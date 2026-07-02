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
 */

import { EventQueue, type ScheduledEvent } from '../../engine/eventQueue';
import { type ScalingGauges, ScalingMetricsCollector, type ScalingRates } from './metrics';
import {
  PIPELINE_STAGES,
  type ScalingDemandView,
  type ScalingInstanceView,
  type ScalingReadout,
  type ScalingSimulationConfig,
  type ScalingStageView,
} from './types';

/** Autoscaler evaluation + demand-ramp refresh cadence (ms). */
const TICK_MS = 2000;
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
  event: ScheduledEvent | null = null;

  constructor(stageIndex: number, now: number, prewarmed: boolean) {
    this.stageIndex = stageIndex;
    this.stageEnteredAt = now;
    this.stageEndsAt = now;
    this.prewarmed = prewarmed;
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

  private rates: ScalingRates = { offered: 0, served: 0 };
  private breachSince = -1;
  private lastLaunchAt = -Infinity;

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
    const cap = c.capacity.capacityPerInstanceTps;
    const offered = this.totalOffered();
    const util = offered / Math.max(1, this.usableCapacityTps());
    if (util > c.capacity.targetUtilization) {
      if (this.breachSince < 0) this.breachSince = this.now;
    } else {
      this.breachSince = -1;
    }
    if (this.breachSince < 0) return;
    if (this.now - this.breachSince < c.stages.detectionMs) return; // alarm not yet firing
    if (this.now - this.lastLaunchAt < c.launch.cooldownMs) return; // cooling down
    const desired = Math.ceil(offered / (c.capacity.targetUtilization * cap));
    const total = this.instances.length;
    const shortfall = desired - total;
    if (shortfall <= 0 || total >= c.launch.maxInstances) return;
    const n = Math.min(shortfall, c.launch.launchBatchSize, c.launch.maxInstances - total);
    for (let i = 0; i < n; i++) this.launchInstance();
    this.lastLaunchAt = this.now;
    this.metrics.totals.launches++;
    this.metrics.totals.instancesLaunched += n;
    this.metrics.totals.peakInstances = Math.max(this.metrics.totals.peakInstances, this.instances.length);
    this.metrics.log(this.now, 'warn', `Scale-out: launching ${n} instance(s) — util ${Math.round(util * 100)}%`);
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
      else inst.event = null;
    });
  }

  private stageDurationMs(stageIndex: number): number {
    return this.cfg.stages[PIPELINE_STAGES[stageIndex].key];
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
        base = this.now >= t.rampStartMs ? t.peakRateTps : t.baseRateTps;
        break;
      case 'ramp': {
        const into = this.now - t.rampStartMs;
        const frac = into <= 0 ? 0 : Math.min(1, into / Math.max(1, t.rampDurationMs));
        base = t.baseRateTps + (t.peakRateTps - t.baseRateTps) * frac;
        break;
      }
    }
    return base * this.pulseFactor;
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

  scaleReadout(): ScalingReadout {
    const c = this.cfg;
    const cap = c.capacity.capacityPerInstanceTps;
    let pipelineLatency = c.stages.detectionMs;
    for (const s of PIPELINE_STAGES) pipelineLatency += c.stages[s.key];
    const maxRamp = (c.launch.launchBatchSize * cap * 60000) / Math.max(1, c.launch.cooldownMs);
    const active = this.eventStart >= 0;
    const recovered = this.eventRecoverAt >= 0;
    const recoverMs = !active ? 0 : recovered ? this.eventRecoverAt - this.eventStart : this.now - this.eventStart;
    const addedTps = active ? Math.max(0, this.eventPeakOffered - this.eventBaseOffered) : 0;
    const recoverMin = recoverMs / 60000;
    return {
      active,
      recoverMs,
      recovered,
      effectiveAddRatePerMin: recovered && recoverMin > 1e-6 ? addedTps / recoverMin : 0,
      minAvailability: active ? this.eventMinAvail : 1,
      addedTps,
      maxSustainableRampPerMin: maxRamp,
      pipelineLatencyMs: pipelineLatency,
    };
  }

  // -- Views + conditions ------------------------------------------------------

  private gauges(): ScalingGauges {
    let provisioning = 0;
    let ready = 0;
    let inUse = 0;
    for (const inst of this.instances) {
      if (inst.inUse) inUse++;
      else if (inst.ready) ready++;
      else provisioning++;
    }
    return {
      offeredRate: this.rates.offered,
      readyCapacityTps: this.readyCapacityTps(),
      usableCapacityTps: this.usableCapacityTps(),
      utilization: this.utilization(),
      provisioning,
      ready,
      inUse,
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
    return {
      offeredTps: this.rates.offered,
      readyCapacityTps: g.readyCapacityTps,
      usableCapacityTps: g.usableCapacityTps,
      utilization: g.utilization,
      targetUtilization: this.cfg.capacity.targetUtilization,
      provisioning: g.provisioning,
      ready: g.ready,
      inUse: g.inUse,
    };
  }

  instanceViews(): ScalingInstanceView[] {
    return this.instances.map((inst) => {
      const total = inst.stageEndsAt - inst.stageEnteredAt;
      const prog = inst.inUse ? 1 : total > 0 ? Math.min(1, (this.now - inst.stageEnteredAt) / total) : 1;
      return {
        id: inst.id,
        stageIndex: inst.stageIndex,
        stageProgress: prog,
        ready: inst.ready,
        inUse: inst.inUse,
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
