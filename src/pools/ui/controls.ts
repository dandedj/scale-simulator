import { PROBE_NUMBER, PROBE_STRING, pathOfSetter } from '../../deeplink';
import type { OptionDoc } from '../../optionDoc';
import { SEMANTIC } from '../../render/colors';
import type { PoolSimulation } from '../engine/poolSimulation';
import { basePoolConfig, POOL_PRESETS } from '../engine/presets';
import type { HttpProtocol, PoolKeyStrategy, PoolOwnership, PoolPolicy, PoolSimulationConfig } from '../engine/types';

export const PANE_TAGS = ['A', 'B'] as const;
type Scope = 'global' | 'sim';
type SettingInfo = { what: string; how: string; expect: string };

interface KnobDef {
  label: string;
  min: number;
  max: number;
  step: number;
  get(c: PoolSimulationConfig): number;
  set(c: PoolSimulationConfig, value: number): void;
  format?(value: number): string;
  info: SettingInfo;
}

interface ChoiceDef {
  label: string;
  choices: Array<{ value: string; label: string }>;
  get(c: PoolSimulationConfig): string;
  set(c: PoolSimulationConfig, value: string): void;
  info: SettingInfo;
}

interface GroupDef {
  name: string;
  scope: Scope;
  knobs: KnobDef[];
  choices: ChoiceDef[];
}

export interface PoolControlHooks {
  getSims(): PoolSimulation[];
  loadPreset(id: string): void;
  applyScenario(pane: number, id: string): void;
  reset(): void;
  pulse(factor: number, durationMs: number): void;
  reconnectAll(): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(scale: number): void;
  getTimeScale(): number;
  configChanged(target: number | 'all'): void;
  setCompare(on: boolean): void;
  isCompare(): boolean;
  showCompareHelp(): void;
}

const count = (v: number) => fmtBig(v);
const qps = (v: number) => `${fmtBig(v)}/s`;
const ms = (v: number) => `${v.toFixed(0)}ms`;
const duration = (v: number) => v === 0 ? 'disabled' : v >= 60_000 ? `${(v / 60_000).toFixed(1)}m` : `${(v / 1000).toFixed(0)}s`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const factor = (v: number) => `${v.toFixed(2)}×`;
const unlimited = (v: number) => v === 0 ? 'unbounded' : String(Math.round(v));

