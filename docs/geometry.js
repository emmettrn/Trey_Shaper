/*
 * Parametric surfboard geometry, in the browser.
 *
 * A line-for-line port of surfboard/geometry.py so the app runs as a static web page.
 * The Python module stays the reference: tests/test_js_parity.py checks that both give
 * the same board (stations, volume, warnings) for every preset and random designs.
 *
 * Board space, inches:  x along the stringer (0 = tail, L = nose),  y across,  z up.
 */
import { DEFAULTS, NOSE_TYPES, TAIL_TYPES } from './data.js';

export const IN3_TO_L = 0.016387064;
const A_MIN = 1.2;
const K_MIN = 1.3, K_MAX = 6.0;
const P_MIN = 1.2, P_MAX = 8.0;

// Measurements that may be left blank (null). A blank value is filled in from the rest of
// the board: tips by proportion, 12" stations from these default curve exponents.
export const NULLABLE = ['nose_width_12', 'tail_width_12', 'tail_block_width', 'nose_rocker', 'nose_rocker_12',
  'tail_rocker_12', 'tail_rocker', 'nose_thickness', 'nose_thickness_12', 'tail_thickness_12', 'tail_thickness'];
const AUTO = { nose_a: 2.3, tail_a: 1.6, nose_k: 2.4, tail_k: 2.0, foil_p: 2.0 };
const ANCHOR_LIMIT = { outline: 6, rocker: 4, thickness: 2, swallow: 3 };   // max offset an anchor point may carry (inches)
const ANCHOR_GAP = 0.75;                                         // min spacing between anchors / pinned points
const GRID = 513;                                                // samples of a slice's deck / bottom offset curve
// What a cross-section slice may adjust, and by how much at most (added to the board-wide value there)
const ADJ = { rail_apex: 0.45, rail_apex_in: 1.5, rail_fullness: 1, deck_dome: 1, rail_hardness: 1, concave: 0.5, double: 0.5, vee: 0.5 };
// Bottom contour stations: what each type puts into the three channels [single concave, double concave, vee]
const BOTTOM_TYPES = {
  flat: () => [0, 0, 0], concave: (a) => [a, 0, 0], roll: (a) => [-a, 0, 0], double: (a) => [0, a, 0],
  concave_double: (a, b) => [a, b, 0], vee: (a) => [0, 0, a], vee_double: (a, b) => [0, b, a],
};
export const BOTTOM_LABELS = { flat: 'flat', concave: 'concave', roll: 'roll', double: 'double concave',
  concave_double: 'concave with double inside', vee: 'vee', vee_double: 'vee with double concave' };
const K2 = (3 / 7) ** 1.5 * (4 / 7) ** 2;                         // peak of eta^1.5 (1 - eta)^2, the double-concave shape

const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smoothstep = (t) => { t = clip(t, 0, 1); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------------------------
   Feet / inches / fractions (same rules as surfboard/units.py)
   --------------------------------------------------------------------------- */
function roundHalfEven(v) {           // Python's round(): keeps 1/16 rounding identical
  const f = Math.floor(v), d = v - f;
  if (Math.abs(d - 0.5) > 1e-9) return Math.round(v);
  return f % 2 === 0 ? f : f + 1;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export function fmtIn(inches, denom = 16) {
  const n = roundHalfEven(Math.abs(inches) * denom);
  const whole = Math.floor(n / denom), rem = n % denom;
  let s = String(whole);
  if (rem) { const g = gcd(rem, denom); const frac = `${rem / g}/${denom / g}`; s = whole ? `${whole} ${frac}` : frac; }
  return (inches < 0 && n ? '-' : '') + s + '"';
}

export function fmtFtin(inches, denom = 16) {
  const total = roundHalfEven(inches * denom);
  const feet = Math.floor(total / (12 * denom));
  return `${feet}'${fmtIn((total - feet * 12 * denom) / denom, denom)}`;
}

export function parseInches(text) {
  if (typeof text === 'number') return text;
  let s = String(text).trim().toLowerCase();
  if (!s) throw new Error('empty');
  s = s.replace(/[”“″]/g, '"').replace(/[’‘′]/g, "'").replace(/−/g, '-');
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1); }
  s = s.replace(/\b(feet|foot|ft)\b/g, "'").replace(/\b(inches|inch|in)\b/g, '"');
  let feet = 0;
  if (s.includes("'")) { const i = s.indexOf("'"); feet = num(s.slice(0, i).trim() || '0'); s = s.slice(i + 1); }
  s = s.replace(/"/g, ' ').replace(/-/g, ' ').replace(/\s*\/\s*/g, '/');
  const inches = s.split(/\s+/).filter(Boolean).reduce((a, tok) => a + num(tok), 0);
  const r = sign * (feet * 12 + inches);
  if (!Number.isFinite(r)) throw new Error('not a number');
  return r;
}
function num(tok) {
  const m = tok.match(/^(\d+)\/(\d+)$/);
  if (m) { if (+m[2] === 0) throw new Error('zero denominator'); return m[1] / m[2]; }
  const v = Number(tok);
  if (Number.isNaN(v)) throw new Error(`could not read "${tok}"`);
  return v;
}

/* ---------------------------------------------------------------------------
   Parameters
   --------------------------------------------------------------------------- */
const u12 = (L, x0, nose) => (nose ? (L - 12 - x0) / (L - x0) : (x0 - 12) / x0);

/** Loose input -> full parameter set. Accepts '19 3/4' strings, blanks, and designs saved by v1. */
export function paramsFromDict(d = {}) {
  d = { ...d };
  for (const [k, v] of Object.entries(d)) {
    if (!(k in DEFAULTS) || typeof DEFAULTS[k] !== 'number') continue;
    if (v === null || v === undefined || v === '' || v === 'auto') {
      if (NULLABLE.includes(k)) d[k] = null; else delete d[k];
    } else if (typeof v === 'string') d[k] = parseInches(v);
  }
  const base = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in d) base[k] = d[k];
  const L = base.length;
  const xl = L / 2 + base.rocker_low_point, xt = L / 2 + base.thickness_point_offset;
  for (const [side, nose] of [['nose', true], ['tail', false]]) {
    if (`${side}_kick` in d && !(`${side}_rocker_12` in d) && base[`${side}_rocker`] !== null)
      base[`${side}_rocker_12`] = base[`${side}_rocker`] * u12(L, xl, nose) ** Number(d[`${side}_kick`]);
    if ('foil_fullness' in d && !(`${side}_thickness_12` in d) && base[`${side}_thickness`] !== null) {
      const te = base[`${side}_thickness`];
      base[`${side}_thickness_12`] = te + (base.thickness - te) * (1 - u12(L, xt, nose) ** Number(d.foil_fullness));
    }
  }
  return base;
}

/**
 * Clamp into a buildable range and fill in blanks; returns [params, warnings].
 * params._auto lists the measurements that were blank. Same order and messages as Python.
 */
