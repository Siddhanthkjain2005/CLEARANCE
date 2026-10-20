// A narrow-body twinjet built from its real proportions (37.6 m long, 35.8 m
// span with sharklets, 3.95 m fuselage): lofted fuselage with a drooped nose
// and upswept tail cone, cranked and swept wings on NACA sections, sharklets,
// high-bypass nacelles on pylons, stabilisers, fin, landing gear, cabin and
// cockpit windows, and anchors for every external light.
//
// Model space: +x forward, +y up, +z right (starboard). The origin is on the
// fuselage centreline above the main gear; the tyres touch y = -3.6.

import { Geo } from '../gl.ts';
import { type Vec3, v3 } from '../math.ts';

/** Vertex colour that LIT_FS replaces with the operator's livery colour. */
const LIVERY: Vec3 = [1, 0, 1];
const WHITE: Vec3 = [0.86, 0.87, 0.88];
/** Fuselage paint: LIT_FS recognises this exact colour and paints the livery over it. */
export const FUSE: Vec3 = [0.861, 0.871, 0.881];
const BELLY: Vec3 = [0.6, 0.62, 0.65];
const WING: Vec3 = [0.66, 0.68, 0.71];
const DARK: Vec3 = [0.035, 0.038, 0.045];
const METAL: Vec3 = [0.4, 0.4, 0.42];

export const GEAR_HEIGHT = 3.6;

/**
 * Joins rings of equal length with quads. Normals come from the surface
 * parameterisation and are oriented away from each ring's centroid, and every
 * quad is wound to agree with them, so the result is smooth and front-facing.
 */
function loft(g: Geo, rings: Vec3[][], colorAt: (ring: number, k: number, p: Vec3) => Vec3, gloss: number, closed = true, emissive = 0) {
  const n = rings[0].length;
  const base = g.count;
  const centroid = rings.map((ring) => v3.scale(ring.reduce((a, p) => v3.add(a, p), [0, 0, 0] as Vec3), 1 / ring.length));
  for (let i = 0; i < rings.length; i++) {
    for (let k = 0; k < n; k++) {
      const p = rings[i][k];
      const along = v3.sub(rings[Math.min(rings.length - 1, i + 1)][k], rings[Math.max(0, i - 1)][k]);
      const kn = closed ? (k + 1) % n : Math.min(n - 1, k + 1);
      const kp = closed ? (k - 1 + n) % n : Math.max(0, k - 1);
      const around = v3.sub(rings[i][kn], rings[i][kp]);
      let nrm = v3.norm(v3.cross(along, around));
      const out = v3.sub(p, centroid[i]);
      if (v3.len(nrm) < 0.5 || !Number.isFinite(nrm[0])) nrm = v3.norm(out);
      if (v3.dot(nrm, out) < 0) nrm = v3.scale(nrm, -1);
      g.vertex(p, nrm, colorAt(i, k, p), gloss, emissive);
    }
  }
  const at = (i: number, k: number) => base + i * n + k;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % n;
      const a = at(i, k), b = at(i + 1, k), c = at(i + 1, k1), d = at(i, k1);
      const pa = rings[i][k], pb = rings[i + 1][k], pc = rings[i + 1][k1];
      const face = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
      const avg = v3.sub(pa, centroid[i]);
      if (v3.dot(face, avg) >= 0) g.quad(a, b, c, d);
      else g.quad(a, d, c, b);
    }
  }
}

/** Fan cap over a ring, facing `dir`. */
function cap(g: Geo, ring: Vec3[], dir: Vec3, color: Vec3, gloss = 0.3) {
  const c = v3.scale(ring.reduce((a, p) => v3.add(a, p), [0, 0, 0] as Vec3), 1 / ring.length);
  const n = v3.norm(dir);
  const ci = g.vertex(c, n, color, gloss);
  const idx = ring.map((p) => g.vertex(p, n, color, gloss));
  for (let k = 0; k < ring.length; k++) {
    const a = idx[k];
    const b = idx[(k + 1) % ring.length];
    const face = v3.cross(v3.sub(ring[k], c), v3.sub(ring[(k + 1) % ring.length], c));
    if (v3.dot(face, n) >= 0) g.tri(ci, a, b);
    else g.tri(ci, b, a);
  }
}

