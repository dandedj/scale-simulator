/**
 * Canvas scene renderer. Reads simulation state every frame and draws the
 * topology: client nodes, the RTB Fabric with its internal gauges (TLS
 * airlock, CPU, queues), downstream nodes, connection lanes, and request
 * particles whose positions are pure functions of sim time — so pausing the
 * clock freezes the scene exactly, and stepping renders exact mid-flight
 * positions.
 */

import {
  NET_FABRIC_DS_MS,
  Simulation,
  type ConnSim,
  type RequestSim,
} from '../engine/simulation';
import { loadColor, SEMANTIC, SURFACE, withAlpha } from './colors';
import { clamp01, clientLane, computeLayout, dsLane, lerp, type SceneLayout } from './layout';

const FATE_LINGER_MS = 250;

type MoteKind = 'timeout' | 'rejected' | 'error' | 'shedTls' | 'shedConn';

interface GraveMote {
  x: number;
  y0: number;
  y1: number;
  bornAt: number; // sim time
  kind: MoteKind;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private seenFates = new Map<number, number>(); // request id → fateTime handled
  private graveyard: GraveMote[] = [];
  private graveSeq = 0;
  private seenShedTls = 0;
  private seenShedConn = 0;
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

  /** Reset per-run renderer state (graveyard, fate tracking). */
  reset(): void {
    this.seenFates.clear();
    this.graveyard = [];
    this.graveSeq = 0;
    this.seenShedTls = 0;
    this.seenShedConn = 0;
  }

  draw(sim: Simulation): void {
    const ctx = this.ctx;
    const now = sim.now;
    const layout = computeLayout(sim, this.cssW, this.cssH);

    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.drawBackdrop(layout);
    this.drawLanes(sim, layout);
    this.drawClients(sim, layout);
    this.drawFabric(sim, layout);
    this.drawDownstreams(sim, layout);
    this.drawQueues(sim, layout);
    this.collectFates(sim, layout);
    this.drawParticles(sim, layout);
    this.drawGraveyard(layout, now);
    if (sim.stormActive()) this.drawStormFrame(now);
    if (sim.pulseFactor > 1) this.drawPulseChip(sim, layout);
  }

  // -- Backdrop ----------------------------------------------------------------

