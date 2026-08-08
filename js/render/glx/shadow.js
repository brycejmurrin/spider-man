/*
 * Apex 26 — GLX shadow subsystem (split out of js/render/glx.js).
 * Owns the static sun shadow map, the per-frame dynamic CAR map, the
 * nearest-floodlight spot map, and the PCSS-lite blocker-search plumbing.
 * Wired through the GLXCore ctx: glx.js calls GLXShadow.init(core) inside
 * GLX.init() and delegates the shadow-pass methods here; the shared state
 * the lit/post passes read (map textures, light VPs, armed flags) lives as
 * plain fields on the returned object.
 * Must load before js/render/glx.js (glx.js calls GLXShadow.init at init time).
 */
import { DEPTH_VS, DEPTH_FS, POST_VS, BLOCKER_FS } from "../shaders/post.js";
"use strict";

export const GLXShadow = (function () {

  function init(core) {
    const gl = core.gl;
    const { useProg, bindVAO, setBlend, setDepthMask, link, locs } = core;
    // Keyed on the DEVICE (IS_MOBILE), not the memory tier: GRAPHICS: HIGH on a
    // phone must not 4x the snap-cache redraw cost (terrain+road+whole city into
    // the map roughly every 10 m of travel) - that redraw frame was the periodic
    // HIGH-tier stall. 1024² also saves 12 MB on every phone.
    const SHADOW_SIZE = core.IS_MOBILE ? 1024 : 2048;
    const CAR_SHADOW_SIZE = 1024;                         // dynamic car-only shadow map (desktop tier)
    const LAMP_SHADOW_SIZE = 512;                         // nearest-floodlight spot map (desktop tier)

    let depthProg = null;
    let shadowMapFBO = null;
    let carShadowFBO = null;
    let lampShadowFBO = null;
    // Min-of-4 downsample of the shadow depth map (conservative nearest-blocker
    // per cell) - the PCSS-lite blocker-search source.
    // BLOCKER_FS lives in js/render/shaders/post.js (uSrcTexel-parameterised).
    let blockerProg = null, blockerU = null, blockerFBO = null, blockerSampler = null;

    // Shared state the lit pass (GLX.begin), the post chain (GLXPost.present)
    // and the chunked caster (GLXChunked) read directly. All the flags mirror
    // the old glx.js closure variables 1:1.
    const S = {
      SIZE: SHADOW_SIZE,
      enabled: false,          // was shadowEnabled
      mapTex: null,            // was shadowMapTex
      lightVP: new Float32Array(16),   // was shadowLightVP
      pcssEnabled: false,
      blockerTex: null,
      depthU: null,
      // True only between a shadow/carShadow/lampShadow Begin that actually bound
      // its depth FBO + program and the matching End. castShadow/castShadowChunked
      // gate on THIS, not enabled: on the mobile tier the car/lamp maps are
      // never created, so their Begins no-op — but game.js still issues the caster
      // draws, which previously ran under whatever program/framebuffer was left
      // bound (per-draw GL errors + stray fills every frame = the "standard tier
      // is buggy and laggy" report). Mirrors WGX, whose casts no-op when no pass
      // is open.
      depthPassOn: false,      // was _depthPassOn
      // Light frustum the chunked shadow caster culls against: null = the static
      // sun box (S.lightVP); lampShadowBegin points it at the lamp's frustum
      // for the duration of that pass.
      castCullVP: null,        // was _castCullVP
      // Dynamic per-frame CAR shadow map — separate from the snap-cached static
      // map so moving cars get live sun shadows.
      carEnabled: false, carTex: null, carLightVP: new Float32Array(16),
      carArmed: false,         // set by carShadowBegin, cleared each present()
      carArms: 0,              // lifetime carShadowBegin count (debug introspection)
      // Nearest-FLOODLIGHT spot shadow map (night, desktop): per-frame depth
      // render from the single nearest lamp (perspective VP down its beam).
      lampEnabled: false, lampTex: null, lampLightVP: new Float32Array(16),
      lampArmed: false,        // set by lampShadowBegin, cleared each present()
      lampIdx: -1,             // frame.lights record index of the mapped lamp
      lampArms: 0,             // lifetime lampShadowBegin count (debug introspection)
      shadowBegin, castShadow, castShadowInstanced, shadowEnd,
      carShadowBegin, carShadowEnd,
      lampShadowBegin, lampShadowEnd,
    };

    function setup() {
      depthProg = link(DEPTH_VS, DEPTH_FS);
      if (!depthProg) return false;
      S.depthU = locs(depthProg, ["uModel", "uInstanced", "uLightVP"]);

      S.mapTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, S.mapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      // LINEAR + COMPARE_REF_TO_TEXTURE = guaranteed hardware 2x2 PCF per tap in
      // ES 3.0 (was NEAREST: every Poisson tap was a single hard compare).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

      shadowMapFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowMapFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, S.mapTex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // ── Dynamic CAR shadow map: cars are NOT in the cached static map above (it
      // only re-renders on a snap-cell change, so a moving car would leave a stale
      // smear). This small map holds ONLY the car meshes and re-renders every
      // frame (~22 tiny body meshes — trivial), giving real sun-projected car
      // shadows with correct direction/length and car-on-car shadowing; the blob
      // decal stays as the contact-AO term. Desktop only: the mobile tier keeps
      // blob-only (memory + fill cost), and WGX has no car pass yet (game.js
      // guards on gfx.carShadowBegin).
      S.carEnabled = false;
      if (ok && !core.IS_MOBILE) {   // true desktop only - a per-frame pass is the HIGH-tier lag, not a memory cap
        S.carTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, S.carTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, CAR_SHADOW_SIZE, CAR_SHADOW_SIZE, 0,
          gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        carShadowFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, carShadowFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, S.carTex, 0);
        S.carEnabled = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      // ── Nearest-floodlight spot shadow map: same creation pattern as the car
      // map above (compare-mode depth texture = hardware PCF), but 512² and a
      // PERSPECTIVE light — the depth render looks down the chosen lamp's beam.
      // Desktop only, like the car map: per-frame depth passes and the extra
      // sampler are exactly the discretionary cost the mobile tier sheds.
      S.lampEnabled = false;
      if (ok && !core.IS_MOBILE) {   // true desktop only - a per-frame pass is the HIGH-tier lag, not a memory cap
        S.lampTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, S.lampTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, LAMP_SHADOW_SIZE, LAMP_SHADOW_SIZE, 0,
          gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        lampShadowFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, lampShadowFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, S.lampTex, 0);
        S.lampEnabled = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      // ── PCSS-lite blocker map: a 512-square R16F min-depth downsample of the
      // shadow map, rebuilt only when the shadow map re-renders (the snap-grid
      // cache means once per ~10 m of travel, not per frame). LIT_FS samples it
      // as a plain sampler2D for the blocker search; the depth texture itself
      // stays a sampler2DShadow. A compare-off SAMPLER OBJECT lets the blocker
      // pass read the same depth texture without compare mode - the legal WebGL2
      // way to view a depth texture two different ways.
      S.pcssEnabled = false;
      if (ok) {
        blockerProg = link(POST_VS, BLOCKER_FS);
        if (blockerProg) {
          blockerU = locs(blockerProg, ["uDepthTex", "uSrcTexel"]);
          S.blockerTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, S.blockerTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 512, 512, 0, gl.RED, gl.HALF_FLOAT, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          blockerFBO = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, blockerFBO);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, S.blockerTex, 0);
          S.pcssEnabled = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          if (S.pcssEnabled) {
            blockerSampler = gl.createSampler();
            gl.samplerParameteri(blockerSampler, gl.TEXTURE_COMPARE_MODE, gl.NONE);
            gl.samplerParameteri(blockerSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.samplerParameteri(blockerSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          }
        }
      }
      return ok;
    }

    function shadowBegin(lightVP) {
      if (!S.enabled) return;
      // Depth must be writable to clear/render the shadow map. This pass runs
      // before begin(), so declare the state explicitly rather than assuming it.
      setDepthMask(true);
      S.lightVP.set(lightVP);
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowMapFBO);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      useProg(depthProg);
      gl.uniformMatrix4fv(S.depthU.uLightVP, false, lightVP);
      gl.disable(gl.CULL_FACE);  // render back faces to avoid peter-panning
      S.depthPassOn = true;
    }

    function castShadow(mesh, model) {
      if (!S.depthPassOn || !mesh) return;
      bindVAO(mesh.vao);
      if (S.depthU.uInstanced) gl.uniform1f(S.depthU.uInstanced, 0);
      gl.uniformMatrix4fv(S.depthU.uModel, false, model);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    }

    // Instanced counterpart: one canonical mesh, N transforms, one draw. `count`
    // optionally limits it to the first N instances, which is how a culled
    // upload draws only the visible slice without reallocating the buffer.
    function castShadowInstanced(batch, count) {
      if (!S.depthPassOn || !batch || !batch.instances) return;
      const n = count === undefined ? batch.instances : Math.min(count, batch.instances);
      if (n <= 0) return;
      bindVAO(batch.vao);
      if (S.depthU.uInstanced) gl.uniform1f(S.depthU.uInstanced, 1);
      gl.drawElementsInstanced(gl.TRIANGLES, batch.count, batch.indexType, 0, n);
      if (S.depthU.uInstanced) gl.uniform1f(S.depthU.uInstanced, 0);
    }

    function shadowEnd() {
      S.depthPassOn = false;
      if (!S.enabled) return;
      gl.enable(gl.CULL_FACE);
      // Refresh the PCSS blocker map from the just-rendered shadow depth.
      // Zero per-frame cost: shadowEnd only runs when the snap cell changed.
      if (S.pcssEnabled) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, blockerFBO);
        gl.viewport(0, 0, 512, 512);
        useProg(blockerProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, S.mapTex);
        gl.bindSampler(0, blockerSampler);
        gl.uniform1i(blockerU.uDepthTex, 0);
        gl.uniform2f(blockerU.uSrcTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
        gl.disable(gl.DEPTH_TEST); setBlend(false);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindSampler(0, null);
        gl.enable(gl.DEPTH_TEST);
      }
      core.post.bindSceneTarget();
    }

    // Dynamic CAR shadow pass — same depth program/caster as shadowBegin, but
    // into the small per-frame car map. Runs before begin() each frame (game.js
    // guards on this method existing, so WGX silently keeps blob-only shadows).
    function carShadowBegin(lightVP) {
      if (!S.carEnabled) return;
      setDepthMask(true);
      S.carLightVP.set(lightVP);
      gl.bindFramebuffer(gl.FRAMEBUFFER, carShadowFBO);
      gl.viewport(0, 0, CAR_SHADOW_SIZE, CAR_SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      useProg(depthProg);
      gl.uniformMatrix4fv(S.depthU.uLightVP, false, lightVP);
      gl.disable(gl.CULL_FACE);   // back faces too, like the static pass
      S.depthPassOn = true;
      S.carArmed = true;
      S.carArms++;
    }

    function carShadowEnd() {
      S.depthPassOn = false;
      if (!S.carEnabled) return;
      gl.enable(gl.CULL_FACE);
      core.post.bindSceneTarget();
    }

    // Nearest-floodlight spot shadow pass — same depth program as the passes
    // above, into the 512² lamp map from a PERSPECTIVE lamp frustum. `lightIdx`
    // is the lamp's record index in this frame's frame.lights (the lit pass
    // gates its PCF to that loop slot; the godray pass re-maps it to its own
    // nearest-N ordering). game.js guards on this method existing, so WGX
    // silently keeps unshadowed lamp cones.
    function lampShadowBegin(lightVP, lightIdx) {
      if (!S.lampEnabled) return;
      setDepthMask(true);
      S.lampLightVP.set(lightVP);
      S.lampIdx = lightIdx | 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, lampShadowFBO);
      gl.viewport(0, 0, LAMP_SHADOW_SIZE, LAMP_SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      useProg(depthProg);
      gl.uniformMatrix4fv(S.depthU.uLightVP, false, lightVP);
      gl.disable(gl.CULL_FACE);   // back faces too, like the static pass
      S.castCullVP = S.lampLightVP;   // chunked casters cull to the lamp cone
      S.depthPassOn = true;
      S.lampArmed = true;
      S.lampArms++;
    }

    function lampShadowEnd() {
      S.depthPassOn = false;
      if (!S.lampEnabled) return;
      S.castCullVP = null;
      gl.enable(gl.CULL_FACE);
      core.post.bindSceneTarget();
    }

    S.enabled = setup();
    return S;
  }

  return { init };
})();
