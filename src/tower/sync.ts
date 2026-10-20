// Live mode: rebuilds the airspace from GitLab and keeps it current.
//
// GitLab is the system of record. On start and every few minutes the Tower
// pulls recent merge requests, their pipelines, the black-box records CI
// wrote to the package registry, agent notes and the trust ledger, and turns
// them into flight events. Webhooks mark individual flights dirty so the
// console updates within a second or two of something happening in GitLab.

import { GitLab, type Job, type MergeRequest } from '../core/gitlab.ts';
import { CI_STAGE_TO_LIFECYCLE, flightIdForIssue, flightIdForMr, type FlightEvent } from '../core/events.ts';
import type { BlackBoxRecord } from '../core/evidence.ts';
import type { AuthorKind, ClearanceDecision, LedgerEntry, RiskAssessment, Stage } from '../core/types.ts';
import type { CanaryReport } from '../core/canary.ts';
import type { SciReport } from '../core/sci.ts';
import type { Store } from './store.ts';

const AGENT_RE = [/^ai-/i, /service_account/i, /duo/i, /bot$/i];
export const isAgent = (name?: string | null) => !!name && AGENT_RE.some((r) => r.test(name));

type Ev = FlightEvent;

export function jobsToStageEvents(flight: string, jobs: Job[]): Ev[] {
  const byStage = new Map<Stage, Job[]>();
  for (const j of jobs) {
    const st = CI_STAGE_TO_LIFECYCLE[j.stage];
    if (!st) continue;
    const list = byStage.get(st) ?? [];
    list.push(j);
    byStage.set(st, list);
  }
  const out: Ev[] = [];
  for (const [stage, list] of byStage) {
    const statuses = list.map((j) => j.status);
    const latest = list.reduce((a, b) => (Date.parse(b.finished_at ?? b.started_at ?? '0') > Date.parse(a.finished_at ?? a.started_at ?? '0') ? b : a));
    const at = latest.finished_at ?? latest.started_at ?? new Date().toISOString();
    const job = latest.name;
    if (statuses.includes('failed')) out.push({ type: 'stage.failed', flight, stage, job, url: list.find((j) => j.status === 'failed')?.web_url, at, source: 'sync' });
    else if (statuses.some((s) => s === 'running' || s === 'pending')) out.push({ type: 'stage.started', flight, stage, job, url: latest.web_url, at: latest.started_at ?? at, source: 'sync' });
    else if (statuses.every((s) => s === 'success' || s === 'skipped' || s === 'manual')) {
      if (statuses.some((s) => s === 'success')) out.push({ type: 'stage.passed', flight, stage, job, url: latest.web_url, at, source: 'sync' });
      else if (statuses.every((s) => s === 'skipped')) out.push({ type: 'stage.skipped', flight, stage, at, source: 'sync' });
    }
  }
  return out;
}

