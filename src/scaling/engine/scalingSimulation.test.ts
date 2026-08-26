/**
 * Invariant tests for the Scaling engine — also the preset-tuning harness. The
 * guards that matter: a ramp faster than the pipeline dips availability and then
 * recovers; more buffer, a faster pipeline, a bigger step ceiling and a shorter
 * bake all reduce the loss; the policy arithmetic matches the worked example in
 * the AWS step-scaling docs; and the model is deterministic across playback
 * speeds.
 */

import { describe, expect, it } from 'vitest';
import { baseConfig, cloneScalingConfig, SCALING_PRESETS, scalingPresetById } from './presets';
import { ScalingSimulation } from './scalingSimulation';
import type { ScalingSimulationConfig } from './types';

function run(sim: ScalingSimulation, durationMs: number, stepMs = 1000): void {
  let elapsed = 0;
  while (elapsed < durationMs) {
    const dt = Math.min(stepMs, durationMs - elapsed);
    sim.step(dt);
    elapsed += dt;
  }
}

function newSim(mutate?: (c: ScalingSimulationConfig) => void): ScalingSimulation {
  const cfg = baseConfig();
  if (mutate) mutate(cfg);
  return new ScalingSimulation(cfg);
}

function availBetween(sim: ScalingSimulation, fromMs: number, toMs: number): number {
  let o = 0;
  let s = 0;
  for (const b of sim.metrics.buckets) {
    if (b.time < fromMs || b.time >= toMs) continue;
    o += b.offered;
    s += b.served;
  }
  return o > 0 ? s / o : 1;
}

