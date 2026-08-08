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

    // And the NEXT press must still work. This half is the actual bug: the
    // release above cleared the shared `state`, but each hold() closure kept
    // its own `id`, and nothing reset it — so `if (id != null) return` in
    // pointerdown rejected every later press and SWING was dead until a page
    // reload. iOS never reuses pointerIds, so the ghost id was permanent.
    // Take a call, get an alert, switch apps: game over, silently.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: swing.x, y: swing.y, id: 4 }],
    });
    expect(await page.evaluate(() => window.__spidey.input().swing),
      "SWING could not be pressed again after backgrounding — the stale pointerId is back").toBe(true);
  });

  // The camera. A phone has no second stick and the controls sit above the
  // canvas, so before this there was no touch source for Input.look() at all
  // and the view could only be steered indirectly, by pushing the stick and
  // waiting for the auto-recentre to catch up.
  test.describe("the SWING zone also steers the camera", () => {
    test("a slide looks without ever cancelling the hold", async ({ page, context }) => {
      test.slow();
      await bootTouch(page);
      const swing = await centreOf(page, "#t-swing");
      const cdp = await context.newCDPSession(page);

      const yaw = () => page.evaluate(() => window.__spidey.camState().orbitYaw);
      const before = await yaw();

      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart", touchPoints: [{ x: swing.x, y: swing.y, id: 5 }],
      });
      expect(await page.evaluate(() => window.__spidey.input().swing)).toBe(true);
      expect(await page.evaluate(() => window.__spidey.input().lookHeld)).toBe(true);

      // A press alone must not move the view. A thumb rolls a few pixels as it
      // presses, and without the dead zone every swing would come with an
      // involuntary camera yank.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: swing.x + 10, y: swing.y, id: 5 }],
      });
      expect(await yaw(), "a 10 px thumb roll moved the camera").toBe(before);

      // Past the dead zone it steers — and the hold survives, which is the
      // whole point of the dual-purpose control.
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x: swing.x + 10 + i * 20, y: swing.y, id: 5 }],
        });
      }
      // The orbit is applied in the render loop, so this needs real frames —
      // a handful at ~10 s each under SwiftShader. polling:100 is required,
      // not decorative: Playwright polls on rAF by default and this page
      // starves that poll badly enough that the declared timeout never fires.
      await page.waitForFunction(() => window.__spidey.camState().orbitYaw !== 0,
        { polling: 100, timeout: 60_000 });
      expect(await page.evaluate(() => window.__spidey.input().swing),
        "sliding to look released the swing — a look is not a cancel").toBe(true);

      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      expect(await page.evaluate(() => window.__spidey.input().swing)).toBe(false);
      expect(await page.evaluate(() => window.__spidey.input().lookHeld)).toBe(false);
    });

    // The per-control pointerId bookkeeping is the oldest rule in touch.js and
    // has never been tested with two real fingers. One dispatch carrying two
    // touchPoints is the only way to produce genuine simultaneity.
    test("steering and swinging are independent fingers", async ({ page, context }) => {
      test.slow();
      await bootTouch(page);
      const stick = await centreOf(page, "#t-stick");
      const swing = await centreOf(page, "#t-swing");
      const cdp = await context.newCDPSession(page);

      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: stick.x, y: stick.y, id: 6 }, { x: swing.x, y: swing.y, id: 7 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: stick.x + 40, y: stick.y, id: 6 }, { x: swing.x, y: swing.y, id: 7 }],
      });
      const both = await page.evaluate(() => window.__spidey.input());
      expect(both.swing, "holding SWING while steering failed").toBe(true);
      expect(both.moveX, "the stick did not steer with a second finger down").toBeGreaterThan(0.2);

      // Move ONLY the swing finger. The stick must not follow it.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: stick.x + 40, y: stick.y, id: 6 }, { x: swing.x - 90, y: swing.y, id: 7 }],
      });
      const after = await page.evaluate(() => window.__spidey.input());
      expect(after.moveX, "the swing finger's slide leaked into the stick").toBeCloseTo(both.moveX, 5);
      expect(after.swing).toBe(true);
    });
  });

  // The layout, at the size it is actually played at. iPhone 13 landscape is
  // 844x390 CSS px with 47 px side insets and 21 px at the bottom; every other
  // assertion in this file runs at 1280x720, which is 3.3x the real height and
  // where fitting is trivial. The old button column was 246 px tall — 63% of
  // this window — which nothing ever caught.
  //
  // Chromium reports env(safe-area-inset-*) as 0, so the insets are INJECTED
  // through the --safe-* variables the CSS adds to env(). That is why they are
  // written as `env(...) + var(...)` and not as env()'s own fallback, which
  // only applies where env() is unsupported.
  test.describe("at phone size", () => {
    test.use({ viewport: { width: 844, height: 390 } });

    test("every control fits inside the safe area and leaves the view clear", async ({ page }) => {
      test.slow();
      await bootTouch(page);
      await page.evaluate(() => {
        const r = document.documentElement.style;
        r.setProperty("--safe-l", "47px"); r.setProperty("--safe-r", "47px");
        r.setProperty("--safe-t", "0px"); r.setProperty("--safe-b", "21px");
      });

      const SAFE = { l: 47, r: 844 - 47, t: 0, b: 390 - 21 };
      for (const sel of ["#t-btns", "#t-ring", "#t-swing .t-pill"]) {
        const b = await page.locator(sel).boundingBox();
        expect(b, `${sel} has no box`).not.toBeNull();
        expect(b.x, `${sel} crosses the left inset`).toBeGreaterThanOrEqual(SAFE.l - 1);
        expect(b.x + b.width, `${sel} crosses the right inset`).toBeLessThanOrEqual(SAFE.r + 1);
        expect(b.y, `${sel} crosses the top inset`).toBeGreaterThanOrEqual(SAFE.t - 1);
        expect(b.y + b.height, `${sel} crosses the home indicator`).toBeLessThanOrEqual(SAFE.b + 1);
      }

      // The zones may span the screen — they are invisible — but they must not
      // reach the physical right edge, where Safari's edge-swipe-back lives.
      // touch-action cannot prevent an OS gesture; not being there is the only
      // defence available to a web page.
      const zone = await page.locator("#t-swing").boundingBox();
      expect(844 - (zone.x + zone.width),
        "the SWING zone runs into Safari's edge-swipe-back gutter").toBeGreaterThanOrEqual(20);

      // What the player can actually see. The visible furniture must leave the
      // middle of the screen alone — that is where the city is.
      const painted = [];
      for (const sel of ["#t-btns", "#t-ring", "#t-swing .t-pill"]) {
        painted.push(await page.locator(sel).boundingBox());
      }
      const midBand = { x0: 844 * 0.28, x1: 844 * 0.72, y0: 0, y1: 390 * 0.6 };
      for (const b of painted) {
        const overlaps = b.x < midBand.x1 && b.x + b.width > midBand.x0 &&
                         b.y < midBand.y1 && b.y + b.height > midBand.y0;
        expect(overlaps, "a control covers the middle of the view").toBe(false);
      }
    });
  });
});
