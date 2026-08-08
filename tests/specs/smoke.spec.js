// @ts-check
// Boot smoke: the page comes up, WebGL2 is available, the canvas has real
// dimensions, nothing logs an error, and __spidey answers.
//
// This is the FIRST spec to read when the suite goes red everywhere: if it
// fails, nothing downstream means anything. It asserts no magnitudes — a
// rendered frame is checked only for "not blank" (byte size), because the city
// is procedurally dressed and differs seed to seed.
import { test, expect } from "../helpers/fixtures.js";

const LANDSCAPE = { width: 1280, height: 720 };

// polling:100 is REQUIRED, not decorative: Playwright polls the predicate on
// requestAnimationFrame by default, and a page running the game loop under
// SwiftShader starves that poll badly enough that the declared timeout never
// gets to fire. See docs/TESTING.md.
async function waitReady(page, timeout = 60_000) {
  await page.waitForFunction(() => window.__spidey != null, { polling: 100, timeout });
}

test.describe("Web-Slinger — smoke", () => {
  test.use({ viewport: LANDSCAPE });

  test("page loads without a WebGL error", async ({ page, pageErrors }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto("/");
    await waitReady(page);

    await expect(page.locator("#overlay")).toBeVisible();
    await expect(page.locator("#nogl")).toBeHidden();
    const box = await page.locator("canvas#game").boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);

    expect(errors.filter((e) => !e.includes("favicon"))).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });

  test("the dev API reports a built city", async ({ page }) => {
    await page.goto("/");
    await waitReady(page);
    const info = await page.evaluate(() => window.__spidey.info());
    expect(info.state).toBe("menu");
    expect(typeof info.city).toBe("string");
    expect(info.buildings).toBeGreaterThan(500);
    expect(info.span).toBeGreaterThan(500);
  });

  test("an unknown camera mode is rejected, not crashed", async ({ page }) => {
    await page.goto("/");
    await waitReady(page);
    expect(await page.evaluate(() => window.__spidey.camera("banana"))).toBe(false);
    expect(await page.evaluate(() => window.__spidey.camera("chase"))).toBe(true);
  });

  test("SWING enters play and shows the HUD", async ({ page }) => {
    await page.goto("/");
    await waitReady(page);
    await page.locator("#mb-play").click();
    await expect(page.locator("#hud")).toBeVisible();
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await page.evaluate(() => window.__spidey.info().state)).toBe("play");
  });

  test("a parked rooftop pose renders a non-blank frame", async ({ page }) => {
    test.slow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await waitReady(page);
    await page.evaluate(() => { window.__spidey.play(); window.__spidey.park(0.5); window.__spidey.snapCam(); });
    // Let the renderer PRESENT the new pose (the loop runs near 1 fps under
    // SwiftShader), then stop it: park() freezes physics, not rendering, and a
    // screenshot issued against a live render loop queues behind it instead of
    // reading a quiet compositor.
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.__spidey.headless(true));
    await page.waitForTimeout(150);

    const png = await page.screenshot({ timeout: 180_000 });
    // A blank/black frame compresses to a few KB; a real 3D frame is tens of KB.
    expect(png.length, "the scene went black").toBeGreaterThan(20_000);
    expect(errors).toEqual([]);
  });
});
