/*
 * Parametric surfboard geometry, in the browser.
 *
 * A line-for-line port of surfboard/geometry.py so the app runs as a static web page.
 * The Python module stays the reference: tests/test_js_parity.py checks that both give
 * the same board (stations, volume, warnings) for every preset and random designs.
 *
 * Board space, inches:  x along the stringer (0 = tail, L = nose),  y across,  z up.
 */
import { DEFAULTS, NOSE_TYPES, TAIL_TYPES } from './data.js?v=23';

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
const ADJ = { rail_apex: 0.45, rail_apex_in: 1.5, rail_fullness: 1, deck_dome: 1, concave: 0.5, double: 0.5, vee: 0.5,
  apex_deck_angle: 80, apex_deck_arm: 0.5, apex_bottom_angle: 80, apex_bottom_arm: 0.5, rail_tuck_in: 4, edge: 1,
  edge_arms: 1, edge_arm_angle: 90, edge_arm_rail: 1, edge_arm_flat: 3 };   // the tuck (edge) point's arms: on (0..1), rail arm angle above the bottom (deg) and length (fraction of edge -> apex), bottom arm (inches)
const PINCH_MAX = 80;                                            // apex arm angle, degrees in from upright: 0 = upright, 80 = nearly a knife edge
const ARM_MAX = 0.5;                                            // apex arm length, fraction of the height that side spans
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
const smoother = (t) => { t = clip(t, 0, 1); return t * t * t * (t * (6 * t - 15) + 10); };

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
  base.tools = Array.isArray(d.tools) ? d.tools : [];      // concave tools (newer than the generated defaults)
  for (const k of ['rail_tuck_nose', 'rail_tuck_tail', 'hard_edge', 'rail_reach_nose', 'rail_reach_tail', 'swallow_round', 'swallow_rail', 'deck_contours', 'curve_v', 'deck_flat', 'diamond_depth', 'deck_flat_corner', 'deck_flat_in', 'nose_beak', 'nose_beak_pos']) if (k in d) base[k] = d[k];   // rail tucks (newer too)
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
  if (!Number.isFinite(p.swallow_tip)) p.swallow_tip = 1;
  clamp('swallow_tip', 0, 1);
  if (tail.notch) { clamp('swallow_width', 1, p.tail_block_width - (2 * tail.corner + 1) * p.swallow_tip - 0.25); clamp('swallow_depth', 1, 10); }

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
  railTuckFromOld(p);
  if (!Number.isFinite(p.swallow_round)) p.swallow_round = 0;
  clamp('swallow_round', 0, 6);
  if (!Number.isFinite(p.diamond_depth)) p.diamond_depth = 2.5;
  clamp('diamond_depth', 0.5, Math.min(8, 0.3 * p.length));
  deckFlatFromOld(p);
  clamp('deck_flat_in', 0.25, 8);
  p.nose_beak = p.nose_beak === true;
  if (!Number.isFinite(p.nose_beak_pos)) p.nose_beak_pos = 2;
  clamp('nose_beak_pos', 0.25, 5);
  if (!Number.isFinite(p.deck_flat)) p.deck_flat = 0;
  clamp('deck_flat', 0, 1);
  if (!Number.isFinite(p.swallow_rail)) p.swallow_rail = 0;     // older designs: a square wall inside the cut
  clamp('swallow_rail', 0, 1);
  for (const n of ['rail_fullness', 'deck_dome', 'rail_hardness_nose', 'rail_hardness_tail', 'rail_reach_nose', 'rail_reach_tail']) clamp(n, 0, 1);
  clamp('rail_tuck_nose', 0, 4); clamp('rail_tuck_tail', 0, 4);
  p.hard_edge = !!p.hard_edge;
  clamp('concave_depth', 0, 0.4);
  clamp('vee_depth', 0, 0.4);
  clamp('target_volume', 10, 120);
  p.stations = Math.trunc(clip(p.stations, 41, 401));
  p.section_points = Math.trunc(clip(Math.max(p.section_points, 96), 16, 192));   // at least 96: small tucks and concave edges need the points
  if (Number.isFinite(p.rail_apex_in)) clamp('rail_apex_in', 0.1, 2.5); else p.rail_apex_in = null;
  p._auto = auto;
  p.marks = cleanMarks(p);
  p._marks = markKnots(p);
  if (p.curve_v !== 2) armsToAuto(p);                  // older designs: arm lengths meant something else; keep the slopes
  p.handles = cleanHandles(p);
  p.anchors = cleanAnchors(p);
  p.slices = cleanSlices(p);
  p.bottom = cleanBottom(p);
  p._bottom = bottomCurves(p);
  p.tools = cleanTools(p);
  p.deck_contours = cleanDeck(p);
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

/**
 * Where a position the shaper typed sits on the board: "pos inches from the nose / tail", or
 * from the center (pos > 0 toward the nose, < 0 toward the tail). Returns x from the tail.
 */
export const FROM = ['nose', 'tail', 'center'];
export const posToX = (r, L) => (r.from === 'nose' ? L - r.pos : r.from === 'center' ? L / 2 + r.pos : r.pos);
const fromOf = (f) => (FROM.includes(f) ? f : 'tail');
/** "3 from nose", "1 behind center": a typed position in words, for the spec sheet. */
const whereIs = (r) => (r.from === 'center' ? `${fmtIn(Math.abs(r.pos))} ${r.pos < 0 ? 'behind' : 'ahead of'} center` : `${fmtIn(r.pos)} from ${r.from}`);

function cleanMarks(p) {
  const L = p.length, rows = [];
  for (const r of Array.isArray(p.marks) ? p.marks : []) {
    if (!r || !Number.isFinite(r.pos)) continue;
    const from = fromOf(r.from), x = posToX({ pos: r.pos, from }, L);
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
    for (const key of ['tail', 'tail12', 'origin', 'nose12', 'nose']) {
      if ((key === 'tail12' || key === 'nose12') && !pin[key]) continue;
      const hd = handleOf(s[key], 3);
      if (!hd) continue;
      if (key === 'origin') hd[0] = null;                 // the wide / low / thick point stays level
      if (hd.some((q) => q !== null)) o[key] = hd;
    }
    out[name] = o;
  }
  const sw = handleOf(src.swallow && src.swallow.tail, 3);
  out.swallow = sw && sw.some((q) => q !== null) ? { tail: [sw[0], null, sw[2]] } : {};
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
    const adj = {}, set = [];
    for (const [k, lim] of Object.entries(ADJ)) {
      const v = s.adj ? s.adj[k] : undefined;
      adj[k] = Number.isFinite(v) ? clip(v, -lim, lim) : 0;
      if (Number.isFinite(v)) set.push(k);                       // what the shaper actually changed here
    }
    const deck = side(s.deck), bottom = side(s.bottom);
    kept.push({ x: s.x, id: s.id ?? null, deck, bottom, adj, set, edited: set.length > 0 || deck.length > 0 || bottom.length > 0 });
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
  const L = p.length, rows = [], stretches = [];
  for (const r of Array.isArray(p.bottom) ? p.bottom : []) {
    if (!r || !Number.isFinite(r.pos)) continue;
    const from = fromOf(r.from);
    const type = Object.prototype.hasOwnProperty.call(BOTTOM_TYPES, r.type) ? r.type : 'flat';
    const depth = Number.isFinite(r.depth) ? clip(r.depth, 0, 0.75) : 0, depth2 = Number.isFinite(r.depth2) ? clip(r.depth2, 0, 0.75) : 0;
    const [c, d, v] = BOTTOM_TYPES[type](depth, depth2);
    const x = clip(posToX({ pos: r.pos, from }, L), 0, L);
    const base = { pos: r.pos, from, type, depth, depth2, src: rows.length + stretches.length };
    const x2 = r.to && Number.isFinite(r.to.pos) ? clip(posToX({ pos: r.to.pos, from: fromOf(r.to.from) }, L), 0, L) : null;
    if (x2 === null || Math.abs(x2 - x) < 0.5) { rows.push({ ...base, x, c, d, v }); continue; }
    // a stretch ("single concave from 3 off the nose until 1 behind center"): full depth at its deepest
    // spot (or the whole way, with no blends), easing out toward each end as its blends say, then
    // blended toward the stations either side as usual
    const x0 = Math.min(x, x2), x1 = Math.max(x, x2);
    const xd = r.deep && Number.isFinite(r.deep.pos) ? clip(posToX({ pos: r.deep.pos, from: fromOf(r.deep.from) }, L), x0, x1) : (x0 + x1) / 2;
    const bn = blendOf(r.blendNose, 0), bt = blendOf(r.blendTail, 0);
    const S = { ...base, x0, x1, xd, bn, bt, c, d, v, to: { pos: r.to.pos, from: fromOf(r.to.from) }, deep: r.deep && Number.isFinite(r.deep.pos) ? { pos: r.deep.pos, from: fromOf(r.deep.from) } : null };
    // its depth along the board, worked out exactly wherever it is needed (no sampled rows, so no
    // kinks): inside, as its deepest spot and blends say; past an end it still holds at (blend 0),
    // it eases out over 6", unless that end is the end of the board
    const R = 6;
    S.f = (q) => {
      if (q >= x0 && q <= x1) return depthAlong(q, x0, x1, xd, bn, bt);
      if (q > x1) return x1 >= L - 0.5 ? 1 : depthAlong(x1, x0, x1, xd, bn, bt) * smoother(1 - (q - x1) / R);
      return x0 <= 0.5 ? 1 : depthAlong(x0, x0, x1, xd, bn, bt) * smoother(1 - (x0 - q) / R);
    };
    S.vs = 1;                                            // a vee deeper than the rail can take is scaled down as a whole (see buildMesh)
    S.at = (q) => { const f = S.f(q); return [c * f, d * f, v * S.vs * f]; };
    stretches.push(S);
  }
  // two stretches that meet end to end (within 3") cross-fade into each other instead of each easing
  // out to a flat bottom: the one toward the tail fades out while the one toward the nose fades in,
  // across both their blends (at least 6"), so there is no flat trough between them
  stretches.sort((a, b) => a.x0 - b.x0);
  for (const A of stretches) for (const B of stretches) {
    if (A === B || Math.abs(B.x0 - A.x1) > 3 || B.x0 < A.x0 + 1 || A.x1 > B.x1 - 1) continue;
    const fA = A.f, fB = B.f;
    let ws = A.x1 - A.bn * (A.x1 - A.xd), we = B.x0 + B.bt * (B.xd - B.x0);
    if (we - ws < 6) { const mid = (ws + we) / 2; ws = mid - 3; we = mid + 3; }
    const a0 = fA(ws), b1 = fB(we);
    A.f = (q) => (q <= ws ? fA(q) : q >= we ? 0 : a0 * (1 - smoother((q - ws) / (we - ws))));
    B.f = (q) => (q >= we ? fB(q) : q <= ws ? 0 : b1 * smoother((q - ws) / (we - ws)));
    A.joinNose = B.joinTail = [ws, we];
  }
  rows.sort((a, b) => a.x - b.x);
  const kept = [];
  for (const r of rows) {
    if (kept.length === 64) break;
    const last = kept[kept.length - 1];
    if (last && r.x - last.x < 0.5) {                    // two at (almost) the same spot: one station with the stronger contour of each
      if (Math.abs(r.c) > Math.abs(last.c)) last.c = r.c;
      last.d = Math.max(last.d, r.d); last.v = Math.max(last.v, r.v);
      continue;
    }
    kept.push(r);
  }
  kept.stretches = stretches;
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
/** The stronger of two contours, without a corner where one overtakes the other (a smooth max, 1/100" wide). */
const smax = (a, b, k = 0.01) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2 - (k / 2) * Math.exp(-Math.abs(a - b) / k);
const stronger = (a, b) => (a >= 0 && b >= 0 ? smax(a, b) : a <= 0 && b <= 0 ? -smax(-a, -b) : a + b);
function bottomAt(p, x) {
  const b = p._bottom, S = p.bottom.stretches || [];
  if (!b && !S.length) return [concaveAt(p, x), 0, veeAt(p, x)];             // the simple Concave / Vee sliders
  let out = [0, 0, 0];
  if (b) { const xq = clip(x, b.xs[0], b.xs[b.xs.length - 1]); out = [hermiteAt(b.xs, b.C, b.mC, xq), hermiteAt(b.xs, b.D, b.mD, xq), hermiteAt(b.xs, b.V, b.mV, xq)]; }
  for (const st of S) { const [c, d, v] = st.at(x); out = [stronger(out[0], c), stronger(out[1], d), stronger(out[2], v)]; }
  return out;
}

/**
 * Correction for one design curve, evaluated at the stations x (base: the closed-form curve there,
 * baseFn(xs) the same curve anywhere). Every point works the same way, measured or anchor:
 *  - its height is held (measured points: the closed-form curve's own; anchors: their offset),
 *  - its slope is the one its handle was given, or else follows its neighbours (no flat spot at a
 *    measured point; the wide / low / thick point stays level so it stays the widest / lowest / thickest),
 *  - between points the curve is smooth in curvature (C2 within each span between measured points),
 *  - its arms are fullness on the curve itself: longer than the automatic third of the span, the curve
 *    hugs the arm's line further (fuller); shorter, it falls away from it sooner.
 * Moving a point reshapes its own span and, through the slope at the measured points, the next span a little.
 */
function curveDelta(p, name, x, arms, baseFn) {
  const out = new Float64Array(x.length);
  const pts = [...p.anchors[name], ...p._marks[name]].sort((a, b) => a[0] - b[0]);
  const L = p.length, pin = pinsFor(p, name), H = p.handles[name];
  const P = [[0, 'tail']];
  if (pin.tail12) P.push([12, 'tail12']);
  P.push([pin.origin, 'origin']);
  if (pin.nose12) P.push([L - 12, 'nose12']);
  P.push([L, 'nose']);
  // every knot in order: [x, offset, fixed slope or null, left arm, right arm, pin key]
  const K = [];
  for (const [px, key] of P) {
    const hd = H[key];
    const m = hd && Number.isFinite(hd[0]) ? hd[0] : key === 'origin' ? 0 : null;
    K.push([px, 0, m, hd ? hd[1] : null, hd ? hd[2] : null, key]);
  }
  for (const q of pts) if (!K.some((k) => Math.abs(k[0] - q[0]) < 0.05)) K.push([q[0], q[1], Number.isFinite(q[2]) ? q[2] : null, q[3], q[4], null]);
  K.sort((a, b) => a[0] - b[0]);
  const n = K.length, xs = K.map((k) => k[0]), ys = K.map((k) => k[1]), m = K.map((k) => k[2]);
  const tip = (i) => K[i][5] === 'tail' || K[i][5] === 'nose';       // the nose and tail points work as they did before: their arms are Bezier arms
  // measured points between the tips with no slope of their own: the slope through their neighbours (parabola)
  for (let i = 1; i < n - 1; i++) if (K[i][5] && m[i] === null) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i], d0 = (ys[i] - ys[i - 1]) / h0, d1 = (ys[i + 1] - ys[i]) / h1;
    m[i] = (h1 * d0 + h0 * d1) / (h0 + h1);
  }
  // C2 slopes for the rest, span by span between knots with a known slope (the tips are free ends)
  let a0 = 0;
  for (let b0 = 1; b0 < n; b0++) {
    if (m[b0] === null && b0 < n - 1) continue;
    splineSlopes(xs, ys, m, a0, b0);
    a0 = b0;
  }
  if (!ys.some((v) => v !== 0) && !m.some((v) => v !== 0) && !K.some((k) => Number.isFinite(k[3]) || Number.isFinite(k[4]))) {
    if (arms) fillArms(arms, K, m, null);
    return out;
  }
  const curve = knotCurve(K.map((k, i) => (tip(i) ? [xs[i], ys[i], k[2], k[3], k[4]] : [xs[i], ys[i], m[i], null, null])), false, false);
  for (let i = 0; i < x.length; i++) if (x[i] > 0 && x[i] < L) out[i] = curve.at(x[i]);
  // fullness: an arm longer or shorter than a third of its span pulls the curve toward, or away from, its line
  const pulls = [];
  for (let i = 0; i < n; i++) for (const side of [-1, 1]) {
    if (tip(i)) continue;
    const len = K[i][side < 0 ? 3 : 4], j = i + side;
    if (!Number.isFinite(len) || j < 0 || j >= n) continue;
    const span = Math.abs(xs[j] - xs[i]), r = clip(len / (span / 3), 0.1, 3);
    if (Math.abs(r - 1) < 1e-3) continue;
    const bx = Float64Array.of(xs[i] - 0.01, xs[i], xs[i] + 0.01), bv = baseFn(bx);
    const y0 = bv[1] + ys[i], S = (bv[2] - bv[0]) / 0.02 + m[i];
    pulls.push({ x0: xs[i], x1: xs[j], y0, S, lam: r >= 1 ? Math.min(r - 1, 1) : Math.max(r - 1, -0.5), ex: r > 2 ? r - 1 : 1 });
  }
  if (pulls.length) {
    const bx = Float64Array.from(x), bv = baseFn(bx);
    const add = new Float64Array(x.length);
    for (const q of pulls) {
      const lo = Math.min(q.x0, q.x1), hi = Math.max(q.x0, q.x1);
      for (let i = 0; i < x.length; i++) {
        if (x[i] <= lo || x[i] >= hi) continue;
        const sN = Math.abs(x[i] - q.x0) / (hi - lo), sx = sN ** q.ex, w = q.lam * (1 - sx) * (1 - sx) * (1 + 2 * sx);
        add[i] += w * (q.y0 + q.S * (x[i] - q.x0) - (bv[i] + out[i]));
      }
    }
    for (let i = 0; i < x.length; i++) out[i] += add[i];
  }
  if (arms) fillArms(arms, K, m, curve);
  return out;
}