describe('baseline invariants', () => {
  it('starts calm: availability ≈ 100% at the base demand before the ramp', () => {
    const sim = newSim((c) => {
      c.traffic.shape = 'steady';
    });
    run(sim, 60_000);
    expect(availBetween(sim, 5_000, 60_000)).toBeGreaterThan(0.99);
  });

  it('served never exceeds offered and availability stays in [0,1]', () => {
    const sim = newSim();
    run(sim, 300_000);
    for (const b of sim.metrics.buckets) {
      expect(b.served).toBeLessThanOrEqual(b.offered + 1e-6);
      expect(b.served).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('a ramp faster than the pipeline dips availability, then recovers', () => {
    const sim = newSim();
    run(sim, 2_400_000);
    // A real dip happened during the ramp...
    expect(sim.metrics.totals.lost).toBeGreaterThan(0);
    expect(availBetween(sim, 90_000, 300_000)).toBeLessThan(0.95);
    // ...and capacity eventually catches up.
    expect(availBetween(sim, 2_300_000, 2_400_000)).toBeGreaterThan(0.99);
  });

  it('a ramp slow enough for the pipeline never breaches the SLO', () => {
    const sim = newSim((c) => (c.traffic.rampDurationMs = 3_600_000)); // +1M over an hour
    run(sim, 3_900_000);
    expect(sim.metrics.lifetimeAvailability()).toBeGreaterThan(0.999);
  });
});

describe('scaling levers reduce the loss', () => {
  const lostOver = (mutate?: (c: ScalingSimulationConfig) => void): number => {
    const sim = newSim(mutate);
    run(sim, 1_800_000);
    return sim.metrics.totals.lost;
  };

  it('a faster pipeline loses far less than the baseline', () => {
    const base = lostOver();
    const fast = lostOver((c) => Object.assign(c.stages, cloneScalingConfig(scalingPresetById('optimized').config).stages));
    expect(fast).toBeLessThan(base * 0.6);
  });

  it('a bigger headroom buffer loses less than the baseline', () => {
    const base = lostOver();
    const headroom = lostOver((c) => {
      c.capacity.targetUtilization = 0.35;
      c.launch.maxInstances = 60;
    });
    expect(headroom).toBeLessThan(base);
  });

  it('a wider step ceiling (higher scale throughput) loses less than the baseline', () => {
    const base = lostOver((c) => (c.launch.maxStepSize = 6));
    const big = lostOver((c) => (c.launch.maxStepSize = 60));
    expect(big).toBeLessThan(base);
  });

  /**
   * On a sustained ramp the fleet is scaling while demand still climbs, so every
   * decision is made against a metric the bake is holding back — the policy
   * scales from a fleet smaller than the one it already has, and under-orders.
   */
  it('a shorter bake loses less on a sustained ramp', () => {
    const sustained = (bakeMs: number) => (c: ScalingSimulationConfig) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.launch.bakeMs = bakeMs;
    };
    const long = lostOver(sustained(600_000));
    const short = lostOver(sustained(60_000));
    expect(short).toBeLessThan(long * 0.5);
  });

  /**
   * The other side of the same coin: against an instant jump the policy sizes
   * the whole gap before any capacity lands, so the bake never gets to bind and
   * the pipeline latency is the entire story.
   */
  it('the bake does not change a jump the policy can size in one decision', () => {
    const short = lostOver((c) => (c.launch.bakeMs = 60_000));
    const long = lostOver((c) => (c.launch.bakeMs = 600_000));
    expect(short).toBeCloseTo(long, 0);
  });

  it('scale-out gain above 1 offsets the under-counting a bake causes', () => {
    const plain = lostOver((c) => (c.traffic.rampDurationMs = 1_800_000));
    const eager = lostOver((c) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.policy.scaleOutGain = 1.3;
    });
    expect(eager).toBeLessThan(plain);
  });

  it('a gentler ramp loses less than a steep one', () => {
    const steep = lostOver((c) => (c.traffic.rampDurationMs = 30_000));
    const gentle = lostOver((c) => (c.traffic.rampDurationMs = 600_000));
    expect(gentle).toBeLessThan(steep);
  });

  it('a bigger ramp amount loses more at the same rate', () => {
    const small = lostOver((c) => (c.traffic.rampAmountTps = 1_000_000));
    const large = lostOver((c) => (c.traffic.rampAmountTps = 3_000_000));
    expect(large).toBeGreaterThan(small);
  });

  it('step scaling recovers faster than simple scaling under the same ramp', () => {
    const simple = lostOver((c) => {
      c.policy.type = 'simple';
      c.policy.simpleAdjustment = 20;
    });
    const step = lostOver((c) => {
      c.policy.type = 'step';
      c.launch.maxStepSize = 60;
    });
    expect(step).toBeLessThan(simple);
  });

  /**
   * A percentage of the small fleet the bake still counts cannot chase a large
   * add; a flat count can. The adjustment type is the difference between a step
   * policy that tracks the ramp and one that never catches it.
   */
  it('a flat-count step ladder beats a percentage one on a large add', () => {
    const stepScenario = (tune: (c: ScalingSimulationConfig) => void) => (c: ScalingSimulationConfig) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.policy.type = 'step';
      tune(c);
    };
    const percent = lostOver(stepScenario(() => {}));
    const flat = lostOver(
      stepScenario((c) => {
        c.policy.adjustmentType = 'change-in-capacity';
        c.policy.steps = [
          { lowerBound: 0, adjustment: 2 },
          { lowerBound: 0.25, adjustment: 6 },
          { lowerBound: 1, adjustment: 12 },
        ];
      }),
    );
    expect(flat).toBeLessThan(percent);
  });
});

describe('scale readout', () => {
  it('paces ECS on the bake alone — its clock runs from the launch', () => {
    const sim = newSim();
    const r = sim.scaleReadout();
    expect(r.decisionIntervalMs).toBe(300_000);
    expect(r.maxSustainableRampPerMin).toBeCloseTo((20 * 50_000 * 60_000) / 300_000, 0);
    // detection 60s + Σ per-instance stages (240s) = 300s.
    expect(r.pipelineLatencyMs).toBe(300_000);
    expect(r.holdBlocks).toBe(true);
  });

  it('paces ASG on pipeline + bake — its clock only starts once the batch lands', () => {
    const sim = newSim((c) => (c.launch.warmupMode = 'asg'));
    const r = sim.scaleReadout();
    // Σ per-instance stages (240s) + bake (300s) = 540s before a batch counts.
    expect(r.decisionIntervalMs).toBe(540_000);
    // Nothing is blocked under ASG — the bake only withholds the metric.
    expect(r.holdBlocks).toBe(false);
  });

  it('a simple-scaling cooldown longer than the bake sets the interval instead', () => {
    const sim = newSim((c) => {
      c.policy.type = 'simple';
      c.launch.cooldownMs = 900_000;
    });
    expect(sim.scaleReadout().decisionIntervalMs).toBe(900_000);
  });

  it('holds after a scale-out and names the bake as the reason', () => {
    const sim = newSim();
    run(sim, 200_000);
    const r = sim.scaleReadout();
    expect(sim.metrics.totals.launches).toBeGreaterThan(0);
    expect(r.holdRemainingMs).toBeGreaterThan(0);
    expect(r.holdReason).toBe('bake');
  });
});

