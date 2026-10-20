// The airport: runway 09/27 with its markings, taxiways, apron, terminal,
// control tower, hangars, and every light a pilot would see on approach.

import { Geo } from '../gl.ts';
import { type Vec3, rng, v3 } from '../math.ts';
import { RUNWAY, TAXIWAY_Z } from '../path.ts';
import { buildServiceArchitecture, buildTerminalArchitecture, buildTowerArchitecture } from './architecture.ts';

export const TOWER = { x: 2760, z: 600, cab: 62 };
export const APRON = { x0: 650, x1: 2550, z0: 232, z1: 430 };
export const TERMINAL = { x0: 760, x1: 2440, z0: 470, z1: 530 };
export const PARKING_COURTS = [796, 1196, 1596, 1996].map((x0) => ({ x0, x1: x0 + 250, z0: 629, z1: 802 }));
export const STANDS: { x: number; z: number }[] = [];
for (let x = 820; x <= 2380; x += 78) STANDS.push({ x, z: 378 });
/** The stand the scripted departure pushes back from; no aircraft is parked there. */
export const DEPARTURE_STAND = 3;

/** Surface quads: position + (along, across, kind). 6 floats per vertex. */
export function buildSurfaces(): { data: Float32Array; indices: Uint32Array } {
  const data: number[] = [];
  const idx: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, la: [number, number], lb: [number, number], lc: [number, number], ld: [number, number], kind: number) => {
    const base = data.length / 6;
    for (const [p, l] of [[a, la], [b, lb], [c, lc], [d, ld]] as [Vec3, [number, number]][]) data.push(p[0], p[1], p[2], l[0], l[1], kind);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // runway, split along its length for depth precision
  const hw = RUNWAY.width / 2;
  const y = RUNWAY.y;
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const xa = RUNWAY.x0 + ((RUNWAY.x1 - RUNWAY.x0) * i) / steps;
    const xb = RUNWAY.x0 + ((RUNWAY.x1 - RUNWAY.x0) * (i + 1)) / steps;
    quad([xa, y, -hw - 7], [xb, y, -hw - 7], [xb, y, hw + 7], [xa, y, hw + 7], [xa, -hw - 7], [xb, -hw - 7], [xb, hw + 7], [xa, hw + 7], 0);
  }
  // a strip of taxiway along a polyline
  const strip = (pts: [number, number][], width: number, kind: number, yy = 0.09) => {
    let along = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const dx = (x1 - x0) / len;
      const dz = (z1 - z0) / len;
      const nx = -dz * width / 2;
      const nz = dx * width / 2;
      quad([x0 - nx, yy, z0 - nz], [x1 - nx, yy, z1 - nz], [x1 + nx, yy, z1 + nz], [x0 + nx, yy, z0 + nz],
        [along, -width / 2], [along + len, -width / 2], [along + len, width / 2], [along, width / 2], kind);
      along += len;
    }
  };
  strip([[-150, TAXIWAY_Z], [RUNWAY.x1 + 150, TAXIWAY_Z]], 23, 1);
  strip([[-120, TAXIWAY_Z], [-60, 70], [-30, 0]], 23, 1, 0.08);
  strip([[820, TAXIWAY_Z], [820, 0]], 23, 1, 0.08);
  strip([[1650, TAXIWAY_Z], [1650, 0]], 23, 1, 0.08);
  strip([[2700, 0], [3000, 120], [3000, TAXIWAY_Z]], 23, 1, 0.08);
  strip([[RUNWAY.x1 + 120, TAXIWAY_Z], [RUNWAY.x1 + 90, 60], [RUNWAY.x1 + 30, 0]], 23, 1, 0.08);
  for (const x of [900, 1500, 2100]) strip([[x, TAXIWAY_Z], [x, APRON.z0 + 2]], 23, 1, 0.085);
  // apron
  quad([APRON.x0, 0.07, APRON.z0], [APRON.x1, 0.07, APRON.z0], [APRON.x1, 0.07, APRON.z1], [APRON.x0, 0.07, APRON.z1],
    [0, 0], [APRON.x1 - APRON.x0, 0], [APRON.x1 - APRON.x0, -(APRON.z1 - APRON.z0)], [0, -(APRON.z1 - APRON.z0)], 2);
  // Operational hardstands give hangars and cargo buildings a grounded campus.
  for (const [x0, x1, z0, z1] of [
    [-1180, -690, 275, 490],
    [-640, -170, 555, 720],
    [3368, 3500, 280, 405],
    [3670, 3865, 610, 677],
  ]) quad([x0, 0.065, z0], [x1, 0.065, z0], [x1, 0.065, z1], [x0, 0.065, z1],
    [0, 0], [x1 - x0, 0], [x1 - x0, -(z1 - z0)], [0, -(z1 - z0)], 2);
  return { data: new Float32Array(data), indices: new Uint32Array(idx) };
}

