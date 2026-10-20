// Shared domain vocabulary for Clearance.
//
// A *flight* is one change travelling from intent to production. Flights pass
// through the nine GitLab DevSecOps stages, which the console draws as gates on
// an approach path. The *governor* decides how much autonomy each flight gets.

export const STAGES = [
  'plan',
  'create',
  'verify',
  'package',
  'secure',
  'release',
  'configure',
  'monitor',
  'govern',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  plan: 'Plan',
  create: 'Create',
  verify: 'Verify',
  package: 'Package',
  secure: 'Secure',
  release: 'Release',
  configure: 'Configure',
  monitor: 'Monitor',
  govern: 'Govern',
};

/** How much a human is involved, from none (autonomous) to everything (hold). */
export type ClearanceLevel = 'autonomous' | 'supervised' | 'assisted' | 'hold';

export const LEVEL_ORDER: ClearanceLevel[] = ['autonomous', 'supervised', 'assisted', 'hold'];

export type RiskBand = 'minimal' | 'low' | 'elevated' | 'high' | 'severe';

export type AuthorKind = 'agent' | 'human';

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';

export interface SecurityFinding {
  severity: Severity;
  scanner: string;
  name: string;
  file?: string;
}

export interface ChangeSet {
  title: string;
  author: string;
  authorKind: AuthorKind;
  files: FileChange[];
  labels?: string[];
  findings?: SecurityFinding[];
  /** Line coverage of the changed code, 0..1, when a coverage report exists. */
  coverage?: number | null;
}

export interface Sector {
  name: string;
  paths: string[];
  criticality: number; // 0..1, how much damage a bad change here can do
  protected?: boolean; // agents may never self-clear changes here
  runtime?: boolean; // false when the files never reach production (docs, tests)
}

export interface Airspace {
  sectors: Sector[];
  defaultCriticality: number;
  irreversible: string[];
  manifests: string[];
}

export interface SectorHit {
  sector: string;
  criticality: number;
  files: number;
  churn: number;
  protected: boolean;
  runtime: boolean;
}

export interface RiskSignal {
  id: string;
  label: string;
  /** Probability that this signal alone causes a production incident. */
  probability: number;
  detail: string;
}

export interface RiskAssessment {
  score: number; // 0..1, noisy-OR of all signal probabilities
  band: RiskBand;
  signals: RiskSignal[];
  sectors: SectorHit[];
  blastRadius: number; // number of runtime sectors touched
  runtimeChange: boolean; // false when nothing that ships to production changed
  churn: number;
  files: number;
}

export interface CanaryPlan {
  steps: number[]; // traffic percentages, ending at 100
  bakeSeconds: number;
}

export interface AutonomyPolicy {
  version: number;
  autonomous: { maxRisk: number; minTrust: number };
  supervised: { maxRisk: number };
  assisted: { maxRisk: number };
  errorBudget: { freezeBelow: number; tightenBelow: number };
  holds: string[];
  canary: Record<Exclude<ClearanceLevel, 'hold'>, CanaryPlan>;
  analysis: {
    maxErrorRateDelta: number;
    maxLatencyP95Ratio: number;
    significance: number;
    minRequests: number;
    sloTarget: number;
    fastBurn: number;
  };
  trust: {
    priorSuccesses: number;
    priorFailures: number;
    halfLifeDays: number;
    confidence: number;
  };
  freezeWindows: { name: string; days: number[]; fromHour: number; toHour: number }[];
}

export type PipelineTier = 'taxi' | 'lean' | 'standard' | 'full';

export interface ClearanceDecision {
  level: ClearanceLevel;
  reasons: string[];
  allowance: number; // the largest risk this flight could have carried autonomously
  thresholds: { autonomous: number; supervised: number; assisted: number }; // effective ceilings after budget scaling
  trust: number;
  budgetFactor: number;
  canary: CanaryPlan | null; // null when nothing needs deploying, or on hold
  tier: PipelineTier;
  approvalsRequired: number;
  holds: string[];
}

export type FlightOutcome = 'landed' | 'go-around' | 'incident' | 'diverted';

export interface LedgerEntry {
  flight: string; // e.g. "CLR-42"
  pilot: string; // author username (agent service account or human)
  pilotKind: AuthorKind;
  risk: number;
  level: ClearanceLevel;
  outcome: FlightOutcome;
  at: string; // ISO timestamp
}

export interface TrustScore {
  pilot: string;
  pilotKind: AuthorKind;
  trust: number; // conservative lower bound, 0..1
  mean: number;
  flights: number;
  landed: number;
  goArounds: number;
  incidents: number;
  streak: number; // consecutive clean landings, most recent first
  autonomyEarned: boolean;
}
