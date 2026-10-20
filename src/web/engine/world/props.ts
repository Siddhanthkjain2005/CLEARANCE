// Ground-scale airport objects make the last part of the approach legible:
// vehicles have tyres and glazing, trees have volume, and every light has a
// physical fixture. Deterministic placement keeps the movement areas clear.

import { Geo } from '../gl.ts';
import { basisMatrix, rng, transform, v3, type Vec3 } from '../math.ts';
import { APRON, STANDS, TERMINAL } from './airport.ts';
import { heightAt } from './terrain.ts';

export type GroundPropKind = 'car' | 'van' | 'bus' | 'tug' | 'cart' | 'container' | 'tree' | 'lamp' | 'floodlight' | 'bench';
export interface GroundPropPlacement {
  kind: GroundPropKind;
  x: number;
  z: number;
  /** Model +x points forward; a quarter-turn faces the terminal. */
  heading: number;
  variant: number;
}

const ASPHALT: Vec3 = [0.055, 0.066, 0.074];
const CONCRETE: Vec3 = [0.28, 0.3, 0.31];
const METAL: Vec3 = [0.32, 0.36, 0.37];
const TYRE: Vec3 = [0.024, 0.027, 0.029];
const GLASS: Vec3 = [0.032, 0.074, 0.088];
const WHITE: Vec3 = [0.72, 0.73, 0.7];
const AMBER: Vec3 = [0.7, 0.43, 0.09];
const PAINTS: Vec3[] = [WHITE, [0.13, 0.22, 0.28], [0.27, 0.075, 0.055], [0.09, 0.1, 0.11], [0.29, 0.32, 0.31]];
const LOTS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200];
const PARKING_ROWS = [652, 676, 748, 772];

/** Public parking, service traffic and landscaping never occupy a taxi lane. */
export function groundPropPlacements(): GroundPropPlacement[] {
  const r = rng(602);
  const out: GroundPropPlacement[] = [];
  const put = (kind: GroundPropKind, x: number, z: number, heading = 0, variant = 0) => out.push({ kind, x, z, heading, variant });
  for (const lot of LOTS) {
    for (const [row, z] of PARKING_ROWS.entries()) {
      for (let bay = 0; bay < 10; bay++) {
        if (r() > 0.17) continue;
        put('car', lot + 5 + bay * 3.2, z, row % 2 ? -Math.PI / 2 : Math.PI / 2, Math.floor(r() * PAINTS.length));
      }
    }
    put('lamp', lot + 45, 710, Math.PI / 2);
    for (let z = 636; z <= 788; z += 38) put('tree', lot + 57, z, r() * 6.28, Math.floor(r() * 3));
  }
  for (let x = 700; x < 2600; x += 90) put('lamp', x, 576, Math.PI / 2);
  for (let x = APRON.x0 + 40; x < APRON.x1; x += 160) put('floodlight', x, APRON.z0 + 30);

  for (let i = 0; i < STANDS.length; i += 3) {
    const stand = STANDS[i];
    // A baggage train parks beside the wing envelope, not beneath the aircraft.
    put('tug', stand.x + 27, 355, Math.PI / 2);
    for (let cart = 0; cart < 3; cart++) put('cart', stand.x + 27, 350 - cart * 3.6, Math.PI / 2, cart);
    put('van', stand.x + 29, 417, 0, i % 5);
    put('container', stand.x - 29, 421, 0, i % 3);
  }
  for (const x of [1080, 1548, 2016, 2400]) put('bus', x, 446, 0, 0);
  for (const [i, x] of [930, 1390, 1830, 2260].entries()) put('van', x, 450, Math.PI, i);
  for (const [i, x] of [855, 1170, 1500, 1845, 2240, 2500].entries()) put('car', x, i % 2 ? 597 : 587, i % 2 ? Math.PI : 0, i % 5);
  for (let x = TERMINAL.x0 + 90; x < TERMINAL.x1; x += 270) {
    put('bench', x, TERMINAL.z1 + 12);
    put('cart', x + 7, TERMINAL.z1 + 13, Math.PI / 2, 3);
  }
  for (let x = -600; x <= 3700; x += 108) {
    put('tree', x + r() * 12, 864 + r() * 12, r() * 6.28, Math.floor(r() * 3));
    if (x > 100 && x < 3000) put('tree', x + r() * 20, -450 - r() * 30, r() * 6.28, Math.floor(r() * 3));
  }
  return out;
}

