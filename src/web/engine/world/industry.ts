// Industry on the eastern skyline: a business park of distribution sheds
// with loading docks beside the motorway and the railway, a works with tall
// banded chimneys and a tank farm, and, on the horizon beyond the runway, a
// power station whose cooling towers trail steam across the evening sky.
// These are what an approaching pilot sees past the far end of the runway.

import { Geo } from '../gl.ts';
import { rng, type Vec3 } from '../math.ts';
import { heightAt } from './terrain.ts';

const CLAD: Vec3[] = [[0.5, 0.52, 0.53], [0.38, 0.42, 0.44], [0.55, 0.53, 0.48], [0.3, 0.36, 0.4]];
const ROOF: Vec3 = [0.42, 0.44, 0.45];
const DARK: Vec3 = [0.07, 0.075, 0.08];
const CONCRETE: Vec3 = [0.5, 0.49, 0.46];
const RED: Vec3 = [0.6, 0.08, 0.06];
const WHITE: Vec3 = [0.78, 0.78, 0.76];
const ASPHALT: Vec3 = [0.06, 0.068, 0.075];
const STEEL: Vec3 = [0.4, 0.43, 0.45];

export interface Shed { x: number; z: number; w: number; d: number; h: number }

/** The distribution sheds, long sides facing north and south. */
export const SHEDS: Shed[] = [
  { x: 5150, z: -1330, w: 150, d: 70, h: 13 },
  { x: 5380, z: -1300, w: 120, d: 80, h: 15 },
  { x: 5620, z: -1340, w: 170, d: 65, h: 12 },
  { x: 5170, z: -1180, w: 110, d: 60, h: 11 },
  { x: 5420, z: -1160, w: 160, d: 70, h: 14 },
  { x: 5690, z: -1190, w: 120, d: 70, h: 13 },
];
export const WORKS = { x: 6050, z: -1250 };
export const CHIMNEYS: Vec3[] = [[6110, 0, -1290], [6125, 0, -1262]];
export const POWER = { x: 10600, z: -950 };
export const COOLING: Vec3[] = [[10480, 0, -1060], [10690, 0, -1000]];
export const STACK: Vec3 = [10820, 0, -880];
const COOLING_HEIGHT = 128;
const CHIMNEY_HEIGHT = 74;
const STACK_HEIGHT = 175;

/** Cylinder from y0 to y1 (radii r0, r1), with optional red and white banding. */
function tube(g: Geo, x: number, z: number, y0: number, y1: number, r0: number, r1: number, color: Vec3, sides = 14, bands = 0) {
  const n = bands > 0 ? bands : 1;
  for (let b = 0; b < n; b++) {
    const ya = y0 + ((y1 - y0) * b) / n;
    const yb = y0 + ((y1 - y0) * (b + 1)) / n;
    const ra = r0 + ((r1 - r0) * b) / n;
    const rb = r0 + ((r1 - r0) * (b + 1)) / n;
    const c = bands > 0 ? (b % 2 ? WHITE : RED) : color;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      g.face([[x + Math.cos(a0) * ra, ya, z + Math.sin(a0) * ra], [x + Math.cos(a0) * rb, yb, z + Math.sin(a0) * rb], [x + Math.cos(a1) * rb, yb, z + Math.sin(a1) * rb], [x + Math.cos(a1) * ra, ya, z + Math.sin(a1) * ra]], c, 0.25);
    }
  }
}

/** A hyperboloid cooling tower: wide at the base, waisted, flaring to the lip. */
function coolingTower(g: Geo, x: number, z: number, y: number) {
  const rings = 14;
  const sides = 28;
  const profile = (t: number) => {
    // radius over height: 46 m at the foot, a 29 m waist at 76 %, 32 m at the lip
    const waist = 0.76;
    const r = t < waist ? 29 + 17 * Math.pow((waist - t) / waist, 1.7) : 29 + 3 * Math.pow((t - waist) / (1 - waist), 1.4);
    return r;
  };
  const shade = (t: number): Vec3 => [0.6 - t * 0.06, 0.59 - t * 0.06, 0.56 - t * 0.05];
  for (let k = 0; k < rings; k++) {
    const t0 = k / rings;
    const t1 = (k + 1) / rings;
    const r0 = profile(t0);
    const r1 = profile(t1);
    const y0 = y + t0 * COOLING_HEIGHT;
    const y1 = y + t1 * COOLING_HEIGHT;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      g.face([[x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0], [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1], [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1], [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0]], shade(t0), 0.15);
    }
  }
  // the dark inside of the lip, seen from above, and the leg colonnade at the foot
  const top = y + COOLING_HEIGHT;
  const rt = profile(1);
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    g.face([[x + Math.cos(a0) * rt, top, z + Math.sin(a0) * rt], [x + Math.cos(a1) * rt, top, z + Math.sin(a1) * rt], [x + Math.cos(a1) * (rt - 0.6), top - 6, z + Math.sin(a1) * (rt - 0.6)], [x + Math.cos(a0) * (rt - 0.6), top - 6, z + Math.sin(a0) * (rt - 0.6)]], DARK, 0.1);
  }
  for (let i = 0; i < sides; i += 2) {
    const a = (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * 47;
    const pz = z + Math.sin(a) * 47;
    g.box([px - 0.8, y - 1, pz - 0.8], [px + 0.8, y + 6, pz + 0.8], CONCRETE, 0.2);
  }
}

