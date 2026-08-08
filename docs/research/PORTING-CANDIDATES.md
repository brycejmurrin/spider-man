# What else is worth taking from Apex 26

A judgement pass over everything in `../f1-game` that is **not** already ported.
The renderer, the massing library, the instancing graph and the engineering
discipline came across in the first round; this is the rest, plus a drift audit
of what already came across.

Method: file-level diff of every ported file against its source, plus a read of
each candidate module's header and its coupling points (`Tracks.*`, arc position
`s`, lap timing, `cars[]`). Line counts are `wc -l` on both trees at
f1-game `788a2bb` / spider-man `1b84304`, both dated 2026-08-08.

Two things the reader should know before the tables:

- **The engine port is byte-faithful.** Every functional difference between the
  two renderers is an IIFE→ESM conversion or an `apex26.`→`spidey.` storage-key
  rename. There is no rendering drift to chase. The drift that exists is in the
  *thin* files — `sw.js`, `store.js`, the light-cull loop in `game.js` — and in
  the things that were **not** ported at all but whose hooks were.
- **The most valuable finding here is not a module.** It is that
  `js/render/glx.js` shipped with `setRenderScale`, `gpuTimer`,
  `createInstancedBatch` and `drawParticles` all live and all unused. The port
  carries the capability and not the driver.

---

## 1. DRIFT — already-ported code

Ordered by consequence. D1–D4 are defects that exist in this repo today.

| # | Where | Finding | Severity |
|---|---|---|---|
| **D1** | `sw.js` | The precache tag parser buckets `<link rel="modulepreload">` as **optional**. 29 of the 30 modules are therefore best-effort. | **High** |
| **D2** | `js/game/touch.js` | Missing f1's anti-latch nets #1, #2 and #4. A stuck SWING on iOS is unrecoverable. | **High** |
| **D3** | `js/game.js` `packLights()` | Allocates ~962 arrays and does a full sort every frame; no behind-camera bias. Both were measured bugs in f1 and are fixed there. | **High** |
| **D4** | `js/game/store.js` | Caches the *caller's default* for a missing key, poisoning later reads with a different default. `broken` is recorded and never surfaced. | Medium |
| **D5** | absent | `PerfGov` was not ported. `setRenderScale` exists and nothing calls it. | **High** (phone) |
| **D6** | absent | `tools/assets.mjs verify` was not ported. The pack is byte-identical today; nothing keeps it that way. | Medium |
| **D7** | `js/city/graph.js` | One line diverged deliberately (`ok !== false`). Correct here, correct differently there. A future wholesale re-port would silently reintroduce the bug. | Low (hazard) |
| **D8** | `js/render/**` | Zero functional drift. Also zero upstream-tracking mechanism. | Note |
| **D9** | `js/city/graph.js` → GLX | `batches()` has no consumer in *either* repo. `PLAN.md` reads as though instancing shipped. | Note + opportunity |
| **D10** | `tests/` | The `polling` rule holds by hand (3/3 sites). `wait-polling-lint.mjs` is what keeps it holding. | Low |

### D1 — the service worker will report a successful offline install of a broken app

`sw.js` derives its precache from the shell's own tags, which is right, and is
inherited unchanged from f1. But f1's shell loads JS with ~150 `<script src>`
tags, and this shell loads **one** — everything else is reached through the
import map, announced only by `<link rel="modulepreload">`.

The classifier is:

```js
if (m[1].toLowerCase() === "script" || /\brel="stylesheet"/i.test(m[0])) {
  essential.add(u);
} else {
  optional.add(u);          // ← every modulepreload lands here
}
```

`cacheRequiredAsset` throws on failure and fails the install; `cacheOptionalAsset`
swallows it. So the essential set is `./`, `index.html`, `version.json`,
two stylesheets and `js/game.js` — and an install that fetched **none** of the
other 29 modules writes `__spidey_install_complete__`, sweeps the previous
cache generation on activate, and leaves an installed PWA that cannot boot
offline. On f1 this hole does not exist, because there a JS file is a
`<script>`.

Fix: add `|| /\brel="modulepreload"/i.test(m[0])` to the essential test. One
line. The cached keys already carry `?v=N` and match what the import map makes
the browser request, so nothing else has to change.

### D2 — the touch hold-release nets

