/*
 * Apex 26 — GLSL sources for the WebGL2 renderer (js/render/glx.js):
 * the post chain — POST_VS fullscreen triangle, bloom
 * (BRIGHT/BLUR/DOWN/UP), SSAO, volumetric sun shafts (GODRAY), the COMPOSITE
 * (tone-map + grade + SSR + flare + vignette), FXAA, and the shadow-map
 * depth passes (DEPTH_*, BLOCKER_FS).
 * Split from the old monolithic glx-shaders.js. Template strings may
 * interpolate GLXChunks (js/render/shaders/chunks.js — loads first); each file
 * registers its programs on the shared GLXShaders global. All shader files
 * must load BEFORE js/render/glx.js (it destructures GLXShaders at eval).
 */
import { GLXChunks } from "./chunks.js";

  // ---- Post-processing (HDR scene target -> bloom -> tonemap + vignette) ----
  // Fullscreen triangle via gl_VertexID; vUV in 0..1.
  const POST_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Bright-pass: keep only the portion of each pixel above the threshold (the
  // sun, floodlights, specular hotspots, bright markings) for the bloom blur.
  const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  float l = max(max(c.r, c.g), c.b);
  // Quadratic soft knee (half-width = threshold/2) instead of the old hard
  // max(0, l-t) cut: pixels ramp smoothly into the bloom as they approach the
  // threshold, so a small lamp crossing it at distance FADES in over a few
  // frames instead of popping its whole halo on in one. Above the knee the
  // response is identical to the hard threshold.
  float knee = uThreshold * 0.5 + 1e-4;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float k = max(soft, l - uThreshold) / max(l, 1e-4);
  outColor = vec4(c * k, 1.0);
}`;

  // Separable 5-tap gaussian (uDir = texelSize * axis).
  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  vec3 s = texture(uTex, vUV).rgb * 0.2270270270;
  s += texture(uTex, vUV + o1).rgb * 0.3162162162;
  s += texture(uTex, vUV - o1).rgb * 0.3162162162;
  s += texture(uTex, vUV + o2).rgb * 0.0702702703;
  s += texture(uTex, vUV - o2).rgb * 0.0702702703;
  outColor = vec4(s, 1.0);
}`;

  // Mip-chain bloom downsample: 13-tap filter (Jimenez, SIGGRAPH 2014 "Next
  // Generation Post Processing in Call of Duty") — a wide, stable kernel that
  // avoids the pulsing/shimmer a plain box chain shows on small bright sources
  // (floodlights at distance, specular glints). uTexel = 1/source size.
  const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uKaris;   // 1 on the FIRST mip only: partial luma weighting (firefly fix)
out vec4 outColor;
void main() {
  vec2 t = uTexel;
  vec3 a = texture(uTex, vUV + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uTex, vUV + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uTex, vUV + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uTex, vUV + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uTex, vUV).rgb;
  vec3 f = texture(uTex, vUV + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uTex, vUV + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uTex, vUV + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uTex, vUV + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uTex, vUV + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uTex, vUV + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uTex, vUV + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uTex, vUV + t * vec2( 1.0, -1.0)).rgb;
  // The 13 taps form 5 overlapping quads (Jimenez): 4 corner quads at weight
  // 0.125 each + the centre quad at 0.5 (same totals as the flat sum below).
  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
  if (uKaris > 0.5) {
    // Karis partial luma weighting, FIRST mip only: weight each quad by
    // 1/(1+luma) and renormalise. A single sub-pixel HDR spike (specular
    // glint, distant lamp) is pulled toward its neighbourhood instead of
    // dominating the whole downsample — the classic bloom-firefly popping —
    // while uniform regions renormalise back to the plain average, so overall
    // bloom energy is roughly preserved.
    float w0 = 0.125 / (1.0 + max(g0.r, max(g0.g, g0.b)));
    float w1 = 0.125 / (1.0 + max(g1.r, max(g1.g, g1.b)));
    float w2 = 0.125 / (1.0 + max(g2.r, max(g2.g, g2.b)));
    float w3 = 0.125 / (1.0 + max(g3.r, max(g3.g, g3.b)));
    float w4 = 0.5   / (1.0 + max(g4.r, max(g4.g, g4.b)));
    vec3 s = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4)
           / (w0 + w1 + w2 + w3 + w4);
    outColor = vec4(s, 1.0);
  } else {
    vec3 s = (g0 + g1 + g2 + g3) * 0.125 + g4 * 0.5;
    outColor = vec4(s, 1.0);
  }
}`;

  // Mip-chain bloom upsample: 9-tap tent filter, drawn ADDITIVELY (ONE, ONE) into
  // the next-larger level so every octave of blur accumulates — a wide, smooth,
  // banding-free halo instead of the old single-octave gaussian's tight ring.
  const UP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSpread;   // BLOOM SPREAD: scales the tent-tap radius (def 1.0)
out vec4 outColor;
void main() {
  vec2 t = uTexel * uSpread;
  vec3 s = texture(uTex, vUV + t * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUV + t * vec2( 1.0,  1.0)).rgb
         + texture(uTex, vUV + t * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUV + t * vec2( 1.0, -1.0)).rgb
         + (texture(uTex, vUV + t * vec2( 0.0,  1.0)).rgb
          + texture(uTex, vUV + t * vec2( 0.0, -1.0)).rgb
          + texture(uTex, vUV + t * vec2(-1.0,  0.0)).rgb
          + texture(uTex, vUV + t * vec2( 1.0,  0.0)).rgb) * 2.0
         + texture(uTex, vUV).rgb * 4.0;
  outColor = vec4(s / 16.0, 1.0);
}`;

  // SSAO: view-space horizon-style ambient occlusion from the depth texture.
  // Reconstructs view position (via uInvProj) and a normal (from depth
  // derivatives), then counts neighbour samples that rise above the surface
  // tangent plane — so flat ground (the road at a grazing angle) is NOT falsely
  // darkened, only real creases/contacts (car-on-tarmac, barrier feet, kerbs).
  const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec3 uSunVS;     // sun direction in view space
uniform vec2 uTexel;
uniform float uStrength;
uniform float uContact;  // contact-shadow strength (0 = off)
uniform float uRadius;   // AO world-space sample reach (def 0.6)
out vec4 outColor;
vec3 viewPos(vec2 uv) {
  float d = texture(uDepth, uv).r;
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uInvProj * c;
  return v.xyz / v.w;
}
const vec2 K[12] = vec2[12](
  vec2(0.0,1.0), vec2(0.5,0.866), vec2(0.866,0.5),
  vec2(1.0,0.0), vec2(0.866,-0.5), vec2(0.5,-0.866),
  vec2(0.0,-1.0), vec2(-0.5,-0.866), vec2(-0.866,-0.5),
  vec2(-1.0,0.0), vec2(-0.866,0.5), vec2(-0.5,0.866));
