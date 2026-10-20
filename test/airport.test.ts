// Architecture checks protect flight clearances and the shared stand/road
// layout while permitting richer roofs, equipment and terminal geometry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE, type Geo } from '../src/web/engine/gl.ts';
import { RUNWAY, TAXIWAY_Z } from '../src/web/engine/path.ts';
import { PARKING_COURTS, STANDS, TERMINAL, TOWER, buildAirportLights, buildAirportStructures, buildSurfaces } from '../src/web/engine/world/airport.ts';
import { buildServiceArchitecture, buildTerminalArchitecture, buildTowerArchitecture } from '../src/web/engine/world/architecture.ts';
import { groundPropPlacements } from '../src/web/engine/world/props.ts';

function bounds(g: Geo) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.data.length; i += LIT_STRIDE) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], g.data[i + axis]);
    max[axis] = Math.max(max[axis], g.data[i + axis]);
  }
  return { min, max };
}

function valid(g: Geo) {
  assert.equal(g.data.length % LIT_STRIDE, 0);
  assert.equal(g.idx.length % 3, 0);
  assert.ok(g.data.every(Number.isFinite));
  assert.ok(g.idx.every((i) => Number.isInteger(i) && i >= 0 && i < g.count));
  for (let i = 0; i < g.data.length; i += LIT_STRIDE) assert.ok(Math.abs(Math.hypot(g.data[i + 3], g.data[i + 4], g.data[i + 5]) - 1) < 1e-5);
  for (let i = 0; i < g.idx.length; i += 3) {
    const a = g.idx[i] * LIT_STRIDE, b = g.idx[i + 1] * LIT_STRIDE, c = g.idx[i + 2] * LIT_STRIDE;
    const ux = g.data[b] - g.data[a], uy = g.data[b + 1] - g.data[a + 1], uz = g.data[b + 2] - g.data[a + 2];
    const vx = g.data[c] - g.data[a], vy = g.data[c + 1] - g.data[a + 1], vz = g.data[c + 2] - g.data[a + 2];
    assert.ok(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 1e-8, 'architectural triangles have visible area');
  }
}

test('terminal has a raised headhouse and vaulted concourses inside the shared footprint', () => {
  const g = buildTerminalArchitecture(TERMINAL);
  valid(g);
  const b = bounds(g);
  assert.ok(b.min[0] >= TERMINAL.x0 - 2 && b.max[0] <= TERMINAL.x1 + 2);
  assert.ok(b.min[2] >= TERMINAL.z0 - 4 && b.max[2] <= TERMINAL.z1 + 19);
  assert.ok(b.max[1] > 30 && b.max[1] < 40, 'a metre-scale headhouse rises above the lower concourses');
  for (const stand of STANDS) {
    const x = stand.x + 4.6;
    let connects = false;
    for (let i = 0; i < g.idx.length; i += 3) {
      const tri = [g.idx[i], g.idx[i + 1], g.idx[i + 2]].map((j) => g.data.slice(j * LIT_STRIDE, j * LIT_STRIDE + 3));
      if (tri.every((p) => Math.abs(p[2] - TERMINAL.z0) < 0.2)
        && Math.min(...tri.map((p) => p[0])) <= x && Math.max(...tri.map((p) => p[0])) >= x
        && Math.min(...tri.map((p) => p[1])) <= 5.5 && Math.max(...tri.map((p) => p[1])) >= 5.5) connects = true;
    }
    assert.ok(connects, 'every existing jetbridge terminates at the gate concourse');
  }
});

test('gate roof arches remain visible from the apron instead of forming a flat frontage', () => {
  const g = buildTerminalArchitecture(TERMINAL);
  const roofAt = (x: number) => {
    let high = -Infinity;
    for (let i = 0; i < g.data.length; i += LIT_STRIDE) if (Math.abs(g.data[i] - x) < 0.5 && Math.abs(g.data[i + 2] - (TERMINAL.z0 - 3)) < 0.5) high = Math.max(high, g.data[i + 1]);
    return high;
  };
  const eave = roofAt(TERMINAL.x0 + 1.2);
  const peak = roofAt(TERMINAL.x0 + 39);
  assert.ok(Number.isFinite(eave) && Number.isFinite(peak));
  assert.ok(peak - eave > 6, 'the first stand bay has a genuinely curved front-facing roof');
  assert.ok(peak < 25, 'concourse roofs remain below the central headhouse');
});