/** Older designs (before arms meant fullness): their arm lengths go back to automatic, slopes kept. */
export function armsToAuto(p) {
  const clear = (q) => { if (Array.isArray(q)) { q[3] = null; q[4] = null; } };
  const H = p.handles && typeof p.handles === 'object' ? p.handles : {};
  for (const name of ['outline', 'rocker', 'thickness']) for (const [key, hd] of Object.entries(H[name] || {})) if (Array.isArray(hd) && key !== 'tail' && key !== 'nose') { hd[1] = null; hd[2] = null; }
  for (const name of ['outline', 'rocker', 'thickness']) for (const q of (p.anchors && p.anchors[name]) || []) clear(q);
  for (const r of p.marks || []) for (const f of ['hw', 'hr', 'ht']) if (Array.isArray(r[f])) { r[f][1] = null; r[f][2] = null; }
  p.curve_v = 2;
}

/** The arms the graphs draw: each point's slope and arm lengths (its own, or a third of the span). */
function fillArms(arms, K, m, curve) {
  arms.pins = {};
  for (let i = 0; i < K.length; i++) {
    if (curve && (K[i][5] === 'tail' || K[i][5] === 'nose')) { arms.pins[K[i][5]] = curve.arms[i]; continue; }   // the tips: their Bezier arms, as before
    const gl = i > 0 ? (K[i][0] - K[i - 1][0]) / 3 : NaN, gr = i < K.length - 1 ? (K[i + 1][0] - K[i][0]) / 3 : NaN;
    const r = { x: K[i][0], m: m[i] ?? 0, aL: Number.isFinite(K[i][3]) ? Math.min(K[i][3], 3 * gl) : gl, aR: Number.isFinite(K[i][4]) ? Math.min(K[i][4], 3 * gr) : gr };
    if (K[i][5]) arms.pins[K[i][5]] = r; else arms.push(r);
  }
}

/** Fill the unknown slopes m[a+1..b-1] (and m[a] / m[b] when unknown: free ends) so the curve through them is C2. */
function splineSlopes(xs, ys, m, a, b) {
  const idx = [];
  for (let i = a; i <= b; i++) if (m[i] === null) idx.push(i);
  if (!idx.length) return;
  const N = idx.length, A = new Float64Array(N), B = new Float64Array(N), C = new Float64Array(N), D = new Float64Array(N);
  idx.forEach((i, r) => {
    const hl = i > a ? xs[i] - xs[i - 1] : 0, hr = i < b ? xs[i + 1] - xs[i] : 0;
    let rhs = 0, diag = 0;
    if (hl > 0) { diag += 2 / hl; rhs += (3 * (ys[i] - ys[i - 1])) / (hl * hl); if (m[i - 1] === null) A[r] = 1 / hl; else rhs -= m[i - 1] / hl; }
    if (hr > 0) { diag += 2 / hr; rhs += (3 * (ys[i + 1] - ys[i])) / (hr * hr); if (m[i + 1] === null) C[r] = 1 / hr; else rhs -= m[i + 1] / hr; }
    B[r] = diag; D[r] = rhs;
  });
  for (let r = 1; r < N; r++) { const w = A[r] / B[r - 1]; B[r] -= w * C[r - 1]; D[r] -= w * D[r - 1]; }
  const sol = new Float64Array(N);
  sol[N - 1] = D[N - 1] / B[N - 1];
  for (let r = N - 2; r >= 0; r--) sol[r] = (D[r] - C[r] * sol[r + 1]) / B[r];
  idx.forEach((i, r) => { m[i] = sol[r]; });
}

/**
 * Cross-section slices. A slice can adjust the section's shape settings (deck dome, rail
 * fullness, rail apex, rail edge, concave, vee) and carry anchor points on its deck and
 * bottom lines: [rho, d] with rho the position along the line by arc length (0 at the
 * stringer, 1 at the rail apex, so the turn of the rail gets its fair share) and d how far
 * the surface moves along its own normal there, as a fraction of the local thickness
 * (deck: outward; bottom: up, which is inward at the rail). On the flat of the deck and
 * bottom that is straight up and down; on the rail it is in and out.
 *
 * Edited sections lead: each setting is pinned only at the sections where the shaper changed
 * it, and runs through them as one smooth curve (no flat spot at each section). Past the last
 * edited section toward a tip it carries on along its trend and eases off gently, keeping most
 * of the change when that section is near the tip (so an apex lowered 4" from the tail releases
 * out the tail instead of snapping back), and fading out over the run when it is far from it.
 */
function sliceTables(p) {
  const sl = p.slices, L = p.length;
  const pts = sl.some((s) => s.deck.length || s.bottom.length);
  if (!pts && !sl.some((s) => s.set.length)) return null;
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
  for (const k of Object.keys(ADJ)) {
    const on = sl.filter((s) => s.set.includes(k));
    if (on.length) adj[k] = sliceTrack(on.map((s) => s.x), on.map((s) => Float64Array.of(s.adj[k])), L);
  }
  const deck = [zero, ...sl.map((s) => table(s.deck))], bottom = [zero, ...sl.map((s) => table(s.bottom))];
  const rows = (which) => {
    const on = sl.map((s, i) => [s, deck === which ? deck[i + 1] : bottom[i + 1]]).filter(([s]) => (which === deck ? s.deck : s.bottom).length);
    return on.length ? sliceTrack(on.map(([s]) => s.x), on.map(([, T]) => T), L) : null;
  };
  return { pts, adj, deck, bottom, deckT: rows(deck), bottomT: rows(bottom) };
}

/**
 * A smooth track through values (each a Float64Array, so a whole offset row can ride along)
 * pinned at xs. Inside: shape-preserving cubic, level at the outermost edited sections. Outside,
 * toward the tip a distance D away: the end value eases toward k = 1 - D/24 of itself (kept
 * whole at the tip, gone if 24" or more away), within 24".
 */
