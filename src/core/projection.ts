// The read model: folds flight events into the views the console renders.
// Pure and deterministic, so the Tower, tests and the simulator all agree.

import type { CanaryReport } from './canary.ts';
import type { FlightEvent } from './events.ts';
import type { AuthorKind, ClearanceDecision, ClearanceLevel, RiskAssessment, Stage } from './types.ts';
import { STAGES } from './types.ts';

export type StageStatus = 'pending' | 'active' | 'passed' | 'failed' | 'skipped';

export type FlightPhase = 'airborne' | 'holding' | 'landed' | 'go-around' | 'diverted';

export interface StageView {
  status: StageStatus;
  at?: string;
  job?: string;
  url?: string;
  detail?: string;
}

export interface AgentActionView {
  agent: string;
  action: string;
  detail: string;
  at: string;
  url?: string;
}

export interface FlightView {
  id: string;
  title: string;
  pilot: string;
  pilotKind: AuthorKind;
  url?: string;
  intent?: string;
  openedAt: string;
  updatedAt: string;
  phase: FlightPhase;
  stages: Record<Stage, StageView>;
  current: Stage; // the stage the flight is in or last reached
  progress: number; // 0..9 along the approach, fractional while a stage is active
  risk: RiskAssessment | null;
  decision: ClearanceDecision | null;
  level: ClearanceLevel | null;
  canary: { percent: number; revision?: string; report?: CanaryReport } | null;
  outcome: { kind: 'landed' | 'go-around' | 'held' | 'diverted'; detail: string; at: string } | null;
  sci: { sci: number; avoidedG: number; avoidedPct: number; energyKwh: number; region: string } | null;
  evidence: { head: string; signed: boolean; records: number; controls: string[]; url?: string } | null;
  actions: AgentActionView[];
  simulated: boolean;
}

export function emptyStages(): Record<Stage, StageView> {
  return Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' as StageStatus }])) as Record<Stage, StageView>;
}

export function newFlight(id: string, at: string): FlightView {
  return {
    id,
    title: id,
    pilot: 'unknown',
    pilotKind: 'human',
    openedAt: at,
    updatedAt: at,
    phase: 'airborne',
    stages: emptyStages(),
    current: 'plan',
    progress: 0,
    risk: null,
    decision: null,
    level: null,
    canary: null,
    outcome: null,
    sci: null,
    evidence: null,
    actions: [],
    simulated: false,
  };
}

function recompute(f: FlightView): void {
  let last = -1;
  let active = -1;
  STAGES.forEach((s, i) => {
    const st = f.stages[s].status;
    if (st === 'passed' || st === 'skipped' || st === 'failed') last = i;
    if (st === 'active') active = i;
  });
  const idx = Math.max(last, active);
  f.current = STAGES[Math.max(0, idx)];
  f.progress = active > last ? active + 0.5 : last + 1;
  if (f.outcome?.kind === 'landed') f.progress = STAGES.length;
}

