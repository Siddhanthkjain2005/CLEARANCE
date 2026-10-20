// The working landscape must be deterministic, well-formed geometry that
// stays out of the airfield, the approach corridor, the water and the city,
// and its obstruction lights must sit on real structures.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { GATES, RUNWAY } from '../src/web/engine/path.ts';
import { WINDSOCKS, buildCountryside, buildCountrysideLights, buildRotor, turbines, windsocks } from '../src/web/engine/world/countryside.ts';
import { AIRFIELD, CITY, heightAt } from '../src/web/engine/world/terrain.ts';
import { shorelineDistance } from '../src/web/engine/world/hydrology.ts';

const land = buildCountryside();

test('countryside geometry is complete, finite and lit with unit normals', () => {
  assert.ok(land.count > 50_000, 'the landscape contains modelled structures');
  assert.ok(land.count < 600_000, 'the landscape stays inside its vertex budget');
  assert.equal(land.data.length % LIT_STRIDE, 0);
  assert.equal(land.idx.length % 3, 0);
  assert.ok(land.data.every(Number.isFinite));
  assert.ok(land.idx.every((i) => i >= 0 && i < land.count));
  for (let i = 0; i < land.data.length; i += LIT_STRIDE * 97) {
    assert.ok(Math.abs(Math.hypot(land.data[i + 3], land.data[i + 4], land.data[i + 5]) - 1) < 1e-4);
  }
});

test('the landscape is the same on every load', () => {
  const again = buildCountryside();
  assert.equal(again.count, land.count);
  assert.deepEqual(turbines(), turbines());
});

test('wind turbines stand on dry, open ground away from the airfield, the city and the approach', () => {
  const list = turbines();
  assert.ok(list.length >= 10, 'a wind farm, not a lone turbine');
  for (const t of list) {
    const [x, y, z] = t.hub;
    assert.ok(!(x > AIRFIELD.x0 - 300 && x < AIRFIELD.x1 + 300 && z > AIRFIELD.z0 - 300 && z < AIRFIELD.z1 + 300), 'clear of the airfield');
    assert.ok(Math.hypot(x - CITY.x, z - CITY.z) > CITY.r, 'clear of the city');
    assert.ok(shorelineDistance(x, z) > 100, 'on dry land');
    assert.ok(Math.abs(y - heightAt(x, z) - 96) < 1e-6, 'the hub sits at hub height above the ground');
    for (const g of GATES) assert.ok(Math.hypot(x - g[0], z - g[2]) > 1500, 'outside the approach');
    for (const o of list) if (o !== t) assert.ok(Math.hypot(x - o.hub[0], z - o.hub[2]) >= 520, 'turbines keep wake spacing');
  }
});

test('a rotor is three blades around a hub, and obstruction lights mark tall structures', () => {
  const rotor = buildRotor();
  let reach = 0;
  for (let i = 0; i < rotor.data.length; i += LIT_STRIDE) reach = Math.max(reach, Math.hypot(rotor.data[i + 1], rotor.data[i + 2]));
  assert.ok(reach > 50 && reach < 62, `blade length ${reach.toFixed(1)} m`);
  const lights = buildCountrysideLights();
  assert.equal(lights.length % 8, 0);
  for (let i = 0; i < lights.length; i += 8) {
    assert.ok(lights[i + 1] > heightAt(lights[i], lights[i + 2]) + 50, 'every obstruction light is high on a structure');
    assert.ok(lights[i + 3] > 0.9 && lights[i + 4] < 0.2, 'obstruction lights are red');
  }
  assert.ok(RUNWAY.x1 > RUNWAY.x0);
});

test('windsocks stream downwind from their masts and move with the gusts', () => {
  const a = windsocks(0);
  const b = windsocks(2.3);
  assert.equal(a.count, b.count, 'the same cloth, re-posed');
  assert.ok(a.data.every(Number.isFinite) && a.idx.every((i) => i >= 0 && i < a.count));
  let moved = 0;
  for (let i = 0; i < a.data.length; i += LIT_STRIDE) {
    moved = Math.max(moved, Math.abs(a.data[i + 1] - b.data[i + 1]));
    // every vertex flies east of its mast (the wind is westerly)
    const mast = WINDSOCKS.reduce((best, w) => (Math.abs(w[0] - a.data[i]) < Math.abs(best[0] - a.data[i]) ? w : best));
    assert.ok(a.data[i] > mast[0] - 0.6 && a.data[i] < mast[0] + 4.5);
  }
  assert.ok(moved > 0.05, 'the socks are alive');
});
