// Life on the ground and the water. Cars, vans, lorries and buses run the
// motorway, the city's avenues and bridges and the airport's landside loop;
// baggage trains, catering and fuel trucks work the apron and visit the
// stands; barges and pleasure boats travel the river and sail the lake; the
// car parks fill up. Everything is a pure function of time from a seeded
// layout, so every visitor sees the same traffic and tests can check it.
//
// Vehicles follow lanes: polylines with rounded corners, sampled every few
// metres with the road's real height, so they bank onto bridges and climb
// ramps. Where a road simply ends in the city or the countryside, vehicles
// dip below the surface over the last stretch rather than vanishing.

import { rng, smoothstep, type Vec3 } from '../math.ts';
import { deckAt } from './motorway.ts';
import { motorwayLine, offsetLine, offsetLineBy, roundCorners, type P2 } from './lines.ts';
import { APRON, DEPARTURE_STAND, PARKING_COURTS, STANDS } from './airport.ts';
import { CITY, LAKE, WATER_LEVEL, heightAt, riverWidthAt, riverZ, shorelineDistance } from './terrain.ts';
import { urbanBridgeSites } from './urban.ts';
import { groundPropPlacements } from './props.ts';
import { landsideBays } from './landside.ts';

export { motorwayLine, offsetLine, offsetLineBy, roundCorners };

/** Instance layout for MOVER_VS: x, y, z, heading | pitch, r, g, b. */
export const MOVER_FLOATS = 8;

export const MOVER_KINDS = [
  'sedan', 'hatch', 'suv', 'carlod', 'van', 'lorry', 'bus', 'coach',
  'tug', 'cart', 'uld', 'pushback', 'fuel', 'catering', 'loader', 'followme', 'apronbus',
  'traincab', 'traincar', 'trainpanto', 'barge', 'boat', 'sailboat', 'person',
] as const;
export type MoverKind = (typeof MOVER_KINDS)[number];

/** Half length of each model, for lights and spacing. */
export const MOVER_LENGTH: Record<MoverKind, number> = {
  sedan: 2.4, hatch: 2.05, suv: 2.4, carlod: 2.3, van: 2.65, lorry: 8.35, bus: 6.0, coach: 6.5,
  tug: 1.5, cart: 1.35, uld: 1.35, pushback: 3.35, fuel: 4.5, catering: 4.5, loader: 3.6, followme: 2.4, apronbus: 7.0,
  traincab: 12.4, traincar: 12.4, trainpanto: 12.4, barge: 40, boat: 4.8, sailboat: 4.5, person: 0.3,
};

export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
}


// ------------------------------------------------------------------ paths

/** A polyline with cumulative length, sampled by distance along it. */
export class Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  readonly closed: boolean;

  constructor(pts: Vec3[], closed = false) {
    const all = closed ? [...pts, pts[0]] : pts;
    const n = all.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.cum = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.xs[i] = all[i][0];
      this.ys[i] = all[i][1];
      this.zs[i] = all[i][2];
      if (i > 0) s += Math.hypot(all[i][0] - all[i - 1][0], all[i][2] - all[i - 1][2]);
      this.cum[i] = s;
    }
    this.length = s;
    this.closed = closed;
  }

  /** Pose at distance d: wrapped on closed paths, clamped on open ones. */
  sample(d: number, out: Pose): Pose {
    const L = this.length;
    if (this.closed) d = ((d % L) + L) % L;
    else d = Math.max(0, Math.min(L, d));
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = c[hi] - c[lo] || 1;
    const u = (d - c[lo]) / seg;
    const dx = this.xs[hi] - this.xs[lo];
    const dy = this.ys[hi] - this.ys[lo];
    const dz = this.zs[hi] - this.zs[lo];
    out.x = this.xs[lo] + dx * u;
    out.y = this.ys[lo] + dy * u;
    out.z = this.zs[lo] + dz * u;
    out.heading = Math.atan2(dz, dx);
    out.pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
    return out;
  }
}

function lift(pts: P2[], height: (x: number, z: number) => number): Vec3[] {
  return pts.map(([x, z]) => [x, height(x, z), z] as Vec3);
}

/**
 * Time-to-distance along a closed route with stops: the vehicle accelerates,
 * cruises and brakes between stops (trapezoidal speed), and waits at each.
 */
export class Schedule {
  readonly period: number;
  private legs: { t0: number; s0: number; dist: number; drive: number; vmax: number; dwellAfter: number }[] = [];
  private readonly accel: number;

