/* Web-Slinger — input: keyboard + mouse-look + gamepad basics. A compact v1
   of Apex 26's input.js keeping its load-bearing shapes: no DOM access at
   module eval (everything wires inside init(), so the module imports headless),
   consume-once edge latches, and a poll() the loop calls once per frame.
   Touch lives in ./touch.js and merges in through the same accessors; tilt
   and One-Euro filtering are still Phase 2. */
import { Touch } from "./touch.js";

const keys = new Set();
let lookDX = 0, lookDY = 0;            // consumed mouse deltas (camera orbit)
let jumpEdge = false, zipEdge = false, camEdge = false;
let pad = null, padPrev = [];
let canvasEl = null, onPauseCb = null, onMusicCb = null, onNextCb = null;

export const Input = {
  init(canvas, opts) {
    canvasEl = canvas;
    onPauseCb = opts && opts.onPause;
    onMusicCb = opts && opts.onMusicToggle;
    onNextCb = opts && opts.onNextTrack;
    window.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
      if (e.repeat) { keys.add(e.code); return; }
      keys.add(e.code);
      if (e.code === "Space") { /* hold = swing; edge also queues jump-at-release logic in hero */ }
      if (e.code === "ShiftLeft" || e.code === "KeyJ") jumpEdge = true;
      if (e.code === "KeyE" || e.code === "KeyK") zipEdge = true;
      if (e.code === "KeyC") camEdge = true;
      if (e.code === "Escape" && onPauseCb) onPauseCb();
      if (e.code === "KeyM" && onMusicCb) onMusicCb();
      if (e.code === "KeyN" && onNextCb) onNextCb();
      if (["Space", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => keys.delete(e.code));
    window.addEventListener("blur", () => keys.clear());
    // pointer-drag look (hold left button); pointer-id scoped like Apex 26's
    // photo cam so a second finger lifting can't kill the drag
    let dragId = null, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", (e) => {
      if (dragId != null) return;
      dragId = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== dragId) return;
      lookDX += e.clientX - lx; lookDY += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
    });
    const end = (e) => { if (e.pointerId === dragId) dragId = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("lostpointercapture", end);
    window.addEventListener("gamepadconnected", (e) => { pad = e.gamepad.index; });
    // Mounted on the body, not the canvas: the canvas is the look-drag
    // surface, and a child of it would swallow the drags it is meant to leave
    // alone. opts.forceTouch is the desktop/test override.
    Touch.create(document.body, { force: opts && opts.forceTouch });
  },

  get touchActive() { return Touch.state.active; },

  poll() {
    if (pad == null) return;
    const g = navigator.getGamepads && navigator.getGamepads()[pad];
    if (!g) return;
    const edge = (i) => { const now = g.buttons[i] && g.buttons[i].pressed; const was = padPrev[i]; padPrev[i] = now; return now && !was; };
    if (edge(0)) jumpEdge = true;      // A
    if (edge(1) || edge(4)) zipEdge = true;   // B / LB
    if (edge(3)) camEdge = true;       // Y
    padPrev.length = g.buttons.length;
    for (let i = 0; i < g.buttons.length; i++) padPrev[i] = g.buttons[i].pressed;
  },

  // continuous
  // Every source is merged the same way: the LAST source to hold a non-zero
  // value wins, so a plugged-in gamepad does not veto the thumbstick and vice
  // versa. Zero from an idle source never overwrites a live one.
  moveX() {   // -1..1 strafe (A/D)
    let v = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    if (g && Math.abs(g.axes[0]) > 0.15) v = g.axes[0];
    if (Touch.state.moveX) v = Touch.state.moveX;
    return v;
  },
  moveZ() {   // -1..1 forward (W/S; +1 = forward)
    let v = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    if (g && Math.abs(g.axes[1]) > 0.15) v = -g.axes[1];
    if (Touch.state.moveZ) v = Touch.state.moveZ;
    return v;
  },
  swing() {
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    return keys.has("Space") || Touch.state.swing || !!(g && g.buttons[7] && g.buttons[7].pressed);   // RT
  },
  dive() {
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    return keys.has("ControlLeft") || keys.has("KeyX") || Touch.state.dive ||
      !!(g && g.buttons[6] && g.buttons[6].pressed);
  },
  look() {    // consumed mouse/touch/right-stick deltas
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    let dx = lookDX, dy = lookDY;
    lookDX = 0; lookDY = 0;
    // Touch drains the same way the mouse does: accumulate in the handler,
    // zero on read. A phone has no second stick, so this is the ONLY camera
    // input it has — it comes from a slide on the held SWING zone.
    dx += Touch.state.lookDX; dy += Touch.state.lookDY;
    Touch.state.lookDX = Touch.state.lookDY = 0;
    if (g) { if (Math.abs(g.axes[2]) > 0.15) dx += g.axes[2] * 6; if (Math.abs(g.axes[3]) > 0.15) dy += g.axes[3] * 6; }
    return [dx, dy];
  },
  /* Is a look pointer down right now? The camera's auto-recentre has to yield
     while the player is deliberately framing, and it cannot infer that from
     the deltas alone: a thumb holding a steady offset produces no deltas at
     all, which is indistinguishable from nobody touching the glass. */
  lookHeld() { return Touch.state.lookHeld; },
  /* The undrained touch look accumulator. Read-only — look() is the consuming
     read. Exists so the dead zone is observable without a rendered frame. */
  lookRaw() { return [Touch.state.lookDX, Touch.state.lookDY]; },

  // consume-once edges — a touch latch is consumed here too, so a tap that
  // lands between two frames is never dropped and never fires twice.
  consumeJump() { const v = jumpEdge || Touch.state.jumpEdge; jumpEdge = Touch.state.jumpEdge = false; return v; },
  consumeZip() { const v = zipEdge || Touch.state.zipEdge; zipEdge = Touch.state.zipEdge = false; return v; },
  consumeCameraCycle() { const v = camEdge || Touch.state.camEdge; camEdge = Touch.state.camEdge = false; return v; },
  clearEdges() {
    jumpEdge = zipEdge = camEdge = false;
    Touch.state.jumpEdge = Touch.state.zipEdge = Touch.state.camEdge = false;
  },
};
