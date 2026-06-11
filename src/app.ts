/**
 * Composition root: owns the simulation instance, the rAF driver with time
 * dilation, and wires the renderer, charts, HUD, and control panel together.
 */

import { cloneConfig, presetById, PRESETS } from './engine/presets';
import { Simulation } from './engine/simulation';
import { ChartRail } from './render/charts';
import { Renderer } from './render/renderer';
import { ControlPanel } from './ui/controls';

/** Default playback: 10x slow motion — a 150ms request takes 1.5s on screen. */
const DEFAULT_TIME_SCALE = 0.1;
/** Ignore wall-time gaps bigger than this (background tab, debugger). */
const MAX_FRAME_WALL_MS = 100;
/** Cap sim advancement per frame so a speed spike can't freeze the page. */
const MAX_SIM_MS_PER_FRAME = 250;

export class App {
  private sim: Simulation;
  private renderer: Renderer;
  private charts: ChartRail;
  private controls: ControlPanel;
  private timeScale = DEFAULT_TIME_SCALE;
  private paused = false;
  private pausedByVisibility = false;
  private lastWall = 0;

  private hudClock: HTMLElement;
  private hudAmp: HTMLElement;
  private hudSuccess: HTMLElement;
  private stormBadge: HTMLElement;

  constructor() {
    this.sim = new Simulation(cloneConfig(PRESETS[0].config));

    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas);
    this.charts = new ChartRail(document.getElementById('charts')!);
    this.hudClock = document.getElementById('hud-clock')!;
    this.hudAmp = document.getElementById('hud-amp')!;
    this.hudSuccess = document.getElementById('hud-success')!;
    this.stormBadge = document.getElementById('storm-badge')!;

    this.controls = new ControlPanel(
      document.getElementById('side')!,
      document.getElementById('header-controls')!,
      {
        getSim: () => this.sim,
        loadPreset: (id) => this.loadPreset(id),
        reset: () => this.reset(this.sim.cfg),
        pulse: (factor, durationMs) => this.sim.triggerPulse(factor, durationMs),
        setPaused: (p) => {
          this.paused = p;
        },
        isPaused: () => this.paused,
        setTimeScale: (s) => {
          this.timeScale = s;
        },
        getTimeScale: () => this.timeScale,
        configChanged: (kind) => {
          if (kind === 'rate') this.sim.rescheduleArrivals();
          if (kind === 'structure') this.sim.applyStructure();
        },
      },
    );

    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.charts.resize();
    });
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

    this.charts.resize();
    requestAnimationFrame((t) => {
      this.lastWall = t;
      requestAnimationFrame(this.frame);
    });
  }

  private loadPreset(id: string): void {
    this.reset(cloneConfig(presetById(id).config));
  }

  private reset(cfg: typeof this.sim.cfg): void {
    this.sim = new Simulation(cloneConfig(cfg));
    this.renderer.reset();
    this.controls.resetLog();
    this.controls.refreshKnobs();
  }

  private frame = (wallNow: number): void => {
    const wallDt = Math.min(MAX_FRAME_WALL_MS, wallNow - this.lastWall);
    this.lastWall = wallNow;
    if (!this.paused) {
      const simDt = Math.min(MAX_SIM_MS_PER_FRAME, wallDt * this.timeScale);
      this.sim.step(simDt);
    }
    this.renderer.draw(this.sim);
    this.charts.draw(this.sim);
    this.controls.update();
    this.updateHud();
    requestAnimationFrame(this.frame);
  };

  private updateHud(): void {
    const clock = `${(this.sim.now / 1000).toFixed(1)}s`;
    if (this.hudClock.textContent !== clock) this.hudClock.textContent = clock;

    // Rolling window (last ~2s): amplification and overall success rate.
    const buckets = this.sim.metrics.buckets;
    let sent = 0;
    let ok = 0;
    let arrivals = 0;
    for (let i = Math.max(0, buckets.length - 8); i < buckets.length; i++) {
      sent += buckets[i].arrivals + buckets[i].retries;
      arrivals += buckets[i].arrivals;
      ok += buckets[i].successes;
    }
    const r = sent === 0 ? 1 : sent / Math.max(1, ok);
    const rText = r >= 8 ? '∞' : `${r.toFixed(1)}`;
    if (this.hudAmp.textContent !== rText) this.hudAmp.textContent = rText;
    this.hudAmp.className = r <= 1.1 ? 'amp-ok' : r <= 1.5 ? 'amp-warn' : 'amp-bad';

    const rate = arrivals === 0 ? 1 : Math.min(1, ok / arrivals);
    const rateText = `${(rate * 100).toFixed(0)}%`;
    if (this.hudSuccess.textContent !== rateText) this.hudSuccess.textContent = rateText;
    this.hudSuccess.className = rate >= 0.95 ? 'amp-ok' : rate >= 0.8 ? 'amp-warn' : 'amp-bad';

    this.stormBadge.classList.toggle('visible', this.sim.stormActive());
  }
}
