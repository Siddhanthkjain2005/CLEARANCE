// Vegetation: where trees grow and what they look like.
//
// One forest-density field decides both the instanced 3D trees near the
// approach and the canopy colour the terrain shader paints beyond them, so a
// wood reads the same from the runway and from ten kilometres out. Trees also
// line the river and lakes, follow the motorway in windbreak rows, shade city
// streets, stand alone in pasture and fill a few orchards. They keep clear of
// water, roads, paving and the runway's protected surfaces.

import { fbm, rng, smoothstep, vnoise, type Vec3 } from '../math.ts';
import { AIRFIELD, CITY, LAKE, PONDS, heightAt, riverWidthAt, riverZ, shorelineDistance } from './terrain.ts';
import { BUILDING_FLOATS, MOTORWAY, buildCity } from './city.ts';
import { GATES, pointAt } from '../path.ts';
import { LEAF_CELL, type LeafKind } from './foliage.ts';
import { hedgeLines } from './fields.ts';
import { farmLife, type FarmKind } from './farmlife.ts';
import { groundPropPlacements } from './props.ts';
import { shoreObjects } from './shore.ts';
import { promenadeTrees } from './urban.ts';

/** Area the forest mask texture covers (metres). */
export const FOREST_RECT = { x0: -22000, z0: -16000, x1: 14000, z1: 16000 };
export const FOREST_RES = 1024;

/** Instance layout shared by every tree mesh: x y z rotation | width height tint seed. */
export const TREE_FLOATS = 8;

export type TreeSpecies = 'oak' | 'birch' | 'pine' | 'spruce' | 'poplar' | 'hedge';
export const SPECIES: TreeSpecies[] = ['oak', 'birch', 'pine', 'spruce', 'poplar', 'hedge'];

function inAirfield(x: number, z: number, pad: number) {
  return x > AIRFIELD.x0 - pad && x < AIRFIELD.x1 + pad && z > AIRFIELD.z0 - pad && z < AIRFIELD.z1 + pad;
}

/** Obstacle-free approach: nothing tall under the last few kilometres of final. */
function inApproachSurface(x: number, z: number) {
  return x < 200 && x > -4200 && Math.abs(z) < 220 + (-x) * 0.12;
}

function distToSegment2(px: number, pz: number, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / l2));
  const x = a[0] + dx * t - px;
  const z = a[2] + dz * t - pz;
  return x * x + z * z;
}

export function nearMotorway(x: number, z: number, pad: number): boolean {
  for (let i = 0; i < MOTORWAY.length - 1; i++) if (distToSegment2(x, z, MOTORWAY[i], MOTORWAY[i + 1]) < pad * pad) return true;
  return false;
}

/** Raw woodland density from noise and landform, before exclusions. */
function woodland(x: number, z: number): number {
  const n = fbm(x * 0.00085 + 4.2, z * 0.00085 - 1.7, 4);
  const detail = vnoise(x * 0.004 + 9.1, z * 0.004 - 3.3);
  let d = smoothstep(0.5, 0.6, n + (detail - 0.5) * 0.08);
  // hills keep their woods; the flood plain is farmed
  d *= 0.35 + 0.65 * smoothstep(-2000, 4000, z) + 0.4 * smoothstep(-9000, -14000, x);
  return Math.min(1, d);
}

/**
 * Villages are cleared of woodland: 60 m cells within reach of any house
 * outside the city (the houses come from the city's own layout).
 */
let villageGrid: Set<number> | null = null;
const VILLAGE_CELL = 60;
function inVillage(x: number, z: number): boolean {
  if (!villageGrid) {
    villageGrid = new Set<number>();
    const b = buildCity().buildings;
    for (let i = 0; i < b.length; i += BUILDING_FLOATS) {
      const hx = b[i];
      const hz = b[i + 1];
      if (Math.hypot(hx - CITY.x, hz - CITY.z) < CITY.r * 1.25) continue;
      const cx = Math.floor(hx / VILLAGE_CELL);
      const cz = Math.floor(hz / VILLAGE_CELL);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) villageGrid.add((cx + dx) * 100003 + (cz + dz));
    }
  }
  return villageGrid.has(Math.floor(x / VILLAGE_CELL) * 100003 + Math.floor(z / VILLAGE_CELL));
}

/** Final forest density at a point, 0..1. */
export function forestDensity(x: number, z: number): number {
  if (inAirfield(x, z, 260) || inApproachSurface(x, z)) return 0;
  if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 1.08) return 0;
  if (inVillage(x, z)) return 0;
  return woodland(x, z);
}

/** Forest density baked into a texture for the terrain shader (R = density). */
export function buildForestMask(): Uint8Array {
  const N = FOREST_RES;
  const out = new Uint8Array(N * N);
  const R = FOREST_RECT;
  for (let j = 0; j < N; j++) {
    const z = R.z0 + ((j + 0.5) / N) * (R.z1 - R.z0);
    for (let i = 0; i < N; i++) {
      const x = R.x0 + ((i + 0.5) / N) * (R.x1 - R.x0);
      let d = 0;
      if (!(inAirfield(x, z, 260) || inApproachSurface(x, z) || Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 1.08 || inVillage(x, z))) d = woodland(x, z);
      out[j * N + i] = Math.round(d * 255);
    }
  }
  return out;
}

