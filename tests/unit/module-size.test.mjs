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
