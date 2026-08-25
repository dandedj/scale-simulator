/**
 * The Scaling simulation: a rapid demand ramp-up against the autoscaling
 * pipeline. Capacity lags demand by the pipeline latency and grows no faster
 * than the launch throughput, so during a ramp `served = min(offered, usable
 * capacity)` and availability dips until capacity catches up.
 *
 * Fluid, discrete-event model (same style as the DNS sim): demand and capacity
 * are TPS rates; discrete events are pipeline stage transitions, autoscaler
 * ticks, and demand ticks. Deterministic — no randomness — so replay is exact
 * at any playback speed.
 *
 * The autoscaler follows the documented AWS scale-out arithmetic. Instances
 * still inside their warmup (bake) window serve traffic but are not counted in
 * the capacity the policy scales *from*, while every in-flight instance is
 * counted in the capacity it scales *to*:
 *
 *   newDesired = max(currentDesired, meteredCapacity + adjustment)
 *
 * so repeated breaches of the same size collapse into one scaling activity and
 * a bigger breach only tops up the difference. That single rule reproduces the
 * worked example in the EC2 Auto Scaling step-scaling docs.
 */

import { EventQueue, type ScheduledEvent } from '../../engine/eventQueue';
import { type ScalingGauges, ScalingMetricsCollector, type ScalingRates } from './metrics';
import {
  PIPELINE_STAGES,
  type ScalingDemandView,
  type ScalingInstanceView,
  type ScalingPolicyType,
  type ScalingReadout,
  type ScalingSimulationConfig,
  type ScalingStageView,
} from './types';

/** Autoscaler evaluation + demand-ramp refresh cadence (ms). */
const TICK_MS = 2000;
/**
 * How often a fired alarm can drive another scaling activity. ECS and EC2
 * publish the underlying metrics once a minute, so a policy cannot act faster
 * than that however often the model ticks.
 */
const METRIC_PERIOD_MS = 60_000;
/** Index into PIPELINE_STAGES an instance reaches once it is serving (past DNS publish). */
const READY_STAGE_INDEX = PIPELINE_STAGES.findIndex((s) => s.readyAfter) + 1;
/** stageIndex once fully in use (past client pickup). */
const IN_USE_INDEX = PIPELINE_STAGES.length;

let nextInstanceId = 1;

class Instance {
  id = nextInstanceId++;
  /** 0..IN_USE_INDEX; IN_USE_INDEX means in use. */
  stageIndex: number;
  stageEnteredAt: number;
  stageEndsAt: number;
  prewarmed: boolean;
  /** When it entered service — the bake clock's zero. Pre-warmed fleet counts from the start. */
  inServiceAt: number;
  event: ScheduledEvent | null = null;

  constructor(stageIndex: number, now: number, prewarmed: boolean) {
    this.stageIndex = stageIndex;
    this.stageEnteredAt = now;
    this.stageEndsAt = now;
    this.prewarmed = prewarmed;
    this.inServiceAt = prewarmed ? -Infinity : Infinity;
  }

  get ready(): boolean {
    return this.stageIndex >= READY_STAGE_INDEX;
  }
  get inUse(): boolean {
    return this.stageIndex >= IN_USE_INDEX;
  }
}

export class ScalingSimulation {
  now = 0;
  readonly queue = new EventQueue();
  readonly metrics = new ScalingMetricsCollector();
  cfg: ScalingSimulationConfig;

  instances: Instance[] = [];

  // Manual surge (a step multiplier on demand, via the SURGE button).
  pulseFactor = 1;
  pulseUntil = 0;
  private pulseEndEvent: ScheduledEvent | null = null;
  // Triggered ramps (additive, persistent) via the ▲ RAMP button.
  private ramps: { startAt: number; amount: number; durMs: number }[] = [];

  private rates: ScalingRates = { offered: 0, served: 0 };
  private breachSince = -1;
  private lastLaunchAt = -Infinity;
  /** Last time the policy evaluated a datapoint (fired or not). */
  private lastDecisionAt = -Infinity;
  private peakOfferedTps = 0;

  // Scale-event readout tracking.
  private eventStart = -1;
  private eventRecoverAt = -1;
  private eventMinAvail = 1;
  private eventBaseOffered = 0;
  private eventPeakOffered = 0;

  private degradedWas = false;
  private lastLogAt: Record<string, number> = {};

