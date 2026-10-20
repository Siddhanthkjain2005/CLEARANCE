// Terrain: rolling farmland around a flattened airfield, a river through the
// city, hills to the south and mountains under the start of the approach.

import { fbm, smoothstep, vnoise, type Vec3 } from '../math.ts';
import { LAKE, PONDS, WATER_LEVEL, carveWaterHeight, lakeShorePoint, riverWidthAt, riverZ } from './hydrology.ts';

export { RIVER, LAKE, PONDS, WATER_LEVEL, riverZ, riverWidthAt, shorelineDistance, waterDepthAt, buildWaterGeometry } from './hydrology.ts';

export const AIRFIELD = { x0: -1400, z0: -650, x1: 4300, z1: 900 };
export const CITY = { x: -4900, z: -4300, r: 2700 };
function rectDistance(x: number, z: number, r: { x0: number; z0: number; x1: number; z1: number }): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dz = Math.max(r.z0 - z, 0, z - r.z1);
  return Math.hypot(dx, dz);
}

export function heightAt(x: number, z: number): number {
  let h = (fbm(x * 0.00022 + 11.3, z * 0.00022 - 4.1, 4) - 0.42) * 260;
  // lowlands settle into flat flood plains a few metres above the river
  if (h < 4) h = 4 - (4 - h) * 0.03;
  // mountains under the start of the approach and along the western horizon
  const west = smoothstep(-9000, -17000, x);
  h += west * Math.pow(fbm(x * 0.00011 + 3.7, z * 0.00013 + 1.9, 5), 1.6) * 3200;
  // hills to the south
  h += smoothstep(3500, 11000, z) * fbm(x * 0.0003 + 9.1, z * 0.0003, 4) * 900;
  // a far northern range
  h += smoothstep(-8000, -18000, z) * fbm(x * 0.00015 - 2.2, z * 0.00015 + 6.6, 4) * 2200;
  // Small irregular rises give the foreground a real silhouette without
  // turning the flat airport or the river floodplain into lumpy terrain.
  h += (vnoise(x * 0.0018 + 2.6, z * 0.0018 - 9.1) - 0.5) * 7;
  h += (vnoise(x * 0.0055 - 4.3, z * 0.0055 + 3.7) - 0.5) * 1.8;
  // flatten the airfield and calm the city
  const a = rectDistance(x, z, AIRFIELD);
  h *= smoothstep(0, 1300, a);
  const c = Math.hypot(x - CITY.x, z - CITY.z);
  h *= 0.25 + 0.75 * smoothstep(CITY.r * 0.6, CITY.r * 1.3, c);
  return carveWaterHeight(x, z, h);
}

/** Terrain mesh on a grid that is dense near the airport and sparse at the horizon. */
export function buildTerrain(n = 300, radius = 38000): { data: Float32Array; indices: Uint32Array } {
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(radius) || radius <= 0) throw new RangeError('Terrain needs a positive integer resolution and a finite positive radius');
  const cx = 600;
  const cz = 0;
  const remap = (u: number) => Math.sign(u) * Math.pow(Math.abs(u), 1.75) * radius;
  const verts = new Float32Array((n + 1) * (n + 1) * 6);
  // Heights once per grid point; normals from the neighbouring grid points,
  // which is the same central difference at a fifth of the cost.
  const xs = Array.from({ length: n + 1 }, (_, i) => cx + remap((i / n) * 2 - 1));
  const zs = Array.from({ length: n + 1 }, (_, j) => cz + remap((j / n) * 2 - 1));
  const H = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) H[j * (n + 1) + i] = heightAt(xs[i], zs[j]);
  let k = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n, j + 1);
      const nx = (H[j * (n + 1) + i0] - H[j * (n + 1) + i1]) / Math.max(1e-6, xs[i1] - xs[i0]);
      const nz = (H[j0 * (n + 1) + i] - H[j1 * (n + 1) + i]) / Math.max(1e-6, zs[j1] - zs[j0]);
      const l = Math.hypot(nx, 1, nz);
      verts[k++] = xs[i]; verts[k++] = H[j * (n + 1) + i]; verts[k++] = zs[j];
      verts[k++] = nx / l; verts[k++] = 1 / l; verts[k++] = nz / l;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let m = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      indices[m++] = a; indices[m++] = c; indices[m++] = b;
      indices[m++] = b; indices[m++] = c; indices[m++] = d;
    }
  }
  return { data: verts, indices };
}

/** Detailed bank geometry replaces the coarse mesh within 180m of water.
 * uShoreTerrain=1 clips the coarse pass; 2 clips these patches to that area.
 * Extra 30m outside the clipping boundary keeps interpolation gaps away from
 * the seam, and the eight-metre shore rows preserve the close bank profile. */
export function buildShoreTerrain(riverStep = 42, basinSegments = 128): { data: Float32Array; indices: Uint32Array } {
  if (!Number.isFinite(riverStep) || riverStep <= 0 || !Number.isInteger(basinSegments) || basinSegments < 16) throw new RangeError('Shore terrain needs a positive river spacing and at least sixteen basin segments');
  const data: number[] = [], indices: number[] = [];
  const vertex = (x: number, z: number) => {
    const h = heightAt(x, z), e = 3;
    // forward differences: three height samples per vertex instead of five
    const nx = (h - heightAt(x + e, z)) / e;
    const nz = (h - heightAt(x, z + e)) / e;
    const length = Math.hypot(nx, 1, nz);
    const index = data.length / 6;
    data.push(x, h, z, nx / length, 1 / length, nz / length);
    return index;
  };
  const bankRows = [0, 8, 16, 28, 44, 65, 95, 135, 180, 210];
  const riverSegments = Math.ceil(60_000 / riverStep);
  let previous: number[] | null = null;
  for (let i = 0; i <= riverSegments; i++) {
    const x = -30_000 + (i / riverSegments) * 60_000;
    const width = riverWidthAt(x), center = riverZ(x);
    const offsets = [...bankRows.map((d) => -(width + d)).reverse(), -width * 0.7, -width * 0.35, 0, width * 0.35, width * 0.7, ...bankRows.map((d) => width + d)];
    const row = offsets.map((offset) => vertex(x, center + offset));
    if (previous) {
      for (let j = 0; j < row.length - 1; j++) indices.push(previous[j], previous[j + 1], row[j], previous[j + 1], row[j + 1], row[j]);
    }
    previous = row;
  }
  for (const body of [LAKE, ...PONDS]) {
    const center = vertex(body.x, body.z);
    let inner: number[] | null = null;
    for (const offset of [-120, -60, -30, -15, ...bankRows]) {
      const ring: number[] = [];
      for (let i = 0; i <= basinSegments; i++) {
        const p = lakeShorePoint(body, (i / basinSegments) * Math.PI * 2, offset);
        ring.push(vertex(p[0], p[2]));
      }
      for (let i = 0; i < basinSegments; i++) {
        if (inner) indices.push(inner[i], ring[i + 1], ring[i], inner[i], inner[i + 1], ring[i + 1]);
        else indices.push(center, ring[i + 1], ring[i]);
      }
      inner = ring;
    }
  }
  return { data: new Float32Array(data), indices: new Uint32Array(indices) };
}

export function groundAt(p: Vec3): Vec3 {
  return [p[0], Math.max(heightAt(p[0], p[2]), WATER_LEVEL), p[2]];
}
