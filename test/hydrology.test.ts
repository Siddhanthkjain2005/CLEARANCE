// Shorelines are shared by geometry, terrain carving and shader material.
// These checks prevent water from spilling into the airport or fine banks
// diverging from the surfaces they frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAKE, PONDS, WATER_LEVEL, buildWaterGeometry, lakeShoreDistance, lakeShorePoint, riverWidthAt, riverZ, shorelineDistance, waterDepthAt } from '../src/web/engine/world/hydrology.ts';
import { AIRFIELD, buildShoreTerrain, heightAt } from '../src/web/engine/world/terrain.ts';

test('river widens organically and both banks meet the terrain water plane', () => {
  const widths: number[] = [];
  for (let x = -28_000; x <= 28_000; x += 113) {
    const width = riverWidthAt(x), center = riverZ(x);
    widths.push(width);
    assert.ok(width >= 57 && width <= 149);
    assert.ok(waterDepthAt(x, center) > 0);
    for (const sign of [-1, 1]) {
      const z = center + width * sign;
      assert.ok(Math.abs(shorelineDistance(x, z)) < 1e-8);
      assert.ok(Math.abs(heightAt(x, z) - WATER_LEVEL) < 1e-8);
      assert.ok(waterDepthAt(x, z) < 1e-8);
      assert.ok(shorelineDistance(x, z + sign * 80) > 0);
      assert.ok(heightAt(x, z + sign * 80) > WATER_LEVEL);
    }
  }
  assert.ok(Math.max(...widths) - Math.min(...widths) > 65, 'river is not a constant-width strip');
});

test('irregular rotated basins have shared waterlines and continuously shallow banks', () => {
  for (const body of [LAKE, ...PONDS]) {
    assert.ok(waterDepthAt(body.x, body.z) > 2);
    const radii: number[] = [];
    for (let i = 0; i < 112; i++) {
      const angle = i / 112 * Math.PI * 2;
      const edge = lakeShorePoint(body, angle);
      radii.push(Math.hypot(edge[0] - body.x, edge[2] - body.z));
      assert.ok(Math.abs(lakeShoreDistance(body, edge[0], edge[2])) < 1e-8);
      assert.ok(Math.abs(heightAt(edge[0], edge[2]) - WATER_LEVEL) < 1e-8);
      const wet = lakeShorePoint(body, angle, -16);
      const dry = lakeShorePoint(body, angle, 16);
      assert.ok(waterDepthAt(wet[0], wet[2]) > 0);
      assert.equal(waterDepthAt(dry[0], dry[2]), 0);
      assert.ok(heightAt(wet[0], wet[2]) < WATER_LEVEL);
      assert.ok(heightAt(dry[0], dry[2]) > WATER_LEVEL);
    }
    assert.ok(Math.max(...radii) / Math.min(...radii) > 1.25, 'basins are not circular disks');
  }
  for (let x = AIRFIELD.x0; x <= AIRFIELD.x1; x += 100) {
    for (let z = AIRFIELD.z0; z <= AIRFIELD.z1; z += 100) {
      assert.equal(waterDepthAt(x, z), 0);
      assert.ok(shorelineDistance(x, z) > 65, 'banks keep clear of the flat airport');
    }
  }
});

test('water and detailed shoreline geometry are finite and consistently face up', () => {
  for (const [mesh, stride] of [[buildWaterGeometry(), 3], [buildShoreTerrain(80, 48), 6]] as const) {
    assert.equal(mesh.data.length % stride, 0);
    assert.equal(mesh.indices.length % 3, 0);
    assert.ok(mesh.data.every(Number.isFinite));
    assert.ok(mesh.indices.every((i) => i >= 0 && i < mesh.data.length / stride));
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i] * stride, b = mesh.indices[i + 1] * stride, c = mesh.indices[i + 2] * stride;
      const normalY = (mesh.data[b + 2] - mesh.data[a + 2]) * (mesh.data[c] - mesh.data[a]) - (mesh.data[b] - mesh.data[a]) * (mesh.data[c + 2] - mesh.data[a + 2]);
      assert.ok(normalY > 0, 'water and bank triangles face above the plane');
    }
    if (stride === 6) for (let i = 0; i < mesh.data.length; i += stride) {
      assert.ok(Math.abs(Math.hypot(mesh.data[i + 3], mesh.data[i + 4], mesh.data[i + 5]) - 1) < 1e-6);
    }
  }
  assert.throws(() => buildWaterGeometry(0), RangeError);
  assert.throws(() => buildWaterGeometry(32, 3), RangeError);
  assert.throws(() => buildShoreTerrain(0), RangeError);
});
