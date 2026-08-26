/**
 * The Scaling timeline pane: the whole run on one annotated axis, so what
 * happened and why reads directly instead of being reconstructed from a
 * scrolling ticker. It is the view worth maximizing — ⤢ hands it the stage.
 *
 * Lanes, top to bottom:
 *   demand   offered vs usable capacity, below-SLO stretches shaded behind
 *   spans    when throughput was offered, and over how long
 *   alarm    utilization over target (amber) then the alarm firing (red)
 *   batches  one Gantt row per scale-out: every pipeline stage it ran, the bake
 *            beneath it, and the point it started counting as capacity
 *   metric   a tick per publish — nothing can be decided between two of them
 *
 * Hovering a batch row explains that scale-out's arithmetic; hovering anywhere
 * else reports the demand, capacity, availability and events at that moment.
 *
 * The axis is either a fixed window that follows the live edge — wide enough for
 * a couple of scale-outs, not the whole run — or the whole run at once, picked
 * with the span buttons. In windowed mode ◀ ▶ page through the history, drag and
 * wheel do the same by hand, HOLD freezes the window where it is while the run
 * carries on, and ● LIVE catches back up. Before the run starts the window sits
 * at the beginning, so a scheduled ramp is visible as a plan.
 */

import { SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import {
  PIPELINE_STAGES,
  type ScalingBatch,
  type ScalingDecision,
  type ScalingDemandSpan,
  type ScalingTimelineView,
} from '../engine/types';

/** Axis tick steps (ms), coarsest that still leaves ~10 ticks wins. */
const TICK_STEPS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000];
/**
 * Zoom stops for the visible window. The default is wide enough to hold a couple
 * of scale-outs with their pipelines and bakes, which is the unit of the story;
 * zooming out to the widest reaches the collector's whole retention.
 */
const WINDOW_STOPS = [300_000, 900_000, 1_800_000, 3_600_000];
const DEFAULT_WINDOW_MS = 900_000; // 15 minutes
/** Pointer slop before a press counts as a drag, so inspecting never scrolls. */
const DRAG_DEADZONE_PX = 4;
/** Floor for the whole-run axis, so an idle run still reads as a timeline. */
const MIN_SPAN_MS = 60_000;
/** Rows the demand-bracket lane will stack before it stops drawing more. */
const MAX_SPAN_ROWS = 3;
/** Tallest a single scale-out's Gantt row gets, however much room there is. */
const BATCH_ROW_MAX = 26;

const LANE_COLOR: Record<ScalingDemandSpan['kind'], string> = {
  ramp: SEMANTIC.timeout,
  step: SEMANTIC.shed,
  surge: SEMANTIC.retry,
};

interface Lane {
  y: number;
  h: number;
}
interface Layout {
  plotX: number;
  plotW: number;
  demand: Lane;
  spans: Lane;
  alarm: Lane;
  batches: Lane;
  metric: Lane;
  axisY: number;
  /** Roomy enough to label the lanes — true once maximized. */
  detailed: boolean;
}

/** A drawn batch row, kept so the pointer can be hit-tested against it. */
interface BatchRow {
  batch: ScalingBatch;
  y0: number;
  y1: number;
}

/**
 * The visible span and where it sits — pan, zoom, hold, fit-all. Held apart from
 * the renderer so comparison mode's two timelines can share one window and stay
 * on the same axis, and so the state machine is testable without a canvas.
 */
export class TimelineWindow {
  /** Visible span while windowed. */
  windowMs = DEFAULT_WINDOW_MS;
  /** Show the whole run on one axis instead of a fixed window. */
  private fitAll = false;
  /** Left edge of the window (sim ms); only meaningful when not following. */
  private windowStart = 0;
  /** Pinned to the live edge until the user scrolls back. */
  private following = true;
  /**
   * Frozen in place: the run advances but the window does not. Distinct from
   * merely having scrolled back, which the live edge would otherwise catch up
   * to and re-pin the moment it arrived.
   */
  private held = false;
  /** Rightmost time the window may reach; set from the view each frame. */
  private contentEnd = 0;

