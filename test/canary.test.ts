import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCanary } from '../src/core/canary.ts';
import { DEFAULT_POLICY } from '../src/core/config.ts';
import { lognormalSample, mannWhitneyGreater, normCdf, rng, twoProportionZ } from '../src/core/stats.ts';
import { budgetStatus, type Bucket } from '../src/core/slo.ts';

function sample(seed: number, revision: string, n: number, errRate: number, medianMs: number) {
  const r = rng(seed);
  let errors = 0;
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < errRate) errors++;
    lat.push(lognormalSample(r, medianMs, 0.35));
  }
  return { revision, requests: n, errors, latenciesMs: lat };
}

test('normal CDF is accurate', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
});

test('two-proportion z-test detects a real error increase', () => {
  assert.ok(twoProportionZ(5, 1000, 60, 1000).p < 0.001);
  assert.ok(twoProportionZ(5, 1000, 6, 1000).p > 0.3);
});

test('Mann-Whitney detects slower samples and ignores identical ones', () => {
  const r = rng(7);
  const a = Array.from({ length: 300 }, () => lognormalSample(r, 50, 0.3));
  const b = Array.from({ length: 300 }, () => lognormalSample(r, 80, 0.3));
  assert.ok(mannWhitneyGreater(a, b).p < 0.001);
  assert.ok(mannWhitneyGreater(a, a).p > 0.4);
});

test('healthy canary is promoted', () => {
  const rep = analyzeCanary(sample(1, 'stable', 1500, 0.002, 40), sample(2, 'canary', 600, 0.002, 41), DEFAULT_POLICY);
  assert.equal(rep.verdict, 'promote', JSON.stringify(rep.checks));
});

test('erroring canary goes around', () => {
  const rep = analyzeCanary(sample(1, 'stable', 1500, 0.002, 40), sample(3, 'canary', 600, 0.08, 40), DEFAULT_POLICY);
  assert.equal(rep.verdict, 'rollback');
  assert.equal(rep.checks.find((c) => c.id === 'errors')?.passed, false);
});

test('slow canary goes around', () => {
  const rep = analyzeCanary(sample(1, 'stable', 1500, 0.002, 40), sample(4, 'canary', 600, 0.002, 95), DEFAULT_POLICY);
  assert.equal(rep.verdict, 'rollback');
  assert.equal(rep.checks.find((c) => c.id === 'latency')?.passed, false);
});

test('too little traffic extends the bake instead of guessing', () => {
  const rep = analyzeCanary(sample(1, 'stable', 1500, 0.002, 40), sample(5, 'canary', 50, 0.0, 40), DEFAULT_POLICY);
  assert.equal(rep.verdict, 'extend');
});

test('error budget and burn-rate alerts', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const buckets: Bucket[] = [];
  for (let m = 0; m < 24 * 60; m++) buckets.push({ t: now - m * 60_000, total: 100, bad: 0 });
  let s = budgetStatus(buckets, 0.995, 28, now);
  assert.equal(s.remaining, 1);
  assert.ok(s.alerts.every((a) => !a.firing));
  // last 60 minutes: 10% errors = 20x burn
  for (let m = 0; m < 60; m++) buckets[m].bad = 10;
  s = budgetStatus(buckets, 0.995, 28, now);
  assert.ok(s.alerts[0].firing, JSON.stringify(s.alerts[0]));
  assert.ok(s.remaining < 1);
});
