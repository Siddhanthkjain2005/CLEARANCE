// `clearance fly`: progressive delivery with statistical canary analysis.
// `clearance land`: record the outcome in the trust ledger and the MR.

import { analyzeCanary, type CanaryReport, type RevisionSample } from '../../core/canary.ts';
import type { ClearanceDecision } from '../../core/types.ts';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudRunDeployer, DrillDeployer, type Deployer } from '../deployer.ts';
import {
  ROOT, appendLedger, emit, env, flightMrIid, gitlabWriter, loadPolicy, log, projectId, readJson, recordBlackBox, warn,
  writeDotenv, writeOut,
} from '../context.ts';

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ClearanceFile {
  flight: string;
  risk: { score: number; runtimeChange: boolean };
  decision: ClearanceDecision;
  pilot: { name: string; kind: 'agent' | 'human'; trust: number };
}

interface FlyArgs {
  drill?: boolean;
  fault?: 'errors' | 'latency' | null;
  rps?: number;
  timeScale?: number; // shrink bake times for drills and demos
}

async function bake(d: Deployer, url: string, seconds: number, rps: number, stable: string | null, canary: string) {
  const samples = new Map<string, RevisionSample>();
  const get = (rev: string) => {
    let s = samples.get(rev);
    if (!s) samples.set(rev, (s = { revision: rev, requests: 0, errors: 0, latenciesMs: [] }));
    return s;
  };
  const total = Math.max(1, Math.round(seconds * rps));
  const interval = 1000 / rps;
  const inflight: Promise<void>[] = [];
  const started = Date.now();
  for (let i = 0; i < total; i++) {
    inflight.push(
      d.probe(url).then((r) => {
        const s = get(r.revision === canary ? canary : r.revision === 'unknown' ? 'unknown' : stable ?? r.revision);
        s.requests++;
        if (!r.ok) s.errors++;
        s.latenciesMs.push(r.ms);
      }),
    );
    if (d.name !== 'drill') {
      const wait = started + (i + 1) * interval - Date.now();
      if (wait > 0) await sleep(wait);
    }
    if (inflight.length >= 64) await Promise.all(inflight.splice(0));
  }
  await Promise.all(inflight);
  const empty = (rev: string): RevisionSample => ({ revision: rev, requests: 0, errors: 0, latenciesMs: [] });
  return { baseline: samples.get(stable ?? '') ?? empty(stable ?? 'stable'), canary: samples.get(canary) ?? empty(canary) };
}

