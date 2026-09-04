/** Configuration and renderer-facing types for the outbound pool model. */

export type PoolKeyStrategy = 'link-ip' | 'dns' | 'endpoint';
export type PoolOwnership = 'worker' | 'node';
export type HttpProtocol = 'http1' | 'http2';
export type PoolPolicy = 'hyper' | 'bounded';

export interface PoolTrafficConfig {
  /** Customer-bound requests across the whole RTB Fabric fleet. */
  requestsPerSec: number;
  /** Request/response occupancy on a connection, including network time. */
  responseTimeMs: number;
  /** Multiplier on mean concurrency for lumpy arrivals and response-time variance. */
  concurrencyHeadroom: number;
  /** Share of a failed request retried by the requester-facing path. */
  retryFraction: number;
  /** Caps retry amplification in the fluid feedback loop. */
  maxRetries: number;
}

export interface FabricPoolTopologyConfig {
  nodes: number;
  coresPerNode: number;
  /** Requester→responder Links carrying traffic to this customer. */
  links: number;
  /** Configured responder endpoint definitions referenced by each link. */
  endpointsPerLink: number;
  /** Exact endpoint identities (host/cert/port) common to every link. */
  sharedEndpointsPerLink: number;
  /** DNS addresses resolved by each configured link endpoint. */
  ipsPerEndpoint: number;
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
  /** Extra HTTP/1 connections produced by checkout-vs-connect races. */
  checkoutRaceFactor: number;
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

/** One requester→responder Link and the endpoint definitions it references. */
export interface PoolLinkView {
  id: number;
  name: string;
  endpointIds: number[];
  requestRate: number;
  /** Current-design link-local keys contributed by this Link per pool owner. */
  localKeysPerOwner: number;
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

export interface PoolSnapshot {
  baseRate: number;
  effectiveRate: number;
  servedRate: number;
  failedRate: number;
  desiredConnections: number;
  allowedConnections: number;
  established: number;
  busy: number;
  idle: number;
  pending: number;
  /** Link→endpoint references, including repeated shared endpoints. */
  linkEndpointBindings: number;
  /** De-duplicated host/certificate/port endpoint identities. */
  uniqueEndpoints: number;
  sharedEndpoints: number;
  logicalKeysPerOwner: number;
  poolOwners: number;
  poolKeys: number;
  keysLabel: string;
  streamsPerConnection: number;
  hottestResponder: number;
  responderPressure: number;
  responderCapacity: number;
  limitActive: boolean;
  capActive: boolean;
  reuseRatio: number;
  attemptsPerSec: number;
  resetsPerSec: number;
  closesPerSec: number;
  links: PoolLinkView[];
  endpoints: PoolEndpointView[];
}
