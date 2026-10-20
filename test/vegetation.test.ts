// Near trees wear leaf-spray cards, hedgerows follow the painted field
// boundaries, livestock and bales keep to their fields, and every city house
// gets a pitched roof. These catch broken atlas cells, cards that sample the
// wrong spray, hedges planted mid-field, cows in the wheat and roofs that
// float off their walls.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEAF_ATLAS_SIZE, LEAF_CELL, leafAtlas } from '../src/web/engine/world/foliage.ts';
import { SPECIES, TREE_VERTEX, buildForestMask, buildTreeMesh, placeFarmLife, placeTrees } from '../src/web/engine/world/vegetation.ts';
import { farmland, fieldDistrict, fieldEdge, fieldParcel, hash12, hedgeGap, hedgeLines } from '../src/web/engine/world/fields.ts';
import { FARM_FLOATS, FARM_KINDS } from '../src/web/engine/world/farmlife.ts';
import * as A from '../src/web/engine/models/animals.ts';
import { BUILDING_FLOATS, ROOF_FLOATS, buildCity, houseRoofs } from '../src/web/engine/world/city.ts';
import { CITY } from '../src/web/engine/world/terrain.ts';

test('the leaf atlas is deterministic, and every spray is leafy with sky between the leaves', () => {
  const a = leafAtlas();
  assert.equal(a.length, LEAF_ATLAS_SIZE * LEAF_ATLAS_SIZE * 4);
  assert.deepEqual(a, leafAtlas(), 'the atlas is painted the same every time');
  const half = LEAF_ATLAS_SIZE / 2;
  for (const [kind, [col, row]] of Object.entries(LEAF_CELL)) {
    let cover = 0;
    let dark = 0;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const o = ((row * half + y) * LEAF_ATLAS_SIZE + col * half + x) * 4;
        cover += a[o + 3] / 255;
        if (a[o] === 0) dark++;
      }
    }
    cover /= half * half;
    assert.ok(cover > 0.15 && cover < 0.6, `${kind} spray covers ${(cover * 100).toFixed(0)}% of its cell`);
    assert.equal(dark, 0, `${kind}: transparent texels carry the leaf colour, so mipmaps do not darken`);
  }
  // nothing touches the cell borders, so mip levels do not bleed between sprays
  for (let i = 0; i < LEAF_ATLAS_SIZE; i++) {
    for (const j of [0, half - 1, half, LEAF_ATLAS_SIZE - 1]) {
      assert.equal(a[(j * LEAF_ATLAS_SIZE + i) * 4 + 3], 0, 'a spray reaches a cell border row');
      assert.equal(a[(i * LEAF_ATLAS_SIZE + j) * 4 + 3], 0, 'a spray reaches a cell border column');
    }
  }
});

test('near trees carry leaf cards in their own spray; far trees are lobes alone', () => {
  for (const species of SPECIES) {
    const near = buildTreeMesh(species, 0);
    const far = buildTreeMesh(species, 1);
    for (const mesh of [near, far]) {
      assert.equal(mesh.data.length % TREE_VERTEX, 0);
      assert.ok(mesh.data.every(Number.isFinite));
      const count = mesh.data.length / TREE_VERTEX;
      assert.ok(count < 65536 && mesh.indices.every((i) => i < count));
      for (let i = 0; i < mesh.data.length; i += TREE_VERTEX) {
        assert.ok(Math.abs(Math.hypot(mesh.data[i + 3], mesh.data[i + 4], mesh.data[i + 5]) - 1) < 1e-4, `${species}: unit normals`);
      }
    }
    const cards = (m: { data: Float32Array }) => {
      const out: number[] = [];
      for (let i = 0; i < m.data.length; i += TREE_VERTEX) if (m.data[i + 6] > 1.5) out.push(i);
      return out;
    };
    assert.equal(cards(far).length, 0, `${species}: the far LOD has no cards`);
    const near0 = cards(near);
    assert.ok(near0.length >= 4 * 40, `${species}: a near crown has dozens of cards (${near0.length / 4})`);
    const cell = species === 'birch' ? LEAF_CELL.birch : species === 'poplar' ? LEAF_CELL.poplar : species === 'pine' || species === 'spruce' ? LEAF_CELL.needle : LEAF_CELL.broadleaf;
    for (const i of near0) {
      const u = near.data[i + 8] * 2 - cell[0];
      const v = near.data[i + 9] * 2 - cell[1];
      assert.ok(u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6, `${species}: a card samples outside its spray`);
      const off = Math.hypot(near.data[i + 10], near.data[i + 11], near.data[i + 12]);
      assert.ok(off > 0.02 && off < 0.6, `${species}: card corners sit a sensible distance from the card centre`);
    }
  }
});

