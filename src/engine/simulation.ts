/**
 * The discrete-event simulation of clients → RTB Fabric → downstreams.
 *
 * Everything runs on a virtual clock in *real-world* milliseconds; the app
 * slows playback via a time-dilation factor outside this module.
 *
 * The storm mechanism is not scripted — it emerges from three coupled rules:
 *   1. A request timeout poisons its connection (HTTP/1.1 semantics), so the
 *      client must tear it down and eventually re-handshake.
 *   2. TLS handshakes cost ~25x the CPU of proxying a request over a warm
 *      connection (measured range 15–70x; see Tempesta kernel-TLS study).
 *   3. Fabric CPU is shared: when demanded work exceeds capacity, *every*
 *      in-flight operation stretches proportionally (processor sharing).
 * Timeouts → teardown → handshakes → CPU contention → slower everything →
 * more timeouts. The protections each break one link of that loop.
 *
 * Concurrency note: requests are reused across retry attempts, so every
 * scheduled continuation captures the attempt number it belongs to and
 * checks staleness before acting. Storms are made of exactly these races —
 * responses arriving for clients that already gave up — and the model
 * accounts for that wasted work explicitly.
 */

import { EventQueue, type ScheduledEvent } from './eventQueue';
import { MetricsCollector } from './metrics';
import { Rng } from './rng';
import type {
  BreakerState,
  ConnectionState,
  FabricView,
  RequestFate,
  RequestPhase,
  SimulationConfig,
} from './types';

// --- Fixed model constants (deliberately not knobs — they set the stage) ---

/** One-way network latency, fabric ↔ downstream (ms). */
export const NET_FABRIC_DS_MS = 10;
/** Network round trips in a full TLS handshake (hellos + key exchange). */
const HANDSHAKE_RTTS_FULL = 2;
/** An abbreviated (resumed) handshake saves a round trip. */
const HANDSHAKE_RTTS_RESUMED = 1;
/** Max integration slice for the CPU model (ms of sim time). */
const SLICE_MS = 1;
/** How long a closing connection lingers for the renderer (ms). */
const CLOSE_LINGER_MS = 150;
/** How long a resolved request's fate flash lingers (ms). */
const FATE_LINGER_MS = 250;
/** Client-side pause after a refused/failed connect before trying again (ms). */
const CONNECT_BACKOFF_MS = 120;
/** Cap on exponential retry backoff (ms). */
const RETRY_BACKOFF_CAP_MS = 2000;
/**
 * An abandoned inbound handshake (client gave up while queued) still burns
 * this fraction of the handshake's CPU before the fabric notices.
 */
const ABANDONED_HANDSHAKE_WORK = 0.5;
/** Outbound (fabric→downstream) TLS client work relative to inbound server work. */
const OUTBOUND_TLS_CPU_FACTOR = 0.5;
/** Downstream errors return faster than successes (fraction of sampled time). */
const ERROR_TIME_FACTOR = 0.5;
/** Log-normal samples are clamped to this multiple of the median. */
const LATENCY_CLAMP_FACTOR = 25;
/** Sim-time width of one circuit-breaker window bucket (ms). */
const BREAKER_BUCKET_MS = 250;
const BREAKER_WINDOW_BUCKETS = 8;

// ---------------------------------------------------------------------------
// CPU model — processor sharing
// ---------------------------------------------------------------------------

interface CpuOp {
  /** Nominal duration remaining (ms at zero contention). */
  remainingMs: number;
  /** Work-units demanded per nominal ms (1 for requests, much more for TLS). */
  ratePerMs: number;
  onComplete: () => void;
}

class CpuScheduler {
  private ops = new Set<CpuOp>();
  private capacityPerMs: number;

  constructor(unitsPerSec: number) {
    this.capacityPerMs = unitsPerSec / 1000;
  }

  setCapacity(unitsPerSec: number): void {
    this.capacityPerMs = unitsPerSec / 1000;
  }

  add(durationMs: number, totalWork: number, onComplete: () => void): CpuOp {
    const op: CpuOp = {
      remainingMs: Math.max(0.01, durationMs),
      ratePerMs: totalWork / Math.max(0.01, durationMs),
      onComplete,
    };
    this.ops.add(op);
    return op;
  }

  demandPerMs(): number {
    let d = 0;
    for (const op of this.ops) d += op.ratePerMs;
    return d;
  }

  /** Demanded work / capacity. Values > 1 mean everything is stretching. */
  utilization(): number {
    return this.demandPerMs() / this.capacityPerMs;
  }

  /** Multiplier applied to every in-flight operation's duration right now. */
  slowdownFactor(): number {
    return Math.max(1, this.utilization());
  }

  /** Advance all ops by dt sim-ms; fire completions. */
  advance(dtMs: number): void {
    if (this.ops.size === 0) return;
    const speed = Math.min(1, this.capacityPerMs / this.demandPerMs());
    const progressed = dtMs * speed;
    const done: CpuOp[] = [];
    for (const op of this.ops) {
      op.remainingMs -= progressed;
      if (op.remainingMs <= 0) done.push(op);
    }
    for (const op of done) {
      this.ops.delete(op);
      op.onComplete();
    }
  }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

let nextConnId = 1;
let nextRequestId = 1;

export class ConnSim {
  id = nextConnId++;
  state: ConnectionState = 'connecting';
  stateSince = 0;
  /** Client gave up on this connection attempt; finishing work is wasted. */
  abandoned = false;
  /** This handshake uses TLS session resumption (cheaper). */
  resumed = false;
  /** Currently held against the fabric's connection limit. */
  counted = false;
  clientId: number;
  downstreamId: number;

