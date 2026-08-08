
# Marvel's Spider-Man (PS4, 2018) — what the source game actually does

Research reference for the Web-Slinger project. Every claim carries a URL.
Claims are tagged:

- **[DEV]** — stated by a developer of the game (Insomniac, or Jamie Fristrom
  for *Spider-Man 2* 2004), in a talk, support document, or AMA.
- **[MEAS]** — a community measurement or observation, not a developer
  statement. Treat the number as an estimate with the measurer's method.
- **[ANALYSIS]** — a critic's or designer's reading. Useful, not authoritative.

A note on scope: the project's own convention is "a number carries its
measurement". Applying that rule to the reference game, **almost no numeric
constant about Insomniac's Spider-Man is public**. Insomniac has never published
gravity, tether length, swing speed, or dodge-window values. What *is* public is
the *shape* of the systems — and, from the accessibility documentation, the list
of which knobs exist. That turns out to be the most useful thing found here.

---

## 1. Traversal

### 1.1 The constraint model, and who actually said it

The Web-Slinger hero controller implements "the Fristrom constraint method". The
primary source holds up completely. Jamie Fristrom (technical director and
designer, Treyarch *Spider-Man 2*, 2004) wrote it out:

> "So now imagine that your avatar is already attached by a virtual rope to a
> virtual point. As far as we're concerned, we can simply consider that an
> invisible circular or spherical wall. We can test collision by seeing if
> you've gotten too far away from the center of the circle, and pull the avatar
> back in." … "Now, the same velocity adjustment that made us slide along walls
> will also make us slide along the inside of this virtual circle or sphere."

**[DEV]** https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

The article also warns about exactly the defect the project caught and fixed
("the constraint was adding energy"):

> "videogames being the hacky things they are, you'll probably often find that
> your character's position snaps suddenly from one frame to the next in certain
> corner cases. When this happens, their velocity will go through the roof. My
> solution for that is simply a hack: check if their velocity gets too extreme
> and fix it if it does." **[DEV]** (same URL)

Note what this does *not* say: Fristrom's fix is a clamp, not the
rescale-to-pre-clamp-magnitude the project implemented. The project's fix is
better physics; the source game shipped the hack.

### 1.2 Anchor selection — raycast against collision geometry, and *more points is better*

The single most load-bearing developer statement about anchoring, from
Fristrom's AMA:

> "At first, we went through the level and added points which we thought would
> be good to swing from, like the corners of buildings etc. **Eric Pavone
> discovered that the more points he added, the more predictable, smooth, and
> fun it got.** So Andrei Pokrovsky implemented a system that just did
> raycasting against the physical geometry, and where the rays intersected,
> that's where the swinging happened." … "Energy Hook, like Spidey 2, works off
> the physics / collision geometry, not the vertices."

**[DEV]** https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/

And the aiming method in 3D:

> "Spider-Man 2 and Energy Hook cast rays out relative to the character, and
> where the rays intersect physical geometry that's the point where you attach."
> **[DEV]** https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

Insomniac's 2018 game is the same in kind: webs attach to real building
geometry, and the swing is a physics simulation — Insomniac said so publicly in
June 2017 and it was widely reported.
**[DEV, second-hand]** https://www.reddit.com/r/PS4/comments/6gx7tv/spiderman_ps4_swinging_is_all_physics_based_and/

Fristrom is explicit that he *dislikes* the alternative:

> "After that, I liked Web of Shadows a lot, but **I hated that you could swing
> from the sky again.** I get why they did it — it makes it more accessible."
> **[DEV]** (AMA URL above)

**Implication for Web-Slinger:** `ANCHOR_MAX: 55` (search ray length) and
`ANCHOR_MIN_UP: 6` are the right *kind* of rule. The one design instruction the
primary source gives that the project does not currently follow is Pavone's:
*density of candidate anchor points is what makes the swing feel predictable.*
The project's `TETHER_IDEAL: 24` selection heuristic is a good answer to a
question the source game answered by having more geometry to hit.

### 1.3 Ground-clearance auto-shorten — confirmed, mechanism and all

> "What if your avatar starts out in a low place and tries to swing? … A quick
> fix for that is to check how high above the ground the point they want to
> swing from is, and shorten the length of their tether so they'll clear the
> ground. You can't just shorten it over one frame though, because then they'll
> suddenly snap into the air — so here, having a `desiredLength` that's short
> enough to not touch the ground and a `currentLength` that rapidly approaches
> `desiredLength` will get you the clearance you want."

**[DEV]** https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

This is exactly `GROUND_CLEAR` + `SHORTEN_RATE`. The rate-limited approach is
specifically prescribed, not merely permitted.

Insomniac does the same thing, and a design analysis names it as one of the
three "physics cheats" that make the game work:

> "the last important physics cheat that Spider-Man utilizes, and the most well
> known probably, is that **Spider-Man shortens the web if you get very close to
> the ground**, allowing to avoid breaking the flow."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

### 1.4 Never stranded — the "special attach point"

Insomniac reportedly confirmed on Twitter that when Spider-Man is too low for
any legal anchor, the game synthesises one so the player cannot fail. The only
surviving trace is second-hand, in a widely-read community analysis:

> "**If there are no castable weblines that won't hit the ground, Insomniac's
> 'special attach point' will simply cast from a point that will swing above the
> ground.** The player's position now doesn't coincide with the cast position,
> as it normally would, so the player is teleported forward to the correct
> position, resulting in floatiness."

and, in the same thread:

> "they talked about it a few months before on Twitter, someone ask about …
> why the swinging was slow and linear; they said it was because Spider-Man was
> too close from the ground, then they explained that **they have special attach
> point for that, to prevent the player to fail**."

**[MEAS / DEV second-hand]** https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/

Two things follow for `ASSIST_Y: 14`. First, the mechanism is confirmed in kind.
Second — and this is the useful part — **the visible cost of that assist in the
shipped game was the single most-complained-about traversal artefact of 2018**:
the hero visibly slides/teleports to the synthetic cast position. If Web-Slinger
synthesises a high anchor, it should synthesise it *at the hero's actual
position*, not teleport the hero to the anchor's implied origin.

### 1.5 Release timing: why letting go beats holding

Confirmed by two independent guides, and the window they describe matches
`RELEASE_PEAK_LO: 0.09` (just past bottom) rather than "at the bottom":

> "The first is to let go of a swing when you're moving the fastest — **just
> after the lowest point** (remember the swingset above). If you let go here,
> you'll carry that momentum forward and into your next swing. **You need to
> wait until just after the lowest point in the swing so that you have a little
> bit of upward momentum, otherwise you're going to lose altitude and end up
> running along the sidewalk.**"
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17805410/swinging-traversal-point-launch-boost-skill/

> "If you want to go as fast as possible … release R2 when you're at the bottom
> of your arc, when you're closest to the ground. Your momentum will be
> conserved into forward velocity, rather than an upward swing… Or, if you need
> to get high sharpish, **let go at the top of a swing** to catapult Spidey high
> into the air."
> **[ANALYSIS]** https://www.gamesradar.com/marvel-spider-man-ps4-tips/

The reference game also lets you *add* a jump on release, and the jump's effect
is phase-dependent in the same direction:

> "When you let go of your web (by releasing R2) at the end of a swing, you can
> hit the X button to add a jump. The effect depends on which way you're moving
> when you let go. If you swing all the way through to the top of your arc and
> add a jump, you'll gain some extra height. If you add a jump at the bottom
> (the fastest) part, you'll add some horizontal distance and some speed."
> **[ANALYSIS]** (Polygon URL above)

A third guide describes the timing cue as an *animation* cue, not an angle:

> "you'll get the best boost if you jump just as **Spidey's legs come together
> and bend up in a right-angle to his torso** – launching any earlier than that
> will only slow you down."
> **[ANALYSIS]** https://www.redbull.com/us-en/marvel-spiderman-tips-web