function sampleMask(mask: Uint8Array, x: number, z: number): number {
  const R = FOREST_RECT;
  const u = ((x - R.x0) / (R.x1 - R.x0)) * FOREST_RES - 0.5;
  const v = ((z - R.z0) / (R.z1 - R.z0)) * FOREST_RES - 0.5;
  if (u < 0 || v < 0 || u >= FOREST_RES - 1 || v >= FOREST_RES - 1) return 0;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const at = (a: number, b: number) => mask[b * FOREST_RES + a] / 255;
  return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
}

/** Points along the approach, for focusing tree density where cameras look. */
const CORRIDOR: Vec3[] = (() => {
  const pts: Vec3[] = [];
  for (let p = -2; p <= 13; p += 0.25) pts.push(pointAt(p));
  pts.push([4200, 0, 600], [-1500, 0, 1800], [1500, 0, 2600], [3600, 0, -1500]);
  return pts;
})();

// distance to the corridor, precomputed on a coarse grid (placement only needs ~100 m accuracy)
const CD_CELL = 200;
const CD_BOX = { x0: -16000, z0: -12000, nx: 130, nz: 110 };
let corridorGrid: Float32Array | null = null;
function corridorDistance(x: number, z: number): number {
  if (!corridorGrid) {
    corridorGrid = new Float32Array(CD_BOX.nx * CD_BOX.nz);
    for (let j = 0; j < CD_BOX.nz; j++) {
      for (let i = 0; i < CD_BOX.nx; i++) {
        const cx = CD_BOX.x0 + (i + 0.5) * CD_CELL;
        const cz = CD_BOX.z0 + (j + 0.5) * CD_CELL;
        let best = Infinity;
        for (const p of CORRIDOR) best = Math.min(best, Math.hypot(cx - p[0], cz - p[2]));
        corridorGrid[j * CD_BOX.nx + i] = best;
      }
    }
  }
  const i = Math.floor((x - CD_BOX.x0) / CD_CELL);
  const j = Math.floor((z - CD_BOX.z0) / CD_CELL);
  if (i < 0 || j < 0 || i >= CD_BOX.nx || j >= CD_BOX.nz) return Infinity;
  return corridorGrid[j * CD_BOX.nx + i];
}

export interface TreeSet {
  species: TreeSpecies;
  data: Float32Array;
  count: number;
}

