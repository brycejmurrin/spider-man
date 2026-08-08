/* Web-Slinger — entry: boot, the fixed-timestep loop, frame assembly and the
   draw path. Deliberately THIN (the module-size ratchet holds it there): the
   engine lives in js/render/, the city in js/city/, gameplay in js/game/.

   The loop and render sequence follow Apex 26's driver recipe exactly:
   fixed 1/60 physics with a 5-substep cap and render interpolation; camera
   damping at clamped frame dt; snap-cached static sun shadow + per-frame
   dynamic map for the hero; begin -> sky -> draws -> glow -> present. */
import { Log } from "./log.js";
import { M4 } from "./mat4.js";
import { GLX } from "./render/glx.js";
import { Assets } from "./render/assets.js";
import { buildCity, CITY } from "./city/citygen.js";
import { createHero } from "./game/hero.js";
import { HeroConsts } from "./game/hero-consts.js";
import { buildHero, pose, SEGMENTS, wristR } from "./hero/hero3d.js";
import { createWebline } from "./game/webline.js";
import { createCameras, CAM_MODES } from "./game/cameras.js";
import { Input } from "./game/input.js";
import { createHud } from "./game/hud.js";
import { GameAudio } from "./game/audio.js";
import { store } from "./game/store.js";
import { createApi } from "./game/spidey-api.js";