// ------------------------------------------------------------------ fuselage

const NOSE = 18.0;
const TAIL = -19.6;
const R = 1.98;

/** Fuselage cross-section at station x: centre height and radius. */
function section(x: number): { cy: number; r: number } {
  if (x > 12.6) {
    const t = Math.min(1, (NOSE - x) / (NOSE - 12.6));
    const r = R * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    return { cy: -0.38 * Math.pow(1 - t, 1.6), r: Math.max(0.04, r) };
  }
  if (x < -8.4) {
    const t = Math.min(1, (-8.4 - x) / (-8.4 - TAIL));
    const top = R - 0.42 * t * t;
    const bottom = -R + (R + 1.06) * Math.pow(t, 1.25);
    return { cy: (top + bottom) / 2, r: Math.max(0.12, (top - bottom) / 2) };
  }
  return { cy: 0, r: R };
}

/** Point on the fuselage skin at station x, angle a (0 = top, +pi/2 = starboard). */
function skin(x: number, a: number, lift = 0): Vec3 {
  const { cy, r } = section(x);
  return [x, cy + (r * 1.03 + lift) * Math.cos(a), (r + lift) * Math.sin(a)];
}

function fuselage(g: Geo) {
  const xs: number[] = [];
  for (let i = 0; i <= 16; i++) xs.push(NOSE - (NOSE - 12.6) * (1 - Math.cos((i / 16) * Math.PI / 2)));
  for (const x of [9, 4, 0, -4, -8.4]) xs.push(x);
  for (let i = 1; i <= 14; i++) xs.push(-8.4 + (TAIL + 8.4) * (i / 14));
  const SEG = 44;
  const rings = xs.map((x) => Array.from({ length: SEG }, (_, k) => skin(x, (k / SEG) * Math.PI * 2)));
  loft(g, rings, () => FUSE, 0.78);
  cap(g, rings[rings.length - 1], [-1, 0.2, 0], METAL);

  // cabin windows: warm, lit from inside
  const warm: Vec3 = [1.0, 0.8, 0.55];
  const doors = [[12.4, 11.2], [3.0, 1.2], [-11.4, -12.6]];
  for (const side of [1, -1]) {
    for (let x = 11.0; x > -11.4; x -= 0.53) {
      if (doors.some(([a, b]) => x < a && x > b)) continue;
      panel(g, [skin(x - 0.12, side * 1.2, 0.012), skin(x + 0.12, side * 1.2, 0.012), skin(x + 0.12, side * 1.33, 0.012), skin(x - 0.12, side * 1.33, 0.012)], warm, 0.2, 1.4);
    }
    // doors read as slightly darker panels
    for (const [a, b] of doors) {
      const half = a - b < 1.5 ? 0.45 : 0.55;
      const mid = (a + b) / 2;
      panel(g, [skin(mid - half, side * 0.62, 0.008), skin(mid + half, side * 0.62, 0.008), skin(mid + half, side * 1.62, 0.008), skin(mid - half, side * 1.62, 0.008)], [0.7, 0.71, 0.73], 0.6, 0);
    }
  }
  // cockpit glazing: six panes wrapping the nose
  const panes: [number, number, number, number][] = [
    [16.25, 15.5, 0.06, 0.64], [15.42, 14.65, 0.72, 1.06], [14.55, 14.0, 1.12, 1.3],
  ];
  for (const side of [1, -1]) {
    for (const [xa, xb, a0, a1] of panes) {
      panel(g, [skin(xa, side * a0, 0.015), skin(xb, side * a0, 0.015), skin(xb, side * a1, 0.015), skin(xa, side * a1, 0.015)], [0.015, 0.02, 0.025], 1.0, 0.0);
    }
  }
}

