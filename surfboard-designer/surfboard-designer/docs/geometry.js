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

/** Loose input -> full parameter set. Accepts '19 3/4' strings and designs saved by v1. */
export function paramsFromDict(d = {}) {
  d = { ...d };
  for (const [k, v] of Object.entries(d)) {
    if (k in DEFAULTS && typeof DEFAULTS[k] === 'number' && typeof v === 'string') d[k] = parseInches(v);
  }
  const base = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in d) base[k] = d[k];
  const L = base.length;
  const xl = L / 2 + base.rocker_low_point, xt = L / 2 + base.thickness_point_offset;
  for (const [side, nose] of [['nose', true], ['tail', false]]) {
    if (`${side}_kick` in d && !(`${side}_rocker_12` in d))
      base[`${side}_rocker_12`] = base[`${side}_rocker`] * u12(L, xl, nose) ** Number(d[`${side}_kick`]);
    if ('foil_fullness' in d && !(`${side}_thickness_12` in d)) {
      const te = base[`${side}_thickness`];
      base[`${side}_thickness_12`] = te + (base.thickness - te) * (1 - u12(L, xt, nose) ** Number(d.foil_fullness));
    }
  }
  return base;
}

/** Clamp into a buildable range; returns [params, warnings]. Same order and messages as Python. */
export function validated(src) {
  const p = { ...src };
  const w = [];
  const clamp = (name, lo, hi, label) => {
    const v = p[name], nv = Math.min(Math.max(v, lo), hi);
    if (Math.abs(nv - v) > 1e-9) {
      w.push(label ? `${label} limited to ${fmtIn(nv)}` : `${name} clamped to ${nv.toFixed(2)}`);
      p[name] = nv;
    }
  };
  if (!(p.nose_type in NOSE_TYPES)) { w.push(`unknown nose_type '${p.nose_type}', using pointed`); p.nose_type = 'pointed'; }
  if (!(p.tail_type in TAIL_TYPES)) { w.push(`unknown tail_type '${p.tail_type}', using squash`); p.tail_type = 'squash'; }

  clamp('length', 40, 144);
  clamp('width', 14, 26);
  clamp('thickness', 1.5, 4.5);
  const half = p.length / 2;
  clamp('wide_point_offset', -(half - 14), half - 14);
  clamp('rocker_low_point', -(half - 14), half - 14);
  clamp('thickness_point_offset', -(half - 14), half - 14);

  clamp('nose_width_12', 3, p.width - 0.5);
  const tail = TAIL_TYPES[p.tail_type];
  if (tail.closes) clamp('tail_width_12', 4, p.width - 0.5);
  else { clamp('tail_block_width', 4, p.width - 2); clamp('tail_width_12', p.tail_block_width + 0.5, p.width - 0.5); }
  if (tail.notch) { clamp('swallow_width', 1, p.tail_block_width - 2 * tail.corner - 1); clamp('swallow_depth', 1, 10); }

  const xw = half + p.wide_point_offset;
  const rn = (1 - u12(p.length, xw, true) ** A_MIN) ** (1 / NOSE_TYPES[p.nose_type]);
  clamp('nose_width_12', p.width * rn, p.width - 0.5, 'width 12" from nose');
  const te0 = tail.closes ? 0 : p.tail_block_width / p.width;
  const rt = (1 - u12(p.length, xw, false) ** A_MIN) ** (1 / tail.b);
  clamp('tail_width_12', p.width * (te0 + (1 - te0) * rt), p.width - 0.5, 'width 12" from tail');

  clamp('nose_rocker', 0, 12);
  clamp('tail_rocker', 0, 8);
  clamp('nose_thickness', 0.3, p.thickness);
  clamp('tail_thickness', 0.3, p.thickness);

  const xl = half + p.rocker_low_point, xt = half + p.thickness_point_offset;
  for (const [side, nose] of [['nose', true], ['tail', false]]) {
    const R = p[`${side}_rocker`]; let u = u12(p.length, xl, nose);
    clamp(`${side}_rocker_12`, R * u ** K_MAX, R * u ** K_MIN, `rocker 12" from ${side}`);
    const te = p[`${side}_thickness`]; u = u12(p.length, xt, nose);
    const span = p.thickness - te;
    clamp(`${side}_thickness_12`, te + span * (1 - u ** P_MIN), te + span * (1 - u ** P_MAX), `thickness 12" from ${side}`);
  }
  clamp('rail_apex', 0.15, 0.6);
  for (const n of ['rail_fullness', 'deck_dome', 'rail_hardness_nose', 'rail_hardness_tail']) clamp(n, 0, 1);
  clamp('concave_depth', 0, 0.4);
  clamp('vee_depth', 0, 0.4);
  clamp('target_volume', 10, 120);
  p.stations = Math.trunc(clip(p.stations, 41, 401));
  p.section_points = Math.trunc(clip(p.section_points, 16, 128));
  return [p, w];
}

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

function thickness(p, x, h, scale) {
  const L = p.length, xt = L / 2 + p.thickness_point_offset;
  const [en, et] = foilExponents(p);
  return Float64Array.from(x, (xi, i) => {
    const nose = xi >= xt;
    const u = nose ? (xi - xt) / (L - xt) : (xt - xi) / xt;
    const tEnd = nose ? p.nose_thickness : p.tail_thickness;
    let t = (tEnd + (p.thickness - tEnd) * (1 - clip(u, 0, 1) ** (nose ? en : et))) * scale;
    return t * Math.tanh((1.5 * h[i]) / Math.max(t, 1e-9));
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

function sections(p, x, h, yin, t, zb, M) {
  const n = x.length;
  const Yo = new Float64Array(n * M), Zo = new Float64Array(n * M);
  const Y = new Float64Array(K), Z = new Float64Array(K), cum = new Float64Array(K);
  const ed = 1.7 + 1.4 * p.rail_fullness, ar = p.rail_apex;
  for (let i = 0; i < n; i++) {
    const hi = h[i], ti = t[i], eb = 2 + 6 * railHardness(p, x[i]);
    const zApex = zb[i] + ar * ti, td = (1 - ar) * ti, tb = ar * ti;
    const con = concaveAt(p, x[i]), vee = veeAt(p, x[i]);
    const hs = Math.max(hi, 1e-9), yi = yin[i];
    for (let k = 0; k < K; k++) {
      const deck = TH_DECK[k], e = deck ? ed : eb;
      const yraw = hi * TH_COS[k] ** (2 / e);
      const eta = clip(yraw / hs, 0, 1);
      Z[k] = deck
        ? zApex + td * TH_SIN[k] ** (2 / ed) * (1 - 0.7 * p.deck_dome * eta * eta)
        : zApex - tb * TH_SIN[k] ** (2 / e) + con * (1 - eta * eta) ** 2 - vee * (1 - eta);
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
  xs.sort((a, b) => a - b);
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1e-3) out.push(xs[i]);  // np.unique + gap filter
  return Float64Array.from(out);
}

function buildMesh(p, tScale) {
  const x = stationXs(p), n = x.length, M = p.section_points;
  const h = halfWidth(p, x);
  const notch = notchHalfWidth(p, x);
  const yin = Float64Array.from(notch, (v, i) => Math.min(v, h[i] * 0.95));
  const zb = rocker(p, x);
  const t = thickness(p, x, h, tScale);
  const [Y, Z] = sections(p, x, h, yin, t, zb, M);

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
  return { V, F: faces, vol, prof: { x, h, yin, zb, t, Y, Z, M } };
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
    params: p, warnings, thickness_scale: scale,
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
