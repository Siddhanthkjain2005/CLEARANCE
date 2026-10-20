// Keep the cinematic camera in step with variable-height page chapters and
// catch invalid world geometry before it reaches WebGL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approachCamera, environmentCamera, storyPosition } from '../src/web/engine/airspace.ts';
import { waterReflection } from '../src/web/engine/reflection.ts';
import { WATER_LEVEL } from '../src/web/engine/world/terrain.ts';
import { buildAirliner } from '../src/web/engine/models/airliner.ts';
import { LIT_STRIDE, type Geo } from '../src/web/engine/gl.ts';
import { GATES, RUNWAY, pointAt } from '../src/web/engine/path.ts';
import { lookAt, multiply, perspective, transform } from '../src/web/engine/math.ts';
import { buildAirportLights, buildAirportStructures, buildSurfaces, parkedAircraft } from '../src/web/engine/world/airport.ts';
import { buildGroundPropLights, buildGroundProps } from '../src/web/engine/world/props.ts';

test('story follows measured chapter positions and stays on its final airport shot', () => {
  const anchors = [
    { scroll: 0, story: 0 },
    { scroll: 780, story: 1 },
    { scroll: 1360, story: 2 },
    { scroll: 2250, story: 3 },
    { scroll: 6780, story: 9 },
    { scroll: 8060, story: 11.6 },
  ];
  assert.equal(storyPosition(-50, anchors), 0);
  for (const anchor of anchors) assert.equal(storyPosition(anchor.scroll, anchors), anchor.story);
  assert.equal(storyPosition(1070, anchors), 1.5);
  assert.equal(storyPosition(100_000, anchors), 11.6);
  let previous = -1;
  for (let scroll = 0; scroll <= 9000; scroll += 5) {
    const story = storyPosition(scroll, anchors);
    assert.ok(story >= previous, 'scrolling down must never reverse the aircraft');
    previous = story;
  }
});

test('story remains safe before chapter layout exists or at a collapsed section', () => {
  assert.equal(storyPosition(200, []), 0);
  assert.equal(storyPosition(Number.NaN, [{ scroll: 0, story: 0 }]), 0);
  assert.equal(storyPosition(1, [
    { scroll: 0, story: 0 },
    { scroll: 0, story: 1 },
    { scroll: 100, story: 2 },
  ]), 1.01);
});

function validMesh(mesh: Geo, label: string) {
  assert.equal(mesh.data.length % LIT_STRIDE, 0, `${label}: complete vertices`);
  assert.equal(mesh.idx.length % 3, 0, `${label}: complete triangles`);
  assert.ok(mesh.data.every(Number.isFinite), `${label}: finite position, normal and material values`);
  assert.ok(mesh.idx.every((i) => Number.isInteger(i) && i >= 0 && i < mesh.count), `${label}: indices stay within geometry`);
}

test('airport and airliner remain complete real 3D meshes', () => {
  const aircraft = buildAirliner();
  validMesh(aircraft.body, 'airliner body');
  validMesh(aircraft.gear, 'landing gear');
  validMesh(buildAirportStructures(), 'airport');
  assert.ok(aircraft.body.count > 1000, 'the aircraft has a detailed mesh');
  const surfaces = buildSurfaces();
  assert.equal(surfaces.data.length % 6, 0);
  assert.ok(Array.from(surfaces.data).every(Number.isFinite));
  assert.ok(Array.from(surfaces.indices).every((i) => i < surfaces.data.length / 6));
  const lights = buildAirportLights();
  assert.equal(lights.length % 8, 0);
  assert.ok(lights.every(Number.isFinite));
  for (const parked of parkedAircraft()) {
    assert.ok(parked.pos.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...parked.heading) - 1) < 1e-6);
  }
});

test('approach crosses all nine gates and reaches the runway at touchdown', () => {
  assert.equal(GATES.length, 9);
  for (let i = 0; i < GATES.length; i++) {
    const pos = pointAt(i);
    assert.ok(pos.every(Number.isFinite));
    assert.deepEqual(pos, GATES[i]);
  }
  const touchdown = pointAt(7);
  assert.ok(touchdown[0] >= RUNWAY.x0 && touchdown[0] <= RUNWAY.x1);
  assert.ok(Math.abs(touchdown[2]) < RUNWAY.width / 2);
});

