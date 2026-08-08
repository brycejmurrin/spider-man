// manifest.cjs — the module inventory, and the single source of truth for the
// import map in index.html.
//
// Unlike Apex 26 (classic scripts, hand-ordered <script> tags), this repo ships
// native ES modules: the BROWSER resolves load order from the import graph, so
// there is no order to hand-maintain and no HARD_EDGES list to get wrong. What
// still cannot be generated without a build step is CACHE BUSTING — an import
// specifier is a static string inside a module, so bumping the entry's ?v= does
// not reach its imports.
//
// The fix is an import map in index.html mapping every module path to itself
// with ?v=N appended. Import-map keys are resolved as URLs against the document
// base, so a relative `import "./render/glx.js"` inside js/game.js resolves to
// /js/render/glx.js and is remapped to /js/render/glx.js?v=N. One bump busts
// every module.
//
// tests/unit/load-order.test.mjs asserts index.html against this file, and
// additionally walks the real import graph: every module must be reachable from
// ENTRY, and every static import must resolve to a file that exists.
"use strict";

const ENTRY = "js/game.js";

// Every module in the repo. A new file must be added here AND imported by
// something reachable from ENTRY, or the load-order test fails both ways.
const MODULES = [
  "js/log.js",
  "js/mat4.js",
  "js/render/shaders/chunks.js",
  "js/render/shaders/lit.js",
  "js/render/shaders/sky.js",
  "js/render/shaders/fx.js",
  "js/render/shaders/post.js",
  "js/render/glx/post.js",
  "js/render/glx/shadow.js",
  "js/render/glx/chunked.js",
  "js/render/glx.js",
  "js/render/assets.js",
  "js/city/geom.js",
  "js/city/graph.js",
  "js/city/city-data.js",
  "js/city/buildings.js",
  "js/city/colliders.js",
  "js/city/citygen.js",
  "js/hero/hero3d.js",
  "js/game/store.js",
  "js/game/hero-consts.js",
  "js/game/hero.js",
  "js/game/webline.js",
  "js/game/cameras.js",
  "js/game/touch.js",
  "js/game/input.js",
  "js/game/hud.js",
  "js/game/audio.js",
  "js/game/spidey-api.js",
  "js/game.js",
];

const CSS = [
  "css/tokens.css",
  "css/game.css",
];

// Named paths so tools/tests follow a file move automatically.
const PATHS = {
  ENTRY,
  CITYGEN: "js/city/citygen.js",
  HERO: "js/game/hero.js",
  COLLIDERS: "js/city/colliders.js",
  GEOM: "js/city/geom.js",
};

// Modules that load in bare Node with no DOM/WebGL — the headless unit suites
// import these directly, so a dependency creeping in that touches `window`
// breaks `npm run test:tooling-fast` rather than failing silently in a browser.
/* ── THE LAYER TABLE ─────────────────────────────────────────────────────────
 * The one place that says what a module is allowed to depend on. Checked
 * against the REAL import graph by tests/unit/load-order.test.mjs, which
 * classifies each module by its resolved repo-relative path — never by the
 * spelling of a specifier. That distinction is the point: the guard this
 * replaces was a regex over source text, and a regex measures how a module
 * SPELLS its dependencies rather than what it does.
 *
 * Two edges carry the weight. **sim may not import viewmodel**, so no pose or
 * camera state can feed back into physics. **viewmodel may not import view**,
 * which is what keeps vantage() and pose() runnable in bare Node — the property
 * that turned a four-minute SwiftShader spec into a one-second one.
 *
 * Prefixes ending in "/" match a directory; others match one file exactly.
 * Every module must match exactly ONE prefix — zero or two is a failure, so a
 * new file cannot be quietly unclassified.
 */
const LAYERS = {
  // no imports, no state
  math: ["js/mat4.js"],
  // deterministic: no clock, no entropy, no IO, no view imports
  sim: ["js/city/", "js/game/hero-consts.js", "js/game/hero.js"],
  // pure derivation from sim state; may hold smoothing state and take dt.
  // hero3d.js belongs here and not in view: it imports js/city/geom.js, holds
  // nine damped pose scalars, takes dt, and imports nothing from js/render/.
  viewmodel: ["js/game/cameras.js", "js/hero/hero3d.js"],
  // owns GL, DOM, WebAudio, storage, rAF
  view: [
    "js/render/", "js/log.js", "js/game/hud.js", "js/game/audio.js",
    "js/game/input.js", "js/game/touch.js", "js/game/store.js",
    "js/game/webline.js",
  ],
  // the only modules importing both sides
  driver: ["js/game.js", "js/game/spidey-api.js"],
};

const ALLOWED = {
  math: [],
  sim: ["math", "sim"],
  viewmodel: ["math", "sim", "viewmodel"],
  view: ["math", "sim", "viewmodel", "view"],
  driver: ["math", "sim", "viewmodel", "view", "driver"],
};

/* Deliberate exceptions. `why` must be a real sentence — the test rejects a
 * short one, so `why: "x"` is not an escape hatch. There is no flag and no env
 * var on purpose: a guard people can --force around is worse than no guard. */
const LAYER_EXCEPTIONS = [];   // { from, to, why }

/* DERIVED, not hand-maintained. This list was written by hand and was wrong:
 * js/game/cameras.js was added to it while it was calling performance.now()
 * (it has done so since the original engine port), and js/mat4.js — which is
 * headless-safe by construction — was simply never listed. The layer table now
 * decides MEMBERSHIP; tests/unit/purity.test.mjs decides PURITY. */
const HEADLESS_SAFE = [...LAYERS.math, ...LAYERS.sim, ...LAYERS.viewmodel]
  .flatMap((p) => (p.endsWith("/") ? MODULES.filter((m) => m.startsWith(p)) : [p]));

module.exports = { ENTRY, MODULES, CSS, PATHS, HEADLESS_SAFE, LAYERS, ALLOWED, LAYER_EXCEPTIONS };
