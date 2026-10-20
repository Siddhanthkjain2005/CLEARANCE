// Waterfront placement catches dry-land boats, flooded trees and broken
// normals before they create visible seams in the 3D scene.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShoreObjects, shoreObjects } from '../src/web/engine/world/shore.ts';
import { shorelineDistance, waterDepthAt } from '../src/web/engine/world/hydrology.ts';
import { AIRFIELD } from '../src/web/engine/world/terrain.ts';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';

test('waterfront trees stay on dry banks and outside airport movement areas', () => {
  const objects = shoreObjects();
  assert.deepEqual(objects, shoreObjects(), 'placements are repeatable');
  assert.ok(objects.filter((object) => object.kind === 'tree').length > 100);
  for (const object of objects) {
    if (object.kind === 'tree') {
      assert.ok(shorelineDistance(object.x, object.z) >= 8);
      assert.ok(object.x < AIRFIELD.x0 - 80 || object.x > AIRFIELD.x1 + 80 || object.z < AIRFIELD.z0 - 80 || object.z > AIRFIELD.z1 + 80);
    } else if (object.kind === 'boat') assert.ok(waterDepthAt(object.x, object.z) > 1, 'boats float inside the river');
  }
  assert.ok(objects.some((object) => object.kind === 'dock'));
});

test('waterfront vegetation, boats and docks have valid real geometry', () => {
  const geometry = buildShoreObjects();
  assert.equal(geometry.data.length % LIT_STRIDE, 0);
  assert.ok(geometry.data.every(Number.isFinite));
  assert.ok(geometry.idx.every((index) => index >= 0 && index < geometry.count));
  for (let i = 0; i < geometry.data.length; i += LIT_STRIDE) {
    const normal = Math.hypot(geometry.data[i + 3], geometry.data[i + 4], geometry.data[i + 5]);
    assert.ok(Math.abs(normal - 1) < 1e-5);
  }
  assert.ok(geometry.count < 100_000, 'shore detail stays within a bounded static mesh');
});