export function validated(src) {
  const p = { ...src };
  const w = [], auto = [];
  const clamp = (name, lo, hi, label) => {
    const v = p[name], nv = Math.min(Math.max(v, lo), hi);
    if (Math.abs(nv - v) > 1e-9) {
      w.push(label ? `${label} limited to ${fmtIn(nv)}` : `${name} clamped to ${nv.toFixed(2)}`);
      p[name] = nv;
    }
  };
  const fill = (name, value) => { if (p[name] === null || p[name] === undefined) { p[name] = value; auto.push(name); } };
  if (!(p.nose_type in NOSE_TYPES)) { w.push(`unknown nose_type '${p.nose_type}', using pointed`); p.nose_type = 'pointed'; }
  if (!(p.tail_type in TAIL_TYPES)) { w.push(`unknown tail_type '${p.tail_type}', using squash`); p.tail_type = 'squash'; }

  clamp('length', 40, 144);
  clamp('width', 14, 26);
  clamp('thickness', 1.5, 4.5);
  const L = p.length, W = p.width, half = L / 2;
  clamp('wide_point_offset', -(half - 14), half - 14);
  clamp('rocker_low_point', -(half - 14), half - 14);
  clamp('thickness_point_offset', -(half - 14), half - 14);

  const tail = TAIL_TYPES[p.tail_type];
  const xw = half + p.wide_point_offset;
  fill('nose_width_12', W * (1 - u12(L, xw, true) ** AUTO.nose_a) ** (1 / NOSE_TYPES[p.nose_type]));
  clamp('nose_width_12', 3, W - 0.5);
  fill('tail_block_width', 0.5 * W);
  if (!tail.closes) clamp('tail_block_width', 4, W - 2);
  const te0 = tail.closes ? 0 : p.tail_block_width / W;
  fill('tail_width_12', W * (te0 + (1 - te0) * (1 - u12(L, xw, false) ** AUTO.tail_a) ** (1 / tail.b)));
  clamp('tail_width_12', tail.closes ? 4 : p.tail_block_width + 0.5, W - 0.5);
  if (tail.notch) { clamp('swallow_width', 1, p.tail_block_width - 2 * tail.corner - 1); clamp('swallow_depth', 1, 10); }

  const rn = (1 - u12(L, xw, true) ** A_MIN) ** (1 / NOSE_TYPES[p.nose_type]);
  clamp('nose_width_12', W * rn, W - 0.5, 'width 12" from nose');
  const rt = (1 - u12(L, xw, false) ** A_MIN) ** (1 / tail.b);
  clamp('tail_width_12', W * (te0 + (1 - te0) * rt), W - 0.5, 'width 12" from tail');

  fill('nose_rocker', clip(6.6 - 0.022 * L, 4.0, 5.2));
  fill('tail_rocker', clip(1.3 + 0.012 * L, 1.5, 3.0));
  clamp('nose_rocker', 0, 12);
  clamp('tail_rocker', 0, 8);
  fill('nose_thickness', 0.35 * p.thickness);
  fill('tail_thickness', 0.5 * p.thickness);
  clamp('nose_thickness', 0.3, p.thickness);
  clamp('tail_thickness', 0.3, p.thickness);

  const xl = half + p.rocker_low_point, xt = half + p.thickness_point_offset;
  for (const [side, nose] of [['nose', true], ['tail', false]]) {
    const R = p[`${side}_rocker`]; let u = u12(L, xl, nose);
    fill(`${side}_rocker_12`, R * u ** (nose ? AUTO.nose_k : AUTO.tail_k));
    clamp(`${side}_rocker_12`, R * u ** K_MAX, R * u ** K_MIN, `rocker 12" from ${side}`);
    const te = p[`${side}_thickness`]; u = u12(L, xt, nose);
    const span = p.thickness - te;
    fill(`${side}_thickness_12`, te + span * (1 - u ** AUTO.foil_p));
    clamp(`${side}_thickness_12`, te + span * (1 - u ** P_MIN), te + span * (1 - u ** P_MAX), `thickness 12" from ${side}`);
  }
  clamp('rail_apex', 0.15, 0.6);
  for (const n of ['rail_fullness', 'deck_dome', 'rail_hardness_nose', 'rail_hardness_tail']) clamp(n, 0, 1);
  clamp('concave_depth', 0, 0.4);
  clamp('vee_depth', 0, 0.4);
  clamp('target_volume', 10, 120);
  p.stations = Math.trunc(clip(p.stations, 41, 401));
  p.section_points = Math.trunc(clip(p.section_points, 16, 128));
  if (Number.isFinite(p.rail_apex_in)) clamp('rail_apex_in', 0.1, 2.5); else p.rail_apex_in = null;
  p._auto = auto;
  p.marks = cleanMarks(p);
  p._marks = markKnots(p);
  p.handles = cleanHandles(p);
  p.anchors = cleanAnchors(p);
  p.slices = cleanSlices(p);
  p.bottom = cleanBottom(p);
  p._bottom = bottomCurves(p);
  return [p, w];
}

/* ---------------------------------------------------------------------------
   Anchor points
   Each design curve (outline, rocker, thickness) is its closed-form base curve plus a
   smooth correction through the anchor offsets that is zero (and level) at every measured
   station and at the curve's origin (wide / low / thick point), and zero at the tips. So
   anchors reshape a curve between measurements without changing the measurements.

   An anchor is [x, offset, slope, armLeft, armRight]. The last three are its handle, as in
   a drawing program: the slope the correction passes through the point with, and how far
   each arm reaches (inches along the board). Left out (null), the slope is the
   shape-preserving default and each arm is a third of the way to the next point, which
   is a plain cubic that never overshoots. Longer arms make the curve hold its direction
   further from the point; that is how two stretches are blended by hand.
   --------------------------------------------------------------------------- */
const pairOk = (a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]);
const optNum = (v, lo, hi) => (Number.isFinite(v) ? clip(v, lo, hi) : null);

function pinsFor(p, name) {
  const half = p.length / 2, a = p._auto;
  const [origin, t12, n12] = {
    outline: [half + p.wide_point_offset, 'tail_width_12', 'nose_width_12'],
    rocker: [half + p.rocker_low_point, 'tail_rocker_12', 'nose_rocker_12'],
    thickness: [half + p.thickness_point_offset, 'tail_thickness_12', 'nose_thickness_12'],
  }[name];
  return { origin, tail12: !a.includes(t12), nose12: !a.includes(n12) };   // a blank 12" station is not pinned
}

/**
 * Added measurements: width, rocker and / or thickness at any position along the board,
 * entered like the five standard stations ("rocker 2 3/4 at 8 from the nose"). Each one is
 * held exactly: it becomes a knot of the curve's correction whose offset is the typed value
 * minus the closed-form curve there. Like an anchor point it can carry a handle
 * [slope, left arm, right arm] per curve (hw, hr, ht).
 */
const MARK_FIELDS = { outline: ['width', 'hw'], rocker: ['rocker', 'hr'], thickness: ['thickness', 'ht'] };
const handleOf = (hd, mLim) => {
  if (!Array.isArray(hd)) return null;
  const v = [optNum(hd[0], -mLim, mLim), optNum(hd[1], 0.05, 60), optNum(hd[2], 0.05, 60)];
  return v.some((q) => q !== null) ? v : null;
};

function cleanMarks(p) {
  const L = p.length, rows = [];
  for (const r of Array.isArray(p.marks) ? p.marks : []) {
    if (!r || !Number.isFinite(r.pos)) continue;
    const from = r.from === 'nose' ? 'nose' : 'tail', x = from === 'nose' ? L - r.pos : r.pos;
    if (x < 1 || x > L - 1) continue;
    rows.push({ pos: r.pos, from, x, width: optNum(r.width, 0.5, p.width), rocker: optNum(r.rocker, -2, 16),
      thickness: optNum(r.thickness, 0.2, p.thickness), hw: handleOf(r.hw, 3), hr: handleOf(r.hr, 3), ht: handleOf(r.ht, 3) });
  }
  rows.sort((a, b) => a.x - b.x);
  const kept = [];
  for (const r of rows) {
    if (kept.length === 16) break;
    if (kept.length && r.x - kept[kept.length - 1].x < ANCHOR_GAP) continue;
    kept.push(r);
  }
  return kept;
}

/** The points of a curve that are held by a standard measurement: the ends, its origin, the 12" stations. */
function fixedPoints(p, name) {
  const pin = pinsFor(p, name), fixed = [0, p.length, pin.origin];
  if (pin.tail12) fixed.push(12);
  if (pin.nose12) fixed.push(p.length - 12);
  return fixed;
}

/** Added measurements as knots [x, offset, slope, left arm, right arm] of each curve's correction. */
function markKnots(p) {
  const out = {};
  for (const name of ['outline', 'rocker', 'thickness']) {
    const [field, hf] = MARK_FIELDS[name], fixed = fixedPoints(p, name), list = [];
    for (const r of p.marks) {
      if (r[field] === null || fixed.some((f) => Math.abs(r.x - f) < ANCHOR_GAP)) continue;
      const at = [r.x];
      const base = name === 'outline' ? halfWidth(p, at)[0] : name === 'rocker' ? rocker(p, at)[0] : foil(p, at)[0];
      const hd = r[hf] || [null, null, null];
      list.push([r.x, (name === 'outline' ? r.width / 2 : r[field]) - base, hd[0], hd[1], hd[2]]);
    }
    out[name] = list;
  }
  return out;
}