/** Every tree in the world, grouped by species. */
export function placeTrees(mask: Uint8Array): TreeSet[] {
  const r = rng(2024);
  const lists: Record<TreeSpecies, number[]> = { oak: [], birch: [], pine: [], spruce: [], poplar: [], hedge: [] };
  const clearOf = (x: number, z: number, water = 7, road = 18) =>
    !inAirfield(x, z, 120) && !inApproachSurface(x, z) && shorelineDistance(x, z) > water && !nearMotorway(x, z, road);
  const plant = (species: TreeSpecies, x: number, z: number, height: number, width: number, heading?: number) => {
    const y = heightAt(x, z) - 0.6;
    const tint = r();
    lists[species].push(x, y, z, heading ?? r() * Math.PI * 2, width, height, tint, r());
  };
  const broadleaf = (): TreeSpecies => (r() < 0.78 ? 'oak' : 'birch');

  // woods: dense near the approach and airport, thinning with distance
  const step = 19;
  const range = 3300;
  const box = { x0: -14500, x1: 7000, z0: -9000, z1: 6500 };
  for (let z = box.z0; z < box.z1; z += step) {
    for (let x = box.x0; x < box.x1; x += step) {
      const jx = x + (r() - 0.5) * step * 0.9;
      const jz = z + (r() - 0.5) * step * 0.9;
      const d = sampleMask(mask, jx, jz);
      if (d < 0.08) continue;
      const cd = corridorDistance(jx, jz);
      if (cd > range) continue;
      const keep = d * (1 - smoothstep(range * 0.55, range, cd) * 0.85);
      if (r() > keep) continue;
      if (!clearOf(jx, jz)) continue;
      // conifers on high and northern ground, broadleaf in the lowlands
      const high = heightAt(jx, jz);
      const conifer = r() < smoothstep(60, 260, high) * 0.8 + 0.12;
      const edge = d < 0.5 ? 0.85 : 1; // smaller trees along wood edges
      if (conifer) plant(r() < 0.6 ? 'spruce' : 'pine', jx, jz, (16 + r() * 12) * edge, 5 + r() * 2.5);
      else plant(broadleaf(), jx, jz, (13 + r() * 9) * edge, 8 + r() * 5);
    }
  }

  // Near the approach the woods close up: a second, offset pass doubles the
  // stem count where the cameras fly low, so crowns touch instead of dotting
  // the canopy painted underneath.
  for (let z = box.z0 + step / 2; z < box.z1; z += step) {
    for (let x = box.x0 + step / 2; x < box.x1; x += step) {
      const jx = x + (r() - 0.5) * step * 0.9;
      const jz = z + (r() - 0.5) * step * 0.9;
      const d = sampleMask(mask, jx, jz);
      if (d < 0.3) continue;
      const cd = corridorDistance(jx, jz);
      if (cd > 1900) continue;
      if (r() > d * (1 - smoothstep(1100, 1900, cd))) continue;
      if (!clearOf(jx, jz)) continue;
      const high = heightAt(jx, jz);
      const conifer = r() < smoothstep(60, 260, high) * 0.8 + 0.12;
      if (conifer) plant(r() < 0.6 ? 'spruce' : 'pine', jx, jz, 15 + r() * 11, 5 + r() * 2.5);
      else plant(broadleaf(), jx, jz, 12 + r() * 9, 8 + r() * 5);
    }
  }

  // ...and a third pass, offset again, closes the canopy where the cameras
  // come lowest: real woods have a tree every few metres, not every twenty.
  for (let z = box.z0 + step / 4; z < box.z1; z += step) {
    for (let x = box.x0 + (step * 3) / 4; x < box.x1; x += step) {
      const jx = x + (r() - 0.5) * step * 0.9;
      const jz = z + (r() - 0.5) * step * 0.9;
      const d = sampleMask(mask, jx, jz);
      if (d < 0.35) continue;
      const cd = corridorDistance(jx, jz);
      if (cd > 1500) continue;
      if (r() > d * (1 - smoothstep(900, 1500, cd))) continue;
      if (!clearOf(jx, jz)) continue;
      const high = heightAt(jx, jz);
      const conifer = r() < smoothstep(60, 260, high) * 0.8 + 0.12;
      if (conifer) plant(r() < 0.6 ? 'spruce' : 'pine', jx, jz, 14 + r() * 10, 5 + r() * 2.5);
      else plant(broadleaf(), jx, jz, 11 + r() * 8, 8 + r() * 5);
    }
  }

  // riparian woodland along both banks of the river
  for (let x = -14000; x < 7000; x += 9) {
    for (const side of [-1, 1]) {
      if (r() > 0.55) continue;
      const half = riverWidthAt(x);
      const off = half + 10 + Math.pow(r(), 1.8) * 55;
      const z = riverZ(x) + side * off;
      if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 0.75) continue;
      if (!clearOf(x, z, 6, 22)) continue;
      const kind = r();
      if (kind < 0.18) plant('poplar', x, z, 18 + r() * 8, 3.2 + r());
      else plant(kind < 0.55 ? 'birch' : 'oak', x, z, 10 + r() * 8, 7 + r() * 4);
    }
  }

  // lake and pond shores
  for (const body of [LAKE, ...PONDS]) {
    const rx = 'rx' in body ? body.rx : 1000;
    const rz = 'rz' in body ? body.rz : 800;
    const n = Math.round((rx + rz) * 0.32);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const spread = 1.06 + Math.pow(r(), 1.6) * 0.35;
      const x = body.x + Math.cos(a) * rx * spread;
      const z = body.z + Math.sin(a) * rz * spread;
      if (!clearOf(x, z, 8, 20)) continue;
      plant(r() < 0.3 ? 'birch' : r() < 0.15 ? 'poplar' : 'oak', x, z, 10 + r() * 9, 7 + r() * 4);
    }
  }

  // windbreak rows of poplar and roadside oaks along the motorway
  for (let i = 0; i < MOTORWAY.length - 1; i++) {
    const a = MOTORWAY[i];
    const b = MOTORWAY[i + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const nx = -(b[2] - a[2]) / len;
    const nz = (b[0] - a[0]) / len;
    const poplars = i % 2 === 0;
    for (let s = 0; s < len; s += poplars ? 11 : 17) {
      for (const side of [-1, 1]) {
        if (r() < 0.12) continue;
        const t = s / len;
        const x = a[0] + (b[0] - a[0]) * t + nx * side * (34 + r() * 4);
        const z = a[2] + (b[2] - a[2]) * t + nz * side * (34 + r() * 4);
        if (!clearOf(x, z, 8, 26)) continue;
        if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 0.9) continue;
        if (poplars) plant('poplar', x, z, 20 + r() * 6, 3 + r());
        else plant('oak', x, z, 11 + r() * 6, 8 + r() * 3);
      }
    }
  }

  // street trees in the residential grid and a few parks
  const BX = 130;
  const BZ = 96;
  for (let gx = -22; gx <= 22; gx++) {
    for (let gz = -30; gz <= 30; gz++) {
      const cx = CITY.x + gx * BX;
      const cz = CITY.z + gz * BZ;
      const dc = Math.hypot(cx - CITY.x, cz - CITY.z);
      if (dc > CITY.r * 1.02 || dc < 650) continue;
      for (let s = 8; s < BX - 8; s += 16) {
        if (r() < 0.4) continue;
        const x = cx - BX / 2 + s;
        const z = cz - BZ / 2 + (r() < 0.5 ? -6.5 : 6.5);
        if (shorelineDistance(x, z) < 10) continue;
        plant(r() < 0.7 ? 'oak' : 'birch', x, z, 8 + r() * 5, 5 + r() * 2.5);
      }
    }
  }

  // garden trees: behind and beside the low-rise houses, clear of every roof
  {
    const city = buildCity();
    const B = city.buildings;
    const F = BUILDING_FLOATS;
    const cell = 40;
    const grid = new Map<number, number[]>();
    const key = (cx: number, cz: number) => cx * 100003 + cz;
    for (let i = 0; i < city.count; i++) {
      const k = key(Math.floor(B[i * F] / cell), Math.floor(B[i * F + 1] / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    const blocked = (x: number, z: number, pad: number) => {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const i of grid.get(key(cx + dx, cz + dz)) ?? []) {
            if (Math.abs(x - B[i * F]) < B[i * F + 2] / 2 + pad && Math.abs(z - B[i * F + 1]) < B[i * F + 3] / 2 + pad) return true;
          }
        }
      }
      return false;
    };
    for (let i = 0; i < city.count; i++) {
      if (B[i * F + 4] > 13 || r() > 0.62) continue;
      const bx = B[i * F];
      const bz = B[i * F + 1];
      for (let t = 0; t < 2; t++) {
        const side = r() < 0.5 ? -1 : 1;
        const across = r() < 0.6;
        const off = (across ? B[i * F + 3] : B[i * F + 2]) / 2 + 4 + r() * 5;
        const x = bx + (across ? (r() - 0.5) * B[i * F + 2] : side * off);
        const z = bz + (across ? side * off : (r() - 0.5) * B[i * F + 3]);
        if (blocked(x, z, 2.5) || shorelineDistance(x, z) < 10 || nearMotorway(x, z, 16)) continue;
        plant(r() < 0.65 ? 'oak' : r() < 0.6 ? 'birch' : 'spruce', x, z, 6 + r() * 7, 4 + r() * 3.5);
      }
    }
  }

  // lone field trees and hedgerow oaks across the farmland
  for (let i = 0; i < 2600; i++) {
    const x = -13000 + r() * 20000;
    const z = -8000 + r() * 14000;
    if (sampleMask(mask, x, z) > 0.05) continue;
    if (corridorDistance(x, z) > 4500) continue;
    if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 1.1) continue;
    if (!clearOf(x, z, 10, 30)) continue;
    // clumps: a few trees around each seed point
    const n = r() < 0.45 ? 1 : 2 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const tx = x + (r() - 0.5) * 26;
      const tz = z + (r() - 0.5) * 26;
      if (!clearOf(tx, tz, 10, 30)) continue;
      plant(r() < 0.85 ? 'oak' : 'birch', tx, tz, 11 + r() * 10, 12 + r() * 8);
    }
  }

  // orchards: neat rows of small round trees beside the villages
  const orchards = [[-2600, 2300, 0.4], [4800, 1900, -0.2], [-7600, 1200, 0.15], [2200, -2600, 0.6]];
  for (const [ox, oz, ang] of orchards) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 14; j++) {
        const u = (i - 13) * 7;
        const v = (j - 7) * 8;
        const x = ox + u * c - v * s;
        const z = oz + u * s + v * c;
        if (!clearOf(x, z, 8, 20) || r() < 0.04) continue;
        plant('oak', x, z, 4.5 + r() * 1.2, 4 + r() * 0.8);
      }
    }
  }

  // the airport's own landscaping: tree belts beyond the perimeter road
  for (let x = -1300; x < 4300; x += 12) {
    for (const z of [980, 1010, -720, -745]) {
      if (r() < 0.3) continue;
      const tx = x + (r() - 0.5) * 6;
      const tz = z + (r() - 0.5) * 10;
      if (inApproachSurface(tx, tz) || shorelineDistance(tx, tz) < 8 || nearMotorway(tx, tz, 26)) continue;
      plant(r() < 0.3 ? 'pine' : 'oak', tx, tz, 10 + r() * 7, 6 + r() * 3);
    }
  }

  // Hedgerows along the field boundaries the terrain shader paints, where the
  // cameras fly low: hawthorn and blackthorn laid in eight-metre lumps, a gap
  // at every gateway, and every so often an old oak standing in the hedge.
  const hedgeBox = { x0: -14000, z0: -8500, x1: 7000, z1: 6500 };
  const hedgeNear = (x: number, z: number) => corridorDistance(x, z) < 2300 && sampleMask(mask, x, z) < 0.12;
  const hedgeKeep = (x: number, z: number) => Math.hypot(x - CITY.x, z - CITY.z) > CITY.r * 1.15 && !inVillage(x, z) && clearOf(x, z, 12, 24);
  for (const h of hedgeLines(hedgeBox, 7, hedgeNear, hedgeKeep)) {
    const along = (r() - 0.5) * 1.2;
    const x = h.x + Math.cos(h.heading) * along;
    const z = h.z + Math.sin(h.heading) * along;
    plant('hedge', x, z, 2.2 + r() * 1.5, 7.6 + r() * 1.2, h.heading + (r() - 0.5) * 0.08);
    if (r() < 0.045) {
      const side = (r() - 0.5) * 2.4;
      plant('oak', x - Math.sin(h.heading) * side, z + Math.cos(h.heading) * side, 13 + r() * 7, 11 + r() * 5);
    }
  }

  // the landscaped trees of the airport forecourt and car parks, the wooded
  // lake and river banks, and the plane trees of the city promenade
  for (const p of groundPropPlacements()) {
    if (p.kind !== 'tree') continue;
    const h = [8.4, 10.2, 6.8][p.variant % 3];
    plant(p.variant === 1 ? 'birch' : 'oak', p.x, p.z, h * (0.95 + r() * 0.15), h * 0.66);
  }
  for (const o of shoreObjects()) {
    if (o.kind !== 'tree') continue;
    if (o.variant === 2) plant('poplar', o.x, o.z, 17 * o.scale, 4.2 * o.scale);
    else plant(o.variant === 1 ? 'birch' : 'oak', o.x, o.z, 14 * o.scale, 12 * o.scale);
  }
  for (const [x, z, seed] of promenadeTrees()) plant('oak', x, z, 9 + seed * 4, 7.5 + seed * 2);

  void GATES;
  return SPECIES.map((species) => ({ species, data: new Float32Array(lists[species]), count: lists[species].length / TREE_FLOATS }));
}

