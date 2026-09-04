/**
 * Fluid/discrete hybrid for RTB Fabric's customer-bound HTTP connection pools.
 *
 * Requests are fluid rates; connection opens, closes, and resets are aggregate
 * discrete batches. The model deliberately keeps the multiplicative ownership
 * and key dimensions visible:
 *
 *   pool copies = nodes x (workers per node, or one node-shared owner)
 *   bindings    = links (every link has exactly one endpoint)
 *   unique eps  = distinct endpoint identities referenced by those links
 *   keys/owner  = links x IPs (current), unique endpoint authorities (DNS),
 *                 or unique endpoints x IPs (IP+cert+port sharing)
 *
 * The Hyper legacy client is modeled as an on-demand pool with idle expiry and
 * a max-idle setting, but no active cap. A bounded policy is included as a
 * hypothetical alternative. HTTP/1 opens are independent; HTTP/2 shares one
 * connection and coalesces connection establishment per key.
 */

import { PoolMetricsCollector } from './metrics';
import type {
  PoolEndpointView,
  PoolKeyStrategy,
  PoolLinkView,
  PoolResponderView,
  PoolSimulationConfig,
  PoolSnapshot,
} from './types';

const INTERNAL_TICK_MS = 50;
const EPS = 1e-7;

interface PendingBatch {
  readyAt: number;
  count: number;
}

export class PoolSimulation {
  now = 0;
  cfg: PoolSimulationConfig;
  readonly metrics = new PoolMetricsCollector();

  private established = 0;
  private pending: PendingBatch[] = [];
  private retryRate = 0;
  private pulseFactor = 1;
  private pulseUntil = 0;
  private idleSince = 0;
  private signature = '';
  private lastLimitActive = false;
  private lastCapActive = false;
  private lastSnapshot!: PoolSnapshot;
  private lastDeltas = { attempts: 0, opened: 0, resets: 0, closed: 0 };

  constructor(cfg: PoolSimulationConfig) {
    this.cfg = cfg;
    this.signature = this.poolSignature();
    // Begin in the equilibrium a running fleet would already have. This avoids
    // turning every scenario into a cold-start test; RECONNECT ALL provides it.
    const initial = this.connectionTarget(this.baseRate());
    this.established = Math.min(initial.allowed, this.responderCapacity());
    this.idleSince = 0;
    this.lastSnapshot = this.computeSnapshot();
    if (this.lastSnapshot.limitActive) {
      this.metrics.log(0, 'critical', this.limitMessage());
      this.lastLimitActive = true;
    }
  }

  step(dtMs: number): void {
    if (dtMs <= 0) return;
    const target = this.now + dtMs;
    while (this.now < target - EPS) {
      const next = Math.min(target, this.now + INTERNAL_TICK_MS, this.metrics.nextBoundary(), this.pulseUntil || Infinity);
      const seg = Math.max(0, next - this.now);
      if (seg > 0) {
        this.advanceSegment(seg);
        this.metrics.accumulate(seg, this.lastSnapshot);
        this.now = next;
        this.metrics.advance(this.now, this.lastSnapshot);
      }
      if (this.pulseUntil > 0 && this.now >= this.pulseUntil - EPS) {
        this.pulseFactor = 1;
        this.pulseUntil = 0;
        this.metrics.log(this.now, 'info', 'Traffic surge ended; excess sockets are now idle');
      }
    }
  }

  triggerPulse(factor: number, durationMs: number): void {
    this.pulseFactor = Math.max(1, factor);
    this.pulseUntil = this.now + Math.max(1, durationMs);
    this.idleSince = this.now;
    this.metrics.log(this.now, 'warn', `Traffic surge: ${this.pulseFactor.toFixed(1)}x for ${(durationMs / 1000).toFixed(0)}s`);
  }

  /** Close every client-side connection, as during a process/fleet recycle. */
  reconnectAll(): void {
    const closed = this.established + this.pending.reduce((n, b) => n + b.count, 0);
    this.established = 0;
    this.pending = [];
    this.idleSince = this.now;
    this.metrics.connections({ attempts: 0, opened: 0, resets: 0, closed });
    this.metrics.log(this.now, 'warn', `All pools recycled; ${fmtCount(closed)} sockets closed`);
    this.lastSnapshot = this.computeSnapshot();
  }

