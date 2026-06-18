/**
 * Control panel: preset cards, the pulse trigger, time controls, live knobs
 * grouped by component, lifetime counters, and the event ticker.
 * Plain DOM, no framework — knobs read/write the live SimulationConfig and
 * take effect immediately, like tuning a running system.
 *
 * Knob groups carry a scope: 'global' groups (Traffic) always edit every
 * sim so comparison mode keeps offered load identical; 'sim' groups —
 * including client behavior — edit the pane selected with the SIM A / SIM B
 * tabs.
 */

import { PRESETS } from '../engine/presets';
import type { Simulation } from '../engine/simulation';
import type { LockConfig, LockSite, SimulationConfig } from '../engine/types';
import { Legend } from './legend';

const LOCK_SITES: LockSite[] = ['accept', 'request', 'handshake'];
/** Monotonic id source for user-added locks (config-only; never touches engine RNG). */
let lockSeq = 0;

export const PANE_TAGS = ['A', 'B'] as const;

type KnobScope = 'global' | 'sim';

export interface ControlHooks {
  getSims(): Simulation[];
  /** Single mode: swap the whole config and restart. */
  loadPreset(id: string): void;
  /** Comparison mode: apply a preset's tuning to one pane (clients shared). */
  applyScenario(pane: number, id: string): void;
  reset(): void;
  /** Surge every sim at once. */
  pulse(factor: number, durationMs: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(s: number): void;
  getTimeScale(): number;
  /** 'rate' → reschedule arrivals; 'structure' → entity/CPU rebuild. */
  configChanged(kind: 'rate' | 'structure' | 'plain', target: number | 'all'): void;
  setCompare(on: boolean): void;
  isCompare(): boolean;
  showCompareHelp(): void;
}

/**
 * The detail behind a setting's ⓘ icon. Split into three fixed parts so every
 * knob documents the same things: the definition, the model mechanic it drives,
 * and the behavior to expect when it moves. Written against the engine in
 * simulation.ts — these double as the spec the model is checked against.
 */
interface SettingInfo {
  /** What the setting is. */
  what: string;
  /** How it works inside the model. */
  how: string;
  /** What to expect on the board when you change it. */
  expect: string;
}

interface KnobDef {
  label: string;
  min: number;
  max: number;
  step: number;
  kind?: 'rate' | 'structure' | 'plain';
  get(cfg: SimulationConfig): number;
  set(cfg: SimulationConfig, v: number): void;
  format?(v: number): string;
  info?: SettingInfo;
}

interface ToggleDef {
  label: string;
  get(cfg: SimulationConfig): boolean;
  set(cfg: SimulationConfig, v: boolean): void;
  info?: SettingInfo;
}

const ms = (v: number) => `${Math.round(v)}ms`;
const msFine = (v: number) => `${v}ms`;
const SIGMA_Z99 = 2.3263;

const GROUPS: Array<{ name: string; scope: KnobScope; knobs: KnobDef[]; toggles: ToggleDef[] }> = [
  {
    name: 'Traffic',
    scope: 'global',
    knobs: [
      {
        label: 'Clients', min: 1, max: 12, step: 1, kind: 'structure', get: (c) => c.clients.count, set: (c, v) => (c.clients.count = v),
        info: {
          what: 'How many independent client instances offer traffic to the fabric.',
          how: 'Each client runs its own Poisson arrival process, its own connection pool, and (when enabled) its own circuit breaker. Total offered load = clients × rate/client. This is a structural change — the client set is rebuilt live; in comparison mode it always applies to both sims so the offered load stays identical.',
          expect: 'More clients scales offered load and the number of connections competing for fabric CPU and TLS permits. Doubling clients roughly doubles handshake and request demand.',
        },
      },
      {
        label: 'Rate / client', min: 1, max: 80, step: 1, kind: 'rate', get: (c) => c.clients.requestRatePerSec, set: (c, v) => (c.clients.requestRatePerSec = v), format: (v) => `${v}/s`,
        info: {
          what: 'Target requests per second from each client (per client, not the total).',
          how: 'Arrivals are Poisson: inter-arrival gaps are exponential around 1000/rate ms, so short bursts happen naturally. Changing it reschedules every client’s next arrival immediately, and a traffic pulse multiplies this rate for its duration.',
          expect: 'Higher rate means more requests and deeper pools needed (pool ≈ 2× rate × latency). Push it past what CPU and downstreams can serve and goodput falls while retries amplify the load.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Clients',
    scope: 'sim',
    knobs: [
      {
        label: 'Pool size', min: 1, max: 24, step: 1, get: (c) => c.clients.poolSize, set: (c, v) => (c.clients.poolSize = v),
        info: {
          what: 'Maximum connections one client keeps open to the fabric.',
          how: 'A request with no idle connection waits; the client opens a new one only when it holds fewer live connections than the pool size and is not in post-refusal backoff. Pools are pre-warmed at start to ~20% of the rate. Every open connection counts against the fabric’s connection limit.',
          expect: 'Too small and requests queue client-side and reject on the client timeout even while the fabric is idle. Generous pools absorb bursts but, once a timeout poisons connections, force more simultaneous re-handshakes. Rule of thumb ≈ 2× Little’s law (rate × latency).',
        },
      },
      {
        label: 'Client RTT', min: 1, max: 100, step: 1, get: (c) => c.clients.rttMs, set: (c, v) => (c.clients.rttMs = v), format: ms,
        info: {
          what: 'Round-trip network time between a client and the fabric.',
          how: 'Every wire leg uses half the RTT one-way: the SYN, request, response, and RST. A full TLS handshake adds 2× RTT of hello exchanges (1× when resumed) — this stretches the handshake and holds its permit but burns no fabric CPU.',
          expect: 'Higher RTT slows handshakes and round trips, so the client timeout must be looser. Low-RTT clients are the dangerous ones: their retries return fast and hammer the fabric before it recovers.',
        },
      },
      {
        label: 'Client TLS delay', min: 0, max: 500, step: 10, get: (c) => c.clients.tlsClientDelayMs, set: (c, v) => (c.clients.tlsClientDelayMs = v), format: ms,
        info: {
          what: 'Extra time a burdened client takes to answer during the TLS handshake.',
          how: 'Added once to handshake completion, on top of the hello round trips. It holds the TLS permit longer but consumes no fabric CPU — it models a slow client, not a slow fabric.',
          expect: 'Higher delay makes handshakes occupy permits longer, so fewer complete per second and the permit pool saturates sooner under churn, even though CPU is untouched.',
        },
      },
      {
        label: 'Client timeout', min: 50, max: 1000, step: 10, get: (c) => c.clients.clientTimeoutMs, set: (c, v) => (c.clients.clientTimeoutMs = v), format: ms,
        info: {
          what: 'The client’s single deadline per attempt.',
          how: 'One deadline covers everything: waiting for a connection (including a hot-path rebuild and its handshake) and the request itself. Fire while still waiting for a connection → rejected (poisons nothing). Fire on a connection → timeout, which tears down (poisons) that connection. Presets set it ≈ p99 latency (~1% baseline timeouts).',
          expect: 'Set below typical latency and you get mass timeouts that poison connections faster than TLS can rebuild them — the storm. Looser timeouts tolerate the tail but hold pool slots longer.',
        },
      },
      {
        label: 'Max retries', min: 0, max: 5, step: 1, get: (c) => c.clients.maxRetries, set: (c, v) => (c.clients.maxRetries = v),
        info: {
          what: 'Retries after a timeout or error (0 = fire once, never retry).',
          how: 'After a non-success the request waits exponential backoff, then the same request object is reused for another attempt; each retry is counted and re-enters the breaker window. Retries are pure added load.',
          expect: 'More retries lift success under transient faults but multiply offered load exactly when the system is already failing. Amplification (attempts ÷ successes) climbs past ~1.5 and the retry loop sustains the storm after the trigger is gone.',
        },
      },
      {
        label: 'Backoff base', min: 5, max: 250, step: 5, get: (c) => c.clients.retryBackoffBaseMs, set: (c, v) => (c.clients.retryBackoffBaseMs = v), format: ms,
        info: {
          what: 'Base delay before the first retry; doubles each attempt.',
          how: 'Backoff = base × 2^attempt, capped at 2000ms. With jitter on it becomes AWS “full jitter”: a random value in [0, that]. With jitter off, every client that failed together retries at the same instant.',
          expect: 'A small base makes retries return fast and synchronized, re-poisoning freshly rebuilt connections. A larger base spreads waves out, giving the fabric time to drain handshakes between them.',
        },
      },
      {
        label: 'Breaker trip ratio', min: 0.1, max: 0.9, step: 0.05, get: (c) => c.clients.breakerFailureRatio, set: (c, v) => (c.clients.breakerFailureRatio = v), format: (v) => `${Math.round(v * 100)}%`,
        info: {
          what: 'Failure fraction over the rolling window that opens the client’s breaker.',
          how: 'An 8-bucket, ~2s window tracks outcomes; once it has enough samples and failures ÷ total ≥ this ratio, the breaker opens and the client fast-fails (rejected) for the cooldown, then half-opens and sends one probe. Only active when the Circuit breaker toggle below is on.',
          expect: 'A lower ratio trips earlier, shedding the client’s own load sooner to protect the fabric — at the cost of rejecting requests that might have succeeded. A higher ratio tolerates more failure before cutting off.',
        },
      },
      {
        label: 'Breaker cooldown', min: 500, max: 10000, step: 250, get: (c) => c.clients.breakerCooldownMs, set: (c, v) => (c.clients.breakerCooldownMs = v), format: (v) => `${(v / 1000).toFixed(1)}s`,
        info: {
          what: 'How long the client breaker stays open before probing.',
          how: 'While open, every attempt fast-fails as rejected. After the cooldown it half-opens and allows exactly one probe; a success closes it, a failure re-opens it for another cooldown.',
          expect: 'A longer cooldown gives the fabric more time to recover before traffic resumes, but rejects more requests meanwhile. Too short and it reopens repeatedly, drip-feeding load into a system that has not healed.',
        },
      },
    ],
    toggles: [
      {
        label: 'Retry jitter', get: (c) => c.clients.retryJitter, set: (c, v) => (c.clients.retryJitter = v),
        info: {
          what: 'Adds full jitter to retry backoff.',
          how: 'On → backoff is randomized to [0, base × 2^attempt]. Off → every retry fires at exactly base × 2^attempt. The difference between a smooth wave and a synchronized wall of retries.',
          expect: 'On smooths retry load and usually prevents the post-pulse echo storm. Off, a pulse that times out a cohort of requests sends them all back in lockstep — watch the storm form after the pulse ends.',
        },
      },
      {
        label: 'Circuit breaker', get: (c) => c.clients.circuitBreakerEnabled, set: (c, v) => (c.clients.circuitBreakerEnabled = v),
        info: {
          what: 'The client-side circuit breaker toward the fabric.',
          how: 'On → sustained failures open the breaker (per the trip ratio) and the client fast-fails locally instead of opening more connections, cutting the retry and handshake load it contributes. Off → the client keeps trying regardless.',
          expect: 'On caps the load a failing client adds and helps the fabric drain. Off lets a struggling client pour reconnects and retries into the storm unchecked.',
        },
      },
    ],
  },
  {
    name: 'RTB Fabric',
    scope: 'sim',
    knobs: [
      {
        label: 'Connection limit', min: 8, max: 500, step: 4, get: (c) => c.fabric.maxConnections, set: (c, v) => (c.fabric.maxConnections = v),
        info: {
          what: 'Hard cap on concurrent client-facing connections.',
          how: 'On accept, if held connections are already at the limit the connection is shed with an RST (shed·conn) before any TLS work. The client learns one hop later and backs off briefly.',
          expect: 'A generous limit admits more connections but lets a handshake flood reach the CPU. A tight limit sheds early and cheaply (pre-crypto) — protective, but set too low it rejects healthy traffic. Sheds show as hollow triangles in the graveyard.',
        },
      },
      {
        label: 'TLS permits', min: 1, max: 128, step: 1, get: (c) => c.fabric.tlsHandshakeConcurrency, set: (c, v) => (c.fabric.tlsHandshakeConcurrency = v),
        info: {
          what: 'How many TLS handshakes the fabric processes concurrently.',
          how: 'There is no TLS queue. With all permits busy, a connection waits up to the permit wait for one to free, then is shed (shed·tls, RST). A permit is held for the whole handshake — crypto plus the wire hellos. Sized to what the CPU can finish before clients hang up.',
          expect: 'Too few and connections are shed under churn even with CPU to spare. Too many and a handshake flood hits the shared CPU at once (each ~25× a request), saturating it and stretching everything — the amplifier that turns churn into a storm.',
        },
      },
      {
        label: 'TLS permit wait', min: 0, max: 5, step: 0.25, get: (c) => c.fabric.tlsPermitWaitMs, set: (c, v) => (c.fabric.tlsPermitWaitMs = v), format: msFine,
        info: {
          what: 'How long a connection waits for a free permit before being shed.',
          how: 'With no permit available the connection waits this long; if none frees in time it is shed with an RST. 0 = shed immediately. There is no queue, only this bounded wait. Typical 0–5ms.',
          expect: 'A longer wait converts sheds into completed handshakes when permits free quickly, but holds connections (and client deadlines) longer. With many permits, a long wait lets a backlog of handshakes accumulate and pile onto the CPU.',
        },
      },
      {
        label: 'TLS resumption', min: 0, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionRate, set: (c, v) => (c.fabric.tlsResumptionRate = v), format: (v) => `${Math.round(v * 100)}%`,
        info: {
          what: 'Fraction of handshakes that use TLS session resumption.',
          how: 'Each handshake is independently resumed with this probability. A resumed handshake skips the expensive asymmetric crypto — costing the resumed-cost fraction of a full handshake in both CPU and time — and saves one hello round trip.',
          expect: 'Higher resumption makes reconnects dramatically cheaper, so a churn event costs far less CPU and is far less likely to storm. This is the single biggest lever on handshake cost; resumed handshakes appear in Run totals.',
        },
      },
      {
        label: 'Resumed cost (vs full)', min: 0.1, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionCostFactor, set: (c, v) => (c.fabric.tlsResumptionCostFactor = v), format: (v) => `${Math.round(v * 100)}%`,
        info: {
          what: 'A resumed handshake’s cost as a fraction of a full one (time and CPU).',
          how: 'Multiplies both the fabric CPU work and the crypto time of any resumed handshake. 40% means a resumed handshake costs 40% of a full one.',
          expect: 'A lower factor makes resumption save more, so the resumption rate matters more. At 100% resumption saves no CPU and only the saved round trip remains.',
        },
      },
      {
        label: 'TLS CPU time', min: 5, max: 100, step: 5, get: (c) => c.fabric.tlsHandshakeCpuMs, set: (c, v) => (c.fabric.tlsHandshakeCpuMs = v), format: ms,
        info: {
          what: 'Fabric CPU processing time for one full handshake at idle.',
          how: 'This is the crypto work that loads the shared CPU; under contention it stretches by the slowdown factor. It excludes the wire hellos (those come from RTT + client TLS delay and burn no CPU). Paired with TLS CPU cost as the work-units it demands.',
          expect: 'Higher and each handshake occupies the CPU longer, so a permitted handshake burst saturates sooner and stretches every concurrent request more.',
        },
      },
      {
        label: 'TLS CPU cost', min: 5, max: 200, step: 5, get: (c) => c.fabric.tlsCpuCost, set: (c, v) => (c.fabric.tlsCpuCost = v), format: (v) => `${v}u`,
        info: {
          what: 'CPU work-units one full handshake consumes, versus ~processing-time units for a request.',
          how: 'In the processor-sharing model, demand = Σ work-rates; a handshake demands this many units while a warm request demands ~processing time. The preset ratio is ~25× (measured 15–70×). It also scales outbound fabric→downstream connects (at half).',
          expect: 'Raising it widens the gap between a handshake and a proxied request, so fewer simultaneous handshakes saturate the CPU. This ratio is the core reason connection churn is so much costlier than serving traffic.',
        },
      },
      {
        label: 'Processing time', min: 1, max: 10, step: 0.5, get: (c) => c.fabric.processingMs, set: (c, v) => (c.fabric.processingMs = v), format: ms,
        info: {
          what: 'Nominal fabric processing time per request at idle.',
          how: 'Each request demands ~1 work-unit per ms of processing on the shared CPU, stretched under contention. It is the cheap end of the CPU model that handshakes are measured against.',
          expect: 'Higher per-request processing raises baseline CPU load and shrinks the headroom available to absorb a handshake burst before saturation.',
        },
      },
      {
        label: 'CPU capacity', min: 500, max: 12000, step: 250, kind: 'structure', get: (c) => c.fabric.cpuCapacity, set: (c, v) => (c.fabric.cpuCapacity = v), format: (v) => `${(v / 1000).toFixed(1)}ku/s`,
        info: {
          what: 'Total fabric CPU work-units per second, shared by requests and handshakes.',
          how: 'Processor sharing: when demanded work-rate exceeds capacity, every in-flight operation slows proportionally (utilization >1 → ×slow on everything). This coupling is what turns a handshake burst into system-wide latency. Applied live.',
          expect: 'More capacity means more headroom before saturation and a higher tolerated handshake rate without storming. Too little and even modest churn pushes utilization past 100%, stretching all service times and feeding more timeouts.',
        },
      },
      {
        label: 'TLS error pacing delay', min: 0, max: 100, step: 0.25, get: (c) => c.fabric.tlsErrorPacingDelayMs, set: (c, v) => (c.fabric.tlsErrorPacingDelayMs = v), format: msFine,
        info: {
          what: 'How long the fabric holds the RST when shedding a connection at TLS admission.',
          how: 'With pacing on, a shed connection’s RST is delayed by this much before the client is told, so a cohort of shed clients does not all learn — and reconnect — at the same instant. Typical 0–5ms; the range runs to 100ms to expose the long-hold tradeoff. No effect when the pacing toggle is off.',
          expect: 'A small delay de-synchronizes reconnect waves, smoothing the load of clients retrying after a shed. But the held connection stays live for the whole delay and carries a trickle of CPU — negligible when short, but a long delay under a heavy shed keeps many connections open at once and adds real load. Set to 0 (or pacing off) and shed clients rebound in lockstep.',
        },
      },
      {
        label: 'Accept rate limit', min: 5, max: 200, step: 5, get: (c) => c.fabric.connRateLimitPerSec, set: (c, v) => (c.fabric.connRateLimitPerSec = v), format: (v) => `${v}/s`,
        info: {
          what: 'Sustained new-connection accept rate per fabric server, when accept-rate shedding is on.',
          how: 'A per-server, in-memory token bucket refills at this rate; each accepted connection spends a token. When it runs dry, new connections are rejected at TCP accept (RST) before any TLS work. No effect when the toggle is off. At this demo scale the healthy accept rate is ~12/s (≈20/s under a pulse) and a storm floods accept at 200–350/s, so a limit around 40/s sits between the two.',
          expect: 'Set it above the real new-connection rate and a storm’s reconnect flood is bounced at the door — handshake demand is capped at the source, so the CPU never melts. Set it below the working rate and you throttle legitimate traffic.',
        },
      },
      {
        label: 'Accept burst', min: 1, max: 100, step: 1, get: (c) => c.fabric.connRateBurst, set: (c, v) => (c.fabric.connRateBurst = v), format: (v) => `${v}`,
        info: {
          what: 'Token-bucket burst capacity: how many new connections are absorbed at once before the rate limit throttles.',
          how: 'The bucket holds at most this many tokens, so a momentary spike up to this size passes untouched; only a sustained rate above the limit drains it and triggers shedding. No effect when the toggle is off.',
          expect: 'Larger burst tolerates brief reconnect bunches (warm-up, a short blip) without shedding; smaller burst clamps sooner and harder. Too large and a real storm slips through before throttling engages.',
        },
      },
      {
        label: 'Representative QPS', min: 10_000, max: 1_000_000, step: 10_000, get: (c) => c.fabric.lockRepThroughputQps, set: (c, v) => (c.fabric.lockRepThroughputQps = v), format: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M/s` : `${Math.round(v / 1000)}k/s`),
        info: {
          what: 'The real per-server request throughput this demo stands in for — only used to scale lock contention (see Locks below).',
          how: 'A µs-scale lock is invisible at the demo’s actual event rate, so lock pressure is scaled up to this QPS. A request-site lock’s utilization works out to (this QPS × its hold time); raising offered load or a pulse scales it further. Has no effect unless at least one lock is enabled.',
          expect: 'This is the “vertical scale” dial: raise it and a fixed-hold lock climbs toward 100% utilization and its wait time explodes, while the CPU stays flat. Drop it and the same lock becomes negligible.',
        },
      },
    ],
    toggles: [
      {
        label: 'TLS error pacing', get: (c) => c.fabric.tlsErrorPacingEnabled, set: (c, v) => (c.fabric.tlsErrorPacingEnabled = v),
        info: {
          what: 'Whether shed RSTs at TLS admission are paced.',
          how: 'On → each shed RST is held for the pacing delay above. Off → sheds are signaled immediately, so all clients shed in the same instant reconnect together.',
          expect: 'On breaks up synchronized reconnect storms after a shedding episode. Off lets sheds become their own thundering herd.',
        },
      },
      {
        label: 'Accept-rate shedding', get: (c) => c.fabric.connRateShedEnabled, set: (c, v) => (c.fabric.connRateShedEnabled = v),
        info: {
          what: 'Whether the fabric sheds new connections by rate at TCP accept, before any TLS work.',
          how: 'On → a per-server token bucket (accept rate limit + burst above) bounces new connections with an RST once their rate exceeds the limit, before the connection-limit check and before any handshake. Off → every connection reaches the connection-limit and TLS-permit checks as usual.',
          expect: 'Unlike the static connection limit (a cap on concurrent connections) or the TLS permit cap (a cap on concurrent handshakes), this caps the rate of new connections — throttling handshake demand at the source. It is the cheapest rejection and the most direct defense against a connection storm. Turn it on over Storm-prone and watch the collapse not happen.',
        },
      },
    ],
  },
  {
    name: 'Downstream pools',
    scope: 'sim',
    knobs: [
      {
        label: 'Pool / downstream', min: 1, max: 30, step: 1, get: (c) => c.downstreamPool.poolSizePerDownstream, set: (c, v) => (c.downstreamPool.poolSizePerDownstream = v),
        info: {
          what: 'Connections the fabric holds to each downstream.',
          how: 'A routed request uses an idle downstream connection or opens one (up to this size); otherwise it waits in that downstream’s time-bounded queue. Pre-warmed at start. Opening an outbound connection also draws some fabric CPU.',
          expect: 'Larger pools absorb more concurrency per downstream before queueing. Too small and requests queue and expire on the downstream timeout even when the downstream itself is healthy.',
        },
      },
      {
        label: 'Downstream timeout', min: 50, max: 1000, step: 10, get: (c) => c.downstreamPool.requestTimeoutMs, set: (c, v) => (c.downstreamPool.requestTimeoutMs = v), format: ms,
        info: {
          what: 'How long after routing the fabric waits for a downstream call.',
          how: 'One budget covers queue wait + wire + service. A request that sat in the queue forwards with only its remaining budget; if it expires, the fabric returns an error and poisons (tears down) the outbound connection. Requests found dead on dequeue are dropped — why queues must be time-bounded.',
          expect: 'Tight timeouts free the fabric from slow downstreams fast but error out tail-latency requests. Loose timeouts wait through tails at the cost of holding pool slots and queue depth longer.',
        },
      },
      {
        label: 'Connect time', min: 5, max: 100, step: 5, get: (c) => c.downstreamPool.connectMs, set: (c, v) => (c.downstreamPool.connectMs = v), format: ms,
        info: {
          what: 'Time to establish a fabric→downstream connection.',
          how: 'Charged when opening a new outbound connection (it also draws some fabric CPU). Until it completes, requests needing that connection wait in the queue.',
          expect: 'Slower connects make pool growth lag demand, so bursts queue longer before new connections come online. Negligible once the pool is warm.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Downstreams',
    scope: 'sim',
    knobs: [
      {
        label: 'Downstreams', min: 1, max: 6, step: 1, kind: 'structure', get: (c) => c.downstreams.count, set: (c, v) => (c.downstreams.count = v),
        info: {
          what: 'Number of downstream systems behind the fabric.',
          how: 'Each request is routed to a random healthy downstream. Total downstream capacity = count × concurrency cap. Applied live (adds or removes nodes; removing one drains its queue).',
          expect: 'More downstreams give more aggregate concurrency and resilience (losing one matters less). Fewer concentrates load, so each saturates sooner and its latency inflates.',
        },
      },
      {
        label: 'Response median', min: 10, max: 500, step: 5, get: (c) => c.downstreams.responseTimeMedianMs, set: (c, v) => (c.downstreams.responseTimeMedianMs = v), format: ms,
        info: {
          what: 'Median downstream service time (log-normal).',
          how: 'Each response samples a log-normal around this median; the tail is set by the p99 ÷ p50 knob. Service time also inflates by the downstream’s load factor once it is past its concurrency cap.',
          expect: 'Slower downstreams push end-to-end latency toward the client timeout — fewer requests beat the deadline, more time out (and poison connections). Drives how much pool and timeout headroom you need.',
        },
      },
      {
        label: 'Tail (p99 ÷ p50)',
        min: 1.2,
        max: 10,
        step: 0.1,
        get: (c) => Math.exp(SIGMA_Z99 * c.downstreams.responseTimeSigma),
        set: (c, v) => (c.downstreams.responseTimeSigma = Math.log(v) / SIGMA_Z99),
        format: (v) => `${v.toFixed(1)}×`,
        info: {
          what: 'How heavy the downstream latency tail is — p99 as a multiple of the median.',
          how: 'Sets the log-normal sigma (the knob shows p99 ÷ p50; sigma = ln(ratio) ÷ 2.3263). Samples are clamped to 25× the median. A fat tail means occasional very slow responses even when the median is fine.',
          expect: 'A heavier tail puts more requests randomly brushing or blowing the client timeout, so timeouts and the connection churn they cause rise even at a healthy median.',
        },
      },
      {
        label: 'Error rate', min: 0, max: 0.5, step: 0.005, get: (c) => c.downstreams.errorRate, set: (c, v) => (c.downstreams.errorRate = v), format: (v) => `${(v * 100).toFixed(1)}%`,
        info: {
          what: 'Probability a downstream returns an error instead of a success.',
          how: 'Sampled per request; errors return faster than successes (half the sampled time). An error is returned to the client (square glyph), distinct from a timeout — it does not poison the connection.',
          expect: 'A higher error rate lowers success directly and drives more retries. The fabric does not eject erroring downstreams, so a bad node keeps taking its share of traffic. Errors are cheaper than timeouts but still feed amplification.',
        },
      },
      {
        label: 'Concurrency cap', min: 1, max: 100, step: 1, get: (c) => c.downstreams.concurrencyCapacity, set: (c, v) => (c.downstreams.concurrencyCapacity = v),
        info: {
          what: 'Concurrent requests one downstream absorbs before its latency inflates.',
          how: 'Load factor = max(1, in-flight ÷ cap); service time is multiplied by it, so past the cap every in-flight request slows proportionally — the downstream’s own processor-sharing.',
          expect: 'A low cap makes a downstream’s latency balloon under load, cascading into fabric queueing and client timeouts. A high cap keeps response times flat until much higher concurrency.',
        },
      },
    ],
    toggles: [],
  },
];

type Totals = Simulation['metrics']['totals'];

const TOTAL_METRICS: Array<{ key: string; color: string; value(t: Totals): string }> = [
  { key: 'success', color: 'var(--ok)', value: (t) => `${(t.arrivals > 0 ? (t.successes / t.arrivals) * 100 : 100).toFixed(1)}%` },
  { key: 'ok', color: 'var(--ok)', value: (t) => fmtCount(t.successes) },
  { key: 'timeout', color: 'var(--bad)', value: (t) => fmtCount(t.timeouts) },
  { key: 'error', color: 'var(--err)', value: (t) => fmtCount(t.errors) },
  { key: 'shed·tls', color: 'var(--warn)', value: (t) => fmtCount(t.shedTls) },
  { key: 'shed·conn', color: 'var(--warn)', value: (t) => fmtCount(t.shedConnLimit) },
  { key: 'retries', color: 'var(--retry)', value: (t) => fmtCount(t.retries) },
  { key: 'resumed TLS', color: 'var(--tls)', value: (t) => fmtCount(t.resumedHandshakes) },
  { key: 'wasted TLS', color: 'var(--bad)', value: (t) => fmtCount(t.wastedHandshakes) },
];

export class ControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private locksListEl!: HTMLElement;
  private lastTotalsHtml = '';
  /** Lifetime-event counters, one per pane. */
  private renderedEvents: number[] = [];
  private pulseFactor = 2;
  private pulseDurationMs = 5000;
  private pauseBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private paneTabBtns: HTMLButtonElement[] = [];
  /** Which pane the 'sim'-scoped knobs edit in comparison mode. */
  private activePane = 0;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: ControlHooks;

  constructor(side: HTMLElement, header: HTMLElement, hooks: ControlHooks) {
    this.side = side;
    this.header = header;
    this.hooks = hooks;
    this.buildHeaderControls();
    this.buildPresets();
    this.buildKnobs();
    this.buildTotals();
    this.buildEventLog();
  }

  // -- Header: pulse + time --------------------------------------------------

  private buildHeaderControls(): void {
    const wrap = el('div', 'time-controls');

    const pulseBtn = el('button', 'btn btn-pulse', '◉ PULSE ×2');
    pulseBtn.title = 'Inject a traffic surge (×factor for the set duration; hits every sim)';
    pulseBtn.addEventListener('click', () => this.hooks.pulse(this.pulseFactor, this.pulseDurationMs));
    wrap.appendChild(pulseBtn);

    const pulseFactor = this.miniSlider(1.1, 4, 0.1, this.pulseFactor, (v) => {
      this.pulseFactor = v;
      pulseBtn.textContent = `◉ PULSE ×${v}`;
    });
    pulseFactor.title = 'Pulse intensity';
    wrap.appendChild(pulseFactor);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        this.hooks.setPaused(!this.hooks.isPaused());
      }
    });
    wrap.appendChild(this.pauseBtn);

    // Speed: log slider mapping [0 .. 1] → 0.01x .. 2x sim-speed
    const speedWrap = el('div', 'speed-wrap');
    const speedLabel = el('span', 'speed-label');
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '1';
    speed.step = '0.005';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(0.01), Math.log10(2), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(0.01)) / (Math.log10(2) - Math.log10(0.01));
    const syncSpeedLabel = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 0.99 ? `${s.toFixed(1)}× speed` : `${(1 / s).toFixed(0)}× slower`;
    };
    speed.value = String(fromScale(this.hooks.getTimeScale()));
    speed.addEventListener('input', () => {
      this.hooks.setTimeScale(toScale(parseFloat(speed.value)));
      syncSpeedLabel();
    });
    syncSpeedLabel();
    speedWrap.appendChild(speed);
    speedWrap.appendChild(speedLabel);
    wrap.appendChild(speedWrap);

    const resetBtn = el('button', 'btn', '↺ RESET');
    resetBtn.title = 'Restart the simulation with the current settings';
    resetBtn.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(resetBtn);

    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.title = 'Run two simulations side by side under the same client traffic';
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);

    new Legend(wrap);

    this.header.appendChild(wrap);
  }

  private miniSlider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mini';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => onInput(parseFloat(input.value)));
    return input;
  }

  // -- Presets ------------------------------------------------------------------

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));

    // Single mode: full preset cards swap the whole config.
    const grid = el('div', 'preset-grid single-only');
    for (const preset of PRESETS) {
      const card = el('button', 'preset-card');
      card.dataset.preset = preset.id;
      card.appendChild(el('div', 'preset-name', preset.name));
      card.appendChild(el('div', 'preset-desc', preset.description));
      card.addEventListener('click', () => {
        this.hooks.loadPreset(preset.id);
        this.setActivePreset(preset.id);
        this.refreshKnobs();
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);

    // Comparison mode: one compact scenario row per pane.
    const cmp = el('div', 'compare-only');
    PANE_TAGS.forEach((tag, pane) => {
      const row = el('div', 'scenario-row');
      row.appendChild(el('span', `scenario-tag tag-${tag.toLowerCase()}`, `SIM ${tag}`));
      const btns = el('div', 'scenario-btns');
      for (const preset of PRESETS) {
        const b = el('button', 'preset-mini', preset.name);
        b.dataset.preset = preset.id;
        b.dataset.pane = String(pane);
        b.title = preset.description;
        b.addEventListener('click', () => {
          this.hooks.applyScenario(pane, preset.id);
          this.setActiveScenario(pane, preset.id);
        });
        btns.appendChild(b);
      }
      row.appendChild(btns);
      cmp.appendChild(row);
    });
    cmp.appendChild(
      el('div', 'scenario-note', 'A scenario sets that sim’s client, fabric & downstream tuning; the traffic shape (clients × rate) applies to both sims.'),
    );
    const helpBtn = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS');
    helpBtn.addEventListener('click', () => this.hooks.showCompareHelp());
    cmp.appendChild(helpBtn);
    section.appendChild(cmp);

    this.side.appendChild(section);
    this.setActivePreset(PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.preset === id);
    });
  }

  private setActiveScenario(pane: number, id: string | null): void {
    this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === id);
    });
  }

  // -- Knobs --------------------------------------------------------------------

  /** The config a knob of the given scope currently reads/writes. */
  private cfgFor(scope: KnobScope): SimulationConfig {
    const sims = this.hooks.getSims();
    const idx = scope === 'sim' ? Math.min(this.activePane, sims.length - 1) : 0;
    return sims[idx].cfg;
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    for (const group of GROUPS) {
      // The first per-sim group is preceded by the A/B target tabs.
      if (group.scope === 'sim' && this.paneTabBtns.length === 0) {
        section.appendChild(this.buildPaneTabs());
      }
      const details = document.createElement('details');
      details.className = 'knob-group';
      if (group.name === 'RTB Fabric') details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      details.appendChild(summary);

      for (const toggle of group.toggles) {
        const row = el('label', 'toggle-row');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const sync = () => (input.checked = toggle.get(this.cfgFor(group.scope)));
        sync();
        input.addEventListener('change', () => {
          this.applyToggle(group.scope, toggle, input.checked);
        });
        this.refreshers.push(sync);
        row.appendChild(input);
        row.appendChild(el('span', 'toggle-label', toggle.label));
        const info = toggle.info ? this.buildInfo(toggle.info) : null;
        if (info) row.appendChild(info.btn);
        details.appendChild(row);
        if (info) details.appendChild(info.panel);
      }

      for (const knob of group.knobs) {
        const row = el('div', 'knob-row');
        const labelEl = el('div', 'knob-label', knob.label);
        const valueEl = el('div', 'knob-value');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(knob.min);
        input.max = String(knob.max);
        input.step = String(knob.step);
        const fmt = knob.format ?? ((v: number) => String(Math.round(v * 100) / 100));
        const sync = () => {
          const v = knob.get(this.cfgFor(group.scope));
          input.value = String(v);
          valueEl.textContent = fmt(v);
        };
        sync();
        input.addEventListener('input', () => {
          this.applyKnob(group.scope, knob, parseFloat(input.value));
          valueEl.textContent = fmt(knob.get(this.cfgFor(group.scope)));
        });
        this.refreshers.push(sync);
        const top = el('div', 'knob-top');
        top.appendChild(labelEl);
        const meta = el('div', 'knob-meta');
        meta.appendChild(valueEl);
        const info = knob.info ? this.buildInfo(knob.info) : null;
        if (info) meta.appendChild(info.btn);
        top.appendChild(meta);
        row.appendChild(top);
        row.appendChild(input);
        if (info) row.appendChild(info.panel);
        details.appendChild(row);
      }
      section.appendChild(details);
    }
    this.buildLocksGroup(section);
    this.side.appendChild(section);
  }

  /**
   * The Locks group: a dynamic list of serialization points. Unlike the fixed
   * knob groups, locks can be added and removed, so the list DOM is rebuilt
   * from the active pane's config whenever it changes (and on preset / pane
   * switches, via the refresher — which never fires mid-keystroke).
   */
  private buildLocksGroup(section: HTMLElement): void {
    const details = document.createElement('details');
    details.className = 'knob-group';
    const summary = document.createElement('summary');
    summary.textContent = 'Locks (contention)';
    details.appendChild(summary);
    details.appendChild(
      el(
        'p',
        'locks-intro',
        'Serialization points (mutexes / Arc<Mutex>) the fabric holds around shared state. Each adds wait — not CPU. Hold time is per-acquisition microseconds, scaled by Representative QPS above.',
      ),
    );
    this.locksListEl = el('div', 'locks-list');
    details.appendChild(this.locksListEl);
    const addBtn = el('button', 'btn add-lock', '＋ add lock') as HTMLButtonElement;
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => this.addLock());
    details.appendChild(addBtn);
    this.refreshers.push(() => this.rebuildLockList());
    this.rebuildLockList();
    section.appendChild(details);
  }

  private rebuildLockList(): void {
    const list = this.locksListEl;
    list.replaceChildren();
    const locks = this.cfgFor('sim').fabric.locks;
    if (locks.length === 0) {
      list.appendChild(el('p', 'locks-empty', 'No locks. Add one to model a mutex bottleneck.'));
      return;
    }
    locks.forEach((lock, i) => list.appendChild(this.buildLockRow(lock, i)));
  }

  private buildLockRow(lock: LockConfig, index: number): HTMLElement {
    const row = el('div', 'lock-row');

    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.className = 'lock-enable';
    enable.checked = lock.enabled;
    enable.title = 'Enable this lock';
    enable.addEventListener('change', () => this.editLock(index, (l) => (l.enabled = enable.checked)));
    row.appendChild(enable);

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'lock-name';
    name.value = lock.name;
    name.spellcheck = false;
    name.addEventListener('input', () => this.editLock(index, (l) => (l.name = name.value)));
    row.appendChild(name);

    const site = document.createElement('select');
    site.className = 'lock-site';
    site.title = 'Where the lock is taken';
    for (const s of LOCK_SITES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === lock.site) opt.selected = true;
      site.appendChild(opt);
    }
    site.addEventListener('change', () => this.editLock(index, (l) => (l.site = site.value as LockSite)));
    row.appendChild(site);

    const holdWrap = el('label', 'lock-hold-wrap');
    const hold = document.createElement('input');
    hold.type = 'number';
    hold.className = 'lock-hold';
    hold.min = '0.1';
    hold.max = '1000';
    hold.step = '0.1';
    hold.value = String(lock.holdTimeUs);
    hold.title = 'Hold time per acquisition (microseconds)';
    hold.addEventListener('input', () => {
      const v = parseFloat(hold.value);
      if (Number.isFinite(v) && v > 0) this.editLock(index, (l) => (l.holdTimeUs = v));
    });
    holdWrap.appendChild(hold);
    holdWrap.appendChild(el('span', 'lock-unit', 'µs'));
    row.appendChild(holdWrap);

    const remove = el('button', 'lock-remove', '✕') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = 'Remove lock';
    remove.addEventListener('click', () => this.removeLock(index));
    row.appendChild(remove);

    return row;
  }

  /** Locks edit the active pane only (sim scope), like client-behavior knobs. */
  private activeLocks(): { locks: LockConfig[]; target: number } | null {
    const sims = this.hooks.getSims();
    if (sims.length === 0) return null;
    const target = Math.min(this.activePane, sims.length - 1);
    return { locks: sims[target].cfg.fabric.locks, target };
  }

  private editLock(index: number, mutate: (l: LockConfig) => void): void {
    const ctx = this.activeLocks();
    if (!ctx || !ctx.locks[index]) return;
    mutate(ctx.locks[index]);
    this.hooks.configChanged('plain', ctx.target);
    this.markCustom('sim');
  }

  private addLock(): void {
    const ctx = this.activeLocks();
    if (!ctx) return;
    lockSeq += 1;
    ctx.locks.push({
      id: `lock-${lockSeq}`,
      name: `lock ${ctx.locks.length + 1}`,
      site: 'request',
      holdTimeUs: 2,
      enabled: true,
    });
    this.hooks.configChanged('plain', ctx.target);
    this.markCustom('sim');
    this.rebuildLockList();
  }

  private removeLock(index: number): void {
    const ctx = this.activeLocks();
    if (!ctx || index < 0 || index >= ctx.locks.length) return;
    ctx.locks.splice(index, 1);
    this.hooks.configChanged('plain', ctx.target);
    this.markCustom('sim');
    this.rebuildLockList();
  }

  /**
   * The ⓘ affordance for one setting: a button plus a collapsible detail panel.
   * The caller appends the button into the row and the panel just after it; the
   * button toggles the panel open. preventDefault/stopPropagation keep a click
   * inside a toggle's <label> from flipping the checkbox.
   */
  private buildInfo(info: SettingInfo): { btn: HTMLButtonElement; panel: HTMLElement } {
    const btn = el('button', 'info-btn', 'ⓘ') as HTMLButtonElement;
    btn.type = 'button';
    btn.title = 'What this setting does';
    btn.setAttribute('aria-label', 'Explain this setting');
    const panel = el('div', 'setting-info');
    const parts: Array<[string, string]> = [
      ['What', info.what],
      ['How', info.how],
      ['Expect', info.expect],
    ];
    for (const [tag, text] of parts) {
      const p = el('p', '');
      p.appendChild(el('b', '', tag));
      p.appendChild(document.createTextNode(` ${text}`));
      panel.appendChild(p);
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      btn.classList.toggle('active', open);
    });
    return { btn, panel };
  }

  private buildPaneTabs(): HTMLElement {
    const tabs = el('div', 'pane-tabs compare-only');
    tabs.appendChild(el('span', 'pane-tabs-label', 'These knobs edit'));
    PANE_TAGS.forEach((tag, i) => {
      const b = el('button', `pane-tab tag-${tag.toLowerCase()}`, `SIM ${tag}`) as HTMLButtonElement;
      b.addEventListener('click', () => {
        this.activePane = i;
        this.syncPaneTabs();
        this.refreshKnobs();
      });
      this.paneTabBtns.push(b);
      tabs.appendChild(b);
    });
    this.syncPaneTabs();
    return tabs;
  }

  private syncPaneTabs(): void {
    this.paneTabBtns.forEach((b, i) => b.classList.toggle('active', i === this.activePane));
  }

  private applyKnob(scope: KnobScope, knob: KnobDef, v: number): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) knob.set(sim.cfg, v);
      this.hooks.configChanged(knob.kind ?? 'plain', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      knob.set(sims[idx].cfg, v);
      this.hooks.configChanged(knob.kind ?? 'plain', idx);
    }
    this.markCustom(scope);
  }

  private applyToggle(scope: KnobScope, toggle: ToggleDef, v: boolean): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) toggle.set(sim.cfg, v);
      this.hooks.configChanged('plain', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      toggle.set(sims[idx].cfg, v);
      this.hooks.configChanged('plain', idx);
    }
    this.markCustom(scope);
  }

  private markCustom(scope: KnobScope): void {
    if (!this.hooks.isCompare()) {
      this.setActivePreset(null);
      return;
    }
    if (scope === 'global') {
      this.setActiveScenario(0, null);
      this.setActiveScenario(1, null);
    } else {
      this.setActiveScenario(this.activePane, null);
    }
  }

  refreshKnobs(): void {
    for (const r of this.refreshers) r();
  }

  /** Mode switched by the app: sync the toggle button and per-sim state. */
  setCompareUI(on: boolean): void {
    this.compareBtn.classList.toggle('active', on);
    this.activePane = 0;
    this.syncPaneTabs();
    this.setActiveScenario(0, null);
    this.setActiveScenario(1, null);
    if (!on) this.setActivePreset(null);
    this.lastTotalsHtml = '';
    this.refreshKnobs();
  }

  // -- Totals & event log ----------------------------------------------------------

  private buildTotals(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Run totals'));
    this.totalsEl = el('div', 'totals-grid');
    section.appendChild(this.totalsEl);
    this.side.appendChild(section);
  }

  private buildEventLog(): void {
    const section = el('div', 'panel-section eventlog-section');
    section.appendChild(el('h2', 'panel-title', 'Events'));
    this.logList = el('div', 'eventlog');
    section.appendChild(this.logList);
    this.side.appendChild(section);
  }

  /** Called every frame (cheap: only touches DOM on change). */
  update(): void {
    const glyph = this.hooks.isPaused() ? '▶' : '⏸';
    if (this.pauseBtn.textContent !== glyph) {
      this.pauseBtn.textContent = glyph;
      this.pauseBtn.classList.toggle('active', this.hooks.isPaused());
    }
    const sims = this.hooks.getSims();
    const compare = sims.length > 1;
    const html = compare ? totalsHtmlCompare(sims) : totalsHtmlSingle(sims[0]);
    if (this.lastTotalsHtml !== html) {
      this.lastTotalsHtml = html;
      this.totalsEl.className = compare ? 'totals-cmp' : 'totals-grid';
      this.totalsEl.innerHTML = html;
    }

    // The engine caps events[] at 200 entries, so track the lifetime count
    // per pane and render the newest unseen entries from the tail.
    sims.forEach((sim, pane) => {
      const { events, totalLogged } = sim.metrics;
      const seen = this.renderedEvents[pane] ?? 0;
      if (totalLogged < seen) this.renderedEvents[pane] = 0;
      const unseen = Math.min(totalLogged - (this.renderedEvents[pane] ?? 0), events.length);
      for (let i = events.length - unseen; i < events.length; i++) {
        const ev = events[i];
        const row = el('div', `event event-${ev.severity}`);
        if (compare) row.appendChild(el('span', `event-tag tag-${PANE_TAGS[pane].toLowerCase()}`, PANE_TAGS[pane]));
        row.appendChild(el('span', 'event-time', `${(ev.time / 1000).toFixed(1)}s`));
        row.appendChild(el('span', 'event-msg', ev.message));
        this.logList.prepend(row);
        while (this.logList.children.length > 60) this.logList.lastChild?.remove();
      }
      this.renderedEvents[pane] = totalLogged;
    });
  }

  resetLog(): void {
    this.renderedEvents = [];
    this.logList.innerHTML = '';
  }
}

function totalsHtmlSingle(sim: Simulation): string {
  const t = sim.metrics.totals;
  return TOTAL_METRICS.map(
    (m) => `<div class="total"><span style="color:${m.color}">${m.value(t)}</span><label>${m.key}</label></div>`,
  ).join('');
}

function totalsHtmlCompare(sims: Simulation[]): string {
  const head =
    `<div class="cmp-row cmp-head"><label></label>` +
    sims.map((_, i) => `<span class="tag-${PANE_TAGS[i].toLowerCase()}">SIM ${PANE_TAGS[i]}</span>`).join('') +
    `</div>`;
  const rows = TOTAL_METRICS.map((m) => {
    const cells = sims
      .map((s) => `<span style="color:${m.color}">${m.value(s.metrics.totals)}</span>`)
      .join('');
    return `<div class="cmp-row"><label>${m.key}</label>${cells}</div>`;
  }).join('');
  return head + rows;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtCount(v: number): string {
  if (v >= 100_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
