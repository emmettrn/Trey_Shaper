/**
 * Outline from a photo: find the edge of the board in a photo that has been straightened onto
 * the stringer, turn it into a handful of points, and fit a design to them (measurements,
 * nose and tail type, then outline anchor points for the rest).
 *
 * Only one side is traced; the board is symmetric, so the other side is its mirror.
 * No DOM here, so it can be tested in Node: images are { data, width, height } (RGBA bytes).
 */

/** The straightened photo: board inches -> pixels. x from the tail (-pad .. L + pad), y across (-ymax .. ymax). */
export const traceFrame = (L, ppi, ymax = 15, pad = 2) => ({
  L, ppi, ymax, pad,
  width: Math.round((L + 2 * pad) * ppi) + 1,
  height: Math.round(2 * ymax * ppi) + 1,
  u: (x) => (x + pad) * ppi,
  v: (y) => (ymax - y) * ppi,
});

const median = (arr) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };

/**
 * Half widths of the board along its length, on one side of the stringer (side = +1 or -1).
 * The board's colour is taken a few inches off the stringer through the middle of the board,
 * the background's from the far edge of the frame. Each column is scanned from the outside in,
 * and the edge is the first spot that stays board-coloured for half an inch, so graphics on
 * the board and a dark stringer line cannot stop it early.
 * Returns { xs, hw, contrast } with xs every 1/ppi inch from 0 to L.
 */
export function traceHalf(img, f, side = 1) {
  const { data, width } = img, { L, ppi, ymax } = f;
  const at = (u, v) => {
    u = Math.round(u); v = Math.round(v);
    if (u < 0 || v < 0 || u >= width || v >= img.height) return null;
    const i = 4 * (v * width + u);
    return data[i + 3] < 128 ? null : [data[i], data[i + 1], data[i + 2]];
  };
  const dist = (c, b) => Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);

  // the board's own colour, through the middle of the board, a little off the stringer
  const R = [], G = [], B = [];
  for (let x = 0.3 * L; x <= 0.7 * L; x += 0.5) for (const y of [1.5, 2.5, 3.5]) {
    const c = at(f.u(x), f.v(side * y)); if (c) { R.push(c[0]); G.push(c[1]); B.push(c[2]); }
  }
  const board = [median(R), median(G), median(B)];
  // the background: the outer strip of the frame on this side
  const bg = [];
  for (let x = -f.pad; x <= L + f.pad; x += 0.5) for (let y = ymax - 1.5; y <= ymax - 0.2; y += 0.5) {
    const c = at(f.u(x), f.v(side * y)); if (c) bg.push(dist(c, board));
  }
  const contrast = bg.length ? median(bg) : 255;
  const thr = Math.max(16, 0.45 * contrast);
  const run = Math.max(3, Math.round(0.5 * ppi));

  const n = Math.floor(L * ppi) + 1, xs = new Float64Array(n), hw = new Float64Array(n);
  const rMin = Math.round(0.4 * ppi), rMax = Math.round((ymax - 0.25) * ppi);
  for (let i = 0; i < n; i++) {
    const x = i / ppi, u = f.u(x);
    xs[i] = x;
    let inside = 0, edge = 0;
    for (let r = rMax; r >= rMin; r--) {                 // from the outside in
      const c = at(u, f.v(0) - side * r);
      if (c && dist(c, board) <= thr) { if (++inside >= run) { edge = r + run - 1; break; } }
      else inside = 0;
    }
    hw[i] = edge > rMin + run ? (edge + 1) / ppi : 0;      // to the outer side of the last board pixel
  }
  // knock out single-column spikes (a leash, a shadow, a speck), then smooth lightly
  const k = Math.max(1, Math.round(0.15 * ppi)), med = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) w.push(hw[j]);
    med[i] = median(w);
  }
  // a swallow's cut: from the stringer outward, where the board starts. Through the cut the
  // middle of the board is floor; the cut ends (its depth) where the middle is board again.
  const cut = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (med[i] <= 0) continue;
    const u = f.u(xs[i]);
    let inside = 0, start = -1;
    for (let r = rMin; r <= Math.round(med[i] * ppi); r++) {
      const c = at(u, f.v(0) - side * r);
      if (c && dist(c, board) <= thr) { if (++inside >= run) { start = r - run + 1; break; } }
      else inside = 0;
    }
    cut[i] = start > rMin + 1 ? start / ppi : 0;
  }
  let seen = 0;
  for (let i = 0; i < n; i++) { if (cut[i] > 0.4) seen = xs[i]; else if (xs[i] > 0.5) break; }
  let notch = null;
  const near = Array.from(cut).filter((c, i) => xs[i] <= seen / 3);
  if (seen >= 0.75 && near.length && median(near) >= 0.6) {
    // the cut is a V: fit a straight line to the part that could be seen and run it out to its point
    let sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
    for (let i = 0; i < n; i++) if (xs[i] <= seen && cut[i] > 0.4) { sx += xs[i]; sy += cut[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * cut[i]; c++; }
    const slope = (c * sxy - sx * sy) / (c * sxx - sx * sx || 1), icpt = (sy - slope * sx) / c;
    const depth = slope < -1e-3 ? -icpt / slope : seen;
    notch = { depth: Math.min(Math.max(depth, seen), 3 * seen + 2), half: Math.max(icpt, 0.5), cut: Array.from(cut) };
  }
  return { xs: Array.from(xs), hw: Array.from(med), contrast, board, notch };
}

