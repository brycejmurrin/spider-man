/*
 * Apex 26 — GLX post-processing subsystem (split out of js/render/glx.js).
 * Owns the whole post chain: the HDR scene + MSAA targets, bright pass,
 * mip-chain bloom, SSAO, volumetric god rays, the composite (tone-map +
 * grade + SSR + flare + vignette), FXAA resolve, and the procedural lens-dirt
 * texture. Wired through the GLXCore ctx: glx.js calls GLXPost.init(core)
 * inside GLX.init() and delegates present() here.
 * Must load before js/render/glx.js (glx.js calls GLXPost.init at init time).
 */
import { POST_VS, BRIGHT_FS, BLUR_FS, DOWN_FS, UP_FS, SSAO_FS, GODRAY_FS, COMPOSITE_FS, FXAA_FS } from "../shaders/post.js";
"use strict";

export const GLXPost = (function () {

  function init(core) {
    const gl = core.gl;
    const { useProg, bindVAO, setBlend, setDepthMask, link, locs } = core;
    const MOBILE_TIER = core.MOBILE_TIER;
    const IS_MOBILE = core.IS_MOBILE;
    const F = core.frame;

    let ssaoProg = null, ssaoU = null, ssaoFBO = null, ssaoTex = null;
    let ssaoBlurFBO = null, ssaoBlurTex = null, whiteTex = null, blackTex = null, dirtTex = null;
    let godrayProg = null, godrayU = null, godrayFBO = null, godrayTex = null;
    let godrayBlurFBO = null, godrayBlurTex = null;
    let godrayW = 0, godrayH = 0;
    let ssaoW = 0, ssaoH = 0;   // SSAO runs at half res (upscaled in composite)
    let fxaaProg = null, fxaaU = null, ldrFBO = null, ldrTex = null;   // FXAA pass + its LDR input

    // Post-processing state. postEnabled stays false (and rendering goes straight
    // to the default framebuffer, exactly as before) if any target/program setup
    // fails, so the game always renders.
    let postEnabled = false;
    let brightProg = null, brightU = null;
    let blurProg = null, blurU = null;
    let downProg = null, downU = null, upProg = null, upU = null;
    let compProg = null, compU = null;
    let sceneFBO = null, sceneTex = null, sceneDepth = null;
    let colorType = null;        // HALF_FLOAT if renderable, else UNSIGNED_BYTE
    // Mip-chain bloom: progressive downsample levels (half res, /4, /8, …), then
    // additive tent upsample back to level 0 — wide multi-octave glow.
    const BLOOM_DIV = 2;         // level 0 at half resolution
    const BLOOM_LEVELS_MAX = 5;
    let bloomLv = [];            // [{fbo, tex, w, h}] — rebuilt on resize
    // MSAA scene target: the geometry passes render into multisampled renderbuffers,
    // resolved (blitFramebuffer) into sceneTex/sceneDepth before post — real edge AA
    // on the HDR path, with FXAA left to clean up what the resolve misses.
    let msaaSamples = 0;         // 0/1 = off (render straight into sceneFBO)
    let msFBO = null, msColorRB = null, msDepthRB = null;

    // God-ray lamp-selection scratch (present() only) — no per-frame allocation.
    const _grPos = new Float32Array(36), _grCol = new Float32Array(36),
          _grRad = new Float32Array(12), _grDir = new Float32Array(36),
          _grCone = new Float32Array(24), _grVolW = new Float32Array(12), _grSel = [];
    const _grByD = (a, b) => a.d - b.d;   // hoisted comparator (was a per-frame closure)

    // Build the post-processing programs + pick a colour format. Returns true if
    // the whole chain is usable; on any failure the caller leaves post disabled.
    function setup() {
      // RGBA16F is the ideal HDR target (preserves sun/specular > 1 for bloom);
      // fall back to 8-bit if float colour buffers aren't renderable.
      const ext = gl.getExtension("EXT_color_buffer_float");
      colorType = ext ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

      brightProg = link(POST_VS, BRIGHT_FS);
      blurProg = link(POST_VS, BLUR_FS);
      downProg = link(POST_VS, DOWN_FS);
      upProg = link(POST_VS, UP_FS);
      compProg = link(POST_VS, COMPOSITE_FS);
      ssaoProg = link(POST_VS, SSAO_FS);
      godrayProg = link(POST_VS, GODRAY_FS);
      fxaaProg = link(POST_VS, FXAA_FS);
      if (fxaaProg) fxaaU = locs(fxaaProg, ["uTex", "uTexel"]);
      if (!brightProg || !blurProg || !compProg || !downProg || !upProg) return false;
      brightU = locs(brightProg, ["uScene", "uThreshold"]);
      blurU = locs(blurProg, ["uTex", "uDir"]);
      downU = locs(downProg, ["uTex", "uTexel", "uKaris"]);
      upU = locs(upProg, ["uTex", "uTexel", "uSpread"]);
      // MSAA: pick the sample count the HDR colour format actually supports (many
      // mobile GPUs render RGBA16F but not multisampled RGBA16F — query, don't assume).
      try {
        const fmt = colorType === gl.HALF_FLOAT ? gl.RGBA16F : gl.RGBA8;
        const cs = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
        const ds = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
        const cMax = cs && cs.length ? cs[0] : 0;
        const dMax = ds && ds.length ? ds[0] : 0;
        // 2× (was 4×): halves the multisample colour+depth store and the resolve
        // blit bandwidth. FXAA (full-res, below) cleans up the specular/edge
        // shimmer the lower sample count misses, so the perceptual gap is small.
        // Mobile tier: no MSAA at all — two extra full-res multisampled surfaces
        // (~20-30 MB) against a tight jetsam budget; FXAA alone carries the AA.
        // True desktop only: 2x MSAA on the RGBA16F scene target + per-frame
        // resolve was part of the GRAPHICS: HIGH lag on phones (HIGH used to
        // flip the whole memory tier, not just visual quality).
        msaaSamples = IS_MOBILE ? 0 : Math.min(2, cMax, dMax);
        if (msaaSamples < 2) msaaSamples = 0;
      } catch (e) { msaaSamples = 0; }
      compU = locs(compProg, ["uScene", "uBloom", "uSSAO", "uAOTexel", "uGodray", "uBloomAmt", "uBloomKnee", "uSunUV", "uFlareStr", "uExposure", "uSunShaft", "uGradeShadow", "uGradeHi", "uGradeStr", "uContrast", "uVibrance", "uSaturation", "uTint", "uVignette", "uVigSoft", "uTone0", "uTone1", "uLift", "uGamma", "uGain", "uHdrGradeOn", "uCarReflect", "uCarGloss", "uDepth", "uInvProj", "uProj", "uUpVS", "uReflTexel", "uReflect", "uSsrOk", "uReflSkyHi", "uReflSkyLo", "uSsrThick", "uSsrTopUV", "uSsrNear", "uChromAb", "uGrain", "uGrainTime", "uSharpen", "uBlackLift", "uWhitePoint", "uAcesA", "uAcesB", "uAcesC", "uAcesD", "uAcesE", "uSpeedBlur", "uDirt", "uLensDirt", "uHazeUV", "uHazeStr", "uHazeTime", "uShaftDecay", "uFlareStreak", "uFlareStreak2"]);
      if (ssaoProg) ssaoU = locs(ssaoProg, ["uDepth", "uInvProj", "uProj", "uSunVS", "uTexel", "uStrength", "uContact", "uRadius"]);
      if (godrayProg) godrayU = locs(godrayProg, ["uDepth", "uShadowMap", "uInvVP", "uLightVP", "uEye", "uSunDir", "uSunColor", "uStr", "uTime", "uCloudCover", "uCloudSpeed", "uNumLights", "uLightPos[0]", "uLightCol[0]", "uLightRad[0]", "uLightDir[0]", "uLightCone[0]", "uLightVolW[0]", "uMist", "uLampStr", "uHgAniso", "uHgFloor", "uLampShadowMap", "uLampShadowVP", "uLampShadowIdx"]);
      // 1×1 white texture: the "AO off" fallback so the composite multiply is a no-op.
      whiteTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, whiteTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      // 1×1 black texture: the "god-ray off" fallback so the additive term is a no-op.
      blackTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, blackTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      makeDirtTex();
      return true;
    }

    // LENS DIRT smudge map: a small procedural greyscale texture generated on a
    // canvas at init (this repo ships no image assets). A low-frequency value-noise
    // base (random coarse grid upscaled with bilinear smoothing) plus soft grime
    // blobs, dust specks and faint wipe streaks. Deterministic LCG seed → every
    // load gets the same lens. Sampled by COMPOSITE_FS to scatter bloom energy
    // into a veil and to break the sun flare into a blotchy, smudged one.
    function makeDirtTex() {
      try {
        const S = 256;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const c2 = cv.getContext("2d");
        if (!c2) return;
        let seed = 0x9e3779b9;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        c2.fillStyle = "#000"; c2.fillRect(0, 0, S, S);
        // value-noise base: coarse random luminance grid, bilinearly upscaled
        const N = 16;
        const nc = document.createElement("canvas");
        nc.width = nc.height = N;
        const n2 = nc.getContext("2d");
        const img = n2.createImageData(N, N);
        for (let i = 0; i < N * N; i++) {
          const v = (rnd() * 42) | 0;
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        n2.putImageData(img, 0, 0);
        c2.imageSmoothingEnabled = true;
        c2.globalCompositeOperation = "lighter";
        c2.drawImage(nc, 0, 0, N, N, 0, 0, S, S);
        // soft grime blobs (the "smudge" body)
        for (let i = 0; i < 130; i++) {
          const x = rnd() * S, y = rnd() * S, r = 3 + rnd() * rnd() * 30;
          const a = 0.03 + rnd() * rnd() * 0.12;
          const g = c2.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, "rgba(255,255,255," + a.toFixed(3) + ")");
          g.addColorStop(1, "rgba(255,255,255,0)");
          c2.fillStyle = g;
          c2.beginPath(); c2.arc(x, y, r, 0, 6.2832); c2.fill();
        }
        // bright dust specks
        for (let i = 0; i < 70; i++) {
          const x = rnd() * S, y = rnd() * S, r = 0.6 + rnd() * 1.7;
          c2.fillStyle = "rgba(255,255,255," + (0.10 + rnd() * 0.28).toFixed(3) + ")";
          c2.beginPath(); c2.arc(x, y, r, 0, 6.2832); c2.fill();
        }
        // faint diagonal wipe streaks
        for (let i = 0; i < 9; i++) {
          const x = rnd() * S, y = rnd() * S, len = 30 + rnd() * 100, ang = rnd() * 6.2832;
          c2.strokeStyle = "rgba(255,255,255," + (0.02 + rnd() * 0.05).toFixed(3) + ")";
          c2.lineWidth = 1 + rnd() * 3;
          c2.beginPath(); c2.moveTo(x, y);
          c2.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          c2.stroke();
        }
        dirtTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, dirtTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } catch (e) { dirtTex = null; }   // no canvas 2D → knob becomes a no-op (black fallback)
    }

    // (Re)allocate the scene + bloom render targets at the current size.
    function createTargets() {
      if (!postEnabled) return;
      const { width, height } = core.getSize();
      const internal = colorType === gl.HALF_FLOAT ? gl.RGBA16F : gl.RGBA8;
      // Slimmer formats where full RGBA16F is waste (bandwidth is the tiled-GPU
      // frame cost): SSAO stores one scalar (sampled .r) -> R8; bloom + godray
      // are alpha-less positive HDR colour -> R11F_G11F_B10F (half the bytes;
      // renderable under the same EXT_color_buffer_float the HDR path requires).
      // LDR fallback keeps RGBA8 everywhere.
      const hdrOk = colorType === gl.HALF_FLOAT;
      const mk = (w, h, fmt) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (fmt === "r8") gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
        else if (fmt === "hdr3" && hdrOk) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R11F_G11F_B10F, w, h, 0, gl.RGB, colorType, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, colorType, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      };
      // scene target (full res) + depth as a SAMPLEABLE texture (enables SSAO and
      // any depth-aware post; same pattern already used for the shadow map).
      // NOTE (every block below): bind the FBO BEFORE deleting its old attachments.
      // Deleting a texture only auto-detaches it from the CURRENTLY BOUND
      // framebuffer — deleted-while-attached-elsewhere keeps the storage resident,
      // so old + new full-size target sets were transiently alive together
      // (~tens of MB per setRenderScale call): a jetsam kill on mobile web apps.
      if (!sceneFBO) sceneFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      if (sceneTex) gl.deleteTexture(sceneTex);
      if (sceneDepth) gl.deleteTexture(sceneDepth);
      sceneTex = mk(width, height);
      sceneDepth = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sceneDepth, 0);
      // The CRITICAL target: every 3D pixel goes through it when post is on. On a
      // driver where RGBA16F + depth-texture isn't a renderable combo (possible
      // even with EXT_color_buffer_float present), skipping this check left
      // postEnabled true and the whole view black — the designed fallback is
      // direct-to-screen rendering, so take it. (Same pattern as msFBO below.)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        postEnabled = false;
        return;
      }
      // MSAA scene target: multisampled colour + depth renderbuffers, resolved into
      // sceneTex/sceneDepth at present(). Falls back silently (msaaSamples = 0) if
      // the combo doesn't yield a complete FBO on this driver.
      if (msaaSamples > 1) {
        const internalD = gl.DEPTH_COMPONENT24;
        if (!msFBO) msFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFBO);   // bound → deletes auto-detach (frees NOW)
        if (msColorRB) gl.deleteRenderbuffer(msColorRB);
        if (msDepthRB) gl.deleteRenderbuffer(msDepthRB);
        msColorRB = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, msColorRB);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaaSamples, internal, width, height);
        msDepthRB = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, msDepthRB);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaaSamples, internalD, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColorRB);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepthRB);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          // Bail cleanly: without this the two just-allocated multisampled
          // surfaces (~30 MB at full res) stayed attached to msFBO forever.
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, null);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
          gl.deleteRenderbuffer(msColorRB); gl.deleteRenderbuffer(msDepthRB);
          msColorRB = null; msDepthRB = null;
          msaaSamples = 0;
        }
      }
      // bloom mip chain (half res, /4, /8, … — stop once a level gets tiny)
      for (const lv of bloomLv) { if (lv.tex) gl.deleteTexture(lv.tex); if (lv.fbo) gl.deleteFramebuffer(lv.fbo); }
      bloomLv = [];
      let bw = Math.max(1, Math.floor(width / BLOOM_DIV));
      let bh = Math.max(1, Math.floor(height / BLOOM_DIV));
      for (let i = 0; i < BLOOM_LEVELS_MAX && bw >= 8 && bh >= 8; i++) {
        const tex = mk(bw, bh, "hdr3");
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        // Level 0 proves the RGBA16F-colour-only combo renders on this driver;
        // deeper levels are the same format, so one check covers the chain.
        if (i === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          gl.deleteTexture(tex); gl.deleteFramebuffer(fbo);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          postEnabled = false;
          return;
        }
        bloomLv.push({ fbo, tex, w: bw, h: bh });
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      }
      // SSAO targets (HALF res): raw AO + a blurred copy to denoise the 12-tap pass.
      // AO is low-frequency, so half-res + LINEAR upscale in the composite is ~75%
      // cheaper with no visible loss (depth is still sampled at full res per tap).
      if (ssaoProg) {
        ssaoW = Math.max(1, Math.floor(width / 2));
        ssaoH = Math.max(1, Math.floor(height / 2));
        if (!ssaoFBO) ssaoFBO = gl.createFramebuffer();
        if (!ssaoBlurFBO) ssaoBlurFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoFBO);
        if (ssaoTex) gl.deleteTexture(ssaoTex);
        ssaoTex = mk(ssaoW, ssaoH, "r8");
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ssaoTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoBlurFBO);
        if (ssaoBlurTex) gl.deleteTexture(ssaoBlurTex);
        ssaoBlurTex = mk(ssaoW, ssaoH, "r8");
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoBlurFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ssaoBlurTex, 0);
      }
      // God-ray targets (half res): raw shafts + a blurred copy to soften the march.
      if (godrayProg) {
        godrayW = Math.max(1, Math.floor(width / 2));
        godrayH = Math.max(1, Math.floor(height / 2));
        if (!godrayFBO) godrayFBO = gl.createFramebuffer();
        if (!godrayBlurFBO) godrayBlurFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, godrayFBO);
        if (godrayTex) gl.deleteTexture(godrayTex);
        godrayTex = mk(godrayW, godrayH, "hdr3");
        gl.bindFramebuffer(gl.FRAMEBUFFER, godrayFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, godrayTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, godrayBlurFBO);
        if (godrayBlurTex) gl.deleteTexture(godrayBlurTex);
        godrayBlurTex = mk(godrayW, godrayH, "hdr3");
        gl.bindFramebuffer(gl.FRAMEBUFFER, godrayBlurFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, godrayBlurTex, 0);
      }
      // LDR target (full res, RGBA8): the composite renders here so the FXAA pass
      // can edge-detect on the final tonemapped image, then resolve to the screen.
      if (fxaaProg) {
        if (!ldrFBO) ldrFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, ldrFBO);
        if (ldrTex) gl.deleteTexture(ldrTex);
        ldrTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, ldrTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, ldrFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ldrTex, 0);
      }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        postEnabled = false;     // unsupported combo: fall back to direct rendering
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Bind the frame's scene render target (the MSAA or HDR offscreen target when
    // post is enabled, else the default framebuffer) and restore the full-size
    // viewport. Used by GLX.begin() and by the shadow passes' End rebind.
    function bindSceneTarget() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, postEnabled ? (msaaSamples > 1 ? msFBO : sceneFBO) : null);
      const { width, height } = core.getSize();
      gl.viewport(0, 0, width, height);
    }

    // Resolve the HDR scene to the screen: extract bright areas, blur them into a
    // bloom buffer, then composite scene + bloom with tonemap + vignette. No-op when
    // post is disabled (the scene was drawn straight to the screen already).
    function present(opts) {
      const SH = core.shadow;
      // Car shadow map must be re-armed by a fresh carShadowBegin every frame —
      // when game.js stops running the pass (night, knob off, menu) the stale map
      // must not keep shadowing. Same contract for the lamp spot map, but its
      // armed state must survive until AFTER the godray pass below consumes it.
      SH.carArmed = false;
      const lampArmed = SH.lampArmed;
      SH.lampArmed = false;
      if (!postEnabled) { core.gpuTimerEnd(); return; }
      const { width, height } = core.getSize();
      const threshold = opts && opts.threshold !== undefined ? opts.threshold : 0.75;
      const bloomAmt = opts && opts.bloom !== undefined ? opts.bloom : 0.55;

      // MSAA resolve: average the multisampled scene into sceneTex (and copy depth
      // into sceneDepth for SSAO/god-rays/SSR) before any post pass samples them.
      if (msaaSamples > 1) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFBO);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneFBO);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height,
          gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        // The multisampled surfaces are consumed — discard them so a tiled (mobile)
        // GPU never writes them back to memory (MDN WebGL best-practice; big
        // bandwidth/tile-store win, esp. for the multisampled DEPTH).
        if (gl.invalidateFramebuffer) gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      // Fullscreen passes must overwrite (no blend) and write depth normally; draws
      // above leave state undeclared, so set what we need through the cache.
      setBlend(false);
      setDepthMask(true);
      gl.disable(gl.DEPTH_TEST);
      bindVAO(core.skyVAO);   // reuse the empty VAO for fullscreen triangles

      const aoStr = opts && opts.ssao !== undefined ? opts.ssao : 0;
      const contactStr = opts && opts.contact !== undefined ? opts.contact : 0;
      // 0) SSAO: raw AO from the depth texture, then a separable blur to denoise.
      // Runs when EITHER knob is live: contact shadows ride in this pass, and
      // gating on AO alone silently killed the independent-looking CONTACT
      // SHADOW slider whenever AMBIENT OCCLUSION was dialled to 0. uStrength=0
      // yields ao=1 in the shader, so an AO-off/contact-on pass darkens only
      // the sun-blocked contact pixels.
      const haveAO = ssaoProg && (aoStr > 0 || contactStr > 0) && F.invProj && ssaoFBO;
      if (haveAO) {
        gl.viewport(0, 0, ssaoW, ssaoH);
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoFBO);
        useProg(ssaoProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
        gl.uniform1i(ssaoU.uDepth, 0);
        gl.uniformMatrix4fv(ssaoU.uInvProj, false, F.invProj);
        gl.uniform2f(ssaoU.uTexel, 1 / ssaoW, 1 / ssaoH);
        gl.uniform1f(ssaoU.uStrength, aoStr);
        // AO RADIUS knob: world-space sampling reach (def 0.6).
        gl.uniform1f(ssaoU.uRadius, opts && opts.tune && opts.tune.ssaoRadius != null ? opts.tune.ssaoRadius : 0.6);
        // Contact shadows ride along in the AO pass when proj + view-sun are present.
        const csOn = contactStr > 0 && F.proj && F.sunVS;
        gl.uniformMatrix4fv(ssaoU.uProj, false, F.proj || F.invProj);
        gl.uniform3fv(ssaoU.uSunVS, F.sunVS || [0, 0, -1]);
        gl.uniform1f(ssaoU.uContact, csOn ? contactStr : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // Blur H (ssaoTex -> ssaoBlurFBO) then V (ssaoBlurTex -> ssaoFBO). Half res.
        useProg(blurProg);
        gl.uniform1i(blurU.uTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoBlurFBO);
        gl.bindTexture(gl.TEXTURE_2D, ssaoTex);
        gl.uniform2f(blurU.uDir, 1 / ssaoW, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, ssaoFBO);
        gl.bindTexture(gl.TEXTURE_2D, ssaoBlurTex);
        gl.uniform2f(blurU.uDir, 0, 1 / ssaoH);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // 0b) Volumetric sun shafts: world-space march of the sun shadow map (half-res)
      // then a separable blur. Gated on the sun being up (grStr > 0) + shadows on.
      const grStr = opts && opts.godray !== undefined ? opts.godray : 0;
      const lampVol = (opts && opts.lampVol) || 0;
      const sunGR = SH.enabled && grStr > 0;
      const haveGR = godrayProg && F.invVP && godrayFBO && (sunGR || lampVol > 0);
      if (haveGR) {
        gl.viewport(0, 0, godrayW, godrayH);
        gl.bindFramebuffer(gl.FRAMEBUFFER, godrayFBO);
        useProg(godrayProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
        gl.uniform1i(godrayU.uDepth, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, SH.mapTex);
        gl.uniform1i(godrayU.uShadowMap, 1);
        gl.uniformMatrix4fv(godrayU.uInvVP, false, F.invVP);
        gl.uniformMatrix4fv(godrayU.uLightVP, false, SH.lightVP);
        gl.uniform3fv(godrayU.uEye, F.eye);
        gl.uniform3fv(godrayU.uSunDir, F.sunDir);
        gl.uniform3fv(godrayU.uSunColor, F.sunColor || [1, 1, 1]);
        gl.uniform1f(godrayU.uStr, sunGR ? grStr : 0.0);
        gl.uniform1f(godrayU.uTime, F.time);
        gl.uniform1f(godrayU.uCloudCover, F.cloud);
        gl.uniform1f(godrayU.uCloudSpeed, F.cloudSpeed);
        // Lamp volumetrics: upload the nearest-12 lamps to the eye (GR_MAX_LIGHTS
        // slots) + the haze gate. The beam march in GODRAY_FS only reads the
        // nearest 6 of them (shaders/post.js "nearest-6 lamps for beams" loop);
        // slots 6-11 are uploaded headroom with no consumer today.
        let grNL = 0, grLampIdx = -1;
        const frameLights = F.lights, frameEye = F.eye;
        if (lampVol > 0 && frameLights) {
          const L = frameLights, total = (L.length / 15) | 0;
          const ex = frameEye[0], ey = frameEye[1], ez = frameEye[2];
          for (let i = 0; i < total; i++) {
            const o = i * 15, dx = L[o] - ex, dy = L[o + 1] - ey, dz = L[o + 2] - ez;
            const d = dx * dx + dy * dy + dz * dz;
            const e = _grSel[i]; if (e) { e.d = d; e.o = o; } else _grSel[i] = { d: d, o: o };
          }
          _grSel.length = total;
          _grSel.sort(_grByD);
          grNL = Math.min(12, total);
          for (let i = 0; i < grNL; i++) {
            const o = _grSel[i].o;
            // Map the frame.lights record that has this frame's spot-shadow map
            // to its slot in THIS pass's nearest-N ordering (the two differ: the
            // lit pass indexes frame.lights directly, this pass re-sorts by eye).
            if (lampArmed && o === SH.lampIdx * 15) grLampIdx = i;
            _grPos[i*3]=L[o]; _grPos[i*3+1]=L[o+1]; _grPos[i*3+2]=L[o+2];
            _grCol[i*3]=L[o+3]; _grCol[i*3+1]=L[o+4]; _grCol[i*3+2]=L[o+5];
            _grRad[i]=L[o+6];
            _grDir[i*3]=L[o+7]; _grDir[i*3+1]=L[o+8]; _grDir[i*3+2]=L[o+9];
            _grCone[i*2]=L[o+10]; _grCone[i*2+1]=L[o+11];
            _grVolW[i]=L[o+13];
          }
          gl.uniform3fv(godrayU["uLightPos[0]"], _grPos);
          gl.uniform3fv(godrayU["uLightCol[0]"], _grCol);
          gl.uniform1fv(godrayU["uLightRad[0]"], _grRad);
          gl.uniform3fv(godrayU["uLightDir[0]"], _grDir);
          gl.uniform2fv(godrayU["uLightCone[0]"], _grCone);
          gl.uniform1fv(godrayU["uLightVolW[0]"], _grVolW);
        }
        gl.uniform1i(godrayU.uNumLights, grNL);
        gl.uniform1f(godrayU.uLampStr, lampVol);
        gl.uniform1f(godrayU.uMist, (opts && opts.mist) || 0);
        // Nearest-floodlight spot shadow: the sampler must ALWAYS point at a real
        // compare-mode depth texture on its own unit — left at the default unit 0
        // it would alias uDepth (a plain sampler2D), and two sampler TYPES on one
        // unit is a draw-time GL error even when the branch never samples. The
        // sun map is the type-compatible stand-in when the lamp map is absent.
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, SH.lampTex || SH.mapTex);
        gl.uniform1i(godrayU.uLampShadowMap, 2);
        gl.uniformMatrix4fv(godrayU.uLampShadowVP, false, SH.lampLightVP);
        gl.uniform1i(godrayU.uLampShadowIdx, grLampIdx);
        gl.activeTexture(gl.TEXTURE0);
        // GOD-RAY FOCUS / HAZE knobs (defaults reproduce the shipped shaft phase).
        const GT = opts && opts.tune || null;
        gl.uniform1f(godrayU.uHgAniso, GT && GT.godrayAniso != null ? GT.godrayAniso : 0.60);
        gl.uniform1f(godrayU.uHgFloor, GT && GT.godrayFloor != null ? GT.godrayFloor : 0.020);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        useProg(blurProg);
        gl.uniform1i(blurU.uTex, 0);
        gl.activeTexture(gl.TEXTURE0);
        // Double separable blur (H+V twice): the march + shadow slices otherwise
        // leave thin stripe artifacts that read as "random tiny rays" — two passes
        // turn the shafts into wide, soft volumes.
        for (let bp = 0; bp < 2; bp++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, godrayBlurFBO);
          gl.bindTexture(gl.TEXTURE_2D, godrayTex);
          gl.uniform2f(blurU.uDir, (1 + bp) / godrayW, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindFramebuffer(gl.FRAMEBUFFER, godrayFBO);
          gl.bindTexture(gl.TEXTURE_2D, godrayBlurTex);
          gl.uniform2f(blurU.uDir, 0, (1 + bp) / godrayH);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }

      // 1+2) bright-pass + mip-chain bloom. The whole ~10-14 fullscreen-pass chain
      //    only feeds the composite's bloom sampler, which is scaled by bloomAmt —
      //    so when bloom is off (bloomAmt <= 0) skip it all and let the composite
      //    read blackTex (bound below) for a zero contribution.
      const nLv = bloomLv.length;
      if (bloomAmt > 0) {
        // 1) bright-pass scene -> bloom level 0 (half res)
        gl.viewport(0, 0, bloomLv[0].w, bloomLv[0].h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomLv[0].fbo);
        useProg(brightProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTex);
        gl.uniform1i(brightU.uScene, 0);
        gl.uniform1f(brightU.uThreshold, threshold);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 2) mip-chain bloom: progressive 13-tap downsample to the smallest level,
        //    then additive 9-tap tent upsample back up — each level contributes one
        //    octave of blur, so bright sources get a tight core AND a wide soft halo.
        useProg(downProg);
        gl.uniform1i(downU.uTex, 0);
        for (let i = 1; i < nLv; i++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, bloomLv[i].fbo);
          gl.viewport(0, 0, bloomLv[i].w, bloomLv[i].h);
          gl.bindTexture(gl.TEXTURE_2D, bloomLv[i - 1].tex);
          gl.uniform2f(downU.uTexel, 1 / bloomLv[i - 1].w, 1 / bloomLv[i - 1].h);
          // Karis partial luma weighting on the FIRST downsample only — that's
          // where sub-pixel HDR spikes (the bloom "fireflies") get averaged in;
          // later mips are already low-pass and keep the plain 13-tap kernel.
          gl.uniform1f(downU.uKaris, i === 1 ? 1 : 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        useProg(upProg);
        gl.uniform1i(upU.uTex, 0);
        // BLOOM SPREAD knob: widen/tighten every octave's tent radius uniformly.
        gl.uniform1f(upU.uSpread, opts && opts.tune && opts.tune.bloomSpread != null ? opts.tune.bloomSpread : 1);
        for (let i = nLv - 1; i >= 1; i--) {
          // Intermediate levels accumulate (ONE, ONE) so every octave sums; the FINAL
          // pass into level 0 OVERWRITES instead — level 0 still holds the sharp
          // unblurred bright-pass, and adding onto it would re-inject the scene's
          // bright areas at full sharpness (large lamp-lit surfaces wash out).
          const last = i === 1;
          setBlend(!last);
          if (!last) gl.blendFunc(gl.ONE, gl.ONE);
          gl.bindFramebuffer(gl.FRAMEBUFFER, bloomLv[i - 1].fbo);
          gl.viewport(0, 0, bloomLv[i - 1].w, bloomLv[i - 1].h);
          gl.bindTexture(gl.TEXTURE_2D, bloomLv[i].tex);
          gl.uniform2f(upU.uTexel, 1 / bloomLv[i].w, 1 / bloomLv[i].h);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        setBlend(false);
      }

      // 3) composite — to the LDR target when FXAA is on (it resolves to screen),
      //    else straight to the screen.
      const useFxaa = fxaaProg && ldrFBO && ldrTex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, useFxaa ? ldrFBO : null);
      gl.viewport(0, 0, width, height);
      useProg(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(compU.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      // When bloom is off the mip chain was skipped and bloomLv[0] holds a stale
      // frame — bind the 1×1 black source so the composite reads zero contribution.
      gl.bindTexture(gl.TEXTURE_2D, bloomAmt > 0 ? bloomLv[0].tex : blackTex);
      gl.uniform1i(compU.uBloom, 1);
      // Normalise the mip-chain accumulation (level 0 holds nLv-1 summed blur
      // octaves) so the hand-tuned per-time-of-day bloom amounts keep their overall
      // energy — same brightness budget, spread over a wider, smoother halo.
      gl.uniform1f(compU.uBloomAmt, bloomAmt * 1.25 / Math.max(nLv - 1, 1));
      // AO: post-blur result is in ssaoTex; when AO is off bind a white 1×1 so the
      // shader's `c *= texture(uSSAO).r` is a no-op.
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, haveAO ? ssaoTex : whiteTex);
      gl.uniform1i(compU.uSSAO, 2);
      // Half-res AO grid texel for the composite's depth-aware bilateral upsample;
      // zeroed when AO is off so the shader takes the plain (1×1 white) fetch.
      gl.uniform2f(compU.uAOTexel, haveAO ? 1 / ssaoW : 0, haveAO ? 1 / ssaoH : 0);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, haveGR ? godrayTex : blackTex);
      gl.uniform1i(compU.uGodray, 3);
      // Project sun direction to screen UV for lens flare
      let sunUV = [-2, -2], flareStr = 0, sunShaft = 0;
      if (F.sunDir && F.viewProj) {
        const s = F.sunDir;
        // Treat sun as infinitely distant: clip pos = VP * (sunDir, 0)
        const vp = F.viewProj;
        const cx = vp[0]*s[0] + vp[4]*s[1] + vp[8]*s[2];
        const cy = vp[1]*s[0] + vp[5]*s[1] + vp[9]*s[2];
        const cw = vp[3]*s[0] + vp[7]*s[1] + vp[11]*s[2];
        if (cw > 0) {
          sunUV = [cx / cw * 0.5 + 0.5, cy / cw * 0.5 + 0.5];
          // Lens flare peaks at GOLDEN HOUR (low sun), fading as the sun climbs —
          // the opposite of the old height-scaled version that vanished at sunset.
          // Gate flare + shafts by the sun's actual BRIGHTNESS, not just elevation:
          // at night the key light is dim moonlight kept above the horizon for sky
          // glow, and without this gate the radial pass streaked every bright lamp
          // head toward the moon — random "beams from the sky".
          const _sl = F.sunColor ? Math.max(F.sunColor[0], F.sunColor[1], F.sunColor[2]) : 1;
          const _sunGate = Math.min(1, Math.max(0, (_sl - 0.35) / 0.45));
          if (s[1] > -0.02) {
            const golden = 1.0 - Math.min(Math.max(s[1], 0) / 0.45, 1.0);
            // Lower floor + peak (was 0.30 + golden*0.55, peaking ~0.85): combined
            // with the streak shape above, that washed the whole frame during
            // ordinary dusk driving. The shader-side soft-clip already taming the
            // wash, so this just keeps typical dusk flare present but subtle.
            flareStr = (0.14 + golden * 0.30) * _sunGate;
          }
          if (s[1] > 0.05) sunShaft = s[1] * 0.8 * _sunGate;
        }
      }
      gl.uniform2fv(compU.uSunUV, sunUV);
      // LENS FLARE knob scales the whole sun/lamp flare + ghost stack (def 1).
      gl.uniform1f(compU.uFlareStr, flareStr * (opts && opts.flareMul != null ? opts.flareMul : 1));
      const exposure = opts && opts.exposure !== undefined ? opts.exposure : 1.0;
      gl.uniform1f(compU.uExposure, exposure);
      // SCREEN SUN-SHAFT knob scales the radial crepuscular pass (def 1 = as-shipped).
      gl.uniform1f(compU.uSunShaft, sunShaft * (opts && opts.tune && opts.tune.sunShaftMul != null ? opts.tune.sunShaftMul : 1));
      // Cinematic split-tone grade (neutral by default → existing look unchanged).
      const grade = opts && opts.grade;
      gl.uniform3fv(compU.uGradeShadow, grade && grade.shadow ? grade.shadow : [1, 1, 1]);
      gl.uniform3fv(compU.uGradeHi, grade && grade.hi ? grade.hi : [1, 1, 1]);
      gl.uniform1f(compU.uGradeStr, grade && grade.str !== undefined ? grade.str : 0);
      // Live colour-grade tunables (IMAGE & COLOUR panel); defaults reproduce the
      // shipped grade so a missing tune object changes nothing.
      const CT = opts && opts.tune || null;
      gl.uniform4f(compU.uTone0,
        CT && CT.blacks != null ? CT.blacks : 0,
        CT && CT.shadows != null ? CT.shadows : 0,
        CT && CT.midtones != null ? CT.midtones : 0,
        CT && CT.highlights != null ? CT.highlights : 0);
      gl.uniform4f(compU.uTone1,
        CT && CT.whites != null ? CT.whites : 0,
        CT && CT.toe != null ? CT.toe : 0,
        CT && CT.shoulder != null ? CT.shoulder : 0, 0);
      gl.uniform3f(compU.uLift,
        CT && CT.liftR != null ? CT.liftR : 0,
        CT && CT.liftG != null ? CT.liftG : 0,
        CT && CT.liftB != null ? CT.liftB : 0);
      gl.uniform3f(compU.uGamma,
        CT && CT.gammaR != null ? CT.gammaR : 1,
        CT && CT.gammaG != null ? CT.gammaG : 1,
        CT && CT.gammaB != null ? CT.gammaB : 1);
      gl.uniform3f(compU.uGain,
        CT && CT.gainR != null ? CT.gainR : 1,
        CT && CT.gainG != null ? CT.gainG : 1,
        CT && CT.gainB != null ? CT.gainB : 1);
      gl.uniform1f(compU.uContrast,   CT && CT.contrast   != null ? CT.contrast   : 1.12);
      gl.uniform1f(compU.uVibrance,   CT && CT.vibrance   != null ? CT.vibrance   : 0.20);
      gl.uniform1f(compU.uSaturation, CT && CT.saturation != null ? CT.saturation : 1.0);
      // Skip the whole HDR lift/gamma/gain/tone block when every knob sits at
      // neutral (the shipped default): applyHdrGrade is then a mathematical
      // no-op, but it still cost ~20 ALU incl. 4-5 transcendentals on every
      // full-screen pixel of every frame.
      const _hg = CT && (
        (CT.blacks || 0) !== 0 || (CT.shadows || 0) !== 0 || (CT.midtones || 0) !== 0 ||
        (CT.highlights || 0) !== 0 || (CT.whites || 0) !== 0 || (CT.toe || 0) !== 0 ||
        (CT.shoulder || 0) !== 0 || (CT.liftR || 0) !== 0 || (CT.liftG || 0) !== 0 ||
        (CT.liftB || 0) !== 0 || (CT.gammaR != null && CT.gammaR !== 1) ||
        (CT.gammaG != null && CT.gammaG !== 1) || (CT.gammaB != null && CT.gammaB !== 1) ||
        (CT.gainR != null && CT.gainR !== 1) || (CT.gainG != null && CT.gainG !== 1) ||
        (CT.gainB != null && CT.gainB !== 1));
      gl.uniform1f(compU.uHdrGradeOn, _hg ? 1.0 : 0.0);
      gl.uniform1f(compU.uTint,       CT && CT.tint       != null ? CT.tint       : 0.0);
      gl.uniform1f(compU.uVignette,   CT && CT.vignette   != null ? CT.vignette   : 0.80);
      gl.uniform1f(compU.uVigSoft,    CT && CT.vignetteSoft != null ? CT.vignetteSoft : 0.35);
      gl.uniform1f(compU.uBloomKnee,  CT && CT.bloomKnee  != null ? CT.bloomKnee  : 0.5);
      gl.uniform1f(compU.uCarReflect, CT && CT.carReflect != null ? CT.carReflect : 0.05);
      gl.uniform1f(compU.uCarGloss, CT && CT.carGloss != null ? CT.carGloss : 1.0);
      // IMAGE & COLOUR extras (all default to a no-op reproducing the shipped look).
      gl.uniform1f(compU.uChromAb,    CT && CT.chromAb    != null ? CT.chromAb    : 0.0);
      gl.uniform1f(compU.uGrain,      CT && CT.grain      != null ? CT.grain      : 0.0);
      gl.uniform1f(compU.uGrainTime,  F.time);
      gl.uniform1f(compU.uSharpen,    CT && CT.sharpen    != null ? CT.sharpen    : 0.0);
      gl.uniform1f(compU.uBlackLift,  CT && CT.blackLift  != null ? CT.blackLift  : 0.005);
      gl.uniform1f(compU.uWhitePoint, CT && CT.whitePoint != null ? CT.whitePoint : 1.0);
      // ACES TONE CURVE knobs (defaults = the shipped Narkowicz coefficients).
      gl.uniform1f(compU.uAcesA, CT && CT.acesA != null ? CT.acesA : 2.51);
      gl.uniform1f(compU.uAcesB, CT && CT.acesB != null ? CT.acesB : 0.03);
      gl.uniform1f(compU.uAcesC, CT && CT.acesC != null ? CT.acesC : 2.43);
      gl.uniform1f(compU.uAcesD, CT && CT.acesD != null ? CT.acesD : 0.59);
      gl.uniform1f(compU.uAcesE, CT && CT.acesE != null ? CT.acesE : 0.14);
      gl.uniform1f(compU.uSpeedBlur,  opts && opts.speedBlur != null ? opts.speedBlur : 0.0);
      // SUN-SHAFT REACH / FLARE STREAK knobs (defaults reproduce the shipped look).
      gl.uniform1f(compU.uShaftDecay,  CT && CT.sunShaftDecay != null ? CT.sunShaftDecay : 0.82);
      gl.uniform1f(compU.uFlareStreak, CT && CT.flareStreak   != null ? CT.flareStreak   : 7.0);
      gl.uniform1f(compU.uFlareStreak2, CT && CT.flareStreak2 != null ? CT.flareStreak2  : 0.5);
      // EXHAUST HEAT HAZE: screen-anchored shimmer plume (opts.haze = {u, v, str}
      // computed by the caller from the player tailpipe projection; absent = off).
      const hz = opts && opts.haze;
      gl.uniform2f(compU.uHazeUV, hz ? hz.u : -9, hz ? hz.v : -9);
      gl.uniform1f(compU.uHazeStr, hz ? hz.str : 0);
      gl.uniform1f(compU.uHazeTime, F.time);
      gl.uniform1f(compU.uSsrThick,   CT && CT.ssrThick   != null ? CT.ssrThick   : 0.20);
      // LENS DIRT: bind the procedural smudge map (black fallback = veil term is
      // zero even if the knob is up, so a failed canvas init degrades silently).
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, dirtTex || blackTex);
      gl.uniform1i(compU.uDirt, 5);
      gl.uniform1f(compU.uLensDirt, CT && CT.lensDirt != null ? CT.lensDirt : 0.15);
      // uReflTexel drives both SSR and SHARPEN, so upload it every frame (not only
      // inside the haveRefl block) — otherwise sharpen samples with a stale texel.
      gl.uniform2f(compU.uReflTexel, 1 / width, 1 / height);
      // Camera-aware SSR screen extent: a low onboard eye (cockpit/hood) sees the
      // wet road climb higher up the frame and start right at the nose, so game.js
      // raises the top cutoff + pulls the near-field fade in for those cams. Every
      // frame (defaults reproduce the shipped chase framing when opts omit them).
      gl.uniform1f(compU.uSsrTopUV, opts && opts.ssrTopUV != null ? opts.ssrTopUV : 0.62);
      gl.uniform1f(compU.uSsrNear,  opts && opts.ssrNear  != null ? opts.ssrNear  : -2.5);
      // Wet-road screen-space reflection: needs depth + view/proj + world-up-in-view.
      const reflStr = (opts && opts.reflect) || 0;
      // Depth is ALWAYS bound: the shader's car-paint branch fires on the carPx
      // tag alone, so on a probe-less path (setup preview never sets frame.proj)
      // it used to sample whatever texture unit 4 last held, against the
      // PREVIOUS race's stale matrices. uSsrOk gates the whole branch instead.
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
      gl.uniform1i(compU.uDepth, 4);
      const haveRefl = F.invProj && F.proj && F.upVS;
      if (haveRefl) {
        gl.uniformMatrix4fv(compU.uInvProj, false, F.invProj);
        gl.uniformMatrix4fv(compU.uProj, false, F.proj);
        gl.uniform3fv(compU.uUpVS, F.upVS);
        gl.uniform3fv(compU.uReflSkyHi, F.skyHi || [0.05, 0.06, 0.09]);
        gl.uniform3fv(compU.uReflSkyLo, F.skyLo || [0.02, 0.025, 0.05]);
      }
      gl.uniform1f(compU.uSsrOk, haveRefl ? 1 : 0);
      gl.uniform1f(compU.uReflect, haveRefl ? reflStr : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 4) FXAA resolve: edge-AA the tonemapped LDR image straight to the screen.
      if (useFxaa) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        useProg(fxaaProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ldrTex);
        gl.uniform1i(fxaaU.uTex, 0);
        gl.uniform2f(fxaaU.uTexel, 1 / width, 1 / height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      bindVAO(null);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.DEPTH_TEST);

      // Discard depth buffers we never read across frames (regenerated every frame
      // by the geometry pass). On tiled mobile GPUs this frees the tiler from
      // storing depth back to memory each frame — pure bandwidth/tile-memory saving
      // with no visual effect. sceneDepth was already consumed by SSAO/SSR/god-ray
      // above; the default framebuffer's depth is unused (post is a fullscreen blit).
      if (gl.invalidateFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH]);
      }

      core.gpuTimerEnd();
    }

    postEnabled = setup();   // best-effort; false -> render straight to screen

    return {
      enabled: () => postEnabled,
      hdrOk: () => colorType === gl.HALF_FLOAT,
      msaa: () => msaaSamples,
      createTargets,
      bindSceneTarget,
      present,
    };
  }

  return { init };
})();