export function blackBoxToEvents(flight: string, records: BlackBoxRecord[]): Ev[] {
  const out: Ev[] = [];
  for (const r of records) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const at = r.at;
    switch (r.kind) {
      case 'assessment':
        if (d.risk) out.push({ type: 'assessment', flight, at, risk: d.risk as RiskAssessment, source: 'sync' });
        if (d.decision) out.push({ type: 'clearance', flight, at, decision: d.decision as ClearanceDecision, source: 'sync' });
        out.push({ type: 'stage.passed', flight, at, stage: 'plan', job: r.actor, source: 'sync' });
        break;
      case 'review':
        out.push({ type: 'agent.action', flight, at, agent: r.actor, action: 'reviewed the diff', detail: r.summary, source: 'sync' });
        break;
      case 'clearance':
        if (d.risk) out.push({ type: 'assessment', flight, at, risk: d.risk as RiskAssessment, source: 'sync' });
        if (d.decision) {
          const decision = d.decision as ClearanceDecision;
          out.push({ type: 'clearance', flight, at, decision, source: 'sync' });
          if (decision.level === 'hold') out.push({ type: 'flight.held', flight, at, detail: decision.reasons[0] ?? 'hold', level: 'hold', source: 'sync' });
        }
        break;
      case 'canary': {
        const step = typeof d.step === 'number' ? d.step : 0;
        out.push({ type: 'canary.step', flight, at, percent: step, source: 'sync' });
        if (d.report) out.push({ type: 'canary.verdict', flight, at, report: d.report as CanaryReport, source: 'sync' });
        break;
      }
      case 'deployment':
        if (r.actor === 'clearance:land') out.push({ type: 'flight.landed', flight, at, detail: String(d.verdict ?? 'landed'), source: 'sync' });
        else out.push({ type: 'stage.passed', flight, at, stage: 'configure', job: r.actor, detail: r.summary, source: 'sync' });
        break;
      case 'rollback':
        out.push({ type: 'flight.go-around', flight, at, detail: r.summary, source: 'sync' });
        break;
      case 'incident':
        out.push({ type: 'agent.action', flight, at, agent: r.actor, action: 'opened an incident', detail: r.summary, url: (d.url as string) ?? undefined, source: 'sync' });
        break;
      case 'release':
        out.push({ type: 'stage.passed', flight, at, stage: 'release', job: r.actor, detail: String(d.version ?? r.summary), source: 'sync' });
        break;
      case 'sci':
        out.push({ type: 'sci', flight, at, report: d as unknown as SciReport, source: 'sync' });
        break;
    }
  }
  return out;
}

function pilotFrom(records: BlackBoxRecord[], mr: MergeRequest): { pilot: string; kind: AuthorKind } {
  for (const r of records) {
    const p = (r.data as { pilot?: { name?: string; kind?: AuthorKind } } | null)?.pilot;
    if (p?.name) return { pilot: p.name, kind: p.kind ?? (isAgent(p.name) ? 'agent' : 'human') };
  }
  return { pilot: mr.author.username, kind: isAgent(mr.author.username) || mr.author.bot ? 'agent' : 'human' };
}

export class GitLabSync {
  private store: Store;
  private g: GitLab;
  private project: string;
  private seenMr = new Map<number, string>(); // iid -> updated_at fingerprint
  private dirty = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  lastSync: string | null = null;
  lastError: string | null = null;
  projectUrl: string | null = null;

  constructor(store: Store, g: GitLab, project: string) {
    this.store = store;
    this.g = g;
    this.project = project;
  }

