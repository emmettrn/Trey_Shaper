/*
 * Rider page: a starting board from the rider's size, ability and usual waves.
 *
 * Volume = body weight (kg) x liters per kilo. For shortboard-type boards the liters per
 * kilo by ability is the widely used "Guild factor" rule of thumb. The figures for
 * mid-lengths and longboards, the nudge for wave size, and the length rules are this
 * app's own starting points. All of it is shown on the page and is meant to be tuned.
 */
import { buildBoard, curves } from './geometry.js';
import { PRESETS } from './data.js';

const KG_PER_LB = 0.45359237;
// [key, label, what it means, Guild factor range (L/kg) for a shortboard]
const ABILITY = [
  ['beginner', 'Beginner', 'first year or so, still learning to catch and ride waves', [0.5, 0.6]],
  ['novice', 'Weekend warrior', 'surfs now and then, wants easy paddling and wave count', [0.43, 0.49]],
  ['intermediate', 'Intermediate', 'surfs regularly, turns on most waves', [0.38, 0.42]],
  ['advanced', 'Advanced', 'surfs most days, full rail turns', [0.36, 0.38]],
  ['pro', 'Expert / competitive', 'fit, surfing at a high level', [0.34, 0.36]],
];
const WAVES = [
  ['small', 'Small and weak', 0.02],
  ['everyday', 'Everyday, waist to head high', 0],
  ['good', 'Good and punchy', -0.01],
  ['big', 'Overhead and powerful', -0.01],
];
// Board types: which preset to start from, liters per kilo relative to the shortboard figure
// (or its own figure by ability for the big boards), and length from the rider's height (inches).
const order = ABILITY.map((a) => a[0]);
const by = (...v) => Object.fromEntries(order.map((k, i) => [k, v[i]]));
const SHORT_LEN = by(6, 4, 2, 1, 0);                    // shortboard = height + this
const TYPES = {
  shortboard: { label: 'Shortboard', preset: 'Shortboard', mult: 1, len: (H, a) => H + SHORT_LEN[a] },
  fish: { label: 'Fish', preset: 'Fish', mult: 1.12, len: (H, a) => H + SHORT_LEN[a] - 4 },
  groveler: { label: 'Groveler', preset: 'Groveler', mult: 1.08, len: (H, a) => H + SHORT_LEN[a] - 3 },
  stepup: { label: 'Step-up', preset: 'Step-up', mult: 1.05, len: (H, a) => H + SHORT_LEN[a] + 6 },
  mid: { label: 'Mid-length', preset: 'Mid-length', factor: by(0.85, 0.72, 0.64, 0.58, 0.55), len: (H, a) => clip(H + 20 + by(4, 2, 0, -2, -4)[a], 82, 98) },
  longboard: { label: 'Longboard', preset: 'Longboard', factor: by(1.1, 1.0, 0.92, 0.85, 0.8), len: (H, a) => clip(H + 38 + by(4, 2, 0, 0, 0)[a], 106, 120) },
};
const AUTO = {
  beginner: () => 'longboard',
  novice: () => 'mid',
  intermediate: (w) => ({ small: 'fish', big: 'stepup' }[w] || 'shortboard'),
  advanced: (w) => ({ small: 'groveler', big: 'stepup' }[w] || 'shortboard'),
  pro: (w) => ({ small: 'groveler', big: 'stepup' }[w] || 'shortboard'),
};

const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const snap = (v, step) => Math.round(v / step) * step;
const presetFor = (prefix) => PRESETS[Object.keys(PRESETS).find((k) => k.startsWith(prefix))];
const quickVolume = (p) => buildBoard({ ...p, stations: 81, section_points: 40 }).volume_l;