  constructor(clientId: number, downstreamId: number) {
    this.clientId = clientId;
    this.downstreamId = downstreamId;
  }

  setState(state: ConnectionState, now: number): void {
    this.state = state;
    this.stateSince = now;
  }
}

export class RequestSim {
  id = nextRequestId++;
  downstreamId = -1;
  phase: RequestPhase = 'waitingForConnection';
  phaseSince = 0;
  phaseUntil = 0;
  attempt = 0;
  fate: RequestFate | null = null;
  fateTime = 0;
  /** Sim time the current attempt started (its client deadline runs from here). */
  startedAt = 0;
  /** Client-side connection carrying this attempt. */
  conn: ConnSim | null = null;
  /** Fabric→downstream connection carrying this attempt. */
  dsConn: ConnSim | null = null;
  timeoutEvent: ScheduledEvent | null = null;
  dsTimeoutEvent: ScheduledEvent | null = null;
  /** True while this request is its client breaker's single half-open probe. */
  isClientProbe = false;
  clientId: number;

  constructor(clientId: number) {
    this.clientId = clientId;
  }

  setPhase(phase: RequestPhase, now: number, until: number): void {
    this.phase = phase;
    this.phaseSince = now;
    this.phaseUntil = until;
  }
}

class BreakerWindow {
  successes = new Array<number>(BREAKER_WINDOW_BUCKETS).fill(0);
  failures = new Array<number>(BREAKER_WINDOW_BUCKETS).fill(0);
  private headTime = 0;
  private head = 0;

  record(now: number, ok: boolean): void {
    this.rotate(now);
    if (ok) this.successes[this.head]++;
    else this.failures[this.head]++;
  }

  ratio(now: number): { failures: number; total: number } {
    this.rotate(now);
    let s = 0;
    let f = 0;
    for (let i = 0; i < BREAKER_WINDOW_BUCKETS; i++) {
      s += this.successes[i];
      f += this.failures[i];
    }
    return { failures: f, total: s + f };
  }

  reset(): void {
    this.successes.fill(0);
    this.failures.fill(0);
  }

  private rotate(now: number): void {
    while (now >= this.headTime + BREAKER_BUCKET_MS) {
      this.head = (this.head + 1) % BREAKER_WINDOW_BUCKETS;
      this.successes[this.head] = 0;
      this.failures[this.head] = 0;
      this.headTime += BREAKER_BUCKET_MS;
    }
  }
}

/** A request waiting (with its attempt number) for a downstream connection. */
interface DsQueueEntry {
  req: RequestSim;
  attempt: number;
  /** Absolute sim time at which the fabric abandons this downstream call. */
  deadline: number;
  expiry: ScheduledEvent | null;
}

/** A connection waiting (time-bounded) for a TLS handshake permit. */
interface PermitWaiter {
  conn: ConnSim;
  expiry: ScheduledEvent;
}

export class DownstreamSim {
  inFlight = 0;
  /**
   * Ejection-style breaker (no half-open probes): open removes the
   * downstream from the random rotation; after the cooldown it re-enters
   * directly with a fresh window, re-tripping quickly if still broken.
   */
  breaker: BreakerState = 'closed';
  breakerSince = 0;
  window = new BreakerWindow();
  /** Fabric-side connections to this downstream. */
  conns: ConnSim[] = [];
  /** Requests waiting for a free fabric→downstream connection. */
  queue: DsQueueEntry[] = [];
  id: number;

  constructor(id: number) {
    this.id = id;
  }

  loadFactor(capacity: number): number {
    return Math.max(1, this.inFlight / Math.max(1, capacity));
  }
}

export class ClientSim {
  conns: ConnSim[] = [];
  waiting: RequestSim[] = [];
  pendingRetries = 0;
  /** No new connection attempts until this time (post-refusal backoff). */
  backoffUntil = 0;
  arrivalEvent: ScheduledEvent | null = null;
  /** Client-side circuit breaker toward the fabric. */
  breaker: BreakerState = 'closed';
  breakerSince = 0;
  probeInFlight = false;
  window = new BreakerWindow();
  id: number;

  constructor(id: number) {
    this.id = id;
  }

  idleConn(): ConnSim | null {
    return this.conns.find((c) => c.state === 'idle') ?? null;
  }

  connectingCount(): number {
    return this.conns.filter((c) => c.state === 'connecting' || c.state === 'handshaking').length;
  }

