// The working landscape around the airport: a wind farm on the southern
// ridge, a 400 kV line marching across the fields on lattice pylons, farmsteads
// with barns and grain silos, a solar farm, a village water tower and guyed
// radio masts. On the airfield itself, the equipment pilots and controllers
// rely on: the ILS localizer array and glide-slope mast, windsocks, frangible
// approach-light stanchions and lit taxiway signs. Everything sits on the
// terrain's real height and stays clear of water, the city and the runway.

import { Geo } from '../gl.ts';
import { basisMatrix, rng, smoothstep, v3, type Vec3 } from '../math.ts';
import { RUNWAY, TAXIWAY_Z } from '../path.ts';
import { AIRFIELD, CITY, heightAt } from './terrain.ts';
import { shorelineDistance } from './hydrology.ts';

const WHITE: Vec3 = [0.82, 0.83, 0.84];
const STEEL: Vec3 = [0.42, 0.44, 0.45];
const GALV: Vec3 = [0.55, 0.57, 0.58];
const ORANGE: Vec3 = [0.85, 0.3, 0.06];

function inAirfield(x: number, z: number, pad: number) {
  return x > AIRFIELD.x0 - pad && x < AIRFIELD.x1 + pad && z > AIRFIELD.z0 - pad && z < AIRFIELD.z1 + pad;
}

function clearSite(x: number, z: number, pad: number): boolean {
  if (inAirfield(x, z, pad)) return false;
  if (shorelineDistance(x, z) < pad * 0.5 + 40) return false;
  if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r * 1.25) return false;
  // keep the approach corridor clear of anything tall
  if (x < 600 && x > -12000 && Math.abs(z - Math.min(0, (x + 3000) * 0.42)) < 900) return false;
  return true;
}

/** A square-section member between two points: struts, poles, lattice. */
function rod(g: Geo, a: Vec3, b: Vec3, half: number, color: Vec3, gloss = 0.3) {
  const d = v3.norm(v3.sub(b, a));
  const ref: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = v3.scale(v3.norm(v3.cross(d, ref)), half);
  const w = v3.scale(v3.norm(v3.cross(d, u)), half);
  const c = (p: Vec3, su: number, sw: number): Vec3 => v3.add(p, v3.add(v3.scale(u, su), v3.scale(w, sw)));
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const [s0, t0] = corners[i];
    const [s1, t1] = corners[(i + 1) % 4];
    g.face([c(a, s0, t0), c(a, s1, t1), c(b, s1, t1), c(b, s0, t0)], color, gloss);
  }
}

/** Tapered round prism between two heights, centred on (x, z). */
function drum(g: Geo, x: number, z: number, y0: number, y1: number, r0: number, r1: number, color: Vec3, sides = 12, gloss = 0.35, emissive = 0) {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    g.face([
      [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0],
      [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1],
      [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1],
      [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0],
    ], color, gloss, emissive);
  }
}

/** A gabled building in local space (x along the ridge), merged in place. */
function gabled(g: Geo, pos: Vec3, heading: number, len: number, wid: number, wall: number, rise: number, walls: Vec3, roof: Vec3) {
  const b = new Geo();
  const hx = len / 2;
  const hz = wid / 2;
  b.box([-hx, 0, -hz], [hx, wall, hz], walls, 0.15);
  const eave = 0.6;
  const L: Vec3 = [-hx - eave, wall, -hz - eave];
  const R: Vec3 = [-hx - eave, wall, hz + eave];
  const top0: Vec3 = [-hx - eave, wall + rise, 0];
  const top1: Vec3 = [hx + eave, wall + rise, 0];
  b.face([L, top0, top1, [hx + eave, wall, -hz - eave]], roof, 0.25);
  b.face([R, [hx + eave, wall, hz + eave], top1, top0], roof, 0.25);
  b.face([[-hx, wall, -hz], [-hx, wall, hz], [-hx, wall + rise, 0]], walls, 0.15);
  b.face([[hx, wall, hz], [hx, wall, -hz], [hx, wall + rise, 0]], walls, 0.15);
  g.merge(b, basisMatrix(pos, [Math.cos(heading), 0, Math.sin(heading)], [0, 1, 0]));
}

