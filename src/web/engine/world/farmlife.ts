// Life in the fields under the approach: round bales left in rows along the
// swaths on the stubble, wrapped silage stacked by a gateway, cattle grazing
// the pastures (a few lying down to chew the cud) and sheep on the leys. All
// of it is placed on the parcels the terrain shader paints (see fields.ts),
// so a herd keeps to one field and the bales follow the swath lines drawn on
// the stubble.

import { rng, type Vec3 } from '../math.ts';
import { farmland, fieldParcel } from './fields.ts';
import { heightAt } from './terrain.ts';

export const FARM_KINDS = ['bale', 'wrapped', 'cow', 'cowLying', 'sheep'] as const;
export type FarmKind = (typeof FARM_KINDS)[number];
/** Instance layout, shared with the movers: x, y, z, heading | pitch, r, g, b. */
export const FARM_FLOATS = 8;

/** Coats: black, dark red-brown, Hereford red, Charolais cream, black again (Angus are common). */
const COATS: Vec3[] = [[0.03, 0.028, 0.026], [0.16, 0.075, 0.04], [0.3, 0.15, 0.08], [0.44, 0.39, 0.31], [0.035, 0.03, 0.03]];
const WOOL: Vec3[] = [[0.5, 0.47, 0.4], [0.46, 0.43, 0.35], [0.54, 0.51, 0.44]];
/** Silage wrap: black, green and white plastic. */
const WRAP: Vec3[] = [[0.02, 0.022, 0.024], [0.045, 0.085, 0.045], [0.44, 0.45, 0.43]];

/** Swath lines on the stubble, where the shader darkens sin(dir * 0.52) to -1. */
const SWATH = (2 * Math.PI) / 0.52;
const SWATH_PHASE = (1.5 * Math.PI) / 0.52;

export function farmLife(
  box: { x0: number; z0: number; x1: number; z1: number },
  near: (x: number, z: number) => boolean,
  keep: (x: number, z: number) => boolean,
): Record<FarmKind, Float32Array> {
  const r = rng(808);
  const out: Record<FarmKind, number[]> = { bale: [], wrapped: [], cow: [], cowLying: [], sheep: [] };
  const used = new Set<string>();
  const jitter = (c: Vec3, k: number): Vec3 => {
    const f = 1 + (r() - 0.5) * k;
    return [c[0] * f, c[1] * f, c[2] * f];
  };
  const put = (kind: FarmKind, x: number, z: number, heading: number, color: Vec3) => {
    out[kind].push(x, heightAt(x, z), z, heading, 0, color[0], color[1], color[2]);
  };
  /** Somewhere in the same parcel, clear of its hedges, on dry open ground. */
  const fits = (x: number, z: number, id: string, edge: number) => {
    const p = fieldParcel(x, z);
    return p.id === id && p.edge > edge && keep(x, z);
  };

  for (let i = 0; i < 16000; i++) {
    const x = box.x0 + r() * (box.x1 - box.x0);
    const z = box.z0 + r() * (box.z1 - box.z0);
    if (!near(x, z) || farmland(x, z) < 0.8) continue;
    const p = fieldParcel(x, z);
    if (p.edge < 24 || used.has(p.id) || !keep(x, z)) continue;
    const roll = r();
    const across = p.drive - Math.PI / 2;

    if (p.crop >= 0.68 && p.crop < 0.8) {
      // stubble: a row of straw bales along one swath, dropped as the baler went
      if (roll > 0.6) continue;
      used.add(p.id);
      const off = p.across - (Math.round((p.across - SWATH_PHASE) / SWATH) * SWATH + SWATH_PHASE);
      let bx = x - Math.cos(across) * off;
      let bz = z - Math.sin(across) * off;
      const n = 3 + Math.floor(r() * 9);
      for (let k = 0; k < n; k++) {
        if (!fits(bx, bz, p.id, 7)) break;
        put('bale', bx + (r() - 0.5) * 0.8, bz + (r() - 0.5) * 0.8, p.drive + (r() - 0.5) * 0.5, [1, 1, 1]);
        const step = 13 + r() * 7;
        bx += Math.cos(p.drive) * step;
        bz += Math.sin(p.drive) * step;
      }
      continue;
    }

    if (p.crop < 0.34) {
      // grass: cattle on the pastures, sheep on the leys and some pastures
      const sheep = p.crop >= 0.2 || r() < 0.3;
      if (roll > (sheep && p.crop >= 0.2 ? 0.3 : 0.45)) continue;
      used.add(p.id);
      const wind = r() * Math.PI * 2; // a herd grazes roughly into the wind
      const n = sheep ? 16 + Math.floor(r() * 40) : 7 + Math.floor(r() * 20);
      const spread = sheep ? 40 : 50;
      const coat = COATS[Math.floor(r() * COATS.length)];
      const other = COATS[Math.floor(r() * COATS.length)];
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * spread;
        const ax = x + Math.cos(a) * d;
        const az = z + Math.sin(a) * d;
        if (!fits(ax, az, p.id, 5)) continue;
        const heading = wind + (r() - 0.5) * 2.4;
        if (sheep) put('sheep', ax, az, heading, jitter(WOOL[Math.floor(r() * WOOL.length)], 0.12));
        else put(r() < 0.22 ? 'cowLying' : 'cow', ax, az, heading, jitter(r() < 0.75 ? coat : other, 0.18));
      }
      // wrapped silage stacked near the gateway of some grass fields
      if (r() < 0.35) {
        let wx = x;
        let wz = z;
        for (let s = 0; s < 40 && fieldParcel(wx, wz).edge > 12; s++) {
          wx -= Math.cos(p.drive) * 6;
          wz -= Math.sin(p.drive) * 6;
        }
        const wrap = WRAP[Math.floor(r() * WRAP.length)];
        const m = 3 + Math.floor(r() * 6);
        for (let k = 0; k < m; k++) {
          const bx = wx + Math.cos(across) * (k - m / 2) * 1.35;
          const bz = wz + Math.sin(across) * (k - m / 2) * 1.35;
          if (!fits(bx, bz, p.id, 4)) continue;
          put('wrapped', bx, bz, p.drive, jitter(wrap, 0.08));
        }
      }
    }
  }
  return {
    bale: new Float32Array(out.bale),
    wrapped: new Float32Array(out.wrapped),
    cow: new Float32Array(out.cow),
    cowLying: new Float32Array(out.cowLying),
    sheep: new Float32Array(out.sheep),
  };
}