/** Handles [slope, left arm, right arm] on the standard measurement points: the 12" stations and each curve's origin. */
function cleanHandles(p) {
  const src = p.handles && typeof p.handles === 'object' ? p.handles : {}, out = {};
  for (const name of ['outline', 'rocker', 'thickness']) {
    const pin = pinsFor(p, name), s = src[name] && typeof src[name] === 'object' ? src[name] : {}, o = {};
    for (const key of ['tail12', 'origin', 'nose12']) {
      if (key !== 'origin' && !pin[key]) continue;
      const hd = handleOf(s[key], 3);
      if (!hd) continue;
      if (key === 'origin') hd[0] = null;                 // the wide / low / thick point stays level
      if (hd.some((q) => q !== null)) o[key] = hd;
    }
    out[name] = o;
  }
  return out;
}

function keepAnchors(list, lim, fixed, lo, hi, gap, mLim) {
  const pts = (Array.isArray(list) ? list : []).filter(pairOk)
    .map((a) => [a[0], clip(a[1], -lim, lim), optNum(a[2], -mLim, mLim), optNum(a[3], 0.05, 60), optNum(a[4], 0.05, 60)])
    .sort((a, b) => a[0] - b[0]);
  const kept = [];
  for (const a of pts) {
    if (kept.length === 24) break;
    if (fixed.some((f) => Math.abs(a[0] - f) < gap)) continue;
    if (a[0] <= lo || a[0] >= hi) continue;
    if (kept.length && a[0] - kept[kept.length - 1][0] < gap) continue;
    kept.push(a);
  }
  return kept;
}

function cleanAnchors(p) {
  const src = p.anchors || {}, L = p.length, out = {};
  for (const name of ['outline', 'rocker', 'thickness'])
    out[name] = keepAnchors(src[name], ANCHOR_LIMIT[name], [...fixedPoints(p, name), ...p._marks[name].map((k) => k[0])], 0, L, ANCHOR_GAP, 3);
  // the cut of a swallow tail: offsets to the notch's half width, between the tail end and the top of the cut
  out.swallow = TAIL_TYPES[p.tail_type].notch ? keepAnchors(src.swallow, ANCHOR_LIMIT.swallow, [], 0.3, p.swallow_depth - 0.3, 0.3, 3) : [];
  return out;
}

function cleanSlices(p) {
  const L = p.length, kept = [];
  const side = (list) => {
    const pts = (Array.isArray(list) ? list : []).filter(pairOk)
      .map((a) => [a[0], clip(a[1], -0.6, 0.6), optNum(a[2], -12, 12), optNum(a[3], 0.004, 1), optNum(a[4], 0.004, 1)])
      .sort((a, b) => a[0] - b[0]);
    const k = [];
    for (const a of pts) {
      if (k.length === 20) break;
      if (a[0] < 0.02 || a[0] > 0.995) continue;
      if (k.length && a[0] - k[k.length - 1][0] < 0.012) continue;
      k.push(a);
    }
    return k;
  };
  const src = (Array.isArray(p.slices) ? p.slices : []).filter((s) => s && Number.isFinite(s.x)).sort((a, b) => a.x - b.x);
  for (const s of src) {
    if (kept.length === 16) break;
    if (s.x < 2 || s.x > L - 2) continue;
    if (kept.length && s.x - kept[kept.length - 1].x < 1) continue;
    const adj = {};
    for (const [k, lim] of Object.entries(ADJ)) { const v = s.adj ? s.adj[k] : undefined; adj[k] = Number.isFinite(v) ? clip(v, -lim, lim) : 0; }
    kept.push({ x: s.x, id: s.id ?? null, deck: side(s.deck), bottom: side(s.bottom), adj });
  }
  return kept;
}

/**
 * Shape-preserving cubic through (xs, ys) (monotone Hermite, Fritsch-Carlson slopes).
 * It never overshoots the points it passes through and stays tangent-continuous.
 * An end is held level when fixed, otherwise it takes the usual three-point end slope.
 */
function pchipSlopes(xs, ys, fixStart, fixEnd) {
  const n = xs.length, m = new Float64Array(n);
  const h = (i) => xs[i + 1] - xs[i], dl = (i) => (ys[i + 1] - ys[i]) / h(i);
  for (let i = 1; i < n - 1; i++) {
    const d0 = dl(i - 1), d1 = dl(i);
    if (d0 * d1 <= 0) continue;
    const w1 = 2 * h(i) + h(i - 1), w2 = h(i) + 2 * h(i - 1);
    m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
  const end = (h0, h1, d0, d1) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(s) !== Math.sign(d0)) s = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
    return s;
  };
  if (!fixStart) m[0] = n === 2 ? dl(0) : end(h(0), h(1), dl(0), dl(1));
  if (!fixEnd) m[n - 1] = n === 2 ? dl(0) : end(h(n - 2), h(n - 3), dl(n - 2), dl(n - 3));
  return m;
}

function hermiteAt(xs, ys, m, xq) {
  let i = 0;
  while (i < xs.length - 2 && xq > xs[i + 1]) i++;
  const hh = xs[i + 1] - xs[i], t = (xq - xs[i]) / hh, u = 1 - t;
  return (1 + 2 * t) * u * u * ys[i] + t * u * u * hh * m[i] + t * t * (3 - 2 * t) * ys[i + 1] + t * t * (t - 1) * hh * m[i + 1];
}

/**
 * A curve through knots [x, y, slope, armLeft, armRight] (handle values optional), as cubic
 * Bezier segments. Returns { at(xq), arms } where arms[i] = the handle actually used at knot i.
 */
function knotCurve(knots, fixStart, fixEnd) {
  const n = knots.length, xs = knots.map((k) => k[0]), ys = knots.map((k) => k[1]);
  const auto = pchipSlopes(xs, ys, fixStart, fixEnd);
  const m = knots.map((k, i) => (Number.isFinite(k[2]) ? k[2] : auto[i]));
  const A = new Float64Array(n), B = new Float64Array(n);       // right arm of knot i, left arm of knot i + 1
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    let a = Number.isFinite(knots[i][4]) ? knots[i][4] : h / 3, b = Number.isFinite(knots[i + 1][3]) ? knots[i + 1][3] : h / 3;
    if (a + b > h) { const f = h / (a + b); a *= f; b *= f; }    // arms may not cross: keeps one height per position
    A[i] = a; B[i + 1] = b;
  }
  const at = (xq) => {
    let i = 0;
    while (i < n - 2 && xq > xs[i + 1]) i++;
    const X0 = xs[i], X3 = xs[i + 1], X1 = X0 + A[i], X2 = X3 - B[i + 1];
    const Y0 = ys[i], Y3 = ys[i + 1], Y1 = Y0 + A[i] * m[i], Y2 = Y3 - B[i + 1] * m[i + 1];
    let lo = 0, hi = 1;
    for (let it = 0; it < 48; it++) {
      const t = (lo + hi) / 2, u = 1 - t;
      if (u * u * u * X0 + 3 * u * u * t * X1 + 3 * u * t * t * X2 + t * t * t * X3 < xq) lo = t; else hi = t;
    }
    const t = (lo + hi) / 2, u = 1 - t;
    return u * u * u * Y0 + 3 * u * u * t * Y1 + 3 * u * t * t * Y2 + t * t * t * Y3;
  };
  return { at, arms: knots.map((k, i) => ({ x: xs[i], m: m[i], aL: B[i], aR: A[i] })) };
}

/**
 * Bottom contours along the board, from the stations the shaper entered (flat here, 1/16"
 * concave there, double concave further back, vee off the tail). Each station sets the
 * depth of three channels; between stations each channel is blended with a
 * shape-preserving cubic. The nose tip is flat and the last station runs out the tail.
 */
