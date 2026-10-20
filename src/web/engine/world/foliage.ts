// Leaf sprays for the near trees.
//
// A crown seen from a few hundred metres is not a smooth blob: it is thousands
// of leaves on twigs, with sky showing through the gaps and a ragged outline.
// Near trees therefore wear a few dozen alpha-tested cards over their crowns,
// each card one spray of leaves (or needles) on its twig. The sprays are
// painted here, procedurally and deterministically, into one atlas of four
// 256-pixel cells: lobed oak leaves, small pendulous birch leaves, pine and
// spruce needles, and the small round leaves of the Lombardy poplar.
//
// Channels: R leaf brightness, G yellowing (0 fresh .. 1 turning), B twig
// (1 = bark), A coverage. Colour under transparent texels is the cell's mean
// leaf colour, so mipmaps converge on the leaves rather than on black.

import { rng } from '../math.ts';

export const LEAF_ATLAS_SIZE = 512;
const CELL = LEAF_ATLAS_SIZE / 2;

/** Atlas cell of each spray, as [column, row] of the 2 x 2 grid. */
export const LEAF_CELL = { broadleaf: [0, 0], birch: [1, 0], needle: [0, 1], poplar: [1, 1] } as const;
export type LeafKind = keyof typeof LEAF_CELL;

type Shape = 'lobed' | 'almond' | 'oval' | 'birch';

