/* Apex 26 — TrackGraph: the scenery MODEL LIBRARY + NODE GRAPH.
 *
 * Why this exists
 * ---------------
 * buildProps emits every prop straight into one shared triangle soup, so the
 * cost of detail scales with the number of PLACEMENTS, not the number of
 * models. Spa places 1 788 pines, each a 126-vertex cone stack: ~225 k of its
 * 446 k prop vertices (~9 MB of VBO) are clones of one small model. Nothing
 * downstream can tell them apart either — the renderer sees anonymous triangles
 * and js/track/tracks.js keeps a PARALLEL note() registry purely so
 * __apex.scene() can name things.
 *
 * A model here is a list of PRIMITIVE OPS in canonical space (origin, identity
 * basis) — not baked vertices. Recording ops rather than triangles is what makes
 * the migration safe: replaying an op list through buildProps's own GUARDED
 * emitters reproduces the same on-track rejection decisions, the same absorb*
 * occupancy writes and the same geometry as the hand-written emitter did, so a
 * migrated helper is parity-checkable against the original.
 *
 * Each placement becomes a NODE: { model, origin, basis, scale, meta }. That is
 * the scene graph — the data an instanced renderer needs (one canonical mesh per
 * model + one transform per node) and the semantic record the agent view wants,
 * in one structure instead of two.
 *
 * Contract
 * --------
 *   const graph = TrackGraph.create({ raw });        // raw = UNGUARDED emitters
 *   graph.instance(key, place, build, meta)          // define-once + place
 *   graph.bake(emit)                                 // replay every node
 *   graph.batches()                                  // instanced-draw handoff
 *   graph.stats()                                    // reuse / vertex accounting
 *
 * `place` is { o:[x,y,z], r, u, t, s?:[sx,sy,sz] } — origin plus the track basis
 * the model is oriented into, plus an optional per-node scale applied in that
 * basis BEFORE the rotation. Scale is what lets one model serve placements that
 * differ only in size (a treeline's per-tree height jitter), instead of minting
 * a near-duplicate model per placement.
 *
 * Pure data + math. No renderer, no track state, no globals beyond the one it
 * assigns — loads under the bare VM sandbox of tools/verify-track.cjs.
 * Load order: before js/track/tracks.js.
 */
