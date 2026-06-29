/**
 * DNS-mode system overview: how a bid request finds a server through Route53,
 * the two control loops at their very different timescales, the full
 * served/shed/stale/unavailable taxonomy, and the explicit modeling
 * assumptions. Value chips read the live config, so it doubles as a spec to
 * check the model against the real fabric.
 */

import type { DnsSimulationConfig } from '../engine/types';

const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1000).toFixed(0)}s`);

interface Stage {
  n: string;
  title: string;
  value: (c: DnsSimulationConfig) => string;
  how: string;
}

const STAGES: Stage[] = [
  {
    n: '1',
    title: 'Client resolves Route 53',
    value: (c) => `TTL ${secs(c.dns.ttlMs)} · all healthy IPs · CoreDNS ${secs(c.clients.coreDnsCacheMs)}`,
    how: 'A client cohort resolves the endpoint and caches the record set for the TTL. RTB Fabric runs a private hosted zone and returns ALL advertised healthy IPs to every client (no multivalue subset). Re-resolution is staggered/jittered; a pinned fraction never re-resolves; and EKS cohorts (⎈) sit behind a shared CoreDNS cache — the whole cluster shares one answer and resolves on min(zone TTL, CoreDNS cache).',
  },
  {
    n: '2',
    title: 'Client sends to a cached IP — the FAST loop',
    value: (c) => (c.servers.rstShedding ? 'RST re-pick: on' : 'RST re-pick: off'),
    how: 'Traffic spreads across the cohort’s cached IPs. If a server is overloaded it sheds with an RST and the client immediately reconnects to ANOTHER IP in its cached set (sub-second). A request to a removed/dead IP is refused and also re-picks. This smooths hot spots — but only within the capacity that is both advertised and cached right now.',
  },
  {
    n: '3',
    title: 'Server serves or sheds',
    value: (c) => `${c.servers.capacityPerSec}/s · shed @ ${Math.round(c.servers.shedThreshold * 100)}%`,
    how: 'Each server serves up to its capacity; demand past the shed threshold is shed (RST). Capacity ramps up over a warm-up window after boot.',
  },
  {
    n: '4',
    title: 'Publisher Lambda — the SLOW loop',
    value: (c) => `every ${secs(c.dns.updateIntervalMs)}${c.dns.propagationMs ? ` + ${secs(c.dns.propagationMs)} prop` : ''}`,
    how: 'The zone is private, so Route53 does NOT health-check the servers. RTB Fabric runs a Lambda every interval that evaluates server health (LIVENESS, not load — an overloaded-but-up server keeps passing, which is why the RST loop exists) and republishes the healthy IPs. If EVERY server is unhealthy the Lambda FAILS OPEN — advertising all records rather than an empty set. A client only sees the change when its TTL expires and it re-resolves.',
  },
  {
    n: '5',
    title: 'Server lifecycle — down, replace, scale out',
    value: (c) => `boot ${secs(c.servers.bootMs)} · warm ${secs(c.servers.warmupMs)}`,
    how: 'A killed server black-holes its cached traffic (graceful drain keeps serving it for the drain window). A replacement or scale-out server takes ~5 min to boot, then must be picked up by the Lambda, published, and re-resolved before it carries load.',
  },
];

const ENGINE = {
  title: 'Two loops, two timescales — the whole point',
  body: 'The FAST loop (RST → re-pick within the cached set) reacts in milliseconds but can only move load among the IPs a client already holds. The SLOW loop — the publisher Lambda interval + TTL expiry + server boot — is the only thing that grows the healthy-and-cached capacity, and it takes minutes. So TTL is a failover lever (how fast clients leave a dead IP), not a scale-out lever (how fast new capacity absorbs a surge). When offered load exceeds total fleet capacity, no distribution scheme keeps 100% — it only decides where the loss lands.',
};

interface FailRow {
  tag: string;
  cls: string;
  cause: string;
}
const FAILURES: FailRow[] = [
  { tag: 'served', cls: 'ov-pass', cause: 'Request reached a server with capacity (possibly after one or more RST re-picks).' },
  { tag: 'shed (RST)', cls: 'ov-rst', cause: 'An overloaded server RST it; the client re-picked another cached IP. A latency/cost signal, not necessarily a loss.' },
  { tag: 'stale → dead IP', cls: 'ov-drop', cause: 'Aimed at a removed/dead IP the cohort still has cached. Re-picks if the cohort has other reachable IPs — the cost of TTL lag.' },
  { tag: 'unavailable', cls: 'ov-emfile', cause: 'No healthy cached capacity left to re-pick into — the actual availability loss (capacity shortfall or an all-dead cache).' },
];

const ASSUMPTIONS: string[] = [
  'Traffic is modeled as rates, not individual requests; the sub-second RST loop is solved to a fixed point each rebalance, while DNS / health / TTL / boot are explicit discrete events.',
  'Resolver layering is collapsed into a per-cohort effective TTL (the authoritative TTL as its floor) plus a pinned/TTL-ignoring tail (connection- or JVM-pinned clients).',
  'EKS cohorts model a cluster behind a shared CoreDNS cache: all pods share one cached answer (one cohort) and resolve on min(zone TTL, CoreDNS cache) — CoreDNS honors the record TTL capped at its cache. NodeLocal DNSCache and serve-stale are out of scope.',
  'The zone is a private hosted zone managed by an RTB Fabric publisher Lambda (run every interval) — Route53 does not health-check the servers. The Lambda evaluates liveness (not load, by default) with run-count hysteresis, and fails open (advertises all) when none are healthy.',
  'RTB Fabric returns ALL advertised healthy IPs to every client — no multivalue subset, weighting, or latency/geo routing.',
  'Clients re-resolve on cache expiry; an RST re-picks within the cached set, and fresh IPs enter only on expiry (or the opt-in early re-resolve).',
  'Availability = served ÷ offered, counted after the within-cache fast loop. RSTs and re-resolves are internal, not offered/served events.',
  'Server capacity is a fixed work-rate with a warm-up ramp; the fleet is pre-warmed at t0 (cold start excluded). Bidders are represented but do not influence the model.',
  'Negative DNS caching and per-resolver geography are out of scope.',
];

export class DnsOverview {
  private dialog: HTMLDialogElement;
  private body: HTMLElement;
  private getCfg: () => DnsSimulationConfig;
  private btn!: HTMLButtonElement;

  constructor(header: HTMLElement, getCfg: () => DnsSimulationConfig) {
    this.getCfg = getCfg;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'dns-overview-dialog';
    this.dialog.className = 'overview-dialog';

    const head = document.createElement('div');
    head.className = 'legend-header';
    head.innerHTML = '<h2>System Overview — DNS distribution</h2>';
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
    this.btn.title = 'System overview — how DNS distributes load, and every setting';
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

  private render(cfg: DnsSimulationConfig): void {
    const parts: string[] = [];
    parts.push(
      `<p class="ov-intro">A bid request finding a server through Route53, in the order the model applies each step. ` +
        `Value chips read the selected sim’s live settings. Use it to check the design against the real fabric.</p>`,
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
    const rows = FAILURES.map(
      (f) => `<div class="ov-fail-row"><span class="ov-tag ${f.cls}">${f.tag}</span><span class="ov-fail-cause">${f.cause}</span></div>`,
    ).join('');
    parts.push(`<div class="ov-panel"><h3>Outcome taxonomy</h3><div class="ov-fail">${rows}</div></div>`);
    const items = ASSUMPTIONS.map((a) => `<li>${a}</li>`).join('');
    parts.push(`<div class="ov-panel"><h3>Modeling assumptions to validate</h3><ul class="ov-assume">${items}</ul></div>`);
    parts.push('</div>');

    this.body.innerHTML = parts.join('');
  }
}
