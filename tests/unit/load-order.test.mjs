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

// ── the layer table ─────────────────────────────────────────────────────────
// Classify by RESOLVED repo-relative path, never by the text of a specifier.
// The regex guard below is coupled to the spelling `../render/`; a resolved
// path is not, so this is path-depth independent by construction.
function layerOf(file) {
  const hits = [];
  for (const [layer, prefixes] of Object.entries(MANIFEST.LAYERS)) {
    for (const p of prefixes) {
      if (p.endsWith("/") ? file.startsWith(p) : file === p) { hits.push(layer); break; }
    }
  }
  return hits;
}

test("every module lands in exactly one layer", () => {
  // Zero matches means a new file was added without deciding what it IS, which
  // is the moment that decision is cheapest. Two means the table overlaps.
  const bad = MANIFEST.MODULES.map((m) => [m, layerOf(m)]).filter(([, h]) => h.length !== 1);
  assert.deepEqual(bad, [], bad.map(([m, h]) =>
    h.length === 0 ? `${m} is in no layer — add it to LAYERS in tools/manifest.cjs`
                   : `${m} matches ${h.join(" and ")}`).join("\n"));
});

test("no layer prefix is stale", () => {
  // A prefix matching nothing is a file that moved. Without this the entry
  // silently classifies zero modules and the table quietly stops guarding them.
  const dead = Object.entries(MANIFEST.LAYERS).flatMap(([l, ps]) =>
    ps.filter((p) => !MANIFEST.MODULES.some((m) => (p.endsWith("/") ? m.startsWith(p) : m === p)))
      .map((p) => `${l}: ${p}`));
  assert.deepEqual(dead, [], `LAYERS prefixes matching no module: ${dead}`);
});

test("no module imports across a forbidden layer edge", () => {
  const why = {
    sim: "the simulation may not depend on anything that derives a view. If the " +
         "sim genuinely needs this, the thing it needs is not a viewmodel — move it " +
         "to sim, or invert the call so the driver passes the value in.",
    viewmodel: "a viewmodel must stay runnable in bare Node. Importing view code is " +
         "what turns a 1-second unit test back into a 4-minute browser spec.",
    math: "math imports nothing.",
    view: "", driver: "",
  };
  const violations = [];
  for (const f of MANIFEST.MODULES) {
    const from = layerOf(f)[0];
    if (!from) continue;
    for (const spec of staticImports(f)) {
      if (!spec.startsWith(".")) continue;
      const target = normalize(join(dirname(f), spec));
      const to = layerOf(target)[0];
      if (!to || MANIFEST.ALLOWED[from].includes(to)) continue;
      if (MANIFEST.LAYER_EXCEPTIONS.some((e) => e.from === f && e.to === target)) continue;
      violations.push(
        `layer violation: ${f} (${from}) imports ${target} (${to})\n` +
        `  ${from} may import: ${MANIFEST.ALLOWED[from].join(", ") || "nothing"}.\n` +
        `  ${why[from]}\n` +
        `  Deliberate? Add { from, to, why } to LAYER_EXCEPTIONS in tools/manifest.cjs.`);
    }
  }
  assert.deepEqual(violations, [], violations.join("\n\n"));
});

test("layer exceptions carry a real reason", () => {
  // The escape hatch is a sentence someone has to write and a reviewer reads,
  // not a flag. `why: "x"` must not work.
  for (const e of MANIFEST.LAYER_EXCEPTIONS) {
    assert.ok(typeof e.why === "string" && e.why.length > 20,
      `LAYER_EXCEPTIONS ${e.from} -> ${e.to} needs a why: explaining itself`);
  }
});

test("deterministic layers use no dynamic import", () => {
  // The walker cannot follow import(), so an edge hidden behind one would be
  // silently unchecked. Ban it rather than pretend to cover it.
  const checked = [...MANIFEST.LAYERS.math, ...MANIFEST.LAYERS.sim, ...MANIFEST.LAYERS.viewmodel];
  const hits = MANIFEST.MODULES
    .filter((m) => checked.some((p) => (p.endsWith("/") ? m.startsWith(p) : m === p)))
    .filter((m) => /\bimport\s*\(/.test(readFileSync(join(ROOT, m), "utf8")));
  assert.deepEqual(hits, [], `dynamic import in a checked layer (the graph walker cannot see it): ${hits}`);
});

test("headless-safe modules import nothing that touches the DOM or WebGL", () => {
  // DEMOTED to a cheap early warning. It is provably incomplete: js/game/hud.js
  // writes el.textContent on every line of update() and passes this, because
  // its elements arrive by injection (createHud(els)) so no banned token ever
  // appears in the file. It also false-positives on its own documentation —
  // js/game/hero.js's comment saying there is no Math.random contains the
  // string "Math.random". The layer table above decides MEMBERSHIP and
  // tests/unit/purity.test.mjs decides PURITY; this only catches the obvious
  // case fast.
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

test("nothing outside hero.js writes the hero's position", () => {
  // The CROSS-FILE half of the two-writer invariant, and only that half. A
  // lexical audit inside hero.js would claim more than it can prove — it cannot
  // see `const q = hero.p; q[0] = …`, a helper handed `p`, or a typed-array
  // set — and it would redden on a rename or an extraction that changes
  // nothing, which is how a guard teaches people to work around it. The
  // in-file invariant is proved BEHAVIOURALLY by hero-swing.test.mjs ("the
  // tether never stretches", "never inside a wall"), and those survive renames.
  //
  // This half is sound and catches the genuinely dangerous case: a renderer,
  // the HUD or the dev API nudging the hero behind the model's back.
  const bad = [];
  for (const f of MANIFEST.MODULES) {
    if (f === "js/game/hero.js") continue;
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\bhero\.p\s*(?:\[[^\]]*\]\s*=[^=]|\.(?:set|fill|copyWithin)\s*\()/g)) {
      bad.push(`${f}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(bad, [],
    "only js/game/hero.js may write hero.p — the position is the authority and " +
    "the model owns its commit point:\n  " + bad.join("\n  "));
});

test("js/render/ as a whole is ratcheted", () => {
  // A DIRECTORY total, not per-file ceilings. Per-file numbers on 2,600 lines
  // of GLSL held in JS strings measure nothing actionable — you cannot extract
  // a fragment shader to satisfy a ratchet — and five ceilings that fire on
  // legitimate work teach people that raising ceilings is routine, which
  // corrodes the six in module-size.test.mjs that guard hand-written files.
  // The total catches the hole the per-file ratchet actually has: moving 300
  // lines into a new, unguarded file.
  const CEILING = 6900;
  const n = MANIFEST.MODULES.filter((m) => m.startsWith("js/render/"))
    .reduce((a, m) => a + readFileSync(join(ROOT, m), "utf8").split("\n").length, 0);
  assert.ok(n <= CEILING, `js/render/ is ${n} lines, ceiling ${CEILING}`);
  assert.ok(CEILING - n <= Math.max(120, 0.08 * CEILING),
    `js/render/ is ${n} lines but the ceiling is ${CEILING} — lower it so the ratchet keeps working`);
});