f1 shipped a fix for this **on 2026-08-08**, hours before this repo was
branched (`716bd1a`, "net #4 — zero touches on the glass releases every hold
button"). It did not come across. Nor did the two nets that preceded it.

f1 has four independent ways a held button gets released; `js/game/touch.js`
has one and a half:

| Net | f1 `input.js` | this repo `touch.js` |
|---|---|---|
| #0 element `pointerup`/`pointercancel` | yes | yes |
| #1 **window-level, capture phase** `pointerup` | yes | **no** |
| #2 `lostpointercapture` | yes | yes |
| #3 `blur` / `visibilitychange` reset | yes | yes |
| #4 **`touchend`/`touchcancel` with `touches.length === 0`** | yes | **no** |

Net #4 is the one that matters and the reason it matters is written into f1's
commit: WebKit under heavy multi-touch drops a `pointerup` outright while still
delivering the touch lift, **and iOS never reuses pointerIds**, so the ghost id
is permanent. A fresh press-and-release cannot clear it. In f1 that produced a
throttle that stayed on no matter what the player pressed.

Here, the hold buttons are **SWING** and **DIVE**. A permanently-held SWING is
the game. And this repo's exposure is strictly worse than f1's was, because
net #1 is also absent: `hold()` binds `pointerup` on the *element*, relying on
`setPointerCapture` to redirect — and that call sits inside `try {} catch (_) {}`,
so when capture fails there is nothing above it to catch the release.

Fix: ~10 lines in `Touch.create` — window-level capture-phase
`pointerup`/`pointercancel` calling the existing per-button `off()`, plus the
two `touchend`/`touchcancel` zero-touch handlers calling `releaseAll()`.
`releaseAll()` already exists and already does exactly the right thing.

### D3 — the per-frame light cull allocates, sorts everything, and wastes half the budget behind the camera

`js/game.js`:

```js
const scored = lamps.map((l, i) => { … return [dx*dx + dz*dz, i]; })
                    .sort((a, b) => a[0] - b[0]);
```

On the shipped seed that is **962 lamps**, so every frame allocates one array of
962 elements plus 962 two-element arrays, then sorts all of them to keep 27.
At 60 fps that is ~58,000 short-lived arrays per second feeding straight into
the minor-GC nursery. f1 hit exactly this and fixed it; the comment in
`js/game/lighting.js` names the symptom:

> Reuse a pooled object array + the output buffer so a dense night grid doesn't
> allocate fresh garbage every frame (was the main source of Minor-GC jitter on
> Vegas/Singapore).

Vegas and Singapore are f1's *night street* circuits — the same lamp density
this city has, on the same renderer, and the jitter was visible enough to be
chased down. This is a bug that was found and fixed in one repo and is present
in the other.

The second half of the same f1 fix is also missing: a purely radial nearest-N
spends roughly half of a 27-slot budget on lamps behind the camera, which ends
the lit street in a hard dark boundary ahead of the player. f1 adds a
`lampBehindBias` penalty **ramped in over ~14°** past the camera plane —
deliberately not a hard sign test, because a hard test makes a fast camera yaw
flip many lamps' rank in one frame and the whole field shudders. A swinging
camera yaws faster than a chase cam does.

Fix: a pooled `Float32Array` of scores + an index array reused across frames,
a partial selection (or an insertion pass over a 27-slot top-k, which at
n=962/k=27 beats a full sort outright), and the ramped forward penalty. ~40
lines, entirely inside `packLights()`. Worth doing as one edit with D5, since
both are frame-budget work.

### D4 — `store.get` poisons its cache with the first caller's default

```js
const v = raw == null ? d : JSON.parse(raw);
this._cache.set(key, v);        // caches `d`
```

f1 caches `undefined` for a missing key and applies the default per call
(`return v === undefined ? d : v`). Here the first `get("x", A)` on an unset key
caches `A`, and a later `get("x", B)` returns `A`. There is one such key today
(`store.get("touch", null)` vs. nothing else), so this is latent rather than
live — but it is the kind of thing that is found six months later as "the touch
override doesn't work on a fresh install".

Second half: `broken` is set and never read. f1's whole point in adding that
field is the paragraph above `set()` — Safari in Private Browsing sets the
localStorage quota to **zero**, every write throws, the in-memory cache makes
the session look perfect, and the player discovers on reload that nothing was
ever saved. f1 logs the first failure through `Log.warn` and exposes it as
`__apex.persistState()`. Here it is unreachable from `__spidey`.

Fix: ~15 lines — cache `undefined`, add `noteBroken()`, expose
`__spidey.persistState()`.

### D5 — the adaptive-performance governor was not ported, but its hooks were

`js/game/perf.js` (221 lines) is the single most relevant unported file to this
project's stated goal of running on an iPhone. This repo already has every
interface it needs:

| PerfGov needs | this repo has |
|---|---|
| `gfx.setRenderScale(s)` / `getRenderScale()` | present in `glx.js`, **never called** |
| `gfx.isMobile` / `gfx.mobileTier` | present, only read inside `glx.js` for DPR capping |
| per-frame ms | `tickBody`'s `dt` |
| feature gates in the draw path | `presentOpts.{ssao,godray,bloom,reflect}`, `carShadowBegin`, `lampVol` |

So `renderScale` is pinned at 1.0 for the life of the session, on a target
platform where it is the only lever that does not change what the frame *looks
like*, only how sharp it is.

Three parts of perf.js are worth reading before porting, because each is the
fix for a wrong first version:

1. **The budget is derived, not hardcoded.** "Slower than 19 ms" assumes frame
   *interval* proxies frame *cost*, which is false the moment anything caps the
   clock externally — iOS Low Power Mode throttles rAF to 30 fps. f1's first
   governor drove a Low-Power phone to the scale floor and shed every optional
   feature within ~27 seconds, none of which could ever help. `_floorMs` tracks
   the *floor* of observed intervals and thresholds are relative to it.
2. **Every step is provisional until verified.** If the EMA did not improve
   after a downscale, fill rate was not the bottleneck: revert and hold off.
   Without this one bad guess becomes "runs to the bottom of the ladder and
   stays there for the session".
3. **The crash sentinel.** A jetsam/OOM kill leaves no signal at all — no
   `pagehide`, no `contextlost`, no error. The only trace is a flag persisted at
   session start still being set at the *next* boot. Strikes pre-degrade the
   governor so a phone that died last session starts conservative. Critically,
   strikes are keyed to the **build** they were earned against, because f1
   shipped this without that key and made safe mode a one-way door: phones that
   died on a bad build stayed pinned at tier 4 after the fix landed.

Adaptation: rename `raceActive`/`cleanRace()` to session terms; the tier ladder
maps almost one-for-one (tier 1 env probe → n/a here, tier 2 lamp spot shadow +
SSR, tier 3 hero sun shadow, tier 4 SSAO/godray/bloom). Nothing in the file
knows about a track, a lap or a car.

Cost: ~180 lines as `js/game/perf.js`, plus ~10 lines in `js/game.js`
(`PerfGov.init(gfx)`, `PerfGov.tick(_dtMs)`, four `PerfGov.tier()` reads on
`presentOpts` and the shadow block). **`js/game.js` is at 440 of a 460 ceiling**,
so this needs either a deliberate ceiling raise with the reason in the commit,
or the ~35-line static-shadow block extracted first. Prefer the extraction.

### D6 — no asset-pack guard

`assets/pack/` is byte-identical to f1's (all four PNG md5s, `manifest.json`,
`CREDITS.md`, `webbake.js` — verified). But `tools/assets.mjs` did not come
across, so nothing enforces the licence allow-list, the md5 manifest or the
8 MB budget. This matters more here than there: `PLAN.md` §6 makes payload size
a *design constraint* (6 MB / 3.7 s converts 72% of visitors, 40 MB / 29.5 s
converts 50%), and `assets/music/` already carries ~17 MB of mp3 that the
service worker header correctly keeps out of the install set. A budget check
that covers `assets/` as a whole is worth more here than the licence check.

