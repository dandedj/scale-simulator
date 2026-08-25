/**
 * Scaling-mode legend: the encodings on the board — fleet tile phases including
 * the bake, the pipeline flow, the scale-cycle breakdown bar, and the
 * demand-vs-capacity meter.
 */

import { SEMANTIC } from '../../render/colors';

const S = 22;
const c = S / 2;

function svg(inner: string): string {
  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${inner}</svg>`;
}
function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function tile(fill: string): string {
  return svg(`<rect x="4" y="5" width="${S - 8}" height="${S - 10}" rx="2" fill="${fill}"/>`);
}
function bakingTile(): string {
  return svg(
    `<rect x="4" y="5" width="${S - 8}" height="${S - 10}" rx="2" fill="${alpha(SEMANTIC.success, 0.75)}"/>` +
      `<rect x="4.75" y="5.75" width="${S - 9.5}" height="${S - 11.5}" rx="2" fill="none" stroke="${SEMANTIC.retry}" stroke-width="1.5"/>`,
  );
}
function dotsRow(color: string): string {
  return svg([4, 9, 14].map((x) => `<circle cx="${x}" cy="${c}" r="2.2" fill="${color}"/>`).join(''));
}
function meter(): string {
  return svg(
    `<rect x="2" y="${c - 4}" width="9" height="8" fill="${alpha(SEMANTIC.success, 0.85)}"/>` +
      `<rect x="11" y="${c - 4}" width="4" height="8" fill="${alpha(SEMANTIC.inFlight, 0.7)}"/>` +
      `<line x1="17" y1="${c - 6}" x2="17" y2="${c + 6}" stroke="${SEMANTIC.timeout}" stroke-width="2"/>`,
  );
}
function breakdown(): string {
  return svg(
    `<rect x="2" y="${c - 4}" width="6" height="8" fill="${alpha(SEMANTIC.inFlight, 0.85)}"/>` +
      `<rect x="8" y="${c - 4}" width="10" height="8" fill="${alpha(SEMANTIC.timeout, 0.85)}"/>` +
      `<rect x="18" y="${c - 4}" width="3" height="8" fill="${alpha(SEMANTIC.inFlight, 0.6)}"/>`,
  );
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
    title: 'Fleet (instances)',
    entries: [
      { swatch: tile(alpha(SEMANTIC.success, 0.85)), label: 'In use (serving)', detail: 'Booted, health-checked, in DNS, and picked up by clients — carrying traffic. Availability depends on how much of this exists.' },
      { swatch: tile(alpha(SEMANTIC.inFlight, 0.85)), label: 'Ready, not picked up', detail: 'Advertised in DNS but clients haven’t re-resolved to it yet (the client-pickup lag). Provisioned but idle.' },
      { swatch: tile(alpha(SEMANTIC.tlsPulse, 0.6)), label: 'Provisioning', detail: 'Still in the scale-up pipeline (launch → cloud-init → boot → health → DNS). Pulses while it works; contributes no capacity yet.' },
      { swatch: bakingTile(), label: 'Baking (uncounted)', detail: 'In service and carrying traffic, but inside its warmup window — so the autoscaler does not count it in the fleet it scales from. Outlined in pink until the bake expires.' },
    ],
  },
  {
    title: 'Pipeline & lag',
    entries: [
      { swatch: dotsRow(SEMANTIC.tlsPulse), label: 'Pipeline flow', detail: 'Each row is a stage; dots are instances moving through it (left→right by progress). The count on the right is how many are in that stage now.' },
      { swatch: breakdown(), label: 'Scale-cycle bar', detail: 'One full cycle split into its parts — detection, the 8 per-instance stages, and the bake — each segment ∝ its duration. The slowest is flagged; the bake segment is pink. Detection + stages is the time to the first new capacity, and the whole bar is how often a scale-out can build on the last one.' },
      { swatch: tile(alpha(SEMANTIC.retry, 0.8)), label: 'Bake hold', detail: 'The ⏳ readout counts down what the last scale-out is still waiting on — the bake, or a simple-scaling cooldown — before the policy can act again.' },
    ],
  },
  {
    title: 'Demand vs capacity',
    entries: [
      { swatch: meter(), label: 'Capacity meter', detail: 'Stacked usable (green) + ready-not-picked-up (blue) + provisioning (faint). The red ▲ marks offered demand; if it sits past the usable capacity, the red gap is dropped demand — the availability dip. A dashed pink line marks where the autoscaler thinks capacity ends: everything to its right is serving but still baking.' },
      { swatch: tile(alpha(SEMANTIC.timeout, 0.85)), label: 'Deficit / lost', detail: 'Offered beyond usable capacity: requests the fleet can’t serve until it scales. Shown red in the meter and the outcome bar; integrated as “lost req”.' },
    ],
  },
];

export class ScalingLegend {
  private dialog: HTMLDialogElement;
  private btn!: HTMLButtonElement;

  constructor(header: HTMLElement) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'scaling-legend-dialog';
    this.dialog.className = 'legend-dialog';
    const title = document.createElement('div');
    title.className = 'legend-header';
    title.innerHTML = `<h2>Legend — Scaling</h2>`;
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
    this.btn.title = 'What the tiles, pipeline, and meters mean';
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