function sliceTrack(xs, Y, L) {
  const n = xs.length, G = Y[0].length, M = Y.map(() => new Float64Array(G));
  if (n > 1) {
    const col = new Float64Array(n);
    for (let g = 0; g < G; g++) {
      for (let i = 0; i < n; i++) col[i] = Y[i][g];
      const m = pchipSlopes(xs, col, true, true);             // level at the outer edited sections
      for (let i = 0; i < n; i++) M[i][g] = m[i];
    }
  }
  const smoother = (t) => t * t * t * (t * (6 * t - 15) + 10);
  return (x, out) => {
    if (x <= xs[0] || x >= xs[n - 1]) {
      const head = x <= xs[0], i = head ? 0 : n - 1, D = head ? xs[0] : L - xs[n - 1];
      const Wd = Math.min(D, 24), d = Math.min(Math.abs(x - xs[i]), Wd), t = Wd > 1e-6 ? d / Wd : 0;   // fades within 24" at most
      const k = clip(1 - D / 24, 0, 1), f = 1 - (1 - k) * smoother(t);
      for (let g = 0; g < G; g++) out[g] = f * Y[i][g];
      return out;
    }
    let j = 0;
    while (j < n - 2 && x > xs[j + 1]) j++;
    const hh = xs[j + 1] - xs[j], t = (x - xs[j]) / hh, u = 1 - t;
    const a = (1 + 2 * t) * u * u, b = t * u * u * hh, c = t * t * (3 - 2 * t), e = t * t * (t - 1) * hh;
    const Y0 = Y[j], Y1 = Y[j + 1], M0 = M[j], M1 = M[j + 1];
    for (let g = 0; g < G; g++) out[g] = a * Y0[g] + b * M0[g] + c * Y1[g] + e * M1[g];
    return out;
  };
}

/** What the slices change at position x: fills d (setting adjustments) and, if given, the offset rows. */
const ONE = new Float64Array(1);
function sliceBlend(sl, x, d, rowD, rowB) {
  for (const k of Object.keys(ADJ)) d[k] = sl.adj[k] ? sl.adj[k](x, ONE)[0] : 0;
  if (sl.pts && rowD) {
    if (sl.deckT) sl.deckT(x, rowD); else rowD.fill(0);
    if (sl.bottomT) sl.bottomT(x, rowB); else rowB.fill(0);
  }
}

/**
 * Section shape settings at x for local thickness t: the board-wide values plus a slice
 * adjustment d (or none). The rail apex is a height in inches above the flat bottom line
 * when rail_apex_in is set (older designs give it as a fraction of thickness instead).
 */
/** v, but never past cap: eases into it (no corner along the board where a vee meets its limit). */
/** The smaller of a and b without a corner (rounded over about 1/64"): a tool's lift where it runs into its limit. */
const sMin = (a, b) => { const k = Math.min(0.015, 0.3 * b); if (!(k > 1e-6)) return Math.min(a, b); const z = (b - a) / k; return b - (z > 30 ? b - a : k * Math.log1p(Math.exp(z))); };
const softCap = (v, cap) => (v > 0 && cap > 0 ? (v ** -8 + cap ** -8) ** -0.125 : Math.max(Math.min(v, cap), 0));
function sectionShape(p, x, d, t) {
  const g = (k) => (d ? d[k] : 0);
  const [c0, d0, v0] = bottomAt(p, x);
  let con = clip(c0 + g('concave'), -0.5, 0.75), dbl = clip(d0 + g('double'), 0, 0.75);
  const lift = Math.abs(con) + dbl, cap = 0.5 * t;                // never carve more than half the thickness
  if (lift > cap) { const f = cap / lift; con *= f; dbl *= f; }
  return {
    ar: p.rail_apex_in !== null ? apexRatio(p.rail_apex_in + g('rail_apex_in'), t) : clip(p.rail_apex + g('rail_apex'), 0.15, 0.6),
    ed: 1.7 + 1.4 * clip(p.rail_fullness + g('rail_fullness'), 0, 1),
    // the bottom of the rail: tuck (inches in from the apex to the flat bottom) and edge (0 = soft, 1 = a hard corner)
    tuck: clip(railTuckAt(p, x).w + g('rail_tuck_in'), 0, 4),
    hard: clip(railTuckAt(p, x).hard + g('edge'), 0, 1),
    dome: clip(p.deck_dome + g('deck_dome'), 0, 1),
    con, dbl, vee: softCap(clip(v0 + g('vee'), 0, 0.75), 0.6 * t * (p.rail_apex_in !== null ? apexRatio(p.rail_apex_in + g('rail_apex_in'), t) : clip(p.rail_apex + g('rail_apex'), 0.15, 0.6))),   // never lifts the rail past its apex
    // the rail apex arms (slices only): angle in from upright (degrees) and length (fraction of the height that side spans)
    pd: clip(g('apex_deck_angle'), 0, PINCH_MAX), ld: clip(g('apex_deck_arm'), 0, ARM_MAX),
    pb: clip(g('apex_bottom_angle'), 0, PINCH_MAX), lb: clip(g('apex_bottom_arm'), 0, ARM_MAX),
    // the edge (tuck point) arms (slices only): how much they lead (0 = the tuck as usual), the rail arm's angle above
    // the bottom and its length, and the bottom arm (how far the edge's roundness runs in along the bottom, inches)
    ew: clip(g('edge_arms'), 0, 1), ea: clip(g('edge_arm_angle'), 0, 90), er: clip(g('edge_arm_rail'), 0.02, 1), ef: clip(g('edge_arm_flat'), 0, 3),
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
    rail_tuck_in: railTuckAt(p, x).w, edge: railTuckAt(p, x).hard, concave: c0, double: d0, vee: v0,
    apex_deck_angle: 0, apex_deck_arm: 0, apex_bottom_angle: 0, apex_bottom_arm: 0, edge_arms: 0, edge_arm_angle: 0, edge_arm_rail: 0, edge_arm_flat: 0 };
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
  let te = tail.closes ? 0 : p.tail_block_width / p.width;
  let at = closureExponent((p.tail_width_12 / p.width - te) / (1 - te), bt, (xw - 12) / xw);
  const dd = tail.point ? p.diamond_depth ?? 2.5 : 0;
  if (dd) {                                              // a diamond: solve the tail end so the corners (dd in) are the tail block width, T12 still exact
    const want = p.tail_block_width / p.width;
    for (let it = 0; it < 6; it++) {
      const f = te + (1 - te) * clip(1 - ((xw - dd) / xw) ** at, 0, 1) ** (1 / bt);
      te = clip(te - (f - want), 0, want);
      at = closureExponent((p.tail_width_12 / p.width - te) / (1 - te), bt, (xw - 12) / xw);
    }
  }
  const rc = tail.notch ? tail.corner * (p.swallow_tip ?? 1) : tail.corner;   // a swallow's tips: rounded, or (swallow_tip 0) a point
  const h = new Float64Array(x.length);
  const main = (xi) => (xi >= xw ? W2 * clip(1 - ((xi - xw) / (L - xw)) ** an, 0, 1) ** (1 / bn) : W2 * (te + (1 - te) * clip(1 - ((xw - xi) / xw) ** at, 0, 1) ** (1 / bt)));
  // a diamond tail: the outline runs as usual to the corners, diamond_depth in from the tail end
  // (the tail block width is across them), then straight in to a point on the stringer
  const hd = dd ? main(dd) : 0;
  // pointed and semi-pointed noses finish into a point at an angle over the last 1.5-2" (like Shape3D), not a rounded
  // end: a cubic from the curve (same width and slope where it starts) to the tip, arriving at a definite angle
  const fin = bn < 1.9 ? clip(0.05 * (L - xw), 1.5, 2) : 0, xf = L - fin;
  let finAt = null;
  if (fin) {
    const a0 = main(xf), m0 = (main(xf + 0.01) - main(xf - 0.01)) / 0.02;
    const m1 = -Math.min(2.85 * a0 / fin, Math.max(1.35 * a0 / fin, -m0));
    finAt = (xi) => { const t = (xi - xf) / fin, h00 = (1 + 2 * t) * (1 - t) ** 2, h10 = t * (1 - t) ** 2, h11 = t * t * (t - 1); return h00 * a0 + fin * (h10 * m0 + h11 * m1); };
  }
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    let v = dd && xi < dd ? (hd * xi) / dd : finAt && xi > xf ? finAt(xi) : main(xi);
    if (rc > 0 && xi < rc) v = v - rc + Math.sqrt(Math.max(rc * rc - (rc - xi) ** 2, 0));
    h[i] = Math.max(v, 0);
  }
  return h;
}

function notchHalfWidth(p, x, arms) {
  const out = new Float64Array(x.length);
  if (!TAIL_TYPES[p.tail_type].notch) return out;
  const D = p.swallow_depth, pts = p.anchors.swallow;
  // with pointed tips (swallow_tip 0) the cut reaches right out to the outline at the tail end, so each side ends in a point
  const tip = p.swallow_tip ?? 1, hb = tip < 1 ? halfWidth(p, [0])[0] : 0;
  const w0 = p.swallow_width + Math.max(0, 2 * hb - p.swallow_width) * (1 - tip);
  const tipH = p.handles?.swallow?.tail;                 // the cut's own arm at the tail end (the swallow tip's second arm)
  const curve = pts.length || tipH ? knotCurve([[0, 0, tipH?.[0] ?? null, null, tipH?.[2] ?? null], ...pts, [D, 0, null, null, null]], false, false) : null;
  for (let i = 0; i < x.length; i++) {
    const base = Math.max((w0 / 2) * (1 - x[i] / D), 0);
    out[i] = curve && x[i] > 0 && x[i] < D ? Math.max(base + curve.at(x[i]), 0.1 * base) : base;   // the cut never closes early
  }
  if (arms && curve) { arms.push(...curve.arms.slice(1, -1)); arms.tip = curve.arms[0]; }
  else if (arms) arms.tip = { x: 0, m: 0, aL: NaN, aR: D / 3 };     // a plain V: its automatic arm at the tail end, ready to be pulled
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

/**
 * The rail's tuck along the board. Each end has its tuck (inches in from the rail apex to where
 * the bottom is flat: 0 = the rail drops straight down from the apex, 3" = a very soft rail) and
 * reach (how far up the board that end's tuck holds, as a share of the length); between the two
 * reaches it blends. The hard edge (when ticked) belongs to the tail and blends out the same way.
 */
function railBlend(p, x) {
  const L = p.length, a = clip(p.rail_reach_tail ?? 0.15, 0, 1) * L, b = L - clip(p.rail_reach_nose ?? 0.25, 0, 1) * L;
  if (b - a < 2) { const m = (a + b) / 2; return smoothstep((x - (m - 1)) / 2); }
  return smoothstep((x - a) / (b - a));                   // 0 = tail settings, 1 = nose settings
}
const railTuckAt = (p, x) => { const f = railBlend(p, x); return { w: p.rail_tuck_tail + (p.rail_tuck_nose - p.rail_tuck_tail) * f, hard: p.hard_edge ? 1 - f : 0 }; };
/** Designs from before rail tucks: Rail edge 0 (soft) .. 1 (hard) becomes a tuck in inches, and a hard tail ticks Hard edge. */
/** Designs from before the flat deck corner was in inches (a fraction of the half width out from the stringer) get it in inches in from the rail. */
export function deckFlatFromOld(p) {
  if (!Number.isFinite(p.deck_flat_in)) {
    const fc = Number.isFinite(p.deck_flat_corner) ? clip(p.deck_flat_corner, 0.3, 0.95) : null;
    p.deck_flat_in = fc === null ? 2 : Math.max(0.25, Math.round((1 - fc) * (p.width || 20) / 2 * 16) / 16);
  }
  delete p.deck_flat_corner;
}
export function railTuckFromOld(p) {
  const conv = (H) => Math.round((0.25 + 2.75 * (1 - clip(H, 0, 1)) ** 1.5) * 16) / 16;
  if (!Number.isFinite(p.rail_tuck_nose)) p.rail_tuck_nose = conv(p.rail_hardness_nose ?? 0.25);
  if (!Number.isFinite(p.rail_tuck_tail)) p.rail_tuck_tail = conv(p.rail_hardness_tail ?? 0.85);
  if (typeof p.hard_edge !== 'boolean') p.hard_edge = (p.rail_hardness_tail ?? 0) >= 0.7;
  if (!Number.isFinite(p.rail_reach_tail)) p.rail_reach_tail = 0.15;
  if (!Number.isFinite(p.rail_reach_nose)) p.rail_reach_nose = 0.25;
}
const concaveAt = (p, x) => p.concave_depth * smoothstep((0.8 * p.length - x) / (0.25 * p.length)) * smoothstep(x / 3);
const veeAt = (p, x) => p.vee_depth * smoothstep((0.35 * p.length - x) / (0.3 * p.length));



/* ---------------------------------------------------------------------------
   Deck contours: concave, vee and channels, laid out like the bottom contours (from / until,
   deepest spot, blends toward the nose and tail). The concave and vee keep the stringer on the
   thickness typed in: the concave raises the deck toward the rails out to its width, the vee
   lowers it away from a ridge on the stringer. Channels (one or two a side) cut down into the deck.
   Step decks, step tails and pockets are deck tools (params.tools with surface 'deck').
   --------------------------------------------------------------------------- */
export const DECK_TYPES = { concave: 'Deck concave', vee: 'Deck vee' };   // channels are deck tools now (shape 'channel')

function cleanDeck(p) {
  const L = p.length;
  return (Array.isArray(p.deck_contours) ? p.deck_contours : []).filter((c) => c && DECK_TYPES[c.type] && c.start && c.end).slice(0, 12).map((c) => {
    const at = (r) => clip(posToX({ pos: Number.isFinite(+r.pos) ? +r.pos : 0, from: fromOf(r.from) }, L), 0, L);
    const a = at(c.start), b = at(c.end), num = (v, d, lo, hi) => clip(Number.isFinite(+v) ? +v : d, lo, hi);
    const x0 = Math.min(a, b), x1 = Math.max(a, b);
    return {
      id: c.id, type: c.type, x0, x1, xd: c.deep && Number.isFinite(+c.deep.pos) ? clip(at(c.deep), x0, x1) : (x0 + x1) / 2,
      bn: blendOf(c.blendNose, 0.5), bt: blendOf(c.blendTail, 0.5),
      depth: num(c.depth, 0.125, 0, 0.75),
      width: Number.isFinite(+c.width) && +c.width > 0 ? clip(+c.width, 0.25, 40) : null,    // concave / vee: across (blank = follows the outline); channels: each one
      count: Math.round(num(c.count, 2, 1, 2)), pos: num(c.pos, 3, 0.5, 14), gap: num(c.gap, 2, 0.5, 8), soft: num(c.soft, 0, 0, 1),
    };
  }).filter((c) => c.x1 - c.x0 > 0.25);
}

/** How much of a deck contour is in at x (0..1): deepest spot and blends as on the bottom; past a held end it eases out over 6". */
function deckAlong(c, x, L) {
  const R = 6;
  if (x >= c.x0 && x <= c.x1) return depthAlong(x, c.x0, c.x1, c.xd, c.bn, c.bt);
  if (x > c.x1) return c.x1 >= L - 0.5 ? 1 : depthAlong(c.x1, c.x0, c.x1, c.xd, c.bn, c.bt) * smootherAt(1 - (x - c.x1) / R);
  return c.x0 <= 0.5 ? 1 : depthAlong(c.x0, c.x0, c.x1, c.xd, c.bn, c.bt) * smootherAt(1 - (c.x0 - x) / R);
}

/** The deck contours in at x, with their strength there. */
function deckContoursAt(p, x) {
  const out = [];
  for (const c of p.deck_contours || []) { const a = deckAlong(c, x, p.length); if (a > 1e-6) out.push([c, a]); }
  return out.length ? out : null;
}

/** Extra mesh stations at the ends of the deck tools (a blend of 0 steps there over 3/4"). */
function deckStationXs(p) {
  const xs = [], L = p.length;
  for (const t of p.tools || []) if (t.surface === 'deck') for (const [xe, dir] of [[t.x0, 1], [t.x1, -1]]) {
    if (xe <= 0.25 || xe >= L - 0.25) continue;
    for (const f of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 1]) xs.push(xe + dir * f);
  }
  return xs;
}