function cleanBottom(p) {
  const L = p.length, rows = [];
  for (const r of Array.isArray(p.bottom) ? p.bottom : []) {
    if (!r || !Number.isFinite(r.pos)) continue;
    const from = r.from === 'nose' ? 'nose' : 'tail';
    const type = Object.prototype.hasOwnProperty.call(BOTTOM_TYPES, r.type) ? r.type : 'flat';
    const depth = Number.isFinite(r.depth) ? clip(r.depth, 0, 0.75) : 0, depth2 = Number.isFinite(r.depth2) ? clip(r.depth2, 0, 0.75) : 0;
    const [c, d, v] = BOTTOM_TYPES[type](depth, depth2);
    rows.push({ pos: r.pos, from, type, depth, depth2, x: clip(from === 'nose' ? L - r.pos : r.pos, 0, L), c, d, v });
  }
  rows.sort((a, b) => a.x - b.x);
  const kept = [];
  for (const r of rows) {
    if (kept.length === 24) break;
    if (kept.length && r.x - kept[kept.length - 1].x < 0.5) continue;
    kept.push(r);
  }
  return kept;
}

function bottomCurves(p) {
  const rows = p.bottom;
  if (!rows.length) return null;
  const L = p.length, xs = [], C = [], D = [], V = [];
  const push = (x, c, d, v) => { xs.push(x); C.push(c); D.push(d); V.push(v); };
  if (rows[0].x > 0.5) push(0, rows[0].c, rows[0].d, rows[0].v);
  for (const r of rows) push(r.x, r.c, r.d, r.v);
  if (rows[rows.length - 1].x < L - 0.5) push(L, 0, 0, 0);
  if (xs.length < 2) push(L, C[0], D[0], V[0]);
  return { xs, C, D, V, mC: pchipSlopes(xs, C, true, true), mD: pchipSlopes(xs, D, true, true), mV: pchipSlopes(xs, V, true, true) };
}

/** [single concave (negative = roll), double concave, vee] depths at x, before any slice adjustment. */
function bottomAt(p, x) {
  const b = p._bottom;
  if (!b) return [concaveAt(p, x), 0, veeAt(p, x)];             // the simple Concave / Vee sliders
  const xq = clip(x, b.xs[0], b.xs[b.xs.length - 1]);
  return [hermiteAt(b.xs, b.C, b.mC, xq), hermiteAt(b.xs, b.D, b.mD, xq), hermiteAt(b.xs, b.V, b.mV, xq)];
}

/**
 * Correction for one design curve, evaluated at the stations x.
 * The pinned points split the curve into spans that are solved separately and held level
 * at each pin, so moving an anchor only reshapes its own span (no ripple into the rest of
 * the board). At the tips the slope is left free.
 */
function curveDelta(p, name, x, arms) {
  const out = new Float64Array(x.length);
  const pts = [...p.anchors[name], ...p._marks[name]].sort((a, b) => a[0] - b[0]);
  const L = p.length, pin = pinsFor(p, name), H = p.handles[name];
  const P = [[0, null]];
  if (pin.tail12) P.push([12, 'tail12']);
  P.push([pin.origin, 'origin']);
  if (pin.nose12) P.push([L - 12, 'nose12']);
  P.push([L, null]);
  // a pinned point as a knot: offset 0, and the slope and arms of its handle if it has been given one
  const pinKnot = (q) => { const hd = q[1] ? H[q[1]] : null; return hd ? [q[0], 0, hd[0], hd[1], hd[2]] : [q[0], 0, null, null, null]; };
  if (arms) arms.pins = {};
  for (let s = 0; s < P.length - 1; s++) {
    const a = P[s][0], b = P[s + 1][0];
    const inside = pts.filter((q) => q[0] > a && q[0] < b);
    const ka = pinKnot(P[s]), kb = pinKnot(P[s + 1]);
    const live = inside.length > 0 || (ka[2] !== null && ka[2] !== 0) || (kb[2] !== null && kb[2] !== 0);
    if (!live && !arms) continue;
    const curve = knotCurve([ka, ...inside, kb], s > 0, s < P.length - 2);
    if (live) for (let i = 0; i < x.length; i++) if (x[i] > a && x[i] < b) out[i] = curve.at(x[i]);
    if (arms) {
      arms.push(...curve.arms.slice(1, -1));
      const first = curve.arms[0], last = curve.arms[curve.arms.length - 1];
      if (P[s][1]) (arms.pins[P[s][1]] ??= { x: a, m: first.m }).aR = first.aR;
      if (P[s + 1][1]) (arms.pins[P[s + 1][1]] ??= { x: b, m: last.m }).aL = last.aL;
    }
  }
  return out;
}

/**
 * Cross-section slices. A slice can adjust the section's shape settings (deck dome, rail
 * fullness, rail apex, rail edge, concave, vee) and carry anchor points on its deck and
 * bottom lines: [rho, d] with rho the position along the line by arc length (0 at the
 * stringer, 1 at the rail apex, so the turn of the rail gets its fair share) and d how far
 * the surface moves along its own normal there, as a fraction of the local thickness
 * (deck: outward; bottom: up, which is inward at the rail). On the flat of the deck and
 * bottom that is straight up and down; on the rail it is in and out. Everything a slice
 * changes blends smoothly to nothing toward the neighbouring slices and the tips.
 */
function sliceTables(p) {
  const sl = p.slices;
  const pts = sl.some((s) => s.deck.length || s.bottom.length);
  if (!pts && !sl.some((s) => Object.values(s.adj).some((v) => v !== 0))) return null;
  const table = (list) => {
    const T = new Float64Array(GRID);
    T.arms = [];
    if (!list.length) return T;
    const curve = knotCurve([[0, 0], ...list, [1, 0]], true, false);   // level across the stringer
    for (let g = 0; g < GRID; g++) T[g] = curve.at(g / (GRID - 1));
    T[GRID - 1] = 0;
    T.arms = curve.arms.slice(1, -1);
    return T;
  };
  const zero = new Float64Array(GRID), adj = {};
  for (const k of Object.keys(ADJ)) adj[k] = [0, ...sl.map((s) => s.adj[k]), 0];
  return {
    pts, adj,
    kx: [0, ...sl.map((s) => s.x), p.length],
    deck: [zero, ...sl.map((s) => table(s.deck)), zero],
    bottom: [zero, ...sl.map((s) => table(s.bottom)), zero],
  };
}

/** What the slices change at position x: fills d (setting adjustments) and, if given, the offset rows. */
function sliceBlend(sl, x, d, rowD, rowB) {
  let j = 0;
  while (j < sl.kx.length - 2 && x >= sl.kx[j + 1]) j++;
  const tt = clip((x - sl.kx[j]) / (sl.kx[j + 1] - sl.kx[j]), 0, 1);
  const wq = tt * tt * tt * (tt * (6 * tt - 15) + 10);
  for (const k in sl.adj) d[k] = (1 - wq) * sl.adj[k][j] + wq * sl.adj[k][j + 1];
  if (sl.pts && rowD) for (let g = 0; g < GRID; g++) {
    rowD[g] = (1 - wq) * sl.deck[j][g] + wq * sl.deck[j + 1][g];
    rowB[g] = (1 - wq) * sl.bottom[j][g] + wq * sl.bottom[j + 1][g];
  }
}

/**
 * Section shape settings at x for local thickness t: the board-wide values plus a slice
 * adjustment d (or none). The rail apex is a height in inches above the flat bottom line
 * when rail_apex_in is set (older designs give it as a fraction of thickness instead).
 */
