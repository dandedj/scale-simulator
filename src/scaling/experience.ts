/**
 * The Scaling experience: a rapid demand ramp against the autoscaling pipeline.
 * Owns its panes (single or two-up compare), renderer, charts, HUD, and control
 * panel. The shell drives it through the Experience interface.
 */

import type { Experience, ExperienceHosts, PlaybackController } from '../experience';
import { ScalingSimulation } from './engine/scalingSimulation';
import { cloneScalingConfig, scalingPresetById, SCALING_PRESETS } from './engine/presets';
import type { ScalingSimulationConfig } from './engine/types';
import { ScalingChartRail } from './render/charts';
import { ScalingRenderer } from './render/renderer';
import { ScalingTimeline } from './render/timeline';
import { ScalingControlPanel, PANE_TAGS } from './ui/controls';

/** Ramps here run for tens of minutes of sim time, so playback starts well dilated. */
const DEFAULT_TIME_SCALE = 60;
const MAX_SIM_MS_PER_FRAME = 60_000;

const SINGLE_HINT =
  'Starts calm at 50K TPS and holds there — press START, then ▲ RAMP when you want to add demand. Pick a scenario to run a scheduled ramp instead.';
const COMPARE_HINT = 'Tune each sim — A above, B below — then start. Both run on the same clock and demand ramp.';

const COMPARE_HELP_HTML = `
  <div class="help-card">
    <h2>Comparison mode</h2>
    <ul>
      <li><b>Two sims, one clock.</b> SIM A (top) and SIM B (bottom) run in lockstep, each with its own board, charts, and totals.</li>
      <li><b>Shared demand.</b> The Demand controls — shape, base rate, ramp amount and ramp rate — apply to both sims, so they face the same ramp.</li>
      <li><b>Per-sim tuning.</b> The Capacity &amp; buffer, Scaling policy, Launch step &amp; bake, and Scale-up stages groups edit one sim at a time — pick it with the SIM A / SIM B tabs.</li>
      <li><b>Scenarios.</b> A scenario sets that sim's scaling config; only the demand ramp is shared. Compare e.g. Sustained ramp vs Long bake to see what a bake costs, or Baseline vs Optimized pipeline.</li>
      <li><b>◉ SURGE and ▲ RAMP hit both sims at once</b> — the same demand change, two responses.</li>
    </ul>
    <button id="scaling-help-dismiss" class="btn">GOT IT</button>
  </div>`;

interface PaneStats {
  badge: HTMLElement;
  availability: HTMLElement;
}
interface Pane {
  sim: ScalingSimulation;
  renderer: ScalingRenderer;
  charts: ScalingChartRail;
  stats: PaneStats | null;
}

export class ScalingExperience implements Experience {
  readonly maxSimStepMs = MAX_SIM_MS_PER_FRAME;

  private panes: Pane[] = [];
  private compare = false;
  private controls!: ScalingControlPanel;
  private playback!: PlaybackController;
  private hosts!: ExperienceHosts;

  private appEl = document.getElementById('app')!;
  private panesHost!: HTMLElement;
  private helpEl!: HTMLElement;
  private hudAvail!: HTMLElement;
  private degradedBadge!: HTMLElement;
  /** The annotated run timeline — single mode only, opened from the header. */
  private timelineEl!: HTMLElement;
  private timeline: ScalingTimeline | null = null;
  private timelineOpen = false;
  private timelineMax = false;
  private liveBtn!: HTMLButtonElement;
  private onKeyDown!: (e: KeyboardEvent) => void;

  mount(hosts: ExperienceHosts, playback: PlaybackController): void {
    this.hosts = hosts;
    this.playback = playback;
    this.panesHost = hosts.stage;
    this.playback.setTimeScale(DEFAULT_TIME_SCALE);

    this.buildHud();
    this.buildCompareHelp();
    this.buildTimeline();
    this.buildPanes([cloneScalingConfig(SCALING_PRESETS[0].config)]);

    this.controls = new ScalingControlPanel(hosts.side, hosts.header, {
      getSims: () => this.panes.map((p) => p.sim),
      loadPreset: (id) => this.resetPanes([cloneScalingConfig(scalingPresetById(id).config)]),
      applyScenario: (pane, id) => this.applyScenario(pane, id),
      reset: () => this.resetPanes(this.panes.map((p) => cloneScalingConfig(p.sim.cfg))),
      surge: (factor, durationMs) => {
        for (const p of this.panes) p.sim.triggerSurge(factor, durationMs);
      },
      ramp: (amountTps, durationMs) => {
        for (const p of this.panes) p.sim.triggerRamp(amountTps, durationMs);
      },
      setPaused: (p) => this.playback.setPaused(p),
      isPaused: () => this.playback.isPaused(),
      setTimeScale: (s) => this.playback.setTimeScale(s),
      getTimeScale: () => this.playback.getTimeScale(),
      configChanged: (kind, target) => {
        const sims = target === 'all' ? this.panes.map((p) => p.sim) : this.panes[target] ? [this.panes[target].sim] : [];
        for (const sim of sims) {
          if (kind === 'structure') sim.applyStructure();
          else sim.applyTraffic();
        }
      },
      setCompare: (on) => this.setCompare(on),
      isCompare: () => this.compare,
      showCompareHelp: () => this.helpEl.classList.remove('hidden'),
      setTimelineOpen: (on) => this.setTimelineOpen(on),
      isTimelineOpen: () => this.timelineOpen,
    });

    this.playback.setStartHint(SINGLE_HINT);
  }

