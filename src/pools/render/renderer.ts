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
    const pad = 12;
    const topH = Math.min(80, h * 0.2);
    const bottomH = Math.min(62, h * 0.17);
    const mainY = pad + topH + 12;
    const mainH = h - mainY - bottomH - 2 * pad;
    const gap = 10;
    const fabric: Rect = { x: pad, y: mainY, w: w * 0.21, h: mainH };
    const links: Rect = { x: fabric.x + fabric.w + gap, y: mainY, w: w * 0.22, h: mainH };
    const endpoints: Rect = { x: links.x + links.w + gap, y: mainY, w: w * 0.31, h: mainH };
    const responders: Rect = { x: endpoints.x + endpoints.w + gap, y: mainY, w: w - endpoints.x - endpoints.w - gap - pad, h: mainH };

    this.drawEquation(sim, pad, pad, w - pad * 2, topH);
    this.drawFlow(sim, fabric, links, endpoints, responders);
    this.drawFabric(sim, fabric);
    this.drawLinks(sim, links);
    this.drawPools(sim, endpoints);
    this.drawResponders(sim, responders);
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
      ? `${s.links.length} Links × 1 endpoint × ${s.responders.length} responder IPs`
      : sim.cfg.fabric.keyStrategy === 'endpoint'
        ? `${s.uniqueEndpoints} unique endpoints × ${s.responders.length} responder IPs`
        : `${s.uniqueEndpoints} unique endpoint authorities`;
    ctxText(this.ctx, 'POOL CARDINALITY', x + 12, y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${ownerTerm} × ${keyTerm}`, x + 12, y + 42, 14, SURFACE.text);
    ctxText(this.ctx, `= ${fmt(s.poolKeys)} independently owned keys`, x + 12, y + 62, 16, SEMANTIC.tlsPulse, true);

    this.ctx.textAlign = 'right';
    ctxText(this.ctx, `${fmt(s.desiredConnections)} desired → ${fmt(s.established)} established`, x + w - 12, y + 29, 15,
      s.limitActive ? SEMANTIC.timeout : SEMANTIC.success, true);
    ctxText(this.ctx, `Little's Law ${fmt(s.littleLawRequired)} required · actual ${amplificationText(s)}`, x + w - 12, y + 52, 11,
      amplificationColor(s));
    this.ctx.textAlign = 'left';
  }

  private drawFabric(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, SURFACE.border);
    const nodes = Math.max(1, Math.round(sim.cfg.fabric.nodes));
    const ownersPerNode = sim.cfg.fabric.ownership === 'worker' ? Math.max(1, Math.round(sim.cfg.fabric.coresPerNode)) : 1;
    ctxText(this.ctx, 'RTB FABRIC NODES', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${nodes} nodes · ${fmt(s.poolOwners)} pool owners`, r.x + 10, r.y + 41, 13, SEMANTIC.inFlight, true);
    ctxText(this.ctx, `${ownersPerNode} owner${ownersPerNode === 1 ? '' : 's'}/node · each owns every Link`, r.x + 10, r.y + 58, 9, SURFACE.textDim);

    const shown = Math.min(nodes, 12, this.maxRows(r, 76, 24, 34));
    const rowH = Math.max(18, Math.min(24, (r.h - 106) / Math.max(1, shown)));
    const linkBlocks = Math.min(8, s.links.length);
    for (let i = 0; i < shown; i++) {
      const y = r.y + 70 + i * rowH;
      this.ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.18);
      this.ctx.fillRect(r.x + 7, y, r.w - 14, rowH - 3);
      this.ctx.strokeStyle = withAlpha(SEMANTIC.inFlight, 0.6);
      this.ctx.strokeRect(r.x + 7.5, y + 0.5, r.w - 15, rowH - 4);
      ctxText(this.ctx, `N${i + 1}`, r.x + 12, y + 13, 9, SURFACE.text, true);
      const blocksX = r.x + 36;
      const blocksW = Math.max(20, r.w - 82);
      const blockGap = 2;
      const blockW = Math.max(2, Math.min(12, (blocksW - blockGap * (linkBlocks - 1)) / linkBlocks));
      for (let link = 0; link < linkBlocks; link++) {
        this.ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.72);
        this.ctx.fillRect(blocksX + link * (blockW + blockGap), y + 5, blockW, Math.max(5, rowH - 13));
      }
      if (s.links.length > linkBlocks) ctxText(this.ctx, '…', blocksX + linkBlocks * (blockW + blockGap), y + 13, 8, SURFACE.textDim);
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, `×${ownersPerNode}`, r.x + r.w - 12, y + 13, 8, SURFACE.textDim);
      this.ctx.textAlign = 'left';
    }
    if (shown < nodes) ctxText(this.ctx, `+${nodes - shown} nodes with the same Link-pool set`, r.x + 10, r.y + r.h - 27, 8, SURFACE.textDim);
    ctxText(this.ctx, `${fmt(s.logicalKeysPerOwner * ownersPerNode)} owned keys / node`, r.x + 10, r.y + r.h - 11, 11, SEMANTIC.tlsPulse, true);
  }

  private drawLinks(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, SURFACE.border);
    const ownersPerNode = sim.cfg.fabric.ownership === 'worker' ? Math.max(1, Math.round(sim.cfg.fabric.coresPerNode)) : 1;
    const linkBased = sim.cfg.fabric.keyStrategy === 'link-ip';
    ctxText(this.ctx, linkBased ? 'LINK-BASED POOLS / OWNER' : 'LINK ROUTES / OWNER', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${fmt(s.poolOwners)} identical owner copies fleet-wide`, r.x + 10, r.y + 40, 10, SURFACE.text);
    ctxText(this.ctx, `${ownersPerNode}/node × all ${s.links.length} Links`, r.x + 10, r.y + 56, 10, SEMANTIC.inFlight);

    const shown = Math.min(s.links.length, this.maxRows(r, 72, 25, 14));
    const rowH = Math.max(18, Math.min(25, (r.h - 94) / Math.max(1, shown)));
    for (let i = 0; i < shown; i++) {
      const link = s.links[i];
      const y = r.y + 68 + i * rowH;
      this.ctx.fillStyle = withAlpha(SEMANTIC.inFlight, 0.12);
      this.ctx.fillRect(r.x + 7, y, r.w - 14, rowH - 3);
      this.ctx.strokeStyle = withAlpha(SEMANTIC.inFlight, 0.45);
      this.ctx.strokeRect(r.x + 7.5, y + 0.5, r.w - 15, rowH - 4);
      ctxText(this.ctx, `L${link.id}→EP${link.endpointId}`, r.x + 13, y + 13, 9, SEMANTIC.inFlight, true);
      ctxText(this.ctx, `${fmt(link.requestRate)}/s`, r.x + Math.min(78, r.w * 0.42), y + 13, 8, SURFACE.textDim);
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, linkBased ? `${s.responders.length} IP pools` : 'shared destination keys', r.x + r.w - 12, y + 13, 8, SURFACE.text);
      this.ctx.textAlign = 'left';
    }
    if (shown < s.links.length) ctxText(this.ctx, `+${s.links.length - shown} Links`, r.x + 10, r.y + r.h - 11, 9, SURFACE.textDim);
  }

  private drawPools(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, s.capActive ? SEMANTIC.shed : SURFACE.border);
    ctxText(this.ctx, 'LINK ENDPOINTS → POOL KEYS', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    const sharing = s.uniqueEndpoints === 1
      ? 'all Links converge'
      : s.sharedEndpoints === 0
        ? 'every Link differs'
        : `${s.sharedEndpoints} reused by multiple Links`;
    ctxText(this.ctx, `${s.uniqueEndpoints} unique · ${sharing}`, r.x + 10, r.y + 40, 11, SURFACE.text);
    ctxText(this.ctx, `${s.keysLabel} · ${sim.cfg.pool.protocol.toUpperCase()} · ${fmt(s.logicalKeysPerOwner)} keys/owner`, r.x + 10, r.y + 56, 9, SEMANTIC.tlsPulse);

    const bottomSpace = 86;
    const shown = Math.min(s.endpoints.length, this.maxRows(r, 72, 28, bottomSpace));
    const rowH = Math.max(20, Math.min(28, (r.h - 72 - bottomSpace) / Math.max(1, shown)));
    for (let i = 0; i < shown; i++) {
      const endpoint = s.endpoints[i];
      const y = r.y + 66 + i * rowH;
      const color = endpoint.shared ? SEMANTIC.success : SEMANTIC.tlsPulse;
      this.ctx.fillStyle = withAlpha(color, 0.1);
      this.ctx.fillRect(r.x + 7, y, r.w - 14, rowH - 3);
      this.ctx.strokeStyle = withAlpha(color, 0.45);
      this.ctx.strokeRect(r.x + 7.5, y + 0.5, r.w - 15, rowH - 4);
      ctxText(this.ctx, `EP${endpoint.id}`, r.x + 12, y + 12, 9, color, true);
      ctxText(this.ctx, endpoint.shared ? `shared ×${endpoint.linkIds.length}` : `Link ${endpoint.linkIds[0]}`, r.x + 41, y + 12, 8, SURFACE.textDim);
      ctxText(this.ctx, truncate(endpoint.authority, Math.max(8, Math.floor((r.w - 150) / 6))), r.x + 12, y + rowH - 6, 8, SURFACE.textDim);
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, `${endpoint.ips.length} IP · ${fmt(endpoint.keysPerOwner)} key · ${fmt(endpoint.estimatedConnections)} conn`, r.x + r.w - 12, y + 12, 8, SURFACE.text);
      this.ctx.textAlign = 'left';
    }
    if (shown < s.endpoints.length) ctxText(this.ctx, `+${s.endpoints.length - shown} endpoints`, r.x + 10, r.y + r.h - bottomSpace + 2, 8, SURFACE.textDim);

    const barX = r.x + 12;
    const barW = r.w - 24;
    const barY = r.y + r.h - 67;
    const barH = 14;
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
    ctxText(this.ctx, `busy ${fmt(s.busy)} · idle ${fmt(s.idle)} · connecting ${fmt(s.pending)}`, barX, barY + barH + 17, 9, SURFACE.text);
    ctxText(this.ctx,
      `idle ${sim.cfg.pool.idleTimeoutMs === 0 ? '∞' : fmtDuration(sim.cfg.pool.idleTimeoutMs)} · max idle ${sim.cfg.pool.maxIdlePerKey === 0 ? '∞' : sim.cfg.pool.maxIdlePerKey}/key · cap ${sim.cfg.pool.policy === 'hyper' ? 'none' : `${sim.cfg.pool.maxConnectionsPerKey}/key`}`,
      barX, barY + barH + 33, 8, s.capActive ? SEMANTIC.shed : SURFACE.textDim);
  }

  private drawResponders(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, s.limitActive ? SEMANTIC.timeout : SURFACE.border);
    ctxText(this.ctx, 'CUSTOMER RESPONDERS', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${sim.cfg.responder.instances} Envoy / bidder instances`, r.x + 10, r.y + 40, 12, SURFACE.text);
    ctxText(this.ctx, `${fmt(sim.cfg.responder.connectionLimit)} connection limit each`, r.x + 10, r.y + 57, 10, SURFACE.textDim);

    const n = s.responders.length;
    const startY = r.y + 76;
    const usableH = Math.max(30, r.h - 110);
    const maxShown = Math.min(24, n, Math.max(1, Math.floor(usableH / 8)));
    const rowH = Math.max(8, Math.min(22, usableH / maxShown));
    for (let i = 0; i < maxShown; i++) {
      const responder = s.responders[i];
      const y = startY + i * rowH;
      ctxText(this.ctx, responder.ip, r.x + 9, y + rowH * 0.7, 8, SURFACE.textDim);
      const bx = r.x + Math.min(96, r.w * 0.42);
      const bw = Math.max(12, r.w - (bx - r.x) - 52);
      this.ctx.fillStyle = SURFACE.panelRaised;
      this.ctx.fillRect(bx, y + 2, bw, Math.max(4, rowH - 5));
      this.ctx.fillStyle = withAlpha(loadColor(responder.pressure), 0.88);
      this.ctx.fillRect(bx, y + 2, bw * Math.min(1, responder.pressure), Math.max(4, rowH - 5));
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, fmt(responder.estimatedConnections), r.x + r.w - 8, y + rowH * 0.7, 9, loadColor(responder.pressure));
      this.ctx.textAlign = 'left';
    }
    ctxText(this.ctx, `hottest ${fmt(s.hottestResponder)} / ${fmt(sim.cfg.responder.connectionLimit)}`, r.x + 10, r.y + r.h - 14, 12,
      loadColor(s.responderPressure), true);
  }

  private drawFlow(sim: PoolSimulation, fabric: Rect, links: Rect, endpoints: Rect, responders: Rect): void {
    const s = sim.snapshot();
    const phase = (sim.now / 450) % 1;
    const lines: Array<[number, number, number, number, string]> = [
      [fabric.x + fabric.w, fabric.y + fabric.h * 0.5, links.x, links.y + links.h * 0.5, SEMANTIC.inFlight],
      [endpoints.x + endpoints.w, endpoints.y + endpoints.h * 0.5, responders.x, responders.y + responders.h * 0.5, s.limitActive ? SEMANTIC.timeout : SEMANTIC.success],
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

    // Actual Link→endpoint membership. Shared endpoints visibly collect lines
    // from several Links; distinct endpoints receive exactly one.
    const shownLinks = Math.min(s.links.length, this.maxRows(links, 72, 25, 14));
    const shownEndpoints = Math.min(s.endpoints.length, this.maxRows(endpoints, 72, 28, 86));
    const linkRowH = Math.max(18, Math.min(25, (links.h - 94) / Math.max(1, shownLinks)));
    const endpointRowH = Math.max(20, Math.min(28, (endpoints.h - 72 - 86) / Math.max(1, shownEndpoints)));
    const endpointIndex = new Map(s.endpoints.slice(0, shownEndpoints).map((endpoint, i) => [endpoint.id, i]));
    for (let i = 0; i < shownLinks; i++) {
      const link = s.links[i];
      const y1 = links.y + 68 + i * linkRowH + (linkRowH - 3) / 2;
      const index = endpointIndex.get(link.endpointId);
      if (index === undefined) continue;
      const y2 = endpoints.y + 66 + index * endpointRowH + (endpointRowH - 3) / 2;
      const endpoint = s.endpoints[index];
      this.ctx.strokeStyle = withAlpha(endpoint.shared ? SEMANTIC.success : SEMANTIC.tlsPulse, endpoint.shared ? 0.34 : 0.22);
      this.ctx.lineWidth = endpoint.shared ? 1.2 : 0.8;
      this.ctx.beginPath();
      this.ctx.moveTo(links.x + links.w, y1);
      this.ctx.bezierCurveTo(links.x + links.w + 5, y1, endpoints.x - 5, y2, endpoints.x, y2);
      this.ctx.stroke();
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
      ["ACTUAL / LITTLE'S LAW", amplificationText(s), amplificationColor(s)],
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

  private maxRows(r: Rect, top: number, row: number, bottom: number): number {
    return Math.max(1, Math.floor((r.h - top - bottom) / row));
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

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function amplificationText(s: ReturnType<PoolSimulation['snapshot']>): string {
  if (s.littleLawRequired <= 1e-7) return '—';
  return `${s.connectionAmplification.toFixed(s.connectionAmplification >= 10 ? 1 : 2)}×`;
}

function amplificationColor(s: ReturnType<PoolSimulation['snapshot']>): string {
  if (s.littleLawRequired <= 1e-7) return SURFACE.textDim;
  const ratio = s.connectionAmplification;
  if (ratio < 0.95) return SEMANTIC.timeout;
  if (ratio <= 1.25) return SEMANTIC.success;
  if (ratio <= 2) return SEMANTIC.shed;
  return SEMANTIC.timeout;
}