/** Shape-preserving cubic through points [[x, y], ...] (sorted by x): never overshoots them. */
export function pchip(pts) {
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  if (n < 2) return () => (n ? ys[0] : 0);
  const h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])); }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  const end = (h0, h1, d0, d1) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(s) !== Math.sign(d0)) s = 0; else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0;
    return s;
  };
  if (n > 2) { m[0] = end(h[0], h[1], d[0], d[1]); m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]); }
  else m[0] = m[1] = d[0];
  const fn = (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
  fn.slopes = m;
  return fn;
}

/**
 * The traced line with control arms at its two ends. `arms` = { tail, nose }, each null (automatic)
 * or [angle, length]: the direction the line leaves that end (degrees from the stringer, toward the
 * other end) and how far it holds it. Between, a shape-preserving cubic through the points; the
 * first and last stretch become cubic Beziers whose inner control point follows the next point.
 */
export function traceCurve(pts, arms = {}) {
  const base = pchip(pts), n = pts.length;
  if (n < 3 || (!arms.tail && !arms.nose)) return base;
  const seg = (A, B, mB, arm, dir) => {                  // Bezier from end A to its neighbour B
    if (!arm) return null;
    const g = Math.abs(B[0] - A[0]), a = (arm[0] * Math.PI) / 180, len = Math.min(arm[1], 0.95 * g);
    const P1 = [A[0] + dir * len * Math.cos(a), A[1] + len * Math.sin(a)];
    const P2 = [B[0] - dir * g / 3, B[1] - dir * mB * g / 3];
    return (x) => {
      let lo = 0, hi = 1;
      for (let k = 0; k < 40; k++) {
        const t = (lo + hi) / 2, s1 = 1 - t, bx = s1 * s1 * s1 * A[0] + 3 * s1 * s1 * t * P1[0] + 3 * s1 * t * t * P2[0] + t * t * t * B[0];
        if ((bx - x) * dir < 0) lo = t; else hi = t;
      }
      const t = (lo + hi) / 2, s1 = 1 - t;
      return Math.max(0, s1 * s1 * s1 * A[1] + 3 * s1 * s1 * t * P1[1] + 3 * s1 * t * t * P2[1] + t * t * t * B[1]);
    };
  };
  const m = base.slopes;
  const tailSeg = seg(pts[0], pts[1], m[1], arms.tail, 1), noseSeg = seg(pts[n - 1], pts[n - 2], m[n - 2], arms.nose, -1);
  const fn = (x) => {
    if (tailSeg && x <= pts[1][0]) return tailSeg(Math.max(x, pts[0][0]));
    if (noseSeg && x >= pts[n - 2][0]) return noseSeg(Math.min(x, pts[n - 1][0]));
    return base(x);
  };
  fn.slopes = m;
  return fn;
}

