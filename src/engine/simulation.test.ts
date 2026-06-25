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
    // The single client timeout traps connection rebuilds too, so at storm
    // CPU no handshake finishes inside the deadline — goodput goes to a
    // hard zero, not a trickle.
    const after = statsBetween(sim, 30_000, 45_000);
    expect(after.successRate).toBeLessThan(0.05);
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

describe('downstream selection', () => {
  it('re-spreads across all downstreams after a stall clears (random IP selection)', () => {
    const sim = newSim('healthy');
    run(sim, 10_000);
    sim.cfg.downstreams.responseTimeMedianMs = 600; // every downstream stalls
    run(sim, 6_000);
    sim.cfg.downstreams.responseTimeMedianMs = 100; // stall clears
    // Measure how work distributes across downstreams during recovery by
    // integrating per-downstream in-flight over the window.
    const share = new Array(sim.downstreams.length).fill(0);
    const STEP = 2;
    for (let t = 0; t < 10_000; t += STEP) {
      sim.step(STEP);
      for (let i = 0; i < sim.downstreams.length; i++) share[i] += sim.downstreams[i].inFlight;
    }
    const total = share.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    for (const s of share) {
      // Random selection: every downstream should carry a meaningful share
      // shortly after recovery — no sticking to the first one back.
      expect(s / total).toBeGreaterThan(0.15);
    }
    // Full recovery follows once the stall clears and pool rebuilds settle.
    run(sim, 10_000);
    const recovered = statsBetween(sim, 30_000, 36_000);
    expect(recovered.successRate).toBeGreaterThan(0.85);
  });
});

