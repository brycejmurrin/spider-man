# Handoff — Web-Slinger, as of build 2

Written for whoever (or whichever session) picks this up next, on a fresh
machine. Read `CLAUDE.md` first for the conventions; this file is the *state*:
what works, what is unverified, what to do next, and the traps that already
cost time.

Branch: `claude/spiderman-game-f1-graphics-qn3e2e` (both repos).
Sibling source repo: `../f1-game` (Apex 26) — **read-only**, nothing is pushed
there.

---

## 1. Where the project stands

A playable prototype exists and boots. In a real headless Chromium at an
iPhone-13 landscape viewport, measured this session:

- boot to `window.__spidey` in **2.8 s**
- city: **983 buildings**, span **1248 m**, seed 42, deterministic
- **zero page errors, zero console errors**
- touch layer mounts on coarse-pointer devices; desktop key hints hide
- earlier desktop-viewport runs: 748 KB–1.2 MB screenshots showing a neon city
  with a correctly posed hero on a webline at 189 km/h

The fast unit suite is **50/50 green** (`npm run test:tooling-fast`, ~5 s).

### What is NOT verified

- **The touch controls have never been proven to reach the hero.** The layer
  mounts, the buttons and stick exist, the CSS is right, and no errors are
  thrown — but the test that holds SWING through live frames and asserts the
  hero attaches **timed out before it produced a result** and was then
  interrupted. This is the single most important thing to finish. See §3.
- **The soundtrack has never been heard.** The wiring is in and syntax-checks;
  autoplay policy, the gesture path and the track-change HUD are unconfirmed.
- **The Playwright browser specs are not green.** See §2 — there are real
  failures outstanding, and they are not all test bugs.
- **Nothing has been deployed.** `.github/workflows/pages.yml` is written but
  has never run. GitHub Pages Source must be set to "GitHub Actions" in repo
  Settings once, by hand, before the first deploy can succeed.

---

## 2. Outstanding test failures — read this before "fixing" anything

The last full `city-visual` run produced **three** failures. Two were being
worked; one is a genuine product finding that nobody has addressed.

| Spec | Failure | Assessment |
|---|---|---|
| `city-visual` › camera line of sight in a street canyon | `0.3` of frames behind geometry, budget `0.15` | **REAL.** The camera still clips into facades 30% of the time in a canyon. The clamp was already fixed once (ray now starts at the subject, not the look-at target, with `PAD 1.4 / MIN_D 2.8`) and this is what remains. Not a tolerance problem — do not widen the budget. |
| `city-visual` › 30 rendered frames, no GL errors | `Test timeout of 240000ms exceeded` inside `page.evaluate` | Almost certainly the box, not the code: the run was sharing 4 cores with 22 browser processes at load 8.5. **Re-run it alone before believing it.** |
| `city-visual` › light system under the uniform cap | `Tearing down "context" exceeded the test timeout` | Should be **fixed** — `tests/helpers/fixtures.js` now quiesces the render loop at the top of `afterEach`, on pass and fail alike. Unconfirmed. |

Two fixes from the prior round are also **applied but unconfirmed**:

- `tests/helpers/fixtures.js` — render-loop quiesce in `afterEach` (above).
- `tests/specs/swing.spec.js` + `js/game/spidey-api.js` — the webline-anchor
  check now uses `nearGeometry()` (sphere overlap) instead of a downward probe
  ray, and the threshold rose `0.6 → 0.9`. This was a **test** bug: measured,
  1 of 5 genuine anchors detected by the ray, 5 of 5 by the sphere. A ray cast
  at a point already lying on a vertical face runs tangent to it and misses.

### How to run them without wasting an hour

**One Playwright process at a time.** Local runs set `reuseExistingServer`, so
a second process attaches to the first's static server; kill either and the
survivor's remaining tests all die `ERR_CONNECTION_REFUSED` and read like
product bugs.

**Read the real exit code.** `npm run test:x 2>&1 | tail` **masks it** — npm
reported 0 while junit showed failures, and that cost a full diagnosis cycle.
Read `artifacts/test-results-*/junit.xml`, or don't pipe.

**Check the box first**: `pgrep -cf pw-browsers` and `/proc/loadavg` (want < 3).
A timeout on a busy box is a measurement of the machine.

---

## 3. Next actions, in order