test('default approach shows the runway in the exposed desktop viewport', () => {
  const camera = approachCamera();
  const projection = perspective(camera.fov, 1440 / 900, 12, 90_000);
  projection[8] = 360 / 1440;
  const view = multiply(projection, lookAt(camera.eye, camera.target));
  for (const pos of [...GATES, [RUNWAY.x0, RUNWAY.y, 0], [RUNWAY.x1, RUNWAY.y, 0]] as [number, number, number][]) {
    const clip = transform(view, pos);
    const x = (clip[0] / clip[3] * 0.5 + 0.5) * 1440;
    const y = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * 900;
    assert.ok(clip[3] > 0, 'the approach stays ahead of the camera');
    assert.ok(x > 0 && x < 1080, 'gates and runway stay outside the inspector');
    assert.ok(y > 0 && y < 810, 'the approach stays above the bottom telemetry');
  }
});

test('planar reflections stay registered to water with an off-axis console camera', () => {
  const camera = environmentCamera('riverside');
  const projection = perspective(camera.fov, 1440 / 900, 0.4, 90_000);
  projection[8] = 360 / 1440;
  const view = multiply(projection, lookAt(camera.eye, camera.target));
  const reflected = waterReflection(view, camera.eye, WATER_LEVEL);
  assert.equal(reflected.eye[1], 2 * WATER_LEVEL - camera.eye[1]);
  for (const offset of [-150, 0, 150]) {
    const surface: [number, number, number] = [camera.target[0] + offset, WATER_LEVEL, camera.target[2]];
    const original = transform(view, surface);
    const reflection = transform(reflected.matrix, surface);
    for (let axis = 0; axis < 4; axis++) assert.ok(Math.abs(original[axis] - reflection[axis]) < 0.001, 'the shoreline reflection has no camera-shift seam');
    const object: [number, number, number] = [surface[0], 70, surface[2]];
    const mirrored: [number, number, number] = [surface[0], 2 * WATER_LEVEL - 70, surface[2]];
    const a = transform(reflected.matrix, object);
    const b = transform(view, mirrored);
    for (let axis = 0; axis < 4; axis++) assert.ok(Math.abs(a[axis] - b[axis]) < 0.001, 'buildings appear at the physically mirrored position');
  }
});

test('environment cameras put their world subject beside the desktop inspector', () => {
  for (const view of ['airport', 'riverside'] as const) {
    const camera = environmentCamera(view);
    assert.ok(camera.eye.every(Number.isFinite));
    assert.ok(camera.eye[1] > 100 && camera.eye[1] < 800, 'the view is low enough to reveal architecture');
    const projection = perspective(camera.fov, 1440 / 900, 0.4, 90_000);
    projection[8] = 360 / 1440;
    const clip = transform(multiply(projection, lookAt(camera.eye, camera.target)), camera.target);
    const x = (clip[0] / clip[3] * 0.5 + 0.5) * 1440;
    const y = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * 900;
    assert.ok(clip[3] > 0 && x > 100 && x < 980 && y > 180 && y < 680);
  }
});

test('ground objects use valid lit geometry and keep the active runway clear', () => {
  const props = buildGroundProps();
  validMesh(props, 'ground objects');
  assert.ok(props.count > 1000, 'service vehicles and surroundings have actual geometry');
  for (let i = 0; i < props.data.length; i += LIT_STRIDE) {
    const [x, , z] = props.data.slice(i, i + 3);
    assert.ok(x < RUNWAY.x0 || x > RUNWAY.x1 || Math.abs(z) > RUNWAY.width / 2, 'service objects do not block the runway');
  }
  const lights = buildGroundPropLights();
  assert.equal(lights.length % 8, 0);
  assert.ok(lights.length > 0, 'physical ground objects provide lights');
  assert.ok(lights.every(Number.isFinite));
});
