/* load-order.test.mjs — asserts index.html against tools/manifest.cjs, and
 * asserts the manifest against the REAL import graph.
 *
 * This repo ships native ES modules, so the browser resolves load ORDER itself
 * and there is no tag sequence to keep in sync. Two things still can't be
 * generated without a build step, and both are checked here:
 *
 *   1. Cache busting. An import specifier is a static string inside a module,
 *      so bumping the entry's ?v= does not reach its imports. index.html
 *      carries an import map that remaps every module to itself with ?v=N.
 *      A module missing from that map loads UNVERSIONED and goes stale for
 *      every returning player — invisible locally, permanent in production.
 *   2. Reachability. "created the file, forgot to import it" and "imported a
 *      path that doesn't exist" are both caught by walking the graph from ENTRY.
 *
 * Run: node --test tests/unit/load-order.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MANIFEST = require("../../tools/manifest.cjs");
const ROOT = new URL("../..", import.meta.url).pathname;

const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

function importMap() {
  const m = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(m, "index.html must carry an <script type=\"importmap\">");
  return JSON.parse(m[1]).imports;
}
const linkHrefs = [...indexHtml.matchAll(/<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
const moduleSrcs = [...indexHtml.matchAll(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const stripV = (u) => u.replace(/\?v=\d+$/, "");
const vOf = (u) => { const m = u.match(/\?v=(\d+)$/); return m ? parseInt(m[1], 10) : null; };

test("the import map covers exactly MANIFEST.MODULES", () => {
  const keys = Object.keys(importMap()).map((k) => k.replace(/^\.\//, ""));
  assert.deepEqual(keys.sort(), [...MANIFEST.MODULES].sort());
});

test("every import-map target is its own key plus the build ?v=", () => {
  const map = importMap();
  const versions = new Set();
  for (const [k, v] of Object.entries(map)) {
    assert.equal(stripV(v), k, `${k} must map to itself with a ?v=, got ${v}`);
    versions.add(vOf(v));
  }
  assert.equal(versions.size, 1, `mixed ?v= values in the import map: ${[...versions]}`);
});

test("stylesheets, the entry module and version.json all carry the same build", () => {
  const vs = new Set([...linkHrefs, ...moduleSrcs].map(vOf));
  for (const v of Object.values(importMap())) vs.add(vOf(v));
  assert.equal(vs.size, 1, `mixed ?v= values across index.html: ${[...vs].join(", ")}`);
  const v = [...vs][0];
  assert.ok(Number.isInteger(v) && v > 0, "assets must carry ?v=N");
  const versionJson = JSON.parse(readFileSync(join(ROOT, "version.json"), "utf8"));
  assert.equal(versionJson.build, v, "version.json build must equal the ?v= build");
});

test("stylesheet sequence equals MANIFEST.CSS", () => {
  assert.deepEqual(linkHrefs.map(stripV), MANIFEST.CSS);
});

test("index.html loads exactly one module entry, and it is MANIFEST.ENTRY", () => {
  assert.deepEqual(moduleSrcs.map(stripV), [MANIFEST.ENTRY]);
});

// ── the real import graph ───────────────────────────────────────────────────
function staticImports(file) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out = [];
  // `import ... from "x"`, `import "x"`, and `export ... from "x"`
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}
function walk() {
  const seen = new Set(), missing = [];
  (function visit(f) {
    if (seen.has(f)) return;
    seen.add(f);
    for (const spec of staticImports(f)) {
      if (!spec.startsWith(".")) continue;   // bare specifiers would need a map entry
      const target = normalize(join(dirname(f), spec));
      if (!existsSync(join(ROOT, target))) { missing.push(`${f} -> ${spec}`); continue; }
      visit(target);
    }
  })(MANIFEST.ENTRY);
  return { seen, missing };
}

test("every static import resolves to a file that exists", () => {
  assert.deepEqual(walk().missing, []);
});

test("every js/**/*.js is reachable from the entry, and vice versa", () => {
  const files = [];
  (function w(dir) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) w(rel);
      else if (name.endsWith(".js")) files.push(rel);
    }
  })("js");
  const { seen } = walk();
  const orphans = files.filter((f) => !seen.has(f));
  const ghosts = [...seen].filter((f) => !files.includes(f));
  assert.deepEqual(orphans, [], `js/ files nothing imports (wire them up or delete them): ${orphans}`);
  assert.deepEqual(ghosts, [], `walked files that are not on disk: ${ghosts}`);
  // and the manifest agrees with the graph
  assert.deepEqual([...seen].sort(), [...MANIFEST.MODULES].sort());
});

test("every module is modulepreloaded at the mapped URL", () => {
  // Without preload the browser discovers the graph one round trip per level;
  // with it, every module is in flight from the first byte of the shell. The
  // href must be the MAPPED url or the preload misses and is wasted.
  const pre = [...indexHtml.matchAll(/<link[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  const map = importMap();
  const want = MANIFEST.MODULES.map((m) => map["./" + m].replace(/^\.\//, ""));
  assert.deepEqual(pre.sort(), want.sort());
});

test("the on-screen build number is derived, not a stale literal", () => {
  assert.ok(!/window\.__SPIDEY_BUILD\s*=\s*[1-9]\d*/.test(indexHtml),
    "index.html must not hardcode window.__SPIDEY_BUILD = <number> (the ?v= bump does not touch it)");
});

test("headless-safe modules import nothing that touches the DOM or WebGL", () => {
  // The unit suites import these directly in bare Node. A dependency creeping
  // in that reaches for window/document/GLX must fail HERE, in 20 ms, not as a
  // confusing crash inside an unrelated test.
  const banned = /\b(document|localStorage|requestAnimationFrame|navigator)\b|from "\.\.\/render\//;
  for (const f of MANIFEST.HEADLESS_SAFE) {
    const seen = new Set();
    (function visit(g) {
      if (seen.has(g)) return;
      seen.add(g);
      const src = readFileSync(join(ROOT, g), "utf8");
      assert.ok(!banned.test(src), `${g} is reachable from headless-safe ${f} but touches the DOM/renderer`);
      for (const spec of staticImports(g)) {
        if (spec.startsWith(".")) visit(normalize(join(dirname(g), spec)));
      }
    })(f);
  }
});
