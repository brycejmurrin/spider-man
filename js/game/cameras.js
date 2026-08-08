/* Web-Slinger — cameras. The Apex 26 discipline: ONE pure vantage() solver
   used by the live rig, snapCam() and any preview; exponential damping with
   SEPARATE eye/target lambdas (the decoupled-lag trick); trauma shake;
   FOV-with-speed; and a geometry clamp that pulls the eye out of buildings
   via a collider raycast (replacing the track ground clamp).

   The chase mode is the free-world rig from Apex 26's cameras.js verbatim
   in spirit: sit behind the SUBJECT along the subject's heading, look where
   the subject is pointing — never along a road. An orbit offset (mouse drag)
   layers a yaw/pitch on top and recentres while moving fast. */
export const CAM_MODES = [
  { id: "chase", label: "CHASE" },
  { id: "far", label: "FAR" },
  { id: "swing", label: "SWING" },     // low + wide, rolls with lateral velocity
  { id: "heli", label: "HELI" },
];

const damp = (c, t, l, dt) => c + (t - c) * (1 - Math.exp(-l * dt));

/* Geometry-clamp constants. PAD is how far short of a surface the eye stops;
   MIN_D is the framing distance we'd LIKE to keep; HARD_D is the floor we'll
   accept when a facade is closer than that.

   MIN_D is a PREFERENCE, never a floor that outranks the wall. The first
   version wrote `Math.max(MIN_D, hit.t - PAD)`, which places the eye at 2.8 m
   whenever the blocker is nearer than 4.2 m — i.e. THROUGH it. Measured by
   tests/unit/camera-los.test.mjs on seed 42: 43 of 200 solved canyon frames
   sat inside a facade, every single one of them at eyeDist 2.80 against a hit
   at t 1.98. A clamp that can push the eye past the surface it is clamping to
   is not a clamp. */
const PAD = 1.4, MIN_D = 2.8, HARD_D = 0.9;

/* The candidate ladder: [backMul, upMul, sideSign]. Tried in order, first
   fully-clear one wins, otherwise the roomiest. Nominal framing first, then
   the mirrored shoulder, then over the roofline, then near-overhead — which in
   a 24 m street canyon is the placement that is essentially always clear.
   Four raycasts a frame against a spatial hash costs nothing measurable. */
const CANDS = [[1, 1, 1], [1, 1, -1], [0.7, 2.0, 1], [0.35, 3.2, 0]];

