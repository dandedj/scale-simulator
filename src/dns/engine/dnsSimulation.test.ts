/**
 * Invariant tests for the DNS load-distribution engine — also the preset-tuning
 * harness. The two guards that matter most:
 *   - timescale separation: after a server dies, the staleness scar is bounded
 *     by TTL, not by the fast RST loop (TTL is a failover lever, not a fix);
 *   - playback determinism: the same seed gives the same availability trace
 *     regardless of how coarsely step() advances time (it must, since the model
 *     is integrated analytically between events).
 */

import { describe, expect, it } from 'vitest';
import { baseConfig, cloneDnsConfig, DNS_PRESETS, dnsPresetById } from './presets';
import { DnsSimulation } from './dnsSimulation';
import type { DnsSimulationConfig } from './types';

/**
 * Advance the sim by exactly durationMs, in steps of at most stepMs (the last
 * step is clamped so a stepMs that doesn't divide durationMs can't overshoot).
 */
function run(sim: DnsSimulation, durationMs: number, stepMs = 1000): void {
  let elapsed = 0;
  while (elapsed < durationMs) {
    const dt = Math.min(stepMs, durationMs - elapsed);
    sim.step(dt);
    elapsed += dt;
  }
}

function newSim(mutate?: (c: DnsSimulationConfig) => void): DnsSimulation {
  const cfg = baseConfig();
  if (mutate) mutate(cfg);
  return new DnsSimulation(cfg);
}

/** Availability (served ÷ offered) over closed buckets in [fromMs, toMs). */
function availBetween(sim: DnsSimulation, fromMs: number, toMs: number): number {
  let o = 0;
  let s = 0;
  for (const b of sim.metrics.buckets) {
    if (b.time < fromMs || b.time >= toMs) continue;
    o += b.offered;
    s += b.served;
  }
  return o > 0 ? s / o : 1;
}

/** Stale-hit volume (requests to dead IPs) over [fromMs, toMs). */
function staleBetween(sim: DnsSimulation, fromMs: number, toMs: number): number {
  let v = 0;
  for (const b of sim.metrics.buckets) {
    if (b.time < fromMs || b.time >= toMs) continue;
    v += b.staleHit;
  }
  return v;
}