test('field geometry matches the shader: hedges stand on boundaries, never in gateways or on rough ground', () => {
  // the GLSL hash is "hash without sine"; spot values guard against a port slip
  assert.ok(Math.abs(hash12(0, 0) - 0) < 1e-12);
  const h = hash12(12.5, -3.25);
  assert.ok(h >= 0 && h < 1);
  assert.equal(hash12(12.5, -3.25), h);
  const district = fieldDistrict(1234, -567);
  assert.ok(district.scale >= 0.7 && district.scale <= 1.35);
  assert.ok(Math.abs(district.ang) <= Math.PI / 2);
  const box = { x0: -6000, z0: -3000, x1: -2000, z1: 1000 };
  const pts = hedgeLines(box, 9, () => true, () => true);
  assert.ok(pts.length > 500, `a stretch of farmland has hedges (${pts.length})`);
  assert.deepEqual(pts.slice(0, 50), hedgeLines(box, 9, () => true, () => true).slice(0, 50), 'repeatable');
  for (const p of pts) {
    assert.ok(p.x >= box.x0 && p.x <= box.x1 && p.z >= box.z0 && p.z <= box.z1);
    assert.ok(fieldEdge(p.x, p.z) < 0.5, `a hedge point ${fieldEdge(p.x, p.z).toFixed(2)} m off its field boundary`);
    assert.ok(!hedgeGap(p.x, p.z) && farmland(p.x, p.z) >= 0.6);
    assert.ok(fieldDistrict(p.x, p.z).border >= 9, 'no hedge on the country lanes');
  }
});

test('hedgerows run along the fields near the approach and keep clear of woods', () => {
  const mask = buildForestMask();
  const hedge = placeTrees(mask).find((s) => s.species === 'hedge')!;
  assert.ok(hedge.count > 5000, `hedgerows across the farmland (${hedge.count} lengths)`);
  for (let i = 0; i < hedge.count; i += 37) {
    const o = i * 8;
    const x = hedge.data[o];
    const z = hedge.data[o + 2];
    assert.ok(fieldEdge(x, z) < 1.5, 'each length of hedge stands on a field boundary');
    assert.ok(hedge.data[o + 5] >= 2 && hedge.data[o + 5] <= 4, 'hedges are two to four metres tall');
  }
});

test('every low-rise city house has a pitched roof sitting on its walls', () => {
  const city = buildCity();
  const roofs = houseRoofs(city);
  assert.equal(roofs.length % ROOF_FLOATS, 0);
  let houses = 0;
  for (let i = 0; i < city.buildings.length; i += BUILDING_FLOATS) {
    const h = city.buildings[i + 4];
    if (h > 4 && h < 10.5 && Math.hypot(city.buildings[i] - CITY.x, city.buildings[i + 1] - CITY.z) <= CITY.r * 1.25) houses++;
  }
  assert.equal(roofs.length / ROOF_FLOATS, houses);
  assert.ok(houses > 3000, 'the suburbs are roofed');
  for (let i = 0; i < roofs.length; i += ROOF_FLOATS) {
    const [x, z, w, d, eave, seed, rise, hip] = roofs.subarray(i, i + ROOF_FLOATS);
    assert.ok([x, z, w, d, eave, seed, rise, hip].every(Number.isFinite));
    assert.ok(rise >= 1.6 - 1e-5 && rise <= 4.8 + 1e-5, 'pitches between 30 and 45 degrees, within reason');
    assert.ok(hip === 0 || hip === 1);
    // at the wall line the roof surface meets the wall plate exactly
    const span = Math.min(w, d) + 0.9;
    const atWall = eave + (rise * 0.45) / (span / 2);
    const k = city.buildings.findIndex((_, j) => j % BUILDING_FLOATS === 0 && city.buildings[j] === x && city.buildings[j + 1] === z);
    assert.ok(k >= 0);
    assert.ok(Math.abs(atWall - (city.buildings[k + 6] + city.buildings[k + 4])) < 1e-3, 'the roof sits on the wall plate');
    if (i > ROOF_FLOATS * 400) break;
  }
});

test('bales lie on the stubble and livestock graze the grass, each group within its field', () => {
  const life = placeFarmLife(buildForestMask());
  for (const kind of FARM_KINDS) assert.equal(life[kind].length % FARM_FLOATS, 0);
  assert.ok(life.bale.length / FARM_FLOATS > 60, 'rows of straw bales on the stubble');
  assert.ok((life.cow.length + life.cowLying.length) / FARM_FLOATS > 150, 'herds of cattle');
  assert.ok(life.sheep.length / FARM_FLOATS > 300, 'flocks of sheep');
  for (const kind of FARM_KINDS) {
    const a = life[kind];
    for (let i = 0; i < a.length; i += FARM_FLOATS) {
      const p = fieldParcel(a[i], a[i + 2]);
      assert.ok(a.subarray(i, i + FARM_FLOATS).every(Number.isFinite));
      assert.ok(p.edge > 3.5, `a ${kind} stands in a hedge`);
      if (kind === 'bale') assert.ok(p.crop >= 0.68 && p.crop < 0.8, 'straw bales only on stubble');
      else assert.ok(p.crop < 0.34, `a ${kind} on a ${p.crop.toFixed(2)} crop rather than grass`);
    }
  }
  // the models themselves are closed, finite and small
  for (const g of [A.cow(), A.cowLying(), A.sheep(), A.roundBale(false), A.roundBale(true)]) {
    assert.ok(g.count > 20 && g.count < 3000);
    assert.ok(g.data.every(Number.isFinite));
    assert.ok(g.idx.every((i) => i >= 0 && i < g.count));
  }
});