  isFollowing(): boolean {
    return this.fitAll || (this.following && !this.held);
  }

  goLive(): void {
    this.held = false;
    this.following = true;
  }

  isHeld(): boolean {
    return this.held;
  }

  setHeld(on: boolean): void {
    if (on === this.held) return;
    // Freeze from wherever the view is right now, live edge included.
    if (on) this.windowStart = this.resolve(this.contentEnd);
    this.held = on;
    if (!on) this.following = true;
  }

  isFitAll(): boolean {
    return this.fitAll;
  }

  setWindow(ms: number | 'all'): void {
    if (ms === 'all') {
      this.fitAll = true;
      return;
    }
    // Keep the middle of the view put when the span changes under it.
    const mid = this.windowStart + this.windowMs / 2;
    this.fitAll = false;
    this.windowMs = ms;
    if (!this.following) this.windowStart = mid - ms / 2;
  }

  pageBy(fraction: number): void {
    if (this.fitAll) return;
    this.panBy(fraction * this.windowMs);
  }

  canPageBack(): boolean {
    return !this.fitAll && this.windowStart > 0;
  }

  /** Zoom one stop, keeping whatever sits at `frac` across the plot put. */
  zoom(dir: -1 | 1, frac: number): void {
    if (this.fitAll) return;
    const anchor = this.windowStart + frac * this.windowMs;
    const i = WINDOW_STOPS.indexOf(this.windowMs);
    const next = WINDOW_STOPS[clampInt(i + dir, 0, WINDOW_STOPS.length - 1)];
    if (next === this.windowMs) return;
    this.windowMs = next;
    if (!this.following) this.windowStart = anchor - frac * next;
  }

  /** Scrolling away from the right edge drops the live pin. */
  panBy(dtMs: number): void {
    if (dtMs === 0 || this.fitAll) return;
    if (this.following) this.windowStart = Math.max(0, this.contentEnd - this.windowMs);
    this.following = false;
    this.windowStart += dtMs;
  }

  /** Where the window sits this frame, given how far the run has reached. */
  resolve(contentEnd: number): number {
    this.contentEnd = contentEnd;
    if (this.fitAll) {
      this.windowMs = contentEnd;
      this.windowStart = 0;
      return 0;
    }
    const max = Math.max(0, contentEnd - this.windowMs);
    if (this.held) {
      // Held: stay put, but never past the end of what exists.
      this.windowStart = Math.min(Math.max(0, this.windowStart), max);
      return this.windowStart;
    }
    if (this.following) this.windowStart = max;
    else this.windowStart = Math.min(Math.max(0, this.windowStart), max);
    // Dragging back to the right edge re-pins, so the button isn't the only way.
    if (!this.following && this.windowStart >= max - 1e-6) this.following = true;
    return this.windowStart;
  }
}

