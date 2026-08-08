# Shipping daytime in Web-Slinger — research

Research only. Nothing in either repo was modified. Read against
`brycejmurrin/spider-man@refs/heads/claude/spiderman-game-f1-graphics-qn3e2e`
(FETCH_HEAD, commit `1b84304`) and the on-disk sibling `/home/user/f1-game`
(Apex 26), which was read only.

## 0. The headline

Daytime is **much closer than `docs/PLAN.md` §6 implies**, and also carries
**four concrete latent defects** that have never executed, because
`buildCity(seed, {night:false})` has never been called anywhere in the repo —
not in `js/game.js`, not in `js/game/spidey-api.js`, not in
`tests/unit/citygen.test.mjs`.

Two facts drive the whole recommendation:

1. **The renderer is already fully day-capable.** The ported `SKY_FS`
   (`js/render/shaders/sky.js`) has explicit `daytime` / `twilight` /
   `nightSky` gates, a golden-hour path, a deep-blue day band, cumulus
   definition, silver linings and a sun disc — all currently switched *off* by
   `frameSky.stars = 1`. `js/render/glx.js` `drawSky()` uploads all 24 sky
   uniforms. `GLX.begin()` already reads a `frame.tune` object of ~38 lighting
   knobs and `GLXPost.present()` reads ~41 more from `opts.tune`, i.e. the
   entire Apex 26 LIGHTING TUNER wire protocol is ported and live. Web-Slinger
   just passes `tune: null` on the frame side and a hand-written 10-key object
   on the present side.
2. **The sibling's proven answer to "changing time of day means a city
   rebuild" is: only rebuild on the day↔dark *binary*, never on the time
   itself.** `js/game.js:2019` in Apex 26:
   `if (builtTrackId !== def.id || builtTrackNight !== sessionDark)`, where
   `sessionDark = night || dusk || dawn || (default && def.night)`. Four times
   of day, two builds. That maps onto Web-Slinger one-for-one.

The smallest honest shippable thing is **a fixed `"day"` preset behind a
`__spidey.setTimeOfDay()` / menu switch that triggers one `loadCity()` rebuild
on the day↔dark flip**. A continuous cycle is a different project and is gated
on cascaded shadow maps, not on the lighting table.

---

## 1. What exists today in Web-Slinger

### 1.1 The `night` flag, every use traced

`buildCity(seed, opts)` — `js/city/citygen.js:45`:

```js
const night = opts.night !== false;   // v1 ships night; day is a supported A/B
```

It is used in exactly **three** places in `citygen.js` (line numbers from
FETCH_HEAD):

| line | use |
|---|---|
| 46 | the definition above |
| 58 | passed into `createBuildings({ out, glassBuf, graph, night, hash, register })` |
| 160 | returned on the result object as `city.night` |

`city.night` is **never read by any consumer** — not `js/game.js`, not
`spidey-api.js`, not `hud.js`. It is write-only.

Everything else in `citygen.js` is **ungated**, and that is the real work list:

- **The ground slab and sidewalk pads** (lines 71–79) are hardcoded
  night-dark: asphalt `[0.052, 0.052, 0.058]`, per-block concrete pad
  `[0.115, 0.115, 0.122]`. Asphalt at 0.052 is defensible in daylight (real
  asphalt albedo runs ~0.04–0.12); concrete at 0.115 is roughly a third of a
  real concrete albedo and will read as wet slate under a noon sun.
- **Street lamps are built identically day and night** (lines 117–152).
  `LAMP_STEP = 34`, `HGT = 8`, masts down every street both axes; 962 lamps on
  seed 42. The lamp *head* carries a deliberately HDR albedo so it trips bloom:
  `[1.4, 0.87, 0.28]` warm / `[1.05, 1.19, 1.4]` cool. Under a day exposure
  that is a permanently blown-out white box on top of every mast.
- **The lamp light records are built identically too.** `SODIUM = [1.0, 0.62,
  0.20]`, `LED = [0.75, 0.85, 1.0]`, scaled by `150` (sodium) / `170` (LED),
  `rad: 30`, `cosIn: 0.80`, `cosOut: 0.26`, `bleed: 0.12`, `volW: 0.5`,
  `glareW: 0.9`. 962 records; `packLights()` uploads the nearest 27 every
  frame regardless of time of day.

### 1.2 `js/city/buildings.js` — 18 `NIGHT` reads, and the unused day path

`const { …, night: NIGHT, … } = ctx;` (line 32). Every use:

| line | what it gates | day value |
|---|---|---|
| 182 | `base` wall colour | `tone.d` or `[0.40,0.41,0.44]` |
| 186 | `cap` (crowns, trim) | `[0.31,0.32,0.35]` |
| 188 | `neonOn = NIGHT && na > 0.3` | always false by day |
| 190 | `bmat` — MAT.BRICK for warm walls, else MAT.CONCRETE | day-only branch |
| 200 | **`sec()` → `neonFacade()` vs `dayGridAt()`** | the day facade |
| 234 | cylinder ring `isLit` | always false by day |
| 244 | spire ring `isLit` | always false by day |
| 249 | spire beacon `[3.0,0.6,0.4]` | omitted by day |
| 253 | `screen` panel colour | `[0.30,0.33,0.40]` |
| 265 | dome cone colour | `cap` |
| 266 | dome beacon | omitted by day |
| 292 | antenna mast beacons | omitted by day |
| 300 | `cross` → `neonFacade` vs `dayGridAt` | the day facade |
| 315 | drum ring | `[0.30,0.34,0.42]` |
| 357 | `body` in `building()` | `tone.d` |
| 358 | plinth colour | `[max(body*1.2, 0.40), …]` |
| 369 | the whole night-signage / aircraft-beacon block | omitted by day |

The ported day path is `dayGridAt(cen, bb, sw, sh, sd, bodyCol)` (line 118): a
plain window grid, panes into `glassBuf` as reflective dark glass
(`[t01*0.40, t01*0.47, t01*0.62]`, `t01 = 0.42 + ry01*0.16` — a vertical
gradient), or into `out` as small recessed `medWin` panes when the wall is a
warm light masonry tone (`med = bodyCol[0] > 0.6 && bodyCol[0] > bodyCol[2] +
0.08`).

**Four latent defects in that never-executed path:**

