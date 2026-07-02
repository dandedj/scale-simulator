/**
 * Canvas renderer for the Scaling model. Shows, live: a scale-rate readout
 * (offered / usable capacity / availability, recover time, effective add-rate,
 * max-sustainable-ramp, pipeline latency); a per-stage lag breakdown bar (where
 * the ~5 minutes goes — the "what to optimize" view); the scale-up pipeline with
 * instances flowing stage by stage; a demand-vs-capacity meter (the current gap);
 * and the fleet as tiles colored by phase. Motion is a function of sim time.
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
    const readoutH = Math.min(96, h * 0.22);
    const outcomeH = 50;
    const top = 8;
    const mainTop = top + readoutH + 12;
    const mainBottom = h - outcomeH - 10;
    const mainH = Math.max(60, mainBottom - mainTop);

    this.drawReadout(sim, m, top, w - 2 * m, readoutH);

    const leftW = (w - 3 * m) * 0.46;
    const rightW = w - 3 * m - leftW;
    const leftX = m;
    const rightX = m + leftW + m;

    // Left column: per-stage breakdown bar + pipeline flow.
    const breakdownH = 54;
    this.drawBreakdown(sim, { x: leftX, y: mainTop, w: leftW, h: breakdownH });
    this.drawPipeline(sim, { x: leftX, y: mainTop + breakdownH + 10, w: leftW, h: mainH - breakdownH - 10 });

    // Right column: demand-vs-capacity meter + fleet tiles.
    const meterH = 84;
    this.drawDemandMeter(sim, { x: rightX, y: mainTop, w: rightW, h: meterH });
    this.drawFleet(sim, { x: rightX, y: mainTop + meterH + 10, w: rightW, h: mainH - meterH - 10 });

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

  private drawReadout(sim: ScalingSimulation, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const d = sim.demandView();
    const r = sim.scaleReadout();
    const avail = sim.availability();
    this.panel(x, y, w, h, avail < sim.cfg.slaTarget ? SEMANTIC.timeout : SURFACE.border);

    ctx.textAlign = 'left';
    ctx.font = '700 14px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.text;
    ctx.fillText('SCALE-UP', x + 12, y + 19);

    // Left block: big live numbers.
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`offered ${fmtTps(d.offeredTps)}`, x + 12, y + 40);
    ctx.fillText(`usable  ${fmtTps(d.usableCapacityTps)}  (ready ${fmtTps(d.readyCapacityTps)})`, x + 12, y + 56);
    ctx.fillText(`instances ${d.inUse} in use · ${d.ready} ready · ${d.provisioning} launching`, x + 12, y + 72);
    const availCol = avail >= sim.cfg.slaTarget ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
    ctx.font = '700 20px "IBM Plex Mono", monospace';
    ctx.fillStyle = availCol;
    ctx.textAlign = 'right';
    ctx.fillText(`${(avail * 100).toFixed(1)}%`, x + w * 0.5, y + 24);
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('availability', x + w * 0.5, y + 36);

    // Right block: the scale-rate calculus.
    const rx = x + w - 12;
    ctx.textAlign = 'right';
    const rows: { label: string; value: string; color: string }[] = [
      {
        label: 'recover time',
        value: r.active ? `${fmtDur(r.recoverMs)}${r.recovered ? '' : '…'}` : '—',
        color: r.recovered ? SEMANTIC.success : r.active ? SEMANTIC.timeout : SURFACE.textDim,
      },
      {
        label: 'effective add-rate',
        value: r.effectiveAddRatePerMin > 0 ? `${fmtTps(r.effectiveAddRatePerMin)}/min` : '—',
        color: SURFACE.text,
      },
      { label: 'max sustainable ramp', value: `${fmtTps(r.maxSustainableRampPerMin)}/min`, color: SEMANTIC.inFlight },
      { label: 'pipeline latency', value: fmtDur(r.pipelineLatencyMs), color: SURFACE.textDim },
    ];
    let ry = y + 18;
    for (const row of rows) {
      ctx.font = '700 12px "IBM Plex Mono", monospace';
      ctx.fillStyle = row.color;
      ctx.fillText(row.value, rx, ry);
      ctx.font = '500 8.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textFaint;
      ctx.fillText(row.label, rx, ry + 9);
      ry += 20;
    }
    ctx.textAlign = 'left';
  }

  // -- Per-stage lag breakdown ------------------------------------------------

  private drawBreakdown(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('WHERE THE LAG GOES', r.x + 8, r.y + 14);

    const stages: { label: string; ms: number }[] = [
      { label: 'detect', ms: sim.cfg.stages.detectionMs },
      ...PIPELINE_STAGES.map((s) => ({ label: s.label, ms: sim.cfg.stages[s.key] })),
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
      ctx.fillStyle = withAlpha(dominant ? SEMANTIC.timeout : SEMANTIC.inFlight, i % 2 === 0 ? 0.85 : 0.6);
      ctx.fillRect(cx, barY, Math.max(0, seg - 1), barH);
      cx += seg;
    }
    // Label the dominant stage + total.
    const dom = stages.reduce((a, s) => (s.ms > a.ms ? s : a), stages[0]);
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = SEMANTIC.timeout;
    ctx.fillText(`slowest: ${dom.label} ${fmtDur(dom.ms)}`, barX, r.y + r.h - 5);
    ctx.textAlign = 'right';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`total ${fmtDur(total)}`, r.x + r.w - 8, r.y + r.h - 5);
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
    // Offered marker.
    const ox = barX + (d.offeredTps / scale) * barW;
    ctx.strokeStyle = SEMANTIC.timeout;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, barY - 4);
    ctx.lineTo(ox, barY + barH + 4);
    ctx.stroke();
    // Deficit: offered beyond usable → the dropped demand.
    const usableX = barX + (d.usableCapacityTps / scale) * barW;
    if (ox > usableX + 1) {
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.3 + 0.2 * (0.5 + 0.5 * Math.sin(sim.now / 240)));
      ctx.fillRect(usableX, barY, ox - usableX, barH);
    }
    ctx.font = '500 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = SEMANTIC.timeout;
    ctx.textAlign = 'left';
    ctx.fillText(`▲ offered ${fmtTps(d.offeredTps)}`, barX, r.y + r.h - 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`usable ${fmtTps(d.usableCapacityTps)} · util ${Math.round(d.utilization * 100)}%`, r.x + r.w - 8, r.y + r.h - 6);
    ctx.textAlign = 'left';
  }

  // -- Fleet tiles ------------------------------------------------------------

  private drawFleet(sim: ScalingSimulation, r: Rect): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.textAlign = 'left';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText('FLEET', r.x + 8, r.y + 14);

    const insts = sim.instanceViews();
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
      const x = r.x + 8 + col * cw;
      const y = gridTop + row * ch;
      let color: string;
      let a = 0.85;
      if (inst.inUse) color = inst.prewarmed ? SEMANTIC.success : loadColor(sim.demandView().utilization);
      else if (inst.ready) color = SEMANTIC.inFlight;
      else {
        // Provisioning: pulse to read as "working".
        color = SEMANTIC.tlsPulse;
        a = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(sim.now / 260 + i));
      }
      ctx.fillStyle = withAlpha(inst.inUse ? SEMANTIC.success : color, inst.inUse ? 0.85 : a);
      ctx.fillRect(x + pad, y + pad, Math.max(2, cw - 2 * pad), Math.max(2, ch - 2 * pad));
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
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.85);
    ctx.fillRect(barX, barY, barW * clamp01(served / offered), barH);
    ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.85);
    const servedW = barW * clamp01(served / offered);
    ctx.fillRect(barX + servedW, barY, barW - servedW, barH);
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