  /** Apply a live knob change. Re-keying cannot reuse old sockets. */
  applyConfig(): void {
    const nextSignature = this.poolSignature();
    if (nextSignature !== this.signature) {
      const closed = this.established;
      this.established = 0;
      this.pending = [];
      this.signature = nextSignature;
      this.metrics.connections({ attempts: 0, opened: 0, resets: 0, closed });
      this.metrics.log(this.now, 'info', `Pool topology changed; ${fmtCount(closed)} old sockets drained`);
    }
    this.lastSnapshot = this.computeSnapshot();
  }

  snapshot(): PoolSnapshot {
    return this.lastSnapshot;
  }

  /** Number of independently owned keys, the primary cardinality multiplier. */
  poolKeyCount(): number {
    return this.poolOwners() * this.logicalKeysPerOwner();
  }

  poolOwners(): number {
    const perNode = this.cfg.fabric.ownership === 'worker' ? this.cfg.fabric.coresPerNode : 1;
    return Math.max(1, Math.round(this.cfg.fabric.nodes)) * Math.max(1, Math.round(perNode));
  }

  logicalKeysPerOwner(): number {
    const ips = this.responderCount();
    switch (this.cfg.fabric.keyStrategy) {
      case 'link-ip':
        return this.linkCount() * ips;
      case 'dns':
        return this.uniqueEndpointCount();
      case 'endpoint':
        return this.uniqueEndpointCount() * ips;
    }
  }

  /** Every Link→endpoint reference, before identical endpoints are de-duplicated. */
  linkEndpointBindingCount(): number {
    return this.linkCount();
  }

  /** Exact host/certificate/port identities referenced by the Links. */
  uniqueEndpointCount(): number {
    return Math.min(this.linkCount(), Math.max(1, Math.round(this.cfg.fabric.uniqueEndpoints)));
  }

  sharedEndpointCount(): number {
    const links = this.linkCount();
    const endpoints = this.uniqueEndpointCount();
    return Math.min(endpoints, links - endpoints);
  }

  /** Analytical desired count before responder or alternative-library limits. */
  desiredConnectionCount(rate = this.effectiveRate()): number {
    return this.connectionTarget(rate).desired;
  }

  responderCapacity(): number {
    const count = this.responderCount();
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    return (count * limit) / (1 + Math.max(0, this.cfg.responder.connectionSkew));
  }

  private advanceSegment(dtMs: number): void {
    const matured = this.maturePending(this.now + dtMs);
    let opened = 0;
    let resets = 0;
    if (matured > 0) {
      const room = Math.max(0, this.responderCapacity() - this.established);
      opened = Math.min(room, matured);
      resets = Math.max(0, matured - opened);
      this.established += opened;
    }

    const rate = this.effectiveRate();
    const target = this.connectionTarget(rate);
    let closed = 0;

    // maxIdlePerKey is an idle limit, not an active limit. It can trim only the
    // portion above currently needed work.
    const busyNeed = this.busyConnectionCount(rate);
    if (this.cfg.pool.maxIdlePerKey > 0) {
      const idleCeiling = this.cfg.pool.maxIdlePerKey * this.poolKeyCount();
      const keep = Math.max(busyNeed, Math.min(this.established, busyNeed + idleCeiling));
      if (keep < this.established) {
        closed += this.established - keep;
        this.established = keep;
      }
    }

    if (target.allowed + EPS < this.established) {
      if (this.idleSince <= 0) this.idleSince = this.now;
      const timeout = this.cfg.pool.idleTimeoutMs;
      if (timeout > 0 && this.now + dtMs - this.idleSince >= timeout) {
        closed += this.established - target.allowed;
        this.established = target.allowed;
        this.idleSince = this.now + dtMs;
      }
    } else {
      this.idleSince = this.now + dtMs;
    }

    const pendingNow = this.pending.reduce((n, b) => n + b.count, 0);
    const missing = Math.max(0, target.allowed - this.established - pendingNow);
    let attempts = 0;
    if (missing > EPS) {
      // Hyper H1 can finish a connection in the background after an idle
      // checkout wins the race. H2's one-in-progress guard removes this term.
      const race = this.cfg.pool.protocol === 'http1' ? Math.max(1, this.cfg.pool.checkoutRaceFactor) : 1;
      attempts = missing * race;
      if (this.cfg.pool.policy === 'bounded') {
        const absoluteCap = this.poolKeyCount() * Math.max(1, this.cfg.pool.maxConnectionsPerKey);
        attempts = Math.min(attempts, Math.max(0, absoluteCap - this.established - pendingNow));
      }
      if (attempts > EPS) {
        this.pending.push({ readyAt: this.now + dtMs + Math.max(1, this.cfg.pool.connectTimeMs), count: attempts });
      }
    }

    this.lastDeltas = { attempts, opened, resets, closed };
    this.metrics.connections(this.lastDeltas);

    // Missing pool-key coverage and responder resets turn into failed requests;
    // a configurable share comes back as retry traffic, capped by maxRetries.
    const interim = this.computeSnapshot();
    const retryTarget = Math.min(
      this.baseRate() * Math.max(0, this.cfg.traffic.maxRetries),
      interim.failedRate * Math.max(0, Math.min(1, this.cfg.traffic.retryFraction)),
    );
    const smoothing = Math.min(1, dtMs / Math.max(50, this.cfg.pool.connectTimeMs));
    this.retryRate += (retryTarget - this.retryRate) * smoothing;
    this.lastSnapshot = this.computeSnapshot();
    this.detectEdges();
  }

