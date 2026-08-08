# Web-Slinger — adversarial architecture critique

An outside review, commissioned to find what is wrong, fragile, or
self-deceiving. It is deliberately unbalanced: every decision below is judged on
what it costs, and a decision is only called sound when the cost is named and
paid. Nothing here is a compliment.

**Scope.** Reviewed at commit `cf3ae26` ("fix(camera): stop the geometry clamp
pushing the eye through facades"), working tree at 2026-08-08 06:50 UTC, with
`tests/specs/audio.spec.js` and `tests/specs/touch.spec.js` present but
untracked and `package.json` / `playwright.config.js` dirty. **The tree moved
under this review**: `js/game/cameras.js` grew 130 → 183 lines and a commit
landed between two `git status` calls in the same session. Line references are
to that tree; a few will have drifted.

**What was actually run.** `node --test tests/unit/*.test.mjs` (twice, before
and after `cf3ae26`), a `buildCity(42)` heap measurement under
`node --expose-gc`, an import-graph cycle walk, and a call-site census of the
`GLX` surface. No Playwright, no edits to `js/` or `css/`.

**Comparison base.** `../f1-game` — `CLAUDE.md`, `docs/ARCHITECTURE.md`,
`docs/ARCHITECTURE-REVIEW.md`, `docs/research/ARCHITECTURE-REDESIGN-2026-08.md`.
The last of these matters more than this project seems to know: the sibling
convened a three-design panel on exactly the question Web-Slinger answered by
assertion, produced a native-ESM design ("Graphline"), **and did not adopt it**.
It adopted "Bedrock-with-grafts" and kept Graphline as a documented escalation
path. Web-Slinger did not take the rejected branch — it took Graphline's
*conclusion* without Graphline's *apparatus*: no generated import map
(`tools/gen-importmap.mjs`), no `tsc --checkJs --noEmit` boundary checking, no
import-hygiene guard with a cycle check, no generated precache. Sections 1 and 4
are mostly the bill for those four omissions.

---

## 1. The ES-modules-plus-import-map bet

> `docs/PLAN.md:41` — "It is a strictly stronger guarantee than the original, in
> less code."

**Verdict: FRAGILE.** The load-order half of the claim is true and cheap. The
"strictly stronger" half is false as written, and the cache-busting half has a
hole in production that no test can see.

### What is genuinely won

The browser resolves order from the import graph. `tools/manifest.cjs` is 82
lines against the sibling's manifest plus `HARD_EDGES`, `DEFERRED`,
`DEFERRED_EDGES` and `BACKEND_FILES`, and `tests/unit/load-order.test.mjs:100`
walks the real graph rather than a declared order. At 30 modules the unbundled
first load is also defensible on published measurement — HTTP/2 research finds
no meaningful difference under ~50 files
(https://philipwalton.com/articles/using-native-javascript-modules-in-production-today/).
Fine. That is the whole of the win.

### What the import map does NOT protect that `HARD_EDGES` did

`HARD_EDGES` records **eval-time** dependencies: B destructures A's global while
B is still evaluating. ESM does not delete that hazard; it renames it. In an
import **cycle**, ESM guarantees the linking order but not that an imported
binding is initialised when the other module's top level runs — you get a TDZ
`ReferenceError` at evaluation, i.e. exactly the `HARD_EDGES` failure with a
different error message.

I walked the graph: **there are no cycles today** (measured, 30 modules). But
nothing asserts that. `load-order.test.mjs` checks reachability, existence,
map coverage and preloads — never acyclicity. Graphline's own design listed
"import-hygiene.test.mjs (relative-imports-only, **cycle check**, legacy()
ratchet)" as a *new guard the migration must add*. Web-Slinger retired
`HARD_EDGES` and did not add the replacement. The class is not retired; it is
currently empty and unwatched.

Three more holes in the same guard:

- **Bare specifiers are silently skipped.** `load-order.test.mjs:87` —
  `if (!spec.startsWith(".")) continue;` with the comment "bare specifiers
  would need a map entry". It notes the requirement and then declines to assert
  it. `import * as THREE from "three"` passes every test in the file and fails
  at runtime.
- **Dynamic `import()` is invisible.** `staticImports()`
  (`load-order.test.mjs:74-79`) matches only `import`/`export … from "x"` at
  line start. A dynamically imported module is either reported as an orphan (a
  false failure) or, if someone adds it to `MODULES`, it is never checked for
  reachability. `sw.js:41-48` already carries two comments anticipating exactly
  this for Rapier and vendored three.js. The next planned feature breaks the
  guard.
- **The map, the preload list and `MODULES` are three hand-maintained copies of
  one fact.** `index.html:129-163` (30 map entries), `index.html:165-194` (30
  preload links), `tools/manifest.cjs:26-57` (30 paths). The sibling's founding
  critique — "two-place consistency is manual" — has become three-place
  consistency, and the test asserts they agree without generating any of them.
  A generator would collapse all three; a checked-in generated file is not a
  build step (Graphline says so explicitly).

### `?v=` on a query string is a cache key, not a content address

`?v=N` does not change what the server returns. `js/log.js?v=2` and
`js/log.js?v=3` are the same bytes on GitHub Pages. So the *only* thing linking
the version number to the content is a human running `npm run
test:tooling-fast` and remembering to bump. `load-order.test.mjs:55-63` can
prove the numbers agree with each other and can never prove the number changed
when the file did. Content-hash filenames (the technique both cited references
actually use —
https://banno.com/articles/improving-caching-with-import-maps/,
https://qubyte.codes/blog/progressively-enhanced-caching-of-javascript-modules-without-bundling-using-import-maps)
make the invariant mechanical. A global counter makes it a ritual. The sibling
has the same problem; inheriting it is not the same as improving on it.

### What happens on a `?v=` mismatch in a live PWA

Three failure modes, none tested:

1. **Modulepreloads are classified OPTIONAL by the service worker.**
   `sw.js:52-64` walks `<script|link>` tags and does
   `if (script || rel="stylesheet") essential.add(u); else optional.add(u);`.
   Every `<link rel="modulepreload" href="js/…?v=N">` is neither, so **29 of
   the 30 JS modules land in the optional set** — and `cacheOptionalAsset`
   (`sw.js:74-79`) swallows every failure. An install can be declared complete
   (`INSTALL_COMPLETE_URL` written at `sw.js:86`, *before* the optional pass)
   with only `index.html`, two stylesheets, `version.json` and `js/game.js`
   cached. That PWA is broken offline, and `activate` will happily sweep the
   previous good generation. The header comment at `sw.js:6-11` claims "CORE
   assets (index.html, css/js it references) are discovered … automatically" —
   for 29 of 31 files that claim is false.
2. **The `<script type="importmap">` block is invisible to the SW** (no
   `src`/`href`, so `sw.js:56` `continue`s). This is benign today only because
   the modulepreload hrefs happen to carry the same mapped URLs. Delete the
   preload links as a "first-load optimisation" and the offline install
   silently loses the whole module graph.
3. **The shell version guard can report "up to date" while stale.** Offline or
   on a slow link, `sw.js:129-158` races `version.json` against a 3 s timeout
   and falls back to the **precached** `version.json`. The guard at
   `index.html:33-41` then compares the cached build against itself, finds
   `v.build <= loaded`, and does not reload. Meanwhile `js/*.js?v=<old>` fetches
   resolve to whatever bytes the server currently has — new code under an old
   HTML shell, the exact state the guard exists to prevent. Banno documents the
   general shape: "if your service worker maintains a list of files to pre-cache,
   those URLs will not be re-mapped by an import map… you will need two
   different service workers."

Also worth knowing before this ships behind any CSP: `<script type="importmap">`
is an inline script and no browser supports an external one, so a strict CSP
needs the map's hash. The sibling's review lists "No CSP" as an open defect;
Web-Slinger inherits it *and* has added a reason it will be harder to add.

**Recommendation.** (a) Generate `index.html`'s map + preload block from
`tools/manifest.cjs` with a checked-in generator and assert the file is
regenerable — kills three-place drift and the bump ritual in one move.
(b) Add the cycle check and a bare-specifier assertion to
`load-order.test.mjs`. (c) Fix `sw.js:59` to treat `rel="modulepreload"` as
essential — one condition, and it is the difference between a working offline
install and a broken one. (d) Write down that `?v=` is a cache key, not an
integrity check, next to the claim in `docs/PLAN.md:41`, and stop calling the
guarantee "strictly stronger".

---

## 2. The absent `G` façade

**Verdict: SOUND at this size — but the premise of the question is wrong, and
that is itself the finding.**

Web-Slinger *does* build a `G` façade. `js/game.js:424-436` passes an object of
live getters and setters (`get state()/set state(v)`, `get city()`, `hero`,
`cams`, `gfx`, `update`, `loadCity`, `snapPrev`, `frame`, `presentOpts`) to
`createApi`, and `js/game/spidey-api.js:9` names its parameter `G` and its
header says "G is the live-getter façade the driver hands in". So the pattern
was ported; it was just scoped to **one consumer**.

That scoping is the right call, and the sibling's own review says why:

> "`G` is a plain object; nothing stops a module reading a global directly, and
> nothing stops `G` growing until it is game.js's closure with extra steps. It
> is a **migration device left in place as an architecture**."
> — `../f1-game/docs/ARCHITECTURE-REVIEW.md` §4

A migration device is worthless in a codebase with nothing to migrate from. ESM
gives real named imports, so `js/game/hero.js` importing `HeroConsts` directly
is strictly better than reading it off a bag: the dependency is declared, the
graph walk sees it, and there is no accessor to add before you can use a value.

**The cost, named.** The façade at `js/game.js:424-436` is not a boundary, it is
a hole in one. It hands out `hero`, `cams`, `gfx`, `frame`, `presentOpts` and
`update` by reference. `spidey-api.js` therefore has full mutation rights over
the renderer's per-frame state and the physics driver, and
`js/game/spidey-api.js:35-42` uses them: `stepN` writes `G.testInput`, calls
`G.snapPrev()` and `G.update()` directly. There is no read-only view and no
seam. The moment a second consumer wants any of that, the choice will be
"import game.js" (impossible — it is the entry and exports nothing) or "widen
the literal", and the literal will become the sibling's `G`.

**What breaks first as it grows.** Not module coupling — `js/game.js` is a
closure with no exports, so nothing *can* import it. What breaks is the
**driver's line budget** (§3): every new subsystem has to be wired in
`js/game.js`, and `js/game.js` is 440 lines against a 460 ceiling. The first
feature that needs 25 lines of boot wiring forces either a ceiling raise or an
extraction that has nowhere to go, because there is no seam to extract *to*.
That is 20 lines away.

**Recommendation.** Do not build a general `G`. Do the opposite: when a second
consumer appears, extract a named module with an explicit `create({…})`
signature listing exactly what it needs, and rank extraction candidates by
**boundary crossings, not line count** — the sibling learned that the expensive
way (`ARCHITECTURE-REVIEW.md` §4: a 415-line module blocked on a missing seam
versus a small one with three crossings). Ranking by size picks the wrong one
first.

---

## 3. The module-size ratchets

**Verdict: FRAGILE.** The mechanism is good; the roster is stale, the metric is
the wrong one for the file that actually needs guarding, and it is about to
force a bad extraction.

`tests/unit/module-size.test.mjs:24-38` guards seven files. Current sizes:

| file | lines | ceiling | slack |
|---|---|---|---|
| `js/game.js` | 440 | 460 | **20** |
| `js/city/buildings.js` | 393 | 420 | 27 |
| `js/game/hero.js` | 354 | 380 | 26 |
| `js/city/colliders.js` | 180 | 220 | 40 |
| `js/hero/hero3d.js` | 191 | 240 | 49 |
| `js/city/citygen.js` | 168 | 220 | 52 |
| `js/game/spidey-api.js` | 127 | 180 | 53 |

**Not guarded at all:**

| file | lines |
|---|---|
| `js/render/shaders/lit.js` | 1375 |
| `js/render/shaders/post.js` | 1231 |
| `js/render/glx.js` | **1586** |
| `js/render/glx/post.js` | 807 |
| `js/render/glx/shadow.js` | 306 |
| `js/game/cameras.js` | 183 (was 130 one commit ago, **+41%**) |
| `js/game/audio.js` | 209 |
| `js/game/touch.js` | 156 |

The ratchet is guarding 2,053 lines of gameplay and leaving 6,552 lines of
renderer plus every module written after the roster was fixed completely
unwatched. `js/game/cameras.js` grew 41% in a single commit during this review
and nothing noticed. The roster is a snapshot of "which files were big on the
day the test was written", not a policy.

**Where it is about to force a bad extraction.** `js/game.js` has 20 lines of
headroom, and it is the one file that *must* absorb every new subsystem's boot
wiring. Phase 2 in `docs/PLAN.md` §3 lists nine items; §2.7 (speed-linked
camera) and §2.8 (input buffering) both need driver wiring. The ratchet's own
docstring says "Do not raise this to land a feature; put the feature in a
module" — but the feature isn't the problem, the *wiring* is, and wiring cannot
be put in a module without a seam that does not exist (§2). The predictable
outcome is a `js/game/boot.js` that is game.js's closure moved sideways: the
line count falls, nothing improves, and the ratchet reports success. That is the
failure mode of measuring lines.

**Where it protects nothing that needs protecting.** `js/city/citygen.js` (52
lines slack) and `js/game/spidey-api.js` (53) are not files anyone is fighting
to keep small. Meanwhile `js/render/glx.js` is 1,586 lines of which **29 of its
53 exported members have zero callers in this repo** (§6) — a file with real
drift, real dead code, and no guard.

Two smaller notes: `lines()` (`module-size.test.mjs:21`) counts
`split("\n").length`, which over-counts by one for any file ending in a newline
— every ceiling is really N−1. And the anti-slack test's 120-line window
(`:57`) is wide enough that `js/game/spidey-api.js` could shed 50 lines without
tripping it.

**Recommendation.** (a) Change the roster rule from a hand-picked list to
"every `.js` in `js/` over N lines must have an entry" — a bidirectional
assertion, the pattern the sibling uses everywhere (`tools/README.md`,
`RENDER_SPECS`, docs counts). New files then join automatically or fail loudly.
(b) Add `js/render/*` to it, or state in the test's header that the ported
renderer is deliberately exempt and why. (c) Raise `js/game.js` to 500 *now*,
deliberately, with the reason "the driver absorbs boot wiring and has no
extraction seam" — better than being cornered into a cosmetic extraction in six
weeks.

---

## 4. The headless / renderer split

**Verdict: FRAGILE.** The boundary is genuinely valuable and the fast suite is
the best thing in this repo. The *regex that guards it* is unsound in four ways,
and the boundary the tests actually depend on is not the boundary the guard
asserts.

The guard, `tests/unit/load-order.test.mjs:137`:

```js
const banned = /\b(document|localStorage|requestAnimationFrame|navigator)\b|from "\.\.\/render\//;
```

**1. `window` is not banned.** A headless-safe module may write
`window.foo`, read `window.innerWidth`, or call `window.performance.now()` and
pass. So may `globalThis`, `self`, `screen`, `location`, `fetch`,
`Date.now`, `performance.now` and `Math.random` — the last two being precisely
the names `CLAUDE.md:140-143` declares forbidden. The rule the guard enforces
and the rule `CLAUDE.md` states are different rules.

**2. Single-quoted render imports are missed.** The alternation is
`from "\.\.\/render\/` — double quotes only, and only the exact `../render/`
depth. `from '../render/glx.js'` or `from "../../render/glx.js"` (a module one
directory deeper, which does not exist yet) both slip the second half. They are
still caught transitively, because `glx.js`'s own text contains `navigator` —
but the failure message will name `glx.js`, not the import that pulled it in.

**3. It matches comments and strings.** A comment in a headless module reading
"never touch `document` here" fails the test. That is a false positive waiting
to teach someone to soften the regex.

**4. The boundary that matters is not the one asserted.**
`tests/unit/camera-los.test.mjs` imports `js/game/cameras.js` in bare Node and
is now one of the most valuable tests in the repo — but `cameras.js` is **not**
in `HEADLESS_SAFE` (`tools/manifest.cjs:76-80`), and it calls
`performance.now()` at `js/game/cameras.js:169`. The test works only because it
calls `vantage()` and never `tick()`. Nothing records that dependency, so the
day someone adds a `document` read to `cameras.js` the failure lands in an
unrelated suite with a confusing message — the exact outcome the guard's own
comment (`load-order.test.mjs:134-136`) says it exists to prevent.

### Where the boundary is costing something real

**The camera clamp is tested where it is cheap, not where it ships.**
`js/game/cameras.js:145-172` `tick()` damps `eye` toward the clamped vantage
with `lE = 7…10`. The *shipped* eye is therefore a lerp between the previous
eye and a cleared target — and a lerp between two unoccluded points is not
unoccluded, because buildings are not convex hulls along that path. On top of
that, `tick()` adds trauma shake to `eye` **after** damping (`:167-171`) with no
re-clamp, so shake can push the eye into a facade by construction.
`camera-los.test.mjs` calls `vantage()` directly. And
`tests/specs/city-visual.spec.js` calls `S.snapCam()` on every sample — which
jumps straight to the same undamped vantage. **Both tests measure the solver;
neither measures the camera.** The browser spec costs ~4 minutes under
SwiftShader to assert a weaker version of what the Node test asserts in 43 ms.

That said, the split earned its keep during this review. At commit `1b84304` the
Node test failed **43/200 canyon frames, every one at `eyeDist=2.80` against a
`hit at t=1.98`** — a one-line diagnosis (`Math.max(MIN_D, hit.t - PAD)` lets
the framing preference override the wall) that the browser spec had reported for
two sessions as an unexplained `0.30 of frames`. `docs/HANDOFF.md:52` called it
"the one confirmed product defect open" without the diagnosis. It was fixed in
`cf3ae26` while this review was in progress, and the new constant block
(`js/game/cameras.js:20-30`) writes the reasoning down properly. That is the
split working exactly as advertised — which is why the guard around it deserves
to be sound.

**Recommendation.** (a) Replace the regex with a small AST/identifier scan and
ban the full list `CLAUDE.md` actually claims: `document, window, globalThis,
self, localStorage, navigator, requestAnimationFrame, performance, Date, fetch,
Math.random`, with an explicit per-module allow-list carrying reasons.
(b) Add `js/game/cameras.js` to `HEADLESS_SAFE` and move the shake's
`performance.now()` behind an injected clock — it is cosmetic and it is the only
thing blocking the move. (c) Add one Node test that drives `tick()` over
synthetic `dt` and asserts the **damped** eye stays clear; then delete the
4-minute browser duplicate.

---

## 5. Determinism as a feature

**Verdict: FRAGILE.** It holds where it is tested, in one engine, and the tested
surface is narrower than the claim.

> `CLAUDE.md:140-143` — "No `Math.random` anywhere reachable from `hero.step()`
> or `buildCity()`. Same seed and inputs must replay bit for bit."

**What holds.** Measured: `Math.random` appears once in `js/`, at
`js/game/audio.js:63` (noise buffer, unreachable from either). `performance.now`
appears at `js/game.js:248/279/438`, `js/game/cameras.js:169` and
`js/log.js:176` — all render/audio/logging. `Date.now` appears nowhere in `js/`.
Sorts are stable-by-spec or key-ordered (`js/city/graph.js:324`,
`js/game.js:148`). No float-order dependence found in the city loops: the lamp
walk `for (let d = -edge; d <= edge; d += LAMP_STEP)` (`js/city/citygen.js:151`)
accumulates exactly-representable integers.

**What does not hold.**

- **`hash()` is `fract(sin(x) * 43758.5453)`** (`js/city/citygen.js:20-23`,
  duplicated at `js/city/geom.js:203`). `Math.sin` is *implementation-approximated*
  in ECMAScript — it is not required to be correctly rounded, and V8,
  SpiderMonkey and JavaScriptCore do not agree in the last ulp. The claim
  "same seed, same city, **byte for byte**" (`js/city/citygen.js:7`) is therefore
  an assertion about V8 specifically. Every test that could catch it — the Node
  unit suite and the Chromium browser suite — runs on V8. The practical blast
  radius is small (a last-ulp difference shifts a threshold comparison only when
  a sample lands within ~1e-11 of it), but the *claim* is unfalsifiable by the
  test suite that is cited as proving it, and a Firefox or Safari player gets a
  different city with no way to know. Say "deterministic on V8", or switch to an
  integer hash (PCG/xorshift) and make the claim true.
- **`__spidey.step()` with no input is nondeterministic.**
  `js/game/spidey-api.js:84` calls `stepN(G.testInput, …)`, which sets
  `G.testInput = input || null`. With `null`, `js/game.js:182-193` `inputFrame()`
  falls through to the live `Input.*` edges **and** computes a camera-relative
  direction from `cams.eye` — a wall-clock-damped value. So `step()` is
  deterministic and `act()` is deterministic, but `step()` after `clearInput()`
  quietly is not. Nothing documents this and nothing tests it.
- **`obs()` mutates the thing it observes.** `js/game/spidey-api.js:15-21` calls
  `hero.pickAnchor()` three times, and `pickAnchor` writes `bestSide`
  (`js/game/hero.js:84`, `:92`), which feeds the auto-straighten memory
  consumed at `js/game/hero.js:81`. Polling `obs()` therefore changes the
  trajectory. `tests/unit/camera-los.test.mjs:14-18` documents this in a NOTE
  and works around it. It is a defect in the observer, not a fact to route
  around — it means every rollout that reads observations diverges from one that
  does not, which is precisely the property determinism is for.
- **The invariant has no structural guard.** Determinism is held by two
  behavioural tests (`hero-swing.test.mjs` "same inputs replay exactly",
  `citygen.test.mjs` "same seed builds a byte-identical city"). Both run twice in
  the same process, so a `Date.now`-derived value would be caught only by luck of
  timing, and neither covers the whole reachable set. The sibling's answer to
  this class is a lint (`tools/vstd-lint.mjs` + `vstd-invariant.test.mjs`); the
  equivalent here is ten lines.

**Recommendation.** (a) Make `obs()` non-mutating — snapshot and restore
`lastSide`/`bestSide`, or give `pickAnchor` a pure mode. This is the one that
actually corrupts measurements. (b) Add the forbidden-identifier scan from §4
over `hero*.js` + `js/city/*` and delete the prose version of the rule.
(c) Either replace the `sin`-hash with an integer hash or amend the claim to
name V8.

---

## 6. The ported renderer

**Verdict: WRONG as characterised, and now an active liability.**

> `docs/PLAN.md:24-29` — "roughly 4,000 of its 7,200 renderer lines carry no
> racing knowledge at all".

`js/render/` is **6,552 lines**. The port did not take the racing-agnostic 4,000
and leave 3,200 behind; it took essentially all of it and left the seven
racing-specific `js/track/` files behind instead. That is a defensible
engineering choice — a renderer does not split cleanly — but the plan's headline
number describes a port that did not happen, and it is the number the project
uses to justify the bet.

### The census

Of `GLX`'s 53 exported members, **29 have zero callers anywhere in
`js/game*`, `js/city/`, `js/hero/`, `js/render/assets.js` or `tests/`**
(measured):

`aabbInFrustum, carShadowState, castShadowInstanced, createInstancedBatch,
createTexMesh, createTexture, cullInstances, drawDecal, drawInstanced, drawMark,
drawParticles, drawShadow, drawSkidBatch, envFaceBegin, envFaceEnd,
envProbeReady, envProbeReset, freeInstancedBatch, getRenderScale, gpuMs,
gpuTimer, hdrMode, lampShadowBegin, lampShadowEnd, lampShadowState,
makeFrustumPlanes, msaa, pcss, setRenderScale`

The unreachable implementations in `js/render/glx.js` alone —
`createTexMesh` (`:526`), `drawDecal` (`:674`), `envFaceBegin/End` (`:758`),
the whole instancing path (`:1135-1275`), `drawMark` (`:1363`),
`drawSkidBatch` (`:1384`), `drawParticles` (`:1477`) — total roughly **390
lines**, plus their GLSL in `js/render/shaders/fx.js` (179 lines, almost
entirely decal/mark/skid/particle), plus the dynamic-car shadow path in
`js/render/glx/shadow.js`, plus 30 `uCar*`/`uWetness`/`uSparkle`/`uClearcoat`/
`trk` references in `lit.js` and 11 in `post.js` for car paint, wet road, road
markings, SSR car-paint tagging and speed blur — every one of which still
compiles into the shipped program and still costs a uniform upload per frame.

**The inherited things this game will never use, specifically:** the car-paint
clearcoat + env-probe cubemap (`glx.js:83-84`, `:754-790`); the sponsor/livery
decal pass (`:674`); the skid-mark ring buffer and its batched draw (`:1363`,
`:1384`); the tyre-smoke/spark/rain particle batch (`:1477`); the road-marking
`trk` vertex attribute that lets the fragment shader draw a start line
analytically (`glx.js:482-486`); wet-road SSR tuned for a tarmac grazing angle
(`glx/post.js:737-747`); the mountain emitter with a snowline and a forest zone
(`js/city/geom.js:195-235`, zero callers, in a Manhattan grid).

### The liability

Two are worse than dead weight.

**(a) `js/city/graph.js` is a scene graph nobody reads.** `graph.instance()` is
called ~85k times (`js/city/buildings.js:35-36`, `js/city/citygen.js:135`), and
`graph.batches()` — the "instanced-draw handoff" the whole module exists for —
**has zero callers**. `GLX.createInstancedBatch` also has zero callers. So the
geometry is `replay()`ed straight into the fused soup and drawn as chunked
meshes, and `docs/PLAN.md:55-56`'s headline "**85,484 instanced nodes from 3
models (≈10,000× reuse)**" describes a saving nobody takes. What it costs,
measured: `city.graph.nodes` retains **26.5 MB** of JS heap for the whole
session, for a feature that is not wired up. The file's header is also still the
sibling's (`js/city/graph.js:1-41`: "Apex 26 — TrackGraph", `buildProps`,
`js/track/tracks.js`, `tools/float-audit.cjs`, "Load order: before
js/track/tracks.js") — none of which exists here. The sibling has
`tests/unit/comment-citations.test.mjs` for exactly this; Web-Slinger dropped it
and has the drift on day two. `js/render/assets.js:26` is the reductio: an ES
module whose header reads "NO build step, no ES modules".

**(b) The baked asset pack is 88% unused layers.** Measured MAT ids emitted by
`buildCity(42)`: `0 FLAT`, `1 CONCRETE`, `3 GLASS`, `4 METAL`, `16 ASPHALT` —
five of the pack's 17. The other twelve (brick, wood, foliage, fabric, sand,
grass, rock, snow, roof, stone…) ship as filmstrip layers inside
`mat-albedo-256.png` (2.4 MB) and `mat-normal-256.png` (2.0 MB). `assets/` is
22 MB total, 17 MB of it soundtrack. `docs/PLAN.md:206-211` cites a study where
6 MB / 3.7 s converts 72% of visitors and 40 MB / 29.5 s converts 50%, calls it
"the hardest number here", and the repo then commits 22 MB of assets. Also,
`assets/pack/CREDITS.md:3` says "Generated by `node tools/assets.mjs credits`" —
`tools/` contains two files and that is not one of them.

**Recommendation.** (a) Either wire `graph.batches()` to
`GLX.createInstancedBatch` — the payoff is real, 2.1 M fused verts collapsing to
204 unique — or delete `js/city/graph.js` and drop the 26.5 MB and the PLAN
claim with it. Doing neither is the worst option and is the current state.
(b) Rewrite the ported file headers to describe this repo, and port
`comment-citations.test.mjs` so they cannot rot again. (c) Bake a 5-layer pack.
(d) Decide, in writing, whether the unreachable GLX surface is "kept for Phase
3-5" (then say which member serves which phase) or dead (then delete it). An
undeclared 390 lines is how a `WGX`-shaped frozen backend happens.

---

## 7. The `window.__spidey` contract

**Verdict: FRAGILE.** It is coherent — 24 members, grouped, no throws, `G`-fed —
and considerably tidier than the sibling's ~180 accreted hooks. It is also
missing the two things the tests most need, and it already has one dead member
and one wrong-vocabulary member.

**Coherent.** `js/game/spidey-api.js` follows the stated contract: staging
(`info/play/place/park/freeze/reset`), a deterministic loop
(`headless/setInput/clearInput/step/act/obs/seed`), camera, world queries, logs.
Failures return `null`/`false`, not throws. `nearGeometry()` (`:115`) is a
genuinely good addition — it encodes a measured lesson (a ray at a point on a
vertical face runs tangent and misses; 1 of 5 anchors detected) as an API rather
than as a comment.

**What is missing, and what the tests do instead.**

- **No way to advance N *rendered* frames.** `step()`/`act()` never present.
  So `tests/specs/city-visual.spec.js:22-26` defines `framesFn` in Node, passes
  `framesFn.toString()` into the page, and does
  `await eval("(" + src + ")")(30)`. That is a hand-rolled workaround for a
  missing hook, and it is one line away from the trap `docs/TESTING.md:97-99`
  warns about ("never let an `evaluate` callback close over a Node-side
  binding"). It has already half-rotted: two of the four tests in that file
  accept `src` and never use it.
- **No way to observe the damped camera.** `camState()` reads `cams.eye`, but
  `eye` only advances inside `render()`, so every spec calls `snapCam()` first
  and measures the undamped solve (§4). There is no `__spidey.camTick(dt)` and
  no headless render step, so the shipped camera path is untestable except
  through real SwiftShader frames.
- **No raster hook.** The sibling has `__apex.render({what:"view|map|circuit|car"})`
  precisely so a visual check does not cost a screenshot. Here every visual
  assertion is a real `page.screenshot` (`city-visual.spec.js:150`, budget
  180 s) or nothing. `docs/TESTING.md:46-48` measures the cost at 88-96 s
  un-quiesced. That is the reason `test:visual` asserts "the PNG is bigger than
  20 kB" instead of anything about the image.
- **`obs()` mutates** (§5). A dev API whose read perturbs the subject is a
  measurement instrument that is also a load.

**Dead and wrong members.**

- `tests/helpers/fixtures.js:121` — `pick(() => a.state && a.state())`.
  `createApi` returns no `state`. Every failure attachment has recorded
  `state: undefined` since it was written, and will keep doing so silently.
- `CLAUDE.md:170` and `docs/TESTING.md` advertise
  `__spidey.logs({ ns: "city" })` and `SPIDEY_LOG=city:debug`. `js/log.js:49-60`
  still declares the sibling's namespaces (`scenery, track, gfx, game, data,
  net, audio, assets, apex`) and the code logs under `scenery`, `gfx` and
  `game`. **There is no `city` namespace.** The documented way to turn up
  diagnostics on the city generator is a no-op.
- `tests/specs/audio.spec.js` (untracked, in flight) calls `__spidey.music()`
  five times. `spidey-api.js` has no `music`. That spec cannot pass today.

**Recommendation.** Add three members and delete two lies:
`frames(n)` (await N presented frames), `camTick(dt)` (advance the rig without
rendering), and a non-mutating `obs()`. Delete `a.state()` from `fixtures.js`.
Replace `js/log.js`'s `NAMESPACES` with this project's (`city`, `hero`, `gfx`,
`game`, `audio`, `assets`, `spidey`) and fix the two docs.

---

## 8. The riskiest thing in the codebase that nobody has written down

**A `buildCity(42)` allocates 287 MB of JavaScript heap, and roughly 192 MB of
it is still resident after the meshes are on the GPU — for the whole session, on
a target platform whose memory budget this project's own renderer comments put
at ~100 MB.**

Measured under `node --expose-gc`: 287.3 MB to build; 191.7 MB still reachable
after simulating what `createChunkedMesh` frees. The buffers are the reason.
`city.out` holds `pos` 5,029,134 + `nrm` 5,029,134 + `col` 5,029,134 + `mat`
1,676,378 + `idx` 2,496,390 **plain JS array elements** (8-byte doubles), and
`city.glassBuf` holds another 4.8 M. `js/render/glx/chunked.js:105-112` nulls
`data.pos` and `data.idx` — and its comment says exactly why, quoting the
sibling's own street-circuit measurement — but it leaves `nrm`, `col` and `mat`
alone, and `js/game.js:50-66` `loadCity()` keeps the whole `city` object alive
forever via the closure, `G.city` and `__spidey.city`. `GLX.createMesh`
(`js/render/glx.js:470-520`), which uploads `city.ground` and all ten hero
segments, frees nothing at all. On top of that sits the 26.5 MB of
`graph.nodes` for a feature with no consumer (§6).

Nothing measures this. There is no memory assertion in any suite, no
`__spidey` hook that reports it, and no line in `CLAUDE.md`, `docs/PLAN.md` or
`docs/HANDOFF.md` that mentions heap at all. Meanwhile `js/render/glx.js:22-27`
carries a detailed inherited comment about iOS WKWebView jetsam being "a hard
kill, no JS error, no `contextlost` event" — the project imported the *warning*
and not the *habit*. And `docs/PLAN.md` §6's growth plan is "chunked or
worker-driven generation to grow past 1.25 km²", i.e. **more city**. The city is
already 2.4× larger in resident JS heap than the platform budget the renderer's
own comments describe, the failure mode is a silent tab kill with no stack
trace, it will appear first on exactly the phones the touch controls were built
for, and the fix — null `nrm`/`col`/`mat` after upload, drop `graph.nodes`,
build into `Float32Array`s instead of `[]` — is perhaps thirty lines. Nobody has
looked because there is no number to look at.

---

## The five things most worth changing, cheapest first

1. **`sw.js:59` — treat `rel="modulepreload"` as essential.** One condition.
   Today 29 of 30 modules are best-effort-cached and an install can be declared
   complete without them, which is a broken offline PWA that reports success.
2. **Fix the two documented no-ops.** Delete `a.state()` from
   `tests/helpers/fixtures.js:121`; replace `js/log.js:49-60`'s namespace list
   with this project's and correct `CLAUDE.md:170` / `docs/TESTING.md`.
   Ten minutes, and it stops the documented debugging entry point being a lie.
3. **Free the city's CPU-side buffers after upload, and drop `graph.nodes`.**
   ~30 lines against ~190 MB of resident heap (§8), plus a `__spidey.mem()` hook
   and one assertion so it cannot regress. This is the one that decides whether
   the game runs on a phone.
4. **Make `obs()` non-mutating** (`js/game/spidey-api.js:15-21` /
   `js/game/hero.js:84`). Small, and it is currently corrupting every rollout
   that reads observations — including any A/B the traversal tuning in
   `docs/PLAN.md` §2.1 depends on.
5. **Generate `index.html`'s import map + modulepreload block from
   `tools/manifest.cjs`, and add the cycle + bare-specifier checks to
   `load-order.test.mjs`.** Half a day. It collapses three-place manual
   consistency to one, kills the bump ritual, and closes the two holes
   `HARD_EDGES` used to cover. This is the change that makes `docs/PLAN.md:41`'s
   claim true instead of aspirational.

*(Runner-up, deliberately not in the five because it is a decision rather than a
fix: resolve `js/city/graph.js` — wire `batches()` to `createInstancedBatch` or
delete the module. Doing neither is strictly worse than either.)*

---

## Things that look wrong but are fine — leave them alone

- **No `G` façade for the game modules.** It looks like a missing pattern from
  the sibling. It is the right omission: `G` is a migration device for a
  codebase with IIFE globals, and ESM's named imports are strictly better.
  See §2 — the sibling's own review says as much.
- **The unbundled 30-module load.** Under ~50 files HTTP/2 shows no meaningful
  penalty, and the modulepreload block already removes the waterfall. Do not add
  a bundler to fix a problem you do not have; the 17 MB of MP3s is the load-time
  problem.
- **`js/city/buildings.js` at 393 lines with a 420 ceiling.** One cohesive
  `switch` over ~18 silhouettes. Splitting it would produce two files that must
  be read together. The test's own comment already calls it "a drift alarm
  rather than an extraction target" — correct.
- **The 0.29 / 0.34 / 0.40 facade standoffs** (`js/city/buildings.js:62-68`).
  They look like magic numbers. Each is a shipped z-fight fix and the comment
  says so. Do not tidy them.
- **The velocity rescale after the tether clamp** (`js/game/hero.js:237-242`).
  It looks redundant after the position clamp. It is the load-bearing line —
  146 m/s against a 52 m/s cap without it. The comment is correct and the test
  ("the speed cap is soft") pins it.
- **`VMAX` as a soft drag threshold rather than a clamp**
  (`js/game/hero-consts.js:70-78`, `js/game/hero.js:190-198`). Reads like a
  missing clamp; it is a deliberate two-tier design with `VHARD` underneath and
  a measured percentile distribution behind the number.
- **`assets/pack/webbake.js` living under `assets/` rather than `tools/`.**
  It looks misfiled. Its header explains it: `js/` requires a manifest entry and
  a tag, and this is a browser-loaded dev tool `index.html` never references.
  The placement is reasoned.
- **`retries: 0` locally, `1` in CI** (`playwright.config.js`). Looks like
  flake-hiding. The comment is right: surface it locally, absorb infra blips in
  CI, and the live reporter counts flaky either way.
- **`tests/unit/camera-los.test.mjs` asserting a budget of exactly zero.**
  It looks brittle next to the browser spec's 0.15. It is calling a pure
  deterministic solver, so any offender is real — and that strictness is what
  produced the one-line diagnosis in `cf3ae26`. Keep it at zero.

---

## Two process notes, since they affect everything above

**The fast suite was red at `1b84304` and CI would not have deployed.**
`.github/workflows/ci.yml` runs `npm run test:tooling-fast` in the `guards` job,
and `.github/workflows/pages.yml` has `needs: ci`. At `1b84304`,
`node --test tests/unit/*.test.mjs` was **52/54**. So `docs/HANDOFF.md:40`'s
next action #4 ("Deploy: set Pages Source to GitHub Actions, push") would have
failed at `guards`, not at the Pages setting — and `docs/HANDOFF.md:26`'s
"50/50 green" was already stale when it was written. It is 54/54 at `cf3ae26`.
The sibling's own lesson applies verbatim: *"A guard nobody runs is prose with
extra steps."*

**`playwright.config.js:53` claims a guard that does not exist.** "Keep this
list exhaustive against `tests/specs/*.spec.js` (a coverage-audit npm script
asserts every spec lands in exactly one project)." There is no such script in
`package.json`. Two new specs (`audio`, `touch`) have already landed outside
`RENDER_SPECS`, so both run in the `headless` project — and `touch.spec.js`
asserts DOM classes and dispatches CDP touch events, which is a render-project
spec by that file's own definition. `testIgnore: ["**/manual/**"]` also guards a
directory that does not exist. Ported prose describing a repo this is not.
