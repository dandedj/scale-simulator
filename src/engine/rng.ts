/**
 * Deterministic random number generation for the simulation.
 *
 * Every source of randomness flows through one seeded PRNG so a given
 * preset + seed replays identically — essential for demos ("watch what
 * happens when I press pulse") and for debugging the model.
 */

/** sfc32: small, fast, high-quality 32-bit PRNG. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // Splitmix-style seeding to fill four state words from one seed.
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // Warm up past any seed correlations.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Exponential variate with the given mean — inter-arrival times of a
   * Poisson process (independent clients firing requests).
   */
  exponential(mean: number): number {
    let u = this.next();
    if (u <= 0) u = Number.MIN_VALUE;
    return -Math.log(u) * mean;
  }

  /**
   * Log-normal variate parameterized by median and sigma (shape).
   * Service times are right-skewed: most responses near the median with a
   * long tail. sigma ≈ 0.3 gives p99/median ≈ 2x; sigma ≈ 0.6 gives ≈ 4x.
   */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Standard normal via Box–Muller. */
  normal(): number {
    let u1 = this.next();
    if (u1 <= 0) u1 = Number.MIN_VALUE;
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
