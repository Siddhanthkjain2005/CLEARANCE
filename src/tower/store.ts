// Event-sourced state for the Tower.
//
// GitLab is the system of record (black boxes and the trust ledger live in the
// project's package registry), so this store is a cache that can always be
// rebuilt by syncing. Events are deduplicated by content, folded into flight
// views, optionally appended to a local NDJSON log, and fanned out to
// subscribers (the console's server-sent event streams).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEvent, stageCoverage, type FlightView } from '../core/projection.ts';
import type { FlightEvent } from '../core/events.ts';
import { computeTrust, landingsToEarnAutonomy, scorePilot } from '../core/trust.ts';
import type { AutonomyPolicy, LedgerEntry, TrustScore } from '../core/types.ts';

export interface TapeItem {
  id: string;
  at: string;
  flight: string;
  kind: FlightEvent['type'];
  text: string;
  simulated: boolean;
}

type Listener = (msg: { kind: 'flight'; flight: FlightView } | { kind: 'tape'; item: TapeItem } | { kind: 'ledger'; agents: AgentView[] } | { kind: 'remove'; id: string }) => void;

export interface AgentView extends TrustScore {
  needs: number; // clean landings still needed for autonomy (0 when earned)
  simulated: boolean;
}

const MAX_FLIGHTS = 80;
const MAX_TAPE = 200;

function digest(e: FlightEvent): string {
  return createHash('sha1').update(JSON.stringify(e)).digest('hex').slice(0, 16);
}

export function describe(e: FlightEvent): string {
  switch (e.type) {
    case 'flight.opened': return `${e.pilot} opened “${e.title}”`;
    case 'flight.linked': return `intent ${e.from} became merge request ${e.flight}`;
    case 'stage.started': return `${e.stage} started${e.job ? ` (${e.job})` : ''}`;
    case 'stage.passed': return `${e.stage} passed${e.detail ? `: ${e.detail}` : ''}`;
    case 'stage.failed': return `${e.stage} failed${e.detail ? `: ${e.detail}` : ''}`;
    case 'stage.skipped': return `${e.stage} skipped`;
    case 'assessment': return `risk ${(e.risk.score * 100).toFixed(0)}% (${e.risk.band})`;
    case 'clearance': return `cleared ${e.decision.level}: ${e.decision.reasons[0] ?? ''}`;
    case 'canary.step': return `canary at ${e.percent}% traffic`;
    case 'canary.verdict': return `canary verdict ${e.report.verdict}`;
    case 'flight.landed': return 'landed';
    case 'flight.go-around': return `went around: ${e.detail}`;
    case 'flight.held': return `holding: ${e.detail}`;
    case 'flight.diverted': return `diverted: ${e.detail}`;
    case 'agent.action': return `${e.agent} ${e.action}`;
    case 'sci': return `${e.report.sci.toFixed(2)} gCO₂e, ${(e.report.avoidedPct * 100).toFixed(0)}% avoided`;
    case 'evidence': return `evidence sealed: ${e.records} records`;
  }
}

export class Store {
  readonly flights = new Map<string, FlightView>();
  readonly tape: TapeItem[] = [];
  private seen = new Set<string>();
  private listeners = new Set<Listener>();
  private ledger: LedgerEntry[] = [];
  private ledgerSimulated = false;
  private dataFile: string | null;
  policy: AutonomyPolicy;

