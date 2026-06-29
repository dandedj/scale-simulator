/**
 * Shared types for the DNS load-distribution model: configuration, entity
 * state, the renderer-facing view snapshots, and the metrics bucket.
 *
 * All durations are virtual simulation milliseconds (real-world scale — a DNS
 * TTL is ~60_000ms, a server boot ~300_000ms). The shell dilates playback so
 * minutes compress to seconds; the model itself always thinks in real time.
 *
 * Unlike the connection-storm model (which simulates every request), this is a
 * fluid model: traffic is carried as piecewise-constant rates (requests/sec)
 * and only the events that change the rate field — TTL re-resolves, DNS updates,
 * health checks, server lifecycle, traffic ticks — are discrete. That keeps it
 * correct and cheap at fleet scale (many clients × many servers) under heavy
 * time compression.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type TrafficShape = 'steady' | 'ramp' | 'pulse';

export interface DnsClientConfig {
  /** Number of client cohorts (each a population sharing one resolved cache). */
  cohorts: number;
  /** Spread in per-cohort offered-load weights (0 = uniform, 1 = heavy skew). */
  heterogeneity: number;
  /**
   * Fraction of cohorts that effectively ignore TTL — connection-pinned or
   * JVM-pinned clients that hold a resolution for the whole run. They never
   * fail over off a dead IP via DNS, only via an RST re-pick within their
   * (now stale) cached set. The honest part of any "lower the TTL" story.
   */
  pinnedFraction: number;
  /**
   * Fraction of cohorts that are EKS clusters behind a shared CoreDNS cache —
   * all pods in the cluster share one cached answer and fail over together. The
   * cluster's effective TTL is min(zone TTL, CoreDNS cache) (CoreDNS honors the
   * record TTL, capped at its configured cache).
   */
  eksFraction: number;
  /** CoreDNS cache duration for EKS cohorts (ms) — the `cache N` in the Corefile. */
  coreDnsCacheMs: number;
  /**
   * When on, sustained shedding makes a cohort re-resolve DNS early, bypassing
   * its TTL (so it can pick up the fresh advertised set before expiry). Off by
   * default, so TTL governs recovery — the realistic, instructive case.
   */
  rstReResolve: boolean;
}

export interface DnsControlConfig {
  /** DNS record TTL: how long a cohort caches a resolution (ms). The lever. */
  ttlMs: number;
  /** Per-cohort jitter on the TTL (0..1) so caches don't expire in lockstep. */
  ttlJitter: number;
  /** How often RTB Fabric pushes the health-derived record set to Route53 (ms). */
  updateIntervalMs: number;
  /** Extra delay before a pushed record set takes effect (propagation, ms). */
  propagationMs: number;
}

/**
 * RTB Fabric health, evaluated by the publisher Lambda each run (the zone is a
 * private hosted zone, so Route53 does not health-check the servers — RTB
 * Fabric's Lambda monitors the fleet and manages the record set). Thresholds
 * count consecutive Lambda runs, so detection latency ≈ threshold × the Lambda
 * (DNS update) interval.
 */
export interface DnsHealthConfig {
  /** Consecutive Lambda runs a server is unhealthy before it is pulled from DNS. */
  unhealthyThreshold: number;
  /** Consecutive Lambda runs a server is healthy before it is added to DNS. */
  healthyThreshold: number;
  /**
   * Whether the Lambda marks an overloaded (RST-shedding) server unhealthy. Off
   * by default: a liveness check sees "accepting connections" and passes, so an
   * overwhelmed-but-up server stays advertised — which is exactly why the RST
   * loop exists. On models a load-aware check.
   */
  overloadFailsHealth: boolean;
}

export interface DnsServerConfig {
  /** Initial number of RTB Fabric servers. */
  count: number;
  /** Sustained request rate one server serves before shedding (req/s). */
  capacityPerSec: number;
  /** Per-server capacity jitter (0..1). */
  capacityJitter: number;
  /** Load fraction at which a server is "overloaded" and sheds (0.5..1). */
  shedThreshold: number;
  /** Time from launch to serving (ms) — provision + boot + app start. */
  bootMs: number;
  /** Per-server boot-time jitter (0..1). */
  bootJitter: number;
  /** After boot, capacity ramps linearly to full over this long (cold caches). */
  warmupMs: number;
  /** A gracefully removed server keeps serving cached traffic this long (ms). */
  drainMs: number;
  /** Maintain fleet size: replace a failed/killed server with a fresh boot. */
  autoReplace: boolean;
  /**
   * Whether an overloaded server sheds with RSTs so clients re-pick another IP
   * in their cached set (the fast loop). Off: the excess is simply dropped — no
   * re-pick — so a hot spot fails instead of redistributing. The central lever.
   */
  rstShedding: boolean;
}

