// Ground detail must remain deterministic, within the rendering budget and
// clear of flight movement areas; luminous points need physical fixtures.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { RUNWAY, TAXIWAY_Z } from '../src/web/engine/path.ts';
import { STANDS, buildAirportLights, buildAirportStructures } from '../src/web/engine/world/airport.ts';
import { buildGroundPropLights, buildGroundProps, groundPropPlacements } from '../src/web/engine/world/props.ts';

const props = buildGroundProps();
const lights = buildGroundPropLights();

test('ground meshes have bounded, complete and finite geometry with usable normals', () => {
  assert.ok(props.count > 10_000, 'the environment contains modeled objects');
  assert.ok(props.count < 50_000, 'ground detail stays inside its vertex budget');
  assert.equal(props.data.length % LIT_STRIDE, 0);
  assert.equal(props.idx.length % 3, 0);
  assert.ok(props.data.every(Number.isFinite));
  assert.ok(props.idx.every((i) => Number.isInteger(i) && i >= 0 && i < props.count));
  for (let i = 0; i < props.data.length; i += LIT_STRIDE) {
    assert.ok(Math.abs(Math.hypot(props.data[i + 3], props.data[i + 4], props.data[i + 5]) - 1) < 1e-5, 'lighting receives unit normals');
    for (let material = 6; material <= 9; material++) assert.ok(props.data[i + material] >= 0 && props.data[i + material] <= 1);
    assert.ok(props.data[i + 10] >= 0);
  }
});

test('the seeded airport layout is repeatable and contains recognisable ground object families', () => {
  assert.deepEqual(groundPropPlacements(), groundPropPlacements());
  const repeated = buildGroundProps();
  assert.deepEqual(repeated.idx, props.idx);
  assert.deepEqual(repeated.data, props.data);
  const kinds = new Set<string>(groundPropPlacements().map((p) => p.kind));
  for (const kind of ['car', 'van', 'bus', 'tug', 'cart', 'container', 'tree', 'lamp', 'floodlight', 'bench']) assert.ok(kinds.has(kind));
});

test('vehicles, trees and furniture keep runway, taxiway and aircraft stand envelopes clear', () => {
  for (const p of groundPropPlacements()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.heading));
    if (p.x >= RUNWAY.x0 - 40 && p.x <= RUNWAY.x1 + 40) {
      assert.ok(Math.abs(p.z) > RUNWAY.width / 2 + 30, `${p.kind} cannot obstruct the runway`);
      assert.ok(Math.abs(p.z - TAXIWAY_Z) > 28, `${p.kind} cannot obstruct the parallel taxiway`);
    }
    for (const stand of STANDS) assert.ok(Math.abs(p.x - stand.x) >= 23 || Math.abs(p.z - stand.z) >= 29, `${p.kind} cannot intrude into an aircraft stand`);
  }
  // Ground roads and markings also stay out of the aircraft movement strip.
  for (let i = 0; i < props.data.length; i += LIT_STRIDE) {
    const x = props.data[i];
    const z = props.data[i + 2];
    if (x >= RUNWAY.x0 && x <= RUNWAY.x1) assert.ok(Math.abs(z) > RUNWAY.width / 2);
  }
});

test('ground point lights correspond to modeled fixtures rather than floating random sprites', () => {
  assert.equal(lights.length % 8, 0);
  assert.ok(lights.length > 0 && lights.every(Number.isFinite));
  for (let i = 0; i < lights.length; i += 8) {
    assert.ok(lights[i + 6] > 0 && lights[i + 6] <= 3, 'ground light size is in metres');
    let nearest = Infinity;
    for (let v = 0; v < props.data.length; v += LIT_STRIDE) {
      const dx = lights[i] - props.data[v];
      const dy = lights[i + 1] - props.data[v + 1];
      const dz = lights[i + 2] - props.data[v + 2];
      nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
    }
    assert.ok(nearest < 0.7 * 0.7, 'every luminous point has a physical fixture nearby');
  }
  const airportLights = buildAirportLights();
  for (let i = 0; i < airportLights.length; i += 8) assert.ok(airportLights[i + 2] < 580 || airportLights[i + 1] > 50, 'legacy floating car-park sprites were removed');
  const structures = buildAirportStructures();
  assert.ok(structures.data.every(Number.isFinite));
  assert.ok(structures.idx.every((i) => i >= 0 && i < structures.count));
});
