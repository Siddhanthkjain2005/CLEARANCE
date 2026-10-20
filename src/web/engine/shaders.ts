// GLSL ES 3.0 shaders for the dusk airport.
//
// Every surface shares one sky model, so fog, reflections and the sky dome
// agree: distant terrain fades into exactly the colour of the horizon behind
// it (aerial perspective), and glossy aircraft paint reflects the same sunset.

import { HYDROLOGY_GLSL } from './world/hydrology.ts';

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

/** Uniforms and functions shared by every 3D program. */
const COMMON = `
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uFog;
uniform float uClipWater;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Gradient noise: zero on the lattice with a random slope at each node. Unlike
// value noise its slope never flattens along the lattice lines, so it can
// bump normals under a grazing sun without printing a grid of squares.
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a0 = hash12(i) * 6.2831853, a1 = hash12(i + vec2(1, 0)) * 6.2831853;
  float a2 = hash12(i + vec2(0, 1)) * 6.2831853, a3 = hash12(i + vec2(1, 1)) * 6.2831853;
  float n0 = dot(vec2(cos(a0), sin(a0)), f);
  float n1 = dot(vec2(cos(a1), sin(a1)), f - vec2(1, 0));
  float n2 = dot(vec2(cos(a2), sin(a2)), f - vec2(0, 1));
  float n3 = dot(vec2(cos(a3), sin(a3)), f - vec2(1, 1));
  return mix(mix(n0, n1, u.x), mix(n2, n3, u.x), u.y);
}
// Slope of two rotated octaves of gradient noise at p (per unit of p).
vec2 bumpSlope(vec2 p) {
  const mat2 R1 = mat2(0.8, 0.6, -0.6, 0.8);
  const mat2 R2 = mat2(0.28, -0.96, 0.96, 0.28);
  const float e = 0.05;
  vec2 q = R1 * p;
  vec2 r = R2 * p * 2.13 + 5.7;
  float h = gnoise(q) + 0.5 * gnoise(r);
  float hx = gnoise(q + R1 * vec2(e, 0.0)) + 0.5 * gnoise(r + R2 * vec2(e * 2.13, 0.0));
  float hz = gnoise(q + R1 * vec2(0.0, e)) + 0.5 * gnoise(r + R2 * vec2(0.0, e * 2.13));
  return vec2(hx - h, hz - h) * (0.6 / e);
}

// Dusk sky: Rayleigh-like gradient, warm forward scattering toward the sun,
// the pink "belt of Venus" opposite it. skyBase has no sun disk, so haze and
// reflections can use it without a second sun appearing in them.
vec3 skyBase(vec3 dir) {
  vec3 d = normalize(dir);
  float e = d.y;
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
  vec3 dFlat = normalize(vec3(d.x, 0.0001, d.z));
  float toward = max(dot(dFlat, sunFlat), 0.0);
  float away = max(-dot(dFlat, sunFlat), 0.0);
  float sunDot = max(dot(d, uSunDir), 0.0);

  vec3 zenith = vec3(0.038, 0.074, 0.145);
  vec3 upper = vec3(0.16, 0.23, 0.32);
  vec3 horizonCool = vec3(0.36, 0.39, 0.44);
  vec3 horizonWarm = vec3(0.78, 0.48, 0.30);
  vec3 horizon = mix(horizonCool, horizonWarm, pow(toward, 2.4));
  horizon += vec3(0.10, 0.055, 0.075) * pow(away, 1.6);

  float h = clamp(e, 0.0, 1.0);
  vec3 col = mix(horizon, upper, smoothstep(0.0, 0.22, h));
  col = mix(col, zenith, smoothstep(0.18, 0.85, h));
  // warm glow hugging the horizon toward the sun
  col += vec3(0.48, 0.22, 0.09) * pow(toward, 6.0) * exp(-max(e, 0.0) * 12.0);
  // mie scattering around the sun
  col += vec3(0.62, 0.37, 0.19) * pow(sunDot, 24.0) * 0.45 + vec3(1.0, 0.69, 0.38) * pow(sunDot, 350.0) * 1.2;
  // below the horizon: the distant ground haze, continuous with the horizon
  if (e < 0.0) {
    vec3 ground = mix(vec3(0.085, 0.105, 0.115), vec3(0.18, 0.135, 0.105), pow(toward, 2.0));
    col = mix(col, ground, 1.0 - smoothstep(-0.10, 0.0, e));
  }
  return col;
}

vec3 skyColor(vec3 dir) {
  vec3 d = normalize(dir);
  return skyBase(d) + vec3(8.0, 5.3, 2.8) * smoothstep(0.99977, 0.9999, max(dot(d, uSunDir), 0.0));
}

// The light the low air itself scatters toward the eye. Looking up it is the
// sky; looking level or down it stays the horizon's colour (it is the same
// air), only a little darker over the ground. It is continuous at eye level,
// so distant land never shows a seam where it crosses the horizon line.
vec3 hazeColor(vec3 dir) {
  vec3 d = normalize(dir);
  if (d.y >= 0.0) return skyBase(d);
  vec2 f = d.xz / max(length(d.xz), 1e-4);
  vec3 level = skyBase(vec3(f.x, 0.0, f.y));
  return level * (1.0 - 0.24 * (1.0 - smoothstep(-0.65, 0.0, d.y)));
}

// Aerial perspective: denser near the ground, fading into the sky behind.
// On top of it, the evening mist: a thin layer lying a few metres deep over
// the river, the lake and the low fields, thickest at the water and in
// drifting banks, lit by the low sun like the rest of the haze. Its optical
// depth is the exact integral of an exponential layer along the view ray.
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 v = wp - uEye;
  float dist = length(v);
  float hmid = max(0.0, (wp.y + uEye.y) * 0.5);
  float density = uFog * (0.2 + 0.8 * exp(-hmid / 850.0));
  float depth = dist * density;
  const float H = 13.0;
  float ya = max(uEye.y + 5.0, 0.0);
  float yb = max(wp.y + 5.0, 0.0);
  float ea = exp(-ya / H);
  float eb = exp(-yb / H);
  float dy = yb - ya;
  float layer = abs(dy) > 0.05 ? dist * H * (ea - eb) / dy : dist * ea;
  float banks = 0.35 + 0.65 * smoothstep(0.3, 0.75, vnoise(wp.xz * 0.0011 + vec2(uTime * 0.004, 0.0)));
  depth += layer * 0.00011 * banks;
  float f = 1.0 - exp(-depth);
  vec3 dir = v / max(dist, 1e-3);
  return mix(col, hazeColor(dir) * 0.88, clamp(f, 0.0, 1.0));
}

// Artificial light: apron floodlight masts and the landing lights of aircraft
// near the ground, so the runway brightens ahead of a landing aircraft.
uniform vec4 uFloods[12];   // xyz position, intensity
uniform vec4 uSpots[6];     // xyz position, intensity
uniform vec4 uSpotDirs[6];  // xyz direction, cos of the half-angle
vec3 localLight(vec3 wp, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    if (uSpots[i].w <= 0.0) continue;
    vec3 d = wp - uSpots[i].xyz;
    float dist2 = max(dot(d, d), 1.0);
    vec3 l = d * inversesqrt(dist2);
    float c = dot(l, uSpotDirs[i].xyz);
    float cone = smoothstep(uSpotDirs[i].w, mix(uSpotDirs[i].w, 1.0, 0.6), c);
    sum += vec3(1.0, 0.96, 0.9) * uSpots[i].w * cone * max(dot(n, -l), 0.0) * 4000.0 / (dist2 + 400.0);
  }
  for (int i = 0; i < 12; i++) {
    if (uFloods[i].w <= 0.0) continue;
    vec3 d = wp - uFloods[i].xyz;
    float dist2 = max(dot(d, d), 1.0);
    vec3 l = d * inversesqrt(dist2);
    float lambert = max(dot(n, -l), 0.0);
    sum += vec3(1.0, 0.74, 0.44) * uFloods[i].w * lambert * 2600.0 / (dist2 + 900.0);
  }
  return sum;
}

// Cascaded sun shadows (see shadows.ts): three tiles in one depth atlas.
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uShadowMat[3];
uniform vec4 uShadowSplits;  // far distance of each cascade; w = 1 when on
uniform vec4 uShadowTexel;   // world texel size per cascade; w = 1 / atlas size
float sunShadowMap(vec3 wp, vec3 n) {
  if (uShadowSplits.w < 0.5) return 1.0;
  float d = length(wp - uEye);
  if (d > uShadowSplits.z) return 1.0;
  int i = d < uShadowSplits.x ? 0 : (d < uShadowSplits.y ? 1 : 2);
  float texel = i == 0 ? uShadowTexel.x : (i == 1 ? uShadowTexel.y : uShadowTexel.z);
  // normal offset keeps grazing surfaces from shadowing themselves
  float slope = 1.0 - abs(dot(n, uSunDir));
  vec3 p = wp + n * texel * (1.2 + 2.2 * slope) + uSunDir * texel * 0.6;
  vec4 c = uShadowMat[i] * vec4(p, 1.0);
  float k = uShadowTexel.w;
  float s = 0.0;
  s += texture(uShadowMap, vec3(c.xy + vec2(-0.7, -0.7) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(0.7, -0.7) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(-0.7, 0.7) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(0.7, 0.7) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(-1.6, 0.2) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(1.6, -0.2) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(0.2, 1.6) * k, c.z));
  s += texture(uShadowMap, vec3(c.xy + vec2(-0.2, -1.6) * k, c.z));
  s *= 0.125;
  float fade = smoothstep(uShadowSplits.z * 0.8, uShadowSplits.z, d);
  return mix(s, 1.0, fade);
}

float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s + 0.045;
}

// Shadows of the broken cumulus overhead: patches of light and shade a few
// kilometres across, drawn out along the sun's bearing as low-sun shadows
// are, drifting with the wind across fields, woods and the city alike.
float cloudShadow(vec3 wp) {
  vec2 sd = normalize(uSunDir.xz);
  vec2 st = vec2(dot(wp.xz, sd) * 0.42, dot(wp.xz, vec2(-sd.y, sd.x)));
  vec2 p = st * 0.00038 + vec2(uTime * 0.0021, uTime * 0.0034);
  float d = fbm3(p + vec2(fbm3(p * 0.8 + 8.0), fbm3(p * 0.6 - 3.0)) * 0.7);
  return 1.0 - 0.6 * smoothstep(0.5, 0.64, d);
}

float sunShadow(vec3 wp, vec3 n) {
  return sunShadowMap(wp, n) * cloudShadow(wp);
}

vec3 hemiAmbient(vec3 n) {
  vec3 skyAmb = vec3(0.28, 0.33, 0.40);
  vec3 gndAmb = vec3(0.11, 0.09, 0.066);
  return mix(gndAmb, skyAmb, n.y * 0.5 + 0.5);
}
`;

export const FULLSCREEN_VS = `${HEADER}
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
out vec2 vUv;
void main(){ vec2 p = P[gl_VertexID]; vUv = p*0.5+0.5; gl_Position = vec4(p,0.9999,1.0); }`;

export const SKY_FS = `${HEADER}${COMMON}
in vec2 vUv;
uniform mat4 uInvViewProj;
out vec4 o;
void main(){
  vec4 a = uInvViewProj * vec4(vUv*2.0-1.0, 1.0, 1.0);
  vec4 b = uInvViewProj * vec4(vUv*2.0-1.0, -1.0, 1.0);
  vec3 dir = normalize(a.xyz/a.w - b.xyz/b.w);
  vec3 col = skyColor(dir);
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
  float toward = max(dot(normalize(vec3(dir.x, 0.0001, dir.z)), sunFlat), 0.0);
  float sunDot = max(dot(dir, uSunDir), 0.0);
  // the moon, nearly full, rising in the east as the sun sets: its seas
  // picked out in grey, a slight warmth from the low sky, a faint halo
  vec3 moonDir = normalize(vec3(0.97, 0.15, 0.12));
  float md = dot(dir, moonDir);
  const float moonR = 0.0078;
  if (md > cos(moonR * 6.0)) {
    vec3 mu = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
    vec3 mv = cross(mu, moonDir);
    vec2 q = vec2(dot(dir, mu), dot(dir, mv)) / moonR;
    float rr = length(q);
    float disk = 1.0 - smoothstep(0.93, 1.0, rr);
    float seas = vnoise(q * 1.9 + 3.7) * 0.55 + vnoise(q * 4.3 + 1.1) * 0.3 + vnoise(q * 9.0) * 0.15;
    float limb = sqrt(max(0.0, 1.0 - rr * rr));
    float lit = smoothstep(-0.82, -0.6, q.x);
    vec3 face = vec3(1.0, 0.94, 0.82) * (0.92 - 0.3 * smoothstep(0.42, 0.66, seas)) * (0.75 + 0.25 * limb) * 1.25;
    col = mix(col, mix(col * 1.05, face, lit), disk);
    col += vec3(0.5, 0.48, 0.45) * exp(-rr * 1.6) * 0.05 * (1.0 - disk);
  }
  // high cirrus: wind-combed streaks on a plane 8 km up, lit gold toward the sun
  if (dir.y > 0.015) {
    vec2 pc = dir.xz / dir.y * 0.62 + vec2(uTime * 0.0012, 0.0);
    float streak = fbm(vec2(pc.x * 0.8 + pc.y * 0.4, pc.y * 4.2 - pc.x * 0.6) + 3.0) * 0.7 + fbm(pc * 6.0 + 9.0) * 0.3;
    float cir = smoothstep(0.56, 0.82, streak) * smoothstep(0.015, 0.12, dir.y) * (1.0 - smoothstep(0.35, 0.8, dir.y)) * 0.55;
    vec3 cirCol = mix(vec3(0.62, 0.62, 0.66), vec3(1.25, 0.78, 0.48), pow(toward, 2.5)) * (0.85 + 0.6 * pow(sunDot, 6.0));
    col = mix(col, cirCol, cir * 0.42);
  }
  // a distant bank of cumulus sitting on the horizon, rim-lit where it faces the sun
  float az = atan(dir.z, dir.x);
  float e = dir.y;
  float bank = fbm(vec2(az * 7.0, e * 42.0) + vec2(11.0, uTime * 0.004)) * 0.75 + fbm(vec2(az * 23.0, e * 120.0) + 4.0) * 0.25;
  float top = 0.018 + 0.05 * fbm(vec2(az * 3.0, 1.7));
  float cloud = smoothstep(0.46, 0.62, bank) * (1.0 - smoothstep(top * 0.4, top, e)) * smoothstep(-0.01, 0.004, e);
  if (cloud > 0.002) {
    float lit = smoothstep(0.5, 0.7, fbm(vec2(az * 7.0, e * 42.0 + 0.8) + vec2(11.0, uTime * 0.004)));
    vec3 shadowSide = mix(vec3(0.32, 0.34, 0.4), vec3(0.42, 0.3, 0.3), pow(toward, 2.0));
    vec3 litSide = mix(vec3(0.75, 0.7, 0.72), vec3(1.6, 0.92, 0.55), pow(toward, 3.0));
    vec3 cc = mix(shadowSide, litSide, lit * 0.7 + 0.15);
    // silver lining where the sun is just behind a cloud
    cc += vec3(2.4, 1.5, 0.8) * pow(sunDot, 40.0) * (1.0 - smoothstep(0.55, 0.75, bank));
    col = mix(col, cc, cloud * 0.92);
  }
  // stars where the sky is dark enough
  if (dir.y > 0.05) {
    vec2 sp = vec2(atan(dir.z, dir.x), asin(dir.y)) * 420.0;
    vec2 cell = floor(sp);
    float h = hash12(cell);
    if (h > 0.985) {
      vec2 f = fract(sp) - 0.5 - (vec2(hash12(cell + 7.0), hash12(cell + 13.0)) - 0.5) * 0.6;
      float star = exp(-dot(f, f) * 60.0) * (h - 0.985) * 66.0;
      float dark = 1.0 - smoothstep(0.05, 0.35, dot(col, vec3(0.33)));
      col += vec3(0.8, 0.85, 1.0) * star * dark * smoothstep(0.05, 0.4, dir.y) * (0.7 + 0.3 * sin(uTime * 2.0 + h * 90.0));
    }
  }
  o = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- lit meshes

export const LIT_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aMat;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out vec2 vMat;
out vec3 vLocal;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vLocal = aPos;
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vMat = aMat;
  gl_Position = uViewProj * w;
}`;

