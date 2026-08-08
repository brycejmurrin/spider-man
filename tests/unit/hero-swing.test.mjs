/* hero-swing.test.mjs — the traversal model, characterized.
 *
 * Every assertion here is RELATIVE or structural: "swinging carries further
 * than falling", "a dive builds speed", "the tether never stretches". Absolute
 * magnitudes go stale the first time the model is retuned, and this file is
 * meant to survive tuning while still failing loudly if the model breaks.
 *
 * It runs against the real generated city, in bare Node, in about two seconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCity } from "../../js/city/citygen.js";
import { createHero } from "../../js/game/hero.js";
import { HeroConsts as C } from "../../js/game/hero-consts.js";

const city = buildCity(42);
const DT = 1 / 60;

function run(input, steps, start) {
  const h = createHero(city.colliders);
  const s = start || { x: 8, y: 60, z: -520, speed: 14, head: 0 };
  h.reset(s.x, s.y, s.z, s.speed, s.head);
  const trace = [];
  for (let i = 0; i < steps; i++) {
    h.step(typeof input === "function" ? input(i, h) : input, DT);
    trace.push([h.p[0], h.p[1], h.p[2], h.speed, h.state]);
  }
  return { h, trace };
}

test("a hero left alone falls and lands, and stays landed", () => {
  const { h } = run({}, 600);
  assert.equal(h.state, "ground");
  assert.ok(Math.abs(h.v[1]) < 0.001, `still moving vertically: ${h.v[1]}`);
});

test("swinging carries further than falling from the same start", () => {
  const fell = run({}, 300).h;
  const swung = run({ swing: true }, 300).h;
  const dFell = Math.hypot(fell.p[0] - 8, fell.p[2] + 520);
  const dSwung = Math.hypot(swung.p[0] - 8, swung.p[2] + 520);
  assert.ok(dSwung > dFell * 1.3, `swung ${dSwung.toFixed(0)} m vs fell ${dFell.toFixed(0)} m`);
});

test("swinging keeps the hero airborne far longer than falling", () => {
  const fell = run({}, 300).trace.filter((t) => t[4] === "ground").length;
  const swung = run({ swing: true }, 300).trace.filter((t) => t[4] === "ground").length;
  assert.ok(swung < fell, `swinging spent ${swung} frames grounded vs ${fell} falling`);
});

test("the same inputs replay exactly — no hidden randomness in the model", () => {
  // Any Math.random reachable from step() would break every A/B, benchmark and
  // regression comparison this project will ever run.
  const a = run({ swing: true, dirZ: 1 }, 400).trace;
  const b = run({ swing: true, dirZ: 1 }, 400).trace;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // ...and it actually moved, so the equality is not trivially true of a
  // frozen hero.
  assert.ok(Math.hypot(a.at(-1)[0] - 8, a.at(-1)[2] + 520) > 50);
});

test("a different input produces a different trajectory", () => {
  const straight = run({ swing: true }, 300).h;
  const steered = run({ swing: true, dirX: 1 }, 300).h;
  assert.notEqual(straight.p[0].toFixed(3), steered.p[0].toFixed(3));
});

test("the tether never stretches beyond its length while attached", () => {
  // The constraint is the swing. If position can drift outside the sphere the
  // pendulum silently stops being one.
  const { trace, h } = run({ swing: true }, 500);
  let checked = 0;
  const hero = createHero(city.colliders);
  hero.reset(8, 60, -520, 14, 0);
  for (let i = 0; i < 500; i++) {
    hero.step({ swing: true }, DT);
    if (hero.anchor) {
      const d = Math.hypot(hero.p[0] - hero.anchor[0],
                           hero.p[1] + 1.4 - hero.anchor[1],
                           hero.p[2] - hero.anchor[2]);
      assert.ok(d <= hero.tether + 0.05, `tether ${hero.tether.toFixed(2)} but distance ${d.toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} attached frames — the swing never engaged`);
});

test("the speed cap is soft: overshoot happens, then decays", () => {
  // VMAX is a DRAG threshold, not a clamp — a dive slingshot is supposed to
  // exceed it briefly, and a hard clamp there would pop visibly. What must
  // hold is that overshoot is bounded and transient.
  const { trace } = run({ swing: true, dirZ: 1 }, 900);
  const top = Math.max(...trace.map((t) => t[3]));
  assert.ok(top < C.VHARD, `top speed ${top.toFixed(1)} hit the hard rail ${C.VHARD}`);
  assert.ok(top > 20, `top speed only ${top.toFixed(1)} — traversal is not building momentum`);
  const over = trace.filter((t) => t[3] > C.VMAX).length;
  assert.ok(over / trace.length < 0.15,
    `${((over / trace.length) * 100).toFixed(0)}% of frames above the cap — the drag is not pulling it back`);
});

test("a dive builds more speed than a neutral fall", () => {
  const plain = run({}, 90).h.speed;
  const dived = run({ dive: true }, 90).h.speed;
  assert.ok(dived > plain * 1.2, `dive ${dived.toFixed(1)} vs fall ${plain.toFixed(1)}`);
});

test("web-zip adds speed once, then respects its cooldown", () => {
  const noZip = run({}, 30).h.speed;
  const oneZip = run((i) => ({ zip: i === 0 }), 30).h.speed;
  const spammed = run(() => ({ zip: true }), 30).h.speed;
  assert.ok(oneZip > noZip, "a zip must add speed");
  // Spamming inside the cooldown must not stack: allow one extra zip's worth.
  assert.ok(spammed < oneZip + C.ZIP_BOOST, `zip spam stacked to ${spammed.toFixed(1)}`);
});

test("the hero never falls through the world", () => {
  const { trace } = run({ swing: true, dirZ: 1 }, 1200);
  for (const [x, y, z] of trace) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), "non-finite position");
    assert.ok(y >= -1, `fell to y=${y}`);
  }
});

test("the hero never ends up inside a building", () => {
  const { trace } = run({ swing: true, dirZ: 1 }, 900);
  let worst = 0;
  for (const [x, y, z] of trace) {
    for (const hy of [0.4, 1.3]) {
      const clip = city.colliders.sphereClip([x, y + hy, z], C.RADIUS * 0.9);
      if (clip) worst = Math.max(worst, clip.depth);
    }
  }
  // Collide-and-slide resolves after integration, so a frame may end a few cm
  // inside; a hero PARKED inside a wall shows up as a large residual.
  assert.ok(worst < 0.25, `deepest wall penetration ${worst.toFixed(3)} m`);
});

test("running on the ground reaches run speed and stops when released", () => {
  const h = createHero(city.colliders);
  const b = city.colliders.list[0];
  h.reset(b.cx, b.y1, b.cz, 0, 0);
  for (let i = 0; i < 120; i++) h.step({ dirZ: 1 }, DT);
  assert.equal(h.state, "ground");
  assert.ok(Math.abs(h.speed - C.RUN_V) < 0.5, `run speed ${h.speed.toFixed(2)}`);
  for (let i = 0; i < 120; i++) h.step({}, DT);
  assert.ok(h.speed < 0.5, `did not stop: ${h.speed.toFixed(2)}`);
});

test("anchor selection prefers points above the hero", () => {
  const h = createHero(city.colliders);
  h.reset(8, 30, -520, 10, 0);
  let found = 0;
  for (let i = 0; i < 40; i++) {
    h.reset(8 + i * 3, 30, -520 + i * 7, 10, 0);
    const a = h.pickAnchor(0);
    if (!a) continue;
    found++;
    assert.ok(a[1] > h.p[1], `anchor at y=${a[1]} is not above the hero at ${h.p[1]}`);
  }
  assert.ok(found > 20, `only ${found}/40 positions found an anchor — the city is too sparse to swing`);
});

test("a low hero always finds an anchor (the never-stranded assist)", () => {
  // Insomniac's 'special attach point': skimming the street with nothing
  // overhead must still produce a swing, or the player face-plants and stops.
  const h = createHero(city.colliders);
  for (let i = 0; i < 20; i++) {
    h.reset(-300 + i * 30, 2, -300 + i * 21, 12, i * 0.3);
    assert.ok(h.pickAnchor(0), `no anchor at low altitude, sample ${i}`);
  }
});

test("every immutable constant is finite and sensibly signed", () => {
  for (const [k, v] of Object.entries(C)) {
    assert.ok(Number.isFinite(v), `${k} is not finite`);
    assert.ok(v > 0, `${k} should be positive, got ${v}`);
  }
  assert.ok(C.TETHER_MIN < C.TETHER_MAX, "tether range inverted");
  assert.ok(C.RUN_V < C.VMAX, "running is faster than the swing cap");
});
