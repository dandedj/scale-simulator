/**
 * The DNS-mode legend: a toggleable dialog explaining every encoding on the
 * board — server-tile states, the advertised marker, cohort tiles, the flow
 * bands, the Route53 control box, and the outcome bar. Swatches are inline SVG
 * drawn with the same palette the canvas uses, so the legend can't drift from
 * the rendering.
 */

import { SEMANTIC, SURFACE } from '../../render/colors';

const S = 22;
const c = S / 2;
const DOWN = '#7a2a3a';

function svg(inner: string): string {
  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${inner}</svg>`;
}

function tile(fill: string, stroke: string, strokeW = 1): string {
  return svg(
    `<rect x="3" y="4" width="${S - 6}" height="${S - 8}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`,
  );
}

function tileDot(fill: string, stroke: string): string {
  return svg(
    `<rect x="3" y="4" width="${S - 6}" height="${S - 8}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
      `<circle cx="${S - 6}" cy="7" r="2.2" fill="${SEMANTIC.success}"/>`,
  );
}

function band(color: string): string {
  return svg(`<path d="M2 ${c} C ${c} ${c}, ${c} ${c}, ${S - 2} ${c}" stroke="${color}" stroke-width="5" fill="none" opacity="0.6"/>`);
}

function pinnedTile(): string {
  return svg(
    `<rect x="3" y="4" width="${S - 6}" height="${S - 8}" rx="3" fill="${alpha(SEMANTIC.success, 0.85)}"/>` +
      `<text x="6" y="15" font-size="9">📌</text>`,
  );
}

function dotsRow(): string {
  const cols = [SEMANTIC.success, SEMANTIC.success, SEMANTIC.error, SEMANTIC.success];
  return svg(cols.map((col, i) => `<circle cx="${4 + i * 5}" cy="${c}" r="2.2" fill="${col}"/>`).join(''));
}

function ttlFlash(): string {
  return svg(
    `<rect x="6" y="7" width="${S - 12}" height="${S - 14}" rx="2" fill="${alpha(SEMANTIC.success, 0.3)}"/>` +
      `<rect x="2.5" y="3.5" width="${S - 5}" height="${S - 7}" rx="4" fill="none" stroke="${SEMANTIC.tlsPulse}" stroke-width="1.5"/>`,
  );
}

function eksTile(): string {
  return svg(
    `<rect x="3" y="4" width="${S - 6}" height="${S - 8}" rx="3" fill="${alpha(SEMANTIC.success, 0.2)}" stroke="${alpha(SEMANTIC.success, 0.85)}"/>` +
      `<text x="5" y="13" font-size="7" fill="${SEMANTIC.tlsPulse}">⎈</text>`,
  );
}

function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

interface Entry {
  swatch: string;
  label: string;
  detail: string;
}
interface Section {
  title: string;
  entries: Entry[];
}

const SECTIONS: Section[] = [
  {
    title: 'Servers (tiles)',
    entries: [
      { swatch: tile(alpha(SEMANTIC.success, 0.22), SEMANTIC.success), label: 'Healthy', detail: 'The big % is per-server availability — served ÷ routed-here. Green = serving everything it is handed; advertised once the Lambda marks it healthy. The bottom bar is load (demand ÷ capacity).' },
      { swatch: tile(alpha(SEMANTIC.timeout, 0.22), SEMANTIC.timeout, 2), label: 'Overloaded (shedding)', detail: 'Demand past the shed threshold — availability drops below 100% as it RSTs the excess and clients re-pick another cached IP. Amber/red fill + bright border; load bar over 100%.' },
      { swatch: tile(alpha(SEMANTIC.tlsPulse, 0.22), SEMANTIC.tlsPulse), label: 'Booting', detail: 'Launched but not serving or advertised. Shows a boot countdown (~5 min) and progress bar.' },
      { swatch: tile(alpha(SEMANTIC.shed, 0.22), SEMANTIC.shed), label: 'Draining', detail: 'Pulled from DNS but still serving existing/cached traffic for the drain window — a graceful removal.' },
      { swatch: tile(alpha(DOWN, 0.5), DOWN), label: 'Down', detail: 'Failed or hard-killed: capacity 0, a black hole for any cached traffic still aimed at it.' },
      { swatch: tileDot(alpha(SEMANTIC.success, 0.22), SEMANTIC.success), label: 'Advertised marker', detail: 'Green corner dot: this server is currently in the Route53 record set.' },
    ],
  },
  {
    title: 'Clients & flow',
    entries: [
      { swatch: tile(alpha(SEMANTIC.success, 0.2), SEMANTIC.success), label: 'Cohort tile', detail: 'Each tile is a population sharing one cached resolution. It shows the cohort id, its availability % (served ÷ offered, colored), its offered rate, and a TTL countdown (↻ Ns to its next re-resolve). Clients are NOT health-checked — availability is an outcome, not a status. Hover for full detail.' },
      { swatch: dotsRow(), label: 'Connection pool dots', detail: 'Top-right of a cohort tile: one dot per cached IP — the servers that cohort is connected to — colored by each server’s health (green up, amber draining, red dead). Hover lists the full pool.' },
      { swatch: ttlFlash(), label: 'TTL re-resolve flash', detail: 'A cyan ring pulses on a cohort each time its TTL expires and it re-resolves DNS — so you can see lookups rippling across the population.' },
      { swatch: tile(alpha(SEMANTIC.success, 0.2), SEMANTIC.error, 3), label: 'Stale ring + link', detail: 'Yellow ring: the cohort still caches a removed/dead IP and keeps aiming at it (wasted connects), even if RST re-picks keep it served. A red line runs from the cohort to that dead server’s tile — showing exactly which clients are stuck on it until they re-resolve (pinned cohorts never do).' },
      { swatch: pinnedTile(), label: 'Pinned cohort', detail: 'A 📌 marks a connection-/JVM-pinned cohort that ignores TTL — it can only fail over via an RST re-pick, never via DNS.' },
      { swatch: eksTile(), label: 'EKS / CoreDNS cohort', detail: 'A ⎈ marks an EKS cluster behind a shared CoreDNS cache — all its pods share one resolution and fail over together on the CoreDNS-cache clock (min(zone TTL, CoreDNS cache)). The countdown shows ⎈ Ns. Hover for the shared pool.' },
      { swatch: band(SEMANTIC.success), label: 'TRAFFIC pipe', detail: 'The labeled, flowing pipe in the gap is the traffic clients send to the servers (arrow points to the fleet). Its colored layers are the outcome split — served (green), shed/RST (amber), stale→dead IP (yellow), unavailable (red).' },
    ],
  },
  {
    title: 'Route 53 & outcome',
    entries: [
      { swatch: tile(SEMANTIC.success, SURFACE.border), label: 'Record cell (advertised)', detail: 'In the control strip: one cell per server. Bright = advertised by the Lambda; dim green = healthy but not yet published (the up-to-one-Lambda-run lag); faint = not advertised.' },
      { swatch: tile(DOWN, SEMANTIC.timeout, 2), label: 'Fail-open', detail: 'When no server is healthy, RTB Fabric’s publisher Lambda fails open — advertising ALL records rather than an empty set — and the box border turns red.' },
      { swatch: tile(alpha(SEMANTIC.success, 0.85), SURFACE.border), label: 'Outcome bar', detail: 'Bottom bar: served (green) vs unavailable (red) share of offered, with the SLO marker. Availability = served ÷ offered.' },
    ],
  },
];

export class DnsLegend {
  private dialog: HTMLDialogElement;
  private btn!: HTMLButtonElement;

  constructor(header: HTMLElement) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'dns-legend-dialog';
    this.dialog.className = 'legend-dialog';
    const title = document.createElement('div');
    title.className = 'legend-header';
    title.innerHTML = `<h2>Legend — DNS distribution</h2>`;
    const close = document.createElement('button');
    close.className = 'btn legend-close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.dialog.close());
    title.appendChild(close);
    this.dialog.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'legend-grid';
    for (const section of SECTIONS) {
      const sec = document.createElement('div');
      sec.className = 'legend-section';
      const h = document.createElement('h3');
      h.textContent = section.title;
      sec.appendChild(h);
      for (const entry of section.entries) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.innerHTML = `<span class="legend-swatch">${entry.swatch}</span><span class="legend-text"><b>${entry.label}</b> — ${entry.detail}</span>`;
        sec.appendChild(row);
      }
      grid.appendChild(sec);
    }
    this.dialog.appendChild(grid);
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });

    this.btn = document.createElement('button');
    this.btn.className = 'btn';
    this.btn.textContent = '? LEGEND';
    this.btn.title = 'What the colors, tiles, and bands mean';
    this.btn.addEventListener('click', () => this.toggle());
    header.appendChild(this.btn);
  }

  toggle(): void {
    if (this.dialog.open) this.dialog.close();
    else this.dialog.showModal();
  }

  destroy(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.btn.remove();
  }
}
