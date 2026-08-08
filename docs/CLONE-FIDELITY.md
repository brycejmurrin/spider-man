# Clone fidelity — how close to Marvel's Spider-Man this can get

The brief is "as close to a clone as possible". This document is the honest
answer: what the reference games do, what we do, what the gap costs, and — the
half that matters most — **what is not reachable from a browser by one person,
so that nobody spends a month discovering it.**

Every claim marked **[DEV]** is developer-stated (a named person at Insomniac,
a GDC talk, or in-game text). **[PRESS]** is a journalist's observation,
**[COMMUNITY]** is player consensus. Where the sources disagree, that is said
rather than resolved.

The deep references are in `research/`:
[`SPIDER-MAN-PS4.md`](research/SPIDER-MAN-PS4.md) (design/tech),
[`SWING-FEEL.md`](research/SWING-FEEL.md) (the genre),
[`HERO-MODEL-PLAN.md`](research/HERO-MODEL-PLAN.md) (the character),
[`CITY-VISUALS.md`](research/CITY-VISUALS.md) (the world).

---

## 0. The one thing to understand first

A player completed Spider-Man 2 (2023) with the camera motion effectively
static — the "Swing Camera Motion" slider shipped inverted relative to its
tooltip — and reported: **[COMMUNITY]**

> *"it kinda reveals how the sense of speed in the game is mainly an illusion —
> I didn't get any feeling of true speed until my second playthrough."*

Identical physics. No sense of speed. **The camera and the post chain are the
feature; the physics are not.** Every ranking below is weighted by that, and it
is why the cheapest items on the list are also the highest-impact ones.

The corollary is uncomfortable and worth stating: our traversal model is
already close enough that retuning it is *not* where the remaining fidelity
is. Measured in bare Node, midtown runs **3.56 km/min**, roughly twice the
reference's community-measured pace — while the low-rise 60% of the map runs
0.25 km/min. The problem is the distribution, not the constant.

---

## 1. The mechanics gap, ranked by feel-per-effort

| # | mechanic | reference | ours today | effort |
|---|---|---|---|---|
| 1 | **Anchor selection** | tagged points chosen to **preserve momentum** **[DEV]** | raycast fan; **no velocity term at all** | XS |
| 2 | **Zip altitude** | the base zip *loses* height; the **upgrade** is merely neutral **[COMMUNITY]** | `ZIP_UP: 4.5` **gains** height, always — better than the reference's upgrade | XS |
| 3 | **Release windows** | **two**: bottom/parallel → speed, top → height | one window; `RELEASE_MULT_MIN 0.4` *penalises* the top-of-arc release, and `AUTO_RELEASE_PHI 0.62` fires 0.01 rad past the window's end | S |
| 4 | **One "keep moving" button** | R2 = swing / sprint / parkour / wall-run, context-chosen; auto-vaults obstacles | `swing` only attaches webs; ground run is stick-only; no vault | S |
| 5 | **Point launch / zip to point** | *"faster than swinging. Period."* — perch points marked with a small white circle, L2 slows time to aim **[COMMUNITY]** | **absent** | M |
| 6 | **Air tricks** | pay Focus/XP; **cost altitude and lock out swinging** while active | absent | M |
| 7 | **Charge jump** | hold R2+X running *or* standing | `CHARGE_JUMP_V` **declared, referenced nowhere** | S |
| 8 | **Dive** | **automatic** after enough free-fall; the button only enters it *early* | held button applying `DIVE_GRAV_MULT` | S |
| 9 | **Assists as one scalar** | `Swing Steering Assistance` 0-10, default 10; players converge on 4-8 **[COMMUNITY]** | five independent hardcoded constants, nothing drives them | M |
| 10 | **Swing pose by arc phase** | release timing taught by silhouette — "legs come together, right-angle to torso" | **one static pose per state**; identical at arc bottom and apex | S |
| 11 | **Camera** | roll + pitch + FOV as one slider | roll + FOV shipped; **pitch missing**; not exposed | XS |

**If only three ship: #1, #5, #4.** #1 is one term in one function and is
developer-sourced. #5 is the reference's own fastest line and is *easier* for
us than it was for them — see §2. #4 is an input change that makes the whole
move set read as one system rather than four buttons.

### 1.1 The finding that unlocks most of the list

