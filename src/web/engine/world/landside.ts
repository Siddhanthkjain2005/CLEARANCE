// The landside campus beyond the perimeter road: a multi-storey car park
// with its decks lit for the evening, an airport hotel and an office park
// with lit windows, a rental-car lot, the connector roads that close the
// terminal's traffic loops, and a security fence around the airside. All of
// it sits in the strip between the perimeter road and the airport's tree
// belts, where the tower and the airport cameras look across it.

import { Geo } from '../gl.ts';
import { rng, type Vec3 } from '../math.ts';
import { AIRFIELD } from './terrain.ts';

const ASPHALT: Vec3 = [0.055, 0.066, 0.074];
const CONCRETE: Vec3 = [0.4, 0.4, 0.38];
const DECK: Vec3 = [0.3, 0.3, 0.29];
const WHITE: Vec3 = [0.72, 0.73, 0.7];
const GLASS: Vec3 = [0.04, 0.075, 0.095];
const FRAME: Vec3 = [0.22, 0.24, 0.26];
const STEEL: Vec3 = [0.42, 0.44, 0.45];
const WARM: Vec3 = [0.95, 0.72, 0.45];
const COOL: Vec3 = [0.85, 0.92, 1.0];
const SIGN: Vec3 = [0.08, 0.25, 0.75];

export const GARAGE = { x0: 1300, x1: 1440, z0: 892, z1: 962, levels: 4, storey: 3.1 };
export const RENTAL = { x0: 640, x1: 800, z0: 892, z1: 962 };
export const HOTEL = { x0: 1640, x1: 1730, z0: 900, z1: 921, floors: 11, storey: 3.2 };
export const OFFICES = [
  { x0: 1980, x1: 2050, z0: 896, z1: 940, floors: 6, storey: 3.8 },
  { x0: 2100, x1: 2150, z0: 900, z1: 956, floors: 8, storey: 3.8 },
  { x0: 2200, x1: 2290, z0: 900, z1: 935, floors: 5, storey: 3.8 },
];
/** Connector roads that close the terminal road and perimeter road into loops. */
export const CONNECTORS = [594, 2668];

function rect(g: Geo, x0: number, z0: number, x1: number, z1: number, color: Vec3, y = 0.13, gloss = 0.08) {
  g.face([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], color, gloss);
}

