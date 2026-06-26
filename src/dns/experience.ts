/**
 * The DNS load-distribution experience: many clients resolving Route53,
 * spreading load across many RTB Fabric servers, with overload RST shedding
 * (fast) and DNS health updates (slow) deciding where traffic lands. Owns its
 * panes (single, or two-up in comparison mode), renderer, charts, HUD, and
 * control panel. The shell drives it through the Experience interface.
 */

import type { Experience, ExperienceHosts, PlaybackController } from '../experience';
import { DnsSimulation } from './engine/dnsSimulation';
import { cloneDnsConfig, dnsPresetById, DNS_PRESETS } from './engine/presets';
import type { DnsSimulationConfig } from './engine/types';
import { DnsChartRail } from './render/charts';
import { DnsRenderer } from './render/renderer';
import { DnsControlPanel, PANE_TAGS } from './ui/controls';

/** Default playback: heavy compression — a 5-min boot plays in ~10s at 30×. */
const DEFAULT_TIME_SCALE = 30;
/** One frame may advance up to a minute of sim time at high speed-up. */
const MAX_SIM_MS_PER_FRAME = 60_000;

const SINGLE_HINT = 'Pick a scenario and tune the knobs first — traffic flows when you start.';
const COMPARE_HINT = 'Tune each sim — A above, B below — then start. Both run on the same clock and offered load.';

const COMPARE_HELP_HTML = `
  <div class="help-card">
    <h2>Comparison mode</h2>
    <ul>
      <li><b>Two sims, one clock.</b> SIM A (top) and SIM B (bottom) run in lockstep on the same virtual clock, each with its own board, charts, and totals.</li>
      <li><b>Shared offered load.</b> The Traffic knobs — shape, base/peak rate, and cohort count — apply to both sims, so they always see the same demand.</li>
      <li><b>Per-sim tuning.</b> The Clients, DNS / Route 53, Health checks, Servers, and Autoscaling groups edit one sim at a time — pick it with the SIM A / SIM B tabs in the Tuning panel.</li>
      <li><b>Scenarios.</b> A scenario sets that sim's DNS, health, server &amp; scaling tuning; only the offered load is shared. Compare e.g. Short vs Long TTL, or Reactive vs Headroom, under the same pulse.</li>
      <li><b>◉ PULSE, ✕ KILL SERVER, and ＋ ADD SERVERS hit both sims at once</b> — the same event, two responses.</li>
    </ul>
    <button id="dns-help-dismiss" class="btn">GOT IT</button>
  </div>`;

interface PaneStats {
  badge: HTMLElement;
  availability: HTMLElement;
}

interface Pane {
  sim: DnsSimulation;
  renderer: DnsRenderer;
  charts: DnsChartRail;
  stats: PaneStats | null;
}

export class DnsExperience implements Experience {
  readonly maxSimStepMs = MAX_SIM_MS_PER_FRAME;

  private panes: Pane[] = [];
  private compare = false;
  private controls!: DnsControlPanel;
  private playback!: PlaybackController;
  private hosts!: ExperienceHosts;

  private appEl = document.getElementById('app')!;
  private panesHost!: HTMLElement;
  private helpEl!: HTMLElement;
  private hudAvail!: HTMLElement;
  private degradedBadge!: HTMLElement;

