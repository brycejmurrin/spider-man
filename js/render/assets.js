/*
 * Apex 26 — Assets: the baked asset pack loader.
 *
 * Loads `assets/pack/manifest.json` and everything it references: the baked PBR
 * MATERIAL ARRAYS (albedo+roughness, normal+AO), baked MODEL geometry, and
 * per-(track, time-of-day) ENVIRONMENT ambient. Produced offline by
 * `node tools/assets.mjs` — see docs/research/ASSET-API-RESEARCH.md.
 *
 * THREE THINGS THIS MODULE GUARANTEES, because the game shipped for years
 * without any of these assets and must keep working without them:
 *
 *  1. NO PACK IS A VALID STATE. A 404 on the manifest, a malformed manifest, a
 *     half-decoded image — every failure path leaves the game rendering its
 *     pure-procedural look. Nothing here throws into the caller and nothing
 *     here is awaited by the boot path.
 *  2. THE BACKEND MAY NOT SUPPORT IT. Material arrays need
 *     `gfx.createTextureArray`, which GLX (WebGL2) and TLX (three) implement
 *     and WGX (WebGPU) does not — WGX has not ported the procedural material
 *     system either (js/render/webgpu/wgsl-chunks.js:147), so there is nothing
 *     there for a baked map to augment. Feature-detected, never assumed.
 *  3. THE KNOB IS THE OFF-SWITCH. The lit shader's uMatTexMix is a LIGHTING
 *     TUNER knob shipped at 1.0 (TUNE_DEFS matTexMix), so a present pack is ON
 *     by default. `matTexMix` 0 / `__apex.matTex(0)` is the A/B off-switch that
 *     restores the pure-procedural render — and at 0 the pack is never fetched.
 *
 * NO build step, no ES modules: "use strict" IIFE assigning one global
 * `Assets`. Loads after glx.js and before game.js. Nothing runs at load time.
 */
"use strict";

