// Everything that moves on the ground and the water: cars, vans, lorries and
// buses on the roads; tugs, baggage trains, fuel and catering trucks, belt
// loaders and apron buses airside; a regional electric train; barges and
// pleasure boats. Each model is built once at metre scale in its own frame
// (+x forward, +y up, +z right, origin on the ground under its centre) and
// drawn instanced. Body panels painted PAINT take each instance's own colour,
// so one mesh gives a whole car park of different cars.

import { Geo } from '../gl.ts';
import { v3, type Vec3 } from '../math.ts';

/** Vertex colour replaced by the instance colour in MOVER_VS. */
export const PAINT: Vec3 = [1, 0, 1];

const GLASS: Vec3 = [0.025, 0.04, 0.05];
const TYRE: Vec3 = [0.018, 0.02, 0.022];
const RIM: Vec3 = [0.42, 0.44, 0.45];
const TRIM: Vec3 = [0.04, 0.043, 0.047];
const METAL: Vec3 = [0.34, 0.36, 0.37];
const DARK: Vec3 = [0.07, 0.075, 0.08];
const WHITE: Vec3 = [0.74, 0.75, 0.74];
const HEAD: Vec3 = [1.0, 0.95, 0.85];
const TAIL: Vec3 = [0.85, 0.05, 0.03];
const AMBER: Vec3 = [0.95, 0.5, 0.06];
const YELLOW: Vec3 = [0.78, 0.6, 0.06];

type P2 = [number, number];

/**
 * A prism from a convex side profile (counter-clockwise in x/y), `hw` metres
 * either side of the centre plane. `band` colours the faces around the
 * outline edge by edge (null leaves an edge open, where another part covers it).
 */
function prism(g: Geo, profile: P2[], hw: number, side: Vec3, band: (i: number) => [Vec3, number, number] | null, sideGloss = 0.75, z0 = 0) {
  for (const s of [1, -1]) {
    const n: Vec3 = [0, 0, s];
    const idx = profile.map(([x, y]) => g.vertex([x, y, z0 + s * hw], n, side, sideGloss));
    for (let i = 1; i < idx.length - 1; i++) {
      if (s > 0) g.tri(idx[0], idx[i], idx[i + 1]);
      else g.tri(idx[0], idx[i + 1], idx[i]);
    }
  }
  for (let i = 0; i < profile.length; i++) {
    const b = band(i);
    if (!b) continue;
    const [p, q] = [profile[i], profile[(i + 1) % profile.length]];
    g.face([[p[0], p[1], z0 - hw], [q[0], q[1], z0 - hw], [q[0], q[1], z0 + hw], [p[0], p[1], z0 + hw]], b[0], b[1], b[2]);
  }
}

/** A cylinder along z (wheels, drums), closed at both ends. */
function wheel(g: Geo, x: number, y: number, z: number, radius: number, width: number, color = TYRE, hub = RIM, sides = 10) {
  const ring = (zz: number) => {
    const out: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      out.push(g.vertex([x + Math.cos(a) * radius, y + Math.sin(a) * radius, zz], [Math.cos(a), Math.sin(a), 0], color, 0.15));
    }
    return out;
  };
  const a = ring(z - width / 2);
  const b = ring(z + width / 2);
  for (let k = 0; k < sides; k++) g.quad(a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]);
  for (const [zz, s] of [[z - width / 2, -1], [z + width / 2, 1]] as [number, number][]) {
    const c = g.vertex([x, y, zz], [0, 0, s], hub, 0.5);
    const rim: number[] = [];
    for (let k = 0; k < sides; k++) {
      const an = (k / sides) * Math.PI * 2;
      const r = k % 2 ? radius * 0.62 : radius * 0.7;
      rim.push(g.vertex([x + Math.cos(an) * r, y + Math.sin(an) * r, zz + s * 0.004], [0, 0, s], hub, 0.5));
    }
    const tyre: number[] = [];
    for (let k = 0; k < sides; k++) {
      const an = (k / sides) * Math.PI * 2;
      tyre.push(g.vertex([x + Math.cos(an) * radius, y + Math.sin(an) * radius, zz], [0, 0, s], color, 0.15));
    }
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      if (s > 0) { g.tri(c, rim[k], rim[k1]); g.quad(rim[k], tyre[k], tyre[k1], rim[k1]); } else { g.tri(c, rim[k1], rim[k]); g.quad(rim[k1], tyre[k1], tyre[k], rim[k]); }
    }
  }
}

function axle(g: Geo, xs: number[], hw: number, r: number, w = 0.24) {
  for (const x of xs) for (const s of [-1, 1]) wheel(g, x, r, s * (hw - w / 2 + 0.03), r, w);
}

/** A lamp lens on a face pointing along ±x. */
function lamp(g: Geo, x: number, y0: number, y1: number, z0: number, z1: number, color: Vec3, emissive: number, facing: 1 | -1) {
  const p: Vec3[] = facing > 0
    ? [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]]
    : [[x, y0, z1], [x, y1, z1], [x, y1, z0], [x, y0, z0]];
  g.face(p, color, 0.6, emissive);
}

