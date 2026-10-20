// Plane polylines for roads, rails and routes: corners rounded into smooth
// curves, lines offset sideways into lanes and tracks. Shared by the road
// and rail geometry and by the traffic that drives on it, so vehicles and
// trains follow exactly the surfaces that are drawn.

import { MOTORWAY } from './city.ts';

export type P2 = [number, number];

/**
 * Replaces each interior corner with a smooth curve of about `radius`
 * metres and subdivides straight runs every `step` metres, so a vehicle's
 * heading turns continuously and heights can be sampled densely.
 */
export function roundCorners(pts: P2[], radius: number, closed: boolean, step = 8): P2[] {
  const n = pts.length;
  const out: P2[] = [];
  const corner = (i: number): { a: P2; b: P2; c: P2 } | null => {
    const p = pts[(i - 1 + n) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const l2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    const d1: P2 = [(q[0] - p[0]) / l1, (q[1] - p[1]) / l1];
    const d2: P2 = [(r[0] - q[0]) / l2, (r[1] - q[1]) / l2];
    const turn = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
    if (turn < 0.01) return null;
    const cut = Math.min(radius * Math.tan(turn / 2), l1 * 0.48, l2 * 0.48);
    return { a: [q[0] - d1[0] * cut, q[1] - d1[1] * cut], b: q, c: [q[0] + d2[0] * cut, q[1] + d2[1] * cut] };
  };
  const line = (a: P2, b: P2) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  };
  const corners = pts.map((_, i) => (closed || (i > 0 && i < n - 1) ? corner(i) : null));
  const start: P2 = corners[0] ? corners[0]!.c : pts[0];
  out.push(start);
  let at = start;
  const last = closed ? n : n - 1;
  for (let i = 1; i <= last; i++) {
    const k = i % n;
    const c = corners[k];
    if (c) {
      line(at, c.a);
      // quadratic Bézier through the corner
      const steps = 10;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        const u = 1 - t;
        out.push([u * u * c.a[0] + 2 * u * t * c.b[0] + t * t * c.c[0], u * u * c.a[1] + 2 * u * t * c.b[1] + t * t * c.c[1]]);
      }
      at = c.c;
    } else {
      line(at, pts[k]);
      at = pts[k];
    }
  }
  if (closed) out.pop();
  return out;
}

/** Offsets a polyline sideways: positive is to the right of the direction of travel. */
export function offsetLine(pts: P2[], d: number, closed: boolean): P2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    // right of heading (dx, dz) in this world is (-dz, dx)
    return [p[0] - (dz / l) * d, p[1] + (dx / l) * d] as P2;
  });
}

/** Offsets a polyline by an amount that varies with distance along it (crossovers, lane changes). */
export function offsetLineBy(pts: P2[], f: (s: number) => number): P2[] {
  let s = 0;
  return pts.map((p, i) => {
    if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    const d = f(s);
    return [p[0] - (dz / l) * d, p[1] + (dx / l) * d] as P2;
  });
}

/** Motorway centreline with gentle bends, as a 2D polyline. */
export function motorwayLine(): P2[] {
  return roundCorners(MOTORWAY.map((p) => [p[0], p[2]] as P2), 140, false, 10);
}
