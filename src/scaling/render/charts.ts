/**
 * The Scaling chart rail (shared strip-chart machinery). Together the charts
 * tell the ramp story: demand climbs past capacity → availability dips → the
 * fleet launches instances → capacity (ready, then usable, then counted by the
 * autoscaler once its bake expires) catches up → the dip closes, lagged by the
 * pipeline and paced by the bake.
 *
 * The view window grows with the run — a 1-minute ramp and a 1-hour one are both
 * fully on screen — up to the collector's retention, after which it scrolls.
 */

import { computeYMax, drawChart, type StripChartDef } from '../../render/stripChart';
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
      // What the autoscaler counts: usable capacity minus whatever is still
      // baking. The gap between this and 'usable cap' is what the bake hides.
      { label: 'counted cap', color: SEMANTIC.retry, value: (b) => b.meteredCapacityTps },
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
      { label: 'baking', color: SEMANTIC.retry, value: (b) => b.baking },
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

/**
 * View spans the rail snaps to as the run gets longer, so a short ramp fills the
 * width and an hour-long one still fits. Capped by the collector's retention.
 */
const VIEW_SPANS = [600_000, 1_200_000, 1_800_000, 3_600_000, 5_400_000, HISTORY_MS];

function viewWindowMs(sim: ScalingSimulation): number {
  for (const span of VIEW_SPANS) if (sim.now <= span) return span;
  return HISTORY_MS;
}

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

  /** Each chart's auto-scaled y-max for this sim (for a shared compare scale). */
  yMaxes(sim: ScalingSimulation): number[] {
    const windowStart = Math.max(0, sim.now - viewWindowMs(sim));
    return this.charts.map((c) => computeYMax(c.def, sim.metrics.buckets, windowStart, sim));
  }

  /** `sharedYMaxes` (compare mode) forces a common y-axis per chart across panes. */
  draw(sim: ScalingSimulation, sharedYMaxes?: number[]): void {
    const buckets = sim.metrics.buckets;
    const window = viewWindowMs(sim);
    const windowStart = Math.max(0, sim.now - window);
    this.charts.forEach(({ def, ctx, w, h }, i) => {
      if (w === 0) return;
      drawChart(ctx, w, h, def, buckets, windowStart, window, sim, sharedYMaxes?.[i]);
    });
  }
}
