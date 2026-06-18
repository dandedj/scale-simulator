/**
 * The chart rail: synchronized strip charts over the same rolling 60-second
 * window of sim time. Together they tell the storm story: latency crosses the
 * timeout line → goodput gap opens → failures spike → handshakes flood →
 * fabric CPU demand crosses capacity → lock contention saturates →
 * connections churn → amplification goes super-unity.
 */

import { BUCKET_MS, HISTORY_MS, percentile } from '../engine/metrics';
import type { Simulation } from '../engine/simulation';
import type { MetricsBucket } from '../engine/types';
import { SEMANTIC, SURFACE, withAlpha } from './colors';

const PER_SEC = 1000 / BUCKET_MS;

interface Series {
  label: string;
  color: string;
  fill?: boolean;
  value(b: MetricsBucket, sim: Simulation): number;
}

interface ChartDef {
  title: string;
  series: Series[];
  /** Dashed reference line (e.g., a limit or timeout). */
  threshold?(sim: Simulation): { value: number; label: string } | null;
  yMax?(sim: Simulation, dataMax: number): number;
}

const CHARTS: ChartDef[] = [
  {
    title: 'LATENCY ms',
    series: [
      { label: 'p99', color: SEMANTIC.shed, value: (b) => percentile(b.latencies, 0.99) },
      { label: 'p50', color: SEMANTIC.inFlight, value: (b) => percentile(b.latencies, 0.5) },
    ],
    threshold: (sim) => ({ value: sim.cfg.clients.clientTimeoutMs, label: 'client timeout' }),
    yMax: (sim, dataMax) => Math.max(dataMax, sim.cfg.clients.clientTimeoutMs * 1.25),
  },
  {
    title: 'THROUGHPUT req/s',
    series: [
      { label: 'offered', color: SEMANTIC.inFlight, fill: true, value: (b) => b.arrivals * PER_SEC },
      { label: 'goodput', color: SEMANTIC.success, value: (b) => b.successes * PER_SEC },
    ],
  },
  {
    title: 'FAILURES /s',
    series: [
      { label: 'timeout', color: SEMANTIC.timeout, value: (b) => b.timeouts * PER_SEC },
      { label: 'error', color: SEMANTIC.error, value: (b) => b.errors * PER_SEC },
      { label: 'rejected', color: SEMANTIC.shed, value: (b) => b.rejected * PER_SEC },
    ],
  },
  {
    title: 'TLS PERMITS',
    series: [
      { label: 'started/s', color: SEMANTIC.tlsPulse, value: (b) => b.tlsHandshakesStarted * PER_SEC },
      { label: 'active', color: SEMANTIC.retry, value: (b) => b.handshakesActive },
      { label: 'shed/s', color: SEMANTIC.shed, value: (b) => b.shedTls * PER_SEC },
    ],
    threshold: (sim) => ({ value: sim.cfg.fabric.tlsHandshakeConcurrency, label: 'permits' }),
  },
  {
    title: 'FABRIC CPU %',
    series: [
      // Demanded work vs capacity; >100% means every in-flight operation is
      // stretching. The sampled gauge can far exceed 100% in a storm — the
      // y-axis follows it so the depth of the hole stays readable.
      { label: 'demand', color: SEMANTIC.cpuBad, fill: true, value: (b) => b.cpuUtilization * 100 },
    ],
    threshold: () => ({ value: 100, label: 'capacity' }),
    yMax: (_sim, dataMax) => Math.max(dataMax * 1.1, 130),
  },
  {
    // The busiest enabled lock's utilization. Pegged at 100% while FABRIC CPU
    // sits low is the lock-contention lesson: the wall is serialization, not
    // compute. Flat at 0 when no lock is enabled.
    title: 'LOCK CONTENTION %',
    series: [
      { label: 'busiest lock', color: SEMANTIC.retry, fill: true, value: (b) => b.lockUtilization * 100 },
    ],
    threshold: () => ({ value: 100, label: 'saturated' }),
    yMax: (_sim, dataMax) => Math.max(dataMax * 1.1, 130),
  },
  {
    title: 'CONNECTIONS',
    series: [
      { label: 'fabric conns', color: SEMANTIC.connEstablished, value: (b) => b.fabricConnections },
      // Connection-level door sheds: the static-limit RST and the accept-rate RST.
      { label: 'shed/s', color: SEMANTIC.shed, value: (b) => (b.shedConnLimit + b.shedConnRate) * PER_SEC },
      { label: 'ds queue', color: SEMANTIC.error, fill: true, value: (b) => b.fabricQueueDepth },
    ],
    threshold: (sim) => ({ value: sim.cfg.fabric.maxConnections, label: 'conn limit' }),
    yMax: (sim, dataMax) => Math.max(dataMax, sim.cfg.fabric.maxConnections * 1.15),
  },
  {
    title: 'AMPLIFICATION R',
    series: [
      {
        label: 'sent ÷ ok',
        color: SEMANTIC.retry,
        value: (b) => {
          const sent = b.arrivals + b.retries;
          return Math.min(8, sent / Math.max(1, b.successes));
        },
      },
    ],
    threshold: () => ({ value: 1.5, label: 'storm line' }),
    yMax: () => 8,
  },
];

