// The Tower's read model: projection of flight events, webhook normalisation,
// the event store, and the simulator flying through the real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, type FlightView } from '../src/core/projection.ts';
import { DEFAULT_AIRSPACE, DEFAULT_POLICY, parseAirspace } from '../src/core/config.ts';
import { Store } from '../src/tower/store.ts';
import { GitLabSync, jobsToStageEvents } from '../src/tower/sync.ts';
import { Simulator } from '../src/tower/simulator.ts';
import { GitLab } from '../src/core/gitlab.ts';
import type { FlightEvent } from '../src/core/events.ts';
import { readFileSync } from 'node:fs';

const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, s)).toISOString();

test('projection walks a flight through the approach', () => {
  const flights = new Map<string, FlightView>();
  const ev = (e: Omit<FlightEvent, 'flight'>) => applyEvent(flights, { flight: 'CLR-1', ...e } as FlightEvent);
  ev({ type: 'flight.opened', at: at(0), title: 't', pilot: 'ai-x', pilotKind: 'agent' } as never);
  let f = ev({ type: 'stage.started', at: at(1), stage: 'verify' } as never);
  assert.equal(f.current, 'verify');
  assert.equal(f.progress, 2.5);
  assert.equal(f.stages.plan.status, 'pending', 'starting a stage does not pass earlier ones');
  f = ev({ type: 'stage.passed', at: at(2), stage: 'secure' } as never);
  assert.equal(f.stages.plan.status, 'passed', 'passing a stage implies earlier ones passed');
  assert.equal(f.progress, 5);
  f = ev({ type: 'canary.step', at: at(3), percent: 25 } as never);
  assert.equal(f.stages.monitor.status, 'active');
  f = ev({ type: 'flight.go-around', at: at(4), detail: 'errors' } as never);
  assert.equal(f.phase, 'go-around');
  assert.equal(f.stages.monitor.status, 'failed');
});

test('an intent becomes a merge request flight', () => {
  const flights = new Map<string, FlightView>();
  applyEvent(flights, { type: 'flight.opened', flight: 'INT-3', at: at(0), title: 'intent', pilot: 'maya', pilotKind: 'human' });
  applyEvent(flights, { type: 'stage.passed', flight: 'INT-3', at: at(1), stage: 'plan' });
  applyEvent(flights, { type: 'agent.action', flight: 'INT-3', at: at(2), agent: 'ai-d', action: 'drafted a flight plan', detail: '' });
  const f = applyEvent(flights, { type: 'flight.linked', flight: 'CLR-9', at: at(3), from: 'INT-3' });
  assert.ok(!flights.has('INT-3'));
  assert.equal(f.intent, 'INT-3');
  assert.equal(f.stages.plan.status, 'passed');
  assert.equal(f.actions.length, 1);
});

test('the store deduplicates, persists nothing simulated, and builds a tape', () => {
  const store = new Store(DEFAULT_POLICY, null);
  const e: FlightEvent = { type: 'flight.opened', flight: 'CLR-2', at: at(0), title: 'x', pilot: 'ai-x', pilotKind: 'agent' };
  assert.equal(store.ingest([e, e]), 1);
  assert.equal(store.tape.length, 1);
  store.ingest([{ type: 'assessment', flight: 'CLR-2', at: at(1), risk: { score: 0.1, band: 'low', signals: [], sectors: [], blastRadius: 1, runtimeChange: true, churn: 10, files: 1 } }]);
  assert.equal(store.tape.length, 1, 'assessments stay off the tape');
  assert.equal(store.agents()[0].pilot, 'ai-x');
});

test('pipeline jobs map onto lifecycle stages', () => {
  const job = (name: string, stage: string, status: string) => ({ id: 1, name, stage, status, duration: 1, started_at: at(0), finished_at: at(1), web_url: '', pipeline: { id: 1, ref: '', sha: '' } });
  const events = jobsToStageEvents('CLR-5', [job('clearance:assess', 'plan', 'success'), job('semgrep-sast', 'secure', 'success'), job('secret_detection', 'secure', 'failed'), job('monitor:canary', 'monitor', 'running')]);
  const by = Object.fromEntries(events.map((e) => [(e as { stage: string }).stage, e.type]));
  assert.deepEqual(by, { plan: 'stage.passed', secure: 'stage.failed', monitor: 'stage.started' });
});

test('webhooks become flight events immediately', () => {
  const store = new Store(DEFAULT_POLICY, null);
  const sync = new GitLabSync(store, new GitLab({ baseUrl: 'http://127.0.0.1:9/api/v4', token: 'x', timeoutMs: 50 }), '42');
  sync.handleWebhook('Merge Request Hook', { user: { username: 'ai-clearance-dispatch-g' }, object_attributes: { iid: 21, title: 'feat: x', action: 'open', url: 'u', created_at: '2026-10-14 10:00:00 UTC' } });
  assert.equal(store.flights.get('CLR-21')?.pilotKind, 'agent');
  sync.handleWebhook('Pipeline Hook', {
    object_attributes: { id: 9 }, merge_request: { iid: 21 },
    builds: [{ id: 1, name: 'clearance:assess', stage: 'plan', status: 'success', started_at: '2026-10-14 10:01:00 UTC', finished_at: '2026-10-14 10:01:20 UTC' }, { id: 2, name: 'verify:flight', stage: 'verify', status: 'running', started_at: '2026-10-14 10:01:30 UTC' }],
  });
  assert.equal(store.flights.get('CLR-21')!.stages.verify.status, 'active');
  sync.handleWebhook('Note Hook', { user: { username: 'ai-clearance-dispatch-g' }, merge_request: { iid: 21 }, object_attributes: { note: '<!-- clearance:inspection verdict=CLEARED -->\nLooks good', url: 'n' } });
  assert.equal(store.flights.get('CLR-21')!.actions.at(-1)!.detail, 'Looks good');
  sync.handleWebhook('Issue Hook', { user: { username: 'maya' }, labels: [{ title: 'intent' }], object_attributes: { iid: 4, title: 'Do a thing', action: 'open', url: 'i' } });
  assert.equal(store.flights.get('INT-4')!.stages.plan.status, 'active');
});

test('the simulator flies the real engine and records outcomes', async () => {
  const store = new Store(DEFAULT_POLICY, null);
  const airspace = parseAirspace(readFileSync(new URL('../.clearance/airspace.yml', import.meta.url), 'utf8'));
  const sim = new Simulator(store, airspace ?? DEFAULT_AIRSPACE, { seed: 3, speed: 1 });
  store.setLedger(sim.seedLedger(), true);
  sim.running = true;
  for (let i = 0; i < 6; i++) sim.launch(undefined, 600_000); // fast-forward whole flights
  sim.stop();
  const flights = store.flightList();
  assert.ok(flights.length >= 6);
  assert.ok(flights.every((f) => f.simulated));
  assert.ok(flights.some((f) => f.decision), 'decisions come from the governor');
  assert.ok(flights.filter((f) => f.phase === 'landed' || f.phase === 'go-around' || f.phase === 'diverted').length >= 5);
  assert.ok(store.ledgerEntries().length > sim.seedLedger().length);
});