/** Half-width of each leaf shape along its length, tabulated (u = 0 stalk .. 1 tip). */
const OUTLINE_STEPS = 128;
const outlines = new Map<Shape, Float32Array>();
function outline(shape: Shape): Float32Array {
  let t = outlines.get(shape);
  if (t) return t;
  t = new Float32Array(OUTLINE_STEPS + 1);
  for (let i = 1; i < OUTLINE_STEPS; i++) {
    const u = i / OUTLINE_STEPS;
    switch (shape) {
      case 'lobed': t[i] = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 0.7) * (0.7 + 0.3 * Math.abs(Math.cos(u * Math.PI * 4.5))); break;
      case 'almond': t[i] = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 0.85); break;
      case 'oval': t[i] = Math.pow(Math.max(0, 1 - (2 * u - 1) * (2 * u - 1)), 0.55) * (u > 0.85 ? 1 - (u - 0.85) * 2.5 : 1); break;
      case 'birch': t[i] = Math.pow(u < 0.32 ? u / 0.32 : (1 - u) / 0.68, 0.75) * (0.88 + 0.12 * Math.sin(u * 46)); break;
    }
  }
  outlines.set(shape, t);
  return t;
}
function widthAt(t: Float32Array, u: number): number {
  if (u <= 0 || u >= 1) return 0;
  const f = u * OUTLINE_STEPS;
  const i = Math.floor(f);
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

/** Premultiplied paint buffers for one cell. */
class Cell {
  r = new Float32Array(CELL * CELL);
  g = new Float32Array(CELL * CELL);
  b = new Float32Array(CELL * CELL);
  a = new Float32Array(CELL * CELL);

  /** Paints a primitive with 4x supersampled coverage, over what is already there. */
  paint(x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean, color: (x: number, y: number) => [number, number, number]) {
    const ix0 = Math.max(0, Math.floor(x0));
    const iy0 = Math.max(0, Math.floor(y0));
    const ix1 = Math.min(CELL - 1, Math.ceil(x1));
    const iy1 = Math.min(CELL - 1, Math.ceil(y1));
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        let n = 0;
        if (inside(px + 0.25, py + 0.25)) n++;
        if (inside(px + 0.75, py + 0.25)) n++;
        if (inside(px + 0.25, py + 0.75)) n++;
        if (inside(px + 0.75, py + 0.75)) n++;
        if (!n) continue;
        const cov = n / 4;
        const [r, g, b] = color(px + 0.5, py + 0.5);
        const i = py * CELL + px;
        const keep = 1 - cov;
        this.r[i] = r * cov + this.r[i] * keep;
        this.g[i] = g * cov + this.g[i] * keep;
        this.b[i] = b * cov + this.b[i] * keep;
        this.a[i] = cov + this.a[i] * keep;
      }
    }
  }

  /** A twig or needle: a tapered stroke from A to B. */
  stroke(ax: number, ay: number, bx: number, by: number, w0: number, w1: number, color: [number, number, number]) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const pad = Math.max(w0, w1) + 1;
    this.paint(Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad, (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const ex = ax + dx * t - x;
      const ey = ay + dy * t - y;
      const w = w0 + (w1 - w0) * t;
      return ex * ex + ey * ey < w * w;
    }, () => color);
  }

  /** One leaf, its stalk at (x, y), pointing along `ang`. */
  leaf(x: number, y: number, ang: number, len: number, wid: number, shape: Shape, shade: number, hue: number) {
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const half = wid / 2;
    const profile = outline(shape);
    const tx = x + ca * len;
    const ty = y + sa * len;
    const px0 = Math.min(x, tx) - Math.abs(sa) * half - 1;
    const px1 = Math.max(x, tx) + Math.abs(sa) * half + 1;
    const py0 = Math.min(y, ty) - Math.abs(ca) * half - 1;
    const py1 = Math.max(y, ty) + Math.abs(ca) * half + 1;
    this.paint(px0, py0, px1, py1, (px, py) => {
      const dx = px - x;
      const dy = py - y;
      const u = (dx * ca + dy * sa) / len;
      return Math.abs((-dx * sa + dy * ca) / half) < widthAt(profile, u);
    }, (px, py) => {
      const dx = px - x;
      const dy = py - y;
      const u = (dx * ca + dy * sa) / len;
      const v = (-dx * sa + dy * ca) / half;
      const rib = u < 0.92 ? 1 - 0.28 * Math.exp(-v * v * 30) : 1;
      const edge = 0.9 + 0.1 * (1 - Math.min(1, Math.abs(v) / Math.max(widthAt(profile, u), 1e-3)));
      return [shade * (0.8 + 0.2 * u) * rib * edge, hue, 0];
    });
  }

  /** Fills transparent texels with the mean leaf colour and writes the cell into the atlas. */
  blit(out: Uint8Array, col: number, row: number) {
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let i = 0; i < this.a.length; i++) {
      if (this.a[i] < 0.5) continue;
      sr += this.r[i] / this.a[i];
      sg += this.g[i] / this.a[i];
      sb += this.b[i] / this.a[i];
      sa++;
    }
    const mr = sa ? sr / sa : 0.6;
    const mg = sa ? sg / sa : 0;
    const mb = sa ? sb / sa : 0;
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const i = y * CELL + x;
        const a = this.a[i];
        const o = ((row * CELL + y) * LEAF_ATLAS_SIZE + col * CELL + x) * 4;
        out[o] = byte(this.r[i] + mr * (1 - a));
        out[o + 1] = byte(this.g[i] + mg * (1 - a));
        out[o + 2] = byte(this.b[i] + mb * (1 - a));
        out[o + 3] = byte(a);
      }
    }
  }
}

const BARK: [number, number, number] = [0.42, 0, 1];
const MARGIN = 7;

/** Keeps a leaf of length `len` from (x, y) along `ang` inside the cell margin. */
function fit(x: number, y: number, ang: number, len: number): number {
  let l = len;
  for (let k = 0; k < 8; k++) {
    const tx = x + Math.cos(ang) * l;
    const ty = y + Math.sin(ang) * l;
    if (tx > MARGIN && tx < CELL - MARGIN && ty > MARGIN && ty < CELL - MARGIN) return l;
    l *= 0.82;
  }
  return 0;
}

interface Twig { ax: number; ay: number; bx: number; by: number }

function along(t: Twig, f: number): [number, number] {
  return [t.ax + (t.bx - t.ax) * f, t.ay + (t.by - t.ay) * f];
}

