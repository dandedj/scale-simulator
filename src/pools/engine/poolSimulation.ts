/**
 * Stochastic per-key model of RTB Fabric's customer-bound HTTP connection pools.
 *
 * The multiplicative ownership and key dimensions stay visible:
 *
 *   pool copies = nodes x (workers per node, or one node-shared owner)
 *   bindings    = links (every link has exactly one endpoint)
 *   unique eps  = distinct endpoint identities referenced by those links
 *   keys/owner  = links x IPs (current), unique endpoint authorities (DNS),
 *                 or unique endpoints x IPs (IP+cert+port sharing)
 *
 * Each pool key is an M/M/∞ queue: Poisson request arrivals (modulated by a
 * slow fleet-wide traffic wave), exponential connection occupancy, and a
 * hyper-util legacy pool in front of it. The pool checks idle sockets out LIFO,
 * so a key holds as many sockets as the highest concurrency it saw inside the
 * trailing idle window; that is where the idle timeout does its work. HTTP/1
 * starts one connect per request that finds no idle socket; HTTP/2 coalesces
 * establishment per key and multiplexes streams. Connects that mature on a
 * responder instance already at its limit reset, which fails the requests
 * waiting on them. A hypothetical bounded policy adds an active cap per key.
 *
 * The fleet can hold millions of keys, so the engine simulates a stratified
 * sample of them (spread across Links and responder IPs) and scales each
 * sampled key by the number of fleet keys it stands for. Randomness comes from
 * one seeded generator, so a scenario replays identically.
 */

import { Rng } from '../../engine/rng';
import { PoolMetricsCollector, type PoolStepTally } from './metrics';
import type {
  IdleRun,
  PoolAggregates,
  PoolEndpointView,
  PoolKeyStrategy,
  PoolLinkView,
  PoolResponderView,
  PoolSampledKeyView,
  PoolSimulationConfig,
  PoolSnapshot,
} from './types';

/** Keys simulated explicitly; the rest of the fleet is represented by weight. */
export const SAMPLE_BUDGET = 384;
/** Correlation time of the customer traffic wave that modulates every key. */
const BURST_TAU_MS = 4000;
/**
 * Share of one connect window's arrivals that an HTTP/1 pool has already
 * committed to new sockets by the time a traffic wave stops pinning it; used
 * only to start the fleet in a stationary state.
 */
const WARM_CASCADE_SHARE = 0.25;
/** Time constant for the displayed per-second rates. */
const RATE_SMOOTHING_MS = 300;
/** A disabled idle timeout warms up as if the window were this long. */
const WARM_WINDOW_CAP_MS = 600_000;
const EPS = 1e-7;

interface PendingBatch {
  readyAt: number;
  count: number;
}

interface KeyGroup {
  /** Endpoint the group belongs to; 0 for the single Link×IP group. */
  endpointId: number;
  /** Fleet keys in this group. */
  keys: number;
  /** Share of customer traffic that reaches this group. */
  rateFraction: number;
  first: number;
  count: number;
}

class SampledKey implements PoolSampledKeyView {
  endpointId: number;
  link: number;
  ip: number;
  weight: number;
  busy = 0;
  waiting = 0;
  busyConns = 0;
  conns = 0;
  pendingConns = 0;
  idle: IdleRun[] = [];
  pending: PendingBatch[] = [];
  meanConcurrency = 0;
  /** Monotonic deque of (time, needed connections) for the trailing-window demand peak. */
  demandT: number[] = [];
  demandV: number[] = [];

  constructor(endpointId: number, link: number, ip: number, weight: number) {
    this.endpointId = endpointId;
    this.link = link;
    this.ip = ip;
    this.weight = weight;
  }
}

/** Per-tick constants derived from the configuration. */
interface TickParams {
  dt: number;
  now1: number;
  streams: number;
  h2: boolean;
  pDepartHalf: number;
  idleTimeout: number;
  maxIdle: number;
  floor: number;
  cap: number;
  connectTime: number;
  limit: number;
  ipCount: number;
}

interface Tally {
  arrivals: number;
  served: number;
  failed: number;
  attempts: number;
  opened: number;
  resets: number;
  closed: number;
  established: number;
  busyConns: number;
  idleConns: number;
  pending: number;
  desired: number;
  allowed: number;
}

export class PoolSimulation {
  now = 0;
  cfg: PoolSimulationConfig;
  readonly metrics = new PoolMetricsCollector();

  private rng: Rng;
  private groups: KeyGroup[] = [];
  private keys: SampledKey[] = [];
  private ipConns = new Float64Array(0);
  private ipWeight = new Float64Array(0);
  private carry = 0;
  private retryRate = 0;
  private fleetBurst = 0;
  private fleetFactor = 1;
  private pulseFactor = 1;
  private pulseUntil = 0;
  private signature = '';
  private lastLimitActive = false;
  private lastCapActive = false;
  private agg: PoolAggregates;
  private smoothed = { served: 0, failed: 0, attempts: 0, opened: 0, resets: 0, closed: 0, arrivals: 0 };
  private cached: PoolSnapshot | null = null;