/**
 * A few points along the traced half outline: closer together toward the nose and tail, where
 * the curve turns fastest, plus two right at the tail end.
 */
export function tracePoints(tr, L, n = 22) {
  const step = tr.xs.length > 1 ? tr.xs[1] - tr.xs[0] : 1;
  const near = (x) => { let s = 0, c = 0; for (let i = 0; i < tr.xs.length; i++) if (Math.abs(tr.xs[i] - x) <= step * 1.01) { s += tr.hw[i]; c++; } return c ? s / c : 0; };
  const xs = [0.25, 0.75];                                // the tail corners turn fast: two extra points there
  for (let i = 0; i < n; i++) xs.push((L * (1 - Math.cos((Math.PI * i) / (n - 1)))) / 2);
  // the nose tip comes to a point; right at a tip the board is too narrow to scan, so a point
  // there that found nothing is left out and the nose (or tail) type takes care of the last bit
  const pts = [...new Set(xs.map((x) => +x.toFixed(3)))].sort((a, b) => a - b)
    .map((x) => [x, x >= L ? 0 : Math.max(0, near(x))])
    .filter(([x, w], i, a) => x <= 0 || x >= L || w > 0.05);
  // a swallow's tips can be too thin to see from outside: run the outline out to the tail end
  if (tr.notch && pts.length > 3) {
    const a = pts.find((p) => p[0] >= 1), b = pts.find((p) => p[0] >= 2.5);
    if (a && b && b[0] > a[0]) pts[0][1] = Math.max(pts[0][1], a[1] - ((b[1] - a[1]) / (b[0] - a[0])) * a[0]);
    for (const p of pts) if (p[0] > 0 && p[0] < 1 && p[1] < pts[0][1]) p[1] = pts[0][1] + (p[0] / 1) * ((a ? a[1] : p[1]) - pts[0][1]);
  }
  return pts;
}

const r16 = (v) => Math.round(v * 16) / 16;

/**
 * A design that follows the traced half outline `pts`: the measurements read off it (width,
 * wide point, widths 12" from each end, tail block), the nose and tail types whose curves come
 * closest, then outline anchor points so it follows the trace between the measurements.
 * `build` is buildBoard; `types` = { NOSE_TYPES, TAIL_TYPES }; `notch` = { depth, half } when the
 * photo shows a swallow cut. Returns { params, nose, tail, error }.
 */