export const LIT_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in vec2 vMat;
in vec3 vLocal;
uniform float uEmissiveBoost;
uniform vec3 uTint;      // livery primary colour
uniform vec3 uTint2;     // livery accent colour
uniform float uLivery;   // 1 while drawing an airliner
uniform sampler2D uLiveryTex; // r: fuselage titles, g: tail logo
uniform float uOpacity;
out vec4 o;

bool near3(vec3 a, vec3 b) { return all(lessThan(abs(a - b), vec3(0.0004))); }

// how strongly the logo lights in the tailplane wash this fragment (set by livery)
float logoWash = 0.0;
uniform float uLogoLights;

/*
 * Interior mapping for architectural glazing (gloss flagged above 1.5): the
 * view ray is carried on through the glass into a virtual room, a box of
 * floor, ceiling, side and back walls cut by the building's grid of storeys
 * and bays, so lit halls and offices show true parallax as the camera moves.
 * At dusk most rooms are lit, warm or cool, under rows of ceiling panels.
 */
vec3 interiorRoom(vec3 wp, vec3 n, vec3 viewDir, float storey) {
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 d = -n;
  // tall storeys are halls (a terminal concourse): long, deep and evenly lit
  float hall = step(4.5, storey);
  vec3 room = vec3(mix(8.4, 42.0, hall), storey, mix(14.0, 30.0, hall));
  vec2 uv = vec2(dot(wp, t), wp.y);
  vec2 cell = floor(uv / room.xy);
  vec3 pos = vec3(fract(uv / room.xy) * room.xy, 0.0);
  vec3 dir = vec3(dot(viewDir, t), viewDir.y, max(dot(viewDir, d), 1e-3));
  vec3 far = max(-pos / dir, (room - pos) / dir);
  float tt = min(min(far.x, far.y), far.z);
  vec3 hit = pos + dir * tt;
  float id = hash12(cell + dot(n, vec3(3.1, 0.0, 7.7)) + floor(dot(wp, n) * 0.01) * 13.0);
  float level = mix(step(0.22, id) * (0.45 + 0.55 * hash12(cell * 1.7 + 3.0)), 0.8 + 0.2 * id, hall);
  vec3 lamp = mix(mix(vec3(1.0, 0.74, 0.46), vec3(0.92, 0.9, 0.84), step(0.72, id)), vec3(1.0, 0.86, 0.66), hall);
  vec3 surface;
  if (tt == far.y && dir.y > 0.0) {
    // ceiling with rows of light panels
    vec2 c = fract(vec2(hit.x, hit.z) / 2.4);
    float panel = step(0.2, c.x) * step(c.x, 0.8) * step(0.35, c.y) * step(c.y, 0.65);
    surface = lamp * (0.05 + 0.1 * level + panel * 3.0 * level);
  } else if (tt == far.y) {
    // floor, pooled with light under the panels
    surface = vec3(0.2, 0.19, 0.17) * lamp * (0.05 + 0.7 * level) * (0.8 + 0.2 * sin(hit.x * 1.3));
  } else if (tt == far.z) {
    // back wall, with a darker dado of desks, counters and seats
    float dado = 1.0 - 0.55 * step(hit.y, 1.1);
    surface = vec3(0.46, 0.44, 0.41) * lamp * (0.05 + 0.55 * level) * dado;
  } else {
    surface = vec3(0.42, 0.41, 0.39) * lamp * (0.04 + 0.42 * level);
  }
  return surface * (1.0 - 0.4 * hit.z / room.z);
}

/*
 * Airline paint, in the aircraft's own coordinates (x forward, y up, z right):
 * a white crown with a belly sweep that climbs toward the tail, a thin accent
 * line along the sweep, titles above the windows, a tail with a gradient,
 * a leading-edge flash and the logo, accent sharklets and engine lips, and
 * fuselage frames and panel lines that only resolve up close.
 */
vec3 livery(vec3 albedo, inout float gloss) {
  bool tail = albedo.r > 0.99 && albedo.g < 0.01 && albedo.b > 0.99;
  if (uLivery < 0.5) return tail ? uTint : albedo;
  vec3 L = vLocal;
  vec3 white = vec3(0.9, 0.905, 0.915);
  float fw = max(fwidth(L.x), fwidth(L.y));
  float near = 1.0 - smoothstep(0.015, 0.09, fw);
  if (near3(albedo, vec3(0.861, 0.871, 0.881))) {
    float rise = 1.0 - smoothstep(-17.5, 7.0, L.x);
    float sweep = -1.05 + rise * 2.55 + 0.12 * sin(L.x * 0.15);
    float aa = 0.02 + fw;
    float belly = 1.0 - smoothstep(sweep - aa, sweep + aa, L.y);
    float accent = (1.0 - smoothstep(0.035, 0.035 + aa, abs(L.y - sweep - 0.17))) * (1.0 - smoothstep(5.0, 9.0, L.x));
    vec3 c = mix(white, uTint, belly);
    c = mix(c, uTint2, accent * (1.0 - belly));
    // titles
    if (abs(L.z) > 1.0 && L.y > 0.78 && L.y < 1.5 && L.x > 0.5 && L.x < 10.5) {
      float u = L.z > 0.0 ? (L.x - 0.5) / 10.0 : (10.5 - L.x) / 10.0;
      float v = (L.y - 0.78) / 0.72;
      c = mix(c, uTint, texture(uLiveryTex, vec2(u * 0.75, v)).r);
    }
    // radome and cockpit surround stay white; the tail cone takes the colour
    float frame = 1.0 - smoothstep(0.006, 0.006 + fw, abs(fract(L.x / 1.6 + 0.5) - 0.5) * 1.6);
    float strake = 1.0 - smoothstep(0.006, 0.006 + fw, abs(abs(L.y) - 1.25) * 0.6);
    c *= 1.0 - 0.1 * max(frame, strake * 0.6) * near;
    gloss = 0.86;
    return c;
  }
  if (near3(albedo, vec3(0.6, 0.62, 0.65))) {
    gloss = 0.7;
    return uTint * 0.92;
  }
  if (tail) {
    gloss = 0.84;
    // engines: livery cowls with an accent lip
    if (abs(L.z) > 3.5 && L.y < -0.8 && abs(L.z) < 8.0) return L.x > 3.75 ? uTint2 : uTint;
    // sharklets
    if (abs(L.z) > 16.0) return uTint2;
    // logo lights in the tailplane tips wash the lower fin with light
    if (abs(L.z) < 1.2 && L.y > 1.5) logoWash = (1.0 - smoothstep(2.0, 8.5, L.y)) * 0.8 + 0.2;
    // fin: deepening toward the top, a flash along the leading edge, the logo
    vec3 c = mix(uTint, uTint * 0.62, smoothstep(2.0, 8.0, L.y));
    float le = (L.x + 12.0) + (L.y - 1.5) * 0.674;
    c = mix(c, uTint2, (1.0 - smoothstep(-1.15, -1.1 + fw, le)) * smoothstep(-1.75 - fw, -1.7, le));
    vec2 uv = vec2((L.x + 16.4) / 3.6, (L.y - 4.9) / 3.6) + 0.5;
    if (L.z < 0.0) uv.x = 1.0 - uv.x;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) c = mix(c, white, texture(uLiveryTex, vec2(0.75 + uv.x * 0.25, uv.y)).g);
    return c;
  }
  return albedo;
}

