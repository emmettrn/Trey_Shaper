/**
 * Shape3D (.s3dx) import. A .s3dx file is XML from Shape3D X: the board as Bezier curves in
 * centimetres (outline, bottom stringer, deck stringer, a few cross sections, fin boxes). This
 * reads those curves, then fits a Trey Shaper design to them:
 *  - the outline with the photo trace's fitter (nose / tail type, widths, a few anchor points),
 *  - rocker and thickness from the measurements at the tips, 12" in and the low / thick point,
 *    then a few anchor points where the curve still strays,
 *  - each cross section between the tips as a Trey Shaper cross section (apex height, tuck, the
 *    tuck point's arms, concave or vee, rail fullness).
 * Fin boxes are left out (fins are not part of Trey Shaper). No DOM: runs in the browser and in Node.
 */
import { fitOutline } from './trace.js?v=26';

const CM = 1 / 2.54;
const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r16 = (v) => Math.round(v * 16) / 16;
const r4 = (v) => Math.round(v * 4) / 4;

/** The inside of the first <tag>...</tag> in text (or null). */
function block(text, tag) {
  const a = text.indexOf(`<${tag}>`); if (a < 0) return null;
  const b = text.indexOf(`</${tag}>`, a); if (b < 0) return null;
  return text.slice(a + tag.length + 2, b);
}
const numOf = (text, tag) => { const v = block(text, tag); return v === null ? NaN : parseFloat(v); };

/** The points of a Polygone3d block, skipping its symmetry centre. */
function points(poly) {
  if (!poly) return [];
  const body = poly.replace(/<Symmetry_center>[\s\S]*?<\/Symmetry_center>/g, '');
  const out = [], re = /<Point3d>\s*<x>([^<]*)<\/x>\s*<y>([^<]*)<\/y>\s*<z>([^<]*)<\/z>\s*<\/Point3d>/g;
  let m;
  while ((m = re.exec(body))) out.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  return out;
}

/** A Bezier3d block: on-curve points P, incoming handles T1, outgoing handles T2. */
function bezier(text) {
  const bz = block(text, 'Bezier3d'); if (!bz) return null;
  const P = points(block(bz, 'Control_points')), T1 = points(block(bz, 'Tangents_1')), T2 = points(block(bz, 'Tangents_2'));
  return P.length >= 2 && T1.length === P.length && T2.length === P.length ? { P, T1, T2 } : null;
}

/** Points along a Bezier curve (cm): segment i runs P[i], T2[i], T1[i + 1], P[i + 1]. */
function sample(bz, per = 60) {
  const out = [];
  for (let i = 0; i < bz.P.length - 1; i++) {
    const a = bz.P[i], b = bz.T2[i], c = bz.T1[i + 1], d = bz.P[i + 1];
    for (let j = i ? 1 : 0; j <= per; j++) {
      const t = j / per, s = 1 - t, w0 = s * s * s, w1 = 3 * s * s * t, w2 = 3 * s * t * t, w3 = t * t * t;
      out.push([0, 1, 2].map((k) => w0 * a[k] + w1 * b[k] + w2 * c[k] + w3 * d[k]));
    }
  }
  return out;
}

/** A curve that runs along the board as a function of x (inches): f(x) from coordinate k (inches). */
function along(pts, k) {
  const q = pts.map((p) => [p[0] * CM, p[k] * CM]).sort((a, b) => a[0] - b[0]);
  const X = [], Y = [];
  for (const [x, y] of q) if (!X.length || x - X[X.length - 1] > 1e-6) { X.push(x); Y.push(y); }
  return (x) => {
    if (x <= X[0]) return Y[0];
    if (x >= X[X.length - 1]) return Y[Y.length - 1];
    let lo = 0, hi = X.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (X[mid] <= x) lo = mid; else hi = mid; }
    return Y[lo] + ((x - X[lo]) / (X[hi] - X[lo])) * (Y[hi] - Y[lo]);
  };
}