  constructor(cfg: PoolSimulationConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.signature = this.poolSignature();
    this.buildCohort();
    // Begin in the state a running fleet would already have: every sampled key
    // holds the sockets its recent traffic peaks would have left behind. This
    // avoids turning every scenario into a cold-start test; RECONNECT ALL
    // provides that.
    this.seedWarmState();
    this.agg = this.computeAggregates(this.tallyFromState(), 0);
    if (this.agg.limitActive) {
      this.metrics.log(0, 'critical', this.limitMessage());
      this.lastLimitActive = true;
    }
  }

  step(dtMs: number): void {
    if (dtMs <= 0) return;
    this.carry += dtMs;
    while (true) {
      const tick = this.tickMs();
      if (this.carry < tick - EPS) break;
      let seg = Math.min(tick, this.metrics.nextBoundary() - this.now);
      if (this.pulseUntil > 0) seg = Math.min(seg, this.pulseUntil - this.now);
      seg = Math.max(1, seg);
      this.advanceTick(seg);
      this.carry -= seg;
      this.metrics.advance(this.now, this.agg);
      if (this.pulseUntil > 0 && this.now >= this.pulseUntil - EPS) {
        this.pulseFactor = 1;
        this.pulseUntil = 0;
        this.metrics.log(this.now, 'info', 'Traffic surge ended; the sockets it opened are idle until they expire');
      }
    }
  }

  triggerPulse(factor: number, durationMs: number): void {
    this.pulseFactor = Math.max(1, factor);
    this.pulseUntil = this.now + Math.max(1, Math.round(durationMs));
    this.metrics.log(this.now, 'warn', `Traffic surge: ${this.pulseFactor.toFixed(1)}x for ${(durationMs / 1000).toFixed(0)}s`);
  }

  /** Close every client-side connection, as during a process/fleet recycle. */
  reconnectAll(): void {
    let closed = 0;
    let lost = 0;
    for (const k of this.keys) {
      closed += (k.conns + k.pendingConns) * k.weight;
      lost += (k.busy + k.waiting) * k.weight;
      k.conns = 0; k.busyConns = 0; k.pendingConns = 0; k.busy = 0; k.waiting = 0;
      k.idle.length = 0; k.pending.length = 0;
    }
    this.ipConns.fill(0);
    this.metrics.record(eventTally({ closed, failedRequests: lost }), this.agg);
    this.metrics.log(this.now, 'warn', `All pools recycled; ${fmtCount(closed)} sockets closed`);
    this.refreshAggregates();
  }

  /** Apply a live knob change. Re-keying cannot reuse old sockets. */
  applyConfig(): void {
    const nextSignature = this.poolSignature();
    if (nextSignature !== this.signature) {
      const closed = this.agg.established + this.agg.pending;
      this.signature = nextSignature;
      this.buildCohort();
      this.metrics.record(eventTally({ closed }), this.agg);
      this.metrics.log(this.now, 'info', `Pool topology changed; ${fmtCount(closed)} old sockets drained`);
    }
    this.refreshAggregates();
  }

