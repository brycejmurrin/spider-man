# Testing

Two halves. The fast half has no browser and catches most defects; the slow half
drives real WebGL under software rendering and catches the rest.

```sh
npm run test:tooling-fast   # 50 assertions, no browser, ~10 s — run this constantly
npm run test:smoke          # boot, dev API, non-blank frame
npm run test:swing          # headless traversal, determinism, anchors on geometry
npm run test:visual         # camera vantages, light cap, line of sight, GL errors
```

## 1. The fast half is fast on purpose

`js/city/*` and `js/game/hero*.js` import nothing from `js/render/` and touch no
DOM. That is not tidiness — it means the entire world generator and the entire
traversal model load in bare Node, so the city builds and the hero swings for
thousands of steps inside `node --test`, in about ten seconds, with no GPU.

`tests/unit/load-order.test.mjs` asserts that property directly: it walks the
import graph from every module named in `HEADLESS_SAFE` and fails if anything
reachable mentions `document`, `localStorage`, `navigator` or the renderer. When
that test goes red, the cheap suite is about to become an expensive one.

| Suite | What it pins |
|---|---|
| `load-order.test.mjs` | The import map covers exactly the module graph; every import resolves; nothing is orphaned; one build number everywhere; headless modules stay headless. |
| `citygen.test.mjs` | The city builds, is deterministic per seed, differs across seeds, is instanced, has a workable height distribution, and keeps its buildings inside their blocks. |
| `colliders.test.mjs` | Ray/OBB, sphere clip, roof and ground queries against hand-computed answers — plus a cross-check of the spatial hash against a brute-force scan. |
| `hero-swing.test.mjs` | The traversal model: swinging beats falling, the tether never stretches, speed overshoot decays, a dive builds speed, the hero never leaves the world or ends up inside a wall, and the same inputs replay exactly. |
| `module-size.test.mjs` | Line-count ratchets on the files that only ever grow. |

## 2. Three rules for the browser half

Each is the fix for a measured failure, inherited from the sibling project that
this engine came from.

**Pass `{ polling: 100, timeout: N }` to every `waitForFunction`.** Playwright
polls the predicate on `requestAnimationFrame` by default. A page running the
game loop under SwiftShader starves that poll so badly the declared timeout
never gets to fire — measured there at **109,665 ms against a declared 3,000 ms**,
36× its own bound, dying on the test budget instead. Only a predicate that
*throws* terminates promptly, which is why an absent global fails fast and a
plain `false` does not.

**Stop the render loop before a screenshot.** `park()` and `freeze()` stop
physics; rendering continues every frame. A capture issued against a live loop
queues behind it instead of reading a quiet compositor — measured at 88-96 s
solo versus 29-32 s once quiesced. Present one real frame first, *then*
`headless(true)`, then shoot.

**Call `snapCam()` after any teleport.** The camera rig eases toward its target
exponentially, so `place()`/`park()` leaves it flying toward the hero for a
second or more: empty frames, or the hero out of shot. Waiting longer is not a
fix; the rig only advances inside `render()`.

## 3. What makes a good spec here

**Assert behaviour and geometry, not magnitudes.** "Swinging carries further
than falling" survives every retune of the model. "Travelled more than 400 m"
goes stale the first time the pump constant changes, and a stale test teaches
people to widen thresholds rather than read failures.

**Prove the check is not vacuous.** A determinism test passes trivially against
a frozen hero, so it must also assert the hero moved. A "different seed produces
a different city" test exists precisely because "deterministic" is satisfied by
a constant.

**Never widen a tolerance to make a test pass.** Two of the three defects found
in the first round looked like tolerance problems and were not: the tether
stretched because anchor search range and tether length were different numbers,
and speed exceeded its cap because a rigid constraint was doing work. Both would
have been hidden by a larger epsilon.

**Report which case failed, not that one did.** Sweeps collect offenders and
assert the collection is empty, so the message names the position.

**Verify a geometric claim with the query that actually answers it.** The
"webs terminate on real geometry" spec first verified each anchor with a short
downward ray, and failed: an anchor sitting on a *vertical* face has a downward
ray running tangent to that face, so it misses. Measured — 1 of 5 genuine
anchors detected. It read as a traversal bug for as long as it took to check the
same five points with `nearGeometry()` (a sphere overlap), which found all five.
When a spec fails on something the screenshots say is fine, suspect the
instrument before the subject.

## 4. Adding a spec

1. Import from `tests/helpers/fixtures.js`, not `@playwright/test` — that is
   what attaches the page console, the log ring and the game state on failure.
2. Decide render vs headless. Screenshot and DOM specs go in `RENDER_SPECS` in
   `playwright.config.js`; everything else scales wide in the headless project.
3. Use `LANDSCAPE` and the `{ polling: 100 }` wait.
4. Add an `npm run test:<name>` script so the spec is reachable by name.
5. Drive rollouts inside **one** `page.evaluate` — one round trip per step turns
   a 600-step stint into minutes of IPC.
6. Never let an `evaluate` callback close over a Node-side binding. It fails as
   `ReferenceError: x is not defined` inside the page, which reads like a game
   bug rather than a test bug. (This was hit once already, in a boot script.)
