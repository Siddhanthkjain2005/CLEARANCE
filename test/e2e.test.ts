// End to end against a mock GitLab: a Duo-authored merge request is assessed,
// gated and auto-merged; on main it is released, flown through a canary drill,
// landed, carbon-reported and sealed; an agent's policy edit is held; a bad
// canary goes around and opens an incident; and the Tower's sync rebuilds the
// whole flight from what the pipeline left in GitLab.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { GitLabMock } from './support/gitlab-mock.ts';
import { verifyChain, verifySignature, type BlackBoxRecord, type EvidencePack } from '../src/core/evidence.ts';
import type { LedgerEntry } from '../src/core/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src/cli/clearance.ts');
const mock = new GitLabMock();
let repo = '';
const sha: Record<string, string> = {};

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (rel: string, content: string) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), content);
};
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

function run(cmd: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...cmd], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr });
    });
  });
}

const baseEnv = () => ({
  CI_PROJECT_DIR: repo,
  CI_API_V4_URL: mock.url,
  CI_PROJECT_ID: '42',
  CI_PROJECT_PATH: 'g/p',
  CI_JOB_TOKEN: 'job-token-only',
  CLEARANCE_TOKEN: 'project-token',
  CLEARANCE_SIGNING_KEY: 'test-signing-key',
});

const readOut = <T>(rel: string): T => JSON.parse(readFileSync(join(repo, rel), 'utf8')) as T;