/** Read a .s3dx file: its name, length and curves (inches), cross sections and stated volume. */
export function readS3dx(text) {
  if (!/<Shape3d_design>/.test(text)) throw new Error('not a Shape3D design');
  const board = block(text, 'Board') || text;
  const otl = bezier(block(board, 'Otl') || ''), bot = bezier(block(board, 'StrBot') || ''), deck = bezier(block(board, 'StrDeck') || '');
  if (!otl || !bot || !deck) throw new Error('the file has no outline or stringer curves');
  const L = (otl.P[otl.P.length - 1][0] - otl.P[0][0]) * CM;
  const x0 = otl.P[0][0];
  const shift = (bz) => ({ P: bz.P.map((p) => [p[0] - x0, p[1], p[2]]), T1: bz.T1.map((p) => [p[0] - x0, p[1], p[2]]), T2: bz.T2.map((p) => [p[0] - x0, p[1], p[2]]) });
  const sections = [];
  const n = numOf(board, 'Number_of_slices');
  for (let k = 0; k < (Number.isFinite(n) ? n : 0); k++) {
    const c = block(board, `Couples_${k}`); if (!c) continue;
    const bz = bezier(c); if (!bz) continue;
    sections.push({ x: (bz.P[0][0] - x0) * CM, ...bz });
  }
  return {
    name: (block(board, 'Name') || '').trim(), L, volume: numOf(board, 'Volume') / 10,     // Shape3D keeps the volume in decilitres
    hw: along(sample(shift(otl)), 1), bot: along(sample(shift(bot)), 2), deck: along(sample(shift(deck)), 2), sections,
  };
}

/** Half the area of a file cross section (in², from the stringer out). */
function halfArea(sec) {
  const pts = sample(sec, 40).map((q) => [q[1] * CM, q[2] * CM]);
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
  return Math.abs(a) / 2;
}
/** Half the area of the built board's cross section at x (in²). The section's deck runs stringer -> apex, its bottom stringer -> apex too. */
let sectionAtFn = null;
export function setSectionAt(fn) { sectionAtFn = fn; }
function sectionHalfArea(board, x) {
  const q = sectionAtFn(board, x), Y = [...q.deck.y, ...[...q.bottom.y].reverse()], Z = [...q.deck.z, ...[...q.bottom.z].reverse()];
  let a = 0;
  for (let i = 0; i < Y.length; i++) { const j = (i + 1) % Y.length; a += Y[i] * Z[j] - Y[j] * Z[i]; }
  return Math.abs(a) / 2;
}

/** One cross section's settings, from its control points (Shape3D's usual 5: bottom centre, tuck, apex, deck shoulder, deck centre). */
function sectionSettings(sec) {
  const P = sec.P.map((p) => [p[1] * CM, p[2] * CM]), T1 = sec.T1.map((p) => [p[1] * CM, p[2] * CM]), T2 = sec.T2.map((p) => [p[1] * CM, p[2] * CM]);
  let ia = 0;
  for (let i = 1; i < P.length; i++) if (P[i][0] > P[ia][0]) ia = i;
  const ie = Math.max(ia - 1, 0), last = P.length - 1;
  const [y0, z0] = P[0], [yE, zE] = P[ie], [yA, zA] = P[ia], zD = P[last][1];
  if (!(yA > 0.2) || ie === 0) return null;
  const lift = z0 - zE;                                    // the stringer above the edge: concave (+) or vee (-)
  const zLine = Math.min(z0, zE);                          // Trey Shaper's bottom line: the edge for a concave, the stringer for a vee
  const bottomDir = [P[ie][0] - T1[ie][0], P[ie][1] - T1[ie][1]], out = [T2[ie][0] - P[ie][0], T2[ie][1] - P[ie][1]];
  const bl = Math.hypot(...bottomDir) || 1, ol = Math.hypot(...out) || 1;
  const ang = Math.atan2(bottomDir[0] * out[1] - bottomDir[1] * out[0], bottomDir[0] * out[0] + bottomDir[1] * out[1]) * 180 / Math.PI;
  // rail fullness: the deck's superellipse exponent through the deck at 80% of the half width
  const pts = sample({ P: sec.P.slice(ia), T1: sec.T1.slice(ia), T2: sec.T2.slice(ia) }, 80).map((p) => [p[1] * CM, p[2] * CM]);
  let H = null;
  for (let i = 1; i < pts.length; i++) {
    const [ya, za] = pts[i - 1], [yb, zb] = pts[i];
    if ((ya - 0.8 * yA) * (yb - 0.8 * yA) <= 0 && Math.abs(yb - ya) > 1e-9) { H = za + ((0.8 * yA - ya) / (yb - ya)) * (zb - za) - zA; break; }
  }
  const td = zD - zA;
  let ed = 2.4;
  if (H !== null && td > 0.05) {
    const r = clip(H / td, 0.05, 0.999);
    let lo = 1.2, hi = 6;
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (0.8 ** m + r ** m > 1) hi = m; else lo = m; }
    ed = (lo + hi) / 2;
  }
  return {
    x: sec.x, apex_in: Math.max(zA - zLine, 0.05), tuck: Math.max(yA - yE, 0), concave: Math.max(lift, 0), vee: Math.max(-lift, 0),
    fullness: clip((ed - 1.7) / 1.4, 0, 1), edgeAngle: clip(ang, 0, 90), edgeRail: clip(ol / Math.hypot(yA - yE, zA - zE), 0.02, 1),
  };
}

