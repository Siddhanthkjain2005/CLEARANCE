// Natural waterfront objects give the analytic shoreline a physical scale.
// Vegetation stays on dry banks; docks and hulls meet the shared water plane.

import { Geo } from '../gl.ts';
import { rng, v3, type Vec3 } from '../math.ts';
import { heightAt, AIRFIELD, CITY } from './terrain.ts';
import { LAKE, PONDS, WATER_LEVEL, lakeShorePoint, riverWidthAt, riverZ, shorelineDistance } from './hydrology.ts';

export interface ShoreObject {
  kind: 'tree' | 'rock' | 'reeds' | 'boat' | 'dock';
  x: number;
  z: number;
  scale: number;
  variant: number;
}

export function shoreObjects(): ShoreObject[] {
  const random = rng(807);
  const objects: ShoreObject[] = [];
  const put = (kind: ShoreObject['kind'], x: number, z: number, scale: number, variant = 0) => objects.push({ kind, x, z, scale, variant });
  const naturalBank = (x: number, z: number) => {
    if (x > AIRFIELD.x0 - 80 && x < AIRFIELD.x1 + 80 && z > AIRFIELD.z0 - 80 && z < AIRFIELD.z1 + 80) return;
    if (shorelineDistance(x, z) < 8) return;
    put('tree', x, z, 0.8 + random() * 0.9, Math.floor(random() * 3));
    if (random() < 0.7) put('rock', x + 5, z - 4, 0.9 + random() * 1.8);
  };
  for (const body of [LAKE, ...PONDS]) {
    for (let i = 0; i < 42; i++) {
      const angle = i / 42 * Math.PI * 2;
      const point = lakeShorePoint(body, angle);
      const direction = v3.norm([point[0] - body.x, 0, point[2] - body.z]);
      if (i % 2 === 0) naturalBank(point[0] + direction[0] * 28, point[2] + direction[2] * 28);
      put('reeds', point[0] + direction[0] * 2, point[2] + direction[2] * 2, 1 + random() * 0.6);
    }
  }
  for (let x = -8500; x < 8000; x += 155) {
    for (const side of [-1, 1]) {
      const z = riverZ(x) + side * (riverWidthAt(x) + 38 + random() * 30);
      // The developed city waterfront is built by the urban geometry module.
      if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 0.90) continue;
      naturalBank(x, z);
      put('reeds', x + 16, riverZ(x + 16) + side * (riverWidthAt(x + 16) + 2), 1.2);
    }
  }
  put('dock', -4250, riverZ(-4250) + riverWidthAt(-4250) + 12, 1);
  put('boat', -4290, riverZ(-4290) + 32, 1, 0);
  put('boat', -5050, riverZ(-5050) - 25, 1.35, 1);
  return objects;
}

function ellipsoid(g: Geo, center: Vec3, radii: Vec3, color: Vec3, phase = 0, gloss = 0.12) {
  const rows = 5, sides = 9, indices: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const latitude = Math.PI * (0.02 + j / rows * 0.96);
    const ring: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const angle = k / sides * Math.PI * 2;
      const n: Vec3 = [Math.sin(latitude) * Math.cos(angle), Math.cos(latitude), Math.sin(latitude) * Math.sin(angle)];
      const irregular = 1 + Math.sin(k * 2.2 + j * 1.9 + phase) * 0.12;
      const p = v3.add(center, v3.scale(v3.mul(n, radii), irregular));
      ring.push(g.vertex(p, v3.norm([n[0] / radii[0], n[1] / radii[1], n[2] / radii[2]]), color, gloss));
    }
    indices.push(ring);
  }
  for (let j = 0; j < rows; j++) for (let k = 0; k < sides; k++) g.quad(indices[j][k], indices[j + 1][k], indices[j + 1][k + 1], indices[j][k + 1]);
}

