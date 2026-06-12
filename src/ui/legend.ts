/**
 * The legend: a toggleable dialog explaining every visual encoding on the
 * board — particle shapes/colors, lane states, node gauges, breaker dots,
 * the graveyard, and the HUD readouts. Swatches are inline SVGs drawn with
 * the same palette the canvas uses, so the legend can never drift from the
 * real rendering.
 */

import { SEMANTIC, SURFACE } from '../render/colors';

interface LegendEntry {
  swatch: string; // inline SVG
  label: string;
  detail: string;
}

interface LegendSection {
  title: string;
  entries: LegendEntry[];
}

const S = 22; // swatch viewport size

function svg(inner: string): string {
  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${inner}</svg>`;
}

const c = S / 2;

function dot(color: string, r = 4): string {
  return svg(`<circle cx="${c}" cy="${c}" r="${r}" fill="${color}"/>`);
}

function ring(color: string, r = 6): string {
  return svg(`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`);
}

function halo(): string {
  return svg(
    `<circle cx="${c}" cy="${c}" r="3.5" fill="${SEMANTIC.inFlight}"/>` +
      `<circle cx="${c}" cy="${c}" r="7" fill="none" stroke="${SEMANTIC.retry}" stroke-width="1.8"/>`,
  );
}

function spikedStar(color: string): string {
  const spikes = 10;
  const pts: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const rad = i % 2 === 0 ? 9 : 4;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${(c + Math.cos(a) * rad).toFixed(1)},${(c + Math.sin(a) * rad).toFixed(1)}`);
  }
  return svg(`<polygon points="${pts.join(' ')}" fill="${color}"/>`);
}

function square(color: string): string {
  return svg(`<rect x="${c - 5}" y="${c - 5}" width="10" height="10" fill="none" stroke="${color}" stroke-width="2"/>`);
}

function cross(color: string): string {
  return svg(
    `<path d="M${c - 5} ${c - 5} L${c + 5} ${c + 5} M${c + 5} ${c - 5} L${c - 5} ${c + 5}" stroke="${color}" stroke-width="2.2"/>`,
  );
}