const GROUPS: GroupDef[] = [
  {
    name: 'Traffic',
    scope: 'global',
    knobs: [
      {
        label: 'Customer request rate', min: 1_000, max: 1_000_000, step: 1_000,
        get: (c) => c.traffic.requestsPerSec, set: (c, v) => (c.traffic.requestsPerSec = v), format: qps,
        info: {
          what: 'Requests per second sent to this customer responder across the whole RTB Fabric fleet.',
          how: 'The rate is divided across every independently owned pool key. It is shared between A and B so comparisons see identical traffic.',
          expect: 'More throughput raises concurrency, but when key cardinality dominates, adding traffic may reuse existing sockets instead of adding many more.',
        },
      },
      {
        label: 'Response occupancy', min: 1, max: 500, step: 1,
        get: (c) => c.traffic.responseTimeMs, set: (c, v) => (c.traffic.responseTimeMs = v), format: ms,
        info: {
          what: 'How long a request occupies one HTTP connection, including responder service and network time.',
          how: 'Required concurrency is request rate × response time. HTTP/1 carries one request per connection; HTTP/2 divides it by streams per connection.',
          expect: 'Slow responders drive more simultaneous sockets even at unchanged QPS; latency is often the strongest load-dependent connection driver.',
        },
      },
      {
        label: 'Concurrency headroom', min: 1, max: 4, step: 0.05,
        get: (c) => c.traffic.concurrencyHeadroom, set: (c, v) => (c.traffic.concurrencyHeadroom = v), format: factor,
        info: {
          what: 'Safety factor for bursty arrivals and the long tail beyond mean response time.',
          how: 'Multiplies Little’s Law concurrency before the per-key connection requirement is rounded up.',
          expect: 'Lumpy traffic and latency variance lift each pool’s high-water mark; Hyper retains that extra idle inventory until expiry.',
        },
      },
      {
        label: 'Retry fraction', min: 0, max: 1, step: 0.05,
        get: (c) => c.traffic.retryFraction, set: (c, v) => (c.traffic.retryFraction = v), format: pct,
        info: {
          what: 'Fraction of requests that fail for lack of a usable pool connection and come back as retries.',
          how: 'Failures feed a smoothed retry rate into effective demand, capped by the maximum-retries multiplier.',
          expect: 'High retry rates sustain connect/reset churn after the responder has reached its socket ceiling.',
        },
      },
      {
        label: 'Max retry amplification', min: 0, max: 5, step: 1,
        get: (c) => c.traffic.maxRetries, set: (c, v) => (c.traffic.maxRetries = v), format: (v) => `${v}× base`,
        info: {
          what: 'Ceiling on retry traffic, expressed as a multiple of the original customer request rate.',
          how: 'Prevents the feedback loop from growing without bound in this fluid model.',
          expect: 'Lower caps protect the responder during reset storms; zero disables retries.',
        },
      },
    ],
    choices: [],
  },
  {
    name: 'RTB Fabric fleet',
    scope: 'sim',
    knobs: [
      {
        label: 'Fabric nodes', min: 1, max: 100, step: 1,
        get: (c) => c.fabric.nodes, set: (c, v) => (c.fabric.nodes = v), format: count,
        info: {
          what: 'RTB Fabric nodes carrying traffic for the customer.',
          how: 'Every node owns its own process-local clients and connection pools. In worker ownership, multiply again by cores.',
          expect: 'Scaling out can increase responder connection pressure even when total QPS stays fixed, because every new node adds a new warm-key floor.',
        },
      },
      {
        label: 'Cores / workers per node', min: 1, max: 128, step: 1,
        get: (c) => c.fabric.coresPerNode, set: (c, v) => (c.fabric.coresPerNode = v), format: count,
        info: {
          what: 'Worker processes on each vertically scaled RTB Fabric node.',
          how: 'With current worker-local ownership, each process has independent pool state that cannot reuse another process’s sockets.',
          expect: 'Larger machines can create more responder connections at the same fleet QPS when per-key traffic is sparse.',
        },
      },
    ],
    choices: [
      {
        label: 'Pool ownership',
        choices: [{ value: 'worker', label: 'worker-local' }, { value: 'node', label: 'node-shared' }],
        get: (c) => c.fabric.ownership, set: (c, v) => (c.fabric.ownership = v as PoolOwnership),
        info: {
          what: 'How many independently owned Hyper clients exist within a node.',
          how: 'Worker-local matches separate worker processes. Node-shared is a hypothetical architectural comparison; cloning one Hyper Client within a process reuses its underlying pool.',
          expect: 'Node sharing removes the cores-per-node multiplier, but cross-process sharing would require an architecture change.',
        },
      },
    ],
  },
  {
    name: 'Pool partitioning',
    scope: 'sim',
    knobs: [
      {
        label: 'Links to responder', min: 1, max: 64, step: 1,
        get: (c) => c.fabric.links,
        set: (c, v) => {
          c.fabric.links = v;
          c.fabric.uniqueEndpoints = Math.min(c.fabric.uniqueEndpoints, v);
        },
        format: count,
        info: {
          what: 'Requester→responder Links carrying traffic to this customer. Every Link points to exactly one configured endpoint.',
          how: 'The model creates every Link as an entity, attaches its one endpoint identity, and divides customer traffic across the Links.',
          expect: 'More Links grow connections linearly in the current design. Endpoint sharing removes this multiplier only where several Links point to the same endpoint.',
        },
      },
      {
        label: 'Unique Link endpoints', min: 1, max: 64, step: 1,
        get: (c) => Math.min(c.fabric.uniqueEndpoints, c.fabric.links),
        set: (c, v) => (c.fabric.uniqueEndpoints = Math.min(v, c.fabric.links)),
        format: count,
        info: {
          what: 'Distinct endpoint identities across all Links. Each identity has a DNS authority, certificate, port, and resolves to the responder instances’ IPs.',
          how: 'The value cannot exceed the Link count. Links are distributed as evenly as possible across these endpoints: one endpoint means all Links converge; one per Link means all differ.',
          expect: 'Fewer unique endpoints create more endpoint reuse. IP+cert+port or DNS-authority pooling can share those repeated identities; current Link-local pools cannot.',
        },
      },
    ],
    choices: [
      {
        label: 'Application pool key',
        choices: [
          { value: 'link-ip', label: 'Link×endpoint×IP' },
          { value: 'endpoint', label: 'IP+cert+port' },
          { value: 'dns', label: 'DNS authority' },
        ],
        get: (c) => c.fabric.keyStrategy, set: (c, v) => (c.fabric.keyStrategy = v as PoolKeyStrategy),
        info: {
          what: 'RTB Fabric’s application-level partition above the library pool.',
          how: 'Current keys every Link→endpoint→IP binding. Endpoint de-duplicates identical IP/cert/port destinations across Links. DNS uses one scheme+authority key per unique endpoint, matching Hyper’s native key shape when one Client is shared.',
          expect: 'Sharing removes only duplicate Link references to the same endpoint identity. Links that point to different endpoints remain separate.',
        },
      },
    ],
  },
  {
    name: 'Hyper / pool behavior',
    scope: 'sim',
    knobs: [
      {
        label: 'Idle timeout', min: 0, max: 300_000, step: 1_000,
        get: (c) => c.pool.idleTimeoutMs, set: (c, v) => (c.pool.idleTimeoutMs = v), format: duration,
        info: {
          what: 'Hyper legacy pool_idle_timeout; the documented default is 90 seconds. Zero models None (disabled).',
          how: 'Idle sockets survive until this age when a pool timer is installed. The model also uses the window to estimate how many sparse keys stay warm.',
          expect: 'Shorter timeouts lower the idle high-water mark after a burst, but increase reconnect/TLS churn when traffic returns.',
        },
      },
      {
        label: 'Max idle / key', min: 0, max: 256, step: 1,
        get: (c) => c.pool.maxIdlePerKey, set: (c, v) => (c.pool.maxIdlePerKey = v), format: unlimited,
        info: {
          what: 'Hyper legacy pool_max_idle_per_host. Zero represents the documented default usize::MAX (no practical limit).',
          how: 'It limits only connections sitting idle for one pool key. Busy and connecting sockets are not an active-connection cap.',
          expect: 'It trims a post-burst idle tail but cannot prevent a concurrent HTTP/1 connect surge from reaching the responder.',
        },
      },
      {
        label: 'Warm floor / key', min: 0, max: 16, step: 1,
        get: (c) => c.pool.minConnectionsPerKey, set: (c, v) => (c.pool.minConnectionsPerKey = v), format: count,
        info: {
          what: 'RTB Fabric’s configured minimum warm connection count for each application pool key; this is not a Hyper legacy builder option.',
          how: 'Multiplied by every owned key. The floor remains even when mean traffic concurrency is below one connection per key.',
          expect: 'At the two-node baseline, a floor of one creates 4,096 sockets versus 2,400 required by Little’s Law. Scaling to four nodes doubles the floor and reaches the responder ceiling.',
        },
      },
      {
        label: 'Connect + TLS time', min: 1, max: 500, step: 1,
        get: (c) => c.pool.connectTimeMs, set: (c, v) => (c.pool.connectTimeMs = v), format: ms,
        info: {
          what: 'TCP plus TLS time before a newly opened socket can carry a request.',
          how: 'Connection attempts remain visible as pending during this interval; failed requests can feed retries while it elapses.',
          expect: 'Longer setup widens the cold-start failure window and lets more demand overlap connection establishment.',
        },
      },
      {
        label: 'H1 checkout-race factor', min: 1, max: 2, step: 0.05,
        get: (c) => c.pool.checkoutRaceFactor, set: (c, v) => (c.pool.checkoutRaceFactor = v), format: factor,
        info: {
          what: 'Empirical overshoot from HTTP/1 requests racing an idle checkout against a new connect.',
          how: 'Hyper’s source allows every HTTP/1 request to connect independently; if checkout wins after connect started, that connect finishes in the background and returns to the pool. The model multiplies a growth batch by this factor.',
          expect: 'Higher concurrency during pool growth leaves more surplus idle sockets. Hyper coalesces HTTP/2 connection establishment, so this factor is ignored for H2.',
        },
      },
      {
        label: 'H2 streams / connection', min: 1, max: 1000, step: 1,
        get: (c) => c.pool.h2StreamsPerConnection, set: (c, v) => (c.pool.h2StreamsPerConnection = v), format: count,
        info: {
          what: 'Concurrent request streams one HTTP/2 connection can carry.',
          how: 'Only applies when protocol is HTTP/2; HTTP/1 always has one active request per connection.',
          expect: 'Multiplexing collapses concurrency-driven sockets, but cannot remove one-connection-per-owned-key cardinality unless keys are also shared.',
        },
      },
      {
        label: 'Max active / key', min: 1, max: 256, step: 1,
        get: (c) => c.pool.maxConnectionsPerKey, set: (c, v) => (c.pool.maxConnectionsPerKey = v), format: count,
        info: {
          what: 'Hypothetical alternative-library cap on established plus connecting sockets for each pool key.',
          how: 'Ignored by native Hyper policy. It is per key, so the absolute cap is still this value × independently owned key count.',
          expect: 'Bounds concurrency growth within a key, but a high-cardinality key scheme can still overwhelm the responder even at one connection per key.',
        },
      },
    ],
    choices: [
      {
        label: 'HTTP protocol',
        choices: [{ value: 'http1', label: 'HTTP/1.1' }, { value: 'http2', label: 'HTTP/2' }],
        get: (c) => c.pool.protocol, set: (c, v) => (c.pool.protocol = v as HttpProtocol),
        info: {
          what: 'Protocol between RTB Fabric and the customer responder.',
          how: 'HTTP/1 reserves a unique connection per in-flight request. HTTP/2 reservations are shared and Hyper suppresses duplicate connects for the same key.',
          expect: 'H2 can sharply reduce connections when the bidder supports it, especially after combining it with a lower-cardinality key.',
        },
      },
      {
        label: 'Pool policy',
        choices: [{ value: 'hyper', label: 'Hyper on-demand' }, { value: 'bounded', label: 'bounded alternative' }],
        get: (c) => c.pool.policy, set: (c, v) => (c.pool.policy = v as PoolPolicy),
        info: {
          what: 'Current Hyper legacy behavior versus a hypothetical client/pool with an active-connection limit.',
          how: 'Hyper grows on demand and only exposes idle controls. Bounded enforces Max active/key and leaves excess requests unserved/queued outside this pool model.',
          expect: 'A cap makes overload predictable, but needs a request queue, deadline, and deliberate shedding policy in production.',
        },
      },
    ],
  },
  {
    name: 'Customer responders',
    scope: 'sim',
    knobs: [
      {
        label: 'Responder instances', min: 1, max: 64, step: 1,
        get: (c) => c.responder.instances, set: (c, v) => (c.responder.instances = v), format: count,
        info: {
          what: 'Envoy or bidder instances receiving connections. Every responder owns one explicit destination IP.',
          how: 'Every Link endpoint resolves to this responder IP set. The aggregate connection budget is instances × per-instance limit, reduced by uneven placement because the hottest instance fails first.',
          expect: 'More instances raise capacity but also add per-IP pool keys under Link×endpoint×IP and IP+cert+port keying. DNS-authority keying avoids that pool-state multiplier.',
        },
      },
      {
        label: 'Connection limit / instance', min: 64, max: 16_384, step: 64,
        get: (c) => c.responder.connectionLimit, set: (c, v) => (c.responder.connectionLimit = v), format: count,
        info: {
          what: 'Maximum concurrent sockets accepted by each customer Envoy/responder.',
          how: 'New sockets beyond the hottest instance’s limit reset. The example configuration uses 1,024.',
          expect: 'Raising the limit buys room but can move the bottleneck to file descriptors, memory, or the bidder; reducing pool demand attacks the source.',
        },
      },
      {
        label: 'Connection placement skew', min: 0, max: 1, step: 0.05,
        get: (c) => c.responder.connectionSkew, set: (c, v) => (c.responder.connectionSkew = v), format: pct,
        info: {
          what: 'How far the hottest responder’s connection count sits above the mean.',
          how: 'A 20% skew means the hottest instance reaches its limit when the fleet-wide average is only 83% of that limit.',
          expect: 'More skew wastes aggregate responder capacity and starts resets earlier; inspect the hottest instance, not only total connections.',
        },
      },
    ],
    choices: [],
  },
];