/**
 * The deck's height above the rail apex at one point, with the deck contours and deck tools in here.
 * H: the domed deck's height, H0: at the stringer, y: inches out from the stringer, hi: the half width.
 * Concave and vee keep the stringer where it is (the thickness typed in) and fade into the rail's roll.
 */
function deckShape(dc, dt, H, H0, y, hi) {
  let up = 0, down = 0;
  const f = clip(H / Math.max(H0, 1e-9), 0, 1);          // 1 on the flat of the deck, 0 at the rail apex
  if (dc) for (const [c, a] of dc) {
    const d = c.depth * a;
    if (c.type === 'concave' || c.type === 'vee') {
      const hw = Math.min(c.width ? c.width / 2 : 0.7 * hi, 0.95 * hi), t = clip(y / Math.max(hw, 1e-6), 0, 1);
      if (c.type === 'concave') up += d * t * t * (3 - 2 * t) * f;                     // a dish from the stringer out to its width, then the rail
      else down += Math.min(d, 0.8 * H0) * ((t - Math.max(0, t - 0.6) ** 2 / 0.8) / 0.8) * f;   // planes off the stringer, easing level at its width
    } else if (c.type === 'channels') {
      const hwc = c.width ? c.width / 2 : 0.375;
      for (let i = 0; i < c.count; i++) {
        const yc = c.pos + i * c.gap, u = y - yc;
        const reach = u >= 0 ? hwc : hwc + c.soft * Math.max(yc - hwc, 0);             // the stringer side can blend out toward the stringer
        if (Math.abs(u) < reach) down += d * Math.cos((Math.abs(u) / reach) * Math.PI / 2) ** 2;
      }
    }
  }
  for (const q of dt || []) {
    if (q.chan) { down += q.D * groove(y, q.e, q.gw, q.soft); continue; }
    const so = soft(q.e - y);                             // a step deck: a dished pocket with a hard edge, like a tear drop concave
    if (so > 1e-5) { const v = Math.max(q.e - so, 0) / q.e; down += q.D * (1 - v * v); }
  }
  const room = 0.85 * (H + up);
  const cut = down > 0 ? (down * room) / Math.sqrt(down * down + room * room + 1e-12) : 0;   // a soft "no deeper than 85% of the deck"
  return H + up - cut;
}

/* ---------------------------------------------------------------------------
   Concave tools: hard-edged concaves laid out on the bottom, on top of the blended
   contours. Each is an area (tear drop, straight edges, venturi) between two spots along
   the board, single (one dish across the stringer) or double (a dish each side of a ridge).
   Across the area the bottom is lifted by depth x g, where g is a parabola across the dish:
   zero at its edges with a slope there, so each edge is a crease (a hard edge) instead of
   blending away. "Hard on the rail side" (doubles) keeps the crease at the outer edge and
   blends into the ridge. Widths are full widths in inches; t runs 0 at the nose end of the
   tool to 1 at its tail end.
   --------------------------------------------------------------------------- */
export const TOOL_SHAPES = { teardrop: 'Tear drop', straight: 'Straight edges', venturi: 'Venturi', channel: 'Channel' };
/** On the deck: a step deck (a tear drop pocket with a hard edge) and channels. */
export const DECK_SHAPES = { teardrop: 'Step deck', channel: 'Channel' };

/**
 * An edge of a concave tool as a smooth curve through points, like the outline: each point
 * [t, width, angle, left arm, right arm] (t 0 at the nose end of the tool to 1 at its tail end,
 * width = full width in inches; angle in degrees, 0 = running straight along the board, + =
 * widening toward the tail, 90 = straight across; arms in inches). A blank angle or arm is worked
 * out from the neighbouring points. Sampled into a table of (inches from the nose end, half width).
 */
function edgeTable(list, len, W) {
  const pts = (Array.isArray(list) ? list : []).filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
    .map((q) => [clip(+q[0], 0, 1), clip(+q[1], 0, 2 * W), optNum(q[2], -90, 90), optNum(q[3], 0.05, 60), optNum(q[4], 0.05, 60)])
    .sort((a, b) => a[0] - b[0]);
  const k = [];
  for (const q of pts) if (!k.length || q[0] - k[k.length - 1][0] > 0.01) k.push(q);
  if (k.length < 2) return null;
  const P = k.slice(0, 16), Xs = P.map((q) => q[0] * len), Ys = P.map((q) => q[1] / 2);
  const m = pchipSlopes(Xs, Ys, false, false);
  const th = P.map((q, i) => (q[2] !== null ? (q[2] * Math.PI) / 180 : Math.atan(m[i])));
  const X = [], Y = [];
  for (let i = 0; i < P.length - 1; i++) {
    const g = Xs[i + 1] - Xs[i];
    let a = P[i][4] ?? g / 3, b = P[i + 1][3] ?? g / 3;
    const ca = Math.cos(th[i]), cb = Math.cos(th[i + 1]);
    if (a * ca + b * cb > 0.98 * g) { const f = (0.98 * g) / (a * ca + b * cb); a *= f; b *= f; }   // the arms may not cross
    const x0 = Xs[i], y0 = Ys[i], x3 = Xs[i + 1], y3 = Ys[i + 1];
    const x1 = x0 + a * ca, y1 = y0 + a * Math.sin(th[i]), x2 = x3 - b * cb, y2 = y3 - b * Math.sin(th[i + 1]);
    for (let j = i ? 1 : 0; j <= 24; j++) {
      const t = j / 24, u = 1 - t;
      X.push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3);
      Y.push(Math.max(0, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3));
    }
  }
  for (let i = 1; i < X.length; i++) if (X[i] < X[i - 1]) X[i] = X[i - 1];
  return { pts: P, X, Y, at: (xq) => interp(xq, X, Y) };
}

/** The tear drop's starting shape: round at one end (a quarter circle), widest a third of the way, tapering to a point. */
function teardropPoints(W, round) {
  const pts = [[0, 0, 90, null, 0.28 * W], [0.33, W, 0, null, null], [0.72, 0.55 * W, null, null, null], [1, 0, null, null, null]];
  return round === 'tail' ? pts.map(([t, w, a, l, r]) => [1 - t, w, a === null ? null : -a, r, l]).reverse() : pts;
}

/**
 * How deep a tool or a contour stretch is along its length: full depth at its deepest spot xd,
 * easing to nothing toward each end. A blend of 0 holds full depth all the way to that end (an
 * abrupt end); 1 eases from the deepest spot all the way to the end; between, it holds for part
 * of the way and then eases out.
 */
function depthAlong(x, x0, x1, xd, bn, bt) {
  const ease = (q) => { const v = clip(q, 0, 1); return v * v * v * (v * (6 * v - 15) + 10); };   // smootherstep: no jump in curvature where it starts
  // deepest right at an end (a spiral vee deepest at the tail): that end's blend fades it out to flat over
  // its fraction of up to 12" in from the end, instead of having nothing to blend across
  const len = Math.min(x1 - x0, 12);
  let f = 1;
  if (xd - x0 < 0.5 && bt > 0) f *= ease((x - x0) / (bt * len));
  if (x1 - xd < 0.5 && bn > 0) f *= ease((x1 - x) / (bn * len));
  if (x >= xd) { const span = x1 - xd; if (span < 0.5 || bn <= 0) return f; const s = (x - xd) / span, hold = 1 - bn; return f * (s <= hold ? 1 : ease((1 - s) / bn)); }
  const span = xd - x0; if (span < 0.5 || bt <= 0) return f; const s = (xd - x) / span, hold = 1 - bt; return f * (s <= hold ? 1 : ease((1 - s) / bt));
}
const blendOf = (v, def) => (Number.isFinite(+v) ? clip(+v, 0, 1) : def);