/**
 * Bales, silage, cattle and sheep in the open fields near the approach (see
 * farmlife.ts): never in a wood, a village, the airfield or the water.
 */
export function placeFarmLife(mask: Uint8Array): Record<FarmKind, Float32Array> {
  return farmLife(
    { x0: -14000, z0: -8500, x1: 7000, z1: 6500 },
    (x, z) => corridorDistance(x, z) < 2000 && sampleMask(mask, x, z) < 0.05,
    (x, z) => !inAirfield(x, z, 150) && shorelineDistance(x, z) > 15 && !nearMotorway(x, z, 30)
      && Math.hypot(x - CITY.x, z - CITY.z) > CITY.r * 1.15 && !inVillage(x, z) && sampleMask(mask, x, z) < 0.05,
  );
}

// ------------------------------------------------------------------ geometry

/**
 * Tree vertex, 13 floats: position, normal, part (0 bark, 1 foliage mass,
 * 2 leaf card), occlusion, atlas uv, and for leaf cards the corner offset
 * from the card's centre in crown widths (scaled uniformly, so sprays keep
 * their shape on tall, narrow crowns).
 */
export const TREE_VERTEX = 13;

class Builder {
  data: number[] = [];
  idx: number[] = [];
  vertex(p: Vec3, n: Vec3, part: number, ao: number, uv: [number, number] = [0, 0], card: Vec3 = [0, 0, 0]): number {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], part, ao, uv[0], uv[1], card[0], card[1], card[2]);
    return this.data.length / TREE_VERTEX - 1;
  }
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function trunk(b: Builder, height: number, radius: number, lean = 0) {
  const S = 6;
  const base = b.data.length / TREE_VERTEX;
  for (let ring = 0; ring <= 1; ring++) {
    const y = ring * height;
    const r = radius * (ring ? 0.55 : 1.15);
    for (let k = 0; k < S; k++) {
      const a = (k / S) * Math.PI * 2;
      b.vertex([Math.cos(a) * r + lean * ring, y - (ring ? 0 : 0.04), Math.sin(a) * r], norm([Math.cos(a), 0.15, Math.sin(a)]), 0, 0.4 + ring * 0.3);
    }
  }
  for (let k = 0; k < S; k++) {
    const k1 = (k + 1) % S;
    b.idx.push(base + k, base + S + k, base + k1, base + k1, base + S + k, base + S + k1);
  }
}