function line(color: string, width: number, dash = ''): string {
  return svg(
    `<line x1="2" y1="${c}" x2="${S - 2}" y2="${c}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
  );
}

function handshakeLane(): string {
  return svg(
    `<line x1="2" y1="${c}" x2="${S - 7}" y2="${c}" stroke="${SEMANTIC.tlsPulse}" stroke-width="2" stroke-dasharray="4 3"/>` +
      `<circle cx="${S - 5}" cy="${c}" r="4" fill="none" stroke="${SEMANTIC.tlsPulse}" stroke-width="1.5"/>`,
  );
}

function gauge(fillColor: string, frac: number): string {
  return svg(
    `<rect x="3" y="${c - 4}" width="${S - 6}" height="8" fill="${SURFACE.panelRaised}" stroke="${SURFACE.border}"/>` +
      `<rect x="3" y="${c - 4}" width="${(S - 6) * frac}" height="8" fill="${fillColor}"/>`,
  );
}

function breakerOpen(): string {
  return svg(
    `<path d="M${c} ${c - 6} A6 6 0 0 1 ${c + 6} ${c}" fill="none" stroke="${SEMANTIC.shed}" stroke-width="2.2"/>`,
  );
}

function poolDots(): string {
  const colors = [SEMANTIC.idle, SEMANTIC.connEstablished, SEMANTIC.tlsPulse, 'none'];
  return svg(
    colors
      .map((col, i) => {
        const x = 4 + i * 5;
        return col === 'none'
          ? `<circle cx="${x}" cy="${c}" r="2.2" fill="none" stroke="${SURFACE.textFaint}"/>`
          : `<circle cx="${x}" cy="${c}" r="2.5" fill="${col}"/>`;
      })
      .join(''),
  );
}

function graveyardSwatch(): string {
  return svg(
    `<rect x="4" y="${S - 7}" width="3" height="3" fill="${SEMANTIC.timeout}"/>` +
      `<rect x="9" y="${S - 9}" width="3" height="3" fill="${SEMANTIC.shed}"/>` +
      `<rect x="14" y="${S - 7}" width="3" height="3" fill="${SEMANTIC.error}"/>` +
      `<rect x="8" y="${S - 13}" width="3" height="3" fill="${SEMANTIC.timeout}"/>`,
  );
}

function shedTlsMote(): string {
  return svg(`<circle cx="${c}" cy="${c}" r="3.5" fill="none" stroke="${SEMANTIC.tlsPulse}" stroke-width="1.5"/>`);
}

function shedConnMote(): string {
  return svg(
    `<path d="M${c} ${c - 4} L${c + 4} ${c + 3} L${c - 4} ${c + 3} Z" fill="none" stroke="${SEMANTIC.shed}" stroke-width="1.5"/>`,
  );
}

const SECTIONS: LegendSection[] = [
  {
    title: 'Requests (particles)',
    entries: [
      { swatch: dot(SEMANTIC.inFlight), label: 'In flight', detail: 'A bid request traveling or being processed.' },
      { swatch: halo(), label: 'Retry attempt', detail: 'Purple halo: this request already failed at least once.' },
      { swatch: ring(SEMANTIC.success), label: 'Success', detail: 'Response made it back within the client timeout.' },
      { swatch: spikedStar(SEMANTIC.timeout), label: 'Timeout', detail: 'Client gave up — and tore down the connection it was using.' },
      { swatch: square(SEMANTIC.error), label: 'Error', detail: 'Downstream error or fabric-side downstream timeout, returned to the client.' },
      { swatch: cross(SEMANTIC.shed), label: 'Rejected', detail: 'Failed client-side: no connection in time, or the client’s own breaker is open.' },
    ],
  },
  {
    title: 'Connections (lanes)',
    entries: [
      { swatch: line(SEMANTIC.idle, 1.5), label: 'Idle', detail: 'Warm, established, ready for a request.' },
      { swatch: line(SEMANTIC.connEstablished, 2.5), label: 'Busy', detail: 'Carrying an in-flight request (one at a time).' },
      { swatch: handshakeLane(), label: 'TLS handshake', detail: 'Dashed + pulsing rings: full handshakes cost ~25× a proxied request in CPU; resumed ones a configurable fraction.' },
      { swatch: line(SEMANTIC.timeout, 2), label: 'Torn down / RST', detail: 'Fades red, then disappears. Timeouts poison connections; sheds RST them.' },
    ],
  },
  {
    title: 'RTB Fabric',
    entries: [
      { swatch: gauge(SEMANTIC.cpuOk, 0.4), label: 'Connection gauge', detail: 'Held connections vs the connection limit. Beyond the limit: shed·conn (RST).' },
      { swatch: ring(SEMANTIC.tlsPulse, 5), label: 'TLS permits', detail: 'Each slot is one concurrent handshake. “+N permit wait” connections are waiting; past the permit wait they are shed·tls (RST). There is no TLS queue.' },
      { swatch: gauge(SEMANTIC.cpuBad, 0.95), label: 'CPU column', detail: 'Demanded work vs capacity. Hatching above = overload; “×N slow” = every in-flight operation stretched by contention.' },
      { swatch: gauge(SEMANTIC.shed, 0.6), label: 'Downstream queues', detail: 'Requests waiting for a fabric→downstream connection, colored by age (blue→red).' },
      { swatch: graveyardSwatch(), label: 'Graveyard', detail: 'Failures pile up below the fabric and slowly settle downward as they fade. Squares are request fates: red timeouts, orange rejections, yellow errors.' },
      { swatch: shedTlsMote(), label: 'Shed TLS conn', detail: 'Hollow ring in the graveyard: a connection shed by RST because TLS permits stayed occupied past the permit wait.' },
      { swatch: shedConnMote(), label: 'Shed at conn limit', detail: 'Hollow triangle in the graveyard: a connection shed by RST at the connection limit, before any TLS work.' },
    ],
  },
  {
    title: 'Clients & downstreams',
    entries: [
      { swatch: poolDots(), label: 'Pool dots', detail: 'One per connection slot: dim idle, blue busy, cyan handshaking, hollow unused.' },
      { swatch: dot(SEMANTIC.success, 3.5), label: 'Breaker closed', detail: 'Circuit breaker healthy (clients when enabled, and each downstream).' },
      { swatch: breakerOpen(), label: 'Breaker open', detail: 'Arc fills over the cooldown. Downstreams are ejected from the random rotation and re-enter directly; an open client breaker half-opens and sends one probe (full orange ring).' },
      { swatch: gauge(SEMANTIC.cpuWarn, 0.8), label: 'Downstream load', detail: 'In-flight vs concurrency capacity; past capacity its latency inflates.' },
    ],
  },
  {
    title: 'HUD & badges',
    entries: [
      { swatch: dot(SEMANTIC.success, 4), label: 'Success rate', detail: 'Successes ÷ arrivals over the last ~2s. Lifetime rate is in Run totals.' },
      { swatch: dot(SEMANTIC.retry, 4), label: 'Amplification', detail: 'Attempts sent ÷ successes. Above ~1.5 the retry feedback loop is generating more load than the system completes.' },
      { swatch: spikedStar(SEMANTIC.timeout), label: 'Storm badge', detail: 'Lit when timeouts/rejections are high while TLS pressure (handshakes running or waiting) is high — connections are dying faster than TLS can rebuild them.' },
      { swatch: dot(SEMANTIC.shed, 4), label: 'ⓘ PULSE chip', detail: 'A traffic surge is active (×factor and time remaining shown on the canvas).' },
    ],
  },
];

export class Legend {
  private dialog: HTMLDialogElement;

  constructor(header: HTMLElement) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'legend-dialog';
    const title = document.createElement('div');
    title.className = 'legend-header';
    title.innerHTML = `<h2>Legend</h2>`;
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
    // Click on the backdrop closes.
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '? LEGEND';
    btn.title = 'What the colors, shapes, and gauges mean';
    btn.addEventListener('click', () => this.toggle());
    header.appendChild(btn);
  }

  toggle(): void {
    if (this.dialog.open) this.dialog.close();
    else this.dialog.showModal();
  }
}
