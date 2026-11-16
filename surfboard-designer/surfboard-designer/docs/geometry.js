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
const ANCHOR_LIMIT = { outline: 6, rocker: 4, thickness: 2 };   // max offset an anchor point may carry (inches)
const ANCHOR_GAP = 0.75;                                         // min spacing between anchors / pinned points
const GRID = 257;                                                // samples of a slice's deck / bottom offset curve
// What a cross-section slice may adjust, and by how much at most (added to the board-wide value there)
const ADJ = { rail_apex: 0.45, rail_fullness: 1, deck_dome: 1, rail_hardness: 1, concave: 0.5, vee: 0.5 };

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
  p._auto = auto;
  p.anchors = cleanAnchors(p);
  p.slices = cleanSlices(p);
  return [p, w];
}

/* ---------------------------------------------------------------------------
   Anchor points
   Each design curve (outline, rocker, thickness) is its closed-form base curve plus a
   smooth correction through the anchor offsets that is zero (and level) at every measured
   station and at the curve's origin (wide / low / thick point), and zero at the tips. So
   anchors reshape a curve between measurements without changing the measurements. The
   correction is a shape-preserving cubic: tangent-continuous, and it never overshoots
   an anchor.
   --------------------------------------------------------------------------- */
const pairOk = (a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]);

function pinsFor(p, name) {
  const half = p.length / 2, a = p._auto;
  const [origin, t12, n12] = {
    outline: [half + p.wide_point_offset, 'tail_width_12', 'nose_width_12'],
    rocker: [half + p.rocker_low_point, 'tail_rocker_12', 'nose_rocker_12'],
    thickness: [half + p.thickness_point_offset, 'tail_thickness_12', 'nose_thickness_12'],
  }[name];
  return { origin, tail12: !a.includes(t12), nose12: !a.includes(n12) };   // a blank 12" station is not pinned
}

function cleanAnchors(p) {
  const src = p.anchors || {}, L = p.length, out = {};
  for (const name of ['outline', 'rocker', 'thickness']) {
    const pin = pinsFor(p, name), lim = ANCHOR_LIMIT[name];
    const fixed = [0, L, pin.origin];
    if (pin.tail12) fixed.push(12);
    if (pin.nose12) fixed.push(L - 12);
    const pts = (Array.isArray(src[name]) ? src[name] : []).filter(pairOk)
      .map((a) => [a[0], clip(a[1], -lim, lim)]).sort((a, b) => a[0] - b[0]);
    const kept = [];
    for (const a of pts) {
      if (kept.length === 24) break;
      if (fixed.some((f) => Math.abs(a[0] - f) < ANCHOR_GAP)) continue;
      if (a[0] <= 0 || a[0] >= L) continue;
      if (kept.length && a[0] - kept[kept.length - 1][0] < ANCHOR_GAP) continue;
      kept.push(a);
    }
    out[name] = kept;
  }
  return out;
}

