// Client state: one server-sent event stream from the Tower, folded into a
// snapshot that components read through useSyncExternalStore.

import { useSyncExternalStore } from 'react';
import type { FlightView } from '../core/projection.ts';
import type { Stage } from '../core/types.ts';
import type { AgentView, TapeItem } from '../tower/store.ts';

export interface ServerInfo {
  mode: 'live' | 'simulated' | 'mixed';
  revision: string;
  role: string;
  commit: string;
  region: string;
  uptimeSeconds: number;
  project: { path: string; url: string | null; lastSync: string | null; lastError: string | null } | null;
  drill: string | null;
}

export interface Budget {
  remaining: number;
  source: string;
  target: number;
  tightenBelow: number;
  freezeBelow: number;
  alerts: { severity: string; longWindowMin: number; shortWindowMin: number; threshold: number; longBurn: number; shortBurn: number; firing: boolean }[];
}

export interface Carbon {
  flights: { flights: number; totalG: number; avoidedG: number; energyKwh: number; meanSci: number; avoidedPct: number };
  runtime: { utilisation: number; energyKwh: number; totalG: number; perThousandRequests: number; region: string; intensity: number; requests: number };
}

export interface PolicySummary {
  autonomous: { maxRisk: number; minTrust: number };
  supervised: { maxRisk: number };
  assisted: { maxRisk: number };
  errorBudget: { freezeBelow: number; tightenBelow: number };
  holds: string[];
  canary: Record<string, { steps: number[]; bakeSeconds: number }>;
}

export interface Snapshot {
  server: ServerInfo | null;
  stages: Stage[];
  flights: FlightView[];
  tape: TapeItem[];
  agents: AgentView[];
  budget: Budget | null;
  carbon: Carbon | null;
  coverage: Record<Stage, number> | null;
  policy: PolicySummary | null;
  connection: 'connecting' | 'live' | 'reconnecting' | 'offline';
}

const EMPTY: Snapshot = {
  server: null, stages: [], flights: [], tape: [], agents: [], budget: null, carbon: null, coverage: null, policy: null, connection: 'connecting',
};

type Listener = () => void;

class LiveState {
  snap: Snapshot = EMPTY;
  private listeners = new Set<Listener>();
  private es: EventSource | null = null;
  private failures = 0;
  private pending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    if (!this.es && !this.pollTimer) this.connect();
    return () => this.listeners.delete(l);
  };

  get = () => this.snap;

  private emit() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      for (const l of this.listeners) l();
    });
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private upsert(f: FlightView) {
    const flights = this.snap.flights.filter((x) => x.id !== f.id);
    flights.unshift(f);
    flights.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    this.set({ flights: flights.slice(0, 60) });
  }

  connect() {
    if (typeof EventSource === 'undefined') return this.poll();
    const es = new EventSource('/api/stream');
    this.es = es;
    es.addEventListener('hello', (e) => {
      const s = JSON.parse((e as MessageEvent).data);
      this.failures = 0;
      this.set({ ...s, connection: 'live' });
    });
    es.addEventListener('flight', (e) => this.upsert(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data);
      this.set({ flights: this.snap.flights.filter((f) => f.id !== id) });
    });
    es.addEventListener('tape', (e) => this.set({ tape: [...this.snap.tape, JSON.parse((e as MessageEvent).data)].slice(-80) }));
    es.addEventListener('ledger', (e) => this.set({ agents: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener('pulse', (e) => this.set({ ...JSON.parse((e as MessageEvent).data) }));
    es.onerror = () => {
      this.failures++;
      if (this.failures >= 4) {
        es.close();
        this.es = null;
        this.poll();
      } else this.set({ connection: 'reconnecting' });
    };
  }

  private poll() {
    const load = async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(String(res.status));
        this.set({ ...(await res.json()), connection: 'live' });
      } catch {
        this.set({ connection: 'offline' });
      }
    };
    load();
    this.pollTimer = setInterval(load, 5000);
  }
}

export const live = new LiveState();

export function useLive(): Snapshot {
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}

// ------------------------------------------------------------- tiny router

type RouteListener = () => void;
const routeListeners = new Set<RouteListener>();
window.addEventListener('popstate', () => routeListeners.forEach((l) => l()));

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  routeListeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => location.pathname,
    () => '/',
  );
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