/** A portal-framed shed: ribbed cladding, a low-pitched roof with rooflights, dock doors on the south side. */
function shed(g: Geo, s: Shed, color: Vec3) {
  const y = heightAt(s.x, s.z) - 0.4;
  const x0 = s.x - s.w / 2;
  const x1 = s.x + s.w / 2;
  const z0 = s.z - s.d / 2;
  const z1 = s.z + s.d / 2;
  g.box([x0, y, z0], [x1, y + s.h, z1], color, 0.3);
  // vertical ribs of the profiled cladding
  for (let x = x0 + 2; x < x1; x += 3) {
    g.face([[x, y + 0.5, z0 - 0.06], [x + 0.25, y + 0.5, z0 - 0.06], [x + 0.25, y + s.h, z0 - 0.06], [x, y + s.h, z0 - 0.06]].reverse() as Vec3[], [color[0] * 0.85, color[1] * 0.85, color[2] * 0.85], 0.3);
    g.face([[x, y + 0.5, z1 + 0.06], [x + 0.25, y + 0.5, z1 + 0.06], [x + 0.25, y + s.h, z1 + 0.06], [x, y + s.h, z1 + 0.06]], [color[0] * 0.85, color[1] * 0.85, color[2] * 0.85], 0.3);
  }
  // low-pitched roof with translucent rooflight strips
  const ridge = y + s.h + s.d * 0.06;
  g.face([[x0 - 0.3, y + s.h, z0 - 0.3], [x0 - 0.3, ridge, s.z], [x1 + 0.3, ridge, s.z], [x1 + 0.3, y + s.h, z0 - 0.3]], ROOF, 0.35);
  g.face([[x0 - 0.3, ridge, s.z], [x0 - 0.3, y + s.h, z1 + 0.3], [x1 + 0.3, y + s.h, z1 + 0.3], [x1 + 0.3, ridge, s.z]], ROOF, 0.35);
  for (const side of [-1, 1]) {
    for (let x = x0 + 8; x < x1 - 8; x += 16) {
      const zA = s.z + side * s.d * 0.18;
      const zB = s.z + side * s.d * 0.3;
      const yA = ridge - (ridge - y - s.h) * 0.36 + 0.05;
      const yB = ridge - (ridge - y - s.h) * 0.6 + 0.05;
      const q: Vec3[] = side < 0 ? [[x, yB, zB], [x, yA, zA], [x + 6, yA, zA], [x + 6, yB, zB]] : [[x, yA, zA], [x, yB, zB], [x + 6, yB, zB], [x + 6, yA, zA]];
      g.face(q, [0.62, 0.66, 0.66], 0.6, 0.05);
    }
  }
  // dock doors with shelters, lit numbers above, and the yard in front
  for (let x = x0 + 6; x < x1 - 6; x += 7) {
    g.face([[x, y + 1.2, z0 - 0.08], [x + 3.2, y + 1.2, z0 - 0.08], [x + 3.2, y + 4.4, z0 - 0.08], [x, y + 4.4, z0 - 0.08]].reverse() as Vec3[], DARK, 0.3);
    g.box([x - 0.35, y + 1.0, z0 - 1.0], [x + 3.55, y + 4.7, z0 - 0.1], [0.08, 0.08, 0.09], 0.2);
    g.face([[x + 1.0, y + 5.0, z0 - 0.1], [x + 2.2, y + 5.0, z0 - 0.1], [x + 2.2, y + 5.5, z0 - 0.1], [x + 1.0, y + 5.5, z0 - 0.1]].reverse() as Vec3[], [0.9, 0.85, 0.6], 0.3, 0.3);
  }
  g.face([[x0 - 10, y + 0.45, z0 - 34], [x0 - 10, y + 0.45, z0], [x1 + 10, y + 0.45, z0], [x1 + 10, y + 0.45, z0 - 34]], ASPHALT, 0.15);
  // rooftop plant
  for (let x = x0 + 15; x < x1 - 10; x += 35) g.box([x, ridge - 0.3, s.z + 4], [x + 5, ridge + 1.8, s.z + 8], STEEL, 0.35);
}

