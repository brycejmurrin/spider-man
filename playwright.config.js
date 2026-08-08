// @ts-check
import { defineConfig, devices } from "@playwright/test";
import fs from "fs";
import os from "os";

// npm scripts use tools/run-playwright.mjs to allocate a unique port per run.
// SPIDEY_PORT remains available for direct CLI invocations.
// Port-suffixed output prevents concurrent runs from clobbering each other.
const PORT = Number(process.env.SPIDEY_PORT || 3456);
const SUF = `-${PORT}`;

// Portable chromium resolution: prefer PW_CHROMIUM, else the Linux sandbox path
// only if it actually exists on disk, else omit executablePath so Playwright
// falls back to its own bundled browser (macOS/other dev machines).
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const CHROMIUM_PATH =
  process.env.PW_CHROMIUM ||
  (fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

// Shared Chromium launch (SwiftShader software-GL). Both projects use it — the
// "headless"/"render" split is about worker concurrency, not GL capability.
const LAUNCH = {
  ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-webgpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    // DO NOT ADD --disable-frame-rate-limit HERE. It was tried, to cure menu
    // clicks that hang: Playwright's actionability poll ticks on rAF, and this
    // page's rAF rate can collapse under SwiftShader, so uncapping the frame
    // clock looks like the fix. Measured on an IDLE box, one browser at a time:
    //
    //   flags                          rAF     #mb-season click
    //   as below                       2/s     1632 ms
    //   + --disable-gpu-vsync          2/s     1569 ms
    //   + --disable-frame-rate-limit   7/s    11982 ms
    //
    // It makes clicking SEVEN TIMES SLOWER. Uncapping tells a CPU rasteriser to
    // render as fast as it can, and it obliges — two workers took the load
    // average past 9 on four cores and every spec slowed with it. The rAF rate
    // is not the lever; CPU headroom is. A menu click that hangs means the box
    // is oversubscribed, so lower --workers rather than raise the frame rate.
  ],
};

// The render suite: specs that take screenshots / pixel-diffs, drive real GL
// rendering, or assert DOM visibility. SwiftShader renders on the CPU, so past
// ~4-6 concurrent renderers a 16-core box THRASHES (measured) rather than speeds
// up. These run in the "render" project (cap its workers via
// `--project=render --workers=4`). Everything NOT in this list is a headless
// physics/geometry/hook/data spec that scales wide — the "headless" project.
// Keep this list exhaustive against tests/specs/*.spec.js (a coverage-audit npm script
// asserts every spec lands in exactly one project).
const RENDER_SPECS = [
  "smoke", "city-visual",
].map((n) => `**/${n}.spec.js`);

// Default worker cap: every worker owns a Chromium + SwiftShader process.
// Override with SPIDEY_WORKERS or Playwright's --workers=N.
const LOCAL_WORKERS = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
const REQUESTED_WORKERS = Number.parseInt(process.env.SPIDEY_WORKERS || "", 10);
const WORKERS = Number.isFinite(REQUESTED_WORKERS) && REQUESTED_WORKERS > 0
  ? REQUESTED_WORKERS
  : (process.env.CI ? 2 : LOCAL_WORKERS);

export default defineConfig({
  testDir: "./tests",
  // tests/manual/ holds the suites a HUMAN runs on purpose: the per-circuit
  // blank scan and contact sheets, and the gallery emitters. They render
  // hundreds of SwiftShader frames or produce images for review, so they gate
  // nothing and stay out of default discovery. Run them by explicit path
  // (see tests/manual/README.md).
  testIgnore: ["**/manual/**"],
  globalSetup: './tests/helpers/global-setup.js',
  fullyParallel: true,
  workers: WORKERS,
  // retries:1 hides flakiness the deterministic (mocked network, headless
  // obs/act/reset, geometry) suite is designed to avoid — surface it locally,
  // keep one retry in CI for genuine infra blips. live-reporter reports flaky
  // (passed-on-retry) counts either way.
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  outputDir: `artifacts/test-results${SUF}`,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Physics / geometry / hooks / data specs — assertion-only, scale wide.
      // Everything NOT in RENDER_SPECS. Run alone (fast) with:
      //   npx playwright test --project=headless --workers=8
      name: "headless",
      testIgnore: RENDER_SPECS,
      use: { ...devices["Desktop Chrome"], launchOptions: LAUNCH },
    },
    {
      // Screenshot / GL-heavy / DOM specs — cap workers to avoid SwiftShader
      // CPU thrash:  npx playwright test --project=render --workers=4
      name: "render",
      testMatch: RENDER_SPECS,
      use: { ...devices["Desktop Chrome"], launchOptions: LAUNCH },
    },
  ],
  webServer: {
    // python's http.server starts instantly with no package resolution, unlike
    // `npx serve` (which cold-resolves the package and often missed the old 10 s
    // window — the cause of flaky net::ERR_CONNECTION_REFUSED on the first specs).
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // The npm wrapper owns an in-process server, while direct local CLI use may
    // deliberately target a manually started :3456 server. Explicit SPIDEY_PORT
    // runs (test-shards/CI) must own their server to avoid teardown races.
    reuseExistingServer:
      process.env.SPIDEY_MANAGED_SERVER === "1" ||
      process.env.SPIDEY_REUSE_SERVER === "1" ||
      (!process.env.CI && !process.env.SPIDEY_PORT),
    timeout: 60_000,
    // python http.server logs every GET to stderr — hundreds of noise lines
    // per test that drown the reporter output in piped logs. Server startup
    // failures still surface as the webServer timeout error.
    stdout: "ignore",
    stderr: "ignore",
  },
  reporter: [
    // Live tail-able progress (see tests/helpers/live-reporter.js): timestamped
    // start/end line per test, written immediately — `tail -f` friendly.
    ["./tests/helpers/live-reporter.js"],
    ["html", { open: "never", outputFolder: `artifacts/report${SUF}` }],
    ["junit", { outputFile: `artifacts/test-results${SUF}/junit.xml` }],
  ],
});
