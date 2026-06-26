/**
 * The DNS chart rail. Same strip-chart machinery as the storm rail
 * (render/stripChart.ts), with chart definitions over the DNS metrics buckets.
 * Together they tell the distribution story: availability dips → offered passes
 * advertised capacity → servers boot in → the advertised set grows → caches
 * re-resolve → availability recovers (lagged by boot + DNS + TTL).
 */

import { drawChart, type StripChartDef } from '../../render/stripChart';
import { SEMANTIC } from '../../render/colors';
import { HISTORY_MS } from '../engine/metrics';
import type { DnsSimulation } from '../engine/dnsSimulation';
import type { DnsMetricsBucket } from '../engine/types';

type ChartDef = StripChartDef<DnsMetricsBucket, DnsSimulation>;

const avail = (b: DnsMetricsBucket) => (b.offered > 1e-9 ? Math.min(1, b.served / b.offered) * 100 : 100);

const CHARTS: ChartDef[] = [
  {
    title: 'AVAILABILITY %',
    series: [{ label: 'served ÷ offered', color: SEMANTIC.success, fill: true, value: avail }],
    threshold: (sim) => ({ value: sim.cfg.slaTarget * 100, label: 'SLO' }),
    yMax: () => 105,
  },
  {
    title: 'THROUGHPUT req/s',
    series: [
      { label: 'offered', color: SEMANTIC.inFlight, fill: true, value: (b) => b.offeredRate },
      { label: 'served', color: SEMANTIC.success, value: (b) => b.servedRate },
    ],
  },
  {
    title: 'CAPACITY vs DEMAND req/s',
    series: [
      { label: 'offered', color: SEMANTIC.timeout, value: (b) => b.offeredRate },
      { label: 'advertised cap', color: SEMANTIC.success, fill: true, value: (b) => b.advertisedCapacity },
    ],
  },
  {
    title: 'SERVERS',
    series: [
      { label: 'healthy', color: SEMANTIC.success, value: (b) => b.healthyCount },
      { label: 'booting', color: SEMANTIC.tlsPulse, value: (b) => b.bootingCount },
      { label: 'overloaded', color: SEMANTIC.timeout, value: (b) => b.overloadedCount },
      { label: 'down', color: SEMANTIC.shed, value: (b) => b.downCount },
    ],
  },
  {
    title: 'SHED & STALE /s',
    series: [
      { label: 'shed (RST)', color: SEMANTIC.shed, value: (b) => b.shed },
      { label: 'stale→dead IP', color: SEMANTIC.error, value: (b) => b.staleHit },
    ],
  },
  {
    title: 'SERVER LOAD %',
    series: [
      { label: 'max', color: SEMANTIC.timeout, value: (b) => b.maxServerLoad * 100 },
      { label: 'mean', color: SEMANTIC.inFlight, fill: true, value: (b) => b.meanServerLoad * 100 },
    ],
    threshold: () => ({ value: 100, label: 'capacity' }),
    yMax: (_sim, dataMax) => Math.max(dataMax * 1.1, 130),
  },
  {
    title: 'ADVERTISED vs HEALTHY IPs',
    series: [
      { label: 'advertised', color: SEMANTIC.success, value: (b) => b.advertisedHealthyCount },
      { label: 'healthy', color: SEMANTIC.inFlight, value: (b) => b.healthyCount },
    ],
  },
  {
    title: 'RE-RESOLUTIONS /s',
    series: [{ label: 'DNS lookups', color: SEMANTIC.retry, fill: true, value: (b) => b.reResolves }],
  },
];

export class DnsChartRail {
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

  draw(sim: DnsSimulation): void {
    const buckets = sim.metrics.buckets;
    const windowStart = Math.max(0, sim.now - HISTORY_MS);
    for (const { def, ctx, w, h } of this.charts) {
      if (w === 0) continue;
      drawChart(ctx, w, h, def, buckets, windowStart, HISTORY_MS, sim);
    }
  }
}
