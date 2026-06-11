/**
 * Invariant tests for the simulation engine, derived from the dynamics the
 * simulator exists to teach (metastable failures, retry amplification,
 * protection mechanisms). These are also the preset-tuning harness: if a
 * preset stops demonstrating its scenario, a test here fails.
 */

import { describe, expect, it } from 'vitest';
import { presetById, cloneConfig } from './presets';
import { Simulation } from './simulation';
import type { SimulationConfig } from './types';

/** Advance the sim in renderer-sized steps (2ms virtual per step). */
function run(sim: Simulation, durationMs: number): void {
  const STEP = 2;
  for (let t = 0; t < durationMs; t += STEP) sim.step(STEP);
}

interface WindowStats {
  arrivals: number;
  successes: number;
  timeouts: number;
  shedTls: number;
  shedConnLimit: number;
  errors: number;
  rejected: number;
  retries: number;
  handshakesStarted: number;
  successRate: number;
}

/** Aggregate metrics buckets over a sim-time window [fromMs, toMs). */
function statsBetween(sim: Simulation, fromMs: number, toMs: number): WindowStats {
  const s: WindowStats = {
    arrivals: 0,
    successes: 0,
    timeouts: 0,
    shedTls: 0,
    shedConnLimit: 0,
    errors: 0,
    rejected: 0,
    retries: 0,
    handshakesStarted: 0,
    successRate: 0,
  };
  for (const b of sim.metrics.buckets) {
    if (b.time < fromMs || b.time >= toMs) continue;
    s.arrivals += b.arrivals;
    s.successes += b.successes;
    s.timeouts += b.timeouts;
    s.shedTls += b.shedTls;
    s.shedConnLimit += b.shedConnLimit;
    s.errors += b.errors;
    s.rejected += b.rejected;
    s.retries += b.retries;
    s.handshakesStarted += b.tlsHandshakesStarted;
  }
  s.successRate = s.arrivals > 0 ? s.successes / s.arrivals : 1;
  return s;
}

function newSim(presetId: string, mutate?: (cfg: SimulationConfig) => void): Simulation {
  const cfg = cloneConfig(presetById(presetId).config);
  if (mutate) mutate(cfg);
  return new Simulation(cfg);
}

describe('healthy preset', () => {
  it('stays healthy over 60s: >95% success, negligible churn', () => {
    const sim = newSim('healthy');
    run(sim, 60_000);
    const s = statsBetween(sim, 5_000, 60_000);
    expect(s.successRate).toBeGreaterThan(0.95);
    expect(s.timeouts / s.arrivals).toBeLessThan(0.02);
    expect(s.shedTls + s.shedConnLimit).toBe(0);
    // Steady-state handshakes only replace the ~1% of conns lost to timeouts.
    expect(s.handshakesStarted / s.arrivals).toBeLessThan(0.05);
  });

  it('absorbs a 3x pulse and recovers', () => {
    const sim = newSim('healthy');
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 5_000); // pulse window
    run(sim, 10_000); // recovery window
    const recovery = statsBetween(sim, 25_000, 30_000);
    expect(recovery.successRate).toBeGreaterThan(0.9);
  });
});

describe('storm-prone preset (metastability)', () => {
  it('is stable-looking at baseline', () => {
    const sim = newSim('storm-prone');
    run(sim, 20_000);
    const s = statsBetween(sim, 5_000, 20_000);
    expect(s.successRate).toBeGreaterThan(0.85);
  });

  it('a pulse ignites a storm that persists after the trigger is gone', () => {
    const sim = newSim('storm-prone');
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 5_000); // pulse: 15s..20s
    run(sim, 25_000); // long after the pulse: 20s..45s
    // The metastable signature: organic load is back to baseline but the
    // sustaining effect (retries + handshake CPU) keeps goodput collapsed.
    const after = statsBetween(sim, 30_000, 45_000);
    expect(after.successRate).toBeLessThan(0.5);
    expect(after.handshakesStarted).toBeGreaterThan(after.arrivals * 0.3);
  });
});

describe('protected preset', () => {
  it('same aggressive clients + same pulse, but recovers quickly', () => {
    const sim = newSim('protected');
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 5_000); // pulse: 15s..20s
    run(sim, 10_000); // recovery: 20s..30s
    const recovery = statsBetween(sim, 25_000, 30_000);
    expect(recovery.successRate).toBeGreaterThan(0.85);
    // During the pulse the fabric shed connection attempts (RST) rather
    // than letting handshake demand melt the CPU.
    const pulse = statsBetween(sim, 15_000, 20_000);
    expect(pulse.shedTls + pulse.shedConnLimit).toBeGreaterThan(0);
  });
});

describe('client circuit breaker', () => {
  it('trips on a failing fabric path and recovers after it heals', () => {
    const sim = newSim('healthy', (cfg) => {
      cfg.clients.circuitBreakerEnabled = true;
      cfg.downstreams.errorRate = 1.0; // every downstream answer is an error
    });
    run(sim, 10_000);
    // All client breakers should have tripped; arrivals now fail fast locally.
    const broken = statsBetween(sim, 6_000, 10_000);
    expect(sim.clients.every((c) => c.breaker !== 'closed')).toBe(true);
    expect(broken.rejected).toBeGreaterThan(broken.errors);
    sim.cfg.downstreams.errorRate = 0.005; // downstream heals
    run(sim, 20_000);
    expect(sim.clients.every((c) => c.breaker === 'closed')).toBe(true);
    const recovered = statsBetween(sim, 25_000, 30_000);
    expect(recovered.successRate).toBeGreaterThan(0.9);
  });
});

