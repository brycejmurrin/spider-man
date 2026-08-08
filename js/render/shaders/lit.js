/*
 * Apex 26 — GLSL sources for the WebGL2 renderer (js/render/glx.js):
 * the LIT program (LIT_VS/LIT_FS) — the scene pass: PBR sun +
 * hemisphere ambient + 32 point lights, procedural materials, sun shadow,
 * wet-road response, fog.
 * Split from the old monolithic glx-shaders.js. Template strings may
 * interpolate GLXChunks (js/render/shaders/chunks.js — loads first); each file
 * registers its programs on the shared GLXShaders global. All shader files
 * must load BEFORE js/render/glx.js (it destructures GLXShaders at eval).
 */
import { GLXChunks } from "./chunks.js";

  const LIT_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in float aMat;   // per-vertex material id (0 = FLAT/untextured)
layout(location=4) in vec3 aTrk;    // road only: (arc-length s, signed lateral x, half-width). (0,0,0) elsewhere.
// INSTANCING (opt-in). Locations 5-8 are the four COLUMNS of a per-instance
// model matrix and 9 a per-instance colour, all with vertexAttribDivisor(1).
// They are only bound by drawInstanced(); every other draw leaves them disabled,
// which is why uInstanced gates the matrix rather than relying on the generic
// attribute value (a disabled vec4 reads (0,0,0,1), i.e. a degenerate mat4).
// aICol needs no gate: GLX sets the generic value to (1,1,1) once at init, so
// the multiply below is the identity on every non-instanced draw.
layout(location=5) in vec4 aInst0;
layout(location=6) in vec4 aInst1;
layout(location=7) in vec4 aInst2;
layout(location=8) in vec4 aInst3;
layout(location=9) in vec3 aInstCol;
uniform float uInstanced;   // 0 = use uModel (default), 1 = use the instance columns
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uTime;   // seconds (shared with the FS cloud-drift clock) — drives the FLAG wave
out vec3 vNrm;
out vec3 vCol;
out vec3 vWorldPos;
out vec3 vObjPos;
out float vDist;
flat out float vMat;
out vec3 vTrk;        // smooth (NOT flat): the marking SDF needs x/s to vary across the quad
void main() {
  vec3 pos = aPos;
  // FLAG material (id 15, aMat 15.0..15.4): cloth wind-wave. The FRACTIONAL
  // part of aMat encodes a per-vertex wave weight (0 = hoist edge pinned to
  // the pole, 0.4 → weight 1 = free edge); a travelling two-sine ripple
  // displaces along the face normal, so marshal flags flutter while every
  // other material keeps the exact static path (pos == aPos).
  if (aMat >= 15.0 && aMat < 16.0) {
    float fw = fract(aMat) * 2.5;
    float ph = uTime * 5.5 + aPos.x * 1.9 + aPos.z * 1.9;
    pos += aNrm * ((sin(ph) * 0.085 + sin(ph * 2.17 + 1.3) * 0.045) * fw);
  }
  mat4 M = uInstanced > 0.5 ? mat4(aInst0, aInst1, aInst2, aInst3) : uModel;
  vec4 wp = M * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  vObjPos = aPos;                 // object space: paint flake/orange-peel pattern
                                  // is glued to the panels, not streaming in world.
  // NOTE mat3(M), not an inverse-transpose: an instance matrix here is a scaled
  // ORTHONORMAL basis (TrackGraph builds columns r*sx, u*sy, t*sz), so this is
  // correct up to a length the shader normalises anyway — the same assumption
  // uModel already relied on.
  vNrm = mat3(M) * aNrm;
  vCol = aCol * aInstCol;
  vMat = aMat;                    // constant across the face (flat) — procedural material key
  vTrk = aTrk;                    // road track-space coords; interpolated across the ribbon
  vDist = length(wp.xyz - uEye);
  gl_Position = uViewProj * wp;
}`;

  // Lit shader: hemisphere ambient + lambert sun (the original, tuned look) PLUS
  // a Cook-Torrance (GGX) specular highlight on top. The diffuse + ambient base is
  // identical to the old shader when uMetalness==0, so the hand-tuned vertex-colour
  // palette is preserved; the spec term is soft-clipped so it sheens rather than
  // blooms. Per-draw material: uRoughness / uMetalness / uSpecular.
  const LIT_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vNrm;
in vec3 vCol;
in vec3 vWorldPos;
in vec3 vObjPos;
in float vDist;
flat in float vMat;   // procedural material id (0 = FLAT); textured in applyMaterial()
in vec3 vTrk;         // road: (s, lateral x, half-width) — drives roadMarkings()
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbGround;
uniform vec3 uAmbSky;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uEmissive;
uniform float uAlpha;
uniform float uRoughness;
uniform float uMetalness;
uniform float uSpecular;
uniform float uDetail;
uniform float uClearcoat;  // 0..1 automotive lacquer layer: 2nd low-rough specular lobe
uniform float uCarPaint;    // 0..1 car-paint model: duotone pigment + bounded silhouette rim
uniform float uSparkle;     // 0..1 metallic-flake glitter strength (1 in-race; low in the setup turntable to kill the "twinkle")
uniform float uWetness;     // 0..1 rain wetness (wet-road material + reflections)
// ── Baked PBR material maps (js/render/assets.js) ────────────────────────────
// TEXTURE_2D_ARRAY whose LAYER INDEX IS THE MAT ID (js/track/geom.js MAT). No
// UV channel exists anywhere on the lit path and none is needed: the sample
// reuses the procedural materials' own triplanar convention below, so a scanned
// map lands on exactly the coordinate the noise it augments already uses.
// uMatTexMix is a LIGHTING TUNER knob shipped at 1.0 (full baked detail);
// __apex.matTex(0) is the A/B off-switch — at 0 nothing here executes and the
// render is byte-identical to the pure-procedural pre-scan game.
uniform lowp sampler2DArray uMatAlbedoTex;  // rgb = albedo reflectance, a = roughness
uniform lowp sampler2DArray uMatNormalTex;  // rg = tangent normal xy, b = AO
uniform float uMatTexMix;                   // ships 1.0 = full baked; 0 = pure procedural
uniform float uMatTexScale[17];             // world metres per tile per layer; 0 = layer absent
uniform samplerCube uEnvCube;  // live 64px env probe around the player car (one face/frame)
uniform float uEnvStr;         // 0 until the probe's first full 6-face cycle; then the CAR tuner's envCube strength
uniform sampler2DShadow uShadowMap;
uniform mat4 uLightVP;
uniform float uShadowBias;
uniform float uShadowStr;
uniform float uShadowTexel;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uFogHeight;
uniform float uGroundMist;  // 0..1 low-lying drifting ground mist
uniform float uLampFog;     // lamp-glow-in-fog strength (0 = off / day)
uniform sampler2D uBlockerMap;  // PCSS-lite min-depth blocker map (512sq)
uniform float uPcss;            // 1 = blocker map valid, 0 = fixed penumbra
// Live-tunable constants (LIGHTING TUNER panel / __apex.lightTune) — defaults
// mirror LightTune.TUNE_DEFS (js/game/lighting.js); uploaded per frame from frame.tune in begin().
uniform float uBounceK;     // per-lamp bounce-fill strength (was literal 0.04)
uniform float uMistShare;   // ground-mist share of the lamp fog glow (was 1.5)
uniform float uLampFogClip; // lamp-fog Reinhard shoulder strength (was 0.7)
uniform float uGlowAmp;     // emissive HDR glow push (was literal 2.3)
uniform float uBloomBoost;  // extra HDR push per unit of OVER-WHITE albedo (neon/lens tag)
uniform float uPcssPen;     // PCSS penumbra growth rate (was literal 80.0)
uniform float uKeyMul;      // direct sun/key-light intensity multiplier (default 1)
uniform float uTime;        // seconds (drives cloud-shadow drift)
uniform float uCloudCover;  // 0..1 cloud cover (drives cloud shadows)
uniform float uCloudSpeed;  // cloud drift-rate multiplier (matches SKY uCloudSpeed; 0 = frozen)
uniform float uCloudShadowDim; // how darkly cloud shadows dim the sun (def 0.80)
uniform float uCarSunGlint; // clearcoat sun-disc reflection punch on car paint (def 12.0)
uniform float uCarSparkle;  // metallic-flake sparkle glint gain (def 1.6)
uniform float uFogSunCore;  // tight hot core of the sun in-scatter through fog (def 0.6)
uniform float uFogTint;     // −1 cool .. +1 warm white-balance on the distance haze
uniform float uMistHeight;  // ground-mist layer height band (world m scale, def 0.30)
uniform float uShadowTintAmt; // 0..1 cool-blue tint on shadowed / ambient-only areas
uniform float uWetDark;     // wet-asphalt darkening multiplier (def 1.0)
uniform float uLampNearClamp;  // near-field distance floor on lamp 1/d² falloff (m, def 4.0) — tames close-by wall blow-out (dual: WGSL F.params7.w)
uniform float uWindowSunFlash; // glossy-glass dry sun-flash reflection strength (def 1.0 = shipped 0.6)
uniform float uSkyRimGlow;     // grazing-angle atmospheric sky-rim brightening strength (def 1.0 = shipped 0.18)
uniform float uAmbContactDark; // ambient contact-darkening depth on downward faces (def 1.0 = shipped 0.88 floor)
uniform float uLampWallSpill;  // out-of-beam lamp reflection floor on walls/road (def 1.0 = shipped 0.16/0.30)
uniform float uShadowRange; // sun shadow box half-size (m, def 80) — drives the receiver-distance shadow fade
uniform vec3 uShadowCtr;    // unsnapped shadow-box anchor (ground level, glides with the camera) — the fade origin
// Dynamic CAR shadow map: car meshes only, re-rendered every frame (the static
// map above is snap-cached and can't hold movers). 1024², box ±42 m on the anchor.
uniform highp sampler2DShadow uCarShadowMap;
uniform mat4 uCarLightVP;
uniform float uCarShadowOn;
// Nearest-FLOODLIGHT spot shadow (night, desktop): a 512² depth map rendered
// per frame from the single nearest lamp to the camera (perspective VP down its
// beam). Only the light-loop slot uLampShadowIdx pays the 4-tap PCF — every
// other lamp skips the branch, so the whole feature costs one lamp's shadow.
uniform highp sampler2DShadow uLampShadowMap;
uniform mat4 uLampShadowVP;
uniform float uLampShadowOn;
uniform int uLampShadowIdx;
// Point lights (floodlights / street lights — mainly for night tracks). Each is
// {position, colour*intensity, radius}; uNumLights of the MAX_LIGHTS slots used.
const int MAX_LIGHTS = 32;
uniform int uNumLights;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightCol[MAX_LIGHTS];
uniform float uLightRad[MAX_LIGHTS];
uniform vec3 uLightDir[MAX_LIGHTS];    // per-lamp beam aim (normalized, tilted over the road)
uniform vec2 uLightCone[MAX_LIGHTS];   // per-lamp spot cone: x=cosInner, y=cosOuter
uniform float uLightBleed[MAX_LIGHTS]; // out-of-beam floor (city skyglow spill)
out vec4 outColor;

const float PI = 3.14159265359;

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-6);
}
// Height-correlated Smith visibility (folds in the 1/(4 NoL NoV) denominator).
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
// Roughness-aware Schlick: grazing reflectance is capped at f90 = 1-roughness
// (Frostbite trick) so rough surfaces like asphalt/grass don't pick up a wet
// mirror sheen at the horizon, while smooth paint keeps its grazing reflection.
vec3 F_Schlick(float VoH, vec3 f0, float f90) {
  float v = 1.0 - VoH; float v2 = v * v;
  return f0 + (vec3(f90) - f0) * (v2 * v2 * v);
}

// --- Procedural surface texture (value noise on world XZ; no UVs needed) ---
${GLXChunks.surfaceNoise}
${GLXChunks.ignoise}
// ── Procedural per-material surface texture (triplanar, UV-free) ─────────────
// Keyed by the flat per-vertex material id (aMat): brick, glass, concrete,
// metal, wood, foliage, fabric, sand, grass, rock, snow, roof tile, stone,
// rust/corrugated. No image textures, no UVs — everything below is world/
// object-position noise. Two passes:
//  1) applyMaterialNormal() — a REAL bump: perturbs the shading normal BEFORE
//     the lighting terms (NoL, shadow, specular) consume it, so mortar grooves,
//     plank seams, corrugation ridges etc. actually catch and cast light —
//     not just an albedo tint. Called early in main(), right after the
//     existing ground/car-paint normal relief.
//  2) applyMaterial() — albedo + roughness modulation, called after rough is
//     resolved (unchanged call site from the original single-pass version).
// Both key off the SAME per-material coordinate convention (hc/y for wall-like
// materials, wp.xz for organic/horizontal ones) so the bump and the tint line
// up — recessed mortar reads darker AND indented, not just darker.

// Scalar relief height for material mid at local coords uv (either (hc,y)
// for wall materials or world (x,z) for horizontal/organic ones — see call
// sites below). Sampled 3x per fragment (center + 2 offsets) for a gradient.
float matBumpHeight(int mid, vec2 uv) {
  float hc = uv.x, y = uv.y;
  if (mid == 1) {          // CONCRETE: fine aggregate + a shallow form-seam groove
    float seam = smoothstep(0.05, 0.0, abs(fract(y / 1.25) - 0.5) - 0.46);
    return vnoise(uv * 6.0) * 0.6 - seam * 0.5;
  } else if (mid == 2) {   // BRICK: bricks proud, mortar recessed
    float ch = 0.20, bl = 0.42, mort = 0.06;
    float row = floor(y / ch), off = mod(row, 2.0) * 0.5 * bl;
    float bx = fract((hc + off) / bl), by = fract(y / ch);
    float joint = max(smoothstep(mort, 0.0, min(bx, 1.0 - bx) * bl),
                      smoothstep(mort, 0.0, min(by, 1.0 - by) * ch));
    return (1.0 - joint) * 0.5 + vnoise(vec2(floor((hc + off) / bl), row) * 4.0) * 0.10;
  } else if (mid == 4) {   // METAL: fine brushed streaks along the vertical axis
    return vnoise(vec2(hc * 55.0, y * 3.0)) * 0.3;
  } else if (mid == 5) {   // WOOD: plank seams recessed + grain ridges along the board
    float seam = smoothstep(0.05, 0.0, abs(fract(hc / 0.35) - 0.5) - 0.46);
    return (1.0 - seam) * 0.4 + vnoise(vec2(hc * 3.0, y * 22.0)) * 0.16;
  } else if (mid == 6) {   // FOLIAGE: lumpy per-leaf-cluster relief
    return vnoise(uv * 3.2) * 0.5 + vnoise(uv * 11.0) * 0.3;
  } else if (mid == 7) {   // FABRIC: woven cross-thread ridges
    return sin(hc * 38.0) * 0.15 + sin(y * 38.0) * 0.15;
  } else if (mid == 8) {   // SAND: dune ripple — a real raised ridge, not just shading
    return sin(hc * 3.0 + vnoise(uv * 0.3) * 6.0) * 0.5 + vnoise(uv * 8.0) * 0.2;
  } else if (mid == 9) {   // GRASS: fine blade-clump bump
    return vnoise(uv * 6.0) * 0.4 + vnoise(uv * 20.0) * 0.25;
  } else if (mid == 10) {  // ROCK: craggy multi-octave relief
    return vnoise(uv * 1.3) * 0.6 + vnoise(uv * 4.5) * 0.3 + vnoise(uv * 15.0) * 0.15;
  } else if (mid == 11) {  // SNOW: soft drifts + a fine sparkly crust
    return vnoise(uv * 1.8) * 0.45 + vnoise(uv * 21.0) * 0.18;
  } else if (mid == 12) {  // ROOF (terracotta tile): ridged overlapping courses
    float ty = fract(y / 0.34);
    return sin(ty * 3.14159) * 0.5 + vnoise(vec2(hc * 2.0, floor(y / 0.34)) * 3.0) * 0.08;
  } else if (mid == 13) {  // STONE: irregular jittered blocks, deep mortar
    vec2 cell = floor(uv * 1.3);
    vec2 f = fract(uv * 1.3) - hash21(cell) * 0.12;
    float d = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    return smoothstep(0.0, 0.16, d) * 0.55 + vnoise(uv * 5.0) * 0.15;
  } else if (mid == 14) {  // RUST / CORRUGATED METAL: real sinusoidal corrugation
    return sin(hc * 7.5) * 0.55 + vnoise(uv * 6.0) * 0.10;
  } else if (mid == 16) {  // ASPHALT: fine aggregate only — no macro relief
    // Two tight octaves and nothing below ~0.1 m. A low-frequency term here
    // would read as a rippled/bumpy road under the car and crawl at speed.
    return vnoise(uv * 9.0) * 0.34 + vnoise(uv * 26.0) * 0.16;
  }
  return 0.0;
}
// Is this material coursed/planked/panelled (keys off the wall coord (hc, y))
// rather than organic/horizontal (keys off world (x, z))? Shared by the
// procedural bump below and the baked texture sample, so the two can never
// disagree about which way a material's pattern runs — a scan landing rotated
// 90 degrees against the noise it augments would read as a smeared mess.
// NOTE this is a per-MATERIAL classification. applyMaterial()'s "wall" local is
// a different thing: a per-FRAGMENT orientation test (an.y < 0.6).
// (No backticks anywhere below this line — the GLSL is a JS template literal.)
bool matWallLike(int mid) {
  return mid == 1 || mid == 2 || mid == 4 || mid == 5 || mid == 7 || mid == 12 || mid == 13 || mid == 14;
}
// Triplanar tile coordinate for a baked material layer. Returns false when the
// feature is off (uMatTexMix 0), the id is out of range, or this MAT simply has
// no baked layer in the pack (scale 0) — in every one of those cases the caller
// leaves the procedural result alone, which is the shipping look.
bool matTexUV(int mid, out vec2 uv) {
  if (uMatTexMix <= 0.001 || mid <= 0 || mid > 16) { uv = vec2(0.0); return false; }
  float sc = uMatTexScale[mid];
  if (sc <= 0.0) { uv = vec2(0.0); return false; }
  vec3 an = abs(normalize(vNrm));
  uv = (matWallLike(mid) ? vec2(an.x > an.z ? vWorldPos.z : vWorldPos.x, vWorldPos.y)
                         : vWorldPos.xz) / sc;
  return true;
}
// Baked NORMAL map, applied right after the procedural bump and composing with
// it: the scan carries fine detail the noise cannot express, the noise carries
// the macro relief that would cost a much larger texture. Both perturb N BEFORE
// the lighting terms consume it, so a baked groove genuinely catches light.
void applyMaterialTexNormal(int mid, inout vec3 N, float vd) {
  vec2 uv;
  if (!matTexUV(mid, uv)) return;
  float fade = clamp(1.0 - (vd - 22.0) / 58.0, 0.0, 1.0);   // same reach as the procedural bump
  if (fade <= 0.005) return;
  // The SAME grazing-angle guard applyMaterialNormal uses, and for the same
  // reason: at a shallow angle a pixel spans many texels, the mip chain averages
  // the tangent normal toward flat, and what is left aliases into crawling
  // moire on a surface moving past at 80 m/s. Fade relief by the per-pixel
  // footprint of the tile coordinate — the normal-map analog of mip-fading.
  float fp = max(fwidth(uv.x), fwidth(uv.y));
  float aa = clamp(1.0 - (fp - 0.02) / 0.30, 0.0, 1.0);
  if (aa <= 0.005) return;
  vec2 dxy = (texture(uMatNormalTex, vec3(uv, float(mid))).xy - 0.5) * 2.0;
  vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-5));
  vec3 B = cross(N, T);
  // ASPHALT stays deliberately the weakest in the table — see the MAT.ASPHALT
  // note in js/track/geom.js: the road is viewed edge-on for the whole race and
  // anything with real relief crawls.
  float amt = (mid == 16 ? 0.10 : 0.55) * uMatTexMix * fade * aa;
  N = normalize(N + (T * dxy.x + B * dxy.y) * amt);
}
// Wall-like materials (coursed/planked/panelled) key off (hc, y): hc runs along
// the wall's horizontal span, y is world-up. Organic/horizontal materials
// (foliage, sand, grass, rock, snow) key off world (x, z), matching the
// existing ground micro-relief above. GLASS (3) is intentionally left flat —
// bump would blur its mirror-reflection read.
void applyMaterialNormal(int mid, inout vec3 N, float vd) {
  if (mid == 0 || mid == 3 || mid == 15) return;   // FLAT/GLASS/FLAG: no procedural bump
  float bumpFade = clamp(1.0 - (vd - 22.0) / 58.0, 0.0, 1.0);
  if (bumpFade <= 0.005) return;
  if (matWallLike(mid)) {
    vec3 an = abs(N);
    float hc = an.x > an.z ? vWorldPos.z : vWorldPos.x;
    float y = vWorldPos.y;
    // Fade the bump by the per-pixel WORLD FOOTPRINT of the (hc,y) coord, not
    // just camera distance. The height gradient below is a fixed-epsilon
    // (0.05 m) 3-tap probe; when a pixel spans more than the finest brick/stone
    // feature (~0.06 m) — which happens at a GRAZING viewing angle even up
    // close, from foreshortening — those three taps land at effectively random
    // points in the pattern and the perturbed normal aliases into a swirling
    // moiré ("wavy" sheen on the shallow-angle side of a facade). fwidth()
    // catches the grazing stretch that the distance-only bumpFade cannot; as
    // the footprint grows the relief flattens toward the interpolated N, the
    // normal-map analog of mip-fading high-frequency texture detail.
    float fp = max(fwidth(hc), fwidth(y));
    float aaFade = clamp(1.0 - (fp - 0.04) / 0.22, 0.0, 1.0);
    if (aaFade <= 0.005) return;
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-5));
    float e = 0.05;
    float h0 = matBumpHeight(mid, vec2(hc, y));
    float hx = matBumpHeight(mid, vec2(hc + e, y));
    float hy = matBumpHeight(mid, vec2(hc, y + e));
    float amt = (mid == 2 || mid == 13) ? 0.10 : (mid == 12 || mid == 14) ? 0.09 : 0.05;
    N = normalize(N + (T * (h0 - hx) + vec3(0.0, 1.0, 0.0) * (h0 - hy)) * (amt * bumpFade * aaFade / e));
  } else {
    vec2 p = vWorldPos.xz;
    // Same grazing-angle guard the wallLike branch uses. Ground materials were
    // exempt because you normally look DOWN at them — but the road is the one
    // horizontal surface viewed almost edge-on at 80 m/s, where foreshortening
    // makes a pixel span many times the probe epsilon and the 3-tap gradient
    // aliases into crawling moiré. Fading relief by the per-pixel world
    // footprint is the normal-map analog of mip-fading, and it only ever
    // REDUCES bump, so head-on grass/sand/rock keep their existing look.
    float fpG = max(fwidth(p.x), fwidth(p.y));
    float aaG = clamp(1.0 - (fpG - 0.10) / 0.55, 0.0, 1.0);
    if (aaG <= 0.005) return;
    float e = 0.22;
    float h0 = matBumpHeight(mid, p);
    float hx = matBumpHeight(mid, p + vec2(e, 0.0));
    float hz = matBumpHeight(mid, p + vec2(0.0, e));
    // ASPHALT (16) is deliberately the weakest relief in the table.
    float amt = mid == 8 ? 0.16 : mid == 10 ? 0.14 : mid == 16 ? 0.025 : 0.07;
    N = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * (amt * bumpFade * aaG / e));
  }
}
// Albedo + roughness modulation (unchanged call site: after rough is resolved).
void applyMaterial(int mid, inout vec3 albedo, inout float rough, float vd) {
  if (mid == 0) return;
  float far  = clamp(1.0 - (vd - 90.0) / 170.0, 0.0, 1.0);   // coarse tint: mid range
  if (far <= 0.001) return;                                   // too distant to read — skip the noise
  float near = clamp(1.0 - (vd - 26.0) / 64.0, 0.0, 1.0);    // fine detail: near field only
  vec3 wp = vWorldPos;
  vec3 an = abs(normalize(vNrm));
  bool wall = an.y < 0.6;                          // roughly vertical face
  float hc = an.x > an.z ? wp.z : wp.x;            // horizontal coord along the wall
  float y = wp.y;
  if (mid == 1) {            // CONCRETE — patchy panels + fine speckle + form seams
    albedo *= 1.0 + (vnoise(wp.xz * 0.09 + y * 0.05) - 0.5) * 0.16 * far;
    albedo *= 1.0 + (vnoise(vec2(hc, y) * 6.0) - 0.5) * 0.10 * near;
    // AA the seam: fwidth() on the PRE-fract coordinate (fract() itself has a
    // hard C0 seam that would spike the derivative) widens the transition band
    // once a screen pixel spans more world-units than the seam's fixed 0.05 —
    // otherwise the line strobes between "on/off" as the camera moves (the
    // reported building-texture shimmer).
    if (wall) albedo *= 1.0 - smoothstep(max(0.05, fwidth(y / 1.25)), 0.0, abs(fract(y / 1.25) - 0.5) - 0.46) * 0.14 * near;
    rough = min(1.0, rough + 0.08 * far);
  } else if (mid == 2) {     // BRICK — courses + staggered joints + per-brick tint
    float ch = 0.20, bl = 0.42, mort = 0.06;
    float row = floor(y / ch);
    float off = mod(row, 2.0) * 0.5 * bl;
    float bx = fract((hc + off) / bl), by = fract(y / ch);
    // mort is a WORLD-space distance (min(bx,1-bx)*bl converts back to metres),
    // so the AA width is the raw per-pixel footprint of hc/y — see the seam
    // note above for why this must scale with distance/viewing angle.
    float mortAA = max(mort, max(fwidth(hc), fwidth(y)));
    float joint = max(smoothstep(mortAA, 0.0, min(bx, 1.0 - bx) * bl),
                      smoothstep(mortAA, 0.0, min(by, 1.0 - by) * ch));
    float bh = vnoise(vec2(floor((hc + off) / bl), row) * 1.3);
    vec3 brick = albedo * (0.82 + bh * 0.42) * vec3(1.06, 0.99, 0.92);
    vec3 mortar = mix(albedo, vec3(0.60, 0.58, 0.55), 0.6);
    albedo = mix(brick, mortar, joint * near);
    rough = min(1.0, rough + 0.12 * far);
  } else if (mid == 3) {     // GLASS / CURTAIN WALL — mullion grid + per-pane variation
    float pw = 1.6, ph = 1.4, mull = 0.11;
    float gx = fract(hc / pw), gy = fract(y / ph);
    // mull compares against a NORMALIZED (0..1 pane-fraction) distance here —
    // unlike brick's mort above, gx/gy are never scaled back to metres — so the
    // AA width must be fwidth() of the pre-fract NORMALIZED coordinate, not the
    // raw world-space one.
    float mullAA = max(mull, max(fwidth(hc / pw), fwidth(y / ph)));
    float bar = max(smoothstep(mullAA, 0.0, min(gx, 1.0 - gx)),
                    smoothstep(mullAA, 0.0, min(gy, 1.0 - gy)));
    albedo *= 1.0 + (vnoise(vec2(floor(hc / pw), floor(y / ph)) * 1.7) - 0.5) * 0.5 * far;
    albedo = mix(albedo, albedo * 0.32, bar * near);
    rough = mix(rough, min(rough, 0.12), near);
  } else if (mid == 4) {     // METAL — brushed vertical streaks, glossier
    float brushFade = clamp(1.0 - (vd - 26.0) / 29.0, 0.0, 1.0);   // fade 40-cycle brushing over 26-55m (tighter than 'near') so it stops sparkling
    albedo *= 1.0 + (vnoise(vec2(hc * 40.0, y * 2.0)) - 0.5) * 0.12 * brushFade;
    rough = clamp(rough - 0.15 * far, 0.05, 1.0);
  } else if (mid == 5) {     // WOOD — grain lines + plank seams
    albedo *= 1.0 + (vnoise(vec2(hc * 3.0, y * 22.0)) - 0.5) * 0.18 * near;
    // Same normalized-space AA correction as glass's mullion grid above.
    albedo *= 1.0 - smoothstep(max(0.05, fwidth(hc / 0.35)), 0.0, abs(fract(hc / 0.35) - 0.5) - 0.46) * 0.16 * near;
  } else if (mid == 6) {     // FOLIAGE — dapple + green variation, breaks flat canopy
    float d = vnoise(wp.xz * 2.4 + wp.y * 1.6) * 0.6 + vnoise(wp.xz * 9.0) * 0.4 * near;
    albedo *= 1.0 + (d - 0.5) * 0.34 * far;
    albedo.g *= 1.0 + (d - 0.5) * 0.10 * far;
  } else if (mid == 7) {     // FABRIC / CROWD / TENT — fine weave speckle
    float weaveFade = clamp(1.0 - (vd - 26.0) / 34.0, 0.0, 1.0);   // fade 26-cycle weave over 26-60m so it stops crawling mid-range
    albedo *= 1.0 + (vnoise(vec2(hc, y) * 26.0) - 0.5) * 0.14 * weaveFade;
  } else if (mid == 8) {     // SAND — fine grain + gentle dune ripple
    albedo *= 1.0 + (vnoise(wp.xz * 5.0) - 0.5) * 0.12 * near
                  + sin(wp.x * 0.7 + vnoise(wp.xz * 0.2) * 6.0) * 0.05 * far;
  } else if (mid == 9) {     // GRASS — bladed clumps + tone variation
    float g = vnoise(wp.xz * 3.5) * 0.6 + vnoise(wp.xz * 14.0) * 0.4 * near - 0.5;
    albedo *= 1.0 + g * 0.22 * far;
    albedo.g *= 1.0 + g * 0.08 * far;
  } else if (mid == 10) {    // ROCK — craggy grey-brown, multi-scale tonal variation
    float r = vnoise(wp.xz * 0.9 + y * 0.6) * 0.6 + vnoise(wp.xz * 4.5) * 0.4 - 0.5;
    albedo *= 1.0 + r * 0.30 * far;
    rough = min(1.0, rough + 0.16 * far);
  } else if (mid == 11) {    // SNOW — bright, soft blue-shaded crevices, sparkle near
    float s = vnoise(wp.xz * 1.6 + y * 0.4) - 0.5;
    albedo *= 1.0 + s * 0.10 * far;
    albedo.b *= 1.0 - s * 0.05 * far;              // shaded drifts read faintly cool
    float sparkleFade = clamp(1.0 - (vd - 26.0) / 34.0, 0.0, 1.0);  // fade 24-cycle snow sparkle over 26-60m so it stops shimmering
    albedo *= 1.0 + (vnoise(wp.xz * 24.0) - 0.5) * 0.06 * sparkleFade;
    rough = clamp(rough - 0.10 * far, 0.05, 1.0);
  } else if (mid == 12) {    // ROOF (terracotta tile) — ridged courses, warm tone bands
    float ty = fract(y / 0.34);
    float shadeAA = clamp(1.0 - fwidth(ty) * 6.0, 0.0, 1.0);           // fade tile-ridge sine when a pixel covers >~1/6 of a tile → no shimmer
    float shade = sin(ty * 3.14159) * shadeAA;
    albedo *= 0.88 + shade * 0.16;
    albedo *= 1.0 + (vnoise(vec2(hc * 2.0, floor(y / 0.34)) * 3.0) - 0.5) * 0.14 * near;
    rough = min(1.0, rough + 0.10 * far);
  } else if (mid == 13) {    // STONE — irregular jittered blocks, deep mortar
    vec2 cell = floor(vec2(hc, y) * 1.3);
    vec2 f = fract(vec2(hc, y) * 1.3) - hash21(cell) * 0.12;
    float d = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    // Normalized-space AA (same correction as glass/wood above): d lives in the
    // *1.3 fract domain, so widen by fwidth() of that same pre-fract coordinate.
    float jointAA = max(0.16, max(fwidth(hc * 1.3), fwidth(y * 1.3)));
    float joint = smoothstep(0.0, jointAA, d);
    vec3 block = albedo * (0.80 + hash21(cell) * 0.4);
    vec3 mortar = mix(albedo, vec3(0.42, 0.40, 0.37), 0.65);
    albedo = mix(mortar, block, joint * near);
    rough = min(1.0, rough + 0.18 * far);
  } else if (mid == 14) {    // RUST / CORRUGATED METAL — ridge shading + rust streaks
    float ridgePhase = hc * 7.5;
    float ridgeAA = clamp(1.0 - fwidth(ridgePhase) * 3.0, 0.0, 1.0);   // fade the corrugation sine as a pixel spans >~1/3 cycle → no crawl at distance
    float ridge = sin(ridgePhase) * ridgeAA;
    albedo *= 0.85 + ridge * 0.18;
    float rust = smoothstep(0.55, 0.9, vnoise(vec2(hc * 0.8, y * 0.35) + 5.0));
    albedo = mix(albedo, albedo * vec3(0.62, 0.42, 0.28), rust * 0.5 * far);
    rough = min(1.0, rough + 0.14 * far);
  } else if (mid == 16) {    // ASPHALT — aggregate speckle + broad laying/wear patches (markings: roadMarkings())
    // Deliberately understated: this is the surface under the car for the whole
    // race, so it gets tone variation rather than pattern. No fract()/sin()
    // term at all — nothing here can strobe, only soften.
    // Broad patches read as laying joints / differential wear (mid range).
    albedo *= 1.0 + (vnoise(wp.xz * 0.035) - 0.5) * 0.10 * far;
    // Fine aggregate grain, near field only — replaces the per-vertex hash
    // tint that buildRoad currently bakes in at 4 m node resolution.
    albedo *= 1.0 + (vnoise(wp.xz * 7.0) - 0.5) * 0.13 * near;
    // Tarmac is rough; the wet path (which runs after this) still overrides it.
    rough = min(1.0, rough + 0.10 * far);
  }
  // ── Baked albedo/roughness, blended OVER the procedural result ─────────────
  // Deliberately MULTIPLICATIVE, not a replacement: the per-track palette tint,
  // the racing-line rubber wear and the per-vertex aggregate grain that
  // buildRoad/buildProps bake into the vertex colour all have to survive, and
  // a scan that replaced albedo outright would flatten 24 circuits into one.
  // The 2.0 recentres a mid-grey (0.5) scan on "changes nothing".
  vec2 tuv;
  if (matTexUV(mid, tuv)) {
    vec4 t = texture(uMatAlbedoTex, vec3(tuv, float(mid)));
    float k = uMatTexMix * far;                 // reuse the existing distance fade
    albedo = mix(albedo, albedo * t.rgb * 2.0, k);
    rough  = clamp(mix(rough, t.a, k * 0.8), 0.04, 1.0);
  }
}
// Road markings, evaluated analytically in TRACK space (s, lateral x, half-width)
// rather than carried as geometry. The road used to spend four of its fourteen
// cross-section columns purely on making a hard paint edge — two verts at line
// colour, then a 5 cm step into asphalt — and the dashed centre line was a
// per-NODE boolean, floor(s/7) mod 2, evaluated on the ~4 m node grid: a 7 m
// period point-sampled every 4 m, so the dash lengths beat irregularly against
// the sampling grid instead of reading as an even 3.5 m on / 3.5 m off.
//
// Here the marking is a signed-distance band filtered by fwidth(), so it stays
// a crisp edge at any distance and any viewing angle, costs no vertices, and
// cannot alias against the geometry. Gated on half-width so only road geometry
// paints itself — every other mesh reads aTrk = (0,0,0).
void roadMarkings(inout vec3 albedo, inout float rough) {
  float hw = vTrk.z;
  if (hw <= 0.5) return;                     // not road surface (or no trk attribute)
  float s = vTrk.x, x = vTrk.y;
  const vec3 paint = vec3(0.95, 0.95, 0.97);

  // Lateral filter width. Clamped: at a grazing angle fwidth explodes and an
  // unclamped band would smear the line into a wide grey wash.
  float aaX = clamp(fwidth(x), 1e-4, 0.30);

  // Edge lines — a 0.20 m band just inside each tarmac edge (matches the old
  // -w .. -w+0.2 vertex columns).
  float dEdge = abs(abs(x) - (hw - 0.10));
  float edge = 1.0 - smoothstep(0.10 - aaX, 0.10 + aaX, dEdge);

  // Dashed centre line — 0.60 m wide, 7 m period, 50% duty. Measuring distance
  // from the dash CENTRE (0.25 of the period) keeps the band symmetric and
  // wraps cleanly at the period seam, which a two-smoothstep gate does not.
  float band = 1.0 - smoothstep(0.30 - aaX, 0.30 + aaX, abs(x));
  float ph = fract(s / 7.0);
  float aaS = clamp(fwidth(s) / 7.0, 1e-4, 0.24);
  float dash = 1.0 - smoothstep(0.25 - aaS, 0.25 + aaS, abs(ph - 0.25));

  // As a marking goes sub-pixel, fade its amplitude rather than let a
  // half-covered band strobe — the standard minification response.
  float mip = clamp(1.0 - (aaX - 0.06) / 0.24, 0.0, 1.0);
  float m = max(edge, band * dash) * mip;

  albedo = mix(albedo, paint, m);
  rough = mix(rough, 0.55, m);                // paint is smoother than tarmac
}
// Cloud cover at a world point: project the point up the sun direction to the
// cloud deck and sample a drifting FBM — gives moving dappled cloud SHADOWS on
// the ground (the "volumetric shading"). 0 = full sun, 1 = fully shadowed.
float cloudFBM(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 2; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }  // 4→2 octaves (soft-thresholded, invisible)
  return s;
}
float cloudShadow(vec3 wp) {
  if (uCloudCover <= 0.001 || uSunDir.y <= 0.06) return 0.0;
  float cloudY = 360.0;
  // Floor the divisor well above the 0.06 cutoff: near that cutoff the sun ray
  // to the cloud deck is almost grazing, so t (and the resulting cp) grows huge
  // for a barely-changed wp — a tiny change in receiver height/position (e.g.
  // the road's own elevation profile, or the ground point sweeping under a
  // moving camera) gets amplified into many cycles of the cloud noise. That
  // over-sampling of a fast-varying signal is exactly what reads as noisy
  // "stripes" dappling the ground at dawn/dusk instead of smooth cloud shadows.
  // Capping the amplification (rather than raising the 0.06 cutoff itself)
  // keeps the shadow visible right down to that cutoff, just less jittery.
  float t = (cloudY - wp.y) / max(uSunDir.y, 0.15);
  // Drift scaled by uCloudSpeed so the ground dapple freezes/slows in lockstep
  // with the SKY clouds (which use the same knob). Was raw uTime, so "0 = frozen
  // sky" still left the ground shadows crawling.
  float cT = uTime * uCloudSpeed;
  vec2 cp = (wp.xz + uSunDir.xz * t) * 0.0052 + vec2(cT * 0.012, cT * 0.005);
  float c = cloudFBM(cp);
  return smoothstep(0.54 - uCloudCover * 0.40, 0.92, c) * uCloudCover;
}

float sampleShadow(vec3 wpos) {
  vec4 lc = uLightVP * vec4(wpos, 1.0);
  vec3 sc = lc.xyz / lc.w * 0.5 + 0.5;
  if (sc.z >= 1.0) return 1.0;
  // Distance fade: dissolve shadows by RECEIVER distance from uShadowCtr — the
  // unsnapped forward-biased ground anchor the box is snapped around (game.js
  // shadow pass). The anchor glides smoothly with the camera, so the fade front
  // never jumps on a box recentre (a BOX-anchored fade stepped sBox/4 = 16 m at
  // a time while driving — the visible shadow pop/jump at racing speed). The box
  // is guaranteed to cover 0.875·range from the anchor (snap slack = range/8),
  // so completing the fade at 0.84·range retains shadows to ~74 m ahead of the
  // camera at a 64 m box (the shipped default is 80 m, which reaches further
  // still) — vs 46 m when this faded from the eye, which had to absorb the
  // chase-cam offset AND the snap slack in one worst case.
  // (Camera-height-independent too: fading by eye distance erased every shadow
  // from high/aerial cameras, where vDist ≥ altitude for the whole ground.)
  float aDist = distance(wpos, uShadowCtr);
  float edgeFade = 1.0 - smoothstep(uShadowRange * 0.62, uShadowRange * 0.84, aDist);
  // UV border fade kept as a thin safety feather only: the distance fade above
  // completes at 0.84·range while the box guarantees 0.875·range from the anchor,
  // so anything this feather touches is already ≤~4% strength. Keep it THIN —
  // it is anchored to the BOX, which recentres in sBox/4 jumps, so any visible
  // strength it gates would step 16 m at a time while driving.
  vec2 ef = smoothstep(0.0, 0.03, sc.xy) * (1.0 - smoothstep(0.97, 1.0, sc.xy));
  edgeFade *= ef.x * ef.y;
  if (edgeFade <= 0.0) return 1.0;
  float t = uShadowTexel;
  // Slope-scale bias: gentle base + steeper slope term reduces both acne and
  // peter-panning on angled surfaces (walls, banking kerbs). tan(acos(c)) done
  // as sqrt(1-c²)/c (same value, no trig).
  float cosTheta = clamp(dot(normalize(vNrm), uSunDir), 0.05, 1.0);
  float slopeBias = t * 1.5 * (sqrt(1.0 - cosTheta * cosTheta) / cosTheta);
  // Shared by the static map below AND the car map at the bottom — the A/B
  // harness (tools/lighting/ab-lighting.mjs shadow.biasClamp) pins this pattern to ONE
  // site, so keep the bias term factored here rather than repeating the clamp.
  float biasTerm = clamp(slopeBias, 0.0005, 0.004) + uShadowBias * 0.5;
  float z = sc.z - biasTerm;
  // SHADOW DISTANCE compensation: the PCF/blocker offsets below are in shadow-map
  // UV space, so their WORLD footprint = offset * (2*uShadowRange). Without this,
  // raising SHADOW DISTANCE widened the penumbra proportionally and washed thin
  // casters (lamp posts, kerbs) out to lit. Scale the kernel by 80/box (clamped to
  // 1 so the crisp look at/below the default box is unchanged) to hold the world
  // penumbra ~constant as the box grows. Anchor tracks the shadowRange def.
  float boxK = min(1.0, 80.0 / uShadowRange);
  // Distance LOD: full 8-tap Poisson + PCSS-lite blocker search near the camera
  // (crisp tyre/kerb contact shadows), a cheap 4-tap disk on distant ground where
  // the shadow is small on screen. Halves shadow bandwidth over most of the frame.
  // Boundary SCALES with SHADOW DISTANCE (was a fixed 55.0 m) and is anchored to
  // the SAME gliding anchor as the distance fade above (aDist, not the eye): a
  // fixed or eye-anchored cutoff parked a hard 8-tap→4-tap / PCSS-off quality
  // ring in the MIDDLE of still-strong shadows — and swept it across the ground
  // as you drove. 0.80 places the switch deep into the 0.62→0.84 fade band
  // (shadows already dimmed to ~7% strength there), so the ring is invisible at
  // every SHADOW DISTANCE setting, and it can never jump: the anchor glides
  // continuously with the camera.
  bool near = aDist < uShadowRange * 0.80;
  float R = 3.0;
  if (near && uPcss > 0.5) {
    // PCSS-lite: blocker search scales the Poisson radius by the receiver-blocker
    // gap — crisp at the contact point, soft where the caster is far.
    float bt = (1.5 / 512.0) * boxK;
    float zb = min(min(texture(uBlockerMap, sc.xy + vec2(-bt,  bt)).r,
                       texture(uBlockerMap, sc.xy + vec2( bt,  bt)).r),
                   min(texture(uBlockerMap, sc.xy + vec2(-bt, -bt)).r,
                       texture(uBlockerMap, sc.xy + vec2( bt, -bt)).r));
    float pen = clamp((z - zb) * uPcssPen, 0.0, 1.0);
    R = mix(1.5, 6.0, pen);
  }
  // Dither anchored to the SHADOW-MAP TEXEL GRID, not gl_FragCoord: screen-keyed
  // noise re-rolls every world point's rotation each frame while driving (no TAA
  // here to average it), boiling the penumbra — the visible "shadow flicker at
  // speed". sc.xy is stable between recentres (the light VP is texel-snapped) and
  // shifts by whole texels on a recentre, so this pattern is glued to the ground.
  float ign = ignoise(floor(sc.xy / t));
  float ang = ign * 6.2831853;
  float cr = cos(ang), sr = sin(ang);
  mat2 rot = mat2(cr, -sr, sr, cr) * (t * R * boxK);
  // 4 taps always; 4 more only near the camera. Rotated per-texel so the reduced
  // count still reads as noise, not banding.
  float s = texture(uShadowMap, vec3(sc.xy + rot * vec2(-0.94201624, -0.39906216), z))
          + texture(uShadowMap, vec3(sc.xy + rot * vec2( 0.94558609, -0.76890725), z))
          + texture(uShadowMap, vec3(sc.xy + rot * vec2(-0.09418410, -0.92938870), z))
          + texture(uShadowMap, vec3(sc.xy + rot * vec2( 0.34495938,  0.29387760), z));
  float sh;
  if (near) {
    s += texture(uShadowMap, vec3(sc.xy + rot * vec2(-0.91588581,  0.45771432), z))
       + texture(uShadowMap, vec3(sc.xy + rot * vec2(-0.81544232, -0.87912464), z))
       + texture(uShadowMap, vec3(sc.xy + rot * vec2(-0.38277543,  0.27676845), z))
       + texture(uShadowMap, vec3(sc.xy + rot * vec2( 0.97484398,  0.75648379), z));
    sh = s * 0.125;
  } else {
    sh = s * 0.25;
  }
  // Dynamic CAR shadows: min-combine with the per-frame car-only map so cars
  // cast real sun-projected shadows (direction/length correct, car-on-car
  // works) on top of the cached static map. Same slope/constant bias; a small
  // fixed 4-tap PCF (the map is tiny and its content moves every frame, so the
  // static map's dither/PCSS machinery buys nothing here).
  if (uCarShadowOn > 0.5) {
    vec4 cc = uCarLightVP * vec4(wpos, 1.0);
    vec3 cs = cc.xyz * 0.5 + 0.5;
    if (cs.x > 0.0 && cs.x < 1.0 && cs.y > 0.0 && cs.y < 1.0 && cs.z < 1.0) {
      float cz = cs.z - biasTerm;
      float ct = (1.0 / 1024.0) * 0.75;   // CAR_SHADOW_SIZE texel, tightened
      float csh = ( texture(uCarShadowMap, vec3(cs.xy + vec2(-ct, -ct), cz))
                  + texture(uCarShadowMap, vec3(cs.xy + vec2( ct, -ct), cz))
                  + texture(uCarShadowMap, vec3(cs.xy + vec2(-ct,  ct), cz))
                  + texture(uCarShadowMap, vec3(cs.xy + vec2( ct,  ct), cz)) ) * 0.25;
      sh = min(sh, csh);
    }
  }
  // Clamped: SHADOW DARKNESS goes to 2.0 and mix() EXTRAPOLATES above t=1 —
  // at sh~0 the lighting factor hit -1, i.e. negative light, which the
  // grade/tonemap renders as psychedelic orange/green in shadowed areas.
  // Clamping crushes >1 toward black, as the knob's help text promises.
  return max(0.0, mix(1.0, sh, uShadowStr * edgeFade));
}

void main() {
  vec3 N = normalize(vNrm);
  // Two-sided lighting: cull-off single-face geometry (the wheels — tyre bands,
  // sidewall discs, hub fans — are drawn double-sided with one face per wall)
  // shows its BACK side through spoke gaps and on the car's far wheels. Without
  // this the back face keeps the front normal and shades inverted, so the same
  // part reads bright on one side of the car and dark on the other. Flip N to
  // face the viewer on back fragments. No-op for culled meshes (their back faces
  // are discarded before shading), so only the double-sided draws are affected.
  if (!gl_FrontFacing) N = -N;
  // Micro-normal relief: perturb the normal with a two-scale noise gradient so
  // procedurally-textured ground (road/terrain, uDetail > 0) has real surface
  // bumps — sun glints, lamp speculars and reflections break up over the surface
  // instead of reading as one uniform polished sheet. Fades with distance (it
  // would alias to shimmer) and with wetness (the water film levels the surface).
  if (uDetail > 0.001) {
    float mnFade = clamp(1.0 - (vDist - 25.0) / 70.0, 0.0, 1.0) * (1.0 - uWetness * 0.75);
    // Footprint fade: the relief below is a fixed-epsilon (0.22 m) world-space
    // noise-gradient normal perturbation. On the ROAD/terrain — viewed at a
    // grazing angle while driving — one screen pixel spans many metres, so
    // neighbouring pixels sample the gradient at unrelated noise phases and the
    // perturbed normal aliases; because the noise is world-locked the aliased
    // pattern CRAWLS under the car as you move, and since it feeds N·L it reads
    // as wavy "shadows" streaming across the tarmac. The distance fade alone
    // misses this — a grazing patch can be close (high mnFade) yet still have a
    // metre-wide footprint — so also fade the relief out once the per-pixel
    // footprint outgrows the ~0.2 m noise-feature scale (the same fwidth() AA
    // used for the wall bump maps and albedo seams).
    float mnFp = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));
    mnFade *= clamp(1.0 - (mnFp - 0.15) / 0.70, 0.0, 1.0);
    if (mnFade > 0.01) {
      vec2 mnp = vWorldPos.xz * 1.7;
      float e = 0.22;
      float h0 = vnoise(mnp) * 0.7 + vnoise(mnp * 3.9) * 0.3;
      float hx = vnoise(mnp + vec2(e, 0.0)) * 0.7 + vnoise(mnp * 3.9 + vec2(e * 3.9, 0.0)) * 0.3;
      float hz = vnoise(mnp + vec2(0.0, e)) * 0.7 + vnoise(mnp * 3.9 + vec2(0.0, e * 3.9)) * 0.3;
      // (Near-field third octave removed: 3 extra vnoise/fragment over most of
      // the screen for fine aggregate bumps that are invisible at racing speed.)
      N = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * ((uDetail * 0.4 * mnFade) / e));
    }
  }
  // Car paint micro normal map (orange-peel): the same trick as the ground
  // relief above, at paint scale. No colour layers — the perturbed normal
  // feeds every standard lighting/reflection term below, so the surface
  // ITSELF reflects: the sun streak and sky env break into a live shimmer
  // that slides across the panels as the car moves.
  // Geometric normal, kept UNPERTURBED for the smooth lacquer clearcoat lobe and
  // the analytic env mirror below — orange-peel/flake live UNDER the clearcoat,
  // they must not roughen the mirror shell (that's what read as "ghostly" before).
  vec3 Ngeo = N;
  // Car3D surface ids occupy 20..26, above TrackGeom's 0..15 material range.
  // Material 0 retains the legacy whole-draw behavior for imported/custom meshes.
  int surfaceId = int(vMat + 0.5);
  bool classifiedCar = surfaceId >= 20 && surfaceId <= 27;
  bool paintSurface = surfaceId == 20;
  bool carbonSurface = surfaceId == 21;
  bool rubberSurface = surfaceId == 22;
  bool metalSurface = surfaceId == 23;
  bool glassSurface = surfaceId == 24;
  bool emissiveSurface = surfaceId == 25;
  bool panelSurface = surfaceId == 26;
  // MIRROR: a chrome livery finish. Paint-like (it keeps the clearcoat and the
  // env lobe, which is what actually makes a mirror) but metallic and nearly
  // smooth, so the body reflects its surroundings instead of going matte-dark.
  bool mirrorSurface = surfaceId == 27;
  float carPaint = classifiedCar ? ((paintSurface || mirrorSurface) ? uCarPaint : 0.0) : uCarPaint;
  float clearcoat = classifiedCar
    ? (paintSurface ? uClearcoat
      : (mirrorSurface ? max(uClearcoat, 0.85)
      : (glassSurface ? uClearcoat * 0.45 : 0.0)))
    : uClearcoat;
  float metalness = classifiedCar
    ? (metalSurface ? max(uMetalness, 0.78)
      : (mirrorSurface ? max(uMetalness, 0.55)
      : (carbonSurface ? 0.08 : 0.0)))
    : uMetalness;
  float specular = classifiedCar
    ? (rubberSurface ? 0.18 : ((metalSurface || mirrorSurface) ? 1.0 : (carbonSurface ? 0.48 : (panelSurface ? 0.35 : uSpecular))))
    : uSpecular;
  float emissive = classifiedCar
    ? (emissiveSurface ? max(uEmissive, 1.0) : (paintSurface ? uEmissive : 0.0))
    : uEmissive;
  bool envSurface = (carPaint > 0.001 || glassSurface) && clearcoat > 0.001;
  if (carPaint > 0.001) {
    // Two scales: coarse orange-peel waviness + fine metallic-flake sparkle.
    // Keyed to OBJECT space so the pattern is glued to the panels instead of
    // streaming across the bodywork as the car drives (texture-swimming).
    // Fades with distance so it never aliases to shimmer at range.
    float pFade = clamp(1.0 - (vDist - 18.0) / 50.0, 0.0, 1.0);
    if (pFade > 0.01) {
      vec2 puv = vObjPos.xz * 34.0 + vObjPos.y * 29.0;
      vec2 fuv = vObjPos.xz * 130.0 + vObjPos.y * 111.0;
      float pe = 0.09;
      float pb0 = vnoise(puv) * 0.6 + vnoise(fuv) * 0.4;
      float pbx = (vnoise(puv + vec2(pe, 0.0)) * 0.6 + vnoise(fuv + vec2(pe * 3.8, 0.0)) * 0.4) - pb0;
      float pby = (vnoise(puv + vec2(0.0, pe)) * 0.6 + vnoise(fuv + vec2(0.0, pe * 3.8)) * 0.4) - pb0;
      vec3 pT = normalize(cross(N, vec3(0.0, 1.0, 0.001)) + vec3(1e-4));
      vec3 pB = cross(N, pT);
      // 0.22 (was 0.7): at 0.7 the perturbation broke the base-coat specular into
      // per-pixel noise and the paint read sandy/matte — keep a whisper of live
      // shimmer, let the clearcoat lobe + env mirror carry the gloss.
      N = normalize(N + (pT * pbx + pB * pby) * (0.22 * carPaint * pFade));
    }
  }
  // Per-material procedural bump: MUST run before V/L/H/NoL below so brick
  // mortar/plank seams/corrugation ridges etc. actually affect the lighting
  // response, not just an albedo tint applied after the fact.
  applyMaterialNormal(int(vMat + 0.5), N, vDist);
  applyMaterialTexNormal(int(vMat + 0.5), N, vDist);   // baked map composes on top (no-op at uMatTexMix 0)
  vec3 V = normalize(uEye - vWorldPos);
  vec3 L = uSunDir;
  vec3 H = normalize(L + V + vec3(1e-5));   // +eps: normalize(0) NaNs when V==-L
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);

  vec3 albedo = vCol;
  // NOTE: the old "car deck mirror" (a sky mirror weighted by N.y that only hit
  // up-facing panels) was removed — on the dead-flat floor plank / front-wing
  // planes (N.y≈1) it peaked at full strength and read as a chrome "silver plane"
  // under the car, brighter than the actual bodywork. The whole car is now
  // reflected uniformly by the VIEW-driven env mirror below (base reflectance on
  // every panel + grazing rim) plus SSR, so the reflection is consistent across
  // the body instead of a flat-panel standout.
  // Procedural ground texture: coarse patchiness + fine aggregate grain keyed to
  // world position, so flat asphalt/concrete/grass read as a surface rather than
  // a solid slab. Multiplicative, so it darkens as much as it lightens.
  float patchM = 0.5;
  if (uDetail > 0.0) {
    vec2 wp = vWorldPos.xz;
    // Fade the fine high-frequency octave out with distance: at range it aliases
    // into shimmer (and the texel footprint exceeds its wavelength anyway), so
    // distant ground settles to flat colour while near ground keeps its grain.
    float fineFade = clamp(1.0 - (vDist - 35.0) / 90.0, 0.0, 1.0);
    float n = vnoise(wp * 0.35) * 0.60 + vnoise(wp * 2.1) * 0.40 * fineFade;
    albedo *= 1.0 + (n - 0.5) * uDetail;
    // Repair patches: low-frequency resurfaced blotches darken the albedo a
    // few percent (patchM also nudges roughness below - fresh asphalt is
    // smoother and darker than the weathered surface around it).
    patchM = vnoise(wp * 0.055 + 9.1);
    float pm = smoothstep(0.52, 0.72, patchM);
    albedo *= 1.0 - pm * 0.05 * min(uDetail * 4.0, 1.0);
    // Sparse cracks: thin ridge-noise lines, masked by a low-frequency zone
    // gate so only some stretches are cracked; near-field only, and the
    // uDetail*4 gate means a wet road (detail 0.06) fades them to ~24%
    // (the water film hides them).
    float crackFade = clamp(1.0 - (vDist - 18.0) / 45.0, 0.0, 1.0);
    if (crackFade > 0.01) {
      float cr = abs(vnoise(wp * 0.9 + 3.3) * 2.0 - 1.0);
      // AA the crack-ridge threshold — same missing-derivative bug as the
      // building-material seams (fixed elsewhere in this file): the fixed
      // 0.015..0.075 band is a THRESHOLD ON cr, not a world-space distance, so
      // once a screen pixel's footprint changes cr by more than that band per
      // pixel, the ridge line pops in/out of existence per-frame instead of
      // fading — right in the driver's near field (crackFade only applies
      // <~63m), reading as thin dark stripes streaming under the car as it
      // moves through world space. fwidth(cr) widens the falloff edge to
      // match; the fixed 0.015 inner edge (solid ridge core) is kept as-is.
      float crAA = max(0.075, 0.015 + fwidth(cr));
      float crack = (1.0 - smoothstep(0.015, crAA, cr))
                  * smoothstep(0.40, 0.70, vnoise(wp * 0.11 + 7.7));
      albedo *= 1.0 - crack * 0.30 * crackFade * min(uDetail * 4.0, 1.0);
    }
    albedo = max(albedo, vec3(0.0));
  }
  float rough = clamp(uRoughness, 0.04, 1.0);
  if (carbonSurface) rough = max(rough, 0.56);
  if (rubberSurface) rough = max(rough, 0.90);
  if (metalSurface) rough = min(rough, 0.16);
  if (glassSurface) rough = min(rough, 0.13);
  if (emissiveSurface) rough = max(rough, 0.32);
  if (panelSurface) rough = max(rough, 0.72);
  if (mirrorSurface) rough = min(rough, 0.09);
  // Repair patches read glossier: fold the patch mask into roughness (max
  // +-0.08) before the specular AA below widens it.
  if (uDetail > 0.0) rough = clamp(rough + (patchM - 0.5) * 0.16 * min(uDetail * 4.0, 1.0), 0.04, 1.0);
  // Procedural per-material surface texture (brick/glass/metal/wood/… ; 0 = FLAT).
  applyMaterial(int(vMat + 0.5), albedo, rough, vDist);
  // After the material's grain/tint so the paint sits ON the tarmac, not under it.
  roadMarkings(albedo, rough);
  // Specular anti-aliasing: widen roughness where the normal changes fast in
  // screen space (geometry edges, micro-normal at distance) so thin bright
  // highlights sheen smoothly instead of shimmering pixel-to-pixel.
  vec3 saaDx = dFdx(N), saaDy = dFdy(N);
  float saaVar = dot(saaDx, saaDx) + dot(saaDy, saaDy);
  rough = min(1.0, sqrt(rough * rough + saaVar * 0.35));
  float a = rough * rough;
  vec3 f0 = mix(vec3(0.08 * specular), albedo, metalness);

  // ── Wet surface (rain) ──────────────────────────────────────────────────────
  // Rain darkens and polishes surfaces. Strongest on up-facing ground (water
  // pools on flat tarmac); near-vertical walls stay mostly matte. A low-frequency
  // value-noise mask carves standing puddles in the low spots that go near-mirror.
  // wet/puddle are reused below to brighten lamp reflections + sky env.
  float wet = 0.0;
  float puddle = 0.0;
  // The specular WATER FILM, as opposed to "this surface is rained on". Every
  // reflection-side use below must key off this, not plain wet — otherwise soaked
  // grass still mirrors the lamps and the sky.
  float wetSheen = 0.0;
  if (uWetness > 0.001) {
    float upFace = smoothstep(0.50, 0.90, N.y);      // flat ground only
    // Water only SHEETS on a sealed surface. The up-facing test alone put the
    // same mirror film on the grass verges and the gravel traps as on the
    // tarmac — flat is flat to a normal test — so a wet lap read as a flooded
    // canal with cyan banks. Porous ground drinks the water instead: it darkens
    // (more than tarmac, since wet soil is markedly darker) but never polishes.
    // This is only expressible now that road/terrain carry material ids.
    int wmid = int(vMat + 0.5);
    float porous = (wmid == 9 || wmid == 6 || wmid == 10 || wmid == 8 || wmid == 11) ? 1.0 : 0.0;
    wet = uWetness * upFace;
    float pn = vnoise(vWorldPos.xz * 0.13 + 4.7);
    // Wide, soft puddle edges so pools BLEND into the wet sheet rather than reading
    // as hard painted ovals.
    puddle = smoothstep(0.48, 0.88, pn) * wet;        // only low spots pool
    // Porous ground cannot hold standing water — no pooling, and no sheen below.
    puddle *= 1.0 - porous;
    // Water absorbs light: wet asphalt reads notably darker, puddles a touch darker
    // (not stark, so they don't read as flat dark blobs). WET ROAD DARKEN knob
    // scales the absorption (uWetDark 1 = shipped 0.42 floor, 0 = no darkening).
    // Soaked grass/gravel darkens harder than tarmac and that is ALL it does.
    float absorb = mix(clamp(1.0 - 0.58 * uWetDark, 0.0, 1.0),
                       clamp(1.0 - 0.42 * uWetDark, 0.0, 1.0), porous);
    albedo *= mix(1.0, absorb, wet);
    albedo *= mix(1.0, 0.50, puddle);
    // Polish: damp sheen → mirror in the puddles. A wet sheet is glossy but not
    // a perfect mirror except where water actually pools, so the general wet
    // roughness stays moderate (keeps the sun specular a streak, not a flare).
    // 0.15 was mirror-flat and turned the road into a canal; real wet asphalt
    // keeps visible texture between the pools. Porous ground stays fully matte.
    wetSheen = wet * (1.0 - porous);
    rough = mix(rough, 0.30, wetSheen);
    rough = mix(rough, 0.06, puddle);
    a = rough * rough;
    // Thin water film is a dielectric (~0.03 reflectance) — raise f0 toward it.
    // Only where a film can actually form.
    f0 = mix(f0, vec3(0.04), wetSheen * 0.6);
  }

  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);

  // Combine the hard shadow map with soft drifting cloud shadows: the sun is
  // dimmed where clouds pass overhead, casting moving dappled light on the track.
  float shadow = sampleShadow(vWorldPos) * (1.0 - cloudShadow(vWorldPos) * uCloudShadowDim);
  // uKeyMul (KEY LIGHT tuner slider, default 1.0) scales all DIRECT sun lighting
  // — diffuse, GGX spec, clearcoat glint, car-paint glint — without touching
  // ambient fill, fog in-scatter or the env-sky reflection (those keep the
  // scene coherent when the key is dialled down).
  float litNoL = NoL * shadow * uKeyMul;

  // Base diffuse + ambient (== original lambert shader when uMetalness == 0).
  vec3 color = albedo * (amb + uSunColor * litNoL * (1.0 - metalness));
  // SHADOW COOLNESS: bias sun-starved (shadowed / ambient-only) pixels toward a
  // cool blue for a sunny-day contrast look. 0 = neutral (shipped).
  if (uShadowTintAmt > 0.001) {
    color *= mix(vec3(1.0), vec3(0.90, 0.96, 1.12), uShadowTintAmt * clamp(1.0 - litNoL, 0.0, 1.0));
  }

  // Reflected view ray — reused by the wet-road lamp reflections and the sky env.

  // ── Physically-based punctual lights (floodlights / street lamps) ─────────
  // Each lamp is a REAL spotlight: windowed inverse-square falloff (the standard
  // punctual-light attenuation), a true AIMED cone (per-lamp beam direction +
  // inner/outer angles — masts tilt their beams over the road), and the SAME
  // Cook-Torrance GGX specular the sun uses. Diffuse paints the pool; the GGX
  // lobe gives physical highlights — elongated wet-road speculars, glass glints,
  // car-paint sparkle — replacing all the old hand-tuned lobe/glint hacks.
  // No per-light shadows (cost); the cone shapes the light instead.
  vec3 lampFog = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uNumLights) break;
    vec3 LP = uLightPos[i] - vWorldPos;
    float dist = length(LP);
    float rad = uLightRad[i];
    if (dist > rad) continue;
    vec3 Ld = LP / max(dist, 1e-3);
    // Physical 1/d² falloff, eased to exactly 0 at the radius by (1-(d/r)^4)^2.
    float dn = dist / rad;
    float win = clamp(1.0 - dn * dn * dn * dn, 0.0, 1.0);
    // Minimum-distance floor: each lamp's raw energy (buildTrackLights) is sized
    // so its INTENDED aim point (road centre, several metres out) reads as a
    // nicely bloomed pool. On tight street circuits the mast sits right beside
    // the barrier wall, much closer than that aim point — the true 1/d² falloff
    // then overshoots the wall by 10-20x, blowing it to solid white. Clamping
    // the near-field distance keeps the aim-point pool unchanged (dist there is
    // already well above the floor) while taming any close-by surface.
    float distC = max(dist, uLampNearClamp);   // LAMP NEAR CLAMP knob (def 4.0)
    float att = (win * win) / (distC * distC + 1.0);
    if (att < 1e-6) continue;
    // Aimed spot cone: how deep the surface sits inside the lamp's beam.
    // uLightDir = beam aim, uLightCone = (cosInner, cosOuter); uLightBleed is the
    // out-of-beam floor (city skyglow spill between pools).
    float cd = dot(-Ld, uLightDir[i]);
    float beam = smoothstep(uLightCone[i].y, uLightCone[i].x, cd);
    // ILLUMINATION follows the beam (the pool on the road)…
    float spotD = mix(uLightBleed[i], 1.0, beam);
    // …but the REFLECTION doesn't: the glowing lens itself is visible from far
    // outside the beam, so a wet road streaks beneath every lamp you can see —
    // not only inside its illumination cone. The floor is wetness-dependent:
    // high when wet (streaks from every visible lamp), lower when dry so a dry
    // night road keeps pool/valley contrast instead of a uniform specular sheet.
    float spotS = mix(mix(0.16, 0.30, wetSheen) * uLampWallSpill, 1.0, beam);   // LAMP WALL SPILL knob (def 1.0 = shipped floor)
    // Fog in-scatter: lamp irradiance reaching the fog column at this surface.
    // Windowed 1/d2 falloff (att) with a partial out-of-beam floor so the lens
    // glows the fog all around, brightest down the throw. Consumed by the fog
    // and ground-mist tints below - everything here is already computed.
    lampFog += uLightCol[i] * (att * mix(0.35, 1.0, beam));
    float NoLl = max(dot(N, Ld), 0.0);
    // Per-lamp SHADOW for the one mapped floodlight: cars/walls between this
    // surface and the lamp block its pool — the radial shadow swinging around
    // a car as it passes under a mast is the marquee night cue the sun map
    // can't provide (no per-light shadows elsewhere; the cone shapes those).
    // Direct terms only (diffuse pool + GGX/clearcoat specular below): the
    // bounce fill and fog in-scatter stay unshadowed — they are indirect.
    float lampSh = 1.0;
    if (uLampShadowOn > 0.5 && i == uLampShadowIdx) {
      vec4 lpc = uLampShadowVP * vec4(vWorldPos, 1.0);
      if (lpc.w > 0.0) {
        vec3 lps = lpc.xyz / lpc.w * 0.5 + 0.5;
        if (lps.x > 0.002 && lps.x < 0.998 && lps.y > 0.002 && lps.y < 0.998 && lps.z < 1.0) {
          // Perspective depth is nonlinear (most precision at the lens), so the
          // receiver — the road, near the far plane — needs a slope-boosted
          // constant bias against acne rather than the sun map's texel-scaled one.
          float lpz = lps.z - (0.0012 + 0.004 * (1.0 - NoLl));
          float lpt = 1.5 / 512.0;
          lampSh = ( texture(uLampShadowMap, vec3(lps.xy + vec2(-lpt, -lpt), lpz))
                   + texture(uLampShadowMap, vec3(lps.xy + vec2( lpt, -lpt), lpz))
                   + texture(uLampShadowMap, vec3(lps.xy + vec2(-lpt,  lpt), lpz))
                   + texture(uLampShadowMap, vec3(lps.xy + vec2( lpt,  lpt), lpz)) ) * 0.25;
        }
      }
    }
    // Diffuse pool — fades as the road wets so a wet surface shows the lamp's
    // REFLECTION (SSR + the GGX lobe below), not a painted matte circle.
    color += albedo * uLightCol[i] * (att * spotD * lampSh) * NoLl * (1.0 - metalness) * (1.0 - wetSheen * 0.85);
    // Bounce fill: pool light bounced off the road washes nearby surfaces
    // (walls, kerbs, car flanks) with the lamp tint even outside the beam -
    // a near-free stand-in for local ambient probes. Soft NoL floor so
    // surfaces facing away from the lamp still catch a little.
    color += albedo * uLightCol[i] * (att * uBounceK * (0.55 + 0.45 * NoLl)) * (1.0 - metalness);
    // GGX specular from the lamp — the same microfacet BRDF as the sun. On the
    // wet low-roughness road this physically elongates at grazing angles (the
    // real wet-night streak); on glass/car paint it's the city-light glint.
    // Gated on NoLl: every term below is multiplied by NoLl at the end, so a
    // fragment facing AWAY from this lamp (~half the lamps for any given wall
    // or road pixel) contributed exactly 0 while still paying the full GGX +
    // clearcoat cost — the dominant per-fragment waste on 28-32-lamp nights.
    if (NoLl > 0.0) {
      vec3 Hl = normalize(Ld + V);
      float NoHl = max(dot(N, Hl), 0.0);
      float VoHl = max(dot(V, Hl), 0.0);
      float Dl = D_GGX(NoHl, a);
      float Vl = V_SmithGGX(NoV, NoLl, a);
      vec3 Fll = F_Schlick(VoHl, f0, clamp(1.0 - rough, 0.0, 1.0));
      vec3 radianceS = uLightCol[i] * (att * spotS * lampSh);
      vec3 lspec = (Dl * Vl) * Fll * radianceS * NoLl;
      color += lspec / (1.0 + lspec);
      // The clearcoat lacquer catches the lamps too — crisp floodlight glints on
      // car bodies at night, over the softer base-coat highlight.
      if (clearcoat > 0.001) {
        float Dcc = D_GGX(NoHl, 0.03);
        float Vcc = V_SmithGGX(NoV, NoLl, 0.01);
        float Fcc = F_Schlick(VoHl, vec3(0.05), 1.0).x;
        vec3 ccl = vec3(Dcc * Vcc * Fcc) * radianceS * NoLl * clearcoat;
        color += 2.2 * ccl / (2.2 + ccl);
      }
    }
  }

  // Cook-Torrance specular, soft-clipped so highlights sheen instead of clipping.
  float D = D_GGX(NoH, a);
  float Vis = V_SmithGGX(NoV, NoL, a);
  vec3 F = F_Schlick(VoH, f0, clamp(1.0 - rough, 0.0, 1.0));
  vec3 specCol = (D * Vis) * F * uSunColor * litNoL;
  specCol = specCol / (1.0 + specCol);
  color += specCol;

  // Specular AA for the CLEARCOAT lobes below: the base-coat saaVar above
  // widens only the base roughness — the fixed-a clearcoat streak and the
  // pow-400 env sun disc ran unwidened, so on curved bodywork (where the
  // geometric normal swings fast per pixel) the tight lobes strobed frame to
  // frame. Variance of Ngeo (NOT N — the lacquer shades on the smooth shell,
  // and the flake micro-normal must not blur it). uClearcoat is a uniform, so
  // the branch is uniform control flow and the derivatives stay defined.
  float ccSaaVar = 0.0;
  if (uClearcoat > 0.001) {
    vec3 ccDx = dFdx(Ngeo), ccDy = dFdy(Ngeo);
    ccSaaVar = dot(ccDx, ccDx) + dot(ccDy, ccDy);
  }

  // Clearcoat: a second, fixed-low-roughness specular lobe over the base coat —
  // the thin lacquer shell of automotive paint. It keeps a crisp sun highlight
  // even where the base coat is rougher, which is what gives cars their glossy
  // showroom read. The bodywork is smooth-shaded (car3d.js lofts), so the lobe
  // sweeps across the curved panels per-pixel instead of flashing whole facets.
  if (clearcoat > 0.001) {
    // Roughness ~0.19 (a=0.035): wide enough that the streak is VISIBLE sweeping
    // the curved panels (at 0.1 the cone is ~2 degrees — sub-pixel, reads matte).
    // Soft-clipped to a 2.6 HDR ceiling instead of 1.0: the hot core punches past
    // the bloom threshold, so the highlight GLOWS — the actual "shiny" cue.
    // Uses the GEOMETRIC normal (Ngeo): the lacquer shell is smooth, so the sun
    // streak stays crisp — the flake micro-normal only roughens the base coat.
    vec3 Hg = normalize(L + V);
    float NoHg = max(dot(Ngeo, Hg), 0.0);
    float NoVg = max(dot(Ngeo, V), 1e-4);
    float NoLg = max(dot(Ngeo, L), 0.0);
    // Widened by the geometric-normal variance (specular AA, same recipe as
    // the base coat): flat panels keep the crisp 0.035 lobe, tight curvature
    // fattens it just enough to stop the per-pixel strobing. Capped so a hard
    // silhouette edge can't matte the lacquer out entirely.
    float ccA = min(sqrt(0.035 * 0.035 + ccSaaVar * 0.25), 0.30);
    float Dc = D_GGX(NoHg, ccA);
    float Vc = V_SmithGGX(NoVg, NoLg, ccA);
    float Fc = F_Schlick(max(dot(V, Hg), 0.0), vec3(0.05), 1.0).x;
    // uKeyMul included so KEY LIGHT dims this lobe with the rest of the direct
    // sun (it was the one direct term missing it — a keyMul of 0 left every
    // clearcoated car with a full-brightness sun streak).
    vec3 ccCol = vec3(Dc * Vc * Fc) * uSunColor * NoLg * shadow * uKeyMul * clearcoat;
    ccCol = 2.6 * ccCol / (2.6 + ccCol);
    color += ccCol;
  }

  // Analytic clearcoat ENV mirror — the lacquer reflects a procedural sky in the
  // reflected view ray, on EVERY paint pixel including the vertical FLANKS (the
  // carDeck term below only mirrors up-facing decks; SSR can't reach flanks that
  // reflect off-screen). Now a WHOLE-CAR env mirror: a base reflectance on every
  // panel + a grazing Fresnel rim, so the entire body reads reflective (not just
  // the silhouette). VIEW-driven (Fresnel on Ngeo), NOT N.y-driven, so it stays
  // uniform across panel orientations instead of hot-spotting flat up-facing
  // panels the way the old deck mirror did (that was the "silver plane" under the
  // car). Energy-conserving: the base is DARKENED under the mirror weight first,
  // then the reflected sky is added over it (a mirror on gloss, not a milky wash),
  // so the livery still reads through it face-on while the car goes mirror-bright.
  if (envSurface) {
    vec3 Rg = reflect(-V, Ngeo);
    float NoVc = max(dot(Ngeo, V), 1e-4);
    float ccFb = 1.0 - NoVc; float ccF = ccFb * ccFb;      // fresnel², rim-concentrated (mul not pow(_,2): pow(0,2) NaNs on mobile)
    // Mirror strength scales with a LIVE probe (uEnvStr>0). Probe-less views —
    // the in-game SETUP MENU preview and the car-viewer with no world — have no
    // real surroundings to mirror, so a strong analytic mirror there just washes
    // the livery flat grey. Those keep only a gentle grazing sheen (base 0.14);
    // in-race the live cube drives a strong, near-uniform mirror (base 0.72).
    // The grazing Fresnel rim (0.28·ccF) stays in both — a subtle edge, not a wash.
    float probeLive = clamp(uEnvStr, 0.0, 1.0);
    float baseRefl = mix(0.14, 0.72, probeLive);
    float envW = clamp(clearcoat * (baseRefl + 0.28 * ccF) * (1.0 - rough * 0.25), 0.0, 0.96);
    // Soft horizon: bright sky above, dark ground tone below. Was a hard step
    // (-0.03..0.06) — on the faceted engine cover / sidepod shoulders adjacent
    // facets straddled the line and flipped between "sky" and "ground", reading
    // as an arbitrary light/dark panel patchwork instead of a reflection. A wide
    // band keeps the sweep cue but blends across facet seams.
    // When the probe is FULLY live (uEnvStr≈1) the mix below collapses to envReal,
    // so the analytic gradient (smoothstep+mix+sqrt, ~10 ops/px on every clear-coated
    // pixel) would be computed only to be discarded — skip it in that case. The
    // common case (probe OFF, uEnvStr 0) still takes the analytic path and skips the
    // cube fetch, so this only ever removes work, never adds a branch cost that matters.
    vec3 envCC;
    if (uEnvStr >= 0.999) {
      // Sharp mip (rough·2.5): a crisp mirror so buildings/trees read as themselves.
      envCC = textureLod(uEnvCube, Rg, rough * 2.5).rgb;
    } else {
      float horiz = smoothstep(-0.12, 0.30, Rg.y);
      vec3 skyR = mix(uSkyHorizon * 1.2, uSkyZenith, sqrt(max(Rg.y, 0.0)));   // sqrt not pow(x,0.5): pow(0.0,0.5) NaNs on mobile
      envCC = mix(uAmbGround * 0.6, skyR, horiz);
      // LIVE env probe (partial fade): when the cubemap around the player car is
      // warm, the lacquer mirrors the REAL surroundings (trees, buildings, track,
      // sky — including everything behind the camera that SSR can never see) instead
      // of the analytic gradient above. uEnvStr fades analytic → real, so the first
      // frames (and the probe-less setup viewer) keep the gradient fallback.
      if (uEnvStr > 0.001) {
        vec3 envReal = textureLod(uEnvCube, Rg, rough * 2.5).rgb;
        envCC = mix(envCC, envReal, clamp(uEnvStr, 0.0, 1.0));
      }
    }
    // Sun disc in the mirror: pow-400 ≈ a GGX lobe of alpha ~0.0705 — widen
    // that alpha by the same geometric variance (specular AA) and map back to
    // an exponent, so the disc softens on tight curvature instead of strobing;
    // flat panels keep the exact 400. Floor 32 caps how soft an edge can get.
    float ccDiscA = sqrt(0.0705 * 0.0705 + ccSaaVar * 0.25);
    float ccDiscExp = max(2.0 / (ccDiscA * ccDiscA) - 2.0, 32.0);
    envCC += uSunColor * pow(max(dot(Rg, uSunDir), 1e-4), ccDiscExp) * uCarSunGlint * shadow;  // CAR SUN GLINT knob (def 12.0) — base floored 1e-4: pow(0.0,exp)=NaN on mobile GPUs (log2(0)=-Inf) → black car pixels at night; SwiftShader returns 0 so it never repro'd headless
    color *= 1.0 - envW * 0.94;                             // absorb: darken the base hard under the mirror so it reads as a mirror, not a milky wash
    vec3 addCC = envCC * envW;
    color += addCC / (1.0 + addCC * 0.35);                 // gentle soft-clip — keeps bright reflections bright
  }

  // Metallic-flake SPARKLE — the signature "metallic paint" glitter. Each ~4.5 mm
  // object-space cell gets a random flake tilt; a flake flashes only when its
  // facet half-aligns with the sun (view-dependent, so the sparkle field shifts
  // as the camera moves). HDR gain so flashes bloom. Distance-faded to nothing so
  // it never aliases at range. Additive white glint — leaves the pigment alone.
  if (carPaint > 0.001 && litNoL > 0.0 && uSparkle > 0.001) {
    float spFade = clamp(1.0 - (vDist - 14.0) / 30.0, 0.0, 1.0) * uSparkle;
    // Flakes live in the COLOUR coat: near-black albedo (tyres, carbon floor,
    // wings, trim) has no metallic pigment, so gate the glitter out there — the
    // dense white speckle on the dark parts read as dust, not sparkle.
    spFade *= smoothstep(0.06, 0.22, max(albedo.r, max(albedo.g, albedo.b)));
    if (spFade > 0.01) {
      vec3 cell = floor(vObjPos * 220.0);
      float h1 = hash21(cell.xy + cell.z * 19.7);
      float h2 = hash21(cell.yz + cell.x * 7.3);
      // Flake basis off the geometry normal. Ngeo is a well-defined car normal in
      // practice (and litNoL>0 above already rejects a NaN normal), but harden the
      // basis anyway: a fallback unit normal keeps cross()/normalize() finite even
      // if a degenerate (zero-length) Ngeo ever reaches here, so a bad face can't
      // spray NaN glints across the paint.
      vec3 nN = length(Ngeo) > 1e-4 ? normalize(Ngeo) : vec3(0.0, 1.0, 0.0);
      vec3 fT = normalize(cross(nN, vec3(0.0, 1.0, 0.001)) + vec3(1e-4));
      vec3 fB = cross(nN, fT);
      vec3 gN = normalize(nN + (fT * (h1 * 2.0 - 1.0) + fB * (h2 * 2.0 - 1.0)) * 0.5);
      // Tighter alignment window + lower gain than the original (0.965 / 3.0):
      // sparse individual glints that flash as the view moves, instead of a
      // dense sand-grain field that made the paint read dirty/matte.
      float glint = smoothstep(0.990, 1.0, dot(gN, H));
      // CAR SPARKLE knob (def 1.6 = as-shipped) sets the metallic-flake glint gain.
      color += uSunColor * litNoL * glint * uCarSparkle * carPaint * spFade;
    }
  }

  // (Car deck mirror step 2 removed — see the note at step 1; the clearcoat ENV
  //  mirror above now carries the car's reflection uniformly across every panel.)

  // Environment reflection: when roughness is very low (wet road / glossy paint),
  // sample the sky gradient in the reflected view direction.
  // Roughness > 0.4 = no visible reflection; < 0.15 = mirror-like sky in road.
  // Wetness forces the surface glossy, so this kicks in hard on rainy roads —
  // the sky/horizon mirrors in the tarmac and the sun smears a bright streak.
  float envBlend = clamp((0.40 - rough) / 0.30, 0.0, 1.0) * specular;
  envBlend = max(envBlend, wetSheen * 0.55);   // smooth analytic wet mirror: this is the COHERENT reflective base the road shows wherever the screen-space SSR march misses (grazing cockpit views miss a lot). Was 0.15 (a whisper, "SSR owns it") — but SSR is patchy at grazing angles, so the analytic sky mirror carries the wet look and SSR just adds crisp on-screen detail on top.
  if (envBlend > 0.001) {
    // reflect() computed here, not at the top: envBlend is ~0 for the matte
    // majority of the scene (road/terrain/walls), where Rv was pure waste.
    vec3 R = reflect(-V, N);
    // Lower exponent shows more of the horizon→zenith gradient in the reflection
    // (vertical glass mostly reflects up into a near-uniform zenith, which reads
    // flat — this lets the brighter horizon band into the reflected sky).
    float skyT = pow(max(R.y, 1e-4), 0.40);
    // Tint env sample by sky gradient; also pick up a gentle sun-horizon blush
    // when the reflected direction aligns with the sun (warm chrome/paint sheen).
    vec3 envColor = mix(uSkyHorizon, uSkyZenith, skyT);
    float envSunAlign = max(dot(R, uSunDir), 0.0);
    envColor = mix(envColor, envColor * uSunColor * 1.15, envSunAlign * envSunAlign * (1.0 - rough));
    // (Wet-road sun-glitter removed — SSR now reflects the real sky/sun on wet roads.)
    // Dry glossy glass catches the sun too — a tighter, softer glint so day/dawn/dusk
    // windows flash where they face the sun. Gated (1-wet) so wet road is unchanged;
    // night sun is dim moonlight so this is naturally negligible after dark.
    envColor += uSunColor * pow(max(envSunAlign, 1e-4), 22.0) * (1.0 - wetSheen) * envBlend * 0.6 * uWindowSunFlash;   // WINDOW SUN FLASH knob (def 1.0 = shipped)
    // Roughness dampens the env contribution: rough surfaces see a blurry flat sky.
    float roughDamp = 1.0 - rough * 0.7;
    // Fresnel: reflection is strongest at grazing angles. On wet ground square
    // it so the sky sheen concentrates into the far grazing band instead of
    // flooding the whole low-camera road — near/mid tarmac stays dark and glossy.
    // Also dim the reflected sky a touch when wet (a wet road is never as bright
    // as the sky it mirrors).
    float envFresnel = F_Schlick(max(dot(N, V), 0.0), vec3(0.04), 1.0).x;
    envFresnel = mix(envFresnel, envFresnel * envFresnel, wetSheen * 0.35);   // was full square when wet, which shoved the sky sheen into the far grazing band only and left near/mid road dark (SSR was meant to cover it). Soften the squaring so the smooth analytic reflection spreads across the whole wet road — a coherent mirror everywhere, not a thin far strip.
    vec3 envWet = envColor * (1.0 - wetSheen * 0.45);   // keep ~55% of the sky colour on a wet road (was 10%): the analytic mirror now has to read as a real reflection, since it's the smooth base under the patchy SSR. Soft-clip below still stops it blowing to white.
    // Soft-clip the reflection so a wet road can never blow out to a white sheet
    // (a low dusk/dawn sun + bright twilight sky otherwise push this past 1). A
    // Reinhard shoulder on the brightest channel keeps it bright where the scene
    // is dim and caps it where it would over-saturate.
    vec3 envAdd = envWet * envFresnel * envBlend * roughDamp * (1.0 - metalness);
    float envM = max(max(envAdd.r, envAdd.g), envAdd.b);
    color += envAdd / (1.0 + envM);
  }

  // Sky rim / fresnel: a subtle atmospheric brightening at grazing angles,
  // tinted by the horizon sky colour. Gives edges a little 'air' without
  // making surfaces look wet or plastic. Damped by roughness.
  {
    float rf = 1.0 - NoV; float rimFresnel = rf * rf * rf;
    float rimAmt = rimFresnel * (1.0 - rough * 0.85) * 0.18 * uSkyRimGlow;   // SKY RIM GLOW knob (def 1.0 = shipped)
    color += uSkyHorizon * rimAmt;
  }

  // Ambient contact darkening: surfaces facing each other (concave) receive
  // less sky light. Approximate with a bent-normal trick: upward-facing
  // surfaces receive full ambient; downward faces lose it.
  // This is already partially handled by hemisphere ambient (N.y), but a
  // gentle extra crush in the darkest zones adds perceived depth.
  {
    float ao = pow(max(N.y * 0.5 + 0.5, 1e-4), 0.35);
    color *= mix(1.0 - 0.12 * uAmbContactDark, 1.0, ao);   // AMBIENT CONTACT DARK knob (def 1.0 = shipped 0.88 floor)
  }

  // Emissive: lerp toward unlit albedo (self-illumination, sun-independent) and,
  // for bright/warm surfaces (lit windows, floodlight lenses, neon), add an extra
  // additive lift that pushes the value past 1.0 so the bloom bright-pass picks it
  // up and the surface actually *glows* at night rather than just reading flat.
  if (emissive > 0.0) {
    color = mix(color, albedo, emissive);
    // Glow weight: how "lamp-like" the albedo is. Bright (high luminance) AND
    // warm-or-neutral colours qualify; dark/muddy colours get no lift so emissive
    // walls don't bloom. Uses max channel for brightness, scaled smoothly in.
    float bright = max(albedo.r, max(albedo.g, albedo.b));
    float glow = smoothstep(0.50, 0.95, bright) * emissive;
    // Push the glow well PAST 1.0 (HDR) so lit windows / neon / lamp lenses read
    // as actual light SOURCES — they punch through the dark and bloom into halos,
    // instead of sitting as flat bright paint.
    // HDR push kept moderate (was 3.2): windows/heads GLOW, they don't glare —
    // the night energy budget lives or dies on this multiplier.
    // PER-MATERIAL bloom weight: albedos authored ABOVE white (the neon crown
    // bands at ~2.5, neon-tinted panes, the LENS_NIGHT lamp albedos at
    // 1.06-1.40 — see tracks.js) are the scenery's "this surface IS a light
    // source" tag, while generic emissive (lit concrete, night road/terrain
    // glow, warm office panes) sits at or under 1.0. Scaling an extra push by
    // how far past white the albedo is lets neon/signage/lenses bloom harder
    // WITHOUT raising uGlowAmp or lowering the global bloom threshold (both of
    // which drag every emissive surface — and the fog — up with them).
    float hdrTag = max(bright - 1.0, 0.0);
    color += albedo * glow * uGlowAmp * (1.0 + hdrTag * uBloomBoost);
  }

  // Height-based fog: density falls off exponentially with altitude above eye level.
  // uFogHeight = 0 → uniform (original behaviour); > 0 → pooling fog.
  float heightAtten = uFogHeight > 0.0
    ? exp(-max(vWorldPos.y - uEye.y, 0.0) * uFogHeight)
    : 1.0;
  float fd = vDist * uFogDensity * heightAtten;
  float f = 1.0 - exp(-fd * fd);
  // Sun in-scattering (Inigo Quilez): the fog is NOT a flat colour — when the
  // view ray points toward the sun, the fog glows toward the sun's colour
  // (forward Mie scatter), staying neutral away from it. Gives volumetric depth
  // and makes a low warm sun bleed dramatically through dawn/dusk haze.
  vec3 rd = -V;   // == normalize(vWorldPos - uEye); V is already normalized above
  float sunAmount = max(dot(rd, uSunDir), 0.0);
  // Wider exponent (4) = the warm sun-glow in the haze spreads across a broader
  // arc of the horizon for a more dramatic sunset; an extra tight core (pow 16)
  // adds a hot bloom right at the sun.
  float sunAmt = max(sunAmount, 1e-4);   // floor base: pow(0.0, n) NaNs on mobile GPUs
  vec3 fogCol = mix(uFogColor, uSunColor, pow(sunAmt, 4.0));
  // FOG SUN CORE knob (def 0.6 = as-shipped): the tight hot bloom right at the sun.
  fogCol += uSunColor * pow(sunAmt, 16.0) * uFogSunCore;
  // FOG WARM / COOL white-balance (uFogTint 0 = neutral, + warm, − cool).
  fogCol *= vec3(1.0 + max(uFogTint, 0.0) * 0.25 - max(-uFogTint, 0.0) * 0.12,
                 1.0 - abs(uFogTint) * 0.02,
                 1.0 - max(uFogTint, 0.0) * 0.25 + max(-uFogTint, 0.0) * 0.18);
  // GLOWING FOG: nearby lamps tint the fog itself, so fog banks glow around
  // floodlights and neon at night. Soft-clipped so a lamp cluster can never
  // push the fog wall past the night bloom threshold into a white wash; the
  // mix by f below gates it, so clear air (f near 0) gets no halo. Energy
  // split with the godray pass: godray owns the NEAR air column (Beer-Lambert
  // decay + range gate), this tint owns the DISTANT fog wall (f grows with
  // distance) - the two never stack in the same regime.
  vec3 lampFogC = vec3(0.0);
  if (uLampFog > 0.0) {
    vec3 lf = lampFog * uLampFog;
    lampFogC = lf / (1.0 + max(max(lf.r, lf.g), lf.b) * uLampFogClip);
    fogCol += lampFogC;
  }
  color = mix(color, fogCol, f);
  // Low-lying GROUND MIST: a drifting FBM fog that pools near the surface (dawn /
  // humid / overcast). Densest at a low datum, thinning with altitude and ramping
  // in with distance; broken by a slow-drifting FBM so it rolls rather than a
  // flat sheet. Tinted by the fog colour with a warm sun in-scatter.
  if (uGroundMist > 0.001) {
    float lowH = max(vWorldPos.y - (uEye.y - 5.0), 0.0);
    // MIST HEIGHT BAND: taller band (bigger uMistHeight) = slower vertical falloff.
    float band = exp(-lowH * (0.09 / max(uMistHeight, 0.05)));
    vec2 mp = vWorldPos.xz * 0.020 + vec2(uTime * 0.010, uTime * 0.006);
    float dRamp = clamp((vDist - 8.0) / 45.0, 0.0, 1.0);
    float mist = uGroundMist * band * smoothstep(0.35, 0.72, cloudFBM(mp)) * dRamp;
    vec3 mistCol = mix(uFogColor, uSunColor, pow(max(sunAmount, 1e-4), 3.0)) + lampFogC * uMistShare;
    color = mix(color, mistCol, clamp(mist, 0.0, 0.45));
  }
  // Car-paint pixels are TAGGED in alpha (opaque draws never blend, so the
  // channel is free): the composite SSR pass reflects the real world on car
  // bodywork every frame — the same world-mirror the wet road gets.
  outColor = vec4(color, carPaint > 0.001 ? 0.35 : uAlpha);
}`;

export { LIT_VS, LIT_FS };