/** Main limbs from the top of the bole into the crown lobes, seen through its gaps. */
function limbs(b: Builder, from: Vec3, to: Vec3[], radius: number) {
  const S = 5;
  for (const t of to) {
    const base = b.data.length / TREE_VERTEX;
    const d = norm([t[0] - from[0], t[1] - from[1], t[2] - from[2]]);
    const ref: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(d, ref));
    const w = cross(d, u);
    for (let ring = 0; ring <= 1; ring++) {
      const c = ring ? t : from;
      const r = radius * (ring ? 0.45 : 1);
      for (let k = 0; k < S; k++) {
        const a = (k / S) * Math.PI * 2;
        const n: Vec3 = [u[0] * Math.cos(a) + w[0] * Math.sin(a), u[1] * Math.cos(a) + w[1] * Math.sin(a), u[2] * Math.cos(a) + w[2] * Math.sin(a)];
        b.vertex([c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n, 0, 0.35 + ring * 0.2);
      }
    }
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S;
      b.idx.push(base + k, base + S + k, base + k1, base + k1, base + S + k, base + S + k1);
    }
  }
}

// icosahedron, for lumpy foliage blobs
const T = (1 + Math.sqrt(5)) / 2;
const ICO_V: Vec3[] = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]].map((v) => norm(v as Vec3));
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

