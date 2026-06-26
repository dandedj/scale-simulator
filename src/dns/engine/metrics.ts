/**
 * DNS-model metrics: time-bucketed amounts and gauges the chart rail consumes.
 *
 * Mirrors the storm collector's shape (buckets + lifetime totals + event log)
 * but, because the model carries traffic as rates, the flow fields integrate
 * rate × time into request *amounts* rather than counting discrete events.
 * Buckets are 1s wide over a 20-minute window so a full surge-and-recover arc
 * (boot ~5min + DNS ~1min + TTL) is on screen at once.
 */

import type { DnsMetricsBucket, DnsSimEventLog } from './types';

/** Sim-time width of one metrics bucket (ms). */
export const BUCKET_MS = 1000;
/** How much history the strip charts keep (sim-time ms) — 20 minutes. */
export const HISTORY_MS = 1_200_000;

const MAX_BUCKETS = Math.ceil(HISTORY_MS / BUCKET_MS);

/** The piecewise-constant rate field (req/s) integrated between events. */
export interface DnsRates {
  offered: number;
  served: number;
  shed: number;
  staleHit: number;
  capacityShortfall: number;
  staleUnavailable: number;
  /** Provisioned capacity (req/s) — integrated to capacity-seconds for cost. */
  provisioned: number;
}

/** Gauges sampled when a bucket closes. */
export interface DnsGauges {
  offeredRate: number;
  servedRate: number;
  advertisedHealthyCount: number;
  advertisedCapacity: number;
  meanServerLoad: number;
  maxServerLoad: number;
  healthyCount: number;
  bootingCount: number;
  overloadedCount: number;
  drainingCount: number;
  downCount: number;
  provisionedCapacity: number;
}

export class DnsMetricsCollector {
  buckets: DnsMetricsBucket[] = [];
  /** Lifetime totals (odometers in the UI). */
  totals = {
    offered: 0,
    served: 0,
    shed: 0,
    staleHit: 0,
    capacityShortfall: 0,
    staleUnavailable: 0,
    reResolves: 0,
    serversBooted: 0,
    serverReplacements: 0,
    scaleOutEvents: 0,
    serversKilled: 0,
    /** ∫ offered×(1−availability) dt, in request·seconds — the dip's area. */
    lostImpressions: 0,
    /** Cost axis: capacity-seconds the fleet was billed for (non-down servers). */
    provisionedSeconds: 0,
    /** Capacity-seconds actually used (served). */
    servedSeconds: 0,
  };
  events: DnsSimEventLog[] = [];
  /** Lifetime count of logged events (events[] is capped; this never resets). */
  totalLogged = 0;

  private current: DnsMetricsBucket;
  private peakMaxLoad = 0;

  constructor() {
    this.current = this.newBucket(0);
  }

  /** Time of the next bucket boundary — used to segment-align integration. */
  nextBoundary(): number {
    return this.current.time + BUCKET_MS;
  }

  /** Integrate piecewise-constant rates over dtMs into the current bucket. */
  accumulate(dtMs: number, r: DnsRates): void {
    const s = dtMs / 1000;
    const unavail = (r.capacityShortfall + r.staleUnavailable) * s;
    this.current.offered += r.offered * s;
    this.current.served += r.served * s;
    this.current.shed += r.shed * s;
    this.current.staleHit += r.staleHit * s;
    this.current.capacityShortfall += r.capacityShortfall * s;
    this.current.staleUnavailable += r.staleUnavailable * s;
    this.totals.offered += r.offered * s;
    this.totals.served += r.served * s;
    this.totals.shed += r.shed * s;
    this.totals.staleHit += r.staleHit * s;
    this.totals.capacityShortfall += r.capacityShortfall * s;
    this.totals.staleUnavailable += r.staleUnavailable * s;
    this.totals.lostImpressions += unavail;
    this.totals.provisionedSeconds += r.provisioned * s;
    this.totals.servedSeconds += r.served * s;
  }

  /** Close out buckets up to `now`, snapshotting gauges. */
  advance(now: number, g: DnsGauges): void {
    this.peakMaxLoad = Math.max(this.peakMaxLoad, g.maxServerLoad);
    while (now >= this.current.time + BUCKET_MS) {
      this.current.offeredRate = g.offeredRate;
      this.current.servedRate = g.servedRate;
      this.current.advertisedHealthyCount = g.advertisedHealthyCount;
      this.current.advertisedCapacity = g.advertisedCapacity;
      this.current.meanServerLoad = g.meanServerLoad;
      this.current.maxServerLoad = this.peakMaxLoad;
      this.current.healthyCount = g.healthyCount;
      this.current.bootingCount = g.bootingCount;
      this.current.overloadedCount = g.overloadedCount;
      this.current.drainingCount = g.drainingCount;
      this.current.downCount = g.downCount;
      this.current.provisionedCapacity = g.provisionedCapacity;
      this.buckets.push(this.current);
      if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
      this.current = this.newBucket(this.current.time + BUCKET_MS);
      this.peakMaxLoad = g.maxServerLoad;
    }
  }

  countReResolve(n = 1): void {
    this.current.reResolves += n;
    this.totals.reResolves += n;
  }

  log(time: number, severity: DnsSimEventLog['severity'], message: string): void {
    this.events.push({ time, severity, message });
    this.totalLogged++;
    if (this.events.length > 200) this.events.shift();
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

  /** Lifetime availability (served ÷ offered). */
  lifetimeAvailability(): number {
    return this.totals.offered > 1e-9 ? Math.min(1, this.totals.served / this.totals.offered) : 1;
  }

  lastClosedBucket(): DnsMetricsBucket | null {
    return this.buckets.length > 0 ? this.buckets[this.buckets.length - 1] : null;
  }

  reset(): void {
    this.buckets = [];
    this.events = [];
    this.totalLogged = 0;
    this.current = this.newBucket(0);
    this.peakMaxLoad = 0;
    for (const k of Object.keys(this.totals) as (keyof typeof this.totals)[]) {
      this.totals[k] = 0;
    }
  }

  private newBucket(time: number): DnsMetricsBucket {
    return {
      time,
      offered: 0,
      served: 0,
      shed: 0,
      staleHit: 0,
      capacityShortfall: 0,
      staleUnavailable: 0,
      reResolves: 0,
      offeredRate: 0,
      servedRate: 0,
      advertisedHealthyCount: 0,
      advertisedCapacity: 0,
      meanServerLoad: 0,
      maxServerLoad: 0,
      healthyCount: 0,
      bootingCount: 0,
      overloadedCount: 0,
      drainingCount: 0,
      downCount: 0,
      provisionedCapacity: 0,
    };
  }
}
