// Livestock and the hay harvest for the fields under the approach: cattle
// grazing or lying down, sheep, and round bales, straw or wrapped silage.
// Models face +x (the mover convention), stand on y = 0, take their coat or
// wrap colour from the instance (PAINT), and stay small enough to instance by
// the thousand.

import { Geo } from '../gl.ts';
import { v3, type Vec3 } from '../math.ts';
import { PAINT } from './vehicles.ts';

const HOOF: Vec3 = [0.05, 0.045, 0.04];
const MUZZLE: Vec3 = [0.2, 0.13, 0.12];
const HORN: Vec3 = [0.5, 0.46, 0.38];

/** An axis-aligned ellipsoid, smooth-shaded. */
function ellipsoid(g: Geo, c: Vec3, r: Vec3, color: Vec3, gloss = 0.1, rings = 6, segs = 9) {
  const base = g.count;
  for (let i = 0; i <= rings; i++) {
    const lat = (i / rings) * Math.PI - Math.PI / 2;
    for (let k = 0; k < segs; k++) {
      const lon = (k / segs) * Math.PI * 2;
      const n: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      g.vertex([c[0] + n[0] * r[0], c[1] + n[1] * r[1], c[2] + n[2] * r[2]], v3.norm([n[0] / r[0], n[1] / r[1], n[2] / r[2]]), color, gloss);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < segs; k++) {
      const a = base + i * segs + k;
      const b = base + i * segs + ((k + 1) % segs);
      const cc = base + (i + 1) * segs + ((k + 1) % segs);
      const d = base + (i + 1) * segs + k;
      g.quad(a, d, cc, b);
    }
  }
}

/** A tapered round member from a to b (legs, necks, tails). */
function member(g: Geo, a: Vec3, b: Vec3, ra: number, rb: number, color: Vec3, sides = 6, gloss = 0.1) {
  const d = v3.norm(v3.sub(b, a));
  const ref: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = v3.norm(v3.cross(d, ref));
  const w = v3.cross(d, u);
  const base = g.count;
  for (const [p, r] of [[a, ra], [b, rb]] as [Vec3, number][]) {
    for (let k = 0; k < sides; k++) {
      const t = (k / sides) * Math.PI * 2;
      const n = v3.add(v3.scale(u, Math.cos(t)), v3.scale(w, Math.sin(t)));
      g.vertex(v3.add(p, v3.scale(n, r)), n, color, gloss);
    }
  }
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    g.quad(base + k, base + k1, base + sides + k1, base + sides + k);
  }
}

/** A cow grazing, head down: about 2.3 m nose to tail, 1.4 m at the withers. */
export function cow(): Geo {
  const g = new Geo();
  ellipsoid(g, [0, 1.02, 0], [1.0, 0.4, 0.34], PAINT, 0.1, 7, 10);
  ellipsoid(g, [-0.62, 1.06, 0], [0.42, 0.36, 0.33], PAINT, 0.1); // hindquarters
  ellipsoid(g, [0.55, 1.04, 0], [0.42, 0.38, 0.31], PAINT, 0.1); // shoulders
  ellipsoid(g, [-0.05, 0.72, 0.12], [0.34, 0.16, 0.14], [0.55, 0.42, 0.38], 0.3, 4, 7); // udder
  member(g, [0.85, 1.05, 0], [1.25, 0.62, 0], 0.22, 0.16, PAINT); // neck, lowered to graze
  ellipsoid(g, [1.36, 0.42, 0], [0.26, 0.15, 0.12], PAINT, 0.1, 5, 8);
  ellipsoid(g, [1.55, 0.3, 0], [0.1, 0.09, 0.1], MUZZLE, 0.4, 4, 7);
  for (const s of [-1, 1]) {
    ellipsoid(g, [1.2, 0.58, s * 0.16], [0.05, 0.03, 0.09], PAINT, 0.2, 3, 6); // ears
    member(g, [1.22, 0.62, s * 0.08], [1.18, 0.7, s * 0.18], 0.02, 0.008, HORN, 4);
  }
  for (const [x, z] of [[0.62, 0.17], [0.62, -0.17], [-0.68, 0.18], [-0.68, -0.18]]) {
    member(g, [x, 0.95, z], [x + 0.02, 0.12, z], 0.085, 0.06, PAINT);
    member(g, [x + 0.02, 0.12, z], [x + 0.02, 0, z], 0.06, 0.065, HOOF);
  }
  member(g, [-1.0, 1.25, 0], [-1.08, 0.62, 0], 0.03, 0.02, PAINT, 4); // tail
  ellipsoid(g, [-1.09, 0.55, 0], [0.04, 0.09, 0.04], [0.06, 0.05, 0.04], 0.2, 3, 5);
  return g;
}

