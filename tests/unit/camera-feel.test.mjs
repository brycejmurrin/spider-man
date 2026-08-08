/* camera-feel.test.mjs — the perceived-speed cues, in bare Node.
 *
 * These exist because of a specific failure this project reproduced in its own
 * code. A player finished Spider-Man 2 (2023) with the camera motion slider
 * shipped inverted and reported no sense of speed from identical physics: the
 * camera and post chain are the feature. Our camera roll had the same problem
 * by a different mechanism — the term was ALGEBRAICALLY ZERO and nobody
 * noticed for the life of the project, because nothing asserted that the
 * camera moved at all.
 *
 * So the first test here is worth more than the fix it guards: a cue that is
 * silently switched off passes every correctness test in the repo.
 *
 * Relative assertions, per docs/TESTING.md — except the nausea rail, which is
 * a real absolute limit and is labelled as one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCity } from "../../js/city/citygen.js";
import { createHero } from "../../js/game/hero.js";
import { createCameras } from "../../js/game/cameras.js";

const city = buildCity(42, { night: true });
const DT = 1 / 60;

/* A midtown swing run, driven through the real tick(). Note this reads
   hero.p directly and never __spidey.obs(), which calls pickAnchor() three
   times and mutates the auto-straighten memory — polling it would measure a
   perturbed system. */
function rollout(steps = 3600) {
  const hero = createHero(city.colliders);
  const cams = createCameras(city.colliders);
  hero.reset(8, 60, -540, 20, 0);
  const roll = [];
  for (let i = 0; i < steps; i++) {
    hero.step({ swing: true, dirZ: 1, dirX: i % 200 < 100 ? 0.5 : -0.5 }, DT);
    cams.tick({ p: hero.p, v: hero.v, head: hero.head, speed: hero.speed,
                state: hero.state, anchor: hero.anchor }, DT);
    if (hero.state === "swing") roll.push(cams.roll);
  }
  return roll;
}

test("the camera actually rolls while swinging", () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE DEAD TERM. The old slip-angle roll
  // measured max 1.10 deg / mean 0.009 deg over these same frames, against a
  // gain written for +-8 deg, because `head` is assigned from the velocity
  // vector on the last line of hero.step() and the term therefore cancels.
  const roll = rollout();
  assert.ok(roll.length > 500, `only ${roll.length} swing frames — the rollout is not swinging`);
  const max = Math.max(...roll.map(Math.abs));
  assert.ok(max > 0.05,
    `the camera barely rolls (max ${(max * 180 / Math.PI).toFixed(2)} deg). ` +
    "A perceived-speed cue that is silently off passes every other test here.");
});

test("roll follows the tether, not the heading", () => {
  // Two subjects identical in p/v/head/speed, anchors mirrored left and right.
  // A heading-derived term cannot tell them apart; a swing-plane term must.
  const mk = (side) => {
    const cams = createCameras(city.colliders);
    const sub = { p: [8, 60, -540], v: [0, -5, 30], head: 0, speed: 30, state: "swing",
                  anchor: [8 + side * 25, 90, -515] };
    for (let i = 0; i < 90; i++) cams.tick(sub, DT);
    return cams.roll;
  };
  const l = mk(-1), r = mk(1);
  assert.ok(Math.sign(l) !== Math.sign(r), `mirrored anchors gave the same sign (${l}, ${r})`);
  assert.ok(Math.abs(Math.abs(l) - Math.abs(r)) < Math.abs(r) * 0.25,
    `mirrored anchors gave lopsided magnitudes (${l}, ${r})`);
});

test("roll stays under the nausea rail", () => {
  // A genuine absolute limit, not a tuning threshold: past ~20 degrees a
  // continuously rolling third-person camera reads as sea-sickness rather than
  // as banking. Deliberately an absolute number, and labelled as one.
  const max = Math.max(...rollout().map(Math.abs));
  assert.ok(max < 0.35, `peak roll ${(max * 180 / Math.PI).toFixed(1)} deg exceeds the 20 deg rail`);
});

test("a vertical tether produces no bank", () => {
  // The degenerate case the clamped denominator exists for: an anchor directly
  // overhead has no lateral component, so there is nothing to bank into.
  const cams = createCameras(city.colliders);
  const sub = { p: [8, 60, -540], v: [0, -5, 30], head: 0, speed: 30, state: "swing",
                anchor: [8, 100, -540] };
  for (let i = 0; i < 120; i++) cams.tick(sub, DT);
  assert.ok(Math.abs(cams.roll) < 0.02, `a vertical tether banked ${cams.roll}`);
});
