/**
 * Composition root: owns the simulation panes (one in single mode, two
 * stacked in comparison mode), the rAF driver with time dilation, and wires
 * renderers, charts, HUD, and the control panel together. In comparison
 * mode both sims step the same virtual clock each frame, so a pulse hits
 * them simultaneously and their charts stay aligned.
 */

import { cloneConfig, presetById, PRESETS } from './engine/presets';
import { Simulation } from './engine/simulation';
import type { SimulationConfig } from './engine/types';
import { ChartRail } from './render/charts';
import { Renderer } from './render/renderer';
import { ControlPanel, PANE_TAGS } from './ui/controls';

/** Default playback: 10x slow motion — a 150ms request takes 1.5s on screen. */
const DEFAULT_TIME_SCALE = 0.1;
/** Ignore wall-time gaps bigger than this (background tab, debugger). */
const MAX_FRAME_WALL_MS = 100;
/** Cap sim advancement per frame so a speed spike can't freeze the page. */
const MAX_SIM_MS_PER_FRAME = 250;

const SINGLE_HINT = 'Pick a scenario and tune the knobs first — traffic flows when you start.';
const COMPARE_HINT = 'Tune each sim — A above, B below — then start. Both run on the same clock and traffic.';

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

export class App {
  private panes: Pane[] = [];
  private compare = false;
  private controls!: ControlPanel;
  private timeScale = DEFAULT_TIME_SCALE;
  /** Starts paused behind the start gate so settings can be tuned first. */
  private paused = true;
  /** True until the current run is started for the first time. */
  private gateArmed = true;
  private pausedByVisibility = false;
  private lastWall = 0;

  private appEl = document.getElementById('app')!;
  private panesHost = document.getElementById('panes')!;
  private startGate = document.getElementById('start-gate')!;
  private startHint = document.getElementById('start-hint')!;
  private helpEl = document.getElementById('compare-help')!;
  private hudClock = document.getElementById('hud-clock')!;
  private hudAmp = document.getElementById('hud-amp')!;
  private hudSuccess = document.getElementById('hud-success')!;
  private stormBadge = document.getElementById('storm-badge')!;

  constructor() {
    this.buildPanes([cloneConfig(PRESETS[0].config)]);
    document.getElementById('start-btn')!.addEventListener('click', () => this.setPaused(false));
    document.getElementById('help-dismiss')!.addEventListener('click', () => this.helpEl.classList.add('hidden'));

    this.controls = new ControlPanel(
      document.getElementById('side')!,
      document.getElementById('header-controls')!,
      {
        getSims: () => this.panes.map((p) => p.sim),
        loadPreset: (id) => this.resetPanes([cloneConfig(presetById(id).config)]),
        applyScenario: (pane, id) => this.applyScenario(pane, id),
        reset: () => this.resetPanes(this.panes.map((p) => cloneConfig(p.sim.cfg))),
        pulse: (factor, durationMs) => {
          for (const p of this.panes) p.sim.triggerPulse(factor, durationMs);
        },
        setPaused: (p) => this.setPaused(p),
        isPaused: () => this.paused,
        setTimeScale: (s) => {
          this.timeScale = s;
        },
        getTimeScale: () => this.timeScale,
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
      },
    );

    window.addEventListener('resize', () => this.resizeAll());
    document.addEventListener('visibilitychange', () => {
      // Browsers throttle rAF in background tabs; auto-pause instead of
      // letting the sim lurch when the tab returns.
      if (document.hidden && !this.paused) {
        this.paused = true;
        this.pausedByVisibility = true;
      } else if (!document.hidden && this.pausedByVisibility) {
        this.paused = false;
        this.pausedByVisibility = false;
      }
    });

    requestAnimationFrame((t) => {
      this.lastWall = t;
      requestAnimationFrame(this.frame);
    });
  }

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
    this.gateArmed = true;
    this.setPaused(true);
  }

  private setCompare(on: boolean): void {
    if (this.compare === on) return;
    this.compare = on;
    // Entering: B starts as a clone of A. Leaving: A (the top pane) survives.
    const cfgA = cloneConfig(this.panes[0].sim.cfg);
    this.resetPanes(on ? [cfgA, cloneConfig(cfgA)] : [cfgA]);
    this.controls.setCompareUI(on);
    this.helpEl.classList.toggle('hidden', !on);
    this.startHint.textContent = on ? COMPARE_HINT : SINGLE_HINT;
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

  private setPaused(p: boolean): void {
    this.paused = p;
    this.pausedByVisibility = false;
    if (!p) {
      this.gateArmed = false;
      this.helpEl.classList.add('hidden');
    }
    // The gate shows only for a fresh (never-started) run; mid-run pauses
    // just freeze the scene.
    this.startGate.classList.toggle('hidden', !(this.paused && this.gateArmed));
  }

  private frame = (wallNow: number): void => {
    const wallDt = Math.min(MAX_FRAME_WALL_MS, wallNow - this.lastWall);
    this.lastWall = wallNow;
    if (!this.paused) {
      const simDt = Math.min(MAX_SIM_MS_PER_FRAME, wallDt * this.timeScale);
      for (const p of this.panes) p.sim.step(simDt);
    }
    for (const p of this.panes) {
      p.renderer.draw(p.sim);
      p.charts.draw(p.sim);
    }
    this.controls.update();
    this.updateHud();
    requestAnimationFrame(this.frame);
  };

  private updateHud(): void {
    const lead = this.panes[0].sim;
    const clock = `${(lead.now / 1000).toFixed(1)}s`;
    if (this.hudClock.textContent !== clock) this.hudClock.textContent = clock;

    if (!this.compare) {
      const s = rollingStats(lead);
      setStat(this.hudAmp, s.ampText, s.ampCls);
      setStat(this.hudSuccess, s.rateText, s.rateCls);
      this.stormBadge.classList.toggle('visible', lead.stormActive());
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
