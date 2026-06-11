/**
 * Control panel: preset cards, the pulse trigger, time controls, live knobs
 * grouped by component, lifetime counters, and the event ticker.
 * Plain DOM, no framework — knobs read/write the live SimulationConfig and
 * take effect immediately, like tuning a running system.
 */

import { PRESETS } from '../engine/presets';
import type { Simulation } from '../engine/simulation';
import type { SimulationConfig } from '../engine/types';
import { Legend } from './legend';

export interface ControlHooks {
  getSim(): Simulation;
  loadPreset(id: string): void;
  reset(): void;
  pulse(factor: number, durationMs: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(s: number): void;
  getTimeScale(): number;
  /** 'rate' → reschedule arrivals; 'structure' → entity/CPU rebuild. */
  configChanged(kind: 'rate' | 'structure' | 'plain'): void;
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
const SIGMA_Z99 = 2.3263;

const GROUPS: Array<{ name: string; knobs: KnobDef[]; toggles: ToggleDef[] }> = [
  {
    name: 'Clients',
    knobs: [
      { label: 'Clients', min: 1, max: 12, step: 1, kind: 'structure', get: (c) => c.clients.count, set: (c, v) => (c.clients.count = v) },
      { label: 'Rate / client', min: 1, max: 80, step: 1, kind: 'rate', get: (c) => c.clients.requestRatePerSec, set: (c, v) => (c.clients.requestRatePerSec = v), format: (v) => `${v}/s` },
      { label: 'Pool size', min: 1, max: 24, step: 1, get: (c) => c.clients.poolSize, set: (c, v) => (c.clients.poolSize = v) },
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
    knobs: [
      { label: 'Connection limit', min: 8, max: 500, step: 4, get: (c) => c.fabric.maxConnections, set: (c, v) => (c.fabric.maxConnections = v) },
      { label: 'TLS permits', min: 1, max: 128, step: 1, get: (c) => c.fabric.tlsHandshakeConcurrency, set: (c, v) => (c.fabric.tlsHandshakeConcurrency = v) },
      { label: 'TLS permit wait', min: 0, max: 2000, step: 10, get: (c) => c.fabric.tlsPermitWaitMs, set: (c, v) => (c.fabric.tlsPermitWaitMs = v), format: ms },
      { label: 'TLS resumption', min: 0, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionRate, set: (c, v) => (c.fabric.tlsResumptionRate = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'Resumed cost (vs full)', min: 0.1, max: 1, step: 0.05, get: (c) => c.fabric.tlsResumptionCostFactor, set: (c, v) => (c.fabric.tlsResumptionCostFactor = v), format: (v) => `${Math.round(v * 100)}%` },
      { label: 'TLS handshake time', min: 5, max: 100, step: 5, get: (c) => c.fabric.tlsHandshakeMs, set: (c, v) => (c.fabric.tlsHandshakeMs = v), format: ms },
      { label: 'TLS CPU cost', min: 5, max: 200, step: 5, get: (c) => c.fabric.tlsCpuCost, set: (c, v) => (c.fabric.tlsCpuCost = v), format: (v) => `${v}u` },
      { label: 'Processing time', min: 1, max: 10, step: 0.5, get: (c) => c.fabric.processingMs, set: (c, v) => (c.fabric.processingMs = v), format: ms },
      { label: 'CPU capacity', min: 500, max: 12000, step: 250, kind: 'structure', get: (c) => c.fabric.cpuCapacity, set: (c, v) => (c.fabric.cpuCapacity = v), format: (v) => `${(v / 1000).toFixed(1)}ku/s` },
      { label: 'Error pacing delay', min: 10, max: 1000, step: 10, get: (c) => c.fabric.errorPacingDelayMs, set: (c, v) => (c.fabric.errorPacingDelayMs = v), format: ms },
    ],
    toggles: [
      { label: 'Error pacing', get: (c) => c.fabric.errorPacingEnabled, set: (c, v) => (c.fabric.errorPacingEnabled = v) },
    ],
  },
  {
    name: 'Downstream pools',
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

export class ControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private lastTotalsHtml = '';
  private renderedEvents = 0;
  private pulseFactor = 3;
  private pulseDurationMs = 5000;
  private pauseBtn!: HTMLButtonElement;
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

    const pulseBtn = el('button', 'btn btn-pulse', '◉ PULSE ×3');
    pulseBtn.title = 'Inject a traffic surge (×factor for the set duration)';
    pulseBtn.addEventListener('click', () => this.hooks.pulse(this.pulseFactor, this.pulseDurationMs));
    wrap.appendChild(pulseBtn);

    const pulseFactor = this.miniSlider(2, 10, 1, this.pulseFactor, (v) => {
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
    const grid = el('div', 'preset-grid');
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
    this.side.appendChild(section);
    this.setActivePreset(PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.preset === id);
    });
  }

  // -- Knobs --------------------------------------------------------------------

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    for (const group of GROUPS) {
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
        const sync = () => (input.checked = toggle.get(this.hooks.getSim().cfg));
        sync();
        input.addEventListener('change', () => {
          toggle.set(this.hooks.getSim().cfg, input.checked);
          this.hooks.configChanged('plain');
          this.markCustom();
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
          const v = knob.get(this.hooks.getSim().cfg);
          input.value = String(v);
          valueEl.textContent = fmt(v);
        };
        sync();
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          knob.set(this.hooks.getSim().cfg, v);
          valueEl.textContent = fmt(knob.get(this.hooks.getSim().cfg));
          this.hooks.configChanged(knob.kind ?? 'plain');
          this.markCustom();
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

  private markCustom(): void {
    this.setActivePreset(null);
  }

  refreshKnobs(): void {
    for (const r of this.refreshers) r();
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
    const sim = this.hooks.getSim();
    const t = sim.metrics.totals;
    const successRate = t.arrivals > 0 ? (t.successes / t.arrivals) * 100 : 100;
    const entries: Array<[string, number | string, string]> = [
      ['success', `${successRate.toFixed(1)}%`, 'var(--ok)'],
      ['ok', t.successes, 'var(--ok)'],
      ['timeout', t.timeouts, 'var(--bad)'],
      ['error', t.errors, 'var(--err)'],
      ['shed·tls', t.shedTls, 'var(--warn)'],
      ['shed·conn', t.shedConnLimit, 'var(--warn)'],
      ['retries', t.retries, 'var(--retry)'],
      ['resumed TLS', t.resumedHandshakes, 'var(--tls)'],
      ['wasted TLS', t.wastedHandshakes, 'var(--bad)'],
    ];
    const html = entries
      .map(
        ([k, v, c]) =>
          `<div class="total"><span style="color:${c}">${typeof v === 'number' ? fmtCount(v) : v}</span><label>${k}</label></div>`,
      )
      .join('');
    if (this.lastTotalsHtml !== html) {
      this.lastTotalsHtml = html;
      this.totalsEl.innerHTML = html;
    }

    // The engine caps events[] at 200 entries, so track the lifetime count
    // and render the newest unseen entries from the tail.
    const { events, totalLogged } = sim.metrics;
    if (totalLogged < this.renderedEvents) this.resetLog();
    const unseen = Math.min(totalLogged - this.renderedEvents, events.length);
    for (let i = events.length - unseen; i < events.length; i++) {
      const ev = events[i];
      const row = el('div', `event event-${ev.severity}`);
      row.appendChild(el('span', 'event-time', `${(ev.time / 1000).toFixed(1)}s`));
      row.appendChild(el('span', 'event-msg', ev.message));
      this.logList.prepend(row);
      while (this.logList.children.length > 60) this.logList.lastChild?.remove();
    }
    this.renderedEvents = totalLogged;
  }

  resetLog(): void {
    this.renderedEvents = 0;
    this.logList.innerHTML = '';
  }
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
