// Small presentational pieces shared across the console.

import type { ReactNode } from 'react';
import type { FlightView, StageView } from '../../core/projection.ts';
import { STAGES, type ClearanceLevel, type Stage } from '../../core/types.ts';
import { LEVEL_LABEL, STAGE_NAMES, isAgentName } from './format.ts';

export function LevelChip({ level, size = 'md' }: { level: ClearanceLevel | null; size?: 'sm' | 'md' }) {
  if (!level) return <span className={`chip chip-pending chip-${size}`}>Assessing</span>;
  return <span className={`chip chip-${level} chip-${size}`}>{LEVEL_LABEL[level]}</span>;
}

export function StageTrack({ stages, compact = false }: { stages: Record<Stage, StageView>; compact?: boolean }) {
  return (
    <span className={`track${compact ? ' track-compact' : ''}`} role="img" aria-label={STAGES.map((s) => `${STAGE_NAMES[s]} ${stages[s].status}`).join(', ')}>
      {STAGES.map((s) => (
        <span key={s} className={`cell cell-${stages[s].status}`} title={`${STAGE_NAMES[s]}: ${stages[s].status}${stages[s].detail ? ` (${stages[s].detail})` : ''}`} />
      ))}
    </span>
  );
}

export function PilotMark({ name }: { name: string }) {
  const agent = isAgentName(name);
  return (
    <span className={`pilot ${agent ? 'pilot-agent' : 'pilot-human'}`} title={agent ? 'GitLab Duo agent' : 'Human'}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        {agent ? <path d="M6 1 11 6 6 11 1 6Z" fill="none" stroke="currentColor" strokeWidth="1.4" /> : <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />}
      </svg>
      {name}
    </span>
  );
}

/** A 0–100% scale with the flight's risk and the thresholds that decide its clearance. */
export function ClearanceScale({ risk, allowance, supervised, assisted }: { risk: number; allowance: number; supervised: number; assisted: number }) {
  const x = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;
  return (
    <div className="scale" role="img" aria-label={`Risk ${Math.round(risk * 100)}%, autonomous allowance ${Math.round(allowance * 100)}%`}>
      <div className="scale-band band-auto" style={{ left: 0, width: x(allowance) }} />
      <div className="scale-band band-sup" style={{ left: x(allowance), width: x(Math.max(0, supervised - allowance)) }} />
      <div className="scale-band band-ast" style={{ left: x(supervised), width: x(Math.max(0, assisted - supervised)) }} />
      <div className="scale-band band-hold" style={{ left: x(assisted), width: x(1 - assisted) }} />
      <div className="scale-marker" style={{ left: x(risk) }}>
        <span className="scale-value">{Math.round(risk * 100)}%</span>
      </div>
      <div className="scale-legend">
        <span>Autonomous ≤ {Math.round(allowance * 100)}%</span>
        <span>Supervised ≤ {Math.round(supervised * 100)}%</span>
        <span>Assisted ≤ {Math.round(assisted * 100)}%</span>
      </div>
    </div>
  );
}

export function Bar({ value, max = 1, tone = 'cyan', label }: { value: number; max?: number; tone?: string; label?: string }) {
  return (
    <span className={`bar bar-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} />
    </span>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="panel-section">
      <header className="panel-section-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function isAirborne(f: FlightView) {
  return f.phase === 'airborne' || f.phase === 'holding';
}
