/**
 * The DNS load-distribution simulation.
 *
 * RTB Fabric advertises a Route53 record set of healthy server IPs. Clients
 * resolve it, cache the answer for the TTL, and spread load across the IPs they
 * got. Two control loops at very different timescales decide where traffic
 * lands — and getting that separation right is the whole point:
 *
 *   FAST (ms–~1s): an overloaded server sheds with RSTs; the client immediately
 *   reconnects to ANOTHER IP already in its cached set. This smooths hot spots,
 *   but only within the capacity that is both advertised AND cached right now.
 *
 *   SLOW (minutes): health detection (check interval × consecutive-fail
 *   threshold) + the DNS publish interval + per-client TTL expiry + server boot.
 *   This is the only loop that grows the healthy-and-cached capacity.
 *
 * So TTL is a failover lever (how fast clients leave a dead IP), not a scale-out
 * lever (how fast new capacity absorbs a surge). The model carries traffic as
 * piecewise-constant rates and solves the fast loop to a fixed point inside each
 * rebalance; the slow loop is the explicit discrete-event dynamics.
 */

import { EventQueue, type ScheduledEvent } from '../../engine/eventQueue';
import { Rng } from '../../engine/rng';
import { type DnsGauges, DnsMetricsCollector, type DnsRates } from './metrics';
import type {
  DnsClientView,
  DnsControlView,
  DnsFlowView,
  DnsServerView,
  DnsSimulationConfig,
  ServerState,
} from './types';

/** Periodic rebalance/ramp/warm-up tick (ms). Bounds the rate field's staleness. */
const TICK_MS = 1000;
/** Water-filling iterations for the fast (RST re-pick) loop. */
const WATERFILL_ITERS = 8;
const EPS = 1e-6;
/** TTL multiplier for connection-/JVM-pinned cohorts — effectively never re-resolve. */
const PINNED_TTL_MULT = 1e6;
/** A down server's tile lingers this long past TTL so the board stays bounded. */
const DOWN_CLEANUP_PAD_MS = 5000;

let nextServerId = 1;
let nextCohortId = 1;

class FabricServer {
  id = nextServerId++;
  state: ServerState = 'booting';
  /** Nominal capacity (req/s) once fully warmed. */
  fullCapacity: number;
  /** Boot duration for this server (ms). */
  bootMs: number;
  bornAt = 0;
  /** Sim time it became healthy (for the warm-up ramp); negative = pre-warmed. */
  healthyAt = -1;
  consecFails = 0;
  consecPasses = 0;
  healthCheckHealthy = false;
  inDnsRecordSet = false;
  /** This server is a replacement for a failed one (cost/accounting flavor). */
  isReplacement = false;
  // Runtime, refreshed each rebalance:
  assignedRate = 0;
  servedRate = 0;
  shedRate = 0;
  overloaded = false;

  constructor(fullCapacity: number, bootMs: number) {
    this.fullCapacity = fullCapacity;
    this.bootMs = bootMs;
  }
}

class ClientCohort {
  id = nextCohortId++;
  /** Share of total offered load. */
  weight: number;
  /** Connection-/JVM-pinned: ignores TTL for the run. */
  pinned: boolean;
  /** 'eks' = a cluster behind a shared CoreDNS cache; 'direct' = ordinary client. */
  kind: 'direct' | 'eks';
  /** TTL multiplier (1 normally, huge if pinned). */
  ttlMult: number;
  cachedSet: number[] = [];
  reResolveEvent: ScheduledEvent | null = null;
  /** Sim time of the last re-resolution (drives the lookup flash); negative = never. */
  lastResolvedAt = -1e9;
  // Runtime, refreshed each rebalance:
  offeredRate = 0;
  servedRate = 0;
  staleRate = 0;
  unavailRate = 0;

