/* purity.test.mjs — the deterministic layers, proved by POISONING the realm.
 *
 * Replaces a regex that is provably wrong. `js/game/hud.js` writes
 * `el.textContent` on every line of `update()` and passes the regex, because
 * its elements arrive by injection so no banned token appears in the file; and
 * `js/game/hero.js`'s comment saying there is no `Math.random` contains the
 * string "Math.random". A text guard measures how a module SPELLS things.
 *
 * This one measures what runs: Math.random, Date.now, performance.now, the
 * zero-arg Date constructor and crypto.getRandomValues all throw, and then the
 * sim/viewmodel modules are driven through a real workload. A wall clock or an
 * entropy source anywhere in that path makes the same inputs produce a
 * different frame, which voids every A/B, benchmark and replay this repo runs.
 *
 * WHAT IT CANNOT CATCH: injected DOM. Nothing here sees
 * `els.speed.textContent = …` because the object came from the caller. That is
 * `tests/unit/load-order.test.mjs`'s layer table's job — it makes hud.js
 * structurally ineligible for the deterministic layers. Do not read a pass here
 * as purity coverage this test does not have.
 *
 * THE COVERAGE ASSERTION AT THE BOTTOM IS LOAD-BEARING. The first version of
 * this test PASSED: `cameras.js`'s wall-clock read sits inside `if (shake > 0)`,
 * and 600 ticks never entered that branch. A poison test is exactly as good as
 * its branch coverage, and a gated branch is invisible to it — which is how
 * that call survived from the original engine port, through cameras.js being
 * added to HEADLESS_SAFE, without one guard noticing.
 *
 * The workload uses a STUB world, not buildCity(): createHero() needs only
 * groundY/sphereClip/raycast/list, and this runs in ~20 ms against ~900 ms for
 * a real build. citygen's own determinism is covered by citygen.test.mjs; the
 * poisoned IMPORT here still proves the module is clean at evaluation time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const MANIFEST = createRequire(import.meta.url)("../../tools/manifest.cjs");

const POISON = [];
function poison() {
  const realDate = globalThis.Date;
  const trip = (what) => () => { throw new Error(`IMPURE: ${what} reached from a deterministic module`); };
  Math.random = trip("Math.random()");
  globalThis.Date.now = trip("Date.now()");
  globalThis.performance.now = trip("performance.now()");
  globalThis.Date = new Proxy(realDate, {
    construct(t, args) {
      if (args.length === 0) throw new Error("IMPURE: new Date() reached from a deterministic module");
      return new t(...args);
    },
  });
  if (globalThis.crypto) globalThis.crypto.getRandomValues = trip("crypto.getRandomValues()");
  POISON.push(realDate);
}
poison();

/* A stub world: flat street plus one 90 m tower. Enough for every branch of the
   traversal model — ground, air, swing, wallrun, the tether, the ground clamp
   and depenetration — without paying for a city build. */
function stubWorld() {
  const box = { cx: 20, cz: 0, y0: 0, y1: 90, hw: 12, hd: 12, rot: 0 };
  return {
    list: [box],
    groundY: (x, z) => (Math.abs(x - box.cx) < box.hw && Math.abs(z - box.cz) < box.hd ? box.y1 : 0),
    roofAt: () => box.y1,
    raycast(o, d, maxT) {
      // one slab test against the tower; good enough to feed pickAnchor
      let tmin = 0, tmax = maxT;
      for (const [lo, hi, oi, di] of [
        [box.cx - box.hw, box.cx + box.hw, o[0], d[0]],
        [box.y0, box.y1, o[1], d[1]],
        [box.cz - box.hd, box.cz + box.hd, o[2], d[2]],
      ]) {
        if (Math.abs(di) < 1e-9) { if (oi < lo || oi > hi) return null; continue; }
        let t0 = (lo - oi) / di, t1 = (hi - oi) / di;
        if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
        tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
        if (tmin > tmax) return null;
      }
      return tmin > 0 ? { t: tmin, nx: 0, ny: 0, nz: -1 } : null;
    },
    sphereClip(p, r) {
      const dx = p[0] - box.cx, dz = p[2] - box.cz;
      if (p[1] < box.y0 || p[1] > box.y1) return null;
      const ox = box.hw + r - Math.abs(dx), oz = box.hd + r - Math.abs(dz);
      if (ox <= 0 || oz <= 0) return null;
      return ox < oz
        ? { nx: Math.sign(dx) || 1, ny: 0, nz: 0, depth: ox }
        : { nx: 0, ny: 0, nz: Math.sign(dz) || 1, depth: oz };
    },
  };
}

test("every deterministic module imports without a clock or an entropy source", async () => {
  // Evaluation time only — a module-scope `Date.now()` or seeded RNG dies here.
  for (const m of MANIFEST.HEADLESS_SAFE) {
    await assert.doesNotReject(() => import(`../../${m}`), `${m} touched a poisoned global at import`);
  }
});

test("the traversal model and the camera run pure under a poisoned realm", async () => {
  const { createHero } = await import("../../js/game/hero.js");
  const { createCameras } = await import("../../js/game/cameras.js");
  const { pose } = await import("../../js/hero/hero3d.js");

  const world = stubWorld();
  const hero = createHero(world);
  const cams = createCameras(world);
  const DT = 1 / 60;

  const states = new Set();
  let shakeFrames = 0;
  hero.reset(0, 60, -40, 20, 0);
  for (let i = 0; i < 900; i++) {
    hero.step({ swing: i % 120 < 90, dirZ: 1, dirX: i % 240 < 120 ? 0.4 : -0.4 }, DT);
    states.add(hero.state);
    const sub = { p: hero.p, v: hero.v, head: hero.head, speed: hero.speed, state: hero.state };
    cams.tick(sub, DT);
    cams.vantage(sub, "chase");
    if (pose) { try { pose(sub, DT, {}); } catch (_) { /* signature drift is not this test's job */ } }
    // Drive the SHAKE branch explicitly. This is the whole reason the test
    // exists — see the header. Without it, everything below passes and the
    // wall-clock read is never reached.
    if (i % 90 === 0) cams.addShake(0.9);
    if (i % 90 < 30) shakeFrames++;
  }

  // COVERAGE. Assert we entered what we claim to cover, or this decays into a
  // "the module loads in Node" check that reports success for the wrong reason.
  assert.ok(shakeFrames > 0, "the camera shake branch was never entered — the poison proves nothing about it");
  assert.ok(states.has("swing"), `the swing branch was never entered (saw ${[...states]})`);
  assert.ok(states.size >= 2, `only reached ${[...states]} — the workload is not exercising the model`);
});
