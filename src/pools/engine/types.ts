/** Configuration and renderer-facing types for the outbound pool model. */

export type PoolKeyStrategy = 'link-ip' | 'dns' | 'endpoint';
export type PoolOwnership = 'worker' | 'node';
export type HttpProtocol = 'http1' | 'http2';
export type PoolPolicy = 'hyper' | 'bounded';

export interface PoolTrafficConfig {
  /** Customer-bound requests across the whole RTB Fabric fleet. */
  requestsPerSec: number;
  /** Mean request/response occupancy on a connection, including network time. */
  responseTimeMs: number;
  /**
   * Coefficient of variation of the short-term request rate around its mean.
   * Zero is a pure Poisson stream; larger values make arrivals lumpier.
   */
  burstiness: number;
  /** Share of a failed request retried by the requester-facing path. */
  retryFraction: number;
  /** Caps retry amplification in the feedback loop. */
  maxRetries: number;
}

export interface FabricPoolTopologyConfig {
  nodes: number;
  coresPerNode: number;
  /** Requester→responder Links carrying traffic to this customer. */
  links: number;
  /** Distinct endpoint identities distributed across the Links. */
  uniqueEndpoints: number;
  /** Current worker-process ownership, or a hypothetical node-shared client. */
  ownership: PoolOwnership;
  /** Application-level partitioning layered above hyper-util's own pool key. */
  keyStrategy: PoolKeyStrategy;
}

export interface HyperPoolConfig {
  protocol: HttpProtocol;
  /** Concurrent streams carried by one HTTP/2 connection; HTTP/1 always uses 1. */
  h2StreamsPerConnection: number;
  /** hyper-util pool_idle_timeout. Zero disables idle expiry. */
  idleTimeoutMs: number;
  /** hyper-util pool_max_idle_per_host. Zero means usize::MAX / unbounded here. */
  maxIdlePerKey: number;
  /** RTB Fabric's warm-connection floor (not a hyper-util legacy setting). */
  minConnectionsPerKey: number;
  /** TCP + TLS establishment time. */
  connectTimeMs: number;
  /** Native hyper behavior or a hypothetical library with an active cap. */
  policy: PoolPolicy;
  /** Only used by the bounded policy; cap is per pool key, not global. */
  maxConnectionsPerKey: number;
}

export interface ResponderConfig {
  instances: number;
  /** Concurrent connection limit on each Envoy/responder instance. */
  connectionLimit: number;
  /** Uneven connection placement: 0 is even, 0.5 makes the hottest 50% above mean. */
  connectionSkew: number;
}

export interface PoolSimulationConfig {
  seed: number;
  traffic: PoolTrafficConfig;
  fabric: FabricPoolTopologyConfig;
  pool: HyperPoolConfig;
  responder: ResponderConfig;
}

export interface PoolPreset {
  id: string;
  name: string;
  description: string;
  config: PoolSimulationConfig;
}

export interface PoolMetricsBucket {
  time: number;
  baseRequests: number;
  effectiveRequests: number;
  servedRequests: number;
  failedRequests: number;
  connectionAttempts: number;
  connectionsOpened: number;
  connectionResets: number;
  connectionsClosed: number;
  baseRate: number;
  effectiveRate: number;
  servedRate: number;
  established: number;
  busy: number;
  idle: number;
  pending: number;
  desired: number;
  littleLawRequired: number;
  connectionAmplification: number;
  poolKeys: number;
  hottestResponder: number;
  responderPressure: number;
  reuseRatio: number;
}

export interface PoolEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}

/** One requester→responder Link and its single configured endpoint. */
export interface PoolLinkView {
  id: number;
  name: string;
  /** A Link always points to exactly one endpoint. */
  endpointId: number;
  requestRate: number;
}

/** A unique host/certificate/port identity referenced by one or more Links. */
export interface PoolEndpointView {
  id: number;
  name: string;
  authority: string;
  certificate: string;
  port: number;
  ips: string[];
  linkIds: number[];
  shared: boolean;
  requestRate: number;
  /** Keys this endpoint contributes per owner under the selected strategy. */
  keysPerOwner: number;
  estimatedConnections: number;
}

/** One customer Envoy/bidder instance and its destination IP. */
export interface PoolResponderView {
  id: number;
  name: string;
  ip: string;
  estimatedConnections: number;
  pressure: number;
}

/** A run of idle sockets that were returned to a pool at the same instant. */
export interface IdleRun {
  /** Sim time the sockets went idle. */
  since: number;
  count: number;
}

/**
 * One simulated pool key. The engine simulates a stratified sample of keys
 * and scales each by `weight` to stand for the fleet.
 */
export interface PoolSampledKeyView {
  endpointId: number;
  /** Link index this key belongs to, or -1 when the key is shared across Links. */
  link: number;
  /** Responder IP index this key targets, or -1 when the key spans every IP. */
  ip: number;
  /** Fleet keys this sample stands for. */
  weight: number;
  /** Requests currently in service on this key. */
  busy: number;
  /** Requests waiting for a connection still being established. */
  waiting: number;
  busyConns: number;
  /** Established sockets: busy + idle. */
  conns: number;
  pendingConns: number;
  /** Idle sockets in LIFO order: the last run is the most recently returned. */
  idle: readonly IdleRun[];
  /** Mean concurrency this key sees, in requests. */
  meanConcurrency: number;
}

/** Fleet-level numbers, recomputed every internal tick. */
export interface PoolAggregates {
  /** Offered customer rate right now, including surge and burst wobble. */
  baseRate: number;
  /** Offered rate plus smoothed retry traffic. */
  effectiveRate: number;
  /** Measured arrivals per second, smoothed like the served and failed rates. */
  arrivalRate: number;
  servedRate: number;
  failedRate: number;
  /** Theoretical connection-equivalent concurrency for configured customer throughput: λW / streams. */
  littleLawRequired: number;
  /** Established connections divided by the Little's Law requirement. */
  connectionAmplification: number;
  /** Sockets the pools would hold with no responder limit or active cap. */
  desiredConnections: number;
  allowedConnections: number;
  established: number;
  busy: number;
  idle: number;
  pending: number;
  poolKeys: number;
  hottestResponder: number;
  responderPressure: number;
  responderCapacity: number;
  limitActive: boolean;
  capActive: boolean;
  reuseRatio: number;
  attemptsPerSec: number;
  opensPerSec: number;
  resetsPerSec: number;
  closesPerSec: number;
}

export interface PoolSnapshot extends PoolAggregates {
  /** Link→endpoint references, including repeated shared endpoints. */
  linkEndpointBindings: number;
  /** De-duplicated host/certificate/port endpoint identities. */
  uniqueEndpoints: number;
  sharedEndpoints: number;
  logicalKeysPerOwner: number;
  poolOwners: number;
  keysLabel: string;
  streamsPerConnection: number;
  /** How many keys are simulated explicitly; the rest are represented by weight. */
  sampledKeys: number;
  links: PoolLinkView[];
  endpoints: PoolEndpointView[];
  responders: PoolResponderView[];
  sampled: readonly PoolSampledKeyView[];
}
