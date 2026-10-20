// Airport architecture uses metre-scale structural bays, curved roof shells,
// glazing, loading docks and operational equipment instead of enlarged boxes.
// The existing footprints keep the terminal roads and aircraft stands aligned.

import { Geo } from '../gl.ts';
import { v3, type Vec3 } from '../math.ts';

type Footprint = { x0: number; x1: number; z0: number; z1: number };
type Tower = { x: number; z: number; cab: number };
const CONCRETE: Vec3 = [0.37, 0.39, 0.39];
const METAL: Vec3 = [0.4, 0.44, 0.46];
const ROOF: Vec3 = [0.48, 0.51, 0.5];
const DARK: Vec3 = [0.065, 0.085, 0.095];
const GLASS: Vec3 = [0.07, 0.14, 0.18];
const WARM: Vec3 = [0.77, 0.66, 0.46];
/** Added to a face's gloss, marks architectural glazing: LIT_FS shows a lit interior behind it (emissive = storey height). */
export const GLAZING = 1;

/** Rectangular strut between arbitrary endpoints, with a real cross section. */
function beam(g: Geo, a: Vec3, b: Vec3, half: number, color = METAL) {
  const d = v3.norm(v3.sub(b, a));
  const u = v3.scale(v3.norm(v3.cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), half);
  const v = v3.scale(v3.cross(d, v3.norm(u)), half);
  const corners = (p: Vec3) => [v3.add(p, v3.add(u, v)), v3.add(p, v3.sub(v, u)), v3.sub(p, v3.add(u, v)), v3.add(p, v3.sub(u, v))];
  const ca = corners(a), cb = corners(b);
  for (let i = 0; i < 4; i++) g.face([ca[i], ca[(i + 1) % 4], cb[(i + 1) % 4], cb[i]], color, 0.4);
}

function drum(g: Geo, x: number, z: number, y0: number, y1: number, r0: number, r1: number, color: Vec3, gloss = 0.3, emissive = 0, sides = 12) {
  const top = g.vertex([x, y1, z], [0, 1, 0], color, gloss, emissive);
  const ring: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = i * Math.PI * 2 / sides, b = (i + 1) * Math.PI * 2 / sides;
    g.face([[x + Math.cos(a) * r0, y0, z + Math.sin(a) * r0], [x + Math.cos(b) * r0, y0, z + Math.sin(b) * r0], [x + Math.cos(b) * r1, y1, z + Math.sin(b) * r1], [x + Math.cos(a) * r1, y1, z + Math.sin(a) * r1]], color, gloss, emissive);
    ring.push(g.vertex([x + Math.cos(a) * r1, y1, z + Math.sin(a) * r1], [0, 1, 0], color, gloss, emissive));
  }
  for (let i = 0; i < sides; i++) g.tri(top, ring[(i + 1) % sides], ring[i]);
}

/** A roof shell curves across z; structural ribs repeat along x. */
function vaultedRoof(g: Geo, f: Footprint, eave: number, rise: number, glassMiddle = false) {
  const segs = 10;
  const profile = (i: number) => {
    const t = i / segs;
    return [f.z0 + (f.z1 - f.z0) * t, eave + Math.sin(t * Math.PI) * rise] as const;
  };
  for (let i = 0; i < segs; i++) {
    const [za, ya] = profile(i), [zb, yb] = profile(i + 1);
    const skylight = glassMiddle && (i === 4 || i === 5);
    g.face([[f.x0, ya, za], [f.x0, yb, zb], [f.x1, yb, zb], [f.x1, ya, za]], skylight ? GLASS : ROOF, skylight ? 0.85 : 0.23, skylight ? 0.02 : 0);
  }
  for (const x of [f.x0, f.x1]) for (let i = 0; i < segs; i++) {
    const [za, ya] = profile(i), [zb, yb] = profile(i + 1);
    beam(g, [x, ya + 0.07, za], [x, yb + 0.07, zb], 0.16, METAL);
  }
  // Thin end gables close the roof's volume without flattening its silhouette.
  for (const x of [f.x0, f.x1]) for (let i = 0; i < segs; i++) {
    const [za, ya] = profile(i), [zb, yb] = profile(i + 1);
    g.face([[x, eave, (f.z0 + f.z1) / 2], [x, ya, za], [x, yb, zb]], GLASS, 0.7);
  }
}

