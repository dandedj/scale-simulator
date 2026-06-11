/**
 * Scene geometry: where nodes sit and where connection lanes run.
 * Everything derives from the canvas CSS size and current entity counts,
 * recomputed each frame (cheap) so live count changes just work.
 */

import type { Simulation } from '../engine/simulation';

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export interface SceneLayout {
  width: number;
  height: number;
  clients: NodeBox[];
  fabric: NodeBox;
  downstreams: NodeBox[];
  /** Where the graveyard pile sits (failed requests accumulate here). */
  graveyard: { x: number; y: number; w: number };
}

const MARGIN_Y = 26;

export function computeLayout(sim: Simulation, width: number, height: number): SceneLayout {
  const clientCount = sim.clients.length;
  const dsCount = sim.downstreams.length;

  const clientW = Math.min(150, width * 0.16);
  const clientH = Math.min(58, (height - 2 * MARGIN_Y) / Math.max(1, clientCount) - 10);
  const clientX = width * 0.025;

  const fabricW = Math.min(240, width * 0.24);
  const fabricH = Math.min(height * 0.74, 460);
  const fabricX = width * 0.5 - fabricW / 2;
  const fabricY = (height - fabricH) / 2 - 8;

  const dsW = Math.min(160, width * 0.17);
  const dsH = Math.min(86, (height - 2 * MARGIN_Y) / Math.max(1, dsCount) - 12);
  const dsX = width * 0.975 - dsW;

  const clients: NodeBox[] = [];
  for (let i = 0; i < clientCount; i++) {
    const slotH = (height - 2 * MARGIN_Y) / clientCount;
    const y = MARGIN_Y + slotH * i + (slotH - clientH) / 2;
    clients.push(box(clientX, y, clientW, clientH));
  }

  const downstreams: NodeBox[] = [];
  for (let i = 0; i < dsCount; i++) {
    const slotH = (height - 2 * MARGIN_Y) / dsCount;
    const y = MARGIN_Y + slotH * i + (slotH - dsH) / 2;
    downstreams.push(box(dsX, y, dsW, dsH));
  }

  const fabric = box(fabricX, fabricY, fabricW, fabricH);
  return {
    width,
    height,
    clients,
    fabric,
    downstreams,
    graveyard: { x: fabricX - 10, y: fabricY + fabricH + 14, w: fabricW + 20 },
  };
}

function box(x: number, y: number, w: number, h: number): NodeBox {
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/**
 * Lane endpoints for a client connection: fans connections of one client
 * across a small vertical spread on both the client and fabric edges.
 */
export function clientLane(
  layout: SceneLayout,
  clientIdx: number,
  laneIdx: number,
  laneCount: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const c = layout.clients[clientIdx] ?? layout.clients[0];
  const f = layout.fabric;
  const spreadC = Math.min(c.h - 12, Math.max(8, laneCount * 5));
  const tC = laneCount <= 1 ? 0.5 : laneIdx / (laneCount - 1);
  const y0 = c.cy - spreadC / 2 + spreadC * tC;
  // Fabric-side fan: distribute this client's lanes inside its share of the
  // fabric's left edge so bundles from different clients don't overlap.
  const clientCount = layout.clients.length;
  const bandH = (f.h - 90) / Math.max(1, clientCount);
  const bandTop = f.y + 70 + bandH * clientIdx;
  const y1 = bandTop + bandH * (laneCount <= 1 ? 0.5 : tC);
  return { x0: c.x + c.w, y0, x1: f.x, y1 };
}

/** Lane endpoints for a fabric→downstream connection. */
export function dsLane(
  layout: SceneLayout,
  dsIdx: number,
  laneIdx: number,
  laneCount: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const f = layout.fabric;
  const d = layout.downstreams[dsIdx] ?? layout.downstreams[0];
  const dsCount = layout.downstreams.length;
  const bandH = (f.h - 90) / Math.max(1, dsCount);
  const bandTop = f.y + 70 + bandH * dsIdx;
  const t = laneCount <= 1 ? 0.5 : laneIdx / (laneCount - 1);
  const y0 = bandTop + bandH * t;
  const spreadD = Math.min(d.h - 12, Math.max(8, laneCount * 4));
  const y1 = d.cy - spreadD / 2 + spreadD * t;
  return { x0: f.x + f.w, y0, x1: d.x, y1 };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
