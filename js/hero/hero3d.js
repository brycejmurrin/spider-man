/* Web-Slinger — procedural rigid-segment hero mesh, following Apex 26's
   car3d.js architecture: primitive emitters into plain {pos,nrm,col,mat,idx}
   accumulators, frozen JOINT datums, and each articulated piece as its OWN
   mesh with its own transform (the aero-flap/wheel pattern — that split IS
   the skeleton; the renderer has no skinning and doesn't need any).

   Nine segments: torso(+head merged? no — head separate for look-at later),
   head, upper/fore arm LxR, thigh/shin LxR. Every segment's geometry origin
   is its PIVOT JOINT, so posing is translate(joint) * rot. pose() writes
   column-major mat4 locals the driver multiplies onto the body root.

   Suit: classic red/blue via vertex colour + SURFACE ids above the city MAT
   range (paint 20, lens 25-emissive style handled by colour brightness). */
import { Geom } from "../city/geom.js";

const RED = [0.72, 0.10, 0.13];
const DK_RED = [0.55, 0.08, 0.11];
const BLUE = [0.12, 0.17, 0.45];
const LENS = [1.6, 1.6, 1.7];          // HDR white — reads at night
const BLACK = [0.05, 0.05, 0.06];

// Frozen joint datums (metres, hero space: +Z forward, +Y up, origin at FEET).
export const JOINTS = {
  pelvis: [0, 0.92, 0],
  neck: [0, 1.52, 0],
  shoulderL: [-0.24, 1.46, 0], shoulderR: [0.24, 1.46, 0],
  elbowDrop: 0.30,             // shoulder -> elbow length
  foreLen: 0.28,               // elbow -> wrist
  hipL: [-0.11, 0.92, 0], hipR: [0.11, 0.92, 0],
  thighLen: 0.44, shinLen: 0.48,
};

function box(out, c, sz, col) { Geom.addBox(out, c, sz, col, null); }

function buildSegments() {
  const segs = {};
  const mk = () => ({ pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 20 });

  // torso: pivot at pelvis; chest red w/ black web hint, abdomen+pelvis blue
  {
    const o = mk();
    box(o, [0, 0.38, 0], [0.36, 0.44, 0.22], RED);           // chest
    box(o, [0, 0.10, 0], [0.30, 0.56 - 0.44, 0.20], BLUE);   // abdomen
    box(o, [0, -0.02, 0], [0.30, 0.14, 0.22], BLUE);         // pelvis
    box(o, [0, 0.42, 0.115], [0.10, 0.14, 0.012], BLACK);    // spider emblem
    segs.torso = o;
  }
  // head: pivot at neck; mask + big white lenses
  {
    const o = mk();
    box(o, [0, 0.13, 0], [0.21, 0.24, 0.23], RED);
    for (const s of [-1, 1]) {
      box(o, [s * 0.055, 0.15, 0.118], [0.075, 0.09, 0.012], LENS);
    }
    segs.head = o;
  }
  // arms: pivot at shoulder; upper arm red, forearm red, hand darker
  for (const side of ["L", "R"]) {
    const u = mk();
    box(u, [0, -JOINTS.elbowDrop / 2, 0], [0.11, JOINTS.elbowDrop + 0.06, 0.11], RED);
    segs["upperArm" + side] = u;
    const f = mk();   // pivot at elbow
    box(f, [0, -JOINTS.foreLen / 2, 0], [0.095, JOINTS.foreLen + 0.04, 0.095], RED);
    box(f, [0, -JOINTS.foreLen - 0.045, 0], [0.09, 0.09, 0.10], DK_RED);   // hand
    segs["foreArm" + side] = f;
  }
  // legs: pivot at hip; thigh/shin blue, boot red
  for (const side of ["L", "R"]) {
    const t = mk();
    box(t, [0, -JOINTS.thighLen / 2, 0], [0.13, JOINTS.thighLen + 0.05, 0.14], BLUE);
    segs["thigh" + side] = t;
    const s = mk();   // pivot at knee
    box(s, [0, -JOINTS.shinLen / 2 + 0.05, 0], [0.11, JOINTS.shinLen - 0.10, 0.115], BLUE);
    box(s, [0, -JOINTS.shinLen + 0.035, 0.03], [0.11, 0.09, 0.19], RED);   // boot
    segs["shin" + side] = s;
  }
  return segs;
}

export const SEGMENTS = ["torso", "head",
  "upperArmL", "foreArmL", "upperArmR", "foreArmR",
  "thighL", "shinL", "thighR", "shinR"];

// parent joint (in hero space) per segment; children pivot in PARENT-LOCAL
// space at the parent's joint-relative offset.
const PIVOT = {
  torso: JOINTS.pelvis, head: JOINTS.neck,
  upperArmL: JOINTS.shoulderL, upperArmR: JOINTS.shoulderR,
  thighL: JOINTS.hipL, thighR: JOINTS.hipR,
};

/* Build all segment geometries once. The driver uploads each with
   gfx.createMesh and draws them with the locals pose() fills in. */
export function buildHero() {
  return buildSegments();
}

/* pose(out, state, t, speed, extra) — fill out[seg] (Float32Array(16),
   column-major, hero-root space) for every segment.
     state: ground|air|swing|wallrun   t: seconds in state / run phase
     extra: { tetherPitch, tetherYaw } while swinging (aim the right arm) */