test('tower cab preserves the viewing position and carries its roof equipment', () => {
  const g = buildTowerArchitecture(TOWER);
  valid(g);
  assert.ok(bounds(g).max[1] >= TOWER.cab + 22);
  for (let i = 0; i < g.data.length; i += LIT_STRIDE) {
    const y = g.data[i + 1];
    if (y >= TOWER.cab - 2 && y < TOWER.cab + 6) assert.ok(Math.hypot(g.data[i] - TOWER.x, g.data[i + 2] - TOWER.z) < 13, 'the observation camera remains outside the glazed cab');
  }
});

test('terminal, jetbridges and operational buildings keep aircraft movement strips clear', () => {
  const g = buildAirportStructures();
  valid(g);
  assert.ok(g.count < 45_000, 'architectural detail remains one modest static mesh');
  valid(buildServiceArchitecture());
  for (let i = 0; i < g.data.length; i += LIT_STRIDE) {
    const x = g.data[i], z = g.data[i + 2];
    if (x >= RUNWAY.x0 && x <= RUNWAY.x1) {
      assert.ok(Math.abs(z) > RUNWAY.width / 2 + 30);
      assert.ok(Math.abs(z - TAXIWAY_Z) > 28);
    }
  }
  const surfaces = buildSurfaces();
  assert.equal(surfaces.data.length % 6, 0);
  assert.ok(Array.from(surfaces.data).every(Number.isFinite));
  assert.ok(Array.from(surfaces.indices).every((i) => i < surfaces.data.length / 6));
});

test('obstacle lights track the new hangar roofs rather than sitting inside them', () => {
  const lights = buildAirportLights();
  const campus = buildServiceArchitecture();
  for (let hangar = 0; hangar < 3; hangar++) {
    const x = -1090 + hangar * 150;
    let light = -1;
    for (let i = 0; i < lights.length; i += 8) if (lights[i] === x && lights[i + 2] === 425) light = i;
    assert.ok(light >= 0);
    assert.ok(lights[light + 1] > 24);
    let nearest = Infinity;
    for (let v = 0; v < campus.data.length; v += LIT_STRIDE) nearest = Math.min(nearest, Math.hypot(campus.data[v] - x, campus.data[v + 1] - lights[light + 1], campus.data[v + 2] - 425));
    assert.ok(nearest < 0.3, 'the light is mounted on a physical beacon');
  }
});

test('landside courts contain the occupied parking while retaining planted tree islands', () => {
  for (const prop of groundPropPlacements()) {
    const court = PARKING_COURTS.find((p) => prop.x >= p.x0 && prop.x <= p.x1 && prop.z >= p.z0 && prop.z <= p.z1);
    if (prop.kind === 'car' && prop.z > 620) assert.ok(court, 'parked cars belong to the connected paved courts');
    if (prop.kind === 'tree' && court) assert.ok(prop.x >= court.x0 + 54 && prop.x <= court.x0 + 68, 'trees inside parking have a planted island');
  }
  for (const court of PARKING_COURTS) assert.ok(court.z0 > TERMINAL.z1 + 70 && court.z1 < 810, 'parking remains behind the public access road and inside the perimeter');
});

test('the terminal glazing is flagged for lit interiors and stands vertical', () => {
  const g = buildTerminalArchitecture(TERMINAL);
  let glazing = 0;
  for (let i = 0; i < g.data.length; i += LIT_STRIDE) {
    const gloss = g.data[i + 9];
    if (gloss <= 1.5) continue;
    glazing++;
    assert.ok(gloss - 1 > 0.5 && gloss - 1 <= 1, 'a glazed face keeps a real gloss under its flag');
    assert.ok(Math.abs(g.data[i + 4]) < 0.05, 'interior mapping is for vertical glazing');
    assert.ok(g.data[i + 10] >= 3 && g.data[i + 10] <= 6, 'the storey height rides in the emissive channel');
  }
  assert.ok(glazing > 400, `the concourse and headhouse are glazed (${glazing} vertices)`);
});