function cleanTools(p) {
  const L = p.length, W = p.width, out = [];
  const count = { bottom: 0, deck: 0, chB: 0, chD: 0 };
  for (const t of Array.isArray(p.tools) ? p.tools : []) {
    if (!t || !TOOL_SHAPES[t.shape] || !t.start || !t.end) continue;
    const onDeck = t.surface === 'deck', ch = t.shape === 'channel';
    if (onDeck && (!DECK_SHAPES[t.shape] || t.step === 'out')) continue;          // the old step deck (outside the edges) and step tail are gone
    if (ch ? (onDeck ? count.chD >= 2 : count.chB >= 4) : (onDeck ? count.deck >= 4 : count.bottom >= 8)) continue;   // channels: 4 a side on the bottom, 2 on the deck
    count[ch ? (onDeck ? 'chD' : 'chB') : onDeck ? 'deck' : 'bottom']++;
    const a = clip(posToX({ pos: +t.start.pos, from: fromOf(t.start.from) }, L), -24, L + 24);     // the ends may run off the board
    const b = clip(posToX({ pos: +t.end.pos, from: fromOf(t.end.from) }, L), -24, L + 24);
    const x1 = Math.max(a, b), x0 = Math.min(a, b), len = x1 - x0;
    if (!(len >= 2)) continue;
    const double = t.kind === 'double', depth = Number.isFinite(+t.depth) ? clip(+t.depth, 0, 0.75) : 0.125;
    const ridge = Number.isFinite(+t.ridge) ? clip(+t.ridge, 0, W) : 2;
    const tool = { id: t.id ?? null, shape: t.shape, kind: double ? 'double' : 'single', edge: double && t.edge === 'rail' ? 'rail' : 'hard',
      x0, x1, len, depth, start: { pos: +t.start.pos, from: fromOf(t.start.from) }, end: { pos: +t.end.pos, from: fromOf(t.end.from) } };
    // deepest in the middle by default; one that runs out the tail holds its depth right out (blend toward the tail 0),
    // and either blend can still ease it out flat at that end
    let xdDef = (x0 + x1) / 2, bDef = [0.6, x0 <= 1 ? 0 : 0.6];
    if (t.shape === 'channel') {                          // a channel: one groove each side, its line (out from the stringer) shaped like a tool edge
      tool.kind = 'single';
      tool.gw = Number.isFinite(+t.gw) ? clip(+t.gw, 0.25, 3) : 0.75;
      tool.soft = Number.isFinite(+t.soft) ? clip(+t.soft, 0, 1) : 0;
      const y0 = Number.isFinite(+t.pos) ? clip(+t.pos, 0.5, W) : 3;
      tool.outer = edgeTable(Array.isArray(t.outer) ? t.outer : [[0, 2 * y0, 0, null, null], [1, 2 * y0, 0, null, null]], len, 2 * W)
        || edgeTable([[0, 2 * y0], [1, 2 * y0]], len, 2 * W);
      bDef = [0.3, x0 <= 1 ? 0 : 0.3];
    } else if (t.shape === 'straight') {
      tool.w1 = Number.isFinite(+t.w1) ? clip(+t.w1, 0.5, 2 * W) : 10;   // at the nose end (wider than the board runs it off the rail)
      tool.w2 = Number.isFinite(+t.w2) ? clip(+t.w2, 0.5, 2 * W) : 10;   // at the tail end
      tool.ridge = ridge;
    } else {
      const width = Number.isFinite(+t.width) ? clip(+t.width, 1, W) : 0.6 * W;
      tool.round = t.round === 'tail' ? 'tail' : 'nose';
      const outer = t.shape === 'teardrop' && !Array.isArray(t.outer) ? teardropPoints(width, tool.round) : t.outer;
      tool.outer = edgeTable(outer, len, 2 * W) || edgeTable(t.shape === 'teardrop' ? teardropPoints(width, tool.round) : [[0, 10], [0.5, 8], [1, 12]], len, W);
      tool.inner = double ? edgeTable(Array.isArray(t.inner) ? t.inner : t.shape === 'teardrop' ? null : [[0, ridge], [1, ridge]], len, 2 * W) : null;
      if (t.shape === 'teardrop') {                       // deepest where it is widest; eases out both ways
        let iw = 0; for (let i = 1; i < tool.outer.Y.length; i++) if (tool.outer.Y[i] > tool.outer.Y[iw]) iw = i;
        xdDef = x1 - tool.outer.X[iw]; bDef = [1, 1];
      }
    }
    tool.xd = t.deep && Number.isFinite(+t.deep.pos) ? clip(posToX({ pos: +t.deep.pos, from: fromOf(t.deep.from) }, L), x0, x1) : xdDef;
    tool.deep = t.deep && Number.isFinite(+t.deep.pos) ? { pos: +t.deep.pos, from: fromOf(t.deep.from) } : null;
    tool.blendNose = blendOf(t.blendNose, bDef[0]); tool.blendTail = blendOf(t.blendTail, bDef[1]);
    // the center line: 'blend' (deepest spot + blends), 'flat' (the stringer runs straight from end to
    // end, so the rocker kinks at the ends), or 'custom' (points [t, depth], straight between them, so
    // each point is a kink; add points for a curve)
    tool.L = L;
    tool.center = t.center === 'flat' || t.center === 'custom' ? t.center : 'blend';
    const cp = (Array.isArray(t.cpts) ? t.cpts : []).filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
      .map((q) => [clip(+q[0], 0, 1), clip(+q[1], 0, 0.75)]).sort((a, b) => a[0] - b[0]);
    tool.cpts = cp.length >= 2 ? cp.slice(0, 24) : [[0, 0], [0.33, tool.depth], [1, 0]];
    if (tool.center === 'custom' && cp.length < 2) tool.center = 'blend';
    // deck tools (step deck, step tail, pockets): single, blended center, and which side of the edges steps down
    tool.surface = t.surface === 'deck' ? 'deck' : 'bottom';
    if (tool.surface === 'deck') { tool.kind = 'single'; tool.center = 'blend'; tool.depth = Math.min(tool.depth, 1); }
    out.push(tool);
  }
  return out;
}

/** A tool's edges at spot x: outer and inner half widths (before staying off the rail) and how much of its depth it has there. */
function toolShapeAt(tool, x) {
  const X = tool.x1 - x, u = X / tool.len;                // from the nose end of the tool
  let e, r = 0;
  if (tool.shape === 'straight') { e = (tool.w1 + (tool.w2 - tool.w1) * u) / 2; r = tool.ridge / 2; }
  else { e = tool.outer.at(X); r = tool.inner ? tool.inner.at(X) : 0.18 * e; }
  if (tool.kind === 'single') r = 0;
  return { e, r, D: toolDepth(tool, x), u };
}

/** How deep a tool is at spot x (inches), from its center line. */
function toolDepth(tool, x, zbAt = tool.zbAt) {
  const u = (tool.x1 - x) / tool.len;
  if (tool.center === 'custom') {
    const c = tool.cpts;
    if (u <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) if (u <= c[i][0]) return c[i - 1][1] + ((u - c[i - 1][0]) / Math.max(c[i][0] - c[i - 1][0], 1e-9)) * (c[i][1] - c[i - 1][1]);
    return c[c.length - 1][1];
  }
  if (tool.center === 'flat' && zbAt) {                  // straight from the rocker at one end to the rocker at the other (on the board)
    const a = clip(tool.x0, 0, tool.L), b = clip(tool.x1, 0, tool.L);
    if (b - a < 1) return 0;
    const chord = zbAt(a) + ((zbAt(b) - zbAt(a)) * (x - a)) / (b - a);
    return Math.max(0, chord - zbAt(x));
  }
  let f = depthAlong(x, tool.x0, tool.x1, tool.xd, tool.blendNose, tool.blendTail);
  // a blend of 0 holds full depth to that end, then the center line kinks back to the rocker over
  // the last 3/4" (unless the concave runs right off the board there): a kink, never a step
  if (tool.blendNose <= 0 && tool.x1 < tool.L - 0.5) f *= clip((tool.x1 - x) / 0.75, 0, 1);
  if (tool.blendTail <= 0 && tool.x0 > 0.5) f *= clip((x - tool.x0) / 0.75, 0, 1);
  return tool.depth * f;
}

/** The tools that reach spot x, each as { lift depth here, outer and inner half widths, single / double, edge }. */
function toolsAt(p, x, h, t) {
  const list = [];
  for (const tool of p.tools) {
    if (tool.surface === 'deck' || x < tool.x0 - 1e-9 || x > tool.x1 + 1e-9) continue;
    tool.zbAt = p._zbAt;
    const q = toolShapeAt(tool, x), e = q.e;                 // an edge past the outline runs the concave off the rail (it lifts the rail there)
    const D = softCap(q.D, 0.4 * t);
    if (tool.shape === 'channel') { if (D > 1e-6 && e > 0.1) list.push({ D, e, gw: tool.gw, soft: tool.soft, chan: true }); continue; }
    if (!(D > 1e-6) || !(e > q.r + 0.2)) continue;
    list.push({ D, e, r: q.r, double: tool.kind === 'double', rail: tool.edge === 'rail' });
  }
  return list.length ? list : null;
}

/** The deck tools in at x: how deep each steps down there, its edge (inches out from the stringer) and which side drops. */
function deckToolsAt(p, x) {
  const list = [];
  for (const tool of p.tools) {
    if (tool.surface !== 'deck' || x < tool.x0 - 1e-9 || x > tool.x1 + 1e-9) continue;
    const q = toolShapeAt(tool, x);
    if (q.D > 1e-6 && q.e > 0.05) list.push({ D: q.D, e: q.e, chan: tool.shape === 'channel', gw: tool.gw, soft: tool.soft });
  }
  return list.length ? list : null;
}

/** A tool's center line for the Profile graph: how deep it is (above the rocker) along its length, nose end first. */
export function toolCenterLine(board, k, n = 80) {
  const tool = board.params.tools[k], pr = board._profiles, out = [];
  if (!tool) return null;
  tool.zbAt = (xq) => interp(xq, pr.x, pr.zb);
  for (let i = 0; i <= n; i++) {
    const x = tool.x1 - (tool.len * i) / n;
    if (x < 0 || x > board.params.length) continue;
    out.push({ x, depth: toolDepth(tool, x), zb: tool.zbAt(x) });
  }
  return { tool, pts: out };
}

/** For drawing a tool on the Plan graph: its edges along its length, as the board has them (n + 1 spots, nose end first). */
export function toolOutline(board, k, n = 80) {
  const tool = board.params.tools[k], pr = board._profiles, out = [];
  if (tool) tool.zbAt = (xq) => interp(xq, pr.x, pr.zb);
  if (!tool) return null;
  for (let i = 0; i <= n; i++) {
    const x = tool.x1 - (tool.len * i) / n, q = toolShapeAt(tool, x), h = interp(x, pr.x, pr.h);
    out.push({ x, e: Math.max(0, q.e), r: q.r, D: q.D, h });
  }
  return { tool, pts: out };
}

/** How far the tools lift the bottom at y inches from the stringer. */
const TOOL_ROUND = 0.1;                                  // the edges of a concave tool are rounded over this much (inches), so they read crisp without stepping
const soft = (d) => (d > 8 * TOOL_ROUND ? d : d < -8 * TOOL_ROUND ? TOOL_ROUND * Math.exp(d / TOOL_ROUND) : TOOL_ROUND * Math.log1p(Math.exp(d / TOOL_ROUND)));
/** A channel's groove across at y (0..1 of its depth): flat-bottomed with hard edges rounded over TOOL_ROUND,
 *  centered e out from the stringer, gw wide; the stringer side can blend out toward the stringer (sf 0..1). */
function groove(y, e, gw, sf) {
  const hw = gw / 2, d = y - e, hard = smootherAt((hw - Math.abs(d)) / (2 * TOOL_ROUND) + 0.5);
  const reach = hw + sf * Math.max(e - hw, 0);
  if (d >= 0 || reach - hw < 2 * TOOL_ROUND) return hard;
  const u = -d;                                          // in toward the stringer: eases out over reach instead of a wall
  return u <= hw ? 1 : smootherAt(1 - (u - hw) / (reach - hw));
}

function toolLift(list, y) {
  let z = 0;
  for (const q of list) {
    if (q.chan) { z += q.D * groove(y, q.e, q.gw, q.soft); continue; }
    const so = soft(q.e - y);                             // in from the outer edge
    if (so < 1e-5) continue;
    if (!q.double) { const v = Math.max(q.e - so, 0) / q.e; z += q.D * (1 - v * v); continue; }
    const w = q.e - q.r, sOut = so / w;
    const sIn = q.rail ? Math.max(y - q.r, 0) / w : soft(y - q.r) / w;
    z += q.D * Math.min(q.rail ? 6.75 * sIn * sIn * sOut : 4 * sIn * sOut, 1.05);
  }
  return z;
}

/* ---------------------------------------------------------------------------
   Cross sections: right half, deck centerline -> rail -> bottom centerline
   --------------------------------------------------------------------------- */