  snapshot(): PoolSnapshot {
    if (!this.cached) this.cached = this.computeSnapshot();
    return this.cached;
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

  /** Sockets the pools would hold right now with no responder limit or active cap. */
  desiredConnectionCount(): number {
    return this.agg.desiredConnections;
  }

  /** Little's Law concurrency for configured customer throughput, before pool effects. */
  littleLawConnectionCount(rate = this.configuredRate()): number {
    return Math.max(0, rate) * (this.occupancyMs() / 1000) / this.streamsPerConnection();
  }

  responderCapacity(): number {
    const count = this.responderCount();
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    return (count * limit) / (1 + Math.max(0, this.cfg.responder.connectionSkew));
  }

  /** Sampled keys, for the board. */
  sampledKeys(): readonly PoolSampledKeyView[] {
    return this.keys;
  }

  /** The traffic surge in progress, if any. */
  surge(): { factor: number; remainingMs: number } | null {
    if (this.pulseUntil <= 0) return null;
    return { factor: this.pulseFactor, remainingMs: Math.max(0, this.pulseUntil - this.now) };
  }

  // -- Core tick ------------------------------------------------------------------

  private advanceTick(dt: number): void {
    const now1 = this.now + dt;
    const p = this.tickParams(dt, now1);
    this.refreshIpWeights();
    this.advanceFleetBurst(dt);
    const effectiveRate = this.baseRate() + this.retryRate;

    const t: Tally = {
      arrivals: 0, served: 0, failed: 0, attempts: 0, opened: 0, resets: 0, closed: 0,
      established: 0, busyConns: 0, idleConns: 0, pending: 0, desired: 0, allowed: 0,
    };
    const n = this.keys.length;
    // Rotate the visiting order so no sampled key is systematically first in line
    // for responder room.
    const start = Math.floor(this.rng.next() * n);
    for (let i = 0; i < n; i++) {
      const k = this.keys[(start + i) % n];
      const g = this.groups[this.groupIndexOf(k)];
      let rate = (effectiveRate * g.rateFraction) / g.keys;
      if (k.ip >= 0) rate *= this.ipWeight[k.ip];
      k.meanConcurrency = rate * (this.occupancyMs() / 1000);
      this.stepKey(k, rate, p, t);
    }

    this.now = now1;
    this.smoothRates(t, dt);
    this.advanceRetries(dt);
    this.agg = this.computeAggregates(t, dt);
    this.cached = null;
    this.metrics.record(this.stepTally(t, dt), this.agg);
    this.detectEdges();
  }

  private stepKey(k: SampledKey, rate: number, p: TickParams, t: Tally): void {
    const w = k.weight;
    const S = p.streams;
    let refusedRequests = 0;

    // Idle expiry, oldest first. The warm floor is kept alive by the application,
    // so expiry never cuts below it.
    if (p.idleTimeout > 0 && k.idle.length > 0) {
      let expired = 0;
      let drop = 0;
      const expirable = Math.max(0, k.conns - Math.max(p.floor, k.busyConns));
      while (drop < k.idle.length && expired < expirable) {
        const run = k.idle[drop];
        if (run.since + p.idleTimeout > p.now1 + EPS) break;
        const take = Math.min(run.count, expirable - expired);
        expired += take;
        if (take === run.count) drop++;
        else { run.count -= take; break; }
      }
      if (drop > 0) k.idle.splice(0, drop);
      if (expired > 0) {
        k.conns -= expired;
        this.ipAdd(k, -expired);
        t.closed += expired * w;
      }
    }

    // Departures: exponential occupancy, memoryless per tick. Half happen
    // before this tick's arrivals are placed and half after, so arrivals see a
    // pool state midway through the tick rather than one end of it.
    if (k.busy > 0) k.busy -= this.binomial(k.busy, p.pDepartHalf);

    // Connects that finished establishing. Each must find room on its responder
    // instance; a connect that lands on a full instance resets and fails the
    // requests that were waiting on it.
    while (k.pending.length > 0 && k.pending[0].readyAt <= p.now1 + EPS) {
      const batch = k.pending.shift()!;
      k.pendingConns -= batch.count;
      const granted = Math.max(0, Math.min(batch.count, this.roomFor(k, p)));
      const refused = batch.count - granted;
      if (granted > 0) {
        k.conns += granted;
        this.ipAdd(k, granted);
        this.pushIdle(k, granted, p.now1);
        t.opened += granted * w;
      }
      if (refused > 0) {
        t.resets += refused * w;
        const lost = Math.min(k.waiting, refused * S);
        k.waiting -= lost;
        refusedRequests += lost;
        t.failed += lost * w;
      }
    }

    // Requests waiting on a connect also race for any socket that frees up.
    let avail = k.conns * S - k.busy;
    if (k.waiting > 0 && avail > 0) {
      const take = Math.min(k.waiting, avail);
      k.waiting -= take;
      k.busy += take;
      avail -= take;
      t.served += take * w;
    }

    // Arrivals.
    const a = this.poisson((rate * p.dt) / 1000);
    if (a > 0) {
      t.arrivals += a * w;
      const take = Math.min(a, avail);
      k.busy += take;
      t.served += take * w;
      const r = a - take;
      if (r > 0) {
        // HTTP/1 opens one socket per request that found nothing idle; HTTP/2
        // keeps one establishment in flight per key and queues behind it.
        const want = p.h2 ? (k.pendingConns > 0 ? 0 : 1) : r;
        const capRoom = p.cap === Infinity ? Infinity : Math.max(0, p.cap - k.conns - k.pendingConns);
        const grant = Math.min(want, capRoom);
        if (p.h2) {
          if (grant > 0 || k.pendingConns > 0) k.waiting += r;
          else { refusedRequests += r; t.failed += r * w; }
        } else {
          k.waiting += grant;
          const dropped = r - grant;
          if (dropped > 0) { refusedRequests += dropped; t.failed += dropped * w; }
        }
        if (grant > 0) {
          k.pending.push({ readyAt: p.now1 + p.connectTime, count: grant });
          k.pendingConns += grant;
          t.attempts += grant * w;
        }
      }
    }

    if (k.busy > 0) k.busy -= this.binomial(k.busy, p.pDepartHalf);

    // Warm floor: the application re-opens sockets below its configured minimum.
    const floorGap = p.floor - k.conns - k.pendingConns;
    if (floorGap > 0) {
      k.pending.push({ readyAt: p.now1 + p.connectTime, count: floorGap });
      k.pendingConns += floorGap;
      t.attempts += floorGap * w;
    }

    // Reconcile busy sockets with the LIFO idle stack.
    const busyConns = Math.ceil(k.busy / S);
    if (busyConns > k.busyConns) this.popIdle(k, busyConns - k.busyConns);
    else if (busyConns < k.busyConns) this.pushIdle(k, k.busyConns - busyConns, p.now1);
    k.busyConns = busyConns;

    // pool_max_idle_per_host drops a returning socket once the idle list is full.
    let idleCount = k.conns - k.busyConns;
    if (idleCount > p.maxIdle) {
      const excess = idleCount - p.maxIdle;
      this.popIdle(k, excess);
      k.conns -= excess;
      idleCount -= excess;
      this.ipAdd(k, -excess);
      t.closed += excess * w;
    }

    // Trailing-window peak of what this key needed, limit or not.
    const demand = Math.ceil((k.busy + k.waiting + refusedRequests) / S);
    this.pushDemand(k, p.now1, demand, p.idleTimeout);
    const hwm = Math.max(p.floor, this.demandPeak(k));
    t.desired += hwm * w;
    t.allowed += (p.cap === Infinity ? hwm : Math.min(hwm, Math.max(p.floor, p.cap))) * w;

    t.established += k.conns * w;
    t.busyConns += k.busyConns * w;
    t.idleConns += idleCount * w;
    t.pending += k.pendingConns * w;
  }

  // -- Idle stack, demand deque, responder room -------------------------------------

  private pushIdle(k: SampledKey, count: number, now: number): void {
    const top = k.idle[k.idle.length - 1];
    if (top && top.since === now) top.count += count;
    else k.idle.push({ since: now, count });
  }

  private popIdle(k: SampledKey, count: number): void {
    let left = count;
    while (left > 0 && k.idle.length > 0) {
      const top = k.idle[k.idle.length - 1];
      if (top.count > left) { top.count -= left; left = 0; }
      else { left -= top.count; k.idle.pop(); }
    }
  }

  private pushDemand(k: SampledKey, now: number, value: number, window: number): void {
    const T = k.demandT;
    const V = k.demandV;
    while (V.length > 0 && V[V.length - 1] <= value) { V.pop(); T.pop(); }
    V.push(value);
    T.push(now);
    if (window > 0) {
      let drop = 0;
      while (drop < T.length && T[drop] + window <= now + EPS) drop++;
      if (drop > 0) { T.splice(0, drop); V.splice(0, drop); }
    }
  }

  private demandPeak(k: SampledKey): number {
    return k.demandV.length > 0 ? k.demandV[0] : 0;
  }

  /** Sampled connections this key may still open before its responder instance(s) are full. */
  private roomFor(k: SampledKey, p: TickParams): number {
    if (k.ip >= 0) return Math.floor((p.limit - this.ipConns[k.ip]) / k.weight + 1e-9);
    let room = Infinity;
    for (let i = 0; i < p.ipCount; i++) {
      const per = (k.weight * this.ipWeight[i]) / p.ipCount;
      if (per > 0) room = Math.min(room, Math.floor((p.limit - this.ipConns[i]) / per + 1e-9));
    }
    return room;
  }

  private ipAdd(k: SampledKey, count: number): void {
    if (k.ip >= 0) {
      this.ipConns[k.ip] += count * k.weight;
      return;
    }
    const n = this.ipConns.length;
    for (let i = 0; i < n; i++) this.ipConns[i] += (count * k.weight * this.ipWeight[i]) / n;
  }

  // -- Cohort construction and warm start -------------------------------------------

  private buildCohort(): void {
    const owners = this.poolOwners();
    const ips = this.responderCount();
    const links = this.linkCount();
    const endpoints = this.uniqueEndpointCount();
    const strategy = this.cfg.fabric.keyStrategy;
    this.groups = [];
    this.keys = [];
    this.ipConns = new Float64Array(ips);
    this.ipWeight = new Float64Array(ips);
    this.refreshIpWeights();

    if (strategy === 'link-ip') {
      this.groups.push({ endpointId: 0, keys: owners * links * ips, rateFraction: 1, first: 0, count: 0 });
    } else {
      for (let e = 1; e <= endpoints; e++) {
        const assigned = Math.floor(links / endpoints) + (e <= links % endpoints ? 1 : 0);
        const keysPerOwner = strategy === 'endpoint' ? ips : 1;
        this.groups.push({ endpointId: e, keys: owners * keysPerOwner, rateFraction: assigned / links, first: 0, count: 0 });
      }
    }
    const total = this.groups.reduce((sum, g) => sum + g.keys, 0);
    for (const g of this.groups) {
      const count = Math.max(1, Math.min(g.keys, Math.round((SAMPLE_BUDGET * g.keys) / total)));
      const weight = g.keys / count;
      g.first = this.keys.length;
      g.count = count;
      for (let t = 0; t < count; t++) {
        if (strategy === 'link-ip') {
          // Stride through IPs fastest and shift the Link each lap, so a small
          // sample still covers every Link and every IP evenly.
          const ip = t % ips;
          const link = (t + Math.floor(t / ips)) % links;
          this.keys.push(new SampledKey((link % endpoints) + 1, link, ip, weight));
        } else if (strategy === 'endpoint') {
          this.keys.push(new SampledKey(g.endpointId, -1, t % ips, weight));
        } else {
          this.keys.push(new SampledKey(g.endpointId, -1, -1, weight));
        }
      }
    }
  }

  /**
   * Put every sampled key in the state one idle window of steady traffic would
   * leave: its current concurrency, the peak it reached inside the window, and
   * idle ages spread the way LIFO checkout leaves them.
   */
  private seedWarmState(): void {
    const S = this.streamsPerConnection();
    const W = this.occupancyMs() / 1000;
    const windowMs = this.cfg.pool.idleTimeoutMs > 0 ? this.cfg.pool.idleTimeoutMs : WARM_WINDOW_CAP_MS;
    const T = windowMs / 1000;
    const floor = Math.max(0, Math.round(this.cfg.pool.minConnectionsPerKey));
    const cap = this.cfg.pool.policy === 'bounded' ? Math.max(1, Math.round(this.cfg.pool.maxConnectionsPerKey)) : Infinity;
    const maxIdle = this.cfg.pool.maxIdlePerKey > 0 ? Math.round(this.cfg.pool.maxIdlePerKey) : Infinity;
    const configured = this.configuredRate();
    const sigma = lognormalSigma(Math.max(0, this.cfg.traffic.burstiness));
    this.fleetBurst = this.rng.normal();
    // The highest point of the traffic wave inside the window, as the expected
    // maximum of the wave's independent looks.
    const looks = 1 + windowMs / BURST_TAU_MS;
    const zTop = expectedMaxNormal(looks);
    const waveTop = Math.exp(sigma * zTop - (sigma * sigma) / 2);
    const fleetFactor = Math.exp(sigma * this.fleetBurst - (sigma * sigma) / 2);
    const connectS = Math.max(1, this.cfg.pool.connectTimeMs) / 1000;
    const h1 = this.cfg.pool.protocol === 'http1';
    for (const k of this.keys) {
      const g = this.groups[this.groupIndexOf(k)];
      let rate = (configured * g.rateFraction) / g.keys;
      if (k.ip >= 0) rate *= this.ipWeight[k.ip];
      const m = rate * W;
      k.meanConcurrency = m;
      let peak = this.samplePeak(m, rate, T, sigma, zTop, this.rng.next());
      // An HTTP/1 pool pinned by a wave starts a connect for every arrival until
      // the sockets land, so the peak it keeps overshoots the concurrency peak.
      if (h1 && peak > 0) peak += this.poisson(WARM_CASCADE_SHARE * rate * waveTop * connectS);
      const busy = Math.min(peak, this.poisson(m * fleetFactor), cap === Infinity ? Infinity : cap * S);
      k.busy = busy;
      k.busyConns = Math.ceil(busy / S);
      const peakConns = Math.max(k.busyConns, Math.ceil(peak / S));
      let conns = Math.max(floor, peakConns);
      if (cap !== Infinity) conns = Math.max(k.busyConns, Math.min(conns, Math.max(floor, cap)));
      conns = Math.min(conns, k.busyConns + maxIdle);
      k.conns = conns;
      // Idle socket c was last used when concurrency last reached level c; that
      // age is roughly exponential in the up-crossing rate to c, older for higher c.
      const ages: number[] = [];
      let age = 0;
      for (let c = k.busyConns + 1; c <= Math.max(conns, peakConns); c++) {
        if (c <= peakConns) {
          const crossing = rate * poissonPmf(m, Math.max(0, c * S - 1));
          let sampled = crossing > 1e-12 ? (-Math.log(Math.max(1e-12, this.rng.next())) / crossing) * 1000 : Infinity;
          // A level the key would rarely reach is held only because the peak
          // sampler put its crossing inside the window; given that, the crossing
          // time is uniform over what remains of the window.
          if (sampled > windowMs * 0.98) sampled = age + this.rng.next() * (windowMs * 0.98 - age);
          age = Math.min(windowMs * 0.98, Math.max(age, sampled));
        }
        ages.push(age);
      }
      // Oldest socket at the bottom of the LIFO stack, freshest on top.
      for (let c = conns; c > k.busyConns; c--) this.pushIdle(k, 1, -ages[c - k.busyConns - 1]);
      // The demand peak decays level by level as each up-crossing leaves the window.
      for (let c = peakConns; c > k.busyConns; c--) this.pushDemand(k, -ages[c - k.busyConns - 1], c, 0);
      this.pushDemand(k, 0, k.busyConns, 0);
      this.ipAdd(k, conns);
    }
    this.trimToResponderLimit(floor);
  }

  /** Warm start cannot hold more sockets than the responder instances accept. */
  private trimToResponderLimit(floor: number): void {
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    for (let pass = 0; pass < 100_000; pass++) {
      let anyOver = false;
      for (let i = 0; i < this.ipConns.length; i++) if (this.ipConns[i] > limit + 1e-6) anyOver = true;
      if (!anyOver) return;
      let progress = false;
      for (const k of this.keys) {
        const over = k.ip >= 0 ? this.ipConns[k.ip] > limit + 1e-6 : anyOver;
        if (!over || k.conns <= 0) continue;
        if (k.idle.length > 0 && k.conns > Math.max(floor, k.busyConns)) {
          const oldest = k.idle[0];
          oldest.count -= 1;
          if (oldest.count <= 0) k.idle.shift();
        } else if (k.busyConns > 0) {
          k.busy = Math.max(0, k.busy - this.streamsPerConnection());
          k.busyConns = Math.ceil(k.busy / this.streamsPerConnection());
        } else continue;
        k.conns -= 1;
        this.ipAdd(k, -1);
        progress = true;
      }
      if (!progress) return;
    }
  }

  /**
   * Sample the peak concurrency a key reached inside a window of length T (s)
   * at mean rate λ (1/s) and mean concurrency m, with the rate modulated by a
   * log-normal wave of the given σ: P(peak ≤ j) ≈ E_F[P(N ≤ j)] · exp(−T · E_F[λF p_F(j)]),
   * the stationary law times the chance of no up-crossing out of level j,
   * averaged over the wave with Gauss–Hermite quadrature. The wave is clipped
   * at zTop, the highest point it is expected to reach inside the window.
   */
  private samplePeak(m: number, rate: number, T: number, sigma: number, zTop: number, u: number): number {
    if (m <= 0 || rate <= 0) return 0;
    const nodes = sigma > 0 ? GH_NODES : [0];
    const weights = sigma > 0 ? GH_WEIGHTS : [1];
    const factors = nodes.map((z) => Math.exp(sigma * Math.min(z, zTop) - (sigma * sigma) / 2));
    const means = factors.map((f) => m * f);
    const mMax = Math.max(...means);
    const mMin = Math.min(...means);
    const exact = mMin <= 200;
    const from = exact ? 0 : Math.max(0, Math.floor(mMin - 8 * Math.sqrt(mMin)));
    const span = mMax + 12 * Math.sqrt(mMax) + 40;
    const pmf = means.map((mi) => (mi <= 200 ? Math.exp(-mi) : 0));
    const cdf = means.map((mi) => (mi <= 200 ? 0 : normalCdf((from - 0.5 - mi) / Math.sqrt(mi))));
    for (let j = from; j < from + span; j++) {
      let cdfMix = 0;
      let crossing = 0;
      for (let i = 0; i < means.length; i++) {
        const mi = means[i];
        let pj: number;
        if (mi <= 200) {
          pj = pmf[i];
          pmf[i] = pj * (mi / (j + 1));
        } else {
          const z = (j - mi) / Math.sqrt(mi);
          pj = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI * mi);
        }
        cdf[i] += pj;
        cdfMix += weights[i] * cdf[i];
        crossing += weights[i] * rate * factors[i] * pj;
      }
      if (cdfMix * Math.exp(-T * crossing) >= u) return j;
    }
    return Math.ceil(from + span);
  }