/** Front-facing arches expose each bay's profile from the apron cameras. */
function frontageRoof(g: Geo, f: Footprint, eave: number, rise: number, skylights = false) {
  const segs = 12;
  const profile = (i: number) => [f.x0 + (f.x1 - f.x0) * i / segs, eave + Math.sin(i / segs * Math.PI) * rise] as const;
  for (let i = 0; i < segs; i++) {
    const [xa, ya] = profile(i), [xb, yb] = profile(i + 1);
    const glass = skylights && i >= 5 && i <= 6;
    g.face([[xa, ya, f.z0], [xa, ya, f.z1], [xb, yb, f.z1], [xb, yb, f.z0]], glass ? GLASS : ROOF, glass ? 0.85 : 0.25, glass ? 0.015 : 0);
    for (const z of [f.z0, f.z1]) {
      beam(g, [xa, ya + 0.06, z], [xb, yb + 0.06, z], 0.17, METAL);
      g.face([[(f.x0 + f.x1) / 2, eave, z], [xa, ya, z], [xb, yb, z]], GLASS, 0.84, 0.025);
    }
  }
  // Roof purlins and the ridge give the large atrium a structural rhythm.
  for (const i of [3, 6, 9]) {
    const [x, y] = profile(i);
    beam(g, [x, y + 0.06, f.z0], [x, y + 0.06, f.z1], 0.1, METAL);
  }
}

function facade(g: Geo, x0: number, x1: number, z: number, low: number, high: number, bay = 8.4) {
  for (let x = x0; x < x1 - 0.2; x += bay) {
    const end = Math.min(x + bay - 0.18, x1);
    g.face([[x + 0.18, low, z], [end, low, z], [end, high, z], [x + 0.18, high, z]], GLASS, GLAZING + 0.87, 4.9);
    g.box([x, low - 0.2, z - 0.13], [x + 0.18, high + 0.2, z + 0.13], METAL, 0.38);
    if (Math.floor((x - x0) / bay) % 3 === 0) g.face([[x + 1, high - 1.2, z - 0.015], [Math.min(x + 5, end), high - 1.2, z - 0.015], [Math.min(x + 5, end), high - 1.04, z - 0.015], [x + 1, high - 1.04, z - 0.015]], WARM, 0.2, 0.35);
  }
  g.box([x0, low - 0.15, z - 0.14], [x1, low, z + 0.14], METAL, 0.4);
  g.box([x0, high, z - 0.14], [x1, high + 0.15, z + 0.14], METAL, 0.4);
}

