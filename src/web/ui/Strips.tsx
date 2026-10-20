// Compact flight strips preserve the ATC metaphor without hiding the
// aircraft. Search and phase filters help find a change in live traffic.

import { useEffect, useRef, useState } from 'react';
import type { FlightView } from '../../core/projection.ts';
import type { AgentView } from '../../tower/store.ts';
import { Empty, StageTrack, isAirborne } from './bits.tsx';
import { LEVEL_LABEL, ago, flightStatus, pct, shortPilot, isAgentName } from './format.ts';
import { filterFlights, type FlightFilter } from './flights.ts';

export function Strip({ f, trust, selected, onSelect }: { f: FlightView; trust?: number; selected: boolean; onSelect: (id: string) => void }) {
  const tone = f.phase === 'go-around' || f.phase === 'diverted' ? 'hold' : f.level ?? 'pending';
  return <button type="button" data-flight-id={f.id} className={`strip strip-${tone}${selected ? ' is-selected' : ''}${f.phase === 'holding' ? ' is-holding' : ''}`} onClick={() => onSelect(f.id)} aria-pressed={selected}>
    <span className="strip-top"><span className="strip-call">{f.id}</span><span className="strip-clearance"><span />{f.level ? LEVEL_LABEL[f.level] : 'Assessing'}</span></span>
    <span className="strip-title">{f.title}</span>
    <span className="strip-meta"><span className={`strip-pilot ${isAgentName(f.pilot) ? 'is-agent' : ''}`} title={`${f.pilot}${trust != null ? ` · trust ${pct(trust)}` : ''}`}><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d={isAgentName(f.pilot) ? 'M6 1 11 6 6 11 1 6Z' : 'M6 1a5 5 0 1 0 0 10 5 5 0 1 0 0-10'} fill="none" stroke="currentColor" /></svg>{shortPilot(f.pilot)}</span><span className="strip-risk">Risk <strong>{f.risk ? pct(f.risk.score) : '–'}</strong></span></span>
    <StageTrack stages={f.stages} compact />
    <span className="strip-bottom"><span className="strip-status">{flightStatus(f)}</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg></span>
  </button>;
}
export function StripBay({ flights, agents, selected, onSelect }: { flights: FlightView[]; agents: AgentView[]; selected: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FlightFilter>('all');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const trust = new Map(agents.map((a) => [a.pilot, a.trust]));
  const filtered = filterFlights(flights, query, filter);
  const air = filtered.filter(isAirborne).sort((a, b) => b.progress - a.progress);
  const done = filtered.filter((f) => !isAirborne(f)).slice(0, 8);
  return <div className="bay">
    <label className="flight-search"><svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg><input ref={search} aria-label="Search flights" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a flight, change, or pilot…" /><kbd>/</kbd></label>
    <div className="flight-filters" role="group" aria-label="Filter flights">{([{ id: 'all', label: 'All flights' }, { id: 'airborne', label: 'In the air' }, { id: 'holding', label: 'Holding' }] as const).map((f) => <button key={f.id} type="button" className={filter === f.id ? 'is-active' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}{f.id === 'holding' && <span>{flights.filter((flight) => flight.phase === 'holding').length}</span>}</button>)}</div>
    <div className="bay-group"><h3 className="bay-title"><span className="status-beacon" />{filter === 'holding' ? 'Holding pattern' : 'In the air'}<span className="bay-count">{String(air.length).padStart(2, '0')}</span></h3>{air.length === 0 ? <Empty>{query ? 'No flights match your search.' : filter === 'holding' ? 'Clear airspace. No flights are holding.' : 'No active flights. Create an intent issue to start a flight.'}</Empty> : air.map((f) => <Strip key={f.id} f={f} trust={trust.get(f.pilot)} selected={selected === f.id} onSelect={onSelect} />)}</div>
    {done.length > 0 && <details className="recent-flights" open={query ? true : undefined}><summary>Recently on the ground<span className="bay-count">{done.length}</span></summary><div className="bay-group">{done.map((f) => <div key={f.id} className="strip-mini-wrap"><Strip f={f} trust={trust.get(f.pilot)} selected={selected === f.id} onSelect={onSelect} /><span className="strip-age">{ago(f.outcome?.at ?? f.updatedAt)}</span></div>)}</div></details>}
  </div>;
}
