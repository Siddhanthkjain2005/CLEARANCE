// The airport's own departure: pushed back by a tractor, taxied out on paved
// ground clear of the parked aircraft, held short while the runway is busy,
// then away on the runway heading and climbing out of sight.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Departure, PUSHBACK_PATH, TAXI_PATH, GROUND_REF } from '../src/web/engine/departure.ts';
import { DEPARTURE_STAND, STANDS, APRON } from '../src/web/engine/world/airport.ts';
import { occupiedStands, type Pose } from '../src/web/engine/world/traffic.ts';
import { RUNWAY, TAXIWAY_Z } from '../src/web/engine/path.ts';

function run(d: Departure, seconds: number, busy = false, inView = false, dt = 0.1) {
  for (let t = 0; t < seconds; t += dt) d.step(dt, busy, inView);
}

test('the departure works through its phases and climbs out to the east', () => {
  const d = new Departure();
  const seen = new Set<string>();
  let lastX = -Infinity;
  let maxY = 0;
  for (let t = 0; t < 900 && !(seen.has('climb') && d.phase === 'gone'); t += 0.1) {
    const s = d.step(0.1, false, false);
    seen.add(s.phase);
    for (const v of [...s.pos, s.pitch, s.bank, s.gear, s.flaps]) assert.ok(Number.isFinite(v));
    if (s.phase === 'roll') {
      assert.ok(s.pos[0] >= lastX - 1e-6, 'the take-off roll runs east');
      assert.ok(Math.abs(s.pos[2]) < 1, 'on the runway centreline');
      lastX = s.pos[0];
    }
    if (s.phase === 'climb') maxY = Math.max(maxY, s.pos[1]);
  }
  for (const p of ['parked', 'pushback', 'start', 'taxi', 'hold', 'lineup', 'roll', 'climb', 'gone']) assert.ok(seen.has(p), `reaches ${p}`);
  assert.ok(maxY > 900, 'climbs well clear of the airport');
  assert.ok(lastX < RUNWAY.x1, 'lifts off before the end of the runway');
});

function runWith(d: Departure, seconds: number, traffic: number) {
  for (let t = 0; t < seconds; t += 0.1) d.step(0.1, traffic, false);
}

test('it holds short while an arrival is on final and goes once the runway is clear', () => {
  const d = new Departure('taxi', 0);
  runWith(d, 400, 2);
  assert.equal(d.phase, 'hold', 'never lines up in front of a close arrival');
  const held = d.state.pos.slice();
  assert.ok(held[2] > 40, 'holds short of the runway, not on it');
  runWith(d, 10, 0);
  assert.equal(d.phase, 'lineup');
  const e = new Departure('taxi', 0);
  runWith(e, 400, 1);
  assert.notEqual(e.phase, 'hold', 'goes ahead of a distant arrival after a long wait');
});

test('the pushback tractor stays on the nose wheel while it pushes', () => {
  const d = new Departure('pushback', 0);
  for (let t = 0; t < 60; t += 0.5) {
    const s = d.step(0.5, false, false);
    if (s.phase !== 'pushback' || !s.tug) continue;
    const gap = Math.hypot(s.tug.x - s.pos[0], s.tug.z - s.pos[2]);
    assert.ok(Math.abs(gap - 15.2) < 0.01, `tractor ${gap.toFixed(2)} m from the reference point`);
  }
});

test('push-back and taxi routes stay on paved ground and clear of parked aircraft', () => {
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  const parked = occupiedStands().map((i) => STANDS[i]);
  for (const path of [PUSHBACK_PATH, TAXI_PATH]) {
    for (let s = 0; s <= path.length; s += 2) {
      path.sample(s, pose);
      const onApron = pose.x > APRON.x0 && pose.x < APRON.x1 && pose.z > APRON.z0 - 1 && pose.z < APRON.z1;
      const onTaxiway = Math.abs(pose.z - TAXIWAY_Z) < 12 && pose.x > -160 && pose.x < RUNWAY.x1 + 160;
      const onConnector = Math.abs(pose.x - 900) < 12 && pose.z > TAXIWAY_Z - 12 && pose.z < APRON.z0 + 2;
      const onLink = pose.x < 60 && pose.x > -140 && pose.z > -5 && pose.z < TAXIWAY_Z + 12;
      assert.ok(onApron || onTaxiway || onConnector || onLink, `off the pavement at ${pose.x.toFixed(0)}, ${pose.z.toFixed(0)}`);
      for (const p of parked) {
        // wing tips of 17 m either side must clear tails and wing tips of parked aircraft
        assert.ok(Math.abs(pose.x - p.x) > 36 || pose.z < p.z - 2 - 19.6 - 17 + 4 || Math.abs(pose.x - p.x) > 0 && path === PUSHBACK_PATH, 'clear of parked aircraft');
      }
    }
  }
  assert.ok(STANDS[DEPARTURE_STAND], 'the departure stand exists');
  assert.equal(GROUND_REF, 3.6);
});

test('a fresh aircraft is boarded only when nobody is watching, or after a while', () => {
  const d = new Departure('gone', 0);
  run(d, 40, false, true);
  assert.equal(d.phase, 'gone', 'waits while the empty stand is in view');
  run(d, 40, false, true);
  assert.equal(d.phase, 'parked', 'but not forever');
  const e = new Departure('gone', 0);
  run(e, 21, false, false);
  assert.equal(e.phase, 'parked');
});
