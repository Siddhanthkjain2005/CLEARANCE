// Architectural geometry complements the instanced city: actual river
// crossings, paved streets, pitched house roofs, a recognisable skyline and
// a riverside promenade. One static lit mesh keeps the detail affordable.

import { Geo } from '../gl.ts';
import { clamp, v3, type Vec3 } from '../math.ts';
import { BUILDING_FLOATS, buildCity } from './city.ts';
import { CITY, WATER_LEVEL, heightAt, riverWidthAt, riverZ, shorelineDistance } from './terrain.ts';

const ASPHALT: Vec3 = [0.047, 0.056, 0.065];
const CONCRETE: Vec3 = [0.36, 0.36, 0.34];
const METAL: Vec3 = [0.36, 0.41, 0.44];
const STONE: Vec3 = [0.32, 0.31, 0.27];
const WHITE: Vec3 = [0.6, 0.59, 0.51];
const GLASS: Vec3 = [0.048, 0.11, 0.15];
const LAMP: Vec3 = [0.74, 0.48, 0.22];

export interface UrbanBridgeSite {
  x: number;
  centerZ: number;
  halfSpan: number;
  deckY: number;
  cableStayed: boolean;
}

/** Bridge aprons end on dry banks even when the river width changes. */
export function urbanBridgeSites(): UrbanBridgeSite[] {
  return [-6200, -5400, -4600, -3800].map((x) => {
    const centerZ = riverZ(x);
    const halfSpan = riverWidthAt(x) + 75;
    const deckY = Math.max(WATER_LEVEL + 16, heightAt(x, centerZ - halfSpan) + 2, heightAt(x, centerZ + halfSpan) + 2);
    return { x, centerZ, halfSpan, deckY, cableStayed: x === -4600 };
  });
}

function rod(g: Geo, a: Vec3, b: Vec3, radius: number, color: Vec3, sides = 6) {
  const axis = v3.norm(v3.sub(b, a));
  const u = v3.norm(v3.cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const v = v3.cross(axis, u);
  const rings: number[][] = [[], []];
  for (const [i, center] of [a, b].entries()) {
    for (let k = 0; k < sides; k++) {
      const angle = k * Math.PI * 2 / sides;
      const normal = v3.add(v3.scale(u, Math.cos(angle)), v3.scale(v, Math.sin(angle)));
      rings[i].push(g.vertex(v3.add(center, v3.scale(normal, radius)), normal, color, 0.4));
    }
  }
  for (let k = 0; k < sides; k++) g.quad(rings[0][k], rings[0][(k + 1) % sides], rings[1][(k + 1) % sides], rings[1][k]);
}

function lamp(g: Geo, x: number, y: number, z: number, side = 1) {
  rod(g, [x, y, z], [x, y + 7, z], 0.12, METAL);
  rod(g, [x, y + 6.8, z], [x + side * 1.6, y + 7.25, z], 0.09, METAL);
  g.box([x + side * 1.6 - 0.45, y + 7.18, z - 0.22], [x + side * 1.6 + 0.45, y + 7.38, z + 0.22], METAL, 0.35);
  g.box([x + side * 1.6 - 0.36, y + 7.17, z - 0.18], [x + side * 1.6 + 0.36, y + 7.19, z + 0.18], LAMP, 0.2, 0.25);
}

function strip(g: Geo, a: Vec3, b: Vec3, halfWidth: number, color: Vec3, lift = 0) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length * halfWidth;
  const nz = dx / length * halfWidth;
  g.face([[a[0] - nx, a[1] + lift, a[2] - nz], [a[0] + nx, a[1] + lift, a[2] + nz], [b[0] + nx, b[1] + lift, b[2] + nz], [b[0] - nx, b[1] + lift, b[2] - nz]], color, 0.16);
}

function road(g: Geo, a: Vec3, b: Vec3, width: number, height: (x: number, z: number) => number, motorway = false, skipWater = false) {
  const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const steps = Math.max(1, Math.ceil(length / 28));
  const n = v3.norm([-(b[2] - a[2]), 0, b[0] - a[0]]);
  for (let i = 0; i < steps; i++) {
    const p = v3.lerp(a, b, i / steps);
    const q = v3.lerp(a, b, (i + 1) / steps);
    if (skipWater && (shorelineDistance(p[0], p[2]) < 16 || shorelineDistance(q[0], q[2]) < 16)) continue;
    const deck = (point: Vec3) => Math.max(
      height(point[0], point[2]),
      heightAt(point[0] + n[0] * width / 2, point[2] + n[2] * width / 2) + 0.25,
      heightAt(point[0] - n[0] * width / 2, point[2] - n[2] * width / 2) + 0.25,
    );
    p[1] = deck(p);
    q[1] = deck(q);
    strip(g, p, q, width / 2 + 1.3, CONCRETE);
    strip(g, p, q, width / 2, ASPHALT, 0.035);
    if (i % 3 !== 2) {
      if (motorway) for (const lane of [-3.5, 3.5]) strip(g, v3.add(p, v3.scale(n, lane)), v3.add(q, v3.scale(n, lane)), 0.07, WHITE, 0.075);
      else strip(g, p, q, 0.07, WHITE, 0.075);
    }
    if (motorway) for (const side of [-1, 1]) {
      const offset = v3.scale(n, side * (width / 2 + 0.55));
      rod(g, v3.add(v3.add(p, offset), [0, 0.8, 0]), v3.add(v3.add(q, offset), [0, 0.8, 0]), 0.14, METAL, 4);
      if (i % 2 === 0) rod(g, v3.add(p, offset), v3.add(v3.add(p, offset), [0, 0.9, 0]), 0.09, METAL, 4);
    }
  }
}

