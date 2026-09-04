import { describe, expect, it } from 'vitest';
import { basePoolConfig, clonePoolConfig, POOL_PRESETS } from './presets';
import { PoolSimulation, SAMPLE_BUDGET } from './poolSimulation';
import type { PoolSimulationConfig } from './types';

/** One key, one owner, one responder: the per-key mechanics in isolation. */
function singleKey(tune: (c: PoolSimulationConfig) => void = () => {}): PoolSimulationConfig {
  const c = basePoolConfig();
  c.fabric.nodes = 1;
  c.fabric.coresPerNode = 1;
  c.fabric.links = 1;
  c.fabric.uniqueEndpoints = 1;
  c.responder.instances = 1;
  c.responder.connectionLimit = 16_384;
  c.responder.connectionSkew = 0;
  c.pool.minConnectionsPerKey = 0;
  c.traffic.burstiness = 0;
  c.traffic.requestsPerSec = 10_000;
  c.traffic.responseTimeMs = 100;
  tune(c);
  return c;
}

/** Time-averaged established sockets over a run, which smooths the traffic wave. */
function meanEstablished(sim: PoolSimulation, ms: number): number {
  const before = sim.metrics.totals.connectionSeconds;
  sim.step(ms);
  return ((sim.metrics.totals.connectionSeconds - before) * 1000) / ms;
}

describe('outbound pool cardinality', () => {
  it('multiplies current pools across nodes, workers, Link endpoints, and IPs', () => {
    const sim = new PoolSimulation(basePoolConfig());
    expect(sim.poolOwners()).toBe(2 * 32);
    expect(sim.logicalKeysPerOwner()).toBe(8 * 8); // 8 Links × 8 responder IPs
    expect(sim.poolKeyCount()).toBe(2 * 32 * 8 * 8);
    expect(sim.desiredConnectionCount()).toBeGreaterThanOrEqual(sim.poolKeyCount());
  });

  it('removes the right multiplier for each alternative key strategy', () => {
    const c = basePoolConfig();
    c.fabric.keyStrategy = 'dns';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(2 * 32);

    c.fabric.keyStrategy = 'endpoint';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(2 * 32 * 8);

    c.fabric.ownership = 'node';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(2 * 8);
  });

  it('shows horizontal and vertical scale multiplying independent pool copies', () => {
    const small = basePoolConfig();
    small.fabric.nodes = 8;
    small.fabric.coresPerNode = 16;
    const large = clonePoolConfig(small);
    large.fabric.nodes = 16;
    large.fabric.coresPerNode = 64;
    expect(new PoolSimulation(large).poolKeyCount()).toBe(new PoolSimulation(small).poolKeyCount() * 8);
  });

  it('starts with two Fabric nodes and doubles to four in the scale-out preset', () => {
    expect(basePoolConfig().fabric.nodes).toBe(2);
    expect(POOL_PRESETS.find((preset) => preset.id === 'scale-out')?.config.fabric.nodes).toBe(4);
  });

  it('simulates every key of a small fleet and a stratified sample of a large one', () => {
    const small = new PoolSimulation(POOL_PRESETS.find((p) => p.id === 'previous-lb')!.config).snapshot();
    expect(small.sampledKeys).toBe(small.poolKeys);
    expect(small.sampled.every((k) => k.weight === 1)).toBe(true);

    const large = new PoolSimulation(basePoolConfig()).snapshot();
    expect(large.sampledKeys).toBe(SAMPLE_BUDGET);
    expect(large.sampled.reduce((sum, k) => sum + k.weight, 0)).toBeCloseTo(large.poolKeys, 6);
    const perIp = new Map<number, number>();
    const perLink = new Map<number, number>();
    for (const k of large.sampled) {
      perIp.set(k.ip, (perIp.get(k.ip) ?? 0) + 1);
      perLink.set(k.link, (perLink.get(k.link) ?? 0) + 1);
    }
    expect(perIp.size).toBe(8);
    expect(perLink.size).toBe(8);
    expect(new Set(perIp.values()).size).toBe(1); // every IP equally represented
    expect(new Set(perLink.values()).size).toBe(1);
  });
});

