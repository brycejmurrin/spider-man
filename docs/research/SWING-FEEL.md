# Swing feel — a design reference for Web-Slinger

What the genre has learned about tether feel, momentum, and perceived speed, and
what of it applies to a rigid-constraint pendulum in a browser.

---

## 0. Scope, provenance, and what this does not repeat

**`docs/research/` did not exist when this pass ran.** The prior pass's output is
the source list in `docs/PLAN.md` §8 and the rationale comments in
`js/game/hero-consts.js` / `js/game/hero.js`. This document therefore assumes
familiarity with, and does not re-derive:

- Fristrom's *Swinging Physics for Player Movement* (the constraint method,
  clamp-to-sphere, re-derive velocity) — already implemented in `hero.js`.
- The 2018 game's design analyses (gamedeveloper.com, Polygon, the r/SpidermanPS4
  in-depth analysis) — already cited in PLAN.md §8.
- Digital Foundry's 2018 tech analysis and the GDC 2019 technical postmortem.

**Provenance labels.** This project's convention is three: **DEVELOPER-STATED**
(the person who built it said so), **COMMUNITY-MEASURED** (a player or critic
observed/compared it), **ANALYSIS** (my inference from the above plus the code in
this repo). Section 5 leans on peer-reviewed perception research, which fits none
of the three cleanly; those claims are labelled **LAB-MEASURED** and the
distinction is deliberate — a psychophysics result and a Reddit gif comparison do
not carry the same weight and should not wear the same tag.

---

## 1. Spider-Man 2 (2004) — what actually differs

### 1.1 The anchor system: raycast against real collision geometry, not points

**DEVELOPER-STATED.** The system began as hand-placed swing points at building
corners; designer Eric Pavone found that "the more points he added, the more
predictable, smooth, and fun it got", and programmer Andrei Pokrovsky replaced
the point list with raycasts against the physical collision geometry. Fristrom:
"almost everything that a character could physically collide with could be
swingable… That same physics geometry that the level builders had to add
manually was what was swung from." Cost: "a small fraction of a frame", after "a
fair amount of optimization work".
https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/
https://www.eurogamer.net/13-years-later-spider-man-2s-swinging-has-never-been-bettered-heres-its-story

**Why this matters more than it sounds.** The rule is not "webs look like they
hit buildings". It is *the set of legal anchors is exactly the set of collidable
surfaces*, with no synthesis, no fallback, and no invisible point cloud. That
makes anchor availability a **property of the level**, so the city teaches the
player where the fast lines are. `pickAnchor` in this repo already raycasts
against the OBB set — that half is right. `ASSIST_Y` breaks it (see §7).

**ANALYSIS.** Fristrom's own framing of the interface problem is worth keeping:
"the hardest thing about bringing this 2D mechanic to 3D is considering the
interface for the player — how they pick points in the world to swing from",
and he enumerates the three families: fixed authored points (Ratchet & Clank),
camera-forward ray (Quake hook, Bionic Commando: Rearmed), character-relative ray
fan (Spider-Man 2, Energy Hook).
https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

### 1.2 The web is a physical object with collision — break / wrap / pass-through

**DEVELOPER-STATED.** "A quick way to simulate [wrapping] is to raycast along the
virtual rope each frame, and if it hits something, make a new attachment point
where it intersects… Suddenly wrapping around an outcropping can take the player
by surprise and make them frustrated. **We had a three step solution in
Spider-Man 2: if you were too close to the outcropping, the web would break; if
you were in a middle distance, the web would wrap; and if you were far away, the
web would just go through.**" — Fristrom, same article.

**COMMUNITY-MEASURED, and this is the sharpest discriminator found.** A 2015
analysis names web collision as *the* thing later games borrowed the look of and
not the substance of: "*The Amazing Spider-Man 2*… borrow[s] one of *Spider-Man
2's* lauded features and force[s] your web to attach to physical buildings, [but]
they do not employ collision for the web itself. At 1:08 of this developer
playthrough, Spider-Man launches a web that lands somewhere above the tunnel
entrance, but he swings through the tunnel in a straight line. In *Spider-Man 2*,
your web would catch and bend on the upper lip of the entrance, sending you
straight into the roof."
https://onthecrtscreen.wordpress.com/2015/07/07/locomotion-and-momentum-in-spider-man-2/

The same complaint is the third item on the most-upvoted structured critique of
the 2018 game: "The web is shooting through the 4th dimension… it totally ignores
street lights and even entire buildings. I'd like it to kink the web if it
intersects with another object like a string would."
https://steamcommunity.com/app/1817070/discussions/0/4859966604386424625/

**ANALYSIS.** Wrapping is not a visual nicety, it is the *only* mechanism in the
2004 game by which the tether shortens under player control — and a shortening
tether is the game's main free-speed source (§4.2). PLAN.md §2.3 already schedules
break/wrap/pass-through; this research upgrades it from "polish" to **the single
highest-value unimplemented item**, because it is simultaneously the fix for
weblines clipping through geometry, the source of a skill-expressive speed gain,
and the thing every comparison names.

### 1.3 Momentum is conserved through *every* transition, not just within a swing

**COMMUNITY-MEASURED.** The 2015 analysis frames the whole 2004 toolkit as
momentum-preservation machinery rather than as separate moves: web-slingshot
(charge between two anchors — recovers speed *from a standstill*), web-boost
(mid-swing impulse, best on the descent), web-zip (yank forward past a rooftop
you would otherwise land on), wall-sprint in **any** direction including upside
down, roll-on-landing. "Efficient movement throughout Manhattan requires a
mixture of swinging and wall-sprinting to maintain a high velocity and full
control." Death is described as "the greatest momentum killer of them all" — i.e.
the *only* hard momentum reset in the game.
https://onthecrtscreen.wordpress.com/2015/07/07/locomotion-and-momentum-in-spider-man-2/

**ANALYSIS.** The design rule that falls out: *every* recovery affordance returns
you to motion **without** costing speed, but each one costs a **different**
resource — time (slingshot charge), height (zip), or a lateral detour
(wall-sprint). That is a different bargain from "the assist is free", and it is
the bargain this repo's CLAUDE.md already states ("assists may redirect momentum;
they may not tax it") but only half-implements: the repo has no cost dimension at
all on its assists.

### 1.4 The camera

**COMMUNITY-MEASURED.** No developer statement on the 2004 camera surfaced. The
negative evidence is more useful: Energy Hook — the same designer, the same swing
model, a decade later — was reviewed with the camera as its top complaint. "It's
way too easy to get completely disoriented. You'll often not know where you are
because the camera can move very erratically. Not only that, sometimes it focuses
on a wall so you can't see your surroundings at all."
https://videochums.com/review/energy-hook