const _tmp = new Float32Array(16);
function setRotXZ(m, rx, rz, px, py, pz) {
  // M = T(pivot) * RotZ(rz) * RotX(rx), column-major
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  m[0] = cz; m[1] = sz; m[2] = 0; m[3] = 0;
  m[4] = -sz * cx; m[5] = cz * cx; m[6] = sx; m[7] = 0;
  m[8] = sz * sx; m[9] = -cz * sx; m[10] = cx; m[11] = 0;
  m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
}
// child = parentLocal * T(childPivot - parentPivot) * Rot
function chain(m, parent, rx, rz, off) {
  setRotXZ(_tmp, rx, rz, off[0], off[1], off[2]);
  // m = parent * _tmp   (4x4 col-major multiply, unrolled-ish)
  for (let c = 0; c < 4; c++) {
    const b0 = _tmp[c * 4], b1 = _tmp[c * 4 + 1], b2 = _tmp[c * 4 + 2], b3 = _tmp[c * 4 + 3];
    for (let r = 0; r < 4; r++)
      m[c * 4 + r] = parent[r] * b0 + parent[4 + r] * b1 + parent[8 + r] * b2 + parent[12 + r] * b3;
  }
}

export function pose(out, state, t, speed, extra) {
  extra = extra || {};
  const J = JOINTS;
  let torsoPitch = 0, legLA = 0, legRA = 0, kneeL = 0, kneeR = 0;
  let armLA = 0, armRA = 0, elbL = 0.25, elbR = 0.25, headPitch = 0;
  if (state === "ground") {
    const run = Math.min(1, speed / 8);
    const ph = t * (4 + speed * 0.9);
    torsoPitch = 0.12 * run;
    legLA = Math.sin(ph) * 0.85 * run; legRA = -legLA;
    kneeL = Math.max(0, -Math.sin(ph)) * 1.0 * run; kneeR = Math.max(0, Math.sin(ph)) * 1.0 * run;
    armLA = -legLA * 0.8; armRA = legLA * 0.8;
    elbL = elbR = 0.5 * run + 0.2;
  } else if (state === "swing") {
    // hang from the tether: torso pitched forward, right arm up the web,
    // legs trailing with bent knees
    torsoPitch = 0.55;
    armRA = -Math.PI + (extra.tetherPitch || 0);   // up along the tether
    elbR = 0.15;
    armLA = 0.5; elbL = 0.7;
    legLA = 0.45; legRA = 0.62; kneeL = 0.9; kneeR = 1.15;
    headPitch = -0.35;
  } else if (state === "wallrun") {
    torsoPitch = 0.6;
    const ph = t * 9;
    legLA = Math.sin(ph) * 0.8; legRA = -legLA;
    kneeL = kneeR = 0.8;
    armLA = -legLA; armRA = legLA; elbL = elbR = 0.6;
  } else { // air
    const dive = speed > 26 && extra.diving;
    if (dive) {
      torsoPitch = 0.2; armLA = armRA = 0.9; elbL = elbR = 0.1;
      legLA = legRA = -0.1; kneeL = kneeR = 0.15;
    } else {
      torsoPitch = -0.15;
      armLA = -2.2; armRA = -2.2; elbL = elbR = 0.35;        // arms up/spread
      legLA = 0.3; legRA = 0.15; kneeL = 0.55; kneeR = 0.9;  // one leg tucked
    }
  }
  setRotXZ(out.torso, torsoPitch, 0, J.pelvis[0], J.pelvis[1], J.pelvis[2]);
  chain(out.head, out.torso, headPitch - torsoPitch * 0.6, 0,
    [J.neck[0] - J.pelvis[0], J.neck[1] - J.pelvis[1], J.neck[2] - J.pelvis[2]]);
  const shl = [J.shoulderL[0] - J.pelvis[0], J.shoulderL[1] - J.pelvis[1], 0];
  const shr = [J.shoulderR[0] - J.pelvis[0], J.shoulderR[1] - J.pelvis[1], 0];
  chain(out.upperArmL, out.torso, armLA, 0.22, shl);
  chain(out.upperArmR, out.torso, armRA, -0.22, shr);
  chain(out.foreArmL, out.upperArmL, -elbL, 0, [0, -J.elbowDrop, 0]);
  chain(out.foreArmR, out.upperArmR, -elbR, 0, [0, -J.elbowDrop, 0]);
  const hl = [J.hipL[0] - J.pelvis[0], 0, 0], hr = [J.hipR[0] - J.pelvis[0], 0, 0];
  chain(out.thighL, out.torso, legLA - torsoPitch, 0.04, hl);
  chain(out.thighR, out.torso, legRA - torsoPitch, -0.04, hr);
  chain(out.shinL, out.thighL, kneeL, 0, [0, -J.thighLen, 0]);
  chain(out.shinR, out.thighR, kneeR, 0, [0, -J.thighLen, 0]);
}

/* Wrist world offset for the webline start point (right hand), given the
   posed locals + the body root matrix. Cheap: transform the wrist point of
   foreArmR through local then root. */
export function wristR(out, root, locals) {
  const w = [0, -JOINTS.foreLen - 0.05, 0];
  const l = locals.foreArmR;
  const lx = l[0] * w[0] + l[4] * w[1] + l[8] * w[2] + l[12];
  const ly = l[1] * w[0] + l[5] * w[1] + l[9] * w[2] + l[13];
  const lz = l[2] * w[0] + l[6] * w[1] + l[10] * w[2] + l[14];
  out[0] = root[0] * lx + root[4] * ly + root[8] * lz + root[12];
  out[1] = root[1] * lx + root[5] * ly + root[9] * lz + root[13];
  out[2] = root[2] * lx + root[6] * ly + root[10] * lz + root[14];
  return out;
}