describe('hyper-util semantics represented by the model', () => {
  it('does not mistake max idle per key for an active connection cap', () => {
    const sim = new PoolSimulation(singleKey((c) => (c.pool.maxIdlePerKey = 1)));
    sim.step(2_000);
    const s = sim.snapshot();
    expect(s.littleLawRequired).toBe(1000);
    expect(s.idle).toBeLessThanOrEqual(1);
    expect(s.established).toBeGreaterThan(900); // busy sockets are untouched by the idle limit
  });

  it('lets a hypothetical bounded library cap active connections per key', () => {
    const sim = new PoolSimulation(singleKey((c) => {
      c.pool.policy = 'bounded';
      c.pool.maxConnectionsPerKey = 64;
    }));
    sim.step(2_000);
    const s = sim.snapshot();
    expect(s.established + s.pending).toBeLessThanOrEqual(64);
    expect(s.allowedConnections).toBe(64);
    expect(s.desiredConnections).toBeGreaterThan(64);
    expect(s.capActive).toBe(true);
  });

  it('uses HTTP/2 stream multiplexing to reduce required connections', () => {
    const h1 = new PoolSimulation(singleKey());
    const h2 = new PoolSimulation(singleKey((c) => {
      c.pool.protocol = 'http2';
      c.pool.h2StreamsPerConnection = 100;
    }));
    h1.step(2_000);
    h2.step(2_000);
    expect(h2.snapshot().established).toBeLessThan(h1.snapshot().established / 10);
  });

  it('retains the peak concurrency a key saw inside the idle window', () => {
    // Mean concurrency of one request, but the pool keeps the peaks it saw.
    const long = new PoolSimulation(singleKey((c) => {
      c.traffic.requestsPerSec = 20;
      c.traffic.responseTimeMs = 50;
      c.pool.idleTimeoutMs = 60_000;
    }));
    const short = new PoolSimulation(singleKey((c) => {
      c.traffic.requestsPerSec = 20;
      c.traffic.responseTimeMs = 50;
      c.pool.idleTimeoutMs = 100;
    }));
    long.step(30_000);
    short.step(30_000);
    expect(long.snapshot().littleLawRequired).toBe(1);
    expect(long.snapshot().established).toBeGreaterThanOrEqual(3);
    expect(short.snapshot().established).toBeLessThan(long.snapshot().established);
    expect(short.metrics.totals.connectionsClosed).toBeGreaterThan(long.metrics.totals.connectionsClosed);
  });

  it('lets a shorter idle timeout hold fewer sockets at the same traffic', () => {
    const long = basePoolConfig();
    long.pool.minConnectionsPerKey = 0;
    const short = clonePoolConfig(long);
    short.pool.idleTimeoutMs = 5_000;
    const a = new PoolSimulation(long);
    const b = new PoolSimulation(short);
    expect(meanEstablished(b, 60_000)).toBeLessThan(meanEstablished(a, 60_000) * 0.85);
  });

  it('starts one HTTP/1 connect per request that finds nothing idle, and one per key for HTTP/2', () => {
    const h1 = new PoolSimulation(singleKey((c) => {
      c.traffic.requestsPerSec = 1_000;
      c.pool.connectTimeMs = 100;
    }));
    h1.reconnectAll();
    h1.step(100);
    // ~100 arrivals in the connect window, each spawning its own connect.
    expect(h1.metrics.totals.connectionAttempts).toBeGreaterThan(60);
    expect(h1.metrics.totals.connectionAttempts).toBeLessThan(140);

    const h2 = new PoolSimulation(singleKey((c) => {
      c.traffic.requestsPerSec = 1_000;
      c.pool.connectTimeMs = 100;
      c.pool.protocol = 'http2';
    }));
    h2.reconnectAll();
    h2.step(100);
    expect(h2.metrics.totals.connectionAttempts).toBeLessThanOrEqual(2);
  });
});