/** A branchlet: a main twig from the bottom of the cell with side twigs off it. */
function branchlet(r: () => number, sides: number, spread: number, top = 40): Twig[] {
  const base: Twig = { ax: CELL / 2 + (r() - 0.5) * 16, ay: CELL - 4, bx: CELL / 2 + (r() - 0.5) * 50, by: top + r() * 20 };
  const twigs = [base];
  for (let i = 0; i < sides; i++) {
    const f = 0.25 + (i / Math.max(1, sides - 1)) * 0.55 + (r() - 0.5) * 0.08;
    const [x, y] = along(base, f);
    const side = i % 2 ? 1 : -1;
    const ang = -Math.PI / 2 + side * (spread + (r() - 0.5) * 0.3);
    const len = (0.3 + 0.25 * r()) * CELL * (1 - f * 0.4);
    twigs.push({ ax: x, ay: y, bx: x + Math.cos(ang) * len, by: y + Math.sin(ang) * len });
  }
  return twigs;
}

/**
 * Twig tips of a branchlet: points along each side twig where leaves bunch,
 * as they do at the ends of the season's growth.
 */
function tips(twigs: Twig[], r: () => number, perTwig: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const t of twigs) {
    const dir = Math.atan2(t.by - t.ay, t.bx - t.ax);
    for (let k = 0; k < perTwig; k++) {
      const f = 0.35 + 0.65 * Math.pow(r(), 0.6);
      const [x, y] = along(t, f);
      out.push([x, y, dir]);
    }
  }
  return out;
}

/** Fine side shoots off every twig, so leaves have something to hang from. */
function shoots(c: Cell, twigs: Twig[], r: () => number, count: number, len: number): Twig[] {
  const out: Twig[] = [];
  for (let i = 0; i < count; i++) {
    const t = twigs[Math.floor(r() * twigs.length)];
    const [x, y] = along(t, 0.2 + 0.8 * r());
    const dir = Math.atan2(t.by - t.ay, t.bx - t.ax) + (r() < 0.5 ? -1 : 1) * (0.5 + 0.5 * r());
    const l = fit(x, y, dir, len * (0.6 + 0.6 * r()));
    if (l < 6) continue;
    const s: Twig = { ax: x, ay: y, bx: x + Math.cos(dir) * l, by: y + Math.sin(dir) * l };
    c.stroke(s.ax, s.ay, s.bx, s.by, 0.9, 0.5, BARK);
    out.push(s);
  }
  return out;
}

function broadleaf(c: Cell, r: () => number) {
  const twigs = branchlet(r, 7, 0.95);
  for (const [k, t] of twigs.entries()) c.stroke(t.ax, t.ay, t.bx, t.by, k ? 1.4 : 2.4, k ? 0.7 : 1.1, BARK);
  const fine = shoots(c, twigs, r, 44, 34);
  // leaves bunch along the shoots and at the twig tips: hundreds, each a hand's length
  const anchors = [...tips(twigs, r, 30), ...tips(fine, r, 11)];
  for (const [x, y, dir] of anchors) {
    for (let k = 0; k < 2; k++) {
      const ang = dir + (k ? 1 : -1) * (0.45 + r() * 0.8) + (r() - 0.5) * 0.4;
      const len = fit(x, y, ang, 11 + r() * 6);
      if (len < 6) continue;
      const facing = 0.5 + 0.5 * Math.sqrt(r());
      c.leaf(x, y, ang, len, len * (0.52 + r() * 0.12) * facing, r() < 0.72 ? 'lobed' : 'almond', 0.55 + r() * 0.45, r() < 0.1 ? 0.35 + r() * 0.4 : r() * 0.12);
    }
  }
}

