/* Web-Slinger — the active webline: a thin tapered ribbon from the hero's
   wrist to the anchor, rebuilt into one small mesh whenever attached (the
   skidmarks pattern: bake world-space quads, one draw). Camera-facing ribbon
   (two crossed strips) so it reads from any angle without a tube's cost. */
import { Geom } from "../city/geom.js";

export function createWebline(gfx) {
  let mesh = null;

  function free() { if (mesh) { gfx.freeMesh(mesh); mesh = null; } }

  /* rebuild(from[3], to[3]) — a slightly sagging 8-segment ribbon. */
  function rebuild(from, to) {
    free();
    const out = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
    const N = 8;
    const col = [0.92, 0.92, 0.96];
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    // two perpendicular thin strips (a "+" cross-section)
    let ux = -dz / len, uz = dx / len;                      // horizontal perp
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N;
      const sag = (t) => Math.sin(t * Math.PI) * len * 0.006;
      const w = (t) => 0.05 - t * 0.028;                    // tapers toward anchor
      for (const [t, tn] of [[t0, t1]]) {
        const ax = from[0] + dx * t, ay = from[1] + dy * t - sag(t), az = from[2] + dz * t;
        const bx = from[0] + dx * tn, by = from[1] + dy * tn - sag(tn), bz = from[2] + dz * tn;
        const wa = w(t), wb = w(tn);
        // strip 1: horizontal offset; strip 2: vertical offset
        Geom.emit(out, [
          [ax - ux * wa, ay, az - uz * wa], [ax + ux * wa, ay, az + uz * wa],
          [bx + ux * wb, by, bz + uz * wb], [bx - ux * wb, by, bz - uz * wb],
        ], col, [ax, ay - 5, az]);
        Geom.emit(out, [
          [ax, ay - wa, az], [ax, ay + wa, az],
          [bx, by + wb, bz], [bx, by - wb, bz],
        ], col, [ax - ux * 5, ay, az - uz * 5]);
      }
    }
    mesh = gfx.createMesh(out);
  }

  return {
    rebuild, free,
    draw(ident) { if (mesh) gfx.draw(mesh, ident, { emissive: 0.25, doubleSided: true, roughness: 0.9 }); },
    get active() { return !!mesh; },
  };
}