void main() {
  float d = texture(uDepth, vUV).r;
  if (d >= 0.99999) { outColor = vec4(1.0); return; }   // sky
  vec3 P = viewPos(vUV);
  // Guarded: at depth silhouettes the derivatives can be parallel/zero and
  // normalize(0) is NaN — a speckled AO pixel. Fall back to eye-facing.
  vec3 crN = cross(dFdx(P), dFdy(P));
  float crL = length(crN);
  vec3 N = crL > 1e-6 ? crN / crL : vec3(0.0, 0.0, 1.0);
  // Screen-space sample radius shrinks with distance so the world radius (~0.6 m)
  // stays roughly constant; clamp so near/far stay sane.
  float radius = uRadius;
  float scr = clamp(radius / max(-P.z, 1.0) * 0.9, 0.004, 0.05);
  // Per-pixel rotation to turn banding into noise.
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
  float ca = cos(a), sa = sin(a);
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {   // 12→8 taps (half-res + blurred)
    vec2 k = vec2(K[i].x * ca - K[i].y * sa, K[i].x * sa + K[i].y * ca);
    vec3 S = viewPos(clamp(vUV + k * scr, vec2(0.001), vec2(0.999)));
    vec3 V = S - P;
    float len = length(V);
    // Occluder must rise above the tangent plane (dot>bias) and be within radius.
    float ndv = max(dot(N, V / max(len, 1e-4)) - 0.10, 0.0);
    float range = smoothstep(radius, radius * 0.4, len);
    occ += ndv * range;
  }
  float ao = 1.0 - clamp(occ / 8.0 * 2.4, 0.0, 1.0) * uStrength;

  // Contact shadows: a short ray-march toward the sun in view space, sampling the
  // depth buffer. If a nearby surface blocks the sun within a small distance, the
  // pixel is in contact shadow (grounds the car/objects where the sun map's texel
  // footprint is too coarse). Folded into AO so the composite multiply applies it.
  if (uContact > 0.0 && uSunVS.z < 0.05) {     // sun at/in front of the camera plane
    float sh = 1.0;
    for (int i = 1; i <= 5; i++) {   // contact-shadow march 8→5
      vec3 q = P + uSunVS * (0.04 * float(i));   // up to ~0.32 m toward the sun
      vec4 cp = uProj * vec4(q, 1.0);
      vec2 quv = cp.xy / cp.w * 0.5 + 0.5;
      if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
      vec3 B = viewPos(quv);                     // blocker view position
      float dz = B.z - q.z;                       // >0: surface is in front of the ray
      // Reject the receiver's OWN near-coplanar surface as a false occluder. On a
      // flat road at a grazing angle the point sampled ahead is almost coplanar
      // with this pixel, so the raw depth test (dz in 0.015..0.5) fires on the
      // road itself — and being screen-space it SWIMS across the tarmac as the
      // camera moves ("wavy moving shadows that vanish when contact shadow is
      // off"). A genuine grounding occluder (wheel, barrier foot, kerb) rises
      // clearly above the receiver's tangent plane; the coplanar road does not.
      // Gate on that height so real contacts still darken but the road can't
      // self-shadow. Bias scales with distance so a distant road pixel (whose
      // whole ~0.3 m march projects into a pixel or two) isn't over-rejected.
      float above = dot(N, B - P);
      float aboveBias = 0.05 + 0.01 * max(-P.z - 6.0, 0.0);
      if (dz > 0.015 && dz < 0.5 && above > aboveBias) { sh = 1.0 - uContact; break; }
    }
    // Smoothly fade the contact term as the sun crosses the camera plane so a
    // chase-cam yaw doesn't flip the whole grounding shadow off in one frame (was
    // a hard uSunVS.z < 0 cutoff — a visible pop). Behind the plane the march
    // points away from view, so this fades to a no-op there (no spurious shadow).
    float front = clamp(-uSunVS.z * 6.0, 0.0, 1.0);
    ao *= mix(1.0, sh, front);
  }
  outColor = vec4(vec3(ao), 1.0);
}`;

  // Volumetric sun shafts (world-space): for each pixel, march the ray from the
  // camera toward the scene point and, at each step, test the SUN SHADOW MAP — lit
  // steps accumulate in-scattered sunlight, shadowed steps don't. The shafts are
  // therefore occluded by REAL geometry (grandstands, trees, cars), unlike a flat
  // screen-space radial blur. Forward Mie phase brightens them toward the sun.
  // Half-res; the result is added to the scene before tonemap so it blooms.
  const GODRAY_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec2 vUV;
uniform sampler2D uDepth;
uniform sampler2DShadow uShadowMap;
uniform mat4 uInvVP;
uniform mat4 uLightVP;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uStr;
uniform float uTime;
uniform float uCloudCover;
uniform float uCloudSpeed;  // cloud drift-rate multiplier (matches SKY/LIT; 0 = frozen)
#define GR_MAX_LIGHTS 12
uniform int uNumLights;
uniform vec3 uLightPos[GR_MAX_LIGHTS];
uniform vec3 uLightCol[GR_MAX_LIGHTS];
uniform float uLightRad[GR_MAX_LIGHTS];
uniform vec3 uLightDir[GR_MAX_LIGHTS];
uniform vec2 uLightCone[GR_MAX_LIGHTS];   // (cosInner, cosOuter)
uniform float uLightVolW[GR_MAX_LIGHTS];  // per-lamp volumetric weight (beam character)
uniform float uMist;       // haze density gate for in-scatter (0 = none)
uniform float uLampStr;    // night lamp-volumetric strength (0 = off, e.g. day)
uniform float uHgAniso;    // god-ray forward-scatter anisotropy g (def 0.60)
uniform float uHgFloor;    // god-ray isotropic scatter floor (def 0.020)
// Nearest-floodlight spot shadow map (same 512² map the lit pass PCF-tests):
// beam steps that the lamp can't see stay dark, so the volumetric shaft is
// carved by cars/walls instead of glowing straight through them. uLampShadowIdx
// is the lamp's slot in THIS pass's nearest-N selection (-1 = no mapped lamp).
uniform sampler2DShadow uLampShadowMap;
uniform mat4 uLampShadowVP;
uniform int uLampShadowIdx;
out vec4 outColor;
vec3 worldPos(vec2 uv, float d) {
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = uInvVP * c;
  return w.xyz / w.w;
}
${GLXChunks.surfaceNoise}
${GLXChunks.ignoise}
float gCloudFBM(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*vnoise(p); p=p*2.03+1.7; a*=0.5; } return s; }  // 4→3 octaves
// Cloud cover at a world point (same model as the lit shader's cloud shadows) so
// the shafts are broken by the SAME clouds that dapple the ground.
float gCloud(vec3 wp){
  if (uCloudCover <= 0.001 || uSunDir.y <= 0.06) return 0.0;
  // Same amplification floor as cloudShadow() in the lit shader (see its
  // comment): near the 0.06 cutoff, dividing by uSunDir.y blows up how fast cp
  // sweeps per metre of march-step height, aliasing under this pass's 16-tap
  // integration — this is the "0.9 made thin stripes" behaviour noted below,
  // now capped instead of only dimmed.
  float t = (360.0 - wp.y) / max(uSunDir.y, 0.15);
  float cT = uTime * uCloudSpeed;   // lockstep with SKY/LIT cloud drift
  vec2 cp = (wp.xz + uSunDir.xz * t) * 0.0052 + vec2(cT * 0.012, cT * 0.005);
  return smoothstep(0.54 - uCloudCover * 0.40, 0.92, gCloudFBM(cp)) * uCloudCover;
}
void main() {
  float d = texture(uDepth, vUV).r;
  // End point: scene hit, or (for sky) a far point along the view ray.
  vec3 viewDir = normalize(worldPos(vUV, 0.5) - uEye);
  vec3 endP = (d >= 0.99999) ? uEye + viewDir * 400.0 : worldPos(vUV, d);
  vec3 ro = uEye;
  vec3 rd = endP - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  float march = min(dist, 260.0);          // cap the march length
  const int N = 16;                        // 32→22→16: jitter + blur hide the coarser step
  float stepLen = march / float(N);
  // Jitter the start with interleaved-gradient noise to hide banding.
  float ign = ignoise(gl_FragCoord.xy);
  float t = stepLen * ign;
  float accum = 0.0;
  vec3 lampAccum = vec3(0.0);
  // PARTICIPATING MEDIUM: the haze has real structure now —
  //  • DENSITY hugs the ground (exp height falloff): beams live down where the
  //    air is, the upper sky holds no medium → no phantom beams in the sky.
  //  • EXTINCTION (Beer-Lambert transmittance): far scattering fades toward the
  //    camera, so shafts are strongest near you instead of piling up at range.
  float trans = 1.0;
  float groundY = uEye.y - 4.0;               // local ground datum
  for (int i = 0; i < N; i++) {
    float td = t + stepLen * float(i);        // distance marched from the camera
    vec3 p = ro + rd * td;
    trans *= exp(-stepLen * 0.010);
    float hSun  = exp(-max(p.y - groundY, 0.0) * 0.03);   // sun shafts reach higher
    float hLamp = exp(-max(p.y - groundY, 0.0) * 0.07);   // lamp haze hugs the road (taller beams)
    vec4 lc = uLightVP * vec4(p, 1.0);
    vec3 sc = lc.xyz / lc.w * 0.5 + 0.5;
    float lit = 1.0;
    if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0)
      lit = texture(uShadowMap, vec3(sc.xy, sc.z - 0.002));
    lit *= 1.0 - gCloud(p) * 0.62;  // clouds break the shafts into SOFT crepuscular bands (0.9 made thin stripes)
    accum += lit * hSun * trans;
    // Lamp in-scatter: each nearby lamp casts a beam through the ground haze,
    // shaped by its aimed cone + falloff (same math as the lit shader's pools),
    // weighted per lamp type (uLightVolW). Range-limited: beams read near the
    // camera; distant cone-crossings were the source of sky-streak noise.
    if (uLampStr > 0.0 && td < 200.0) {
      for (int li = 0; li < 6; li++) {   // nearest-6 lamps for beams (was 12) — nearest-sorted
        if (li >= uNumLights) break;
        vec3 LP = uLightPos[li] - p;
        float ld = length(LP);
        float rad = uLightRad[li];
        if (ld > rad) continue;
        vec3 Ld = LP / max(ld, 1e-3);
        float s = ld / rad;
        float win = clamp(1.0 - s*s*s*s, 0.0, 1.0);
        float att = win * win / (ld * ld + 1.0);
        float cd = dot(-Ld, uLightDir[li]);
        float spot = smoothstep(uLightCone[li].y, uLightCone[li].x, cd);
        float cosL = max(dot(rd, Ld), 0.0);                          // forward scatter
        float hgLd = 1.36 - 1.2 * cosL;                              // HG g=0.6; d >= 0.16, sqrt safe
        float hgL = (1.0 - 0.36) / (hgLd * sqrt(hgLd));              // == pow(d, 1.5) minus the transcendental
        // Shadowed shaft: test this march step against the mapped lamp's depth
        // map — an occluded step contributes no in-scatter, so the beam shows
        // the silhouette of whatever blocks the lamp (one tap × 16 steps,
        // and only for the single mapped lamp).
        float lampLit = 1.0;
        if (li == uLampShadowIdx) {
          vec4 lq = uLampShadowVP * vec4(p, 1.0);
          if (lq.w > 0.0) {
            vec3 lqs = lq.xyz / lq.w * 0.5 + 0.5;
            if (lqs.x > 0.002 && lqs.x < 0.998 && lqs.y > 0.002 && lqs.y < 0.998 && lqs.z < 1.0)
              lampLit = texture(uLampShadowMap, vec3(lqs.xy, lqs.z - 0.004));
          }
        }
        lampAccum += uLightCol[li] * (att * spot * (0.12 + hgL * 0.14) * lampLit) * uLightVolW[li] * hLamp * trans;
      }
    }
  }
  accum /= float(N);
  lampAccum *= uMist * uLampStr * 2.0 / float(N);
  // Henyey-Greenstein phase (g=0.60 = a wider forward lobe so the shafts read
  // across a broader arc, not only when staring straight at the sun) + a small
  // isotropic floor so lit haze glows everywhere, giving an atmospheric volume.
  float cosT = max(dot(rd, uSunDir), 0.0);
  // GOD-RAY FOCUS knob (def 0.60 = as-shipped); clamped <0.95 to keep the HG
  // denominator well-behaved. GOD-RAY HAZE knob (def 0.020) is the isotropic floor.
  float g = clamp(uHgAniso, 0.0, 0.95);
  float hgD = 1.0 + g * g - 2.0 * g * cosT;   // >= (1-g)^2 > 0 at the clamp, sqrt safe
  float hg = (1.0 - g * g) / (hgD * sqrt(hgD));   // == pow(d, 1.5) minus the transcendental
  float phase = hg * 0.16 + uHgFloor;
  outColor = vec4(uSunColor * accum * phase * uStr + lampAccum, 1.0);
}`;

  // Composite: scene + bloom, filmic ACES tone-map, colour grading, sun shafts,
  // lens flare, and a soft vignette.
  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uSSAO;     // ambient occlusion (1 = unoccluded)