### D7 — the one deliberate divergence in `graph.js`, and why it is a hazard

```js
// f1-game/js/track/graph.js
if (ok) landed++;

// spider-man/js/city/graph.js
// RAW Geom emitters return undefined (only GUARDED emitters return a
// verdict); count anything but an explicit false as landed, or every
// raw replay records zero nodes and batches() goes empty.
if (ok !== false) landed++;
```

Both are correct for their own emitter contract — f1's emitters are guarded and
return a verdict; `buildings.js` here calls the raw `Geom` emitters, which
return `undefined`. The two files are otherwise identical. The hazard is that
this is *the* line that decides whether a placement is recorded at all, and the
next person to sync `graph.js` from upstream will delete it without noticing.
Worth a test: assert `graph.stats().nodes > 0` after a city build. (`citygen.test.mjs`
asserts the city is instanced, so this may already be covered — confirm before
adding.)

### D9 — the instancing is recorded and never drawn

`PLAN.md` §2 reports "**85,484 instanced nodes from 3 models** (≈10,000× reuse)".
That is `graph.stats()`, which counts what was *recorded*. `graph.batches()` —
the handoff that turns those nodes into `gfx.createInstancedBatch` +
`gfx.drawInstanced` — is called by nothing. Neither is it called in f1, so this
is not drift; but the doc reads as though a draw-call saving shipped, and it did
not. Everything is baked into the 1.47 M-vertex chunked prop mesh.

This is the largest untapped phone-perf lever in the repo, and this project's
numbers are far more favourable than f1's ever were: 3 models, ~10,000× reuse,
static geometry, one draw call per model against a mesh that currently costs
1.47 M vertices of bandwidth. `cullInstances`, `drawInstanced`,
`castShadowInstanced` and `freeInstancedBatch` are all present and tested in
`glx.js`. The work is in `citygen.js`: call `batches()`, keep `bakeOnly` in the
chunked mesh, upload the rest. Not free — the chunked mesh's spatial culling is
what makes the current path survivable, and an instanced batch culls by
`cullInstances` instead — but it is the one change that could plausibly halve
the frame on a phone.

---

## 2. Candidate table

Verdict key: **clean** = port near-verbatim; **adapt** = the idea and most of
the code transfer, named changes required; **contract** = port the *rules* and
the shape, write the body fresh; **no** = racing-specific or valueless here.

### Directly relevant to the phone target