  // -- Aggregates, snapshot, rates ---------------------------------------------------

  private tickParams(dt: number, now1: number): TickParams {
    const p = this.cfg.pool;
    return {
      dt,
      now1,
      streams: this.streamsPerConnection(),
      h2: p.protocol === 'http2',
      pDepartHalf: 1 - Math.exp(-dt / (2 * this.occupancyMs())),
      idleTimeout: Math.max(0, p.idleTimeoutMs),
      maxIdle: p.maxIdlePerKey > 0 ? Math.round(p.maxIdlePerKey) : Infinity,
      floor: Math.max(0, Math.round(p.minConnectionsPerKey)),
      cap: p.policy === 'bounded' ? Math.max(1, Math.round(p.maxConnectionsPerKey)) : Infinity,
      connectTime: Math.max(1, p.connectTimeMs),
      limit: Math.max(1, this.cfg.responder.connectionLimit),
      ipCount: this.ipConns.length,
    };
  }

  private tickMs(): number {
    const W = this.occupancyMs();
    if (W >= 100) return 50;
    if (W >= 50) return 25;
    if (W >= 40) return 20;
    return 10;
  }

  private refreshIpWeights(): void {
    const n = this.ipWeight.length;
    const skew = Math.max(0, this.cfg.responder.connectionSkew);
    for (let i = 0; i < n; i++) this.ipWeight[i] = n <= 1 ? 1 : 1 + skew * (1 - (2 * i) / (n - 1));
  }