/** A glazed block: floor slabs, spandrels, a curtain wall of windows of which some are lit. */
function glazedBlock(g: Geo, b: { x0: number; x1: number; z0: number; z1: number; floors: number; storey: number }, seed: number, bay = 3.0, hotel = false) {
  const r = rng(seed);
  const top = b.floors * b.storey;
  g.box([b.x0, 0, b.z0], [b.x1, 0.6, b.z1], CONCRETE, 0.2);
  // each facade: per floor a band of windows above a spandrel
  // traversed so that (along the facade) x up points out of the building
  const sides: { a: [number, number]; b: [number, number]; n: [number, number] }[] = [
    { a: [b.x1, b.z0], b: [b.x0, b.z0], n: [0, -1] },
    { a: [b.x1, b.z1], b: [b.x1, b.z0], n: [1, 0] },
    { a: [b.x0, b.z1], b: [b.x1, b.z1], n: [0, 1] },
    { a: [b.x0, b.z0], b: [b.x0, b.z1], n: [-1, 0] },
  ];
  for (const s of sides) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const dir: [number, number] = [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len];
    const n = Math.max(1, Math.round(len / bay));
    const w = len / n;
    for (let f = 0; f < b.floors; f++) {
      const y0 = 0.6 + f * b.storey;
      const sill = y0 + (hotel ? 0.9 : 0.75);
      const head = y0 + b.storey - 0.35;
      const out = 0.02;
      // spandrel band across the whole facade
      g.face([
        [s.a[0] + s.n[0] * out, y0, s.a[1] + s.n[1] * out], [s.b[0] + s.n[0] * out, y0, s.b[1] + s.n[1] * out],
        [s.b[0] + s.n[0] * out, sill, s.b[1] + s.n[1] * out], [s.a[0] + s.n[0] * out, sill, s.a[1] + s.n[1] * out],
      ], hotel ? WHITE : FRAME, 0.35);
      g.face([
        [s.a[0] + s.n[0] * out, head, s.a[1] + s.n[1] * out], [s.b[0] + s.n[0] * out, head, s.b[1] + s.n[1] * out],
        [s.b[0] + s.n[0] * out, y0 + b.storey, s.b[1] + s.n[1] * out], [s.a[0] + s.n[0] * out, y0 + b.storey, s.a[1] + s.n[1] * out],
      ], hotel ? WHITE : FRAME, 0.35);
      for (let i = 0; i < n; i++) {
        const u0 = i * w + 0.12;
        const u1 = (i + 1) * w - 0.12;
        const lit = r() < (hotel ? 0.42 : 0.3);
        const tone = 0.55 + r() * 0.6;
        const p = (u: number, y: number): Vec3 => [s.a[0] + dir[0] * u + s.n[0] * out, y, s.a[1] + dir[1] * u + s.n[1] * out];
        g.face([p(u0, sill), p(u1, sill), p(u1, head), p(u0, head)], lit ? (hotel ? WARM : COOL) : GLASS, lit ? 0.3 : 0.9, lit ? 0.22 * tone : 0);
        // mullion: a slim fin standing proud of the glass
        const m = (u: number, y: number): Vec3 => [s.a[0] + dir[0] * u + s.n[0] * 0.12, y, s.a[1] + dir[1] * u + s.n[1] * 0.12];
        g.face([m(i * w - 0.07, sill), m(i * w + 0.07, sill), m(i * w + 0.07, head), m(i * w - 0.07, head)], FRAME, 0.4);
      }
    }
  }
  // roof: parapet, plant and a lift overrun
  g.box([b.x0, top + 0.6, b.z0], [b.x1, top + 0.65, b.z1], [0.26, 0.27, 0.27], 0.15);
  g.box([b.x0 - 0.1, top + 0.6, b.z0 - 0.1], [b.x1 + 0.1, top + 1.6, b.z0 + 0.25], CONCRETE, 0.2);
  g.box([b.x0 - 0.1, top + 0.6, b.z1 - 0.25], [b.x1 + 0.1, top + 1.6, b.z1 + 0.1], CONCRETE, 0.2);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  g.box([cx - 6, top + 0.6, cz - 4], [cx + 6, top + 4.4, cz + 4], [0.36, 0.37, 0.37], 0.3);
  for (let i = 0; i < 3; i++) g.box([b.x0 + 4 + i * 5, top + 0.6, b.z1 - 7], [b.x0 + 8 + i * 5, top + 2.6, b.z1 - 3], STEEL, 0.4);
}

