// One shoreline model drives the terrain, water geometry and water material.
// Keeping those boundaries together avoids rectangular rivers, circular lakes
// and water that spills over dry airport ground.

import { clamp, smoothstep, type Vec3 } from '../math.ts';

export const WATER_LEVEL = -5;
export const RIVER = { amp: 380, wave: 1500, z: -2350 };
export interface WaterBody {
  x: number;
  z: number;
  rx: number;
  rz: number;
  angle: number;
  phase: number;
  depth: number;
}
export const LAKE = { x: -3600, z: 3900, r: 1100, rx: 1100, rz: 870, angle: -0.28, phase: 1.4, depth: 17 };
export const PONDS: readonly WaterBody[] = [
  { x: -1100, z: 1770, rx: 470, rz: 290, angle: 0.32, phase: 0.7, depth: 5 },
  { x: 3250, z: 1720, rx: 460, rz: 280, angle: -0.4, phase: 2.2, depth: 4.5 },
  { x: 5600, z: 2600, rx: 680, rz: 400, angle: 0.28, phase: 4.1, depth: 7 },
];

export function riverZ(x: number): number {
  return RIVER.z + Math.sin(x / RIVER.wave) * RIVER.amp + Math.sin(x / (RIVER.wave * 0.37)) * RIVER.amp * 0.3;
}

/** Half width in metres across z; broad reaches alternate with narrow bends. */
export function riverWidthAt(x: number): number {
  return 103 + Math.sin(x * 0.00063 + 0.8) * 22 + Math.cos(x * 0.0017 - 0.5) * 16 + Math.sin(x * 0.0033 + 2.1) * 8;
}

function shorelineFactor(angle: number, phase: number): number {
  return 1 + 0.11 * Math.sin(angle * 3 + phase) + 0.065 * Math.sin(angle * 5 - phase * 0.6) + 0.035 * Math.cos(angle * 7 + phase * 0.8);
}

export function lakeShorePoint(body: WaterBody, angle: number, shoreOffset = 0): Vec3 {
  const radius = Math.max(0, shorelineFactor(angle, body.phase) + shoreOffset / Math.min(body.rx, body.rz));
  const x = Math.cos(angle) * body.rx * radius;
  const z = Math.sin(angle) * body.rz * radius;
  const c = Math.cos(body.angle), s = Math.sin(body.angle);
  return [body.x + c * x - s * z, WATER_LEVEL, body.z + s * x + c * z];
}

/** Approximate signed shore distance in metres: negative is water. */
export function lakeShoreDistance(body: WaterBody, x: number, z: number): number {
  const dx = x - body.x, dz = z - body.z;
  const c = Math.cos(body.angle), s = Math.sin(body.angle);
  const u = (c * dx + s * dz) / body.rx;
  const v = (-s * dx + c * dz) / body.rz;
  return (Math.hypot(u, v) - shorelineFactor(Math.atan2(v, u), body.phase)) * Math.min(body.rx, body.rz);
}

export function shorelineDistance(x: number, z: number): number {
  let distance = Math.min(Math.abs(z - riverZ(x)) - riverWidthAt(x), lakeShoreDistance(LAKE, x, z));
  for (const pond of PONDS) distance = Math.min(distance, lakeShoreDistance(pond, x, z));
  return distance;
}

/** Depth falls continuously to zero at every shoreline. */
export function waterDepthAt(x: number, z: number): number {
  let depth = clamp((riverWidthAt(x) - Math.abs(z - riverZ(x))) * 0.12, 0, 14);
  for (const body of [LAKE, ...PONDS]) depth = Math.max(depth, clamp(-lakeShoreDistance(body, x, z) * 0.065, 0, body.depth));
  return depth;
}

export function carveWaterHeight(x: number, z: number, ground: number): number {
  const shore = shorelineDistance(x, z);
  if (shore < 0) return Math.min(ground, WATER_LEVEL - waterDepthAt(x, z));
  if (shore >= 65) return ground;
  const bank = WATER_LEVEL + (Math.max(ground, WATER_LEVEL + 0.8) - WATER_LEVEL) * smoothstep(0, 65, shore);
  return Math.min(ground, bank);
}

