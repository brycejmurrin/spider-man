/* Web-Slinger — the city generator: seeded grid -> blocks -> lots ->
   buildings.js massing calls, plus ground/road geometry, street lamps and the
   collider registry. Replaces Apex 26's spline-relative placement layer with
   the Manhattan grid the massing library always wanted.

   Deterministic: everything derives from hash(seed + coords) — same seed,
   same city, byte for byte (asserted by tests/unit/citygen.test.mjs).

   Pure module: emits plain {pos,nrm,col,idx,mat} accumulators + records.
   The driver uploads them (createMesh / createChunkedMesh) — no renderer here. */
import { Geom } from "./geom.js";
import { CityGraph } from "./graph.js";
import { createBuildings } from "./buildings.js";
import { createColliders } from "./colliders.js";
import { DISTRICTS, districtOf } from "./city-data.js";

const { MAT } = Geom;

// The f1-game scenery hash: deterministic, stateless, uniform enough.
export const hash = (x) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export const CITY = {
  BLOCKS: 12,        // blocks per side
  BLOCK: 80,         // block size (m)
  STREET: 24,        // street width (m)
  SIDEWALK: 4,       // sidewalk strip inside each block edge (m)
};
CITY.PITCH = CITY.BLOCK + CITY.STREET;                 // 104 m block pitch
CITY.SPAN = CITY.BLOCKS * CITY.PITCH;                  // ~1.25 km side
CITY.HALF = CITY.SPAN / 2;

/* buildCity(seed, opts) -> {
     out, glassBuf          geometry accumulators (props + reflective glass)
     ground                 ground/street slab geometry
     graph                  CityGraph (instancing batches + bake)
     colliders              building OBB query object
     lamps                  street lamp records for frame.lights
                            [{x,y,z, r,g,b, rad, dir, kind}]
     stats
   } */
