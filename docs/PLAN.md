# Web-Slinger — the plan

What this is, what shipped, and what comes next. Written to be executable: every
phase names files, and the tunable numbers come with the measurement or the
source that produced them.

---

## 1. Why this exists, and the bet it makes

The sibling project `../f1-game` ("Apex 26") contains a hand-written WebGL2
renderer that is genuinely good and almost entirely un-racing-specific: an HDR
pipeline with mip-chain bloom, SSAO, screen-space reflections, ACES tonemapping
and colour grading, volumetric god rays, a 32-light forward point/spot system
with lamp-fog, a procedural sky with a night city-glow dome, snap-cached shadow
maps, GPU instancing, and a baked PBR material system keyed by a per-vertex
material id rather than UVs. Alongside it sits a procedural **city generator**:
~18 building silhouettes, inset curtain-wall facades with HDR-lit windows, and
tuned neon and daylight palettes, built to dress night street circuits.

That is most of a Spider-Man game's renderer, already written and shipped.

The bet: **port the engine, replace the world model and write the gameplay.**
Three exploration passes over the source project established that roughly 4,000
of its 7,200 renderer lines carry no racing knowledge at all, that the city
massing library transfers if its placement layer is replaced, and that what a
swinging game needs and a racing game does not — 3D collision, rooftop data, a
character controller — is all additive.

### The one architectural departure

Apex 26 loads ~150 classic scripts in a hand-maintained order, with a manifest
file and a test asserting the two agree. That machinery exists **only** because
IIFE globals have no dependency information. This repo uses **native ES
modules**, so the browser resolves order from the import graph and the whole
class of "wrong order" bug disappears. What a build step would otherwise give
us — cache busting — is done with an **import map** that remaps every module to
itself with `?v=N` (import-map keys resolve as URLs, so a relative import inside
a module is remapped too). `tests/unit/load-order.test.mjs` asserts the map
covers exactly the module graph, that every import resolves, and that nothing is
orphaned. It is a strictly stronger guarantee than the original, in less code.

---

## 2. What shipped in this round

A playable prototype: a procedural neon city you swing through.

**World.** `js/city/citygen.js` builds a 12×12-block Manhattan grid — 80 m
blocks, 24 m streets, ~1.25 km square — with three radial districts (midtown
towers / commercial mid-rise / low-rise rim). Blocks subdivide into lots, each
lot gets one building from the ported massing library, and every building
registers an oriented bounding box. Measured on seed 42: **983 buildings**,
median height 24 m, p90 64 m, tallest 181 m; 962 street lamps; 1.47 M prop
vertices and 772 k reflective-glass vertices; **85,484 instanced nodes from 3
models** (≈10,000× reuse). It builds in about two seconds, in bare Node.

**Gameplay city.** `js/city/colliders.js` persists what the source project
computed and discarded: per-building OBBs in a spatial hash, with `raycast`
(web anchors, camera line-of-sight), `sphereClip` (capsule collide-and-slide),
`roofAt` and `groundY`. Cross-checked against a brute-force scan over 200 rays.

**Traversal.** `js/game/hero.js` is a world-space capsule with a
`GROUND | AIR | SWING | WALLRUN` state machine. The swing is the Fristrom
constraint method — integrate under gravity and air steer, clamp the position to
the tether sphere, re-derive velocity from positions — plus a pump, a
ground-clearance auto-shorten, an apex auto-release, a stall guard and a
never-stranded anchor assist.

**The cruise numbers this paragraph used to claim — 42 m/s and 2.5 km/min — are
wrong.** Re-measured in bare Node over a 60 s held swing: **27.2 m/s median
(p90 73.1) and 1.83 km/min**, with a median 0.95 s between attaches. And a
single figure is misleading anyway, because the same physics produces three
different games depending on where you start:

| district | share of buildings | attached | swings/min | distance |
|---|---|---|---|---|
| midtown (r<0.45) | 9% | 25% | 24 | **3.56 km/min** |
| commercial | 31% | 57% | 34 | 2.43 km/min |
| low-rise | **60%** | 89% | **137** | **0.25 km/min** |

Low-rise is a swing every 0.44 s at 13 m — hopping that covers no ground.
Midtown is long ballistic arcs between rare anchors, and is roughly twice the
reference game's community-measured pace. Neither is a continuous rhythmic arc,
and the majority of the map produces the worse one. **The root cause is anchor
availability, not the constraint** — it dies by ~80 m even in midtown and by
25 m across the low-rise majority — so the primary lever is the city, and
`ASSIST_Y` is currently not a safety net but the *primary anchor source* over
most of the map.

**Renderer.** Ported near-verbatim and converted to modules by script. The
driver (`js/game.js`) is ~430 lines: fixed 1/60 loop with render interpolation
and a 5-substep cap, frame assembly, a snap-cached sun shadow plus a per-frame
dynamic map for the hero, and the draw path.

