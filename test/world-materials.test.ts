// Ground geometry and the city lighting model must remain deterministic and
// physically bounded as procedural material detail changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIRFIELD, WATER_LEVEL, buildTerrain, heightAt, riverZ } from '../src/web/engine/world/terrain.ts';
import { BUILDING_FLOATS, buildCity, motorwayAt } from '../src/web/engine/world/city.ts';

test('terrain supplies finite positions and upward unit normals on an uneven grid', () => {
  const mesh = buildTerrain(42, 18_000);
  const count = 43 * 43;
  assert.ok(mesh.data instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.equal(mesh.data.length, count * 6);
  assert.equal(mesh.indices.length, 42 * 42 * 6);
  assert.ok(mesh.data.every(Number.isFinite));
  for (let i = 0; i < mesh.data.length; i += 6) {
    const [nx, ny, nz] = mesh.data.slice(i + 3, i + 6);
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-6);
    assert.ok(ny > 0, 'terrain normals face up');
  }
  assert.ok(mesh.indices.every((i) => i >= 0 && i < count));
  assert.deepEqual(buildTerrain(42, 18_000), mesh, 'world geometry is stable across reloads');
});

test('the airport stays level while the river is carved below its water plane', () => {
  for (let x = AIRFIELD.x0; x <= AIRFIELD.x1; x += 250) {
    for (let z = AIRFIELD.z0; z <= AIRFIELD.z1; z += 250) assert.ok(heightAt(x, z) === 0, 'airfield height stays zero');
  }
  for (let x = -8000; x <= 8000; x += 500) assert.ok(heightAt(x, riverZ(x)) < WATER_LEVEL);
  for (const resolution of [0, -1, 1.2, Number.NaN]) assert.throws(() => buildTerrain(resolution), RangeError);
  for (const radius of [0, -1, Number.POSITIVE_INFINITY]) assert.throws(() => buildTerrain(8, radius), RangeError);
});

test('city fixtures are stable small emitters and only aviation beacons flash', () => {
  const city = buildCity();
  assert.equal(city.buildings.length, city.count * BUILDING_FLOATS);
  assert.ok(city.count > 1000, 'city skyline uses real instanced building volumes');
  assert.ok(city.buildings.every(Number.isFinite));
  assert.equal(city.lights.length % 8, 0);
  assert.ok(city.lights.every(Number.isFinite));
  for (let i = 0; i < city.buildings.length; i += BUILDING_FLOATS) {
    assert.ok(city.buildings[i + 2] > 0 && city.buildings[i + 3] > 0 && city.buildings[i + 4] > 0);
    assert.ok(city.buildings[i + 6] >= WATER_LEVEL, 'building foundations remain on dry ground');
  }
  let fixtures = 0;
  for (let i = 0; i < city.lights.length; i += 8) {
    const kind = Math.floor(city.lights[i + 7]);
    assert.ok(kind === 4 || kind === 5, 'ordinary city lamps do not twinkle');
    assert.ok(city.lights[i + 6] <= 1.3, 'a metre-wide light does not become a giant bulb');
    if (kind === 5) {
      fixtures++;
      assert.ok(city.lights[i + 7] > 5 && city.lights[i + 7] < 5.4, 'fixture brightness is bounded');
    }
  }
  assert.ok(fixtures > 100);
  assert.deepEqual(buildCity(), city, 'building materials and lights are reproducible');
  for (const t of [-0.1, 0, 0.2, 0.99, 1.25]) assert.ok(motorwayAt(t, 3).every(Number.isFinite));
});
