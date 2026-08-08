/* Web-Slinger — touch controls. Without these the game is unplayable on a
   phone: every action is a key, and iOS Safari has no keys.

   Three rules, each the fix for a way virtual controls usually break:

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

   No DOM at module eval — like input.js, everything wires inside create(), so
   the module stays importable in bare Node. */

/* Held state, read by input.js each frame. The stick is already normalised to
   the -1..1 the keyboard path produces, so the consumers below it need no
   knowledge of where the value came from. */
const state = {
  active: false,        // controls are mounted and visible
  moveX: 0, moveZ: 0,
  swing: false, dive: false,
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

export const Touch = {
  state,

  /* create(root, opts) — mounts the layer into `root` (the body) and returns
     true if it took. opts.force overrides device detection. */
  create(root, opts) {
    if (state.active) return true;
    if (!wantTouch(opts && opts.force)) return false;

    const layer = document.createElement("div");
    layer.id = "touch";
    layer.innerHTML =
      '<div id="t-stick"><div id="t-knob"></div></div>' +
      '<div id="t-btns">' +
      '<button id="t-zip" class="t-b" type="button">ZIP</button>' +
      '<button id="t-jump" class="t-b" type="button">JUMP</button>' +
      '<button id="t-dive" class="t-b" type="button">DIVE</button>' +
      '<button id="t-swing" class="t-b t-big" type="button">SWING</button>' +
      "</div>";
    root.appendChild(layer);

    const stick = layer.querySelector("#t-stick");
    const knob = layer.querySelector("#t-knob");

    // ── the stick ──────────────────────────────────────────────────────────
    // Origin is where the thumb LANDED, not the centre of the pad: a thumb
    // that lands off-centre would otherwise start the hero at a hard walk in
    // whatever direction the offset happened to be.
    let stickId = null, ox = 0, oy = 0;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };

    stick.addEventListener("pointerdown", (e) => {
      if (stickId != null) return;
      stickId = e.pointerId; ox = e.clientX; oy = e.clientY;
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
    };
    stick.addEventListener("pointerup", stickEnd);
    stick.addEventListener("pointercancel", stickEnd);
    stick.addEventListener("lostpointercapture", stickEnd);

    // ── the buttons ────────────────────────────────────────────────────────
    // A HOLD button owns its pointer for the same reason the stick does. An
    // EDGE button sets its latch on press and is consumed by the game loop.
    const hold = (el, key) => {
      let id = null;
      el.addEventListener("pointerdown", (e) => {
        if (id != null) return;
        id = e.pointerId; state[key] = true; el.classList.add("on");
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      const off = (e) => {
        if (e.pointerId !== id) return;
        id = null; state[key] = false; el.classList.remove("on");
      };
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
      el.addEventListener("lostpointercapture", off);
    };
    const edge = (el, key) => {
      el.addEventListener("pointerdown", (e) => {
        state[key] = true; el.classList.add("on");
        setTimeout(() => el.classList.remove("on"), 90);
        e.preventDefault();
      });
    };

    hold(layer.querySelector("#t-swing"), "swing");
    hold(layer.querySelector("#t-dive"), "dive");
    edge(layer.querySelector("#t-jump"), "jumpEdge");
    edge(layer.querySelector("#t-zip"), "zipEdge");

    // A pointer that never gets its pointerup — the app backgrounds mid-hold,
    // iOS steals the touch for the app switcher — would leave SWING stuck on
    // forever. Both of these fire in exactly that case.
    const releaseAll = () => {
      state.swing = state.dive = false;
      state.moveX = state.moveZ = 0; stickId = null; setKnob(0, 0);
      layer.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
    };
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });

    state.active = true;
    return true;
  },

  show(on) {
    const l = document.getElementById("touch");
    if (l) l.hidden = !on;
  },
};