/** Applies one event to a flight. Returns true when the view changed. */
export function applyEvent(flights: Map<string, FlightView>, e: FlightEvent): FlightView {
  let f = flights.get(e.flight);
  if (!f) {
    f = newFlight(e.flight, e.at);
    flights.set(e.flight, f);
  }
  if (e.source === 'simulator') f.simulated = true;
  if (Date.parse(e.at) > Date.parse(f.updatedAt)) f.updatedAt = e.at;

  switch (e.type) {
    case 'flight.opened':
      f.title = e.title;
      f.pilot = e.pilot;
      f.pilotKind = e.pilotKind;
      if (e.url) f.url = e.url;
      if (e.intent) f.intent = e.intent;
      if (Date.parse(e.at) < Date.parse(f.openedAt)) f.openedAt = e.at;
      break;
    case 'flight.linked': {
      const from = flights.get(e.from);
      if (from) {
        for (const s of STAGES) if (f.stages[s].status === 'pending' && from.stages[s].status !== 'pending') f.stages[s] = from.stages[s];
        f.actions = [...from.actions, ...f.actions].slice(-40);
        f.intent = e.from;
        f.openedAt = from.openedAt;
        flights.delete(e.from);
      }
      break;
    }
    case 'stage.started':
      if (f.stages[e.stage].status === 'pending' || f.stages[e.stage].status === 'failed') {
        f.stages[e.stage] = { status: 'active', at: e.at, job: e.job, url: e.url, detail: e.detail };
      }
      break;
    case 'stage.passed':
    case 'stage.failed':
    case 'stage.skipped': {
      const status: StageStatus = e.type === 'stage.passed' ? 'passed' : e.type === 'stage.failed' ? 'failed' : 'skipped';
      // A later pass overrides a failure (retries); a failure never overrides a pass of a newer run.
      f.stages[e.stage] = { status, at: e.at, job: e.job, url: e.url, detail: e.detail };
      // Reaching a stage implies the ones before it were passed.
      const idx = STAGES.indexOf(e.stage);
      for (let i = 0; i < idx; i++) {
        const prev = f.stages[STAGES[i]];
        if (prev.status === 'pending' || prev.status === 'active') f.stages[STAGES[i]] = { ...prev, status: 'passed', at: prev.at ?? e.at };
      }
      if (status === 'failed' && f.phase === 'airborne' && e.stage !== 'monitor') f.phase = 'holding';
      if (status === 'passed' && f.phase === 'holding' && f.level !== 'hold') f.phase = 'airborne';
      break;
    }
    case 'assessment':
      f.risk = e.risk;
      break;
    case 'clearance':
      f.decision = e.decision;
      f.level = e.decision.level;
      if (e.decision.level === 'hold') f.phase = 'holding';
      else if (f.phase === 'holding') f.phase = 'airborne';
      break;
    case 'canary.step':
      f.canary = { ...(f.canary ?? {}), percent: e.percent, revision: e.revision };
      if (f.stages.monitor.status === 'pending') f.stages.monitor = { status: 'active', at: e.at, detail: `${e.percent}% traffic` };
      else if (f.stages.monitor.status === 'active') f.stages.monitor.detail = `${e.percent}% traffic`;
      break;
    case 'canary.verdict':
      f.canary = { percent: e.report.verdict === 'promote' ? 100 : 0, ...(f.canary?.revision ? { revision: f.canary.revision } : {}), report: e.report };
      break;
    case 'flight.landed':
      f.phase = 'landed';
      f.outcome = { kind: 'landed', detail: e.detail, at: e.at };
      for (const s of STAGES) {
        if (s === 'govern') continue;
        const st = f.stages[s];
        if (st.status === 'pending' || st.status === 'active') f.stages[s] = { ...st, status: 'passed', at: st.at ?? e.at };
      }
      break;
    case 'flight.go-around':
      f.phase = 'go-around';
      f.outcome = { kind: 'go-around', detail: e.detail, at: e.at };
      f.stages.monitor = { ...f.stages.monitor, status: 'failed', at: e.at, detail: 'rolled back' };
      break;
    case 'flight.held':
      f.phase = 'holding';
      f.outcome = { kind: 'held', detail: e.detail, at: e.at };
      break;
    case 'flight.diverted':
      f.phase = 'diverted';
      f.outcome = { kind: 'diverted', detail: e.detail, at: e.at };
      break;
    case 'agent.action':
      f.actions = [...f.actions, { agent: e.agent, action: e.action, detail: e.detail, at: e.at, url: e.url }].slice(-40);
      break;
    case 'sci':
      f.sci = { sci: e.report.sci, avoidedG: e.report.avoidedG, avoidedPct: e.report.avoidedPct, energyKwh: e.report.energyKwh, region: e.report.region };
      break;
    case 'evidence':
      f.evidence = { head: e.head, signed: e.signed, records: e.records, controls: e.controls, url: e.url };
      if (f.stages.govern.status !== 'passed') f.stages.govern = { status: 'passed', at: e.at, detail: `${e.records} records` };
      break;
  }
  recompute(f);
  return f;
}

export function stageCoverage(flights: Iterable<FlightView>): Record<Stage, number> {
  const out = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const f of flights) for (const s of STAGES) if (f.stages[s].status === 'passed') out[s]++;
  return out;
}
