// The field system, on the CPU.
//
// The terrain shader paints the farmland (see fieldDistrict and fieldColor in
// shaders.ts): districts about 1.6 km across, each with its own orientation
// and parcel size, parcels in staggered rows, some split into strips. This is
// the same geometry in TypeScript, built on the shader's own hash, so 3D
// hedgerows can be planted exactly on the boundaries the shader paints.

/** fract(), as GLSL defines it. */
function fract(v: number): number {
  return v - Math.floor(v);
}

/** The shaders' hash12 (Dave Hoskins' "hash without sine"). */
export function hash12(x: number, y: number): number {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fract((a + b) * c);
}

/** The shaders' value noise. */
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** The shaders' five-octave fbm. */
export function fbm(x: number, y: number): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < 5; i++) {
    s += a * vnoise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

export interface District {
  /** Grid cell of the district's seed point. */
  ix: number;
  iz: number;
  /** Orientation of the parcels (radians), and their scale. */
  ang: number;
  scale: number;
  /** Distance to the district border, where the country lanes run (m). */
  border: number;
}

const DISTRICT = 1650;

/** The district a point lies in (fieldDistrict in TERRAIN_FS). */
export function fieldDistrict(x: number, z: number): District {
  const gx = x / DISTRICT;
  const gz = z / DISTRICT;
  const fx = Math.floor(gx);
  const fz = Math.floor(gz);
  let d1 = 1e9;
  let d2 = 1e9;
  let ix = 0;
  let iz = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = fx + i;
      const cz = fz + j;
      const ox = hash12(cx * 1.31 + 0.7, cz * 1.31 + 0.7) * 0.85 + 0.075;
      const oz = hash12(cx * 2.17 + 3.1, cz * 2.17 + 3.1) * 0.85 + 0.075;
      const dx = gx - (cx + ox);
      const dz = gz - (cz + oz);
      const dd = dx * dx + dz * dz;
      if (dd < d1) {
        d2 = d1;
        d1 = dd;
        ix = cx;
        iz = cz;
      } else if (dd < d2) d2 = dd;
    }
  }
  return {
    ix,
    iz,
    ang: (hash12(ix * 3.7 + 1.9, iz * 3.7 + 1.9) - 0.5) * Math.PI,
    scale: 0.7 + 0.65 * hash12(ix * 5.3 + 7.1, iz * 5.3 + 7.1),
    border: (Math.sqrt(d2) - Math.sqrt(d1)) * DISTRICT * 0.5,
  };
}

/** Parcel size of a district (m), before splitting into strips. */
function parcelSize(d: District): [number, number] {
  return [360 * d.scale, 205 * d.scale];
}

/** Parcel coordinates of a point: rotated into the district's frame. */
function parcelFrame(d: District, x: number, z: number): [number, number] {
  const ca = Math.cos(d.ang);
  const sa = Math.sin(d.ang);
  return [ca * x + sa * z + d.ix * 397, -sa * x + ca * z + d.iz * 397];
}

/** Row stagger, so field corners do not line up into a grid. */
function stagger(row: number, d: District): number {
  return hash12(row, d.ix) * 0.8;
}

/** Whether a parcel is split lengthwise into two strips. */
function split(cx: number, cy: number, d: District): boolean {
  return hash12(cx + d.ix * 13 + 41, cy + d.iz * 13 + 41) >= 0.62;
}

/** Distance (m) from a point to the nearest field boundary, as the shader measures it. */
export function fieldEdge(x: number, z: number): number {
  const d = fieldDistrict(x, z);
  const [sx, sy] = parcelSize(d);
  const [rx, ry] = parcelFrame(d, x, z);
  const qy = ry / sy;
  const qx = rx / sx + stagger(Math.floor(qy), d);
  const cx = Math.floor(qx);
  const cy = Math.floor(qy);
  const f = qx - cx;
  const g = qy - cy;
  const s = split(cx, cy, d);
  const fx = s ? fract(f * 2) : f;
  const edge = Math.min(Math.min(fx, 1 - fx) * sx * (s ? 0.5 : 1), Math.min(g, 1 - g) * sy);
  return Math.min(edge, d.border);
}

export interface Parcel {
  /** The crop draw in [0, 1): pasture below 0.2, ley, maize, wheat, barley, stubble from 0.68, plough from 0.8, rape. */
  crop: number;
  /** Distance to the parcel's boundary (m). */
  edge: number;
  /** Heading the tractors drove (radians): drill rows and swaths run this way. */
  drive: number;
  /** Coordinate across the drill rows (m): the shader's dir. */
  across: number;
  /** The parcel's identity: equal for every point of one parcel. */
  id: string;
}