Mike Fitzgerald, Insomniac, in Variety: **[DEV]**

> *"Every piece of architecture in the city is tagged with places webs can
> attach, and as you swing around, **we find the perfect swing points to
> preserve your momentum** and keep you flying towards your destination."*

The 2018 game **does not raycast for anchors.** Ours does, which makes our
`pickAnchor` the *2004* design — Fristrom's, explicitly, and he wrote the
tutorial our constraint method comes from. Two consequences:

1. **An authored attachment-point cloud is what removes our anchor desert.**
   Measured per district: anchors die by ~80 m even at the heart of midtown,
   and by 25 m across the 60% of the map that is low-rise. A *procedural* city
   can seed those points densely and deterministically along every building
   edge and roofline — which is strictly **easier** than Insomniac's authored
   problem, not harder. This is the rare case where being procedural is an
   advantage.
2. **Momentum preservation is the selection criterion**, stated by the
   developer. Our scorer has length-to-ideal, height, aim and side-alternation
   and no velocity term. That absence is the likeliest source of the "air
   brakes" feel: grabbing an anchor that is not roughly perpendicular to travel.

`docs/research/SPIDER-MAN-PS4.md` used to claim the 2018 game "attaches to real
building geometry". It is corrected there; this is the correction.

---

## 2. Where being procedural HELPS

Worth naming, because the instinct is to treat "no authored content" purely as
a deficit:

- **Perch points for point launch are free.** Insomniac marks them with a small
  white circle **[COMMUNITY]** — they are a *discrete, enumerable set*, and our
  generator knows every roofline, setback and ledge it emitted. What is an
  authoring cost for them is a `for` loop for us.
- **Anchor tagging is free**, per §1.1.
- **Fire escapes, water towers and setbacks are generator features**, not art
  assets. The art director names *"yellow taxicabs, fire escapes, water towers,
  distinct neighbourhoods"* as the identity budget **[DEV]** — and fire escapes
  are what produced point launch in the first place.
- **Every seed is a new city.** The reference shipped one map, hand-built.

## 3. Where being procedural HURTS, and cannot be fixed

- **8,300 authored buildings** with real signage, real interiors and real
  landmarks. We have 983 procedural masses. Landmark recognition — the thing
  that makes a real skyline navigable — is authored by definition.
- **Recorded audio.** They shipped **200+ web-shot variants** **[DEV]** because
  the sound is repetitive by nature. We have one synthesised `thwip()`. We can
  randomise 3-4 synthesis parameters per shot, which is the right move and is
  not the same thing.
- **Voice, cutscenes, story.** Out of scope, and no amount of engineering
  substitutes.
- **Baked GI and per-time-of-day probe datasets** over a whole city. This is
  what stopped Insomniac shipping a time-of-day *cycle* on PS4 **[DEV]** —
  their TOD is discrete pre-baked configurations, per Digital Foundry
  **[PRESS]**. If it was too expensive for them, it is too expensive for us,
  and it validates the discrete-preset design already in `research/DAYTIME.md`.

## 4. Not achievable in a browser — do not attempt

Recorded so the same investigation is not repeated:

- **Per-pixel motion blur with a velocity G-buffer.** The reference's blur is
  **radial** anyway **[PRESS]**, and ours is already implemented — see §5.
- **Real-time cloth** on the suit and the webline.
- **A continuous day/night cycle** (see §3).
- **GPU skinning as a shared-program change.** Ten bones fits inside every
  uniform budget the web has, so skinning buys nothing here that a cheaper
  technique does not — and it would add two `vec4` attributes to the one
  interleaved VAO layout carrying 1.47 M city vertices, for one character.
  Details and the spec text in `research/HERO-MODEL-PLAN.md` §2.

---

## 5. The camera, the post chain and the audio — cheapest wins available

Per §0, this is where the perceived fidelity lives.

