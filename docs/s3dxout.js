/**
 * Shape3D (.s3dx) export: writes a Trey Shaper board as a Shape3D X design, so it opens in Shape3D for CNC.
 * Shape3D describes a board with Bezier curves in centimetres: the outline, the bottom and deck stringers,
 * the paths of the rail edge (tuck point) and rail apex along the board, and a handful of cross sections
 * ("couples"), each five points: bottom stringer, rail edge, apex, deck shoulder, deck stringer.
 * Each curve here is fitted to the built board: knots are added where the fit strays more than about
 * 1/64" (outline and stringers) or 1/32" (cross sections), with tangents taken from the board itself.
 * What a cross section's single curve from the stringer to the rail cannot hold (channels, hard-edged
 * concave tools, step decks, a swallow's cut) is not in the file; Shape3D has its own tools for those.
 * No DOM: runs in the browser and in Node.
 */

const IN = 2.54;
const f6 = (v) => (Number.isFinite(v) ? v : 0).toFixed(6);
const f3 = (v) => (Number.isFinite(v) ? v : 0).toFixed(3);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/** The point at t on the cubic a, b, c, d. */
function bz(a, b, c, d, t) {
  const s = 1 - t, w0 = s * s * s, w1 = 3 * s * s * t, w2 = 3 * s * t * t, w3 = t * t * t;
  return [0, 1, 2].map((k) => w0 * a[k] + w1 * b[k] + w2 * c[k] + w3 * d[k]);
}

/** Fit one cubic from P[i0] to P[i1] (points between them are the data), leaving each end along its given
 *  unit tangent: handle lengths by least squares, with the data's parameters refined a few times.
 *  Returns [b, c, worst distance]. */
function fitSegment(P, i0, i1, t0, t1) {
  const a = P[i0], d = P[i1], chord = len(sub(d, a));
  if (i1 - i0 < 2 || chord < 1e-9) return [add(a, t0, chord / 3), add(d, t1, -chord / 3), 0];
  let u = [0], acc = 0;
  for (let i = i0 + 1; i <= i1; i++) { acc += len(sub(P[i], P[i - 1])); u.push(acc); }
  u = u.map((v) => v / (acc || 1));
  let al = chord / 3, be = chord / 3;
  for (let it = 0; it < 6; it++) {
    // P(t) = A(t) + al*B1(t)*t0 - be*B2(t)*t1, solve the 2x2 normal equations
    let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0;
    for (let j = 1; j < u.length - 1; j++) {
      const t = u[j], s = 1 - t, B0 = s * s * s, B1 = 3 * s * s * t, B2 = 3 * s * t * t, B3 = t * t * t;
      const A1 = t0.map((v) => v * B1), A2 = t1.map((v) => -v * B2);
      const base = [0, 1, 2].map((k) => (B0 + B1) * a[k] + (B2 + B3) * d[k]), r = sub(P[i0 + j], base);
      c11 += dot(A1, A1); c12 += dot(A1, A2); c22 += dot(A2, A2); x1 += dot(A1, r); x2 += dot(A2, r);
    }
    const det = c11 * c22 - c12 * c12;
    if (Math.abs(det) > 1e-12) { al = (x1 * c22 - x2 * c12) / det; be = (c11 * x2 - c12 * x1) / det; }
    const lo = chord * 0.02, hi = chord * 1.2;
    al = Math.min(Math.max(al, lo), hi); be = Math.min(Math.max(be, lo), hi);
    // Newton step on each data point's parameter
    const b = add(a, t0, al), c = add(d, t1, -be);
    for (let j = 1; j < u.length - 1; j++) {
      const t = u[j], s = 1 - t;
      const q = bz(a, b, c, d, t), q1 = [0, 1, 2].map((k) => 3 * (s * s * (b[k] - a[k]) + 2 * s * t * (c[k] - b[k]) + t * t * (d[k] - c[k])));
      const q2 = [0, 1, 2].map((k) => 6 * (s * (c[k] - 2 * b[k] + a[k]) + t * (d[k] - 2 * c[k] + b[k])));
      const r = sub(q, P[i0 + j]), num = dot(r, q1), den = dot(q1, q1) + dot(r, q2);
      if (Math.abs(den) > 1e-12) u[j] = Math.min(Math.max(t - num / den, 0), 1);
    }
  }
  const b = add(a, t0, al), c = add(d, t1, -be);
  let worst = 0, wi = Math.round((i0 + i1) / 2);
  const S = []; for (let k = 0; k <= 400; k++) S.push(bz(a, b, c, d, k / 400));
  for (let j = 1; j < u.length - 1; j++) {
    // distance from the data point to the curve (to the nearer of the two closest samples' chord)
    let best = Infinity, kb = 0;
    for (let k = 0; k <= 400; k++) { const q = len(sub(S[k], P[i0 + j])); if (q < best) { best = q; kb = k; } }
    for (const k2 of [kb - 1, kb + 1]) {
      if (k2 < 0 || k2 > 400) continue;
      const e = sub(S[k2], S[kb]), w = sub(P[i0 + j], S[kb]), ee = dot(e, e);
      if (ee > 0) { const f = Math.min(Math.max(dot(w, e) / ee, 0), 1); best = Math.min(best, len(sub(w, [e[0] * f, e[1] * f, e[2] * f]))); }
    }
    if (best > worst) { worst = best; wi = i0 + j; }
  }
  return [b, c, worst, wi];
}

