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
  /** Fewest instances a scale-out step launches (ECS minimumScalingStepSize). */
  minStepSize: number;
  /** Most instances one scale-out step launches (ECS maximumScalingStepSize). */
  maxStepSize: number;
  /**
   * Simple-scaling cooldown: after a scale-out, block every decision for this
   * long. AWS accepts `Cooldown` only on a simple-scaling policy (default 300s);
   * target-tracking and step policies throttle themselves with the bake instead.
   */
  cooldownMs: number;
  /**
   * Bake / instance warmup (ECS instanceWarmupPeriod, ASG DefaultInstanceWarmup
   * — 300s is the documented default for both). What it gates depends on
   * `warmupMode`; the clock is per instance either way.
   */
  bakeMs: number;
  /**
   * Which service's warmup semantics apply. The two differ in both what the
   * bake gates and when its clock starts, and the difference is large enough to
   * change a run's shape:
   *
   * - `ecs` — ECS cluster auto scaling. "Auto Scaling checks if all existing
   *   instances have passed the instanceWarmupPeriod (now minus the instance
   *   launch time). The scale-out is blocked for instances that are within the
   *   instanceWarmupPeriod." So the next scale-out step waits for the whole
   *   fleet, and the clock runs from launch — a bake shorter than the pipeline
   *   expires before the capacity it covers has even landed.
   * - `asg` — EC2 Auto Scaling target-tracking / step policies. Nothing is
   *   blocked: a warming instance is left out of the aggregated metrics and out
   *   of the capacity the policy scales from, while still counting toward what
   *   has been requested. The clock runs from the instance reaching InService.
   */
  warmupMode: ScalingWarmupMode;
  /** Ceiling on fleet size. */
  maxInstances: number;
}

export interface ScalingTrafficConfig {
  shape: ScalingTrafficShape;
  /** Steady demand and the ramp floor (TPS). */
  baseRateTps: number;
  /** Hold base this long before the ramp begins (a visible calm baseline). */
  rampStartMs: number;
  /**
   * How much demand the ramp adds on top of base (TPS). The scheduled shape
   * climbs base → base + this; the ▲ RAMP button adds this much from wherever
   * demand currently sits.
   */
  rampAmountTps: number;
  /** How long that amount takes to arrive (ms) — the ramp rate. */
  rampDurationMs: number;
}

// ---------------------------------------------------------------------------
// Scaling policy — how aggressively capacity is added
// ---------------------------------------------------------------------------

/**
 * Mirrors the AWS policy types. `target-tracking` computes a desired count from
 * the metric and closes the gap; `step` picks an adjustment from a ladder keyed
 * on how far past target the metric is; `simple` applies one fixed adjustment
 * per alarm and blocks until the cooldown expires.
 */
export type ScalingPolicyType = 'target-tracking' | 'step' | 'simple';

/** Whose warmup rules the bake follows — see `ScalingLaunchConfig.warmupMode`. */
export type ScalingWarmupMode = 'ecs' | 'asg';

/** How a step/simple adjustment is read (AWS AdjustmentType). */
export type ScalingAdjustmentType = 'change-in-capacity' | 'percent-change-in-capacity';

/** One rung of a step-scaling ladder. */
export interface ScalingStepAdjustment {
  /**
   * Applies when the breach — (utilization ÷ target) − 1 — reaches this
   * fraction. The AWS MetricIntervalLowerBound, expressed relative to target.
   */
  lowerBound: number;
  /** Instances to add, or % of current capacity, per the adjustment type. */
  adjustment: number;
}

export interface ScalingPolicyConfig {
  type: ScalingPolicyType;
  /**
   * target-tracking only: multiplier on the computed gap. 1.0 is the AWS
   * formula (close the gap exactly); above 1 over-provisions on purpose, below
   * 1 walks up in fractions of the gap.
   */
  scaleOutGain: number;
  adjustmentType: ScalingAdjustmentType;
  /** step only: rungs in ascending lowerBound order. */
  steps: ScalingStepAdjustment[];
  /** simple only: the single adjustment applied per alarm. */
  simpleAdjustment: number;
}