describe('TLS handshake wire vs CPU split', () => {
  /**
   * Isolate handshakes: one client, one connection, every request times out
   * and poisons the connection, forcing a fresh full handshake per cycle.
   * The client timeout is set above the longest profiled handshake (so
   * rebuilds complete inside the deadline) and below the downstream response
   * time (so every request still times out and poisons its connection).
   * Measures mean handshake duration and fabric CPU work per handshake.
   */
  function handshakeProfile(rttMs: number, tlsClientDelayMs: number) {
    const sim = newSim('healthy', (cfg) => {
      cfg.clients.count = 1;
      cfg.clients.requestRatePerSec = 4;
      cfg.clients.poolSize = 1;
      cfg.clients.maxRetries = 0;
      cfg.clients.clientTimeoutMs = 600;
      cfg.clients.rttMs = rttMs;
      cfg.clients.tlsClientDelayMs = tlsClientDelayMs;
      cfg.fabric.tlsResumptionRate = 0;
      cfg.downstreams.responseTimeMedianMs = 2000; // guarantee client timeouts
      cfg.downstreamPool.requestTimeoutMs = 5000; // never error before the client gives up
    });
    let busyMs = 0;
    let workUnits = 0;
    const capPerMs = sim.cfg.fabric.cpuCapacity / 1000;
    const STEP = 1;
    for (let t = 0; t < 30_000; t += STEP) {
      sim.step(STEP);
      if (sim.handshakesActive > 0) busyMs += STEP;
      workUnits += Math.min(1, sim.cpu.utilization()) * capPerMs * STEP;
    }
    const n = sim.metrics.totals.tlsHandshakesCompleted;
    expect(n).toBeGreaterThan(20);
    return { durMs: busyMs / n, workPerHs: workUnits / n };
  }

  it('client RTT stretches the handshake without adding fabric CPU work', () => {
    const fast = handshakeProfile(4, 0);
    const slow = handshakeProfile(80, 0);
    // Two hello round trips: duration grows by ~2×ΔRTT (= 152ms here)...
    expect(slow.durMs - fast.durMs).toBeGreaterThan(120);
    expect(slow.durMs - fast.durMs).toBeLessThan(185);
    // ...while CPU work per handshake stays put.
    expect(slow.workPerHs / fast.workPerHs).toBeGreaterThan(0.75);
    expect(slow.workPerHs / fast.workPerHs).toBeLessThan(1.3);
  });

  it('client TLS delay holds the handshake (and its permit) without fabric CPU', () => {
    const prompt = handshakeProfile(24, 0);
    const burdened = handshakeProfile(24, 200);
    expect(burdened.durMs - prompt.durMs).toBeGreaterThan(170);
    expect(burdened.durMs - prompt.durMs).toBeLessThan(230);
    expect(burdened.workPerHs / prompt.workPerHs).toBeGreaterThan(0.75);
    expect(burdened.workPerHs / prompt.workPerHs).toBeLessThan(1.3);
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
    }
    for (const client of sim.clients) {
      expect(client.probeInFlight).toBe(false);
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

describe('connection-rate shedding (accept-rate limiter)', () => {
  // Defaults tuned for the demo load: healthy accept rate peaks ~12/s (steady)
  // and ~20/s (under a 3x pulse); a storm floods accept at 200-350/s. A 40/s
  // limit with a 30-burst sits cleanly between the two.
  const enableLimiter = (cfg: SimulationConfig) => {
    cfg.fabric.connRateShedEnabled = true;
    cfg.fabric.connRateLimitPerSec = 40;
    cfg.fabric.connRateBurst = 30;
  };

  it('never fires under healthy load and leaves goodput untouched', () => {
    const sim = newSim('healthy', enableLimiter);
    run(sim, 60_000);
    expect(sim.metrics.totals.shedConnRate).toBe(0);
    const s = statsBetween(sim, 5_000, 60_000);
    expect(s.successRate).toBeGreaterThan(0.95);
  });

  it('does not throttle a healthy 3x pulse (accept rate stays under the limit)', () => {
    const sim = newSim('healthy', enableLimiter);
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 15_000);
    expect(sim.metrics.totals.shedConnRate).toBe(0);
    expect(statsBetween(sim, 25_000, 30_000).successRate).toBeGreaterThan(0.9);
  });

  it('alone prevents the storm-prone metastable collapse', () => {
    // Baseline: storm-prone collapses to ~zero goodput long after the pulse.
    const off = newSim('storm-prone');
    run(off, 15_000);
    off.triggerPulse(3, 5_000);
    run(off, 30_000);
    expect(statsBetween(off, 30_000, 45_000).successRate).toBeLessThan(0.05);

    // Same preset and pulse, with only the accept-rate limiter added: the
    // fabric sheds the connection flood at accept and goodput survives —
    // something the static connection limit and TLS permit cap could not do.
    const on = newSim('storm-prone', enableLimiter);
    run(on, 15_000);
    on.triggerPulse(3, 5_000);
    run(on, 30_000);
    expect(on.metrics.totals.shedConnRate).toBeGreaterThan(0);
    expect(statsBetween(on, 30_000, 45_000).successRate).toBeGreaterThan(0.85);
  });

  it('caps the sustained accept rate near the configured limit under a storm', () => {
    const sim = newSim('storm-prone', enableLimiter);
    run(sim, 10_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 20_000);
    // Connections that actually pass accept (start a handshake) per second,
    // averaged over the storm window, must not exceed the limit by much — the
    // burst allows a little overage but the sustained rate is bounded.
    const s = statsBetween(sim, 15_000, 30_000);
    const acceptedPerSec = s.handshakesStarted / 15;
    expect(acceptedPerSec).toBeLessThan(40 * 1.5);
  });
});

describe('kernel limits (accept queue + file descriptors)', () => {
  it('are inert by default — no accept-queue drops or EMFILE even in a storm', () => {
    const sim = newSim('storm-prone');
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 25_000);
    expect(sim.metrics.totals.acceptQueueDrops).toBe(0);
    expect(sim.metrics.totals.emfileDrops).toBe(0);
    // The default storm still collapses — the new layers changed nothing.
    expect(statsBetween(sim, 30_000, 45_000).successRate).toBeLessThan(0.05);
  });

  it('the accept queue never overflows under healthy load (default depth)', () => {
    const sim = newSim('healthy', (cfg) => {
      cfg.fabric.acceptQueueEnabled = true; // default depth 32
    });
    run(sim, 60_000);
    expect(sim.metrics.totals.acceptQueueDrops).toBe(0);
    expect(statsBetween(sim, 5_000, 60_000).successRate).toBeGreaterThan(0.95);
  });

  it('the accept queue overflows when a storm starves the accept loop', () => {
    // Under storm-prone's post-pulse collapse the CPU saturates, the accept
    // loop drains slowly, and the kernel backlog fills past its depth.
    const sim = newSim('storm-prone', (cfg) => {
      cfg.fabric.acceptQueueEnabled = true; // default depth 32
    });
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 20_000);
    expect(sim.metrics.totals.acceptQueueDrops).toBeGreaterThan(0);
  });

  it('overflow with abort-on-overflow still drops, and the queue drains clean when traffic stops', () => {
    const sim = newSim('storm-prone', (cfg) => {
      cfg.fabric.acceptQueueEnabled = true;
      cfg.fabric.acceptQueueAbortOnOverflow = true;
    });
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 15_000);
    expect(sim.metrics.totals.acceptQueueDrops).toBeGreaterThan(0);
    // Stop offered load: the accept queue must empty (no leaked slots).
    sim.cfg.clients.requestRatePerSec = 0;
    sim.cfg.clients.maxRetries = 0;
    sim.rescheduleArrivals();
    run(sim, 20_000);
    expect(sim.acceptQueue.length).toBe(0);
    expect(sim.fabricInFlight).toBe(0);
  });

  it('the FD ceiling caps live sockets and fails by EMFILE, not a clean RST', () => {
    // A storm wants ~98 live sockets; the ceiling holds it below that and the
    // overflow is EMFILE (a withered connection), not a shed RST.
    const fdLimit = 64;
    const sim = newSim('storm-prone', (cfg) => {
      cfg.fabric.fdLimitEnabled = true;
      cfg.fabric.maxFileDescriptors = fdLimit;
    });
    const STEP = 2;
    const liveSockets = () => {
      let ds = 0;
      for (const d of sim.downstreams) ds += d.conns.length;
      return sim.fabricConnCount + ds;
    };
    for (let t = 0; t < 15_000; t += STEP) {
      sim.step(STEP);
      expect(liveSockets()).toBeLessThanOrEqual(fdLimit);
    }
    sim.triggerPulse(3, 5_000);
    for (let t = 0; t < 15_000; t += STEP) {
      sim.step(STEP);
      // The shared FD budget (client-facing + downstream pool) never breaches.
      expect(liveSockets()).toBeLessThanOrEqual(fdLimit);
    }
    expect(sim.metrics.totals.emfileDrops).toBeGreaterThan(0);
    // EMFILE is a dirty failure: no clean RST shed comes from the FD ceiling.
    expect(sim.metrics.totals.shedConnLimit).toBe(0);
  });

  it('a healthy fabric never hits the default FD ceiling', () => {
    const sim = newSim('healthy', (cfg) => {
      cfg.fabric.fdLimitEnabled = true; // default 80, healthy holds ~70 sockets
    });
    run(sim, 30_000);
    expect(sim.metrics.totals.emfileDrops).toBe(0);
    expect(statsBetween(sim, 5_000, 30_000).successRate).toBeGreaterThan(0.95);
  });
});

