/**
 * Scaling scenarios. Every scenario shares one demand ramp (the Traffic group)
 * so switching scenarios isolates the scaling-side difference. The lesson is the
 * availability dip during the ramp and how fast capacity recovers.
 *
 * Defaults are grounded on the reference fleet: 50K TPS per c7g.2xlarge, a ~5-min
 * scale-up pipeline, and a +1M-TPS-in-1-min ramp — the "can we add 1M TPS in a
 * minute?" question, which a 5-min pipeline answers with a deep dip.
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
    launch: {
      launchBatchSize: 4,
      cooldownMs: 60_000,
      maxInstances: 40,
    },
    traffic: {
      shape: 'ramp',
      baseRateTps: 100_000,
      peakRateTps: 1_100_000,
      rampStartMs: 15_000,
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
    id: 'baseline',
    name: 'Baseline ramp',
    description:
      'The reference: a ~5-min scale-up pipeline vs a +1M-TPS-in-1-min ramp. Capacity lands minutes after the surge, so availability craters and recovers slowly. The max sustainable ramp (200K TPS/min) is far below the 1M/min offered — the honest answer to "1M in a minute."',
    config: baseConfig(),
  },
  {
    id: 'optimized',
    name: 'Optimized pipeline',
    description:
      'A warm-pool / pre-baked-AMI pipeline: fast launch, cloud-init, boot and health checks. The per-stage lag collapses, so the first new capacity lands in ~1.5 min and the dip is shallow and short. Same demand, far less lost.',
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
      'Same slow pipeline, but a big headroom buffer (target 35% util) keeps far more capacity ready. The extra headroom absorbs the first part of the ramp while the pipeline catches up, so the dip is shallower — at the cost of running more idle instances steady-state.',
    config: scenario((c) => {
      c.capacity.targetUtilization = 0.35;
      c.launch.maxInstances = 60;
    }),
  },
  {
    id: 'big-batches',
    name: 'Big batches',
    description:
      'Larger launch batches and a short cooldown lift the sustained scale rate to ~1.2M TPS/min — enough to track the ramp once the pipeline fills. The latency floor still delays the first capacity, but recovery is much faster than the baseline.',
    config: scenario((c) => {
      c.launch.launchBatchSize = 12;
      c.launch.cooldownMs = 30_000;
      c.launch.maxInstances = 60;
    }),
  },
  {
    id: 'slow-detection',
    name: 'Slow detection',
    description:
      'Everything else is the baseline, but detection takes 3 minutes (coarse metrics, many datapoints-to-alarm). The breakdown bar shows detection dominating the lag — no instance is even requested until the alarm finally fires, deepening the dip.',
    config: scenario((c) => {
      c.stages.detectionMs = 180_000;
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