  constructor(cfg: ScalingSimulationConfig) {
    this.cfg = cfg;
    // Pre-warm to the target buffer for the base demand: a calm start.
    const cap = cfg.capacity.capacityPerInstanceTps;
    const prewarm = Math.max(1, Math.ceil(cfg.traffic.baseRateTps / (cfg.capacity.targetUtilization * cap)));
    for (let i = 0; i < prewarm; i++) this.instances.push(new Instance(IN_USE_INDEX, 0, true));
    this.metrics.totals.peakInstances = this.instances.length;
    this.scheduleTick();
    this.rebalance();
  }

  // -- Time --------------------------------------------------------------------

  step(dtMs: number): void {
    if (dtMs <= 0) return;
    const target = this.now + dtMs;
    let guard = 0;
    while (this.now < target - 1e-9 && guard++ < 1_000_000) {
      const next = Math.min(target, this.queue.peekTime(), this.metrics.nextBoundary());
      const seg = next - this.now;
      if (seg > 0) {
        this.metrics.accumulate(seg, this.rates);
        this.now = next;
        this.metrics.advance(this.now, this.gauges());
      }
      let fired = false;
      let ev: ScheduledEvent | null;
      while ((ev = this.queue.popDue(this.now)) !== null) {
        ev.fire();
        fired = true;
      }
      if (fired) this.rebalance();
    }
    this.detectConditions();
  }

  /** Manual step surge: multiply demand by `factor` for `durationMs`. */
  triggerSurge(factor: number, durationMs: number): void {
    this.pulseFactor = factor;
    this.pulseUntil = this.now + durationMs;
    if (this.pulseEndEvent) this.pulseEndEvent.active = false;
    this.pulseEndEvent = this.queue.schedule(this.pulseUntil, () => {
      this.pulseFactor = 1;
      this.pulseEndEvent = null;
      this.metrics.log(this.now, 'info', 'Manual surge ended');
    });
    this.metrics.log(this.now, 'warn', `Manual surge: ${factor}× for ${(durationMs / 1000).toFixed(0)}s`);
    this.rebalance();
  }

  /**
   * Schedule an additive demand ramp: raise offered by `amountTps` over
   * `durationMs`, then hold it. Stacks with the shape and any prior ramps (e.g.
   * "+1M TPS in 1 min"). Persists until reset.
   */
  triggerRamp(amountTps: number, durationMs: number): void {
    this.ramps.push({ startAt: this.now, amount: amountTps, durMs: Math.max(1, durationMs) });
    this.metrics.log(this.now, 'warn', `Scheduled ramp: +${fmtTps(amountTps)} over ${(durationMs / 1000).toFixed(0)}s`);
    this.rebalance();
  }

  private rampAdd(now: number): number {
    let sum = 0;
    for (const r of this.ramps) sum += r.amount * clamp01((now - r.startAt) / r.durMs);
    return sum;
  }

  /** Live demand/config change: the next rebalance reads cfg. */
  applyTraffic(): void {
    this.rebalance();
  }

  /** No structural rebuild needed — capacity/instances derive from cfg live. */
  applyStructure(): void {
    this.rebalance();
  }

  // -- Autoscaler + pipeline ---------------------------------------------------

  private scheduleTick(): void {
    this.queue.schedule(this.now + TICK_MS, () => {
      this.evalAutoscaler();
      this.scheduleTick();
    });
  }

  private evalAutoscaler(): void {
    const c = this.cfg;
    const target = c.capacity.targetUtilization;
    const offered = this.totalOffered();
    // The alarm metric is the true utilization of the serving fleet: every
    // in-service instance carries load, baking or not.
    const util = offered / Math.max(1, this.usableCapacityTps());
    if (util > target) {
      if (this.breachSince < 0) this.breachSince = this.now;
    } else {
      this.breachSince = -1;
      return;
    }
    if (this.now - this.breachSince < c.stages.detectionMs) return; // alarm not yet firing
    if (this.now - this.lastDecisionAt < METRIC_PERIOD_MS) return; // no new datapoint yet
    // Simple scaling is the one policy AWS gates with a cooldown: it blocks
    // every decision until the cooldown expires, however far behind it falls.
    if (c.policy.type === 'simple' && this.now - this.lastLaunchAt < c.launch.cooldownMs) return;

    this.lastDecisionAt = this.now;
    const tier = this.stepTier(util / target - 1);
    const n = this.scaleOutSize(util, tier);
    if (n <= 0) return;
    for (let i = 0; i < n; i++) this.launchInstance();
    this.lastLaunchAt = this.now;
    this.metrics.totals.launches++;
    this.metrics.totals.instancesLaunched += n;
    this.metrics.totals.peakInstances = Math.max(this.metrics.totals.peakInstances, this.instances.length);
    this.metrics.log(
      this.now,
      'warn',
      `Scale-out (${POLICY_LABEL[c.policy.type]}): +${n} instance(s) → ${this.instances.length} — util ${Math.round(util * 100)}%`,
    );
  }