/** Rider in, { target liters, how it was worked out, board parameters } out. */
export function suggest(r) {
  const kg = r.units === 'us' ? r.weight * KG_PER_LB : r.weight;
  const H = r.units === 'us' ? r.ft * 12 + r.inch : r.cm / 2.54;
  if (!(kg >= 20 && kg <= 200) || !(H >= 48 && H <= 84)) return null;
  const ab = ABILITY.find((a) => a[0] === r.ability) || ABILITY[2];
  const wv = WAVES.find((w) => w[0] === r.waves) || WAVES[1];
  const key = r.type === 'auto' ? AUTO[ab[0]](wv[0]) : r.type;
  const T = TYPES[key] || TYPES.shortboard;
  const [lo, hi] = ab[3];
  const base = T.factor ? T.factor[ab[0]] : ((lo + hi) / 2) * T.mult;
  const factor = (base + wv[2]) * (1 + r.tune / 100);
  const target = kg * factor;

  const how = [];
  how.push(T.factor
    ? `${T.label} for a ${ab[1].toLowerCase()} rider: about ${base.toFixed(2)} L per kg (this app's starting point)`
    : `${ab[1]}: ${lo.toFixed(2)} to ${hi.toFixed(2)} L per kg on a shortboard (the Guild factor rule of thumb)${T.mult !== 1 ? `, ×${T.mult} for a ${T.label.toLowerCase()}` : ''}`);
  if (wv[2]) how.push(`${wv[1].toLowerCase()} waves: ${wv[2] > 0 ? '+' : '−'}${Math.abs(wv[2]).toFixed(2)} L per kg`);
  if (r.tune) how.push(`your adjustment: ${r.tune > 0 ? '+' : '−'}${Math.abs(r.tune)}%`);
  how.push(`${kg.toFixed(0)} kg × ${factor.toFixed(2)} L per kg = ${target.toFixed(1)} L`);

  // Scale the preset. Length comes from the rider's height; width (within 8% of the preset, so the
  // board keeps its character) and then thickness make up the volume; if they run out of room,
  // the length gives a little too.
  const src = presetFor(T.preset), V0 = quickVolume(src), p = structuredClone(src);
  const L0 = clip(Math.round(T.len(H, ab[0])), 54, 120);
  let L = L0;
  const size = () => {
    const fL = L / src.length;
    p.length = L;
    for (const k of ['wide_point_offset', 'rocker_low_point', 'thickness_point_offset']) if (Number.isFinite(src[k])) p[k] = snap(src[k] * fL, 0.25);
    const fW = clip(snap(src.width * clip(Math.sqrt(target / (V0 * fL)), 0.92, 1.08), 0.125), 16, 25) / src.width;
    for (const k of ['width', 'nose_width_12', 'tail_width_12', 'tail_block_width', 'swallow_width'])
      if (Number.isFinite(src[k])) p[k] = snap(src[k] * fW, 0.125);
    const lo = Math.max(0.85, 1.75 / src.thickness), hi = Math.min(1.2, 4 / src.thickness);
    let fT = 1;
    const thick = () => {
      for (const k of ['thickness', 'nose_thickness', 'nose_thickness_12', 'tail_thickness_12', 'tail_thickness'])
        if (Number.isFinite(src[k])) p[k] = snap(src[k] * fT, 0.0625);
    };
    for (let i = 0; i < 4; i++) { thick(); fT = clip((fT * target) / quickVolume(p), lo, hi); }
    thick();
    return quickVolume(p);
  };
  let V = size();
  if (Math.abs(V - target) / target > 0.03) {
    L = clip(Math.round((L * target) / V), Math.max(54, L0 - 10), Math.min(120, L0 + 10));
    if (L !== L0) { V = size(); how.push(`length ${L > L0 ? 'stretched' : 'trimmed'} ${Math.abs(L - L0)}″ so the width and thickness stay sensible`); }
  }
  p.lock_volume = false;
  const board = buildBoard(p);
  board.curves = curves(board);
  return { target, factor, kg, type: T.label, auto: r.type === 'auto', how, params: p, board };
}

const DEFAULTS = { units: 'us', weight: 170, ft: 5, inch: 10, cm: 178, ability: 'intermediate', waves: 'everyday', type: 'auto', tune: 0 };

