/**
 * The generic strip-chart renderer, shared by both simulators' chart rails.
 *
 * A chart is a set of series plotted over a rolling window of bucketed metrics,
 * with an optional dashed threshold line (a limit, a timeout, an SLO). The
 * storm and DNS rails each supply their own bucket type, context object, and
 * chart definitions; this module owns the drawing so there is one copy of it.
 */

import { SEMANTIC, SURFACE, withAlpha } from './colors';

export interface StripSeries<B, C> {
  label: string;
  color: string;
  fill?: boolean;
  value(bucket: B, ctx: C): number;
}

export interface StripChartDef<B, C> {
  title: string;
  series: StripSeries<B, C>[];
  /** Dashed reference line (e.g. a limit, timeout, or SLO). */
  threshold?(ctx: C): { value: number; label: string } | null;
  yMax?(ctx: C, dataMax: number): number;
}

/**
 * Draw one chart into a 2D context sized w×h. `buckets` are time-ordered;
 * `windowStart` is the left edge in the same time units, `historyMs` the span.
 * `ctx` is the caller's context object (the simulation), passed to series/
 * threshold/yMax callbacks.
 */
export function drawChart<B extends { time: number }, C>(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  def: StripChartDef<B, C>,
  buckets: B[],
  windowStart: number,
  historyMs: number,
  ctx: C,
): void {
  g.clearRect(0, 0, w, h);

  const plotX = 6;
  const plotY = 16;
  const plotW = w - 12;
  const plotH = h - 24;

  // Title + legend
  g.font = '600 9px "IBM Plex Mono", monospace';
  g.fillStyle = SURFACE.textDim;
  g.fillText(def.title, plotX, 10);
  let lx = plotX + g.measureText(def.title).width + 10;
  for (const s of def.series) {
    g.fillStyle = s.color;
    g.fillText(s.label, lx, 10);
    lx += g.measureText(s.label).width + 8;
  }

  // Determine y scale
  let dataMax = 1e-6;
  for (const b of buckets) {
    if (b.time < windowStart) continue;
    for (const s of def.series) dataMax = Math.max(dataMax, s.value(b, ctx));
  }
  const yMax = def.yMax ? def.yMax(ctx, dataMax) : dataMax * 1.15;

  // Gridlines (baseline + midpoint) + threshold
  g.strokeStyle = SURFACE.grid;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(plotX, plotY + plotH);
  g.lineTo(plotX + plotW, plotY + plotH);
  g.moveTo(plotX, plotY + plotH / 2);
  g.lineTo(plotX + plotW, plotY + plotH / 2);
  g.stroke();
  const thr = def.threshold?.(ctx);
  if (thr && thr.value <= yMax) {
    const ty = plotY + plotH - (thr.value / yMax) * plotH;
    g.strokeStyle = withAlpha(SEMANTIC.timeout, 0.55);
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(plotX, ty);
    g.lineTo(plotX + plotW, ty);
    g.stroke();
    g.setLineDash([]);
    // Name the reference line; flip below it when it hugs the top edge.
    g.font = '600 8px "IBM Plex Mono", monospace';
    g.fillStyle = withAlpha(SEMANTIC.timeout, 0.85);
    g.textAlign = 'right';
    g.fillText(thr.label, plotX + plotW - 2, ty < plotY + 12 ? ty + 9 : ty - 3);
    g.textAlign = 'left';
  }

  // Series
  const xFor = (time: number) => plotX + ((time - windowStart) / historyMs) * plotW;
  const yFor = (v: number) => plotY + plotH - (Math.min(v, yMax) / yMax) * plotH;
  for (const s of def.series) {
    g.strokeStyle = s.color;
    g.lineWidth = 1.4;
    g.beginPath();
    let started = false;
    let lastX = plotX;
    for (const b of buckets) {
      if (b.time < windowStart) continue;
      const x = xFor(b.time);
      const y = yFor(s.value(b, ctx));
      if (!started) {
        g.moveTo(x, y);
        started = true;
      } else {
        g.lineTo(x, y);
      }
      lastX = x;
    }
    g.stroke();
    if (s.fill && started) {
      g.lineTo(lastX, plotY + plotH);
      g.lineTo(plotX, plotY + plotH);
      g.closePath();
      g.fillStyle = withAlpha(s.color, 0.13);
      g.fill();
    }
  }

  // Y-axis values (drawn last so they stay legible over the series);
  // the bottom gridline is 0.
  g.font = '500 8px "IBM Plex Mono", monospace';
  g.fillStyle = SURFACE.textFaint;
  g.fillText(fmtAxis(yMax), plotX + 2, plotY + 8);
  g.fillText(fmtAxis(yMax / 2), plotX + 2, plotY + plotH / 2 - 3);
}

/** Compact axis value: units live in the chart title. */
export function fmtAxis(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return String(Math.round(v));
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}