  private advanceFleetBurst(dt: number): void {
    const sigma = lognormalSigma(Math.max(0, this.cfg.traffic.burstiness));
    if (sigma <= 0) { this.fleetFactor = 1; return; }
    const rho = Math.exp(-dt / BURST_TAU_MS);
    this.fleetBurst = this.fleetBurst * rho + Math.sqrt(1 - rho * rho) * this.rng.normal();
    this.fleetFactor = Math.exp(sigma * this.fleetBurst - (sigma * sigma) / 2);
  }

  private smoothRates(t: Tally, dt: number): void {
    const a = 1 - Math.exp(-dt / RATE_SMOOTHING_MS);
    const s = this.smoothed;
    const perSec = 1000 / dt;
    s.arrivals += (t.arrivals * perSec - s.arrivals) * a;
    s.served += (t.served * perSec - s.served) * a;
    s.failed += (t.failed * perSec - s.failed) * a;
    s.attempts += (t.attempts * perSec - s.attempts) * a;
    s.opened += (t.opened * perSec - s.opened) * a;
    s.resets += (t.resets * perSec - s.resets) * a;
    s.closed += (t.closed * perSec - s.closed) * a;
  }

  /** Failed requests come back as retry traffic, smoothed and capped. */
  private advanceRetries(dt: number): void {
    const target = Math.min(
      this.configuredRate() * this.pulseFactor * Math.max(0, this.cfg.traffic.maxRetries),
      this.smoothed.failed * Math.max(0, Math.min(1, this.cfg.traffic.retryFraction)),
    );
    const smoothing = Math.min(1, dt / Math.max(50, this.cfg.pool.connectTimeMs));
    this.retryRate += (target - this.retryRate) * smoothing;
  }