export function describePoolOptions(): OptionDoc[] {
  const base = basePoolConfig();
  const docs: OptionDoc[] = [];
  for (const group of GROUPS) {
    for (const knob of group.knobs) {
      const value = knob.get(base);
      docs.push({
        group: group.name, label: knob.label,
        path: pathOfSetter(base, knob.set, PROBE_NUMBER),
        kind: 'range', range: { min: knob.min, max: knob.max, step: knob.step },
        value: (knob.format ?? String)(value), info: knob.info,
      });
    }
    for (const choice of group.choices) {
      const value = choice.get(base);
      docs.push({
        group: group.name, label: choice.label,
        path: pathOfSetter(base, choice.set, PROBE_STRING),
        kind: 'choice', choices: choice.choices.map((c) => c.label),
        value: choice.choices.find((c) => c.value === value)?.label ?? value, info: choice.info,
      });
    }
  }
  return docs;
}

export class PoolControlPanel {
  private refreshers: Array<() => void> = [];
  private pauseBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private totalsEl!: HTMLElement;
  private logList!: HTMLElement;
  private lastTotalsHtml = '';
  private renderedEvents: number[] = [];
  private paneTabs: HTMLButtonElement[] = [];
  private activePane = 0;
  private pulseFactor = 2;
  private pulseDurationMs = 30_000;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: PoolControlHooks;

