// Routes, the persistent airspace, and which panels sit over it.

import { useEffect, useState } from 'react';
import { live, navigate, useLive, usePath } from './state.ts';
import { Scene } from './ui/Scene.tsx';
import { Landing } from './ui/Landing.tsx';
import { Console, type CameraView, type Tab } from './ui/Console.tsx';

function useViewport() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

const TAB_FOR: Record<string, Tab> = { '/tower': 'flights', '/ledger': 'ledger', '/carbon': 'carbon', '/governor': 'governor' };

export function App() {
  const s = useLive();
  const path = usePath();
  const width = useViewport();
  const flightMatch = path.match(/^\/flights\/([A-Za-z]{3}-[\w-]+)$/);
  const selected = flightMatch ? decodeURIComponent(flightMatch[1]) : null;
  const isConsole = !!selected || path in TAB_FOR;
  const [lastTab, setLastTab] = useState<Tab>('flights');
  const [view, setView] = useState<CameraView>(selected ? 'follow' : 'approach');
  const [expandedScene, setExpandedScene] = useState(false);
  const tab = TAB_FOR[path] ?? lastTab;
  useEffect(() => { if (TAB_FOR[path]) setLastTab(TAB_FOR[path]); }, [path]);
  useEffect(() => setExpandedScene(false), [path]);
  const narrow = width < 900;

  // Opening a new flight puts its aircraft in frame. Camera buttons remain
  // available while its inspector stays open.
  useEffect(() => {
    if (selected) setView('follow');
    else setView((current) => current === 'follow' ? 'approach' : current);
  }, [selected]);

  useEffect(() => {
    document.title = selected ? `${selected} · Clearance` : isConsole ? 'Tower · Clearance' : 'Clearance';
    document.body.classList.toggle('is-console', isConsole);
    if (isConsole) window.scrollTo(0, 0);
  }, [isConsole, selected]);

  // Keep the selection valid when a flight is renamed (intent → merge request) or evicted.
  useEffect(() => {
    if (selected && s.flights.length && !s.flights.some((f) => f.id === selected) && s.connection === 'live') {
      const linked = s.flights.find((f) => f.intent === selected);
      navigate(linked ? `/flights/${linked.id}` : '/tower', { replace: true });
    }
  }, [selected, s.flights, s.connection]);

  const panelWidth = tab === 'governor' && !selected ? 600 : 360;
  const offset = narrow || expandedScene ? 0 : isConsole ? -panelWidth / 2 : Math.min(300, width * 0.2);

  const onSelect = (id: string | null) => {
    if (id) setView('follow');
    else if (view === 'follow') setView('approach');
    navigate(id ? `/flights/${encodeURIComponent(id)}` : TAB_FOR[path] ? path : '/tower');
  };

  return (
    <>
      <Scene
        flights={s.flights}
        view={isConsole ? view : 'story'}
        interactive={isConsole}
        selected={selected}
        onSelect={onSelect}
        offset={offset}
        dim={1}
        showTags={isConsole && width >= 700 && view !== 'airport' && view !== 'riverside'}
      />
      <main className={isConsole ? 'shell shell-console' : 'shell shell-landing'}>
        {isConsole ? <Console s={s} tab={tab} selected={selected} onSelect={onSelect} view={view} onView={setView} expandedScene={expandedScene} onExpandScene={setExpandedScene} /> : <Landing s={s} />}
      </main>
    </>
  );
}

export { live };