function lightsFrontRear(g: Geo, front: number, rear: number, y: number, hw: number, h = 0.13) {
  for (const s of [-1, 1]) {
    const za = s * (hw - 0.34);
    const zb = s * (hw - 0.06);
    lamp(g, front, y, y + h, Math.min(za, zb), Math.max(za, zb), HEAD, 0.6, 1);
    lamp(g, rear, y + 0.08, y + 0.08 + h, Math.min(za, zb), Math.max(za, zb), TAIL, 0.35, -1);
  }
}

// ------------------------------------------------------------------ road vehicles

export type CarShape = 'sedan' | 'hatch' | 'suv';

/** A passenger car: a painted lower body with bonnet and boot, a narrower glasshouse, mirrors and four wheels. */
export function car(shape: CarShape): Geo {
  const g = new Geo();
  const L = shape === 'hatch' ? 4.1 : shape === 'suv' ? 4.75 : 4.75;
  const hw = shape === 'suv' ? 0.95 : 0.9;
  const lift = shape === 'suv' ? 0.12 : 0;
  const belt = 0.97 + lift + (shape === 'suv' ? 0.08 : 0);
  const roof = shape === 'suv' ? 1.78 : shape === 'hatch' ? 1.48 : 1.44;
  const f = L / 2;
  const body: P2[] = [
    [-f + 0.08, 0.3 + lift], [f - 0.08, 0.3 + lift], [f + 0.02, 0.6 + lift], [f - 0.12, 0.8 + lift + (shape === 'suv' ? 0.1 : 0)],
    [f - (shape === 'hatch' ? 1.05 : 1.35), belt], [-f + (shape === 'hatch' ? 0.25 : 0.6), belt + 0.01], [-f + 0.06, belt - 0.07], [-f - 0.02, 0.62 + lift],
  ];
  prism(g, body, hw, PAINT, (i) => (i === 0 ? [TRIM, 0.1, 0] : i === 1 || i === 7 ? [TRIM, 0.3, 0] : [PAINT, 0.8, 0]), 0.8);
  const gh = hw - 0.15;
  const ws = f - (shape === 'hatch' ? 1.05 : 1.35);
  const glass: P2[] = shape === 'hatch'
    ? [[-f + 0.25, belt], [ws, belt], [ws - 0.72, roof], [-f + 0.42, roof - 0.03]]
    : shape === 'suv'
      ? [[-f + 0.5, belt], [ws, belt], [ws - 0.7, roof], [-f + 0.62, roof - 0.02]]
      : [[-f + 0.62, belt], [ws, belt], [ws - 0.78, roof], [-f + 1.45, roof + 0.01]];
  prism(g, glass, gh, GLASS, (i) => (i === 0 ? null : i === 2 ? [PAINT, 0.8, 0] : [GLASS, 0.9, 0]), 0.92);
  // pillars and a dark sill
  const bx = (glass[1][0] + glass[0][0]) / 2 - 0.15;
  for (const s of [-1, 1]) {
    g.box([bx, belt, s > 0 ? gh - 0.01 : -gh - 0.02], [bx + 0.12, roof - 0.02, s > 0 ? gh + 0.02 : -gh + 0.01], TRIM, 0.4);
    g.box([-f + 0.5, 0.3 + lift, s > 0 ? hw - 0.02 : -hw - 0.02], [f - 0.6, 0.42 + lift, s > 0 ? hw + 0.02 : -hw + 0.02], TRIM, 0.2);
    // door mirrors
    g.box([ws - 0.2, belt + 0.02, s > 0 ? hw - 0.05 : -hw - 0.15], [ws - 0.05, belt + 0.16, s > 0 ? hw + 0.15 : -hw + 0.05], PAINT, 0.8);
  }
  if (shape === 'suv') for (const s of [-1, 1]) g.box([-f + 0.8, roof, s * 0.62 - 0.03], [f - 1.9, roof + 0.06, s * 0.62 + 0.03], TRIM, 0.4);
  lightsFrontRear(g, f + 0.025, -f - 0.025, 0.62 + lift, hw);
  const r = shape === 'suv' ? 0.38 : 0.32;
  axle(g, [f - (shape === 'hatch' ? 0.78 : 0.95), -f + (shape === 'hatch' ? 0.72 : 0.92)], hw, r);
  return g;
}

/** A distant car: painted body and glasshouse as two blocks, no wheels. */
export function carLod(): Geo {
  const g = new Geo();
  g.box([-2.3, 0.25, -0.9], [2.3, 0.95, 0.9], PAINT, 0.8);
  g.box([-1.3, 0.95, -0.75], [0.9, 1.42, 0.75], GLASS, 0.9);
  g.box([-1.25, 1.42, -0.72], [0.85, 1.46, 0.72], PAINT, 0.8);
  return g;
}

