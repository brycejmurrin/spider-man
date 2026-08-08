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
const HEADLESS_SAFE = [
  "js/city/geom.js", "js/city/graph.js", "js/city/city-data.js",
  "js/city/buildings.js", "js/city/colliders.js", "js/city/citygen.js",
  "js/game/hero-consts.js", "js/game/hero.js", "js/hero/hero3d.js",
];

module.exports = { ENTRY, MODULES, CSS, PATHS, HEADLESS_SAFE };
