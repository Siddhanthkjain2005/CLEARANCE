// The villages scattered across the farmland: every cottage gets a pitched
// tile or slate roof with a chimney, each village a high street with
// lamps and a parish church with a tower and spire at its heart, and a green
// with a war memorial. The houses themselves are the city's instanced
// blocks; this module adds what makes a cluster of boxes read as a village.

import { Geo } from '../gl.ts';
import { clamp, rng, type Vec3 } from '../math.ts';
import { BUILDING_FLOATS, buildCity } from './city.ts';
import { CITY, heightAt, shorelineDistance } from './terrain.ts';

const ROOFS: Vec3[] = [[0.27, 0.1, 0.055], [0.22, 0.085, 0.05], [0.12, 0.13, 0.14], [0.3, 0.16, 0.09], [0.16, 0.15, 0.15]];
const STONE: Vec3 = [0.42, 0.39, 0.33];
const DARK_STONE: Vec3 = [0.3, 0.28, 0.24];
const ASPHALT: Vec3 = [0.06, 0.068, 0.075];
const WHITE: Vec3 = [0.62, 0.61, 0.56];
const GREEN: Vec3 = [0.1, 0.16, 0.06];
const LEAD: Vec3 = [0.26, 0.28, 0.3];
const LAMP: Vec3 = [0.95, 0.66, 0.32];

export interface Village {
  x: number;
  z: number;
  /** Half length of the high street along x. */
  half: number;
  houses: number[][];
}

/** Village houses are the low buildings well outside the city; clusters become villages. */
export function villages(): Village[] {
  const b = buildCity().buildings;
  const houses: number[][] = [];
  for (let i = 0; i < b.length; i += BUILDING_FLOATS) {
    const x = b[i];
    const z = b[i + 1];
    if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 1.25) continue;
    houses.push(Array.from(b.slice(i, i + BUILDING_FLOATS)));
  }
  const out: Village[] = [];
  for (const h of houses) {
    let v = out.find((c) => Math.abs(c.z - h[1]) < 80 && Math.abs(c.x - h[0]) < 950);
    if (!v) {
      v = { x: h[0], z: h[1], half: 0, houses: [] };
      out.push(v);
    }
    v.houses.push(h);
  }
  for (const v of out) {
    const xs = v.houses.map((h) => h[0]);
    const zs = v.houses.map((h) => h[1]);
    v.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    v.z = zs.reduce((a, b2) => a + b2, 0) / zs.length;
    v.half = (Math.max(...xs) - Math.min(...xs)) / 2 + 18;
  }
  return out.filter((v) => v.houses.length >= 4);
}

function roof(g: Geo, x: number, z: number, w: number, d: number, y: number, seed: number) {
  const ridgeAlongZ = d >= w;
  const span = ridgeAlongZ ? w : d;
  const hw = w / 2 + 0.4;
  const hd = d / 2 + 0.4;
  const ridge = y + clamp(span * 0.42, 2.2, 4.8);
  const color = ROOFS[Math.floor(seed * 97) % ROOFS.length];
  const gable: Vec3 = seed > 0.5 ? [0.55, 0.5, 0.42] : [0.44, 0.36, 0.28];
  if (ridgeAlongZ) {
    g.face([[x - hw, y, z + hd], [x, ridge, z + hd], [x, ridge, z - hd], [x - hw, y, z - hd]], color, 0.12);
    g.face([[x, ridge, z + hd], [x + hw, y, z + hd], [x + hw, y, z - hd], [x, ridge, z - hd]], color, 0.12);
    g.face([[x + hw - 0.4, y, z - hd + 0.4], [x - hw + 0.4, y, z - hd + 0.4], [x, ridge - 0.3, z - hd + 0.4]], gable, 0.1);
    g.face([[x - hw + 0.4, y, z + hd - 0.4], [x + hw - 0.4, y, z + hd - 0.4], [x, ridge - 0.3, z + hd - 0.4]], gable, 0.1);
  } else {
    g.face([[x - hw, y, z - hd], [x - hw, ridge, z], [x + hw, ridge, z], [x + hw, y, z - hd]], color, 0.12);
    g.face([[x - hw, ridge, z], [x - hw, y, z + hd], [x + hw, y, z + hd], [x + hw, ridge, z]], color, 0.12);
    g.face([[x - hw + 0.4, y, z + hd - 0.4], [x - hw + 0.4, y, z - hd + 0.4], [x - hw + 0.4, ridge - 0.3, z]], gable, 0.1);
    g.face([[x + hw - 0.4, y, z - hd + 0.4], [x + hw - 0.4, y, z + hd - 0.4], [x + hw - 0.4, ridge - 0.3, z]], gable, 0.1);
  }
  // a chimney stack on most cottages
  if (seed > 0.25) {
    const cx = x + (ridgeAlongZ ? w * 0.18 : (seed - 0.5) * w * 0.6);
    const cz = z + (ridgeAlongZ ? (seed - 0.5) * d * 0.6 : d * 0.18);
    g.box([cx - 0.45, y, cz - 0.45], [cx + 0.45, ridge + 1.0, cz + 0.45], seed > 0.6 ? [0.35, 0.16, 0.1] : DARK_STONE, 0.15);
  }
}

