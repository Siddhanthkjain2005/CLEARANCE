// The motorway from the city to the airport and on east: two carriageways of
// two lanes and a hard shoulder either side of a concrete central barrier,
// with edge lines and broken lane lines, steel guard rails, lighting columns
// down the central reserve, piers where it rides above wet ground and
// overhead sign gantries. It follows the same rounded centreline the traffic
// drives on.

import { Geo } from '../gl.ts';
import { type Vec3 } from '../math.ts';
import { motorwayDeckHeight } from './city.ts';
import { motorwayLine, type P2 } from './lines.ts';
import { WATER_LEVEL, heightAt } from './terrain.ts';

const HALF = 11;
const ASPHALT: Vec3 = [0.05, 0.058, 0.066];
const CONCRETE: Vec3 = [0.36, 0.36, 0.34];
const BARRIER: Vec3 = [0.5, 0.5, 0.47];
const WHITE: Vec3 = [0.66, 0.66, 0.6];
const STEEL: Vec3 = [0.45, 0.48, 0.5];
const SIGN: Vec3 = [0.03, 0.12, 0.42];
const LAMP: Vec3 = [0.95, 0.72, 0.42];

/** Deck height at a point on the carriageway with normal n (matches the traffic's lanes). */
export function deckAt(x: number, z: number, n: P2): number {
  return Math.max(
    motorwayDeckHeight(x, z),
    heightAt(x + n[0] * HALF, z + n[1] * HALF) + 0.25,
    heightAt(x - n[0] * HALF, z - n[1] * HALF) + 0.25,
  );
}

