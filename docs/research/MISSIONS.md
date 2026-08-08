<!-- Research pass on mission/content/progression design, 2026-08-08. Companion
     to SPIDER-MAN-PS4.md, which covers traversal, camera, combat and rendering.
     This one covers what the player does when they are NOT swinging, and what a
     one-developer procedural browser clone should build instead. -->

# Marvel's Spider-Man — mission, content and progression design

Labels: **[DEV]** developer-stated · **[PRESS]** journalist observation ·
**[COMMUNITY]** player/wiki consensus. Where sources disagree on a count, both
numbers are given. §8 lists what could not be sourced, so nobody re-derives it
as fact.

---

## 0. The sources that carry weight

Most writing about this game's open world is reviews and checklists. Five
sources are load-bearing:

1. **David Santiago (Principal Technical Artist), *Procedurally Crafting
   Manhattan for Marvel's Spider-Man*, GDC 2019** — the only hard content-volume
   numbers Insomniac published. **[DEV]**
   https://media.gdcvault.com/gdc2019/presentations/santiago_david_procedurally_crafting_manhattan.pdf
2. **Josue Benavidez (Design Director), GDC 2024, on Spider-Man 2's open
   world** — the single most useful talk for this project, because it is
   explicitly about *what to do when the player can fly and therefore skips your
   content*. **[DEV]**, reported:
   https://www.ign.com/articles/spider-man-2s-popular-fast-travel-system-almost-cut-gdc-2024
3. **Bryan Intihar interviews** (2018 Push Square, 2023 IGN postmortem). **[DEV]**
4. **Doug Sheahan, *Concrete Jungle Gym: Building Traversal*, GDC 2019** — video
   only, no slides published.
5. **The wikis and completion tables**, for counts. **[COMMUNITY]**

---

## 1. The activity taxonomy

### 1.1 The scale, and the number everyone misreads

From the GDC 2019 slides, verbatim: **[DEV]**

> 6 km × 3 km · 9 districts · 544 roads, 1202 alleys · > 8,300 buildings ·
> > 3,250 edifice prefabs · > 350 storefronts · **> 3000 crimes** ·
> **> 3000 vignettes**

**That ">3000 crimes" is the most important fact in this document.** The player
is required to complete **165**. Insomniac placed **>3000 crime setups** —
authored spawn sites with geometry, cover, spawn points and camera framing —
into the world as *markup*, generated and validated by the same procedural
pipeline that made the streets. A later slide confirms it: *"Even small change
cascades through many dependencies: UV continuity around block · Prop
positions · **Crimes** · **Vignettes**."*

So **the encounter is content; the encounter's location is procedural markup,
generated in bulk.** A crime is not a hand-placed quest. It is a slot. That is
exactly the shape a procedural clone can copy.

### 1.2 The table

Base 2018 game. "Required" = counts toward 100% district completion.

| Type | What the player does | Instances | One takes | Reward | Req? |
|---|---|---|---|---|---|
| **Crimes** | Arrive at a red triangle, fight 4-10 enemies of one of four factions | **165 required**; **>3000 placed** [DEV] | ~1-2 min | 1 Crime Token | ✅ |
| **Backpacks** | Fly to a marker, press a button | 55 | ~15 s | 1 Token + 25 XP | ✅ |
| **Landmarks** | Frame a real NYC landmark until the reticle greens, shoot | 47 | ~20 s | 1 Landmark Token | ✅ |
| **Secret photo ops** | Same, unmarked on the map | 50 | ~20 s | 100 XP, **no token** | ❌ |
| **Bases** | Fixed arena, optional stealth opener, then **six waves** | 19 (one table sums 17) | **10-20 min** | up to 3 Tokens | ✅ |
| **Research Stations** | A short scripted task, **usually pure traversal** — see §1.3 | 17 | **~5 min** | 2 Tokens + 100 XP; becomes a fast-travel node | ✅ |
| **Taskmaster** | Scored time trial: **Bomb** (traversal), **Drone** (traversal chase), Combat, Stealth — 4 each | 16 | 1-3 min | **Scaled 1 / 3 / 6** by medal | ✅ |
| **Black Cat** | Find a rooftop telescope, spot a plush on another building | 11 or 12 | ~1 min | 100 XP | ✅ |
| **Pigeons** | **Chase a flying pigeon through the city and catch it.** No combat | 12 | ~30-60 s | 1 Research Token | ✅ |
| **Side missions** | Short authored quests with VO | 16 | 5-15 min | XP, tokens | ✅ |
| **Surveillance towers** | ~15 s unscramble minigame; unfogs the district | 8 (disputed) | ~1 min | map reveal | ❌ |