  private computeSnapshot(): PoolSnapshot {
    const baseRate = this.baseRate();
    const effectiveRate = baseRate + this.retryRate;
    const target = this.connectionTarget(effectiveRate);
    const coverage = target.desired > EPS ? Math.min(1, this.established / target.desired) : 1;
    const servedRate = effectiveRate * coverage;
    const busy = Math.min(this.established, this.busyConnectionCount(servedRate));
    const pending = this.pending.reduce((n, b) => n + b.count, 0);
    const hottest = (this.established / this.responderCount()) *
      (1 + Math.max(0, this.cfg.responder.connectionSkew));
    const pressure = hottest / Math.max(1, this.cfg.responder.connectionLimit);
    const opensRate = this.lastDeltas.opened * (1000 / INTERNAL_TICK_MS);
    const reuse = effectiveRate > EPS ? Math.max(0, 1 - opensRate / effectiveRate) : 1;
    const topology = this.topologyViews(effectiveRate, this.established);
    const responders = this.responderViews(this.established);
    return {
      baseRate,
      effectiveRate,
      servedRate,
      failedRate: Math.max(0, effectiveRate - servedRate),
      desiredConnections: target.desired,
      allowedConnections: target.allowed,
      established: this.established,
      busy,
      idle: Math.max(0, this.established - busy),
      pending,
      linkEndpointBindings: this.linkEndpointBindingCount(),
      uniqueEndpoints: this.uniqueEndpointCount(),
      sharedEndpoints: this.sharedEndpointCount(),
      logicalKeysPerOwner: this.logicalKeysPerOwner(),
      poolOwners: this.poolOwners(),
      poolKeys: this.poolKeyCount(),
      keysLabel: keyStrategyLabel(this.cfg.fabric.keyStrategy),
      streamsPerConnection: this.streamsPerConnection(),
      hottestResponder: hottest,
      responderPressure: pressure,
      responderCapacity: this.responderCapacity(),
      limitActive: pressure >= 0.999 || this.lastDeltas.resets > EPS,
      capActive: target.allowed + EPS < target.desired,
      reuseRatio: reuse,
      attemptsPerSec: this.lastDeltas.attempts * (1000 / INTERNAL_TICK_MS),
      resetsPerSec: this.lastDeltas.resets * (1000 / INTERNAL_TICK_MS),
      closesPerSec: this.lastDeltas.closed * (1000 / INTERNAL_TICK_MS),
      links: topology.links,
      endpoints: topology.endpoints,
      responders,
    };
  }