// ------------------------------------------------------------------ wind farm

export interface Turbine {
  hub: Vec3;
  yaw: number; // rotor axis heading, radians from +x
  phase: number;
  speed: number; // rad/s
}

const HUB_HEIGHT = 96;
const BLADE = 58;

export function turbines(): Turbine[] {
  const out: Turbine[] = [];
  const r = rng(907);
  // ridge sites: the highest clear ground in a band of hills south of the airport
  const cand: { x: number; z: number; h: number }[] = [];
  for (let x = -7000; x <= 9000; x += 160) {
    for (let z = 3600; z <= 9500; z += 160) {
      if (!clearSite(x, z, 300)) continue;
      cand.push({ x, z, h: heightAt(x, z) });
    }
  }
  cand.sort((a, b) => b.h - a.h);
  for (const c of cand) {
    if (out.length >= 18) break;
    if (out.some((t) => Math.hypot(t.hub[0] - c.x, t.hub[2] - c.z) < 520)) continue;
    out.push({ hub: [c.x, c.h + HUB_HEIGHT, c.z], yaw: Math.PI + (r() - 0.5) * 0.25, phase: r() * 6.28, speed: 1.1 + r() * 0.35 });
  }
  return out;
}

/** Hub and three blades around the origin; the rotor axis is +x. */
export function buildRotor(): Geo {
  const g = new Geo();
  // spinner
  const sides = 10;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const ring = (x: number, rr: number, a: number): Vec3 => [x, Math.cos(a) * rr, Math.sin(a) * rr];
    g.face([ring(-1.5, 1.7, a0), ring(1.6, 1.4, a0), ring(1.6, 1.4, a1), ring(-1.5, 1.7, a1)], WHITE, 0.5);
    g.face([ring(1.6, 1.4, a0), ring(3.4, 0.05, a0), ring(3.4, 0.05, a1), ring(1.6, 1.4, a1)], WHITE, 0.5);
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const dir: Vec3 = [0, Math.cos(a), Math.sin(a)];
    const side: Vec3 = [0, -Math.sin(a), Math.cos(a)];
    // a twisted, tapering blade: wide near the root, slender at the tip
    const stations = [1.6, 6, 14, 26, 40, BLADE];
    const chords = [1.9, 3.9, 3.3, 2.5, 1.6, 0.5];
    const twists = [0.5, 0.42, 0.3, 0.18, 0.08, 0.02];
    for (let i = 0; i < stations.length - 1; i++) {
      const p = (j: number, s: number): Vec3 => {
        const c = chords[j] * 0.5;
        const t = twists[j];
        const along = v3.scale(dir, stations[j]);
        return v3.add(along, v3.add(v3.scale(side, s * c * Math.cos(t)), [s * c * Math.sin(t) - 0.2, 0, 0]));
      };
      g.face([p(i, -1), p(i + 1, -1), p(i + 1, 1), p(i, 1)], WHITE, 0.55);
      // a thin trailing face gives the blade thickness at the root
      if (i < 2) g.face([p(i, 1), p(i + 1, 1), v3.add(p(i + 1, 1), [-0.35, 0, 0]), v3.add(p(i, 1), [-0.45, 0, 0])], WHITE, 0.4);
    }
  }
  return g;
}

function turbineTower(g: Geo, t: Turbine) {
  const base = t.hub[1] - HUB_HEIGHT;
  const x = t.hub[0];
  const z = t.hub[2];
  drum(g, x, z, base - 2, base + 0.6, 9, 9, [0.45, 0.45, 0.43], 14, 0.15);
  drum(g, x, z, base, t.hub[1] - 2.2, 2.35, 1.45, WHITE, 16, 0.45);
  // nacelle, aligned with the rotor
  const n = new Geo();
  n.box([-1.2, -2.0, -1.9], [10.5, 2.2, 1.9], WHITE, 0.45);
  n.box([7.5, 2.2, -0.6], [9.5, 2.7, 0.6], STEEL, 0.4);
  g.merge(n, basisMatrix([x, t.hub[1], z], [-Math.cos(t.yaw), 0, -Math.sin(t.yaw)], [0, 1, 0]));
}

