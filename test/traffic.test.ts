// Ground and water traffic is a pure function of time from a seeded layout.
// Vehicles must keep to their roads, boats to the water, airside equipment
// off the runway and taxiway, and parked cars and stand equipment must not
// overlap each other or the parked aircraft.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { RUNWAY, TAXIWAY_Z } from '../src/web/engine/path.ts';
import { MOTORWAY } from '../src/web/engine/world/city.ts';
import { STANDS } from '../src/web/engine/world/airport.ts';
import { WATER_LEVEL, shorelineDistance } from '../src/web/engine/world/terrain.ts';
import {
  MOVER_FLOATS, MOVER_KINDS, Path, Schedule, Traffic, gseYard, landsideCars, occupiedStands, parkedCars, roundCorners, standEquipment,
  type MoverKind, type Pose,
} from '../src/web/engine/world/traffic.ts';
import * as V from '../src/web/engine/models/vehicles.ts';

const traffic = new Traffic();
const EVERYWHERE = 1e6;

function instances(time: number, kinds: MoverKind[]): { kind: MoverKind; x: number; y: number; z: number; heading: number }[] {
  const f = traffic.update(time, [0, 0, 0], EVERYWHERE, 0);
  const out: { kind: MoverKind; x: number; y: number; z: number; heading: number }[] = [];
  for (const k of kinds) {
    for (let i = 0; i < f.count[k]; i++) {
      const o = i * MOVER_FLOATS;
      out.push({ kind: k, x: f.data[k][o], y: f.data[k][o + 1], z: f.data[k][o + 2], heading: f.data[k][o + 3] });
    }
  }
  return out;
}