  private drawBackdrop(l: SceneLayout): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.canvas;
    ctx.fillRect(0, 0, l.width, l.height);
    ctx.fillStyle = withAlpha('#3A4148', 0.18);
    for (let x = 14; x < l.width; x += 28) {
      for (let y = 14; y < l.height; y += 28) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }
    // Zone captions
    ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.textFaint;
    ctx.textAlign = 'left';
    ctx.fillText('CLIENTS', l.clients[0]?.x ?? 20, 18);
    ctx.textAlign = 'right';
    ctx.fillText('DOWNSTREAMS', (l.downstreams[0]?.x ?? l.width - 20) + (l.downstreams[0]?.w ?? 0), 18);
    ctx.textAlign = 'left';
  }

  // -- Lanes ---------------------------------------------------------------------

  private laneStyle(conn: ConnSim, now: number): { color: string; width: number; dash: number[] } {
    switch (conn.state) {
      case 'idle':
        return { color: withAlpha(SEMANTIC.idle, 0.9), width: 1.4, dash: [] };
      case 'busy':
        return { color: SEMANTIC.connEstablished, width: 2.4, dash: [] };
      case 'handshaking':
        return { color: SEMANTIC.tlsPulse, width: 2, dash: [6, 5] };
      case 'connecting':
        return { color: withAlpha(SEMANTIC.tlsPulse, 0.4), width: 1.4, dash: [3, 6] };
      case 'closing': {
        const age = clamp01((now - conn.stateSince) / 150);
        return { color: withAlpha(SEMANTIC.timeout, 0.85 * (1 - age)), width: 2, dash: [] };
      }
    }
  }

  private drawLanes(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    const now = sim.now;
    for (let ci = 0; ci < sim.clients.length; ci++) {
      const client = sim.clients[ci];
      const n = client.conns.length;
      for (let li = 0; li < n; li++) {
        const conn = client.conns[li];
        const lane = clientLane(l, ci, li, n);
        const s = this.laneStyle(conn, now);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.setLineDash(s.dash);
        // TLS dash crawls toward the fabric while handshaking
        ctx.lineDashOffset = conn.state === 'handshaking' || conn.state === 'connecting' ? -(now / 24) % 11 : 0;
        ctx.beginPath();
        ctx.moveTo(lane.x0, lane.y0);
        ctx.lineTo(lane.x1, lane.y1);
        ctx.stroke();
        if (conn.state === 'handshaking') this.drawHandshakeRing(lane.x1, lane.y1, now, conn.stateSince);
      }
    }
    for (let di = 0; di < sim.downstreams.length; di++) {
      const ds = sim.downstreams[di];
      const n = ds.conns.length;
      for (let li = 0; li < n; li++) {
        const conn = ds.conns[li];
        const lane = dsLane(l, di, li, n);
        const s = this.laneStyle(conn, now);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.setLineDash(s.dash);
        ctx.lineDashOffset = conn.state === 'handshaking' ? -(now / 24) % 11 : 0;
        ctx.beginPath();
        ctx.moveTo(lane.x0, lane.y0);
        ctx.lineTo(lane.x1, lane.y1);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  /** The TLS ritual: expanding double ring at the fabric port. */
  private drawHandshakeRing(x: number, y: number, now: number, since: number): void {
    const ctx = this.ctx;
    // The caller is mid-lane-drawing with an animated dash; rings are solid.
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    const phase = ((now - since) / 320) % 1;
    for (const offset of [0, 0.5]) {
      const p = (phase + offset) % 1;
      ctx.strokeStyle = withAlpha(SEMANTIC.tlsPulse, 0.7 * (1 - p));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3 + p * 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // -- Nodes -----------------------------------------------------------------------

  private panel(x: number, y: number, w: number, h: number, borderColor: string = SURFACE.border): void {
    const ctx = this.ctx;
    ctx.fillStyle = SURFACE.panel;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fill();
    ctx.stroke();
  }

  private drawClients(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    for (let i = 0; i < sim.clients.length; i++) {
      const client = sim.clients[i];
      const b = l.clients[i];
      if (!b) continue;
      const hot = client.waiting.length > 2 || client.pendingRetries > 2;
      this.panel(b.x, b.y, b.w, b.h, hot ? withAlpha(SEMANTIC.retry, 0.7) : SURFACE.border);

      ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
      ctx.fillStyle = SURFACE.text;
      ctx.fillText(`CLIENT ${i + 1}`, b.x + 9, b.y + 16);

      // Pool gauge: one dot per pool slot
      const pool = sim.cfg.clients.poolSize;
      const shown = Math.min(pool, 16);
      const dotGap = Math.min(11, (b.w - 18) / shown);
      for (let s = 0; s < shown; s++) {
        const conn = client.conns[s];
        const x = b.x + 12 + s * dotGap;
        const y = b.y + b.h - 13;
        if (!conn) {
          ctx.strokeStyle = withAlpha(SURFACE.textFaint, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = this.laneStyle(conn, sim.now).color;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Waiting + retry badges
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      let bx = b.x + b.w - 8;
      if (sim.cfg.clients.circuitBreakerEnabled) {
        const cbx = bx - 4;
        const cby = b.y + 13;
        if (client.breaker === 'closed') {
          ctx.fillStyle = SEMANTIC.success;
          ctx.beginPath();
          ctx.arc(cbx, cby, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (client.breaker === 'open') {
          const frac = clamp01((sim.now - client.breakerSince) / sim.cfg.clients.breakerCooldownMs);
          ctx.strokeStyle = SEMANTIC.shed;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cbx, cby, 4.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.strokeStyle = SEMANTIC.shed;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cbx, cby, 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        bx -= 14;
      }
      if (client.pendingRetries > 0) {
        const label = `↻${client.pendingRetries}`;
        ctx.fillStyle = SEMANTIC.retry;
        ctx.textAlign = 'right';
        ctx.fillText(label, bx, b.y + 16);
        bx -= ctx.measureText(label).width + 8;
      }
      if (client.waiting.length > 0) {
        ctx.fillStyle = SEMANTIC.shed;
        ctx.textAlign = 'right';
        ctx.fillText(`⌛${client.waiting.length}`, bx, b.y + 16);
      }
      ctx.textAlign = 'left';
    }
  }

  private drawFabric(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    const f = l.fabric;
    const view = sim.fabricView();
    const cpu = view.cpuUtilization;
    this.panel(f.x, f.y, f.w, f.h, cpu >= 1 ? SEMANTIC.cpuBad : SURFACE.border);

    ctx.font = '700 17px "Big Shoulders", "Arial Narrow", sans-serif';
    ctx.fillStyle = SURFACE.text;
    ctx.fillText('RTB FABRIC', f.x + 12, f.y + 22);

    // Connection gauge across the top — the storm telltale.
    const connRatio = clamp01(view.connectionCount / view.maxConnections);
    const gx = f.x + 12;
    const gw = f.w - 24;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(gx, f.y + 30, gw, 7);
    ctx.fillStyle = loadColor(connRatio);
    ctx.fillRect(gx, f.y + 30, gw * connRatio, 7);
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`conns ${view.connectionCount}/${view.maxConnections}`, gx, f.y + 50);
    if (view.permitWaiting > 0) {
      ctx.fillStyle = SEMANTIC.shed;
      ctx.textAlign = 'right';
      ctx.fillText(`+${view.permitWaiting} permit wait`, gx + gw, f.y + 50);
      ctx.textAlign = 'left';
    }

    // TLS airlock — vertical slot strip on the left edge. The slot count
    // adapts to the box height so compact (comparison-mode) panes stay legible.
    const slotCap = Math.max(3, Math.min(12, Math.floor((f.h - 130) / 10)));
    const slots = Math.min(sim.cfg.fabric.tlsHandshakeConcurrency, slotCap);
    const slotTop = f.y + 70;
    const slotH = (f.h - 130) / Math.max(1, slots);
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SEMANTIC.tlsPulse;
    ctx.fillText(`TLS ${view.handshakesActive}/${sim.cfg.fabric.tlsHandshakeConcurrency}`, f.x + 10, f.y + 66);
    for (let s = 0; s < slots; s++) {
      const y = slotTop + s * slotH + slotH / 2;
      const active = s < Math.min(view.handshakesActive, slots);
      if (active) {
        const p = ((sim.now / 300) + s * 0.37) % 1;
        ctx.strokeStyle = withAlpha(SEMANTIC.tlsPulse, 0.9 - 0.6 * p);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(f.x + 18, y, 3 + p * 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = SEMANTIC.tlsPulse;
        ctx.beginPath();
        ctx.arc(f.x + 18, y, 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = withAlpha(SURFACE.textFaint, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(f.x + 18, y, 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (sim.cfg.fabric.tlsHandshakeConcurrency > slots && view.handshakesActive > slots) {
      ctx.fillStyle = SEMANTIC.tlsPulse;
      ctx.fillText(`+${view.handshakesActive - slots}`, f.x + 10, slotTop + slots * slotH + 12);
    }

    // CPU column in the middle.
    const cpuX = f.x + f.w / 2 - 13;
    const cpuTop = f.y + 78;
    const cpuH = f.h - 150;
    ctx.fillStyle = SURFACE.panelRaised;
    ctx.fillRect(cpuX, cpuTop, 26, cpuH);
    const fill = clamp01(cpu);
    ctx.fillStyle = withAlpha(loadColor(cpu), 0.9);
    ctx.fillRect(cpuX, cpuTop + cpuH * (1 - fill), 26, cpuH * fill);
    if (cpu > 1) {
      // Demand beyond capacity: overflow hatching above the bar.
      const over = Math.min(1, cpu - 1);
      ctx.fillStyle = withAlpha(SEMANTIC.cpuBad, 0.45);
      ctx.fillRect(cpuX - 4, cpuTop - 8 - over * 14, 34, 6 + over * 14);
    }
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'center';
    ctx.fillText('CPU', cpuX + 13, cpuTop - 14);
    ctx.fillStyle = cpu >= 1 ? SEMANTIC.cpuBad : SURFACE.text;
    ctx.fillText(`${Math.round(cpu * 100)}%`, cpuX + 13, cpuTop + cpuH + 14);
    if (view.slowdownFactor > 1.05) {
      ctx.fillStyle = SEMANTIC.cpuBad;
      ctx.fillText(`×${view.slowdownFactor.toFixed(1)} slow`, cpuX + 13, cpuTop + cpuH + 27);
    }
    ctx.textAlign = 'left';

    // Footer: in-flight, lifetime shed counters, pacing chip.
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = SURFACE.textDim;
    ctx.fillText(`in-flight ${view.inFlight}`, f.x + 12, f.y + f.h - 12);
    const t = sim.metrics.totals;
    if (t.shedTls + t.shedConnLimit > 0) {
      ctx.fillStyle = SEMANTIC.shed;
      ctx.fillText(`shed tls ${t.shedTls} · conn ${t.shedConnLimit}`, f.x + 12, f.y + f.h - 25);
    }
    const pacingOn = sim.cfg.fabric.tlsErrorPacingEnabled;
    ctx.textAlign = 'right';
    ctx.fillStyle = pacingOn ? SEMANTIC.success : withAlpha(SURFACE.textFaint, 0.8);
    ctx.fillText(pacingOn ? '●PACE' : '○PACE', f.x + f.w - 12, f.y + f.h - 12);
    ctx.textAlign = 'left';
  }

  private drawDownstreams(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    const cap = sim.cfg.downstreams.concurrencyCapacity;
    for (let i = 0; i < sim.downstreams.length; i++) {
      const ds = sim.downstreams[i];
      const b = l.downstreams[i];
      if (!b) continue;
      const load = ds.inFlight / Math.max(1, cap);
      this.panel(b.x, b.y, b.w, b.h, load > 1 ? SEMANTIC.cpuBad : SURFACE.border);

      ctx.font = '600 12px "Big Shoulders", "Arial Narrow", sans-serif';
      ctx.fillStyle = SURFACE.text;
      ctx.fillText(`BIDDER ${i + 1}`, b.x + 9, b.y + 15);

      // Load bar
      const gw = b.w - 18;
      ctx.fillStyle = SURFACE.panelRaised;
      ctx.fillRect(b.x + 9, b.y + 22, gw, 6);
      ctx.fillStyle = loadColor(load);
      ctx.fillRect(b.x + 9, b.y + 22, gw * clamp01(load), 6);
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = SURFACE.textDim;
      ctx.fillText(`${ds.inFlight}/${cap} in-flight`, b.x + 9, b.y + 39);
      const d = sim.cfg.downstreams;
      if (b.h > 52) {
        ctx.fillText(
          `p50 ${Math.round(d.responseTimeMedianMs)}ms · err ${(d.errorRate * 100).toFixed(1)}%`,
          b.x + 9,
          b.y + 51,
        );
      }
    }
  }

  /** Per-downstream wait queues, drawn inside the fabric's right column. */
  private drawQueues(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    const f = l.fabric;
    const dsCount = sim.downstreams.length;
    const bandH = (f.h - 90) / Math.max(1, dsCount);
    const timeout = sim.cfg.downstreamPool.requestTimeoutMs;
    for (let i = 0; i < dsCount; i++) {
      const ds = sim.downstreams[i];
      const top = f.y + 70 + bandH * i;
      const baseX = f.x + f.w - 22;
      const shown = Math.min(ds.queue.length, Math.floor(bandH / 7));
      for (let q = 0; q < shown; q++) {
        const entry = ds.queue[q];
        const age = clamp01((sim.now - entry.req.phaseSince) / timeout);
        ctx.fillStyle = mixColor(SEMANTIC.inFlight, SEMANTIC.timeout, age);
        ctx.fillRect(baseX, top + bandH - 8 - q * 7, 14, 5);
      }
      if (ds.queue.length > shown) {
        ctx.font = '600 9px "IBM Plex Mono", monospace';
        ctx.fillStyle = SEMANTIC.timeout;
        ctx.fillText(`+${ds.queue.length - shown}`, baseX - 4, top + 10);
      }
    }
  }

  // -- Particles -----------------------------------------------------------------

  /** Drop a mote into the graveyard band below the fabric (stacks downward). */
  private spawnMote(sim: Simulation, l: SceneLayout, kind: MoteKind): void {
    const g = l.graveyard;
    this.graveSeq++;
    const scatter = (((this.graveSeq * 2654435761) >>> 8) % 1000) / 1000;
    this.graveyard.push({
      x: g.x + 8 + scatter * (g.w - 16),
      y0: l.fabric.y + l.fabric.h,
      y1: g.y + 4 + ((this.graveSeq * 7919) % 6) * 4,
      bornAt: sim.now,
      kind,
    });
    if (this.graveyard.length > 320) this.graveyard.shift();
  }

  /** Note newly-resolved requests and shed connections → graveyard motes. */
  private collectFates(sim: Simulation, l: SceneLayout): void {
    for (const req of sim.requests) {
      if (!req.fate || req.fate === 'success') continue;
      const seen = this.seenFates.get(req.id);
      if (seen === req.fateTime) continue;
      this.seenFates.set(req.id, req.fateTime);
      this.spawnMote(sim, l, req.fate);
    }
    // Connection sheds (RSTs) are events, not requests — diff the totals.
    const t = sim.metrics.totals;
    const newTls = Math.min(20, t.shedTls - this.seenShedTls);
    const newConn = Math.min(20, t.shedConnLimit - this.seenShedConn);
    for (let i = 0; i < newTls; i++) this.spawnMote(sim, l, 'shedTls');
    for (let i = 0; i < newConn; i++) this.spawnMote(sim, l, 'shedConn');
    this.seenShedTls = t.shedTls;
    this.seenShedConn = t.shedConnLimit;
    // Bound the bookkeeping map.
    if (this.seenFates.size > 4096) {
      const live = new Set<number>();
      for (const req of sim.requests) live.add(req.id);
      for (const id of this.seenFates.keys()) if (!live.has(id)) this.seenFates.delete(id);
    }
  }

  private drawParticles(sim: Simulation, l: SceneLayout): void {
    const waitingDrawn = new Map<number, number>(); // clientId → stack count
    for (const req of sim.requests) {
      if (req.fate) {
        this.drawFateFlash(sim, l, req);
        continue;
      }
      const pos = this.particlePosition(sim, l, req, waitingDrawn);
      if (!pos) continue;
      this.drawRequestDot(pos.x, pos.y, req);
    }
  }

  private particlePosition(
    sim: Simulation,
    l: SceneLayout,
    req: RequestSim,
    waitingDrawn: Map<number, number>,
  ): { x: number; y: number } | null {
    const t = clamp01((sim.now - req.phaseSince) / Math.max(1, req.phaseUntil - req.phaseSince));
    switch (req.phase) {
      case 'waitingForConnection': {
        const b = l.clients[req.clientId];
        if (!b) return null;
        const stack = waitingDrawn.get(req.clientId) ?? 0;
        if (stack > 8) return null;
        waitingDrawn.set(req.clientId, stack + 1);
        return { x: b.x + b.w + 8 + (stack % 3) * 8, y: b.y + 6 + Math.floor(stack / 3) * 8 };
      }
      case 'travelingToFabric': {
        const lane = this.laneForClientConn(sim, l, req);
        if (!lane) return null;
        return { x: lerp(lane.x0, lane.x1, t), y: lerp(lane.y0, lane.y1, t) };
      }
      case 'processingAtFabric': {
        const f = l.fabric;
        const h = (req.id * 2654435761) >>> 16;
        return {
          x: f.x + f.w * 0.32 + (h % 50) / 50 * f.w * 0.16,
          y: f.y + 84 + ((h >> 6) % 100) / 100 * (f.h - 170),
        };
      }
      case 'queuedAtFabric':
        return null; // drawn by drawQueues
      case 'travelingToDownstream': {
        const lane = this.laneForDsConn(sim, l, req);
        if (!lane) return null;
        return { x: lerp(lane.x0, lane.x1, t), y: lerp(lane.y0, lane.y1, t) };
      }
      case 'atDownstream': {
        const b = l.downstreams[req.downstreamId];
        if (!b) return null;
        const h = (req.id * 2654435761) >>> 16;
        return {
          x: b.x + 12 + (h % 60) / 60 * (b.w - 24),
          y: b.y + b.h - 18 + ((h >> 6) % 10),
        };
      }
      case 'returning': {
        const hop = sim.cfg.clients.rttMs / 2;
        const total = req.phaseUntil - req.phaseSince;
        const fromDs = req.downstreamId >= 0 && total > hop + 2;
        const clientLaneGeom = this.laneForClientConn(sim, l, req);
        const f = l.fabric;
        if (fromDs) {
          const split = NET_FABRIC_DS_MS / (NET_FABRIC_DS_MS + hop);
          const d = l.downstreams[req.downstreamId];
          if (t < split && d) {
            const tt = t / split;
            return { x: lerp(d.x, f.x + f.w, tt), y: lerp(d.cy, f.cy, tt) };
          }
          const tt = (t - split) / (1 - split);
          if (!clientLaneGeom) return null;
          return { x: lerp(clientLaneGeom.x1, clientLaneGeom.x0, tt), y: lerp(clientLaneGeom.y1, clientLaneGeom.y0, tt) };
        }
        if (!clientLaneGeom) return null;
        return { x: lerp(clientLaneGeom.x1, clientLaneGeom.x0, t), y: lerp(clientLaneGeom.y1, clientLaneGeom.y0, t) };
      }
    }
  }

  private laneForClientConn(sim: Simulation, l: SceneLayout, req: RequestSim) {
    const client = sim.clients[req.clientId];
    if (!client || !req.conn) return null;
    const idx = client.conns.indexOf(req.conn);
    if (idx < 0) return null;
    return clientLane(l, req.clientId, idx, client.conns.length);
  }

  private laneForDsConn(sim: Simulation, l: SceneLayout, req: RequestSim) {
    const ds = sim.downstreams[req.downstreamId];
    if (!ds || !req.dsConn) return null;
    const idx = ds.conns.indexOf(req.dsConn);
    if (idx < 0) return null;
    return dsLane(l, req.downstreamId, idx, ds.conns.length);
  }

  private drawRequestDot(x: number, y: number, req: RequestSim): void {
    const ctx = this.ctx;
    const color = SEMANTIC.inFlight;
    if (req.attempt > 0) {
      ctx.strokeStyle = withAlpha(SEMANTIC.retry, 0.85);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = withAlpha(color, 0.25);
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFateFlash(sim: Simulation, l: SceneLayout, req: RequestSim): void {
    const ctx = this.ctx;
    const age = clamp01((sim.now - req.fateTime) / FATE_LINGER_MS);
    if (age >= 1) return;
    const pos = this.fatePosition(l, req);
    if (!pos) return;
    const alpha = 1 - age;
    const r = 4 + age * 7;
    switch (req.fate) {
      case 'success':
        ctx.strokeStyle = withAlpha(SEMANTIC.success, alpha);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'timeout':
        this.spikedStar(pos.x, pos.y, r, withAlpha(SEMANTIC.timeout, alpha));
        break;
      case 'error':
        ctx.strokeStyle = withAlpha(SEMANTIC.error, alpha);
        ctx.lineWidth = 2;
        ctx.strokeRect(pos.x - r * 0.7, pos.y - r * 0.7, r * 1.4, r * 1.4);
        break;
      case 'rejected':
        ctx.strokeStyle = withAlpha(SEMANTIC.shed, alpha);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pos.x - r * 0.6, pos.y - r * 0.6);
        ctx.lineTo(pos.x + r * 0.6, pos.y + r * 0.6);
        ctx.moveTo(pos.x + r * 0.6, pos.y - r * 0.6);
        ctx.lineTo(pos.x - r * 0.6, pos.y + r * 0.6);
        ctx.stroke();
        break;
    }
  }

  private fatePosition(l: SceneLayout, req: RequestSim): { x: number; y: number } | null {
    // Success/error/shed resolve at the client; timeouts flash at the client
    // (that's who gave up); rejected flashes beside the client's wait stack.
    const b = l.clients[req.clientId];
    if (!b) return null;
    return { x: b.x + b.w + 14, y: b.cy };
  }

  private spikedStar(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    const spikes = 10;
    for (let i = 0; i < spikes * 2; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  // -- Graveyard, storm frame, pulse chip -------------------------------------------

  private drawGraveyard(l: SceneLayout, now: number): void {
    const ctx = this.ctx;
    const FALL_MS = 500;
    const FADE_MS = 25_000;
    const DRIFT_PX = 12;
    const floor = l.height - 8;
    for (const m of this.graveyard) {
      const age = now - m.bornAt;
      if (age > FADE_MS) continue;
      let x = m.x;
      let y: number;
      let alpha: number;
      if (age < FALL_MS) {
        y = Math.min(floor, lerp(m.y0, m.y1, clamp01(age / FALL_MS)));
        x += Math.sin(age / 60) * 2;
        alpha = 0.9;
      } else {
        // Settled motes keep drifting slowly downward as they fade.
        const settled = (age - FALL_MS) / (FADE_MS - FALL_MS);
        y = Math.min(floor, m.y1 + settled * DRIFT_PX);
        alpha = 0.9 * (1 - settled);
      }
      switch (m.kind) {
        case 'timeout':
          ctx.fillStyle = withAlpha(SEMANTIC.timeout, alpha);
          ctx.fillRect(x, y, 3, 3);
          break;
        case 'rejected':
          ctx.fillStyle = withAlpha(SEMANTIC.shed, alpha);
          ctx.fillRect(x, y, 3, 3);
          break;
        case 'error':
          ctx.fillStyle = withAlpha(SEMANTIC.error, alpha);
          ctx.fillRect(x, y, 3, 3);
          break;
        case 'shedTls':
          // Shed TLS connection: hollow ring (a handshake that never was).
          ctx.strokeStyle = withAlpha(SEMANTIC.tlsPulse, alpha);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x + 1.5, y + 1.5, 2.6, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'shedConn':
          // Shed at the connection limit: hollow triangle (bounced at the door).
          ctx.strokeStyle = withAlpha(SEMANTIC.shed, alpha);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x + 1.5, y - 2);
          ctx.lineTo(x + 4.5, y + 3);
          ctx.lineTo(x - 1.5, y + 3);
          ctx.closePath();
          ctx.stroke();
          break;
      }
    }
  }

  private drawStormFrame(now: number): void {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.25 + 0.35 * pulse);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(3, 3, this.cssW - 6, this.cssH - 6, 10);
    ctx.stroke();
  }

  private drawPulseChip(sim: Simulation, l: SceneLayout): void {
    const ctx = this.ctx;
    const remaining = Math.max(0, sim.pulseUntil - sim.now) / 1000;
    ctx.font = '700 13px "Big Shoulders", "Arial Narrow", sans-serif';
    const label = `◉ PULSE ×${sim.pulseFactor}  ${remaining.toFixed(1)}s`;
    const w = ctx.measureText(label).width + 18;
    ctx.fillStyle = withAlpha(SEMANTIC.shed, 0.16);
    ctx.strokeStyle = SEMANTIC.shed;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(l.width / 2 - w / 2, 6, w, 22, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = SEMANTIC.shed;
    ctx.fillText(label, l.width / 2 - w / 2 + 9, 22);
  }
}

/** Blend two hex colors (t in [0,1]). */
function mixColor(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const m = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