  private computeAggregates(t: Tally, dt: number): PoolAggregates {
    const baseRate = this.baseRate();
    const effectiveRate = baseRate + this.retryRate;
    const s = this.smoothed;
    let hottest = 0;
    for (let i = 0; i < this.ipConns.length; i++) hottest = Math.max(hottest, this.ipConns[i]);
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    const pressure = hottest / limit;
    const littleLawRequired = this.littleLawConnectionCount();
    const resetsNow = dt > 0 ? t.resets > EPS : false;
    return {
      baseRate,
      effectiveRate,
      arrivalRate: s.arrivals,
      servedRate: s.served,
      failedRate: s.failed,
      littleLawRequired,
      connectionAmplification: littleLawRequired > EPS ? t.established / littleLawRequired : 0,
      desiredConnections: t.desired,
      allowedConnections: t.allowed,
      established: t.established,
      busy: t.busyConns,
      idle: t.idleConns,
      pending: t.pending,
      poolKeys: this.poolKeyCount(),
      hottestResponder: hottest,
      responderPressure: pressure,
      responderCapacity: this.responderCapacity(),
      limitActive: pressure >= 0.999 || resetsNow || s.resets > 0.5,
      capActive: t.allowed + EPS < t.desired,
      reuseRatio: s.arrivals > EPS ? Math.max(0, 1 - s.opened / s.arrivals) : 1,
      attemptsPerSec: s.attempts,
      opensPerSec: s.opened,
      resetsPerSec: s.resets,
      closesPerSec: s.closed,
    };
  }

