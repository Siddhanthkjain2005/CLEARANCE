// Error budgets and multiwindow, multi-burn-rate alerting
// (Google SRE Workbook, "Alerting on SLOs", table 5-8).

export interface Bucket {
  t: number; // bucket start, epoch ms
  total: number;
  bad: number;
}

export interface BurnAlert {
  severity: 'page' | 'ticket';
  longWindowMin: number;
  shortWindowMin: number;
  threshold: number;
  longBurn: number;
  shortBurn: number;
  firing: boolean;
}

export interface BudgetStatus {
  target: number;
  windowDays: number;
  total: number;
  bad: number;
  remaining: number; // 0..1 of the budget left (can't go below 0)
  consumed: number; // 0..∞ fraction of the budget used
  alerts: BurnAlert[];
}

// Long window, short window (minutes), burn-rate threshold and severity.
export const BURN_RULES: [number, number, number, 'page' | 'ticket'][] = [
  [60, 5, 14.4, 'page'],
  [360, 30, 6, 'page'],
  [1440, 120, 3, 'ticket'],
  [4320, 360, 1, 'ticket'],
];

function windowRate(buckets: Bucket[], now: number, minutes: number): number {
  const since = now - minutes * 60_000;
  let total = 0;
  let bad = 0;
  for (const b of buckets) {
    if (b.t >= since && b.t <= now) { total += b.total; bad += b.bad; }
  }
  return total === 0 ? 0 : bad / total;
}

export function burnRate(buckets: Bucket[], now: number, minutes: number, target: number): number {
  return windowRate(buckets, now, minutes) / (1 - target);
}

export function budgetStatus(buckets: Bucket[], target: number, windowDays = 28, now = Date.now()): BudgetStatus {
  const since = now - windowDays * 86_400_000;
  let total = 0;
  let bad = 0;
  for (const b of buckets) if (b.t >= since) { total += b.total; bad += b.bad; }
  const allowed = (1 - target) * total;
  const consumed = allowed === 0 ? 0 : bad / allowed;
  const alerts = BURN_RULES.map(([long, short, threshold, severity]) => {
    const longBurn = burnRate(buckets, now, long, target);
    const shortBurn = burnRate(buckets, now, short, target);
    return {
      severity,
      longWindowMin: long,
      shortWindowMin: short,
      threshold,
      longBurn: Math.round(longBurn * 100) / 100,
      shortBurn: Math.round(shortBurn * 100) / 100,
      firing: longBurn >= threshold && shortBurn >= threshold,
    };
  });
  return {
    target,
    windowDays,
    total,
    bad,
    remaining: Math.max(0, Math.round((1 - consumed) * 10_000) / 10_000),
    consumed: Math.round(consumed * 10_000) / 10_000,
    alerts,
  };
}