before(async () => {
  await mock.start();
  repo = mkdtempSync(join(tmpdir(), 'clearance-e2e-'));
  cpSync(join(ROOT, '.clearance'), join(repo, '.clearance'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write('src/web/ui/Strip.tsx', lines(20, 'strip'));
  write('test/strip.test.ts', "import { strip0 } from '../src/web/ui/Strip.tsx';\n");
  write('README.md', '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: base');
  sha.base = git('rev-parse', 'HEAD');

  // A Duo-authored change: console code plus tests, signed with the pilot trailer.
  git('checkout', '-q', '-b', 'clearance/12-bake-countdown');
  write('src/web/ui/Strip.tsx', lines(20, 'strip') + lines(36, 'bake'));
  write('test/strip.test.ts', "import { strip0 } from '../src/web/ui/Strip.tsx';\n" + lines(22, 't'));
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: show bake countdown on strips\n\nClearance-Pilot: ai-clearance-dispatch');
  sha.head = git('rev-parse', 'HEAD');

  // An agent trying to loosen its own policy.
  git('checkout', '-q', '-b', 'clearance/13-policy', sha.base);
  write('.clearance/policy.yml', readFileSync(join(repo, '.clearance/policy.yml'), 'utf8').replace('max_risk: 0.35', 'max_risk: 0.60'));
  git('commit', '-q', '-am', 'chore: raise the autonomous ceiling\n\nClearance-Pilot: ai-clearance-dispatch');
  sha.policy = git('rev-parse', 'HEAD');

  const now = Date.now();
  const mr = (iid: number, title: string, head: string) => ({
    iid, title, description: 'Closes #3', state: 'opened', labels: [], author: { username: 'maya.chen', name: 'Maya' }, sha: head,
    merge_commit_sha: null, created_at: new Date(now - 600_000).toISOString(), updated_at: new Date(now).toISOString(), merged_at: null,
    head_pipeline: { id: 500 + iid, status: 'success' }, source_branch: `clearance/${iid}`, target_branch: 'main',
  });
  mock.mrs.set(12, mr(12, 'feat: show bake countdown on strips', sha.head));
  mock.mrs.set(13, mr(13, 'chore: raise the autonomous ceiling', sha.policy));

  // The dispatch agent has a clean record: it has earned autonomy.
  const ledger: LedgerEntry[] = Array.from({ length: 16 }, (_, i) => ({
    flight: `CLR-${100 + i}`, pilot: 'ai-clearance-dispatch', pilotKind: 'agent', risk: 0.2, level: i < 9 ? 'supervised' : 'autonomous', outcome: 'landed',
    at: new Date(now - (16 - i) * 3_600_000).toISOString(),
  }));
  mock.packages.set('clearance-ledger/v1/ledger.json', JSON.stringify(ledger));
});

after(() => {
  try {
    // Export only when explicitly requested for a local rehearsal. These
    // fixtures must never be presented as live GitLab or Duo execution.
    const evidenceDir = process.env.CLEARANCE_E2E_EVIDENCE_DIR;
    if (evidenceDir && repo) {
      mkdirSync(evidenceDir, { recursive: true });
      const packageDir = join(evidenceDir, 'mock-packages');
      for (const [name, body] of mock.packages) {
        const target = join(packageDir, name);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, body);
      }
      const canary = existsSync(join(repo, '.clearance-out/canary.json')) ? readOut<{ verdict: string }>('.clearance-out/canary.json') : null;
      const pack = JSON.parse(mock.packages.get('clearance-evidence/CLR-12/evidence.json') ?? 'null') as EvidencePack | null;
      const report = {
        schema: 'clearance.local-proof/v1',
        createdAt: new Date().toISOString(),
        provenance: 'Local CLI integration tests using an in-memory GitLab API and deterministic canary drills',
        liveGitLab: false,
        liveDuo: false,
        realCloudDeployment: false,
        trustHistory: 'Seeded test fixture; not an earned production track record',
        checks: {
          autoMergeRequested: mock.callsTo('PUT', /merge_requests\/12\/merge$/).length > 0,
          successfulRelease: /Landed: promoted to 100%/.test(mock.releases.get('v0.1.0')?.description ?? ''),
          governanceHold: !!mock.mrs.get(13)?.labels.includes('clearance::hold') && mock.callsTo('PUT', /merge_requests\/13\/merge$/).length === 0,
          rollbackAndIncident: canary?.verdict === 'rollback' && mock.issues.some((issue) => issue.issue_type === 'incident'),
          signedEvidenceChain: !!pack?.signature && verifyChain(pack.records).ok && verifySignature(pack.head, pack.signature, 'test-signing-key'),
        },
        apiCalls: mock.calls.map(({ method, path }) => ({ method, path })),
      };
      writeFileSync(join(evidenceDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
      for (const file of ['canary.json', 'sci.json']) {
        const source = join(repo, '.clearance-out', file);
        if (existsSync(source)) cpSync(source, join(evidenceDir, file));
      }
      const sci = pack?.records.find((record) => record.kind === 'sci');
      if (sci) writeFileSync(join(evidenceDir, 'sci.json'), JSON.stringify(sci.data, null, 2) + '\n');
    }
  } finally {
    mock.stop();
    if (repo) rmSync(repo, { recursive: true, force: true });
  }
});

const mrEnv = (iid: number, head: string) => ({
  ...baseEnv(), CI_MERGE_REQUEST_IID: String(iid), CI_MERGE_REQUEST_DIFF_BASE_SHA: sha.base, CI_COMMIT_SHA: head, CI_PIPELINE_SOURCE: 'merge_request_event',
});

test('assess scores a Duo change and generates a lean pipeline', async () => {
  git('checkout', '-q', 'clearance/12-bake-countdown');
  const r = await run(['assess'], mrEnv(12, sha.head));
  assert.equal(r.code, 0, r.out);
  const c = readOut<{ flight: string; pilot: { name: string; kind: string }; decision: { level: string; tier: string }; risk: { score: number } }>('.clearance-out/clearance.json');
  assert.equal(c.flight, 'CLR-12');
  assert.deepEqual([c.pilot.name, c.pilot.kind], ['ai-clearance-dispatch', 'agent']);
  assert.equal(c.decision.level, 'autonomous', r.out);
  assert.equal(c.decision.tier, 'lean');
  const child = readFileSync(join(repo, '.clearance-out/child-pipeline.yml'), 'utf8');
  assert.match(child, /test:impacted/);
  assert.match(child, /test\/strip\.test\.ts/);
  assert.match(readFileSync(join(repo, 'clearance.env'), 'utf8'), /CLEARANCE_LEVEL=autonomous/);
  const box = JSON.parse(mock.packages.get('clearance-blackbox/CLR-12/blackbox.json')!) as BlackBoxRecord[];
  assert.equal(box[0].kind, 'assessment');
});

test('gate notes, labels and auto-merges an autonomous flight', async () => {
  const r = await run(['gate'], mrEnv(12, sha.head));
  assert.equal(r.code, 0, r.out);
  const notes = mock.notes.get('12')!;
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /<!-- clearance:report -->/);
  assert.match(notes[0].body, /Cleared for autonomous landing/);
  assert.ok(mock.mrs.get(12)!.labels.includes('clearance::autonomous'));
  const merge = mock.callsTo('PUT', /merge_requests\/12\/merge$/);
  assert.equal(merge.length, 1);
  assert.equal((merge[0].body as { auto_merge: boolean }).auto_merge, true);
  assert.equal(merge[0].auth, 'project-token');
  // a second gate run updates the same note instead of adding another
  await run(['gate'], mrEnv(12, sha.head));
  assert.equal(mock.notes.get('12')!.length, 1);
});

test('an agent editing its own policy is held and the job fails', async () => {
  git('checkout', '-q', 'clearance/13-policy');
  rmSync(join(repo, '.clearance-out'), { recursive: true, force: true });
  const env = mrEnv(13, sha.policy);
  assert.equal((await run(['assess'], env)).code, 0);
  const r = await run(['gate'], env);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /HOLD: Agents cannot clear their own governance/);
  assert.ok(mock.mrs.get(13)!.labels.includes('clearance::hold'));
  assert.equal(mock.callsTo('PUT', /merge_requests\/13\/merge$/).length, 0);
  assert.match(mock.notes.get('13')![0].body, /Holding/);
});

test('on main the flight is released, flown, landed, measured and sealed', async () => {
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', 'clearance/12-bake-countdown', '-m', "Merge branch 'clearance/12-bake-countdown' into 'main'\n\nSee merge request g/p!12");
  sha.merge = git('rev-parse', 'HEAD');
  rmSync(join(repo, '.clearance-out'), { recursive: true, force: true });
  const env = { ...baseEnv(), CI_COMMIT_SHA: sha.merge, CI_COMMIT_BEFORE_SHA: sha.base, CI_COMMIT_BRANCH: 'main', CI_PIPELINE_URL: 'https://gitlab.example/p/1' };

  const a = await run(['assess'], env);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /using the clearance issued on the merge request: AUTONOMOUS/);

  const rel = await run(['release'], env);
  assert.equal(rel.code, 0, rel.out);
  assert.ok(mock.releases.has('v0.1.0'), `releases: ${[...mock.releases.keys()]}`);

  const fly = await run(['fly', '--drill'], env);
  assert.equal(fly.code, 0, fly.out);
  assert.equal(readOut<{ verdict: string }>('.clearance-out/canary.json').verdict, 'promote');

  const land = await run(['land'], env);
  assert.equal(land.code, 0, land.out);
  const ledger = JSON.parse(mock.packages.get('clearance-ledger/v1/ledger.json')!) as LedgerEntry[];
  assert.equal(ledger.length, 17);
  assert.deepEqual([ledger.at(-1)!.flight, ledger.at(-1)!.outcome], ['CLR-12', 'landed']);
  assert.ok(mock.mrs.get(12)!.labels.includes('flight::landed'));
  assert.match(mock.releases.get('v0.1.0')!.description, /Landed: promoted to 100%/);
  assert.match(readFileSync(join(repo, 'canary.env'), 'utf8'), /CLEARANCE_OUTCOME=landed/);

  const sci = await run(['sci'], { ...env, CI_PIPELINE_ID: '600' });
  assert.equal(sci.code, 0, sci.out);
  assert.match(readFileSync(join(repo, 'metrics.txt'), 'utf8'), /clearance_sci_gco2e_per_flight \d/);

  const ev = await run(['evidence'], env);
  assert.equal(ev.code, 0, ev.out);
  const pack = JSON.parse(mock.packages.get('clearance-evidence/CLR-12/evidence.json')!) as EvidencePack;
  assert.equal(verifyChain(pack.records).ok, true);
  assert.ok(pack.signature, 'evidence is signed');
  const kinds = pack.records.map((r) => r.kind);
  for (const k of ['assessment', 'security', 'clearance', 'release', 'deployment', 'canary', 'sci']) assert.ok(kinds.includes(k), `black box has ${k}: ${kinds}`);
  assert.ok(pack.controls.some((c) => c.id === 'CC8.1'));
  assert.ok(existsSync(join(repo, 'evidence/CLR-12.md')));
});