/** A cow lying down, chewing the cud, head up. */
export function cowLying(): Geo {
  const g = new Geo();
  ellipsoid(g, [0, 0.46, 0], [1.0, 0.42, 0.42], PAINT, 0.1, 7, 10);
  ellipsoid(g, [-0.6, 0.44, 0.04], [0.45, 0.4, 0.44], PAINT, 0.1);
  member(g, [0.75, 0.62, 0], [1.05, 0.98, 0], 0.22, 0.17, PAINT);
  ellipsoid(g, [1.15, 0.95, 0], [0.26, 0.15, 0.12], PAINT, 0.1, 5, 8);
  ellipsoid(g, [1.36, 0.88, 0], [0.1, 0.09, 0.1], MUZZLE, 0.4, 4, 7);
  for (const s of [-1, 1]) ellipsoid(g, [1.0, 1.08, s * 0.16], [0.05, 0.03, 0.09], PAINT, 0.2, 3, 6);
  // folded forelegs
  for (const s of [-1, 1]) member(g, [0.55, 0.12, s * 0.3], [0.95, 0.1, s * 0.22], 0.08, 0.07, PAINT);
  return g;
}

/** A ewe in her fleece. */
export function sheep(): Geo {
  const g = new Geo();
  const face: Vec3 = [0.06, 0.055, 0.05];
  ellipsoid(g, [0, 0.66, 0], [0.56, 0.31, 0.29], PAINT, 0.1, 6, 9);
  ellipsoid(g, [0.42, 0.72, 0], [0.24, 0.24, 0.24], PAINT, 0.1, 4, 7);
  member(g, [0.5, 0.74, 0], [0.7, 0.5, 0], 0.1, 0.08, face, 5);
  ellipsoid(g, [0.76, 0.44, 0], [0.15, 0.09, 0.08], face, 0.25, 4, 7);
  for (const s of [-1, 1]) ellipsoid(g, [0.66, 0.55, s * 0.1], [0.03, 0.02, 0.07], face, 0.2, 3, 5);
  for (const [x, z] of [[0.32, 0.13], [0.32, -0.13], [-0.34, 0.13], [-0.34, -0.13]]) member(g, [x, 0.5, z], [x, 0, z], 0.04, 0.03, face, 5);
  return g;
}

/** A round bale lying on its side, 1.5 m across and 1.2 m wide; wrapped bales take the instance colour. */
export function roundBale(wrapped: boolean): Geo {
  const g = new Geo();
  const r = 0.75;
  const hw = 0.6;
  const side: Vec3 = wrapped ? PAINT : [0.46, 0.38, 0.21];
  const end: Vec3 = wrapped ? PAINT : [0.36, 0.29, 0.15];
  const gloss = wrapped ? 0.7 : 0.08;
  const S = 14;
  const ring = (z: number, nz: number, color: Vec3, inset: number) => {
    const out: number[] = [];
    for (let k = 0; k < S; k++) {
      const a = (k / S) * Math.PI * 2;
      const n: Vec3 = nz === 0 ? [Math.cos(a), Math.sin(a), 0] : [0, 0, nz];
      out.push(g.vertex([Math.cos(a) * (r - inset), r + Math.sin(a) * (r - inset), z], n, color, gloss));
    }
    return out;
  };
  // the rounded face, slightly barrelled at the edges
  const a0 = ring(-hw, 0, side, 0.04);
  const a1 = ring(-hw + 0.12, 0, side, 0);
  const a2 = ring(hw - 0.12, 0, side, 0);
  const a3 = ring(hw, 0, side, 0.04);
  for (const [p, q] of [[a0, a1], [a1, a2], [a2, a3]]) for (let k = 0; k < S; k++) g.quad(p[k], p[(k + 1) % S], q[(k + 1) % S], q[k]);
  // flat ends, the straw rolled in a spiral (darker centre)
  for (const [z, nz] of [[hw, 1], [-hw, -1]] as [number, number][]) {
    const rim = ring(z, nz, end, 0.04);
    const centre = g.vertex([0, r, z], [0, 0, nz], wrapped ? end : [0.27, 0.21, 0.1], gloss);
    for (let k = 0; k < S; k++) {
      if (nz > 0) g.tri(centre, rim[k], rim[(k + 1) % S]);
      else g.tri(centre, rim[(k + 1) % S], rim[k]);
    }
  }
  return g;
}
