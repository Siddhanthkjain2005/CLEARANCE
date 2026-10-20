// Flight events: the single vocabulary shared by CI jobs, the GitLab webhook
// ingester, the simulator and the console. The Tower is an event-sourced
// projection of these, so live and simulated airspace render identically.

import type { CanaryReport } from './canary.ts';
import type { SciReport } from './sci.ts';
import type { AuthorKind, ClearanceDecision, ClearanceLevel, RiskAssessment, Stage } from './types.ts';

interface Base {
  flight: string; // "CLR-<mr iid>" or "INT-<issue iid>" before an MR exists
  at: string;
  source?: 'ci' | 'webhook' | 'sync' | 'simulator' | 'agent';
}

export type FlightEvent =
  | (Base & { type: 'flight.opened'; title: string; pilot: string; pilotKind: AuthorKind; url?: string; intent?: string })
  | (Base & { type: 'flight.linked'; from: string }) // intent INT-n became MR CLR-m
  | (Base & { type: 'stage.started' | 'stage.passed' | 'stage.failed' | 'stage.skipped'; stage: Stage; job?: string; url?: string; detail?: string })
  | (Base & { type: 'assessment'; risk: RiskAssessment })
  | (Base & { type: 'clearance'; decision: ClearanceDecision })
  | (Base & { type: 'canary.step'; percent: number; revision?: string })
  | (Base & { type: 'canary.verdict'; report: CanaryReport })
  | (Base & { type: 'flight.landed' | 'flight.go-around' | 'flight.held' | 'flight.diverted'; detail: string; level?: ClearanceLevel })
  | (Base & { type: 'agent.action'; agent: string; action: string; detail: string; url?: string })
  | (Base & { type: 'sci'; report: Pick<SciReport, 'sci' | 'energyKwh' | 'operationalG' | 'embodiedG' | 'avoidedG' | 'avoidedPct' | 'baselineG' | 'region' | 'intensity'> })
  | (Base & { type: 'evidence'; head: string; signed: boolean; records: number; controls: string[]; url?: string });

export type FlightEventType = FlightEvent['type'];

/** Omit that distributes over the union, so each event keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before it is stamped with a time and source. */
export type FlightEventDraft = DistributiveOmit<FlightEvent, 'at' | 'source'>;

export const EVENT_TYPES: FlightEventType[] = [
  'flight.opened', 'flight.linked', 'stage.started', 'stage.passed', 'stage.failed', 'stage.skipped',
  'assessment', 'clearance', 'canary.step', 'canary.verdict', 'flight.landed', 'flight.go-around',
  'flight.held', 'flight.diverted', 'agent.action', 'sci', 'evidence',
];

export function isFlightEvent(v: unknown): v is FlightEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.type === 'string' && EVENT_TYPES.includes(e.type as FlightEventType) && typeof e.flight === 'string' && e.flight.length <= 64 && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at));
}

/** Maps a CI job's stage name to the lifecycle stage it advances. */
export const CI_STAGE_TO_LIFECYCLE: Record<string, Stage> = {
  plan: 'plan',
  assess: 'plan',
  create: 'create',
  verify: 'verify',
  test: 'secure', // GitLab's security templates default to a stage named test
  package: 'package',
  build: 'package',
  secure: 'secure',
  clearance: 'secure',
  release: 'release',
  configure: 'configure',
  deploy: 'configure',
  monitor: 'monitor',
  canary: 'monitor',
  govern: 'govern',
  '.post': 'govern',
};

export function flightIdForMr(iid: number | string): string {
  return `CLR-${iid}`;
}
export function flightIdForIssue(iid: number | string): string {
  return `INT-${iid}`;
}
