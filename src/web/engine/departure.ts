// The airport's own departures, between the live arrivals: an airliner is
// pushed back from its stand by a tractor, starts its engines, taxis out
// along the apron and the parallel taxiway, holds short while anything is on
// final or on the runway, lines up, rolls, rotates and climbs out to the
// east. Then a fresh aircraft is boarded on the same stand, out of the
// camera's sight. The departure is a small state machine; positions inside
// each phase are closed-form functions of the time spent in it.

import { clamp, smoothstep, type Vec3 } from './math.ts';
import { DEPARTURE_STAND, STANDS } from './world/airport.ts';
import { Path, roundCorners, type Pose } from './world/traffic.ts';

/** Height of the aircraft's reference point above the ground (as for arrivals). */
export const GROUND_REF = 3.6;

export type DeparturePhase = 'parked' | 'pushback' | 'start' | 'taxi' | 'hold' | 'lineup' | 'roll' | 'climb' | 'gone';

export interface DepartureState {
  phase: DeparturePhase;
  visible: boolean;
  pos: Vec3;
  /** Flat unit heading of the nose. */
  heading: Vec3;
  pitch: number;
  bank: number;
  gear: number;
  flaps: number;
  fanSpeed: number;
  beacon: boolean;
  strobes: boolean;
  landing: boolean;
  taxi: boolean;
  /** The pushback tractor, while it is out on the apron. */
  tug: Pose | null;
}

const STAND = STANDS[DEPARTURE_STAND];
const SX = STAND.x;
const SZ = STAND.z - 2;
/** Where the tractor waits between departures, beside the starboard wing tip. */
const TUG_HOME: [number, number] = [SX - 22, 414];
const NOSE_GEAR = 12.6;
const TUG_REACH = 2.6;
const ROTATE = 74;
const ACCEL = 1.75;

function flat(p: [number, number][], y = 0): Path {
  return new Path(p.map(([x, z]) => [x, y, z] as Vec3));
}

/** The tractor's loop from its spot to the nose wheel: west, round, east, south. */
const TUG_APPROACH = flat(roundCorners([TUG_HOME, [SX - 36, 414], [SX - 36, 428], [SX, 428], [SX, SZ + NOSE_GEAR + TUG_REACH]], 5, false, 1));
/** After pushback the tractor is in front of the nose, facing east: it reverses round to face north... */
const PUSHED: [number, number] = [SX + 40 - NOSE_GEAR - TUG_REACH, 296];
const TUG_REVERSE = flat(roundCorners([PUSHED, [PUSHED[0] - 12, 296], [PUSHED[0] - 12, 284]], 12, false, 1));
/** ...then drives north past the aircraft's nose and home under the jet bridge. */
const TUG_RETURN = flat(roundCorners([[PUSHED[0] - 12, 284], [PUSHED[0] - 12, 414], TUG_HOME], 9, false, 1.5));

