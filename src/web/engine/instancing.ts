// Spatially bucketed instancing. Tens of thousands of trees (or grass tufts)
// are sorted into grid cells once; each pass then draws only the cells inside
// its frustum and range, by pointing the instance attributes at the cell's
// slice of one static buffer. No per-frame uploads, and the GPU never sees
// trees behind the camera or under another cascade's shadow map.

import type { GL } from './gl.ts';
import type { Mat4 } from './math.ts';

export interface InstanceAttr {
  loc: number;
  size: number;
}

interface Cell {
  x: number;
  y: number;
  z: number;
  radius: number;
  start: number;
  count: number;
}

/** Frustum planes (a, b, c, d) from a column-major view-projection matrix. */
export function frustumPlanes(m: Mat4): Float32Array {
  const p = new Float32Array(24);
  const rows = [0, 1, 2].map((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]]);
  const w = [m[3], m[7], m[11], m[15]];
  let k = 0;
  for (const r of rows) {
    for (const s of [1, -1]) {
      const a = w[0] + s * r[0];
      const b = w[1] + s * r[1];
      const c = w[2] + s * r[2];
      const d = w[3] + s * r[3];
      const l = Math.hypot(a, b, c) || 1;
      p[k++] = a / l;
      p[k++] = b / l;
      p[k++] = c / l;
      p[k++] = d / l;
    }
  }
  return p;
}

export function sphereVisible(planes: Float32Array, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
  return true;
}

export class CellInstances {
  vao: WebGLVertexArrayObject;
  private gl: GL;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private inst: WebGLBuffer;
  private indexCount: number;
  private stride: number;
  private attrs: InstanceAttr[];
  private cells: Cell[] = [];
  total = 0;

  /**
   * `vertexAttrs` describe the mesh; `attrs` the per-instance layout, whose
   * first three floats must be the instance position (for bucketing).
   */
  constructor(gl: GL, mesh: { data: Float32Array; indices: Uint16Array | Uint32Array }, vertexAttrs: InstanceAttr[], instances: Float32Array, attrs: InstanceAttr[], cellSize = 450, extent = 40) {
    this.gl = gl;
    this.attrs = attrs;
    this.stride = attrs.reduce((a, b) => a + b.size, 0);
    const n = instances.length / this.stride;
    this.total = n;
    // bucket by cell, then lay the instances out contiguously per cell
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const x = instances[i * this.stride];
      const z = instances[i * this.stride + 2];
      const key = `${Math.floor(x / cellSize)}_${Math.floor(z / cellSize)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }
    const sorted = new Float32Array(instances.length);
    let at = 0;
    for (const list of buckets.values()) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const start = at;
      for (const i of list) {
        const o = i * this.stride;
        sorted.set(instances.subarray(o, o + this.stride), at * this.stride);
        const x = instances[o], y = instances[o + 1], z = instances[o + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y + extent);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        at++;
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + extent * 0.5;
      this.cells.push({ x: cx, y: cy, z: cz, radius, start, count: list.length });
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const vstride = vertexAttrs.reduce((a, b) => a + b.size, 0);
    let off = 0;
    for (const a of vertexAttrs) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, vstride * 4, off * 4);
      off += a.size;
    }
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.indexCount = mesh.indices.length;
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, sorted, gl.STATIC_DRAW);
    for (const a of attrs) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribDivisor(a.loc, 1);
    }
    this.point(0);
    gl.bindVertexArray(null);
    this.indexType = mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  private indexType: number;

  private point(firstInstance: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    let off = 0;
    for (const a of this.attrs) {
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, this.stride * 4, (firstInstance * this.stride + off) * 4);
      off += a.size;
    }
  }

  /**
   * Draws the cells visible in `planes` whose centre is within `range` of
   * `from`. Returns the number of instances drawn.
   */
  draw(planes: Float32Array, from: [number, number, number], range: number, minRange = 0): number {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    let drawn = 0;
    for (const c of this.cells) {
      const dx = c.x - from[0], dy = c.y - from[1], dz = c.z - from[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d - c.radius > range || d < minRange) continue;
      if (!sphereVisible(planes, c.x, c.y, c.z, c.radius)) continue;
      this.point(c.start);
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, this.indexType, 0, c.count);
      drawn += c.count;
    }
    gl.bindVertexArray(null);
    return drawn;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteBuffer(this.inst);
  }
}
