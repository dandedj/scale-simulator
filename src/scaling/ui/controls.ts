/**
 * Control panel for the Scaling sim: scenario presets, the SURGE trigger, live
 * knobs (demand, capacity/buffer, the 9 scale-up stages, launch throughput), run
 * totals, and the event ticker. Mirrors the DNS panel's structure and CSS.
 *
 * The Demand group is 'global' (shared across compare panes so offered load is
 * identical); the rest are 'sim' (edited per pane via the SIM A / SIM B tabs).
 */

import { compareSuccessRates } from '../../stats';
import { SCALING_PRESETS } from '../engine/presets';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import type { ScalingSimulationConfig, ScalingTrafficShape } from '../engine/types';
import { ScalingLegend } from './legend';
import { ScalingOverview } from './overview';

export const PANE_TAGS = ['A', 'B'] as const;
type KnobScope = 'global' | 'sim';

export interface ScalingControlHooks {
  getSims(): ScalingSimulation[];
  loadPreset(id: string): void;
  applyScenario(pane: number, id: string): void;
  reset(): void;
  surge(factor: number, durationMs: number): void;
  ramp(amountTps: number, durationMs: number): void;
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
  get(c: ScalingSimulationConfig): number;
  set(c: ScalingSimulationConfig, v: number): void;
  format?(v: number): string;
  info?: SettingInfo;
}
interface ToggleDef {
  label: string;
  get(c: ScalingSimulationConfig): boolean;
  set(c: ScalingSimulationConfig, v: boolean): void;
  info?: SettingInfo;
}

