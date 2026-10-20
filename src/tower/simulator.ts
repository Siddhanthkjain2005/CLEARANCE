// The simulator flies realistic traffic through the real decision engine.
//
// It is how the public console stays alive when no GitLab project is
// connected, and it is labelled as simulated everywhere it appears. Nothing is
// scripted about the decisions: each flight's risk, clearance, canary verdict
// and carbon footprint come from the same core modules the CI jobs use, fed
// with synthetic changes, synthetic canary traffic and a seeded trust ledger.

import { analyzeCanary, type RevisionSample } from '../core/canary.ts';
import { decide } from '../core/governor.ts';
import { assessRisk } from '../core/risk.ts';
import { avoidedJobs, plannedJobs } from '../core/pipeline.ts';
import { sciForFlight } from '../core/sci.ts';
import { lognormalSample, rng } from '../core/stats.ts';
import { scorePilot } from '../core/trust.ts';
import type { DistributiveOmit, FlightEvent, FlightEventDraft } from '../core/events.ts';
import type { Airspace, AuthorKind, ChangeSet, FileChange, LedgerEntry, SecurityFinding } from '../core/types.ts';
import type { Store } from './store.ts';

interface Scenario {
  weight: number;
  title: string;
  kind: AuthorKind;
  files: FileChange[];
  findings?: SecurityFinding[];
  fault?: 'errors' | 'latency';
}

const f = (path: string, additions: number, deletions: number, status: FileChange['status'] = 'modified'): FileChange => ({ path, additions, deletions, status });

const SCENARIOS: Scenario[] = [
  { weight: 5, kind: 'agent', title: 'Show bake countdown on flight strips', files: [f('src/web/ui/Strip.tsx', 42, 9), f('test/strip.test.ts', 31, 0, 'added')] },
  { weight: 4, kind: 'agent', title: 'Retry GitLab API calls on 429 with backoff', files: [f('src/core/gitlab.ts', 38, 6), f('test/gitlab.test.ts', 44, 0, 'added')] },
  { weight: 4, kind: 'agent', title: 'Document the canary drill for game days', files: [f('docs/drills.md', 64, 0, 'added'), f('README.md', 3, 1)] },
  { weight: 3, kind: 'agent', title: 'Cache trust scores between sync cycles', files: [f('src/tower/store.ts', 27, 8), f('test/store.test.ts', 22, 0)] },
  { weight: 3, kind: 'agent', title: 'Add p99 latency to the canary report', files: [f('src/core/canary.ts', 18, 4), f('test/canary.test.ts', 16, 2)] },
  { weight: 3, kind: 'human', title: 'Stream canary samples to the console', files: [f('src/tower/server.ts', 66, 12), f('src/web/ui/Canary.tsx', 120, 0, 'added'), f('test/smoke.ts', 14, 2)] },
  { weight: 2, kind: 'agent', title: 'Raise Cloud Run concurrency to 80', files: [f('infra/terraform/main.tf', 6, 2)] },
  { weight: 2, kind: 'human', title: 'Upgrade esbuild and rebuild the console', files: [f('package.json', 2, 2), f('package-lock.json', 140, 132)] },
  { weight: 2, kind: 'agent', title: 'Rework sector weights in the risk model', files: [f('src/core/risk.ts', 96, 41), f('src/core/governor.ts', 22, 9), f('test/risk.test.ts', 30, 6)] },
  { weight: 1, kind: 'agent', title: 'Tighten the autonomous risk ceiling to 0.30', files: [f('.clearance/policy.yml', 1, 1)] },
  { weight: 1, kind: 'agent', title: 'Add a diagnostics token to the probe endpoint', files: [f('src/tower/probe.ts', 12, 1)], findings: [{ severity: 'high', scanner: 'secret_detection', name: 'Generic API key' }] },
  { weight: 2, kind: 'agent', title: 'Compress /api/state responses', files: [f('src/tower/server.ts', 24, 3), f('test/smoke.ts', 8, 0)], fault: 'latency' },
  { weight: 1, kind: 'human', title: 'Batch webhook ingestion', files: [f('src/tower/sync.ts', 58, 20), f('test/sync.test.ts', 26, 0)], fault: 'errors' },
];

