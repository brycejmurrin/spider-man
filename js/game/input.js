/* Web-Slinger — input: keyboard + mouse-look + gamepad basics. A compact v1
   of Apex 26's input.js keeping its load-bearing shapes: no DOM access at
   module eval (everything wires inside init(), so the module imports headless),
   consume-once edge latches, and a poll() the loop calls once per frame.
   The full multi-source port (touch sticks, tilt, One-Euro) is Phase 2. */

const keys = new Set();
let lookDX = 0, lookDY = 0;            // consumed mouse deltas (camera orbit)
let jumpEdge = false, zipEdge = false, camEdge = false;
let pad = null, padPrev = [];
let canvasEl = null, onPauseCb = null;

export const Input = {
  init(canvas, opts) {
    canvasEl = canvas;
    onPauseCb = opts && opts.onPause;
    window.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
      if (e.repeat) { keys.add(e.code); return; }
      keys.add(e.code);
      if (e.code === "Space") { /* hold = swing; edge also queues jump-at-release logic in hero */ }
      if (e.code === "ShiftLeft" || e.code === "KeyJ") jumpEdge = true;
      if (e.code === "KeyE" || e.code === "KeyK") zipEdge = true;
      if (e.code === "KeyC") camEdge = true;
      if (e.code === "Escape" && onPauseCb) onPauseCb();
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
  },

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
  moveX() {   // -1..1 strafe (A/D)
    let v = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    if (g && Math.abs(g.axes[0]) > 0.15) v = g.axes[0];
    return v;
  },
  moveZ() {   // -1..1 forward (W/S; +1 = forward)
    let v = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    if (g && Math.abs(g.axes[1]) > 0.15) v = -g.axes[1];
    return v;
  },
  swing() {
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    return keys.has("Space") || !!(g && g.buttons[7] && g.buttons[7].pressed);   // RT
  },
  dive() {
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    return keys.has("ControlLeft") || keys.has("KeyX") || !!(g && g.buttons[6] && g.buttons[6].pressed);
  },
  look() {    // consumed mouse/right-stick deltas
    const g = pad != null && navigator.getGamepads && navigator.getGamepads()[pad];
    let dx = lookDX, dy = lookDY;
    lookDX = 0; lookDY = 0;
    if (g) { if (Math.abs(g.axes[2]) > 0.15) dx += g.axes[2] * 6; if (Math.abs(g.axes[3]) > 0.15) dy += g.axes[3] * 6; }
    return [dx, dy];
  },

  // consume-once edges
  consumeJump() { const v = jumpEdge; jumpEdge = false; return v; },
  consumeZip() { const v = zipEdge; zipEdge = false; return v; },
  consumeCameraCycle() { const v = camEdge; camEdge = false; return v; },
  clearEdges() { jumpEdge = zipEdge = camEdge = false; },
};
