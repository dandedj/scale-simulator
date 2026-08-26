/**
 * Scaling-mode legend: the encodings on the board — fleet tile phases including
 * the bake, the pipeline flow, the scale-cycle breakdown bar, and the
 * demand-vs-capacity meter.
 */

import { SEMANTIC, SURFACE } from '../../render/colors';

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
function bracket(): string {
  return svg(
    `<line x1="3" y1="${c}" x2="19" y2="${c}" stroke="${SEMANTIC.timeout}" stroke-width="2"/>` +
      `<line x1="3" y1="${c - 4}" x2="3" y2="${c + 4}" stroke="${SEMANTIC.timeout}" stroke-width="2"/>` +
      `<line x1="19" y1="${c - 4}" x2="19" y2="${c + 4}" stroke="${SEMANTIC.timeout}" stroke-width="2"/>`,
  );
}
function gantt(): string {
  return svg(
    `<rect x="2" y="${c - 5}" width="6" height="5" fill="${alpha(SEMANTIC.inFlight, 0.85)}"/>` +
      `<rect x="8" y="${c - 5}" width="5" height="5" fill="${alpha(SEMANTIC.inFlight, 0.55)}"/>` +
      `<rect x="13" y="${c - 5}" width="4" height="5" fill="${alpha(SEMANTIC.success, 0.85)}"/>` +
      `<rect x="2" y="${c + 1}" width="14" height="2.5" fill="${alpha(SEMANTIC.retry, 0.8)}"/>` +
      `<line x1="17" y1="${c - 2.5}" x2="20" y2="${c - 2.5}" stroke="${alpha(SEMANTIC.success, 0.6)}" stroke-width="1"/>`,
  );
}
function window_(): string {
  return svg(
    `<rect x="2" y="${c - 6}" width="${S - 4}" height="12" fill="none" stroke="${alpha(SURFACE.border, 1)}" stroke-width="1"/>` +
      `<rect x="9" y="${c - 6}" width="9" height="12" fill="${alpha(SEMANTIC.inFlight, 0.35)}" stroke="${SEMANTIC.inFlight}" stroke-width="1"/>`,
  );
}
function alarmBar(): string {
  return svg(
    `<rect x="2" y="${c - 4}" width="6" height="5" fill="${alpha(SEMANTIC.shed, 0.8)}"/>` +
      `<rect x="8" y="${c - 4}" width="12" height="5" fill="${alpha(SEMANTIC.timeout, 0.8)}"/>` +
      [3, 8, 13, 18].map((x) => `<rect x="${x}" y="${c + 3}" width="1" height="4" fill="${alpha(SEMANTIC.tlsPulse, 0.6)}"/>`).join(''),
  );
}
function breachBand(): string {
  return svg(`<rect x="4" y="3" width="${S - 8}" height="${S - 6}" fill="${alpha(SEMANTIC.timeout, 0.22)}"/>`);
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
      { swatch: breakdown(), label: 'Scale-cycle bar', detail: 'One full cycle split into its parts — detection, the 8 per-instance stages, and the bake — each segment ∝ its duration. The slowest is flagged; the bake segment is pink. Detection + stages is the time to the first new capacity, and the whole bar is how often a scale-out can build on the last one. Under ECS rules the bake runs alongside the pipeline rather than after it, so only the part that outlasts the pipeline shows.' },
      { swatch: tile(alpha(SEMANTIC.retry, 0.8)), label: 'Bake hold', detail: 'The ⏳ readout counts down the last scale-out’s bake (or a simple-scaling cooldown). Under ECS rules that is a hard block on the next step; under ASG rules nothing is blocked and the countdown is just until the batch starts counting toward the metric.' },
    ],
  },
  {
    title: 'Demand vs capacity',
    entries: [
      { swatch: meter(), label: 'Capacity meter', detail: 'Stacked usable (green) + ready-not-picked-up (blue) + provisioning (faint). The red ▲ marks offered demand; if it sits past the usable capacity, the red gap is dropped demand — the availability dip. A dashed pink line marks where the autoscaler thinks capacity ends: everything to its right is serving but still baking.' },
      { swatch: tile(alpha(SEMANTIC.timeout, 0.85)), label: 'Deficit / lost', detail: 'Offered beyond usable capacity: requests the fleet can’t serve until it scales. Shown red in the meter and the outcome bar; integrated as “lost req”.' },
    ],
  },
  {
    title: 'Timeline (⧗, single mode)',
    entries: [
      { swatch: bracket(), label: 'Demand bracket', detail: 'One demand change, spanning the time over which it arrived: the scheduled ramp in orange, a step in amber, a ◉ SURGE window in pink. An instant step draws as a caret instead. This is when the throughput was offered.' },
      { swatch: gantt(), label: 'Scale-out row', detail: 'One Gantt row per scaling activity: the pipeline stage by stage (green where the instance becomes serving), the bake as a bar beneath it, then a hairline from the point the batch starts counting as capacity. Under ECS rules the bake starts at the launch and runs alongside the stages; under ASG rules it follows them.' },
      { swatch: alarmBar(), label: 'Alarm lane', detail: 'Amber while the breach is accumulating datapoints, red once the alarm has fired — the amber stretch is the detection lag. Below it, a tick per metric publish: nothing can be decided between two of them.' },
      { swatch: tile(alpha(SURFACE.text, 0.5)), label: 'Row hover', detail: 'Hovering a scale-out row shows why it chose that size — the metric it measured, the capacity it scaled from, the policy arithmetic, the netting against what was already requested, any clamp that bound it, and when the capacity lands and starts counting.' },
      { swatch: window_(), label: 'Scrolling window', detail: 'The axis is a fixed window (15 min by default), not the whole run, so a couple of scale-outs fill it at readable size. The control bar picks the span — 5m / 15m / 30m / 1h, or ALL to fit the whole run — pages through history with ◀ ▶, freezes the view with ⏸ HOLD while the run carries on, and offers ● LIVE once you are off the live edge. Drag and wheel do the same by hand. Only scale-outs active in the window get a row, and the demand curve scales to the window.' },
      { swatch: breachBand(), label: 'Below-SLO band', detail: 'A red band marks every stretch where availability sat under the SLO; the header totals them. Hovering anywhere drops a cursor and reports the demand, capacity, availability and events at that moment.' },
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