describe("Little's Law connection justification", () => {
  it('compares established sockets with the theoretical concurrency for customer throughput', () => {
    const sim = new PoolSimulation(basePoolConfig());
    const snapshot = sim.snapshot();
    expect(snapshot.littleLawRequired).toBe(120_000 * 0.020);
    expect(snapshot.established).toBeGreaterThan(snapshot.poolKeys); // more than one socket per key
    expect(snapshot.connectionAmplification).toBeCloseTo(snapshot.established / 2400, 8);
  });

  it('accounts for HTTP/2 streams but excludes warm floors', () => {
    const cfg = basePoolConfig();
    cfg.pool.protocol = 'http2';
    cfg.pool.h2StreamsPerConnection = 100;
    cfg.pool.minConnectionsPerKey = 8;
    const snapshot = new PoolSimulation(cfg).snapshot();
    expect(snapshot.littleLawRequired).toBe(24);
    expect(snapshot.connectionAmplification).toBeCloseTo(snapshot.established / 24, 8);
  });

  it('tracks the metric in history and drops actual/required to zero after a recycle', () => {
    const sim = new PoolSimulation(basePoolConfig());
    sim.step(1000);
    expect(sim.metrics.buckets.at(-1)?.littleLawRequired).toBe(2400);
    expect(sim.metrics.buckets.at(-1)?.connectionAmplification).toBeCloseTo(sim.snapshot().connectionAmplification, 4);
    sim.reconnectAll();
    expect(sim.snapshot().connectionAmplification).toBe(0);
  });
});