export function buildIndustry(): Geo {
  const g = new Geo();
  const r = rng(61);
  SHEDS.forEach((s, i) => shed(g, s, CLAD[i % CLAD.length]));
  // estate roads
  const ey = heightAt(5400, -1260) - 0.35;
  g.face([[5050, ey, -1272], [5050, ey, -1252], [5800, ey, -1252], [5800, ey, -1272]], ASPHALT, 0.15);
  // the works: a tall process hall, banded chimneys, a tank farm and a pipe bridge
  const wy = heightAt(WORKS.x, WORKS.z) - 0.4;
  g.box([WORKS.x - 50, wy, WORKS.z - 30], [WORKS.x + 30, wy + 24, WORKS.z + 25], [0.46, 0.43, 0.38], 0.25);
  g.box([WORKS.x - 50, wy + 24, WORKS.z - 30], [WORKS.x + 30, wy + 25, WORKS.z + 25], ROOF, 0.3);
  g.box([WORKS.x - 20, wy + 25, WORKS.z - 10], [WORKS.x + 10, wy + 36, WORKS.z + 10], [0.5, 0.47, 0.42], 0.25);
  for (const c of CHIMNEYS) tube(g, c[0], c[2], wy, wy + CHIMNEY_HEIGHT, 3.4, 2.4, RED, 14, 8);
  for (let i = 0; i < 4; i++) {
    const tx = WORKS.x - 40 + i * 22;
    const tz = WORKS.z + 55;
    tube(g, tx, tz, wy, wy + 16, 9, 9, [0.62, 0.63, 0.6], 18);
    tube(g, tx, tz, wy + 16, wy + 18.5, 9, 3, [0.58, 0.59, 0.56], 18);
  }
  g.box([WORKS.x - 45, wy + 12, WORKS.z + 25], [WORKS.x + 25, wy + 13.5, WORKS.z + 46], STEEL, 0.4);
  // the power station: cooling towers, turbine hall, boiler house and the stack
  const py = heightAt(POWER.x, POWER.z) - 1;
  for (const c of COOLING) coolingTower(g, c[0], c[2], py);
  g.box([POWER.x - 40, py, POWER.z + 60], [POWER.x + 140, py + 32, POWER.z + 120], [0.42, 0.4, 0.37], 0.25);
  g.box([POWER.x + 60, py, POWER.z + 30], [POWER.x + 130, py + 62, POWER.z + 80], [0.38, 0.37, 0.35], 0.25);
  for (let x = POWER.x - 30; x < POWER.x + 140; x += 12) g.face([[x, py + 18, POWER.z + 59.9], [x + 6, py + 18, POWER.z + 59.9], [x + 6, py + 28, POWER.z + 59.9], [x, py + 28, POWER.z + 59.9]].reverse() as Vec3[], [0.8, 0.7, 0.5], 0.3, r() < 0.6 ? 0.25 : 0);
  tube(g, STACK[0], STACK[2], py, py + STACK_HEIGHT, 9, 5.5, RED, 18, 9);
  // switchyard gantries
  for (let i = 0; i < 6; i++) {
    const x = POWER.x - 120 + i * 18;
    for (const z of [POWER.z + 140, POWER.z + 170]) g.box([x - 0.3, py, z - 0.3], [x + 0.3, py + 22, z + 0.3], STEEL, 0.4);
    g.box([x - 0.3, py + 21, POWER.z + 140], [x + 0.3, py + 22, POWER.z + 170], STEEL, 0.4);
  }
  return g;
}

/** Obstruction lights on the chimneys, stack and cooling towers (POINTS_VS records). */
export function buildIndustryLights(): number[] {
  const out: number[] = [];
  const red: [number, number, number] = [1, 0.12, 0.08];
  const wy = heightAt(WORKS.x, WORKS.z) - 0.4;
  const py = heightAt(POWER.x, POWER.z) - 1;
  CHIMNEYS.forEach((c, i) => out.push(c[0], wy + CHIMNEY_HEIGHT + 1, c[2], ...red, 2.2, 4 + i * 0.37));
  out.push(STACK[0], py + STACK_HEIGHT + 2, STACK[2], ...red, 4, 4.5);
  out.push(STACK[0], py + STACK_HEIGHT * 0.5, STACK[2] - 9.5, ...red, 3, 4.25);
  COOLING.forEach((c, i) => out.push(c[0], py + COOLING_HEIGHT + 2, c[2] - 32, ...red, 3.5, 4.1 + i * 0.3));
  return out;
}

/** Where steam and smoke leave: chimney tops and cooling-tower lips, with a source size. */
export function plumeSources(): { pos: Vec3; size: number; rate: number; steam: boolean }[] {
  const wy = heightAt(WORKS.x, WORKS.z) - 0.4;
  const py = heightAt(POWER.x, POWER.z) - 1;
  return [
    ...CHIMNEYS.map((c) => ({ pos: [c[0], wy + CHIMNEY_HEIGHT + 2, c[2]] as Vec3, size: 6, rate: 3, steam: false })),
    ...COOLING.map((c) => ({ pos: [c[0], py + COOLING_HEIGHT + 4, c[2]] as Vec3, size: 48, rate: 1.4, steam: true })),
  ];
}