export function buildTerminalArchitecture(t: Footprint): Geo {
  const g = new Geo();
  const mid = (t.x0 + t.x1) / 2;
  // A low continuous gate concourse serves all existing stand connections.
  g.box([t.x0, 0, t.z0], [t.x1, 3.9, t.z1], [0.24, 0.27, 0.27], 0.2);
  g.box([t.x0, 3.9, t.z0], [t.x1, 4.2, t.z1], CONCRETE, 0.2);
  facade(g, t.x0, t.x1, t.z0 - 0.01, 4.4, 14.2);
  facade(g, t.x0, t.x1, t.z1 + 0.01, 4.4, 14.2);
  g.box([t.x0, 8.8, t.z0 - 0.18], [t.x1, 9.02, t.z0 + 0.16], METAL, 0.4);
  // A small valley separates each stand-sized arch; its silhouette is visible
  // across x from the runway rather than merging into one longitudinal barrel.
  for (let x = t.x0; x < t.x1; x += 78) {
    const x1 = Math.min(t.x1, x + 78);
    frontageRoof(g, { x0: x + 1.2, x1: x1 - 1.2, z0: t.z0 - 3, z1: t.z1 + 2 }, 14.7, 7.6, true);
    g.box([x, 14.4, t.z0 - 3], [x + 1.2, 14.7, t.z1 + 2], METAL, 0.25);
    for (const z of [t.z0 + 12, t.z1 - 12]) g.box([x + 19, 0, z], [x + 19.7, 14.7, z + 0.7], CONCRETE, 0.2);
  }
  // A raised headhouse gives the long concourse a recognizable main entrance.
  const head = { x0: mid - 160, x1: mid + 160, z0: t.z0 + 13, z1: t.z1 };
  g.box([head.x0, 4.2, head.z0], [head.x1, 22.5, head.z1], [0.18, 0.22, 0.24], 0.3);
  facade(g, mid - 110, mid + 110, head.z0 - 10.03, 16.2, 24, 10);
  facade(g, head.x0, head.x1, head.z1 + 0.05, 4.4, 24, 10);
  frontageRoof(g, { x0: mid - 110, x1: mid + 110, z0: head.z0 - 10, z1: head.z1 + 2 }, 24.3, 13.3, true);
  for (const [x0, x1] of [[head.x0, mid - 111], [mid + 111, head.x1]]) frontageRoof(g, { x0, x1, z0: head.z0 - 2, z1: head.z1 + 2 }, 22.8, 3.2);
  for (let x = mid - 105; x < mid + 110; x += 35) g.box([x, 4.2, head.z0 - 10.3], [x + 0.42, 24.3, head.z0 - 9.88], METAL, 0.4);
  // Glazed entrance canopy shelters the benches and carts already on the footway.
  g.box([mid - 164, 5.2, t.z1 + 0.1], [mid + 164, 5.6, t.z1 + 18], METAL, 0.35);
  for (let x = mid - 154; x < mid + 160; x += 24) {
    g.box([x, 0, t.z1 + 16], [x + 0.28, 5.2, t.z1 + 16.28], METAL, 0.4);
    g.face([[x, 5.63, t.z1 + 1], [x, 5.63, t.z1 + 15.5], [Math.min(x + 21, mid + 164), 5.63, t.z1 + 15.5], [Math.min(x + 21, mid + 164), 5.63, t.z1 + 1]], GLASS, 0.87);
  }
  for (const x of [mid - 90, mid - 10, mid + 70]) g.box([x, 0.1, t.z1 + 0.1], [x + 20, 3.9, t.z1 + 0.32], [0.025, 0.055, 0.065], 0.85);
  // Roof equipment and louvres sit on lower service annexes between gate bays.
  for (const x of [t.x0 + 85, t.x0 + 245, t.x1 - 250, t.x1 - 90]) {
    g.box([x, 14.7, t.z1 - 15], [x + 9, 17.4, t.z1 - 8], [0.24, 0.27, 0.28], 0.35);
    for (let z = t.z1 - 14.5; z < t.z1 - 8; z += 1.2) g.box([x - 0.04, 15.2, z], [x + 9.04, 15.38, z + 0.18], DARK, 0.25);
  }
  return g;
}

export function buildTowerArchitecture(t: Tower): Geo {
  const g = new Geo();
  g.box([t.x - 23, 0, t.z + 11], [t.x + 29, 8.2, t.z + 42], CONCRETE, 0.2);
  g.box([t.x - 25, 8.2, t.z + 9], [t.x + 31, 8.8, t.z + 44], METAL, 0.3);
  facade(g, t.x - 21, t.x + 25, t.z + 10.98, 2, 6.8, 5.8);
  drum(g, t.x, t.z, 0, t.cab - 6, 6.3, 4.6, [0.44, 0.46, 0.46], 0.2);
  for (const side of [-1, 1]) beam(g, [t.x + side * 7.7, 0, t.z + 2], [t.x + side * 4.8, t.cab - 6, t.z + 2], 0.28, [0.32, 0.36, 0.37]);
  drum(g, t.x, t.z, t.cab - 6, t.cab - 2, 4.6, 11.1, METAL, 0.35);
  // the cab's sloped glazing: consoles and screens glow behind its lower band
  drum(g, t.x, t.z, t.cab - 2, t.cab + 1.4, 11.1, 11.56, [0.42, 0.36, 0.26], 0.85, 0.32);
  drum(g, t.x, t.z, t.cab + 1.4, t.cab + 6, 11.56, 12.2, GLASS, 0.9, 0.06);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    beam(g, [t.x + Math.cos(a) * 11.12, t.cab - 2, t.z + Math.sin(a) * 11.12], [t.x + Math.cos(a) * 12.22, t.cab + 6, t.z + Math.sin(a) * 12.22], 0.09, [0.24, 0.29, 0.3]);
  }
  drum(g, t.x, t.z, t.cab + 6, t.cab + 7.5, 13, 12.7, METAL, 0.35);
  drum(g, t.x, t.z, t.cab + 7.5, t.cab + 8.2, 7.6, 7.6, DARK, 0.25);
  drum(g, t.x, t.z, t.cab + 8.2, t.cab + 22, 0.3, 0.15, METAL, 0.4, 0, 6);
  // Redundant antennas, a lightning mast and a roof beacon keep the cab operational.
  for (const x of [-5.5, 5.5]) {
    beam(g, [t.x + x, t.cab + 7.5, t.z + 3], [t.x + x, t.cab + 13, t.z + 3], 0.065);
    beam(g, [t.x + x - 1.1, t.cab + 11, t.z + 3], [t.x + x + 1.1, t.cab + 11, t.z + 3], 0.045);
  }
  drum(g, t.x, t.z, t.cab + 7.5, t.cab + 7.9, 0.42, 0.42, [0.19, 0.42, 0.24], 0.3, 0.3, 8);
  return g;
}

