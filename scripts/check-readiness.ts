// Reproduce the local submission checks and save their evidence. Local success
// is deliberately separate from account provisioning and live Duo execution.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.clearance-out/readiness');
const proof = join(root, 'docs/proof/local');
mkdirSync(output, { recursive: true });
mkdirSync(proof, { recursive: true });

const commands = [
  { name: 'types', args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'] },
  { name: 'tests', args: ['--test', '--test-reporter=spec', 'test/*.test.ts'] },
  { name: 'build', args: ['scripts/build-web.ts'] },
  { name: 'bundle', args: ['src/cli/clearance.ts', 'budget', 'dist/web'] },
  { name: 'docs', args: ['src/cli/clearance.ts', 'doccheck'] },
  { name: 'smoke', args: ['test/smoke.ts'] },
];

const results: { name: string; passed: boolean; code: number; durationMs: number; log: string }[] = [];
for (const command of commands) {
  const started = Date.now();
  const child = spawn(process.execPath, command.args, {
    cwd: root,
    env: { ...process.env, CLEARANCE_MODE: 'simulated', CLEARANCE_E2E_EVIDENCE_DIR: proof },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += String(chunk); });
  child.stderr.on('data', (chunk) => { log += String(chunk); });
  const code = await new Promise<number>((resolve) => {
    child.on('error', (error) => { log += error.message; resolve(1); });
    child.on('close', (status) => resolve(status ?? 1));
  });
  const logFile = `${command.name}.log`;
  writeFileSync(join(output, logFile), log);
  results.push({ name: command.name, passed: code === 0, code, durationMs: Date.now() - started, log: `.clearance-out/readiness/${logFile}` });
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${command.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (code !== 0) console.log(log.slice(-4000));
}

const tests = readFileSync(join(output, 'tests.log'), 'utf8');
const count = Number(tests.match(/tests (\d+)/)?.[1] ?? 0);
const passed = Number(tests.match(/pass (\d+)/)?.[1] ?? 0);
const bundle = JSON.parse(readFileSync(join(root, '.clearance-out/bundle.json'), 'utf8')) as { totalGzipBytes: number; budgetKb: number };
const report = {
  schema: 'clearance.readiness/v1',
  createdAt: new Date().toISOString(),
  localReady: results.every((check) => check.passed),
  submissionReady: false,
  tests: { count, passed },
  bundle,
  checks: results,
  external: {
    gitlabWorkspace: 'Pending hackathon workspace provisioning',
    liveDuoWorkflow: 'Not run; local mock evidence is not a live Duo session',
    cloudDeployment: 'Hosted preview is recorded separately in docs/proof/cloud-deployment.json; this local check does not verify live deployment reachability',
    youtubeVideo: 'Pending final recording of real workflow and upload',
    devpostSubmission: 'Pending owner registration and completed submission',
  },
};
mkdirSync(join(root, 'docs/proof'), { recursive: true });
writeFileSync(join(root, 'docs/proof/readiness.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.localReady ? 'Local checks complete.' : 'Local checks need attention.'} External submission steps remain pending.`);
process.exitCode = report.localReady ? 0 : 1;