/** An open-sided car park: decks on a column grid, parapets, a ramp, stair cores and lit soffits. */
function garage(g: Geo) {
  const G = GARAGE;
  const top = G.levels * G.storey;
  for (let l = 1; l <= G.levels; l++) {
    const y = l * G.storey;
    g.box([G.x0, y - 0.35, G.z0], [G.x1, y, G.z1], DECK, 0.15, 0, false);
    // parapet with a slot of light under each deck edge
    for (const [a, b] of [[[G.x0, G.z0 - 0.3], [G.x1, G.z0]], [[G.x0, G.z1], [G.x1, G.z1 + 0.3]]] as [[number, number], [number, number]][]) {
      g.box([a[0], y, a[1]], [b[0], y + 1.05, b[1]], CONCRETE, 0.2);
    }
    for (const [a, b] of [[[G.x0 - 0.3, G.z0], [G.x0, G.z1]], [[G.x1, G.z0], [G.x1 + 0.3, G.z1]]] as [[number, number], [number, number]][]) {
      g.box([a[0], y, a[1]], [b[0], y + 1.05, b[1]], CONCRETE, 0.2);
    }
    // lit soffit strips over the aisles
    for (const z of [G.z0 + 17, G.z1 - 17]) {
      for (let x = G.x0 + 6; x < G.x1 - 6; x += 8) g.face([[x, y - 0.36, z - 0.15], [x + 3, y - 0.36, z - 0.15], [x + 3, y - 0.36, z + 0.15], [x, y - 0.36, z + 0.15]], COOL, 0.2, 0.7);
    }
  }
  // ground-level parapet and kerb
  g.box([G.x0, 0, G.z0 - 0.3], [G.x1, 0.9, G.z0], CONCRETE, 0.2);
  // columns
  for (let x = G.x0 + 0.4; x <= G.x1 - 0.2; x += 8) {
    for (const z of [G.z0 + 0.6, G.z0 + 23.3, G.z1 - 23.3, G.z1 - 0.6]) g.box([x - 0.3, 0, z - 0.3], [x + 0.3, top, z + 0.3], CONCRETE, 0.2);
  }
  // ramp along the west bay
  for (let l = 0; l < G.levels; l++) {
    const y0 = l * G.storey;
    const y1 = y0 + G.storey;
    const z0 = G.z0 + 26;
    const z1 = G.z1 - 26;
    g.face([[G.x0 + 1, y0 + 0.15, z0], [G.x0 + 1, y1 - 0.2, z1], [G.x0 + 8, y1 - 0.2, z1], [G.x0 + 8, y0 + 0.15, z0]], DECK, 0.12);
  }
  // stair and lift cores with glazed fronts and a blue P sign
  for (const [x, z] of [[G.x0 - 7, G.z0 + 4], [G.x1 + 1, G.z1 - 10]] as [number, number][]) {
    g.box([x, 0, z], [x + 6, top + 3.5, z + 6], CONCRETE, 0.2);
    g.face([[x + 1, 1, z - 0.02], [x + 5, 1, z - 0.02], [x + 5, top + 2.5, z - 0.02], [x + 1, top + 2.5, z - 0.02]].reverse() as Vec3[], GLASS, 0.9, 0.04);
  }
  g.box([G.x0 + 30, top + 1.2, G.z0 - 0.6], [G.x0 + 36, top + 7.2, G.z0 - 0.3], SIGN, 0.4, 0.55);
  g.face([[G.x0 + 31.5, top + 2.4, G.z0 - 0.62], [G.x0 + 34.5, top + 2.4, G.z0 - 0.62], [G.x0 + 34.5, top + 6.0, G.z0 - 0.62], [G.x0 + 31.5, top + 6.0, G.z0 - 0.62]].reverse() as Vec3[], [0.95, 0.97, 1.0], 0.3, 0.9);
  // lamp posts on the roof deck
  for (let x = G.x0 + 12; x < G.x1; x += 30) {
    for (const z of [G.z0 + 23.3, G.z1 - 23.3]) {
      g.box([x - 0.08, top, z - 0.08], [x + 0.08, top + 6, z + 0.08], STEEL, 0.4);
      g.box([x - 0.5, top + 6, z - 0.2], [x + 0.5, top + 6.2, z + 0.2], STEEL, 0.4);
    }
  }
}

/** Parking positions in the car park and the rental lot: x, deck height, z, heading. */
export function landsideBays(): { x: number; y: number; z: number; heading: number }[] {
  const out: { x: number; y: number; z: number; heading: number }[] = [];
  const G = GARAGE;
  const rows = [G.z0 + 5.5, G.z0 + 28.8, G.z1 - 28.8, G.z1 - 5.5];
  for (let l = 0; l <= G.levels; l++) {
    const y = l * G.storey + 0.17;
    // lower decks: only the outer rows can be seen through the open sides
    const use = l === G.levels ? rows : [rows[0], rows[3]];
    for (const z of use) {
      // cars nose in toward the aisle
      const heading = z < (G.z0 + G.z1) / 2 ? Math.PI / 2 : -Math.PI / 2;
      for (let x = G.x0 + 10; x < G.x1 - 2; x += 2.6) out.push({ x, y, z, heading });
    }
  }
  for (let z = RENTAL.z0 + 6; z < RENTAL.z1 - 4; z += 12) {
    for (let x = RENTAL.x0 + 6; x < RENTAL.x1 - 4; x += 2.7) out.push({ x, y: 0.17, z, heading: Math.PI / 2 });
  }
  return out;
}