/** A panel van with a sloping bonnet and a tall load box. */
export function van(): Geo {
  const g = new Geo();
  const f = 2.65;
  const hw = 1.0;
  const body: P2[] = [[-f, 0.35], [f - 0.05, 0.35], [f + 0.03, 0.75], [f - 0.35, 1.05], [f - 0.95, 1.55], [f - 1.45, 2.42], [-f, 2.42]];
  prism(g, body, hw, PAINT, (i) => (i === 0 ? [TRIM, 0.1, 0] : i === 4 ? [GLASS, 0.9, 0] : [PAINT, 0.65, 0]), 0.65);
  for (const s of [-1, 1]) {
    g.face(s > 0
      ? [[f - 1.6, 1.3, hw + 0.005], [f - 0.95, 1.3, hw + 0.005], [f - 1.4, 2.2, hw + 0.005], [f - 1.6, 2.2, hw + 0.005]]
      : [[f - 1.6, 2.2, -hw - 0.005], [f - 1.4, 2.2, -hw - 0.005], [f - 0.95, 1.3, -hw - 0.005], [f - 1.6, 1.3, -hw - 0.005]], GLASS, 0.9);
    g.box([-f + 0.3, 0.35, s > 0 ? hw - 0.02 : -hw - 0.02], [f - 0.5, 0.48, s > 0 ? hw + 0.02 : -hw + 0.02], TRIM, 0.2);
    g.box([f - 1.75, 1.4, s > 0 ? hw - 0.05 : -hw - 0.2], [f - 1.6, 1.6, s > 0 ? hw + 0.2 : -hw + 0.05], TRIM, 0.3);
  }
  lightsFrontRear(g, f + 0.035, -f - 0.01, 0.68, hw);
  axle(g, [f - 0.85, -f + 0.95], hw, 0.36);
  return g;
}

/** An articulated lorry: a cab-over tractor and a 13.6 m curtain-side trailer. */
export function lorry(): Geo {
  const g = new Geo();
  const hw = 1.26;
  // trailer from x = -8.3 to 5.3, tractor in front
  g.box([-8.3, 1.25, -hw], [5.3, 4.0, hw], [0.62, 0.63, 0.62], 0.35);
  g.box([-8.3, 3.55, -hw - 0.01], [5.3, 3.95, hw + 0.01], PAINT, 0.5);
  for (let x = -8.0; x < 5.2; x += 1.1) for (const s of [-1, 1]) g.box([x, 1.3, s * hw - 0.02], [x + 0.06, 3.5, s * hw + 0.02], [0.5, 0.51, 0.5], 0.3);
  g.box([-8.3, 0.9, -hw + 0.1], [5.3, 1.25, hw - 0.1], DARK, 0.2);
  g.box([-8.32, 1.3, -hw], [-8.3, 3.95, hw], [0.55, 0.56, 0.55], 0.3);
  // tractor
  const cab: P2[] = [[5.5, 0.85], [8.2, 0.85], [8.32, 1.6], [8.25, 3.2], [7.9, 3.55], [5.5, 3.55]];
  prism(g, cab, 1.24, PAINT, (i) => (i === 0 ? [DARK, 0.1, 0] : [PAINT, 0.7, 0]), 0.7);
  g.face([[8.33, 2.0, -1.05], [8.33, 2.95, -1.05], [8.33, 2.95, 1.05], [8.33, 2.0, 1.05]], GLASS, 0.9);
  for (const s of [-1, 1]) g.face(s > 0
    ? [[7.0, 2.0, 1.245], [8.1, 2.0, 1.245], [8.1, 2.9, 1.245], [7.0, 2.9, 1.245]]
    : [[8.1, 2.0, -1.245], [7.0, 2.0, -1.245], [7.0, 2.9, -1.245], [8.1, 2.9, -1.245]], GLASS, 0.9);
  g.box([5.4, 0.55, -1.0], [8.2, 0.9, 1.0], DARK, 0.2);
  lightsFrontRear(g, 8.34, -8.33, 0.95, hw);
  axle(g, [7.3, 5.9], hw, 0.5, 0.3);
  axle(g, [-4.6, -5.9, -7.2], hw, 0.5, 0.3);
  return g;
}