/** A flat panel over the skin, wound to face away from the fuselage axis. */
function panel(g: Geo, p: Vec3[], color: Vec3, gloss: number, emissive: number) {
  const mid = v3.scale(p.reduce((a, q) => v3.add(a, q), [0, 0, 0] as Vec3), 0.25);
  const out = v3.norm([0, mid[1] - section(mid[0]).cy, mid[2]]);
  let n = v3.norm(v3.cross(v3.sub(p[1], p[0]), v3.sub(p[2], p[0])));
  const flip = v3.dot(n, out) < 0;
  if (flip) n = v3.scale(n, -1);
  const idx = p.map((q) => g.vertex(q, n, color, gloss, emissive));
  if (flip) g.quad(idx[0], idx[3], idx[2], idx[1]);
  else g.quad(idx[0], idx[1], idx[2], idx[3]);
}

// ------------------------------------------------------------------ lifting surfaces

/** NACA 4-digit half-thickness at chord fraction x for thickness ratio t. */
function naca(x: number, t: number): number {
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

const CHORD = [0, 0.012, 0.04, 0.09, 0.16, 0.26, 0.38, 0.52, 0.66, 0.8, 0.92, 1];

/**
 * Airfoil ring. `le` is the leading-edge point, `chord` its length along -x,
 * `t` thickness ratio, `camber` as a fraction of chord. `axis` 'y' puts the
 * thickness vertical (wings), 'z' sideways (fin).
 */
function airfoil(le: Vec3, chord: number, t: number, camber: number, axis: 'y' | 'z' = 'y'): Vec3[] {
  const up: Vec3[] = [];
  const lo: Vec3[] = [];
  for (const c of CHORD) {
    const yt = naca(Math.max(c, 0.0005), t) * chord;
    const yc = camber * chord * 4 * c * (1 - c);
    const x = le[0] - c * chord;
    if (axis === 'y') {
      up.push([x, le[1] + yc + yt, le[2]]);
      lo.push([x, le[1] + yc - yt, le[2]]);
    } else {
      up.push([x, le[1], le[2] + yt]);
      lo.push([x, le[1], le[2] - yt]);
    }
  }
  // trailing edge to leading edge on top, then back along the bottom
  return [...up.slice().reverse(), ...lo.slice(1, -1)];
}

function wing(g: Geo, side: 1 | -1) {
  const tan27 = Math.tan((27 * Math.PI) / 180);
  const tan25 = Math.tan((25 * Math.PI) / 180);
  const dihedral = Math.tan((5.1 * Math.PI) / 180);
  const y = (z: number) => -1.28 + (z - 1.6) * dihedral;
  const st = (z: number, le: number, chord: number, t: number, camber = 0.022): Vec3[] => airfoil([le, y(z), side * z], chord, t, camber);
  const rootLe = 3.1;
  const kinkZ = 6.3;
  const kinkLe = rootLe - (kinkZ - 1.6) * tan27;
  const tipZ = 17.05;
  const tipLe = kinkLe - (tipZ - kinkZ) * tan25;
  const sections: Vec3[][] = [
    st(1.6, rootLe, 6.6, 0.15),
    st(kinkZ, kinkLe, 4.45, 0.13),
    st(10.5, kinkLe - (10.5 - kinkZ) * tan25, 3.2, 0.12),
    st(14.5, kinkLe - (14.5 - kinkZ) * tan25, 2.15, 0.11),
    st(tipZ, tipLe, 1.55, 0.105),
  ];
  // sharklet: blends up and back from the tip
  const tipY = y(tipZ);
  const blend: Vec3[] = airfoil([tipLe - 0.15, tipY + 0.55, side * (tipZ + 0.32)], 1.25, 0.09, 0.0).map((p) => p);
  const top: Vec3[] = airfoil([tipLe - 1.25, tipY + 2.5, side * (tipZ + 0.55)], 0.62, 0.08, 0.0);
  loft(g, sections, () => WING, 0.55, true);
  loft(g, [sections[sections.length - 1], blend, top], (i) => (i === 0 ? WING : LIVERY), 0.6, true, 0.05);
  cap(g, top, [0, 1, 0], LIVERY);
  cap(g, sections[0], [0, 0, -side], WING);
  // flap track fairings under the wing
  for (const z of [4.2, 8.2, 11.4, 14.0]) {
    const le = kinkLe - Math.max(0, z - kinkZ) * tan25 - (z < kinkZ ? (z - 1.6) * tan27 - (kinkZ - 1.6) * tan27 : 0);
    const chord = z < kinkZ ? 5.2 : 3.4 - (z - kinkZ) * 0.12;
    const x0 = le - chord * 0.55;
    const x1 = le - chord * 1.12;
    const yy = y(z) - 0.12;
    g.box([x1, yy - 0.32, side * z - 0.13], [x0, yy, side * z + 0.13], WING, 0.4);
  }
}

function tailplane(g: Geo, side: 1 | -1) {
  const tan29 = Math.tan((29 * Math.PI) / 180);
  const dihedral = Math.tan((6 * Math.PI) / 180);
  const st = (z: number, chord: number) => airfoil([-15.25 - (z - 0.4) * tan29, 1.1 + (z - 0.4) * dihedral, side * z], chord, 0.1, 0);
  const s = [st(0.4, 3.7), st(3.2, 2.6), st(6.2, 1.35)];
  loft(g, s, () => WHITE, 0.6, true);
  cap(g, s[2], [0, 0, side], WHITE);
}

function fin(g: Geo) {
  const tan34 = Math.tan((34 * Math.PI) / 180);
  const st = (y: number, chord: number) => airfoil([-12.0 - (y - 1.5) * tan34, y, 0], chord, 0.11, 0, 'z');
  const s = [st(1.5, 6.9), st(4.5, 4.6), st(8.25, 2.55)];
  // dorsal fillet blending the fin into the fuselage
  const fillet = airfoil([-9.6, 1.62, 0], 9.0, 0.035, 0, 'z');
  loft(g, [fillet, s[0]], () => LIVERY, 0.65, true, 0.1);
  loft(g, s, () => LIVERY, 0.65, true, 0.12);
  cap(g, s[2], [0, 1, 0], LIVERY);
}

// ------------------------------------------------------------------ engines

function engine(g: Geo, side: 1 | -1) {
  const z = side * 5.75;
  const cy = -2.15;
  const SEG = 28;
  const ring = (x: number, r: number, dy = 0): Vec3[] => Array.from({ length: SEG }, (_, k) => {
    const a = (k / SEG) * Math.PI * 2;
    // nacelles are slightly flattened at the bottom for ground clearance
    const flat = Math.cos(a) < -0.5 ? 0.94 : 1;
    return [x, cy + dy + r * Math.cos(a) * flat, z + r * Math.sin(a)] as Vec3;
  });
  const outer = [ring(4.35, 0.86), ring(4.28, 0.98), ring(4.05, 1.06), ring(3.3, 1.1), ring(2.2, 1.07), ring(1.2, 0.97), ring(0.35, 0.8), ring(-0.15, 0.66)];
  loft(g, outer, (i) => (i < 1 ? [0.75, 0.76, 0.78] : LIVERY), 0.7, true, 0.02);
  // intake lip turning inward, then the dark fan face and spinner
  const lip = [ring(4.35, 0.86), ring(4.25, 0.8), ring(3.95, 0.79)];
  loft(g, lip, (i) => (i === 0 ? [0.75, 0.76, 0.78] : DARK), 0.6, true);
  cap(g, ring(3.95, 0.79), [1, 0, 0], [0.05, 0.05, 0.06], 0.5);
  const spinner = [ring(3.97, 0.3), ring(4.25, 0.18), ring(4.42, 0.02)];
  loft(g, spinner, () => [0.5, 0.5, 0.52], 0.8, true);
  // core cowl and exhaust plug
  const core = [ring(-0.15, 0.62), ring(-0.9, 0.55), ring(-1.6, 0.42)];
  loft(g, core, () => [0.32, 0.32, 0.34], 0.5, true);
  const plug = [ring(-1.6, 0.3), ring(-2.2, 0.16), ring(-2.55, 0.02)];
  loft(g, plug, () => [0.22, 0.2, 0.19], 0.4, true);
  cap(g, ring(-1.6, 0.42), [-1, 0, 0], [0.04, 0.04, 0.045]);
  // pylon
  g.box([-1.4, cy + 0.85, z - 0.2], [2.9, -1.02, z + 0.2], WHITE, 0.5);
}

// ------------------------------------------------------------------ landing gear

function wheel(g: Geo, cx: number, cy: number, cz: number, r: number, w: number) {
  const SEG = 16;
  const ring = (zz: number, rr: number): Vec3[] => Array.from({ length: SEG }, (_, k) => {
    const a = (k / SEG) * Math.PI * 2;
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, zz] as Vec3;
  });
  loft(g, [ring(cz - w / 2, r * 0.82), ring(cz - w / 2 + 0.04, r), ring(cz + w / 2 - 0.04, r), ring(cz + w / 2, r * 0.82)], () => [0.025, 0.025, 0.028], 0.15, true);
  cap(g, ring(cz - w / 2, r * 0.82), [0, 0, -1], [0.38, 0.38, 0.4], 0.5);
  cap(g, ring(cz + w / 2, r * 0.82), [0, 0, 1], [0.38, 0.38, 0.4], 0.5);
}