  constructor(weight: number, pinned: boolean, kind: 'direct' | 'eks') {
    this.weight = weight;
    this.pinned = pinned;
    this.kind = kind;
    this.ttlMult = pinned ? PINNED_TTL_MULT : 1;
  }
}

export class DnsSimulation {
  now = 0;
  readonly rng: Rng;
  readonly queue = new EventQueue();
  readonly metrics = new DnsMetricsCollector();
  cfg: DnsSimulationConfig;

  servers: FabricServer[] = [];
  cohorts: ClientCohort[] = [];
  /** The live Route53 record set clients resolve against. */
  advertised: number[] = [];
  /** RTB Fabric's Lambda is failing open — advertising all servers (none healthy). */
  failOpen = false;

  // Traffic pulse (manual surge multiplier).
  pulseFactor = 1;
  pulseUntil = 0;
  private pulseEndEvent: ScheduledEvent | null = null;

  /** The current piecewise-constant rate field (req/s). */
  private rates: DnsRates = {
    offered: 0,
    served: 0,
    shed: 0,
    staleHit: 0,
    capacityShortfall: 0,
    staleUnavailable: 0,
    provisioned: 0,
  };
  /** Fleet demand ÷ serving capacity (for autoscale + banners). */
  private fleetUtil = 0;
  private desiredCount: number;
  private lastScaleAt = -Infinity;

  // Condition edge-detection / log throttling.
  private degradedWas = false;
  private lastLogAt: Record<string, number> = {};

  constructor(cfg: DnsSimulationConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.desiredCount = cfg.servers.count;

    // Pre-warmed steady state: the fleet is up and fully warmed at t0.
    for (let i = 0; i < cfg.servers.count; i++) {
      const s = new FabricServer(this.jitterCapacity(), this.jitterBoot());
      s.state = 'healthy';
      s.healthyAt = -cfg.servers.warmupMs; // already past the ramp → full capacity
      s.healthCheckHealthy = true;
      this.servers.push(s);
    }
    // Clients already resolved and connected at t0.
    for (let i = 0; i < cfg.clients.cohorts; i++) this.cohorts.push(this.makeCohort());
    this.applyAdvertised(this.healthyCandidates(), false);
    for (const c of this.cohorts) {
      c.cachedSet = this.pickRecords();
      // Stagger first expiry across [0, effective TTL] so caches never expire in lockstep.
      const ttl = this.effectiveTtlMs(c);
      const offset = this.rng.next() * Math.min(ttl, cfg.dns.ttlMs);
      c.reResolveEvent = this.queue.schedule(this.now + Math.max(100, offset), () => this.resolveCohort(c));
    }

    this.scheduleTick();
    this.scheduleLambda();
    this.rebalance();
  }

  // -- Time --------------------------------------------------------------------

  /** Advance the simulation by dt virtual milliseconds. */
  step(dtMs: number): void {
    if (dtMs <= 0) return;
    const target = this.now + dtMs;
    let guard = 0;
    while (this.now < target - 1e-9 && guard++ < 1_000_000) {
      const next = Math.min(target, this.queue.peekTime(), this.metrics.nextBoundary());
      const seg = next - this.now;
      if (seg > 0) {
        // Rate field is constant over [now, next): integrate analytically.
        this.metrics.accumulate(seg, this.rates);
        this.now = next;
        this.metrics.advance(this.now, this.gauges());
      }
      let fired = false;
      let ev: ScheduledEvent | null;
      while ((ev = this.queue.popDue(this.now)) !== null) {
        ev.fire();
        fired = true;
      }
      if (fired) this.rebalance();
    }
    this.detectConditions();
  }