/** A twelve-metre city bus or a long-distance coach: a glazed band above a painted body. */
export function bus(coach: boolean): Geo {
  const g = new Geo();
  const f = coach ? 6.5 : 6.0;
  const hw = 1.27;
  const top = coach ? 3.6 : 3.1;
  const body: P2[] = [[-f, 0.4], [f, 0.4], [f + 0.05, 1.0], [f - 0.15, top - 0.1], [f - 0.4, top], [-f + 0.2, top], [-f, top - 0.2]];
  prism(g, body, hw, PAINT, (i) => (i === 0 ? [DARK, 0.1, 0] : [PAINT, 0.7, 0]), 0.7);
  // windscreen, side glazing and a dark skirt
  g.face([[f + 0.06, 1.15, -hw + 0.1], [f - 0.12, top - 0.2, -hw + 0.1], [f - 0.12, top - 0.2, hw - 0.1], [f + 0.06, 1.15, hw - 0.1]], GLASS, 0.9);
  const y0 = coach ? 1.9 : 1.3;
  for (const s of [-1, 1]) {
    const z = s * (hw + 0.006);
    g.face(s > 0 ? [[-f + 0.3, y0, z], [f - 0.4, y0, z], [f - 0.4, top - 0.25, z], [-f + 0.3, top - 0.25, z]] : [[f - 0.4, y0, z], [-f + 0.3, y0, z], [-f + 0.3, top - 0.25, z], [f - 0.4, top - 0.25, z]], GLASS, 0.9);
    for (let x = -f + 1.6; x < f - 0.6; x += coach ? 1.5 : 1.25) g.box([x, y0, z - 0.02], [x + 0.09, top - 0.25, z + 0.02], DARK, 0.3);
    g.box([-f, 0.4, s * hw - 0.02], [f, 0.62, s * hw + 0.02], DARK, 0.2);
  }
  if (!coach) g.box([-f + 1.5, top, -0.8], [-f + 4.5, top + 0.35, 0.8], [0.5, 0.51, 0.5], 0.3);
  lightsFrontRear(g, f + 0.06, -f - 0.005, 0.7, hw);
  axle(g, coach ? [f - 2.4, -f + 2.6, -f + 1.4] : [f - 2.5, -f + 2.6], hw, 0.5, 0.3);
  return g;
}

// ------------------------------------------------------------------ airside

/** A baggage tractor: low body, open cab with a canopy, amber beacon. */
export function tug(): Geo {
  const g = new Geo();
  g.box([-1.5, 0.35, -0.8], [1.5, 0.95, 0.8], PAINT, 0.5);
  g.box([-1.5, 0.95, -0.8], [-0.2, 1.25, 0.8], PAINT, 0.5);
  for (const x of [-1.4, -0.35]) for (const s of [-1, 1]) g.box([x, 0.95, s * 0.72 - 0.04], [x + 0.08, 2.05, s * 0.72 + 0.04], DARK, 0.3);
  g.box([-1.5, 2.05, -0.82], [-0.2, 2.15, 0.82], PAINT, 0.4);
  g.box([-0.95, 0.95, -0.35], [-0.55, 1.45, 0.35], DARK, 0.2);
  g.box([-0.7, 2.15, -0.12], [-0.45, 2.33, 0.12], AMBER, 0.4, 0.9);
  g.box([1.5, 0.45, -0.2], [1.95, 0.55, 0.2], METAL, 0.4);
  lightsFrontRear(g, 1.51, -1.51, 0.62, 0.8, 0.1);
  axle(g, [0.95, -0.95], 0.8, 0.33, 0.26);
  return g;
}

/** An open baggage cart with suitcases, or (variant 1) a ULD dolly with a container. */
export function cart(container: boolean): Geo {
  const g = new Geo();
  const hw = 0.78;
  g.box([-1.35, 0.38, -hw], [1.35, 0.55, hw], METAL, 0.45);
  g.box([1.35, 0.4, -0.05], [2.0, 0.46, 0.05], METAL, 0.4);
  if (container) {
    g.box([-1.2, 0.55, -0.75], [1.2, 2.1, 0.75], [0.62, 0.64, 0.64], 0.4);
    for (let x = -1.1; x < 1.2; x += 0.36) g.box([x, 0.6, 0.75], [x + 0.03, 2.0, 0.765], [0.4, 0.42, 0.42], 0.3);
  } else {
    for (const s of [-1, 1]) g.box([-1.35, 0.55, s * hw - 0.03], [1.35, 1.25, s * hw + 0.03], [0.25, 0.27, 0.28], 0.3);
    g.box([-1.35, 1.25, -hw], [1.35, 1.32, hw], [0.25, 0.27, 0.28], 0.3);
    const bags: Vec3[] = [[0.12, 0.13, 0.15], [0.35, 0.08, 0.06], [0.07, 0.15, 0.3], [0.32, 0.3, 0.28], [0.08, 0.09, 0.08], [0.45, 0.33, 0.12]];
    let k = 0;
    for (let x = -1.2; x < 1.1; x += 0.58) for (let z = -0.6; z < 0.6; z += 0.6) {
      const h = 0.35 + ((k * 37) % 7) * 0.05;
      g.box([x + 0.03, 0.55, z + 0.03], [x + 0.53, 0.55 + h, z + 0.55], bags[k % bags.length], 0.25);
      k++;
    }
  }
  axle(g, [0.95, -0.95], hw, 0.2, 0.16);
  return g;
}