export function createCameras(colliders) {
  const eye = [0, 40, -60], tgt = [0, 20, 0];
  let fov = 62, roll = 0, shake = 0, slipSm = 0;
  let orbitYaw = 0, orbitPitch = 0;    // player-drag offsets on the chase rig
  let modeIdx = 0;

  /* solveEye(subject chest, desired eye, out) -> room
     Place one candidate eye and report how far the line to the subject stays
     clear. `room` >= the candidate's own distance means fully unobstructed.

     The ground/roof lift happens HERE, BEFORE the ray, and that ordering is
     load-bearing: lifting the eye after the ray moves it off the very line
     that was just cleared, so it can re-enter the building it was pulled out
     of — the second half of the canyon bug. */
  function solveEye(sx, sy, sz, ex, ey, ez, out) {
    const gy = colliders.groundY(ex, ez, ey + 1);
    if (ey < gy + 0.8) ey = gy + 0.8;
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const hit = colliders.raycast([sx, sy, sz], [dx / dl, dy / dl, dz / dl], dl);
    const room = hit ? hit.t - PAD : dl;
    // Absolute ceiling: stay short of the surface no matter what MIN_D/HARD_D
    // would prefer. This is the line the old clamp did not have.
    const limit = hit ? Math.max(0.2, hit.t - 0.25) : dl;
    const want = Math.min(dl, limit, Math.max(HARD_D, room));
    const k = want / dl;
    out[0] = sx + dx * k; out[1] = sy + dy * k; out[2] = sz + dz * k;
    return room;
  }

  /* vantage(subject) -> {eye, tgt, fov} — pure, no damping.
     subject: { p:[3], v:[3], head, speed, state } */
  const _e = [0, 0, 0], _t = [0, 0, 0], _c = [0, 0, 0];
  function vantage(sub, mode) {
    const spN = Math.min(1, sub.speed / 40);
    const hx = Math.sin(sub.head + orbitYaw), hz = Math.cos(sub.head + orbitYaw);
    let back, up, lead, f;
    if (mode === "far") { back = 10.5; up = 4.2; lead = 9; f = 61 + 8 * spN; }
    else if (mode === "swing") { back = 5.2; up = 1.4; lead = 8; f = 66 + 14 * spN; }
    else if (mode === "heli") { back = 26; up = 30; lead = 4; f = 52; }
    else { back = 6.4; up = 2.3; lead = 6; f = 58 + 10 * spN; }
    up += orbitPitch * back;
    _t[0] = sub.p[0] + hx * lead;
    _t[1] = sub.p[1] + 1.4 + (mode === "heli" ? 0 : 0.6) + orbitPitch * -6;
    _t[2] = sub.p[2] + hz * lead;

    // Geometry clamp. The ray starts at the SUBJECT, not at the look-at
    // target: the target leads the hero by 6-8 m, so a ray cast from it can
    // start on the far side of the very wall the hero is swinging past, and
    // the clamp then "protects" a point the player is not looking at while
    // the eye sits inside a facade. What must stay unobstructed is the line
    // to the hero.
    //
    // Shortening along ONE direction cannot always succeed — in a canyon the
    // wall is sometimes closer than any watchable framing distance. So try a
    // few placements and take the first that is genuinely clear, rather than
    // forcing the nominal one and hoping.
    const sx = sub.p[0], sy = sub.p[1] + 1.4, sz = sub.p[2];
    const rx = hz, rz = -hx;                      // 3/4 side offset (CHASE_SIDE_FRAC)
    let bestScore = -Infinity;
    for (let i = 0; i < CANDS.length; i++) {
      const c = CANDS[i];
      const b = back * c[0], u = up * c[1], side = back * 0.22 * c[2];
      const ex = sub.p[0] - hx * b + rx * side;
      const ey = sub.p[1] + 1.5 + u;
      const ez = sub.p[2] - hz * b + rz * side;
      const room = solveEye(sx, sy, sz, ex, ey, ez, _c);
      const dl = Math.hypot(ex - sx, ey - sy, ez - sz) || 1;
      // Prefer a clear line; among blocked ones prefer the roomiest. Cap the
      // score at MIN_D so a distant HELI shot does not always beat a perfectly
      // good CHASE shot just for being further away.
      const score = Math.min(room, MIN_D);
      if (score > bestScore) {
        bestScore = score;
        _e[0] = _c[0]; _e[1] = _c[1]; _e[2] = _c[2];
      }
      if (room >= dl) break;                      // fully unobstructed — done
    }
    // Last resort: if the eye still ended up inside a box (a corner case the
    // single centre ray cannot see), push it out along the shallowest face.
    const clip = colliders.sphereClip(_e, 0.5);
    if (clip) {
      _e[0] += clip.nx * clip.depth; _e[1] += clip.ny * clip.depth; _e[2] += clip.nz * clip.depth;
    }
    return { eye: _e, tgt: _t, fov: f };
  }

  return {
    eye, tgt,
    get fov() { return fov; },
    get roll() { return roll; },
    get mode() { return CAM_MODES[modeIdx].id; },
    get modeIndex() { return modeIdx; },
    setMode(id) {
      const i = CAM_MODES.findIndex((m) => m.id === id);
      if (i < 0) return false;
      modeIdx = i; return true;
    },
    cycle() { modeIdx = (modeIdx + 1) % CAM_MODES.length; return CAM_MODES[modeIdx].id; },
    addShake(amt) { shake = Math.min(1, shake + amt); },
    orbit(dx, dy) {
      orbitYaw += dx * 0.006; orbitPitch = Math.max(-0.9, Math.min(1.2, orbitPitch + dy * 0.004));
    },
    vantage,

    /* tick(sub, dt) — solve + damp into eye/tgt/fov/roll. */
    tick(sub, dt) {
      const v = vantage(sub, CAM_MODES[modeIdx].id);
      // recentre the orbit while moving (holds still when parked/aiming)
      const rec = Math.min(1, sub.speed / 12) * 1.6;
      orbitYaw = damp(orbitYaw, 0, rec, dt);
      orbitPitch = damp(orbitPitch, 0, rec * 0.6, dt);
      // decoupled lambdas: eye lags more than the look-at (the Apex trick)
      const lE = sub.state === "swing" ? 7 : 10;
      const lT = 16;
      for (let i = 0; i < 3; i++) {
        eye[i] = damp(eye[i], v.eye[i], lE, dt);
        tgt[i] = damp(tgt[i], v.tgt[i], lT, dt);
      }
      fov = damp(fov, v.fov, 4, dt);
      // roll from lateral velocity while swinging (slip-roll, λ from Apex)
      const fx = Math.sin(sub.head), fz = Math.cos(sub.head);
      const lat = sub.speed > 1 ? (sub.v[0] * fz - sub.v[2] * fx) / Math.max(sub.speed, 1) : 0;
      slipSm = damp(slipSm, Math.max(-1, Math.min(1, lat)), 10, dt);
      const rollT = (sub.state === "swing" ? slipSm * 0.14 : slipSm * 0.05);
      roll = damp(roll, rollT, 7, dt);
      // trauma shake — squared so grazes barely move and slams hit hard
      if (shake > 0) {
        shake = Math.max(0, shake - dt * 1.6);
        const a = shake * shake * 0.5, t = performance.now() * 0.05;
        eye[0] += Math.sin(t * 1.3) * a; eye[1] += Math.sin(t * 1.7) * a * 0.6;
        tgt[0] += Math.sin(t * 1.1) * a * 0.4;
      }
    },

    /* snap() — jump straight to the solved vantage (after teleports; the rig
       otherwise spends a second flying to the subject — the Apex snapCam rule). */
    snap(sub) {
      const v = vantage(sub, CAM_MODES[modeIdx].id);
      for (let i = 0; i < 3; i++) { eye[i] = v.eye[i]; tgt[i] = v.tgt[i]; }
      fov = v.fov; roll = 0; shake = 0;
    },
  };
}