// ------------------------------------------------------------------ transmission line

const LINE_ROUTES: [number, number][][] = [
  [[-16000, 3200], [-9000, 2700], [-4200, 2350], [-200, 2050], [4200, 2250], [9000, 2900], [16000, 3600]],
  [[-2400, -9800], [-2600, -7000], [-1500, -5200], [400, -3600], [2600, -2600], [6400, -2200], [12000, -1600]],
];

interface Pylon { pos: Vec3; along: Vec3 }

function pylonsOf(route: [number, number][]): Pylon[] {
  const out: Pylon[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const [x0, z0] = route[i];
    const [x1, z1] = route[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 380));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      if (!clearSite(x, z, 120) && shorelineDistance(x, z) < 60) continue;
      if (inAirfield(x, z, 500)) continue;
      out.push({ pos: [x, heightAt(x, z), z], along: v3.norm([x1 - x0, 0, z1 - z0]) });
    }
  }
  return out;
}

/** Arm tips in pylon-local space (x along the line, z across): where the conductors hang. */
const ARMS: Vec3[] = [[0, 30, -9], [0, 30, 9], [0, 36, -7], [0, 36, 7], [0, 42, -5], [0, 42, 5]];
const EARTH: Vec3 = [0, 47.5, 0];

function pylon(g: Geo, p: Pylon) {
  const b = new Geo();
  const leg = (y: number) => 5.2 * (1 - y / 52) + 0.8;
  const levels = [0, 6, 12, 18, 24, 30, 36, 42, 46];
  const corner = (y: number, sx: number, sz: number): Vec3 => [sx * leg(y), y, sz * leg(y)];
  const signs: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [sx, sz] of signs) rod(b, corner(-1, sx, sz), corner(46, sx, sz), 0.13, GALV);
  for (let i = 0; i < levels.length - 1; i++) {
    const y0 = levels[i];
    const y1 = levels[i + 1];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = signs[k];
      const [bx, bz] = signs[(k + 1) % 4];
      rod(b, corner(y0, ax, az), corner(y1, bx, bz), 0.05, GALV);
      rod(b, corner(y0, bx, bz), corner(y1, ax, az), 0.05, GALV);
      rod(b, corner(y1, ax, az), corner(y1, bx, bz), 0.05, GALV);
    }
  }
  // cross-arms with insulator strings
  for (const y of [30, 36, 42]) {
    const reach = y === 30 ? 9 : y === 36 ? 7 : 5;
    for (const s of [-1, 1]) {
      rod(b, [leg(y), y, 0], [0, y, s * reach], 0.09, GALV);
      rod(b, [-leg(y), y, 0], [0, y, s * reach], 0.09, GALV);
      rod(b, [0, y, s * reach], [0, y - 3.2, s * reach], 0.12, [0.32, 0.38, 0.42], 0.6);
    }
  }
  rod(b, [0, 46, -1.5], [0, EARTH[1], 0], 0.07, GALV);
  rod(b, [0, 46, 1.5], [0, EARTH[1], 0], 0.07, GALV);
  // concrete footings
  for (const [sx, sz] of signs) b.box([sx * 6 - 0.8, -1, sz * 6 - 0.8], [sx * 6 + 0.8, 0.5, sz * 6 + 0.8], [0.45, 0.45, 0.43], 0.1);
  g.merge(b, basisMatrix(p.pos, p.along, [0, 1, 0]));
}

