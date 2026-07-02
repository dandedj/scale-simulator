/**
 * Scaling-mode system overview: the scale-up pipeline stage by stage, the two
 * limits (latency vs throughput), how the scale-rate readout is computed, and
 * the modeling assumptions. Value chips read the live config.
 */

import { PIPELINE_STAGES, type ScalingSimulationConfig } from '../engine/types';

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
    value: (c) => `base ${tps(c.traffic.baseRateTps)} → ${tps(c.traffic.peakRateTps)} · target ${Math.round(c.capacity.targetUtilization * 100)}%`,
    how: 'The fleet runs at the target utilization (the buffer) — the rest is headroom. As demand climbs, utilization rises past the target and the headroom starts to erode.',
  },
  {
    n: '2',
    title: 'Detection — metric + ASG alarm',
    value: (c) => dur(c.stages.detectionMs),
    how: 'A metric must emit and the alarm must hold (datapoints-to-alarm) before the ASG acts. No instance is even requested until this lag passes — often a big, overlooked chunk of the total.',
  },
  {
    n: '3',
    title: 'Launch a batch (throughput limit)',
    value: (c) => `${c.launch.launchBatchSize} / step · cooldown ${dur(c.launch.cooldownMs)} · max ${c.launch.maxInstances}`,
    how: 'The ASG launches a batch, waits out the cooldown, then launches again — so the *sustained* add rate is batch × capacity ÷ cooldown, regardless of how deep the shortfall is.',
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
    title: 'Client pickup → usable',
    value: (c) => dur(c.stages.clientPickupMs),
    how: 'Clients must re-resolve (DNS TTL / CoreDNS) before they send traffic to the new IP. Until then the instance is ready but idle — capacity provisioned but not yet absorbing load.',
  },
];

const ENGINE = {
  title: 'Two limits: latency vs throughput',
  body: 'Capacity lags demand by the pipeline LATENCY (detection + per-instance stages + pickup, ~5 min) — this sets when the first new capacity lands and how deep the dip goes. It grows no faster than the THROUGHPUT (batch × capacity ÷ cooldown) — this sets the sustained TPS/min you can add. "Add 1M TPS in 1 minute" fails on both counts if the pipeline is 5 minutes and the throughput is 200K/min: capacity arrives after the surge, and not fast enough. During the gap, served = min(offered, usable capacity), so availability = capacity ÷ demand.',
};

const READOUT = {
  title: 'The scale-rate readout',
  body: 'Recover time = from the first SLO breach until usable capacity catches demand. Effective add-rate = demand added ÷ recover time. Max sustainable ramp = batch × capacity ÷ cooldown (the throughput ceiling). Pipeline latency = detection + Σ per-instance stages (the floor before any new capacity lands). Lost req = the integral of (offered − served) — the area of the dip.',
};

const ASSUMPTIONS: string[] = [
  'Fluid model: demand and capacity are TPS rates; pipeline stage transitions, autoscaler ticks, and demand ticks are discrete events. Deterministic — no randomness.',
  'Capacity is fixed per instance (reference: 50K TPS on a c7g.2xlarge, i.e. 100K on two). The autoscaler is target-tracking: it provisions toward keeping utilization at the buffer target.',
  'A launched instance is serving after DNS publish and usable once clients pick it up; served = min(offered, usable capacity), so demand beyond usable capacity is dropped.',
  'The fleet is pre-warmed to the buffer for the base demand at t0 (a calm start). Instance termination / scale-in and cost-per-instance are out of scope.',
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
    parts.push(`<div class="ov-panel ov-engine"><h3>${READOUT.title}</h3><p>${READOUT.body}</p></div>`);
    const items = ASSUMPTIONS.map((a) => `<li>${a}</li>`).join('');
    parts.push(`<div class="ov-panel"><h3>Modeling assumptions</h3><ul class="ov-assume">${items}</ul></div>`);
    parts.push('</div>');
    this.body.innerHTML = parts.join('');
  }
}