export function buildAirportStructures(): Geo {
  const g = new Geo();
  const dark: Vec3 = [0.12, 0.13, 0.15];
  const glass: Vec3 = [0.06, 0.12, 0.15];
  const bridgeMetal: Vec3 = [0.24, 0.28, 0.29];
  const T = TERMINAL;
  // The small occupied parking pads belong to four connected landside courts.
  // Keeping planted islands around the existing trees avoids paving over them.
  for (const p of PARKING_COURTS) {
    g.face([[p.x0, 0.1, p.z0], [p.x0, 0.1, p.z1], [p.x1, 0.1, p.z1], [p.x1, 0.1, p.z0]], [0.055, 0.066, 0.074], 0.08);
    for (const z of [p.z0, p.z1]) g.box([p.x0, 0, z], [p.x1, 0.18, z + 0.28], [0.29, 0.31, 0.31], 0.15);
    for (const x of [p.x0, p.x1]) g.box([x, 0, p.z0], [x + 0.28, 0.18, p.z1], [0.29, 0.31, 0.31], 0.15);
    const islandX = p.x0 + 54;
    g.face([[islandX, 0.13, p.z0 + 5], [islandX, 0.13, p.z1 - 5], [islandX + 14, 0.13, p.z1 - 5], [islandX + 14, 0.13, p.z0 + 5]], [0.075, 0.145, 0.083], 0.025);
    // Short rows face a central circulation aisle; existing cars and bay lines
    // stay on their original pads at either end of each parking court.
    for (const z of [650, 676, 748, 774]) {
      for (let x = p.x0 + 76; x < p.x1 - 57; x += 3.2) g.face([[x, 0.115, z - 2.7], [x, 0.115, z + 2.7], [x + 0.09, 0.115, z + 2.7], [x + 0.09, 0.115, z - 2.7]], [0.58, 0.6, 0.57], 0.05);
    }
  }
  g.merge(buildTerminalArchitecture(T));
  // Enclosed jet bridges with glass sides, a roof, telescoping cabin and wheels.
  // Their port-side ends meet the forward door instead of the aircraft's nose.
  for (const s of STANDS) {
    const x = s.x + 4.6;
    const end = s.z + 11;
    g.box([x - 1.6, 4.1, end], [x + 1.6, 4.45, T.z0], [0.32, 0.35, 0.36], 0.4);
    g.box([x - 1.8, 7.3, end], [x + 1.8, 7.6, T.z0], [0.45, 0.48, 0.48], 0.35);
    for (const side of [-1, 1]) {
      const wallX = x + side * 1.6;
      g.face([[wallX, 4.45, end], [wallX, 4.45, T.z0], [wallX, 7.3, T.z0], [wallX, 7.3, end]], glass, 0.87, 0.025);
      for (let along = end + 4; along < T.z0; along += 8) g.face([[wallX + side * 0.01, 4.45, along], [wallX + side * 0.01, 4.45, along + 0.1], [wallX + side * 0.01, 7.3, along + 0.1], [wallX + side * 0.01, 7.3, along]], bridgeMetal, 0.4);
    }
    g.box([s.x + 1.8, 4.1, end - 1.8], [x + 1.6, 7.35, end + 1.8], [0.3, 0.32, 0.33], 0.45);
    g.box([x - 0.35, 0.25, end + 9], [x + 0.35, 4.1, end + 9.7], dark);
    for (const dx of [-0.7, 0.7]) g.box([x + dx - 0.16, 0.12, end + 8.7], [x + dx + 0.16, 0.65, end + 9.5], [0.025, 0.03, 0.035]);
  }
  g.merge(buildTowerArchitecture(TOWER));
  g.merge(buildServiceArchitecture());
  return g;
}

