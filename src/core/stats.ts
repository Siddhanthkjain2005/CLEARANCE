// Small, exact statistics used by canary analysis. No dependencies.

/** Standard normal CDF via the complementary error function (W. J. Cody style approximation). */
export function normCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

export function erfc(x: number): number {
  // Numerical Recipes erfc approximation, relative error < 1.2e-7.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * One-sided two-proportion z-test: is the canary's failure rate higher than
 * the baseline's? Returns the p-value of H0 "canary <= baseline".
 */
export function twoProportionZ(failA: number, nA: number, failB: number, nB: number): { z: number; p: number } {
  if (nA === 0 || nB === 0) return { z: 0, p: 1 };
  const pA = failA / nA;
  const pB = failB / nB;
  const pooled = (failA + failB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, p: pB > pA ? 0 : 1 };
  const z = (pB - pA) / se;
  return { z, p: 1 - normCdf(z) };
}

/**
 * One-sided Mann–Whitney U test with tie correction: are canary latencies
 * stochastically greater than baseline latencies? Returns the p-value and the
 * common-language effect size (probability a canary sample is slower).
 */
export function mannWhitneyGreater(baseline: number[], canary: number[]): { u: number; p: number; effect: number } {
  const n1 = baseline.length;
  const n2 = canary.length;
  if (n1 === 0 || n2 === 0) return { u: 0, p: 1, effect: 0.5 };
  const all = [
    ...baseline.map((v) => ({ v, g: 0 })),
    ...canary.map((v) => ({ v, g: 1 })),
  ].sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    if (t > 1) tieTerm += t * t * t - t;
    i = j + 1;
  }
  let r2 = 0;
  all.forEach((x, i) => { if (x.g === 1) r2 += ranks[i]; });
  const u2 = r2 - (n2 * (n2 + 1)) / 2; // U for canary: count of (canary > baseline) pairs
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return { u: u2, p: 1, effect: u2 / (n1 * n2) };
  const z = (u2 - mu - 0.5) / sigma; // continuity correction
  return { u: u2, p: 1 - normCdf(z), effect: u2 / (n1 * n2) };
}

/** Deterministic PRNG (mulberry32) so simulations and tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lognormalSample(rand: () => number, median: number, sigma: number): number {
  const u1 = Math.max(1e-12, rand());
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(sigma * z);
}