/** A towbarless pushback tractor: long, low and heavy, with a raised cab at one end. */
export function pushback(): Geo {
  const g = new Geo();
  const hw = 1.45;
  const body: P2[] = [[-3.2, 0.35], [3.2, 0.35], [3.35, 0.7], [3.1, 1.25], [-3.1, 1.25], [-3.35, 0.7]];
  prism(g, body, hw, PAINT, (i) => (i === 0 ? [DARK, 0.1, 0] : [PAINT, 0.55, 0]), 0.55);
  // cradle that cups the nose wheel, at the front
  g.box([1.6, 0.4, -0.7], [3.3, 0.75, 0.7], DARK, 0.3);
  // cab at the back left
  g.box([-3.1, 1.25, -1.4], [-1.6, 2.3, -0.2], PAINT, 0.5);
  g.box([-3.12, 1.55, -1.3], [-1.58, 2.15, -0.3], GLASS, 0.9);
  g.box([-2.5, 2.3, -0.9], [-2.2, 2.48, -0.6], AMBER, 0.4, 0.9);
  for (const s of [-1, 1]) g.box([-2.8, 0.75, s * hw - 0.02], [2.8, 0.95, s * hw + 0.02], [0.07, 0.07, 0.07], 0.2);
  lightsFrontRear(g, 3.36, -3.36, 0.75, hw, 0.12);
  axle(g, [2.1, -2.1], hw, 0.48, 0.42);
  return g;
}

/** A fuel bowser: cab and a white elliptical tank with a red stripe. */
export function fuelTruck(): Geo {
  const g = new Geo();
  const hw = 1.25;
  const cab: P2[] = [[2.6, 0.7], [4.4, 0.7], [4.5, 1.4], [4.35, 2.9], [2.6, 2.9]];
  prism(g, cab, hw, WHITE, (i) => (i === 0 ? [DARK, 0.1, 0] : [WHITE, 0.6, 0]), 0.6);
  g.face([[4.46, 1.75, -1.05], [4.38, 2.7, -1.05], [4.38, 2.7, 1.05], [4.46, 1.75, 1.05]], GLASS, 0.9);
  g.box([-4.2, 0.7, -0.9], [2.6, 1.05, 0.9], DARK, 0.2);
  // tank: an elongated octagon in section
  const sec: P2[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    sec.push([Math.cos(a) * 1.2, 2.05 + Math.sin(a) * 0.95]);
  }
  for (let k = 0; k < 12; k++) {
    const [a, b] = [sec[k], sec[(k + 1) % 12]];
    // a quad running along x
    g.face([[2.4, b[1], b[0]], [-4.2, b[1], b[0]], [-4.2, a[1], a[0]], [2.4, a[1], a[0]]], k === 0 || k === 11 ? PAINT : WHITE, 0.6);
  }
  for (const [x, s] of [[2.4, 1], [-4.2, -1]] as [number, number][]) {
    const c = g.vertex([x, 2.05, 0], [s, 0, 0], WHITE, 0.5);
    const ring = sec.map(([z, y]) => g.vertex([x, y, z], [s, 0, 0], WHITE, 0.5));
    for (let k = 0; k < 12; k++) {
      if (s > 0) g.tri(c, ring[(k + 1) % 12], ring[k]);
      else g.tri(c, ring[k], ring[(k + 1) % 12]);
    }
  }
  g.box([-4.2, 1.7, -1.24], [2.4, 1.92, 1.24], PAINT, 0.5);
  g.box([-0.4, 3.0, -0.5], [0.4, 3.1, 0.5], METAL, 0.4);
  g.box([3.4, 2.9, -0.15], [3.7, 3.1, 0.15], AMBER, 0.4, 0.9);
  lightsFrontRear(g, 4.51, -4.21, 0.9, hw);
  axle(g, [3.5, -2.2, -3.4], hw, 0.5, 0.32);
  return g;
}

/** A high-loader catering truck: cab, scissor frame and a white box body. */
export function cateringTruck(): Geo {
  const g = new Geo();
  const hw = 1.25;
  const cab: P2[] = [[2.8, 0.7], [4.4, 0.7], [4.5, 1.4], [4.35, 2.8], [2.8, 2.8]];
  prism(g, cab, hw, WHITE, (i) => (i === 0 ? [DARK, 0.1, 0] : [WHITE, 0.6, 0]), 0.6);
  g.face([[4.46, 1.7, -1.05], [4.38, 2.6, -1.05], [4.38, 2.6, 1.05], [4.46, 1.7, 1.05]], GLASS, 0.9);
  g.box([-3.6, 0.7, -1.0], [2.8, 1.1, 1.0], DARK, 0.2);
  for (const s of [-1, 1]) {
    g.box([-3.2, 1.1, s * 0.85 - 0.06], [2.4, 1.2, s * 0.85 + 0.06], METAL, 0.4);
    g.box([-3.2, 1.2, s * 0.85 - 0.05], [2.4, 1.3, s * 0.85 + 0.05], METAL, 0.4);
  }
  g.box([-3.7, 1.35, -1.25], [2.5, 3.85, 1.25], WHITE, 0.45);
  g.box([-3.72, 2.6, -1.27], [2.52, 3.0, 1.27], PAINT, 0.5);
  g.box([2.5, 1.5, -1.1], [3.0, 3.6, 1.1], [0.55, 0.56, 0.56], 0.35);
  g.box([3.4, 2.8, -0.15], [3.7, 3.0, 0.15], AMBER, 0.4, 0.9);
  lightsFrontRear(g, 4.51, -3.71, 0.9, hw);
  axle(g, [3.5, -2.6], hw, 0.48, 0.32);
  return g;
}

