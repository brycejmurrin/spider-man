/* module-size.test.mjs — a RATCHET on the files that only ever grow.
 *
 * The sibling project this engine came from records the failure mode: a July
 * reorg took its entry file from 8,955 lines to ~4,700, and it was back over
 * 8,000 within months. Nobody did anything wrong — nothing was watching, and
 * the net direction of an unbounded file is always up.
 *
 * So: a ceiling per file, and the rule that you LOWER it when you extract.
 * Raising one is allowed — this is a ratchet, not a cap on doing work — but it
 * has to be a deliberate edit here with a reason in the commit message. A
 * number nobody can raise gets deleted the first time it is inconvenient; a
 * number you must look at gets thought about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lines = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").split("\n").length;

// file -> ceiling. LOWER these when you extract.
const CEILINGS = {
  // The driver. It owns boot, the loop, frame assembly and the draw path and
  // nothing else — gameplay goes in js/game/, world in js/city/. Do not raise
  // this to land a feature; put the feature in a module.
  "js/game.js": 460,
  // The ported massing library. Cohesive (one switch over ~18 silhouettes), so
  // this is a drift alarm rather than an extraction target.
  "js/city/buildings.js": 420,
  "js/game/hero.js": 380,   // +80: anchor scoring, release curve, stall guard,
                            // constraint energy fix — each with its rationale
  // +20, deliberately: pose smoothing (nine damped scalars, so a state change
  // no longer snaps the right arm ~55 degrees in one frame) and web-arm
  // aiming. Both are pose work in the file that owns posing; extracting them
  // would put half a pose in another module. Lower this again if the mesh
  // builder ever moves out.
  "js/hero/hero3d.js": 260,
  "js/city/colliders.js": 220,
  "js/city/citygen.js": 220,
  "js/game/spidey-api.js": 180,
};

test("the big modules are not growing unnoticed", () => {
  const over = [];
  for (const [file, ceiling] of Object.entries(CEILINGS)) {
    const n = lines(file);
    if (n > ceiling) over.push(`${file}: ${n} lines, ceiling ${ceiling} (+${n - ceiling})`);
  }
  assert.deepEqual(over, [],
    "a module grew past its ceiling — extract something, or raise the ceiling in " +
    "tests/unit/module-size.test.mjs deliberately and say why in the commit");
});

test("a ceiling is not left far above the file it guards", () => {
  // The other failure mode: extract 200 lines, never lower the ceiling, and the
  // ratchet silently stops ratcheting.
  const slack = [];
  for (const [file, ceiling] of Object.entries(CEILINGS)) {
    const n = lines(file);
    if (ceiling - n > 120) slack.push(`${file}: ${n} lines but ceiling is ${ceiling} — lower it`);
  }
  assert.deepEqual(slack, [], "a ceiling drifted far above its file — lower it so the ratchet keeps working");
});

/* ── the ApiPorts ratchet ────────────────────────────────────────────────────
 * The object js/game.js hands to createApi(). It has ONE consumer, and it must
 * stay that way: a port exists because __spidey needs to expose that thing,
 * never because a module needed a reference across a file boundary. ES modules
 * mean a module that needs something imports it. The sibling project's
 * equivalent façade reached ~140 members, but only because IIFE modules cannot
 * import — a forcing function that does not exist here. Ratcheting at 16 costs
 * ten lines now instead of a quarter of untangling later.
 */
const PORT_CEILING = 16;

function portNames() {
  const src = fs.readFileSync(path.join(ROOT, "js/game.js"), "utf8");
  const at = src.indexOf("createApi({");
  assert.ok(at >= 0, "could not find the createApi({ … }) literal in js/game.js");
  // Brace-match, then split on DEPTH-0 commas. A line-oriented regex undercounts
  // silently: eight of these share one line, and a count that reads 11 instead
  // of 19 makes the ratchet permanently green — which is worse than absent.
  let i = src.indexOf("{", at), depth = 0, end = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(src.indexOf("{", at) + 1, end);
  const parts = [];
  let buf = "", d = 0;
  for (const ch of body) {
    if ("{[(".includes(ch)) d++;
    else if ("}])".includes(ch)) d--;
    if (ch === "," && d === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);
  const names = new Set();
  for (const p of parts) {
    const m = p.replace(/\/\/[^\n]*/g, "").trim()
      .match(/^(?:get|set)\s+([A-Za-z_$][\w$]*)|^([A-Za-z_$][\w$]*)/);
    if (m) names.add(m[1] || m[2]);
  }
  return [...names];
}

test("ApiPorts stays small, and every port is read", () => {
  const names = portNames();
  assert.ok(names.length > 5, `the port parser found only ${names.length} — it is broken, not the code`);
  assert.ok(names.length <= PORT_CEILING,
    `ApiPorts has ${names.length} members, ceiling ${PORT_CEILING}.\n` +
    "  A port is allowed only because __spidey must expose that thing. If a module\n" +
    "  needs it, import the module. Deliberate? Raise PORT_CEILING and say why.");

  // The half that earns its keep: a port nobody reads is the first symptom of a
  // façade becoming a grab bag. This found three on its first run.
  const api = fs.readFileSync(path.join(ROOT, "js/game/spidey-api.js"), "utf8");
  assert.ok(!/\bports\s*\[|\bconst\s*\{[^}]*\}\s*=\s*G\b/.test(api),
    "spidey-api.js uses computed or destructured port access — the dead-port scan below is unsound");
  const dead = names.filter((n) => !new RegExp(`\\bG\\.${n}\\b`).test(api));
  assert.deepEqual(dead, [],
    `ApiPorts exposes ${dead.join(", ")} but js/game/spidey-api.js never reads it.\n` +
    "  Delete the port, or if __spidey genuinely needs it, use it.");
});
