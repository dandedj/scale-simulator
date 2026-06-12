/**
 * Control panel: preset cards, the pulse trigger, time controls, live knobs
 * grouped by component, lifetime counters, and the event ticker.
 * Plain DOM, no framework — knobs read/write the live SimulationConfig and
 * take effect immediately, like tuning a running system.
 *
 * Knob groups carry a scope: 'global' groups (Clients) always edit every
 * sim so comparison mode keeps offered traffic identical; 'sim' groups edit
 * the pane selected with the SIM A / SIM B tabs.
 */

import { PRESETS } from '../engine/presets';
import type { Simulation } from '../engine/simulation';
import type { SimulationConfig } from '../engine/types';
import { Legend } from './legend';

export const PANE_TAGS = ['A', 'B'] as const;

type KnobScope = 'global' | 'sim';

export interface ControlHooks {
  getSims(): Simulation[];
  /** Single mode: swap the whole config and restart. */
  loadPreset(id: string): void;
  /** Comparison mode: apply a preset's tuning to one pane (clients shared). */
  applyScenario(pane: number, id: string): void;
  reset(): void;
  /** Surge every sim at once. */
  pulse(factor: number, durationMs: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(s: number): void;
  getTimeScale(): number;
  /** 'rate' → reschedule arrivals; 'structure' → entity/CPU rebuild. */
  configChanged(kind: 'rate' | 'structure' | 'plain', target: number | 'all'): void;
  setCompare(on: boolean): void;
  isCompare(): boolean;
  showCompareHelp(): void;
}

interface KnobDef {
  label: string;
  min: number;
  max: number;
  step: number;
  kind?: 'rate' | 'structure' | 'plain';
  get(cfg: SimulationConfig): number;
  set(cfg: SimulationConfig, v: number): void;
  format?(v: number): string;
}

interface ToggleDef {
  label: string;
  get(cfg: SimulationConfig): boolean;
  set(cfg: SimulationConfig, v: boolean): void;
}

const ms = (v: number) => `${Math.round(v)}ms`;
const msFine = (v: number) => `${v}ms`;
const SIGMA_Z99 = 2.3263;

const GROUPS: Array<{ name: string; scope: KnobScope; knobs: KnobDef[]; toggles: ToggleDef[] }> = [
  {
    name: 'Clients',
    scope: 'global',
    knobs: [
      { label: 'Clients', min: 1, max: 12, step: 1, kind: 'structure', get: (c) => c.clients.count, set: (c, v) => (c.clients.count = v) },
      { label: 'Rate / client', min: 1, max: 80, step: 1, kind: 'rate', get: (c) => c.clients.requestRatePerSec, set: (c, v) => (c.clients.requestRatePerSec = v), format: (v) => `${v}/s` },
      { label: 'Pool size', min: 1, max: 24, step: 1, get: (c) => c.clients.poolSize, set: (c, v) => (c.clients.poolSize = v) },
      { label: 'Client RTT', min: 1, max: 100, step: 1, get: (c) => c.clients.rttMs, set: (c, v) => (c.clients.rttMs = v), format: ms },
      { label: 'Client TLS delay', min: 0, max: 500, step: 10, get: (c) => c.clients.tlsClientDelayMs, set: (c, v) => (c.clients.tlsClientDelayMs = v), format: ms },
      { label: 'Request timeout', min: 50, max: 1000, step: 10, get: (c) => c.clients.requestTimeoutMs, set: (c, v) => (c.clients.requestTimeoutMs = v), format: ms },
      { label: 'Pool wait limit', min: 50, max: 1000, step: 10, get: (c) => c.clients.poolAcquireTimeoutMs, set: (c, v) => (c.clients.poolAcquireTimeoutMs = v), format: ms },
      { label: 'Connect timeout', min: 100, max: 3000, step: 50, get: (c) => c.clients.connectTimeoutMs, set: (c, v) => (c.clients.connectTimeoutMs = v), format: ms },
      { label: 'Max retries', min: 0, max: 5, step: 1, get: (c) => c.clients.maxRetries, set: (c, v) => (c.clients.maxRetries = v) },
      { label: 'Backoff base', min: 5, max: 250, step: 5, get: (c) => c.clients.retryBackoffBaseMs, set: (c, v) => (c.clients.retryBackoffBaseMs = v), format: ms },
      { label: 'Breaker trip ratio', min: 0.1, max: 0.9, step: 0.05, get: (c) => c.clients.breakerFailureRatio, set: (c, v) => (c.clients.breakerFailureRatio = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'Breaker cooldown', min: 500, max: 10000, step: 250, get: (c) => c.clients.breakerCooldownMs, set: (c, v) => (c.clients.breakerCooldownMs = v), format: (v) => `${(v / 1000).toFixed(1)}s` },
    ],
    toggles: [
      { label: 'Retry jitter', get: (c) => c.clients.retryJitter, set: (c, v) => (c.clients.retryJitter = v) },
      { label: 'Circuit breaker', get: (c) => c.clients.circuitBreakerEnabled, set: (c, v) => (c.clients.circuitBreakerEnabled = v) },
    ],
  },
  {
    name: 'RTB Fabric',
    scope: 'sim',
    knobs: [
      { label: 'Connection limit', min: 8, max: 500, step: 4, get: (c) => c.fabric.maxConnections, set: (c, v) => (c.fabric.maxConnections = v) },
      { label: 'TLS permits', min: 1, max: 128, step: 1, get: (c) => c.fabric.tlsHandshakeConcurrency, set: (c, v) => (c.fabric.tlsHandshakeConcurrency = v) },
      { label: 'TLS permit wait', min: 0, max: 5, step: 0.25, get: (c) => c.fabric.tlsPermitWaitMs, set: (c, v) => (c.fabric.tlsPermitWaitMs = v), format: msFine },
      { label: 'TLS resumption', min: 0, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionRate, set: (c, v) => (c.fabric.tlsResumptionRate = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'Resumed cost (vs full)', min: 0.1, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionCostFactor, set: (c, v) => (c.fabric.tlsResumptionCostFactor = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'TLS CPU time', min: 5, max: 100, step: 5, get: (c) => c.fabric.tlsHandshakeCpuMs, set: (c, v) => (c.fabric.tlsHandshakeCpuMs = v), format: ms },
      { label: 'TLS CPU cost', min: 5, max: 200, step: 5, get: (c) => c.fabric.tlsCpuCost, set: (c, v) => (c.fabric.tlsCpuCost = v), format: (v) => `${v}u` },
      { label: 'Processing time', min: 1, max: 10, step: 0.5, get: (c) => c.fabric.processingMs, set: (c, v) => (c.fabric.processingMs = v), format: ms },
      { label: 'CPU capacity', min: 500, max: 12000, step: 250, kind: 'structure', get: (c) => c.fabric.cpuCapacity, set: (c, v) => (c.fabric.cpuCapacity = v), format: (v) => `${(v / 1000).toFixed(1)}ku/s` },
      { label: 'TLS error pacing delay', min: 0, max: 5, step: 0.25, get: (c) => c.fabric.tlsErrorPacingDelayMs, set: (c, v) => (c.fabric.tlsErrorPacingDelayMs = v), format: msFine },
    ],
    toggles: [
      { label: 'TLS error pacing', get: (c) => c.fabric.tlsErrorPacingEnabled, set: (c, v) => (c.fabric.tlsErrorPacingEnabled = v) },
    ],
  },
  {
    name: 'Downstream pools',
    scope: 'sim',
    knobs: [
      { label: 'Pool / downstream', min: 1, max: 30, step: 1, get: (c) => c.downstreamPool.poolSizePerDownstream, set: (c, v) => (c.downstreamPool.poolSizePerDownstream = v) },
      { label: 'Downstream timeout', min: 50, max: 1000, step: 10, get: (c) => c.downstreamPool.requestTimeoutMs, set: (c, v) => (c.downstreamPool.requestTimeoutMs = v), format: ms },
      { label: 'Connect time', min: 5, max: 100, step: 5, get: (c) => c.downstreamPool.connectMs, set: (c, v) => (c.downstreamPool.connectMs = v), format: ms },
      { label: 'Breaker trip ratio', min: 0.1, max: 0.9, step: 0.05, get: (c) => c.downstreamPool.breakerFailureRatio, set: (c, v) => (c.downstreamPool.breakerFailureRatio = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'Breaker cooldown', min: 500, max: 10000, step: 250, get: (c) => c.downstreamPool.breakerCooldownMs, set: (c, v) => (c.downstreamPool.breakerCooldownMs = v), format: (v) => `${(v / 1000).toFixed(1)}s` },
    ],
    toggles: [
      { label: 'Circuit breaker', get: (c) => c.downstreamPool.circuitBreakerEnabled, set: (c, v) => (c.downstreamPool.circuitBreakerEnabled = v) },
    ],
  },
  {
    name: 'Downstreams',
    scope: 'sim',
    knobs: [
      { label: 'Downstreams', min: 1, max: 6, step: 1, kind: 'structure', get: (c) => c.downstreams.count, set: (c, v) => (c.downstreams.count = v) },
      { label: 'Response median', min: 10, max: 500, step: 5, get: (c) => c.downstreams.responseTimeMedianMs, set: (c, v) => (c.downstreams.responseTimeMedianMs = v), format: ms },
      {
        label: 'Tail (p99 ÷ p50)',
        min: 1.2,
        max: 10,
        step: 0.1,
        get: (c) => Math.exp(SIGMA_Z99 * c.downstreams.responseTimeSigma),
        set: (c, v) => (c.downstreams.responseTimeSigma = Math.log(v) / SIGMA_Z99),
        format: (v) => `${v.toFixed(1)}×`,
      },
      { label: 'Error rate', min: 0, max: 0.5, step: 0.005, get: (c) => c.downstreams.errorRate, set: (c, v) => (c.downstreams.errorRate = v), format: (v) => `${(v * 100).toFixed(1)}%` },
      { label: 'Concurrency cap', min: 1, max: 100, step: 1, get: (c) => c.downstreams.concurrencyCapacity, set: (c, v) => (c.downstreams.concurrencyCapacity = v) },
    ],
    toggles: [],
  },
];

type Totals = Simulation['metrics']['totals'];

const TOTAL_METRICS: Array<{ key: string; color: string; value(t: Totals): string }> = [
  { key: 'success', color: 'var(--ok)', value: (t) => `${(t.arrivals > 0 ? (t.successes / t.arrivals) * 100 : 100).toFixed(1)}%` },
  { key: 'ok', color: 'var(--ok)', value: (t) => fmtCount(t.successes) },
  { key: 'timeout', color: 'var(--bad)', value: (t) => fmtCount(t.timeouts) },
  { key: 'error', color: 'var(--err)', value: (t) => fmtCount(t.errors) },
  { key: 'shed·tls', color: 'var(--warn)', value: (t) => fmtCount(t.shedTls) },
  { key: 'shed·conn', color: 'var(--warn)', value: (t) => fmtCount(t.shedConnLimit) },
  { key: 'retries', color: 'var(--retry)', value: (t) => fmtCount(t.retries) },
  { key: 'resumed TLS', color: 'var(--tls)', value: (t) => fmtCount(t.resumedHandshakes) },
  { key: 'wasted TLS', color: 'var(--bad)', value: (t) => fmtCount(t.wastedHandshakes) },
];

export class ControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private lastTotalsHtml = '';
  /** Lifetime-event counters, one per pane. */
  private renderedEvents: number[] = [];
  private pulseFactor = 2;
  private pulseDurationMs = 5000;
  private pauseBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private paneTabBtns: HTMLButtonElement[] = [];
  /** Which pane the 'sim'-scoped knobs edit in comparison mode. */
  private activePane = 0;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: ControlHooks;

  constructor(side: HTMLElement, header: HTMLElement, hooks: ControlHooks) {
    this.side = side;
    this.header = header;
    this.hooks = hooks;
    this.buildHeaderControls();
    this.buildPresets();
    this.buildKnobs();
    this.buildTotals();
    this.buildEventLog();
  }

  // -- Header: pulse + time --------------------------------------------------

  private buildHeaderControls(): void {
    const wrap = el('div', 'time-controls');

    const pulseBtn = el('button', 'btn btn-pulse', '◉ PULSE ×2');
    pulseBtn.title = 'Inject a traffic surge (×factor for the set duration; hits every sim)';
    pulseBtn.addEventListener('click', () => this.hooks.pulse(this.pulseFactor, this.pulseDurationMs));
    wrap.appendChild(pulseBtn);

    const pulseFactor = this.miniSlider(1.1, 4, 0.1, this.pulseFactor, (v) => {
      this.pulseFactor = v;
      pulseBtn.textContent = `◉ PULSE ×${v}`;
    });
    pulseFactor.title = 'Pulse intensity';
    wrap.appendChild(pulseFactor);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        this.hooks.setPaused(!this.hooks.isPaused());
      }
    });
    wrap.appendChild(this.pauseBtn);

    // Speed: log slider mapping [0 .. 1] → 0.01x .. 2x sim-speed
    const speedWrap = el('div', 'speed-wrap');
    const speedLabel = el('span', 'speed-label');
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '1';
    speed.step = '0.005';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(0.01), Math.log10(2), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(0.01)) / (Math.log10(2) - Math.log10(0.01));
    const syncSpeedLabel = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 0.99 ? `${s.toFixed(1)}× speed` : `${(1 / s).toFixed(0)}× slower`;
    };
    speed.value = String(fromScale(this.hooks.getTimeScale()));
    speed.addEventListener('input', () => {
      this.hooks.setTimeScale(toScale(parseFloat(speed.value)));
      syncSpeedLabel();
    });
    syncSpeedLabel();
    speedWrap.appendChild(speed);
    speedWrap.appendChild(speedLabel);
    wrap.appendChild(speedWrap);

