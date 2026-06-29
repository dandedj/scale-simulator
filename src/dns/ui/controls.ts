/**
 * Control panel for the DNS load-distribution sim: scenario presets, the pulse
 * and lifecycle triggers (kill / add servers), the traffic-shape selector, live
 * knobs grouped by component, run totals (availability, lost-impression-seconds,
 * the cost axis), and the event ticker. Plain DOM, mirroring the storm panel's
 * structure and CSS so the two modes feel like one app.
 *
 * Knob groups carry a scope: 'global' (Traffic) always edits every pane so
 * comparison mode keeps offered load identical; 'sim' groups edit the pane
 * selected with the SIM A / SIM B tabs.
 */

import { compareSuccessRates } from '../../stats';
import type { DnsSimulation } from '../engine/dnsSimulation';
import { DNS_PRESETS } from '../engine/presets';
import type { DnsSimulationConfig, TrafficShape } from '../engine/types';
import { DnsLegend } from './legend';
import { DnsOverview } from './overview';

export const PANE_TAGS = ['A', 'B'] as const;

type KnobScope = 'global' | 'sim';

export interface DnsControlHooks {
  getSims(): DnsSimulation[];
  loadPreset(id: string): void;
  applyScenario(pane: number, id: string): void;
  reset(): void;
  pulse(factor: number, durationMs: number): void;
  killServer(graceful: boolean): void;
  addServers(n: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(s: number): void;
  getTimeScale(): number;
  configChanged(kind: 'rate' | 'structure' | 'plain', target: number | 'all'): void;
  setCompare(on: boolean): void;
  isCompare(): boolean;
  showCompareHelp(): void;
}

interface SettingInfo {
  what: string;
  how: string;
  expect: string;
}

interface KnobDef {
  label: string;
  min: number;
  max: number;
  step: number;
  kind?: 'rate' | 'structure' | 'plain';
  get(c: DnsSimulationConfig): number;
  set(c: DnsSimulationConfig, v: number): void;
  format?(v: number): string;
  info?: SettingInfo;
}

interface ToggleDef {
  label: string;
  get(c: DnsSimulationConfig): boolean;
  set(c: DnsSimulationConfig, v: boolean): void;
  info?: SettingInfo;
}

const secs = (v: number) => `${(v / 1000).toFixed(0)}s`;
const mins = (v: number) => (v >= 60_000 ? `${(v / 60_000).toFixed(1)}m` : `${(v / 1000).toFixed(0)}s`);
const perSec = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k/s` : `${Math.round(v)}/s`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

const GROUPS: Array<{ name: string; scope: KnobScope; knobs: KnobDef[]; toggles: ToggleDef[] }> = [
  {
    name: 'Traffic',
    scope: 'global',
    knobs: [
      {
        label: 'Base rate', min: 2000, max: 60000, step: 1000, kind: 'rate', get: (c) => c.traffic.baseRatePerSec, set: (c, v) => (c.traffic.baseRatePerSec = v), format: perSec,
        info: {
          what: 'Steady offered load, and the floor of a ramp (requests/sec across all cohorts).',
          how: 'Split across cohorts by weight, then distributed over each cohort’s resolved IPs. Total fleet capacity is servers × per-server capacity.',
          expect: 'Above total capacity, no distribution keeps 100% — availability falls to capacity ÷ offered. Below it, a balanced fleet serves nearly all.',
        },
      },
      {
        label: 'Peak rate', min: 5000, max: 120000, step: 1000, kind: 'rate', get: (c) => c.traffic.peakRatePerSec, set: (c, v) => (c.traffic.peakRatePerSec = v), format: perSec,
        info: {
          what: 'The target of a ramp and the high level of a pulse-shaped offer.',
          how: 'Ramp interpolates base→peak over the ramp duration; pulse shape spends 40% of each cycle at peak.',
          expect: 'Set peak above fleet capacity to force a surge the fleet can’t fully absorb until it scales out.',
        },
      },
      {
        label: 'Ramp / pulse period', min: 10000, max: 600000, step: 10000, kind: 'rate', get: (c) => c.traffic.rampDurationMs, set: (c, v) => (c.traffic.rampDurationMs = v), format: mins,
        info: {
          what: 'How long a ramp takes base→peak (and the pulse shape’s cycle length).',
          how: 'Only used by the ramp and pulse traffic shapes.',
          expect: 'A surge shorter than the scale-out time (~boot + DNS + TTL) can’t be met by reactive scaling — only by headroom.',
        },
      },
      {
        label: 'Cohorts', min: 5, max: 100, step: 1, kind: 'structure', get: (c) => c.clients.cohorts, set: (c, v) => (c.clients.cohorts = v),
        info: {
          what: 'Number of client cohorts — populations that each share one cached DNS resolution.',
          how: 'Offered load splits across cohorts by weight; each caches its own subset of the record set and re-resolves on its own TTL clock.',
          expect: 'More cohorts smooth the load distribution; fewer make it lumpier. Shared across both panes in comparison mode.',
        },
      },
      {
        label: 'SLO target', min: 0.9, max: 1, step: 0.005, kind: 'plain', get: (c) => c.slaTarget, set: (c, v) => (c.slaTarget = v), format: (v) => `${(v * 100).toFixed(1)}%`,
        info: {
          what: 'The availability objective — the chart line and the degraded-frame threshold.',
          how: 'Availability below this lights the degraded frame and logs an event. In adtech a brief dip is often acceptable if cost and performance are good.',
          expect: 'Lower it to tolerate more transient loss; raise it to flag every dip.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Clients',
    scope: 'sim',
    knobs: [
      {
        label: 'Load skew', min: 0, max: 1, step: 0.05, get: (c) => c.clients.heterogeneity, set: (c, v) => (c.clients.heterogeneity = v), format: pct,
        info: {
          what: 'Spread in per-cohort offered-load weights (0 = uniform, 1 = heavy skew).',
          how: 'Each cohort’s weight is jittered by this much, so some cohorts carry more load than others.',
          expect: 'More skew creates hot spots that the RST fast loop must redistribute; with shedding off they turn into loss.',
        },
      },
      {
        label: 'Pinned clients', min: 0, max: 0.6, step: 0.05, get: (c) => c.clients.pinnedFraction, set: (c, v) => (c.clients.pinnedFraction = v), format: pct,
        info: {
          what: 'Fraction of cohorts that effectively ignore TTL — connection-pinned or JVM-pinned clients.',
          how: 'These cohorts hold their t0 resolution for the whole run and only fail over via an RST re-pick within that (stale) set, never via DNS.',
          expect: 'Even a short TTL can’t move these off a dead IP — the honest limit of “just lower the TTL”. Marked 📌 on the cohort tiles.',
        },
      },
      {
        label: 'EKS clients', min: 0, max: 1, step: 0.05, get: (c) => c.clients.eksFraction, set: (c, v) => (c.clients.eksFraction = v), format: pct,
        info: {
          what: 'Fraction of cohorts that are EKS clusters behind a shared CoreDNS cache.',
          how: 'All pods in a cluster share one cached answer (CoreDNS), so the cluster fails over as a unit on the CoreDNS cache clock — not per pod. Marked ⎈ on the cohort tiles.',
          expect: 'Their effective TTL is min(zone TTL, CoreDNS cache), so under a long zone TTL they fail over FASTER than direct/pinned clients (CoreDNS caps it) — but a whole cluster moves together, so the stale blast radius is lumpier.',
        },
      },
      {
        label: 'CoreDNS cache', min: 1000, max: 300000, step: 1000, get: (c) => c.clients.coreDnsCacheMs, set: (c, v) => (c.clients.coreDnsCacheMs = v), format: mins,
        info: {
          what: 'The CoreDNS cache duration (`cache N` in the Corefile) for EKS cohorts.',
          how: 'CoreDNS honors the record TTL capped at this value, so an EKS cohort’s effective TTL is min(zone TTL, this). Only affects EKS clients.',
          expect: 'Below the zone TTL it makes EKS clusters fresher than direct clients; at/above it, the zone TTL governs. The classic EKS lever for how fast clusters pick up DNS changes.',
        },
      },
    ],
    toggles: [
      {
        label: 'RST forces re-resolve', get: (c) => c.clients.rstReResolve, set: (c, v) => (c.clients.rstReResolve = v),
        info: {
          what: 'Whether sustained shedding makes a cohort re-resolve DNS early, bypassing its TTL.',
          how: 'Off (default): an RST only re-picks within the cached set, so TTL governs when fresh IPs arrive. On: shedding triggers an early DNS lookup.',
          expect: 'On lets clients pick up new capacity before their TTL expires — a real mitigation that trades extra DNS load for faster recovery.',
        },
      },
    ],
  },
  {
    name: 'DNS / Route 53',
    scope: 'sim',
    knobs: [
      {
        label: 'TTL', min: 1000, max: 600000, step: 1000, get: (c) => c.dns.ttlMs, set: (c, v) => (c.dns.ttlMs = v), format: mins,
        info: {
          what: 'How long a cohort caches a resolution before re-resolving.',
          how: 'Per-cohort expiry is staggered and jittered so caches don’t expire in lockstep. A dead IP keeps getting traffic until the caching cohorts re-resolve.',
          expect: 'The failover lever: short TTL clears clients off a dead IP fast (more lookups); long TTL leaves a long scar. It is NOT a scale-out lever — new capacity still waits on boot + publish.',
        },
      },
      {
        label: 'TTL jitter', min: 0, max: 1, step: 0.05, get: (c) => c.dns.ttlJitter, set: (c, v) => (c.dns.ttlJitter = v), format: pct,
        info: {
          what: 'Randomization applied to each cohort’s TTL.',
          how: 'Spreads re-resolutions over time so a mass expiry doesn’t become a thundering herd.',
          expect: 'Lower jitter synchronizes re-resolves into waves; higher jitter smooths them.',
        },
      },
      {
        label: 'Lambda interval', min: 5000, max: 300000, step: 5000, get: (c) => c.dns.updateIntervalMs, set: (c, v) => (c.dns.updateIntervalMs = v), format: mins,
        info: {
          what: 'How often RTB Fabric’s publisher Lambda runs — it updates the Route53 record set with the IPs of the healthy servers.',
          how: 'The zone is a private hosted zone (Route53 does not health-check it); each Lambda run evaluates server health and republishes the healthy set, failing open if none are healthy.',
          expect: 'A serial lag before a change reaches traffic: this interval + TTL (+ boot, for new capacity). Shrinking it alone barely moves surge absorption — boot and TTL dominate.',
        },
      },
      {
        label: 'Propagation', min: 0, max: 30000, step: 1000, get: (c) => c.dns.propagationMs, set: (c, v) => (c.dns.propagationMs = v), format: secs,
        info: {
          what: 'Extra delay before a published record set takes effect.',
          how: 'Models resolver propagation on top of the Lambda interval. RTB Fabric returns all healthy records to every client (no multivalue subset).',
          expect: 'Adds directly to how long a removed server keeps being handed out.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Server health (Lambda)',
    scope: 'sim',
    knobs: [
      {
        label: 'Unhealthy after', min: 1, max: 10, step: 1, get: (c) => c.health.unhealthyThreshold, set: (c, v) => (c.health.unhealthyThreshold = v), format: (v) => `${v} runs`,
        info: {
          what: 'Consecutive Lambda runs a server is unhealthy before it is pulled from DNS.',
          how: 'Detection lag ≈ this × the Lambda interval (e.g. 2 runs × 1 min = ~2 min). 1 = removed on the next run.',
          expect: 'Higher tolerates blips but slows removal of a genuinely dead server; the dead IP keeps getting traffic until its caching cohorts re-resolve.',
        },
      },
      {
        label: 'Healthy after', min: 1, max: 10, step: 1, get: (c) => c.health.healthyThreshold, set: (c, v) => (c.health.healthyThreshold = v), format: (v) => `${v} runs`,
        info: {
          what: 'Consecutive Lambda runs a server is healthy before it is (re)added to DNS.',
          how: 'The grace a freshly booted server waits before being advertised — hysteresis against flapping.',
          expect: 'Higher is steadier but delays new capacity entering rotation on top of boot + warm-up.',
        },
      },
    ],
    toggles: [
      {
        label: 'Overload marks unhealthy', get: (c) => c.health.overloadFailsHealth, set: (c, v) => (c.health.overloadFailsHealth = v),
        info: {
          what: 'Whether the Lambda marks an overloaded (RST-shedding) server unhealthy.',
          how: 'Off (default, realistic): a liveness check sees “accepting connections” and passes, so the Lambda does NOT pull an overwhelmed-but-up server — which is why the RST loop exists. On: a load-aware check pulls it.',
          expect: 'On can help DNS de-load a hot server, but risks flapping it in/out as load shifts; off leaves overload entirely to the fast RST loop.',
        },
      },
    ],
  },
  {
    name: 'Servers',
    scope: 'sim',
    knobs: [
      {
        label: 'Server count', min: 1, max: 50, step: 1, kind: 'structure', get: (c) => c.servers.count, set: (c, v) => (c.servers.count = v),
        info: {
          what: 'Baseline number of RTB Fabric servers.',
          how: 'Total fleet capacity = count × per-server capacity. autoReplace and autoscale maintain/grow it.',
          expect: 'Raising it adds headroom (and cost); lowering it tightens utilization toward the shed/overload knee.',
        },
      },
      {
        label: 'Per-server capacity', min: 200, max: 8000, step: 100, get: (c) => c.servers.capacityPerSec, set: (c, v) => (c.servers.capacityPerSec = v), format: perSec,
        info: {
          what: 'Requests/sec one server serves before it sheds.',
          how: 'A server above shed-threshold × capacity is overloaded and sheds the excess via RST.',
          expect: 'Higher capacity per box means more headroom per server and fewer hot spots.',
        },
      },
      {
        label: 'Shed threshold', min: 0.5, max: 1, step: 0.05, get: (c) => c.servers.shedThreshold, set: (c, v) => (c.servers.shedThreshold = v), format: pct,
        info: {
          what: 'Load fraction at which a server is “overloaded” and starts shedding.',
          how: 'A soft knee below 1.0 sheds before the hard limit, leaving margin and damping flapping.',
          expect: 'Lower sheds earlier (protective, more RST churn); near 1.0 packs servers fuller before shedding.',
        },
      },
      {
        label: 'Boot time', min: 30000, max: 900000, step: 30000, get: (c) => c.servers.bootMs, set: (c, v) => (c.servers.bootMs = v), format: mins,
        info: {
          what: 'Time from launch to serving for a new/replacement server.',
          how: 'A booting server is not advertised and serves nothing; on completion it becomes healthy and warms up.',
          expect: 'The dominant term in scale-out time. ~5 min is typical and far longer than any short surge.',
        },
      },
      {
        label: 'Warm-up', min: 0, max: 300000, step: 10000, get: (c) => c.servers.warmupMs, set: (c, v) => (c.servers.warmupMs = v), format: secs,
        info: {
          what: 'After boot, how long capacity ramps to full (cold caches/JIT).',
          how: 'A just-healthy server serves at reduced capacity, climbing linearly to full over this window.',
          expect: 'Longer warm-up means new capacity helps gradually, not instantly — scale-out is even slower than boot alone.',
        },
      },
      {
        label: 'Drain time', min: 0, max: 120000, step: 5000, get: (c) => c.servers.drainMs, set: (c, v) => (c.servers.drainMs = v), format: secs,
        info: {
          what: 'How long a gracefully removed server keeps serving cached traffic before going down.',
          how: 'A drained server is pulled from DNS immediately but still answers existing/cached connections, so loss is low. A hard kill skips this and black-holes.',
          expect: 'Longer drains hide a removal from clients until their caches expire — graceful replace vs hard failure.',
        },
      },
    ],
    toggles: [
      {
        label: 'RST shedding (fast loop)', get: (c) => c.servers.rstShedding, set: (c, v) => (c.servers.rstShedding = v),
        info: {
          what: 'Whether overloaded servers shed with RSTs so clients re-pick another cached IP.',
          how: 'On: the excess at a hot server redistributes within each cohort’s cached set (sub-second). Off: the excess is simply lost — no re-pick.',
          expect: 'The central protection. With it, a surge redistributes to headroom; without it, hot spots fail long before DNS can react.',
        },
      },
      {
        label: 'Auto-replace failed', get: (c) => c.servers.autoReplace, set: (c, v) => (c.servers.autoReplace = v),
        info: {
          what: 'Whether a failed/killed server is replaced by a fresh boot to hold fleet size.',
          how: 'On: a replacement starts booting (~5 min) when a server goes down. Off: the fleet shrinks until you add capacity.',
          expect: 'On models an ASG holding desired count; off lets you watch survivors absorb the loss alone.',
        },
      },
    ],
  },
  {
    name: 'Autoscaling',
    scope: 'sim',
    knobs: [
      {
        label: 'Target utilization', min: 0.3, max: 0.95, step: 0.05, get: (c) => c.scaling.targetUtilization, set: (c, v) => (c.scaling.targetUtilization = v), format: pct,
        info: {
          what: 'Fleet utilization that triggers a reactive scale-out.',
          how: 'When demand ÷ serving capacity exceeds this for a cooldown, new servers launch (and boot ~5 min).',
          expect: 'Lower scales out earlier (more headroom, more cost). Either way, reactive capacity arrives too late for a short surge.',
        },
      },
      {
        label: 'Scale step', min: 1, max: 10, step: 1, get: (c) => c.scaling.scaleStep, set: (c, v) => (c.scaling.scaleStep = v),
        info: {
          what: 'Servers launched per scale-out step.',
          how: 'Each step adds this many booting servers, then waits out the cooldown.',
          expect: 'Bigger steps add capacity faster once booted, at higher cost if the surge passes.',
        },
      },
      {
        label: 'Cooldown', min: 10000, max: 300000, step: 10000, get: (c) => c.scaling.cooldownMs, set: (c, v) => (c.scaling.cooldownMs = v), format: mins,
        info: {
          what: 'Minimum time between scale-out steps.',
          how: 'Prevents launching a huge fleet before the first batch has booted and taken load.',
          expect: 'Too short over-provisions; too long starves a sustained surge of capacity.',
        },
      },
      {
        label: 'Max servers', min: 1, max: 80, step: 1, kind: 'plain', get: (c) => c.scaling.maxServers, set: (c, v) => (c.scaling.maxServers = v),
        info: {
          what: 'Ceiling on fleet size from autoscaling + manual adds.',
          how: 'Scale-out and the add-servers action stop here.',
          expect: 'Caps cost and blast radius; set below demand and a big surge can’t ever be fully served.',
        },
      },
    ],
    toggles: [
      {
        label: 'Reactive autoscale', get: (c) => c.scaling.autoScaleEnabled, set: (c, v) => (c.scaling.autoScaleEnabled = v),
        info: {
          what: 'Whether the fleet scales out automatically under sustained overload.',
          how: 'On: launches servers when utilization passes the target. Off: capacity is whatever you provisioned.',
          expect: 'Compare reactive (cheap, slow) against pre-provisioned headroom (costly, instant) under the same surge.',
        },
      },
    ],
  },
];

type Totals = DnsSimulation['metrics']['totals'];

const TOTAL_METRICS: Array<{ key: string; color: string; value(t: Totals): string }> = [
  { key: 'availability', color: 'var(--ok)', value: (t) => `${(t.offered > 0 ? (t.served / t.offered) * 100 : 100).toFixed(2)}%` },
  { key: 'lost·impr', color: 'var(--bad)', value: (t) => fmtBig(t.lostImpressions) },
  { key: 'served', color: 'var(--ok)', value: (t) => fmtBig(t.served) },
  { key: 'shed (RST)', color: 'var(--warn)', value: (t) => fmtBig(t.shed) },
  { key: 'stale→dead', color: 'var(--err)', value: (t) => fmtBig(t.staleHit) },
  { key: 're-resolves', color: 'var(--retry)', value: (t) => fmtBig(t.reResolves) },
  { key: 'scale-outs', color: 'var(--info)', value: (t) => String(t.scaleOutEvents) },
  { key: 'replacements', color: 'var(--info)', value: (t) => String(t.serverReplacements) },
  { key: 'fleet use', color: 'var(--ok)', value: (t) => `${(t.provisionedSeconds > 0 ? (t.servedSeconds / t.provisionedSeconds) * 100 : 0).toFixed(0)}%` },
];

export class DnsControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private lastTotalsHtml = '';
  private renderedEvents: number[] = [];
  private pulseFactor = 2;
  private pulseDurationMs = 60000;
  private pauseBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private paneTabBtns: HTMLButtonElement[] = [];
  private activePane = 0;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: DnsControlHooks;
  private legend!: DnsLegend;
  private overview!: DnsOverview;

  constructor(side: HTMLElement, header: HTMLElement, hooks: DnsControlHooks) {
    this.side = side;
    this.header = header;
    this.hooks = hooks;
    this.buildHeaderControls();
    this.buildPresets();
    this.buildKnobs();
    this.buildTotals();
    this.buildEventLog();
  }

  destroy(): void {
    this.legend.destroy();
    this.overview.destroy();
  }

  // -- Header ------------------------------------------------------------------

  private buildHeaderControls(): void {
    const wrap = el('div', 'time-controls');

    const pulseBtn = el('button', 'btn btn-pulse', '◉ PULSE ×2');
    pulseBtn.title = 'Inject a traffic surge (×factor for the set duration; hits every sim)';
    pulseBtn.addEventListener('click', () => this.hooks.pulse(this.pulseFactor, this.pulseDurationMs));
    wrap.appendChild(pulseBtn);
    const pulseFactor = this.miniSlider(1.2, 4, 0.1, this.pulseFactor, (v) => {
      this.pulseFactor = v;
      pulseBtn.textContent = `◉ PULSE ×${v.toFixed(1)}`;
    });
    pulseFactor.title = 'Pulse intensity';
    wrap.appendChild(pulseFactor);

    const killBtn = el('button', 'btn', '✕ KILL SERVER');
    killBtn.title = 'Hard-kill a healthy server (black-holes its cached traffic until DNS + TTL move clients off)';
    killBtn.addEventListener('click', () => this.hooks.killServer(false));
    wrap.appendChild(killBtn);

    const addBtn = el('button', 'btn', '＋ ADD SERVERS');
    addBtn.title = 'Manually launch 2 servers (they boot in)';
    addBtn.addEventListener('click', () => this.hooks.addServers(2));
    wrap.appendChild(addBtn);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    wrap.appendChild(this.pauseBtn);

    // Speed slider: wide log range (1× .. 600×) so a 5-min boot can play in ~½s.
    const speedWrap = el('div', 'speed-wrap');
    const speedLabel = el('span', 'speed-label');
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '1';
    speed.step = '0.005';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(1), Math.log10(600), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(1)) / (Math.log10(600) - Math.log10(1));
    const syncSpeedLabel = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 1 ? `${Math.round(s)}× speed` : `${(1 / s).toFixed(0)}× slower`;
    };
    speed.value = String(fromScale(this.clampScale(this.hooks.getTimeScale())));
    speed.addEventListener('input', () => {
      this.hooks.setTimeScale(toScale(parseFloat(speed.value)));
      syncSpeedLabel();
    });
    syncSpeedLabel();
    speedWrap.append(speed, speedLabel);
    wrap.appendChild(speedWrap);

    const resetBtn = el('button', 'btn', '↺ RESET');
    resetBtn.title = 'Restart the simulation with the current settings';
    resetBtn.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(resetBtn);

    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.title = 'Run two simulations side by side under the same offered load';
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);

    this.overview = new DnsOverview(wrap, () => this.cfgFor('sim'));
    this.legend = new DnsLegend(wrap);

    this.header.appendChild(wrap);
  }

  private clampScale(s: number): number {
    return Math.min(600, Math.max(1, s));
  }

  private miniSlider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mini';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => onInput(parseFloat(input.value)));
    return input;
  }

  // -- Presets -----------------------------------------------------------------

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));

    const grid = el('div', 'preset-grid single-only');
    for (const preset of DNS_PRESETS) {
      const card = el('button', 'preset-card');
      card.dataset.preset = preset.id;
      card.appendChild(el('div', 'preset-name', preset.name));
      card.appendChild(el('div', 'preset-desc', preset.description));
      card.addEventListener('click', () => {
        this.hooks.loadPreset(preset.id);
        this.setActivePreset(preset.id);
        this.refreshKnobs();
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);

    const cmp = el('div', 'compare-only');
    PANE_TAGS.forEach((tag, pane) => {
      const row = el('div', 'scenario-row');
      row.appendChild(el('span', `scenario-tag tag-${tag.toLowerCase()}`, `SIM ${tag}`));
      const btns = el('div', 'scenario-btns');
      for (const preset of DNS_PRESETS) {
        const b = el('button', 'preset-mini', preset.name);
        b.dataset.preset = preset.id;
        b.dataset.pane = String(pane);
        b.title = preset.description;
        b.addEventListener('click', () => {
          this.hooks.applyScenario(pane, preset.id);
          this.setActiveScenario(pane, preset.id);
        });
        btns.appendChild(b);
      }
      row.appendChild(btns);
      cmp.appendChild(row);
    });
    cmp.appendChild(
      el('div', 'scenario-note', 'A scenario sets that sim’s DNS, health, server & scaling tuning; the offered load (Traffic) applies to both sims.'),
    );
    const helpBtn = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS');
    helpBtn.addEventListener('click', () => this.hooks.showCompareHelp());
    cmp.appendChild(helpBtn);
    section.appendChild(cmp);

    this.side.appendChild(section);
    this.setActivePreset(DNS_PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => c.classList.toggle('active', c.dataset.preset === id));
  }

  private setActiveScenario(pane: number, id: string | null): void {
    this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => b.classList.toggle('active', b.dataset.preset === id));
  }

  // -- Knobs -------------------------------------------------------------------

  private cfgFor(scope: KnobScope): DnsSimulationConfig {
    const sims = this.hooks.getSims();
    const idx = scope === 'sim' ? Math.min(this.activePane, sims.length - 1) : 0;
    return sims[idx].cfg;
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));

    // Traffic shape selector (its own row at the top of Traffic).
    for (const group of GROUPS) {
      if (group.scope === 'sim' && this.paneTabBtns.length === 0) {
        section.appendChild(this.buildPaneTabs());
      }
      const details = document.createElement('details');
      details.className = 'knob-group';
      if (group.name === 'DNS / Route 53' || group.name === 'Servers') details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      details.appendChild(summary);

      if (group.name === 'Traffic') details.appendChild(this.buildShapeSelector());

      for (const toggle of group.toggles) {
        const row = el('label', 'toggle-row');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const sync = () => (input.checked = toggle.get(this.cfgFor(group.scope)));
        sync();
        input.addEventListener('change', () => this.applyToggle(group.scope, toggle, input.checked));
        this.refreshers.push(sync);
        row.append(input, el('span', 'toggle-label', toggle.label));
        const info = toggle.info ? this.buildInfo(toggle.info) : null;
        if (info) row.appendChild(info.btn);
        details.appendChild(row);
        if (info) details.appendChild(info.panel);
      }

      for (const knob of group.knobs) {
        const row = el('div', 'knob-row');
        const labelEl = el('div', 'knob-label', knob.label);
        const valueEl = el('div', 'knob-value');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(knob.min);
        input.max = String(knob.max);
        input.step = String(knob.step);
        const fmt = knob.format ?? ((v: number) => String(Math.round(v * 100) / 100));
        const sync = () => {
          const v = knob.get(this.cfgFor(group.scope));
          input.value = String(v);
          valueEl.textContent = fmt(v);
        };
        sync();
        input.addEventListener('input', () => {
          this.applyKnob(group.scope, knob, parseFloat(input.value));
          valueEl.textContent = fmt(knob.get(this.cfgFor(group.scope)));
        });
        this.refreshers.push(sync);
        const top = el('div', 'knob-top');
        top.appendChild(labelEl);
        const meta = el('div', 'knob-meta');
        meta.appendChild(valueEl);
        const info = knob.info ? this.buildInfo(knob.info) : null;
        if (info) meta.appendChild(info.btn);
        top.appendChild(meta);
        row.append(top, input);
        if (info) row.appendChild(info.panel);
        details.appendChild(row);
      }
      section.appendChild(details);
    }
    this.side.appendChild(section);
  }

  private buildShapeSelector(): HTMLElement {
    const row = el('div', 'knob-row');
    const top = el('div', 'knob-top');
    top.appendChild(el('div', 'knob-label', 'Traffic shape'));
    row.appendChild(top);
    const seg = el('div', 'shape-seg');
    const shapes: TrafficShape[] = ['steady', 'ramp', 'pulse'];
    const btns: HTMLButtonElement[] = [];
    const sync = () => {
      const cur = this.cfgFor('global').traffic.shape;
      btns.forEach((b) => b.classList.toggle('active', b.dataset.shape === cur));
    };
    for (const s of shapes) {
      const b = el('button', 'shape-btn', s) as HTMLButtonElement;
      b.dataset.shape = s;
      b.addEventListener('click', () => {
        for (const sim of this.hooks.getSims()) sim.cfg.traffic.shape = s;
        this.hooks.configChanged('rate', 'all');
        sync();
        this.markCustom('global');
      });
      btns.push(b);
      seg.appendChild(b);
    }
    sync();
    this.refreshers.push(sync);
    row.appendChild(seg);
    return row;
  }

  private buildInfo(info: SettingInfo): { btn: HTMLButtonElement; panel: HTMLElement } {
    const btn = el('button', 'info-btn', 'ⓘ') as HTMLButtonElement;
    btn.type = 'button';
    btn.title = 'What this setting does';
    const panel = el('div', 'setting-info');
    for (const [tag, text] of [['What', info.what], ['How', info.how], ['Expect', info.expect]] as const) {
      const p = el('p', '');
      p.appendChild(el('b', '', tag));
      p.appendChild(document.createTextNode(` ${text}`));
      panel.appendChild(p);
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      btn.classList.toggle('active', open);
    });
    return { btn, panel };
  }

  private buildPaneTabs(): HTMLElement {
    const tabs = el('div', 'pane-tabs compare-only');
    tabs.appendChild(el('span', 'pane-tabs-label', 'These knobs edit'));
    PANE_TAGS.forEach((tag, i) => {
      const b = el('button', `pane-tab tag-${tag.toLowerCase()}`, `SIM ${tag}`) as HTMLButtonElement;
      b.addEventListener('click', () => {
        this.activePane = i;
        this.syncPaneTabs();
        this.refreshKnobs();
      });
      this.paneTabBtns.push(b);
      tabs.appendChild(b);
    });
    this.syncPaneTabs();
    return tabs;
  }

  private syncPaneTabs(): void {
    this.paneTabBtns.forEach((b, i) => b.classList.toggle('active', i === this.activePane));
  }

  private applyKnob(scope: KnobScope, knob: KnobDef, v: number): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) knob.set(sim.cfg, v);
      this.hooks.configChanged(knob.kind ?? 'plain', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      knob.set(sims[idx].cfg, v);
      this.hooks.configChanged(knob.kind ?? 'plain', idx);
    }
    this.markCustom(scope);
  }

  private applyToggle(scope: KnobScope, toggle: ToggleDef, v: boolean): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) toggle.set(sim.cfg, v);
      this.hooks.configChanged('plain', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      toggle.set(sims[idx].cfg, v);
      this.hooks.configChanged('plain', idx);
    }
    this.markCustom(scope);
  }

  private markCustom(scope: KnobScope): void {
    if (!this.hooks.isCompare()) {
      this.setActivePreset(null);
      return;
    }
    if (scope === 'global') {
      this.setActiveScenario(0, null);
      this.setActiveScenario(1, null);
    } else {
      this.setActiveScenario(this.activePane, null);
    }
  }

  refreshKnobs(): void {
    for (const r of this.refreshers) r();
  }

  setCompareUI(on: boolean): void {
    this.compareBtn.classList.toggle('active', on);
    this.activePane = 0;
    this.syncPaneTabs();
    this.setActiveScenario(0, null);
    this.setActiveScenario(1, null);
    if (!on) this.setActivePreset(null);
    this.lastTotalsHtml = '';
    this.refreshKnobs();
  }

  // -- Totals & event log ------------------------------------------------------

  private buildTotals(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Run totals'));
    this.totalsEl = el('div', 'totals-grid');
    section.appendChild(this.totalsEl);
    this.side.appendChild(section);
  }

  private buildEventLog(): void {
    const section = el('div', 'panel-section eventlog-section');
    section.appendChild(el('h2', 'panel-title', 'Events'));
    this.logList = el('div', 'eventlog');
    section.appendChild(this.logList);
    this.side.appendChild(section);
  }

  update(): void {
    const glyph = this.hooks.isPaused() ? '▶' : '⏸';
    if (this.pauseBtn.textContent !== glyph) {
      this.pauseBtn.textContent = glyph;
      this.pauseBtn.classList.toggle('active', this.hooks.isPaused());
    }
    const sims = this.hooks.getSims();
    const compare = sims.length > 1;
    const html = compare ? totalsHtmlCompare(sims) : totalsHtmlSingle(sims[0]);
    if (this.lastTotalsHtml !== html) {
      this.lastTotalsHtml = html;
      this.totalsEl.className = compare ? 'totals-cmp' : 'totals-grid';
      this.totalsEl.innerHTML = html;
    }

    sims.forEach((sim, pane) => {
      const { events, totalLogged } = sim.metrics;
      const seen = this.renderedEvents[pane] ?? 0;
      if (totalLogged < seen) this.renderedEvents[pane] = 0;
      const unseen = Math.min(totalLogged - (this.renderedEvents[pane] ?? 0), events.length);
      for (let i = events.length - unseen; i < events.length; i++) {
        const ev = events[i];
        const row = el('div', `event event-${ev.severity}`);
        if (compare) row.appendChild(el('span', `event-tag tag-${PANE_TAGS[pane].toLowerCase()}`, PANE_TAGS[pane]));
        row.appendChild(el('span', 'event-time', `${(ev.time / 1000).toFixed(0)}s`));
        row.appendChild(el('span', 'event-msg', ev.message));
        this.logList.prepend(row);
        while (this.logList.children.length > 60) this.logList.lastChild?.remove();
      }
      this.renderedEvents[pane] = totalLogged;
    });
  }

  resetLog(): void {
    this.renderedEvents = [];
    this.logList.innerHTML = '';
  }
}

function totalsHtmlSingle(sim: DnsSimulation): string {
  const t = sim.metrics.totals;
  return TOTAL_METRICS.map(
    (m) => `<div class="total"><span style="color:${m.color}">${m.value(t)}</span><label>${m.key}</label></div>`,
  ).join('');
}

function totalsHtmlCompare(sims: DnsSimulation[]): string {
  const head =
    `<div class="cmp-row cmp-head"><label></label>` +
    sims.map((_, i) => `<span class="tag-${PANE_TAGS[i].toLowerCase()}">SIM ${PANE_TAGS[i]}</span>`).join('') +
    `</div>`;
  const rows = TOTAL_METRICS.map((m) => {
    const cells = sims.map((s) => `<span style="color:${m.color}">${m.value(s.metrics.totals)}</span>`).join('');
    return `<div class="cmp-row"><label>${m.key}</label>${cells}</div>`;
  }).join('');
  return head + rows + significanceHtml(sims);
}

/** Availability significance: a two-proportion z-test on served ÷ offered. */
function significanceHtml(sims: DnsSimulation[]): string {
  if (sims.length < 2) return '';
  const a = sims[0].metrics.totals;
  const b = sims[1].metrics.totals;
  const g = compareSuccessRates(Math.round(a.offered), Math.round(a.served), Math.round(b.offered), Math.round(b.served));
  const block = sigBlock(
    'Δ availability (B−A)',
    `${g.deltaPp >= 0 ? '+' : '−'}${Math.abs(g.deltaPp).toFixed(2)}pp`,
    g.enough,
    g.confidence,
    g.better ? `SIM ${g.better} better` : '',
    g.enough ? `z=${g.z.toFixed(2)} · p=${fmtP(g.pValue)}` : `n=${Math.round(a.offered)}/${Math.round(b.offered)}`,
  );
  const note =
    `<div class="cmp-sig-note">availability = served ÷ offered; the test assumes independent requests ` +
    `(correlated failures inflate confidence) — read it as directional</div>`;
  return block + note;
}

function sigBlock(label: string, delta: string, enough: boolean, confidence: number, lead: string, stats: string): string {
  let cls: string;
  let verdict: string;
  if (!enough) {
    cls = 'sig-wait';
    verdict = 'gathering data…';
  } else if (confidence >= 0.95) {
    cls = 'sig-strong';
    verdict = `significant (${Math.round(confidence * 100)}%)${lead ? ` · ${lead}` : ''}`;
  } else if (confidence > 0) {
    cls = 'sig-some';
    verdict = `weak (90%)${lead ? ` · ${lead}` : ''}`;
  } else {
    cls = 'sig-none';
    verdict = 'not significant — likely noise';
  }
  return (
    `<div class="cmp-sig ${cls}">` +
    `<div class="cmp-sig-head"><label>${label}</label><b>${delta}</b></div>` +
    `<div class="cmp-sig-verdict">${verdict}</div>` +
    `<div class="cmp-sig-stats">${stats}</div>` +
    `</div>`
  );
}

function fmtP(p: number): string {
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtBig(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
