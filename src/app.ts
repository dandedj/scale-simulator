/**
 * The connection-storm experience: owns the simulation panes (one in single
 * mode, two stacked in comparison mode), the renderers, charts, HUD chips, and
 * the control panel. In comparison mode both sims step the same virtual clock
 * each frame, so a pulse hits them simultaneously and their charts stay aligned.
 *
 * The requestAnimationFrame loop, time-dilation clock, pause/start-gate, and
 * mode switch live in the Shell (shell.ts); this class implements the
 * Experience interface the shell drives.
 */

import type { Experience, ExperienceHosts, PlaybackController } from './experience';
import { cloneConfig, presetById, PRESETS } from './engine/presets';
import { Simulation } from './engine/simulation';
import type { SimulationConfig } from './engine/types';
import { ChartRail } from './render/charts';
import { Renderer } from './render/renderer';
import { ControlPanel, PANE_TAGS } from './ui/controls';

/** Default playback: 10x slow motion — a 150ms request takes 1.5s on screen. */
const DEFAULT_TIME_SCALE = 0.1;
/** Cap sim advancement per frame so a speed spike can't freeze the page. */
const MAX_SIM_MS_PER_FRAME = 250;

const SINGLE_HINT = 'Pick a scenario and tune the knobs first — traffic flows when you start.';
const COMPARE_HINT = 'Tune each sim — A above, B below — then start. Both run on the same clock and traffic.';

const COMPARE_HELP_HTML = `
  <div class="help-card">
    <h2>Comparison mode</h2>
    <ul>
      <li><b>Two sims, one clock.</b> SIM A (top) and SIM B (bottom) run in lockstep on the same virtual clock, each with its own charts and totals.</li>
      <li><b>Shared traffic.</b> The Traffic knobs — client count and request rate — apply to both sims, so they always see the same offered load. Speed, pause, and reset are shared too.</li>
      <li><b>Per-sim tuning.</b> The Clients, RTB Fabric, Downstream pools, and Downstreams groups edit one sim at a time — pick it with the SIM A / SIM B tabs in the Tuning panel. Client behavior (timeouts, retries, jitter, breakers) can differ between sims.</li>
      <li><b>Scenarios.</b> A scenario button sets that sim's client, fabric &amp; downstream tuning; only the traffic shape applies to both. Storm-prone and Protected share identical client settings, isolating the fabric protections — compare them under the same pulse.</li>
      <li><b>◉ PULSE surges both sims at once</b> — the same traffic spike, two responses.</li>
    </ul>
    <button id="help-dismiss" class="btn">GOT IT</button>
  </div>`;

interface PaneStats {
  storm: HTMLElement;
  success: HTMLElement;
  amp: HTMLElement;
}

interface Pane {
  sim: Simulation;
  renderer: Renderer;
  charts: ChartRail;
  /** Per-pane HUD chips; only present in comparison mode. */
  stats: PaneStats | null;
}

export class StormExperience implements Experience {
  readonly maxSimStepMs = MAX_SIM_MS_PER_FRAME;

  private panes: Pane[] = [];
  private compare = false;
  private controls!: ControlPanel;
  private playback!: PlaybackController;
  private hosts!: ExperienceHosts;

  private appEl = document.getElementById('app')!;
  private panesHost!: HTMLElement;
  private helpEl!: HTMLElement;
  private hudAmp!: HTMLElement;
  private hudSuccess!: HTMLElement;
  private stormBadge!: HTMLElement;

  mount(hosts: ExperienceHosts, playback: PlaybackController): void {
    this.hosts = hosts;
    this.playback = playback;
    this.panesHost = hosts.stage;
    // Set the mode's default speed before building controls so the speed slider
    // initializes from it (the shell's scale carries over from the prior mode).
    this.playback.setTimeScale(DEFAULT_TIME_SCALE);

    this.buildHud();
    this.buildCompareHelp();

    this.buildPanes([cloneConfig(PRESETS[0].config)]);

    this.controls = new ControlPanel(hosts.side, hosts.header, {
      getSims: () => this.panes.map((p) => p.sim),
      loadPreset: (id) => this.resetPanes([cloneConfig(presetById(id).config)]),
      applyScenario: (pane, id) => this.applyScenario(pane, id),
      reset: () => this.resetPanes(this.panes.map((p) => cloneConfig(p.sim.cfg))),
      pulse: (factor, durationMs) => {
        for (const p of this.panes) p.sim.triggerPulse(factor, durationMs);
      },
      setPaused: (p) => this.playback.setPaused(p),
      isPaused: () => this.playback.isPaused(),
      setTimeScale: (s) => this.playback.setTimeScale(s),
      getTimeScale: () => this.playback.getTimeScale(),
      configChanged: (kind, target) => {
        const sims =
          target === 'all' ? this.panes.map((p) => p.sim) : this.panes[target] ? [this.panes[target].sim] : [];
        for (const sim of sims) {
          if (kind === 'rate') sim.rescheduleArrivals();
          if (kind === 'structure') sim.applyStructure();
        }
      },
      setCompare: (on) => this.setCompare(on),
      isCompare: () => this.compare,
      showCompareHelp: () => this.helpEl.classList.remove('hidden'),
    });

    this.playback.setStartHint(SINGLE_HINT);
  }