That last point matters for Web-Slinger: the source game teaches the release
window through a **pose**, not a HUD element or an angle readout. The project's
`RELEASE_PEAK_LO/HI` is the mechanism; a hero pose that changes at
`phi ≈ RELEASE_MULT_MAX` is the missing *teaching* half.

### 1.6 Entry speed sets the swing, not the tether

> "The speed of your swing — how far you've backed up on the swingset — is
> determined by how fast you're moving when you start. So if you just stand
> still and jump straight up, your swing will be relatively gentle. If, however,
> you're sprinting or plunging straight at the ground when you start your swing,
> you're going to carry a lot more speed into it."
> **[ANALYSIS]** (Polygon URL above)

Community confirmation of the extreme case, which is why a speed cap exists at
all:

> "Since there's no 'webline snapping' at high velocities, and there's no
> stretching in the webline, you can gain *insane* amounts of speed by dropping
> from a great height… I jumped off the Chrysler building, and shot out a
> webline on one of the lower buildings on Lexington Avenue. The result? I was
> shot all the way across to Madison Square Garden, in a high arc that took me
> higher than the *Empire State Building*. … In previous games, this was simply
> dealt with by capping Spidey's maximum swing velocity (though if you remember,
> **the cap in Spider-Man 2 was very generous**)."
> **[MEAS]** https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/

This validates `VMAX: 66` + `OVERSPEED_DRAG` set above natural cruise: the dive
slingshot is the case the cap is for, and the source games kept it generous.

### 1.7 Point launch and zip-to-point — faster than swinging, *period*

> "Point Launching is when you use your webs to zip to a point — usually the
> corner of a building or a lamppost. These points are indicated on your screen
> by a small white circle. If you hit L2 and R2 at the same time, you'll use
> both hands to throw out webs and then perch on the point you're aiming at. You
> can even hold down L2 first to slow down time and aim more carefully." …
> "**If you hit X right when you hit your perch, you'll do a move called a Point
> Launch.**" … "**Point Launching is great for Traversing the city because it's
> faster than swinging. Period.** You're limited to the points that the city and
> the game provide for you, but you can cover a lot of distance quickly if
> you're careful."
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17805410/swinging-traversal-point-launch-boost-skill/

The timing rule again:

> "when using Zip to Point, you'll leap off your perch with more gusto **if you
> time your jump to the exact moment you land**."
> **[ANALYSIS]** https://www.redbull.com/us-en/marvel-spiderman-tips-web

Skill names, and their in-game text: `Point Launch Boost` — "Press X on contact
with point to massively boost Point Launch distance"; `Charge Jump` is the other
early must-buy.
**[MEAS]** https://www.neoseeker.com/spider-man-2018/faqs/3029648-marvel-spider-man-a.html ·
https://www.redbull.com/us-en/marvel-spiderman-tips-web

**Two design facts worth copying exactly.** (a) Aiming is *both triggers*, and
holding the aim trigger **slows time** — the game gives you a deliberate aiming
mode for the fast move. (b) Point launch is gated by world content: "you're
limited to the points that the city and the game provide". Web-Slinger's
procedural city can place perch points *densely and deterministically*, which is
strictly easier than the source game's authored problem.

### 1.8 The full move set is a *palette*, and mixing is where mastery lives

Insomniac's senior programming director on the design principle, stated for
*Spider-Man 2* but describing the 2018 system:

> "**we look at traversal as a cohesive whole.** As Spider-Man you have a huge
> palette of moves that you can do in traversal. Swinging is obviously a huge
> part of it, but there's also wall-running, and web-zipping, and
> point-launching." — Doug Shehan, Insomniac
> **[DEV]** https://www.gamespot.com/articles/spider-man-2-is-building-on-familiar-ideas-to-take-web-slinging-in-exciting-new-directions/1100-6517756/

> "Don't try and force a swing when a wall run is a better option, and learn to
> mix those up with Zip to Point (L2+R2) and the course-correcting Web Zip (X
> button). … **Using all four abilities together is where the mastery lies.**"
> **[ANALYSIS]** https://www.redbull.com/us-en/marvel-spiderman-tips-web

### 1.9 Wall run on collision — the "no dead stop" rule, confirmed

> "In addition to those physics cheats, what makes Spider-Man swinging work so
> well as a main basic traversal mechanism in the game is the fact that **you
> don't crash into walls, but automatically start wall-running on collision.**"
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

Fristrom lists the wall problem and its four known solutions, and Web-Slinger's
`WALLRUN_AUTO_V` is a fifth (auto-convert to wall run):

> "* Let the player steer in the air … * Play a cool animation … * Keep them off
> the wall: **Ultimate Spider-Man did this — if you got too close to a wall it
> would gently push you away from it.** … * Reward them for not hitting the wall
> in the first place: This is the Energy Hook strategy."
> **[DEV]** https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

### 1.10 Air steering — the quote in `hero-consts.js` is real, and it is Fristrom's

> "Let the player steer in the air: **physics doesn't have a lot to say about
> this but it somehow feels right.** That's one of the things we did in
> Spider-Man 2, and why you get a jetpack in Energy Hook."
> **[DEV]** (same URL)

The "floating drone" phrasing in `SWING_STEER`'s comment is *not* Fristrom — it
is the Game Developer design analysis, and it is about Insomniac's game:

> "if you do move with the analog stick, you can do so in any direction. Of
> course, trying to go directly the opposite way of where you were swinging to
> will make you lose momentum, but in general **Spider-Man is like a floating
> drone that is attached to a swinging rope**, you know. This lets the swinging
> still feel very physics-based, but also allow a great degree of control
> precision."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

### 1.11 Auto-straightening — confirmed, and Insomniac exposes it as a slider

The analysis states the behaviour:

> "if you just swing without holding any direction, **the game will adjust the
> arc of your swing to keep moving you as straight as possible.** So if you just
> jump and start holding and releasing R2, you will move in a straight line, as
> opposed to keep moving you from side to side which is what a truer to physics
> game would do."
> **[ANALYSIS]** (same URL)

And Insomniac's own accessibility documentation says what the knob *is* —
**resistance**, not a steering force:

> "**Steering Assistance:** Higher values allow for easier web-swinging while
> lower values reduce the amount of resistance and cause physics to have a
> greater affect on web-lines while swinging."
> **[DEV]** https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature

This is a direct, actionable correction for PLAN §2.1. The project's
auto-straightening is described as a "side-alternation weight" to be retuned.
Insomniac models it as **damping resistance on the web-line's lateral degree of
freedom**, monotonic in one scalar, and *shipped as a player-facing slider from
0 to max*. A resistance formulation is easier to make drift-free than a
weighting one, and shipping it as a slider means the 15°-drift target becomes a
default rather than a constraint on the model.

### 1.12 Tether line-of-sight — break / wrap / pass-through

The rule is real, is from *Spider-Man 2* (2004), and is stated by its author.
**The distances are not.**

> "**Tweaking the way your rope wraps can have a big impact on fun.** Suddenly
> wrapping around an outcropping can take the player by surprise and make them
> frustrated. **We had a three step solution in Spider-Man 2: if you were too
> close to the outcropping, the web would break; if you were in a middle
> distance, the web would wrap; and if you were far away, the web would just go
> through.**"
> **[DEV]** https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

The wrap is also the *stall guard* in *Spider-Man 2*, per community analysis —
which is a mechanism Web-Slinger currently solves separately with
`STALL_ANGLE`/`AUTO_RELEASE_PHI`:

> "it is theoretically possible to 'stall' yourself at a 90 degree angle on the
> webline… Ultimate Spider-Man solved this by preventing you from slowing down
> too much vertically, while **Spider-Man 2 had the web wrap as you went,
> preventing you from achieving a perfect 90 degree arc.**"
> **[MEAS]** https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/

Player experience of the wrap, worth noting because it argues for implementing
wrap *before* fiddling with the pump:

