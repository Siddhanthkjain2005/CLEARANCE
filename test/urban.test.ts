// Protect the relationship between visible water, crossing geometry and
// motorway traffic, plus the static city's rendering budget and mesh format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { BUILDING_FLOATS, buildCity, motorwayAt } from '../src/web/engine/world/city.ts';
import { buildUrbanLights, buildUrbanStructures, urbanBridgeSites } from '../src/web/engine/world/urban.ts';
import { WATER_LEVEL, heightAt, riverWidthAt, shorelineDistance } from '../src/web/engine/world/terrain.ts';

test('physical bridges span changing river widths and land on dry banks', () => {
  const bridges = urbanBridgeSites();
  assert.equal(bridges.length, 4);
  assert.equal(bridges.filter((b) => b.cableStayed).length, 1);
  for (const bridge of bridges) {
    assert.ok(bridge.halfSpan > riverWidthAt(bridge.x) + 50);
    assert.ok(bridge.deckY >= WATER_LEVEL + 16, 'boats have a clear span');
    for (const side of [-1, 1]) {
      assert.ok(shorelineDistance(bridge.x, bridge.centerZ + side * bridge.halfSpan) > 35, 'bridge ends reach dry bank aprons');
    }
  }
});

test('urban architecture is a complete lit mesh within the static detail budget', () => {
  const geometry = buildUrbanStructures();
  assert.equal(geometry.data.length % LIT_STRIDE, 0);
  assert.equal(geometry.idx.length % 3, 0);
  assert.ok(geometry.count > 30_000, 'bridges, pitched roofs and streets have geometry');
  assert.ok(geometry.count < 150_000, 'detail stays affordable beside the instanced city');
  assert.ok(geometry.data.every(Number.isFinite));
  assert.ok(geometry.idx.every((index) => Number.isInteger(index) && index >= 0 && index < geometry.count));
  for (let i = 0; i < geometry.data.length; i += LIT_STRIDE) {
    const length = Math.hypot(geometry.data[i + 3], geometry.data[i + 4], geometry.data[i + 5]);
    assert.ok(length > 0.99 && length < 1.01, 'material lighting receives unit normals');
  }
});

test('urban lamps are stable physical emitters and city instances retain their format', () => {
  const lights = buildUrbanLights();
  assert.equal(lights.length % 8, 0);
  assert.ok(lights.length > 40 * 8);
  assert.ok(lights.every(Number.isFinite));
  assert.deepEqual(lights, buildUrbanLights());
  const city = buildCity();
  assert.equal(city.buildings.length, city.count * BUILDING_FLOATS);
  for (let i = 0; i < city.buildings.length; i += BUILDING_FLOATS) {
    assert.ok(shorelineDistance(city.buildings[i], city.buildings[i + 1]) > 0, 'buildings do not stand in the river');
  }
});

test('motorway headlights stay above the physical road across land and wet ground', () => {
  for (let step = 0; step <= 300; step++) for (const lane of [-5, 5]) {
    const point = motorwayAt(step / 300, lane);
    assert.ok(point.every(Number.isFinite));
    assert.ok(point[1] >= WATER_LEVEL + 1, 'traffic remains above water');
    assert.ok(point[1] > heightAt(point[0], point[2]) + 0.6, 'headlights sit above the road foundation');
    if (shorelineDistance(point[0], point[2]) < 0) assert.ok(point[1] >= WATER_LEVEL + 14, 'the crossing rises clear of the channel');
  }
});