/** Conductors sag between pylons as catenaries; thin ribbons, edge-on to nobody. */
function conductors(g: Geo, a: Pylon, b: Pylon) {
  const ma = basisMatrix(a.pos, a.along, [0, 1, 0]);
  const mb = basisMatrix(b.pos, b.along, [0, 1, 0]);
  const tx = (m: Float32Array, p: Vec3): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  const span = v3.dist(a.pos, b.pos);
  const sag = 0.022 * span;
  const anchors: Vec3[] = [...ARMS.map((q) => [q[0], q[1] - 3.2, q[2]] as Vec3), EARTH];
  for (const q of anchors) {
    const p0 = tx(ma, q);
    const p1 = tx(mb, q);
    const segs = 10;
    let prev = p0;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p: Vec3 = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t), p0[2] + (p1[2] - p0[2]) * t];
      const w = q === EARTH ? 0.035 : 0.055;
      g.face([[prev[0], prev[1] + w, prev[2]], [p[0], p[1] + w, p[2]], [p[0], p[1] - w, p[2]], [prev[0], prev[1] - w, prev[2]]], [0.16, 0.17, 0.18], 0.55);
      prev = p;
    }
  }
}

// ------------------------------------------------------------------ farms, solar, towers

function farmstead(g: Geo, x: number, z: number, r: () => number) {
  const heading = (Math.floor(r() * 4) * Math.PI) / 2 + (r() - 0.5) * 0.3;
  const f: Vec3 = [Math.cos(heading), 0, Math.sin(heading)];
  const s: Vec3 = [-f[2], 0, f[0]];
  const at = (a: number, b: number): Vec3 => {
    const px = x + f[0] * a + s[0] * b;
    const pz = z + f[2] * a + s[2] * b;
    return [px, heightAt(px, pz) - 0.3, pz];
  };
  const house = [[0.78, 0.74, 0.66], [0.62, 0.5, 0.42], [0.85, 0.83, 0.78]][Math.floor(r() * 3)] as Vec3;
  const tile = [[0.36, 0.13, 0.08], [0.18, 0.19, 0.21], [0.42, 0.2, 0.1]][Math.floor(r() * 3)] as Vec3;
  gabled(g, at(0, 0), heading, 13, 9, 5.6, 3.6, house, tile);
  const barnWall = r() > 0.5 ? [0.46, 0.1, 0.07] as Vec3 : [0.3, 0.32, 0.31] as Vec3;
  gabled(g, at(28, 6), heading, 32, 17, 7, 5.5, barnWall, [0.32, 0.33, 0.34]);
  gabled(g, at(26, -20), heading + Math.PI / 2, 20, 11, 4.2, 2.2, [0.38, 0.39, 0.4], [0.28, 0.29, 0.3]);
  // grain silos: corrugated galvanised steel with conical caps
  const silos = 1 + Math.floor(r() * 3);
  for (let i = 0; i < silos; i++) {
    const p = at(50, -6 + i * 8.5);
    drum(g, p[0], p[2], p[1], p[1] + 15, 3.6, 3.6, GALV, 14, 0.55);
    drum(g, p[0], p[2], p[1] + 15, p[1] + 18.5, 3.7, 0.4, [0.62, 0.64, 0.65], 14, 0.55);
  }
  // a garden of fruit trees is left to the vegetation pass; a hay bale stack here
  const bales = at(10, 18);
  for (let i = 0; i < 6; i++) drum(g, bales[0] + (i % 3) * 1.9, bales[2] + Math.floor(i / 3) * 1.9, bales[1] + 0.3, bales[1] + 1.8, 0.85, 0.85, [0.5, 0.42, 0.22], 8, 0.05);
}

function solarFarm(g: Geo) {
  const x0 = 4500;
  const x1 = 5250;
  const z0 = 1250;
  const rows = 34;
  for (let i = 0; i < rows; i++) {
    const z = z0 + i * 8.5;
    for (let x = x0; x < x1; x += 50) {
      const y = heightAt(x + 25, z) + 0.9;
      const tilt = 0.45;
      const depth = 4.2;
      const lo: Vec3 = [x, y, z + depth * Math.cos(tilt) * 0.5];
      const hi: Vec3 = [x, y + depth * Math.sin(tilt), z - depth * Math.cos(tilt) * 0.5];
      g.face([lo, [x + 48, lo[1], lo[2]], [x + 48, hi[1], hi[2]], hi], [0.035, 0.05, 0.09], 0.95);
      g.face([hi, [x + 48, hi[1], hi[2]], [x + 48, lo[1], lo[2]], lo], [0.25, 0.26, 0.27], 0.3);
      for (const px of [x + 4, x + 24, x + 44]) rod(g, [px, y - 1, z], [px, y + 0.9, z], 0.06, GALV);
    }
  }
  // inverter cabins and the fence line
  for (let i = 0; i < 4; i++) g.box([x0 - 20, heightAt(x0 - 15, z0 + 60 + i * 70), z0 + 60 + i * 70], [x0 - 12, heightAt(x0 - 15, z0 + 60 + i * 70) + 2.6, z0 + 66 + i * 70], [0.7, 0.71, 0.7], 0.25);
}

