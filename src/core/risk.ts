// The risk model: how likely is this change to hurt production?
//
// Each signal estimates, on its own, the probability that the change causes an
// incident. Signals are combined with a noisy-OR, which treats them as
// independent causes: risk = 1 - Π(1 - p_i). That keeps the score in [0, 1],
// makes every contribution explainable, and means no single weak signal can
// dominate while several moderate ones still add up.

import { matchAny } from './glob.ts';
import type {
  Airspace,
  ChangeSet,
  FileChange,
  RiskAssessment,
  RiskBand,
  RiskSignal,
  SectorHit,
} from './types.ts';

const TEST_PATTERNS = ['test/**', 'tests/**', '**/__tests__/**', '*.test.*', '*.spec.*'];

export function isTestFile(path: string): boolean {
  return matchAny(path, TEST_PATTERNS);
}

export function classify(path: string, airspace: Airspace) {
  for (const s of airspace.sectors) {
    if (matchAny(path, s.paths)) {
      return { sector: s.name, criticality: s.criticality, protected: !!s.protected, runtime: s.runtime !== false };
    }
  }
  return { sector: 'unmapped', criticality: airspace.defaultCriticality, protected: false, runtime: true };
}

export function bandFor(score: number): RiskBand {
  if (score < 0.1) return 'minimal';
  if (score < 0.25) return 'low';
  if (score < 0.45) return 'elevated';
  if (score < 0.7) return 'high';
  return 'severe';
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function noisyOr(probabilities: number[]): number {
  return 1 - probabilities.reduce((acc, p) => acc * (1 - Math.min(0.999, Math.max(0, p))), 1);
}

const SEVERITY_P: Record<string, number> = { critical: 0.6, high: 0.22, medium: 0.05, low: 0.01, info: 0, unknown: 0.03 };

export function assessRisk(change: ChangeSet, airspace: Airspace): RiskAssessment {
  const files = change.files.filter((f) => f.path);
  const hits = new Map<string, SectorHit>();
  let churn = 0;
  let srcChurn = 0;
  let testChurn = 0;

  for (const f of files) {
    const c = classify(f.path, airspace);
    const lines = f.additions + f.deletions;
    churn += lines;
    if (isTestFile(f.path)) testChurn += lines;
    else if (c.runtime) srcChurn += lines;
    const h = hits.get(c.sector) ?? { sector: c.sector, criticality: c.criticality, files: 0, churn: 0, protected: c.protected, runtime: c.runtime };
    h.files += 1;
    h.churn += lines;
    hits.set(c.sector, h);
  }

  const sectors = [...hits.values()].sort((a, b) => b.criticality - a.criticality);
  const runtimeSectors = sectors.filter((s) => s.runtime);
  const runtimeChange = runtimeSectors.length > 0;
  const maxCrit = sectors.reduce((m, s) => Math.max(m, s.criticality), 0);
  const maxRuntimeCrit = runtimeSectors.reduce((m, s) => Math.max(m, s.criticality), 0);
  const signals: RiskSignal[] = [];

  // 1. Where the change lands. The most critical sector sets the floor.
  // Even a one-line change to critical code carries most of the sector's risk;
  // larger changes approach the full weight.
  if (sectors.length > 0) {
    const top = sectors[0];
    const depth = 0.45 + 0.55 * (1 - Math.exp(-top.churn / 60));
    signals.push({
      id: 'sector',
      label: 'Sector criticality',
      probability: round(0.4 * Math.pow(maxCrit, 1.15) * depth),
      detail: `Touches ${top.sector} (criticality ${top.criticality.toFixed(2)}, ${top.churn} lines)`,
    });
  }

  // 2. How much changed. Saturates so huge diffs don't read as certain failure.
  if (churn > 0) {
    signals.push({
      id: 'size',
      label: 'Change size',
      probability: round(0.25 * (1 - Math.exp(-srcChurn / 400)) + 0.04 * (1 - Math.exp(-(churn - srcChurn) / 800))),
      detail: `${churn} lines across ${files.length} file${files.length === 1 ? '' : 's'} (${srcChurn} in shipped code)`,
    });
  }

  // 3. Blast radius: the number of distinct runtime sectors touched.
  const blastRadius = runtimeSectors.length;
  if (blastRadius > 1 || files.length > 8) {
    signals.push({
      id: 'spread',
      label: 'Blast radius',
      probability: round(Math.min(0.25, 0.06 * Math.max(0, blastRadius - 1)) + 0.08 * (1 - Math.exp(-files.length / 20))),
      detail: `${blastRadius} runtime sector${blastRadius === 1 ? '' : 's'}, ${files.length} files`,
    });
  }

  // 4. Shipped code without matching tests.
  if (srcChurn > 0) {
    const ratio = testChurn / srcChurn;
    const gap = Math.max(0, 1 - ratio / 0.5) * (1 - Math.exp(-srcChurn / 40));
    let p = 0.16 * maxRuntimeCrit * gap;
    let detail = testChurn === 0 ? 'No tests changed alongside shipped code' : `Test-to-code churn ratio ${ratio.toFixed(2)}`;
    if (typeof change.coverage === 'number') {
      const covGap = Math.max(0, 0.8 - change.coverage) / 0.8;
      p = Math.max(p * 0.6, 0.12 * covGap * maxRuntimeCrit + p * 0.4);
      detail += `, ${(change.coverage * 100).toFixed(0)}% line coverage`;
    }
    if (p > 0.001) signals.push({ id: 'test-gap', label: 'Test gap', probability: round(p), detail });
  }

  // 5. Dependency and build-manifest changes pull in code nobody reviewed.
  const manifests = files.filter((f) => matchAny(f.path, airspace.manifests));
  if (manifests.length > 0) {
    signals.push({
      id: 'dependencies',
      label: 'Dependency change',
      probability: round(Math.min(0.3, 0.09 * manifests.length)),
      detail: manifests.map((m) => m.path).join(', '),
    });
  }

  // 6. Changes that cannot simply be rolled back.
  const irreversible = files.filter((f) => matchAny(f.path, airspace.irreversible));
  if (irreversible.length > 0) {
    signals.push({
      id: 'irreversible',
      label: 'Irreversible change',
      probability: 0.3,
      detail: `${irreversible.length} file${irreversible.length === 1 ? '' : 's'} cannot be undone by a rollback`,
    });
  }

  // 7. Deleting files in critical sectors.
  const deletions = files.filter((f) => f.status === 'deleted' && classify(f.path, airspace).criticality >= 0.5);
  if (deletions.length > 0) {
    signals.push({
      id: 'deletions',
      label: 'Critical deletions',
      probability: round(Math.min(0.2, 0.05 * deletions.length)),
      detail: `${deletions.length} file${deletions.length === 1 ? '' : 's'} deleted in critical sectors`,
    });
  }

  // 8. Security findings from the scanners on this pipeline.
  const findings = change.findings ?? [];
  if (findings.length > 0) {
    const p = noisyOr(findings.map((f) => SEVERITY_P[f.severity] ?? 0.03));
    const bySev = findings.reduce<Record<string, number>>((acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc), {});
    signals.push({
      id: 'security',
      label: 'Security findings',
      probability: round(p),
      detail: Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', '),
    });
  }

  const score = round(noisyOr(signals.map((s) => s.probability)));
  return {
    score,
    band: bandFor(score),
    signals: signals.sort((a, b) => b.probability - a.probability),
    sectors,
    blastRadius,
    runtimeChange,
    churn,
    files: files.length,
  };
}

/** Parses `git diff --numstat` output into file changes. */
export function parseNumstat(out: string, statusOut = ''): FileChange[] {
  const status = new Map<string, FileChange['status']>();
  for (const line of statusOut.split('\n')) {
    const [s, ...rest] = line.trim().split(/\s+/);
    if (!s || rest.length === 0) continue;
    const path = rest[rest.length - 1];
    status.set(path, s.startsWith('A') ? 'added' : s.startsWith('D') ? 'deleted' : s.startsWith('R') ? 'renamed' : 'modified');
  }
  const files: FileChange[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    let path = m[3].trim();
    const rename = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/) ?? path.match(/^()(.*) => (.*)()$/);
    if (rename) path = `${rename[1]}${rename[3]}${rename[4]}`.replace(/\/\//g, '/');
    files.push({
      path,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      status: status.get(path) ?? 'modified',
    });
  }
  return files;
}