function boat(g: Geo, x: number, z: number, scale: number, variant: number) {
  const y = WATER_LEVEL;
  const p = (a: number, b: number, c: number): Vec3 => [x + a * scale, y + b * scale, z + c * scale];
  const bottom = [p(-3.3, -0.6, -0.75), p(3.2, -0.6, -0.75), p(4.5, -0.45, 0), p(3.2, -0.6, 0.75), p(-3.3, -0.6, 0.75)];
  const rim = [p(-4.2, 0.75, -1.4), p(3.5, 0.75, -1.4), p(5, 0.75, 0), p(3.5, 0.75, 1.4), p(-4.2, 0.75, 1.4)];
  const hull: Vec3 = variant ? [0.16, 0.26, 0.27] : [0.61, 0.63, 0.58];
  for (let i = 0; i < 5; i++) g.face([bottom[i], bottom[(i + 1) % 5], rim[(i + 1) % 5], rim[i]], hull, 0.45);
  const deck = g.vertex(p(0, 0.76, 0), [0, 1, 0], [0.21, 0.16, 0.10], 0.15);
  const corners = rim.map((point) => g.vertex(point, [0, 1, 0], [0.21, 0.16, 0.10], 0.15));
  for (let i = 0; i < 5; i++) g.tri(deck, corners[(i + 1) % 5], corners[i]);
  g.box(p(-1.8, 0.78, -1.1), p(1.2, 2.5, 1.1), hull, 0.35);
  g.box(p(-1.65, 1.55, -1.12), p(1.05, 2.28, 1.12), [0.026, 0.063, 0.079], 0.9);
  g.box(p(-2, 2.45, -1.3), p(1.5, 2.7, 1.3), [0.64, 0.63, 0.58], 0.35);
  g.box(p(-1, 2.7, -0.07), p(-0.88, 5.6, 0.07), [0.26, 0.28, 0.28], 0.4);
  for (const side of [-1, 1]) for (const a of [-3, 2.6]) g.box(p(a, 0.68, side * 1.3 - 0.08), p(a + 0.3, 1.0, side * 1.3 + 0.08), [0.02, 0.025, 0.028]);
}

export function buildShoreObjects(): Geo {
  const g = new Geo();
  for (const object of shoreObjects()) {
    const { kind, x, z, scale, variant } = object;
    const y = heightAt(x, z);
    if (kind === 'tree') continue; // instanced with the other trees (vegetation.ts)
    else if (kind === 'rock') ellipsoid(g, [x, y + 0.25, z], [scale, scale * 0.6, scale * 0.8], [0.22, 0.235, 0.22], x * 0.1, 0.08);
    else if (kind === 'reeds') {
      const base = Math.max(WATER_LEVEL - 0.12, y);
      for (let k = 0; k < 7; k++) {
        const dx = Math.sin(k * 2.4) * 1.3, dz = Math.cos(k * 2.4) * 1.3;
        g.face([[x + dx, base, z + dz], [x + dx + 0.12, base, z + dz], [x + dx + 0.7, base + scale * (1.2 + k * 0.08), z + dz]], [0.17, 0.20, 0.079]);
        g.face([[x + dx, base, z + dz], [x + dx, base, z + dz + 0.12], [x + dx, base + scale * 1.4, z + dz + 0.6]], [0.20, 0.22, 0.093]);
      }
    } else if (kind === 'boat') boat(g, x, z, scale, variant);
    else {
      const deck = Math.max(WATER_LEVEL + 1.2, heightAt(x, z) + 0.3);
      for (let dz = -60; dz < 18; dz += 2) g.box([x - 3, deck - 0.28, z + dz], [x + 3, deck, z + dz + 1.85], [0.26, 0.19, 0.12], 0.1);
      for (let dz = -57; dz <= 15; dz += 12) for (const dx of [-2.7, 2.7]) g.box([x + dx - 0.18, WATER_LEVEL - 2, z + dz - 0.18], [x + dx + 0.18, deck + 0.75, z + dz + 0.18], [0.16, 0.13, 0.09]);
    }
  }
  return g;
}