| # | change | status today | cost |
|---|---|---|---|
| 1 | **Radial speed blur** | **already implemented and switched off.** `shaders/post.js:612-621` is a 4-tap smear along `vUV - 0.5` — zero at centre, growing to the edges, exactly DF's description of the reference. `glx/post.js:715` uploads it every present. `js/game.js:126` sets `speedBlur: 0` | **drive it from `hero.speed`** |
| 2 | **Follow distance ramps with speed** | the reference ramps **two** params, FOV *and* follow distance (developer debug footage, GDC 2019) **[DEV]**; `cameras.js:84-90` ramps FOV only | 3 lines |
| 3 | **Dolly-zoom impulse on attach** | *"every web shoot triggers a bump in FoV"* — a "dolly heartbeat" synced to the swing rhythm **[PRESS]**. We have no per-attach camera event, but `js/game.js:200` already detects that edge for `thwip()`, and the asymmetric FOV damping (fast attack, slow decay) is already the right envelope | small |
| 4 | **Roll into the SWING PLANE** | `cameras.js:174-178` rolls from **lateral velocity** — slip-roll inherited from the racing sibling, near-zero on a straight swing. The reference banks into the tether plane, which `webline` already knows | same cost, correct quantity |
| 5 | **Camera pitch to the pendulum tangent** + hero screen-position offset along the arc | absent; makes the pendulum legible *as* a pendulum | medium |

**Audio: the envelope is driven by ALTITUDE, not speed.** Insomniac's audio
lead: **[DEV]**

> *"The city's intensity is related to **how close a player is to the ground**…
> At the apex moment of intensity, when they almost touch the ground, some
> players catch themselves holding their breath. Then they swing back up…
> **floating weightless in a split second of tranquility**."*

We drive wind from speed alone (`js/game.js:400`). Altitude *is* the pendulum's
phase, so an altitude-driven city/wind envelope turns every swing into a breath
for ~15 lines. Also developer-stated and directly applicable: their first-pass
**heavy impacts made Spider-Man "sound heavy and slow, like a tank"** — the fix
was lighter impacts plus air and cloth transients. Our `land()` is a 150→45 Hz
slide: the tank.

**The HUD is backwards.** Bryan Intihar: *"Since E3, we've turned off the health
bar, gadget and suit power HUD elements **while you are swinging around the
city**."* **[DEV]** The reference *clears the screen* during traversal. Ours
shows km/h, altitude and the state string — racing telemetry inherited from the
sibling project, displayed during the exact activity the reference hides it for.

---

## 6. The city

Full diagnosis and measurements in [`research/CITY-VISUALS.md`](research/CITY-VISUALS.md).
The three that matter here:

1. **`js/game.js:229` passes `{ emissive: 0.7 }` to the props draw.** `uEmissive`
   is per-draw, non-car geometry takes it unconditionally, and the shader does
   `color = mix(color, albedo, emissive)` — so **70% of every building's shading
   is replaced by its raw unlit vertex colour.** Moon key, all 28 lamps, shadow
   map, SSAO, contact darkening and sky-rim, all attenuated to 30%. That *is*
   the "flat colour blocks" complaint, and it is ~15 lines to fix (split the lit
   panes/neon/beacons into a third buffer at `emissive: 1.0`, which the existing
   `glassBuf` split already demonstrates). Must be paired with lifting
   `frame.ambientGround` toward a sodium tint or the frame goes black.
2. **Window panes are 2-6× real size, and are 74% of all world vertices.** For a
   midtown lot the street face caps at 6×10 → panes of 4.51 × 6.84 m; the side
   faces cap at 3×6 → 9.0 × 12.8 m, an 18-rectangle wall. Real curtain wall is
   ~1.5 m wide by one 3.8 m floor. The divisors are right; the `min(…,6)` /
   `min(…,10)` caps are the bug, and they exist only because each pane is a
   24-vertex box. Folding the facade into the fragment shader — the lit shader
   already carries an `fwidth`-AA'd, UV-free curtain-wall mullion grid the city
   never uses as a facade — is **−1.65 M vertices while multiplying apparent
   window count ~8×**. The "oversized panels" defect and the memory problem are
   the same defect.
3. **Manhattan is anisotropic and our grid is square.** The 1811 Commissioners'
   Plan: avenues 30.5 m, cross streets 18.3 m, blocks 80.5 × 180-280 m. Ours is
   square 80 m blocks with uniform 24 m streets — and **the 80 m already matches
   Manhattan's 264 ft short side**, so only the second axis and the two street
   widths are wrong. That is a data change in one file, and it is the single
   biggest "this is Manhattan" change available. It also explains the swing
   geometry: you swing *along* the avenue canyon and *across* the narrow cross
   streets. Separately, `districtOf` is a **radial** gradient — a generic-city
   topology — where Manhattan's districts are **longitudinal bands**.

