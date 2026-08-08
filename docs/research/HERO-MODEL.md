# Web-Slinger — the hero model: what it does today, what the field does, and what to change


## Part 1 — What the code does today

### 1.1 The mesh: ten rigid boxes, ten meshes, ten draws

`js/hero/hero3d.js` (191 lines; ceiling 240 in `tests/unit/module-size.test.mjs`) builds the hero
as a set of independent geometry accumulators, one per body segment, each with its **geometry
origin at its own pivot joint**:

```js
export const SEGMENTS = ["torso", "head",
  "upperArmL", "foreArmL", "upperArmR", "foreArmR",
  "thighL", "shinL", "thighR", "shinR"];
```

Ten segments (the file header comment says "Nine segments" — stale). Every segment is built from
`Geom.addBox` calls only. Counting boxes: torso 4 (chest / abdomen / pelvis / emblem), head 3
(mask + 2 lenses), each upper arm 1, each forearm 2 (forearm + hand), each thigh 1, each shin 2
(shin + boot) = **21 boxes = 126 quads = 504 vertices, 252 triangles** for the whole character.
There is no cylinder, no cone, no sphere anywhere in the hero, although `Geom` exports
`addCyl`, `addCone`, `addFrustum`, `addPyramid`, `addPrism` and `addMesh`.

The joint datums are frozen data:

```js
export const JOINTS = {
  pelvis: [0, 0.92, 0],
  neck: [0, 1.52, 0],
  shoulderL: [-0.24, 1.46, 0], shoulderR: [0.24, 1.46, 0],
  elbowDrop: 0.30,             // shoulder -> elbow length
  foreLen: 0.28,               // elbow -> wrist
  hipL: [-0.11, 0.92, 0], hipR: [0.11, 0.92, 0],
  thighLen: 0.44, shinLen: 0.48,
};
```

So the figure is 1.52 m to the neck with a 1.7 m `HeroConsts.HEIGHT`; upper arm 0.30 m, forearm
0.28 m (total reach 0.58 m from the shoulder), thigh 0.44 m, shin 0.48 m. Shoulders are 0.48 m
apart, hips 0.22 m apart.

Colours are five frozen constants, applied per-box as vertex colour:

```js
const RED = [0.72, 0.10, 0.13];
const DK_RED = [0.55, 0.08, 0.11];
const BLUE = [0.12, 0.17, 0.45];
const LENS = [1.6, 1.6, 1.7];          // HDR white — reads at night
const BLACK = [0.05, 0.05, 0.06];
```

Colour blocking: chest RED, abdomen + pelvis BLUE, a BLACK `0.10 × 0.14 × 0.012` emblem plate at
`[0, 0.42, 0.115]`, head RED with two LENS plates `0.075 × 0.09 × 0.012` at `[±0.055, 0.15, 0.118]`,
arms RED with DK_RED hands, legs BLUE with RED boots. That is the classic red/blue split, but
**inverted at the arms** — the classic suit has blue upper arms below the shoulder and red gloves;
here the whole arm is red and only the hand is dark red.

Every accumulator is created with `_mat: 20`:

```js
const mk = () => ({ pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 20 });
```

### 1.2 What material id 20 actually does in the ported shader

This matters and is not obvious. `js/render/shaders/lit.js` in *this* repo (ported from Apex 26)
still carries the Car3D surface classification:

```glsl
// Car3D surface ids occupy 20..26, above TrackGeom's 0..15 material range.
int surfaceId = int(vMat + 0.5);
bool classifiedCar = surfaceId >= 20 && surfaceId <= 27;
bool paintSurface = surfaceId == 20;
...
bool emissiveSurface = surfaceId == 25;
...
float emissive = classifiedCar
  ? (emissiveSurface ? max(uEmissive, 1.0) : (paintSurface ? uEmissive : 0.0))
  : uEmissive;
```

So id 20 = `paintSurface`. It gets `carPaint = uCarPaint` and `clearcoat = uClearcoat` — but the
hero is drawn with

```js
const heroOpts = { roughness: 0.55, specular: 0.6, emissive: 0.10 };
```

and `glx.js` defaults `carPaint` and `clearcoat` to `0.0` when the option is absent. **The entire
car-paint path — orange peel, metallic flake, the clearcoat env lobe — is therefore switched off
for the hero.** Being id 20 buys nothing today except `emissive = uEmissive = 0.10` (which the
non-classified path would also give) and exclusion from `applyMaterial()`'s procedural surface
texture, since that function's branch chain ends at `mid == 16` and `matTexUV()` early-outs on
`mid <= 0 || mid > 16`. `applyMaterialNormal()` does *not* early-out for 20, so it computes
`matBumpHeight(20, …)` three times per fragment; that function returns `0.0` for 20, so the cost is
paid and nothing happens.

The lenses' `[1.6, 1.6, 1.7]` albedo is HDR-ish vertex colour, and with `emissive = 0.10` the
shader does `color = mix(color, albedo, 0.10)` plus a small `glow` term — a 10% push. **The lenses
are not marked emissive.** Stamping them `25` would make the shader take
`emissive = max(uEmissive, 1.0)`, i.e. full self-illumination plus the glow/bloom tag.

### 1.3 The pose function

`pose(out, state, t, speed, extra)` writes ten column-major `Float32Array(16)` locals. Two helpers
do all the work:

```js
function setRotXZ(m, rx, rz, px, py, pz) {
  // M = T(pivot) * RotZ(rz) * RotX(rx), column-major
```

and `chain(m, parent, rx, rz, off)` which does `m = parent * T(off) * RotZ * RotX`. **There is no
Y axis anywhere in the rig.** Every joint has exactly two degrees of freedom, one of which (`rz`)
is a fixed constant per limb: `±0.22` for the shoulders, `±0.04` for the hips, `0` for elbows,
knees, neck and root.

The state machine's four poses are hard-coded angle sets:

| | torsoPitch | legL/legR | kneeL/kneeR | armL/armR | elbL/elbR | headPitch |
|---|---|---|---|---|---|---|
| `ground` | `0.12*run` | `±sin(ph)*0.85*run` | `max(0,∓sin ph)*1.0*run` | `∓legLA*0.8` | `0.5*run+0.2` | 0 |
| `swing` | `0.55` | `0.45 / 0.62` | `0.9 / 1.15` | `0.5 / -π+tetherPitch` | `0.7 / 0.15` | `-0.35` |
| `wallrun` | `0.6` | `±sin(t*9)*0.8` | `0.8 / 0.8` | `∓legLA` | `0.6` | 0 |
| `air` (glide) | `-0.15` | `0.3 / 0.15` | `0.55 / 0.9` | `-2.2 / -2.2` | `0.35` | 0 |
| `air` (dive) | `0.2` | `-0.1 / -0.1` | `0.15` | `0.9 / 0.9` | `0.1` | 0 |

with `run = min(1, speed/8)` and `ph = t * (4 + speed*0.9)`. At `RUN_V = 9` m/s that is
`ph' = 12.1 rad/s`, ~1.93 Hz stride, ~3.9 footfalls/s.

The head is counter-rotated against the torso — `headPitch - torsoPitch * 0.6` — a partial
"keep the head level" rule. That is the only relational rule in the whole function.

`wristR(out, root, locals)` transforms the point `[0, -foreLen - 0.05, 0]` through `foreArmR`'s
local and then the root, and `js/game/webline.js` builds the ribbon from there to `hero.anchor`
at 30 Hz.

### 1.4 How the driver drives it

`js/game.js` (440 lines; ceiling 460 — **20 lines of headroom**):

```js
const heroGeo = buildHero();
const heroMeshes = {};
for (const s of SEGMENTS) heroMeshes[s] = gfx.createMesh(heroGeo[s]);
const heroLocals = {};
for (const s of SEGMENTS) heroLocals[s] = new Float32Array(16);
```

and in `render(dt)`:

```js
heroRoot(ix, iy, iz, ihead);
const tetherPitch = hero.anchor
  ? Math.atan2(Math.hypot(hero.anchor[0] - ix, hero.anchor[2] - iz), hero.anchor[1] - iy) : 0;
pose(heroLocals, hero.state, hero.state === "ground" ? frame.time : hero.airTime,
  hero.speed, { tetherPitch, diving: hero.v[1] < -20 });
for (const s of SEGMENTS) {
  M4.mulTo(segWorld, rootMat, heroLocals[s]);
  gfx.draw(heroMeshes[s], segWorld, heroOpts);
}
```

`heroRoot` is **yaw only** — "pitch/roll live in the segment poses", per its own comment. So the
body never banks into a swing even though `cameras.js` has a `roll` term.

### 1.5 Five defects I found by reading

These are stated as findings, not guesses; each names the line that produces it.

1. **The wall-run leg cycle is frozen.** `pose()` gets `t = hero.airTime` for every non-ground
   state, and `js/game/hero.js` increments `airT` only inside
   `if (state === "air" || state === "swing")`. The `wallrun` branch never touches it. So `ph = t*9`
   is a constant for the whole wall run and the legs hold a single frame. (`airT` is also reset to
   0 only in `ground`.)

2. **The hero's shadow is a chest floating at ankle height, and it is 1/10 of the character.**

   ```js
   heroRoot(ix, iy, iz, ihead);
   gfx.castShadow(heroMeshes.torso, rootMat);
   ```

   The torso mesh's boxes live at y ∈ [−0.09, 0.60] *relative to the pelvis pivot*; the pivot
   translation `T(0, 0.92, 0)` lives in `heroLocals.torso`, which is not multiplied in here. The
   shadow caster is therefore a 0.36 × 0.44 × 0.22 box centred 0.38 m above the feet, un-posed, and
   the head, arms and legs cast nothing. (The call also runs *before* `pose()` for this frame, so
   even if the local were applied it would be one frame stale — harmless, but worth knowing.)

3. **The swing arm cannot track a sideways anchor.** `extra.tetherYaw` is named in `pose()`'s own
   doc comment (`extra: { tetherPitch, tetherYaw }`) but is neither passed by `game.js` nor read by
   `pose()`. `armRA = -Math.PI + extra.tetherPitch` is a pure sagittal-plane rotation. Because
   `hero.js` deliberately alternates anchor sides (`lastSide` / `bestSide`, the auto-straightening),
   roughly half of all swings have the anchor off to one side while the arm points straight up the
   body's midline. The webline still starts at the wrist, so the visible result is a web that
   leaves the hand at a large angle to the arm.

4. **Poses snap on every state transition.** `pose()` is a pure function of `(state, t, speed)`
   with no memory. `swing → air` moves `armRA` from `≈ -π` to `-2.2` — about 55° — in one frame.
   Ditto `air → ground`, `ground → swing`, and both `air` sub-modes when `hero.v[1]` crosses −20.

5. **The rig has no yaw and no twist.** Two DOF per joint, one of them a per-limb constant. The
   hero cannot look at anything, cannot reach across the body, cannot rotate the torso relative to
   the hips, and cannot bank.

Additionally: `heroOpts` is a single material for all ten meshes, so the lenses shade exactly like
the boots; and `js/game/webline.js` does `gfx.freeMesh` + `gfx.createMesh` 30 times a second while
attached, which is per-second GPU buffer churn adjacent to (but not part of) the hero model.

### 1.6 The pattern this borrowed from Apex 26

The claim in `docs/PLAN.md` — "the source project's articulated sub-mesh pattern (wheels and aero
flaps as separate meshes with their own transforms) *is* a skeleton if you use it as one" — is
accurate. In `/home/user/f1-game/js/game.js`, `drawPlayerWheels` composes a local matrix by hand
and multiplies into world, exactly as `pose()`/`chain()` now do:

```js
// local = translate(corner) ∘ rotY(steer) ∘ rotX(spin), composed
// straight into a scratch matrix (no per-frame allocation), then into world.
L[0] = cs*ws;  L[1] = 0;   L[2] = -ss*ws; ...
M4.mulTo(_wheelWorld, base, L);
gfx.draw(wd.rear ? wm.R : wm.F, _wheelWorld, opt);
```

