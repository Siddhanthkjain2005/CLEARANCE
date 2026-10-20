import { test } from 'node:test';
import assert from 'node:assert/strict';
import { energyKwh, footprint, sciForFlight, RUNNER_PROFILES, greenestRegion, runtimeSci } from '../src/core/sci.ts';
import { avoidedJobs, generateChildPipeline, plannedJobs } from '../src/core/pipeline.ts';
import { buildImportGraph, impactedTests } from '../src/core/impact.ts';
import { parseYaml } from '../src/core/yaml.ts';
import { appendRecord, buildEvidencePack, verifyChain, verifySignature } from '../src/core/evidence.ts';

test('energy follows the CCF formula', () => {
  // 2 vCPU at 50%: 2 * (0.71 + 0.5 * 3.55) = 4.97 W; 8 GB * 0.392 = 3.136 W; * 1.1 PUE = 8.9166 W
  const e = energyKwh(3600, RUNNER_PROFILES['saas-linux-small-amd64'], 0.5);
  assert.ok(Math.abs(e - 0.0089166) < 1e-6, String(e));
});

test('the same job emits far less in a low-carbon region', () => {
  const job = { name: 'test', durationSec: 600 };
  assert.ok(footprint(job, 'us-east1').operationalG > 10 * footprint(job, 'europe-north1').operationalG);
  assert.equal(greenestRegion(['us-east1', 'us-central1', 'europe-north1']).region, 'europe-north1');
});

test('SCI per flight reports avoided emissions from adaptive pipelines', () => {
  const ctx = { impact: { mode: 'impacted' as const, tests: ['test/a.test.ts'], reason: '' }, webChanged: false };
  const ran = plannedJobs('lean', ctx).map((j) => ({ name: j.name, durationSec: j.typicalSec }));
  const rep = sciForFlight(ran, avoidedJobs('lean', ctx), 'us-east1');
  assert.ok(rep.avoidedG > 0);
  assert.ok(rep.avoidedPct > 0.5, String(rep.avoidedPct));
  assert.ok(Math.abs(rep.baselineG - (rep.sci + rep.avoidedG)) < 1e-3);
});

test('runtime SCI is per thousand requests', () => {
  const r = runtimeSci(30, 3600, 100_000, 'us-central1');
  assert.ok(r.perThousandRequests > 0 && r.utilisation < 0.01);
});

test('generated child pipelines are valid YAML and scale with tier', () => {
  const ctx = { impact: { mode: 'impacted' as const, tests: ['test/risk.test.ts'], reason: '1 test' }, webChanged: true };
  const lean = parseYaml(generateChildPipeline({ tier: 'lean', ...ctx })) as Record<string, unknown>;
  const full = parseYaml(generateChildPipeline({ tier: 'full', ...ctx })) as Record<string, unknown>;
  const taxi = parseYaml(generateChildPipeline({ tier: 'taxi', ...ctx })) as Record<string, unknown>;
  const jobs = (d: Record<string, unknown>) => Object.keys(d).filter((k) => !['default', 'variables', 'stages'].includes(k));
  assert.deepEqual(jobs(taxi), ['docs:links']);
  assert.ok(jobs(lean).includes('test:impacted'));
  assert.ok(!jobs(lean).includes('test:soak'));
  assert.ok(jobs(full).includes('test:soak') && jobs(full).includes('typecheck'));
  assert.match(String((lean['test:impacted'] as { script: string[] }).script[0]), /test\/risk\.test\.ts/);
});

test('test impact analysis follows imports transitively', () => {
  const graph = buildImportGraph({
    'src/core/a.ts': "export const a = 1;",
    'src/core/b.ts': "import { a } from './a.ts';",
    'src/tower/c.ts': "import { b } from '../core/b.ts';",
    'test/b.test.ts': "import { b } from '../src/core/b.ts';",
    'test/c.test.ts': "import x from '../src/tower/c.ts';",
    'test/other.test.ts': "import 'node:test';",
  });
  const isTest = (p: string) => p.startsWith('test/');
  assert.deepEqual(impactedTests(graph, ['src/core/a.ts'], isTest).tests, ['test/b.test.ts', 'test/c.test.ts']);
  assert.deepEqual(impactedTests(graph, ['src/tower/c.ts'], isTest).tests, ['test/c.test.ts']);
  assert.equal(impactedTests(graph, ['package.json'], isTest).mode, 'all');
  assert.equal(impactedTests(graph, ['src/new.ts'], isTest).mode, 'all');
});

test('black box chain detects tampering and signs its head', () => {
  let chain = appendRecord([], { stage: 'plan', actor: 'ai-dispatch', kind: 'assessment', summary: 'risk 0.12', data: { score: 0.12 } });
  chain = appendRecord(chain, { stage: 'release', actor: 'ci', kind: 'clearance', summary: 'autonomous', data: { level: 'autonomous' } });
  assert.equal(verifyChain(chain).ok, true);
  const tampered = chain.map((r, i) => (i === 0 ? { ...r, summary: 'risk 0.01' } : r));
  assert.deepEqual(verifyChain(tampered), { ok: false, brokenAt: 0 });
  const pack = buildEvidencePack({ flight: 'CLR-1', project: 'p', commit: 'abc', records: chain, signingKey: 'k' });
  assert.ok(pack.signature && verifySignature(pack.head, pack.signature, 'k'));
  assert.ok(pack.controls.some((c) => c.id === 'CC8.1'));
});