| Candidate | Lines | What it does | Portability | Value to a swinging game | Cost |
|---|---|---|---|---|---|
| **`js/game/perf.js`** | 221 | Two-stage adaptive governor (render scale, then feature tiers) + jetsam crash sentinel | **adapt** — knows nothing of tracks/laps/cars; rename `raceActive`/`cleanRace`, drop the env-probe tier | **Highest.** The stated goal is an iPhone and there is currently no governor at all | ~180 lines + ~10 in `game.js`; needs a ceiling raise or an extraction first (see D5) |
| **`docs/iOS-OPTIMIZATION.md`** | — | iOS input matrix, why gamepad, rendering/power notes, on-device checklist | **adapt** | High — most applies verbatim; the tilt row does not | doc only |
| `glx.gpuTimer()` / `gpuMs()` | (in glx) | GPU frame time via `EXT_disjoint_timer_query` | **clean** — already present, unused | High — tells you whether you are GPU- or CPU-bound before you tune anything | 0 lines; expose via `__spidey.gpuMs()` |
| **`tools/profile-gameloop.mjs`** | — | Headless V8 CPU profile of the loop → `.cpuprofile` | **clean** | High — `packLights` and `buildCity` are the obvious suspects and neither has been measured | ~1 tool file |
| `graph.batches()` wiring | — | GPU instancing for the 85 k recorded nodes | **contract** | High, see D9 | ~60 lines in `citygen.js`/`game.js`; real risk to culling |

### Effects and feel

| Candidate | Lines | What it does | Portability | Value | Cost |
|---|---|---|---|---|---|
| **`js/game/particles.js`** | 328 | Fixed CPU pool of camera-facing soft billboards, two batches/frame (alpha + additive); struct-of-arrays, zero steady-state allocation, swap-remove on death | **clean** — the only dependency is `gfx`, injected once. Emitters take world positions; nothing reads a car. `gfx.drawParticles` is already present and unused | High. Web impact puffs, landing dust, wall-scrape sparks, air-rush motes at speed, and it is the substrate for Phase 4 weather. Additive sparks feed bloom for free | ~230 lines after dropping the tyre-smoke/gravel emitters; +2 lines in `render()`. Its own module, no ceiling pressure |
| **`js/game/skidmarks.js`** | 102 | Ring buffer of 120 stamped quads, batched into one draw; stamp every N frames while sliding | **clean** — "extracted verbatim, self-contained by construction", `create(_G)` ignores its argument. `gfx.drawSkidBatch` present and unused | Medium-high. Wall-crawl scuffs and web-residue marks are the same object. Note the transferable *bug*: f1's stamp lives inside `render()`, so a headless `act()` run never stamps — keep it in the render path here too and do not test it through `step()` | ~90 lines, one module |
| **`js/game/bodyattitude.js`** | 179 | Critically-damped analytic springs driving cosmetic pitch/roll/heave on the body mesh only | **contract** — the *car* couplings (`axEstSm`, `kCur`, road-surface height) are all racing; the spring model and its four rules are not | Medium-high. The hero currently has ten rigid segments posed by state with no acceleration response. A lean into the swing plane and a compression on landing are exactly this | ~80 lines of fresh code following its rules: render-only, deterministic, no `Date.now`/`Math.random`, clamped, default-on with an off switch |
| `js/game/cam-tune.js` + `cam-tuner.js` | 183 + 144 | Per-mode framing offsets (height/distance/side/pitch/yaw/fov) applied at the end of `vantage()`, persisted per mode; plus its slider panel | **adapt** — `cam-tune.js` is pure data + an `apply()` on a solved `{eye,tgt,fov}`. `cameras.js` here already has one pure `vantage()` solver, which is the precondition | Medium. `PLAN.md` §2.7 wants speed-linked FOV/pullback/roll — this is the knob layer that makes tuning it a slider instead of a rebuild | 183 lines clean; the panel waits on the UI-layer work |
| `js/game/photomode.js` | 307 | Free-fly camera, render-scale bump, HUD hide, DOM wiring | **adapt** — heavy `G`-façade destructure; the free-fly cam itself is ~120 lines and generic | Medium. A swinging game is a screenshot game, and it doubles as a debug free-cam | ~130 lines for the camera; the panel waits on the UI layer |

### UI

Web-Slinger has two screens (`#overlay`, `#pausemenu`) and one `<dialog>`.
Most of f1's UI discipline is the scar tissue of seventeen screens and should
be taken **when the third screen lands**, not before — with two exceptions.