/** A parish church: nave and chancel with steep roofs, a west tower and a lead spire. */
function church(g: Geo, x: number, z: number, y: number) {
  // nave along x, tower at the west end (-x)
  g.box([x - 12, y - 0.5, z - 5], [x + 10, y + 8, z + 5], STONE, 0.12);
  g.face([[x - 12, y + 8, z - 5.4], [x - 12, y + 13, z], [x + 10, y + 13, z], [x + 10, y + 8, z - 5.4]], ROOFS[2], 0.15);
  g.face([[x - 12, y + 13, z], [x - 12, y + 8, z + 5.4], [x + 10, y + 8, z + 5.4], [x + 10, y + 13, z]], ROOFS[2], 0.15);
  g.face([[x + 10, y + 8, z - 5], [x + 10, y + 8, z + 5], [x + 10, y + 12.6, z]], STONE, 0.12);
  // chancel
  g.box([x + 10, y - 0.5, z - 3.6], [x + 17, y + 6.5, z + 3.6], STONE, 0.12);
  g.face([[x + 10, y + 6.5, z - 3.9], [x + 10, y + 10.2, z], [x + 17, y + 10.2, z], [x + 17, y + 6.5, z - 3.9]], ROOFS[2], 0.15);
  g.face([[x + 10, y + 10.2, z], [x + 10, y + 6.5, z + 3.9], [x + 17, y + 6.5, z + 3.9], [x + 17, y + 10.2, z]], ROOFS[2], 0.15);
  g.face([[x + 17, y + 6.5, z - 3.6], [x + 17, y + 6.5, z + 3.6], [x + 17, y + 10, z]], STONE, 0.12);
  // tall lancet windows, faintly lit from inside
  for (const side of [-1, 1]) for (let wx = x - 9; wx < x + 9; wx += 4.5) {
    const zz = z + side * 5.02;
    const q: Vec3[] = [[wx, y + 2, zz], [wx + 1.2, y + 2, zz], [wx + 1.2, y + 6, zz], [wx, y + 6, zz]];
    g.face(side > 0 ? q : q.reverse(), [0.85, 0.62, 0.32], 0.4, 0.18);
  }
  // tower with buttresses, belfry openings, battlements and spire
  const t0 = x - 19;
  g.box([t0, y - 0.5, z - 3.5], [t0 + 7, y + 21, z + 3.5], STONE, 0.12);
  for (const [bx, bz] of [[t0 - 0.6, z - 4.1], [t0 + 6.4, z - 4.1], [t0 - 0.6, z + 3.5], [t0 + 6.4, z + 3.5]] as [number, number][]) {
    g.box([bx, y - 0.5, bz], [bx + 1.2, y + 12, bz + 0.6], DARK_STONE, 0.12);
  }
  for (const side of [-1, 1]) {
    const q: Vec3[] = [[t0 + 2.4, y + 15.5, z + side * 3.52], [t0 + 4.6, y + 15.5, z + side * 3.52], [t0 + 4.6, y + 19, z + side * 3.52], [t0 + 2.4, y + 19, z + side * 3.52]];
    g.face(side > 0 ? q : q.reverse(), [0.04, 0.04, 0.045], 0.2);
  }
  for (let k = 0; k < 4; k++) {
    const bx = t0 + (k % 2) * 6;
    const bz = z - 3.5 + Math.floor(k / 2) * 6;
    g.box([bx, y + 21, bz], [bx + 1, y + 22.4, bz + 1], STONE, 0.12);
  }
  const apex: Vec3 = [t0 + 3.5, y + 36, z];
  const base: Vec3[] = [[t0 + 0.6, y + 21, z - 2.9], [t0 + 6.4, y + 21, z - 2.9], [t0 + 6.4, y + 21, z + 2.9], [t0 + 0.6, y + 21, z + 2.9]];
  for (let k = 0; k < 4; k++) g.face([base[k], base[(k + 1) % 4], apex], LEAD, 0.45);
  g.box([apex[0] - 0.05, apex[1], apex[2] - 0.05], [apex[0] + 0.05, apex[1] + 1.6, apex[2] + 0.05], [0.6, 0.48, 0.2], 0.7);
}

