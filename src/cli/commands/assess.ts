// `clearance assess` (start of every pipeline) and `clearance gate`
// (after security scanning, on merge requests).

import { avoidedJobs, generateChildPipeline, plannedJobs } from '../../core/pipeline.ts';
import type { FlightEvent } from '../../core/events.ts';
import { evaluate, riskTable, type Evaluation } from '../evaluate.ts';
import {
  emit, env, gitlab, gitlabWriter, isMrPipeline, loadBlackBox, log, mrIid, projectId, recordBlackBox, upsertMrNote,
  warn, writeDotenv, writeOut,
} from '../context.ts';
import type { ClearanceDecision } from '../../core/types.ts';

const now = () => new Date().toISOString();
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function persist(e: Evaluation, phase: 'assess' | 'gate') {
  const ctx = { impact: e.impact, webChanged: e.webChanged };
  const planned = plannedJobs(e.decision.tier, ctx).map((j) => j.name);
  const avoided = avoidedJobs(e.decision.tier, ctx);
  const payload = {
    schema: 'clearance.decision/v1',
    phase,
    flight: e.flight,
    at: now(),
    commit: env.CI_COMMIT_SHA ?? null,
    pilot: { name: e.trust.pilot, kind: e.change.authorKind, trust: e.trust.trust, flights: e.trust.flights, streak: e.trust.streak },
    risk: e.risk,
    decision: e.decision,
    errorBudget: e.errorBudget,
    pipeline: { tier: e.decision.tier, planned, avoided, impact: e.impact },
  };
  writeOut('.clearance-out/clearance.json', JSON.stringify(payload, null, 2));
  writeDotenv('clearance.env', {
    CLEARANCE_FLIGHT: e.flight,
    CLEARANCE_LEVEL: e.decision.level,
    CLEARANCE_TIER: e.decision.tier,
    CLEARANCE_RISK: e.risk.score,
    CLEARANCE_RUNTIME_CHANGE: e.risk.runtimeChange,
    CLEARANCE_PILOT: e.trust.pilot,
  });
  return payload;
}

/** On the default branch, honour the clearance issued on the merge request. */
async function carryForward(e: Evaluation): Promise<Evaluation> {
  if (isMrPipeline()) return e;
  const chain = await loadBlackBox(e.flight);
  const issued = [...chain].reverse().find((r) => r.kind === 'clearance' && r.actor === 'clearance:gate');
  const data = issued?.data as { decision?: ClearanceDecision } | undefined;
  if (!data?.decision) return e;
  log(`using the clearance issued on the merge request: ${data.decision.level.toUpperCase()}`);
  return { ...e, decision: { ...data.decision, reasons: [...data.decision.reasons, 'Clearance carried forward from the merge request'] } };
}

export async function assess() {
  const evaluated = await evaluate({ withFindings: false });
  const e = await carryForward(evaluated);
  const payload = persist(e, 'assess');
  const child = generateChildPipeline({ tier: e.decision.tier, impact: e.impact, webChanged: e.webChanged });
  writeOut('.clearance-out/child-pipeline.yml', child);
  log(`generated a ${e.decision.tier} child pipeline with ${payload.pipeline.planned.length} job(s); ${payload.pipeline.avoided.length} avoided`);

  await recordBlackBox(e.flight, {
    stage: 'plan',
    actor: 'clearance:assess',
    kind: 'assessment',
    summary: `Risk ${pct(e.risk.score)} (${e.risk.band}); preliminary clearance ${e.decision.level}`,
    data: { risk: e.risk, decision: e.decision, pilot: payload.pilot, pipeline: payload.pipeline },
  });
  const events: FlightEvent[] = [
    { type: 'flight.opened', flight: e.flight, at: now(), title: e.change.title, pilot: e.trust.pilot, pilotKind: e.change.authorKind, url: e.url },
    { type: 'stage.passed', flight: e.flight, at: now(), stage: 'plan', job: 'clearance:assess', url: env.CI_JOB_URL },
    { type: 'stage.passed', flight: e.flight, at: now(), stage: 'create', detail: `${e.risk.files} files, ${e.risk.churn} lines` },
    { type: 'assessment', flight: e.flight, at: now(), risk: e.risk },
    { type: 'clearance', flight: e.flight, at: now(), decision: e.decision },
  ];
  await emit(events);
}

