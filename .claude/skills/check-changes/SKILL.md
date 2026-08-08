---
name: check-changes
description: Use when the user asks did I break anything, run the right tests, validate changes, ready to push, pre-commit or pre-push checks, or which tests a Web-Slinger change needs.
---

# Validate a change before pushing

The suite splits sharply by cost. Getting the order right is most of the value:
the cheap half catches most defects in ten seconds, and the expensive half is
minutes of software-rendered WebGL.

## Escalation ladder

1. **Always, after every edit — `npm run test:tooling-fast`.** ~10 s, no
   browser. It builds the whole city, drives the traversal model for thousands
   of steps, and checks the module graph. For a change under `js/city/`,
   `js/game/hero*.js` or `tools/`, this is often the whole answer.

2. **Touched `js/render/`, `js/game.js`, `index.html` or the module list —
   `npm run test:smoke`.** Proves the page still boots, WebGL2 initialises and
   the dev API answers. If this is red, nothing downstream means anything.

3. **Touched the traversal model or the dev API — `npm run test:swing`.**

4. **Touched cameras, lighting, the draw path or the post chain —
   `npm run test:visual`.**

## Then, four checks the suite does not make for you

**Look at it.** A renderer change that passes every assertion can still look
wrong. `node tools/_shot.mjs out.png 200 swing` gives a deterministic action
shot; read the image.

**Re-measure anything that touched the swing.** The tests are relative by
design, so a change that halves the cruise speed can pass all of them. The
numbers that matter are swing period, median tether length and distance per
minute — measure them the way `docs/PLAN.md` records them, and compare.

**Bump the cache version.** See the `bump-cache` skill. Forgetting it ships a
change returning players never see. Do it as the last edit before the commit,
never mid-test-run.

**Confirm the branch.** `git branch --show-current` is the truth; prose is not.

## Reading failures

Decide **stale expectation or real regression** before touching code. Relative
assertions ("swinging beats falling") are ground truth; a magnitude that drifted
is a test to fix, not code to bend.

But be slow to call something a stale threshold. Of the three defects found in
the first round of this project, two looked exactly like tolerance problems and
were not: the tether stretched because the anchor search range and the tether
length were different numbers, and speed blew past its cap because a rigid
constraint was doing work on the hero. A larger epsilon would have hidden both.

Only one Playwright process at a time. Two runs share a server, and killing
either makes the survivor's remaining tests die on connection-refused — which
reads like a product failure and is not.
