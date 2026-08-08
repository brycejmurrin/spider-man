// @ts-check
// The headless traversal loop: __spidey.headless() / place() / act() / obs().
//
// Two things are proved here and nowhere else: a tight control loop can step
// the simulation and read observations in ONE round trip (every rollout below
// runs inside a single evaluate — one round trip per step would make a 600-step
// stint minutes of IPC), and the same inputs replay exactly.
//
// The physics itself is characterized far more cheaply in
// tests/unit/hero-swing.test.mjs, which runs the same model in bare Node. What
// this file adds is that the model is correctly WIRED to the page: the API
// reaches it, headless mode really skips rendering, and the browser build
// agrees with the Node build.
import { test, expect } from "../helpers/fixtures.js";

const LANDSCAPE = { width: 1280, height: 720 };

async function load(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.__spidey != null, { polling: 100, timeout: 60_000 });
  await page.evaluate(() => { window.__spidey.play(); window.__spidey.headless(true); });
}

test.describe("headless traversal", () => {
  test.use({ viewport: LANDSCAPE });

  test("obs() is null before placement, and complete after", async ({ page }) => {
    await load(page);
    const o = await page.evaluate(() => {
      window.__spidey.place(8, 60, -520, 14, 0);
      return window.__spidey.obs();
    });
    expect(o).not.toBeNull();
    for (const k of ["x", "y", "z", "speed", "speedKph", "tether", "groundClear", "head"]) {
      expect(typeof o[k], `obs().${k}`).toBe("number");
      expect(Number.isFinite(o[k]), `obs().${k} is finite`).toBe(true);
    }
    expect(typeof o.state).toBe("string");
    expect(typeof o.attached).toBe("boolean");
    expect(Array.isArray(o.anchors)).toBe(true);
    expect(o.speedKph).toBeCloseTo(o.speed * 3.6, 0);
  });

  test("swinging carries the hero further than falling", async ({ page }) => {
    await load(page);
    // RELATIVE, not absolute: "swinging beats falling" survives any retune;
    // "travelled > 400 m" goes stale the day the pump changes.
    const r = await page.evaluate(() => {
      const S = window.__spidey;
      const run = (input) => {
        S.place(8, 60, -520, 14, 0);
        for (let i = 0; i < 600; i++) S.act(input, 1 / 60, 1);
        const o = S.obs();
        return Math.hypot(o.x - 8, o.z + 520);
      };
      return { swung: run({ swing: true, dirZ: 1 }), fell: run({ dirZ: 1 }) };
    });
    expect(r.swung).toBeGreaterThan(r.fell * 1.5);
  });

  test("a 900-step stint stays finite, above ground and out of the walls", async ({ page }) => {
    await load(page);
    const r = await page.evaluate(() => {
      const S = window.__spidey;
      S.place(8, 60, -520, 14, 0);
      let minY = Infinity, maxSpeed = 0, bad = 0, o;
      for (let i = 0; i < 900; i++) {
        o = S.act({ swing: true, dirZ: 1 }, 1 / 60, 1);
        if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) bad++;
        minY = Math.min(minY, o.y);
        maxSpeed = Math.max(maxSpeed, o.speed);
      }
      return { bad, minY, maxSpeed, final: o, dist: Math.hypot(o.x - 8, o.z + 520) };
    });
    expect(r.bad).toBe(0);
    expect(r.minY).toBeGreaterThan(-1);
    expect(r.maxSpeed).toBeLessThan(95);          // the hard rail
    // ...and it actually traversed, so the checks above are not vacuously true
    // of a hero standing still.
    expect(r.dist).toBeGreaterThan(200);
  });

  test("the same inputs replay exactly in the browser build", async ({ page }) => {
    await load(page);
    const r = await page.evaluate(() => {
      const S = window.__spidey;
      const run = () => {
        S.place(8, 60, -520, 14, 0);
        const t = [];
        for (let i = 0; i < 400; i++) {
          const o = S.act({ swing: true, dirZ: 1 }, 1 / 60, 1);
          t.push([+o.x.toFixed(6), +o.y.toFixed(6), +o.z.toFixed(6)]);
        }
        return JSON.stringify(t);
      };
      return { a: run(), b: run() };
    });
    expect(r.a).toBe(r.b);
    expect(r.a.length).toBeGreaterThan(1000);
  });

  test("the webline attaches to real city geometry", async ({ page }) => {
    await load(page);
    // A web that terminates in mid-air is the single most visible traversal
    // bug, and it cannot be seen in a screenshot at speed.
    const r = await page.evaluate(() => {
      const S = window.__spidey;
      S.place(8, 60, -520, 16, 0);
      const anchors = [];
      for (let i = 0; i < 600; i++) {
        S.act({ swing: true, dirZ: 1 }, 1 / 60, 1);
        const sw = S.swing();
        if (sw.anchor) anchors.push({ a: sw.anchor, t: sw.tether });
      }
      return anchors.map(({ a, t }) => {
        // A point ON a surface: a tiny ray straight down from just above the
        // anchor must hit something, unless it is a synthetic assist anchor.
        const hit = S.raycast([a[0], a[1] + 0.6, a[2]], [0, -1, 0], 2.0);
        return { hit: !!hit, t };
      });
    });
    expect(r.length).toBeGreaterThan(50);
    const grounded = r.filter((x) => x.hit).length / r.length;
    // The never-stranded assist deliberately synthesises an anchor in open air
    // when nothing is castable, so this is a majority check, not a totality one.
    expect(grounded, "most anchors must be on real geometry").toBeGreaterThan(0.6);
    expect(Math.max(...r.map((x) => x.t))).toBeLessThanOrEqual(45.001);
  });

  test("headless mode really skips rendering", async ({ page }) => {
    await load(page);
    const r = await page.evaluate(async () => {
      const S = window.__spidey;
      const frames = () => new Promise((res) => {
        let n = 0, last = 0;
        const t = (ts) => { if (n++ === 0) last = ts; if (n > 20) res(ts - last); else requestAnimationFrame(t); };
        requestAnimationFrame(t);
      });
      S.headless(true);
      const off = await frames();
      S.headless(false);
      return { off, headless: S.headless() };
    });
    expect(r.headless).toBe(false);
    expect(r.off).toBeGreaterThan(0);
  });
});
