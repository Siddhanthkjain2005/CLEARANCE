// A planar water reflection keeps shorelines and buildings registered to the
// water surface, even when the console shifts the camera beside its inspector.

import { invert, multiply, type Mat4, type Vec3 } from './math.ts';

export function waterReflection(viewProj: Mat4, eye: Vec3, level: number) {
  const mirror = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * level, 0, 1]);
  const matrix = multiply(viewProj, mirror);
  return { matrix, inverse: invert(matrix), eye: [eye[0], 2 * level - eye[1], eye[2]] as Vec3 };
}