const AGENTS = ['ai-clearance-dispatch', 'ai-clearance-dispatch', 'ai-clearance-dispatch', 'ai-clearance-medic'];
const HUMANS = ['maya.chen', 'dev.okafor'];
const REVIEWER = 'maya.chen';

type Step = { after: number; events: FlightEventDraft[]; ledger?: Omit<LedgerEntry, 'at'> };

export class Simulator {
  private store: Store;
  private airspace: Airspace;
  private rand: () => number;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private nextIid = 140;
  private nextIntent = 310;
  private revision = 86;
  private version = [1, 13, 4];
  private speed: number;
  budget = 0.81;
  running = false;

  constructor(store: Store, airspace: Airspace, opts: { seed?: number; speed?: number } = {}) {
    this.store = store;
    this.airspace = airspace;
    this.rand = rng(opts.seed ?? Date.now());
    this.speed = opts.speed ?? 1;
  }

  /** Seeds 30 days of history so trust scores start from a believable place. */
  seedLedger(now = Date.now()): LedgerEntry[] {
    const r = rng(7);
    const entries: LedgerEntry[] = [];
    const add = (pilot: string, kind: AuthorKind, n: number, goArounds: number[]) => {
      for (let i = 0; i < n; i++) {
        entries.push({
          flight: `CLR-${60 + entries.length}`, pilot, pilotKind: kind, risk: 0.08 + r() * 0.3,
          level: i < 9 ? 'supervised' : 'autonomous', outcome: goArounds.includes(i) ? 'go-around' : 'landed',
          at: new Date(now - (n - i) * (26 / n) * 86_400_000 - r() * 3_600_000).toISOString(),
        });
      }
    };
    add('ai-clearance-dispatch', 'agent', 24, [11]);
    add('ai-clearance-medic', 'agent', 5, []);
    add('maya.chen', 'human', 28, [6, 19]);
    add('dev.okafor', 'human', 9, [4]);
    return entries;
  }