export function buildCity(seed, opts) {
  opts = opts || {};
  const night = opts.night !== false;   // v1 ships night; day is a supported A/B
  const N = opts.blocks || CITY.BLOCKS;
  const h2 = (a, b) => hash(seed * 7.31 + a * 12.9898 + b * 78.233);

  const out = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
  const glassBuf = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
  const ground = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
  const graph = CityGraph.create({ raw: Geom });
  const colliders = createColliders({});
  const lamps = [];

  const B = createBuildings({
    out, glassBuf, graph, night, hash,
    register: (rec) => colliders.add(rec),
  });

  // ── ground slab + streets ────────────────────────────────────────────────
  // One big asphalt slab under everything, then a concrete pad per block so
  // sidewalks/blocks read lighter than the streets between them.
  const H = N * CITY.PITCH / 2;
  ground._mat = MAT.ASPHALT;
  Geom.addBox(ground, [0, -0.25, 0], [N * CITY.PITCH + 400, 0.5, N * CITY.PITCH + 400], [0.052, 0.052, 0.058]);
  ground._mat = MAT.CONCRETE;
  for (let bx = 0; bx < N; bx++) for (let bz = 0; bz < N; bz++) {
    const cx = -H + CITY.PITCH * (bx + 0.5), cz = -H + CITY.PITCH * (bz + 0.5);
    Geom.addBox(ground, [cx, 0.06, cz], [CITY.BLOCK, 0.12, CITY.BLOCK], [0.115, 0.115, 0.122]);
  }
  ground._mat = 0;

  // ── blocks -> lots -> buildings ──────────────────────────────────────────
  // Each block: an inner buildable square (block minus sidewalks) split into a
  // small grid of lots (1x1 to 3x3 by district height — tall cores get fewer,
  // bigger lots). Every lot faces its nearest street (basis rotated so -r
  // points outward); interior lots face +x by convention.
  let buildings = 0;
  for (let bx = 0; bx < N; bx++) for (let bz = 0; bz < N; bz++) {
    const dName = districtOf(bx, bz, N, N);
    const prof = DISTRICTS[dName];
    const cx = -H + CITY.PITCH * (bx + 0.5), cz = -H + CITY.PITCH * (bz + 0.5);
    const inner = CITY.BLOCK - CITY.SIDEWALK * 2;
    // lots per side: midtown 2, commercial 2-3, lowrise 3
    const per = dName === "midtown" ? 2 : dName === "lowrise" ? 3 : (h2(bx, bz) < 0.5 ? 2 : 3);
    const lot = inner / per;
    for (let lx = 0; lx < per; lx++) for (let lz = 0; lz < per; lz++) {
      const s = h2(bx * 31 + lx, bz * 17 + lz);
      if (s < 0.06) continue;                    // occasional empty lot (plaza)
      const lcx = cx - inner / 2 + lot * (lx + 0.5);
      const lcz = cz - inner / 2 + lot * (lz + 0.5);
      // face the nearest block edge: west/east lots face -x/+x, else -z/+z
      let yaw = 0;
      if (lx === 0) yaw = 0;                         // -r = -x (west street)
      else if (lx === per - 1) yaw = Math.PI;        // -r = +x
      else if (lz === 0) yaw = Math.PI / 2;          // -r = -z
      else if (lz === per - 1) yaw = -Math.PI / 2;   // -r = +z
      const r = [Math.cos(yaw), 0, Math.sin(yaw)];
      const t = [-Math.sin(yaw), 0, Math.cos(yaw)];
      const margin = 1.5;
      const w = lot - margin * 2, d = lot - margin * 2;
      let h = prof.h[0] + (0.6 * s + 0.4 * h2(bx, bz)) * prof.h[1];
      if (h2(bx * 7 + lx * 3, bz * 5 + lz * 11) < 0.10) h = Math.min(prof.hMax, h * 1.5);
      B.building(
        { c: [lcx, 0, lcz], r, u: [0, 1, 0], t, w, h, d },
        prof,
        { seed: seed * 3.1 + bx * 97.7 + bz * 55.1 + lx * 13.7 + lz * 7.3 });
      buildings++;
    }
  }

  // ── street lamps: sodium/led records for frame.lights + lamp geometry ────
  // Cantilever masts down every street, both directions, at LAMP_STEP. Apex 26
  // walks its centreline at ~22 m and that density is what makes its street
  // circuits read as LIT rather than as dark boxes with lamps in them; a lamp
  // per block corner (the first pass here) left 100 m of unlit asphalt between
  // pools. Geometry is instanced (2 models), and setFrameLights only ever
  // uploads the nearest 28 records, so density costs almost nothing.
  const SODIUM = [1.0, 0.62, 0.20], LED = [0.75, 0.85, 1.0];
  const lampCol = (warm, lvl) => warm ? SODIUM.map((v) => v * lvl) : LED.map((v) => v * lvl);
  const LAMP_STEP = 34, HGT = 8;
  const lampModel = (warm) => (rec) => {
    rec.mat(MAT.METAL);
    rec.cyl([0, 0, 0], 0.18, HGT, [0.13, 0.13, 0.15], 6);
    rec.box([0.85, HGT - 0.2, 0], [1.7 + 0.5, 0.18, 0.22], [0.13, 0.13, 0.15]);
    rec.mat(0);
    // HDR head albedo so the fixture itself glows and trips bloom at night
    rec.box([1.7, HGT - 0.2, 0], [0.85, 0.35, 0.55],
      warm ? [1.4, 0.87, 0.28] : [1.05, 1.19, 1.4]);
  };
  const placeLamp = (x, z, yaw, warm) => {
    const r = [Math.cos(yaw), 0, Math.sin(yaw)], t = [-Math.sin(yaw), 0, Math.cos(yaw)];
    graph.instance(`lamp|${warm ? "na" : "led"}`,
      { o: [x, 0, z], r, u: [0, 1, 0], t }, lampModel(warm),
      { kind: "streetLamp" }, Geom, out);
    lamps.push({
      x: x + r[0] * 1.7, y: HGT - 0.3, z: z + r[2] * 1.7,
      col: lampCol(warm, warm ? 150 : 170),
      rad: 30, dir: [0, -1, 0], cosIn: 0.80, cosOut: 0.26,
      bleed: 0.12, volW: 0.5, glareW: 0.9,
    });
  };
  const edge = N * CITY.PITCH / 2;
  const warmAt = (x, z) => districtOf(
    Math.max(0, Math.min(N - 1, Math.floor((x + edge) / CITY.PITCH))),
    Math.max(0, Math.min(N - 1, Math.floor((z + edge) / CITY.PITCH))), N, N) !== "midtown";
  for (let i = 0; i <= N; i++) {
    const sx = -H + CITY.PITCH * i - CITY.STREET / 2;   // street centre, both axes
    for (let d = -edge; d <= edge; d += LAMP_STEP) {
      // avenue running along +z at x=sx: masts on the +x kerb, arm pointing -x
      placeLamp(sx + CITY.STREET / 2 - 1, d, Math.PI, warmAt(sx, d));
      // cross street running along +x at z=sx: masts on the +z kerb
      placeLamp(d, sx + CITY.STREET / 2 - 1, -Math.PI / 2, warmAt(d, sx));
    }
  }

  return {
    out, glassBuf, ground, graph, colliders, lamps, night,
    span: N * CITY.PITCH,
    stats: {
      buildings, lamps: lamps.length,
      propVerts: out.pos.length / 3, glassVerts: glassBuf.pos.length / 3,
      graph: graph.stats(),
    },
  };
}