**Total required activity instances for 100%: 358. 165 of them — 46% — are the
same repeated combat encounter.**

### 1.3 The Research Stations are the most transferable content in the game

Seventeen ~5-minute missions the fandom page describes as *"short missions
**often based on traversal mechanics**"*. Read as design templates rather than
lore, they are a complete catalogue of **combat-free, procedurally-seedable
traversal challenges**:

- **Smog Alert** — swing or fall through 8 marked volumes in the air →
  **gate/ring collection through free space**
- **Dive and Dash** — **free-fall 100 m before starting to swing; then 250 m** →
  **a measured dive test, i.e. a pure assertion against the hero's own state**
- **Bacteria Buddies** — cross the city to a distant target **without swinging
  at all** (climb, jump, zip only) → **a restricted-moveset challenge, costing
  one flag**
- **Reboot Times Square** — **20 targets, 20 s**, each hit adds time →
  **a combo system with no enemies**
- **Ventilate the Problem** — **15 vents, 45 s**, same structure, vertical
- **Data Chain** — align 8 dish towers *in sequence*, each adding time →
  **ordered checkpoint chain with a rolling clock**
- **Cell Tower Frequency** — reach rooftops while avoiding damaging sky volumes
- **Lightning Rod** — hop antennas while a hazard circle chases you

Only three of the seventeen (drone stealth, a spider-bot chase, a spectrograph
puzzle) need systems a clone will not have. **Roughly 12 of 17 need nothing but
the hero, the collider set and a timer.** This is the single highest-value
finding here.

### 1.4 Where sources disagree

Bases 19 vs 17; Black Cat stakeouts 11 vs 12; surveillance towers 8 vs more;
suits 28 / 45 / 47 depending on what is counted. None of it is material to the
recommendations.

---

## 2. How activities are surfaced

### 2.1 The mechanism

