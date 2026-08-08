/* colliders.test.mjs — the gameplay city. Every traversal query the hero and
 * the camera make goes through this module, so its geometry is pinned here
 * against hand-computed answers rather than against the generator's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createColliders } from "../../js/city/colliders.js";

// Round a normal for comparison, folding -0 into 0: a face normal of exactly
// -0 on an unused axis is arithmetically identical to 0 but deepEqual reports
// them as different values.
const nrm = (v) => v.map((x) => { const r = Math.round(x); return r === 0 ? 0 : r; });

// One axis-aligned 20x20x30 tower centred at the origin, plus a rotated one.
function world() {
  const c = createColliders({});
  c.add({ cx: 0, cz: 0, y0: 0, y1: 30, hw: 10, hd: 10, rot: 0, kind: "slab" });
  c.add({ cx: 100, cz: 0, y0: 0, y1: 50, hw: 8, hd: 12, rot: Math.PI / 2, kind: "slab" });
  return c;
}

test("a ray straight at a face hits at the face, with the face normal", () => {
  const c = world();
  const h = c.raycast([-50, 15, 0], [1, 0, 0], 100);
  assert.ok(h, "expected a hit");
  assert.ok(Math.abs(h.t - 40) < 1e-6, `hit at t=${h.t}, expected 40`);
  assert.deepEqual(nrm([h.nx, h.ny, h.nz]), [-1, 0, 0]);
});

test("a ray that passes above the roof misses", () => {
  const c = world();
  assert.equal(c.raycast([-50, 31, 0], [1, 0, 0], 100), null);
});

test("a ray that stops short of the box misses", () => {
  const c = world();
  assert.equal(c.raycast([-50, 15, 0], [1, 0, 0], 30), null);
});

test("a downward ray hits the roof and reports an up normal", () => {
  const c = world();
  const h = c.raycast([0, 80, 0], [0, -1, 0], 100);
  assert.ok(h);
  assert.ok(Math.abs(h.t - 50) < 1e-6, `t=${h.t}`);
  assert.deepEqual(nrm([h.nx, h.ny, h.nz]), [0, 1, 0]);
});

test("rotation is respected: the rotated box is wider along x than its hw", () => {
  // rot = 90deg swaps the local axes, so the world-x half-extent is hd (12).
  const c = world();
  const hit = c.raycast([100 - 50, 20, 0], [1, 0, 0], 100);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - (50 - 12)) < 1e-6, `t=${hit.t}, expected 38`);
});

test("the nearest of several boxes wins", () => {
  const c = createColliders({});
  c.add({ cx: 60, cz: 0, y0: 0, y1: 30, hw: 5, hd: 5, rot: 0 });
  c.add({ cx: 30, cz: 0, y0: 0, y1: 30, hw: 5, hd: 5, rot: 0 });
  const h = c.raycast([0, 10, 0], [1, 0, 0], 200);
  assert.ok(Math.abs(h.t - 25) < 1e-6, `t=${h.t}, expected the near box at 25`);
});

test("sphereClip pushes out of a wall along the wall normal", () => {
  const c = world();
  const clip = c.sphereClip([10.2, 10, 0], 0.5);   // 0.2 m outside the +x face
  assert.ok(clip, "expected a clip");
  assert.ok(Math.abs(clip.depth - 0.3) < 1e-6, `depth ${clip.depth}`);
  assert.deepEqual(nrm([clip.nx, clip.ny, clip.nz]), [1, 0, 0]);
});

test("sphereClip returns null in open air", () => {
  const c = world();
  assert.equal(c.sphereClip([40, 10, 40], 0.5), null);
});

test("a sphere centred inside the box is pushed out the shallowest face", () => {
  const c = world();
  const clip = c.sphereClip([9, 15, 0], 0.5);      // deep inside, near the +x face
  assert.ok(clip);
  assert.ok(clip.depth > 0);
  assert.equal(Math.round(clip.nx), 1);
});

test("roofAt finds the roof over a footprint and nothing beside it", () => {
  const c = world();
  assert.equal(c.roofAt(0, 0, Infinity).y, 30);
  assert.equal(c.roofAt(40, 0, Infinity), null);
});

test("roofAt only reports roofs at or below the query height", () => {
  // A hero at 10 m must not 'land' on a 30 m roof above his head.
  const c = world();
  assert.equal(c.roofAt(0, 0, 10), null);
  assert.equal(c.roofAt(0, 0, 30).y, 30);
});

test("groundY is street level off a footprint and roof height on one", () => {
  const c = world();
  assert.equal(c.groundY(40, 40, 1e9), 0);
  assert.equal(c.groundY(0, 0, 1e9), 30);
});

test("the spatial hash returns the same answers as a brute-force scan", () => {
  // The hash is the only thing standing between correctness and 983 OBB tests
  // per ray. If a cell insertion is wrong the miss is silent — a web that
  // occasionally passes through a building.
  const c = createColliders({ cell: 20 });
  const boxes = [];
  for (let i = 0; i < 60; i++) {
    const b = { cx: (i % 10) * 37 - 180, cz: Math.floor(i / 10) * 41 - 100,
                y0: 0, y1: 20 + (i % 7) * 9, hw: 6 + (i % 3), hd: 5 + (i % 4),
                rot: (i % 4) * Math.PI / 2 };
    boxes.push(b); c.add(b);
  }
  const brute = createColliders({ cell: 1e6 });   // one cell = no spatial pruning
  for (const b of boxes) brute.add({ ...b });
  for (let i = 0; i < 200; i++) {
    const o = [(i * 7) % 400 - 200, 5 + (i % 30), (i * 13) % 300 - 150];
    const a = (i / 200) * Math.PI * 2;
    const d = [Math.cos(a), Math.sin(a * 0.7) * 0.3, Math.sin(a)];
    const h1 = c.raycast(o, d, 120), h2 = brute.raycast(o, d, 120);
    assert.equal(!!h1, !!h2, `hash/brute disagree on ray ${i}`);
    if (h1) assert.ok(Math.abs(h1.t - h2.t) < 1e-9, `ray ${i}: ${h1.t} vs ${h2.t}`);
  }
});