/** Smooth-sided closed cylinder, used for tyres, hubs and lamp shafts. */
function cylinder(g: Geo, a: Vec3, b: Vec3, radius: number, color: Vec3, sides = 6, gloss = 0.25) {
  const axis = v3.norm(v3.sub(b, a));
  const u = v3.norm(v3.cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const v = v3.cross(axis, u);
  const rings: number[][] = [[], []];
  for (const [j, center] of [a, b].entries()) {
    for (let k = 0; k < sides; k++) {
      const t = k * Math.PI * 2 / sides;
      const n = v3.add(v3.scale(u, Math.cos(t)), v3.scale(v, Math.sin(t)));
      rings[j].push(g.vertex(v3.add(center, v3.scale(n, radius)), n, color, gloss));
    }
  }
  for (let k = 0; k < sides; k++) g.quad(rings[0][k], rings[0][(k + 1) % sides], rings[1][(k + 1) % sides], rings[1][k]);
  for (const [j, center] of [a, b].entries()) {
    const normal = v3.scale(axis, j ? 1 : -1);
    const ci = g.vertex(center, normal, color, gloss);
    const cap: number[] = [];
    for (let k = 0; k < sides; k++) {
      const t = k * Math.PI * 2 / sides;
      cap.push(g.vertex(v3.add(center, v3.scale(v3.add(v3.scale(u, Math.cos(t)), v3.scale(v, Math.sin(t))), radius)), normal, color, gloss));
    }
    for (let k = 0; k < sides; k++) {
      if (j) g.tri(ci, cap[k], cap[(k + 1) % sides]);
      else g.tri(ci, cap[(k + 1) % sides], cap[k]);
    }
  }
}

function wheels(g: Geo, axle: number[], halfWidth: number, radius: number) {
  for (const x of axle) for (const side of [-1, 1]) {
    const z = side * halfWidth;
    cylinder(g, [x, radius, z - 0.12], [x, radius, z + 0.12], radius, TYRE, 6, 0.1);
    // The exposed hub is a separate small cap, rather than a painted tyre.
    const outer = z + side * 0.13;
    const hub = g.vertex([x, radius, outer], [0, 0, side], METAL, 0.55);
    const ring: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = k * Math.PI * 2 / 5;
      ring.push(g.vertex([x + Math.cos(t) * radius * 0.43, radius + Math.sin(t) * radius * 0.43, outer], [0, 0, side], METAL, 0.55));
    }
    for (let k = 0; k < 5; k++) {
      if (side > 0) g.tri(hub, ring[k], ring[(k + 1) % 5]);
      else g.tri(hub, ring[(k + 1) % 5], ring[k]);
    }
  }
}

function lamps(g: Geo, front: number, back: number, halfWidth: number, y: number) {
  for (const z of [-halfWidth * 0.75, halfWidth * 0.75]) {
    g.face([[front + 0.025, y, z - 0.13], [front + 0.025, y + 0.17, z - 0.13], [front + 0.025, y + 0.17, z + 0.13], [front + 0.025, y, z + 0.13]], [0.9, 0.84, 0.68], 0.45, 0.55);
    g.face([[back - 0.025, y, z + 0.13], [back - 0.025, y + 0.17, z + 0.13], [back - 0.025, y + 0.17, z - 0.13], [back - 0.025, y, z - 0.13]], [0.7, 0.055, 0.028], 0.35, 0.4);
  }
}