  /**
   * Instances to launch now. `metered` is the capacity the policy scales from —
   * in-service instances past their bake — while `currentDesired` counts
   * everything already requested, so capacity in flight is never re-requested.
   */
  private scaleOutSize(util: number, tier: number): number {
    const c = this.cfg;
    const p = c.policy;
    const currentDesired = this.instances.length;
    const room = c.launch.maxInstances - currentDesired;
    if (room <= 0) return 0;
    const metered = this.meteredInstances();

    let want: number;
    if (p.type === 'target-tracking') {
      // AWS target tracking: newCapacity = currentCapacity × metric ÷ target.
      want = metered * (util / c.capacity.targetUtilization) * p.scaleOutGain;
    } else {
      const from = p.type === 'simple' ? currentDesired : metered;
      const adj = p.type === 'simple' ? p.simpleAdjustment : (p.steps[tier]?.adjustment ?? 0);
      want = from + (p.adjustmentType === 'percent-change-in-capacity' ? roundPercentAdjustment(from, adj) : adj);
    }
    const newDesired = Math.max(currentDesired, Math.ceil(want - 1e-9));
    const n = newDesired - currentDesired;
    if (n <= 0) return 0;
    return Math.min(Math.max(n, c.launch.minStepSize), c.launch.maxStepSize, room);
  }

  /** In-service instances whose bake has expired — the capacity the policy counts. */
  private meteredInstances(): number {
    const bake = this.cfg.launch.bakeMs;
    let n = 0;
    for (const inst of this.instances) if (inst.inUse && this.now - inst.inServiceAt >= bake) n++;
    return n;
  }

  /** Highest step-ladder rung the breach — (util ÷ target) − 1 — has reached. */
  private stepTier(breach: number): number {
    const steps = this.cfg.policy.steps;
    let tier = 0;
    for (let i = 0; i < steps.length; i++) if (breach >= steps[i].lowerBound) tier = i;
    return tier;
  }

  private launchInstance(): void {
    const inst = new Instance(0, this.now, false);
    this.instances.push(inst);
    this.scheduleStage(inst);
  }

  private scheduleStage(inst: Instance): void {
    if (inst.stageIndex >= IN_USE_INDEX) return; // in use, no more transitions
    const durMs = this.stageDurationMs(inst.stageIndex);
    inst.stageEnteredAt = this.now;
    inst.stageEndsAt = this.now + durMs;
    inst.event = this.queue.schedule(inst.stageEndsAt, () => {
      inst.stageIndex++;
      if (inst.stageIndex < IN_USE_INDEX) this.scheduleStage(inst);
      else {
        inst.inServiceAt = this.now;
        inst.event = null;
      }
    });
  }

  private stageDurationMs(stageIndex: number): number {
    return this.cfg.stages[PIPELINE_STAGES[stageIndex].key];
  }

  /** Σ per-instance stages: launch → in service. Detection sits in front of it. */
  private perInstancePipelineMs(): number {
    let ms = 0;
    for (const s of PIPELINE_STAGES) ms += this.cfg.stages[s.key];
    return ms;
  }

  // -- Demand + rebalance ------------------------------------------------------

  private totalOffered(): number {
    const t = this.cfg.traffic;
    let base: number;
    switch (t.shape) {
      case 'steady':
        base = t.baseRateTps;
        break;
      case 'step':
        base = this.now >= t.rampStartMs ? t.baseRateTps + t.rampAmountTps : t.baseRateTps;
        break;
      case 'ramp': {
        const into = this.now - t.rampStartMs;
        const frac = into <= 0 ? 0 : Math.min(1, into / Math.max(1, t.rampDurationMs));
        base = t.baseRateTps + t.rampAmountTps * frac;
        break;
      }
    }
    return base * this.pulseFactor + this.rampAdd(this.now);
  }