Three layers: **police radio dispatch** (diegetic audio — later made lore:
*"Spider-Man receiving his secondary objectives from the police radio
frequencies"*), **a world/minimap icon**, and **a player-initiated R3 scan**
that pulses and surfaces nearby crimes. The scan is the failsafe: *"sometimes
the dispatch won't mention it."* **[COMMUNITY]**

### 2.2 Density, and whether there is a director

**There is no public statement of a director system.** What exists:

- **>3000 placed slots against 165 required completions** [DEV] — an ~18:1
  ratio. Whatever picks among them is doing *selection*, not authoring.
- **Player-measured cadence** [COMMUNITY]: early/mid game ~**20-30 s** apart;
  late game **1-5 min**, typically 2-3; and **fast travel forces a spawn**
  ("crimes spawn a few seconds right after you fast travel"). That shape — rate
  falling as the district's requirement pool empties, plus a nudge on teleport —
  is consistent with *"pick a nearby unplayed slot, on a cooldown, weighted by
  what the player still needs"*. **That is an inference, not a dev statement.**

### 2.3 They did not avoid icon soup in 2018. They fixed it in 2023.

The 2018 [DEV] answer is *staged unlocking*, not density: activity types open on
named story missions. Intihar: *"as you progress through the story new
activities open up."*

The 2023 material is far better, and it is the most directly applicable design
input in this document. Benavidez at GDC 2024: **[DEV]**

> "We were working on this new fast travel… And **it totally broke our game.
> Because the map was fully revealed, you could go anywhere.**"
>
> "It was so detrimental that we considered cutting [it]… I eventually decided
> that, **no, the fast travel wasn't wrong. The game was wrong.**"
>
> The biggest challenge "was that **Spider-Man could functionally fly, meaning
> that players could effectively skip encounters.**" The goal was that players
> "**engage with the gameplay as they encountered it**" — likened to delivering
> cake: going straight to the bakery is boring; if you only know roughly where
> the cake is, you discover a coffee shop on the way.
>
> The fixes: new currencies; **greater emphasis on landmarks**; a **district
> progression system** *"to tie together all of the activities in a different
> area and give players a reason to stick around beyond finishing up
> collections"*; and layered pop-ups so players stop reading map icons.
>
> The success signal: "**We had a test where a player never opened their map.
> They just went to the top of a tall point and looked out.**"

Read that last line twice. Their stated win condition for a flying-traversal
open world is **the player navigating by looking at the skyline instead of
reading a map**. For a procedural city with no landmark art, that is a design
brief: **the world must be legible from a rooftop.**

They also **deleted surveillance towers entirely** in Spider-Man 2.

---

## 3. The token economy, and what it actually gates

**Six token types**, each earned from exactly one activity family, plus XP →
levels → skill points on a separate axis. **Three sinks:** suits (two-stage —
unlock at a player level, then buy with a token bundle), suit mods, gadget
upgrades.

**What it gates is almost nothing, and this is the part usually got wrong:**

- **Suits are cosmetic.** Once a suit power is unlocked it can be equipped with
  **any** suit. Buying a suit buys *one power*; the look is then free choice.
- **The skill tree fully completes.** 34 skills, 50 skill points by level 50.
  Every skill is affordable before the cap. There is no build — only an *order*.
- **Nothing in the token economy gates traversal at all.** Traversal upgrades
  live entirely in the skill tree, bought with skill points, which come from XP,
  which comes from everything.

**So the token economy is a completion ledger, not a difficulty gate.** Its only
real mechanical function is to **force breadth**: 165 Crime Tokens cannot buy a
suit that needs Base or Challenge tokens.

**Only one activity in the game pays on skill rather than completion:**
Taskmaster/Screwball, at 1 / 3 / 6 for Amazing / Spectacular / Ultimate.
Everything else is binary. Worth noting, because a clone with no combat has
*only* skill-scaled activities available.

**And they dismantled the economy over two sequels.** Miles Morales collapsed to
essentially one currency; Spider-Man 2 uses four split by *rarity* rather than
by activity type, shared across both characters, plus district progression.
**The trajectory is fewer currencies, less activity-type coupling, and a spatial
completion meter replacing a ledger. Start where they ended up.**

---

## 4. The traversal moveset — only five of 34 skills touch it

All five are in the Webslinger tree, all cost **1 point**:

| Skill | What it does to traversal |
|---|---|
| *(Swing Kick)* | combat only — but gates the branch |
| **Quick Zip** | web-zip a second time **without losing altitude** — makes zip chainable |
| **Point Launch Boost** | "massively boost Point Launch distance" — the fastest line in the game |
| **Air Tricks** | tricks for Focus and XP — a *risk purchase*, needs clearance |
| **Quick Recovery** | jump during the landing roll — removes the landing dead stop |
| **Charge Jump** | hold to charge, release for a standing leap — the cold-start move |

The other 28 are combat.

**The reference ships ~90% of its traversal unlocked at minute zero and gates
five cheap amplifiers**, of which the two most movement-changing (Quick Zip,
Point Launch Boost) are bought in the first hour or two. Intihar: *"we wanted
you to feel like a superhero right away."*

This **confirms** `PLAN.md` §5's rule — *"skill trees hold amplifiers, never the
moves that make the system fun"* — as an accurate description of the reference's
traversal design, and as a *correction* of its combat design, where the analyses
complain that throws and swing kicks are locked.

---

## 5. Missions and pacing

Weakest-sourced section, stated as such. Three Acts; activity types unlock on
named story missions, so **the story is the content valve**. Base game ~28 main
missions (derived from 44 total − 16 side, an inference). Spider-Man 2 is solid:
32 main, exactly three MJ missions, ~13 h main / ~30 h completionist.

Intihar's defence of the disliked non-combat interludes is worth keeping,
because it is a principle rather than an excuse: *"We've talked about **showing
the world from all different angles**… We knew we had to make her more of a
proactive, capable person. And if she's a little OP, I don't give a shit."*
**[DEV]**

And on what he is proudest of — note the honesty in it: *"I wrote a letter to
the people who reviewed Spider-Man 2 and basically **begged** them… Those little
stories really mean a lot to me because it shows the world doesn't need to be
ending."* **[DEV]** The studio's most-loved content is the content reviewers
skip, and it is loved *because of writing*. **That is exactly the category a
one-developer clone cannot buy.**

---

## 6. What this project should build, ranked

Constraints: no combat, no VO, no cutscenes, no authored geometry, everything
deterministic per seed.

### 6.1 What `js/city` can already seed, free

The generator deterministically produces a block grid with street/alley
topology, ~983 buildings each with an OBB in a spatial hash, `roofAt`,
`groundY`, `raycast`, `sphereClip`, three districts and 962 lamps. From that,
with no new art and no authoring:

- every rooftop as a node + roof-to-roof jump distances as edges → **a roof graph**
- street centrelines and intersections → **a ground course graph**
- the tallest building per sector → **landmark candidates**
- free space above the canyons → **ring placement**
- corners and ledges → **collectible anchors**
- district radius → **difficulty tiers**

Everything in tier (a) is a query over that plus a timer.

### 6.1a The verdict table

**FREE** = seedable today from what `citygen`/`colliders` already emit ·
**NEW DATA** = seedable, but the generator must persist something it currently
computes and discards · **SKIP** = needs authored content, art, writing or
out-of-scope systems.

| Activity | Verdict | What it needs from the generator | Effort |
|---|---|---|---|
| **Chase target** (pigeon) | **FREE** | nothing — a deterministic spline over the canyons + a catch radius | ~1 day |
| **Timed chained-target run** | **FREE** | sample points on OBB faces and roofs, both already queryable | 1-2 days |
| **Dive / air-time / restricted-move tests** | **FREE** | nothing — predicates over `hero.p` and `hero.v`; they double as regression tests | hours each |
| **Checkpoint race + ghost + medals** | **NEW DATA** | a **roof adjacency graph** (which roofs reach which, at what cost) so a course is provably completable with ≥2 lines. The OBBs contain it; nothing builds it | 2-3 days |
| **Photo-op landmarks** | **NEW DATA** | a **per-building distinctiveness score** (silhouette rarity, height percentile in its sector, isolation) persisted at emit time. `citygen` knows all of it and throws it away | 2-3 days |
| **Collectibles** | **NEW DATA**, barely | **ledge/setback extraction** — the massing library knows where setbacks are, the collider layer keeps only the whole-building OBB. Without it you can place on roof centres and corners, which reads as arbitrary | ~1 day |
| **District completion meter** | **FREE** | district radius already exists | ~1 day |
| **Perch/vista surfacing** | **FREE** | `raycast` line-of-sight already exists; this is a HUD feature | ~2 days |
| **Falling-person intercept** | **FREE** | roof-edge spawn, ballistic fall, catch radius — same maths as the chase target | ~1 day |
| **Vehicle-chase crimes** | **SKIP** | needs a traffic system; nothing emits roads-as-paths or vehicles | weeks |
| **Combat crimes / bases** | **SKIP** | AI, detection, navmesh, waves — and the six-wave hideout is the reference's most-criticised structure | months |
| **Surveillance towers / fog** | **SKIP — actively don't** | trivial to build, and *that is the trap*. Insomniac cut them entirely in 2023, and a 1.25 km² city renders in one view | ~1 day wasted |
| **Mementos, podcast, articles** | **SKIP** | procedural text reads as procedural text and cheapens the object | — |
| **Real landmarks, side missions, villains** | **SKIP** | recognition and writing cannot be generated | — |
| **Networked leaderboards** | **SKIP** (backend) — but **FREE** as a shareable seed + input-log URL | determinism makes a full run a few hundred bytes | ~half a day |

**Three things the generator should start persisting**, in payoff order:
**(1) a roof adjacency graph** — unlocks races and everything route-shaped after
them; **(2) a per-building distinctiveness score** — unlocks landmarks and
skyline legibility; **(3) ledge/setback surfaces** — unlocks collectible
placement that reads as deliberate.

### 6.2 Tier (a) — cheap and procedural. Build these.

1. **Chase targets** (the pigeon). A deterministic spline flown just below the
   hero's cruise; catch by proximity. **Insomniac shipped this twice** and it is
   the purest expression of "the content is the traversal". ~1 day.
2. **Timed chained-target runs** (20 targets / 20 s, each hit adding time). A
   combo system with no enemies — the failure mode is losing the rhythm, not
   losing a fight. ~1-2 days.
3. **Dive / air-time / restricted-move tests.** A predicate and a HUD line each.
   They interrogate the traversal model directly and **double as regression
   tests.** Hours each.
4. **Checkpoint races with ghosts and generated medals.** See §7.
5. **Photo-op landmarks.** The city has no Chrysler Building, but it can
   *manufacture* landmarks: the tallest per sector, or a rare silhouette draw,
   given a generated name. This is what makes the skyline legible from a
   rooftop — §2.3's stated win condition — and Benavidez named landmarks as one
   of the 2023 fixes. ~2-3 days; the framing scorer is the work.
6. **Collectibles**, easy and ubiquitous. ~half a day.
7. **District completion meter.** [DEV] rationale in §2.3. ~1 day.
8. **Perch/vista surfacing instead of map icons** — world-space markers visible
   only in line of sight. Replaces the whole fog/tower apparatus, which they
   themselves deleted. ~2 days.

### 6.3 Tier (b) — expensive. At most one, later.

Non-combat "crimes" need a verb on arrival; the only one that is both cheap and
good is **intercepting a falling person** (a timed 3D intercept that uses the
whole traversal model). **Bases/stealth outposts are a second game** and the
six-wave hideout is the most-criticised structure in the reference — do not
build it. A **second movement mode** (glide) is the one item here that increases
*feel* rather than content count. **Networked leaderboards** violate the
no-backend posture — but a shareable seed + input-log URL is the poor man's
version and costs nothing, which is exactly what a deterministic engine is for.

### 6.4 Tier (c) — impossible. Do not attempt.

Story, cutscenes, VO. The 84-episode podcast, 28 Bugle articles, 24 audio logs
and **55 hand-written backpack mementos** — the value of a backpack *is* a
paragraph of Peter Parker's diary, and procedural text will read as procedural
text and cheapen the object. **Ship the collectible without the memento.** Real
landmarks and real districts: recognition cannot be generated. Character side
missions — the content Intihar begged reviewers to play.

---

## 7. Is ghost racing enough?

**Honestly: no, not on its own — but it is the correct spine.**

Against: no shipped traversal sandbox retains players on a bare self-ghost.
Trackmania's retention is **the medal ladder plus a constant supply of new
tracks**, not the ghost. Mirror's Edge time trials run on **authored** routes
where shortcut discovery is most of the content, and a naive procedural course
has none. A self-ghost on a random course gives a target with **no ceiling to
compare against** and **no evidence a better line exists** — and both are what
drives repeat attempts.

For: determinism is already a hard invariant here, so a ghost costs an input log
and a replay path. Close to free. And **Insomniac's own most-replayed side
content in a game full of combat was a scored time trial** — Taskmaster's Bomb
and Drone challenges, the only skill-scaled payout in the 2018 game, which IGN
singled out as what *"kept me coming back for better scores."* **[PRESS]**

**The gap-closer, and why it is ours specifically.** What Trackmania buys with
an author medal and Mirror's Edge buys with level design is **a credible
ceiling**. Because our hero is deterministic and driveable headless through
`__spidey.act()`, we can **run a scripted policy through every generated course
at build time and compute the author medal**. That is not available to a studio
with a nondeterministic physics step, and it is the single feature that makes a
*generated* time trial as good as an *authored* one.

**The minimum viable loop, as a specification:**

1. **A generated course, not a random one** — seeded from the roof/street graph
   with a checked property (no leg exceeding the measured anchor range), and
   with **at least two viable lines** so a shortcut exists to be found.
2. **A generated par**, from running the deterministic hero through it under a
   scripted policy at build time. **This is the piece only a deterministic
   engine can do cheaply: you can compute the author medal.**
3. **Four medal tiers**, visible before the run. *The ladder is the retention
   mechanism, not the ghost.*
4. **Your own ghost** for moment-to-moment feedback, plus the **medal ghost** as
   the aspirational one. Trackmania's exact structure.
5. **At least three challenge verbs, not one.** Every source that shipped one
   verb (Just Cause 3's rings) got a grind complaint; the one that shipped four
   (Taskmaster) got "kept me coming back".
6. **A district meta-goal** so challenges tie to a place.
7. **Pay in medals and cosmetics. Never in movement.**

That last rule has hard evidence behind it. **Just Cause 3** locks gear mods —
including traversal mods — behind its 27 wingsuit challenges, and the community
reaction is consistently *"the Gear Challenges are ruining this game for me…
the game has turned into a grind"* **[COMMUNITY]**. Meanwhile Insomniac's
Taskmaster challenges are optional and IGN singled them out as the side content
that *"kept me coming back for better scores"*. **Traversal challenges are loved
as optional content and hated as a gate.**

Note also the ancestor: **Spider-Man 2 (2004)** — Fristrom's game, whose swing
model ours descends from — shipped city races, four collectible token types and
a store where Hero Points bought **traversal upgrades**. It *did* gate movement
behind an economy. The 2018 game did not. We follow 2018.

---

## 8. What could not be sourced

Recorded so nobody re-derives these as facts:

- **Any Insomniac statement about a crime director, spawn cadence, or
  icon-density target.** The §2.2 timings are player measurements from one
  forum thread.
- **Any Insomniac rationale for the six-token economy.** The critics are on
  record; the designers are not.
- **The fraction of playtime spent in traversal between objectives.** No public
  figure exists for any of the three games. Do not put a number on this — we
  have a deterministic hero and a headless harness, so measure it here instead,
  which is more than Insomniac published.
- **Slides for the *Concrete Jungle Gym* traversal talk.** Video only.
- Reliable counts for surveillance towers, bases, Black Cat stakeouts; the 2018
  main-mission count (~28 is an inference).
- **Frame-level or telemetry data of any kind**, for anything.
