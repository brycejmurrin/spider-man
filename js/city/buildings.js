/* Web-Slinger — the building massing library, ported from Apex 26's
   SceneryCity (js/track/scenery-city.js). The visual recipes — inset curtain
   walls, HDR lit panes, the ~18-silhouette massing switch, crowns, beacons —
   carry over with their tuned numbers intact (the 0.29/0.34/0.40 facade
   standoffs each encode a shipped z-fight fix; keep them). What changed:

   - Placement is a LOT, not a (k, side, dist) spline anchor: the caller hands
     {c, r, u, t, w, h, d} with the street-facing face on -r. side is +1 always.
   - No rejBox/onTrack/massBlocked/blockAt: the street grid reserves roads by
     construction and lots never overlap, so the guards (and the driving
     boundary) have no job here.
   - ctx.note() became ctx.register(): every shipped building records the OBB
     the collider/rooftop systems consume — that record IS the gameplay city.
   - Every facade element routes through graph.instance (the unit-box model +
     per-instance colour), including the neonTower masses that Apex 26 still
     emitted as raw boxes — the instancing migration its docs called the
     prerequisite for a city bigger than Vegas. */
import { Geom } from "./geom.js";
import { CityGraph } from "./graph.js";
import { WINTINTS } from "./city-data.js";

const { MAT } = Geom;

// The one model every axis-aligned facade box shares: a unit cube with its
// size on the node scale and its colour on the node.
const UNIT_BOX = "unit-box";
const unitBox = (rec) => rec.box([0, 0, 0], [1, 1, 1], CityGraph.NODE_COLOR);

const vadd = (a, v, k) => [a[0] + v[0] * k, a[1] + v[1] * k, a[2] + v[2] * k];

