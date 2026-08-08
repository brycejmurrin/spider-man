<!-- Research pass on the city's visual quality, 2026-08-08. Every number in §0
     comes from running buildCity(42, {night:true}) in bare Node — js/city/ is
     headless by rule, which is what makes that possible. Nothing was rendered;
     the shading predictions are read from the GLSL, not measured on screen. -->

# Making the Web-Slinger city read as Manhattan

Read-only research + design pass over `js/city/*`, `js/render/shaders/lit.js` and
`js/game.js`. Nothing was modified. All measurements below were taken by running
`buildCity(42, {night:true})` in bare Node this session.

---

## 0. Measurements taken this session

```
buildings 983    propVerts 1 676 378    glassVerts 567 696    groundVerts 3 480
props  MAT histogram  { 0: 1 183 876,  1: 61 368,  4: 431 134 }
glass  MAT histogram  { 3: 567 696 }
ground MAT histogram  { 1: 3 456, 16: 24 }
graph  models 3   nodes 85 484   uniqueVerts 204   fusedVerts 2 115 108   reuse 10 368x
byKind windowPane 69 037 | facadeRail 5 350 | facadeMullion 4 259 | facadeNeon 4 419
       buildingMass 1 457 | streetLamp 962
heights  min 10.2   median 24.2   p90 63.9   max 180.8
kinds    slab 131, podium 121, tiered 116, chevron 116, hall 110, setback 101,
         clad 39, screen 38, spire 28, fin 28, twin 26, dome 20, drum 18,
         antenna 16, cross 16, ziggurat 14, arch 14, notch 14, cylinder 9, jenga 8
```

Two numbers reframe the whole problem:

- **MAT 0 (FLAT) is 70.6 % of prop vertices.** `applyMaterial()` returns
  immediately on it (`lit.js:378`), as does `applyMaterialNormal()`
  (`lit.js:328`). Most of the city is explicitly opted out of every procedural
  material the shader implements.
- **Window panes are 1 656 888 of the 2 244 074 world vertices — 74 %.** Panes
  are the memory problem *and* the "oversized panels" problem. Both are fixed by
  the same change.

---

## 1. Ranked diagnosis

### D1 — `emissive: 0.7` on the whole props mesh deletes 70 % of the lighting

`js/game.js:229`

```js
gfx.drawChunked(meshes.props, MAT_IDENT, { emissive: 0.7, detail: 0.25 });
```

`uEmissive` is a **per-draw** uniform (`glx.js:1102, 1114`). For non-car
geometry the shader takes it unconditionally (`lit.js:784`), and then:

```glsl
if (emissive > 0.0) { color = mix(color, albedo, emissive); ... }   // lit.js:1294
```

So for every one of 1.68 M prop vertices — building masses, plinths, facade
rails, mullions, caps, spires, domes, crowns, lamp posts — **70 % of the final
pixel is the raw unlit vertex colour**. Attenuated to 30 %: the moon key, all 28
spot lamps with their cone falloff, the snap-cached static shadow map, SSAO,
hemisphere ambient, the ambient contact darkening (`lit.js:1285`) and the sky-rim
fresnel (`lit.js:1275`).

A cube's six faces differ *only* by their normal being consumed by those terms.
Attenuate them to 30 % and the faces converge in value. That is, precisely,
"buildings read as flat colour blocks" and "boxes with stripes" — the corner
between two faces stops existing, the roofline stops separating from the sky,
and 983 overlapping silhouettes stop resolving in depth.

This single draw-call argument is doing more visual damage than everything in
`js/city/` combined.

### D2 — The window grid is 2–6x real-world size (the literal "oversized panels")

`js/city/buildings.js:54, 58-60`

```js
const rows = lod(Math.max(4, Math.min(10, Math.round(sh / 4.4))), 3);
const cols = simple ? Math.max(2, Math.min(3, Math.round(faceW / 5.4)))
                    : lod(Math.max(2, Math.min(6, Math.round(faceW / 3.3))), 2);
const rowN = simple ? lod(Math.max(2, Math.min(6, Math.round(sh / 6.4))), 2) : rows;
```