function sectionShape(p, x, d, t) {
  const g = (k) => (d ? d[k] : 0);
  const [c0, d0, v0] = bottomAt(p, x);
  let con = clip(c0 + g('concave'), -0.5, 0.75), dbl = clip(d0 + g('double'), 0, 0.75);
  const lift = Math.abs(con) + dbl, cap = 0.5 * t;                // never carve more than half the thickness
  if (lift > cap) { const f = cap / lift; con *= f; dbl *= f; }
  return {
    ar: p.rail_apex_in !== null ? apexRatio(p.rail_apex_in + g('rail_apex_in'), t) : clip(p.rail_apex + g('rail_apex'), 0.15, 0.6),
    ed: 1.7 + 1.4 * clip(p.rail_fullness + g('rail_fullness'), 0, 1),
    eb: 2 + 6 * clip(railHardness(p, x) + g('rail_hardness'), 0, 1),
    dome: clip(p.deck_dome + g('deck_dome'), 0, 1),
    con, dbl, vee: clip(v0 + g('vee'), 0, 0.75),
  };
}
/**
 * Rail apex height a (inches above the bottom line) as a fraction of the thickness t. It can
 * never pass 60% of the thickness; where the board thins out it eases into that limit
 * instead of hitting it, so the rail line has no corner along the board.
 */
function apexRatio(a, t) {
  const ts = Math.max(t, 1e-9), hi = 0.6 * ts, av = Math.max(a, 1e-3);
  return clip((av ** -6 + hi ** -6) ** (-1 / 6) / ts, 0.1, 0.6);
}
/** Board-wide section settings at x, in the same terms a slice adjusts (for the UI). */
export function sectionBase(p, x) {
  const [c0, d0, v0] = bottomAt(p, x);
  return { rail_apex: p.rail_apex, rail_apex_in: p.rail_apex_in ?? 0, rail_fullness: p.rail_fullness, deck_dome: p.deck_dome,
    rail_hardness: railHardness(p, x), concave: c0, double: d0, vee: v0 };
}
const gridAt = (row, eta) => {
  const f = eta * (GRID - 1), i0 = Math.min(Math.floor(f), GRID - 2);
  return row[i0] + (f - i0) * (row[i0 + 1] - row[i0]);
};

/* ---------------------------------------------------------------------------
   1D profiles
   --------------------------------------------------------------------------- */
function closureExponent(r, b, uRef) {
  r = clip(r, 1e-3, 0.999);
  return Math.log(1 - r ** b) / Math.log(uRef);
}

function halfWidth(p, x) {
  const L = p.length, W2 = p.width / 2, xw = L / 2 + p.wide_point_offset;
  const bn = NOSE_TYPES[p.nose_type];
  const an = closureExponent(p.nose_width_12 / p.width, bn, (L - 12 - xw) / (L - xw));
  const tail = TAIL_TYPES[p.tail_type], bt = tail.b;
  const te = tail.closes ? 0 : p.tail_block_width / p.width;
  const at = closureExponent((p.tail_width_12 / p.width - te) / (1 - te), bt, (xw - 12) / xw);
  const rc = tail.corner;
  const h = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    let v;
    if (xi >= xw) v = W2 * clip(1 - ((xi - xw) / (L - xw)) ** an, 0, 1) ** (1 / bn);
    else v = W2 * (te + (1 - te) * clip(1 - ((xw - xi) / xw) ** at, 0, 1) ** (1 / bt));
    if (rc > 0 && xi < rc) v = v - rc + Math.sqrt(Math.max(rc * rc - (rc - xi) ** 2, 0));
    h[i] = Math.max(v, 0);
  }
  return h;
}

function notchHalfWidth(p, x, arms) {
  const out = new Float64Array(x.length);
  if (!TAIL_TYPES[p.tail_type].notch) return out;
  const D = p.swallow_depth, pts = p.anchors.swallow;
  const curve = pts.length ? knotCurve([[0, 0, null, null, null], ...pts, [D, 0, null, null, null]], false, false) : null;
  for (let i = 0; i < x.length; i++) {
    const base = Math.max((p.swallow_width / 2) * (1 - x[i] / D), 0);
    out[i] = curve && x[i] > 0 && x[i] < D ? Math.max(base + curve.at(x[i]), 0.1 * base) : base;   // the cut never closes early
  }
  if (arms && curve) arms.push(...curve.arms.slice(1, -1));
  return out;
}

export function rockerExponents(p) {
  const xl = p.length / 2 + p.rocker_low_point;
  return [[p.nose_rocker, p.nose_rocker_12, true], [p.tail_rocker, p.tail_rocker_12, false]].map(([R, r12, nose]) => {
    let k = 2;
    if (R > 1e-9) k = r12 <= 0 ? K_MAX : Math.log(r12 / R) / Math.log(u12(p.length, xl, nose));
    return clip(k, K_MIN, K_MAX);
  });
}

function foilExponents(p) {
  const xt = p.length / 2 + p.thickness_point_offset;
  return [[p.nose_thickness, p.nose_thickness_12, true], [p.tail_thickness, p.tail_thickness_12, false]].map(([te, t12, nose]) => {
    let e = 2;
    if (p.thickness - te > 1e-9) {
      const drop = 1 - (t12 - te) / (p.thickness - te);
      e = drop <= 0 ? P_MAX : drop >= 1 ? P_MIN : Math.log(drop) / Math.log(u12(p.length, xt, nose));
    }
    return clip(e, P_MIN, P_MAX);
  });
}

function rocker(p, x) {
  const L = p.length, xl = L / 2 + p.rocker_low_point;
  const [kn, kt] = rockerExponents(p);
  return Float64Array.from(x, (xi) => (xi >= xl
    ? p.nose_rocker * clip((xi - xl) / (L - xl), 0, 1) ** kn
    : p.tail_rocker * clip((xl - xi) / xl, 0, 1) ** kt));
}

function foil(p, x) {
  const L = p.length, xt = L / 2 + p.thickness_point_offset;
  const [en, et] = foilExponents(p);
  return Float64Array.from(x, (xi) => {
    const nose = xi >= xt;
    const u = nose ? (xi - xt) / (L - xt) : (xt - xi) / xt;
    const tEnd = nose ? p.nose_thickness : p.tail_thickness;
    return tEnd + (p.thickness - tEnd) * (1 - clip(u, 0, 1) ** (nose ? en : et));
  });
}

const railHardness = (p, x) =>
  p.rail_hardness_tail + (p.rail_hardness_nose - p.rail_hardness_tail) * smoothstep((x - 0.15 * p.length) / (0.6 * p.length));
const concaveAt = (p, x) => p.concave_depth * smoothstep((0.8 * p.length - x) / (0.25 * p.length)) * smoothstep(x / 3);
const veeAt = (p, x) => p.vee_depth * smoothstep((0.35 * p.length - x) / (0.3 * p.length));

/* ---------------------------------------------------------------------------
   Cross sections: right half, deck centerline -> rail -> bottom centerline
   --------------------------------------------------------------------------- */
const K = 900;
const TH_COS = new Float64Array(K), TH_SIN = new Float64Array(K), TH_DECK = new Uint8Array(K);
for (let k = 0; k < K; k++) {
  const th = k === K - 1 ? -Math.PI / 2 : Math.PI / 2 + k * (-Math.PI / (K - 1));
  TH_COS[k] = Math.abs(Math.cos(th)); TH_SIN[k] = Math.abs(Math.sin(th)); TH_DECK[k] = th >= 0 ? 1 : 0;
}

const KA = K / 2;                                        // deck = samples 0 .. KA-1 (stringer -> rail apex), bottom = KA .. K-1 (apex -> stringer)
const S_RHO = new Float64Array(K), S_NY = new Float64Array(K), S_NZ = new Float64Array(K);
const ZERO_ROW = new Float64Array(GRID);

/**
 * One cross section, densely sampled, into Y / Z. With offset rows (a slice's anchor
 * points, blended to this position) every point is moved along the normal of the section
 * there by thickness x row(rho), rho = its arc-length position between the stringer (0)
 * and the rail apex (1). aux, if given, also receives the section before the anchor
 * points (Y0, Z0), rho, the normals and the two arc lengths.
 */