/** The unit tangent of the polyline at point i: through the points about 1 cm either side (so close stations don't
 *  give a noisy direction); one-sided at the ends, or one side of a corner (side -1 incoming, +1 outgoing). */
function tangentAt(P, i, side = 0, reach = 1) {
  const n = P.length;
  const walk = (dir) => { let j = i, d = 0; while (j + dir >= 0 && j + dir < n && d < reach) { d += len(sub(P[j + dir], P[j])); j += dir; } return j; };
  const jb = side > 0 ? i : walk(-1), jf = side < 0 ? i : walk(1);
  if (jf === jb) return [0, 0, 0];
  return unit(sub(P[jf], P[jb]));
}

/** A curve through the points P (cm), knots at the indices `fixed` plus more where it strays past tol.
 *  `tan(i, side)` may override a knot's tangent (side -1 incoming, +1 outgoing). Returns { P, T1, T2, knots }. */
function fitCurve(P, fixed, tol, maxKnots = 24, tan = () => null) {
  const knots = [...new Set([0, P.length - 1, ...fixed])].sort((a, b) => a - b);
  const tIn = (i) => tan(i, -1) || tangentAt(P, i), tOut = (i) => tan(i, 1) || tangentAt(P, i);
  let segs;
  for (;;) {
    segs = [];
    let worst = 0, at = -1;
    for (let k = 0; k < knots.length - 1; k++) {
      const i0 = knots[k], i1 = knots[k + 1], s = fitSegment(P, i0, i1, tOut(i0), tIn(i1));
      segs.push(s);
      if (s[2] > worst && i1 - i0 > 2) { worst = s[2]; at = k; }
    }
    if (worst <= tol || knots.length >= maxKnots || at < 0) break;
    knots.splice(at + 1, 0, segs[at][3]);                // split the worst segment at its farthest point
  }
  const out = { P: knots.map((i) => P[i]), T1: [], T2: [], knots };
  knots.forEach((i, k) => {
    out.T1.push(k ? segs[k - 1][1] : P[i]);
    out.T2.push(k < knots.length - 1 ? segs[k][0] : P[i]);
  });
  return out;
}

