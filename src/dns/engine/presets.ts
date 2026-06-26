/**
 * DNS load-distribution scenarios.
 *
 * Every scenario shares one offered-load shape (the Traffic group) so switching
 * scenarios — or comparing two side by side — isolates the fabric-side
 * difference, the way the storm presets isolate the fabric. The lesson emerges
 * when the operator drives an event: kill a server, ramp the traffic, or pulse.
 *
 * Defaults are demo-scaled but keep the ratios that matter: a server boots in
 * ~5 min, RTB Fabric's publisher Lambda updates the record set every ~1 min,
 * and a cohort caches a resolution for ~1 min. The fleet serves 30k req/s; the
 * steady offer is 18k (60%) and a pulse/ramp peak of 45k exceeds total capacity
 * — so a big enough surge has irreducible loss no matter how it is distributed.
 */

import type { DnsPreset, DnsSimulationConfig } from './types';

/** The plain baseline every scenario overrides. Exported for the test harness. */
export function baseConfig(): DnsSimulationConfig {
  return {
    seed: 1337,
    slaTarget: 0.99,
    clients: {
      cohorts: 12,
      heterogeneity: 0.2,
      pinnedFraction: 0.15,
      rstReResolve: false,
    },
    dns: {
      ttlMs: 60_000,
      ttlJitter: 0.2,
      updateIntervalMs: 60_000,
      propagationMs: 0,
    },
    health: {
      unhealthyThreshold: 1,
      healthyThreshold: 1,
      overloadFailsHealth: false,
    },
    servers: {
      count: 20,
      capacityPerSec: 1500,
      capacityJitter: 0.1,
      shedThreshold: 0.9,
      bootMs: 300_000,
      bootJitter: 0.15,
      warmupMs: 60_000,
      drainMs: 30_000,
      autoReplace: true,
      rstShedding: true,
    },
    scaling: {
      autoScaleEnabled: true,
      targetUtilization: 0.7,
      scaleStep: 2,
      cooldownMs: 60_000,
      minServers: 20,
      maxServers: 50,
    },
    traffic: {
      shape: 'steady',
      baseRatePerSec: 18_000,
      peakRatePerSec: 45_000,
      rampDurationMs: 120_000,
    },
    bidders: { count: 4 },
  };
}

function scenario(tune: (c: DnsSimulationConfig) => void): DnsSimulationConfig {
  const c = baseConfig();
  tune(c);
  return c;
}

export const DNS_PRESETS: DnsPreset[] = [
  {
    id: 'steady',
    name: 'Steady state',
    description:
      'Balanced fleet at ~60% utilization, RST shedding on, reactive autoscale on. The calm reference. Pulse it past total capacity (45k > 30k) to see that no distribution scheme keeps 100% — it only decides where the loss lands.',
    config: baseConfig(),
  },
  {
    id: 'no-rst',
    name: 'No RST shedding',
    description:
      'Overloaded servers do NOT shed — the fast loop is off, so excess hitting a hot server is simply lost instead of re-picking another cached IP. Pulse it next to Steady: with RST the surge redistributes, without it availability craters long before DNS can react.',
    config: scenario((c) => {
      c.servers.rstShedding = false;
    }),
  },
  {
    id: 'long-ttl',
    name: 'Long TTL (5 min)',
    description:
      'Clients cache resolutions for 5 minutes. Kill a server: the clients holding its IP keep hammering the black hole until their TTLs expire — a long availability scar. TTL is a failover lever; here it is set against you.',
    config: scenario((c) => {
      c.dns.ttlMs = 300_000;
    }),
  },
  {
    id: 'short-ttl',
    name: 'Short TTL (10 s)',
    description:
      'Clients re-resolve every 10 seconds. Kill a server next to Long TTL: clients clear off the dead IP fast, so the scar is short — at the cost of constant re-resolution churn. Even so, the pinned/JVM cohorts still stick until the run ends.',
    config: scenario((c) => {
      c.dns.ttlMs = 10_000;
    }),
  },
  {
    id: 'reactive',
    name: 'Reactive autoscale',
    description:
      'A tight fleet (~85% utilization) that scales out reactively. Pulse it: the surge overloads instantly, but new servers take ~5 min to boot + be advertised + be re-resolved — so reactive capacity arrives after the surge is over. Cheap to run, slow to react.',
    config: scenario((c) => {
      c.servers.count = 14;
      c.scaling.autoScaleEnabled = true;
      c.scaling.targetUtilization = 0.7;
      c.scaling.minServers = 14;
    }),
  },
  {
    id: 'headroom',
    name: 'Pre-provisioned headroom',
    description:
      'A larger fleet (~40% utilization) with autoscale off — capacity already in place. Pulse it next to Reactive: headroom absorbs the surge instantly with no dip, but costs more server-seconds steady-state. The availability-vs-cost trade, quantified on both axes.',
    config: scenario((c) => {
      c.servers.count = 30;
      c.scaling.autoScaleEnabled = false;
      c.scaling.minServers = 30;
    }),
  },
];

export function dnsPresetById(id: string): DnsPreset {
  const p = DNS_PRESETS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown DNS preset: ${id}`);
  return p;
}

/** Deep-clone a config so live knob edits never mutate the preset. */
export function cloneDnsConfig(cfg: DnsSimulationConfig): DnsSimulationConfig {
  return structuredClone(cfg);
}