export const CityGraph = (function () {
  "use strict";

  // Op kinds mirror the guarded emitter surface in buildProps. Each carries its
  // centre in LOCAL space; sizes are local too and scale with the node.
  //   box/prism/pyramid : { c, sz }
  //   cyl/cone          : { c, rad, h, seg }
  //   frustum           : { c, rB, rT, h, seg }
  // `mat` is the MAT id in force for that op (out._mat at emission time).

  const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

  // Sentinel colour: "take this vertex colour from the NODE, not the model".
  // Emitters that vary only by tint — a city's window panes, each with its own
  // hash-jittered warm/neon colour — would otherwise mint a model per pane and
  // instance at 1.00x. With this they share one model and carry colour per
  // placement, which is exactly what a per-instance colour attribute is for.
  // The canonical mesh bakes these as white; the colour lives on the node.
  const NODE_COLOR = "@node";
  const WHITE = [1, 1, 1];
  const colourOf = (op, place) =>
    op.col === NODE_COLOR ? (place.col || WHITE) : op.col;

  // world = o + R * (local * scale), R the column basis [r,u,t].
  function xform(place, lc) {
    const s = place.s;
    const x = s ? lc[0] * s[0] : lc[0];
    const y = s ? lc[1] * s[1] : lc[1];
    const z = s ? lc[2] * s[2] : lc[2];
    const r = place.r, u = place.u, t = place.t, o = place.o;
    return [
      o[0] + r[0] * x + u[0] * y + t[0] * z,
      o[1] + r[1] * x + u[1] * y + t[1] * z,
      o[2] + r[2] * x + u[2] * y + t[2] * z,
    ];
  }

  // Radial ops (cyl/cone/frustum) are round in the local XZ plane, so a
  // non-uniform XZ scale would make them elliptical — which the primitive
  // emitters cannot express. Take the larger of the two so the guard footprint
  // is never UNDER-estimated (an under-estimate would let a prop reach tarmac).
  const radScale = (s) => (s ? Math.max(Math.abs(s[0]), Math.abs(s[2])) : 1);
  const upScale = (s) => (s ? Math.abs(s[1]) : 1);

  function create(ctx) {
    ctx = ctx || {};
    const raw = ctx.raw || null;

    const models = new Map();   // key -> { key, ops, geo, verts, aabb }
    const nodes = [];
    let dropped = 0;

    // ---- recorder: what a model's build(rec) function writes into ----
    function recorder(ops) {
      // undefined = "inherit whatever out._mat holds at replay time". out._mat is
      // a persistent register, so a helper that never sets it (marshalPost) must
      // keep inheriting; forcing 0 here would silently untexture those props.
      let mat;
      const push = (op) => { op.mat = mat; ops.push(op); return true; };
      return {
        // out._mat equivalent — stamps every op recorded after it
        mat(id) { mat = id || 0; },
        box: (c, sz, col) => push({ op: "box", c, sz, col }),
        prism: (c, sz, col) => push({ op: "prism", c, sz, col }),
        pyramid: (c, sz, col) => push({ op: "pyramid", c, sz, col }),
        cyl: (c, rad, h, col, seg) => push({ op: "cyl", c, rad, h, col, seg }),
        cone: (c, rad, h, col, seg) => push({ op: "cone", c, rad, h, col, seg }),
        frustum: (c, rB, rT, h, col, seg) => push({ op: "frustum", c, rB, rT, h, col, seg }),
      };
    }

    // ---- canonical mesh: replay a model's ops at origin with the RAW emitters ----
    // This is the buffer an instanced renderer uploads ONCE per model. It is also
    // how the model's vertex cost and AABB are measured — by construction rather
    // than by a per-primitive vertex-count formula that would drift from geom.js.
    function bakeCanonical(ops) {
      if (!raw) return null;
      const buf = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
      for (const op of ops) {
        buf._mat = op.mat || 0;
        const col = op.col === NODE_COLOR ? WHITE : op.col;
        switch (op.op) {
          case "box": raw.addBox(buf, op.c, op.sz, col, null); break;
          case "prism": raw.addPrism(buf, op.c, op.sz, col, null); break;
          case "pyramid": raw.addPyramid(buf, op.c, op.sz, col, null); break;
          case "cyl": raw.addCyl(buf, op.c, op.rad, op.h, col, op.seg, null); break;
          case "cone": raw.addCone(buf, op.c, op.rad, op.h, col, op.seg, null); break;
          case "frustum": raw.addFrustum(buf, op.c, op.rB, op.rT, op.h, col, op.seg, null); break;
        }
      }
      buf._mat = 0;
      return buf;
    }

    function aabbOf(geo) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      const p = geo && geo.pos;
      if (!p || !p.length) return { mn: [0, 0, 0], mx: [0, 0, 0] };
      for (let i = 0; i < p.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = p[i + a];
          if (v < mn[a]) mn[a] = v;
          if (v > mx[a]) mx[a] = v;
        }
      }
      return { mn, mx };
    }

    // Define a model once. `build(rec)` records ops in canonical space.
    //
    // The canonical mesh is built LAZILY. A shipping build never needs it — the
    // ops are replayed straight into the world — so the work only happens when
    // something actually asks: stats(), or an instanced renderer uploading one
    // mesh per model. It also keeps a plain build emitting EXACTLY the primitives
    // it ships, which matters because tools/float-audit.cjs wraps TrackGeom's
    // emitters and indexes them in emission order; a reference mesh baked through
    // those same wrappers is geometry that exists nowhere in the world.
    // Closure-scoped rather than `this`-relative so a destructured or spread model
    // record still resolves.
    function model(key, build) {
      let m = models.get(key);
      if (m) return m;
      const ops = [];
      build(recorder(ops));
      let geo, aabb;
      const meshOf = () => (geo === undefined ? (geo = bakeCanonical(ops)) : geo);
      m = {
        key, ops, uses: 0,
        // A radial op (cyl/cone/frustum) is round in the local XZ plane. Replay
        // sizes it with radScale() = max(|sx|,|sz|) because the primitive
        // emitters cannot make an ellipse — but an INSTANCE matrix scales x and z
        // independently, so under a non-uniform XZ scale the two paths disagree.
        // Flagged here so batches() can route those placements back to the bake.
        hasRadial: ops.some((o) => o.op === "cyl" || o.op === "cone" || o.op === "frustum"),
        // Whether the model's colour comes from the node (a per-instance colour
        // attribute) rather than the shared mesh.
        nodeColored: ops.some((o) => o.col === NODE_COLOR),
        get geo() { return meshOf(); },
        get aabb() { return aabb === undefined ? (aabb = aabbOf(meshOf())) : aabb; },
        get verts() { const g = meshOf(); return g ? g.pos.length / 3 : 0; },
      };
      models.set(key, m);
      return m;
    }

    // Replay one model into the world through the caller's emitters. `emit` is
    // the GUARDED emitter set, so every op is on-track tested exactly as the
    // hand-written helper's own call was. Returns the number of ops that
    // actually landed — 0 means the whole placement was suppressed.
    function replay(m, place, emit, out) {
      const s = place.s;
      const rs = radScale(s), us = upScale(s);
      const basis = [place.r, place.u, place.t];
      let landed = 0;
      // Deliberately does NOT save/restore out._mat: the register's trailing state
      // is the migrated helper's business, exactly as it was when it emitted
      // inline (pine ends on 0; marshalPost never touches it).
      for (const op of m.ops) {
        const c = xform(place, op.c);
        if (op.mat !== undefined) out._mat = op.mat;
        const col = colourOf(op, place);
        let ok = false;
        switch (op.op) {
          case "box":
          case "prism":
          case "pyramid": {
            const sz = s ? [op.sz[0] * Math.abs(s[0]), op.sz[1] * Math.abs(s[1]), op.sz[2] * Math.abs(s[2])] : op.sz;
            ok = op.op === "box" ? emit.addBox(out, c, sz, col, basis)
              : op.op === "prism" ? emit.addPrism(out, c, sz, col, basis)
                : emit.addPyramid(out, c, sz, col, basis);
            break;
          }
          case "cyl": ok = emit.addCyl(out, c, op.rad * rs, op.h * us, col, op.seg, basis); break;
          case "cone": ok = emit.addCone(out, c, op.rad * rs, op.h * us, col, op.seg, basis); break;
          case "frustum": ok = emit.addFrustum(out, c, op.rB * rs, op.rT * rs, op.h * us, col, op.seg, basis); break;
        }
        // RAW Geom emitters return undefined (only GUARDED emitters return a
        // verdict); count anything but an explicit false as landed, or every
        // raw replay records zero nodes and batches() goes empty.
        if (ok !== false) landed++;
      }
      return landed;
    }

    // Define-once + place. `meta` is the semantic record (kind, k, side, …) that
    // makes the node answerable by the agent view.
    function instance(key, place, build, meta, emit, out) {
      if (!place || !isVec3(place.o) || !isVec3(place.r) || !isVec3(place.u) || !isVec3(place.t)) {
        dropped++;
        return 0;
      }
      const m = model(key, build);
      if (!m.ops.length) { dropped++; return 0; }
      const landed = emit ? replay(m, place, emit, out) : 0;
      if (landed) {
        m.uses++;
        nodes.push({
          model: key,
          o: place.o, r: place.r, u: place.u, t: place.t,
          s: place.s || null,
          col: place.col || null,
          landed,
          // A placement whose ops were only PARTLY suppressed does not equal its
          // model: drawing the whole mesh at this transform would put back the
          // primitives the guard removed. batches() keeps these out.
          full: landed === m.ops.length,
          meta: meta || null,
        });
      }
      return landed;
    }

    // Replay every node — the S2 bake path. Reproduces the soup from the graph
    // alone, which is what proves the graph is a complete description of the
    // scenery rather than a side-channel that happens to agree.
    function bake(emit, out) {
      let landed = 0;
      for (const node of nodes) {
        const m = models.get(node.model);
        if (!m) continue;
        landed += replay(m, node, emit, out);
      }
      return landed;
    }

    // ---- the instanced-draw handoff ----
    // One producer, any number of backend consumers. GLX wants a per-instance
    // mat4 in attributes 5-8 via vertexAttribDivisor; three.js wants the same
    // matrices in an InstancedMesh; neither should have to know how a node is
    // stored. So this emits plain typed arrays and nothing else.
    //
    // Matrices are COLUMN-MAJOR, the layout both GLX's M4 and THREE.Matrix4 use:
    // columns 0-2 are the (scaled) basis vectors r/u/t, column 3 the origin.
    // That is exactly xform()'s world = o + R*(local*s), so an instanced draw of
    // `geo` under this matrix reproduces what replay() emitted.
    //
    // Two classes of node CANNOT be instanced and are returned separately rather
    // than silently mis-drawn:
    //   * partially suppressed placements (see node.full), and
    //   * radial geometry under a non-uniform XZ scale (see model.hasRadial) —
    //     replay makes those round via max(|sx|,|sz|), an instance matrix would
    //     make them elliptical.
    // The caller bakes that remainder. `bake()` already does exactly that.
    function batches() {
      const byModel = new Map();
      const bakeOnly = [];
      for (const node of nodes) {
        const m = models.get(node.model);
        if (!m) continue;
        const s = node.s;
        const nonUniformXZ = !!s && Math.abs(Math.abs(s[0]) - Math.abs(s[2])) > 1e-9;
        if (!node.full || (m.hasRadial && nonUniformXZ)) { bakeOnly.push(node); continue; }
        let list = byModel.get(node.model);
        if (!list) byModel.set(node.model, (list = []));
        list.push(node);
      }

      const out = [];
      for (const [key, list] of byModel) {
        const m = models.get(key);
        const count = list.length;
        const matrices = new Float32Array(count * 16);
        const colors = m.nodeColored ? new Float32Array(count * 3) : null;
        for (let i = 0; i < count; i++) {
          const n = list[i], o = n.o, r = n.r, u = n.u, t = n.t, s = n.s;
          const sx = s ? s[0] : 1, sy = s ? s[1] : 1, sz = s ? s[2] : 1;
          const b = i * 16;
          matrices[b]      = r[0] * sx; matrices[b + 1]  = r[1] * sx; matrices[b + 2]  = r[2] * sx;
          matrices[b + 4]  = u[0] * sy; matrices[b + 5]  = u[1] * sy; matrices[b + 6]  = u[2] * sy;
          matrices[b + 8]  = t[0] * sz; matrices[b + 9]  = t[1] * sz; matrices[b + 10] = t[2] * sz;
          matrices[b + 12] = o[0];      matrices[b + 13] = o[1];      matrices[b + 14] = o[2];
          matrices[b + 15] = 1;
          if (colors) {
            const c = n.col || WHITE;
            colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
          }
        }
        out.push({ model: key, geo: m.geo, verts: m.verts, count, matrices, colors });
      }
      // Deterministic order: a backend uploading these must not have its draw
      // list reshuffle between builds of the same track.
      out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
      return { batches: out, bakeOnly };
    }

    // The number this whole exercise turns on: instanced cost vs fused cost.
    // byKind is the actionable half — a migrated emitter whose reuse sits at 1.00
    // is one whose parameters are continuous (or affine in a scale it cannot
    // factor out), and is therefore a re-parameterisation candidate rather than
    // an instancing win. That distinction is invisible without this breakdown.
    function stats() {
      let unique = 0, fused = 0;
      for (const m of models.values()) {
        unique += m.verts;
        fused += m.verts * m.uses;
      }
      const byKind = {};
      const seen = new Map();   // kind -> Set of model keys
      for (const node of nodes) {
        const kind = (node.meta && node.meta.kind) || "(unkeyed)";
        const m = models.get(node.model);
        if (!m) continue;
        let e = byKind[kind];
        if (!e) { e = byKind[kind] = { nodes: 0, models: 0, fusedVerts: 0, uniqueVerts: 0, reuse: 0 }; seen.set(kind, new Set()); }
        e.nodes++;
        e.fusedVerts += m.verts;
        const set = seen.get(kind);
        if (!set.has(node.model)) { set.add(node.model); e.models++; e.uniqueVerts += m.verts; }
      }
      for (const kind in byKind) {
        const e = byKind[kind];
        e.reuse = e.uniqueVerts > 0 ? e.fusedVerts / e.uniqueVerts : 0;
      }
      return {
        models: models.size,
        nodes: nodes.length,
        dropped,
        uniqueVerts: unique,          // what an instanced renderer uploads
        fusedVerts: fused,            // what the soup costs today
        reuse: unique > 0 ? fused / unique : 0,
        byKind,
      };
    }

    return { models, nodes, model, instance, replay, bake, batches, stats };
  }

  return { create, xform, NODE_COLOR };
})();