  /** Gauges from the current key state, for events outside a tick. */
  private tallyFromState(): Tally {
    const t: Tally = {
      arrivals: 0, served: 0, failed: 0, attempts: 0, opened: 0, resets: 0, closed: 0,
      established: 0, busyConns: 0, idleConns: 0, pending: 0, desired: 0, allowed: 0,
    };
    const floor = Math.max(0, Math.round(this.cfg.pool.minConnectionsPerKey));
    const cap = this.cfg.pool.policy === 'bounded' ? Math.max(1, Math.round(this.cfg.pool.maxConnectionsPerKey)) : Infinity;
    for (const k of this.keys) {
      const hwm = Math.max(floor, this.demandPeak(k));
      t.established += k.conns * k.weight;
      t.busyConns += k.busyConns * k.weight;
      t.idleConns += (k.conns - k.busyConns) * k.weight;
      t.pending += k.pendingConns * k.weight;
      t.desired += hwm * k.weight;
      t.allowed += (cap === Infinity ? hwm : Math.min(hwm, Math.max(floor, cap))) * k.weight;
    }
    return t;
  }

  private refreshAggregates(): void {
    this.agg = this.computeAggregates(this.tallyFromState(), 0);
    this.cached = null;
    this.detectEdges();
  }

  private stepTally(t: Tally, dt: number): PoolStepTally {
    return {
      dtMs: dt,
      baseRequests: (this.baseRate() * dt) / 1000,
      effectiveRequests: t.arrivals,
      servedRequests: t.served,
      failedRequests: t.failed,
      attempts: t.attempts,
      opened: t.opened,
      resets: t.resets,
      closed: t.closed,
    };
  }

  private computeSnapshot(): PoolSnapshot {
    const a = this.agg;
    const topology = this.topologyViews(a.effectiveRate);
    return {
      ...a,
      linkEndpointBindings: this.linkEndpointBindingCount(),
      uniqueEndpoints: this.uniqueEndpointCount(),
      sharedEndpoints: this.sharedEndpointCount(),
      logicalKeysPerOwner: this.logicalKeysPerOwner(),
      poolOwners: this.poolOwners(),
      keysLabel: keyStrategyLabel(this.cfg.fabric.keyStrategy),
      streamsPerConnection: this.streamsPerConnection(),
      sampledKeys: this.keys.length,
      links: topology.links,
      endpoints: topology.endpoints,
      responders: this.responderViews(),
      sampled: this.keys,
    };
  }

  private topologyViews(rate: number): { links: PoolLinkView[]; endpoints: PoolEndpointView[] } {
    const linkCount = this.linkCount();
    const endpointCount = this.uniqueEndpointCount();
    const responderIps = Array.from({ length: this.responderCount() }, (_, i) => responderIp(i + 1));
    const ipsPerEndpoint = responderIps.length;
    const endpoints: PoolEndpointView[] = [];
    const endpointById = new Map<number, PoolEndpointView>();

    for (let id = 1; id <= endpointCount; id++) {
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
    }
    const links: PoolLinkView[] = [];
    for (let linkId = 1; linkId <= linkCount; linkId++) {
      const endpointId = ((linkId - 1) % endpointCount) + 1;
      const requestRate = rate / linkCount;
      links.push({ id: linkId, name: `Link ${linkId}`, endpointId, requestRate });
      const endpoint = endpointById.get(endpointId)!;
      endpoint.linkIds.push(linkId);
      endpoint.requestRate += requestRate;
    }
    for (const endpoint of endpoints) {
      endpoint.shared = endpoint.linkIds.length > 1;
      endpoint.keysPerOwner = this.cfg.fabric.keyStrategy === 'link-ip'
        ? endpoint.linkIds.length * ipsPerEndpoint
        : this.cfg.fabric.keyStrategy === 'endpoint'
          ? ipsPerEndpoint
          : 1;
    }
    for (const k of this.keys) {
      const endpoint = endpointById.get(k.endpointId);
      if (endpoint) endpoint.estimatedConnections += k.conns * k.weight;
    }
    return { links, endpoints };
  }

