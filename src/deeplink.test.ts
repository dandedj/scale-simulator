/**
 * Deep-link invariants. The guards that matter: a link carries only what differs
 * from its scenario, an override lands on the right field with the right type,
 * a stale or hostile path is ignored rather than corrupting the config, and a
 * setter's dot-path is recovered correctly — that last one is what keeps the
 * options reference and the link parser naming the same fields.
 */

import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  applyPath,
  diff,
  encode,
  flatten,
  PANE_B_PREFIX,
  pathOfSetter,
  PROBE_NUMBER,
  PROBE_STRING,
} from './deeplink';
import { baseConfig as scalingBase, cloneScalingConfig } from './scaling/engine/presets';
import { describeScalingOptions } from './scaling/ui/controls';
import { basePoolConfig } from './pools/engine/presets';
import { describePoolOptions } from './pools/ui/controls';

describe('flatten and diff', () => {
  it('addresses nested fields and array entries by dot-path', () => {
    const flat = flatten(scalingBase());
    expect(flat['capacity.targetUtilization']).toBe(0.6);
    expect(flat['launch.bakeMs']).toBe(300_000);
    expect(flat['policy.steps.1.adjustment']).toBe(30);
    expect(flat['traffic.shape']).toBe('ramp');
  });

  it('reports only what changed', () => {
    const a = scalingBase();
    const b = cloneScalingConfig(a);
    b.launch.bakeMs = 600_000;
    b.policy.steps[2].adjustment = 90;
    expect(diff(a, b)).toEqual({ 'launch.bakeMs': 600_000, 'policy.steps.2.adjustment': 90 });
    expect(diff(a, cloneScalingConfig(a))) .toEqual({});
  });
});