uniform vec2 uAOTexel;       // 1/ssaoW, 1/ssaoH (half-res grid) — 0 when AO is off
uniform sampler2D uGodray;   // additive volumetric sun shafts
uniform float uBloomAmt;
uniform float uBloomKnee;    // how much bloom is suppressed over bright pixels (def 0.5)
uniform vec2 uSunUV;
uniform float uFlareStr;
uniform float uExposure;
uniform float uSunShaft;
uniform vec3 uGradeShadow;   // multiplicative tint pulled into shadows  (~1.0 = neutral)
uniform vec3 uGradeHi;       // multiplicative tint pulled into highlights (~1.0 = neutral)
uniform float uGradeStr;     // 0 = neutral grade (backward-compatible)
// Live colour-grade tunables (IMAGE & COLOUR tuner group); defaults reproduce
// the shipped look so a missing tune object is a no-op.
uniform float uContrast;     // midtone-contrast gamma (default 1.12)
uniform float uVibrance;     // selective saturation of dull pixels (default 0.20)
uniform float uSaturation;   // global saturation (1 = unchanged)
uniform float uTint;         // warm(+)/cool(-) white-balance shift, -1..1 (default 0)
uniform float uVignette;     // corner-darkening floor: 1 = none, lower = stronger (default 0.80)
uniform float uVigSoft;      // vignette inner-edge radius / reach (default 0.35)
uniform vec4 uTone0;         // blacks, shadows, midtones, highlights (stops)
uniform vec4 uTone1;         // whites (stops), toe, shoulder, padding
uniform vec3 uLift;          // per-channel lift (0 = neutral)
uniform vec3 uGamma;         // per-channel gamma (1 = neutral)
uniform vec3 uGain;          // per-channel gain (1 = neutral)
uniform float uHdrGradeOn;   // 1 only when any lift/gamma/gain/tone knob is off-neutral (skips the block)
uniform sampler2D uDepth;    // scene depth (for wet-road screen-space reflection)
uniform mat4 uInvProj;       // clip → view (reconstruct view position from depth)
uniform mat4 uProj;          // view → clip  (project the marched ray to screen)
uniform vec3 uUpVS;          // world-up in view space (pick out up-facing road)
uniform vec2 uReflTexel;     // 1/width, 1/height
uniform float uReflect;      // wet-road SSR strength (0 = off)
uniform float uSsrOk;        // 1 when depth+proj inputs are bound this frame (0 = probe-less path: skip SSR entirely)
uniform float uCarReflect;   // car-bodywork SSR strength (CAR tuner group; default 0.05)
uniform float uCarGloss;     // car paint gloss (CAR tuner group; default 1.0) — widens the car's SSR streak as it drops
uniform vec3 uReflSkyHi;     // horizon sky-glow (dim reflection fallback on a march miss)
uniform vec3 uReflSkyLo;     // zenith sky-glow
uniform float uSsrThick;     // wet-road SSR depth thickness gate (def 0.20)
uniform float uSsrTopUV;     // top-of-screen SSR cutoff (def 0.62). The upper screen
                             //   is "never wet road" ONLY for a high, down-looking
                             //   chase eye; a low onboard eye (cockpit/hood) pushes the
                             //   road far higher up the frame, so game.js raises this
                             //   for those cams or the top half of the wet road gets no
                             //   reflection and the band-edge sweeps as the car pitches.
uniform float uSsrNear;      // near edge of the SSR road fade in view Z (def -2.5; the
                             //   far edge is uSsrNear*2.8). Chase sits metres back so its
                             //   road clears this; an onboard eye is on the car, so
                             //   game.js pulls this toward 0 to reflect the near road too.
uniform float uChromAb;      // chromatic aberration toward frame edges (def 0)
uniform float uGrain;        // per-pixel film grain amount (def 0)
uniform float uGrainTime;    // seconds — animates the grain so it isn't a frozen speckle
uniform float uSharpen;      // unsharp-mask crispness (def 0)
uniform float uBlackLift;    // raised black floor (def 0.005)
uniform float uWhitePoint;   // highlight roll-off knee (def 1.0)
uniform float uAcesA;        // ACES curve num-quad coeff a (def 2.51)
uniform float uAcesB;        // ACES curve num-lin  coeff b (def 0.03)
uniform float uAcesC;        // ACES curve den-quad coeff c (def 2.43)
uniform float uAcesD;        // ACES curve den-lin  coeff d (def 0.59)
uniform float uAcesE;        // ACES curve den-const coeff e (def 0.14, floored >0)
uniform float uSpeedBlur;    // radial speed blur amount, 0 = off
uniform sampler2D uDirt;     // procedural lens-dirt smudge map (generated at init)
uniform float uLensDirt;     // lens-dirt veil strength (IMAGE & COLOUR knob, def 0.15)
uniform vec2 uHazeUV;        // player tailpipe screen UV (heat-haze plume anchor)
uniform float uHazeStr;      // exhaust heat-haze strength (0 = off; boost pushes ~1)
uniform float uHazeTime;     // seconds — scrolls the shimmer upward
uniform float uShaftDecay;   // screen-space sun-shaft per-tap falloff (def 0.82)
uniform float uFlareStreak;  // anamorphic flare horizontal tightness (def 7.0)
uniform float uFlareStreak2; // second thin hot-core flare streak strength (def 0.5)
out vec4 outColor;

// Reconstruct view-space position from the depth buffer at a screen UV.
vec3 ssrViewPos(vec2 uv) {
  float d = texture(uDepth, uv).r * 2.0 - 1.0;     // window depth → NDC z
  vec4 cp = uInvProj * vec4(uv * 2.0 - 1.0, d, 1.0);
  return cp.xyz / cp.w;
}

// Scene sample carrying the CHROMATIC ABERRATION radial R/B split, so the later
// SPEED BLUR and SHARPEN passes sample in the SAME domain as CA instead of the
// raw scene — otherwise stacking CA with speed blur / sharpen re-mixed
// un-aberrated taps and largely cancelled the fringe. uChromAb = 0 → identity.
vec3 caScene(vec2 uv) {
  if (uChromAb <= 0.001) return texture(uScene, uv).rgb;
  vec2 d = uv - 0.5;
  float a = uChromAb * 0.004 * dot(d, d);
  return vec3(texture(uScene, uv + d * a).r, texture(uScene, uv).g, texture(uScene, uv - d * a).b);
}

// Five overlapping exposure masks in log2 stops around 18% middle grey.
void gradeZoneWeights(float y, out vec4 w0, out float wWhite) {
  float z = log2(max(y, 1e-6) / 0.18);
  // ACES compresses roughly the bottom four linear stops into the first few
  // display values. Wider low-end masks keep BLACKS and SHADOWS visible after
  // that compression instead of letting the later black-floor clamp erase them.
  w0.x = 1.0 - smoothstep(-4.0, -0.75, z);
  w0.y = smoothstep(-4.0, -1.5, z) * (1.0 - smoothstep(-1.0, 0.75, z));
  w0.z = smoothstep(-2.5, -0.5, z) * (1.0 - smoothstep(0.5, 2.5, z));
  w0.w = smoothstep(0.0, 1.5, z) * (1.0 - smoothstep(3.0, 5.0, z));
  wWhite = smoothstep(2.5, 5.0, z);
}