export function fitOutline(pts, L, current, build, types, notch = null, curve = null) {
  const f = curve || pchip(pts);
  let W = 0, xw = L / 2;
  for (let x = 0; x <= L; x += 0.125) { const w = 2 * f(x); if (w > W) { W = w; xw = x; } }
  const half = L / 2, wpo = Math.min(Math.max(xw - half, -(half - 14)), half - 14);
  const tb = 2 * f(0);
  const base = structuredClone(current);
  Object.assign(base, {
    length: L, width: r16(W), wide_point_offset: Math.round(wpo * 4) / 4,
    nose_width_12: r16(2 * f(L - 12)), tail_width_12: r16(2 * f(12)),
  });
  base.anchors = { ...(base.anchors || {}), outline: [] };
  base.handles = { ...(base.handles || {}), outline: {} };
  const err = (p, lo, hi) => {
    const b = build({ ...p, marks: [] }), pr = b._profiles;
    let s = 0, c = 0;
    for (let i = 0; i < pr.x.length; i++) if (pr.x[i] >= lo && pr.x[i] <= hi) { s += (pr.h[i] - f(pr.x[i])) ** 2; c++; }
    return c ? Math.sqrt(s / c) : 0;
  };
  // nose type: whichever closed-form nose comes closest from the wide point forward
  let nose = base.nose_type, best = Infinity;
  for (const t of Object.keys(types.NOSE_TYPES)) {
    const e = err({ ...base, nose_type: t }, xw, L);
    if (e < best) { best = e; nose = t; }
  }
  base.nose_type = nose;
  // tail type: a swallow stays a swallow (the trace only sees the outside); otherwise a tail
  // that ends in a block is squash or square, one that closes is round, rounded pin or pin
  let tail = base.tail_type;
  if (notch) {                                            // the photo shows a swallow cut
    tail = 'swallow';
    base.swallow_depth = r16(Math.min(Math.max(notch.depth, 1), 10));
    const tipGap = f(0) - notch.half;                      // how much board is left at each tip
    base.swallow_tip = tipGap < 0.35 ? 0 : Math.min(1, tipGap / 1.5);
    base.swallow_width = r16(Math.max(1, 2 * notch.half));
    let block = tb;
    best = Infinity;
    for (const bw of Array.from({ length: 13 }, (_, k) => r16(tb + 0.25 * k))) {
      const e = err({ ...base, tail_type: 'swallow', tail_block_width: bw }, 0, xw);
      if (e < best) { best = e; block = bw; }
    }
    base.tail_block_width = block;
  } else if (tail !== 'swallow') {
    const closes = tb < Math.max(2, 0.12 * W);
    const cands = Object.entries(types.TAIL_TYPES).filter(([k, v]) => !v.notch && v.closes === closes).map(([k]) => k);
    best = Infinity;
    let block = tb;
    for (const t of cands) {
      // rounded corners make the very end narrower than the tail block, so try a few block widths
      const blocks = closes ? [base.tail_block_width] : Array.from({ length: 13 }, (_, k) => r16(tb + 0.25 * k));
      for (const bw of blocks) {
        const e = err({ ...base, tail_type: t, tail_block_width: bw }, 0, xw);
        if (e < best) { best = e; tail = t; block = bw; }
      }
    }
    if (!closes) base.tail_block_width = block;
  }
  base.tail_type = tail;
  // anchor points: as few as possible. Start with none, then add one where the design strays most from
  // the traced line (away from the measurements, which are held exactly already), until it is within
  // 1/16" everywhere or 10 points have been placed. Each point holds the trace's offset from the
  // closed-form curve; the curve between points is smooth, so a few go a long way.
  const plain = build({ ...base, marks: [], anchors: { ...base.anchors, outline: [] } }), pr = plain._profiles;
  const hAt = (q, x) => { let i = 0; while (i < q.x.length - 2 && q.x[i + 1] < x) i++; const t = (x - q.x[i]) / (q.x[i + 1] - q.x[i]); return q.h[i] + t * (q.h[i + 1] - q.h[i]); };
  const fixed = [0, L, half + base.wide_point_offset, 12, L - 12];
  const anchors = [], TOL = 1 / 16;
  for (let round = 0; round < 10; round++) {
    const q = build({ ...base, marks: [], anchors: { ...base.anchors, outline: anchors } })._profiles;
    let worst = 0, wx = null;
    for (let x = 1.5; x <= L - 1.5; x += 0.25) {
      if (fixed.some((v) => Math.abs(v - x) < 1.25) || anchors.some((a) => Math.abs(a[0] - x) < 2)) continue;
      const d = Math.abs(f(x) - hAt(q, x));
      if (d > worst) { worst = d; wx = x; }
    }
    if (wx === null || worst < TOL) break;
    anchors.push([+wx.toFixed(3), +(f(wx) - hAt(pr, wx)).toFixed(4)]);
    anchors.sort((a, b) => a[0] - b[0]);
  }
  base.anchors.outline = anchors;
  const fin = build(base), q = fin._profiles;
  let worst = 0;                                          // how far the design strays from the line, away from the very tips
  for (let i = 0; i < q.x.length; i++) if (q.x[i] > 1.5 && q.x[i] < L - 1.5) worst = Math.max(worst, Math.abs(q.h[i] - f(q.x[i])));
  return { params: base, nose, tail, error: worst };
}