const pt = (p, ind) => `${ind}<Point3d>\n${ind}\t<x>${f6(p[0])}</x>\n${ind}\t<y>${f6(p[1])}</y>\n${ind}\t<z>${f6(p[2])}</z>\n${ind}</Point3d>\n`;
function poly(tag, pts, sym, plan, ind) {
  const i2 = ind + '\t', i3 = i2 + '\t';
  return `${ind}<${tag}>\n${i2}<Polygone3d>\n${i3}<Nb_of_points>${pts.length}</Nb_of_points>\n${i3}<Open>1</Open>\n${i3}<Symmetry>${sym}</Symmetry>\n`
    + `${i3}<Symmetry_center>\n${pt([pts.length ? pts[0][0] : 0, 0, 0].map((v, k) => (k ? 0 : sym === 6 && plan === 3 ? v : 0)), i3 + '\t')}${i3}</Symmetry_center>\n${i3}<Plan>${plan}</Plan>\n`
    + pts.map((p) => pt(p, i3)).join('') + `${i2}</Polygone3d>\n${ind}</${tag}>\n`;
}
/** A Bezier3d block. ct / tt: each knot's control and tangent type codes (as Shape3D writes them). */
function bezXml(name, c, { open, sym, plan, ct, tt }, ind) {
  const n = c.P.length, i2 = ind + '\t';
  let s = `${ind}<Bezier3d>\n${i2}<Name>${name}</Name>\n${i2}<Degree>3</Degree>\n${i2}<Open>${open}</Open>\n${i2}<Symmetry>${sym}</Symmetry>\n${i2}<Plan>${plan}</Plan>\n`;
  s += poly('Control_points', c.P, sym, plan, i2) + poly('Tangents_1', c.T1, sym, plan, i2) + poly('Tangents_2', c.T2, sym, plan, i2);
  s += poly('Tangents_m', c.P.map(() => [0, 0, 0]), 0, 0, i2);
  for (let k = 0; k < n; k++) s += `${i2}<Control_type_point_${k}> ${ct(k, n)}</Control_type_point_${k}>\n`;
  for (let k = 0; k < n; k++) s += `${i2}<Tangent_type_point_${k}> ${tt(k, n)}</Tangent_type_point_${k}>\n`;
  return s + `${ind}</Bezier3d>\n`;
}
const ends = (e, mid) => (k, n) => (k === 0 || k === n - 1 ? e : mid);
const LONG = { open: 1, sym: 0, plan: 2, ct: ends(32, 0), tt: ends(0, 2) };     // a curve in the side view
const TOP = { open: 0, sym: 6, plan: 1, ct: ends(32, 0), tt: ends(0, 2) };      // a curve in the plan view (mirrored)
const CPL = { open: 0, sym: 6, plan: 3, ct: (k) => [224, 33, 98, 32, 224][k], tt: (k) => [32, 0, 16, 2, 32][k] };

function curveDef(name, c, top, np, edited, color, ind) {
  const i2 = ind + '\t', i3 = i2 + '\t';
  return `${i2}<BezierDef>\n${i3}<Top>${top ? 1 : 0}</Top>\n${i3}<NpCouple>${np}</NpCouple>\n${i3}<Edited>${edited}</Edited>\n${i3}<Displayed>1</Displayed>\n`
    + `${i3}<DisplayCurvature>0</DisplayCurvature>\n${i3}<DisplayCurvatureRadius>0</DisplayCurvatureRadius>\n${i3}<DisplayCurvatureRadiusDir>0</DisplayCurvatureRadiusDir>\n${i3}<DisplayGuidelines>0</DisplayGuidelines>\n`
    + `${i3}<Color>${color}</Color>\n${i3}<ColorCurvature>255</ColorCurvature>\n${i3}<ColorCurvatureRadius>255</ColorCurvatureRadius>\n${i3}<ColorCurvatureRadiusDir>255</ColorCurvatureRadiusDir>\n${i3}<ColorGuidelines>65280</ColorGuidelines>\n`
    + `${i3}<DisplayedPlan>0</DisplayedPlan>\n${i3}<FixedRelativeTo>-1</FixedRelativeTo>\n` + bezXml(name, c, top ? TOP : LONG, i3) + `${i2}</BezierDef>\n`;
}