  start(prefill = 5) {
    if (this.running) return;
    this.running = true;
    this.store.setLedger(this.seedLedger(), true);
    for (let i = 0; i < prefill; i++) this.launch(undefined, 6_000 + i * 9_000 * (0.6 + this.rand() * 0.8));
    this.loop();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms / this.speed);
    this.timers.add(t);
  }

  private loop() {
    const airborne = [...this.store.flights.values()].filter((x) => x.simulated && (x.phase === 'airborne' || x.phase === 'holding')).length;
    if (airborne < 7) this.launch();
    this.schedule(9_000 + this.rand() * 9_000, () => this.loop());
  }

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rand() * xs.length)];
  }

  private pickScenario(): Scenario {
    const total = SCENARIOS.reduce((a, s) => a + s.weight, 0);
    let x = this.rand() * total;
    for (const s of SCENARIOS) if ((x -= s.weight) <= 0) return s;
    return SCENARIOS[0];
  }

  /** Builds a flight's full script, then plays it. `offsetMs` fast-forwards. */
  launch(forced?: Partial<Scenario> & { title: string }, offsetMs = 0) {
    const sc: Scenario = { ...this.pickScenario(), ...(forced ?? {}) };
    const pilot = sc.kind === 'agent' ? (/^fix/i.test(sc.title) ? 'ai-clearance-medic' : this.pick(AGENTS)) : this.pick(HUMANS);
    const iid = this.nextIid++;
    const id = `CLR-${iid}`;
    const intent = sc.kind === 'agent' ? `INT-${this.nextIntent++}` : null;
    const jitter = (ms: number) => ms * (0.75 + this.rand() * 0.5);
    const steps: Step[] = [];
    const ev = (e: DistributiveOmit<FlightEvent, 'at' | 'source' | 'flight'> & { flight?: string }) => ({ flight: id, ...e }) as FlightEventDraft;

    const change: ChangeSet = { title: sc.title, author: pilot, authorKind: sc.kind, files: sc.files, findings: sc.findings ?? [], coverage: 0.7 + this.rand() * 0.25 };
    const risk = assessRisk(change, this.airspace);
    const ledger = this.store.ledgerEntries().filter((e) => e.pilot === pilot);
    const trust = scorePilot(pilot, ledger, this.store.policy);
    const decision = decide({ change, risk, trust, errorBudget: this.budget, policy: this.store.policy });
    const preliminary = decide({ change: { ...change, findings: [] }, risk: assessRisk({ ...change, findings: [] }, this.airspace), trust, errorBudget: this.budget, policy: this.store.policy });
    const ctx = { impact: { mode: 'impacted' as const, tests: sc.files.filter((x) => x.path.startsWith('test/')).map((x) => x.path), reason: '' }, webChanged: sc.files.some((x) => x.path.startsWith('src/web')) };
    const planned = plannedJobs(decision.tier, ctx);
    const avoided = avoidedJobs(decision.tier, ctx);

    // --- plan: intent → flight plan (agent flights start as an intent issue)
    if (intent) {
      steps.push({ after: 0, events: [
        { type: 'flight.opened', flight: intent, title: sc.title, pilot: REVIEWER, pilotKind: 'human', intent: intent },
        { type: 'stage.started', flight: intent, stage: 'plan' },
      ] });
      steps.push({ after: jitter(3_000), events: [
        { type: 'agent.action', flight: intent, agent: 'ai-clearance-dispatch', action: 'drafted a flight plan', detail: `Acceptance criteria, test plan and ${sc.files.length} affected file(s)` },
      ] });
    }
    steps.push({ after: intent ? jitter(3_500) : 0, events: [
      { type: 'flight.opened', flight: id, title: sc.title, pilot, pilotKind: sc.kind, ...(intent ? { intent } : {}) },
      ...(intent ? [{ type: 'flight.linked' as const, flight: id, from: intent }] : []),
      { type: 'stage.passed', flight: id, stage: 'plan', job: 'clearance:assess', detail: `risk ${(risk.score * 100).toFixed(0)}%` },
      ev({ type: 'assessment', risk: assessRisk({ ...change, findings: [] }, this.airspace) }),
      ev({ type: 'clearance', decision: preliminary }),
      ev({ type: 'stage.started', stage: 'create' }),
    ] });
    steps.push({ after: jitter(3_000), events: [
      ...(sc.kind === 'agent' ? [ev({ type: 'agent.action', agent: pilot, action: `opened !${iid}`, detail: `${sc.files.length} file(s), ${risk.churn} lines, tests included` })] : []),
      ev({ type: 'stage.passed', stage: 'create', detail: `${risk.files} files, ${risk.churn} lines` }),
      ev({ type: 'stage.started', stage: 'verify', job: `${decision.tier} child pipeline` }),
    ] });
    steps.push({ after: jitter(2_500 + planned.length * 900), events: [
      ...(sc.kind === 'agent' ? [ev({ type: 'agent.action', agent: 'ai-clearance-inspector', action: 'reviewed the diff', detail: risk.score > 0.45 ? 'CHANGES then CLEARED after one rework' : 'CLEARED' })] : []),
      ev({ type: 'stage.passed', stage: 'verify', detail: `${decision.tier}: ${planned.length} job(s), ${avoided.length} avoided` }),
      ev({ type: 'stage.started', stage: 'package' }),
    ] });
    steps.push({ after: jitter(2_500), events: [
      ev({ type: 'stage.passed', stage: 'package', detail: `image sha256:${Math.floor(this.rand() * 0xffffffff).toString(16).padStart(8, '0')}` }),
      ev({ type: 'stage.started', stage: 'secure' }),
    ] });

    const findings = sc.findings ?? [];
    steps.push({ after: jitter(2_800), events: [
      ev({ type: findings.length ? 'stage.failed' : 'stage.passed', stage: 'secure', detail: findings.length ? `${findings.length} finding(s): ${findings[0].name}` : 'SAST, secrets, dependencies, container: clean' }),
      ev({ type: 'assessment', risk }),
      ev({ type: 'clearance', decision }),
      ...(decision.level === 'hold' ? [ev({ type: 'flight.held', detail: decision.reasons[0] ?? 'hold', level: 'hold' })] : []),
    ] });

    if (decision.level === 'hold') {
      // Holds wait for a human. In the simulation a reviewer eventually closes the MR.
      steps.push({ after: jitter(26_000), events: [
        ev({ type: 'agent.action', agent: REVIEWER, action: 'closed the merge request', detail: 'Hold upheld by a code owner' }),
        ev({ type: 'flight.diverted', detail: 'Closed after review; the hold was correct' }),
      ], ledger: { flight: id, pilot, pilotKind: sc.kind, risk: risk.score, level: 'hold', outcome: 'diverted' } });
      return this.play(steps, offsetMs);
    }

    if (decision.level !== 'autonomous' || risk.runtimeChange === false) {
      if (decision.level !== 'autonomous') {
        steps.push({ after: jitter(8_000), events: [
          ev({ type: 'agent.action', agent: REVIEWER, action: `approved !${iid}`, detail: `${decision.level} clearance: outcome approved` }),
        ] });
      }
    }

    if (!risk.runtimeChange) {
      steps.push({ after: jitter(2_000), events: [
        ev({ type: 'stage.skipped', stage: 'release' }),
        ev({ type: 'stage.skipped', stage: 'configure' }),
        ev({ type: 'stage.skipped', stage: 'monitor', detail: 'taxi: nothing shipped changed' }),
      ] });
      this.governSteps(steps, id, planned.map((j) => ({ name: j.name, durationSec: j.typicalSec })), avoided, jitter);
      steps.push({ after: jitter(1_500), events: [ev({ type: 'flight.landed', detail: 'taxi', level: decision.level })], ledger: { flight: id, pilot, pilotKind: sc.kind, risk: risk.score, level: decision.level, outcome: 'landed' } });
      return this.play(steps, offsetMs);
    }

    const version = this.bump(sc.title);
    const rev = `tower-${String(++this.revision).padStart(5, '0')}`;
    steps.push({ after: jitter(2_200), events: [
      ev({ type: 'stage.passed', stage: 'release', detail: version }),
      ev({ type: 'stage.started', stage: 'configure' }),
    ] });
    steps.push({ after: jitter(2_600), events: [
      ev({ type: 'stage.passed', stage: 'configure', detail: `${rev} deployed with no traffic` }),
      ev({ type: 'stage.started', stage: 'monitor' }),
    ] });

    const plan = decision.canary!;
    let wentAround = false;
    for (const pct of plan.steps.filter((s) => s < 100)) {
      steps.push({ after: jitter(1_200), events: [ev({ type: 'canary.step', percent: pct, revision: rev })] });
      const report = analyzeCanary(this.samples('stable', 900, null), this.samples(rev, Math.max(260, Math.round(900 * (pct / (100 - pct)))), sc.fault ?? null), this.store.policy);
      if (report.verdict === 'rollback') {
        steps.push({ after: jitter(4_000), events: [
          ev({ type: 'canary.verdict', report }),
          ev({ type: 'flight.go-around', detail: (report.checks.find((c) => !c.passed && c.id !== 'traffic') ?? report.checks.find((c) => !c.passed))?.summary ?? 'canary failed', level: decision.level }),
        ], ledger: { flight: id, pilot, pilotKind: sc.kind, risk: risk.score, level: decision.level, outcome: 'go-around' } });
        steps.push({ after: jitter(3_500), events: [
          ev({ type: 'agent.action', agent: 'ai-clearance-debrief', action: 'wrote the postmortem', detail: `Incident opened; ${report.checks.filter((c) => !c.passed).length} failed check(s) analysed` }),
        ] });
        this.governSteps(steps, id, planned.map((j) => ({ name: j.name, durationSec: j.typicalSec })), avoided, jitter);
        wentAround = true;
        break;
      }
      steps.push({ after: jitter(3_600), events: [] });
    }
    if (wentAround) {
      this.play(steps, offsetMs);
      // The medic agent follows up with a fix flight.
      this.schedule(jitter(14_000) + Math.max(0, 40_000 - offsetMs), () =>
        this.launch({ title: `fix: ${sc.title.charAt(0).toLowerCase()}${sc.title.slice(1)} without the regression`, kind: 'agent', files: sc.files.map((x) => ({ ...x, additions: Math.ceil(x.additions / 3), deletions: Math.ceil(x.deletions / 2) })), fault: undefined, weight: 0 }),
      );
      return;
    }
    const final = analyzeCanary(this.samples('stable', 900, null), this.samples(rev, 900, null), this.store.policy);
    steps.push({ after: jitter(1_500), events: [ev({ type: 'canary.verdict', report: final }), ev({ type: 'stage.passed', stage: 'monitor', detail: 'promoted to 100%' })] });
    this.governSteps(steps, id, planned.map((j) => ({ name: j.name, durationSec: j.typicalSec })), avoided, jitter);
    steps.push({ after: jitter(1_200), events: [ev({ type: 'flight.landed', detail: 'promote', level: decision.level })], ledger: { flight: id, pilot, pilotKind: sc.kind, risk: risk.score, level: decision.level, outcome: 'landed' } });
    this.play(steps, offsetMs);
  }

  private governSteps(steps: Step[], id: string, ran: { name: string; durationSec: number }[], avoided: ReturnType<typeof avoidedJobs>, jitter: (n: number) => number) {
    const sci = sciForFlight(
      [...ran.map((j) => ({ ...j, durationSec: j.durationSec * (0.8 + this.rand() * 0.4) })), { name: 'clearance:assess', durationSec: 18 }, { name: 'semgrep-sast', durationSec: 75 }, { name: 'secret_detection', durationSec: 30 }, { name: 'build:image', durationSec: 95 }],
      avoided,
      'us-east1',
    );
    steps.push({ after: jitter(1_800), events: [
      { type: 'stage.started', flight: id, stage: 'govern' },
      { type: 'sci', flight: id, report: sci },
    ] });
    steps.push({ after: jitter(1_600), events: [
      { type: 'evidence', flight: id, head: Array.from({ length: 64 }, () => Math.floor(this.rand() * 16).toString(16)).join(''), signed: true, records: 9 + Math.floor(this.rand() * 4), controls: ['SOC 2 CC8.1', 'SOC 2 CC7.2', 'ISO 27001:2022 A.8.32', 'NIST SSDF PS.3.2'] },
    ] });
  }

  private samples(revision: string, n: number, fault: 'errors' | 'latency' | null): RevisionSample {
    let errors = 0;
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.rand() < (fault === 'errors' ? 0.07 : 0.0025)) errors++;
      lat.push(lognormalSample(this.rand, fault === 'latency' ? 41 * 2.4 : 41, 0.32));
    }
    return { revision, requests: n, errors, latenciesMs: lat };
  }

  private bump(title: string): string {
    if (/^feat|add|show|stream|rework/i.test(title)) this.version = [this.version[0], this.version[1] + 1, 0];
    else this.version = [this.version[0], this.version[1], this.version[2] + 1];
    return `v${this.version.join('.')}`;
  }

  private play(steps: Step[], offsetMs: number) {
    const base = Date.now() - offsetMs;
    let t = 0;
    for (const s of steps) {
      t += s.after;
      const at = new Date(base + t).toISOString();
      const fire = () => {
        this.store.ingest(s.events.map((e) => ({ ...e, at, source: 'simulator' }) as FlightEvent));
        if (s.ledger) {
          this.store.addLedgerEntry({ ...s.ledger, at }, true);
          if (s.ledger.outcome === 'go-around') this.budget = Math.max(0.2, this.budget - 0.035);
          else if (s.ledger.outcome === 'landed') this.budget = Math.min(0.97, this.budget + 0.004);
        }
      };
      if (t <= offsetMs) fire();
      else this.schedule(t - offsetMs, fire);
    }
  }
}