function waterTower(g: Geo, x: number, z: number) {
  const y = heightAt(x, z);
  drum(g, x, z, y - 1, y + 30, 2.6, 2.2, [0.68, 0.68, 0.66], 16, 0.25);
  drum(g, x, z, y + 30, y + 35, 2.2, 9.5, [0.82, 0.83, 0.82], 20, 0.45);
  drum(g, x, z, y + 35, y + 41, 9.5, 9.5, [0.84, 0.85, 0.84], 20, 0.45);
  drum(g, x, z, y + 41, y + 43, 9.5, 0.6, [0.6, 0.62, 0.62], 20, 0.4);
}

function radioMast(g: Geo, x: number, z: number, height: number) {
  const y = heightAt(x, z);
  // a slender triangular lattice painted in aviation red and white bands
  const band = height / 7;
  for (let i = 0; i < 7; i++) drum(g, x, z, y + i * band, y + (i + 1) * band, 1.15, 1.15, i % 2 ? [0.82, 0.82, 0.8] : [0.62, 0.08, 0.05], 3, 0.3);
  // guy wires to three anchors at two heights
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const ax = x + Math.cos(a) * height * 0.55;
    const az = z + Math.sin(a) * height * 0.55;
    const ay = heightAt(ax, az);
    for (const f of [0.45, 0.85]) rod(g, [ax, ay, az], [x, y + height * f, z], 0.03, [0.3, 0.3, 0.3], 0.5);
    g.box([ax - 1.5, ay - 0.5, az - 1.5], [ax + 1.5, ay + 0.6, az + 1.5], [0.45, 0.45, 0.43], 0.1);
  }
}

// ------------------------------------------------------------------ airfield equipment

