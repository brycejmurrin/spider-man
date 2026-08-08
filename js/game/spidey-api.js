/* Web-Slinger — window.__spidey, the dev/test API. The Apex 26 contract:
   debug-only, safe to call at runtime; deterministic control loop
   (place/step/act/obs) for headless tests; false/null on failure, never a
   throw. G is the live-getter façade the driver hands in. */
import { Log } from "../log.js";
import { CAM_MODES } from "./cameras.js";
import { HeroConsts } from "./hero-consts.js";
import { Input } from "./input.js";

export function createApi(G) {
  const hero = G.hero, cams = G.cams;

  function obs() {
    if (!G.city) return null;
    const anchors = [];
    for (const az of [0, 0.4, -0.4]) {
      const a = hero.pickAnchor(az);
      if (a) anchors.push({
        d: +Math.hypot(a[0] - hero.p[0], a[1] - hero.p[1], a[2] - hero.p[2]).toFixed(1),
        height: +(a[1] - hero.p[1]).toFixed(1),
      });
    }
    const speed = hero.speed;
    return {
      x: hero.p[0], y: hero.p[1], z: hero.p[2],
      speed, speedKph: speed * 3.6,
      state: hero.state,
      attached: !!hero.anchor,
      tether: hero.tether,
      groundClear: hero.p[1] - G.city.colliders.groundY(hero.p[0], hero.p[2], hero.p[1] + 0.5),
      anchors,
      head: hero.head,
    };
  }

  function stepN(input, dt, n) {
    G.testInput = input || null;
    for (let i = 0; i < (n || 1); i++) {
      G.snapPrev();
      G.update(dt || G.PHYS_DT);
    }
    G.testInput = null;
  }

  const api = {
    // ── info / staging ───────────────────────────────────────────────────
    info() {
      return {
        state: G.state, city: G.city ? "city-" + G.citySeed : null,
        span: G.city ? G.city.span : 0,
        buildings: G.city ? G.city.stats.buildings : 0,
      };
    },
    play() { G.play(); return true; },
    /* place the hero in the world; speed along heading. The obs()/act() loop
       needs this (or park) before observations mean anything. */
    place(x, y, z, speed, head) {
      hero.reset(x, y, z, speed || 0, head || 0);
      G.snapPrev();
      cams.snap({ p: hero.p, v: hero.v, head: hero.head, speed: speed || 0, state: hero.state });
      return { x: hero.p[0], y: hero.p[1], z: hero.p[2] };
    },
    /* park(frac) — stand on rooftop #floor(frac * buildings), frozen scene:
       the deterministic screenshot stage. */
    park(frac) {
      const list = G.city.colliders.list;
      const b = list[Math.min(list.length - 1, Math.floor((frac || 0) * list.length))];
      api.place(b.cx, b.y1, b.cz, 0, 0);
      if (G.state !== "play") G.play();
      G.frozen = true;
      return { x: b.cx, y: b.y1, z: b.cz };
    },
    freeze(on) { G.frozen = on !== false; return G.frozen; },
    reset(frac, y, speed) {
      // route convention for tests: a straight +z run across the city at x=8
      const span = G.city.span;
      const z = -span / 2 + (frac || 0) * span;
      return api.place(8, y == null ? 45 : y, z, speed == null ? 12 : speed, 0), obs();
    },

    // ── deterministic loop ───────────────────────────────────────────────
    headless(on) { if (on !== undefined) G.headlessMode = !!on; return G.headlessMode; },
    setInput(input) { G.testInput = input || null; return true; },
    clearInput() { G.testInput = null; return true; },
    step(dt, n) { stepN(G.testInput, dt, n); return obs(); },
    act(input, dt, n) { stepN(input, dt, n); return obs(); },
    obs,
    seed(n) { if (n !== undefined) { G.setSeed(n); G.loadCity(n, true); } return G.citySeed; },

    // ── camera ───────────────────────────────────────────────────────────
    camera(id) { return cams.setMode(id); },
    cameraModes() { return CAM_MODES.map((m) => m.id); },
    snapCam() {
      cams.snap({ p: hero.p, v: hero.v, head: hero.head, speed: hero.speed, state: hero.state });
      return true;
    },
    camState() {
      return { eye: [...cams.eye], tgt: [...cams.tgt], fov: cams.fov, mode: cams.mode };
    },

    // ── world queries ────────────────────────────────────────────────────
    city() { return G.city ? { seed: G.citySeed, ...G.city.stats } : null;
    },
    swing() {
      return { state: hero.state, anchor: hero.anchor ? [...hero.anchor] : null,
               tether: hero.tether, speed: hero.speed, consts: HeroConsts };
    },
    groundY(x, z) {
      if (!G.city) return null;
      return { y: G.city.colliders.groundY(x == null ? hero.p[0] : x, z == null ? hero.p[2] : z, 1e9) };
    },
    raycast(o, d, maxT) { return G.city ? G.city.colliders.raycast(o, d, maxT || 100) : null; },
    /* Is this world point on (or within r of) a building surface? The right
       question for "did the web land on something": a ray cast at a point on a
       vertical face runs tangent to it and misses. */
    nearGeometry(pt, r) { return G.city ? G.city.colliders.sphereClip(pt, r || 0.5) : null; },
    lightState() {
      const L = G.frame.lights;
      return { numLights: L ? L.length / 15 : 0, exposure: G.frame.exposure,
               ambientSky: [...G.frame.ambientSky], ambientGround: [...G.frame.ambientGround] };
    },

    /* input() — the MERGED input the loop is about to read, from whichever
       source is live (keys, gamepad, touch). Read-only: the consume-once
       edges (jump/zip/camera) and look() are deliberately absent, because
       reading them here would eat an input the game is owed.

       This exists because the touch layer was otherwise unobservable: when a
       virtual button failed to reach the hero there was no way to tell whether
       the DOM handler never fired, the merge dropped it, or the hero ignored
       it. Three different bugs with one symptom. */
    input() {
      return {
        touch: Input.touchActive,
        moveX: Input.moveX(), moveZ: Input.moveZ(),
        swing: Input.swing(), dive: Input.dive(),
      };
    },

    /* music() — is the soundtrack ACTUALLY playing? Every other signal this
       subsystem offers is a false positive: the elements are detached so the
       DOM cannot see them, startMusic() returns true regardless, and a failed
       play() is swallowed. currentTime advancing across two samples is the
       only fact that separates playing from refused. */
    music() { return G.audio.musicState(); },

    // ── logs ─────────────────────────────────────────────────────────────
    logs(o) { return Log.records(o || {}); },
    logLevel(spec) { return Log.level(spec); },
  };
  return api;
}