/** Write the board as a Shape3D X design (text). name: the design's name. */
export function exportS3dx(board, name = 'Trey Shaper board') {
  const pr = board._profiles, p = board.params, M = pr.M, n = pr.x.length, L = p.length;
  const Md = Math.round(0.45 * M), Mr = Math.round(0.15 * M);
  const X = Array.from(pr.x, (v) => v * IN);
  const row = (i, m) => [X[i], pr.Y[i * M + m] * IN, pr.Z[i * M + m] * IN];
  const zbot = (i) => pr.Z[i * M + M - 1] * IN, ztop = (i) => pr.Z[i * M] * IN;
  // the swallow's cut is left to Shape3D: inside it, the stringer lines carry on from the crotch
  const sd = p.tail_type === 'swallow' ? p.swallow_depth || 0 : 0;
  const near = (x) => { let b = 0; for (let i = 0; i < n; i++) if (Math.abs(pr.x[i] - x) < Math.abs(pr.x[b] - x)) b = i; return b; };
  const iCut = sd > 0 ? near(sd + 2) : 0;                 // clear of the inside rail bevel
  const lineAlong = (f) => { const P = []; for (let i = 0; i < n; i++) P.push(f(i)); return P; };
  const slopeAt = (i) => unit(sub(lineAlong((j) => [X[j], 0, zbot(j)])[Math.min(i + 1, n - 1)], [X[Math.max(i - 1, 0)], 0, zbot(Math.max(i - 1, 0))]));
  // inside a swallow's cut the board's stringer is cut away: there the stringer lines follow the designed rocker
  // and thickness (the board's own profiles), offset to meet the real stringer lines at the crotch, so they carry
  // straight on through the cut without a jump or a dive (Shape3D cuts the swallow itself)
  const zbD = (i) => pr.zb[i] * IN, tD = (i) => pr.t[i] * IN;
  const oBot = iCut ? zbot(iCut) - zbD(iCut) : 0, oTop = iCut ? ztop(iCut) - zbD(iCut) - tD(iCut) : 0;
  const botAt = (i) => (i < iCut ? zbD(i) + oBot : zbot(i)), topAt = (i) => (i < iCut ? zbD(i) + tD(i) + oTop : ztop(i));
  const extend = (P, top) => { for (let i = 0; i < iCut; i++) P[i] = [X[i], 0, top ? topAt(i) : botAt(i)]; return P; };
  const tolL = 0.04;                                       // cm, about 1/64"
  const wide = near(L / 2 + (p.wide_point_offset || 0)), low = (() => { let b = 0; for (let i = 0; i < n; i++) if (pr.zb[i] < pr.zb[b]) b = i; return b; })();
  // outline: the apex (widest) line in plan
  const Po = lineAlong((i) => [X[i], pr.h[i] * IN, 0]);
  const otl = fitCurve(Po, [wide], tolL, 24, (i) => (i === wide ? [1, 0, 0] : null));
  const PbRaw = extend(lineAlong((i) => [X[i], 0, zbot(i)]), false);
  const strBot = fitCurve(PbRaw, [low], tolL, 24, (i) => (i === low ? [1, 0, 0] : null));
  const strDeck = fitCurve(extend(lineAlong((i) => [X[i], 0, ztop(i)]), true), [], tolL);
  // the rail edge (tuck point) and apex paths, in plan and in the side view
  const railTop = fitCurve(lineAlong((i) => [X[i], pr.Y[i * M + Md + Mr] * IN, 0]), [], tolL);
  const apexTop = fitCurve(lineAlong((i) => [X[i], pr.Y[i * M + Md] * IN, 0]), [wide], tolL, 24, (i) => (i === wide ? [1, 0, 0] : null));
  const railSide = fitCurve(lineAlong((i) => [X[i], 0, pr.Z[i * M + Md + Mr] * IN]), [], tolL);
  const apexSide = fitCurve(lineAlong((i) => [X[i], 0, pr.Z[i * M + Md] * IN]), [], tolL);

  // a cross section at station i: bottom stringer, rail edge, apex, deck shoulder, deck stringer
  const couple = (i) => {
    const P = [];
    if (i < iCut) {
      // inside a swallow's cut: the section just ahead of the crotch, stretched to this station's width and set
      // between its stringer lines (a whole section from the stringer; Shape3D cuts the swallow out of it)
      const j = iCut, b0 = zbot(j), t0 = ztop(j) - b0, sy = pr.h[i] / Math.max(pr.h[j], 1e-6), sz = (topAt(i) - botAt(i)) / Math.max(t0, 1e-6);
      for (let m = M - 1; m >= 0; m--) { const q = row(j, m); P.push([X[i], q[1] * sy, botAt(i) + (q[2] - b0) * sz]); }
    } else for (let m = M - 1; m >= 0; m--) P.push(row(i, m));
    if (P[0][1] > 1e-6) P.unshift([X[i], 0, P[0][2]]);     // closed to the stringer
    const off = P.length - M, iE = off + (M - 1 - (Md + Mr)), iA = off + (M - 1 - Md);
    // the deck shoulder: where the deck has come in to 85% of the apex's width
    let iD = iA + 1; const yA = P[iA][1];
    while (iD < P.length - 2 && P[iD][1] > 0.85 * yA) iD++;
    const knots = [0, iE, iA, iD, P.length - 1];
    const T = (k, side) => {
      const j = knots[k];
      if (k === 0) return [0, 1, 0];
      if (k === 4) return [0, -1, 0];
      if (k === 2) return [0, 0, 1];
      return k === 1 ? tangentAt(P, j, side) : tangentAt(P, j);
    };
    const c = { P: knots.map((j) => P[j]), T1: [], T2: [] };
    const segs = [];
    for (let k = 0; k < 4; k++) segs.push(fitSegment(P, knots[k], knots[k + 1], T(k, 1), T(k + 1, -1)));
    for (let k = 0; k < 5; k++) { c.T1.push(k ? segs[k - 1][1] : c.P[k]); c.T2.push(k < 4 ? segs[k][0] : c.P[k]); }
    return c;
  };
  // couples: the tail, 6" and 12" in, the wide point, 12" and 6" from the nose, the nose, and the cross sections
  // edited by hand, kept at least 3" apart
  const want = [0, 6, 12, (L / 2 + (p.wide_point_offset || 0) + 12) / 2, L / 2 + (p.wide_point_offset || 0), (L / 2 + L - 12) / 2, L - 12, L - 6, L];
  for (const s of p.slices || []) want.push(s.x);
  want.sort((a, b) => a - b);
  const xs = [];
  for (const x of want) if (x >= 0 && x <= L && (!xs.length || x - xs[xs.length - 1] >= 3 || x === L)) { if (x === L && xs.length && L - xs[xs.length - 1] < 3) xs.pop(); xs.push(x); }
  const iC = [...new Set(xs.map(near))].sort((a, b) => a - b);
  const C = iC.map(couple);
  // the three reference sections Shape3D shows: 12" from the tail, the centre, 12" from the nose
  const ref = [near(12), near(L / 2), near(L - 12)].map(couple);

  let curves = '';
  const blk = (tag, nm, c, kind) => `\t\t<${tag}>\n` + bezXml(nm, c, kind, '\t\t\t') + `\t\t</${tag}>\n`;
  curves += blk('Otl', '', otl, { ...TOP, tt: (k, nn) => (k === 0 || k === nn - 1 ? 0 : otl.knots[k] === wide ? 16 : 2) });
  curves += blk('StrBot', 'Stringer Bot', strBot, { ...LONG, tt: (k, nn) => (k === 0 || k === nn - 1 ? 0 : strBot.knots[k] === low ? 32 : 2) });
  curves += blk('StrDeck', 'Stringer Top', strDeck, LONG);
  curves += blk('SliceTail', '', ref[0], CPL) + blk('SliceCenter', '', ref[1], CPL) + blk('SliceNose', '', ref[2], CPL);
  const defTop = `\t\t<curveDefTop1>\n${curveDef('Rail', railTop, true, 1, 0, 65280, '\t\t')}\t\t</curveDefTop1>\n`
    + `\t\t<curveDefTop2>\n${curveDef('Apex', apexTop, true, 2, 0, 16744448, '\t\t')}\t\t</curveDefTop2>\n`;
  const defSide = `\t\t<curveDefSide0>\n${curveDef('Stringer Bot', strBot, false, 0, 1, 0, '\t\t')}\t\t</curveDefSide0>\n`
    + `\t\t<curveDefSide1>\n${curveDef('Rail', railSide, false, 1, 0, 0, '\t\t')}\t\t</curveDefSide1>\n`
    + `\t\t<curveDefSide2>\n${curveDef('Apex', apexSide, false, 2, 0, 16744448, '\t\t')}\t\t</curveDefSide2>\n`
    + `\t\t<curveDefSide4>\n${curveDef('Stringer Top', strDeck, false, 4, 1, 0, '\t\t')}\t\t</curveDefSide4>\n`;
  const couples = C.map((c, k) => `\t\t<Couples_${k}>\n\t\t\t<Dessus>1</Dessus>\n\t\t\t<Dessous>1</Dessous>\n\t\t\t<Displayed>0</Displayed>\n\t\t\t<Color>0</Color>\n`
    + bezXml('cpl', c, CPL, '\t\t\t') + `\t\t</Couples_${k}>\n`).join('');

  // the numbers Shape3D shows in its header
  let dev = 0, area = 0, tMax = 0;
  for (let i = 1; i < n; i++) { dev += Math.hypot(X[i] - X[i - 1], zbot(i) - zbot(i - 1)); area += (pr.h[i] + pr.h[i - 1]) * (X[i] - X[i - 1]) * IN; }
  for (let i = 0; i < n; i++) tMax = Math.max(tMax, (pr.Z[i * M] - pr.Z[i * M + M - 1]) * IN);
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]).replace(/[^\x20-\x7e]/g, '');
  const v = {
    Name: esc(name), Author: 'Trey Shaper', Comment: 'Exported from Trey Shaper', User: '',
    Length: f3(L * IN), LengthDev: f3(dev), Width: f3(2 * Math.max(...pr.h) * IN), Thickness: f3(tMax),
    Tail_rocker: f3(zbot(0)), Nose_rocker: f3(zbot(n - 1)), Volume: f3(board.volume_l * 10), SurfaceProj: f3(area),
    CategoryType: L < 84 ? 'Shortboard' : L < 108 ? 'Funboard' : 'Longboard', NbBoxesFastLoad: 0, nbcdTop: 15, nbcdSide: 15,
    Number_of_slices: C.length, Nb_Boxes: 0, CURVES: curves, DEFTOP: defTop, DEFSIDE: defSide, COUPLES: couples,
  };
  return TEMPLATE.replace(/\{([A-Za-z_]+)\}/g, (all, k) => (k in v ? v[k] : all));
}

