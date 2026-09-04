import { applyOverrides, diff, LINK_KEYS, PANE_B_PREFIX, type LinkState } from '../deeplink';
import type { Experience, ExperienceHosts, PlaybackController } from '../experience';
import { clonePoolConfig, poolPresetById, POOL_PRESETS } from './engine/presets';
import { PoolSimulation } from './engine/poolSimulation';
import type { PoolSimulationConfig } from './engine/types';
import { PoolChartRail } from './render/charts';
import { PoolRenderer } from './render/renderer';
import { PANE_TAGS, PoolControlPanel } from './ui/controls';

const DEFAULT_TIME_SCALE = 1;
const MAX_SIM_MS_PER_FRAME = 1000;
const SINGLE_HINT = 'Pick a pool scenario, tune the topology, then start. Use SURGE or RECONNECT ALL to expose growth.';
const COMPARE_HINT = 'Choose A and B pool designs, then start. Both receive identical customer traffic and events.';

const COMPARE_HELP = `
  <div class="help-card">
    <h2>Comparing outbound pools</h2>
    <ul>
      <li><b>Same customer traffic.</b> Request rate, response occupancy, concurrency headroom, and retries apply to both panes.</li>
      <li><b>Independent pool designs.</b> Fleet size, process ownership, Link endpoint membership and overlap, keying, Hyper behavior, protocol, and responder limits are tuned per pane.</li>
      <li><b>Follow the Link paths.</b> Every Link points to exactly one endpoint ID. Shared endpoint rows collect several paths; distinct endpoint rows collect one.</li>
      <li><b>See where pools live.</b> Every Fabric node row contains the full Link-pool set. The Link column shows one owner’s template and how many worker-local or node-shared copies exist.</li>
      <li><b>Read the multiplier first.</b> The top equation shows independently owned pool keys. One warm socket per key can dominate before throughput concurrency does.</li>
      <li><b>Check actual / Little’s Law.</b> This divides established sockets by the theoretical minimum for customer throughput and response occupancy. It excludes safety headroom, warm floors, and retries.</li>
      <li><b>SURGE and RECONNECT ALL hit both panes together.</b> Compare pool growth, idle retention, responder pressure, resets, and served traffic on one clock.</li>
      <li><b>Max idle is not max active.</b> Hyper’s max-idle setting trims returned sockets; only the hypothetical bounded policy limits established + connecting sockets.</li>
    </ul>
    <button id="pool-help-dismiss" class="btn">GOT IT</button>
  </div>`;

interface PaneStats { badge: HTMLElement; connections: HTMLElement; amplification: HTMLElement; pressure: HTMLElement }
interface Pane { sim: PoolSimulation; renderer: PoolRenderer; charts: PoolChartRail; stats: PaneStats | null }

export class PoolExperience implements Experience {
  readonly maxSimStepMs = MAX_SIM_MS_PER_FRAME;
  private panes: Pane[] = [];
  private compare = false;
  private linkScenario: Array<string | null> = [POOL_PRESETS[0].id, null];
  private controls!: PoolControlPanel;
  private playback!: PlaybackController;
  private hosts!: ExperienceHosts;
  private panesHost!: HTMLElement;
  private helpEl!: HTMLElement;
  private limitBadge!: HTMLElement;
  private hudConnections!: HTMLElement;
  private hudAmplification!: HTMLElement;
  private hudPressure!: HTMLElement;
  private appEl = document.getElementById('app')!;

  mount(hosts: ExperienceHosts, playback: PlaybackController): void {
    this.hosts = hosts; this.playback = playback; this.panesHost = hosts.stage;
    playback.setTimeScale(DEFAULT_TIME_SCALE);
    this.buildHud(); this.buildHelp(); this.buildPanes([clonePoolConfig(POOL_PRESETS[0].config)]);
    this.controls = new PoolControlPanel(hosts.side, hosts.header, {
      getSims: () => this.panes.map((p) => p.sim),
      loadPreset: (id) => { this.linkScenario = [id, null]; this.resetPanes([clonePoolConfig(poolPresetById(id).config)]); },
      applyScenario: (pane, id) => { this.linkScenario[pane] = id; this.applyScenario(pane, id); },
      reset: () => this.resetPanes(this.panes.map((p) => clonePoolConfig(p.sim.cfg))),
      pulse: (factor, duration) => { for (const p of this.panes) p.sim.triggerPulse(factor, duration); },
      reconnectAll: () => { for (const p of this.panes) p.sim.reconnectAll(); },
      setPaused: (v) => playback.setPaused(v), isPaused: () => playback.isPaused(),
      setTimeScale: (v) => playback.setTimeScale(v), getTimeScale: () => playback.getTimeScale(),
      configChanged: (target) => {
        const sims = target === 'all' ? this.panes.map((p) => p.sim) : this.panes[target] ? [this.panes[target].sim] : [];
        for (const sim of sims) sim.applyConfig();
      },
      setCompare: (v) => this.setCompare(v), isCompare: () => this.compare,
      showCompareHelp: () => this.helpEl.classList.remove('hidden'),
    });
    playback.setStartHint(SINGLE_HINT);
  }

