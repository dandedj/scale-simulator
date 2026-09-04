import { describe, expect, it } from 'vitest';
import { basePoolConfig, clonePoolConfig, POOL_PRESETS } from './presets';
import { PoolSimulation } from './poolSimulation';

describe('outbound pool cardinality', () => {
  it('multiplies current pools across nodes, workers, links, and IPs', () => {
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
    a.fabric.endpointIps = 1;
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
    c.fabric.endpointIps = 1;
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
    h1.fabric.endpointIps = 1;
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