  liveConnCount(): number {
    return this.conns.filter((c) => c.state !== 'closing').length;
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export class Simulation {
  now = 0;
  readonly rng: Rng;
  readonly queue = new EventQueue();
  readonly metrics = new MetricsCollector();
  readonly cpu: CpuScheduler;

  clients: ClientSim[] = [];
  downstreams: DownstreamSim[] = [];
  /** All live requests (renderer iterates this). */
  requests = new Set<RequestSim>();

  // Fabric state
  /** Inbound connections currently held against the connection limit. */
  fabricConnCount = 0;
  handshakesActive = 0;
  /** Connections waiting (time-bounded) for a TLS permit. There is no queue. */
  permitWaiters: PermitWaiter[] = [];
  /** Requests inside the fabric (processing, queued, or at a downstream). */
  fabricInFlight = 0;

  // Pulse state
  pulseFactor = 1;
  pulseUntil = 0;

  // Log throttling / condition edge detection
  private lastLogAt: Record<string, number> = {};
  private shedWasActive = false;
  private stormWasActive = false;
  private cpuSaturatedSince: number | null = null;

  cfg: SimulationConfig;

  constructor(cfg: SimulationConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.cpu = new CpuScheduler(cfg.fabric.cpuCapacity);
    for (let i = 0; i < cfg.clients.count; i++) this.addClient();
    for (let i = 0; i < cfg.downstreams.count; i++) this.downstreams.push(new DownstreamSim(i));
    this.prewarm();
  }

  /**
   * Start with warm pools, as a production fabric runs. Without this, t=0 is
   * itself a thundering herd of cold handshakes — a real failure mode, but
   * not the scenario the presets are staged to teach.
   */
  private prewarm(): void {
    const perClient = Math.min(
      this.cfg.clients.poolSize,
      Math.ceil(this.cfg.clients.requestRatePerSec * 0.2) + 1,
    );
    for (const client of this.clients) {
      for (let i = 0; i < perClient; i++) {
        if (this.fabricConnCount >= this.cfg.fabric.maxConnections) break;
        const conn = new ConnSim(client.id, -1);
        conn.setState('idle', 0);
        conn.counted = true;
        client.conns.push(conn);
        this.fabricConnCount++;
      }
    }
    const totalRate = this.cfg.clients.count * this.cfg.clients.requestRatePerSec;
    const perDs = Math.min(
      this.cfg.downstreamPool.poolSizePerDownstream,
      Math.ceil((totalRate / Math.max(1, this.cfg.downstreams.count)) * 0.2) + 1,
    );
    for (const ds of this.downstreams) {
      for (let i = 0; i < perDs; i++) {
        const conn = new ConnSim(-1, ds.id);
        conn.setState('idle', 0);
        ds.conns.push(conn);
      }
    }
  }

  // -- Time ------------------------------------------------------------------

  /** Advance the simulation by dt virtual milliseconds. */
  step(dtMs: number): void {
    let remaining = dtMs;
    while (remaining > 0) {
      const slice = Math.min(SLICE_MS, remaining);
      this.cpu.advance(slice);
      this.now += slice;
      remaining -= slice;
      let ev: ScheduledEvent | null;
      while ((ev = this.queue.popDue(this.now)) !== null) ev.fire();
    }
    if (this.pulseFactor !== 1 && this.now >= this.pulseUntil) {
      this.pulseFactor = 1;
      this.metrics.log(this.now, 'info', 'Traffic pulse ended');
      this.rescheduleArrivals();
    }
    this.metrics.advance(this.now, {
      connections: this.fabricConnCount,
      queueDepth: this.totalDsQueueDepth(),
      cpu: this.cpu.utilization(),
      handshakesActive: this.handshakesActive,
    });
    this.detectConditions();
  }

  /** Multiply client arrival rates by `factor` for `durationMs` of sim time. */
  triggerPulse(factor: number, durationMs: number): void {
    this.pulseFactor = factor;
    this.pulseUntil = this.now + durationMs;
    this.metrics.log(this.now, 'warn', `Traffic pulse: ${factor}x for ${(durationMs / 1000).toFixed(1)}s`);
    this.rescheduleArrivals();
  }

  /** Re-sample every client's next arrival (call after rate changes). */
  rescheduleArrivals(): void {
    for (const client of this.clients) {
      if (client.arrivalEvent) client.arrivalEvent.active = false;
      this.scheduleArrival(client);
    }
  }

  /** Apply live structural config changes (entity counts, CPU capacity). */
  applyStructure(): void {
    this.cpu.setCapacity(this.cfg.fabric.cpuCapacity);
    while (this.clients.length < this.cfg.clients.count) this.addClient();
    while (this.clients.length > this.cfg.clients.count) this.removeClient();
    while (this.downstreams.length < this.cfg.downstreams.count) {
      this.downstreams.push(new DownstreamSim(this.downstreams.length));
    }
    while (this.downstreams.length > this.cfg.downstreams.count) this.removeDownstream();
  }

  // -- Clients -----------------------------------------------------------------

  private addClient(): void {
    const client = new ClientSim(this.clients.length);
    this.clients.push(client);
    this.scheduleArrival(client);
  }

  private removeClient(): void {
    const client = this.clients.pop();
    if (!client) return;
    if (client.arrivalEvent) client.arrivalEvent.active = false;
    for (const req of this.requests) {
      if (req.clientId === client.id && !req.fate) {
        req.attempt += 1000; // invalidate all in-flight continuations
        this.requests.delete(req);
      }
    }
    for (const conn of [...client.conns]) this.teardownClientConn(client, conn);
  }

  private removeDownstream(): void {
    const ds = this.downstreams.pop();
    if (!ds) return;
    // Every queued entry holds exactly one outstanding fabricInFlight count,
    // dead or alive — drop them all; only live ones get an answer.
    for (const entry of ds.queue) {
      this.fabricInFlight--;
      if (entry.expiry) entry.expiry.active = false;
      if (entry.req.attempt === entry.attempt && !entry.req.fate) {
        this.respondError(entry.req);
      }
    }
    ds.queue = [];
  }

  private scheduleArrival(client: ClientSim): void {
    const rate = this.cfg.clients.requestRatePerSec * this.pulseFactor;
    if (rate <= 0) return;
    const wait = this.rng.exponential(1000 / rate);
    client.arrivalEvent = this.queue.schedule(this.now + wait, () => {
      this.scheduleArrival(client);
      this.onArrival(client);
    });
  }

  private onArrival(client: ClientSim): void {
    this.metrics.countArrival();
    const req = new RequestSim(client.id);
    this.requests.add(req);
    this.startAttempt(client, req);
  }

  /** Begin an attempt (first try or retry): find a connection, arm timers. */
  private startAttempt(client: ClientSim, req: RequestSim): void {
    if (!this.clientBreakerAllows(client, req)) {
      // Fail fast locally: the client's own breaker is open.
      this.metrics.countRejected();
      this.resolve(req, 'rejected');
      return;
    }
    const a = req.attempt;
    req.startedAt = this.now;
    const deadline = this.cfg.clients.clientTimeoutMs;
    req.setPhase('waitingForConnection', this.now, this.now + deadline);
    // One deadline traps both phases: still waiting for a connection when it
    // fires → rejected; on a connection → timeout (poisons the connection).
    req.timeoutEvent = this.queue.schedule(this.now + deadline, () => {
      if (req.attempt !== a || req.fate) return;
      if (req.conn) {
        this.onClientTimeout(client, req);
        return;
      }
      client.waiting = client.waiting.filter((r) => r !== req);
      this.metrics.countRejected();
      this.recordClientOutcome(client, req, false);
      this.resolve(req, 'rejected');
    });
    this.dispatch(client, req);
  }

  // -- Client circuit breaker ----------------------------------------------------

  /** Gate an attempt on the client's breaker; claims the half-open probe slot. */
  private clientBreakerAllows(client: ClientSim, req: RequestSim): boolean {
    if (!this.cfg.clients.circuitBreakerEnabled) return true;
    if (client.breaker === 'closed') return true;
    if (client.breaker === 'halfOpen' && !client.probeInFlight) {
      client.probeInFlight = true;
      req.isClientProbe = true;
      return true;
    }
    return false;
  }

  /** Feed an attempt outcome to the client breaker (never breaker fast-fails). */
  private recordClientOutcome(client: ClientSim, req: RequestSim, ok: boolean): void {
    const c = this.cfg.clients;
    if (req.isClientProbe) {
      req.isClientProbe = false;
      client.probeInFlight = false;
      if (ok) {
        client.breaker = 'closed';
        client.breakerSince = this.now;
        client.window.reset();
        this.metrics.log(this.now, 'info', `Client ${client.id + 1} breaker closed (probe succeeded)`);
      } else {
        client.breaker = 'open';
        client.breakerSince = this.now;
        this.scheduleClientProbe(client);
      }
      return;
    }
    client.window.record(this.now, ok);
    if (!c.circuitBreakerEnabled || client.breaker !== 'closed') return;
    const { failures, total } = client.window.ratio(this.now);
    if (total >= c.breakerMinSamples && failures / total >= c.breakerFailureRatio) {
      client.breaker = 'open';
      client.breakerSince = this.now;
      this.metrics.log(this.now, 'warn', `Client ${client.id + 1} circuit breaker OPEN`);
      this.scheduleClientProbe(client);
    }
  }

  private scheduleClientProbe(client: ClientSim): void {
    this.queue.schedule(this.now + this.cfg.clients.breakerCooldownMs, () => {
      if (client.breaker === 'open') {
        client.breakerSince = this.now;
        client.breaker = 'halfOpen';
      }
    });
  }

  /** Try to put a request on a connection; otherwise leave it waiting. */
  private dispatch(client: ClientSim, req: RequestSim): void {
    const idle = client.idleConn();
    if (idle) {
      this.sendOnConnection(client, req, idle);
      return;
    }
    if (!client.waiting.includes(req)) client.waiting.push(req);
    this.maybeOpenConnection(client);
  }

  /** One-way wire time for a client ↔ fabric leg (half the client RTT). */
  private clientHopMs(): number {
    return this.cfg.clients.rttMs / 2;
  }

  private maybeOpenConnection(client: ClientSim): void {
    if (this.now < client.backoffUntil) return;
    if (client.liveConnCount() >= this.cfg.clients.poolSize) return;
    if (client.connectingCount() >= client.waiting.length) return;
    const conn = new ConnSim(client.id, -1);
    conn.setState('connecting', this.now);
    client.conns.push(conn);
    // Hot-path rebuild: the attempt is trapped by the same client timeout as
    // the requests that forced it — there is no separate connect budget.
    this.queue.schedule(this.now + this.cfg.clients.clientTimeoutMs, () =>
      this.onConnectTimeout(client, conn),
    );
    // The SYN reaches the fabric after one network hop.
    this.queue.schedule(this.now + this.clientHopMs(), () => this.fabricAccept(client, conn));
  }

  private onConnectTimeout(client: ClientSim, conn: ConnSim): void {
    if (conn.state !== 'connecting' && conn.state !== 'handshaking') return;
    if (!client.conns.includes(conn)) return;
    // The client walks away; the fabric will discover this only after doing
    // (wasted) handshake work. Client-side, the pool slot frees immediately.
    conn.abandoned = true;
    client.conns = client.conns.filter((c) => c !== conn);
    client.backoffUntil = Math.max(client.backoffUntil, this.now + CONNECT_BACKOFF_MS);
  }

  private sendOnConnection(client: ClientSim, req: RequestSim, conn: ConnSim): void {
    const a = req.attempt;
    conn.setState('busy', this.now);
    req.conn = conn;
    client.waiting = client.waiting.filter((r) => r !== req);
    // The deadline armed at attempt start keeps running — time spent waiting
    // for this connection came out of the same budget.
    req.setPhase('travelingToFabric', this.now, this.now + this.clientHopMs());
    this.queue.schedule(this.now + this.clientHopMs(), () => {
      if (req.attempt !== a || req.fate) return;
      this.fabricReceive(req);
    });
  }

  /** The defining storm event: a timeout poisons the connection. */
  private onClientTimeout(client: ClientSim, req: RequestSim): void {
    this.metrics.countTimeout();
    this.recordClientOutcome(client, req, false);
    if (req.conn) this.teardownClientConn(client, req.conn);
    req.conn = null;
    this.resolve(req, 'timeout');
  }

  private teardownClientConn(client: ClientSim, conn: ConnSim): void {
    if (conn.state === 'closing') return;
    conn.setState('closing', this.now);
    this.releaseCount(conn);
    this.queue.schedule(this.now + CLOSE_LINGER_MS, () => {
      client.conns = client.conns.filter((c) => c !== conn);
    });
  }

  /** Response (any kind) reaches the client. */
  private clientReceive(req: RequestSim, kind: 'success' | 'error'): void {
    const client = this.clients[req.clientId];
    if (!client) return;
    if (req.timeoutEvent) {
      req.timeoutEvent.active = false;
      req.timeoutEvent = null;
    }
    // A clean response — even an error — keeps the connection alive,
    // unlike a timeout, which poisons it.
    if (req.conn && req.conn.state === 'busy') {
      req.conn.setState('idle', this.now);
      this.serveWaiting(client);
    }
    req.conn = null;
    if (kind === 'success') {
      this.metrics.countSuccess(this.now - req.startedAt);
      this.recordClientOutcome(client, req, true);
      this.resolve(req, 'success');
    } else {
      this.metrics.countError();
      this.recordClientOutcome(client, req, false);
      this.resolve(req, 'error');
    }
  }

  /**
   * Dispatch newest-first (adaptive LIFO). With a single client deadline,
   * the freshest waiting request has the most budget left; serving the
   * oldest first would hand every rebuilt connection a nearly-expired
   * request that times out and poisons it — a client-side spiral that pins
   * goodput at zero with the fabric CPU idle. The starved oldest requests
   * fail by deadline rejection instead, which poisons nothing.
   */
  private serveWaiting(client: ClientSim): void {
    const idle = client.idleConn();
    if (!idle) return;
    const req = client.waiting.pop();
    if (req) this.sendOnConnection(client, req, idle);
  }

  /** Record a request's outcome; schedule a retry or removal. */
  private resolve(req: RequestSim, fate: RequestFate): void {
    req.fate = fate;
    req.fateTime = this.now;
    if (req.timeoutEvent) {
      req.timeoutEvent.active = false;
      req.timeoutEvent = null;
    }
    const c = this.cfg.clients;
    if (fate !== 'success' && req.attempt < c.maxRetries) {
      const client = this.clients[req.clientId];
      if (!client) return;
      const a = req.attempt;
      // Exponential backoff; with jitter this is AWS "full jitter":
      // sleep = rand(0, min(cap, base * 2^attempt)).
      let backoff = Math.min(RETRY_BACKOFF_CAP_MS, c.retryBackoffBaseMs * Math.pow(2, req.attempt));
      if (c.retryJitter) backoff *= this.rng.next();
      client.pendingRetries++;
      this.queue.schedule(this.now + Math.max(1, backoff), () => {
        client.pendingRetries--;
        if (req.attempt !== a || !this.clients.includes(client)) {
          this.requests.delete(req);
          return;
        }
        this.metrics.countRetry();
        this.beginRetry(client, req);
      });
    } else {
      this.queue.schedule(this.now + FATE_LINGER_MS, () => this.requests.delete(req));
    }
  }

  private beginRetry(client: ClientSim, req: RequestSim): void {
    // If this request owned the client breaker's half-open probe, hand the
    // slot back — otherwise the breaker is wedged out of rotation forever.
    if (req.isClientProbe) {
      client.probeInFlight = false;
      req.isClientProbe = false;
    }
    req.attempt++;
    req.fate = null;
    req.conn = null;
    req.dsConn = null;
    req.downstreamId = -1;
    this.startAttempt(client, req);
  }

  // -- Fabric: inbound connections & TLS ---------------------------------------

  private acceptCount(conn: ConnSim): void {
    this.fabricConnCount++;
    conn.counted = true;
  }

  private releaseCount(conn: ConnSim): void {
    if (conn.counted) {
      this.fabricConnCount--;
      conn.counted = false;
    }
  }

  private fabricAccept(client: ClientSim, conn: ConnSim): void {
    if (conn.abandoned || conn.state === 'closing') return;
    const f = this.cfg.fabric;
    if (this.fabricConnCount >= f.maxConnections) {
      this.metrics.countShedConnLimit();
      this.shedConnection(client, conn, 'connection limit exceeded');
      return;
    }
    this.acceptCount(conn);
    conn.resumed = this.rng.chance(f.tlsResumptionRate);
    if (this.handshakesActive < f.tlsHandshakeConcurrency) {
      this.startHandshake(client, conn);
    } else if (f.tlsPermitWaitMs > 0) {
      // No TLS queue — the connection may wait a bounded time for a permit,
      // after which it is shed with an RST.
      const waiter: PermitWaiter = { conn, expiry: null as unknown as ScheduledEvent };
      waiter.expiry = this.queue.schedule(this.now + f.tlsPermitWaitMs, () =>
        this.onPermitExpiry(client, waiter),
      );
      this.permitWaiters.push(waiter);
    } else {
      this.shedTls(client, conn);
    }
  }

  /** The permit never came: shed the connection. */
  private onPermitExpiry(client: ClientSim, waiter: PermitWaiter): void {
    const idx = this.permitWaiters.indexOf(waiter);
    if (idx < 0) return;
    this.permitWaiters.splice(idx, 1);
    const conn = waiter.conn;
    if (conn.state === 'closing') {
      this.releaseCount(conn);
      return;
    }
    this.shedTls(client, conn);
  }

  /**
   * Shed at TLS admission. With TLS error pacing on, the RST is held for the
   * pacing delay before it is sent, so shed clients don't learn — and
   * reconnect — in lockstep.
   */
  private shedTls(client: ClientSim, conn: ConnSim): void {
    const f = this.cfg.fabric;
    this.metrics.countShedTls();
    if (f.tlsErrorPacingEnabled && f.tlsErrorPacingDelayMs > 0) {
      this.queue.schedule(this.now + f.tlsErrorPacingDelayMs, () => {
        if (conn.state === 'closing') {
          this.releaseCount(conn);
          return;
        }
        this.shedConnection(client, conn, 'TLS permits exhausted');
      });
    } else {
      this.shedConnection(client, conn, 'TLS permits exhausted');
    }
  }

  /** RST: the connection is invalidated; the client learns one hop later. */
  private shedConnection(client: ClientSim, conn: ConnSim, reason: string): void {
    this.throttledLog('shed', 2000, 'warn', `Fabric shedding connections (${reason} — RST)`);
    this.releaseCount(conn);
    conn.setState('closing', this.now);
    this.queue.schedule(this.now + this.clientHopMs(), () => {
      client.conns = client.conns.filter((c) => c !== conn);
      client.backoffUntil = Math.max(client.backoffUntil, this.now + CONNECT_BACKOFF_MS);
    });
  }

  /**
   * A handshake has two parts. The fabric-side crypto loads the shared CPU
   * (tlsHandshakeCpuMs / tlsCpuCost, stretched under contention). The wire
   * part — hello round trips at the client RTT plus the client's own TLS
   * processing (client TLS delay) — stretches the handshake and holds its
   * permit but consumes no fabric CPU: a far or burdened client slows
   * completion, not the fabric.
   */
  private startHandshake(client: ClientSim, conn: ConnSim): void {
    const f = this.cfg.fabric;
    this.handshakesActive++;
    this.metrics.countHandshakeStarted(conn.resumed);
    const startedAbandoned = conn.abandoned;
    if (!startedAbandoned) conn.setState('handshaking', this.now);
    // Session resumption skips the expensive asymmetric crypto.
    const resumeFactor = conn.resumed ? f.tlsResumptionCostFactor : 1;
    const fraction = (startedAbandoned ? ABANDONED_HANDSHAKE_WORK : 1) * resumeFactor;
    const finish = () => {
      this.handshakesActive--;
      if (conn.state === 'closing') {
        // Torn down mid-handshake; the teardown already released the count.
        this.metrics.countHandshakeCompleted(true);
      } else if (startedAbandoned || conn.abandoned) {
        // Client is long gone; all that crypto was for nothing.
        this.metrics.countHandshakeCompleted(true);
        this.releaseCount(conn);
      } else {
        this.metrics.countHandshakeCompleted(false);
        conn.setState('idle', this.now);
        this.serveWaiting(client);
      }
      this.grantPermits();
    };
    this.cpu.add(f.tlsHandshakeCpuMs * fraction, f.tlsCpuCost * fraction, () => {
      if (conn.state === 'closing' || startedAbandoned || conn.abandoned) {
        // No one is on the other end; skip the wire phase and free the permit.
        finish();
        return;
      }
      const c = this.cfg.clients;
      const rtts = conn.resumed ? HANDSHAKE_RTTS_RESUMED : HANDSHAKE_RTTS_FULL;
      this.queue.schedule(this.now + rtts * c.rttMs + c.tlsClientDelayMs, finish);
    });
  }

  /** A permit freed up: grant it to the longest-waiting viable connection. */
  private grantPermits(): void {
    const f = this.cfg.fabric;
    while (this.handshakesActive < f.tlsHandshakeConcurrency && this.permitWaiters.length > 0) {
      const waiter = this.permitWaiters.shift()!;
      waiter.expiry.active = false;
      const conn = waiter.conn;
      if (conn.state === 'closing') {
        this.releaseCount(conn);
        continue;
      }
      const client = this.clients[conn.clientId];
      if (!client) {
        this.releaseCount(conn);
        continue;
      }
      // Abandoned connections still get the permit and burn (wasted) crypto —
      // the fabric can't know the client hung up until it tries.
      this.startHandshake(client, conn);
    }
  }

  // -- Fabric: request path -----------------------------------------------------

  private fabricReceive(req: RequestSim): void {
    const a = req.attempt;
    const f = this.cfg.fabric;
    this.fabricInFlight++;
    req.setPhase('processingAtFabric', this.now, this.now + f.processingMs * this.cpu.slowdownFactor());
    this.cpu.add(f.processingMs, f.processingMs, () => {
      if (req.attempt !== a || req.fate) {
        this.fabricInFlight--; // processed a request whose client already left
        return;
      }
      this.routeToDownstream(req);
    });
  }

  private routeToDownstream(req: RequestSim): void {
    const p = this.cfg.downstreamPool;
    // Random IP selection across all downstreams in rotation (ejected ones
    // are skipped until their cooldown re-admits them).
    const healthy = this.downstreams.filter(
      (ds) => !p.circuitBreakerEnabled || ds.breaker === 'closed',
    );
    if (healthy.length === 0) {
      this.fabricInFlight--;
      this.throttledLog('nods', 2000, 'critical', 'All downstreams circuit-broken — failing fast');
      this.respondError(req);
      return;
    }
    const ds = healthy[Math.floor(this.rng.next() * healthy.length)];
    req.downstreamId = ds.id;
    const deadline = this.now + p.requestTimeoutMs;
    const idle = ds.conns.find((c) => c.state === 'idle');
    if (idle) {
      this.forwardToDownstream(req, ds, idle, deadline);
      return;
    }
    if (ds.conns.filter((c) => c.state !== 'closing').length < p.poolSizePerDownstream) {
      this.openDownstreamConn(ds);
    }
    // The downstream deadline covers queue wait + wire time: a request that
    // sat in the queue forwards with only its remaining budget.
    req.setPhase('queuedAtFabric', this.now, deadline);
    const entry: DsQueueEntry = { req, attempt: req.attempt, deadline, expiry: null };
    entry.expiry = this.queue.schedule(deadline, () => this.onQueueExpiry(ds, entry));
    ds.queue.push(entry);
  }

  /** The fabric abandons a downstream call that never left the queue. */
  private onQueueExpiry(ds: DownstreamSim, entry: DsQueueEntry): void {
    const idx = ds.queue.indexOf(entry);
    if (idx < 0) return;
    ds.queue.splice(idx, 1);
    this.fabricInFlight--;
    if (entry.req.attempt !== entry.attempt || entry.req.fate) return;
    this.respondError(entry.req);
  }

  private openDownstreamConn(ds: DownstreamSim): void {
    const p = this.cfg.downstreamPool;
    const conn = new ConnSim(-1, ds.id);
    conn.setState('handshaking', this.now);
    ds.conns.push(conn);
    this.cpu.add(p.connectMs, this.cfg.fabric.tlsCpuCost * OUTBOUND_TLS_CPU_FACTOR, () => {
      if (conn.state !== 'handshaking') return;
      conn.setState('idle', this.now);
      this.serveDsQueue(ds);
    });
  }

  private serveDsQueue(ds: DownstreamSim): void {
    for (;;) {
      const idle = ds.conns.find((c) => c.state === 'idle');
      if (!idle) return;
      const entry = ds.queue.shift();
      if (!entry) return;
      const { req, attempt, deadline } = entry;
      if (entry.expiry) entry.expiry.active = false;
      if (req.attempt !== attempt || req.fate) {
        // Dead on dequeue: the client gave up while this sat in the queue.
        // The queue did nothing but delay the discovery — the AWS lesson on
        // why queues must be bounded by time.
        this.fabricInFlight--;
        continue;
      }
      this.forwardToDownstream(req, ds, idle, deadline);
    }
  }

  private forwardToDownstream(req: RequestSim, ds: DownstreamSim, conn: ConnSim, deadline: number): void {
    const a = req.attempt;
    conn.setState('busy', this.now);
    req.dsConn = conn;
    req.setPhase('travelingToDownstream', this.now, this.now + NET_FABRIC_DS_MS);
    req.dsTimeoutEvent = this.queue.schedule(Math.max(this.now + 1, deadline), () => {
      if (req.dsConn !== conn || req.attempt !== a) return;
      this.onDownstreamTimeout(req, ds, conn);
    });
    this.queue.schedule(this.now + NET_FABRIC_DS_MS, () => this.downstreamReceive(req, a, ds, conn));
  }

  private downstreamReceive(req: RequestSim, attempt: number, ds: DownstreamSim, conn: ConnSim): void {
    const d = this.cfg.downstreams;
    ds.inFlight++;
    const isError = this.rng.chance(d.errorRate);
    const sample = Math.min(
      d.responseTimeMedianMs * LATENCY_CLAMP_FACTOR,
      this.rng.logNormal(d.responseTimeMedianMs, d.responseTimeSigma),
    );
    let duration = sample * ds.loadFactor(d.concurrencyCapacity);
    if (isError) duration *= ERROR_TIME_FACTOR;
    if (req.attempt === attempt && !req.fate) {
      req.setPhase('atDownstream', this.now, this.now + duration);
    }
    this.queue.schedule(this.now + duration, () => {
      ds.inFlight--;
      this.downstreamComplete(req, attempt, ds, conn, isError);
    });
  }

  private downstreamComplete(
    req: RequestSim,
    attempt: number,
    ds: DownstreamSim,
    conn: ConnSim,
    isError: boolean,
  ): void {
    if (conn.state === 'closing') {
      // The fabric already timed this call out and poisoned the connection;
      // the downstream's work was wasted and everything is accounted for.
      return;
    }
    conn.setState('idle', this.now);
    this.serveDsQueue(ds);
    if (req.attempt !== attempt) {
      // The connection is fine, but this response belongs to a dead attempt.
      this.fabricInFlight--;
      return;
    }
    if (req.dsTimeoutEvent) {
      req.dsTimeoutEvent.active = false;
      req.dsTimeoutEvent = null;
    }
    req.dsConn = null;
    this.recordBreakerResult(ds, req, !isError);
    this.fabricInFlight--;
    if (req.fate) return; // client timed out; the response has nowhere to go
    if (isError) {
      this.respondError(req);
    } else {
      const wire = NET_FABRIC_DS_MS + this.clientHopMs();
      req.setPhase('returning', this.now, this.now + wire);
      const a = req.attempt;
      this.queue.schedule(this.now + wire, () => {
        if (req.attempt !== a || req.fate) return;
        this.clientReceive(req, 'success');
      });
    }
  }

  /** Fabric-side timeout on the downstream call: poison the outbound conn. */
  private onDownstreamTimeout(req: RequestSim, ds: DownstreamSim, conn: ConnSim): void {
    req.dsConn = null;
    req.dsTimeoutEvent = null;
    if (conn.state === 'busy') {
      conn.setState('closing', this.now);
      this.queue.schedule(this.now + CLOSE_LINGER_MS, () => {
        ds.conns = ds.conns.filter((c) => c !== conn);
      });
    }
    this.recordBreakerResult(ds, req, false);
    this.fabricInFlight--;
    if (req.fate) return;
    this.respondError(req);
  }

  private recordBreakerResult(ds: DownstreamSim, _req: RequestSim, ok: boolean): void {
    const p = this.cfg.downstreamPool;
    ds.window.record(this.now, ok);
    if (!p.circuitBreakerEnabled || ds.breaker !== 'closed') return;
    const { failures, total } = ds.window.ratio(this.now);
    if (total >= p.breakerMinSamples && failures / total >= p.breakerFailureRatio) {
      ds.breaker = 'open';
      ds.breakerSince = this.now;
      this.metrics.log(this.now, 'warn', `Downstream ${ds.id + 1} ejected (breaker open)`);
      this.queue.schedule(this.now + p.breakerCooldownMs, () => {
        // Ejection-style re-entry: rejoin the random rotation with a clean
        // window. If it is still broken, the window re-trips it quickly.
        if (ds.breaker === 'open') {
          ds.breaker = 'closed';
          ds.breakerSince = this.now;
          ds.window.reset();
          this.metrics.log(this.now, 'info', `Downstream ${ds.id + 1} re-entered rotation`);
        }
      });
    }
  }

  /** Send an error response back to the client. */
  private respondError(req: RequestSim): void {
    if (req.fate) return;
    const a = req.attempt;
    req.setPhase('returning', this.now, this.now + this.clientHopMs());
    this.queue.schedule(this.now + this.clientHopMs(), () => {
      if (req.attempt !== a || req.fate) return;
      this.clientReceive(req, 'error');
    });
  }

  // -- Views & condition detection ----------------------------------------------

  totalDsQueueDepth(): number {
    let n = 0;
    for (const ds of this.downstreams) n += ds.queue.length;
    return n;
  }

  fabricView(): FabricView {
    return {
      connectionCount: this.fabricConnCount,
      maxConnections: this.cfg.fabric.maxConnections,
      handshakesActive: this.handshakesActive,
      permitWaiting: this.permitWaiters.length,
      inFlight: this.fabricInFlight,
      cpuUtilization: this.cpu.utilization(),
      slowdownFactor: this.cpu.slowdownFactor(),
    };
  }

  private detectConditions(): void {
    const b = this.metrics.lastClosedBucket();
    if (!b) return;
    const shedActive = b.shedTls + b.shedConnLimit > 0;
    if (shedActive && !this.shedWasActive) {
      this.metrics.log(this.now, 'warn', 'Shedding connections (TLS permits / connection limit)');
    }
    this.shedWasActive = shedActive;

    // Single handshakes legitimately spike instantaneous demand past 100%;
    // only sustained saturation is an incident worth logging.
    if (this.cpu.utilization() >= 1) {
      if (this.cpuSaturatedSince === null) this.cpuSaturatedSince = this.now;
      if (this.now - this.cpuSaturatedSince >= 500) {
        this.throttledLog(
          'cpu',
          5000,
          'critical',
          `Fabric CPU saturated (${Math.round(this.cpu.utilization() * 100)}% demanded)`,
        );
      }
    } else {
      this.cpuSaturatedSince = null;
    }
    // A storm = clients failing fast (timeouts/rejections) while TLS pressure
    // is high. Late in a storm handshakes barely *start* (everything is
    // queued or refused), so gauge pressure counts too.
    const failing = b.timeouts + b.rejected >= 3;
    const tlsPressure =
      b.tlsHandshakesStarted >= 8 || this.handshakesActive >= 8 || this.permitWaiters.length >= 8;
    const stormActive = failing && tlsPressure;
    if (stormActive && !this.stormWasActive) {
      this.throttledLog(
        'storm',
        5000,
        'critical',
        'CONNECTION STORM: timeouts are tearing down connections faster than TLS can rebuild them',
      );
    }
    this.stormWasActive = stormActive;
  }

  /** True when the last closed bucket looks like an active storm (for UI banner). */
  stormActive(): boolean {
    return this.stormWasActive;
  }

  private throttledLog(
    key: string,
    intervalMs: number,
    severity: 'info' | 'warn' | 'critical',
    message: string,
  ): void {
    const last = this.lastLogAt[key] ?? -Infinity;
    if (this.now - last < intervalMs) return;
    this.lastLogAt[key] = this.now;
    this.metrics.log(this.now, severity, message);
  }
}
