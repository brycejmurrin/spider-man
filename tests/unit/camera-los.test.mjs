/* camera-los.test.mjs — the camera's line of sight to the hero, headless.
 *
 * This is a Node reproduction of `city-visual.spec.js` › "the camera keeps line
 * of sight to the hero inside a street canyon", which costs ~4 minutes under
 * SwiftShader and has been failing at 0.30 of frames behind geometry against a
 * 0.15 budget. `js/game/cameras.js` imports nothing and `vantage()` is pure
 * over a colliders object, so the same assertion runs here in about two
 * seconds — which is the difference between a fix you can iterate on and one
 * you cannot.
 *
 * Because it is exact and deterministic, the budget here is ZERO. A browser
 * tolerance exists to absorb damping and frame timing; this calls the solver
 * directly, so any blocked sample is a real one.
 *
 * NOTE: drive with `hero.p` directly and never through `__spidey.obs()` —
 * obs() calls `hero.pickAnchor()` three times per call and mutates the
 * auto-straighten memory (`bestSide`), so polling it perturbs the trajectory
 * being measured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCity } from "../../js/city/citygen.js";
import { createHero } from "../../js/game/hero.js";
import { createCameras, CAM_MODES } from "../../js/game/cameras.js";

const city = buildCity(42, { night: true });
const DT = 1 / 60;

/* One canyon run: drive the hero, solve the vantage each sample, and cast the
   same ray the browser spec casts — subject chest -> eye, stopping just short
   of the eye so touching the eye's own surface is not a hit. */
function run(start, mode, samples = 40) {
  const hero = createHero(city.colliders);
  const cams = createCameras(city.colliders);
  cams.setMode(mode);
  hero.reset(start.x, start.y, start.z, start.speed, start.head || 0);

  const blocked = [];
  const dists = [];
  let n = 0;
  for (let i = 0; i < samples; i++) {
    for (let k = 0; k < 6; k++) hero.step({ swing: true, dirZ: 1 }, DT);
    const sub = { p: hero.p, v: hero.v, head: hero.head, speed: hero.speed, state: hero.state };
    const v = cams.vantage(sub, mode);
    const ox = hero.p[0], oy = hero.p[1] + 1.4, oz = hero.p[2];
    const dx = v.eye[0] - ox, dy = v.eye[1] - oy, dz = v.eye[2] - oz;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.5) continue;
    n++;
    dists.push(L);
    const hit = city.colliders.raycast([ox, oy, oz], [dx / L, dy / L, dz / L], L - 0.3);
    if (hit) {
      blocked.push(
        `${mode} @ (${hero.p[0].toFixed(0)}, ${hero.p[1].toFixed(0)}, ${hero.p[2].toFixed(0)})` +
        ` state=${hero.state} eyeDist=${L.toFixed(2)} hit at t=${hit.t.toFixed(2)}`);
    }
  }
  return { blocked, samples: n, dists };
}

// Canyon starts: low in the street where the facades are close, which is the
// case the clamp gets wrong. The first is the browser spec's own start.
const STARTS = [
  { x: 8, y: 25, z: -540, speed: 18 },
  { x: 8, y: 18, z: -300, speed: 22 },
  { x: -96, y: 22, z: -420, speed: 20, head: 0.4 },
  { x: 112, y: 30, z: -180, speed: 16, head: -0.3 },
  { x: 8, y: 45, z: -520, speed: 24 },
];

test("the chase camera never sits behind geometry in a street canyon", () => {
  const offenders = [];
  let total = 0;
  for (const s of STARTS) {
    const r = run(s, "chase");
    assert.ok(r.samples > 20, `too few samples from ${JSON.stringify(s)}: ${r.samples}`);
    total += r.samples;
    offenders.push(...r.blocked);
  }
  assert.deepEqual(offenders, [],
    `the camera spent ${offenders.length}/${total} solved frames behind geometry`);
});

test("every camera mode keeps its line of sight", () => {
  // The clamp is shared, but the modes sit at very different distances and
  // heights — "far" and "heli" reach over rooflines, "swing" hugs the hero.
  const offenders = [];
  for (const mode of CAM_MODES.map((m) => m.id)) {
    const r = run(STARTS[0], mode);
    assert.ok(r.samples > 20, `${mode}: too few samples`);
    offenders.push(...r.blocked);
  }
  assert.deepEqual(offenders, []);
});

test("the fix does not work by collapsing the camera onto the hero", () => {
  // The cheap way to pass the tests above is to jam the eye a few centimetres
  // from the subject, where nothing can come between them. That would be a
  // first-person camera, not a fixed clamp, so pin the framing too: most
  // frames must keep a real chase distance.
  const r = run(STARTS[0], "chase");
  const sorted = [...r.dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median > 3.5,
    `median eye distance collapsed to ${median.toFixed(2)} m — the camera is inside the hero`);
  const tiny = r.dists.filter((d) => d < 2).length;
  assert.ok(tiny / r.dists.length < 0.2,
    `${tiny}/${r.dists.length} frames pulled the eye under 2 m`);
});

test("the solved vantage is always finite and above the street", () => {
  const bad = [];
  for (const s of STARTS) {
    const hero = createHero(city.colliders);
    const cams = createCameras(city.colliders);
    hero.reset(s.x, s.y, s.z, s.speed, s.head || 0);
    for (let i = 0; i < 120; i++) {
      hero.step({ swing: true, dirZ: 1 }, DT);
      const v = cams.vantage(
        { p: hero.p, v: hero.v, head: hero.head, speed: hero.speed, state: hero.state }, "chase");
      if (!v.eye.every(Number.isFinite) || !v.tgt.every(Number.isFinite)) {
        bad.push(`non-finite vantage at ${hero.p.map((q) => q.toFixed(0))}`);
        break;
      }
      const street = city.colliders.groundY(v.eye[0], v.eye[2], v.eye[1] + 1);
      if (v.eye[1] < street) {
        bad.push(`eye ${v.eye[1].toFixed(1)} under ground ${street.toFixed(1)}`);
        break;
      }
    }
  }
  assert.deepEqual(bad, []);
});