function sectionDense(p, xi, hi, yi, ti, zbi, d, rowD, rowB, Y, Z, aux) {
  const sh = sectionShape(p, xi, d, ti);
  const { ar, ed, eb, dome, con, dbl, vee } = sh;
  const zApex = zbi + ar * ti, td = (1 - ar) * ti, tb = ar * ti;
  const hs = Math.max(hi, 1e-9);
  for (let k = 0; k < K; k++) {
    const deck = TH_DECK[k], e = deck ? ed : eb;
    const yraw = hi * TH_COS[k] ** (2 / e);
    const eta = clip(yraw / hs, 0, 1);
    Z[k] = deck
      ? zApex + td * TH_SIN[k] ** (2 / ed) * (1 - 0.7 * dome * eta * eta)
      : zApex - tb * TH_SIN[k] ** (2 / e) + con * (1 - eta * eta) ** 2 + (dbl * eta ** 1.5 * (1 - eta) ** 2) / K2 - vee * (1 - eta);
    Y[k] = yi + (yraw * (hi - yi)) / hs;
  }
  if (!rowD) return sh;
  const RHO = aux ? aux.rho : S_RHO, NY = aux ? aux.ny : S_NY, NZ = aux ? aux.nz : S_NZ;
  RHO[0] = 0;
  for (let k = 1; k < KA; k++) RHO[k] = RHO[k - 1] + Math.hypot(Y[k] - Y[k - 1], Z[k] - Z[k - 1]);
  RHO[K - 1] = 0;
  for (let k = K - 2; k >= KA; k--) RHO[k] = RHO[k + 1] + Math.hypot(Y[k] - Y[k + 1], Z[k] - Z[k + 1]);
  const aD = RHO[KA - 1], aB = RHO[KA];
  for (let k = 0; k < K; k++) {
    const a = Math.max(k - 1, 0), b = Math.min(k + 1, K - 1);
    const ty = Y[b] - Y[a], tz = Z[b] - Z[a], len = Math.hypot(ty, tz), tot = k < KA ? aD : aB;
    RHO[k] = tot > 1e-12 ? RHO[k] / tot : 0;
    if (len < 1e-12 || k === 0 || k === K - 1) { NY[k] = 0; NZ[k] = 1; }
    else if (k < KA) { NY[k] = -tz / len; NZ[k] = ty / len; }
    else { NY[k] = tz / len; NZ[k] = -ty / len; }
  }
  if (aux) { aux.Y0.set(Y); aux.Z0.set(Z); aux.aD = aD; aux.aB = aB; }
  for (let k = 0; k < K; k++) {
    const D = ti * gridAt(k < KA ? rowD : rowB, RHO[k]);
    if (D === 0) continue;
    Y[k] = clip(Y[k] + D * NY[k], yi, hi);                // never wider than the outline, never across the stringer
    Z[k] += D * NZ[k];
  }
  return sh;
}

function sections(p, x, h, yin, t, zb, M, sl) {
  const n = x.length;
  const Yo = new Float64Array(n * M), Zo = new Float64Array(n * M);
  const Y = new Float64Array(K), Z = new Float64Array(K), cum = new Float64Array(K);
  const rowD = new Float64Array(GRID), rowB = new Float64Array(GRID), d = {};
  const pts = sl && sl.pts;
  for (let i = 0; i < n; i++) {
    const ti = t[i];
    if (sl) sliceBlend(sl, x[i], d, rowD, rowB);         // blend what the two neighbouring slices change
    sectionDense(p, x[i], h[i], yin[i], ti, zb[i], sl ? d : null, pts ? rowD : null, rowB, Y, Z, null);
    // resample by arc length plus turning angle so hard rails stay crisp
    cum[0] = 0;
    let prevRaw = 0, unwrapped = 0, prevAng = 0;
    for (let j = 0; j < K - 1; j++) {
      const dY = Y[j + 1] - Y[j], dZ = Z[j + 1] - Z[j];
      const raw = Math.atan2(dZ, dY);
      if (j === 0) unwrapped = raw;
      else {
        const d = raw - prevRaw;
        let dm = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        if (dm === -Math.PI && d > 0) dm = Math.PI;
        unwrapped += Math.abs(d) < Math.PI ? d : dm;
      }
      const dturn = j === 0 ? 0 : Math.abs(unwrapped - prevAng);
      prevRaw = raw; prevAng = unwrapped;
      cum[j + 1] = cum[j] + Math.hypot(dY, dZ) + 0.35 * ti * dturn;
    }
    const total = cum[K - 1], base = i * M;
    if (total <= 1e-12) { Yo.fill(Y[0], base, base + M); Zo.fill(Z[0], base, base + M); continue; }
    let j = 0;
    for (let m = 0; m < M; m++) {
      const tgt = (total * m) / (M - 1);
      if (m === M - 1 || tgt >= total) { Yo[base + m] = Y[K - 1]; Zo[base + m] = Z[K - 1]; continue; }
      while (j < K - 2 && cum[j + 1] <= tgt) j++;
      const span = cum[j + 1] - cum[j], f = span > 0 ? (tgt - cum[j]) / span : 0;
      Yo[base + m] = Y[j] + f * (Y[j + 1] - Y[j]);
      Zo[base + m] = Z[j] + f * (Z[j + 1] - Z[j]);
    }
  }
  return [Yo, Zo];
}

/* ---------------------------------------------------------------------------
   Mesh
   --------------------------------------------------------------------------- */
function stationXs(p) {
  const n = p.stations, L = p.length, half = L / 2;
  const xs = [];
  for (let i = 0; i < n; i++) {
    const s = n === 1 ? 0 : i / (n - 1);
    xs.push(L * (0.55 * 0.5 * (1 - Math.cos(Math.PI * s)) + 0.45 * s));
  }
  xs.push(12, L - 12, half + p.wide_point_offset, half + p.rocker_low_point, half + p.thickness_point_offset);
  const tail = TAIL_TYPES[p.tail_type];
  if (tail.notch) for (let j = 1; j <= 8; j++) xs.push((p.swallow_depth * j) / 8);     // the cut can be curved
  if (tail.corner > 0) for (const f of [0.04, 0.15, 0.35, 0.6, 1]) xs.push(tail.corner * f);   // round the tail corners properly
  for (const s of p.slices) xs.push(s.x);
  for (const r of p.marks) xs.push(r.x);
  xs.sort((a, b) => a - b);
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1e-3) out.push(xs[i]);  // np.unique + gap filter
  return Float64Array.from(out);
}