  constructor(length: number, speed: number, stops: { at: number; dwell: number }[], accel = 1.2) {
    this.accel = accel;
    const sorted = [...stops].sort((a, b) => a.at - b.at);
    if (!sorted.length) sorted.push({ at: 0, dwell: 0 });
    let t = 0;
    for (let i = 0; i < sorted.length; i++) {
      const from = sorted[i];
      const to = i + 1 < sorted.length ? sorted[i + 1].at : sorted[0].at + length;
      const dist = to - from.at;
      const vmax = Math.min(speed, Math.sqrt(dist * accel));
      const drive = dist / vmax + vmax / accel;
      this.legs.push({ t0: t + from.dwell, s0: from.at, dist, drive, vmax, dwellAfter: from.dwell });
      t += from.dwell + drive;
    }
    this.period = t;
  }

  /** Distance along the route at time t (wraps with the period). */
  at(time: number): number {
    const t = ((time % this.period) + this.period) % this.period;
    let leg = this.legs[0];
    for (const l of this.legs) if (t >= l.t0 - l.dwellAfter) leg = l;
    const tau = t - leg.t0;
    if (tau <= 0) return leg.s0;
    const a = this.accel;
    const v = leg.vmax;
    const ta = v / a;
    const cruise = leg.drive - 2 * ta;
    let s: number;
    if (tau < ta) s = 0.5 * a * tau * tau;
    else if (tau < ta + cruise) s = 0.5 * v * ta + v * (tau - ta);
    else {
      const tb = Math.min(ta, tau - ta - cruise);
      s = 0.5 * v * ta + v * cruise + v * tb - 0.5 * a * tb * tb;
    }
    return leg.s0 + Math.min(leg.dist, s);
  }
}

// ------------------------------------------------------------------ fleets

/** One vehicle (or a tug and its trailers) following a path. */
interface Unit {
  parts: { kind: MoverKind; back: number }[];
  color: Vec3;
  /** Offset along the path at time zero. */
  s0: number;
}

interface Stream {
  path: Path;
  speed: number;
  units: Unit[];
  /** Open roads wrap with a hidden gap; vehicles dip out of sight at the ends. */
  gap: number;
  schedule: Schedule | null;
  /** Points of interest for lights: whether units show head and tail lights. */
  lit: boolean;
  /** Vertical offset from the sampled path (water lines, kerbs). */
  sink: boolean;
}

export const CAR_COLOURS: Vec3[] = [
  [0.78, 0.79, 0.78], [0.8, 0.8, 0.79], [0.72, 0.73, 0.74], [0.03, 0.03, 0.035], [0.035, 0.035, 0.04], [0.24, 0.25, 0.26],
  [0.46, 0.47, 0.49], [0.5, 0.51, 0.52], [0.05, 0.08, 0.18], [0.42, 0.035, 0.03], [0.06, 0.13, 0.08], [0.48, 0.41, 0.3],
  [0.22, 0.36, 0.5], [0.62, 0.3, 0.05], [0.2, 0.21, 0.23], [0.12, 0.05, 0.05],
];
const CAR_WEIGHTS = [10, 7, 6, 9, 6, 9, 8, 7, 5, 5, 2, 2, 2, 1, 6, 2];

function pickColour(r: () => number): Vec3 {
  const total = CAR_WEIGHTS.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < CAR_COLOURS.length; i++) {
    x -= CAR_WEIGHTS[i];
    if (x <= 0) return CAR_COLOURS[i];
  }
  return CAR_COLOURS[0];
}

function roadVehicle(r: () => number, lorries: number, buses: number): { kind: MoverKind; color: Vec3 } {
  const x = r();
  if (x < lorries) return { kind: 'lorry', color: [[0.75, 0.76, 0.76], [0.45, 0.05, 0.04], [0.06, 0.12, 0.3], [0.08, 0.2, 0.1], [0.05, 0.05, 0.06]][Math.floor(r() * 5)] as Vec3 };
  if (x < lorries + buses) return { kind: r() < 0.5 ? 'bus' : 'coach', color: r() < 0.6 ? [0.5, 0.06, 0.05] : [0.75, 0.76, 0.77] };
  const y = r();
  if (y < 0.1) return { kind: 'van', color: r() < 0.7 ? [0.76, 0.77, 0.77] : pickColour(r) };
  if (y < 0.36) return { kind: 'suv', color: pickColour(r) };
  if (y < 0.62) return { kind: 'hatch', color: pickColour(r) };
  return { kind: 'sedan', color: pickColour(r) };
}