| Candidate | Lines | Portability | Value | Cost |
|---|---|---|---|---|
| **`js/game/uilayers.js`** | 154 | **contract** — the *list* is racing, the rule is not | Medium-high **now**. Its whole thesis is that three modules each kept a private list of "which screen is on top" and by the time anyone checked they differed by five screens. This repo has exactly two consumers today (`input.js`'s `Escape` and `topmodal`'s `data-esc-close`) and that is the cheapest possible moment to make it one. Also carries the real finding: **a top-layer `<dialog>` computes `z-index: auto`**, so ranking by `parseInt(zIndex)` scores the modal as 0 — `:modal` outranks every z-index | ~60 lines for two screens |
| **`js/game/topmodal.js`** | 146 | **adapt** | Medium-high. `#pausemenu` is already a `<dialog>` with `data-esc-close`, so half of this is here in spirit. Take the *migration seam* — `hidden` stays the source of truth, mirrored onto `showModal()`/`close()` — before there are sixty call sites to rewrite | ~80 lines |
| `js/game/scrollfade.js` | 155 | clean | Low now, medium at Phase 4. Its finding is worth recording even if the code waits: a CSS scroll-driven timeline resolves once at animation *creation*, and these regions are created inside a `[hidden]` overlay and filled later, so the timeline comes up inactive and never revives | defer |
| `js/game/menunav.js` | 353 | adapt | Low now. Solves "the only scrollable target is too small to hit by accident" — a seventeen-screen problem | defer |
| `js/game/ariastate.js` | 123 | clean | Low now, high the moment option groups exist. An observer, not 15 call sites, so it costs the same whenever it lands | defer |
| `js/game/sheetshape.js` | 144 | adapt | Low. Its consumer is CSS that does not exist here | no |
| `js/game/menus.js`, `results.js`, `setup-ui.js`, `hud.js` | 430 / 296 / 752 / 284 | no | Racing flows. `hud.js`'s write-cache pattern is already ported | no |
| `js/game/audio-panel.js` | 220 | adapt | Medium, paired with the UI work. Music/SFX switches, two volume sliders, source row, transport — this repo has `M`/`N` keys and no mixer | 150 lines, after `uilayers` |

### Input

| Candidate | Lines | Portability | Value | Cost |
|---|---|---|---|---|
| **touch nets #1/#4** | ~10 | **clean** | **Highest of anything in this section** — see D2 | ~10 lines |
| f1 `input.js` tilt + One-Euro band | ~180 of 1316 | adapt | **Low.** Tilt is a *steering* input: one axis, continuous, with a wheel that cannot snap. A swinging hero needs two axes plus four discrete verbs, and holding a phone flat while swinging is not a control scheme anyone wants. `input.js`'s deferral of tilt was the right call | skip |
| f1 gamepad mapping + rumble | ~120 | adapt | Low-medium. The gamepad path here is already functional (sticks, A/B/Y/LB, RT/LT). `Input.rumble()` via `vibrationActuator` with `navigator.vibrate` alongside is ~20 lines and lands on web impact / hard landing | 20 lines |
| f1 input-buffering / edge latches | — | already ported | — | — |
| `?inputdebug=1` on-screen readout | ~40 | clean | Medium. There is no console on a phone; this repo has the error overlay but no input readout, and D2's class of bug is invisible without one | 40 lines |

### Agent / dev API

| Candidate | Lines | Portability | Value | Cost |
|---|---|---|---|---|
| `js/game/apex.js` | 3012 | no — 181 racing hooks | The *shape* is already ported (`__spidey`, 127 lines): false/null never throw, deterministic control loop | — |
| `js/game/agentview.js` | 2819 | **contract** | Medium. The code is `Tracks.sample`/`wallAt`/`project`/`bankAngle`/`curvature` throughout — nothing survives. What transfers is the design: one egocentric snapshot per decision; semantics beside the numbers; an error that is `{ok:false, error, message, fix}` rather than `null`; `API_VERSION` **and** `PHYSICS_VERSION`, the latter bumped when a model change invalidates a strategy an agent derived earlier. `__spidey.obs()` already returns `null` on failure — that is the anti-pattern the doc argues against | ~40 lines to fix the error shape; the rest is Phase 4 work |
| `js/game/agentview-raster.js` | 764 | adapt | Low-medium. A depth-sorted character-grid rasteriser is genuinely world-agnostic and would answer "is the hero about to hit that building" without a screenshot. But it hangs off `corners()`/`nextCorner()` and its own header calls it approximate and not a decision surface | defer |
| `docs/AGENT-WORLD-API.md`, `docs/CONSOLE-RECIPES.md` | — | adapt | Medium — the recipes format transfers | doc |

### Physics side-worlds (Phase 3)

| Candidate | Lines | Portability | Value | Cost |
|---|---|---|---|---|
| **`js/game/debrisworld.js`** | 1128 | **contract** | High **as a contract**, near-zero as code. `PLAN.md` Phase 3 wants Rapier; this is a repo that already integrated it and wrote down what it cost. The rules to take verbatim: *zero writeback* (the side world never moves a game entity); *inert when disabled* (a plain boolean guard, non-users never fetch the wasm); *dynamic `import()` off the boot path* (~90 ms one-time init, measured); *deterministic* (spawn variation seeded from tick/index, never `Math.random`); *mobile cap* (48 bodies, 16 on the mobile tier). And the measured budget: 22 mirrors + 100 debris ≈ 0.36 ms mean / 1.1 ms p95 per tick | ~150 lines of loader + contract; the bodies are new |
| **`js/game/incidentsim.js`** | 511 | **contract** | High as a contract. This is the module that is *allowed* to move a game entity, and it is the direct analogue of a combat ragdoll or a takedown animation taking over the hero. Its safety contract is the thing to copy: a **bounded window** with a hard cap that hands control back; mandatory fallback on any anomaly (non-finite, absurd teleport, Rapier throwing) reverting to last-good; and an explicit invalidation flag so timing is never *silently* corrupted. That maps onto this repo's own rule — "the hero's world position and velocity are the authority, exactly two things write back" — as a third, bounded, exception | contract only |
| `vendor/rapier-0.19.3/` | — | clean | The `sw.js` seed comment for it is already written here, which is good discipline | — |