Two things Apex 26 does that the hero does **not** yet inherit:

- **`Car3D.SURFACES` is a real classification** — `paint: 20, carbon: 21, rubber: 22, metal: 23,
  glass: 24, emissive: 25, panel: 26, mirror: 27` — and the shader branches on all eight. The hero
  stamps everything 20 and gets one of them.
- **`js/car/liverytex.js` is a canvas-2D atlas** (`SIZE = 1024`, named `REGIONS`) and
  `js/game/carmesh.js` builds separate *decal quad* meshes drawn over the painted body with
  `gfx.drawDecal`. That is exactly the mechanism a web-pattern overlay would use, and `glx.js` in
  this repo still exports `drawDecal(mesh, modelMat, tex, opts)`. **But** `liverytex.js` reads
  `localStorage` and `navigator` at module scope, and any equivalent here would have to live
  outside `js/game/hero*.js` (it could live in `js/hero/`, which has no headless rule, or better
  in a `js/render/` module).

---

## Part 2 — Findings from the field

### 2.1 Rigid-segment (no-skinning) character animation

**The technique is: a transform hierarchy where each bone owns one whole rigid mesh, and 100% of
each vertex's weight goes to that one bone.** It was the fifth-generation console norm because the
per-vertex blend was the expensive part. A Polycount discussion of the era summarises the
motivation bluntly — "segmented mesh animation was a performance limitation, not [a] stylistic
choice" (https://polycount.com/discussion/236049/looking-for-retro-games-with-an-old-rigging-technique
— the thread text is bot-blocked to my fetcher; this is the search-index snippet, so treat the
quote as second-hand). The seam problem is stated well in a Quora answer on the same subject: "If
an arm is modeled separately from the torso, the seam will split or overlap awkwardly when the
character moves its shoulder" (https://www.quora.com/Why-do-video-game-3D-modelers-use-separate-meshes-for-a-characters-limbs-head-etc).

**Modern uses are not historical curiosities — they are two of the most-played 3D games in
existence.** Roblox's default rig is documented as fifteen separate parts:

> "R15 is the default avatar body and animation rig in Roblox, which has more joints than R6 and is
> able to bend. The model is named after the number of body parts it has (15 parts) instead of 6
> (R6)." … "The R15 avatar shares the same segments as Mario from Super Mario 64."
> — https://roblox.fandom.com/wiki/R15

That same page is also the clearest available statement of **what gives the technique away**:

> "Many people have complained that the gaps are too noticeable, or that they should be filled in…
> The joints' disconnecting also seems to be a problem. Also, on May 16, 2018, Roblox updated the
> R15 default, but it stretched down the blends, so when you're moving around, the gap was very
> noticeable."