  unmount(): void {
    this.controls.destroy(); this.appEl.classList.remove('compare'); this.helpEl.remove();
    this.hosts.hud.replaceChildren(); this.hosts.header.replaceChildren(); this.hosts.side.replaceChildren(); this.hosts.stage.replaceChildren();
  }
  step(dt: number): void { for (const pane of this.panes) pane.sim.step(dt); }
  render(): void { for (const pane of this.panes) { pane.renderer.draw(pane.sim); pane.charts.draw(pane.sim); } this.controls.update(); this.updateHud(); }
  resize(): void { for (const pane of this.panes) { pane.renderer.resize(); pane.charts.resize(); } }
  simTimeMs(): number { return this.panes[0]?.sim.now ?? 0; }
  onResume(): void { this.helpEl.classList.add('hidden'); }

  deepLink(): LinkState {
    const configs = this.panes.map((p) => p.sim.cfg);
    const a = this.linkScenario[0]; const b = this.linkScenario[1];
    const base = (id: string | null) => id ? poolPresetById(id).config : POOL_PRESETS[0].config;
    return {
      mode: '', scenario: a, scenarioB: this.compare ? b : null, compare: this.compare,
      overrides: configs[0] ? diff(base(a), configs[0]) : {},
      overridesB: this.compare && configs[1] ? diff(base(b), configs[1]) : {},
    };
  }

  applyDeepLink(params: URLSearchParams): void {
    const comparing = params.get(LINK_KEYS.compare) === '1';
    const known = (id: string | null) => id && POOL_PRESETS.some((p) => p.id === id) ? id : POOL_PRESETS[0].id;
    const a = known(params.get(LINK_KEYS.scenario)); const b = known(params.get(LINK_KEYS.scenarioB));
    const cfgA = clonePoolConfig(poolPresetById(a).config); applyOverrides(cfgA, params, '');
    const configs = [cfgA];
    if (comparing) { const cfgB = clonePoolConfig(poolPresetById(b).config); applyOverrides(cfgB, params, PANE_B_PREFIX); configs.push(cfgB); }
    this.compare = comparing; this.linkScenario = [a, comparing ? b : null]; this.resetPanes(configs);
    this.controls.setCompareUI(comparing, [a, b]); if (!comparing) this.controls.setActivePreset(a);
  }

  private buildHud(): void {
    this.limitBadge = el('div', 'single-only', '⚠ RESPONDER LIMIT'); this.limitBadge.id = 'pool-limit';
    const connections = el('div', 'hud-item single-only'); this.hudConnections = el('span', 'amp-ok', '0'); connections.append(this.hudConnections, label('connections'));
    const amplification = el('div', 'hud-item single-only'); this.hudAmplification = el('span', 'amp-ok', '0×'); amplification.append(this.hudAmplification, label("actual / Little's Law"));
    const pressure = el('div', 'hud-item single-only'); this.hudPressure = el('span', 'amp-ok', '0%'); pressure.append(this.hudPressure, label('hottest / limit'));
    this.hosts.hud.append(this.limitBadge, connections, amplification, pressure);
  }

  private buildHelp(): void {
    this.helpEl = el('div', 'hidden'); this.helpEl.id = 'compare-help'; this.helpEl.innerHTML = COMPARE_HELP;
    this.helpEl.querySelector('#pool-help-dismiss')!.addEventListener('click', () => this.helpEl.classList.add('hidden'));
    this.hosts.stageCol.appendChild(this.helpEl);
  }