### Tooling and process

| Candidate | Portability | Value | Cost |
|---|---|---|---|
| **`tools/wait-polling-lint.mjs`** | clean | Medium-high. `docs/TESTING.md` and `CLAUDE.md` both state the `polling` rule; 3/3 sites obey it today. A rule stated in prose and obeyed by hand is one careless spec away from the 109,665 ms failure. f1 has **353 violating sites** because it wrote the doc first and the lint late | 1 file |
| **`tools/evaluate-scope-lint.mjs`** | clean | Medium-high. A `page.evaluate()` callback is serialised, not closed over, so a module-scope `const` read inside is a `ReferenceError` in the page — and the test then fails for a reason unrelated to what it asserts. f1 lost every elevation track to this once and it read as a physics regression | 1 file (needs `eslint-scope`, which is a devDep this repo does not have — weigh that against the no-runtime-deps rule, which this does not violate) |
| `tools/assets.mjs verify` | adapt | Medium — D6. Retarget the budget check at all of `assets/` | ~120 lines |
| `tools/harness.mjs` | clean | Medium. This repo's `tools/_boot.mjs`/`_shot.mjs` are gitignored one-offs; a shared in-process server + Chromium launcher is what stops them multiplying | ~100 lines |
| `tools/pick-tests.mjs`, `test-bg.mjs`, `test-shards.sh`, `select-*.mjs`, `ci-coverage.mjs`, `test-observed.mjs`, `assert-audit.mjs` | adapt | **Low now.** Every one is a solution to "40 minutes of SwiftShader across 110 specs". This repo has 4 specs and a 10 s unit suite. Porting them now is machinery guarding nothing | no (revisit ~20 specs) |
| `tools/cross-file-paths.mjs` | clean | Low. 30 modules, an asserted import map | no |
| `tools/extract-module.mjs` | adapt | Low-medium. Becomes useful the first time `game.js` hits its ceiling — which is now | defer |
| `tools/motion-capture.mjs` | adapt | Medium. Headless rAF is frozen at 0 fps, so screenshots cannot see temporal artifacts; this records via `recordVideo` (which ticks the loop) and scores per-frame flicker. A swinging camera through a dense city is a *worse* case for shadow crawl and pop-in than a car on a track | ~150 lines |
| `tools/float-audit.cjs`, `clip-audit.cjs`, `coplanar-audit.cjs`, `graph-parity.cjs` | adapt | Medium at Phase 4-5. `coplanar-audit` (same-facing coplanar faces = z-fighting) applies directly to a city of stacked boxes; `graph-parity` is the gate to have *before* touching `citygen.js` for D9 | defer, except graph-parity if D9 proceeds |
| **`.claude/skills/`** (2 of ~28 present) | mixed | See §5 | ~1 file each |
| `docs/PARALLEL-WORK.md` | adapt | Low now — its subject is a 4-core box serialising a 40-minute browser suite | no |
| `docs/ARCHITECTURE-REVIEW.md` (standing defect register) | contract | Medium. This document is the start of one | — |

### Racing-specific — no value here

`quali.js` (322) · `career.js` (1293) + `career-ui.js` (1276) · `reliability.js`
(164) · `racecontrol.js` (225) · `aerozones.js` (112) · `parts.js` ·
`liveries.js` · `liverytex.js` · `teams.js` · `driver-ratings.js` · `ghost.js` ·
`car3d.js` · `carmesh.js` (509) · `results.js` (296) · `setup-ui.js` (752) ·
`tables.js` (74) · `physics-consts.js` (149) · `steer-tuning.js` (431) ·
`cam-modes.js` (108, and the C-key cycle is already here) · all of `js/track/`
beyond `graph.js` · all 40 of `js/circuits/` · all of `js/data/` (Jolpica/OpenF1
hub) · all of `js/net/` (no multiplayer is planned) · `light-presets.js` (2452
lines of per-circuit × time-of-day × weather values) · `atmosphere.js` (557,
`applyRaceSettings`) · `music-lib.js` (341, BYO-music IndexedDB) ·
`spotify.js` (1211) · `gltf.js` (453 — until the project loads a `.glb`, which
it does not) · `gfx.js` (171, the multi-backend façade — pointless with one
backend) · `js/render/webgpu/` and `js/render/three/` (both DEFERRED and both
below GLX parity in their own docs).

