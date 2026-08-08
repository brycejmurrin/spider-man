/* Web-Slinger — touch controls. Without these the game is unplayable on a
   phone: every action is a key, and iOS Safari has no keys.

   Four rules, each the fix for a way virtual controls usually break:

   1. EVERY control tracks its own pointerId. A phone hand is three or four
      simultaneous pointers — thumb on the stick, thumb on SWING, a palm
      touching the glass — and a control that stores "is pressed" as a boolean
      is released by whichever pointer happens to lift first. Holding SWING
      while steering is the core of the game, so this is not an edge case.

   2. The controls are DOM elements ABOVE the canvas, so look-drag needs no
      hit-testing: a pointer that reaches the canvas is by definition not on a
      control. Trying to exclude button rectangles in canvas coordinates is the
      same logic maintained twice, and it goes stale the first time the layout
      moves.

   3. `touch-action: none` on the controls, not on the document. The menu
      screens must still scroll on a small phone, and a blanket
      `touch-action: none` kills that too.

   4. THE CONTROLS ARE ZONES, NOT BUTTONS, AND SWING ALSO CARRIES THE CAMERA.
      Rule 2 has a consequence nobody had traced: both thumbs are on controls,
      the controls are above the canvas, and the only source feeding
      `Input.look()` was a pointer drag ON the canvas — so on a phone there was
      no camera input at all, at any time. The player could only steer
      indirectly, by pushing the stick and waiting for the auto-recentre to
      swing the view round behind the new velocity.

      The answer shipped mobile games converged on is one dual-purpose control
      (Wild Rift's ability buttons, Diablo Immortal's skills): press = the
      action, slide past a dead zone = the camera, lift = release. So each half
      of the screen is one big invisible zone with the visible ring/pill drawn
      as a child, and a slide on the SWING zone moves the camera WITHOUT ever
      clearing the hold. The dead zone is what stops a thumb that rolls on
      press from yanking the view.

   No DOM at module eval — like input.js, everything wires inside create(), so
   the module stays importable in bare Node. */

/* Held state, read by input.js each frame. The stick is already normalised to
   the -1..1 the keyboard path produces, so the consumers below it need no
   knowledge of where the value came from. lookDX/lookDY are ACCUMULATED pixel
   deltas drained by Input.look(), exactly like the mouse path's. */
const state = {
  active: false,        // controls are mounted and visible
  moveX: 0, moveZ: 0,
  swing: false, dive: false,
  lookDX: 0, lookDY: 0, lookHeld: false,
  jumpEdge: false, zipEdge: false, camEdge: false,
};

/* Coarse pointer OR no hover: the pair that distinguishes a phone/tablet from
   a laptop with a touchscreen, which should keep the keyboard. `spidey.touch`
   forces it either way — the only way to exercise this on a desktop browser,
   and how the spec drives it. */
function wantTouch(forced) {
  if (forced === true || forced === false) return forced;
  try {
    if (navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches) return true;
  } catch (_) {}
  return false;
}

const STICK_R = 52;      // px from stick centre for full deflection
const DEAD = 0.16;       // fraction of STICK_R ignored, so a resting thumb is neutral
/* px of accumulated travel before a press on the SWING zone starts steering the
   camera. A thumb rolls a few px as it presses, and without this every swing
   would come with a small involuntary camera yank. Wild Rift ships this as a
   player-tunable slider and describes it in exactly those terms; 24 px is a
   starting value, not a measured one. */
const LOOK_DEAD = 24;

/* The Fullscreen API was removed from iPhone entirely (iPadOS keeps a prefixed
   version), so a browser tab cannot hide the address bar and cannot stop
   Safari's edge-swipe-back from competing with the right-hand SWING zone.
   Installing to the Home Screen is the only mechanism that fixes both, and the
   shell already ships the manifest and apple-mobile-web-app-capable — so this
   is the largest free win available on the platform and it costs a hint.
   Suppressed once dismissed, and never shown when already standalone. */
