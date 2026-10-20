import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAirspace, parsePolicy } from '../src/core/config.ts';
import { assessRisk } from '../src/core/risk.ts';
import { decide, budgetFactor } from '../src/core/governor.ts';
import { scorePilot, landingsToEarnAutonomy, betaLowerBound, normInv } from '../src/core/trust.ts';
import type { ChangeSet, LedgerEntry } from '../src/core/types.ts';

const policy = parsePolicy(readFileSync(new URL('../.clearance/policy.yml', import.meta.url), 'utf8'));
const airspace = parseAirspace(readFileSync(new URL('../.clearance/airspace.yml', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-14T10:00:00Z'); // a Wednesday

const consoleChange: ChangeSet = {
  title: 'Show bake timer on flight strips',
  author: 'ai-pilot',
  authorKind: 'agent',
  files: [
    { path: 'src/web/ui/Strip.tsx', additions: 40, deletions: 8 },
    { path: 'test/strip.test.ts', additions: 30, deletions: 0 },
  ],
};

function history(pilot: string, outcomes: LedgerEntry['outcome'][], risk = 0.2): LedgerEntry[] {
  return outcomes.map((outcome, i) => ({
    flight: `CLR-${i}`, pilot, pilotKind: 'agent', risk, level: 'supervised', outcome,
    at: new Date(NOW.getTime() - (outcomes.length - i) * 3_600_000).toISOString(),
  }));
}

test('policy file parses with ordered thresholds', () => {
  assert.equal(policy.autonomous.maxRisk, 0.35);
  assert.deepEqual(policy.canary.autonomous.steps, [25, 50, 100]);
  assert.throws(() => parsePolicy('autonomy:\n  autonomous:\n    max_risk: 0.9\n  supervised:\n    max_risk: 0.5\n'));
});

test('normal quantile and beta bound behave', () => {
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
  const b = betaLowerBound(9, 3, 0.9);
  assert.ok(b.lower < b.mean);
});

test('a new agent is sceptically trusted and must earn autonomy', () => {
  const t = scorePilot('ai-pilot', [], policy, NOW);
  assert.ok(t.trust < 0.3, `trust ${t.trust}`);
  assert.equal(t.autonomyEarned, false);
  const needed = landingsToEarnAutonomy([], 'ai-pilot', policy, 0.2, NOW);
  assert.ok(needed >= 5 && needed <= 20, `needed ${needed}`);
});

test('clean landings earn autonomy, a go-around costs it', () => {
  const good = scorePilot('ai-pilot', history('ai-pilot', Array(14).fill('landed')), policy, NOW);
  assert.equal(good.autonomyEarned, true, `trust ${good.trust}`);
  assert.equal(good.streak, 14);
  const bad = scorePilot('ai-pilot', history('ai-pilot', [...Array(14).fill('landed'), 'go-around']), policy, NOW);
  assert.ok(bad.trust < good.trust);
  assert.equal(bad.streak, 0);
  const incident = scorePilot('ai-pilot', history('ai-pilot', [...Array(14).fill('landed'), 'incident']), policy, NOW);
  assert.ok(incident.trust < bad.trust);
});

test('low-risk change from a trusted agent is cleared autonomously', () => {
  const risk = assessRisk(consoleChange, airspace);
  const trust = scorePilot('ai-pilot', history('ai-pilot', Array(16).fill('landed')), policy, NOW);
  const d = decide({ change: consoleChange, risk, trust, errorBudget: 0.9, policy, now: NOW });
  assert.equal(d.level, 'autonomous', d.reasons.join('; '));
  assert.equal(d.tier, 'lean');
  assert.deepEqual(d.canary?.steps, [25, 50, 100]);
  assert.equal(d.approvalsRequired, 0);
});

test('the same change from an untested agent is supervised', () => {
  const risk = assessRisk(consoleChange, airspace);
  const trust = scorePilot('ai-new', [], policy, NOW);
  const d = decide({ change: consoleChange, risk, trust, errorBudget: 0.9, policy, now: NOW });
  assert.equal(d.level, 'supervised');
  assert.match(d.reasons.join(' '), /not earned autonomy/);
});

test('a burning error budget shrinks autonomy, an exhausted one holds', () => {
  const risk = assessRisk(consoleChange, airspace);
  const trust = scorePilot('ai-pilot', history('ai-pilot', Array(16).fill('landed')), policy, NOW);
  assert.equal(budgetFactor(0.3, policy), 0.5);
  const tight = decide({ change: consoleChange, risk, trust, errorBudget: 0.12, policy, now: NOW });
  assert.notEqual(tight.level, 'autonomous');
  const frozen = decide({ change: consoleChange, risk, trust, errorBudget: 0.05, policy, now: NOW });
  assert.equal(frozen.level, 'hold');
  const fix = decide({ change: { ...consoleChange, title: 'fix: restore strip colours' }, risk, trust, errorBudget: 0.05, policy, now: NOW });
  assert.notEqual(fix.level, 'hold');
});

test('agents can never clear changes to their own governance', () => {
  const change: ChangeSet = { ...consoleChange, files: [{ path: '.clearance/policy.yml', additions: 1, deletions: 1 }] };
  const risk = assessRisk(change, airspace);
  const trust = scorePilot('ai-pilot', history('ai-pilot', Array(40).fill('landed')), policy, NOW);
  const d = decide({ change, risk, trust, errorBudget: 1, policy, now: NOW });
  assert.equal(d.level, 'hold');
  assert.ok(d.holds.includes('protected_sectors'));
  const human = decide({ change: { ...change, authorKind: 'human' }, risk, trust, errorBudget: 1, policy, now: NOW });
  assert.equal(human.level, 'supervised');
});

test('critical findings and detected secrets always hold', () => {
  const risk = assessRisk(consoleChange, airspace);
  const trust = scorePilot('ai-pilot', history('ai-pilot', Array(40).fill('landed')), policy, NOW);
  const d = decide({ change: { ...consoleChange, findings: [{ severity: 'high', scanner: 'secret_detection', name: 'AWS key' }] }, risk, trust, errorBudget: 1, policy, now: NOW });
  assert.equal(d.level, 'hold');
  assert.ok(d.holds.includes('secrets_detected'));
});

test('freeze windows hold everything except fixes', () => {
  const frozen = parsePolicy('freeze_windows:\n  - name: weekend\n    days: [6, 0]\n    from_hour: 0\n    to_hour: 24\n');
  const saturday = new Date('2026-10-17T12:00:00Z');
  const risk = assessRisk(consoleChange, airspace);
  const trust = scorePilot('ai-pilot', history('ai-pilot', Array(20).fill('landed')), frozen, saturday);
  assert.equal(decide({ change: consoleChange, risk, trust, errorBudget: 1, policy: frozen, now: saturday }).level, 'hold');
  assert.notEqual(decide({ change: { ...consoleChange, title: 'fix: x' }, risk, trust, errorBudget: 1, policy: frozen, now: saturday }).level, 'hold');
});

test('docs-only flights taxi without a deployment', () => {
  const change: ChangeSet = { ...consoleChange, files: [{ path: 'docs/demo.md', additions: 12, deletions: 0 }] };
  const d = decide({ change, risk: assessRisk(change, airspace), trust: scorePilot('ai-new', [], policy, NOW), errorBudget: 1, policy, now: NOW });
  assert.equal(d.level, 'autonomous');
  assert.equal(d.tier, 'taxi');
  assert.equal(d.canary, null);
});