  private responderViews(): PoolResponderView[] {
    const limit = Math.max(1, this.cfg.responder.connectionLimit);
    return Array.from({ length: this.ipConns.length }, (_, index) => ({
      id: index + 1,
      name: `Responder ${index + 1}`,
      ip: responderIp(index + 1),
      estimatedConnections: this.ipConns[index],
      pressure: this.ipConns[index] / limit,
    }));
  }

  private groupIndexOf(k: SampledKey): number {
    if (this.groups.length === 1) return 0;
    return k.endpointId - 1;
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

  private detectEdges(): void {
    const a = this.agg;
    if (a.limitActive && !this.lastLimitActive) this.metrics.log(this.now, 'critical', this.limitMessage());
    if (!a.limitActive && this.lastLimitActive) this.metrics.log(this.now, 'info', 'Responder connection pressure fell below the configured limit');
    if (a.capActive && !this.lastCapActive) {
      this.metrics.log(this.now, 'warn', `Per-key active cap is binding at ${fmtCount(a.allowedConnections)} connections`);
    }
    if (!a.capActive && this.lastCapActive) this.metrics.log(this.now, 'info', 'Per-key active cap is no longer binding');
    this.lastLimitActive = a.limitActive;
    this.lastCapActive = a.capActive;
  }

  private limitMessage(): string {
    return `Responder limit reached: hottest instance ${fmtCount(this.cfg.responder.connectionLimit)} / ${fmtCount(this.cfg.responder.connectionLimit)}`;
  }

  // -- Small helpers ----------------------------------------------------------------

  private streamsPerConnection(): number {
    return this.cfg.pool.protocol === 'http2' ? Math.max(1, this.cfg.pool.h2StreamsPerConnection) : 1;
  }

  private occupancyMs(): number {
    return Math.max(0.1, this.cfg.traffic.responseTimeMs);
  }

  private configuredRate(): number {
    return Math.max(0, this.cfg.traffic.requestsPerSec) * this.pulseFactor;
  }

  private baseRate(): number {
    return this.configuredRate() * this.fleetFactor;
  }

  private linkCount(): number {
    return Math.max(1, Math.round(this.cfg.fabric.links));
  }

  private responderCount(): number {
    return Math.max(1, Math.round(this.cfg.responder.instances));
  }

  private poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean < 12) {
      const L = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.rng.next();
      } while (p > L);
      return k - 1;
    }
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.rng.normal()));
  }

  private binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (n <= 16) {
      let k = 0;
      for (let i = 0; i < n; i++) if (this.rng.next() < p) k++;
      return k;
    }
    const np = n * p;
    if (np < 10) return Math.min(n, this.poisson(np));
    const nq = n * (1 - p);
    if (nq < 10) return n - Math.min(n, this.poisson(nq));
    return Math.min(n, Math.max(0, Math.round(np + Math.sqrt(np * (1 - p)) * this.rng.normal())));
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

/** A metrics entry for connection events that happen between ticks. */
function eventTally(extra: Partial<PoolStepTally>): PoolStepTally {
  return {
    dtMs: 0, baseRequests: 0, effectiveRequests: 0, servedRequests: 0, failedRequests: 0,
    attempts: 0, opened: 0, resets: 0, closed: 0, ...extra,
  };
}

/** Probabilists' Gauss–Hermite nodes and weights (7 points) for E over N(0,1). */
const GH_NODES = [-3.750439717725742, -2.366759410734541, -1.154405394739968, 0, 1.154405394739968, 2.366759410734541, 3.750439717725742];
const GH_WEIGHTS = [0.0005482688559722185, 0.03075712202474613, 0.2401232307999788, 0.4571428571428571, 0.2401232307999788, 0.03075712202474613, 0.0005482688559722185];

/** Expected maximum of n independent standard normals (Gumbel asymptotics, n ≥ 1). */
function expectedMaxNormal(n: number): number {
  if (n <= 1) return 0;
  const a = Math.sqrt(2 * Math.log(n));
  return a - (Math.log(Math.log(n)) + Math.log(4 * Math.PI)) / (2 * a) + 0.5772 / a;
}

/** σ of a log-normal factor with mean 1 and the given coefficient of variation. */
function lognormalSigma(cv: number): number {
  return cv > 0 ? Math.sqrt(Math.log(1 + cv * cv)) : 0;
}

function poissonPmf(m: number, j: number): number {
  if (j < 0) return 0;
  if (m > 60) {
    const z = (j - m) / Math.sqrt(m);
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI * m);
  }
  // log-space to survive large j
  let logP = -m + j * Math.log(m);
  for (let i = 2; i <= j; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function normalCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26 via erf; ample for a warm start.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function fmtCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}