/** Fills a lane with vehicles at irregular spacing averaging `gap` metres. */
function populate(r: () => number, length: number, gap: number, pick: () => { kind: MoverKind; color: Vec3 }): Unit[] {
  const units: Unit[] = [];
  let s = r() * gap;
  while (s < length) {
    const v = pick();
    units.push({ parts: [{ kind: v.kind, back: 0 }], color: v.color, s0: s });
    // traffic bunches: mostly short gaps with the occasional long one
    s += MOVER_LENGTH[v.kind] * 2 + 6 + gap * (0.25 + 1.5 * Math.pow(r(), 2.2));
  }
  return units;
}

// ------------------------------------------------------------------ the world's roads

/** Lifts a motorway lane onto the deck exactly as motorway.ts builds it. */
function onMotorway(pts: P2[]): Vec3[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0], deckAt(p[0], p[1], [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]) + 0.06, p[1]] as Vec3;
  });
}

/** Lanes either side of the motorway's central barrier: inner (fast) and outer (slow). */
export const MOTORWAY_LANES = [2.75, 6.45];

/** Avenues and bridges in the city, split into dry runs between the water. */
export function cityRoutes(): P2[][] {
  const runs: P2[][] = [];
  const split = (a: P2, b: P2) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(len / 20);
    let run: P2[] = [];
    for (let i = 0; i <= n; i++) {
      const p: P2 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      if (shorelineDistance(p[0], p[1]) < 18) {
        if (run.length > 1) runs.push(run);
        run = [];
      } else run.push(p);
    }
    if (run.length > 1) runs.push(run);
  };
  for (let row = -16; row <= 12; row += 4) {
    const z = CITY.z + row * 96 - 48;
    split([CITY.x - 2300, z], [CITY.x + 2100, z]);
  }
  for (let column = -16; column <= 12; column += 4) {
    const x = CITY.x + column * 130 - 65;
    split([x, CITY.z - 1800], [x, CITY.z + 2200]);
  }
  return runs.filter((r) => Math.hypot(r[r.length - 1][0] - r[0][0], r[r.length - 1][1] - r[0][1]) > 250);
}

function bridgeRoute(site: ReturnType<typeof urbanBridgeSites>[number]): { pts: P2[]; height: (x: number, z: number) => number } {
  const { x, centerZ: cz, halfSpan: span, deckY } = site;
  const south = cz - span - 360;
  const north = cz + span + 360;
  const endS = heightAt(x, south) + 0.3;
  const endN = heightAt(x, north) + 0.3;
  const height = (_x: number, z: number) => {
    const off = Math.abs(z - cz);
    if (off <= span) return deckY + 0.27;
    const end = z < cz ? endS : endN;
    return Math.max(heightAt(x, z) + 0.3, deckY + ((end - deckY) * (off - span)) / 360) + 0.04;
  };
  const pts: P2[] = [];
  for (let z = south; z <= north; z += 8) pts.push([x, z]);
  return { pts, height };
}

// ------------------------------------------------------------------ the airport

/** Landside: a one-way loop each way around the terminal road, connectors and perimeter road. */
export const LANDSIDE_LOOPS: P2[][] = [
  [[597, 597], [2665, 597], [2665, 823], [597, 823]],
  [[2671, 587], [591, 587], [591, 829], [2671, 829]],
];

/** Airside service road lanes: eastbound on the +z side, westbound on the -z side. */
const SERVICE_EAST = 450;
const SERVICE_WEST = 442;

/** Stands with an aircraft parked on them: the same draw as parkedAircraft(). */
export function occupiedStands(): number[] {
  const r = rng(11);
  const keep = STANDS.map(() => r() > 0.25);
  return STANDS.map((_, i) => i).filter((i) => keep[i] && i !== DEPARTURE_STAND);
}

/**
 * An apron service loop: westbound along the service road with a detour
 * around each visited stand (down the starboard side past the holds, behind
 * the tail, back up the port side), a U-turn at each end, eastbound back.
 * Returns the loop and the distances of the hold-side stops.
 */