describe('Links and configured link endpoints', () => {
  it('builds concrete Links that converge on a shared endpoint identity', () => {
    const sim = new PoolSimulation(basePoolConfig());
    const snapshot = sim.snapshot();
    expect(snapshot.links).toHaveLength(8);
    expect(snapshot.endpoints).toHaveLength(1);
    expect(snapshot.linkEndpointBindings).toBe(8);
    expect(snapshot.sharedEndpoints).toBe(1);
    expect(snapshot.endpoints[0].linkIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(snapshot.endpoints[0].ips).toHaveLength(8);
    expect(snapshot.responders).toHaveLength(8);
    expect(snapshot.endpoints[0].ips).toEqual(snapshot.responders.map((responder) => responder.ip));
    expect(snapshot.endpoints[0].authority).toContain(':443');
    expect(snapshot.links.every((link) => link.endpointId === snapshot.endpoints[0].id)).toBe(true);
    expect(snapshot.endpoints[0].estimatedConnections).toBeCloseTo(snapshot.established, 6);
  });

  it('distinguishes repeated endpoint identities from different endpoints', () => {
    const cfg = basePoolConfig();
    cfg.fabric.nodes = 1;
    cfg.fabric.coresPerNode = 1;
    cfg.fabric.links = 3;
    cfg.fabric.uniqueEndpoints = 2;
    cfg.responder.instances = 2;

    const current = new PoolSimulation(cfg);
    expect(current.snapshot().linkEndpointBindings).toBe(3); // exactly one endpoint / Link
    expect(current.snapshot().uniqueEndpoints).toBe(2);
    expect(current.logicalKeysPerOwner()).toBe(6); // 3 Links × 2 IPs
    expect(current.snapshot().endpoints[0].ips).toEqual(current.snapshot().endpoints[1].ips);
    expect(current.snapshot().endpoints[0].ips).toEqual(current.snapshot().responders.map((responder) => responder.ip));

    cfg.fabric.keyStrategy = 'endpoint';
    expect(new PoolSimulation(cfg).logicalKeysPerOwner()).toBe(4); // 2 unique × 2 IPs
    cfg.fabric.keyStrategy = 'dns';
    expect(new PoolSimulation(cfg).logicalKeysPerOwner()).toBe(2); // one authority key / unique endpoint
  });

  it('routes every Link through exactly one endpoint and conserves endpoint traffic', () => {
    const cfg = basePoolConfig();
    cfg.fabric.links = 4;
    cfg.fabric.uniqueEndpoints = 3;
    const sim = new PoolSimulation(cfg);
    const snapshot = sim.snapshot();
    expect(snapshot.links.map((link) => link.endpointId)).toEqual([1, 2, 3, 1]);
    const endpointRate = snapshot.endpoints.reduce((sum, endpoint) => sum + endpoint.requestRate, 0);
    expect(endpointRate).toBeCloseTo(snapshot.effectiveRate, 6);
    expect(snapshot.endpoints.filter((endpoint) => endpoint.shared)).toHaveLength(1);
    expect(snapshot.endpoints.filter((endpoint) => !endpoint.shared)).toHaveLength(2);
    expect(snapshot.endpoints[0].linkIds).toEqual([1, 4]);
    const sampledPerEndpoint = snapshot.endpoints.map((e) => snapshot.sampled.filter((k) => k.endpointId === e.id).length);
    expect(sampledPerEndpoint.every((n) => n > 0)).toBe(true);
  });

  it('cannot create more unique endpoints than Links', () => {
    const cfg = basePoolConfig();
    cfg.fabric.links = 4;
    cfg.fabric.uniqueEndpoints = 12;
    const snapshot = new PoolSimulation(cfg).snapshot();
    expect(snapshot.uniqueEndpoints).toBe(4);
    expect(snapshot.sharedEndpoints).toBe(0);
    expect(snapshot.links.map((link) => link.endpointId)).toEqual([1, 2, 3, 4]);
    expect(snapshot.endpoints.every((endpoint) => endpoint.linkIds.length === 1)).toBe(true);
  });

  it('derives every endpoint IP from the responder instances', () => {
    const cfg = basePoolConfig();
    cfg.responder.instances = 18;
    const snapshot = new PoolSimulation(cfg).snapshot();
    const responderIps = snapshot.responders.map((responder) => responder.ip);
    expect(snapshot.responders).toHaveLength(18);
    expect(new Set(responderIps).size).toBe(18);
    expect(snapshot.endpoints.every((endpoint) => endpoint.ips.length === 18)).toBe(true);
    expect(snapshot.endpoints.every((endpoint) => endpoint.ips.join() === responderIps.join())).toBe(true);
    expect(snapshot.logicalKeysPerOwner).toBe(8 * 18);
  });

  it('combines the traffic contributions of Links that share an endpoint', () => {
    const cfg = singleKey((c) => {
      c.fabric.links = 4;
      c.fabric.uniqueEndpoints = 3;
      c.fabric.keyStrategy = 'endpoint';
      c.pool.policy = 'bounded';
      c.pool.maxConnectionsPerKey = 20;
      c.traffic.requestsPerSec = 800;
      c.traffic.responseTimeMs = 100;
    });

    const sim = new PoolSimulation(cfg);
    sim.step(2_000);
    const snapshot = sim.snapshot();
    const shared = snapshot.endpoints.find((endpoint) => endpoint.shared)!;
    const singleLinkEndpoints = snapshot.endpoints.filter((endpoint) => !endpoint.shared);
    expect(shared.requestRate).toBeCloseTo(snapshot.effectiveRate / 2, 6);
    expect(singleLinkEndpoints.every((endpoint) => Math.abs(endpoint.requestRate - snapshot.effectiveRate / 4) < 1e-6)).toBe(true);
    // The shared endpoint wants ~40 sockets but is capped at 20; the others need fewer.
    expect(shared.estimatedConnections).toBe(20);
    expect(snapshot.allowedConnections).toBeLessThanOrEqual(60);
    expect(snapshot.desiredConnections).toBeGreaterThan(snapshot.allowedConnections);
    expect(snapshot.capActive).toBe(true);
  });
});

describe('responder pressure dynamics', () => {
  it('hits the configured Envoy limit after scaling the baseline from two to four nodes', () => {
    const baseline = new PoolSimulation(basePoolConfig()).snapshot();
    expect(baseline.responderPressure).toBeLessThan(0.97);
    expect(baseline.limitActive).toBe(false);

    const cfg = basePoolConfig();
    cfg.fabric.nodes = 4;
    const sim = new PoolSimulation(cfg);
    expect(sim.snapshot().responderPressure).toBeCloseTo(1, 2);
    expect(sim.snapshot().limitActive).toBe(true);
    expect(sim.snapshot().established).toBeLessThan(sim.snapshot().desiredConnections);
  });

  it('produces reset attempts after a cold reconnect above the responder budget', () => {
    const cfg = basePoolConfig();
    cfg.fabric.nodes = 4;
    const sim = new PoolSimulation(cfg);
    sim.reconnectAll();
    sim.step(90_000); // sparse keys need most of an idle window to inflate to the budget
    expect(sim.metrics.totals.connectionAttempts).toBeGreaterThan(0);
    expect(sim.metrics.totals.connectionResets).toBeGreaterThan(0);
    expect(sim.metrics.totals.failedRequests).toBeGreaterThan(0);
  });

  it('places more sockets on the responder with the larger traffic share', () => {
    const sim = new PoolSimulation(basePoolConfig());
    sim.step(2_000);
    const responders = sim.snapshot().responders;
    expect(responders[0].estimatedConnections).toBeGreaterThan(responders[responders.length - 1].estimatedConnections);
    expect(Math.max(...responders.map((r) => r.estimatedConnections))).toBeCloseTo(sim.snapshot().hottestResponder, 6);
  });

  it('keeps the sockets a surge opened until the idle window passes, then expires them', () => {
    const sim = new PoolSimulation(basePoolConfig());
    sim.step(5_000);
    sim.triggerPulse(2, 30_000);
    sim.step(30_000);
    const atSurgeEnd = sim.snapshot().established;
    sim.step(60_000); // 60 s after the surge, still inside the 90 s idle window
    expect(sim.snapshot().established).toBeGreaterThan(atSurgeEnd * 0.9);
    sim.step(40_000); // the surge sockets have now aged past the idle timeout
    expect(sim.snapshot().established).toBeLessThan(atSurgeEnd * 0.85);
  });

  it('inflates cold pools over the idle window rather than instantly', () => {
    const sim = new PoolSimulation(basePoolConfig());
    sim.reconnectAll();
    sim.step(1_000);
    const early = sim.snapshot().established;
    sim.step(30_000);
    expect(early).toBeGreaterThan(0);
    expect(sim.snapshot().established).toBeGreaterThan(early * 1.2);
  });

  it('keeps scenario traffic identical for fair A/B comparisons', () => {
    const traffic = JSON.stringify(POOL_PRESETS[0].config.traffic);
    for (const preset of POOL_PRESETS) expect(JSON.stringify(preset.config.traffic)).toBe(traffic);
  });

  it('replays identically for one seed and differently for another', () => {
    const a = new PoolSimulation(basePoolConfig());
    const b = new PoolSimulation(basePoolConfig());
    const other = basePoolConfig();
    other.seed = 42;
    const c = new PoolSimulation(other);
    a.step(3_000);
    b.step(3_000);
    c.step(3_000);
    expect(a.snapshot().established).toBe(b.snapshot().established);
    expect(a.metrics.totals.servedRequests).toBe(b.metrics.totals.servedRequests);
    expect(a.snapshot().established).not.toBe(c.snapshot().established);
  });

  it('is step-size stable at metrics-bucket boundaries', () => {
    const a = new PoolSimulation(basePoolConfig());
    const b = new PoolSimulation(basePoolConfig());
    a.triggerPulse(2, 10_000);
    b.triggerPulse(2, 10_000);
    for (let i = 0; i < 200; i++) a.step(50);
    b.step(10_000);
    expect(a.snapshot().established).toBeCloseTo(b.snapshot().established, 5);
    expect(a.metrics.totals.connectionResets).toBeCloseTo(b.metrics.totals.connectionResets, 5);
    expect(a.metrics.totals.servedRequests).toBeCloseTo(b.metrics.totals.servedRequests, 5);
  });
});