function airfieldEquipment(g: Geo) {
  const y0 = RUNWAY.y;
  // ILS localizer: a row of log-periodic antennas on a steel frame past the far end
  const lx = RUNWAY.x1 + 300;
  rod(g, [lx, y0 + 2.2, -30], [lx, y0 + 2.2, 30], 0.12, STEEL);
  for (let zz = -29; zz <= 29; zz += 3.6) {
    rod(g, [lx, y0, zz], [lx, y0 + 2.2, zz], 0.06, STEEL);
    rod(g, [lx, y0 + 2.2, zz], [lx, y0 + 4.4, zz], 0.04, GALV);
    for (let k = 0; k < 4; k++) rod(g, [lx - 0.9 + k * 0.6, y0 + 2.5 + k * 0.45, zz - 0.8 + k * 0.15], [lx - 0.9 + k * 0.6, y0 + 2.5 + k * 0.45, zz + 0.8 - k * 0.15], 0.025, GALV);
  }
  g.box([lx + 40, y0, -6], [lx + 46, y0 + 2.8, 2], [0.78, 0.78, 0.75], 0.2);
  // glide-slope mast beside the touchdown zone, with its equipment shelter
  const gx = 310;
  const gz = -140;
  rod(g, [gx, y0, gz], [gx, y0 + 16, gz], 0.16, [0.75, 0.32, 0.08]);
  for (const h of [5, 10, 15]) rod(g, [gx, y0 + h, gz - 0.2], [gx, y0 + h, gz - 1.6], 0.14, GALV);
  g.box([gx + 5, y0, gz - 3], [gx + 10, y0 + 2.8, gz + 3], [0.78, 0.78, 0.75], 0.2);
  // windsock masts near both thresholds; the socks themselves fly in the
  // wind and are built each frame by windsocks()
  for (const [wx, wz] of WINDSOCKS) {
    rod(g, [wx, y0, wz], [wx, y0 + 7, wz], 0.07, [0.85, 0.85, 0.85]);
    rod(g, [wx - 0.05, y0 + 6.6, wz], [wx + 0.25, y0 + 6.6, wz], 0.05, GALV);
  }
  // approach-light stanchions: frangible orange-and-white masts under each bar
  for (let d = 30; d <= 900; d += 30) {
    const x = RUNWAY.x0 - d;
    const ground = Math.min(0, heightAt(x, 0));
    rod(g, [x, ground, 0], [x, 0.82, 0], 0.07, d % 60 ? ORANGE : [0.88, 0.88, 0.86]);
    rod(g, [x, 0.82, -2.4], [x, 0.82, 2.4], 0.05, GALV);
    if (d === 300) rod(g, [x, 0.82, -15.5], [x, 0.82, 15.5], 0.05, GALV);
    if (d <= 270) for (const s of [-1, 1]) {
      rod(g, [x, ground, s * 9.5], [x, 0.82, s * 9.5], 0.06, ORANGE);
      rod(g, [x, 0.82, s * 7.6], [x, 0.82, s * 11.4], 0.04, GALV);
    }
  }
  // lit signs: yellow location and direction boards at the taxiway junctions,
  // red mandatory holding signs at the runway entries
  const sign = (x: number, z: number, face: Vec3, w = 2.6) => {
    g.box([x - w / 2, y0 + 0.25, z - 0.18], [x + w / 2, y0 + 1.25, z + 0.18], [0.08, 0.08, 0.08], 0.2);
    g.face([[x - w / 2 + 0.08, y0 + 0.33, z - 0.19], [x + w / 2 - 0.08, y0 + 0.33, z - 0.19], [x + w / 2 - 0.08, y0 + 1.17, z - 0.19], [x - w / 2 + 0.08, y0 + 1.17, z - 0.19]].reverse() as Vec3[], face, 0.3, 0.9);
    g.face([[x - w / 2 + 0.08, y0 + 0.33, z + 0.19], [x + w / 2 - 0.08, y0 + 0.33, z + 0.19], [x + w / 2 - 0.08, y0 + 1.17, z + 0.19], [x - w / 2 + 0.08, y0 + 1.17, z + 0.19]], face, 0.3, 0.9);
  };
  for (const x of [-120, 820, 1650, 3000, RUNWAY.x1 + 120]) {
    sign(x - 22, TAXIWAY_Z - 18, [1.0, 0.72, 0.08]);
    sign(x + 22, TAXIWAY_Z + 18, [1.0, 0.72, 0.08], 3.4);
    sign(x - 18, 62, [0.9, 0.08, 0.06]);
  }
  // distance-remaining boards along the north edge, every 300 m
  for (let x = 300; x < RUNWAY.x1; x += 300) {
    g.box([x - 0.7, y0 + 0.2, -38.2], [x + 0.7, y0 + 1.5, -37.9], [0.03, 0.03, 0.03], 0.2);
    g.face([[x - 0.55, y0 + 0.4, -38.25], [x + 0.55, y0 + 0.4, -38.25], [x + 0.55, y0 + 1.35, -38.25], [x - 0.55, y0 + 1.35, -38.25]].reverse() as Vec3[], [0.9, 0.9, 0.88], 0.2, 0.7);
  }
  // blast fences behind both runway ends
  for (const x of [RUNWAY.x0 - 1050, RUNWAY.x1 + 220]) {
    for (let z = -60; z < 60; z += 3) g.face([[x, y0, z], [x, y0, z + 3], [x - 1.2, y0 + 4.5, z + 3], [x - 1.2, y0 + 4.5, z]], [0.5, 0.52, 0.5], 0.35);
  }
}

// ------------------------------------------------------------------ public

