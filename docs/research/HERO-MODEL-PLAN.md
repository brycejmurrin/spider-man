<!-- Second research pass on the hero mesh, 2026-08-08. Supersedes the ranked
     plan in HERO-MODEL.md, which it also CORRECTS: that document says "21
     boxes, 504 vertices, 252 triangles"; the real builder run in bare Node
     reports 19 boxes, 456 verts, 228 tris. Everything below was measured or
     read from the source — nothing was rendered and no test was run, which is
     stated again at the end where it matters. -->

# Making the Web-Slinger hero look dramatically better

Research + decision. Read-only pass over `/home/user/spider-man` and
`/home/user/f1-game`; nothing was run in a browser and nothing was edited.

---

## 0. Measurements taken this session (not estimates)

Ran the real builder in bare Node (`js/hero/hero3d.js` is headless-safe):

| segment | verts | tris |
|---|---|---|
| torso | 96 | 48 |
| head | 72 | 36 |
| upperArmL / R | 24 | 12 |
| foreArmL / R | 48 | 24 |
| thighL / R | 24 | 12 |
| shinL / R | 48 | 24 |
| **TOTAL (10 meshes)** | **456** | **228** |

GPU cost: `456 × 9 floats × 4 B + 228 × 3 × 2 B` = **17,784 bytes ≈ 17 KB**.

`docs/research/HERO-MODEL.md` §1.1 says "21 boxes … 504 vertices, 252
triangles". It is **19 boxes, 456 verts, 228 tris** — its box count double-counts
the single-box upper arms/thighs. Small, but the whole "polygon budget is not the
binding constraint" argument rests on it, so the corrected number should replace
it.

Budget context, from `docs/research/ARCHITECTURE-CRITIQUE.md` §8 (measured under
`node --expose-gc`): `buildCity(42)` allocates **287.3 MB** of JS heap and
**191.7 MB is still resident** for the session, against a platform budget the
renderer's own comments put at **~100 MB**. The hero is 17 KB of that. **Memory
is a real problem in this project and the hero is not remotely part of it.**

Size ratchets, current (`tests/unit/module-size.test.mjs`):

| file | lines | ceiling | free |
|---|---|---|---|
| `js/game.js` | 457 | 460 | **3** |
| `js/hero/hero3d.js` | 246 | 260 | 14 |
| `js/game/hero.js` | ~355 | 380 | ~25 |

**`js/game.js` has three lines of headroom.** That is the hardest constraint on
this work and it rules out any plan whose cost lands in the draw path.

State of the prior document's proposals: **P2 (pose the shadow, cast every
segment), P3 (pose damping, the nine `SM` scalars), P5 (cloth shading — `heroOpts`
is now `{roughness: 0.82, specular: 0.28, emissive: 0.10}`) and P6 (web-arm yaw,
as `armRZ`) have all LANDED.** P1 (emissive lenses) has **not** — `mk()` still
stamps `_mat: 20` on every accumulator including the head. P4, P7, P8 not done.

---

## 1. The glTF question, answered

### What `/home/user/f1-game/js/render/gltf.js` actually is

453 lines, zero dependencies. Self-contained column-major mat4/quat helpers,
its own base64 decoder (`atob` or `Buffer`), `TextDecoder`, `fetch`. Pure IIFE:
`const GLTF = (function () { … })()` with no `export`.

Public surface: `parseGLB(arrayBuffer)`, `toMesh(arrayBuffer, opts)`,
`load(url, opts)` where `opts = {scale, swapYZ, tint}`.

**What it supports:** GLB container (magic/version/chunk walk), the JSON +
BIN chunks, `data:` base64 buffer URIs, accessors including interleaved
`byteStride` and `normalized` integer types, the full node hierarchy
(`matrix` or TRS, recursive walk with a cycle guard, correct
inverse-transpose for normals), multi-primitive multi-mesh merge into ONE
buffer set, `TRIANGLES` only, `material.pbrMetallicRoughness.baseColorFactor`
baked to vertex colour, optional `COLOR_0` multiplied in, flat face normals
computed when `NORMAL` is absent, Uint16/Uint32 index promotion.