  constructor(policy: AutonomyPolicy, dataDir?: string | null) {
    this.policy = policy;
    this.dataFile = dataDir ? join(dataDir, 'events.ndjson') : null;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.replay();
    }
  }

  private replay() {
    if (!this.dataFile || !existsSync(this.dataFile)) return;
    const lines = readFileSync(this.dataFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(-20_000)) {
      try {
        this.ingest([JSON.parse(l) as FlightEvent], { persist: false, notify: false });
      } catch {
        /* skip a corrupt line rather than refusing to start */
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(msg: Parameters<Listener>[0]) {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        /* a broken stream must not break ingestion */
      }
    }
  }

  ingest(events: FlightEvent[], opts: { persist?: boolean; notify?: boolean } = {}): number {
    let applied = 0;
    const touched = new Set<string>();
    for (const e of events) {
      const id = digest(e);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > 100_000) this.seen = new Set([...this.seen].slice(-50_000));
      const before = e.type === 'flight.linked' ? e.from : null;
      const f = applyEvent(this.flights, e);
      if (before) this.notify({ kind: 'remove', id: before });
      touched.add(f.id);
      applied++;
      if (e.type !== 'stage.started' && e.type !== 'assessment' && e.type !== 'stage.skipped' && !(e.type === 'stage.passed' && (e.stage === 'plan' || e.stage === 'create'))) {
        const item: TapeItem = { id, at: e.at, flight: e.flight, kind: e.type, text: describe(e), simulated: e.source === 'simulator' };
        this.tape.push(item);
        if (this.tape.length > MAX_TAPE) this.tape.splice(0, this.tape.length - MAX_TAPE);
        if (opts.notify !== false) this.notify({ kind: 'tape', item });
      }
      if (opts.persist !== false && this.dataFile && e.source !== 'simulator') {
        try {
          appendFileSync(this.dataFile, JSON.stringify(e) + '\n');
        } catch {
          /* read-only filesystem: keep running from memory */
        }
      }
    }
    this.evict();
    if (opts.notify !== false) for (const id of touched) {
      const f = this.flights.get(id);
      if (f) this.notify({ kind: 'flight', flight: f });
    }
    return applied;
  }

  private evict() {
    if (this.flights.size <= MAX_FLIGHTS) return;
    const sorted = [...this.flights.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const f of sorted.slice(0, this.flights.size - MAX_FLIGHTS)) {
      this.flights.delete(f.id);
      this.notify({ kind: 'remove', id: f.id });
    }
  }

  setLedger(entries: LedgerEntry[], simulated = false) {
    this.ledger = entries;
    this.ledgerSimulated = simulated;
    this.notify({ kind: 'ledger', agents: this.agents() });
  }

  addLedgerEntry(entry: LedgerEntry, simulated = false) {
    this.ledger = [...this.ledger.filter((e) => e.flight !== entry.flight), entry].slice(-2000);
    this.ledgerSimulated = simulated;
    this.notify({ kind: 'ledger', agents: this.agents() });
  }

  ledgerEntries(): LedgerEntry[] {
    return this.ledger;
  }

  agents(): AgentView[] {
    const scores = computeTrust(this.ledger, this.policy);
    // Pilots seen in flights but absent from the ledger start from priors.
    for (const f of this.flights.values()) {
      if (!scores.has(f.pilot) && f.pilot !== 'unknown') {
        scores.set(f.pilot, { ...scorePilot(f.pilot, [], this.policy), pilotKind: f.pilotKind });
      }
    }
    return [...scores.values()]
      .map((s) => ({
        ...s,
        needs: s.autonomyEarned ? 0 : landingsToEarnAutonomy(this.ledger, s.pilot, this.policy),
        simulated: this.ledgerSimulated,
      }))
      .sort((a, b) => b.trust - a.trust);
  }

  flightList(): FlightView[] {
    return [...this.flights.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  coverage() {
    return stageCoverage(this.flights.values());
  }

  carbon() {
    let sci = 0;
    let avoided = 0;
    let energy = 0;
    let n = 0;
    for (const f of this.flights.values()) {
      if (!f.sci) continue;
      sci += f.sci.sci;
      avoided += f.sci.avoidedG;
      energy += f.sci.energyKwh;
      n++;
    }
    return {
      flights: n,
      totalG: Math.round(sci * 1000) / 1000,
      avoidedG: Math.round(avoided * 1000) / 1000,
      energyKwh: Math.round(energy * 1e6) / 1e6,
      meanSci: n ? Math.round((sci / n) * 1000) / 1000 : 0,
      avoidedPct: sci + avoided > 0 ? Math.round((avoided / (sci + avoided)) * 1000) / 1000 : 0,
    };
  }
}
