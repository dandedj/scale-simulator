/**
 * Invariant tests for the Scaling engine — also the preset-tuning harness. The
 * guards that matter: a ramp faster than the pipeline dips availability and then
 * recovers; more buffer / a faster pipeline / bigger batches all reduce the loss;
 * and the model is deterministic across playback speeds.
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
    run(sim, 1_100_000);
    // A real dip happened during the ramp...
    expect(sim.metrics.totals.lost).toBeGreaterThan(0);
    expect(availBetween(sim, 90_000, 300_000)).toBeLessThan(0.95);
    // ...and capacity eventually catches up.
    expect(availBetween(sim, 1_000_000, 1_100_000)).toBeGreaterThan(0.99);
  });
});

describe('scaling levers reduce the loss', () => {
  const lostOver = (mutate?: (c: ScalingSimulationConfig) => void): number => {
    const sim = newSim(mutate);
    run(sim, 900_000);
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

  it('bigger batches (higher scale throughput) lose less than the baseline', () => {
    const base = lostOver();
    const big = lostOver((c) => {
      c.launch.launchBatchSize = 12;
      c.launch.cooldownMs = 30_000;
      c.launch.maxInstances = 60;
    });
    expect(big).toBeLessThan(base);
  });

  it('a gentler ramp loses less than a steep one', () => {
    const steep = lostOver((c) => (c.traffic.rampDurationMs = 30_000));
    const gentle = lostOver((c) => (c.traffic.rampDurationMs = 240_000));
    expect(gentle).toBeLessThan(steep);
  });
});

describe('scale readout', () => {
  it('reports max sustainable ramp = batch × capacity ÷ cooldown', () => {
    const sim = newSim();
    const r = sim.scaleReadout();
    // 4 × 50_000 × (60000/60000) = 200_000 TPS/min
    expect(r.maxSustainableRampPerMin).toBeCloseTo(200_000, 0);
    // detection 60s + Σ per-instance stages (240s) = 300s.
    expect(r.pipelineLatencyMs).toBe(300_000);
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
      run(sim, 300_000);
      const t = sim.metrics.totals;
      expect(Number.isFinite(t.served)).toBe(true);
      expect(Number.isFinite(t.offered)).toBe(true);
      expect(sim.metrics.lifetimeAvailability()).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