/** Where the windsocks stand, beside the touchdown zones. */
export const WINDSOCKS: [number, number][] = [[380, -105], [RUNWAY.x1 - 400, -105]];

/**
 * The windsocks at a moment: striped cones streaming east in a gusty westerly,
 * filling and lifting in the gusts, sagging and snaking in the lulls.
 */
export function windsocks(time: number): Geo {
  const g = new Geo();
  const y0 = 0.12;
  WINDSOCKS.forEach(([wx, wz], n) => {
    const t = time + n * 3.7;
    const wind = 0.62 + 0.25 * Math.sin(t * 0.63) + 0.13 * Math.sin(t * 2.1 + 1.3);
    const yaw = 0.12 * Math.sin(t * 0.37 + n) + 0.05 * Math.sin(t * 1.7);
    const segs = 6;
    const ring = (a: number, k: number): Vec3 => {
      const th = (k / 12) * Math.PI * 2;
      const r = 0.45 * (1 - a * 0.55) * (0.75 + 0.25 * wind);
      const droop = a * a * (1.5 - wind * 1.3);
      const snake = Math.sin(t * 6.3 - a * 7) * a * 0.18 * (1.1 - wind);
      const x = a * 3.6 * (0.85 + 0.15 * wind);
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const lx = x;
      const lz = snake + Math.sin(th) * r;
      return [wx + 0.25 + lx * c - lz * sn, y0 + 6.6 - droop + Math.cos(th) * r, wz + lx * sn + lz * c];
    };
    for (let i = 0; i < segs; i++) {
      const a = i / segs;
      const b = (i + 1) / segs;
      for (let k = 0; k < 12; k++) {
        g.face([ring(a, k), ring(b, k), ring(b, k + 1), ring(a, k + 1)], i % 2 ? [0.9, 0.9, 0.88] : ORANGE, 0.2, 0.08);
      }
    }
  });
  return g;
}

export function buildCountryside(): Geo {
  const g = new Geo();
  for (const t of turbines()) turbineTower(g, t);
  for (const route of LINE_ROUTES) {
    const ps = pylonsOf(route);
    ps.forEach((p, i) => {
      pylon(g, p);
      const next = ps[i + 1];
      if (next && v3.dist(p.pos, next.pos) < 560) conductors(g, p, next);
    });
  }
  const r = rng(3301);
  let farms = 0;
  for (let tries = 0; tries < 800 && farms < 34; tries++) {
    const ang = r() * Math.PI * 2;
    const dist = 2600 + r() * 9500;
    const x = 600 + Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (!clearSite(x, z, 250)) continue;
    const slope = Math.abs(heightAt(x + 40, z) - heightAt(x - 40, z)) + Math.abs(heightAt(x, z + 40) - heightAt(x, z - 40));
    if (slope > 14 || heightAt(x, z) > 380) continue;
    farmstead(g, x, z, r);
    farms++;
  }
  solarFarm(g);
  waterTower(g, -2300, 2700);
  waterTower(g, 6200, -3300);
  radioMast(g, 7200, 5600, 210);
  radioMast(g, -8200, 6100, 170);
  airfieldEquipment(g);
  return g;
}

/** Aviation obstruction lights and lit sign glows. 8 floats each (see POINTS_VS). */
export function buildCountrysideLights(): number[] {
  const out: number[] = [];
  const red: Vec3 = [1.0, 0.1, 0.06];
  const P = (p: Vec3, c: Vec3, size: number, kind: number) => out.push(p[0], p[1], p[2], c[0], c[1], c[2], size, kind);
  turbines().forEach((t, i) => P(v3.add(t.hub, [0, 2.8, 0]), red, 3.6, 4 + ((i * 0.37) % 0.99) * smoothstep(0, 1, 1)));
  for (const [x, z, h] of [[7200, 5600, 210], [-8200, 6100, 170]] as const) {
    const y = heightAt(x, z);
    for (const f of [1, 0.66, 0.33]) P([x, y + h * f + 1, z], red, f === 1 ? 4.2 : 3, 4.3);
  }
  return out;
}
