/**
 * The Scaling timeline pane: one annotated time axis for the whole run, so
 * "what happened, and when" reads at a glance rather than being reconstructed
 * from a scrolling ticker.
 *
 * Top to bottom: the offered-demand curve against usable capacity (with the
 * below-SLO stretches shaded behind it), a lane of demand brackets showing when
 * throughput was offered and over how long, a lane of scale-out markers sized by
 * how many instances each one launched, and the time axis. Hovering drops a
 * cursor and reports the demand, capacity and events at that moment.
 *
 * The axis spans the whole run rather than a rolling window — and extends to a
 * scheduled ramp that hasn't happened yet, so the plan is visible before the run
 * starts.
 */

import { SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import type { ScalingDemandSpan, ScalingSimEventLog, ScalingTimelineView } from '../engine/types';

/** Axis tick steps (ms), coarsest that still leaves ~6+ ticks wins. */
const TICK_STEPS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000];
/** Never squeeze the axis below this, so an idle run still reads as a timeline. */
const MIN_AXIS_MS = 60_000;
/** Rows the demand-bracket lane will stack before it stops drawing more. */
const MAX_SPAN_ROWS = 3;

const LANE_COLOR: Record<ScalingDemandSpan['kind'], string> = {
  ramp: SEMANTIC.timeout,
  step: SEMANTIC.shed,
  surge: SEMANTIC.retry,
};

interface Layout {
  plotX: number;
  plotW: number;
  demandY: number;
  demandH: number;
  spanY: number;
  spanH: number;
  scaleY: number;
  scaleH: number;
  axisY: number;
}