describe('applying overrides', () => {
  it('coerces to the type already in the config', () => {
    const c = scalingBase();
    expect(applyPath(c, 'launch.bakeMs', '600000')).toBe(true);
    expect(c.launch.bakeMs).toBe(600_000);
    expect(applyPath(c, 'traffic.shape', 'steady')).toBe(true);
    expect(c.traffic.shape).toBe('steady');
    expect(applyPath(c, 'policy.steps.0.adjustment', '25')).toBe(true);
    expect(c.policy.steps[0].adjustment).toBe(25);
  });

  /** A link outlives the config it was written against; it must degrade quietly. */
  it('ignores unknown paths, bad numbers, and paths through nothing', () => {
    const c = scalingBase();
    const before = JSON.stringify(c);
    expect(applyPath(c, 'launch.noSuchField', '1')).toBe(false);
    expect(applyPath(c, 'nope.deeper.still', '1')).toBe(false);
    expect(applyPath(c, 'launch.bakeMs', 'not-a-number')).toBe(false);
    expect(applyPath(c, '__proto__.polluted', 'yes')).toBe(false);
    expect(JSON.stringify(c)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('routes bare paths to pane A and b.-prefixed ones to pane B', () => {
    const a = scalingBase();
    const b = scalingBase();
    const params = new URLSearchParams('m=scaling&s=x&launch.bakeMs=60000&b.launch.bakeMs=900000');
    applyOverrides(a, params, '');
    applyOverrides(b, params, PANE_B_PREFIX);
    expect(a.launch.bakeMs).toBe(60_000);
    expect(b.launch.bakeMs).toBe(900_000);
  });

  it('never treats a reserved key as a config path', () => {
    const c = scalingBase();
    const before = JSON.stringify(c);
    applyOverrides(c, new URLSearchParams('m=scaling&s=baseline&cmp=1&run=1'), '');
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe('encoding', () => {
  it('carries the scenario, the comparison state, and only the differences', () => {
    const q = encode({
      mode: 'scaling',
      scenario: 'sustained',
      scenarioB: 'long-bake',
      compare: true,
      run: true,
      overrides: { 'launch.bakeMs': 60_000 },
      overridesB: { 'launch.bakeMs': 900_000 },
    });
    const p = new URLSearchParams(q);
    expect(p.get('m')).toBe('scaling');
    expect(p.get('s')).toBe('sustained');
    expect(p.get('s2')).toBe('long-bake');
    expect(p.get('cmp')).toBe('1');
    expect(p.get('run')).toBe('1');
    expect(p.get('launch.bakeMs')).toBe('60000');
    expect(p.get('b.launch.bakeMs')).toBe('900000');
  });

  it('leaves out pane B entirely when not comparing', () => {
    const q = encode({ mode: 'scaling', scenario: 'baseline', scenarioB: 'long-bake', overridesB: { x: 1 } });
    const p = new URLSearchParams(q);
    expect(p.get('s2')).toBeNull();
    expect(p.get('cmp')).toBeNull();
    expect(p.get('b.x')).toBeNull();
  });
});

describe('recovering a setter’s path', () => {
  it('finds the field a setter writes, for every value type', () => {
    const base = scalingBase();
    expect(pathOfSetter(base, (c, v) => (c.launch.bakeMs = v), PROBE_NUMBER)).toBe('launch.bakeMs');
    expect(pathOfSetter(base, (c, v) => (c.traffic.shape = v), PROBE_STRING)).toBe('traffic.shape');
    expect(pathOfSetter(base, (c, v) => (c.policy.steps[2].adjustment = v), PROBE_NUMBER)).toBe(
      'policy.steps.2.adjustment',
    );
  });

  it('leaves the config it probed untouched', () => {
    const base = scalingBase();
    const before = JSON.stringify(base);
    pathOfSetter(base, (c, v) => (c.launch.bakeMs = v), PROBE_NUMBER);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('the options reference and the link parser agree', () => {
  /**
   * The reference publishes a dot-path for every setting and tells people to put
   * it in a URL. If a path it prints is one `applyPath` rejects, the page is
   * lying — so check every one of them against a real config.
   */
  it('every documented scaling path is one a link can actually set', () => {
    const docs = describeScalingOptions();
    expect(docs.length).toBeGreaterThan(20);
    for (const doc of docs) {
      expect(doc.path, `${doc.group} / ${doc.label} has no path`).not.toBeNull();
      const cfg = scalingBase();
      const flat = flatten(cfg);
      expect(Object.hasOwn(flat, doc.path!), `${doc.path} is not a config field`).toBe(true);
      // Round-trip a value of the right shape through the parser.
      const sample = typeof flat[doc.path!] === 'string' ? String(flat[doc.path!]) : '1';
      expect(applyPath(cfg, doc.path!, sample), `${doc.path} was rejected`).toBe(true);
    }
  });

  it('describes every group the panel renders, with its defaults formatted', () => {
    const docs = describeScalingOptions();
    const groups = new Set(docs.map((d) => d.group));
    expect(groups).toContain('Demand');
    expect(groups).toContain('Scaling policy');
    expect(groups).toContain('Launch step & bake');
    expect(groups).toContain('Scale-up stages');
    // The bake knob carries its label, its formatted default, and its guidance.
    const bake = docs.find((d) => d.path === 'launch.bakeMs');
    expect(bake?.label).toBe('Bake (instance warmup)');
    expect(bake?.value).toBe('5m');
    expect(bake?.range).toEqual({ min: 0, max: 900_000, step: 30_000 });
    expect(bake?.info?.what).toBeTruthy();
    expect(bake?.info?.how).toBeTruthy();
    expect(bake?.info?.expect).toBeTruthy();
  });

  it('accepts every documented outbound-pool path', () => {
    const docs = describePoolOptions();
    expect(docs.length).toBeGreaterThan(20);
    for (const doc of docs) {
      expect(doc.path, `${doc.group} / ${doc.label} has no path`).not.toBeNull();
      const cfg = basePoolConfig();
      const flat = flatten(cfg);
      expect(Object.hasOwn(flat, doc.path!), `${doc.path} is not a config field`).toBe(true);
      const sample = typeof flat[doc.path!] === 'string' ? String(flat[doc.path!]) : '1';
      expect(applyPath(cfg, doc.path!, sample), `${doc.path} was rejected`).toBe(true);
    }
  });
});