function bridge(g: Geo, site: UrbanBridgeSite) {
  const { x, centerZ: z, halfSpan: span, deckY: y } = site;
  g.box([x - 14.5, y - 1.8, z - span], [x + 14.5, y + 0.22, z + span], CONCRETE, 0.12);
  strip(g, [x, y + 0.23, z - span], [x, y + 0.23, z + span], 10.4, ASPHALT);
  for (let zz = z - span + 6; zz < z + span - 6; zz += 18) strip(g, [x, y + 0.29, zz], [x, y + 0.29, zz + 9], 0.07, WHITE);
  for (const side of [-1, 1]) {
    const xx = x + side * 14;
    for (let zz = z - span; zz < z + span; zz += 14) {
      rod(g, [xx, y + 0.25, zz], [xx, y + 1.65, zz], 0.11, METAL, 4);
      rod(g, [xx, y + 1.55, zz], [xx, y + 1.55, Math.min(z + span, zz + 14)], 0.13, METAL, 4);
    }
    for (let zz = z - span + 15; zz < z + span - 10; zz += 48) lamp(g, x + side * 12.5, y + 0.25, zz, -side);
  }
  for (const zz of [z - span * 0.53, z + span * 0.53]) {
    g.box([x - 8, WATER_LEVEL - 3, zz - 3], [x + 8, y - 1.8, zz + 3], STONE, 0.18);
    g.box([x - 10, y - 3.8, zz - 4], [x + 10, y - 1.8, zz + 4], CONCRETE);
  }
  if (site.cableStayed) {
    for (const zz of [z - span * 0.32, z + span * 0.32]) {
      for (const side of [-1, 1]) {
        const xx = x + side * 13.2;
        g.box([xx - 1.5, y - 1.7, zz - 2.5], [xx + 1.5, y + 59, zz + 2.5], [0.52, 0.52, 0.49], 0.25);
        for (let step = 1; step <= 6; step++) for (const direction of [-1, 1]) {
          const endZ = clamp(zz + direction * step * 24, z - span + 3, z + span - 3);
          rod(g, [xx, y + 56 - step * 1.8, zz], [xx, y + 0.5, endZ], 0.32, [0.56, 0.57, 0.54], 4);
        }
      }
      g.box([x - 14.7, y + 46, zz - 2.2], [x + 14.7, y + 49, zz + 2.2], CONCRETE, 0.25);
    }
  }
  for (const side of [-1, 1]) {
    const startZ = z + side * span;
    const endZ = startZ + side * 360;
    const endHeight = heightAt(x, endZ) + 0.3;
    road(g, [x, y, startZ], [x, endHeight, endZ], 20.8, (_xx, zz) => Math.max(heightAt(x, zz) + 0.3, y + (endHeight - y) * Math.abs(zz - startZ) / 360));
  }
}