/** A belt loader: a small chassis carrying a conveyor that climbs to the hold door. */
export function beltLoader(): Geo {
  const g = new Geo();
  const hw = 1.0;
  g.box([-3.6, 0.3, -hw], [3.6, 0.8, hw], PAINT, 0.5);
  // the belt: a tilted slab with side rails
  const a: Vec3 = [-3.4, 1.0, 0];
  const b: Vec3 = [3.9, 2.35, 0];
  const up = v3.norm([-(b[1] - a[1]), b[0] - a[0], 0]);
  const t = (p: Vec3, z: number, h: number): Vec3 => [p[0] + up[0] * h, p[1] + up[1] * h, z];
  g.face([t(a, -0.5, 0.12), t(b, -0.5, 0.12), t(b, 0.5, 0.12), t(a, 0.5, 0.12)].reverse() as Vec3[], [0.05, 0.05, 0.05], 0.15);
  for (const s of [-1, 1]) {
    g.face(s > 0 ? [t(a, 0.55, -0.1), t(b, 0.55, -0.1), t(b, 0.55, 0.35), t(a, 0.55, 0.35)] : [t(b, -0.55, -0.1), t(a, -0.55, -0.1), t(a, -0.55, 0.35), t(b, -0.55, 0.35)], METAL, 0.45);
  }
  g.box([-1.2, 0.8, -0.2], [1.6, 1.9, 0.2], METAL, 0.4);
  g.box([-2.6, 0.8, 0.55], [-1.6, 1.4, 0.95], DARK, 0.2);
  g.box([-2.7, 1.4, 0.5], [-2.55, 2.1, 1.0], DARK, 0.2);
  g.box([-2.3, 2.2, 0.68], [-2.05, 2.36, 0.88], AMBER, 0.4, 0.9);
  lightsFrontRear(g, 3.61, -3.61, 0.5, hw, 0.1);
  axle(g, [2.6, -2.6], hw, 0.32, 0.24);
  return g;
}

/** The follow-me car: a yellow estate with a lit roof sign. */
export function followMe(): Geo {
  const g = car('suv');
  g.box([-0.7, 1.8, -0.75], [0.7, 2.2, 0.75], YELLOW, 0.5, 0.15);
  g.face([[0.71, 1.85, -0.7], [0.71, 2.15, -0.7], [0.71, 2.15, 0.7], [0.71, 1.85, 0.7]], [0.9, 0.85, 0.2], 0.5, 0.9);
  g.box([-0.15, 2.2, -0.12], [0.15, 2.36, 0.12], AMBER, 0.4, 0.9);
  return g;
}

/** A low-floor apron bus: three metres wide, glazed almost to the ground. */
export function apronBus(): Geo {
  const g = new Geo();
  const f = 7.0;
  const hw = 1.5;
  g.box([-f, 0.35, -hw], [f, 0.75, hw], PAINT, 0.55);
  g.box([-f, 0.75, -hw], [f, 2.9, hw], GLASS, 0.9);
  g.box([-f, 2.9, -hw], [f, 3.15, hw], PAINT, 0.55);
  for (let x = -f; x <= f; x += 2.33) for (const s of [-1, 1]) g.box([x - 0.08, 0.75, s * hw - 0.03], [x + 0.08, 2.9, s * hw + 0.03], PAINT, 0.5);
  g.box([-f + 2, 3.15, -0.9], [-f + 5, 3.4, 0.9], [0.5, 0.51, 0.5], 0.3);
  g.box([-0.15, 3.15, -0.12], [0.15, 3.3, 0.12], AMBER, 0.4, 0.9);
  lightsFrontRear(g, f + 0.01, -f - 0.01, 0.45, hw, 0.15);
  axle(g, [f - 2.5, -f + 2.5], hw, 0.45, 0.3);
  return g;
}

// ------------------------------------------------------------------ rail

/**
 * A regional electric multiple unit car, 25 m over couplers. The driving car
 * (`cab`) has a raked, glazed nose at +x; intermediate cars have gangways.
 * PAINT is the operator's band along the window line.
 */