export class ScalingTimeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private hoverX: number | null = null;
  private hoverY = 0;
  private onMove: (e: PointerEvent) => void;
  private onLeave: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.onMove = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      this.hoverY = e.clientY - rect.top;
    };
    this.onLeave = () => {
      this.hoverX = null;
    };
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
    this.resize();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(sim: ScalingSimulation): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    if (w < 200 || h < 90) return;

    const view = sim.timelineView();
    const axisMax = axisMaxMs(view);
    const l = layout(w, h);
    const xFor = (t: number) => l.plotX + (t / axisMax) * l.plotW;

    this.drawFrame(w, h, view);
    this.drawBreaches(view, l, xFor);
    this.drawDemand(sim, l, xFor);
    this.drawSpans(view, l, xFor);
    this.drawScaleMarkers(view, l, xFor);
    this.drawAxis(l, axisMax, xFor);
    this.drawNowEdge(view, l, xFor);
    this.drawHover(sim, view, l, axisMax);
  }

  // -- Chrome ----------------------------------------------------------------

  private drawFrame(w: number, h: number, view: ScalingTimelineView): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.panel;
    ctx.strokeStyle = SURFACE.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 7);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('TIMELINE', 10, 14);

    // The run in one line, so the shape of it is readable without hovering.
    const scaleOuts = view.events.filter((e) => e.kind === 'scale').length;
    const breachMs = view.breaches.reduce((a, b) => a + (b.endMs - b.startMs), 0);
    ctx.textAlign = 'right';
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    let x = w - 10;
    if (breachMs > 0) {
      const label = `below SLO ${fmtDur(breachMs)}`;
      ctx.fillStyle = SEMANTIC.timeout;
      ctx.fillText(label, x, 14);
      x -= ctx.measureText(label).width + 10;
    }
    const outs = `${scaleOuts} scale-out${scaleOuts === 1 ? '' : 's'}`;
    ctx.fillStyle = SEMANTIC.inFlight;
    ctx.fillText(outs, x, 14);
    x -= ctx.measureText(outs).width + 10;
    ctx.fillStyle = SURFACE.textFaint;
    ctx.fillText(`hover for detail · ${fmtClock(view.nowMs)} elapsed`, x, 14);
    ctx.textAlign = 'left';
  }

  /** Below-SLO stretches, shaded behind everything else in the demand band. */
  private drawBreaches(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    for (const b of view.breaches) {
      const x0 = xFor(b.startMs);
      const x1 = Math.max(x0 + 1, xFor(b.endMs));
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.16);
      ctx.fillRect(x0, l.demandY, x1 - x0, l.demandH + l.spanH + l.scaleH + 8);
    }
  }

  /** Offered demand as a filled curve, usable capacity as a line over it. */
  private drawDemand(sim: ScalingSimulation, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const buckets = sim.metrics.buckets;
    let peak = 1;
    for (const b of buckets) peak = Math.max(peak, b.offeredRate, b.usableCapacityTps);
    // Include the demand the run is heading for, so a pre-start axis is to scale.
    const t = sim.cfg.traffic;
    peak = Math.max(peak, t.baseRateTps + (t.shape === 'steady' ? 0 : t.rampAmountTps));
    const yFor = (v: number) => l.demandY + l.demandH - (Math.min(v, peak) / peak) * l.demandH;

    // Downsample to roughly one point per pixel — a 2h run is 3600 buckets.
    const stride = Math.max(1, Math.floor(buckets.length / Math.max(1, l.plotW)));
    const series = (value: (b: (typeof buckets)[number]) => number, color: string, fill: boolean) => {
      if (buckets.length === 0) return;
      ctx.beginPath();
      let started = false;
      let lastX = l.plotX;
      for (let i = 0; i < buckets.length; i += stride) {
        const b = buckets[i];
        const x = xFor(b.time);
        const y = yFor(value(b));
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
        lastX = x;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(lastX, l.demandY + l.demandH);
        ctx.lineTo(l.plotX, l.demandY + l.demandH);
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.14);
        ctx.fill();
      }
    };
    series((b) => b.usableCapacityTps, SEMANTIC.success, true);
    series((b) => b.offeredRate, SEMANTIC.timeout, false);

    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText(fmtTps(peak), l.plotX + 2, l.demandY + 8);
    ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.9);
    ctx.fillText('offered', l.plotX + 34, l.demandY + 8);
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.9);
    ctx.fillText('usable capacity', l.plotX + 76, l.demandY + 8);
  }

  /** Demand brackets: when throughput was offered, and over how long. */
  private drawSpans(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const rowH = l.spanH / MAX_SPAN_ROWS;
    // Greedy row packing so stacked ramps don't draw on top of each other.
    const rowEnds: number[] = [];
    for (const span of view.spans) {
      const x0 = xFor(span.startMs);
      const x1 = Math.max(x0 + 3, xFor(span.endMs));
      let row = rowEnds.findIndex((end) => x0 > end + 4);
      if (row === -1) {
        if (rowEnds.length >= MAX_SPAN_ROWS) continue;
        row = rowEnds.length;
        rowEnds.push(0);
      }
      const y = l.spanY + row * rowH + rowH / 2;
      const color = LANE_COLOR[span.kind];
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.fillStyle = withAlpha(color, 0.9);
      ctx.lineWidth = 2;
      if (span.endMs > span.startMs) {
        // A bracket: the stretch over which the demand arrived.
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        for (const cap of [x0, x1]) {
          ctx.beginPath();
          ctx.moveTo(cap, y - 3.5);
          ctx.lineTo(cap, y + 3.5);
          ctx.stroke();
        }
      } else {
        // A step: an instant, drawn as a caret.
        ctx.beginPath();
        ctx.moveTo(x0, y - 4);
        ctx.lineTo(x0 + 3.5, y + 3);
        ctx.lineTo(x0 - 3.5, y + 3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.font = '600 8.5px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      const label = span.label;
      const labelX = x1 + 5;
      // Flip the label inside the plot when the bracket ends near the edge.
      if (labelX + ctx.measureText(label).width < l.plotX + l.plotW) {
        ctx.fillText(label, labelX, y + 3);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(label, x0 - 5, y + 3);
        ctx.textAlign = 'left';
      }
      rowEnds[row] = x1 + ctx.measureText(label).width + 6;
    }
  }

  /** One marker per scale-out, its height set by the instances that step launched. */
  private drawScaleMarkers(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const scaled = view.events.filter((e) => e.kind === 'scale');
    let maxAdd = 1;
    for (const e of scaled) maxAdd = Math.max(maxAdd, e.value ?? 1);
    const base = l.scaleY + l.scaleH;
    for (const e of scaled) {
      const x = xFor(e.time);
      const hgt = 3 + ((e.value ?? 1) / maxAdd) * (l.scaleH - 4);
      ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.85);
      ctx.fillRect(x - 1, base - hgt, 2.5, hgt);
    }
    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textFaint;
    // Right-aligned: the markers themselves cluster at the left of a run.
    ctx.textAlign = 'right';
    ctx.fillText('scale-outs, by instances added', l.plotX + l.plotW - 2, base - 1);
    ctx.textAlign = 'left';
  }

  private drawAxis(l: Layout, axisMax: number, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = SURFACE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.plotX, l.axisY);
    ctx.lineTo(l.plotX + l.plotW, l.axisY);
    ctx.stroke();
    const step = TICK_STEPS.find((s) => axisMax / s <= 10) ?? TICK_STEPS[TICK_STEPS.length - 1];
    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'center';
    for (let t = 0; t <= axisMax + 1; t += step) {
      const x = xFor(t);
      ctx.strokeStyle = SURFACE.grid;
      ctx.beginPath();
      ctx.moveTo(x, l.axisY);
      ctx.lineTo(x, l.axisY + 3);
      ctx.stroke();
      ctx.fillText(fmtClock(t), x, l.axisY + 12);
    }
    ctx.textAlign = 'left';
  }

  /** The live edge: everything right of it hasn't happened yet. */
  private drawNowEdge(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const x = xFor(view.nowMs);
    if (x >= l.plotX + l.plotW - 1) return;
    ctx.fillStyle = withAlpha(SURFACE.canvas, 0.45);
    ctx.fillRect(x, l.demandY, l.plotX + l.plotW - x, l.axisY - l.demandY);
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.35);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, l.demandY);
    ctx.lineTo(x, l.axisY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Hover -----------------------------------------------------------------

  private drawHover(sim: ScalingSimulation, view: ScalingTimelineView, l: Layout, axisMax: number): void {
    const hx = this.hoverX;
    if (hx === null || hx < l.plotX || hx > l.plotX + l.plotW) return;
    const ctx = this.ctx;
    const t = ((hx - l.plotX) / l.plotW) * axisMax;
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, l.demandY);
    ctx.lineTo(hx, l.axisY);
    ctx.stroke();

    // Nearest closed bucket for the demand/capacity readout at that moment.
    const buckets = sim.metrics.buckets;
    let bucket = null as (typeof buckets)[number] | null;
    for (const b of buckets) {
      if (b.time > t) break;
      bucket = b;
    }
    const lines: string[] = [fmtClock(t)];
    if (bucket) {
      const avail = bucket.offered > 1e-9 ? Math.min(1, bucket.served / bucket.offered) : 1;
      lines.push(`offered ${fmtTps(bucket.offeredRate)}`);
      lines.push(`usable  ${fmtTps(bucket.usableCapacityTps)}`);
      lines.push(`avail   ${(avail * 100).toFixed(1)}%`);
    }
    // Events within half a tick of the cursor, most recent first.
    const windowMs = (axisMax / l.plotW) * 6;
    const near = view.events.filter((e) => Math.abs(e.time - t) <= windowMs).slice(-3);
    for (const e of near) lines.push(`• ${e.message}`);
    this.tooltip(lines, hx, l, near);
  }

  private tooltip(lines: string[], hx: number, l: Layout, near: ScalingSimEventLog[]): void {
    const ctx = this.ctx;
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    let boxW = 0;
    for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
    boxW = Math.min(boxW + 14, l.plotW - 8);
    const boxH = lines.length * 11 + 8;
    const bx = Math.min(Math.max(l.plotX, hx + 10), l.plotX + l.plotW - boxW);
    const by = Math.min(Math.max(l.demandY, this.hoverY - boxH - 6), l.axisY - boxH);
    ctx.fillStyle = withAlpha(SURFACE.canvas, 0.95);
    ctx.strokeStyle = SURFACE.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      const isEvent = line.startsWith('•');
      const ev = isEvent ? near[i - (lines.length - near.length)] : null;
      ctx.fillStyle = i === 0 ? SURFACE.text : ev ? severityColor(ev) : SURFACE.textDim;
      ctx.fillText(clip(ctx, line, boxW - 12), bx + 7, by + 13 + i * 11);
    });
  }
}

