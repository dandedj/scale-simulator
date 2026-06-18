import { describe, expect, it } from 'vitest';
import { compareMeans, compareQuantiles, compareSuccessRates, normalCdf } from './stats';

/** Sorted ramp [base, base+1, …, base+n-1] — a fixed sample, no RNG. */
function ramp(n: number, base = 0): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

/** Build (n, sum, sumSq) moments from an explicit sample array. */
function moments(xs: number[]): [number, number, number] {
  let sum = 0;
  let sumSq = 0;
  for (const x of xs) {
    sum += x;
    sumSq += x * x;
  }
  return [xs.length, sum, sumSq];
}

/** Moments for n i.i.d.-ish points alternating mean±spread (fixed variance, no RNG). */
function synthMoments(n: number, mean: number, spread: number): [number, number, number] {
  const xs = Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? spread : -spread));
  return moments(xs);
}

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

describe('compareMeans (Welch t-test)', () => {
  it('withholds a verdict below the minimum sample', () => {
    const a = synthMoments(5, 100, 10);
    const b = synthMoments(5, 130, 10);
    const r = compareMeans(...a, ...b);
    expect(r.enough).toBe(false);
  });

  it('finds no significance for overlapping distributions', () => {
    // Means 100 vs 101 with spread ±40 over 500 points: swamped by variance.
    const a = synthMoments(500, 100, 40);
    const b = synthMoments(500, 101, 40);
    const r = compareMeans(...a, ...b);
    expect(r.confidence).toBe(0);
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it('flags a clear mean separation as highly significant', () => {
    // Means 100 vs 130, tight spread ±10 over 500 points.
    const a = synthMoments(500, 100, 10);
    const b = synthMoments(500, 130, 10);
    const r = compareMeans(...a, ...b);
    expect(r.deltaMean).toBeCloseTo(30, 0);
    expect(r.confidence).toBe(0.99);
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.t).toBeGreaterThan(0); // B's mean is higher
  });

  it('reports no difference for identical moments', () => {
    const a = synthMoments(500, 100, 15);
    const r = compareMeans(...a, ...a);
    expect(r.deltaMean).toBeCloseTo(0, 6);
    expect(r.confidence).toBe(0);
  });

  it('handles zero-variance samples without dividing by zero', () => {
    const a = moments(Array(100).fill(50));
    const b = moments(Array(100).fill(50));
    const r = compareMeans(...a, ...b);
    expect(Number.isFinite(r.t)).toBe(true);
    expect(r.confidence).toBe(0);
  });
});

describe('compareQuantiles (tail/p99)', () => {
  it('withholds a verdict below the tail-sample floor', () => {
    const r = compareQuantiles(ramp(100), ramp(100, 50), 0.99);
    expect(r.enough).toBe(false);
  });

  it('flags a clearly shifted tail as significant and signs the delta', () => {
    // Both 0..999 but B shifted up 100: p99 ≈ 990 vs ≈ 1090.
    const r = compareQuantiles(ramp(1000), ramp(1000, 100), 0.99);
    expect(r.enough).toBe(true);
    expect(r.delta).toBeCloseTo(100, 0);
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.z).toBeGreaterThan(0); // B's tail is higher (slower)
  });

  it('finds no tail difference for identical distributions', () => {
    const r = compareQuantiles(ramp(1000), ramp(1000), 0.99);
    expect(r.delta).toBeCloseTo(0, 6);
    expect(r.confidence).toBe(0);
  });

  it('can separate tails even when the means barely move', () => {
    // A: tight 0..999. B: same bulk but a heavier top 1% (last 10 values large).
    const a = ramp(1000);
    const b = ramp(1000);
    for (let i = 990; i < 1000; i++) b[i] = 5000;
    const tail = compareQuantiles(a, b, 0.99);
    expect(tail.confidence).toBeGreaterThanOrEqual(0.95);
    expect(tail.delta).toBeGreaterThan(0);
  });
});