  mount(hosts: ExperienceHosts, playback: PlaybackController): void {
    this.hosts = hosts;
    this.playback = playback;
    this.panesHost = hosts.stage;
    // Set the mode's default speed before building controls so the speed slider
    // initializes from it (the shell's scale carries over from the prior mode).
    this.playback.setTimeScale(DEFAULT_TIME_SCALE);

    this.buildHud();
    this.buildCompareHelp();
    this.buildPanes([cloneDnsConfig(DNS_PRESETS[0].config)]);

    this.controls = new DnsControlPanel(hosts.side, hosts.header, {
      getSims: () => this.panes.map((p) => p.sim),
      loadPreset: (id) => this.resetPanes([cloneDnsConfig(dnsPresetById(id).config)]),
      applyScenario: (pane, id) => this.applyScenario(pane, id),
      reset: () => this.resetPanes(this.panes.map((p) => cloneDnsConfig(p.sim.cfg))),
      pulse: (factor, durationMs) => {
        for (const p of this.panes) p.sim.triggerPulse(factor, durationMs);
      },
      killServer: (graceful) => {
        for (const p of this.panes) p.sim.killServer(graceful);
      },
      addServers: (n) => {
        for (const p of this.panes) p.sim.addServers(n);
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
    for (const p of this.panes) {
      p.renderer.resize();
      p.charts.resize();
    }
  }

  simTimeMs(): number {
    return this.panes[0]?.sim.now ?? 0;
  }

  onResume(): void {
    this.helpEl.classList.add('hidden');
  }

  // -- HUD + overlays ----------------------------------------------------------

  private buildHud(): void {
    this.degradedBadge = el('div', 'single-only', '▼ BELOW SLO');
    this.degradedBadge.id = 'dns-degraded';
    const availItem = el('div', 'hud-item single-only');
    this.hudAvail = el('span', 'amp-ok', '100%');
    availItem.append(this.hudAvail, labelEl('availability'));
    this.hosts.hud.append(this.degradedBadge, availItem);
  }

  private buildCompareHelp(): void {
    this.helpEl = el('div', 'hidden');
    this.helpEl.id = 'compare-help';
    this.helpEl.innerHTML = COMPARE_HELP_HTML;
    this.helpEl.querySelector('#dns-help-dismiss')!.addEventListener('click', () => this.helpEl.classList.add('hidden'));
    this.hosts.stageCol.appendChild(this.helpEl);
  }

  // -- Panes -------------------------------------------------------------------

  private buildPanes(cfgs: DnsSimulationConfig[]): void {
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
        sim: new DnsSimulation(cloneDnsConfig(cfg)),
        renderer: new DnsRenderer(canvas),
        charts: new DnsChartRail(chartsEl),
        stats,
      };
    });
    this.resize();
  }

  private resetPanes(cfgs: DnsSimulationConfig[]): void {
    this.buildPanes(cfgs);
    this.controls?.resetLog();
    this.controls?.refreshKnobs();
    this.playback.rearmGate();
  }

  private setCompare(on: boolean): void {
    if (this.compare === on) return;
    this.compare = on;
    const cfgA = cloneDnsConfig(this.panes[0].sim.cfg);
    this.resetPanes(on ? [cfgA, cloneDnsConfig(cfgA)] : [cfgA]);
    this.controls.setCompareUI(on);
    this.helpEl.classList.toggle('hidden', !on);
    this.playback.setStartHint(on ? COMPARE_HINT : SINGLE_HINT);
  }

  /**
   * Comparison-mode scenario: DNS / health / server / scaling tuning applies to
   * the chosen pane; only the offered load (Traffic group + cohort count) is
   * shared, keeping demand identical for a fair comparison.
   */
  private applyScenario(pane: number, id: string): void {
    const preset = cloneDnsConfig(dnsPresetById(id).config);
    const cfgs = this.panes.map((p) => cloneDnsConfig(p.sim.cfg));
    if (!cfgs[pane]) return;
    cfgs[pane].dns = preset.dns;
    cfgs[pane].health = preset.health;
    cfgs[pane].servers = preset.servers;
    cfgs[pane].scaling = preset.scaling;
    cfgs[pane].clients = structuredClone(preset.clients);
    cfgs[pane].slaTarget = preset.slaTarget;
    for (const c of cfgs) {
      c.traffic = structuredClone(preset.traffic);
      c.clients.cohorts = preset.clients.cohorts;
    }
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

function availStats(sim: DnsSimulation): { text: string; cls: string } {
  const a = sim.availability();
  const slo = sim.cfg.slaTarget;
  return {
    text: `${(a * 100).toFixed(1)}%`,
    cls: a >= slo ? 'amp-ok' : a >= 0.9 ? 'amp-warn' : 'amp-bad',
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
