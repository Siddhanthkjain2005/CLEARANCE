// Shared plumbing for CI commands: environment, repository files, git,
// GitLab API access, the black-box and ledger stores, and the Tower client.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseAirspace, parsePolicy } from '../core/config.ts';
import { GitLab, GitLabError } from '../core/gitlab.ts';
import { appendRecord, type BlackBoxRecord } from '../core/evidence.ts';
import type { FlightEvent } from '../core/events.ts';
import type { Airspace, AutonomyPolicy, AuthorKind, LedgerEntry } from '../core/types.ts';

export const env = process.env;

export const ROOT = env.CI_PROJECT_DIR ?? process.cwd();

export function readRepoFile(rel: string): string | null {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export function loadPolicy(): AutonomyPolicy {
  return parsePolicy(readRepoFile('.clearance/policy.yml'));
}

export function loadAirspace(): Airspace {
  return parseAirspace(readRepoFile('.clearance/airspace.yml'));
}

export function writeOut(rel: string, content: string): string {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function readJson<T>(rel: string): T | null {
  const s = readRepoFile(rel);
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

export const projectId = () => env.CI_PROJECT_ID ?? env.CLEARANCE_PROJECT_ID ?? '';
export const mrIid = () => (env.CI_MERGE_REQUEST_IID ? Number(env.CI_MERGE_REQUEST_IID) : null);
export const isMrPipeline = () => !!env.CI_MERGE_REQUEST_IID;

export function gitlab(): GitLab | null {
  return GitLab.fromEnv(env);
}

/** A GitLab client that can write (notes, labels, merges): needs CLEARANCE_TOKEN. */
export function gitlabWriter(): GitLab | null {
  const base = env.CI_API_V4_URL ?? env.CLEARANCE_GITLAB_API;
  if (!base || !env.CLEARANCE_TOKEN) return null;
  return new GitLab({ baseUrl: base, token: env.CLEARANCE_TOKEN });
}

/** Package registry access: works with the job token, no extra secret needed. */
export function gitlabPackages(): GitLab | null {
  const base = env.CI_API_V4_URL ?? env.CLEARANCE_GITLAB_API;
  if (!base) return null;
  if (env.CLEARANCE_TOKEN) return new GitLab({ baseUrl: base, token: env.CLEARANCE_TOKEN });
  if (env.CI_JOB_TOKEN) return new GitLab({ baseUrl: base, jobToken: env.CI_JOB_TOKEN });
  return null;
}

export function log(msg: string) {
  process.stdout.write(`\x1b[36m[clearance]\x1b[0m ${msg}\n`);
}

export function warn(msg: string) {
  process.stdout.write(`\x1b[33m[clearance] warning:\x1b[0m ${msg}\n`);
}

/** Collapsible CI log section (GitLab job log syntax). */
export function section<T>(name: string, title: string, fn: () => T): T {
  const ts = Math.floor(Date.now() / 1000);
  process.stdout.write(`\x1b[0Ksection_start:${ts}:${name}\r\x1b[0K${title}\n`);
  try {
    return fn();
  } finally {
    process.stdout.write(`\x1b[0Ksection_end:${Math.floor(Date.now() / 1000)}:${name}\r\x1b[0K\n`);
  }
}

// ------------------------------------------------------------- pilots

const AGENT_PATTERNS = [/^ai-/i, /service_account/i, /duo/i, /\bbot\b/i, /-bot$/i];

export function isAgentIdentity(...ids: (string | undefined | null)[]): boolean {
  return ids.some((id) => !!id && AGENT_PATTERNS.some((re) => re.test(id)));
}

/**
 * Who flew this change? Commits made by Duo flows carry a
 * "Clearance-Pilot: <service account>" trailer (the flows are instructed to
 * add it); otherwise service-account commit identities are detected, and
 * finally the MR author is used.
 */
export function identifyPilot(range: string | null, mrAuthor?: string): { pilot: string; kind: AuthorKind } {
  if (range) {
    const trailers = tryGit('log', '--format=%(trailers:key=Clearance-Pilot,valueonly)', range);
    const t = trailers?.split('\n').map((s) => s.trim()).find(Boolean);
    if (t) return { pilot: t, kind: 'agent' };
    const authors = tryGit('log', '--format=%an|%ae', range)?.split('\n').filter(Boolean) ?? [];
    for (const a of authors) {
      const [name, email] = a.split('|');
      if (isAgentIdentity(name, email)) return { pilot: name, kind: 'agent' };
    }
    if (!mrAuthor && authors[0]) return { pilot: authors[0].split('|')[0], kind: 'human' };
  }
  const who = mrAuthor ?? env.GITLAB_USER_LOGIN ?? 'unknown';
  return { pilot: who, kind: isAgentIdentity(who) ? 'agent' : 'human' };
}

// ------------------------------------------------------------- flight id

export function flightId(): string {
  if (env.CLEARANCE_FLIGHT) return env.CLEARANCE_FLIGHT;
  if (env.CI_MERGE_REQUEST_IID) return `CLR-${env.CI_MERGE_REQUEST_IID}`;
  // On the default branch, find the MR that introduced this commit.
  const msg = tryGit('log', '-1', '--format=%B') ?? '';
  const m = msg.match(/See merge request [^!]*!(\d+)/) ?? msg.match(/\(!(\d+)\)/);
  if (m) return `CLR-${m[1]}`;
  return `SHA-${(env.CI_COMMIT_SHORT_SHA ?? tryGit('rev-parse', '--short', 'HEAD') ?? 'local').slice(0, 8)}`;
}

export function flightMrIid(flight: string): number | null {
  const m = flight.match(/^CLR-(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------- package-registry stores

const BLACKBOX_PKG = 'clearance-blackbox';
const LEDGER_PKG = 'clearance-ledger';

/**
 * Loads a flight's black box. Chains only ever grow, so when both the package
 * registry copy and a job-artifact copy exist, the longer one is current
 * (artifacts from several upstream jobs can leave an older copy on disk).
 */
export async function loadBlackBox(flight: string): Promise<BlackBoxRecord[]> {
  const localAll = readJson<BlackBoxRecord[]>('.clearance-out/blackbox.json') ?? [];
  const local = localAll.length && localAll.every((r) => r && typeof r.hash === 'string') ? localAll : [];
  let remote: BlackBoxRecord[] = [];
  const g = gitlabPackages();
  if (g && projectId()) {
    try {
      const raw = await g.genericPackageFile(projectId(), BLACKBOX_PKG, flight, 'blackbox.json');
      remote = raw ? (JSON.parse(raw) as BlackBoxRecord[]) : [];
    } catch (e) {
      warn(`could not load black box: ${(e as Error).message}`);
    }
  }
  return remote.length >= local.length ? remote : local;
}

export async function recordBlackBox(
  flight: string,
  entry: Pick<BlackBoxRecord, 'stage' | 'actor' | 'kind' | 'summary' | 'data'>,
): Promise<BlackBoxRecord[]> {
  const chain = appendRecord(await loadBlackBox(flight), entry);
  writeOut('.clearance-out/blackbox.json', JSON.stringify(chain, null, 2));
  const g = gitlabPackages();
  if (g && projectId()) {
    try {
      await g.putGenericPackageFile(projectId(), BLACKBOX_PKG, flight, 'blackbox.json', JSON.stringify(chain));
    } catch (e) {
      warn(`could not persist black box: ${(e as Error).message}`);
    }
  }
  return chain;
}

export async function loadLedger(): Promise<LedgerEntry[]> {
  const g = gitlabPackages();
  if (!g || !projectId()) return readJson<LedgerEntry[]>('.clearance-out/ledger.json') ?? [];
  try {
    const raw = await g.genericPackageFile(projectId(), LEDGER_PKG, 'v1', 'ledger.json');
    return raw ? (JSON.parse(raw) as LedgerEntry[]) : [];
  } catch (e) {
    if (!(e instanceof GitLabError && e.status === 404)) warn(`could not load trust ledger: ${(e as Error).message}`);
    return [];
  }
}

export async function appendLedger(entry: LedgerEntry): Promise<LedgerEntry[]> {
  const ledger = (await loadLedger()).filter((e) => e.flight !== entry.flight);
  ledger.push(entry);
  const trimmed = ledger.slice(-2000);
  writeOut('.clearance-out/ledger.json', JSON.stringify(trimmed, null, 2));
  const g = gitlabPackages();
  if (g && projectId()) {
    try {
      await g.putGenericPackageFile(projectId(), LEDGER_PKG, 'v1', 'ledger.json', JSON.stringify(trimmed));
    } catch (e) {
      warn(`could not persist trust ledger: ${(e as Error).message}`);
    }
  }
  return trimmed;
}

// ------------------------------------------------------------- tower

export async function emit(events: FlightEvent[]): Promise<void> {
  const url = env.CLEARANCE_TOWER_URL;
  if (!url) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CLEARANCE_TOWER_TOKEN ?? ''}` },
      body: JSON.stringify(events.map((e) => ({ source: 'ci', ...e }))),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) warn(`Tower rejected ${events.length} event(s): ${res.status}`);
  } catch (e) {
    warn(`Tower unreachable: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------- MR notes

export const NOTE_MARKER = '<!-- clearance:report -->';

/** Creates or updates Clearance's single report note on a merge request. */
export async function upsertMrNote(iid: number, body: string): Promise<void> {
  const g = gitlabWriter();
  if (!g) {
    warn('CLEARANCE_TOKEN is not set; skipping the merge request note');
    return;
  }
  const full = `${NOTE_MARKER}\n${body}`;
  try {
    const notes = await g.get<{ id: number; body: string }[]>(`/projects/${encodeURIComponent(projectId())}/merge_requests/${iid}/notes?per_page=100&sort=desc`);
    const existing = notes.find((n) => n.body.startsWith(NOTE_MARKER));
    if (existing) {
      await g.request('PUT', `/projects/${encodeURIComponent(projectId())}/merge_requests/${iid}/notes/${existing.id}`, { body: full });
    } else {
      await g.createNote(projectId(), 'merge_requests', iid, full);
    }
  } catch (e) {
    warn(`could not write the merge request note: ${(e as Error).message}`);
  }
}

/** Writes a dotenv artifact so later jobs can read decisions as variables. */
export function writeDotenv(rel: string, vars: Record<string, string | number | boolean>) {
  writeOut(rel, Object.entries(vars).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n');
}