/** Hangar roof curves across its door opening, unlike a warehouse barrel. */
function hangar(g: Geo, x0: number, z0: number) {
  const width = 120, depth = 90, eave = 14.5, rise = 9.5, segs = 12;
  g.box([x0, 0, z0], [x0 + width, eave, z0 + depth], [0.29, 0.34, 0.35], 0.25);
  for (let i = 0; i < segs; i++) {
    const xa = x0 + width * i / segs, xb = x0 + width * (i + 1) / segs;
    const ya = eave + Math.sin(i / segs * Math.PI) * rise, yb = eave + Math.sin((i + 1) / segs * Math.PI) * rise;
    g.face([[xa, ya, z0], [xa, ya, z0 + depth], [xb, yb, z0 + depth], [xb, yb, z0]], ROOF, 0.27);
    for (const z of [z0, z0 + depth]) g.face([[x0 + width / 2, eave, z], [xa, ya, z], [xb, yb, z]], [0.34, 0.39, 0.41], 0.3);
    if (i % 3 === 0) g.face([[xa + 1, ya + 0.05, z0 + 22], [xa + 1, ya + 0.05, z0 + 65], [Math.min(xa + 6, xb), yb + 0.05, z0 + 65], [Math.min(xa + 6, xb), yb + 0.05, z0 + 22]], GLASS, 0.8);
  }
  // Six sliding leaves and translucent upper panels make the large doors readable.
  for (let i = 0; i < 6; i++) {
    const x = x0 + 12 + i * 16;
    g.box([x, 0.1, z0 - 0.14], [x + 15.7, 13.4, z0 - 0.04], i === 2 ? DARK : [0.39, 0.43, 0.43], 0.25);
    for (const y of [5.4, 10]) g.face([[x + 1, y, z0 - 0.15], [x + 14.5, y, z0 - 0.15], [x + 14.5, y + 1.7, z0 - 0.15], [x + 1, y + 1.7, z0 - 0.15]], GLASS, 0.8, i === 2 ? 0.1 : 0.025);
  }
  g.box([x0 + 2, 0, z0 + depth + 1], [x0 + 45, 5, z0 + depth + 14], [0.24, 0.29, 0.3], 0.3);
  for (let z = z0 + 8; z < z0 + depth; z += 10) g.box([x0 - 0.16, 0, z], [x0 + 0.06, eave, z + 0.17], METAL, 0.3);
  drum(g, x0 + width / 2, z0 + depth / 2, 24, 24.65, 0.14, 0.14, DARK, 0.25, 0, 6);
  drum(g, x0 + width / 2, z0 + depth / 2, 24.65, 24.9, 0.17, 0.17, [0.56, 0.045, 0.025], 0.35, 0.8, 6);
}

/** Where the surveillance radar's antenna turns, on top of its plinth. */
export const RADAR_PIVOT: Vec3 = [3040, 13, 675];

function radar(g: Geo) {
  const [x, , z] = RADAR_PIVOT;
  g.box([x - 14, 0, z - 12], [x + 14, 5, z + 12], [0.25, 0.29, 0.3], 0.2);
  drum(g, x, z, 5, 13, 2.2, 1.5, CONCRETE, 0.2);
}