function landmark(g: Geo, x: number, z: number, w: number, d: number, h: number, base: number, seed: number) {
  const light: Vec3 = [0.37 + seed * 0.1, 0.39 + seed * 0.08, 0.4 + seed * 0.07];
  const top = base + h;
  // Closely spaced vertical fins and thin floor plates define real facade
  // rhythms; the existing instance supplies the continuous building core.
  for (const side of [-1, 1]) {
    const xx = x + side * (w / 2 + 0.035);
    const zz = z + side * (d / 2 + 0.035);
    const xFace: Vec3[] = [[xx, base + 4, z - d / 2], [xx, top - 1, z - d / 2], [xx, top - 1, z + d / 2], [xx, base + 4, z + d / 2]];
    const zFace: Vec3[] = [[x - w / 2, base + 4, zz], [x + w / 2, base + 4, zz], [x + w / 2, top - 1, zz], [x - w / 2, top - 1, zz]];
    g.face(side < 0 ? xFace.reverse() : xFace, GLASS, 0.85);
    g.face(side < 0 ? zFace.reverse() : zFace, GLASS, 0.85);
    for (let t = -w / 2 + 2; t < w / 2; t += 7) g.box([x + t, base + 4, zz - 0.25], [x + t + 0.3, top - 0.7, zz + 0.25], light, 0.4);
    for (let t = -d / 2 + 2; t < d / 2; t += 7) g.box([xx - 0.25, base + 4, z + t], [xx + 0.25, top - 0.7, z + t + 0.3], light, 0.4);
  }
  for (let yy = base + 5; yy < top; yy += 7.5) g.box([x - w / 2 - 0.22, yy, z - d / 2 - 0.22], [x + w / 2 + 0.22, yy + 0.25, z + d / 2 + 0.22], light, 0.3);
  g.box([x - w * 0.42, top, z - d * 0.42], [x + w * 0.42, top + h * 0.08, z + d * 0.42], [0.2 + seed * 0.05, 0.215 + seed * 0.04, 0.23], 0.45);
  // louvred plant: cooling towers and air handlers on the roof of the crown
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2 ? 0.2 : -0.2) * w;
    const oz = (i < 2 ? 0.2 : -0.2) * d;
    g.box([x + ox - 2.2, top + h * 0.08, z + oz - 1.6], [x + ox + 2.2, top + h * 0.08 + 2.4, z + oz + 1.6], [0.36, 0.37, 0.38], 0.4);
  }
  g.box([x - w * 0.22, top + h * 0.08, z - d * 0.22], [x + w * 0.22, top + h * 0.14, z + d * 0.22], [0.23, 0.29, 0.32], 0.65);
  if (seed > 0.55) rod(g, [x, top + h * 0.14, z], [x, top + h * 0.14 + 17, z], 0.4, METAL);
}

/** Plane trees along the riverside promenade (planted by vegetation.ts): x, z, seed. */
export function promenadeTrees(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const side of [-1, 1]) {
    for (let x = -6400; x <= -3300; x += 32) {
      if (Math.round((x + 6400) / 32) % 4 !== 0) continue;
      const z = riverZ(x) + side * (riverWidthAt(x) + 22);
      out.push([x, z + side * 7, ((x * 7) % 13 + 13) / 26]);
    }
  }
  return out;
}

export function buildUrbanStructures(): Geo {
  const g = new Geo();
  // the motorway itself is built by motorway.ts along the traffic's own centreline
  for (const site of urbanBridgeSites()) bridge(g, site);
  // Only main avenues need separate geometry; minor streets retain the
  // instanced/shader treatment, keeping the large city inexpensive.
  for (let row = -16; row <= 12; row += 4) {
    const z = CITY.z + row * 96 - 48;
    road(g, [CITY.x - 2300, 0, z], [CITY.x + 2100, 0, z], 14, (x, zz) => heightAt(x, zz) + 0.2, false, true);
  }
  for (let column = -16; column <= 12; column += 4) {
    const x = CITY.x + column * 130 - 65;
    road(g, [x, 0, CITY.z - 1800], [x, 0, CITY.z + 2200], 12, (xx, z) => heightAt(xx, z) + 0.2, false, true);
  }
  // (pitched house roofs are instanced: see houseRoofs in city.ts)
  const city = buildCity().buildings;
  const towers: number[][] = [];
  for (let i = 0; i < city.length; i += BUILDING_FLOATS) {
    const data = Array.from(city.slice(i, i + BUILDING_FLOATS));
    if (data[4] > 78) towers.push(data);
  }
  const foregroundScore = (b: number[]) => Math.hypot(b[0] + 4600, b[1] + 3000);
  towers.sort((a, b) => foregroundScore(a) - foregroundScore(b));
  for (const [x, z, w, d, h, seed, base] of towers.slice(0, 14)) landmark(g, x, z, w, d, h, base, seed);
  for (const side of [-1, 1]) {
    let previous: Vec3 | null = null;
    for (let x = -6400; x <= -3300; x += 32) {
      const z = riverZ(x) + side * (riverWidthAt(x) + 22);
      const point: Vec3 = [x, heightAt(x, z) + 0.25, z];
      if (previous) strip(g, previous, point, 2.5, STONE);
      if (Math.round((x + 6400) / 32) % 8 === 0) lamp(g, x, point[1], z + side * 3.5, -side);
      previous = point;
    }
  }
  return g;
}

export function buildUrbanLights(): number[] {
  const out: number[] = [];
  const light = (x: number, y: number, z: number) => out.push(x, y, z, LAMP[0], LAMP[1], LAMP[2], 1.15, 5.24);
  for (const { x, centerZ: z, halfSpan: span, deckY: y } of urbanBridgeSites()) {
    for (const side of [-1, 1]) for (let zz = z - span + 15; zz < z + span - 10; zz += 48) light(x + side * 10.9, y + 7.43, zz);
  }
  for (const side of [-1, 1]) for (let x = -6400; x <= -3300; x += 256) {
    const z = riverZ(x) + side * (riverWidthAt(x) + 22);
    light(x - side * 1.6, heightAt(x, z) + 7.43, z + side * 3.5);
  }
  return out;
}
