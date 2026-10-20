// The trust ledger: autonomy is earned, flight by flight.
//
// Each pilot (a Duo agent's service account or a human) has a Beta-distributed
// belief about how often their changes land cleanly. Every flight updates it:
//   - a clean landing adds success weight, more for riskier flights;
//   - a go-around (canary rollback) adds failure weight, more for safer flights,
//     because failing an easy approach says more than failing a hard one;
//   - an incident after promotion counts double.
// Old flights decay with a half-life so trust reflects recent behaviour.
// The governor uses the *lower confidence bound*, so a pilot with three lucky
// flights is not trusted like one with forty.

import type { AutonomyPolicy, LedgerEntry, TrustScore } from './types.ts';

const DAY_MS = 86_400_000;

/** Inverse of the standard normal CDF (Acklam's rational approximation). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0, 1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function betaLowerBound(alpha: number, beta: number, confidence: number): { mean: number; lower: number } {
  const n = alpha + beta;
  const mean = alpha / n;
  const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
  const z = normInv(confidence);
  return { mean, lower: Math.max(0, Math.min(1, mean - z * sd)) };
}

export function computeTrust(
  entries: LedgerEntry[],
  policy: AutonomyPolicy,
  now: Date = new Date(),
): Map<string, TrustScore> {
  const byPilot = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const list = byPilot.get(e.pilot) ?? [];
    list.push(e);
    byPilot.set(e.pilot, list);
  }
  const out = new Map<string, TrustScore>();
  for (const [pilot, list] of byPilot) {
    out.set(pilot, scorePilot(pilot, list, policy, now));
  }
  return out;
}

export function scorePilot(pilot: string, list: LedgerEntry[], policy: AutonomyPolicy, now: Date = new Date()): TrustScore {
  const { priorSuccesses, priorFailures, halfLifeDays, confidence } = policy.trust;
  let alpha = priorSuccesses;
  let beta = priorFailures;
  let landed = 0;
  let goArounds = 0;
  let incidents = 0;
  const sorted = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let streak = 0;
  let streakOpen = true;
  for (const e of sorted) {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(e.at)) / DAY_MS);
    const w = Math.pow(0.5, ageDays / halfLifeDays);
    const risk = Math.min(1, Math.max(0, e.risk));
    if (e.outcome === 'landed') {
      alpha += w * (0.5 + risk);
      landed++;
      if (streakOpen) streak++;
    } else if (e.outcome === 'go-around') {
      beta += w * (1.5 - risk);
      goArounds++;
      streakOpen = false;
    } else if (e.outcome === 'incident') {
      beta += w * 2 * (1.5 - risk);
      incidents++;
      streakOpen = false;
    } else {
      streakOpen = false; // diverted: neither success nor failure, but breaks the streak
    }
  }
  const { mean, lower } = betaLowerBound(alpha, beta, confidence);
  return {
    pilot,
    pilotKind: list[0]?.pilotKind ?? 'agent',
    trust: Math.round(lower * 1000) / 1000,
    mean: Math.round(mean * 1000) / 1000,
    flights: list.length,
    landed,
    goArounds,
    incidents,
    streak,
    autonomyEarned: lower >= policy.autonomous.minTrust,
  };
}

/** Trust for a pilot with no history: priors only. */
export function newcomerTrust(pilot: string, kind: 'agent' | 'human', policy: AutonomyPolicy): TrustScore {
  return { ...scorePilot(pilot, [], policy), pilotKind: kind };
}

/** How many consecutive clean landings at a given risk it takes to earn autonomy. */
export function landingsToEarnAutonomy(current: LedgerEntry[], pilot: string, policy: AutonomyPolicy, risk = 0.2, now = new Date()): number {
  const list = current.filter((e) => e.pilot === pilot);
  for (let k = 0; k <= 60; k++) {
    const extra: LedgerEntry[] = Array.from({ length: k }, (_, i) => ({
      flight: `sim-${i}`, pilot, pilotKind: 'agent', risk, level: 'supervised', outcome: 'landed', at: now.toISOString(),
    }));
    if (scorePilot(pilot, [...list, ...extra], policy, now).trust >= policy.autonomous.minTrust) return k;
  }
  return Infinity;
}
