/**
 * Scaling scenarios. Every scenario shares one demand ramp (the Demand group)
 * so switching scenarios isolates the scaling-side difference. The lesson is the
 * availability dip during the ramp and how fast capacity recovers.
 *
 * Defaults are grounded on the reference fleet — 50K TPS per c7g.2xlarge and a
 * ~5-min scale-up pipeline — and on AWS's own documented defaults: a 60%
 * utilization target (AWS suggests 60–80%), a 300s bake (ECS
 * instanceWarmupPeriod, and the value AWS names as a starting point for ASG
 * DefaultInstanceWarmup), a 300s simple-scaling cooldown, and a
 * minimum/maximum scaling step size around the computed target.
 */

import type { ScalingPreset, ScalingSimulationConfig } from './types';

export function baseConfig(): ScalingSimulationConfig {
  return {
    seed: 1337,
    slaTarget: 0.99,
    capacity: {
      capacityPerInstanceTps: 50_000,
      targetUtilization: 0.6,
    },
    stages: {
      detectionMs: 60_000,
      signalMs: 5_000,
      launchMs: 30_000,
      cloudInitMs: 60_000,
      placeMs: 10_000,
      bootMs: 45_000,
      healthCheckMs: 30_000,
      dnsPublishMs: 30_000,
      clientPickupMs: 30_000,
    },
    policy: {
      type: 'target-tracking',
      scaleOutGain: 1,
      adjustmentType: 'percent-change-in-capacity',
      steps: [
        { lowerBound: 0, adjustment: 10 },
        { lowerBound: 0.25, adjustment: 30 },
        { lowerBound: 1, adjustment: 60 },
      ],
      simpleAdjustment: 20,
    },
    launch: {
      minStepSize: 1,
      maxStepSize: 20,
      cooldownMs: 300_000,
      bakeMs: 300_000,
      // The pipeline this models is ECS on EC2, so ECS cluster auto scaling's
      // warmup rules are the default: the bake blocks the next step outright,
      // measured from the launch.
      warmupMode: 'ecs',
      maxInstances: 160,
    },
    traffic: {
      shape: 'ramp',
      baseRateTps: 100_000,
      rampStartMs: 15_000,
      rampAmountTps: 1_000_000,
      rampDurationMs: 60_000,
    },
  };
}

function scenario(tune: (c: ScalingSimulationConfig) => void): ScalingSimulationConfig {
  const c = baseConfig();
  tune(c);
  return c;
}