**Hero.** `js/hero/hero3d.js` builds ten rigid segments posed procedurally per
state — the renderer has no skinning, and the source project's articulated
sub-mesh pattern (wheels and aero flaps as separate meshes with their own
transforms) *is* a skeleton if you use it as one.

**Tests.** 50 unit assertions with no browser (module graph, city determinism
and shape, collider geometry, swing characterization, size ratchets) plus three
Playwright specs.

### Three defects the tests and measurements caught

- **The tether stretched.** Anchors were accepted out to the 55 m search-ray
  length but clamped to a 45 m tether, so the constraint yanked the hero inward
  on the attach frame. Caught by an invariant test, not by looking.
- **The constraint was adding energy.** Re-deriving velocity from a clamped
  position counts the clamp's own displacement as motion, so reeling the tether
  in pumped the swing: **146 m/s against a 52 m/s cap**. A rigid constraint does
  no work — the velocity is now rescaled to its pre-clamp magnitude.
- **The camera protected the wrong point.** Its occlusion clamp raycast from the
  look-at target, which leads the hero by 6-8 m, so in a canyon the ray began on
  the far side of the wall the hero was passing and the eye ended up inside a
  facade. It now protects the line of sight to the subject.

### Two visual findings from research, applied

- Every lit window in the city was one of two colours: a `WINTINTS` palette
  existed and was imported but never used, while the facade code hardcoded a
  single warm tint. Wiring it, plus per-pane jitter, is most of the difference
  between the first screenshot and the current one.
- Window occupancy was per-pane white noise. Real towers show whole lit floors
  and vertical lit runs where the stair and lift core is. Structured occupancy
  is the single strongest cue that a building is a building.

---

## 3. Phase 2 — traversal depth and feel

Ordered. The first three are the difference between a swing system and a button
that moves you.

**2.1 Finish the feel pass.** Auto-straightening is implemented but weak with no
directional input (measured drift: 444 m over 60 s of pure held-swing). Retune
the side-alternation weight and re-measure. Target from the checklist: ten
consecutive swings with no stick input drift under 15° from the initial heading.

**2.2 Release timing must beat holding.** The reward curve is in
(`RELEASE_*` in `hero-consts.js`) and the apex auto-release is deliberately set
past its peak so a manual release wins. This is untested as a *player-facing*
claim: build the 500 m course and assert a peak-timed release beats a held run
by ≥20%. Until that test exists, the skill ceiling is a hypothesis.

**2.3 Tether line-of-sight: break / wrap / pass-through.** Raycast the tether
each frame. Blocker within 6 m of the hero → the web breaks; between 6 and
20 m → re-pivot at the hit and shorten; beyond → ignore. This is the shipped
rule from Spider-Man 2 (2004) and it is also what makes weblines stop clipping
through geometry.

**2.4 Zip-to-point and point launch.** Highlight perch points within 70 m; zip
at ~48 m/s; a jump within 250 ms of arrival launches forward. The fastest line
in the reference game, and the main mastery move after release timing.

**2.5 Charge jump; quick-recovery roll; wall corner wrap; vertical wall jump.**
`CHARGE_JUMP_V` is already reserved.

**2.6 Air tricks.** Only available with ≥0.35 s of clearance, so they are a risk
purchase rather than free points. Feeds the Focus economy in Phase 3.

**2.7 Speed-linked camera.** FOV 62→86 over 12→50 m/s with an asymmetric
response (fast in, slow out), pullback, and roll into the swing plane. The
largest perceived-speed lever available and it costs nothing.

**2.8 Input buffering (~140 ms) and coyote time (~110 ms).** Browser input
latency is worse than console; it needs more forgiveness, not less.

**2.9 Touch controls.** Left virtual stick plus three large right-side buttons.

---

## 4. Phase 3 — combat

The loop, in implementable terms. Frame timings are proposals, not measurements
— no public frame data exists for the reference game; the *rules* below are
sourced from design analyses.

- **Every standard animation cancels into dodge.** Not most — every one.
- **A combo ends on taking a hit or on a timeout with no landed hits. A whiff
  does not break it.**
- **Spider-sense is two-stage**: a telegraph at roughly T−0.55 s, then a
  distinct pulse for the last ~0.2 s that is the perfect-dodge window. Perfect
  dodge grants brief immunity, slows time and pays bonus Focus.
- **Air combat pays more Focus than ground combat** — that gradient is the skill
  expression. Focus spends on heal or finisher.
- Four enemy archetypes cover all four verbs: grunt (combo), gunman
  (prioritise), brute (reposition — dodge *under*), shield (flank). Everything
  else is variation.