  /**
   * Multiply offered load by `factor` for `durationMs` of sim time. The end is a
   * scheduled event (an exact sim-time boundary) so the pulse window — and thus
   * availability — is identical no matter how coarsely step() advances.
   */
  triggerPulse(factor: number, durationMs: number): void {
    this.pulseFactor = factor;
    this.pulseUntil = this.now + durationMs;
    if (this.pulseEndEvent) this.pulseEndEvent.active = false;
    this.pulseEndEvent = this.queue.schedule(this.pulseUntil, () => {
      this.pulseFactor = 1;
      this.pulseEndEvent = null;
      this.metrics.log(this.now, 'info', 'Traffic pulse ended');
      // The rebalance after this event batch (in step) refreshes the rate field.
    });
    this.metrics.log(this.now, 'warn', `Traffic pulse: ${factor}× for ${(durationMs / 1000).toFixed(0)}s`);
    this.rebalance();
  }

  /** Live rate-shape change (traffic knobs): the next rebalance reads cfg. */
  applyTraffic(): void {
    this.rebalance();
  }

  /** Live structural change: reconcile cohort and baseline server counts. */
  applyStructure(): void {
    this.desiredCount = this.cfg.servers.count;
    // Cohorts.
    while (this.cohorts.length < this.cfg.clients.cohorts) {
      const c = this.makeCohort();
      c.cachedSet = this.pickRecords();
      const offset = this.rng.next() * this.effectiveTtlMs(c);
      c.reResolveEvent = this.queue.schedule(this.now + Math.max(100, offset), () => this.resolveCohort(c));
      this.cohorts.push(c);
    }
    while (this.cohorts.length > this.cfg.clients.cohorts) {
      const c = this.cohorts.pop();
      if (c?.reResolveEvent) c.reResolveEvent.active = false;
    }
    // Baseline fleet size: spawn booting servers up, drain extras down.
    let live = this.liveCount();
    while (live < this.cfg.servers.count) {
      this.spawnServer(false);
      live++;
    }
    while (live > this.cfg.servers.count) {
      const victim = this.servers.find((s) => s.state === 'healthy') ?? this.servers.find((s) => s.state === 'booting');
      if (!victim) break;
      this.removeServer(victim, true);
      live--;
    }
    this.rebalance();
  }

  // -- Manual actions (UI) -----------------------------------------------------

  /** Kill a healthy server: hard (black hole) or graceful (drain then down). */
  killServer(graceful: boolean): void {
    const healthy = this.servers.filter((s) => s.state === 'healthy');
    if (healthy.length === 0) return;
    const victim = healthy[Math.floor(this.rng.next() * healthy.length)];
    this.removeServer(victim, graceful);
  }