function noteBody(e: Evaluation, avoidedCount: number): string {
  const d = e.decision;
  const head: Record<string, string> = {
    autonomous: '🟢 **Cleared for autonomous landing.** No human approval needed; this merge request will merge and deploy on its own.',
    supervised: '🟡 **Cleared under supervision.** One approval of the outcome is needed before this merges.',
    assisted: '🟠 **Cleared with assistance.** A human approves each step; two approvals are required.',
    hold: '🔴 **Holding.** This flight cannot proceed until the hold is resolved.',
  };
  const canary = d.canary ? `Canary steps ${d.canary.steps.map((s) => `${s}%`).join(' → ')}, ${d.canary.bakeSeconds}s bake per step` : 'No deployment needed';
  return [
    `### Clearance ${e.flight}`,
    head[d.level],
    '',
    `**Risk ${pct(e.risk.score)}** (${e.risk.band}) · **Pilot** \`${e.trust.pilot}\` (${e.change.authorKind}, trust ${pct(e.trust.trust)}, ${e.trust.streak} clean landing${e.trust.streak === 1 ? '' : 's'} in a row) · **Error budget** ${pct(e.errorBudget)}`,
    '',
    ...d.reasons.map((r) => `- ${r}`),
    '',
    '<details><summary>Risk breakdown</summary>',
    '',
    riskTable(e),
    '',
    `Sectors: ${e.risk.sectors.map((s) => `\`${s.sector}\``).join(', ') || 'none'} · blast radius ${e.risk.blastRadius}`,
    '</details>',
    '',
    `**Flight plan:** ${d.tier} verification pipeline (${avoidedCount} job${avoidedCount === 1 ? '' : 's'} avoided versus a fixed pipeline) · ${canary}`,
    '',
    `<sub>Decided by the deterministic governor from \`.clearance/policy.yml\`. Agents propose; policy disposes.</sub>`,
  ].join('\n');
}

/** Pulls the Inspector agent's verdict from MR notes into the black box. */
async function inspectorVerdict(iid: number): Promise<{ verdict: string; author: string } | null> {
  const g = gitlab();
  if (!g || !projectId()) return null;
  try {
    const notes = await g.get<{ body: string; author: { username: string } }[]>(
      `/projects/${encodeURIComponent(projectId())}/merge_requests/${iid}/notes?per_page=100&sort=desc`,
    );
    for (const n of notes) {
      const m = n.body.match(/<!--\s*clearance:inspection\s+verdict=(\w+)\s*-->/);
      if (m) return { verdict: m[1].toUpperCase(), author: n.author.username };
    }
  } catch (e) {
    warn(`could not read inspection notes: ${(e as Error).message}`);
  }
  return null;
}

export async function gate() {
  const e = await evaluate({ withFindings: true });
  const payload = persist(e, 'gate');
  const iid = mrIid();
  const findings = e.change.findings ?? [];

  await recordBlackBox(e.flight, {
    stage: 'secure', actor: 'clearance:gate', kind: 'security',
    summary: findings.length ? `${findings.length} scanner finding(s)` : 'No scanner findings',
    data: { findings: findings.slice(0, 200) },
  });
  if (iid) {
    const insp = await inspectorVerdict(iid);
    if (insp) {
      await recordBlackBox(e.flight, { stage: 'verify', actor: insp.author, kind: 'review', summary: `Inspector verdict: ${insp.verdict}`, data: insp });
    }
  }
  await recordBlackBox(e.flight, {
    stage: 'secure', actor: 'clearance:gate', kind: 'clearance',
    summary: `${e.decision.level} at risk ${pct(e.risk.score)} with trust ${pct(e.trust.trust)}`,
    data: { decision: e.decision, risk: e.risk, pilot: payload.pilot, errorBudget: e.errorBudget },
  });

  if (iid) {
    await upsertMrNote(iid, noteBody(e, payload.pipeline.avoided.length));
    const w = gitlabWriter();
    if (w) {
      try {
        await w.updateMergeRequest(projectId(), iid, { add_labels: `clearance::${e.decision.level},risk::${e.risk.band}` });
      } catch (err) {
        warn(`could not label the merge request: ${(err as Error).message}`);
      }
      if (e.decision.level === 'autonomous' && env.CLEARANCE_AUTOMERGE !== 'false') {
        try {
          await w.autoMerge(projectId(), iid, env.CI_COMMIT_SHA ?? '');
          log('auto-merge set: the merge request lands when this pipeline succeeds');
        } catch (err) {
          warn(`could not set auto-merge: ${(err as Error).message}`);
        }
      } else if (e.decision.level === 'supervised' || e.decision.level === 'assisted') {
        try {
          await w.request('POST', `/projects/${encodeURIComponent(projectId())}/merge_requests/${iid}/approval_rules`, {
            name: `Clearance: ${e.decision.level}`,
            approvals_required: e.decision.approvalsRequired,
          });
        } catch {
          // Approval rules need GitLab Premium; the label and note still tell humans what to do.
        }
      }
    }
  }

  await emit([
    { type: 'stage.passed', flight: e.flight, at: now(), stage: 'secure', job: 'clearance:gate', detail: findings.length ? `${findings.length} findings` : 'clean' },
    { type: 'assessment', flight: e.flight, at: now(), risk: e.risk },
    { type: 'clearance', flight: e.flight, at: now(), decision: e.decision },
    ...(e.decision.level === 'hold' ? [{ type: 'flight.held' as const, flight: e.flight, at: now(), detail: e.decision.reasons.join('; '), level: e.decision.level }] : []),
  ]);

  if (e.decision.level === 'hold') {
    console.error(`\nHOLD: ${e.decision.reasons.join('; ')}`);
    console.error('A human must resolve the hold. Do not retry this job to bypass it.');
    process.exitCode = 3;
  }
}
