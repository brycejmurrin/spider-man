/*
 * Apex 26 — GLSL sources for the WebGL2 renderer (js/render/glx.js):
 * the small effect programs — blob shadow (SHADOW_*), skid-mark
 * stamps (MARK_*), racing-line decals (DECAL_*), HDR glows (GLOW_*) and the
 * particle sprites (PARTICLE_*).
 * Split from the old monolithic glx-shaders.js. Template strings may
 * interpolate GLXChunks (js/render/shaders/chunks.js — loads first); each file
 * registers its programs on the shared GLXShaders global. All shader files
 * must load BEFORE js/render/glx.js (it destructures GLXShaders at eval).
 */

  const SHADOW_VS = `#version 300 es
layout(location=0) in vec2 aPos; // unit quad, -0.5..0.5 in x/z
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform vec2 uSize; // w, l in meters
out vec2 vUV;
void main() {
  vUV = aPos * 2.0; // -1..1
  vec4 wp = uModel * vec4(aPos.x * uSize.x, 0.02, aPos.y * uSize.y, 1.0);
  gl_Position = uViewProj * wp;
}`;

  const SHADOW_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
out vec4 outColor;
void main() {
  float r = length(vUV);
  float a = 0.45 * (1.0 - smoothstep(0.25, 1.0, r));
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

  // Flat rectangular skid-mark stamp (x=lateral, y=along-travel in normalised -1..1 space)
  const MARK_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
out vec4 outColor;
void main() {
  float a = 0.38 * smoothstep(1.0, 0.4, abs(vUV.x)) * smoothstep(1.0, 0.3, abs(vUV.y));
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

  // Batched skid marks: all live marks baked into one world-space vertex buffer
  // (pos + uv per vertex) so the whole trail draws in ONE call instead of up to
  // 120 per-mark drawElements. Same MARK_FS, so the look is identical.
  const MARK_BATCH_VS = `#version 300 es
layout(location=0) in vec3 aPos;   // world position (metres)
layout(location=1) in vec2 aUV;    // -1..1 across the stamp
uniform mat4 uViewProj;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

  // ---- Textured car decals (team logos / sponsors) ----
  // Flat UV'd quads sitting slightly proud of the bodywork, sampling a canvas-
  // baked RGBA atlas (transparent where there's no mark). Lit by sun + hemisphere
  // ambient so a decal sits INTO the paint's shading instead of floating flat;
  // uGlow lifts bright marks so white sponsors read at night.
  const DECAL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec2 vUV;
out vec3 vNrm;
void main() {
  vUV = aUV;
  vNrm = mat3(uModel) * aNrm;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;
  const DECAL_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec3 vNrm;
uniform sampler2D uTex;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform float uGlow;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  if (t.a < 0.02) discard;
  vec3 N = normalize(vNrm);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
  vec3 lit = t.rgb * (amb + uSunColor * ndl) + t.rgb * uGlow;
  outColor = vec4(lit, t.a);
}`;

  // ---- Lamp lens glare (round veiling halo at each lamp head) ----
  // A camera-facing quad per lamp, drawn ADDITIVELY into the HDR scene before
  // bloom. Purely RADIAL: a hot core + a soft round veil, like real lens glare.
  // (The old version was a downward cone wedge meant to fake a beam — seen from
  // below/off-axis it projected as a bright diagonal dash hanging in the sky,
  // one of the "rays from the sky". Beams in the air are the volumetric godray
  // pass's job now; this billboard is only the glare around the source itself.)
  const GLOW_VS = `#version 300 es
layout(location=0) in vec2 aCorner;   // x in {-1,+1}, y in {0,1}
layout(location=1) in vec3 aCenter;   // lamp head world position
layout(location=2) in vec3 aColor;    // HDR lamp colour
layout(location=3) in float aRadius;  // halo radius (m)
uniform mat4 uViewProj;
uniform vec3 uEye;
out vec2 vUV;
out vec3 vColor;
void main() {
  vec3 fwd = normalize(uEye - aCenter);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd) + vec3(1e-4, 0.0, 0.0));
  vec3 upv = cross(fwd, right);
  vec2 c = vec2(aCorner.x, aCorner.y * 2.0 - 1.0);   // corner buffer is x±1, y 0..1
  vec3 wp = aCenter + (right * c.x + upv * c.y) * aRadius;
  vUV = c;
  vColor = aColor;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

  const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;        // -1..1 across the halo quad
in vec3 vColor;
uniform float uStr;
out vec4 outColor;
void main() {
  float r2 = dot(vUV, vUV);
  float core = exp(-r2 * 28.0);   // hot centre right at the lens
  float veil = exp(-r2 * 5.0);    // broad soft glare veil (≈0 by the quad edge)
  float a = (core * 0.75 + veil * 0.28) * uStr;
  outColor = vec4(vColor * a, 1.0);   // additive (blendFunc ONE, ONE)
}`;

  // ---- Transient FX particles (tyre smoke / sparks / kickup / rain spray) ----
  // Camera-facing soft billboards, batched by js/game/particles.js into one
  // interleaved buffer per blend group. uAdditive switches the output packing:
  // 0 = classic alpha transparency (smoke/dust/spray), 1 = premultiplied energy
  // for the ONE/ONE spark group (HDR tints feed bloom).
  const PARTICLE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;   // quad corner in {-1,+1}²
layout(location=1) in vec3 aCenter;   // particle world position
layout(location=2) in vec3 aColor;    // tint (HDR allowed for the additive group)
layout(location=3) in float aSize;    // half-size (m)
layout(location=4) in float aAlpha;   // per-particle opacity
uniform mat4 uViewProj;
uniform vec3 uEye;
out vec2 vUV;
out vec3 vColor;
out float vAlpha;
void main() {
  vec3 fwd = normalize(uEye - aCenter);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd) + vec3(1e-4, 0.0, 0.0));
  vec3 upv = cross(fwd, right);
  vec3 wp = aCenter + (right * aCorner.x + upv * aCorner.y) * aSize;
  vUV = aCorner;
  vColor = aColor;
  vAlpha = aAlpha;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

  const PARTICLE_FS = `#version 300 es
precision mediump float;
in vec2 vUV;        // -1..1 across the quad
in vec3 vColor;
in float vAlpha;
uniform float uAdditive;
out vec4 outColor;
void main() {
  float r2 = dot(vUV, vUV);
  float fall = max(1.0 - r2, 0.0);
  fall *= fall;                       // smooth soft-disc falloff, zero at the rim
  float a = vAlpha * fall;
  outColor = mix(vec4(vColor, a), vec4(vColor * a, 1.0), uAdditive);
}`;

export { SHADOW_VS, SHADOW_FS, MARK_FS, MARK_BATCH_VS, DECAL_VS, DECAL_FS, GLOW_VS, GLOW_FS, PARTICLE_VS, PARTICLE_FS };