/** The rest of a Shape3D X file (display settings, scene), from a design saved by Shape3D X 9.1. */
const TEMPLATE = `<?xml version="1.0" encoding="iso-8859-1"?>
<Shape3d_design>
	<Board>
		<Version>9</Version>
		<VersionNumber>9.1.3.4</VersionNumber>
		<Name>{Name}</Name>
		<Author>{Author}</Author>
		<Comment>{Comment}</Comment>
		<User>{User}</User>
		<Length>{Length}</Length>
		<LengthDev>{LengthDev}</LengthDev>
		<Width>{Width}</Width>
		<Thickness>{Thickness}</Thickness>
		<Tail_rocker>{Tail_rocker}</Tail_rocker>
		<Nose_rocker>{Nose_rocker}</Nose_rocker>
		<StringerMeasurement>1</StringerMeasurement>
		<Volume>{Volume}</Volume>
		<SurfaceProj>{SurfaceProj}</SurfaceProj>
		<Category>Surfboard</Category>
		<CategoryType>{CategoryType}</CategoryType>
		<NbCalquesFastLoad>0</NbCalquesFastLoad>
		<NbBoxesFastLoad>{NbBoxesFastLoad}</NbBoxesFastLoad>
		<MinVersion>0</MinVersion>
		<RockerLengthRescaleRatio>1.000</RockerLengthRescaleRatio>
		<WidthLengthRescaleRatio>1.000</WidthLengthRescaleRatio>
		<ThicknessLengthRescaleRatio>1.000</ThicknessLengthRescaleRatio>
		<StockLMin>0.000</StockLMin>
		<StockLMax>0.000</StockLMax>
		<VCResizeThickness>0</VCResizeThickness>
		<VCResizeRocker>1</VCResizeRocker>
		<VCResizeNone>0</VCResizeNone>
		<Symmetry>6</Symmetry>
{CURVES}		<nbcdTop>{nbcdTop}</nbcdTop>
{DEFTOP}
		<nbcdSide>{nbcdSide}</nbcdSide>
{DEFSIDE}
		<ThicknessZStretchTop>1</ThicknessZStretchTop>
		<ThicknessZStretchSide>1</ThicknessZStretchSide>
		<iFixedCurveTop>-1</iFixedCurveTop>
		<iFixedFromTop>-1</iFixedFromTop>
		<iFixedCurveSide>-1</iFixedCurveSide>
		<iFixedFromSide>-1</iFixedFromSide>
		<AfficheCourbureThck>0</AfficheCourbureThck>
		<ColorThck>0</ColorThck>
		<ColorCourbureThck>255</ColorCourbureThck>
		<AfficheCourbureCpl>0</AfficheCourbureCpl>
		<AfficheGuidelinesCpl>0</AfficheGuidelinesCpl>
	 	<ColorCpl>0</ColorCpl>
		<ColorCourbureCpl>255</ColorCourbureCpl>
		<ColorGuidelinesCpl>65280</ColorGuidelinesCpl>
		<NbOptionsPlan>1</NbOptionsPlan>
		<SelectedOptionsPlan>0</SelectedOptionsPlan>
		<OptionsPlan_0>
		<OptionsPlan>
			<Nom>Plan 0</Nom>
			<DisplayPlanTop>1	</DisplayPlanTop>
			<DisplayPlanTopOnly>0	</DisplayPlanTopOnly>
			<DisplayPlanBot>0	</DisplayPlanBot>
			<DisplayPlanSide>1	</DisplayPlanSide>
			<DisplayPlanSlice>0	</DisplayPlanSlice>
			<PlanSliceX>0.000	</PlanSliceX>
			<CsteSpacingPlan>0	</CsteSpacingPlan>
			<SpacingPlan>10.000	</SpacingPlan>
			<ZoomCadragePlan>100	</ZoomCadragePlan>
			<UseMeasBarsPlanTop>0	</UseMeasBarsPlanTop>
			<UseMeasBarsPlanSide>0	</UseMeasBarsPlanSide>
			<UseMeasBarsPlanCpl>0	</UseMeasBarsPlanCpl>
			<DisplayMainContours>1	</DisplayMainContours>
			<DisplaySlicesTopView>1	</DisplaySlicesTopView>
			<DisplayVConc>1	</DisplayVConc>
			<DisplayPlanOrgShape>0	</DisplayPlanOrgShape>
			<DisplayPlanCartoucheDims>1	</DisplayPlanCartoucheDims>
			<DisplayPlanCartoucheVol>1	</DisplayPlanCartoucheVol>
			<DisplayPlanCartoucheSurf>0	</DisplayPlanCartoucheSurf>
			<DisplayPlanCartoucheAR>0	</DisplayPlanCartoucheAR>
			<DisplayPlanComments>0	</DisplayPlanComments>
			<DisplayPlanCG>1	</DisplayPlanCG>
			<DisplayPlanLengthDevProj>1	</DisplayPlanLengthDevProj>
			<DisplayPlanMeasMethod>1	</DisplayPlanMeasMethod>
		</OptionsPlan>	</OptionsPlan_0>
		<Number_of_slices>{Number_of_slices}</Number_of_slices>
{COUPLES}
		<Nb_Boxes>{Nb_Boxes}</Nb_Boxes>
		<Sandwich>0.000</Sandwich>
		<Color>16777215</Color>
		<ColorBot>16777215</ColorBot>
		<ColorRail>16777215</ColorRail>
		<Reflexion_coef>22</Reflexion_coef>
		<Nb_of_computed_slices>150</Nb_of_computed_slices>
		<Nb_of_lines>20</Nb_of_lines>
		<Reflexion_coef_Bot>-1</Reflexion_coef_Bot>
		<Reflexion_coef_Rail>-1</Reflexion_coef_Rail>
		<Color_Maillage>0</Color_Maillage>
		<Color_CouplesDef>255</Color_CouplesDef>
		<MaillageStraightBot>1</MaillageStraightBot>
		<MaillageCouplesDef>1</MaillageCouplesDef>
		<DefAll>0</DefAll>
		<DefEdgesOnly>0</DefEdgesOnly>
		<DisplayBothSides>1</DisplayBothSides>
		<DisplayDeck>1</DisplayDeck>
		<DisplayBot>1</DisplayBot>
		<ImageMappingDeck>0</ImageMappingDeck>
		<ImageMappingBot>0</ImageMappingBot>
		<ImageMappingRail>0</ImageMappingRail>
		<ExtendDecoBot>1</ExtendDecoBot>
		<ExtendDecoRail>0</ExtendDecoRail>
		<DuplicateDecoBot>1</DuplicateDecoBot>
		<DecoSideMargin>    2.54</DecoSideMargin>
		<DecoSideMarginBot>    0.00</DecoSideMarginBot>
		<Xmin3D>-1.000000</Xmin3D>
		<Xmax3D>-1.000000</Xmax3D>
		<OpenContourTail>0</OpenContourTail>
		<Deco_origin>
			<Point3d>
				<x>0.000000</x>
				<y>0.000000</y>
				<z>0.000000</z>
			</Point3d>
		</Deco_origin>
		<NbStringers>1</NbStringers>
		<Stringer_0>
			<StringerD3D>
				<Name></Name>
				<Width>0.500</Width>
				<Shift>0.000</Shift>
				<Tilt>0.000</Tilt>
				<ColorD3D>7378607</ColorD3D>
				<MappingD3D>1</MappingD3D>
				<ImageMappedD3D>Bass</ImageMappedD3D>
				<DisplayD3D>1</DisplayD3D>
				<SuperpositionOrder>1</SuperpositionOrder>
			</StringerD3D>
		</Stringer_0>
	</Board>
	<GhostImgCplNum_1>0</GhostImgCplNum_1>
	<GhostImgCplNum_2>0</GhostImgCplNum_2>
	<GhostImgCplNum_3>0</GhostImgCplNum_3>
	<GhostImgCplNum_4>0</GhostImgCplNum_4>
	<GhostImgCplNum_5>0</GhostImgCplNum_5>
	<GhostImgCplNum_6>0</GhostImgCplNum_6>
	<GhostImgCplNum_7>0</GhostImgCplNum_7>
	<GhostImgCplNum_8>0</GhostImgCplNum_8>
	<GhostImgCplNum_9>0</GhostImgCplNum_9>
	<GhostImgCplNum_10>0</GhostImgCplNum_10>
	<Scene>
		<Version>1.2</Version>
		<Background_color>16777215</Background_color>
		<Lighting>
		<Version>9.000</Version>
			<Ecl>
			<Point3d>
				<x>114.580655</x>
				<y>-218.901251</y>
				<z>-493.042134</z>
			</Point3d></Ecl>
			<Color>16777215</Color>
			<ColorSpot>16777215</ColorSpot>
			<Intensity>0.650</Intensity>
			<Intensity2>0.000</Intensity2>
			<IntensityAmbient>0.500</IntensityAmbient>
			<IntensitySpec>1.000</IntensitySpec>
		</Lighting>
		<Camera>
			<Version>1.2</Version>
			<Crot>
			<Point3d>
				<x>0.000000</x>
				<y>0.000000</y>
				<z>-3.326746</z>
			</Point3d></Crot>
			<Cvis>
			<Point3d>
				<x>-0.015498</x>
				<y>-1.128943</y>
				<z>-0.197451</z>
			</Point3d></Cvis>
			<Ccam>
			<Point3d>
				<x>1.706389</x>
				<y>124.300686</y>
				<z>-347.873298</z>
			</Point3d></Ccam>
			<Alpha>0.000</Alpha>
			<Oy>
			<Point3d>
				<x>0.012912</x>
				<y>0.940559</y>
				<z>0.339386</z>
			</Point3d></Oy>
			<Ur>
			<Point3d>
				<x>0.000000</x>
				<y>0.000000</y>
				<z>1.000000</z>
			</Point3d></Ur>
			<DimObj>184.807</DimObj>
			<View>
				<Version>1.2</Version>
				<Wh>571.000</Wh>
				<Ww>1264.000</Ww>
				<Wox>372.455</Wox>
				<Woy>25.955</Woy>
				<Uh>46.000</Uh>
				<Uw>184.807</Uw>
				<Uxmin>0.000</Uxmin>
				<Uymin>0.000</Uymin>
				<Cxy>6.218</Cxy>
				<Mrgx>0.050</Mrgx>
				<Mrgy>0.050</Mrgy>
				<Police>MS Sans Serif</Police>
				<OverSample>1</OverSample>
				<Grid>10.000</Grid>
			</View>
		</Camera>
		<ReflexionMap>None</ReflexionMap>
		<DisplaySkyBox>0</DisplaySkyBox>
	</Scene>
</Shape3d_design>`;