export function serviceLoop(stands: number[]): { pts: P2[]; stops: number[] } {
  const xs = [...stands].map((i) => STANDS[i].x).sort((a, b) => b - a);
  const west = APRON.x0 + 14;
  const east = APRON.x1 - 14;
  const raw: P2[] = [[east, SERVICE_WEST]];
  for (const sx of xs) raw.push([sx + 14, SERVICE_WEST], [sx + 14, 345], [sx - 14, 345], [sx - 14, SERVICE_WEST]);
  raw.push([west, SERVICE_WEST], [west - 4, SERVICE_WEST + 4], [west, SERVICE_EAST], [east, SERVICE_EAST], [east + 4, SERVICE_EAST - 4]);
  const pts = roundCorners(raw, 7, true, 6);
  // stops: alongside the aft hold of each stand, on the starboard leg
  const path = new Path(lift(pts, () => 0), true);
  const stops: number[] = [];
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  for (const sx of xs) {
    let best = 0;
    let bestD = Infinity;
    for (let d = 0; d < path.length; d += 1) {
      path.sample(d, pose);
      const dd = Math.hypot(pose.x - (sx - 14), pose.z - 364);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    stops.push(best);
  }
  return { pts, stops };
}

export interface GroundService { kind: MoverKind; x: number; z: number; heading: number; color: Vec3; y?: number }

/**
 * Equipment standing at the occupied stands: belt loaders at the holds,
 * catering trucks at the rear service door, fuel bowsers under the
 * starboard wing and ULD dollies. Aircraft face +z, so starboard is -x.
 */
export function standEquipment(): GroundService[] {
  const out: GroundService[] = [];
  const r = rng(808);
  const white: Vec3 = [0.74, 0.75, 0.75];
  for (const i of occupiedStands()) {
    const sx = STANDS[i].x;
    const z0 = STANDS[i].z - 2;
    out.push({ kind: 'loader', x: sx - 2.2 - 3.9, z: z0 + 8.5, heading: 0, color: white });
    if (r() < 0.7) out.push({ kind: 'loader', x: sx - 2.2 - 3.9, z: z0 - 9, heading: 0, color: white });
    if (r() < 0.55) out.push({ kind: 'catering', x: sx - 2.3 - 4.55, z: z0 - 14.6, heading: 0, color: [0.08, 0.2, 0.42] });
    if (r() < 0.5) out.push({ kind: 'fuel', x: sx - 10.5, z: z0 + 1.0, heading: Math.PI / 2, color: [0.6, 0.06, 0.05] });
    if (r() < 0.6) {
      for (let k = 0; k < 3; k++) out.push({ kind: r() < 0.5 ? 'uld' : 'cart', x: sx - 17.6, z: z0 - 6 + k * 3.4, heading: Math.PI / 2, color: white });
    }
    // ramp crew in hi-vis: at the hold door, by the loader, one walking the nose
    const vis: Vec3 = r() < 0.5 ? [0.85, 0.32, 0.04] : [0.78, 0.72, 0.08];
    out.push({ kind: 'person', x: sx - 2.8, z: z0 + 7.2, heading: Math.PI, color: vis });
    out.push({ kind: 'person', x: sx - 9.8, z: z0 + 10.1, heading: r() * 6.28, color: vis });
    if (r() < 0.6) out.push({ kind: 'person', x: sx + (r() - 0.5) * 6, z: z0 + 20.5, heading: r() * 6.28, color: [0.85, 0.32, 0.04] });
  }
  return out;
}

/** The multi-storey decks fill up; the rental lot is nearly full of white and silver cars. */
export function landsideCars(): GroundService[] {
  const r = rng(9090);
  const out: GroundService[] = [];
  for (const b of landsideBays()) {
    const rental = b.y < 1 && b.x < 900;
    if (r() > (rental ? 0.86 : 0.74)) continue;
    const v = roadVehicle(r, 0, 0);
    const kind: MoverKind = v.kind === 'van' ? 'sedan' : v.kind;
    const color: Vec3 = rental ? ([[0.78, 0.79, 0.78], [0.5, 0.51, 0.52], [0.03, 0.03, 0.035], [0.24, 0.25, 0.26]][Math.floor(r() * 4)] as Vec3) : v.color;
    out.push({ kind, x: b.x, y: b.y, z: b.z, heading: b.heading + (r() - 0.5) * 0.05, color });
  }
  return out;
}

/** Ground equipment lined up in a yard at the east end of the apron. */
export function gseYard(): GroundService[] {
  const out: GroundService[] = [];
  const r = rng(77);
  const white: Vec3 = [0.74, 0.75, 0.75];
  const yellow: Vec3 = [0.78, 0.6, 0.06];
  for (let row = 0; row < 4; row++) {
    const z = 252 + row * 12;
    for (let x = 2428; x < 2538; x += row < 2 ? 3.4 : 8.5) {
      if (r() < 0.12) continue;
      if (row < 2) out.push({ kind: r() < 0.4 ? 'uld' : 'cart', x, z, heading: Math.PI / 2, color: white });
      else {
        const k = r();
        const kind: MoverKind = k < 0.35 ? 'tug' : k < 0.6 ? 'loader' : k < 0.75 ? 'pushback' : k < 0.88 ? 'catering' : 'fuel';
        out.push({ kind, x, z, heading: Math.PI / 2, color: kind === 'tug' || kind === 'pushback' ? yellow : kind === 'catering' ? [0.08, 0.2, 0.42] : kind === 'fuel' ? [0.6, 0.06, 0.05] : white });
      }
    }
  }
  return out;
}

/** Car park bays not already taken by the static ground props. */
export function parkedCars(): GroundService[] {
  const taken = groundPropPlacements().filter((p) => p.kind === 'car');
  const r = rng(4242);
  const out: GroundService[] = [];
  const free = (x: number, z: number) => !taken.some((p) => Math.abs(p.x - x) < 1.6 && Math.abs(p.z - z) < 2.5);
  const park = (x: number, z: number, heading: number) => {
    if (!free(x, z) || r() > 0.78) return;
    const v = roadVehicle(r, 0, 0);
    out.push({ kind: v.kind === 'van' && r() < 0.6 ? 'sedan' : v.kind, x, z, heading: heading + (r() - 0.5) * 0.06, color: v.color });
  };
  // the four short lots at each end of the courts
  for (const lot of [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200]) {
    for (const [row, z] of [652, 676, 748, 772].entries()) {
      for (let bay = 0; bay < 10; bay++) park(lot + 5 + bay * 3.2, z, row % 2 ? -Math.PI / 2 : Math.PI / 2);
    }
  }
  // the long middle rows of each court
  for (const p of PARKING_COURTS) {
    for (const [row, z] of [650, 676, 748, 774].entries()) {
      for (let x = p.x0 + 76 + 1.6; x < p.x1 - 57; x += 3.2) park(x, z, row % 2 ? -Math.PI / 2 : Math.PI / 2);
    }
  }
  return out;
}

// ------------------------------------------------------------------ water

/** The river's navigation channel: barges keep right of the centreline. */
function riverLane(side: number): P2[] {
  const pts: P2[] = [];
  for (let x = -14000; x <= 14000; x += 25) pts.push([x, riverZ(x) + side * Math.min(38, riverWidthAt(x) * 0.36)]);
  return side > 0 ? pts : pts.reverse();
}

function lakeCircuit(k: number): P2[] {
  const pts: P2[] = [];
  const rx = 520 - k * 140;
  const rz = 380 - k * 90;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    pts.push([LAKE.x + 60 * k + Math.cos(a) * rx, LAKE.z - 40 + Math.sin(a) * rz]);
  }
  return k % 2 ? pts.reverse() : pts;
}