/** Tail first: straight back off the stand, then swung to face west. */
export const PUSHBACK_PATH = flat(roundCorners([[SX, SZ], [SX, 296], [SX + 40, 296]], 40, false, 2));
/** From the end of the pushback to the runway: apron taxilane, connector, parallel taxiway, entry link. */
export const TAXI_PATH = flat(roundCorners([[SX + 40, 296], [900, 296], [900, 190], [-120, 190], [-62, 78], [-18, 24], [32, 0], [48, 0]], 34, false, 4));
const HOLD_AT = (() => {
  const pose: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  let best = 0;
  let bestD = Infinity;
  for (let d = 0; d < TAXI_PATH.length; d += 1) {
    TAXI_PATH.sample(d, pose);
    const dd = Math.hypot(pose.x + 72, pose.z - 98);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
})();
const TAXI_SPEED = 9;

/**
 * Trapezoidal speed profile over a distance: accelerate at `a`, cruise at
 * `v`, brake at `a` to a stop. Returns the distance covered after `t`
 * seconds and the total duration.
 */
export function rollProfile(dist: number, v: number, a: number, t: number): { s: number; duration: number } {
  const vm = Math.min(v, Math.sqrt(dist * a));
  const ta = vm / a;
  const cruise = Math.max(0, dist / vm - ta);
  const duration = 2 * ta + cruise;
  let s: number;
  if (t <= 0) s = 0;
  else if (t < ta) s = 0.5 * a * t * t;
  else if (t < ta + cruise) s = 0.5 * vm * ta + vm * (t - ta);
  else if (t < duration) {
    const tb = t - ta - cruise;
    s = 0.5 * vm * ta + vm * cruise + vm * tb - 0.5 * a * tb * tb;
  } else s = dist;
  return { s: Math.min(dist, s), duration };
}

export class Departure {
  phase: DeparturePhase = 'parked';
  private t = 0;
  private wait = 0;
  readonly state: DepartureState;

  constructor(startPhase: DeparturePhase = 'parked', startTime = 0) {
    this.phase = startPhase;
    this.t = startTime;
    this.state = {
      phase: startPhase, visible: true, pos: [SX, GROUND_REF, SZ], heading: [0, 0, 1], pitch: 0, bank: 0,
      gear: 1, flaps: 0, fanSpeed: 0, beacon: false, strobes: false, landing: false, taxi: false, tug: null,
    };
    this.pose(0);
  }

  /**
   * Advances the departure. `runway` is 0 when clear, 1 while an arrival is
   * on the approach and 2 while one is on short final or rolling out: the
   * departure holds short for both, but after a long wait it will go ahead
   * of a distant arrival, never in front of a close one. `standInView`
   * delays boarding a fresh aircraft while someone is watching the empty stand.
   */
  step(dt: number, runway: number | boolean, standInView: boolean): DepartureState {
    const traffic = typeof runway === 'boolean' ? (runway ? 2 : 0) : runway;
    this.t += dt;
    const t = this.t;
    const next = (p: DeparturePhase) => { this.phase = p; this.t = 0; };
    switch (this.phase) {
      case 'parked': if (t > 46) next('pushback'); break;
      case 'pushback': if (t > rollProfile(PUSHBACK_PATH.length, 1.5, 0.35, 0).duration + 1) next('start'); break;
      case 'start': if (t > 16) next('taxi'); break;
      case 'taxi': if (t > this.taxiTime(HOLD_AT) + 0.5) next('hold'); break;
      case 'hold':
        this.wait = traffic > 0 ? 0 : this.wait + dt;
        if ((this.wait > 4 && t > 8) || (t > 150 && traffic < 2)) { this.wait = 0; next('lineup'); }
        break;
      case 'lineup': if (t > rollProfile(TAXI_PATH.length - HOLD_AT, 5, 0.6, 0).duration + 7) next('roll'); break;
      case 'roll': if (t > ROTATE / ACCEL + 2.5) next('climb'); break;
      case 'climb': if (t > 150) next('gone'); break;
      case 'gone': if (t > 20 && (!standInView || t > 75)) next('parked'); break;
    }
    this.state.phase = this.phase;
    this.pose(this.t);
    return this.state;
  }

  private taxiTime(dist: number): number {
    return rollProfile(dist, TAXI_SPEED, 0.5, 0).duration;
  }

  private pose(t: number) {
    const s = this.state;
    const p: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
    s.visible = this.phase !== 'gone';
    s.pitch = 0;
    s.bank = 0;
    s.gear = 1;
    s.tug = null;
    s.strobes = false;
    s.landing = false;
    s.taxi = false;
    const setPose = (x: number, y: number, z: number, heading: number) => {
      s.pos = [x, y, z];
      s.heading = [Math.cos(heading), 0, Math.sin(heading)];
    };
    const tugAtNose = () => {
      const h = Math.atan2(s.heading[2], s.heading[0]);
      const r = NOSE_GEAR + TUG_REACH;
      s.tug = { x: s.pos[0] + s.heading[0] * r, y: 0.17, z: s.pos[2] + s.heading[2] * r, heading: h + Math.PI, pitch: 0 };
    };
    const home: Pose = { x: TUG_HOME[0], y: 0.17, z: TUG_HOME[1], heading: Math.PI, pitch: 0 };
    switch (this.phase) {
      case 'parked': {
        setPose(SX, GROUND_REF, SZ, Math.PI / 2);
        s.flaps = 0;
        s.fanSpeed = 0;
        s.beacon = t > 34;
        // the tractor loops round from its spot and cups the nose wheel
        const d = rollProfile(TUG_APPROACH.length, 3.2, 0.8, t - 22).s;
        TUG_APPROACH.sample(d, p);
        s.tug = { x: p.x, y: 0.17, z: p.z, heading: p.heading, pitch: 0 };
        break;
      }
      case 'pushback': {
        const d = rollProfile(PUSHBACK_PATH.length, 1.5, 0.35, t).s;
        PUSHBACK_PATH.sample(d, p);
        // moving tail first: the nose points back along the path
        setPose(p.x, GROUND_REF, p.z, p.heading + Math.PI);
        s.beacon = true;
        s.fanSpeed = smoothstep(10, 40, t) * 2.5;
        tugAtNose();
        break;
      }
      case 'start': {
        const end = PUSHBACK_PATH.sample(PUSHBACK_PATH.length, p);
        setPose(end.x, GROUND_REF, end.z, end.heading + Math.PI);
        s.beacon = true;
        s.fanSpeed = 2.5 + smoothstep(0, 10, t) * 1.5;
        s.flaps = smoothstep(6, 14, t) * 0.42;
        // the tractor backs away in an arc until it faces north, then drives home
        const back = rollProfile(TUG_REVERSE.length, 2, 0.8, t - 3);
        if (back.s < TUG_REVERSE.length) {
          TUG_REVERSE.sample(back.s, p);
          s.tug = { x: p.x, y: 0.17, z: p.z, heading: p.heading + Math.PI, pitch: 0 };
        } else {
          TUG_RETURN.sample(rollProfile(TUG_RETURN.length, 4.5, 0.9, t - 3 - back.duration).s, p);
          s.tug = { x: p.x, y: 0.17, z: p.z, heading: p.heading, pitch: 0 };
        }
        break;
      }
      case 'taxi':
      case 'hold':
      case 'lineup': {
        let d: number;
        if (this.phase === 'taxi') d = rollProfile(HOLD_AT, TAXI_SPEED, 0.5, t).s;
        else if (this.phase === 'hold') d = HOLD_AT;
        else d = HOLD_AT + rollProfile(TAXI_PATH.length - HOLD_AT, 5, 0.6, t).s;
        TAXI_PATH.sample(d, p);
        setPose(p.x, GROUND_REF, p.z, p.heading);
        s.beacon = true;
        s.fanSpeed = 4;
        s.flaps = 0.42;
        s.taxi = true;
        s.strobes = this.phase === 'lineup';
        s.landing = this.phase === 'lineup' && d > TAXI_PATH.length - 40;
        s.tug = home;
        break;
      }
      case 'roll':
      case 'climb': {
        const start = TAXI_PATH.sample(TAXI_PATH.length, p);
        const x0 = start.x;
        const tr = ROTATE / ACCEL;
        let x: number;
        let y = GROUND_REF;
        let z = 0;
        let heading = 0;
        if (this.phase === 'roll') {
          x = x0 + 0.5 * ACCEL * t * t;
          // rotation: the nose comes up over three seconds
          s.pitch = smoothstep(tr, tr + 3, t) * 0.16;
          y = GROUND_REF + Math.max(0, t - tr - 1.6) * 1.2 * smoothstep(tr + 1.6, tr + 2.5, t);
        } else {
          // initial climb: 74 → 90 m/s, vertical speed building to 12 m/s,
          // a gentle right turn once established
          const x1 = x0 + 0.5 * ACCEL * (tr + 2.5) * (tr + 2.5);
          const v = (tc: number) => Math.min(90, ROTATE + ACCEL * 2.5 + tc * 0.9);
          const along = (tc: number) => {
            const n = 24;
            let sum = 0;
            for (let i = 0; i < n; i++) sum += v(((i + 0.5) / n) * tc);
            return (sum / n) * tc;
          };
          const dist = along(t);
          const turnStart = 4200;
          const radius = 9000;
          if (dist < turnStart) {
            x = x1 + dist;
          } else {
            const a = (dist - turnStart) / radius;
            x = x1 + turnStart + Math.sin(a) * radius;
            z = (1 - Math.cos(a)) * radius;
            heading = a;
            s.bank = 0.26 * smoothstep(0, 0.1, a);
          }
          const climbed = 1.2 * 0.9 + Math.min(t, 6) * Math.min(t, 6) * 0.9 + Math.max(0, t - 6) * 12;
          y = GROUND_REF + climbed;
          s.pitch = 0.16 + 0.04 * smoothstep(0, 5, t) - 0.05 * smoothstep(60, 110, t);
        }
        setPose(x, y, z, heading);
        s.tug = home;
        const airborne = this.phase === 'climb' ? t + 2.5 : Math.max(0, t - tr - 2);
        s.gear = 1 - smoothstep(4, 10, this.phase === 'climb' ? t : 0);
        s.flaps = 0.42 * (1 - smoothstep(25, 45, this.phase === 'climb' ? t : 0));
        s.fanSpeed = 14 - (this.phase === 'climb' ? smoothstep(30, 60, t) * 2 : 0);
        s.beacon = true;
        s.strobes = true;
        s.landing = y < 900;
        s.taxi = this.phase === 'roll';
        void airborne;
        break;
      }
      case 'gone': {
        setPose(SX, GROUND_REF, SZ, Math.PI / 2);
        s.visible = false;
        s.tug = home;
        break;
      }
    }
    s.pitch = clamp(s.pitch, -0.2, 0.3);
  }
}
