// A double-track electrified railway runs beside the motorway from a
// terminus on the edge of the city, past the airport's own station, out to
// the eastern horizon. Ballast, rails, catenary masts and contact wires are
// modelled; the stations have platforms, canopies, lamps and a footbridge.
// Four-car electric units shuttle along it on a timetable: into the airport
// station, out to the terminus, reverse, and back east, where they run out
// of sight beyond the hills.

import { Geo } from '../gl.ts';
import { smoothstep, type Vec3 } from '../math.ts';
import { heightAt, shorelineDistance, WATER_LEVEL } from './terrain.ts';
import { MOVER_LENGTH, Path, Schedule, motorwayLine, offsetLine, offsetLineBy, type MoverKind, type Pose } from './traffic.ts';

type P2 = [number, number];

/** Distance of the railway's centreline from the motorway's, on the airport side. */
const OFFSET = 52;
/** Each track's distance from the railway centreline. */
export const TRACK = 2.25;
/** Where the terminus buffers stand (x), and the airport station's centre. */
const TERMINUS_X = -3100;
export const AIRPORT_STATION_X = 1300;
const PLATFORM = 230;
const CAR = 25;

/** The railway centreline (2D): the motorway's line moved to the airport side, from the terminus east. */
export function railLine(): P2[] {
  const m = offsetLine(motorwayLine(), OFFSET, false);
  const out: P2[] = [];
  for (const p of m) if (p[0] >= TERMINUS_X) out.push(p);
  return out;
}

/** Height of the rail head: on a low embankment, on a viaduct over wet ground. */
export function railHeight(x: number, z: number): number {
  const ground = heightAt(x, z) + 1.0;
  const wet = 1 - smoothstep(20, 90, shorelineDistance(x, z));
  return Math.max(ground, (WATER_LEVEL + 13) * wet + ground * (1 - wet));
}

function lift(pts: P2[]): Vec3[] {
  return pts.map(([x, z]) => [x, railHeight(x, z), z] as Vec3);
}