/**
 * Fit a Trey Shaper design to a .s3dx file. build = buildBoard, base = sectionBase, types = { NOSE_TYPES, TAIL_TYPES },
 * current = the design to start from (its settings that a .s3dx file does not describe are kept).
 * Returns { params, report }.
 */
export function importS3dx(text, build, base, types, current) {
  const s = readS3dx(text), L = s.L;
  const thick = (x) => s.deck(x) - s.bot(x);
  const p = structuredClone(current);
  Object.assign(p, {
    anchors: { outline: [], rocker: [], thickness: [], swallow: [] }, handles: {}, marks: [], slices: [], tools: [], bottom: [], deck_contours: [],
    curve_v: 2, lock_volume: false, concave_depth: 0, vee_depth: 0, deck_dome: 0, deck_flat: 0,
  });
  // rocker and thickness from their measurements
  let xl = L / 2, low = Infinity, xt = L / 2, tmax = 0;
  for (let x = 0; x <= L; x += 0.125) { if (s.bot(x) < low) { low = s.bot(x); xl = x; } if (thick(x) > tmax) { tmax = thick(x); xt = x; } }
  const half = L / 2;
  Object.assign(p, {
    tail_rocker: r16(s.bot(0) - low), nose_rocker: r16(s.bot(L) - low), rocker_low_point: r4(clip(xl - half, -(half - 14), half - 14)),
    tail_rocker_12: r16(s.bot(12) - low), nose_rocker_12: r16(s.bot(L - 12) - low),
    thickness: r16(tmax), thickness_point_offset: r4(clip(xt - half, -(half - 14), half - 14)),
    tail_thickness: r16(Math.max(thick(0.25), 0.25)), nose_thickness: r16(Math.max(thick(L - 0.25), 0.25)),
    tail_thickness_12: r16(thick(12)), nose_thickness_12: r16(thick(L - 12)),
  });
  // the outline: the photo trace's fitter, given the curve itself
  const pts = [];
  for (let x = 0; x <= L + 1e-9; x += 0.5) pts.push([Math.min(x, L), s.hw(Math.min(x, L))]);
  const fit = fitOutline(pts, L, p, build, types, null, s.hw);
  Object.assign(p, fit.params);
  // rocker and thickness: a few anchor points where the curve still strays (worst spot first, to 1/32")
  const greedy = (name, want, got, base0) => {
    const list = [];
    for (let round = 0; round < 8; round++) {
      const pr = build({ ...p, anchors: { ...p.anchors, [name]: list } })._profiles;
      const at = (arr, x) => { let i = 0; while (i < pr.x.length - 2 && pr.x[i + 1] < x) i++; const t = (x - pr.x[i]) / (pr.x[i + 1] - pr.x[i]); return arr[i] + t * (arr[i + 1] - arr[i]); };
      let worst = 0, wx = null;
      for (let x = 2; x <= L - 2; x += 0.25) {
        if ([12, L - 12, half + (name === 'rocker' ? p.rocker_low_point : p.thickness_point_offset)].some((q) => Math.abs(q - x) < 1.25) || list.some((a) => Math.abs(a[0] - x) < 2.5)) continue;
        const d = Math.abs(want(x) - at(pr[got], x));
        if (d > worst) { worst = d; wx = x; }
      }
      if (wx === null || worst < 1 / 32) break;
      const pr0 = build({ ...p, anchors: { ...p.anchors, [name]: [] } })._profiles;
      const at0 = (x) => { let i = 0; while (i < pr0.x.length - 2 && pr0.x[i + 1] < x) i++; const t = (x - pr0.x[i]) / (pr0.x[i + 1] - pr0.x[i]); return pr0[base0][i] + t * (pr0[base0][i + 1] - pr0[base0][i]); };
      list.push([+wx.toFixed(3), +(want(wx) - at0(wx)).toFixed(4)]);
      list.sort((a, b) => a[0] - b[0]);
    }
    p.anchors[name] = list;
  };
  greedy('rocker', (x) => s.bot(x) - low, 'zb', 'zb0');
  greedy('thickness', thick, 't', 'foil0');
  // cross sections: board-wide rail settings from the one nearest the middle, each section between the tips as a slice
  const secs = s.sections.map(sectionSettings).filter((q) => q && q.x > 2 && q.x < L - 2);
  if (secs.length) {
    const mid = secs.reduce((a, b) => (Math.abs(b.x - half) < Math.abs(a.x - half) ? b : a));
    const tailS = secs.reduce((a, b) => (b.x < a.x ? b : a)), noseS = secs.reduce((a, b) => (b.x > a.x ? b : a));
    Object.assign(p, { rail_apex_in: r16(mid.apex_in), rail_fullness: +mid.fullness.toFixed(2), hard_edge: false,
      rail_tuck_tail: r16(tailS.tuck), rail_tuck_nose: r16(noseS.tuck) });
    const b = build(p);
    let id = 1;
    for (const q of secs) {
      const sb = base(b.params, q.x), adj = {};
      const set = (k, v, lim) => { const d = v - sb[k]; if (Math.abs(d) > 1e-3) adj[k] = +clip(d, -lim, lim).toFixed(4); };
      set('rail_apex_in', q.apex_in, 1.5);
      set('rail_tuck_in', q.tuck, 4);
      set('rail_fullness', q.fullness, 1);
      set('concave', q.concave, 0.5);
      set('vee', q.vee, 0.5);
      Object.assign(adj, { edge_arms: 1, edge_arm_angle: +q.edgeAngle.toFixed(1), edge_arm_rail: +q.edgeRail.toFixed(3), edge_arm_flat: 0 });
      p.slices.push({ id: id++, x: +q.x.toFixed(3), adj, deck: [], bottom: [], v: 2 });
    }
  }
  // match each section's area to the file's (its rail fullness, a couple of Newton steps), so the volume comes out right
  if (p.slices.length) {
    const fileArea = secs.map((q) => halfArea(s.sections.find((sec) => Math.abs(sec.x - q.x) < 1e-6)));
    const areas = () => { const b = build(p); return p.slices.map((sl) => sectionHalfArea(b, sl.x)); };
    let A = areas();
    for (let it = 0; it < 3; it++) {
      const keep = p.slices.map((sl) => sl.adj.rail_fullness ?? 0);
      p.slices.forEach((sl, i) => { sl.adj.rail_fullness = keep[i] - 0.1; });   // (down: the fit often lands at full, where up would not move)
      const A2 = areas();
      p.slices.forEach((sl, i) => {
        const slope = (A[i] - A2[i]) / 0.1;
        const step = Math.abs(slope) > 1e-6 ? clip((fileArea[i] - A[i]) / slope, -0.5, 0.5) : 0;
        sl.adj.rail_fullness = +clip(keep[i] + step, -1, 1).toFixed(4);
      });
      A = areas();
      if (A.every((a, i) => Math.abs(a / fileArea[i] - 1) < 0.004)) break;
    }
  }
  const made = build(p);
  return {
    params: p,
    report: { name: s.name, nose: fit.nose, tail: fit.tail, outlineError: fit.error, volume: made.stats.volume_l, fileVolume: s.volume, sections: secs.length },
  };
}
