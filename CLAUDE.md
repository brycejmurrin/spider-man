# Web-Slinger — engineering reference

An unofficial Spider-Man-inspired open-city fan game. WebGL2, **no build step**,
no frameworks, no runtime dependencies. Native ES modules served as static
files. This file is the working reference: commands, rules, the file map. Deeper
material lives in `docs/` — start at `docs/README.md`, and `docs/PLAN.md` is the
roadmap.

The engine is ported from the sibling project **Apex 26** (`../f1-game`): its
WebGL2 renderer, procedural building massing, instancing graph and engineering
discipline. Where a comment here says "measured", the number came from that
project's logs or from a measurement in this one — keep those comments with
their numbers.

---

## Key commands

```sh
npx serve -l 3456 .              # run locally (or: python3 -m http.server 3456)
npm run test:tooling-fast        # the ~10 s no-browser suite: run this constantly
npm run test:smoke               # boot + render health in Chromium
npm run test:swing               # headless traversal + determinism
npm run test:visual              # camera/light/render health, no pixel baselines
node tools/run-playwright.mjs tests/specs/<spec>.spec.js
```

## Testing

**Run `test:tooling-fast` after every edit.** It builds the whole city, drives
the traversal model for thousands of steps and checks the module graph, in about
ten seconds, with no browser. Most defects in this codebase are catchable there,
and that is deliberate: `js/city/*` and `js/game/hero*.js` import nothing from
`js/render/`, so they load in bare Node. `tests/unit/load-order.test.mjs` fails
if that ever stops being true.

Three rules the browser half inherits from Apex 26, each the fix for a measured
failure:

1. **`{ polling: 100, timeout: N }` on every `waitForFunction`.** Playwright
   polls on `requestAnimationFrame`; a page running the game loop under
   SwiftShader starves that poll so badly the declared timeout never fires
   (measured there: a 3 s bound ran 109,665 ms). Only a predicate that *throws*
   terminates promptly.
2. **Stop the render loop before a screenshot.** `park()`/`freeze()` stop
   physics, not rendering. A capture issued against a live loop queues behind it
   (measured: 88-96 s versus 29-32 s once quiesced). Present one real frame,
   then `headless(true)`, then shoot.
3. **`snapCam()` after any teleport.** The rig eases toward its target
   exponentially, so `place()`/`park()` leaves it flying to the hero for a
   second or more. Waiting longer is not a fix.

Assert **behaviour and geometry, not magnitudes**: "swinging carries further
than falling", not "travelled > 400 m". Absolute thresholds go stale the first
time the model is retuned; the relative ones survive it and still fail loudly.

## Output dirs

Regenerable output goes in `artifacts/` (test results, reports, logs) and
`scratch/` (captures, profiles). Both gitignored — never `/tmp`, never the repo
root. Transient tools are `tools/_*.mjs` and are gitignored too.

---

## File layout

```
js/game.js          the driver: boot, the fixed-timestep loop, frame assembly,
                    the draw path. Deliberately thin — the size ratchet holds it
js/log.js           Log      levelled, namespaced logging + retained ring buffer
js/mat4.js          M4, V3   matrix / vector math

js/render/          — the ported Apex 26 WebGL2 renderer —
  glx.js            GLX      core: HDR, MSAA, bloom, SSAO, god rays, ACES
                             composite + SSR, FXAA, instancing, texture arrays,
                             env probe, mobile tiers
  glx/post.js       GLXPost      the post chain
  glx/shadow.js     GLXShadow    static sun map (snap-cached) + dynamic + spot
  glx/chunked.js    GLXChunked   spatial-cell frustum-culled meshes
  shaders/          GLSL sources as pure data (chunks, lit, sky, fx, post)
  assets.js         Assets   baked PBR texture-array pack; every failure
                             degrades to the procedural look, boot never awaits

js/city/            — the world —
  geom.js           Geom       primitive emitters + MAT ids (no renderer deps)
  graph.js          CityGraph  instancing: record ops once, replay per node
  city-data.js      district profiles, neon/facade/window palettes
  buildings.js      the ~18-silhouette massing library + curtain-wall facades
  citygen.js        the generator: grid -> blocks -> lots -> buildings
  colliders.js      building OBBs + spatial hash: raycast/sphereClip/roofAt

js/game/            — gameplay —
  hero-consts.js    the traversal model's immutable numbers WITH their rationale
  hero.js           the controller: GROUND | AIR | SWING | WALLRUN
  webline.js        the active web ribbon
  cameras.js        one pure vantage() solver + damping + shake + geometry clamp
  input.js          keyboard / mouse-look / gamepad; edge latches
  hud.js            write-cached DOM HUD
  audio.js          WebAudio: wind, thwip, landing, UI
  store.js          cached localStorage (`spidey.` prefix)
  spidey-api.js     window.__spidey — the dev/test API

js/hero/hero3d.js   procedural rigid-segment hero mesh + poses (no skinning)

index.html          shell: version guard, error overlay, static DOM, import map
sw.js               service worker; precache derived from the shell's own tags
tools/manifest.cjs  the module inventory the import map is asserted against
tests/              unit (node --test, no browser) + specs (Playwright)
```

## Critical conventions

- **Native ES modules, no build step.** One `<script type="module">` entry;
  the browser resolves load order from the import graph. There is no tag
  sequence to hand-maintain.