**ANALYSIS.** The swing model is not what makes a swing readable; the camera is.
A correct pendulum with a camera that loses the horizon reads as a bug. This
repo's confirmed open defect — the eye behind geometry on 30% of canyon frames
(`docs/HANDOFF.md` §2) — is therefore not cosmetic and not lower priority than
the physics work. It is the same failure that sank the reference implementation's
own successor.

### 1.5 Why "better to some players": the Coke/Pepsi answer

**DEVELOPER-STATED.** Fristrom's explanation for why every subsequent Activision
Spider-Man abandoned the system: focus tests. "Most focus testers, given just a
couple of sips of Pepsi, preferred Pepsi… But if you actually sent people home
with a case of Coke and a case of Pepsi, most people preferred Coke… somebody new
coming to the system will be like, 'yeah, look how cool and badass I am right out
of the gate!' But after playing it for a while will be like, 'okay, I'm bored
now.'"
https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/

**ANALYSIS.** This is a claim about the *shape of the fun curve over hours*, and
it is directly testable in a system as instrumented as this one: does time-to-
traverse a fixed course keep improving with practice, or does it plateau in the
first ten minutes? PLAN.md §2.2's 500 m course is the right instrument; it should
measure a *learning curve across sessions*, not a single A/B.

---

## 2. The other entries

### 2.1 Ultimate Spider-Man (2005) — Fristrom's own #2, and the "push off the wall" assist

**DEVELOPER-STATED.** Fristrom ranks it second after 2004: "it feels really
different from Spider-Man 2, but that's totally in keeping with the character
being more spastic and cartoony." He also documents one of its assists as a
technique worth stealing: "**Keep them off the wall:** *Ultimate Spider-Man* did
this — if you got too close to a wall it would gently push you away from it. It
looked a little weird if you let go of the stick and just let your avatar hang
there… **You could possibly have the best of both worlds by only pushing away if
the character is going a certain speed?**"
https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t

**COMMUNITY-MEASURED, dissenting.** A detailed comparison thread calls Ultimate
"the weakest system we've had since Spider-Man 1… You had to climb your web WHILE
swinging to get the extra height" — but a second poster in the same thread argues
the opposite on *control*: in SM2 "when I wanted to turn on a corner of a street,
I always need to release my web and face the direction I wanted then web swing
again… while in Ultimate I could turn while still hanging on my web", and
Ultimate's web-zip "give[s] you extra elevation" where SM2's "always go[es] lower
and lower each time you use it".
https://gamefaqs.gamespot.com/boards/647137-the-amazing-spider-man/63426564

**ANALYSIS.** Two transferable rules. (a) A speed-gated wall repulsion is
strictly better than an unconditional one *and* better than nothing — this repo
currently does the opposite, converting wall contact into a wall-run
unconditionally above a threshold (§6.2). (b) Turn authority while attached is a
real axis, not a cheat; `SWING_STEER: 16` is on the right side of this argument.

### 2.2 Web of Shadows (2008) — Fristrom liked it, with one named regression

**DEVELOPER-STATED.** "I liked Web of Shadows a lot, but **I hated that you could
swing from the sky again.** I get why they did it — it makes it more accessible."
https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/

**COMMUNITY-MEASURED.** "Control was similar to Spider-Man 2 although most of the
extra options for swinging were scaled back. You could no longer do tricks but
you still could wall run (manually), catapult off of buildings, and you still
could move at incredible speeds."
https://gamefaqs.gamespot.com/boards/647137-the-amazing-spider-man/63426564

**ANALYSIS.** The single named regression from the system's own author is
**sky anchors**. That is exactly what `ASSIST_Y` synthesises.

### 2.3 Marvel's Spider-Man (2018) — physics-based, with assists on top

**DEVELOPER-STATED.** Insomniac, pre-launch: "swinging is all physics based and
the webs attach to buildings". Reported alongside the NeoGAF comparison thread
that had just accused the game of having "no wild momentum" and "only one speed".
https://www.vg247.com/marvels-spider-man-will-have-physics-based-web-swinging-and-webs-must-tether-to-surfaces

**COMMUNITY-MEASURED — the "air brakes" observation.** A side-by-side of the same
manoeuvre (Empire State jump → web on the way down) in 2004 vs 2018: in 2004 "the
web swing resulting clearly shows speed being used from his gravitational descent
to fling him elsewhere"; in 2018 "the momentum is rapidly slowed down, almost
like he's stopping in midair, and he's back to default swinging speed." The
poster re-ran the 2004 test with zero speed upgrades to rule out the obvious
confound and reports the gap survives.
https://www.reddit.com/r/Games/comments/8rws2a/the_concerning_state_of_ps4_spidermans_webswinging/

