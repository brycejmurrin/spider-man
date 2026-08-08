/* Web-Slinger — the gameplay city: building OBB colliders + spatial hash +
   raycast/capsule queries. This persists exactly the record Apex 26's
   buildProps computed and threw away (its masses[] occupancy list, plus a
   height interval) — the exploration finding that made a swingable city cheap.

   Every query here is exact against oriented boxes. Coordinates: +Y up,
   metres. A building record is:
     { cx, cz, y0, y1, hw, hd, rot, kind }
   where rot is the yaw of the box's local +X (r) axis and hw/hd are the
   half-extents along local X/Z. All buildings live on flat ground (y0 = 0)
   in v1, but the y interval is kept so bridges/terraces can join later.

   Pure module — no renderer, no DOM. Unit-tested headless in Node. */

export function createColliders(opts) {
  const cell = (opts && opts.cell) || 48;   // XZ hash cell in metres
  const list = [];
  const grid = new Map();                   // "ix,iz" -> indices

  const key = (ix, iz) => ix + "," + iz;

  function add(b) {
    const i = list.length;
    // Cache the rotation basis once per building.
    b.cos = Math.cos(b.rot); b.sin = Math.sin(b.rot);
    list.push(b);
    // Insert into every cell the box's bounding circle touches.
    const rad = Math.hypot(b.hw, b.hd);
    const x0 = Math.floor((b.cx - rad) / cell), x1 = Math.floor((b.cx + rad) / cell);
    const z0 = Math.floor((b.cz - rad) / cell), z1 = Math.floor((b.cz + rad) / cell);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = key(ix, iz);
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(i);
    }
    return i;
  }

  // world -> box-local (XZ only)
  function toLocal(b, wx, wz, out) {
    const dx = wx - b.cx, dz = wz - b.cz;
    out[0] = dx * b.cos + dz * b.sin;
    out[1] = -dx * b.sin + dz * b.cos;
    return out;
  }

  const _l0 = [0, 0], _l1 = [0, 0];

  /* Segment vs one OBB (3D slab test in box space). Returns t in [0,1] or -1.
     nOut (len 3) receives the world-space hit normal. */
  function segBox(b, ox, oy, oz, dx, dy, dz, nOut) {
    toLocal(b, ox, oz, _l0);
    // rotate the direction into box space
    const ldx = dx * b.cos + dz * b.sin;
    const ldz = -dx * b.sin + dz * b.cos;
    let t0 = 0, t1 = 1, axis = -1, sign = 0;
    const test = (o, d, mn, mx, ax) => {
      if (Math.abs(d) < 1e-9) return o >= mn && o <= mx;
      let ta = (mn - o) / d, tb = (mx - o) / d, s = -1;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
      if (ta > t0) { t0 = ta; axis = ax; sign = d > 0 ? -1 : 1; }
      if (tb < t1) t1 = tb;
      return t0 <= t1;
    };
    if (!test(_l0[0], ldx, -b.hw, b.hw, 0)) return -1;
    if (!test(oy, dy, b.y0, b.y1, 1)) return -1;
    if (!test(_l0[1], ldz, -b.hd, b.hd, 2)) return -1;
    if (t0 <= 0 || t0 > 1) return -1;       // starts inside or beyond the segment
    if (nOut) {
      if (axis === 0) { nOut[0] = b.cos * sign; nOut[1] = 0; nOut[2] = b.sin * sign; }
      else if (axis === 1) { nOut[0] = 0; nOut[1] = sign; nOut[2] = 0; }
      else { nOut[0] = -b.sin * sign; nOut[1] = 0; nOut[2] = b.cos * sign; }
    }
    return t0;
  }

  const _cells = new Set();

  function cellsAlong(ox, oz, ex, ez, out) {
    out.clear();
    // conservative: every cell the segment's AABB touches (segments are short
    // relative to the world — a 60 m web ray spans at most a few cells)
    const x0 = Math.floor(Math.min(ox, ex) / cell), x1 = Math.floor(Math.max(ox, ex) / cell);
    const z0 = Math.floor(Math.min(oz, ez) / cell), z1 = Math.floor(Math.max(oz, ez) / cell);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const a = grid.get(key(ix, iz));
      if (a) for (const i of a) out.add(i);
    }
    return out;
  }

  const _n = [0, 0, 0];

  /* raycast(o, d, maxT) -> { t, x, y, z, nx, ny, nz, b } | null
     o: origin [x,y,z]; d: direction (NOT normalised — maxT scales it).
     The web-anchor, camera-clip and wall queries. */
  function raycast(o, d, maxT) {
    const ex = o[0] + d[0] * maxT, ey = o[1] + d[1] * maxT, ez = o[2] + d[2] * maxT;
    let best = Infinity, bestB = null;
    const bn = [0, 0, 0];
    for (const i of cellsAlong(o[0], o[2], ex, ez, _cells)) {
      const b = list[i];
      const t = segBox(b, o[0], o[1], o[2], d[0] * maxT, d[1] * maxT, d[2] * maxT, _n);
      if (t >= 0 && t < best) { best = t; bestB = b; bn[0] = _n[0]; bn[1] = _n[1]; bn[2] = _n[2]; }
    }
    if (!bestB) return null;
    const t = best * maxT;
    return { t, x: o[0] + d[0] * t, y: o[1] + d[1] * t, z: o[2] + d[2] * t,
             nx: bn[0], ny: bn[1], nz: bn[2], b: bestB };
  }

  /* sphereClip(p, r) -> { nx, ny, nz, depth, b } | null
     Deepest penetration of a sphere centre p radius r against the buildings.
     The capsule controller calls this at foot and head height and slides. */
  function sphereClip(p, r) {
    let worst = null, worstDepth = 0;
    const a = grid.get(key(Math.floor(p[0] / cell), Math.floor(p[2] / cell)));
    // check the 3x3 neighbourhood — r << cell
    for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
      const g = grid.get(key(Math.floor(p[0] / cell) + ix, Math.floor(p[2] / cell) + iz));
      if (!g) continue;
      for (const i of g) {
        const b = list[i];
        if (p[1] + r < b.y0 || p[1] - r > b.y1) continue;
        toLocal(b, p[0], p[2], _l0);
        const qx = Math.max(-b.hw, Math.min(b.hw, _l0[0]));
        const qz = Math.max(-b.hd, Math.min(b.hd, _l0[1]));
        const qy = Math.max(b.y0, Math.min(b.y1, p[1]));
        // world-space closest point
        const wx = b.cx + qx * b.cos - qz * b.sin;
        const wz = b.cz + qx * b.sin + qz * b.cos;
        const dx = p[0] - wx, dy = p[1] - qy, dz = p[2] - wz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2);
          let nx, ny, nz;
          if (d > 1e-6) { nx = dx / d; ny = dy / d; nz = dz / d; }
          else {
            // centre inside the box: push out along the shallowest face
            const px = b.hw - Math.abs(_l0[0]), pz = b.hd - Math.abs(_l0[1]), py = b.y1 - p[1];
            if (px < pz && px < py) { const s = _l0[0] > 0 ? 1 : -1; nx = b.cos * s; ny = 0; nz = b.sin * s; }
            else if (pz < py) { const s = _l0[1] > 0 ? 1 : -1; nx = -b.sin * s; ny = 0; nz = b.cos * s; }
            else { nx = 0; ny = 1; nz = 0; }
          }
          const depth = r - d;
          if (depth > worstDepth) { worstDepth = depth; worst = { nx, ny, nz, depth, b }; }
        }
      }
    }
    return worst;
  }

  /* roofAt(x, z, yFrom) -> { y, b } | null — the highest roof at (x,z) at or
     below yFrom. Landing/ground query for rooftops. */
  function roofAt(x, z, yFrom) {
    let best = null;
    const g = grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));
    if (g) for (const i of g) {
      const b = list[i];
      toLocal(b, x, z, _l0);
      if (Math.abs(_l0[0]) <= b.hw && Math.abs(_l0[1]) <= b.hd) {
        if (b.y1 <= yFrom + 0.01 && (!best || b.y1 > best.y)) best = { y: b.y1, b };
      }
    }
    return best;
  }

  // groundY: street level (flat world v1); roofs win where present.
  function groundY(x, z, yFrom) {
    const roof = roofAt(x, z, yFrom == null ? Infinity : yFrom);
    return roof ? roof.y : 0;
  }

  return {
    add, raycast, sphereClip, roofAt, groundY,
    list, cellSize: cell,
    stats() { return { buildings: list.length, cells: grid.size }; },
  };
}