1. **Two of the three district day palettes are unreachable.**
   `js/city/buildings.js:361`:
   ```js
   const tone = profile.tone
     ? profile.tone
     : { n: [0.14,0.14,0.17], d: profile.dayPal[Math.floor(hash(seed*4.9)*profile.dayPal.length) % profile.dayPal.length] };
   ```
   `DISTRICTS.midtown.tone` and `DISTRICTS.lowrise.tone` are both objects, so
   truthy, so `dayPal` is only ever consulted for `commercial` (the one
   district with `tone: null`). Midtown's 8-entry `dayPal`
   (`steel, bluglass, darkglass, greyblue, white, concrete, charcoal, stone`)
   and lowrise's 7-entry `dayPal` (`brick, terra, cream, tan, ochre, stone,
   sand`) are dead data. By day, every midtown tower would be the single value
   `[0.44, 0.46, 0.50]` under a ±15% value / ±5% hue jitter, and every lowrise
   `[0.66, 0.55, 0.46]`. That is precisely the "one extruded material" read
   that `city-data.js`'s own comment warns about, and precisely what `DC`
   (24 daytime facade materials) was written to prevent.
2. **Cylinder and spire rings render near-black by day.** Lines 234 and 244:
   `const isLit = NIGHT && hash(…) < …;` then
   `const col = isLit ? … : [0.06, 0.06, 0.09];`. With `NIGHT` false, *every*
   ring takes the else branch. `cylinder` emits `max(3, min(14, round(h/6)))`
   of them and `spire` `max(3, round(bh/7))`. Those are the two tallest
   midtown silhouettes: black hoops up a daylit tower.
3. **`dayGridAt` leaks `out._mat`.** `sec()` sets `out._mat = MAT.METAL`
   before dispatching. `neonFacade` ends every `drawFace` with
   `out._mat = 0`. `dayGridAt`'s `med` branch also restores 0, but its
   **non-`med` branch touches only `glassBuf._mat`** — so on a cool-toned
   building `out._mat` is still `MAT.METAL` when `sec()` returns, and the
   caller's crown/cap `Geom.addBox(out, …, cap, b)` picks up the metal texture
   layer instead of layer 0. Asymmetric with the night path; a one-line fix.
4. **Three silhouettes have no day windows at all.** `dayGridAt` is only
   reachable from `sec()` and from the `cross` kind. `cylinder`, `spire` and
   `drum` never call `sec()` — at night they get lit rings instead of a facade,
   and by day they get nothing but the (black, see #2) rings. They are in
   `midtown.kinds`, so they are common in the core.

### 1.3 `frame` — the actual literals (`js/game.js:88–105`)

```js
sunDir:        [0.42, 0.66, 0.36]   // then normalised in the block at :106
sunColor:      [0.12, 0.14, 0.22]   // "faint cool moonlight key"
ambientSky:    [0.034, 0.034, 0.049]
ambientGround: [0.016, 0.015, 0.022]
skyZenith:     [0.01, 0.02, 0.05]
skyHorizon:    [0.04, 0.03, 0.06]
fogColor:      [0.015, 0.017, 0.035]
fogDensity:    0.0032
fogHeight:     0.012
exposure:      0.86
moonK:         1
groundMist:    0.15,  lampFog: 0.4
time: 0, cloud: 0.22, cloudSpeed: 1, wetness: 0
cullDist: 900, shadowCtr, lights: null, tune: null
```

After normalisation `sunDir ≈ [0.4877, 0.7664, 0.4180]` — elevation ≈ **50°**.
That is a moon key posing as a high sun, which is exactly the case `SKY_FS`'s
`nightSky = step(0.5, uStars)` gate was written to defuse:

```glsl
float sunE = clamp(uSunDir.y * 1.4, 0.0, 1.0);   // = 1.0 here
float daytime  = smoothstep(0.35, 0.60, sunE);   // = 1.0 …
float nightSky = step(0.5, uStars);
daytime  *= (1.0 - nightSky);                    // …zeroed only by stars=1
```

**Consequence for any day work:** the moment you set `frameSky.stars = 0` you
must also move `sunDir`, or you get a full daytime sky with a 50°-elevation sun
and no golden hour anywhere.

### 1.4 `frameSky` (`js/game.js:110–116`)

```js
zenith: frame.skyZenith,    horizon: frame.skyHorizon,   // aliased, not copied
sunDir: frame.sunDir,       sunColor: [1.0, 0.95, 0.84],
stars: 1, moon: 0.85, cloud: 0.22, time: 0,
cityGlow: [0.050, 0.038, 0.055], cityGlowReach: 1
```

`zenith`/`horizon`/`sunDir` are **aliases of the same arrays** as `frame`.
Reassigning `frame.skyZenith = [...]` will silently *desync* the dome from the
reflection colour that `LIT_FS` reads (`uSkyZenith`/`uSkyHorizon` feed the env
mirror / SSR fallback). Apex 26 hits this constantly and re-syncs explicitly
(`G.frame.skyZenith = G.frameSky.zenith;` appears seven times in
`atmosphere.js`). Any Web-Slinger time-of-day function must do the same.

`cityGlow` `[0.050, 0.038, 0.055]` is byte-identical to Apex 26's
`street_night`/`modern` value at `js/game/atmosphere.js:34`. Apex clears it to
`null` for any non-night session; Web-Slinger has no code path that clears it.

### 1.5 `presentOpts` (`js/game.js:122–133`)

```js
exposure: 0.82, bloom: 0.62, threshold: 0.75, ssao: 0.35, contact: 0.35,
godray: 0, lampVol: 0.5, mist: 0.26, reflect: 0.55,
flareMul: 0, speedBlur: 0,
tune: { blackLift: 0.015, contrast: 1.06, vibrance: 0.28, saturation: 1.04,
        chromAb: 0.20, grain: 0.03, lensDirt: 0.20, vignette: 0.85,
        vignetteSoft: 0.40, bloomKnee: 0.6 },
grade: { shadow: [0.86, 0.96, 1.14], hi: [1.06, 0.98, 0.93], str: 0.40 }
```

The `grade` is within rounding of Apex 26's `_gradeNight`
(`{ shadow: [0.86,0.94,1.14], hi: [1.07,1.00,0.92], str: 0.30 }`,
`js/game.js:5024`).

### 1.6 Dead fields found while tracing (worth fixing before anything else)

- **`frame.exposure = 0.86` is never read.** `js/render/glx.js` has no
  `exposure` reference at all; `js/render/glx/post.js:647` reads
  `opts.exposure`. So the scene exposure is `presentOpts.exposure = 0.82` and
  the `frame` value is decorative — yet `__spidey.lightState()` reports
  `G.frame.exposure`, i.e. the debug hook reports a number the renderer
  ignores. Any time-of-day table that writes `frame.exposure` (which is what
  the Apex 26 code you would port does) will appear to do nothing.
- **`shadowSnap.sun` is declared and never used** (`js/game.js:44`). Apex 26
  keeps `_shadowSunX/_shadowSunY/_shadowSunZ` for exactly this and invalidates
  the snap cache when the sun moves; the port dropped the check but kept the
  field. Harmless with a static sun; a correctness bug the instant `sunDir`
  changes at runtime (Stage 2+).
- **`city.night`** is returned and never read (§1.1).

### 1.7 The shadow path (`js/game.js:287–323`, `js/render/glx/shadow.js`)

Static sun map: `SHADOW_SIZE = 2048` desktop / `1024` mobile, snap-cached on
the light's own axes with `sBox = 180`, `step = sBox/4 = 45`,
`M4.orthoTo(mLProj, -180, 180, -180, 180, 1.0, 620)` from a virtual light 300 m
back. The gate is `if (lu !== shadowSnap.x || lv !== shadowSnap.z)`, where
`lu`/`lv` are the camera anchor projected onto axes **derived from `sd`**.

That is the load-bearing constraint on a cycle: if `sunDir` changes every
frame, the axes change every frame, `lu`/`lv` change every frame, the gate
fires every frame, and the whole city (`castShadow(ground)` +
`castShadowChunked(props)` over 1.47 M prop verts) re-renders into a 2048² map
at 60 Hz. Today that cost is amortised to roughly once per 45 m of travel.

The dynamic hero map is `1024²`, `orthoTo(-42, 42, -42, 42, 1.0, 320)`,
rebuilt every frame — that one is fine either way.

Also note `PLAN.md` §6 already names "cascaded shadow maps (the current
snap-cached map is sized for a district, not a city)" as outstanding. A 180 m
half-box is about 1.7 block pitches (`CITY.PITCH = 104`), against midtown
towers up to 220 m. It is adequate for a near-vertical moon key and visibly
short for a 40° sun.

---

## 2. What exists in the sibling f1-game, and what is portable

### 2.1 `js/game/atmosphere.js` — `applyRaceSettings()` (557 lines)

One function with a branch per time of day, then weather post-modifiers, then
live-tuner overrides. Structure:

```
applyLightTune(true)                        // resolve the profile first
isNightSession?                             // set/clear frameSky.cityGlow
buildTrackLights() if the session is dark
if (raceTimeOfDay !== "default")
    night | dawn | dusk | else(=day)        // each sets ~14 fields
else
    derive from track.def.palette, then Assets.env() HDRI override
weather post-modifiers: wet / overcast / fog   (multiply, never assign)
groundMist derivation
live LT overrides: sunTemp, sunElev/sunAzim, cloudCover, moonBright,
                   cityGlowMul, ambTemp/ambBalance, skyColorSat, fogColorSat