// Monotonic power curves pivoted at middle grey. Toe affects only luminance
// below the pivot; shoulder affects only luminance above it. RGB is rescaled by
// the luminance ratio, preserving hue and making zero on both controls identity.
vec3 applyToeShoulder(vec3 c, float toe, float shoulder) {
  c = max(c, vec3(0.0));
  float oldY = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  float exponent = oldY < 0.18
    ? exp2(clamp(toe, -1.0, 1.0))
    : exp2(clamp(-shoulder, -1.0, 1.0));
  float newY = 0.18 * pow(oldY / 0.18, exponent);
  return c * (newY / max(oldY, 1e-6));
}

vec3 applyHdrGrade(vec3 c) {
  vec3 lift = uLift;
  vec3 gain = max(uGain, vec3(1e-3));
  vec3 invGamma = 1.0 / max(uGamma, vec3(1e-3));
  c = lift + (gain - lift) * pow(max(c, vec3(0.0)), invGamma);

  float y = max(dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  vec4 w0; float wWhite;
  gradeZoneWeights(y, w0, wWhite);
  // Per-zone exposure gain. The two dark zones get a wider stop swing than the
  // 1:1 mid/high zones: a plain +/-1 stop multiply barely moves the low end once
  // ACES compresses it, so SHADOWS looked weak. Scaling their contribution
  // (blacks x3, shadows x2) makes both bite harder, while neutral (0) stays an
  // exact identity.
  vec4 toneGain = uTone0 * vec4(3.0, 2.0, 1.0, 1.0);
  float stops = dot(w0, toneGain) + wWhite * uTone1.x;
  c *= exp2(clamp(stops, -4.0, 4.0));
  // Additive low-end offset for BLACKS/SHADOWS. A multiply can never move a
  // near-black pixel (x*0 stays 0), which is exactly why BLACKS "did nothing" on
  // dark night/dusk scenes. A small signed additive lift, weighted to the black
  // and shadow zones, is what actually reveals near-black detail (+) or crushes
  // it to a true black (-) — the DaVinci-style Lift the labels describe. Neutral
  // (0) adds nothing, so identity is preserved; the clamp keeps blacks solid.
  c += w0.x * uTone0.x * 0.05 + w0.y * uTone0.y * 0.025;
  c = max(c, vec3(0.0));

  c = applyToeShoulder(c, uTone1.y, uTone1.z);
  return max(c, vec3(0.0));
}

${GLXChunks.ignoise}
${GLXChunks.tonemap}
// Lifts shadows slightly (warm), crushes a tiny bit of the blue channel in
// mid-tones, and boosts green just a hint — gives an F1 broadcast look.
vec3 colourGrade(vec3 c) {
  // Gain (per-channel linear scale in highlights)
  c *= vec3(1.015, 1.008, 0.992);
  // Soft S-curve: deepen contrast for punch (less washed-out / flat)
  c = c * (1.0 + c * 0.13) / (1.0 + c * 0.20);
  // Midtone-darkening contrast for a more realistic, less-bright look: a gentle
  // gamma deepens the mids/shadows while blacks stay black and the ACES highlight
  // rolloff is preserved — turns the flat "video-game bright" image filmic.
  c = pow(c, vec3(uContrast));
  // Vibrance: pull colour away from its luma. Weighted by how UNsaturated the
  // pixel already is, so pale, washed-out areas (hazy sky, dull grass, gray
  // asphalt) gain the most while vivid neon/kerbs don't over-cook. This is the
  // main fix for the "boring / washed-out" daytime look.
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float sat = mx - mn;
  c = mix(vec3(luma), c, 1.0 + (1.0 - clamp(sat * 1.5, 0.0, 1.0)) * uVibrance);
  // Global saturation (uniform, after vibrance): a plain luma<->colour lerp.
  c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, uSaturation);
  // White-balance tint: warm tilts red up / blue down, cool the reverse. Subtle
  // per-unit so the full -1..1 range stays natural rather than a colour cast.
  c *= vec3(1.0 + 0.07 * uTint, 1.0, 1.0 - 0.07 * uTint);
  // Cinematic split-tone: tint shadows one way (cool teal) and highlights the
  // other (warm amber), blended by luma. A staple of the teal-orange film look —
  // gives dusk/dawn richer separation and night a cool moody cast. uGradeStr 0
  // (default) leaves the image untouched, so day stays neutral unless driven.
  float gl2 = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 toneTint = mix(uGradeShadow, uGradeHi, smoothstep(0.0, 0.85, gl2));
  c = mix(c, c * toneTint, uGradeStr);
  // BLACK LIFT: raised (slightly warm) black floor — prevents pure blacks and,
  // pushed up, gives a matte faded-film base. Default 0.005 = the shipped floor.
  c = max(c, vec3(uBlackLift, uBlackLift * 0.8, uBlackLift * 0.6));
  return c;
}