(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const canvas = $("game");

  // ── renderer ─────────────────────────────────────────────────────────────
  if (!GLX.init(canvas)) { $("nogl").hidden = false; return; }
  const gfx = GLX;
  Assets.init(gfx);
  Assets.load();          // baked PBR pack — never awaited, never fatal

  // ── frame scratch (declared before loadCity: it invalidates the cache) ───
  const camUp = new Float32Array(3);
  const mProj = new Float32Array(16), mView = new Float32Array(16),
        mVP = new Float32Array(16), mInvProj = new Float32Array(16), mInvVP = new Float32Array(16);
  const mLView = new Float32Array(16), mLProj = new Float32Array(16), mLVP = new Float32Array(16);
  const mCView = new Float32Array(16), mCProj = new Float32Array(16), mCVP = new Float32Array(16);
  const MAT_IDENT = M4.ident();
  const shadowCtr = new Float32Array(3);
  const shadowSnap = { x: Infinity, z: Infinity, sun: 0 };

  // ── city ─────────────────────────────────────────────────────────────────
  let citySeed = store.get("citySeed", 42);
  let city = null;
  const meshes = {};
  function loadCity(seed, night) {
    if (meshes.ground) {
      gfx.freeMesh(meshes.ground);
      (gfx.freeChunkedMesh || gfx.freeMesh)(meshes.props);
      (gfx.freeChunkedMesh || gfx.freeMesh)(meshes.glass);
    }
    city = null;                        // drop before building (memory)
    city = buildCity(seed, { night });
    meshes.ground = gfx.createMesh(city.ground);
    meshes.props = gfx.createChunkedMesh
      ? gfx.createChunkedMesh(city.out, 72) : gfx.createMesh(city.out);
    meshes.glass = gfx.createChunkedMesh
      ? gfx.createChunkedMesh(city.glassBuf, 72) : gfx.createMesh(city.glassBuf);
    shadowSnap.x = Infinity;            // invalidate the shadow cache
    Log.info("game", `city seed=${seed} buildings=${city.stats.buildings}`);
  }
  loadCity(citySeed, true);

  // ── hero ─────────────────────────────────────────────────────────────────
  const hero = createHero(city.colliders);
  const heroGeo = buildHero();
  const heroMeshes = {};
  for (const s of SEGMENTS) heroMeshes[s] = gfx.createMesh(heroGeo[s]);
  const heroLocals = {};
  for (const s of SEGMENTS) heroLocals[s] = new Float32Array(16);
  // start on a mid-town rooftop facing +z
  const startB = city.colliders.list.find((b) => b.y1 > 50 && b.y1 < 90) || city.colliders.list[0];
  hero.reset(startB.cx, startB.y1, startB.cz - 2, 0, 0);
  let rPrev = [hero.p[0], hero.p[1], hero.p[2]], rPrevHead = 0;

  const webline = createWebline(gfx);
  const cams = createCameras(city.colliders);
  const hud = createHud({
    hud: $("hud"), speed: $("speed-v"), alt: $("alt-v"), mode: $("mode-v"),
    track: $("track"), trackV: $("track-v"),
  });

  // ── frame state (the night-city preset distilled from Apex 26) ───────────
  const frame = {
    viewProj: mVP, proj: mProj, invProj: mInvProj, invViewProj: mInvVP,
    eye: cams.eye,
    sunDir: [0.42, 0.66, 0.36],
    sunColor: [0.12, 0.14, 0.22],           // faint cool moonlight key
    ambientSky: [0.034, 0.034, 0.049],      // neon-city night band, mid
    ambientGround: [0.016, 0.015, 0.022],
    skyZenith: [0.01, 0.02, 0.05],
    skyHorizon: [0.04, 0.03, 0.06],
    fogColor: [0.015, 0.017, 0.035],
    fogDensity: 0.0032,
    fogHeight: 0.012,
    exposure: 0.86,
    moonK: 1,                               // clear night — keep moon shadows alive
    groundMist: 0.15, lampFog: 0.4,
    time: 0, cloud: 0.22, cloudSpeed: 1, wetness: 0,
    cullDist: 900, shadowCtr, lights: null, tune: null,
  };
  {
    const l = Math.hypot(...frame.sunDir);
    frame.sunDir = frame.sunDir.map((v) => v / l);
  }
  const frameSky = {
    invViewProj: mInvVP,
    zenith: frame.skyZenith, horizon: frame.skyHorizon,
    sunDir: frame.sunDir, sunColor: [1.0, 0.95, 0.84],
    stars: 1, moon: 0.85, cloud: 0.22, time: 0,
    cityGlow: [0.050, 0.038, 0.055], cityGlowReach: 1,
  };
  // Post chain. `godray: 0` does NOT disable the volumetric pass — that pass is
  // gated on (sun || lampVol), and lampVol is what puts haze in the lamp cones,
  // which is the single strongest "this is a night city" cue. Blacks are LIFTED
  // on purpose: a lit city has no true black, and crushing it reads as
  // underexposed day rather than night.
  const presentOpts = {
    exposure: 0.82, bloom: 0.62, threshold: 0.75, ssao: 0.35, contact: 0.35,
    godray: 0, lampVol: 0.5, mist: 0.26, reflect: 0.55,
    flareMul: 0, speedBlur: 0,
    tune: { blackLift: 0.015, contrast: 1.06, vibrance: 0.28, saturation: 1.04,
            chromAb: 0.20, grain: 0.03, lensDirt: 0.20, vignette: 0.85,
            vignetteSoft: 0.40, bloomKnee: 0.6 },
    // split tone: cool shadows, warm highlights — near-neutral grading is what
    // makes a night frame look like a desaturated photograph of a day frame
    grade: { shadow: [0.86, 0.96, 1.14], hi: [1.06, 0.98, 0.93], str: 0.40 },
  };

  // Per-frame light cull: nearest lamps to the eye, capped under the shader's
  // 32, with ONE slot reserved for a hero follow light. A character above lamp
  // height has nothing lighting him at night — he renders as a black cut-out
  // against his own city. Every game solves this with a dedicated character
  // light rather than by raising ambient (which would grey out the night).
  const LIGHT_CAP = 28;
  const HERO_SLOT = LIGHT_CAP - 1;
  const lightBuf = new Float32Array(LIGHT_CAP * 15);
  function packLights() {
    const e = cams.eye;
    const lamps = city.lamps;
    const scored = lamps.map((l, i) => {
      const dx = l.x - e[0], dz = l.z - e[2];
      return [dx * dx + dz * dz, i];
    }).sort((a, b) => a[0] - b[0]);
    const n = Math.min(HERO_SLOT, scored.length);
    for (let k = 0; k < n; k++) {
      const l = lamps[scored[k][1]], o = k * 15;
      lightBuf[o] = l.x; lightBuf[o + 1] = l.y; lightBuf[o + 2] = l.z;
      lightBuf[o + 3] = l.col[0]; lightBuf[o + 4] = l.col[1]; lightBuf[o + 5] = l.col[2];
      lightBuf[o + 6] = l.rad;
      lightBuf[o + 7] = l.dir[0]; lightBuf[o + 8] = l.dir[1]; lightBuf[o + 9] = l.dir[2];
      lightBuf[o + 10] = l.cosIn; lightBuf[o + 11] = l.cosOut;
      lightBuf[o + 12] = l.bleed; lightBuf[o + 13] = l.volW; lightBuf[o + 14] = l.glareW;
    }
    // hero follow light: a soft cool key just above and behind him, sized so it
    // never washes the street (radius 7 m, no glare billboard, no volumetrics)
    {
      const o = n * 15;
      lightBuf[o] = hero.p[0] - Math.sin(hero.head) * 1.2;
      lightBuf[o + 1] = hero.p[1] + 3.2;
      lightBuf[o + 2] = hero.p[2] - Math.cos(hero.head) * 1.2;
      lightBuf[o + 3] = 26; lightBuf[o + 4] = 27; lightBuf[o + 5] = 34;
      lightBuf[o + 6] = 7;
      lightBuf[o + 7] = 0; lightBuf[o + 8] = -1; lightBuf[o + 9] = 0;
      lightBuf[o + 10] = 0.2; lightBuf[o + 11] = -0.9;   // near-omni
      lightBuf[o + 12] = 0.9; lightBuf[o + 13] = 0; lightBuf[o + 14] = 0;
    }
    frame.lights = lightBuf.subarray(0, (n + 1) * 15);
  }

  // ── state ────────────────────────────────────────────────────────────────
  let state = "menu";                       // menu | play
  let paused = false, headlessMode = false, frozen = false;
  let renderAlpha = 1, lastFrame = 0, physAcc = 0;
  const PHYS_DT = 1 / 60;
  let testInput = null;                     // __spidey.act/setInput override

  function inputFrame() {
    if (testInput) return testInput;
    // camera-relative move: W = camera forward (projected), A/D strafe
    const mx = Input.moveX(), mz = Input.moveZ();
    const fy = Math.atan2(hero.p[0] - cams.eye[0], hero.p[2] - cams.eye[2]);
    const fx = Math.sin(fy), fz = Math.cos(fy);
    return {
      dirX: fx * mz + fz * mx, dirZ: fz * mz - fx * mx,
      swing: Input.swing(), dive: Input.dive(),
      jump: Input.consumeJump(), zip: Input.consumeZip(),
    };
  }

  function update(dt) {
    const inp = inputFrame();
    const wasState = hero.state, wasAnchor = hero.anchor;
    hero.step(inp, dt);
    // FX events (render/audio only — never feed back into physics)
    if (hero.state === "swing" && wasState !== "swing") GameAudio.thwip();
    if (hero.landed > 0) {
      const hard = Math.min(1, hero.landed / 24);
      if (hard > 0.2) { cams.addShake(hard * 0.7); GameAudio.land(hard); }
      hero.landed = 0;
    }
    if (hero.anchor && hero.anchor !== wasAnchor) webRebuildT = 0;
  }

  // ── render ───────────────────────────────────────────────────────────────
  let webRebuildT = 0, frameNo = 0;
  const _wrist = [0, 0, 0];
  const rootMat = new Float32Array(16);
  const segWorld = new Float32Array(16);
  // Cloth, not plastic: 0.55/0.6 read as vinyl (docs/research/HERO-MODEL.md).
  const heroOpts = { roughness: 0.82, specular: 0.28, emissive: 0.10 };

  function heroRoot(px, py, pz, head) {
    // yaw-only root; pitch/roll live in the segment poses
    const c = Math.cos(head), s = Math.sin(head);
    rootMat[0] = c; rootMat[1] = 0; rootMat[2] = -s; rootMat[3] = 0;
    rootMat[4] = 0; rootMat[5] = 1; rootMat[6] = 0; rootMat[7] = 0;
    rootMat[8] = s; rootMat[9] = 0; rootMat[10] = c; rootMat[11] = 0;
    rootMat[12] = px; rootMat[13] = py; rootMat[14] = pz; rootMat[15] = 1;
  }

  function drawWorld() {
    gfx.draw(meshes.ground, MAT_IDENT, { roughness: 0.85, detail: 0.05 });
    if (frame.lights) gfx.drawGlow(frame.lights, 0.12);
    gfx.drawChunked(meshes.props, MAT_IDENT, { emissive: 0.7, detail: 0.25 });
    gfx.drawChunked(meshes.glass, MAT_IDENT, { roughness: 0.12, metalness: 0.4, specular: 1 });
  }

  function render(dt) {
    if (headlessMode) return;
    gfx.resize();
    frameNo++;

    // interpolated hero pose
    const ix = rPrev[0] + (hero.p[0] - rPrev[0]) * renderAlpha;
    const iy = rPrev[1] + (hero.p[1] - rPrev[1]) * renderAlpha;
    const iz = rPrev[2] + (hero.p[2] - rPrev[2]) * renderAlpha;
    let dh = hero.head - rPrevHead;
    if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
    const ihead = rPrevHead + dh * renderAlpha;

    // camera
    const sub = { p: [ix, iy, iz], v: hero.v, head: ihead, speed: hero.speed, state: hero.state };
    if (state === "menu") {
      const t = performance.now() * 0.0045;
      const R = CITY.SPAN * 0.42;
      cams.eye[0] += (Math.sin(t * 0.1) * R - cams.eye[0]) * 0.02;
      cams.eye[1] += (150 - cams.eye[1]) * 0.02;
      cams.eye[2] += (Math.cos(t * 0.1) * R - cams.eye[2]) * 0.02;
      cams.tgt[0] += (0 - cams.tgt[0]) * 0.05; cams.tgt[1] += (60 - cams.tgt[1]) * 0.05; cams.tgt[2] += (0 - cams.tgt[2]) * 0.05;
    } else if (!frozen) {
      const [ldx, ldy] = Input.look();
      if (ldx || ldy) cams.orbit(ldx, ldy);
      cams.setRecentreHold(Input.lookHeld());
      cams.tick(sub, dt);
    }

    // matrices (+ rolled up vector, the Apex inline)
    const fovY = Math.min(cams.fov * Math.PI / 180,
      2 * Math.atan(Math.tan(86 * Math.PI / 360) / Math.max(gfx.aspect, 1e-4)));
    M4.perspectiveTo(mProj, fovY, gfx.aspect, 0.5, 2000);
    {
      let bx = cams.eye[0] - cams.tgt[0], by = cams.eye[1] - cams.tgt[1], bz = cams.eye[2] - cams.tgt[2];
      const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
      let rx = bz, ry = 0, rz = -bx;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; rz /= rl;
      const s = Math.sin(cams.roll);
      let ux = rx * s, uy = 1 + ry * s, uz = rz * s;
      const ul = Math.hypot(ux, uy, uz) || 1;
      camUp[0] = ux / ul; camUp[1] = uy / ul; camUp[2] = uz / ul;
    }
    M4.lookAtTo(mView, cams.eye, cams.tgt, camUp);
    M4.mulTo(mVP, mProj, mView);
    M4.invertTo(mInvProj, mProj);
    M4.invertTo(mInvVP, mVP);
    frame.eye = cams.eye;
    frame.time = performance.now() / 1000;
    frameSky.time = frame.time;
    packLights();

    // shadow anchor: ground level ahead of the camera (target height, not eye —
    // the receiver-distance fade erases shadows anchored at an aerial eye)
    shadowCtr[0] = cams.tgt[0]; shadowCtr[1] = Math.max(0, cams.tgt[1] - 10); shadowCtr[2] = cams.tgt[2];

    // static sun/moon shadow — snap-cached on the light's own axes
    {
      const sd = frame.sunDir;
      const up = Math.abs(sd[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
      const sBox = 180;                     // city block scale, not a race circuit
      const step = sBox / 4;
      const zx = sd[0], zy = sd[1], zz = sd[2];
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      const cx = shadowCtr[0], cy = shadowCtr[1], cz = shadowCtr[2];
      const lu = Math.round((xx * cx + xy * cy + xz * cz) / step) * step;
      const lv = Math.round((yx * cx + yy * cy + yz * cz) / step) * step;
      if (lu !== shadowSnap.x || lv !== shadowSnap.z) {
        shadowSnap.x = lu; shadowSnap.z = lv;
        const lw = zx * cx + zy * cy + zz * cz;
        const wx = xx * lu + yx * lv + zx * lw, wy = xy * lu + yy * lv + zy * lw, wz = xz * lu + yz * lv + zz * lw;
        M4.lookAtTo(mLView, [wx + sd[0] * 300, wy + sd[1] * 300, wz + sd[2] * 300], [wx, wy, wz], up);
        M4.orthoTo(mLProj, -sBox, sBox, -sBox, sBox, 1.0, 620);
        M4.mulTo(mLVP, mLProj, mLView);
        gfx.shadowBegin(mLVP);
        gfx.castShadow(meshes.ground, MAT_IDENT);
        gfx.castShadowChunked(meshes.props, MAT_IDENT);
        gfx.shadowEnd();
      }
    }
    // Pose FIRST, then shadow, then draw — the shadow pass and the colour pass
    // must show the same hero. Posing after the shadow cast meant the shadow
    // used the PREVIOUS frame's locals.
    heroRoot(ix, iy, iz, ihead);
    const tetherPitch = hero.anchor
      ? Math.atan2(Math.hypot(hero.anchor[0] - ix, hero.anchor[2] - iz), hero.anchor[1] - iy) : 0;
    // Yaw to the anchor in HERO space: which side the web is on. pose() has
    // documented this parameter from the start and never received it.
    let tetherYaw = 0;
    if (hero.anchor) {
      const ay = Math.atan2(hero.anchor[0] - ix, hero.anchor[2] - iz) - ihead;
      tetherYaw = Math.atan2(Math.sin(ay), Math.cos(ay));   // wrap to [-pi, pi]
    }
    pose(heroLocals, hero.state, hero.state === "ground" ? frame.time : hero.airTime,
      hero.speed, { tetherPitch, tetherYaw, diving: hero.v[1] < -20, dt });

    // dynamic map: the hero, every frame (carArmed clears each present)
    if (gfx.carShadowBegin) {
      const sd = frame.sunDir;
      const up = Math.abs(sd[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
      M4.lookAtTo(mCView, [shadowCtr[0] + sd[0] * 150, shadowCtr[1] + sd[1] * 150, shadowCtr[2] + sd[2] * 150], shadowCtr, up);
      M4.orthoTo(mCProj, -42, 42, -42, 42, 1.0, 320);
      M4.mulTo(mCVP, mCProj, mCView);
      gfx.carShadowBegin(mCVP);
      // Every segment, POSED. This cast heroMeshes.torso with rootMat alone —
      // but the pelvis offset lives in heroLocals.torso, so the shadow was an
      // un-posed box floating ~0.38 m up, and 9 of 10 segments cast nothing.
      for (const s of SEGMENTS) {
        M4.mulTo(segWorld, rootMat, heroLocals[s]);
        gfx.castShadow(heroMeshes[s], segWorld);
      }
      gfx.carShadowEnd();
    }

    if (gfx.begin(frame) === false) return;   // context lost
    gfx.drawSky(frameSky);
    drawWorld();

    // hero: segment draws (posed above)
    for (const s of SEGMENTS) {
      M4.mulTo(segWorld, rootMat, heroLocals[s]);
      gfx.draw(heroMeshes[s], segWorld, heroOpts);
    }

    // webline
    if (hero.anchor) {
      webRebuildT -= dt;
      if (webRebuildT <= 0) {
        wristR(_wrist, rootMat, heroLocals);
        webline.rebuild(_wrist, hero.anchor);
        webRebuildT = 1 / 30;               // rebuild at 30 Hz, draw every frame
      }
      webline.draw(MAT_IDENT);
    } else if (webline.active) webline.free();

    gfx.present(presentOpts);
  }

  // ── loop ─────────────────────────────────────────────────────────────────
  function tick(now) {
    requestAnimationFrame(tick);
    try { tickBody(now); }
    catch (e) {
      if (!tick._reported && typeof window.__spideyReportError === "function") {
        tick._reported = true; window.__spideyReportError("tick", e);
      }
      throw e;
    }
  }
  function tickBody(now) {
    const dt = Math.min((now - lastFrame) / 1000, 1 / 4);
    lastFrame = now;
    Input.poll();
    if (paused) { Input.clearEdges(); return; }
    if (Input.consumeCameraCycle()) cams.cycle();
    if (state === "play" && !frozen) {
      physAcc += dt;
      let steps = 0;
      while (physAcc >= PHYS_DT && steps < 5) {
        rPrev[0] = hero.p[0]; rPrev[1] = hero.p[1]; rPrev[2] = hero.p[2];
        rPrevHead = hero.head;
        update(PHYS_DT);
        physAcc -= PHYS_DT; steps++;
      }
      if (steps === 5) physAcc = 0;
      renderAlpha = Math.max(0, Math.min(1, physAcc / PHYS_DT));
      GameAudio.setWind(hero.speed / HeroConsts.VMAX);
    }
    render(Math.min(dt, 1 / 20));
    if (state === "play") hud.update(hero, false);
  }

  // ── menu / UI wiring ─────────────────────────────────────────────────────
  function play() {
    state = "play";
    $("overlay").hidden = true;
    hud.show(true);
    document.body.classList.add("playing");
    cams.snap({ p: hero.p, v: hero.v, head: hero.head, speed: 0, state: hero.state });
  }
  /* Both audio subsystems start on THIS gesture and nowhere else: a WebAudio
     context created outside a user gesture starts suspended, and
     HTMLAudioElement.play() outside one rejects. One click arms both. */
  $("mb-play").addEventListener("click", () => {
    GameAudio.init(); GameAudio.uiSelect(); GameAudio.startMusic(); play();
  });
  GameAudio.onTrackChange((t) => hud.setTrack(t));
  $("pm-resume").addEventListener("click", () => { paused = false; $("pausemenu").close(); });
  $("pm-restart").addEventListener("click", () => {
    hero.reset(startB.cx, startB.y1, startB.cz - 2, 0, 0);
    paused = false; $("pausemenu").close();
    cams.snap({ p: hero.p, v: hero.v, head: hero.head, speed: 0, state: "ground" });
  });
  Input.init(canvas, {
    onPause: () => {
      if (state !== "play") return;
      paused = !paused;
      const pm = $("pausemenu");
      if (paused) pm.showModal(); else pm.close();
    },
    onMusicToggle: () => { GameAudio.setMusic(!GameAudio.music); },
    onNextTrack: () => { GameAudio.nextTrack(); },
    forceTouch: store.get("touch", null),
  });
  window.addEventListener("resize", () => gfx.resize());

  // ── dev API ──────────────────────────────────────────────────────────────
  // ApiPorts — a port exists because __spidey must EXPOSE that thing, never
  // because a module needed a reference. Ratcheted at 16 (see CLAUDE.md).
  window.__spidey = createApi({
    get state() { return state; }, set state(v) { state = v; },
    get headlessMode() { return headlessMode; }, set headlessMode(v) { headlessMode = v; },
    get frozen() { return frozen; }, set frozen(v) { frozen = v; },
    get testInput() { return testInput; }, set testInput(v) { testInput = v; },
    get city() { return city; },
    get citySeed() { return citySeed; },
    hero, cams, audio: GameAudio, update, PHYS_DT, play, loadCity,
    setSeed(n) { citySeed = n; store.set("citySeed", n); },
    snapPrev() { rPrev[0] = hero.p[0]; rPrev[1] = hero.p[1]; rPrev[2] = hero.p[2]; rPrevHead = hero.head; },
    frame,
  });

  lastFrame = performance.now();
  requestAnimationFrame(tick);
})();