export interface DnsScalingConfig {
  /** Whether reactive autoscaling launches servers under sustained overload. */
  autoScaleEnabled: boolean;
  /** Fleet utilization that triggers a scale-out (0.3..0.95). */
  targetUtilization: number;
  /** Servers launched per scale-out step. */
  scaleStep: number;
  /** Minimum time between scale-out steps (ms). */
  cooldownMs: number;
  /** Floor on fleet size (the baseline desired count). */
  minServers: number;
  /** Ceiling on fleet size. */
  maxServers: number;
}

export interface DnsTrafficConfig {
  shape: TrafficShape;
  /** Steady offered load, and the floor of a ramp (req/s). */
  baseRatePerSec: number;
  /** Ramp target / pulse peak (req/s). */
  peakRatePerSec: number;
  /** Ramp duration from base to peak (ms). */
  rampDurationMs: number;
}

export interface DnsSimulationConfig {
  seed: number;
  /** Availability SLO (0..1): the chart line and degraded banner threshold. */
  slaTarget: number;
  clients: DnsClientConfig;
  dns: DnsControlConfig;
  health: DnsHealthConfig;
  servers: DnsServerConfig;
  scaling: DnsScalingConfig;
  traffic: DnsTrafficConfig;
  /** Represented downstream only; does not influence the model. */
  bidders: { count: number };
}

export interface DnsPreset {
  id: string;
  name: string;
  /** What the audience should watch for. */
  description: string;
  config: DnsSimulationConfig;
}

// ---------------------------------------------------------------------------
// Entity state
// ---------------------------------------------------------------------------

/**
 * booting  — launched, warming, not serving and not advertised.
 * healthy  — serving; advertised once health checks pass.
 * draining — gracefully removed from DNS but still serving existing/cached
 *            traffic (low loss) until drain completes.
 * down     — failed/killed: capacity 0, a black hole for any cached traffic.
 */
export type ServerState = 'booting' | 'healthy' | 'draining' | 'down';

// ---------------------------------------------------------------------------
// Renderer-facing views (built per frame)
// ---------------------------------------------------------------------------

export interface DnsServerView {
  id: number;
  state: ServerState;
  overloaded: boolean;
  /** Effective capacity now (after the warm-up ramp), req/s. */
  capacity: number;
  /** Natural (pre-shed) demand reaching this server, req/s. */
  assignedRate: number;
  servedRate: number;
  /** RST-shed overflow, req/s. */
  shedRate: number;
  /** assignedRate / capacity. */
  load: number;
  inDnsRecordSet: boolean;
  healthCheckHealthy: boolean;
  /** 0..1 while booting. */
  bootProgress: number;
  /** Seconds until a booting server is serving (0 otherwise). */
  secondsUntilHealthy: number;
}

export interface DnsControlView {
  advertised: number[];
  advertisedCount: number;
  /** Total effective capacity of advertised servers, req/s. */
  advertisedCapacity: number;
  /** Servers the publisher Lambda currently believes healthy. */
  healthyKnownCount: number;
  totalServers: number;
  /**
   * True when RTB Fabric's Lambda is failing open — advertising every server
   * because none were found healthy, rather than publish an empty record set
   * that would black-hole the zone.
   */
  failOpen: boolean;
  msUntilUpdate: number;
  ttlMs: number;
  updateIntervalMs: number;
}

export interface DnsClientView {
  id: number;
  offeredRate: number;
  cachedSet: number[];
  /** Cached IPs that are currently down (dead) — the cohort is still aiming at them. */
  staleIds: number[];
  pinned: boolean;
  /** 'eks' = a cluster behind a shared CoreDNS cache; 'direct' = ordinary client. */
  kind: 'direct' | 'eks';
  /** Effective cache TTL this cohort resolves on (ms) — for the countdown label. */
  effectiveTtlMs: number;
  msUntilReResolve: number;
  /** Sim time of this cohort's last re-resolution (for the lookup flash). */
  lastResolvedAt: number;
  servedRate: number;
  shedRate: number;
  staleRate: number;
  unavailableRate: number;
}

export interface DnsFlowView {
  offeredRate: number;
  servedRate: number;
  shedRate: number;
  staleRate: number;
  unavailableRate: number;
  /** Per-server inbound bands (served portion shown separately). */
  inbound: { serverId: number; rate: number; served: number }[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** One bucket of integrated amounts (requests) + gauges sampled at close. */
export interface DnsMetricsBucket {
  /** Bucket start, sim time ms. */
  time: number;
  // Integrated amounts over the bucket (requests):
  offered: number;
  served: number;
  /** RST-shed overflow volume (re-picked within cache; a latency/cost signal). */
  shed: number;
  /** Requests aimed at down (dead/removed) IPs — the staleness signature. */
  staleHit: number;
  /** Unavailable because every reachable cached server was at capacity. */
  capacityShortfall: number;
  /** Unavailable because the cohort's whole cached set was dead. */
  staleUnavailable: number;
  /** Cohort re-resolutions in this bucket. */
  reResolves: number;
  // Gauges sampled at bucket close:
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
  /** Capacity the fleet is paying for (non-down servers), req/s — the cost axis. */
  provisionedCapacity: number;
}

export interface DnsSimEventLog {
  time: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}