export async function fly(args: FlyArgs) {
  const clr = readJson<ClearanceFile>('.clearance-out/clearance.json');
  if (!clr) throw new Error('run `clearance assess` first: .clearance-out/clearance.json is missing');
  const policy = loadPolicy();
  const flight = clr.flight;
  const plan = clr.decision.canary;
  if (!plan || clr.decision.level === 'hold') {
    log(clr.decision.level === 'hold' ? 'flight is on hold; not deploying' : 'nothing shipped changed; the flight taxis without a deployment');
    writeOut('.clearance-out/canary.json', JSON.stringify({ verdict: 'taxi', flight }, null, 2));
    writeDotenv('canary.env', { CLEARANCE_VERDICT: 'taxi' });
    return;
  }

  const scale = args.timeScale ?? Number(env.CLEARANCE_TIME_SCALE ?? 1);
  const rps = args.rps ?? Number(env.CLEARANCE_CANARY_RPS ?? 20);
  const deployer: Deployer = args.drill
    ? new DrillDeployer(7, args.fault === 'errors' ? { errorRate: 0.08 } : args.fault === 'latency' ? { latencyFactor: 2.6 } : {})
    : new CloudRunDeployer(env.CLEARANCE_SERVICE ?? 'clearance-tower', env.CLEARANCE_REGION ?? 'northamerica-northeast1', env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT_ID);

  const before = await deployer.describe();
  const stable = before.traffic.find((t) => t.percent > 0)?.revision ?? null;
  const image = env.CLEARANCE_IMAGE ?? `${env.CI_REGISTRY_IMAGE ?? 'clearance'}:${env.CI_COMMIT_SHA ?? 'dev'}`;
  const drill = env.CLEARANCE_DRILL ?? (args.fault ?? '');
  const deployed = await deployer.deployCanary(image, {
    CLEARANCE_ROLE: 'canary',
    CLEARANCE_COMMIT: env.CI_COMMIT_SHA ?? 'dev',
    CLEARANCE_FLIGHT: flight,
    ...(drill ? { CLEARANCE_DRILL: drill } : {}),
  });
  const canary = deployed.revision;
  const url = before.url ?? deployed.url;
  log(`canary revision ${canary} deployed${stable ? ` beside ${stable}` : ' (first deployment)'} via ${deployer.name}`);
  await recordBlackBox(flight, { stage: 'configure', actor: 'clearance:fly', kind: 'deployment', summary: `Deployed ${canary} with no traffic`, data: { canary, stable, image, plan } });
  await emit([{ type: 'stage.passed', flight, at: now(), stage: 'configure', job: 'clearance:fly', detail: `revision ${canary}` }]);

  if (!stable) {
    // Nothing to compare against on the very first deployment.
    await deployer.promote(canary);
    const report: CanaryReport = {
      verdict: 'promote', checks: [{ id: 'traffic', passed: true, summary: 'First deployment: no baseline to compare', metrics: {} }],
      baseline: { revision: 'none', requests: 0, errorRate: 0, p50: 0, p95: 0 }, canary: { revision: canary, requests: 0, errorRate: 0, p50: 0, p95: 0 },
    };
    return finish(flight, report, canary, stable, plan.steps);
  }

  let last: CanaryReport | null = null;
  for (const step of plan.steps) {
    if (step >= 100) break;
    await deployer.setTraffic(stable, canary, step);
    await emit([{ type: 'canary.step', flight, at: now(), percent: step, revision: canary }]);
    log(`step ${step}%: baking for ${Math.round(plan.bakeSeconds * scale)}s at ${rps} req/s`);
    let report: CanaryReport | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await bake(deployer, url, plan.bakeSeconds * scale, rps, stable, canary);
      report = analyzeCanary(s.baseline, s.canary, policy);
      for (const c of report.checks) log(`  ${c.passed ? '✓' : '✗'} ${c.summary}`);
      if (report.verdict !== 'extend') break;
      log('  not enough traffic yet; extending the bake');
    }
    last = report!;
    await recordBlackBox(flight, { stage: 'monitor', actor: 'clearance:fly', kind: 'canary', summary: `${step}% step: ${last.verdict}`, data: { step, report: last } });
    if (last.verdict !== 'promote') {
      await deployer.rollback(stable, canary);
      log(`go-around: traffic returned to ${stable}`);
      return finish(flight, { ...last, verdict: 'rollback' }, canary, stable, plan.steps, step);
    }
  }
  await deployer.promote(canary);
  log(`landed: ${canary} now serves 100% of traffic`);
  return finish(flight, last!, canary, stable, plan.steps);
}

async function finish(flight: string, report: CanaryReport, canary: string, stable: string | null, steps: number[], failedAt?: number) {
  writeOut('.clearance-out/canary.json', JSON.stringify({ flight, verdict: report.verdict, failedAt: failedAt ?? null, canary, stable, steps, report }, null, 2));
  writeDotenv('canary.env', { CLEARANCE_VERDICT: report.verdict, CLEARANCE_CANARY_REVISION: canary, CLEARANCE_STABLE_REVISION: stable ?? '' });
  await emit([
    { type: 'canary.verdict', flight, at: now(), report },
    { type: report.verdict === 'promote' ? 'stage.passed' : 'stage.failed', flight, at: now(), stage: 'monitor', job: 'clearance:fly', detail: report.verdict },
  ]);
  if (report.verdict === 'rollback') process.exitCode = 0; // a go-around is a successful safety outcome, not a CI failure
}