const K = 900;
const TH_COS = new Float64Array(K), TH_SIN = new Float64Array(K), TH_DECK = new Uint8Array(K);
for (let k = 0; k < K; k++) {
  const th = k === K - 1 ? -Math.PI / 2 : Math.PI / 2 + k * (-Math.PI / (K - 1));
  TH_COS[k] = Math.abs(Math.cos(th)); TH_SIN[k] = Math.abs(Math.sin(th)); TH_DECK[k] = th >= 0 ? 1 : 0;
}

const KA = K / 2;
const NR = 160, NF = K - KA - NR + 1;                   // bottom: NR samples apex -> edge (the rail), then NF - 1 more edge -> stringer (flat)                                        // deck = samples 0 .. KA-1 (stringer -> rail apex), bottom = KA .. K-1 (apex -> stringer)
const S_RHO = new Float64Array(K), S_NY = new Float64Array(K), S_NZ = new Float64Array(K);
const ZERO_ROW = new Float64Array(GRID);


/**
 * The rail apex arms. On each side of the apex (deck above, bottom below) an arm of length
 * l (in inches: the fraction times the height that side spans) leaves the apex at an angle
 * in from upright. Near the apex the rail is replaced by a cubic Bezier: from the apex A,
 * with its first control point along the arm, A + l (-sin a, +-cos a), to the point J where
 * the plain rail is 2 l up (or down) from the apex, arriving along the rail's own direction
 * there (second control point J - |AJ|/3 T). So it leaves the apex along the arm and joins
 * the rail level and smooth. The control points climb in height, so the curve has one width
 * per height. The apex stays on the outline (the width is untouched), nothing passes the
 * outline or the stringer, and beyond J nothing changes. Upright with no length = no change.
 */
const BZ = 48, BZY = new Float64Array(BZ + 1), BZU = new Float64Array(BZ + 1);
/**
 * The tuck (edge) point's arms. The rail from the apex down to the edge becomes a Bezier: it leaves the
 * apex straight down and arrives at the edge along the rail arm (angle above the bottom: 0 = tangent,
 * a soft edge; up toward 90 = a harder corner; length = how full the tuck is near the edge). The bottom
 * arm then rounds the corner over that many inches in along the bottom and as far up the rail: the
 * edge's radius. sh.ew says how much the arms lead (they ease in and out along the board like any
 * section setting); 0 leaves the usual tuck.
 */
function edgeArms(sh, zApex, tb, yi, hi, hs, yE, Y, Z, contour, tool) {
  const n0 = KA, nE = KA + NR - 1, Wt = hi - yE;
  const toY = (yr) => yi + (yr * (hi - yi)) / hs;
  const base = (yr, u) => zApex - tb + u + contour(yr) * (1 - u / Math.max(tb, 1e-9)) + sMin(tool(yr), 0.95 * Math.max(tb - u, 0));
  const a = (sh.ea * Math.PI) / 180, dAE = Math.hypot(Wt, tb);
  // the rail arm stays inside the rail (below 85% of the apex height, in from the apex), and the apex's own
  // control sits above the arm's tip, so the tuck never hooks back on itself
  let lr = sh.er * dAE;
  if (Math.sin(a) > 1e-6) lr = Math.min(lr, (0.85 * tb) / Math.sin(a));
  if (Math.cos(a) > 1e-6) lr = Math.min(lr, (0.95 * Wt) / Math.cos(a));
  const p2u = lr * Math.sin(a), la = Math.max(0.1 * tb, Math.min(0.45 * tb, 0.7 * (tb - p2u)));
  const P = [[hi, tb], [hi, tb - la], [yE + lr * Math.cos(a), p2u], [yE, 0]];
  const by = new Float64Array(NR), bu = new Float64Array(NR);
  for (let j = 0; j < NR; j++) {                          // the rail: samples by the Bezier's own parameter, apex first
    const t = j / (NR - 1), s1 = 1 - t, b0 = s1 * s1 * s1, b1 = 3 * s1 * s1 * t, b2 = 3 * s1 * t * t, b3 = t * t * t;
    by[j] = Math.min(b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0] + b3 * P[3][0], hi);
    bu[j] = Math.max(b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1] + b3 * P[3][1], 0);
  }
  // the bottom arm: round the corner at the edge over ef in along the bottom and ef back up the rail
  const ef = Math.min(sh.ef, 0.9 * yE, 0.9 * Math.hypot(Wt, tb));
  const nf = NF, fy = new Float64Array(nf + 1), fu = new Float64Array(nf + 1);
  for (let j = 1; j <= nf; j++) { fy[j] = yE * (1 - j / nf); fu[j] = 0; }
  if (ef > 1e-3) {
    let arc = 0, jr = NR - 1;
    while (jr > 0 && arc < ef) { arc += Math.hypot(by[jr] - by[jr - 1], bu[jr] - bu[jr - 1]); jr--; }
    let jf = 1; while (jf < nf && fy[jf] > yE - ef) jf++;
    const F2 = [by[jr], bu[jr]], F1 = [yE - ef, 0];
    // a cubic from the rail (leaving along the rail's own direction there) to the bottom (arriving level): no kink at either end
    let ty = by[Math.min(jr + 1, NR - 1)] - by[jr], tu = bu[Math.min(jr + 1, NR - 1)] - bu[jr];
    const tl = Math.hypot(ty, tu) || 1; ty /= tl; tu /= tl;
    const reach = 0.55 * Math.hypot(F2[0] - yE, F2[1]), Q1 = [F2[0] + ty * reach, F2[1] + tu * reach], Q2 = [F1[0] + 0.55 * ef, 0];
    const cnt = (NR - 1 - jr) + jf;                       // the samples in the rounded zone, rail end first
    for (let q = 0; q <= cnt; q++) {
      const t = q / cnt, s1 = 1 - t, c0 = s1 * s1 * s1, c1 = 3 * s1 * s1 * t, c2 = 3 * s1 * t * t, c3 = t * t * t;
      const yq = c0 * F2[0] + c1 * Q1[0] + c2 * Q2[0] + c3 * F1[0], uq = Math.max(0, c0 * F2[1] + c1 * Q1[1] + c2 * Q2[1] + c3 * F1[1]);
      const k = jr + q;                                   // rail samples jr .. NR-1, then flat samples 1 .. jf
      if (k <= NR - 1) { by[k] = yq; bu[k] = uq; } else { fy[k - (NR - 1)] = yq; fu[k - (NR - 1)] = uq; }
    }
  }
  const w = sh.ew;
  for (let j = 0; j < NR; j++) {
    const k = n0 + j, y1 = toY(by[j]), z1 = base(by[j], bu[j]);
    Y[k] += w * (y1 - Y[k]); Z[k] += w * (z1 - Z[k]);
  }
  for (let j = 1; j <= nf; j++) {
    if (!(fu[j] > 0)) continue;                           // only the rounded zone moves on the flat
    const k = nE + j, y1 = toY(fy[j]), z1 = base(fy[j], fu[j]);
    Y[k] += w * (y1 - Y[k]); Z[k] += w * (z1 - Z[k]);
  }
}

function pinchRail(sh, zApex, td, tb, yi, hi, Y, Z) {
  for (const [deg, frac, span, deck] of [[sh.pd, sh.ld, td, true], [sh.pb, sh.lb, tb, false]]) {
    const l = frac * span;
    if (!(l > 1e-4) || !(span > 1e-4)) continue;
    const step = deck ? -1 : 1, k0 = deck ? KA - 1 : KA, kEnd = deck ? -1 : K;
    let far = 0;                                          // how far the side climbs before its first dip (a channel or step): the arm reshapes no further
    for (let k = k0 + step; k !== kEnd; k += step) { const u = Math.abs(Z[k] - zApex); if (u < far - 1e-4) break; far = Math.max(far, u); }
    let R = Math.min(2 * l, 0.97 * far), j = -1;                  // an arm pulled all the way out reshapes the whole side
    for (let k = k0 + step; k !== kEnd; k += step) if (Math.abs(Z[k] - zApex) >= R) { j = k; break; }
    if (j < 0) continue;                                  // the rail never gets that far (cannot happen while 2 l < span)
    // J between samples j - step and j, and the rail's direction there (away from the apex)
    const i = j - step, ui = Math.abs(Z[i] - zApex), uj = Math.abs(Z[j] - zApex);
    const f = uj > ui ? (R - ui) / (uj - ui) : 1;
    const Jy = Y[i] + f * (Y[j] - Y[i]);
    let ty = Y[j] - Y[i], tu = uj - ui;
    const tl = Math.hypot(ty, tu) || 1; ty /= tl; tu /= tl;
    const a = (clip(deg, 0, PINCH_MAX) * Math.PI) / 180;
    const p1y = hi - l * Math.sin(a), p1u = l * Math.cos(a);
    const c = Math.hypot(hi - Jy, R) / 3;                // second arm: a third of the way from the apex to J, along the rail's direction
    const p2y = Math.min(Jy - c * ty, hi), p2u = clip(R - c * tu, p1u, R);
    for (let n = 0; n <= BZ; n++) {
      const t = n / BZ, s1 = 1 - t, b0 = s1 * s1 * s1, b1 = 3 * s1 * s1 * t, b2 = 3 * s1 * t * t, b3 = t * t * t;
      BZY[n] = b0 * hi + b1 * p1y + b2 * p2y + b3 * Jy;
      BZU[n] = b1 * p1u + b2 * p2u + b3 * R;
    }
    Y[k0] = hi; Z[k0] = zApex;                            // the sample nearest the apex sits on it, so a sharp pinch keeps the full width
    let n = 0;
    for (let k = k0 + step; k !== j; k += step) {                // the samples between the apex and J take the Bezier's width at their height
      const u = Math.abs(Z[k] - zApex);
      while (n < BZ - 1 && BZU[n + 1] < u) n++;
      const du = BZU[n + 1] - BZU[n], w = du > 1e-12 ? clip((u - BZU[n]) / du, 0, 1) : 0;
      Y[k] = clip(BZY[n] + w * (BZY[n + 1] - BZY[n]), yi, hi);
    }
  }
}

/**
 * One cross section, densely sampled, into Y / Z. With offset rows (a slice's anchor
 * points, blended to this position) every point is moved along the normal of the section
 * there by thickness x row(rho), rho = its arc-length position between the stringer (0)
 * and the rail apex (1). aux, if given, also receives the section before the anchor
 * points (Y0, Z0), rho, the normals and the two arc lengths.
 */