export class ChartRail {
  private charts: Array<{
    def: ChartDef;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
  }> = [];

  constructor(container: HTMLElement) {
    for (const def of CHARTS) {
      const cell = document.createElement('div');
      cell.className = 'chart-cell';
      const canvas = document.createElement('canvas');
      cell.appendChild(canvas);
      container.appendChild(cell);
      this.charts.push({ def, canvas, ctx: canvas.getContext('2d')!, w: 0, h: 0 });
    }
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    for (const c of this.charts) {
      const rect = c.canvas.getBoundingClientRect();
      c.w = rect.width;
      c.h = rect.height;
      c.canvas.width = Math.round(rect.width * dpr);
      c.canvas.height = Math.round(rect.height * dpr);
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  draw(sim: Simulation): void {
    const buckets = sim.metrics.buckets;
    const windowStart = Math.max(0, sim.now - HISTORY_MS);
    for (const { def, ctx, w, h } of this.charts) {
      if (w === 0) continue;
      ctx.clearRect(0, 0, w, h);

      const plotX = 6;
      const plotY = 16;
      const plotW = w - 12;
      const plotH = h - 24;

      // Title + legend
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(def.title, plotX, 10);
      let lx = plotX + ctx.measureText(def.title).width + 10;
      for (const s of def.series) {
        ctx.fillStyle = s.color;
        ctx.fillText(s.label, lx, 10);
        lx += ctx.measureText(s.label).width + 8;
      }

      // Determine y scale
      let dataMax = 1e-6;
      for (const b of buckets) {
        if (b.time < windowStart) continue;
        for (const s of def.series) dataMax = Math.max(dataMax, s.value(b, sim));
      }
      const yMax = def.yMax ? def.yMax(sim, dataMax) : dataMax * 1.15;

      // Gridlines (baseline + midpoint) + threshold
      ctx.strokeStyle = SURFACE.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, plotY + plotH);
      ctx.lineTo(plotX + plotW, plotY + plotH);
      ctx.moveTo(plotX, plotY + plotH / 2);
      ctx.lineTo(plotX + plotW, plotY + plotH / 2);
      ctx.stroke();
      const thr = def.threshold?.(sim);
      if (thr && thr.value <= yMax) {
        const ty = plotY + plotH - (thr.value / yMax) * plotH;
        ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.55);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(plotX, ty);
        ctx.lineTo(plotX + plotW, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        // Name the reference line; flip below it when it hugs the top edge.
        ctx.font = '600 8px "IBM Plex Mono", monospace';
        ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.85);
        ctx.textAlign = 'right';
        ctx.fillText(thr.label, plotX + plotW - 2, ty < plotY + 12 ? ty + 9 : ty - 3);
        ctx.textAlign = 'left';
      }

      // Series
      const xFor = (time: number) => plotX + ((time - windowStart) / HISTORY_MS) * plotW;
      const yFor = (v: number) => plotY + plotH - (Math.min(v, yMax) / yMax) * plotH;
      for (const s of def.series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let started = false;
        let lastX = plotX;
        for (const b of buckets) {
          if (b.time < windowStart) continue;
          const x = xFor(b.time);
          const y = yFor(s.value(b, sim));
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
          lastX = x;
        }
        ctx.stroke();
        if (s.fill && started) {
          ctx.lineTo(lastX, plotY + plotH);
          ctx.lineTo(plotX, plotY + plotH);
          ctx.closePath();
          ctx.fillStyle = withAlpha(s.color, 0.13);
          ctx.fill();
        }
      }

      // Y-axis values (drawn last so they stay legible over the series);
      // the bottom gridline is 0.
      ctx.font = '500 8px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText(fmtAxis(yMax), plotX + 2, plotY + 8);
      ctx.fillText(fmtAxis(yMax / 2), plotX + 2, plotY + plotH / 2 - 3);
    }
  }
}

/** Compact axis value: units live in the chart title. */
function fmtAxis(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return String(Math.round(v));
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}