One partial exception worth naming: **`js/game/lighting.js` (753) +
`tuner.js` (187) + `light-store.js` (150)** — the `TUNE_DEFS` slider registry,
the live `LT` values and the five-layer per-context profile resolution. The
*presets* are worthless here but the *machinery* is not: this repo's night look
is ~40 hardcoded literals in `game.js`'s `frame` and `presentOpts`, and
`PLAN.md` §6 wants a day/night cycle. The registry-plus-panel pattern is what
produced f1's night look in the first place. **Defer to Phase 5**, then take
`lighting.js`'s registry shape and `light-store.js`'s resolution order, not the
values.

---

## 3. The next five things to port

Ordered by (value to the phone target and to the stated Phase 2 plan) ÷ cost.
The first three are defect fixes, not features, and together are under a day.

**1. The three drift defects: `sw.js` D1, touch nets D2, `store.js` D4.**
~35 lines across three files. D1 makes an offline install honest; D2 removes a
stuck-SWING failure that only appears on the exact device this project is aimed
at and that a desktop test can never see; D4 removes a silent-save-loss mode
that iOS Private Browsing triggers on the first write. None needs a design
decision, none touches a ceiling, and all three are fixes f1 already paid for.

**2. `PerfGov` (D5), and `packLights()` with it (D3).**
The project's stated purpose is running on an iPhone and it currently has no
adaptive anything: `renderScale` is 1.0 forever, no feature ladder, no crash
sentinel, and a per-frame allocation of ~58 k arrays/second feeding the GC.
Port perf.js with its three hard-won properties (derived budget, provisional
steps, build-keyed strike ledger) and rewrite the light cull against a pooled
buffer with the ramped forward bias. Do the `game.js` shadow-block extraction
first so the ratchet stays a ratchet. Measure with `gpuTimer()` — which is
already there — before and after, or the whole thing is a guess.

**3. `particles.js`.**
The largest visual return per line available. It is the cleanest module in the
whole survey — one injected dependency, zero racing knowledge, zero
steady-state allocation, and its draw entry point (`gfx.drawParticles`) is
already compiled into this renderer and has never been called. Web impact,
landing dust, wall scrape, speed motes; and it is the substrate Phase 4's
weather needs anyway. Keep it strictly in the render path, per this repo's own
"effects live in the render/audio path, never in the physics step" rule — which
is f1's rule, and which `skidmarks.js` is the cautionary example of getting
subtly wrong.

**4. `uilayers.js` + `topmodal.js`, as a contract, now — while it is 60 lines.**
This is the one recommendation that is about *timing* rather than value. Both
files exist in f1 because the same list got maintained in three places and
silently diverged by five screens, and because a top-layer `<dialog>` computes
`z-index: auto` so the obvious implementation hands the arrow keys to the wrong
pane. This repo has two screens and two consumers of that question. Every
screen Phase 2.9 and Phase 4 add makes this more expensive and no more valuable.
Take the rule and the `hidden`-stays-authoritative migration seam; leave
`menunav`, `scrollfade` and `ariastate` for when there is something to navigate.

**5. `tools/wait-polling-lint.mjs` + `tools/profile-gameloop.mjs`.**
Two small tools, opposite jobs. The lint converts this repo's most important
testing rule from prose into a check while compliance is still 3/3 — f1 wrote
the doc first and the lint at 353 violations. The profiler is the instrument
that should decide everything in item 2: `packLights` and `buildCity` are the
obvious suspects and neither has ever been measured here. f1's own recorded
lesson from the `waitForFunction` saga was that reaching for an instrument beat
a fifth theory; this is the instrument.

**Honourable mention, deliberately not in the five:** wiring `graph.batches()`
(D9). Potentially the largest single frame-time win available, and the reason
it is not ranked is that it trades the chunked mesh's spatial culling for
`cullInstances` and that trade has not been measured. Do item 5 first, then
this, gated by `graph-parity.cjs`.

---

## 4. Do not port