export function buildVillages(): Geo {
  const g = new Geo();
  const r = rng(515);
  for (const v of villages()) {
    // the high street through the middle, with a kerb line either side
    for (let x = v.x - v.half; x < v.x + v.half; x += 12) {
      const x1 = Math.min(v.x + v.half, x + 12);
      const ya = heightAt(x, v.z) + 0.12;
      const yb = heightAt(x1, v.z) + 0.12;
      g.face([[x, ya, v.z - 3.5], [x, ya, v.z + 3.5], [x1, yb, v.z + 3.5], [x1, yb, v.z - 3.5]], ASPHALT, 0.12);
      for (const side of [-1, 1]) g.face([[x, ya + 0.02, v.z + side * 3.3 - 0.06], [x, ya + 0.02, v.z + side * 3.3 + 0.06], [x1, yb + 0.02, v.z + side * 3.3 + 0.06], [x1, yb + 0.02, v.z + side * 3.3 - 0.06]], WHITE, 0.1);
    }
    for (const h of v.houses) {
      const [x, z, w, d, hh, seed, base] = h;
      roof(g, x, z, w, d, base + hh, seed);
    }
    // church and green at the far end of the street, on dry ground
    let cx = v.x + v.half + 34;
    if (shorelineDistance(cx, v.z + 22) < 60) cx = v.x - v.half - 40;
    const cz = v.z + 22;
    church(g, cx, cz, heightAt(cx, cz));
    const gy = heightAt(cx, v.z - 26) + 0.1;
    g.face([[cx - 22, gy, v.z - 40], [cx - 22, gy, v.z - 12], [cx + 22, gy, v.z - 12], [cx + 22, gy, v.z - 40]], GREEN, 0.05);
    g.box([cx - 0.8, gy, v.z - 27], [cx + 0.8, gy + 3.2, v.z - 25.4], WHITE, 0.2);
    // lamp posts along the street
    for (let x = v.x - v.half + 10; x < v.x + v.half; x += 38) {
      const side = r() < 0.5 ? -1 : 1;
      const lz = v.z + side * 4.4;
      const ly = heightAt(x, lz);
      g.box([x - 0.07, ly, lz - 0.07], [x + 0.07, ly + 6, lz + 0.07], [0.15, 0.16, 0.17], 0.4);
      g.box([x - 0.3, ly + 5.9, lz - 0.2], [x + 0.3, ly + 6.15, lz + 0.2], [0.15, 0.16, 0.17], 0.4);
      g.face([[x - 0.25, ly + 5.88, lz - 0.16], [x + 0.25, ly + 5.88, lz - 0.16], [x + 0.25, ly + 5.88, lz + 0.16], [x - 0.25, ly + 5.88, lz + 0.16]], LAMP, 0.3, 0.6);
    }
  }
  return g;
}

/** Tops of the cottage chimneys, where a thread of wood smoke rises at dusk. */
export function chimneyTops(): Vec3[] {
  const out: Vec3[] = [];
  for (const v of villages()) {
    for (const [x, z, w, d, hh, seed, base] of v.houses) {
      if (seed <= 0.25) continue;
      const y = base + hh;
      const ridgeAlongZ = d >= w;
      const span = ridgeAlongZ ? w : d;
      const ridge = y + clamp(span * 0.42, 2.2, 4.8);
      const cx = x + (ridgeAlongZ ? w * 0.18 : (seed - 0.5) * w * 0.6);
      const cz = z + (ridgeAlongZ ? (seed - 0.5) * d * 0.6 : d * 0.18);
      out.push([cx, ridge + 1.0, cz]);
    }
  }
  return out;
}

/** Street lamps and lit church windows as POINTS_VS records. */
export function buildVillageLights(): number[] {
  const out: number[] = [];
  const r = rng(515);
  for (const v of villages()) {
    for (let x = v.x - v.half + 10; x < v.x + v.half; x += 38) {
      const side = r() < 0.5 ? -1 : 1;
      const lz = v.z + side * 4.4;
      out.push(x, heightAt(x, lz) + 5.85, lz, LAMP[0], LAMP[1], LAMP[2], 1.0, 5.3);
    }
  }
  return out;
}