export interface ScalingSimulationConfig {
  seed: number;
  /** Availability SLO (0..1): chart line, degraded banner, recovery threshold. */
  slaTarget: number;
  capacity: ScalingCapacityConfig;
  stages: ScalingStageConfig;
  policy: ScalingPolicyConfig;
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
  /** In service but still inside the bake window — serving, yet uncounted by the autoscaler. */
  baking: boolean;
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
  /** Serving capacity past its bake — what the autoscaler counts when it scales. */
  meteredCapacityTps: number;
  utilization: number;
  targetUtilization: number;
  provisioning: number;
  ready: number;
  inUse: number;
  /** In service and carrying traffic, but still inside the bake window. */
  baking: number;
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
  /** Throughput-bound sustainable ramp: max step × cap ÷ decision interval (TPS/min). */
  maxSustainableRampPerMin: number;
  /** Latency floor: detection + Σ per-instance stages (ms) — when the first new capacity lands. */
  pipelineLatencyMs: number;
  /**
   * Gate between scale-out decisions: max(cooldown, per-instance pipeline +
   * bake). With a bake configured this, not the cooldown, sets the cadence.
   */
  decisionIntervalMs: number;
  /** ms until the autoscaler may act again; 0 when it is free to decide. */
  holdRemainingMs: number;
  /** What is holding it — the bake timer, the cooldown, or nothing. */
  holdReason: 'bake' | 'cooldown' | null;
  /** True when the bake is a hard block on the next step, not just metric exclusion. */
  holdBlocks: boolean;
  /** Instances beyond what the peak demand needed at target utilization. */
  overshootInstances: number;
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
  meteredCapacityTps: number;
  utilization: number;
  provisioning: number;
  ready: number;
  inUse: number;
  baking: number;
  inFlight: number;
}

/** What an event is about — the timeline draws one lane per kind. */
export type ScalingEventKind = 'demand' | 'scale' | 'slo' | 'info';

export interface ScalingSimEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  kind: ScalingEventKind;
  message: string;
  /** Magnitude for the timeline to size its marker by (instances added, TPS). */
  value?: number;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * A demand change that occupies a stretch of time rather than an instant — the
 * scheduled shape, a triggered ▲ RAMP, or a ◉ SURGE window. Drawn as a bracket
 * so "when the throughput was offered" is legible at a glance.
 */
export interface ScalingDemandSpan {
  kind: 'ramp' | 'step' | 'surge';
  label: string;
  startMs: number;
  /** Equal to `startMs` for an instantaneous step. */
  endMs: number;
  /** TPS the span adds at full effect (a surge reports its delta at trigger). */
  amountTps: number;
}

/** A stretch of the run where availability sat under the SLO. */
export interface ScalingBreachSpan {
  startMs: number;
  endMs: number;
  /** Lowest availability reached inside the span (0..1). */
  minAvailability: number;
}

/** A stretch where the alarm metric sat above target, and when it fired. */
export interface ScalingAlarmSpan {
  /** When utilization first crossed the target. */
  startMs: number;
  /** startMs + detection: when the alarm actually fired. -1 if it cleared first. */
  firedAtMs: number;
  /** When utilization fell back to target; the run's end while still breaching. */
  endMs: number;
}

/**
 * The arithmetic behind one scale-out, kept so the timeline can show *why* a
 * step was the size it was rather than just that it happened.
 */
export interface ScalingDecision {
  timeMs: number;
  policy: ScalingPolicyType;
  utilization: number;
  targetUtilization: number;
  /** In-service instances past their bake — the capacity the policy scales from. */
  metered: number;
  /** Everything already requested, in flight included. */
  currentDesired: number;
  /** What the policy's arithmetic asked for, before any clamp. */
  want: number;
  /** max(currentDesired, ceil(want)) — the capacity it settled on. */
  newDesired: number;
  /** Instances actually launched, after the step clamps and the fleet ceiling. */
  launched: number;
  /** Which limit bound the step, if any did. */
  clampedBy: 'min step' | 'max step' | 'fleet ceiling' | null;
  /** Step scaling only: the rung that fired. */
  tier: number | null;
  /** The adjustment applied, for step and simple policies. */
  adjustment: number | null;
  adjustmentType: ScalingAdjustmentType | null;
  /** Target tracking only: the multiplier on the computed capacity. */
  gain: number | null;
}

/**
 * One launched batch, with the pipeline plan it will follow. Stage durations are
 * fixed and deterministic at launch, so every boundary is known up front — which
 * is what lets the timeline draw the whole scale process as a Gantt row.
 */
export interface ScalingBatch {
  launchedAt: number;
  count: number;
  /** Absolute end time of each PIPELINE_STAGES entry, in order. */
  stageEndsAt: number[];
  /** When the batch finished the pipeline and began serving. */
  inServiceAt: number;
  /** When its bake expires and the autoscaler starts counting it. */
  countedAt: number;
  decision: ScalingDecision;
}

/** Everything the timeline pane draws for one run. */
export interface ScalingTimelineView {
  /** Right edge — the current sim time. */
  nowMs: number;
  /** How often the scaling metric is published (ms) — the decision floor. */
  metricPeriodMs: number;
  spans: ScalingDemandSpan[];
  breaches: ScalingBreachSpan[];
  alarms: ScalingAlarmSpan[];
  batches: ScalingBatch[];
  events: ScalingSimEventLog[];
}