export function createBuildings(ctx) {
  const { out, glassBuf, graph, night: NIGHT, hash, register } = ctx;
  const lod = ctx.lod || ((n) => n);
  // graph.instance wrapper: default buffer `out`, RAW emitters (no guards).
  const inst = (key, place, build, meta, buf) =>
    graph.instance(key, place, build, meta, Geom, buf || out);

  /* neonFacade(): the shared detailed night facade — an inset-window curtain
     wall on the street-facing (-r) face: proud dark frame rails + vertical
     mullions, recessed glass panes behind them. Most panes DARK; a minority
     lit (warm office light, a few neon). neonAmt 0..1 sets how neon it is. */
  const neonFacade = (mid, bb, sw, sh, sd, neon, seed, neonAmt) => {
    const u = bb[1];
    const frameCol = [0.12, 0.12, 0.15];
    const dark = [0.035, 0.035, 0.055];
    const nc = [neon[0] * 0.95, neon[1] * 0.95, neon[2] * 0.95];
    // Lit-window tint. A single hardcoded warm made every non-neon window in
    // the city one of exactly two colours, which is the whole "monochrome per
    // building" read: real towers mix 2700 K residential, 4100 K office
    // fluorescent and cool LED, and the mix differs floor to floor. WINTINTS
    // is that spread; pick a base per building and vary per pane around it.
    const wbase = WINTINTS[Math.floor(hash(seed * 1.7) * WINTINTS.length) % WINTINTS.length];
    const litShare = 0.20 + neonAmt * 0.08, neonShare = neonAmt * 0.7;
    const rows = lod(Math.max(4, Math.min(10, Math.round(sh / 4.4))), 3);
    const fh = sh / rows, frameT = 0.30, railH = Math.max(0.4, fh * 0.24);
    const drawFace = (nAxis, nSign, nHalf, wAxis, faceW, sOff, simple) => {
      const nVec = bb[nAxis], wVec = bb[wAxis];
      const cols = simple ? Math.max(2, Math.min(3, Math.round(faceW / 5.4)))
                          : lod(Math.max(2, Math.min(6, Math.round(faceW / 3.3))), 2);
      const rowN = simple ? lod(Math.max(2, Math.min(6, Math.round(sh / 6.4))), 2) : rows;
      const winHH = Math.max(0.5, sh / rowN - railH);
      const fBase = vadd(mid, nVec, nSign * (nHalf + 0.34));
      // Mullions 5 cm BEHIND the rails — the zero-gap same-facing z-fight fix.
      const mBase = vadd(mid, nVec, nSign * (nHalf + 0.29));
      // Edge neon stands PROUD of the frame with real air (0.40).
      const nBase = vadd(mid, nVec, nSign * (nHalf + 0.40));
      // Panes 0.08 thick; 0.05+0.04 keeps their inner face clear of the wall.
      const gBase = vadd(mid, nVec, nSign * (nHalf + 0.05 + 0.04));
      const dim = (thin, hgt, wid) => { const a = [0, 0, 0]; a[nAxis] = thin; a[1] = hgt; a[wAxis] = wid; return a; };
      out._mat = MAT.METAL;
      if (!simple) for (let i = 0; i <= rowN; i += 2)
        inst(UNIT_BOX,
          { o: vadd(fBase, u, (i / rowN - 0.5) * sh), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT, railH, faceW * 1.005), col: frameCol },
          unitBox, { kind: "facadeRail" });
      for (let c = 0; c < cols; c++) {
        const cx = (-0.5 + (c + 0.5) / cols) * faceW;
        // Occupancy is STRUCTURED, not per-pane white noise. A real tower shows
        // whole lit floors and vertical runs where the stair/lift core is lit
        // top to bottom; uncorrelated noise is the strongest "CG building" tell
        // there is. Net lit share lands near the same value, but banded.
        const coreCol = Math.floor(hash(seed * 4.3 + sOff) * cols);
        for (let ri = 0; ri < rowN; ri++) {
          const ry = (-0.5 + (ri + 0.5) / rowN) * sh;
          const floorLit = hash(seed * 2.9 + ri * 3.7) < 0.55;
          const isCore = c === coreCol && hash(seed * 6.1 + ri * 1.3) < 0.9;
          let col = dark, lit = false;
          if (isCore || (floorLit && hash(seed + sOff + c * 12.9 + ri * 7.3) < litShare * 2.4)) {
            lit = true;
            const tw = 0.65 + hash(seed + sOff + c * 5.5 + ri * 2.2) * 0.5;
            // per-pane hue jitter around the building's base tint
            const j = (hash(seed + c * 9.1 + ri * 4.7) - 0.5) * 0.14;
            col = hash(seed + sOff + c * 3.1 + ri * 1.7) < neonShare
              ? [nc[0] * tw, nc[1] * tw, nc[2] * tw]
              : [wbase[0] * (tw + j), wbase[1] * tw, wbase[2] * (tw - j)];
          }
          // Lit panes glow on the emissive props mesh; unlit street-face panes
          // become reflective dark glass (glass mesh) so windows mirror the
          // city as live glints.
          const toGlass = !lit && !simple;
          if (toGlass) glassBuf._mat = MAT.GLASS; else out._mat = 0;
          inst(UNIT_BOX,
            { o: vadd(vadd(gBase, wVec, cx), u, ry),
              r: bb[0], u: bb[1], t: bb[2],
              s: dim(0.08, winHH, (faceW / cols) * 0.82), col },
            unitBox, { kind: "windowPane" }, toGlass ? glassBuf : out);
          if (toGlass) glassBuf._mat = 0;
        }
      }
      out._mat = MAT.METAL;
      if (simple) { out._mat = 0; return; }
      const nm = Math.max(1, Math.min(3, cols - 1));
      for (let c = 1; c <= nm; c++)
        inst(UNIT_BOX,
          { o: vadd(mBase, wVec, (-0.5 + c / (nm + 1)) * faceW), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT, sh, 0.4), col: frameCol },
          unitBox, { kind: "facadeMullion" });
      if (neonAmt > 0.3) {
        const ST = Math.min(0.4, faceW * 0.04);
        for (const dr of [-1, 1])
          inst(UNIT_BOX,
            { o: vadd(nBase, wVec, dr * faceW * 0.5), r: bb[0], u: bb[1], t: bb[2],
              s: dim(frameT * 1.05, sh * 0.96, ST), col: nc },
            unitBox, { kind: "facadeNeon" });
        inst(UNIT_BOX,
          { o: vadd(nBase, u, sh * 0.48), r: bb[0], u: bb[1], t: bb[2],
            s: dim(frameT * 1.1, Math.min(0.5, sh * 0.018), faceW), col: nc },
          unitBox, { kind: "facadeNeon" });
      }
      out._mat = 0;
    };
    drawFace(0, -1, sw / 2, 2, sd, 0, false);   // street-facing facade: full detail
    drawFace(2, 1, sd / 2, 0, sw, 137, true);   // +t side: simple
    drawFace(2, -1, sd / 2, 0, sw, 311, true);  // -t side: simple
  };

  // Day window grid around a mass centre (the neonTower day path).
  const dayGridAt = (cen, bb, sw, sh, sd, bodyCol) => {
    const med = bodyCol[0] > 0.6 && bodyCol[0] > bodyCol[2] + 0.08;   // warm light wall
    const medWin = [bodyCol[0] * 0.34, bodyCol[1] * 0.30, bodyCol[2] * 0.26];
    const rows = lod(Math.max(4, Math.min(10, Math.round(sh / 4.4))), 3);
    const dface = (nAxis, nSign, nHalf, wAxis, faceW, simple) => {
      const cols = simple ? Math.max(2, Math.min(3, Math.round(faceW / 5.2)))
                          : lod(Math.max(2, Math.min(6, Math.round(faceW / 3.1))), 2);
      const rowN = simple ? lod(Math.max(2, Math.min(6, Math.round(sh / 6.4))), 2) : rows;
      const PANE_STANDOFF = 0.05;
      const gBase = (thick) => vadd(cen, bb[nAxis], nSign * (nHalf + PANE_STANDOFF + thick / 2));
      const dim = (thin, hgt, wid) => { const a = [0, 0, 0]; a[nAxis] = thin; a[1] = hgt; a[wAxis] = wid; return a; };
      for (let c = 0; c < cols; c++) {
        const cx = (-0.5 + (c + 0.5) / cols) * faceW;
        for (let r = 0; r < rowN; r++) {
          const ry01 = (r + 0.5) / rowN;
          const at = (thick) => vadd(vadd(gBase(thick), bb[wAxis], cx), bb[1], (-0.5 + ry01) * sh);
          if (med) {
            out._mat = MAT.GLASS;
            Geom.addBox(out, at(0.06), dim(0.06, (sh / rowN) * 0.42, (faceW / cols) * 0.42), medWin, bb);
            out._mat = 0;
          } else {
            const t01 = 0.42 + ry01 * 0.16;
            glassBuf._mat = MAT.GLASS;
            Geom.addBox(glassBuf, at(0.08), dim(0.08, (sh / rowN) * 0.62, (faceW / cols) * 0.6),
              [t01 * 0.40, t01 * 0.47, t01 * 0.62], bb);
            glassBuf._mat = 0;
          }
        }
      }
    };
    dface(0, -1, sw / 2, 2, sd, false);
    dface(2, 1, sd / 2, 0, sw, true);
    dface(2, -1, sd / 2, 0, sw, true);
  };

  /* tower(): the massing-silhouette switch (Apex 26's neonTower). lot gives
     the anchor + basis; kind picks the form. */
  const tower = (lot, kind, neon, tone, neonAmt, seed) => {
    const { c, r, u, t, w, h, d } = lot;
    const a = { c }, b = [r, u, t];
    const reach = Math.max(w, d);
    // Per-building jitter around the district tone. tone.n/tone.d are single
    // literals per district, so without this every tower in midtown is exactly
    // the same grey and the skyline reads as one extruded material.
    const base = NIGHT ? (tone && tone.n || [0.14, 0.14, 0.17]) : (tone && tone.d || [0.40, 0.41, 0.44]);
    const jv = 0.86 + hash(seed * 8.7) * 0.30;                 // value
    const jh = (hash(seed * 5.9) - 0.5) * 0.10;                // warm/cool tilt
    const bodyCol = [base[0] * (jv + jh), base[1] * jv, base[2] * (jv - jh)];
    const cap = NIGHT ? [0.09, 0.09, 0.12] : [0.31, 0.32, 0.35];
    const na = neonAmt == null ? 0.5 : neonAmt;
    const neonOn = NIGHT && na > 0.3;
    const warm = [1.0, 0.80, 0.46];   // ring/band lighting on radial forms
    const bmat = NIGHT ? MAT.CONCRETE
      : (bodyCol[0] > 0.5 && bodyCol[0] > bodyCol[2] + 0.03) ? MAT.BRICK : MAT.CONCRETE;
    // One stacked section centred at up=yb+sh/2; to/ro shift along t/r so twin
    // and notch members never share a face plane (the zero-gap fix).
    const sec = (yb, sw, sh, sd, sseed, to, ro) => {
      const cen = vadd(vadd(vadd(a.c, u, yb + sh / 2), t, to || 0), r, ro || 0);
      out._mat = bmat;
      inst(UNIT_BOX, { o: cen, r, u, t, s: [sw, sh, sd], col: bodyCol },
        unitBox, { kind: "buildingMass" });
      out._mat = MAT.METAL;
      if (NIGHT) neonFacade(cen, b, sw, sh, sd, neon, sseed, na);
      else dayGridAt(cen, b, sw, sh, sd, bodyCol);
      return true;
    };
    out._mat = MAT.METAL;   // caps / antennas / trim default
    if (kind === "tiered") {
      let yb = 0, tw = w, td = d;
      const frac = [0.46, 0.32, 0.22];
      for (let i = 0; i < 3; i++) { const th = h * frac[i]; sec(yb, tw, th, td, seed + i * 11); yb += th; tw *= 0.66; td *= 0.66; }
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [tw, 1.0, td], cap, b);
    } else if (kind === "podium") {
      const podH = h * 0.28;
      sec(0, w * 1.18, podH, d * 1.18, seed);          // wide retail podium (1.35 trimmed: lots abut)
      sec(podH, w * 0.7, h - podH, d * 0.7, seed + 7);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.45, 1.0, d * 0.45], cap, b);
    } else if (kind === "slab") {
      sec(0, w, h, d, seed);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.92, 1.0, d * 0.92], cap, b);
    } else if (kind === "twin") {
      const td = d * 0.4, off = d * 0.28;
      for (let i = 0; i < 2; i++) {
        const o = i === 0 ? -off : off, th = h * (i === 0 ? 1 : 0.82);
        sec(0, w * 0.9, th, td, seed + i * 7, o);
        Geom.addBox(out, vadd(vadd(a.c, u, th + 0.4), t, o), [w * 0.6, 0.8, td * 0.8], cap, b);
      }
    } else if (kind === "jenga") {
      const n2 = 4, bh = h / n2;
      for (let i = 0; i < n2; i++) sec(i * bh, w * 0.86, bh, d * 0.72, seed + i * 9.1, (hash(seed + i * 5.5) - 0.5) * d * 0.5);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.5, 1.0, d * 0.5], cap, b);
    } else if (kind === "cylinder") {
      const R = reach * 0.5, segs = 14;
      Geom.addCyl(out, a.c, R, h, bodyCol, segs, b);
      const rings = Math.max(3, Math.min(14, Math.round(h / 6)));
      for (let ri = 1; ri < rings; ri++) {
        const isLit = NIGHT && hash(seed + ri * 3.3) < (0.26 + na * 0.18);
        const col = isLit ? (neonOn ? neon : warm) : [0.06, 0.06, 0.09];
        Geom.addCyl(out, vadd(a.c, u, ri * (h / rings)), R * 1.01, (h / rings) * (isLit ? 0.22 : 0.1), col, segs, b);
      }
      Geom.addCyl(out, vadd(a.c, u, h), R * 0.6, 1.4, cap, segs, b);
    } else if (kind === "spire") {
      const bh = h * 0.74, R = reach * 0.5;
      Geom.addFrustum(out, a.c, R, R * 0.42, bh, bodyCol, 8, b);
      const rings = Math.max(3, Math.round(bh / 7));
      for (let ri = 1; ri < rings; ri++) {
        const isLit = NIGHT && hash(seed + ri * 2.1) < (0.26 + na * 0.16);
        const col = isLit ? (neonOn ? neon : warm) : [0.06, 0.06, 0.09];
        Geom.addCyl(out, vadd(a.c, u, ri * (bh / rings)), R * (1 - 0.55 * ri / rings) * 1.02, (bh / rings) * (isLit ? 0.2 : 0.09), col, 8, b);
      }
      Geom.addCyl(out, vadd(a.c, u, bh), 0.35, h - bh, neonOn ? neon : [0.4, 0.4, 0.45], 4, b);
      if (NIGHT) Geom.addBox(out, vadd(a.c, u, h), [0.9, 0.9, 0.9], [3.0, 0.6, 0.4], b);
    } else if (kind === "screen") {
      sec(0, w, h, d, seed);
      const sc = neonOn ? [neon[0] * 1.25, neon[1] * 1.25, neon[2] * 1.25]
                        : (NIGHT ? [warm[0] * 0.9, warm[1] * 0.9, warm[2] * 0.9] : [0.30, 0.33, 0.40]);
      Geom.addBox(out, vadd(vadd(a.c, u, h * 0.56), r, -(w / 2 + 0.25)), [0.3, h * 0.66, d * 0.82], sc, b);
      if (neonOn) Geom.addBox(out, vadd(vadd(a.c, u, h * 0.56), r, -(w / 2 + 0.28)), [0.1, h * 0.6, d * 0.74],
        [neon[0] * 0.4, neon[1] * 0.4, neon[2] * 0.4], b);
    } else if (kind === "clad") {
      sec(0, w, h, d, seed);
      if (neonOn) { const bands = Math.max(4, Math.round(h / 5)); for (let i = 1; i < bands; i++) Geom.addBox(out, vadd(a.c, u, i * (h / bands)), [w * 1.04, (h / bands) * 0.22, d * 1.04], neon, b); }
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.6, 1.0, d * 0.6], cap, b);
    } else if (kind === "dome") {
      const bh = h * 0.78, R = reach * 0.34;
      sec(0, w, bh, d, seed);
      Geom.addCyl(out, vadd(a.c, u, bh), R, h * 0.10, cap, 14, b);
      Geom.addCone(out, vadd(a.c, u, bh + h * 0.10), R * 1.1, h * 0.16, neonOn ? neon : (NIGHT ? warm : cap), 14, b);
      if (NIGHT) Geom.addBox(out, vadd(a.c, u, h + 0.6), [0.7, 0.7, 0.7], neonOn ? [3.0, 2.0, 0.8] : [3.0, 0.6, 0.4], b);
    } else if (kind === "chevron") {
      const bh = h * 0.82;
      sec(0, w, bh, d, seed);
      // addPrism takes its c as the BASE centre, so no half-height lift here.
      Geom.addPrism(out, vadd(a.c, u, bh), [w, h * 0.18, d], cap, b);
      if (neonOn) Geom.addBox(out, vadd(a.c, u, bh + h * 0.18), [w * 1.02, 0.5, d * 1.02], neon, b);
    } else if (kind === "notch") {
      const podH = h * 0.22, off = w * 0.30;
      sec(0, w, podH, d, seed);
      for (const o2 of [-off, off]) sec(podH, w * 0.42, h - podH, d, seed + o2, o2, o2 > 0 ? 0.07 : 0);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.92, 1.0, d * 0.9], cap, b);
    } else if (kind === "fin") {
      sec(0, w, h, d, seed);
      const fins = Math.max(3, Math.round(w / 4));
      for (let i = 0; i < fins; i++) {
        const fx = (-0.5 + (i + 0.5) / fins) * w, lit = neonOn && hash(seed + i * 5.1) < 0.5;
        Geom.addBox(out, vadd(vadd(vadd(a.c, u, h * 0.5), t, fx), r, -(d / 2 + 0.2)), [0.5, h * 0.94, 0.5], lit ? neon : cap, b);
      }
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.92, 1.0, d * 0.92], cap, b);
    } else if (kind === "antenna") {
      sec(0, w, h, d, seed);
      Geom.addBox(out, vadd(a.c, u, h + 0.4), [w * 0.9, 0.8, d * 0.9], cap, b);
      for (let i = 0; i < 3; i++) {
        const mx = (-0.5 + (i + 0.5) / 3) * w * 0.6, mh = h * (0.14 + hash(seed + i * 7.3) * 0.16);
        Geom.addCyl(out, vadd(vadd(a.c, u, h), t, mx), 0.22, mh, [0.4, 0.4, 0.45], 4, b);
        if (NIGHT) Geom.addBox(out, vadd(vadd(a.c, u, h + mh), t, mx), [0.5, 0.5, 0.5], [3.0, 0.5, 0.35], b);
      }
    } else if (kind === "cross") {
      sec(0, w, h, d * 0.5, seed);
      const cen2 = vadd(a.c, u, h * 0.5);
      out._mat = bmat;
      Geom.addBox(out, cen2, [w * 0.5, h, d], bodyCol, b);
      out._mat = MAT.METAL;
      if (NIGHT) neonFacade(cen2, b, w * 0.5, h, d, neon, seed + 6.1, na);
      else dayGridAt(cen2, b, w * 0.5, h, d, bodyCol);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.6, 1.0, d * 0.6], cap, b);
    } else if (kind === "arch") {
      const legW = w * 0.26, gp = w * 0.46, legH = h * 0.78, off = gp / 2 + legW / 2;
      for (const o3 of [-off, off]) sec(0, legW, legH, d, seed + o3 * 7, o3, o3 > 0 ? 0.07 : 0);
      sec(legH, w, h - legH, d, seed + 5.9);
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.96, 1.0, d * 0.9], cap, b);
    } else if (kind === "ziggurat") {
      const steps = 6; let yb = 0, tw = w, td = d;
      for (let i = 0; i < steps; i++) { const th = h / steps; sec(yb, tw, th, td, seed + i * 8); yb += th; tw *= 0.82; td *= 0.82; }
      Geom.addBox(out, vadd(a.c, u, h + 0.4), [tw, 0.8, td], cap, b);
    } else if (kind === "drum") {
      const R = reach * 0.6, dh = h * 0.5;
      Geom.addCyl(out, a.c, R, dh, bodyCol, 18, b);
      const ring = NIGHT ? (neonOn ? neon : warm) : [0.30, 0.34, 0.42];
      Geom.addCyl(out, vadd(a.c, u, dh * 0.5), R * 1.02, dh * 0.16, ring, 18, b);
      Geom.addCyl(out, vadd(a.c, u, dh), R * 0.96, 1.2, cap, 18, b);
      Geom.addCyl(out, vadd(a.c, u, dh + 1.0), R * 0.7, 0.8, cap, 18, b);
    } else if (kind === "hall") {
      const hh = h * 0.5;
      sec(0, w, hh * 0.7, d, seed);
      Geom.addPrism(out, vadd(a.c, u, hh * 0.7), [w, hh * 0.3, d], cap, b);
      if (neonOn) Geom.addBox(out, vadd(a.c, u, hh * 0.7), [w * 1.02, 0.4, d * 1.02], neon, b);
    } else { // setback
      const setH = h * 0.84;
      sec(0, w, setH, d, seed);
      out._mat = bmat;
      Geom.addBox(out, vadd(a.c, u, setH + (h - setH) / 2), [w * 0.72, h - setH, d * 0.72], bodyCol, b);
      out._mat = MAT.METAL;
      Geom.addBox(out, vadd(a.c, u, h + 0.5), [w * 0.5, 1.0, d * 0.5], cap, b);
    }
    out._mat = 0;
  };

  /* building(lot, profile, opts) — one building on one lot.
     lot: { c:[x,y,z] ground centre, r/u/t basis (street face -r), w, h, d }
     profile: a DISTRICTS entry; opts: { seed } */
  const building = (lot, profile, opts) => {
    opts = opts || {};
    const { c, r, u, t, w, h, d } = lot;
    const seed = opts.seed != null ? opts.seed : (c[0] * 0.37 + c[2] * 0.91);
    const kinds = profile.kinds;
    const kind = kinds[Math.floor(hash(seed * 3.7) * kinds.length) % kinds.length];
    const isNeon = hash(seed * 5.3) < profile.bias;
    const useKind = isNeon && profile.neonKinds.length && hash(seed * 7.7) < 0.4
      ? profile.neonKinds[Math.floor(hash(seed * 9.1) * profile.neonKinds.length) % profile.neonKinds.length]
      : kind;
    const neon = profile.neon[Math.floor(hash(seed * 2.3) * profile.neon.length) % profile.neon.length];
    const tone = profile.tone
      ? profile.tone
      : { n: [0.14, 0.14, 0.17], d: profile.dayPal[Math.floor(hash(seed * 4.9) * profile.dayPal.length) % profile.dayPal.length] };
    const neonAmt = isNeon ? 0.85 : 0.32;

    // Ground-floor plinth — grounded, never near-black; slight overhang with a
    // floor of 0.22 m so facade panes (0.13 m proud) can never tie against it.
    const plH = Math.min(3.2, h * 0.14);
    const body = NIGHT ? [0.26, 0.24, 0.30] : tone.d;
    const plinth = NIGHT ? [body[0] * 0.8, body[1] * 0.8, body[2] * 0.9]
                         : [Math.max(body[0] * 1.2, 0.40), Math.max(body[1] * 1.2, 0.40), Math.max(body[2] * 1.2, 0.44)];
    const plOut = Math.max(0.22, w * 0.01), pdOut = Math.max(0.22, d * 0.01);
    out._mat = MAT.CONCRETE;
    Geom.addBox(out, vadd(c, u, plH / 2), [w + 2 * plOut, plH, d + 2 * pdOut], plinth, [r, u, t]);
    out._mat = 0;

    tower(lot, useKind, neon, tone, neonAmt, seed);

    // Night signage: an HDR neon band wrapping the crown of some lit towers,
    // plus a red aircraft beacon (with its mast) on tall ones.
    if (NIGHT) {
      const NEON = [[2.6, 1.5, 0.5], [0.5, 1.9, 2.6], [2.6, 0.6, 1.7], [0.9, 2.4, 0.9], [2.2, 0.9, 2.4]];
      if (hash(seed * 6.7) < 0.5) {
        const nb = NEON[Math.floor(hash(seed * 8.9) * NEON.length) % NEON.length];
        const by = h * (0.5 + hash(seed * 2.3) * 0.32);
        Geom.addBox(out, vadd(c, u, by), [w * 0.72 * 1.05, 0.7, d * 0.72 * 1.05], nb, [r, u, t]);
      }
      if (h > 38) {
        Geom.addCyl(out, vadd(c, u, h), 0.14, 2.4, [0.30, 0.30, 0.34], 4, [r, u, t]);
        Geom.addBox(out, vadd(c, u, h + 2.4), [1.1, 1.1, 1.1], [3.2, 0.4, 0.3], [r, u, t]);
      }
    }

    // The gameplay record: footprint OBB + roof for colliders/anchors/landing.
    if (register) register({
      cx: c[0], cz: c[2], y0: c[1], y1: c[1] + h,
      hw: w / 2, hd: d / 2,
      // yaw of the r axis in world XZ (colliders rotate into lot space with it)
      rot: Math.atan2(r[2], r[0]),
      kind: useKind,
    });
  };

  return { building, neonFacade };
}
