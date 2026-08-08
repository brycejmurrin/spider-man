# docs

Three tiers. Know which one you are reading.

## Engineering reference — how the game works today

Read these before touching the subsystem they describe.

| Doc | Covers |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | The working reference: commands, conventions, file map, the dev API. Start here. |
| [`PLAN.md`](PLAN.md) | Why this project exists, what shipped, the phased roadmap, and the sources behind the design numbers. |
| [`TESTING.md`](TESTING.md) | Every suite, how to run them, and the three rules the browser half obeys. |
| [`CLONE-FIDELITY.md`](CLONE-FIDELITY.md) | How close to Marvel's Spider-Man this can get: the mechanics gap ranked by feel-per-effort, where being procedural *helps* (perch points and anchor tags are free), where it cannot, and — the half that saves the most time — **what is not reachable from a browser at all**. Synthesises the four research notes below. |

## Research — design notes still cited from source or from CLAUDE.md

The rule that keeps this tier honest: a research note stays only while
something in the code or in `CLAUDE.md` cites it. A note indexed by nothing
gets archived, because a document nobody reaches is a document nobody
maintains — and it will quietly stop being true.

| Doc | Covers | Cited by |
|---|---|---|
| [`SWING-FEEL.md`](research/SWING-FEEL.md) | Swing feel across the genre — Spider-Man 2 (2004) through Spider-Man 2 (2023), plus Just Cause, Gravity Rush, Bionic Commando, Titanfall 2 and Energy Hook. Momentum rules on release/re-attach/wall contact, perceived-speed levers ranked by cost, and what makes a swing feel *bad*. Argues the post-clamp velocity rescale is over-applied to a *shortening* tether. | `js/game/hero-consts.js`, `js/game/hero.js` |
| [`SPIDER-MAN-PS4.md`](research/SPIDER-MAN-PS4.md) | The design/tech reference for Marvel's Spider-Man (2018), with every claim split into developer-stated / community-measured / analysis — and a list of what it *contradicts* in `PLAN.md`. | `docs/PLAN.md` |
| [`HERO-MODEL.md`](research/HERO-MODEL.md) | Rigid-segment character animation with no skinning: procedural posing, cheap WebGL2 alternatives, and the joint-gap tell. Four defects in the current rig. **Its vertex counts are wrong** — see the correction at the top. | `js/hero/hero3d.js` |
| [`HERO-MODEL-PLAN.md`](research/HERO-MODEL-PLAN.md) | Second pass, and the one to act on. Measures the real builder (456 verts, not 504), settles the glTF and GPU-skinning questions with the spec text that decides them, finds a third option nobody had proposed (hard skinning at *bake* time), and names the single highest-impact change: a tapered `limb()` emitter with a rotation-invariant ball at each pivot. Two verified traps: `carPaint` is metallic flake, `MAT 7` swims. | `js/hero/hero3d.js`, `js/city/geom.js` |
| [`CITY-VISUALS.md`](research/CITY-VISUALS.md) | Why the city reads as flat colour blocks, measured. `emissive: 0.7` on the props draw replaces 70% of every building's shading with its raw unlit vertex colour; the window-pane grid caps make panes 2-6x real size; panes are 74% of all world vertices, so the "oversized panels" defect and the memory problem are the same defect. Also finds a collider bug: one OBB per building, using the base footprint for the full height. | `js/game.js`, `js/city/buildings.js` |
| [`DAYTIME.md`](research/DAYTIME.md) | What shipping daylight costs. The `night` flag exists but `buildCity(seed, {night:false})` has never once executed, and the day path has rotted in four specific ways. | `js/city/citygen.js`, `js/city/buildings.js` |
| [`ARCHITECTURE-CRITIQUE.md`](research/ARCHITECTURE-CRITIQUE.md) | An adversarial review: the city heap, the import-map claim, the headless-boundary regex, and the unreachable half of the ported renderer. | `CLAUDE.md` |
| [`PORTING-CANDIDATES.md`](research/PORTING-CANDIDATES.md) | What else in `../f1-game` is worth porting, what is not, and — most valuably — where the already-ported code has **drifted** behind fixes made there. | `CLAUDE.md` |

Two of the drift findings in `PORTING-CANDIDATES.md` were shipped as bugs the
day they were read (the stuck-hold-button nets and the service-worker precache
bucketing), which is the argument for keeping this tier at all.

## Archive — finished plans, kept for provenance

Nothing here yet. **Never read the archive for current structure.** It records
what was true when it was written, which is exactly what makes it useless as a
guide and valuable as a record.

---

Two conventions worth stating once:

**Numbers carry their measurement.** Where a comment in the code or a value in
these docs says "measured", the number came from a run, and the run is named.
A tuning constant without a reason is a constant nobody can safely change.

**Rules carry their failure.** Most of the rules in `CLAUDE.md` exist because
something broke in a specific, hard-to-reproduce way. The failure is recorded
with the rule so a future reader can tell a real constraint from a superstition.