function distanceToPolyline(x: number, z: number, pts: [number, number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, , az] = pts[i];
    const [bx, , bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

test('every vehicle, train and boat model is finite, closed and carries unit normals', () => {
  const models = [V.car('sedan'), V.car('hatch'), V.car('suv'), V.carLod(), V.van(), V.lorry(), V.bus(false), V.bus(true), V.tug(), V.cart(false), V.cart(true),
    V.pushback(), V.fuelTruck(), V.cateringTruck(), V.beltLoader(), V.followMe(), V.apronBus(), V.trainCar(true, false), V.trainCar(false, true), V.barge(), V.boat(), V.sailboat(), V.person()];
  for (const g of models) {
    assert.ok(g.count > 8 && g.count < 4000, `a model has ${g.count} vertices`);
    assert.equal(g.idx.length % 3, 0);
    assert.ok(g.data.every(Number.isFinite));
    assert.ok(g.idx.every((i) => i >= 0 && i < g.count));
    for (let i = 0; i < g.data.length; i += LIT_STRIDE) assert.ok(Math.abs(Math.hypot(g.data[i + 3], g.data[i + 4], g.data[i + 5]) - 1) < 1e-4);
  }
});

test('the traffic is the same for every viewer at the same moment', () => {
  const again = new Traffic();
  const a = traffic.update(321.5, [1500, 50, 400], 6000, 4000);
  const snapshot = MOVER_KINDS.map((k) => Array.from(a.data[k].subarray(0, a.count[k] * MOVER_FLOATS)));
  const b = again.update(321.5, [1500, 50, 400], 6000, 4000);
  MOVER_KINDS.forEach((k, i) => assert.deepEqual(Array.from(b.data[k].subarray(0, b.count[k] * MOVER_FLOATS)), snapshot[i]));
  assert.ok(traffic.units > 500, 'a living landscape needs hundreds of vehicles');
});

test('motorway lanes keep to the carriageway', () => {
  for (let s = 0; s < 4; s++) {
    for (let u = 0; u < 40; u++) {
      for (const t of [0, 77, 300]) {
        const p = traffic.poseOf(s, u, t);
        if (!p) continue;
        assert.ok(distanceToPolyline(p.x, p.z, MOTORWAY) < 9, `vehicle ${u} in lane ${s} is ${distanceToPolyline(p.x, p.z, MOTORWAY).toFixed(1)} m off the motorway`);
      }
    }
  }
});

test('road vehicles stay out of the water; boats stay in it', () => {
  for (const t of [0, 140, 610]) {
    for (const v of instances(t, ['sedan', 'hatch', 'suv', 'van', 'lorry', 'bus', 'coach'])) {
      const bridge = v.y > WATER_LEVEL + 9;
      assert.ok(bridge || shorelineDistance(v.x, v.z) > 0, `a ${v.kind} at ${v.x.toFixed(0)}, ${v.z.toFixed(0)} is in the water`);
    }
    for (const v of instances(t, ['barge', 'boat', 'sailboat'])) {
      assert.ok(shorelineDistance(v.x, v.z) < -2, `a ${v.kind} at ${v.x.toFixed(0)}, ${v.z.toFixed(0)} is aground`);
      assert.ok(Math.abs(v.y - WATER_LEVEL) < 1e-6, 'hulls float on the water line');
    }
  }
});

test('airside equipment never enters the runway or the parallel taxiway', () => {
  const airside: MoverKind[] = ['tug', 'cart', 'uld', 'pushback', 'fuel', 'catering', 'loader', 'followme', 'apronbus'];
  for (let t = 0; t < 900; t += 37) {
    for (const v of instances(t, airside)) {
      if (v.x > RUNWAY.x0 - 200 && v.x < RUNWAY.x1 + 200) {
        assert.ok(Math.abs(v.z) > RUNWAY.width / 2 + 40, `${v.kind} on the runway at t=${t}`);
        assert.ok(Math.abs(v.z - TAXIWAY_Z) > 30, `${v.kind} on the taxiway at t=${t}`);
      }
    }
  }
});

test('parked cars and stand equipment keep their own space and clear of the aircraft', () => {
  const parked = [...parkedCars(), ...landsideCars(), ...gseYard()];
  const cell = new Map<string, { x: number; z: number; y: number }[]>();
  for (const p of parked) {
    const key = `${Math.floor(p.x / 10)}_${Math.floor(p.z / 10)}_${Math.round((p.y ?? 0) * 10)}`;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const k = `${Math.floor(p.x / 10) + dx}_${Math.floor(p.z / 10) + dz}_${Math.round((p.y ?? 0) * 10)}`;
      for (const q of cell.get(k) ?? []) assert.ok(Math.hypot(q.x - p.x, q.z - p.z) > 2.3, 'two parked vehicles overlap');
    }
    const list = cell.get(key) ?? [];
    list.push({ x: p.x, z: p.z, y: p.y ?? 0 });
    cell.set(key, list);
  }
  for (const e of standEquipment()) {
    for (const i of occupiedStands()) {
      const s = STANDS[i];
      // fuselage footprint of an aircraft parked nose-in facing +z
      assert.ok(!(Math.abs(e.x - s.x) < 2.3 && e.z > s.z - 2 - 20 && e.z < s.z - 2 + 18.5), `${e.kind} inside the fuselage at stand ${i}`);
    }
  }
});

test('paths wrap, schedules stop and wait, and corners are smoothed', () => {
  const square = new Path([[0, 0, 0], [100, 0, 0], [100, 0, 100], [0, 0, 100]], true);
  assert.equal(square.length, 400);
  const p: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  square.sample(450, p);
  assert.ok(Math.abs(p.x - 50) < 1e-9 && Math.abs(p.z) < 1e-9, 'distance wraps around a closed path');
  const sched = new Schedule(400, 10, [{ at: 0, dwell: 20 }, { at: 200, dwell: 30 }]);
  assert.equal(sched.at(5), 0, 'waiting at the first stop');
  const arrive = sched.period - 30 - 0.01;
  assert.ok(sched.at(10_000 * sched.period + 21) > 0, 'leaves after the dwell');
  let t = 20;
  while (sched.at(t) < 199.999 && t < sched.period) t += 0.25;
  assert.ok(Math.abs(sched.at(t + 10) - 200) < 1e-6, 'waits at the second stop');
  assert.ok(arrive > 0);
  const smooth = roundCorners([[0, 0], [100, 0], [100, 100]], 20, false, 5);
  for (let i = 2; i < smooth.length; i++) {
    const a = Math.atan2(smooth[i - 1][1] - smooth[i - 2][1], smooth[i - 1][0] - smooth[i - 2][0]);
    const b = Math.atan2(smooth[i][1] - smooth[i - 1][1], smooth[i][0] - smooth[i - 1][0]);
    assert.ok(Math.abs(b - a) < 0.25, 'no sharp kinks in a rounded path');
  }
});

test('lights come in whole point records', () => {
  const f = traffic.update(42, [-4600, 300, -2600], 5000, 4000);
  assert.ok(f.lights.length > 0);
  assert.equal(f.lights.length % 8, 0);
  assert.ok(f.lights.every(Number.isFinite));
});