/** Point lights: position, colour, size in metres, kind (see POINTS_VS). */
export function buildAirportLights(): number[] {
  const out: number[] = [];
  const P = (p: Vec3, c: Vec3, size: number, kind = 0) => out.push(p[0], p[1], p[2], c[0], c[1], c[2], size, kind);
  const white: Vec3 = [1.0, 0.93, 0.82];
  const amber: Vec3 = [1.0, 0.72, 0.3];
  const red: Vec3 = [1.0, 0.16, 0.12];
  const green: Vec3 = [0.3, 1.0, 0.5];
  const blue: Vec3 = [0.3, 0.45, 1.0];
  const hw = RUNWAY.width / 2 + 1.5;
  // edge lights (the last 600 m are amber, as on a real runway)
  for (let x = RUNWAY.x0; x <= RUNWAY.x1; x += 60) {
    const c = RUNWAY.x1 - x < 600 ? amber : white;
    P([x, 0.6, -hw], c, 2.6);
    P([x, 0.6, hw], c, 2.6);
  }
  // centreline: white, then alternating red/white, then red
  for (let x = RUNWAY.x0 + 15; x < RUNWAY.x1; x += 15) {
    const toEnd = RUNWAY.x1 - x;
    const c = toEnd < 300 ? red : toEnd < 900 ? ((Math.round(x / 15) % 2) ? red : white) : white;
    P([x, 0.25, 0], c, 1.3);
  }
  // touchdown zone barrettes
  for (let x = RUNWAY.x0 + 60; x < RUNWAY.x0 + 900; x += 30) {
    for (const z of [-11, -9.5, -8, 8, 9.5, 11]) P([x, 0.25, z], white, 1.0);
  }
  // threshold (green) and runway end (red) bars
  for (let z = -hw; z <= hw; z += 3) {
    P([RUNWAY.x0 - 1, 0.6, z], green, 2.2);
    P([RUNWAY.x1 + 1, 0.6, z], red, 2.2);
  }
  // ALSF-2 approach lights: 900 m of crossbars and sequenced flashers ("the rabbit")
  for (let d = 30; d <= 900; d += 30) {
    const x = RUNWAY.x0 - d;
    for (const z of [-2.1, -1.05, 0, 1.05, 2.1]) P([x, 0.9, z], white, 1.6);
    if (d >= 270) P([x, 1.2, 0], [1.0, 1.0, 1.0], 3.2, 2 + Math.min(0.99, (900 - d) / 660));
    if (d === 300) for (let z = -15; z <= 15; z += 1.5) P([x, 0.9, z], white, 1.5);
    if (d <= 270) {
      for (const z of [-11, -9.5, -8, 8, 9.5, 11]) P([x, 0.9, z], d <= 120 ? red : white, 1.3);
    }
  }
  // PAPI: two white over two red means on the glide path
  [white, white, red, red].forEach((c, i) => P([RUNWAY.x0 + 330, 1.0, -hw - 15 - i * 9], c, 2.4));
  // taxiway edges (blue) and centreline (green)
  for (let x = -150; x <= RUNWAY.x1 + 150; x += 30) {
    P([x, 0.5, TAXIWAY_Z - 13], blue, 1.4);
    P([x, 0.5, TAXIWAY_Z + 13], blue, 1.4);
  }
  for (let x = -150; x <= RUNWAY.x1 + 150; x += 15) P([x, 0.2, TAXIWAY_Z], green, 0.9);
  // Apron and landside lamps now come from the physical ground-prop fixtures.
  // obstacle lights and the rotating airport beacon on the tower
  P([TOWER.x, TOWER.cab + 22, TOWER.z], red, 2.5, 4.0);
  P([TOWER.x, TOWER.cab + 7.6, TOWER.z], [0.3, 1.0, 0.45], 6, 4.5);
  P([TOWER.x, TOWER.cab + 7.6, TOWER.z], [1.0, 1.0, 0.95], 6, 4.0);
  for (let i = 0; i < 3; i++) P([-1150 + i * 150 + 60, 24.8, 425], red, 1.8, 4.25);
  return out;
}

/** Where the static airliners stand on the apron, nose to the terminal. */
export function parkedAircraft(): { pos: Vec3; heading: Vec3; tint: Vec3 }[] {
  const r = rng(11);
  const tints: Vec3[] = [[0.12, 0.22, 0.55], [0.75, 0.1, 0.12], [0.08, 0.45, 0.42], [0.92, 0.55, 0.12], [0.35, 0.36, 0.4]];
  return STANDS.filter((_, i) => r() > 0.25 && i !== DEPARTURE_STAND).map((s) => ({
    pos: [s.x, 3.6, s.z - 2] as Vec3,
    heading: v3.norm([0, 0, 1]),
    tint: tints[Math.floor(r() * tints.length)],
  }));
}