describe('policy arithmetic', () => {
  /**
   * The worked example from the EC2 Auto Scaling step-scaling docs: from a fleet
   * of 10, a +30% adjustment while an earlier instance is still warming adds 2,
   * not 3, because the one already requested counts toward the new desired
   * capacity. This is ASG behavior specifically — under ECS the second step
   * would be blocked outright until the first instance finished warming.
   */
  it('a deeper breach tops up rather than re-requesting capacity in flight (ASG)', () => {
    const sim = newSim((c) => {
      c.launch.warmupMode = 'asg';
      c.traffic.shape = 'steady';
      c.traffic.baseRateTps = 300_000; // 10 instances at 60% of 50K
      c.policy.type = 'step';
      c.policy.adjustmentType = 'percent-change-in-capacity';
      c.policy.steps = [
        { lowerBound: 0, adjustment: 10 },
        { lowerBound: 0.25, adjustment: 30 },
        { lowerBound: 1, adjustment: 60 },
      ];
      c.launch.bakeMs = 600_000; // long enough that nothing lands during the test
      c.launch.maxStepSize = 100;
    });
    expect(sim.instances.length).toBe(10);
    // Shallow breach → the first rung: 10% of 10 = 1 instance.
    sim.cfg.traffic.baseRateTps = 320_000;
    run(sim, 130_000);
    expect(sim.instances.length).toBe(11);
    // Deeper breach → 30% of the 10 metered instances = 3, but 11 are already
    // desired, so only 2 more are launched.
    sim.cfg.traffic.baseRateTps = 400_000;
    run(sim, 130_000);
    expect(sim.instances.length).toBe(13);
  });

  /**
   * "Auto Scaling checks if all existing instances have passed the
   * instanceWarmupPeriod... The scale-out is blocked for instances that are
   * within the instanceWarmupPeriod." Same breach, same ladder — under ECS the
   * escalation simply does not fire until the fleet is warm.
   */
  it('ECS blocks the escalating step until the whole fleet is warm', () => {
    const build = (mode: 'ecs' | 'asg') =>
      newSim((c) => {
        c.launch.warmupMode = mode;
        c.traffic.shape = 'steady';
        c.traffic.baseRateTps = 300_000;
        c.policy.type = 'step';
        c.policy.adjustmentType = 'percent-change-in-capacity';
        c.launch.bakeMs = 600_000;
        c.launch.maxStepSize = 100;
      });
    const ecs = build('ecs');
    const asg = build('asg');
    for (const sim of [ecs, asg]) {
      sim.cfg.traffic.baseRateTps = 320_000;
      run(sim, 130_000);
      sim.cfg.traffic.baseRateTps = 400_000;
      run(sim, 130_000);
    }
    expect(asg.instances.length).toBe(13); // 11, then topped up to 13
    expect(ecs.instances.length).toBe(11); // blocked at the first step
  });

  it('the ECS bake runs from the launch, so a short one expires before capacity lands', () => {
    // Pipeline is 240s; a 60s bake is long gone by the time the batch is in
    // service, so the next step fires while the first is still provisioning.
    const sim = newSim((c) => (c.launch.bakeMs = 60_000));
    run(sim, 300_000);
    const launchTimes = sim.metrics.events.filter((e) => e.kind === 'scale').map((e) => e.time);
    expect(launchTimes.length).toBeGreaterThan(1);
    expect(launchTimes[1] - launchTimes[0]).toBeLessThan(240_000);
  });

  it('target tracking closes the gap exactly and then stops', () => {
    const sim = newSim((c) => {
      c.traffic.shape = 'step';
      c.traffic.rampStartMs = 0;
      c.traffic.rampAmountTps = 500_000;
      c.launch.maxStepSize = 100;
    });
    run(sim, 1_800_000);
    // 600K TPS at a 60% target on 50K instances = 20 instances, and no more.
    expect(sim.instances.length).toBe(20);
    expect(sim.scaleReadout().overshootInstances).toBe(0);
  });
});

