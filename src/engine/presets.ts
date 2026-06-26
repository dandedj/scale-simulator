/**
 * Preset configurations.
 *
 * The simulator runs at demo scale (~30x smaller than a production fabric)
 * but preserves the ratios that drive the dynamics, all from measured data:
 *   - TLS full handshake = 25x the CPU of proxying one request over a warm
 *     connection (measured range 15–70x; Tempesta kernel-TLS study).
 *   - Resumed handshakes cost a configurable fraction of a full handshake
 *     (default 40%).
 *   - Client timeout ≈ p99 of end-to-end latency (~1% baseline timeouts —
 *     "p99 brushing the deadline" is normal in RTB).
 *   - Pool size ≈ 2x Little's law (rate x latency).
 *   - TLS permits ≈ what the CPU can finish before clients hang up; waiters
 *     are shed with an RST after the permit wait.
 *
 * Scenarios vary ONLY the RTB Fabric configuration. Every scenario shares one
 * fixed, deliberately aggressive client profile (SCENARIO_CLIENTS) — identical
 * traffic shape and client behavior — so switching scenarios isolates the
 * fabric-side differences. Traffic volume is the operator's to drive, with the
 * Traffic knobs and the pulse button.
 */

import type { Preset, SimulationConfig } from './types';

/**
 * The plain baseline: gentle, well-behaved clients on a modest fabric with
 * every optional protection off. Exported as the canonical substrate the
 * mechanism tests build on; also the starting point each scenario overrides.
 */
export function baseConfig(): SimulationConfig {
  return {
    seed: 1337,
    clients: {
      count: 6,
      requestRatePerSec: 20,
      poolSize: 6,
      rttMs: 24,
      tlsClientDelayMs: 0,
      clientTimeoutMs: 300,
      maxRetries: 1,
      retryBackoffBaseMs: 25,
      retryJitter: true,
      circuitBreakerEnabled: false,
      breakerFailureRatio: 0.5,
      breakerMinSamples: 10,
      breakerCooldownMs: 3000,
    },
    fabric: {
      maxConnections: 96,
      tlsHandshakeConcurrency: 4,
      tlsPermitWaitMs: 2,
      tlsHandshakeCpuMs: 30,
      tlsResumptionRate: 0.7,
      tlsResumptionCostFactor: 0.4,
      processingMs: 4,
      cpuCapacity: 3000,
      tlsCpuCost: 60,
      // TLS error pacing is off by default: pacing de-synchronizes reconnect
      // waves after a TLS shed, but at this demo scale it has little effect on
      // the storm, so it stays an opt-in knob rather than a preset protection.
      // The delay is the value used when the toggle is turned on.
      tlsErrorPacingEnabled: false,
      tlsErrorPacingDelayMs: 2,
      connRateShedEnabled: false,
      connRateLimitPerSec: 40,
      connRateBurst: 30,
      // Kernel limits, modeled off by default so the baseline is behaviorally
      // unchanged. The values are demo-scaled the way the accept-rate limiter is
      // (the demo's pool sizes cap live sockets at ~70–98, far below real Linux
      // numbers): the real somaxconn is 4096 (128 before kernel 5.4) and the
      // RLIMIT_NOFILE soft default is 1024, but here a depth of 32 sits between
      // healthy accept-queue occupancy (~1) and a storm's pile-up (~57), and an
      // FD ceiling of 80 sits between healthy live sockets (~70) and a storm's
      // (~98). So either one bites only when enabled over a raised-limit storm.
      acceptQueueEnabled: false,
      acceptQueueDepth: 32,
      acceptQueueAbortOnOverflow: false,
      fdLimitEnabled: false,
      maxFileDescriptors: 80,
      lockRepThroughputQps: 50_000,
      // Example locks, disabled by default (no effect until enabled): the
      // Arc<Mutex<usize>> max-connections counter, a per-request router lock,
      // and a TLS session-cache lock. Enable one and raise the representative
      // QPS to watch the lock become the bottleneck while CPU stays idle. Hold
      // times are calibrated for Graviton3 (c7g): an uncontended Arc<Mutex>
      // lock+unlock is ~25ns, a coarser/contended lock runs into the µs.
      locks: [
        { id: 'maxconn', name: 'max-conns counter (Arc<Mutex>)', site: 'accept', holdTimeUs: 0.025, enabled: false },
        { id: 'router', name: 'request router state', site: 'request', holdTimeUs: 0.05, enabled: false },
        { id: 'sessioncache', name: 'TLS session cache', site: 'handshake', holdTimeUs: 1, enabled: false },
      ],
    },
    downstreamPool: {
      poolSizePerDownstream: 10,
      requestTimeoutMs: 250,
      connectMs: 25,
    },
    downstreams: {
      count: 3,
      responseTimeMedianMs: 100,
      responseTimeSigma: 0.4,
      errorRate: 0.005,
      concurrencyCapacity: 15,
    },
  };
}

/**
 * The fixed client profile every scenario shares: deliberately aggressive —
 * a generous pool, a tight deadline, three un-jittered retries, no client
 * breaker — so a cohort that times out comes back in a synchronized wall. It
 * is calm at baseline (warm pools, few handshakes) and only bites under a
 * surge, which is exactly what makes the fabric-side differences legible. Held
 * identical across scenarios so the only variable is the fabric.
 */
