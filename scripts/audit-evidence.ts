// Nightly audit: re-verify the hash chain of every recent flight's black box.
// A broken chain means a record was edited or removed after the fact.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { GitLab } from '../src/core/gitlab.ts';
import { verifyChain, verifySignature, type BlackBoxRecord, type EvidencePack } from '../src/core/evidence.ts';

const env = process.env;
let broken = 0;
let checked = 0;

function check(flight: string, records: BlackBoxRecord[], pack?: EvidencePack) {
  checked++;
  const r = verifyChain(records);
  let sig = 'unsigned';
  if (pack?.signature && env.CLEARANCE_SIGNING_KEY) sig = verifySignature(pack.head, pack.signature, env.CLEARANCE_SIGNING_KEY) ? 'signature ok' : 'SIGNATURE MISMATCH';
  if (!r.ok || sig === 'SIGNATURE MISMATCH') broken++;
  console.log(`${flight.padEnd(12)} ${records.length.toString().padStart(3)} records  ${r.ok ? 'chain intact' : `BROKEN at ${r.brokenAt}`}  ${sig}`);
}

if (existsSync('evidence')) {
  for (const f of readdirSync('evidence').filter((x) => x.endsWith('.json'))) {
    const pack = JSON.parse(readFileSync(`evidence/${f}`, 'utf8')) as EvidencePack;
    check(pack.flight, pack.records, pack);
  }
}

const g = GitLab.fromEnv(env);
if (g && env.CI_PROJECT_ID) {
  const mrs = await g.mergeRequests(env.CI_PROJECT_ID, 'state=merged&order_by=updated_at&sort=desc&per_page=50');
  for (const mr of mrs) {
    const flight = `CLR-${mr.iid}`;
    const raw = await g.genericPackageFile(env.CI_PROJECT_ID, 'clearance-blackbox', flight, 'blackbox.json').catch(() => null);
    if (raw) check(flight, JSON.parse(raw));
  }
}

console.log(`\n${checked} black box(es) checked, ${broken} broken`);
if (broken > 0) process.exitCode = 1;
