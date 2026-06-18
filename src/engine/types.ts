/**
 * Shared types: simulation configuration, entity state, and metrics.
 *
 * All durations are virtual simulation milliseconds (real-world scale, e.g. a
 * request takes ~150ms). The renderer slows playback via the time-dilation
 * factor in PlaybackConfig — the model itself always thinks in real time.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClientConfig {
  /** Number of client instances. */
  count: number;
  /** Target request rate per client, requests/second (Poisson arrivals). */
  requestRatePerSec: number;
  /** Connections each client may hold open to RTB Fabric. */
  poolSize: number;
  /**
   * Round-trip network time between a client and the fabric (ms). Drives
   * every wire leg (SYN, request, response, RST) and the handshake's hello
   * exchanges — fast clients are dangerous because their retries come back
   * quickly.
   */
  rttMs: number;
  /**
   * Extra time a burdened client takes to answer during the TLS handshake
   * (ms). Stretches the handshake — holding its permit — without consuming
   * any fabric CPU.
   */
  tlsClientDelayMs: number;
  /**
   * The client's single deadline per attempt (ms). It traps both phases:
   * the wait for a connection — including any hot-path rebuild and its TLS
   * handshake — and the request itself. Connection attempts opened under
   * pressure are abandoned on the same bound; only prewarmed connections
   * are built outside it. Clients with high RTTs typically run higher
   * timeouts.
   */
  clientTimeoutMs: number;
  /** Retries after a timeout or error (0 = fire once, never retry). */
  maxRetries: number;
  /** Base delay before the first retry (ms); doubles each attempt. */
  retryBackoffBaseMs: number;
  /** Add full jitter to backoff (the difference between a wave and a wall). */
  retryJitter: boolean;

  /** Client-side circuit breaker toward the fabric. */
  circuitBreakerEnabled: boolean;
  /** Open when failure ratio over the rolling window exceeds this. */
  breakerFailureRatio: number;
  /** Minimum samples in the window before the breaker may trip. */
  breakerMinSamples: number;
  /** How long the breaker stays open before probing (ms). */
  breakerCooldownMs: number;
}

export interface FabricConfig {
  /** Hard cap on concurrent client-facing connections; beyond it, connects are shed (RST). */
  maxConnections: number;
  /** TLS handshake permits: handshakes processed concurrently. */
  tlsHandshakeConcurrency: number;
  /**
   * How long a connection may wait for a free TLS permit before the fabric
   * sheds it with an RST (which invalidates the connection). 0 = shed
   * immediately when no permit is free. There is no TLS queue — only this
   * bounded wait. Typical values: 0–5ms.
   */
  tlsPermitWaitMs: number;
  /**
   * Fabric-side CPU processing time for one full TLS handshake at idle (ms).
   * The wire portion of a handshake comes from the client RTT (2 round trips
   * full, 1 resumed) plus the client TLS delay — those stretch the handshake
   * and hold its permit but consume no fabric CPU.
   */
  tlsHandshakeCpuMs: number;
  /** Fraction of handshakes that use TLS session resumption (0..1). */
  tlsResumptionRate: number;
  /** Resumed handshake cost as a fraction of a full handshake (time and CPU). */
  tlsResumptionCostFactor: number;
  /** Nominal fabric processing time per request at idle (ms). */
  processingMs: number;
  /**
   * CPU work-units/second. Requests cost ~1 unit/ms of processing; TLS
   * handshakes cost tlsCpuCost units each. When demanded work exceeds
   * capacity every in-flight operation stretches proportionally — this is
   * the coupling that turns a handshake burst into a storm.
   */
  cpuCapacity: number;
  /** CPU work-units consumed by one full TLS handshake (vs ~processingMs for a request). */
  tlsCpuCost: number;

  /**
   * TLS error pacing: how long the fabric holds the RST when shedding a
   * connection at TLS admission, so shed clients don't learn — and
   * reconnect — in lockstep. Typical values: 0–5ms (range runs to 100ms).
   * The held connection stays live for the delay and carries a small trickle
   * of fabric CPU, so a long hold under a heavy shed is not free.
   */
  tlsErrorPacingEnabled: boolean;
  tlsErrorPacingDelayMs: number;

  /**
   * Connection-rate shedding: a per-server, in-memory token-bucket limiter at
   * TCP accept. New connections refill the bucket at connRateLimitPerSec; each
   * accepted connection spends a token. When the bucket is empty the connection
   * is rejected at accept (RST) before any TLS work — so a storm of new
   * connections is bounced at near-zero cost, before it can melt the handshake
   * CPU. Unlike the static connection limit (a cap on concurrent connections)
   * or the TLS permit limit (a cap on concurrent handshakes), this caps the
   * *rate* of new connections, throttling handshake demand at the source.
   */
  connRateShedEnabled: boolean;
  /** Sustained new-connection accept rate per fabric server (conns/sec) — the bucket's refill rate. */
  connRateLimitPerSec: number;
  /** Burst capacity (tokens): how many new connections are absorbed at once before the rate throttles. */
  connRateBurst: number;

