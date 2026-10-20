// The airspace: a dusk approach into a real-scale airport, rendered with a
// hand-written WebGL2 pipeline.
//
// Every merge request is an airliner. Nine stage gates hang over the approach
// as holographic frames, from 10 km out over the city down to the runway.
// Flights fly the gates as their pipelines progress, make a 360 for spacing
// when a stage runs long, hold in a racetrack when the governor holds them,
// climb away on a go-around, and touch down, roll out and taxi off when they
// land. The landing page drives a scripted flight with the scroll position;
// the console watches live traffic from the tower cab, an approach overview or
// a chase camera.
//
// The world is metre-scale: lofted airliners, terrain with farmland, woods, a
// river and mountains, a city of instanced buildings, the runway with its
// markings and lighting systems, and a dusk sky shared by fog, reflections and
// clouds. It renders into a multisampled HDR target with bloom and ACES tone
// mapping.

import { InstancedLines, Mesh, SceneTarget, canvasTexture, deleteTarget, makeTarget, program, type GL, type Geo, type Program, type Target } from './gl.ts';
import { axisAngle, basisMatrix, clamp, damp, dampV, invert, lookAt, multiply, perspective, rng, smoothstep, transform, translation, v3, type Mat4, type Vec3 } from './math.ts';
import { GATES, GATE_SIZE, PATH_MAX, RUNWAY, goAroundAt, holdingAt, pointAt, tangentAt } from './path.ts';
import * as S from './shaders.ts';
import { AIRFIELD, RIVER, WATER_LEVEL, buildTerrain, buildShoreTerrain, heightAt, riverZ } from './world/terrain.ts';
import { buildWaterGeometry } from './world/hydrology.ts';
import { waterReflection } from './reflection.ts';
import { APRON, TOWER, buildAirportLights, buildAirportStructures, buildSurfaces, parkedAircraft } from './world/airport.ts';
import { buildGroundProps, buildGroundPropLights } from './world/props.ts';
import { ROOF_FLOATS, buildCity, houseRoofs } from './world/city.ts';
import { buildUrbanStructures, buildUrbanLights } from './world/urban.ts';
import { buildShoreObjects } from './world/shore.ts';
import { WINDSOCKS, buildCountryside, buildCountrysideLights, buildRotor, turbines, windsocks, type Turbine } from './world/countryside.ts';
import { RADAR_PIVOT, buildRadarAntenna } from './world/architecture.ts';
import { AIRLINER_LIGHTS, buildAirliner, type Hinged } from './models/airliner.ts';
import { CASCADES, ShadowAtlas } from './shadows.ts';
import { CellInstances, frustumPlanes } from './instancing.ts';
import { FOREST_RECT, FOREST_RES, TREE_VERTEX, buildForestMask, buildTreeMesh, placeFarmLife, placeTrees, type TreeSpecies } from './world/vegetation.ts';
import { FARM_KINDS, type FarmKind } from './world/farmlife.ts';
import * as A from './models/animals.ts';
import { LEAF_ATLAS_SIZE, leafAtlas } from './world/foliage.ts';
import { MOVER_FLOATS, MOVER_KINDS, Traffic, type MoverKind } from './world/traffic.ts';
import * as V from './models/vehicles.ts';
import { Departure } from './departure.ts';
import { buildLandside, buildLandsideLights } from './world/landside.ts';
import { buildVillages, buildVillageLights, chimneyTops } from './world/villages.ts';
import { Train, buildRailway, buildRailwayLights, platformPassengers } from './world/railway.ts';
import { buildMotorway, buildMotorwayLights } from './world/motorway.ts';
import { buildIndustry, buildIndustryLights, plumeSources } from './world/industry.ts';
import { DEPARTURE_STAND, STANDS } from './world/airport.ts';

export type FlightLevel = 'autonomous' | 'supervised' | 'assisted' | 'hold' | null;
export type FlightPhase = 'airborne' | 'holding' | 'landed' | 'go-around' | 'diverted';
export type View = 'story' | 'tower' | 'approach' | 'airport' | 'riverside' | 'follow';

export interface StoryAnchor {
  scroll: number;
  story: number;
}

/** Map page chapters to flight progress without assuming fixed section heights. */
export function storyPosition(scroll: number, anchors: readonly StoryAnchor[]): number {
  if (!anchors.length || !Number.isFinite(scroll)) return 0;
  if (scroll <= anchors[0].scroll) return anchors[0].story;
  for (let i = 1; i < anchors.length; i++) {
    const next = anchors[i];
    const prev = anchors[i - 1];
    if (scroll > next.scroll) continue;
    const t = clamp((scroll - prev.scroll) / Math.max(1, next.scroll - prev.scroll), 0, 1);
    return prev.story + (next.story - prev.story) * t;
  }
  return anchors[anchors.length - 1].story;
}

export interface FlightInput {
  id: string;
  pilot: string;
  phase: FlightPhase;
  progress: number; // 0..9 from the projection
  activeStage: number | null;
  stageStartedAt: number | null; // epoch ms
  level: FlightLevel;
  outcomeAt: number | null; // epoch ms
}

export interface TagPosition {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  altitude: number; // metres
  speed: number; // knots, for the data block
}

export interface GateLabel {
  index: number;
  x: number;
  y: number;
  visible: boolean;
  active: number; // 0..1 how busy the gate is
  distance: number; // metres from the camera
}

export interface HeroInfo {
  x: number;
  y: number;
  visible: boolean;
  altitude: number;
  speed: number;
  gate: number; // index of the next gate, 9 after the last
}

interface Options {
  reducedMotion?: boolean;
  view?: View;
  interactive?: boolean;
  onPick?: (id: string | null) => void;
  onFrame?: (tags: TagPosition[], gates: GateLabel[], hero: HeroInfo | null) => void;
}

/** Clearance colours for trails and data blocks (linear RGB). */
const LEVEL_COLORS: Record<string, Vec3> = {
  autonomous: [0.25, 0.85, 0.95],
  supervised: [1.0, 0.62, 0.2],
  assisted: [0.92, 0.9, 0.84],
  hold: [1.0, 0.25, 0.5],
  pending: [0.55, 0.65, 0.9],
};

/** Airline liveries, primary and accent: Duo agents fly the violet fleet, people fly the rest. */
const AGENT_LIVERIES: [Vec3, Vec3][] = [
  [[0.2, 0.07, 0.5], [0.98, 0.4, 0.1]],
  [[0.3, 0.09, 0.58], [0.95, 0.62, 0.14]],
  [[0.13, 0.06, 0.36], [0.45, 0.8, 0.95]],
];
const HUMAN_LIVERIES: [Vec3, Vec3][] = [
  [[0.03, 0.08, 0.3], [0.85, 0.08, 0.1]],
  [[0.55, 0.04, 0.06], [0.95, 0.72, 0.2]],
  [[0.02, 0.28, 0.3], [0.85, 0.85, 0.82]],
  [[0.8, 0.3, 0.03], [0.05, 0.1, 0.32]],
  [[0.04, 0.22, 0.1], [0.82, 0.78, 0.2]],
  [[0.1, 0.3, 0.65], [0.55, 0.85, 0.98]],
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function liveryPair(pilot: string): [Vec3, Vec3] {
  const agent = /^ai-|duo|bot$/i.test(pilot);
  const list = agent ? AGENT_LIVERIES : HUMAN_LIVERIES;
  return list[hashString(pilot) % list.length];
}

export function liveryFor(pilot: string): Vec3 {
  return liveryPair(pilot)[0];
}

/** Titles and the tail logo, drawn once into a texture the livery shader reads. */
function liveryCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, 1024, 256);
  x.fillStyle = '#f00';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = '600 150px "Geist", "Helvetica Neue", Arial, sans-serif';
  x.fillText('clearance', 384, 136);
  // tail logo: two nested chevrons, as on the wordmark
  x.strokeStyle = '#0f0';
  x.lineCap = 'round';
  x.lineJoin = 'round';
  x.lineWidth = 26;
  x.beginPath();
  x.moveTo(800, 170); x.lineTo(896, 74); x.lineTo(992, 170);
  x.stroke();
  x.globalAlpha = 0.85;
  x.beginPath();
  x.moveTo(846, 214); x.lineTo(896, 164); x.lineTo(946, 214);
  x.stroke();
  return c;
}

/** A hinged part's model matrix inside its aircraft at extension e (0..1). */
function hingeMatrix(h: Hinged, e: number): Mat4 {
  const slide = translation(v3.scale(h.slide, e));
  const toOrigin = translation(h.origin);
  const back = translation(v3.scale(h.origin, -1));
  return multiply(slide, multiply(toOrigin, multiply(axisAngle(h.axis, h.angle * e), back)));
}

const SUN_DIR = v3.norm([-0.95, 0.14, 0.3]);
const SUN_COLOR: Vec3 = [1.7, 1.12, 0.68];
const FOG = 3.8e-5;
const TRAIL = 90;
/** Instanced trees stop here; the terrain paints the canopy beyond. */
const TREE_RANGE = 5200;
const TREE_NEAR = 850;
const TREE_MID = 2400;
/** Livestock and bales are drawn this far out (they are a pixel or two beyond). */
const FARM_RANGE = 2200;
const FOLIAGE: Record<TreeSpecies, { leaf: Vec3; bark: Vec3 }> = {
  oak: { leaf: [0.1, 0.145, 0.05], bark: [0.1, 0.085, 0.07] },
  birch: { leaf: [0.14, 0.175, 0.065], bark: [0.42, 0.4, 0.37] },
  pine: { leaf: [0.06, 0.1, 0.052], bark: [0.17, 0.1, 0.065] },
  spruce: { leaf: [0.045, 0.085, 0.055], bark: [0.1, 0.08, 0.06] },
  poplar: { leaf: [0.11, 0.16, 0.058], bark: [0.2, 0.19, 0.17] },
  hedge: { leaf: [0.075, 0.118, 0.042], bark: [0.08, 0.068, 0.052] },
};
const TOWER_EYE: Vec3 = [TOWER.x - 15, TOWER.cab + 2.5, TOWER.z - 3];
const GROUND_Y = 3.6;

/** Appends one thick-line segment: A, B, colour, alpha at each end, width in CSS px. */
function seg(out: number[], a: Vec3, b: Vec3, c: Vec3, alphaA: number, alphaB: number, width: number) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], alphaA, alphaB, width);
}

/** Appends a glow quad (two triangles): corners a b c d with uvs (0,0) (1,0) (1,1) (0,1). */
function glowQuad(out: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, rgb: Vec3, intensity: number, uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const v = (p: Vec3, uv: [number, number]) => out.push(p[0], p[1], p[2], rgb[0], rgb[1], rgb[2], intensity, uv[0], uv[1]);
  v(a, uvs[0]); v(b, uvs[1]); v(c, uvs[2]);
  v(a, uvs[0]); v(c, uvs[2]); v(d, uvs[3]);
}

interface Pose {
  pos: Vec3;
  heading: Vec3; // flat, unit
  pitch: number;
  bank: number;
}

interface FlightState {
  id: string;
  input: FlightInput;
  display: number;
  speed: number; // progress units per second
  pos: Vec3;
  heading: Vec3;
  pitch: number;
  bank: number;
  vel: Vec3;
  hold: number;
  holdPhase: number;
  orbit: { theta: number; center: Vec3; start: Vec3; fwd: Vec3; side: Vec3; radius: number } | null;
  escape: number;
  escapeFrom: Vec3 | null;
  escapeDir: Vec3 | null;
  alpha: number;
  color: Vec3;
  tint: Vec3;
  gear: number;
  tint2: Vec3;
  flaps: number;
  spoilers: number;
  fan: number;
  fanSpeed: number;
  trail: Float32Array;
  trailLen: number;
  trailTimer: number;
  gone: boolean;
  touchedDown: boolean;
  matrix: Mat4;
  scale: number;
  /** Scenery traffic (the airport's own departures): no trail, tag or gate. */
  ambient?: { beacon: boolean; strobes: boolean; landing: boolean; taxi: boolean };
}

interface Smoke {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
  /** Wood smoke from a cottage chimney: slow, thin and blue-grey. */
  wood?: boolean;
}

interface Rig {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

/** Aim diagonally across the runway so both the airport and all nine gates fit
 * beside the console inspector, rather than putting the airport behind it. */
export function approachCamera(yawOffset = 0, pitchOffset = 0, zoom = 1): Rig {
  const target: Vec3 = [450, 140, -150];
  const yaw = -0.72 + yawOffset;
  const pitch = clamp(0.42 + pitchOffset, 0.05, 1.4);
  const dist = 7000 * zoom;
  return {
    eye: v3.add(target, [Math.cos(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, -Math.sin(yaw) * Math.cos(pitch) * dist]),
    target,
    fov: 0.72,
  };
}

/** Lower, dedicated views make the airport architecture and water legible. */
export function environmentCamera(view: 'airport' | 'riverside', yawOffset = 0, pitchOffset = 0, zoom = 1): Rig {
  const airport = view === 'airport';
  const target: Vec3 = airport ? [1530, 18, 430] : [-4600, 10, riverZ(-4600)];
  const yaw = (airport ? -1.07 : 0.57) + yawOffset;
  const pitch = clamp((airport ? 0.23 : 0.20) + pitchOffset, 0.04, 1.35);
  const distance = (airport ? 1100 : 1310) * zoom;
  return {
    eye: v3.add(target, [Math.cos(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.sin(yaw) * Math.cos(pitch) * distance]),
    target,
    fov: airport ? 0.70 : 0.76,
  };
}

/** Camera shots for the scripted story flight, in the aircraft's flat frame (forward, up, right). */
interface Shot {
  eye: Vec3;
  look: Vec3;
  fov: number;
  world?: { eye: Vec3; look?: Vec3 };
}

const SHOTS: Shot[] = [
  { eye: [150, 10, -80], look: [-20, 6, 8], fov: 30 }, // hero: ahead-left, looking back into the sunset
  { eye: [30, -6, -105], look: [12, 2, 0], fov: 38 }, // plan: abeam, the city below
  { eye: [-95, 20, 26], look: [60, -8, 0], fov: 44 }, // create: chase from above right
  { eye: [-24, -26, -62], look: [16, 6, 0], fov: 42 }, // verify: from below, looking up at the belly
  { eye: [95, 4, 58], look: [0, 1, 0], fov: 36 }, // package: front quarter
  { eye: [-60, 150, -70], look: [60, 0, 0], fov: 46 }, // secure: high above, the tunnel of gates
  { eye: [-62, 9, -24], look: [260, -24, 0], fov: 46 }, // release: chase, the approach lights ahead
  { eye: [-34, 8.5, 0], look: [420, -28, 0], fov: 52 }, // configure: over the cabin roof toward the runway
  { eye: [0, 0, 0], look: [0, 0, 0], fov: 34, world: { eye: [470, 2.2, -62] } }, // monitor: touchdown, from the runway edge
  { eye: [-58, 4.5, 14], look: [120, 0, 0], fov: 50 }, // govern: rollout chase
  { eye: [0, 0, 0], look: [0, 0, 0], fov: 46, world: { eye: [3000, 220, 1100], look: [1450, 12, 355] } }, // after landing: crane over the terminal and apron
];

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

function numbersCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, 512, 256);
  x.fillStyle = '#fff';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = 'bold 230px "Arial Narrow", "Roboto Condensed", Arial, sans-serif';
  // designators are drawn tall and narrow, as painted on a runway
  x.save();
  x.scale(0.62, 1);
  x.fillText('09', 128 / 0.62, 132);
  x.fillText('27', 384 / 0.62, 132);
  x.restore();
  return c;
}

export class Airspace {
  private gl: GL;
  private canvas: HTMLCanvasElement;
  private opts: Options;
  private hdr: boolean;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private raf = 0;
  private last = 0;
  private time = 0;
  private disposed = false;
  private slowFrames = 0;
  private quality = 1;
  /** 2: every effect; 1: no ambient occlusion or depth of field; 0: also no reflections or grass. */
  private effects = 2;

