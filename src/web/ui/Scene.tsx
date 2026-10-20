// The persistent 3D layer behind every page, plus the HTML data blocks that
// follow each flight (ATC-style: callsign, risk, clearance) and gate labels.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Airspace, storyPosition, webglAvailable, type FlightInput, type GateLabel, type StoryAnchor, type TagPosition, type View } from '../engine/airspace.ts';
import type { FlightView } from '../../core/projection.ts';
import { STAGES } from '../../core/types.ts';
import { LEVEL_CODE, STAGE_NAMES } from './format.ts';
import { prefersReducedMotion } from '../state.ts';

interface Props {
  flights: FlightView[];
  view: View;
  interactive: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  offset: number;
  dim: number;
  showTags: boolean;
}

function toInput(f: FlightView): FlightInput {
  let activeStage: number | null = null;
  let startedAt: number | null = null;
  STAGES.forEach((s, i) => {
    if (f.stages[s].status === 'active') {
      activeStage = i;
      startedAt = f.stages[s].at ? Date.parse(f.stages[s].at!) : null;
    }
  });
  return {
    id: f.id,
    pilot: f.pilot,
    phase: f.phase,
    progress: f.progress,
    activeStage,
    stageStartedAt: startedAt,
    level: f.level,
    outcomeAt: f.outcome ? Date.parse(f.outcome.at) : null,
  };
}

export function Scene({ flights, view, interactive, selected, onSelect, offset, dim, showTags }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Airspace | null>(null);
  const tagEls = useRef(new Map<string, HTMLDivElement>());
  const gateEls = useRef<(HTMLDivElement | null)[]>([]);
  const [failed, setFailed] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!canvasRef.current) return;
    if (!webglAvailable()) {
      setFailed(true);
      return;
    }
    try {
      engine.current = new Airspace(canvasRef.current, {
        view,
        interactive,
        reducedMotion: prefersReducedMotion(),
        onPick: (id) => onSelectRef.current(id),
        onFrame: (tags: TagPosition[], gates: GateLabel[]) => {
          // Stack data blocks that would overlap, nearest-to-runway first.
          const placed: { x: number; y: number }[] = [];
          const visible = tags.filter((t) => t.visible).sort((a, b) => b.x - a.x);
          const lift = new Map<string, number>();
          for (const t of visible) {
            let dy = 0;
            for (let guard = 0; guard < 6; guard++) {
              const hit = placed.find((p) => Math.abs(p.x - t.x) < 84 && Math.abs(p.y - (t.y - dy)) < 30);
              if (!hit) break;
              dy += 30;
            }
            placed.push({ x: t.x, y: t.y - dy });
            lift.set(t.id, dy);
          }
          for (const t of tags) {
            const el = tagEls.current.get(t.id);
            if (!el) continue;
            if (!t.visible) { el.style.opacity = '0'; continue; }
            el.style.opacity = String(Math.min(1, t.alpha));
            el.style.transform = `translate3d(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px, 0)`;
            el.style.setProperty('--lift', `${lift.get(t.id) ?? 0}px`);
          }
          for (const g of gates) {
            const el = gateEls.current[g.index];
            if (!el) continue;
            el.style.opacity = g.visible ? String(0.45 + g.active * 0.55) : '0';
            el.style.transform = `translate3d(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px, 0)`;
          }
        },
      });
    } catch (e) {
      console.error(e);
      setFailed(true);
    }
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => engine.current?.setView(view), [view]);
  useEffect(() => engine.current?.setInteractive(interactive), [interactive]);
  useEffect(() => engine.current?.select(selected), [selected]);
  useEffect(() => engine.current?.setViewOffset(offset), [offset]);
  useEffect(() => engine.current?.setDim(dim), [dim]);

  useEffect(() => {
    if (view !== 'story') return;
    let frame = 0;
    let anchors: StoryAnchor[] = [];
    const measure = () => {
      anchors = [{ scroll: 0, story: 0 }];
      for (const section of document.querySelectorAll<HTMLElement>('[data-flight-chapter]')) {
        const story = Number(section.dataset.flightChapter);
        if (story < 1 || story > 9) continue;
        const rect = section.getBoundingClientRect();
        anchors.push({ scroll: Math.max(1, window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2), story });
      }
      const final = anchors[anchors.length - 1];
      if (final.story > 0) anchors.push({ scroll: final.scroll + window.innerHeight * 1.6, story: 11.6 });
      update();
    };
    const update = () => engine.current?.setStory(storyPosition(window.scrollY, anchors));
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    const observer = new ResizeObserver(measure);
    const landing = document.querySelector('.home');
    if (landing) observer.observe(landing);
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
    };
  }, [view]);

  const inputs = useMemo(() => flights.map(toInput), [flights]);
  useEffect(() => engine.current?.setFlights(inputs), [inputs]);

  const counts = useMemo(() => {
    const c = new Array(9).fill(0);
    for (const f of flights) {
      if (f.phase !== 'airborne' && f.phase !== 'holding') continue;
      const i = STAGES.indexOf(f.current);
      if (i >= 0) c[i]++;
    }
    return c;
  }, [flights]);

  const visibleTags = flights.filter((f) => !f.outcome || Date.now() - Date.parse(f.outcome.at) < 20_000);

  return (
    <div className="scene" aria-hidden={!interactive}>
      {failed ? <div className="scene-fallback" /> : <canvas ref={canvasRef} className="scene-canvas" />}
      {showTags && !failed && (
        <div className="tags" aria-hidden="true">
          {STAGES.map((s, i) => (
            <div key={s} className="gate-label" ref={(el) => { gateEls.current[i] = el; }}>
              <span className="gate-inner">
                <span className="gate-name">{STAGE_NAMES[s]}</span>
                {counts[i] > 0 && <span className="gate-count">{counts[i]}</span>}
              </span>
            </div>
          ))}
          {visibleTags.map((f) => (
            <div
              key={f.id}
              className={`tag tag-${f.phase === 'go-around' || f.phase === 'diverted' ? 'hold' : f.level ?? 'pending'}${selected === f.id ? ' is-selected' : ''}`}
              ref={(el) => {
                if (el) tagEls.current.set(f.id, el);
                else tagEls.current.delete(f.id);
              }}
              style={{ opacity: 0 }}
            >
              <span className="tag-leader" />
              <span className="tag-block">
                <span className="tag-call">{f.id}</span>
                <span className="tag-data">
                  {f.risk ? Math.round(f.risk.score * 100).toString().padStart(2, '0') : '--'} {f.level ? LEVEL_CODE[f.level] : 'ASM'}
                  {f.canary && f.phase === 'airborne' && f.stages.monitor.status === 'active' ? ` ${f.canary.percent}%` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