  private connectionTarget(rate: number): { desired: number; allowed: number } {
    const links = this.linkCount();
    const ipsPerEndpoint = this.responderCount();
    if (this.cfg.fabric.keyStrategy === 'link-ip') {
      // Every Link has one endpoint and carries an equal traffic share. Shared
      // endpoint identity is deliberately irrelevant to the current key.
      return this.keyGroupTarget(rate, links * ipsPerEndpoint);
    }

    // Shared strategies combine the traffic of all Links assigned to the same
    // exact endpoint identity. Endpoint membership can be uneven when the Link
    // count is not divisible by the endpoint count, which matters when rounding
    // or an active cap binds.
    const endpoints = this.uniqueEndpointCount();
    const keysPerEndpoint = this.cfg.fabric.keyStrategy === 'endpoint'
      ? ipsPerEndpoint
      : 1;
    let desired = 0;
    let allowed = 0;
    for (let endpointId = 1; endpointId <= endpoints; endpointId++) {
      const assignedLinks = Math.floor(links / endpoints) + (endpointId <= links % endpoints ? 1 : 0);
      const target = this.keyGroupTarget(Math.max(0, rate) * (assignedLinks / links), keysPerEndpoint);
      desired += target.desired;
      allowed += target.allowed;
    }
    return { desired, allowed };
  }

  private keyGroupTarget(rate: number, logicalKeysPerOwner: number): { desired: number; allowed: number } {
    if (logicalKeysPerOwner <= 0) return { desired: 0, allowed: 0 };
    const keys = this.poolOwners() * logicalKeysPerOwner;
    const perKeyRate = Math.max(0, rate) / keys;
    const timeoutSeconds = this.cfg.pool.idleTimeoutMs <= 0 ? 1e6 : this.cfg.pool.idleTimeoutMs / 1000;
    // Probability that this key has been touched inside its idle-retention
    // window. It prevents a theoretical key from contributing a full socket
    // when traffic is too sparse ever to warm all keys.
    const touched = 1 - Math.exp(-perKeyRate * timeoutSeconds);
    const meanConcurrency =
      perKeyRate * (Math.max(0.1, this.cfg.traffic.responseTimeMs) / 1000) *
      Math.max(1, this.cfg.traffic.concurrencyHeadroom) / this.streamsPerConnection();
    const trafficConnectionsPerKey = touched * Math.max(1, Math.ceil(meanConcurrency));
    const floorPerKey = Math.max(0, this.cfg.pool.minConnectionsPerKey);
    const desired = keys * Math.max(floorPerKey, trafficConnectionsPerKey);
    const allowedPerKey = this.cfg.pool.policy === 'bounded'
      ? Math.min(Math.max(floorPerKey, trafficConnectionsPerKey), Math.max(1, this.cfg.pool.maxConnectionsPerKey))
      : Math.max(floorPerKey, trafficConnectionsPerKey);
    return { desired, allowed: keys * allowedPerKey };
  }

  private busyConnectionCount(rate: number): number {
    const raw = Math.max(0, rate) * (Math.max(0.1, this.cfg.traffic.responseTimeMs) / 1000) *
      Math.max(1, this.cfg.traffic.concurrencyHeadroom) / this.streamsPerConnection();
    return Math.min(this.poolKeyCount() * 1e6, raw);
  }

  private streamsPerConnection(): number {
    return this.cfg.pool.protocol === 'http2' ? Math.max(1, this.cfg.pool.h2StreamsPerConnection) : 1;
  }

  private baseRate(): number {
    return Math.max(0, this.cfg.traffic.requestsPerSec) * this.pulseFactor;
  }

  private effectiveRate(): number {
    return this.baseRate() + this.retryRate;
  }

  private maturePending(at: number): number {
    let matured = 0;
    const waiting: PendingBatch[] = [];
    for (const batch of this.pending) {
      if (batch.readyAt <= at + EPS) matured += batch.count;
      else waiting.push(batch);
    }
    this.pending = waiting;
    return matured;
  }

  private poolSignature(): string {
    const f = this.cfg.fabric;
    const p = this.cfg.pool;
    return [
      f.nodes,
      f.coresPerNode,
      f.links,
      f.uniqueEndpoints,
      f.ownership,
      f.keyStrategy,
      p.protocol,
      this.responderCount(),
    ].join('|');
  }