function sectionDense(p, xi, hi, yi, ti, zbi, d, rowD, rowB, Y, Z, aux) {
  const sh = sectionShape(p, xi, d, ti);
  const { ar, ed, dome, con, dbl, vee } = sh;
  // a swallow's tips: over the last swallow_round inches each half thins down onto its bottom on a radius,
  // to a thin tip (12% of the thickness at the very end). The bottom and its edge stay where they are.
  const sr = TAIL_TYPES[p.tail_type].notch ? p.swallow_round ?? 0 : 0;
  const tipK = sr > 0 && xi < sr ? 0.12 + 0.88 * Math.sqrt(Math.max(0, 1 - (1 - xi / sr) ** 2)) : 1;
  const zApex = zbi + ar * ti * tipK, td = (1 - ar) * ti * tipK, tb = ar * ti * tipK;
  const hs = Math.max(hi, 1e-9);
  // inside a swallow's cut: a rounded rail bevel down the inside of each half (swallow_rail 0 = a square wall,
  // 1 = the deck comes all the way down to the bottom edge). It runs along the cut's outline at the same width
  // (measured square to the cut), and past the crotch the two bevels carry on along the lines of the cut until they
  // meet on the stringer and close in a point: the inside rails converge cleanly at the stringer. The bottom is not touched.
  const sd = TAIL_TYPES[p.tail_type].notch ? p.swallow_depth ?? 0 : 0, qIn = sd > 0 ? p.swallow_rail ?? 0 : 0;
  let bevel = null;
  if (qIn > 0 && p._yinAt) {
    const Rw = Math.min(0.55 * (hi - Math.max(yi, 0)), 1.25 * ti);
    // the cut's direction: its own slope here inside the cut, the slope it arrives at the crotch with past it
    const xs = Math.min(xi, sd), sl = (p._yinAt(xs) - p._yinAt(xs - 0.5)) / 0.5, cs = 1 / Math.hypot(1, sl);
    const yl = xi <= sd ? yi : sl * (xi - sd);              // the cut's line (past the crotch: carried on across the stringer)
    if (Rw > 1e-3 && (xi <= sd || -yl * cs < Rw)) bevel = (y) => { const u = clip(((y - yl) * cs) / Rw, 0, 1); return qIn * (1 - Math.sqrt(Math.max(0, 1 - (1 - u) ** 2))); };
  }
  const tl = p.tools && p.tools.length ? toolsAt(p, xi, hi, ti * tipK) : null;     // hard-edged concaves at this spot (shallower where a swallow's tips thin out)
  // contours: a single concave is one dish across the bottom (deepest at the stringer, the same curve all
  // the way out, so it reads as one concave); a vee keeps the stringer on the rocker and lifts the rails.
  // Always across the whole board from the stringer: a swallow's halves are cut out of the same bottom
  const contour = (yr) => { const eta = clip((yi + (yr * (hi - yi)) / hs) / hs, 0, 1); return con * (1 - eta * eta) + (dbl * eta ** 1.5 * (1 - eta) ** 2) / K2 + vee * eta; };
  // the deck: from the stringer round to the rail apex (a superellipse, as before), then the deck contours
  const dc = p.deck_contours && p.deck_contours.length ? deckContoursAt(p, xi) : null;
  const dtl = p.tools && p.tools.length ? deckToolsAt(p, xi) : null;
  // flat deck (deck_flat): the deck runs flat across to a corner deck_flat_in in from the rail, then bevels down and
  // rounds into the rail. The corner follows the outline at that distance, out through the tail (and each half of a
  // swallow); near the nose, where the board gets narrow, it closes in with the outline to the tip, or with a beak
  // nose, in to the stringer where the beak starts (the flat fades into the beak's usual deck there). A corner further
  // in makes a longer bevel and a lower, softer rail (foam comes out of the corners); deck_flat mixes this with the
  // usual curve. (a classic fish deck)
  let fl = p.deck_flat ?? 0, fc = 0;
  const rF = 1.25 + 0.5 * (sh.ed - 1.7) / 1.4;
  if (fl > 0) {
    const wq = Math.max(hi - yi, 1e-6), c = p.deck_flat_in ?? 2, k = 0.6;
    const cE = (c ** -4 + (k * wq) ** -4) ** -0.25;       // c inches in from the rail; no more than 60% of the way in where it is narrow
    fc = clip(1 - cE / wq, 0, 0.98);
    if (p.nose_beak) {
      const xb = p.length - p.nose_beak_pos;
      fc *= smoother((xb - xi) / Math.max(8, 2 * p.nose_beak_pos));   // the flat narrows into the beak and meets it at its hard edge
    }
  }
  const kF = 0.025 + 0.04 * (1 - fl);
  const flatDeck = (eta) => { const u = (eta - fc) / (1 - fc), pr = Math.max(1 - u, 0) ** (1 / rF); return -kF * Math.log(Math.exp(-pr / kF) + Math.exp(-1 / kF)); };
  for (let k = 0; k < KA; k++) {
    const yraw = hi * TH_COS[k] ** (2 / ed), eta = clip(yraw / hs, 0, 1);
    Y[k] = yi + (yraw * (hi - yi)) / hs;
    const S0 = TH_SIN[k] ** (2 / ed);
    let H = td * (fl > 0 ? (1 - fl) * S0 + fl * Math.min(flatDeck(eta), 1) : S0) * (1 - 0.7 * dome * eta * eta);
    if (dc || dtl) H = deckShape(dc, dtl, H, td, Math.abs(Y[k]), hi);
    if (bevel) { const zf = zApex - tb + contour(yraw); Z[k] = zApex + H - (zApex + H - zf) * bevel(Y[k]); }
    else Z[k] = zApex + H;
  }
  // the bottom: from the apex down and in around the rail to the edge (the tuck, w in from the apex),
  // then the flat bottom (with its contours and concave tools) in to the stringer. Soft: a quarter
  // ellipse meeting the bottom level; hard: leaves the apex straight down and meets the bottom at a
  // corner. Always the same samples for the same parts, so nothing shifts from section to section.
  // near the tips the board gets narrower than the tuck: ease the tuck down smoothly (no sudden cap, so no lump at the ends)
  // a pointed or semi-pointed nose: the tuck blends down into the point over the last few inches (a 1" tuck is only
  // about 1/8" a quarter inch from the tip), so the rail runs cleanly out into the point instead of a tuck crowding it
  let tk = sh.tuck, cw = 0.85;
  if (NOSE_TYPES[p.nose_type] < 1.9) {
    const Lt = clip(0.08 * p.length, 4, 6), s = smoother(clip((p.length - xi) / Lt, 0, 1));
    tk *= 0.15 + 0.85 * s; cw *= 0.4 + 0.6 * s;         // and it takes less and less of the width, so the edge runs out into the point
  }
  const w = tk > 1e-6 ? (tk ** -4 + (cw * hi) ** -4) ** -0.25 : 0, yE = hi - w, hf = sh.hard;
  const tool = (yr) => (tl ? toolLift(tl, yi + (yr * (hi - yi)) / hs) : 0);
  // a wide soft tuck under a low apex (a nose tuck) would make the quarter ellipse turn up in a tiny radius right
  // at the apex (a pinched rail): there it gets boxier (a superellipse), so it turns up sooner and the rail stays round
  const nT = 2 + clip(0.25 * (w / Math.max(tb, 1e-6) - 1), 0, 0.8);
  for (let j = 0; j < NR; j++) {
    const sp = j / (NR - 1), ph = (sp * Math.PI) / 2;
    const yr = hi - w * ((1 - hf) * (1 - Math.cos(ph) ** (2 / nT)) + hf * sp * sp);
    const dz = tb * ((1 - hf) * Math.sin(ph) ** (2 / nT) + hf * sp);
    Y[KA + j] = yi + (yr * (hi - yi)) / hs;
    Z[KA + j] = zApex - dz + contour(yr) * sp + sMin(tool(yr), 0.95 * dz);   // a concave run off the rail lifts the rail too (never past the apex)
  }
  for (let j = 1; j <= NF; j++) {
    const yr = yE * (1 - j / NF);
    Y[KA + NR - 1 + j] = yi + (yr * (hi - yi)) / hs;
    Z[KA + NR - 1 + j] = zApex - tb + contour(yr) + sMin(tool(yr), 0.95 * tb);
  }
  if (sh.ew > 1e-4 && w > 1e-3) edgeArms(sh, zApex, tb, yi, hi, hs, yE, Y, Z, contour, tool);
  pinchRail(sh, zApex, td, tb, yi, hi, Y, Z);
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

const smootherAt = (t) => { t = clip(t, 0, 1); return t * t * t * (t * (6 * t - 15) + 10); };

/** How the M points of a section are shared: Md round the deck to the apex, Mr round the rail to the edge, the rest across the flat bottom. */
const sampleSplit = (M) => ({ Md: Math.round(0.45 * M), Mr: Math.round(0.15 * M) });

/** Where the bottom channels' walls are at x (inches out from the stringer) and how many extra points each gets:
 *  [y, weight, y, weight, ...]. A channel's walls are counted from 3" before it starts to 3" past its end, easing in
 *  and out over those 3", so the points are already in place before the groove deepens. */
const CH_SIG = 0.04, SQ2PI = Math.sqrt(2 * Math.PI), CG = 800, CC = new Float64Array(CG + 1);
/** The standard normal's cumulative distribution (Abramowitz & Stegun 7.1.26, to about 1e-7). */
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
}
function chanWalls(p, x) {
  const out = [];
  for (const tool of p.tools || []) {
    if (tool.shape !== 'channel' || tool.surface === 'deck') continue;
    const wx = smootherAt((x - tool.x0 + 3) / 3) * smootherAt((tool.x1 + 3 - x) / 3);
    if (!(wx > 0)) continue;
    // a hard wall turns over two rounded corners, TOOL_ROUND either side of it: points gather on each corner
    const e = tool.outer.at(clip(tool.x1 - x, 0, tool.len)), hw = tool.gw / 2, A = wx * 0.45;
    out.push(e + hw - TOOL_ROUND, A, e + hw + TOOL_ROUND, A);
    const reach = hw + tool.soft * Math.max(e - hw, 0);
    if (reach - hw < 2 * TOOL_ROUND) out.push(e - hw - TOOL_ROUND, A, e - hw + TOOL_ROUND, A);
    else out.push(e - hw, 0.4 * A);                   // the floor easing out toward the stringer: a softer turn
  }
  return out;
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
    // resample to M points, the same way in every section so nothing ripples along the board: the
    // deck by arc length plus turning (the rail's roll gets its share), then the rail from the apex
    // to the edge and the flat bottom evenly, with the apex and the edge always on the same points
    const base = i * M, { Md, Mr } = sampleSplit(M), Mf = M - Md - Mr;
    cum[0] = 0;
    let prevA = Math.atan2(Z[1] - Z[0], Y[1] - Y[0]);
    for (let j = 0; j < KA; j++) {                         // deck samples 0 .. KA-1, then the apex (KA)
      const dY = Y[j + 1] - Y[j], dZ = Z[j + 1] - Z[j], a = Math.atan2(dZ, dY);
      let da = a - prevA; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      cum[j + 1] = cum[j] + Math.hypot(dY, dZ) + 0.35 * ti * (j ? Math.abs(da) : 0);
      prevA = a;
    }
    const total = cum[KA];
    let j = 0;
    for (let m = 0; m < Md; m++) {
      const tgt = total > 1e-12 ? (total * m) / Md : 0;
      while (j < KA - 1 && cum[j + 1] <= tgt) j++;
      const span = cum[j + 1] - cum[j], f = span > 0 ? clip((tgt - cum[j]) / span, 0, 1) : 0;
      Yo[base + m] = Y[j] + f * (Y[j + 1] - Y[j]); Zo[base + m] = Z[j] + f * (Z[j + 1] - Z[j]);
    }
    const take = (m, kf) => { const k0 = Math.min(Math.floor(kf), K - 2), f = kf - k0; Yo[base + m] = Y[k0] + f * (Y[k0 + 1] - Y[k0]); Zo[base + m] = Z[k0] + f * (Z[k0 + 1] - Z[k0]); };
    take(Md, KA);                                          // the apex
    const walls = p._chanB ? chanWalls(p, x[i]) : null;
    if (walls) {
      // bottom channels: round the rail by arc length, denser where a channel's walls cross it (one running off the rail), so they don't alias
      cum[0] = 0;
      for (let q = 0; q < NR - 1; q++) {
        const k = KA + q, ym = 0.5 * (Y[k] + Y[k + 1]);
        let rho = 1;
        for (let w = 0; w < walls.length; w += 2) { const u = (ym - walls[w]) / CH_SIG; if (u * u < 25) rho += (0.5 * walls[w + 1] * Math.exp(-0.5 * u * u)) / (CH_SIG * SQ2PI); }
        cum[q + 1] = cum[q] + rho * Math.hypot(Y[k + 1] - Y[k], Z[k + 1] - Z[k]) + 1e-9;
      }
      const tot = cum[NR - 1];
      let q = 0;
      for (let m = 1; m < Mr; m++) {
        const tgt = (tot * m) / Mr;
        while (q < NR - 2 && cum[q + 1] <= tgt) q++;
        const span = cum[q + 1] - cum[q], f = span > 0 ? clip((tgt - cum[q]) / span, 0, 1) : 0;
        take(Md + m, KA + q + f);
      }
    } else for (let m = 1; m < Mr; m++) take(Md + m, KA + ((NR - 1) * m) / Mr);       // round the rail ...
    take(Md + Mr, KA + NR - 1);                            // ... to the edge
    if (p._chanB) {                                        // bottom channels: more points on the groove walls
      // the flat by a density that is higher on each channel wall's corners, wherever the channel's line runs (not how
      // deep it is here), measured out from the stringer the same way in every section (a swallow's cut just takes the
      // points it cuts away, gathered against the cut), so each point keeps riding the same corner from section to
      // section: no wrinkles or saw teeth where a groove fades in or out, crosses a swallow's cut or runs off the rail
      const k0 = KA + NR - 1, yE = Y[k0], yI = Y[K - 1];
      for (let g = 0; g <= CG; g++) {
        const y = (yE * g) / CG;
        let c = y;
        for (let w = 0; w < walls.length; w += 2) { const z = (y - walls[w]) / CH_SIG; c += walls[w + 1] * (z > 6 ? 1 : z < -6 ? 0 : normCdf(z)); }
        CC[g] = c;
      }
      const T = CC[CG] - CC[0];
      let g = CG, q = 0;
      for (let m = 1; m < Mf; m++) {
        const c = CC[CG] - (T * m) / (Mf - 1);
        while (g > 1 && CC[g - 1] > c) g--;
        const yA = (yE * (g - 1 + clip((c - CC[g - 1]) / Math.max(CC[g] - CC[g - 1], 1e-12), 0, 1))) / CG;
        const u = (yA - yI) / 0.04, y = Math.min(yI + (u > 30 ? yA - yI : 0.04 * Math.log1p(Math.exp(u))), yE);
        while (q < NF - 2 && Y[k0 + q + 1] >= y) q++;
        const span = Y[k0 + q] - Y[k0 + q + 1];
        take(Md + Mr + m, k0 + q + (span > 1e-12 ? clip((Y[k0 + q] - y) / span, 0, 1) : 0));
      }
    } else for (let m = 1; m < Mf; m++) take(Md + Mr + m, KA + NR - 1 + ((NF - 1) * m) / (Mf - 1));   // then the flat bottom in to the stringer
    if (Mf > 1) { Yo[base + M - 1] = Y[K - 1]; Zo[base + M - 1] = Z[K - 1]; }
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
  if (tail.point) for (const f of [0.25, 0.5, 0.75, 0.97, 1, 1.03]) xs.push(p.diamond_depth * f);   // the diamond's corners stay crisp
  if (p.nose_beak) { const xb = L - p.nose_beak_pos; for (const d of [-0.3, -0.12, -0.04, 0, 0.04, 0.12, 0.3]) xs.push(xb + d); }   // the beak's edge stays crisp
  if (NOSE_TYPES[p.nose_type] < 1.9) for (const d of [0.02, 0.05, 0.1, 0.16, 0.24, 0.34, 0.46, 0.62, 0.8, 1.05, 1.35]) xs.push(L - d);   // a pointed nose finishes cleanly into its point
  for (const s of p.slices) xs.push(s.x);
  for (const r of p.marks) xs.push(r.x);
  for (const v of deckStationXs(p)) xs.push(v);
  xs.sort((a, b) => a - b);
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1e-3) out.push(xs[i]);  // np.unique + gap filter
  return Float64Array.from(out);
}