void main() {
  // EXHAUST HEAT HAZE: a small rising shimmer plume anchored just above the
  // player's tailpipe screen position — refracts (UV-warps) the scene fetch
  // inside a soft elliptical region. Gaussian falloff keeps the warp local;
  // the travelling phase (uHazeTime) makes it boil upward frame to frame.
  // Skip the warp on car-paint pixels (SSR alpha tag): from chase cam the
  // plume sits on the rear body, and warping those UVs made the car look
  // wavy whenever throttle was held (exhaustPop > 0). Air/road behind still
  // shimmers.
  vec2 hazeUV = vUV;
  if (uHazeStr > 0.002) {
    float carHere = 1.0 - smoothstep(0.42, 0.55, texture(uScene, vUV).a);
    if (carHere < 0.25) {
      vec2 hd = (vUV - uHazeUV - vec2(0.0, 0.08)) * vec2(3.2, 1.0);   // tall plume, centred above the pipe
      float hm = exp(-dot(hd, hd) * 70.0) * uHazeStr;
      if (hm > 0.003) {
        float hp = vUV.y * 90.0 - uHazeTime * 11.0;
        hazeUV += vec2(sin(hp + vUV.x * 70.0), cos(hp * 0.63)) * (0.0075 * hm);
      }
    }
  }
  vec4 scn = texture(uScene, hazeUV);   // one fetch: .rgb colour + .a SSR car tag
  vec3 c = scn.rgb;
  vec2 caDir = vUV - 0.5;

  // CHROMATIC ABERRATION: split the R/B channels radially — the fringe grows
  // quadratically toward the frame corners (real lens dispersion). 0 = off.
  if (uChromAb > 0.001) {
    float caAmt = uChromAb * 0.004 * dot(caDir, caDir);
    c.r = texture(uScene, hazeUV + caDir * caAmt).r;
    c.b = texture(uScene, hazeUV - caDir * caAmt).b;
  }

  // SPEED BLUR: radial smear from the frame centre outward, growing with the
  // car's velocity (uSpeedBlur folds speed × the tuner amount). 0 = off.
  if (uSpeedBlur > 0.001) {
    vec3 acc = c; float wsum = 1.0;
    for (int i = 1; i <= 4; i++) {
      float t = float(i) / 4.0 * uSpeedBlur * 0.05;
      acc += caScene(vUV - caDir * t);   // caScene carries CA so the two don't cancel
      wsum += 1.0;
    }
    c = acc / wsum;
  }

  // SHARPEN: unsharp mask against a 4-tap neighbour blur (uReflTexel is uploaded
  // every frame). Recovers kerb/wire crispness FXAA softens. 0 = off.
  if (uSharpen > 0.001) {
    vec3 bl = (caScene(vUV + vec2(uReflTexel.x, 0.0))
             + caScene(vUV - vec2(uReflTexel.x, 0.0))
             + caScene(vUV + vec2(0.0, uReflTexel.y))
             + caScene(vUV - vec2(0.0, uReflTexel.y))) * 0.25;
    c += (c - bl) * uSharpen * 0.9;
  }

  // Ambient occlusion: darken creases/contacts before bloom + tonemap so the
  // grounding reads in linear light (under cars, barrier feet, kerbs, building
  // bases). 1.0 = no change, so it's a no-op when SSAO is disabled.
  // The AO buffer is HALF resolution — a plain bilinear fetch averages AO
  // straight across depth discontinuities, so the dark crease AO hugging a near
  // surface bleeds onto the far side of every silhouette (a soft grey halo
  // tracing the car roofline / wing tips against sky and road). Depth-aware
  // 4-tap bilateral upsample instead: the four half-res texels around this
  // pixel keep their bilinear weights, re-weighted by how close each tap's
  // depth is to THIS pixel's full-res depth — taps that belong to the other
  // side of an edge lose their vote, so AO stays pinned to its own surface.
  // uAOTexel is zeroed when AO is off (1×1 white bound): plain fetch, no cost.
  float aoV = 1.0;
  if (uAOTexel.x > 0.0) {
    float aoDc = texture(uDepth, vUV).r;
    vec2 aoG = vUV / uAOTexel - 0.5;
    vec2 aoF = fract(aoG);
    vec2 aoB = (floor(aoG) + 0.5) * uAOTexel;
    float aoSum = 0.0, aoW = 0.0;
    for (int ai = 0; ai < 4; ai++) {
      vec2 auv = aoB + vec2(ai == 1 || ai == 3 ? uAOTexel.x : 0.0,
                            ai >= 2 ? uAOTexel.y : 0.0);
      float bw = (ai == 0 ? (1.0 - aoF.x) * (1.0 - aoF.y)
                : ai == 1 ? aoF.x * (1.0 - aoF.y)
                : ai == 2 ? (1.0 - aoF.x) * aoF.y
                          : aoF.x * aoF.y) + 1e-4;
      // Depth similarity as a ratio weight: silhouettes are big steps in window
      // depth, same-surface slope is tiny, so no linearisation is needed — the
      // scale cancels in the normalisation below.
      float w = bw / (1e-4 + abs(aoDc - texture(uDepth, auv).r) * 30.0);
      aoSum += texture(uSSAO, auv).r * w;
      aoW += w;
    }
    aoV = aoSum / aoW;
  } else {
    aoV = texture(uSSAO, vUV).r;
  }
  c *= aoV;

  // Volumetric sun shafts: additive in-scattered sunlight (0 when disabled).
  c += texture(uGodray, vUV).rgb;

  // ── Wet-road screen-space reflection ────────────────────────────────────────
  // The neon city and lit windows are emissive geometry (not point lights), so
  // the lit shader can't mirror them on wet tarmac. Here we march the reflected
  // view ray through the depth buffer and sample the already-lit scene colour,
  // so the city actually reflects in wet night roads. Gated to wet+dark scenes.
  // Cheap early-out: the sky sits at the far plane and the upper screen is never
  // wet road — skip the costly position/normal reconstruction + march there.
  // Guarded so dry/day frames (uReflect 0, uDepth unbound) never sample depth.
  // Car-paint pixels (alpha tag < 0.5) reflect the world in EVERY session —
  // dry or wet — through the same march as the wet road.
  float carPx = 1.0 - smoothstep(0.42, 0.55, scn.a);
  if (uSsrOk > 0.5 && (uReflect > 0.001 || carPx > 0.3) && texture(uDepth, vUV).r < 0.9999 && vUV.y < uSsrTopUV) {
    vec3 P = ssrViewPos(vUV);
    // View-space normal from depth derivatives (cheap; rough at silhouettes, but
    // the road-mask + march thickness test reject the bad cases).
    // 3-TEXEL baseline, not 1: at phone resolution (~2500 px wide, DPR 2-3) one
    // texel spans so little world space at a grazing road angle that the depth
    // deltas are quantization-dominated — the reconstructed normal turns to
    // noise, upDot dances around the road-mask threshold, and the wet mirror
    // breaks into patches that shift every frame (and drops out entirely in the
    // hood cam, whose slight up-aim grazes hardest). A wider baseline scales the
    // world-space deltas up 3x, cutting the quantization noise 3x at every
    // resolution — a 3-texel step at phone res sees the geometry the way a
    // 1-texel step did at the low res where this demonstrably worked. The normal
    // is only a coarse road-vs-wall classifier (the road's reflection RAY uses
    // the flattened plane below), so the slight extra blur is free.
    vec2 nT = uReflTexel * 3.0;
    vec3 dpx = ssrViewPos(vUV + vec2(nT.x, 0.0)) - P;
    vec3 dpy = ssrViewPos(vUV + vec2(0.0, nT.y)) - P;
    // Guarded like the SSAO normal: parallel/zero derivatives at silhouettes
    // NaN the normalize and sparkle the far field.
    vec3 crv = cross(dpx, dpy);
    float crvL = length(crv);
    // Degenerate fallback = the ROAD's up direction, NOT view-forward (0,0,1).
    // At grazing distance (a low cockpit eye looking down a straight) the road's
    // screen footprint flattens, the depth derivatives go near-parallel and this
    // fallback fires over a narrow distance band. Defaulting to view-forward
    // zeroed upDot there → the whole roadMask collapsed in one step → the wet
    // mirror ended in a HARSH horizontal line, with matte road beyond. The road
    // IS up-facing, so assume uUpVS: SSR then fades out on the smooth distance
    // taper below instead of snapping off.
    vec3 upVSn = normalize(uUpVS);
    // ...but crvL > 1e-6 is an ABSOLUTE magnitude, and that is the wrong test.
    // crvL scales with |dpx|·|dpy|, and at grazing distance those derivatives span
    // METRES — so the cross product stays large while its DIRECTION is pure depth
    // quantization noise. The guard therefore almost never fired where it was
    // needed: measured on a wet straight from the cockpit, upDot collapsed and
    // smoothstep(0.25, 0.55, upDot) zeroed the road mask across everything past
    // the first few metres, leaving a narrow glossy strip in front of the car and
    // matte tarmac for the rest of the frame. Test the CONDITIONING instead — the
    // sine of the angle between the two derivatives, which is scale-free — so the
    // fallback fires exactly when the basis is degenerate, at any distance.
    float sinT = crvL / max(length(dpx) * length(dpy), 1e-12);
    vec3 Nv = (crvL > 1e-6 && sinT > 0.08) ? crv / crvL : upVSn;
    if (Nv.z < 0.0) Nv = -Nv;                     // face the eye (view space looks down -z)
    // ...and THAT flip is what actually killed the wet road. A ground normal seen
    // at grazing incidence is world-up, whose view-space z is ~0 — so "face the
    // eye" picks its sign off a near-zero component, i.e. essentially at random,
    // and with the camera pitched up (an uphill, or just the cockpit's look-ahead)
    // it lands DOWNWARD. upDot then reads -1, smoothstep(0.25, 0.55, upDot)
    // returns 0, and the road mask collapses across everything past the first few
    // metres: a narrow glossy strip in front of the car, matte tarmac for the rest
    // of the frame, and a hard line where the sign flips. MEASURED by rendering
    // the three roadMask gates to RGB — the road came back cyan (upDot gate 0)
    // beyond one white band.
    //
    // Alignment with up is a DOUBLE-SIDED property of a plane, so don't decide it
    // from a coin-toss component: re-orient a clearly ground-facing normal upward.
    // Walls sit at |dot| ~ 0.0-0.1, well inside the dead band, so the road-vs-wall
    // classification this mask exists for is untouched. Nv itself is re-oriented
    // (not just upDot) so the flattened reflection normal Nr and the car mask stay
    // consistent with it.
    if (dot(Nv, upVSn) < -0.25) Nv = -Nv;
    float upDot = dot(Nv, upVSn);
    // Up-facing AND not the very-near cockpit (z near 0). P.z is negative ahead.
    // Fade out the far field: depth precision + coarse march steps there breed
    // speckle, and reflections compress to nothing near the horizon anyway — so
    // keep the clean, high-impact foreground and taper the distance out. The
    // fade end is pushed out (-55 → -78) so the taper spreads across more screen
    // rows near the cockpit horizon instead of compressing into a visible band.
    // Relaxed up-facing test (was 0.40..0.75): with the road's reflection ray
    // now built from the flattened plane, upDot only has to separate ROAD from
    // WALLS — and walls sit at upDot ≈ 0.0-0.1, nowhere near 0.25. The old 0.40
    // edge (already scraped by banked corners per LIGHTING-KNOBS) meant a noisy
    // grazing-angle normal could drop genuine road below threshold — the other
    // half of the patchy/dropout mask failure at phone resolution.
    float roadMask = smoothstep(0.25, 0.55, upDot)
                   * smoothstep(uSsrNear, uSsrNear * 2.8, P.z)
                   * (1.0 - smoothstep(-22.0, -78.0, P.z));
    // Car bodywork: up-facing-ish panels, allowed much nearer than the road
    // (the chase camera sits ~5-8 m behind the car).
    float carMask = carPx * smoothstep(0.30, 0.65, upDot)
                  * smoothstep(-1.0, -3.0, P.z)
                  * (1.0 - smoothstep(-22.0, -55.0, P.z));
    // Reject the noisy car silhouette rim: dpx/dpy (already computed above for Nv)
    // spike at edge pixels, which is exactly where the cheap upDot normal is worst.
    // ÷3 compensates the 3-texel derivative baseline so the rejection threshold
    // keeps the same per-texel meaning it was tuned at.
    float edgeGrad = (length(dpx) + length(dpy)) * (1.0 / 3.0);
    carMask *= 1.0 - smoothstep(0.35, 0.9, edgeGrad);
    float roadTerm = roadMask * uReflect;
    float carTerm  = carMask  * uCarReflect;
    float ssrGate  = max(roadTerm, carTerm);
    if (ssrGate > 0.001) {
      bool carDom = carTerm > roadTerm;   // hoisted: the march needs it too
      vec3 V = normalize(-P);
      // The ROAD reflects off a near-FLAT plane, not its bumpy per-pixel normal.
      // Nv is reconstructed from depth derivatives, so it picks up the road's
      // facets / undulation / micro-relief — and reflecting off that bumpy normal
      // scatters the reflected ray, so the march hits on-screen scenery in some
      // pixels and shoots off-screen (miss) in others. That is the "patchy, shifts
      // as I drive" wet road: the reflective/matte split wanders with the bumps and
      // the camera. Reflecting off the smooth road plane keeps every road pixel's
      // ray coherent → one continuous, stable reflection that still mirrors the
      // real scene. Car paint keeps its true normal (curved bodywork needs it).
      // 0.85 toward flat: kills the bump scatter while retaining a little real
      // slope/bank response.
      //
      // upVSn is the ROAD's normal, not world-up (game.js builds it from r × t).
      // That distinction is the whole elevation story: flattening onto world-up
      // put this normal a full gradient-angle off the surface it is meant to
      // approximate, the reflect() doubled it, and on any real climb the ray left
      // at an angle the road never had.
      vec3 Nr = (carTerm > roadTerm) ? Nv : normalize(mix(Nv, upVSn, 0.85));
      vec3 R = reflect(-V, Nr);                    // points up toward the city
      // Finer refined march: small fixed steps (dense near/mid) so small/distant
      // emissive lamp heads + neon aren't stepped over (was a coarse 12×1.42 march).
      // JITTERED: an un-jittered march quantizes the hit at identical step
      // boundaries down whole pixel columns, slicing the mirrored city into hard
      // vertical slats with flat sky-fallback stripes between them on a fully wet
      // road. Interleaved-gradient-noise offsets each pixel's march start by a
      // sub-step, dithering that banding into fine noise the streak blur + bloom
      // absorb. Growth eased 1.22→1.16 (+4 steps keeps the ~120 m reach) so late
      // steps stay small enough for the refine to land on thin distant emitters.
      float ign = ignoise(gl_FragCoord.xy);
      vec3 pos = P, prevPos = P;
      float stepLen = 0.55;
      pos += R * (stepLen * ign);                  // sub-step start offset per pixel
      float hit = 0.0;
      float hitDist = 0.0;                       // march distance to the hit (contact hardening)
      vec2 hitUV = vec2(0.0);
      bool found = false;
      for (int i = 0; i < 24; i++) {
        prevPos = pos;
        pos += R * stepLen;
        stepLen *= 1.16;                           // gentle growth
        vec4 cp = uProj * vec4(pos, 1.0);
        if (cp.w <= 0.0) break;
        vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
        float dz = ssrViewPos(suv).z - pos.z;      // >0 = ray passed behind a surface
        // SSR THICKNESS gate. The far-sky reject window must scale with the
        // current step: late steps span many metres, so a fixed 5 m ceiling
        // rejected legitimate hits mid-distance — the other source of the
        // striped hit/miss alternation on strongly reflective roads.
        if (dz > uSsrThick && dz < max(5.0, stepLen * 1.5)) {
          vec3 a = prevPos, b = pos;               // binary-search refine → crisp hit
          for (int j = 0; j < 4; j++) {
            vec3 mid = (a + b) * 0.5;
            vec4 mc = uProj * vec4(mid, 1.0);
            vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
            if (ssrViewPos(muv).z - mid.z > 0.20) b = mid; else a = mid;
          }
          vec4 fc = uProj * vec4(b, 1.0);
          vec2 huv = fc.xy / fc.w * 0.5 + 0.5;
          // GRAZING SELF-REFLECTION REJECT. From a low onboard eye the reflected
          // ray leaves the tarmac at the same shallow angle the view ray arrived,
          // so it skims a metre above the road for tens of metres — and the march
          // lands on the ROAD ITSELF a short way ahead (measured: the whole
          // mid-frame band of a wet straight mirrors wet-darkened asphalt). The
          // wet mirror then fills with tarmac, reads MATTE, and butts against the
          // analytic sky mirror beside it as a hard-edged patch. Physically a
          // rough wet surface contributes almost nothing to its own grazing
          // reflection, so reject a hit whose surface faces the same way the
          // reflector does and keep marching — the ray climbs and may still find
          // a barrier, car or tree. Normals are reconstructed on the same 3-texel
          // baseline as Nv, and the eye-facing flip keeps the up/down distinction
          // (a roof UNDERSIDE reads down-facing, so real overheads still mirror).
          if (!carDom) {
            vec3 hP  = ssrViewPos(huv);
            vec3 hdx = ssrViewPos(huv + vec2(nT.x, 0.0)) - hP;
            vec3 hdy = ssrViewPos(huv + vec2(0.0, nT.y)) - hP;
            vec3 hcr = cross(hdx, hdy);
            float hcl = length(hcr);
            vec3 hN  = hcl > 1e-6 ? hcr / hcl : upVSn;
            if (hN.z < 0.0) hN = -hN;
            if (dot(hN, upVSn) > 0.55) continue;
          }
          hitUV = huv;
          hitDist = length(b - P);
          vec2 e = abs(hitUV - 0.5) * 2.0;
          hit = 1.0 - pow(max(e.x, e.y), 4.0);     // screen-edge fade
          found = true;
          break;
        }
      }
      // Vertical light-smear: real wet roads stretch reflected lights into soft
      // vertical streaks toward the viewer. Extra HDR taps down/up-screen from the
      // hit (Gaussian, wetness+grazing-scaled) bloom into the streak naturally.
      vec3 hitCol = vec3(0.0);
      if (found) {
        // Car reflections get their own blur character (gloss-driven) instead of
        // inheriting the road's wetness-driven streak spread.
        float carSoft = clamp((1.4 - uCarGloss) * 0.5, 0.0, 1.0);
        float streak = (carTerm > roadTerm)
          ? uCarReflect * (0.006 + 0.030 * carSoft)
          : uReflect * (0.010 + 0.022 * clamp((uSsrTopUV - vUV.y) / uSsrTopUV, 0.0, 1.0));
        // CONTACT HARDENING: real rough reflections blur with distance from the
        // reflector — the reflection of an object touching the wet road is
        // near-crisp, a distant tower smears. Scale the streak by the march's
        // actual hit distance: sharp at contact (x0.3), softer far out (x1.6).
        streak *= mix(0.3, 1.6, clamp(hitDist / 25.0, 0.0, 1.0));
        float w0 = 0.30, w1 = 0.24, w2 = 0.15, w3 = 0.08, w4 = 0.04;
        hitCol  = texture(uScene, hitUV).rgb * w0;
        hitCol += texture(uScene, hitUV + vec2(0.0, -streak * 0.5)).rgb * w1;
        hitCol += texture(uScene, hitUV + vec2(0.0, -streak * 1.0)).rgb * w2;
        hitCol += texture(uScene, hitUV + vec2(0.0, -streak * 1.6)).rgb * w3;
        hitCol += texture(uScene, hitUV + vec2(0.0, -streak * 2.3)).rgb * w4;
        hitCol += texture(uScene, hitUV + vec2(0.0,  streak * 0.5)).rgb * w1;
        hitCol += texture(uScene, hitUV + vec2(0.0,  streak * 1.0)).rgb * w2;
        hitCol /= (w0 + 2.0 * w1 + 2.0 * w2 + w3 + w4);
      }
      // Miss fallback: reflect the dim night sky-glow, never a black hole.
      // R.y is the reflection's up-ness: grazing rays (R.y→0, far road) should
      // show the HORIZON glow, steep rays (R.y→1, road right under the camera)
      // the ZENITH — matching the lit shader's analytic env mix(horizon,zenith)
      // and physical wet-road reflection. Was mix(zenith,horizon), inverted, so
      // the reflected sky bands ran upside-down vs the road's own paint mirror.
      // ...but "up-ness" is measured against the surface, and R.y is the ray's
      // VIEW-space y — those only agree while the camera is level. In the cockpit
      // the view pitches with the road, so on a climb or a dip R.y drifted off the
      // real up axis and the fallback picked horizon-vs-zenith from the wrong one:
      // the miss regions took a sky colour that did not belong to the direction
      // they were reflecting. Now that a miss substitutes at the same cover as a
      // hit, that error is fully visible, so measure against the road plane.
      vec3 skyRefl = mix(uReflSkyHi, uReflSkyLo, clamp(dot(R, upVSn), 0.0, 1.0));
      // CONFIDENCE in the marched hit, not a boolean. hit already tapers as the
      // hit approaches the frame border; blending the fallback in over that taper
      // (instead of swapping colours outright) means a ray that walks off screen
      // hands over to the sky smoothly rather than at a pixel-wide seam.
      float conf = found ? clamp(hit, 0.0, 1.0) : 0.0;
      vec3 reflCol = mix(skyRefl, hitCol, conf);
      // SPECULAR OCCLUSION: the diffuse AO above never touched the reflection
      // terms, so a mirrored wet road / glossy deck inside an occluded crease
      // (under the car, wheel wells, barrier feet) still GLOWED with reflected
      // scene/sky — bright streaks exactly where the surface should be buried.
      // Lagarde-style ao² (specular visibility shrinks faster than diffuse)
      // on the reflected colour keeps open road untouched (ao ≈ 1) while
      // creases keep their darkness through the mirror substitution.
      reflCol *= aoV * aoV;
      // Soft-clip the reflected colour BEFORE it's substituted in: a bright HDR
      // hit (neon signage, a lit window, the sun disc, a floodlight lens) was
      // injected raw, so a handful of very bright reflected pixels could blow
      // the whole mirror surface toward white. Compressing here caps the mirror
      // itself at a sane peak while keeping its colour (unlike a post multiply).
      reflCol = reflCol / (1.0 + reflCol * 0.35);
      // SSR changes WHAT the wet road mirrors, never HOW MUCH it mirrors.
      //
      // The march hits in some screen regions and misses in others — from a low
      // grazing onboard eye it alternates over a few pixels (each mirrored tree
      // is a hit, the sky between them a miss). Scaling the SUBSTITUTION by that
      // boolean turned a difference in reflected CONTENT into a difference in
      // SURFACE: hit pixels took a near-full mirror, miss pixels a third of one,
      // so the tarmac broke into reflective-vs-matte patches with hard edges.
      // Cover 1.0-vs-0.30 (and 1.0-vs-1.0 before build 734) both did this; the
      // ratio only set how obvious it was.
      //
      // The lit shader already carries the coherent base — envBlend is floored
      // at wetSheen*0.55 (lit.js) expressly so the analytic sky mirror gives the
      // wet look wherever the march misses. So hold the road's cover CONSTANT and
      // let only reflCol vary: hits show the marched scene, misses the sky, both
      // through the same amount of mirror. Car paint keeps its confidence-scaled
      // cover — it falls through to the lit shader's env mirror on a miss, which
      // is already continuous because the env cube covers every direction.
      float cover  = carDom ? conf : 0.60;
      // Clean DARKER MIRROR: substitute the reflected scene into a darkened base
      // (a real wet mirror shows the scene it reflects, not a wash added on top).
      // Mirror-like: a high base reflectance (so mid/near tarmac mirrors too, not
      // just the grazing band) with a gentle Fresnel lift toward the horizon.
      // Fresnel off the SAME normal the reflection ray used (Nr), not the bumpy
      // reconstructed Nv: Nv carries the road's facets and depth-derivative noise,
      // and this term swings strength across 0.55..0.97, so feeding it Nv sprayed
      // that noise straight back into the mirror the flattened ray exists to keep
      // coherent. Car paint's Nr IS Nv, so car behaviour is unchanged.
      float fres = pow(1.0 - max(dot(Nr, V), 0.0), 3.0);
      // Car SSR reflects the on-screen HDR scene — sharp, bright light sources
      // (neon, lit windows, floodlights) that punch through and bloom like the
      // wet road mirrors them. Strong face-on (the env cube owns the off-screen/
      // sky read; SSR owns the crisp on-screen lights + nearby geometry).
      float strength = ssrGate * (carDom ? (0.50 + 0.45 * fres)
                                         : (0.55 + 0.42 * fres));
      // The darker-mirror substitution below is tuned for WET roads. At the
      // faint dry levels (uReflect < 0.2: dry-day 0.07 / dry-night 0.16) fade
      // the substitution quadratically so it reads as a subtle sheen instead
      // of dark towers replacing the sunlit tarmac. Car-paint pixels damp by
      // their OWN driving value (uCarReflect), not the road's — otherwise a
      // dry session silently crushes car reflections regardless of carReflect.
      float gateSrc = carDom ? uCarReflect : uReflect;
      strength *= min(gateSrc / 0.20, 1.0);
      // The whole SSR branch above is gated by a HARD "vUV.y < uSsrTopUV" cutoff
      // (a cheap early-out — for a high chase eye the upper screen is sky, never
      // wet road/car paint; a low onboard eye raises uSsrTopUV since the road
      // climbs higher up the frame). That boolean gate is a step function:
      // reflected pixels just below the line are full-strength, pixels just above
      // get none, so any noticeable difference between the mirrored colour and the
      // base scene shows as a visible seam slicing across the frame. Fade the last
      // few percent out instead of cutting it off.
      strength *= 1.0 - smoothstep(uSsrTopUV - 0.06, uSsrTopUV, vUV.y);
      float mixAmt = clamp(strength * cover, 0.0, carDom ? 0.85 : 0.80);   // road cap 0.94→0.80: keep more of the reflective lit base under a HIT so hit vs miss regions share the same wet look (less patchy), car unchanged
      // Near-full darker-mirror substitution — the car mirrors the scene it
      // reflects (bright on-screen lights punch through), keeping a whisper of
      // pigment so the livery still tints the reflection.
      vec3 mirrored = carDom ? c * 0.22 + reflCol * 0.88
                             : c * 0.10 + reflCol * 0.92;
      c = mix(c, mirrored, mixAmt);
    }
  }

  // Exposure multiply before tone-mapping (default 1.0 = no change).
  c *= uExposure;

  // Improved bloom: add with a mild tone-aware mask so it doesn't wash out
  // already-bright pixels (reduce bloom addition proportionally in highlights).
  vec3 bloomSample = texture(uBloom, vUV).rgb;
  // uBloomKnee (BLOOM ON HIGHLIGHTS) scales the highlight suppression: 0 = bloom
  // everything evenly (milky), 1 = strongly hold bloom off blown pixels (crisp).
  float bloomMask = 1.0 - clamp(max(c.r, max(c.g, c.b)) - 0.7, 0.0, 0.3) / 0.3 * uBloomKnee;
  // Scale by uExposure to match the scene: the bright-pass samples the RAW
  // pre-exposure HDR target, but the scene above is already multiplied by
  // uExposure. Without this, a driven exposure (0.86–0.90 at night) dimmed the
  // scene while the halos kept full pre-exposure energy — over-strong bloom.
  c += bloomSample * uBloomAmt * bloomMask * uExposure;

  // LENS DIRT veil: grime on the lens scatters incoming light into a smudgy
  // film. Driven by the blurred bright-pass, so it only appears where the frame
  // actually carries bright energy (sun, floodlights, neon) — a dark scene
  // stays clean. The dirt value is reused by the flare modulation below.
  float dirt = 0.0;
  if (uLensDirt > 0.001) {
    dirt = texture(uDirt, vUV).r;
    c += bloomSample * uExposure * dirt * uLensDirt * 2.2;
  }

  // Sun shafts / god-rays: radial samples from current pixel toward the sun's
  // screen position, reading the bright-pass (bloom[0] after bright-pass step).
  // Additively composited. Gated when uSunShaft > 0 (sun on-screen, above horizon).
  if (uSunShaft > 0.0) {
    vec2 toSun = uSunUV - vUV;
    float dist = length(toSun);
    // Only cast rays when we're not right on top of the sun (avoid div-zero).
    if (dist > 0.005) {
      vec2 step = toSun / dist * min(dist, 0.40) / 8.0;
      vec3 shaft = vec3(0.0);
      // Interleaved-gradient-noise start jitter: hides the 8-tap quantisation
      // (without it, a small bright spot smears into a dotted comet dash).
      float ign = ignoise(gl_FragCoord.xy);
      vec2 uv = vUV + step * ign;
      float decay = 1.0;
      for (int i = 0; i < 8; i++) {
        uv += step;
        // Clamp so we don't sample outside 0..1 (avoids edge bleed).
        vec2 suv = clamp(uv, vec2(0.0), vec2(1.0));
        // Crepuscular rays emanate from the SUN'S OWN glare. Weight each sample
        // by its proximity to the sun so an isolated bright lamp head or cloud
        // hotspot elsewhere on screen can never smear into a comet streak.
        float sw = 1.0 - clamp(length(suv - uSunUV) / 0.32, 0.0, 1.0);
        shaft += texture(uBloom, suv).rgb * (decay * sw * sw);
        decay *= uShaftDecay;   // SUN-SHAFT REACH knob (def 0.82 = as-shipped)
      }
      shaft /= 8.0;
      // Radial falloff: strongest near the sun, zero at the edge of the screen.
      float radial = 1.0 - clamp(dist * 2.6, 0.0, 1.0);
      c += shaft * uSunShaft * radial * radial * 0.60;
    }
  }

  // Professional HDR grade runs after all linear-light bloom/shaft composition
  // and before the display-referred ACES curve. Gated: at neutral knobs the
  // whole block is an identity that still cost ~20 ALU + 4 transcendentals
  // per pixel — uHdrGradeOn is 1 only when a knob is actually off-neutral.
  if (uHdrGradeOn > 0.5) c = applyHdrGrade(c);

  // Filmic tone-map (ACES) + colour grading. WHITE POINT scales the input knee:
  // lower clips highlights sooner (punchy), higher preserves highlight detail.
  c = acesTonemap(c / uWhitePoint);
  c = colourGrade(c);

  // Lens flare: anamorphic streak + ghost circles
  vec3 flare = vec3(0.0);
  // OCCLUSION: the streaks + ghosts below are PURELY procedural (screen position
  // vs sun UV) with no scene sampling, so without this they bleed straight
  // through a grandstand/building/hill the sun sits behind. Scene depth is 1.0
  // (far) on open sky and < 1.0 wherever geometry covers the sun's screen point,
  // so sample it at uSunUV and fade the flare when the sun is hidden. (The
  // god-ray shaft above self-occludes: it samples the dark-behind-geometry
  // bright-pass.) uDepth is bound to the scene depth every frame (SSR inputs).
  float sunVis = smoothstep(0.9990, 0.9999, texture(uDepth, uSunUV).r);
  if (uFlareStr > 0.0 && sunVis > 0.0 && uSunUV.x >= 0.0 && uSunUV.x <= 1.0 &&
      uSunUV.y >= 0.0 && uSunUV.y <= 1.0) {
    // Anamorphic horizontal streak — warm and wide, the iconic "sun bleeding
    // across the frame" golden-hour cue (uFlareStr peaks when the sun is low).
    // The horizontal falloff (was 1.3) barely decayed across the ENTIRE screen
    // width (exp(-1.3) ~ 0.27 a full frame-width away), so any golden-hour
    // driving painted a near-full-width bright band across the whole image,
    // added AFTER tonemap+grade with no further compression — none of the
    // exposure/bloom/reflection dampening upstream touched it. Tightened so
    // the streak stays a contained, elongated highlight near the sun instead
    // of a screen-wide wash.
    float streakY = exp(-abs(vUV.y - uSunUV.y) * 110.0);
    float streakX = exp(-abs(vUV.x - uSunUV.x) * uFlareStreak);   // FLARE STREAK knob (def 7.0)
    flare += vec3(1.0, 0.80, 0.52) * streakY * streakX * 0.75;
    // A second thinner hot core streak (FLARE CORE STREAK knob, def 0.5).
    float streakX2 = exp(-abs(vUV.x - uSunUV.x) * 10.0);
    flare += vec3(1.0, 0.92, 0.78) * exp(-abs(vUV.y - uSunUV.y) * 320.0) * streakX2 * uFlareStreak2;

    // Lens ghost circles along sun-to-center axis
    vec2 toCenter = vec2(0.5) - uSunUV;
    float d0 = length(vUV - (uSunUV + toCenter * 0.5));
    flare += vec3(1.0, 0.88, 0.65) * smoothstep(0.055, 0.020, d0) * 0.35;
    float d1 = length(vUV - (uSunUV + toCenter * 1.3));
    flare += vec3(0.70, 0.60, 1.00) * smoothstep(0.038, 0.012, d1) * 0.25;
    float d2 = length(vUV - (uSunUV + toCenter * 1.8));
    flare += vec3(0.50, 1.00, 0.70) * smoothstep(0.028, 0.008, d2) * 0.18;

    // Soft-clip (was a hard clamp to 1.2 — a flat ceiling still let a wide,
    // near-uniform band sit at 1.2 across the whole streak). Compressing keeps
    // the hot core near the sun bright while taming the wash further out.
    flare *= uFlareStr * sunVis;
    // Lens dirt breaks the clean procedural flare into a blotchy, smudged one —
    // bright spots where grime catches the glare, dimmer in the clean patches.
    if (uLensDirt > 0.001) flare *= mix(1.0, 0.35 + dirt * 2.2, clamp(uLensDirt * 2.0, 0.0, 0.85));
    flare = flare / (1.0 + flare * 0.6);
  }
  c += flare;

  // Vignette — aspect-corrected so the darkening is circular in SCREEN space,
  // not an ellipse. The old length(vUV-0.5) treated one UV unit of width like
  // one of height, so on the wide race viewport (~2.16:1) it over-darkened the
  // top/bottom into horizontal bands. Scale x by aspect (from uReflTexel =
  // 1/width,1/height) then renormalise so the frame CORNER still maps to the
  // same 0.707 radius the tuned thresholds expect (identity at 1:1).
  vec2 q = vUV - 0.5;
  float vAspect = uReflTexel.x > 0.0 ? uReflTexel.y / uReflTexel.x : 1.0;   // width/height
  q.x *= vAspect;
  float vr = length(q) * 0.70710678 / length(vec2(0.5 * vAspect, 0.5));
  // uVigSoft (VIGNETTE REACH) is the inner edge: lower = broad soft gradient
  // reaching toward centre, higher = a thin ring hugging the corners. Kept below
  // the fixed 0.95 outer edge so the smoothstep stays well-ordered.
  float vig = smoothstep(0.95, min(uVigSoft, 0.94), vr);
  c *= mix(uVignette, 1.0, vig);

  // Dither: a triangular-PDF noise of ~1 output LSB, added in the LDR domain to
  // break the 8-bit banding that otherwise stamps visible steps onto smooth sky
  // and fog gradients (and rescues the RGBA8 fallback path). Interleaved-
  // gradient hashes on PIXEL coords (the old vUV-seeded sin-hash was screen-
  // locked white noise — a frozen speckle welded to the panel), stepped each
  // frame by the golden-ratio IGN offset so the pattern re-randomises in time
  // like real sensor noise. Two decorrelated hashes → triangular in [-1,1].
  vec2 dc = gl_FragCoord.xy + 5.588238 * mod(floor(uGrainTime * 60.0), 64.0);
  float d0 = ignoise(dc);
  float d1 = fract(52.9829189 * fract(dot(dc + 17.31, vec2(0.00583715, 0.06711056))));
  c += (d0 + d1 - 1.0) / 255.0;
  // FILM GRAIN: luminance-weighted per-pixel noise (mid-tones grain most, blacks
  // and clipped whites least — where real sensor grain lives). 0 = off.
  if (uGrain > 0.001) {
    // Per-frame animated: without a time term the "grain" is welded to the
    // panel — a frozen dirty-lens speckle, not moving sensor noise. Offset the
    // sample point by a time-varying jitter so each frame re-randomises.
    vec2 gUV = vUV + vec2(fract(uGrainTime * 1.37), fract(uGrainTime * 0.61)) * 3.17;
    float gn = fract(sin(dot(gUV, vec2(93.9898, 47.233))) * 61237.312) - 0.5;
    float gLuma = dot(c, vec3(0.299, 0.587, 0.114));
    c += gn * uGrain * (1.0 - abs(gLuma - 0.5) * 1.4);
  }
  outColor = vec4(c, 1.0);
}`;

  // FXAA (Timothy Lottes, compact). Edge-detect via luma in a 3×3 neighbourhood,
  // then blend along the detected edge — kills the jaggies/shimmer on thin
  // geometry, kerbs, wires and specular highlights that MSAA misses. Runs on the
  // already-tonemapped LDR image, last, straight to the screen.
  const FXAA_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 outColor;
float fxLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 t = uTexel;
  vec3 cM = texture(uTex, vUV).rgb;
  float lM  = fxLuma(cM);
  float lNW = fxLuma(texture(uTex, vUV + vec2(-t.x,-t.y)).rgb);
  float lNE = fxLuma(texture(uTex, vUV + vec2( t.x,-t.y)).rgb);
  float lSW = fxLuma(texture(uTex, vUV + vec2(-t.x, t.y)).rgb);
  float lSE = fxLuma(texture(uTex, vUV + vec2( t.x, t.y)).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  // Flat areas (incl. HUD/text) stay pixel-exact.
  if (lMax - lMin < max(0.04, lMax * 0.125)) { outColor = vec4(cM, 1.0); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * t;
  vec3 rA = 0.5 * (texture(uTex, vUV + dir * (-1.0/6.0)).rgb
                 + texture(uTex, vUV + dir * ( 1.0/6.0)).rgb);
  vec3 rB = rA * 0.5 + 0.25 * (texture(uTex, vUV + dir * -0.5).rgb
                             + texture(uTex, vUV + dir *  0.5).rgb);
  float lB = fxLuma(rB);
  outColor = vec4((lB < lMin || lB > lMax) ? rA : rB, 1.0);
}`;

  // Depth-only pass for shadow map — renders world position into depth buffer.
  // Sun/lamp shadow depth pass. Mirrors LIT_VS's instancing gate so instanced
  // scenery CASTS shadows: without it an instanced prop would light correctly and
  // then drop no shadow, which reads as a floating object rather than a bug.
  // Locations 5-8 are the same four instance-matrix columns LIT_VS declares, and
  // uInstanced defaults to 0 so every existing caller is byte-identical.
  const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=5) in vec4 aInst0;