// ------------------------------------------------------------------ the simulation

export interface MoverFrame {
  /** Instance data per kind (MOVER_FLOATS each), and the number used. */
  data: Record<MoverKind, Float32Array>;
  count: Record<MoverKind, number>;
  /** Head and tail lights as POINTS_VS records (8 floats each). */
  lights: number[];
}

export class Traffic {
  private streams: Stream[] = [];
  private parked: GroundService[] = [];
  readonly frame: MoverFrame;
  private pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };

  constructor(reduced = false) {
    const r = rng(1789);
    const density = reduced ? 0.6 : 1;

    // motorway: two lanes each way
    const centre = motorwayLine();
    for (const dir of [1, -1]) {
      const line = dir > 0 ? centre : [...centre].reverse();
      for (const [li, off] of MOTORWAY_LANES.entries()) {
        const pts = offsetLine(line, off, false);
        const path = new Path(onMotorway(pts));
        const fast = li === 0;
        const units = populate(r, path.length, (fast ? 95 : 70) / density, () => (fast ? roadVehicle(r, 0, 0.01) : roadVehicle(r, 0.22, 0.04)));
        this.streams.push({ path, speed: fast ? 33 : 25.5, units, gap: 120, schedule: null, lit: true, sink: true });
      }
    }

    // the city's avenues, both ways, and its bridges
    for (const run of cityRoutes()) {
      for (const dir of [1, -1]) {
        const line = dir > 0 ? run : [...run].reverse();
        const pts = offsetLine(line, 3.2, false);
        const path = new Path(lift(pts, (x, z) => heightAt(x, z) + 0.25));
        const units = populate(r, path.length, 72 / density, () => roadVehicle(r, 0.015, 0.05));
        this.streams.push({ path, speed: 12.5 + r() * 2, units, gap: 60, schedule: null, lit: true, sink: true });
      }
    }
    for (const site of urbanBridgeSites()) {
      const b = bridgeRoute(site);
      for (const dir of [1, -1]) {
        const line = dir > 0 ? b.pts : [...b.pts].reverse();
        const path = new Path(lift(offsetLine(line, 3.6, false), b.height));
        const units = populate(r, path.length, 50 / density, () => roadVehicle(r, 0.03, 0.06));
        this.streams.push({ path, speed: 13, units, gap: 60, schedule: null, lit: true, sink: true });
      }
    }

    // the airport's landside loops
    for (const loop of LANDSIDE_LOOPS) {
      const pts = roundCorners(loop, 9, true, 6);
      const path = new Path(lift(pts, () => 0.17), true);
      const units = populate(r, path.length, 38 / density, () => {
        const v = roadVehicle(r, 0, 0.08);
        if (v.kind === 'bus') return { kind: 'coach' as MoverKind, color: [0.07, 0.2, 0.45] as Vec3 };
        if (r() < 0.12) return { kind: 'sedan' as MoverKind, color: [0.7, 0.55, 0.06] as Vec3 };
        return v;
      });
      // closed loops must not overlap where the last unit meets the first
      while (units.length > 1 && units[units.length - 1].s0 > path.length - 14) units.pop();
      this.streams.push({ path, speed: 8.5, units, gap: 0, schedule: null, lit: true, sink: false });
    }

    // apron service: baggage trains, catering and fuel trucks, buses and a follow-me car
    const stands = occupiedStands();
    const crews: { kind: MoverKind; trailers: MoverKind[]; color: Vec3; visit: number[] }[] = [
      { kind: 'tug', trailers: ['cart', 'cart', 'uld', 'cart'], color: [0.78, 0.6, 0.06], visit: stands.filter((_, k) => k % 3 === 0) },
      { kind: 'tug', trailers: ['uld', 'uld', 'cart'], color: [0.74, 0.75, 0.75], visit: stands.filter((_, k) => k % 3 === 1) },
      { kind: 'tug', trailers: ['cart', 'cart', 'cart'], color: [0.78, 0.6, 0.06], visit: stands.filter((_, k) => k % 3 === 2) },
      { kind: 'catering', trailers: [], color: [0.08, 0.2, 0.42], visit: stands.filter((_, k) => k % 4 === 1) },
      { kind: 'fuel', trailers: [], color: [0.6, 0.06, 0.05], visit: stands.filter((_, k) => k % 4 === 3) },
      { kind: 'apronbus', trailers: [], color: [0.1, 0.24, 0.5], visit: [] },
      { kind: 'apronbus', trailers: [], color: [0.1, 0.24, 0.5], visit: [] },
      { kind: 'followme', trailers: [], color: [0.78, 0.6, 0.06], visit: [] },
      { kind: 'van', trailers: [], color: [0.74, 0.75, 0.75], visit: [] },
    ];
    for (const [k, crew] of crews.entries()) {
      const loop = serviceLoop(crew.visit);
      const path = new Path(lift(loop.pts, () => 0.17), true);
      const schedule = new Schedule(path.length, 6.5, loop.stops.map((at) => ({ at, dwell: 22 + r() * 18 })));
      const parts: Unit['parts'] = [{ kind: crew.kind, back: 0 }];
      let back = MOVER_LENGTH[crew.kind];
      for (const t of crew.trailers) {
        back += 0.75 + MOVER_LENGTH[t];
        parts.push({ kind: t, back });
        back += MOVER_LENGTH[t];
      }
      this.streams.push({ path, speed: 0, units: [{ parts, color: crew.color, s0: (k / crews.length) * schedule.period }], gap: 0, schedule, lit: true, sink: false });
    }

    // travellers on the terminal forecourt, walking its length both ways
    {
      const pts = roundCorners([[790, 537], [2410, 537], [2410, 546], [790, 546]], 3, true, 4);
      const path = new Path(lift(pts, () => 0.17), true);
      const units: Unit[] = [];
      const coats: Vec3[] = [[0.05, 0.05, 0.06], [0.2, 0.05, 0.05], [0.08, 0.12, 0.25], [0.35, 0.3, 0.22], [0.25, 0.26, 0.27], [0.5, 0.48, 0.45], [0.1, 0.18, 0.12]];
      for (let s = r() * 5; s < path.length - 2; s += 3 + Math.pow(r(), 2) * 18) units.push({ parts: [{ kind: 'person', back: 0 }], color: coats[Math.floor(r() * coats.length)], s0: s });
      this.streams.push({ path, speed: 1.3, units, gap: 0, schedule: null, lit: false, sink: false });
    }

    // water: barges both ways on the river, boats on the river and the lake
    for (const side of [1, -1]) {
      const path = new Path(lift(riverLane(side), () => WATER_LEVEL));
      const units: Unit[] = [];
      for (let s = r() * 3000; s < path.length; s += 2600 + r() * 3200) units.push({ parts: [{ kind: 'barge', back: 0 }], color: [[0.12, 0.2, 0.35], [0.35, 0.08, 0.05], [0.1, 0.25, 0.12]][Math.floor(r() * 3)] as Vec3, s0: s });
      this.streams.push({ path, speed: 3.2, units, gap: 400, schedule: null, lit: true, sink: false });
      const boats = new Path(lift(riverLane(side * 0.4), () => WATER_LEVEL));
      const bu: Unit[] = [];
      for (let s = r() * 2000; s < boats.length; s += 1800 + r() * 2600) bu.push({ parts: [{ kind: 'boat', back: 0 }], color: [[0.05, 0.1, 0.3], [0.5, 0.06, 0.04], [0.1, 0.1, 0.1]][Math.floor(r() * 3)] as Vec3, s0: s });
      this.streams.push({ path: boats, speed: 7, units: bu, gap: 300, schedule: null, lit: false, sink: false });
    }
    for (let k = 0; k < 3; k++) {
      const path = new Path(lift(lakeCircuit(k), () => WATER_LEVEL), true);
      const units: Unit[] = [];
      const n = 2 + k;
      for (let i = 0; i < n; i++) units.push({ parts: [{ kind: k === 2 ? 'boat' : 'sailboat', back: 0 }], color: [0.06, 0.14, 0.3], s0: (i / n) * path.length + r() * 50 });
      this.streams.push({ path, speed: k === 2 ? 5 : 2.6, units, gap: 0, schedule: null, lit: false, sink: false });
    }

    this.parked = [...parkedCars(), ...standEquipment(), ...landsideCars(), ...gseYard()];

    const cap: Record<string, number> = {};
    for (const k of MOVER_KINDS) cap[k] = 0;
    for (const s of this.streams) for (const u of s.units) for (const p of u.parts) cap[p.kind]++;
    for (const p of this.parked) cap[p.kind]++;
    cap.carlod = cap.sedan + cap.hatch + cap.suv;
    const data = {} as Record<MoverKind, Float32Array>;
    const count = {} as Record<MoverKind, number>;
    for (const k of MOVER_KINDS) {
      data[k] = new Float32Array(Math.max(1, cap[k] + 64 + (k.startsWith('train') ? 16 : 0)) * MOVER_FLOATS);
      count[k] = 0;
    }
    this.frame = { data, count, lights: [] };
  }

  /** Adds standing figures or parked vehicles after construction (people on the station platforms). */
  addParked(list: GroundService[]) {
    this.parked.push(...list);
    for (const k of new Set(list.map((p) => p.kind))) {
      let n = 64 + this.parked.filter((p) => p.kind === k).length;
      for (const st of this.streams) for (const u of st.units) for (const part of u.parts) if (part.kind === k) n++;
      if (this.frame.data[k].length < n * MOVER_FLOATS) this.frame.data[k] = new Float32Array(n * MOVER_FLOATS);
    }
  }

  /** Total moving units, for tests and budgets. */
  get units(): number {
    return this.streams.reduce((a, s) => a + s.units.length, 0);
  }

  /** The pose of one unit's lead vehicle at a time, for tests. */
  poseOf(stream: number, unit: number, time: number): Pose | null {
    const s = this.streams[stream];
    const u = s?.units[unit];
    if (!u) return null;
    return this.place(s, u, 0, time, { x: 0, y: 0, z: 0, heading: 0, pitch: 0 });
  }

  get streamCount(): number {
    return this.streams.length;
  }

  private place(s: Stream, u: Unit, back: number, time: number, out: Pose): Pose | null {
    const L = s.path.length;
    let d: number;
    if (s.schedule) d = s.schedule.at(time + u.s0) - back;
    else if (s.path.closed) d = u.s0 + s.speed * time - back;
    else {
      const cycle = L + s.gap;
      d = (((u.s0 + s.speed * time) % cycle) + cycle) % cycle - back;
      if (d > L || d < 0) return null;
    }
    s.path.sample(d, out);
    if (s.sink && !s.path.closed) {
      // dip out of sight where a road just ends
      const ends = Math.min(d, L - d);
      if (ends < 30) out.y -= (1 - smoothstep(0, 30, ends)) * 4.5;
    }
    return out;
  }

  /**
   * Fills the frame for time `time`. Only vehicles within `range` metres of
   * the eye are emitted; lights are emitted within `lightRange`.
   */
  update(time: number, eye: Vec3, range: number, lightRange: number): MoverFrame {
    const f = this.frame;
    for (const k of MOVER_KINDS) f.count[k] = 0;
    f.lights.length = 0;
    const r2 = range * range;
    const l2 = lightRange * lightRange;
    const pose = this.pose;
    const lod2 = 650 * 650;
    const push = (k: MoverKind, p: Pose, c: Vec3, d2: number) => {
      // past a few hundred metres a car is two blocks of colour
      const kind: MoverKind = d2 > lod2 && (k === 'sedan' || k === 'hatch' || k === 'suv') ? 'carlod' : k;
      const n = f.count[kind];
      const buf = f.data[kind];
      if ((n + 1) * MOVER_FLOATS > buf.length) return;
      const o = n * MOVER_FLOATS;
      buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z; buf[o + 3] = p.heading;
      buf[o + 4] = p.pitch; buf[o + 5] = c[0]; buf[o + 6] = c[1]; buf[o + 7] = c[2];
      f.count[kind] = n + 1;
    };
    for (const s of this.streams) {
      for (const u of s.units) {
        for (const part of u.parts) {
          if (!this.place(s, u, part.back, time, pose)) continue;
          const dx = pose.x - eye[0];
          const dz = pose.z - eye[2];
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          push(part.kind, pose, u.color, d2);
          if (!s.lit || d2 > l2 || part.back > 0) continue;
          this.lightsFor(part.kind, pose, d2 > 2500 * 2500);
        }
      }
    }
    for (const p of this.parked) {
      const dx = p.x - eye[0];
      const dz = p.z - eye[2];
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      pose.x = p.x; pose.y = p.y ?? 0.17; pose.z = p.z; pose.heading = p.heading; pose.pitch = 0;
      push(p.kind, pose, p.color, d2);
    }
    return f;
  }

  /** Appends one extra instance to this frame (trains, the departure's tug). */
  add(kind: MoverKind, p: Pose, c: Vec3) {
    const f = this.frame;
    const n = f.count[kind];
    const buf = f.data[kind];
    if ((n + 1) * MOVER_FLOATS > buf.length) return;
    buf.set([p.x, p.y, p.z, p.heading, p.pitch, c[0], c[1], c[2]], n * MOVER_FLOATS);
    f.count[kind] = n + 1;
  }

  private lightsFor(kind: MoverKind, p: Pose, far: boolean) {
    const L = this.frame.lights;
    const c = Math.cos(p.heading);
    const sn = Math.sin(p.heading);
    const half = MOVER_LENGTH[kind];
    if (kind === 'barge' || kind === 'boat' || kind === 'sailboat') {
      // masthead light on the wheelhouse mast, a bow light, lit cabin windows
      L.push(p.x - c * 32, p.y + 8.7, p.z - sn * 32, 1.0, 0.95, 0.85, 1.4, 0);
      L.push(p.x + c * 39, p.y + 2.4, p.z + sn * 39, 1.0, 0.95, 0.85, 1.0, 0);
      L.push(p.x - c * 34, p.y + 3.0, p.z - sn * 34, 1.0, 0.75, 0.45, 2.2, 0);
      return;
    }
    const y = p.y + (kind === 'lorry' || kind === 'bus' || kind === 'coach' || kind === 'apronbus' ? 0.85 : 0.68);
    if (far) {
      L.push(p.x + c * half, y, p.z + sn * half, 1.0, 0.9, 0.72, 2.0, 0);
      L.push(p.x - c * half, y, p.z - sn * half, 1.0, 0.08, 0.05, 1.6, 0);
      return;
    }
    for (const side of [-0.62, 0.62]) {
      const ox = -sn * side;
      const oz = c * side;
      L.push(p.x + c * (half + 0.05) + ox, y, p.z + sn * (half + 0.05) + oz, 1.0, 0.92, 0.78, 0.55, 0);
      L.push(p.x - c * (half + 0.05) + ox, y + 0.1, p.z - sn * (half + 0.05) + oz, 1.0, 0.07, 0.04, 0.38, 0);
    }
    // amber beacons on airside vehicles
    if (kind === 'tug' || kind === 'pushback' || kind === 'fuel' || kind === 'catering' || kind === 'loader' || kind === 'followme' || kind === 'apronbus') {
      const h = kind === 'tug' ? 2.3 : kind === 'apronbus' ? 3.3 : kind === 'followme' ? 2.35 : 3.05;
      L.push(p.x, p.y + h, p.z, 1.0, 0.55, 0.08, 0.5, 4 + ((Math.abs(p.x * 0.37 + p.z * 0.11) % 1) * 0.99));
    }
  }
}