function buildMesh(p, tScale) {
  const chan = (p.tools || []).some((t) => t.shape === 'channel');
  const x = stationXs(p), n = x.length, M = chan ? Math.max(p.section_points, 200) : p.section_points;   // channels: narrow hard walls need more points across
  // base curves, then the anchor-point corrections
  const h0 = halfWidth(p, x), zb0 = rocker(p, x), foil0 = foil(p, x);
  const arms = { outline: [], rocker: [], thickness: [], swallow: [] };
  const dh = curveDelta(p, 'outline', x, arms.outline, (q) => halfWidth(p, q)), dz = curveDelta(p, 'rocker', x, arms.rocker, (q) => rocker(p, q)), dt = curveDelta(p, 'thickness', x, arms.thickness, (q) => foil(p, q));
  const h = Float64Array.from(h0, (v, i) => Math.max(v + dh[i], 0.15 * v));
  const zb = Float64Array.from(zb0, (v, i) => v + dz[i]);
  const t = Float64Array.from(foil0, (v, i) => {
    const ti = Math.max(v + dt[i], 0.15 * v) * tScale;
    let tq = ti * Math.tanh((3 * h[i]) / Math.max(ti, 1e-9));   // pinch only right where the outline closes (the tip stays a small rounded nub, like Shape3D's)
    // a beak nose: from nose_beak_pos in from the nose the deck breaks down toward the tip over a hard edge (a crease
    // across the deck where the beak starts, steepest right there), then eases into the tip. The bottom stays.
    if (p.nose_beak && x[i] > p.length - p.nose_beak_pos) { const sB = (x[i] - (p.length - p.nose_beak_pos)) / p.nose_beak_pos; tq *= 1 - 0.7 * (1 - (1 - sB) ** 1.8); }
    return tq;
  });
  const notch = notchHalfWidth(p, x, arms.swallow);
  const keep = TAIL_TYPES[p.tail_type].notch ? 0.95 + 0.046 * (1 - (p.swallow_tip ?? 1)) : 0.95;   // pointed swallow tips: the cut runs right out
  const yin = Float64Array.from(notch, (v, i) => Math.min(v, h[i] * keep));
  const sl = sliceTables(p);
  // a vee stretch deeper than the rail can take somewhere along it (60% of the rail apex height there, with any slice's
  // apex) is scaled down as a whole, so it keeps its shape along the board (deepest where it says, easing out as its
  // blends say) instead of following that limit, which rises and falls with the thickness and the apex and would put
  // humps and dips in the rail line. The last inch and a half at either end of the board is left to the limit itself.
  const vS = (p.bottom.stretches || []).filter((S) => S.v > 0);
  if (vS.length) {
    const dq = {}, rD = new Float64Array(GRID), rB = new Float64Array(GRID);
    for (const S of vS) S.vs = 1;
    for (let i = 0; i < n; i++) {
      if (x[i] < 1.5 || x[i] > p.length - 1.5) continue;
      if (sl) sliceBlend(sl, x[i], dq, rD, rB);
      const ti = t[i], ga = sl ? dq.rail_apex_in ?? 0 : 0, gr = sl ? dq.rail_apex ?? 0 : 0;
      const cap = 0.6 * ti * (p.rail_apex_in !== null ? apexRatio(p.rail_apex_in + ga, ti) : clip(p.rail_apex + gr, 0.15, 0.6));
      for (const S of vS) { const f = S.f(x[i]); if (f > 0.02) S.vs = Math.min(S.vs, cap / (S.v * f)); }
    }
  }
  p._zbAt = (xq) => interp(clip(xq, x[0], x[n - 1]), x, zb);
  p._yinAt = (xq) => interp(clip(xq, x[0], x[n - 1]), x, yin);   // the swallow's cut, for its inside rail     // the rocker, for concave tools with a flat center line
  p._chanB = (p.tools || []).some((t) => t.shape === 'channel' && t.surface !== 'deck');   // bottom channels: resample the flat by turning too
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

  // each triangle also gets the patch of surface it belongs to (deck, rail below the apex, flat
  // bottom, notch walls, end caps), so the viewer can crease exactly where patches meet and
  // nowhere else: a hard edge stays crisp all the way along, a soft one shows no line at all
  const F = [], PF = [];
  const { Md, Mr } = sampleSplit(M);
  const patchOf = (m) => (m < Md ? 0 : m < Md + Mr ? 1 : 2);
  let curPatch = 0;
  const tri = (a, b, d, flip) => { (flip ? F.push(d, b, a) : F.push(a, b, d)); PF.push(curPatch); };
  for (const [I, flip] of [[IR, false], [IL, true]]) {
    for (let i = 0; i < n - 1; i++) for (let m = 0; m < M - 1; m++) {
      curPatch = patchOf(m);
      tri(I[i * M + m], I[(i + 1) * M + m], I[(i + 1) * M + m + 1], flip);
      tri(I[i * M + m], I[(i + 1) * M + m + 1], I[i * M + m + 1], flip);
    }
  }
  curPatch = 3;
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
  curPatch = 4;
  if (h[0] >= 1e-6) cap(0, false);
  if (h[n - 1] >= 1e-6) cap(n - 1, true);

  const idx = [], pat = [];
  for (let f = 0; f < F.length; f += 3) {
    const a = F[f], b = F[f + 1], d = F[f + 2];
    if (a !== b && b !== d && a !== d) { idx.push(a, b, d); pat.push(PF[f / 3]); }
  }
  const faces = Uint32Array.from(idx), patches = Uint8Array.from(pat);
  let vol = meshVolume(V, faces);
  if (vol < 0) {
    for (let f = 0; f < faces.length; f += 3) { const tmp = faces[f]; faces[f] = faces[f + 2]; faces[f + 2] = tmp; }
    vol = -vol;
  }
  return { V, F: faces, patches, vol, prof: { x, h, yin, zb, t, Y, Z, M, h0, zb0, foil0, sl, arms } };
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
    vertices: mesh.V, faces: mesh.F, patches: mesh.patches, volume_l: mesh.vol * IN3_TO_L, _profiles: mesh.prof,
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
    ...p.marks.map((r) => row(whereIs(r), r.x, true)),      // added measurements, after the five standard ones
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
  const eff = {};
  for (const k of Object.keys(ADJ)) eff[k] = pr.sl && pr.sl.adj[k] ? pr.sl.adj[k](s.x, new Float64Array(1))[0] : 0;
  return { ...sectionAt(board, s.x), id: s.id, adj: eff, set: s.set, edited: s.edited, base: sectionBase(p, s.x), arms: { deck: arms('deck'), bottom: arms('bottom') } };
}

export function specSheet(board) {
  const s = board.stats, p = board.params, L_ = p.length;
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
      ? ['bottom       contours, nose to tail:', ...[...p.bottom.filter((r) => r.inner === undefined).map((r) => ({ ...r, x0: r.x })), ...(p.bottom.stretches || [])]
        .sort((a, b) => b.x0 - a.x0).map((r) => {
          const what = `${BOTTOM_LABELS[r.type]}${r.type === 'flat' ? '' : ` ${fmtIn(r.depth)}`}${r.type.endsWith('_double') ? ` / ${fmtIn(r.depth2)}` : ''}`;
          if (!r.to) return `             ${whereIs(r)}: ${what}`;
          const blend = r.bn > 0 || r.bt > 0 ? `, deepest ${r.deep ? whereIs(r.deep) : 'in the middle'}, blends ${r.bn.toFixed(2)} toward the nose / ${r.bt.toFixed(2)} toward the tail` : '';
          return `             ${whereIs(r)} until ${whereIs(r.to)}: ${what}${blend}`;
        })]
      : [`bottom       concave ${fmtIn(p.concave_depth)}, tail vee ${fmtIn(p.vee_depth)}`]),
    ...p.tools.filter((t) => t.surface === 'deck').map((t) => `deck         ${DECK_SHAPES[t.shape].toLowerCase()} ${fmtIn(t.depth)} deep${t.shape === 'channel' ? `, ${fmtIn(t.gw)} wide` : ''}, from ${whereIs(t.start)} until ${whereIs(t.end)}, blends ${t.blendNose.toFixed(2)} / ${t.blendTail.toFixed(2)}`),
    ...(p.deck_contours || []).map((c) => `deck         ${DECK_TYPES[c.type].toLowerCase()} ${fmtIn(c.depth)}${c.type === 'channels' ? `, ${c.count} a side from ${fmtIn(c.pos)} out` : c.width ? `, ${fmtIn(c.width)} across` : ''}, ${fmtFtin(L_ - c.x1)} to ${fmtFtin(L_ - c.x0)} from the nose`),
    ...p.tools.filter((t) => t.surface !== 'deck').map((t) => `concave tool ${TOOL_SHAPES[t.shape].toLowerCase()}, ${t.kind}${t.kind === 'double' ? (t.edge === 'rail' ? ', hard on the rail side' : ', hard edges') : ', hard edge'}, ${fmtIn(t.depth)} deep, from ${whereIs(t.start)} until ${whereIs(t.end)}${
      t.shape === 'teardrop' ? `, ${fmtIn(2 * Math.max(...t.outer.Y))} at its widest, round end toward the ${t.round}` : t.shape === 'straight' ? `, ${fmtIn(t.w1)} wide at the nose end to ${fmtIn(t.w2)} at the tail end` : ', curved edges'}, deepest ${fmtFtin(L_ - t.xd)} from the nose, blends ${t.blendNose.toFixed(2)} / ${t.blendTail.toFixed(2)}`),
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
