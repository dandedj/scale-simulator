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
      `<rect x="3" y="4" width="7" height="3" fill="rgba(0,0,0,0.55)"/>`,
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
      { swatch: tile(alpha(SEMANTIC.success, 0.22), SEMANTIC.success), label: 'Healthy', detail: 'Serving and (once health checks pass) advertised. The load bar shows demand ÷ capacity.' },
      { swatch: tile(alpha(SEMANTIC.timeout, 0.22), SEMANTIC.timeout, 2), label: 'Overloaded', detail: 'Demand past the shed threshold — sheds the excess via RST so clients re-pick another cached IP. Bright border.' },
      { swatch: tile(alpha(SEMANTIC.tlsPulse, 0.22), SEMANTIC.tlsPulse), label: 'Booting', detail: 'Launched but not serving or advertised. Shows a boot countdown (~5 min) and progress bar.' },
      { swatch: tile(alpha(SEMANTIC.shed, 0.22), SEMANTIC.shed), label: 'Draining', detail: 'Pulled from DNS but still serving existing/cached traffic for the drain window — a graceful removal.' },
      { swatch: tile(alpha(DOWN, 0.5), DOWN), label: 'Down', detail: 'Failed or hard-killed: capacity 0, a black hole for any cached traffic still aimed at it.' },
      { swatch: tileDot(alpha(SEMANTIC.success, 0.22), SEMANTIC.success), label: 'Advertised marker', detail: 'Green corner dot: this server is currently in the Route53 record set.' },
    ],
  },
  {
    title: 'Clients & flow',
    entries: [
      { swatch: tile(alpha(SEMANTIC.success, 0.85), SEMANTIC.success), label: 'Cohort served', detail: 'A client cohort getting ~100% availability. Each tile is a population sharing one cached resolution.' },
      { swatch: tile(alpha(SEMANTIC.timeout, 0.85), SEMANTIC.timeout), label: 'Cohort losing', detail: 'A cohort with availability below ~90% — its cached IPs are dead or saturated.' },
      { swatch: pinnedTile(), label: 'Pinned cohort', detail: 'A notch marks a connection-/JVM-pinned cohort that ignores TTL — it can only fail over via an RST re-pick, never via DNS.' },
      { swatch: band(SEMANTIC.success), label: 'Served flow', detail: 'Green band from clients to servers; thickness ∝ requests/sec served.' },
      { swatch: band(SEMANTIC.shed), label: 'Shed (RST) flow', detail: 'Amber band: traffic an overloaded server shed, re-picked within the cohort’s cache.' },
      { swatch: band(SEMANTIC.error), label: 'Stale → dead IP', detail: 'Yellow band: requests aimed at a removed/dead IP a cohort still has cached — the staleness signature.' },
      { swatch: band(SEMANTIC.timeout), label: 'Unavailable', detail: 'Red band: requests that found no healthy cached capacity — the actual availability loss.' },
    ],
  },
  {
    title: 'Route 53 & outcome',
    entries: [
      { swatch: tile(SEMANTIC.success, SURFACE.border), label: 'Record cell (advertised)', detail: 'In the control strip: one cell per server. Bright = advertised; dim green = healthy but not yet advertised (DNS lag); faint = not advertised.' },
      { swatch: tile(DOWN, SEMANTIC.timeout, 2), label: 'Fail-open', detail: 'When every server is unhealthy, Route53 returns ALL records rather than an empty answer — the box border turns red.' },
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
