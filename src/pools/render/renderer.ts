import { loadColor, SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { PoolSimulation } from '../engine/poolSimulation';

interface Rect { x: number; y: number; w: number; h: number }

export class PoolRenderer {
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

  draw(sim: PoolSimulation): void {
    const { ctx } = this;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = SURFACE.canvas;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = withAlpha(SURFACE.textFaint, 0.18);
    for (let x = 14; x < w; x += 30) for (let y = 14; y < h; y += 30) ctx.fillRect(x, y, 1.5, 1.5);
    if (w < 300 || h < 180) return;

    const s = sim.snapshot();
    const pad = 16;
    const topH = Math.min(80, h * 0.2);
    const bottomH = Math.min(62, h * 0.17);
    const mainY = pad + topH + 12;
    const mainH = h - mainY - bottomH - 2 * pad;
    const gap = 16;
    const leftW = w * 0.25;
    const centerW = w * 0.34;
    const left: Rect = { x: pad, y: mainY, w: leftW, h: mainH };
    const center: Rect = { x: left.x + left.w + gap, y: mainY, w: centerW, h: mainH };
    const right: Rect = { x: center.x + center.w + gap, y: mainY, w: w - center.x - center.w - gap - pad, h: mainH };

    this.drawEquation(sim, pad, pad, w - pad * 2, topH);
    this.drawFabric(sim, left);
    this.drawPools(sim, center);
    this.drawResponders(sim, right);
    this.drawFlow(sim, left, center, right);
    this.drawOutcome(sim, pad, h - bottomH - pad, w - pad * 2, bottomH);
    if (s.limitActive) this.drawLimitFrame(sim.now);
  }

  private drawEquation(sim: PoolSimulation, x: number, y: number, w: number, h: number): void {
    const s = sim.snapshot();
    this.panel({ x, y, w, h }, s.limitActive ? SEMANTIC.timeout : SURFACE.border);
    const ownerTerm = sim.cfg.fabric.ownership === 'worker'
      ? `${sim.cfg.fabric.nodes} nodes × ${sim.cfg.fabric.coresPerNode} workers`
      : `${sim.cfg.fabric.nodes} nodes × 1 shared owner`;
    const keyTerm = sim.cfg.fabric.keyStrategy === 'link-ip'
      ? `${sim.cfg.fabric.links} links × ${sim.cfg.fabric.endpointIps} IPs`
      : sim.cfg.fabric.keyStrategy === 'endpoint'
        ? `${sim.cfg.fabric.endpointIps} IP+cert+port keys`
        : '1 DNS authority';
    ctxText(this.ctx, 'POOL CARDINALITY', x + 12, y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${ownerTerm} × ${keyTerm}`, x + 12, y + 42, 14, SURFACE.text);
    ctxText(this.ctx, `= ${fmt(s.poolKeys)} independently owned keys`, x + 12, y + 62, 16, SEMANTIC.tlsPulse, true);

    this.ctx.textAlign = 'right';
    ctxText(this.ctx, `${fmt(s.desiredConnections)} desired → ${fmt(s.established)} established`, x + w - 12, y + 29, 15,
      s.limitActive ? SEMANTIC.timeout : SEMANTIC.success, true);
    ctxText(this.ctx, `${fmt(s.busy)} busy · ${fmt(s.idle)} idle · ${fmt(s.pending)} connecting`, x + w - 12, y + 52, 11, SURFACE.textDim);
    this.ctx.textAlign = 'left';
  }

  private drawFabric(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, SURFACE.border);
    ctxText(this.ctx, 'RTB FABRIC', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${sim.cfg.fabric.nodes} nodes`, r.x + 10, r.y + 42, 18, SEMANTIC.inFlight, true);
    ctxText(this.ctx,
      sim.cfg.fabric.ownership === 'worker' ? `${sim.cfg.fabric.coresPerNode} worker pools / node` : '1 shared pool owner / node',
      r.x + 10, r.y + 59, 10, SURFACE.textDim);

    const count = Math.min(48, Math.max(1, sim.cfg.fabric.nodes));
    const cols = Math.max(2, Math.ceil(Math.sqrt(count * Math.max(1, r.w / Math.max(1, r.h)))));
    const rows = Math.ceil(count / cols);
    const cellW = (r.w - 20) / cols;
    const cellH = Math.min(24, (r.h - 82) / rows);
    for (let i = 0; i < count; i++) {
      const cx = r.x + 10 + (i % cols) * cellW;
      const cy = r.y + 72 + Math.floor(i / cols) * cellH;
      this.ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.18);
      this.ctx.fillRect(cx + 2, cy + 2, Math.max(5, cellW - 5), Math.max(4, cellH - 5));
      this.ctx.strokeStyle = withAlpha(SEMANTIC.inFlight, 0.6);
      this.ctx.strokeRect(cx + 2, cy + 2, Math.max(5, cellW - 5), Math.max(4, cellH - 5));
    }
    if (sim.cfg.fabric.nodes > count) ctxText(this.ctx, `+${sim.cfg.fabric.nodes - count}`, r.x + r.w - 28, r.y + r.h - 10, 10, SURFACE.textDim);
    ctxText(this.ctx, `${fmt(s.baseRate)} req/s`, r.x + 10, r.y + r.h - 12, 12, SEMANTIC.success, true);
  }

  private drawPools(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, s.capActive ? SEMANTIC.shed : SURFACE.border);
    ctxText(this.ctx, 'OUTBOUND POOLS', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, s.keysLabel, r.x + 10, r.y + 41, 16, SEMANTIC.tlsPulse, true);
    ctxText(this.ctx, `${sim.cfg.pool.protocol.toUpperCase()} · ${s.streamsPerConnection} stream${s.streamsPerConnection === 1 ? '' : 's'} / conn`, r.x + 10, r.y + 58, 10, SURFACE.textDim);

    const barX = r.x + 12;
    const barW = r.w - 24;
    const barY = r.y + 82;
    const barH = Math.min(54, r.h * 0.2);
    const denom = Math.max(1, s.desiredConnections, s.established + s.pending);
    this.ctx.fillStyle = SURFACE.panelRaised;
    this.ctx.fillRect(barX, barY, barW, barH);
    this.ctx.fillStyle = withAlpha(SEMANTIC.success, 0.85);
    this.ctx.fillRect(barX, barY, barW * (s.busy / denom), barH);
    this.ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.75);
    this.ctx.fillRect(barX + barW * (s.busy / denom), barY, barW * (s.idle / denom), barH);
    this.ctx.strokeStyle = SEMANTIC.timeout;
    this.ctx.setLineDash([3, 3]);
    const desiredX = barX + barW * Math.min(1, s.desiredConnections / denom);
    this.ctx.beginPath(); this.ctx.moveTo(desiredX, barY - 5); this.ctx.lineTo(desiredX, barY + barH + 5); this.ctx.stroke();
    this.ctx.setLineDash([]);
    ctxText(this.ctx, `busy ${fmt(s.busy)}`, barX, barY + barH + 18, 10, SEMANTIC.success);
    ctxText(this.ctx, `idle ${fmt(s.idle)}`, barX + barW * 0.34, barY + barH + 18, 10, SEMANTIC.inFlight);
    ctxText(this.ctx, `connecting ${fmt(s.pending)}`, barX + barW * 0.65, barY + barH + 18, 10, SEMANTIC.tlsPulse);

    const y = Math.min(r.y + r.h - 72, barY + barH + 48);
    ctxText(this.ctx, `idle timeout  ${sim.cfg.pool.idleTimeoutMs === 0 ? 'disabled' : fmtDuration(sim.cfg.pool.idleTimeoutMs)}`, r.x + 12, y, 10, SURFACE.textDim);
    ctxText(this.ctx, `max idle/key ${sim.cfg.pool.maxIdlePerKey === 0 ? 'unbounded' : sim.cfg.pool.maxIdlePerKey}`, r.x + 12, y + 17, 10, SURFACE.textDim);
    ctxText(this.ctx, `active cap   ${sim.cfg.pool.policy === 'hyper' ? 'none (Hyper)' : `${sim.cfg.pool.maxConnectionsPerKey}/key`}`, r.x + 12, y + 34, 10,
      s.capActive ? SEMANTIC.shed : SURFACE.textDim);
  }

  private drawResponders(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, s.limitActive ? SEMANTIC.timeout : SURFACE.border);
    ctxText(this.ctx, 'CUSTOMER RESPONDERS', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${sim.cfg.responder.instances} Envoy / bidder instances`, r.x + 10, r.y + 40, 12, SURFACE.text);
    ctxText(this.ctx, `${fmt(sim.cfg.responder.connectionLimit)} connection limit each`, r.x + 10, r.y + 57, 10, SURFACE.textDim);

    const n = Math.max(1, Math.round(sim.cfg.responder.instances));
    const maxShown = Math.min(24, n);
    const startY = r.y + 76;
    const usableH = Math.max(30, r.h - 110);
    const rowH = Math.max(8, Math.min(22, usableH / maxShown));
    for (let i = 0; i < maxShown; i++) {
      const uneven = n <= 1 ? 1 : 1 + sim.cfg.responder.connectionSkew * (1 - (2 * i) / (n - 1));
      const conn = (s.established / n) * uneven;
      const pressure = conn / Math.max(1, sim.cfg.responder.connectionLimit);
      const y = startY + i * rowH;
      ctxText(this.ctx, `E${i + 1}`, r.x + 9, y + rowH * 0.7, 9, SURFACE.textDim);
      const bx = r.x + 34;
      const bw = r.w - 78;
      this.ctx.fillStyle = SURFACE.panelRaised;
      this.ctx.fillRect(bx, y + 2, bw, Math.max(4, rowH - 5));
      this.ctx.fillStyle = withAlpha(loadColor(pressure), 0.88);
      this.ctx.fillRect(bx, y + 2, bw * Math.min(1, pressure), Math.max(4, rowH - 5));
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, fmt(conn), r.x + r.w - 8, y + rowH * 0.7, 9, loadColor(pressure));
      this.ctx.textAlign = 'left';
    }
    ctxText(this.ctx, `hottest ${fmt(s.hottestResponder)} / ${fmt(sim.cfg.responder.connectionLimit)}`, r.x + 10, r.y + r.h - 14, 12,
      loadColor(s.responderPressure), true);
  }

  private drawFlow(sim: PoolSimulation, left: Rect, center: Rect, right: Rect): void {
    const s = sim.snapshot();
    const phase = (sim.now / 450) % 1;
    const lines: Array<[number, number, number, number, string]> = [
      [left.x + left.w, left.y + left.h * 0.5, center.x, center.y + center.h * 0.5, SEMANTIC.inFlight],
      [center.x + center.w, center.y + center.h * 0.5, right.x, right.y + right.h * 0.5, s.limitActive ? SEMANTIC.timeout : SEMANTIC.success],
    ];
    for (const [x1, y1, x2, y2, color] of lines) {
      this.ctx.strokeStyle = withAlpha(color, 0.35);
      this.ctx.lineWidth = 2;
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const t = (phase + i / 4) % 1;
        this.ctx.fillStyle = color;
        this.ctx.beginPath(); this.ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 2.2, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  private drawOutcome(sim: PoolSimulation, x: number, y: number, w: number, h: number): void {
    const s = sim.snapshot();
    this.panel({ x, y, w, h }, s.limitActive ? SEMANTIC.timeout : SURFACE.border);
    const items: Array<[string, string, string]> = [
      ['ESTABLISHED', fmt(s.established), SEMANTIC.connEstablished],
      ['HOTTEST RESPONDER', `${fmt(s.hottestResponder)} / ${fmt(sim.cfg.responder.connectionLimit)}`, loadColor(s.responderPressure)],
      ['SERVED', `${(s.effectiveRate > 0 ? 100 * s.servedRate / s.effectiveRate : 100).toFixed(1)}%`, SEMANTIC.success],
      ['RESETS /s', fmt(s.resetsPerSec), s.resetsPerSec > 0 ? SEMANTIC.timeout : SURFACE.textDim],
      ['REUSE', `${(s.reuseRatio * 100).toFixed(1)}%`, SEMANTIC.tlsPulse],
    ];
    items.forEach(([label, value, color], i) => {
      const ix = x + 13 + (i * (w - 26)) / items.length;
      ctxText(this.ctx, label, ix, y + 18, 9, SURFACE.textFaint, true);
      ctxText(this.ctx, value, ix, y + 40, 15, color, true);
    });
  }

  private drawLimitFrame(now: number): void {
    const alpha = 0.45 + 0.3 * Math.sin(now / 220);
    this.ctx.strokeStyle = withAlpha(SEMANTIC.timeout, alpha);
    this.ctx.lineWidth = 4;
    this.ctx.strokeRect(3, 3, this.cssW - 6, this.cssH - 6);
  }

  private panel(r: Rect, border: string): void {
    this.ctx.fillStyle = withAlpha(SURFACE.panel, 0.92);
    this.ctx.fillRect(r.x, r.y, r.w, r.h);
    this.ctx.strokeStyle = border;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
}

function ctxText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, bold = false): void {
  ctx.font = `${bold ? 700 : 500} ${size}px ${bold ? '"Big Shoulders", "Arial Narrow"' : '"IBM Plex Mono"'}, monospace`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtDuration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`;
}
