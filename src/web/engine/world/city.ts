// The city under the approach: a downtown of towers, mid-rise blocks and
// low-rise suburbs on a street grid, split by the river, with sodium street
// lights, obstacle lights on the tall buildings, villages scattered across the
// countryside and a motorway out to the airport. City lamps are stable,
// subpixel emitters; only aviation beacons flash.

import { type Vec3, rng, smoothstep, vnoise } from '../math.ts';
import { AIRFIELD, CITY, WATER_LEVEL, heightAt, shorelineDistance } from './terrain.ts';

/** Instance layout for CITY_VS: x, z, width, depth, height, seed, base y. */
export const BUILDING_FLOATS = 7;

export interface City {
  buildings: Float32Array;
  count: number;
  /** Static point lights: 8 floats each (see POINTS_VS). */
  lights: number[];
}

const DOWNTOWN = { x: CITY.x + 380, z: CITY.z + 520 };

function inAirfield(x: number, z: number, pad: number) {
  return x > AIRFIELD.x0 - pad && x < AIRFIELD.x1 + pad && z > AIRFIELD.z0 - pad && z < AIRFIELD.z1 + pad;
}

function nearWater(x: number, z: number, pad: number) {
  return shorelineDistance(x, z) < pad + 35;
}

export function buildCity(): City {
  const r = rng(77);
  const b: number[] = [];
  const lights: number[] = [];
  const L = (p: Vec3, c: Vec3, size: number, kind = 0) => lights.push(p[0], p[1], p[2], c[0], c[1], c[2], size, kind);
  const sodium: Vec3 = [0.68, 0.39, 0.15];
  const led: Vec3 = [0.48, 0.46, 0.39];
  const red: Vec3 = [1.0, 0.12, 0.08];

  const BX = 130; // block pitch east-west
  const BZ = 96; // block pitch north-south
  const STREET = 16;
  const reach = CITY.r * 1.25;
  for (let gx = -Math.ceil(reach / BX); gx <= Math.ceil(reach / BX); gx++) {
    for (let gz = -Math.ceil(reach / BZ); gz <= Math.ceil(reach / BZ); gz++) {
      const cx = CITY.x + gx * BX;
      const cz = CITY.z + gz * BZ;
      // a ragged edge rather than a circle
      const edge = CITY.r * (0.82 + 0.45 * vnoise(cx * 0.0011 + 3.1, cz * 0.0011 - 7.7));
      const d = Math.hypot(cx - CITY.x, cz - CITY.z);
      if (d > edge) continue;
      if (nearWater(cx, cz, 30) || inAirfield(cx, cz, 400)) continue;
      const dd = Math.hypot(cx - DOWNTOWN.x, cz - DOWNTOWN.z);
      const core = Math.exp(-(dd * dd) / (650 * 650));
      const mid = Math.exp(-(d * d) / (1500 * 1500));
      const parkland = vnoise(cx * 0.004 + 11, cz * 0.004 - 2) > 0.78 && core < 0.3;

      // Warm pools punctuate the main roads rather than outlining every
      // suburban lot with oversized sparkling point sprites.
      const lampStep = mid > 0.35 ? 58 : 92;
      for (let s = 20; s < BX; s += lampStep) L([cx - BX / 2 + s, heightAt(cx - BX / 2 + s, cz - BZ / 2) + 8, cz - BZ / 2], r() > 0.16 ? sodium : led, 1.25, 5.28);
      if (gx % 2 === 0) for (let s = 24; s < BZ; s += lampStep) L([cx - BX / 2, heightAt(cx - BX / 2, cz - BZ / 2 + s) + 8, cz - BZ / 2 + s], sodium, 1.1, 5.23);
      if (parkland) continue;

      // lots: downtown blocks hold one or two towers, suburbs many small houses
      const w = BX - STREET;
      const dep = BZ - STREET;
      const lots = core > 0.45 ? 1 + Math.floor(r() * 2) : mid > 0.35 ? 2 + Math.floor(r() * 3) : 6 + Math.floor(r() * 6);
      const cols = Math.ceil(Math.sqrt(lots * (w / dep)));
      const rows = Math.ceil(lots / cols);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (r() < 0.08) continue;
          const lw = w / cols;
          const ld = dep / rows;
          const setback = core > 0.45 ? 3 : mid > 0.35 ? 4 + r() * 3 : 5 + r() * 4;
          const bw = Math.max(6, lw - setback * 2) * (0.75 + r() * 0.25);
          const bd = Math.max(6, ld - setback * 2) * (0.75 + r() * 0.25);
          const x = cx - w / 2 + lw * (i + 0.5);
          const z = cz - dep / 2 + ld * (j + 0.5);
          let h: number;
          if (core > 0.45) h = 40 + core * 170 * Math.pow(r(), 1.4) + r() * 30;
          else if (mid > 0.35) h = 12 + mid * 38 * r() + r() * 8;
          else h = 5 + r() * 4;
          const base = heightAt(x, z) - 0.45;
          const seed = r();
          b.push(x, z, bw, bd, h + 0.45, seed, base);
          if (h > 38) {
            // A smaller rooftop plant enclosure gives towers a stepped
            // silhouette, instead of identical featureless extruded blocks.
            b.push(x + bw * 0.10, z - bd * 0.08, bw * 0.34, bd * 0.38, 2.4 + r() * 1.6, seed, base + h + 0.45);
          }
          if (h > 75) {
            // obstacle lights on each tall roof, phases staggered
            L([x + bw * 0.10, base + h + 4.5, z - bd * 0.08], red, 1.3, 4 + r() * 0.99);
          }
        }
      }
    }
  }

  // villages and farms across the countryside
  for (let v = 0; v < 32; v++) {
    const ang = r() * Math.PI * 2;
    const dist = 3500 + r() * 14000;
    const vx = 600 + Math.cos(ang) * dist;
    const vz = Math.sin(ang) * dist;
    if (inAirfield(vx, vz, 900) || nearWater(vx, vz, 200) || Math.hypot(vx - CITY.x, vz - CITY.z) < CITY.r * 1.3) continue;
    const ground = heightAt(vx, vz);
    if (ground > 160 || Math.abs(heightAt(vx + 70, vz) - ground) > 10 || Math.abs(heightAt(vx, vz + 70) - ground) > 10) continue;
    const size = 12 + Math.floor(r() * 24);
    for (let k = 0; k < size; k++) {
      const x = vx + (k - size / 2) * 24 + (r() - 0.5) * 8;
      const z = vz + (k % 2 ? 27 : -27) + (r() - 0.5) * 12;
      if (nearWater(x, z, 30) || inAirfield(x, z, 600)) continue;
      const base = heightAt(x, z) - 0.3;
      b.push(x, z, 8 + r() * 5, 10 + r() * 6, 5.2 + r() * 2.0, r(), base);
      if (k % 4 === 0) L([x, base + 5.5, vz], sodium, 0.8, 5.20);
    }
  }

  return { buildings: new Float32Array(b), count: b.length / BUILDING_FLOATS, lights };
}

