import { SEMANTIC } from '../../render/colors';
import { drawChart, type StripChartDef } from '../../render/stripChart';
import { POOL_HISTORY_MS } from '../engine/metrics';
import type { PoolSimulation } from '../engine/poolSimulation';
import type { PoolMetricsBucket } from '../engine/types';

type ChartDef = StripChartDef<PoolMetricsBucket, PoolSimulation>;

const CHARTS: ChartDef[] = [
  {
    title: 'CONNECTIONS',
    series: [
      { label: 'desired', color: SEMANTIC.timeout, value: (b) => b.desired },
      { label: 'established', color: SEMANTIC.connEstablished, fill: true, value: (b) => b.established },
    ],
    threshold: (sim) => ({ value: sim.snapshot().responderCapacity, label: 'responder budget' }),
  },
  {
    title: 'POOL STATE',
    series: [
      { label: 'busy', color: SEMANTIC.success, value: (b) => b.busy },
      { label: 'idle', color: SEMANTIC.inFlight, fill: true, value: (b) => b.idle },
      { label: 'connecting', color: SEMANTIC.tlsPulse, value: (b) => b.pending },
    ],
  },
  {
    title: 'HOTTEST RESPONDER',
    series: [{ label: 'connections', color: SEMANTIC.timeout, fill: true, value: (b) => b.hottestResponder }],
    threshold: (sim) => ({ value: sim.cfg.responder.connectionLimit, label: 'limit' }),
  },
  {
    title: 'CONNECTION EVENTS /s',
    series: [
      { label: 'open', color: SEMANTIC.success, value: (b) => b.connectionsOpened },
      { label: 'reset', color: SEMANTIC.timeout, value: (b) => b.connectionResets },
      { label: 'close', color: SEMANTIC.shed, value: (b) => b.connectionsClosed },
    ],
  },
  {
    title: 'REQUESTS /s',
    series: [
      { label: 'base', color: SEMANTIC.inFlight, fill: true, value: (b) => b.baseRate },
      { label: 'with retries', color: SEMANTIC.retry, value: (b) => b.effectiveRate },
      { label: 'served', color: SEMANTIC.success, value: (b) => b.servedRate },
    ],
  },
  {
    title: 'RESPONDER PRESSURE %',
    series: [{ label: 'hottest / limit', color: SEMANTIC.timeout, fill: true, value: (b) => b.responderPressure * 100 }],
    threshold: () => ({ value: 100, label: 'limit' }),
    yMax: (_sim, max) => Math.max(120, max * 1.1),
  },
  {
    title: 'POOL KEY COPIES',
    series: [{ label: 'owned keys', color: SEMANTIC.tlsPulse, fill: true, value: (b) => b.poolKeys }],
  },
  {
    title: 'CONNECTION REUSE %',
    series: [{ label: 'requests not opening', color: SEMANTIC.success, fill: true, value: (b) => b.reuseRatio * 100 }],
    yMax: () => 105,
  },
];

export class PoolChartRail {
  private charts: Array<{ def: ChartDef; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number }> = [];

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

  draw(sim: PoolSimulation): void {
    const windowStart = Math.max(0, sim.now - POOL_HISTORY_MS);
    for (const { def, ctx, w, h } of this.charts) {
      if (w > 0) drawChart(ctx, w, h, def, sim.metrics.buckets, windowStart, POOL_HISTORY_MS, sim);
    }
  }
}