  /** Manually launch n servers (they boot in). */
  addServers(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.liveCount() >= this.cfg.scaling.maxServers) break;
      this.spawnServer(false);
    }
    this.metrics.log(this.now, 'info', `Manual scale-out: launching ${n} server(s)`);
    this.rebalance();
  }

  // -- The fast loop: water-filling fixed point --------------------------------

  /**
   * Recompute the rate field. Each cohort spreads its offered load over the IPs
   * it cached; traffic to down IPs is a stale hit that re-picks (RST) onto the
   * cohort's reachable cached servers; servers fill to capacity and shed the
   * rest, which re-picks again — solved to a fixed point by water-filling.
   */
  private rebalance(): void {
    const total = this.totalOffered();
    const sumW = this.cohorts.reduce((a, c) => a + c.weight, 0) || 1;
    const n = this.servers.length;
    const idx = new Map<number, number>();
    this.servers.forEach((s, i) => idx.set(s.id, i));

    const cap = this.servers.map((s) => this.effectiveCapacity(s));
    const remaining = cap.slice();
    const natural = new Array(n).fill(0); // pre-shed even-split demand per server
    const served = new Array(n).fill(0);

    const reachOf: number[][] = [];
    const demand: number[] = [];
    let staleHit = 0;
    let staleUnavail = 0;

    for (const c of this.cohorts) {
      c.offeredRate = total * (c.weight / sumW);
      c.servedRate = 0;
      c.staleRate = 0;
      c.unavailRate = 0;
      const cs = c.cachedSet;
      const reach: number[] = [];
      for (const id of cs) {
        const i = idx.get(id);
        if (i !== undefined && this.serves(this.servers[i])) reach.push(i);
      }
      reachOf.push(reach);
      if (cs.length > 0) {
        const dead = (cs.length - reach.length) / cs.length;
        const sh = c.offeredRate * dead;
        c.staleRate = sh;
        staleHit += sh;
      }
      if (reach.length === 0) {
        c.unavailRate = c.offeredRate;
        staleUnavail += c.offeredRate;
        demand.push(0);
        continue;
      }
      demand.push(c.offeredRate);
      // Natural even split (the dead portion re-picks evenly onto the reachable).
      const share = c.offeredRate / reach.length;
      for (const i of reach) natural[i] += share;
    }

    // Iterative water-fill: place demand onto reachable cached servers with
    // headroom; overflow (RST) re-picks among the cohort's other cached servers.
    // With RST shedding off the fast loop is disabled: a single pass places the
    // even split, and whatever hit an over-capacity server is lost (no re-pick).
    const iters = this.cfg.servers.rstShedding ? WATERFILL_ITERS : 1;
    for (let iter = 0; iter < iters; iter++) {
      const incoming = new Array(n).fill(0);
      const plans: { k: number; active: number[]; share: number }[] = [];
      let any = false;
      for (let k = 0; k < this.cohorts.length; k++) {
        if (demand[k] <= EPS) continue;
        const active = reachOf[k].filter((i) => remaining[i] > EPS);
        if (active.length === 0) continue;
        any = true;
        const share = demand[k] / active.length;
        for (const i of active) incoming[i] += share;
        plans.push({ k, active, share });
      }
      if (!any) break;
      const ratio = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const take = Math.min(incoming[i], remaining[i]);
        served[i] += take;
        remaining[i] -= take;
        ratio[i] = incoming[i] > EPS ? take / incoming[i] : 0;
      }
      for (const p of plans) {
        let got = 0;
        for (const i of p.active) got += p.share * ratio[i];
        demand[p.k] -= got;
        this.cohorts[p.k].servedRate += got;
      }
    }

    let capShort = 0;
    for (let k = 0; k < this.cohorts.length; k++) {
      if (demand[k] > EPS) {
        this.cohorts[k].unavailRate += demand[k];
        capShort += demand[k];
      }
    }

    // Per-server runtime from the natural (pre-shed) demand — the overload/RST
    // signal the tiles and shed chart show.
    let shed = 0;
    let totalServed = 0;
    let loadSum = 0;
    let loadMax = 0;
    let serving = 0;
    let servingCap = 0;
    for (let i = 0; i < n; i++) {
      const s = this.servers[i];
      s.assignedRate = natural[i];
      s.servedRate = served[i];
      const over = Math.max(0, natural[i] - cap[i]);
      s.shedRate = over;
      s.overloaded = cap[i] > 0 && natural[i] >= this.cfg.servers.shedThreshold * cap[i];
      shed += over;
      totalServed += served[i];
      if (this.serves(s)) {
        serving++;
        servingCap += cap[i];
        const load = cap[i] > 0 ? natural[i] / cap[i] : 0;
        loadSum += load;
        loadMax = Math.max(loadMax, load);
      }
    }
    this.fleetUtil = servingCap > EPS ? total / servingCap : (total > 0 ? Infinity : 0);
    this.meanLoad = serving > 0 ? loadSum / serving : 0;
    this.maxLoad = loadMax;

    this.rates = {
      offered: total,
      served: totalServed,
      shed,
      staleHit,
      capacityShortfall: capShort,
      staleUnavailable: staleUnavail,
      provisioned: this.provisionedCapacity(),
    };
  }

  private meanLoad = 0;
  private maxLoad = 0;

  // -- The slow loop: the RTB Fabric publisher Lambda --------------------------

  /**
   * RTB Fabric runs a Lambda every updateIntervalMs (the private hosted zone is
   * managed by RTB Fabric, not health-checked by Route53). Each run evaluates
   * server health (with hysteresis, counted in runs) and publishes the healthy
   * IPs to Route53. This is the slow control loop — minutes — that the fast RST
   * loop covers for.
   */
  private scheduleLambda(): void {
    this.queue.schedule(this.now + this.cfg.dns.updateIntervalMs, () => {
      this.runLambda();
      this.scheduleLambda();
    });
  }

  private runLambda(): void {
    const h = this.cfg.health;
    for (const s of this.servers) {
      if (this.liveFail(s)) {
        s.consecPasses = 0;
        s.consecFails++;
        if (s.consecFails >= h.unhealthyThreshold) s.healthCheckHealthy = false;
      } else {
        s.consecFails = 0;
        s.consecPasses++;
        if (s.consecPasses >= h.healthyThreshold) s.healthCheckHealthy = true;
      }
    }
    this.pushDnsUpdate();
  }

  /** A server fails the Lambda's check for anything not cleanly serving; overload only counts if configured. */
  private liveFail(s: FabricServer): boolean {
    if (s.state !== 'healthy') return true;
    if (this.cfg.health.overloadFailsHealth && s.overloaded) return true;
    return false;
  }

  /** Publish the healthy record set (with propagation lag); fail open if none. */
  private pushDnsUpdate(): void {
    const candidates = this.healthyCandidates();
    const ids = candidates.length ? candidates : this.allServerIds();
    const failOpen = candidates.length === 0;
    if (this.cfg.dns.propagationMs > 0) {
      this.queue.schedule(this.now + this.cfg.dns.propagationMs, () => this.applyAdvertised(ids, failOpen));
    } else {
      this.applyAdvertised(ids, failOpen);
    }
  }

  private healthyCandidates(): number[] {
    return this.servers.filter((s) => s.state === 'healthy' && s.healthCheckHealthy).map((s) => s.id);
  }

  private allServerIds(): number[] {
    return this.servers.map((s) => s.id);
  }

  /**
   * Swap the record set. When the Lambda finds no healthy server it FAILS OPEN —
   * advertising every record rather than publishing an empty set that would
   * black-hole the zone, so clients keep trying (possibly dead) IPs.
   */
  private applyAdvertised(ids: number[], failOpen: boolean): void {
    this.advertised = ids.slice();
    if (failOpen && !this.failOpen) {
      this.metrics.log(this.now, 'critical', 'Publisher Lambda failing open: no healthy servers — advertising every record');
    }
    this.failOpen = failOpen;
    const set = new Set(ids);
    for (const s of this.servers) s.inDnsRecordSet = set.has(s.id);
  }

  // -- Resolution + TTL --------------------------------------------------------

  /** Make a cohort: roll EKS first, then pinned, else a plain direct client. */
  private makeCohort(): ClientCohort {
    const c = this.cfg.clients;
    const r = this.rng.next();
    let kind: 'direct' | 'eks' = 'direct';
    let pinned = false;
    if (r < c.eksFraction) kind = 'eks';
    else if (r < c.eksFraction + c.pinnedFraction) pinned = true;
    const weight = Math.max(0.05, 1 + (this.rng.next() * 2 - 1) * c.heterogeneity);
    return new ClientCohort(weight, pinned, kind);
  }

  /**
   * The cache TTL a cohort resolves on. EKS clusters resolve through a shared
   * CoreDNS cache, whose duration caps the record TTL — min(zone TTL, CoreDNS
   * cache). Direct clients use the zone TTL (×ttlMult, huge for pinned).
   */
  private effectiveTtlMs(c: ClientCohort): number {
    if (c.kind === 'eks') return Math.min(this.cfg.dns.ttlMs, this.cfg.clients.coreDnsCacheMs);
    return this.cfg.dns.ttlMs * c.ttlMult;
  }

  /** A cohort re-resolves: copy the current record set, re-arm its TTL. */
  private resolveCohort(c: ClientCohort): void {
    c.cachedSet = this.pickRecords();
    c.lastResolvedAt = this.now;
    this.metrics.countReResolve();
    const jitter = 1 + (this.rng.next() * 2 - 1) * this.cfg.dns.ttlJitter;
    const wait = Math.max(100, this.effectiveTtlMs(c) * jitter);
    if (c.reResolveEvent) c.reResolveEvent.active = false;
    c.reResolveEvent = this.queue.schedule(this.now + wait, () => this.resolveCohort(c));
  }

  /** RTB Fabric serves a private hosted zone and returns ALL advertised records
   * to every client — no multivalue subset. */
  private pickRecords(): number[] {
    return this.advertised.slice();
  }

  // -- Lifecycle ---------------------------------------------------------------

  private spawnServer(isReplacement: boolean): FabricServer {
    const s = new FabricServer(this.jitterCapacity(), this.jitterBoot());
    s.state = 'booting';
    s.bornAt = this.now;
    s.healthCheckHealthy = false;
    s.isReplacement = isReplacement;
    this.servers.push(s);
    this.queue.schedule(this.now + s.bootMs, () => {
      if (s.state !== 'booting') return;
      s.state = 'healthy';
      s.healthyAt = this.now;
      this.metrics.totals.serversBooted++;
      this.metrics.log(this.now, 'info', `Server ${s.id} booted — warming up (${(this.cfg.servers.warmupMs / 1000).toFixed(0)}s)`);
    });
    return s;
  }

  /** Remove a server: graceful drain (keeps serving cached traffic) then down. */
  private removeServer(s: FabricServer, graceful: boolean): void {
    if (s.state === 'down' || s.state === 'draining') return;
    s.healthCheckHealthy = false;
    this.metrics.totals.serversKilled++;
    if (graceful && this.cfg.servers.drainMs > 0) {
      s.state = 'draining';
      this.metrics.log(this.now, 'warn', `Server ${s.id} draining (${(this.cfg.servers.drainMs / 1000).toFixed(0)}s)`);
      this.queue.schedule(this.now + this.cfg.servers.drainMs, () => {
        if (s.state === 'draining') this.downServer(s);
      });
    } else {
      this.metrics.log(this.now, 'critical', `Server ${s.id} down — black-holing cached traffic`);
      this.downServer(s);
    }
  }

  private downServer(s: FabricServer): void {
    s.state = 'down';
    s.inDnsRecordSet = false;
    // Maintain fleet size: a replacement boots in (the ~5min scale-out clock).
    if (this.cfg.servers.autoReplace && this.liveCount() < this.desiredCount) {
      this.metrics.totals.serverReplacements++;
      this.spawnServer(true);
      this.metrics.log(this.now, 'info', `Replacement for server ${s.id} launching (boot ~${(this.cfg.servers.bootMs / 1000 / 60).toFixed(1)}min)`);
    }
    // Drop the dead tile once caches have had time to expire off it.
    this.queue.schedule(this.now + this.cfg.dns.ttlMs * 2 + DOWN_CLEANUP_PAD_MS, () => {
      const i = this.servers.indexOf(s);
      if (i >= 0 && s.state === 'down') this.servers.splice(i, 1);
    });
  }

  // -- Autoscale + traffic shape -----------------------------------------------

  private scheduleTick(): void {
    this.queue.schedule(this.now + TICK_MS, () => {
      this.maybeAutoScale();
      this.scheduleTick();
    });
  }

  private maybeAutoScale(): void {
    const sc = this.cfg.scaling;
    if (!sc.autoScaleEnabled) return;
    if (this.now - this.lastScaleAt < sc.cooldownMs) return;
    const live = this.liveCount();
    if (this.fleetUtil > sc.targetUtilization && live < sc.maxServers) {
      const add = Math.min(sc.scaleStep, sc.maxServers - live);
      for (let i = 0; i < add; i++) this.spawnServer(false);
      this.lastScaleAt = this.now;
      this.metrics.totals.scaleOutEvents++;
      this.metrics.log(
        this.now,
        'warn',
        `Scale-out: launching ${add} server(s) — fleet util ${Math.round(this.fleetUtil * 100)}%`,
      );
    }
  }

  private totalOffered(): number {
    const t = this.cfg.traffic;
    let base: number;
    switch (t.shape) {
      case 'steady':
        base = t.baseRatePerSec;
        break;
      case 'ramp':
        base = t.baseRatePerSec + (t.peakRatePerSec - t.baseRatePerSec) * Math.min(1, this.now / Math.max(1, t.rampDurationMs));
        break;
      case 'pulse': {
        const period = Math.max(1000, t.rampDurationMs);
        base = this.now % period < period * 0.4 ? t.peakRatePerSec : t.baseRatePerSec;
        break;
      }
    }
    return base * this.pulseFactor;
  }

  // -- Helpers -----------------------------------------------------------------

  private serves(s: FabricServer): boolean {
    return s.state === 'healthy' || s.state === 'draining';
  }

  private effectiveCapacity(s: FabricServer): number {
    if (!this.serves(s)) return 0;
    const w = this.cfg.servers.warmupMs;
    if (s.state === 'healthy' && s.healthyAt >= 0 && w > 0 && this.now < s.healthyAt + w) {
      const ramp = Math.max(0.05, (this.now - s.healthyAt) / w);
      return s.fullCapacity * ramp;
    }
    return s.fullCapacity;
  }

  private provisionedCapacity(): number {
    let sum = 0;
    for (const s of this.servers) if (s.state !== 'down') sum += s.fullCapacity;
    return sum;
  }

  private liveCount(): number {
    let n = 0;
    for (const s of this.servers) if (s.state !== 'down') n++;
    return n;
  }

  private jitterCapacity(): number {
    return Math.max(1, this.cfg.servers.capacityPerSec * (1 + (this.rng.next() * 2 - 1) * this.cfg.servers.capacityJitter));
  }

  private jitterBoot(): number {
    return Math.max(1000, this.rng.logNormal(this.cfg.servers.bootMs, this.cfg.servers.bootJitter));
  }

  private gauges(): DnsGauges {
    let healthy = 0;
    let booting = 0;
    let overloaded = 0;
    let draining = 0;
    let down = 0;
    let advCount = 0;
    let advCap = 0;
    for (const s of this.servers) {
      switch (s.state) {
        case 'healthy':
          healthy++;
          break;
        case 'booting':
          booting++;
          break;
        case 'draining':
          draining++;
          break;
        case 'down':
          down++;
          break;
      }
      if (s.overloaded && this.serves(s)) overloaded++;
      if (s.inDnsRecordSet) {
        advCount++;
        advCap += this.effectiveCapacity(s);
      }
    }
    return {
      offeredRate: this.rates.offered,
      servedRate: this.rates.served,
      advertisedHealthyCount: advCount,
      advertisedCapacity: advCap,
      meanServerLoad: this.meanLoad,
      maxServerLoad: this.maxLoad,
      healthyCount: healthy,
      bootingCount: booting,
      overloadedCount: overloaded,
      drainingCount: draining,
      downCount: down,
      provisionedCapacity: this.provisionedCapacity(),
    };
  }

  private detectConditions(): void {
    const avail = this.metrics.availability(10_000);
    const degraded = avail < this.cfg.slaTarget;
    if (degraded && !this.degradedWas) {
      this.throttledLog('degraded', 5000, 'critical', `Availability below SLO: ${(avail * 100).toFixed(1)}% < ${(this.cfg.slaTarget * 100).toFixed(0)}%`);
    }
    this.degradedWas = degraded;
  }

  private throttledLog(key: string, intervalMs: number, severity: 'info' | 'warn' | 'critical', message: string): void {
    const last = this.lastLogAt[key] ?? -Infinity;
    if (this.now - last < intervalMs) return;
    this.lastLogAt[key] = this.now;
    this.metrics.log(this.now, severity, message);
  }

  // -- Views -------------------------------------------------------------------

  /** Rolling availability for the HUD (last ~10s of sim time). */
  availability(windowMs = 10_000): number {
    return this.metrics.availability(windowMs);
  }

  degradedActive(): boolean {
    return this.degradedWas;
  }

  serverViews(): DnsServerView[] {
    return this.servers.map((s) => {
      const cap = this.effectiveCapacity(s);
      const bootElapsed = this.now - s.bornAt;
      return {
        id: s.id,
        state: s.state,
        overloaded: s.overloaded,
        capacity: cap,
        assignedRate: s.assignedRate,
        servedRate: s.servedRate,
        shedRate: s.shedRate,
        load: cap > 0 ? s.assignedRate / cap : 0,
        inDnsRecordSet: s.inDnsRecordSet,
        healthCheckHealthy: s.healthCheckHealthy,
        bootProgress: s.state === 'booting' ? Math.max(0, Math.min(1, bootElapsed / s.bootMs)) : 0,
        secondsUntilHealthy: s.state === 'booting' ? Math.max(0, (s.bootMs - bootElapsed) / 1000) : 0,
      };
    });
  }

  dnsView(): DnsControlView {
    const advCap = this.servers.reduce((a, s) => a + (s.inDnsRecordSet ? this.effectiveCapacity(s) : 0), 0);
    const healthyKnown = this.servers.filter((s) => s.state === 'healthy' && s.healthCheckHealthy).length;
    // The DNS update event is the soonest queued at updateIntervalMs cadence; we
    // approximate the countdown from the cadence and now.
    const period = this.cfg.dns.updateIntervalMs;
    const msUntil = period - (this.now % period);
    return {
      advertised: this.advertised.slice(),
      advertisedCount: this.advertised.length,
      advertisedCapacity: advCap,
      healthyKnownCount: healthyKnown,
      totalServers: this.servers.length,
      failOpen: this.failOpen,
      msUntilUpdate: msUntil,
      ttlMs: this.cfg.dns.ttlMs,
      updateIntervalMs: this.cfg.dns.updateIntervalMs,
    };
  }

  clientViews(): DnsClientView[] {
    const down = new Set(this.servers.filter((s) => s.state === 'down').map((s) => s.id));
    return this.cohorts.map((c) => ({
      id: c.id,
      offeredRate: c.offeredRate,
      cachedSet: c.cachedSet.slice(),
      staleIds: c.cachedSet.filter((id) => down.has(id)),
      pinned: c.pinned,
      kind: c.kind,
      effectiveTtlMs: this.effectiveTtlMs(c),
      msUntilReResolve: c.reResolveEvent ? Math.max(0, c.reResolveEvent.time - this.now) : 0,
      lastResolvedAt: c.lastResolvedAt,
      servedRate: c.servedRate,
      shedRate: 0,
      staleRate: c.staleRate,
      unavailableRate: c.unavailRate,
    }));
  }

  flowView(): DnsFlowView {
    return {
      offeredRate: this.rates.offered,
      servedRate: this.rates.served,
      shedRate: this.rates.shed,
      staleRate: this.rates.staleHit,
      unavailableRate: this.rates.capacityShortfall + this.rates.staleUnavailable,
      inbound: this.servers
        .filter((s) => s.assignedRate > 0 || this.serves(s))
        .map((s) => ({ serverId: s.id, rate: s.assignedRate, served: s.servedRate })),
    };
  }

  bidderViews(): { id: number }[] {
    return Array.from({ length: this.cfg.bidders.count }, (_, i) => ({ id: i }));
  }
}
