/* Apex 26 — levelled, namespaced logging. Global `Log`. Loads FIRST — imported by every module, so it can be called at evaluation time.

   WHY THIS EXISTS. Before it, diagnostics were ~59 bare console.* calls that
   were on all the time and off never. The scenery suppression warnings alone
   fire dozens of times per track build, so the browser console was unusable
   during a build and every spec that listened to `console` had to filter noise
   it did not care about. There was also no way to turn anything UP: a bug you
   could not reproduce left nothing behind, because nothing was recorded.

   Two independent thresholds, which is the whole point:
     - the CONSOLE level decides what a human sees (default `warn` — exactly
       what the bare console.warn calls printed before, so nothing got louder)
     - the BUFFER level decides what is RETAINED in a ring buffer (default
       `info`), readable afterwards via __apex.logs(). A test that fails, or a
       player who hits something once, still has the record. Retention is never
       LOWER than the console level — see bufferAt().

   Configuration, highest precedence first:
     Log.level("scenery:debug")     — at runtime, or __apex.logLevel(...)
     ?log=debug&log=scenery:trace   — URL query, survives a reload
     localStorage spidey.logLevel   — sticky across sessions
     "warn" (console) / "info" (buffer)

   Spec grammar is a comma-separated list of `level` or `ns:level`, where a bare
   level sets the default for every namespace:
     "debug"                  everything at debug
     "warn,scenery:debug"     scenery verbose, the rest as shipped
     "silent"                 nothing to the console (the buffer still fills)
   Prefix a term with `buffer:` to move the retention threshold instead:
     "buffer:debug"           retain debug, still print only warnings

   HOT PATHS: the args to a call are evaluated whether or not it prints, so a
   per-frame or per-primitive debug line must be guarded:
     if (Log.enabled("scenery", Log.DEBUG)) Log.debug("scenery", expensive());

   Safe outside a browser: tools/track-build-vm.cjs loads the track engine into
   a Node VM with no localStorage and no location, so every host lookup here is
   feature-detected. */
