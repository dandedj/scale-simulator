/**
 * Scaling-model metrics: time-bucketed amounts and gauges the chart rail reads.
 * Mirrors the DNS collector — rate integration into request amounts plus gauges
 * sampled at bucket close — with fields for the demand/capacity/utilization story.
 * 2s buckets over a 2-hour window: a slow ramp plus a bake-throttled recovery is
 * an hours-long arc, and the rail scales its view to whatever has run so far.
 */

import type { ScalingMetricsBucket, ScalingSimEventLog } from './types';

export const BUCKET_MS = 2000;
export const HISTORY_MS = 7_200_000;
const MAX_BUCKETS = Math.ceil(HISTORY_MS / BUCKET_MS);
/** Event retention — the ticker shows the tail, the timeline pane plots them all. */
const MAX_EVENTS = 500;

/** The piecewise-constant rate field (TPS) integrated between events. */
export interface ScalingRates {
  offered: number;
  served: number;
}

export interface ScalingGauges {
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

export class ScalingMetricsCollector {
  buckets: ScalingMetricsBucket[] = [];
  totals = {
    offered: 0,
    served: 0,
    /** Lost requests = ∫ (offered − served) — the availability dip's area. */
    lost: 0,
    launches: 0,
    instancesLaunched: 0,
    peakInstances: 0,
  };
  events: ScalingSimEventLog[] = [];
  totalLogged = 0;

  private current: ScalingMetricsBucket;

  constructor() {
    this.current = this.newBucket(0);
  }

  nextBoundary(): number {
    return this.current.time + BUCKET_MS;
  }

  accumulate(dtMs: number, r: ScalingRates): void {
    const s = dtMs / 1000;
    const lost = Math.max(0, r.offered - r.served) * s;
    this.current.offered += r.offered * s;
    this.current.served += r.served * s;
    this.current.lost += lost;
    this.totals.offered += r.offered * s;
    this.totals.served += r.served * s;
    this.totals.lost += lost;
  }

  advance(now: number, g: ScalingGauges): void {
    while (now >= this.current.time + BUCKET_MS) {
      this.current.offeredRate = g.offeredRate;
      this.current.readyCapacityTps = g.readyCapacityTps;
      this.current.usableCapacityTps = g.usableCapacityTps;
      this.current.meteredCapacityTps = g.meteredCapacityTps;
      this.current.utilization = g.utilization;
      this.current.provisioning = g.provisioning;
      this.current.ready = g.ready;
      this.current.inUse = g.inUse;
      this.current.baking = g.baking;
      this.current.inFlight = g.inFlight;
      this.buckets.push(this.current);
      if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
      this.current = this.newBucket(this.current.time + BUCKET_MS);
    }
  }

  log(
    time: number,
    severity: ScalingSimEventLog['severity'],
    kind: ScalingSimEventLog['kind'],
    message: string,
    value?: number,
  ): void {
    this.events.push({ time, severity, kind, message, value });
    this.totalLogged++;
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  /** Rolling availability (served ÷ offered) over the last windowMs of closed buckets. */
  availability(windowMs: number): number {
    if (this.buckets.length === 0) return 1;
    const cutoff = this.buckets[this.buckets.length - 1].time - windowMs;
    let o = 0;
    let s = 0;
    for (let i = this.buckets.length - 1; i >= 0; i--) {
      const b = this.buckets[i];
      if (b.time < cutoff) break;
      o += b.offered;
      s += b.served;
    }
    return o > 1e-9 ? Math.min(1, s / o) : 1;
  }

  lifetimeAvailability(): number {
    return this.totals.offered > 1e-9 ? Math.min(1, this.totals.served / this.totals.offered) : 1;
  }

  reset(): void {
    this.buckets = [];
    this.events = [];
    this.totalLogged = 0;
    this.current = this.newBucket(0);
    for (const k of Object.keys(this.totals) as (keyof typeof this.totals)[]) this.totals[k] = 0;
  }

  private newBucket(time: number): ScalingMetricsBucket {
    return {
      time,
      offered: 0,
      served: 0,
      lost: 0,
      offeredRate: 0,
      readyCapacityTps: 0,
      usableCapacityTps: 0,
      meteredCapacityTps: 0,
      utilization: 0,
      provisioning: 0,
      ready: 0,
      inUse: 0,
      baking: 0,
      inFlight: 0,
    };
  }
}
