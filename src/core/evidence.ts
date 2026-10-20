// The black box: a tamper-evident record of every decision on a flight.
//
// Each record's hash covers its content and the previous record's hash, so
// editing or deleting any entry breaks every hash after it. When a signing key
// is configured (CLEARANCE_SIGNING_KEY, a masked CI variable) the head of the
// chain is also HMAC-signed, so an auditor can tell the pack came from the
// pipeline and not from someone with write access to the release page.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface BlackBoxRecord {
  seq: number;
  at: string;
  stage: string;
  actor: string; // who acted: an agent service account, a CI job, or a human
  kind: string; // e.g. "assessment", "clearance", "canary", "rollback"
  summary: string;
  data: unknown;
  prev: string;
  hash: string;
}

export interface EvidencePack {
  schema: 'clearance.evidence/v1';
  flight: string;
  project: string;
  commit: string;
  createdAt: string;
  records: BlackBoxRecord[];
  head: string;
  signature: string | null;
  controls: { id: string; framework: string; title: string; satisfiedBy: string[] }[];
}

/** Canonical JSON: sorted keys, so hashes don't depend on property order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as object).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export const GENESIS = '0'.repeat(64);

export function hashRecord(r: Omit<BlackBoxRecord, 'hash'>): string {
  return createHash('sha256').update(canonical({ ...r })).digest('hex');
}

export function appendRecord(
  chain: BlackBoxRecord[],
  entry: Pick<BlackBoxRecord, 'stage' | 'actor' | 'kind' | 'summary' | 'data'> & { at?: string },
): BlackBoxRecord[] {
  const prev = chain.length ? chain[chain.length - 1].hash : GENESIS;
  const base = { seq: chain.length, at: entry.at ?? new Date().toISOString(), stage: entry.stage, actor: entry.actor, kind: entry.kind, summary: entry.summary, data: entry.data ?? null, prev };
  return [...chain, { ...base, hash: hashRecord(base) }];
}

export function verifyChain(chain: BlackBoxRecord[]): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const { hash, ...rest } = chain[i];
    if (rest.prev !== prev || rest.seq !== i || hashRecord(rest) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, brokenAt: null };
}

export function sign(head: string, key: string | undefined | null): string | null {
  if (!key) return null;
  return createHmac('sha256', key).update(head).digest('hex');
}

export function verifySignature(head: string, signature: string, key: string): boolean {
  const expected = Buffer.from(sign(head, key)!, 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Maps black-box record kinds to the change-management controls they evidence. */
export const CONTROL_MAP = [
  { id: 'CC8.1', framework: 'SOC 2', title: 'Changes are authorised, tested, approved and implemented', kinds: ['assessment', 'clearance', 'verification', 'approval', 'deployment'] },
  { id: 'CC7.2', framework: 'SOC 2', title: 'System components are monitored for anomalies', kinds: ['canary', 'rollback', 'slo'] },
  { id: 'CC7.4', framework: 'SOC 2', title: 'Security incidents are responded to', kinds: ['rollback', 'incident', 'debrief'] },
  { id: 'A.8.32', framework: 'ISO 27001:2022', title: 'Change management', kinds: ['assessment', 'clearance', 'approval', 'release'] },
  { id: 'A.8.28', framework: 'ISO 27001:2022', title: 'Secure coding', kinds: ['security', 'review'] },
  { id: 'A.8.29', framework: 'ISO 27001:2022', title: 'Security testing in development and acceptance', kinds: ['security', 'verification'] },
  { id: 'PS.3.2', framework: 'NIST SSDF', title: 'Collect and maintain provenance data for each release', kinds: ['package', 'sbom', 'release'] },
];

export function buildEvidencePack(args: {
  flight: string;
  project: string;
  commit: string;
  records: BlackBoxRecord[];
  signingKey?: string | null;
  now?: Date;
}): EvidencePack {
  const head = args.records.length ? args.records[args.records.length - 1].hash : GENESIS;
  const kinds = new Set(args.records.map((r) => r.kind));
  return {
    schema: 'clearance.evidence/v1',
    flight: args.flight,
    project: args.project,
    commit: args.commit,
    createdAt: (args.now ?? new Date()).toISOString(),
    records: args.records,
    head,
    signature: sign(head, args.signingKey),
    controls: CONTROL_MAP.map((c) => ({
      id: c.id,
      framework: c.framework,
      title: c.title,
      satisfiedBy: c.kinds.filter((k) => kinds.has(k)),
    })).filter((c) => c.satisfiedBy.length > 0),
  };
}