/** Instance layout for ROOF_VS: x, z, width, depth, eave height, seed, rise, hip. */
export const ROOF_FLOATS = 8;

/**
 * A pitched roof for every low-rise house in the city: gabled or hipped,
 * pitched between 30 and 45 degrees across the narrower span, the eaves
 * overhanging the walls and dipping just below the wall plate, as real eaves
 * do. Village cottages are roofed with their villages (see villages.ts).
 */
export function houseRoofs(city: City = buildCity()): Float32Array {
  const out: number[] = [];
  const B = city.buildings;
  for (let i = 0; i < B.length; i += BUILDING_FLOATS) {
    const x = B[i];
    const z = B[i + 1];
    const w = B[i + 2];
    const d = B[i + 3];
    const h = B[i + 4];
    const seed = B[i + 5];
    const base = B[i + 6];
    if (h <= 4 || h >= 10.5) continue;
    if (Math.hypot(x - CITY.x, z - CITY.z) > CITY.r * 1.25) continue;
    const span = Math.min(w, d) + 0.9;
    const pitch = 0.58 + 0.42 * ((seed * 7.13) % 1); // tan 30..45 degrees
    const rise = Math.min(4.8, Math.max(1.6, span * 0.5 * pitch));
    const hip = (seed * 3.31) % 1 < 0.42 ? 1 : 0;
    out.push(x, z, w, d, base + h - (0.9 * rise) / span, seed, rise, hip);
  }
  return new Float32Array(out);
}

/** A short elevated span carries the motorway across wet ground, with a
 * graded approach rather than cars descending below the water surface. */
export function motorwayDeckHeight(x: number, z: number): number {
  const ground = heightAt(x, z) + 0.3;
  const blend = smoothstep(0, 100, shorelineDistance(x, z));
  return Math.max(ground, (WATER_LEVEL + 14) * (1 - blend) + ground * blend);
}

/** The motorway from the city to the airport, as a polyline on the ground. */
export const MOTORWAY: Vec3[] = (() => {
  const pts: [number, number][] = [
    [CITY.x + 900, CITY.z + 1900],
    [-3200, -1700],
    [-1900, -1250],
    [-700, -950],
    [600, -900],
    [1900, -1000],
    [2700, -1150],
    [4200, -1500],
    [9000, -2300],
  ];
  return pts.map(([x, z]) => [x, motorwayDeckHeight(x, z) + 1.0, z] as Vec3);
})();

/** Point on the motorway polyline at fraction t of its length. */
export function motorwayAt(t: number, lane: number): Vec3 {
  const segs = MOTORWAY.length - 1;
  const f = ((t % 1) + 1) % 1 * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const u = f - i;
  const a = MOTORWAY[i];
  const c = MOTORWAY[i + 1];
  const dx = c[0] - a[0];
  const dz = c[2] - a[2];
  const len = Math.hypot(dx, dz) || 1;
  const x = a[0] + dx * u - (dz / len) * lane;
  const z = a[2] + dz * u + (dx / len) * lane;
  return [x, motorwayDeckHeight(x, z) + 1.0, z];
}