  private buildPanes(configs: PoolSimulationConfig[]): void {
    this.panesHost.innerHTML = ''; const comparing = configs.length > 1; this.appEl.classList.toggle('compare', comparing);
    this.panes = configs.map((cfg, i) => {
      const root = el('section', 'pane'); let stats: PaneStats | null = null;
      if (comparing) {
        const bar = el('div', 'pane-bar'); const tag = el('span', `pane-tag tag-${PANE_TAGS[i].toLowerCase()}`, `SIM ${PANE_TAGS[i]}`);
        const badge = el('span', 'pane-storm', '⚠ RESPONDER LIMIT'); const statWrap = el('span', 'pane-stats');
        const connections = el('b', 'amp-ok', '0'); const amplification = el('b', 'amp-ok', '0×'); const pressure = el('b', 'amp-ok', '0%');
        statWrap.append(connections, ' connections · ', amplification, " actual/Little's Law · ", pressure, ' hottest/limit'); bar.append(tag, badge, statWrap); root.appendChild(bar);
        stats = { badge, connections, amplification, pressure };
      }
      const stage = el('div', 'pane-stage'); const canvas = document.createElement('canvas'); stage.appendChild(canvas);
      const chartsEl = el('div', 'pane-charts'); root.append(stage, chartsEl); this.panesHost.appendChild(root);
      return { sim: new PoolSimulation(clonePoolConfig(cfg)), renderer: new PoolRenderer(canvas), charts: new PoolChartRail(chartsEl), stats };
    });
    this.resize();
  }

  private resetPanes(configs: PoolSimulationConfig[]): void {
    this.buildPanes(configs); this.controls?.resetLog(); this.controls?.refreshKnobs(); this.playback.rearmGate();
  }

  private setCompare(on: boolean): void {
    if (this.compare === on) return; this.compare = on;
    const a = clonePoolConfig(this.panes[0].sim.cfg); this.linkScenario[1] = on ? this.linkScenario[0] : null;
    this.resetPanes(on ? [a, clonePoolConfig(a)] : [a]); this.controls.setCompareUI(on, this.linkScenario);
    this.helpEl.classList.toggle('hidden', !on); this.playback.setStartHint(on ? COMPARE_HINT : SINGLE_HINT);
  }

  private applyScenario(pane: number, id: string): void {
    const preset = clonePoolConfig(poolPresetById(id).config); const configs = this.panes.map((p) => clonePoolConfig(p.sim.cfg));
    if (!configs[pane]) return;
    configs[pane].fabric = preset.fabric; configs[pane].pool = preset.pool; configs[pane].responder = preset.responder;
    for (const config of configs) config.traffic = structuredClone(preset.traffic);
    this.resetPanes(configs);
  }

  private updateHud(): void {
    if (!this.compare) {
      const s = this.panes[0].sim.snapshot(); setStat(this.hudConnections, fmt(s.established), s.limitActive ? 'amp-bad' : 'amp-ok');
      setStat(this.hudAmplification, formatAmplification(s.connectionAmplification, s.littleLawRequired), amplificationClass(s.connectionAmplification, s.littleLawRequired));
      setStat(this.hudPressure, `${(s.responderPressure * 100).toFixed(0)}%`, pressureClass(s.responderPressure));
      this.limitBadge.classList.toggle('visible', s.limitActive); return;
    }
    for (const pane of this.panes) if (pane.stats) {
      const s = pane.sim.snapshot(); setStat(pane.stats.connections, fmt(s.established), s.limitActive ? 'amp-bad' : 'amp-ok');
      setStat(pane.stats.amplification, formatAmplification(s.connectionAmplification, s.littleLawRequired), amplificationClass(s.connectionAmplification, s.littleLawRequired));
      setStat(pane.stats.pressure, `${(s.responderPressure * 100).toFixed(0)}%`, pressureClass(s.responderPressure));
      pane.stats.badge.classList.toggle('visible', s.limitActive);
    }
  }
}

function pressureClass(value: number): string { return value >= 1 ? 'amp-bad' : value >= 0.8 ? 'amp-warn' : 'amp-ok'; }
function amplificationClass(value: number, required: number): string {
  if (required <= 1e-7 || (value >= 0.95 && value <= 1.25)) return 'amp-ok';
  if (value >= 0.75 && value <= 2) return 'amp-warn';
  return 'amp-bad';
}
function formatAmplification(value: number, required: number): string {
  return required <= 1e-7 ? '—' : `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}
function setStat(node: HTMLElement, text: string, cls: string): void { if (node.textContent !== text) node.textContent = text; if (node.className !== cls) node.className = cls; }
function fmt(v: number): string { return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)); }
function el(tag: string, cls: string, text?: string): HTMLElement { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function label(text: string): HTMLElement { const node = document.createElement('label'); node.textContent = text; return node; }
