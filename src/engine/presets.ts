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
 */

import type { Preset, SimulationConfig } from './types';

function base(): SimulationConfig {
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
      tlsErrorPacingEnabled: true,
      tlsErrorPacingDelayMs: 2,
      connRateShedEnabled: false,
      connRateLimitPerSec: 40,
      connRateBurst: 30,
      // Kernel limits, modeled off by default so every preset is behaviorally
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

export const PRESETS: Preset[] = [
  {
    id: 'healthy',
    name: 'Healthy',
    description:
      'Conservative limits, protections on. Connections stay warm, handshakes are rare and mostly resumed. Try a pulse and watch the response.',
    config: base(),
  },
  {
    id: 'storm-prone',
    name: 'Storm-prone',
    description:
      'Raised limits: 16x the TLS permits, the permit wait maxed out, 3 un-jittered retries, pacing off. Stable at baseline — try a traffic pulse and watch what happens after it ends.',
    config: (() => {
      const c = base();
      c.clients.clientTimeoutMs = 250;
      c.clients.poolSize = 12;
      c.clients.maxRetries = 3;
      c.clients.retryJitter = false;
      c.fabric.maxConnections = 300;
      c.fabric.tlsHandshakeConcurrency = 64;
      c.fabric.tlsPermitWaitMs = 5;
      c.fabric.tlsErrorPacingEnabled = false;
      return c;
    })(),
  },
  {
    id: 'protected',
    name: 'Protected',
    description:
      'Identical client settings to Storm-prone (3 un-jittered retries, tight timeouts), with the fabric limits and protections enabled. Compare the two under the same pulse.',
    config: (() => {
      const c = base();
      c.clients.clientTimeoutMs = 250;
      c.clients.poolSize = 12;
      c.clients.maxRetries = 3;
      c.clients.retryJitter = false;
      return c;
    })(),
  },
  {
    id: 'overwhelmed',
    name: 'Overwhelmed',
    description:
      'Offered load beyond capacity, slow erroring downstreams, timeouts tighter than typical latency, no protections. Observe goodput once the system saturates.',
    config: (() => {
      const c = base();
      c.clients.count = 8;
      c.clients.requestRatePerSec = 35;
      c.clients.poolSize = 12;
      c.clients.clientTimeoutMs = 200;
      c.clients.maxRetries = 3;
      c.clients.retryBackoffBaseMs = 20;
      c.clients.retryJitter = false;
      c.fabric.maxConnections = 500;
      c.fabric.tlsHandshakeConcurrency = 128;
      c.fabric.tlsPermitWaitMs = 5;
      c.fabric.tlsErrorPacingEnabled = false;
      c.downstreamPool.poolSizePerDownstream = 12;
      c.downstreamPool.requestTimeoutMs = 180;
      c.downstreams.responseTimeMedianMs = 140;
      c.downstreams.responseTimeSigma = 0.5;
      c.downstreams.errorRate = 0.15;
      return c;
    })(),
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