/** Distance along a path to the point nearest x (paths here run monotonically in x). */
function distanceAtX(path: Path, x: number): number {
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  let lo = 0;
  let hi = path.length;
  const east = path.sample(path.length, pose).x > path.sample(0, pose).x;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const px = path.sample(mid, pose).x;
    if ((px < x) === east) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ------------------------------------------------------------------ geometry

const BALLAST: Vec3 = [0.3, 0.28, 0.255];
const SLEEPERS: Vec3 = [0.2, 0.19, 0.18];
const RAIL: Vec3 = [0.5, 0.48, 0.46];
const MAST: Vec3 = [0.42, 0.44, 0.45];
const WIRE: Vec3 = [0.12, 0.11, 0.1];
const CONCRETE: Vec3 = [0.42, 0.42, 0.4];
const EDGE: Vec3 = [0.75, 0.62, 0.12];
const CANOPY: Vec3 = [0.3, 0.33, 0.36];
const GLASS: Vec3 = [0.05, 0.09, 0.11];

/** A box aligned with a direction in the ground plane (`ends` false leaves the end caps off). */
function oriented(g: Geo, c: Vec3, dir: P2, halfLen: number, halfWidth: number, y0: number, y1: number, color: Vec3, gloss = 0.2, emissive = 0, ends = true) {
  const n: P2 = [-dir[1], dir[0]];
  const corner = (a: number, b: number, y: number): Vec3 => [c[0] + dir[0] * a + n[0] * b, y, c[2] + dir[1] * a + n[1] * b];
  const L = halfLen;
  const W = halfWidth;
  const quad = (p: Vec3[]) => g.face(p, color, gloss, emissive);
  quad([corner(-L, -W, y1), corner(-L, W, y1), corner(L, W, y1), corner(L, -W, y1)]);
  quad([corner(-L, -W, y0), corner(L, -W, y0), corner(L, -W, y1), corner(-L, -W, y1)]);
  quad([corner(L, W, y0), corner(-L, W, y0), corner(-L, W, y1), corner(L, W, y1)]);
  if (!ends) return;
  quad([corner(L, -W, y0), corner(L, W, y0), corner(L, W, y1), corner(L, -W, y1)]);
  quad([corner(-L, W, y0), corner(-L, -W, y0), corner(-L, -W, y1), corner(-L, W, y1)]);
}

export function buildRailway(): Geo {
  const g = new Geo();
  const line = railLine();
  const path = new Path(lift(line));
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  const at = (d: number) => {
    path.sample(d, pose);
    return { c: [pose.x, pose.y, pose.z] as Vec3, dir: [Math.cos(pose.heading), Math.sin(pose.heading)] as P2 };
  };
  const step = 20;
  for (let d = 0; d < path.length - 0.5; d += step) {
    const len = Math.min(step, path.length - d);
    const { c, dir } = at(d + len / 2);
    const n: P2 = [-dir[1], dir[0]];
    const y = c[1];
    const ground = Math.min(heightAt(c[0], c[2]), y - 0.4);
    // embankment and ballast shoulder
    const p = (a: number, b: number, yy: number): Vec3 => [c[0] + dir[0] * a + n[0] * b, yy, c[2] + dir[1] * a + n[1] * b];
    const h = len / 2 + 0.02;
    g.face([p(-h, -4.6, y - 0.55), p(-h, 4.6, y - 0.55), p(h, 4.6, y - 0.55), p(h, -4.6, y - 0.55)], BALLAST, 0.06);
    g.face([p(h, -4.6, y - 0.55), p(h, -7.2, ground - 0.2), p(-h, -7.2, ground - 0.2), p(-h, -4.6, y - 0.55)], BALLAST, 0.05);
    g.face([p(-h, 4.6, y - 0.55), p(-h, 7.2, ground - 0.2), p(h, 7.2, ground - 0.2), p(h, 4.6, y - 0.55)], BALLAST, 0.05);
    if (y - heightAt(c[0], c[2]) > 4) {
      // viaduct pier
      oriented(g, [c[0], 0, c[2]], dir, 1.2, 4.2, WATER_LEVEL - 2, y - 0.6, CONCRETE, 0.2);
    }
    for (const t of [-TRACK, TRACK]) {
      g.face([p(-h, t - 1.3, y - 0.5), p(-h, t + 1.3, y - 0.5), p(h, t + 1.3, y - 0.5), p(h, t - 1.3, y - 0.5)], SLEEPERS, 0.08);
      for (const r of [-0.72, 0.72]) {
        const rc: Vec3 = [c[0] + n[0] * (t + r), 0, c[2] + n[1] * (t + r)];
        oriented(g, rc, dir, h, 0.036, y - 0.5, y - 0.36, RAIL, 0.75, 0, false);
      }
    }
  }
  // catenary: a mast either side every 60 m with a cantilever over its track, and the wires
  for (let d = 15; d < path.length - 20; d += 60) {
    const { c, dir } = at(d);
    const n: P2 = [-dir[1], dir[0]];
    for (const side of [-1, 1]) {
      const mx = c[0] + n[0] * side * 5.6;
      const mz = c[2] + n[1] * side * 5.6;
      const base = Math.min(heightAt(mx, mz), c[1] - 0.6);
      oriented(g, [mx, 0, mz], dir, 0.16, 0.16, base, c[1] + 7.6, MAST, 0.4);
      const ax = c[0] + n[0] * side * 3.6;
      const az = c[2] + n[1] * side * 3.6;
      oriented(g, [ax, 0, az], [n[0] * side, n[1] * side], 2.0, 0.05, c[1] + 6.4, c[1] + 6.5, MAST, 0.4);
      oriented(g, [c[0] + n[0] * side * 4.1, 0, c[2] + n[1] * side * 4.1], [n[0] * side, n[1] * side], 1.5, 0.04, c[1] + 6.9, c[1] + 6.98, MAST, 0.4);
    }
    // contact and catenary wires to the next mast pair
    const next = at(Math.min(path.length - 1, d + 60));
    for (const t of [-TRACK, TRACK]) {
      const a: Vec3 = [c[0] + n[0] * t, 0, c[2] + n[1] * t];
      const b: Vec3 = [next.c[0] - next.dir[1] * t, 0, next.c[2] + next.dir[0] * t];
      const mid: Vec3 = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const dd: P2 = [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
      const y = (c[1] + next.c[1]) / 2;
      oriented(g, mid, dd, len / 2, 0.025, y + 5.45, y + 5.5, WIRE, 0.4, 0, false);
      oriented(g, mid, dd, len / 2, 0.02, y + 6.85, y + 6.89, WIRE, 0.4, 0, false);
    }
  }
  for (const [x, terminus] of [[AIRPORT_STATION_X, false], [TERMINUS_X + PLATFORM / 2 + 6, true]] as [number, boolean][]) station(g, path, distanceAtX(path, x), terminus);
  return g;
}

function station(g: Geo, path: Path, centre: number, terminus: boolean) {
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  for (let d = centre - PLATFORM / 2; d < centre + PLATFORM / 2; d += 10) {
    path.sample(d + 5, pose);
    const dir: P2 = [Math.cos(pose.heading), Math.sin(pose.heading)];
    const n: P2 = [-dir[1], dir[0]];
    const y = pose.y - 0.4;
    for (const side of [-1, 1]) {
      const pc: Vec3 = [pose.x + n[0] * side * 5.8, 0, pose.z + n[1] * side * 5.8];
      oriented(g, pc, dir, 5.02, 1.8, y - 1.2, y + 0.55, CONCRETE, 0.15);
      const ec: Vec3 = [pose.x + n[0] * side * 4.25, 0, pose.z + n[1] * side * 4.25];
      oriented(g, ec, dir, 5.02, 0.12, y + 0.551, y + 0.56, EDGE, 0.3);
      // canopy over the middle of the platform
      if (Math.abs(d + 5 - centre) < 70) {
        const cc: Vec3 = [pose.x + n[0] * side * 6.6, 0, pose.z + n[1] * side * 6.6];
        oriented(g, cc, dir, 0.12, 0.12, y + 0.55, y + 4.4, CANOPY, 0.4);
        const rc: Vec3 = [pose.x + n[0] * side * 5.9, 0, pose.z + n[1] * side * 5.9];
        oriented(g, rc, dir, 5.05, 2.4, y + 4.4, y + 4.65, CANOPY, 0.35);
        oriented(g, [pose.x + n[0] * side * 5.9, 0, pose.z + n[1] * side * 5.9], dir, 4.0, 0.15, y + 4.38, y + 4.4, [0.95, 0.95, 0.9], 0.2, 0.8);
      }
    }
  }
  // the buffer stops at a terminus, or a footbridge with lift towers at the airport
  path.sample(centre, pose);
  const dir: P2 = [Math.cos(pose.heading), Math.sin(pose.heading)];
  const n: P2 = [-dir[1], dir[0]];
  if (terminus) {
    path.sample(Math.max(0, centre - PLATFORM / 2 - 6), pose);
    for (const t of [-TRACK, TRACK]) {
      oriented(g, [pose.x + n[0] * t, 0, pose.z + n[1] * t], dir, 0.6, 1.5, pose.y - 0.5, pose.y + 0.9, [0.55, 0.08, 0.05], 0.4);
    }
    // concourse building across the end of the platforms
    path.sample(Math.max(0, centre - PLATFORM / 2 - 18), pose);
    oriented(g, [pose.x, 0, pose.z], dir, 9, 14, pose.y - 1.5, pose.y + 9, [0.36, 0.34, 0.31], 0.2);
    oriented(g, [pose.x + dir[0] * 9.05, 0, pose.z + dir[1] * 9.05], dir, 0.05, 12, pose.y + 1, pose.y + 7.5, GLASS, 0.9, 0.05);
  } else {
    for (const side of [-1, 1]) {
      const tc: Vec3 = [pose.x + n[0] * side * 6.0, 0, pose.z + n[1] * side * 6.0];
      oriented(g, tc, dir, 2.2, 1.6, pose.y - 0.4, pose.y + 9.0, CONCRETE, 0.2);
      oriented(g, [tc[0] + dir[0] * 2.21, 0, tc[2] + dir[1] * 2.21], dir, 0.02, 1.2, pose.y + 1, pose.y + 8.4, GLASS, 0.9, 0.05);
    }
    oriented(g, [pose.x, 0, pose.z], n, 7.6, 1.6, pose.y + 7.2, pose.y + 9.6, [0.4, 0.42, 0.43], 0.3);
    for (const side of [-1, 1]) oriented(g, [pose.x + dir[0] * side * 1.62, 0, pose.z + dir[1] * side * 1.62], n, 7.6, 0.02, pose.y + 7.6, pose.y + 9.2, GLASS, 0.9, 0.04);
  }
}

/** Passengers waiting on the airport station's platforms: x, platform height, z, facing the track. */
export function platformPassengers(): { x: number; y: number; z: number; heading: number }[] {
  const out: { x: number; y: number; z: number; heading: number }[] = [];
  const path = new Path(lift(railLine()));
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  const centre = distanceAtX(path, AIRPORT_STATION_X);
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = centre - 80; d <= centre + 80; d += 2.6) {
    path.sample(d, pose);
    const n: P2 = [-Math.sin(pose.heading), Math.cos(pose.heading)];
    for (const side of [-1, 1]) {
      if (r() > (Math.abs(d - centre) < 40 ? 0.45 : 0.2)) continue;
      const off = side * (5.4 + r() * 1.6);
      out.push({ x: pose.x + n[0] * off, y: pose.y + 0.15, z: pose.z + n[1] * off, heading: pose.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + (r() - 0.5) * 0.8 });
    }
  }
  return out;
}

/** Platform lamps (POINTS_VS records). */
export function buildRailwayLights(): number[] {
  const out: number[] = [];
  const path = new Path(lift(railLine()));
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  for (const x of [AIRPORT_STATION_X, TERMINUS_X + PLATFORM / 2 + 6]) {
    const centre = distanceAtX(path, x);
    for (let d = centre - 60; d <= centre + 60; d += 20) {
      path.sample(d, pose);
      const n: P2 = [-Math.sin(pose.heading), Math.cos(pose.heading)];
      for (const side of [-1, 1]) out.push(pose.x + n[0] * side * 5.9, pose.y + 3.9, pose.z + n[1] * side * 5.9, 0.95, 0.95, 0.9, 1.1, 0);
    }
  }
  return out;
}

// ------------------------------------------------------------------ trains

export interface TrainCar {
  kind: MoverKind;
  pose: Pose;
}

/**
 * One four-car unit's timetable: west on the north track with a stop at the
 * airport, into the terminus, then east on the south track through the
 * airport again and away over the horizon, where it waits before the next run.
 */
export class Train {
  private west: Path;
  private east: Path;
  private westSchedule: Schedule;
  private eastSchedule: Schedule;
  private offset: number;
  readonly period: number;
  private westTime: number;
  private eastTime: number;
  private readonly length = 4 * CAR;

  constructor(offset: number) {
    const line = railLine();
    // westbound on the north track into the terminus; eastbound leaves the
    // same platform and crosses over to the south track beyond the station
    const back = [...line].reverse();
    this.west = new Path(lift(offsetLine(back, TRACK, false)));
    const cross = PLATFORM + 40;
    this.east = new Path(lift(offsetLineBy(line, (s) => -TRACK + 2 * TRACK * smoothstep(cross, cross + 140, s))));
    const westStation = distanceAtX(this.west, AIRPORT_STATION_X) + this.length / 2;
    const eastStation = distanceAtX(this.east, AIRPORT_STATION_X) + this.length / 2;
    const westEnd = this.west.length - 8;
    // the western run starts beyond the horizon and stops at the airport and the buffers
    this.westSchedule = new Schedule(westEnd, 32, [{ at: 0, dwell: 0 }, { at: westStation, dwell: 38 }], 0.7);
    this.westTime = this.runTime(this.westSchedule, westEnd);
    // the eastern run leaves the terminus with its tail at the buffers
    const start = this.length + 8;
    this.eastSchedule = new Schedule(this.east.length, 32, [{ at: start, dwell: 0 }, { at: eastStation, dwell: 38 }], 0.7);
    this.eastTime = this.runTime(this.eastSchedule, this.east.length);
    this.period = this.westTime + 55 + this.eastTime + 70;
    this.offset = offset;
  }

  /** Time for a schedule to reach a distance (the schedules are monotonic within a run). */
  private runTime(s: Schedule, to: number): number {
    let t = 0;
    while (t < s.period && s.at(t) < to - 0.5) t += 0.5;
    return t;
  }

  /** The cars' poses at a time, or an empty list while the unit is out of sight. */
  cars(time: number): TrainCar[] {
    const t = (((time + this.offset) % this.period) + this.period) % this.period;
    let path: Path;
    let lead: number;
    if (t < this.westTime) {
      path = this.west;
      lead = this.westSchedule.at(t);
    } else if (t < this.westTime + 55) {
      path = this.west;
      lead = this.west.length - 8;
    } else if (t < this.westTime + 55 + this.eastTime) {
      path = this.east;
      lead = Math.max(this.length + 8, this.eastSchedule.at(t - this.westTime - 55));
    } else return [];
    const out: TrainCar[] = [];
    const kinds: MoverKind[] = ['traincab', 'trainpanto', 'traincar', 'traincab'];
    for (let k = 0; k < 4; k++) {
      const d = lead - MOVER_LENGTH.traincab - k * CAR;
      if (d < 0 || d > path.length) continue;
      const p = path.sample(d, { x: 0, y: 0, z: 0, heading: 0, pitch: 0 });
      // wheels on the rail heads
      p.y -= 0.36;
      // the last car is a driving car facing the other way
      if (k === 3) p.heading += Math.PI;
      // run out of sight at the far ends of the line
      if (d < 40) p.y -= (1 - d / 40) * 7;
      if (d > path.length - 40 && path === this.east) p.y -= ((d - (path.length - 40)) / 40) * 7;
      out.push({ kind: kinds[k], pose: p });
    }
    return out;
  }
}
