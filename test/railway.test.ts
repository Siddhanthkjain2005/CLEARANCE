// The railway runs on dry ground beside the motorway and outside the
// airfield; its trains keep to the rails and call at the airport station.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIT_STRIDE } from '../src/web/engine/gl.ts';
import { AIRPORT_STATION_X, TRACK, Train, buildRailway, buildRailwayLights, railLine } from '../src/web/engine/world/railway.ts';
import { AIRFIELD, shorelineDistance } from '../src/web/engine/world/terrain.ts';

const line = railLine();

function offLine(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

test('railway geometry is finite, indexed and inside its budget', () => {
  const g = buildRailway();
  assert.ok(g.count > 10_000 && g.count < 200_000, `${g.count} vertices`);
  assert.equal(g.idx.length % 3, 0);
  assert.ok(g.data.every(Number.isFinite));
  assert.ok(g.idx.every((i) => i >= 0 && i < g.count));
  for (let i = 0; i < g.data.length; i += LIT_STRIDE * 31) assert.ok(Math.abs(Math.hypot(g.data[i + 3], g.data[i + 4], g.data[i + 5]) - 1) < 1e-4);
  const lights = buildRailwayLights();
  assert.equal(lights.length % 8, 0);
});

test('the line keeps to dry ground and outside the airfield', () => {
  for (const [x, z] of line) {
    assert.ok(shorelineDistance(x, z) > 30, `wet ground at ${x.toFixed(0)}, ${z.toFixed(0)}`);
    if (x > AIRFIELD.x0 && x < AIRFIELD.x1) assert.ok(z < AIRFIELD.z0 - 100, 'outside the airfield boundary');
  }
});

test('trains stay on the tracks and stop at the airport station', () => {
  const train = new Train(0);
  let stoppedAtStation = false;
  let prev: number[] | null = null;
  for (let t = 0; t < train.period; t += 1) {
    const cars = train.cars(t);
    for (const c of cars) {
      const d = offLine(c.pose.x, c.pose.z);
      assert.ok(Math.abs(d - TRACK) < 0.6 || d < TRACK + 0.6, `car ${d.toFixed(2)} m from the centreline`);
    }
    if (cars.length === 4) {
      const now = cars.map((c) => c.pose.x);
      if (prev && Math.abs(now[0] - prev[0]) < 1e-6 && Math.abs((now[0] + now[3]) / 2 - AIRPORT_STATION_X) < 60) stoppedAtStation = true;
      prev = now;
    } else prev = null;
  }
  assert.ok(stoppedAtStation, 'the unit calls at the airport station');
});