    const resetBtn = el('button', 'btn', '↺ RESET');
    resetBtn.title = 'Restart the simulation with the current settings';
    resetBtn.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(resetBtn);

    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.title = 'Run two simulations side by side under the same client traffic';
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);

    new Legend(wrap);

    this.header.appendChild(wrap);
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

  // -- Presets ------------------------------------------------------------------

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));

    // Single mode: full preset cards swap the whole config.
    const grid = el('div', 'preset-grid single-only');
    for (const preset of PRESETS) {
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

    // Comparison mode: one compact scenario row per pane.
    const cmp = el('div', 'compare-only');
    PANE_TAGS.forEach((tag, pane) => {
      const row = el('div', 'scenario-row');
      row.appendChild(el('span', `scenario-tag tag-${tag.toLowerCase()}`, `SIM ${tag}`));
      const btns = el('div', 'scenario-btns');
      for (const preset of PRESETS) {
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
      el('div', 'scenario-note', 'A scenario sets that sim’s fabric & downstream tuning — and the shared client settings (both sims).'),
    );
    const helpBtn = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS');
    helpBtn.addEventListener('click', () => this.hooks.showCompareHelp());
    cmp.appendChild(helpBtn);
    section.appendChild(cmp);

    this.side.appendChild(section);
    this.setActivePreset(PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.preset === id);
    });
  }

  private setActiveScenario(pane: number, id: string | null): void {
    this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === id);
    });
  }

  // -- Knobs --------------------------------------------------------------------

  /** The config a knob of the given scope currently reads/writes. */
  private cfgFor(scope: KnobScope): SimulationConfig {
    const sims = this.hooks.getSims();
    const idx = scope === 'sim' ? Math.min(this.activePane, sims.length - 1) : 0;
    return sims[idx].cfg;
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    for (const group of GROUPS) {
      // The first per-sim group is preceded by the A/B target tabs.
      if (group.scope === 'sim' && this.paneTabBtns.length === 0) {
        section.appendChild(this.buildPaneTabs());
      }
      const details = document.createElement('details');
      details.className = 'knob-group';
      if (group.name === 'RTB Fabric') details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      details.appendChild(summary);

      for (const toggle of group.toggles) {
        const row = el('label', 'toggle-row');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const sync = () => (input.checked = toggle.get(this.cfgFor(group.scope)));
        sync();
        input.addEventListener('change', () => {
          this.applyToggle(group.scope, toggle, input.checked);
        });
        this.refreshers.push(sync);
        row.appendChild(input);
        row.appendChild(el('span', 'toggle-label', toggle.label));
        details.appendChild(row);
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
        top.appendChild(valueEl);
        row.appendChild(top);
        row.appendChild(input);
        details.appendChild(row);
      }
      section.appendChild(details);
    }
    this.side.appendChild(section);
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

  /** Mode switched by the app: sync the toggle button and per-sim state. */
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

  // -- Totals & event log ----------------------------------------------------------

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

  /** Called every frame (cheap: only touches DOM on change). */
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

    // The engine caps events[] at 200 entries, so track the lifetime count
    // per pane and render the newest unseen entries from the tail.
    sims.forEach((sim, pane) => {
      const { events, totalLogged } = sim.metrics;
      const seen = this.renderedEvents[pane] ?? 0;
      if (totalLogged < seen) this.renderedEvents[pane] = 0;
      const unseen = Math.min(totalLogged - (this.renderedEvents[pane] ?? 0), events.length);
      for (let i = events.length - unseen; i < events.length; i++) {
        const ev = events[i];
        const row = el('div', `event event-${ev.severity}`);
        if (compare) row.appendChild(el('span', `event-tag tag-${PANE_TAGS[pane].toLowerCase()}`, PANE_TAGS[pane]));
        row.appendChild(el('span', 'event-time', `${(ev.time / 1000).toFixed(1)}s`));
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

function totalsHtmlSingle(sim: Simulation): string {
  const t = sim.metrics.totals;
  return TOTAL_METRICS.map(
    (m) => `<div class="total"><span style="color:${m.color}">${m.value(t)}</span><label>${m.key}</label></div>`,
  ).join('');
}

function totalsHtmlCompare(sims: Simulation[]): string {
  const head =
    `<div class="cmp-row cmp-head"><label></label>` +
    sims.map((_, i) => `<span class="tag-${PANE_TAGS[i].toLowerCase()}">SIM ${PANE_TAGS[i]}</span>`).join('') +
    `</div>`;
  const rows = TOTAL_METRICS.map((m) => {
    const cells = sims
      .map((s) => `<span style="color:${m.color}">${m.value(s.metrics.totals)}</span>`)
      .join('');
    return `<div class="cmp-row"><label>${m.key}</label>${cells}</div>`;
  }).join('');
  return head + rows;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtCount(v: number): string {
  if (v >= 100_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
