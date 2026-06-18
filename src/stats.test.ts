import { describe, expect, it } from 'vitest';
import { compareSuccessRates, normalCdf } from './stats';

describe('normalCdf', () => {
  it('matches known standard-normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(2.5758)).toBeCloseTo(0.995, 3);
  });
});

describe('compareSuccessRates', () => {
  it('withholds a verdict until both samples are large enough', () => {
    const r = compareSuccessRates(5, 5, 5, 0);
    expect(r.enough).toBe(false);
    expect(r.better).toBeNull();
  });

  it('finds no significance for a tiny gap on a modest sample', () => {
    // 90% vs 89% over 1000 trials each — well within noise.
    const r = compareSuccessRates(1000, 900, 1000, 890);
    expect(r.confidence).toBe(0);
    expect(r.better).toBeNull();
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it('flags a real, large gap as highly significant and names the winner', () => {
    // 95% vs 80% over 1000 trials each.
    const r = compareSuccessRates(1000, 950, 1000, 800);
    expect(r.confidence).toBe(0.99);
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.better).toBe('A'); // A's rate is higher
    expect(r.deltaPp).toBeCloseTo(-15, 0); // B − A = −15pp
  });

  it('a small gap becomes significant once the sample is large enough', () => {
    const small = compareSuccessRates(200, 180, 200, 172); // 90% vs 86%
    const large = compareSuccessRates(20000, 18000, 20000, 17200); // same rates, 100× n
    expect(small.confidence).toBe(0);
    expect(large.confidence).toBeGreaterThanOrEqual(0.95);
    expect(large.better).toBe('A');
  });

  it('reports no difference when both sims are identical', () => {
    const r = compareSuccessRates(1000, 500, 1000, 500);
    expect(r.deltaPp).toBeCloseTo(0, 6);
    expect(r.confidence).toBe(0);
    expect(r.better).toBeNull();
  });
});