Found in passing and worth its own line, because it is a correctness bug rather
than an aesthetic one: `buildings.js:383-389` registers **one OBB per building
using the base footprint for the full height**, so every tiered, setback, twin
and arch tower misreports its shape to the collider **and to the anchor
system**. The anchor-desert measurements above were taken against these OBBs,
so this lands before the anchor work, not after.

---

## 7. The character

Full analysis in [`research/HERO-MODEL-PLAN.md`](research/HERO-MODEL-PLAN.md).
The decision, and it is a decision rather than a deferral:

**Keep rigid segments and push them.** Do not port `gltf.js` into the runtime —
it refuses skins by design, and glTF requires `JOINTS_0`/`WEIGHTS_0` on any
skinned primitive, so a rigged `.glb` arrives as **the bind pose merged into one
rigid blob**: a T-posed statue, strictly worse than ten boxes that bend. It also
has no UVs, and this renderer has no UV channel to put them in.

**The single highest-impact change is a `limb()` emitter**: a tapered frustum
stack with a rotation-invariant ball at each pivot, on all eight limb segments.
It is the only change that fixes *both* named defects — the ball occludes the
socket at every joint angle (gaps), the taper removes the box read
(silhouette) — for ~830 triangles and ~80 KB, and it needs a new `Geom.addSphere`
because there is no sphere anywhere in this codebase. Critically it costs **zero
`game.js` lines**, and `game.js` has three of its 460 free.

Two traps, both verified against this repo's own shader:

- **Do not set `heroOpts.carPaint`** — it is a metallic-*flake* model
  ("~4.5 mm object-space cell gets a random flake tilt"). Glitter on cloth, and
  the exact axis Insomniac deliberately moved away from.
- **Do not stamp the suit `MAT 7` (FABRIC)** — `matTexUV()` keys the triplanar
  tile off `vWorldPos`, so the weave would swim across the suit as the hero
  moves.

And one free finding: the hero has **almost no rim light and the shader already
has one.** The sky-rim Fresnel is scaled by `(1.0 - rough * 0.85)`, which at
`roughness: 0.82` is **0.303** — the cloth-shading win bought realism and
silently paid for it in silhouette separation. Rim light is precisely the
silhouette device the art-direction literature names.

If webbing is wanted later it is a **shader branch, not a texture**: `vObjPos`
already exists in the lit shader (car paint uses it for exactly the swimming
reason), so a procedural object-space web is ~12 GLSL lines with no texture, no
UV and no memory.

**Model sourcing, if an authored body is ever baked:** Quaternius' *Universal
Base Characters* is CC0, glTF, and ships **superhero proportions** — about as
close to a bespoke match as a free asset gets. Mixamo is usable for offline
auto-rigging but **not** for a committed asset: Adobe grants royalty-free *use*,
not redistribution, and this is a public repo a Pages workflow stages. The
project already accepts the fan-game exposure on the name and costume; asset
provenance is the avoidable half, so **never use a model that is a Spider-Man
rip** — a generic CC0 body with our own colour blocking keeps that clean.

---

## 8. One deliberate departure, recorded rather than fixed

Insomniac's stated design goal is making players *"feel like they're better at
the game than they are"* **[DEV]**. Fristrom's is the opposite, and
`docs/PLAN.md` §2.2 sides with Fristrom.

That is defensible for a game with no mass-market obligation. But it means we
are **not** cloning the reference's most load-bearing design value, and every
assist decision should be read in that light. It also reframes our own assists:
`ASSIST_Y` is not a safety net today, it is the **primary anchor source** across
most of the map — so retuning it before fixing the city would remove the only
thing keeping the low-rise majority playable.

---

## 9. Missions and content

**Not yet researched.** The game has no mission content at all: no objectives,
no activities, no progression, no reason to swing anywhere in particular. A
research pass on the reference games' activity taxonomy, spawn/pacing systems,
token economy, skill trees and what a one-developer procedural clone can
actually reproduce is in flight; this section will be written from it rather
than guessed at.

What is already known and constrains it: everything must be **deterministic per
seed** (no `Math.random` reachable from `buildCity()` or `hero.step()`), and the
city is generated rather than authored — so activity placement is a generator
concern, and anything requiring hand-placed geometry is in §3's "cannot be
fixed" column.
