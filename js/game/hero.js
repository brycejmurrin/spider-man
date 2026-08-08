/* Web-Slinger — the hero controller: a world-space capsule with a
   GROUND | AIR | SWING | WALLRUN state machine.

   Design (carried over from Apex 26's driving model, generalized):
   - World position + velocity are THE AUTHORITY. Everything else (camera,
     mesh pose, HUD, obs()) reads them; only hard constraints write back —
     exactly two: the tether clamp and capsule depenetration.
   - The swing is the Fristrom constraint method: integrate velocity under
     gravity + air steer, clamp the position to the tether sphere, re-derive
     velocity from positions. The pendulum falls out; no angular state.
   - Deterministic: no Math.random anywhere in this module. Same inputs +
     same city ⇒ same trajectory, bit for bit (swing.spec.js pins it).

   Pure module: needs only a colliders object ({raycast, sphereClip, groundY}).
   No renderer, no DOM — unit-tested headless in Node. */
import { HeroConsts as C } from "./hero-consts.js";

export function createHero(colliders) {
  const p = [0, 0, 0];          // FOOT position, world metres
  const v = [0, 0, 0];
  let state = "air";            // ground | air | swing | wallrun
  let head = 0;                 // facing yaw (rad, atan2(vx, vz) convention)
  let anchor = null;            // [x,y,z] web attach point while swinging
  let tether = 0;               // current tether length
  let zipCd = 0;                // zip cooldown
  let wallN = null;             // wall normal while wallrunning
  let lastSide = 0, bestSide = 0;   // which side the last anchor was on (auto-straighten)
  let releaseMult = 0;          // last release's timing multiplier (HUD/FX read)
  let wallV = 0;                // vertical speed left in the wallrun
  let airT = 0, swingT = 0;     // time in state (feel + tests)

  const len2 = (x, z) => Math.hypot(x, z);

  function reset(x, y, z, speed, headIn) {
    p[0] = x; p[1] = y; p[2] = z;
    head = headIn || 0;
    const s = speed || 0;
    v[0] = Math.sin(head) * s; v[1] = 0; v[2] = Math.cos(head) * s;
    state = "air"; anchor = null; tether = 0; zipCd = 0; wallN = null;
    airT = 0; swingT = 0; lastSide = 0; bestSide = 0; releaseMult = 0;
  }

  /* Anchor selection: cast a fan of rays from the chest, forward and up,
     biased toward the input steer, and SCORE the hits.

     The scoring is the whole feel of the swing. Preferring the highest hit —
     the obvious first implementation — monotonically prefers the LONGEST
     tether, and a long tether is a slow pendulum: half-period is pi*sqrt(L/g),
     so 45 m swings for 2.8 s. That single choice is what makes a swing game
     feel like "hold the button and drift". Targeting TETHER_IDEAL instead
     keeps arcs in the 1.8-2.3 s band, where they read as athletic.

     With no steering input we also bias to the side OPPOSITE the last anchor,
     so consecutive arcs oscillate about the heading instead of curving away —
     the auto-straightening every swing game does invisibly. */
  const _dir = [0, 0, 0];
  function pickAnchor(steer) {
    const fx = Math.sin(head), fz = Math.cos(head);
    const chest = [p[0], p[1] + 1.4, p[2]];
    let best = null, bestScore = -Infinity;
    const straightening = Math.abs(steer) < 0.15;
    for (const az of [0, 0.28, -0.28, 0.55, -0.55]) {
      for (const el of [0.9, 0.65, 1.15]) {
        const a = az + steer * 0.45;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = fx * ca + fz * sa, dz = fz * ca - fx * sa;
        const ch = Math.cos(el), sh = Math.sin(el);
        _dir[0] = dx * ch; _dir[1] = sh; _dir[2] = dz * ch;
        const hit = colliders.raycast(chest, _dir, C.ANCHOR_MAX);
        if (!hit) continue;
        if (hit.y < p[1] + C.ANCHOR_MIN_UP) continue;
        // ANCHOR_MAX is how far the SEARCH ray reaches; TETHER_MAX is how long
        // a web may be. Accepting a hit between the two clamps the tether
        // shorter than the hero's actual distance, and the constraint then
        // yanks him inward on the attach frame (caught by the tether test:
        // "tether 45.00 but distance 46.95").
        if (hit.t > C.TETHER_MAX) continue;
        const lenS = -Math.abs(hit.t - C.TETHER_IDEAL);          // dominant term
        const upS = Math.min(hit.y - p[1], 30) * 0.35;           // clearance, saturating
        const aimS = -Math.abs(az) * 6;
        const strS = straightening && az !== 0 && lastSide !== 0
          ? -Math.sign(az) * lastSide * 5 : 0;
        const score = lenS + upS + aimS + strS + (hit.t < C.TETHER_MIN ? -40 : 0);
        if (score > bestScore) { bestScore = score; best = hit; bestSide = Math.sign(az); }
      }
    }
    if (best) return [best.x, best.y, best.z];
    if (p[1] < C.ASSIST_Y) {
      // Never-stranded assist. Derived from the hero's CURRENT position, so
      // there is no teleport into the arc — the artifact players read as
      // "floatiness" in the game this borrows the idea from.
      bestSide = -lastSide || 1;
      return [p[0] + fx * 18, p[1] + 30, p[2] + fz * 18];
    }
    return null;
  }

  /* One fixed physics step. input:
       dirX, dirZ  desired move direction, world space (camera-relative,
                   already resolved by the caller), |dir| <= 1
       swing       hold to swing (attach if unattached)
       jump        edge-triggered
       zip         edge-triggered web-zip
       dive        hold to dive */
  function step(input, dt) {
    input = input || {};
    const dirX = input.dirX || 0, dirZ = input.dirZ || 0;
    const dirLen = len2(dirX, dirZ);
    zipCd = Math.max(0, zipCd - dt);

    if (state === "swing") {
      const held = input.swing;
      // Force-release: a rigid tether with no stall guard lets the hero come
      // to rest out at 90 degrees, balanced on a stiff web.
      // A stall is SLOW-AND-FAR-OUT, not merely far out: a fresh anchor 6 m
      // above and 20 m ahead already sits at 73 degrees, so testing the angle
      // alone force-released most swings on their attach frame (measured: 7
      // swings and 125 m in 60 s, against 40+ and ~1 km once gated).
      const sp3 = Math.hypot(v[0], v[1], v[2]);
      const phi = swingPhase(anchor);
      const stalled = swingT > 0.35 &&
        ((Math.abs(phi) > C.STALL_ANGLE && sp3 < 14)
          || sp3 < C.STALL_SPEED
          || swingT > C.SWING_MAX_T);
      // Auto-release at the forward apex while the button is held.
      const apex = swingT > 0.25 && phi > C.AUTO_RELEASE_PHI && v[1] > -0.5;
      if (!held || stalled || apex) {
        if (input.jump || !held) releaseJump(anchor);
        lastSide = bestSide;
        state = "air"; anchor = null;
      }
    }

    if (state === "ground") {
      airT = 0;
      // camera-relative run
      if (dirLen > 0.05) {
        v[0] += dirX * C.RUN_ACCEL * dt; v[2] += dirZ * C.RUN_ACCEL * dt;
        const sp = len2(v[0], v[2]);
        if (sp > C.RUN_V) { const k = C.RUN_V / sp; v[0] *= k; v[2] *= k; }
      } else {
        const f = Math.exp(-C.GROUND_FRICTION * dt);
        v[0] *= f; v[2] *= f;
      }
      if (input.jump) { v[1] = C.JUMP_V; state = "air"; }
      else if (input.swing) { const a = pickAnchor(steerOf(input)); if (a) attach(a); }
    }

    if (state === "wallrun") {
      wallV -= C.WALLRUN_DECAY * dt;
      v[1] = wallV;
      // hug the wall; jump kicks off it
      if (input.jump && wallN) {
        v[0] += wallN[0] * C.WALLJUMP_KICK; v[2] += wallN[2] * C.WALLJUMP_KICK;
        v[1] = C.WALLJUMP_UP; state = "air"; wallN = null;
      } else if (wallV < -2 || !input.dirX && !input.dirZ && wallV < 0) {
        state = "air"; wallN = null;
      } else if (input.swing) {
        const a = pickAnchor(steerOf(input));
        if (a) { attach(a); wallN = null; }
      }
    }

    if (state === "air" || state === "swing") {
      airT += dt;
      const g = C.GRAV * (input.dive && state === "air" ? C.DIVE_GRAV_MULT : 1);
      v[1] -= g * dt;
      // Steering authority. Higher while attached: the hero handles like a
      // drone on a rope, not like a body on rails.
      const steerA = state === "swing" ? C.SWING_STEER : C.AIR_STEER;
      v[0] += dirX * steerA * dt; v[2] += dirZ * steerA * dt;

      if (state === "air" && input.swing && !anchor) {
        const a = pickAnchor(steerOf(input));
        if (a) attach(a);
      }
      if (state === "air" && input.zip && zipCd <= 0) {
        const sp = len2(v[0], v[2]);
        const fx = sp > 1 ? v[0] / sp : Math.sin(head), fz = sp > 1 ? v[2] / sp : Math.cos(head);
        v[0] += fx * C.ZIP_BOOST; v[2] += fz * C.ZIP_BOOST; v[1] += C.ZIP_UP;
        zipCd = C.ZIP_COOLDOWN;
      }
    }

    // Speed cap. VMAX is SOFT — drag past it, so a dive slingshot off a tower
    // legitimately overshoots for a second or two and bleeds back with no
    // clamp pop. VHARD is the sanity rail underneath it: nothing in the model
    // should ever reach it, and if something does, a hard clamp is a far
    // better failure than a hero leaving the map.
    {
      const sp = Math.hypot(v[0], v[1], v[2]);
      if (sp > C.VMAX) {
        const k = Math.exp(-C.OVERSPEED_DRAG * dt * (sp / C.VMAX - 1));
        v[0] *= k; v[1] *= k; v[2] *= k;
      }
      const sp2 = Math.hypot(v[0], v[1], v[2]);
      if (sp2 > C.VHARD) { const k = C.VHARD / sp2; v[0] *= k; v[1] *= k; v[2] *= k; }
    }

    // integrate + tether constraint (velocity projection: the constraint IS
    // the swing — clamp position to the sphere, recompute v from positions)
    const px = p[0], py = p[1], pz = p[2];
    let nx = px + v[0] * dt, ny = py + v[1] * dt, nz = pz + v[2] * dt;
    if (state === "swing" && anchor) {
      swingT += dt;
      // Pump: the rider's own energy input, along horizontal velocity in the
      // bottom half of the arc. Applied to VELOCITY, not position — a position
      // nudge is re-derived as velocity by the constraint below and its
      // magnitude then depends on dt.
      const below = anchor[1] - ny;
      if (below > tether * 0.55) {
        const sp = len2(v[0], v[2]);
        if (sp > 0.5) {
          const k = C.SWING_PUMP * dt / sp;
          v[0] += v[0] * k; v[2] += v[2] * k;
          nx = px + v[0] * dt; nz = pz + v[2] * dt;
        }
      }
      // auto-shorten so the arc bottom clears the street
      const street = colliders.groundY(anchor[0], anchor[2], anchor[1]);
      const clearL = anchor[1] - (street + C.GROUND_CLEAR) - 1.7;
      if (clearL > C.TETHER_MIN && tether > clearL)
        tether = Math.max(clearL, tether - C.SHORTEN_RATE * dt);
      const spBefore = Math.hypot(v[0], v[1], v[2]);
      let dx = nx - anchor[0], dy = ny + 1.4 - anchor[1], dz = nz - anchor[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > tether) {
        const k = tether / d;
        nx = anchor[0] + dx * k; ny = anchor[1] + dy * k - 1.4; nz = anchor[2] + dz * k;
      }
      v[0] = (nx - px) / dt; v[1] = (ny - py) / dt; v[2] = (nz - pz) / dt;
      // A RIGID CONSTRAINT DOES NO WORK. Re-deriving velocity from a clamped
      // position silently adds energy whenever the clamp moves the hero more
      // than free flight would — reeling the tether in, or a large correction
      // on one frame. Measured before this line: 146 m/s against a 52 m/s cap.
      // The tether may redirect the velocity; it may never lengthen it.
      const spAfter = Math.hypot(v[0], v[1], v[2]);
      if (spAfter > spBefore && spAfter > 1e-6) {
        const k = spBefore / spAfter;
        v[0] *= k; v[1] *= k; v[2] *= k;
        nx = px + v[0] * dt; ny = py + v[1] * dt; nz = pz + v[2] * dt;
      }
    } else swingT = 0;
    p[0] = nx; p[1] = ny; p[2] = nz;

    // ── collisions: ground/roof, then walls (collide-and-slide) ────────────
    const gy = colliders.groundY(p[0], p[2], p[1] + 0.5);
    if (p[1] <= gy && v[1] <= 0.01) {
      p[1] = gy;
      if (state !== "ground") { land(); }
      v[1] = 0;
    } else if (state === "ground" && p[1] > gy + 0.3) {
      state = "air";   // ran off a roof edge
    }

    // capsule vs building walls at knee + chest
    for (const hy of [0.4, 1.3]) {
      const clip = colliders.sphereClip([p[0], p[1] + hy, p[2]], C.RADIUS);
      if (!clip) continue;
      p[0] += clip.nx * clip.depth; p[2] += clip.nz * clip.depth;
      if (Math.abs(clip.ny) < 0.3) {
        // wall contact: try wallrun, else slide (project v off the normal)
        const into = v[0] * clip.nx + v[2] * clip.nz;
        const sp = Math.hypot(v[0], v[1], v[2]);
        if (into < 0) { v[0] -= clip.nx * into; v[2] -= clip.nz * into; }
        // Auto-convert a wall contact into a wall run — but only a real one.
        // Gating on total speed alone converted every glancing brush past a
        // facade (measured: 28% of all frames spent wall-running, and forward
        // progress collapsed to a fifth). What matters is how fast the hero is
        // travelling INTO the surface, which is exactly -(v . n).
        const intoV = -into;
        const steered = (dirX * clip.nx + dirZ * clip.nz) < -0.4;
        if (state === "air" && intoV > 4 &&
            (sp > C.WALLRUN_AUTO_V || (sp > C.WALLRUN_MIN_V && dirLen > 0.3 && steered))) {
          state = "wallrun"; wallN = [clip.nx, 0, clip.nz];
          wallV = Math.min(C.WALLRUN_UP, sp * 0.8);
          anchor = null;
        }
      }
    }

    // facing follows horizontal velocity
    const hsp = len2(v[0], v[2]);
    if (hsp > 1.5) head = Math.atan2(v[0], v[2]);
  }

  function steerOf(input) {
    // signed left/right intent relative to facing, for the anchor cone bias
    const fx = Math.sin(head), fz = Math.cos(head);
    return (input.dirX || 0) * fz - (input.dirZ || 0) * fx;
  }

  function attach(a) {
    anchor = a;
    const dx = p[0] - a[0], dy = p[1] + 1.4 - a[1], dz = p[2] - a[2];
    tether = Math.min(C.TETHER_MAX, Math.max(C.TETHER_MIN, Math.hypot(dx, dy, dz)));
    state = "swing";
    swingT = 0;
  }

  /* Tether angle from straight down, signed by direction of travel: 0 at the
     bottom of the arc, positive on the way up and out. */
  function swingPhase(a) {
    if (!a) return 0;
    const dx = p[0] - a[0], dy = p[1] + 1.4 - a[1], dz = p[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const phi = Math.acos(Math.max(-1, Math.min(1, -dy / L)));
    const outward = v[0] * dx + v[2] * dz;      // moving away from under the anchor
    return outward >= 0 ? phi : -phi;
  }

  /* Release boost. Peaks just past the bottom of the arc and decays to a
     PENALTY outside the window, so "when do I let go" is a real decision
     rather than a button to hold. */
  function releaseJump(a) {
    const phi = swingPhase(a);
    const lo = C.RELEASE_PEAK_LO, hi = C.RELEASE_PEAK_HI;
    let m = C.RELEASE_MULT_MIN;
    if (phi > lo && phi < hi) {
      const t = (phi - lo) / (hi - lo);                  // 0..1 across the window
      const bump = Math.sin(Math.PI * t);                // peaks mid-window
      m = C.RELEASE_MULT_MIN + (C.RELEASE_MULT_MAX - C.RELEASE_MULT_MIN) * bump;
    }
    releaseMult = m;
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp > 1) {
      const k = (C.RELEASE_BASE * m) / sp;
      v[0] += v[0] * k; v[1] += Math.max(v[1] * k, 2.5); v[2] += v[2] * k;
    }
  }

  function land() {
    state = "ground";
    anchor = null;
    // landing report for FX/audio (read-and-clear by the driver)
    api.landed = Math.max(api.landed, -v[1]);
  }

  const api = {
    p, v,
    landed: 0,                 // impact speed of the latest landing (driver clears)
    get state() { return state; },
    get head() { return head; },
    get anchor() { return anchor; },
    get tether() { return tether; },
    get speed() { return Math.hypot(v[0], v[1], v[2]); },
    get airTime() { return airT; },
    get swingTime() { return swingT; },
    get swingPhase() { return swingPhase(anchor); },
    get releaseMult() { return releaseMult; },
    reset, step, pickAnchor,
  };
  return api;
}