| | Why |
|---|---|
| **All racing gameplay** — career, quali, parts, liveries, teams, reliability, race control, aero zones, results, garage, ghosts, driver ratings | Nothing survives contact with a game that has no car, no lap and no field |
| **`js/track/` (except `graph.js`) and all 40 `js/circuits/`** | The spline, Frenet projection, road extrusion and arc position `s` are the exact abstraction this project replaced with a city grid and world-space collision. `js/city/` is the answer, not a stopgap |
| **`js/data/`** (Jolpica + OpenF1 hub, telemetry, standings, schedule, export) | Live F1 timing data. Also the only cross-origin traffic in either repo, which `sw.js` here is already correctly written to have none of |
| **`js/net/`** (13 files, WebRTC/Nostr/QR rendezvous, snapshots, lobby) | `PLAN.md` has no multiplayer phase. `snapshot.js` extrapolates along `s`; a swinging hero has no `s` |
| **`js/render/webgpu/` and `js/render/three/`** | Both DEFERRED in f1, both explicitly below GLX parity (no volumetrics, MSAA 1, no `gpuTimer`, no baked material arrays on WGX). Porting a second backend before the first is tuned is the definition of premature |
| **`js/render/gfx.js`** (the backend-selection façade) | Its only job is choosing between three backends. There is one |
| **`js/render/gltf.js`** | 453 lines of `.glb` loader for a project whose entire world is procedural and whose load-time budget (`PLAN.md` §6) is the reason it is procedural |
| **Tilt input + the One-Euro filter** | Tilt suits one continuous constrained axis. This game needs two axes plus four discrete verbs, and the posture is wrong. `input.js` already defers it; keep deferring it. (The One-Euro filter itself, ~25 lines, is worth remembering if a noisy analog signal ever needs smoothing — it is not worth the 180 lines around it) |
| **`light-presets.js`** (2452 lines) | Per-circuit × time-of-day × weather values for circuits that do not exist |
| **`music-lib.js` (341) + `spotify.js` (1211)** | Bring-your-own-music via IndexedDB and a Spotify Premium integration, for a game that ships three tracks and a `?v=` budget it is trying to protect |
| **The CI-selection tool family** — `pick-tests`, `select-budget`, `select-specs`, `select-recall`, `ci-coverage`, `test-observed`, `assert-audit`, `test-bg`, `test-shards`, `fixture-consumer-audit` | Every one exists to manage 110 specs and ~40 minutes of SwiftShader. This repo runs 4 specs and a 10 s unit suite. They would be machinery guarding nothing, and machinery that guards nothing is the thing this project's own module-size test is written to prevent. Revisit at ~20 specs |
| **`sheetshape.js`, `menunav.js`, `scrollfade.js`, `ariastate.js`** (for now) | Not wrong — premature. Each is cheap and lands unchanged whenever the screens exist. Record the findings (the inactive scroll timeline; `:modal` beating z-index) so they are not re-derived |
| **`docs/PARALLEL-WORK.md`, `docs/TESTING.md`'s background-queue discipline** | Written for a suite that takes tens of minutes per group. The one rule that already applies — never edit `js/`/`css/` while a run is in flight, because the test server serves the working tree — is already in this repo's `CLAUDE.md` |

---

## 5. Skills

Web-Slinger has 2 of f1's 28. Skills are ~1 file each and cost nothing to
carry, but a skill for a workflow that does not exist is noise in the matcher.

**Port now** (the workflow exists here today):

- **`playwright-probe`** — headless screenshots/evals. `tools/_boot.mjs` and
  `tools/_shot.mjs` are gitignored one-offs doing this job with no recipe.
- **`perf-profile`** — pairs with `tools/profile-gameloop.mjs`; item 5 above.
- **`webgl-debug`** — the renderer is ported verbatim, so its failure modes
  (shadow acne, uniform-array light bugs, `GL_INVALID_OPERATION`, instancing)
  are ported verbatim too.
- **`debug-state`** — `__spidey`'s `obs`/`act`/`step`/`place` loop is here and
  has no recipe.
- **`pwa-cache-service-worker`** — directly relevant given D1.

**Port when the matching work starts:**

- `game-feel` (Phase 2 feel pass, 2.1-2.7) · `motion-capture` (a swinging
  camera through a dense city is a worse temporal-artifact case than a car) ·
  `ui-menu-a11y` (with item 4) · `asset-pack` (with D6) · `agent-view` (if the
  agent surface grows) · `lighting-tuner` (Phase 5 day/night).

**Do not port:** `new-track`, `survey-track`, `scenery-dress`, `debug-tracks`,
`tune-physics`, `car-viewer`, `garage-parts-livery`, `career-mode`,
`multiplayer-debug`, `race-incidents-control`, `audio-debug` (f1's is about
engine-note pitch), `bake-lighting`, `scene-graph-instancing` (revisit only if
D9 proceeds), `debug-cameras` (13 racing camera modes).

Also worth taking from f1's skills README: the convention that a skill's
`description` says **when** to load it and the body carries the workflow. Both
skills here already follow it.

---

## Appendix — how to re-run this audit

The engine port is a hard fork with no upstream tracking. The check that found
D1-D4 is cheap and should be repeated whenever f1 lands a fix in a shared file:

```sh
# functional drift in the ported engine (expect: only IIFE→ESM + key renames)
for f in render/glx.js render/glx/post.js render/glx/shadow.js \
         render/glx/chunked.js render/assets.js render/shaders/*.js; do
  diff <(sed 's/[[:space:]]*$//' ../f1-game/js/$f) \
       <(sed 's/[[:space:]]*$//' js/$f)
done
diff ../f1-game/js/track/graph.js js/city/graph.js   # expect ONLY the D7 line
diff ../f1-game/sw.js sw.js
md5sum ../f1-game/assets/pack/*.png assets/pack/*.png

# what f1 has fixed since this repo was branched
git -C ../f1-game log --oneline --since=2026-08-08 -- js/game/input.js js/game/perf.js \
    js/render/ js/track/graph.js sw.js js/game/store.js
```

Baselines for this pass: f1-game `788a2bb`, spider-man `1b84304`, 2026-08-08.