/** The parcel under a point, with its crop, as fieldColor in TERRAIN_FS paints it. */
export function fieldParcel(x: number, z: number): Parcel {
  const d = fieldDistrict(x, z);
  const [sx, sy] = parcelSize(d);
  const [rx, ry] = parcelFrame(d, x, z);
  const qy = ry / sy;
  const qx = rx / sx + stagger(Math.floor(qy), d);
  const cx = Math.floor(qx);
  const cy = Math.floor(qy);
  const f = qx - cx;
  const g = qy - cy;
  const s = split(cx, cy, d);
  const fx = s ? fract(f * 2) : f;
  const edge = Math.min(Math.min(fx, 1 - fx) * sx * (s ? 0.5 : 1), Math.min(g, 1 - g) * sy, d.border);
  const cellX = cx * 2 + (s && f >= 0.5 ? 1 : 0) + d.ix * 31;
  const cellY = cy * 2 + d.iz * 31;
  const alongX = hash12(cellX + 3, cellY + 3) < 0.5;
  return {
    crop: hash12(cellX, cellY),
    edge,
    // rows are lines of constant dir: the tractor drove along the other axis
    drive: alongX ? d.ang + Math.PI / 2 : d.ang,
    across: alongX ? rx : ry,
    id: `${cellX}_${cellY}`,
  };
}

/** Farmland (1) as opposed to rough grazing and heath (0), as the shader blends them. */
export function farmland(x: number, z: number): number {
  const n = fbm(x * 0.0008 + 18, z * 0.0008 + 18);
  const t = Math.max(0, Math.min(1, (n - 0.43) / (0.62 - 0.43)));
  return 1 - t * t * (3 - 2 * t);
}

/** Hedges have gaps at the gateways, where the shader leaves the line unpainted. */
export function hedgeGap(x: number, z: number): boolean {
  return vnoise(x * 0.018, z * 0.018) < 0.22;
}

export interface HedgePoint {
  x: number;
  z: number;
  /** Heading of the hedge line (radians, local +x along the hedge). */
  heading: number;
}

/**
 * Points every `step` metres along the field boundaries of the districts whose
 * seeds lie in the box, skipping lanes, gateways and rough ground. `near` is a
 * cheap first test (range from the cameras, say); `keep` filters by any other
 * rule (water, woods, roads) once a point is known to be on a hedge line.
 */
export function hedgeLines(box: { x0: number; z0: number; x1: number; z1: number }, step: number, near: (x: number, z: number) => boolean, keep: (x: number, z: number) => boolean): HedgePoint[] {
  const out: HedgePoint[] = [];
  const seen = new Set<string>();
  for (let gz = Math.floor(box.z0 / DISTRICT) - 1; gz <= Math.floor(box.z1 / DISTRICT) + 1; gz++) {
    for (let gx = Math.floor(box.x0 / DISTRICT) - 1; gx <= Math.floor(box.x1 / DISTRICT) + 1; gx++) {
      // the district whose seed lies in this grid cell
      const ox = hash12(gx * 1.31 + 0.7, gz * 1.31 + 0.7) * 0.85 + 0.075;
      const oz = hash12(gx * 2.17 + 3.1, gz * 2.17 + 3.1) * 0.85 + 0.075;
      const seedX = (gx + ox) * DISTRICT;
      const seedZ = (gz + oz) * DISTRICT;
      const d = fieldDistrict(seedX, seedZ);
      if (d.ix !== gx || d.iz !== gz) continue;
      const key = `${gx}_${gz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [sx, sy] = parcelSize(d);
      const ca = Math.cos(d.ang);
      const sa = Math.sin(d.ang);
      const [crx, cry] = parcelFrame(d, seedX, seedZ);
      // a district's cell lies within ~1.4 grid cells of its seed; skip
      // districts that do not come near the area wanted at all
      const reach = DISTRICT * 1.45;
      let wanted = false;
      for (let a = -4; a <= 4 && !wanted; a++) for (let b = -4; b <= 4 && !wanted; b++) wanted = near(seedX + (a * reach) / 4, seedZ + (b * reach) / 4);
      if (!wanted) continue;
      const toWorld = (rx: number, ry: number): [number, number] => {
        const u = rx - d.ix * 397;
        const v = ry - d.iz * 397;
        return [ca * u - sa * v, sa * u + ca * v];
      };
      const visit = (rx: number, ry: number, heading: number) => {
        const [x, z] = toWorld(rx, ry);
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1 || !near(x, z)) return;
        const at = fieldDistrict(x, z);
        if (at.ix !== d.ix || at.iz !== d.iz || at.border < 9) return;
        if (hedgeGap(x, z) || farmland(x, z) < 0.6 || !keep(x, z)) return;
        out.push({ x, z, heading });
      };
      const rowLo = Math.floor((cry - reach) / sy);
      const rowHi = Math.ceil((cry + reach) / sy);
      for (let row = rowLo; row <= rowHi; row++) {
        // the boundary between this row and the next, along the parcels
        for (let rx = crx - reach; rx < crx + reach; rx += step) visit(rx, row * sy, d.ang);
        // the ends of each parcel in this row, and the strip divisions
        const st = stagger(row, d);
        const colLo = Math.floor((crx - reach) / sx + st);
        const colHi = Math.ceil((crx + reach) / sx + st);
        for (let col = colLo; col <= colHi; col++) {
          const ends = split(col, row, d) ? [col, col + 0.5] : [col];
          for (const e of ends) {
            const rx = (e - st) * sx;
            for (let ry = row * sy + step / 2; ry < (row + 1) * sy; ry += step) visit(rx, ry, d.ang + Math.PI / 2);
          }
        }
      }
    }
  }
  return out;
}