function gear(g: Geo) {
  const strut: Vec3 = [0.62, 0.63, 0.65];
  // nose gear
  g.box([12.5, -3.25, -0.09], [12.72, -1.7, 0.09], strut, 0.5);
  g.box([12.2, -3.3, -0.36], [12.9, -3.14, 0.36], strut, 0.4);
  wheel(g, 12.55, -3.22, -0.26, 0.38, 0.24);
  wheel(g, 12.55, -3.22, 0.26, 0.38, 0.24);
  // nose gear doors
  g.box([11.0, -2.6, -0.62], [13.6, -1.75, -0.58], WHITE, 0.6);
  g.box([11.0, -2.6, 0.58], [13.6, -1.75, 0.62], WHITE, 0.6);
  // main gear
  for (const side of [1, -1]) {
    const z = side * 3.8;
    g.box([-0.95, -3.0, z - 0.14], [-0.6, -1.0, z + 0.14], strut, 0.5);
    g.box([-1.2, -2.0, z - side * 1.6], [-0.95, -1.75, z], strut, 0.4); // side brace
    g.box([-1.1, -3.12, z - 0.62], [-0.45, -2.92, z + 0.62], strut, 0.4);
    wheel(g, -0.78, -3.02, z - 0.46, 0.58, 0.4);
    wheel(g, -0.78, -3.02, z + 0.46, 0.58, 0.4);
    // leg door
    g.box([-1.6, -2.7, z + side * 0.3], [0.1, -1.1, z + side * 0.34], WHITE, 0.5);
  }
}