export async function land() {
  const clr = readJson<ClearanceFile>('.clearance-out/clearance.json');
  const can = readJson<{ verdict: string; report?: CanaryReport; failedAt?: number | null; canary?: string }>('.clearance-out/canary.json');
  if (!clr) throw new Error('missing .clearance-out/clearance.json');
  const flight = clr.flight;
  const verdict = can?.verdict ?? 'taxi';
  const outcome = verdict === 'rollback' ? 'go-around' : 'landed';
  const ledger = await appendLedger({
    flight, pilot: clr.pilot.name, pilotKind: clr.pilot.kind, risk: clr.risk.score, level: clr.decision.level, outcome, at: now(),
  });
  log(`${flight} ${outcome}; trust ledger now holds ${ledger.length} flight(s)`);
  await recordBlackBox(flight, {
    stage: 'monitor', actor: 'clearance:land', kind: outcome === 'landed' ? 'deployment' : 'rollback',
    summary: outcome === 'landed' ? (verdict === 'taxi' ? 'Taxied: no deployment needed' : 'Landed: canary promoted to 100%') : `Go-around at ${can?.failedAt ?? '?'}% traffic`,
    data: { verdict, report: can?.report ?? null },
  });

  const iid = flightMrIid(flight);
  const w = gitlabWriter();
  if (w && iid) {
    try {
      await w.updateMergeRequest(projectId(), iid, { add_labels: `flight::${outcome}` });
    } catch (e) {
      warn(`could not label the merge request: ${(e as Error).message}`);
    }
  }
  const rel = readJson<{ version: string }>('.clearance-out/release.json');
  if (rel && w) {
    const status = outcome === 'landed'
      ? `| Status | Landed: promoted to 100% after canary analysis |`
      : `| Status | **Withdrawn**: went around at ${can?.failedAt ?? '?'}% canary traffic and was rolled back automatically |`;
    try {
      const current = await w.get<{ description: string }>(`/projects/${encodeURIComponent(projectId())}/releases/${encodeURIComponent(rel.version)}`);
      await w.request('PUT', `/projects/${encodeURIComponent(projectId())}/releases/${encodeURIComponent(rel.version)}`, {
        description: current.description.replace(/\| Status \|.*\|/, status),
        ...(outcome === 'go-around' ? { name: `${rel.version} · ${flight} (withdrawn)` } : {}),
      });
    } catch (e) {
      warn(`could not update release ${rel.version}: ${(e as Error).message}`);
    }
  }
  if (outcome === 'go-around' && w) {
    const failed = can?.report?.checks.filter((c) => !c.passed).map((c) => `- ${c.summary}`).join('\n') ?? '';
    try {
      const issue = await w.createIssue(projectId(), {
        title: `Go-around: ${flight} rolled back during canary`,
        issue_type: 'incident',
        labels: 'clearance::go-around,incident::automated',
        description: [
          `Clearance rolled back **${flight}** automatically at ${can?.failedAt ?? '?'}% canary traffic. Production traffic is back on the stable revision; no human action was needed to restore service.`,
          '',
          '**Failed checks**',
          failed,
          '',
          `Pilot: \`${clr.pilot.name}\` · risk ${(clr.risk.score * 100).toFixed(0)}% · clearance ${clr.decision.level}`,
          `Pipeline: ${env.CI_PIPELINE_URL ?? 'local'}`,
          '',
          'The Debrief agent writes the postmortem on this incident. Mention the debrief flow here to rerun it.',
        ].join('\n'),
      });
      log(`opened incident ${issue.web_url}`);
      await recordBlackBox(flight, { stage: 'monitor', actor: 'clearance:land', kind: 'incident', summary: `Opened incident #${issue.iid}`, data: { url: issue.web_url } });
    } catch (e) {
      warn(`could not open the incident: ${(e as Error).message}`);
    }
  }
  await emit([
    { type: outcome === 'landed' ? 'flight.landed' : 'flight.go-around', flight, at: now(), detail: verdict, level: clr.decision.level },
  ]);
  // Appended to the canary dotenv so later jobs (debrief) see the outcome.
  appendFileSync(join(ROOT, 'canary.env'), `CLEARANCE_OUTCOME=${outcome}\n`);
}
