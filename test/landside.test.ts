// Villages and the landside campus: real geometry on dry ground, kept out
// of the woods and clear of the airport's roads.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { GARAGE, HOTEL, OFFICES, buildLandside, landsideBays } from '../src/web/engine/world/landside.ts';
import { buildVillages, chimneyTops, villages } from '../src/web/engine/world/villages.ts';
import { forestDensity } from '../src/web/engine/world/vegetation.ts';
import { heightAt, shorelineDistance } from '../src/web/engine/world/terrain.ts';
import { buildIndustry, buildIndustryLights, plumeSources, SHEDS, POWER } from '../src/web/engine/world/industry.ts';
import { buildMotorway, buildMotorwayLights } from '../src/web/engine/world/motorway.ts';
import { railLine } from '../src/web/engine/world/railway.ts';
import { MOTORWAY } from '../src/web/engine/world/city.ts';

for (const [name, build, budget] of [['villages', buildVillages, 120_000], ['landside', buildLandside, 150_000]] as const) {
  test(`${name} geometry is finite, indexed and inside its budget`, () => {
    const g = build();
    assert.ok(g.count > 1000 && g.count < budget, `${g.count} vertices`);
    assert.equal(g.idx.length % 3, 0);
    assert.ok(g.data.every(Number.isFinite));
    assert.ok(g.idx.every((i) => i >= 0 && i < g.count));
    for (let i = 0; i < g.data.length; i += LIT_STRIDE * 13) assert.ok(Math.abs(Math.hypot(g.data[i + 3], g.data[i + 4], g.data[i + 5]) - 1) < 1e-4);
  });
}

test('villages stand on dry ground with no woodland growing through them', () => {
  const list = villages();
  assert.ok(list.length >= 10, 'a countryside of villages');
  for (const v of list) {
    assert.ok(shorelineDistance(v.x, v.z) > 20);
    for (const h of v.houses) assert.equal(forestDensity(h[0], h[1]), 0, 'no trees through the houses');
  }
});

test('the landside campus sits between the perimeter road and the tree belts', () => {
  for (const b of [GARAGE, HOTEL, ...OFFICES]) {
    assert.ok(b.z0 > 832 + 50 && b.z1 < 975, 'clear of the road and the tree belts');
  }
  const bays = landsideBays();
  assert.ok(bays.length > 300);
  for (const b of bays) assert.ok(b.z > 880 && b.z < 970 && Number.isFinite(b.y));
});

for (const [name, build, budget] of [['industry', buildIndustry, 120_000], ['motorway', buildMotorway, 160_000]] as const) {
  test(`${name} geometry is finite, indexed and inside its budget`, () => {
    const g = build();
    assert.ok(g.count > 1000 && g.count < budget, `${g.count} vertices`);
    assert.equal(g.idx.length % 3, 0);
    assert.ok(g.data.every(Number.isFinite));
    assert.ok(g.idx.every((i) => i >= 0 && i < g.count));
    for (let i = 0; i < g.data.length; i += LIT_STRIDE * 17) assert.ok(Math.abs(Math.hypot(g.data[i + 3], g.data[i + 4], g.data[i + 5]) - 1) < 1e-4);
  });
}

test('industry keeps clear of the motorway, the railway and the water', () => {
  const near = (x: number, z: number, pts: [number, number][], d: number) => pts.some(([px, pz]) => Math.hypot(px - x, pz - z) < d);
  const rail = railLine();
  const road = MOTORWAY.map((p) => [p[0], p[2]] as [number, number]);
  for (const s of SHEDS) {
    for (const [cx, cz] of [[s.x - s.w / 2, s.z - s.d / 2 - 34], [s.x + s.w / 2, s.z - s.d / 2 - 34], [s.x, s.z + s.d / 2]] as [number, number][]) {
      assert.ok(!near(cx, cz, rail, 60), 'sheds and yards stand back from the railway');
      assert.ok(shorelineDistance(cx, cz) > 100);
    }
  }
  assert.ok(!near(POWER.x, POWER.z, road, 600));
  const lights = buildIndustryLights();
  assert.equal(lights.length % 8, 0);
  assert.ok(plumeSources().every((p) => p.pos.every(Number.isFinite) && p.rate > 0));
  assert.equal(buildMotorwayLights().length % 8, 0);
});

test('cottage chimneys rise above their roofs and stay inside their villages', () => {
  const tops = chimneyTops();
  assert.ok(tops.length > 50);
  const list = villages();
  for (const [x, y, z] of tops) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    const home = list.find((v) => Math.abs(v.z - z) < 120 && Math.abs(v.x - x) < v.half + 40);
    assert.ok(home, 'every chimney belongs to a village');
    assert.ok(y > heightAt(x, z) + 7, 'chimney tops stand above the ridge line');
  }
});