  private readyCapacityTps(): number {
    const cap = this.cfg.capacity.capacityPerInstanceTps;
    let n = 0;
    for (const inst of this.instances) if (inst.ready) n++;
    return n * cap;
  }

  private usableCapacityTps(): number {
    const cap = this.cfg.capacity.capacityPerInstanceTps;
    let n = 0;
    for (const inst of this.instances) if (inst.inUse) n++;
    return n * cap;
  }

  private rebalance(): void {
    const offered = this.totalOffered();
    const usable = this.usableCapacityTps();
    const served = Math.min(offered, usable);
    this.rates = { offered, served };
    this.peakOfferedTps = Math.max(this.peakOfferedTps, offered);
    this.updateReadout(offered, served);
  }

  private utilization(): number {
    return this.totalOffered() / Math.max(1, this.usableCapacityTps());
  }

  // -- Scale-event readout -----------------------------------------------------

  private updateReadout(offered: number, served: number): void {
    const avail = offered > 1e-9 ? served / offered : 1;
    const slo = this.cfg.slaTarget;
    if (avail < slo - 1e-9) {
      if (this.eventStart < 0) {
        this.eventStart = this.now;
        this.eventBaseOffered = offered;
        this.eventPeakOffered = offered;
        this.eventMinAvail = avail;
        this.eventRecoverAt = -1;
      }
      this.eventMinAvail = Math.min(this.eventMinAvail, avail);
      this.eventPeakOffered = Math.max(this.eventPeakOffered, offered);
    } else if (this.eventStart >= 0 && this.eventRecoverAt < 0) {
      this.eventRecoverAt = this.now;
    }
  }

  /**
   * How long a scale-out has to wait before the next one can build on it: the
   * batch must finish the pipeline and then bake before it counts toward the
   * capacity the policy scales from. Simple scaling adds its cooldown on top,
   * and nothing acts faster than the metric period.
   */
  private decisionIntervalMs(): number {
    const c = this.cfg;
    const settle = this.perInstancePipelineMs() + c.launch.bakeMs;
    const cooldown = c.policy.type === 'simple' ? c.launch.cooldownMs : 0;
    return Math.max(settle, cooldown, METRIC_PERIOD_MS);
  }

  scaleReadout(): ScalingReadout {
    const c = this.cfg;
    const cap = c.capacity.capacityPerInstanceTps;
    const pipelineLatency = c.stages.detectionMs + this.perInstancePipelineMs();
    const interval = this.decisionIntervalMs();
    const maxRamp = (c.launch.maxStepSize * cap * 60000) / Math.max(1, interval);
    const active = this.eventStart >= 0;
    const recovered = this.eventRecoverAt >= 0;
    const recoverMs = !active ? 0 : recovered ? this.eventRecoverAt - this.eventStart : this.now - this.eventStart;
    const addedTps = active ? Math.max(0, this.eventPeakOffered - this.eventBaseOffered) : 0;
    const recoverMin = recoverMs / 60000;
    const requiredAtPeak = Math.ceil(this.peakOfferedTps / (c.capacity.targetUtilization * cap));
    const hold = this.holdView();
    return {
      active,
      recoverMs,
      recovered,
      effectiveAddRatePerMin: recovered && recoverMin > 1e-6 ? addedTps / recoverMin : 0,
      minAvailability: active ? this.eventMinAvail : 1,
      addedTps,
      maxSustainableRampPerMin: maxRamp,
      pipelineLatencyMs: pipelineLatency,
      decisionIntervalMs: interval,
      holdRemainingMs: hold.remainingMs,
      holdReason: hold.reason,
      overshootInstances: Math.max(0, this.metrics.totals.peakInstances - requiredAtPeak),
    };
  }

  /**
   * What the last scale-out is still waiting on — the bake window it has to
   * clear before it counts as capacity, or a simple-scaling cooldown.
   */
  private holdView(): { remainingMs: number; reason: 'bake' | 'cooldown' | null } {
    const c = this.cfg;
    if (this.lastLaunchAt === -Infinity) return { remainingMs: 0, reason: null };
    // Every launched instance is deterministic, so the batch's bake end is known
    // the moment it launches.
    const bakeEnd = this.lastLaunchAt + this.perInstancePipelineMs() + c.launch.bakeMs;
    const cooldownEnd = c.policy.type === 'simple' ? this.lastLaunchAt + c.launch.cooldownMs : -Infinity;
    const end = Math.max(bakeEnd, cooldownEnd);
    if (this.now >= end) return { remainingMs: 0, reason: null };
    return { remainingMs: end - this.now, reason: cooldownEnd > bakeEnd ? 'cooldown' : 'bake' };
  }

