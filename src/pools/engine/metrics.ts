import type { PoolAggregates, PoolEventLog, PoolMetricsBucket } from './types';

export const POOL_BUCKET_MS = 1000;
export const POOL_HISTORY_MS = 180_000;
const MAX_BUCKETS = Math.ceil(POOL_HISTORY_MS / POOL_BUCKET_MS);

/** Counts from one internal tick (or one instantaneous event, with dtMs 0). */
export interface PoolStepTally {
  dtMs: number;
  baseRequests: number;
  effectiveRequests: number;
  servedRequests: number;
  failedRequests: number;
  attempts: number;
  opened: number;
  resets: number;
  closed: number;
}

export class PoolMetricsCollector {
  buckets: PoolMetricsBucket[] = [];
  events: PoolEventLog[] = [];
  totalLogged = 0;
  totals = {
    baseRequests: 0,
    effectiveRequests: 0,
    servedRequests: 0,
    failedRequests: 0,
    connectionAttempts: 0,
    connectionsOpened: 0,
    connectionResets: 0,
    connectionsClosed: 0,
    connectionSeconds: 0,
    peakConnections: 0,
    peakHottestResponder: 0,
  };

  private current = this.newBucket(0);

  nextBoundary(): number {
    return this.current.time + POOL_BUCKET_MS;
  }

  record(step: PoolStepTally, agg: PoolAggregates): void {
    const c = this.current;
    const t = this.totals;
    c.baseRequests += step.baseRequests;
    c.effectiveRequests += step.effectiveRequests;
    c.servedRequests += step.servedRequests;
    c.failedRequests += step.failedRequests;
    c.connectionAttempts += step.attempts;
    c.connectionsOpened += step.opened;
    c.connectionResets += step.resets;
    c.connectionsClosed += step.closed;
    t.baseRequests += step.baseRequests;
    t.effectiveRequests += step.effectiveRequests;
    t.servedRequests += step.servedRequests;
    t.failedRequests += step.failedRequests;
    t.connectionAttempts += step.attempts;
    t.connectionsOpened += step.opened;
    t.connectionResets += step.resets;
    t.connectionsClosed += step.closed;
    t.connectionSeconds += (agg.established * step.dtMs) / 1000;
    t.peakConnections = Math.max(t.peakConnections, agg.established);
    t.peakHottestResponder = Math.max(t.peakHottestResponder, agg.hottestResponder);
  }

  advance(now: number, s: PoolAggregates): void {
    while (now >= this.current.time + POOL_BUCKET_MS - 1e-9) {
      this.current.baseRate = s.baseRate;
      this.current.effectiveRate = s.effectiveRate;
      this.current.servedRate = s.servedRate;
      this.current.established = s.established;
      this.current.busy = s.busy;
      this.current.idle = s.idle;
      this.current.pending = s.pending;
      this.current.desired = s.desiredConnections;
      this.current.littleLawRequired = s.littleLawRequired;
      this.current.connectionAmplification = s.connectionAmplification;
      this.current.poolKeys = s.poolKeys;
      this.current.hottestResponder = s.hottestResponder;
      this.current.responderPressure = s.responderPressure;
      this.current.reuseRatio = s.reuseRatio;
      this.buckets.push(this.current);
      if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
      this.current = this.newBucket(this.current.time + POOL_BUCKET_MS);
    }
  }

  log(time: number, severity: PoolEventLog['severity'], message: string): void {
    this.events.push({ time, severity, message });
    this.totalLogged++;
    if (this.events.length > 200) this.events.shift();
  }

  lifetimeSuccess(): number {
    return this.totals.effectiveRequests > 1e-9
      ? Math.min(1, this.totals.servedRequests / this.totals.effectiveRequests)
      : 1;
  }

  private newBucket(time: number): PoolMetricsBucket {
    return {
      time,
      baseRequests: 0,
      effectiveRequests: 0,
      servedRequests: 0,
      failedRequests: 0,
      connectionAttempts: 0,
      connectionsOpened: 0,
      connectionResets: 0,
      connectionsClosed: 0,
      baseRate: 0,
      effectiveRate: 0,
      servedRate: 0,
      established: 0,
      busy: 0,
      idle: 0,
      pending: 0,
      desired: 0,
      littleLawRequired: 0,
      connectionAmplification: 0,
      poolKeys: 0,
      hottestResponder: 0,
      responderPressure: 0,
      reuseRatio: 1,
    };
  }
}
