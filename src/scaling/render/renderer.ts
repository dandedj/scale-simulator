/**
 * Canvas renderer for the Scaling model. Shows, live: a scale-rate readout
 * (offered / usable capacity / availability, recover time, effective add-rate,
 * max-sustainable-ramp, pipeline latency, and the bake hold before the next
 * scale decision); a per-stage lag breakdown bar (where the ~5 minutes goes —
 * the "what to optimize" view); the scale-up pipeline with instances flowing
 * stage by stage; a demand-vs-capacity meter (the current gap, and how much of
 * the serving capacity the autoscaler is not yet counting); and the fleet as
 * tiles colored by phase. Motion is a function of sim time.
 */

import { loadColor, SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import { PIPELINE_STAGES } from '../engine/types';

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ScalingRenderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
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

  reset(): void {}

  draw(sim: ScalingSimulation): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    this.drawBackdrop(w, h);
    if (w < 260 || h < 200) return;

    const m = w * 0.02;
    // One row of chips — the board gets the rest.
    const readoutH = 34;
    // Short board (comparison mode with a timeline under each pane): the fixed
    // furniture has to give ground too, or there is nothing left for the fleet.
    const compact = h < 340;
    const outcomeH = compact ? 30 : 50;
    const top = 8;
    const mainTop = top + readoutH + (compact ? 8 : 12);
    const mainBottom = h - outcomeH - (compact ? 6 : 10);
    const mainH = Math.max(60, mainBottom - mainTop);

    this.drawReadout(sim, m, top, w - 2 * m, readoutH);

    // Short boards — comparison mode with a timeline under each pane — drop the
    // pipeline column rather than squeeze eight stage rows into no height. The
    // cycle bar and the fleet are what carry the story at a glance; the
    // stage-by-stage view is a single-sim study, and the timeline shows it too.
    if (compact) {
      const full = w - 2 * m;
      // The cycle bar is the first thing to go when even this is too tall.
      const breakdownH = mainH >= 130 ? 34 : 0;
      if (breakdownH) this.drawBreakdown(sim, { x: m, y: mainTop, w: full, h: breakdownH });
      const restY = mainTop + (breakdownH ? breakdownH + 6 : 0);
      const restH = mainH - (breakdownH ? breakdownH + 6 : 0);
      // Proportional, so the fleet always gets room rather than a negative box.
      const meterH = Math.max(30, Math.min(56, restH * 0.42));
      this.drawDemandMeter(sim, { x: m, y: restY, w: full, h: meterH });
      this.drawFleet(sim, { x: m, y: restY + meterH + 6, w: full, h: Math.max(24, restH - meterH - 6) });
    } else {
      const meterH = 84;
      const leftW = (w - 3 * m) * 0.46;
      const rightW = w - 3 * m - leftW;
      const leftX = m;
      const rightX = m + leftW + m;

      // Left column: per-stage breakdown bar + pipeline flow.
      const breakdownH = 54;
      this.drawBreakdown(sim, { x: leftX, y: mainTop, w: leftW, h: breakdownH });
      this.drawPipeline(sim, { x: leftX, y: mainTop + breakdownH + 10, w: leftW, h: mainH - breakdownH - 10 });

      // Right column: demand-vs-capacity meter + fleet tiles.
      this.drawDemandMeter(sim, { x: rightX, y: mainTop, w: rightW, h: meterH });
      this.drawFleet(sim, { x: rightX, y: mainTop + meterH + 10, w: rightW, h: mainH - meterH - 10 });
    }

    this.drawOutcomeBar(sim, m, h - outcomeH - 4, w - 2 * m, outcomeH - 4);

    if (sim.degradedActive()) this.drawDegradedFrame(sim.now);
  }

  private drawBackdrop(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.canvas;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = withAlpha('#3A4148', 0.16);
    for (let x = 14; x < w; x += 30) {
      for (let y = 14; y < h; y += 30) ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  // -- Readout panel ----------------------------------------------------------

  /**
   * One row of chips rather than three stacked columns. The panel used to take a
   * fifth of the board's height to say ten things that fit on a line, and the
   * board is what people are here to watch.
   *
   * Chips are drawn in priority order and stop at the panel edge, so a narrow
   * pane loses the least important readings instead of overlapping them.
   */
  private drawReadout(sim: ScalingSimulation, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const d = sim.demandView();
    const r = sim.scaleReadout();
    const avail = sim.availability();
    const availCol = avail >= sim.cfg.slaTarget ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
    const held = r.holdRemainingMs > 0;
    const beat = 0.5 + 0.5 * Math.sin(sim.now / 300);
    this.panel(x, y, w, h, avail < sim.cfg.slaTarget ? SEMANTIC.timeout : SURFACE.border);

    const mid = y + h / 2 + 4;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 13px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.text;
    ctx.fillText('SCALE-UP', x + 11, mid);
    let cx = x + 11 + ctx.measureText('SCALE-UP').width + 14;
    const right = x + w - 10;

    // Once one chip runs out of room the rest stay off too, so what is shown is
    // always the leading run of the priority order rather than whichever later
    // ones happened to be short enough to squeeze in.
    let full = false;
    const chip = (value: string, label: string, color: string, big = false): void => {
      if (full) return;
      ctx.font = big ? '700 15px "IBM Plex Mono", monospace' : '700 11.5px "IBM Plex Mono", monospace';
      const vw = ctx.measureText(value).width;
      ctx.font = '500 8.5px "IBM Plex Mono", monospace';
      const lw = ctx.measureText(label).width;
      if (cx + vw + 4 + lw > right) {
        full = true;
        return;
      }
      ctx.font = big ? '700 15px "IBM Plex Mono", monospace' : '700 11.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = color;
      ctx.fillText(value, cx, mid);
      cx += vw + 4;
      ctx.font = '500 8.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText(label, cx, mid);
      cx += lw + 15;
    };

    chip(`${(avail * 100).toFixed(1)}%`, 'availability', availCol, true);
    chip(fmtTps(d.offeredTps), 'offered', SEMANTIC.timeout);
    chip(fmtTps(d.usableCapacityTps), `usable · ${fmtTps(d.meteredCapacityTps)} counted`, SEMANTIC.success);
    chip(
      `${d.inUse}·${d.baking}·${d.ready}·${d.provisioning}`,
      'in use · baking · ready · launching',
      SURFACE.text,
    );
    // What the autoscaler is waiting on, or how often it can act when free.
    if (held) {
      chip(
        `⏳ ${fmtDur(r.holdRemainingMs)}`,
        r.holdBlocks ? `${r.holdReason} — until the next decision` : `${r.holdReason} — until counted`,
        withAlpha(SEMANTIC.retry, 0.65 + 0.35 * beat),
      );
    } else {
      chip(fmtDur(r.decisionIntervalMs), 'between decisions', SURFACE.textDim);
    }
    chip(
      r.active ? `${fmtDur(r.recoverMs)}${r.recovered ? '' : '…'}` : '—',
      'recover',
      r.recovered ? SEMANTIC.success : r.active ? SEMANTIC.timeout : SURFACE.textDim,
    );
    chip(
      r.effectiveAddRatePerMin > 0 ? `${fmtTps(r.effectiveAddRatePerMin)}/min` : '—',
      'add-rate',
      SURFACE.text,
    );
    chip(`${fmtTps(r.maxSustainableRampPerMin)}/min`, 'max ramp', SEMANTIC.inFlight);
    chip(fmtDur(r.pipelineLatencyMs), 'pipeline', SURFACE.textDim);
    if (r.overshootInstances > 0) chip(`+${r.overshootInstances}`, 'beyond peak need', SEMANTIC.shed);
  }

  // -- Per-stage lag breakdown ------------------------------------------------

  private drawBreakdown(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('WHERE THE SCALE CYCLE GOES', r.x + 8, r.y + 14);

    // Detection + the per-instance pipeline is the lag to the *first* new
    // capacity; the bake is what has to pass before a second scale-out can build
    // on it. Together they are one full scale cycle.
    //
    // Under ASG the bake starts when the batch lands, so it follows the pipeline
    // and the whole bar adds up. Under ECS it starts at the launch and runs
    // *alongside* the pipeline, so only the part that outlasts the pipeline
    // lengthens the cycle — a bake shorter than the pipeline adds nothing at all.
    const pipelineMs = PIPELINE_STAGES.reduce((a, st) => a + sim.cfg.stages[st.key], 0);
    const bakeMs =
      sim.cfg.launch.warmupMode === 'ecs' ? Math.max(0, sim.cfg.launch.bakeMs - pipelineMs) : sim.cfg.launch.bakeMs;
    const stages: { label: string; ms: number; bake?: boolean }[] = [
      { label: 'detect', ms: sim.cfg.stages.detectionMs },
      ...PIPELINE_STAGES.map((s) => ({ label: s.label, ms: sim.cfg.stages[s.key] })),
      { label: 'bake', ms: bakeMs, bake: true },
    ];
    const total = stages.reduce((a, s) => a + s.ms, 0) || 1;
    const maxMs = Math.max(...stages.map((s) => s.ms));
    const barX = r.x + 8;
    const barY = r.y + 22;
    const barW = r.w - 16;
    const barH = 12;
    let cx = barX;
    for (let i = 0; i < stages.length; i++) {
      const seg = (stages[i].ms / total) * barW;
      const dominant = stages[i].ms === maxMs;
      const base = stages[i].bake ? SEMANTIC.retry : dominant ? SEMANTIC.timeout : SEMANTIC.inFlight;
      ctx.fillStyle = withAlpha(base, stages[i].bake ? 0.8 : i % 2 === 0 ? 0.85 : 0.6);
      ctx.fillRect(cx, barY, Math.max(0, seg - 1), barH);
      cx += seg;
    }
    // Label the dominant stage + total.
    const dom = stages.reduce((a, s) => (s.ms > a.ms ? s : a), stages[0]);
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = dom.bake ? SEMANTIC.retry : SEMANTIC.timeout;
    ctx.fillText(`slowest: ${dom.label} ${fmtDur(dom.ms)}`, barX, r.y + r.h - 5);
    ctx.textAlign = 'right';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`cycle ${fmtDur(total)}`, r.x + r.w - 8, r.y + r.h - 5);
    ctx.textAlign = 'left';
  }

  // -- Pipeline flow ----------------------------------------------------------

  private drawPipeline(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('SCALE-UP PIPELINE', r.x + 8, r.y + 14);

    const stages = sim.stageViews();
    const instances = sim.instanceViews();
    const top = r.y + 22;
    const rowH = Math.max(14, (r.h - 30) / stages.length);
    const labelW = Math.min(74, r.w * 0.34);
    const trackX = r.x + 8 + labelW;
    const trackW = r.w - 16 - labelW - 34;

    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const y = top + i * rowH + rowH / 2;
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textDim;
      ctx.textAlign = 'left';
      ctx.fillText(s.label, r.x + 8, y + 3);
      // Track.
      ctx.strokeStyle = withAlpha(SURFACE.border, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(trackX, y);
      ctx.lineTo(trackX + trackW, y);
      ctx.stroke();
      // Instances currently in this stage, positioned by progress.
      let shown = 0;
      for (const inst of instances) {
        if (inst.stageIndex !== i) continue;
        if (shown++ > 40) break;
        const px = trackX + trackW * clamp01(inst.stageProgress);
        ctx.fillStyle = SEMANTIC.tlsPulse;
        ctx.beginPath();
        ctx.arc(px, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Count on the right.
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = s.count > 0 ? SEMANTIC.tlsPulse : SURFACE.textFaint;
      ctx.textAlign = 'right';
      ctx.fillText(String(s.count), r.x + r.w - 8, y + 3);
    }
    ctx.textAlign = 'left';
  }

  // -- Demand vs capacity meter ----------------------------------------------

  private drawDemandMeter(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    const d = sim.demandView();
    const cap = sim.cfg.capacity.capacityPerInstanceTps;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('DEMAND vs CAPACITY', r.x + 8, r.y + 14);

    const provisioningCap = d.provisioning * cap;
    const readyOnlyCap = d.ready * cap; // ready but not yet usable
    const scale = Math.max(d.offeredTps, d.usableCapacityTps + readyOnlyCap + provisioningCap, 1) * 1.08;
    const barX = r.x + 8;
    const barY = r.y + 26;
    const barW = r.w - 16;
    const barH = 20;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(barX, barY, barW, barH);
    // Stacked capacity: usable (serving) → ready-in-DNS-not-picked-up → provisioning (in pipeline).
    let cx = barX;
    const seg = (tps: number, color: string, a: number) => {
      const wpx = (tps / scale) * barW;
      ctx.fillStyle = withAlpha(color, a);
      ctx.fillRect(cx, barY, wpx, barH);
      cx += wpx;
    };
    seg(d.usableCapacityTps, SEMANTIC.success, 0.85);
    seg(readyOnlyCap, SEMANTIC.inFlight, 0.7);
    seg(provisioningCap, SEMANTIC.tlsPulse, 0.4);
    // Live traffic river over the serving (green) capacity: motion so a steady
    // state still reads as carrying load. Flow speed rises with utilization.
    const usableX = barX + (d.usableCapacityTps / scale) * barW;
    const servedTps = Math.min(d.offeredTps, d.usableCapacityTps);
    const servedX = barX + (servedTps / scale) * barW;
    this.flowStripes(barX, barY, servedX - barX, barH, SURFACE.canvas, 0.4, d.utilization, sim.now);
    // Offered marker + a pulsing head so the current load reads as live.
    const ox = barX + (d.offeredTps / scale) * barW;
    ctx.strokeStyle = SEMANTIC.timeout;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, barY - 4);
    ctx.lineTo(ox, barY + barH + 4);
    ctx.stroke();
    const beat = 0.5 + 0.5 * Math.sin(sim.now / 200);
    ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.55 + 0.45 * beat);
    ctx.beginPath();
    ctx.arc(ox, barY - 5, 2.4 + 1.4 * beat, 0, Math.PI * 2);
    ctx.fill();
    // Deficit: offered beyond usable → the dropped demand, as a red rush.
    if (ox > usableX + 1) {
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.28 + 0.18 * beat);
      ctx.fillRect(usableX, barY, ox - usableX, barH);
      this.flowStripes(usableX, barY, ox - usableX, barH, SURFACE.text, 0.3, 1, sim.now);
    }
    // Where the autoscaler thinks capacity ends: everything to the right of this
    // is serving traffic but still baking, so it does not count toward the fleet
    // the next scale decision is computed from.
    if (d.baking > 0) {
      const mx = barX + (d.meteredCapacityTps / scale) * barW;
      ctx.strokeStyle = withAlpha(SEMANTIC.retry, 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, barY - 2);
      ctx.lineTo(mx, barY + barH + 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = SEMANTIC.timeout;
    ctx.textAlign = 'left';
    ctx.fillText(`▲ offered ${fmtTps(d.offeredTps)}`, barX, r.y + r.h - 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = d.baking > 0 ? SEMANTIC.retry : SURFACE.textDim;
    const counted = d.baking > 0 ? `counted ${fmtTps(d.meteredCapacityTps)} · ` : '';
    ctx.fillText(
      `${counted}usable ${fmtTps(d.usableCapacityTps)} · util ${Math.round(d.utilization * 100)}%`,
      r.x + r.w - 8,
      r.y + r.h - 6,
    );
    ctx.textAlign = 'left';
  }

  // -- Fleet tiles ------------------------------------------------------------

  private drawFleet(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    const insts = sim.instanceViews();
    const atMax = insts.length >= sim.cfg.launch.maxInstances;
    const beat = 0.5 + 0.5 * Math.sin(sim.now / 200);
    // At the ceiling → red pulsing border: no more scale-out is possible.
    this.panel(r.x, r.y, r.w, r.h, atMax ? withAlpha(SEMANTIC.timeout, 0.45 + 0.45 * beat) : SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('FLEET', r.x + 8, r.y + 14);

    // Fleet-size / max-capacity badge, top-right of the panel header.
    ctx.textAlign = 'right';
    if (atMax) {
      ctx.font = '700 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.7 + 0.3 * beat);
      ctx.fillText(`⛔ MAX FLEET ${insts.length}/${sim.cfg.launch.maxInstances}`, r.x + r.w - 8, r.y + 14);
    } else {
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText(`${insts.length}/${sim.cfg.launch.maxInstances}`, r.x + r.w - 8, r.y + 14);
    }
    ctx.textAlign = 'left';

    const d = sim.demandView();
    const target = clamp01(d.targetUtilization);
    const util = d.utilization;
    const nStages = PIPELINE_STAGES.length;
    const n = Math.max(1, insts.length);
    const gridTop = r.y + 22;
    const gridW = Math.max(1, r.w - 16);
    const gridH = Math.max(1, r.h - 30);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * (gridW / gridH))));
    const rows = Math.ceil(n / cols);
    const cw = gridW / cols;
    const ch = gridH / rows;
    const pad = Math.min(3, cw * 0.12);
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const tx = r.x + 8 + col * cw + pad;
      const ty = gridTop + row * ch + pad;
      const tw = Math.max(2, cw - 2 * pad);
      const th = Math.max(2, ch - 2 * pad);
      const detailed = th >= 9 && tw >= 5;

      if (inst.inUse) {
        if (detailed) {
          // In-use tile is a utilization gauge relative to the scaling threshold:
          // fill = current util, dashed line = target util (where scale-out trips).
          ctx.fillStyle = withAlpha(SURFACE.panelRaised, 0.9);
          ctx.fillRect(tx, ty, tw, th);
          const fh = th * clamp01(util);
          ctx.fillStyle = withAlpha(loadColor(util), 0.9);
          ctx.fillRect(tx, ty + th - fh, tw, fh);
          const thY = ty + th * (1 - target);
          ctx.strokeStyle = withAlpha(SURFACE.text, 0.7);
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tx, thY);
          ctx.lineTo(tx + tw, thY);
          ctx.stroke();
          ctx.setLineDash([]);
          if (util >= 1) {
            // Over capacity → dropping: red top edge.
            ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.6 + 0.4 * beat);
            ctx.fillRect(tx, ty, tw, 1.5);
          }
          if (inst.baking) {
            // Serving, but the autoscaler is not counting it yet: outlined.
            ctx.strokeStyle = withAlpha(SEMANTIC.retry, 0.75 + 0.25 * beat);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(tx + 0.75, ty + 0.75, tw - 1.5, th - 1.5);
          }
        } else {
          ctx.fillStyle = withAlpha(inst.baking ? SEMANTIC.retry : inst.prewarmed ? SEMANTIC.success : loadColor(util), 0.85);
          ctx.fillRect(tx, ty, tw, th);
        }
      } else if (inst.ready) {
        // Provisioned & advertised, but clients not yet using it.
        ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.8);
        ctx.fillRect(tx, ty, tw, th);
      } else {
        // Provisioning: fill rises with pipeline progress; pulse reads as "working".
        const prog = clamp01((inst.stageIndex + inst.stageProgress) / nStages);
        const a = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(sim.now / 260 + i));
        ctx.fillStyle = withAlpha(SURFACE.panelRaised, 0.9);
        ctx.fillRect(tx, ty, tw, th);
        ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, a);
        ctx.fillRect(tx, ty + th * (1 - prog), tw, th * prog);
      }
    }
  }

  // -- Outcome bar + frame ----------------------------------------------------

  private drawOutcomeBar(sim: ScalingSimulation, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const d = sim.demandView();
    const offered = Math.max(1e-6, d.offeredTps);
    const served = Math.min(offered, d.usableCapacityTps);
    const avail = sim.availability();
    this.panel(x, y, w, h, SURFACE.border);
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'left';
    ctx.fillText(`SERVED ${fmtTps(served)} / ${fmtTps(offered)}`, x + 10, y + 15);
    ctx.textAlign = 'right';
    ctx.fillStyle = avail >= sim.cfg.slaTarget ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
    ctx.fillText(`AVAILABILITY ${(avail * 100).toFixed(1)}%`, x + w - 10, y + 15);
    ctx.textAlign = 'left';
    const barX = x + 10;
    const barY = y + 22;
    const barW = w - 20;
    const barH = h - 30;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(barX, barY, barW, barH);
    const servedW = barW * clamp01(served / offered);
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.85);
    ctx.fillRect(barX, barY, servedW, barH);
    ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.85);
    ctx.fillRect(barX + servedW, barY, barW - servedW, barH);
    // Live flow so a steady, fully-served run still reads as carrying traffic.
    this.flowStripes(barX, barY, servedW, barH, SURFACE.canvas, 0.32, d.utilization, sim.now);
    if (barW - servedW > 1) this.flowStripes(barX + servedW, barY, barW - servedW, barH, SURFACE.text, 0.26, 1, sim.now);
    const sloX = barX + barW * sim.cfg.slaTarget;
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.5);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sloX, barY);
    ctx.lineTo(sloX, barY + barH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawDegradedFrame(now: number): void {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.25 + 0.35 * pulse);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(3, 3, this.cssW - 6, this.cssH - 6, 10);
    ctx.stroke();
  }

  /**
   * Diagonal stripes drifting across a rect (clipped to it) — a live "traffic
   * river" so a steady state still reads as flowing rather than frozen. Flow
   * speed scales with `intensity` (0..1+, the utilization of the region).
   */
  private flowStripes(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    intensity: number,
    now: number,
  ): void {
    if (w < 2 || h < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const period = 14;
    const speed = 0.0022 * (0.4 + 1.2 * clamp01(intensity)); // px per sim-ms
    const phase = (now * speed) % period;
    ctx.strokeStyle = withAlpha(color, alpha);
    ctx.lineWidth = 3;
    for (let sx = x - h - period + phase; sx < x + w + period; sx += period) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + h, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private panel(x: number, y: number, w: number, h: number, border: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.panel;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fill();
    ctx.stroke();
  }
}

function fmtTps(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return rem ? `${m}m${rem}s` : `${m}m`;
  }
  return `${Math.round(s)}s`;
}
