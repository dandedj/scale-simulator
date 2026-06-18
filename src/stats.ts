/**
 * Lightweight inferential statistics for the A/B comparison readout.
 *
 * The headline question — "are SIM A and SIM B really performing differently,
 * or is this just noise?" — is a comparison of two success rates. Each request
 * is a Bernoulli trial (it succeeds within the client deadline or it doesn't),
 * so the standard tool is the two-proportion z-test on the success counts.
 *
 * Caveat worth stating wherever this is shown: the test assumes independent
 * trials. Requests in a storm are correlated (one poisoned connection fails a
 * burst of them; retries cluster), so the effective sample size is smaller than
 * the raw count and the reported confidence is optimistic. Treat it as "is the
 * gap clearly beyond noise," not a precise p-value.
 */

/** Error function (Abramowitz & Stegun 7.1.26); max abs error ~1.5e-7. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface ABComparison {
  /** Difference in success rate, B − A, in percentage points. */
  deltaPp: number;
  /** Two-proportion z statistic (positive ⇒ B better). */
  z: number;
  /** Two-sided p-value. */
  pValue: number;
  /** Highest confidence band cleared: 0, 0.90, 0.95, or 0.99. */
  confidence: number;
  /** False until both samples are large enough to judge. */
  enough: boolean;
  /** Which sim is significantly better, or null if the gap is not significant. */
  better: 'A' | 'B' | null;
}

/** Minimum arrivals per sim before a verdict is offered. */
const MIN_SAMPLE = 30;

/**
 * Two-proportion z-test comparing success rate B vs A.
 * nA/nB are arrivals (trials); kA/kB are successes.
 */
export function compareSuccessRates(nA: number, kA: number, nB: number, kB: number): ABComparison {
  const enough = nA >= MIN_SAMPLE && nB >= MIN_SAMPLE;
  const pA = nA > 0 ? kA / nA : 0;
  const pB = nB > 0 ? kB / nB : 0;
  const deltaPp = (pB - pA) * 100;
  const pooled = (kA + kB) / Math.max(1, nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, nA) + 1 / Math.max(1, nB)));
  const z = se > 0 ? (pB - pA) / se : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  let confidence = 0;
  if (Math.abs(z) >= 2.5758) confidence = 0.99;
  else if (Math.abs(z) >= 1.96) confidence = 0.95;
  else if (Math.abs(z) >= 1.645) confidence = 0.9;
  const better = !enough || confidence === 0 ? null : pB > pA ? 'B' : 'A';
  return { deltaPp, z, pValue, confidence, enough, better };
}

export interface ABMeans {
  /** Difference in mean, B − A (same units as the samples, e.g. ms). */
  deltaMean: number;
  /** Welch t statistic (positive ⇒ B's mean is higher). */
  t: number;
  /** Two-sided p-value (normal approximation; valid here because n is large). */
  pValue: number;
  /** Highest confidence band cleared: 0, 0.90, 0.95, or 0.99. */
  confidence: number;
  /** False until both samples are large enough to judge. */
  enough: boolean;
}

/**
 * Welch's t-test comparing two means from running moments (count, sum, sum of
 * squares) — no need to retain the samples. Unequal variances allowed. With the
 * large counts this sim accumulates the t-distribution ≈ normal, so the p-value
 * uses the normal CDF (a precise t-CDF would shift it only at tiny n).
 */
export function compareMeans(
  nA: number,
  sumA: number,
  sumSqA: number,
  nB: number,
  sumB: number,
  sumSqB: number,
): ABMeans {
  const enough = nA >= MIN_SAMPLE && nB >= MIN_SAMPLE;
  const meanA = nA > 0 ? sumA / nA : 0;
  const meanB = nB > 0 ? sumB / nB : 0;
  const deltaMean = meanB - meanA;
  // Sample variance via the moments; clamp tiny negatives from float error.
  const varA = nA > 1 ? Math.max(0, (sumSqA - (sumA * sumA) / nA) / (nA - 1)) : 0;
  const varB = nB > 1 ? Math.max(0, (sumSqB - (sumB * sumB) / nB) / (nB - 1)) : 0;
  const se = Math.sqrt(varA / Math.max(1, nA) + varB / Math.max(1, nB));
  const t = se > 0 ? deltaMean / se : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  let confidence = 0;
  if (Math.abs(t) >= 2.5758) confidence = 0.99;
  else if (Math.abs(t) >= 1.96) confidence = 0.95;
  else if (Math.abs(t) >= 1.645) confidence = 0.9;
  return { deltaMean, t, pValue, confidence, enough };
}
