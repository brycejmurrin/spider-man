// @ts-check
// Render health WITHOUT pixel baselines.
//
// The city is procedurally dressed and the camera is physically driven, so two
// runs of the same scene differ across a large fraction of pixels. A golden PNG
// here would either be permanently red or so loosely toleranced it could not
// catch a real regression. So this file asserts three things that need no
// baseline: no GL error while real frames are drawn, the frame is not blank,
// and the camera reaches geometrically sane, DISTINCT vantages per mode.
import { test, expect } from "../helpers/fixtures.js";

const LANDSCAPE = { width: 1280, height: 720 };

async function load(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.__spidey != null, { polling: 100, timeout: 60_000 });
  await page.evaluate(() => window.__spidey.play());
}

// Advance N REAL rendered frames. step()/act() never present a frame, so
// anything that only happens inside render() — the shadow passes, the camera
// rig easing toward its target — needs this and not a step loop.
const framesFn = (n) => new Promise((resolve) => {
  const next = () => { if (--n <= 0) resolve(); else requestAnimationFrame(next); };
  requestAnimationFrame(next);
});

test.describe("city render health", () => {
  test.use({ viewport: LANDSCAPE });

  test("30 rendered frames produce no GL errors", async ({ page }) => {
    test.setTimeout(240_000);
    const glErrors = [];
    page.on("console", (m) => {
      if (/INVALID_OPERATION|INVALID_ENUM|INVALID_VALUE|INVALID_FRAMEBUFFER/.test(m.text())) glErrors.push(m.text());
    });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await load(page);
    await page.evaluate(async (src) => {
      window.__spidey.place(8, 70, -540, 16, 0);
      window.__spidey.snapCam();
      await eval("(" + src + ")")(30);
    }, framesFn.toString());

    expect(glErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("the light system stays under the shader's uniform-array cap", async ({ page }) => {
    await load(page);
    const ls = await page.evaluate(() => {
      window.__spidey.place(0, 40, 0, 0, 0);
      window.__spidey.snapCam();
      return window.__spidey.lightState();
    });
    // The lit shader sizes its uniform arrays for 32; one more is a silent
    // upload overflow, not an error.
    expect(ls.numLights).toBeGreaterThan(0);
    expect(ls.numLights).toBeLessThanOrEqual(32);
    // Night ambient must stay in the band: crushed to zero and every building
    // mass reads as a black silhouette; lifted and the night looks like dim day.
    for (const v of ls.ambientSky) { expect(v).toBeGreaterThan(0.004); expect(v).toBeLessThan(0.09); }
  });

  test("every camera mode reaches a distinct, above-ground vantage", async ({ page }) => {
    test.slow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await load(page);
    await page.evaluate(() => { window.__spidey.place(0, 60, 0, 10, 0); window.__spidey.snapCam(); });

    const modes = await page.evaluate(() => window.__spidey.cameraModes());
    expect(modes.length).toBeGreaterThan(2);

    // Distinctness is asserted on CAMERA STATE, which is what "a distinct
    // frame" means: N different eye/target/fov vantages cannot render the same
    // image. A screenshot per mode costs ~20 s under software GL for no extra
    // signal. snapCam() is REQUIRED — the rig only moves during render(), so
    // without it every mode reports the PREVIOUS vantage and all read alike.
    const vantages = {};
    for (const mode of modes) {
      const c = await page.evaluate((m) => {
        window.__spidey.camera(m); window.__spidey.snapCam();
        return window.__spidey.camState();
      }, mode);
      expect(c.mode).toBe(mode);
      expect(c.eye.every(Number.isFinite), `${mode} eye finite`).toBe(true);
      expect(c.tgt.every(Number.isFinite), `${mode} tgt finite`).toBe(true);
      const d = Math.hypot(c.eye[0] - c.tgt[0], c.eye[1] - c.tgt[1], c.eye[2] - c.tgt[2]);
      expect(d, `${mode} eye-target separation`).toBeGreaterThan(1);
      const street = await page.evaluate((e) => window.__spidey.groundY(e[0], e[2]).y, c.eye);
      expect(c.eye[1], `${mode} eye above the street`).toBeGreaterThan(street);
      vantages[mode] = [...c.eye, ...c.tgt, c.fov].map((v) => +v.toFixed(2)).join(",");
    }
    const vv = Object.values(vantages);
    expect(new Set(vv).size, "two camera modes collapsed to the same vantage").toBe(vv.length);
    expect(errors).toEqual([]);
  });

  test("the camera keeps line of sight to the hero inside a street canyon", async ({ page }) => {
    // The clamp used to raycast from the LOOK-AT TARGET, which leads the hero
    // by 6-8 m — so in a canyon the ray started on the far side of the wall the
    // hero was passing and the eye ended up inside a facade, filling the frame
    // with one lit window pane. It must protect the line to the SUBJECT.
    await load(page);
    const blocked = await page.evaluate(async (src) => {
      const S = window.__spidey;
      S.camera("chase");
      S.place(8, 25, -540, 18, 0);
      let bad = 0, samples = 0;
      for (let i = 0; i < 40; i++) {
        S.act({ swing: true, dirZ: 1 }, 1 / 60, 6);
        S.snapCam();
        const c = S.camState();
        const o = S.obs();
        const dx = c.eye[0] - o.x, dy = c.eye[1] - (o.y + 1.4), dz = c.eye[2] - o.z;
        const L = Math.hypot(dx, dy, dz);
        if (L < 0.5) continue;
        samples++;
        const hit = S.raycast([o.x, o.y + 1.4, o.z], [dx / L, dy / L, dz / L], L - 0.3);
        if (hit) bad++;
      }
      return { bad, samples };
    }, framesFn.toString());
    expect(blocked.samples).toBeGreaterThan(20);
    expect(blocked.bad / blocked.samples,
      "the camera spent too many frames behind geometry").toBeLessThan(0.15);
  });

  test("a swing in progress renders a non-blank frame", async ({ page }) => {
    test.slow();
    await load(page);
    await page.evaluate(() => {
      const S = window.__spidey;
      S.camera("swing");
      S.headless(true);
      S.place(8, 70, -560, 16, 0);
      for (let i = 0; i < 200; i++) S.act({ swing: true, dirZ: 1 }, 1 / 60, 1);
      for (let i = 0; i < 240 && S.swing().state !== "swing"; i++) S.act({ swing: true, dirZ: 1 }, 1 / 60, 1);
      S.headless(false);
      S.setInput({ swing: true, dirZ: 1 });   // hold it through the live frames
      S.snapCam();
    });
    await page.waitForTimeout(2600);
    await page.evaluate(() => { window.__spidey.snapCam(); });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__spidey.headless(true));
    await page.waitForTimeout(150);

    const png = await page.screenshot({ timeout: 180_000 });
    expect(png.length, "the swing frame went black").toBeGreaterThan(20_000);
  });
});