/** Flat position-only water geometry; shading supplies waves and depth. */
export function buildWaterGeometry(riverSegments = 780, shoreSegments = 112): { data: Float32Array; indices: Uint32Array } {
  if (!Number.isInteger(riverSegments) || riverSegments < 2 || !Number.isInteger(shoreSegments) || shoreSegments < 16) throw new RangeError('Water geometry needs at least two river segments and sixteen shoreline segments');
  const data: number[] = [], indices: number[] = [];
  for (let i = 0; i <= riverSegments; i++) {
    const x = -30_000 + (i / riverSegments) * 60_000;
    const z = riverZ(x), width = riverWidthAt(x);
    const index = data.length / 3;
    data.push(x, WATER_LEVEL, z - width, x, WATER_LEVEL, z + width);
    if (i > 0) indices.push(index - 2, index - 1, index, index - 1, index + 1, index);
  }
  for (const body of [LAKE, ...PONDS]) {
    const center = data.length / 3;
    data.push(body.x, WATER_LEVEL, body.z);
    for (let i = 0; i <= shoreSegments; i++) {
      data.push(...lakeShorePoint(body, (i / shoreSegments) * Math.PI * 2));
      if (i > 0) indices.push(center, center + i + 1, center + i);
    }
  }
  return { data: new Float32Array(data), indices: new Uint32Array(indices) };
}

// CPU and fragment programs use identical analytic boundaries. Values are
// inserted from the source constants so a moved pond cannot leave a ghost bank.
const glslBody = (body: WaterBody) => `lakeDistance(p, vec4(${body.x.toFixed(1)}, ${body.z.toFixed(1)}, ${body.rx.toFixed(1)}, ${body.rz.toFixed(1)}), vec2(${body.angle.toFixed(4)}, ${body.phase.toFixed(4)}))`;
export const HYDROLOGY_GLSL = `
float riverCenter(float x) { return ${RIVER.z.toFixed(1)} + sin(x / ${RIVER.wave.toFixed(1)}) * ${RIVER.amp.toFixed(1)} + sin(x / ${(RIVER.wave * 0.37).toFixed(1)}) * ${(RIVER.amp * 0.3).toFixed(1)}; }
float riverHalfWidth(float x) { return 103.0 + sin(x * 0.00063 + 0.8) * 22.0 + cos(x * 0.0017 - 0.5) * 16.0 + sin(x * 0.0033 + 2.1) * 8.0; }
float lakeDistance(vec2 p, vec4 basin, vec2 shape) {
  vec2 d = p - basin.xy;
  float c = cos(shape.x), s = sin(shape.x);
  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / basin.zw;
  float a = dot(q, q) < 0.000001 ? 0.0 : atan(q.y, q.x);
  float r = 1.0 + 0.11 * sin(a * 3.0 + shape.y) + 0.065 * sin(a * 5.0 - shape.y * 0.6) + 0.035 * cos(a * 7.0 + shape.y * 0.8);
  return (length(q) - r) * min(basin.z, basin.w);
}
float waterShore(vec2 p) {
  float distance = min(abs(p.y - riverCenter(p.x)) - riverHalfWidth(p.x), ${glslBody(LAKE)});
  ${PONDS.map((body) => `distance = min(distance, ${glslBody(body)});`).join('\n  ')}
  return distance;
}
float waterDepth(vec2 p) {
  float depth = clamp((riverHalfWidth(p.x) - abs(p.y - riverCenter(p.x))) * 0.12, 0.0, 14.0);
  ${[LAKE, ...PONDS].map((body) => `depth = max(depth, clamp(-${glslBody(body)} * 0.065, 0.0, ${body.depth.toFixed(2)}));`).join('\n  ')}
  return depth;
}
`;
