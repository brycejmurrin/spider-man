// @ts-check
// The soundtrack, proved to actually play.
//
// Every signal this subsystem offers by default is a false positive. The
// <audio> elements are detached (`new Audio()`, never appended), so
// document.querySelectorAll("audio") finds nothing. `startMusic()` returns true
// whether or not playback started, because the play() promise is
// fire-and-forget: `a.play().catch(() => {})`, three times over. A missing or
// undecodable file fires an `error` listener that quietly calls nextTrack(), so
// a 404 still lights the HUD — with the NEXT track's title. And `#track`
// appearing proves only that the onTrack callback ran, one line after the
// play() that may have rejected.
//
// So the only fact that separates "playing" from "play() was called and
// refused" is THE MEDIA CLOCK ADVANCING. That is what this asserts.
//
// Two things this spec must not do:
//   - It must click #mb-play with locator.click(), which goes out over CDP as a
//     real input event (isTrusted, and it grants user activation). Chromium's
//     default autoplay policy is document-user-activation-required and
//     Playwright does NOT relax it — there is no --autoplay-policy in its
//     Chromium switch list. A dispatchEvent("click") or an in-page
//     element.click() is untrusted, so play() would reject, the rejection would
//     be swallowed, and this spec would pass every check except the clock.
//   - It must not add an autoplay flag to playwright.config.js. The default
//     policy is exactly what makes this test prove the production gesture path.
//
// Headless adds --mute-audio, which silences the output device only: the
// element still loads, decodes and advances currentTime. The assertion holds.
import { test, expect } from "../helpers/fixtures.js";

const LANDSCAPE = { width: 1280, height: 720 };

test.use({ viewport: LANDSCAPE });

async function boot(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.__spidey != null, { polling: 100, timeout: 60_000 });
}

test.describe("soundtrack", () => {
  test("clicking SWING starts music and the media clock advances", async ({ page }) => {
    test.slow();
    await boot(page);

    const before = await page.evaluate(() => window.__spidey.music());
    expect(before.started, "music elements exist before any gesture").toBe(false);

    // The real gesture. This handler arms GameAudio.init() AND startMusic().
    await page.locator("#mb-play").click();

    // Wait for the element to have data and be unpaused. readyState >= 2 is
    // HAVE_CURRENT_DATA — enough to be playing, without waiting on 7.6 MB.
    await page.waitForFunction(() => {
      const s = window.__spidey.music();
      return s.started && !s.paused && s.readyState >= 2;
    }, { polling: 100, timeout: 60_000 });

    const t0 = await page.evaluate(() => window.__spidey.music().currentTime);
    await page.waitForTimeout(1200);
    const s1 = await page.evaluate(() => window.__spidey.music());

    expect(s1.currentTime,
      `the media clock did not advance (${t0} -> ${s1.currentTime}): play() was called but nothing is playing`)
      .toBeGreaterThan(t0 + 0.2);
    expect(s1.error, "the audio element reported a MediaError").toBeNull();
    expect(s1.on).toBe(true);
    expect(s1.volume).toBeGreaterThan(0);

    // The HUD names the track that is actually playing, not a stale one.
    await expect(page.locator("#track")).toBeVisible();
    expect(await page.locator("#track-v").innerText()).toBe(s1.title);

    // The gesture arms the synth as well — one click is supposed to do both.
    expect(s1.ctx, "the WebAudio context is still suspended after the gesture").toBe("running");
  });

  test("M mutes and N skips", async ({ page }) => {
    test.slow();
    await boot(page);
    await page.locator("#mb-play").click();
    await page.waitForFunction(() => {
      const s = window.__spidey.music();
      return s.started && !s.paused && s.readyState >= 2;
    }, { polling: 100, timeout: 60_000 });

    const first = await page.evaluate(() => window.__spidey.music().track);

    await page.keyboard.press("KeyN");
    await expect.poll(() => page.evaluate(() => window.__spidey.music().track))
      .not.toBe(first);

    await page.keyboard.press("KeyM");
    await expect.poll(() => page.evaluate(() => window.__spidey.music().on)).toBe(false);
    expect(await page.evaluate(() => window.__spidey.music().paused)).toBe(true);
  });

  test("a missing track is visible, not silently swallowed", async ({ page }) => {
    // The error path deliberately skips on rather than taking the game with it,
    // which is right — but it must still be OBSERVABLE, or a broken deploy that
    // ships no audio looks identical to a working one from every test.
    test.slow();
    await page.route("**/assets/music/*.mp3", (r) => r.fulfill({ status: 404, body: "" }));
    await boot(page);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.locator("#mb-play").click();
    // Give the element time to fail and the skip-on chain to run.
    await page.waitForTimeout(3000);

    const s = await page.evaluate(() => window.__spidey.music());
    expect(s.started, "no audio element was ever created").toBe(true);
    // Whatever else is true, the clock must NOT be advancing and the failure
    // must be legible from musicState().
    expect(s.currentTime).toBe(0);
    expect(s.error, "a 404 track left no MediaError to find").not.toBeNull();
    // ...and it still must not take the game down.
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__spidey.info().state)).toBe("play");
  });
});
