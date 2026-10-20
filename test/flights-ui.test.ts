// Search must find a callsign, change or pilot and keep held flights visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFlights } from '../src/web/ui/flights.ts';
const flights = [
  { id: 'CLR-1', title: 'Fix the webhook timeout', pilot: 'ai-clearance-medic', phase: 'airborne' as const },
  { id: 'CLR-2', title: 'Update autonomy policy', pilot: 'maya.chen', phase: 'holding' as const },
  { id: 'CLR-3', title: 'Document webhook retries', pilot: 'ai-clearance-dispatch', phase: 'landed' as const },
  { id: 'CLR-4', title: 'Fix canary errors', pilot: 'dev.okafor', phase: 'go-around' as const },
];
test('search combines callsign, title and pilot without changing snapshot order', () => {
  assert.deepEqual(filterFlights(flights, '  WEBHOOK medic ', 'all').map((f) => f.id), ['CLR-1']);
  assert.deepEqual(filterFlights(flights, 'webhook', 'all').map((f) => f.id), ['CLR-1', 'CLR-3']);
  assert.deepEqual(filterFlights(flights, 'clr-2', 'all').map((f) => f.id), ['CLR-2']);
  assert.equal(flights[0].title, 'Fix the webhook timeout');
});
test('active filter includes holds but excludes landed and rolled-back flights', () => {
  assert.deepEqual(filterFlights(flights, '', 'airborne').map((f) => f.id), ['CLR-1', 'CLR-2']);
  assert.deepEqual(filterFlights(flights, 'policy', 'holding').map((f) => f.id), ['CLR-2']);
  assert.deepEqual(filterFlights(flights, 'webhook', 'holding'), []);
});
test('clearing search and filters restores completed outcomes', () => {
  assert.deepEqual(filterFlights(flights, '  ', 'all'), flights);
  assert.deepEqual(filterFlights([], '', 'all'), []);
});
