// Loads and validates the policy-as-code files in .clearance/.
// Every field has a safe default, so a missing file never makes the governor
// more permissive than the defaults below.

import { parseYaml, type YamlValue } from './yaml.ts';
import type { Airspace, AutonomyPolicy, Sector } from './types.ts';

type Obj = { [k: string]: YamlValue };

function obj(v: YamlValue | undefined): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function num(v: YamlValue | undefined, d: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(max, Math.max(min, n));
}
function strs(v: YamlValue | undefined, d: string[] = []): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
}

export const DEFAULT_POLICY: AutonomyPolicy = {
  version: 1,
  autonomous: { maxRisk: 0.35, minTrust: 0.55 },
  supervised: { maxRisk: 0.7 },
  assisted: { maxRisk: 0.9 },
  errorBudget: { freezeBelow: 0.1, tightenBelow: 0.5 },
  holds: ['protected_sectors', 'critical_findings', 'secrets_detected', 'freeze_windows'],
  canary: {
    autonomous: { steps: [25, 50, 100], bakeSeconds: 120 },
    supervised: { steps: [10, 25, 50, 100], bakeSeconds: 300 },
    assisted: { steps: [5, 25, 50, 100], bakeSeconds: 600 },
  },
  analysis: {
    maxErrorRateDelta: 0.01,
    maxLatencyP95Ratio: 1.25,
    significance: 0.05,
    minRequests: 200,
    sloTarget: 0.995,
    fastBurn: 14.4,
  },
  trust: { priorSuccesses: 2, priorFailures: 3, halfLifeDays: 30, confidence: 0.9 },
  freezeWindows: [],
};

export const DEFAULT_AIRSPACE: Airspace = {
  sectors: [
    { name: 'governance', paths: ['.clearance/**', '.gitlab/security-policies/**', 'CODEOWNERS'], criticality: 1, protected: true, runtime: false },
    { name: 'pipeline', paths: ['.gitlab-ci.yml', '.gitlab/ci/**'], criticality: 0.85, runtime: false },
    { name: 'docs', paths: ['docs/**', '*.md'], criticality: 0.02, runtime: false },
  ],
  defaultCriticality: 0.4,
  irreversible: ['**/migrations/**'],
  manifests: ['package.json', 'package-lock.json', 'Dockerfile', 'requirements*.txt', 'go.mod', 'Gemfile.lock'],
};

function canaryPlan(v: YamlValue | undefined, d: { steps: number[]; bakeSeconds: number }) {
  const o = obj(v);
  const steps = Array.isArray(o.steps)
    ? o.steps.filter((x): x is number => typeof x === 'number' && x > 0 && x <= 100)
    : d.steps;
  if (steps.length === 0 || steps[steps.length - 1] !== 100) steps.push(100);
  return { steps, bakeSeconds: num(o.bake_seconds, d.bakeSeconds, 0, 86_400) };
}

export function parsePolicy(src: string | null | undefined): AutonomyPolicy {
  if (!src) return structuredClone(DEFAULT_POLICY);
  const root = obj(parseYaml(src));
  const d = DEFAULT_POLICY;
  const auto = obj(obj(root.autonomy).autonomous);
  const sup = obj(obj(root.autonomy).supervised);
  const asst = obj(obj(root.autonomy).assisted);
  const eb = obj(root.error_budget);
  const canary = obj(root.canary);
  const an = obj(root.analysis);
  const tr = obj(root.trust);
  const policy: AutonomyPolicy = {
    version: num(root.version, 1),
    autonomous: {
      maxRisk: num(auto.max_risk, d.autonomous.maxRisk, 0, 1),
      minTrust: num(auto.min_trust, d.autonomous.minTrust, 0, 1),
    },
    supervised: { maxRisk: num(sup.max_risk, d.supervised.maxRisk, 0, 1) },
    assisted: { maxRisk: num(asst.max_risk, d.assisted.maxRisk, 0, 1) },
    errorBudget: {
      freezeBelow: num(eb.freeze_below, d.errorBudget.freezeBelow, 0, 1),
      tightenBelow: num(eb.tighten_below, d.errorBudget.tightenBelow, 0, 1),
    },
    holds: strs(root.holds, d.holds),
    canary: {
      autonomous: canaryPlan(canary.autonomous, d.canary.autonomous),
      supervised: canaryPlan(canary.supervised, d.canary.supervised),
      assisted: canaryPlan(canary.assisted, d.canary.assisted),
    },
    analysis: {
      maxErrorRateDelta: num(an.max_error_rate_delta, d.analysis.maxErrorRateDelta, 0, 1),
      maxLatencyP95Ratio: num(an.max_latency_p95_ratio, d.analysis.maxLatencyP95Ratio, 1, 100),
      significance: num(an.significance, d.analysis.significance, 0.0001, 0.5),
      minRequests: num(an.min_requests, d.analysis.minRequests, 1),
      sloTarget: num(an.slo_target, d.analysis.sloTarget, 0.5, 0.99999),
      fastBurn: num(an.fast_burn, d.analysis.fastBurn, 1),
    },
    trust: {
      priorSuccesses: num(tr.prior_successes, d.trust.priorSuccesses, 0.1),
      priorFailures: num(tr.prior_failures, d.trust.priorFailures, 0.1),
      halfLifeDays: num(tr.half_life_days, d.trust.halfLifeDays, 1),
      confidence: num(tr.confidence, d.trust.confidence, 0.5, 0.999),
    },
    freezeWindows: (Array.isArray(root.freeze_windows) ? root.freeze_windows : []).map((w) => {
      const o = obj(w);
      return {
        name: typeof o.name === 'string' ? o.name : 'freeze',
        days: Array.isArray(o.days) ? o.days.filter((x): x is number => typeof x === 'number') : [],
        fromHour: num(o.from_hour, 0, 0, 24),
        toHour: num(o.to_hour, 24, 0, 24),
      };
    }),
  };
  // Thresholds must be ordered, otherwise a typo could widen autonomy.
  if (!(policy.autonomous.maxRisk <= policy.supervised.maxRisk && policy.supervised.maxRisk <= policy.assisted.maxRisk)) {
    throw new Error('policy: autonomy thresholds must satisfy autonomous <= supervised <= assisted');
  }
  return policy;
}

export function parseAirspace(src: string | null | undefined): Airspace {
  if (!src) return structuredClone(DEFAULT_AIRSPACE);
  const root = obj(parseYaml(src));
  const sectors: Sector[] = (Array.isArray(root.sectors) ? root.sectors : []).map((s, i) => {
    const o = obj(s);
    if (typeof o.name !== 'string') throw new Error(`airspace: sector ${i + 1} needs a name`);
    return {
      name: o.name,
      paths: strs(o.paths),
      criticality: num(o.criticality, DEFAULT_AIRSPACE.defaultCriticality, 0, 1),
      protected: o.protected === true,
      runtime: o.runtime !== false,
    };
  });
  return {
    sectors,
    defaultCriticality: num(root.default_criticality, DEFAULT_AIRSPACE.defaultCriticality, 0, 1),
    irreversible: strs(root.irreversible, DEFAULT_AIRSPACE.irreversible),
    manifests: strs(root.manifests, DEFAULT_AIRSPACE.manifests),
  };
}