function offerInstall() {
  const el = document.getElementById("a2hs");
  if (!el) return;
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  // iOS Safari only: no other browser has this failure, and Chrome/Android has
  // a real install prompt rather than a Share-sheet ritual to describe.
  const ios = /iP(hone|ad|od)/.test(navigator.platform || "") ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ""));
  let hidden = false;
  try { hidden = localStorage.getItem("spidey.a2hs") === "off"; } catch (_) {}
  if (standalone || !ios || hidden) return;
  el.hidden = false;
  const x = document.getElementById("a2hs-x");
  if (x) x.addEventListener("click", () => {
    el.hidden = true;
    try { localStorage.setItem("spidey.a2hs", "off"); } catch (_) {}
  });
}

export const Touch = {
  state,

  /* create(root, opts) — mounts the layer into `root` (the body) and returns
     true if it took. opts.force overrides device detection. */
  create(root, opts) {
    if (state.active) return true;
    if (!wantTouch(opts && opts.force)) return false;

    const layer = document.createElement("div");
    layer.id = "touch";
    // #t-btns is LAST on purpose: it overlaps the SWING zone, and in the same
    // stacking context the later sibling wins the hit test. A press on ZIP is
    // a zip, not a swing, and no hit-test exclusion is written anywhere.
    layer.innerHTML =
      '<div id="t-stick"><div id="t-ring"><div id="t-knob"></div></div></div>' +
      '<div id="t-swing"><div class="t-pill">SWING</div></div>' +
      '<div id="t-btns">' +
      '<button id="t-zip" class="t-b" type="button">ZIP</button>' +
      '<button id="t-jump" class="t-b" type="button">JUMP</button>' +
      '<button id="t-dive" class="t-b" type="button">DIVE</button>' +
      "</div>";
    root.appendChild(layer);

    const stick = layer.querySelector("#t-stick");
    const ring = layer.querySelector("#t-ring");
    const knob = layer.querySelector("#t-knob");

    // ── the stick ──────────────────────────────────────────────────────────
    // Origin is where the thumb LANDED, not the centre of the pad: a thumb
    // that lands off-centre would otherwise start the hero at a hard walk in
    // whatever direction the offset happened to be. Now that the pad is the
    // whole left half, the visible ring MOVES to the landing point too —
    // otherwise the thumb and the thing it is apparently pushing are metres
    // apart on screen.
    let stickId = null, ox = 0, oy = 0;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };

    stick.addEventListener("pointerdown", (e) => {
      if (stickId != null) return;
      stickId = e.pointerId; ox = e.clientX; oy = e.clientY;
      // The layer is position:fixed inset:0, so client coords ARE layer coords.
      ring.style.left = `${e.clientX}px`; ring.style.top = `${e.clientY}px`;
      ring.classList.add("on");
      try { stick.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    stick.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickId) return;
      let dx = (e.clientX - ox) / STICK_R, dy = (e.clientY - oy) / STICK_R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      state.moveX = Math.abs(dx) < DEAD ? 0 : dx;
      state.moveZ = Math.abs(dy) < DEAD ? 0 : -dy;    // screen +y is down; +Z is forward
      setKnob(dx * STICK_R, dy * STICK_R);
      e.preventDefault();
    });
    const stickEnd = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null; state.moveX = 0; state.moveZ = 0; setKnob(0, 0);
      ring.classList.remove("on");
    };
    stick.addEventListener("pointerup", stickEnd);
    stick.addEventListener("pointercancel", stickEnd);
    stick.addEventListener("lostpointercapture", stickEnd);

    // ── the buttons ────────────────────────────────────────────────────────
    // A HOLD button owns its pointer for the same reason the stick does. An
    // EDGE button sets its latch on press and is consumed by the game loop.
    const holds = [];                 // every hold button, for the safety nets
    /* hold(el, key, look) — press-and-hold. `look` makes it dual-purpose: the
       same press also steers the camera once the thumb has travelled past
       LOOK_DEAD, and the hold is never cleared by movement. */
    const hold = (el, key, look) => {
      let id = null, lx = 0, ly = 0, travel = 0;
      el.addEventListener("pointerdown", (e) => {
        if (id != null) return;
        id = e.pointerId; state[key] = true; el.classList.add("on");
        lx = e.clientX; ly = e.clientY; travel = 0;
        if (look) state.lookHeld = true;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      if (look) {
        el.addEventListener("pointermove", (e) => {
          if (e.pointerId !== id) return;
          const dx = e.clientX - lx, dy = e.clientY - ly;
          lx = e.clientX; ly = e.clientY;
          travel += Math.hypot(dx, dy);
          // Note what is NOT here: any clearing of state[key]. A slide is a
          // look, not a cancel — the player is holding a swing and framing it.
          if (travel >= LOOK_DEAD) { state.lookDX += dx; state.lookDY += dy; }
          e.preventDefault();
        });
      }
      // Total and idempotent on purpose. This used to early-return when `id`
      // was already null, which read as harmless and was not: releaseAll()
      // below cleared `state` but could not reach this closure's `id`, so
      // after a blur / app-switch / touchcancel the id stayed at the stale
      // pointer forever, `pointerdown`'s `if (id != null) return` rejected
      // EVERY later press, and SWING was dead until a page reload. iOS never
      // reuses pointerIds, so nothing could ever clear it. releaseAll now
      // calls this, and this now always clears.
      const release = () => {
        id = null; state[key] = false; el.classList.remove("on");
        if (look) state.lookHeld = false;
      };
      const off = (e) => { if (e.pointerId === id) release(); };
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
      el.addEventListener("lostpointercapture", off);
      holds.push({ has: (pid) => id === pid, release });
    };
    const edge = (el, key) => {
      el.addEventListener("pointerdown", (e) => {
        state[key] = true; el.classList.add("on");
        setTimeout(() => el.classList.remove("on"), 90);
        e.preventDefault();
      });
    };

    hold(layer.querySelector("#t-swing"), "swing", true);
    hold(layer.querySelector("#t-dive"), "dive");
    edge(layer.querySelector("#t-jump"), "jumpEdge");
    edge(layer.querySelector("#t-zip"), "zipEdge");

    // ── the release nets ───────────────────────────────────────────────────
    // A held button that never sees its pointerup stays held forever, and the
    // held buttons here are SWING and DIVE — a stuck SWING IS the game. One
    // net is not enough, and each of these covers a case the others cannot.
    // Ported from Apex 26's input.js, which found them the hard way.
    const releaseAll = () => {
      // Through the closures, NOT around them — see the note on release().
      for (const h of holds) h.release();
      state.moveX = state.moveZ = 0; stickId = null; setKnob(0, 0);
      state.lookDX = state.lookDY = 0; state.lookHeld = false;
      layer.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
    };

    // #1 — window-level, CAPTURE phase: a pointer that lifts or cancels
    // anywhere on the page releases the button holding it, even when the
    // button element itself never receives the event. Capture phase so an
    // overlay or a stopPropagation between here and the button cannot swallow
    // it. This matters most when setPointerCapture threw (it is inside a
    // try/catch), because then nothing redirects the lift back to the element.
    const releasePointer = (e) => {
      for (const h of holds) if (h.has(e.pointerId)) h.release();
    };
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);

    // #4 — and this is the one that actually saves you, because it is the only
    // net not built on pointer events. WebKit under heavy multi-touch drops a
    // pointerup outright while still delivering the touch-event lift, and iOS
    // never reuses pointerIds — so the ghost id is PERMANENT and a fresh
    // press-and-release cannot clear it. Apex 26 shipped this after a player
    // reported a throttle that stayed on no matter what they pressed.
    // TouchEvent.touches is ground truth the pointer stream cannot contradict:
    // zero touches on the glass means nothing is held, whatever the pointer
    // bookkeeping believes. A finger still down keeps touches.length > 0, so a
    // legitimate hold survives.
    window.addEventListener("touchend", (e) => { if (e.touches.length === 0) releaseAll(); }, true);
    window.addEventListener("touchcancel", (e) => { if (e.touches.length === 0) releaseAll(); }, true);

    // #3 — the app backgrounds mid-hold and iOS steals the touch for the app
    // switcher, so no lift of any kind is ever delivered.
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });

    state.active = true;
    offerInstall();
    return true;
  },

  show(on) {
    const l = document.getElementById("touch");
    if (l) l.hidden = !on;
  },
};