export function buildMotorway(): Geo {
  const g = new Geo();
  const line = motorwayLine();
  const norms: P2[] = line.map((_, i) => {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  });
  const ys = line.map((p, i) => deckAt(p[0], p[1], norms[i]));
  const at = (i: number, off: number, lift: number): Vec3 => [line[i][0] + norms[i][0] * off, ys[i] + lift, line[i][1] + norms[i][1] * off];
  const band = (i: number, a: number, b: number, lift: number, color: Vec3, gloss = 0.12) => {
    g.face([at(i, a, lift), at(i, b, lift), at(i + 1, b, lift), at(i + 1, a, lift)], color, gloss);
  };
  let s = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    // verges, then the carriageways either side of the central reserve
    band(i, -HALF - 1.3, -HALF, 0, CONCRETE);
    band(i, HALF, HALF + 1.3, 0, CONCRETE);
    band(i, -HALF, -0.6, 0.035, ASPHALT, 0.16);
    band(i, 0.6, HALF, 0.035, ASPHALT, 0.16);
    // edge lines and broken lane lines
    for (const side of [-1, 1]) {
      for (const e of [0.9, 8.3]) band(i, side * e - 0.08, side * e + 0.08, 0.06, WHITE, 0.2);
      if (Math.floor(s / 10) % 2 === 0) band(i, side * 4.6 - 0.07, side * 4.6 + 0.07, 0.06, WHITE, 0.2);
    }
    // central concrete barrier, sloped faces and a narrow top
    g.face([at(i, -0.6, 0.03), at(i + 1, -0.6, 0.03), at(i + 1, -0.18, 0.88), at(i, -0.18, 0.88)].reverse() as Vec3[], BARRIER, 0.18);
    g.face([at(i, 0.6, 0.03), at(i + 1, 0.6, 0.03), at(i + 1, 0.18, 0.88), at(i, 0.18, 0.88)], BARRIER, 0.18);
    g.face([at(i, -0.18, 0.88), at(i + 1, -0.18, 0.88), at(i + 1, 0.18, 0.88), at(i, 0.18, 0.88)].reverse() as Vec3[], BARRIER, 0.18);
    // guard rails: a W-beam on short posts outside each hard shoulder
    for (const side of [-1, 1]) {
      const o = side * (HALF + 0.5);
      const rail = [at(i, o, 0.55), at(i + 1, o, 0.55), at(i + 1, o, 0.85), at(i, o, 0.85)];
      g.face(side > 0 ? rail : (rail.reverse() as Vec3[]), STEEL, 0.55);
      if (i % 4 === 0) {
        const p = at(i, o + side * 0.12, 0);
        g.box([p[0] - 0.06, p[1] - 0.2, p[2] - 0.06], [p[0] + 0.06, p[1] + 0.8, p[2] + 0.06], STEEL, 0.4);
      }
    }
    // piers under the elevated spans
    const ground = heightAt(line[i][0], line[i][1]);
    if (ys[i] - Math.max(ground, WATER_LEVEL) > 3 && i % 3 === 0) {
      const c = at(i, 0, 0);
      for (const side of [-1, 1]) {
        const q = at(i, side * 6, 0);
        g.box([q[0] - 0.9, Math.max(ground, WATER_LEVEL) - 3, q[2] - 0.9], [q[0] + 0.9, ys[i] - 1.2, q[2] + 0.9], CONCRETE, 0.2);
      }
      g.box([c[0] - 1.4, ys[i] - 1.6, c[2] - 1.4], [c[0] + 1.4, ys[i] - 0.05, c[2] + 1.4], CONCRETE, 0.2);
    }
    s += seg;
  }
  // deck fascia over elevated stretches
  for (let i = 0; i < line.length - 1; i++) {
    if (ys[i] - heightAt(line[i][0], line[i][1]) < 2) continue;
    for (const side of [-1, 1]) {
      const f = [at(i, side * (HALF + 1.3), 0.02), at(i + 1, side * (HALF + 1.3), 0.02), at(i + 1, side * (HALF + 1.3), -1.4), at(i, side * (HALF + 1.3), -1.4)];
      g.face(side > 0 ? (f.reverse() as Vec3[]) : f, CONCRETE, 0.2);
    }
  }
  // lighting columns in the central reserve, double-armed
  for (const i of lampIndices(line)) {
    const c = at(i, 0, 0.88);
    const n = norms[i];
    g.box([c[0] - 0.12, c[1], c[2] - 0.12], [c[0] + 0.12, c[1] + 11.5, c[2] + 0.12], STEEL, 0.45);
    for (const side of [-1, 1]) {
      const end: Vec3 = [c[0] + n[0] * side * 2.4, c[1] + 11.6, c[2] + n[1] * side * 2.4];
      g.box([Math.min(c[0], end[0]) - 0.05, c[1] + 11.4, Math.min(c[2], end[2]) - 0.05], [Math.max(c[0], end[0]) + 0.05, c[1] + 11.5, Math.max(c[2], end[2]) + 0.05], STEEL, 0.45);
      g.box([end[0] - 0.35, end[1] - 0.3, end[2] - 0.35], [end[0] + 0.35, end[1] - 0.12, end[2] + 0.35], STEEL, 0.45);
      g.face([[end[0] - 0.3, end[1] - 0.31, end[2] - 0.3], [end[0] + 0.3, end[1] - 0.31, end[2] - 0.3], [end[0] + 0.3, end[1] - 0.31, end[2] + 0.3], [end[0] - 0.3, end[1] - 0.31, end[2] + 0.3]], LAMP, 0.3, 0.7);
    }
  }
  // sign gantries spanning both carriageways
  for (const i of gantryIndices(line)) {
    const n = norms[i];
    const dir: P2 = [n[1], -n[0]];
    for (const side of [-1, 1]) {
      const p = at(i, side * (HALF + 0.9), 0);
      g.box([p[0] - 0.25, p[1], p[2] - 0.25], [p[0] + 0.25, p[1] + 7.4, p[2] + 0.25], STEEL, 0.4);
    }
    const a = at(i, -HALF - 0.9, 7.0);
    const b = at(i, HALF + 0.9, 7.0);
    g.box([Math.min(a[0], b[0]) - 0.2, a[1], Math.min(a[2], b[2]) - 0.2], [Math.max(a[0], b[0]) + 0.2, a[1] + 0.5, Math.max(a[2], b[2]) + 0.2], STEEL, 0.4);
    // a blue direction board over each carriageway, facing its oncoming traffic
    for (const side of [-1, 1]) {
      const c = at(i, side * 4.6, 7.2);
      const face = side; // eastbound (+) traffic sees the -dir face
      const off: Vec3 = [-dir[0] * face * 0.3, 0, -dir[1] * face * 0.3];
      const w: Vec3 = [n[0] * 3.4, 0, n[1] * 3.4];
      const p0: Vec3 = [c[0] + off[0] - w[0], c[1] - 1.6, c[2] + off[2] - w[2]];
      const p1: Vec3 = [c[0] + off[0] + w[0], c[1] - 1.6, c[2] + off[2] + w[2]];
      const p2: Vec3 = [p1[0], c[1] + 1.4, p1[2]];
      const p3: Vec3 = [p0[0], c[1] + 1.4, p0[2]];
      const quad = [p0, p1, p2, p3];
      g.face(face > 0 ? quad : (quad.reverse() as Vec3[]), SIGN, 0.4, 0.12);
      for (let k = 0; k < 3; k++) {
        const y = c[1] - 0.9 + k * 0.8;
        const l0: Vec3 = [c[0] + off[0] * 1.05 - w[0] * 0.8, y, c[2] + off[2] * 1.05 - w[2] * 0.8];
        const l1: Vec3 = [c[0] + off[0] * 1.05 + w[0] * (0.2 + k * 0.15), y, c[2] + off[2] * 1.05 + w[2] * (0.2 + k * 0.15)];
        const strip = [l0, l1, [l1[0], y + 0.28, l1[2]] as Vec3, [l0[0], y + 0.28, l0[2]] as Vec3];
        g.face(face > 0 ? strip : (strip.reverse() as Vec3[]), [0.85, 0.86, 0.84], 0.3, 0.35);
      }
    }
  }
  return g;
}

function lampIndices(line: P2[]): number[] {
  const out: number[] = [];
  let s = 0;
  let next = 20;
  for (let i = 0; i < line.length - 1; i++) {
    if (s >= next) {
      out.push(i);
      next += 60;
    }
    s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  }
  return out;
}

function gantryIndices(line: P2[]): number[] {
  const out: number[] = [];
  let s = 0;
  let next = 900;
  for (let i = 0; i < line.length - 1; i++) {
    if (s >= next) {
      out.push(i);
      next += 2100;
    }
    s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  }
  return out;
}

/** The lighting columns' lamps (POINTS_VS records). */
export function buildMotorwayLights(): number[] {
  const out: number[] = [];
  const line = motorwayLine();
  for (const i of lampIndices(line)) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n: P2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    const y = deckAt(line[i][0], line[i][1], n) + 0.88 + 11.25;
    for (const side of [-1, 1]) out.push(line[i][0] + n[0] * side * 2.4, y, line[i][1] + n[1] * side * 2.4, LAMP[0], LAMP[1], LAMP[2], 1.5, 5.32);
  }
  return out;
}