function cleanSlices(p) {
  const L = p.length, kept = [];
  const side = (list) => {
    const pts = (Array.isArray(list) ? list : []).filter(pairOk)
      .map((a) => [a[0], clip(a[1], -0.6, 0.6)]).sort((a, b) => a[0] - b[0]);
    const k = [];
    for (const a of pts) {
      if (k.length === 16) break;
      if (a[0] < 0.03 || a[0] > 0.97) continue;
      if (k.length && a[0] - k[k.length - 1][0] < 0.03) continue;
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
 * Correction for one design curve, evaluated at the stations x.
 * The pinned points split the curve into spans that are solved separately and held level
 * at each pin, so moving an anchor only reshapes its own span (no ripple into the rest of
 * the board). At the tips the slope is left free.
 */
function curveDelta(p, name, x) {
  const out = new Float64Array(x.length), pts = p.anchors[name];
  if (!pts.length) return out;
  const L = p.length, pin = pinsFor(p, name);
  const P = [0];
  if (pin.tail12) P.push(12);
  P.push(pin.origin);
  if (pin.nose12) P.push(L - 12);
  P.push(L);
  for (let s = 0; s < P.length - 1; s++) {
    const a = P[s], b = P[s + 1];
    const inside = pts.filter((q) => q[0] > a && q[0] < b);
    if (!inside.length) continue;
    const xs = [a, ...inside.map((q) => q[0]), b], ys = [0, ...inside.map((q) => q[1]), 0];
    const m = pchipSlopes(xs, ys, s > 0, s < P.length - 2);
    for (let i = 0; i < x.length; i++) if (x[i] > a && x[i] < b) out[i] = hermiteAt(xs, ys, m, x[i]);
  }
  return out;
}

/**
 * Cross-section slices. A slice can adjust the section's shape settings (deck dome, rail
 * fullness, rail apex, rail edge, concave, vee) and carry anchor points on its deck and
 * bottom lines: [eta, d] with eta = 0 at the stringer and 1 at the rail, d = vertical
 * offset as a fraction of the local thickness. Everything a slice changes blends smoothly
 * to nothing toward the neighbouring slices and the tips.
 */
function sliceTables(p) {
  const sl = p.slices;
  const pts = sl.some((s) => s.deck.length || s.bottom.length);
  if (!pts && !sl.some((s) => Object.values(s.adj).some((v) => v !== 0))) return null;
  const table = (list) => {
    const T = new Float64Array(GRID);
    if (!list.length) return T;
    const xs = [0, ...list.map((a) => a[0]), 1], ys = [0, ...list.map((a) => a[1]), 0];
    const m = pchipSlopes(xs, ys, true, false);          // level across the stringer
    for (let g = 0; g < GRID; g++) T[g] = hermiteAt(xs, ys, m, g / (GRID - 1));
    T[GRID - 1] = 0;
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

/** Section shape settings at x: the board-wide values plus a slice adjustment d (or none). */
function sectionShape(p, x, d) {
  const g = (k) => (d ? d[k] : 0);
  return {
    ar: clip(p.rail_apex + g('rail_apex'), 0.15, 0.6),
    ed: 1.7 + 1.4 * clip(p.rail_fullness + g('rail_fullness'), 0, 1),
    eb: 2 + 6 * clip(railHardness(p, x) + g('rail_hardness'), 0, 1),
    dome: clip(p.deck_dome + g('deck_dome'), 0, 1),
    con: clip(concaveAt(p, x) + g('concave'), 0, 0.5),
    vee: clip(veeAt(p, x) + g('vee'), 0, 0.5),
  };
}
/** Board-wide section settings at x, in the same terms a slice adjusts (for the UI). */
export function sectionBase(p, x) {
  return { rail_apex: p.rail_apex, rail_fullness: p.rail_fullness, deck_dome: p.deck_dome,
    rail_hardness: railHardness(p, x), concave: concaveAt(p, x), vee: veeAt(p, x) };
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

function notchHalfWidth(p, x) {
  const out = new Float64Array(x.length);
  if (!TAIL_TYPES[p.tail_type].notch) return out;
  for (let i = 0; i < x.length; i++) out[i] = Math.max((p.swallow_width / 2) * (1 - x[i] / p.swallow_depth), 0);
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

function sections(p, x, h, yin, t, zb, M, sl) {
  const n = x.length;
  const Yo = new Float64Array(n * M), Zo = new Float64Array(n * M);
  const Y = new Float64Array(K), Z = new Float64Array(K), cum = new Float64Array(K);
  const rowD = new Float64Array(GRID), rowB = new Float64Array(GRID), d = {};
  for (let i = 0; i < n; i++) {
    const hi = h[i], ti = t[i];
    if (sl) {                                            // blend what the two neighbouring slices change
      let j = 0;
      while (j < sl.kx.length - 2 && x[i] >= sl.kx[j + 1]) j++;
      const tt = clip((x[i] - sl.kx[j]) / (sl.kx[j + 1] - sl.kx[j]), 0, 1);
      const wq = tt * tt * tt * (tt * (6 * tt - 15) + 10);
      for (const k in sl.adj) d[k] = (1 - wq) * sl.adj[k][j] + wq * sl.adj[k][j + 1];
      if (sl.pts) for (let g = 0; g < GRID; g++) {
        rowD[g] = (1 - wq) * sl.deck[j][g] + wq * sl.deck[j + 1][g];
        rowB[g] = (1 - wq) * sl.bottom[j][g] + wq * sl.bottom[j + 1][g];
      }
    }
    const { ar, ed, eb, dome, con, vee } = sectionShape(p, x[i], sl ? d : null);
    const zApex = zb[i] + ar * ti, td = (1 - ar) * ti, tb = ar * ti;
    const hs = Math.max(hi, 1e-9), yi = yin[i];
    for (let k = 0; k < K; k++) {
      const deck = TH_DECK[k], e = deck ? ed : eb;
      const yraw = hi * TH_COS[k] ** (2 / e);
      const eta = clip(yraw / hs, 0, 1);
      Z[k] = deck
        ? zApex + td * TH_SIN[k] ** (2 / ed) * (1 - 0.7 * dome * eta * eta)
        : zApex - tb * TH_SIN[k] ** (2 / e) + con * (1 - eta * eta) ** 2 - vee * (1 - eta);
      if (sl && sl.pts) Z[k] += ti * gridAt(deck ? rowD : rowB, eta);
      Y[k] = yi + (yraw * (hi - yi)) / hs;
    }
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
  if (TAIL_TYPES[p.tail_type].notch) xs.push(p.swallow_depth);
  for (const s of p.slices) xs.push(s.x);
  xs.sort((a, b) => a - b);
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1e-3) out.push(xs[i]);  // np.unique + gap filter
  return Float64Array.from(out);
}

function buildMesh(p, tScale) {
  const x = stationXs(p), n = x.length, M = p.section_points;
  // base curves, then the anchor-point corrections
  const h0 = halfWidth(p, x), zb0 = rocker(p, x), foil0 = foil(p, x);
  const dh = curveDelta(p, 'outline', x), dz = curveDelta(p, 'rocker', x), dt = curveDelta(p, 'thickness', x);
  const h = Float64Array.from(h0, (v, i) => Math.max(v + dh[i], 0.15 * v));
  const zb = Float64Array.from(zb0, (v, i) => v + dz[i]);
  const t = Float64Array.from(foil0, (v, i) => {
    const ti = Math.max(v + dt[i], 0.15 * v) * tScale;
    return ti * Math.tanh((1.5 * h[i]) / Math.max(ti, 1e-9));   // pinch where the outline gets narrow
  });
  const notch = notchHalfWidth(p, x);
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
  return { V, F: faces, vol, prof: { x, h, yin, zb, t, Y, Z, M, h0, zb0, foil0, sl } };
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
  return [['Nose tip', L], ['12" from nose', L - 12], ['Wide point', L / 2 + p.wide_point_offset], ['12" from tail', 12], ['Tail end', 0]]
    .map(([label, xs]) => ({
      label, from_nose_in: L - xs,
      width_in: xs === 0 && !tail.closes ? p.tail_block_width : 2 * interp(xs, x, h),
      rocker_in: interp(xs, x, zb), thickness_in: interp(xs, x, t),
    }));
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
 * One user slice in a form the section editor can use: closed-form deck and bottom
 * heights (relative to the bottom centerline) as functions of eta = 0 (stringer) .. 1 (rail).
 */
export function sliceInfo(board, k) {
  const p = board.params, pr = board._profiles, s = p.slices[k];
  let i = 0;
  for (let q = 1; q < pr.x.length; q++) if (Math.abs(pr.x[q] - s.x) < Math.abs(pr.x[i] - s.x)) i = q;
  const h = pr.h[i], t = pr.t[i], yin = pr.yin[i];
  const { ar, ed, eb, dome, con, vee } = sectionShape(p, s.x, s.adj);
  const row = (which) => (pr.sl && pr.sl.pts ? pr.sl[which][k + 1] : null);
  const off = (which, eta) => (row(which) ? t * gridAt(row(which), clip(eta, 0, 1)) : 0);
  return {
    x: s.x, id: s.id, h, t, yin, adj: s.adj, base: sectionBase(p, s.x),
    y: (eta) => yin + eta * (h - yin),
    deck: (eta, withAnchors = true) =>
      ar * t + (1 - ar) * t * (1 - eta ** ed) ** (1 / ed) * (1 - 0.7 * dome * eta * eta) + (withAnchors ? off('deck', eta) : 0),
    bottom: (eta, withAnchors = true) =>
      ar * t - ar * t * (1 - eta ** eb) ** (1 / eb) + con * (1 - eta * eta) ** 2 - vee * (1 - eta) + (withAnchors ? off('bottom', eta) : 0),
    offset: (which, eta) => (row(which) ? gridAt(row(which), clip(eta, 0, 1)) : 0),
  };
}

export function specSheet(board) {
  const s = board.stats, p = board.params;
  const name = (v) => v.replace(/_/g, ' ');
  const L = (str, n) => str.padEnd(n), R = (str, n) => str.padStart(n);
  const lines = [
    `${fmtFtin(s.length_in)} x ${fmtIn(s.width_in)} x ${fmtIn(s.thickness_in)}   ${s.volume_l.toFixed(1)} L`,
    `nose: ${name(p.nose_type)}    tail: ${name(p.tail_type)}`,
    '',
    `${L('Station', 16)}${R('From nose', 11)}${R('Width', 10)}${R('Rocker', 10)}${R('Thickness', 11)}`,
    ...s.stations.map((r) => `${L(r.label, 16)}${R(fmtFtin(r.from_nose_in), 11)}${R(fmtIn(r.width_in), 10)}${R(fmtIn(r.rocker_in), 10)}${R(fmtIn(r.thickness_in), 11)}`),
    '',
    `wide point   ${fmtIn(p.wide_point_offset)} from center (+ = toward nose)`,
    `rocker low   ${fmtIn(p.rocker_low_point)} from center`,
    `thick point  ${fmtIn(p.thickness_point_offset)} from center`,
    `rails        apex ${Math.round(p.rail_apex * 100)}% of thickness, fullness ${p.rail_fullness.toFixed(2)}, deck dome ${p.deck_dome.toFixed(2)}`,
    `bottom       concave ${fmtIn(p.concave_depth)}, tail vee ${fmtIn(p.vee_depth)}`,
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
