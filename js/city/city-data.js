/* Web-Slinger — static city-generator data tables. Pure constants, no closure
   state. Ported from Apex 26's TrackSceneryData (js/track/scenery-data.js) with
   the per-circuit keying replaced by per-DISTRICT profiles: the palettes and
   massing-kind mixes are the tuned values that already read as a credible
   night/day city there; the district profiles below are new. */

// Neon accent palette — HDR-adjacent bases; building() boosts them ~1.55x so
// lit glass trips the bloom threshold.
export const NC = {
  mag: [0.95, 0.15, 0.55], cyan: [0.18, 0.85, 0.98], gold: [1.00, 0.78, 0.12],
  violet: [0.62, 0.22, 1.0], blue: [0.22, 0.48, 1.0], orange: [1.00, 0.42, 0.08],
  red: [1.0, 0.16, 0.22], teal: [0.0, 0.92, 0.78], white: [0.86, 0.92, 1.0],
  green: [0.25, 1.0, 0.45], pink: [1.0, 0.30, 0.62], lime: [0.66, 1.0, 0.22],
  ice: [0.55, 0.82, 1.0], yellow: [1.0, 0.92, 0.25], purple: [0.82, 0.30, 0.96],
  rose: [1.0, 0.45, 0.55], amber: [1.00, 0.55, 0.12],
};

// Daytime facade materials — real building colours so daylight isn't a wall of
// grey concrete. Warm stone/terracotta read as masonry; cool tones as glass.
export const DC = {
  cream:   [0.86, 0.82, 0.72], sand:    [0.80, 0.71, 0.54], tan:     [0.74, 0.63, 0.47],
  stone:   [0.78, 0.76, 0.70], terra:   [0.74, 0.46, 0.34], brick:   [0.62, 0.40, 0.34],
  ochre:   [0.82, 0.63, 0.36], white:   [0.88, 0.88, 0.85], greyblue:[0.56, 0.62, 0.70],
  slate:   [0.48, 0.53, 0.60], paleblue:[0.66, 0.74, 0.83], teal:    [0.54, 0.70, 0.68],
  peach:   [0.92, 0.74, 0.61], pink:    [0.90, 0.69, 0.74], mint:    [0.72, 0.86, 0.77],
  aqua:    [0.62, 0.82, 0.84], lemon:   [0.92, 0.87, 0.62], coral:   [0.88, 0.55, 0.46],
  concrete:[0.52, 0.53, 0.55], charcoal:[0.34, 0.36, 0.41], graphite:[0.27, 0.29, 0.34],
  steel:   [0.45, 0.50, 0.57], darkglass:[0.26, 0.34, 0.45], bluglass:[0.34, 0.44, 0.58],
  bronze:  [0.55, 0.45, 0.33], gold:    [0.72, 0.58, 0.30], copper:  [0.62, 0.42, 0.30],
};

// The full massing-silhouette library implemented by buildings.js.
export const BLD = ["setback", "tiered", "podium", "slab", "twin", "jenga",
  "cylinder", "spire", "dome", "chevron", "notch", "fin", "antenna", "cross",
  "arch", "ziggurat", "drum", "hall"];

// Per-building lit-window tints: warm office / cool glass / soft accents.
// Kept near 1.0 — building() applies the HDR boost.
export const WINTINTS = [
  [0.98, 0.86, 0.56], [0.92, 0.82, 0.60],
  [0.62, 0.76, 1.00], [0.72, 0.84, 0.98],
  [1.00, 0.70, 0.85], [0.70, 0.95, 0.90],
];

/* District profiles. Each block of the city grid belongs to one district;
   the profile decides heights, massing mix, neon bias and palettes.
     h:        [min, range] building height in metres (uniform hash pick + a
               10% landmark spike to 1.5x, capped by hMax)
     hMax:     hard ceiling for landmark spikes
     bias:     fraction of buildings that get the neon treatment at night
     kinds:    massing silhouettes in rotation
     neonKinds: extra-bright variants (LED screen walls, clad crowns)
     tone:     { n: night wall colour, d: day wall colour } (null = generator's
               dark neutral default)
     dayPal:   daytime facade material rotation
   Values are tuned from Apex 26's street_night/modern/vegas profiles. */
export const DISTRICTS = {
  // Midtown: the tall core you swing through. Vegas/Singapore-derived.
  midtown: {
    h: [42, 90], hMax: 220, bias: 0.55,
    kinds: ["setback", "tiered", "podium", "slab", "twin", "spire", "cylinder", "fin", "notch", "drum"],
    neonKinds: ["screen", "clad", "antenna"],
    tone: { n: [0.12, 0.13, 0.18], d: [0.44, 0.46, 0.50] },
    neon: [NC.cyan, NC.mag, NC.gold, NC.violet, NC.teal, NC.white, NC.blue],
    dayPal: [DC.steel, DC.bluglass, DC.darkglass, DC.greyblue, DC.white, DC.concrete, DC.charcoal, DC.stone],
  },
  // Commercial mid-rise ring around the core.
  commercial: {
    h: [18, 46], hMax: 110, bias: 0.42,
    kinds: BLD,
    neonKinds: ["screen", "clad"],
    tone: null,
    neon: [NC.mag, NC.cyan, NC.gold, NC.violet, NC.teal, NC.orange, NC.pink],
    dayPal: [DC.stone, DC.greyblue, DC.cream, DC.tan, DC.slate, DC.paleblue, DC.sand, DC.brick],
  },
  // Low-rise brownstone / warehouse edges — rooftops you can run across.
  lowrise: {
    h: [9, 18], hMax: 40, bias: 0.16,
    kinds: ["setback", "slab", "podium", "tiered", "hall", "chevron"],
    neonKinds: [],
    tone: { n: [0.19, 0.16, 0.15], d: [0.66, 0.55, 0.46] },
    neon: [NC.gold, NC.white, NC.rose, NC.amber],
    dayPal: [DC.brick, DC.terra, DC.cream, DC.tan, DC.ochre, DC.stone, DC.sand],
  },
};

// District assignment by block coordinate — a radial profile: tall core,
// commercial ring, low-rise rim. citygen.js calls this per block.
export function districtOf(bx, bz, nx, nz) {
  const cx = (nx - 1) / 2, cz = (nz - 1) / 2;
  const r = Math.hypot((bx - cx) / (nx / 2), (bz - cz) / (nz / 2));
  return r < 0.45 ? "midtown" : r < 0.8 ? "commercial" : "lowrise";
}