function buildMesh(p, tScale) {
  const x = stationXs(p), n = x.length, M = p.section_points;
  // base curves, then the anchor-point corrections
  const h0 = halfWidth(p, x), zb0 = rocker(p, x), foil0 = foil(p, x);
  const arms = { outline: [], rocker: [], thickness: [], swallow: [] };
  const dh = curveDelta(p, 'outline', x, arms.outline), dz = curveDelta(p, 'rocker', x, arms.rocker), dt = curveDelta(p, 'thickness', x, arms.thickness);
  const h = Float64Array.from(h0, (v, i) => Math.max(v + dh[i], 0.15 * v));
  const zb = Float64Array.from(zb0, (v, i) => v + dz[i]);
  const t = Float64Array.from(foil0, (v, i) => {
    const ti = Math.max(v + dt[i], 0.15 * v) * tScale;
    return ti * Math.tanh((1.5 * h[i]) / Math.max(ti, 1e-9));   // pinch where the outline gets narrow
  });
  const notch = notchHalfWidth(p, x, arms.swallow);
  const yin = Float64Array.from(notch, (v, i) => Math.min(v, h[i] * 0.95));
  const sl = sliceTables(p);
  const [Y, Z] = sections(p, x, h, yin, t, zb, M, sl);

  let nv = 0;
  for (let i = 0; i < n; i++) nv += h[i] < 1e-6 ? 1 : yin[i] > 1e-9 ? 2 * M : 2 * M - 2;
  const capCount = (h[0] >= 1e-6 ? 2 : 0) + (h[n - 1] >= 1e-6 ? 2 : 0);
  const V = new Float64Array((nv + capCount) * 3);
  const IR = new Int32Array(n * M), IL = new Int32Array(n * M);
  let c = 0;
  const put = (a, b, z) => { V[3 * c] = a; V[3 * c + 1] = b; V[3 * c + 2] = z; return c++; };
  for (let i = 0; i < n; i++) {
    const o = i * M;
    if (h[i] < 1e-6) { const id = put(x[i], 0, zb[i]); IR.fill(id, o, o + M); IL.fill(id, o, o + M); continue; }
    for (let m = 0; m < M; m++) IR[o + m] = put(x[i], Y[o + m], Z[o + m]);
    if (yin[i] > 1e-9) for (let m = 0; m < M; m++) IL[o + m] = put(x[i], -Y[o + m], Z[o + m]);
    else {
      IL[o] = IR[o]; IL[o + M - 1] = IR[o + M - 1];
      for (let m = 1; m < M - 1; m++) IL[o + m] = put(x[i], -Y[o + m], Z[o + m]);
    }
  }

  const F = [];
  const tri = (a, b, d, flip) => (flip ? F.push(d, b, a) : F.push(a, b, d));
  for (const [I, flip] of [[IR, false], [IL, true]]) {
    for (let i = 0; i < n - 1; i++) for (let m = 0; m < M - 1; m++)
      tri(I[i * M + m], I[(i + 1) * M + m], I[(i + 1) * M + m + 1], flip);
    for (let i = 0; i < n - 1; i++) for (let m = 0; m < M - 1; m++)
      tri(I[i * M + m], I[(i + 1) * M + m + 1], I[i * M + m + 1], flip);
  }
  for (let i = 0; i < n - 1; i++) {                      // swallow notch walls
    if (!(yin[i] > 1e-9 && h[i] >= 1e-6)) continue;
    for (const [I, flip] of [[IR, false], [IL, true]]) {
      const q = [I[i * M], I[i * M + M - 1], I[(i + 1) * M + M - 1], I[(i + 1) * M]];
      tri(q[0], q[1], q[2], flip); tri(q[0], q[2], q[3], flip);
    }
  }
  const cap = (row, noseEnd) => {                        // fan from the section's centroid
    for (const [I, flip] of [[IR, false], [IL, true]]) {
      let sx = 0, sy = 0, sz = 0;
      for (let m = 0; m < M; m++) { const v = I[row * M + m]; sx += V[3 * v]; sy += V[3 * v + 1]; sz += V[3 * v + 2]; }
      const ci = put(sx / M, sy / M, sz / M);
      for (let m = 0; m < M; m++) {
        const a = I[row * M + m], b = I[row * M + ((m + 1) % M)];
        noseEnd ? tri(ci, b, a, flip) : tri(ci, a, b, flip);
      }
    }
  };
  if (h[0] >= 1e-6) cap(0, false);
  if (h[n - 1] >= 1e-6) cap(n - 1, true);

  const idx = [];
  for (let f = 0; f < F.length; f += 3) {
    const a = F[f], b = F[f + 1], d = F[f + 2];
    if (a !== b && b !== d && a !== d) idx.push(a, b, d);
  }
  const faces = Uint32Array.from(idx);
  let vol = meshVolume(V, faces);
  if (vol < 0) {
    for (let f = 0; f < faces.length; f += 3) { const tmp = faces[f]; faces[f] = faces[f + 2]; faces[f + 2] = tmp; }
    vol = -vol;
  }
  return { V, F: faces, vol, prof: { x, h, yin, zb, t, Y, Z, M, h0, zb0, foil0, sl, arms } };
}

function meshVolume(V, F) {
  let s = 0;
  for (let f = 0; f < F.length; f += 3) {
    const a = 3 * F[f], b = 3 * F[f + 1], c = 3 * F[f + 2];
    s += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1])
       + V[a + 1] * (V[b + 2] * V[c] - V[b] * V[c + 2])
       + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
  }
  return s / 6;
}

function meshArea(V, F) {
  let s = 0;
  for (let f = 0; f < F.length; f += 3) {
    const a = 3 * F[f], b = 3 * F[f + 1], c = 3 * F[f + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s / 2;
}

function interp(xq, xs, ys) {                           // np.interp
  const n = xs.length;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= xq) lo = mid; else hi = mid; }
  return ys[lo] + ((xq - xs[lo]) / (xs[hi] - xs[lo])) * (ys[hi] - ys[lo]);
}

/* ---------------------------------------------------------------------------
   Board
   --------------------------------------------------------------------------- */
export function buildBoard(input = {}) {
  const t0 = performance.now();
  const [p, warnings] = validated(paramsFromDict(input));
  let scale = 1;
  let mesh = buildMesh(p, scale);
  if (p.lock_volume) {
    const target = p.target_volume / IN3_TO_L;
    for (let it = 0; it < 6; it++) {
      scale = clip(scale * (target / mesh.vol), 0.4, 2.5);
      mesh = buildMesh(p, scale);
      if (Math.abs(mesh.vol - target) / target < 1e-4) break;
    }
    if (scale === 0.4 || scale === 2.5) warnings.push('target volume out of reach by scaling thickness alone');
  }
  const board = {
    params: p, warnings, thickness_scale: scale, auto: p._auto,
    vertices: mesh.V, faces: mesh.F, volume_l: mesh.vol * IN3_TO_L, _profiles: mesh.prof,
  };
  board.stats = stats(board);
  board.build_ms = Math.round((performance.now() - t0) * 10) / 10;
  return board;
}

export function stationTable(board) {
  const p = board.params, { x, h, zb, t } = board._profiles, L = p.length;
  const tail = TAIL_TYPES[p.tail_type];
  const row = (label, xs, mark) => ({
    label, from_nose_in: L - xs,
    width_in: xs === 0 && !tail.closes ? p.tail_block_width : 2 * interp(xs, x, h),
    rocker_in: interp(xs, x, zb), thickness_in: interp(xs, x, t), mark,
  });
  return [
    ...[['Nose tip', L], ['12" from nose', L - 12], ['Wide point', L / 2 + p.wide_point_offset], ['12" from tail', 12], ['Tail end', 0]].map(([label, xs]) => row(label, xs, false)),
    ...p.marks.map((r) => row(`${fmtIn(r.pos)} from ${r.from}`, r.x, true)),      // added measurements, after the five standard ones
  ];
}

function stats(board) {
  const p = board.params, { x, h, yin, t } = board._profiles, L = p.length;
  let plan = 0, hmax = 0, tmax = 0;
  for (let i = 0; i < x.length; i++) {
    hmax = Math.max(hmax, h[i]); tmax = Math.max(tmax, t[i]);
    if (i) plan += ((x[i] - x[i - 1]) * (2 * h[i] - 2 * yin[i] + 2 * h[i - 1] - 2 * yin[i - 1])) / 2;
  }
  const rem = L % 12, remS = Number.isInteger(rem) ? `${rem}` : rem.toFixed(1);
  return {
    length_in: L,
    length_ftin: `${Math.floor(L / 12)}'${remS.endsWith('.0') ? remS.slice(0, -2) : remS}"`,
    width_in: 2 * hmax, thickness_in: tmax, volume_l: board.volume_l,
    nose_width_12_in: 2 * interp(L - 12, x, h), tail_width_12_in: 2 * interp(12, x, h),
    plan_area_in2: plan, surface_area_in2: meshArea(board.vertices, board.faces),
    thickness_scale: board.thickness_scale, stations: stationTable(board),
    vertices: board.vertices.length / 3, triangles: board.faces.length / 3,
  };
}

/** Curves for the 2D panels (same shape as the Python server's JSON). */
export function curves(board) {
  const { x, h, yin, zb, t, Y, Z, M } = board._profiles, L = board.params.length;
  const A = (a) => Array.from(a);
  const sx = [], sd = [], sb = [];
  for (let i = 0; i < x.length; i++) if (yin[i] <= 1e-9) { sx.push(x[i]); sd.push(Z[i * M]); sb.push(Z[i * M + M - 1]); }
  const out = {
    outline: { x: A(x), h: A(h), yin: A(yin) },
    rocker: { x: A(x), bottom: A(zb), deck: A(zb).map((v, i) => v + t[i]) },
    stringer: { x: sx, deck: sd, bottom: sb },
    sections: {},
  };
  for (const [name, xs] of [['tail_12', 12], ['center', L / 2], ['nose_12', L - 12]]) {
    let best = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - xs) < Math.abs(x[best] - xs)) best = i;
    const Yr = Y.slice(best * M, best * M + M), Zr = Z.slice(best * M, best * M + M);
    out.sections[name] = {
      x: x[best],
      y: [...Yr, ...Array.from(Yr).reverse().map((v) => -v)],
      z: [...Zr, ...Array.from(Zr).reverse()].map((v) => v - zb[best]),
    };
  }
  return out;
}

