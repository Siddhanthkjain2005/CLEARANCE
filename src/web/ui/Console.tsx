// The control tower keeps the world in view while the flight board and
// instruments make the governor's decisions easy to inspect.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '../state.ts';
import { navigate } from '../state.ts';
import { StripBay } from './Strips.tsx';
import { FlightDetail } from './FlightDetail.tsx';
import { Ledger } from './Ledger.tsx';
import { Carbon } from './Carbon.tsx';
import { Governor } from './Governor.tsx';
import { isAirborne } from './bits.tsx';
import { clock, grams, pct } from './format.ts';

export type Tab = 'flights' | 'ledger' | 'carbon' | 'governor';
export type CameraView = 'approach' | 'airport' | 'riverside' | 'tower' | 'follow';
const CAMERAS: { id: CameraView; label: string }[] = [
  { id: 'approach', label: 'Approach' },
  { id: 'airport', label: 'Airport' },
  { id: 'riverside', label: 'Riverside' },
  { id: 'tower', label: 'Tower' },
  { id: 'follow', label: 'Follow flight' },
];
const TABS: { id: Tab; label: string; path: string; icon: string }[] = [
  { id: 'flights', label: 'Airspace', path: '/tower', icon: 'M3 12h18M12 3v18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6' },
  { id: 'ledger', label: 'Trust ledger', path: '/ledger', icon: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM8.5 12l2.5 2.5 4.5-5' },
  { id: 'carbon', label: 'Carbon', path: '/carbon', icon: 'M20 4c-1 10-3 16-10 16-5 0-8-7-3-11C11 5 16 7 20 4ZM5 21 16 10' },
  { id: 'governor', label: 'Governor', path: '/governor', icon: 'M4 7h16M4 17h16M8 4v6M16 14v6' },
];
function Icon({ path }: { path: string }) {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
export function ModeChip({ s }: { s: Snapshot }) {
  if (s.connection === 'offline') return <span className="mode mode-offline"><span className="mode-dot" />Tower unreachable</span>;
  if (!s.server) return <span className="mode"><span className="mode-dot" />Connecting</span>;
  if (s.server.mode === 'simulated') return <span className="mode mode-sim" title="Synthetic flights, assessed by the real decision engine. No GitLab project is connected."><span className="mode-dot" />Simulated traffic</span>;
  return <span className="mode mode-live" title={s.server.project?.lastError ?? 'Following your GitLab project'}><span className="mode-dot" />Live traffic{s.server.mode === 'mixed' && <span> + simulation</span>}</span>;
}
export function Wordmark({ onClick }: { onClick?: () => void }) {
  return <a className="wordmark" aria-label="Clearance home" href="/" onClick={(e) => { e.preventDefault(); onClick ? onClick() : navigate('/'); }}><span className="brand-symbol"><svg viewBox="0 0 28 28" width="23" height="23" fill="none" aria-hidden="true"><path d="M4 22 14 5l10 17M8 22l6-10 6 10M14 17v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>clearance<span className="brand-period">.</span></span></a>;
}
function Instruments({ s }: { s: Snapshot }) {
  const air = s.flights.filter(isAirborne);
  const holding = air.filter((f) => f.phase === 'holding').length;
  const decided = s.flights.filter((f) => f.level).slice(0, 24);
  const auto = decided.filter((f) => f.level === 'autonomous').length;
  const budget = s.budget;
  return <div className="instruments" role="group" aria-label="Flight instruments">
    <div className="inst"><span className="inst-label">Error budget</span><div className="inst-readout"><span className="inst-value">{budget ? pct(budget.remaining) : '–'}</span><span className={`inst-note${budget && budget.remaining < budget.tightenBelow ? ' is-warning' : ''}`}>{budget ? budget.remaining <= budget.freezeBelow ? 'Frozen' : budget.remaining < budget.tightenBelow ? 'Tightened' : 'Healthy' : 'Connecting'}</span></div><span className="instrument-track" aria-hidden="true"><span style={{ width: pct(budget?.remaining ?? 0) }} /></span></div>
    <div className="inst"><span className="inst-label">Active flights</span><div className="inst-readout"><span className="inst-value">{String(air.length).padStart(2, '0')}</span><span className="inst-note">{holding ? `${holding} holding` : 'In the air'}</span></div><span className="inst-foot">Intent → production</span></div>
    <div className="inst"><span className="inst-label">Autonomous</span><div className="inst-readout"><span className="inst-value">{auto}<span className="inst-denominator">/{decided.length}</span></span><span className="inst-note">Hands-off</span></div><span className="inst-foot">Of recent assessed flights</span></div>
    <div className="inst"><span className="inst-label">Carbon intensity</span><div className="inst-readout"><span className="inst-value inst-carbon">{s.carbon?.flights.flights ? grams(s.carbon.flights.meanSci) : '–'}</span></div><span className="inst-foot">CO₂e per change shipped</span></div>
  </div>;
}
function Tape({ s, onSelect }: { s: Snapshot; onSelect: (id: string) => void }) {
  return <div className="activity-feed"><span className="activity-label"><span className="activity-dot" />Activity</span><ol className="tape" aria-label="Recent flight activity">{s.tape.slice(-2).reverse().map((t) => <li key={t.id}><span className="tape-time mono">{clock(t.at)}</span><button type="button" className="tape-call mono" onClick={() => onSelect(t.flight)}>{t.flight}</button><span className="tape-text">{t.text}</span></li>)}</ol></div>;
}
const PANEL_TITLES: Record<Tab, { title: string; subtitle: string; number: string }> = {
  flights: { title: 'Flight board', subtitle: 'Every change, from intent to landing.', number: '01' },
  ledger: { title: 'Trust ledger', subtitle: 'Autonomy is earned. See the record.', number: '02' },
  carbon: { title: 'Carbon report', subtitle: 'Measure the work. Avoid the waste.', number: '03' },
  governor: { title: 'Try the governor', subtitle: 'Change the inputs. See the decision.', number: '04' },
};
export function Console({ s, tab, selected, onSelect, view, onView, expandedScene, onExpandScene }: { s: Snapshot; tab: Tab; selected: string | null; onSelect: (id: string | null) => void; view: CameraView; onView: (view: CameraView) => void; expandedScene: boolean; onExpandScene: (expanded: boolean) => void }) {
  const flight = selected ? s.flights.find((f) => f.id === selected) : null;
  const agent = flight ? s.agents.find((a) => a.pilot === flight.pilot) : undefined;
  const panel = useRef<HTMLElement>(null);
  const previousSelection = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const meta = PANEL_TITLES[tab];
  const scenic = view === 'airport' || view === 'riverside';
  useEffect(() => {
    if (flight) {
      previousSelection.current = flight.id;
      panel.current?.querySelector<HTMLButtonElement>('.back')?.focus();
    } else if (previousSelection.current) {
      const button = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-flight-id]') ?? [])].find((el) => el.dataset.flightId === previousSelection.current);
      const history = button?.closest('details');
      if (history) history.open = true;
      (button ?? panel.current?.querySelector<HTMLInputElement>('[aria-label="Search flights"]'))?.focus();
      previousSelection.current = null;
    }
  }, [flight?.id]);
  let body: ReactNode;
  if (flight) body = <FlightDetail f={flight} agent={agent} policy={s.policy} onClose={() => onSelect(null)} />;
  else if (tab === 'ledger') body = <Ledger agents={s.agents} policy={s.policy} simulated={s.server?.mode === 'simulated'} />;
  else if (tab === 'carbon') body = <Carbon carbon={s.carbon} flights={s.flights} />;
  else if (tab === 'governor') body = <Governor />;
  else body = <StripBay flights={s.flights} agents={s.agents} selected={selected} onSelect={onSelect} />;
  const expandControl = <button type="button" className="board-expand" aria-label={expanded ? 'Show airspace' : 'Expand flight board'} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Icon path={expanded ? 'M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5' : 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5'} /></button>;
  return <div className={`console console-${tab}${flight ? ' has-selection' : ''}${expanded ? ' board-expanded' : ''}${scenic ? ' is-scenic' : ''}${expandedScene ? ' world-expanded' : ''}`}>
    <header className="topbar"><div className="brand-lockup"><Wordmark /><span className="brand-caption">Control tower</span></div><nav className="tabs" aria-label="Console">{TABS.map((t) => <a key={t.id} href={t.path} className={`tab${tab === t.id && !flight ? ' is-active' : ''}`} aria-current={tab === t.id && !flight ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onSelect(null); navigate(t.path); }}><Icon path={t.icon} />{t.label}</a>)}</nav><div className="topbar-status"><ModeChip s={s} /><span className="tower-id mono">TWR / 001</span></div></header>
    <section className="airspace-heading" aria-label="Airspace overview"><p className="eyebrow"><span className="status-beacon" />{scenic ? 'Explore the airspace / drag to orbit' : 'Autonomous delivery / live airspace'}</p>{scenic ? <><h1>{view === 'airport' ? 'Clearance International.' : 'The river district.'}</h1><p className="airspace-description">{view === 'airport' ? 'Terminal, stands and ground operations.' : 'The city beneath the approach.'}</p></> : <><h1>Every flight.<br /><span>Under control.</span></h1><p className="airspace-description">From the first intent to the final landing.<br />A clear view of everything your agents ship.</p></>}</section>
    <div className="scene-coordinate mono" aria-hidden="true"><span>RWY 09 / 27</span><span>{s.server?.region === 'northamerica-northeast1' ? 'Montréal' : s.server?.region ?? 'Local airspace'}</span></div>
    <button type="button" className="world-expand" aria-label={expandedScene ? 'Show flight board' : 'Expand airspace'} title={expandedScene ? 'Show flight board' : 'Expand airspace'} aria-expanded={expandedScene} onClick={() => onExpandScene(!expandedScene)}><Icon path={expandedScene ? 'M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5' : 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5'} /></button>
    <div className="camera-toolbar" role="group" aria-label="Camera view"><span className="camera-label"><Icon path="M3 7h4l2-3h6l2 3h4v13H3V7ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />View</span>{CAMERAS.map(({ id, label }) => <button key={id} type="button" aria-pressed={view === id} disabled={id === 'follow' && !flight} title={id === 'follow' && !flight ? 'Select a flight to follow it' : undefined} className={view === id ? 'is-active' : ''} onClick={() => onView(id)}>{label}</button>)}</div>
    <aside ref={panel} className={`panel${flight ? ' panel-detail' : ''}${tab === 'governor' && !flight ? ' panel-wide' : ''}`} aria-label={flight ? `Flight ${flight.id}` : meta.title}>{flight ? <div className="detail-navigation"><button type="button" className="back" onClick={() => onSelect(null)}>Back to flight board</button>{expandControl}</div> : <header className="board-heading"><div><span className="eyebrow">Tower operations</span><h2>{meta.title}</h2><p>{meta.subtitle}</p></div><div className="board-heading-actions"><span className="board-number mono">{meta.number}</span>{expandControl}</div></header>}{body}</aside>
    <div className="hud"><Instruments s={s} /><Tape s={s} onSelect={onSelect} /></div>
    <footer className="tower-footer"><span><span className="footer-dot" />{s.connection === 'live' ? 'Tower connected' : s.connection === 'offline' ? 'Connection lost' : 'Connecting to tower'}</span><span className="mono">NINE GATES. ONE CLEARANCE.</span></footer>
  </div>;
}