describe('baseline invariants', () => {
  it('steady state holds availability near 100% with capacity to spare', () => {
    const sim = newSim();
    run(sim, 120_000);
    expect(availBetween(sim, 30_000, 120_000)).toBeGreaterThan(0.99);
  });

  it('served never exceeds offered and availability stays in [0,1]', () => {
    const sim = newSim((c) => {
      c.traffic.shape = 'ramp';
    });
    run(sim, 180_000);
    for (const b of sim.metrics.buckets) {
      expect(b.served).toBeLessThanOrEqual(b.offered + 1e-6);
      expect(b.served).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('a surge beyond total fleet capacity has irreducible loss', () => {
    // 20 × 1500 = 30k capacity; pulse to 2× of 18k = 36k > capacity.
    const sim = newSim();
    run(sim, 30_000);
    sim.triggerPulse(2, 60_000);
    run(sim, 60_000); // 30s..90s under the pulse
    const a = availBetween(sim, 45_000, 90_000);
    expect(a).toBeLessThan(0.95); // cannot serve what no server can hold
    expect(a).toBeGreaterThan(0.7); // but most still lands (≈30k/36k)
  });
});

describe('the fast loop: RST shedding', () => {
  it('RST re-pick lifts availability over a hot fleet vs no shedding', () => {
    // High, uneven load (small answer set + heterogeneity) just under total
    // capacity so hot spots form with headroom elsewhere to re-pick into.
    const tune = (c: DnsSimulationConfig) => {
      c.traffic.baseRatePerSec = 28_000; // 28k of 30k total
      c.dns.recordsReturned = 4;
      c.clients.heterogeneity = 0.5;
      c.clients.pinnedFraction = 0;
    };
    const withRst = newSim(tune);
    const noRst = newSim((c) => {
      tune(c);
      c.servers.rstShedding = false;
    });
    run(withRst, 120_000);
    run(noRst, 120_000);
    const a = availBetween(withRst, 60_000, 120_000);
    const b = availBetween(noRst, 60_000, 120_000);
    expect(a).toBeGreaterThan(b + 0.01); // the fast loop earns real availability
    expect(a).toBeGreaterThan(0.95);
  });
});

describe('the slow loop: TTL is a failover lever, not a fix', () => {
  it('a dead server leaves a stale-hit scar bounded by TTL', () => {
    const tune = (c: DnsSimulationConfig) => {
      c.servers.autoReplace = false; // isolate the staleness, no recovery
      c.clients.pinnedFraction = 0; // isolate TTL from pinned clients
      c.dns.recordsReturned = 20; // every cohort caches the victim
    };
    const longTtl = newSim((c) => {
      tune(c);
      c.dns.ttlMs = 300_000;
    });
    const shortTtl = newSim((c) => {
      tune(c);
      c.dns.ttlMs = 10_000;
    });
    run(longTtl, 60_000);
    run(shortTtl, 60_000);
    longTtl.killServer(false);
    shortTtl.killServer(false);
    run(longTtl, 180_000); // to 240s (180s after the kill)
    run(shortTtl, 180_000);
    // Long after the kill, the short-TTL fleet has cleared the dead IP from its
    // caches; the long-TTL fleet is still hammering it.
    const longScar = staleBetween(longTtl, 180_000, 240_000);
    const shortScar = staleBetween(shortTtl, 180_000, 240_000);
    expect(longScar).toBeGreaterThan(shortScar * 5);
    expect(shortScar).toBeLessThan(longScar);
  });
});

describe('scale-out: reactive is too slow for a short surge', () => {
  it('pre-provisioned headroom holds availability where reactive scaling cannot', () => {
    // Same offered surge; headroom already has the capacity, reactive must boot
    // (~5min) — far longer than the surge.
    const reactive = new DnsSimulation(cloneDnsConfig(dnsPresetById('reactive').config));
    const headroom = new DnsSimulation(cloneDnsConfig(dnsPresetById('headroom').config));
    run(reactive, 30_000);
    run(headroom, 30_000);
    reactive.triggerPulse(40_000 / 18_000, 120_000); // ramp offered to ~40k
    headroom.triggerPulse(40_000 / 18_000, 120_000);
    run(reactive, 120_000);
    run(headroom, 120_000);
    const r = availBetween(reactive, 45_000, 150_000);
    const h = availBetween(headroom, 45_000, 150_000);
    expect(h).toBeGreaterThan(r + 0.2);
    expect(h).toBeGreaterThan(0.95);
  });
});

describe('playback determinism', () => {
  it('availability is identical regardless of step granularity', () => {
    const build = () =>
      new DnsSimulation(
        cloneDnsConfig(
          (() => {
            const c = baseConfig();
            c.traffic.shape = 'ramp';
            return c;
          })(),
        ),
      );
    const coarse = build();
    const fine = build();
    // Same sim-time milestones, different step sizes.
    run(coarse, 30_000, 1000);
    run(fine, 30_000, 250);
    coarse.killServer(false);
    fine.killServer(false);
    run(coarse, 30_000, 1000);
    run(fine, 30_000, 250);
    coarse.triggerPulse(2, 30_000);
    fine.triggerPulse(2, 30_000);
    run(coarse, 120_000, 1000);
    run(fine, 120_000, 333);
    const a = coarse.metrics.lifetimeAvailability();
    const b = fine.metrics.lifetimeAvailability();
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
    expect(coarse.metrics.totals.served).toBeCloseTo(fine.metrics.totals.served, 2);
  });
});

describe('presets', () => {
  it('every preset runs without producing NaN or negative flows', () => {
    for (const p of DNS_PRESETS) {
      const sim = new DnsSimulation(cloneDnsConfig(p.config));
      run(sim, 60_000);
      const t = sim.metrics.totals;
      expect(Number.isFinite(t.served)).toBe(true);
      expect(Number.isFinite(t.offered)).toBe(true);
      expect(t.served).toBeGreaterThanOrEqual(-1e-9);
      expect(sim.metrics.lifetimeAvailability()).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