const SCENARIO_CLIENTS: Partial<SimulationConfig['clients']> = {
  poolSize: 12,
  clientTimeoutMs: 250,
  maxRetries: 3,
  retryJitter: false,
};

/** Build a scenario: the base config with the shared clients, then fabric tuning. */
function scenario(tune: (c: SimulationConfig) => void): SimulationConfig {
  const c = baseConfig();
  Object.assign(c.clients, SCENARIO_CLIENTS);
  tune(c);
  return c;
}

export const PRESETS: Preset[] = [
  {
    id: 'unbounded',
    name: 'Wide open',
    description:
      'Few limits: a high connection cap, 16× the TLS permits, the permit wait maxed out, no rate or kernel limits. Stable at baseline — pulse it and watch the storm persist after the surge ends.',
    config: scenario((c) => {
      c.fabric.maxConnections = 300;
      c.fabric.tlsHandshakeConcurrency = 64;
      c.fabric.tlsPermitWaitMs = 5;
    }),
  },
  {
    id: 'early-shed',
    name: 'Shed early',
    description:
      'Tight connection cap and few TLS permits: the fabric sheds connections cheaply at the door (RST) before the CPU can melt. Pulse it — it stays up by rejecting the flood instead of trying to serve it.',
    config: scenario((c) => {
      c.fabric.maxConnections = 96;
      c.fabric.tlsHandshakeConcurrency = 4;
      c.fabric.tlsPermitWaitMs = 2;
    }),
  },
  {
    id: 'rate-limited',
    name: 'Rate limited',
    description:
      'Loose static caps, but a per-server token bucket throttles the rate of new connections at TCP accept (shed·rate). Pulse it — handshake demand is capped at the source, so the same flood that storms “Wide open” never forms.',
    config: scenario((c) => {
      c.fabric.maxConnections = 300;
      c.fabric.tlsHandshakeConcurrency = 64;
      c.fabric.tlsPermitWaitMs = 5;
      c.fabric.connRateShedEnabled = true;
      c.fabric.connRateLimitPerSec = 40;
      c.fabric.connRateBurst = 30;
    }),
  },
  {
    id: 'kernel-bound',
    name: 'Kernel limited',
    description:
      'High app limits, but the OS limits bite first: a shallow accept queue (somaxconn) and a file-descriptor ceiling. Pulse it — connections drop at the kernel (drop·acceptq, emfile) before they ever reach TLS, a dirtier failure than a clean RST.',
    config: scenario((c) => {
      c.fabric.maxConnections = 300;
      c.fabric.tlsHandshakeConcurrency = 64;
      c.fabric.tlsPermitWaitMs = 5;
      c.fabric.acceptQueueEnabled = true;
      c.fabric.acceptQueueDepth = 16;
      c.fabric.fdLimitEnabled = true;
      c.fabric.maxFileDescriptors = 80;
    }),
  },
  {
    id: 'lock-bound',
    name: 'Lock contention',
    description:
      'A serialization point — a shared mutex on the request path — scaled to a high per-server throughput. The LOCK CONTENTION chart pegs red and latency climbs while the CPU column stays low: the wall is contention, not compute. Holds at this load; pulse it to push the lock past saturation. Uses calmer clients than the other scenarios on purpose, so the bottleneck is the lock itself, not a reconnect storm it would otherwise ignite.',
    config: (() => {
      // Built on the gentle baseline clients (not SCENARIO_CLIENTS): a fully
      // saturated request lock makes requests time out, and un-jittered
      // aggressive retries would turn that into a handshake storm that also pegs
      // the CPU — masking the very lesson (lock-bound, CPU idle). Jittered, few
      // retries keeps the lock the sole, visible wall. The representative QPS is
      // tuned to just past the lock's ceiling so it saturates and inflates
      // latency while leaving compute idle (raising it further would tip into a
      // churn storm that warms the CPU).
      const c = baseConfig();
      const router = c.fabric.locks.find((l) => l.id === 'router')!;
      router.enabled = true;
      router.holdTimeUs = 2;
      c.fabric.lockRepThroughputQps = 400_000;
      return c;
    })(),
  },
  {
    id: 'well-tuned',
    name: 'Well tuned',
    description:
      'Balanced limits, high TLS resumption (cheap reconnects), and an accept-rate backstop. Pulse it — it absorbs the surge with little shedding and recovers fast. The reference: layered, modest protections instead of one big limit.',
    config: scenario((c) => {
      c.fabric.maxConnections = 150;
      c.fabric.tlsHandshakeConcurrency = 16;
      c.fabric.tlsPermitWaitMs = 2;
      c.fabric.tlsResumptionRate = 0.85;
      c.fabric.connRateShedEnabled = true;
      c.fabric.connRateLimitPerSec = 60;
      c.fabric.connRateBurst = 40;
    }),
  },
];

export function presetById(id: string): Preset {
  const p = PRESETS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown preset: ${id}`);
  return p;
}

/** Deep-clone a config so live knob edits never mutate the preset. */
export function cloneConfig(cfg: SimulationConfig): SimulationConfig {
  return structuredClone(cfg);
}