export function initRider(root, { fracIn, ftin, open }) {
  const r = { ...DEFAULTS };
  try { Object.assign(r, JSON.parse(localStorage.getItem('surfboard.rider') || '{}')); } catch {}
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  root.innerHTML = `<div class="rider-wrap">
    <div class="rider-form">
      <h1>Rider</h1>
      <p class="lead">Say who the board is for. This works out a volume and a starting shape that you can open in the designer and refine.</p>
      <div class="rf"><label>Units</label><div class="seg" id="r-units"><button data-u="us">lb · ft</button><button data-u="metric">kg · cm</button></div></div>
      <div class="rf"><label for="r-weight">Weight</label><div class="in"><input id="r-weight" class="cell" inputmode="decimal"><span id="r-wu"></span></div></div>
      <div class="rf"><label for="r-ft">Height</label>
        <div class="in" id="r-h-us"><input id="r-ft" class="cell" inputmode="numeric"><span>ft</span><input id="r-in" class="cell" inputmode="decimal"><span>in</span></div>
        <div class="in" id="r-h-m"><input id="r-cm" class="cell" inputmode="decimal"><span>cm</span></div></div>
      <div class="rf"><label for="r-ability">Ability</label><select id="r-ability">${opts(ABILITY, r.ability)}</select><div class="help" id="r-ability-help"></div></div>
      <div class="rf"><label for="r-waves">Usual waves</label><select id="r-waves">${opts(WAVES, r.waves)}</select></div>
      <div class="rf"><label for="r-type">Board</label><select id="r-type">${opts([['auto', 'Pick for me'], ...Object.entries(TYPES).map(([k, t]) => [k, t.label])], r.type)}</select></div>
      <div class="rf"><label for="r-tune">Foam</label><input type="range" id="r-tune" min="-15" max="15" step="1"><div class="help" id="r-tune-help"></div></div>
    </div>
    <div class="rider-result">
      <div class="r-vol"><b id="r-vol">--</b><small>liters</small><span id="r-factor"></span></div>
      <div id="r-board"></div>
      <canvas id="r-canvas"></canvas>
      <ul id="r-how"></ul>
      <button class="primary" id="r-open">Open in the designer</button>
      <p class="help">A first guess, not a prescription. Liters per kilo by ability is the common Guild factor rule of thumb for shortboards. The wave nudge, the mid-length and longboard figures, and the lengths are this app's starting points. Tune the result in the designer.</p>
    </div></div>`;
  const $ = (s) => root.querySelector(s);
  let result = null;

  const draw = () => {
    const c = $('#r-canvas'), b = result?.board;
    const box = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (box.width < 4) return;
    c.width = Math.round(box.width * dpr); c.height = Math.round(box.height * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (!b) return;
    const o = b.curves.outline, rk = b.curves.rocker, L = b.params.length, W = b.stats.width_in;
    const top = Math.max(...rk.deck), s = Math.min((box.width - 16) / L, (box.height - 26) / (W + top + 1.5));
    const X = (x) => box.width / 2 + (x - L / 2) * s;
    const y0 = 6 + (W / 2) * s, y1 = 6 + W * s + 14 + top * s;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    o.x.forEach((x, i) => (i ? ctx.lineTo(X(x), y0 - o.h[i] * s) : ctx.moveTo(X(x), y0 - o.h[i] * s)));
    for (let i = o.x.length - 1; i >= 0; i--) ctx.lineTo(X(o.x[i]), y0 + o.h[i] * s);
    ctx.closePath();
    ctx.fillStyle = 'rgba(243,239,230,0.08)'; ctx.fill();
    ctx.strokeStyle = '#f3efe6'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#9a7650'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(0), y0); ctx.lineTo(X(L), y0); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    rk.x.forEach((x, i) => (i ? ctx.lineTo(X(x), y1 - rk.deck[i] * s) : ctx.moveTo(X(x), y1 - rk.deck[i] * s)));
    for (let i = rk.x.length - 1; i >= 0; i--) ctx.lineTo(X(rk.x[i]), y1 - rk.bottom[i] * s);
    ctx.closePath();
    ctx.fillStyle = 'rgba(60,200,180,0.10)'; ctx.fill();
    ctx.strokeStyle = '#3cc8b4'; ctx.lineWidth = 1.4; ctx.stroke();
  };

  const num = (el) => { const v = parseFloat(el.value.replace(',', '.')); return Number.isFinite(v) ? v : NaN; };
  const sync = () => {
    root.querySelectorAll('#r-units button').forEach((b) => b.classList.toggle('on', b.dataset.u === r.units));
    $('#r-wu').textContent = r.units === 'us' ? 'lb' : 'kg';
    $('#r-h-us').hidden = r.units !== 'us'; $('#r-h-us').style.display = r.units === 'us' ? '' : 'none';
    $('#r-h-m').style.display = r.units === 'us' ? 'none' : '';
    $('#r-weight').value = +(+r.weight).toFixed(1);
    $('#r-ft').value = r.ft; $('#r-in').value = +(+r.inch).toFixed(1); $('#r-cm').value = +(+r.cm).toFixed(0);
    $('#r-tune').value = r.tune;
  };
  const update = () => {
    try { localStorage.setItem('surfboard.rider', JSON.stringify(r)); } catch {}
    $('#r-ability-help').textContent = (ABILITY.find((a) => a[0] === r.ability) || ABILITY[2])[2];
    $('#r-tune-help').textContent = r.tune ? `${r.tune > 0 ? '+' : '−'}${Math.abs(r.tune)}% ${r.tune > 0 ? 'more float and paddle' : 'more sensitive, less float'}` : 'as worked out · slide for more or less';
    $('#r-tune').style.setProperty('--pct', `${((r.tune + 15) / 30) * 100}%`);
    try { result = suggest(r); } catch (e) { console.error(e); result = null; }
    $('#r-open').disabled = !result;
    if (!result) {
      $('#r-vol').textContent = '--'; $('#r-factor').textContent = '';
      $('#r-board').textContent = 'Enter a weight and height to get a board.'; $('#r-how').innerHTML = '';
      draw();
      return;
    }
    const s = result.board.stats;
    $('#r-vol').textContent = result.target.toFixed(1);
    $('#r-factor').textContent = `${result.factor.toFixed(2)} L per kg`;
    const off = Math.abs(s.volume_l - result.target) > Math.max(0.6, 0.03 * result.target);
    $('#r-board').innerHTML = `<b>${result.type}</b> ${ftin(s.length_in)} × ${fracIn(s.width_in)}″ × ${fracIn(s.thickness_in)}″
      <small>${result.auto ? 'picked for this rider and these waves · ' : ''}comes out at ${s.volume_l.toFixed(1)} L${off ? ' (as close as this shape gets; change the board type or length)' : ''}</small>`;
    $('#r-how').innerHTML = result.how.map((h) => `<li>${h}</li>`).join('');
    draw();
  };

  root.querySelector('#r-units').addEventListener('click', (e) => {
    const u = e.target.closest('button')?.dataset.u;
    if (!u || u === r.units) return;
    if (u === 'metric') { r.weight = r.weight * KG_PER_LB; r.cm = (r.ft * 12 + r.inch) * 2.54; }
    else { r.weight = r.weight / KG_PER_LB; const H = r.cm / 2.54; r.ft = Math.floor(H / 12 + 1e-6); r.inch = Math.round((H - r.ft * 12) * 2) / 2; if (r.inch >= 12) { r.ft++; r.inch = 0; } }
    r.units = u; sync(); update();
  });
  for (const [id, key] of [['#r-weight', 'weight'], ['#r-ft', 'ft'], ['#r-in', 'inch'], ['#r-cm', 'cm']]) {
    const el = $(id);
    el.addEventListener('input', () => { const v = num(el); if (Number.isFinite(v)) { r[key] = v; update(); } });
    el.addEventListener('focus', () => el.select());
  }
  for (const [id, key] of [['#r-ability', 'ability'], ['#r-waves', 'waves'], ['#r-type', 'type']])
    $(id).addEventListener('change', () => { r[key] = $(id).value; update(); });
  $('#r-tune').addEventListener('input', () => { r.tune = +$('#r-tune').value; update(); });
  $('#r-open').addEventListener('click', () => { if (result) open(structuredClone(result.params), result); });
  new ResizeObserver(draw).observe($('#r-canvas'));
  sync(); update();
  return { refresh: () => { draw(); } };
}