> "One of the things I always loved in SM2 was **wrapping a web around the
> corner of a building, which would shorten the length of web I was swinging
> from and give me a huge speed boost.**"
> **[MEAS]** (Fristrom AMA URL) — and Fristrom's reply, about Energy Hook:
> "**wrapping around lets you do some cool slingshoty whippy type stuff**"
> **[DEV]**

### 1.13 Speed envelope — what is actually known

This is the weakest area of public knowledge, and the project should treat every
number below as soft.

- **No developer figure exists** for Insomniac's swing speed. Searched
  extensively; Insomniac has published none.
- The most-cited community figure is a casual forum estimate of **~70 mph
  (~31 m/s) top speed** in *Marvel's Spider-Man*, offered without method.
  **[MEAS, low confidence]** https://www.reddit.com/r/Spiderman/comments/93h04b/spiderman_swing_speed/
- **Base swing speed increases with player level** in the 2018 game — a
  progression system, not a constant. **[MEAS]** https://www.redbull.com/us-en/marvel-spiderman-tips-web
- The game exposes internal tuning parameters that PC modders now edit by name,
  which tells us what the model *has*: gravity, a speed cap, "web tightening and
  extension and web-length", drag, jerk, wind resistance, and air-control
  authority. **[MEAS]** https://www.nexusmods.com/marvelsspiderman2/mods/657 ·
  https://www.nexusmods.com/marvelsspiderman2/mods/1016

The practical consequence: Web-Slinger's measured **42 m/s cruise / p50 53 /
p90 64** is very likely *faster* than the reference game, possibly by a factor
approaching two. That is not automatically wrong — a browser game with a smaller
city needs a shorter transit time — but the project should stop describing its
envelope as "the same envelope" as the reference (see §7b).

### 1.14 Charge jump, dive, air tricks

- **Charge Jump** is a purchased skill and one of the two highest-value early
  buys. **[MEAS]** https://www.redbull.com/us-en/marvel-spiderman-tips-web
- **Dive**: the game rewards diving to build entry speed before a swing, and
  waiting longer before the swing yields more speed ("if you're diving or
  falling, the longer you wait, the faster you'll be going … and that speed will
  transfer into your swing"). **[ANALYSIS]** Polygon traversal guide (URL above)
- **Air tricks**: "Hold Circle and Triangle while mid-air and you can perform
  some acrobatic forward, backward and sideways rolls between your swings. …
  those flips help fill the web head's Focus bar, letting you arrive at your
  next battle with special moves ready to go." **[ANALYSIS]**
  https://www.redbull.com/us-en/marvel-spiderman-tips-web
  Insomniac exposes it as `Air Trick Mode: Set Air Tricks input to HOLD or
  TOGGLE to perform tricks while swinging or gliding`. **[DEV]**
  https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature

**This is the direct confirmation of PLAN §2.6's design intent** (air tricks feed
the Focus economy). It is not a Phase-3 nicety in the reference game — tricks
are the *traversal-to-combat bridge*, which is why they exist.

---

## 2. Camera and perceived speed

### 2.1 The strongest single finding in this document

Insomniac's own accessibility documentation names the swing camera's three
speed-driven behaviours, in one line:

> "**Swing Camera Motion: Adjust the amount of roll, pitch, and field of view
> (FOV) changes while swinging.**"
> **[DEV]** https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature

For *Miles Morales* the same setting is documented more narrowly as "Swing
Camera Motion – Adjust the FOV when swinging". **[DEV]**
https://support.insomniac.games/hc/en-us/articles/46670895263635-What-Accessibility-options-does-Marvel-s-Spider-Man-Miles-Morales-feature

This confirms **PLAN §2.7 in full and from the developer**: FOV ramps with the
swing, the camera rolls into the swing plane, and it pitches. It also tells you
the shipped answer to the motion-sickness objection: make the whole thing one
0-to-max slider, and let a player who cannot tolerate it set it to zero. A
Web-Slinger `camMotion` scalar multiplying FOV delta, roll and pitch together is
a faithful copy of a shipped design, not an invention.

Related shipped camera assists in the same document, all **[DEV]**:

- `Camera Follow: Automatically rotate the camera behind Spider-Man while
  swinging or running.`
- `Camera Shake: Turns camera shake ON or OFF during gameplay`
- `Slow Corner Timescale: Slow game speed during corner transitions to reduce
  disorientation when whipping around a corner at high speeds.` — Insomniac
  explicitly acknowledges that high-speed corner whip is disorienting and ships
  a time-scale fix for it.
- `Motion Blur: Adjust the blurring effect created by camera motion and fast
  moving objects.`

### 2.2 Motion blur, tuned specifically for the swing

Digital Foundry, on the shipped implementation:

> "Insomniac's super impressive per-pixel motion blur — which might just be the
> best implementation I've seen to date. … **Most importantly, it's tuned for
> gameplay — while swinging through the city, edges of the screen and objects
> are properly blurred but the middle portion of the image remains sharp
> allowing players to see what's coming.**"
> **[ANALYSIS, expert]** https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis

That is a *radial* blur weighting — strong at the periphery, near-zero at the
centre. It is directly implementable in a WebGL2 post pass and it is cheap: one
extra term in the existing post chain, weighted by `smoothstep` on screen-space
radius times a speed scalar. **This is probably the highest perceived-speed
return per line of code available to Web-Slinger**, and it is the one that
survives at 30 fps (DF notes the game leans on motion blur specifically to avoid
"the hand-cranked feel you might otherwise get" at its 30 fps target — same URL).

### 2.3 What the community says about the camera

> "Whenever you increase speed a bit, the game camera pulls back a little,
> making you feel even faster."
> **[MEAS, low confidence — social video]** https://www.instagram.com/reel/Dbkjzq_BM49/

