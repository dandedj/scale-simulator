/**
 * Canvas renderer for the DNS load-distribution model — a fleet dashboard, not
 * a per-request animation. It draws: the Route53 control box (the advertised
 * record set, TTL, and the next-update countdown), a grid of client-cohort
 * tiles colored by the availability each cohort sees, the server grid (tiles
 * colored by lifecycle state + load, with boot countdowns and an advertised
 * marker), the aggregate traffic flow split into served / shed / dead-IP, and a
 * bottom outcome bar. Positions are pure functions of sim state, so pausing
 * freezes the scene exactly.
 */

import { loadColor, SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { DnsSimulation } from '../engine/dnsSimulation';
import type { DnsServerView } from '../engine/types';

const DOWN_COLOR = '#7a2a3a';
const DRAIN_COLOR = SEMANTIC.shed;

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class DnsRenderer {
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

  draw(sim: DnsSimulation): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    this.drawBackdrop(w, h);
    if (w < 220 || h < 140) return; // too small to lay out meaningfully

    const dnsH = Math.min(86, h * 0.2);
    const outcomeH = 54;
    const topY = 8;
    const mainTop = topY + dnsH + 14;
    const mainBottom = h - outcomeH - 12;
    const mainH = Math.max(40, mainBottom - mainTop);

    // Columns: clients (left) | servers (center-right) | bidders (far right).
    const clientsX = w * 0.025;
    const clientsW = w * 0.26;
    const biddersW = Math.min(80, w * 0.08);
    const biddersX = w - biddersW - w * 0.02;
    const serversX = clientsX + clientsW + w * 0.06;
    const serversW = biddersX - serversX - w * 0.04;

    const clientsRect = { x: clientsX, y: mainTop, w: clientsW, h: mainH };
    const serversRect = { x: serversX, y: mainTop, w: serversW, h: mainH };

    this.drawFlow(sim, clientsRect, serversRect);
    this.drawClients(sim, clientsRect);
    this.drawServers(sim, serversRect);
    this.drawBidders(sim, biddersX, mainTop, biddersW, mainH, serversX + serversW);
    this.drawDnsBox(sim, clientsX, topY, w - clientsX - w * 0.02, dnsH);
    this.drawOutcomeBar(sim, clientsX, h - outcomeH - 6, w - clientsX - w * 0.02, outcomeH - 6);

    if (sim.degradedActive()) this.drawDegradedFrame(sim.now);
  }

  // -- Backdrop ---------------------------------------------------------------

  private drawBackdrop(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.canvas;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = withAlpha('#3A4148', 0.16);
    for (let x = 14; x < w; x += 30) {
      for (let y = 14; y < h; y += 30) ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  // -- Route53 control box ----------------------------------------------------

  private drawDnsBox(sim: DnsSimulation, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const v = sim.dnsView();
    const border = v.failOpen ? SEMANTIC.timeout : SURFACE.border;
    this.panel(x, y, w, h, border);

    ctx.font = '700 14px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.text;
    ctx.textAlign = 'left';
    ctx.fillText('ROUTE 53 — ADVERTISED RECORD SET', x + 12, y + 19);

    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(
      `${v.advertisedCount}/${v.totalServers} IPs · healthy-known ${v.healthyKnownCount} · TTL ${(v.ttlMs / 1000).toFixed(0)}s`,
      x + 12,
      y + 36,
    );

    // Record-set strip: one cell per server in id order.
    const servers = sim.serverViews();
    const stripX = x + 12;
    const stripY = y + 44;
    const stripW = w - 24;
    const cellGap = 2;
    const cells = Math.max(1, servers.length);
    const cw = Math.max(3, Math.min(16, (stripW - (cells - 1) * cellGap) / cells));
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      const cx = stripX + i * (cw + cellGap);
      let col: string;
      if (s.inDnsRecordSet) {
        col = s.state === 'down' ? DOWN_COLOR : s.state === 'healthy' ? SEMANTIC.success : DRAIN_COLOR;
      } else if (s.healthCheckHealthy && s.state === 'healthy') {
        col = withAlpha(SEMANTIC.success, 0.3); // healthy but not yet advertised (DNS lag)
      } else {
        col = withAlpha(SURFACE.textFaint, 0.5);
      }
      ctx.fillStyle = col;
      ctx.fillRect(cx, stripY, cw, h - (stripY - y) - 8);
    }

    // Publisher-Lambda countdown + fail-open flag (right aligned).
    ctx.textAlign = 'right';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    if (v.failOpen) {
      ctx.fillStyle = SEMANTIC.timeout;
      ctx.fillText('⚠ LAMBDA FAIL-OPEN (no healthy servers → all records)', x + w - 12, y + 19);
    } else {
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(`next Lambda ${(v.msUntilUpdate / 1000).toFixed(0)}s`, x + w - 12, y + 19);
    }
    ctx.textAlign = 'left';
  }

  // -- Clients ----------------------------------------------------------------

  private drawClients(sim: DnsSimulation, r: { x: number; y: number; w: number; h: number }): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);
    ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('CLIENT COHORTS', r.x + 8, r.y + 15);

    const cohorts = sim.clientViews();
    const gridTop = r.y + 24;
    const gridH = Math.max(1, r.h - 32);
    const gridW = Math.max(1, r.w - 16);
    const n = Math.max(1, cohorts.length);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * (gridW / gridH))));
    const rows = Math.ceil(n / cols);
    const cellW = gridW / cols;
    const cellH = gridH / rows;
    const pad = Math.min(3, cellW * 0.12);
    for (let i = 0; i < cohorts.length; i++) {
      const c = cohorts[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = r.x + 8 + col * cellW;
      const cy = gridTop + row * cellH;
      const avail = c.offeredRate > 1e-6 ? c.servedRate / c.offeredRate : 1;
      const staleFrac = c.offeredRate > 1e-6 ? c.staleRate / c.offeredRate : 0;
      const tileCol = avail >= 0.999 ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
      const tx = cx + pad;
      const ty = cy + pad;
      const tw = Math.max(2, cellW - 2 * pad);
      const th = Math.max(2, cellH - 2 * pad);
      // Fill = availability the cohort experiences (served ÷ offered). Clients
      // are not health-checked — only servers are — so this is an outcome, not a
      // status.
      ctx.fillStyle = withAlpha(tileCol, 0.85);
      ctx.fillRect(tx, ty, tw, th);
      // Stale ring: this cohort still has a removed/dead IP cached and keeps
      // aiming traffic at it (wasted connects), even if RST re-picks keep it
      // served. The signature of TTL lag — lights up after a kill until the
      // cohort re-resolves (pinned cohorts never do).
      if (staleFrac > 0.01 && tw > 8 && th > 8) {
        ctx.strokeStyle = withAlpha(SEMANTIC.error, Math.min(1, 0.5 + staleFrac));
        ctx.lineWidth = 3;
        ctx.strokeRect(tx + 1.5, ty + 1.5, tw - 3, th - 3);
      }
      if (c.pinned) {
        // Pinned/JVM cohort: a small notch — it ignores TTL.
        ctx.fillStyle = withAlpha('#000000', 0.55);
        ctx.fillRect(tx, ty, Math.max(2, tw * 0.32), 3);
      }
    }
  }

  // -- Servers ----------------------------------------------------------------

  private drawServers(sim: DnsSimulation, r: { x: number; y: number; w: number; h: number }): void {
    const ctx = this.ctx;
    ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('RTB FABRIC SERVERS', r.x, r.y - 4);

    const servers = sim.serverViews();
    const n = Math.max(1, servers.length);
    const gridW = r.w;
    const gridH = r.h;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * (gridW / Math.max(1, gridH)))));
    const rows = Math.ceil(n / cols);
    const cellW = gridW / cols;
    const cellH = gridH / rows;
    const gap = Math.min(5, cellW * 0.08);
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = r.x + col * cellW + gap / 2;
      const y = r.y + row * cellH + gap / 2;
      const tw = cellW - gap;
      const th = cellH - gap;
      this.drawServerTile(s, x, y, tw, th);
    }
  }

  private drawServerTile(s: DnsServerView, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const fill = this.serverFill(s);
    ctx.fillStyle = withAlpha(fill, s.state === 'down' ? 0.5 : 0.22);
    ctx.strokeStyle = s.overloaded ? SEMANTIC.timeout : withAlpha(fill, 0.9);
    ctx.lineWidth = s.overloaded ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();

    // Advertised marker (in the Route53 set) — a dot in the corner.
    if (s.inDnsRecordSet) {
      ctx.fillStyle = SEMANTIC.success;
      ctx.beginPath();
      ctx.arc(x + w - 6, y + 6, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (w < 28 || h < 22) return; // too small for inner detail

    if (s.state === 'booting') {
      ctx.fillStyle = SEMANTIC.tlsPulse;
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('BOOT', x + w / 2, y + h / 2 - 2);
      ctx.fillText(`${s.secondsUntilHealthy.toFixed(0)}s`, x + w / 2, y + h / 2 + 9);
      ctx.textAlign = 'left';
      // Boot progress bar along the bottom.
      ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.7);
      ctx.fillRect(x + 3, y + h - 5, (w - 6) * s.bootProgress, 2.5);
      return;
    }
    if (s.state === 'down') {
      ctx.fillStyle = withAlpha('#ffffff', 0.7);
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DOWN', x + w / 2, y + h / 2 + 3);
      ctx.textAlign = 'left';
      return;
    }

    // Load gauge (bottom) — how full the server is (can exceed 100% → overflow).
    const load = clamp01(s.load);
    const gx = x + 4;
    const gw = w - 8;
    const gy = y + h - 6;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(gx, gy, gw, 4);
    ctx.fillStyle = loadColor(s.load);
    ctx.fillRect(gx, gy, gw * load, 4);
    if (s.load > 1) {
      ctx.fillStyle = withAlpha(SEMANTIC.timeout, 0.6);
      ctx.fillRect(gx, gy - 2, gw, 1.5);
    }

    ctx.textAlign = 'left';
    if (s.state === 'draining') {
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillStyle = DRAIN_COLOR;
      ctx.fillText('drain', x + 5, y + 14);
      return;
    }
    // Per-server availability = served ÷ routed-here. 100% = serving everything
    // it is handed; below 100% = shedding (the excess RSTs and re-picks
    // elsewhere). Headlines the tile so shedding servers stand out.
    const avail = serverAvailability(s);
    ctx.font = '700 12px "IBM Plex Mono", monospace';
    ctx.fillStyle = availColor(avail);
    ctx.fillText(`${Math.round(avail * 100)}%`, x + 5, y + 15);
    if (h > 42) {
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(`${Math.round(s.load * 100)}% load`, x + 5, y + 28);
    }
  }

  private serverFill(s: DnsServerView): string {
    switch (s.state) {
      case 'booting':
        return SEMANTIC.tlsPulse;
      case 'draining':
        return DRAIN_COLOR;
      case 'down':
        return DOWN_COLOR;
      case 'healthy':
        // Color by availability: green when serving all it is handed, amber/red
        // when shedding — so overloaded servers read instantly.
        return availColor(serverAvailability(s));
    }
  }

  // -- Bidders (represented only) ---------------------------------------------

  private drawBidders(
    sim: DnsSimulation,
    x: number,
    y: number,
    w: number,
    h: number,
    fromX: number,
  ): void {
    const ctx = this.ctx;
    const bidders = sim.bidderViews();
    const n = Math.max(1, bidders.length);
    const cellH = h / n;
    ctx.font = '600 10px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('BIDDERS', x, y - 4);
    for (let i = 0; i < bidders.length; i++) {
      const by = y + i * cellH + cellH * 0.2;
      const bh = cellH * 0.6;
      // Faint link from the server block.
      ctx.strokeStyle = withAlpha(SURFACE.textFaint, 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fromX, y + h / 2);
      ctx.lineTo(x, by + bh / 2);
      ctx.stroke();
      ctx.fillStyle = withAlpha(SURFACE.panelRaised, 0.7);
      ctx.strokeStyle = withAlpha(SURFACE.border, 0.7);
      ctx.beginPath();
      ctx.roundRect(x, by, w, bh, 4);
      ctx.fill();
      ctx.stroke();
    }
  }

  // -- Flow (clients → servers) -----------------------------------------------

  /**
   * The traffic the clients send to the servers, drawn as a labeled, directional
   * pipe in the gap. The pipe is a constant-width "flow" whose colored layers
   * show the outcome split (served / shed / stale→dead IP / unavailable), with
   * an arrowhead pointing at the servers — so it reads as traffic, not a box.
   */
  private drawFlow(
    sim: DnsSimulation,
    c: { x: number; y: number; w: number; h: number },
    s: { x: number; y: number; w: number; h: number },
  ): void {
    const ctx = this.ctx;
    const f = sim.flowView();
    const offered = f.offeredRate;
    const x0 = c.x + c.w + 6;
    const x1 = s.x - 4;
    if (offered <= 1e-6 || x1 - x0 < 26) return;
    const cy = (c.y + c.h / 2 + s.y + s.h / 2) / 2;
    const pipeH = Math.min(160, Math.min(c.h, s.h) * 0.4);
    const top = cy - pipeH / 2;
    const arrow = 9;
    const bodyRight = x1 - arrow;

    const layers: { rate: number; color: string }[] = [
      { rate: f.servedRate, color: SEMANTIC.success },
      { rate: f.shedRate, color: SEMANTIC.shed },
      { rate: f.staleRate, color: SEMANTIC.error },
      { rate: f.unavailableRate, color: SEMANTIC.timeout },
    ];
    let yy = top;
    for (const layer of layers) {
      const hh = (clamp01(layer.rate / offered)) * pipeH;
      if (hh < 0.4) continue;
      ctx.fillStyle = withAlpha(layer.color, 0.5);
      ctx.fillRect(x0, yy, bodyRight - x0, hh);
      yy += hh;
    }
    // Arrowhead toward the servers.
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.5);
    ctx.beginPath();
    ctx.moveTo(bodyRight, top - 3);
    ctx.lineTo(x1, cy);
    ctx.lineTo(bodyRight, top + pipeH + 3);
    ctx.closePath();
    ctx.fill();

    // Caption.
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'center';
    ctx.fillText('TRAFFIC →', (x0 + bodyRight) / 2, top - 6);
    ctx.fillText(fmtRate(offered), (x0 + bodyRight) / 2, top + pipeH + 13);
    ctx.textAlign = 'left';
  }

  // -- Outcome bar ------------------------------------------------------------

  private drawOutcomeBar(sim: DnsSimulation, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const f = sim.flowView();
    const offered = Math.max(1e-6, f.offeredRate);
    const avail = sim.availability();
    this.panel(x, y, w, h, SURFACE.border);

    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'left';
    ctx.fillText(`OFFERED ${fmtRate(offered)}`, x + 10, y + 16);
    ctx.textAlign = 'right';
    const availCol = avail >= sim.cfg.slaTarget ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
    ctx.fillStyle = availCol;
    ctx.fillText(`AVAILABILITY ${(avail * 100).toFixed(1)}%`, x + w - 10, y + 16);
    ctx.textAlign = 'left';

    const barX = x + 10;
    const barY = y + 24;
    const barW = w - 20;
    const barH = h - 32;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(barX, barY, barW, barH);
    const segs: { rate: number; color: string }[] = [
      { rate: f.servedRate, color: SEMANTIC.success },
      { rate: f.unavailableRate, color: SEMANTIC.timeout },
    ];
    let cx = barX;
    for (const sgmt of segs) {
      const segW = (clamp01(sgmt.rate / offered)) * barW;
      ctx.fillStyle = withAlpha(sgmt.color, 0.85);
      ctx.fillRect(cx, barY, segW, barH);
      cx += segW;
    }
    // SLO marker line.
    const sloX = barX + barW * sim.cfg.slaTarget;
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.5);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sloX, barY);
    ctx.lineTo(sloX, barY + barH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Frame / helpers --------------------------------------------------------

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

function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
  return `${Math.round(v)}/s`;
}

/** Per-server availability: the fraction of traffic routed here it served (the
 * rest was shed/RST and re-picked elsewhere). 1.0 when it has headroom. */
function serverAvailability(s: DnsServerView): number {
  return s.assignedRate > 1e-6 ? Math.min(1, s.servedRate / s.assignedRate) : 1;
}

/** Availability → green (serving all) → amber (shedding some) → red. */
function availColor(a: number): string {
  return a >= 0.99 ? SEMANTIC.success : a >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
}