export class ScalingTimeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private hoverX: number | null = null;
  private hoverY = 0;
  private rows: BatchRow[] = [];
  /** Shared with the other pane in comparison mode, so both stay on one axis. */
  private win: TimelineWindow;
  /** Plot geometry from the last draw, so pointer deltas can be read as time. */
  private geom = { plotX: 10, plotW: 1 };
  /** Right-hand space the DOM control bar occupies, so the header clears it. */
  private headerInset = 0;
  private dragging: { pointerId: number; lastX: number; startX: number; live: boolean } | null = null;
  private onMove: (e: PointerEvent) => void;
  private onLeave: () => void;
  private onDown: (e: PointerEvent) => void;
  private onUp: (e: PointerEvent) => void;
  private onWheel: (e: WheelEvent) => void;

  constructor(canvas: HTMLCanvasElement, win: TimelineWindow) {
    this.canvas = canvas;
    this.win = win;
    this.ctx = canvas.getContext('2d')!;
    this.onMove = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      this.hoverY = e.clientY - rect.top;
      const d = this.dragging;
      if (d && e.pointerId === d.pointerId && !this.win.isFitAll()) {
        // Ignore pointer slop, so moving onto a row to read it never scrolls.
        if (!d.live && Math.abs(e.clientX - d.startX) < DRAG_DEADZONE_PX) return;
        d.live = true;
        const dx = e.clientX - d.lastX;
        d.lastX = e.clientX;
        // Content follows the finger: dragging right walks back in time.
        this.win.panBy(-(dx / this.geom.plotW) * this.win.windowMs);
      }
    };
    this.onLeave = () => {
      this.hoverX = null;
    };
    this.onDown = (e: PointerEvent) => {
      this.dragging = { pointerId: e.pointerId, lastX: e.clientX, startX: e.clientX, live: false };
      // Capture keeps a drag alive past the canvas edge; it throws for a pointer
      // the browser isn't tracking, which must not break the drag itself.
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable — the drag still works inside the canvas */
      }
      this.canvas.classList.add('dragging');
    };
    this.onUp = (e: PointerEvent) => {
      if (this.dragging?.pointerId !== e.pointerId) return;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* never captured */
      }
      this.dragging = null;
      this.canvas.classList.remove('dragging');
    };
    this.onWheel = (e: WheelEvent) => {
      if (this.win.isFitAll()) return;
      e.preventDefault();
      // Zoom about the cursor so whatever is under it stays put.
      const rect = this.canvas.getBoundingClientRect();
      const frac = clamp01((e.clientX - rect.left - this.geom.plotX) / this.geom.plotW);
      this.win.zoom(e.deltaY > 0 ? 1 : -1, frac);
    };
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  /** The shared window, for the controls that drive it. */
  window(): TimelineWindow {
    return this.win;
  }

  /** Reserve room on the header row for the control bar drawn over the canvas. */
  setHeaderInset(px: number): void {
    this.headerInset = px;
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
    // The window may reach past `now` to a ramp that is scheduled but hasn't run.
    const contentEnd = Math.max(
      view.nowMs,
      ...view.spans.map((s) => s.endMs),
      this.win.isFitAll() ? MIN_SPAN_MS : this.win.windowMs,
    );
    const start = this.win.resolve(contentEnd);
    const end = start + this.win.windowMs;
    // Only batches active inside the window get a row, so the rows stay large
    // and about what is on screen rather than the whole run.
    const visible = view.batches.filter((b) => b.countedAt >= start && b.launchedAt <= end);
    const l = layout(w, h, visible.length);
    this.geom = { plotX: l.plotX, plotW: l.plotW };
    const xFor = (t: number) => l.plotX + ((t - start) / this.win.windowMs) * l.plotW;

    this.drawFrame(w, h, view, start);
    // Everything time-mapped is clipped to the plot so nothing spills into the
    // margins when it runs off either edge of the window.
    ctx.save();
    ctx.beginPath();
    ctx.rect(l.plotX, l.demand.y - 10, l.plotW, l.axisY - l.demand.y + 10);
    ctx.clip();
    this.drawBreaches(view, l, xFor);
    this.drawDemand(sim, l, xFor, start, end);
    this.drawSpans(view, l, xFor);
    this.drawAlarms(view, l, xFor);
    this.drawBatches(view, visible, l, xFor);
    this.drawMetricTicks(view, l, xFor, start, end);
    this.drawNowEdge(view, l, xFor);
    ctx.restore();
    this.drawAxis(l, start, xFor);
    this.drawHover(sim, view, l, start);
  }

  // -- Chrome ----------------------------------------------------------------

  private drawFrame(w: number, h: number, view: ScalingTimelineView, start: number): void {
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

    // The run in one line, so its shape is readable without hovering.
    const breachMs = view.breaches.reduce((a, b) => a + (b.endMs - b.startMs), 0);
    const added = view.batches.reduce((a, b) => a + b.count, 0);
    ctx.textAlign = 'right';
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    let x = w - 10 - this.headerInset;
    if (breachMs > 0) {
      const label = `below SLO ${fmtDur(breachMs)}`;
      ctx.fillStyle = SEMANTIC.timeout;
      ctx.fillText(label, x, 14);
      x -= ctx.measureText(label).width + 10;
    }
    const outs = `${view.batches.length} scale-out${view.batches.length === 1 ? '' : 's'} · +${added}`;
    ctx.fillStyle = SEMANTIC.inFlight;
    ctx.fillText(outs, x, 14);
    x -= ctx.measureText(outs).width + 10;
    ctx.fillStyle = this.win.isFollowing() ? SURFACE.textFaint : SEMANTIC.shed;
    const state = this.win.isHeld() ? ' — held' : this.win.isFollowing() ? '' : ' — scrolled back';
    const win = this.win.isFitAll()
      ? 'whole run'
      : `${fmtDur(this.win.windowMs)} window${state ? ` @ ${fmtClock(start)}${state}` : ''}`;
    ctx.fillText(win, x, 14);
    x -= ctx.measureText(win).width + 10;
    // Drop the hint rather than let it collide with the title on a narrow pane.
    const how = this.win.isFitAll() ? 'hover for detail' : '◀ ▶ or drag to scroll';
    const hint = `${how} · ${fmtClock(view.nowMs)} elapsed`;
    if (x - ctx.measureText(hint).width > 76) {
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText(hint, x, 14);
    }
    ctx.textAlign = 'left';
  }

  /** Below-SLO stretches, shaded behind every lane. */
  private drawBreaches(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    for (const b of view.breaches) {
      const x0 = xFor(b.startMs);
      const x1 = Math.max(x0 + 1, xFor(b.endMs));
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.13);
      ctx.fillRect(x0, l.demand.y, x1 - x0, l.axisY - l.demand.y);
    }
  }

  /** Offered demand as a curve, usable capacity filled beneath it. */
  private drawDemand(
    sim: ScalingSimulation,
    l: Layout,
    xFor: (t: number) => number,
    start: number,
    end: number,
  ): void {
    const ctx = this.ctx;
    // Only the buckets in view, so the y-scale reflects the window rather than
    // a peak that happened an hour ago and is no longer on screen.
    const buckets = sim.metrics.buckets.filter((b) => b.time >= start && b.time <= end);
    let peak = 1;
    for (const b of buckets) peak = Math.max(peak, b.offeredRate, b.usableCapacityTps);
    // Include the demand the run is heading for, so a pre-start axis is to scale.
    const t = sim.cfg.traffic;
    peak = Math.max(peak, t.baseRateTps + (t.shape === 'steady' ? 0 : t.rampAmountTps));
    const yFor = (v: number) => l.demand.y + l.demand.h - (Math.min(v, peak) / peak) * l.demand.h;

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
        ctx.lineTo(lastX, l.demand.y + l.demand.h);
        ctx.lineTo(l.plotX, l.demand.y + l.demand.h);
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.14);
        ctx.fill();
      }
    };
    series((b) => b.usableCapacityTps, SEMANTIC.success, true);
    series((b) => b.offeredRate, SEMANTIC.timeout, false);

    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.fillText(fmtTps(peak), l.plotX + 2, l.demand.y + 8);
    ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.9);
    ctx.fillText('offered', l.plotX + 34, l.demand.y + 8);
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.9);
    ctx.fillText('usable capacity', l.plotX + 76, l.demand.y + 8);
  }

  /** Demand brackets: when throughput was offered, and over how long. */
  private drawSpans(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const rowH = l.spans.h / MAX_SPAN_ROWS;
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
      const y = l.spans.y + row * rowH + rowH / 2;
      const color = LANE_COLOR[span.kind];
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.fillStyle = withAlpha(color, 0.9);
      ctx.lineWidth = 2;
      if (span.endMs > span.startMs) {
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
      // Label after the bracket; failing that before it; failing that inside it,
      // which is what a bracket spanning most of the axis needs.
      ctx.font = '600 8.5px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      const labelW = ctx.measureText(span.label).width;
      if (x1 + 5 + labelW < l.plotX + l.plotW) {
        ctx.fillText(span.label, x1 + 5, y + 3);
      } else if (x0 - 5 - labelW > l.plotX) {
        ctx.textAlign = 'right';
        ctx.fillText(span.label, x0 - 5, y + 3);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(span.label, x0 + 6, y - 3);
      }
      rowEnds[row] = x1 + labelW + 6;
    }
  }

  /**
   * The alarm's own state: amber while the breach is accumulating datapoints,
   * red once it has fired. The amber stretch is the detection lag, made literal.
   */
  private drawAlarms(view: ScalingTimelineView, l: Layout, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    const y = l.alarm.y;
    const h = Math.max(3, l.alarm.h - 3);
    for (const a of view.alarms) {
      const x0 = xFor(a.startMs);
      const xEnd = Math.max(x0 + 1, xFor(a.endMs));
      const fired = a.firedAtMs >= 0 ? Math.min(xFor(a.firedAtMs), xEnd) : xEnd;
      ctx.fillStyle = withAlpha(SEMANTIC.shed, 0.75);
      ctx.fillRect(x0, y, Math.max(1, fired - x0), h);
      if (fired < xEnd) {
        ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.75);
        ctx.fillRect(fired, y, xEnd - fired, h);
      }
    }
    if (l.detailed) {
      ctx.font = '500 8px "IBM Plex Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText('alarm: detecting → firing', l.plotX + l.plotW - 2, y + h - 1);
      ctx.textAlign = 'left';
    }
  }

  /**
   * One row per scale-out: the pipeline stage by stage, the bake beneath it, and
   * the point the batch started counting as capacity. This is the whole scale
   * process — why a step took as long as it did to matter.
   */
  private drawBatches(
    view: ScalingTimelineView,
    visible: ScalingBatch[],
    l: Layout,
    xFor: (t: number) => number,
  ): void {
    const ctx = this.ctx;
    this.rows = [];
    const n = visible.length;
    if (n === 0) {
      ctx.font = '500 8.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.textAlign = 'left';
      const msg = view.batches.length
        ? 'no scale-outs in this window — scroll back to find them'
        : 'no scale-outs yet — each one draws its pipeline here';
      ctx.fillText(msg, l.plotX + 2, l.batches.y + 12);
      return;
    }
    const rowH = Math.min(BATCH_ROW_MAX, l.batches.h / n);
    const barH = Math.max(2, rowH * 0.42);
    const bakeH = Math.max(1.5, rowH * 0.16);
    const hoveredBatch = this.hoveredRow()?.batch;

    visible.forEach((batch, i) => {
      const y = l.batches.y + i * rowH;
      this.rows.push({ batch, y0: y, y1: y + rowH });
      const hovered = hoveredBatch === batch;

      // Pipeline: one segment per stage, alternating so the boundaries read.
      // The stage that makes an instance serving (DNS publish) goes green.
      let prev = batch.launchedAt;
      batch.stageEndsAt.forEach((end, si) => {
        const x0 = xFor(prev);
        const x1 = xFor(end);
        const ready = PIPELINE_STAGES[si].readyAfter;
        ctx.fillStyle = withAlpha(ready ? SEMANTIC.success : SEMANTIC.inFlight, si % 2 === 0 ? 0.85 : 0.55);
        ctx.fillRect(x0, y + 2, Math.max(0.75, x1 - x0 - 0.5), barH);
        prev = end;
      });

      // Bake: its own bar under the pipeline. Under ECS it starts at the launch
      // and runs *alongside* the stages; under ASG it starts when the batch
      // lands and follows them. Drawing it separately makes that visible.
      const bakeFrom = batch.countedAt <= batch.inServiceAt ? batch.launchedAt : batch.inServiceAt;
      const ecsOverlap = batch.countedAt - batch.launchedAt < batch.inServiceAt - batch.launchedAt;
      const bx0 = xFor(ecsOverlap ? batch.launchedAt : bakeFrom);
      const bx1 = xFor(batch.countedAt);
      ctx.fillStyle = withAlpha(SEMANTIC.retry, 0.8);
      ctx.fillRect(bx0, y + 2 + barH + 1, Math.max(1, bx1 - bx0), bakeH);

      // Counting from here on: a hairline out to the right edge.
      if (batch.countedAt <= view.nowMs) {
        ctx.strokeStyle = withAlpha(SEMANTIC.success, hovered ? 0.85 : 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xFor(batch.countedAt), y + 2 + barH / 2);
        ctx.lineTo(l.plotX + l.plotW, y + 2 + barH / 2);
        ctx.stroke();
      }

      if (rowH >= 9) {
        ctx.font = '600 8px "IBM Plex Mono", monospace';
        ctx.fillStyle = hovered ? SURFACE.text : SURFACE.textDim;
        ctx.textAlign = 'left';
        const label = `+${batch.count}`;
        const lx = xFor(batch.launchedAt) - ctx.measureText(label).width - 4;
        ctx.fillText(label, Math.max(l.plotX, lx), y + 2 + barH);
      }
      if (hovered) {
        ctx.strokeStyle = withAlpha(SURFACE.text, 0.35);
        ctx.lineWidth = 1;
        ctx.strokeRect(l.plotX, y + 0.5, l.plotW, rowH - 1);
      }
    });

    if (l.detailed) {
      ctx.font = '500 8px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.textAlign = 'right';
      ctx.fillText('scale-outs: pipeline ▸ bake ▸ counted', l.plotX + l.plotW - 2, l.batches.y + l.batches.h - 1);
      ctx.textAlign = 'left';
    }
  }

  /** A tick per metric publish — nothing can be decided between two of them. */
  private drawMetricTicks(
    view: ScalingTimelineView,
    l: Layout,
    xFor: (t: number) => number,
    start: number,
    end: number,
  ): void {
    const ctx = this.ctx;
    const step = view.metricPeriodMs;
    // Don't draw a solid smear when a wide window packs ticks tighter than a pixel.
    if ((step / this.win.windowMs) * l.plotW < 2.5) return;
    ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.5);
    const first = Math.ceil(Math.max(0, start) / step) * step;
    for (let t = first; t <= Math.min(view.nowMs, end); t += step) {
      ctx.fillRect(xFor(t), l.metric.y, 1, Math.max(2, l.metric.h - 2));
    }
    if (l.detailed) {
      ctx.font = '500 8px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.textAlign = 'right';
      ctx.fillText(`metric published every ${fmtDur(step)}`, l.plotX + l.plotW - 2, l.metric.y + l.metric.h);
      ctx.textAlign = 'left';
    }
  }

  private drawAxis(l: Layout, start: number, xFor: (t: number) => number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = SURFACE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.plotX, l.axisY);
    ctx.lineTo(l.plotX + l.plotW, l.axisY);
    ctx.stroke();
    const step = TICK_STEPS.find((s) => this.win.windowMs / s <= 10) ?? TICK_STEPS[TICK_STEPS.length - 1];
    ctx.font = '500 8px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'center';
    const end = start + this.win.windowMs;
    for (let t = Math.ceil(start / step) * step; t <= end + 1; t += step) {
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
    ctx.fillRect(x, l.demand.y, l.plotX + l.plotW - x, l.axisY - l.demand.y);
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.35);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, l.demand.y);
    ctx.lineTo(x, l.axisY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Hover -----------------------------------------------------------------

  private hoveredRow(): BatchRow | null {
    if (this.hoverX === null) return null;
    return this.rows.find((r) => this.hoverY >= r.y0 && this.hoverY < r.y1) ?? null;
  }

  private drawHover(sim: ScalingSimulation, view: ScalingTimelineView, l: Layout, start: number): void {
    const hx = this.hoverX;
    if (hx === null || hx < l.plotX || hx > l.plotX + l.plotW) return;
    const ctx = this.ctx;
    const t = start + ((hx - l.plotX) / l.plotW) * this.win.windowMs;
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, l.demand.y);
    ctx.lineTo(hx, l.axisY);
    ctx.stroke();

    // Over a batch row, explain that scale-out instead of the moment.
    const row = this.hoveredRow();
    if (row) {
      this.tooltip(decisionLines(row.batch), hx, l, 0);
      return;
    }

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
      lines.push(`counted ${fmtTps(bucket.meteredCapacityTps)}`);
      lines.push(`avail   ${(avail * 100).toFixed(1)}%`);
    }
    const grabMs = (this.win.windowMs / l.plotW) * 6;
    const near = view.events.filter((e) => Math.abs(e.time - t) <= grabMs).slice(-3);
    for (const e of near) lines.push(`• ${e.message}`);
    this.tooltip(lines, hx, l, near.length);
  }

  private tooltip(lines: string[], hx: number, l: Layout, eventCount: number): void {
    const ctx = this.ctx;
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    let boxW = 0;
    for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
    boxW = Math.min(boxW + 14, l.plotW - 8);
    const boxH = lines.length * 11 + 8;
    const bx = Math.min(Math.max(l.plotX, hx + 10), l.plotX + l.plotW - boxW);
    const by = Math.min(Math.max(l.demand.y, this.hoverY - boxH - 6), l.axisY - boxH);
    ctx.fillStyle = withAlpha(SURFACE.canvas, 0.96);
    ctx.strokeStyle = SURFACE.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    const firstEvent = lines.length - eventCount;
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? SURFACE.text : eventCount > 0 && i >= firstEvent ? SEMANTIC.shed : SURFACE.textDim;
      ctx.fillText(clip(ctx, line, boxW - 12), bx + 7, by + 13 + i * 11);
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * The derivation behind one scale-out, in the order the policy computed it:
 * what it measured, what it scaled from, what that asked for, what the clamps
 * left, and when the result would actually matter.
 */
function decisionLines(batch: ScalingBatch): string[] {
  const d: ScalingDecision = batch.decision;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const unit = d.adjustmentType === 'percent-change-in-capacity' ? '%' : '';
  const lines = [
    `${fmtClock(d.timeMs)}  scale-out +${d.launched}`,
    `${d.policy} · util ${pct(d.utilization)} vs target ${pct(d.targetUtilization)}`,
  ];
  if (d.policy === 'target-tracking') {
    const gain = d.gain !== null && d.gain !== 1 ? ` × ${d.gain.toFixed(1)} gain` : '';
    lines.push(`${d.metered} counted × ${pct(d.utilization)} ÷ ${pct(d.targetUtilization)}${gain} = ${d.want.toFixed(1)}`);
  } else if (d.policy === 'step') {
    lines.push(`rung ${(d.tier ?? 0) + 1}: +${d.adjustment}${unit} on ${d.metered} counted = ${d.want.toFixed(1)}`);
  } else {
    lines.push(`+${d.adjustment}${unit} on ${d.currentDesired} desired = ${d.want.toFixed(1)}`);
  }
  lines.push(`desired ${d.newDesired} − ${d.currentDesired} already requested = ${d.newDesired - d.currentDesired}`);
  if (d.clampedBy) lines.push(`clamped by ${d.clampedBy} → +${d.launched}`);
  lines.push(`lands ${fmtClock(batch.inServiceAt)} · counts ${fmtClock(batch.countedAt)}`);
  return lines;
}

function layout(w: number, h: number, batchCount: number): Layout {
  const plotX = 10;
  const plotW = w - 20;
  const top = 20;
  const axisY = h - 16;
  const avail = axisY - top;
  const detailed = avail > 190;
  // Fixed-height lanes first; the demand curve and the batch rows share the rest.
  const spansH = Math.min(34, Math.max(22, avail * 0.14));
  const alarmH = detailed ? 14 : 9;
  const metricH = detailed ? 12 : 7;
  const flexible = Math.max(40, avail - spansH - alarmH - metricH - 8);
  // The batch lane takes only what its rows can actually use — otherwise a run
  // with a handful of scale-outs leaves a dead band under them. Whatever is left
  // goes to the demand curve, which always has more to say with more room.
  const rowH = detailed ? BATCH_ROW_MAX : 16;
  const batchesH = Math.max(24, Math.min(flexible * 0.55, Math.max(1, batchCount) * rowH));
  const demandH = Math.max(38, flexible - batchesH);
  let y = top;
  const demand = { y, h: demandH };
  y += demandH + 4;
  const spans = { y, h: spansH };
  y += spansH;
  const alarm = { y, h: alarmH };
  y += alarmH + 2;
  const batches = { y, h: batchesH };
  y += batchesH + 2;
  const metric = { y, h: metricH };
  return { plotX, plotW, demand, spans, alarm, batches, metric, axisY, detailed };
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
