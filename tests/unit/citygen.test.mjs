/* citygen.test.mjs — the city builds headlessly, deterministically, and with
 * the shape the traversal model assumes.
 *
 * This suite is the reason js/city/* imports nothing from js/render/: the whole
 * generator runs in bare Node in ~2 s, so every rule about the world is
 * testable without a browser, a GPU or a screenshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCity, CITY, hash } from "../../js/city/citygen.js";
import { DISTRICTS, districtOf } from "../../js/city/city-data.js";

const city = buildCity(42);

test("hash is deterministic and roughly uniform in [0,1)", () => {
  assert.equal(hash(1.5), hash(1.5));
  let n = 0, sum = 0;
  for (let i = 0; i < 4000; i++) { const v = hash(i * 1.37); assert.ok(v >= 0 && v < 1); sum += v; n++; }
  const mean = sum / n;
  assert.ok(mean > 0.44 && mean < 0.56, `hash mean ${mean} is not near 0.5`);
});

test("the same seed builds a byte-identical city", () => {
  const a = buildCity(7), b = buildCity(7);
  assert.deepEqual(a.stats, b.stats);
  assert.equal(a.out.pos.length, b.out.pos.length);
  // spot-check the buffers rather than deep-equalling 1.4M floats
  for (const i of [0, 999, 50_000, a.out.pos.length - 1]) assert.equal(a.out.pos[i], b.out.pos[i]);
  assert.deepEqual(a.colliders.list.map((x) => x.y1), b.colliders.list.map((x) => x.y1));
});

test("a different seed builds a different city", () => {
  // Without this, "deterministic" could be satisfied by a constant and the
  // test above would pass against a generator that ignores its seed.
  const other = buildCity(9);
  assert.notDeepEqual(other.colliders.list.map((x) => x.y1), city.colliders.list.map((x) => x.y1));
});

test("the city has enough buildings, lamps and geometry to read as a city", () => {
  assert.ok(city.stats.buildings > 700, `only ${city.stats.buildings} buildings`);
  assert.ok(city.stats.lamps > 400, `only ${city.stats.lamps} lamps`);
  assert.ok(city.stats.propVerts > 500_000, `only ${city.stats.propVerts} prop verts`);
  assert.ok(city.stats.glassVerts > 100_000, "no reflective glass was emitted");
});

test("facade furniture is instanced, not baked per building", () => {
  // The single most important perf property of the port: every window pane,
  // rail and mullion in the city is ONE unit-box model plus a transform. If
  // reuse collapses, something started minting a model per placement.
  const g = city.stats.graph;
  assert.ok(g.nodes > 20_000, `only ${g.nodes} graph nodes`);
  assert.ok(g.models < 20, `${g.models} models — expected a handful`);
  assert.ok(g.reuse > 500, `instance reuse fell to ${g.reuse}`);
  assert.equal(g.dropped, 0, "placements were dropped");
});

test("building heights span the district profiles, tall to low", () => {
  // Group by `bid`: colliders.list is one record per SECTION, not per building.
  // Taking b.y1 straight off the list measures section tops, whose median is
  // a podium rather than a roofline (18.9 m vs 22.4 m on seed 42).
  const tops = new Map();
  for (const b of city.colliders.list) tops.set(b.bid, Math.max(tops.get(b.bid) || 0, b.y1));
  const hs = [...tops.values()].sort((a, b) => a - b);
  const p = (q) => hs[Math.floor(hs.length * q)];
  assert.ok(p(0.5) > 12 && p(0.5) < 60, `median height ${p(0.5)} m is off`);
  assert.ok(p(0.9) > 40, `p90 height ${p(0.9)} m — no tall stock to swing between`);
  assert.ok(hs[hs.length - 1] > 120, `tallest is only ${hs[hs.length - 1]} m`);
  assert.ok(hs[0] >= 5, `shortest is ${hs[0]} m`);
});

test("districts are radial: the core is taller than the rim", () => {
  const N = CITY.BLOCKS, H = N * CITY.PITCH / 2;
  const meanH = (pred) => {
    const v = city.colliders.list.filter(pred).map((b) => b.y1);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  const dOf = (b) => districtOf(
    Math.max(0, Math.min(N - 1, Math.floor((b.cx + H) / CITY.PITCH))),
    Math.max(0, Math.min(N - 1, Math.floor((b.cz + H) / CITY.PITCH))), N, N);
  const mid = meanH((b) => dOf(b) === "midtown");
  const low = meanH((b) => dOf(b) === "lowrise");
  assert.ok(mid > low * 1.5, `midtown mean ${mid} should tower over lowrise ${low}`);
});

test("no building footprint overlaps a street", () => {
  // Streets are reserved by construction (lots live inside the block minus the
  // sidewalk), so a building on the asphalt means the lot maths drifted.
  //
  // This got much stronger when colliders became one record per SECTION. It
  // used to see only the base footprint, so an offset upper mass could stand
  // in the street unseen — and two did: `arch` legs 10.4 m out and `notch`
  // towers 8.4 m out, both because they were narrowed on one axis and
  // displaced along the other at full depth. Both fixed in buildings.js.
  const half = CITY.BLOCK / 2 - CITY.SIDEWALK;
  const N = CITY.BLOCKS, H = N * CITY.PITCH / 2;
  for (const b of city.colliders.list) {
    const bx = Math.floor((b.cx + H) / CITY.PITCH), bz = Math.floor((b.cz + H) / CITY.PITCH);
    const cx = -H + CITY.PITCH * (bx + 0.5), cz = -H + CITY.PITCH * (bz + 0.5);
    // Project the ORIENTED box onto each world axis. Using the diagonal
    // (hypot(hw,hd)) instead over-reports by up to 41% and fails a city that
    // is actually inside its blocks — measured, on the first run of this test.
    const c = Math.abs(Math.cos(b.rot)), s = Math.abs(Math.sin(b.rot));
    const ex = b.hw * c + b.hd * s, ez = b.hw * s + b.hd * c;
    assert.ok(Math.abs(b.cx - cx) + ex <= half + 2.5, `building at ${b.cx} escapes its block in x`);
    assert.ok(Math.abs(b.cz - cz) + ez <= half + 2.5, `building at ${b.cz} escapes its block in z`);
  }
});

test("every district profile is well formed", () => {
  for (const [name, d] of Object.entries(DISTRICTS)) {
    assert.ok(d.h[0] > 0 && d.h[1] > 0, `${name} height range`);
    assert.ok(d.hMax >= d.h[0] + d.h[1], `${name} hMax below its own range`);
    assert.ok(d.kinds.length > 0 && d.neon.length > 0 && d.dayPal.length > 0, `${name} empty table`);
    assert.ok(d.bias >= 0 && d.bias <= 1, `${name} bias out of range`);
  }
});

test("geometry carries no NaN and no absurd coordinates", () => {
  const span = city.span * 1.5;
  for (const buf of [city.out, city.glassBuf, city.ground]) {
    for (let i = 0; i < buf.pos.length; i++) {
      const v = buf.pos[i];
      if (!Number.isFinite(v) || Math.abs(v) > span + 500) {
        assert.fail(`bad vertex component at ${i}: ${v}`);
      }
    }
    assert.equal(buf.pos.length / 3, buf.mat.length, "one MAT id per vertex");
  }
});