let LOD = 0;

/** Subdivided once (80 faces) with radial jitter: an organic crown lobe. The far LOD keeps the 20-face icosahedron. */
function blob(b: Builder, c: Vec3, rx: number, ry: number, rz: number, seed: number, canopyY: [number, number]) {
  const verts: Vec3[] = [...ICO_V];
  const faces: number[][] = [];
  if (LOD > 0) {
    const base = b.data.length / TREE_VERTEX;
    for (const v of verts) {
      const j = 0.85 + 0.3 * vnoise(v[0] * 2.3 + seed * 7.1, v[2] * 2.3 + v[1] * 1.7 - seed * 3.3);
      const flat = v[1] < -0.35 ? 0.72 : 1;
      const p: Vec3 = [c[0] + v[0] * rx * j, c[1] + v[1] * ry * j * flat, c[2] + v[2] * rz * j];
      const ao = Math.max(0, Math.min(1, (p[1] - canopyY[0]) / (canopyY[1] - canopyY[0])));
      b.vertex(p, norm([v[0] / rx, v[1] / ry, v[2] / rz]), 1, 0.25 + 0.75 * ao);
    }
    for (const f of ICO_F) b.idx.push(base + f[0], base + f[2], base + f[1]);
    return;
  }
  const mid = new Map<string, number>();
  const midpoint = (a: number, c2: number) => {
    const key = a < c2 ? `${a}_${c2}` : `${c2}_${a}`;
    let i = mid.get(key);
    if (i === undefined) {
      const p = norm([(verts[a][0] + verts[c2][0]) / 2, (verts[a][1] + verts[c2][1]) / 2, (verts[a][2] + verts[c2][2]) / 2]);
      i = verts.push(p) - 1;
      mid.set(key, i);
    }
    return i;
  };
  for (const [a, bb, cc] of ICO_F) {
    const ab = midpoint(a, bb);
    const bc = midpoint(bb, cc);
    const ca = midpoint(cc, a);
    faces.push([a, ab, ca], [bb, bc, ab], [cc, ca, bc], [ab, bc, ca]);
  }
  const base = b.data.length / TREE_VERTEX;
  for (const v of verts) {
    const j = 0.82 + 0.36 * vnoise(v[0] * 2.3 + seed * 7.1, v[2] * 2.3 + v[1] * 1.7 - seed * 3.3);
    const flat = v[1] < -0.35 ? 0.72 : 1; // crowns are flatter underneath
    const p: Vec3 = [c[0] + v[0] * rx * j, c[1] + v[1] * ry * j * flat, c[2] + v[2] * rz * j];
    const ao = Math.max(0, Math.min(1, (p[1] - canopyY[0]) / (canopyY[1] - canopyY[0])));
    b.vertex(p, norm([v[0] / rx, v[1] / ry, v[2] / rz]), 1, 0.25 + 0.75 * ao);
  }
  for (const f of faces) b.idx.push(base + f[0], base + f[2], base + f[1]);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Leaf cards over an ellipsoidal crown lobe: each a spray from the atlas,
 * centred near the lobe's surface and facing roughly outward, its twig end
 * turned toward the inside of the crown (or hanging, for birch). They are lit
 * with the lobe's normal, so the crown still shades as one volume.
 */
function cards(b: Builder, c: Vec3, rx: number, ry: number, rz: number, count: number, size: number, kind: LeafKind, seed: number, canopyY: [number, number], hang = false) {
  let s = Math.floor(seed * 1e5) >>> 0;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
  const [col, row] = LEAF_CELL[kind];
  for (let k = 0; k < count; k++) {
    // directions spread evenly (golden spiral) with jitter, few underneath
    const t = (k + 0.5) / count;
    const y = Math.min(0.98, -0.5 + 1.48 * t + (rnd() - 0.5) * 0.12);
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = k * 2.39996 + seed * 11 + (rnd() - 0.5) * 0.5;
    const d: Vec3 = [Math.cos(phi) * ring, y, Math.sin(phi) * ring];
    const reach = 0.72 + 0.34 * rnd();
    const centre: Vec3 = [c[0] + d[0] * rx * reach, c[1] + d[1] * ry * reach, c[2] + d[2] * rz * reach];
    const normal = norm([d[0] / rx, d[1] / ry, d[2] / rz]);
    // the card plane: outward-ish, tilted at random
    const facing = norm([normal[0] + (rnd() - 0.5) * 1.3, normal[1] + (rnd() - 0.5) * 1.3, normal[2] + (rnd() - 0.5) * 1.3]);
    // twig end (atlas v = 1) toward the crown's inside, or straight down for hanging sprays
    const inward: Vec3 = hang ? [0, -1, 0] : norm([-d[0], -d[1] - 0.6, -d[2]]);
    const along = inward[0] * facing[0] + inward[1] * facing[1] + inward[2] * facing[2];
    let down = norm([inward[0] - facing[0] * along, inward[1] - facing[1] * along, inward[2] - facing[2] * along]);
    if (!Number.isFinite(down[0])) down = norm(cross(facing, [1, 0, 0]));
    let across = norm(cross(down, facing));
    // a little in-plane twist
    const tw = (rnd() - 0.5) * 0.9;
    const ct = Math.cos(tw);
    const st = Math.sin(tw);
    const d2: Vec3 = [down[0] * ct + across[0] * st, down[1] * ct + across[1] * st, down[2] * ct + across[2] * st];
    across = norm(cross(d2, facing));
    down = d2;
    const half = (size * (0.8 + 0.4 * rnd())) / 2;
    const hgt = Math.max(0, Math.min(1, (centre[1] - canopyY[0]) / (canopyY[1] - canopyY[0])));
    const ao = Math.min(1, (0.3 + 0.7 * hgt) * (0.62 + 0.38 * Math.min(1, (reach - 0.72) / 0.34)) + 0.1);
    const base = b.data.length / TREE_VERTEX;
    const corner = (su: number, sv: number, u: number, v: number) =>
      b.vertex(centre, normal, 2, ao, [(col + u) / 2, (row + v) / 2], [
        (across[0] * su + down[0] * sv) * half,
        (across[1] * su + down[1] * sv) * half,
        (across[2] * su + down[2] * sv) * half,
      ]);
    corner(-1, -1, 0, 0);
    corner(1, -1, 1, 0);
    corner(1, 1, 1, 1);
    corner(-1, 1, 0, 1);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function cone(b: Builder, y0: number, y1: number, r: number, seed: number, canopyY: [number, number]) {
  const S = 9;
  const base = b.data.length / TREE_VERTEX;
  const tip = b.vertex([0, y1, 0], [0, 1, 0], 1, 1);
  for (let k = 0; k < S; k++) {
    const a = (k / S) * Math.PI * 2 + seed;
    const rr = r * (0.85 + 0.3 * vnoise(k * 1.7 + seed, seed * 3.1));
    const droop = (vnoise(k * 2.3, seed) - 0.5) * r * 0.25;
    const p: Vec3 = [Math.cos(a) * rr, y0 + droop, Math.sin(a) * rr];
    const ao = Math.max(0, Math.min(1, (y0 - canopyY[0]) / (canopyY[1] - canopyY[0])));
    b.vertex(p, norm([Math.cos(a), r / (y1 - y0) * 0.9, Math.sin(a)]), 1, 0.2 + 0.6 * ao);
  }
  // underside ring, slightly inset, so cones read as solid tiers
  const under = b.vertex([0, y0 + (y1 - y0) * 0.12, 0], [0, -1, 0], 1, 0.15);
  for (let k = 0; k < S; k++) {
    const k1 = (k + 1) % S;
    b.idx.push(tip, base + 1 + k1, base + 1 + k);
    b.idx.push(under, base + 1 + k, base + 1 + k1);
  }
}

/** Needle sprays round a spruce tier's skirt, drooping outward from the trunk. */
function spruceSprays(b: Builder, y0: number, y1: number, r: number, count: number, seed: number, canopyY: [number, number]) {
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + seed * 2.1 + (Math.sin(k * 7.1 + seed) * 0.5) * (Math.PI / count);
    const out: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    const up = 0.15 + 0.25 * ((k * 0.618 + seed) % 1);
    const centre: Vec3 = [out[0] * r * 0.82, y0 + (y1 - y0) * up, out[2] * r * 0.82];
    const normal = norm([out[0], (r / (y1 - y0)) * 0.9, out[2]]);
    // the spray lies along the slope of the tier, twig end at the trunk
    const down = norm([-out[0], (y1 - y0) / Math.max(r, 1e-3) * 0.35, -out[2]]);
    const across: Vec3 = [-out[2], 0, out[0]];
    const half = r * 0.72;
    const hgt = Math.max(0, Math.min(1, (centre[1] - canopyY[0]) / (canopyY[1] - canopyY[0])));
    const ao = 0.3 + 0.6 * hgt;
    const [col, row] = LEAF_CELL.needle;
    const base = b.data.length / TREE_VERTEX;
    const corner = (su: number, sv: number, u: number, v: number) =>
      b.vertex(centre, normal, 2, ao, [(col + u) / 2, (row + v) / 2], [
        (across[0] * su + down[0] * sv) * half,
        (across[1] * su + down[1] * sv) * half - 0.03 * (1 - sv),
        (across[2] * su + down[2] * sv) * half,
      ]);
    corner(-1, -1, 0, 0);
    corner(1, -1, 1, 0);
    corner(1, 1, 1, 1);
    corner(-1, 1, 0, 1);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * Unit-height tree meshes (scaled per instance by width and height). The near
 * LOD (0) carries leaf cards over slightly smaller foliage lobes; the far
 * LODs are the lobes alone.
 */
export function buildTreeMesh(species: TreeSpecies, lod = 0): { data: Float32Array; indices: Uint16Array } {
  const b = new Builder();
  LOD = lod;
  const near = lod === 0;
  const k = near ? 0.8 : 1; // inner lobes shrink under the cards: the dark heart of the crown
  const lobe = (c: Vec3, rx: number, ry: number, rz: number, seed: number, cy: [number, number], n: number, size: number, kind: LeafKind, hang = false) => {
    blob(b, c, rx * k, ry * k, rz * k, seed, cy);
    if (near) cards(b, c, rx, ry, rz, n, size, kind, seed, cy, hang);
  };
  switch (species) {
    case 'oak': {
      // a broad, low-branching crown of several lobes over a short bole
      trunk(b, 0.44, 0.034);
      if (near) limbs(b, [0, 0.4, 0], [[0.28, 0.52, 0.14], [-0.25, 0.54, -0.2], [-0.06, 0.5, 0.3], [0.04, 0.78, -0.04]], 0.016);
      const cy: [number, number] = [0.26, 1.0];
      lobe([0, 0.62, 0], 0.5, 0.34, 0.5, 1.3, cy, 64, 0.42, 'broadleaf');
      lobe([0.28, 0.5, 0.14], 0.33, 0.25, 0.31, 2.7, cy, 26, 0.36, 'broadleaf');
      lobe([-0.25, 0.52, -0.2], 0.32, 0.25, 0.33, 4.1, cy, 26, 0.36, 'broadleaf');
      lobe([-0.06, 0.48, 0.3], 0.28, 0.22, 0.26, 6.6, cy, 22, 0.34, 'broadleaf');
      lobe([0.02, 0.83, -0.04], 0.32, 0.19, 0.32, 5.9, cy, 28, 0.36, 'broadleaf');
      break;
    }
    case 'birch': {
      trunk(b, 0.62, 0.022, 0.03);
      if (near) limbs(b, [0.02, 0.5, 0], [[0.14, 0.62, -0.1], [-0.12, 0.72, 0.08], [0.06, 0.86, 0.1]], 0.009);
      const cy: [number, number] = [0.35, 1.0];
      lobe([0.02, 0.7, 0], 0.36, 0.3, 0.36, 7.7, cy, 50, 0.36, 'birch', true);
      lobe([0.0, 0.9, 0.04], 0.24, 0.13, 0.24, 8.9, cy, 18, 0.3, 'birch', true);
      lobe([0.12, 0.52, -0.08], 0.22, 0.16, 0.22, 3.2, cy, 18, 0.3, 'birch', true);
      break;
    }
    case 'poplar': {
      trunk(b, 0.3, 0.04);
      const cy: [number, number] = [0.15, 1.0];
      lobe([0, 0.55, 0], 0.5, 0.44, 0.5, 6.6, cy, 120, 0.5, 'poplar');
      lobe([0, 0.82, 0], 0.36, 0.2, 0.36, 2.2, cy, 32, 0.42, 'poplar');
      break;
    }
    case 'pine': {
      trunk(b, 0.72, 0.026);
      const cy: [number, number] = [0.5, 1.0];
      if (near) limbs(b, [0, 0.7, 0], [[0.3, 0.8, 0.1], [-0.28, 0.78, -0.12], [0.05, 0.84, 0.3], [0.18, 0.76, -0.28]], 0.012);
      lobe([0, 0.82, 0], 0.42, 0.18, 0.42, 5.1, cy, 56, 0.36, 'needle');
      lobe([0.18, 0.74, 0.1], 0.28, 0.12, 0.26, 1.9, cy, 24, 0.3, 'needle');
      break;
    }
    case 'hedge': {
      // a laid hedge: a row of overlapping lumps along x, eight metres long,
      // two and a half wide, its foot just below the ground
      const cy: [number, number] = [0.0, 1.0];
      const xs = near ? [-0.36, -0.12, 0.12, 0.36] : [-0.3, 0, 0.3];
      LOD = 1; // coarse lobes even up close: the leaf cards carry the outline
      xs.forEach((x, i) => lobe([x, 0.5, i % 2 ? 0.025 : -0.025], near ? 0.17 : 0.22, 0.52, 0.15, 3.3 + i * 1.7, cy, 12, 0.17, 'broadleaf'));
      break;
    }
    case 'spruce': {
      trunk(b, 0.25, 0.03);
      const cy: [number, number] = [0.08, 1.0];
      const tiers = 5;
      for (let i = 0; i < tiers; i++) {
        const y0 = 0.1 + i * 0.17;
        const r = 0.5 * (1 - i / (tiers + 0.6));
        cone(b, y0, Math.min(1, y0 + 0.36), r * (near ? 0.88 : 1), i * 1.3 + 0.7, cy);
        if (near) spruceSprays(b, y0, Math.min(1, y0 + 0.36), r, 22 - i * 3, i * 1.3 + 0.7, cy);
      }
      break;
    }
  }
  LOD = 0;
  return { data: new Float32Array(b.data), indices: new Uint16Array(b.idx) };
}
