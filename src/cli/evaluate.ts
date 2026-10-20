// Shared evaluation used by `assess` (start of pipeline) and `gate` (after
// security scans): gather the change, the pilot's trust and the error budget,
// then ask the governor for a clearance decision.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assessRisk, isTestFile, parseNumstat } from '../core/risk.ts';
import { decide } from '../core/governor.ts';
import { scorePilot } from '../core/trust.ts';
import { buildImportGraph, impactedTests, type ImpactResult } from '../core/impact.ts';
import type { ChangeSet, ClearanceDecision, RiskAssessment, SecurityFinding, Severity, TrustScore } from '../core/types.ts';
import {
  env, ROOT, flightId, gitlab, identifyPilot, isMrPipeline, loadAirspace, loadLedger, loadPolicy, log, mrIid,
  projectId, readJson, readRepoFile, tryGit, warn,
} from './context.ts';

export interface Evaluation {
  flight: string;
  change: ChangeSet;
  range: string | null;
  risk: RiskAssessment;
  trust: TrustScore;
  decision: ClearanceDecision;
  errorBudget: number;
  impact: ImpactResult;
  webChanged: boolean;
  url?: string;
}

const ZERO_SHA = /^0+$/;

export function diffRange(): string | null {
  if (env.CLEARANCE_RANGE) return env.CLEARANCE_RANGE;
  const head = env.CI_COMMIT_SHA ?? 'HEAD';
  if (env.CI_MERGE_REQUEST_DIFF_BASE_SHA) return `${env.CI_MERGE_REQUEST_DIFF_BASE_SHA}...${head}`;
  const before = env.CI_COMMIT_BEFORE_SHA;
  if (before && !ZERO_SHA.test(before)) return `${before}..${head}`;
  if (tryGit('rev-parse', '--verify', 'origin/main')) {
    const base = tryGit('merge-base', 'origin/main', head);
    if (base && base !== tryGit('rev-parse', head)) return `${base}...${head}`;
  }
  return tryGit('rev-parse', '--verify', `${head}~1`) ? `${head}~1..${head}` : null;
}

function normSeverity(s: unknown): Severity {
  const v = String(s ?? '').toLowerCase();
  return (['critical', 'high', 'medium', 'low', 'info'] as const).find((x) => x === v) ?? 'unknown';
}

/** Reads GitLab security reports (SAST, secret detection, dependency scanning) if present. */
export function readFindings(): SecurityFinding[] {
  const reports: [string, string][] = [
    ['gl-sast-report.json', 'sast'],
    ['gl-secret-detection-report.json', 'secret_detection'],
    ['gl-dependency-scanning-report.json', 'dependency_scanning'],
    ['gl-container-scanning-report.json', 'container_scanning'],
  ];
  const out: SecurityFinding[] = [];
  for (const [file, scanner] of reports) {
    const rep = readJson<{ vulnerabilities?: { severity?: string; name?: string; message?: string; location?: { file?: string } }[] }>(file);
    for (const v of rep?.vulnerabilities ?? []) {
      out.push({ severity: normSeverity(v.severity), scanner, name: v.name ?? v.message ?? 'finding', file: v.location?.file });
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

export function analyzeImpact(changedPaths: string[]): ImpactResult {
  const files: Record<string, string> = {};
  for (const abs of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'test'))]) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    files[rel] = readRepoFile(rel) ?? '';
  }
  const shipped = changedPaths.filter((p) => /^(src|test)\//.test(p) || /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(p));
  return impactedTests(buildImportGraph(files), shipped, isTestFile);
}

async function errorBudget(): Promise<number> {
  if (env.CLEARANCE_ERROR_BUDGET) return Math.max(0, Math.min(1, Number(env.CLEARANCE_ERROR_BUDGET)));
  const url = env.CLEARANCE_TOWER_URL;
  if (!url) return 1;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/budget`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return 1;
    const body = (await res.json()) as { remaining?: number };
    return typeof body.remaining === 'number' ? body.remaining : 1;
  } catch {
    warn('Tower unreachable; assuming a full error budget');
    return 1;
  }
}

export async function evaluate(opts: { withFindings: boolean }): Promise<Evaluation> {
  const policy = loadPolicy();
  const airspace = loadAirspace();
  let flight = flightId();
  // Squash and fast-forward merges don't name the MR in the commit message; ask GitLab.
  if (flight.startsWith('SHA-') && env.CI_COMMIT_SHA && projectId()) {
    const g0 = gitlab();
    try {
      const mrs = g0 ? await g0.mergeRequestsForCommit(projectId(), env.CI_COMMIT_SHA) : [];
      if (mrs[0]) flight = `CLR-${mrs[0].iid}`;
    } catch {
      /* job tokens can't read this endpoint; keep the SHA-based id */
    }
  }
  const range = diffRange();
  const numstat = range ? tryGit('diff', '--numstat', '-M', range) ?? '' : '';
  const status = range ? tryGit('diff', '--name-status', '-M', range) ?? '' : '';
  const files = parseNumstat(numstat, status);
  if (!range) warn('could not determine a diff range; assessing an empty change');

  let title = env.CI_MERGE_REQUEST_TITLE ?? tryGit('log', '-1', '--format=%s') ?? '';
  let labels = (env.CI_MERGE_REQUEST_LABELS ?? '').split(',').filter(Boolean);
  let mrAuthor: string | undefined;
  let url: string | undefined;
  const g = gitlab();
  const iid = mrIid();
  if (g && iid && projectId()) {
    try {
      const mr = await g.mergeRequest(projectId(), iid);
      title = mr.title;
      labels = mr.labels;
      mrAuthor = mr.author.username;
      url = mr.web_url;
    } catch (e) {
      warn(`could not read the merge request: ${(e as Error).message}`);
    }
  }
  const { pilot, kind } = identifyPilot(range, mrAuthor);

  const ledger = await loadLedger();
  const trust = scorePilot(pilot, ledger.filter((e) => e.pilot === pilot), policy);
  trust.pilotKind = kind;

  const findings = opts.withFindings ? readFindings() : [];
  const cov = readJson<{ lines: number }>('.clearance-out/coverage.json');
  const change: ChangeSet = { title, author: pilot, authorKind: kind, files, labels, findings, coverage: cov?.lines ?? null };
  const risk = assessRisk(change, airspace);
  const budget = await errorBudget();
  const decision = decide({ change, risk, trust, errorBudget: budget, policy });
  const impact = analyzeImpact(files.map((f) => f.path));
  const webChanged = files.some((f) => f.path.startsWith('src/web/') || f.path === 'package.json');

  log(`${flight}: ${files.length} file(s), pilot ${pilot} (${kind}), trust ${(trust.trust * 100).toFixed(0)}%`);
  log(`risk ${(risk.score * 100).toFixed(1)}% (${risk.band}) → ${decision.level.toUpperCase()}, ${decision.tier} pipeline`);
  for (const r of decision.reasons) log(`  · ${r}`);
  if (!isMrPipeline() && !range) warn('not a merge request pipeline');

  return { flight, change, range, risk, trust, decision, errorBudget: budget, impact, webChanged, url };
}

export function riskTable(e: Evaluation): string {
  const rows = e.risk.signals
    .map((s) => `| ${s.label} | ${(s.probability * 100).toFixed(1)}% | ${s.detail.replace(/\|/g, '\\|')} |`)
    .join('\n');
  return `| Signal | Contribution | Detail |\n|---|---:|---|\n${rows || '| none | 0% | |'}`;
}