// ------------------------------------------------------------------ public

/** A control surface that rotates about a hinge line and slides along a track. */
export interface Hinged {
  geo: Geo;
  origin: Vec3;
  axis: Vec3; // unit, pointing to +z so a positive angle lowers the trailing edge
  slide: Vec3; // displacement at full extension
  angle: number; // rotation at full extension (radians)
}

export interface AirlinerModel {
  body: Geo;
  gear: Geo;
  flaps: Hinged[];
  spoilers: Hinged[];
  fan: Geo;
  fanCenters: Vec3[];
}

// wing planform, shared by the wing loft and its moving surfaces
const TAN27 = Math.tan((27 * Math.PI) / 180);
const TAN25 = Math.tan((25 * Math.PI) / 180);
const DIHEDRAL = Math.tan((5.1 * Math.PI) / 180);
const wingY = (z: number) => -1.28 + (z - 1.6) * DIHEDRAL;
const KINK_LE = 3.1 - (6.3 - 1.6) * TAN27;
function leadingEdge(z: number): number {
  return z <= 6.3 ? 3.1 - (z - 1.6) * TAN27 : KINK_LE - (z - 6.3) * TAN25;
}
function chordAt(z: number): number {
  if (z <= 6.3) return 6.6 + (4.45 - 6.6) * ((z - 1.6) / 4.7);
  if (z <= 10.5) return 4.45 + (3.2 - 4.45) * ((z - 6.3) / 4.2);
  if (z <= 14.5) return 3.2 + (2.15 - 3.2) * ((z - 10.5) / 4);
  return 2.15 + (1.55 - 2.15) * ((z - 14.5) / 2.55);
}
const trailingEdge = (z: number) => leadingEdge(z) - chordAt(z);