**What it refuses, by its own header comment:** *"textures/UVs, external .bin or
image URIs, Draco / meshopt compression, animations, **skins/morphs**, sparse
accessors, cameras, lights"*, and the text `.gltf` form.

### Why that refusal is decisive

The glTF 2.0 spec requires that *"When the node contains `skin`, all
`mesh.primitives` MUST contain `JOINTS_0` and `WEIGHTS_0` attributes"*
(https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), and Khronos'
own tutorial states the runtime contract:

> `jointMatrix(j) = globalTransformOfJointNode(j) * inverseBindMatrixForJoint(j);`
> … The skin matrix is then used to transform the original position of the vertex
> into the world space. **The transform of the node that the skin is attached to
> is ignored.**
> — https://github.com/KhronosGroup/glTF-Tutorials/blob/main/gltfTutorial/gltfTutorial_020_Skins.md

`gltf.js` reads `POSITION`, `NORMAL`, `COLOR_0` and the node transform, and
nothing else. Feed it a rigged character and it emits **the bind pose as one
merged rigid blob** — a T-posed statue with no joints, which is strictly worse
than the ten boxes that already bend.

Second refusal, equally decisive: **no UVs, and this renderer has no UV channel
at all.** `GLX.createMesh` (`js/render/glx.js:466-520`) interleaves
`[pos3, nrm3, col3, (mat1), (trk3)]` — there is no texture-coordinate attribute
anywhere in the vertex format. f1-game's own in-browser baker says it out loud
at `assets/pack/webbake.js:450`: *"textures dropped — the lit path is
vertex-colour only"*. Every authored character worth downloading is textured;
through this pipeline it arrives as flat per-material colour.

### Verdict on porting it into the runtime: NO

- Mechanical port cost is genuinely trivial (`const GLTF` → `export const GLTF`,
  plus `tools/manifest.cjs` + the import-map entry + the modulepreload + a `?v=`
  bump). That is not the argument.
- The argument is that it buys a **static** mesh, and this project's entire
  problem is **articulation**.
- And there is already a better runtime path for static meshes, already ported:
  `js/render/assets.js` carries the complete `Assets.model(id)` / `modelSync` /
  `loadModels()` API and the `AX26` binary format (`_parseModel`, lines 240-300),
  whose whole point is *"the bake tool already resolved materials down to a
  vertex colour plus a MAT id, so this is a straight typed-array view with **no
  parsing**, no material resolution and no runtime cost beyond the fetch."*
  `assets/pack/manifest.json` even ships `"models": {}` — an empty, waiting slot.

**The runtime half of the model pipeline is already here. What is missing is the
baker**, and a baker is offline tooling, which the no-build-step rule does not
touch (f1-game's `tools/assets.mjs bake-model <id> <file.glb>` runs `gltf.js`
inside a `vm` sandbox precisely so the offline and runtime parses agree).

Note for the record: `docs/research/PORTING-CANDIDATES.md` rejected `gltf.js`
with *"453 lines of .glb loader for a project whose entire world is procedural"*.
That verdict was right about the runtime and should be **amended**, not
reversed — the file belongs in `tools/`, invoked offline, never in `MODULES`.

---

## 2. The skinning question, answered

Cost of real GPU skinning in *this* engine, concretely:

- **Uniforms.** 10-20 bones × 4 `vec4` = 40-80 `vec4` added to `litProg`. That
  program is shared by the entire city; `litU` already resolves ~80 uniform
  names including five `[0]` arrays. WebGL2 Fundamentals' skinning lesson
  measures the ceiling: *"most devices support 128 vec4s and 70% of them support
  256 vec4s but … that's still only 13 bones and 29 bones respectively"*
  (https://webgl2fundamentals.org/webgl/lessons/webgl-skinning.html). Ten bones
  fits — which is exactly why it buys nothing.
- **Vertex format.** `JOINTS_0` + `WEIGHTS_0` are two more `vec4` attributes on
  the ONE interleaved layout every mesh in the game shares (`createMesh`,
  `glx.js:479-503`). Adding them touches the VAO layout that carries 1.47 M city
  prop vertices, for one character.
- **Authored weights.** For procedural boxes there are no weights; someone has to
  write a weight function. For an authored model there are weights — but see §1:
  they cannot get here.

**Verdict: no.** Not as a shared-program change. Ten bones is inside every
uniform budget the web has, so skinning's only real gain is smooth joint
deformation, and there is a cheaper way to get the *visible* part of that
(§4, S2).

---

## 3. The unexplored third option: hard skinning at bake time

The synthesis neither "keep boxes" nor "port the loader" reaches. It is a real,
documented technique, not an invention — it is what PS1 engines do:

> At export time … **Records per-triangle bone indices (hard skinning — each
> vertex uses its highest-weight bone)** … The PS1 doesn't have the power for
> multi-bone blending per vertex. Each vertex is assigned to a **single bone**
> (the one with the highest weight). Design your meshes with this in mind —
> weight painting should use clean, hard transitions between bones.
> — https://psxsplash.github.io/docs/2.3.0/components/skinned-meshes/

Applied here, **entirely offline**:

1. Read a CC0 rigged `.glb` with an extended `gltf.js` that also reads
   `skins`, `inverseBindMatrices`, `JOINTS_0`, `WEIGHTS_0`.
2. Per vertex, take `argmax(WEIGHTS_0)` → one joint index.
3. Pre-multiply the vertex by that joint's `inverseBindMatrix`, putting it in
   **bone-local space** — which is exactly the space `hero3d.js` already builds
   in ("Every segment's geometry origin is its PIVOT JOINT").
4. Group the vertices by joint into the project's ten named segments (a
   joint-name → segment map; a 20-bone humanoid rig collapses cleanly, and spare
   bones like the spine chain either merge into `torso` or become new segments).
5. Paint vertex colours by body region — the project's own red/blue/black
   scheme, not the source model's textures.
6. Emit one `AX26` `.bin` per segment into `assets/pack/models/`, register them
   in `manifest.json`'s waiting `models: {}`.

