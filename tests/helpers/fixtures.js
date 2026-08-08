// @ts-check
/**
 * Shared Playwright fixtures for Web-Slinger.
 *
 * Importing `test` from here instead of `@playwright/test` gives every
 * test in that file these extras at zero per-test cost:
 *
 *   1. `page.addInitScript` — injects `window.__TEST_MODE = true` before
 *      any game script runs (safe to read in game.js for guards).
 *
 *   2. Browser-console capture on every page in the context, attached to the
 *      report on failure — so a red test shows what the PAGE said, not only
 *      what the assertion said.
 *
 *   3. The `Log` ring buffer (js/log.js) attached on failure too. Console
 *      capture only sees what was PRINTED; the ring holds everything retained
 *      (default down to `info`), which is the half that used to be lost.
 *
 * Usage:
 *   import { test, expect } from './fixtures.js';
 *
 * Turning diagnostics up for one run — the spec needs no change, because the
 * level is read from localStorage before any game script evaluates:
 *
 *   SPIDEY_LOG=city:debug npm test -- tests/specs/smoke.spec.js
 */
import { test as base, expect } from "@playwright/test";

// SPIDEY_LOG is a js/log.js level spec ("debug", "city:debug", "buffer:trace").
// Written to localStorage rather than passed as a query param because the
// specs navigate to "/" themselves and would drop a query string.
const LOG_SPEC = process.env.SPIDEY_LOG || "";

async function installInit(context) {
  await context.addInitScript((spec) => {
    window.__TEST_MODE = true;
    if (spec) { try { localStorage.setItem("spidey.logLevel", spec); } catch (_) {} }
  }, LOG_SPEC);
}

// Console lines captured per test, keyed by the page they came from.
const consoleByPage = new WeakMap();

function captureConsole(page) {
  const lines = [];
  consoleByPage.set(page, lines);
  page.on("console", (m) => {
    // Favicon 404s are a static-server artefact, not the game talking.
    const text = m.text();
    if (/favicon/i.test(text)) return;
    lines.push(`${m.type()}: ${text}`);
    if (lines.length > 400) lines.shift();
  });
  page.on("pageerror", (e) => lines.push(`pageerror: ${e.message}`));
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installInit(context);
    context.on("page", captureConsole);
    for (const p of context.pages()) captureConsole(p);
    await use(context);
  },

  /**
   * `string[]` — every console line and page error the page produced, newest
   * last, prefixed with its console type. Attached automatically on failure;
   * take it as a fixture when a test wants to ASSERT on it.
   */
  consoleLines: async ({ page }, use) => {
    await use(consoleByPage.get(page) || []);
  },

  /**
   * Collects all uncaught JS exceptions thrown by the page.
   * `expect(pageErrors).toHaveLength(0)` after exercising game logic
   * confirms no silent JS errors occurred.
   * @type {string[]}
   */
  pageErrors: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
  },

  /**
   * Navigates to `/` and waits until `window.__spidey` is available (up to
   * 15 s — ~40 script tags plus WebGL context creation under SwiftShader),
   * then hands the loaded page to the test.
   */
  gamePage: async ({ page }, use) => {
    await page.goto("/");
    await page.waitForFunction(() => window.__spidey != null, { timeout: 15000, polling: 100 });
    await use(page);
  },
});

// On any failure, attach everything that explains it and nothing that does not.
// All attachments are free on a passing test — only collected when red.
test.afterEach(async ({ page }, testInfo) => {
  // Quiesce the render loop FIRST, on pass and on fail alike. Playwright tears
  // the context down while the page is still driving requestAnimationFrame,
  // and under SwiftShader that starves teardown past the whole test timeout —
  // it surfaces as 'Tearing down "context" exceeded the test timeout', which
  // reads like a hung browser rather than a busy one.
  await page.evaluate(() => { try { window.__spidey?.headless(true); } catch (_) {} }).catch(() => {});

  if (testInfo.status === testInfo.expectedStatus) return;
  const lines = consoleByPage.get(page);
  if (lines && lines.length) {
    await testInfo.attach("page-console", {
      body: lines.slice(-120).join("\n"),
      contentType: "text/plain",
    }).catch(() => {});
  }
  try {
    const snap = await page.evaluate(() => {
      const a = window.__spidey; if (!a) return null;
      const pick = (fn) => { try { return fn(); } catch (_) { return undefined; } };
      return {
        state: pick(() => a.state && a.state()),
        swing: pick(() => a.swing && a.swing()),
        city: pick(() => a.city && a.city()),
      };
    });
    if (snap) await testInfo.attach("spidey-state", { body: JSON.stringify(snap), contentType: "application/json" });

    const logs = await page.evaluate(() => {
      try { return (window.Log && window.Log.records({ limit: 80 })) || []; }
      catch (_) { return []; }
    });
    if (logs.length) {
      await testInfo.attach("spidey-logs", {
        body: logs.map((r) => `${r.t}ms [${r.ns}] ${r.level}: ${r.msg}`).join("\n"),
        contentType: "text/plain",
      });
    }
  } catch (_) { /* page may be closed / __spidey absent — best-effort only */ }
});

export { expect };