/** A tapered slab between two spanwise stations: leading edge hidden in the wing. */
function wingPanel(g: Geo, side: 1 | -1, z0: number, z1: number, chord: number, lift: number, thick: number, color: Vec3, top: boolean) {
  const pts = (z: number) => {
    const te = trailingEdge(z);
    const y = wingY(z) + lift;
    const le: Vec3 = [te + chord, y, side * z];
    const tail: Vec3 = [te - (top ? 0 : 0.05), y + (top ? 0 : 0.03), side * z];
    return { le, leLow: [le[0], le[1] - thick, le[2]] as Vec3, tail };
  };
  const a = pts(z0);
  const b = pts(z1);
  g.face([a.le, b.le, b.tail, a.tail].map((p) => p) as Vec3[], color, 0.55);
  g.face([a.leLow, a.tail, b.tail, b.leLow], color, 0.5);
  g.face([a.le, a.leLow, b.leLow, b.le], color, 0.5);
  g.face([a.le, a.tail, a.leLow], color, 0.5);
  g.face([b.le, b.leLow, b.tail], color, 0.5);
  const origin = top ? a.le : a.leLow;
  let axis = v3.norm(v3.sub(top ? b.le : b.leLow, origin));
  if (axis[2] < 0) axis = v3.scale(axis, -1);
  return { origin, axis };
}

function flap(side: 1 | -1, z0: number, z1: number): Hinged {
  const geo = new Geo();
  const { origin, axis } = wingPanel(geo, side, z0, z1, 1.05, -0.06, 0.16, WING, false);
  return { geo, origin, axis, slide: [-1.05, -0.18, 0], angle: 0.52 };
}

function spoiler(side: 1 | -1, z0: number, z1: number): Hinged {
  const geo = new Geo();
  const lift = 0.1;
  const { origin, axis } = wingPanel(geo, side, z0, z1, 1.25, lift, 0.04, [0.6, 0.62, 0.65], true);
  // move the panel forward onto the upper surface, ahead of the flaps
  const shift: Vec3 = [1.0, 0.02, 0];
  for (let i = 0; i < geo.data.length; i += 11) {
    geo.data[i] += shift[0];
    geo.data[i + 1] += shift[1];
  }
  return { geo, origin: v3.add(origin, shift), axis, slide: [0, 0, 0], angle: -0.85 };
}