  constructor(side: HTMLElement, header: HTMLElement, hooks: PoolControlHooks) {
    this.side = side;
    this.header = header;
    this.hooks = hooks;
    this.buildHeader();
    this.buildPresets();
    this.buildResearchNote();
    this.buildKnobs();
    this.buildTotals();
    this.buildLog();
  }

  destroy(): void {}

  private buildHeader(): void {
    const wrap = el('div', 'time-controls');
    const pulse = el('button', 'btn btn-pulse', '◉ SURGE ×2.0') as HTMLButtonElement;
    pulse.title = 'Double traffic for 30 simulated seconds in every pane';
    pulse.addEventListener('click', () => this.hooks.pulse(this.pulseFactor, this.pulseDurationMs));
    wrap.appendChild(pulse);
    const surge = document.createElement('input');
    surge.type = 'range'; surge.className = 'mini'; surge.min = '1.2'; surge.max = '5'; surge.step = '0.1'; surge.value = '2';
    surge.title = 'Traffic surge multiplier';
    surge.addEventListener('input', () => { this.pulseFactor = +surge.value; pulse.textContent = `◉ SURGE ×${this.pulseFactor.toFixed(1)}`; });
    wrap.appendChild(surge);

    const recycle = el('button', 'btn', '⟳ RECONNECT ALL') as HTMLButtonElement;
    recycle.title = 'Close every outbound socket and let on-demand pool growth rebuild them';
    recycle.addEventListener('click', () => this.hooks.reconnectAll());
    wrap.appendChild(recycle);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    wrap.appendChild(this.pauseBtn);

    const speedWrap = el('div', 'speed-wrap');
    const speed = document.createElement('input');
    const speedLabel = el('span', 'speed-label');
    speed.type = 'range'; speed.min = '0'; speed.max = '1'; speed.step = '0.01';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(0.2), Math.log10(50), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(0.2)) / (Math.log10(50) - Math.log10(0.2));
    const syncSpeed = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 1 ? `${s.toFixed(s < 10 ? 1 : 0)}×` : `${(1 / s).toFixed(0)}× slow`;
    };
    speed.value = String(fromScale(Math.min(50, Math.max(0.2, this.hooks.getTimeScale()))));
    speed.addEventListener('input', () => { this.hooks.setTimeScale(toScale(+speed.value)); syncSpeed(); });
    syncSpeed(); speedWrap.append(speed, speedLabel); wrap.appendChild(speedWrap);

    const reset = el('button', 'btn', '↺ RESET') as HTMLButtonElement;
    reset.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(reset);
    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);
    this.header.appendChild(wrap);
  }

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));
    const grid = el('div', 'preset-grid single-only');
    for (const preset of POOL_PRESETS) {
      const card = el('button', 'preset-card');
      card.dataset.preset = preset.id;
      card.append(el('div', 'preset-name', preset.name), el('div', 'preset-desc', preset.description));
      card.addEventListener('click', () => { this.hooks.loadPreset(preset.id); this.setActivePreset(preset.id); });
      grid.appendChild(card);
    }
    section.appendChild(grid);

    const compare = el('div', 'compare-only');
    PANE_TAGS.forEach((tag, pane) => {
      const row = el('div', 'scenario-row');
      row.appendChild(el('span', `scenario-tag tag-${tag.toLowerCase()}`, `SIM ${tag}`));
      const buttons = el('div', 'scenario-btns');
      for (const preset of POOL_PRESETS) {
        const button = el('button', 'preset-mini', preset.name) as HTMLButtonElement;
        button.dataset.preset = preset.id; button.dataset.pane = String(pane); button.title = preset.description;
        button.addEventListener('click', () => { this.hooks.applyScenario(pane, preset.id); this.setActiveScenario(pane, preset.id); });
        buttons.appendChild(button);
      }
      row.appendChild(buttons); compare.appendChild(row);
    });
    compare.appendChild(el('div', 'scenario-note', 'Traffic settings are shared; fleet, pool, keying, protocol, and responder settings are per simulation.'));
    const help = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS') as HTMLButtonElement;
    help.addEventListener('click', () => this.hooks.showCompareHelp());
    compare.appendChild(help); section.appendChild(compare); this.side.appendChild(section);
    this.setActivePreset(POOL_PRESETS[0].id);
  }

  private buildResearchNote(): void {
    const details = document.createElement('details');
    details.className = 'panel-section pool-research';
    const summary = document.createElement('summary');
    summary.textContent = 'Model basis · hyper-util 0.1.20';
    details.appendChild(summary);
    const p = el('div', 'pool-research-body');
    p.innerHTML =
      'Hyper legacy pools by <b>scheme + authority</b>; cloned Clients reuse one underlying pool. ' +
      'Its documented controls are <code>pool_idle_timeout</code> (90s default) and ' +
      '<code>pool_max_idle_per_host</code> (unbounded default). The latter is not an active cap. ' +
      'HTTP/1 connects are independent; HTTP/2 establishment is coalesced per key. ' +
      '<a href="https://docs.rs/hyper-util/latest/hyper_util/client/legacy/struct.Builder.html" target="_blank" rel="noreferrer">Builder docs</a> · ' +
      '<a href="https://docs.rs/hyper-util/latest/src/hyper_util/client/legacy/client.rs.html" target="_blank" rel="noreferrer">client source</a> · ' +
      '<a href="https://docs.rs/hyper-util/latest/src/hyper_util/client/legacy/pool.rs.html" target="_blank" rel="noreferrer">pool source</a>.';
    details.appendChild(p); this.side.appendChild(details);
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    let tabsBuilt = false;
    for (const group of GROUPS) {
      if (group.scope === 'sim' && !tabsBuilt) { section.appendChild(this.buildPaneTabs()); tabsBuilt = true; }
      const details = document.createElement('details');
      details.className = 'knob-group';
      details.open = group.name === 'RTB Fabric fleet' || group.name === 'Pool partitioning' || group.name === 'Customer responders';
      const summary = document.createElement('summary'); summary.textContent = group.name; details.appendChild(summary);
      for (const choice of group.choices) details.appendChild(this.buildChoice(group.scope, choice));
      for (const knob of group.knobs) details.appendChild(this.buildKnob(group.scope, knob));
      section.appendChild(details);
    }
    this.side.appendChild(section);
  }

  private buildKnob(scope: Scope, knob: KnobDef): HTMLElement {
    const row = el('div', 'knob-row');
    const top = el('div', 'knob-top');
    top.appendChild(el('div', 'knob-label', knob.label));
    const meta = el('div', 'knob-meta'); const value = el('div', 'knob-value'); const info = this.info(knob.info);
    meta.append(value, info.button); top.appendChild(meta);
    const input = document.createElement('input'); input.type = 'range'; input.min = String(knob.min); input.max = String(knob.max); input.step = String(knob.step);
    const format = knob.format ?? ((v: number) => String(v));
    const sync = () => { const v = knob.get(this.cfg(scope)); input.value = String(v); value.textContent = format(v); };
    sync(); this.refreshers.push(sync);
    input.addEventListener('input', () => { this.apply(scope, (c) => knob.set(c, +input.value)); value.textContent = format(knob.get(this.cfg(scope))); });
    row.append(top, input, info.panel); return row;
  }

  private buildChoice(scope: Scope, choice: ChoiceDef): HTMLElement {
    const row = el('div', 'knob-row');
    const top = el('div', 'knob-top'); top.appendChild(el('div', 'knob-label', choice.label));
    const info = this.info(choice.info); top.appendChild(info.button); row.appendChild(top);
    const seg = el('div', 'shape-seg'); const buttons: HTMLButtonElement[] = [];
    const sync = () => { const cur = choice.get(this.cfg(scope)); buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === cur)); };
    for (const option of choice.choices) {
      const button = el('button', 'shape-btn', option.label) as HTMLButtonElement;
      button.dataset.value = option.value;
      button.addEventListener('click', () => { this.apply(scope, (c) => choice.set(c, option.value)); sync(); });
      buttons.push(button); seg.appendChild(button);
    }
    sync(); this.refreshers.push(sync); row.append(seg, info.panel); return row;
  }

  private info(content: SettingInfo): { button: HTMLButtonElement; panel: HTMLElement } {
    const button = el('button', 'info-btn', 'ⓘ') as HTMLButtonElement; button.type = 'button';
    const panel = el('div', 'setting-info');
    for (const [label, text] of [['What', content.what], ['How', content.how], ['Expect', content.expect]] as const) {
      const p = el('p', ''); p.append(el('b', '', label), document.createTextNode(` ${text}`)); panel.appendChild(p);
    }
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); button.classList.toggle('active', panel.classList.toggle('open')); });
    return { button, panel };
  }

  private buildPaneTabs(): HTMLElement {
    const tabs = el('div', 'pane-tabs compare-only'); tabs.appendChild(el('span', 'pane-tabs-label', 'These knobs edit'));
    PANE_TAGS.forEach((tag, i) => {
      const b = el('button', `pane-tab tag-${tag.toLowerCase()}`, `SIM ${tag}`) as HTMLButtonElement;
      b.addEventListener('click', () => { this.activePane = i; this.syncTabs(); this.refreshKnobs(); });
      this.paneTabs.push(b); tabs.appendChild(b);
    });
    this.syncTabs(); return tabs;
  }

  private cfg(scope: Scope): PoolSimulationConfig {
    const sims = this.hooks.getSims();
    return sims[scope === 'global' ? 0 : Math.min(this.activePane, sims.length - 1)].cfg;
  }

  private apply(scope: Scope, change: (c: PoolSimulationConfig) => void): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) change(sim.cfg);
      this.hooks.configChanged('all');
    } else {
      const pane = Math.min(this.activePane, sims.length - 1);
      change(sims[pane].cfg); this.hooks.configChanged(pane);
    }
    this.markCustom(scope);
  }

  private buildTotals(): void {
    const section = el('div', 'panel-section'); section.appendChild(el('h2', 'panel-title', 'Run totals'));
    this.totalsEl = el('div', 'totals-grid'); section.appendChild(this.totalsEl); this.side.appendChild(section);
  }

  private buildLog(): void {
    const section = el('div', 'panel-section eventlog-section'); section.appendChild(el('h2', 'panel-title', 'Events'));
    this.logList = el('div', 'eventlog'); section.appendChild(this.logList); this.side.appendChild(section);
  }

  update(): void {
    const glyph = this.hooks.isPaused() ? '▶' : '⏸';
    if (this.pauseBtn.textContent !== glyph) { this.pauseBtn.textContent = glyph; this.pauseBtn.classList.toggle('active', this.hooks.isPaused()); }
    const sims = this.hooks.getSims();
    const html = sims.length > 1 ? totalsCompare(sims) : totalsSingle(sims[0]);
    if (html !== this.lastTotalsHtml) { this.lastTotalsHtml = html; this.totalsEl.className = sims.length > 1 ? 'totals-cmp' : 'totals-grid'; this.totalsEl.innerHTML = html; }
    sims.forEach((sim, pane) => {
      const seen = this.renderedEvents[pane] ?? 0;
      if (sim.metrics.totalLogged < seen) this.renderedEvents[pane] = 0;
      const unseen = Math.min(sim.metrics.totalLogged - (this.renderedEvents[pane] ?? 0), sim.metrics.events.length);
      for (let i = sim.metrics.events.length - unseen; i < sim.metrics.events.length; i++) {
        const event = sim.metrics.events[i]; const row = el('div', `event event-${event.severity}`);
        if (sims.length > 1) row.appendChild(el('span', `event-tag tag-${PANE_TAGS[pane].toLowerCase()}`, PANE_TAGS[pane]));
        row.append(el('span', 'event-time', `${(event.time / 1000).toFixed(1)}s`), el('span', 'event-msg', event.message));
        this.logList.prepend(row); while (this.logList.children.length > 60) this.logList.lastChild?.remove();
      }
      this.renderedEvents[pane] = sim.metrics.totalLogged;
    });
  }

  refreshKnobs(): void { for (const refresh of this.refreshers) refresh(); }
  resetLog(): void { this.renderedEvents = []; this.logList.innerHTML = ''; }
  setActivePreset(id: string | null): void { this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => c.classList.toggle('active', c.dataset.preset === id)); }
  private setActiveScenario(pane: number, id: string | null): void { this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => b.classList.toggle('active', b.dataset.preset === id)); }
  private markCustom(scope: Scope): void {
    if (!this.hooks.isCompare()) this.setActivePreset(null);
    else if (scope === 'global') { this.setActiveScenario(0, null); this.setActiveScenario(1, null); }
    else this.setActiveScenario(this.activePane, null);
  }
  private syncTabs(): void { this.paneTabs.forEach((b, i) => b.classList.toggle('active', i === this.activePane)); }
  setCompareUI(on: boolean, scenarios?: Array<string | null>): void {
    this.compareBtn.classList.toggle('active', on); this.activePane = 0; this.syncTabs();
    this.setActiveScenario(0, scenarios?.[0] ?? null); this.setActiveScenario(1, scenarios?.[1] ?? null);
    if (!on) this.setActivePreset(null); this.lastTotalsHtml = ''; this.refreshKnobs();
  }
}