Community threads on FOV and perceived swing speed are numerous and consistent
in direction ("How an increase in FOV changes the perception of swinging
speed"), and the PC port's FOV slider is widely recommended as the single
setting that most changes how fast swinging feels.
**[MEAS]** https://www.reddit.com/r/SpidermanPS4/comments/16ti1os/how_an_increase_in_fov_changes_the_perception_of/ ·
https://www.sportskeeda.com/gaming-tech/marvel-s-spider-man-2-settings-need-change-playing

Counter-evidence worth logging: the combination is genuinely motion-sickening
for some players, and the named culprits are low FOV + 30 fps + motion blur
together. **[MEAS]** https://www.resetera.com/threads/spider-man-on-ps4-gave-me-severe-motion-sickness.658357/
A browser game running at 60 fps with a user-set FOV avoids two of the three.

---

## 3. Combat

### 3.1 Spider-sense is genuinely two-stage — and PLAN's description is right

The in-game skill description, quoted by Polygon:

> "**Press [Circle] just as your Spider Sense turns blue** to counter enemies
> with a Web Shot to the face. **Generates bonus Focus.**"
> **[DEV, in-game text]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17801264/perfect-dodge/

And the two phases spelled out:

> "**There are two phases to your Spider Sense's warning.** Think of it as an
> 'uh-oh' warning — something might happen soon — that starts as soon as you see
> the white halo appear, followed by a 'danger imminent' warning — someone's
> going to pull the trigger or throw a punch now. **The second phase starts a
> couple moments after the first and is indicated by a brighter, bluer, more
> distinct halo.** … You don't have to dodge the instant your Spider Sense kicks
> in, but you'd better be moving when your halo turns blue."
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/

So PLAN §4's "two-stage telegraph" is **confirmed in structure**. The specific
timings (T−0.55 s, 0.2 s window) are not published anywhere and PLAN already
labels them proposals — correctly.

The window is also a *tunable Insomniac ships to players*:
`Dodge/Parry Timing: Increases the dodge and parry window time.` **[DEV]**
https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature
— and in the 2018 skill tree, `Dodge Window` is a purchasable skill that "gives
you a slightly longer timing window to perfectly dodge an attack".
**[MEAS]** https://www.gamesradar.com/marvel-spider-man-ps4-tips/

### 3.2 Cancel-into-dodge and combo rules — both confirmed verbatim

> "**Absolutely every standard combat animation can be cancelled into a dodge**,
> which is great. Finishers can't be cancelled, but enemies don't try to hit you
> during those and the camera changes zoom and focus to hide that fact."
>
> "What is cool is that **combos end only when you're hit or when a lot of time
> passes without you hitting anybody, but it stays if you make a failed hit that
> doesn't do any damage.** Again, this is more in line with the feeling of
> Spider-Man."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

That is PLAN §4's first two bullets, near word-for-word. Same source also names
two smaller mercy rules worth stealing: picked-up grenades stop their timer, and
a grenade you threw cannot damage you.

### 3.3 Focus economy — how it actually works

> "In the top left corner of the screen, you've got your standard health meter.
> Below that, you've got a Focus Meter. **It fills as you land punches and as you
> land more hits in a row, but doesn't deplete if you take damage.** Your Focus
> has two uses — **Healing and Finishers.** At any point, you can press down on
> the D-pad to convert your focus into health. If you don't use it to heal, once
> your Focus Meter is full, you'll get the option to perform a Finisher…"
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/

> "Focus … is a gauge that is built by successfully landing melee attacks **and
> dodges**, and builds quicker by performing combos. **As the Spider-Men's Focus
> increases, the damage dealt by attacks also increases.**"
> **[MEAS, wiki]** https://marvels-spider-man.fandom.com/wiki/Focus

Focus is also earned *outside* combat:

> "you'll build Focus while swinging — Focus that you can use to heal"
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17805410/swinging-traversal-point-launch-boost-skill/

> air tricks "help fill the web head's Focus bar, letting you arrive at your next
> battle with special moves ready to go" **[ANALYSIS]**
> https://www.redbull.com/us-en/marvel-spiderman-tips-web

**The heal-vs-finisher tension is the whole economy** and it is explicitly framed
that way in the guide: "Deciding when to use a Finisher and when to heal is a
delicate balance." PLAN §4's "Focus spends on heal or finisher" is exactly right.

### 3.4 Air combat

The reference game strongly *encourages* air combat but no source states that it
pays more Focus:

> "**Get airborne**. Hold down Square during a punch to use your Air Launcher
> ability. This will launch your target up into the air… Once they're airborne,
> you can jump up and continue punching them out of the reach of their buddies
> (as long as they don't have, like, guns). **While you're up there, you'll have
> more options to dodge and web strike, too.**"
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/

The design analysis frames air combat as a *spirit* inheritance from the 2004
game rather than an economy:

> "it's actually much closer to the console Spider-Man 2 from 2004 combat in
> terms of spirit and principles. **It's based a lot on dodging, jumping around,
> and launching enemies in the air to do air combos.** The combat feels very
> fast-paced and sloppy, in a good way, you feel more improvisational like
> Spider-Man and not a perfectionist martial arts master like Batman."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

The *actual* reason air combat is strong is positional: it removes you from
melee reach of the ground crowd, and it costs you nothing because traversal
moves are all available in combat. See §3.6.

### 3.5 The gadget wheel criticism — confirmed, and the fix is named

> "One big caveat I would like to mention regarding combat though, is how
> gadgets are utilized. Insomniac wanted to promote gadget use and
> improvisation, but **the weapon wheel is so clunky that usually you just use
> the gadget that you had equipped when combat started. Also, changing gadgets
> midcombat can be very risky because the weapon wheel doesn't actually stop
> time, but just slows it down a bit, opening you up for attacks. If there's one
> thing that Spider-Man should've taken from Arkham, then it's the gadget
> shortcuts**, it would make the combat feel even better."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

PLAN §4's last bullet ("Gadgets bind to direct keys") is the exactly-prescribed
fix from the exactly-cited source. Note that Insomniac themselves eventually
conceded the point: *Spider-Man 2* ships **D-pad shortcut assignment** for
"Combat & Traversal Abilities / Abilities / Gadgets". **[DEV]**
https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature

### 3.6 Enemy archetypes and the four verbs

Sources agree on the archetype set and the verb each demands:

> "Use **Air Launcher (hold square) for baton enemies, Dodge Under (square, then
> circle) for shields, and web up heavies before attacking.** Using the right
> moves at the right time is vital." **[ANALYSIS]**
> https://www.gamesradar.com/marvel-spider-man-ps4-tips/

> "you'll want to take out **gun wielding foes as soon as possible**, as having
> to dodge bullets while fighting large groups is bothersome" (same URL)

> "Finishers … **best used against more powerful foes, such as brutes and
> enemies with riot shields. For brutes, finishers can only be used on them with
> two full Focus gauges.**" **[MEAS, wiki]**
> https://marvels-spider-man.fandom.com/wiki/Focus

So: grunt → combo; gunman → prioritise/disarm; brute → web up or double-finisher;
shield → dodge *under*. That is PLAN §4's four archetypes with sourcing, and the
"dodge *under*" verb PLAN assigns to the brute actually belongs to the **shield**
in the reference game. Small but worth correcting.

The one verb PLAN omits: **use your traversal moves as a dodge**.

> "The obvious way to dodge is to hit the Circle button, but this is a small
> movement and isn't really thinking like Spider-Man. The other way to dodge is
> to just get out of there. **You have all of your Traversal moves — like
> jumping, swinging, zip webbing, and point launching — during a fight.**"
> **[ANALYSIS]** https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/

For a project whose traversal is its strongest system, this is the cheapest
combat depth available: *do not disable traversal in combat.*

### 3.7 Targeting is automatic on purpose

> "**Do not pick your target — let the game do it.** … Punch someone until you
> complete a combo (four hits), then press Triangle. This will automatically
> pick your next target for you and even moves the camera around. … It takes a
> lot of the pressure off of you so you can focus on the hitting and dodging."
> **[ANALYSIS]** (same URL)

---

## 4. Open world structure

### 4.1 The consensus criticism

Wikipedia's summary of critical reception: "praised for its gameplay, graphics,
narrative, and characterization, but was **criticized for its familiar
open-world tropes and lack of innovation**."
**[ANALYSIS]** https://en.wikipedia.org/wiki/Marvel%27s_Spider-Man_(video_game)

IGN's verdict line: "**Occasionally stuck in a web of familiar open-world
trappings**, Insomniac's Spider-Man is still a spectacular adventure." (8.7)
And the specific complaint:

> "some were reused so often that I found myself running through the motions of
> scenarios I once found exciting. **The fourth or fifth time you figure out how
> to take on a horde of enemies committing a crime or fend off waves of enemies
> at an outpost is still entertaining — the fortieth is much less so.** It
> dilutes what starts as a fun, heroic act into a repetitive, going-through-the-
> motions activity that often had a knack for popping up just as I was making my
> way to a major story mission."
> **[ANALYSIS]** https://www.ign.com/articles/2018/09/04/marvels-spider-man-ps4-review

### 4.2 The collectible that never got old — confirmed, and it is a *specific* one

PLAN §5 asserts "the one collectible players never tired of was the one whose
collection *was just more swinging*". The source is the design analysis PLAN
already cites, and it names two:

> "The most enjoyable side content for me was, honestly, **the simple things like
> finding backpacks and catching pigeons, because it's pretty much based on
> swinging and swinging is always fun and fantastic, I never minded doing slight
> detours for a backpack because, hey, more swinging around!**"
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

Important qualification: this is **one analyst's opinion**, not measured player
sentiment. IGN's contrary note is that "finding landmarks and backpacks
encouraged me to hit every corner of the city, **the activity itself was pretty
easy**" — i.e. it is a *pleasant* collectible, not a *challenging* one.
**[ANALYSIS]** https://www.ign.com/articles/2018/09/04/marvels-spider-man-ps4-review

For PLAN's design bullet ("~10 per district, each placed where reaching it
*requires* a traversal move") this is a real tension: the reference game's
best-loved collectible was loved because getting there was *free and pleasant*,
not because it was a skill gate. Web-Slinger's version adds a difficulty
dimension the source game deliberately did not have. That may still be right —
Web-Slinger has no story to carry the player — but it is a departure, not a
copy.

### 4.3 The six-wave hideout slog — confirmed verbatim

> "Fights with random crimes are fine, but some scenarios with reinforcements and
> stuff make those really drawn out. And speaking of drawn out, **I stopped
> doing the hideout-type side-missions because they just take too much time with
> all that 6-wave gameplay.** What is especially weird about those is that they
> start you in a stealth state, and will make you instantly detected if you're
> being too good at taking out enemies stealthily."
> **[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

### 4.4 Skill trees hold the fun — confirmed, and it is a stated criticism

> "a lot of things that make the combat really enjoyable and experimental are
> **locked behind the skill tree. Like throws and swing kicks and some other
> things. I really don't think it would've been an issue to have them available
> from the start** so players could experiment more with the combat from the get
> go." … "a lot of skills that you have to unlock, Spider-Man does in cutscenes
> long before the availability."
> **[ANALYSIS]** (same URL)

Also: "the separation into three skill trees is incredibly arbitrary here. It
doesn't really define a style." (same URL)

### 4.5 The towers — PLAN's characterisation is *overstated*

PLAN §5 says: "Skip the tower-climb trope; **it was the most-criticised
structure** and it does not earn its cost."

What the sources actually support:

- The towers exist and are map-unfog gates. They are **not climbs** — they are
  a short signal-unscrambling minigame; the *travel to them* is the content.
  **[MEAS, wiki]** https://marvels-spider-man.fandom.com/wiki/Surveillance_tower
- They are named among the tedious standard-issue content, alongside backpacks:
  "Many of them are the standard open world fare and can feel a bit tedious,
  **like synching up to Oscorp towers for map info, finding backpacks**, or…"
  **[ANALYSIS]** https://www.cgmagonline.com/review/game/spider-man-ps4-review/
- **The design analysis that supplies most of PLAN's other open-world claims
  does not mention towers at all.** Its named villains are the *hideout waves*,
  the *token economy*, the *science puzzle minigames*, and the *MJ stealth
  sections*.
- IGN's review does not single out towers either; its named complaints are
  repetition of crimes/bases and the Peter puzzle minigames.

So: towers are *a* criticised element, but "the most-criticised structure" is not
supported. The most-criticised structures, by weight of sources, are **the
wave-based hideouts** and **the mandatory non-Spider-Man stealth missions**.
PLAN's *conclusion* (don't build towers) is still fine — a fog-of-war unfog gate
is pure friction in a 1.25 km city that renders in one view — but the
*justification* should be corrected.

### 4.6 What was actually praised

- The core traversal, unreservedly, everywhere.
- District character: "Neighborhoods have distinct enough character to be
  discernible as I swung from one to the next." **[ANALYSIS]** IGN (URL above)
  — this supports PLAN's "3-4 districts with distinct height profiles".
- The handful of *authored* side missions: "The brilliance of what the world
  could have been can be seen in a handful of brilliant side missions." IGN.
- **Photo mode**, which Insomniac describe as an accident that turned out to
  matter — see §5.5.
- Combat challenges (Taskmaster's) "kept me coming back for better scores" —
  IGN. Supports PLAN's "traversal time trials" bullet as a cheap, well-liked
  format.

---

## 5. Technology (GDC 2019 postmortem + Digital Foundry)

Primary sources: Elan Ruskin, *"Marvel's Spider-Man": A Technical Postmortem*,
GDC 2019 — https://www.youtube.com/watch?v=KDhKyIZd3O8 ·
https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man ·
talk description at https://80.lv/articles/marvels-spider-man-a-technical-postmortem
The most detailed public write-up of its numbers is a Chinese-language summary
of the talk: https://vitalight.me/archives/spider-man-console-game — numbers
below are attributed to that summary of the talk. **[DEV, via summary]**

### 5.1 Streaming, and the swing-specific problem

- The city is divided into **rectangular tiles**, but intersection tests use
  **circles** to cheapen the maths. Moving one tile normally requires loading
  ~5 neighbours.
- Spider-Man's speed multiplies the I/O demand. **The fix: only load the ~3
  tiles directly ahead**, because players move approximately in straight lines.
- That is safe because **turning takes Spider-Man about 1 second**, which is
  ample for the async loader to re-plan.
- **Delayed loading**: at swing speed the screen is motion-blurred anyway, so
  only the blurriest mip level is loaded up front; finer mips and street-level
  shop interiors are deferred.

**Relevance to WebGL2:** *high, in principle, none in practice yet.* Web-Slinger
generates its city procedurally at boot in ~2 s and holds it in memory; there is
no streaming. But the **"load ahead along the velocity vector, not radially"**
insight and the **"1 second to turn is your loading budget"** framing are exactly
the right shape for PLAN §6's "chunked or worker-driven generation to grow past
1.25 km²". When that work happens, generate the 3 chunks ahead of the velocity
vector, and use the measured turn time as the deadline.

### 5.2 Disc size — the anti-duplication pass

- PS4's mechanical drive rewards sequential reads, so the studio's habit was to
  **duplicate** shared assets into every tile. New York broke the Blu-ray budget.
- The reversal: **CPU was plentiful, space was not**. Stop duplicating (a) files
  eligible for delayed loading, (b) files over 4 MB, (c) files duplicated more
  than 400 times.
- Mesh index buffers were rewritten as **deltas** (`74, 75, 76` → `74, +1, +1`),
  which compresses far better under LZ4: **~20% smaller model files.**

**Relevance to WebGL2:** the *specific* technique is irrelevant (no disc, no
LZ4-on-console), but the **Revisit Speed-Space Tradeoffs** moral maps directly
onto Web-Slinger's own hard constraint (PLAN §6: 6 MB / 3.7 s converts 72% of
visitors, 40 MB / 29.5 s converts 50%). Procedural generation is the browser
analogue of "don't ship the duplicate" — it is the same trade taken further.

### 5.3 Rendering the whole skyline

- **Imposters**: lightweight distant buildings — minimal data (transform + mesh)
  and a simplified pipeline with **no UVs and no normals**, relying on offline
  baking.
- **Hibernates**: rooftop clutter (solar panels, chimneys, water towers). There
  are **~600,000** of them. At 384 bytes each that would be **230.4 MB** of
  memory for object records alone. Stripped down — e.g. position stored as a
  **16-bit offset from the tile centre** — each becomes **40 bytes**, total
  **24 MB**. They promote to full game objects when the player gets close.

**Relevance to WebGL2: very high, and directly applicable.** This is precisely
PLAN §6's "LOD that drops facade furniture beyond ~250 m and keeps an emissive
speckle". Two concrete transfers:
1. **The no-UV/no-normal imposter pipeline is already Web-Slinger's material
   model.** The ported Apex 26 renderer keys PBR off a per-vertex material id in
   a texture array rather than UVs. Distant buildings therefore need *no* extra
   pipeline — they need a lower-poly silhouette and the same MAT ids.
2. **The hibernate record layout is the answer to rooftop clutter at city
   scale.** Web-Slinger already has `CityGraph` instancing (85,484 nodes from 3
   models on seed 42). A 40-byte-equivalent record — tile-relative 16-bit
   position, 8-bit model id, 8-bit yaw — lets rooftop props scale by an order of
   magnitude inside the same instancing graph.

### 5.4 Lighting — the finding that should change Web-Slinger's plan

- **Environment probes were going to cost 8 GB baked.** Same speed-vs-space
  reasoning: **generate them at runtime, asynchronously, when the player enters
  a new area and spare compute exists, with caching. Zero disk cost.**
  **[DEV, via summary]** https://vitalight.me/archives/spider-man-console-game
- Digital Foundry on what shipped: reflections are "of the cube-map variety,
  **transitioning between samples depending on height**", with screen-space
  reflections added for ground-level puddles.
  **[ANALYSIS, expert]** https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis
- **There is no real-time time-of-day transition.** "similar to InFamous Second
  Son, Spider-Man does not feature a real-time TOD transition. Instead, changes
  in time are tied to story events, with **a limited number of pre-baked
  lighting configurations**. I'd imagine this choice was made to support
  improved scene illumination — while it's possible to blend between different
  pre-calculated light passes (as seen in Horizon Zero Dawn), it's not always
  optimal and may not have worked well in a large urban environment." (same URL)

**Relevance to WebGL2: high, and it is a caution.** PLAN §6 lists "day/night
cycle" as a scale-and-polish item. **The reference game, on dedicated console
hardware, decided a continuous TOD cycle in a large city was not worth it and
shipped discrete baked configurations instead.** Web-Slinger should ship a small
set of discrete, hand-tuned lighting states (the sibling project's
`LightStore`/`LightPresets` five-layer resolution is literally this design
already) rather than a continuous cycle. That is a plan simplification, not a
compromise.

The runtime-probe finding cuts the other way and is encouraging: probe
generation on idle frames with caching is well within a WebGL2 budget, and the
ported renderer already has an env probe.

### 5.5 Crowds and NPC AI LOD

- Pedestrians run a **very lightweight AI by default**. Roughly **every 30
  seconds one nearby pedestrian is promoted to a "Full AI Bot"** and picks a
  random interaction: photo/autograph with the player, reporting a crime,
  pointing the player toward a nearby point of interest.
- Far or occluded pedestrians have **animation and AI suspended entirely** and
  merely translate randomly in place to preserve the illusion of motion.
  **[DEV, via summary]** https://vitalight.me/archives/spider-man-console-game
- Stated design premise: "if it moves in a game, some player will try to
  interact with it."

**Relevance to WebGL2: high and cheap.** "One promoted actor every 30 s within
radius, everyone else is a translating billboard" is an implementable crowd
system for a browser game and is the mechanism behind PLAN §4's crime-event
cadence ("one within 300 m every 45-75 s"). The reference game's promotion
interval (30 s) is in the same order as PLAN's proposed crime interval — worth
noting they solved the same "how often does the world address you" problem with
a similar number.

### 5.6 Photo mode

Built as a token feature so the studio could say it had one; it grew "one
volunteer contribution at a time" once the team saw players sharing selfies,
scenery and even bugs, and became a major source of organic exposure. Filters
and decals followed.
**[DEV, via talk description]** https://80.lv/articles/marvels-spider-man-a-technical-postmortem ·
**[DEV, via summary]** https://vitalight.me/archives/spider-man-console-game

Web-Slinger already has the two prerequisites — a free camera and deterministic
`place()`/`snapCam()` — so a share-image mode is nearly free and is the cheapest
distribution lever available to a browser game.

### 5.7 The four morals Insomniac drew

1. **Simple is Good** — a simple implementation has lower cost and higher
   extensibility; don't reach for the fancy method when the simple one works.
2. **Fit Tech To Context** — nearly every optimisation was bespoke to this
   game's specific situation, which is why an innovative game wants its own
   engine.
3. **Revisit Speed-Space Tradeoffs** — the traditional trades stop holding as
   scale grows.
4. **If There's No Fun Then What Is Even The Point.**
**[DEV, via summary]** https://vitalight.me/archives/spider-man-console-game

### 5.8 Image quality, for reference

Temporal injection (not checkerboard); dynamic resolution scaling; PS4 Pro
observed range **3456×1944 down to 2560×1368**, averaging about **1584p**; base
PS4 sustains 1080p; **30 fps target on both**.
**[ANALYSIS, expert]** https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis

Also of note for a facade-heavy renderer: **modelled interiors behind windows**,
"achieved quite cheaply … for the most part we're looking at 'box' instances with
simple textures on each visible plane" (same URL). This is the interior-mapping
parallax trick and it is one shader function in WebGL2 — a strong candidate for
Web-Slinger's curtain-wall facades, which currently use lit-window emissives.

---

## 6. What Insomniac changed afterwards, and what that implies

### 6.1 Web Wings and wind tunnels (Spider-Man 2, 2023) — and the balance rule

Insomniac's stated design problem and solution:

> "**Swinging is the core of our Spider-Man traversal, so we designed the Web
> Wings to work with swinging and complement it.** That way you can weave back
> and forth between the two to build up speed and height. When you use the Web
> Wings with our wind tunnels, though, that's one of the ways to go across the
> city super-fast and really push the speed of traversal, which was one of our
> goals." — Ryan Smith, senior game director
> **[DEV]** https://gamingbolt.com/marvels-spider-man-2-devs-reveal-new-open-world-and-traversal-details

And the mechanism that stops the new move from eating the old one — this is the
most transferable single paragraph in the whole sequel coverage:

> "It was really, really important that we made sure that effective use of the
> web wings was getting it so that people were more integrating them into the
> rest of their traversal and using them **opportunistically, as opposed to
> using them exclusively.** People can [use them exclusively], but **the side
> effect of that is if you just use them and try to glide for a long way you're
> going to slow down a lot. The only way to get there fast is to dive and to
> shed height**, and then we're getting you into integrating everything else and
> you use swinging to really build that speed back up, fling yourself up in the
> air, glide a little further, go around a building, engage with point launch,
> fire off of that swing again, use the web wings again." — Doug Shehan
> **[DEV]** https://www.gamespot.com/articles/spider-man-2-is-building-on-familiar-ideas-to-take-web-slinging-in-exciting-new-directions/1100-6517756/

**The rule generalises:** every traversal move should *bleed* the resource the
other moves *build*. Gliding trades altitude for distance and loses speed;
swinging trades altitude for speed. Web-Slinger's `ZIP_BOOST`/`ZIP_COOLDOWN` is
the same idea (a cooldown enforces integration) but a *speed-bleed* is a better
mechanism than a cooldown — it teaches rather than blocks.

Also new in 2023: a **slingshot launch** (webs to two surfaces either side, then
fire yourself upward) — a cheap, high-drama accelerator worth stealing.
**[ANALYSIS]** (GameSpot URL above)

Community reaction is a genuine warning, though:

> "The web wings although fun just made traversal way too easy and much faster.
> The speed of web wings + wind tunnels made the swinging feel slow"
> **[MEAS]** https://www.reddit.com/r/patientgamers/comments/1s6n3dz/theres_something_missing_in_the_traversal_of/

So the balance rule was stated but arguably not achieved. If Web-Slinger ever
adds a glide, the bleed must be aggressive.

### 6.2 Miles Morales (2020) — subtraction as design

- **Venom Dash** lets Miles regain momentum mid-air, up to 3 times in a row — an
  air-recovery resource that stacks with swinging. **[ANALYSIS]**
  https://leolesetre.medium.com/spider-man-vs-miles-morales-a-game-design-study-c63223272c92
- **Gadgets cut from 8 to 4**, and the circuit-remapping puzzle minigame removed
  entirely. The analyst's conclusion: "**All this results in a more consistent
  and focused experience relying on a recurrent set of controls and abilities
  without the additional cost of complexity.**" (same URL)
- Finisher generation changed from a meter to a **combo count**: Miles builds a
  Finisher "by landing fifteen hits on enemies uninterrupted", with skills
  banking a 2nd and 3rd at +10 hits each.
  **[MEAS, wiki]** https://marvels-spider-man.fandom.com/wiki/Focus
- *Spider-Man 2* tightened it again: healing there "requires a full Focus bar"
  rather than any amount. (same URL)

The trend across three games: **fewer gadgets, fewer minigames, tighter Focus.**
That is a strong endorsement of PLAN §4's four-archetype / direct-key-gadget
plan and of Miles-style subtraction generally.

### 6.3 What Insomniac has said they'd change

Insomniac have not published a "what we'd do differently" list for 2018. The one
clear on-the-record admission is about the Mary Jane stealth missions, from
senior creative director Bryan Intihar:

> "**We had two choices. We could say, 'All right, we'll make it easy and just
> not do it.'** And everybody would go, 'Great. No MJ missions.' Or we could
> say, 'Hey, we've talked about showing the world from all different angles.
> We're going to make her moments better. We're going to take on the challenge.
> We're going to make people like playing as her.' … **We knew we had to make
> her more of a proactive, capable person.**"
> **[DEV]** https://www.ign.com/articles/our-big-spider-man-2-postmortem-interview-10-things-we-learned

I.e. Insomniac acknowledge the 2018 forced-stealth sections were poorly received
and their stated fix was *give the powerless character real verbs*, not remove
the section. The design analysis's independent diagnosis was the same: instant
fail on detection plus linear levels plus almost no tools.
**[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

Intihar also made the case for **small, authored, non-combat side content** over
volume — he wrote to reviewers asking them to play the Friendly Neighborhood
Spider-Man app quests and the Brooklyn Visions ones, saying "These side missions
aren't the longest things in the world, but they show that you have to be a hero
at all times and for all different people." **[DEV]** (same URL)

Fristrom's own long-running position, worth putting alongside all of the above,
is that accessibility pressure is what erodes swing depth:

> "When millions of people see a Spider-Man movie and then buy a Spider-Man game
> to go with that movie, most of them don't want to learn a challenging swinging
> system. **They just want to push a button and be Spider-Man.**"
> and on the Coke/Pepsi analogy for focus-tested easy swinging: "somebody new
> coming to the system will be like 'Yeah, look how cool and badass I am right
> out of the gate!' but after playing it for a while will be like, 'Okay, I'm
> bored now.'"
> **[DEV]** https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/

The 2018 game's own analyst reached the matching verdict: "If there's one
criticism I have about Insomniac's swinging system is that even with those
elements, **the skill ceiling is pretty low.** I think in sequel more additional
mastery mechanics have to be added."
**[ANALYSIS]** https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis

**This is the strongest strategic argument for PLAN §2.2.** The reference game's
one widely agreed *design* failing in its best system is that release timing does
not pay enough. Web-Slinger has no mass-market accessibility constraint. Making
the release-timing reward curve steep is the differentiator, and it is already
specified.

---

## 7a. Claims this research CONFIRMS

| Claim (location) | Verdict | Source |
|---|---|---|
| Fristrom constraint method: clamp position to tether sphere, re-derive velocity (`hero.js`, PLAN §2) | **Confirmed, primary** | https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t |
| `GROUND_CLEAR` + `SHORTEN_RATE`: "tether auto-shortens so the arc bottom clears the street… (the PS4 assist)" | **Confirmed twice** — Fristrom prescribes the `desiredLength`/`currentLength` rate limit by name; design analysis confirms Insomniac ships it | tutsplus URL above · https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis |
| `AIR_STEER` comment: air control "somehow feels right (Fristrom)" | **Confirmed, exact quote** | tutsplus URL above |
| `SWING_STEER` comment: "a floating drone attached to a rope" | **Confirmed as a quote** — but it is the Game Developer analysis, **not** Fristrom | https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis |
| PLAN §2.1 auto-straightening is a real reference-game behaviour | **Confirmed, and Insomniac ships it as a 0-to-max slider** described as *resistance* | analysis URL above · https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature |
| PLAN §2.2 release just past the arc bottom beats holding | **Confirmed** ("just after the lowest point… so that you have a little bit of upward momentum") — matches `RELEASE_PEAK_LO: 0.09` | https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17805410/swinging-traversal-point-launch-boost-skill/ · https://www.gamesradar.com/marvel-spider-man-ps4-tips/ |
| PLAN §2.3 tether break / wrap / pass-through is "the shipped rule from Spider-Man 2 (2004)" | **Rule confirmed, by its author, in those three tiers** | tutsplus URL above |
| PLAN §2.4 point launch is "the fastest line in the reference game" | **Confirmed** — "faster than swinging. Period." | Polygon traversal URL above |
| PLAN §2.4 zip-to-point + jump-on-arrival is the launch | **Confirmed**, and the timing window is "the exact moment you land" | Polygon · https://www.redbull.com/us-en/marvel-spiderman-tips-web |
| PLAN §2.6 air tricks feed the Focus economy | **Confirmed** — tricks fill the Focus bar so you arrive at a fight with specials ready | https://www.redbull.com/us-en/marvel-spiderman-tips-web · https://www.newsweek.com/entertainment/video-games/spiderman-ps4-beginners-guide-tips-tricks-1110064 |
| PLAN §2.7 speed-linked FOV + pullback + **roll into the swing plane** | **Confirmed, developer-stated, all three axes**: "Swing Camera Motion: Adjust the amount of roll, pitch, and field of view (FOV) changes while swinging." | https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature |
| `WALLRUN_AUTO_V`: "a dead stop against a wall is the one outcome a traversal game must never produce" | **Confirmed** — "you don't crash into walls, but automatically start wall-running on collision", named as a reason the swing works as base traversal | https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis |
| `ASSIST_Y` "Insomniac's special anchor — never strand the player" | **Confirmed in kind**, though only second-hand: Insomniac's "special attach point" for when no legal anchor exists | https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/ |
| `STALL_ANGLE` rationale: rigid tether allows the "standing on a stiff web" pose | **Confirmed as a real, named failure mode**, and *Spider-Man 2* solved it via web wrap, *Ultimate Spider-Man* via a vertical-speed floor | same URL |
| PLAN §4 "every standard animation cancels into dodge — not most, every one" | **Confirmed verbatim** | https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis |
| PLAN §4 combo ends on hit or timeout, **whiff does not break it** | **Confirmed verbatim** | same URL |
| PLAN §4 spider-sense is **two-stage** | **Confirmed** — white "uh-oh" halo, then a brighter/bluer "danger imminent" halo which is the perfect-dodge window | https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/ · https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17801264/perfect-dodge/ |
| PLAN §4 perfect dodge "pays bonus Focus" | **Confirmed, in-game text**: "Generates bonus Focus" | Polygon perfect-dodge URL above |
| PLAN §4 "Focus spends on heal or finisher" | **Confirmed**, and the heal/finisher tension is explicitly the interesting decision | Polygon fighting URL above · https://marvels-spider-man.fandom.com/wiki/Focus |
| PLAN §4 four archetypes cover four verbs | **Confirmed in substance** (grunt/gunman/brute/shield each demand a distinct answer) — one verb reassigned, see 7b | https://www.gamesradar.com/marvel-spider-man-ps4-tips/ · https://marvels-spider-man.fandom.com/wiki/Focus |
| PLAN §4 gadget wheel "slows but does not stop time… most-criticised part of the reference game's combat" | **Confirmed verbatim**, including the prescribed fix (Arkham-style shortcuts) — and Insomniac later shipped D-pad gadget shortcuts | https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis · Insomniac support URL |
| PLAN §5 "the one collectible players never tired of was the one whose collection *was just more swinging*" | **Confirmed as the cited analyst's stated view**, naming backpacks and pigeons — see 7b for the caveat | https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis |
| PLAN §5 "Never a six-wave slog" | **Confirmed** — the analyst quit the hideout missions specifically over "all that 6-wave gameplay" | same URL |
| PLAN §5 "Skill trees hold amplifiers, never the moves that make the system fun" | **Confirmed as a stated criticism** — throws and swing kicks were locked and shouldn't have been | same URL |
| PLAN §5 distinct districts are worth building | **Confirmed** — "Neighborhoods have distinct enough character to be discernible as I swung from one to the next" | https://www.ign.com/articles/2018/09/04/marvels-spider-man-ps4-review |
| PLAN §5 side content is "enormous and repetitive" | **Confirmed by review consensus** — "the fortieth is much less so" | IGN URL above · https://en.wikipedia.org/wiki/Marvel%27s_Spider-Man_(video_game) |
| PLAN §6 LOD that drops facade furniture and keeps an emissive speckle | **Confirmed as the shipped strategy** — imposters (no UVs, no normals) + 600k hibernates at 40 bytes each | https://vitalight.me/archives/spider-man-console-game (summarising GDC 2019) |

## 7b. Claims this research CONTRADICTS, qualifies, or could not verify

**1. `GRAV` comment: "Spider-Man 2 (2004) shipped a swing-accel multiplier of ~3x on real gravity." — NOT a developer statement. Could not verify.**
The only traceable origin is a community analysis, and its author hedges it:
> "if I remember correctly, **Spider-Man 2 had actually settled on a multiplier around 3 for their swing speed**: that's right, you'd need to be falling 3 times faster than you normally would to swing as fast as in Spider-Man 2"
The same post opens by stating "I am **NOT** an Insomniac employee… Everything I know about it comes from what I've seen." The number appears nowhere in Fristrom's article, his AMA, or coverage of his GDC 2019 postmortem.
**[MEAS, low confidence]** https://www.reddit.com/r/SpidermanPS4/comments/8sff54/an_indepth_analysis_of_the_webswinging_mechanic/
Note also that the claim is about the **downward-acceleration multiplier feeding the pendulum solve**, not a general gravity scale — a different quantity from `GRAV: 22`. **Recommended fix:** re-label the comment as community recollection, or drop the citation and justify 22 purely on the project's own measurement (which is the stronger argument anyway).

**2. PLAN §2.3's "6 m / 20 m" break/wrap distances are invented.** The three-tier rule is Fristrom's and is solid; **no distances are given in any source**, and *Spider-Man 2*'s world scale is not published. Treat 6/20 as Web-Slinger's own numbers and measure them in Web-Slinger's city. https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

**3. PLAN §4: "Perfect dodge grants brief immunity, **slows time** and pays bonus Focus." — the slow-motion is wrong for the base move.** Perfect Dodge's in-game text is "counter enemies with a Web Shot to the face. Generates bonus Focus" — no time dilation. The slow-motion belongs to a *different, later* skill: **Last Stand**, which "give[s] you a moment of slow-mo to help avoid a potentially lethal blow". Invincibility frames are a community report, not documented. https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17801264/perfect-dodge/ · https://www.gamesradar.com/marvel-spider-man-ps4-tips/ · https://gamefaqs.gamespot.com/boards/191635-marvels-spider-man/78461970

**4. PLAN §4: "Air combat pays more Focus than ground combat — that gradient is the skill expression." — could not verify.** Every Focus source lists the same generators: landing melee attacks, dodges, combo length, and (in traversal) air *tricks*. **None distinguishes air from ground combat.** The reference game's incentive to fight airborne is *positional* (out of reach of the ground crowd, more dodge and web-strike options), not economic. If Web-Slinger wants an air/ground Focus gradient it is a Web-Slinger invention — a reasonable one, but it should not be attributed to the reference game. https://marvels-spider-man.fandom.com/wiki/Focus · https://www.polygon.com/spider-man-ps4-guide/2018/9/6/17800314/fighting-combat-dodge/

**5. PLAN §5: the tower-climb was "the most-criticised structure" — overstated, and the towers are not climbs.** Insomniac's Oscorp surveillance towers are short signal-unscramble minigames that unfog the map; the travel to them is the content. Reviews name them among tedious standard-issue content, but by weight of sources the *most*-criticised structures are the **wave-based hideout missions** and the **mandatory non-Spider-Man stealth sections** — and the design analysis PLAN cites for its other open-world claims **does not mention towers at all**. PLAN's conclusion (skip them) still stands; the justification should change. https://marvels-spider-man.fandom.com/wiki/Surveillance_tower · https://www.cgmagonline.com/review/game/spider-man-ps4-review/ · https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis · https://www.ign.com/articles/2018/09/04/marvels-spider-man-ps4-review

**6. PLAN §5's collectible design departs from the thing it cites.** Backpacks/pigeons were enjoyed because "it's pretty much based on swinging" — i.e. the *travel* was the reward and "the activity itself was pretty easy" (IGN). PLAN specifies collectibles "each placed where reaching it *requires* a traversal move", which adds a skill gate the beloved reference collectible did not have. Possibly right for a game with no story, but it is a change, not a copy. https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis · https://www.ign.com/articles/2018/09/04/marvels-spider-man-ps4-review

**7. PLAN §4's archetype→verb mapping has one verb on the wrong enemy.** PLAN assigns "dodge *under*" to the brute. In the reference game **Dodge Under is the answer to the shield**; the brute wants web-up-then-attack, or a finisher costing **two** full Focus bars. https://www.gamesradar.com/marvel-spider-man-ps4-tips/ · https://marvels-spider-man.fandom.com/wiki/Focus

**8. Web-Slinger's speed envelope is probably well above the reference game's, and `hero-consts.js` should not imply otherwise.** No developer figure for Insomniac swing speed exists. The best community estimate is **~70 mph ≈ 31 m/s** top speed (offered without method), and base swing speed in the 2018 game *increases with player level* rather than being a constant. Web-Slinger measures **p50 53 m/s, p90 64, VMAX 66**, i.e. plausibly ~1.7-2× the reference. That may be correct for a 1.25 km city, but the `GRAV` comment's "lands in the same envelope" is unsupported. https://www.reddit.com/r/Spiderman/comments/93h04b/spiderman_swing_speed/ · https://www.redbull.com/us-en/marvel-spiderman-tips-web

**9. PLAN §6's "day/night cycle" runs against the reference game's decision.** *Marvel's Spider-Man* has **no real-time time-of-day transition** — times of day are tied to story beats with a limited set of **pre-baked lighting configurations**, and DF speculates a large urban environment is exactly where blending pre-calculated light passes fails. On console hardware, with more budget than a browser. Web-Slinger should ship discrete lighting states. https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis

**10. No frame data exists for the reference game's combat — PLAN §4 is right to say so, and nothing found here changes it.** Every timing in PLAN §4 (T−0.55 s telegraph, 0.2 s pulse) remains a proposal. What *is* known is that the dodge window is a **first-class tunable** Insomniac ships to players twice over (the `Dodge Window` skill; the `Dodge/Parry Timing` accessibility setting) — which suggests Web-Slinger should build it as a tunable from day one rather than a constant. https://support.insomniac.games/hc/en-us/articles/46730041467027-What-Accessibility-options-does-Marvel-s-Spider-Man-2-feature

**11. Could not verify: any Insomniac statement about what they would change in the 2018 traversal or open world.** The only on-record regret is about the **Mary Jane stealth missions** (Intihar, 2023), where the stated fix was to make her capable rather than to cut the sections. No Insomniac statement about towers, collectible volume, or side-content repetition was found. https://www.ign.com/articles/our-big-spider-man-2-postmortem-interview-10-things-we-learned

**12. Could not verify: the GDC 2019 technical postmortem numbers from an English-language primary source.** The talk video and GDC Vault entry are public and the slides were posted by Elan Ruskin at `crashworks.org/gdc19/`, but that host is blocked by this environment's egress proxy. The specific numbers in §5 (600k hibernates, 384→40 bytes, 8 GB probes, ~20% index compression, 3-tiles-ahead, ~1 s turn time, 4 MB / 400× duplication thresholds) come from **one Chinese-language summary of the talk**. They are consistent with the talk's published abstract and with Digital Foundry's independent observations, but they are single-sourced and should be re-verified against the video or slides before any of them is written into a code comment as "measured". https://www.youtube.com/watch?v=KDhKyIZd3O8 · https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man · https://vitalight.me/archives/spider-man-console-game · https://x.com/despair/status/1109013313189404673