test('a failing canary goes around, withdraws the release and opens an incident', async () => {
  rmSync(join(repo, '.clearance-out'), { recursive: true, force: true });
  rmSync(join(repo, 'canary.env'), { force: true });
  const env = { ...baseEnv(), CI_COMMIT_SHA: sha.merge, CI_COMMIT_BEFORE_SHA: sha.base, CI_COMMIT_BRANCH: 'main', CLEARANCE_FLIGHT: 'CLR-14', CLEARANCE_VERSION: 'v0.1.1' };
  mock.mrs.set(14, { ...mock.mrs.get(12)!, iid: 14, labels: [] });
  assert.equal((await run(['assess'], env)).code, 0);
  assert.equal((await run(['release'], env)).code, 0);
  const fly = await run(['fly', '--drill', '--fault', 'errors'], env);
  assert.equal(fly.code, 0, 'a go-around is a safe outcome, not a failed job');
  assert.equal(readOut<{ verdict: string }>('.clearance-out/canary.json').verdict, 'rollback');
  assert.equal((await run(['land'], env)).code, 0);
  const incident = mock.issues.at(-1) as { title: string; issue_type: string; description: string };
  assert.match(incident.title, /Go-around: CLR-14/);
  assert.equal(incident.issue_type, 'incident');
  assert.match(mock.releases.get('v0.1.1')!.name, /withdrawn/);
  const ledger = JSON.parse(mock.packages.get('clearance-ledger/v1/ledger.json')!) as LedgerEntry[];
  assert.equal(ledger.at(-1)!.outcome, 'go-around');
});