  // -- Views + conditions ------------------------------------------------------

  private gauges(): ScalingGauges {
    const bake = this.cfg.launch.bakeMs;
    let provisioning = 0;
    let ready = 0;
    let inUse = 0;
    let metered = 0;
    for (const inst of this.instances) {
      if (inst.inUse) {
        inUse++;
        if (this.now - inst.inServiceAt >= bake) metered++;
      } else if (inst.ready) ready++;
      else provisioning++;
    }
    return {
      offeredRate: this.rates.offered,
      readyCapacityTps: this.readyCapacityTps(),
      usableCapacityTps: this.usableCapacityTps(),
      meteredCapacityTps: metered * this.cfg.capacity.capacityPerInstanceTps,
      utilization: this.utilization(),
      provisioning,
      ready,
      inUse,
      baking: inUse - metered,
      inFlight: provisioning + ready,
    };
  }

  private detectConditions(): void {
    const avail = this.metrics.availability(10_000);
    const degraded = avail < this.cfg.slaTarget;
    if (degraded && !this.degradedWas) {
      this.throttledLog('degraded', 5000, 'critical', `Availability below SLO: ${(avail * 100).toFixed(1)}% — capacity can't keep up with demand`);
    }
    this.degradedWas = degraded;
  }

  private throttledLog(key: string, intervalMs: number, severity: 'info' | 'warn' | 'critical', message: string): void {
    const last = this.lastLogAt[key] ?? -Infinity;
    if (this.now - last < intervalMs) return;
    this.lastLogAt[key] = this.now;
    this.metrics.log(this.now, severity, message);
  }

  availability(windowMs = 10_000): number {
    return this.metrics.availability(windowMs);
  }

  degradedActive(): boolean {
    return this.degradedWas;
  }

  demandView(): ScalingDemandView {
    const g = this.gauges();
    const metered = this.meteredInstances();
    return {
      offeredTps: this.rates.offered,
      readyCapacityTps: g.readyCapacityTps,
      usableCapacityTps: g.usableCapacityTps,
      meteredCapacityTps: metered * this.cfg.capacity.capacityPerInstanceTps,
      utilization: g.utilization,
      targetUtilization: this.cfg.capacity.targetUtilization,
      provisioning: g.provisioning,
      ready: g.ready,
      inUse: g.inUse,
      baking: g.inUse - metered,
    };
  }

  instanceViews(): ScalingInstanceView[] {
    const bake = this.cfg.launch.bakeMs;
    return this.instances.map((inst) => {
      const total = inst.stageEndsAt - inst.stageEnteredAt;
      const prog = inst.inUse ? 1 : total > 0 ? Math.min(1, (this.now - inst.stageEnteredAt) / total) : 1;
      return {
        id: inst.id,
        stageIndex: inst.stageIndex,
        stageProgress: prog,
        ready: inst.ready,
        inUse: inst.inUse,
        baking: inst.inUse && this.now - inst.inServiceAt < bake,
        prewarmed: inst.prewarmed,
      };
    });
  }

  stageViews(): ScalingStageView[] {
    const counts = new Array(PIPELINE_STAGES.length).fill(0);
    for (const inst of this.instances) {
      if (inst.stageIndex < IN_USE_INDEX) counts[inst.stageIndex]++;
    }
    return PIPELINE_STAGES.map((s, i) => ({
      label: s.label,
      durationMs: this.cfg.stages[s.key],
      count: counts[i],
    }));
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * AWS PercentChangeInCapacity rounding: a magnitude above 1 rounds down (12.7 →
 * 12), and anything between 0 and 1 still moves by one instance.
 */
function roundPercentAdjustment(from: number, percent: number): number {
  const raw = (from * percent) / 100;
  if (raw > 0 && raw < 1) return 1;
  return Math.floor(raw);
}

const POLICY_LABEL: Record<ScalingPolicyType, string> = {
  'target-tracking': 'target tracking',
  step: 'step',
  simple: 'simple',
};

function fmtTps(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}