- Gadgets bind to direct keys. A radial wheel that slows but does not stop time
  was the most-criticised part of the reference game's combat.

---

## 5. Phase 4 — the open world

The reference game's own strongest lesson is a negative one: its side content is
enormous and repetitive, and the one collectible players never tired of was the
one whose collection *was just more swinging*.

- **3-4 districts** with distinct height profiles, so the swing rhythm changes:
  short tethers and fast cadence in the low-rise, dive slingshots among towers.
- **One collectible type**, ~10 per district. ~~Each placed where reaching it
  *requires* a traversal move.~~ **CORRECTED** — the sourced evidence is that
  the beloved collectible was beloved for being *easy* (IGN: "the activity
  itself was pretty easy"). **Split the verb**: collectibles are the pleasant
  detour, easy and everywhere; the skill gate goes in a *separate*, optional
  activity type that pays medals. Do not make one thing be both.
- ~~**Crime events**: one within 300 m every 45-75 s, three flavours.~~
  **DEMOTED.** The cadence is roughly right for the reference's early game
  (measured 20-30 s), but its crime system is **its single most-criticised
  feature at volume** — 165 required completions, 46% of all required activity
  instances. With no combat we have no crime verb worth repeating. Chase
  targets, timed target runs and dive tests all rank above it: cheaper, more
  on-thesis, and proven in the same game. The one viable non-combat crime verb
  is a **falling-person intercept**.
- **District completion** unlocks the next spawn point. Skip the tower-climb
  trope; it was the most-criticised structure and it does not earn its cost.
  (Confirmed: Insomniac **deleted surveillance towers entirely** in 2023.)
- **Traversal time trials** — nearly free, since the hero is already
  deterministic and seed-reproducible. **Understated.** Determinism buys
  something Insomniac could not have: **generated par times and a computable
  author medal**, by running a scripted policy through each course at build
  time. That is the mechanism that makes a *procedural* time trial as good as
  an *authored* one, and it is why time trials rank near the top rather than
  the bottom. Pay in medals and cosmetics, **never in movement** — Just Cause 3
  gates traversal mods behind its wingsuit challenges and the consistent
  verdict is grind.
- **Skill trees hold amplifiers, never the moves that make the system fun.**
  **Confirmed against the reference**: only **five of its 34 skills** touch
  traversal, all cost one point, and the two most movement-changing (Quick Zip,
  Point Launch Boost) are bought in the first hour or two. ~90% of its
  traversal is unlocked at minute zero.

The full activity taxonomy, the surfacing research, the token economy and the
per-activity "seedable free / needs new generator data / skip" verdict are in
[`research/MISSIONS.md`](research/MISSIONS.md). The three things the generator
should start persisting, in payoff order: a **roof adjacency graph**, a
**per-building distinctiveness score**, and **ledge/setback surfaces**.

---

## 6. Phase 5 — scale and polish

Cascaded shadow maps (the current snap-cached map is sized for a district, not a
city); chunked or worker-driven generation to grow past 1.25 km²; LOD that drops
facade furniture beyond ~250 m and keeps an emissive speckle — distant buildings
need window *twinkle*, not window *geometry*; weather; day/night cycle
(`buildCity` already takes a `night` flag and the day facade path is ported and
unused).

**Browser-specific constraint, and it is the hardest number here:** a portal
case study reports the same game at 40 MB / 29.5 s median load converting 50% of
visitors to play, and at 6 MB / 3.7 s converting 72%. The no-build,
procedural-world, single-texture-pack architecture is already the right answer —
the job is to protect it, keep the first swing within ten seconds of the click,
and never block it on streaming.

---

## 7. Verification

```sh
npm run test:tooling-fast   # 50 assertions, no browser, ~10 s
npm run test:smoke          # boot, dev API, non-blank frame
npm run test:swing          # headless traversal, determinism, anchors on geometry
npm run test:visual         # camera vantages, light cap, line of sight, GL errors
npx serve -l 3456 .         # then: hold SPACE
```

`tools/_boot.mjs` and `tools/_shot.mjs` (gitignored, underscore-prefixed) drive
a headless Chromium for one-off boot checks and deterministic action shots.

## 8. Sources

Swing physics: Jamie Fristrom (technical director, *Spider-Man 2* 2004), *Swinging
Physics for Player Movement* —
https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

Design analysis: https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis ·
https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17805410/swinging-traversal-point-launch-boost-skill/ ·
https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/

Rendering: https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis ·
GDC 2019 *Spider-Man: A Technical Postmortem* — https://www.youtube.com/watch?v=KDhKyIZd3O8 ·
lamp colour temperatures: https://spectrum.ieee.org/led-streetlights-are-giving-neighborhoods-the-blues

Browser games: https://poki.com/blog/what-makes-high-quality-browser-game