const tps = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M/s` : v >= 1e3 ? `${Math.round(v / 1e3)}K/s` : `${Math.round(v)}/s`);
const secs = (v: number) => `${Math.round(v / 1000)}s`;
const mins = (v: number) => (v >= 60_000 ? `${(v / 60_000).toFixed(1)}m` : `${Math.round(v / 1000)}s`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

function stageKnob(label: string, key: keyof ScalingSimulationConfig['stages'], info: SettingInfo): KnobDef {
  return {
    label,
    min: 0,
    max: 300_000,
    step: 5_000,
    get: (c) => c.stages[key],
    set: (c, v) => (c.stages[key] = v),
    format: mins,
    info,
  };
}

const GROUPS: Array<{ name: string; scope: KnobScope; knobs: KnobDef[]; toggles: ToggleDef[] }> = [
  {
    name: 'Demand',
    scope: 'global',
    knobs: [
      {
        label: 'Base rate', min: 20_000, max: 1_000_000, step: 10_000, get: (c) => c.traffic.baseRateTps, set: (c, v) => (c.traffic.baseRateTps = v), format: tps,
        info: {
          what: 'Steady demand and the floor of the ramp (TPS).',
          how: 'The fleet is pre-warmed to serve this at the target utilization, so the run starts calm.',
          expect: 'Sets the baseline; the ramp climbs from here to the peak.',
        },
      },
      {
        label: 'Peak rate', min: 100_000, max: 3_000_000, step: 50_000, get: (c) => c.traffic.peakRateTps, set: (c, v) => (c.traffic.peakRateTps = v), format: tps,
        info: {
          what: 'The demand the ramp climbs to (TPS).',
          how: 'Peak − base is the capacity the fleet must add. At 50K/instance, +1M TPS needs 20 more instances at 100% (≈33 at a 60% buffer).',
          expect: 'A peak the pipeline can’t reach in time drops availability until it catches up.',
        },
      },
      {
        label: 'Ramp start', min: 0, max: 120_000, step: 5_000, get: (c) => c.traffic.rampStartMs, set: (c, v) => (c.traffic.rampStartMs = v), format: secs,
        info: {
          what: 'How long demand holds at base before the ramp begins.',
          how: 'A short lead-in so the calm baseline is visible before the surge.',
          expect: 'Cosmetic — shifts when the ramp starts.',
        },
      },
      {
        label: 'Ramp duration', min: 5_000, max: 600_000, step: 5_000, get: (c) => c.traffic.rampDurationMs, set: (c, v) => (c.traffic.rampDurationMs = v), format: mins,
        info: {
          what: 'Time to climb base → peak — and the duration of a triggered ▲ RAMP.',
          how: 'The ramp rate = (peak − base) ÷ this. Compare it against the max sustainable ramp (batch × capacity ÷ cooldown).',
          expect: 'A ramp faster than the pipeline can add capacity opens an availability dip; a gentle ramp stays covered by headroom.',
        },
      },
      {
        label: 'Ramp amount', min: 100_000, max: 3_000_000, step: 100_000, get: (c) => c.traffic.rampAmountTps, set: (c, v) => (c.traffic.rampAmountTps = v), format: tps,
        info: {
          what: 'How much the ▲ RAMP button adds (TPS), over the ramp duration.',
          how: 'Click ▲ RAMP to schedule an additive ramp of this size on top of current demand (e.g. +1M TPS over 1 min). Ramps stack and persist until reset.',
          expect: 'The on-demand version of the surge, but a ramp instead of a step — schedule a specific capacity increase and watch the fleet chase it.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Capacity & buffer',
    scope: 'sim',
    knobs: [
      {
        label: 'Capacity / instance', min: 5_000, max: 200_000, step: 5_000, get: (c) => c.capacity.capacityPerInstanceTps, set: (c, v) => (c.capacity.capacityPerInstanceTps = v), format: tps,
        info: {
          what: 'TPS one instance serves at 100%.',
          how: 'Reference: 50K on a c7g.2xlarge (100K on two). Fleet capacity = instances × this.',
          expect: 'Bigger instances mean fewer to launch for a given add — fewer batches, faster to target.',
        },
      },
      {
        label: 'Target utilization (buffer)', min: 0.2, max: 0.95, step: 0.05, get: (c) => c.capacity.targetUtilization, set: (c, v) => (c.capacity.targetUtilization = v), format: pct,
        info: {
          what: 'The utilization the autoscaler holds — the buffer.',
          how: 'Steady-state util sits here; (1 − this) is headroom. Scale-out triggers when util exceeds it. The fleet is pre-warmed to keep base at this util.',
          expect: 'A lower target = more headroom that absorbs a ramp during the scaling lag (shallower dip) — at the cost of more idle instances.',
        },
      },
    ],
    toggles: [],
  },
  {
    name: 'Scale-up stages',
    scope: 'sim',
    knobs: [
      stageKnob('Detection', 'detectionMs', {
        what: 'Metric emit + ASG alarm before any launch.',
        how: 'The breach must persist this long before the ASG acts (metric period × datapoints-to-alarm).',
        expect: 'Often a big, overlooked chunk — nothing is even requested until it fires.',
      }),
      stageKnob('Signal → ECS', 'signalMs', {
        what: 'Accept the scaling signal and notify ECS.',
        how: 'Control-plane handoff before an instance is requested.',
        expect: 'Usually small.',
      }),
      stageKnob('Launch EC2', 'launchMs', {
        what: 'Request + start the EC2 instance.',
        how: 'Capacity request through to a running instance.',
        expect: 'Warm pools / pre-provisioned capacity shrink this sharply.',
      }),
      stageKnob('Cloud-init / user-data', 'cloudInitMs', {
        what: 'Run cloud-init and user-data on boot.',
        how: 'Per-instance bootstrap before the app can start.',
        expect: 'A baked AMI moves this work to build time — big win.',
      }),
      stageKnob('Task placement', 'placeMs', {
        what: 'ECS schedules the task onto the instance.',
        how: 'Scheduler placement latency.',
        expect: 'Usually small.',
      }),
      stageKnob('Task boot', 'bootMs', {
        what: 'Container / app process start.',
        how: 'Image pull + process init + warm-up before it can serve.',
        expect: 'Slow app/JVM starts dominate here; pre-pulled images help.',
      }),
      stageKnob('Health check', 'healthCheckMs', {
        what: 'Pass health checks before it is added.',
        how: 'Grace period + consecutive passes before it is considered ready.',
        expect: 'Stricter checks are safer but slower to admit new capacity.',
      }),
      stageKnob('DNS publish', 'dnsPublishMs', {
        what: 'Register the instance in DNS (advertised).',
        how: 'After this the instance is serving/ready, but clients haven’t resolved it yet.',
        expect: 'The record-set update lag before clients can even learn about it.',
      }),
      stageKnob('Client pickup', 'clientPickupMs', {
        what: 'Clients re-resolve and start using it.',
        how: 'DNS TTL / CoreDNS cache before traffic actually flows to the new IP.',
        expect: 'Until this passes the instance is provisioned but idle — see the DNS tab for how this lag behaves.',
      }),
    ],
    toggles: [],
  },
  {
    name: 'Launch throughput',
    scope: 'sim',
    knobs: [
      {
        label: 'Batch size', min: 1, max: 40, step: 1, get: (c) => c.launch.launchBatchSize, set: (c, v) => (c.launch.launchBatchSize = v),
        info: {
          what: 'Instances launched per scale-out step.',
          how: 'With the cooldown, sets the sustained add rate = batch × capacity ÷ cooldown.',
          expect: 'Bigger batches add capacity faster once the pipeline fills — the throughput lever.',
        },
      },
      {
        label: 'Cooldown', min: 5_000, max: 300_000, step: 5_000, get: (c) => c.launch.cooldownMs, set: (c, v) => (c.launch.cooldownMs = v), format: mins,
        info: {
          what: 'Minimum time between scale-out steps.',
          how: 'Prevents launching a huge fleet before the first batch reports in.',
          expect: 'Shorter cooldown raises the sustained scale rate; too long starves a fast ramp.',
        },
      },
      {
        label: 'Max instances', min: 1, max: 100, step: 1, get: (c) => c.launch.maxInstances, set: (c, v) => (c.launch.maxInstances = v),
        info: {
          what: 'Ceiling on fleet size.',
          how: 'Scale-out stops here.',
          expect: 'Below what the peak needs and availability can never fully recover.',
        },
      },
    ],
    toggles: [],
  },
];

type Totals = ScalingSimulation['metrics']['totals'];

const TOTAL_METRICS: Array<{ key: string; color: string; value(t: Totals): string }> = [
  { key: 'availability', color: 'var(--ok)', value: (t) => `${(t.offered > 0 ? (t.served / t.offered) * 100 : 100).toFixed(2)}%` },
  { key: 'lost req', color: 'var(--bad)', value: (t) => fmtBig(t.lost) },
  { key: 'served', color: 'var(--ok)', value: (t) => fmtBig(t.served) },
  { key: 'launches', color: 'var(--info)', value: (t) => String(t.launches) },
  { key: 'instances +', color: 'var(--info)', value: (t) => String(t.instancesLaunched) },
  { key: 'peak fleet', color: 'var(--tls)', value: (t) => String(t.peakInstances) },
];

export class ScalingControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private lastTotalsHtml = '';
  private renderedEvents: number[] = [];
  private surgeFactor = 2;
  private surgeDurationMs = 60_000;
  private pauseBtn!: HTMLButtonElement;
  private rampBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private paneTabBtns: HTMLButtonElement[] = [];
  private activePane = 0;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: ScalingControlHooks;
  private legend!: ScalingLegend;
  private overview!: ScalingOverview;

  constructor(side: HTMLElement, header: HTMLElement, hooks: ScalingControlHooks) {
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

  private buildHeaderControls(): void {
    const wrap = el('div', 'time-controls');
    const surgeBtn = el('button', 'btn btn-pulse', '◉ SURGE ×2');
    surgeBtn.title = 'Step demand up by the factor for the set duration (on top of the shape)';
    surgeBtn.addEventListener('click', () => this.hooks.surge(this.surgeFactor, this.surgeDurationMs));
    wrap.appendChild(surgeBtn);
    const factor = this.miniSlider(1.2, 5, 0.1, this.surgeFactor, (v) => {
      this.surgeFactor = v;
      surgeBtn.textContent = `◉ SURGE ×${v.toFixed(1)}`;
    });
    factor.title = 'Surge intensity';
    wrap.appendChild(factor);

    this.rampBtn = el('button', 'btn', '▲ RAMP') as HTMLButtonElement;
    this.rampBtn.title = 'Schedule a ramp of the configured amount over the ramp duration (Demand group)';
    this.rampBtn.addEventListener('click', () => {
      const t = this.cfgFor('global').traffic;
      this.hooks.ramp(t.rampAmountTps, t.rampDurationMs);
    });
    wrap.appendChild(this.rampBtn);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    wrap.appendChild(this.pauseBtn);

    const speedWrap = el('div', 'speed-wrap');
    const speedLabel = el('span', 'speed-label');
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '1';
    speed.step = '0.005';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(1), Math.log10(600), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(1)) / (Math.log10(600) - Math.log10(1));
    const syncSpeed = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 1 ? `${Math.round(s)}× speed` : `${(1 / s).toFixed(0)}× slower`;
    };
    speed.value = String(fromScale(Math.min(600, Math.max(1, this.hooks.getTimeScale()))));
    speed.addEventListener('input', () => {
      this.hooks.setTimeScale(toScale(parseFloat(speed.value)));
      syncSpeed();
    });
    syncSpeed();
    speedWrap.append(speed, speedLabel);
    wrap.appendChild(speedWrap);

    const resetBtn = el('button', 'btn', '↺ RESET');
    resetBtn.title = 'Restart with the current settings';
    resetBtn.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(resetBtn);

    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.title = 'Run two configs side by side under the same demand';
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);

    this.overview = new ScalingOverview(wrap, () => this.cfgFor('sim'));
    this.legend = new ScalingLegend(wrap);
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

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));
    const grid = el('div', 'preset-grid single-only');
    for (const preset of SCALING_PRESETS) {
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
      for (const preset of SCALING_PRESETS) {
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
    cmp.appendChild(el('div', 'scenario-note', 'A scenario sets that sim’s capacity, stages & launch tuning; the demand ramp applies to both sims.'));
    const helpBtn = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS');
    helpBtn.addEventListener('click', () => this.hooks.showCompareHelp());
    cmp.appendChild(helpBtn);
    section.appendChild(cmp);
    this.side.appendChild(section);
    this.setActivePreset(SCALING_PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => c.classList.toggle('active', c.dataset.preset === id));
  }
  private setActiveScenario(pane: number, id: string | null): void {
    this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => b.classList.toggle('active', b.dataset.preset === id));
  }

  private cfgFor(scope: KnobScope): ScalingSimulationConfig {
    const sims = this.hooks.getSims();
    const idx = scope === 'sim' ? Math.min(this.activePane, sims.length - 1) : 0;
    return sims[idx].cfg;
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    for (const group of GROUPS) {
      if (group.scope === 'sim' && this.paneTabBtns.length === 0) section.appendChild(this.buildPaneTabs());
      const details = document.createElement('details');
      details.className = 'knob-group';
      if (group.name === 'Scale-up stages' || group.name === 'Capacity & buffer') details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      details.appendChild(summary);
      if (group.name === 'Demand') details.appendChild(this.buildShapeSelector());

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
    top.appendChild(el('div', 'knob-label', 'Demand shape'));
    row.appendChild(top);
    const seg = el('div', 'shape-seg');
    const shapes: ScalingTrafficShape[] = ['steady', 'ramp', 'step'];
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
      this.hooks.configChanged('rate', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      knob.set(sims[idx].cfg, v);
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
    const t = this.cfgFor('global').traffic;
    const amt = t.rampAmountTps >= 1e6 ? `${(t.rampAmountTps / 1e6).toFixed(1)}M` : `${Math.round(t.rampAmountTps / 1e3)}K`;
    const rampLabel = `▲ RAMP +${amt}/${mins(t.rampDurationMs)}`;
    if (this.rampBtn.textContent !== rampLabel) this.rampBtn.textContent = rampLabel;
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

function totalsHtmlSingle(sim: ScalingSimulation): string {
  const t = sim.metrics.totals;
  return TOTAL_METRICS.map((m) => `<div class="total"><span style="color:${m.color}">${m.value(t)}</span><label>${m.key}</label></div>`).join('');
}

function totalsHtmlCompare(sims: ScalingSimulation[]): string {
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

function significanceHtml(sims: ScalingSimulation[]): string {
  if (sims.length < 2) return '';
  const a = sims[0].metrics.totals;
  const b = sims[1].metrics.totals;
  const g = compareSuccessRates(Math.round(a.offered), Math.round(a.served), Math.round(b.offered), Math.round(b.served));
  let cls: string;
  let verdict: string;
  if (!g.enough) {
    cls = 'sig-wait';
    verdict = 'gathering data…';
  } else if (g.confidence >= 0.95) {
    cls = 'sig-strong';
    verdict = `significant (${Math.round(g.confidence * 100)}%)${g.better ? ` · SIM ${g.better} better` : ''}`;
  } else if (g.confidence > 0) {
    cls = 'sig-some';
    verdict = `weak (90%)${g.better ? ` · SIM ${g.better} better` : ''}`;
  } else {
    cls = 'sig-none';
    verdict = 'not significant';
  }
  const stats = g.enough ? `z=${g.z.toFixed(2)} · p=${g.pValue < 0.001 ? '<0.001' : g.pValue.toFixed(3)}` : `n=${Math.round(a.offered)}/${Math.round(b.offered)}`;
  return (
    `<div class="cmp-sig ${cls}"><div class="cmp-sig-head"><label>Δ availability (B−A)</label>` +
    `<b>${g.deltaPp >= 0 ? '+' : '−'}${Math.abs(g.deltaPp).toFixed(2)}pp</b></div>` +
    `<div class="cmp-sig-verdict">${verdict}</div><div class="cmp-sig-stats">${stats}</div></div>` +
    `<div class="cmp-sig-note">availability = served ÷ offered; directional (correlated failures inflate confidence)</div>`
  );
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