  private p: Record<string, Program> = {};
  private emptyVao: WebGLVertexArrayObject;
  private numbersTex: WebGLTexture;
  private forestTex: WebGLTexture;
  private leafTex: WebGLTexture;
  private shadows: ShadowAtlas;
  private shadowFrame = 0;
  private fovY = 0.8;
  /** Per species: full detail near, low detail mid-distance, a thinned set far away. */
  private trees: { species: TreeSpecies; hi: CellInstances; lo: CellInstances; sparse: CellInstances }[] = [];
  /** Bales, silage, cattle and sheep in the fields near the approach. */
  private farm: CellInstances[] = [];

  private terrain: Mesh;
  private shoreTerrain: Mesh;
  private surfaces: Mesh;
  private structures: Mesh;
  private groundProps: Mesh;
  private urban: Mesh;
  private shore: Mesh;
  private city: Mesh;
  private roofs: Mesh;
  private water: Mesh;
  private clouds: Mesh;
  private body: Mesh;
  private gearMesh: Mesh;
  private flapParts: { mesh: Mesh; h: Hinged }[] = [];
  private spoilerParts: { mesh: Mesh; h: Hinged }[] = [];
  private fanMesh: Mesh;
  private fanCenters: Vec3[] = [];
  private liveryTex: WebGLTexture;
  private countryside: Mesh;
  private socks: Mesh;
  private landside: Mesh;
  private motorway: Mesh;
  private industry: Mesh;
  private plumes: { pos: Vec3; size: number; rate: number; steam: boolean; wood?: boolean }[] = plumeSources();
  private steam: Smoke[] = [];
  private plumeClock = 0;
  private villageMesh: Mesh;
  private railway: Mesh;
  private trains: Train[] = [];
  private birdMesh: Mesh;
  private boats = new Float32Array(32);
  private rotor: Mesh;
  private radarAntenna: Mesh;
  private turbineList: Turbine[] = [];
  private grassTuft: Mesh;
  private vapour: Smoke[] = [];
  private staticPoints: Mesh;
  private dynPoints: Mesh;
  private smokePoints: Mesh;
  private gateLines: InstancedLines;
  private dynLines: InstancedLines;
  private contrailLines: InstancedLines;
  private gatePanels: Mesh;
  private beams: Mesh;

  private scene: SceneTarget | null = null;
  private reflection: SceneTarget | null = null;
  private reflected = waterReflection(new Float32Array(16), [0, 0, 0], WATER_LEVEL);
  private reflectionAt = -1;
  private reflectionActive = false;
  private mips: Target[] = [];
  private raysTarget: Target | null = null;
  private aoTarget: Target | null = null;
  private aoBlurTarget: Target | null = null;
  private dofTarget: Target | null = null;
  private proj: Mat4 = new Float32Array(16);
  private invProj: Mat4 = new Float32Array(16);

  private parked: { matrix: Mat4; tint: Vec3; tint2: Vec3 }[] = [];
  /** Instanced ground and water traffic, one mesh per model. */
  private movers = new Map<MoverKind, Mesh>();
  private moverCount = new Map<MoverKind, number>();
  private traffic: Traffic;
  private trafficLights: number[] = [];
  private departure = new Departure('parked', 30);
  private depFlight: FlightState;
  private floods = new Float32Array(48);
  private spots = new Float32Array(24);
  private spotDirs = new Float32Array(24);

  private flights = new Map<string, FlightState>();
  private smoke: Smoke[] = [];
  private selected: string | null = null;
  private gateHeat = new Float32Array(9);
  private gateFlash = new Float32Array(9);

  // story flight
  private storyGoal = 0;
  private story = 0;
  private hero: FlightState;
  private heroPrev = -2;

  // camera
  private view: View;
  private rig: Rig;
  private userYaw = 0;
  private userPitch = 0;
  private userZoom = 1;
  private towerYaw: number;
  private towerPitch: number;
  private viewProj: Mat4 = new Float32Array(16);
  private viewMatrix: Mat4 = new Float32Array(16);
  private invViewProj: Mat4 = new Float32Array(16);
  private eye: Vec3 = [0, 0, 0];
  private fov = 0.8;
  private dim = 1;
  private dimGoal = 1;
  private offsetX = 0;
  private offsetGoal = 0;
  private cut = true;

