/*
 * Apex 26 — GLX chunked-mesh subsystem (split out of js/render/glx.js).
 * Frustum-culled chunked meshes for the heavy city/props geometry: one shared
 * VBO/VAO with one index buffer per spatial XZ cell, drawn (or shadow-cast)
 * only when the cell's AABB survives the active frustum. Wired through the
 * GLXCore ctx: glx.js calls GLXChunked.init(core) inside GLX.init() and
 * delegates createChunkedMesh/drawChunked/castShadowChunked/freeChunkedMesh.
 * Must load before js/render/glx.js (glx.js calls GLXChunked.init at init time).
 */
"use strict";

export const GLXChunked = (function () {

  function init(core) {
    const gl = core.gl;
    const { bindVAO, setBlend, setDepthMask, toF32, createMesh, litMaterial } = core;
    const F = core.frame;

    // Gribb–Hartmann plane extraction from a COLUMN-MAJOR view-proj (m[col*4+row]).
    // Planes are [a,b,c,d], inside = a*x+b*y+c*z+d >= 0. Scratch is module-static so
    // culling allocates nothing per frame.
    const _fcPlanes = [new Float32Array(4), new Float32Array(4), new Float32Array(4),
                       new Float32Array(4), new Float32Array(4), new Float32Array(4)];
    function _setPlane(p, a, b, c, d) {
      const inv = 1 / (Math.hypot(a, b, c) || 1);
      p[0] = a * inv; p[1] = b * inv; p[2] = c * inv; p[3] = d * inv;
    }
    function _extractPlanes(m, planes) {
      const m0=m[0],m4=m[4],m8=m[8],m12=m[12], m1=m[1],m5=m[5],m9=m[9],m13=m[13],
            m2=m[2],m6=m[6],m10=m[10],m14=m[14], m3=m[3],m7=m[7],m11=m[11],m15=m[15];
      _setPlane(planes[0], m3+m0, m7+m4, m11+m8,  m15+m12); // left
      _setPlane(planes[1], m3-m0, m7-m4, m11-m8,  m15-m12); // right
      _setPlane(planes[2], m3+m1, m7+m5, m11+m9,  m15+m13); // bottom
      _setPlane(planes[3], m3-m1, m7-m5, m11-m9,  m15-m13); // top
      _setPlane(planes[4], m3+m2, m7+m6, m11+m10, m15+m14); // near
      _setPlane(planes[5], m3-m2, m7-m6, m11-m10, m15-m14); // far
    }
    // AABB vs frustum via the box's most-positive vertex per plane (conservative).
    function _aabbInFrustum(planes, mn, mx) {
      for (let i = 0; i < 6; i++) {
        const p = planes[i];
        const px = p[0] >= 0 ? mx[0] : mn[0];
        const py = p[1] >= 0 ? mx[1] : mn[1];
        const pz = p[2] >= 0 ? mx[2] : mn[2];
        if (p[0]*px + p[1]*py + p[2]*pz + p[3] < 0) return false;
      }
      return true;
    }
    // Squared distance from point (ex,ey,ez) to the nearest point on an AABB.
    function _aabbDist2(mn, mx, ex, ey, ez) {
      const dx = ex < mn[0] ? mn[0] - ex : ex > mx[0] ? ex - mx[0] : 0;
      const dy = ey < mn[1] ? mn[1] - ey : ey > mx[1] ? ey - mx[1] : 0;
      const dz = ez < mn[2] ? mn[2] - ez : ez > mx[2] ? ez - mx[2] : 0;
      return dx * dx + dy * dy + dz * dz;
    }

    // Build a chunked mesh: ONE shared VBO/VAO + one index buffer per spatial XZ
    // cell (cellSize metres), each with an AABB over the verts it references. Index
    // type is Uint32 whenever total verts > 65535 (chunk indices reference the full
    // shared vertex array). Returns an object that also works as a plain mesh
    // (top-level vao/vbo/ib/count) so a stray draw()/castShadow() won't crash.
    function createChunkedMesh(data, cellSize) {
      const cell = cellSize > 0 ? cellSize : 72;
      let pos = toF32(data.pos), nrm = toF32(data.nrm), col = toF32(data.col);
      const srcIdx = data.idx, vCount = pos.length / 3, big = vCount > 65535;
      const triCount = (srcIdx.length / 3) | 0;
      if (triCount < 2000) { const m = createMesh(data); m.chunks = null; return m; }
      let mat = data.mat && data.mat.length === vCount ? toF32(data.mat) : null;
      const hasMat = mat != null;
      const fpv = hasMat ? 10 : 9;
      let interleaved = new Float32Array(vCount * fpv);
      for (let i = 0; i < vCount; i++) {
        const o = i * fpv;
        interleaved[o  ]=pos[i*3  ]; interleaved[o+1]=pos[i*3+1]; interleaved[o+2]=pos[i*3+2];
        interleaved[o+3]=nrm[i*3  ]; interleaved[o+4]=nrm[i*3+1]; interleaved[o+5]=nrm[i*3+2];
        interleaved[o+6]=col[i*3  ]; interleaved[o+7]=col[i*3+1]; interleaved[o+8]=col[i*3+2];
        if (mat) interleaved[o+9]=mat[i];
      }
      // Interleave done: normals/colours/materials are now baked into `interleaved`
      // and never read again. Drop them (both the toF32 copies and the source refs)
      // so ~half the source arrays can be GC'd before the bucket index arrays are
      // built — lowers the transient peak on ~5 M-vert street props. `pos` is still
      // needed below for triangle centroids/AABBs, so it's nulled after the bins.
      nrm = col = mat = null;
      data.nrm = data.mat = null;
      if (!data._keepPositions) data.col = null;
      // Bin triangles by centroid cell. Numeric key (fast, no string alloc): the
      // grid is bounded (tracks span a few km), so pack signed cell coords.
      const buckets = new Map();
      for (let t = 0; t < srcIdx.length; t += 3) {
        const a = srcIdx[t], b = srcIdx[t+1], c = srcIdx[t+2];
        const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2], bx=pos[b*3],by=pos[b*3+1],bz=pos[b*3+2],
              cx=pos[c*3],cy=pos[c*3+1],cz=pos[c*3+2];
        const gx = Math.floor(((ax+bx+cx)/3)/cell) + 1024;
        const gz = Math.floor(((az+bz+cz)/3)/cell) + 1024;
        const key = gx * 4096 + gz;
        let bk = buckets.get(key);
        if (!bk) { bk = { idx: [], mn: [Infinity,Infinity,Infinity], mx: [-Infinity,-Infinity,-Infinity] }; buckets.set(key, bk); }
        bk.idx.push(a, b, c);
        const mn = bk.mn, mx = bk.mx;
        if (ax<mn[0])mn[0]=ax; if (ax>mx[0])mx[0]=ax; if (ay<mn[1])mn[1]=ay; if (ay>mx[1])mx[1]=ay; if (az<mn[2])mn[2]=az; if (az>mx[2])mx[2]=az;
        if (bx<mn[0])mn[0]=bx; if (bx>mx[0])mx[0]=bx; if (by<mn[1])mn[1]=by; if (by>mx[1])mx[1]=by; if (bz<mn[2])mn[2]=bz; if (bz>mx[2])mx[2]=bz;
        if (cx<mn[0])mn[0]=cx; if (cx>mx[0])mx[0]=cx; if (cy<mn[1])mn[1]=cy; if (cy>mx[1])mx[1]=cy; if (cz<mn[2])mn[2]=cz; if (cz>mx[2])mx[2]=cz;
      }
      // Positions are now only referenced by the growable `bk.idx` arrays (as
      // indices, not coords) — drop the vertex coordinate copies before the
      // per-bucket IndexArray allocations below. The source index array is also
      // fully consumed by the bins: dropping it matters most — on a ~5 M-vert
      // street circuit it's a multi-million-element JS array that would otherwise
      // stay resident for the whole session via track.propsGeo/glassGeo.
      pos = null;
      if (!data._keepPositions) { data.pos = null; data.idx = null; }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
      interleaved = null;   // uploaded to the VBO — drop the CPU copy
      const stride = fpv * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride,  0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
      if (hasMat) { gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36); }
      const IndexArray = big ? Uint32Array : Uint16Array;
      const indexType = big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      const chunks = [];
      let firstIb = null;
      buckets.forEach((bk) => {
        const arr = new IndexArray(bk.idx);
        bk.idx = null;   // uploaded below — drop the growable JS array now so buckets
                         // don't all stay resident while the rest are converted
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        if (!firstIb) firstIb = ibo;
        chunks.push({ ibo, count: arr.length, indexType, min: bk.mn, max: bk.mx });
      });
      gl.bindVertexArray(null);
      core.invalidateVAO();   // keep glx.js's VAO bind cache in sync with the direct bind above
      return { vao, vbo, ib: firstIb, count: chunks.length ? chunks[0].count : 0, indexType, chunks, cellSize: cell };
    }

    // Draw a chunked mesh, frustum-culling each chunk against the camera. Material
    // setup is identical to draw() (both route through core.litMaterial).
    // OPAQUE-ONLY: this path keeps depth writes ON regardless of alpha and never
    // masks alpha writes, so draw()'s translucency invariants (translucent draws
    // must not write depth; any blended draw masks scene alpha to protect the
    // SSR car-paint tag) are NOT honoured here. Every current caller passes
    // alpha 1 (game.js props/glass materials carry no alpha field); route
    // translucent work through draw() instead.
    function drawChunked(mesh, modelMat, opts) {
      if (!mesh) return;
      const alpha = litMaterial(modelMat, opts);
      setDepthMask(true);
      setBlend(alpha < 1);
      bindVAO(mesh.vao);
      if (!mesh.chunks) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib); gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0); return; }
      _extractPlanes(F.viewProj, _fcPlanes);
      const chunks = mesh.chunks;
      // Radial draw-distance cap: the frustum's far plane is the only distance cull,
      // so when it's pushed out (free camera) a high/wide vantage admits the whole
      // ~5 M-vert city at once — a mobile-tiler OOM. When frame.cullDist is set, also
      // skip any chunk whose nearest point is beyond it (fog hides the edge).
      const eye = F.eye;
      const cd = F.cullDist, cd2 = cd * cd,
            ex = eye ? eye[0] : 0, ey = eye ? eye[1] : 0, ez = eye ? eye[2] : 0;
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        if (!_aabbInFrustum(_fcPlanes, ch.min, ch.max)) continue;
        if (cd > 0 && _aabbDist2(ch.min, ch.max, ex, ey, ez) > cd2) continue;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.ibo);
        gl.drawElements(gl.TRIANGLES, ch.count, ch.indexType, 0);
      }
    }

    // Shadow cast for a chunked mesh, culled against the shadow light frustum (an
    // off-camera building can still cast INTO view, so we cull by the light-VP, not
    // the camera). Runs under the depth program (bound by GLXShadow.shadowBegin).
    function castShadowChunked(mesh, model) {
      const SH = core.shadow;
      if (!SH.depthPassOn || !mesh) return;
      bindVAO(mesh.vao);
      gl.uniformMatrix4fv(SH.depthU.uModel, false, model);
      if (!mesh.chunks) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib); gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0); return; }
      // Cull against the ACTIVE depth pass's light frustum: the sun box by
      // default, or the lamp's perspective frustum between lampShadowBegin/End —
      // that tight cone is what keeps the per-frame lamp pass down to a handful
      // of city chunks instead of the whole circuit.
      _extractPlanes(SH.castCullVP || SH.lightVP, _fcPlanes);
      const chunks = mesh.chunks;
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        if (!_aabbInFrustum(_fcPlanes, ch.min, ch.max)) continue;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.ibo);
        gl.drawElements(gl.TRIANGLES, ch.count, ch.indexType, 0);
      }
    }

    function freeChunkedMesh(mesh) {
      if (!mesh) return;
      core.unbindVAOIf(mesh.vao);
      if (mesh.chunks) for (let i = 0; i < mesh.chunks.length; i++) gl.deleteBuffer(mesh.chunks[i].ibo);
      else if (mesh.ib) gl.deleteBuffer(mesh.ib);
      if (mesh.vbo) gl.deleteBuffer(mesh.vbo);
      if (mesh.vao) gl.deleteVertexArray(mesh.vao);
    }

    // Allocate a fresh plane set from a column-major view-proj. The draw path
    // uses the module-static _fcPlanes scratch and must keep doing so (it runs
    // per frame); this is for occasional callers — the agent world view asking
    // "which scenery chunks are actually on screen" — where one allocation is
    // free and sharing the scratch with an in-flight draw would be a bug.
    function makeFrustumPlanes(viewProj) {
      const p = [new Float32Array(4), new Float32Array(4), new Float32Array(4),
                 new Float32Array(4), new Float32Array(4), new Float32Array(4)];
      _extractPlanes(viewProj, p);
      return p;
    }

    return { createChunkedMesh, drawChunked, castShadowChunked, freeChunkedMesh,
             // exported so callers outside the draw path can run the SAME cull
             // test the GPU path runs, rather than reimplementing it and drifting
             makeFrustumPlanes, aabbInFrustum: _aabbInFrustum, aabbDist2: _aabbDist2 };
  }

  return { init };
})();