export const Log = (function () {
  "use strict";

  // Ordered low → high. An entry passes a threshold when its level <= threshold.
  const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
  const NAMES = ["silent", "error", "warn", "info", "debug", "trace"];

  // The namespaces in use. Not enforced — an unknown namespace logs fine and
  // falls back to the default threshold — but a call site should pick from
  // here so `Log.level("<ns>:debug")` has a discoverable vocabulary.
  const NAMESPACES = [
    "scenery",   // prop placement + on-track suppression (js/track/scenery-*.js)
    "track",     // build orchestration, geometry rejection (js/track/tracks.js)
    "gfx",       // renderer backends: GLX / WGX / TLX (js/render/**)
    "game",      // game loop, race logic, physics (js/game.js, js/game/**)
    "data",      // the data hub + its API client (js/data/**)
    "net",       // multiplayer wire (js/net/**)
    "audio",     // WebAudio synth (js/game/audio.js)
    "assets",    // baked asset pack (js/render/assets.js)
    "apex",      // the __apex dev API itself (js/game/apex.js)
  ];

  const RING = 500;                 // records retained; oldest evicted first

  let consoleDefault = LEVELS.warn; // what a human sees
  let bufferDefault = LEVELS.info;  // what is retained for __apex.logs()
  const consoleNs = Object.create(null);   // ns -> level override
  const bufferNs = Object.create(null);

  const buf = [];                   // ring of {t, ns, level, msg}
  let seq = 0;                      // monotonic id, so logs({since}) can page
  let sink = null;                  // optional subscriber (tests, tools)

  // ── configuration ────────────────────────────────────────────────────────
  function parseLevel(name) {
    const l = LEVELS[String(name).trim().toLowerCase()];
    return l === undefined ? null : l;
  }

  /* Apply one spec string. Terms are `level`, `ns:level`, `buffer:level` or
     `buffer:ns:level`. An unparseable term is ignored rather than thrown — a
     typo in a URL must not take the game down. */
  function applySpec(spec) {
    if (!spec) return;
    for (let term of String(spec).split(",")) {
      term = term.trim();
      if (!term) continue;
      let toBuffer = false;
      if (/^buffer:/i.test(term)) { toBuffer = true; term = term.slice(7); }
      const colon = term.lastIndexOf(":");
      const ns = colon < 0 ? null : term.slice(0, colon).trim();
      const lvl = parseLevel(colon < 0 ? term : term.slice(colon + 1));
      if (lvl === null) continue;
      if (!ns || ns === "*") {
        if (toBuffer) { bufferDefault = lvl; wipe(bufferNs); }
        else { consoleDefault = lvl; wipe(consoleNs); }
      } else if (toBuffer) bufferNs[ns] = lvl;
      else consoleNs[ns] = lvl;
    }
  }

  function wipe(o) { for (const k in o) delete o[k]; }

  /* Read the sticky sources once at load. Query wins over localStorage so a
     link can override a stored setting without the player having to clear it;
     repeated ?log= terms all apply, left to right. */
  (function boot() {
    try {
      const ls = typeof localStorage !== "undefined" && localStorage.getItem("spidey.logLevel");
      if (ls) applySpec(ls);
    } catch (_) { /* privacy mode / no storage — the defaults stand */ }
    try {
      if (typeof location !== "undefined" && location.search) {
        const q = new URLSearchParams(location.search).getAll("log");
        for (const term of q) applySpec(term);
      }
    } catch (_) { /* no URL host (Node VM) */ }
  })();

  // ── emission ─────────────────────────────────────────────────────────────
  function threshold(table, def, ns) {
    const v = table[ns];
    return v === undefined ? def : v;
  }

  const consoleAt = (ns) => threshold(consoleNs, consoleDefault, ns);

  /* The buffer NEVER retains less than the console prints. You can retain more
     than you print (that is what `buffer:debug` is for), but the reverse is a
     trap: `logLevel("scenery:debug")` reads as "I want scenery debug", and if
     that only moved the console then the very next __apex.logs() would come
     back empty — the ring being the thing you read AFTER the fact is the whole
     reason it exists. Measured on a real page before this was a max(). */
  const bufferAt = (ns) => Math.max(threshold(bufferNs, bufferDefault, ns), consoleAt(ns));

  function enabled(ns, level) {
    return level <= bufferAt(ns);
  }

  /* Records are flattened to a string HERE, not at read time: a record that
     holds a live mesh or car object would keep it alive for the length of the
     ring and turn a diagnostic into a leak. */
  function flatten(args) {
    const out = [];
    for (const a of args) {
      if (typeof a === "string") out.push(a);
      else if (a instanceof Error) out.push(a.message + (a.stack ? "\n" + a.stack : ""));
      else {
        try { out.push(JSON.stringify(a)); }
        catch (_) { out.push(String(a)); }
      }
    }
    return out.join(" ");
  }

  const CONSOLE_FN = [null, "error", "warn", "info", "log", "debug"];

  function emit(level, ns, args) {
    const toConsole = level <= consoleAt(ns);
    const toBuffer = level <= bufferAt(ns);
    if (!toConsole && !toBuffer) return;

    const msg = flatten(args);
    const rec = { id: ++seq, t: now(), ns: ns, level: NAMES[level], msg: msg };
    if (toBuffer) {
      buf.push(rec);
      if (buf.length > RING) buf.shift();
    }
    if (toConsole) {
      try { console[CONSOLE_FN[level]]("[" + ns + "] " + msg); } catch (_) {}
    }
    // The sink sees everything either threshold admitted, so a test can watch
    // debug records without also printing them into the run log.
    if (sink) { try { sink(rec); } catch (_) {} }
  }

  function now() {
    try { return Math.round(performance.now()); } catch (_) { return 0; }
  }

  // ── public surface ───────────────────────────────────────────────────────
  const api = {
    SILENT: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5,
    LEVELS: LEVELS,
    NAMESPACES: NAMESPACES,

    error: function (ns) { emit(1, ns, [].slice.call(arguments, 1)); },
    warn:  function (ns) { emit(2, ns, [].slice.call(arguments, 1)); },
    info:  function (ns) { emit(3, ns, [].slice.call(arguments, 1)); },
    debug: function (ns) { emit(4, ns, [].slice.call(arguments, 1)); },
    trace: function (ns) { emit(5, ns, [].slice.call(arguments, 1)); },

    enabled: enabled,

    /* No arg reads the resolved thresholds; a string applies a spec and returns
       the new state, so __apex.logLevel("scenery:debug") is one round trip. */
    level: function (spec) {
      if (spec !== undefined && spec !== null) applySpec(spec);
      return {
        console: NAMES[consoleDefault],
        buffer: NAMES[bufferDefault],
        consoleNs: mapNames(consoleNs),
        bufferNs: mapNames(bufferNs),
      };
    },

    /* Persist a spec so it survives a reload — the shape a player follows when
       asked to reproduce a bug with diagnostics on. null clears it. */
    persist: function (spec) {
      try {
        if (spec === null) localStorage.removeItem("spidey.logLevel");
        else localStorage.setItem("spidey.logLevel", String(spec));
      } catch (_) { return false; }
      if (spec !== null) applySpec(spec);
      return true;
    },

    /* The retained records, newest last. `since` is a record id (see the `id`
       field), so a poller can ask only for what it has not seen. */
    records: function (filter) {
      const f = filter || {};
      const min = f.level === undefined ? 5 : (parseLevel(f.level) ?? 5);
      let out = buf;
      if (f.ns) out = out.filter((r) => r.ns === f.ns);
      if (f.since) out = out.filter((r) => r.id > f.since);
      out = out.filter((r) => LEVELS[r.level] <= min);
      if (f.limit > 0 && out.length > f.limit) out = out.slice(-f.limit);
      return out.slice();
    },

    clear: function () { buf.length = 0; return true; },

    /* Subscribe to every admitted record. One subscriber at a time (this is a
       debug seam, not an event bus); pass null to detach. */
    sink: function (fn) { sink = typeof fn === "function" ? fn : null; return !!sink; },

    /* Duration timing that costs nothing when the namespace is quiet:
         const done = Log.time("track", "build monza"); …; done();  */
    time: function (ns, label) {
      if (!enabled(ns, 3)) return function () {};
      const t0 = now();
      return function (extra) {
        emit(3, ns, [label + " " + (now() - t0) + "ms" + (extra ? " " + extra : "")]);
      };
    },
  };

  function mapNames(o) {
    const out = {};
    for (const k in o) out[k] = NAMES[o[k]];
    return out;
  }

  return api;
})();

// The track engine also runs inside a Node VM (tools/track-build-vm.cjs), where
// `window` is the sandbox itself and this assignment is a harmless self-set.
if (typeof window !== "undefined") window.Log = Log;