layout(location=6) in vec4 aInst1;
layout(location=7) in vec4 aInst2;
layout(location=8) in vec4 aInst3;
uniform float uInstanced;
uniform mat4 uModel;
uniform mat4 uLightVP;
void main() {
  mat4 M = uInstanced > 0.5 ? mat4(aInst0, aInst1, aInst2, aInst3) : uModel;
  gl_Position = uLightVP * M * vec4(aPos, 1.0);
}`;

  const DEPTH_FS = `#version 300 es
void main() {}`;

  // PCSS blocker map: conservative min-of-4 downsample of the sun shadow map
  // (SHADOW_SIZE² -> 512²), one tap at the centre of each quadrant of this dest
  // texel's source footprint. uSrcTexel = 1/SHADOW_SIZE: the old hardcoded
  // 1/512*0.25 offset happened to equal one source texel on the desktop 2048
  // map (identical output) but sampled only a half-texel window on the 1024
  // mobile map — under-sampled blockers, optimistic penumbra, tier-dependent.
  const BLOCKER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uDepthTex;
uniform vec2 uSrcTexel;
out vec4 o;
void main() {
  vec2 t = uSrcTexel;
  float d0 = texture(uDepthTex, vUV + t * vec2(-1.0, -1.0)).r;
  float d1 = texture(uDepthTex, vUV + t * vec2( 1.0, -1.0)).r;
  float d2 = texture(uDepthTex, vUV + t * vec2(-1.0,  1.0)).r;
  float d3 = texture(uDepthTex, vUV + t * vec2( 1.0,  1.0)).r;
  o = vec4(min(min(d0, d1), min(d2, d3)), 0.0, 0.0, 1.0);
}`;

export { POST_VS, BRIGHT_FS, BLUR_FS, DOWN_FS, UP_FS, SSAO_FS, GODRAY_FS, COMPOSITE_FS, FXAA_FS, DEPTH_VS, DEPTH_FS, BLOCKER_FS };
