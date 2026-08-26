/**
 * Scaling-mode system overview: the scale-up pipeline stage by stage, the
 * scaling policy that sizes each step, the bake that paces them, the two limits
 * (latency vs throughput), how the scale-rate readout is computed, and the
 * modeling assumptions. Value chips read the live config.
 */

import { PIPELINE_STAGES, type ScalingSimulationConfig } from '../engine/types';

const POLICY_NAME: Record<ScalingSimulationConfig['policy']['type'], string> = {
  'target-tracking': 'target tracking',
  step: 'step scaling',
  simple: 'simple scaling',
};

const dur = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${Math.round(ms / 1000)}s`);
const tps = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(Math.round(v)));

interface Stage {
  n: string;
  title: string;
  value: (c: ScalingSimulationConfig) => string;
  how: string;
}

const STAGES: Stage[] = [
  {
    n: '1',
    title: 'Demand ramps past the buffer',
    value: (c) => `base ${tps(c.traffic.baseRateTps)} +${tps(c.traffic.rampAmountTps)} over ${dur(c.traffic.rampDurationMs)} · target ${Math.round(c.capacity.targetUtilization * 100)}%`,
    how: 'The fleet runs at the target utilization (the buffer) — the rest is headroom. As demand climbs, utilization rises past the target and the headroom starts to erode. The ramp amount and rate together set how fast that happens; a +1M add over an hour is a different problem from the same add over a minute.',
  },
  {
    n: '2',
    title: 'Detection — metric + alarm',
    value: (c) => dur(c.stages.detectionMs),
    how: 'ECS and EC2 publish the scaling metrics once a minute, and the breach must hold for the configured datapoints-to-alarm before the policy acts. No instance is even requested until this lag passes — often a big, overlooked chunk of the total.',
  },
  {
    n: '3',
    title: 'The policy sizes the step',
    value: (c) => `${POLICY_NAME[c.policy.type]} · step ${c.launch.minStepSize}–${c.launch.maxStepSize} · max ${c.launch.maxInstances}`,
    how: 'Target tracking computes the capacity that holds utilization at target and closes the gap. Step scaling picks an adjustment from a ladder keyed on how far past target the metric is. Simple scaling applies one fixed adjustment and then blocks for its cooldown. Whatever the policy asks for is clamped into the min/max scaling step size and the fleet ceiling.',
  },
  {
    n: '4',
    title: 'Per-instance pipeline (latency limit)',
    value: (c) => PIPELINE_STAGES.slice(0, -1).reduce((a, s) => a + c.stages[s.key], 0) > 0
      ? dur(PIPELINE_STAGES.slice(0, -1).reduce((a, s) => a + c.stages[s.key], 0))
      : '—',
    how: 'Each instance runs signal→ECS, EC2 launch, cloud-init/user-data, task placement, task boot, health check, and DNS publish — in parallel across the batch. After DNS publish it is serving (ready, advertised).',
  },
  {
    n: '5',
    title: 'Client pickup → in service',
    value: (c) => dur(c.stages.clientPickupMs),
    how: 'Clients must re-resolve (DNS TTL / CoreDNS) before they send traffic to the new IP. Until then the instance is ready but idle — capacity provisioned but not yet absorbing load.',
  },
  {
    n: '6',
    title: 'Bake — the new capacity settles',
    value: (c) => `${dur(c.launch.bakeMs)}${c.policy.type === 'simple' ? ` · cooldown ${dur(c.launch.cooldownMs)}` : ''}`,
    how: 'A baking instance serves traffic, but the policy does not count it in the capacity it scales *from* — while still counting it in what it has already requested. Repeated breaches of the same size therefore collapse into one scaling activity, and a deeper breach only tops up the difference. Once the bake expires the instance joins the metric and the next decision can build on it.',
  },
];

const ENGINE = {
  title: 'Two limits: latency vs throughput',
  body: 'Capacity lags demand by the pipeline LATENCY (detection + per-instance stages + pickup, ~5 min) — this sets when the first new capacity lands and how deep the dip goes. It then grows no faster than the THROUGHPUT: one scale-out per DECISION INTERVAL, which is the pipeline plus the bake, times the max scaling step size. "Add 1M TPS in 1 minute" fails on both counts if the pipeline is 5 minutes and each step then bakes for another 5: capacity arrives after the surge, and each further step waits out a bake. During the gap, served = min(offered, usable capacity), so availability = capacity ÷ demand.',
};

const POLICY = {
  title: 'How much gets added, and how often',
  body: 'Each decision computes newDesired = max(what has already been requested, the capacity the policy counts + the adjustment). Target tracking\u2019s adjustment is the gap to the capacity that holds utilization at target; step scaling reads it off a ladder keyed on breach depth; simple scaling uses one fixed number. The capacity the policy counts excludes anything still baking, which is what stops two breaches of the same size from launching the same capacity twice — and what makes the bake, not the cooldown, the thing that paces a target-tracking or step policy. AWS accepts a Cooldown only on simple scaling.',
};

const TIMELINE = {
  title: 'Reading the run back',
  body: 'The board and charts show the present; ⧗ TIMELINE (single mode) shows the whole run on one axis. Demand brackets mark when throughput was offered and over how long — the scheduled ramp, every triggered ▲ RAMP, every ◉ SURGE. Scale-out markers sit at the moment each scaling activity fired, sized by the instances it launched, so the cadence the bake imposes shows up as the gaps between them. Below-SLO stretches are shaded behind everything and totalled in the header, and hovering reports the demand, capacity, availability and events at that moment.',
};

const READOUT = {
  title: 'The scale-rate readout',
  body: 'Recover time = from the first SLO breach until usable capacity catches demand. Effective add-rate = demand added ÷ recover time. Decision interval = pipeline + bake (plus the cooldown, for simple scaling) — how often a scale-out can build on the last one. Max sustainable ramp = max step × capacity ÷ decision interval (the throughput ceiling). Pipeline latency = detection + Σ per-instance stages (the floor before any new capacity lands). Overshoot = instances beyond what the peak demand needed at target. Lost req = the integral of (offered − served) — the area of the dip.',
};

const ASSUMPTIONS: string[] = [
  'Fluid model: demand and capacity are TPS rates; pipeline stage transitions, autoscaler ticks, and demand ticks are discrete events. Deterministic — no randomness.',
  'Capacity is fixed per instance (reference: 50K TPS on a c7g.2xlarge, i.e. 100K on two).',
  'Scale-out follows the documented AWS arithmetic: warming instances count toward what has been requested but not toward the capacity the policy scales from, so repeated breaches of the same size collapse into one scaling activity. Percent adjustments round the AWS way (a magnitude above 1 rounds down; anything above zero moves at least one instance).',
  'A policy can act at most once per metric period (60s — the ECS/EC2 publish interval), whatever the model’s tick rate.',
  'A launched instance is serving after DNS publish and in service once clients pick it up; the bake clock starts there. served = min(offered, usable capacity), so demand beyond usable capacity is dropped.',
  'The fleet is pre-warmed to the buffer for the base demand at t0 (a calm start). Scale-in, instance termination, predictive scaling, and cost-per-instance are out of scope — overshoot is reported but never reclaimed.',
];

export class ScalingOverview {
  private dialog: HTMLDialogElement;
  private body: HTMLElement;
  private getCfg: () => ScalingSimulationConfig;
  private btn!: HTMLButtonElement;

  constructor(header: HTMLElement, getCfg: () => ScalingSimulationConfig) {
    this.getCfg = getCfg;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'scaling-overview-dialog';
    this.dialog.className = 'overview-dialog';
    const head = document.createElement('div');
    head.className = 'legend-header';
    head.innerHTML = '<h2>System Overview — Scaling</h2>';
    const close = document.createElement('button');
    close.className = 'btn legend-close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.dialog.close());
    head.appendChild(close);
    this.dialog.appendChild(head);
    this.body = document.createElement('div');
    this.body.className = 'ov-body';
    this.dialog.appendChild(this.body);
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    this.btn = document.createElement('button');
    this.btn.className = 'btn';
    this.btn.textContent = '◈ SYSTEM';
    this.btn.title = 'System overview — the scale-up pipeline and every setting';
    this.btn.addEventListener('click', () => this.toggle());
    header.appendChild(this.btn);
  }

  private toggle(): void {
    if (this.dialog.open) {
      this.dialog.close();
      return;
    }
    this.render(this.getCfg());
    this.dialog.showModal();
  }

  destroy(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.btn.remove();
  }

  private render(cfg: ScalingSimulationConfig): void {
    const parts: string[] = [];
    parts.push(
      `<p class="ov-intro">How a rapid demand ramp is met by the autoscaling pipeline, stage by stage. ` +
        `Value chips read the selected sim's live settings.</p>`,
    );
    parts.push('<div class="ov-flow">');
    for (const s of STAGES) {
      parts.push(
        `<div class="ov-gate"><div class="ov-gate-head"><span class="ov-n">${s.n}</span>` +
          `<span class="ov-title">${s.title}</span><span class="ov-val">${s.value(cfg)}</span></div>` +
          `<div class="ov-gate-how">${s.how}</div></div>`,
      );
      parts.push('<div class="ov-arrow">↓</div>');
    }
    parts.push(
      `<div class="ov-deadline"><div class="ov-lane-head">${ENGINE.title}</div><p class="ov-lane-blurb">${ENGINE.body}</p></div>`,
    );
    parts.push('</div>');
    parts.push('<div class="ov-panels">');
    parts.push(`<div class="ov-panel ov-engine"><h3>${POLICY.title}</h3><p>${POLICY.body}</p></div>`);
    parts.push(`<div class="ov-panel"><h3>${READOUT.title}</h3><p>${READOUT.body}</p></div>`);
    parts.push(`<div class="ov-panel"><h3>${TIMELINE.title}</h3><p>${TIMELINE.body}</p></div>`);
    const items = ASSUMPTIONS.map((a) => `<li>${a}</li>`).join('');
    parts.push(`<div class="ov-panel"><h3>Modeling assumptions</h3><ul class="ov-assume">${items}</ul></div>`);
    parts.push('</div>');
    this.body.innerHTML = parts.join('');
  }
}
