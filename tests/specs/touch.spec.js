// @ts-check
// The touch controls, proved all the way through to the hero.
//
// This is the spec the handoff called the single most important thing to
// finish: the layer mounts, the buttons exist and nothing throws, but nothing
// had ever demonstrated that a held SWING button reaches `hero.step()`. On a
// phone that is the entire game.
//
// Two rules make this spec different from every other one here.
//
// 1. It must NOT use `__spidey.act()`. act() sets `G.testInput`, and
//    `inputFrame()` returns that INSTEAD of reading `Input` — so act() bypasses
//    precisely the layer under test. The only honest driver is live
//    requestAnimationFrame frames with the game's own input path running.
//
// 2. It must NOT call `headless(true)`. That is what stops the loop that reads
//    `Input.swing()`. (The shared afterEach quiesces the page at teardown, which
//    is fine — that is after the assertions.)
//
// The press is dispatched over CDP `Input.dispatchTouchEvent` rather than
// `locator.dispatchEvent("pointerdown")`. Chromium turns a CDP touch into a
// real, trusted, hit-tested `pointerdown` with `pointerType: "touch"`, so this
// exercises the things that actually break on a phone — `pointer-events: none`
// on the layer versus `auto` on the controls, the z-order against the canvas
// and #rotate, and `setPointerCapture()` on a genuinely active pointer.
// A synthetic PointerEvent skips hit-testing entirely and makes
// setPointerCapture throw NotFoundError into the code's try/catch, so it would
// prove the wiring while silently not testing the layout.
import { test, expect } from "../helpers/fixtures.js";

const LANDSCAPE = { width: 1280, height: 720 };

// Landscape on purpose, and isMobile deliberately OFF. `#rotate` sits at
// z-index 40 and displays under `(orientation: portrait) and (pointer: coarse)`
// — a portrait phone viewport would cover the screen and swallow every touch,
// and the failure would read as "the buttons do nothing".
test.use({ viewport: LANDSCAPE, hasTouch: true });

/* Force the touch layer on. `store.get("touch", null)` JSON-parses the value
   into Input.init's forceTouch, and Input.init runs once at module evaluation
   — so this has to land before navigation, not after. */
async function bootTouch(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem("spidey.touch", "true"); } catch (_) {}
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__spidey != null, { polling: 100, timeout: 60_000 });
  // play() adds body.playing, which is what un-hides #touch (CSS, not JS).
  await page.evaluate(() => window.__spidey.play());
}

async function centreOf(page, sel) {
  const box = await page.locator(sel).boundingBox();
  expect(box, `${sel} has no box — the touch layer did not mount`).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe("touch controls", () => {
  test("a held SWING button attaches the hero", async ({ page, context }) => {
    test.slow();   // live rAF under SwiftShader runs near 2 fps
    await bootTouch(page);

    // The layer is real and reachable. This alone catches a safe-area or
    // stacking regression that would make the game unplayable on a phone.
    await expect(page.locator("#touch")).toBeVisible();
    const swing = await centreOf(page, "#t-swing");
    expect(swing.box.x + swing.box.width).toBeLessThanOrEqual(LANDSCAPE.width);
    expect(swing.box.y + swing.box.height).toBeLessThanOrEqual(LANDSCAPE.height);

    // The placement matters more than it looks. This spec deliberately renders
    // (headless(true) would stop the loop that reads the input), and a full
    // frame of an 983-building city under SwiftShader costs ~10 s -- so the
    // budget is measured in FRAMES, not seconds, and the loop advances at most
    // 5 physics substeps per frame.
    //
    // The first version placed the hero at y=80, which has no anchor within
    // reach: he has to fall 2.07 s of game time before pickAnchor finds
    // anything (measured in Node), i.e. ~25 rendered frames, i.e. past any
    // sane timeout. It failed at 397 s having fallen 22 m, which reads as
    // "touch is broken" and is nothing of the kind.
    //
    // (-486, 35, -204) is beside a ~49 m tower: pickAnchor succeeds on the
    // FIRST step, so one rendered frame is enough. Found by scanning the
    // colliders for a spot where step 0 attaches.
    await page.evaluate(() => {
      window.__spidey.place(-486, 35, -204, 18, 0);
      window.__spidey.snapCam();
    });
    // Assert the premise, so a future failure says which half broke: if this
    // is empty the placement went stale, not the touch layer.
    expect(await page.evaluate(() => window.__spidey.obs().anchors.length),
      "no anchor is reachable from the start position — the placement is stale").toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__spidey.obs().attached)).toBe(false);
    expect(await page.evaluate(() => window.__spidey.input().swing)).toBe(false);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swing.x, y: swing.y, id: 1 }],
    });

    // Checkpoint 1: the handler fired at all. If this fails the problem is
    // hit-testing or CSS, not the game.
    await expect(page.locator("#t-swing")).toHaveClass(/\bon\b/);
    // Checkpoint 2: the state reached the input layer's merged view.
    expect(await page.evaluate(() => window.__spidey.input().swing),
      "the button is held but Input.swing() is false").toBe(true);

    // Checkpoint 3: the frames the game itself drives carry it to the hero.
    // Wait on the CONDITION, not a frame count. polling:100 is required, not
    // decorative — Playwright polls on requestAnimationFrame by default, and
    // this page starves that poll badly enough that the declared timeout never
    // fires.
    await page.waitForFunction(
      () => window.__spidey.obs().attached === true,
      { polling: 100, timeout: 120_000 });

    const held = await page.evaluate(() => window.__spidey.obs());
    expect(held.state).toBe("swing");

    // Releasing must actually release. A stuck SWING is the failure mode the
    // per-control pointerId bookkeeping exists to prevent.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("#t-swing")).not.toHaveClass(/\bon\b/);
    expect(await page.evaluate(() => window.__spidey.input().swing)).toBe(false);
  });

  test("the virtual stick steers", async ({ page, context }) => {
    test.slow();
    await bootTouch(page);
    const stick = await centreOf(page, "#t-stick");

    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: stick.x, y: stick.y, id: 2 }],
    });
    // The origin is where the thumb LANDED, so the deflection is measured from
    // the touchStart point, not from the pad's centre.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: stick.x + 40, y: stick.y - 30, id: 2 }],
    });

    const moved = await page.evaluate(() => window.__spidey.input());
    expect(moved.moveX, "pushing right did not move moveX").toBeGreaterThan(0.2);
    expect(moved.moveZ, "pushing up did not move moveZ forward").toBeGreaterThan(0.2);

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const released = await page.evaluate(() => window.__spidey.input());
    expect(released.moveX).toBe(0);
    expect(released.moveZ).toBe(0);
  });

  test("backgrounding the app releases a held control", async ({ page, context }) => {
    // iOS steals touches for the app switcher, so the pointerup never arrives.
    // Without the blur/visibilitychange release the hero would swing forever
    // with nobody holding anything — the single worst phone bug available here.
    test.slow();
    await bootTouch(page);
    const swing = await centreOf(page, "#t-swing");

    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: swing.x, y: swing.y, id: 3 }],
    });
    expect(await page.evaluate(() => window.__spidey.input().swing)).toBe(true);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await page.evaluate(() => window.__spidey.input().swing),
      "SWING stayed held after the app lost focus").toBe(false);
  });
});