export const Assets = (function () {
  // Pack URLs carry no ?v= cache-bust (index.html's version guard only rewrites
  // the shell's own script/link tags), so these fetches use DEFAULT caching
  // rather than force-cache: force-cache would serve a stale pack out of the
  // HTTP cache indefinitely, and a rebaked pack would never reach anyone who
  // had already loaded the old one. Normal revalidation plus sw.js's
  // build-numbered cache generation is what makes a rebake actually land.
  const PACK_DIR = "assets/pack/";
  const MANIFEST = PACK_DIR + "manifest.json";
  const MAT_LAYERS = 17;                 // MAT.FLAT(0) … MAT.ASPHALT(16)

  let _gfx = null;
  let _manifest = null;
  let _loadPromise = null;
  let _uploaded = false;
  let _err = null;                       // last failure reason, for __apex.assets()
  let _bytes = 0;                        // bytes fetched for the material arrays
  let _tier = null;                      // "high" | "low" | "off"
  const _models = Object.create(null);   // id -> {pos,nrm,col,mat,idx} | null (miss)
  const _modelPromises = Object.create(null);

  // Bind the active renderer. game.js calls this once, right after it resolves
  // gfx (GLX or a Gfx.create() backend), and before any load().
  function init(gfx) { _gfx = gfx || null; }

  function supported() {
    return !!(_gfx && typeof _gfx.createTextureArray === "function" &&
              typeof _gfx.setMaterialMaps === "function");
  }

  // ── manifest ───────────────────────────────────────────────────────────────

  async function manifest() {
    if (_manifest !== null) return _manifest;
    try {
      const res = await fetch(MANIFEST);
      if (!res.ok) { _manifest = false; _err = "no-pack"; return false; }
      const j = await res.json();
      if (!j || typeof j !== "object") { _manifest = false; _err = "bad-manifest"; return false; }
      _manifest = j;
      return j;
    } catch (e) {
      // A 404 here is the NORMAL case for a checkout with no pack baked. Don't
      // log — a console error on every boot would train people to ignore it.
      _manifest = false; _err = "no-pack";
      return false;
    }
  }

  // ── material arrays ────────────────────────────────────────────────────────

  // The two material images are FILMSTRIPS: one image of size×(size*layers)
  // with layer N at y = N*size. One request instead of seventeen, and
  // createImageBitmap can slice a sub-rectangle without a canvas round-trip.
  async function _decodeStrip(file, size, present) {
    const res = await fetch(PACK_DIR + file);
    if (!res.ok) throw new Error("fetch " + file);
    const blob = await res.blob();
    _bytes += blob.size;
    const out = new Array(MAT_LAYERS);
    try {
      for (let i = 0; i < MAT_LAYERS; i++) {
        if (!present[i]) continue;
        // Slice straight out of the encoded blob — no intermediate canvas, so a
        // 17-layer strip costs one decode and seventeen crops.
        out[i] = await createImageBitmap(blob, 0, i * size, size, size);
      }
      return out;
    } catch (_) {
      // The cropping overload of createImageBitmap has a patchy history on
      // Safari. Fall back to one full-strip decode plus canvas crops, which
      // every engine supports — slower and it allocates, but it is the
      // difference between iOS getting baked materials and not.
      _releaseStrip(out);
      const full = await createImageBitmap(blob);
      try {
        const cv = (typeof OffscreenCanvas !== "undefined")
          ? new OffscreenCanvas(size, size)
          : Object.assign(document.createElement("canvas"), { width: size, height: size });
        const c2d = cv.getContext("2d");
        if (!c2d) throw new Error("no-2d-context");
        const alt = new Array(MAT_LAYERS);
        for (let i = 0; i < MAT_LAYERS; i++) {
          if (!present[i]) continue;
          c2d.clearRect(0, 0, size, size);
          c2d.drawImage(full, 0, i * size, size, size, 0, 0, size, size);
          alt[i] = await createImageBitmap(cv);
        }
        return alt;
      } finally {
        if (full.close) { try { full.close(); } catch (__) {} }
      }
    }
  }

  function _releaseStrip(imgs) {
    if (!imgs) return;
    for (const b of imgs) { if (b && b.close) { try { b.close(); } catch (_) {} } }
  }

  // Load + upload the baked material arrays. Resolves to true only when the
  // arrays are actually live on the GPU; false (never a rejection) otherwise.
  // Safe to call repeatedly — concurrent calls share one in-flight promise.
  function load(opts) {
    if (_loadPromise) return _loadPromise;
    _loadPromise = _load(opts || {}).catch((e) => {
      _err = (e && e.message) || "load-failed";
      return false;
    });
    return _loadPromise;
  }

  async function _load(opts) {
    if (!supported()) { _err = "backend"; _tier = "off"; return false; }
    const m = await manifest();
    if (!m || !m.materials) { _tier = "off"; return false; }
    const mats = m.materials;

    // Tier: phones get the small strip if the pack baked one. `mobileTier` is
    // the renderer's own memory-pressure signal — the same one that caps
    // shadow-map and scene-buffer sizes.
    const wantLow = opts.tier ? opts.tier === "low"
                              : !!(_gfx.isMobile || _gfx.mobileTier);
    const variant = (wantLow && mats.low) ? mats.low : mats;
    const size = variant.size | 0;
    if (!size || !variant.albedo) { _err = "bad-materials"; _tier = "off"; return false; }

    // Which layers exist, and at what world tile size. A layer with no entry
    // (or scale <= 0) keeps its procedural look — GLASS and FLAG are deliberate
    // omissions: a baked map would blur glass's mirror read, and FLAG's
    // geometry is displaced in the vertex shader.
    const present = new Array(MAT_LAYERS).fill(false);
    const scales = new Float32Array(MAT_LAYERS);
    for (const L of (variant.layers || [])) {
      const id = L.mat | 0;
      if (id <= 0 || id >= MAT_LAYERS) continue;
      if (!(L.scale > 0)) continue;
      present[id] = true;
      scales[id] = L.scale;
    }
    if (!present.some(Boolean)) { _err = "no-layers"; _tier = "off"; return false; }

    let albedo = null, normal = null, albedoTex = null, normalTex = null;
    try {
      albedo = await _decodeStrip(variant.albedo, size, present);
      albedoTex = _gfx.createTextureArray(size, albedo, MAT_LAYERS);
      if (!albedoTex) throw new Error("albedo-upload");
      if (variant.normal) {
        normal = await _decodeStrip(variant.normal, size, present);
        normalTex = _gfx.createTextureArray(size, normal, MAT_LAYERS);
        // A missing normal array is survivable — albedo alone still helps.
      }
    } catch (e) {
      if (albedoTex && _gfx.freeTexture) _gfx.freeTexture(albedoTex);
      if (normalTex && _gfx.freeTexture) _gfx.freeTexture(normalTex);
      _releaseStrip(albedo); _releaseStrip(normal);
      _err = (e && e.message) || "decode-failed";
      _tier = "off";
      return false;
    }
    // ImageBitmaps are copied into the texture on upload; holding them past
    // that pins a second full copy of the pack in memory.
    _releaseStrip(albedo); _releaseStrip(normal);

    _gfx.setMaterialMaps({ albedo: albedoTex, normal: normalTex, scales: scales });
    _uploaded = true;
    _tier = wantLow && mats.low ? "low" : "high";
    _err = null;
    return true;
  }

  // Adopt material layers built in the BROWSER rather than fetched from a pack.
  // `albedoImgs`/`normalImgs` are sparse arrays indexed by MAT id holding
  // anything createTextureArray accepts (ImageBitmap / canvas / ImageData).
  //
  // This exists for assets/pack/webbake.js, the in-browser baker: Poly Haven's
  // API and CDN both allow cross-origin canvas reads, so a browser can pull real
  // CC0 scans, composite them and preview them live — which is the only route to
  // real materials for anyone without a shell. Returns the new state(); never
  // throws, and a failure leaves the previous arrays untouched.
  function adopt(size, albedoImgs, normalImgs, scales) {
    if (!supported() || !size || !albedoImgs) { _err = "adopt-unsupported"; return state(); }
    let a = null, n = null;
    try {
      a = _gfx.createTextureArray(size, albedoImgs, MAT_LAYERS);
      if (!a) throw new Error("albedo-upload");
      if (normalImgs) n = _gfx.createTextureArray(size, normalImgs, MAT_LAYERS);
    } catch (e) {
      if (a && _gfx.freeTexture) _gfx.freeTexture(a);
      if (n && _gfx.freeTexture) _gfx.freeTexture(n);
      _err = (e && e.message) || "adopt-failed";
      return state();
    }
    const sc = new Float32Array(MAT_LAYERS);
    for (let i = 0; i < MAT_LAYERS; i++) sc[i] = scales && scales[i] > 0 ? scales[i] : 0;
    _gfx.setMaterialMaps({ albedo: a, normal: n, scales: sc });
    _uploaded = true; _tier = "browser-bake"; _err = null;
    return state();
  }

  // Drop the material arrays and go back to the procedural look. Used by the
  // tier switch and by tests that need a clean slate.
  function unload() {
    if (_gfx && _gfx.setMaterialMaps) _gfx.setMaterialMaps(null);
    _uploaded = false;
    _tier = "off";
    _loadPromise = null;
  }

  // ── baked models ───────────────────────────────────────────────────────────

  // A baked model is the game's OWN interleaved vertex format, not glTF: the
  // bake tool (tools/assets.mjs) already resolved materials down to a vertex
  // colour plus a MAT id, so this is a straight typed-array view with no
  // parsing, no material resolution and no runtime cost beyond the fetch.
  //
  // Layout (little-endian): magic "AX26" | u32 version | u32 vertCount |
  // u32 idxCount | u32 flags | f32 pos[3*v] | f32 nrm[3*v] | f32 col[3*v] |
  // f32 mat[v] | u32 idx[i]
  function _parseModel(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 20) return null;
    // "AX26" as four bytes, checked individually so endianness cannot bite.
    if (dv.getUint8(0) !== 0x41 || dv.getUint8(1) !== 0x58 ||
        dv.getUint8(2) !== 0x32 || dv.getUint8(3) !== 0x36) return null;
    const ver = dv.getUint32(4, true);
    if (ver !== 1) return null;
    const nv = dv.getUint32(8, true), ni = dv.getUint32(12, true);
    if (!nv || !ni) return null;
    let o = 20;
    const need = o + nv * 3 * 4 * 3 + nv * 4 + ni * 4;
    if (dv.byteLength < need) return null;
    const pos = new Float32Array(buf, o, nv * 3); o += nv * 12;
    const nrm = new Float32Array(buf, o, nv * 3); o += nv * 12;
    const col = new Float32Array(buf, o, nv * 3); o += nv * 12;
    const mat = new Float32Array(buf, o, nv);     o += nv * 4;
    const idx = new Uint32Array(buf, o, ni);
    return { pos, nrm, col, mat, idx };
  }

  // Fetch + parse a baked model by manifest id. Resolves to the mesh data, or
  // null when the pack has no such model — callers fall back to the procedural
  // geometry they already build.
  function model(id) {
    if (id in _models) return Promise.resolve(_models[id]);
    if (_modelPromises[id]) return _modelPromises[id];
    _modelPromises[id] = (async () => {
      try {
        const m = await manifest();
        const rec = m && m.models && m.models[id];
        if (!rec || !rec.file) { _models[id] = null; return null; }
        const res = await fetch(PACK_DIR + rec.file);
        if (!res.ok) { _models[id] = null; return null; }
        const parsed = _parseModel(await res.arrayBuffer());
        _models[id] = parsed;
        return parsed;
      } catch (_) {
        _models[id] = null;
        return null;
      } finally {
        delete _modelPromises[id];
      }
    })();
    return _modelPromises[id];
  }

  // Ids of every baked model in the pack (empty without a pack).
  function models() {
    return _manifest && _manifest.models ? Object.keys(_manifest.models) : [];
  }

  // SYNCHRONOUS lookup — null until loadModels() has resolved.
  //
  // This exists because the track build is synchronous all the way down:
  // Tracks.build -> buildProps -> the circuit's own scenery(api) callback. An
  // async fetch inside that call chain would make prop placement depend on
  // network timing, so the same circuit could build differently twice. Models
  // are therefore ALL prefetched before a track builds, and placement is a
  // plain cache read that either has the geometry or definitively does not.
  function modelSync(id) { return _models[id] || null; }

  // Prefetch every model in the pack. Resolves to the number now resident.
  // Cheap by construction: `tools/assets.mjs verify` caps the whole pack at
  // 8 MB, so this is never a large download.
  async function loadModels() {
    const m = await manifest();
    if (!m || !m.models) return 0;
    await Promise.all(Object.keys(m.models).map((id) => model(id)));
    return Object.keys(_models).reduce((n, k) => n + (_models[k] ? 1 : 0), 0);
  }

  // ── baked environment (HDRI-derived ambient) ───────────────────────────────

  // Returns {ambientSky, ambientGround, skyZenith?, skyHorizon?} for a
  // "<track>|<tod>" key, falling back to "*|<tod>" then null. These are values
  // applyRaceSettings already consumes, so an HDRI bake needs no shader change
  // at all — it just replaces hand-picked hemisphere colours with measured ones.
  function env(trackId, tod) {
    const m = _manifest;
    if (!m || !m.env) return null;
    return m.env[trackId + "|" + tod] || m.env["*|" + tod] || null;
  }

  // ── introspection ──────────────────────────────────────────────────────────

  function state() {
    const gs = (_gfx && _gfx.materialMapState) ? _gfx.materialMapState() : null;
    return {
      supported: supported(),
      pack: !!_manifest,
      uploaded: _uploaded,
      tier: _tier,
      layers: gs ? gs.layers : 0,
      normal: gs ? gs.normal : false,
      scales: gs ? gs.scales : null,
      bytes: _bytes,
      models: models().length,
      error: _err,
    };
  }

  // Attribution roll. CC0 needs no attribution, but crediting the people whose
  // scans are in the game is the right thing and the licence audit in
  // `tools/assets.mjs verify` depends on every entry carrying a source.
  function credits() {
    return (_manifest && _manifest.credits) ? _manifest.credits.slice() : [];
  }

  return { init, supported, manifest, load, unload, adopt, state,
           model, modelSync, models, loadModels, env, credits, MAT_LAYERS };
})();

