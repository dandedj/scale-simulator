/**
 * Canvas renderer for the DNS load-distribution model — a fleet dashboard with
 * live motion. It draws the Route53 control box (advertised record set, TTL,
 * the publisher-Lambda countdown), client-cohort tiles (per-cohort availability,
 * offered rate, TTL countdown, connection-pool state, and a stale ring when a
 * cohort still caches a dead IP), the server grid (lifecycle state + per-server
 * availability + load), the animated traffic flow, and a bottom outcome bar.
 *
 * Motion keeps the board from reading as static: the traffic pipe flows, cohort
 * tiles flash on each DNS re-resolution, overloaded servers pulse, and the
 * control box flashes when the Lambda republishes. After a kill, red links run
 * from every cohort still caching the dead server to that server's tile.
 *
 * Hovering a cohort tile opens a detail tooltip (pool membership + per-server
 * health, stats, and the TTL countdown).
 */

import { loadColor, SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { DnsSimulation } from '../engine/dnsSimulation';
import type { DnsClientView, DnsServerView, ServerState } from '../engine/types';

const DOWN_COLOR = '#7a2a3a';
const DRAIN_COLOR = SEMANTIC.shed;
/** Re-resolution flash duration (sim ms) — long enough to see at high speed-up. */
const RESOLVE_FLASH_MS = 2500;
/** Lambda-republish flash duration (sim ms). */
const LAMBDA_FLASH_MS = 2500;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class DnsRenderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private canvas: HTMLCanvasElement;
  private mouseX = -1;
  private mouseY = -1;
  /** Cohort tile rects from the last frame, for hover hit-testing. */
  private cohortRects: Rect[] = [];
  private cohortViews: DnsClientView[] = [];
  /** Server tile centers by id, for stale links + tooltip. */
  private serverRectById = new Map<number, Rect>();
  /** Tracks the advertised set to flash the box when the Lambda republishes. */
  private prevAdvKey = '';
  private lambdaFlashAt = -1e9;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
    });
    canvas.addEventListener('mouseleave', () => {
      this.mouseX = -1;
      this.mouseY = -1;
    });
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

  reset(): void {
    this.prevAdvKey = '';
    this.lambdaFlashAt = -1e9;
  }

  draw(sim: DnsSimulation): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    const now = sim.now;
    ctx.clearRect(0, 0, w, h);
    this.drawBackdrop(w, h);
    if (w < 220 || h < 140) return;

    const dnsH = Math.min(86, h * 0.2);
    const topY = 8;
    const outcomeH = 54;
    const mainTop = topY + dnsH + 14;
    const mainBottom = h - outcomeH - 12;
    const mainH = Math.max(40, mainBottom - mainTop);

    const clientsX = w * 0.025;
    const clientsW = w * 0.26;
    const biddersW = Math.min(80, w * 0.08);
    const biddersX = w - biddersW - w * 0.02;
    const serversX = clientsX + clientsW + w * 0.06;
    const serversW = biddersX - serversX - w * 0.04;

    const clientsRect: Rect = box(clientsX, mainTop, clientsW, mainH);
    const serversRect: Rect = box(serversX, mainTop, serversW, mainH);

    const serverViews = sim.serverViews();
    const cohortViews = sim.clientViews();
    this.cohortViews = cohortViews;

    // Geometry (shared by tiles, stale links, and hover).
    const serverInner = box(serversRect.x, serversRect.y, serversRect.w, serversRect.h);
    const serverRects = gridRects(serverInner, serverViews.length);
    this.serverRectById.clear();
    serverViews.forEach((s, i) => this.serverRectById.set(s.id, serverRects[i]));
    const cohortInner = box(clientsRect.x + 8, clientsRect.y + 28, clientsRect.w - 16, clientsRect.h - 36);
    this.cohortRects = gridRects(cohortInner, cohortViews.length);

    this.drawFlow(sim, clientsRect, serversRect);
    this.drawStaleLinks(cohortViews, serverViews, now);
    this.drawClients(sim, clientsRect, cohortViews, now);
    this.drawServers(serverViews, serverRects, now);
    this.drawBidders(sim, biddersX, mainTop, biddersW, mainH, serversX + serversW);
    this.drawDnsBox(sim, clientsX, topY, w - clientsX - w * 0.02, dnsH);
    this.drawOutcomeBar(sim, clientsX, h - outcomeH - 6, w - clientsX - w * 0.02, outcomeH - 6);

    this.drawHoverTooltip(serverViews, now);

    if (sim.degradedActive()) this.drawDegradedFrame(now);
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
    const now = sim.now;

    // Detect a republish (advertised set changed) → flash.
    const key = v.advertised.join(',');
    if (key !== this.prevAdvKey) {
      if (this.prevAdvKey !== '') this.lambdaFlashAt = now;
      this.prevAdvKey = key;
    }
    const flash = clamp01(1 - (now - this.lambdaFlashAt) / LAMBDA_FLASH_MS);
    const border = v.failOpen
      ? SEMANTIC.timeout
      : flash > 0
        ? withAlpha(SEMANTIC.tlsPulse, 0.4 + 0.6 * flash)
        : SURFACE.border;
    this.panel(x, y, w, h, border);

    ctx.font = '700 14px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.text;
    ctx.textAlign = 'left';
    ctx.fillText('ROUTE 53 — ADVERTISED RECORD SET (RTB Fabric Lambda)', x + 12, y + 19);

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
        col = withAlpha(SEMANTIC.success, 0.3);
      } else {
        col = withAlpha(SURFACE.textFaint, 0.5);
      }
      ctx.fillStyle = col;
      ctx.fillRect(cx, stripY, cw, h - (stripY - y) - 8);
    }

    // Publisher-Lambda countdown + fail-open flag (right aligned, with a bar).
    ctx.textAlign = 'right';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    if (v.failOpen) {
      ctx.fillStyle = SEMANTIC.timeout;
      ctx.fillText('⚠ LAMBDA FAIL-OPEN (no healthy servers → all records)', x + w - 12, y + 19);
    } else {
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(`next Lambda ${Math.ceil(v.msUntilUpdate / 1000)}s`, x + w - 12, y + 19);
      // Countdown bar shrinking toward the next run.
      const frac = clamp01(v.msUntilUpdate / Math.max(1, v.updateIntervalMs));
      const bw = 90;
      const bx = x + w - 12 - bw;
      ctx.fillStyle = SURFACE.panelRaised;
      ctx.fillRect(bx, y + 26, bw, 4);
      ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.8);
      ctx.fillRect(bx, y + 26, bw * frac, 4);
    }
    ctx.textAlign = 'left';
  }

  // -- Clients ----------------------------------------------------------------

  private drawClients(sim: DnsSimulation, r: Rect, cohorts: DnsClientView[], now: number): void {
    const ctx = this.ctx;
    this.panel(r.x, r.y, r.w, r.h, SURFACE.border);

    // Aggregate client stats in the header.
    let off = 0;
    let srv = 0;
    let stale = 0;
    for (const c of cohorts) {
      off += c.offeredRate;
      srv += c.servedRate;
      if (c.staleIds.length) stale++;
    }
    const aggAvail = off > 1e-6 ? srv / off : 1;
    ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('CLIENT COHORTS', r.x + 8, r.y + 15);
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = availColor(aggAvail);
    ctx.fillText(`${(aggAvail * 100).toFixed(1)}% avail`, r.x + r.w - 8, r.y + 15);
    if (stale > 0) {
      ctx.fillStyle = SEMANTIC.error;
      ctx.fillText(`· ${stale} stale`, r.x + r.w - 8, r.y + 27);
    }
    ctx.textAlign = 'left';

    cohorts.forEach((c, i) => {
      const rect = this.cohortRects[i];
      if (!rect) return;
      this.drawClientTile(c, rect, sim, now, i === this.hoveredIndex());
    });
  }

  private drawClientTile(c: DnsClientView, rect: Rect, sim: DnsSimulation, now: number, hovered: boolean): void {
    const ctx = this.ctx;
    const pad = Math.min(3, rect.w * 0.06);
    const x = rect.x + pad;
    const y = rect.y + pad;
    const w = Math.max(3, rect.w - 2 * pad);
    const h = Math.max(3, rect.h - 2 * pad);
    const avail = c.offeredRate > 1e-6 ? c.servedRate / c.offeredRate : 1;
    const stale = c.staleIds.length > 0;
    const col = availColor(avail);
    const showStats = w >= 58 && h >= 44;

    // Fill: subtle when there is room for text, solid heatmap when tiny.
    ctx.fillStyle = withAlpha(col, showStats ? 0.18 : 0.85);
    roundRectPath(ctx, x, y, w, h, 4);
    ctx.fill();
    // Border: stale ring (yellow) dominates, else availability.
    ctx.strokeStyle = stale ? withAlpha(SEMANTIC.error, 0.95) : hovered ? SURFACE.text : withAlpha(col, 0.85);
    ctx.lineWidth = stale ? 2.5 : hovered ? 1.6 : 1;
    roundRectPath(ctx, x, y, w, h, 4);
    ctx.stroke();

    // Re-resolution flash: an expanding ring when the cohort just re-resolved.
    const sinceResolve = now - c.lastResolvedAt;
    if (sinceResolve >= 0 && sinceResolve < RESOLVE_FLASH_MS) {
      const a = 1 - sinceResolve / RESOLVE_FLASH_MS;
      ctx.strokeStyle = withAlpha(SEMANTIC.tlsPulse, a * 0.9);
      ctx.lineWidth = 1.5;
      const grow = (1 - a) * 4;
      roundRectPath(ctx, x - grow, y - grow, w + 2 * grow, h + 2 * grow, 5);
      ctx.stroke();
    }

    if (showStats) {
      ctx.textAlign = 'left';
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = c.kind === 'eks' ? SEMANTIC.tlsPulse : SURFACE.textDim;
      ctx.fillText(c.kind === 'eks' ? `C${c.id} ⎈EKS` : `C${c.id}`, x + 5, y + 12);
      // Availability headline.
      ctx.font = '700 16px "IBM Plex Mono", monospace';
      ctx.fillStyle = col;
      ctx.fillText(`${Math.round(avail * 100)}%`, x + 5, y + 30);
      // Offered rate + TTL countdown (EKS shows its shared CoreDNS-cache clock).
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(fmtRate(c.offeredRate), x + 5, y + h - 16);
      if (c.pinned) {
        ctx.fillStyle = SEMANTIC.retry;
        ctx.fillText('📌 pinned', x + 5, y + h - 5);
      } else if (c.kind === 'eks') {
        ctx.fillStyle = stale ? SEMANTIC.error : SEMANTIC.tlsPulse;
        ctx.fillText(`⎈ ${Math.ceil(c.msUntilReResolve / 1000)}s`, x + 5, y + h - 5);
      } else {
        ctx.fillStyle = stale ? SEMANTIC.error : SURFACE.textDim;
        ctx.fillText(`↻ ${Math.ceil(c.msUntilReResolve / 1000)}s`, x + 5, y + h - 5);
      }
      // Connection-pool strip (top-right): one dot per cached IP, by health.
      this.drawPoolStrip(c, sim, x + w - 5, y + 8, w * 0.5);
    } else {
      if (c.kind === 'eks') {
        ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.9);
        ctx.fillRect(x + w - Math.max(2, w * 0.32), y, Math.max(2, w * 0.32), 3);
      }
      if (c.pinned) {
        ctx.fillStyle = withAlpha('#000000', 0.55);
        ctx.fillRect(x, y, Math.max(2, w * 0.32), 3);
      }
    }
  }

  /** A compact right-aligned row of pool dots: cached IPs colored by server health. */
  private drawPoolStrip(c: DnsClientView, sim: DnsSimulation, rightX: number, y: number, maxW: number): void {
    const ctx = this.ctx;
    const stateById = this.serverStateById(sim);
    const n = c.cachedSet.length;
    if (n === 0) return;
    const r = 1.7;
    const gap = Math.max(1.5, Math.min(4, maxW / n));
    const shown = Math.min(n, Math.floor(maxW / gap));
    for (let i = 0; i < shown; i++) {
      const id = c.cachedSet[i];
      const st = stateById.get(id);
      const dead = st === undefined || st === 'down';
      ctx.fillStyle = dead ? SEMANTIC.error : st === 'healthy' ? SEMANTIC.success : DRAIN_COLOR;
      ctx.beginPath();
      ctx.arc(rightX - i * gap, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -- Stale links (cohort → the dead server it still caches) -----------------

  private drawStaleLinks(cohorts: DnsClientView[], _servers: DnsServerView[], now: number): void {
    const ctx = this.ctx;
    const pulse = 0.45 + 0.35 * Math.sin(now / 500);
    let drawn = 0;
    for (let i = 0; i < cohorts.length; i++) {
      const c = cohorts[i];
      if (c.staleIds.length === 0) continue;
      const cr = this.cohortRects[i];
      if (!cr) continue;
      for (const id of c.staleIds) {
        const sr = this.serverRectById.get(id);
        if (!sr) continue;
        if (drawn++ > 240) break;
        ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.12 + 0.18 * pulse);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cr.cx, cr.cy);
        ctx.lineTo(sr.cx, sr.cy);
        ctx.stroke();
      }
    }
  }

  // -- Servers ----------------------------------------------------------------

  private drawServers(servers: DnsServerView[], rects: Rect[], now: number): void {
    const ctx = this.ctx;
    ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    if (rects[0]) ctx.fillText('RTB FABRIC SERVERS', rects[0].x, rects[0].y - 6);
    servers.forEach((s, i) => {
      const r = rects[i];
      if (r) this.drawServerTile(s, r, now);
    });
  }

  private drawServerTile(s: DnsServerView, rect: Rect, now: number): void {
    const ctx = this.ctx;
    const gap = Math.min(5, rect.w * 0.08);
    const x = rect.x + gap / 2;
    const y = rect.y + gap / 2;
    const w = rect.w - gap;
    const h = rect.h - gap;
    const fill = this.serverFill(s);
    ctx.fillStyle = withAlpha(fill, s.state === 'down' ? 0.5 : 0.22);
    // Overloaded + down servers pulse so they draw the eye.
    let border = withAlpha(fill, 0.9);
    let lw = 1;
    if (s.overloaded) {
      const p = 0.5 + 0.5 * Math.sin(now / 240);
      border = withAlpha(SEMANTIC.timeout, 0.5 + 0.5 * p);
      lw = 2;
    } else if (s.state === 'down') {
      const p = 0.5 + 0.5 * Math.sin(now / 320);
      border = withAlpha(SEMANTIC.timeout, 0.35 + 0.4 * p);
      lw = 1.5;
    }
    ctx.strokeStyle = border;
    ctx.lineWidth = lw;
    roundRectPath(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();

    if (s.inDnsRecordSet) {
      ctx.fillStyle = SEMANTIC.success;
      ctx.beginPath();
      ctx.arc(x + w - 6, y + 6, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (w < 28 || h < 22) return;

    if (s.state === 'booting') {
      const p = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now / 260));
      ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, p);
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('BOOT', x + w / 2, y + h / 2 - 2);
      ctx.fillText(`${s.secondsUntilHealthy.toFixed(0)}s`, x + w / 2, y + h / 2 + 9);
      ctx.textAlign = 'left';
      ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.7);
      ctx.fillRect(x + 3, y + h - 5, (w - 6) * s.bootProgress, 2.5);
      return;
    }

    // Load gauge (bottom).
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
    if (s.state === 'down') {
      ctx.fillStyle = withAlpha('#ffffff', 0.7);
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DOWN', x + w / 2, y + h / 2 + 3);
      ctx.textAlign = 'left';
      return;
    }
    if (s.state === 'draining') {
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillStyle = DRAIN_COLOR;
      ctx.fillText('drain', x + 5, y + 14);
      return;
    }
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
        return availColor(serverAvailability(s));
    }
  }

  // -- Bidders (represented only) ---------------------------------------------

  private drawBidders(sim: DnsSimulation, x: number, y: number, w: number, h: number, fromX: number): void {
    const ctx = this.ctx;
    const bidders = sim.bidderViews();
    const n = Math.max(1, bidders.length);
    const cellH = h / n;
    ctx.font = '600 10px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('BIDDERS', x, y - 6);
    for (let i = 0; i < bidders.length; i++) {
      const by = y + i * cellH + cellH * 0.2;
      const bh = cellH * 0.6;
      ctx.strokeStyle = withAlpha(SURFACE.textFaint, 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fromX, y + h / 2);
      ctx.lineTo(x, by + bh / 2);
      ctx.stroke();
      ctx.fillStyle = withAlpha(SURFACE.panelRaised, 0.7);
      ctx.strokeStyle = withAlpha(SURFACE.border, 0.7);
      roundRectPath(ctx, x, by, w, bh, 4);
      ctx.fill();
      ctx.stroke();
    }
  }

  // -- Flow (clients → servers) -----------------------------------------------

  private drawFlow(sim: DnsSimulation, c: Rect, s: Rect): void {
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
      const hh = clamp01(layer.rate / offered) * pipeH;
      if (hh < 0.4) continue;
      ctx.fillStyle = withAlpha(layer.color, 0.45);
      ctx.fillRect(x0, yy, bodyRight - x0, hh);
      yy += hh;
    }

    // Flowing stripes (a conveyor) so the pipe reads as moving traffic.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, top, bodyRight - x0, pipeH);
    ctx.clip();
    const spacing = 26;
    const phase = (sim.now * 0.06) % spacing;
    ctx.strokeStyle = withAlpha('#ffffff', 0.08);
    ctx.lineWidth = 7;
    for (let sx = x0 - spacing + phase; sx < bodyRight + pipeH; sx += spacing) {
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.lineTo(sx - pipeH, top + pipeH);
      ctx.stroke();
    }
    ctx.restore();

    // Arrowhead toward the servers.
    ctx.fillStyle = withAlpha(SEMANTIC.success, 0.5);
    ctx.beginPath();
    ctx.moveTo(bodyRight, top - 3);
    ctx.lineTo(x1, cy);
    ctx.lineTo(bodyRight, top + pipeH + 3);
    ctx.closePath();
    ctx.fill();

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
    ctx.fillStyle = avail >= sim.cfg.slaTarget ? SEMANTIC.success : avail >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
    ctx.fillText(`AVAILABILITY ${(avail * 100).toFixed(1)}%`, x + w - 10, y + 16);
    ctx.textAlign = 'left';

    const barX = x + 10;
    const barY = y + 24;
    const barW = w - 20;
    const barH = h - 32;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(barX, barY, barW, barH);
    let cx = barX;
    for (const seg of [
      { rate: f.servedRate, color: SEMANTIC.success },
      { rate: f.unavailableRate, color: SEMANTIC.timeout },
    ]) {
      const segW = clamp01(seg.rate / offered) * barW;
      ctx.fillStyle = withAlpha(seg.color, 0.85);
      ctx.fillRect(cx, barY, segW, barH);
      cx += segW;
    }
    const sloX = barX + barW * sim.cfg.slaTarget;
    ctx.strokeStyle = withAlpha(SURFACE.text, 0.5);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sloX, barY);
    ctx.lineTo(sloX, barY + barH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- Hover tooltip ----------------------------------------------------------

  private hoveredIndex(): number {
    if (this.mouseX < 0) return -1;
    for (let i = 0; i < this.cohortRects.length; i++) {
      const r = this.cohortRects[i];
      if (this.mouseX >= r.x && this.mouseX <= r.x + r.w && this.mouseY >= r.y && this.mouseY <= r.y + r.h) return i;
    }
    return -1;
  }

  private drawHoverTooltip(servers: DnsServerView[], _now: number): void {
    const i = this.hoveredIndex();
    if (i < 0) return;
    const c = this.cohortViews[i];
    if (!c) return;
    const ctx = this.ctx;
    const stateById = new Map(servers.map((s) => [s.id, s.state] as const));
    const avail = c.offeredRate > 1e-6 ? c.servedRate / c.offeredRate : 1;
    const healthy = c.cachedSet.filter((id) => stateById.get(id) === 'healthy').length;
    const dead = c.staleIds.length;

    const kindLabel = c.kind === 'eks' ? '  ·  EKS / CoreDNS' : c.pinned ? '  ·  PINNED (ignores TTL)' : '  ·  direct';
    const lines: { text: string; color: string }[] = [
      { text: `Client cohort C${c.id}${kindLabel}`, color: SURFACE.text },
      { text: `availability  ${(avail * 100).toFixed(1)}%`, color: availColor(avail) },
      { text: `offered ${fmtRate(c.offeredRate)}  ·  served ${fmtRate(c.servedRate)}`, color: SURFACE.textDim },
    ];
    if (c.staleRate > 1e-6) lines.push({ text: `stale ${fmtRate(c.staleRate)} → dead IPs`, color: SEMANTIC.error });
    if (c.unavailableRate > 1e-6) lines.push({ text: `unavailable ${fmtRate(c.unavailableRate)}`, color: SEMANTIC.timeout });
    if (c.pinned) {
      lines.push({ text: 'pinned — never re-resolves', color: SURFACE.textDim });
    } else if (c.kind === 'eks') {
      lines.push({
        text: `CoreDNS cache ${Math.round(c.effectiveTtlMs / 1000)}s · re-resolve in ${Math.ceil(c.msUntilReResolve / 1000)}s`,
        color: SEMANTIC.tlsPulse,
      });
    } else {
      lines.push({ text: `re-resolve (TTL) in ${Math.ceil(c.msUntilReResolve / 1000)}s`, color: SURFACE.textDim });
    }
    const poolLabel = c.kind === 'eks' ? 'CoreDNS pool (shared by pods)' : 'connection pool';
    lines.push({ text: `${poolLabel}: ${c.cachedSet.length} IPs · ${healthy} up · ${dead} dead`, color: SURFACE.text });

    ctx.font = '500 11px "IBM Plex Mono", monospace';
    let tw = 0;
    for (const l of lines) tw = Math.max(tw, ctx.measureText(l.text).width);
    const dotsRows = Math.ceil(c.cachedSet.length / 16);
    const padX = 10;
    const lineH = 15;
    const boxW = Math.min(this.cssW - 16, Math.max(190, tw + 2 * padX));
    const boxH = 10 + lines.length * lineH + dotsRows * 9 + 8;
    let bx = this.mouseX + 14;
    let by = this.mouseY + 12;
    if (bx + boxW > this.cssW - 6) bx = this.mouseX - boxW - 14;
    if (by + boxH > this.cssH - 6) by = this.cssH - boxH - 6;
    if (bx < 6) bx = 6;
    if (by < 6) by = 6;

    ctx.fillStyle = withAlpha('#0b0c0f', 0.96);
    ctx.strokeStyle = SURFACE.border;
    ctx.lineWidth = 1;
    roundRectPath(ctx, bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    let ty = by + 18;
    for (const l of lines) {
      ctx.font = l === lines[0] ? '700 11px "IBM Plex Mono", monospace' : '500 11px "IBM Plex Mono", monospace';
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, bx + padX, ty);
      ty += lineH;
    }
    // Pool dots: one per cached IP, colored by the target server's health.
    ty += 2;
    let dx = bx + padX;
    let col = 0;
    for (const id of c.cachedSet) {
      const st = stateById.get(id);
      const isDead = st === undefined || st === 'down';
      ctx.fillStyle = isDead ? SEMANTIC.error : st === 'healthy' ? SEMANTIC.success : DRAIN_COLOR;
      ctx.beginPath();
      ctx.arc(dx + 3, ty, 2.4, 0, Math.PI * 2);
      ctx.fill();
      dx += 9;
      if (++col >= 16) {
        col = 0;
        dx = bx + padX;
        ty += 9;
      }
    }
  }

  private serverStateById(sim: DnsSimulation): Map<number, ServerState> {
    const m = new Map<number, ServerState>();
    for (const s of sim.serverViews()) m.set(s.id, s.state);
    return m;
  }

  // -- Frame / helpers --------------------------------------------------------

  private drawDegradedFrame(now: number): void {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.25 + 0.35 * pulse);
    ctx.lineWidth = 3;
    roundRectPath(ctx, 3, 3, this.cssW - 6, this.cssH - 6, 10);
    ctx.stroke();
  }

  private panel(x: number, y: number, w: number, h: number, border: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.panel;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.stroke();
  }
}

function box(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** Lay out n cells in a grid that fills `area`, aspect-balanced. */
function gridRects(area: Rect, n: number): Rect[] {
  const count = Math.max(1, n);
  const gridW = Math.max(1, area.w);
  const gridH = Math.max(1, area.h);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (gridW / gridH))));
  const rows = Math.ceil(count / cols);
  const cellW = gridW / cols;
  const cellH = gridH / rows;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    rects.push(box(area.x + col * cellW, area.y + row * cellH, cellW, cellH));
  }
  return rects;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
  return `${Math.round(v)}/s`;
}

/** Per-server availability: fraction of traffic routed here it served. */
function serverAvailability(s: DnsServerView): number {
  return s.assignedRate > 1e-6 ? Math.min(1, s.servedRate / s.assignedRate) : 1;
}

/** Availability → green (serving all) → amber (shedding some) → red. */
function availColor(a: number): string {
  return a >= 0.99 ? SEMANTIC.success : a >= 0.9 ? SEMANTIC.shed : SEMANTIC.timeout;
}
