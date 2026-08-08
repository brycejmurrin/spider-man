/*
 * Apex 26 — WebGL2 renderer core: the PBR GGX lit pass (sun + 32 spot lamps,
 * shadow maps, procedural materials, wet road, fog), the procedural sky and
 * the FX passes — ~13 programs. GLSL sources live in js/render/shaders/
 * (chunks/lit/sky/fx/post); the post, shadow and chunked-scenery subsystems
 * are split into js/render/glx/.
 */
import { Log } from "../log.js";
import { M4 } from "../mat4.js";
import { LIT_VS, LIT_FS } from "./shaders/lit.js";
import { SKY_VS, SKY_FS } from "./shaders/sky.js";
import { SHADOW_VS, SHADOW_FS, MARK_FS, MARK_BATCH_VS, DECAL_VS, DECAL_FS, GLOW_VS, GLOW_FS, PARTICLE_VS, PARTICLE_FS } from "./shaders/fx.js";
import { GLXPost } from "./glx/post.js";
import { GLXShadow } from "./glx/shadow.js";
import { GLXChunked } from "./glx/chunked.js";
"use strict";

export const GLX = (function () {
  // GLSL sources live in js/render/shaders/{lit,sky,fx,post}.js (loaded before this
  // file). The post/shadow sources are destructured by the split subsystem modules
  // (js/render/glx/post.js, js/render/glx/shadow.js) instead of here.

  let gl = null;
  let canvas = null;
  // Mobile tier: iOS home-screen web apps (WKWebView) get a tight jetsam memory
  // budget that GPU/IOSurface allocations count against — a hard kill, no JS
  // error, no contextlost event. Shrink every discretionary GPU allocation on
  // phones/tablets. (iPadOS 13+ masquerades as Mac; catch it via touch points.)
  // spidey.forceMobileTier=1 makes a desktop browser take every mobile-tier
  // path — the only way Playwright/desktop DevTools can exercise and A/B the
  // phone-only downgrades (lamp budget, beams-off, atlas sizes, shadow sizes).
  let _forceMobile = false;
  try { _forceMobile = localStorage.getItem("spidey.forceMobileTier") === "1"; } catch (_) {}
  const IS_MOBILE = _forceMobile ||
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  // A capable phone can opt into the desktop-quality tier (full DPR + MSAA +
  // full-res atlases + 2048 shadows) via the pause-menu GRAPHICS: HIGH setting.
  // Default OFF — the safe tier is what keeps memory-limited devices alive.
  let _gfxHigh = false;
  try { _gfxHigh = localStorage.getItem("spidey.gfxHigh") === "1"; } catch (_) {}
  // MOBILE TIER = a phone NOT opted into high quality. All the memory downgrades
  // key off this, so HIGH restores full quality (a reload re-runs init with it).
  const MOBILE_TIER = IS_MOBILE && !_gfxHigh;
  let _ctxLost = false;   // true between webglcontextlost and the reload on restore

  // ── GPU frame timer (opt-in via gpuTimer(true); __apex.gpuTimer()) ──
  // EXT_disjoint_timer_query_webgl2 measures GPU-side frame cost — the thing a
  // CPU flame chart (perf-profile skill) literally can't see, and the number the
  // "are night-track spikes GPU-bound?" / WebGL2-vs-WebGPU question turns on.
  // Results are async (ready a few frames after endQuery), so we keep a small
  // ring of queries and only read one whose result is available. No-op (and
  // gpuMs() returns -1) when the extension is missing — notably iOS Safari,
  // where it's unreliable/absent, so this is a Chrome/Android profiling aid.
  let _gpuTimerExt = null, _gpuTimerOn = false, _gpuQPending = [], _gpuMs = -1;
  let _anisoExt = null, _anisoMax = 0;   // EXT_texture_filter_anisotropic (capped 4×)
  let _gpuQActive = null;   // query open between begin() and present() this frame
  let litProg = null, litU = null;
  // Identity model matrix for instanced draws: the transform lives in the
  // per-instance columns, so uModel is unused on that path.
  const IDENT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  // Baked PBR material arrays (js/render/assets.js). Layer index == MAT id, so
  // the shader indexes them with the per-vertex material id it already carries.
  // Null until a pack is loaded — a pack ships in assets/pack and loads at boot
  // (matTexMix def 1.0), but load is async and can fail, so every path below
  // has to survive them staying null and degrade to the procedural look.
  let matAlbedoTex = null, matNormalTex = null, matDummyArrTex = null;
  const MAT_TEX_LAYERS = 17;                                 // MAT.FLAT(0) … MAT.ASPHALT(16)
  const matTexScales = new Float32Array(MAT_TEX_LAYERS);     // world metres per tile; 0 = absent
  // Scratch vec3s for the tuner's ambient multiplier (no per-frame allocation).
  const _ambScratchG = [0, 0, 0], _ambScratchS = [0, 0, 0];
  let skyProg = null, skyU = null;
  let shadowProg = null, shadowU = null;
  let markProg = null, markU = null;
  let markBatchProg = null, markBatchU = null, markBatchVAO = null, markBatchVBO = null;
  let glowProg = null, glowU = null, glowVAO = null, glowVBO = null;
  let glowData = null;   // CPU-side dynamic vertex buffer for light-glow billboards
  let particleProg = null, particleU = null, particleVAO = null, particleVBO = null;
  let skyVAO = null;     // empty VAO (WebGL2 still needs one bound)
  let shadowVAO = null;
  let width = 0, height = 0, aspect = 1;
  // ── Live environment probe ──────────────────────────────────────────────────
  // A small cubemap rendered around the player car (one face per frame — full
  // refresh every 6 frames) that the car-paint clearcoat samples for REAL
  // reflections of the surrounding world. 64px RGBA8 faces + mips: reflections
  // are blurred by paint roughness anyway, so tiny faces read perfectly.
  const ENV_SIZE = 64;
  let envTex = null, envFBO = null, envDepthRB = null, envDummyTex = null;
  let envFacesMask = 0, envReady = false, _envActive = false;
  const _envView = new Float32Array(16), _envProj = new Float32Array(16),
        _envVP = new Float32Array(16), _envInvVP = new Float32Array(16),
        _envTgt = [0, 0, 0];
  // Cubemap face orientations (forward, up) — WebGL cube-face convention.
  const ENV_FACES = [
    [[ 1, 0, 0], [0, -1, 0]], [[-1, 0, 0], [0, -1, 0]],
    [[ 0, 1, 0], [0, 0,  1]], [[ 0, -1, 0], [0, 0, -1]],
    [[ 0, 0, 1], [0, -1, 0]], [[ 0, 0, -1], [0, -1, 0]],
  ];
  let frameViewProj = null;
  let frameSunDir = null;
  let frameEye = null;
  let frameCullDist = 0;   // >0: radial draw-distance cap for chunked scenery (mobile free-cam) — bounds chunk count when the far plane is pushed out
  let frameLights = null;
  let frameGroundMist = 0;
  // Point-light upload scratch (lit program). Sized for MAX_LIGHTS (32) and
  // reused every frame — .subarray(0, nL*stride) is uploaded to avoid per-frame
  // typed-array allocs (GC jitter on dense night grids). Mirrors the _gr*
  // god-ray scratch, which moved to js/render/glx/post.js with present().
  const _luPos = new Float32Array(32 * 3), _luCol = new Float32Array(32 * 3),
        _luRad = new Float32Array(32), _luDir = new Float32Array(32 * 3),
        _luCone = new Float32Array(32 * 2), _luBleed = new Float32Array(32);
  let frameInvProj = null;
  let frameInvVP = null;
  let frameProj = null;
  let frameSunVS = null;
  let frameUpVS = null;
  let frameSkyHi = null;
  let frameSkyLo = null;
  let frameSunColor = null;
  let frameDecalSun = null;   // keyMul-scaled sun for the decal pass (raw frameSunColor feeds god rays)
  const _decalSunScr = [0, 0, 0];
  let frameAmbSky = [0.3, 0.32, 0.36], frameAmbGround = [0.2, 0.19, 0.18];   // for decal lighting
  let decalProg = null, decalU = null;   // textured car-decal (logo/sponsor) pass
  let frameTime = 0, frameCloud = 0, frameCloudSpeed = 1;

  // The split renderer subsystems (js/render/glx/{post,shadow,chunked}.js),
  // wired at init() through the GLXCore ctx built there. PST = post chain,
  // SHD = shadow maps (sun/car/lamp + PCSS blocker), CHK = chunked meshes.
  let core = null, PST = null, SHD = null, CHK = null;


  // Material uniform cache — skip redundant per-draw scalar uploads.
  let _matEmissive = -1, _matAlpha = -1, _matRough = -1, _matMetal = -1, _matSpec = -1, _matDetail = -1, _matCC = -1, _matCP = -1, _matSpark = -1;

  // Active-program cache — gl.useProgram is a pipeline-flushing state change, so
  // skip it when the requested program is already bound. Route every bind here.
  let _activeProg = null;
  function useProg(p) { if (p !== _activeProg) { gl.useProgram(p); _activeProg = p; } }

  // Per-frame view-projection upload cache for the blob-shadow / skid-mark
  // programs. uViewProj never changes within a frame, but drawShadow/drawMark are
  // called dozens of times per frame (one per skid stamp / car shadow), each
  // re-uploading the same 16-float matrix. Track which program last received the
  // frame's matrix so the upload happens at most once per program per frame.
  let _frameToken = 0;
  let _shadowVPToken = -1, _markVPToken = -1;

  // VAO bind cache — drawElements requires the right VAO, but consecutive draws
  // of the same mesh (or repeated skid/shadow quads sharing shadowVAO) would
  // otherwise rebind redundantly. Binding null after every draw also forces a
  // rebind on the next; instead leave the last VAO bound and skip no-op binds.
  let _activeVAO = null;
  function bindVAO(v) { if (v !== _activeVAO) { gl.bindVertexArray(v); _activeVAO = v; } }

  // Render-state cache — enable/disable(BLEND) and depthMask are pipeline state
  // changes. Many consecutive draws share the same state (e.g. dozens of skid
  // marks and car shadows per frame), so collapse redundant toggles into no-ops.
  // begin() resyncs these to GL defaults each frame; present() restores them.
  let _blendOn = false, _depthWrite = true;
  function setBlend(on) {
    if (on !== _blendOn) { if (on) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); _blendOn = on; }
  }
  function setDepthMask(on) {
    if (on !== _depthWrite) { gl.depthMask(on); _depthWrite = on; }
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      Log.error("gfx", "GLX shader compile failed:\n" + gl.getShaderInfoLog(sh) + "\n" + src);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function link(vsSrc, fsSrc) {
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      Log.error("gfx", "GLX program link failed: " + gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  function locs(prog, names) {
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return u;
  }


  function init(canvasEl) {
    canvas = canvasEl;
    watchCanvasSize();
    gl = canvas.getContext("webgl2", {
      // antialias:true makes the BROWSER allocate its own multisampled backbuffer
      // (Apple GPUs round the request up to 4×) — pure waste on the post path,
      // which renders offscreen and only blits a resolved image to the screen.
      // On the memory-tight mobile tier that's ~40-50 MB of IOSurface for nothing.
      antialias: !IS_MOBILE,   // phones never take the context-level AA path (see GRAPHICS: HIGH note in shadow.js)
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) return false;

    // GPU timer extension (Chrome/Android; absent on iOS Safari). Acquired once;
    // actual querying is gated behind gpuTimer(true).
    try { _gpuTimerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2"); } catch (_) { _gpuTimerExt = null; }

    // Anisotropic filtering (ubiquitous, but still an extension in WebGL2).
    // Applied at a modest 4× to the mippy content textures (decal atlases,
    // env cube) so decals stay legible at grazing angles instead of smearing
    // into the LINEAR_MIPMAP_LINEAR blur. Query once; 0 = unavailable.
    try {
      _anisoExt = gl.getExtension("EXT_texture_filter_anisotropic")
               || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
      _anisoMax = _anisoExt
        ? Math.min(4, gl.getParameter(_anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 0) : 0;
    } catch (_) { _anisoExt = null; _anisoMax = 0; }

    // WebGL context-loss recovery. Mobile tile GPUs can drop the context under
    // memory pressure (the per-frame env-probe cube adds load). Without a handler
    // the loss is permanent and later gl calls cascade into errors. preventDefault
    // lets the GPU restore; on restore we reload to cleanly rebuild every GL
    // resource (programs, FBOs, textures, meshes) rather than track them all.
    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault(); _ctxLost = true;
      // Only downgrade quality on a loss that happened while VISIBLE — that's the
      // memory-pressure signal. iOS also drops the context on backgrounding
      // (document.hidden), a benign transient loss that shouldn't permanently
      // disable the env probe. Persisting the opt-out otherwise stops a
      // lose→reload→lose loop on genuinely memory-tight devices.
      if (!document.hidden) { try { localStorage.setItem("spidey.envProbeOff", "1"); } catch (_) {} }
    }, false);
    canvas.addEventListener("webglcontextrestored", function () { try { location.reload(); } catch (_) {} }, false);

    litProg = link(LIT_VS, LIT_FS);
    skyProg = link(SKY_VS, SKY_FS);
    shadowProg = link(SHADOW_VS, SHADOW_FS);
    markProg = link(SHADOW_VS, MARK_FS);
    markBatchProg = link(MARK_BATCH_VS, MARK_FS);
    glowProg = link(GLOW_VS, GLOW_FS);
    particleProg = link(PARTICLE_VS, PARTICLE_FS);
    decalProg = link(DECAL_VS, DECAL_FS);
    decalU = decalProg && locs(decalProg, ["uModel", "uViewProj", "uSunDir", "uSunColor", "uAmbSky", "uAmbGround", "uGlow", "uTex"]);
    if (!litProg || !skyProg || !shadowProg || !markProg) return false;

    // ── GLXCore: the ctx façade handed to the split subsystem modules
    // (js/render/glx/{post,shadow,chunked}.js). Live getters close over this
    // file's per-frame state; the helpers are the same shared GL-state-cache
    // functions the rest of this file uses, so the subsystems never fight the
    // caches. core.post / core.shadow are filled in right after each init so
    // the subsystems can reach each other at call time.
    core = {
      gl,
      MOBILE_TIER,
      IS_MOBILE,
      useProg, bindVAO, setBlend, setDepthMask,
      compile, link, locs,
      toF32, createMesh, litMaterial,
      getSize: () => ({ width, height }),
      gpuTimerEnd: _gpuTimerEnd,
      get skyVAO() { return skyVAO; },
      invalidateVAO() { _activeVAO = null; },
      unbindVAOIf(v) { if (_activeVAO === v) { gl.bindVertexArray(null); _activeVAO = null; } },
      frame: {
        get viewProj() { return frameViewProj; },
        get sunDir() { return frameSunDir; },
        get sunColor() { return frameSunColor; },
        get eye() { return frameEye; },
        get cullDist() { return frameCullDist; },
        get invProj() { return frameInvProj; },
        get invVP() { return frameInvVP; },
        get proj() { return frameProj; },
        get sunVS() { return frameSunVS; },
        get upVS() { return frameUpVS; },
        get skyHi() { return frameSkyHi; },
        get skyLo() { return frameSkyLo; },
        get lights() { return frameLights; },
        get time() { return frameTime; },
        get cloud() { return frameCloud; },
        get cloudSpeed() { return frameCloudSpeed; },
      },
      post: null, shadow: null,
    };
    PST = GLXPost.init(core);   core.post = PST;    // post chain (best-effort; disabled -> render straight to screen)
    SHD = GLXShadow.init(core); core.shadow = SHD;  // sun/car/lamp shadow maps + PCSS blocker
    CHK = GLXChunked.init(core);                    // frustum-culled chunked city/props meshes

    // The per-instance colour attribute is multiplied into vCol on EVERY lit
    // draw, so its generic value must be the identity or ordinary meshes — which
    // never bind attribute 9 — render black. WebGL's default generic value is
    // (0,0,0,1), which is exactly that failure: it crushed ~25% of the frame to
    // black and only the sky survived. Generic attribute values are CONTEXT
    // state, not VAO state, so setting it once here covers every mesh.
    gl.vertexAttrib3f(9, 1, 1, 1);
    litU = locs(litProg, ["uModel", "uInstanced", "uViewProj", "uEye", "uSunDir", "uSunColor",
      "uAmbGround", "uAmbSky", "uFogColor", "uFogDensity", "uEmissive", "uAlpha",
      "uRoughness", "uMetalness", "uSpecular", "uDetail", "uClearcoat", "uCarPaint", "uSparkle", "uWetness", "uEnvCube", "uEnvStr",
      "uShadowMap", "uLightVP", "uShadowBias", "uShadowStr", "uShadowTexel", "uShadowRange", "uShadowCtr",
      "uCarShadowMap", "uCarLightVP", "uCarShadowOn",
      "uLampShadowMap", "uLampShadowVP", "uLampShadowOn", "uLampShadowIdx",
      "uSkyZenith", "uSkyHorizon", "uFogHeight", "uGroundMist", "uLampFog", "uBlockerMap", "uPcss", "uTime", "uCloudCover", "uCloudSpeed", "uCloudShadowDim",
      "uBounceK", "uMistShare", "uLampFogClip", "uGlowAmp", "uBloomBoost", "uPcssPen", "uKeyMul",
      "uFogTint", "uMistHeight", "uShadowTintAmt", "uWetDark",
      "uCarSunGlint", "uCarSparkle", "uFogSunCore",
      "uLampNearClamp", "uWindowSunFlash", "uSkyRimGlow", "uAmbContactDark", "uLampWallSpill",
      "uMatAlbedoTex", "uMatNormalTex", "uMatTexMix", "uMatTexScale[0]",
      "uNumLights", "uLightPos[0]", "uLightCol[0]", "uLightRad[0]", "uLightDir[0]", "uLightCone[0]", "uLightBleed[0]"]);
    skyU = locs(skyProg, ["uInvViewProj", "uZenith", "uHorizon", "uSunDir", "uSunColor", "uStars", "uCloud", "uTime", "uMoon", "uCityGlow", "uStarBright", "uCloudSpeed", "uSkyGrad", "uStarDensity", "uDaySkyBlue", "uMieScatter", "uCloudSilver", "uCoronaAureole", "uSunDiscSize", "uStarSize", "uStarTwinkle", "uMoonDiscSize", "uMoonHalo", "uSunCorona", "uSunSquash", "uCityGlowReach", "uCloudDef", "uLightning"]);
    shadowU = locs(shadowProg, ["uModel", "uViewProj", "uSize"]);
    markU = locs(markProg, ["uModel", "uViewProj", "uSize"]);
    if (markBatchProg) {
      markBatchU = locs(markBatchProg, ["uViewProj"]);
      // Dynamic interleaved buffer: [posX, posY, posZ, uvX, uvY] per vertex.
      markBatchVAO = gl.createVertexArray();
      gl.bindVertexArray(markBatchVAO);
      markBatchVBO = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, markBatchVBO);
      const mst = 5 * 4;   // 5 floats per vertex
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, mst, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, mst, 12);
      gl.bindVertexArray(null);
    }
    if (glowProg) {
      glowU = locs(glowProg, ["uViewProj", "uEye", "uStr"]);
      // Dynamic interleaved buffer: [cornerX, cornerY, cx, cy, cz, r, g, b, radius] ×6 verts/lamp.
      glowVAO = gl.createVertexArray();
      gl.bindVertexArray(glowVAO);
      glowVBO = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glowVBO);
      const st = 9 * 4;   // 9 floats per vertex
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, st, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, st, 20);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, st, 32);
      gl.bindVertexArray(null);
    }
    if (particleProg) {
      particleU = locs(particleProg, ["uViewProj", "uEye", "uAdditive"]);
      // Dynamic interleaved buffer: [cornerX, cornerY, cx, cy, cz, r, g, b,
      // size, alpha] ×6 verts/particle (filled by js/game/particles.js).
      particleVAO = gl.createVertexArray();
      gl.bindVertexArray(particleVAO);
      particleVBO = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, particleVBO);
      const pst = 10 * 4;   // 10 floats per vertex
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, pst, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, pst, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, pst, 20);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, pst, 32);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, pst, 36);
      gl.bindVertexArray(null);
    }

    skyVAO = gl.createVertexArray();

    // Cached unit quad for blob shadows (xz plane, CCW seen from +Y).
    shadowVAO = gl.createVertexArray();
    gl.bindVertexArray(shadowVAO);
    const qv = new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5]);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, qv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const qi = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, qi);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    resize();
    return true;
  }

  // Adaptive render scale: the whole 3D pipeline (scene + every post FBO) sizes
  // off width/height, and the canvas CSS size is fixed — so scaling the backing
  // store down and letting the browser upscale is a single knob that trades
  // sharpness for fill-rate. The HUD is a DOM overlay, so only the 3D view
  // softens. setRenderScale() drives it from the frame-time governor in game.js.
  let renderScale = 1;
  // CACHED CSS SIZE. resize() is the first statement of every render() — and
  // clientWidth/clientHeight are LAYOUT reads, so asking for them there forces a
  // synchronous reflow of anything dirtied since the last frame. The HUD dirties
  // layout constantly (textContent, style and classList writes, plus a dataset
  // write on documentElement), so the frame loop was paying a forced reflow every
  // time the 10 Hz HUD tick, an announce, or a lights change landed. The CSS box
  // only changes on a viewport/orientation change or a rotation of the device, so
  // read it when the browser tells us it moved and cache it in between.
  let cssW = 0, cssH = 0, cssDirty = true;
  const markCssDirty = () => { cssDirty = true; };
  // Wired from init(), NOT at IIFE eval: `canvas` is still null up here, so an
  // observer attached at module scope would silently observe nothing.
  function watchCanvasSize() {
    if (typeof window === "undefined" || !window.addEventListener) return;
    window.addEventListener("resize", markCssDirty);
    window.addEventListener("orientationchange", markCssDirty);
    // Covers what a window resize never fires for: a layout change that moves
    // the canvas alone (entering photo mode, a rotated phone that keeps the same
    // window size). Feature-detected — without it the two listeners above still
    // cover the common cases, and cssSize()'s zero-guard covers first layout.
    if (typeof ResizeObserver === "function" && canvas) {
      try { new ResizeObserver(markCssDirty).observe(canvas); } catch (_) {}
    }
  }
  function cssSize() {
    // A zero is never a real size — it means the canvas has not been laid out
    // yet (init before first layout, a display:none ancestor). Keep re-reading
    // until it is real, so this can't latch a 1x1 backbuffer the way a plain
    // cache would; the old read-every-frame code self-corrected for free.
    if (cssDirty || cssW <= 0 || cssH <= 0) {
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
      cssDirty = false;
    }
  }
  function resize() {
    // Mobile: cap DPR at 1.5 (was 2) — every full-screen target scales with the
    // square of this; 1.5 is 56% of the pixels of 2 with little visible loss on
    // a ~6" screen, and it multiplies with every other saving.
    const dpr = Math.min(window.devicePixelRatio || 1, MOBILE_TIER ? 1.5 : 2);
    cssSize();
    const w = Math.max(1, Math.round(cssW * dpr * renderScale));
    const h = Math.max(1, Math.round(cssH * dpr * renderScale));
    const changed = canvas.width !== w || canvas.height !== h;
    if (changed) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    const first = width === 0;
    width = w;
    height = h;
    aspect = w / h;
    if ((changed || first) && PST) PST.createTargets();   // (re)allocate HDR + bloom targets
  }
  function setRenderScale(s) {
    s = Math.max(0.5, Math.min(1, s));
    if (Math.abs(s - renderScale) < 0.02) return false;
    renderScale = s;
    resize();
    return true;
  }
  function getRenderScale() { return renderScale; }

  function toF32(a) {
    return a instanceof Float32Array ? a : new Float32Array(a);
  }

  function createMesh(data) {
    const pos = toF32(data.pos);
    const nrm = toF32(data.nrm);
    const col = toF32(data.col);
    let idx = data.idx;
    const vCount = pos.length / 3;
    const big = vCount > 65535;
    if (idx instanceof Uint16Array || idx instanceof Uint32Array) {
      if (big && idx instanceof Uint16Array) idx = new Uint32Array(idx);
    } else {
      idx = big ? new Uint32Array(idx) : new Uint16Array(idx);
    }

    // Interleaved: [x,y,z, nx,ny,nz, r,g,b (, mat) (, s,x,hw)] per vertex — one
    // buffer. Optional per-vertex material id (data.mat) adds a 10th float
    // (attrib 3); meshes without it stay 9-float and aMat reads the generic
    // default (0=FLAT). Optional track coords (data.trk: arc-length s, signed
    // lateral offset, half-width — 3 floats, attrib 4) let the ROAD evaluate its
    // markings analytically in the fragment shader instead of carrying a vertex
    // column per painted line. Meshes without it read (0,0,0), and the shader
    // gates on hw > 0 so nothing else can accidentally paint lines on itself.
    const mat = data.mat && data.mat.length === vCount ? toF32(data.mat) : null;
    const trk = data.trk && data.trk.length === vCount * 3 ? toF32(data.trk) : null;
    const fpv = 9 + (mat ? 1 : 0) + (trk ? 3 : 0);
    const trkOff = 9 + (mat ? 1 : 0);
    const interleaved = new Float32Array(vCount * fpv);
    for (let i = 0; i < vCount; i++) {
      const o = i * fpv;
      interleaved[o  ] = pos[i*3  ]; interleaved[o+1] = pos[i*3+1]; interleaved[o+2] = pos[i*3+2];
      interleaved[o+3] = nrm[i*3  ]; interleaved[o+4] = nrm[i*3+1]; interleaved[o+5] = nrm[i*3+2];
      interleaved[o+6] = col[i*3  ]; interleaved[o+7] = col[i*3+1]; interleaved[o+8] = col[i*3+2];
      if (mat) interleaved[o+9] = mat[i];
      if (trk) {
        interleaved[o+trkOff  ] = trk[i*3  ];
        interleaved[o+trkOff+1] = trk[i*3+1];
        interleaved[o+trkOff+2] = trk[i*3+2];
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const stride = fpv * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride,  0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    if (mat) { gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36); }
    if (trk) { gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride, trkOff * 4); }
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    _activeVAO = null;   // keep the bind cache in sync with the direct bind above

    return { vao, vbo, ib, count: idx.length, indexType: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  // Textured decal mesh: interleaved [x,y,z, nx,ny,nz, u,v], stride 32 (no colour).
  function createTexMesh(data) {
    const pos = toF32(data.pos), nrm = toF32(data.nrm), uv = toF32(data.uv);
    const vCount = pos.length / 3;
    const big = vCount > 65535;
    let idx = data.idx;
    idx = (idx instanceof Uint16Array || idx instanceof Uint32Array)
      ? (big && idx instanceof Uint16Array ? new Uint32Array(idx) : idx)
      : (big ? new Uint32Array(idx) : new Uint16Array(idx));
    const inter = new Float32Array(vCount * 8);
    for (let i = 0; i < vCount; i++) {
      inter[i*8  ] = pos[i*3  ]; inter[i*8+1] = pos[i*3+1]; inter[i*8+2] = pos[i*3+2];
      inter[i*8+3] = nrm[i*3  ]; inter[i*8+4] = nrm[i*3+1]; inter[i*8+5] = nrm[i*3+2];
      inter[i*8+6] = uv[i*2  ];  inter[i*8+7] = uv[i*2+1];
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
    const stride = 32;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride,  0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    _activeVAO = null;
    return { vao, vbo, ib, count: idx.length, indexType: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }
  // Upload a canvas / ImageBitmap / ImageData as an RGBA texture (mipmapped, clamped).
  function createTexture(src) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 4× anisotropy: decal atlases are read at grazing angles on the bodywork —
    // trilinear alone smears the sponsors/numbers into mip blur there.
    if (_anisoMax > 1) gl.texParameterf(gl.TEXTURE_2D, _anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, _anisoMax);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }
  function freeTexture(t) { if (t) gl.deleteTexture(t); }

  // ── Baked PBR material texture arrays ──────────────────────────────────────
  // One TEXTURE_2D_ARRAY whose LAYER INDEX IS THE MAT ID, so the lit shader can
  // texture every surface in the game from the per-vertex material id it already
  // carries — no UV channel, no new vertex attribute, no per-material draw call.
  //
  // `images` is a sparse array indexed by MAT id (holes = that material has no
  // baked map and keeps its procedural look). Every image must already be
  // size×size; the caller (js/render/assets.js) guarantees that from the pack
  // manifest. Returns null rather than throwing on any failure — a missing or
  // malformed pack must degrade to the shipping look, never break the render.
  function createTextureArray(size, images, layers) {
    if (!size || !images) return null;
    const n = layers || MAT_TEX_LAYERS;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    // texStorage3D allocates the whole mip chain immutably up front — required
    // for an array texture whose layers arrive one at a time, and it means a
    // layer we never fill is well-defined (zero) rather than undefined memory.
    const mips = Math.floor(Math.log2(size)) + 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mips, gl.RGBA8, size, size, n);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let filled = 0;
    for (let i = 0; i < n; i++) {
      const img = images[i];
      if (!img) continue;
      try {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
        filled++;
      } catch (_) { /* one bad layer must not sink the pack */ }
    }
    if (!filled) { gl.deleteTexture(tex); gl.bindTexture(gl.TEXTURE_2D_ARRAY, null); return null; }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // REPEAT, unlike createTexture's CLAMP_TO_EDGE: these tile across a whole
    // circuit's worth of world-space triplanar coordinate.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // The road is the grazing-angle surface these exist for — trilinear alone
    // smears tarmac aggregate into mip mush ~20 m ahead of the car.
    if (_anisoMax > 1) gl.texParameterf(gl.TEXTURE_2D_ARRAY, _anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, _anisoMax);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return tex;
  }

  // Adopt (or clear, with a falsy argument) the baked material maps. Frees any
  // previously-bound arrays so a pack swap — tier change, test teardown — can't
  // leak GPU memory.
  function setMaterialMaps(maps) {
    if (matAlbedoTex) { gl.deleteTexture(matAlbedoTex); matAlbedoTex = null; }
    if (matNormalTex) { gl.deleteTexture(matNormalTex); matNormalTex = null; }
    matTexScales.fill(0);
    if (!maps) return;
    matAlbedoTex = maps.albedo || null;
    matNormalTex = maps.normal || null;
    const sc = maps.scales;
    if (sc) for (let i = 0; i < MAT_TEX_LAYERS; i++) matTexScales[i] = +sc[i] > 0 ? +sc[i] : 0;
    // No albedo array means no baked material at all: zero every scale so the
    // shader's per-layer `scale <= 0` test short-circuits before it samples.
    if (!matAlbedoTex) matTexScales.fill(0);
  }

  // 1×1×1 dummy array — a COMPLETE sampler2DArray target for both material
  // units whenever no pack is loaded. Same reasoning as ensureEnvDummy(): a
  // sampler pointing at an incomplete texture unit is undefined behaviour and
  // renders black on strict drivers (SwiftShader) even when the shader branch
  // that would sample it is never taken.
  function ensureMatDummy() {
    if (matDummyArrTex) return;
    matDummyArrTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, matDummyArrTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
                     new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  // Per-frame material-map binding. Units 10/11 are free — the lit pass holds 0
  // (shadow), 5 (decal), 6, 7 (PCSS blocker), 8 (car shadow), 9 (lamp shadow).
  function bindMaterialMaps(mix) {
    ensureMatDummy();
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, matAlbedoTex || matDummyArrTex);
    gl.uniform1i(litU.uMatAlbedoTex, 10);
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, matNormalTex || matAlbedoTex || matDummyArrTex);
    gl.uniform1i(litU.uMatNormalTex, 11);
    gl.activeTexture(gl.TEXTURE0);      // leave unit 0 active + bound to the shadow map
    gl.uniform1f(litU.uMatTexMix, matAlbedoTex ? mix : 0);
    if (litU["uMatTexScale[0]"]) gl.uniform1fv(litU["uMatTexScale[0]"], matTexScales);
  }
  // Draw textured decals over the just-drawn car body: depth test ON, depth write
  // OFF (decals are proud of the panel so they never z-fight), alpha-blended, and
  // the alpha channel is NOT written (the car's SSR paint tag underneath survives).
  let _decalVPToken = -1;
  function drawDecal(mesh, modelMat, tex, opts) {
    if (!decalProg || !mesh || !tex) return;
    useProg(decalProg);
    gl.uniformMatrix4fv(decalU.uModel, false, modelMat);
    // Frame-constant uniforms once per frame (same token pattern as
    // drawShadow/drawMark) — this runs once per car livery, ~22x/frame.
    if (_decalVPToken !== _frameToken) {
      _decalVPToken = _frameToken;
      gl.uniformMatrix4fv(decalU.uViewProj, false, frameViewProj);
      gl.uniform3fv(decalU.uSunDir, frameSunDir);
      gl.uniform3fv(decalU.uSunColor, frameDecalSun || frameSunColor);
      gl.uniform3fv(decalU.uAmbSky, frameAmbSky);
      gl.uniform3fv(decalU.uAmbGround, frameAmbGround);
    }
    gl.uniform1f(decalU.uGlow, (opts && opts.glow) || 0);
    // Bind the decal texture to a SPARE unit (5), NOT unit 0 — the lit pass keeps
    // the shadow map bound to TEXTURE0 for the whole frame, so clobbering unit 0
    // here would make every later lit draw (e.g. the player's wheels, drawn right
    // after these decals) sample this RGBA image as the shadow map → broken/black.
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(decalU.uTex, 5);
    gl.activeTexture(gl.TEXTURE0);   // leave unit 0 active + still bound to the shadow map
    setBlend(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    setDepthMask(false);
    gl.disable(gl.CULL_FACE);                 // decals are single quads — draw both faces
    gl.colorMask(true, true, true, false);    // keep the SSR alpha tag underneath
    bindVAO(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.CULL_FACE);
    setDepthMask(true);
  }

  // 1px black dummy cube — a COMPLETE samplerCube target for the env unit
  // whenever the real probe isn't live (menu / setup viewer / probe-less tools)
  // OR while rendering INTO the real cube (feedback-loop guard). Minted on demand
  // so the probe-less path never leaves uEnvCube pointing at an incomplete unit
  // (which renders the whole car black on strict drivers like SwiftShader).
  function ensureEnvDummy() {
    if (envDummyTex) return;
    envDummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envDummyTex);
    for (let f = 0; f < 6; f++)
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  function envInit() {
    // HDR cube (RGBA16F) when float buffers are renderable — so emissive light
    // sources (neon, lit windows, floodlights, the sun) keep their >1 brightness
    // in the reflection and bloom on the paint, like the wet road's SSR. Falls
    // back to 8-bit (LDR, lights clamp to white) where float isn't renderable.
    const envInternal = PST.hdrOk() ? gl.RGBA16F : gl.RGBA8;
    const envType = PST.hdrOk() ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    envTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);
    for (let f = 0; f < 6; f++)
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, envInternal, ENV_SIZE, ENV_SIZE, 0, gl.RGBA, envType, null);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 4× anisotropy on the env cube: the clearcoat mirror samples it along
    // grazing reflection rays where plain trilinear over-blurs.
    if (_anisoMax > 1) gl.texParameterf(gl.TEXTURE_CUBE_MAP, _anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, _anisoMax);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);   // texture-complete (black) from frame 0
    ensureEnvDummy();
    envDepthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, envDepthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, ENV_SIZE, ENV_SIZE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    envFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, envFBO);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, envDepthRB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // Render one probe face: caller re-issues the world draws (sky + track meshes,
  // no cars) between envFaceBegin and envFaceEnd. Reuses begin() with the face's
  // camera so every lighting uniform (sun, shadow map, ambient, fog, tune)
  // matches the main frame exactly. Returns the face's invViewProj for drawSky.
  function envFaceBegin(face, eye, frame) {
    if (!gl || _ctxLost || (gl.isContextLost && gl.isContextLost())) return null;
    if (!envTex) envInit();
    _envActive = true;   // begin() → env FBO + 64px viewport; env unit → dummy cube
    const F = ENV_FACES[face];
    _envTgt[0] = eye[0] + F[0][0]; _envTgt[1] = eye[1] + F[0][1]; _envTgt[2] = eye[2] + F[0][2];
    M4.lookAtTo(_envView, eye, _envTgt, F[1]);
    M4.perspectiveTo(_envProj, Math.PI / 2, 1, 0.4, 900);
    M4.mulTo(_envVP, _envProj, _envView);
    M4.invertTo(_envInvVP, _envVP);
    gl.bindFramebuffer(gl.FRAMEBUFFER, envFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, envTex, 0);
    const svVP = frame.viewProj, svEye = frame.eye;
    frame.viewProj = _envVP; frame.eye = eye;
    begin(frame);
    frame.viewProj = svVP; frame.eye = svEye;
    return _envInvVP;
  }
  function envFaceEnd(face) {
    if (!gl || !envTex) return;
    _envActive = false;
    envFacesMask |= 1 << face;
    // Unbind the probe FBO FIRST. generateMipmap below must NOT run while envTex
    // is still the COLOR_ATTACHMENT0 of the bound framebuffer — that read/write
    // feedback is GL_INVALID_OPERATION (or a context loss) on strict/mobile
    // drivers, though SwiftShader silently tolerates it. Detaching + unbinding
    // before the mip pass removes the hazard.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);  // restore for the (non-post) main pass
    if (envFacesMask === 63) {         // full cycle → refresh mips, probe is live
      envFacesMask = 0; envReady = true;
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  // Open a GPU timer query for this frame (if timing is on and none is already
  // open). Called from begin(); the matching endQuery is in present().
  function _gpuTimerBegin() {
    if (!_gpuTimerOn || !_gpuTimerExt || _gpuQActive) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(_gpuTimerExt.TIME_ELAPSED_EXT, q);
    _gpuQActive = q;
  }

  // Close the frame's query and harvest any completed result. GPU_DISJOINT means
  // the GPU was interrupted (e.g. power-state change) and every in-flight timing
  // is invalid — drop them. Keeps at most a few queries in flight.
  // NOTE the _gpuTimerOn gate. The extension is acquired unconditionally at
  // context creation, so without it the gl.getParameter below ran at the END OF
  // EVERY FRAME on every device that has EXT_disjoint_timer_query_webgl2 (i.e.
  // all of Chrome desktop + Android) for a feature that ships off. getParameter
  // with an uncached pname is a synchronous round trip to the GPU process — a
  // command-buffer flush plus blocking IPC — so this was a per-frame pipeline
  // stall, worst exactly when the GPU process is already backed up. _gpuTimerBegin
  // has always had this guard; this one did not.
  function _gpuTimerEnd() {
    if (!_gpuTimerExt) return;
    // Timing just switched off: close and drain what is still in flight, then
    // stop touching the GPU until it is switched back on.
    if (!_gpuTimerOn && !_gpuQActive && !_gpuQPending.length) return;
    if (_gpuQActive) {
      gl.endQuery(_gpuTimerExt.TIME_ELAPSED_EXT);
      _gpuQPending.push(_gpuQActive);
      _gpuQActive = null;
    }
    const disjoint = gl.getParameter(_gpuTimerExt.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (let i = 0; i < _gpuQPending.length; i++) gl.deleteQuery(_gpuQPending[i]);
      _gpuQPending.length = 0;
      return;
    }
    while (_gpuQPending.length) {
      const q = _gpuQPending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      _gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;   // ns → ms
      gl.deleteQuery(q);
      _gpuQPending.shift();
    }
    // Backstop: never let the ring grow unbounded if results stall.
    while (_gpuQPending.length > 4) { gl.deleteQuery(_gpuQPending.shift()); }
  }

  function begin(frame) {
    if (_ctxLost || (gl && gl.isContextLost && gl.isContextLost())) return false;
    _gpuTimerBegin();
    frameViewProj = frame.viewProj;
    frameSunDir = frame.sunDir;
    frameSunColor = frame.sunColor;
    frameEye = frame.eye;
    frameCullDist = frame.cullDist || 0;
    frameInvProj = frame.invProj || null;
    frameInvVP = frame.invViewProj || null;
    frameProj = frame.proj || null;
    frameSunVS = frame.sunViewDir || null;
    frameUpVS = frame.upViewDir || null;
    frameSkyHi = frame.skyHorizon || [0.05, 0.06, 0.09];
    frameSkyLo = frame.skyZenith || [0.02, 0.025, 0.05];
    frameAmbSky = frame.ambientSky || [0.3, 0.32, 0.36];
    frameAmbGround = frame.ambientGround || [0.2, 0.19, 0.18];
    frameTime = frame.time != null ? frame.time : 0;
    frameCloud = frame.cloud != null ? frame.cloud : 0;
    frameCloudSpeed = frame.cloudSpeed != null ? frame.cloudSpeed : 1;
    frameLights = frame.lights || null;
    frameGroundMist = frame.groundMist != null ? frame.groundMist : 0;
    _frameToken++;   // invalidate per-frame uViewProj upload caches
    // Render the scene into the HDR offscreen target when post is enabled, else
    // straight to the default framebuffer. With MSAA the geometry goes into the
    // multisampled renderbuffer, resolved into sceneTex/sceneDepth at present().
    // An env-probe face (envFaceBegin) instead targets the probe cubemap FBO.
    if (_envActive) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, envFBO);
      gl.viewport(0, 0, ENV_SIZE, ENV_SIZE);
    } else if (PST.enabled()) {
      PST.bindSceneTarget();
    }
    // Resync cached render state to GL defaults — depthMask must be on for the
    // depth buffer to clear, and blend off is the opaque-pass default.
    gl.disable(gl.BLEND); _blendOn = false;
    gl.depthMask(true); _depthWrite = true;
    const fc = frame.fogColor;
    gl.clearColor(fc[0], fc[1], fc[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    useProg(litProg);
    gl.uniformMatrix4fv(litU.uViewProj, false, frame.viewProj);
    gl.uniform3fv(litU.uEye, frame.eye);
    gl.uniform3fv(litU.uSunDir, frame.sunDir);
    gl.uniform3fv(litU.uSunColor, frame.sunColor);
    // Live tunables (LIGHTING TUNER / __apex.lightTune) ride in on frame.tune;
    // defaults here MUST mirror LightTune.TUNE_DEFS (js/game/lighting.js) so a missing tune object
    // (unit harnesses driving GLX directly) renders the shipped look.
    const T = frame.tune || null;
    const _ambM = T && T.ambientMul != null ? T.ambientMul : 1;
    if (_ambM !== 1) {
      const g = frame.ambientGround, s = frame.ambientSky;
      _ambScratchG[0] = g[0] * _ambM; _ambScratchG[1] = g[1] * _ambM; _ambScratchG[2] = g[2] * _ambM;
      _ambScratchS[0] = s[0] * _ambM; _ambScratchS[1] = s[1] * _ambM; _ambScratchS[2] = s[2] * _ambM;
      gl.uniform3fv(litU.uAmbGround, _ambScratchG);
      gl.uniform3fv(litU.uAmbSky, _ambScratchS);
      // The decal pass reads frameAmb* — point it at the SAME scaled ambient the
      // lit pass just uploaded. Decals used the raw frame colours, so moving the
      // AMBIENT slider re-lit the bodywork but not the sponsor marks on it.
      frameAmbSky = _ambScratchS; frameAmbGround = _ambScratchG;
    } else {
      gl.uniform3fv(litU.uAmbGround, frame.ambientGround);
      gl.uniform3fv(litU.uAmbSky, frame.ambientSky);
    }
    // Same for the KEY LIGHT slider on the decals' sun term (raw frameSunColor
    // stays untouched for the god-ray/flare passes, which are not keyMul-lit).
    const _kM = T && T.keyMul != null ? T.keyMul : 1.0;
    if (_kM !== 1 && frameSunColor) {
      _decalSunScr[0] = frameSunColor[0] * _kM;
      _decalSunScr[1] = frameSunColor[1] * _kM;
      _decalSunScr[2] = frameSunColor[2] * _kM;
      frameDecalSun = _decalSunScr;
    } else {
      frameDecalSun = frameSunColor;
    }
    gl.uniform1f(litU.uBounceK,     T && T.bounceK     != null ? T.bounceK     : 0.04);
    gl.uniform1f(litU.uMistShare,   T && T.mistShare   != null ? T.mistShare   : 1.5);
    gl.uniform1f(litU.uLampFogClip, T && T.fogClip     != null ? T.fogClip     : 0.7);
    gl.uniform1f(litU.uGlowAmp,     T && T.glowAmp     != null ? T.glowAmp     : 2.3);
    gl.uniform1f(litU.uBloomBoost,  T && T.neonBoost   != null ? T.neonBoost   : 0.6);
    gl.uniform1f(litU.uPcssPen,     T && T.pcssPen     != null ? T.pcssPen     : 80.0);
    gl.uniform1f(litU.uKeyMul,      T && T.keyMul      != null ? T.keyMul      : 1.0);
    gl.uniform1f(litU.uFogTint,     T && T.fogTint     != null ? T.fogTint     : 0.0);
    gl.uniform1f(litU.uMistHeight,  T && T.mistHeight  != null ? T.mistHeight  : 0.30);
    gl.uniform1f(litU.uShadowTintAmt, T && T.shadowTintAmt != null ? T.shadowTintAmt : 0.0);
    gl.uniform1f(litU.uWetDark,     T && T.wetDark     != null ? T.wetDark     : 1.0);
    // BAKED MATERIALS knob. Ships at 1.0 (mirrors TUNE_DEFS matTexMix def);
    // __apex.matTex(0) is the A/B off-switch back to pure procedural. A missing
    // pack still renders procedural — bindMaterialMaps forces uMatTexMix to 0
    // whenever no albedo array is loaded, whatever the slider says.
    bindMaterialMaps(T && T.matTexMix != null ? T.matTexMix : 1.0);
    gl.uniform3fv(litU.uFogColor, frame.fogColor);
    // FOG DENSITY knob: scale the per-condition haze depth (multiplier, def 1).
    gl.uniform1f(litU.uFogDensity, frame.fogDensity * (T && T.fogDensityMul != null ? T.fogDensityMul : 1));
    if (SHD.enabled) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, SHD.mapTex);
      gl.uniform1i(litU.uShadowMap, 0);
      if (SHD.pcssEnabled) {
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, SHD.blockerTex);
        gl.uniform1i(litU.uBlockerMap, 7);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.uniform1f(litU.uPcss, SHD.pcssEnabled ? 1.0 : 0.0);
      gl.uniformMatrix4fv(litU.uLightVP, false, SHD.lightVP);
      // SHADOW BIAS / DARKNESS knobs (repair + artistic; defaults mirror TUNE_DEFS).
      gl.uniform1f(litU.uShadowBias, T && T.shadowBias != null ? T.shadowBias : 0.001);
      // Fade the cast shadow out as the KEY light dims toward moonlight: props stop
      // casting into the map once the key is dim (game.js shadow-pass perf skip is
      // now gated on key brightness, not sunDir.y — the night moon-key is held high
      // at y≈0.97 for the sky glow, so an elevation test never detected night and
      // left full-strength shadows on at night). Fading by key luminance keeps the
      // two in lock-step: as the key dims the terrain/road shadows fade out exactly
      // as the props stop casting, so nothing POPs when the SUN ELEVATION slider or
      // a time-of-day flip crosses into night.
      const _kl = frame.sunColor ? Math.max(frame.sunColor[0], frame.sunColor[1], frame.sunColor[2]) : 1;
      let _hf = (_kl - 0.28) / 0.14;
      _hf = _hf < 0 ? 0 : _hf > 1 ? 1 : _hf;
      _hf = _hf * _hf * (3 - 2 * _hf);
      // Clear-night moon shadows: floor the key-dim fade with the MOON SHADOWS
      // knob scaled by the clear-night factor (game.js frame.moonK — bright
      // moon, low cloud, dry road, no fog). 0 = old fade-to-nothing night.
      const _mSh = (T && T.moonShadow != null ? T.moonShadow : 0.25) * (frame.moonK || 0);
      if (_mSh > _hf) _hf = _mSh;
      gl.uniform1f(litU.uShadowStr, (T && T.shadowStr != null ? T.shadowStr : 1.15) * _hf);
      // SHADOW DISTANCE knob: box half-size, drives the receiver-distance fade.
      gl.uniform1f(litU.uShadowRange, T && T.shadowRange != null ? T.shadowRange : 80.0);
      // Fade anchor: the UNSNAPPED forward-biased ground point the shadow box is
      // snapped around (game.js shadow pass). It glides continuously with the
      // camera, so the fade front never jumps on a box recentre.
      gl.uniform3fv(litU.uShadowCtr, frame.shadowCtr || frame.eye || [0, 0, 0]);
      gl.uniform1f(litU.uShadowTexel, 1.0 / SHD.SIZE);
      // Dynamic car shadow map — unit 8, armed only on frames where game.js ran
      // the car caster pass (carShadowBegin). The texture is always bound while
      // enabled so the sampler2DShadow stays complete even when gated off.
      if (SHD.carEnabled) {
        gl.activeTexture(gl.TEXTURE8);
        gl.bindTexture(gl.TEXTURE_2D, SHD.carTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(litU.uCarShadowMap, 8);
        gl.uniformMatrix4fv(litU.uCarLightVP, false, SHD.carLightVP);
        gl.uniform1f(litU.uCarShadowOn, SHD.carArmed ? 1.0 : 0.0);
      } else {
        gl.uniform1f(litU.uCarShadowOn, 0.0);
      }
      // Nearest-floodlight spot shadow map — unit 9, armed only on frames where
      // game.js ran the lamp caster pass (lampShadowBegin). Same always-bound
      // pattern as the car map: when disabled, uLampShadowMap stays at its
      // default unit 0, which holds the static sun map — the SAME sampler type,
      // so the program stays valid and the gated branch never samples it.
      if (SHD.lampEnabled) {
        gl.activeTexture(gl.TEXTURE9);
        gl.bindTexture(gl.TEXTURE_2D, SHD.lampTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(litU.uLampShadowMap, 9);
        gl.uniformMatrix4fv(litU.uLampShadowVP, false, SHD.lampLightVP);
        gl.uniform1f(litU.uLampShadowOn, SHD.lampArmed ? 1.0 : 0.0);
        gl.uniform1i(litU.uLampShadowIdx, SHD.lampIdx);
      } else {
        gl.uniform1f(litU.uLampShadowOn, 0.0);
      }
    } else {
      gl.uniform1f(litU.uShadowStr, 0.0);
      gl.uniform1f(litU.uCarShadowOn, 0.0);
      gl.uniform1f(litU.uLampShadowOn, 0.0);
    }
    gl.uniform3fv(litU.uSkyZenith,  frame.skyZenith  || [0.18, 0.40, 0.78]);
    gl.uniform3fv(litU.uSkyHorizon, frame.skyHorizon || [0.62, 0.74, 0.88]);
    // FOG HEIGHT FALLOFF knob (absolute; def 0.018 matches the shipped palette).
    gl.uniform1f(litU.uFogHeight,   T && T.fogHeight != null ? T.fogHeight : (frame.fogHeight != null ? frame.fogHeight : 0.0));
    // GROUND MIST knob: scale the per-condition mist amount (multiplier, def 1).
    gl.uniform1f(litU.uGroundMist,  (frame.groundMist != null ? frame.groundMist : 0.0) * (T && T.mistDensity != null ? T.mistDensity : 1));
    gl.uniform1f(litU.uLampFog,     frame.lampFog != null ? frame.lampFog : 0.0);
    gl.uniform1f(litU.uTime,        frame.time  != null ? frame.time  : 0.0);
    gl.uniform1f(litU.uCloudCover,  frame.cloud != null ? frame.cloud : 0.0);
    gl.uniform1f(litU.uCloudSpeed,  frame.cloudSpeed != null ? frame.cloudSpeed : 1.0);
    gl.uniform1f(litU.uCloudShadowDim, T && T.cloudShadowDim != null ? T.cloudShadowDim : 0.80);
    // CAR SUN GLINT / CAR SPARKLE / FOG SUN CORE knobs (defaults = shipped look).
    gl.uniform1f(litU.uCarSunGlint, T && T.carSunGlint != null ? T.carSunGlint : 12.0);
    gl.uniform1f(litU.uCarSparkle,  T && T.carSparkle  != null ? T.carSparkle  : 1.6);
    gl.uniform1f(litU.uFogSunCore,  T && T.fogSunCore  != null ? T.fogSunCore  : 0.6);
    // LAMP NEAR CLAMP / WINDOW SUN FLASH / SKY RIM GLOW / AMBIENT CONTACT DARK /
    // LAMP WALL SPILL knobs (defaults = shipped look).
    gl.uniform1f(litU.uLampNearClamp,  T && T.lampNearClamp  != null ? T.lampNearClamp  : 4.0);
    gl.uniform1f(litU.uWindowSunFlash, T && T.windowSunFlash != null ? T.windowSunFlash : 1.0);
    gl.uniform1f(litU.uSkyRimGlow,     T && T.skyRimGlow     != null ? T.skyRimGlow     : 1.0);
    gl.uniform1f(litU.uAmbContactDark, T && T.ambContactDark != null ? T.ambContactDark : 1.0);
    gl.uniform1f(litU.uLampWallSpill,  T && T.lampWallSpill  != null ? T.lampWallSpill  : 1.0);
    gl.uniform1f(litU.uWetness,     frame.wetness != null ? frame.wetness : 0.0);
    // Env probe: dedicated unit 6 (0 shadow / 5 decal / 7 blocker). A COMPLETE
    // cube must ALWAYS be bound here with uEnvCube pointed at it — even with no
    // probe (menu / setup viewer / tools) — otherwise the samplerCube defaults to
    // unit 0 (a 2D texture), which is incomplete and renders the car black on
    // strict drivers. Bind the real cube only when it's live and not the current
    // render target (feedback guard); the dummy covers every other case.
    ensureEnvDummy();
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, (envTex && !_envActive) ? envTex : envDummyTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(litU.uEnvCube, 6);
    // uEnvStr stays 0 until the first full 6-face cycle (probe still black), and
    // frame.noEnv forces it off for probe-less views (the SETUP MENU preview)
    // even when a stale cube lingers from a prior race — so the menu car reads
    // matte (gentle analytic sheen) instead of mirroring last race's scene.
    // Fallback 0 (= probe OFF) is the SAFE side of the tier-gated TUNE_DEFS
    // carEnvCube default (0.3 desktop / 0.0 mobile) — a caller with no tune obj
    // gets no probe rather than the old 1.0 fallback's full-mirror surprise.
    gl.uniform1f(litU.uEnvStr, (envTex && envReady && !_envActive && !frame.noEnv)
      ? (T && T.carEnvCube != null ? T.carEnvCube : 0.0) : 0.0);
    // Point lights (floodlights / street lights). frame.lights is a flat array
    // of at most MAX_LIGHTS (32) entries, already culled to the nearest set by
    // the caller. Uploaded once per frame; uNumLights=0 on day.
    {
      const L = frame.lights;
      // Flat stride-15: [x,y,z, r,g,b, rad, dirX,dirY,dirZ, cosInner, cosOuter,
      // bleed, volW, glareW]. volW is consumed by the godray pass only; glareW
      // (lens-glare halo weight) by drawGlow only.
      const nL = L ? Math.min(32, (L.length / 15) | 0) : 0;
      gl.uniform1i(litU.uNumLights, nL);
      if (nL > 0) {
        const pos = _luPos, col = _luCol, rad = _luRad, dir = _luDir,
              cone = _luCone, bleed = _luBleed;
        for (let i = 0; i < nL; i++) {
          const o = i * 15;
          pos[i * 3] = L[o]; pos[i * 3 + 1] = L[o + 1]; pos[i * 3 + 2] = L[o + 2];
          col[i * 3] = L[o + 3]; col[i * 3 + 1] = L[o + 4]; col[i * 3 + 2] = L[o + 5];
          rad[i] = L[o + 6];
          dir[i * 3] = L[o + 7]; dir[i * 3 + 1] = L[o + 8]; dir[i * 3 + 2] = L[o + 9];
          cone[i * 2] = L[o + 10]; cone[i * 2 + 1] = L[o + 11];
          bleed[i] = L[o + 12];
        }
        gl.uniform3fv(litU["uLightPos[0]"], pos.subarray(0, nL * 3));
        gl.uniform3fv(litU["uLightCol[0]"], col.subarray(0, nL * 3));
        gl.uniform1fv(litU["uLightRad[0]"], rad.subarray(0, nL));
        gl.uniform3fv(litU["uLightDir[0]"], dir.subarray(0, nL * 3));
        gl.uniform2fv(litU["uLightCone[0]"], cone.subarray(0, nL * 2));
        gl.uniform1fv(litU["uLightBleed[0]"], bleed.subarray(0, nL));
      }
    }
    _matEmissive = _matAlpha = _matRough = _matMetal = _matSpec = _matDetail = _matCC = _matCP = _matSpark = -1;
  }

  // Shared lit-pass material setup — draw() below and GLXChunked.drawChunked
  // both route through this single helper (formerly duplicated in lockstep):
  // bind the lit program, upload the model matrix, and set the material
  // scalars through the redundancy cache. Returns the resolved alpha for the
  // caller's blend/depth-mask decisions.
  function litMaterial(modelMat, opts) {
    useProg(litProg);
    gl.uniformMatrix4fv(litU.uModel, false, modelMat);
    // Default the instancing gate OFF on every lit draw. drawInstanced() turns it
    // on for the duration of its own call and back off after, so no ordinary draw
    // can ever inherit it — the shader falls back to uModel exactly as before.
    if (litU.uInstanced) gl.uniform1f(litU.uInstanced, opts && opts._instanced ? 1 : 0);
    const emissive = opts && opts.emissive !== undefined ? opts.emissive : 0;
    const alpha = opts && opts.alpha !== undefined ? opts.alpha : 1;
    // Material (set every draw so values never leak from the previous mesh).
    // Defaults give a matte dielectric, so callers that pass no material look
    // essentially like the original lambert shading, just with a faint sheen.
    const roughness = opts && opts.roughness !== undefined ? opts.roughness : 0.7;
    const metalness = opts && opts.metalness !== undefined ? opts.metalness : 0.0;
    const specular = opts && opts.specular !== undefined ? opts.specular : 0.5;
    const detail = opts && opts.detail !== undefined ? opts.detail : 0.0;
    const clearcoat = opts && opts.clearcoat !== undefined ? opts.clearcoat : 0.0;
    const carPaint = opts && opts.carPaint !== undefined ? opts.carPaint : 0.0;
    const sparkle = opts && opts.sparkle !== undefined ? opts.sparkle : 1.0;
    if (emissive  !== _matEmissive) { gl.uniform1f(litU.uEmissive,  emissive);  _matEmissive = emissive; }
    if (alpha     !== _matAlpha)    { gl.uniform1f(litU.uAlpha,     alpha);     _matAlpha    = alpha; }
    if (roughness !== _matRough)    { gl.uniform1f(litU.uRoughness, roughness); _matRough    = roughness; }
    if (metalness !== _matMetal)    { gl.uniform1f(litU.uMetalness, metalness); _matMetal    = metalness; }
    if (specular  !== _matSpec)     { gl.uniform1f(litU.uSpecular,  specular);  _matSpec     = specular; }
    if (detail    !== _matDetail)   { gl.uniform1f(litU.uDetail,    detail);    _matDetail   = detail; }
    if (clearcoat !== _matCC)       { gl.uniform1f(litU.uClearcoat, clearcoat); _matCC       = clearcoat; }
    if (carPaint  !== _matCP)       { gl.uniform1f(litU.uCarPaint,  carPaint);  _matCP       = carPaint; }
    if (sparkle   !== _matSpark)    { gl.uniform1f(litU.uSparkle,   sparkle);   _matSpark    = sparkle; }
    return alpha;
  }

  // ---------- instanced draw (the TrackGraph.batches() consumer) ----------
  // One canonical mesh + a per-instance transform, instead of the same geometry
  // fused into the world N times. See js/track/graph.js and
  // docs/research/SCENE-GRAPH-PLAN.md; the producer is graph.batches().
  //
  // Layout: the mesh's own vertex VBO keeps attributes 0-4 with divisor 0, and a
  // SECOND buffer carries the instance columns at 5-8 (+ colour at 9) with
  // divisor 1. Nothing about the vertex format changes, so the same {pos,nrm,
  // col,idx,mat} geometry works in both paths.
  function createInstancedBatch(data, matrices, colors, opts) {
    const mesh = createMesh(data);
    const vao = mesh.vao;
    gl.bindVertexArray(vao);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ARRAY_BUFFER, matrices, gl.STATIC_DRAW);
    // A mat4 attribute is four consecutive vec4 slots — WebGL2 has no mat4
    // attribute type, the four columns must be declared individually.
    for (let c = 0; c < 4; c++) {
      const loc = 5 + c;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, c * 16);
      gl.vertexAttribDivisor(loc, 1);
    }

    let cbo = null;
    if (colors && colors.length) {
      cbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cbo);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(9);
      gl.vertexAttribPointer(9, 3, gl.FLOAT, false, 12, 0);
      gl.vertexAttribDivisor(9, 1);
    }
    gl.bindVertexArray(null);

    mesh.instances = matrices.length / 16;
    mesh.visible = mesh.instances;    // culling narrows this; see cullInstances()
    mesh.ibo = ibo;
    mesh.cbo = cbo;

    // Optional spatial buckets for per-frame frustum culling. WebGL2 has NO
    // baseInstance, so an instanced draw always starts at instance 0 — a visible
    // subset cannot be expressed as an offset. The only way to draw part of a
    // batch is to PACK the visible instances to the front of the buffer and
    // re-upload, which is what cullInstances() does; these buckets are what keep
    // that repack proportional to what is on screen rather than to the whole
    // batch. Same 72 m grid the chunked meshes use, so the two agree about what
    // "nearby" means.
    if (opts && opts.cellSize > 0) {
      const cell = opts.cellSize;
      // Conservative per-instance reach: the model's own extent, scaled by the
      // largest scale any instance applies. Cheap and never under-estimates.
      let reach = opts.radius || 0;
      if (!reach) {
        // Largest |component| in the canonical mesh: the model sits at the origin
        // (TrackGraph guarantees it), so this is its radius in every direction.
        const p0 = data.pos;
        for (let i = 0; i < p0.length; i++) { const a = Math.abs(p0[i]); if (a > reach) reach = a; }
      }
      const buckets = new Map();
      for (let i = 0; i < mesh.instances; i++) {
        const b = i * 16, x = matrices[b + 12], y = matrices[b + 13], z = matrices[b + 14];
        // Column lengths ARE the per-instance scale (orthonormal basis * scale).
        const sx = Math.hypot(matrices[b], matrices[b + 1], matrices[b + 2]);
        const sy = Math.hypot(matrices[b + 4], matrices[b + 5], matrices[b + 6]);
        const sz = Math.hypot(matrices[b + 8], matrices[b + 9], matrices[b + 10]);
        const r = reach * Math.max(sx, sy, sz);
        const key = (Math.floor(x / cell) + 1024) * 4096 + (Math.floor(z / cell) + 1024);
        let bk = buckets.get(key);
        if (!bk) buckets.set(key, (bk = { idx: [], mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] }));
        bk.idx.push(i);
        const mn = bk.mn, mx = bk.mx;
        if (x - r < mn[0]) mn[0] = x - r; if (x + r > mx[0]) mx[0] = x + r;
        if (y - r < mn[1]) mn[1] = y - r; if (y + r > mx[1]) mx[1] = y + r;
        if (z - r < mn[2]) mn[2] = z - r; if (z + r > mx[2]) mx[2] = z + r;
      }
      mesh.cells = [...buckets.values()];
      mesh.srcMatrices = matrices;      // CPU copies the repack reads from
      mesh.srcColors = colors && colors.length ? colors : null;
      mesh.packMatrices = new Float32Array(matrices.length);
      mesh.packColors = mesh.srcColors ? new Float32Array(mesh.srcColors.length) : null;
    }
    // A batch with no per-instance colour falls back to the context-wide generic
    // value for attribute 9, which init() pins at (1,1,1).
    return mesh;
  }

  // Repack the instances whose cell survives the frustum to the front of the GPU
  // buffer and record how many. Returns the visible count. A batch created
  // without cellSize has no cells and is left whole (always drawn in full).
  function cullInstances(batch, planes) {
    if (!batch || !batch.cells) return batch ? batch.instances : 0;
    const src = batch.srcMatrices, dst = batch.packMatrices;
    const sc = batch.srcColors, dc = batch.packColors;
    let n = 0;
    for (const c of batch.cells) {
      if (!CHK.aabbInFrustum(planes, c.mn, c.mx)) continue;
      for (const i of c.idx) {
        dst.set(src.subarray(i * 16, i * 16 + 16), n * 16);
        if (dc) dc.set(sc.subarray(i * 3, i * 3 + 3), n * 3);
        n++;
      }
    }
    batch.visible = n;
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.ibo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dst.subarray(0, n * 16));
      if (dc) {
        gl.bindBuffer(gl.ARRAY_BUFFER, batch.cbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, dc.subarray(0, n * 3));
      }
    }
    return n;
  }

  // OPAQUE-ONLY: a blended instanced draw would drop depth writes (below) but
  // would NOT mask alpha writes the way draw() does, so it would drag the SSR
  // car-paint tag stored in scene alpha. Every current caller (the TrackGraph
  // prop batches; tests/specs/instanced-draw.spec.js) passes alpha 1 — route
  // translucent work through draw() instead.
  function drawInstanced(batch, opts) {
    if (!batch || !batch.instances) return;
    const o = opts ? Object.assign({}, opts, { _instanced: 1 }) : { _instanced: 1 };
    // IDENTITY model matrix: the transform lives entirely in the instance
    // columns. Passing anything else would be silently ignored by the shader and
    // mislead the next reader.
    const alpha = litMaterial(IDENT4, o);
    setDepthMask(alpha >= 1);
    setBlend(alpha < 1);
    bindVAO(batch.vao);
    const dbl = opts && opts.doubleSided;
    if (dbl) gl.disable(gl.CULL_FACE);
    const n = batch.visible === undefined ? batch.instances : batch.visible;
    if (n > 0) gl.drawElementsInstanced(gl.TRIANGLES, batch.count, batch.indexType, 0, n);
    if (dbl) gl.enable(gl.CULL_FACE);
  }

  function freeInstancedBatch(batch) {
    if (!batch) return;
    if (batch.ibo) gl.deleteBuffer(batch.ibo);
    if (batch.cbo) gl.deleteBuffer(batch.cbo);
    if (freeMesh) freeMesh(batch);
  }

  function draw(mesh, modelMat, opts) {
    const alpha = litMaterial(modelMat, opts);
    // Each draw declares the full render state it needs (no restores afterwards),
    // so runs of same-state draws collapse to a single real toggle via the cache.
    // Translucent draws (ghost car, boost flame, pulsing rain light) must NOT
    // write depth: a 35%-alpha ghost that lands in the depth buffer culls the
    // cars/props drawn after it (they pop invisible "through" the ghost) and
    // registers in sceneDepth as a solid wall for SSAO/SSR/god-rays.
    setDepthMask(alpha >= 1);
    setBlend(alpha < 1);
    bindVAO(mesh.vao);
    // Scene alpha is the SSR car-paint tag (see LIT_FS outColor), written only
    // by OPAQUE draws — so ANY blended draw masks alpha writes automatically
    // (default blending blends the alpha channel too, dragging a stored 0.35
    // tag across the composite's 0.42-0.55 threshold). noAlphaWrite remains as
    // an explicit opt-out for opaque FX quads.
    const noAW = (opts && opts.noAlphaWrite) || alpha < 1;
    if (noAW) gl.colorMask(true, true, true, false);
    // doubleSided: render back faces too (cull off) — for the wheels + car body,
    // whose single-winding tyre walls must show from every angle without any
    // coincident duplicate to z-fight.
    const dbl = opts && opts.doubleSided;
    if (dbl) gl.disable(gl.CULL_FACE);
    // Depth bias for DECAL geometry (start line, road markings): nudge the
    // fragment's depth toward the camera instead of lifting the mesh in Y.
    // A geometric lift is resolution-dependent — it holds up close and
    // z-fights at distance, where depth precision collapses under a 0.3 m
    // near plane. polygonOffset scales with the local depth slope, so a
    // decal wins at every distance and grazing angle without moving it.
    const _db = opts && opts.depthBias;
    if (_db) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(_db[0], _db[1]); }
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    if (_db) { gl.polygonOffset(0, 0); gl.disable(gl.POLYGON_OFFSET_FILL); }
    if (dbl) gl.enable(gl.CULL_FACE);
    if (noAW) gl.colorMask(true, true, true, true);
  }

  function drawSky(sky) {
    useProg(skyProg);
    gl.uniformMatrix4fv(skyU.uInvViewProj, false, sky.invViewProj);
    gl.uniform3fv(skyU.uZenith, sky.zenith);
    gl.uniform3fv(skyU.uHorizon, sky.horizon);
    gl.uniform3fv(skyU.uSunDir, sky.sunDir);
    gl.uniform3fv(skyU.uSunColor, sky.sunColor);
    gl.uniform1f(skyU.uStars, sky.stars ? 1 : 0);
    gl.uniform1f(skyU.uCloud, sky.cloud !== undefined ? sky.cloud : 0);
    gl.uniform1f(skyU.uTime,  sky.time  !== undefined ? sky.time  : 0);
    gl.uniform1f(skyU.uMoon,  sky.moon  !== undefined ? sky.moon  : 0);
    gl.uniform3fv(skyU.uCityGlow, sky.cityGlow || [0, 0, 0]);
    gl.uniform1f(skyU.uStarBright, sky.starBright !== undefined ? sky.starBright : 1);
    gl.uniform1f(skyU.uCloudSpeed, sky.cloudSpeed !== undefined ? sky.cloudSpeed : 1);
    gl.uniform1f(skyU.uSkyGrad,     sky.skyGrad     !== undefined ? sky.skyGrad     : 0.35);
    gl.uniform1f(skyU.uStarDensity, sky.starDensity !== undefined ? sky.starDensity : 1);
    gl.uniform1f(skyU.uDaySkyBlue,  sky.daySkyBlue  !== undefined ? sky.daySkyBlue  : 1);
    gl.uniform1f(skyU.uMieScatter,  sky.mieScatter  !== undefined ? sky.mieScatter  : 1);
    gl.uniform1f(skyU.uCloudSilver, sky.cloudSilver !== undefined ? sky.cloudSilver : 1);
    gl.uniform1f(skyU.uCoronaAureole, sky.coronaAureole !== undefined ? sky.coronaAureole : 1);
    gl.uniform1f(skyU.uSunDiscSize, sky.sunDiscSize !== undefined ? sky.sunDiscSize : 1);
    gl.uniform1f(skyU.uStarSize,     sky.starSize     !== undefined ? sky.starSize     : 1);
    gl.uniform1f(skyU.uStarTwinkle,  sky.starTwinkle  !== undefined ? sky.starTwinkle  : 1);
    gl.uniform1f(skyU.uMoonDiscSize, sky.moonDiscSize !== undefined ? sky.moonDiscSize : 1);
    gl.uniform1f(skyU.uMoonHalo,     sky.moonHalo     !== undefined ? sky.moonHalo     : 1);
    gl.uniform1f(skyU.uSunCorona,    sky.sunCorona    !== undefined ? sky.sunCorona    : 1);
    gl.uniform1f(skyU.uSunSquash,    sky.sunSquash    !== undefined ? sky.sunSquash    : 1);
    gl.uniform1f(skyU.uCityGlowReach, sky.cityGlowReach !== undefined ? sky.cityGlowReach : 1);
    gl.uniform1f(skyU.uCloudDef,     sky.cloudDef     !== undefined ? sky.cloudDef     : 1);
    gl.uniform1f(skyU.uLightning,   sky.lightning   !== undefined ? sky.lightning   : 0);
    setBlend(false);
    setDepthMask(false);
    bindVAO(skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawShadow(modelMat, w, l) {
    useProg(shadowProg);
    if (_shadowVPToken !== _frameToken) {
      gl.uniformMatrix4fv(shadowU.uViewProj, false, frameViewProj);
      _shadowVPToken = _frameToken;
    }
    gl.uniformMatrix4fv(shadowU.uModel, false, modelMat);
    gl.uniform2f(shadowU.uSize, w, l);
    setBlend(true);
    setDepthMask(false);
    // Pull the flat quad toward the camera in depth so it can't z-fight the
    // coplanar road underneath (the "shadow flickering under the car").
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-4.0, -8.0);
    bindVAO(shadowVAO);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  function drawMark(modelMat, w, l) {
    useProg(markProg);
    if (_markVPToken !== _frameToken) {
      gl.uniformMatrix4fv(markU.uViewProj, false, frameViewProj);
      _markVPToken = _frameToken;
    }
    gl.uniformMatrix4fv(markU.uModel, false, modelMat);
    gl.uniform2f(markU.uSize, w, l);
    setBlend(true);
    setDepthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-4.0, -8.0);
    bindVAO(shadowVAO);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  // Batched skid marks. `verts` is an interleaved Float32Array (pos3 + uv2 per
  // vertex, 6 verts/mark); `vertCount` verts are live. When `dirty`, re-upload
  // the buffer (marks change at most every few frames). One draw for the whole
  // trail — replaces up to 120 per-mark drawMark calls. Returns false if the
  // batch path is unavailable (caller falls back to per-mark drawMark).
  function drawSkidBatch(verts, vertCount, dirty) {
    if (!markBatchProg || vertCount <= 0) return !markBatchProg ? false : true;
    useProg(markBatchProg);
    gl.uniformMatrix4fv(markBatchU.uViewProj, false, frameViewProj);
    setBlend(true);
    setDepthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-4.0, -8.0);   // sit on the road, no z-fight
    bindVAO(markBatchVAO);
    if (dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, markBatchVBO);
      gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, vertCount * 5), gl.DYNAMIC_DRAW);
    }
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    return true;
  }

  // Additive lens-glare halos: one round billboard per lamp. `lights` is the
  // stride-15 frame.lights array; fields 0-6 (position, colour, radius) and 14
  // (glareW: per-lamp halo weight, 0 = no visible fixture = no halo) are
  // read here. Must be called while the HDR scene target is bound (after
  // drawSky, before present) so the glare lands in the scene buffer and
  // participates in bloom. `str` scales halo brightness (0 disables).
  const _glowCorners = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
  function drawGlow(lights, str) {
    if (!glowProg || !lights || !lights.length || !(str > 0)) return;
    const nL = (lights.length / 15) | 0;  // stride-15 light records (see frame.lights)
    const floatsPerLamp = 6 * 9;
    if (!glowData || glowData.length < nL * floatsPerLamp) glowData = new Float32Array(nL * floatsPerLamp);
    let p = 0, nDraw = 0;
    const ex = frameEye ? frameEye[0] : 0, ey = frameEye ? frameEye[1] : 0, ez = frameEye ? frameEye[2] : 0;
    for (let i = 0; i < nL; i++) {
      const o = i * 15;
      // Per-lamp glare weight (record field 14): 0 = fixture-less light (edge
      // washers) that must never paint a floating halo; >1 = big soft glare
      // (heritage globes, flood banks).
      const glareW = lights[o + 14];
      if (!(glareW > 0)) continue;
      const cx = lights[o], cy = lights[o + 1], cz = lights[o + 2];
      // Lens glare is a NEAR-FIELD veiling effect. Distant sources already read
      // as bloom on their emissive head geometry — a halo billboard out there is
      // a detached orb hanging in the sky (elevated flood heads especially).
      const dxE = cx - ex, dyE = cy - ey, dzE = cz - ez;
      const dEye = Math.sqrt(dxE * dxE + dyE * dyE + dzE * dzE);
      const fade = Math.min(1, Math.max(0, (170 - dEye) / 110));
      if (fade <= 0) continue;
      // Light colours carry PHYSICAL intensities (hundreds, for the inverse-square
      // shader) — normalise to a display-scale corona colour that keeps the hue.
      let r = lights[o + 3], g = lights[o + 4], b = lights[o + 5];
      const rad = lights[o + 6];
      const cm = Math.max(r, g, b) || 1;
      const csc = Math.min(1, 3.2 / cm) * (0.5 + 0.5 * Math.min(1, cm / 40)) * fade * glareW;
      r *= csc; g *= csc; b *= csc;
      // Billboard size: a small LENS HALO hugging the lamp head — NOT a beam cone.
      // Sized to the lens housing (~2 m) and scaled by the lamp's glare weight.
      const brad = Math.min(2.2, rad * 0.10) * (0.7 + 0.6 * Math.min(glareW, 2));
      for (let v = 0; v < 6; v++) {
        const c = _glowCorners[v];
        glowData[p++] = c[0]; glowData[p++] = c[1];
        glowData[p++] = cx; glowData[p++] = cy; glowData[p++] = cz;
        glowData[p++] = r; glowData[p++] = g; glowData[p++] = b;
        glowData[p++] = brad;
      }
      nDraw++;
    }
    if (!nDraw) return;
    useProg(glowProg);
    gl.uniformMatrix4fv(glowU.uViewProj, false, frameViewProj);
    gl.uniform3fv(glowU.uEye, frameEye);
    gl.uniform1f(glowU.uStr, str);
    bindVAO(glowVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, glowVBO);
    gl.bufferData(gl.ARRAY_BUFFER, glowData.subarray(0, p), gl.DYNAMIC_DRAW);
    // Additive, depth-tested (halos occlude behind walls) but no depth write.
    setBlend(true);
    gl.blendFunc(gl.ONE, gl.ONE);
    setDepthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, nDraw * 6);
    // Restore the default alpha-blend + culling for subsequent passes.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
  }

  // Transient FX particle batch (tyre smoke / sparks / kickup / rain spray).
  // `data` is an interleaved Float32Array ([cornerX, cornerY, center xyz,
  // colour rgb, size, alpha] ×6 verts per particle); `floatCount` floats are
  // live. Two blend groups per frame: additive=false → classic alpha smoke/
  // dust/spray; additive=true → ONE/ONE sparks whose HDR tints feed bloom.
  // Depth-TESTED (puffs hide behind walls/cars) but never depth-written, and
  // the scene alpha channel (the SSR car-paint tag — see draw()) is masked.
  // Must be called while the HDR scene target is bound (before present) so
  // particles tone-map and bloom with the scene.
  function drawParticles(data, floatCount, additive) {
    if (!particleProg || !data || !(floatCount > 0) || !frameEye) return;
    useProg(particleProg);
    gl.uniformMatrix4fv(particleU.uViewProj, false, frameViewProj);
    gl.uniform3fv(particleU.uEye, frameEye);
    gl.uniform1f(particleU.uAdditive, additive ? 1 : 0);
    bindVAO(particleVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, particleVBO);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floatCount), gl.DYNAMIC_DRAW);
    setBlend(true);
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    setDepthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, false);
    gl.drawArrays(gl.TRIANGLES, 0, (floatCount / 10) | 0);
    gl.colorMask(true, true, true, true);
    if (additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
  }

  function freeMesh(mesh) {
    if (!mesh) return;
    if (_activeVAO === mesh.vao) { gl.bindVertexArray(null); _activeVAO = null; }
    gl.deleteBuffer(mesh.ib);
    gl.deleteBuffer(mesh.vbo);
    gl.deleteVertexArray(mesh.vao);
  }

  return {
    init,
    resize,
    createMesh,
    // TrackGraph.batches() consumer — see js/track/graph.js.
    createInstancedBatch,
    cullInstances,
    drawInstanced,
    freeInstancedBatch,
    createTexMesh,
    createTexture,
    createTextureArray,
    setMaterialMaps,
    materialMapState: () => ({
      albedo: !!matAlbedoTex, normal: !!matNormalTex,
      layers: Array.from(matTexScales).reduce((n, s) => n + (s > 0 ? 1 : 0), 0),
      scales: Array.from(matTexScales),
    }),
    freeTexture,
    drawDecal,
    createChunkedMesh: (data, cellSize) => CHK.createChunkedMesh(data, cellSize),
    freeMesh,
    freeChunkedMesh: (mesh) => CHK.freeChunkedMesh(mesh),
    begin,
    draw,
    drawChunked: (mesh, modelMat, opts) => CHK.drawChunked(mesh, modelMat, opts),
    castShadowChunked: (mesh, model) => CHK.castShadowChunked(mesh, model),
    // Cull-test helpers, so a caller outside the draw path (the agent world
    // view's visible()) runs the same frustum maths the GPU path runs.
    makeFrustumPlanes: (viewProj) => CHK.makeFrustumPlanes(viewProj),
    aabbInFrustum: (planes, mn, mx) => CHK.aabbInFrustum(planes, mn, mx),
    drawSky,
    drawShadow,
    drawMark,
    drawSkidBatch,
    drawGlow,
    drawParticles,
    present: (opts) => PST.present(opts),
    envFaceBegin,
    envFaceEnd,
    envProbeReady() { return envReady; },
    // New track/session: the cube still holds the OLD circuit — hold the
    // analytic fallback until a fresh 6-face cycle has re-rendered the world.
    envProbeReset() { envFacesMask = 0; envReady = false; },
    shadowBegin: (lightVP) => SHD.shadowBegin(lightVP),
    castShadow: (mesh, model) => SHD.castShadow(mesh, model),
    castShadowInstanced: (batch, count) => SHD.castShadowInstanced(batch, count),
    shadowEnd: () => SHD.shadowEnd(),
    carShadowBegin: (lightVP) => SHD.carShadowBegin(lightVP),
    carShadowEnd: () => SHD.carShadowEnd(),
    lampShadowBegin: (lightVP, lightIdx) => SHD.lampShadowBegin(lightVP, lightIdx),
    lampShadowEnd: () => SHD.lampShadowEnd(),
    get width() { return width; },
    get height() { return height; },
    get aspect() { return aspect; },
    hdrMode: () => PST.hdrOk(),
    // Debug introspection for the dynamic car shadow map (used by tests/tools).
    carShadowState: () => ({ enabled: SHD.carEnabled, arms: SHD.carArms }),
    // Same for the nearest-floodlight spot shadow map (idx = frame.lights slot).
    lampShadowState: () => ({ enabled: SHD.lampEnabled, arms: SHD.lampArms, idx: SHD.lampIdx }),
    msaa: () => PST.msaa(),
    pcss: () => SHD.pcssEnabled,
    setRenderScale, getRenderScale,
    // GPU frame timer. gpuTimer(true|false) toggles timing (returns whether it's
    // supported + on); gpuTimer() reads state. gpuMs() returns the most recent
    // GPU frame time in ms, or -1 if unsupported / no result yet.
    gpuTimer(on) {
      if (on !== undefined) {
        _gpuTimerOn = !!on && !!_gpuTimerExt;
        if (!_gpuTimerOn) {
          if (_gpuQActive) { try { gl.endQuery(_gpuTimerExt.TIME_ELAPSED_EXT); gl.deleteQuery(_gpuQActive); } catch (_) {} _gpuQActive = null; }
          for (let i = 0; i < _gpuQPending.length; i++) gl.deleteQuery(_gpuQPending[i]);
          _gpuQPending.length = 0; _gpuMs = -1;
        }
      }
      return { supported: !!_gpuTimerExt, on: _gpuTimerOn };
    },
    gpuMs() { return _gpuMs; },
    isMobile: IS_MOBILE,
    mobileTier: MOBILE_TIER,   // phone NOT opted into GRAPHICS: HIGH → memory-safe caps apply
  };
})();
