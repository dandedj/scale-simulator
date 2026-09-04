import type { PoolEventLog, PoolMetricsBucket, PoolSnapshot } from './types';

export const POOL_BUCKET_MS = 1000;
export const POOL_HISTORY_MS = 180_000;
const MAX_BUCKETS = Math.ceil(POOL_HISTORY_MS / POOL_BUCKET_MS);

export interface ConnectionDeltas {
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

  accumulate(dtMs: number, s: PoolSnapshot): void {
    const seconds = dtMs / 1000;
    this.current.baseRequests += s.baseRate * seconds;
    this.current.effectiveRequests += s.effectiveRate * seconds;
    this.current.servedRequests += s.servedRate * seconds;
    this.current.failedRequests += s.failedRate * seconds;
    this.totals.baseRequests += s.baseRate * seconds;
    this.totals.effectiveRequests += s.effectiveRate * seconds;
    this.totals.servedRequests += s.servedRate * seconds;
    this.totals.failedRequests += s.failedRate * seconds;
    this.totals.connectionSeconds += s.established * seconds;
    this.totals.peakConnections = Math.max(this.totals.peakConnections, s.established);
    this.totals.peakHottestResponder = Math.max(this.totals.peakHottestResponder, s.hottestResponder);
  }

  connections(delta: ConnectionDeltas): void {
    this.current.connectionAttempts += delta.attempts;
    this.current.connectionsOpened += delta.opened;
    this.current.connectionResets += delta.resets;
    this.current.connectionsClosed += delta.closed;
    this.totals.connectionAttempts += delta.attempts;
    this.totals.connectionsOpened += delta.opened;
    this.totals.connectionResets += delta.resets;
    this.totals.connectionsClosed += delta.closed;
  }

  advance(now: number, s: PoolSnapshot): void {
    while (now >= this.current.time + POOL_BUCKET_MS - 1e-9) {
      this.current.baseRate = s.baseRate;
      this.current.effectiveRate = s.effectiveRate;
      this.current.servedRate = s.servedRate;
      this.current.established = s.established;
      this.current.busy = s.busy;
      this.current.idle = s.idle;
      this.current.pending = s.pending;
      this.current.desired = s.desiredConnections;
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
      poolKeys: 0,
      hottestResponder: 0,
      responderPressure: 0,
      reuseRatio: 1,
    };
  }
}
