/**
 * Shared types for the Scaling model: how the fleet copes with a rapid demand
 * ramp-up, and the scale rate the autoscaling pipeline can achieve.
 *
 * All durations are virtual simulation milliseconds (real-world scale — a
 * scale-up pipeline is minutes). The shell dilates playback so minutes compress
 * to seconds. Like the DNS model this is a fluid model: demand and capacity are
 * carried as rates (TPS) and only the events that change them — pipeline stage
 * transitions, autoscaler ticks, demand ticks — are discrete.
 *
 * Reference point: 100K TPS on 2× c7g.2xlarge ⇒ 50K TPS/instance.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ScalingTrafficShape = 'ramp' | 'step' | 'steady';

export interface ScalingCapacityConfig {
  /** TPS one instance serves at 100% (c7g.2xlarge ≈ 50K). */
  capacityPerInstanceTps: number;
  /**
   * Target utilization the autoscaler holds — the buffer. Steady-state util sits
   * here, so (1 − this) is the headroom that absorbs a ramp during the scaling
   * lag. Scale-out triggers when util exceeds it.
   */
  targetUtilization: number;
}

/**
 * The scale-up pipeline. `detectionMs` is per scaling decision (the metric/alarm
 * lag before any launch); the rest are per-instance and run in parallel across a
 * launched batch. An instance is serving (ready, advertised) after dnsPublish and
 * usable by clients after clientPickup.
 */
export interface ScalingStageConfig {
  detectionMs: number;
  signalMs: number;
  launchMs: number;
  cloudInitMs: number;
  placeMs: number;
  bootMs: number;
  healthCheckMs: number;
  dnsPublishMs: number;
  clientPickupMs: number;
}

export interface ScalingLaunchConfig {
  /** Instances launched per scale-out step. */
  launchBatchSize: number;
  /** Minimum time between scale-out steps (ms). */
  cooldownMs: number;
  /** Ceiling on fleet size. */
  maxInstances: number;
}

export interface ScalingTrafficConfig {
  shape: ScalingTrafficShape;
  /** Steady demand and the ramp floor (TPS). */
  baseRateTps: number;
  /** Ramp target / step level (TPS). */
  peakRateTps: number;
  /** Hold base this long before the ramp begins (a visible calm baseline). */
  rampStartMs: number;
  /** Time to go base → peak (ms), and the duration of a triggered ramp. */
  rampDurationMs: number;
  /** Demand added by a triggered ramp event (TPS) — the ▲ RAMP button. */
  rampAmountTps: number;
}

export interface ScalingSimulationConfig {
  seed: number;
  /** Availability SLO (0..1): chart line, degraded banner, recovery threshold. */
  slaTarget: number;
  capacity: ScalingCapacityConfig;
  stages: ScalingStageConfig;
  launch: ScalingLaunchConfig;
  traffic: ScalingTrafficConfig;
}

export interface ScalingPreset {
  id: string;
  name: string;
  description: string;
  config: ScalingSimulationConfig;
}

// ---------------------------------------------------------------------------
// Pipeline stage metadata (the per-instance stages, in order)
// ---------------------------------------------------------------------------

export interface StageMeta {
  key: keyof ScalingStageConfig;
  label: string;
  /** Serving after this stage completes (dnsPublish) — advertised, ready. */
  readyAfter?: boolean;
}

/** Per-instance stages, in order. Detection is a separate per-decision lag. */
export const PIPELINE_STAGES: StageMeta[] = [
  { key: 'signalMs', label: 'signal→ECS' },
  { key: 'launchMs', label: 'launch EC2' },
  { key: 'cloudInitMs', label: 'cloud-init' },
  { key: 'placeMs', label: 'place task' },
  { key: 'bootMs', label: 'boot task' },
  { key: 'healthCheckMs', label: 'health check' },
  { key: 'dnsPublishMs', label: 'DNS publish', readyAfter: true },
  { key: 'clientPickupMs', label: 'client pickup' },
];

// ---------------------------------------------------------------------------
// Renderer-facing views
// ---------------------------------------------------------------------------

/** An in-flight or serving instance. `stageIndex` = index into PIPELINE_STAGES; PIPELINE_STAGES.length = in use. */
export interface ScalingInstanceView {
  id: number;
  /** 0..PIPELINE_STAGES.length-1 while progressing; PIPELINE_STAGES.length once in use. */
  stageIndex: number;
  /** 0..1 progress through the current stage. */
  stageProgress: number;
  ready: boolean;
  inUse: boolean;
  /** Pre-warmed at t0 (not the result of a scale-out). */
  prewarmed: boolean;
}

export interface ScalingStageView {
  label: string;
  durationMs: number;
  /** Instances currently in this stage. */
  count: number;
}

export interface ScalingDemandView {
  offeredTps: number;
  readyCapacityTps: number;
  usableCapacityTps: number;
  utilization: number;
  targetUtilization: number;
  provisioning: number;
  ready: number;
  inUse: number;
}

export interface ScalingReadout {
  /** True while a scale event (breach) is in progress or recently recovered. */
  active: boolean;
  /** ms from the breach until availability recovered (or elapsed so far). */
  recoverMs: number;
  recovered: boolean;
  /** Effective capacity add-rate over the recovery (TPS/min). */
  effectiveAddRatePerMin: number;
  /** Lowest instantaneous availability during the event. */
  minAvailability: number;
  /** Demand added in the event (TPS). */
  addedTps: number;
  /** Throughput-bound sustainable ramp: batch × cap ÷ cooldown (TPS/min). */
  maxSustainableRampPerMin: number;
  /** Latency floor: detection + Σ per-instance stages (ms) — when the first new capacity lands. */
  pipelineLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ScalingMetricsBucket {
  time: number;
  // Integrated amounts (requests) over the bucket:
  offered: number;
  served: number;
  lost: number;
  // Gauges sampled at close:
  offeredRate: number;
  readyCapacityTps: number;
  usableCapacityTps: number;
  utilization: number;
  provisioning: number;
  ready: number;
  inUse: number;
  inFlight: number;
}

export interface ScalingSimEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}
