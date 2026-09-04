import type { PoolPreset, PoolSimulationConfig } from './types';

/**
 * A deliberately high-cardinality RTB Fabric shape. At 120k req/s the mean
 * concurrency per key is well under one request, but 2 nodes x 32 workers x
 * 8 links x 8 responder IPs creates 4,096 independently owned HTTP/1 pool
 * keys, and each of them holds the peak concurrency it saw inside the 90 s
 * idle window. Scaling to four nodes doubles that inventory and crosses the
 * responder budget once connection-placement skew is included.
 */
export function basePoolConfig(): PoolSimulationConfig {
  return {
    seed: 1337,
    traffic: {
      requestsPerSec: 120_000,
      responseTimeMs: 20,
      burstiness: 0.15,
      retryFraction: 0.7,
      maxRetries: 2,
    },
    fabric: {
      nodes: 2,
      coresPerNode: 32,
      links: 8,
      uniqueEndpoints: 1,
      ownership: 'worker',
      keyStrategy: 'link-ip',
    },
    pool: {
      protocol: 'http1',
      h2StreamsPerConnection: 100,
      idleTimeoutMs: 90_000,
      maxIdlePerKey: 0,
      minConnectionsPerKey: 1,
      connectTimeMs: 30,
      policy: 'hyper',
      maxConnectionsPerKey: 32,
    },
    responder: {
      instances: 8,
      connectionLimit: 4096,
      connectionSkew: 0.12,
    },
  };
}

function scenario(tune: (c: PoolSimulationConfig) => void): PoolSimulationConfig {
  const c = basePoolConfig();
  tune(c);
  return c;
}

export const POOL_PRESETS: PoolPreset[] = [
  {
    id: 'current',
    name: 'Current RTB shape',
    description:
      'Eight Links all reference the same endpoint and its eight responder IPs, but current per-worker, per-Link, per-IP HTTP/1 pools cannot share those sockets.',
    config: basePoolConfig(),
  },
  {
    id: 'previous-lb',
    name: 'Previous LB shape',
    description:
      'A small node-shared pool keyed by endpoint IP. Same traffic and responders, much lower pool cardinality—the migration contrast.',
    config: scenario((c) => {
      c.fabric.nodes = 2;
      c.fabric.ownership = 'node';
      c.fabric.keyStrategy = 'endpoint';
      c.pool.minConnectionsPerKey = 0;
    }),
  },
  {
    id: 'scale-out',
    name: 'Scale out ×2',
    description:
      'Four RTB Fabric nodes split the same offered load. CPU headroom rises, but independent pool copies—and the peaks each one retains—double.',
    config: scenario((c) => {
      c.fabric.nodes = 4;
    }),
  },
  {
    id: 'endpoint-shared',
    name: 'Share links',
    description:
      'Pools are keyed by IP + certificate + port across Links. Links pointing to the same endpoint reuse sockets; different endpoints stay isolated.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'endpoint';
    }),
  },
  {
    id: 'mixed-endpoints',
    name: 'Partially shared endpoints',
    description:
      'Eight Links are distributed across three endpoint identities. Some Links converge on the same endpoint while others point elsewhere.',
    config: scenario((c) => {
      c.fabric.uniqueEndpoints = 3;
    }),
  },
  {
    id: 'dns-authority',
    name: 'DNS authority',
    description:
      'One authority-keyed pool per unique link endpoint and worker, matching Hyper’s native scheme + authority key shape.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'dns';
    }),
  },
  {
    id: 'short-idle',
    name: 'Short idle timeout',
    description:
      'The current shape with a 5 s pool_idle_timeout instead of 90 s. Each key forgets its concurrency peaks sooner, at the cost of more reconnects.',
    config: scenario((c) => {
      c.pool.idleTimeoutMs = 5_000;
    }),
  },
  {
    id: 'bounded-shared',
    name: 'Bounded + shared',
    description:
      'A hypothetical bounded pool, shared across links, with sixteen active connections per endpoint key and a short idle lifetime.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'endpoint';
      c.pool.policy = 'bounded';
      c.pool.maxConnectionsPerKey = 16;
      c.pool.maxIdlePerKey = 4;
      c.pool.minConnectionsPerKey = 0;
      c.pool.idleTimeoutMs = 15_000;
    }),
  },
  {
    id: 'http2',
    name: 'HTTP/2 multiplexed',
    description:
      'Hypothetical responder HTTP/2 support: up to 100 streams share one authority connection, and Hyper coalesces concurrent H2 establishment per key.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'dns';
      c.pool.protocol = 'http2';
      c.pool.minConnectionsPerKey = 0;
    }),
  },
];

export function poolPresetById(id: string): PoolPreset {
  const preset = POOL_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown connection-pool preset: ${id}`);
  return preset;
}

export function clonePoolConfig(cfg: PoolSimulationConfig): PoolSimulationConfig {
  return structuredClone(cfg);
}