export function trainCar(cab: boolean, pantograph: boolean): Geo {
  const g = new Geo();
  const hw = 1.45;
  const f = 12.4;
  const body: P2[] = cab
    ? [[-f, 0.95], [f - 1.2, 0.95], [f + 0.2, 1.45], [f - 0.4, 3.0], [f - 2.6, 4.05], [-f, 4.05]]
    : [[-f, 0.95], [f, 0.95], [f, 4.05], [-f, 4.05]];
  prism(g, body, hw, WHITE, (i) => (i === 0 ? [DARK, 0.1, 0] : cab && i === 3 ? [GLASS, 0.92, 0] : cab && (i === 1 || i === 2) ? [PAINT, 0.7, 0] : [WHITE, 0.55, 0]), 0.55);
  for (const s of [-1, 1]) {
    const z = s * (hw + 0.006);
    const x1 = cab ? f - 2.8 : f - 0.6;
    // window band, then the painted stripe below it, then the doors
    // lit saloon windows: the evening service is running with its lights on
    g.face(s > 0 ? [[-f + 0.6, 2.05, z], [x1, 2.05, z], [x1, 3.15, z], [-f + 0.6, 3.15, z]] : [[x1, 2.05, z], [-f + 0.6, 2.05, z], [-f + 0.6, 3.15, z], [x1, 3.15, z]], [0.72, 0.78, 0.8], 0.85, 0.2);
    g.box([-f, 1.6, z - 0.01], [cab ? f - 0.3 : f, 1.95, z + 0.01], PAINT, 0.6);
    for (const dx of [-7.2, 5.6]) g.box([dx, 1.05, z - 0.015], [dx + 1.4, 3.3, z + 0.015], [0.2, 0.22, 0.24], 0.5);
    for (let x = -f + 2.2; x < x1 - 0.5; x += 2.1) g.box([x, 2.05, z - 0.01], [x + 0.1, 3.15, z + 0.01], WHITE, 0.4);
  }
  // roof: an equipment fairing and, on one car, the pantograph
  g.box([-f + 3, 4.05, -0.9], [-f + 9, 4.4, 0.9], [0.45, 0.46, 0.46], 0.3);
  if (pantograph) {
    g.box([1.0, 4.05, -0.5], [2.6, 4.25, 0.5], DARK, 0.3);
    g.box([1.6, 4.25, -0.05], [3.1, 5.3, 0.05], DARK, 0.3);
    g.box([2.9, 5.3, -0.9], [3.2, 5.4, 0.9], DARK, 0.3);
  }
  // bogies
  for (const x of [-f + 2.6, f - 2.6]) {
    g.box([x - 1.4, 0.45, -1.1], [x + 1.4, 0.95, 1.1], DARK, 0.2);
    for (const dx of [-0.9, 0.9]) for (const s of [-1, 1]) wheel(g, x + dx, 0.45, s * 0.72, 0.45, 0.14, [0.1, 0.1, 0.1], METAL, 8);
  }
  if (cab) {
    lamp(g, f + 0.21, 1.5, 1.68, -1.2, -0.75, HEAD, 0.8, 1);
    lamp(g, f + 0.21, 1.5, 1.68, 0.75, 1.2, HEAD, 0.8, 1);
  }
  return g;
}

// ------------------------------------------------------------------ water

/** A Rhine-type motor barge: long hold with hatch covers, wheelhouse and living quarters aft. */
export function barge(): Geo {
  const g = new Geo();
  const hw = 5.6;
  const f = 40;
  // hull: bow raked, flat sides; the waterline sits at y = 0
  const hull: P2[] = [[-f, -2.6], [f - 3, -2.6], [f + 1.5, 1.4], [f - 1.0, 1.6], [-f + 0.5, 1.6], [-f - 0.4, 0.2]];
  prism(g, hull, hw, [0.08, 0.09, 0.1], (i) => (i === 0 ? null : i === 3 ? [[0.22, 0.2, 0.18], 0.2, 0] : [[0.08, 0.09, 0.1], 0.4, 0]), 0.4);
  g.box([-f, -0.4, -hw - 0.02], [f - 2.5, 0.0, hw + 0.02], [0.3, 0.06, 0.05], 0.4);
  // cargo hatches
  for (let x = -f + 14; x < f - 6; x += 6.5) g.box([x, 1.6, -hw + 0.6], [x + 6.2, 2.5, hw - 0.6], PAINT, 0.35);
  // accommodation and the wheelhouse
  g.box([-f + 0.5, 1.6, -hw + 0.4], [-f + 11, 4.2, hw - 0.4], WHITE, 0.45);
  for (const s of [-1, 1]) g.face(s > 0 ? [[-f + 1.5, 2.6, hw - 0.39], [-f + 10, 2.6, hw - 0.39], [-f + 10, 3.5, hw - 0.39], [-f + 1.5, 3.5, hw - 0.39]] : [[-f + 10, 2.6, -hw + 0.39], [-f + 1.5, 2.6, -hw + 0.39], [-f + 1.5, 3.5, -hw + 0.39], [-f + 10, 3.5, -hw + 0.39]], GLASS, 0.9);
  g.box([-f + 6, 4.2, -2.4], [-f + 10.5, 6.8, 2.4], WHITE, 0.45);
  g.box([-f + 6.1, 5.4, -2.41], [-f + 10.6, 6.4, 2.41], GLASS, 0.9);
  g.box([-f + 5.8, 6.8, -2.6], [-f + 10.8, 7.0, 2.6], DARK, 0.3);
  g.box([-f + 8, 7.0, -0.1], [-f + 8.2, 8.6, 0.1], DARK, 0.3);
  // a small car carried aft, as the skippers do
  g.box([-f + 1.2, 4.2, -1.8], [-f + 5.2, 5.4, -0.2], [0.4, 0.05, 0.04], 0.6);
  return g;
}