// ---------------------------------------------------------------------------

function layout(w: number, h: number): Layout {
  const plotX = 10;
  const plotW = w - 20;
  const top = 20;
  const axisY = h - 16;
  const spanH = 30;
  const scaleH = 20;
  const demandH = Math.max(24, axisY - top - spanH - scaleH - 10);
  return {
    plotX,
    plotW,
    demandY: top,
    demandH,
    spanY: top + demandH + 4,
    spanH,
    scaleY: top + demandH + 4 + spanH,
    scaleH,
    axisY,
  };
}

/** Span the whole run — and any scheduled demand still ahead of it. */
function axisMaxMs(view: ScalingTimelineView): number {
  let max = Math.max(view.nowMs, MIN_AXIS_MS);
  for (const s of view.spans) max = Math.max(max, s.endMs);
  return max;
}

function severityColor(e: ScalingSimEventLog): string {
  if (e.severity === 'critical') return SEMANTIC.timeout;
  if (e.severity === 'warn') return SEMANTIC.shed;
  return SURFACE.textDim;
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 4 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
  return `${out}…`;
}

function fmtTps(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

/** A span length, for the summary line. */
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m${rem}s` : `${m}m`;
  }
  return `${s}s`;
}

/** Axis/cursor time as m:ss, or h:mm:ss once the run passes an hour. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600);
  const mm = String(m).padStart(hrs > 0 ? 2 : 1, '0');
  return hrs > 0 ? `${hrs}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}