const TOTALS: Array<{ label: string; color: string; get(sim: PoolSimulation): string }> = [
  { label: 'Established now', color: SEMANTIC.connEstablished, get: (s) => fmtBig(s.snapshot().established) },
  { label: "Little's Law required", color: SEMANTIC.success, get: (s) => fmtBig(s.snapshot().littleLawRequired) },
  { label: 'Actual / required', color: SEMANTIC.timeout, get: (s) => formatRatio(s.snapshot().connectionAmplification, s.snapshot().littleLawRequired) },
  { label: 'Peak connections', color: SEMANTIC.tlsPulse, get: (s) => fmtBig(s.metrics.totals.peakConnections) },
  { label: 'Peak hottest', color: SEMANTIC.timeout, get: (s) => fmtBig(s.metrics.totals.peakHottestResponder) },
  { label: 'Connections opened', color: SEMANTIC.success, get: (s) => fmtBig(s.metrics.totals.connectionsOpened) },
  { label: 'Responder resets', color: SEMANTIC.timeout, get: (s) => fmtBig(s.metrics.totals.connectionResets) },
  { label: 'Requests served', color: SEMANTIC.success, get: (s) => `${(s.metrics.lifetimeSuccess() * 100).toFixed(1)}%` },
];

function totalsSingle(sim: PoolSimulation): string {
  return TOTALS.map((m) => `<div class="total"><span style="color:${m.color}">${m.get(sim)}</span><label>${m.label}</label></div>`).join('');
}

function totalsCompare(sims: PoolSimulation[]): string {
  const head = `<div class="cmp-row cmp-head"><label></label>${sims.map((_, i) => `<span class="tag-${PANE_TAGS[i].toLowerCase()}">SIM ${PANE_TAGS[i]}</span>`).join('')}</div>`;
  const rows = TOTALS.map((m) => `<div class="cmp-row"><label>${m.label}</label>${sims.map((s) => `<span style="color:${m.color}">${m.get(s)}</span>`).join('')}</div>`).join('');
  const a = sims[0].snapshot(); const b = sims[1].snapshot();
  const delta = b.established - a.established;
  return head + rows + `<div class="cmp-sig ${delta === 0 ? 'sig-none' : 'sig-strong'}"><div class="cmp-sig-head"><label>Δ established (B−A)</label><b>${delta >= 0 ? '+' : '−'}${fmtBig(Math.abs(delta))}</b></div><div class="cmp-sig-verdict">${delta === 0 ? 'same responder pressure' : delta < 0 ? 'SIM B uses fewer sockets' : 'SIM A uses fewer sockets'}</div></div>`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}

function fmtBig(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatRatio(value: number, required: number): string {
  return required <= 1e-7 ? '—' : `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
