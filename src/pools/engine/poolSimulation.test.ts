import { describe, expect, it } from 'vitest';
import { basePoolConfig, clonePoolConfig, POOL_PRESETS } from './presets';
import { PoolSimulation } from './poolSimulation';

describe('outbound pool cardinality', () => {
  it('multiplies current pools across nodes, workers, Link endpoints, and IPs', () => {
    const sim = new PoolSimulation(basePoolConfig());
    expect(sim.poolOwners()).toBe(24 * 32);
    expect(sim.logicalKeysPerOwner()).toBe(8 * 4);
    expect(sim.poolKeyCount()).toBe(24 * 32 * 8 * 4);
    expect(sim.desiredConnectionCount()).toBeGreaterThanOrEqual(sim.poolKeyCount());
  });

  it('removes the right multiplier for each alternative key strategy', () => {
    const c = basePoolConfig();
    c.fabric.keyStrategy = 'dns';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(24 * 32);

    c.fabric.keyStrategy = 'endpoint';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(24 * 32 * 4);

    c.fabric.ownership = 'node';
    expect(new PoolSimulation(c).poolKeyCount()).toBe(24 * 4);
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
});

describe('hyper-util semantics represented by the model', () => {
  it('does not mistake max idle per key for an active connection cap', () => {
    const a = basePoolConfig();
    a.fabric.nodes = 1;
    a.fabric.coresPerNode = 1;
    a.fabric.links = 1;
    a.fabric.endpointsPerLink = 1;
    a.fabric.sharedEndpointsPerLink = 1;
    a.fabric.ipsPerEndpoint = 1;
    a.pool.minConnectionsPerKey = 0;
    a.traffic.requestsPerSec = 10_000;
    a.traffic.responseTimeMs = 100;
    a.traffic.concurrencyHeadroom = 1;
    a.pool.maxIdlePerKey = 1;
    const sim = new PoolSimulation(a);
    expect(sim.desiredConnectionCount()).toBe(1000);
    expect(sim.snapshot().allowedConnections).toBe(1000);
  });

  it('lets a hypothetical bounded library cap active connections per key', () => {
    const c = basePoolConfig();
    c.fabric.nodes = 1;
    c.fabric.coresPerNode = 1;
    c.fabric.links = 1;
    c.fabric.endpointsPerLink = 1;
    c.fabric.sharedEndpointsPerLink = 1;
    c.fabric.ipsPerEndpoint = 1;
    c.pool.minConnectionsPerKey = 0;
    c.traffic.requestsPerSec = 10_000;
    c.traffic.responseTimeMs = 100;
    c.traffic.concurrencyHeadroom = 1;
    c.pool.policy = 'bounded';
    c.pool.maxConnectionsPerKey = 64;
    const sim = new PoolSimulation(c);
    expect(sim.desiredConnectionCount()).toBe(1000);
    expect(sim.snapshot().allowedConnections).toBe(64);
    expect(sim.snapshot().capActive).toBe(true);
  });

  it('uses HTTP/2 stream multiplexing to reduce required connections', () => {
    const h1 = basePoolConfig();
    h1.pool.minConnectionsPerKey = 0;
    h1.fabric.nodes = 1;
    h1.fabric.coresPerNode = 1;
    h1.fabric.links = 1;
    h1.fabric.endpointsPerLink = 1;
    h1.fabric.sharedEndpointsPerLink = 1;
    h1.fabric.ipsPerEndpoint = 1;
    h1.traffic.requestsPerSec = 10_000;
    h1.traffic.responseTimeMs = 100;
    h1.traffic.concurrencyHeadroom = 1;
    const h2 = clonePoolConfig(h1);
    h2.pool.protocol = 'http2';
    h2.pool.h2StreamsPerConnection = 100;
    expect(new PoolSimulation(h2).desiredConnectionCount()).toBeLessThan(new PoolSimulation(h1).desiredConnectionCount());
  });

  it('uses idle timeout to avoid warming extremely sparse keys forever', () => {
    const long = basePoolConfig();
    long.pool.minConnectionsPerKey = 0;
    long.traffic.requestsPerSec = 10;
    long.pool.idleTimeoutMs = 90_000;
    const short = clonePoolConfig(long);
    short.pool.idleTimeoutMs = 100;
    expect(new PoolSimulation(short).desiredConnectionCount()).toBeLessThan(new PoolSimulation(long).desiredConnectionCount());
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
    expect(snapshot.endpoints[0].ips).toHaveLength(4);
    expect(snapshot.endpoints[0].authority).toContain(':443');
    expect(snapshot.links.every((link) => link.endpointIds[0] === snapshot.endpoints[0].id)).toBe(true);
  });

  it('distinguishes shared endpoint identities from Link-private endpoints', () => {
    const cfg = basePoolConfig();
    cfg.fabric.nodes = 1;
    cfg.fabric.coresPerNode = 1;
    cfg.fabric.links = 3;
    cfg.fabric.endpointsPerLink = 3;
    cfg.fabric.sharedEndpointsPerLink = 1;
    cfg.fabric.ipsPerEndpoint = 2;

    const current = new PoolSimulation(cfg);
    expect(current.snapshot().linkEndpointBindings).toBe(9);
    expect(current.snapshot().uniqueEndpoints).toBe(7); // 1 shared + 3×2 private
    expect(current.logicalKeysPerOwner()).toBe(18); // 9 bindings × 2 IPs
    const endpointIps = current.snapshot().endpoints.flatMap((endpoint) => endpoint.ips);
    expect(new Set(endpointIps).size).toBe(14); // every unique endpoint has a distinct synthetic IP set

    cfg.fabric.keyStrategy = 'endpoint';
    expect(new PoolSimulation(cfg).logicalKeysPerOwner()).toBe(14); // 7 unique × 2 IPs
    cfg.fabric.keyStrategy = 'dns';
    expect(new PoolSimulation(cfg).logicalKeysPerOwner()).toBe(7); // one authority key / unique endpoint
  });

  it('routes every Link through its endpoint set and conserves endpoint traffic', () => {
    const cfg = basePoolConfig();
    cfg.fabric.links = 4;
    cfg.fabric.endpointsPerLink = 2;
    cfg.fabric.sharedEndpointsPerLink = 1;
    const sim = new PoolSimulation(cfg);
    const snapshot = sim.snapshot();
    expect(snapshot.links.every((link) => link.endpointIds.length === 2)).toBe(true);
    const endpointRate = snapshot.endpoints.reduce((sum, endpoint) => sum + endpoint.requestRate, 0);
    expect(endpointRate).toBeCloseTo(snapshot.effectiveRate, 6);
    expect(snapshot.endpoints.filter((endpoint) => endpoint.shared)).toHaveLength(1);
    expect(snapshot.endpoints.filter((endpoint) => !endpoint.shared)).toHaveLength(4);
  });

  it('combines the traffic contributions of Links that share an endpoint', () => {
    const cfg = basePoolConfig();
    cfg.fabric.nodes = 1;
    cfg.fabric.coresPerNode = 1;
    cfg.fabric.links = 4;
    cfg.fabric.endpointsPerLink = 2;
    cfg.fabric.sharedEndpointsPerLink = 1;
    cfg.fabric.ipsPerEndpoint = 1;
    cfg.fabric.keyStrategy = 'endpoint';
    cfg.pool.minConnectionsPerKey = 0;
    cfg.pool.policy = 'bounded';
    cfg.pool.maxConnectionsPerKey = 20;
    cfg.traffic.requestsPerSec = 800;
    cfg.traffic.responseTimeMs = 100;
    cfg.traffic.concurrencyHeadroom = 1;
    cfg.responder.connectionLimit = 10_000;
    cfg.responder.connectionSkew = 0;

    const snapshot = new PoolSimulation(cfg).snapshot();
    expect(snapshot.desiredConnections).toBe(80);
    expect(snapshot.allowedConnections).toBe(60); // shared endpoint wants 40 but is capped at 20
    const shared = snapshot.endpoints.find((endpoint) => endpoint.shared)!;
    const privateEndpoints = snapshot.endpoints.filter((endpoint) => !endpoint.shared);
    expect(shared.requestRate).toBe(400);
    expect(shared.estimatedConnections).toBe(20);
    expect(privateEndpoints.every((endpoint) => endpoint.requestRate === 100)).toBe(true);
    expect(privateEndpoints.every((endpoint) => endpoint.estimatedConnections === 10)).toBe(true);
  });
});

describe('responder pressure dynamics', () => {
  it('hits the configured Envoy limit in the current scenario', () => {
    const sim = new PoolSimulation(basePoolConfig());
    expect(sim.snapshot().responderPressure).toBeCloseTo(1, 5);
    expect(sim.snapshot().limitActive).toBe(true);
    expect(sim.snapshot().established).toBeLessThan(sim.snapshot().desiredConnections);
  });

  it('produces reset attempts after a cold reconnect above the responder budget', () => {
    const sim = new PoolSimulation(basePoolConfig());
    sim.reconnectAll();
    sim.step(500);
    expect(sim.metrics.totals.connectionAttempts).toBeGreaterThan(0);
    expect(sim.metrics.totals.connectionResets).toBeGreaterThan(0);
    expect(sim.metrics.totals.failedRequests).toBeGreaterThan(0);
  });

  it('keeps scenario traffic identical for fair A/B comparisons', () => {
    const traffic = JSON.stringify(POOL_PRESETS[0].config.traffic);
    for (const preset of POOL_PRESETS) expect(JSON.stringify(preset.config.traffic)).toBe(traffic);
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
