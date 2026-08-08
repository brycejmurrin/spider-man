/* Web-Slinger — the traversal model's immutable numbers, with their tuning
   rationale (the physics-consts.js idiom from Apex 26: every constant carries
   the reason it is what it is; tunables that a slider may move stay `let`s in
   game.js). Units: metres, seconds, radians. +Y up. */

export const HeroConsts = {
  // Gravity 22 m/s² — heavier than Earth's 9.81 on purpose. Every traversal
  // game overdrives gravity because film-real fall rates read floaty at game
  // camera distances; Spider-Man 2 (2004) shipped a swing-accel multiplier of
  // ~3x on real gravity. 22 with a 1.35 swing pump lands in the same envelope.
  GRAV: 22,
  DIVE_GRAV_MULT: 2.0,       // held dive doubles downward accel (speed builder)

  // Swing: rigid-tether pendulum via velocity projection (the Fristrom
  // constraint method — constrain position to the tether sphere, re-derive
  // velocity from positions so it swings for free).
  TETHER_MIN: 8,             // shorter than this reads as a yank, not a swing
  // Pendulum half-period is pi*sqrt(L/g): at GRAV 22 a 45 m tether swings for
  // 2.8 s and a 24 m one for 2.1 s. "Hold to travel" floatiness IS the long
  // arc, so anchor selection targets IDEAL rather than taking the highest hit
  // it can find (which is monotonically the longest one).
  TETHER_MAX: 45,
  TETHER_IDEAL: 24,
  SWING_PUMP: 7.0,           // m/s² forward accel while holding swing at the
                             // arc bottom half — the "pumping your legs" energy
                             // input; 0 = pure pendulum (measurably duller)
  GROUND_CLEAR: 3.5,         // tether auto-shortens so the arc bottom clears
                             // the street by this much (the PS4 assist)
  SHORTEN_RATE: 18,          // m/s the tether reels toward its clearing length
  // Release timing is where ALL the skill lives. A flat bonus makes the
  // optimal play "hold the button"; a phase-dependent one makes it "let go
  // just past the bottom of the arc", which is the technique the games
  // actually reward. phi is the tether angle from straight down, signed by
  // direction of travel.
  RELEASE_BASE: 4.0,
  RELEASE_PEAK_LO: 0.09,     // rad (~5 deg)  window opens just past the bottom
  RELEASE_PEAK_HI: 0.61,     // rad (~35 deg) closes on the upswing
  RELEASE_MULT_MAX: 1.6,     // peak, around 18 deg
  RELEASE_MULT_MIN: 0.4,     // outside the window an early release COSTS speed

  // Force-release. A rigid tether with no stall guard lets the hero balance
  // motionless out at 90 degrees — the "standing on a stiff web" pose the
  // pendulum analyses all warn about.
  // Holding the button auto-releases at the forward apex, or the hero simply
  // orbits the anchor for several oscillations and makes no net progress
  // (measured: 4-6 s attached per swing, 180 m in 60 s). Deliberately set
  // PAST the reward window's peak, so a manual release timed to the peak
  // still beats holding — otherwise the optimal play is "hold the button".
  AUTO_RELEASE_PHI: 0.62,    // rad (~36 deg) on the upswing
  STALL_ANGLE: 1.36,         // rad (78 deg) from the anchor's down vector
  STALL_SPEED: 4.5,          // m/s while attached
  SWING_MAX_T: 3.2,          // s — no single swing outlasts this
  ANCHOR_MIN_UP: 6,          // an anchor must be at least this far above the hero
  ANCHOR_MAX: 55,            // anchor search ray length
  ASSIST_Y: 14,              // below this height with no wall hit, synthesize a
                             // high attach point (Insomniac's special anchor —
                             // never strand the player skimming the street)

  // Air control. Physics has nothing to say about steering in flight; it
  // "somehow feels right" (Fristrom) and every swing game ships it.
  AIR_STEER: 12,             // m/s² lateral authority in free fall
  SWING_STEER: 16,           // ...and while attached. The hero handles like "a
                             // floating drone attached to a rope" — near-full
                             // authority mid-arc is what stops a swing feeling
                             // like an on-rails animation.
  ZIP_BOOST: 14,             // web-zip impulse along facing (+ a little up)
  ZIP_UP: 4.5,
  ZIP_COOLDOWN: 0.55,        // zip is the connective tissue between arcs

  // Speed cap — soft, and set ABOVE the model's natural cruise so it only
  // catches the exceptional case. Measured over a 60 s held swing through the
  // seed-42 city: p50 53 m/s, p90 64, p99 66 — a pendulum's bottom-of-arc
  // speed is well above its average, so a cap at the median (52, where this
  // started) has drag fighting ordinary swinging on 45% of frames. A dive
  // slingshot from 190 m peaks at 77, which is what the drag is FOR.
  VMAX: 66,
  OVERSPEED_DRAG: 1.1,
  VHARD: 95,                 // hard sanity rail; the model should never reach it

  // Ground locomotion.
  RUN_V: 9,
  RUN_ACCEL: 30,
  GROUND_FRICTION: 10,       // exponential decay rate with no input
  JUMP_V: 9.5,
  CHARGE_JUMP_V: 16,         // held-crouch release (phase 2 wiring)

  // Wall run / crawl.
  WALLRUN_MIN_V: 5,          // slower than this against a wall = just falling
  WALLRUN_AUTO_V: 8,         // any wall contact above this becomes a wall run:
                             // a dead stop against a wall is the one outcome a
                             // traversal game must never produce
  WALLRUN_UP: 12,            // initial vertical speed running up a face
  WALLRUN_DECAY: 6,          // it bleeds off — you crest, then kick or fall
  WALLJUMP_KICK: 12,         // impulse along the wall normal on jump
  WALLJUMP_UP: 8,

  // Capsule.
  RADIUS: 0.4,
  HEIGHT: 1.7,               // foot-to-head; p is the FOOT position
};
