// WebGL2 plumbing: programs, geometry, meshes (indexed, instanced), textures
// and render targets with depth.

import { type Mat4, type Vec3, transform, v3 } from './math.ts';

export type GL = WebGL2RenderingContext;

export function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
  }
  return sh;
}

export interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export function program(gl: GL, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

// ------------------------------------------------------------------ geometry

/** Lit-mesh vertex: position, normal, albedo, material (gloss, emissive). 11 floats. */
export const LIT_STRIDE = 11;

export class Geo {
  data: number[] = [];
  idx: number[] = [];
  get count() {
    return this.data.length / LIT_STRIDE;
  }
  vertex(p: Vec3, n: Vec3, c: Vec3, gloss = 0.2, emissive = 0): number {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], gloss, emissive);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  /** Flat-shaded quad from four corners (counter-clockwise seen from the front). */
  face(p: Vec3[], c: Vec3, gloss = 0.2, emissive = 0) {
    const n = v3.norm(v3.cross(v3.sub(p[1], p[0]), v3.sub(p[2], p[0])));
    const i = p.map((q) => this.vertex(q, n, c, gloss, emissive));
    if (i.length === 4) this.quad(i[0], i[1], i[2], i[3]);
    else this.tri(i[0], i[1], i[2]);
  }
  /** Axis-aligned box. */
  box(min: Vec3, max: Vec3, c: Vec3, gloss = 0.15, emissive = 0, skipBottom = true) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c, gloss, emissive);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], c, gloss, emissive);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], c, gloss, emissive);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], c, gloss, emissive);
    this.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], c, gloss, emissive);
    if (!skipBottom) this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], c, gloss, emissive);
  }
  /** Appends another geometry transformed by a matrix. */
  merge(g: Geo, m?: Mat4) {
    const base = this.count;
    for (let i = 0; i < g.data.length; i += LIT_STRIDE) {
      let p: Vec3 = [g.data[i], g.data[i + 1], g.data[i + 2]];
      let n: Vec3 = [g.data[i + 3], g.data[i + 4], g.data[i + 5]];
      if (m) {
        const t = transform(m, p);
        p = [t[0], t[1], t[2]];
        const tn = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
        n = v3.norm(tn as Vec3);
      }
      this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], g.data[i + 6], g.data[i + 7], g.data[i + 8], g.data[i + 9], g.data[i + 10]);
    }
    for (const j of g.idx) this.idx.push(j + base);
  }
}

// ------------------------------------------------------------------ meshes

export interface AttrSpec {
  loc: number;
  size: number;
}

/** A vertex buffer (+ optional index buffer and per-instance buffer) bound to a VAO. */
export class Mesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer | null = null;
  inst: WebGLBuffer | null = null;
  count = 0;
  indexCount = 0;
  instances = 1;
  private gl: GL;
  private indexType: number;

  constructor(gl: GL, attrs: AttrSpec[], data: Float32Array | null, indices?: Uint32Array | Uint16Array | null, usage: number = gl.STATIC_DRAW, instanceAttrs?: AttrSpec[]) {
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    const stride = attrs.reduce((a, b) => a + b.size, 0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    let off = 0;
    for (const a of attrs) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride * 4, off * 4);
      off += a.size;
    }
    this.indexType = indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    if (indices) {
      this.ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.indexCount = indices.length;
    }
    if (instanceAttrs) {
      this.inst = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      const istride = instanceAttrs.reduce((a, b) => a + b.size, 0);
      let ioff = 0;
      for (const a of instanceAttrs) {
        gl.enableVertexAttribArray(a.loc);
        gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, istride * 4, ioff * 4);
        gl.vertexAttribDivisor(a.loc, 1);
        ioff += a.size;
      }
    }
    gl.bindVertexArray(null);
    if (data) this.count = data.length / stride;
  }

  static lit(gl: GL, g: Geo, instanceAttrs?: AttrSpec[]): Mesh {
    const idx = g.count > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx);
    return new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 3 }, { loc: 3, size: 2 }], new Float32Array(g.data), idx, gl.STATIC_DRAW, instanceAttrs);
  }

  update(data: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.count = count;
  }

  setInstances(data: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.instances = count;
  }

  draw(mode: number = this.gl.TRIANGLES) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.ibo) {
      if (this.inst) gl.drawElementsInstanced(mode, this.indexCount, this.indexType, 0, this.instances);
      else gl.drawElements(mode, this.indexCount, this.indexType, 0);
    } else if (this.count > 0) {
      if (this.inst) gl.drawArraysInstanced(mode, 0, this.count, this.instances);
      else gl.drawArrays(mode, 0, this.count);
    }
  }
}

