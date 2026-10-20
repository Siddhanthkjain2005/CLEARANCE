// Canary analysis: should this revision take more traffic, or go around?
//
// Three independent checks, each of which can force a go-around:
//   1. Errors: one-sided two-proportion z-test, and the absolute increase must
//      also exceed a practical threshold (statistically significant but tiny
//      differences don't block a release).
//   2. Latency: one-sided Mann–Whitney U on raw samples plus a p95 ratio guard.
//   3. SLO burn: the canary's error rate expressed as a burn rate against the
//      SLO; above the fast-burn threshold it fails immediately (Google SRE
//      workbook, multiwindow burn-rate alerting).
// Too little traffic yields "extend" rather than a guess.

import { mannWhitneyGreater, quantile, twoProportionZ } from './stats.ts';
import type { AutonomyPolicy } from './types.ts';

export interface RevisionSample {
  revision: string;
  requests: number;
  errors: number;
  latenciesMs: number[];
}

export type CanaryVerdict = 'promote' | 'rollback' | 'extend';

export interface CanaryCheck {
  id: 'errors' | 'latency' | 'burn' | 'traffic';
  passed: boolean;
  summary: string;
  metrics: Record<string, number>;
}

export interface CanaryReport {
  verdict: CanaryVerdict;
  checks: CanaryCheck[];
  baseline: { revision: string; requests: number; errorRate: number; p50: number; p95: number };
  canary: { revision: string; requests: number; errorRate: number; p50: number; p95: number };
}

const r4 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : 0);

export function analyzeCanary(baseline: RevisionSample, canary: RevisionSample, policy: AutonomyPolicy): CanaryReport {
  const a = policy.analysis;
  const bRate = baseline.requests ? baseline.errors / baseline.requests : 0;
  const cRate = canary.requests ? canary.errors / canary.requests : 0;
  const bP95 = quantile(baseline.latenciesMs, 0.95);
  const cP95 = quantile(canary.latenciesMs, 0.95);
  const checks: CanaryCheck[] = [];

  const enough = canary.requests >= a.minRequests && baseline.requests >= a.minRequests;
  checks.push({
    id: 'traffic',
    passed: enough,
    summary: enough
      ? `${canary.requests} canary and ${baseline.requests} baseline requests observed`
      : `Need ${a.minRequests} requests per revision, have ${canary.requests} canary / ${baseline.requests} baseline`,
    metrics: { canaryRequests: canary.requests, baselineRequests: baseline.requests, minRequests: a.minRequests },
  });

  // SLO burn is checked even with little traffic: a canary failing hard fails fast.
  const burn = cRate / (1 - a.sloTarget);
  const burnFail = burn >= a.fastBurn && canary.errors >= 5;
  checks.push({
    id: 'burn',
    passed: !burnFail,
    summary: `Canary burns error budget at ${burn.toFixed(1)}× (fast-burn limit ${a.fastBurn}×)`,
    metrics: { burnRate: r4(burn), fastBurn: a.fastBurn, sloTarget: a.sloTarget },
  });

  const z = twoProportionZ(baseline.errors, baseline.requests, canary.errors, canary.requests);
  const delta = cRate - bRate;
  const errorsFail = z.p < a.significance && delta > a.maxErrorRateDelta;
  checks.push({
    id: 'errors',
    passed: !errorsFail,
    summary: `Error rate ${(cRate * 100).toFixed(2)}% vs ${(bRate * 100).toFixed(2)}% baseline (p = ${z.p.toFixed(4)})`,
    metrics: { canaryErrorRate: r4(cRate), baselineErrorRate: r4(bRate), delta: r4(delta), pValue: r4(z.p), z: r4(z.z) },
  });

  const mw = mannWhitneyGreater(baseline.latenciesMs, canary.latenciesMs);
  const ratio = bP95 > 0 ? cP95 / bP95 : 1;
  const latencyFail = mw.p < a.significance && ratio > a.maxLatencyP95Ratio;
  checks.push({
    id: 'latency',
    passed: !latencyFail,
    summary: `p95 ${cP95.toFixed(0)} ms vs ${bP95.toFixed(0)} ms baseline (${ratio.toFixed(2)}×, p = ${mw.p.toFixed(4)})`,
    metrics: { canaryP95: r4(cP95), baselineP95: r4(bP95), ratio: r4(ratio), pValue: r4(mw.p), effect: r4(mw.effect) },
  });

  let verdict: CanaryVerdict;
  if (burnFail || errorsFail || latencyFail) verdict = 'rollback';
  else if (!enough) verdict = 'extend';
  else verdict = 'promote';

  return {
    verdict,
    checks,
    baseline: { revision: baseline.revision, requests: baseline.requests, errorRate: r4(bRate), p50: r4(quantile(baseline.latenciesMs, 0.5)), p95: r4(bP95) },
    canary: { revision: canary.revision, requests: canary.requests, errorRate: r4(cRate), p50: r4(quantile(canary.latenciesMs, 0.5)), p95: r4(cP95) },
  };
}