1. **Prove the touch controls drive the hero.** The half-written test did:
   place the hero airborne at `(8, 80, -520)` with speed 18, dispatch a
   `PointerEvent("pointerdown", {pointerId, pointerType:"touch"})` at the
   centre of `#t-swing`, advance **live `requestAnimationFrame` frames** (not
   `act()` — `act()` injects `testInput` and bypasses the whole input layer,
   which is precisely what needs proving), then assert `obs().attached` became
   true. Budget ~40 frames, not 150: under SwiftShader 150 rAF frames exceeded
   two minutes. Land it as `tests/specs/touch.spec.js` with
   `localStorage["spidey.touch"] = true` to force the layer on.
2. **Fix the camera canyon clip** (§2, row 1). It is the one confirmed product
   defect open.
3. **Re-run `smoke`, `swing`, `city-visual`** one at a time, reading junit.
4. **Deploy**: set Pages Source to "GitHub Actions", push, watch the `pages`
   workflow. It gates on `ci` via `workflow_call`, so a red build never ships.
5. Fold in the character/model research agent's findings when they arrive
   (see §5) — `docs/PLAN.md` §3 is where they belong.

---

## 4. What changed in this round (build 2, uncommitted → committed with this file)

**Soundtrack** (`js/game/audio.js`, `js/game/hud.js`, `index.html`,
`assets/music/`). Three user-supplied MP3s, ~17 MB total, 192 kbps. Played
through **plain detached `<audio>` elements, deliberately not the WebAudio
graph**: a `MediaElementSource` would put the stream behind the same suspended
context the synth sits behind, and would decode the whole file into memory
instead of streaming. `startMusic()` runs on the SWING-button gesture alongside
`GameAudio.init()` — both subsystems need a user gesture and one click arms
both. `M` toggles, `N` skips, the HUD names the track on change. A missing or
undecodable file skips to the next rather than taking the game with it.

**Touch controls** (`js/game/touch.js`, new; `js/game/input.js`, `css/game.css`,
`index.html`). This was the iOS blocker — every action was a key. Left virtual
stick, SWING (hold, oversized, under the right thumb), JUMP, ZIP, DIVE. Three
things it gets right on purpose, each a standard way virtual controls break:
every control tracks its **own `pointerId`** (a hand is 3-4 simultaneous
pointers; a boolean "pressed" is released by whichever finger lifts first, and
holding SWING while steering is the core of the game); the controls are **DOM
elements above the canvas**, so look-drag needs no hit-testing; `touch-action:
none` is on the **controls only**, not the document, so menus still scroll.
`blur`/`visibilitychange` release everything — iOS steals touches for the app
switcher and would otherwise leave SWING stuck on forever. Safe-area insets
keep it clear of the notch and home indicator.

**Deploy** (`.github/workflows/pages.yml`, new). Fires only on this branch;
`needs: ci` gates on guards + smoke; stages a runtime-only `_site` (no tests,
tools, docs, node_modules).

**Docs**: the `nearGeometry` proximity-vs-ray lesson in `CLAUDE.md` and
`docs/TESTING.md`; the sw.js precache comment now says why the 17 MB
soundtrack must stay out of the install set.

Cache bumped to `?v=2` / `version.json` build 2 throughout.

---

## 5. Loose threads

- A background research agent (`a35328d64acec7a50`, "Research hero model and
  animation") was still running when this session ended. Its findings were
  meant for `docs/PLAN.md` §3 and possibly `js/hero/hero3d.js`. It never
  reported. Two earlier research agents (city-gen/world design, and an earlier
  character pass) were lost in an interrupt and never reported either.
- `docs/PLAN.md` holds the full phased roadmap (Phase 2 traversal depth,
  Phase 3 combat + Rapier, Phase 4 open world, Phase 5 scale). Nothing in it is
  started.
- The plan file from plan mode is at
  `/root/.claude/plans/prancy-wobbling-galaxy.md` on the old machine — its
  content is fully reflected in `docs/PLAN.md`, so it need not travel.

---

## 6. Traps already paid for

Each of these cost real time this session. They are in `CLAUDE.md` and
`docs/TESTING.md` too, but they are the ones most likely to be re-learned:

- **`waitForFunction` without `{ polling: 100 }` does not bound its wait** on a
  rendering page — measured in the sibling project at 109,665 ms against a
  declared 3,000 ms.
- **A rigid constraint does no work.** The velocity rescale after the tether
  clamp in `hero.js` is load-bearing: without it, 146 m/s against a 52 m/s cap.
- **`| tail` masks Playwright exit codes.**
- **Suspect the instrument before the subject** when a spec fails on something
  the screenshots say is fine. That was true for the anchor ray, and it is
  worth checking before touching the camera clamp — though the canyon-clip
  failure does look genuine.
- The city-visual run was killed mid-flight to free the box for this handoff;
  `artifacts/` holds its partial results and is gitignored.