export const SCALING_PRESETS: ScalingPreset[] = [
  {
    id: 'rtb-fabric',
    name: 'RTB Fabric (prod)',
    description:
      'Where the tab opens: measured RTB Fabric production configuration — ten broker tasks serving 60K TPS in one AZ, ' +
      'behind a step policy capped at +20% per decision with a 10-task minimum and a 300s cooldown. Press START and it ' +
      'holds. ▲ RAMP adds +500K over 30 min: eight scale-outs, one every five minutes, to reach the ~91 tasks that ' +
      'demand needs. The ladder and its cooldown pace that, not the ~6-minute pipeline — which is the opposite of the ' +
      'AWS-generic scenarios below, where pipeline latency is the whole story.',
    config: scenario((c) => {
      // Fleet: c7g.xlarge at BASIC_TPS_PER_INSTANCE, RTB Fabric's own
      // conservative planning constant.
      c.capacity.capacityPerInstanceTps = 10_000;
      // Burst alarm trips at 0.61875 × systemLoadAverageMax.
      c.capacity.targetUtilization = 0.62;

      // Only the pipeline terms production actually pins.
      c.stages.bootMs = 60_000; // health check startPeriod
      c.stages.dnsPublishMs = 60_000; // DNS update lambda: rate(1 minute)
      c.stages.clientPickupMs = 60_000; // record TTL 60s

      // StepScaling, PercentChangeInCapacity, two real rungs — production has
      // no third, so the top rung is held flat rather than invented.
      c.policy.type = 'step';
      c.policy.steps = [
        { lowerBound: 0, adjustment: 10 }, // e1 == 1: any pressure signal breached
        { lowerBound: 0.18, adjustment: 20 }, // e1 == 2: load ≥ 0.73125 × max
        { lowerBound: 1, adjustment: 20 },
      ];
      c.launch.minStepSize = 10; // minAdjustmentMagnitude (tasks)
      c.launch.maxStepSize = 400; // no maximum configured
      c.launch.maxInstances = 400; // ECS scalable target max, per AZ

      // Demand is a workload choice, not configuration. 60K ÷ (10K × 0.62) ≈ 10
      // tasks, which is exactly production's configured desiredCount.
      c.traffic.shape = 'steady';
      c.traffic.baseRateTps = 60_000;
      c.traffic.rampAmountTps = 500_000;
      c.traffic.rampDurationMs = 1_800_000;
    }),
  },
  {
    id: 'steady',
    name: 'Steady baseline',
    description:
      'A calm fleet on the AWS-generic defaults: 50K TPS on two instances, sitting under the target buffer with nothing scheduled. Press START and it just holds. Add demand when you want it — ▲ RAMP for the configured amount and rate, ◉ SURGE for a step — and watch the whole scale-out play out on the timeline. The scenarios below run their ramp for you instead.',
    config: scenario((c) => {
      c.traffic.shape = 'steady';
      c.traffic.baseRateTps = 50_000;
    }),
  },
  {
    id: 'baseline',
    name: 'Baseline ramp',
    description:
      'The reference: target tracking against a +1M-TPS-in-1-min ramp, on a ~5-min scale-up pipeline. The policy sizes the whole gap within two decisions — so nothing here is throttled by the bake or the step ceiling. What is left is pure pipeline latency: the capacity was ordered in the first minute and still lands four minutes after the demand did.',
    config: baseConfig(),
  },
  {
    id: 'optimized',
    name: 'Optimized pipeline',
    description:
      'The same ramp against a warm-pool / pre-baked-AMI pipeline: fast launch, cloud-init, boot and health checks. The first new capacity lands in ~1.5 min instead of ~5, and because the latency floor is the whole story on a ramp this steep, the loss drops by roughly three quarters.',
    config: scenario((c) => {
      c.stages.detectionMs = 30_000;
      c.stages.signalMs = 2_000;
      c.stages.launchMs = 5_000;
      c.stages.cloudInitMs = 5_000;
      c.stages.placeMs = 5_000;
      c.stages.bootMs = 12_000;
      c.stages.healthCheckMs = 10_000;
      c.stages.dnsPublishMs = 15_000;
      c.stages.clientPickupMs = 15_000;
    }),
  },
  {
    id: 'headroom',
    name: 'Over-provisioned buffer',
    description:
      'Same slow pipeline and same 1-min ramp, but a 35% utilization target keeps roughly three times the idle capacity ready. It absorbs the first slice of the ramp — and barely dents the loss, because no buffer that a fleet can afford covers a 10× jump. Headroom buys minutes against a gradual ramp, not against a step change.',
    config: scenario((c) => {
      c.capacity.targetUtilization = 0.35;
      c.launch.maxInstances = 220;
    }),
  },
  {
    id: 'slow-detection',
    name: 'Slow detection',
    description:
      'The baseline with 3-minute detection (coarse metrics, many datapoints-to-alarm). The breakdown bar shows detection dominating the lag — no instance is even requested until the alarm finally fires, and the dip deepens by exactly the extra two minutes.',
    config: scenario((c) => {
      c.stages.detectionMs = 180_000;
    }),
  },
  {
    id: 'sustained',
    name: 'Sustained ramp',
    description:
      'The same +1M, delivered over 30 minutes instead of one. Demand now climbs the whole time the fleet is scaling, so every decision is made against a metric the bake is still holding back — the reference point for what a bake actually costs. Compare it against Long bake and Aggressive scale-out.',
    config: scenario((c) => {
      c.traffic.rampDurationMs = 1_800_000;
    }),
  },
  {
    id: 'long-bake',
    name: 'Long bake',
    description:
      'The sustained ramp with a 10-minute bake. Each batch serves traffic the moment it lands, but stays uncounted for another ten minutes — so the policy keeps scaling from a fleet far smaller than the one it already has, and under-orders every step. Roughly triple the loss of a 300s bake, for a demand curve the fleet could otherwise have tracked.',
    config: scenario((c) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.launch.bakeMs = 600_000;
    }),
  },
  {
    id: 'aggressive',
    name: 'Aggressive scale-out',
    description:
      'The sustained ramp with the scale-out gain at 1.3× — each decision orders 30% more than the AWS arithmetic asks for. That deliberate over-order cancels out the under-counting the bake causes, and the ramp is tracked almost perfectly. The bill is a handful of instances beyond what the peak ever needed, which nothing in this model gives back.',
    config: scenario((c) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.policy.scaleOutGain = 1.3;
    }),
  },
  {
    id: 'step-ladder',
    name: 'Step scaling ladder',
    description:
      'The sustained ramp under step scaling with a flat-count ladder — +2 instances just past target, +6 at 25% over, +12 once utilization doubles it. It reacts to a shallow breach sooner than target tracking does. Switch the adjustment type to a percentage and it collapses: a percentage of the small fleet the bake still counts cannot chase a large add.',
    config: scenario((c) => {
      c.traffic.rampDurationMs = 1_800_000;
      c.policy.type = 'step';
      c.policy.adjustmentType = 'change-in-capacity';
      c.policy.steps = [
        { lowerBound: 0, adjustment: 2 },
        { lowerBound: 0.25, adjustment: 6 },
        { lowerBound: 1, adjustment: 12 },
      ];
    }),
  },
];

export function scalingPresetById(id: string): ScalingPreset {
  const p = SCALING_PRESETS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown scaling preset: ${id}`);
  return p;
}

export function cloneScalingConfig(cfg: ScalingSimulationConfig): ScalingSimulationConfig {
  return structuredClone(cfg);
}