function birch(c: Cell, r: () => number) {
  // slender twigs arch out from the top of the cell and droop, small leaves hanging off them
  const twigs: Twig[] = [];
  for (let k = 0; k < 7; k++) {
    let x = 26 + k * 34 + (r() - 0.5) * 16;
    let y = 6;
    let drift = (r() - 0.5) * 3.2;
    for (let s = 0; s < 6; s++) {
      const nx = x + drift * 9;
      const ny = Math.min(CELL - 14, y + 34 + r() * 10);
      twigs.push({ ax: x, ay: y, bx: nx, by: ny });
      x = nx;
      y = ny;
      drift *= 0.7;
    }
  }
  for (const t of twigs) c.stroke(t.ax, t.ay, t.bx, t.by, 0.9, 0.7, BARK);
  for (let i = 0; i < 760; i++) {
    const t = twigs[Math.floor(r() * twigs.length)];
    const [x, y] = along(t, r());
    const ang = Math.PI / 2 + (r() - 0.5) * 1.9;
    const len = fit(x, y, ang, 8 + r() * 5);
    if (len < 5) continue;
    c.leaf(x, y, ang, len, len * (0.5 + 0.22 * r()), 'birch', 0.6 + r() * 0.4, r() < 0.16 ? 0.45 + r() * 0.5 : r() * 0.15);
  }
}

function needles(c: Cell, r: () => number) {
  const twigs = branchlet(r, 8, 0.85, 22);
  for (const [k, t] of twigs.entries()) c.stroke(t.ax, t.ay, t.bx, t.by, k ? 1.5 : 2.4, 0.9, BARK);
  for (const t of twigs) {
    const dir = Math.atan2(t.by - t.ay, t.bx - t.ax);
    const length = Math.hypot(t.bx - t.ax, t.by - t.ay);
    for (let s = 6; s < length; s += 4.2) {
      const [x, y] = along(t, s / length);
      for (const side of [-1, 1]) {
        const ang = dir + side * (0.5 + r() * 0.35);
        const len = fit(x, y, ang, 20 + r() * 14 * (1 - (s / length) * 0.4));
        if (len < 6) continue;
        const shade = 0.55 + r() * 0.45;
        c.stroke(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 1.25, 0.55, [shade, r() * 0.08, 0]);
      }
    }
  }
}

function poplar(c: Cell, r: () => number) {
  const twigs = branchlet(r, 6, 0.5);
  for (const [k, t] of twigs.entries()) c.stroke(t.ax, t.ay, t.bx, t.by, k ? 1.2 : 1.9, 0.6, BARK);
  const fine = shoots(c, twigs, r, 36, 26);
  const all = [...twigs, ...fine];
  for (let i = 0; i < 980; i++) {
    const t = all[Math.floor(r() * all.length)];
    const [x, y] = along(t, 0.1 + r() * 0.9);
    const dir = Math.atan2(t.by - t.ay, t.bx - t.ax);
    const ang = dir + (r() - 0.5) * 2.6;
    const len = fit(x, y, ang, 8 + r() * 4);
    if (len < 5) continue;
    c.leaf(x, y, ang, len, len * (0.62 + 0.26 * r()), 'oval', 0.55 + r() * 0.45, r() < 0.08 ? 0.5 + r() * 0.4 : r() * 0.1);
  }
}

/** The RGBA8 atlas (see the channel layout above), 512 x 512, deterministic. */
export function leafAtlas(): Uint8Array {
  const out = new Uint8Array(LEAF_ATLAS_SIZE * LEAF_ATLAS_SIZE * 4);
  const painters: [LeafKind, (c: Cell, r: () => number) => void][] = [['broadleaf', broadleaf], ['birch', birch], ['needle', needles], ['poplar', poplar]];
  for (const [kind, paint] of painters) {
    const c = new Cell();
    paint(c, rng(4100 + LEAF_CELL[kind][0] * 7 + LEAF_CELL[kind][1] * 13));
    c.blit(out, LEAF_CELL[kind][0], LEAF_CELL[kind][1]);
  }
  return out;
}