  unmount(): void {
    this.controls.destroy();
    window.removeEventListener('keydown', this.onKeyDown);
    this.appEl.classList.remove('compare', 'timeline-max');
    this.timeline?.destroy();
    this.timelineEl.remove();
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
    if (this.timelineMax) {
      this.timeline?.draw(this.panes[0].sim);
      this.syncLiveBtn();
      this.controls.update();
      this.updateHud();
      return;
    }
    for (const p of this.panes) p.renderer.draw(p.sim);
    if (this.compare && this.panes.length === 2) {
      // Share a y-axis per chart so magnitude differences between the two
      // scenarios are visible (each pane auto-scaling alone hides them).
      const a = this.panes[0].charts.yMaxes(this.panes[0].sim);
      const b = this.panes[1].charts.yMaxes(this.panes[1].sim);
      const shared = a.map((m, i) => Math.max(m, b[i] ?? m));
      this.panes[0].charts.draw(this.panes[0].sim, shared);
      this.panes[1].charts.draw(this.panes[1].sim, shared);
    } else {
      for (const p of this.panes) p.charts.draw(p.sim);
    }
    if (this.timelineOpen && this.timeline && !this.compare) {
      this.timeline.draw(this.panes[0].sim);
      this.syncLiveBtn();
    }
    this.controls.update();
    this.updateHud();
  }

  resize(): void {
    if (!this.timelineMax) {
      for (const p of this.panes) {
        p.renderer.resize();
        p.charts.resize();
      }
    }
    this.timeline?.resize();
  }

  simTimeMs(): number {
    return this.panes[0]?.sim.now ?? 0;
  }

  onResume(): void {
    this.helpEl.classList.add('hidden');
  }

  private buildHud(): void {
    this.degradedBadge = el('div', 'single-only', '▼ BELOW SLO');
    this.degradedBadge.id = 'dns-degraded';
    const availItem = el('div', 'hud-item single-only');
    this.hudAvail = el('span', 'amp-ok', '100%');
    availItem.append(this.hudAvail, labelEl('availability'));
    this.hosts.hud.append(this.degradedBadge, availItem);
  }

