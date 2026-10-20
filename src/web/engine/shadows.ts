// Cascaded sun shadows. At golden hour the sun is eight degrees up, so trees,
// buildings and aircraft throw shadows many times their height; without them
// a lit scene reads as a scale model. Three cascades share one depth atlas:
// a sharp one around the subject, a middle one for the neighbourhood and a
// wide one for hills and the city. Each cascade is a bounding sphere around a
// slice of the camera frustum, snapped to whole texels so shadows don't crawl
// as the camera moves.

import type { GL } from './gl.ts';
import { lookAt, multiply, v3, type Mat4, type Vec3 } from './math.ts';

export const CASCADES = 3;

function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

export interface CameraSlice {
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanY: number; // tan(fovY / 2)
  aspect: number;
}

export class ShadowAtlas {
  readonly size: number;
  readonly tile: number;
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  /** Light view-projection per cascade, for rendering casters. */
  lightVP: Mat4[] = [];
  /** World → atlas (uv, depth) per cascade, for receivers. */
  lookup = new Float32Array(16 * CASCADES);
  /** Far distance of each cascade from the eye; w = 1 when shadows are on. */
  splits = new Float32Array(4);
  /** World-space size of one texel per cascade (for normal-offset bias). */
  texel = new Float32Array(4);
  private gl: GL;

  constructor(gl: GL, size = 4096) {
    this.gl = gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.size = Math.min(size, max);
    this.tile = this.size / 2;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < CASCADES; i++) this.lightVP.push(new Float32Array(16));
  }

  /**
   * Fits the cascades to the camera. `far` are the cascade far distances; the
   * first cascade starts at the eye. `reach` extends each light frustum back
   * toward the sun so tall casters outside the slice still cast into it.
   */
  fit(cam: CameraSlice, sunDir: Vec3, far: number[], reach: number[], which: boolean[] = [true, true, true]) {
    let near = 0;
    for (let i = 0; i < CASCADES; i++) {
      const d0 = near;
      const d1 = far[i];
      near = d1;
      this.splits[i] = d1;
      if (!which[i]) continue;
      // bounding sphere of the frustum slice
      const corners: Vec3[] = [];
      for (const d of [d0, d1]) {
        const c = v3.add(cam.eye, v3.scale(cam.forward, d));
        const hy = d * cam.tanY * 1.08;
        const hx = hy * cam.aspect * 1.08;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) corners.push(v3.add(c, v3.add(v3.scale(cam.right, sx * hx), v3.scale(cam.up, sy * hy))));
      }
      let center: Vec3 = [0, 0, 0];
      for (const p of corners) center = v3.add(center, p);
      center = v3.scale(center, 1 / corners.length);
      let radius = 0;
      for (const p of corners) radius = Math.max(radius, v3.dist(p, center));
      radius = Math.ceil(radius / 8) * 8; // quantised so the texel size is stable
      const texel = (2 * radius) / this.tile;
      // light basis, then snap the centre to whole texels in light space
      const L = v3.norm(sunDir);
      const upHint: Vec3 = Math.abs(L[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      const lx = v3.norm(v3.cross(upHint, L));
      const ly = v3.cross(L, lx);
      const cx = Math.round(v3.dot(center, lx) / texel) * texel;
      const cy = Math.round(v3.dot(center, ly) / texel) * texel;
      const cz = v3.dot(center, L);
      const snapped: Vec3 = v3.add(v3.add(v3.scale(lx, cx), v3.scale(ly, cy)), v3.scale(L, cz));
      const extra = reach[i];
      const view = lookAt(v3.add(snapped, v3.scale(L, radius + extra)), snapped, upHint);
      const proj = ortho(-radius, radius, -radius, radius, 0.5, 2 * radius + extra + 0.5);
      const vp = multiply(proj, view);
      this.lightVP[i] = vp;
      // clip → atlas tile: uv = clip * 0.25 + 0.25 + tile offset, depth = clip * 0.5 + 0.5
      const ox = (i % 2) * 0.5;
      const oy = Math.floor(i / 2) * 0.5;
      const bias = new Float32Array([0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.5, 0, 0.25 + ox, 0.25 + oy, 0.5, 1]);
      this.lookup.set(multiply(bias, vp), i * 16);
      this.splits[i] = d1;
      this.texel[i] = texel;
    }
    this.splits[3] = 1;
  }

  /** Viewport of a cascade's tile in the atlas. */
  viewport(i: number) {
    const gl = this.gl;
    gl.viewport((i % 2) * this.tile, Math.floor(i / 2) * this.tile, this.tile, this.tile);
  }

  dispose() {
    this.gl.deleteFramebuffer(this.fb);
    this.gl.deleteTexture(this.tex);
  }
}
