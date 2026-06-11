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
  /** Abort a request if no response within this time (ms). */
  requestTimeoutMs: number;
  /** Max time a request waits for a free pooled connection before failing (ms). */
  poolAcquireTimeoutMs: number;
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
   * bounded wait.
   */
  tlsPermitWaitMs: number;
  /** Nominal time to complete one full TLS handshake at idle (ms). */
  tlsHandshakeMs: number;
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

  /** Error pacing: delay error responses to damp client retry loops. */
  errorPacingEnabled: boolean;
  errorPacingDelayMs: number;
}

export interface DownstreamPoolConfig {
  /** Connections RTB Fabric holds per downstream. */
  poolSizePerDownstream: number;
  /** Fabric abandons a downstream call this long after routing it — the budget covers queue wait + wire time (ms). */
  requestTimeoutMs: number;
  /** Time to establish a fabric→downstream connection (ms). */
  connectMs: number;

  /** Circuit breaker on each downstream. */
  circuitBreakerEnabled: boolean;
  /** Open the breaker when failure ratio over the rolling window exceeds this. */
  breakerFailureRatio: number;
  /** Minimum samples in the window before the breaker may trip. */
  breakerMinSamples: number;
  /** How long the breaker stays open before probing (ms). */
  breakerCooldownMs: number;
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
  | 'returning'            // response traveling back to the client
  | 'pacedError';          // error response held by error pacing

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
}

export interface SimEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}