_ltBase snapshot (for the lightning restore)
```

The **`day` branch, at `_trackAtmoBias == 0`** (`atmosphere.js:171–219`) — this
is the single most portable artefact in the whole sibling repo, and it is the
starting point for Web-Slinger's day preset:

```js
frameSky.zenith     = [0.09, 0.26, 0.95]
frameSky.horizon    = [0.54, 0.68, 0.90]
frameSky.sunDir     = V3.norm([0.46, 0.58, 0.42])   // elevation ≈ 43°
frame.sunColor      = [1.13, 0.95, 0.72]            // warm key, >1 on purpose
frameSky.sunColor   = [1.0,  0.95, 0.84]
frame.ambientGround = [0.24, 0.19, 0.12]            // warm bounce
frame.ambientSky    = [0.26, 0.33, 0.50]            // cool fill
frame.fogColor      = [0.66, 0.74, 0.88]
frame.fogDensity    = 0.0008
frameSky.moon       = 0
frameSky.stars      = 0                             // (set at :57)
_cloudBase          = 0.44
frame.exposure      = 0.99
```

plus, at present time (`js/game.js:6243`): `_grade = _gradeDay =
{ shadow: [0.90,0.98,1.13], hi: [1.13,1.04,0.87], str: 0.34 }`,
`_bloom = 0.60`, `_thresh = 0.82`.

Two comments in that branch are worth carrying over verbatim, because both
encode a failed earlier attempt:

> "A lower, raking afternoon sun — high overhead light gave almost no shadow
> modelling, which is what read 'flat'."

> "Strong WARM sun vs a cooler, slightly darker sky-fill: neutral concrete then
> reads with a warm sunlit side and a cool shadow side (chiaroscuro), which is
> what lifts a grey city out of 'dull/flat'."

That second one is directly load-bearing for Web-Slinger: its city *is* neutral
concrete, and the warm-key/cool-fill split is the difference between "daylight"
and "the night scene with the brightness turned up".

### 2.2 `js/game/lighting.js` — `TUNE_DEFS` + `LT` (753 lines, **178 knobs**)

A flat array of `{ id, label, group, min, max, step, def, u?, rebuild?, fmt?,
help }`. 12 groups: SUN & MOON, AMBIENT & BOUNCE, SHADOWS, FLOODLIGHTS, LAMP
BEHAVIOUR, NIGHT GLOW & BLOOM, ATMOSPHERE, SKY & WEATHER, ROAD & REFLECTIONS,
CAR, IMAGE & COLOUR, FX. `LT` is the live value object; the renderer reads
`frame.tune.<id>` / `opts.tune.<id>`.

**Web-Slinger's renderer already consumes 79 of these ids.** Measured by
grepping the ported sources:

- `js/render/glx.js` reads 34 knob ids off `frame.tune`: `ambContactDark,
  ambientMul, bounceK, carEnvCube, carSparkle, carSunGlint, cloudShadowDim,
  fogClip, fogDensityMul, fogHeight, fogSunCore, fogTint, glowAmp, keyMul,
  lampNearClamp, lampWallSpill, matTexMix, mistDensity, mistHeight, mistShare,
  moonShadow, neonBoost, pcssPen, shadowBias, shadowRange, shadowStr,
  shadowTintAmt, skyRimGlow, wetDark, windowSunFlash` (+ 4 non-knob members).
- `js/render/glx/post.js` reads 45 off `opts.tune`: `acesA…acesE, blackLift,
  blacks, bloomKnee, bloomSpread, carGloss, carReflect, chromAb, contrast,
  flareStreak, gain{R,G,B}, gamma{R,G,B}, godrayAniso, godrayFloor, grain,
  highlights, lensDirt, lift{R,G,B}, midtones, saturation, shadows, sharpen,
  shoulder, ssaoRadius, ssrThick, sunShaftDecay, sunShaftMul, tint, toe,
  vibrance, vignette, vignetteSoft, whitePoint, whites`.

So the *wire* is complete. What is missing is only the registry and the driver
that fills it. **Web-Slinger passes `frame.tune = null`**, so all 34 of the
`glx.js` knobs are currently sitting at their shader-side fallbacks.

Directly relevant to daytime, and currently unreachable:
`windowSunFlash` (sun glinting off window panes — a day-only effect that is
already in the ported lit shader), `skyRimGlow`, `cloudShadowDim`,
`shadowTintAmt` (cool-tint the shadows for a sunny-day look, def 0),
`sunShaftMul` / `godrayAniso` / `godrayFloor` (the god-ray pass, which
Web-Slinger drives with `godray: 0`).

### 2.3 `js/game/light-store.js` (150 lines) — five-layer resolution

```
TUNE_DEFS.def → LightPresets["*"] → LightPresets[key]
              → localStorage["*"] → localStorage[key]
key = `${track.id}|${tod}|${weather}`      // "default" tod resolves to day|night
```

Plus `APPLY_RACE_IDS` — the set of knobs whose effect is *baked into*
`frame`/`frameSky` by `applyRaceSettings()` rather than read per-frame, so
changing one must re-run that function: `sunTemp, sunElev, sunAzim, cloudCover,
moonBright, cityGlowMul, cityGlowTint, ambTemp, ambBalance, skyColorSat,
fogColorSat`. And `rebuild: true` knobs, which invalidate `track._lights`.

That two-tier "some knobs are per-frame, some are baked" distinction is the
one idea from `light-store.js` that Web-Slinger genuinely needs, because it is
the same distinction as "some knobs are per-frame, some need a `loadCity()`".

### 2.4 `js/game/light-presets.js` (2452 lines) — **255 keys**

`window.LightPresets = { "*": {…}, "abudhabi|dawn|dry": {…}, … }`, sparse
partial maps of 3–10 knob ids each, keyed `track|tod|weather`. 40 circuits ×
up to 20 condition combos.

### 2.5 The precedent that matters most: the rebuild gate

`js/game.js:2016–2047`:

```js
const sessionDark = raceTimeOfDay === "night" || raceTimeOfDay === "dusk" ||
  raceTimeOfDay === "dawn" || (raceTimeOfDay === "default" && def.night);
