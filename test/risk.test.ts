import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessRisk, noisyOr, parseNumstat } from '../src/core/risk.ts';
import { parseAirspace } from '../src/core/config.ts';
import { matchGlob } from '../src/core/glob.ts';
import type { ChangeSet } from '../src/core/types.ts';

const airspace = parseAirspace(readFileSync(new URL('../.clearance/airspace.yml', import.meta.url), 'utf8'));

const change = (files: ChangeSet['files'], extra: Partial<ChangeSet> = {}): ChangeSet => ({
  title: 't', author: 'ai-pilot', authorKind: 'agent', files, ...extra,
});

test('globs follow CODEOWNERS semantics', () => {
  assert.ok(matchGlob('docs/a/b.md', 'docs/**'));
  assert.ok(matchGlob('README.md', '*.md'));
  assert.ok(matchGlob('src/x/README.md', '*.md'));
  assert.ok(matchGlob('src/db/migrations/001.sql', '**/migrations/**'));
  assert.ok(matchGlob('src/web/engine/gl.ts', 'src/web/**'));
  assert.ok(!matchGlob('src/core/risk.ts', 'src/web/**'));
  assert.ok(matchGlob('src/core/a.test.ts', '*.test.*'));
  assert.ok(matchGlob('x.yml', '{x,y}.yml'));
});

test('noisy-OR combines independent causes', () => {
  assert.equal(noisyOr([]), 0);
  assert.ok(Math.abs(noisyOr([0.5, 0.5]) - 0.75) < 1e-12);
});

test('docs-only change is minimal risk and does not ship', () => {
  const r = assessRisk(change([{ path: 'docs/guide.md', additions: 40, deletions: 3 }]), airspace);
  assert.equal(r.runtimeChange, false);
  assert.equal(r.band, 'minimal');
  assert.ok(r.score < 0.05, `score ${r.score}`);
});

test('small console change with tests is low risk', () => {
  const r = assessRisk(
    change([
      { path: 'src/web/ui/Strip.tsx', additions: 30, deletions: 10 },
      { path: 'test/strip.test.ts', additions: 25, deletions: 0 },
    ]),
    airspace,
  );
  assert.equal(r.runtimeChange, true);
  assert.ok(r.score < 0.25, `score ${r.score}`);
});

test('untested decision-engine change with a dependency bump is riskier', () => {
  const small = assessRisk(change([{ path: 'src/web/ui/Strip.tsx', additions: 30, deletions: 10 }]), airspace);
  const big = assessRisk(
    change([
      { path: 'src/core/governor.ts', additions: 220, deletions: 90 },
      { path: 'src/tower/server.ts', additions: 40, deletions: 5 },
      { path: 'package.json', additions: 2, deletions: 1 },
    ]),
    airspace,
  );
  assert.ok(big.score > small.score + 0.2, `${big.score} vs ${small.score}`);
  assert.ok(big.signals.some((s) => s.id === 'test-gap'));
  assert.ok(big.signals.some((s) => s.id === 'dependencies'));
  assert.ok(big.blastRadius >= 2);
});

test('security findings raise risk by severity', () => {
  const base = change([{ path: 'src/tower/server.ts', additions: 10, deletions: 2 }]);
  const clean = assessRisk(base, airspace).score;
  const high = assessRisk({ ...base, findings: [{ severity: 'high', scanner: 'semgrep', name: 'x' }] }, airspace).score;
  const crit = assessRisk({ ...base, findings: [{ severity: 'critical', scanner: 'semgrep', name: 'x' }] }, airspace).score;
  assert.ok(clean < high && high < crit);
});

test('parses git numstat including renames and binary files', () => {
  const files = parseNumstat('10\t2\tsrc/a.ts\n-\t-\tlogo.png\n3\t3\tsrc/{old => new}/b.ts\n', 'M\tsrc/a.ts\nA\tlogo.png\nR100\tsrc/old/b.ts\tsrc/new/b.ts');
  assert.deepEqual(files.map((f) => f.path), ['src/a.ts', 'logo.png', 'src/new/b.ts']);
  assert.equal(files[1].additions, 0);
  assert.equal(files[1].status, 'added');
  assert.equal(files[2].status, 'renamed');
});