/** Security fence on the airside boundary: posts, three rails, barbed arms. */
function fence(g: Geo) {
  const runs: [number, number][][] = [
    [[AIRFIELD.x0 + 10, AIRFIELD.z0 + 10], [AIRFIELD.x1 - 10, AIRFIELD.z0 + 10]],
    [[AIRFIELD.x0 + 10, AIRFIELD.z0 + 10], [AIRFIELD.x0 + 10, 560]],
    [[AIRFIELD.x1 - 10, AIRFIELD.z0 + 10], [AIRFIELD.x1 - 10, 560]],
  ];
  for (const [a, b] of runs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / len;
    const dz = (b[1] - a[1]) / len;
    for (let s = 0; s <= len; s += 6) {
      const x = a[0] + dx * s;
      const z = a[1] + dz * s;
      g.box([x - 0.045, 0, z - 0.045], [x + 0.045, 2.5, z + 0.045], STEEL, 0.35);
    }
    for (let s = 0; s < len; s += 40) {
      const e = Math.min(len, s + 40);
      for (const y of [0.15, 1.25, 2.4]) {
        const x0 = a[0] + dx * s;
        const z0 = a[1] + dz * s;
        const x1 = a[0] + dx * e;
        const z1 = a[1] + dz * e;
        g.box([Math.min(x0, x1) - 0.02, y, Math.min(z0, z1) - 0.02], [Math.max(x0, x1) + 0.02, y + 0.04, Math.max(z0, z1) + 0.02], STEEL, 0.4);
      }
    }
  }
}

export function buildLandside(): Geo {
  const g = new Geo();
  // connectors closing the terminal-road loops, with a broken centre line
  for (const cx of CONNECTORS) {
    rect(g, cx - 6, 604, cx + 6, 820, ASPHALT);
    for (let z = 610; z < 815; z += 14) rect(g, cx - 0.1, z, cx + 0.1, z + 6, WHITE, 0.16);
    for (const side of [-1, 1]) rect(g, cx + side * 6 - 0.1, 604, cx + side * 6 + 0.1, 820, WHITE, 0.16);
  }
  // driveways from the perimeter road to the car park, hotel and offices
  for (const [x, w] of [[1370, 14], [1685, 12], [2075, 10], [760, 12]] as [number, number][]) rect(g, x - w / 2, 832, x + w / 2, 893, ASPHALT);
  rect(g, RENTAL.x0, RENTAL.z0, RENTAL.x1, RENTAL.z1, ASPHALT, 0.12);
  for (let z = RENTAL.z0 + 6; z < RENTAL.z1 - 4; z += 12) {
    for (let x = RENTAL.x0 + 4.65; x < RENTAL.x1 - 3; x += 2.7) rect(g, x, z - 2.5, x + 0.08, z + 2.5, WHITE, 0.16);
  }
  rect(g, GARAGE.x0 - 8, GARAGE.z0 - 4, GARAGE.x1 + 8, GARAGE.z1 + 2, ASPHALT, 0.12);
  // forecourts
  rect(g, HOTEL.x0 - 10, HOTEL.z0 - 8, HOTEL.x1 + 10, HOTEL.z1 + 30, [0.3, 0.29, 0.27], 0.12);
  for (const o of OFFICES) rect(g, o.x0 - 6, o.z0 - 6, o.x1 + 6, o.z1 + 6, [0.3, 0.29, 0.27], 0.12);
  garage(g);
  glazedBlock(g, HOTEL, 31, 3.2, true);
  // the hotel's lit name board on the roof
  g.box([HOTEL.x0 + 20, HOTEL.floors * HOTEL.storey + 1.6, HOTEL.z0 - 0.4], [HOTEL.x1 - 20, HOTEL.floors * HOTEL.storey + 4.2, HOTEL.z0 - 0.1], [0.9, 0.85, 0.75], 0.4, 0.7);
  OFFICES.forEach((o, i) => glazedBlock(g, o, 90 + i, 2.4));
  fence(g);
  return g;
}

/** Lamps on the car park roof and in the rental lot (POINTS_VS records). */
export function buildLandsideLights(): number[] {
  const out: number[] = [];
  const top = GARAGE.levels * GARAGE.storey;
  for (let x = GARAGE.x0 + 12; x < GARAGE.x1; x += 30) {
    for (const z of [GARAGE.z0 + 23.3, GARAGE.z1 - 23.3]) out.push(x, top + 6.0, z, 0.9, 0.94, 1.0, 1.6, 0);
  }
  return out;
}