  start(intervalMs = 20_000) {
    this.syncAll().catch((e) => (this.lastError = String(e)));
    this.timer = setInterval(() => this.syncAll().catch((e) => (this.lastError = String(e))), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(full = false) {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const mrs = await this.g.mergeRequests(this.project, `state=all&order_by=updated_at&sort=desc&updated_after=${since}&per_page=30`);
    if (!this.projectUrl && mrs[0]?.web_url) this.projectUrl = mrs[0].web_url.replace(/\/-\/merge_requests\/\d+$/, '');
    const work: Promise<void>[] = [];
    for (const mr of mrs.slice(0, 30)) {
      const fp = `${mr.updated_at}|${mr.state}`;
      const active = mr.state === 'opened' || (mr.merged_at && Date.now() - Date.parse(mr.merged_at) < 3_600_000);
      if (!full && this.seenMr.get(mr.iid) === fp && !active && !this.dirty.has(mr.iid)) continue;
      work.push(this.syncMr(mr.iid).then(() => void this.seenMr.set(mr.iid, fp)));
    }
    await Promise.allSettled(work);
    await this.syncIntents(since);
    await this.syncLedger();
    this.lastSync = new Date().toISOString();
    this.lastError = null;
  }

  async syncMr(iid: number) {
    this.dirty.delete(iid);
    const flight = flightIdForMr(iid);
    const mr = await this.g.mergeRequest(this.project, iid);
    const raw = await this.g.genericPackageFile(this.project, 'clearance-blackbox', flight, 'blackbox.json').catch(() => null);
    const records: BlackBoxRecord[] = raw ? JSON.parse(raw) : [];
    const { pilot, kind } = pilotFrom(records, mr);
    const events: Ev[] = [{ type: 'flight.opened', flight, at: mr.created_at, title: mr.title, pilot, pilotKind: kind, url: mr.web_url, source: 'sync' }];
    const linked = (mr.description ?? '').match(/(?:closes|fixes|resolves|implements)\s+#(\d+)/i);
    if (linked) events.push({ type: 'flight.linked', flight, at: mr.created_at, from: flightIdForIssue(linked[1]), source: 'sync' });
    events.push({ type: 'stage.passed', flight, at: mr.created_at, stage: 'create', detail: `!${iid} opened`, source: 'sync' });

    const pipelines = [];
    if (mr.head_pipeline) pipelines.push(mr.head_pipeline.id);
    const mergeSha = mr.merge_commit_sha ?? mr.squash_commit_sha;
    if (mergeSha) {
      const onMain = await this.g.pipelines(this.project, `sha=${mergeSha}&order_by=id&sort=desc`).catch(() => []);
      if (onMain[0]) pipelines.push(onMain[0].id);
    }
    for (const pid of pipelines) {
      const jobs = await this.g.pipelineJobs(this.project, pid).catch(() => [] as Job[]);
      events.push(...jobsToStageEvents(flight, jobs));
      const bridges = await this.g.pipelineBridges(this.project, pid).catch(() => []);
      for (const b of bridges) {
        if (!b.downstream_pipeline) continue;
        const child = await this.g.pipelineJobs(this.project, b.downstream_pipeline.id).catch(() => [] as Job[]);
        events.push(...jobsToStageEvents(flight, child.map((j) => ({ ...j, stage: 'verify' }))));
      }
    }
    events.push(...blackBoxToEvents(flight, records));

    // Agent activity: notes written by Duo flow service accounts.
    const notes = await this.g.get<{ body: string; author: { username: string; name: string }; created_at: string; system: boolean }[]>(
      `/projects/${encodeURIComponent(this.project)}/merge_requests/${iid}/notes?per_page=30&sort=desc`,
    ).catch(() => []);
    for (const n of notes) {
      if (n.system || !isAgent(n.author.username) || n.body.startsWith('<!-- clearance:report -->')) continue;
      events.push({ type: 'agent.action', flight, at: n.created_at, agent: n.author.username, action: 'commented', detail: firstLine(n.body), url: mr.web_url, source: 'sync' });
    }
    if (mr.state === 'closed') events.push({ type: 'flight.diverted', flight, at: mr.updated_at, detail: 'merge request closed', source: 'sync' });

    if (records.some((r) => r.actor === 'clearance:sci' || r.kind === 'release')) {
      const ev = await this.g.genericPackageFile(this.project, 'clearance-evidence', flight, 'evidence.json').catch(() => null);
      if (ev) {
        const pack = JSON.parse(ev) as { head: string; signature: string | null; records: unknown[]; controls: { framework: string; id: string }[]; createdAt: string };
        events.push({ type: 'evidence', flight, at: pack.createdAt, head: pack.head, signed: !!pack.signature, records: pack.records.length, controls: pack.controls.map((c) => `${c.framework} ${c.id}`), source: 'sync' });
      }
    }
    this.store.ingest(events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
  }

  async syncIntents(since: string) {
    const issues = await this.g.issues(this.project, `labels=intent&state=opened&updated_after=${since}&per_page=20`).catch(() => []);
    const events: Ev[] = [];
    for (const i of issues) {
      const flight = flightIdForIssue(i.iid);
      if (!this.store.flights.has(flight) && [...this.store.flights.values()].some((f) => f.intent === flight)) continue;
      events.push({ type: 'flight.opened', flight, at: i.created_at, title: i.title, pilot: i.author.username, pilotKind: 'human', url: i.web_url, intent: flight, source: 'sync' });
      events.push({ type: 'stage.started', flight, at: i.created_at, stage: 'plan', source: 'sync' });
    }
    this.store.ingest(events);
  }

  async syncLedger() {
    const raw = await this.g.genericPackageFile(this.project, 'clearance-ledger', 'v1', 'ledger.json').catch(() => null);
    if (raw) this.store.setLedger(JSON.parse(raw) as LedgerEntry[], false);
  }

  /** Normalises a GitLab webhook into immediate events plus a targeted refresh. */
  handleWebhook(kind: string, body: Record<string, any>): number {
    const events: Ev[] = [];
    const now = new Date().toISOString();
    let iid: number | null = null;
    if (kind === 'Merge Request Hook') {
      const a = body.object_attributes ?? {};
      iid = a.iid;
      const user = body.user?.username ?? 'unknown';
      if (a.action === 'open') events.push({ type: 'flight.opened', flight: flightIdForMr(a.iid), at: a.created_at ? new Date(a.created_at).toISOString() : now, title: a.title, pilot: user, pilotKind: isAgent(user) ? 'agent' : 'human', url: a.url, source: 'webhook' });
    } else if (kind === 'Pipeline Hook') {
      iid = body.merge_request?.iid ?? null;
      if (!iid) {
        const m = String(body.commit?.message ?? '').match(/See merge request [^!]*!(\d+)/);
        if (m) iid = Number(m[1]);
      }
      if (iid) {
        const jobs: Job[] = (body.builds ?? []).map((b: Record<string, any>) => ({
          id: b.id, name: b.name, stage: b.stage, status: b.status, duration: b.duration ?? null,
          started_at: b.started_at ? new Date(b.started_at).toISOString() : null,
          finished_at: b.finished_at ? new Date(b.finished_at).toISOString() : null,
          web_url: '', pipeline: { id: body.object_attributes?.id, ref: '', sha: '' },
        }));
        events.push(...jobsToStageEvents(flightIdForMr(iid), jobs).map((e) => ({ ...e, source: 'webhook' as const })));
      }
    } else if (kind === 'Note Hook') {
      const user = body.user?.username;
      const mrIid = body.merge_request?.iid;
      const issueIid = body.issue?.iid;
      if (isAgent(user) && !String(body.object_attributes?.note ?? '').startsWith('<!-- clearance:report -->')) {
        const flight = mrIid ? flightIdForMr(mrIid) : issueIid ? flightIdForIssue(issueIid) : null;
        if (flight) events.push({ type: 'agent.action', flight, at: now, agent: user, action: 'commented', detail: firstLine(body.object_attributes?.note ?? ''), url: body.object_attributes?.url, source: 'webhook' });
      }
      iid = mrIid ?? null;
    } else if (kind === 'Issue Hook') {
      const a = body.object_attributes ?? {};
      const labels: string[] = (body.labels ?? []).map((l: { title: string }) => l.title);
      if (labels.includes('intent') && a.action === 'open') {
        const flight = flightIdForIssue(a.iid);
        events.push({ type: 'flight.opened', flight, at: now, title: a.title, pilot: body.user?.username ?? 'unknown', pilotKind: 'human', url: a.url, intent: flight, source: 'webhook' });
        events.push({ type: 'stage.started', flight, at: now, stage: 'plan', source: 'webhook' });
      }
    } else if (kind === 'Deployment Hook' || kind === 'Release Hook' || kind === 'Job Hook') {
      this.syncAll().catch(() => {});
    }
    const applied = this.store.ingest(events);
    if (iid) {
      this.dirty.add(iid);
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        for (const d of [...this.dirty]) this.syncMr(d).catch((e) => (this.lastError = String(e)));
      }, 1500);
    }
    return applied;
  }
}

function firstLine(s: string): string {
  const line = s.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