At runtime **literally nothing changes**: `buildHero()` gains a
`Assets.modelSync("hero-" + seg) || <procedural boxes>` branch, honouring the
degradation contract `assets.js` already guarantees ("NO PACK IS A VALID
STATE"). Same ten meshes, same `pose()`, same `chain()`, same `wristR()`, same
shader, zero new uniforms, zero new attributes, zero new runtime modules.

The seams get worse, not better, under hard skinning — but §4's pivot balls fix
seams regardless of where the geometry came from, which is why they come first.

---

## 4. THE PLAN — ranked

House rules re-checked against every step: no new runtime module except where
flagged; determinism untouched (all of this is in `render()`, never
`hero.step()`); `js/city/` and `js/game/hero*.js` stay headless (`js/hero/` has
no headless rule but is in `HEADLESS_SAFE` and must stay importable in Node —
`geom.js` is renderer-free, so S1/S2 keep that property).

### Tier 0 — geometry. This is the "dramatically better".

**S1 — `Geom.addSphere(out, c, r, col, seg, rings)`.** New primitive in
`js/city/geom.js`. There is no sphere anywhere in this codebase; `Geom` exports
`addBox / addPrism / addPyramid / addCone / addCyl / addFrustum / addMountain /
addMesh` and nothing rotation-invariant. Build it from `emit()` like the others
so it inherits the auto-orient (`ref` = centre) and the NaN guard. ~14 lines.
`geom.js` has no ratchet. Zero cost until used.

**S2 — a `limb()` emitter in `hero3d.js`, and rebuild all eight limb segments
with it. THIS IS THE HIGHEST-IMPACT CHANGE (argued in §6).**

```js
// pivot ball + tapered stack, in the segment's own bone-local space
function limb(o, len, r0, r1, col, seg) {
  Geom.addSphere(o, [0, 0, 0], r0 * 1.05, col, seg, 2);        // fills the socket
  Geom.addFrustum(o, [0, -len * 0.55, 0], r0, (r0 + r1) / 2, len * 0.55, col, seg, DOWN);
  Geom.addFrustum(o, [0, -len, 0], (r0 + r1) / 2, r1, len * 0.45, col, seg, DOWN);
}
```

- The **ball at the pivot is rotation-invariant**, so it occludes the gap for
  *every* joint angle. That is the documented tell of the whole technique
  (Roblox R15: *"the gaps are too noticeable … The joints' disconnecting also
  seems to be a problem"* — cited in the prior doc) and the PS1 answer was
  exactly a dedicated joint mesh at each pivot.
- The **taper** is what stops it reading as boxes. A frustum stack going
  shoulder→elbow→wrist at 0.055 → 0.045 → 0.038 m gives a real limb profile.
- Note `addFrustum`/`addCyl`/`addCone` are **base-anchored** (`c` is the base
  centre, and `geom.js` carries a seven-defect warning about exactly this) — the
  limb hangs down `-Y` from its pivot, so pass a `basis` with `u = [0,-1,0]` or
  anchor at the far end.

**Vertex cost, computed.** `seg = 8`: a frustum is 8 quads = 32 verts / 16 tris;
a 2-ring sphere is ~8×4 faces ≈ 112 verts / 56 tris. Per limb segment ≈ 96 + 112
= ~208 verts, ~104 tris. Eight limb segments ≈ **1,660 verts / 830 tris**. With
S3 the whole character lands near **2,600 verts / 1,300 tris ≈ 100 KB GPU** —
against 191.7 MB of resident city heap, and against the 250-polygon original
Lara Croft the prior doc benchmarks. This is free.

**Ratchet:** `limb()` is ~8 lines and *replaces* six existing box calls, so
`hero3d.js` lands around 250/260. Fits.

**S3 — torso, neck, head.** Chest wider than waist (two stacked frusta), deltoid
balls at both shoulders parented to the torso, a short neck cylinder, and the
head as a rounded mask (frustum stack, wider at the crown, tapering to the chin)
instead of a cube. Keep the lens plates, emblem, gloves and boots as **boxes** —
those are hard shapes and reading as hard shapes is correct. ~12 lines.

**S4 — one more articulation: feet.** The rig has no ankle, so the boot is
welded to the shin and the foot never flattens against a surface. A `footL/R`
segment is 2 segments, 2 meshes, 2 locals, and unlocks A2 below. Costs 2 lines
in `game.js` — **and `game.js` has 3 free.** Defer this until something is
extracted from `game.js`, or extract the hero draw block into a
`js/hero/hero-draw.js` first (new file → manifest + import map + modulepreload +
`?v=` bump, per the checklist).

### Tier 1 — shading and read. Near-free, biggest gain at distance.

**L1 — emissive lenses.** `_mat = 25` on the two lens boxes only. `lit.js:762,
783` gives `emissive = emissiveSurface ? max(uEmissive, 1.0) : …`, i.e. 1.0
instead of today's 0.10, plus the bloom glow tag. 2 lines, verified mechanism,
still the highest payoff-per-line in the document. **Not yet landed.**

**L2 — the hero has almost no rim light, and the shader already has one.**
`lit.js:1274-1276` computes a sky-rim Fresnel scaled by `(1.0 - rough * 0.85)`.
At `heroOpts.roughness = 0.82` that factor is **0.303** — the cloth-shading win
(P5) bought realism and silently paid for it with the silhouette. Rim light is
precisely the silhouette-separation device the art-direction literature names.
Options, in order of cheapness: (a) split `heroOpts` so the *suit* stays matte
while a rim knob is raised; (b) give the hero a dedicated rim term. Measure
before choosing — this one is a prediction.

**L3 — two things NOT to do, both now verified against this repo's shader.**
- **Do not set `heroOpts.carPaint`.** It is a *metallic-flake* model
  (`lit.js:1189-1215`, "~4.5 mm object-space cell gets a random flake tilt") —
  glitter on a cloth suit, and the exact axis Insomniac deliberately moved away
  from.
- **Do not stamp the suit `MAT 7` (FABRIC).** `matTexUV()` (`lit.js:287-296`)
  keys the triplanar tile off **`vWorldPos`**, not object space. The weave would
  swim across the suit as the hero moves. The prior doc flagged this as an
  unverified risk; it is now verified as real.

**L4 — webbing, if you want it, is a shader branch, not a texture.** The lit
shader already carries `vObjPos` (`lit.js:39, 58, 83`) — object-space position,
used by car paint for exactly the reason that world space swims. A new surface
id (28 — extend `classifiedCar`'s `>= 20 && <= 27` range) with a procedural
object-space web pattern is ~12 GLSL lines, zero texture, zero UV, zero memory,
and is the idiom this whole renderer is written in. This supersedes the prior
doc's P9 Option B (a canvas-2D decal atlas, ~120 lines + a new module).

### Tier 2 — animation. `pose()` damping already landed; these are what is next.

Trifox's shipped decomposition is the right frame and it is four named things
(https://www.trifox-game.com/exploring-procedural-animation-in-trifox/):
**Intent** (head leads), **Action** (limbs drive), **Reaction** (body responds),
**Follow-through** (the trailing part lags). The current `pose()` has Action and
half of Reaction.

- **A1 — head look-at (Intent).** Trifox implemented Intent *first*, before the
  legs, precisely because it stands alone and pays immediately. Aim the head at
  the anchor while swinging, at the velocity vector while diving, at the landing
  point while falling. The rig has no Y axis at the neck — add one (`setRotXZ` →
  `setRotYXZ`), which S2's work already invites.
- **A2 — foot-to-surface IK.** `city/colliders.js` already exports `roofAt`, and
  Trifox's note applies verbatim: *"we also force the rotation of the foot joint
  to be aligned with the floor … the feet would stick into the ground instead of
  being nicely grounded"*. Needs S4's ankle.
- **A3 — torso/head lag against root yaw rate (Follow-through).** Same damper,
  larger halflife. Free once the `SM` block exists — which it now does.
- **A4 — two-bone IK for the web arm.** Analytic, ~15 lines
  (https://blog.littlepolygon.com/posts/twobone/). **Low priority:** with a fixed
  arm and a 40 m anchor the solver degenerates to "point the arm at it", which
  `armRZ` already approximates. Do it only if the arm is ever asked to reach
  something close.

### Tier 3 — the authored model (§3). Do this LAST, or never.

- **M1** — copy `gltf.js` to `tools/` (NOT `js/`, NOT `MODULES`); extend it
  offline with `skins` / `inverseBindMatrices` / `JOINTS_0` / `WEIGHTS_0`.
  ~+90 lines on a file nobody has to load at runtime.
- **M2** — the hard-skin bake: argmax weight, pre-multiply IBM, group into
  segments, paint per-region vertex colours. ~200 lines of new `tools/assets.mjs`
  (f1-game's `bakeModel`, lines 454-530, is the working template — it already
  writes the exact `AX26` layout `_parseModel` reads).
- **M3** — `buildHero()` prefers `Assets.modelSync("hero-<seg>")`, falls back to
  the procedural segments. ~4 lines in `hero3d.js`, 0 in `game.js`.

**Only start M1 once S2/S3 have shipped**, because if the tapered procedural
hero already reads well, this becomes an optional aesthetic upgrade rather than a
rescue — and because the pivot balls are needed either way.

---

## 5. Sourcing a model, and the licensing

**The safe pick: Quaternius, *Universal Base Characters*.**
https://quaternius.com/packs/universalbasecharacters.html — six game-ready
bases in **Superhero, Regular and Teen proportions**, average **13k triangles**,
humanoid rig, **`.FBX` and `.glTF` formats**, and *"Free to use in personal,
educational and commercial projects. (CC0 License)"*. A superhero-proportioned,
CC0, glTF, rigged humanoid is close to a bespoke match for this need. Also
`https://poly.pizza` mirrors Quaternius packs as direct **GLB** downloads.
Other CC0 pools: https://opengameart.org/content/3d-humanoids-under-cc0 and
https://github.com/madjin/awesome-cc0.

**Why a full-body costume is the forgiving case.** No face, no hair, no skin
shading, no cloth sim — the three things a low-poly humanoid is worst at are
exactly the three the character does not need. A masked figure is a
silhouette plus colour blocking, and both survive the vertex-colour-only
pipeline intact.

**Mixamo: usable, but not for this repo.** Adobe's FAQ is unambiguous that the
content is free to use — *"You can use both characters and animations royalty
free for personal, commercial, and non-profit projects including … Create video
games"* (https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) — but Adobe
**retains rights to the content**. That is a licence to *use*, not to
*redistribute*, and this project's assets sit in a public git repo that a Pages
workflow stages. CC0 is the right constraint here; Mixamo is fine as an offline
*rigging* step (its auto-rigger takes a humanoid mesh) whose output you would then
have to check against its terms before committing.

**On the fan-game risk itself, stated plainly.** Odin Law (Veda Cruz, a video
game lawyer): *"Rights holders have exclusive control over derivative works,
which means fan projects, even if noncommercial, are typically infringing"*, and
on the defence people reach for: *"fair use is not permission granted in advance;
it is a defense raised after infringement is alleged … Because fan games often
copy characters, settings, music, and other substantial parts of the original,
fair use arguments are rarely successful."*
(https://odinlaw.com/blog-fan-games-legal-risks/) The exposure is the **name and
the costume design**, which the project has already chosen to accept and which
`CLAUDE.md` labels "unofficial … inspired". Nothing in this plan changes that
exposure. What it *does* control is the second, avoidable risk: **never use a
model that is a Spider-Man rip.** A generic CC0 body plus the project's own
colour blocking keeps the third-party-asset half of the problem completely clean,
and is the specific, defensible recommendation.

---

## 6. The single highest-impact change

**S2: the `limb()` emitter — a tapered frustum stack with a rotation-invariant
ball at its pivot — applied to all eight limb segments.**

The argument:

1. **It is the only change that fixes both named defects.** The captured frame
   shows joint gaps *and* a blocky silhouette. The ball fixes the gaps (it
   occludes the socket at every angle, which is why PS1 rigs used dedicated joint
   meshes and why Roblox's R15 wiki records the gap as its persistent complaint);
   the taper fixes the blockiness. Emissive lenses, cloth shading and pose
   damping are all worthwhile and none of them touch either defect.
2. **It is the difference the question is actually about.** "Articulated
   character" vs "assembled boxes" is decided at the joints. A rig with filled
   sockets and tapered limbs reads as a character at 250 triangles — the original
   Lara Croft is the proof.
3. **It costs nothing that is scarce.** ~830 extra triangles and ~80 KB of GPU
   buffer, in a project whose measured pressure is 191.7 MB of *resident JS heap*
   and 3 free lines in `game.js`. It needs **zero** `game.js` lines, zero new
   modules, zero import-map entries, zero shader changes, zero uniforms, and it
   cannot touch determinism because `buildHero()` runs once at boot and `pose()`
   runs in `render()`.
4. **Everything downstream inherits it.** An authored model (§3) arrives into the
   same ten meshes, the same `pose()`, the same `chain()`. Improving that path is
   never wasted work, and doing it first converts the model decision from a rescue
   into an option.

Second place, and it should ship in the same commit because it is two lines:
**L1, the emissive lenses** — the one proposal from the prior document with a
verified mechanism that still has not landed.

---

## 7. Things I did not verify

- **Nothing was rendered.** Every claim about how a change will *look* — S2's
  silhouette, L1's bloom strength, L2's rim — is a prediction from reading the
  shader, not a capture. L2 in particular should be measured before it is
  believed.
- **No test was run.** `npm run test:tooling-fast` has no hero-geometry coverage
  at all (`grep` over `tests/` finds `hero3d` only in the size ratchet), so S1-S4
  ship with no automated guard. Worth adding a unit test that asserts every
  segment's verts are finite and its bounding box is sane — `hero3d.js` is
  already in `HEADLESS_SAFE`, so it costs one file in `tests/unit/`.
- **I did not open a Quaternius `.glb`** to confirm its joint names, bone count,
  or that its skin survives an `argmax` collapse cleanly. M2 should prototype on
  one file before the baker is written.
- **The frustum-stack vertex counts are arithmetic, not a build.** Run
  `buildHero()` in Node again after S2 and replace them with the measurement.