describe('lock contention (serialization bottleneck)', () => {
  // Enable the seeded per-request router lock (2µs) and run healthy at the
  // given representative server QPS. Returns lock + CPU + goodput observations.
  function runWithRouterLock(repQps: number, enabled: boolean) {
    const sim = newSim('healthy', (cfg) => {
      const router = cfg.fabric.locks.find((l) => l.id === 'router')!;
      router.enabled = enabled;
      router.holdTimeUs = 2;
      cfg.fabric.lockRepThroughputQps = repQps;
    });
    let cpuMean = 0;
    let samples = 0;
    const STEP = 2;
    for (let t = 0; t < 30_000; t += STEP) {
      sim.step(STEP);
      if (t >= 10_000) {
        cpuMean += Math.min(2, sim.cpu.utilization());
        samples++;
      }
    }
    let utilMean = 0;
    let waitPeak = 0;
    let n = 0;
    for (const b of sim.metrics.buckets) {
      if (b.time < 10_000) continue;
      utilMean += b.lockUtilization;
      waitPeak = Math.max(waitPeak, b.lockWaitMs);
      n++;
    }
    return {
      utilMean: utilMean / n,
      waitPeak,
      cpuMean: cpuMean / samples,
      success: statsBetween(sim, 10_000, 30_000).successRate,
    };
  }

  it('disabled locks have no effect (default presets)', () => {
    const sim = newSim('healthy');
    run(sim, 20_000);
    for (const b of sim.metrics.buckets) expect(b.lockUtilization).toBe(0);
  });

  it('a lightly-loaded µs lock is nearly invisible', () => {
    // At a modest representative QPS a 2µs lock is far from saturated and costs
    // almost nothing — like the real lock at low traffic.
    const m = runWithRouterLock(50_000, true);
    expect(m.utilMean).toBeLessThan(0.3);
    expect(m.success).toBeGreaterThan(0.95);
  });

  it('scaling representative throughput drives the same lock to saturation', () => {
    // "Vertical scaling": the lock's hold time is fixed, but pushing more QPS
    // through it raises utilization and the wait time climbs steeply.
    const low = runWithRouterLock(50_000, true);
    const high = runWithRouterLock(600_000, true);
    expect(high.utilMean).toBeGreaterThan(1); // saturated
    expect(low.utilMean).toBeLessThan(0.3); // not
    expect(high.waitPeak).toBeGreaterThan(low.waitPeak * 20);
    expect(high.waitPeak).toBeGreaterThan(100);
  });

  it('the lock — not the CPU — is the bottleneck', () => {
    // Same load, same CPU budget. With the 2µs lock the goodput collapses;
    // without it the identical workload is perfectly healthy and the CPU idles.
    const withLock = runWithRouterLock(600_000, true);
    const withoutLock = runWithRouterLock(600_000, false);
    expect(withLock.utilMean).toBeGreaterThan(1); // the lock is pegged
    expect(withLock.waitPeak).toBeGreaterThan(100); // ...adding big wait
    expect(withLock.success).toBeLessThan(0.6); // ...and crushing goodput
    // The very same workload without the lock stays healthy on idle CPU —
    // proof the wall is lock wait, not compute.
    expect(withoutLock.success).toBeGreaterThan(0.95);
    expect(withoutLock.cpuMean).toBeLessThan(0.5);
  });

  it('an accept-site lock contends when connection churn spikes', () => {
    // The Arc<Mutex> max-conns counter: quiet when pools stay warm, but a pulse
    // that churns connections drives acquisitions through it.
    const sim = newSim('storm-prone', (cfg) => {
      const maxconn = cfg.fabric.locks.find((l) => l.id === 'maxconn')!;
      maxconn.enabled = true;
      maxconn.holdTimeUs = 5;
      cfg.fabric.lockRepThroughputQps = 300_000;
    });
    run(sim, 15_000);
    sim.triggerPulse(3, 5_000);
    run(sim, 10_000);
    let peak = 0;
    for (const b of sim.metrics.buckets) if (b.time >= 15_000) peak = Math.max(peak, b.lockUtilization);
    expect(peak).toBeGreaterThan(0.1);
  });
});