  private drag: { x: number; y: number; moved: boolean; id: number } | null = null;
  private observer: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, opts: Options = {}) {
    this.canvas = canvas;
    this.opts = opts;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    const P = (name: string, vs: string, fs: string) => { this.p[name] = program(gl, vs, fs); };
    P('sky', S.FULLSCREEN_VS, S.SKY_FS);
    P('lit', S.LIT_VS, S.LIT_FS);
    P('tree', S.TREE_VS, S.TREE_FS);
    P('depthLit', S.LIT_VS, S.DEPTH_FS);
    P('depthCity', S.CITY_VS, S.DEPTH_FS);
    P('depthTree', S.TREE_VS, S.DEPTH_FS);
    P('depthTerrain', S.TERRAIN_VS, S.DEPTH_FS);
    P('terrain', S.TERRAIN_VS, S.TERRAIN_FS);
    P('surface', S.SURFACE_VS, S.SURFACE_FS);
    P('city', S.CITY_VS, S.CITY_FS);
    P('roof', S.ROOF_VS, S.ROOF_FS);
    P('depthRoof', S.ROOF_VS, S.DEPTH_FS);
    P('water', S.WATER_VS, S.WATER_FS);
    P('cloud', S.CLOUD_VS, S.CLOUD_FS);
    P('points', S.POINTS_VS, S.POINTS_FS);
    P('lines', S.LINES_VS, S.LINES_FS);
    P('glow', S.GLOW_VS, S.GLOW_FS);
    P('bright', S.FULLSCREEN_VS, S.BRIGHT_FS);
    P('down', S.FULLSCREEN_VS, S.DOWN_FS);
    P('up', S.FULLSCREEN_VS, S.UP_FS);
    P('comp', S.FULLSCREEN_VS, S.COMPOSITE_FS);
    P('rays', S.FULLSCREEN_VS, S.RAYS_FS);
    P('grass', S.GRASS_VS, S.GRASS_FS);
    P('ssao', S.FULLSCREEN_VS, S.SSAO_FS);
    P('aoblur', S.FULLSCREEN_VS, S.AO_BLUR_FS);
    P('dof', S.FULLSCREEN_VS, S.DOF_FS);
    P('mover', S.MOVER_VS, S.LIT_FS);
    P('bird', S.BIRD_VS, S.BIRD_FS);
    P('depthMover', S.MOVER_VS, S.DEPTH_FS);
    this.emptyVao = gl.createVertexArray()!;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.numbersTex = canvasTexture(gl, numbersCanvas());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // world geometry
    const t = buildTerrain(opts.reducedMotion ? 240 : 300);
    this.terrain = new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], t.data, t.indices);
    const banks = buildShoreTerrain();
    this.shoreTerrain = new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], banks.data, banks.indices);
    const sfc = buildSurfaces();
    this.surfaces = new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], sfc.data, sfc.indices);
    this.structures = Mesh.lit(gl, buildAirportStructures());
    this.countryside = Mesh.lit(gl, buildCountryside());
    const sock = windsocks(0);
    this.socks = new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 3 }, { loc: 3, size: 2 }], new Float32Array(sock.data), new Uint16Array(sock.idx), gl.DYNAMIC_DRAW);
    this.landside = Mesh.lit(gl, buildLandside());
    this.motorway = Mesh.lit(gl, buildMotorway());
    this.industry = Mesh.lit(gl, buildIndustry());
    // a few cottages have the fire lit
    const chimneys = chimneyTops();
    for (let i = 0; i < chimneys.length; i += 7) this.plumes.push({ pos: chimneys[i], size: 1.6, rate: 0.45, steam: false, wood: true });
    // the plumes are already drifting when the page opens
    for (let i = 0; i < 220; i++) this.stepPlumes(0.5);
    this.villageMesh = Mesh.lit(gl, buildVillages());
    this.railway = Mesh.lit(gl, buildRailway());
    this.rotor = Mesh.lit(gl, buildRotor());
    this.radarAntenna = Mesh.lit(gl, buildRadarAntenna());
    this.turbineList = turbines();
    this.grassTuft = buildGrassTuft(gl);
    this.birdMesh = buildBird(gl);

    this.groundProps = Mesh.lit(gl, buildGroundProps());
    this.urban = Mesh.lit(gl, buildUrbanStructures());
    this.shore = Mesh.lit(gl, buildShoreObjects());
    this.city = this.buildCityMesh();
    this.roofs = this.buildRoofMesh();

    // woods: one density field for the 3D trees and the painted canopy beyond them
    const mask = buildForestMask();
    this.forestTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.forestTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FOREST_RES, FOREST_RES, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // leaf sprays for the near crowns, mipmapped for alpha-to-coverage
    this.leafTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.leafTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LEAF_ATLAS_SIZE, LEAF_ATLAS_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, leafAtlas());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const treeVertex = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 2 }, { loc: 3, size: 2 }, { loc: 6, size: 3 }];
    const treeInstance = [{ loc: 4, size: 4 }, { loc: 5, size: 4 }];
    for (const set of placeTrees(mask)) {
      if (!set.count) continue;
      const hiMesh = buildTreeMesh(set.species, 0);
      const loMesh = buildTreeMesh(set.species, 1);
      // every third tree, a little wider, stands in for the wood at a distance
      const thin: number[] = [];
      // hedges stop with the mid-distance trees: beyond, the painted hedge lines carry them
      for (let i = 0; set.species !== 'hedge' && i < set.count; i += 3) {
        const o = i * 8;
        void TREE_VERTEX;
        thin.push(set.data[o], set.data[o + 1], set.data[o + 2], set.data[o + 3], set.data[o + 4] * 1.45, set.data[o + 5] * 1.05, set.data[o + 6], set.data[o + 7]);
      }
      this.trees.push({
        species: set.species,
        hi: new CellInstances(gl, hiMesh, treeVertex, set.data, treeInstance, 420, 30),
        lo: new CellInstances(gl, loMesh, treeVertex, set.data, treeInstance, 420, 30),
        sparse: new CellInstances(gl, loMesh, treeVertex, new Float32Array(thin), treeInstance, 420, 30),
      });
    }
    // life in the fields, instanced and culled like the trees
    const farm = placeFarmLife(mask);
    const farmModels: Record<FarmKind, Geo> = { bale: A.roundBale(false), wrapped: A.roundBale(true), cow: A.cow(), cowLying: A.cowLying(), sheep: A.sheep() };
    const litVertex = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 3 }, { loc: 3, size: 2 }];
    const moverInstance = [{ loc: 4, size: 4 }, { loc: 5, size: 4 }];
    for (const k of FARM_KINDS) {
      if (!farm[k].length) continue;
      const g = farmModels[k];
      this.farm.push(new CellInstances(gl, { data: new Float32Array(g.data), indices: new Uint16Array(g.idx) }, litVertex, farm[k], moverInstance, 300, 3));
    }
    this.shadows = new ShadowAtlas(gl, opts.reducedMotion ? 2048 : 4096);
    this.water = this.buildWater();
    const C = 60000;
    this.clouds = new Mesh(gl, [{ loc: 0, size: 3 }], new Float32Array([-C, 3300, -C, C, 3300, -C, C, 3300, C, -C, 3300, C]), new Uint16Array([0, 2, 1, 0, 3, 2]));
    const plane = buildAirliner();
    this.body = Mesh.lit(gl, plane.body);
    this.gearMesh = Mesh.lit(gl, plane.gear);
    this.flapParts = plane.flaps.map((h) => ({ mesh: Mesh.lit(gl, h.geo), h }));
    this.spoilerParts = plane.spoilers.map((h) => ({ mesh: Mesh.lit(gl, h.geo), h }));
    this.fanMesh = Mesh.lit(gl, plane.fan);
    this.fanCenters = plane.fanCenters;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.liveryTex = canvasTexture(gl, liveryCanvas());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const pointAttrs = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 1 }, { loc: 3, size: 1 }];
    const cityData = buildCity();
    this.city.setInstances(cityData.buildings, cityData.count);
    const roofData = houseRoofs(cityData);
    this.roofs.setInstances(roofData, roofData.length / ROOF_FLOATS);
    this.staticPoints = new Mesh(gl, pointAttrs, new Float32Array([...buildAirportLights(), ...buildGroundPropLights(), ...buildUrbanLights(), ...buildCountrysideLights(), ...buildLandsideLights(), ...buildMotorwayLights(), ...buildIndustryLights(), ...buildVillageLights(), ...buildRailwayLights(), ...cityData.lights]));
    this.dynPoints = new Mesh(gl, pointAttrs, null, null, gl.DYNAMIC_DRAW);
    this.smokePoints = new Mesh(gl, pointAttrs, null, null, gl.DYNAMIC_DRAW);
    this.gateLines = new InstancedLines(gl);
    this.dynLines = new InstancedLines(gl);
    this.contrailLines = new InstancedLines(gl);
    const glowAttrs = [{ loc: 0, size: 3 }, { loc: 1, size: 4 }, { loc: 2, size: 2 }];
    this.gatePanels = new Mesh(gl, glowAttrs, null, null, gl.DYNAMIC_DRAW);
    this.beams = new Mesh(gl, glowAttrs, null, null, gl.DYNAMIC_DRAW);

    parkedAircraft().forEach((a, i) => {
      const pair = (i % 3 === 0 ? AGENT_LIVERIES : HUMAN_LIVERIES)[(i * 7) % (i % 3 === 0 ? AGENT_LIVERIES.length : HUMAN_LIVERIES.length)];
      this.parked.push({ matrix: basisMatrix(v3.add(a.pos, [0, RUNWAY.y, 0]), a.heading, [0, 1, 0]), tint: pair[0], tint2: pair[1] });
    });
    let fi = 0;
    for (let x = APRON.x0 + 40; x < APRON.x1 && fi < 12; x += 160, fi++) this.floods.set([x, 28, APRON.z0 + 30, 0.22], fi * 4);

    // traffic: one instanced mesh per vehicle, train and boat model
    const models: Record<MoverKind, () => Geo> = {
      sedan: () => V.car('sedan'), hatch: () => V.car('hatch'), suv: () => V.car('suv'), carlod: V.carLod, van: V.van, lorry: V.lorry,
      bus: () => V.bus(false), coach: () => V.bus(true), tug: V.tug, cart: () => V.cart(false), uld: () => V.cart(true),
      pushback: V.pushback, fuel: V.fuelTruck, catering: V.cateringTruck, loader: V.beltLoader, followme: V.followMe, apronbus: V.apronBus,
      traincab: () => V.trainCar(true, false), traincar: () => V.trainCar(false, false), trainpanto: () => V.trainCar(false, true),
      barge: V.barge, boat: V.boat, sailboat: V.sailboat, person: V.person,
    };
    const inst = [{ loc: 4, size: 4 }, { loc: 5, size: 4 }];
    for (const k of MOVER_KINDS) this.movers.set(k, Mesh.lit(gl, models[k](), inst));
    this.traffic = new Traffic(!!opts.reducedMotion);
    const coats: Vec3[] = [[0.05, 0.05, 0.06], [0.2, 0.05, 0.05], [0.08, 0.12, 0.25], [0.35, 0.3, 0.22], [0.25, 0.26, 0.27], [0.5, 0.48, 0.45]];
    this.traffic.addParked(platformPassengers().map((p, i) => ({ kind: 'person' as MoverKind, x: p.x, y: p.y, z: p.z, heading: p.heading, color: coats[i % coats.length] })));
    const first = new Train(0);
    this.trains = [first, new Train(first.period * 0.52)];
    const dep = this.departure.state;
    this.depFlight = this.newFlight({ id: 'DEP', pilot: 'ground', phase: 'airborne', progress: 9, activeStage: null, stageStartedAt: null, level: null, outcomeAt: null }, 9);
    this.depFlight.ambient = { beacon: false, strobes: false, landing: false, taxi: false };
    [this.depFlight.tint, this.depFlight.tint2] = HUMAN_LIVERIES[2 % HUMAN_LIVERIES.length];
    this.depFlight.pos = dep.pos;

    this.hero = this.newFlight({ id: 'CLR-1', pilot: 'ai-clearance-dispatch', phase: 'airborne', progress: 0, activeStage: 0, stageStartedAt: null, level: 'autonomous', outcomeAt: null }, -1.2);
    this.hero.alpha = 1;

    this.view = opts.view ?? 'tower';
    const toApron = v3.norm(v3.sub([1450, 12, 260], TOWER_EYE));
    this.towerYaw = Math.atan2(toApron[2], toApron[0]);
    this.towerPitch = Math.asin(toApron[1]);
    this.rig = this.goalRig(0);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.bindInput();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    (window as unknown as { __airspace?: Airspace }).__airspace = this;
  }

  // ------------------------------------------------------------ public API

  setFlights(list: FlightInput[]) {
    const now = Date.now();
    const keep = new Set<string>();
    for (const f of list) {
      keep.add(f.id);
      let s = this.flights.get(f.id);
      if (!s) {
        s = this.newFlight(f, Math.max(-0.9, Math.min(f.progress, 9) - 0.7));
        if (f.outcomeAt && now - f.outcomeAt > 20_000) s.gone = true;
        if (f.phase === 'landed') s.display = f.outcomeAt && now - f.outcomeAt > 20_000 ? PATH_MAX - 0.3 : 8.4;
        this.flights.set(f.id, s);
      }
      s.input = f;
      [s.tint, s.tint2] = liveryPair(f.pilot);
    }
    for (const [id, s] of this.flights) if (!keep.has(id)) s.gone = true;
  }

  select(id: string | null) {
    this.selected = id;
  }

  setView(v: View) {
    if (v === this.view) return;
    this.view = v;
    this.userYaw = 0;
    this.userPitch = 0;
    this.userZoom = 1;
  }

  /** Backwards-compatible alias used by older callers. */
  setPreset(p: string) {
    this.setView(p === 'hero' ? 'story' : p === 'overview' ? 'approach' : (p as View));
  }

  /** Story position in chapters: 0 hero, 1..9 the nine gates, 10 rollout, 11+ the airport. */
  setStory(s: number) {
    this.storyGoal = Number.isFinite(s) ? clamp(s, 0, 12) : 0;
  }

  setInteractive(on: boolean) {
    this.opts.interactive = on;
    this.canvas.style.cursor = on ? 'grab' : '';
  }

  setDim(d: number) {
    this.dimGoal = d;
  }

  setViewOffset(px: number) {
    this.offsetGoal = px;
  }

  /** Jump straight to the current goals (screenshots, reduced motion). */
  snap() {
    this.cut = true;
  }

  /** Development hook for screenshots: an explicit camera. */
  debugCamera(eye: Vec3, target: Vec3, fovDeg = 45) {
    this.debugRig = { eye, target, fov: (fovDeg * Math.PI) / 180 };
    this.cut = true;
  }
  private debugRig: Rig | null = null;

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unbindInput();
    this.scene?.dispose();
    this.reflection?.dispose();
    for (const m of this.mips) deleteTarget(this.gl, m);
    for (const t of this.trees) { t.hi.dispose(); t.lo.dispose(); t.sparse.dispose(); }
    for (const f of this.farm) f.dispose();
    for (const m of this.movers.values()) {
      this.gl.deleteVertexArray(m.vao);
      this.gl.deleteBuffer(m.vbo);
      if (m.ibo) this.gl.deleteBuffer(m.ibo);
      if (m.inst) this.gl.deleteBuffer(m.inst);
    }
    this.shadows.dispose();
    this.gl.deleteTexture(this.forestTex);
    this.gl.deleteTexture(this.leafTex);
    for (const mesh of [this.terrain, this.shoreTerrain, this.surfaces, this.structures, this.groundProps, this.urban, this.shore, this.countryside, this.socks, this.landside, this.motorway, this.industry, this.villageMesh, this.railway, this.birdMesh, this.rotor, this.radarAntenna, this.fanMesh, this.city, this.roofs, this.water, this.clouds, this.body, this.gearMesh, this.staticPoints, this.dynPoints, this.smokePoints, this.gatePanels, this.beams]) {
      this.gl.deleteVertexArray(mesh.vao);
      this.gl.deleteBuffer(mesh.vbo);
      this.gl.deleteBuffer(mesh.ibo);
      this.gl.deleteBuffer(mesh.inst);
    }
    this.gl.deleteTexture(this.numbersTex);
    this.gl.deleteVertexArray(this.emptyVao);
    for (const p of Object.values(this.p)) this.gl.deleteProgram(p.prog);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ------------------------------------------------------------ construction

  private newFlight(f: FlightInput, start: number): FlightState {
    const p = pointAt(start);
    const t = tangentAt(start);
    return {
      id: f.id, input: f, display: start, speed: 0.05, pos: p, heading: v3.norm([t[0], 0, t[2]]), pitch: 0.05, bank: 0, vel: [0, 0, 0],
      hold: 0, holdPhase: Math.random(), orbit: null, escape: 0, escapeFrom: null, escapeDir: null,
      alpha: 0, color: LEVEL_COLORS[f.level ?? 'pending'] ?? LEVEL_COLORS.pending, tint: liveryPair(f.pilot)[0], tint2: liveryPair(f.pilot)[1], gear: start > 4.6 ? 1 : 0,
      flaps: start > 3 ? 1 : 0, spoilers: 0, fan: Math.random() * 6, fanSpeed: 6,
      trail: new Float32Array(TRAIL * 3), trailLen: 0, trailTimer: 0, gone: false, touchedDown: start >= 7, matrix: new Float32Array(16), scale: 1,
    };
  }

  private buildCityMesh(): Mesh {
    const gl = this.gl;
    const data: number[] = [];
    const idx: number[] = [];
    const face = (pts: Vec3[], n: Vec3) => {
      const b = data.length / 6;
      for (const p of pts) data.push(p[0], p[1], p[2], n[0], n[1], n[2]);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const a = -0.5;
    const z = 0.5;
    face([[a, 0, z], [z, 0, z], [z, 1, z], [a, 1, z]], [0, 0, 1]);
    face([[z, 0, a], [a, 0, a], [a, 1, a], [z, 1, a]], [0, 0, -1]);
    face([[z, 0, z], [z, 0, a], [z, 1, a], [z, 1, z]], [1, 0, 0]);
    face([[a, 0, a], [a, 0, z], [a, 1, z], [a, 1, a]], [-1, 0, 0]);
    face([[a, 1, z], [z, 1, z], [z, 1, a], [a, 1, a]], [0, 1, 0]);
    return new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], new Float32Array(data), new Uint16Array(idx), gl.STATIC_DRAW, [{ loc: 4, size: 4 }, { loc: 5, size: 3 }]);
  }

  /** The unit pitched roof fitted to each house by ROOF_VS (faces tagged in normal.x). */
  private buildRoofMesh(): Mesh {
    const data: number[] = [];
    const idx: number[] = [];
    const face = (id: number, pts: Vec3[]) => {
      const b = data.length / 6;
      for (const p of pts) data.push(p[0], p[1], p[2], id, 0, 0);
      idx.push(b, b + 1, b + 2);
      if (pts.length === 4) idx.push(b, b + 2, b + 3);
    };
    face(0, [[-0.5, 0, 0.5], [0.5, 0, 0.5], [1, 1, 0], [-1, 1, 0]]);
    face(1, [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-1, 1, 0], [1, 1, 0]]);
    face(2, [[0.5, 0, 0.5], [0.5, 0, -0.5], [1, 1, 0]]);
    face(3, [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-1, 1, 0]]);
    face(4, [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]]);
    return new Mesh(this.gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], new Float32Array(data), new Uint16Array(idx), this.gl.STATIC_DRAW, [{ loc: 4, size: 4 }, { loc: 5, size: 4 }]);
  }

  private buildWater(): Mesh {
    const { data, indices } = buildWaterGeometry();
    return new Mesh(this.gl, [{ loc: 0, size: 3 }], data, indices);
  }

  // ------------------------------------------------------------ simulation

  private targetProgress(f: FlightInput, now: number): number {
    if (f.phase === 'landed') return PATH_MAX;
    if (f.activeStage !== null) {
      const age = f.stageStartedAt ? (now - f.stageStartedAt) / 1000 : 0;
      return f.activeStage + 0.15 + 0.7 * (1 - Math.exp(-age / 9));
    }
    return Math.min(9, f.progress);
  }

  /** Top speed along the path in progress units per second (time-lapsed, ~150 m/s aloft). */
  private static vmax(p: number): number {
    if (p < 6) return 0.1;
    if (p < 7) return 0.075;
    if (p < 8.2) return 0.06;
    return 0.04;
  }

  private step(dt: number) {
    const now = Date.now();
    this.gateHeat.fill(0);
    for (let k = 0; k < 9; k++) this.gateFlash[k] = Math.max(0, this.gateFlash[k] - dt * 0.8);
    for (const [id, s] of this.flights) {
      const f = s.input;
      const prevPos = s.pos;
      const target = this.targetProgress(f, now);
      const escaping = f.phase === 'go-around' || f.phase === 'diverted';

      // along the path: accelerate toward a speed that closes on the target
      if (!s.orbit && !escaping) {
        const want = clamp((target - s.display) * 0.35, 0, Airspace.vmax(s.display));
        s.speed = damp(s.speed, want, 1.2, dt);
        s.display = Math.min(PATH_MAX, s.display + s.speed * dt);
        // a stage running long while airborne: make a 360 for spacing
        if (s.display < 6.2 && s.display > -0.5 && want < 0.012 && f.phase === 'airborne' && s.hold < 0.05 && s.alpha > 0.5) {
          const t = tangentAt(s.display);
          const fwd = v3.norm([t[0], 0, t[2]]);
          const side = v3.norm(v3.cross(fwd, [0, 1, 0]));
          const radius = 650 - s.display * 50;
          const start = pointAt(s.display);
          s.orbit = { theta: 0, start, fwd, side, radius, center: v3.add(start, v3.scale(side, radius)) };
        }
      }
      let pos = pointAt(s.display);
      if (s.orbit) {
        const o = s.orbit;
        o.theta += (dt * 150) / o.radius;
        const th = Math.min(o.theta, Math.PI * 2);
        pos = v3.add(o.center, v3.add(v3.scale(o.side, -Math.cos(th) * o.radius), v3.scale(o.fwd, Math.sin(th) * o.radius)));
        if (o.theta >= Math.PI * 2) s.orbit = null;
      }

      const holding = f.phase === 'holding';
      s.hold = damp(s.hold, holding ? 1 : 0, 0.5, dt);
      if (s.hold > 0.001) {
        s.holdPhase += dt / 70;
        const hp = holdingAt(clamp(s.display, 0, 6), s.holdPhase);
        pos = v3.lerp(pos, hp.pos, smoothstep(0, 1, s.hold));
      }

      if (escaping) {
        if (!s.escapeFrom) {
          s.escapeFrom = s.pos;
          s.escapeDir = s.heading;
        }
        s.escape = Math.min(1, s.escape + dt / 26);
        pos = goAroundAt(s.escapeFrom, s.escapeDir!, f.phase === 'diverted' ? s.escape * 0.8 : s.escape).pos;
      }

      pos = [pos[0], pos[1] + RUNWAY.y, pos[2]];
      s.pos = s.alpha < 0.02 ? pos : dampV(s.pos, pos, 6, dt);
      this.orient(s, prevPos, dt);

      const col: Vec3 = escaping ? LEVEL_COLORS.hold : LEVEL_COLORS[f.level ?? 'pending'] ?? LEVEL_COLORS.pending;
      s.color = dampV(s.color, col, 3, dt);
      const gearGoal = escaping ? (s.escape > 0.15 ? 0 : 1) : holding || s.orbit ? 0 : s.display > 4.6 ? 1 : 0;
      s.gear = damp(s.gear, gearGoal, 0.8, dt);
      this.configure(s, escaping, holding, dt);

      // touchdown: tyre smoke once per landing
      if (!s.touchedDown && s.display >= 7 && !escaping) {
        s.touchedDown = true;
        if (s.alpha > 0.3) this.puff(s);
      }

      let alphaGoal = 1;
      if (s.gone) alphaGoal = 0;
      if (f.phase === 'landed' && s.display > PATH_MAX - 0.4) alphaGoal = 0;
      if (escaping && s.escape > 0.85) alphaGoal = 0;
      if (f.outcomeAt && now - f.outcomeAt > 60_000) alphaGoal = 0;
      // The inspector can revisit an older outcome. Keep that flight present
      // for its camera, including a landed aircraft parked on the taxiway.
      if (this.selected === id) alphaGoal = 1;
      // the story flight owns the approach on the landing page
      if (this.view === 'story' && v3.dist(s.pos, this.hero.pos) < 2500) alphaGoal = 0;
      s.alpha = damp(s.alpha, alphaGoal, alphaGoal > s.alpha ? 1.2 : 1.6, dt);

      s.trailTimer += dt;
      if (s.trailTimer > 0.25) {
        s.trailTimer = 0;
        s.trail.copyWithin(3, 0, (TRAIL - 1) * 3);
        s.trail.set(s.pos, 0);
        s.trailLen = Math.min(TRAIL, s.trailLen + 1);
      }

      if (s.alpha > 0.05 && f.phase !== 'landed' && f.activeStage !== null) {
        this.gateHeat[f.activeStage] = Math.min(1, this.gateHeat[f.activeStage] + 0.6);
        if (f.activeStage + 1 < 9) this.gateHeat[f.activeStage + 1] = Math.min(1, this.gateHeat[f.activeStage + 1] + 0.25);
      }
      if (s.gone && s.alpha < 0.01 && this.selected !== id) this.flights.delete(id);
    }
    this.stepHero(dt);
    this.stepDeparture(dt);
    this.stepSmoke(dt);
  }

  /**
   * The airport's own departure. It holds short while a live arrival is
   * anywhere from gate 3 to the end of its roll-out, and stays out of the
   * scripted story flight's way altogether.
   */
  private stepDeparture(dt: number) {
    let busy = 0;
    for (const s of this.flights.values()) {
      if (s.alpha < 0.2 || s.escapeFrom) continue;
      if (s.display > 6 && s.display < 8.5) busy = 2;
      else if (s.display > 3 && s.display <= 6) busy = Math.max(busy, 1);
    }
    const stand = STANDS[DEPARTURE_STAND];
    const c = transform(this.viewProj, [stand.x, 10, stand.z]);
    const inView = c[3] > 0 && Math.abs(c[0] / c[3]) < 1.15 && Math.abs(c[1] / c[3]) < 1.15 && v3.dist(this.eye, [stand.x, 10, stand.z]) < 6000;
    const st = this.departure.step(this.opts.reducedMotion ? dt * 0 : dt, busy, inView);
    const f = this.depFlight;
    f.pos = st.pos;
    f.heading = st.heading;
    f.pitch = st.pitch;
    f.bank = st.bank;
    f.gear = st.gear;
    f.flaps = st.flaps;
    f.spoilers = 0;
    f.fanSpeed = st.fanSpeed;
    f.fan += st.fanSpeed * dt;
    f.alpha = st.visible && this.view !== 'story' ? 1 : 0;
    f.ambient = { beacon: st.beacon, strobes: st.strobes, landing: st.landing, taxi: st.taxi };
    // humid evening air condenses over the flaps as the wing takes the load at rotation
    const climbing = st.phase === 'climb' || (st.phase === 'roll' && st.pitch > 0.04);
    if (climbing && f.alpha > 0.5 && st.pos[1] < 260) this.emitVapour(f, dt, 0.75 * (1 - smoothstep(120, 260, st.pos[1])));
  }

  /** Heading from the velocity, bank from the turn rate, pitch from the flight path plus angle of attack. */
  private orient(s: FlightState, prev: Vec3, dt: number) {
    const vel = v3.scale(v3.sub(s.pos, prev), 1 / Math.max(dt, 1e-3));
    s.vel = dampV(s.vel, vel, 4, dt);
    const flat: Vec3 = [s.vel[0], 0, s.vel[2]];
    const hs = v3.len(flat);
    if (hs > 2) {
      const goal = v3.norm(flat);
      const cross = s.heading[0] * goal[2] - s.heading[2] * goal[0];
      const turnRate = cross / Math.max(dt, 1e-3);
      s.heading = v3.norm(dampV(s.heading, goal, 5, dt));
      const onGround = s.pos[1] < GROUND_Y + RUNWAY.y + 1.5;
      s.bank = damp(s.bank, onGround ? 0 : clamp(turnRate * 9, -0.5, 0.5), 2.5, dt);
      const gamma = Math.atan2(s.vel[1], hs);
      const aoa = onGround ? 0 : 0.085 * smoothstep(GROUND_Y + 0.4, GROUND_Y + 3, s.pos[1]) + 0.01;
      s.pitch = damp(s.pitch, clamp(gamma, -0.12, 0.22) + aoa, onGround ? 1.4 : 2.5, dt);
    }
  }

  private poseMatrix(pose: Pose, scale: number): Mat4 {
    const h = pose.heading;
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const fwd: Vec3 = [h[0] * cp, sp, h[2] * cp];
    let u: Vec3 = [-h[0] * sp, cp, -h[2] * sp];
    // bank: positive rolls the right wing down
    const right = v3.cross(fwd, u);
    const cb = Math.cos(pose.bank);
    const sb = Math.sin(pose.bank);
    u = v3.norm(v3.sub(v3.scale(u, cb), v3.scale(right, sb)));
    return basisMatrix(pose.pos, fwd, u, scale);
  }

  private stepHero(dt: number) {
    const reduced = this.opts.reducedMotion;
    this.story = this.cut ? this.storyGoal : damp(this.story, this.storyGoal, reduced ? 8 : 3.2, dt);
    const s = this.story;
    // idle drift at the top of the page so the hero shot is never a still
    const idle = -1.25 + (reduced ? 0.35 : 0.42 * (1 - Math.exp(-this.time / 30)));
    let p: number;
    if (s < 1) p = idle + (-0.35 - idle) * smoothstep(0, 1, s);
    else if (s < 10) p = s - 1.35;
    else p = 8.65 + (PATH_MAX - 0.3 - 8.65) * smoothstep(10, 11.6, s);
    const h = this.hero;
    const prev = this.heroPrev;
    h.display = p;
    const pos = pointAt(p);
    h.pos = [pos[0], pos[1] + RUNWAY.y, pos[2]];
    const t = tangentAt(p);
    h.heading = v3.norm([t[0], 0, t[2]]);
    const ahead = tangentAt(p + 0.08);
    const behind = tangentAt(p - 0.08);
    const turn = behind[0] * ahead[2] - behind[2] * ahead[0];
    const onGround = p >= 7;
    h.bank = onGround ? 0 : clamp(turn * 2.2, -0.45, 0.45);
    const gamma = Math.atan2(t[1], Math.hypot(t[0], t[2]));
    const flare = smoothstep(6.75, 6.97, p) * (1 - smoothstep(7.0, 7.25, p));
    h.pitch = onGround ? 0.09 * (1 - smoothstep(7.0, 7.25, p)) : clamp(gamma, -0.1, 0.2) + 0.09 + flare * 0.02;
    h.gear = smoothstep(4.4, 4.9, p);
    h.color = LEVEL_COLORS.autonomous;
    [h.tint, h.tint2] = AGENT_LIVERIES[0];
    // flaps run out from gate 3, ground spoilers stand up at touchdown
    h.flaps = smoothstep(2.6, 5.6, p) * (1 - smoothstep(8.6, 9.6, p)) * (0.55 + 0.45 * smoothstep(5.2, 6.2, p));
    h.spoilers = smoothstep(7.0, 7.1, p) * (1 - smoothstep(8.2, 8.8, p));
    h.fanSpeed = p < 7 ? 8 : p < 8.2 ? 11 : 4;
    h.fan += h.fanSpeed * dt;
    if (this.view === 'story') this.emitVapour(h, dt);
    // gates light up as the story flight passes through them
    for (let k = 0; k < 9; k++) if (prev < k && p >= k && this.view === 'story') this.gateFlash[k] = 1;
    if (prev < 7 && p >= 7 && this.view === 'story' && !this.cut) this.puff(h);
    this.heroPrev = p;
    h.alpha = this.view === 'story' ? 1 : damp(h.alpha, 0, 2, dt);
  }

  /** Flaps, spoilers, fan speed and vapour for a live flight. */
  private configure(s: FlightState, escaping: boolean, holding: boolean, dt: number) {
    const p = s.display;
    const flapGoal = escaping ? 0.35 : holding || s.orbit ? 0.25 : smoothstep(2.6, 5.6, p) * (0.55 + 0.45 * smoothstep(5.2, 6.2, p)) * (1 - smoothstep(8.6, 9.6, p));
    s.flaps = damp(s.flaps, flapGoal, 0.6, dt);
    const spoilerGoal = !escaping && p > 7.0 && p < 8.3 ? 1 : 0;
    s.spoilers = damp(s.spoilers, spoilerGoal, spoilerGoal > s.spoilers ? 6 : 1.5, dt);
    s.fanSpeed = damp(s.fanSpeed, escaping ? 14 : p < 7 ? 8 : p < 8.2 ? 11 : 4, 1, dt);
    s.fan += s.fanSpeed * dt;
    if (!escaping && s.alpha > 0.5) this.emitVapour(s, dt);
  }

  /**
   * Humid air on final condenses in the low pressure over the flap tips and
   * wingtips: thin white wisps that trail and fade behind the aircraft.
   */
  private emitVapour(s: FlightState, dt: number, override?: number) {
    if (this.opts.reducedMotion) return;
    const p = s.display;
    const strength = override ?? smoothstep(4.8, 5.6, p) * (1 - smoothstep(6.85, 7.0, p));
    if (strength < 0.05 || v3.dist(s.pos, this.eye) > 2200) return;
    const m = s.matrix;
    const r = Math.random;
    const n = Math.min(6, Math.ceil(dt * 70));
    for (const tip of [[-4.9, 0.05, -16.9], [-4.9, 0.05, 16.9], [-5.6, -1.0, -12.8], [-5.6, -1.0, 12.8]] as Vec3[]) {
      const prev = transform(m, v3.add(tip, [0.9, 0, 0]));
      const now = transform(m, tip);
      for (let i = 0; i < n; i++) {
        const k = i / n;
        this.vapour.push({
          pos: [now[0] + (prev[0] - now[0]) * k, now[1] + (prev[1] - now[1]) * k, now[2] + (prev[2] - now[2]) * k],
          vel: [(r() - 0.5) * 0.6, -0.4 - r() * 0.3, (r() - 0.5) * 0.6],
          age: 0, life: 1.4 + r() * 0.8, size: (0.55 + r() * 0.3) * strength,
        });
      }
    }
    if (this.vapour.length > 2400) this.vapour.splice(0, this.vapour.length - 2400);
  }

  private puff(s: FlightState) {
    if (this.opts.reducedMotion) return;
    const r = rng(Math.floor(this.time * 1000));
    const m = this.poseMatrix(s, 1);
    for (const z of [-3.8, 3.8]) {
      const c = transform(m, [-0.8, -3.4, z]);
      for (let i = 0; i < 9; i++) {
        this.smoke.push({
          pos: [c[0] + (r() - 0.5) * 2, c[1], c[2] + (r() - 0.5) * 2],
          vel: [s.heading[0] * (8 + r() * 10) + (r() - 0.5) * 3, 1 + r() * 2, s.heading[2] * (8 + r() * 10) + (r() - 0.5) * 3],
          age: 0, life: 2.5 + r() * 2.5, size: 2.5 + r() * 2,
        });
      }
    }
  }

  /**
   * Chimney smoke and cooling-tower steam: puffs leave the stacks, rise and
   * slow, swell and drift east on the evening breeze for a minute or two.
   */
  private stepPlumes(dt: number) {
    if (this.opts.reducedMotion) return;
    this.plumeClock += dt;
    const r = Math.random;
    for (const src of this.plumes) {
      const n = Math.floor((this.plumeClock + src.pos[0] * 0.001) * src.rate) - Math.floor((this.plumeClock - dt + src.pos[0] * 0.001) * src.rate);
      for (let i = 0; i < n; i++) {
        this.steam.push({
          pos: [src.pos[0] + (r() - 0.5) * src.size * 0.4, src.pos[1], src.pos[2] + (r() - 0.5) * src.size * 0.4],
          vel: [(r() - 0.5) * 0.6, src.steam ? 4.5 + r() * 1.5 : src.wood ? 0.8 + r() * 0.4 : 3 + r(), (r() - 0.5) * 0.6],
          age: 0, life: src.steam ? 95 + r() * 30 : src.wood ? 30 + r() * 15 : 70 + r() * 25, size: src.size * (0.7 + r() * 0.3),
          wood: src.wood,
        });
      }
    }
    for (const p of this.steam) {
      p.age += dt;
      // buoyancy fades; the breeze takes over
      p.vel = [p.vel[0] + (4.2 - p.vel[0]) * dt * 0.05, p.vel[1] * Math.exp(-dt * 0.035), p.vel[2] + (1.1 - p.vel[2]) * dt * 0.05];
      p.pos = v3.add(p.pos, v3.scale(p.vel, dt));
      p.size += dt * (p.size > 40 ? 0.9 : p.wood ? 0.22 : 0.25);
    }
    this.steam = this.steam.filter((p) => p.age < p.life);
  }

  private stepSmoke(dt: number) {
    this.stepPlumes(dt);
    for (const p of this.smoke) {
      p.age += dt;
      p.pos = v3.add(p.pos, v3.scale(p.vel, dt));
      p.vel = v3.scale(p.vel, Math.exp(-dt * 1.4));
      p.vel[1] += dt * 0.6;
      p.size += dt * 5;
    }
    this.smoke = this.smoke.filter((p) => p.age < p.life);
    for (const p of this.vapour) {
      p.age += dt;
      p.pos = v3.add(p.pos, v3.scale(p.vel, dt));
      p.size += dt * 1.1;
    }
    this.vapour = this.vapour.filter((p) => p.age < p.life);
  }

  // ------------------------------------------------------------ dynamic geometry

  private aircraftScale(s: FlightState): number {
    if (this.view === 'story' || this.view === 'follow') return 1;
    const d = v3.dist(s.pos, this.eye) * Math.tan(this.fov / 2) / Math.tan(0.42);
    const air = smoothstep(GROUND_Y + 15, GROUND_Y + 220, s.pos[1]);
    return 1 + (clamp(d / 1400, 1, 5) - 1) * air;
  }

  private buildDynamic(): { points: number[]; lines: number[]; beams: number[] } {
    const pts: number[] = [];
    const lines: number[] = [];
    const beams: number[] = [];
    const L = AIRLINER_LIGHTS;
    let spot = 0;
    this.spots.fill(0);
    const all = [...this.flights.values()];
    if (this.hero.alpha > 0.01) all.push(this.hero);
    if (this.depFlight.alpha > 0.01) all.push(this.depFlight);
    for (const s of all) {
      if (s.alpha < 0.01) continue;
      const isHero = s === this.hero || !!s.ambient;
      const amb = s.ambient;
      s.scale = s.ambient ? 1 : this.aircraftScale(s);
      s.matrix = this.poseMatrix(s, s.scale);
      const m = s.matrix;
      const a = s.alpha;
      const at = (p: Vec3): Vec3 => {
        const q = transform(m, p);
        return [q[0], q[1], q[2]];
      };
      const fwd = v3.norm([m[0], m[1], m[2]]);
      const up = v3.norm([m[4], m[5], m[6]]);
      const lightSize = Math.max(1, s.scale * 0.7);
      const phase = (hashString(s.id) % 1000) / 1000;
      pts.push(...at(L.navLeft), 1.0 * a, 0.08 * a, 0.06 * a, 1.1 * lightSize, 0);
      pts.push(...at(L.navRight), 0.1 * a, 1.0 * a, 0.25 * a, 1.1 * lightSize, 0);
      pts.push(...at(L.tail), 0.9 * a, 0.9 * a, 0.9 * a, 1.0 * lightSize, 0);
      if (!amb || amb.strobes) {
        pts.push(...at(L.strobeLeft), 1.4 * a, 1.4 * a, 1.5 * a, 2.0 * lightSize, 3 + phase * 0.99);
        pts.push(...at(L.strobeRight), 1.4 * a, 1.4 * a, 1.5 * a, 2.0 * lightSize, 3 + phase * 0.99);
        pts.push(...at(L.tail), 1.4 * a, 1.4 * a, 1.5 * a, 1.6 * lightSize, 3 + ((phase + 0.5) % 1) * 0.99);
      }
      if (!amb || amb.beacon) {
        pts.push(...at(L.beaconTop), 1.0 * a, 0.1 * a, 0.05 * a, 1.3 * lightSize, 4 + phase * 0.99);
        pts.push(...at(L.beaconBottom), 1.0 * a, 0.1 * a, 0.05 * a, 1.3 * lightSize, 4 + ((phase + 0.5) % 1) * 0.99);
      }
      if (amb && amb.taxi && !amb.landing) pts.push(...at(L.taxi), 0.9 * a, 0.86 * a, 0.8 * a, 1.2 * lightSize, 0);

      // landing lights below 2,500 ft and on the runway: a hard glare toward the viewer, and beams
      const lightsOn = amb ? amb.landing : s.pos[1] < 900 && s.display > -0.2 && !(s.input.phase === 'go-around' && s.escape > 0.3);
      if (lightsOn) {
        const dir = v3.norm(v3.sub(fwd, v3.scale(up, 0.08)));
        for (const lamp of [L.landingLeft, L.landingRight]) {
          const lp = at(lamp);
          const toEye = v3.norm(v3.sub(this.eye, lp));
          const facing = Math.pow(Math.max(0, v3.dot(dir, toEye)), 6);
          const glare = (0.25 + 7 * facing) * a;
          pts.push(...lp, 1.0 * glare, 0.95 * glare, 0.86 * glare, (1.6 + facing * 3.5) * lightSize, 0);
          // volumetric beam: two crossed fans
          const far = v3.add(lp, v3.scale(dir, 320));
          const side = v3.norm(v3.cross(dir, up));
          const upb = v3.norm(v3.cross(side, dir));
          for (const axis of [side, upb]) {
            glowQuad(beams, v3.add(lp, v3.scale(axis, -0.4)), v3.add(far, v3.scale(axis, -46)), v3.add(far, v3.scale(axis, 46)), v3.add(lp, v3.scale(axis, 0.4)), [1.0, 0.93, 0.82], 0.16 * a,
              [[0, 0], [1, 0], [1, 1], [0, 1]]);
          }
        }
        if (s.gear > 0.5) {
          const tp = at(L.taxi);
          pts.push(...tp, 0.9 * a, 0.86 * a, 0.8 * a, 1.2 * lightSize, 0);
        }
        // light the runway and taxiways ahead of aircraft near the ground
        if (s.pos[1] < 160 && spot < 6) {
          const c = at([2.4, -1.3, 0]);
          this.spots.set([c[0], c[1], c[2], 1.0 * a], spot * 4);
          this.spotDirs.set([dir[0], dir[1] - 0.05, dir[2], Math.cos(0.2)], spot * 4);
          spot++;
        }
      }

      // trail and selection furniture for live flights
      if (!isHero && this.view !== 'story') {
        const sel = s.id === this.selected;
        const c = s.color;
        const tw = sel ? 2.4 : 1.3;
        for (let i = 0; i < s.trailLen - 1; i++) {
          const t0 = 1 - i / TRAIL;
          const t1 = 1 - (i + 1) / TRAIL;
          const ta = (sel ? 0.75 : 0.32) * a;
          seg(lines, [s.trail[i * 3], s.trail[i * 3 + 1], s.trail[i * 3 + 2]], [s.trail[(i + 1) * 3], s.trail[(i + 1) * 3 + 1], s.trail[(i + 1) * 3 + 2]], c, t0 * t0 * ta, t1 * t1 * ta, tw);
        }
        if (s.hold > 0.05) {
          const prog = clamp(s.display, 0, 6);
          let prev = holdingAt(prog, 0).pos;
          for (let i = 1; i <= 64; i++) {
            const q = holdingAt(prog, i / 64).pos;
            if (i % 2 === 0) seg(lines, prev, q, c, 0.35 * s.hold * a, 0.35 * s.hold * a, 1.2);
            prev = q;
          }
        }
        // a drop line to the ground gives altitude a reading
        if (s.pos[1] > 40) {
          const g = Math.max(heightAt(s.pos[0], s.pos[2]), WATER_LEVEL);
          seg(lines, s.pos, [s.pos[0], g, s.pos[2]], c, (sel ? 0.5 : 0.18) * a, 0, 1);
        }
      }
    }
    // head and tail lights of the traffic, beacons on the apron vehicles
    for (const v of this.trafficLights) pts.push(v);
    return { points: pts, lines, beams };
  }

  private buildGates(): { lines: number[]; panels: number[] } {
    const out: number[] = [];
    const panels: number[] = [];
    const story = this.view === 'story';
    const heroP = this.hero.display;
    for (let k = 0; k < GATES.length; k++) {
      const c = GATES[k];
      const tan = tangentAt(k);
      const flat = v3.norm([tan[0], 0, tan[2]]);
      const side = v3.norm(v3.cross([0, 1, 0], flat));
      const up: Vec3 = [0, 1, 0];
      const [hw, hh] = GATE_SIZE[k];
      const ground = k >= 7;
      const center: Vec3 = ground ? [c[0], RUNWAY.y + hh + 1, c[2]] : c;
      const P = (sx: number, sy: number): Vec3 => v3.add(center, v3.add(v3.scale(side, sx * hw), v3.scale(up, sy * hh)));

      let a: number;
      let col: Vec3;
      const flash = this.gateFlash[k];
      if (story) {
        // ahead of the story flight: bright; behind it: fading out
        const rel = k - heroP;
        a = rel > -0.15 ? 0.55 + 0.45 * smoothstep(3, 0, rel) : 0.55 * smoothstep(-1.2, -0.15, rel);
        col = v3.lerp([0.42, 0.85, 1.0], [0.55, 1.0, 0.75], flash);
        a += flash * 1.4;
      } else {
        const heat = this.gateHeat[k];
        a = 0.35 + heat * 0.8;
        col = v3.lerp([0.42, 0.75, 1.0], [0.55, 0.95, 1.0], heat);
      }
      if (a < 0.01) continue;
      const bw = 1.4 + flash * 1.6;
      const B = 0.2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
        const corner = P(sx, sy);
        seg(out, corner, P(sx - sx * B, sy), col, a * 1.4, a * 1.4, bw + 0.8);
        seg(out, corner, P(sx, sy - sy * B * (hw / hh)), col, a * 1.4, a * 1.4, bw + 0.8);
      }
      seg(out, P(-1, -1), P(1, -1), col, a * 0.35, a * 0.35, bw * 0.7);
      seg(out, P(1, -1), P(1, 1), col, a * 0.35, a * 0.35, bw * 0.7);
      seg(out, P(1, 1), P(-1, 1), col, a * 0.35, a * 0.35, bw * 0.7);
      seg(out, P(-1, 1), P(-1, -1), col, a * 0.35, a * 0.35, bw * 0.7);
      // centre reticle: the point the flight aims through
      const r = Math.min(hw, hh) * 0.08;
      seg(out, P(-0.06, 0), v3.add(center, v3.scale(side, -r * 0.4)), col, a * 0.7, a * 0.7, 1.2);
      seg(out, P(0.06, 0), v3.add(center, v3.scale(side, r * 0.4)), col, a * 0.7, a * 0.7, 1.2);
      // ticks along the bottom edge, like a HUD scale
      for (let i = -4; i <= 4; i++) {
        const b = P(i / 5, -1);
        seg(out, b, v3.add(b, [0, hh * 0.06, 0]), col, a * 0.5, a * 0.5, 1);
      }
      glowQuad(panels, P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), col, 0.55 * a);
      // tunnel to the next gate
      if (k < GATES.length - 1) {
        const n = GATES[k + 1];
        const nt = tangentAt(k + 1);
        const nflat = v3.norm([nt[0], 0, nt[2]]);
        const nside = v3.norm(v3.cross([0, 1, 0], nflat));
        const [nhw, nhh] = GATE_SIZE[k + 1];
        const ncenter: Vec3 = k + 1 >= 7 ? [n[0], RUNWAY.y + nhh + 1, n[2]] : n;
        const NP = (sx: number, sy: number): Vec3 => v3.add(ncenter, v3.add(v3.scale(nside, sx * nhw), v3.scale(up, sy * nhh)));
        const ta = a * 0.14;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) seg(out, P(sx, sy), NP(sx, sy), col, ta, ta * 0.6, 1);
      }
      if (!ground) {
        const bottom = P(0, -1);
        const g = Math.max(heightAt(bottom[0], bottom[2]), WATER_LEVEL);
        seg(out, bottom, [bottom[0], g, bottom[2]], col, a * 0.25, 0, 1);
      }
    }
    return { lines: out, panels };
  }

  // ------------------------------------------------------------ camera

  private storyRig(): Rig {
    const s = this.story;
    const h = this.hero;
    const f = h.heading;
    const up: Vec3 = [0, 1, 0];
    const r = v3.norm(v3.cross(f, up));
    const shotAt = (i: number): Rig => {
      const sh = SHOTS[Math.max(0, Math.min(SHOTS.length - 1, i))];
      if (sh.world) {
        if (sh.world.look) return { eye: sh.world.eye, target: sh.world.look, fov: (sh.fov * Math.PI) / 180 };
        // a spotter's telephoto: track the aircraft and zoom to keep it large
        const d = v3.dist(sh.world.eye, h.pos);
        return { eye: sh.world.eye, target: h.pos, fov: clamp(2 * Math.atan(24 / d), 0.12, 0.72) };
      }
      const L = (o: Vec3): Vec3 => v3.add(h.pos, v3.add(v3.scale(f, o[0]), v3.add(v3.scale(up, o[1]), v3.scale(r, o[2]))));
      return { eye: L(sh.eye), target: L(sh.look), fov: (sh.fov * Math.PI) / 180 };
    };
    // which shot, and how far into the cut to the next one
    let i: number;
    let u: number;
    if (s < 1) { i = 0; u = smoothstep(0.45, 1, s); }
    else if (s < 10) { i = Math.floor(s); u = smoothstep(0.55, 1, s - i); }
    else { i = 10; u = 0; }
    const a = shotAt(i);
    const b = shotAt(i + 1);
    const e = u * u * (3 - 2 * u);
    const rig: Rig = { eye: v3.lerp(a.eye, b.eye, e), target: v3.lerp(a.target, b.target, e), fov: a.fov + (b.fov - a.fov) * e };
    if (s >= 10) {
      // after the rollout: crane up and away to the airport
      const k = smoothstep(10.1, 11.6, s);
      const roll = shotAt(9);
      const air = shotAt(10);
      rig.eye = v3.lerp(roll.eye, air.eye, k * k * (3 - 2 * k));
      rig.target = v3.lerp(roll.target, air.target, k);
      rig.fov = roll.fov + (air.fov - roll.fov) * k;
      // slow drift over the airport while the rest of the page is read
      const drift = (s - 11.6) * 0.06 + (this.opts.reducedMotion ? 0 : Math.sin(this.time * 0.05) * 0.03);
      if (s > 11.6) {
        const d = v3.sub(rig.eye, rig.target);
        const ang = drift;
        rig.eye = v3.add(rig.target, [d[0] * Math.cos(ang) - d[2] * Math.sin(ang), d[1], d[0] * Math.sin(ang) + d[2] * Math.cos(ang)]);
      }
    } else if (!this.opts.reducedMotion) {
      // a hand-held breath on the camera
      const t = this.time;
      rig.eye = v3.add(rig.eye, [Math.sin(t * 0.7) * 0.6, Math.sin(t * 0.9 + 1) * 0.4, Math.cos(t * 0.6) * 0.6]);
    }
    return rig;
  }

  private goalRig(_dt: number): Rig {
    if (this.debugRig) return this.debugRig;
    const sel = this.selected ? this.flights.get(this.selected) : null;
    switch (this.view) {
      case 'story':
        return this.storyRig();
      case 'tower': {
        const yaw = this.towerYaw + this.userYaw;
        const pitch = clamp(this.towerPitch + this.userPitch, -0.6, 0.9);
        const dir: Vec3 = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)];
        return { eye: TOWER_EYE, target: v3.add(TOWER_EYE, v3.scale(dir, 1000)), fov: clamp(0.82 * this.userZoom, 0.08, 1.2) };
      }
      case 'approach': {
        return approachCamera(this.userYaw, this.userPitch, this.userZoom);
      }
      case 'airport':
      case 'riverside':
        return environmentCamera(this.view, this.userYaw, this.userPitch, this.userZoom);
      case 'follow': {
        const s = sel ?? [...this.flights.values()].find((x) => x.alpha > 0.5 && x.input.phase === 'airborne') ?? null;
        if (!s) return { eye: TOWER_EYE, target: v3.add(TOWER_EYE, [-1000, 40, -150]), fov: 0.8 };
        const f = s.heading;
        const yaw = Math.atan2(f[2], f[0]) + Math.PI + 0.35 + this.userYaw;
        const pitch = clamp(0.16 + this.userPitch, -0.3, 1.3);
        const dist = 95 * this.userZoom;
        const eye = v3.add(s.pos, [Math.cos(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.sin(yaw) * Math.cos(pitch) * dist]);
        return { eye, target: v3.add(s.pos, v3.scale(f, 18)), fov: 0.75 };
      }
    }
  }

  private updateCamera(dt: number) {
    const goal = this.goalRig(dt);
    if (this.cut) {
      this.rig = { eye: [...goal.eye], target: [...goal.target], fov: goal.fov };
      this.cut = false;
    } else {
      const story = this.view === 'story';
      const k = this.drag ? 14 : story ? 9 : this.view === 'follow' ? 4 : 2.2;
      this.rig.eye = dampV(this.rig.eye, goal.eye, k, dt);
      this.rig.target = dampV(this.rig.target, goal.target, story ? 9 : 3.2, dt);
      this.rig.fov = damp(this.rig.fov, goal.fov, story ? 9 : 2.4, dt);
    }
    // keep the camera above the ground and water
    const g = Math.max(heightAt(this.rig.eye[0], this.rig.eye[2]), WATER_LEVEL) + 1.6;
    if (this.rig.eye[1] < g) this.rig.eye = [this.rig.eye[0], g, this.rig.eye[2]];
    this.eye = this.rig.eye;
    this.fov = this.rig.fov;
    const aspect = this.w / this.h;
    // portrait screens need a wider lens to keep the subject in frame
    const fovY = aspect < 0.8 ? Math.min(1.4, this.fov * 1.45) : this.fov;
    this.fovY = fovY;
    this.offsetX = damp(this.offsetX, this.offsetGoal, 3, dt);
    const camHeight = this.eye[1] - Math.max(heightAt(this.eye[0], this.eye[2]), WATER_LEVEL);
    const focus = v3.dist(this.eye, this.rig.target);
    const near = clamp(Math.min(camHeight * 0.25, focus * 0.08), 0.4, 12);
    const proj = perspective(fovY, aspect, near, 90000);
    proj[8] = (-2 * this.offsetX) / this.w; // off-axis: shift the image without turning the camera
    this.proj = proj;
    this.invProj = invert(proj);
    this.viewMatrix = lookAt(this.eye, this.rig.target);
    this.viewProj = multiply(proj, this.viewMatrix);
    this.invViewProj = invert(this.viewProj);
  }

  // ------------------------------------------------------------ input

  private onPointerDown = (e: PointerEvent) => {
    if (!this.opts.interactive) return;
    this.drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  private onPointerMove = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.id) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4 && !this.drag.moved) {
        this.drag.moved = true;
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        this.canvas.style.cursor = 'grabbing';
      }
      if (this.drag.moved) {
        const k = this.view === 'tower' ? this.fov * 0.0016 : 0.004;
        this.userYaw += (this.view === 'tower' ? dx : -dx) * k;
        this.userPitch += (this.view === 'tower' ? -dy : dy) * (this.view === 'tower' ? k : 0.003);
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
      return;
    }
    if (this.opts.interactive && e.target === this.canvas) this.canvas.style.cursor = this.pick(e.clientX, e.clientY) ? 'pointer' : 'grab';
  };
  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    this.canvas.style.cursor = this.opts.interactive ? 'grab' : '';
    if (!moved) this.opts.onPick?.(this.pick(e.clientX, e.clientY));
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.opts.interactive) return;
    e.preventDefault();
    this.userZoom = clamp(this.userZoom * Math.exp(e.deltaY * 0.0011), 0.12, 2.2);
  };
  private onVisibility = () => {
    if (document.hidden) cancelAnimationFrame(this.raf);
    else {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private bindInput() {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }
  private unbindInput() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  /** Resets the user's look-around offsets (the console's "recentre" control). */
  recentre() {
    this.userYaw = 0;
    this.userPitch = 0;
    this.userZoom = 1;
  }

  private project(p: Vec3): { x: number; y: number; visible: boolean; depth: number } {
    const c = transform(this.viewProj, p);
    if (c[3] <= 0.01) return { x: 0, y: 0, visible: false, depth: 0 };
    const x = (c[0] / c[3] * 0.5 + 0.5) * this.w;
    const y = (1 - (c[1] / c[3] * 0.5 + 0.5)) * this.h;
    return { x, y, visible: x > -60 && x < this.w + 60 && y > -60 && y < this.h + 60, depth: c[3] };
  }

  private pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = 30 * 30;
    for (const s of this.flights.values()) {
      if (s.alpha < 0.3) continue;
      const p = this.project(s.pos);
      if (!p.visible) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = s.id; }
    }
    return best;
  }

  // ------------------------------------------------------------ frame

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75) * this.quality;
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    const W = Math.max(1, Math.round(this.w * this.dpr));
    const H = Math.max(1, Math.round(this.h * this.dpr));
    this.canvas.width = W;
    this.canvas.height = H;
    this.scene?.dispose();
    this.scene = new SceneTarget(this.gl, W, H, this.hdr, this.quality < 1 ? 2 : 4, true);
    this.reflection?.dispose();
    const reflectionScale = Math.min(0.5, 768 / W);
    this.reflection = new SceneTarget(this.gl, Math.max(1, Math.round(W * reflectionScale)), Math.max(1, Math.round(H * reflectionScale)), this.hdr, 0);
    this.reflectionAt = -1;
    for (const m of this.mips) deleteTarget(this.gl, m);
    this.mips = [];
    let mw = W >> 1;
    let mh = H >> 1;
    for (let i = 0; i < 6 && mw > 4 && mh > 4; i++) {
      this.mips.push(makeTarget(this.gl, mw, mh, this.hdr));
      mw >>= 1;
      mh >>= 1;
    }
    deleteTarget(this.gl, this.raysTarget);
    this.raysTarget = makeTarget(this.gl, Math.max(1, W >> 2), Math.max(1, H >> 2), this.hdr);
    for (const t of [this.aoTarget, this.aoBlurTarget, this.dofTarget]) deleteTarget(this.gl, t);
    this.aoTarget = makeTarget(this.gl, Math.max(1, W >> 1), Math.max(1, H >> 1), false);
    this.aoBlurTarget = makeTarget(this.gl, Math.max(1, W >> 1), Math.max(1, H >> 1), false);
    this.dofTarget = makeTarget(this.gl, Math.max(1, W >> 1), Math.max(1, H >> 1), this.hdr);
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    // adapt resolution on slow machines rather than stutter
    if (dt > 0.045) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    // a slow machine first gives up resolution, then the costliest effects
    if (this.slowFrames > 40) {
      this.slowFrames = 0;
      if (this.quality > 0.6) {
        this.quality = this.quality > 0.8 ? 0.75 : 0.6;
        this.resize();
      } else if (this.effects > 0) {
        this.effects--;
      }
    }
    this.dim = damp(this.dim, this.dimGoal, 3, dt);
    this.step(dt);
    this.updateCamera(dt);
    this.render();
    this.report();
  };

  private setCommon(p: Program, reflection = false) {
    const gl = this.gl;
    const u = p.u;
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, reflection ? this.reflected.matrix : this.viewProj);
    if (u.uEye) gl.uniform3fv(u.uEye, reflection ? this.reflected.eye : this.eye);
    if (u.uClipWater) gl.uniform1f(u.uClipWater, reflection ? 1 : 0);
    if (u.uSunDir) gl.uniform3fv(u.uSunDir, SUN_DIR);
    if (u.uSunColor) gl.uniform3fv(u.uSunColor, SUN_COLOR);
    if (u.uTime) gl.uniform1f(u.uTime, this.opts.reducedMotion ? 0 : this.time);
    if (u.uFog) gl.uniform1f(u.uFog, FOG);
    if (u.uFloods) gl.uniform4fv(u.uFloods, this.floods);
    if (u.uSpots) gl.uniform4fv(u.uSpots, this.spots);
    if (u.uSpotDirs) gl.uniform4fv(u.uSpotDirs, this.spotDirs);
    if (u.uLiveryTex) gl.uniform1i(u.uLiveryTex, 6);
    if (u.uShadowMap) {
      gl.uniform1i(u.uShadowMap, 5);
      gl.uniformMatrix4fv(u.uShadowMat, false, this.shadows.lookup);
      gl.uniform4fv(u.uShadowSplits, this.shadows.splits);
      gl.uniform4f(u.uShadowTexel, this.shadows.texel[0], this.shadows.texel[1], this.shadows.texel[2], 1 / this.shadows.size);
    }
  }

  private drawSky(reflection = false) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.p.sky.prog);
    this.setCommon(this.p.sky, reflection);
    gl.uniformMatrix4fv(this.p.sky.u.uInvViewProj, false, reflection ? this.reflected.inverse : this.invViewProj);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawWorld(reflection = false) {
    const gl = this.gl;
    // opaque world
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.cullFace(gl.BACK);
    gl.frontFace(reflection ? gl.CW : gl.CCW);

    const pt = this.p.terrain;
    gl.useProgram(pt.prog);
    this.setCommon(pt, reflection);
    gl.uniform4f(pt.u.uAirport, AIRFIELD.x0 + 250, AIRFIELD.z0 + 200, AIRFIELD.x1 - 250, AIRFIELD.z1 - 150);
    gl.uniform3f(pt.u.uRiver, RIVER.amp, RIVER.wave, RIVER.z);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.forestTex);
    gl.uniform1i(pt.u.uForest, 4);
    gl.uniform4f(pt.u.uForestRect, FOREST_RECT.x0, FOREST_RECT.z0, 1 / (FOREST_RECT.x1 - FOREST_RECT.x0), 1 / (FOREST_RECT.z1 - FOREST_RECT.z0));
    gl.uniform1f(pt.u.uTreeRange, TREE_RANGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(pt.u.uShoreTerrain, 1);
    this.terrain.draw();
    gl.uniform1f(pt.u.uShoreTerrain, 2);
    this.shoreTerrain.draw();
    this.drawGrass(reflection);

    if (!reflection) {
      const pw = this.p.water;
      gl.useProgram(pw.prog);
      this.setCommon(pw);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.reflection!.resolved.tex);
      gl.uniform1i(pw.u.uReflection, 1);
      gl.uniformMatrix4fv(pw.u.uReflectionVP, false, this.reflected.matrix);
      gl.uniform1f(pw.u.uReflectionEnabled, this.reflectionActive ? 1 : 0);
      gl.uniform4fv(pw.u.uBoats, this.boats);
      this.water.draw();
    }

    // airport paving sits a hair above the grass: bias it toward the camera
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -6);
    const ps = this.p.surface;
    gl.useProgram(ps.prog);
    this.setCommon(ps, reflection);
    gl.uniform1f(ps.u.uRunwayLength, RUNWAY.x1 - RUNWAY.x0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.numbersTex);
    gl.uniform1i(ps.u.uNumbers, 0);
    this.surfaces.draw();
    gl.disable(gl.POLYGON_OFFSET_FILL);

    const pc = this.p.city;
    gl.useProgram(pc.prog);
    this.setCommon(pc, reflection);
    gl.enable(gl.CULL_FACE);
    this.city.draw();
    const pr = this.p.roof;
    gl.useProgram(pr.prog);
    this.setCommon(pr, reflection);
    this.roofs.draw();
    gl.disable(gl.CULL_FACE);

    this.drawTrees(this.p.tree, reflection ? this.reflected.matrix : this.viewProj, reflection ? TREE_RANGE * 0.45 : TREE_RANGE, reflection);

    const pl = this.p.lit;
    gl.useProgram(pl.prog);
    this.setCommon(pl, reflection);
    gl.uniform1f(pl.u.uOpacity, 1);
    gl.uniform3f(pl.u.uTint, 0.5, 0.5, 0.5);
    gl.uniform1f(pl.u.uEmissiveBoost, 2.2);
    gl.uniformMatrix4fv(pl.u.uModel, false, IDENTITY);
    this.structures.draw();
    this.groundProps.draw();
    this.urban.draw();
    this.shore.draw();
    this.countryside.draw();
    this.landside.draw();
    this.motorway.draw();
    this.industry.draw();
    this.villageMesh.draw();
    if (!reflection) this.railway.draw();
    this.drawMovers(reflection);
    if (!reflection) this.drawFarm();
    if (!reflection) this.drawBirds();
    gl.useProgram(pl.prog);
    // turbine rotors face the westerly wind; the surveillance radar sweeps at 13 rpm
    const spin = this.opts.reducedMotion ? 0 : this.time;
    for (const t of this.turbineList) {
      if (v3.dist(t.hub, this.eye) > 18000) continue;
      const fwd: Vec3 = [Math.cos(t.yaw), 0, Math.sin(t.yaw)];
      gl.uniformMatrix4fv(pl.u.uModel, false, multiply(basisMatrix(v3.add(t.hub, v3.scale(fwd, 2.4)), fwd, [0, 1, 0]), axisAngle([1, 0, 0], t.phase + spin * t.speed)));
      this.rotor.draw();
    }
    gl.uniformMatrix4fv(pl.u.uModel, false, multiply(translation(RADAR_PIVOT), axisAngle([0, 1, 0], -spin * 1.36)));
    this.radarAntenna.draw();
    gl.uniformMatrix4fv(pl.u.uModel, false, IDENTITY);
    // the windsocks fly in the gusts when the camera is near enough to see them
    if (!reflection && v3.dist(this.eye, [WINDSOCKS[0][0], 5, WINDSOCKS[0][1]]) < 4000) {
      const g = windsocks(this.opts.reducedMotion ? 0 : this.time);
      this.socks.update(new Float32Array(g.data), g.count);
    }
    this.socks.draw();
    // the airliners are closed, outward-wound meshes: cull their insides
    gl.enable(gl.CULL_FACE);
    gl.uniform1f(pl.u.uLivery, 1);
    gl.uniform1f(pl.u.uLogoLights, 1);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.liveryTex);
    gl.uniform1i(pl.u.uLiveryTex, 6);
    gl.activeTexture(gl.TEXTURE0);
    for (const a of this.parked) {
      gl.uniformMatrix4fv(pl.u.uModel, false, a.matrix);
      gl.uniform3fv(pl.u.uTint, a.tint);
      gl.uniform3fv(pl.u.uTint2, a.tint2);
      this.body.draw();
      this.gearMesh.draw();
    }
    const fleet = [...this.flights.values()];
    if (this.hero.alpha > 0.01) fleet.push(this.hero);
    if (this.depFlight.alpha > 0.01) fleet.push(this.depFlight);
    for (const s of fleet) {
      if (s.alpha < 0.02) continue;
      gl.uniformMatrix4fv(pl.u.uModel, false, s.matrix);
      gl.uniform3fv(pl.u.uTint, s.tint);
      gl.uniform3fv(pl.u.uTint2, s.tint2);
      this.body.draw();
      if (s.gear > 0.5) this.gearMesh.draw();
      // moving parts are only worth drawing where they can be seen
      if (reflection || v3.dist(s.pos, this.eye) > 1800 * s.scale) continue;
      gl.disable(gl.CULL_FACE);
      for (const part of this.flapParts) {
        gl.uniformMatrix4fv(pl.u.uModel, false, multiply(s.matrix, hingeMatrix(part.h, s.flaps)));
        part.mesh.draw();
      }
      for (const part of this.spoilerParts) {
        gl.uniformMatrix4fv(pl.u.uModel, false, multiply(s.matrix, hingeMatrix(part.h, s.spoilers)));
        part.mesh.draw();
      }
      for (const c of this.fanCenters) {
        gl.uniformMatrix4fv(pl.u.uModel, false, multiply(s.matrix, multiply(translation(c), axisAngle([1, 0, 0], s.fan))));
        this.fanMesh.draw();
      }
      gl.enable(gl.CULL_FACE);
    }
    gl.uniform1f(pl.u.uLivery, 0);
    gl.uniform1f(pl.u.uLogoLights, 0);
    gl.disable(gl.CULL_FACE);

  }

  /** Uploads this frame's traffic: every vehicle, train and boat near the camera. */
  private updateMovers() {
    const time = this.opts.reducedMotion ? 0 : this.time;
    const f = this.traffic.update(time, this.eye, 5200, 4200);
    // the departure's pushback tractor joins the pushback fleet
    const tug = this.departure.state.tug;
    if (tug && this.view !== 'story') this.traffic.add('pushback', tug, [0.78, 0.6, 0.06]);
    // the electric units, with head and tail lights
    for (const train of this.trains) {
      const cars = train.cars(time);
      cars.forEach((c, k) => {
        this.traffic.add(c.kind, c.pose, [0.62, 0.06, 0.05]);
        if (k !== 0 && k !== cars.length - 1) return;
        const p = c.pose;
        const cs = Math.cos(p.heading);
        const sn = Math.sin(p.heading);
        const front = k === 0;
        for (const side of [-0.95, 0.95]) {
          f.lights.push(p.x + cs * 12.65 - sn * side, p.y + 1.6, p.z + sn * 12.65 + cs * side, front ? 1.0 : 1.0, front ? 0.95 : 0.08, front ? 0.85 : 0.05, front ? 0.9 : 0.5, 0);
        }
      });
    }
    for (const k of MOVER_KINDS) {
      const n = f.count[k];
      this.moverCount.set(k, n);
      if (n > 0) this.movers.get(k)!.setInstances(f.data[k].subarray(0, n * MOVER_FLOATS), n);
    }
    this.trafficLights = f.lights;
    // the nearest hulls on the water draw their wakes
    const near: { d: number; x: number; z: number; h: number; w: number }[] = [];
    for (const [kind, half] of [['barge', 40], ['boat', 4.8], ['sailboat', 2.2]] as [MoverKind, number][]) {
      const buf = f.data[kind];
      for (let i = 0; i < f.count[kind]; i++) {
        const o = i * MOVER_FLOATS;
        const d = Math.hypot(buf[o] - this.eye[0], buf[o + 2] - this.eye[2]);
        if (d < 4500) near.push({ d, x: buf[o], z: buf[o + 2], h: buf[o + 3], w: half });
      }
    }
    near.sort((a, b) => a.d - b.d);
    this.boats.fill(0);
    near.slice(0, 8).forEach((b, i) => this.boats.set([b.x, b.z, b.h, b.w], i * 4));
  }

  /**
   * High-altitude traffic crossing the sky at 11 km, unrelated to the
   * airport: each aircraft is a glint of light at the head of a contrail
   * that widens and fades over the two minutes behind it. Adds the trail
   * segments to the line list and the aircraft to the point list.
   */
  private contrails(points: number[]): number[] {
    const lines: number[] = [];
    if (this.opts.reducedMotion) return lines;
    const routes: { a: Vec3; b: Vec3; period: number; offset: number }[] = [
      { a: [42000, 11200, 30000], b: [-38000, 11200, -26000], period: 330, offset: 40 },
      { a: [-45000, 10600, 14000], b: [40000, 10600, -9000], period: 360, offset: 210 },
      { a: [20000, 11800, -42000], b: [-15000, 11800, 40000], period: 350, offset: 120 },
    ];
    const at = (r: (typeof routes)[number], t: number): Vec3 | null => {
      const f = (t + r.offset) / r.period;
      const k = f - Math.floor(f);
      return v3.lerp(r.a, r.b, k);
    };
    for (const r of routes) {
      const head = at(r, this.time);
      if (!head) continue;
      const cycleStart = Math.floor((this.time + r.offset) / r.period);
      points.push(head[0], head[1], head[2], 1.0, 0.95, 0.88, 40, 0);
      let prev = head;
      for (let k = 1; k <= 28; k++) {
        const age = k * 4.5;
        const t = this.time - age;
        // the trail never reaches back past the start of this crossing
        if (Math.floor((t + r.offset) / r.period) !== cycleStart) break;
        const p = at(r, t)!;
        const drift: Vec3 = [p[0] + age * 2.5, p[1] - age * 0.6, p[2] + age * 1.2];
        const fade = (1 - age / 130) * (1 - age / 130);
        const a0 = 0.32 * (1 - (age - 4.5) / 130) * (1 - (age - 4.5) / 130);
        seg(lines, prev, drift, [1.0, 0.93, 0.86], k === 1 ? 0.05 : a0, fade * 0.32, 1.2 + age * 0.03);
        prev = drift;
      }
    }
    return lines;
  }

  /** Starling murmurations over the fields and gulls wheeling over the water. */
  private drawBirds() {
    if (this.opts.reducedMotion) return;
    const gl = this.gl;
    const pb = this.p.bird;
    gl.useProgram(pb.prog);
    this.setCommon(pb);
    const flocks: [number, number, number, number, number, number][] = [
      [700, 140, 1000, 75, 0, 560],
      [-3700, 115, -1250, 48, 0, 380],
      [-4700, 38, riverZ(-4700), 260, 1, 26],
      [-3500, 26, 3850, 380, 1, 22],
      [2400, 45, -2300, 220, 1, 14],
    ];
    gl.bindVertexArray(this.birdMesh.vao);
    for (const [x, y, z, size, kind, count] of flocks) {
      if (v3.dist(this.eye, [x, y, z]) > 9000) continue;
      gl.uniform4f(pb.u.uFlock, x, y, z, size);
      gl.uniform1f(pb.u.uKind, kind);
      gl.drawElementsInstanced(gl.TRIANGLES, this.birdMesh.indexCount, gl.UNSIGNED_SHORT, 0, count);
    }
  }

  private drawMovers(reflection: boolean) {
    const gl = this.gl;
    const pm = this.p.mover;
    gl.useProgram(pm.prog);
    this.setCommon(pm, reflection);
    gl.uniform1f(pm.u.uOpacity, 1);
    gl.uniform1f(pm.u.uEmissiveBoost, 2.2);
    gl.uniform1f(pm.u.uLivery, 0);
    gl.uniform3f(pm.u.uTint, 0.5, 0.5, 0.5);
    for (const [k, m] of this.movers) if ((this.moverCount.get(k) ?? 0) > 0) m.draw();
  }

  /** Bales and livestock in the fields, within a couple of kilometres. */
  private drawFarm() {
    if (!this.farm.length) return;
    const gl = this.gl;
    const pm = this.p.mover;
    gl.useProgram(pm.prog);
    this.setCommon(pm);
    gl.uniform1f(pm.u.uOpacity, 1);
    gl.uniform1f(pm.u.uEmissiveBoost, 2.2);
    gl.uniform1f(pm.u.uLivery, 0);
    gl.uniform3f(pm.u.uTint, 0.5, 0.5, 0.5);
    const planes = frustumPlanes(this.viewProj);
    for (const f of this.farm) f.draw(planes, this.eye, this.effects >= 2 ? FARM_RANGE : FARM_RANGE * 0.5);
  }

  /** 3D grass around a camera that is down on the airfield. */
  private drawGrass(reflection: boolean) {
    const e = this.eye;
    const ground = Math.max(heightAt(e[0], e[2]), 0);
    if (reflection || this.effects < 1 || e[1] - ground > 42 || e[0] < AIRFIELD.x0 - 100 || e[0] > AIRFIELD.x1 + 100 || e[2] < AIRFIELD.z0 - 100 || e[2] > AIRFIELD.z1 + 100) return;
    const gl = this.gl;
    const pg = this.p.grass;
    const cell = 0.42;
    const n = this.quality < 1 ? 120 : 170;
    gl.useProgram(pg.prog);
    this.setCommon(pg);
    gl.uniform3f(pg.u.uGrass, Math.floor(e[0] / cell), Math.floor(e[2] / cell), cell);
    gl.uniform1f(pg.u.uGrassN, n);
    gl.bindVertexArray(this.grassTuft.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.grassTuft.indexCount, gl.UNSIGNED_SHORT, 0, n * n);
  }

  private drawTrees(prog: Program, vp: Mat4, range: number, reflection = false) {
    const gl = this.gl;
    gl.useProgram(prog.prog);
    this.setCommon(prog, reflection);
    if (prog.u.uViewProj) gl.uniformMatrix4fv(prog.u.uViewProj, false, vp);
    const planes = frustumPlanes(vp);
    // near crowns are leaf sprays: their coverage comes from alpha when multisampled
    const a2c = !reflection && (this.scene?.samples ?? 0) > 1;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.leafTex);
    gl.activeTexture(gl.TEXTURE0);
    if (prog.u.uLeaves) gl.uniform1i(prog.u.uLeaves, 7);
    if (prog.u.uA2C) gl.uniform1f(prog.u.uA2C, a2c ? 1 : 0);
    // a machine that has had to shed effects also draws fewer leafy crowns
    const near = this.effects >= 2 ? TREE_NEAR : TREE_NEAR * 0.5;
    for (const t of this.trees) {
      const c = FOLIAGE[t.species];
      if (prog.u.uFoliage) gl.uniform3fv(prog.u.uFoliage, c.leaf);
      if (prog.u.uBark) gl.uniform3fv(prog.u.uBark, c.bark);
      if (!reflection) {
        if (a2c) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        t.hi.draw(planes, this.eye, Math.min(range, near));
        if (a2c) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      }
      t.lo.draw(planes, this.eye, Math.min(range, TREE_MID), reflection ? 0 : near);
      if (range > TREE_MID) t.sparse.draw(planes, this.eye, range, TREE_MID);
    }
  }

  /**
   * Renders the sun's depth from three cascades. The near cascade follows the
   * camera every frame; the wider ones refresh every second and fourth frame,
   * which is invisible because they move slowly in screen space.
   */
  private renderShadows() {
    const gl = this.gl;
    const atlas = this.shadows;
    const f = this.shadowFrame++;
    const which = [true, f % 2 === 0, f % 4 === 1 || f < 4];
    const target = this.rig.target;
    const fwd = v3.norm(v3.sub(target, this.eye));
    const right = v3.norm(v3.cross(fwd, [0, 1, 0]));
    const up = v3.cross(right, fwd);
    const focus = v3.dist(this.eye, target);
    const c0 = clamp(focus * 1.7, 140, 2600);
    const far = [c0, Math.min(c0 * 4.5, 9000), Math.min(c0 * 16, 22000)];
    atlas.fit({ eye: this.eye, forward: fwd, right, up, tanY: Math.tan(this.fovY / 2), aspect: this.w / this.h }, SUN_DIR, far, [400, 1500, 4000], which);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.fb);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 3);
    gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < CASCADES; i++) {
      if (!which[i]) continue;
      atlas.viewport(i);
      gl.scissor((i % 2) * atlas.tile, Math.floor(i / 2) * atlas.tile, atlas.tile, atlas.tile);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const vp = atlas.lightVP[i];
      const set = (p: Program) => {
        gl.useProgram(p.prog);
        if (p.u.uViewProj) gl.uniformMatrix4fv(p.u.uViewProj, false, vp);
        if (p.u.uTime) gl.uniform1f(p.u.uTime, this.opts.reducedMotion ? 0 : this.time);
      };
      if (i > 0) {
        set(this.p.depthTerrain);
        this.terrain.draw();
      }
      set(this.p.depthCity);
      this.city.draw();
      set(this.p.depthRoof);
      this.roofs.draw();
      const pl = this.p.depthLit;
      set(pl);
      gl.uniformMatrix4fv(pl.u.uModel, false, IDENTITY);
      this.structures.draw();
      this.groundProps.draw();
      this.urban.draw();
      this.shore.draw();
      this.countryside.draw();
      this.landside.draw();
      this.villageMesh.draw();
      if (i === 2) this.industry.draw();
      if (i < 2) {
        const pm = this.p.depthMover;
        set(pm);
        for (const [k, m] of this.movers) if ((this.moverCount.get(k) ?? 0) > 0) m.draw();
        if (i === 0) {
          const near = frustumPlanes(vp);
          for (const f of this.farm) f.draw(near, this.eye, 700);
        }
        set(pl);
        for (const a of this.parked) {
          gl.uniformMatrix4fv(pl.u.uModel, false, a.matrix);
          this.body.draw();
          this.gearMesh.draw();
        }
        const fleet = [...this.flights.values()];
        if (this.hero.alpha > 0.01) fleet.push(this.hero);
        if (this.depFlight.alpha > 0.01) fleet.push(this.depFlight);
        for (const s of fleet) {
          if (s.alpha < 0.3) continue;
          gl.uniformMatrix4fv(pl.u.uModel, false, s.matrix);
          this.body.draw();
          if (s.gear > 0.5) this.gearMesh.draw();
        }
      }
      // trees, limited to the range where they are drawn at all
      const dt = this.p.depthTree;
      set(dt);
      const planes = frustumPlanes(vp);
      for (const t of this.trees) {
        if (i < 2) t.lo.draw(planes, this.eye, TREE_MID);
        t.sparse.draw(planes, this.eye, i === 2 ? TREE_RANGE * 0.8 : TREE_RANGE, i < 2 ? TREE_MID : 0);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, atlas.tex);
    gl.activeTexture(gl.TEXTURE0);
  }

  private renderReflection() {
    const gl = this.gl;
    const target = this.reflection!;
    // A bounded, half-resolution pass supplies real building and bank
    // reflections without doubling the full-resolution scene workload.
    this.reflectionActive = this.eye[1] < 2200 && this.effects >= 1;
    if (!this.reflectionActive || this.time - this.reflectionAt < 1 / 30) return;
    this.reflectionAt = this.time;
    this.reflected = waterReflection(this.viewProj, this.eye, WATER_LEVEL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawSky(true);
    this.drawWorld(true);
    gl.frontFace(gl.CCW);
    target.resolve();
  }

  private render() {
    const gl = this.gl;
    const scene = this.scene!;
    const dyn = this.buildDynamic();
    const scenic = this.view === 'airport' || this.view === 'riverside';
    const gates = scenic ? { lines: [], panels: [] } : this.buildGates();
    this.updateMovers();
    this.renderShadows();
    this.renderReflection();

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb);
    gl.viewport(0, 0, scene.w, scene.h);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawSky();
    this.drawWorld();

    // translucent and emissive layers
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pcl = this.p.cloud;
    gl.useProgram(pcl.prog);
    this.setCommon(pcl);
    gl.uniform1f(pcl.u.uCoverage, 0.5);
    this.clouds.draw();

    // tyre smoke and wingtip vapour: soft, alpha-blended
    if (this.smoke.length || this.vapour.length || this.steam.length) {
      const sm: number[] = [];
      for (const p of this.steam) {
        const life = p.age / p.life;
        const al = Math.min(1, p.age * 0.4) * (1 - life) * (1 - life) * (p.size > 30 ? 0.42 : p.wood ? 0.22 : 0.3);
        const warm = p.size > 30 ? [0.96, 0.86, 0.76] : p.wood ? [0.5, 0.52, 0.58] : [0.55, 0.52, 0.5];
        sm.push(p.pos[0], p.pos[1], p.pos[2], warm[0], warm[1], warm[2], p.size, 5 + Math.min(0.99, al));
      }
      for (const p of this.smoke) {
        const life = p.age / p.life;
        const al = Math.min(1, p.age * 6) * (1 - life) * 0.55;
        sm.push(p.pos[0], p.pos[1], p.pos[2], 0.5, 0.48, 0.5, p.size, 5 + Math.min(0.99, al));
      }
      for (const p of this.vapour) {
        const life = p.age / p.life;
        const al = Math.min(1, p.age * 10) * (1 - life) * (1 - life) * 0.32;
        sm.push(p.pos[0], p.pos[1], p.pos[2], 0.95, 0.9, 0.86, p.size, 5 + Math.min(0.99, al));
      }
      this.smokePoints.update(new Float32Array(sm), sm.length / 8);
      const pp = this.p.points;
      gl.useProgram(pp.prog);
      this.setCommon(pp);
      this.pointUniforms(pp);
      gl.uniform1f(pp.u.uSoft, 1);
      this.smokePoints.draw(gl.POINTS);
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    const pg = this.p.glow;
    gl.useProgram(pg.prog);
    this.setCommon(pg);
    gl.uniform1f(pg.u.uMode, 0);
    this.gatePanels.update(new Float32Array(gates.panels), gates.panels.length / 9);
    this.gatePanels.draw();
    gl.uniform1f(pg.u.uMode, 1);
    this.beams.update(new Float32Array(scenic ? [] : dyn.beams), scenic ? 0 : dyn.beams.length / 9);
    this.beams.draw();

    const pli = this.p.lines;
    gl.useProgram(pli.prog);
    this.setCommon(pli);
    gl.uniform2f(pli.u.uResolution, scene.w, scene.h);
    gl.uniform1f(pli.u.uPixelRatio, this.dpr);
    this.gateLines.update(new Float32Array(gates.lines));
    this.gateLines.draw();
    this.dynLines.update(new Float32Array(scenic ? [] : dyn.lines));
    this.dynLines.draw();
    // airliners cruising high overhead, each laying a contrail that spreads and fades
    const trails = this.contrails(dyn.points);
    this.contrailLines.update(new Float32Array(trails));
    this.contrailLines.draw();

    const pp = this.p.points;
    gl.useProgram(pp.prog);
    this.setCommon(pp);
    this.pointUniforms(pp);
    gl.uniform1f(pp.u.uSoft, 0);
    this.staticPoints.draw(gl.POINTS);
    this.dynPoints.update(new Float32Array(dyn.points), dyn.points.length / 8);
    this.dynPoints.draw(gl.POINTS);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    scene.resolve();
    this.post();
  }

  /**
   * What the lens is focused on: the story flight, the flight the camera is
   * following, or the aircraft the tower's binoculars track. Wide views of
   * the whole airspace keep everything sharp (0).
   */
  private focusDistance(): number {
    if (this.debugRig) return 0;
    if (this.view === 'story') {
      if (this.story >= 10.4) return 0;
      return v3.dist(this.eye, this.hero.pos);
    }
    const sel = this.selected ? this.flights.get(this.selected) : null;
    if (this.view === 'follow') {
      const s = sel ?? [...this.flights.values()].find((x) => x.alpha > 0.5 && x.input.phase === 'airborne') ?? null;
      return s && s.alpha > 0.3 ? v3.dist(this.eye, s.pos) : 0;
    }
    if (this.view === 'tower' && sel && sel.alpha > 0.3) return v3.dist(this.eye, sel.pos);
    return 0;
  }

  private pointUniforms(pp: Program) {
    const gl = this.gl;
    gl.uniform1f(pp.u.uPixelRatio, this.dpr);
    gl.uniform1f(pp.u.uMotion, this.opts.reducedMotion ? 0 : 1);
    gl.uniform1f(pp.u.uHeight, this.scene!.h);
    gl.uniform1f(pp.u.uFovScale, 1 / Math.tan(this.fov / 2));
    gl.uniform1f(pp.u.uDaylight, smoothstep(0.0, 0.2, SUN_DIR[1]));
  }

  private post() {
    const gl = this.gl;
    const scene = this.scene!;
    gl.bindVertexArray(this.emptyVao);
    // bright pass into the first mip, then a down chain and a tent-filtered up chain
    const first = this.mips[0];
    if (!first) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, first.fb);
    gl.viewport(0, 0, first.w, first.h);
    gl.useProgram(this.p.bright.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.resolved.tex);
    gl.uniform1i(this.p.bright.u.uSrc, 0);
    gl.uniform1f(this.p.bright.u.uThreshold, 1.05);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.p.down.prog);
    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      const dst = this.mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.p.down.u.uSrc, 0);
      gl.uniform2f(this.p.down.u.uTexel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(this.p.up.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      const dst = this.mips[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.p.up.u.uSrc, 0);
      gl.uniform2f(this.p.up.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.p.up.u.uRadius, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // where the sun is on screen, and how much of the frame it can reach
    const sc = transform(this.viewProj, v3.add(this.eye, v3.scale(SUN_DIR, 20000)));
    let sun: Vec3 = [0.5, 0.5, 0];
    if (sc[3] > 0) {
      const u = (sc[0] / sc[3]) * 0.5 + 0.5;
      const v = (sc[1] / sc[3]) * 0.5 + 0.5;
      const inside = smoothstep(-0.25, 0.08, Math.min(u, v)) * smoothstep(-0.25, 0.08, Math.min(1 - u, 1 - v));
      sun = [u, v, inside * (this.view === 'story' || this.view === 'airport' || this.view === 'riverside' || this.view === 'tower' || this.view === 'approach' || this.view === 'follow' ? 1 : 0)];
    }
    const rays = this.raysTarget;
    if (rays && sun[2] > 0.001) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rays.fb);
      gl.viewport(0, 0, rays.w, rays.h);
      const pr = this.p.rays;
      gl.useProgram(pr.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.resolved.tex);
      gl.uniform1i(pr.u.uSrc, 0);
      gl.uniform2f(pr.u.uSunUv, sun[0], sun[1]);
      gl.uniform1f(pr.u.uAspect, this.w / this.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ambient occlusion and depth of field, both from the resolved depth
    const depth = scene.depthTex;
    const aoOn = !!depth && this.effects >= 2 && !!this.aoTarget && !!this.aoBlurTarget;
    if (aoOn) {
      const at = this.aoTarget!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, at.fb);
      gl.viewport(0, 0, at.w, at.h);
      const ps = this.p.ssao;
      gl.useProgram(ps.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, depth);
      gl.uniform1i(ps.u.uDepth, 0);
      gl.uniformMatrix4fv(ps.u.uProj, false, this.proj);
      gl.uniformMatrix4fv(ps.u.uInvProj, false, this.invProj);
      gl.uniform2f(ps.u.uTexel, 1 / scene.w, 1 / scene.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const bt = this.aoBlurTarget!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bt.fb);
      const pb = this.p.aoblur;
      gl.useProgram(pb.prog);
      gl.uniform1i(pb.u.uDepth, 0);
      gl.uniformMatrix4fv(pb.u.uInvProj, false, this.invProj);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, at.tex);
      gl.uniform1i(pb.u.uAo, 1);
      gl.uniform2f(pb.u.uAoTexel, 1 / at.w, 1 / at.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const focus = this.focusDistance();
    const dofOn = !!depth && this.effects >= 2 && !!this.dofTarget && focus > 0;
    if (dofOn) {
      const dt = this.dofTarget!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dt.fb);
      gl.viewport(0, 0, dt.w, dt.h);
      const pd = this.p.dof;
      gl.useProgram(pd.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, depth);
      gl.uniform1i(pd.u.uDepth, 0);
      gl.uniformMatrix4fv(pd.u.uInvProj, false, this.invProj);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, scene.resolved.tex);
      gl.uniform1i(pd.u.uScene, 1);
      gl.uniform2f(pd.u.uTexel, 1 / dt.w, 1 / dt.h);
      gl.uniform1f(pd.u.uFocus, focus);
      // A full-frame cine lens at f/1.8: focal length from the field of view,
      // blur from the thin-lens equation. Distant landscapes stay sharp, as
      // through a real camera; long lenses throw near grass and far haze soft.
      const fMetres = 0.012 / Math.tan(this.fovY / 2);
      const blurOnSensor = (fMetres * fMetres) / (1.8 * Math.max(focus - fMetres, 0.5));
      gl.uniform1f(pd.u.uAperture, (blurOnSensor / 0.024) * dt.h * 0.5);
      const maxCoc = Math.min(12, dt.h / 45);
      gl.uniform1f(pd.u.uMaxCoc, maxCoc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const pc = this.p.comp;
    gl.useProgram(pc.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.resolved.tex);
    gl.uniform1i(pc.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, first.tex);
    gl.uniform1i(pc.u.uBloom, 1);
    gl.uniform1f(pc.u.uBloomStrength, 0.32);
    gl.uniform1f(pc.u.uExposure, 1.08);
    gl.uniform1f(pc.u.uTime, this.time);
    gl.uniform1f(pc.u.uDim, this.dim);
    gl.uniform1f(pc.u.uAberration, 0.0016);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, rays ? rays.tex : null);
    gl.uniform1i(pc.u.uRays, 2);
    gl.uniform3f(pc.u.uSun, sun[0], sun[1], sun[2]);
    gl.uniform1f(pc.u.uAspect, this.w / this.h);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, aoOn ? this.aoBlurTarget!.tex : null);
    gl.uniform1i(pc.u.uAo, 3);
    gl.uniform1f(pc.u.uAoOn, aoOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, dofOn ? this.dofTarget!.tex : null);
    gl.uniform1i(pc.u.uDof, 4);
    gl.uniform1f(pc.u.uDofOn, dofOn ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  private report() {
    const cb = this.opts.onFrame;
    if (!cb) return;
    const tags: TagPosition[] = [];
    for (const s of this.flights.values()) {
      const p = this.project(v3.add(s.pos, [0, 6 * s.scale, 0]));
      const knots = Math.round(v3.len(s.vel) * 1.944 * 0.45);
      tags.push({ id: s.id, x: p.x, y: p.y, visible: p.visible && s.alpha > 0.05, alpha: s.alpha, altitude: Math.max(0, s.pos[1] - GROUND_Y), speed: knots });
    }
    const gates: GateLabel[] = GATES.map((c, k) => {
      const tan = tangentAt(k);
      const flat = v3.norm([tan[0], 0, tan[2]]);
      const side = v3.norm(v3.cross([0, 1, 0], flat));
      const [hw, hh] = GATE_SIZE[k];
      const center: Vec3 = k >= 7 ? [c[0], RUNWAY.y + hh + 1, c[2]] : c;
      const corner = v3.add(center, v3.add(v3.scale(side, -hw), [0, hh, 0]));
      const p = this.project(corner);
      return { index: k, x: p.x, y: p.y, visible: p.visible, active: this.gateHeat[k], distance: v3.dist(this.eye, center) };
    });
    let hero: HeroInfo | null = null;
    if (this.view === 'story') {
      const p = this.project(this.hero.pos);
      const p0 = this.hero.display;
      const speed = p0 < 7 ? 140 - Math.max(0, p0 - 3) * 2.5 : Math.max(18, 132 - (p0 - 7) * 40);
      hero = { x: p.x, y: p.y, visible: p.visible, altitude: Math.max(0, this.hero.pos[1] - GROUND_Y - RUNWAY.y), speed: Math.round(speed), gate: clamp(Math.ceil(p0 - 0.001), 0, 9) };
    }
    cb(tags, gates, hero);
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A bird in silhouette: a slim body and two swept wings whose tips flap (aWing = +-1). */
function buildBird(gl: GL): Mesh {
  const v = [
    // x y z wing
    0.5, 0, 0, 0, 0.05, 0.03, 0.07, 0, -0.5, 0, 0, 0, 0.05, 0.03, -0.07, 0,
    0.18, 0, 0, 0, -0.12, 0, 0, 0, -0.08, 0.05, -1.0, -1,
    0.18, 0, 0, 0, -0.12, 0, 0, 0, -0.08, 0.05, 1.0, 1,
    -0.5, 0, 0, 0, -0.62, 0, -0.12, 0, -0.62, 0, 0.12, 0,
  ];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 1 }], new Float32Array(v), new Uint16Array(idx));
}

/** One tuft: seven tapering blades fanned around a point, each a single triangle. */
function buildGrassTuft(gl: GL): Mesh {
  const data: number[] = [];
  const idx: number[] = [];
  const r = rng(77);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + r() * 0.6;
    const out: [number, number] = [Math.cos(a), Math.sin(a)];
    const side: [number, number] = [-out[1], out[0]];
    const root = 0.02 + r() * 0.05;
    const h = 0.26 + r() * 0.16;
    const lean = 0.05 + r() * 0.12;
    const w = 0.016 + r() * 0.01;
    const nrm: Vec3 = v3.norm([side[0], 0.35, side[1]]);
    const base = data.length / 6;
    data.push(out[0] * root + side[0] * w, 0, out[1] * root + side[1] * w, ...nrm);
    data.push(out[0] * root - side[0] * w, 0, out[1] * root - side[1] * w, ...nrm);
    data.push(out[0] * (root + lean), h, out[1] * (root + lean), ...nrm);
    idx.push(base, base + 1, base + 2);
  }
  return new Mesh(gl, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], new Float32Array(data), new Uint16Array(idx));
}
