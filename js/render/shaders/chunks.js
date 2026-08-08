/*
 * Apex 26 — GLXChunks: shared GLSL leaves for the WebGL2 shader sources.
 *
 * The GLSL-side sibling of js/render/webgpu/wgsl-chunks.js (WGSLChunks) — the
 * maintainability review's option B(i) / step C.1 (docs/archive/webgpu/WEBGPU-MAINTAINABILITY.md):
 * math snippets genuinely shared by more than one pass live here ONCE as named
 * template-string constants, and js/render/shaders/{lit,sky,fx,post}.js
 * interpolate them into the program sources at load time (plain JS string
 * concatenation — no build step). Where a WGSL sibling exists the chunk keeps
 * the SAME name on both sides (hash, vnoise, tonemap), so a change to the
 * shared math is "edit two small leaves", not "hand-diff two 850-line files".
 *
 * Deliberately small and honest — only leaves that ARE duplicated across GLSL
 * passes (or have a WGSL sibling) belong here:
 *   hash          sky-family value hashes (hash2/hash3)      — SKY  (WGSL: hash)
 *   vnoise        sky-family value noise + 4-octave fbm      — SKY  (WGSL: vnoise)
 *   surfaceNoise  surface-family hash21 + value noise        — LIT + GODRAY
 *                 (different hash constants from the sky family; the
 *                 procedural-material look is welded to them — do NOT merge)
 *   ignoise       interleaved-gradient noise dither/jitter   — LIT + SKY +
 *                 GODRAY + COMPOSITE
 *   tonemap       ACES filmic tone-map (reads uAcesA..E)     — COMPOSITE
 *                 (WGSL: tonemap — coefficient-parameterised there)
 * Per-pass fbm variants (LIT cloudFBM 2-oct, GODRAY gCloudFBM 3-oct) stay in
 * their shaders: the octave counts are per-pass performance tuning, not copies.
 *
 * Must load BEFORE lit.js, sky.js, fx.js and post.js in the same directory (see tools/manifest.cjs).
 */
"use strict";

export const GLXChunks = (function () {
  // ── hash: sky-family value-hash leaves (mirror WGSLChunks.hash) ──
  const hash = `float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float hash2(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.5);
  return fract(p.x * p.y);
}`;

  // ── vnoise: sky-family value noise + fbm (mirror WGSLChunks.vnoise).
  //    Depends on hash (uses hash2). This was duplicated as vnoise/vnoise2
  //    when LIT and SKY lived in one file — the sky copy now lives here once,
  //    under the WGSL sibling's name.
  const vnoise = `float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i), b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.02; a *= 0.5; }   // 5→4 octaves
  return s;
}`;

  // ── surfaceNoise: surface-family hash + value noise (LIT procedural
  //    materials + GODRAY cloud shadows — GODRAY had it inlined as
  //    gHash/gNoise with identical constants). NOT the sky family: hash21's
  //    constants differ from hash2's and every procedural surface is welded
  //    to this exact pattern.
  const surfaceNoise = `float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

  // ── ignoise: interleaved-gradient noise (Jimenez) — screen/texel-grid
  //    dither + ray-march start jitter. Was pasted inline in four passes.
  //    (COMPOSITE's second decorrelated dither hash d1 stays inline — it
  //    swaps the constant pair, so it is a different function.)
  const ignoise = `float ignoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}`;

  // ── tonemap: ACES filmic tone-map (mirror WGSLChunks.tonemap; the WGSL
  //    side passes the coefficients as parameters, this side reads the
  //    uAcesA..E TONE CURVE uniforms — the including shader declares them).
  const tonemap = `// ACES fitted filmic tone-map (Krzysztof Narkowicz's approximation — the
// a=2.51,b=0.03,c=2.43,d=0.59,e=0.14 curve; NOT Stephen Hill's fit).
// Preserves colour ratios better than Reinhard; keeps darks dark, rolls off highlights.
// NOTE (display transfer): the composite writes these values straight to an RGBA8
// canvas with no explicit OETF (no pow(1/2.2) / sRGB encode, and the context/FBO
// is not sRGB). The whole look — uContrast, vibrance, black-lift, the baked light
// presets and the pixel-diff baselines — is hand-calibrated on top of that direct
// output. Adding a gamma encode here is therefore a deliberate, all-baselines-
// regenerating change, not a drop-in fix; leave it unless re-grading the game.
// Coefficients come from the TONE CURVE tuner knobs (uAcesA..E). Their defaults
// (2.51/0.03/2.43/0.59/0.14) reproduce the shipped Narkowicz curve byte-for-byte
// — same values, same expression, so the default output is bit-identical. e is
// floored >0 by the slider min so the denominator can't reach 0 for x>=0.
vec3 acesTonemap(vec3 x) {
  float a = uAcesA, b = uAcesB, c = uAcesC, d = uAcesD, e = uAcesE;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}`;

  return { hash, vnoise, surfaceNoise, ignoise, tonemap };
})();