void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye - vWorld);
  bool glazing = vMat.x > 1.5;
  float gloss = clamp(glazing ? vMat.x - 1.0 : vMat.x, 0.0, 1.0);
  float emissive = glazing ? 0.0 : vMat.y;
  if (glazing && abs(n.y) < 0.35) {
    // coated double glazing: the lit interior through a faint blue tint, the
    // sky in the glass, more of it the more obliquely the facade is seen
    vec3 nh = normalize(vec3(n.x, 0.0, n.z));
    float storey = vMat.y > 1.0 ? vMat.y : 4.2;
    vec3 room = interiorRoom(vWorld, nh, -v, storey);
    // rooms a pixel across are averaged rather than left to shimmer
    vec2 grid = vec2(dot(vWorld, normalize(cross(vec3(0.0, 1.0, 0.0), nh))) / mix(8.4, 42.0, step(4.5, storey)), vWorld.y / storey);
    float blur = smoothstep(0.08, 0.35, max(fwidth(grid.x), fwidth(grid.y)));
    room = mix(room, vec3(0.16, 0.12, 0.08), blur);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    float F = 0.07 + 0.93 * fres;
    vec3 hg = normalize(uSunDir + v);
    float sh = sunShadow(vWorld, n);
    float glint = pow(max(dot(n, hg), 0.0), 400.0) * sh * 4.0;
    vec3 col = room * (1.0 - F) * vec3(0.7, 0.8, 0.84) + skyColor(reflect(-v, n)) * F + uSunColor * glint;
    o = vec4(applyFog(col, vWorld), uOpacity);
    return;
  }
  vec3 albedo = livery(vColor, gloss);
  float sh = sunShadow(vWorld, n);
  float ndl = max(dot(n, uSunDir), 0.0) * sh;
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), mix(22.0, 220.0, gloss)) * gloss * 0.65 * sh;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  // Rough surfaces average a wider part of the sky; polished paint retains
  // the horizon reflection. This separates concrete from glass and metal.
  vec3 reflected = reflect(-v, n);
  vec3 environment = mix(hemiAmbient(n), skyColor(reflected), gloss * gloss);
  vec3 refl = environment * (0.04 + 0.96 * fres) * gloss;
  vec3 col = albedo * (uSunColor * ndl + hemiAmbient(n) + localLight(vWorld, n)) * (1.0 - fres * gloss * 0.45) + uSunColor * spec + refl;
  col += albedo * emissive * uEmissiveBoost;
  col += albedo * vec3(1.0, 0.93, 0.82) * logoWash * uLogoLights * 0.55;
  col = applyFog(col, vWorld);
  o = vec4(col, uOpacity);
}`;

/**
 * Instanced vehicles, trains and boats: the lit-mesh vertex stage with the
 * model matrix built from a per-instance position, heading and pitch.
 * Vertices painted magenta take the instance's paint colour, so one mesh
 * gives a whole street of differently coloured cars. Pairs with LIT_FS.
 */
export const MOVER_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aMat;
layout(location=4) in vec4 aInst;   // x, y, z, heading (model +x forward)
layout(location=5) in vec4 aInst2;  // pitch, paint rgb
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out vec2 vMat;
out vec3 vLocal;
void main(){
  float c = cos(aInst.w), s = sin(aInst.w);
  float cp = cos(aInst2.x), sp = sin(aInst2.x);
  vec3 p = vec3(aPos.x * cp - aPos.y * sp, aPos.x * sp + aPos.y * cp, aPos.z);
  vec3 n = vec3(aNormal.x * cp - aNormal.y * sp, aNormal.x * sp + aNormal.y * cp, aNormal.z);
  vWorld = aInst.xyz + vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vNormal = vec3(c * n.x - s * n.z, n.y, s * n.x + c * n.z);
  bool paint = aColor.r > 0.99 && aColor.g < 0.01 && aColor.b > 0.99;
  vColor = paint ? aInst2.yzw : aColor;
  vMat = aMat;
  vLocal = aPos;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

// ---------------------------------------------------------------- terrain

export const TERRAIN_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
out vec3 vWorld;
out vec3 vNormal;
void main(){
  vWorld = aPos;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const TERRAIN_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vNormal;
uniform vec4 uAirport;   // x0, z0, x1, z1 of the mown airfield
uniform vec3 uRiver;     // amplitude, wavelength, z offset of the river centreline
uniform float uShoreTerrain; // 0: legacy, 1: coarse ground, 2: detailed bank patches
uniform sampler2D uForest;   // woodland density (see vegetation.ts)
uniform vec4 uForestRect;    // x0, z0, 1/width, 1/depth
uniform float uTreeRange;    // beyond this the 3D trees stop and the canopy is painted
out vec4 o;
${HYDROLOGY_GLSL}

// Farmland as it looks from an aircraft. The land is divided into districts
// (a jittered Voronoi pattern about 1.6 km across) whose borders are country
// lanes; inside each district the parcels share one orientation and size, so
// field edges are straight and meet at right angles, and neighbouring
// districts meet at an angle the way old field systems do. Each parcel is
// sown with its own crop, with headlands, drill rows and tramlines up close.
vec3 cropColor(float k, float moist) {
  vec3 pasture = vec3(0.105, 0.15, 0.062);
  vec3 ley = vec3(0.12, 0.17, 0.058);
  vec3 maize = vec3(0.085, 0.125, 0.045);
  vec3 wheat = vec3(0.31, 0.26, 0.125);
  vec3 barley = vec3(0.285, 0.265, 0.155);
  vec3 stubble = vec3(0.265, 0.225, 0.15);
  vec3 plough = vec3(0.13, 0.098, 0.07);
  vec3 rape = vec3(0.35, 0.32, 0.07);
  vec3 c = k < 0.2 ? pasture : k < 0.34 ? ley : k < 0.44 ? maize : k < 0.58 ? wheat : k < 0.68 ? barley : k < 0.8 ? stubble : k < 0.96 ? plough : rape;
  return c * (0.84 + 0.26 * moist);
}

/** District of a point: x = orientation, y = parcel scale, z = distance to the district's border in metres. */
vec4 fieldDistrict(vec2 p, out vec2 id) {
  vec2 g = p / 1650.0;
  vec2 gi = floor(g);
  float d1 = 1e9, d2 = 1e9;
  id = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = gi + vec2(float(i), float(j));
      vec2 o = vec2(hash12(c * 1.31 + 0.7), hash12(c * 2.17 + 3.1)) * 0.85 + 0.075;
      vec2 d = g - (c + o);
      float dd = dot(d, d);
      if (dd < d1) { d2 = d1; d1 = dd; id = c; }
      else if (dd < d2) { d2 = dd; }
    }
  }
  float border = (sqrt(d2) - sqrt(d1)) * 1650.0 * 0.5;
  float ang = (hash12(id * 3.7 + 1.9) - 0.5) * 3.14159;
  float scale = 0.7 + 0.65 * hash12(id * 5.3 + 7.1);
  return vec4(ang, scale, border, hash12(id + 17.0));
}

vec3 fieldColor(vec2 p, out float edge, out float lane) {
  vec2 id;
  vec4 dist = fieldDistrict(p, id);
  float ca = cos(dist.x), sa = sin(dist.x);
  vec2 rp = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y) + id * 397.0;
  vec2 size = vec2(360.0, 205.0) * dist.y;
  vec2 q = rp / size;
  // stagger alternate rows so field corners don't line up into a grid
  q.x += hash12(vec2(floor(q.y), id.x)) * 0.8;
  vec2 c = floor(q);
  vec2 f = fract(q);
  // some parcels are split lengthwise into strips
  float split = step(0.62, hash12(c + id * 13.0 + 41.0));
  vec2 cell = c * 2.0 + vec2(split * step(0.5, f.x), 0.0) + id * 31.0;
  float fx = split > 0.5 ? fract(f.x * 2.0) : f.x;
  edge = min(min(fx, 1.0 - fx) * size.x * (split > 0.5 ? 0.5 : 1.0), min(f.y, 1.0 - f.y) * size.y);
  edge = min(edge, dist.z);
  lane = dist.z;
  float k = hash12(cell);
  float moist = fbm(p * 0.0035 + cell * 1.7);
  vec3 col = cropColor(k, moist);
  float footprint = max(fwidth(p.x), fwidth(p.y));
  float arable = step(0.34, k);
  // drill rows along the parcel; headlands turned across them near the edge
  bool alongX = hash12(cell + 3.0) < 0.5;
  float dir = alongX ? rp.x : rp.y;
  float head = 1.0 - smoothstep(9.0, 12.0, edge);
  float rowCoord = mix(dir, alongX ? rp.y : rp.x, head);
  float rows = sin(rowCoord * 4.4);
  float rowFade = 1.0 - smoothstep(0.08, 0.3, footprint);
  float tram = 1.0 - smoothstep(0.0, 0.9 + footprint, abs(fract(dir / 24.0 + hash12(cell)) - 0.5) * 24.0 - 0.2);
  col *= 1.0 - arable * (0.07 * rows * rowFade + 0.14 * tram * (1.0 - head) * (1.0 - smoothstep(1.0, 3.0, footprint)));
  col *= 1.0 - arable * head * 0.06;
  // swaths on stubble, grazing paths and clover patches on grass
  if (k >= 0.68 && k < 0.8) col *= 0.93 + 0.07 * sin(dir * 0.52);
  if (k < 0.34) col *= 0.86 + 0.26 * vnoise(p * 0.05) * (0.7 + 0.3 * vnoise(p * 0.31));
  return col;
}


/*
 * Woodland from above: a closed canopy of crowns about seven metres across on
 * a jittered grid, each a dome lit on its sunward flank over deep gaps, with
 * conifers on high ground and in stands, and a few crowns already turning.
 * It carries the forest wherever the instanced trees thin out or stop, so a
 * wood reads as one mass from the runway and from ten kilometres out. Crowns
 * only exist where the density allows, which gives woods ragged edges.
 * Returns the albedo; coverage, sunlit and sky terms come back separately.
 */
vec3 canopy(vec2 p, float density, float y, out float cover, out float sunTerm, out float skyTerm) {
  vec2 g = p / 6.8;
  vec2 gi = floor(g);
  float best = 4.0;
  vec2 bd = vec2(0.0);
  vec2 bid = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = gi + vec2(float(i), float(j));
      if (hash12(c * 0.731 + 5.17) > density * 1.35) continue;
      vec2 o = vec2(hash12(c * 1.713 + 3.1), hash12(c * 2.377 + 7.7)) * 0.7 + 0.15;
      float r = 0.56 + 0.3 * hash12(c + 19.3);
      vec2 d = (g - c - o) / r;
      float dd = dot(d, d);
      if (dd < best) { best = dd; bd = d; bid = c; }
    }
  }
  cover = 1.0 - smoothstep(0.72, 1.0, best);
  // leafy lumps on the dome break the crown into tufts
  float tuft = vnoise(p * 1.3 + bid * 7.0) * 0.6 + vnoise(p * 3.1) * 0.4;
  vec3 cn = normalize(vec3(bd.x * 0.95 + (tuft - 0.5) * 0.5, sqrt(max(1.0 - min(best, 1.0), 0.0)) * 1.1 + 0.2, bd.y * 0.95 + (vnoise(p * 1.7 - 3.0) - 0.5) * 0.5));
  sunTerm = max(dot(cn, uSunDir), 0.0) * 1.25;
  skyTerm = 0.5 + 0.5 * cn.y;
  float coniferP = clamp(smoothstep(60.0, 260.0, y) * 0.8 + 0.12 + (vnoise(p * 0.0045 + 3.0) - 0.5) * 0.6, 0.0, 1.0);
  float kind = hash12(bid * 3.11 + 1.7);
  float shade = hash12(bid + 9.1);
  vec3 alb = kind < coniferP
    ? mix(vec3(0.034, 0.068, 0.046), vec3(0.058, 0.094, 0.05), shade)
    : mix(vec3(0.09, 0.13, 0.045), vec3(0.15, 0.175, 0.066), shade);
  float autumn = hash12(bid * 7.73 + 0.31);
  if (kind >= coniferP) {
    if (autumn > 0.975) alb = mix(alb, vec3(0.24, 0.11, 0.035), 0.55);
    else if (autumn > 0.94) alb = mix(alb, vec3(0.2, 0.18, 0.05), 0.45);
  }
  alb *= 0.82 + 0.36 * tuft;
  return alb;
}

void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  vec3 n = normalize(vNormal);
  vec2 p = vWorld.xz;
  float shore = waterShore(p);
  if (uShoreTerrain > 0.5 && uShoreTerrain < 1.5 && shore < 180.0) discard;
  if (uShoreTerrain > 1.5 && shore >= 180.0) discard;
  // The mesh is deliberately coarse at a distance; analytic shore clipping
  // prevents a large terrain triangle from cutting across a small pond.
  if (shore < -1.5 && vWorld.y > -5.0) discard;
  float edge;
  float lane;
  vec3 col = fieldColor(p, edge, lane);
  float natural = fbm(p * 0.0008 + 18.0);
  float farmland = 1.0 - smoothstep(0.43, 0.62, natural);
  // rough grazing: tussocks, rushes, worn sheep tracks and drier knolls
  float tuss = vnoise(p * 0.09) * 0.55 + vnoise(p * 0.37) * 0.3 + vnoise(p * 1.4) * 0.15;
  vec3 meadow = mix(vec3(0.1, 0.14, 0.06), vec3(0.17, 0.18, 0.095), fbm(p * 0.0022));
  meadow = mix(meadow, vec3(0.2, 0.19, 0.11), smoothstep(0.55, 0.85, fbm(p * 0.006 + 4.0)) * 0.6);
  meadow *= 0.86 + 0.28 * tuss;
  col = mix(meadow, col, farmland * 0.8);
  // hedgerows with gaps at the gateways, darker where they are thick
  float gap = step(0.22, vnoise(p * 0.018));
  float hedge = (1.0 - smoothstep(1.4, 3.8 + fwidth(edge) * 1.5, edge)) * farmland * gap;
  col = mix(col, vec3(0.04, 0.062, 0.028) * (0.8 + 0.4 * vnoise(p * 0.4)), hedge * 0.85);
  // country lanes along the district borders: tarmac with grass verges
  float laneW = 2.8 + fwidth(lane);
  float laneMask = (1.0 - smoothstep(laneW, laneW + 1.2, lane)) * (1.0 - smoothstep(0.4, 0.62, natural) * 0.5);
  float verge = (1.0 - smoothstep(5.5, 7.0, lane)) * (1.0 - laneMask);
  col = mix(col, vec3(0.13, 0.155, 0.085), verge * 0.6);
  col = mix(col, vec3(0.085, 0.087, 0.09) * (0.85 + 0.3 * vnoise(p * 0.7)), laneMask);
  // woodland density; the canopy itself is shaded after the ground is lit
  float trees = texture(uForest, (p - uForestRect.xy) * uForestRect.zw).r;
  float footprint = max(fwidth(p.x), fwidth(p.y));
  // mown airfield grass
  vec2 inA = step(uAirport.xy, p) * step(p, uAirport.zw);
  float airfield = inA.x * inA.y;
  float mow = step(0.5, fract(p.y / 9.0)) * (1.0 - smoothstep(2.0, 8.0, max(fwidth(p.x), fwidth(p.y))));
  vec3 turf = mix(vec3(0.098, 0.138, 0.058), vec3(0.15, 0.162, 0.078), smoothstep(0.35, 0.8, fbm(p * 0.006 + 7.0)));
  // dry, sun-bleached patches and darker damp hollows; clippings in the stripes
  turf = mix(turf, vec3(0.19, 0.18, 0.1), smoothstep(0.6, 0.82, fbm(p * 0.011 + 2.0)) * 0.55);
  turf = mix(turf, vec3(0.07, 0.105, 0.045), smoothstep(0.62, 0.85, fbm(p * 0.017 - 6.0)) * 0.5);
  turf *= 0.93 + 0.09 * mow;
  turf *= 0.9 + 0.2 * (vnoise(mat2(0.8, 0.6, -0.6, 0.8) * p * 0.8) * 0.6 + vnoise(mat2(0.28, -0.96, 0.96, 0.28) * p * 3.1) * 0.4) * (1.0 - smoothstep(0.05, 0.4, max(fwidth(p.x), fwidth(p.y))));
  col = mix(col, turf, airfield);
  // Street corridors ground the buildings in paved blocks, parks and yards.
  float cityRadius = length(p - vec2(-4900.0, -4300.0));
  float urban = (1.0 - smoothstep(2200.0, 2850.0, cityRadius)) * (1.0 - airfield);
  float streetX = abs(mod(p.x + 4900.0, 130.0) - 65.0);
  float streetZ = abs(mod(p.y + 4300.0, 96.0) - 48.0);
  float street = 1.0 - smoothstep(6.0, 9.0, min(streetX, streetZ));
  // gardens and lawns in the suburbs, paving downtown, driveways and patios between
  float core = 1.0 - smoothstep(700.0, 1500.0, cityRadius);
  vec3 lawn = mix(vec3(0.092, 0.132, 0.054), vec3(0.15, 0.16, 0.08), vnoise(p * 0.05)) * (0.88 + 0.24 * vnoise(p * 0.4));
  vec3 paved = mix(vec3(0.17, 0.165, 0.15), vec3(0.23, 0.215, 0.19), vnoise(p * 0.01));
  vec3 yard = mix(lawn, paved, max(core, smoothstep(0.58, 0.8, vnoise(p * 0.035)) * 0.6));
  col = mix(col, mix(yard, vec3(0.07, 0.075, 0.077), street), urban);
  // Wet earth, reeds and sandy shoulders follow every analytic shoreline.
  float rz = uRiver.z + sin(p.x / uRiver.y) * uRiver.x + sin(p.x / (uRiver.y * 0.37)) * uRiver.x * 0.3;
  shore = min(shore, abs(p.y - rz) - riverHalfWidth(p.x));
  float sand = (1.0 - smoothstep(8.0, 38.0, shore)) * smoothstep(-5.0, 4.0, shore);
  vec3 sediment = mix(vec3(0.23, 0.20, 0.14), vec3(0.31, 0.275, 0.19), vnoise(p * 0.045));
  col = mix(col, sediment, sand * (0.68 + 0.20 * vnoise(p * 0.009)));
  float wet = 1.0 - smoothstep(0.0, 8.0, shore);
  col = mix(col, vec3(0.09, 0.095, 0.061), wet * 0.78);
  float reeds = smoothstep(12.0, 20.0, shore) * (1.0 - smoothstep(28.0, 45.0, shore)) * smoothstep(0.42, 0.67, vnoise(p * 0.022));
  col = mix(col, vec3(0.12, 0.16, 0.064), reeds * 0.55);
  // rock on steep or high ground
  float slope = 1.0 - n.y;
  float rock = max(smoothstep(0.22, 0.52, slope), smoothstep(600.0, 1250.0, vWorld.y) * 0.65);
  vec3 rockColor = mix(vec3(0.20, 0.195, 0.18), vec3(0.31, 0.29, 0.25), vnoise(p * 0.004));
  col = mix(col, rockColor, rock);
  // snow on the high peaks: a ragged snow line, lying in gullies and on the
  // gentler slopes, blown off the steepest faces
  float snowLine = 1850.0 + (vnoise(p * 0.0007) - 0.5) * 520.0;
  float snow = smoothstep(snowLine - 140.0, snowLine + 160.0, vWorld.y) * (1.0 - smoothstep(0.42, 0.72, slope));
  snow *= 0.6 + 0.4 * smoothstep(0.3, 0.65, vnoise(p * 0.012) * 0.6 + vnoise(p * 0.05) * 0.4);
  col = mix(col, vec3(0.8, 0.82, 0.86), clamp(snow, 0.0, 1.0));
  float detail = mix(vnoise(p * 0.065), 0.5, smoothstep(0.25, 0.9, max(fwidth(p.x), fwidth(p.y)) * 0.065));
  col *= 0.93 + 0.14 * detail;

  // Micro-relief that only a low sun reveals: tussocks and molehills on rough
  // grazing, furrows and wheel ruts in the fields, gentle swales everywhere.
  vec3 nb = n;
  float near = 1.0 - smoothstep(0.5, 2.5, footprint);
  float mid = 1.0 - smoothstep(3.0, 14.0, footprint);
  if (mid > 0.0 && airfield < 0.5 && urban < 0.5) {
    vec2 g = bumpSlope(p * 0.021);
    float rough = mix(0.035, 0.07, 1.0 - farmland);
    nb = normalize(nb - vec3(g.x, 0.0, g.y) * rough * mid);
    if (near > 0.0) {
      vec2 kg = bumpSlope(p * 0.17 + 31.0);
      nb = normalize(nb - vec3(kg.x, 0.0, kg.y) * mix(0.05, 0.13, 1.0 - farmland) * near);
    }
  } else if (near > 0.0 && airfield > 0.5) {
    // mown turf: a gentle unevenness, and the faint sheen of cut grass
    vec2 kg = bumpSlope(p * 0.23 + 13.0);
    nb = normalize(nb - vec3(kg.x, 0.0, kg.y) * 0.03 * near);
  }

  float sunVis = sunShadow(vWorld, n);
  float ndl = max(dot(nb, uSunDir), 0.0) * sunVis;
  vec3 lit = col * (uSunColor * ndl + hemiAmbient(nb));

  // Woodland: crowns over a ground in deep shade. Up close each crown is
  // modelled; past a few metres per pixel the canopy is averaged instead.
  float forest = smoothstep(0.05, 0.3, trees) * (1.0 - airfield) * (1.0 - urban);
  if (forest > 0.0) {
    float cover, sunTerm, skyTerm;
    vec3 alb = canopy(p, trees, vWorld.y, cover, sunTerm, skyTerm);
    // Within the instanced trees' reach, individual painted crowns would read
    // as flat discs between the real trees: there the canopy is shaded as a
    // soft, mottled mass of the same average tone, and the crowns resolve
    // only further out, where the instanced trees thin.
    float camDist = length(vWorld - uEye);
    float far = max(smoothstep(1.4, 4.0, footprint), 1.0 - smoothstep(900.0, 2600.0, camDist));
    float coniferP = clamp(smoothstep(60.0, 260.0, vWorld.y) * 0.8 + 0.12 + (vnoise(p * 0.0045 + 3.0) - 0.5) * 0.6, 0.0, 1.0);
    vec3 avgAlb = mix(vec3(0.115, 0.15, 0.054), vec3(0.046, 0.08, 0.048), coniferP) * (0.9 + 0.2 * vnoise(p * 0.02));
    float mottle = vnoise(p * 0.11) * 0.55 + vnoise(p * 0.37 + 4.0) * 0.3 + vnoise(p * 1.1) * 0.15;
    alb = mix(alb, avgAlb * (0.78 + 0.44 * mottle), far);
    cover = mix(cover, smoothstep(0.12, 0.7, trees), far);
    sunTerm = mix(sunTerm, 0.36 * (0.6 + 0.8 * mottle), far);
    skyTerm = mix(skyTerm, 0.78, far);
    // crown tops stand fifteen metres up: sample the shadow there, so the 3D trees
    // shade the painted canopy as tree tops shade each other
    float crownVis = sunShadow(vWorld + vec3(0.0, 15.0, 0.0), vec3(0.0, 1.0, 0.0));
    vec3 crownLit = alb * (uSunColor * sunTerm * crownVis + hemiAmbient(vec3(0.0, 1.0, 0.0)) * skyTerm);
    vec3 gapLit = lit * mix(1.0, 0.22, smoothstep(0.2, 0.75, trees));
    vec3 woods = mix(gapLit, crownLit, cover);
    // Where the instanced trees stand in full, they are the canopy: the ground
    // between them is the woodland floor, holly, hazel and bracken over leaf
    // litter, in the real dappled shade of the trees above (the shadow map).
    float floorMix = (1.0 - smoothstep(1300.0, 2300.0, camDist)) * (1.0 - smoothstep(1.4, 4.0, footprint));
    if (floorMix > 0.0) {
      float scrub = vnoise(p * 0.21) * 0.6 + vnoise(p * 0.83 + 2.0) * 0.4;
      vec3 litter = mix(vec3(0.07, 0.055, 0.035), vec3(0.05, 0.075, 0.03), smoothstep(0.35, 0.65, scrub));
      litter = mix(litter, vec3(0.03, 0.055, 0.035), coniferP * 0.6);
      float dapple = sunVis;
      vec3 floorLit = litter * (uSunColor * max(dot(nb, uSunDir), 0.0) * dapple * 0.8 + hemiAmbient(nb) * 0.42);
      woods = mix(woods, floorLit, floorMix * smoothstep(0.15, 0.45, trees));
    }
    lit = mix(lit, woods, forest);
  }
  o = vec4(applyFog(lit, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- airport surfaces

export const SURFACE_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aLocal; // x: metres along, y: metres across, z: surface kind
out vec3 vWorld;
out vec3 vLocal;
void main(){
  vWorld = aPos;
  vLocal = aLocal;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const SURFACE_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vLocal;
uniform float uRunwayLength;
uniform sampler2D uNumbers;
out vec4 o;

float box(vec2 p, vec2 a, vec2 b) { return step(a.x, p.x) * step(p.x, b.x) * step(a.y, p.y) * step(p.y, b.y); }

void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  float kind = vLocal.z;
  vec2 p = vLocal.xy;            // metres: x along, y across (0 = centreline)
  float footprint = max(fwidth(vWorld.x), fwidth(vWorld.z));
  float aggregate = mix(vnoise(vWorld.xz * 1.7), 0.5, smoothstep(0.25, 0.8, footprint * 1.7));
  float weather = fbm(vWorld.xz * 0.025);
  float grain = weather * 0.6 + aggregate * 0.4;
  vec3 asphalt = vec3(0.088, 0.09, 0.093) * (0.86 + 0.28 * grain);
  // repair patches, sealed cracks and transverse grooving catch the low sun differently
  float patchy = step(0.72, hash12(floor(vWorld.xz / vec2(23.0, 9.0) + 0.37)));
  asphalt *= 1.0 - 0.14 * patchy + 0.06 * vnoise(vWorld.xz * 0.045);
  float crack = 1.0 - smoothstep(0.0, 0.018 + footprint * 0.01, abs(vnoise(vWorld.xz * 0.11) - 0.5));
  asphalt *= 1.0 - 0.1 * crack * (1.0 - smoothstep(0.15, 0.8, footprint));
  vec3 col = asphalt;
  float paint = 0.0;
  vec3 paintCol = vec3(0.92);
  float gloss = 0.10;

  if (kind < 0.5) {
    // runway: piano keys, numbers, centreline, touchdown zone, aiming points, edges
    float L = uRunwayLength;
    float ax = abs(p.y);
    float fromEnd = min(p.x, L - p.x);
    bool west = p.x < L * 0.5;
    float e = west ? p.x : L - p.x;
    // rubber deposits in the touchdown zones
    col *= 1.0 - 0.40 * (1.0 - smoothstep(250.0, 900.0, e)) * (1.0 - smoothstep(2.0, 14.0, ax)) * (0.6 + 0.4 * vnoise(vec2(e * 0.08, p.y * 0.6)));
    paint += box(vec2(e, ax), vec2(6.0, 1.0), vec2(36.0, 21.0)) * step(0.5, fract((ax - 1.0) / 2.5 + 0.0)) * step(ax, 21.0);
    paint += box(vec2(e, p.y), vec2(1.0, -22.0), vec2(3.5, 22.0)); // threshold bar
    paint += step(ax, 0.45) * step(70.0, fromEnd) * step(fract(p.x / 50.0), 0.6);
    paint += box(vec2(e, ax), vec2(400.0, 6.0), vec2(460.0, 15.0));                // aiming points
    for (int i = 0; i < 4; i++) {
      float s = 150.0 + float(i) * 150.0;
      if (abs(s - 400.0) < 1.0) continue;
      paint += box(vec2(e, ax), vec2(s, 4.0), vec2(s + 22.0, 5.8)) * step(float(i), 3.0);
      paint += box(vec2(e, ax), vec2(s, 8.0), vec2(s + 22.0, 9.8)) * step(float(i), 1.0);
    }
    paint += step(21.6, ax) * step(ax, 22.4) * step(10.0, fromEnd);              // edge lines
    // runway designators from the numbers texture ("09" west, "27" east)
    vec2 nuv = vec2((p.y + 9.0) / 18.0, (e - 42.0) / 26.0);
    if (nuv.x > 0.0 && nuv.x < 1.0 && nuv.y > 0.0 && nuv.y < 1.0) {
      vec2 uvn = west ? nuv : vec2(1.0 - nuv.x, nuv.y);
      uvn.x = uvn.x * 0.5 + (west ? 0.0 : 0.5);
      paint += texture(uNumbers, uvn).r;
    }
  } else if (kind < 1.5) {
    // taxiway: yellow centreline, edge lines
    col = asphalt * 1.1;
    paintCol = vec3(0.85, 0.62, 0.12);
    paint += step(abs(p.y), 0.25);
    paint += step(10.0, abs(p.y)) * step(abs(p.y), 10.4) * 0.8;
  } else {
    // apron: lighter concrete slabs with stand lead-in lines
    vec2 slabCoord = vWorld.xz / 7.5;
    vec2 slab = fract(slabCoord);
    float joint = min(min(slab.x, 1.0 - slab.x), min(slab.y, 1.0 - slab.y));
    float jointWidth = 0.009 + footprint / 7.5 * 0.35;
    float seam = (1.0 - smoothstep(0.004, jointWidth, joint)) * (1.0 - smoothstep(0.5, 2.0, footprint));
    float slabTone = hash12(floor(slabCoord));
    col = vec3(0.245, 0.236, 0.212) * (0.89 + 0.13 * grain + 0.1 * slabTone);
    col *= 1.0 - 0.22 * seam;
    // oil and fuel stains where aircraft stand, tyre scrub on the lead-in lines
    float standLine = abs(mod(p.x - 170.0 + 39.0, 78.0) - 39.0);
    float atStand = step(p.y, -10.0) * step(-70.0, p.y) * (1.0 - smoothstep(4.0, 11.0, standLine));
    float stain = smoothstep(0.55, 0.85, vnoise(vWorld.xz * 0.21) * 0.7 + vnoise(vWorld.xz * 0.9) * 0.3);
    col *= 1.0 - 0.42 * stain * atStand - 0.12 * stain;
    col *= 1.0 - 0.18 * (1.0 - smoothstep(0.6, 1.8, standLine)) * step(p.y, -14.0) * step(-145.0, p.y);
    paintCol = vec3(0.85, 0.62, 0.12);
    float standOffset = abs(mod(p.x - 170.0 + 39.0, 78.0) - 39.0);
    paint += step(standOffset, 0.22) * step(p.y, -14.0) * step(-145.0, p.y);
    paint += step(standOffset, 3.0) * step(abs(p.y + 145.0), 0.22);
    gloss = 0.045;
  }
  paint = clamp(paint, 0.0, 1.0) * (0.75 + 0.25 * grain);
  col = mix(col, paintCol * 0.78, paint);

  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 v = normalize(uEye - vWorld);
  float ndl = max(uSunDir.y, 0.0) * sunShadow(vWorld, n);
  float fres = pow(1.0 - max(v.y, 0.0), 5.0);
  vec3 refl = skyColor(reflect(-v, normalize(n + vec3(grain - 0.5, 0.0, aggregate - 0.5) * 0.018)));
  vec3 local = localLight(vWorld + vec3(0.0, 0.0, 0.0), n);
  vec3 lit = col * (uSunColor * ndl + hemiAmbient(n) + local) + refl * (0.02 + 0.6 * fres) * gloss;
  // Slightly polished aggregate catches lamps; dry concrete stays diffuse.
  lit += local * gloss * 0.10 * fres;
  o = vec4(applyFog(lit, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- city buildings (instanced)

/** Walls of the low-rise houses: rendered, painted or brick, one per house. */
const HOUSE_GLSL = `
vec3 houseWall(float seed) {
  float k = fract(seed * 7.3);
  vec3 c = k < 0.28 ? vec3(0.45, 0.41, 0.33)    // cream render
         : k < 0.46 ? vec3(0.5, 0.49, 0.46)     // white render
         : k < 0.68 ? vec3(0.3, 0.155, 0.1)     // red brick
         : k < 0.8 ? vec3(0.42, 0.33, 0.21)     // ochre render
         : k < 0.91 ? vec3(0.25, 0.2, 0.155)    // brown brick
         : vec3(0.33, 0.34, 0.33);              // grey render
  return c * (0.9 + 0.2 * fract(seed * 31.7));
}
`;

export const CITY_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;      // unit box, y in [0,1]
layout(location=1) in vec3 aNormal;
layout(location=4) in vec4 aBox;      // x, z, width, depth
layout(location=5) in vec3 aParams;   // height, seed, base y
out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out float vSeed;
out float vHeight;
out vec2 vSize;
void main(){
  vec3 p = vec3(aBox.x + aPos.x * aBox.z, aParams.z + aPos.y * aParams.x, aBox.y + aPos.z * aBox.w);
  vWorld = p;
  vNormal = aNormal;
  vLocal = vec3(aPos.x * aBox.z, aPos.y * aParams.x, aPos.z * aBox.w);
  vSeed = aParams.y;
  vHeight = aParams.x;
  vSize = aBox.zw;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

export const CITY_FS = `${HEADER}${COMMON}${HOUSE_GLSL}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
in float vSeed;
in float vHeight;
in vec2 vSize;
out vec4 o;
void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  vec3 n = normalize(vNormal);
  float material = fract(vSeed * 7.3);
  vec3 masonry = mix(vec3(0.21, 0.19, 0.16), vec3(0.36, 0.35, 0.31), material);
  if (vHeight < 11.0) masonry = houseWall(vSeed);
  float glass = step(0.62, fract(vSeed * 3.1)) * step(17.0, vHeight);
  vec3 base = mix(masonry, vec3(0.075, 0.12, 0.145), glass);
  float grounded = mix(0.68, 1.0, smoothstep(0.0, 9.0, vLocal.y));
  vec3 irradiance = uSunColor * max(dot(n, uSunDir), 0.0) * sunShadow(vWorld, n) + hemiAmbient(n);
  vec3 col = base * irradiance * grounded;
  vec3 view = normalize(uEye - vWorld);
  if (abs(n.y) < 0.5 && vHeight > 3.0) {
    // Adjacent bays share an office/floor occupancy, with interior lighting
    // integrated into the façade when a window is smaller than a pixel.
    float along = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
    float bayWidth = mix(3.2, 4.5, step(24.0, vHeight));
    vec2 grid = vec2(along / bayWidth, vLocal.y / 3.4);
    vec2 f = fract(grid);
    vec2 aa = max(fwidth(grid), vec2(0.003));
    vec2 windowMask = smoothstep(vec2(0.18) - aa, vec2(0.18) + aa, f) * (1.0 - smoothstep(vec2(0.80, 0.76) - aa, vec2(0.80, 0.76) + aa, f));
    float resolved = 1.0 - smoothstep(0.18, 0.65, max(aa.x, aa.y));
    float win = windowMask.x * windowMask.y * step(2.4, vLocal.y);
    float office = hash12(vec2(floor(grid.x / 3.0), floor(grid.y)) + vSeed * 23.0 + dot(n.xz, vec2(7.0, 11.0)));
    float on = step(mix(0.81, 0.69, glass), office);
    vec3 windowGlass = vec3(0.035, 0.07, 0.085) * irradiance;
    float fres = 0.055 + 0.40 * pow(1.0 - max(dot(n, view), 0.0), 4.0);
    vec3 reflected = skyColor(reflect(-view, n)) * fres;
    col = mix(col, windowGlass + reflected, win * resolved * 0.88 + glass * 0.52);
    vec3 interior = mix(vec3(0.31, 0.20, 0.10), vec3(0.26, 0.25, 0.20), step(0.86, material));
    float roomLight = mix(0.055 * mix(0.19, 0.31, glass), win * on, resolved);
    col += interior * roomLight;
    // Continuous floor bands read as architecture at a distance.
    float band = (1.0 - smoothstep(0.04, 0.09 + aa.y, f.y)) * resolved;
    col *= 1.0 - band * mix(0.09, 0.24, glass);
  } else if (n.y > 0.5) {
    // roofs: weathered membrane or gravel, a parapet, and rooftop plant
    float weather = vnoise(vWorld.xz * 0.035);
    vec2 rl = vLocal.xz;
    vec2 hs = vSize * 0.5;
    float edgeD = min(hs.x - abs(rl.x), hs.y - abs(rl.y));
    vec3 roof = mix(vec3(0.1, 0.105, 0.11), vec3(0.17, 0.165, 0.155), step(0.5, fract(vSeed * 5.7))) * (0.86 + 0.28 * weather);
    roof *= 0.92 + 0.16 * vnoise(vWorld.xz * 0.6);
    float parapet = 1.0 - smoothstep(0.45, 0.7, edgeD);
    vec2 cellCoord = rl / 4.5;
    vec2 fc = fract(cellCoord);
    float unit = step(0.78, hash12(floor(cellCoord) + vSeed * 17.0)) * step(2.6, edgeD) * step(12.0, vHeight);
    float inUnit = step(0.18, fc.x) * step(fc.x, 0.82) * step(0.22, fc.y) * step(fc.y, 0.78);
    float rim = inUnit * (1.0 - step(0.26, fc.y));
    roof = mix(roof, vec3(0.3, 0.31, 0.32), unit * inUnit);
    roof *= 1.0 - 0.35 * unit * rim;
    roof = mix(roof, vec3(0.24, 0.235, 0.22), parapet);
    col = roof * irradiance;
    // a lit stair core or skylight on some roofs after dark
    col += vec3(0.3, 0.24, 0.16) * unit * inUnit * step(0.93, hash12(floor(cellCoord) + 3.0)) * 0.4;
  }
  o = vec4(applyFog(col, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- pitched house roofs

/**
 * Instanced pitched roofs for the city's houses (see houseRoofs in city.ts).
 * The unit mesh has eaves at x, z = +-0.5 and ridge ends marked at x = +-1,
 * y = 1; the vertex stage fits it to each house: the ridge along the longer
 * side, hipped or gabled, the eaves overhanging by 45 cm, the gable walls
 * flush with the house walls below. Every face reports where it is in roof
 * coordinates, so the tiles, ridge and panels line up across a slope.
 */
export const ROOF_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;   // x: face (0 front slope, 1 back slope, 2 and 3 ends, 4 soffit)
layout(location=4) in vec4 aBox;      // x, z, width, depth of the house
layout(location=5) in vec4 aRoof;     // eave height, seed, rise, hip (0 gabled, 1 hipped)
out vec3 vWorld;
out vec3 vNormal;
out vec3 vRoof;    // along the eave (m), up the slope from the eave (m), face kind
out float vSeed;
out vec2 vSpan;    // ridge length, slope length
void main(){
  bool alongX = aBox.z >= aBox.w;
  float L = max(aBox.z, aBox.w) + 0.9;
  float W = min(aBox.z, aBox.w) + 0.9;
  float H = aRoof.z;
  bool hipped = aRoof.w > 0.5;
  float ridgeHalf = hipped ? max(0.5 * L - 0.5 * W, 0.0) : 0.5 * L;
  int face = int(aNormal.x + 0.5);
  vec3 l = vec3(aPos.y > 0.5 ? sign(aPos.x) * ridgeHalf : aPos.x * L, aPos.y * H, aPos.z * W);
  float slopeLen = sqrt(H * H + 0.25 * W * W);
  float hipRun = 0.5 * L - ridgeHalf;
  float hipLen = sqrt(H * H + hipRun * hipRun);
  vec3 n;
  vec3 roof;
  if (face == 0) {
    n = vec3(0.0, 0.5 * W, H);
    roof = vec3(l.x, (0.5 * W - abs(l.z)) / (0.5 * W) * slopeLen, 0.0);
  } else if (face == 1) {
    n = vec3(0.0, 0.5 * W, -H);
    roof = vec3(-l.x, (0.5 * W - abs(l.z)) / (0.5 * W) * slopeLen, 1.0);
  } else if (face <= 3) {
    float sx = face == 2 ? 1.0 : -1.0;
    if (hipped) {
      n = vec3(sx * H, hipRun, 0.0);
      roof = vec3(sx * -l.z, (0.5 * L - abs(l.x)) / max(hipRun, 0.01) * hipLen, 2.0);
    } else {
      // the gable wall stands on the end wall, under the verge
      float wallTop = 0.45 * H / (0.5 * W);
      l = aPos.y > 0.5 ? vec3(sx * (0.5 * L - 0.45), H - 0.04, 0.0) : vec3(sx * (0.5 * L - 0.45), wallTop, sign(aPos.z) * (0.5 * W - 0.45));
      n = vec3(sx, 0.0, 0.0);
      roof = vec3(sx * -l.z, l.y - wallTop, 3.0);
    }
  } else {
    n = vec3(0.0, -1.0, 0.0);
    roof = vec3(l.x, 0.0, 4.0);
  }
  n = normalize(n);
  // turn (never mirror) the roof onto z when the house is deeper than wide
  vec3 w = alongX ? l : vec3(-l.z, l.y, l.x);
  vNormal = alongX ? n : vec3(-n.z, n.y, n.x);
  vWorld = vec3(aBox.x + w.x, aRoof.x + w.y, aBox.y + w.z);
  vRoof = roof;
  vSeed = aRoof.y;
  vSpan = vec2(2.0 * ridgeHalf, slopeLen);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const ROOF_FS = `${HEADER}${COMMON}${HOUSE_GLSL}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vRoof;
in float vSeed;
in vec2 vSpan;
out vec4 o;
void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uEye - vWorld);
  float kind = vRoof.z;
  float sh = sunShadow(vWorld, n);
  vec3 irradiance = uSunColor * max(dot(n, uSunDir), 0.0) * sh + hemiAmbient(n);
  if (kind > 2.5) {
    // gable wall in the house's own finish, or the shaded soffit under the eaves
    vec3 wall = kind < 3.5 ? houseWall(vSeed) : vec3(0.16, 0.15, 0.14);
    o = vec4(applyFog(wall * irradiance * (kind < 3.5 ? 1.0 : 0.55), vWorld), 1.0);
    return;
  }
  float k = fract(vSeed * 13.71);
  // clay pantiles, plain red-brown tiles, slate, brown concrete tiles, weathered orange clay
  vec3 tile = k < 0.3 ? vec3(0.28, 0.115, 0.07)
            : k < 0.5 ? vec3(0.215, 0.095, 0.07)
            : k < 0.72 ? vec3(0.095, 0.1, 0.11)
            : k < 0.88 ? vec3(0.18, 0.135, 0.105)
            : vec3(0.32, 0.165, 0.095);
  float slate = step(0.5, k) * step(k, 0.72);
  float pantile = step(k, 0.3) + step(0.88, k);
  float weather = vnoise(vWorld.xz * 0.21 + vSeed * 50.0);
  tile *= 0.84 + 0.32 * weather;
  // lichen on the slopes that never see the sun
  float shade = clamp(-dot(normalize(n.xz + 1e-4), normalize(uSunDir.xz)), 0.0, 1.0);
  tile = mix(tile, vec3(0.13, 0.14, 0.08), shade * smoothstep(0.45, 0.8, vnoise(vWorld.xz * 0.9 + 7.0)) * 0.35 * (1.0 - slate * 0.5));
  // tile courses with their shadowed lower lips, staggered joints, and the
  // rolls of the pantiles; all of it fades out once a course is under a pixel
  float fw = max(fwidth(vRoof.y), fwidth(vRoof.x));
  float resolved = 1.0 - smoothstep(0.05, 0.22, fw);
  float course = mix(0.33, 0.25, slate);
  float cy = vRoof.y / course;
  float row = floor(cy);
  float cx = vRoof.x / mix(0.3, 0.42, slate) + 0.5 * mod(row, 2.0);
  float lip = smoothstep(0.0, 0.22, fract(cy));
  float tileVar = hash12(vec2(floor(cx), row) + vSeed * 97.0);
  float joint = smoothstep(0.43, 0.5, abs(fract(cx) - 0.5)) * (1.0 - pantile);
  float roll = sin(fract(cx) * 6.2832) * pantile;
  vec3 col = tile * mix(1.0, (0.64 + 0.36 * lip) * (0.86 + 0.28 * tileVar) * (1.0 - 0.28 * joint) * (1.0 + 0.16 * roll), resolved);
  // ridge and hip capping
  float ridge = kind < 1.5 ? smoothstep(vSpan.y - 0.32, vSpan.y - 0.22, vRoof.y) : 0.0;
  col = mix(col, tile * 0.72, ridge);
  // solar panels on some roofs, on one slope: dark glass in silver frames
  float panelRoof = step(fract(vSeed * 5.3), 0.2) * step(abs(kind - step(0.5, fract(vSeed * 9.1))), 0.1);
  float inPanel = panelRoof * step(abs(vRoof.x), vSpan.x * 0.5 - 0.9) * step(0.7, vRoof.y) * step(vRoof.y, vSpan.y - 0.55);
  if (inPanel > 0.5) {
    vec2 cell = vec2(vRoof.x / 1.05, (vRoof.y - 0.7) / 1.72);
    vec2 f = abs(fract(cell) - 0.5);
    float frame = max(smoothstep(0.47, 0.49, f.x), smoothstep(0.48, 0.495, f.y)) * resolved;
    vec3 glass = vec3(0.012, 0.018, 0.032);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
    vec3 lit = glass * irradiance + skyColor(reflect(-view, n)) * fres * 0.9;
    // the cells' fine grid, faintly
    vec2 g = abs(fract(cell * vec2(6.0, 10.0)) - 0.5);
    lit *= 1.0 - 0.18 * max(smoothstep(0.44, 0.5, g.x), smoothstep(0.44, 0.5, g.y)) * resolved;
    col = mix(lit, vec3(0.42, 0.43, 0.44) * irradiance, frame);
    o = vec4(applyFog(col, vWorld), 1.0);
    return;
  }
  col *= irradiance;
  // slate and glazed tiles carry a little of the sky
  float fres = pow(1.0 - max(dot(n, view), 0.0), 5.0);
  col += skyBase(reflect(-view, n)) * (0.015 + 0.22 * fres) * mix(0.35, 1.0, slate);
  o = vec4(applyFog(col, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- grass blades near the camera

/**
 * Tufts of grass generated entirely on the GPU: each instance is one cell of
 * a grid centred on the camera, jittered and sized by a hash of its world
 * cell so it never swims, shrinking to nothing at the edge of the patch.
 * Only the mown airfield gets them, and never on pavement.
 */
export const GRASS_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform vec3 uGrass; // camera cell x, camera cell z, cell size (m)
uniform float uGrassN;
out vec3 vWorld;
out vec3 vNormal;
out float vTip;
out float vShade;
bool paved(vec2 q) {
  if (q.x > -150.0 && q.x < 3350.0 && abs(q.y) < 32.0) return true;               // runway and shoulders
  if (q.x > -170.0 && q.x < 3370.0 && abs(q.y - 190.0) < 17.0) return true;      // parallel taxiway
  if (q.y > 0.0 && q.y < 230.0 && (abs(q.x - 820.0) < 17.0 || abs(q.x - 1650.0) < 17.0)) return true;
  if (q.y > 180.0 && q.y < 250.0 && (abs(q.x - 900.0) < 17.0 || abs(q.x - 1500.0) < 17.0 || abs(q.x - 2100.0) < 17.0)) return true;
  if (q.y > -5.0 && q.y < 230.0 && (q.x < 0.0 || (q.x > 2660.0 && q.x < 3060.0) || q.x > 3290.0) && q.x > -170.0 && q.x < 3370.0) return true;
  if (q.y > 220.0 && q.x > 600.0 && q.x < 2650.0) return true;                    // apron and terminal
  if (q.y > 300.0 || q.y < -620.0 || q.x < -1300.0 || q.x > 4200.0) return true;   // outside the mown field
  return false;
}
void main(){
  float N = uGrassN;
  float id = float(gl_InstanceID);
  vec2 cell = vec2(mod(id, N), floor(id / N)) - N * 0.5;
  vec2 wc = uGrass.xy + cell;
  vec2 xz = (wc + vec2(hash12(wc * 0.71 + 1.3), hash12(wc * 1.37 + 7.9))) * uGrass.z;
  float d = length(xz - uEye.xz);
  float R = N * 0.5 * uGrass.z;
  float s = (0.55 + 0.95 * hash12(wc + 3.1)) * (1.0 - smoothstep(R * 0.55, R * 0.95, d));
  if (paved(xz)) s = 0.0;
  float a = hash12(wc + 5.3) * 6.2832;
  float ca = cos(a), sa = sin(a);
  vec3 lp = aPos * vec3(1.0, s, 1.0);
  // wind leans the tips; gusts travel across the field
  float gust = sin(uTime * 1.7 + xz.x * 0.21 + xz.y * 0.07) * 0.5 + 0.5;
  vec3 world = vec3(xz.x + ca * lp.x - sa * lp.z, lp.y - 0.02, xz.y + sa * lp.x + ca * lp.z);
  world.xz += vec2(0.09 + 0.08 * gust, 0.03) * aPos.y * aPos.y * s;
  vWorld = world;
  vNormal = normalize(vec3(ca * aNormal.x - sa * aNormal.z, aNormal.y, sa * aNormal.x + ca * aNormal.z));
  vTip = aPos.y / 0.42;
  vShade = 0.75 + 0.5 * hash12(wc + 11.0);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const GRASS_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in float vTip;
in float vShade;
out vec4 o;
void main(){
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  vec3 green = mix(vec3(0.035, 0.06, 0.02), vec3(0.15, 0.18, 0.07), vTip) * vShade;
  // some tufts are dry and straw-coloured at the tips
  green = mix(green, vec3(0.24, 0.21, 0.11) * vShade, smoothstep(1.05, 1.2, vShade) * vTip * 0.7);
  float sh = sunShadow(vWorld, vec3(0.0, 1.0, 0.0));
  vec3 lit = green * (uSunColor * max(dot(n, uSunDir), 0.0) * sh * 0.85 + hemiAmbient(vec3(0.0, 1.0, 0.0)) * (0.55 + 0.45 * vTip));
  // backlit blades glow gold when you look toward the low sun
  lit += green * uSunColor * pow(max(dot(-v, uSunDir), 0.0), 5.0) * vTip * 1.4 * sh;
  o = vec4(applyFog(lit, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- trees (instanced, bucketed)

export const TREE_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;     // unit-height tree
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aPart;    // 0 bark / 1 foliage / 2 leaf card, occlusion
layout(location=3) in vec2 aUV;      // leaf atlas
layout(location=6) in vec3 aCard;    // leaf card corner offset, in crown widths
layout(location=4) in vec4 aInst;    // x, y, z, rotation
layout(location=5) in vec4 aShape;   // crown width, height, tint, seed
out vec3 vWorld;
out vec3 vNormal;
out vec2 vPart;
out vec2 vTint;
out vec2 vUV;
void main(){
  float c = cos(aInst.w), s = sin(aInst.w);
  vec3 scale = vec3(aShape.x, aShape.y, aShape.x);
  vec3 p = vec3(c * aPos.x - s * aPos.z, aPos.y, s * aPos.x + c * aPos.z) * scale;
  p += vec3(c * aCard.x - s * aCard.z, aCard.y, s * aCard.x + c * aCard.z) * aShape.x;
  // crowns sway in the evening breeze; trunks stay put
  float h = aPos.y * aPos.y * min(aPart.x, 1.0) * min(aShape.y / 14.0, 1.0);
  float gust = sin(uTime * 0.7 + aInst.x * 0.004 + aInst.z * 0.003) * 0.5 + 0.5;
  float sway = (sin(uTime * 1.6 + aShape.w * 40.0) * 0.6 + sin(uTime * 3.1 + aShape.w * 17.0) * 0.25) * (0.4 + 0.6 * gust);
  p.x += sway * h * 0.45;
  p.z += sway * h * 0.25;
  // and each spray trembles on its twig
  float card = step(1.5, aPart.x);
  float flutter = sin(uTime * 4.7 + aShape.w * 31.0 + aPos.x * 37.0 + aPos.z * 23.0 + aPos.y * 11.0);
  p.y += card * flutter * (0.25 + 0.75 * gust) * 0.009 * aShape.x;
  vWorld = aInst.xyz + p;
  vec3 n = vec3(c * aNormal.x - s * aNormal.z, aNormal.y, s * aNormal.x + c * aNormal.z);
  vNormal = normalize(n / scale);
  vPart = aPart;
  vTint = aShape.zw;
  vUV = aUV;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const TREE_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vPart;
in vec2 vTint;
in vec2 vUV;
uniform vec3 uFoliage;   // species colour
uniform vec3 uBark;
uniform sampler2D uLeaves;  // leaf sprays (see foliage.ts)
uniform float uA2C;         // 1 when coverage comes from alpha (multisampled target)
out vec4 o;
void main(){
  if (uClipWater > 0.5 && vWorld.y < -5.0) discard;
  float card = step(1.5, vPart.x);
  // Leaf sprays: coverage is kept through the mip chain and then sharpened to
  // the pixel, so distant sprays neither dissolve nor fizz.
  vec4 spray = texture(uLeaves, vUV);
  vec2 texel = vUV * 512.0;
  vec2 tx = dFdx(texel), ty = dFdy(texel);
  float mip = max(0.0, 0.5 * log2(max(dot(tx, tx), dot(ty, ty))));
  float cover = spray.a * (1.0 + mip * 0.32);
  cover = (cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5;
  if (card > 0.5 && cover < mix(0.5, 0.02, uA2C)) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing && card < 0.5) n = -n;
  vec3 v = normalize(uEye - vWorld);
  float leaf = step(0.5, vPart.x);
  float ao = vPart.y;
  float tint = vTint.x;
  float seed = vTint.y;
  vec3 green = uFoliage * (0.72 + 0.56 * tint);
  // a few trees are turning: early autumn colour at golden hour
  if (seed > 0.975) green = mix(green, vec3(0.26, 0.12, 0.03), 0.6);
  else if (seed > 0.95) green = mix(green, vec3(0.2, 0.18, 0.04), 0.45);
  // clumps of leaves: noise breaks the crown into lit and shaded tufts
  float dist = length(vWorld - uEye);
  float detail = 1.0 - smoothstep(60.0, 900.0, dist);
  float clump = vnoise(vWorld.xz * 0.85 + vWorld.y * 0.6) * 0.55 + vnoise(vec2(vWorld.x + vWorld.z, vWorld.y) * 2.4) * 0.45;
  clump = mix(0.5, clump, (0.35 + 0.65 * detail) * (1.0 - card * 0.6));
  vec3 albedo = mix(uBark, green * (0.7 + 0.6 * clump), leaf);
  if (card > 0.5) {
    // each leaf its own shade, some yellowing, twigs in bark
    vec3 l = green * (0.45 + 0.78 * spray.r) * (0.8 + 0.4 * clump);
    l = mix(l, l * vec3(1.45, 1.18, 0.5) + vec3(0.025, 0.014, 0.0), spray.g * 0.85);
    albedo = mix(l, uBark * 0.75, step(0.5, spray.b));
  }
  if (leaf > 0.5) {
    vec3 bump = vec3(vnoise(vWorld.yz * 0.9), vnoise(vWorld.xz * 0.9 + 3.0), vnoise(vWorld.xy * 0.9 + 7.0)) - 0.5;
    n = normalize(n + bump * mix(1.2, 0.7, card) * (0.4 + 0.6 * detail));
  }
  float sh = sunShadow(vWorld, normalize(vNormal));
  float wrap = mix(max(dot(n, uSunDir), 0.0), clamp((dot(n, uSunDir) + 0.45) / 1.45, 0.0, 1.0), leaf);
  float occl = mix(0.3, 1.0, ao) * mix(0.75, 1.0, clump);
  vec3 col = albedo * (uSunColor * wrap * sh * mix(0.75, 1.0, ao) + hemiAmbient(n) * occl);
  // sunlight through the leaves when the tree is between the camera and the sun
  float back = pow(max(dot(-v, uSunDir), 0.0), 3.0);
  col += leaf * albedo * vec3(0.9, 1.0, 0.45) * uSunColor * back * (0.3 + 0.35 * card) * sh * (0.35 + 0.65 * ao) * (1.0 - step(0.5, spray.b) * card);
  // soft sheen on the sunny side of the crown; single leaves glint
  vec3 hv = normalize(uSunDir + v);
  col += leaf * uSunColor * pow(max(dot(n, hv), 0.0), 24.0) * (0.035 + card * 0.03 * spray.r) * sh;
  o = vec4(applyFog(col, vWorld), card > 0.5 ? clamp(cover, 0.0, 1.0) : 1.0);
}`;

/** Depth-only fragment stage for the shadow atlas. */
export const DEPTH_FS = `${HEADER}
void main(){}`;

// ---------------------------------------------------------------- water

export const WATER_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
out vec3 vWorld;
void main(){ vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

export const WATER_FS = `${HEADER}${COMMON}
in vec3 vWorld;
uniform sampler2D uReflection;
uniform mat4 uReflectionVP;
uniform float uReflectionEnabled;
uniform vec4 uBoats[8];   // x, z, heading, half length (0: unused)
out vec4 o;
${HYDROLOGY_GLSL}

/*
 * Wakes: behind each hull two Kelvin arms spread at 19.5 degrees with a
 * churned, foaming centre line from the propeller, and transverse ripples
 * between the arms; along the hull a bow wave folds away. Returns foam
 * cover and adds the wake's slope to the water's gradient.
 */
float wakes(vec2 p, inout vec2 gradient) {
  float foam = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 b = uBoats[i];
    if (b.w <= 0.0) continue;
    vec2 dir = vec2(cos(b.z), sin(b.z));
    vec2 rel = p - b.xy;
    float along = dot(rel, dir);
    float across = dot(rel, vec2(-dir.y, dir.x));
    float side = abs(across);
    float beam = b.w * 0.15;
    float behind = -(along + b.w);
    if (behind > b.w * 22.0 || along > b.w * 1.4 || side > max(behind, 0.0) * 0.4 + beam * 3.0) continue;
    // bow wave and the wash along the hull
    float hull = (1.0 - smoothstep(b.w * 0.6, b.w * 1.15, along)) * smoothstep(-b.w * 1.1, -b.w * 0.2, along);
    foam += hull * exp(-pow(side - beam * 1.15, 2.0) / (0.4 + beam * 0.3)) * 0.8;
    if (behind > 0.0) {
      float fade = exp(-behind / (b.w * 7.0));
      float armD = side - beam - behind * 0.354;
      float arms = exp(-armD * armD / (1.5 + behind * 0.05)) * fade;
      float spread = beam * (0.9 + behind * 0.025);
      float centre = exp(-side * side / (spread * spread)) * exp(-behind / (b.w * 3.0));
      foam += arms * 0.55 + centre * 0.9;
      float inside = 1.0 - smoothstep(-2.0, 2.0, armD);
      float k = 0.55 / (1.0 + b.w * 0.02);
      gradient += dir * cos(behind * k - uTime * 2.0) * 0.07 * inside * fade;
      gradient += vec2(-dir.y, dir.x) * sign(across) * cos(armD * 1.2 - uTime * 2.5) * 0.05 * arms;
    }
  }
  return min(foam, 1.0);
}

void main(){
  vec2 p = vWorld.xz;
  float depth = waterDepth(p);
  float footprint = max(fwidth(p.x), fwidth(p.y));
  vec2 wind = vec2(0.86, 0.51), crossWind = vec2(-0.32, 0.95);
  float longWave = dot(p, wind) * 0.087 - uTime * 0.62;
  float midWave = dot(p, crossWind) * 0.52 - uTime * 1.18;
  float ripple = dot(p, vec2(0.73, -0.69)) * 1.07 - uTime * 1.82;
  vec2 gradient = wind * cos(longWave) * 0.011;
  gradient += crossWind * cos(midWave) * 0.029 * (1.0 - smoothstep(1.5, 5.0, footprint));
  gradient += vec2(0.73, -0.69) * cos(ripple) * 0.018 * (1.0 - smoothstep(0.5, 2.0, footprint));
  // wind-driven noise on top of the swell: catspaws and chop
  vec2 q = p * 0.16 + wind * uTime * 0.35;
  float n0 = vnoise(q);
  gradient += (vec2(vnoise(q + vec2(0.37, 0.0)), vnoise(q + vec2(0.0, 0.37))) - n0) * 0.11 * (1.0 - smoothstep(0.8, 3.0, footprint));
  vec2 q2 = p * 0.7 - crossWind * uTime * 0.8;
  float m0 = vnoise(q2);
  gradient += (vec2(vnoise(q2 + vec2(0.29, 0.0)), vnoise(q2 + vec2(0.0, 0.29))) - m0) * 0.07 * (1.0 - smoothstep(0.25, 1.0, footprint));
  gradient *= 0.55 + 0.45 * smoothstep(0.0, 2.0, depth);
  float foam = wakes(p, gradient);
  vec3 n = normalize(vec3(-gradient.x, 1.0, -gradient.y));
  vec3 v = normalize(uEye - vWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 refl = skyColor(reflect(-v, n));
  // The reflected opaque world and sky share a linear HDR target. Wave
  // normals disturb its projection without screen-space duplicate imagery.
  if (uReflectionEnabled > 0.5) {
    vec4 projected = uReflectionVP * vec4(vWorld, 1.0);
    if (projected.w > 0.0) {
      vec2 uv = projected.xy / projected.w * 0.5 + 0.5;
      uv += gradient * 0.024;
      if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
        vec2 edge = min(uv, 1.0 - uv);
        float valid = smoothstep(0.0, 0.025, min(edge.x, edge.y));
        refl = mix(refl, texture(uReflection, uv).rgb, valid);
      }
    }
  }
  float transmit = exp(-depth * 0.48);
  vec3 sediment = mix(vec3(0.15, 0.13, 0.08), vec3(0.105, 0.12, 0.071), vnoise(p * 0.05));
  vec3 deep = vec3(0.012, 0.026, 0.03);
  vec3 body = mix(deep, sediment, transmit) * (hemiAmbient(n) + uSunColor * max(dot(n, uSunDir), 0.0));
  vec3 col = mix(body, refl, fres);
  vec3 h = normalize(uSunDir + v);
  float sunVis = sunShadow(vWorld, vec3(0.0, 1.0, 0.0));
  float nh = max(dot(n, h), 0.0);
  col += uSunColor * pow(nh, 420.0) * 1.4 * sunVis;
  // the glitter path: a broad lobe broken into sparkles by the chop
  float sparkle = smoothstep(0.62, 0.95, vnoise(p * 2.3 + uTime * 1.7) * 0.6 + vnoise(p * 7.1 - uTime * 2.3) * 0.4);
  col += uSunColor * pow(nh, 60.0) * (0.25 + 3.5 * sparkle) * sunVis * (1.0 - smoothstep(0.6, 3.0, footprint) * 0.6);
  col += uSunColor * pow(nh, 9.0) * 0.07 * sunVis;
  float shoreRipple = sin(waterShore(p) * 1.3 - uTime * 1.1) * (1.0 - smoothstep(0.0, 1.0, depth));
  col += vec3(0.014, 0.019, 0.013) * shoreRipple * 0.12;
  if (foam > 0.0) {
    // foam breaks up into streaks and patches; it is lit like a rough white surface
    float breakup = smoothstep(0.25, 0.75, vnoise(p * 0.9 + uTime * 0.3) * 0.6 + vnoise(p * 3.7 - uTime * 0.5) * 0.4);
    float cover = foam * (0.45 + 0.55 * breakup);
    vec3 white = vec3(0.62, 0.64, 0.64) * (hemiAmbient(vec3(0.0, 1.0, 0.0)) + uSunColor * max(uSunDir.y, 0.0) * sunVis * 1.6);
    col = mix(col, white, clamp(cover, 0.0, 0.85));
  }
  o = vec4(applyFog(col, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- clouds

export const CLOUD_VS = WATER_VS;

export const CLOUD_FS = `${HEADER}${COMMON}
in vec3 vWorld;
uniform float uCoverage;
out vec4 o;
void main(){
  vec2 p = vWorld.xz * 0.00022 + vec2(uTime * 0.004, 0.0);
  float d = fbm(p + vec2(fbm(p * 0.7 + 8.0), 0.0)) * 0.78 + fbm(p * 3.1 + 5.0) * 0.22;
  float a = smoothstep(uCoverage - 0.025, uCoverage + 0.18, d) * 0.82;
  if (a < 0.003) discard;
  vec3 v = normalize(vWorld - uEye);
  vec2 sunFlat = normalize(uSunDir.xz);
  float toward = max(dot(normalize(vec3(v.x, 0.0001, v.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  // density a step toward the sun: where it is thicker, this point is in shadow
  vec2 ps = p + sunFlat * 0.06;
  float ds = fbm(ps + vec2(fbm(ps * 0.7 + 8.0), 0.0)) * 0.78 + fbm(ps * 3.1 + 5.0) * 0.22;
  float selfShadow = clamp((ds - d) * 4.0 + 0.5, 0.0, 1.0);
  // lit from below by the low sun: hot orange toward it, rose and lilac away
  // at sunset the low sun lights cloud undersides across the whole sky:
  // gold toward it, dusky rose and mauve away from it
  vec3 under = mix(vec3(0.46, 0.34, 0.38), vec3(0.8, 0.44, 0.25), pow(toward, 2.4));
  float thickness = smoothstep(uCoverage, uCoverage + 0.24, d);
  vec3 shade = mix(under, vec3(0.13, 0.15, 0.2), thickness * 0.62 + selfShadow * 0.3);
  float edge = 1.0 - smoothstep(uCoverage, uCoverage + 0.14, d);
  shade += vec3(0.75, 0.42, 0.2) * edge * pow(toward, 4.0) * (1.0 - selfShadow * 0.5);
  shade += vec3(0.3, 0.17, 0.14) * edge * (1.0 - selfShadow * 0.6);
  float dist = length(vWorld - uEye);
  float fade = exp(-dist * 0.000035);
  shade = mix(shade, skyColor(v), 1.0 - fade);
  o = vec4(shade * a * fade, a * fade);
}`;

// ---------------------------------------------------------------- birds

/**
 * Flocks, procedurally. A starling murmuration is a cloud of a few hundred
 * birds whose shape is a slowly churning noise field around a drifting
 * centre, so density waves roll through it; gulls wheel in loose circles
 * over the water. Every bird's position comes from its instance number and
 * the time, its heading from its own velocity, and its wings flap (or, for
 * gulls, mostly glide). aWing: 0 on the body, +-1 at the wing tips.
 */
export const BIRD_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in float aWing;
uniform vec4 uFlock;   // centre xyz, size in metres
uniform float uKind;   // 0 starlings, 1 gulls
out vec3 vWorld;
out float vShade;
float n3(vec3 p) { return vnoise(p.xy + p.z * 17.13) * 2.0 - 1.0; }
vec3 birdAt(float id, float t) {
  vec3 seed = vec3(hash12(vec2(id, 1.7)), hash12(vec2(id, 5.3)), hash12(vec2(id, 9.1))) * 2.0 - 1.0;
  if (uKind < 0.5) {
    vec3 u = seed * vec3(1.0, 0.45, 1.0);
    // the cloud churns: a smooth displacement field advected in time
    vec3 q = u * 1.3 + vec3(t * 0.11, t * 0.07, -t * 0.09);
    vec3 disp = vec3(n3(q), n3(q + 31.7), n3(q + 57.3));
    vec3 shape = vec3(1.0 + 0.6 * sin(t * 0.13), 0.55 + 0.35 * sin(t * 0.21 + 1.0), 1.0 + 0.5 * cos(t * 0.17));
    vec3 drift = vec3(sin(t * 0.045) * 2.2, sin(t * 0.07) * 0.35, cos(t * 0.038) * 1.8);
    return uFlock.xyz + (u + disp * 0.55 + drift) * shape * uFlock.w;
  }
  float r = uFlock.w * (0.4 + 0.6 * abs(seed.x));
  float a = t * (0.09 + 0.05 * seed.y) * (seed.z > 0.0 ? 1.0 : -1.0) + id * 2.399;
  return uFlock.xyz + vec3(cos(a) * r, seed.y * 18.0 + sin(t * 0.3 + id) * 4.0, sin(a) * r * 0.8);
}
void main(){
  float id = float(gl_InstanceID);
  float t = uTime;
  vec3 p = birdAt(id, t);
  vec3 v = birdAt(id, t + 0.15) - p;
  vec3 fwd = normalize(v + vec3(1e-4, 0.0, 0.0));
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  float span = uKind < 0.5 ? 0.55 : 1.35;
  float phase = hash12(vec2(id, 3.3)) * 6.2832;
  float flap = uKind < 0.5 ? sin(t * 15.0 + phase) : sin(t * 4.0 + phase) * smoothstep(0.3, 0.9, sin(t * 0.4 + phase));
  vec3 local = aPos * span;
  local.y += abs(aWing) * flap * span * 0.55;
  vWorld = p + fwd * local.x + up * local.y + right * local.z;
  vShade = uKind < 0.5 ? 0.0 : 0.5 + 0.5 * abs(aWing);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const BIRD_FS = `${HEADER}${COMMON}
in vec3 vWorld;
in float vShade;
uniform float uKind;
out vec4 o;
void main(){
  vec3 albedo = uKind < 0.5 ? vec3(0.015, 0.016, 0.018) : mix(vec3(0.35, 0.36, 0.37), vec3(0.75, 0.75, 0.73), vShade);
  vec3 col = albedo * (hemiAmbient(vec3(0.0, 1.0, 0.0)) + uSunColor * 0.5 * cloudShadow(vWorld));
  o = vec4(applyFog(col, vWorld), 1.0);
}`;

// ---------------------------------------------------------------- lights (point sprites)

// aKind: [0,1) steady   [1,2) twinkle   [2,3) approach rabbit (fraction = sequence)
//        [3,4) strobe (fraction = phase)  [4,5) beacon (fraction = phase)
export const POINTS_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aSize;
layout(location=3) in float aKind;
uniform float uPixelRatio;
uniform float uMotion;
uniform float uHeight;   // drawing buffer height in px
uniform float uFovScale; // 1 / tan(fov / 2)
uniform float uDaylight; // 0 at night .. 1 in full day: steady lamps lose contrast, flashers keep it
out vec3 vColor;
out float vAlpha;
void main(){
  float dist = length(aPos - uEye);
  vec3 toEye = (uEye - aPos) / max(dist, 1e-3);
  vec4 clip = uViewProj * vec4(aPos + toEye * min(dist * 0.015, 4.0), 1.0);
  gl_Position = clip;
  float kind = floor(aKind);
  float param = fract(aKind);
  float a = 1.0;
  float seed = hash12(aPos.xz * 0.37 + aPos.y);
  if (kind == 1.0) a = mix(1.0, 0.65 + 0.35 * sin(uTime * (0.6 + seed * 2.0) + seed * 40.0), uMotion);
  else if (kind == 2.0) { float d = fract(uTime * 2.0) - param; a = 0.3 + mix(0.0, 6.0 * exp(-d * d * 2500.0), uMotion); }
  else if (kind == 3.0) { float ph = fract(uTime * 0.9 + param); a = mix(0.0, 1.0, step(ph, 0.06)) * 8.0 + 0.0; if (uMotion < 0.5) a = 0.6; }
  else if (kind == 4.0) { float ph = fract(uTime * 0.75 + param); a = exp(-ph * 9.0) * 3.0 + 0.15; }
  else if (kind == 5.0) a = param;
  if (kind < 3.0) a *= 1.0 - uDaylight * 0.6;
  // atmospheric extinction keeps distant lights warm and dim
  float ext = exp(-dist * uFog * 0.55);
  vAlpha = a * ext;
  vColor = aColor * mix(vec3(1.0, 0.82, 0.62), vec3(1.0), ext);
  // Navigation lights retain a legible floor. Ordinary city lamps conserve
  // projected energy, so thousands of distant bulbs do not become white noise.
  float px = aSize * uFovScale * uHeight * 0.5 / max(clip.w, 1.0);
  float minimum = kind == 5.0 ? uPixelRatio : 1.5 * uPixelRatio;
  gl_PointSize = clamp(px, minimum, 48.0 * uPixelRatio);
  float projected = clamp(px / minimum, 0.0, 1.0);
  vAlpha *= kind == 5.0 ? projected * projected : max(0.35, projected);
}`;

export const POINTS_FS = `${HEADER}
in vec3 vColor;
in float vAlpha;
uniform float uSoft;  // 1: alpha-blended smoke puffs instead of additive lights
out vec4 o;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  if (uSoft > 0.5) {
    float a = exp(-r2 * 2.6) * (1.0 - r2) * vAlpha;
    o = vec4(vColor * a, a);
    return;
  }
  float core = exp(-r2 * 10.0);
  float halo = exp(-r2 * 3.0) * 0.4;
  o = vec4(vColor * (core + halo) * vAlpha, 1.0);
}`;

// ---------------------------------------------------------------- thick lines (holographic gates, trails)

export const LINES_VS = `${HEADER}${COMMON}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in vec3 aColor;
layout(location=4) in vec3 aAlphaWidth;
uniform vec2 uResolution;
uniform float uPixelRatio;
out vec3 vColor;
out float vSide;
void main(){
  vec4 ca = uViewProj * vec4(aA, 1.0);
  vec4 cb = uViewProj * vec4(aB, 1.0);
  if (ca.w < 0.5) ca = mix(ca, cb, clamp((0.5 - ca.w) / max(cb.w - ca.w, 1e-4), 0.0, 1.0));
  if (cb.w < 0.5) cb = mix(cb, ca, clamp((0.5 - cb.w) / max(ca.w - cb.w, 1e-4), 0.0, 1.0));
  vec2 sa = ca.xy / ca.w * uResolution;
  vec2 sb = cb.xy / cb.w * uResolution;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 c = mix(ca, cb, aCorner.x);
  float w = aAlphaWidth.z * uPixelRatio + 1.0;
  c.xy += n * aCorner.y * w / uResolution * c.w;
  gl_Position = c;
  vec3 p = mix(aA, aB, aCorner.x);
  float ext = exp(-length(p - uEye) * uFog * 0.35);
  vColor = aColor * mix(aAlphaWidth.x, aAlphaWidth.y, aCorner.x) * ext;
  vSide = aCorner.y;
}`;

export const LINES_FS = `${HEADER}
in vec3 vColor;
in float vSide;
out vec4 o;
void main(){
  float edge = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
  o = vec4(vColor * edge, 1.0);
}`;

// ---------------------------------------------------------------- holographic gate panels and light beams

export const GLOW_VS = `${HEADER}${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor; // rgb, intensity
layout(location=2) in vec2 aUv;
out vec4 vColor;
out vec2 vUv;
out vec3 vWorld;
void main(){
  vColor = aColor;
  vUv = aUv;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

/** uMode 0: gate panel (edge glow + scanlines); 1: light cone (fades along and across). */
export const GLOW_FS = `${HEADER}${COMMON}
in vec4 vColor;
in vec2 vUv;
in vec3 vWorld;
uniform float uMode;
out vec4 o;
void main(){
  float a;
  if (uMode < 0.5) {
    vec2 e = min(vUv, 1.0 - vUv);
    float edge = exp(-min(e.x, e.y) * 70.0);
    float scan = 0.5 + 0.5 * sin(vUv.y * 160.0 - uTime * 3.0);
    float fill = 0.006 + 0.01 * scan * scan;
    a = edge * 0.35 + fill;
  } else {
    float along = vUv.x;            // 0 at the lamp, 1 at the far end
    float across = abs(vUv.y - 0.5) * 2.0;
    a = (1.0 - along) * (1.0 - along) * (1.0 - across * across) * 0.5;
  }
  float ext = exp(-length(vWorld - uEye) * uFog * 0.4);
  o = vec4(vColor.rgb * vColor.a * a * ext, 1.0);
}`;

// ---------------------------------------------------------------- post-processing

export const BRIGHT_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uThreshold;
out vec4 o;
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  o = vec4(min(c * k, vec3(40.0)), 1.0);
}`;

export const DOWN_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main(){
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + t*vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSrc, vUv + t*vec2( 0.0, 2.0)).rgb;
  vec3 c = texture(uSrc, vUv + t*vec2( 2.0, 2.0)).rgb;
  vec3 d = texture(uSrc, vUv + t*vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSrc, vUv).rgb;
  vec3 f = texture(uSrc, vUv + t*vec2( 2.0, 0.0)).rgb;
  vec3 g = texture(uSrc, vUv + t*vec2(-2.0,-2.0)).rgb;
  vec3 h = texture(uSrc, vUv + t*vec2( 0.0,-2.0)).rgb;
  vec3 i = texture(uSrc, vUv + t*vec2( 2.0,-2.0)).rgb;
  vec3 j = texture(uSrc, vUv + t*vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSrc, vUv + t*vec2( 1.0, 1.0)).rgb;
  vec3 l = texture(uSrc, vUv + t*vec2(-1.0,-1.0)).rgb;
  vec3 m = texture(uSrc, vUv + t*vec2( 1.0,-1.0)).rgb;
  o = vec4(e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125, 1.0);
}`;

export const UP_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
out vec4 o;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb * 2.0
         + texture(uSrc, vUv + vec2(t.x, t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb * 2.0
         + texture(uSrc, vUv).rgb * 4.0 + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb * 2.0
         + texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb * 2.0
         + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb;
  o = vec4(s / 16.0, 1.0);
}`;

// ---------------------------------------------------------------- depth effects

const VIEWPOS = `
uniform sampler2D uDepth;
uniform mat4 uInvProj;
vec3 viewPos(vec2 uv) {
  float d = texture(uDepth, uv).r;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * Screen-space ambient occlusion from resolved depth alone: normals are
 * rebuilt from neighbouring depths, then sixteen samples in a hemisphere whose
 * radius grows with distance (a wing root up close, a street canyon from the
 * air) test whether nearby geometry hides the sky.
 */
export const SSAO_FS = `${HEADER}
in vec2 vUv;
uniform mat4 uProj;
uniform vec2 uTexel;
out vec4 o;
${VIEWPOS}
void main(){
  float d = texture(uDepth, vUv).r;
  if (d >= 0.99999) { o = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 r1 = viewPos(vUv + vec2(uTexel.x, 0.0)) - P;
  vec3 l1 = P - viewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 u1 = viewPos(vUv + vec2(0.0, uTexel.y)) - P;
  vec3 b1 = P - viewPos(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(r1.z) < abs(l1.z) ? r1 : l1;
  vec3 dy = abs(u1.z) < abs(b1.z) ? u1 : b1;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  float radius = clamp(-P.z * 0.018, 0.35, 28.0);
  float a0 = ign(gl_FragCoord.xy) * 6.2831853;
  vec3 rnd = vec3(cos(a0), sin(a0), 0.0);
  vec3 T = normalize(rnd - N * dot(rnd, N));
  vec3 B = cross(N, T);
  float occ = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float z = 0.15 + 0.85 * fract(fi * 0.618034 + 0.31);
    float ang = fi * 2.3999632;
    float rr = sqrt(1.0 - z * z);
    vec3 k = vec3(cos(ang) * rr, sin(ang) * rr, z);
    float scale = mix(0.1, 1.0, (fi + 1.0) / 16.0);
    scale *= scale;
    vec3 q = P + (T * k.x + B * k.y + N * k.z) * radius * scale;
    vec4 c = uProj * vec4(q, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float sceneZ = viewPos(uv).z;
    float range = smoothstep(0.0, 1.0, radius / max(abs(P.z - sceneZ), 1e-3));
    occ += step(q.z + radius * 0.03, sceneZ) * range;
  }
  float ao = pow(clamp(1.0 - occ / 16.0, 0.0, 1.0), 1.7);
  o = vec4(ao, ao, ao, 1.0);
}`;

/** A small bilateral blur that keeps occlusion from leaking across depth edges. */
export const AO_BLUR_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uAo;
uniform vec2 uAoTexel;
out vec4 o;
${VIEWPOS}
void main(){
  float zc = viewPos(vUv).z;
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 1; y++) {
    for (int x = -2; x <= 1; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) + 0.5) * uAoTexel;
      float z = viewPos(uv).z;
      float w = exp(-abs(z - zc) / max(abs(zc) * 0.02, 0.05));
      sum += texture(uAo, uv).r * w;
      wsum += w;
    }
  }
  float ao = sum / max(wsum, 1e-4);
  o = vec4(ao, ao, ao, 1.0);
}`;

/**
 * Depth of field with a thin-lens circle of confusion: the subject sharp, the
 * landscape behind it softly out of focus, bright lights opening into
 * bokeh discs. A spiral gather where each sample only counts if its own blur
 * reaches the pixel, so sharp foreground edges don't smear into the background.
 */
export const DOF_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uTexel;     // of the output target
uniform float uFocus;    // metres
uniform float uAperture; // lens blur scale in output pixels: f^2 / (N (s - f)) on the sensor
uniform float uMaxCoc;   // largest blur radius gathered, in output pixels
out vec4 o;
${VIEWPOS}
float distAt(vec2 uv) {
  if (texture(uDepth, uv).r >= 0.99999) return 1e6;
  return max(-viewPos(uv).z, 0.05);
}
// thin lens: the blur circle grows with |d - s| / d
float cocOf(float dist) { return clamp(uAperture * abs(dist - uFocus) / dist, 0.0, uMaxCoc); }
void main(){
  float dc = distAt(vUv);
  float c0 = cocOf(dc);
  vec3 col = texture(uScene, vUv).rgb;
  float tot = 1.0;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  for (int i = 1; i < 36; i++) {
    float fi = float(i);
    float r = sqrt(fi / 35.0) * uMaxCoc;
    float a = fi * 2.3999632 + rot;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
    float ds = distAt(uv);
    float cs = cocOf(ds);
    // background behind a sharper pixel can't spill over it
    if (ds > dc) cs = clamp(cs, 0.0, c0 * 2.0);
    float m = smoothstep(r - 0.5, r + 0.5, cs);
    col += mix(col / tot, texture(uScene, uv).rgb, m);
    tot += 1.0;
  }
  o = vec4(col / tot, clamp(c0 / 3.0, 0.0, 1.0));
}`;

/** Crepuscular rays: the bright sky around the sun smeared toward it, so
 * mountains, clouds and aircraft that block it cast shafts through the haze. */
export const RAYS_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uSunUv;
uniform float uAspect;
out vec4 o;
void main(){
  vec2 delta = (vUv - uSunUv) / 40.0;
  vec2 uv = vUv;
  float decay = 1.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 40; i++) {
    uv -= delta;
    vec3 c = texture(uSrc, uv).rgb;
    float l = max(c.r, max(c.g, c.b));
    // only the sun and the glowing sky round it shine through: lit fields do not streak
    sum += c * smoothstep(1.3, 3.0, l) * decay;
    decay *= 0.965;
  }
  vec2 dd = (vUv - uSunUv) * vec2(uAspect, 1.0);
  o = vec4(sum / 40.0 * exp(-dot(dd, dd) * 1.6), 1.0);
}`;

export const COMPOSITE_FS = `${HEADER}
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uRays;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uTime;
uniform float uDim;
uniform float uAberration;
uniform vec3 uSun;     // screen uv of the sun, z = how visible it is (0..1)
uniform float uAspect;
uniform sampler2D uAo;
uniform float uAoOn;
uniform sampler2D uDof;
uniform float uDofOn;
out vec4 o;

/** Lens ghosts strung along the line from the sun through the frame centre. */
vec3 flare(vec2 uv) {
  if (uSun.z <= 0.001) return vec3(0.0);
  vec2 axis = vec2(0.5) - uSun.xy;
  vec3 sum = vec3(0.0);
  const float T[6] = float[6](0.35, 0.62, 0.9, 1.25, 1.55, 1.9);
  const float S[6] = float[6](0.03, 0.055, 0.018, 0.09, 0.04, 0.13);
  for (int i = 0; i < 6; i++) {
    vec2 c = uSun.xy + axis * T[i];
    vec2 d = (uv - c) * vec2(uAspect, 1.0);
    float r = length(d) / S[i];
    float disc = (1.0 - smoothstep(0.82, 1.0, r)) * (0.55 + 0.45 * smoothstep(0.4, 1.0, r));
    vec3 tint = i % 3 == 0 ? vec3(0.35, 0.55, 1.0) : i % 3 == 1 ? vec3(1.0, 0.55, 0.25) : vec3(0.5, 1.0, 0.6);
    sum += tint * disc * (i == 5 ? 0.012 : 0.03);
  }
  // a faint halo ring and the starburst glare around the sun itself
  vec2 ds = (uv - uSun.xy) * vec2(uAspect, 1.0);
  float rs = length(ds);
  sum += vec3(1.0, 0.75, 0.5) * (1.0 - smoothstep(0.0, 0.03, abs(rs - 0.32))) * 0.025;
  float ang = atan(ds.y, ds.x);
  sum += vec3(1.0, 0.8, 0.6) * pow(abs(cos(ang * 3.0)), 60.0) * exp(-rs * 9.0) * 0.35;
  // the sun has to be visible in the frame itself: mountains and aircraft occlude the flare
  vec3 at = texture(uScene, uSun.xy).rgb;
  float occ = smoothstep(1.2, 4.0, max(at.r, max(at.g, at.b)));
  return sum * uSun.z * occ;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
vec3 displayColor(vec3 linearColor) {
  return mix(linearColor * 12.92, 1.055 * pow(max(linearColor, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), linearColor));
}
float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 d = vUv - 0.5;
  vec2 off = d * uAberration;
  vec3 c = vec3(texture(uScene, vUv + off).r, texture(uScene, vUv).g, texture(uScene, vUv - off).b);
  if (uDofOn > 0.5) {
    vec4 dd = texture(uDof, vUv);
    c = mix(c, dd.rgb, smoothstep(0.2, 0.85, dd.a));
  }
  if (uAoOn > 0.5) c *= mix(1.0, texture(uAo, vUv).r, 0.78);
  c += texture(uBloom, vUv).rgb * uBloomStrength;
  c += texture(uRays, vUv).rgb * vec3(1.0, 0.82, 0.6) * 0.55 * uSun.z;
  c += flare(vUv);
  c = aces(c * uExposure);
  // grading: a gentle filmic S-curve, warm highlights, cool shadows, a touch more colour
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
  c += vec3(0.018, 0.006, -0.012) * smoothstep(0.45, 1.0, luma) + vec3(-0.006, 0.0, 0.01) * (1.0 - smoothstep(0.0, 0.3, luma));
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.08);
  c *= 1.0 - dot(d, d) * 0.65;
  c = displayColor(max(c, vec3(0.0)));
  c += (rand(vUv * 913.0) - 0.5) * 0.004;
  o = vec4(c * uDim, 1.0);
}`;