if (builtTrackId !== def.id || builtTrackNight !== sessionDark) {
  … free meshes …
  track = null;                       // drop BEFORE building — peak memory
  track = Tracks.build(def, { night: sessionDark, gfx });
  builtTrackNight = sessionDark;
}
```

and `docs/LIGHTING-REF.md`: *"Switch time of day (no asset reload; rebuilds
meshes only on day↔dark flip)"*, and `apex.js:1369`: *"loadTrack() only
rebuilds geometry when the night/day state actually flips (dawn/dusk/night
share one build; day is the other), so switching among the three dark times is
near-instant."*

Web-Slinger's `loadCity()` already does the free/null/rebuild dance — it is
missing only the `builtCityNight` comparison so it can *skip* the rebuild.

### 2.6 Knob-by-knob: what Apex 26 has that Web-Slinger has, under what name

| Apex 26 | Web-Slinger `frame`/`frameSky`/`presentOpts` | status |
|---|---|---|
| `frame.sunDir` | `frame.sunDir` + `frameSky.sunDir` (aliased) | same name |
| `frame.sunColor` | `frame.sunColor` | same |
| `frameSky.sunColor` | `frameSky.sunColor` | same |
| `frame.ambientSky` / `ambientGround` | same | same |
| `frameSky.zenith` / `.horizon` | `frameSky.zenith`/`.horizon`, **aliased to** `frame.skyZenith`/`skyHorizon` | same, but the alias is a trap |
| `frame.fogColor` / `fogDensity` | same | same |
| `frame.exposure` | `frame.exposure` **(dead)** + `presentOpts.exposure` **(live)** | split; must be unified |
| `frameSky.stars` / `.moon` / `.cloud` | same | same |
| `frameSky.cityGlow` / `cityGlowReach` | same | same, but never cleared |
| `frame.groundMist` | `frame.groundMist` | same |
| `frame.lampFog` | `frame.lampFog` | same |
| `frame.moonK` | `frame.moonK` | same |
| `frame.wetness` / `cloudSpeed` / `cullDist` | same | same |
| `_grade` (`_gradeNight/Dawn/Dusk/Day`) | `presentOpts.grade` (a single literal) | needs a table |
| `_bloom` / `_thresh` | `presentOpts.bloom` / `.threshold` | needs a table |
| `_lampVol` (gated on `_sunLumGR < 0.45`) | `presentOpts.lampVol` (fixed 0.5) | needs a gate |
| `_grLow` / god-ray strength | `presentOpts.godray` (fixed 0) | needs a day value |
| `LT.*` (178 knobs) | `frame.tune` = **null**; `presentOpts.tune` = 10 keys | wire exists, registry does not |
| `buildTrackLights()` + `setFrameLights()` cull | `citygen` lamps + `packLights()` | same shape, no dark-session gate |
| `_nightAmbientBand()` floor/cap + city-glow hue | — | absent |
| `_trackAtmoBias(def)` (per-circuit weather character) | — | **not needed** (one city) |
| `LightStore` 5-layer profile resolution | — | **not needed** (see §2.7) |
| `LightPresets` 255 keys | — | **not needed** |
| `raceWeather` axis | — | **not needed** |

### 2.7 What a minimal port looks like — and what to leave behind

Apex 26's machinery exists to solve **40 tracks × 5 times × 5 weathers = up to
1000 conditions**, authored by hand, persisted per player, with a live slider
panel. Web-Slinger has **one procedural city, one weather, and one axis: time
of day.**

Leave behind, all of it:

- `light-store.js` in its entirety. Five layers exist so a shipped preset and
  a player edit can coexist per (track, tod, weather). With no track axis and
  no weather axis there is nothing to resolve — a plain object literal keyed by
  time of day *is* the whole store.
- `light-presets.js`. Its 255 keys collapse to 2–4 entries.
- `_trackAtmoBias` and the `clr`/`ovc` interpolation threaded through every
  branch of `applyRaceSettings`. Delete the bias and every expression like
  `0.09 - clr*0.04 + ovc*0.28` collapses to its constant.
- The weather post-modifier block (wet / overcast / fog), the lightning
  system, `_ltBase`.
- `TUNE_DEFS` as a *slider panel*. There is no pause-menu tuner in
  Web-Slinger and building one is a separate project.

Keep:

- The **branch values themselves** (§2.1) — those are hundreds of hours of
  A/B tuning and they transfer as literals.
- The **day↔dark rebuild gate** (§2.5).
- The **discipline of re-deriving from a stable base every call** rather than
  mutating in place. `atmosphere.js` carries five separate comments documenting
  bugs caused by compounding (`"the moon ran away while dragging"`,
  `"fog raced to white after a few ticks"`). Web-Slinger's version should be a
  pure function `applyTimeOfDay(tod, frame, frameSky, presentOpts)` that
  *assigns* every field from the table, never multiplies.
- The **`frame.skyZenith ← frameSky.zenith` re-sync** after every write.

**The smallest honest version** is a ~120-line pure module,
`js/game/atmosphere.js`, exporting a `TOD` table of 2 (later 4) entries and one
`applyTimeOfDay()` that assigns them. No registry, no store, no presets file,
no sliders. If a tuner is ever wanted, `TUNE_DEFS` can be added later against
a wire that is already complete.

---

## 3. Web findings

### 3.1 Daylight values that read right

**Illuminance and the compression every game applies.** Direct sunlight is
100,000–120,000 lux; full moon is ~0.3 lux — a ratio of about 3×10⁵
([Real-Time Rendering, *Physical Units for Lights*](https://www.realtimerendering.com/blog/physical-units-for-lights/);
[BeamNG, *Physically Based Lighting*](https://documentation.beamng.com/modding/lighting/pbl/):
*"On a clear day, sunlight can reach around 100 000 lux, while moonlight is
typically around 1 lux."*). Apex 26 compresses that to about **7–10×** on the
hemisphere ambient (`[0.034,0.034,0.049]` → `[0.26,0.33,0.50]`) and **3–9×**
on the key (`[0.12,0.14,0.22]` → `[1.13,0.95,0.72]`), with exposure moving only
`0.86 → 0.99`. That compression is not a cheat to apologise for — it is what
every game without auto-exposure does, and it is the number Web-Slinger should
copy rather than re-derive.

**Exposure in EV.** 0 EV = 0.125 cd/m²; EV 15 ("sunny 16") = 4096 cd/m²
luminance / 82,000 lux illuminance
([Wikipedia, *Exposure value*](https://en.wikipedia.org/wiki/Exposure_value)).
Nathan Reed's [*Artist-Friendly HDR With Exposure Values*](https://www.reedbeta.com/blog/artist-friendly-hdr-with-exposure-values/)
is the practical reference: half-float natively spans −14…+16 EV, *"+16 EV is
about the luminance of a matte white object in noon sunlight"*, so a bright
day scene wants the internal scale shifted (he suggests −10 EV) to leave
headroom for speculars and the sun disc. Web-Slinger renders HDR16F and the
lamp heads are already authored above 1.0; a day preset must not push the
*whole frame* up such that those clip.

**Sun colour temperature through the day.** Sunrise/sunset 2000–3000 K;
morning/afternoon 4000–5000 K; midday 5500–6500 K; sun through cloud/haze
6000–7500 K; overcast sky 6500 K; open blue sky higher still
([fromlux, *What is the Color Temperature of Daylight?*](https://fromlux.com/what-is-the-color-temperature-of-daylight-a-complete-guide/);
[City Electric Supply Kelvin chart, PDF](https://media.cityelectricsupply.com/cesonline/ca/media/Electrical_References/CES_KelvinColourTempChart.pdf)).
The practical rendering consequence is the **warm key against a cool fill**:
a ~5000 K direct sun and a ~10000 K sky dome, which is exactly what Apex 26's
`sunColor [1.13, 0.95, 0.72]` vs `ambientSky [0.26, 0.33, 0.50]` encodes.

**Sky zenith vs horizon.** Both the Preetham and Hosek-Wilkie analytic models
give a deeply saturated zenith falling to a pale, desaturated horizon, and
Hosek-Wilkie *"produces deeper blues than Preetham – perhaps a little too
dark"* by day, with markedly better low-solar-altitude (sunrise/sunset)
behaviour ([Sundog Software, *New Hosek-Wilkie Sky Model in SilverLining
2.8*](https://sundog-soft.com/2013/05/new-hosek-wilkie-sky-model-in-silverlining-2-8/);
[Zhang 2015 thesis, UMBC, PDF](https://www.csee.umbc.edu/~olano/papers/theses/Zhang2015.pdf):
*"the Hosek-Wilkie model has a deeper blue sky, while the sky color is more
pinkish in the Preetham model during the day"*). Apex 26's day
`zenith [0.09, 0.26, 0.95]` → `horizon [0.54, 0.68, 0.90]` is a hand-fitted
version of exactly that curve, and `SKY_FS`'s `uSkyGrad` (def 0.35 —
`pow(up, 0.35)`) is the shape parameter. Note Hosek-Wilkie's known artefact:
*"an increase in brightness at lower solar elevations, [where] nature dictates
a decreasing brightness"*
([Kol, *Analytical sky simulation*, PDF](https://timothykol.com/pub/sky.pdf)) —
a reason to prefer a hand-tuned table over dropping in an analytic model.

**Sun elevation/azimuth by time.** If a real cycle is ever wanted, the
canonical cheap formula is NOAA's:
[*General Solar Position Calculations* (PDF)](https://gml.noaa.gov/grad/solcalc/solareqns.PDF)
— fractional year γ, equation of time, declination, hour angle
`ha = (tst/4) − 180`, then zenith from `ha`/latitude/declination
([NOAA Solar Calculator](https://gml.noaa.gov/grad/solcalc/azel.html)). About
25 lines. For Manhattan, latitude 40.7 °N: peak solar elevation ~73° at the
June solstice, ~26° at December, ~50° at the equinoxes. A game will almost
certainly want to *ignore* the true noon elevation and use ~40–45° anyway, for
the shadow-modelling reason quoted in §2.1.

**Fog and bloom, day vs night.** In Apex 26's own numbers the day branch runs
fog density **4× lower** than night (0.0008 vs 0.0032) and a *sky-matched*,
much lighter fog colour (`[0.66,0.74,0.88]` vs `[0.015,0.017,0.035]`). Bloom
goes the other way from what intuition suggests: day runs **more** bloom at a
**higher** threshold (0.60 / 0.82) than a neon night (0.48–0.55 / 0.97), for
the reason the source comment gives — at night the threshold has to be near 1.0
so *only* lamps and neon halo and the dark between them stays dark, whereas by
day you want chrome, kerbs, glass and the sky to sparkle. Web-Slinger's current
threshold of **0.75 is far below both**, which is a night-specific choice
(`bloomKnee: 0.6`, `blackLift: 0.015`) and will produce a milky wash in
daylight.

### 3.2 Marvel's Spider-Man (PS4, 2018), specifically

**It has no day/night cycle. It has a small set of pre-baked lighting
configurations tied to story beats.** Digital Foundry's tech analysis is
explicit
([*Marvel's Spider-Man — Insomniac's technology swings to new heights*](https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis)):

> "When it comes to lighting, Spider-Man is perhaps Insomniac Games' finest
> work to date, but it has its limits. The game features multiple times of day
> and features great usage of direct and indirect illumination, but the biggest
> limiting factor here stems from those times of day — similar to InFamous
> Second Son, **Spider-Man does not feature a real-time TOD transition.
> Instead, changes in time are tied to story events, with a limited number of
> pre-baked lighting configurations.** I'd imagine this choice was made to
> support improved scene illumination — while it's possible to blend between
> different pre-calculated light passes (as seen in Horizon Zero Dawn), it's
> not always optimal and may not have worked well in a large urban
> environment."
>
> "Still, the benefit of this approach is that lighting conditions are always
> beautiful and the scenes set at dusk in particular are simply spectacular."

That was reported pre-launch too — Game Informer's Andrew Reiner: *"the time
doesn't pass while exploring the open world and the time of day only changes
depending on the story mission"*
([wccftech](https://wccftech.com/spider-man-ps4-day-night-cycle/)).

**The player-facing form is a discrete picker, unlocked post-story.** Insomniac
support: *"The option to change the time of day can be found via GAMEPLAY
settings once you've finished the main story… you cannot change the time of day
when the story is in progress because certain times of day are tied to the
story"*
([support.insomniac.games](https://support.insomniac.games/hc/en-us/articles/46720429859347-I-can-t-change-the-weather-or-time-of-day-in-the-post-game)).
In *Spider-Man 2* the list is reported as **day, night, overcast, dawn, …** —
i.e. named states, not a slider
([r/InsomniacGames](https://www.reddit.com/r/InsomniacGames/comments/17d3ucs/can_i_change_the_time_of_the_day_in_marvels/)).

**What daylight cost them, versus night.** Insomniac did not publish a
day-vs-night frame budget, but the two GDC 2019 talks say what the lighting
system *is*, which implies the cost: Xray Halperin's
[*Marvel's Spider-Man: Procedural Lighting Tools*](https://www.gdcvault.com/play/1026034/-Marvel-s-Spider-Man)
covers *"how procedural systems assisted the lighting team… to place
environment probes and light grids into the open world of Manhattan"*, and
Elan Ruskin's
[*Marvel's Spider-Man: A Technical Postmortem*](https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man)
covers *"adapting rendering, streaming, and lighting to build a New York City
that fits on [a disc]"*. **Procedurally placed probes and light grids are
per-time-of-day data.** That is the actual cost: each additional time of day
multiplies a baked GI dataset over the whole island, which is why a *cycle*
was never on the table and why the count of states stayed small.

DF also notes the interior-mapping trick that Web-Slinger's `dayGridAt` is a
cousin of: *"the inclusion of modelled interiors on buildings… for the most
part we're looking at 'box' instances with simple textures on each visible
plane."* Interior boxes read well by day *and* by night; a flat emissive pane
only reads at night.

**Read-across for Web-Slinger:** the reference game itself concluded that a
large urban environment with baked lighting should ship *fixed states with a
discrete picker*. That is a direct endorsement of Stage 1 below, from the
exact genre.

### 3.3 What breaks when a night-tuned scene goes to day

From the code read plus the sources above, in order of how loudly it breaks:

1. **Emissive windows.** They are the whole point at night and physically
   wrong at noon — a lit office window is invisible against a sunlit facade.
   In Web-Slinger these are *baked into vertex colours* by `neonFacade`, which
   is why `buildCity` takes `night` at all. Cannot be crossfaded without a
   shader change (§3.4).
2. **Neon.** `NC` bases are boosted ~1.55× to sit above the bloom threshold.
   By day the physical fact is that neon is still on but is *overwhelmed*, not
   off — so the right day treatment is to keep the geometry and drop its
   emissive contribution, not to delete it. Currently `neonOn = NIGHT && …`
   deletes it, which is defensible for a fixed preset and wrong for a cycle.
3. **Street lamps.** Three separate problems: the light records (962 spots at
   intensity 150–170), the HDR head albedo (`[1.4, 0.87, 0.28]`), and the
   volumetric cones (`presentOpts.lampVol = 0.5`). Apex 26's answer is a hard
   gate — `setFrameLights()` sets `numLights = 0` on a bright day and skips the
   upload entirely (`docs/LIGHTING-REF.md`) — plus a `floodDay` knob (def 0.0)
   for the deliberate lit-stadium-under-blue-sky look. The head albedo is
   baked, so it needs the rebuild.
4. **`cityGlow`.** A light-pollution dome hugging the horizon. Apex 26 sets
   `frameSky.cityGlow = null` for every non-night session, first thing in
   `applyRaceSettings`. Web-Slinger has no code that ever clears it. Left on,
   it adds a magenta band to the day horizon.
5. **Bloom threshold.** Web-Slinger's 0.75 with `bloomKnee: 0.6` is tuned so
   HDR windows halo against a dark frame. Raise it to ~0.82 by day (§3.1) or
   every bright concrete face blooms.
6. **Black lift.** `presentOpts.tune.blackLift = 0.015` is deliberate — the
   in-repo comment says *"a lit city has no true black, and crushing it reads
   as underexposed day rather than night."* By day it does the reverse: it
   greys the shadows and kills the chiaroscuro that makes daylight read. Take
   it to 0.
7. **The split-tone grade.** `{ shadow: [0.86,0.96,1.14], hi: [1.06,0.98,0.93],
   str: 0.40 }` — cool shadows, warm highlights, near-neutral. Apex 26's day
   grade is *stronger* in the warm direction (`hi: [1.13,1.04,0.87]`) at a
   *lower* strength (0.34).
8. **`groundMist` / `lampFog` / `mist`.** `groundMist: 0.15`, `lampFog: 0.4`,
   `presentOpts.mist: 0.26`. Apex 26 gives a clear day `groundMist = 0` and
   `lampFog` has nothing to tint. Leave them on and a sunny city sits in haze.
9. **Shadow bias and cascade sizing.** A 50° moon key and a 43° sun produce
   similar shadow lengths, so bias is not the immediate problem — but
   *contrast* is: at night the shadow term is buried under ambient and lamps,
   by day it is the dominant cue, so acne and peter-panning that were invisible
   become obvious. The standard tools are slope-scale depth bias plus a
   normal-offset bias measured in shadow-map texels
   ([Microsoft, *Common Techniques to Improve Shadow Depth Maps*](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/common-techniques-to-improve-shadow-depth-maps);
   [DigitalRune, *Shadow Acne*](https://digitalrune.github.io/DigitalRune-Documentation/html/3f4d959e-9c98-4a97-8d85-7a73c26145d7.htm);
   [MJP, *A Sampling of Shadow Techniques*](https://mynameismjp.wordpress.com/2013/09/10/shadow-maps/)).
   Apex 26 exposes both as `shadowBias` (def 0.001) and `pcssPen` (def 80) —
   Web-Slinger has the uniforms and no way to set them, because `frame.tune`
   is null. The **cascade** problem is separate and real: `sBox = 180` against
   220 m towers (§1.7).

**The standard set that must be crossfaded rather than switched.** The
distinction is whether the value is *consumed per-frame* or *baked into
geometry*:

| crossfade (per-frame, free) | switch + rebuild (baked into vertex colour) |
|---|---|
| `sunDir`, `sunColor`, `ambientSky/Ground` | window pane emissive colour |
| `skyZenith/Horizon`, `frameSky.zenith/horizon` | neon band / crown signage colour |
| `fogColor`, `fogDensity`, `groundMist` | lamp head HDR albedo |
| `exposure`, `bloom`, `threshold`, `grade`, `blackLift` | aircraft beacons, spire/dome/antenna beacons |
| `frameSky.stars`, `.moon`, `.cloud`, `.cityGlow` | cylinder/spire ring colours |
| `lampVol`, `godray`, `mist`, `lampFog` | ground slab + sidewalk pad albedo |
| the lamp light records (cull them in `packLights`) | wall base tone (`tone.n` vs `tone.d`) |

Anything in the left column can and should be interpolated. Anything in the
right column forces the `loadCity()` rebuild — and *that* is the line the
staging below is drawn along.

### 3.4 Cycle vs presets, for a procedural world with baked emissives

**The precedent for presets-with-interpolation is GTA's `timecyc.dat`.** It is
a table of keyframes per weather type, and *"each value of one entry gets
interpolated with the previous and the next setting of the current ingame
weather."* GTA III and Vice City store 24 keyframes (one per game hour); **San
Andreas stores only 8** — 00am, 05am, 06am, 07am, 00pm, 07pm, 08pm, 10pm — and
interpolates between them
([GTAMods Wiki, *Time cycle*](https://gtamods.com/wiki/Time_cycle)). The stored
fields are exactly the ones under discussion here: static/dynamic ambient
colour, direct light colour, sky top colour, sky bottom colour, sun core and
corona colour and size, sprite brightness, shadow intensity, far-clip and
fog-start offsets, cloud colours, colour-correction pairs. GTA IV's set is
recognisably the same list: *"Amb0… Amb1… Dir controls the colour of the
sun-/moonlight… Sky top… Sky bot controls the colour of the fog."*

Eight keyframes covering a full day, interpolated, is a *tiny* amount of data —
and it is exactly the shape of `TOD` proposed below. **The lighting side of a
cycle is cheap. It is not the reason a cycle is hard.**

**The reason a cycle is hard here is the baked emissive.** Web-Slinger bakes
the window look into vertex colours at generation time, and PLAN.md measures
the whole build at **~2 s in bare Node** for 1.47 M prop verts + 772 k glass
verts + 85,484 instanced nodes. In-browser plus `createChunkedMesh` upload it
will be more. A 2 s hitch mid-swing is not shippable, and a cycle by definition
crosses the boundary while the player is flying.

The industry answers, in increasing cost:

1. **Don't have a cycle.** Insomniac (§3.2), Sucker Punch (Second Son, per
   DF), and GTA's own interiors. Discrete named states, changed at a moment the
   game controls.
2. **Blend two baked datasets.** Horizon Zero Dawn is DF's cited example;
   Unity lightmap-blending systems do the same
   ([showcase](https://www.youtube.com/watch?v=8eSi5XFO_9Y)). Cost: 2× the
   baked data resident. For Web-Slinger that means holding the day city *and*
   the night city in GPU memory simultaneously — ~4.5 M verts — which is the
   wrong trade for a browser game whose whole architecture is built around a
   6 MB / 3.7 s first load (PLAN.md §6).
3. **Stop baking; move the decision to the shader.** This is the only real
   answer for a continuous cycle, and Web-Slinger is unusually well placed for
   it because *the split already exists*: `neonFacade` writes lit panes into
   `out` (the emissive props mesh) and unlit panes into `glassBuf` (reflective
   dark glass). Build **both** sets unconditionally, keep the lit pane's colour
   in its vertex colour, tag those verts with a new `MAT.WINDOW` id in
   `js/city/geom.js`, and add one uniform — call it `uEmissiveMix` — that
   scales the emissive contribution of that material layer only. Then day = 0,
   night = 1, dusk = a ramp, no rebuild ever, and the same uniform handles neon
   bands and beacons. Cost: the day build stops being cheaper than the night
   build, plus a `LIT_FS` change, plus a MAT-id addition that the asset pack
   must tolerate.

Note that Reed's HDR-texture advice applies to (3): high-contrast emissive
content is where precision problems show, and *"bloom will help soften the
edges of textures like these"* — Web-Slinger's panes are untextured flat
vertex colour, so this is a non-issue, which is a point in favour of the
approach.

---

## 4. Staged proposal

Every stage names files, and flags whether it needs a city rebuild.

### Stage 0 — instrument and fix the dead wiring (no visual change)

Rationale: three of the fields anyone will reach for first are dead, and the
day path has never executed anywhere.

| file | change | size |
|---|---|---|
| `js/game.js` | make **one** exposure authoritative. Either delete `frame.exposure` or have `render()` do `presentOpts.exposure = frame.exposure` before `gfx.present()`. Recommend the latter — every ported Apex 26 branch writes `frame.exposure`. | ±1 line, 440 → 441 |
| `js/game/spidey-api.js` | extend `lightState()` to return `sunDir`, `sunColor`, `ambientSky/Ground`, `skyZenith/Horizon`, `fogColor/Density`, `stars`, `moon`, `cityGlow`, `presentOpts.{exposure,bloom,threshold}` and `city.night`. Without this there is no way to assert a preset landed. | +~18, 127 → ~145 (ceiling 180) |
| `tests/unit/citygen.test.mjs` | add: `buildCity(7, {night:false})` builds; is deterministic across two calls; differs from `buildCity(7, {night:true})`; produces > 0 `glassBuf` verts. **This is the first execution of the day path in the repo's history.** | new test |

No rebuild. No cache bump needed if only tests change; a bump *is* needed for
the two js edits (`index.html` import map + `modulepreload` + `version.json`
`build: 2 → 3`).

### Stage 1 — a fixed `"day"` preset. The smallest shippable daytime.

**New file `js/game/atmosphere.js`** — pure data + one pure function. It must
import nothing from `js/render/` and touch no `document`/`localStorage`/
`navigator`, so it can be added to `MANIFEST.HEADLESS_SAFE` and unit-tested in
bare Node under `test:tooling-fast`. That is the single most important design
choice in this whole proposal.

```js
export const TIMES = ["night", "day"];
export const TOD = {
  night: { /* the current js/game.js literals, moved verbatim */ },
  day:   { /* Apex 26 atmosphere.js:171-219 at bias 0, §2.1 */ },
};
export const isDark = (tod) => tod !== "day";
export function applyTimeOfDay(tod, frame, frameSky, presentOpts) { … }
```

`applyTimeOfDay` **assigns** every field from the table (never multiplies), and
must, in order:

1. write `frame.sunDir` normalised, then alias `frameSky.sunDir = frame.sunDir`;
2. write `frameSky.zenith`/`horizon`, then re-sync
   `frame.skyZenith = frameSky.zenith; frame.skyHorizon = frameSky.horizon;`
   (§1.4 — the alias trap);
3. set `frameSky.cityGlow = null` for `day` (§3.3 #4);
4. set `frameSky.stars = 0`, `frameSky.moon = 0`, `frame.moonK = 0` for `day`;
5. write `presentOpts.exposure/bloom/threshold/godray/lampVol/mist/grade` and
   `presentOpts.tune.blackLift`.

Day values to start from — Apex 26's, with the Web-Slinger-specific deltas
called out:

| field | night (today) | day (proposed) | source |
|---|---|---|---|
| `sunDir` | `[0.42,0.66,0.36]` → 50° | `[0.46,0.58,0.42]` → **43°** | Apex day branch; the raking-sun comment |
| `frame.sunColor` | `[0.12,0.14,0.22]` | `[1.13,0.95,0.72]` | Apex; warm key >1 |
| `frameSky.sunColor` | `[1.0,0.95,0.84]` | `[1.0,0.95,0.84]` | unchanged |
| `ambientSky` | `[0.034,0.034,0.049]` | `[0.26,0.33,0.50]` | Apex; cool fill |
| `ambientGround` | `[0.016,0.015,0.022]` | `[0.24,0.19,0.12]` | Apex; warm bounce |
| `skyZenith` | `[0.01,0.02,0.05]` | `[0.09,0.26,0.95]` | Apex; Hosek-like deep blue |
| `skyHorizon` | `[0.04,0.03,0.06]` | `[0.54,0.68,0.90]` | Apex |
| `fogColor` | `[0.015,0.017,0.035]` | `[0.66,0.74,0.88]` | Apex; sky-matched |
| `fogDensity` | `0.0032` | `0.0008` | Apex; 4× thinner |
| `exposure` | `0.82` (present) | `0.99` | Apex |
| `stars` / `moon` / `moonK` | `1` / `0.85` / `1` | `0` / `0` / `0` | — |
| `cloud` | `0.22` | `0.44` | Apex `_cloudBase` |
| `cityGlow` | `[0.050,0.038,0.055]` | `null` | Apex clears it for non-night |
| `groundMist` | `0.15` | `0.0` | Apex clear-day |
| `bloom` / `threshold` | `0.62` / `0.75` | `0.60` / `0.82` | Apex `_bloom`/`_thresh` |
| `grade` | `{[0.86,0.96,1.14],[1.06,0.98,0.93],0.40}` | `{[0.90,0.98,1.13],[1.13,1.04,0.87],0.34}` | Apex `_gradeDay` |
| `blackLift` | `0.015` | `0.0` | §3.3 #6 |
| `godray` | `0` | `~0.55` | Apex low-sun shafts; the pass is gated on `sun \|\| lampVol` |
| `lampVol` | `0.5` | `0` | no lamp cones by day |
| `mist` | `0.26` | `0.05` | — |

**`js/game.js`** (currently **440 / ceiling 460 — only 20 lines of headroom**):

- `import { TOD, applyTimeOfDay, isDark } from "./game/atmosphere.js";` (+1)
- `let tod = store.get("tod", "night");` (+1)
- **Delete** the `frame` / `frameSky` / `presentOpts` literals at lines 88–133
  (~46 lines) and replace with skeleton objects plus one
  `applyTimeOfDay(tod, frame, frameSky, presentOpts)` call (~12 lines).
  **Net: game.js goes DOWN, roughly 440 → ~410.**
- `let builtNight = null;` and in `loadCity(seed, night)` add
  `if (builtNight === night && citySeed === seed && city) return;` plus
  `builtNight = night;` (+3) — this is the Apex 26 gate (§2.5).
- boot becomes `loadCity(citySeed, isDark(tod));`
- `setTimeOfDay(t)`: assign `tod`, `store.set("tod", t)`,
  `applyTimeOfDay(...)`, `if (isDark(t) !== builtNight) loadCity(citySeed, isDark(t))`,
  `shadowSnap.x = Infinity` (+6, or put it in the API module).
- `packLights()`: `if (!isDark(tod)) { frame.lights = null; return; }` before
  the lamp loop, keeping only the hero light if wanted (it should be dropped by
  day too — a character in sunlight does not need a fill key). (+2)

The size ratchet: 410 lines against a 460 ceiling is a slack of 50, comfortably
under the "ceiling drifted more than 120 above its file" rule, so no ceiling
edit is required. **`js/game.js` does not exceed its ceiling — it drops.**

**`js/city/citygen.js`** (168 / ceiling 220 — 52 lines of headroom).
**Rebuild required for all of these:**

- gate the ground slab and pad colours on `night` — day values around
  `[0.10, 0.10, 0.11]` asphalt and `[0.30, 0.30, 0.31]` concrete (§1.1);
- gate the lamp head albedo on `night`: the HDR `[1.4,0.87,0.28]` /
  `[1.05,1.19,1.4]` become a dull `[0.30,0.30,0.33]` grey by day (§3.3 #3);
- leave `lamps.push` alone — building the records unconditionally keeps the
  generator's output identical and deterministic, and the day/night decision
  belongs in `packLights()`, where dusk will later need a *ramp* rather than a
  gate.

Estimated +12 lines → ~180 / 220. Fine.

**`js/city/city-data.js`** (not ratcheted) — fix the unreachable `dayPal`
(§1.2 #1). Cleanest form: change `midtown.tone` and `lowrise.tone` from
`{ n: […], d: […] }` to `{ n: […] }` only, and in `js/city/buildings.js:361`
resolve `d` as `profile.tone && profile.tone.d ? profile.tone.d :
profile.dayPal[pick]`. That makes all three districts draw from `DC`, which is
what `DC`'s 24 entries exist for. **Rebuild required** (it changes vertex
colours).

**`js/city/buildings.js`** (393 / ceiling 420 — **only 27 lines of headroom**).
Three surgical fixes, ~6 lines total → ~399:

- line 361: the `dayPal` resolution above (1 line);
- lines 234 and 244: replace the `[0.06, 0.06, 0.09]` unlit ring colour with
  `NIGHT ? [0.06,0.06,0.09] : cap` (2 lines) — §1.2 #2;
- `dayGridAt`'s non-`med` branch: restore `out._mat` symmetrically with
  `neonFacade` (1–2 lines) — §1.2 #3.

**Flag:** this file has almost no headroom. Anything larger than the above —
for example giving `cylinder`/`spire`/`drum` a real day facade (§1.2 #4) — must
be an extraction (`js/city/facades.js` holding `neonFacade` + `dayGridAt`,
~110 lines out, which would also let `buildings.js`'s ceiling be *lowered*, as
the ratchet's own rule requires).

**`js/game/spidey-api.js`** (127 → ~145 after Stage 0): add
`setTimeOfDay(t)` / `timeOfDay()`, and fix `seed(n)` at line 87 which hardcodes
`G.loadCity(n, true)` → `G.loadCity(n, isDark(G.tod))`. (+~10 → ~155 / 180.)

**`tools/manifest.cjs`**: add `"js/game/atmosphere.js"` to `MODULES` and to
`HEADLESS_SAFE`. **`index.html`**: add its import-map entry and its
`modulepreload`, and bump every `?v=` to the next N. **`version.json`**: set
`build` to the same N. (All four are asserted by
`tests/unit/load-order.test.mjs`, including that the import map covers exactly
`MANIFEST.MODULES`, that every module is modulepreloaded at the *mapped* URL,
and that `version.json.build` equals the `?v=`.)

**Tests to add:** a new `tests/unit/atmosphere.test.mjs` (headless) asserting
that every entry in `TOD` covers the same key set, that `applyTimeOfDay("day")`
leaves `frame.skyZenith === frameSky.zenith` (the alias re-sync), that
`cityGlow` is null by day and non-null at night, and that
`sunDir` comes back normalised with `y > 0.5`. Then
`tests/specs/city-visual.spec.js` gets a day vantage asserting `numLights === 0`
and a non-blank frame.

**Rebuild cost, stated plainly.** A day↔night flip is a full `loadCity()`:
free three meshes, regenerate ~1.47 M prop verts + 772 k glass verts + 85,484
instanced nodes, re-upload as chunked meshes. PLAN.md measures the generation
alone at ~2 s in bare Node. Do it from the pause menu or the start screen with
a visible "rebuilding" state, never mid-swing. This is precisely what Apex 26
does (`setTimeOfDay` → `loadTrack` → rebuild) and what Spider-Man PS4 does
(the option lives in a settings menu, and the game's own time changes happen at
mission boundaries).

**What Stage 1 delivers:** a genuine daytime Manhattan, selectable, with the
sibling's tuned values, at a cost of roughly +40 net lines across five files
and one new 130-line headless module — and `js/game.js` gets *smaller*.

### Stage 2 — `dawn` and `dusk`, sharing the dark build

Add two entries to `TOD` (Apex 26's dawn and dusk branches at bias 0, which are
already in §2.1's neighbourhood: dawn `zenith [0.07,0.12,0.27]`, `horizon
[0.88,0.50,0.40]`, `sunDir norm([-0.62,0.08,0.28])` ≈ 7°, `exposure 1.08`,
`moon 0.30`, `groundMist 0.40`; dusk `zenith [0.08,0.10,0.28]`, `horizon
[0.72,0.34,0.08]`, `sunDir norm([0.50,0.10,0.22])` ≈ 10°, `exposure 1.03`,
`groundMist 0.22`).

`isDark` already covers them — `tod !== "day"` — so **dawn, dusk and night
share one city build and switching among them is instantaneous.** That is the
whole payoff of the binary gate and it costs nothing extra.

New work, all in `js/game.js`'s `packLights()` and `js/game/atmosphere.js`:
a **twilight ramp** on the lamp records, driven by `sunDir[1]`. Apex 26's
version is `twilightFloor` (def 0.30) / `twilightRamp` (def 6) /
`twilightWarm` (def 1.0) — a floor on lamp level while the sun is still up, a
steepness against sun elevation, and an amber "just switched on" cast. A
5-line scalar in `packLights` is enough; the knob registry is not needed.

Also at this stage: fix `shadowSnap.sun` (§1.6) so the snap cache invalidates
when `sunDir` changes, otherwise switching dusk→night keeps dusk's shadows.

**No rebuild** for any transition inside the dark set. Day↔dark still rebuilds.

### Stage 3 — a continuous cycle

Additionally required, in dependency order:

1. **Interpolation.** `lerpTOD(a, b, t)` over the ~18 vec3/scalar fields, and a
   keyframe list rather than a switch. GTA San Andreas ships 8 keyframes for a
   whole day and interpolates (§3.4) — 4–8 is plenty. ~30 lines in
   `js/game/atmosphere.js`. Optionally the NOAA solar-position formula
   (§3.1, ~25 lines) to derive `sunDir` from a clock instead of keyframing it.
   **This part is easy and is not the blocker.**
2. **Unbake the emissives.** The `MAT.WINDOW` + `uEmissiveMix` design in
   §3.4(3). Touches `js/city/geom.js` (a new MAT id), `js/city/buildings.js`
   (tag lit panes, and always emit both pane sets — likely forcing the
   `js/city/facades.js` extraction, since `buildings.js` has 27 lines of
   headroom), `js/render/shaders/lit.js` (gate the emissive ramp on the layer),
   `js/render/glx.js` (upload the uniform). Determinism is preserved — the
   generator's output becomes *more* deterministic, not less, since it stops
   branching on `night`. The asset pack (`assets/pack/manifest.json`, the
   `TEXTURE_2D_ARRAY` whose layer index *is* the MAT id) must gain a layer or
   the new id must be explicitly untextured.
3. **Cascaded shadow maps.** Non-negotiable. With a moving sun the existing
   snap cache (§1.7) degenerates to a full 2048² city re-render every frame,
   and a 180 m half-box is already short for 220 m towers. `PLAN.md` §6 already
   lists CSM as outstanding — **a cycle should be scheduled after CSM, not
   before.**
4. **`lampFog` / volumetric ramp** so lamp cones fade in over the twilight
   window rather than popping.

**Recommendation: do not build Stage 3 until CSM lands.** Stages 1 and 2 give
four times of day, three of them free to switch between, which is more than the
reference game offers, at a small fraction of the cost.

---

## 5. House-rule compliance

| rule | status |
|---|---|
| No build step | respected — one new hand-written ES module, no tooling |
| Native ES modules | `js/game/atmosphere.js` is a plain `export`-ing module reachable from `js/game.js` |
| `js/city/*` stays headless | Stage 1's citygen/buildings/city-data edits add only literals and a ternary — no `document`, no `localStorage`, no `navigator`, no `from "../render/`. `tests/unit/load-order.test.mjs`'s `banned` regex stays satisfied. `js/game/atmosphere.js` should be added to `HEADLESS_SAFE` for the same reason, and holds nothing that would violate it |
| Determinism per seed | preserved. `night` is already a `buildCity` input; every Stage 1 change is a colour literal chosen by the same `hash(seed…)` calls. No `Math.random`. The new unit test asserts `buildCity(s,{night:false})` is stable across calls |
| `?v=` bumped with `version.json` | required at every stage: bump **all** `?v=` in `index.html` (2 stylesheet links, the entry `<script type="module">`, every import-map value, every `modulepreload` href) to N+1 and set `version.json` `{"build": N+1}`. Currently `build: 2`. `tests/unit/load-order.test.mjs` asserts a single shared N across all of them |
| New-file checklist | `js/game/atmosphere.js` needs: the file, an import from `js/game.js`, a `MODULES` entry in `tools/manifest.cjs`, an import-map entry **and** a `modulepreload` link in `index.html`, a line in `CLAUDE.md`'s layout, and the `?v=`/`version.json` bump |
| **`js/game.js` ≤ 460** (at **440**) | **not exceeded — it falls to ~410.** Stage 1 removes ~46 lines of literals and adds ~12. Slack 50 < 120, so no ceiling edit is needed |
| **`js/city/citygen.js` ≤ 220** (at **168**) | not exceeded — ~180 after Stage 1 |
| **`js/city/buildings.js` ≤ 420** (at **393**) | not exceeded by Stage 1 (~399), but **27 lines of headroom is the tightest constraint in this proposal.** Any day-facade work beyond the three one-line fixes needs `neonFacade` + `dayGridAt` extracted to `js/city/facades.js`, and the ceiling **lowered** afterwards, as the ratchet's second test requires |
| `js/game/spidey-api.js` ≤ 180 (at **127**) | ~155 after Stages 0+1 |
| Effects never in the physics step | respected — everything here is frame assembly and generation |

---

## 6. Open questions and risks

1. **Nobody has ever seen the day city.** The day path has never run. Before
   committing to any of the numbers above, run
   `buildCity(42, {night:false})` headlessly and take a `__spidey.park()`
   screenshot. Expect it to look wrong on the first try in the four specific
   ways enumerated in §1.2 — that list is a prediction, not an observation.
2. **`dayGridAt` may be under-detailed.** `neonFacade` emits frame rails,
   mullions, structured lit/unlit occupancy and edge neon; `dayGridAt` emits
   panes only. By day, geometry *is* the detail (there is no emissive to carry
   it), so a daylit facade may need the rails and mullions back — which is more
   lines in the file with the least headroom.
3. **Is the day build cheaper or more expensive?** Unknown. Day skips the neon
   crowns, beacons and per-pane lit colouring, but `dayGridAt` still emits a
   pane per cell. Measure `stats.propVerts` / `glassVerts` for both before
   assuming the rebuild time is the same ~2 s.
4. **The hero.** `js/hero/hero3d.js` and `js/car/`-equivalent colours were
   tuned against a near-black night. A red-and-blue suit under `sunColor
   [1.13, 0.95, 0.72]` at exposure 0.99 may clip. Not researched here.
5. **The dedicated hero fill light** (`packLights`, `[26,27,34]`, radius 7)
   exists because *"a character above lamp height has nothing lighting him at
   night."* By day it should be off, and the comment should say why.
6. **`css/` and the menu.** A time-of-day picker needs UI. Not researched.
7. **Cache-bump timing.** Bump `?v=` and `version.json` as the **last** edit
   before commit, never mid-test-run — the shell version guard in `index.html`
   force-reloads every open page when `version.json` moves ahead of the loaded
   build.

---

## 7. Sources

**Insomniac / Marvel's Spider-Man**
- Digital Foundry, *Marvel's Spider-Man — Insomniac's technology swings to new heights* — https://www.digitalfoundry.net/articles/digitalfoundry-2018-marvels-spider-man-ps4-tech-analysis
- GDC 2019, Elan Ruskin, *Marvel's Spider-Man: A Technical Postmortem* — https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man · video https://www.youtube.com/watch?v=KDhKyIZd3O8
- GDC 2019, Xray Halperin, *Marvel's Spider-Man: Procedural Lighting Tools* — https://www.gdcvault.com/play/1026034/-Marvel-s-Spider-Man · video https://www.youtube.com/watch?v=HnguuY9IRro · writeup https://www.gamedeveloper.com/programming/video-dive-into-i-marvel-s-spider-man-i-procedural-lighting-tools
- GDC 2019, *Procedurally Crafting Manhattan for Marvel's Spider-Man* — https://www.gdcvault.com/play/1025765/Procedurally-Crafting-Manhattan-for-Marvel
- Insomniac support, *I can't change the weather or time of day in the post game* — https://support.insomniac.games/hc/en-us/articles/46720429859347-I-can-t-change-the-weather-or-time-of-day-in-the-post-game
- wccftech (reporting Game Informer's Andrew Reiner), *Spider-Man PS4 May Not Have Day-Night Cycle* — https://wccftech.com/spider-man-ps4-day-night-cycle/
- r/InsomniacGames, post-game time-of-day option list — https://www.reddit.com/r/InsomniacGames/comments/17d3ucs/can_i_change_the_time_of_the_day_in_marvels/

**Sky models and daylight values**
- Sundog Software, *New Hosek-Wilkie Sky Model in SilverLining 2.8* — https://sundog-soft.com/2013/05/new-hosek-wilkie-sky-model-in-silverlining-2-8/
- Zhang (2015), UMBC thesis, Preetham vs Hosek-Wilkie comparison (PDF) — https://www.csee.umbc.edu/~olano/papers/theses/Zhang2015.pdf
- Timothy Kol, *Analytical sky simulation* (PDF) — https://timothykol.com/pub/sky.pdf
- Andrew Willmott, *sun-sky* reference implementations — https://github.com/andrewwillmott/sun-sky
- NOAA, *General Solar Position Calculations* (PDF) — https://gml.noaa.gov/grad/solcalc/solareqns.PDF · calculator https://gml.noaa.gov/grad/solcalc/azel.html

**Exposure, units, HDR**
- Real-Time Rendering blog, *Physical Units for Lights* — https://www.realtimerendering.com/blog/physical-units-for-lights/
- Nathan Reed, *Artist-Friendly HDR With Exposure Values* — https://www.reedbeta.com/blog/artist-friendly-hdr-with-exposure-values/
- Wikipedia, *Exposure value* — https://en.wikipedia.org/wiki/Exposure_value
- BeamNG, *Physically Based Lighting — Introduction* — https://documentation.beamng.com/modding/lighting/pbl/
- fromlux, *What is the Color Temperature of Daylight?* — https://fromlux.com/what-is-the-color-temperature-of-daylight-a-complete-guide/
- City Electric Supply, Kelvin colour temperature chart (PDF) — https://media.cityelectricsupply.com/cesonline/ca/media/Electrical_References/CES_KelvinColourTempChart.pdf

**Time-of-day architecture, shadows**
- GTAMods Wiki, *Time cycle* (`timecyc.dat` keyframes and interpolation) — https://gtamods.com/wiki/Time_cycle
- Adrian Courrèges, *GTA V — Graphics Study* — https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/
- Microsoft, *Common Techniques to Improve Shadow Depth Maps* — https://learn.microsoft.com/en-us/windows/win32/dxtecharts/common-techniques-to-improve-shadow-depth-maps
- DigitalRune, *Shadow Acne* (depth + normal-offset bias in texels) — https://digitalrune.github.io/DigitalRune-Documentation/html/3f4d959e-9c98-4a97-8d85-7a73c26145d7.htm
- MJP, *A Sampling of Shadow Techniques* — https://mynameismjp.wordpress.com/2013/09/10/shadow-maps/
- Unity day/night with baked lighting (lightmap + probe blending) — https://www.youtube.com/watch?v=8eSi5XFO_9Y

**In-repo (read, not modified)**
- Web-Slinger @ `1b84304`: `js/city/citygen.js`, `js/city/buildings.js`, `js/city/city-data.js`, `js/game.js`, `js/game/spidey-api.js`, `js/render/glx.js`, `js/render/glx/post.js`, `js/render/glx/shadow.js`, `js/render/shaders/sky.js`, `tools/manifest.cjs`, `tests/unit/{load-order,module-size,citygen}.test.mjs`, `index.html`, `version.json`, `docs/PLAN.md`, `CLAUDE.md`
- Apex 26 (`/home/user/f1-game`): `js/game/atmosphere.js`, `js/game/lighting.js`, `js/game/light-store.js`, `js/game/light-presets.js`, `js/game.js` (`loadTrack` :2005–2047, `_nightAmbientBand` :2092, grade tables :5024, present assembly :6218–6357), `js/game/apex.js` (`setTimeOfDay` :1372), `docs/LIGHTING-REF.md`, `docs/LIGHTING-KNOBS.md`, `docs/LIGHTING-PRESETS.md`