  unmount(): void {
    this.controls.destroy();
    this.appEl.classList.remove('compare');
    this.helpEl.remove();
    this.hosts.hud.replaceChildren();
    this.hosts.header.replaceChildren();
    this.hosts.side.replaceChildren();
    this.hosts.stage.replaceChildren();
  }

  step(simDtMs: number): void {
    for (const p of this.panes) p.sim.step(simDtMs);
  }

  render(): void {
    for (const p of this.panes) {
      p.renderer.draw(p.sim);
      p.charts.draw(p.sim);
    }
    this.controls.update();
    this.updateHud();
  }

  resize(): void {
    this.resizeAll();
  }

  simTimeMs(): number {
    return this.panes[0]?.sim.now ?? 0;
  }

  onResume(): void {
    this.helpEl.classList.add('hidden');
  }

  // -- HUD + overlays the experience owns --------------------------------------

  private buildHud(): void {
    this.stormBadge = el('div', 'single-only', '⚡ CONNECTION STORM');
    this.stormBadge.id = 'storm-badge';
    const successItem = el('div', 'hud-item single-only');
    this.hudSuccess = el('span', 'amp-ok', '100%');
    successItem.append(this.hudSuccess, labelEl('success rate'));
    const ampItem = el('div', 'hud-item single-only');
    this.hudAmp = el('span', 'amp-ok', '1.0');
    ampItem.append(this.hudAmp, labelEl('amplification'));
    this.hosts.hud.append(this.stormBadge, successItem, ampItem);
  }

  private buildCompareHelp(): void {
    this.helpEl = el('div', 'hidden');
    this.helpEl.id = 'compare-help';
    this.helpEl.innerHTML = COMPARE_HELP_HTML;
    this.helpEl.querySelector('#help-dismiss')!.addEventListener('click', () => this.helpEl.classList.add('hidden'));
    this.hosts.stageCol.appendChild(this.helpEl);
  }

  // -- Panes -------------------------------------------------------------------

  /** Tear down and rebuild the pane DOM: one cfg = single, two = compare. */
  private buildPanes(cfgs: SimulationConfig[]): void {
    this.panesHost.innerHTML = '';
    const compare = cfgs.length > 1;
    this.appEl.classList.toggle('compare', compare);
    this.panes = cfgs.map((cfg, i) => {
      const root = document.createElement('section');
      root.className = 'pane';
      let stats: PaneStats | null = null;
      if (compare) {
        const bar = document.createElement('div');
        bar.className = 'pane-bar';
        const tag = document.createElement('span');
        tag.className = `pane-tag tag-${PANE_TAGS[i].toLowerCase()}`;
        tag.textContent = `SIM ${PANE_TAGS[i]}`;
        const storm = document.createElement('span');
        storm.className = 'pane-storm';
        storm.textContent = '⚡ STORM';
        const statsWrap = document.createElement('span');
        statsWrap.className = 'pane-stats';
        const success = document.createElement('b');
        success.className = 'amp-ok';
        success.textContent = '100%';
        const amp = document.createElement('b');
        amp.className = 'amp-ok';
        amp.textContent = '1.0';
        statsWrap.append(success, ' success · ', amp, ' amplification');
        bar.append(tag, storm, statsWrap);
        root.appendChild(bar);
        stats = { storm, success, amp };
      }
      const stage = document.createElement('div');
      stage.className = 'pane-stage';
      const canvas = document.createElement('canvas');
      stage.appendChild(canvas);
      const chartsEl = document.createElement('div');
      chartsEl.className = 'pane-charts';
      root.append(stage, chartsEl);
      this.panesHost.appendChild(root);
      return {
        sim: new Simulation(cloneConfig(cfg)),
        renderer: new Renderer(canvas),
        charts: new ChartRail(chartsEl),
        stats,
      };
    });
    this.resizeAll();
  }

