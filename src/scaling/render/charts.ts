/**
 * The Scaling chart rail (shared strip-chart machinery). Together the charts
 * tell the ramp story: demand climbs past capacity → availability dips → the
 * fleet launches instances → capacity (ready, then usable) catches up → the dip
 * closes, lagged by the pipeline.
 */

import { drawChart, type StripChartDef } from '../../render/stripChart';
import { SEMANTIC } from '../../render/colors';
import { HISTORY_MS } from '../engine/metrics';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import type { ScalingMetricsBucket } from '../engine/types';

type ChartDef = StripChartDef<ScalingMetricsBucket, ScalingSimulation>;

const avail = (b: ScalingMetricsBucket) => (b.offered > 1e-9 ? Math.min(1, b.served / b.offered) * 100 : 100);

const CHARTS: ChartDef[] = [
  {
    title: 'AVAILABILITY %',
    series: [{ label: 'served ÷ offered', color: SEMANTIC.success, fill: true, value: avail }],
    threshold: (sim) => ({ value: sim.cfg.slaTarget * 100, label: 'SLO' }),
    yMax: () => 105,
  },
  {
    title: 'DEMAND vs CAPACITY TPS',
    series: [
      { label: 'offered', color: SEMANTIC.timeout, value: (b) => b.offeredRate },
      { label: 'ready cap', color: SEMANTIC.inFlight, value: (b) => b.readyCapacityTps },
      { label: 'usable cap', color: SEMANTIC.success, fill: true, value: (b) => b.usableCapacityTps },
    ],
  },
  {
    title: 'UTILIZATION %',
    series: [{ label: 'offered ÷ usable', color: SEMANTIC.retry, fill: true, value: (b) => b.utilization * 100 }],
    threshold: (sim) => ({ value: sim.cfg.capacity.targetUtilization * 100, label: 'target' }),
    yMax: (_sim, dataMax) => Math.max(dataMax * 1.1, 130),
  },
  {
    title: 'INSTANCES',
    series: [
      { label: 'in use', color: SEMANTIC.success, value: (b) => b.inUse },
      { label: 'ready', color: SEMANTIC.inFlight, value: (b) => b.ready },
      { label: 'provisioning', color: SEMANTIC.tlsPulse, value: (b) => b.provisioning },
    ],
  },
  {
    title: 'LOST TPS /s',
    series: [{ label: 'offered − served', color: SEMANTIC.timeout, fill: true, value: (b) => b.lost }],
  },
  {
    title: 'IN-FLIGHT INSTANCES',
    series: [{ label: 'launching', color: SEMANTIC.tlsPulse, fill: true, value: (b) => b.inFlight }],
  },
];

export class ScalingChartRail {
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

  draw(sim: ScalingSimulation): void {
    const buckets = sim.metrics.buckets;
    const windowStart = Math.max(0, sim.now - HISTORY_MS);
    for (const { def, ctx, w, h } of this.charts) {
      if (w === 0) continue;
      drawChart(ctx, w, h, def, buckets, windowStart, HISTORY_MS, sim);
    }
  }
}