Worked through for a typical midtown lot (`citygen.js:87` per = 2 → inner 72,
lot 36, `w = d = 33`, `h ≈ 90`):

| face | cols | rows | pane W x H |
|---|---|---|---|
| street (`drawFace(0,-1,…)`) | min(6, round(33/3.3)=10) = **6** | min(10, round(90/4.4)=20) = **10** | **4.51 m x 6.84 m** |
| sides (`simple`) | min(3, round(33/5.4)=6) = **3** | min(6, round(90/6.4)=14) = **6** | **9.00 m x 12.84 m** |

Reality: a unitized curtain-wall module is ~1.5 m wide and spans one
floor-to-floor, 3.5–4.0 m (ground storey 4.5–5.0 m)
([APRO](https://aprowin.com/unitized-curtain-wall-standard-sizes-guide/)). The
street face is ~3x too wide and ~2x too tall per pane; **a 33 x 90 m side wall
carries 18 rectangles.**

Note the divisors (`/3.3`, `/4.4`) are roughly correct. The `min(…, 6)` and
`min(…, 10)` **caps** are what destroy them, and they exist purely because each
pane costs a 24-vertex instanced box.

`railH = max(0.4, fh * 0.24)` with `fh = 9 m` gives a 2.16 m rail every *other*
row (`buildings.js:71`, `i += 2`) — a horizontal band every 18 m. Those are the
stripes.

### D3 — Only 3 MAT ids reach the props buffer, and the dominant one is FLAT

Measured above. Consequences:

- MAT 0 = 70.6 % of prop vertices gets no tint variation, no bump, no roughness
  modulation, ever, at any distance. This is where all side-face panes and all
  *lit* street-face panes land (`buildings.js:101`: `if (toGlass) glassBuf._mat =
  MAT.GLASS; else out._mat = 0;`).
- **MAT.BRICK is unreachable at night** — `buildings.js:190`:
  `const bmat = NIGHT ? MAT.CONCRETE : (…)`. The hist confirms zero MAT 2.
- MAT.STONE (13), MAT.ROOF (12), MAT.RUST (14), MAT.WOOD (5) are **never emitted
  anywhere in the city**, yet each has a full coursing/bump/tint implementation
  already written and shipped in `lit.js:226-271` and `lit.js:430-485`. Free,
  tested detail sitting unused.
- Distance fades: `far = clamp(1 - (vd-90)/170)` (`lit.js:379`) kills *all*
  material detail beyond **260 m**; `near = clamp(1 - (vd-26)/64)` kills fine
  detail beyond **90 m**. At 40+ m/s and a 1.25 km city, most of the frame is
  beyond both.

### D4 — Every building's back face is bare

`js/city/buildings.js:132-134`

```js
drawFace(0, -1, sw / 2, 2, sd, 0, false);   // street-facing: full detail
drawFace(2,  1, sd / 2, 0, sw, 137, true);  // +t side: simple
drawFace(2, -1, sd / 2, 0, sw, 311, true);  // -t side: simple
```

There is no `drawFace(0, +1, …)`. **One in four vertical faces of all 1 457
building sections is an untouched coloured box.** `citygen.js:96-99` derives the
lot yaw from its grid index, so on any 2x2 or 3x3 block the back faces point at
each other across the alleys the player flies through.

### D5 — The roofline is a 1 m slab, and there is no rooftop clutter

Every massing kind terminates in the same primitive —
`buildings.js:209, 214, 217, 223, 228, 260, 277, 285, 288, 302, 307, 311`:

```js
Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.5..0.92, 1.0, d * …], cap, b);
```

A 1 m box in `cap = [0.09, 0.09, 0.12]`. Against the sky that is a stripe on a
box. No parapets, no cornices, no water tanks, no HVAC, no stair bulkheads, no
aerial forests. In a game played *above the rooftops* the roofline is the most
looked-at surface in the world and it carries one primitive.

Wooden rooftop water tanks are the single most recognisable NYC rooftop
signature — mandated in practice by the fire code for any building over six
storeys, and on essentially every pre-war roof
([Untapped New York](https://www.untappedcities.com/new-york-city-water-towers-how-they-work/)).

### D6 — Three night colours for 983 buildings; one plinth colour for the city

`buildings.js:182-185`:

```js
const base = NIGHT ? (tone && tone.n || [0.14,0.14,0.17]) : (tone && tone.d || …);
const jv = 0.86 + hash(seed * 8.7) * 0.30;   // value  ±15 %
const jh = (hash(seed * 5.9) - 0.5) * 0.10;  // warm/cool ±0.05
```

`tone.n` is a single literal per district (`city-data.js:63, 81`; `commercial`
has `tone: null` so it falls to the generator default). So the whole city is
**three hues at ±15 % value**. Meanwhile `DC` (`city-data.js:20-30`) holds 24
authored building colours — cream, sand, terra, brick, ochre, greyblue, slate,
bronze, copper — that are used **only in day mode** (`buildings.js:351`).

`buildings.js:357`: `const body = NIGHT ? [0.26, 0.24, 0.30] : tone.d;` — one
hardcoded plinth colour for every ground floor in the city. Below 3.2 m there
are no shopfronts, no awnings, no lit vitrines, no doors, no signage.

### D7 — Occupancy is banded, but the banding parameters are city-wide constants

`buildings.js:53, 85-88`:

```js
const litShare = 0.20 + neonAmt * 0.08, neonShare = neonAmt * 0.7;
const floorLit = hash(seed * 2.9 + ri * 3.7) < 0.55;
```

`0.55` and `litShare` are the same for every building. Shamus Young hit exactly
this and named the fix: *"all buildings had the same percentage of lit windows,
which made the view even more monotonous… It randomly decides at the outset how
big the interior spaces are, and what percent of the windows should be lit."*
([Pixel City, Part 5](https://www.shamusyoung.com/twentysidedtale/?p=3059))

Also `coreCol` (`buildings.js:82`) is recomputed inside `drawFace` with the
per-face `sOff`, so the "stair/lift core" lands in a *different column on every
face of the same building*. It is not a core; it is a per-face stripe.

### D8 — No LOD, and the instancing graph's win is computed then discarded

`buildings.js:33`: `const lod = ctx.lod || ((n) => n)` — and `citygen.js:57-60`
never passes `lod`. **Every `lod()` call in the file is the identity function.**
Full facade detail is emitted for a building 1.2 km away.

`graph.batches()` is never called. `game.js:56-60` uploads `city.out` as one
fused chunked mesh. The graph itself reports `uniqueVerts 204, fusedVerts
2 115 108, reuse 10 368x` — the entire instancing win is measured and thrown
away. GLX already has `drawInstanced` (`glx.js:1248`), the divisor plumbing
(`glx.js:1149, 1159`) and attribute slots 5–9 (`lit.js:26-30`), and
`graph.batches()` already emits exactly the `{geo, matrices, colors}` shape it
wants.

### D9 — Massing silhouettes vary; massing *proportions* do not

The kind histogram is healthy (20 kinds well spread). But `citygen.js:103` gives
every lot in a block `w = d = lot - 3` — square, identical footprints — and
`citygen.js:104` draws height from one uniform per district independent of lot
area. The setback fractions are fixed literals (`[0.46, 0.32, 0.22]` for
`tiered`, `*= 0.82` for `ziggurat`, `h * 0.84` for `setback`).

Real NYC: the 1916 Zoning Resolution required a setback along a **diagonal
springing from the centre of the street** — so setback depth is a function of
street width — plus a tower of unlimited height over **≤ 25 % of the lot**. That
produces the bulky base + slender shaft "wedding cake"
([The Skyscraper Museum](https://skyscraper.org/skyline/impact-of-1916-zoning/),
[On Verticality](https://www.onverticality.com/blog/nyc-zoning-envelopes)). The
same source gives a proportion worth stealing: **no workspace deeper than 28 ft
(8.5 m) from window to core** — which is why pre-war Manhattan towers are thin
slabs and light-court "H"/"E" plans, not the 33 x 33 m cubes here.

Nothing in `citygen.js` can produce a narrow party-wall street parcel either (a
brownstone is ~6 m wide x 15 m deep), so the low-rise rim is a 3x3 grid of
near-cubes instead of a row of houses.

---

## 2. What the research says (short form, with the citations that matter)

- **Interior mapping is cheap and it is exactly the target look.** The Spider-Man
  windows are ray-plane intersections in the fragment shader with no geometry.
  Only 3 of a room's 6 planes need testing (you know which way you're looking).
  ([Joost van Dongen](http://joostdevblog.blogspot.com/2018/09/interior-mapping-real-rooms-without.html),
  [Alisavakis](https://halisavakis.com/my-take-on-shaders-interior-mapping/)) —
  and a cubemap is optional: hash the room cell for wall/ceiling colours instead.
- **Windows can be lit entirely in the fragment shader from world position.**
  3DWorld: *"Texture coordinates are generated by scaling the building {x,y,z}
  vertex positions in world space… The integer components give us the world-space
  index of the window… hashed to produce a lit-window density between 10 % and
  50 %."* This is a UV-free recipe and this renderer already computes exactly
  that coordinate in `matTexUV()` (`lit.js:287-295`).
  ([3DWorld](http://3dworldgen.blogspot.com/2018/04/building-window-generation.html))
- **Leave blank facade.** Young's second-biggest fix: *"Every building was all
  windows, edge-to-edge, top-to-bottom… These new buildings are very rarely
  covered in windows. They have vertical stripes or windowless areas running down
  the face… the vertical blank areas seem very subtle, but it's shocking how the
  eye can instantly spot the break in the pattern."*
  Also *"I put larger gaps between buildings, which gives their silhouettes more
  opportunities to stand out."* ([Part 5](https://www.shamusyoung.com/twentysidedtale/?p=3059))
- **Windows are never truly black, and lit windows are never uniform.** *"even in
  windows where the lights are off, there's often a little bit of light coming
  from other nearby interior rooms. So few windows are truly black."* Plus warm
  colour noise: *"I try adding some random color noise and all of a sudden the
  windows pop to life."* The current `dark = [0.035, 0.035, 0.055]`
  (`buildings.js:45`) is that true black.
  ([Part 2](https://www.shamusyoung.com/twentysidedtale/?p=2954))
- **Keep the *colour* variation small.** 3DWorld: *"Each building has a single
  window light color… bright yellow to light blue. Too much color variation looks
  unnatural."* `WINTINTS` (`city-data.js:39-43`) is already the right idea; the
  per-pane hue jitter at `buildings.js:92` (±0.07 on R and B in opposite
  directions) is the right magnitude.
- **Silhouette is the LOD contract.** Cities: Skylines II's asset rules: *"The
  silhouette should be taken into account when considering detail — most details
  under 5 cm depth do not change the silhouette"*, and the far LOD *"should just
  factor in the basic silhouette"* — but the window sub-mesh is explicitly
  exempted: *"it is acceptable to use a LOD2_Win sub mesh that is virtually the
  same as the main window sub mesh, as this allows you to have night time
  lighting on windows on the LOD2 zoom level."*
  ([CS2 wiki](https://cs2.paradoxwikis.com/index.php?title=Asset_Pipeline:_Buildings))
  **That is the answer to "what survives at distance": silhouette + window
  luminance. Mullions, spandrels, bump, rooftop clutter and shopfronts do not.**
- **Scale sanity check.** Insomniac shipped 6 km x 3 km, 9 districts, >8 300
  buildings from >3 250 edifice prefabs — ~2.5 buildings per unique prefab.
  ([GDC 2019, Santiago](https://media.gdcvault.com/gdc2019/presentations/santiago_david_procedurally_crafting_manhattan.pdf))
  This project has 983 buildings from 20 kinds; the shortfall is not in the
  number of silhouettes, it is in facade and roofline vocabulary.
- **Facade proportions to target.** Floor-to-floor 3.5–4.0 m (ground 4.5–5.0);
  curtain-wall module ~1.5 m wide, one floor tall; 28 ft (8.5 m) max window-to-core
  depth.

---

## 3. The plan, ordered by (visual payoff) / (implementation cost)

Constraints honoured throughout: `js/city/*` stays headless (no DOM, no
`document`, no renderer imports); `hash(seed)` only, no `Math.random`;
`buildings.js` is 393/420 lines — anything larger than a few lines needs a new
module and the full new-file checklist (`tools/manifest.cjs` MODULES, import-map
entry **and** modulepreload in `index.html`, layout entry in `CLAUDE.md`,
`?v=N` + `version.json` bump).

### P1 — Stop flattening the light  **[do this first; see §4]**

**Files:** `js/game.js:229`, `js/city/buildings.js:97-107`, `js/city/citygen.js:50-60`
**Vertices:** **0** (geometry is *moved* between buffers, not added)
**Size:** ~15 lines across three files, no new module

1. Split the props accumulator three ways, exactly as `glassBuf` is already
   split. `neonFacade` already branches on `toGlass ? glassBuf : out`
   (`buildings.js:106`) — make it a three-way into a new `emitBuf` for the things
   that genuinely are light sources: lit panes, the `facadeNeon` rails
   (`buildings.js:118-129`), the crown neon band (`buildings.js:374`), the
   aircraft beacons (`buildings.js:378`), the spire/dome/cylinder lit rings, and
   the lamp head box (`citygen.js:130`).
2. `citygen.js` returns `emitBuf`; `game.js` uploads one more chunked mesh.
3. `drawWorld()`:
   - `meshes.props` → `{ emissive: 0.06, detail: 0.25 }` (a black-floor lift, not
     a flattening)
   - `meshes.emissive` → `{ emissive: 1.0 }`
4. **Pair with a night re-tune, or the city goes black.** Today midtown reads at
   `0.7 * bodyCol ≈ 0.084`, which is *brighter* than the ambient-lit result
   (`frame.ambientSky = 0.034`). Recover the energy the physically right way:
   raise `frame.ambientGround` (`game.js:94`) from `[0.016, 0.015, 0.022]` toward
   a sodium tint (~`[0.030, 0.022, 0.014]`). A night city is lit from *below* by
   its own street glow; that up-light is what makes a vertical face read, and it
   is the cue the current flat emissive is faking badly.

Payoff: the entire city gets its shading, shadow, SSAO, contact darkening and
sky-rim back in one edit. Every box gets its form; every corner gets its edge;
the roofline separates from the sky.

### P2 — Facade as an analytic shader grid, not 69 037 boxes

**Files:** `js/render/shaders/lit.js` (`applyMaterial`), `js/city/geom.js`
(one new MAT id), `js/city/buildings.js` (`neonFacade` shrinks dramatically)
**Vertices:** **−1.65 M (−74 %)** — the single biggest memory win available
**Size:** ~50 lines of GLSL, ~30 lines removed from `buildings.js`

`lit.js:413-425` **already implements a curtain-wall mullion grid** for
MAT.GLASS, keyed off world `(hc, y)`, at `pw = 1.6, ph = 1.4, mull = 0.11` —
near-correct real-world proportions, `fwidth`-antialiased, no UVs, no vertices.
The city never uses it as a facade: it stamps it onto individual 4.5 m panes, so
the grid tiles *inside* each panel instead of *being* the panels.

Proposal — add `MAT.FACADE = 17` (the table tops out at `ASPHALT: 16`, so 17 is
free and nothing in the ported Apex 26 path is disturbed) and emit the facade as
**one box per face** instead of a pane grid:

```
ph = 3.8 m (floor-to-floor)          pw = 1.7 m (bay)
cell = (floor(hc/pw), floor(y/ph))   // 3DWorld's world-space window index
mullion / spandrel / reveal from fract(), fwidth-AA'd (copy the mid==3 branch)
lit  = hash(cell, buildingSeed) < litDensity(buildingSeed)
tint = WINTINTS[hash(buildingSeed)] * (0.65 + 0.5*hash(cell)) with ±0.07 R/B jitter
```

Per-building parameters (seed, floor height, lit density, blank-bay mask) ride
in the **free `aTrk` vec3 attribute** — `lit.js:18`, location 4, documented as
"road only… (0,0,0) elsewhere". No new attribute, no new VBO channel, no change
to `createMesh`.

Two rules from the research, both cheap here:

- **Blank bays.** Reserve 1–2 vertical bays per face as solid wall
  (`hash(bayIndex, seed) < 0.18`). Young's "shocking how the eye can instantly
  spot the break in the pattern".
- **Dark ≠ black.** Unlit panes get `0.10-0.16 * tint` (spill from adjacent
  rooms), not `[0.035, 0.035, 0.055]`.

**Distance fade is a separate decision from `far`/`near`.** Window *luminance*
must survive to the far plane (2000 m) or the skyline goes black — CS2 makes
exactly this exemption for its window sub-mesh. Only mullion depth, spandrel
shading and bump should fade, on the existing `near` ramp.

This fixes D2 (panels become 1.7 x 3.8 m — ~8x more apparent windows), D3 (the
facade is no longer MAT 0), D4 (a fourth `drawFace` is now free: it is one box),
and 74 % of the vertex budget simultaneously.

### P3 — Interior mapping behind the lit windows

**Files:** `js/render/shaders/lit.js` only
**Vertices:** **0**  |  **Cost:** ~25 lines GLSL, ~20 ALU on lit-window fragments
**Depends on:** P2 (needs its cell coordinate)

The signature Spider-Man look, and it needs neither UVs nor a cubemap here.
`vWorldPos`, `vNrm` and `uEye` are all in scope, which is enough to build the
view ray; the room is a box of `(pw, ph, ~6 m)` and only **3 of its 6 planes**
need intersecting. Colour the hit plane procedurally from the room cell hash —
back wall, side wall, ceiling, plus a ceiling-light term — instead of sampling a
texture. Gate on `mid == FACADE && lit && vDist < ~150 m` so it costs nothing on
the skyline.

Do this *after* P2 and *after* P1: parallax depth is a shading effect and it is
invisible through `mix(color, albedo, 0.7)`.

### P4 — Rooftops

**Files:** new `js/city/rooftops.js` (full new-file checklist), called from
`buildings.js:building()`
**Vertices:** ~+170 k fused (+10 %), or **~600 uploaded** under P6
**Size:** ~120 lines in a new module

One `roof(lot, kind, seed)` emitter, everything through `graph.instance` so it
becomes 5 more models at ~600x reuse:

- **Parapet** — 4 thin boxes forming a rim, 0.9 m tall, 0.25 m proud of the mass.
  Replaces the 1 m `cap` slab everywhere. This alone rewrites the skyline.
- **Water tank** — cylinder + cone lid on a 4-leg frame, **MAT.WOOD** (a fully
  implemented shader material this city has never emitted). ~90 verts. Place on
  lowrise/commercial with p ≈ 0.55.
- HVAC block (2 boxes, MAT.RUST — also never emitted), stair bulkhead (1 box),
  aerial mast (1 cyl), rooftop billboard (1 box, HDR albedo → free bloom).

LOD: drop all clutter beyond ~400 m (sub-pixel), keep the parapet — it is
silhouette.

### P5 — Ground floor

**Files:** `js/city/buildings.js:355-363` (replaces the plinth), or into
`rooftops.js` renamed to `dressing.js`
**Vertices:** ~+118 k fused (+7 %), **~600 uploaded** under P6

Raise the ground storey to a real 4.5–5.0 m, colour it per-lot from the `DC`
palette instead of the one hardcoded `[0.26, 0.24, 0.30]`, and give the street
face 1–3 shopfront bays: recessed dark box + warm HDR emissive sign box + awning
prism. High payoff — this is the only place a warm lit colour meets the asphalt,
so it also fixes the "the streets are black" read, and it is what the player sees
at the bottom of every swing arc.

### P6 — Actually call `graph.batches()` and `drawInstanced`

**Files:** `js/game.js` (`loadCity`, `drawWorld`)
**Vertices uploaded:** 2.1 M → **~204 + 85 k matrices**
**Size:** ~30 lines

Everything is already built: `graph.batches()` emits `{geo, matrices, colors}`
column-major (`graph.js:286-326`), GLX has `drawInstanced` (`glx.js:1248`),
divisors (`glx.js:1149, 1159`) and slots 5–9 (`lit.js:26-30`).

Measured caveat: `batches()` routes non-`full` nodes and radial-under-nonuniform-
scale nodes to `bakeOnly`. All 3 city models are boxes and the city replays
through the **raw** Geom emitters, which return `undefined` and therefore always
count as landed (`graph.js:222`), so `full` is universally true — the whole
85 484 should batch. Worth asserting in `tests/unit/`.

Trade-off to measure before committing: an instanced draw bypasses
`createChunkedMesh`'s per-cell frustum culling, so this buys memory at the cost
of cull granularity. Under P2 the pane batches mostly vanish anyway, so P6's
value drops sharply once P2 lands — **sequence P2 before deciding on P6.**

### P7 — Colour and occupancy variance (all zero-cost, all in `buildings.js`)

Fits inside the 27 lines of headroom under the 420 ceiling.

- `buildings.js:182` — use the `DC` palette at night too, darkened toward the
  district tone: `bodyCol = mix(DC[pick], tone.n, 0.72)`. 3 night hues → 24.
- `buildings.js:85` — derive per-building occupancy from the seed, per Young:
  `litP = 0.15 + hash(seed*13.7)*0.45` and an office run-length
  `runCols = 1 + floor(hash(seed*11.3)*3)`.
- `buildings.js:82` — hoist `coreCol` out of `drawFace` so the lift core is the
  same column in *plan* on all faces. It is one shaft, not three stripes.
- `buildings.js:190` — pick `bmat` by district at night (lowrise → BRICK,
  commercial → STONE, midtown → CONCRETE). Unlocks two complete shader materials
  for free.
- `buildings.js:45` — `dark` becomes `0.10-0.16 * wbase`, not near-black.

### P8 — Massing proportions from the zoning envelope

**Files:** `js/city/citygen.js:87-105`, `js/city/buildings.js` setback kinds
**Vertices:** 0 (same primitive count, different sizes)

- Vary lot aspect: narrow party-wall parcels in `lowrise` (w 6–10 m, d 18–24 m,
  no side gap), wide slabs in midtown with a max plan depth of ~17 m (2 x the 8.5 m
  window-to-core rule) — which turns cubes into slabs and light-court plans.
- Correlate `h` with lot area rather than drawing it independently.
- Zoning-derived setback: first setback at ~1.5x street width (≈36 m here), step
  in ~25 % of remaining plan every ~20 m, final tower on ≤25 % of the lot rising
  free. That *is* the Empire State / Chrysler profile.

**Flag a correctness issue found while reading:** `buildings.js:383-389` registers
**one OBB per building**, using the *base* `w`/`d` for the full height `y1`. Every
tiered/setback/ziggurat/twin/notch/arch tower therefore lies to the collider,
anchor-picking and rooftop systems about its shape — a wedding cake is registered
as its own bounding slab. Widening the setbacks in P8 makes that lie bigger.
`register` should be called per **section**, from `sec()`.

### P9 — Wire the dead `lod()` hook

`buildings.js:33` + `citygen.js:57`. Mostly moot after P2 (the facade becomes a
shader effect with its own fade); the remaining calls are rooftop clutter (drop
> 400 m) and shopfronts (drop > 250 m).

---

## 4. The single highest-impact change

**Take `emissive: 0.7` off the props mesh — `js/game.js:229` — and give the
things that genuinely glow their own buffer at `emissive: 1.0`.**

The argument, against the obvious rival (P2, the shader facade, which is the
more impressive change):

1. **It currently overrides everything else in the pipeline.** The renderer
   computes a full PBR result — moon key, 28 spot lamps with cone falloff, a
   snap-cached static shadow map, SSAO, contact darkening, hemisphere ambient,
   sky-rim fresnel — and then one line, `lit.js:1294`, discards 70 % of it for
   every prop vertex in the city. No amount of facade detail can read as
   three-dimensional through that. Adding mullions under `mix(color, albedo, 0.7)`
   adds *more flat colour blocks*, just smaller ones.

2. **It is precisely what makes a box read as a box.** The only thing
   distinguishing the two visible faces of a corner is the normal, consumed by
   NoL and the ambient hemisphere — both attenuated to 30 %. Restoring them
   restores the corner, the roofline against the sky, and the depth ordering of
   983 overlapping silhouettes. "Reads as boxes with stripes" is answered at its
   source, not decorated over.

3. **It is a precondition for everything else on this list.** P2's mullions,
   P3's parallax rooms, P4's parapets and P5's awnings are geometry and albedo
   changes whose entire payoff is delivered *by shading*. Doing them first spends
   vertices and shader cycles to buy detail that the emissive term then erases.

4. **It is the cheapest item here.** One draw-call argument, plus a
   pane/neon/beacon split into a second buffer that moves ~1.09 M vertices
   between accumulators and adds **zero**, plus a night re-tune of
   `frame.ambientGround` toward a sodium up-light — which is also the physically
   correct night-city cue and the thing that will keep the frame from going black.

**Do second: P2.** It converts the "oversized panels" defect and the 1.68 M-vertex
memory problem into one fix — the facade grid stops being 69 037 boxes at
4.5 x 6.8 m and becomes an analytic 1.7 x 3.8 m grid inside `applyMaterial`, at
one-eighth the apparent panel size and **−1.65 M vertices**. Everything after
that (P3 interiors, P4 rooftops, P5 shopfronts) is spending a budget those two
changes have already freed.

---

## 5. Vertex budget across the plan

| stage | props | glass | emissive | total | Δ |
|---|---|---|---|---|---|
| today | 1 676 378 | 567 696 | — | 2 244 074 | — |
| after P1 (split only) | ~587 000 | 567 696 | ~1 089 000 | 2 244 074 | 0 |
| after P2 (shader facade) | ~360 000 | ~120 000 | ~110 000 | **~590 000** | **−74 %** |
| + P4 rooftops | +170 000 | | | ~760 000 | −66 % |
| + P5 ground floors | +118 000 | | | **~878 000** | **−61 %** |

Every added system is paid for several times over by P2, and under P6 the
*uploaded* figure for all of it is a few thousand vertices plus instance
matrices.

---

## 6. Testing notes for whoever implements this

- `npm run test:tooling-fast` after every edit; it builds the whole city in bare
  Node and will catch determinism and module-graph breakage in ~10 s.
- Determinism: every new parameter must derive from `hash(seed …)`. The
  `citygen.test.mjs` byte-for-byte assertion is the guard.
- `tests/unit/module-size.test.mjs:31` caps `buildings.js` at 420 (it is at 393).
  P4 and P5 must land in a new module and take the full new-file checklist.
- Any `waitForFunction` added to a browser spec needs `{ polling: 100, timeout: N }`.
- Screenshots: present a frame, `headless(true)`, `snapCam()`, then shoot.
- Bump every `?v=` in `index.html` **and** `version.json` as the last edit.
