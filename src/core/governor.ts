// The governor: LLM agents propose, deterministic policy disposes.
//
// Given a risk assessment, the pilot's earned trust and the service's remaining
// error budget, the governor issues a clearance level. It is pure, explainable
// and reproducible: the same inputs always produce the same decision, and every
// decision carries the reasons a human would need to audit it.

import type {
  AutonomyPolicy,
  ChangeSet,
  ClearanceDecision,
  ClearanceLevel,
  PipelineTier,
  RiskAssessment,
  TrustScore,
} from './types.ts';

export interface GovernorInput {
  change: Pick<ChangeSet, 'authorKind' | 'labels' | 'findings' | 'title'>;
  risk: RiskAssessment;
  trust: Pick<TrustScore, 'trust' | 'pilot'>;
  /** Remaining error budget, 0..1 (1 = untouched). */
  errorBudget: number;
  policy: AutonomyPolicy;
  now?: Date;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function budgetFactor(remaining: number, policy: AutonomyPolicy): number {
  const { tightenBelow, freezeBelow } = policy.errorBudget;
  if (remaining >= tightenBelow) return 1;
  if (remaining <= freezeBelow) return 0;
  return Math.round(Math.max(0.25, (remaining - freezeBelow) / (tightenBelow - freezeBelow)) * 10_000) / 10_000;
}

export function inFreezeWindow(policy: AutonomyPolicy, now: Date): string | null {
  for (const w of policy.freezeWindows) {
    const day = now.getUTCDay();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (w.days.includes(day) && hour >= w.fromHour && hour < w.toHour) return w.name;
  }
  return null;
}

export function tierFor(risk: RiskAssessment, level: ClearanceLevel): PipelineTier {
  if (!risk.runtimeChange) return 'taxi';
  if (level === 'hold') return 'full';
  if (risk.band === 'minimal' || risk.band === 'low') return level === 'autonomous' ? 'lean' : 'standard';
  if (risk.band === 'elevated') return 'standard';
  return 'full';
}

export function decide(input: GovernorInput): ClearanceDecision {
  const { change, risk, trust, errorBudget, policy } = input;
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const holds: string[] = [];
  const isAgent = change.authorKind === 'agent';
  const labels = (change.labels ?? []).map((l) => l.toLowerCase());
  const isFix = labels.some((l) => l === 'fix' || l === 'revert' || l === 'type::fix' || l === 'clearance::fix') || /^(fix|revert)\b/i.test(change.title);

  // --- Hard holds: no amount of trust overrides these.
  const protectedHit = risk.sectors.find((s) => s.protected);
  if (protectedHit && policy.holds.includes('protected_sectors')) {
    if (isAgent) {
      holds.push('protected_sectors');
      reasons.push(`Agents cannot clear their own governance: the change touches the protected ${protectedHit.sector} sector`);
    } else {
      reasons.push(`Touches the protected ${protectedHit.sector} sector, so a code owner must approve`);
    }
  }
  const findings = change.findings ?? [];
  if (policy.holds.includes('critical_findings') && findings.some((f) => f.severity === 'critical')) {
    holds.push('critical_findings');
    reasons.push('A scanner reported a critical vulnerability');
  }
  if (policy.holds.includes('secrets_detected') && findings.some((f) => /secret/i.test(f.scanner))) {
    holds.push('secrets_detected');
    reasons.push('Secret detection found a credential in the diff');
  }
  const freeze = policy.holds.includes('freeze_windows') ? inFreezeWindow(policy, now) : null;
  if (freeze && !isFix) {
    holds.push('freeze_windows');
    reasons.push(`Inside the "${freeze}" change freeze; only fixes may fly`);
  }

  // --- Error budget: a burning service shrinks everyone's autonomy.
  const bf = budgetFactor(errorBudget, policy);
  if (bf === 0) {
    if (!isFix) {
      holds.push('budget_exhausted');
      reasons.push(`Error budget is at ${pct(errorBudget)}; only fixes and reverts may ship until it recovers`);
    } else reasons.push(`Error budget is at ${pct(errorBudget)}, but fixes are allowed through under supervision`);
  } else if (bf < 1) {
    reasons.push(`Error budget is at ${pct(errorBudget)}, so autonomy thresholds are scaled to ${pct(bf)}`);
  }

  // --- Autonomy allowance grows with trust above the minimum.
  const factor = bf === 0 ? 0.25 : bf;
  const trustBonus = 1 + 0.5 * Math.max(0, trust.trust - policy.autonomous.minTrust);
  const allowance = Math.min(policy.supervised.maxRisk, policy.autonomous.maxRisk * factor * trustBonus);
  const supervisedMax = policy.supervised.maxRisk * factor;
  const assistedMax = policy.assisted.maxRisk * Math.max(factor, 0.5);

  let level: ClearanceLevel;
  if (holds.length > 0) {
    level = 'hold';
  } else if (!risk.runtimeChange && !protectedHit) {
    level = 'autonomous';
    reasons.push('Nothing that ships to production changed, so the flight taxis without a deployment');
  } else if (bf > 0 && !protectedHit && trust.trust >= policy.autonomous.minTrust && risk.score <= allowance) {
    level = 'autonomous';
    reasons.push(`Risk ${pct(risk.score)} is within the ${pct(allowance)} this pilot has earned (trust ${pct(trust.trust)})`);
  } else if (risk.score <= supervisedMax) {
    level = 'supervised';
    if (trust.trust < policy.autonomous.minTrust) {
      reasons.push(`${trust.pilot} has not earned autonomy yet (trust ${pct(trust.trust)}, needs ${pct(policy.autonomous.minTrust)})`);
    } else if (!protectedHit && bf > 0) {
      reasons.push(`Risk ${pct(risk.score)} exceeds the ${pct(allowance)} autonomous allowance`);
    }
  } else if (risk.score <= assistedMax) {
    level = 'assisted';
    reasons.push(`Risk ${pct(risk.score)} is high; a human approves each step`);
  } else {
    level = 'hold';
    holds.push('risk_ceiling');
    reasons.push(`Risk ${pct(risk.score)} is above the ${pct(assistedMax)} ceiling for any automated path`);
  }

  const tier = tierFor(risk, level);
  const canary = level === 'hold' || !risk.runtimeChange ? null : policy.canary[level];
  const approvalsRequired = level === 'autonomous' ? 0 : level === 'supervised' ? 1 : level === 'assisted' ? 2 : 2;

  return {
    level,
    reasons,
    allowance: Math.round(allowance * 1000) / 1000,
    thresholds: {
      autonomous: Math.round(allowance * 1000) / 1000,
      supervised: Math.round(supervisedMax * 1000) / 1000,
      assisted: Math.round(assistedMax * 1000) / 1000,
    },
    trust: trust.trust,
    budgetFactor: Math.round(bf * 1000) / 1000,
    canary,
    tier,
    approvalsRequired,
    holds,
  };
}
