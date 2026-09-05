/**
 * The outbound-pool board. Four columns trace a request's path (Fabric nodes →
 * Link pools → endpoint keys → responder instances) and, beneath them, the
 * socket field shows every simulated pool key as a column of sockets: busy at
 * the bottom, idle above it fading with age toward the idle timeout, connects
 * in flight on top. Everything animated is a pure function of sim time, so a
 * paused clock freezes the scene exactly.
 */

import { loadColor, SEMANTIC, SURFACE, withAlpha } from '../../render/colors';
import type { PoolSimulation } from '../engine/poolSimulation';
import type { PoolSampledKeyView, PoolSnapshot } from '../engine/types';

interface Rect { x: number; y: number; w: number; h: number }

/** A block of socket-field columns that target the same responder IP. */
interface FieldGroup { ip: number; keys: PoolSampledKeyView[] }

export class PoolRenderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private canvas: HTMLCanvasElement;
  private groupsFor: readonly PoolSampledKeyView[] | null = null;
  private groups: FieldGroup[] = [];

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
    const topH = Math.min(80, h * 0.17);
    const compact = h < 480;
    const bottomH = compact ? 0 : Math.min(62, h * 0.13);
    const mainY = pad + topH + 12;
    const available = h - mainY - pad - (bottomH > 0 ? bottomH + 10 : 0);
    let fieldH = Math.min(190, Math.max(64, available * 0.36));
    if (available - fieldH - 10 < 120) fieldH = 0;
    const mainH = available - (fieldH > 0 ? fieldH + 10 : 0);
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
    if (fieldH > 0) this.drawSocketField(sim, { x: pad, y: mainY + mainH + 10, w: w - pad * 2, h: fieldH });
    if (bottomH > 0) this.drawOutcome(sim, pad, h - bottomH - pad, w - pad * 2, bottomH);
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
    const perKey = s.poolKeys > 0 ? s.established / s.poolKeys : 0;
    const perKeyText = perKey.toFixed(perKey >= 100 ? 0 : perKey >= 10 ? 1 : 2);
    const right = x + w - 12;
    if (h < 70) {
      // Short pane (comparison mode): two lines each side.
      ctxText(this.ctx, 'POOL CARDINALITY', x + 12, y + 16, 11, SURFACE.textFaint, true);
      ctxText(this.ctx, `${ownerTerm} × ${keyTerm}`, x + 12, y + 36, 12, SURFACE.text);
      this.ctx.font = '500 12px "IBM Plex Mono", monospace';
      const termW = this.ctx.measureText(`${ownerTerm} × ${keyTerm}`).width;
      ctxText(this.ctx, `= ${fmt(s.poolKeys)} keys`, x + 12 + termW + 10, y + 36, 13, SEMANTIC.tlsPulse, true);
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, `${fmt(s.desiredConnections)} desired → ${fmt(s.established)} established`, right, y + 20, 13,
        s.limitActive ? SEMANTIC.timeout : SEMANTIC.success, true);
      ctxText(this.ctx, `Little's Law ${fmt(s.littleLawRequired)} · actual ${amplificationText(s)} · ${perKeyText} sockets / key · idle ${idleLabel(sim)}`,
        right, y + 38, 10, amplificationColor(s));
      this.ctx.textAlign = 'left';
    } else {
      ctxText(this.ctx, 'POOL CARDINALITY', x + 12, y + 20, 13, SURFACE.textFaint, true);
      ctxText(this.ctx, `${ownerTerm} × ${keyTerm}`, x + 12, y + 42, 14, SURFACE.text);
      ctxText(this.ctx, `= ${fmt(s.poolKeys)} independently owned keys`, x + 12, y + 62, 16, SEMANTIC.tlsPulse, true);

      this.ctx.textAlign = 'right';
      ctxText(this.ctx, `${fmt(s.desiredConnections)} desired → ${fmt(s.established)} established`, right, y + 29, 15,
        s.limitActive ? SEMANTIC.timeout : SEMANTIC.success, true);
      ctxText(this.ctx, `Little's Law ${fmt(s.littleLawRequired)} required · actual ${amplificationText(s)}`, right, y + 52, 11,
        amplificationColor(s));
      ctxText(this.ctx,
        `${perKeyText} sockets / key · idle ${idleLabel(sim)} · ${fmt(s.baseRate)} req/s offered`,
        right, y + 70, 10, SURFACE.textDim);
      this.ctx.textAlign = 'left';
    }

    const surge = sim.surge();
    if (surge) {
      const label = `◉ SURGE ×${surge.factor.toFixed(1)}  ${(surge.remainingMs / 1000).toFixed(1)}s`;
      this.ctx.font = '700 11px "Big Shoulders", "Arial Narrow", monospace';
      const tw = this.ctx.measureText(label).width + 16;
      const cx = x + w * 0.5 - tw / 2;
      const pulse = 0.5 + 0.5 * Math.sin(sim.now / 180);
      this.ctx.fillStyle = withAlpha(SEMANTIC.shed, 0.16 + 0.1 * pulse);
      this.ctx.fillRect(cx, y + 10, tw, 18);
      this.ctx.strokeStyle = withAlpha(SEMANTIC.shed, 0.6 + 0.3 * pulse);
      this.ctx.strokeRect(cx + 0.5, y + 10.5, tw - 1, 17);
      ctxText(this.ctx, label, cx + 8, y + 23, 11, SEMANTIC.shed, true);
    }
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
    // Each Link block glows with that Link's live socket count, so the node rows
    // breathe with the traffic instead of sitting still.
    const perLink = this.connectionsPerLink(s);
    const maxPerLink = Math.max(1, ...perLink);
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
        const level = perLink.length > link ? perLink[link] / maxPerLink : 1;
        this.ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.3 + 0.55 * level);
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

  /**
   * Every Link pool in the fleet, not one owner's set. Each row is a Link; the
   * blocks along it are the owner copies that each hold their own pool for it.
   * The count is the whole point of this model — a socket total is easy to read
   * past, but sixty-four blocks per row is not — so the copies are drawn rather
   * than asserted in a caption.
   */
  private drawLinks(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, SURFACE.border);
    const owners = Math.max(1, Math.round(s.poolOwners));
    const linkBased = sim.cfg.fabric.keyStrategy === 'link-ip';
    const copies = owners * s.links.length;
    ctxText(this.ctx, linkBased ? 'EVERY LINK POOL' : 'LINK ROUTES × OWNERS', r.x + 10, r.y + 20, 13, SURFACE.textFaint, true);
    ctxText(this.ctx, `${fmt(copies)} pool copies`, r.x + 10, r.y + 40, 13, SEMANTIC.inFlight, true);
    ctxText(this.ctx, `${fmt(owners)} owners × ${s.links.length} Links · one block each`, r.x + 10, r.y + 56, 9, SURFACE.textDim);

    const perLink = this.connectionsPerLink(s);
    const maxPerLink = Math.max(1, ...perLink);
    const shown = Math.min(s.links.length, this.maxRows(r, 70, 30, 16));
    const rowH = Math.max(22, Math.min(30, (r.h - 86) / Math.max(1, shown)));
    const stripX = r.x + 11;
    const stripW = r.w - 22;

    for (let i = 0; i < shown; i++) {
      const link = s.links[i];
      const y = r.y + 68 + i * rowH;
      const level = perLink.length > i ? perLink[i] / maxPerLink : 1;
      ctxText(this.ctx, `L${link.id}→EP${link.endpointId}`, stripX + 1, y + 9, 9, SEMANTIC.inFlight, true);
      this.ctx.textAlign = 'right';
      const sockets = perLink.length > i ? `${fmt(perLink[i])} sockets` : `${s.responders.length} IP pools`;
      ctxText(this.ctx, `${fmt(link.requestRate)}/s · ${sockets}`, r.x + r.w - 11, y + 9, 8, SURFACE.text);
      this.ctx.textAlign = 'left';

      // One block per owner copy of this Link's pool, packed to the row width.
      // Below about a pixel each they stop reading as countable things, so the
      // row becomes a solid band with the count called out instead.
      const blockH = Math.max(6, rowH - 16);
      const blockY = y + 13;
      const gap = stripW / owners >= 3 ? 1 : 0;
      const blockW = (stripW - gap * (owners - 1)) / owners;
      const shade = withAlpha(SEMANTIC.tlsPulse, 0.3 + 0.55 * level);
      if (blockW < 1) {
        this.ctx.fillStyle = shade;
        this.ctx.fillRect(stripX, blockY, stripW, blockH);
        this.ctx.strokeStyle = withAlpha(SURFACE.canvas, 0.5);
        this.ctx.lineWidth = 1;
        // Tick marks per node keep the band from reading as one wide pool.
        const nodes = Math.max(1, Math.round(sim.cfg.fabric.nodes));
        for (let n = 1; n < nodes && nodes <= 64; n++) {
          const x = Math.round(stripX + (stripW * n) / nodes) + 0.5;
          this.ctx.beginPath(); this.ctx.moveTo(x, blockY); this.ctx.lineTo(x, blockY + blockH); this.ctx.stroke();
        }
      } else {
        this.ctx.fillStyle = shade;
        for (let o = 0; o < owners; o++) {
          this.ctx.fillRect(stripX + o * (blockW + gap), blockY, blockW, blockH);
        }
      }
    }
    if (shown < s.links.length) {
      ctxText(this.ctx, `+${s.links.length - shown} Links, same shape`, r.x + 10, r.y + r.h - 11, 9, SURFACE.textDim);
    }
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

    const bottomSpace = endpointBottomSpace(r);
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
    if (bottomSpace < 86) return;

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
    this.ctx.fillStyle = withAlpha(SEMANTIC.tlsPulse, 0.5 + 0.3 * Math.sin(sim.now / 160));
    this.ctx.fillRect(barX + barW * ((s.busy + s.idle) / denom), barY, barW * (s.pending / denom), barH);
    this.ctx.strokeStyle = SEMANTIC.timeout;
    this.ctx.setLineDash([3, 3]);
    const desiredX = barX + barW * Math.min(1, s.desiredConnections / denom);
    this.ctx.beginPath(); this.ctx.moveTo(desiredX, barY - 5); this.ctx.lineTo(desiredX, barY + barH + 5); this.ctx.stroke();
    this.ctx.setLineDash([]);
    ctxText(this.ctx, `busy ${fmt(s.busy)} · idle ${fmt(s.idle)} · connecting ${fmt(s.pending)}`, barX, barY + barH + 17, 9, SURFACE.text);
    ctxText(this.ctx,
      `idle ${idleLabel(sim)} · max idle ${sim.cfg.pool.maxIdlePerKey === 0 ? '∞' : sim.cfg.pool.maxIdlePerKey}/key · cap ${sim.cfg.pool.policy === 'hyper' ? 'none' : `${sim.cfg.pool.maxConnectionsPerKey}/key`}`,
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
    const usableH = Math.max(8, r.h - 100);
    const maxShown = Math.min(24, n, Math.max(1, Math.floor(usableH / 8)));
    const rowH = Math.max(8, Math.min(22, usableH / maxShown));
    for (let i = 0; i < maxShown; i++) {
      const responder = s.responders[i];
      const y = startY + i * rowH;
      ctxText(this.ctx, responder.ip, r.x + 9, y + rowH * 0.7, 8, SURFACE.textDim);
      const bx = r.x + Math.min(96, r.w * 0.42);
      const bw = Math.max(12, r.w - (bx - r.x) - 52);
      const bh = Math.max(4, rowH - 5);
      this.ctx.fillStyle = SURFACE.panelRaised;
      this.ctx.fillRect(bx, y + 2, bw, bh);
      this.ctx.fillStyle = withAlpha(loadColor(responder.pressure), 0.88);
      this.ctx.fillRect(bx, y + 2, bw * Math.min(1, responder.pressure), bh);
      if (responder.pressure >= 0.999) {
        // A full instance flickers: connects landing here are being reset.
        const flick = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(sim.now / 90 + i));
        this.ctx.fillStyle = withAlpha(SEMANTIC.timeout, flick);
        this.ctx.fillRect(bx + bw - 3, y + 2, 3, bh);
      }
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, fmt(responder.estimatedConnections), r.x + r.w - 8, y + rowH * 0.7, 9, loadColor(responder.pressure));
      this.ctx.textAlign = 'left';
    }
    ctxText(this.ctx, `hottest ${fmt(s.hottestResponder)} / ${fmt(sim.cfg.responder.connectionLimit)}`, r.x + 10, r.y + r.h - 14, 12,
      loadColor(s.responderPressure), true);
  }

  /**
   * The socket field: one column per simulated pool key, grouped by the
   * responder IP the key targets. Busy sockets sit at the bottom, idle sockets
   * stack above them in LIFO order (the freshest nearest the busy ones) and fade
   * as they age toward the idle timeout, and connects in flight hover on top.
   */
  private drawSocketField(sim: PoolSimulation, r: Rect): void {
    const s = sim.snapshot();
    this.panel(r, SURFACE.border);
    const keys = s.sampled;
    const weight = keys.length > 0 ? keys[0].weight : 1;
    const timeout = sim.cfg.pool.idleTimeoutMs;
    const S = s.streamsPerConnection;

    ctxText(this.ctx, 'POOL SOCKETS', r.x + 10, r.y + 17, 13, SURFACE.textFaint, true);
    const scope = keys.length >= s.poolKeys
      ? `every one of ${fmt(s.poolKeys)} keys`
      : `${keys.length} of ${fmt(s.poolKeys)} keys sampled · each column stands for ${weight >= 100 ? fmt(weight) : weight.toFixed(weight % 1 === 0 ? 0 : 1)} keys`;
    ctxText(this.ctx, scope, r.x + 118, r.y + 17, 9, SURFACE.textDim);

    const counts = keys.map((k) => k.conns).sort((a, b) => a - b);
    const median = counts.length > 0 ? counts[Math.floor(counts.length / 2)] : 0;
    const peak = counts.length > 0 ? counts[counts.length - 1] : 0;
    this.ctx.textAlign = 'right';
    ctxText(this.ctx, `median ${median} · max ${peak} sockets / key · idle timeout ${idleLabel(sim)}`, r.x + r.w - 10, r.y + 17, 10, SURFACE.text);
    this.ctx.textAlign = 'left';

    const plotX = r.x + 10;
    const plotY = r.y + 26;
    const plotW = r.w - 20;
    const groups = this.fieldGroups(s);
    const labelRow = groups.length > 1 ? 11 : 0;
    const plotH = r.h - 26 - 18 - labelRow;
    if (plotH < 20 || keys.length === 0) return;

    let scaleMax = 4;
    for (const k of keys) scaleMax = Math.max(scaleMax, k.conns + k.pendingConns);
    const cap = sim.cfg.pool.policy === 'bounded' ? sim.cfg.pool.maxConnectionsPerKey : 0;
    if (cap > 0) scaleMax = Math.max(scaleMax, cap);
    scaleMax = Math.ceil(scaleMax * 1.08);
    const cellH = plotH / scaleMax;
    const discrete = cellH >= 3;
    const groupGap = groups.length > 1 ? 4 : 0;
    const colW = (plotW - groupGap * (groups.length - 1)) / keys.length;
    const barW = colW >= 3 ? colW - 1 : Math.max(0.8, colW);
    const baseY = plotY + plotH;

    // Scale ticks.
    this.ctx.strokeStyle = SURFACE.grid;
    this.ctx.lineWidth = 1;
    for (const tick of [0.5, 1]) {
      const y = Math.round(baseY - plotH * tick) + 0.5;
      this.ctx.beginPath(); this.ctx.moveTo(plotX, y); this.ctx.lineTo(plotX + plotW, y); this.ctx.stroke();
    }
    ctxText(this.ctx, String(scaleMax), plotX + 2, plotY + 8, 8, SURFACE.textFaint);
    ctxText(this.ctx, String(Math.round(scaleMax / 2)), plotX + 2, baseY - plotH / 2 - 3, 8, SURFACE.textFaint);

    let x = plotX;
    const pulse = 0.5 + 0.5 * Math.sin(sim.now / 160);
    for (const group of groups) {
      const groupX = x;
      for (const k of group.keys) {
        let level = 0;
        if (k.busyConns > 0) {
          this.fillCells(x, baseY, barW, cellH, level, k.busyConns, discrete, withAlpha(SEMANTIC.success, 0.9));
          level += k.busyConns;
        }
        for (let i = k.idle.length - 1; i >= 0; i--) {
          const run = k.idle[i];
          const age = Math.max(0, sim.now - run.since);
          const fresh = timeout > 0 ? Math.max(0, 1 - age / timeout) : 0.55;
          const alpha = 0.14 + 0.72 * fresh;
          this.fillCells(x, baseY, barW, cellH, level, run.count, discrete, withAlpha(SEMANTIC.inFlight, alpha));
          level += run.count;
        }
        if (k.pendingConns > 0) {
          const y0 = baseY - (level + k.pendingConns) * cellH;
          const hgt = k.pendingConns * cellH;
          this.ctx.strokeStyle = withAlpha(SEMANTIC.tlsPulse, 0.45 + 0.45 * pulse);
          this.ctx.setLineDash([2, 2]);
          this.ctx.strokeRect(x + 0.5, y0 + 0.5, Math.max(1, barW - 1), Math.max(1, hgt - 1));
          this.ctx.setLineDash([]);
        }
        x += colW;
      }
      if (groups.length > 1 && x - groupX >= 30 && group.ip >= 0) {
        const responder = s.responders[group.ip];
        ctxText(this.ctx, responder ? responder.ip : `R${group.ip + 1}`, groupX + 1, baseY + 10, 8, SURFACE.textFaint);
      }
      x += groupGap;
    }

    // Reference lines: the mean concurrency a key needs, and the active cap.
    const meanNeed = keys.reduce((sum, k) => sum + k.meanConcurrency, 0) / keys.length / S;
    const meanY = baseY - meanNeed * cellH;
    this.ctx.setLineDash([4, 3]);
    this.ctx.strokeStyle = withAlpha(SEMANTIC.success, 0.7);
    this.ctx.beginPath(); this.ctx.moveTo(plotX, meanY); this.ctx.lineTo(plotX + plotW, meanY); this.ctx.stroke();
    if (cap > 0) {
      const capY = baseY - cap * cellH;
      this.ctx.strokeStyle = withAlpha(SEMANTIC.shed, 0.75);
      this.ctx.beginPath(); this.ctx.moveTo(plotX, capY); this.ctx.lineTo(plotX + plotW, capY); this.ctx.stroke();
      this.ctx.textAlign = 'right';
      ctxText(this.ctx, `cap ${cap}/key`, plotX + plotW - 2, capY - 3, 8, SEMANTIC.shed);
      this.ctx.textAlign = 'left';
    }
    this.ctx.setLineDash([]);
    this.ctx.textAlign = 'right';
    ctxText(this.ctx, `mean need ${meanNeed.toFixed(meanNeed >= 10 ? 0 : 2)}/key`, plotX + plotW - 2, meanY < plotY + 12 ? meanY + 10 : meanY - 3, 8, SEMANTIC.success);
    this.ctx.textAlign = 'left';

    // Legend.
    const ly = r.y + r.h - 6;
    let lx = r.x + 10;
    const swatch = (color: string, label: string, hollow = false) => {
      if (hollow) {
        this.ctx.strokeStyle = color; this.ctx.setLineDash([2, 2]); this.ctx.strokeRect(lx + 0.5, ly - 7.5, 8, 7); this.ctx.setLineDash([]);
      } else {
        this.ctx.fillStyle = color; this.ctx.fillRect(lx, ly - 8, 9, 8);
      }
      ctxText(this.ctx, label, lx + 13, ly, 8, SURFACE.textDim);
      lx += 13 + this.ctx.measureText(label).width + 12;
    };
    swatch(withAlpha(SEMANTIC.success, 0.9), 'busy');
    swatch(withAlpha(SEMANTIC.inFlight, 0.86), 'idle · fresh');
    swatch(withAlpha(SEMANTIC.inFlight, 0.2), timeout > 0 ? 'idle · about to expire' : 'idle · never expires');
    swatch(withAlpha(SEMANTIC.tlsPulse, 0.8), 'connecting', true);
    if (groups.length > 1) ctxText(this.ctx, 'columns grouped by responder IP', lx + 4, ly, 8, SURFACE.textFaint);
  }

  private fillCells(x: number, baseY: number, w: number, cellH: number, from: number, count: number, discrete: boolean, color: string): void {
    this.ctx.fillStyle = color;
    if (!discrete) {
      this.ctx.fillRect(x, baseY - (from + count) * cellH, w, count * cellH);
      return;
    }
    for (let i = 0; i < count; i++) {
      const y = baseY - (from + i + 1) * cellH;
      this.ctx.fillRect(x, y + 1, w, cellH - 1);
    }
  }

  private fieldGroups(s: PoolSnapshot): FieldGroup[] {
    if (this.groupsFor === s.sampled) return this.groups;
    const byIp = new Map<number, PoolSampledKeyView[]>();
    for (const k of s.sampled) {
      const list = byIp.get(k.ip) ?? [];
      list.push(k);
      byIp.set(k.ip, list);
    }
    this.groups = [...byIp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ip, keys]) => ({ ip, keys: keys.slice().sort((a, b) => a.link - b.link || a.endpointId - b.endpointId) }));
    this.groupsFor = s.sampled;
    return this.groups;
  }

  /** Live sockets attributed to each Link, from the sampled keys that belong to it. */
  private connectionsPerLink(s: PoolSnapshot): number[] {
    const out = new Array<number>(s.links.length).fill(0);
    let attributed = false;
    for (const k of s.sampled) {
      if (k.link >= 0 && k.link < out.length) {
        out[k.link] += k.conns * k.weight;
        attributed = true;
      }
    }
    return attributed ? out : [];
  }

  private drawFlow(sim: PoolSimulation, fabric: Rect, links: Rect, endpoints: Rect, responders: Rect): void {
    const s = sim.snapshot();
    const phase = (sim.now / 450) % 1;
    // Dot density follows offered traffic; each dot keeps its own jittered lane
    // and spacing so the stream reads as traffic rather than a metronome.
    const dots = Math.max(3, Math.min(28, Math.round(Math.log10(Math.max(1, s.effectiveRate)) * 5)));
    const lines: Array<[number, number, number, number, string]> = [
      [fabric.x + fabric.w, fabric.y + fabric.h * 0.5, links.x, links.y + links.h * 0.5, SEMANTIC.inFlight],
      [endpoints.x + endpoints.w, endpoints.y + endpoints.h * 0.5, responders.x, responders.y + responders.h * 0.5, s.limitActive ? SEMANTIC.timeout : SEMANTIC.success],
    ];
    lines.forEach(([x1, y1, x2, y2, color], lineIndex) => {
      this.ctx.strokeStyle = withAlpha(color, 0.35);
      this.ctx.lineWidth = 2;
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2); this.ctx.stroke();
      for (let i = 0; i < dots; i++) {
        const j1 = hash(i * 7 + lineIndex * 131);
        const j2 = hash(i * 13 + 5 + lineIndex * 97);
        const t = (phase + i / dots + (j1 - 0.5) * (0.6 / dots)) % 1;
        const lane = (j2 - 0.5) * 10;
        this.ctx.fillStyle = withAlpha(color, 0.55 + 0.45 * j2);
        this.ctx.beginPath();
        this.ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t + lane, 1.4 + j1 * 1.2, 0, Math.PI * 2);
        this.ctx.fill();
      }
    });

    // Resets bounce off the responder edge as short red ticks.
    if (s.resetsPerSec > 0.5) {
      const [, , x2, y2] = lines[1];
      const count = Math.max(1, Math.min(6, Math.round(s.resetsPerSec / 25)));
      for (let i = 0; i < count; i++) {
        const blink = (Math.sin(sim.now / 70 + i * 1.7) + 1) / 2;
        const dx = 6 + i * 5;
        const dy = (hash(i * 3 + 1) - 0.5) * 24;
        this.ctx.strokeStyle = withAlpha(SEMANTIC.timeout, 0.3 + 0.6 * blink);
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(x2 - dx - 3, y2 + dy - 3); this.ctx.lineTo(x2 - dx + 3, y2 + dy + 3);
        this.ctx.moveTo(x2 - dx + 3, y2 + dy - 3); this.ctx.lineTo(x2 - dx - 3, y2 + dy + 3);
        this.ctx.stroke();
      }
      this.ctx.lineWidth = 1;
    }

    // Actual Link→endpoint membership. Shared endpoints visibly collect lines
    // from several Links; distinct endpoints receive exactly one.
    const shownLinks = Math.min(s.links.length, this.maxRows(links, 72, 25, 14));
    const endpointSpace = endpointBottomSpace(endpoints);
    const shownEndpoints = Math.min(s.endpoints.length, this.maxRows(endpoints, 72, 28, endpointSpace));
    const linkRowH = Math.max(18, Math.min(25, (links.h - 94) / Math.max(1, shownLinks)));
    const endpointRowH = Math.max(20, Math.min(28, (endpoints.h - 72 - endpointSpace) / Math.max(1, shownEndpoints)));
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
    this.ctx.lineWidth = 1;
  }

  private drawOutcome(sim: PoolSimulation, x: number, y: number, w: number, h: number): void {
    const s = sim.snapshot();
    this.panel({ x, y, w, h }, s.limitActive ? SEMANTIC.timeout : SURFACE.border);
    const perKey = s.poolKeys > 0 ? s.established / s.poolKeys : 0;
    const items: Array<[string, string, string]> = [
      ['ESTABLISHED', fmt(s.established), SEMANTIC.connEstablished],
      ['SOCKETS / KEY', perKey.toFixed(perKey >= 100 ? 0 : perKey >= 10 ? 1 : 2), SEMANTIC.inFlight],
      ['HOTTEST RESPONDER', `${fmt(s.hottestResponder)} / ${fmt(sim.cfg.responder.connectionLimit)}`, loadColor(s.responderPressure)],
      ['SERVED', `${(s.arrivalRate > 0 ? Math.min(100, 100 * s.servedRate / s.arrivalRate) : 100).toFixed(1)}%`, SEMANTIC.success],
      ['RESETS /s', fmt(s.resetsPerSec), s.resetsPerSec > 0.5 ? SEMANTIC.timeout : SURFACE.textDim],
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
    this.ctx.lineWidth = 1;
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

/** Room the endpoint column keeps under its rows for the busy/idle bar; none when the pane is short. */
function endpointBottomSpace(r: Rect): number {
  return r.h >= 200 ? 86 : 12;
}

function ctxText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, bold = false): void {
  ctx.font = `${bold ? 700 : 500} ${size}px ${bold ? '"Big Shoulders", "Arial Narrow"' : '"IBM Plex Mono"'}, monospace`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Deterministic pseudo-random in [0, 1) for a small integer, for jitter. */
function hash(i: number): number {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtDuration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
}

function idleLabel(sim: PoolSimulation): string {
  return sim.cfg.pool.idleTimeoutMs === 0 ? '∞' : fmtDuration(sim.cfg.pool.idleTimeoutMs);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function amplificationText(s: PoolSnapshot): string {
  if (s.littleLawRequired <= 1e-7) return '—';
  return `${s.connectionAmplification.toFixed(s.connectionAmplification >= 10 ? 1 : 2)}×`;
}

function amplificationColor(s: PoolSnapshot): string {
  if (s.littleLawRequired <= 1e-7) return SURFACE.textDim;
  const ratio = s.connectionAmplification;
  if (ratio < 0.95) return SEMANTIC.timeout;
  if (ratio <= 1.25) return SEMANTIC.success;
  if (ratio <= 2) return SEMANTIC.shed;
  return SEMANTIC.timeout;
}