- **Cache busting is an import map.** An import specifier is a static string
  inside a module, so bumping the entry's `?v=` does not reach its imports.
  `index.html` carries an import map remapping every module to itself with
  `?v=N`, plus a `modulepreload` per module at the same URL. After ANY js/css
  change: bump every `?v=` to max+1 and set `version.json` to the same N.
  `tests/unit/load-order.test.mjs` asserts all of it.
- **New file checklist**: (1) create it in the right `js/<domain>/`; (2) import
  it from something reachable from the entry; (3) add it to `MODULES` in
  `tools/manifest.cjs`; (4) add its import-map entry AND its modulepreload link
  in `index.html`; (5) name it in the layout above; (6) bump `?v=N` +
  `version.json`.
- **`js/city/` and `js/game/hero*.js` stay headless.** No `document`, no
  `localStorage`, no renderer imports. That is what makes the world and the
  traversal model testable in bare Node, and it is asserted.
- **localStorage keys** are all prefixed `spidey.`.
- **Coordinates**: +Y up, metres, radians. Hero space is +Z forward. Building
  OBBs store `rot` as the yaw of the box's local +X axis.
- **The hero's world position and velocity are the authority.** Camera, mesh
  pose, HUD and `obs()` all read them. Exactly two things write back: the
  tether constraint and capsule depenetration. Nothing else may move the hero.
- **A rigid constraint does no work.** The tether may redirect velocity; it may
  never lengthen it. Re-deriving velocity from a clamped position silently adds
  energy (measured: 146 m/s against a 52 m/s cap) — the rescale after the clamp
  in `hero.js` is load-bearing.
- **Determinism is a feature.** No `Math.random` anywhere reachable from
  `hero.step()` or `buildCity()`. Same seed and inputs must replay bit for bit,
  or every A/B, benchmark and regression comparison this project runs is void.
  Cosmetic randomness (particles, shake) stays out of that path.
- **Effects live in the render/audio path, never in the physics step.** The
  physics step may set a bounded flag (`hero.landed`); the driver consumes it.

## Traversal model

`docs/PLAN.md` holds the design rationale. Two rules bind code elsewhere:

- **Anchor scoring decides the feel of the whole game.** Preferring the highest
  hit monotonically prefers the longest tether, and a long tether is a slow
  pendulum (half-period `π√(L/g)`: 45 m swings for 2.8 s). Scoring targets
  `TETHER_IDEAL` instead. If you touch `pickAnchor`, re-measure the swing
  period and the tether distribution.
- **Assists may redirect momentum; they may not tax it.** The ground-clearance
  shorten, the never-stranded anchor, the auto wall-run and the apex
  auto-release all exist to stop the player being stranded — none of them may
  cost speed, or holding the button becomes better than playing well.

## `window.__spidey` dev API

```js
__spidey.info(); __spidey.play(); __spidey.park(0.5); __spidey.freeze(true)
__spidey.place(x, y, z, speed, head); __spidey.reset(frac, y, speed)
__spidey.headless(true); __spidey.obs(); __spidey.act(input, dt, n); __spidey.step(dt, n)
__spidey.camera("chase"); __spidey.cameraModes(); __spidey.snapCam(); __spidey.camState()
__spidey.city(); __spidey.swing(); __spidey.groundY(x, z); __spidey.raycast(o, d, maxT)
__spidey.nearGeometry(pt, r)         // "is this point ON a building?" — see below
__spidey.input()                     // the MERGED input the loop is about to read
__spidey.music()                     // is the soundtrack actually playing? — see below
__spidey.lightState(); __spidey.seed(n); __spidey.logs({ ns: "city" })
```

Sharp edges: `obs()` returns null until the hero is placed; `park()` freezes the
scene, so call `freeze(false)` before driving; `snapCam()` is required after any
teleport, before a capture.

**`obs()` MUTATES THE HERO.** It calls `pickAnchor()` three times to report
reachable anchors, and `pickAnchor` writes `bestSide` — the auto-straighten
memory. So a rollout that polls `obs()` every frame does not follow the same
trajectory as one that does not, and any drift or A/B measurement that reads it
per-frame is measuring a perturbed system. Read `hero.p` directly in Node.

**`input()` is how you tell three different bugs apart.** When a virtual button
fails to reach the hero, the DOM handler may never have fired, the merge may
have dropped it, or the hero may have ignored it — one symptom, three causes.
It reports only non-consuming sources: the consume-once edges (jump/zip/camera)
and `look()` are deliberately absent, because reading them here would eat an
input the game is owed.

**`music()` exists because every other music signal is a false positive.** The
`<audio>` elements are detached (`new Audio()`, never appended) so the DOM
cannot find them; `startMusic()` returns `true` whether or not playback began;
and each `play()` rejection is swallowed on purpose. `#track` appearing in the
HUD proves only that the callback ran, one line after a `play()` that may have
been refused. **`currentTime` advancing across two samples is the only ground
truth**, and `error` surfaces the `MediaError` the skip-on-failure path
otherwise discards. A test that clicks with `dispatchEvent` instead of
`locator.click()` gets an untrusted event, no user activation, a rejected
`play()` — and passes every check except that one.

**"Did the web land on something?" is a proximity question, not a ray question.**
Use `nearGeometry(pt, r)`, never a probe ray. A ray cast at a point that already
lies on a *vertical* face runs tangent to that face and misses it — measured, 1
of 5 genuine anchors detected, which reads as a traversal bug and is a test bug.
A small sphere at the point answers correctly for every face orientation.

## Git branch

Work happens on a `claude/<topic>` feature branch —
`git branch --show-current` is the truth, prose is not. No deploy branch is
configured yet; `.github/workflows/ci.yml` runs guards + smoke on every push.