/** Fan disc: twisted titanium blades around the spinner, spun per frame. */
function fanDisc(): Geo {
  const g = new Geo();
  const blades = 20;
  const metal: Vec3 = [0.3, 0.31, 0.33];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const at = (r: number, chord: number, twist: number): Vec3[] => {
      const tx = -sa;
      const tz = ca;
      const lead: Vec3 = [Math.sin(twist) * chord * 0.5, ca * r + tx * Math.cos(twist) * chord * 0.5, sa * r + tz * Math.cos(twist) * chord * 0.5];
      const trail: Vec3 = [-Math.sin(twist) * chord * 0.5, ca * r - tx * Math.cos(twist) * chord * 0.5, sa * r - tz * Math.cos(twist) * chord * 0.5];
      return [lead, trail];
    };
    const [l0, t0] = at(0.27, 0.22, 0.35);
    const [l1, t1] = at(0.78, 0.16, 1.05);
    g.face([l0, t0, t1, l1], metal, 0.7);
  }
  return g;
}

export function buildAirlinerParts(): Pick<AirlinerModel, 'flaps' | 'spoilers' | 'fan' | 'fanCenters'> {
  const flaps: Hinged[] = [];
  const spoilers: Hinged[] = [];
  for (const side of [-1, 1] as const) {
    flaps.push(flap(side, 2.15, 6.2));
    flaps.push(flap(side, 6.45, 12.6));
    spoilers.push(spoiler(side, 3.2, 6.0));
    spoilers.push(spoiler(side, 6.7, 11.8));
  }
  return { flaps, spoilers, fan: fanDisc(), fanCenters: [[4.02, -2.15, -5.75], [4.02, -2.15, 5.75]] };
}

export function buildAirliner(): AirlinerModel {
  const body = new Geo();
  fuselage(body);
  wing(body, 1);
  wing(body, -1);
  tailplane(body, 1);
  tailplane(body, -1);
  fin(body);
  engine(body, 1);
  engine(body, -1);
  // belly fairing between the wings
  const fair: Vec3[][] = [];
  for (const x of [4.6, 3.0, -2.0, -5.2, -6.6]) {
    const half = x > 4 || x < -6 ? 1.2 : 1.85;
    fair.push(Array.from({ length: 12 }, (_, k) => {
      const a = Math.PI * 0.5 + (k / 11) * Math.PI;
      return [x, -1.25 + Math.cos(a) * 0.55 * (half / 1.85) - 0.35, Math.sin(a) * half] as Vec3;
    }));
  }
  loft(body, fair, () => BELLY, 0.5, false);
  // antennas on the crown and belly
  body.box([4.5, 2.0, -0.04], [5.3, 2.32, 0.04], [0.3, 0.3, 0.32], 0.4);
  body.box([-6.2, 2.0, -0.04], [-5.6, 2.26, 0.04], [0.3, 0.3, 0.32], 0.4);
  body.box([7.5, -2.32, -0.04], [8.1, -2.03, 0.04], [0.3, 0.3, 0.32], 0.4);
  const g = new Geo();
  gear(g);
  return { body, gear: g, ...buildAirlinerParts() };
}

/** External lights in model space. Kinds match POINTS_VS. */
export const AIRLINER_LIGHTS = {
  navLeft: [-4.15, -0.05, -17.15] as Vec3,
  navRight: [-4.15, -0.05, 17.15] as Vec3,
  tail: [-19.7, 1.32, 0] as Vec3,
  strobeLeft: [-4.6, -0.05, -17.2] as Vec3,
  strobeRight: [-4.6, -0.05, 17.2] as Vec3,
  beaconTop: [-2.0, 2.08, 0] as Vec3,
  beaconBottom: [1.5, -2.12, 0] as Vec3,
  landingLeft: [2.4, -1.3, -2.7] as Vec3,
  landingRight: [2.4, -1.3, 2.7] as Vec3,
  taxi: [12.62, -1.95, 0] as Vec3,
  logoLeft: [-13.5, 2.2, -4.0] as Vec3,
  logoRight: [-13.5, 2.2, 4.0] as Vec3,
};