Two further observations from that thread, both mechanical and both replicable:
the webs visibly **stretch** rather than being taut (so the constraint is soft,
not rigid), and Spider-Man **begins the swing animation before the web has
attached** — which is also independently the top-voted complaint in the Steam
thread ("if you stand still, jump and just tap the trigger you'll see what I mean.
He begins moving into the swing when nothing is carrying him yet").

### 2.4 Miles Morales (2020)

**COMMUNITY-MEASURED.** Widely read as a momentum retune rather than a new model —
"Miles Morales has better momentum, and the venom jump and new air tricks/
animations make swinging more fun to play and look at."
https://www.reddit.com/r/SpidermanPS4/comments/15juwqn/anybody_else_thinks_insomniacs_traversal_gets_a/
The venom jump's stated role is as a **speed/altitude recovery in low-rise
geography** — "while web-swinging, Miles can use venom to give him a boost and
move faster or gain altitude **in areas where there are no buildings or
structures**".
https://mcccagora.com/2020/11/27/spider-man-miles-morales-swings-in-with-style/

**ANALYSIS.** This is the first appearance of the pattern that dominates 2023:
*the swing model is not changed, a parallel verb is added to cover the terrain
the swing model handles badly.* Web-Slinger's city has a low-rise rim district
(PLAN.md §2 / §5) and will hit the same wall.

### 2.5 Marvel's Spider-Man 2 (2023) — Web Wings, the retune, and swing assist

**DEVELOPER-STATED — why Web Wings exist.** Senior game director Ryan Smith:
"Swinging is the core of our Spider-Man traversal, so we designed the Web Wings to
work with swinging and **complement** it. That way you can weave back and forth
between the two to build up speed and height."
https://gamingbolt.com/marvels-spider-man-2-devs-reveal-new-open-world-and-traversal-details

Senior programming director Doug Sheehan, on the same question, is explicit that
the motivation was **terrain the pendulum cannot serve**: "we double the size of
the city. So we've now got Brooklyn and Queens… they're not built like Manhattan
is, they're a lot lower… And then you've got the river in between and we say,
well, how do you traverse all of that? **You can just swing, but it doesn't always
work. It's not always the optimal way to do it.**"
https://www.ign.com/articles/insomniac-answers-all-of-our-questions-about-spider-man-2s-ps5-tech

**DEVELOPER-STATED — the retune, and what it cost.** Sheehan's GDC 2024 talk is
literally titled *Higher, Faster, Farther: Evolving Traversal in 'Marvel's
Spider-Man 2'*; its abstract says the team "had to evolve several of our existing
mechanics to handle the new speeds the player could traverse at."
https://gdcvault.com/play/1034327/Higher-Faster-Farther-Evolving-Traversal
Coverage of the talk: on early web-glide builds "they made several adjustments and
changes to the pitch and yaw of the web gliding, **retaining a sense of
'floatiness'** for movement and adjusting how air momentum works", and the first
playtest "was an absolute mess… the only honest feedback we got was that it was
clunky. **We didn't get proper feedback on how the feature worked because they
struggled with the basic barrier of getting deployed.**" The fix was purely input:
shoulder-buttons-plus-Triangle → tap Triangle. "The response to this was
immediate."
https://www.gamedeveloper.com/programming/how-spider-man-2-s-traversal-physics-sling-a-faster-superhero-fantasy

Sheehan's closing thesis in that talk: the goal is giving "players a better sense
of control, and making them **feel like they're better at the game than they
are**".

**DEVELOPER-STATED — magnitude of the speed increase.** Core tech director Mike
Fitzgerald: "When you come off those slingshots in the open world, I think you're
going about **three times as fast** as we could in the first game."
https://www.ign.com/articles/insomniac-answers-all-of-our-questions-about-spider-man-2s-ps5-tech

**COMMUNITY-MEASURED — swing assist, the 0–10 slider.** 2023 shipped the assist
as a player-facing dial, which makes it the closest thing to a controlled
experiment the genre has. At 0 the reported deltas are: no auto-correction around
corners, no "pre-set pendulum arc", you must manage tether length to avoid
buildings, you can hit the street (the invisible safety net is gone), and
"launching yourself vertically will dramatically lose your speed". Players report
converging on **4–8**, not 0 and not 10.
https://www.reddit.com/r/SpidermanPS4/comments/178cu49/swing_assist_explanation/

**ANALYSIS.** Three things Web-Slinger should take from 2023, and one it should
not. Take: (1) a **complement**, not a replacement, for terrain the pendulum
handles badly; (2) the assist as a **slider**, because it settles the
accessibility argument empirically instead of by taste, and because a slider is
the only honest way to ship both a low skill floor and a real skill ceiling;
(3) the deployment-input lesson — a mechanic can test as "bad feel" when the
actual defect is that nobody got it to fire. Do not take: the 3× speed increase
without the streaming budget that paid for it — Insomniac bought it with an SSD;
a browser buys it with pop-in.

---

## 3. Non-Spider-Man swinging games

### 3.1 Gibbon: Beyond the Trees (2022) — the most technically useful source found

**DEVELOPER-STATED**, Eddy Boxerman's deep dive, and it is nearly a spec for
anchor scoring:
https://www.gamedeveloper.com/programming/deep-dive-physics-based-animation-in-gibbon-beyond-the-trees

- Their first model was a **sine wave** (canned arc). It failed on transitions:
  "sometimes it looked kinda glitchy, and **momentum often didn't feel like it was
  being conserved**", and launches "felt quite discontinuous and unphysical". The
  fix was to move to a **handhold-centred** model. *Transitions, not steady
  state, are where a swing model is judged.*
- The key physical result, from the brachiation literature: **"gibbons ideally
  want their 'grab arm' to be reaching out perpendicularly to their velocity. In
  this way, the swing is initiated smoothly, with no discontinuities in the
  gibbon's COM velocity — just a new (perpendicular) force applied, causing a
  smooth rotation. Anything else causes a 'collisional energy loss'."**
- The planner **penalises** solutions "that required a significant change in the
  gibbon's momentum during their swing… Some 'muscle work' was ok — even good…
  but too much looked discontinuous, as though our gibbon had gotten a rocket
  boost, or hit a wall."
- Bookkeeping, stated plainly: "some accounting to **re-inject any lost energy**
  (except where we intentionally bleed speed), some velocity 'projection'."
- Design constraint from the director that overrode pure physics: the game should
  feel "almost like a flowy rhythm game — not twitchy, requiring players to give
  input for every handhold", so the planner follows *branches*, not the globally
  best handhold.

**ANALYSIS — this is the biggest actionable finding in the document.** The
perpendicularity rule gives `pickAnchor` a physically-grounded score term it
does not currently have. Attaching to an anchor whose tether direction is *not*
perpendicular to the current velocity means the constraint's very first clamp
projects out a large radial component — that is the "collisional energy loss",
and it is precisely the 2018 game's "air brakes" complaint (§2.3) expressed as
physics. Web-Slinger's scoring is `lenS + upS + aimS + strS`: length-to-ideal,
height, aim, side-alternation. **Not one term is about the velocity at the moment
of attach.** See §8, change A.

### 3.2 Titanfall 2 (2016) — the tether as a *modifier* of existing momentum

**COMMUNITY-MEASURED / ANALYSIS.** The clearest statement of what a good grapple
does: "Imagine a ball rolling down a sloped surface… If that same ball is
tethered midway down the slope by a small thread, that thread is now affecting
direction and speed of the ball. It will fall in a circular arc… **With Titanfall,
the grappling hook takes the player's velocity into account.** Now jumping off of
one wall while attached to another point further up takes the force of the jump
and revolves the player around that hooked point."
https://www.jordanrobertguy.com/home/titanfall-2-grabbing-that-grappling-hook

**ANALYSIS.** The design position is that the grapple is worth almost nothing
used as a *winch* (aim up, get pulled) and is worth everything used as a *pivot*
on speed you already had. Applied here: the value of `ZIP_BOOST` is not the
impulse, it is that it is available *between* arcs — which is how PLAN.md §2.4
already frames it ("connective tissue"). Keep that framing; do not grow the
impulse.

### 3.3 Energy Hook (2016) — Fristrom's own, and its criticism

**COMMUNITY-MEASURED, and the most instructive negative data in this document,**
because it is the 2004 model in isolation, by its own author, with no city and no
assists.

- Anchor selection collapsed without a dense city to choose from: "it feels like a
  missed opportunity that the system doesn't demand more precision. **It's simply
  a matter of holding down a button and waiting for the tether to stick to
  whatever object happens to be closest.**" The same reviewer identifies why 2004
  got away with it: "since there was an entire city to explore, the game did much
  of the work for players who simply needed to worry about maintaining momentum
  and steering."
  https://gamecritics.com/mike-suskie/energy-hook-hands-on-preview/
- Camera disorientation as the top shipped complaint (quoted in §1.4).
- Landing precision as the second: "trying to land perfectly on platforms is
  needlessly frustrating… the character runs a little after she lands and it's
  hard to control her mid-air while she's falling."
  https://videochums.com/review/energy-hook

**DEVELOPER-STATED**, Fristrom's own listed strategy for wall collisions in
Energy Hook: "**Reward them for not hitting the wall in the first place**… teach
the player to avoid hitting walls, by rewarding them for clean swings. On the one
hand, it encourages them to swing pretty; on the other hand, **when they do hit
the wall it's that much more frustrating, because they lose their style points.**"
(tutsplus, as above)

**ANALYSIS.** Fristrom names his own approach's downside in the same sentence he
proposes it. The four options he lists for wall contact — air steer, cool
animation, push-away assist, style-point punishment — are a menu, and 2004 shipped
*all four*. Shipping only the harshest one is what Energy Hook did and what its
reviews punished.

### 3.4 Bionic Commando (2009), Just Cause, Sekiro, Gravity Rush — thinner ground

No developer postmortem for Bionic Commando 2009's swing surfaced through this
pass; the substantive material is community-level. Two points are still worth
recording.

**DEVELOPER-STATED (by proxy).** Fristrom classifies *Bionic Commando: Rearmed*
with the Quake hook as **camera-forward aiming** — you point the camera at what
you want and the ray goes there — as opposed to Spider-Man 2's character-relative
ray fan. (tutsplus, as above) That is the whole interface taxonomy and it is
still the live decision for any grapple: *who aims, the camera or the character?*
Web-Slinger currently uses a character-relative fan biased by steer input, i.e.
the SM2 answer, which is correct for a game where the camera is also doing
framing work.

**COMMUNITY-MEASURED.** Sekiro's grapple uses **explicit, highlighted, discrete**
anchor points and a fixed pull — no pendulum at all. The design discussion around
it is entirely about *readability of the point*, not about tether physics; the
common derived pattern is "jump right after reaching the grappling point to gain
momentum".
https://www.reddit.com/r/Sekiro/comments/9eja7p/how_do_people_feel_about_the_popup_displaying_for/
https://www.linkedin.com/posts/jramello_what-do-you-think-we-used-sekiro-as-main-activity-7383490886183305216-Bqwy

Gravity Rush's recurring criticism is disorientation from a camera that does not
auto-correct after a shift — the same failure class as Energy Hook's, in a game
with no tether at all.
https://www.reddit.com/r/gravityrush/comments/1o4j5zf/hey_gravity_shifters_is_it_normal_for_the_camera/

**ANALYSIS.** Across four unrelated games, the recurring lethal defect of a
free-motion traversal system is **the camera**, not the motion model. Sekiro is
the only one of the four with no camera complaint, and it is also the only one
whose anchors are pre-highlighted — the player always knows where they are going
before they commit. That argues for PLAN.md §2.4's perch-point highlighting being
a **readability** feature, not just a new move.

---

## 4. Momentum conservation rules across the genre

### 4.1 On release

**COMMUNITY-MEASURED.** 2004: release preserves the full instantaneous velocity,
and the design work is in *making the player want to time it*. The web-boost
timing rhythm is described precisely: "Using the boost on the descent of Spidey's
swing leads to the most forward momentum. Jumping right after ascent begins
confines Spidey to a mostly horizontal plane of travel, but it allows the player
to propel themselves forward with each boost. **The rhythm of swing, boost on the
way down, and jump shortly after the ascent begins is one of the fastest ways
around the city.**"
https://onthecrtscreen.wordpress.com/2015/07/07/locomotion-and-momentum-in-spider-man-2/

**COMMUNITY-MEASURED, negative.** Forced release is disliked where it exists:
"Spiderman lets go. Small gripe, but I wish Spiderman didn't let go of the web
after a set amount of time" (2018, Steam thread, item 4); and for *The Amazing
Spider-Man*, "This one is the worst: **The game does not let you hold on to your
web indefinitely. It automatically lets you go when you reach the apex of your
swing.** How stupid is that?" (GameFAQs thread).

**ANALYSIS.** Note the exact shape of the complaint: it is not that auto-release
exists, it is that auto-release fires at the apex where the player would have
released *anyway if they were good*, so it removes the decision without removing
the outcome. Web-Slinger's `AUTO_RELEASE_PHI: 0.62` sits **past** the reward
peak (~0.35 rad) precisely to avoid this, and the code comment says so. That
reasoning is sound and is corroborated — but it is only sound if the *cost* of
letting the auto-release fire is real and legible. Today `RELEASE_MULT_MIN: 0.4`
applies at φ = 0.62 because 0.62 > `RELEASE_PEAK_HI` = 0.61, by 0.01 rad. That is
a cliff, not a curve, and it is one retune away from inverting.

### 4.2 On re-attach — and the tether-shortening question

**DEVELOPER-STATED.** Fristrom, on what wrapping buys you, answering a player who
described "wrapping a web around the corner of a building, which would shorten the
length of web I was swinging from and give me a huge speed boost": "You'll be able
to choose… whether you want your lines to wrap around objects or pass through
them. Passing through is easier for beginners; **wrapping around lets you do some
cool slingshoty whippy type stuff.**"
https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/

**DEVELOPER-STATED.** Fristrom's slack model shortens the tether every frame the
player is inside it: `tetherLength = (avatar.position - tetherPoint).Length();`
— "if you want to take slack out of your springy web or grapple beam, you can
shorten the tetherLength as the player gets closer to the tether point." Separately
he keeps a `desiredLength`/`currentLength` pair so ground-clearance shortening
does not "snap into the air" over one frame. (tutsplus, as above)

**ANALYSIS — this is where the project's stated invariant is too strong.** See §7.

### 4.3 On hitting a wall mid-swing

**DEVELOPER-STATED.** Fristrom's four-item menu (§3.3): air steer / cool
animation / speed-gated push-away / style-point penalty. Note that *none* of them
is "convert the collision into a free wall-run".

**COMMUNITY-MEASURED, on the 2018 game doing exactly that.** "What annoys is how
**if you hit a building at nearly any angle, you're sent sprinting up the side of
it.** That only really makes sense if you connected with the building on an
upswing but it doesn't matter; contact = Spider-Man exploding into a sprint. Sure
it streamlines the speed, but success of your movement flow doesn't feel earned;
**it feels cheap and cheated and handicapped in your favour.**"
https://www.reddit.com/r/Games/comments/8rws2a/the_concerning_state_of_ps4_spidermans_webswinging/
And: "You can't really mess up. When slamming face first into a building, you
don't get a movement penalty, or damage, or anything. You just start running up
the wall."
https://steamcommunity.com/app/1817070/discussions/0/4859966604386424625/

**ANALYSIS.** The 2004 wall-sprint was *manual* and directional (GameFAQs thread
explicitly notes WoS wall-running was "manually, people"); the 2018 one is
automatic and omnidirectional. Web-Slinger's is automatic and gated only on
`intoV > 4` plus a speed test — closer to 2018 than to 2004.

### 4.4 The two failure modes, and how the genre avoids each

**The pendulum that loses all energy.** Symptom: attaching kills speed, arcs decay,
you must re-earn velocity every swing. Causes and fixes found:
1. *Collisional loss at attach* — attaching non-perpendicular to velocity.
   Gibbon's fix: score candidate handholds by perpendicularity and reject the
   rest. (Gibbon deep dive.)
2. *A soft/stretchy tether* — the 2018 stretch observation (§2.3); a spring that
   is critically damped bleeds energy every oscillation where a rigid constraint
   does not.
3. *A blanket velocity clamp after the constraint* — see §7.
4. *An overzealous speed governor.* "The governing system seems WAY too aggressive
   and happy to slow you down as much as possible, as fast as possible… Wanna turn
   around that building? Sure, but you were going at max speed so let's go ahead
   and drop you 30% even though with a turn like that you should actually have
   GAINED some speed." (Steam thread, item 5.)

**The constraint that adds energy.** Fristrom's own remedy is a rail, not a
correction: "videogames being the hacky things they are, you'll probably often
find that your character's position snaps suddenly from one frame to the next in
certain corner cases. When this happens, their velocity will go through the roof.
**My solution for that is simply a hack: check if their velocity gets too extreme
and fix it if it does.**" (tutsplus.)

**ANALYSIS.** That is a `VHARD` rail, and Web-Slinger already has one (`VHARD: 95`).
The author of the method Web-Slinger implements does *not* rescale velocity after
every clamp; he clamps only the pathological case. The distinction matters and is
the subject of §7.

---

## 5. Perceived speed in a browser at 60 fps, with no motion-blur budget

### 5.1 The single most useful measurement: speed lives in the periphery

**LAB-MEASURED.** Caramenti et al. (2019), 12 subjects running on a treadmill in
a virtual environment, matching optic-flow speed to locomotion speed. Relative
underestimation of visual speed:

| Condition | Underestimation |
|---|---|
| Central view (periphery masked) | **41.30 %** |
| Full screen | **12.32 %** |
| Peripheral view only (centre masked) | **10.22 %** |

Main effect of FoV condition χ²(2) = 33.50, p < 0.0001; no main effect of speed.
https://pmc.ncbi.nlm.nih.gov/articles/PMC6812648/

**LAB-MEASURED, the FOV threshold.** Van Veen et al. (1998), via the same review:
visual speed was **underestimated below 73° FoV and slightly overestimated above
107°**. Banton et al. (2005) found 50% underestimation at 50° FoV. Pretto et al.
(2009): below 60°, underestimation bias is inversely related to visible area.
(All cited within Caramenti et al., same URL.)

**ANALYSIS — the ranking this produces.** Perceived speed is carried by *angular
rate of texture in the periphery*. Therefore, per millisecond of GPU:

1. **FOV kick — by far the best value, and it is free.** It is a projection matrix
   change: zero fill cost, zero draw calls, and it simultaneously widens the
   optic-flow field (moving toward the 107° regime) *and* increases the angular
   velocity of everything off-axis. Nothing else on this list has a better ratio.
   Caveat below.
2. **Screen-edge effects that modulate with speed — vignette, edge-only radial
   streaks.** One fullscreen pass, and it is applied exactly where the 41.30% vs
   10.22% result says the signal lives. A vignette that only darkens is worth
   little; one whose *radius and strength* track speed is a peripheral flow cue.
3. **Particle streaks (view-locked, near-camera, radially outward).** A few
   hundred camera-space quads is cheaper than any fullscreen pass at 1080p and
   puts high-angular-rate texture in the periphery on demand. This is the highest
   value-per-ms item that is not the FOV.
4. **Audio wind.** Free on the GPU entirely. See §5.3.
5. **Camera shake.** Free, but it is an *impact* cue, not a *speed* cue — see §5.4.
6. **Radial blur.** One fullscreen pass with N taps; the cost is N× the fill.
   Real, but it is item 2 done expensively.
7. **Chromatic aberration.** Three texture fetches per pixel for a cue with no
   optic-flow content at all. Lowest value on this list.

**DEVELOPER-STATED**, on why motion blur is the traditional answer and why its
absence must be compensated: "Motion blur can be one of the most important effects
to add to games, especially racing games, because it increases realism and **a
sense of speed**."
https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-27-motion-blur-post-processing-effect

**COMMUNITY-MEASURED**, on 2004's use of it: the web-boost "is accompanied by
heavy motion blur, which further drives home the feeling of speeding between
buildings."
https://onthecrtscreen.wordpress.com/2015/07/07/locomotion-and-momentum-in-spider-man-2/

### 5.2 The FOV finding specific to this codebase

**ANALYSIS.** `js/game/cameras.js`: `spN = Math.min(1, sub.speed / 40)`, and swing
mode is `f = 66 + 14 * spN` → 66°…80°. Two problems, both measurable now:

- **The kick saturates below the cruise speed.** `docs/PLAN.md` §2 measures
  sustained cruise at **42 m/s**, with `VMAX: 66` and dive peaks to 77. `spN`
  pins at 1.0 from 40 m/s upward, so across the entire 40–77 m/s band — which is
  most of the interesting play — the FOV signal is **constant**. The player gets
  no visual differentiation between cruising and a dive slingshot.
- **80° is in the underestimation regime.** Van Veen's crossover is 107°;
  Web-Slinger tops out at 80°. There is headroom, and taking it costs nothing.

### 5.3 Audio

**LAB-MEASURED.** Horswill & Plooy (2008), *Perception* 37(7): 2AFC speed
comparison of video driving scenes with in-car noise at real level vs **5 dB
lower**. "The reduction in noise led to participants judging speeds to be
**significantly slower** and this effect was evident for **all** participants."
https://journals.sagepub.com/doi/abs/10.1068/p5736

**ANALYSIS.** A 5 dB level change moved a perceptual speed judgement across every
subject. That is a large effect for zero GPU cost, and it says the wind layer in
`js/game/audio.js` should be driven by speed with a **wide dynamic range** —
several dB between cruise and peak, not a subtle filter sweep. It is likely the
cheapest perceived-speed lever in the whole project.

### 5.4 Camera shake — a warning

**ANALYSIS.** Shake adds screen-space motion that is *uncorrelated with heading*,
so it is not optic flow; it reads as impact or instability. Two of the four
non-Spider-Man traversal games surveyed have disorientation as their top
criticism (§3.4). `cameras.js` already squares trauma "so grazes barely move and
slams hit hard", which is the right shape. Do not extend shake into a
speed-proportional term.

---

## 6. What makes a swing feel BAD — the criticism, collected

Sourced primarily from three structured critiques: the r/Games 2018 pre-launch
thread, the 2022 Steam thread, and the GameFAQs cross-game comparison. Each item
below is **COMMUNITY-MEASURED** unless marked.

### 6.1 Momentum discontinuities at transitions
"The momentum is rapidly slowed down, almost like he's stopping in midair, and
he's back to default swinging speed." — "air brakes" on attach.
[r/Games 8rws2a] · Corroborated as physics by Gibbon's "collisional energy loss"
[DEVELOPER-STATED, Gibbon deep dive].

### 6.2 No punishment for bad timing, so no reward for good timing
"You can't really mess up… You just start running up the wall." · "It feels like
I'm bowling with the bumpers up." · "It's disappointing that the web slinging
doesn't require any skill, and that you don't pay any price if you make a
mistake. **It's unrewarding.**" [Steam 4859966604386424625]

### 6.3 Assists that silently rescue a bad arc
"If you mis-judge a swing and the bottom of your arc is going to have you slamming
into the street, don't worry! **Your web magically shortens** and you keep
swinging." [Steam thread, item 2.5] — *this is `GROUND_CLEAR` + `SHORTEN_RATE`,
named as a defect.*

### 6.4 Unclear anchor rules
Fristrom on Web of Shadows: "I hated that you could swing from the sky again."
[DEVELOPER-STATED] · On 2012's *Amazing*: "when you're on top of the tallest
building around and the game gives you one more swing off of nothing, that's the
only time I really noticed how fake it was." [GameFAQs] · "Some webzips don't seem
to connect to anything. And no, the webs can't be that long." [r/Games 8rws2a]

### 6.5 The web ignoring the world
"The web is shooting through the 4th dimension… it totally ignores street lights
and even entire buildings." [Steam, item 3] · "In Spider-Man 2, your web would
catch and bend on the upper lip of the entrance." [onthecrtscreen]

### 6.6 Animation leading physics
"He begins moving into the swing when nothing is carrying him yet… Insomniac set
the webline animation out of sync with the gameplay." [Steam, item 6] · "It looks
a bit stupid how Spidey just starts levitating for a second and how the most basic
laws of physics stop applying to him before the web actually attaches itself to
something." [Steam, comment #8]

### 6.7 An over-eager speed governor
"The governing system seems WAY too aggressive… let's go ahead and drop you 30%
even though with a turn like that you should actually have GAINED some speed."
[Steam, item 5]

### 6.8 Forced release
"I wish Spiderman didn't let go of the web after a set amount of time." [Steam,
item 4] · "The game does not let you hold on to your web indefinitely. It
automatically lets you go when you reach the apex." [GameFAQs]

### 6.9 The camera
Energy Hook: erratic, focuses on walls, disorienting [videochums] · Gravity Rush:
no auto-correct after a shift [r/gravityrush] · *Web-Slinger has a confirmed
instance of this class open right now* (HANDOFF §2).

### 6.10 Floaty arcs
**DEVELOPER-STATED, and the one place the genre defends floatiness:** Insomniac
deliberately *retained* "a sense of 'floatiness'" for **web gliding** while
tuning it [gamedeveloper.com GDC 2024 coverage]. The distinction is that a glide
is supposed to feel buoyant; a *pendulum* is not. `hero-consts.js` already names
the mechanism correctly — "'Hold to travel' floatiness IS the long arc" — which
is the right diagnosis, and the anchor scoring already acts on it.

---

## 7. Where the research contradicts what this project currently believes

### 7.1 "A rigid constraint does no work" is true — and it is being applied to a
###      case where it is false

`CLAUDE.md` states it as an invariant: *"The tether may redirect velocity; it may
never lengthen it."* `hero.js` enforces it with an unconditional rescale after the
clamp, and the comment records the measurement that motivated it (146 m/s against
a 52 m/s cap).

**The invariant is correct for a fixed-length tether and incorrect for a
shortening one.** A pendulum whose length is reduced while it swings gains
tangential speed — conservation of angular momentum, `v_t · L` constant. This is
not a bug in the physics; it is *parametric pumping*, and it is the same
mechanism as a child pulling in on a swing's chains. Two consequences:

1. **It is the genre's marquee speed technique.** Fristrom, on wrapping:
   "wrapping around lets you do some cool slingshoty whippy type stuff"
   [DEVELOPER-STATED, AMA], in direct reply to a player describing wrapping as
   giving "a **huge speed boost**" precisely because it "shorten[s] the length of
   web I was swinging from". Web-Slinger's blanket rescale makes that technique
   impossible to implement, because the reel-in's legitimate energy gain is
   deleted on the same frame it is created.
2. **It also taxes the ground-clearance assist.** `SHORTEN_RATE: 18` m/s reels the
   tether in constantly during the descent of most arcs. Every metre of that
   shortening should be adding tangential speed; the rescale removes it. CLAUDE.md's
   own rule — *"assists may redirect momentum; they may not tax it"* — is being
   violated by the invariant one paragraph above it.

**The 146 m/s measurement was real, but it was diagnosing the wrong thing.** An
unbounded gain from a *discrete* clamp correction is a numerical artifact; a
bounded gain from a *known* length change is physics. The correct fix separates
them, and Fristrom's own remedy is the shape of it: enforce the rail on the
pathological case, not on every frame. See §8, change B.

### 7.2 The project's assist list is, item for item, the criticism list

`hero-consts.js` documents each assist as "the PS4 assist" or "Insomniac's special
anchor", i.e. as a feature borrowed from the reference game. The research finds
that **five of them are individually the named complaints about that game**:

| Web-Slinger | Named as a defect in | Source |
|---|---|---|
| `ASSIST_Y: 14` synthetic sky anchor | "I hated that you could swing from the sky again" | Fristrom, DEVELOPER-STATED |
| `GROUND_CLEAR` + `SHORTEN_RATE` auto-shorten | "your web magically shortens and you keep swinging" | Steam, item 2.5 |
| Auto wall-run on contact | "contact = Spider-Man exploding into a sprint… feels cheap and cheated" | r/Games 8rws2a |
| `OVERSPEED_DRAG` above `VMAX` | "the governing system seems WAY too aggressive" | Steam, item 5 |
| Side-alternation bias in `pickAnchor` | "I can REALLY feel the game guiding my swings around" | Steam, item 6 |

This is not an argument for deleting them — 2023 shipped all of them and shipped
a **slider**, and players converged on 4–8 out of 10, not 0. It is an argument
that **they must be one parameter, exposed, and tested at both ends.** Right now
they are five independent hardcoded constants and no test drives them off.

### 7.3 Anchor scoring is missing the term the physics literature says matters most

`pickAnchor` scores length-to-ideal, height, aim, and side-alternation. Gibbon's
finding is that the dominant determinant of whether a swing *starts* cleanly is
the angle between the tether and the current velocity, and that anything other
than perpendicular incurs "collisional energy loss" [DEVELOPER-STATED]. The
comment in `hero.js` says "The scoring is the whole feel of the swing", and it is
right — but the term the literature identifies is absent.

### 7.4 The FOV kick saturates before the speed band the game lives in

§5.2. `spN` caps at 40 m/s; measured cruise is 42 m/s. **ANALYSIS.**

### 7.5 The auto-release penalty is a 0.01 rad cliff

`AUTO_RELEASE_PHI: 0.62` vs `RELEASE_PEAK_HI: 0.61`. The design intent (manual
peak-timed release must beat holding) is correct and corroborated by §4.1, but
the margin enforcing it is a rounding error. **ANALYSIS.**

---

## 8. Concrete changes the research supports

Ordered by expected feel-per-effort. Each names the constant or function, the
direction, and the source. **None of these has been applied — this pass was
read-only and a Playwright run was in flight.**

### A. Add a perpendicularity term to `pickAnchor` scoring — `hero.js`
Score each candidate by `|cos(angle between (hit − chest) and v)|`, penalising
non-perpendicular attaches; weight it comparably to `lenS`. New constant
`ANCHOR_PERP_W` in `hero-consts.js`.
*Source:* Gibbon deep dive, DEVELOPER-STATED — "gibbons ideally want their grab
arm to be reaching out perpendicularly to their velocity… Anything else causes a
'collisional energy loss'."
*Expected:* removes the "air brakes" class of feel (§2.3, §6.1) at attach, and
makes fast dive-into-swing transitions preserve speed. Measurable now via
`obs()`: speed immediately before vs. 3 frames after attach.

### B. Split the post-clamp rescale into two rules — `hero.js`
Replace the unconditional `spAfter > spBefore → rescale` with:
1. **Projection rule (keep).** For a *fixed*-length clamp, project velocity onto
   the tether's tangent plane rather than re-deriving from positions. A pure
   projection cannot increase speed, so the rescale becomes unnecessary rather
   than compensatory.
2. **Reel-in rule (new).** When `tether` decreased this frame by `dL`, scale the
   *tangential* component by `L_before / L_after`, clamped by a new
   `REEL_GAIN_MAX` (start ~1.02 per frame at 60 Hz) so a large correction cannot
   run away.
3. **Keep `VHARD` as the rail.**
*Source:* Fristrom AMA, DEVELOPER-STATED (wrapping shortens the web and gives "a
huge speed boost" / "slingshoty whippy type stuff"); Fristrom tutsplus,
DEVELOPER-STATED, on the rail-not-rescale remedy; conservation of angular
momentum, ANALYSIS.
*Contradicts:* the CLAUDE.md invariant as currently written — that line needs the
fixed-vs-shortening distinction added, not deletion.

### C. Implement tether line-of-sight: break / wrap / pass-through — `hero.js` + `webline.js`
Raycast the tether each frame. Blocker within `WEB_BREAK_D` of the hero → release;
between that and `WEB_WRAP_D` → re-pivot the anchor to the hit point and set
`tether` to the remaining length; beyond → ignore. New constants `WEB_BREAK_D`
(~6), `WEB_WRAP_D` (~20).
*Source:* Fristrom tutsplus, DEVELOPER-STATED — the exact three-step rule as
shipped in Spider-Man 2. Corroborated as the discriminating feature by
onthecrtscreen (COMMUNITY-MEASURED) and as the standing complaint about the 2018
game (Steam item 3).
*Note:* this is PLAN.md §2.3 already, but with (B) in place it also becomes the
game's primary skill-expressive speed source, not just an anti-clipping fix.
Depends on B — wrapping without the reel-in gain is a pure penalty.

### D. Collapse the five assists onto one exposed `ASSIST` scalar — `hero-consts.js`
Introduce `ASSIST` (0…1, default ~0.6) and derive: `ASSIST_Y` (0 at ASSIST=0),
the effective `SHORTEN_RATE`, the wall-run auto threshold, the side-alternation
weight `strS`, and `OVERSPEED_DRAG`. Persist it in `store.js`; expose via
`__spidey`.
*Source:* Marvel's Spider-Man 2 (2023) shipped exactly this as a 0–10 slider,
DEVELOPER-STATED by shipping; players converged on 4–8, COMMUNITY-MEASURED
(r/SpidermanPS4 178cu49). The five-item mapping in §7.2.
*Expected:* makes PLAN.md §2.2's skill-ceiling claim testable — run the 500 m
course at ASSIST 0 and 1 and compare best-of-N, not mean.

### E. `ASSIST_Y` — make the fallback anchor a *real* one, or remove it
At ASSIST=0 it must not fire at all. Above 0, prefer widening the ray fan and
extending `ANCHOR_MAX` before synthesising a point in empty air; if a synthetic
anchor is unavoidable, clamp it so it still lies on the ray toward real geometry.
*Source:* Fristrom, DEVELOPER-STATED — the one regression he names by name in a
game he otherwise liked ("I hated that you could swing from the sky again");
corroborated by the "one more swing off of nothing" and "webzips don't seem to
connect to anything" complaints, COMMUNITY-MEASURED.

### F. Gate the auto wall-run on direction, and add a non-punishing alternative — `hero.js`
Require the wall-run to be *steered into* (drop the `sp > WALLRUN_AUTO_V` OR-branch
that fires on speed alone), and add Fristrom's speed-gated push-away as the
default outcome of an unsteered brush: nudge the hero off the facade instead of
converting the collision into free vertical progress. New constant
`WALL_REPEL` (m/s²), gated on `sp > WALLRUN_MIN_V`.
*Source:* Fristrom tutsplus, DEVELOPER-STATED — Ultimate Spider-Man's push-away
plus his own suggested improvement ("only pushing away if the character is going a
certain speed"); the "contact = exploding into a sprint" criticism, COMMUNITY-MEASURED.

### G. Widen and re-scale the FOV response — `cameras.js`
Change `spN` to normalise against `VMAX` (66) rather than 40, and raise the swing
mode ceiling from 80° toward ~95–100°. Make the damping asymmetric (fast in, slow
out) as PLAN.md §2.7 already specifies; `damp(fov, v.fov, 4, dt)` is currently
symmetric.
*Source:* Van Veen et al. 1998 via Caramenti et al. 2019, LAB-MEASURED — speed
underestimated below 73° FoV, *over*estimated above 107°; the saturation
measurement in §5.2, ANALYSIS.
*Cost:* zero GPU. This is the best perceived-speed-per-millisecond item available.

### H. Drive the wind layer hard off speed — `audio.js`
Give wind several dB of range between cruise and peak rather than a subtle sweep.
*Source:* Horswill & Plooy 2008, LAB-MEASURED — a **5 dB** attenuation
significantly lowered judged speed **for every participant**.
*Cost:* zero GPU.

### I. Put the speed cue in the periphery, not the centre — render path
Prefer, in order: speed-modulated vignette radius/strength → view-locked radial
particle streaks near the camera → radial blur. Skip chromatic aberration.
*Source:* Caramenti et al. 2019, LAB-MEASURED — 41.30% underestimation with the
periphery masked vs 10.22% with only the periphery visible; NVIDIA GPU Gems 3
ch. 27 on motion blur and sense of speed, DEVELOPER-STATED; ANALYSIS for the
cost ordering.

### J. Widen the auto-release margin — `hero-consts.js`
Raise `AUTO_RELEASE_PHI` to ~0.75 rad, or lower `RELEASE_PEAK_HI` to ~0.55, so the
penalty at forced release is unambiguous rather than 0.01 rad wide. Then assert it:
a run that never presses release must lose to a peak-timed run by ≥20% (PLAN.md §2.2).
*Source:* §4.1, ANALYSIS; forced release is a named complaint in two games
(COMMUNITY-MEASURED), so the auto-release must remain clearly *worse* than playing
well or it becomes the dominant strategy.

### K. Do not add a speed-proportional camera shake — `cameras.js`
Leave trauma shake as an impact cue only.
*Source:* §5.4, ANALYSIS; disorientation is the top-line criticism of both Energy
Hook and Gravity Rush, COMMUNITY-MEASURED.

### L. Fix the canyon camera clip before any of the above ships
*Source:* every free-motion traversal game surveyed has camera as its dominant
criticism (§3.4, §6.9), COMMUNITY-MEASURED; the defect is already confirmed in
`docs/HANDOFF.md` §2 at 0.30 of frames against a 0.15 budget.

---

## 9. Source index

**Developer-stated**
- Fristrom, *Swinging Physics for Player Movement* — https://code.tutsplus.com/swinging-physics-for-player-movement-as-seen-in-spider-man-2-and-energy-hook--gamedev-8782t
- Fristrom AMA, r/Games — https://www.reddit.com/r/Games/comments/1ep0ed/i_invented_the_swinging_in_spiderman_2_now_im/
- Fristrom interview, Eurogamer — https://www.eurogamer.net/13-years-later-spider-man-2s-swinging-has-never-been-bettered-heres-its-story
- Fristrom, GDC 2019 classic postmortem (index) — https://www.gdcvault.com/play/1025725/Classic-Game-Design-Postmortem-Swinging · https://www.gamedeveloper.com/design/video-designing-i-spider-man-2-i-s-classic-web-swinging-mechanic
- Sheehan, *Higher, Faster, Farther*, GDC 2024 — https://gdcvault.com/play/1034327/Higher-Faster-Farther-Evolving-Traversal
- GDC 2024 talk coverage — https://www.gamedeveloper.com/programming/how-spider-man-2-s-traversal-physics-sling-a-faster-superhero-fantasy
- Insomniac tech interview (Fitzgerald, Lee, Sheehan), IGN — https://www.ign.com/articles/insomniac-answers-all-of-our-questions-about-spider-man-2s-ps5-tech
- Ryan Smith on Web Wings — https://gamingbolt.com/marvels-spider-man-2-devs-reveal-new-open-world-and-traversal-details
- Insomniac on physics-based swinging, 2017 — https://www.vg247.com/marvels-spider-man-will-have-physics-based-web-swinging-and-webs-must-tether-to-surfaces
- Boxerman, *Physics-based animation in Gibbon* — https://www.gamedeveloper.com/programming/deep-dive-physics-based-animation-in-gibbon-beyond-the-trees
- NVIDIA GPU Gems 3 ch. 27, motion blur — https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-27-motion-blur-post-processing-effect

**Community-measured**
- *Locomotion and Momentum in "Spider-Man 2"* — https://onthecrtscreen.wordpress.com/2015/07/07/locomotion-and-momentum-in-spider-man-2/
- "The concerning state of PS4 Spider-Man's webswinging", r/Games — https://www.reddit.com/r/Games/comments/8rws2a/the_concerning_state_of_ps4_spidermans_webswinging/
- "Web swinging is poor", Steam — https://steamcommunity.com/app/1817070/discussions/0/4859966604386424625/
- "Webswinging Comparison (Spidey 2, WOS, Ultimate)", GameFAQs — https://gamefaqs.gamespot.com/boards/647137-the-amazing-spider-man/63426564
- Swing assist explanation, r/SpidermanPS4 — https://www.reddit.com/r/SpidermanPS4/comments/178cu49/swing_assist_explanation/
- Energy Hook review — https://videochums.com/review/energy-hook
- Energy Hook hands-on — https://gamecritics.com/mike-suskie/energy-hook-hands-on-preview/
- Titanfall 2 grapple analysis — https://www.jordanrobertguy.com/home/titanfall-2-grabbing-that-grappling-hook
- Miles Morales venom-boost description — https://mcccagora.com/2020/11/27/spider-man-miles-morales-swings-in-with-style/
- Insomniac traversal, r/SpidermanPS4 — https://www.reddit.com/r/SpidermanPS4/comments/15juwqn/anybody_else_thinks_insomniacs_traversal_gets_a/
- Sekiro grapple point readability — https://www.reddit.com/r/Sekiro/comments/9eja7p/how_do_people_feel_about_the_popup_displaying_for/
- Gravity Rush camera — https://www.reddit.com/r/gravityrush/comments/1o4j5zf/hey_gravity_shifters_is_it_normal_for_the_camera/
- 2004-vs-2018 overview — https://screenrant.com/marvels-spider-man-2-web-slinging-mechanics-physics/

**Lab-measured**
- Caramenti et al. 2019, *Front. Psychol.* — https://pmc.ncbi.nlm.nih.gov/articles/PMC6812648/ (contains Van Veen 1998, Banton 2005, Pretto 2009)
- Horswill & Plooy 2008, *Perception* 37(7) — https://journals.sagepub.com/doi/abs/10.1068/p5736
- Wu et al. 2017, *PLOS ONE* — https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0185347