/**
 * Screen-space thick lines: instanced quads expanded in the vertex shader.
 * Instance layout: A.xyz, B.xyz, rgb, alphaA, alphaB, widthPx (12 floats).
 */
export const SEGMENT_FLOATS = 12;

export class InstancedLines {
  vao: WebGLVertexArrayObject;
  inst: WebGLBuffer;
  count = 0;
  private gl: GL;
  constructor(gl: GL) {
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const corner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const stride = SEGMENT_FLOATS * 4;
    for (const [loc, size, off] of [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 3, 9]] as const) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }
  update(data: Float32Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.count = data.length / SEGMENT_FLOATS;
  }
  draw() {
    if (this.count <= 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
  }
}

// ------------------------------------------------------------------ textures & targets

export function canvasTexture(gl: GL, canvas: HTMLCanvasElement | OffscreenCanvas, repeat = false): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as TexImageSource);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return tex;
}

export interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export function makeTarget(gl: GL, w: number, h: number, hdr: boolean): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

export function deleteTarget(gl: GL, t: Target | null) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

/** Multisampled colour + depth, resolved into a sampleable colour target. */
export class SceneTarget {
  fb: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
  resolved: Target;
  /** Single-sample depth, resolved alongside colour for ambient occlusion and depth of field. */
  depthTex: WebGLTexture | null = null;
  /** Samples per pixel actually allocated (0 or 1: not multisampled). */
  samples = 0;
  private depthFb: WebGLFramebuffer | null = null;
  private depthChecked = false;
  w: number;
  h: number;
  private gl: GL;
  constructor(gl: GL, w: number, h: number, hdr: boolean, samples: number, withDepthTexture = false) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    const max = gl.getParameter(gl.MAX_SAMPLES) as number;
    const s = Math.min(samples, max);
    this.samples = s;
    this.color = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, hdr ? gl.RGBA16F : gl.RGBA8, w, h);
    this.depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.DEPTH_COMPONENT32F, w, h);
    this.fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.resolved = makeTarget(gl, w, h, hdr);
    if (withDepthTexture) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, w, h, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (ok) {
        this.depthTex = tex;
        this.depthFb = fb;
      } else {
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(tex);
      }
    }
  }
  resolve() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (this.depthFb) {
      if (!this.depthChecked) gl.getError(); // clear anything earlier frames left behind
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthFb);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      // a driver that cannot resolve multisampled depth reports it on the first
      // try; checking once avoids a GPU round trip every frame
      if (!this.depthChecked && (this.depthChecked = true) && gl.getError() !== gl.NO_ERROR) {
        gl.deleteFramebuffer(this.depthFb);
        gl.deleteTexture(this.depthTex);
        this.depthFb = null;
        this.depthTex = null;
      }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  dispose() {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fb);
    gl.deleteRenderbuffer(this.color);
    gl.deleteRenderbuffer(this.depth);
    deleteTarget(gl, this.resolved);
    if (this.depthFb) gl.deleteFramebuffer(this.depthFb);
    if (this.depthTex) gl.deleteTexture(this.depthTex);
  }
}
