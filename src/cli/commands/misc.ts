// Small CI utilities: link checking, bundle budget, coverage, ledger view,
// and `explain` for trying the governor on a local working tree.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { computeTrust, landingsToEarnAutonomy } from '../../core/trust.ts';
import { evaluate, riskTable } from '../evaluate.ts';
import { ROOT, loadLedger, loadPolicy, log, writeOut } from '../context.ts';

function walk(dir: string, filter: (p: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, acc);
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

export function doccheck() {
  const files = walk(ROOT, (p) => p.endsWith('.md'));
  const broken: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const abs = resolve(dirname(f), decodeURIComponent(target));
      if (!existsSync(abs)) broken.push(`${relative(ROOT, f)} → ${m[1]}`);
    }
  }
  if (broken.length) {
    console.error(`${broken.length} broken link(s):\n${broken.map((b) => `  ${b}`).join('\n')}`);
    process.exitCode = 1;
  } else log(`${files.length} markdown files, all relative links resolve`);
}

/** Enforces a transfer-size budget on the console bundle: bytes are energy. */
export function budget(dir: string, maxKb = Number(process.env.CLEARANCE_BUNDLE_BUDGET_KB ?? 160)) {
  const files = walk(resolve(ROOT, dir), (p) => /\.(js|css|html)$/.test(p));
  let total = 0;
  const rows = files.map((f) => {
    const gz = gzipSync(readFileSync(f)).length;
    total += gz;
    return `${relative(ROOT, f).padEnd(40)} ${(gz / 1024).toFixed(1).padStart(7)} KB gz`;
  });
  rows.forEach((r) => log(r));
  log(`total ${(total / 1024).toFixed(1)} KB gzipped (budget ${maxKb} KB)`);
  writeOut('.clearance-out/bundle.json', JSON.stringify({ totalGzipBytes: total, budgetKb: maxKb, files: files.length }));
  if (total / 1024 > maxKb) {
    console.error('bundle is over budget');
    process.exitCode = 1;
  }
}

export function coverage(lcovPath: string) {
  const text = existsSync(lcovPath) ? readFileSync(lcovPath, 'utf8') : '';
  let found = 0;
  let hit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('LF:')) found += Number(line.slice(3));
    if (line.startsWith('LH:')) hit += Number(line.slice(3));
  }
  const pct = found ? hit / found : 0;
  writeOut('.clearance-out/coverage.json', JSON.stringify({ lines: Math.round(pct * 10_000) / 10_000, found, hit }));
  // GitLab picks this line up with the job's `coverage:` regex.
  console.log(`Line coverage: ${(pct * 100).toFixed(2)}%`);
}

export async function ledger() {
  const policy = loadPolicy();
  const entries = await loadLedger();
  const scores = [...computeTrust(entries, policy).values()].sort((a, b) => b.trust - a.trust);
  if (scores.length === 0) {
    log('the trust ledger is empty: every pilot starts with priors only');
    log(`a new agent needs about ${landingsToEarnAutonomy([], 'new', policy)} clean landings to earn autonomy`);
    return;
  }
  console.log('pilot'.padEnd(36), 'trust', ' flights', ' landed', ' go-arounds', ' streak', ' autonomy');
  for (const s of scores) {
    console.log(
      s.pilot.padEnd(36), `${(s.trust * 100).toFixed(0)}%`.padStart(5), String(s.flights).padStart(8), String(s.landed).padStart(7),
      String(s.goArounds + s.incidents).padStart(11), String(s.streak).padStart(7), s.autonomyEarned ? '  earned' : `  needs ${landingsToEarnAutonomy(entries, s.pilot, policy)} more`,
    );
  }
}

export async function explain() {
  const e = await evaluate({ withFindings: true });
  console.log(`\n${e.flight}  ${e.decision.level.toUpperCase()}  risk ${(e.risk.score * 100).toFixed(1)}% (${e.risk.band})  tier ${e.decision.tier}\n`);
  console.log(riskTable(e));
  console.log('');
  for (const r of e.decision.reasons) console.log(`- ${r}`);
}

/**
 * `clearance predict`: what would the governor decide for a planned change?
 * Duo agents call this from their flow sandbox before writing code, so they
 * can scope work to stay within the autonomy their pilot has earned.
 *   clearance predict --pilot ai-clearance-dispatch --files src/web/ui/A.tsx:40:8,test/a.test.ts:30:0
 */
export async function predict(args: string[]) {
  const { assessRisk } = await import('../../core/risk.ts');
  const { decide } = await import('../../core/governor.ts');
  const { scorePilot } = await import('../../core/trust.ts');
  const { loadAirspace } = await import('../context.ts');
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const spec = get('--files');
  if (!spec) {
    console.error('usage: clearance predict --files path:added:removed[,path:added:removed...] [--pilot name] [--human] [--json]');
    process.exitCode = 2;
    return;
  }
  const files = spec.split(',').filter(Boolean).map((f) => {
    const [path, a = '20', d = '0'] = f.split(':');
    return { path, additions: Number(a) || 0, deletions: Number(d) || 0 };
  });
  const pilot = get('--pilot') ?? 'ai-clearance-dispatch';
  const kind = args.includes('--human') ? 'human' : 'agent';
  const policy = loadPolicy();
  const ledger = await loadLedger();
  const trust = scorePilot(pilot, ledger.filter((e) => e.pilot === pilot), policy);
  const change = { title: get('--title') ?? 'planned change', author: pilot, authorKind: kind as 'agent' | 'human', files };
  const risk = assessRisk(change, loadAirspace());
  const decision = decide({ change, risk, trust, errorBudget: Number(process.env.CLEARANCE_ERROR_BUDGET ?? 1), policy });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ level: decision.level, risk: risk.score, band: risk.band, allowance: decision.allowance, trust: trust.trust, reasons: decision.reasons, signals: risk.signals, tier: decision.tier }, null, 2));
    return;
  }
  console.log(`Predicted clearance: ${decision.level.toUpperCase()} (risk ${(risk.score * 100).toFixed(1)}%, allowance ${(decision.allowance * 100).toFixed(0)}%, trust ${(trust.trust * 100).toFixed(0)}%)`);
  for (const r of decision.reasons) console.log(`- ${r}`);
  for (const s of risk.signals) console.log(`  ${s.label.padEnd(20)} ${(s.probability * 100).toFixed(1).padStart(5)}%  ${s.detail}`);
}
