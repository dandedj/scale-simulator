import type { MetricsBucket, SimEventLog } from './types';

/** Sim-time width of one metrics bucket (ms). Charts plot one point per bucket. */
export const BUCKET_MS = 250;

/** How much history the strip charts keep (sim-time ms). */
export const HISTORY_MS = 60_000;

const MAX_BUCKETS = Math.ceil(HISTORY_MS / BUCKET_MS);

/**
 * Per-interval counters and gauges, bucketed in sim time. The renderer reads
 * `buckets` directly; the engine calls the count* methods as events occur.
 */
export class MetricsCollector {
  buckets: MetricsBucket[] = [];
  /** Lifetime totals (shown as odometers in the UI). */
  totals = {
    arrivals: 0,
    successes: 0,
    timeouts: 0,
    shedTls: 0,
    shedConnLimit: 0,
    shedConnRate: 0,
    errors: 0,
    rejected: 0,
    retries: 0,
    tlsHandshakesCompleted: 0,
    resumedHandshakes: 0,
    wastedHandshakes: 0,
    // Running latency moments (over successful requests) for the A/B mean test.
    latencySum: 0,
    latencySumSq: 0,
  };
  events: SimEventLog[] = [];
  /** Lifetime count of logged events (events[] is capped; this never resets mid-run). */
  totalLogged = 0;

  private current: MetricsBucket;
  private peakCpu = 0;
  private peakLockUtil = 0;
  private peakLockWaitMs = 0;

  constructor() {
    this.current = this.newBucket(0);
  }

  /** Close out buckets up to `now`; called by the engine each step. */
  advance(
    now: number,
    gauges: {
      connections: number;
      queueDepth: number;
      cpu: number;
      handshakesActive: number;
      lockUtilization: number;
      lockWaitMs: number;
    },
  ): void {
    this.peakCpu = Math.max(this.peakCpu, gauges.cpu);
    this.peakLockUtil = Math.max(this.peakLockUtil, gauges.lockUtilization);
    this.peakLockWaitMs = Math.max(this.peakLockWaitMs, gauges.lockWaitMs);
    while (now >= this.current.time + BUCKET_MS) {
      this.current.fabricConnections = gauges.connections;
      this.current.fabricQueueDepth = gauges.queueDepth;
      this.current.cpuUtilization = this.peakCpu;
      this.current.handshakesActive = gauges.handshakesActive;
      this.current.lockUtilization = this.peakLockUtil;
      this.current.lockWaitMs = this.peakLockWaitMs;
      // Closed buckets are immutable; sort once so percentile() can index.
      this.current.latencies.sort((a, b) => a - b);
      this.buckets.push(this.current);
      if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
      this.current = this.newBucket(this.current.time + BUCKET_MS);
      this.peakCpu = gauges.cpu;
      this.peakLockUtil = gauges.lockUtilization;
      this.peakLockWaitMs = gauges.lockWaitMs;
    }
  }

  countArrival(): void {
    this.current.arrivals++;
    this.totals.arrivals++;
  }
  countSuccess(latencyMs: number): void {
    this.current.successes++;
    this.current.latencies.push(latencyMs);
    this.totals.successes++;
    this.totals.latencySum += latencyMs;
    this.totals.latencySumSq += latencyMs * latencyMs;
  }
  countTimeout(): void {
    this.current.timeouts++;
    this.totals.timeouts++;
  }
  countShedTls(): void {
    this.current.shedTls++;
    this.totals.shedTls++;
  }
  countShedConnLimit(): void {
    this.current.shedConnLimit++;
    this.totals.shedConnLimit++;
  }
  countShedConnRate(): void {
    this.current.shedConnRate++;
    this.totals.shedConnRate++;
  }
  countError(): void {
    this.current.errors++;
    this.totals.errors++;
  }
  countRejected(): void {
    this.current.rejected++;
    this.totals.rejected++;
  }
  countRetry(): void {
    this.current.retries++;
    this.totals.retries++;
  }
  countHandshakeStarted(resumed: boolean): void {
    this.current.tlsHandshakesStarted++;
    if (resumed) {
      this.current.tlsHandshakesResumed++;
      this.totals.resumedHandshakes++;
    }
  }
  countHandshakeCompleted(wasted: boolean): void {
    this.current.tlsHandshakesCompleted++;
    this.totals.tlsHandshakesCompleted++;
    if (wasted) this.totals.wastedHandshakes++;
  }

  log(time: number, severity: SimEventLog['severity'], message: string): void {
    this.events.push({ time, severity, message });
    this.totalLogged++;
    if (this.events.length > 200) this.events.shift();
  }

  /** Most recently *closed* bucket (stable values for storm detection). */
  lastClosedBucket(): MetricsBucket | null {
    return this.buckets.length > 0 ? this.buckets[this.buckets.length - 1] : null;
  }

  reset(): void {
    this.buckets = [];
    this.events = [];
    this.totalLogged = 0;
    this.current = this.newBucket(0);
    this.peakCpu = 0;
    this.peakLockUtil = 0;
    this.peakLockWaitMs = 0;
    for (const k of Object.keys(this.totals) as (keyof typeof this.totals)[]) {
      this.totals[k] = 0;
    }
  }

  private newBucket(time: number): MetricsBucket {
    return {
      time,
      arrivals: 0,
      successes: 0,
      timeouts: 0,
      shedTls: 0,
      shedConnLimit: 0,
      shedConnRate: 0,
      errors: 0,
      rejected: 0,
      retries: 0,
      tlsHandshakesStarted: 0,
      tlsHandshakesResumed: 0,
      tlsHandshakesCompleted: 0,
      latencies: [],
      fabricConnections: 0,
      fabricQueueDepth: 0,
      cpuUtilization: 0,
      handshakesActive: 0,
      lockUtilization: 0,
      lockWaitMs: 0,
    };
  }
}

/**
 * Percentile of a SORTED sample array (p in [0,1]). Returns 0 when empty.
 * Closed buckets sort their latencies once at close time (see advance()).
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