/** A small cabin cruiser. */
export function boat(): Geo {
  const g = new Geo();
  const hull: P2[] = [[-4.2, -0.5], [3.0, -0.5], [4.8, 0.9], [4.2, 1.0], [-4.2, 1.0]];
  prism(g, hull, 1.35, WHITE, (i) => (i === 0 ? null : i === 3 ? [[0.55, 0.5, 0.42], 0.3, 0] : [WHITE, 0.6, 0]), 0.6);
  g.box([-4.21, -0.1, -1.36], [3.6, 0.15, 1.36], PAINT, 0.6);
  g.box([-2.2, 1.0, -1.0], [1.4, 2.0, 1.0], WHITE, 0.55);
  g.face([[1.41, 1.15, -0.9], [0.9, 1.95, -0.9], [0.9, 1.95, 0.9], [1.41, 1.15, 0.9]], GLASS, 0.9);
  for (const s of [-1, 1]) g.box([-1.9, 1.3, s * 1.0 - 0.01], [0.6, 1.8, s * 1.0 + 0.01], GLASS, 0.9);
  return g;
}

/** A small sloop: white hull, a mast, mainsail and jib on a reach. */
export function sailboat(): Geo {
  const g = new Geo();
  const hull: P2[] = [[-4.2, -0.4], [2.8, -0.4], [4.6, 0.8], [4.0, 0.85], [-4.2, 0.85]];
  prism(g, hull, 1.3, WHITE, (i) => (i === 0 ? null : i === 3 ? [[0.5, 0.42, 0.3], 0.3, 0] : [WHITE, 0.6, 0]), 0.6);
  g.box([-4.21, 0.0, -1.31], [3.0, 0.18, 1.31], PAINT, 0.6);
  g.box([-1.6, 0.85, -0.8], [0.8, 1.35, 0.8], WHITE, 0.5);
  g.box([0.55, 0.85, -0.06], [0.67, 12.5, 0.06], METAL, 0.5);
  g.box([-3.6, 1.9, -0.05], [0.6, 2.0, 0.05], METAL, 0.5);
  const sail: Vec3 = [0.86, 0.85, 0.82];
  // sails set a little off the centreline, filling on the starboard side
  g.face([[0.62, 2.05, 0.1], [-3.5, 2.0, 0.9], [0.62, 12.2, 0.1]], sail, 0.15);
  g.face([[0.75, 1.0, 0.08], [4.3, 0.95, 0.35], [0.75, 11.6, 0.08]], sail, 0.15);
  return g;
}

/** A tapered prism along y with n sides: limbs and bodies that read as round. */
function limb(g: Geo, x: number, z: number, y0: number, y1: number, r0x: number, r0z: number, r1x: number, r1z: number, color: Vec3, n = 6, gloss = 0.3) {
  const ring = (y: number, rx: number, rz: number) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      out.push(g.vertex([x + Math.cos(a) * rx, y, z + Math.sin(a) * rz], [Math.cos(a), 0, Math.sin(a)], color, gloss));
    }
    return out;
  };
  const a = ring(y0, r0x, r0z);
  const b = ring(y1, r1x, r1z);
  for (let k = 0; k < n; k++) g.quad(a[k], b[k], b[(k + 1) % n], a[(k + 1) % n]);
  const top = g.vertex([x, y1, z], [0, 1, 0], color, gloss);
  for (let k = 0; k < n; k++) g.tri(top, b[(k + 1) % n], b[k]);
}

/** A person, 1.75 m tall: PAINT is the jacket (hi-vis on the apron, a coat in town). */
export function person(): Geo {
  const g = new Geo();
  const skin: Vec3 = [0.5, 0.36, 0.27];
  const legs: Vec3 = [0.06, 0.07, 0.09];
  const shoes: Vec3 = [0.03, 0.03, 0.03];
  for (const z of [-0.1, 0.1]) {
    limb(g, 0, z, 0, 0.1, 0.12, 0.06, 0.1, 0.055, shoes, 6, 0.2);
    limb(g, 0, z, 0.1, 0.88, 0.065, 0.065, 0.085, 0.085, legs, 6, 0.2);
  }
  limb(g, 0, 0, 0.86, 1.04, 0.13, 0.2, 0.13, 0.21, PAINT, 8, 0.35);
  limb(g, 0, 0, 1.04, 1.44, 0.13, 0.21, 0.12, 0.22, PAINT, 8, 0.35);
  for (const z of [-0.26, 0.26]) limb(g, 0, z, 0.9, 1.42, 0.05, 0.05, 0.065, 0.065, PAINT, 6, 0.35);
  limb(g, 0, 0, 1.44, 1.52, 0.05, 0.05, 0.05, 0.05, skin, 6, 0.3);
  limb(g, 0.01, 0, 1.52, 1.62, 0.09, 0.085, 0.1, 0.095, skin, 8, 0.3);
  limb(g, 0.01, 0, 1.62, 1.74, 0.1, 0.095, 0.06, 0.055, [0.08, 0.06, 0.05], 8, 0.25);
  return g;
}