/**
 * The cross section at any position x, as two lines from the stringer to the rail apex
 * (deck and bottom), heights measured from the flat bottom line. Each line has its points
 * (y, z), the same before any slice anchor points (y0, z0), the arc-length position rho of
 * every point and the normal (ny, nz) anchor points move along. Used to roll through the
 * board section by section, and by the section editor.
 */
export function sectionAt(board, x) {
  const p = board.params, pr = board._profiles;
  const h = interp(x, pr.x, pr.h), t = interp(x, pr.x, pr.t), yin = interp(x, pr.x, pr.yin);
  const d = {}, rowD = new Float64Array(GRID), rowB = new Float64Array(GRID);
  if (pr.sl) sliceBlend(pr.sl, x, d, rowD, rowB);
  const Y = new Float64Array(K), Z = new Float64Array(K);
  const aux = { Y0: new Float64Array(K), Z0: new Float64Array(K), rho: new Float64Array(K), ny: new Float64Array(K), nz: new Float64Array(K) };
  const pts = pr.sl && pr.sl.pts;
  const sh = sectionDense(p, x, h, yin, t, 0, pr.sl ? d : null, pts ? rowD : ZERO_ROW, pts ? rowB : ZERO_ROW, Y, Z, aux);
  const line = (a, b, back) => {
    const cut = (arr) => { const v = Array.from(arr.subarray(a, b)); return back ? v.reverse() : v; };
    return { y: cut(Y), z: cut(Z), y0: cut(aux.Y0), z0: cut(aux.Z0), rho: cut(aux.rho), ny: cut(aux.ny), nz: cut(aux.nz) };
  };
  return { x, h, t, yin, apex_in: sh.ar * t, shape: sh, deck: line(0, KA, false), bottom: line(KA, K, true), girth: { deck: aux.aD, bottom: aux.aB } };
}

/** One user slice: its section plus what the editor needs (settings, handles in use). */
export function sliceInfo(board, k) {
  const p = board.params, pr = board._profiles, s = p.slices[k];
  const arms = (which) => (pr.sl && pr.sl.pts ? pr.sl[which][k + 1].arms : []);
  return { ...sectionAt(board, s.x), id: s.id, adj: s.adj, base: sectionBase(p, s.x), arms: { deck: arms('deck'), bottom: arms('bottom') } };
}

export function specSheet(board) {
  const s = board.stats, p = board.params;
  const name = (v) => v.replace(/_/g, ' ');
  const L = (str, n) => str.padEnd(n), R = (str, n) => str.padStart(n);
  const lines = [
    `${fmtFtin(s.length_in)} x ${fmtIn(s.width_in)} x ${fmtIn(s.thickness_in)}   ${s.volume_l.toFixed(1)} L`,
    `nose: ${name(p.nose_type)}    tail: ${name(p.tail_type)}`,
    '',
    `${L('Station', 20)}${R('From nose', 11)}${R('Width', 10)}${R('Rocker', 10)}${R('Thickness', 11)}`,
    ...[...s.stations].sort((a, b) => a.from_nose_in - b.from_nose_in).map((r) => `${L(r.label, 20)}${R(fmtFtin(r.from_nose_in), 11)}${R(fmtIn(r.width_in), 10)}${R(fmtIn(r.rocker_in), 10)}${R(fmtIn(r.thickness_in), 11)}`),
    '',
    `wide point   ${fmtIn(p.wide_point_offset)} from center (+ = toward nose)`,
    `rocker low   ${fmtIn(p.rocker_low_point)} from center`,
    `thick point  ${fmtIn(p.thickness_point_offset)} from center`,
    `rails        apex ${p.rail_apex_in !== null ? `${fmtIn(p.rail_apex_in)} above the bottom` : `${Math.round(p.rail_apex * 100)}% of thickness`}, fullness ${p.rail_fullness.toFixed(2)}, deck dome ${p.deck_dome.toFixed(2)}`,
    ...(p.bottom.length
      ? ['bottom       contours, nose to tail:', ...[...p.bottom].reverse().map((r) =>
        `             ${fmtIn(r.pos)} from ${r.from}: ${BOTTOM_LABELS[r.type]}${r.type === 'flat' ? '' : ` ${fmtIn(r.depth)}`}${r.type.endsWith('_double') ? ` / ${fmtIn(r.depth2)}` : ''}`)]
      : [`bottom       concave ${fmtIn(p.concave_depth)}, tail vee ${fmtIn(p.vee_depth)}`]),
    `plan area    ${s.plan_area_in2.toFixed(0)} sq in`,
    '',
    'Inches to the nearest 1/16. Rocker is bottom height above a flat table touching the low point.',
  ];
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------------------
   Exports
   --------------------------------------------------------------------------- */
export function toSTL(board, units = 'mm') {
  const s = units === 'mm' ? 25.4 : 1, V = board.vertices, F = board.faces, nt = F.length / 3;
  const buf = new ArrayBuffer(84 + 50 * nt), dv = new DataView(buf);
  const header = `surfboard ${board.params.length.toFixed(1)}in ${board.volume_l.toFixed(2)}L units=${units}`.padEnd(80).slice(0, 80);
  for (let i = 0; i < 80; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let f = 0; f < F.length; f += 3) {
    const a = 3 * F[f], b = 3 * F[f + 1], c = 3 * F[f + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const ln = Math.max(Math.hypot(nx, ny, nz), 1e-12); nx /= ln; ny /= ln; nz /= ln;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const k of [a, b, c]) for (let d = 0; d < 3; d++) { dv.setFloat32(o, V[k + d] * s, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

export function toOBJ(board, units = 'mm') {
  const s = units === 'mm' ? 25.4 : 1, V = board.vertices, F = board.faces;
  const lines = [`# surfboard, units=${units}, volume=${board.volume_l.toFixed(2)} L`];
  for (let i = 0; i < V.length; i += 3) lines.push(`v ${(V[i] * s).toFixed(5)} ${(V[i + 1] * s).toFixed(5)} ${(V[i + 2] * s).toFixed(5)}`);
  for (let f = 0; f < F.length; f += 3) lines.push(`f ${F[f] + 1} ${F[f + 1] + 1} ${F[f + 2] + 1}`);
  return lines.join('\n') + '\n';
}

/** Minimal store-only .zip (some hosts only allow saving .zip, not .stl). */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function zipOne(name, data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const nb = new TextEncoder().encode(name), size = data.length;
  const out = new Uint8Array(30 + nb.length + size + 46 + nb.length + 22), dv = new DataView(out.buffer);
  let o = 0;
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; }, u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0x21); u32(crc); u32(size); u32(size); u16(nb.length); u16(0);
  out.set(nb, o); o += nb.length; out.set(data, o); o += size;
  const cd = o;
  u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0x21); u32(crc); u32(size); u32(size);
  u16(nb.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
  out.set(nb, o); o += nb.length;
  const cdSize = o - cd;
  u32(0x06054b50); u16(0); u16(0); u16(1); u16(1); u32(cdSize); u32(cd); u16(0);
  return out;
}

export function checkWatertight(F) {
  const fwd = new Set(); let dup = 0;
  const key = (a, b) => a * 4294967296 + b;
  for (let f = 0; f < F.length; f += 3) for (const [a, b] of [[F[f], F[f + 1]], [F[f + 1], F[f + 2]], [F[f + 2], F[f]]]) {
    const k = key(a, b); if (fwd.has(k)) dup++; else fwd.add(k);
  }
  let unmatched = 0;
  for (const k of fwd) { const a = Math.floor(k / 4294967296), b = k % 4294967296; if (!fwd.has(key(b, a))) unmatched++; }
  return [unmatched === 0 && dup === 0, unmatched, dup];
}