function vehicle(kind: 'car' | 'van' | 'bus' | 'tug', variant: number): Geo {
  const g = new Geo();
  const paint = kind === 'car' ? PAINTS[variant % PAINTS.length] : kind === 'tug' ? AMBER : WHITE;
  const length = kind === 'bus' ? 11.8 : kind === 'van' ? 5.4 : kind === 'tug' ? 3.1 : 4.6;
  const w = kind === 'bus' ? 1.27 : kind === 'van' ? 1.02 : kind === 'tug' ? 0.78 : 0.91;
  const half = length / 2;
  const roof = kind === 'bus' ? 3.12 : kind === 'van' ? 2.28 : kind === 'tug' ? 1.55 : 1.47;
  const waist = kind === 'tug' ? 0.83 : 0.97;
  g.box([-half, 0.42, -w], [half, waist, w], paint, 0.65);
  if (kind === 'car') {
    const bottom = [[-1.4, waist, -w + 0.06], [1.15, waist, -w + 0.06], [1.15, waist, w - 0.06], [-1.4, waist, w - 0.06]] as Vec3[];
    const top = [[-0.85, roof, -0.73], [0.57, roof, -0.73], [0.57, roof, 0.73], [-0.85, roof, 0.73]] as Vec3[];
    g.face(top.slice().reverse(), paint, 0.7);
    for (let i = 0; i < 4; i++) g.face([bottom[i], bottom[(i + 1) % 4], top[(i + 1) % 4], top[i]], GLASS, 0.85);
    for (const side of [-1, 1]) g.box([-0.23, waist, side < 0 ? -w + 0.03 : w - 0.1], [-0.16, roof, side < 0 ? -w + 0.1 : w - 0.03], paint, 0.65);
  } else {
    const topFront = kind === 'tug' ? 0.65 : half - 0.65;
    g.box([-half + 0.18, waist, -w + 0.045], [topFront, roof, w - 0.045], paint, 0.4);
    const windowY = kind === 'tug' ? 1.02 : 1.3;
    g.box([topFront + 0.012, windowY, -w + 0.14], [topFront + 0.02, roof - 0.15, w - 0.14], GLASS, 0.85);
    for (const side of [-1, 1]) {
      const z = side * (w - 0.035);
      if (kind === 'bus') {
        for (let x = -half + 0.4; x < half - 1.1; x += 1.25) g.face([[x, 1.3, z], [x + 1.08, 1.3, z], [x + 1.08, roof - 0.18, z], [x, roof - 0.18, z]], GLASS, 0.85);
        g.box([-half, 0.84, z - 0.01], [half, 1.12, z + 0.01], [0.06, 0.27, 0.27], 0.45);
      } else {
        g.face([[topFront - 1.1, windowY, z], [topFront - 0.08, windowY, z], [topFront - 0.08, roof - 0.15, z], [topFront - 1.1, roof - 0.15, z]], GLASS, 0.8);
      }
    }
    if (kind === 'tug' || kind === 'van') g.box([-0.35, roof, -0.12], [0.1, roof + 0.16, 0.12], AMBER, 0.4, 0.8);
  }
  wheels(g, [-half * 0.63, half * 0.62], w, kind === 'bus' ? 0.49 : kind === 'tug' ? 0.29 : 0.33);
  lamps(g, half, -half, w, kind === 'bus' ? 0.75 : 0.6);
  return g;
}

function baggageCart(variant: number): Geo {
  const g = new Geo();
  const short = variant === 3;
  const half = short ? 0.82 : 1.22;
  const w = short ? 0.48 : 0.72;
  g.box([-half, 0.36, -w], [half, 0.53, w], METAL, 0.45);
  wheels(g, [-half * 0.75, half * 0.75], w, 0.17);
  for (const z of [-w, w]) g.box([-half, 0.7, z - 0.035], [half, 0.75, z + 0.035], METAL, 0.55);
  for (const x of [-half, half]) g.box([x - 0.035, 0.5, -w], [x + 0.035, 1.12, -w + 0.065], METAL);
  g.box([half, 0.33, -0.04], [half + 0.6, 0.39, 0.04], METAL);
  for (let i = 0; i < (short ? 2 : 3); i++) {
    const x = -half + 0.13 + i * (short ? 0.57 : 0.73);
    g.box([x, 0.53, -w + 0.08], [x + 0.5, 0.95 + (i % 2) * 0.25, w - 0.08], PAINTS[(i + variant + 1) % PAINTS.length], 0.2);
  }
  return g;
}