  private resizeAll(): void {
    for (const p of this.panes) {
      p.renderer.resize();
      p.charts.resize();
    }
  }

  /** Fresh run for every pane with the given configs; re-arms the start gate. */
  private resetPanes(cfgs: SimulationConfig[]): void {
    this.buildPanes(cfgs);
    this.controls?.resetLog();
    this.controls?.refreshKnobs();
    this.playback.rearmGate();
  }

  private setCompare(on: boolean): void {
    if (this.compare === on) return;
    this.compare = on;
    // Entering: B starts as a clone of A. Leaving: A (the top pane) survives.
    const cfgA = cloneConfig(this.panes[0].sim.cfg);
    this.resetPanes(on ? [cfgA, cloneConfig(cfgA)] : [cfgA]);
    this.controls.setCompareUI(on);
    this.helpEl.classList.toggle('hidden', !on);
    this.playback.setStartHint(on ? COMPARE_HINT : SINGLE_HINT);
  }

  /**
   * Comparison-mode scenario: the whole preset — clients included — applies
   * to the chosen pane, so client-side differences between scenarios (retry
   * jitter, timeouts, breakers) are honored per sim. Only the traffic shape
   * (client count × rate) propagates to both panes, keeping offered load
   * identical for a fair comparison.
   */
  private applyScenario(pane: number, id: string): void {
    const preset = cloneConfig(presetById(id).config);
    const cfgs = this.panes.map((p) => cloneConfig(p.sim.cfg));
    if (!cfgs[pane]) return;
    cfgs[pane].fabric = preset.fabric;
    cfgs[pane].downstreamPool = preset.downstreamPool;
    cfgs[pane].downstreams = preset.downstreams;
    cfgs[pane].clients = structuredClone(preset.clients);
    for (const c of cfgs) {
      c.clients.count = preset.clients.count;
      c.clients.requestRatePerSec = preset.clients.requestRatePerSec;
    }
    this.resetPanes(cfgs);
  }

  private updateHud(): void {
    if (!this.compare) {
      const s = rollingStats(this.panes[0].sim);
      setStat(this.hudAmp, s.ampText, s.ampCls);
      setStat(this.hudSuccess, s.rateText, s.rateCls);
      this.stormBadge.classList.toggle('visible', this.panes[0].sim.stormActive());
      return;
    }
    for (const p of this.panes) {
      if (!p.stats) continue;
      const s = rollingStats(p.sim);
      setStat(p.stats.amp, s.ampText, s.ampCls);
      setStat(p.stats.success, s.rateText, s.rateCls);
      p.stats.storm.classList.toggle('visible', p.sim.stormActive());
    }
  }
}

/** Rolling window (last ~2s): amplification and overall success rate. */
function rollingStats(sim: Simulation): { rateText: string; rateCls: string; ampText: string; ampCls: string } {
  const buckets = sim.metrics.buckets;
  let sent = 0;
  let ok = 0;
  let arrivals = 0;
  for (let i = Math.max(0, buckets.length - 8); i < buckets.length; i++) {
    sent += buckets[i].arrivals + buckets[i].retries;
    arrivals += buckets[i].arrivals;
    ok += buckets[i].successes;
  }
  const r = sent === 0 ? 1 : sent / Math.max(1, ok);
  const rate = arrivals === 0 ? 1 : Math.min(1, ok / arrivals);
  return {
    ampText: r >= 8 ? '∞' : r.toFixed(1),
    ampCls: r <= 1.1 ? 'amp-ok' : r <= 1.5 ? 'amp-warn' : 'amp-bad',
    rateText: `${(rate * 100).toFixed(0)}%`,
    rateCls: rate >= 0.95 ? 'amp-ok' : rate >= 0.8 ? 'amp-warn' : 'amp-bad',
  };
}

function setStat(node: HTMLElement, text: string, cls: string): void {
  if (node.textContent !== text) node.textContent = text;
  if (node.className !== cls) node.className = cls;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelEl(text: string): HTMLElement {
  const node = document.createElement('label');
  node.textContent = text;
  return node;
}