/** The antenna in pivot space: a tilted parabolic reflector on a turntable, turned per frame. */
export function buildRadarAntenna(): Geo {
  const g = new Geo();
  drum(g, 0, 0, 0, 1.6, 1.5, 1.2, METAL, 0.3);
  beam(g, [0, 1.6, 0], [0, 4, 0], 0.35);
  const center: Vec3 = [0, 4, 0];
  const axis = v3.norm([-0.5, 0.75, -0.3]);
  const u = v3.norm(v3.cross(axis, [0, 0, 1])), v = v3.cross(axis, u);
  const n = 16, rings = 5, r = 8;
  const root = g.vertex(center, axis, METAL, 0.3);
  const base = g.count;
  for (let ring = 1; ring <= rings; ring++) for (let k = 0; k < n; k++) {
    const radius = r * ring / rings, a = k * Math.PI * 2 / n;
    const radial = v3.add(v3.scale(u, Math.cos(a)), v3.scale(v, Math.sin(a)));
    const p = v3.add(center, v3.add(v3.scale(radial, radius), v3.scale(axis, radius * radius / 22)));
    g.vertex(p, v3.norm(v3.sub(axis, v3.scale(radial, radius / 11))), [0.57, 0.59, 0.56], 0.32);
  }
  for (let k = 0; k < n; k++) g.tri(root, base + k, base + (k + 1) % n);
  for (let ring = 0; ring < rings - 1; ring++) for (let k = 0; k < n; k++) g.quad(base + ring * n + k, base + (ring + 1) * n + k, base + (ring + 1) * n + (k + 1) % n, base + ring * n + (k + 1) % n);
  const feed = v3.add(center, v3.scale(axis, 7));
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3;
    beam(g, v3.add(center, v3.add(v3.scale(u, Math.cos(a) * r), v3.add(v3.scale(v, Math.sin(a) * r), v3.scale(axis, r * r / 22)))), feed, 0.06);
  }
  g.box(v3.sub(feed, [0.24, 0.24, 0.24]), v3.add(feed, [0.24, 0.24, 0.24]), DARK, 0.3);
  return g;
}

export function buildServiceArchitecture(): Geo {
  const g = new Geo();
  for (let i = 0; i < 3; i++) hangar(g, -1150 + i * 150, 380);
  // Fire station has separate vehicle bays and a higher watch/dispatch room.
  g.box([3400, 0, 330], [3480, 9.5, 380], [0.32, 0.12, 0.09], 0.22);
  g.box([3458, 9.5, 345], [3478, 15, 377], CONCRETE, 0.2);
  facade(g, 3458, 3478, 344.98, 10.5, 14, 5);
  for (let x = 3406; x < 3452; x += 14) {
    g.box([x, 0.15, 329.95], [x + 10, 6.8, 329.99], [0.16, 0.19, 0.2], 0.3);
    for (let y = 1; y < 6.8; y += 1.1) g.box([x, y, 329.9], [x + 10, y + 0.05, 329.94], METAL, 0.3);
  }
  g.box([3398, 9.5, 328], [3482, 9.9, 382], ROOF, 0.2);
  // Cargo dock canopies, truck ramps and insulated roof pitches.
  for (let i = 0; i < 4; i++) {
    const x = -600 + i * 110;
    g.box([x, 0, 600], [x + 80, 10.5, 680], [0.29, 0.31, 0.3], 0.2);
    vaultedRoof(g, { x0: x - 1, x1: x + 81, z0: 599, z1: 681 }, 10.8, 2.5);
    g.box([x + 2, 4.8, 591], [x + 78, 5.1, 601], METAL, 0.35);
    for (let door = x + 8; door < x + 75; door += 14) {
      g.box([door, 1.15, 599.87], [door + 8, 4.7, 599.93], DARK, 0.3);
      g.box([door - 0.5, 0, 595], [door + 8.5, 1.15, 600], CONCRETE, 0.2);
      for (const dx of [-0.1, 7.8]) g.box([door + dx, 0, 593], [door + dx + 0.3, 1.5, 593.3], [0.63, 0.42, 0.08], 0.25);
    }
  }
  // Bund walls, closed tanks, catwalks and exposed transfer pipes form a fuel farm.
  for (const z of [613, 672]) g.box([3678, 0, z], [3855, 0.8, z + 0.5], CONCRETE, 0.2);
  for (const x of [3678, 3854.5]) g.box([x, 0, 613], [x + 0.5, 0.8, 672], CONCRETE, 0.2);
  for (let i = 0; i < 5; i++) {
    const x = 3700 + i * 34;
    drum(g, x, 640, 0.3, 13, 13, 13, [0.63, 0.65, 0.62], 0.32);
    drum(g, x, 640, 13, 14.2, 13, 1, [0.53, 0.56, 0.55], 0.28);
    beam(g, [x - 12.7, 0.3, 640], [x - 12.7, 13, 640], 0.09);
    beam(g, [x, 0.8, 653], [x, 0.8, 660], 0.17, [0.38, 0.4, 0.36]);
    if (i < 4) beam(g, [x, 12.7, 640], [x + 34, 12.7, 640], 0.3);
  }
  beam(g, [3700, 0.8, 660], [3836, 0.8, 660], 0.17, [0.38, 0.4, 0.36]);
  radar(g);
  return g;
}