describe('TLS resumption', () => {
  it('flags handshakes as resumed according to the configured rate', () => {
    const all = newSim('healthy', (cfg) => {
      cfg.fabric.tlsResumptionRate = 1;
    });
    const none = newSim('healthy', (cfg) => {
      cfg.fabric.tlsResumptionRate = 0;
    });
    for (const sim of [all, none]) {
      run(sim, 10_000);
      sim.triggerPulse(3, 3_000); // force pool growth → handshakes
      run(sim, 10_000);
    }
    expect(all.metrics.totals.resumedHandshakes).toBeGreaterThan(0);
    expect(all.metrics.totals.tlsHandshakesCompleted).toBeGreaterThan(0);
    expect(none.metrics.totals.resumedHandshakes).toBe(0);
  });
});

describe('overwhelmed preset', () => {
  it('goodput collapses and stays collapsed', () => {
    const sim = newSim('overwhelmed');
    run(sim, 30_000);
    const s = statsBetween(sim, 10_000, 30_000);
    expect(s.successRate).toBeLessThan(0.3);
  });
});

describe('engine invariants', () => {
  it('is deterministic for a given seed', () => {
    const a = newSim('storm-prone');
    const b = newSim('storm-prone');
    run(a, 20_000);
    run(b, 20_000);
    expect(a.metrics.totals).toEqual(b.metrics.totals);
    expect(a.fabricConnCount).toBe(b.fabricConnCount);
    expect(a.fabricInFlight).toBe(b.fabricInFlight);
  });

  it('different seeds diverge', () => {
    const a = newSim('healthy');
    const b = newSim('healthy', (cfg) => {
      cfg.seed = 42;
    });
    run(a, 10_000);
    run(b, 10_000);
    expect(a.metrics.totals).not.toEqual(b.metrics.totals);
  });

  it('drains cleanly when traffic stops (no leaked accounting)', () => {
    const sim = newSim('storm-prone');
    run(sim, 20_000);
    sim.cfg.clients.requestRatePerSec = 0;
    sim.cfg.clients.maxRetries = 0;
    sim.rescheduleArrivals();
    run(sim, 20_000);
    expect(sim.fabricInFlight).toBe(0);
    expect(sim.handshakesActive).toBe(0);
    expect(sim.permitWaiters.length).toBe(0);
    expect(sim.totalDsQueueDepth()).toBe(0);
    expect(sim.requests.size).toBe(0);
    for (const ds of sim.downstreams) {
      expect(ds.inFlight).toBe(0);
      expect(ds.probeInFlight).toBe(false);
    }
    // Conservation: after a full drain the fabric's count must equal the
    // client-side view exactly (no phantom or double-freed connections).
    let counted = 0;
    for (const client of sim.clients) {
      counted += client.conns.filter(
        (c) => c.state === 'idle' || c.state === 'busy' || c.state === 'handshaking',
      ).length;
    }
    expect(sim.fabricConnCount).toBe(counted);
  });

  it('breaker recovers after downstream heals, even when probe clients time out and retry', () => {
    // The latch scenario: client timeout < downstream timeout, retries on,
    // breaker enabled, one downstream slow enough to trip it. A probe whose
    // client gives up and retries must hand the probe slot back.
    const sim = newSim('healthy', (cfg) => {
      cfg.downstreams.count = 1;
      cfg.downstreams.responseTimeMedianMs = 400;
      cfg.clients.requestTimeoutMs = 200;
      cfg.clients.maxRetries = 2;
      cfg.downstreamPool.requestTimeoutMs = 250;
      cfg.downstreamPool.breakerCooldownMs = 1500;
      cfg.downstreamPool.breakerMinSamples = 6;
    });
    run(sim, 15_000); // downstream is broken; breaker trips and probes churn
    expect(sim.downstreams[0].breaker).not.toBe('closed');
    sim.cfg.downstreams.responseTimeMedianMs = 50; // downstream heals
    run(sim, 20_000);
    expect(sim.downstreams[0].breaker).toBe('closed');
    expect(sim.downstreams[0].probeInFlight).toBe(false);
    const recovered = statsBetween(sim, 30_000, 35_000);
    expect(recovered.successRate).toBeGreaterThan(0.8);
  });

  it('counters never go negative under storm churn', () => {
    const sim = newSim('overwhelmed');
    const STEP = 2;
    for (let t = 0; t < 30_000; t += STEP) {
      sim.step(STEP);
      expect(sim.fabricInFlight).toBeGreaterThanOrEqual(0);
      expect(sim.fabricConnCount).toBeGreaterThanOrEqual(0);
      expect(sim.handshakesActive).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects the TLS handshake concurrency limit', () => {
    const sim = newSim('storm-prone');
    sim.cfg.fabric.tlsHandshakeConcurrency = 4;
    const STEP = 2;
    for (let t = 0; t < 30_000; t += STEP) {
      sim.step(STEP);
      expect(sim.handshakesActive).toBeLessThanOrEqual(4);
    }
  });

  it('live entity-count changes apply without breaking accounting', () => {
    const sim = newSim('healthy');
    run(sim, 5_000);
    sim.cfg.clients.count = 9;
    sim.cfg.downstreams.count = 5;
    sim.applyStructure();
    run(sim, 5_000);
    expect(sim.clients.length).toBe(9);
    expect(sim.downstreams.length).toBe(5);
    sim.cfg.clients.count = 3;
    sim.cfg.downstreams.count = 2;
    sim.applyStructure();
    run(sim, 10_000);
    const s = statsBetween(sim, 22_000, 25_000);
    expect(s.successRate).toBeGreaterThan(0.9);
    expect(sim.fabricInFlight).toBeGreaterThanOrEqual(0);
  });
});
