/*
 * Apex 26 — GLSL sources for the WebGL2 renderer (js/render/glx.js):
 * the SKY dome program (SKY_VS/SKY_FS) — gradient + sun + clouds
 * + stars, fullscreen triangle at far depth.
 * Split from the old monolithic glx-shaders.js. Template strings may
 * interpolate GLXChunks (js/render/shaders/chunks.js — loads first); each file
 * registers its programs on the shared GLXShaders global. All shader files
 * must load BEFORE js/render/glx.js (it destructures GLXShaders at eval).
 */
import { GLXChunks } from "./chunks.js";

  const SKY_VS = `#version 300 es
uniform mat4 uInvViewProj;
out vec3 vDir;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 1.0, 1.0); // z = w -> depth 1.0 (far plane)
  vec4 a = uInvViewProj * vec4(p, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(p, 1.0, 1.0);
  vDir = b.xyz / b.w - a.xyz / a.w;
}`;

  const SKY_FS = `#version 300 es
precision highp float;
in vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uStars;
uniform float uCloud;
uniform float uTime;   // seconds, 0 = static/deterministic (backward-compatible)
uniform float uMoon;   // 0..1 moon visibility (0 = none, backward-compatible)
uniform vec3 uCityGlow;  // night city light-pollution dome (colour x strength, 0 = none)
uniform float uStarBright; // star-field intensity multiplier (def 1.0)
uniform float uCloudSpeed; // cloud drift/evolution rate multiplier (def 1.0)
uniform float uSkyGrad;    // horizon→zenith gradient exponent (def 0.35)
uniform float uStarDensity;// star-field spawn-window multiplier (def 1.0)
uniform float uDaySkyBlue; // day deep-blue mid-band strength (def 1.0)
uniform float uMieScatter; // sun-facing sky forward-scatter glow gain (def 1.0)
uniform float uCloudSilver;// backlit cloud-edge silver-lining gain (def 1.0)
uniform float uCoronaAureole; // wide sun aureole halo gain (def 1.0)
uniform float uSunDiscSize;// angular size of the sun disc (def 1.0)
uniform float uStarSize;   // star point-size multiplier (def 1.0)
uniform float uStarTwinkle; // star twinkle amplitude scale (def 1.0)
uniform float uMoonDiscSize;// moon disc angular-size multiplier (def 1.0)
uniform float uMoonHalo;   // moon halo spread/strength scale (def 1.0)
uniform float uSunCorona;  // tight sun corona ring gain (def 1.0)
uniform float uSunSquash;  // sun horizon vertical-squash amount (def 1.0)
uniform float uCityGlowReach; // city-glow horizon reach scale (def 1.0)
uniform float uCloudDef;   // cloud edge definition/contrast (def 1.0)
uniform float uLightning;  // storm strike flash 1→0 (0 = none, backward-compatible)
out vec4 outColor;
${GLXChunks.hash}
${GLXChunks.vnoise}
${GLXChunks.ignoise}
void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;
  float sd = max(dot(dir, uSunDir), 0.0);

  // Sun-elevation factor: 0 = sun on/below horizon, 1 = overhead noon.
  // Drives automatic golden-hour / sunset tint without per-track authoring.
  float sunE = clamp(uSunDir.y * 1.4, 0.0, 1.0);

  // Bright-DAY gate: 1 only when the sun is well up (≈25°+). Isolates day-only
  // sky enrichments (cumulus definition, horizon cloud-bank, gradient life) so
  // the dramatic dusk/dawn/night looks that share this shader are untouched.
  float daytime = smoothstep(0.35, 0.60, sunE);
  // TWILIGHT gate: ~1 at dawn/dusk (low sun above the horizon), 0 at deep night
  // and bright day. Drives extra sunset/sunrise cloud presence + warm grading.
  float twilight = smoothstep(0.02, 0.22, sunE) * (1.0 - daytime);

  // NIGHT gate: uStars>0.5 marks a night session. At night the scene keeps
  // uSunDir pointing HIGH (it doubles as the moon key-light direction), which
  // fools the sunElevation math above into reading midday — painting a bright
  // white sun disc + puffy daytime cumulus + a blue day gradient among the
  // stars. Zero the sun-driven day/twilight ENRICHMENTS here (the horizon
  // warm-glow terms below are already up-faded to the horizon, so they stay).
  float nightSky = step(0.5, uStars);
  daytime  *= (1.0 - nightSky);
  twilight *= (1.0 - nightSky);

  // Overcast factor: drives grey-shift and corona damping under heavy cloud.
  float overcast = smoothstep(0.5, 1.0, uCloud);

  // --- Sky gradient ---
  vec3 c;
  if (up >= 0.0) {
    // Under heavy overcast, flatten zenith/horizon toward a uniform grey.
    vec3 zenithO  = mix(uZenith,  vec3(0.55, 0.56, 0.58), overcast * 0.75);
    vec3 horizonO = mix(uHorizon, vec3(0.58, 0.58, 0.60), overcast * 0.60);
    // pow(up, uSkyGrad): richer blue zenith extends further down, horizon band
    // narrower — avoids the pale/washed look at mid-sky while keeping the
    // gradient smooth. (Was 0.5 which mapped too much sky to the horizon tint.)
    // SKY GRADIENT knob (def 0.35 = as-shipped); lower = richer dome, higher = paler mid.
    c = mix(horizonO, zenithO, pow(up, uSkyGrad));
    // Day gradient LIFE: a deeper saturated blue pushed into the low/mid band
    // (so the gameplay sky strip isn't a flat pale wash) plus a faint azimuthal
    // variation that breaks the perfectly-smooth gradient. Day-only and faded
    // under overcast, so dusk/dawn/night and grey days are untouched.
    {
      float bandLM = (1.0 - smoothstep(0.06, 0.55, up)) * smoothstep(0.0, 0.06, up);
      vec3 deepBlue = vec3(0.10, 0.30, 0.72);
      // DAY SKY BLUE knob (def 1.0 = as-shipped) scales the band strength; clamp
      // keeps the blend valid when the knob pushes past 1.
      c = mix(c, mix(c, deepBlue, 0.30), clamp(daytime * (1.0 - overcast) * bandLM * uDaySkyBlue, 0.0, 1.0));
      float az = vnoise(vec2(atan(dir.z, dir.x) * 2.2, up * 6.0)) - 0.5;
      c *= 1.0 + az * 0.05 * daytime * (1.0 - overcast) * (1.0 - smoothstep(0.0, 0.5, up));
    }
    // Golden-hour: warm amber/orange overlay near the horizon when the sun is low.
    // Concentrated in the bottom 32% of sky; fades out as sun climbs past ~50°.
    // Damped under overcast so heavy cloud doesn't show warm colour.
    float goldenAmt = (1.0 - smoothstep(0.0, 0.72, sunE))
                    * (1.0 - smoothstep(0.0, 0.32, up))
                    * (1.0 - overcast * 0.9);
    vec3 goldenColor = mix(vec3(0.70, 0.22, 0.04), vec3(0.92, 0.55, 0.16),
                           clamp(sunE * 2.5, 0.0, 1.0));
    c = mix(c, c * 0.45 + goldenColor * 0.55, goldenAmt * 0.80);
    // Low-sun horizon band: extra warm band just above the horizon at sunset.
    // Gives a richer, more saturated glow at the magic hour.
    float lowBand = (1.0 - smoothstep(0.0, 0.60, sunE))
                  * (1.0 - smoothstep(0.0, 0.18, up))
                  * smoothstep(0.01, 0.06, up)
                  * (1.0 - overcast * 0.85);
    vec3 lowColor = mix(vec3(0.90, 0.26, 0.03), vec3(1.0, 0.66, 0.12),
                        clamp(sunE * 3.0, 0.0, 1.0));
    c = mix(c, lowColor, lowBand * 0.70);
  } else {
    // Below the horizon: dark earth tone, smoothly blended from the horizon colour.
    float gnd = clamp(-up * 5.0, 0.0, 1.0);
    c = mix(uHorizon * 0.85, vec3(0.035, 0.030, 0.022), gnd * gnd);
  }

  // --- Procedural cloud layer ---
  // Cloud plane is drifted slowly by uTime (no drift when time=0 → deterministic).
  // Coverage/thickness seen along this ray, exported for the city-glow cloud
  // pickup below (clouds over a lit city catch the uplight on their bellies).
  float cityCov = 0.0;
  float cityThick = 0.0;
  if (uCloud > 0.001 && up > 0.012) {
    vec2 cp = dir.xz / up * 0.42;
    // Drift offset: two independent slow vectors for parallax feel. CLOUD SPEED
    // knob scales the drift/evolution rate (uCloudSpeed 1 = shipped, 0 = frozen).
    float cT = uTime * uCloudSpeed;
    vec2 drift1 = vec2(cT * 0.0028, cT * 0.0011);
    vec2 drift2 = vec2(cT * 0.0017, cT * 0.0023);
    // Evolution: a very slow warp of the second octave to change cloud shape.
    float evo = cT * 0.00035;
    vec2 cp1 = cp + drift1;
    vec2 cp2 = cp + drift2;
    float f = fbm(cp1);
    // Base coverage. Lower band than the old 0.55→0.92 so puffy cumulus read
    // clearly instead of faint wisps; fade in just above the horizon.
    float cov = smoothstep(0.50 - uCloud * 0.42, 0.84, f) * smoothstep(0.013, 0.05, up);
    // ── Cloudscape enrichments — bright DAY *and* TWILIGHT (sunset/sunrise) get
    //    extra cumulus definition + a horizon cloud-bank; deep night is untouched.
    float cloudRich = max(daytime, twilight);
    if (cloudRich > 0.001) {
      // Billow: a higher-frequency octave carves lumpy cumulus definition so the
      // puffs read as 3-D cauliflower rather than flat smears.
      float billow = fbm(cp1 * 2.3 + vec2(11.7, 4.3));
      float defined = smoothstep(0.42, 0.80, f * 0.6 + billow * 0.45)
                    * smoothstep(0.013, 0.05, up);
      // CLOUD DEFINITION (uCloudDef, def 1) scales how strongly the billow octave
      // carves lumpy cumulus edges onto the base coverage (0.85 = as-shipped blend).
      cov = mix(cov, max(cov, defined), clamp(cloudRich * 0.85 * uCloudDef, 0.0, 1.0));
      // Horizon cloud-bank: distant cumulus bunched near the horizon on a
      // compressed plane, so the LOW gameplay sky band (just above the scenery)
      // is never a plain wash. Its own coverage + a band fade focused ~1–9°.
      // Twilight gets a fuller, lower bank so sunset/sunrise has dramatic strata
      // catching the warm light right where the player looks.
      vec2 bp = dir.xz / max(up, 0.02) * 0.16 + drift1 * 1.4;
      float bankThresh = 0.46 - uCloud * 0.30 - twilight * 0.10;
      float bankCov = smoothstep(bankThresh, 0.80, fbm(bp))
                    * smoothstep(0.013, 0.030, up) * (1.0 - smoothstep(0.10, 0.26, up));
      cov = max(cov, bankCov * cloudRich * (1.0 - overcast * 0.5));
      // Firmer edges so cumulus look solid, not gauzy.
      cov = mix(cov, smoothstep(0.18, 0.82, cov), cloudRich * 0.5);
    }
    // Second FBM gives per-cloud "thickness": thin areas = backlit bright,
    // thick billowing regions = shadowed dark underside.
    float thick = clamp(fbm(cp2 * 0.55 + vec2(3.1 + evo, 1.7)) * 2.0 - 0.55, 0.0, 1.0);
    float sl = pow(sd, 2.0);
    float sunBright = max(uSunColor.r, max(uSunColor.g, uSunColor.b));
    // Under heavy overcast, clamp sunBright so even a bright sun gives grey clouds.
    float effectiveSunBright = mix(sunBright, min(sunBright, 0.55), overcast);
    float golden = 1.0 - smoothstep(0.0, 0.45, sunE);   // 1 near horizon, 0 high
    // Sunlit tops: white in daylight, strongly warm/red-tinted at golden hour.
    vec3 cloudTop = mix(vec3(0.58, 0.62, 0.70), vec3(1.0, 0.97, 0.91), sl);
    cloudTop *= 0.38 + 0.62 * effectiveSunBright;
    cloudTop = mix(cloudTop, cloudTop * uSunColor * mix(1.45, 2.6, golden),
                   sl * (1.0 - sunE) * (0.55 + golden * 0.40) * (1.0 - overcast));
    // Under overcast flatten tops toward medium grey.
    cloudTop = mix(cloudTop, vec3(0.62, 0.63, 0.65), overcast * 0.65);
    // Dark undersides: cooler/dimmer, but pick up a warm pink under-glow at sunset.
    vec3 cloudBot = vec3(0.26, 0.27, 0.34) * (0.24 + 0.44 * effectiveSunBright);
    cloudBot += uSunColor * vec3(0.9, 0.42, 0.5) * (0.22 * golden * (1.0 - overcast) * (1.0 + twilight * 1.3));
    cloudBot = mix(cloudBot, vec3(0.19, 0.19, 0.22), overcast * 0.60);
    vec3 lit = mix(cloudBot, cloudTop, clamp(0.18 + (1.0 - thick) * 0.75, 0.0, 1.0));
    // Day: widen the top↔bottom contrast so cumulus get punchy sunlit caps and
    // shadowed bases (gated; twilight clouds keep their soft warm grading).
    {
      float capf = clamp(0.18 + (1.0 - thick) * 0.75, 0.0, 1.0);
      lit = mix(lit, mix(cloudBot * 0.80, cloudTop * 1.14, capf), daytime * 0.45);
    }
    // Silver lining: thin sun-facing cloud edges glow bright (backlit forward scatter),
    // most intense at golden hour — the defining dramatic-cloud cue. Pushed much
    // harder at twilight so sunset/sunrise clouds get blazing fire-lit rims.
    float silver = pow(sd, 6.0) * (1.0 - thick) * (0.55 + golden) * (1.0 - overcast * 0.7);
    // CLOUD SILVER LINING knob (def 1.0 = as-shipped) scales the backlit rim glow.
    lit += uSunColor * silver * (1.3 + twilight * 1.6) * uCloudSilver;
    // Twilight: a broad warm wash across the sun-facing cloud field (not just the
    // thin rim) so the whole sky catches fire at the magic hour.
    lit += uSunColor * pow(sd, 2.5) * twilight * 0.30 * (1.0 - overcast * 0.6);
    // Moon tints nearby clouds faintly blue-silver.
    if (uMoon > 0.0) {
      float moonLit = uMoon * cov * (1.0 - thick * 0.6) * 0.18;
      lit = mix(lit, lit + vec3(0.08, 0.10, 0.16), moonLit);
    }
    // LIGHTNING: during a strike (uLightning 1→0, the same decay that spikes
    // ambient/exposure in game.js) the cloud deck itself flares — a storm flash
    // is diffused THROUGH the clouds, so thick billowing bellies light up
    // brightest (the bolt is inside/behind the deck) while thin wisps bleach
    // less. Cool blue-white, HDR >1 so the flash blooms like the real thing.
    if (uLightning > 0.001) {
      vec3 ltFlash = vec3(0.82, 0.94, 1.30) * (1.0 + thick * 1.2);
      lit = mix(lit, ltFlash, clamp(uLightning * (0.40 + 0.60 * thick), 0.0, 1.0));
    }
    c = mix(c, lit, cov);
    cityCov = cov;
    cityThick = thick;
  }

  // LIGHTNING sky-gradient lift: the clear dome between the clouds also picks
  // up a gentler cool bleach during a strike (scattered flash light), weighted
  // DOWN where the cloud deck already flared above so the energy isn't doubled.
  if (uLightning > 0.001 && up > 0.0) {
    c += vec3(0.10, 0.13, 0.20) * uLightning * (1.0 - cityCov * 0.6);
  }

  // --- Mie forward scatter: glow toward the sun, strongest near the horizon ---
  // Damped under overcast (corona hidden behind cloud).
  float upPos = max(up, 0.0);
  float mieDamp = 1.0 - overcast * 0.85;
  // MIE SCATTER knob (def 1.0 = as-shipped) scales the sun-facing sky glow; clamp
  // keeps the mix blend valid when the knob pushes the amount past 1.
  c = mix(c, uSunColor, clamp(pow(sd, 5.0) * 0.22 * max(1.0 - upPos * 1.5, 0.0) * mieDamp * uMieScatter, 0.0, 1.0));

  // --- Horizon glow in the sun's compass direction ---
  vec2 sunH = vec2(uSunDir.x, uSunDir.z);
  float sunHLen = length(sunH);
  if (sunHLen > 0.05) {
    vec2 dirH = vec2(dir.x, dir.z);
    float dirHLen = length(dirH);
    float hdot = dirHLen > 0.05 ? max(dot(dirH / dirHLen, sunH / sunHLen), 0.0) : 0.0;
    float hband = max(1.0 - abs(up) * 5.0, 0.0);
    c += uSunColor * pow(hdot, 6.0) * hband * hband * 0.22 * sunHLen * mieDamp;
  }

  // --- Sun corona + disc (damped under overcast) ---
  // goldenFactor: 1 when the sun is at the horizon, 0 high up — drives reddening,
  // a broader warm aureole, a vertically flattened disc, and a brighter HDR core.
  // coronaDamp folds in the NIGHT gate: the sun disc + corona + inner ring all
  // multiply by this, so a night session (sunDir high as the moon key) can never
  // paint a daytime sun disc up among the stars. The moon disc is drawn separately.
  float coronaDamp = (1.0 - overcast * 0.92) * (1.0 - nightSky);
  float golden = 1.0 - smoothstep(0.0, 0.45, sunE);
  vec3 sunWarm = mix(uSunColor, uSunColor * vec3(1.18, 0.52, 0.24), golden);
  // Wide aureole: broader (lower exponent) and stronger at golden hour.
  // CORONA AUREOLE knob (def 1.0 = as-shipped) scales the broad sun halo glow.
  c += sunWarm * pow(sd, mix(20.0, 8.0, golden)) * (0.55 + golden * 0.55) * coronaDamp * uCoronaAureole;
  // SUN CORONA RING knob (def 1.0 = as-shipped) scales the tight inner ring.
  c += sunWarm * pow(sd, 300.0) * 0.95 * uSunCorona * coronaDamp;   // tight inner ring
  // Flatten the disc near the horizon (atmospheric refraction squashes it).
  // SUN HORIZON SQUASH knob (def 1.0 = as-shipped): scales the golden-hour vertical
  // squash of the disc (1.0 = round, higher = more oval near the horizon).
  vec3 dd = dir - uSunDir * sd;
  float perp = length(vec2(length(dd.xz), dd.y * mix(1.0, mix(1.0, 1.6, golden), uSunSquash)));
  // SUN DISC SIZE knob (def 1.0 = as-shipped): scales the disc's angular radius by
  // widening the smoothstep edge. Larger = a bigger, brighter sun.
  float disc = smoothstep(mix(0.018, 0.028, golden) * uSunDiscSize, 0.006 * uSunDiscSize, perp) * coronaDamp;
  // Bright HDR core (>1) so it blooms into glare; warm-white high, deep amber low.
  vec3 discCore = mix(vec3(2.3, 2.2, 1.9), sunWarm * 2.8, golden);
  c += discCore * disc;

  // --- Stars (night tracks) ---
  if (uStars > 0.5 && up > 0.05) {
    // ROUND point stars. The old version lit whole direction-grid CELLS, which
    // project as elongated dashes on screen (they read as "tiny rays"), and its
    // giant stars crossed the bloom threshold and smeared into streaks. Now each
    // star is a tiny anti-aliased DISC placed inside its cell, with brightness
    // capped below the bloom threshold so stars can never bloom into rays.
    float SC = 180.0;
    vec3 cell = floor(dir * SC);
    float h = hash3(cell);
    // STAR DENSITY knob (def 1.0 = as-shipped): scale the (1 - threshold) spawn
    // window, clamped below 1 so a huge density can't reject every cell to blank.
    if (h > min(0.9994, 1.0 - (1.0 - 0.9968) * uStarDensity)) {
      vec3 jit = vec3(hash3(cell + 7.1), hash3(cell + 13.7), hash3(cell + 29.3)) - 0.5;
      vec3 sdir = normalize((cell + 0.5 + jit * 0.8) / SC);
      float d = length(dir - sdir);
      float bright = 0.30 + 0.55 * hash3(cell + 43.0);
      float phase = hash3(cell + 31.0) * 6.2832;
      // STAR TWINKLE knob (def 1.0 = as-shipped): scales the ±0.20 oscillation
      // amplitude around the 0.80 base (0 = rock-steady stars).
      float twinkle = 0.80 + 0.20 * uStarTwinkle * sin(uTime * 1.4 + phase);
      float giant = step(0.9995, h);                     // rare brighter star
      // STAR SIZE knob (def 1.0 = as-shipped): scales each star's disc radius.
      float srad = mix(0.0016, 0.0028, giant) * uStarSize;
      float star = smoothstep(srad, srad * 0.35, d)
                 * min(0.88, bright * twinkle * (1.0 + giant * 0.6));
      // Cloud occlusion: stars sit BEHIND the cloud deck, so coverage along
      // this ray (cityCov, hoisted from the cloud pass above) fades them out —
      // an overcast night shows few/no stars instead of stars ON the clouds.
      c += vec3(star) * uStarBright * (1.0 - cityCov);   // STAR BRIGHTNESS knob
    }
  }

  // --- Moon disc + halo (night tracks) ---
  if (uMoon > 0.0 && uStars > 0.5) {
    // Fixed moon direction: high in the sky, to the right of the sun's compass direction.
    // Using a stable world-space direction so it doesn't follow the camera.
    vec3 moonDir = normalize(vec3(0.42, 0.72, 0.55));
    float md = dot(dir, moonDir);
    float moonPerp = length(dir - moonDir * max(md, 0.0));
    // Moon disc: crisp soft edge. MOON DISC SIZE knob (def 1.0 = as-shipped)
    // scales the disc's angular radius via the smoothstep edges.
    float moonDisc = smoothstep(0.025 * uMoonDiscSize, 0.010 * uMoonDiscSize, moonPerp) * uMoon;
    // Moon halo: broad soft glow. MOON HALO SPREAD knob (def 1.0 = as-shipped)
    // scales the halo strength (0.28) and widens its falloff (140 → 140/size).
    float moonHalo = exp(-moonPerp * moonPerp * (140.0 / max(uMoonHalo, 0.001))) * 0.28 * uMoonHalo * uMoon;
    // Moon colour: cool blue-white
    vec3 moonCol = vec3(0.82, 0.88, 1.00);
    // The halo should only appear above the horizon and not wash out too much.
    if (up > 0.0 && md > 0.0) {
      c += moonCol * (moonDisc * 1.10 + moonHalo);
    }
  }

  // CITY SKYGLOW: light pollution from the lit circuit/city — a warm dome that
  // hugs the horizon and fades fast with elevation, with a hint of cloud pickup
  // (clouds over a city glow from below). Zero when uCityGlow is black.
  if (uCityGlow.r + uCityGlow.g + uCityGlow.b > 0.001) {
    // CITY GLOW REACH knob (def 1.0 = as-shipped): scales the horizon-hug exponent
    // (lower = the glow climbs higher up the sky, higher = it hugs the horizon).
    float horiz = pow(clamp(1.0 - max(dir.y, 0.0) * 2.4, 0.0, 1.0), 3.0 * uCityGlowReach);
    c += uCityGlow * horiz;
    // Cloud pickup: the cloud deck over a lit city glows from BELOW — thick
    // bellies catch the most uplight, and the effect eases off toward the
    // zenith (the dome's energy is strongest near the horizon). Kept subtle
    // (×0.45) so heavy cover reads as a warm overcast lid, not banding.
    float pickup = cityCov * (0.35 + 0.65 * cityThick)
                 * clamp(1.0 - dir.y * 1.6, 0.0, 1.0);
    c += uCityGlow * pickup * 0.45;
  }

  // ~1/255 interleaved-gradient dither on the dome output: the night gradient
  // spans just a handful of 8-bit steps, and on the RGBA8 fallback path the
  // quantisation happens right here at scene write — the composite's own
  // dither can't repair steps that were baked into its input. Time-stepped so
  // it shimmers like noise instead of etching a fixed pattern.
  float skyDth = ignoise(gl_FragCoord.xy + 5.588238 * mod(floor(uTime * 60.0), 64.0));
  c += (skyDth - 0.5) * (1.0 / 255.0);

  outColor = vec4(c, 1.0);
}`;

export { SKY_VS, SKY_FS };
