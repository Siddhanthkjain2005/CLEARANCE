import type { ClearanceLevel, Stage } from '../../core/types.ts';
import type { FlightView } from '../../core/projection.ts';

export const pct = (n: number | null | undefined, digits = 0) => (n == null || Number.isNaN(n) ? '–' : `${(n * 100).toFixed(digits)}%`);

export const LEVEL_LABEL: Record<ClearanceLevel, string> = {
  autonomous: 'Autonomous',
  supervised: 'Supervised',
  assisted: 'Assisted',
  hold: 'Holding',
};

/** ATC-style three-letter clearance codes for data blocks. */
export const LEVEL_CODE: Record<ClearanceLevel, string> = {
  autonomous: 'AUT',
  supervised: 'SUP',
  assisted: 'AST',
  hold: 'HLD',
};

export const STAGE_NAMES: Record<Stage, string> = {
  plan: 'Plan', create: 'Create', verify: 'Verify', package: 'Package', secure: 'Secure',
  release: 'Release', configure: 'Configure', monitor: 'Monitor', govern: 'Govern',
};

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
}

export function grams(g: number | null | undefined): string {
  if (g == null) return '–';
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  if (g >= 10) return `${g.toFixed(1)} g`;
  return `${g.toFixed(2)} g`;
}

export function flightStatus(f: FlightView): string {
  if (f.phase === 'landed') return f.outcome?.detail === 'taxi' ? 'Taxied in: nothing to deploy' : 'Landed';
  if (f.phase === 'go-around') return 'Went around: rolled back';
  if (f.phase === 'diverted') return f.outcome?.detail ?? 'Diverted';
  if (f.phase === 'holding') {
    if (f.level === 'hold') return 'Holding for a human';
    const failed = Object.entries(f.stages).find(([, s]) => s.status === 'failed');
    return failed ? `Holding: ${STAGE_NAMES[failed[0] as Stage]} failed` : 'Holding';
  }
  const active = (Object.entries(f.stages) as [Stage, FlightView['stages'][Stage]][]).filter(([, s]) => s.status === 'active').pop();
  if (active) {
    if (active[0] === 'monitor' && f.canary) return `Canary at ${f.canary.percent}% traffic`;
    return `${STAGE_NAMES[active[0]]}${active[1].detail ? `: ${active[1].detail}` : ''}`;
  }
  if (f.level === 'supervised' || f.level === 'assisted') {
    if (f.stages.secure.status === 'passed' && f.stages.release.status === 'pending') return 'Awaiting approval';
  }
  if (f.current === 'govern' && f.stages.govern.status === 'passed') return 'Landing';
  return `${STAGE_NAMES[f.current]} done`;
}

export function shortPilot(p: string): string {
  return p.replace(/^ai-clearance-/, '').replace(/^ai-/, '');
}

export function isAgentName(p: string): boolean {
  return /^ai-|service_account|duo|bot$/i.test(p);
}
