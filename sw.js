"use strict";
// Web-Slinger — offline cache service worker.
//
// No build step (see CLAUDE.md), so this file deliberately does NOT hand-maintain
// a precache manifest that could drift out of sync with a JS/CSS edit. Instead:
//   - CORE assets (index.html, css/js it references, manifest, icons) are
//     discovered by fetching+parsing the shell's OWN <script src>/<link href>
//     tags at install time — whatever index.html actually loads is what gets
//     cached, automatically, forever in sync with the existing `?v=N` bump.
//   - Everything else under assets/ is cached opportunistically the first time
//     it's fetched, so a full offline install follows naturally from one normal
//     play session. The soundtrack in particular MUST stay out of the install
//     set: three tracks is ~17 MB against a 5 MB shell, and a precache that
//     large turns first load into a stall on a phone — and fails the whole
//     install on a device with a tight cache quota.
//
// Cache name embeds version.json's build number, so every cache-bust bump
// (already required for any JS/CSS change per CLAUDE.md) automatically starts
// a fresh cache generation and the old one is swept on activate — no manual
// cache-invalidation step to remember.
const CACHE_PREFIX = "spidey-";
const INSTALL_COMPLETE_URL = "__spidey_install_complete__";

let _cacheNamePromise = null;
function currentCacheName() {
  if (_cacheNamePromise) return _cacheNamePromise;
  _cacheNamePromise = fetch("version.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => CACHE_PREFIX + (v && v.build ? v.build : "0"))
    .catch(() => CACHE_PREFIX + "0");
  return _cacheNamePromise;
}

// Parse the shell's own tags so the precache lists cannot drift from what
// index.html actually loads. The shell and executable styles/scripts are
// essential; metadata and icons improve the install but are best-effort.
async function precacheAssetLists() {
  const essential = new Set(["./", "index.html", "version.json"]);
  // Vendored three.js (TLX backend) is fetched by DYNAMIC import() through the
  // inline importmap, so the tag parser below never sees it. Seed it as
  // OPTIONAL: TLX is opt-in — install success for GLX users must not depend on
  // ~1 MB of vendor they never run (promote to essential at the Phase D flip).
  const optional = new Set(["manifest.json",
    // Rapier will be dynamic-import()ed (never tagged) when the combat phase
    // lands — seed it here the moment vendor/rapier-*/rapier.mjs is added, or
    // an installed PWA loses physics set-pieces offline. OPTIONAL, never
    // essential: the loader degrades to a no-op on failure.
  ]);
  const shell = await fetch("index.html", { cache: "no-store" });
  if (!shell || !shell.ok) throw new Error("Unable to fetch the application shell");
  const html = await shell.text();
  const re = /<(script|link)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[0].match(/\b(?:src|href)="([^"]+)"/i);
    if (!ref) continue;
    const u = ref[1];
    if (/^([a-z]+:)?\/\//i.test(u)) continue;   // skip any absolute/cross-origin URL
    if (m[1].toLowerCase() === "script" || /\brel="stylesheet"/i.test(m[0])) {
      essential.add(u);
    } else {
      optional.add(u);
    }
  }
  return { essential: Array.from(essential), optional: Array.from(optional) };
}

async function cacheRequiredAsset(cache, url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res || !res.ok) throw new Error("Unable to precache essential asset: " + url);
  await cache.put(url, res);
}

async function cacheOptionalAsset(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res && res.ok) await cache.put(url, res);
  } catch (_) { /* optional assets must not invalidate an otherwise healthy install */ }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const [name, urls] = await Promise.all([currentCacheName(), precacheAssetLists()]);
    const cache = await caches.open(name);
    await Promise.all(urls.essential.map((u) => cacheRequiredAsset(cache, u)));
    await cache.put(INSTALL_COMPLETE_URL, new Response("complete"));
    await Promise.all(urls.optional.map((u) => cacheOptionalAsset(cache, u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const name = await currentCacheName();
    const cache = await caches.open(name);
    if (!(await cache.match(INSTALL_COMPLETE_URL))) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // blob: URLs (the player's uploaded music, js/game/music-lib.js) report the
  // PAGE's origin, so the same-origin test below would wave them through — and
  // cache.put() throws on any non-HTTP scheme, which would fail the request
  // instead of just declining to cache it. Spec says a SW never sees these;
  // the guard is here so that stays true if it ever does.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.origin !== self.location.origin) return;   // never touch cross-origin (no cross-origin data is used)

  // Network-first for the HTML shell + version.json: the existing "SHELL
  // VERSION GUARD" in index.html depends on version.json always reflecting the
  // true latest deploy when online, so this SW must never let a cached
  // version.json mask a newer build. It only serves the cache when the
  // network is actually unavailable — that's the offline win.
  //
  // Racing the fetch against a short timeout (rather than only reacting to a
  // rejected promise) matters because "no network" doesn't always fail fast —
  // a dead/very slow connection can leave fetch() pending far longer than a
  // user will wait, and offline emulation in some embedding contexts (e.g. a
  // browser automation harness) can behave the same way. Either way the cache
  // fallback should win once it's clearly not going to resolve promptly; the
  // real network response, if it does eventually land, still gets cached.
  const isVersion = url.pathname.endsWith("version.json");
  if (req.mode === "navigate" || isVersion) {
    // version.json is NEVER written to the cache here. index.html fetches it as
    // "version.json?_=<Date.now()>", so every launch would put one more entry
    // under a URL (query included) that caches.match can never hit again — an
    // entry per launch until the next build bump sweeps the generation. The
    // precache already holds the bare "version.json" key, which is what the
    // offline fallback below reads.
    const network = fetch(req, { cache: "no-store" }).then(async (res) => {
      if (res && res.ok && !isVersion) {
        const cache = await caches.open(await currentCacheName());
        await cache.put(req, res.clone());
      }
      return res;
    });
    // If the timeout wins, respondWith() no longer protects the late refresh.
    // Keep the worker alive until both the fetch and its cache write settle.
    event.waitUntil(network.then(() => undefined, () => undefined));
    event.respondWith((async () => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch (_) { /* network rejected — fall through to cache */ }
      // Offline: the version request reads the PRECACHED bare key. Without this
      // it fell through to the index.html fallback below and answered a JSON
      // request with the shell's HTML (survivable only because the version
      // guard swallows the parse error).
      if (isVersion) return (await caches.match("version.json")) || Response.error();
      return (await caches.match(req)) || (await caches.match("index.html")) || Response.error();
    })());
    return;
  }

  // Cache-first for everything else. Every ?v=N URL is immutable content by
  // this project's own cache-busting convention, and audio/sfx never change
  // post-release, so a cache hit is always correct — no revalidation needed.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(await currentCacheName());
        await cache.put(req, res.clone());
      }
      return res;
    } catch (_) {
      return Response.error();
    }
  })());
});