test('the Tower rebuilds the flight from GitLab alone', async () => {
  const { Store } = await import('../src/tower/store.ts');
  const { GitLabSync } = await import('../src/tower/sync.ts');
  const { GitLab } = await import('../src/core/gitlab.ts');
  const { DEFAULT_POLICY } = await import('../src/core/config.ts');
  const now = new Date().toISOString();
  const mr = mock.mrs.get(12)!;
  Object.assign(mr, { state: 'merged', merged_at: now, merge_commit_sha: sha.merge });
  mock.pipelines.push(
    { id: 512, sha: sha.head, status: 'success', jobs: [
      { id: 1, name: 'clearance:assess', stage: 'plan', status: 'success', duration: 12, started_at: now, finished_at: now, web_url: '', pipeline: { id: 512 } },
      { id: 2, name: 'semgrep-sast', stage: 'secure', status: 'success', duration: 60, started_at: now, finished_at: now, web_url: '', pipeline: { id: 512 } },
    ], bridges: [{ id: 3, name: 'verify:flight', stage: 'verify', status: 'success', downstream_pipeline: { id: 513, status: 'success' } }] },
    { id: 513, sha: sha.head, status: 'success', jobs: [{ id: 4, name: 'test:impacted', stage: 'verify', status: 'success', duration: 30, started_at: now, finished_at: now, web_url: '', pipeline: { id: 513 } }], bridges: [] },
    { id: 600, sha: sha.merge, status: 'success', jobs: [
      { id: 5, name: 'package:image', stage: 'package', status: 'success', duration: 90, started_at: now, finished_at: now, web_url: '', pipeline: { id: 600 } },
      { id: 6, name: 'monitor:canary-drill', stage: 'monitor', status: 'success', duration: 40, started_at: now, finished_at: now, web_url: '', pipeline: { id: 600 } },
    ], bridges: [] },
  );
  mock.mrs.get(12)!.head_pipeline = { id: 512, status: 'success' };
  mock.notes.get('12')!.push({ id: 1, body: '<!-- clearance:inspection verdict=CLEARED -->\nLooks right.', author: { username: 'ai-clearance-dispatch-g', name: 'Duo' }, created_at: now, system: false });

  const store = new Store(DEFAULT_POLICY, null);
  const sync = new GitLabSync(store, new GitLab({ baseUrl: mock.url, token: 'read-token' }), '42');
  await sync.syncAll(true);
  const f = store.flights.get('CLR-12');
  assert.ok(f, `flights: ${[...store.flights.keys()]}`);
  assert.equal(f!.pilot, 'ai-clearance-dispatch');
  assert.equal(f!.pilotKind, 'agent');
  assert.equal(f!.level, 'autonomous');
  assert.equal(f!.phase, 'landed');
  assert.ok(f!.evidence && f!.evidence.signed);
  assert.ok(f!.sci && f!.sci.sci > 0);
  assert.equal(f!.stages.verify.status, 'passed');
  assert.ok(f!.actions.some((a) => a.agent.startsWith('ai-clearance-dispatch')));
  assert.ok(store.agents().some((a) => a.pilot === 'ai-clearance-dispatch' && a.flights === 18));
  const held = store.flights.get('CLR-13');
  assert.equal(held?.level, 'hold');
});
