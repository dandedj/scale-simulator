/**
 * The timeline window's state machine, which comparison mode's two timelines
 * share. The states overlap in ways that are easy to get subtly wrong — a held
 * window must not be re-pinned by the live edge arriving, and a scrolled one
 * must be — so each transition is pinned here rather than left to the canvas.
 */

import { describe, expect, it } from 'vitest';
import { TimelineWindow } from './timeline';

/** Fifteen minutes is the default span; runs are given in ms of sim time. */
const DEFAULT = 900_000;

describe('following the live edge', () => {
  it('starts pinned, and keeps the window flush with the run', () => {
    const w = new TimelineWindow();
    expect(w.isFollowing()).toBe(true);
    expect(w.resolve(2_000_000)).toBe(2_000_000 - DEFAULT);
    expect(w.resolve(3_000_000)).toBe(3_000_000 - DEFAULT);
  });

  it('sits at zero until the run is longer than the window', () => {
    const w = new TimelineWindow();
    expect(w.resolve(300_000)).toBe(0);
    expect(w.canPageBack()).toBe(false);
  });
});

describe('scrolling back', () => {
  it('drops the pin and stays where it was put', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.pageBy(-0.5);
    expect(w.isFollowing()).toBe(false);
    const start = w.resolve(2_000_000);
    expect(start).toBeCloseTo(2_000_000 - DEFAULT - DEFAULT / 2, 3);
    expect(w.canPageBack()).toBe(true);
  });

  /** Paging back to the edge re-pins, so ● LIVE is not the only way home. */
  it('re-pins on its own once paged forward to the edge', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.pageBy(-0.5);
    w.resolve(2_000_000);
    w.pageBy(0.5);
    w.resolve(2_000_000);
    expect(w.isFollowing()).toBe(true);
  });

  it('never scrolls past the start of the run', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    for (let i = 0; i < 20; i++) w.pageBy(-1);
    expect(w.resolve(2_000_000)).toBe(0);
  });

  it('goLive brings it back', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.pageBy(-0.5);
    w.goLive();
    expect(w.isFollowing()).toBe(true);
    expect(w.resolve(2_000_000)).toBe(2_000_000 - DEFAULT);
  });
});

describe('holding', () => {
  /**
   * The distinction that has to hold: a held window stays put while the run
   * runs on past it. A merely-scrolled one would be caught and re-pinned by the
   * live edge, which is exactly what hold exists to prevent.
   */
  it('stays put while the run travels past it', () => {
    const w = new TimelineWindow();
    const at = w.resolve(2_000_000);
    w.setHeld(true);
    expect(w.isHeld()).toBe(true);
    expect(w.isFollowing()).toBe(false);
    expect(w.resolve(3_000_000)).toBe(at);
    expect(w.resolve(9_000_000)).toBe(at);
  });

  it('holds from the live edge when pressed while following', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.setHeld(true);
    expect(w.resolve(5_000_000)).toBe(2_000_000 - DEFAULT);
  });

  it('releasing it follows again', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.setHeld(true);
    w.resolve(4_000_000);
    w.setHeld(false);
    expect(w.isFollowing()).toBe(true);
    expect(w.resolve(4_000_000)).toBe(4_000_000 - DEFAULT);
  });

  it('goLive releases a hold too', () => {
    const w = new TimelineWindow();
    w.resolve(2_000_000);
    w.setHeld(true);
    w.goLive();
    expect(w.isHeld()).toBe(false);
    expect(w.isFollowing()).toBe(true);
  });
});

describe('span and zoom', () => {
  it('fitting all puts the whole run on the axis and reports as live', () => {
    const w = new TimelineWindow();
    w.setWindow('all');
    expect(w.resolve(5_000_000)).toBe(0);
    expect(w.windowMs).toBe(5_000_000);
    expect(w.isFitAll()).toBe(true);
    // Nothing to follow away from, and nothing to page or hold.
    expect(w.isFollowing()).toBe(true);
    expect(w.canPageBack()).toBe(false);
  });

  it('a fixed span replaces fit-all and follows again', () => {
    const w = new TimelineWindow();
    w.setWindow('all');
    w.resolve(5_000_000);
    w.setWindow(300_000);
    expect(w.isFitAll()).toBe(false);
    expect(w.resolve(5_000_000)).toBe(5_000_000 - 300_000);
  });

  it('zoom keeps whatever is under the cursor in place', () => {
    const w = new TimelineWindow();
    w.resolve(4_000_000);
    w.pageBy(-1); // step off the live edge so zoom anchors rather than re-pins
    const start = w.resolve(4_000_000);
    const anchor = start + 0.5 * DEFAULT;
    w.zoom(-1, 0.5); // one stop narrower
    const after = w.resolve(4_000_000);
    expect(after + 0.5 * w.windowMs).toBeCloseTo(anchor, 3);
    expect(w.windowMs).toBeLessThan(DEFAULT);
  });

  it('zoom and pan do nothing while fitting all', () => {
    const w = new TimelineWindow();
    w.setWindow('all');
    w.resolve(5_000_000);
    w.zoom(-1, 0.5);
    w.panBy(-100_000);
    expect(w.isFitAll()).toBe(true);
    expect(w.resolve(5_000_000)).toBe(0);
  });
});