describe('timeline', () => {
  it('brackets the scheduled ramp, and extends the axis to it before the run starts', () => {
    const sim = newSim();
    const v = sim.timelineView();
    expect(v.nowMs).toBe(0);
    const ramp = v.spans.find((s) => s.kind === 'ramp');
    expect(ramp).toBeDefined();
    expect(ramp!.startMs).toBe(15_000);
    expect(ramp!.endMs).toBe(75_000); // rampStart + rampDuration
    expect(ramp!.amountTps).toBe(1_000_000);
  });

  it('records a triggered ramp and a surge as spans, in time order', () => {
    const sim = newSim((c) => (c.traffic.shape = 'steady'));
    run(sim, 30_000);
    sim.triggerRamp(500_000, 60_000);
    run(sim, 30_000);
    sim.triggerSurge(2, 20_000);
    run(sim, 60_000);
    const spans = sim.timelineView().spans;
    expect(spans.map((s) => s.kind)).toEqual(['ramp', 'surge']);
    expect(spans[0].startMs).toBe(30_000);
    expect(spans[0].endMs).toBe(90_000);
    // The surge span keeps its window after it ends, so the run stays readable.
    expect(spans[1].endMs).toBe(80_000);
  });

  it('reports below-SLO stretches as breach spans', () => {
    const sim = newSim();
    run(sim, 900_000);
    const { breaches } = sim.timelineView();
    expect(breaches.length).toBeGreaterThan(0);
    const worst = breaches.reduce((a, b) => (b.minAvailability < a.minAvailability ? b : a));
    expect(worst.minAvailability).toBeLessThan(sim.cfg.slaTarget);
    expect(worst.endMs).toBeGreaterThan(worst.startMs);
    // Every span sits inside the run and none overlap.
    for (let i = 1; i < breaches.length; i++) expect(breaches[i].startMs).toBeGreaterThanOrEqual(breaches[i - 1].endMs);
  });

  it('tags events by kind and carries the instances each scale-out added', () => {
    const sim = newSim();
    run(sim, 900_000);
    const events = sim.timelineView().events;
    const scale = events.filter((e) => e.kind === 'scale');
    expect(scale.length).toBe(sim.metrics.totals.launches);
    expect(scale.reduce((a, e) => a + (e.value ?? 0), 0)).toBe(sim.metrics.totals.instancesLaunched);
    expect(events.some((e) => e.kind === 'slo')).toBe(true);
  });
});

describe('playback determinism', () => {
  it('availability is identical regardless of step granularity', () => {
    const build = () => new ScalingSimulation(cloneScalingConfig(baseConfig()));
    const coarse = build();
    const fine = build();
    run(coarse, 600_000, 1000);
    run(fine, 600_000, 250);
    expect(Math.abs(coarse.metrics.lifetimeAvailability() - fine.metrics.lifetimeAvailability())).toBeLessThan(1e-6);
    expect(coarse.metrics.totals.served).toBeCloseTo(fine.metrics.totals.served, 1);
  });
});

describe('presets', () => {
  it('every preset runs without producing NaN or negative flows', () => {
    for (const p of SCALING_PRESETS) {
      const sim = new ScalingSimulation(cloneScalingConfig(p.config));
      run(sim, 1_800_000);
      const t = sim.metrics.totals;
      expect(Number.isFinite(t.served)).toBe(true);
      expect(Number.isFinite(t.offered)).toBe(true);
      expect(sim.metrics.lifetimeAvailability()).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