function container(variant: number): Geo {
  const g = new Geo();
  for (const z of [-0.72, 0.62]) g.box([-1.45, 0, z], [1.45, 0.15, z + 0.1], METAL, 0.3);
  g.box([-1.55, 0.15, -0.95], [1.55, 1.85, 0.95], [0.46, 0.49, 0.48], 0.35);
  // Chamfered upper shoulders distinguish an air-freight ULD from a building.
  g.face([[-1.55, 1.85, -0.95], [1.55, 1.85, -0.95], [1.2, 2.35, -0.7], [-1.2, 2.35, -0.7]], METAL, 0.4);
  g.face([[1.55, 1.85, 0.95], [-1.55, 1.85, 0.95], [-1.2, 2.35, 0.7], [1.2, 2.35, 0.7]], METAL, 0.4);
  g.box([-1.2, 2.3, -0.7], [1.2, 2.36, 0.7], METAL, 0.4);
  for (let x = -1.3; x < 1.4; x += 0.42) g.box([x, 0.25, 0.95], [x + 0.035, 1.7, 0.965], [0.23, 0.26, 0.27], 0.4);
  g.box([-1.4, 0.85, 0.97], [-0.7, 1.1, 0.98], PAINTS[(variant + 1) % 5], 0.2);
  return g;
}

/** Irregular closed crowns with shared vertices give trees a smooth silhouette. */
function lightMast(flood: boolean): Geo {
  const g = new Geo();
  const h = flood ? 28 : 9;
  cylinder(g, [0, 0, 0], [0, h - 0.25, 0], flood ? 0.3 : 0.1, METAL, 6, 0.5);
  g.box([-0.45, 0, -0.45], [0.45, 0.3, 0.45], CONCRETE);
  if (flood) {
    g.box([-1.7, h - 0.65, -0.13], [1.7, h - 0.48, 0.13], METAL);
    for (const x of [-1.2, 0, 1.2]) {
      g.box([x - 0.42, h - 0.5, -0.28], [x + 0.42, h + 0.13, 0.28], [0.08, 0.1, 0.11], 0.4);
      g.face([[x - 0.33, h, -0.29], [x + 0.33, h, -0.29], [x + 0.33, h - 0.35, -0.29], [x - 0.33, h - 0.35, -0.29]], [0.82, 0.72, 0.55], 0.25, 1.2);
    }
  } else {
    g.box([0, h - 0.25, -0.045], [3, h - 0.15, 0.045], METAL, 0.45);
    g.box([2.45, h - 0.3, -0.24], [3.25, h - 0.04, 0.24], [0.1, 0.13, 0.14], 0.4);
    g.face([[2.5, h - 0.31, -0.2], [3.2, h - 0.31, -0.2], [3.2, h - 0.31, 0.2], [2.5, h - 0.31, 0.2]], [0.8, 0.74, 0.61], 0.2, 0.85);
  }
  return g;
}

function bench(): Geo {
  const g = new Geo();
  const wood: Vec3 = [0.3, 0.21, 0.13];
  for (const x of [-0.7, 0.7]) g.box([x - 0.05, 0, -0.24], [x + 0.05, 0.82, 0.27], METAL);
  for (let z = -0.24; z < 0.25; z += 0.15) g.box([-0.95, 0.46, z], [0.95, 0.53, z + 0.12], wood, 0.08);
  for (const y of [0.68, 0.85]) g.box([-0.95, y, -0.28], [0.95, y + 0.12, -0.22], wood, 0.08);
  return g;
}

function rect(g: Geo, x0: number, z0: number, x1: number, z1: number, color: Vec3, y = 0.13, gloss = 0.08) {
  g.face([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], color, gloss);
}

