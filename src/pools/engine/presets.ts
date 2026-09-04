import type { PoolPreset, PoolSimulationConfig } from './types';

/**
 * A deliberately high-cardinality RTB Fabric shape. At 120k req/s the mean
 * concurrency is modest, but 24 nodes x 32 workers x 8 links x 1 endpoint/link
 * x 4 IPs creates
 * 24,576 independently warm HTTP/1 pool keys before load requires that many.
 */
export function basePoolConfig(): PoolSimulationConfig {
  return {
    seed: 1337,
    traffic: {
      requestsPerSec: 120_000,
      responseTimeMs: 20,
      concurrencyHeadroom: 1.25,
      retryFraction: 0.7,
      maxRetries: 2,
    },
    fabric: {
      nodes: 24,
      coresPerNode: 32,
      links: 8,
      endpointsPerLink: 1,
      sharedEndpointsPerLink: 1,
      ipsPerEndpoint: 4,
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
      checkoutRaceFactor: 1.15,
      policy: 'hyper',
      maxConnectionsPerKey: 32,
    },
    responder: {
      instances: 8,
      connectionLimit: 1024,
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
      'Eight Links all reference the same four-IP link endpoint, but current per-worker, per-Link, per-IP HTTP/1 pools cannot share those sockets.',
    config: basePoolConfig(),
  },
  {
    id: 'previous-lb',
    name: 'Previous LB shape',
    description:
      'A small node-shared pool keyed by endpoint IP. Same traffic and responders, much lower pool cardinality—the migration contrast.',
    config: scenario((c) => {
      c.fabric.nodes = 8;
      c.fabric.ownership = 'node';
      c.fabric.keyStrategy = 'endpoint';
      c.pool.minConnectionsPerKey = 0;
      c.pool.checkoutRaceFactor = 1;
    }),
  },
  {
    id: 'scale-out',
    name: 'Scale out ×2',
    description:
      'Forty-eight RTB Fabric nodes split the same offered load. CPU headroom rises, but independent pool copies—and the warm connection floor—double.',
    config: scenario((c) => {
      c.fabric.nodes = 48;
    }),
  },
  {
    id: 'endpoint-shared',
    name: 'Share links',
    description:
      'Pools are keyed by IP + certificate + port across Links. Exact shared link endpoints reuse sockets, while private endpoints stay isolated.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'endpoint';
    }),
  },
  {
    id: 'mixed-endpoints',
    name: 'Mixed Link endpoints',
    description:
      'Each Link references one common customer endpoint and two Link-private endpoints, making partial overlap and the limits of cross-Link sharing visible.',
    config: scenario((c) => {
      c.fabric.endpointsPerLink = 3;
      c.fabric.sharedEndpointsPerLink = 1;
      c.fabric.ipsPerEndpoint = 2;
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
    id: 'bounded-shared',
    name: 'Bounded + shared',
    description:
      'A hypothetical bounded pool, shared across links, with eight active connections per endpoint key and a short idle lifetime.',
    config: scenario((c) => {
      c.fabric.keyStrategy = 'endpoint';
      c.pool.policy = 'bounded';
      c.pool.maxConnectionsPerKey = 8;
      c.pool.maxIdlePerKey = 2;
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
      c.pool.checkoutRaceFactor = 1;
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