So: the tell is the **joint gap** — a visible hole or an interpenetrating corner where two boxes
rotate past each other — and it appears at exactly the joints with the largest range of motion
(shoulder, hip, neck). The classic fixes are (a) a **separate joint mesh** (a ball/sphere at the
pivot, parented to the parent bone, that occludes the gap from every angle) and (b) **overlapping
the segments** so the child mesh starts *inside* the parent. The Tomb Raider PS1 rig, discussed on
Blender Artists, is a worked example of the first: "I'm trying to figure out how to deal with the
joint meshes that connect the body parts (neck, shoulder, elbow, etc). Those are the only parts
that are allowed to deform when the bones rotate."
(https://blenderartists.org/t/how-to-deal-with-joint-meshes/1258105)

Lara's original model was ~250 polygons for the whole character
(https://www.tombraider.com/news/merch/lara-crofts-iconic-low-poly-look-a-tubbz-tribute) — which
puts Web-Slinger's 252 triangles in exactly the historical envelope, and means **polygon budget is
not the binding constraint here; joint articulation is.**

The second tell is subtler and is not about geometry at all: with rigid segments, the *only*
expressive channel is joint angle, so any pose the angle set does not cover simply does not exist.
Segmented characters read as stiff not because the meshes are rigid but because the *pose graph*
is small.

### 2.2 Procedural pose generation for a swinging/flying character

**The canonical reference is David Rosen's GDC 2014 Animation Bootcamp talk**, "An Indie Approach
to Procedural Animation" (Wolfire Games) — free video at
https://www.youtube.com/watch?v=LNidsMesxSE, GDC Vault entry
https://www.gdcvault.com/play/1020583/Animation-Bootcamp-An-Indie-Approach, Game Developer's
write-up at
https://www.gamedeveloper.com/design/video-an-indie-approach-to-procedural-animation. The framing
sentence from Rosen, as quoted there:

> "We really need animation and code to work more closely together, so we can use the code to help
> offload repetitive tasks from the animators."

and the description: "how indie developers can use simple procedural techniques to achieve
interactive and fluid animations **using very few key frames**." That is the exact shape of what
`pose()` already is: a handful of pose constants blended by code. The talk's method — a small set
of extreme poses, blended by continuous game state, with IK correcting contact points — is the
upgrade path, not a replacement.

**The single most directly relevant source is Rosen's follow-up on a game whose entire verb is
swinging**: "The Procedural Animation of Gibbon: Beyond the Trees"
(https://www.youtube.com/watch?v=KCKdGlpsdlo; Game Anim listing
https://www.gameanim.com/2022/09/24/the-procedural-animation-of-gibbon-beyond-the-trees/). Gibbon
is brachiation — hand-over-hand swinging — animated procedurally from physics state with no clips.
I did not watch the video in this session, so I am citing it as the correct prior art to study
rather than paraphrasing its contents.

**Two-bone IK is the one analytic tool worth having**, and it is small. The law-of-cosines solver,
with a complete listing in both C++/Unreal and C#/Unity, is at
https://blog.littlepolygon.com/posts/twobone/ :

> "What makes this case simple is that, unlike many other problems in kinematics, there is an
> analytical solution! It's based on the Law of Cosines! Given the length of your arm bones (A & B),
> and the offset from your shoulder to your hand (C), we can compute the angle your elbow makes (θ)."

The core is `cosθ = (d² + upper² − lower²) / (2·upper·d)`, plus a pole vector to pick the plane. In
a two-DOF-per-joint rig this collapses to about fifteen lines. Note the author's arm-aiming
refinement, which is exactly the swing-arm case: "extend arm almost-full (99%) towards the target"
then rotate the whole chain so the forearm aligns with the aim direction.

Alan Zucconi's overview (https://www.alanzucconi.com/2017/04/17/procedural-animations/) is useful
for placing the options on a spectrum — ragdoll (no motor control, "highly unpredictable"), driven
rigid bodies (Grow Home, Rain World: end points moved by code, intermediate joints follow), and IK
(joints forced into a desired stance). Web-Slinger's determinism rule rules out the physics-driven
middle option unless the solver is deterministic and lives in the render path.

**Spring-damped joints are the cheapest large win, and the frame-rate-independent forms are
published.** Daniel Holden's "Spring-It-On: The Game Developer's Spring-Roll-Call"
(https://theorangeduck.com/page/spring-roll-call) is the reference implementation set; Alexis
Bacot's comparison (https://www.alexisbacot.com/blog/the-art-of-damping) is the shorter read and
makes the operative point:

> "a **damping function cannot be a fixed curve**. It's a math function trying to reach a goal in a
> smooth way, always adapting to what's happening in real-time."

and enumerates six variants, of which two matter here: the "simple damper (not spring related)
with rough & fast ease-in but great ease-out" — i.e. `x += (goal − x) * (1 − exp(−λ·dt))`, which
`js/game/cameras.js` already uses as `const damp = (c, t, l, dt) => c + (t - c) * (1 - Math.exp(-l * dt));`
— and the critically-damped spring, which "returns to the goal as fast as possible without extra
oscillation". Both are frame-rate independent. Overshoot is available and desirable for limbs:
Bacot notes the oscillating spring is "great for car suspension or fake ball physics", and limbs
trailing a body are precisely that.

**Secondary motion is the named animation principle and it has a rule that maps onto code.** From
Animation Mentor's treatment of follow-through and overlapping action
(https://www.animationmentor.com/blog/follow-through-and-overlapping-action-the-12-basic-principles-of-animation/):

> "Make sure the tail always feels like it's along for the ride. The tail should never lead the
> action of the block. The tail should never feel like it can exert any energy or motion of its own."

and, decisively for a torso/head/limb rig:

> "A common mistake in student work is the hips, torso, and head feeling like they are connected
> with a steel rod. This causes the entire trunk of the body to move at the same time and results
> in a very stiff feel. The torso and head should feel like they can overlap and drag depending on
> how the hips influence them."

Web-Slinger's hero is currently a steel rod: `torsoPitch` is a constant per state and the head is a
fixed fraction of it. A damped lag on torso and head against the root's own motion is the textbook
fix and is two springs.

### 2.3 Cheap skinning alternatives in WebGL2

The relevant numbers, from the WebGL2 Fundamentals skinning lesson
(https://webgl2fundamentals.org/webgl/lessons/webgl-skinning.html):

> "A character can have anywhere from 15 bones (Virtua Fighter 1) to 150-300 bones (some modern
> games)… most realtime skinning systems limit it [to] ~4 weights per vertex."

and on the uniform-array approach specifically:

> "if we were on a device with a limit of 64 vec4s we could only have 5 bones! Checking WebGLStats
> most devices support 128 vec4s and 70% of them support 256 vec4s but with our sample above that's
> still only 13 bones and 29 bones respectively. 13 is not even enough for an early 90s Virtua
> Fighter 1 style character."

Toji's older write-up makes the same point from the engine side: "Shaders have a limited number of
uniform variables that they can use at once, and since our matrices are being passed as uniforms,
we can eat that limit up quickly"
(https://blog.tojicode.com/2011/10/building-game-part-3-skinning-animation.html). The standard
escape is a **bone texture**: "A texture is better than a uniform array of matrices, because it is
much faster to load, and has less size restrictions"
(https://stackoverflow.com/questions/17203508/webgl-hardware-skinning-with-a-bone-texture).

Mapped onto this project, the four options rank like this:

| Option | Code size | New per-vertex data | Quality gain | Notes |
|---|---|---|---|---|
| **Status quo: per-segment mesh + per-segment draw** | 0 | none | — | 10 draws, 10 uniform sets. Already works. |
| **Single-bone-per-vertex, one mesh, matrices in a uniform array** | ~40 lines GLSL + ~30 JS | 1 float (`aBone`) — the vertex format *already has a spare float slot mechanism* (`data.mat`) | none visually; collapses 10 draws to 1 | With 10 bones = 40 vec4s, comfortably inside even a 64-vec4 device. But `glx.js` shares one `lit` program with the entire city; adding `uBones[10]` costs every draw's uniform budget. |
| **True 4-weight skinning** | ~80 lines + a weight-authoring step | 4 weights + 4 indices per vertex | fixes joint gaps genuinely | Requires authoring weights for procedurally generated boxes — i.e. writing a weight function, not just a shader. Real work. |
| **Vertex-texture skinning** | ~60 lines + a float texture path | as above | same as above | Only needed above ~29 bones. **Not applicable**: this character has 10. |
| **Morph targets** | ~30 lines | N extra position streams | good for *shape* (a bulging chest, a squash), useless for *rotation* | Wrong tool: limb rotation through 180° is exactly what linear vertex blending cannot express. |

**The conclusion for this project is that skinning is not the lever.** Ten bones is inside every
uniform budget the web has, which means the only reason to implement skinning is to eliminate joint
gaps — and joint gaps are cheaper to eliminate with geometry (a sphere at the pivot) than with a
weight-authoring pipeline. Consolidating the ten draws into one is a *performance* change, and at
252 triangles and 10 draws per frame against a city of 1.47 M prop vertices, the hero is not the
bottleneck.

### 2.4 Spider-Man's silhouette and readability

The best-sourced principle comes from Overwatch's lead artist Arnold Tsang, interviewed by Business
Insider (https://www.businessinsider.com/secrets-of-overwatch-character-design-2016-6). Two
components, in his order:

> "First of all, [we design] the body type… How much armor are they wearing? What's the size of this
> character?"

then — and this is the part a procedural pose system controls:

> "The running pose [is the next part of the equation] — so, the silhouette of the character holding
> the weapon and running around. We go into animation… and we try to **push the silhouette of that
> character running in the game to be as different as possible** from the other heroes so they stand
> out."

The article's summary: "Each character's silhouette is like their fingerprint… it's important for
players to be able to instantly recognize who they're fighting" — at a glance, from across a map.
For a third-person game with one character, the same logic applies against *the player's memory of
the character*, not against other heroes: the pose has to match the pose language the audience
already carries.

For Spider-Man specifically, Insomniac's senior art director Jacinda Chew, interviewed by Console
Creatures (https://www.consolecreatures.com/marvels-spider-man-2-jacinda-chew/), is explicit that
the comic source is deliberately *under*-specified and the game's job is to add material where the
comic has only colour:

> "In the comics, the suits are very, very simple. If you try to translate them directly, maybe
> everybody would be in spandex or Lycra, which doesn't make a lot of sense… the character team…
> spent a lot of time doing material research… making sure it looks like it would stand up to wear
> and tear but also look stretchy."

and on flat comic colour generally: "In the comics, everything looks like you have one colour and
it's very solid… Normally, it's just a colour and we have to fill in the blanks ourselves."

On the *pose* side, the strongest sourced claim about swinging readability is from the Game
Developer design analysis of Marvel's Spider-Man (Stanislav Costiuc,
https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis), which characterises the
feel the animation has to sell: "Spider-Man is like a floating drone that is attached to a swinging
rope" — the same phrase `js/game/hero-consts.js` already quotes for `SWING_STEER`. And on the
web-line as a readability element: the analysis is unequivocal that the cheats that keep the arc
continuous ("Spider-Man shortens the web if you get very close to the ground, allowing to avoid
breaking the flow") are what let the *silhouette* stay a swing rather than a fall.

**Honest limitation.** I could not find a design or art analysis that specifically treats the mask
lenses, the emblem or the colour blocking as readability devices at gameplay camera distance from a
professional/industry source. Everything I found on lens shape and size is fan commentary
(Instagram/Reddit/TikTok), and I have deliberately not cited it. The defensible claims are: (a)
silhouette + motion signature is the primary identification channel (Tsang, above); (b) the suit's
material, not its colour, is what game art has to add over the comic (Chew, above); (c) the
webline is a functional, load-bearing part of the swinging read (Costiuc, above).

### 2.5 What Insomniac actually did — and what is transferable

**What I verified.** From Digital Foundry's technical analysis
(https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis):

> "Spidey's suit stands out with superb texture work — the material reflects light properly and
> small details are visible throughout."

> "in-game, Spider-Man features an impressive range of animation applied to major and minor
> characters alike. Players have a lot of mobility and combat options, while **animation is smoothly
> blended, giving some degree of continuity to highly complex strings of attacks**. It's also
> exceptional while web-swinging through the city, to the point where it's fun to vary your style to
> see what kind of variation in animation you get — watching Spider-Man spin through the legs of a
> water tower was one example of **bespoke** animation you'll only get by experimenting with how you
> target your webbing."

From DF's downgrade piece
(https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-debunking-the-downgrade),
on the suit shading specifically — this is the single most transferable finding in the whole
research pass:

> "the main difference here stems from a change in suit material. **The E3 suit features more
> prominent specularity, and it's basically the difference between plastic and cloth. The final
> material is more diffuse in appearance while the E3 suit is extra glossy**, so even though the
> resolution of the suit material textures is identical, the way light behaves across its surface
> has changed."

> "When in shadow, the final game exhibits a softer, diffuse appearance which is arguably more
> realistic — the E3 demo simply appears overly shiny and more plastic-like in comparison. In direct
> sunlight, the E3 demo gives the impression of a suit covered in saran wrap while the cloth
> material in the final game exhibits more natural light dispersal."

Insomniac shipped a *less* glossy suit on purpose, and the shipped one reads as cloth. Web-Slinger
currently draws the hero at `roughness: 0.55, specular: 0.6` — glossier than "cloth", on the wrong
side of the line Insomniac chose.

Cloth was a first-class system: "One of the visual pillars of 'Marvel's Spider-Man' was to have
believable cloth-solutions… what challenges real-time cloth brought, **what cloth could and could
not be used for**" (GDC 2019 Technical Artist Bootcamp, Sophie Brennan,
https://gdcvault.com/play/1025663/Technical-Artist-Bootcamp-Real-Time). Chew confirms it was
expensive enough to be a fight: "One of the big ones was capes. That definitely got a lot of people
on the tech team shaking their fists at us."

Traversal is a separate system from animation and was iterated for usability, not fidelity, per the
GDC 2019 session abstract (Doug Sheahan,
https://gdcvault.com/play/1026422/Concrete-Jungle-Gym-Building-Traversal):

> "The talk will focus on how the swinging mechanic was originally executed and the process through
> which it evolved in order to increase usability and player engagement. This will include a
> discussion on the integration of additional mechanics as well as **how the camera was designed to
> increase the sense of speed, power, and enjoyment for the system**."

The animation talk exists (Robert Coddington, *The Animation of 'Marvel's Spider-Man'*,
https://www.gdcvault.com/play/1025971/The-Animation-of-Marvel-s) and the technical postmortem
exists (Elan Ruskin, https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man; free video
https://www.youtube.com/watch?v=KDhKyIZd3O8).

**What I could NOT verify — state this plainly.**

- **Bone count.** No published figure for Spider-Man's rig. I found none, in the DF articles, the
  GDC abstracts, or any secondary write-up. Do not put a number in code comments.
- **Animation layering specifics.** DF says animation is "smoothly blended"; nobody I could reach
  in text says *how* — additive layers, motion matching, blend trees, or anything else. The GDC
  animation talk is the place that answer lives and it is video behind the Vault; I did not watch it.
- **The postmortem slide deck.** Elan Ruskin's PDF export was posted at `crashworks.org/gdc19/`
  (https://x.com/despair/status/1109013313189404673). That path now **404s** and `crashworks.org`
  redirects to a Linktree profile. I could not retrieve the slides.
- **Postmortem content.** Per the GDC Vault abstract, the talk is about asset count, streaming,
  lighting, procedural city markup, pedestrians/traffic/crimes, the vertical slice and photo mode —
  **it is a world/pipeline talk, not a character-rendering talk.** `docs/PLAN.md` cites it under
  "Rendering", which is fine for the city work but it is not a source for character animation.

**Transferability, bluntly:**

| Insomniac did | Transferable to 10 rigid boxes in a browser? |
|---|---|
| Cloth simulation on capes/jackets | **No.** Costs a solver and a deformable mesh; the hero has neither, and a solver in the physics step would break determinism. |
| Diffuse, cloth-like suit shading | **Yes, and it is nearly free** — it is two numbers in `heroOpts`. |
| Blended, continuous animation across state changes | **Yes** — as damped angle interpolation, not as a blend tree. This is the highest-value transfer. |
| Bespoke traversal animations (spinning through a water tower) | **No.** Requires authored clips and contextual triggers. |
| Camera doing the work of selling speed and power | **Yes, and it is already half-built** (`cameras.js` has `roll`, FOV-with-speed, trauma shake). `docs/PLAN.md` §2.7 already schedules it. |
| Sub-surface scattering on skin | **No** — and irrelevant; the hero is masked. |

---

## Part 3 — Prioritized proposals

Ranked by visual payoff per line of code. Every proposal names its file and function, its effect on
the two size ratchets (`js/hero/hero3d.js` ceiling **240**, currently 191, so **49 lines free**;
`js/game.js` ceiling **460**, currently 440, so **20 lines free**), and its house-rule status.

House rules re-checked against each: no build step / native ES modules (all proposals are plain
edits to existing modules — none adds a file, so none needs a `tools/manifest.cjs` entry, an
import-map line or a modulepreload); determinism (nothing proposed is reachable from `hero.step()`);
effects in the render path only; `js/game/hero*.js` stays headless (only P4 touches `js/game/hero.js`,
and it adds one arithmetic line with no DOM).

---

### P1 — Make the lenses emissive. **2 lines. Highest payoff/line in the document.**

**File:** `js/hero/hero3d.js`, in `buildSegments()`'s head block.

```js
o._mat = 25;                                              // emissiveSurface
for (const s of [-1, 1]) box(o, [s*0.055, 0.15, 0.118], [0.075, 0.09, 0.012], LENS);
o._mat = 20;
```

**Why it works:** `lit.js` computes `emissive = emissiveSurface ? max(uEmissive, 1.0) : …` and then
`color = mix(color, albedo, emissive)` plus the bloom `glow` tag. Today the lenses get `0.10`; this
gives them `1.0`. In a night city where the key light is `sunColor: [0.12, 0.14, 0.22]` (faint
moonlight), the lenses become the one part of the character that is always visible — which is
exactly the readability channel Tsang describes, applied to the smallest possible geometry.
**Verified mechanism, not speculation:** the surface-id branch is present in this repo's shader.

**Ratchet:** +2 lines in hero3d (193/240). **Risk:** the lenses may bloom too hard; the amount is
already tunable per-draw via `heroOpts.emissive` for everything *except* id 25, whose floor is 1.0.
If that is too strong, use id 26 (`panelSurface`, `rough = max(rough, 0.72)`) for a matte white
instead and keep the HDR albedo.

---

### P2 — Fix the shadow: pose it, and cast four segments instead of one. **~6 lines.**

**File:** `js/game.js`, the `gfx.carShadowBegin` block in `render()`.

Move the `pose(...)` call *above* the shadow block, then:

```js
heroRoot(ix, iy, iz, ihead);
for (const s of ["torso", "thighL", "thighR", "head"]) {
  M4.mulTo(segWorld, rootMat, heroLocals[s]);
  gfx.castShadow(heroMeshes[s], segWorld);
}
```

**Why:** today the caster is an un-posed chest box sitting 0.38 m off the ground. A swinging hero's
shadow racing along a wall is one of the strongest "he is really there" cues in the genre, and
right now it is a floating brick that never changes shape. Four segments give a head-torso-legs
silhouette that changes between swing, dive and run. **Ratchet:** ~+4 net lines in game.js
(444/460) — tight but inside. If it does not fit, hoist the loop into a two-line helper next to
`heroRoot`.

---

### P3 — Damp the pose. **~18 lines. The single biggest quality change available.**

**Files:** `js/hero/hero3d.js` (`pose`), `js/game.js` (one scratch object).

Today `pose()` recomputes eleven angles from scratch each frame and snaps on every transition.
Change it to compute the same eleven as a *target*, and store the smoothed value in a caller-owned
state object:

```js
// hero3d.js
const KEYS = ["torsoPitch","legLA","legRA","kneeL","kneeR",
              "armLA","armRA","elbL","elbR","headPitch","lean"];
export function newPoseState() { const s = {}; for (const k of KEYS) s[k] = 0; return s; }

// at the end of pose(), before the setRotXZ/chain calls:
const lam = state === "ground" ? 22 : 14;          // s^-1
const k = 1 - Math.exp(-lam * dt);
for (const key of KEYS) ps[key] += (tgt[key] - ps[key]) * k;
```

with `pose(out, ps, state, t, dt, speed, extra)` and `game.js` owning `const posePS = newPoseState();`.

**Why this exact form:** `1 - Math.exp(-λ·dt)` is the frame-rate-independent simple damper — the
same expression `js/game/cameras.js` already uses (`const damp = (c, t, l, dt) => c + (t - c) * (1 - Math.exp(-l * dt));`),
and the one Bacot describes as having "rough & fast ease-in but great ease-out"
(https://www.alexisbacot.com/blog/the-art-of-damping). Fast ease-out is exactly right for limbs
settling into a pose. Different λ per state means the run cadence stays crisp while the swing
transitions flow. This is what DF means by "animation is smoothly blended", implemented as ~5 lines
rather than a blend tree.

**Determinism:** `pose()` runs in `render()`, never in `hero.step()`; `dt` is the render dt. State
lives in a plain object owned by `game.js`. No `Math.random`. Compliant.

**Ratchet:** ~+14 lines in hero3d (205/240), ~+2 in game.js (442/460, plus P2's +4 → 446). Both fit.
**Caveat:** angles that wrap (none currently do — `armRA ≈ -π` is a fixed constant, not a wrapping
value) would need `atan2` shortest-arc handling if a future pose crosses ±π. Add a comment saying so.

---

### P4 — Un-freeze the wall run. **1 line.**

**File:** `js/game/hero.js`, the `if (state === "wallrun")` block. Add `airT += dt;` at the top of
it (or change the later guard to `state === "air" || state === "swing" || state === "wallrun"` —
but that also enables air-steer during a wall run, which changes gameplay; prefer the explicit
increment).

**Why:** `pose()` receives `hero.airTime` for every non-ground state, and `airT` is never
incremented in `wallrun`, so `ph = t * 9` is constant and the legs hold one frame for the whole run.
**Headless rule:** one arithmetic line in a module that already has `airT`; no DOM, no renderer, no
randomness. `tests/unit/hero-swing.test.mjs` asserts behaviour, and `airTime` is exposed via `api`
so if any test pins wall-run `airTime` it will fail loudly, which is the correct outcome.
**Ratchet:** hero.js 355/380.

---

### P5 — Shade the suit like cloth, not like plastic. **1 line.**

**File:** `js/game.js`, `heroOpts`.

```js
const heroOpts = { roughness: 0.78, specular: 0.35, emissive: 0.04 };
```

**Why, with the source:** DF's downgrade analysis is a direct statement of the exact axis —
"The E3 suit features more prominent specularity, and it's basically the difference between plastic
and cloth. The final material is more diffuse in appearance while the E3 suit is extra glossy…
In direct sunlight, the E3 demo gives the impression of a suit covered in saran wrap while the cloth
material in the final game exhibits more natural light dispersal"
(https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-debunking-the-downgrade).
Insomniac moved *away* from gloss on purpose. `roughness: 0.55, specular: 0.6` is on the plastic
side of that line. Combined with P1, the contrast between a matte suit and hot lenses is the whole
read. **Ratchet:** 0 lines. **Caution:** verify against the night lighting — a matte suit under
`ambientSky: [0.034, 0.034, 0.049]` may go too dark; the compensating knob is `emissive`, and P1
makes the lenses independent of it.

---

### P6 — Add a yaw axis and aim the web arm at the actual anchor. **~14 lines.**

**Files:** `js/hero/hero3d.js` (`setRotXZ` → `setRotYXZ`, `chain`, `pose`), `js/game.js`
(pass `tetherYaw`).

Add a third angle to the joint helper (`M = T · RotY(ry) · RotZ(rz) · RotX(rx)`), thread `ry`
through `chain`, and in `game.js`:

```js
const tetherYaw = hero.anchor
  ? Math.atan2(hero.anchor[0] - ix, hero.anchor[2] - iz) - ihead : 0;
```

normalised to (−π, π], passed in `extra`; in the swing branch set the right shoulder's `ry` from it.

**Why:** `pose()`'s own doc comment already promises `extra: { tetherPitch, tetherYaw }` and only
half of it exists. Because `pickAnchor` deliberately alternates sides (`lastSide`/`bestSide`), a
large fraction of swings have the anchor off-axis while the arm points up the midline — and the
webline, which starts at the wrist, then leaves the hand at a visibly wrong angle. This is the
`FAnimNode_ArmAim` case from the two-bone IK write-up in its cheapest form: "extend arm almost-full
(99%) towards the target" then align the forearm to the aim direction
(https://blog.littlepolygon.com/posts/twobone/) — except that with a fixed-length arm and a target
40 m away, the IK degenerates to "point the arm at it", which is two angles and no solver.

**Ratchet:** ~+10 in hero3d (215/240 with P3), +3 in game.js (449/460 with P2+P3). **This is where
the budget starts to bind** — see the note at the end.

---

### P7 — Kill the joint gaps with pivot spheres. **~8 lines.**

**File:** `js/hero/hero3d.js`, `buildSegments()`.

Emit a small `Geom.addCyl` or an 8-segment ball at the origin of `upperArmL/R`, `thighL/R` and
`head`, parented to the child (so it rotates with the limb and always fills the socket):

```js
const joint = (o, r, col) => Geom.addCyl(o, [0, -r, 0], r, r * 2, col, 6, null);
```

**Why:** this is the documented tell of the whole technique. Roblox's own wiki records it as the
persistent complaint — "the gaps are too noticeable, or that they should be filled in… The joints'
disconnecting also seems to be a problem" (https://roblox.fandom.com/wiki/R15) — and the PS1-era
answer was a dedicated joint mesh at each pivot
(https://blenderartists.org/t/how-to-deal-with-joint-meshes/1258105). At 6 segments per cylinder
this is ~5 quads × 5 joints = ~120 extra triangles, roughly a 50% increase on a 252-triangle
character, which is nothing.

**Ratchet:** ~+8 in hero3d. **Sequencing note:** P3 + P6 + P7 together put hero3d at ~223/240. The
ceiling is a deliberate ratchet, not a cap — raising it is allowed with a reason in the commit
message — but do the arithmetic before starting, and note that the *second* test in
`module-size.test.mjs` fails if `ceiling − lines > 120`, so a raise must not be generous.

---

### P8 — Torso and head lag the root (overlapping action). **~6 lines, on top of P3.**

**File:** `js/hero/hero3d.js`, in the damped block.

Feed the *root's* yaw rate and vertical acceleration into two extra damped channels — a `lean`
(torso roll, needs P6's Y/Z work) and a head-lag — with a **slower** λ than the body, so they drag.

**Why:** this is the named principle, and the source states both the rule and the failure it fixes:
"A common mistake in student work is the hips, torso, and head feeling like they are connected with
a steel rod… The torso and head should feel like they can overlap and drag depending on how the hips
influence them", with the constraint that the follower "should never lead the action" and "should
never feel like it can exert any energy or motion of its own"
(https://www.animationmentor.com/blog/follow-through-and-overlapping-action-the-12-basic-principles-of-animation/).
Implemented as "same damper, larger halflife", it is free once P3 exists.

**Determinism / house rules:** the input is `ihead` and `hero.v[1]`, both read in `render()`.
Nothing enters the physics step.

---

### P9 — A web-pattern decal, or a fabric material id. **Two options; pick one.**

**Option A (cheap, ~1 line):** stamp the suit `_mat = 7` (`FABRIC`) instead of 20. The ported
`lit.js` gives FABRIC a real bump — `matBumpHeight`: `return sin(hc * 38.0) * 0.15 + sin(y * 38.0) * 0.15;`
— "woven cross-thread ridges", plus an albedo weave speckle in `applyMaterial`, and `matWallLike(7)`
is true so the pattern runs vertically on the body. **Cost:** it forfeits `classifiedCar`, so
`specular` falls back to `uSpecular` and the lens id-25 trick (P1) must stay on its own boxes.
**Risk not verified:** FABRIC keys its triplanar UV off *world* position, so the weave would swim
across the suit as the hero moves — the same "texture-swimming" problem `lit.js` calls out and
solves for car paint by keying to object space. Prototype before committing.

**Option B (the Apex 26 way, ~120 lines + a new module):** the web pattern as a **decal**.
`js/render/glx.js` here still exports `drawDecal(mesh, modelMat, tex, opts)`, and Apex 26's
`js/car/liverytex.js` + `js/game/carmesh.js` are the working precedent (a canvas-2D atlas of named
`REGIONS`, plus decal-quad meshes drawn over the painted body). This is the only way to get actual
webbing lines, which is a defining feature of the character's read. **But** it needs a canvas, so it
cannot live in `js/game/hero*.js`; it would be a new module (`js/render/suittex.js`), which means
`tools/manifest.cjs` + an import-map entry + a modulepreload + a `?v=N` bump, per
`CLAUDE.md`'s new-file checklist. **Verdict: real work, correctly deferred**, and it should be
scheduled explicitly in `docs/PLAN.md` §5 rather than smuggled in.

---

### P10 — Correct the arm colour blocking. **~3 lines.**

**File:** `js/hero/hero3d.js`, the arm loop.

Today `upperArm*` and `foreArm*` are both `RED` with `DK_RED` hands. The classic suit reads
red-and-blue with **blue upper arms** and red gloves; the current scheme flattens the upper body
into one red mass at distance. Making the upper arm `BLUE` and the hand `RED` restores the
alternation. **Payoff is genuinely uncertain** — I have no professional source that says which arm
blocking reads better at game-camera distance, only the general principle that the silhouette and
its internal colour division carry identification (Tsang, via Business Insider). Treat this as a
cheap A/B, not a fix. **Ratchet:** 0 net lines.

---

### Deliberately NOT proposed

- **GPU skinning of any kind.** Ten bones fits in every uniform budget the web has (128 vec4s on
  most devices, 256 on ~70% — https://webgl2fundamentals.org/webgl/lessons/webgl-skinning.html), so
  it buys no quality; the joint gaps it would fix are cheaper to fix with P7's geometry; and it
  would require authoring vertex weights for procedurally emitted boxes.
- **Morph targets.** Wrong tool for limb rotation.
- **Ragdoll / physical secondary motion.** Zucconi's summary of the failure mode is the reason:
  ragdolls are "highly unpredictable, and often result in accidentally hilarious behaviours"
  (https://www.alanzucconi.com/2017/04/17/procedural-animations/), and a physics solver anywhere
  near the hero risks the determinism rule that `tests/unit/hero-swing.test.mjs` pins.
- **Cloth.** See §2.5. No mesh, no solver, no budget, and Insomniac needed a dedicated tech-art
  effort for it (https://gdcvault.com/play/1025663/Technical-Artist-Bootcamp-Real-Time).
- **Authored animation clips.** Would need a data format and an authoring tool: a build step by
  another name.

### Suggested order

**P1 → P5 → P4 → P2 → P3 → P6 → P7 → P8**, then re-evaluate P9/P10.

P1+P5+P4 are four lines total and change the night silhouette, the material read and a frozen
animation. P2 and P3 are the two structural changes. P6 and P7 are where the hero3d ratchet starts
to bind — do the line arithmetic first, and if hero3d needs to pass 240, raise the ceiling in
`tests/unit/module-size.test.mjs` deliberately with the reason in the commit message, exactly as
that file instructs.

### Things I could not verify, collected

1. Insomniac's bone count, animation-layering scheme, and blend architecture — no text source
   reaches them; the GDC animation talk is video behind the Vault and I did not watch it.
2. Elan Ruskin's postmortem slides — `crashworks.org/gdc19/` 404s; the domain redirects to Linktree.
   The talk's abstract shows it is a world/pipeline talk, not a character talk.
3. Any professional analysis of Spider-Man's mask lenses / emblem / colour blocking as readability
   devices — everything I found was fan commentary and is not cited.
4. Polycount's segmented-rigging thread and the Medium character-readability article both blocked my
   fetcher; the one Polycount quote used is a search-index snippet and is flagged as such.
5. I did not run the game, take a screenshot, or run any test. Every claim about the current code is
   from reading it; every claim about how a change will *look* is a prediction. In particular
   P1's bloom strength, P5's darkness under night lighting, and P9-A's texture swimming are all
   unmeasured and should be looked at before they are believed.
6. I have not measured the hero's frame cost (10 draws / 252 triangles), so the "consolidating draws
   is not the lever" conclusion is an argument from proportion against the city's 1.47 M prop
   vertices, not a profile.