function roadsAndFurniture(g: Geo) {
  rect(g, 590, 580, 2760, 604, ASPHALT);
  rect(g, APRON.x0, 438, APRON.x1, 454, ASPHALT, 0.14);
  rect(g, -1250, 820, 4220, 832, ASPHALT);
  // Edge lines and broken centrelines are raised a few centimetres for depth.
  for (const z of [581, 603]) rect(g, 595, z, 2755, z + 0.16, WHITE, 0.17);
  for (let x = 605; x < 2750; x += 18) rect(g, x, 591.9, x + 7, 592.1, WHITE, 0.17);
  for (let x = APRON.x0 + 8; x < APRON.x1; x += 16) rect(g, x, 445.9, x + 5, 446.1, WHITE, 0.18);
  for (const lot of LOTS) {
    rect(g, lot, 633, lot + 42, 798, ASPHALT);
    rect(g, lot + 14, 604, lot + 26, 633, ASPHALT);
    for (const z of [633, 798]) g.box([lot, 0, z], [lot + 42, 0.19, z + 0.28], CONCRETE);
    for (const z of PARKING_ROWS) {
      for (let bay = 0; bay <= 10; bay++) rect(g, lot + 3.4 + bay * 3.2, z - 2.7, lot + 3.5 + bay * 3.2, z + 2.7, WHITE, 0.17);
      rect(g, lot + 3.4, z + 2.6, lot + 35.5, z + 2.7, WHITE, 0.17);
    }
    // Accessible crossing between the parking access road and terminal footway.
    for (let x = lot + 13; x < lot + 27; x += 1.4) rect(g, x, 605, x + 0.7, 609, WHITE, 0.17);
  }
  rect(g, TERMINAL.x0, TERMINAL.z1 + 1, TERMINAL.x1, TERMINAL.z1 + 21, CONCRETE, 0.16);
  // Landside perimeter railing stays outside both the parking and service road.
  for (let x = 650; x <= 2600; x += 12) cylinder(g, [x, 0, 809], [x, 2.15, 809], 0.055, METAL, 4, 0.25);
  for (const y of [0.6, 1.45, 2.1]) g.box([650, y, 808.97], [2600, y + 0.035, 809.03], METAL, 0.25);
  // Kerbside bollards are small physical obstacles along the terminal walkway.
  for (let x = TERMINAL.x0 + 15; x < TERMINAL.x1; x += 32) cylinder(g, [x, 0.16, 553], [x, 0.99, 553], 0.12, METAL, 5, 0.3);
}

export function buildGroundProps(): Geo {
  const g = new Geo();
  roadsAndFurniture(g);
  const models = new Map<string, Geo>();
  for (const prop of groundPropPlacements()) {
    const key = `${prop.kind}:${prop.variant}`;
    let model = models.get(key);
    if (!model) {
      if (prop.kind === 'car' || prop.kind === 'van' || prop.kind === 'bus' || prop.kind === 'tug') model = vehicle(prop.kind, prop.variant);
      else if (prop.kind === 'tree') continue; // instanced with the other trees (vegetation.ts)
      else if (prop.kind === 'cart') model = baggageCart(prop.variant);
      else if (prop.kind === 'container') model = container(prop.variant);
      else if (prop.kind === 'bench') model = bench();
      else model = lightMast(prop.kind === 'floodlight');
      models.set(key, model);
    }
    const y = heightAt(prop.x, prop.z) + (prop.kind === 'tree' ? 0 : 0.15);
    g.merge(model, basisMatrix([prop.x, y, prop.z], [Math.cos(prop.heading), 0, Math.sin(prop.heading)], [0, 1, 0]));
  }
  return g;
}

/** Eight-float point lights share exactly the geometry's placement and scale. */
export function buildGroundPropLights(): number[] {
  const out: number[] = [];
  const point = (p: Vec3, c: Vec3, size: number, kind = 0) => out.push(...p, ...c, size, kind);
  for (const prop of groundPropPlacements()) {
    const model = basisMatrix([prop.x, heightAt(prop.x, prop.z) + 0.15, prop.z], [Math.cos(prop.heading), 0, Math.sin(prop.heading)], [0, 1, 0]);
    const at = (p: Vec3): Vec3 => transform(model, p).slice(0, 3) as Vec3;
    if (prop.kind === 'floodlight') {
      for (const x of [-1.2, 0, 1.2]) point(at([x, 27.84, -0.3]), [1, 0.83, 0.59], 2.2);
    } else if (prop.kind === 'lamp') point(at([2.85, 8.69, 0]), [1, 0.81, 0.58], 1.45);
    else if (prop.kind === 'car' || prop.kind === 'van' || prop.kind === 'bus' || prop.kind === 'tug') {
      const half = prop.kind === 'bus' ? 5.9 : prop.kind === 'van' ? 2.7 : prop.kind === 'tug' ? 1.55 : 2.3;
      // Parked cars keep their lamps off; only road and apron service vehicles glow.
      if (prop.kind === 'car' && prop.z > 620) continue;
      for (const z of [-0.65, 0.65]) {
        point(at([half + 0.03, 0.7, z]), [1, 0.91, 0.75], 0.42);
        point(at([-half - 0.03, 0.7, z]), [1, 0.09, 0.04], 0.3);
      }
      if (prop.kind === 'tug' || prop.kind === 'van') point(at([0, prop.kind === 'tug' ? 1.7 : 2.44, 0]), [1, 0.52, 0.08], 0.35, 4.25);
    }
  }
  return out;
}