  /**
   * Locks: serialization points (mutexes, Arc<Mutex<…>>) the fabric takes
   * around shared state. Each is a single-server FIFO with a hold time; under
   * contention, waiting on the lock — not the CPU — becomes the bottleneck.
   */
  locks: LockConfig[];
  /**
   * Representative per-server request throughput (QPS) the demo stands in for.
   * A µs-scale lock is invisible at the demo's actual event rate, so lock
   * pressure is scaled up to this rate: a request-site lock's utilization works
   * out to repQPS × holdTime. Raise it to model vertically scaling the server.
   */
  lockRepThroughputQps: number;
}

/** Where in the fabric a lock is acquired. */
export type LockSite = 'accept' | 'request' | 'handshake';

export interface LockConfig {
  /** Stable identifier (runtime contention state is keyed on this). */
  id: string;
  /** Display name, e.g. "max-conns counter (Arc<Mutex>)". */
  name: string;
  /** Operation that takes the lock: every connection accept, request, or handshake. */
  site: LockSite;
  /** Time the critical section is held per acquisition, microseconds. */
  holdTimeUs: number;
  enabled: boolean;
}

export interface DownstreamPoolConfig {
  /** Connections RTB Fabric holds per downstream. */
  poolSizePerDownstream: number;
  /** Fabric abandons a downstream call this long after routing it — the budget covers queue wait + wire time (ms). */
  requestTimeoutMs: number;
  /** Time to establish a fabric→downstream connection (ms). */
  connectMs: number;
}

export interface DownstreamConfig {
  /** Number of downstream systems. */
  count: number;
  /** Median response time (ms); log-normal tail. */
  responseTimeMedianMs: number;
  /** Log-normal sigma: 0.3 ≈ 2x p99/median, 0.6 ≈ 4x. */
  responseTimeSigma: number;
  /** Probability a request returns an error instead of a success. */
  errorRate: number;
  /** Concurrent requests one downstream absorbs before its latency inflates. */
  concurrencyCapacity: number;
}

export interface SimulationConfig {
  seed: number;
  clients: ClientConfig;
  fabric: FabricConfig;
  downstreamPool: DownstreamPoolConfig;
  downstreams: DownstreamConfig;
}

export interface Preset {
  id: string;
  name: string;
  /** What the audience should watch for. */
  description: string;
  config: SimulationConfig;
}

// ---------------------------------------------------------------------------
// Entity state enums + the fabric gauge snapshot.
// The renderer reads the engine entities (ConnSim, RequestSim, ClientSim,
// DownstreamSim in simulation.ts) directly each frame; these shared types
// describe their state machines.
// ---------------------------------------------------------------------------

export type ConnectionState =
  | 'connecting'   // TCP open + waiting for / undergoing TLS handshake
  | 'handshaking'  // TLS handshake actively being processed by the fabric
  | 'idle'         // established, available for a request
  | 'busy'         // carrying an in-flight request
  | 'closing';     // torn down (brief visual state before removal)

export type RequestPhase =
  | 'waitingForConnection' // queued in the client waiting for a pooled conn
  | 'travelingToFabric'
  | 'queuedAtFabric'
  | 'processingAtFabric'
  | 'travelingToDownstream'
  | 'atDownstream'
  | 'returning';           // response traveling back to the client

export type RequestFate = 'success' | 'timeout' | 'error' | 'rejected';

export type BreakerState = 'closed' | 'open' | 'halfOpen';

/** Snapshot of the fabric's gauges, built once per frame for the renderer. */
export interface FabricView {
  connectionCount: number;
  maxConnections: number;
  handshakesActive: number;
  /** Connections currently waiting (time-bounded) for a TLS permit. */
  permitWaiting: number;
  /** Requests inside the fabric: processing + queued + at a downstream. */
  inFlight: number;
  /** Demanded work / capacity. >1 means everything is stretching. */
  cpuUtilization: number;
  /** Effective slowdown multiplier applied to all service times. */
  slowdownFactor: number;
}

/** Live contention state for one enabled lock (renderer-facing). */
export interface LockView {
  name: string;
  site: LockSite;
  holdTimeUs: number;
  /** Smoothed utilization (0..>1); ≥1 means saturated. */
  utilization: number;
  /** Recent mean delay (wait + hold) each acquisition incurs, ms. */
  waitMs: number;
  acquisitions: number;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** One bucket of per-interval counters (the strip charts consume these). */
export interface MetricsBucket {
  /** Bucket start, sim time ms. */
  time: number;
  arrivals: number;
  successes: number;
  timeouts: number;
  /** Connections shed because TLS permits stayed occupied past the wait (RST). */
  shedTls: number;
  /** Connections shed because the connection limit was exceeded (RST). */
  shedConnLimit: number;
  /** Connections shed at TCP accept because the new-connection rate limit was exceeded (RST). */
  shedConnRate: number;
  errors: number;
  rejected: number;
  retries: number;
  tlsHandshakesStarted: number;
  /** Of those started, how many used session resumption. */
  tlsHandshakesResumed: number;
  tlsHandshakesCompleted: number;
  /** Latency samples (ms) of requests completed in this bucket. */
  latencies: number[];
  // Gauges sampled at bucket close:
  fabricConnections: number;
  fabricQueueDepth: number;
  cpuUtilization: number;
  handshakesActive: number;
  /** Utilization of the busiest enabled lock (0..>1), sampled at bucket close. */
  lockUtilization: number;
  /** Mean wait that lock contention added to operations this bucket (ms). */
  lockWaitMs: number;
}

export interface SimEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}