  private topologyViews(rate: number, established: number): { links: PoolLinkView[]; endpoints: PoolEndpointView[] } {
    const linkCount = this.linkCount();
    const endpointCount = this.uniqueEndpointCount();
    const responderIps = Array.from({ length: this.responderCount() }, (_, i) => responderIp(i + 1));
    const ipsPerEndpoint = responderIps.length;
    const endpoints: PoolEndpointView[] = [];
    const endpointById = new Map<number, PoolEndpointView>();

    const makeEndpoint = (id: number): PoolEndpointView => {
      const endpoint: PoolEndpointView = {
        id,
        name: `Endpoint ${id}`,
        authority: `endpoint-${id}.bidder.example:443`,
        certificate: `customer-${id}`,
        port: 443,
        // Every configured endpoint targets this customer responder fleet, so
        // it resolves to the explicit IP owned by every responder instance.
        ips: [...responderIps],
        linkIds: [],
        shared: false,
        requestRate: 0,
        keysPerOwner: 0,
        estimatedConnections: 0,
      };
      endpoints.push(endpoint);
      endpointById.set(id, endpoint);
      return endpoint;
    };

    for (let id = 1; id <= endpointCount; id++) makeEndpoint(id);
    const links: PoolLinkView[] = [];
    for (let linkId = 1; linkId <= linkCount; linkId++) {
      const endpointId = ((linkId - 1) % endpointCount) + 1;
      const requestRate = rate / linkCount;
      const link: PoolLinkView = {
        id: linkId,
        name: `Link ${linkId}`,
        endpointId,
        requestRate,
      };
      links.push(link);
      const endpoint = endpointById.get(endpointId)!;
      endpoint.linkIds.push(linkId);
      endpoint.requestRate += requestRate;
    }

    const endpointTargets: Array<{ endpoint: PoolEndpointView; allowed: number }> = [];
    for (const endpoint of endpoints) {
      endpoint.shared = endpoint.linkIds.length > 1;
      endpoint.keysPerOwner = this.cfg.fabric.keyStrategy === 'link-ip'
        ? endpoint.linkIds.length * ipsPerEndpoint
        : this.cfg.fabric.keyStrategy === 'endpoint'
          ? ipsPerEndpoint
          : 1;
      endpointTargets.push({
        endpoint,
        allowed: this.keyGroupTarget(endpoint.requestRate, endpoint.keysPerOwner).allowed,
      });
    }
    const totalAllowed = endpointTargets.reduce((sum, target) => sum + target.allowed, 0);
    for (const target of endpointTargets) {
      target.endpoint.estimatedConnections = totalAllowed > EPS
        ? established * (target.allowed / totalAllowed)
        : 0;
    }
    return { links, endpoints };
  }

  private linkCount(): number {
    return Math.max(1, Math.round(this.cfg.fabric.links));
  }

  private responderCount(): number {
    return Math.max(1, Math.round(this.cfg.responder.instances));
  }

  private responderViews(established: number): PoolResponderView[] {
    const count = this.responderCount();
    const skew = Math.max(0, this.cfg.responder.connectionSkew);
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    return Array.from({ length: count }, (_, index) => {
      const uneven = count <= 1 ? 1 : 1 + skew * (1 - (2 * index) / (count - 1));
      const estimatedConnections = (established / count) * uneven;
      return {
        id: index + 1,
        name: `Responder ${index + 1}`,
        ip: responderIp(index + 1),
        estimatedConnections,
        pressure: estimatedConnections / limit,
      };
    });
  }

  private detectEdges(): void {
    const s = this.lastSnapshot;
    if (s.limitActive && !this.lastLimitActive) this.metrics.log(this.now, 'critical', this.limitMessage());
    if (!s.limitActive && this.lastLimitActive) this.metrics.log(this.now, 'info', 'Responder connection pressure fell below the configured limit');
    if (s.capActive && !this.lastCapActive) {
      this.metrics.log(this.now, 'warn', `Per-key active cap is binding at ${fmtCount(s.allowedConnections)} connections`);
    }
    if (!s.capActive && this.lastCapActive) this.metrics.log(this.now, 'info', 'Per-key active cap is no longer binding');
    this.lastLimitActive = s.limitActive;
    this.lastCapActive = s.capActive;
  }

  private limitMessage(): string {
    return `Responder limit reached: hottest instance ${fmtCount(this.cfg.responder.connectionLimit)} / ${fmtCount(this.cfg.responder.connectionLimit)}`;
  }
}

export function keyStrategyLabel(strategy: PoolKeyStrategy): string {
  switch (strategy) {
    case 'link-ip': return 'Link x endpoint x IP';
    case 'dns': return 'endpoint DNS authority';
    case 'endpoint': return 'IP + cert + port';
  }
}

function responderIp(responderId: number): string {
  const index = responderId - 1;
  const third = Math.floor(index / 254);
  const fourth = (index % 254) + 1;
  return `172.20.${third}.${fourth}`;
}

function fmtCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}
