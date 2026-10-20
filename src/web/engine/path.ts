// The approach, in metres. Runway 09 runs east along +x from the threshold at
// x = 0. Flights arrive from the north-west on a curved base leg over the city,
// join a 3–4° final, touch down, roll out and turn off onto the taxiway.
//
//   gate 0 plan … gate 3 package   curved intermediate approach
//   gate 4 secure … gate 6 configure  final approach
//   gate 7 monitor                touchdown
//   gate 8 govern                 roll-out

import { v3, type Vec3 } from './math.ts';

export const RUNWAY = { x0: 0, x1: 3200, width: 45, y: 0.12 };
export const TAXIWAY_Z = 190;

export const GATES: Vec3[] = [
  [-9800, 980, -4300],
  [-8500, 880, -3150],
  [-7150, 760, -2050],
  [-5800, 630, -1100],
  [-4450, 470, -330],
  [-3000, 300, 0],
  [-1450, 130, 0],
  [420, 3.6, 0],
  [1900, 3.6, 0],
];

/** Gate frame half-sizes (width, height) in metres. */
export const GATE_SIZE: [number, number][] = [
  [190, 120], [180, 115], [170, 108], [160, 100], [150, 92], [130, 80], [110, 66], [90, 34], [90, 34],
];

// After the last gate: roll out, turn onto a high-speed exit and taxi to the apron.
const ROLLOUT: Vec3[] = [
  [2650, 3.6, 0],
  [2920, 3.6, 40],
  [3040, 3.6, 150],
  [2900, 3.6, TAXIWAY_Z],
  [2500, 3.6, TAXIWAY_Z],
];

// Two points before the first gate let the story flight arrive from 4 km out.
const LEAD = 2;
const CONTROL: Vec3[] = [v3.add(GATES[0], [-3000, 230, -2650]), v3.add(GATES[0], [-1500, 120, -1300]), ...GATES, ...ROLLOUT, [2100, 3.6, TAXIWAY_Z]];

function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

/** Progress 0 = plan gate, 8 = govern gate, up to 13 = parked on the taxiway. */
export const PATH_MAX = 8 + ROLLOUT.length;

export const PATH_MIN = -LEAD;

export function pointAt(progress: number): Vec3 {
  const p = Math.max(PATH_MIN, Math.min(PATH_MAX, progress));
  const seg = Math.floor(p);
  const t = p - seg;
  const i = seg + LEAD;
  const c = (k: number) => CONTROL[Math.max(0, Math.min(CONTROL.length - 1, k))];
  const pt = catmull(c(i - 1), c(i), c(i + 1), c(i + 2), t);
  if (p >= 6.9) pt[1] = Math.max(3.6, pt[1]); // wheels never sink into the runway
  if (p >= 7) pt[1] = 3.6;
  return pt;
}

export function tangentAt(progress: number): Vec3 {
  const p = Math.max(PATH_MIN + 0.011, Math.min(PATH_MAX - 0.011, progress));
  return v3.norm(v3.sub(pointAt(p + 0.01), pointAt(p - 0.01)));
}

/** Signed turn rate (radians per unit progress) for banking. */
export function turnAt(progress: number): number {
  const a = tangentAt(progress - 0.05);
  const b = tangentAt(progress + 0.05);
  const cross = a[0] * b[2] - a[2] * b[0];
  return cross / 0.1;
}

/** A racetrack holding pattern abeam the approach. */
export function holdingAt(progress: number, phase: number): { pos: Vec3; dir: Vec3; bank: number } {
  const c = pointAt(Math.min(progress, 6));
  const t = tangentAt(Math.min(progress, 6));
  const side = v3.norm(v3.cross([0, 1, 0], t));
  const center = v3.add(v3.add(c, v3.scale(side, -1300)), [0, 260, 0]);
  const L = 1100;
  const R = 520;
  const perim = 4 * L + 2 * Math.PI * R;
  let s = (((phase % 1) + 1) % 1) * perim;
  let local: [number, number];
  let ldir: [number, number];
  let bank = 0;
  if (s < 2 * L) { local = [-L + s, R]; ldir = [1, 0]; }
  else if ((s -= 2 * L) < Math.PI * R) { const a = Math.PI / 2 - s / R; local = [L + R * Math.cos(a), R * Math.sin(a)]; ldir = [Math.sin(a), -Math.cos(a)]; bank = 0.42; }
  else if ((s -= Math.PI * R) < 2 * L) { local = [L - s, -R]; ldir = [-1, 0]; }
  else { s -= 2 * L; const a = -Math.PI / 2 - s / R; local = [-L + R * Math.cos(a), R * Math.sin(a)]; ldir = [Math.sin(a), -Math.cos(a)]; bank = 0.42; }
  const pos = v3.add(center, v3.add(v3.scale(t, local[0]), v3.scale(side, local[1])));
  const dir = v3.norm(v3.add(v3.scale(t, ldir[0]), v3.scale(side, ldir[1])));
  return { pos, dir, bank };
}

/** Missed approach: climb straight ahead, then turn right. t in [0, 1]. */
export function goAroundAt(start: Vec3, startDir: Vec3, t: number): { pos: Vec3; dir: Vec3 } {
  const e = t;
  const ahead = 4500 * e;
  const turn = Math.max(0, e - 0.45) * 2.2;
  const f = v3.norm([startDir[0], 0, startDir[2]]);
  const right = v3.norm(v3.cross(f, [0, 1, 0]));
  const pos: Vec3 = [
    start[0] + f[0] * ahead + right[0] * 2600 * turn * turn,
    start[1] + 30 + 900 * Math.pow(e, 1.3),
    start[2] + f[2] * ahead + right[2] * 2600 * turn * turn,
  ];
  const dir = v3.norm(v3.add(v3.scale(f, 1), v3.add(v3.scale(right, turn * 1.6), [0, 0.18, 0])));
  return { pos, dir };
}