  /**
   * The timeline lives below the panes rather than inside one: it is a view of
   * the whole run on one axis, so it wants the full stage width.
   */
  private buildTimeline(): void {
    this.timelineEl = el('div', 'timeline-pane hidden');
    this.timelineEl.id = 'scaling-timeline';
    const canvas = document.createElement('canvas');
    const maxBtn = el('button', 'timeline-max-btn', '⤢') as HTMLButtonElement;
    maxBtn.title = 'Maximize the timeline (Esc to restore)';
    maxBtn.addEventListener('click', () => this.setTimelineMax(!this.timelineMax));
    // Only shown once the window has been scrolled off the live edge.
    this.liveBtn = el('button', 'timeline-live-btn', '● LIVE') as HTMLButtonElement;
    this.liveBtn.title = 'Jump back to the live edge';
    this.liveBtn.addEventListener('click', () => this.timeline?.goLive());
    this.timelineEl.append(canvas, this.liveBtn, maxBtn);
    this.hosts.stageCol.appendChild(this.timelineEl);
    this.timeline = new ScalingTimeline(canvas);
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.timelineOpen) return;
      // Escape backs out one step: re-pin a scrolled window, then un-maximize.
      if (this.timeline && !this.timeline.isFollowing()) this.timeline.goLive();
      else if (this.timelineMax) this.setTimelineMax(false);
    };
    window.addEventListener('keydown', this.onKeyDown);
  }

  private setTimelineOpen(on: boolean): void {
    // Two panes, two clocks — one shared axis would misrepresent both.
    this.timelineOpen = on && !this.compare;
    this.timelineEl.classList.toggle('hidden', !this.timelineOpen);
    this.controls?.setTimelineUI(this.timelineOpen);
    if (!this.timelineOpen) this.setTimelineMax(false);
    // The panes lose height to the timeline, so every canvas needs re-measuring.
    this.resize();
  }

  private syncLiveBtn(): void {
    const scrolled = this.timeline ? !this.timeline.isFollowing() : false;
    this.liveBtn.classList.toggle('visible', scrolled);
  }

  /** Hand the whole stage to the timeline — the board and charts step aside. */
  private setTimelineMax(on: boolean): void {
    this.timelineMax = on && this.timelineOpen;
    this.appEl.classList.toggle('timeline-max', this.timelineMax);
    this.timelineEl.classList.toggle('maximized', this.timelineMax);
    const btn = this.timelineEl.querySelector('.timeline-max-btn');
    if (btn) btn.textContent = this.timelineMax ? '⤡' : '⤢';
    this.resize();
  }

  private buildCompareHelp(): void {
    this.helpEl = el('div', 'hidden');
    this.helpEl.id = 'compare-help';
    this.helpEl.innerHTML = COMPARE_HELP_HTML;
    this.helpEl.querySelector('#scaling-help-dismiss')!.addEventListener('click', () => this.helpEl.classList.add('hidden'));
    this.hosts.stageCol.appendChild(this.helpEl);
  }

  private buildPanes(cfgs: ScalingSimulationConfig[]): void {
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
        const badge = document.createElement('span');
        badge.className = 'pane-storm';
        badge.textContent = '▼ BELOW SLO';
        const statsWrap = document.createElement('span');
        statsWrap.className = 'pane-stats';
        const availability = document.createElement('b');
        availability.className = 'amp-ok';
        availability.textContent = '100%';
        statsWrap.append(availability, ' availability');
        bar.append(tag, badge, statsWrap);
        root.appendChild(bar);
        stats = { badge, availability };
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
        sim: new ScalingSimulation(cloneScalingConfig(cfg)),
        renderer: new ScalingRenderer(canvas),
        charts: new ScalingChartRail(chartsEl),
        stats,
      };
    });
    this.resize();
  }

  private resetPanes(cfgs: ScalingSimulationConfig[]): void {
    this.buildPanes(cfgs);
    this.controls?.resetLog();
    this.controls?.refreshKnobs();
    this.playback.rearmGate();
  }

  private setCompare(on: boolean): void {
    if (this.compare === on) return;
    if (on && this.timelineOpen) this.setTimelineOpen(false);
    this.compare = on;
    const cfgA = cloneScalingConfig(this.panes[0].sim.cfg);
    this.resetPanes(on ? [cfgA, cloneScalingConfig(cfgA)] : [cfgA]);
    this.controls.setCompareUI(on);
    this.helpEl.classList.toggle('hidden', !on);
    this.playback.setStartHint(on ? COMPARE_HINT : SINGLE_HINT);
  }

  private applyScenario(pane: number, id: string): void {
    const preset = cloneScalingConfig(scalingPresetById(id).config);
    const cfgs = this.panes.map((p) => cloneScalingConfig(p.sim.cfg));
    if (!cfgs[pane]) return;
    cfgs[pane].capacity = preset.capacity;
    cfgs[pane].stages = preset.stages;
    cfgs[pane].policy = preset.policy;
    cfgs[pane].launch = preset.launch;
    cfgs[pane].slaTarget = preset.slaTarget;
    for (const c of cfgs) c.traffic = structuredClone(preset.traffic);
    this.resetPanes(cfgs);
  }

  private updateHud(): void {
    if (!this.compare) {
      const sim = this.panes[0].sim;
      const s = availStats(sim);
      setStat(this.hudAvail, s.text, s.cls);
      this.degradedBadge.classList.toggle('visible', sim.degradedActive());
      return;
    }
    for (const p of this.panes) {
      if (!p.stats) continue;
      const s = availStats(p.sim);
      setStat(p.stats.availability, s.text, s.cls);
      p.stats.badge.classList.toggle('visible', p.sim.degradedActive());
    }
  }
}

function availStats(sim: ScalingSimulation): { text: string; cls: string } {
  const a = sim.availability();
  const slo = sim.cfg.slaTarget;
  return { text: `${(a * 100).toFixed(1)}%`, cls: a >= slo ? 'amp-ok' : a >= 0.9 ? 'amp-warn' : 'amp-bad' };
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
