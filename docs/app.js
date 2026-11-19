import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { railTuckFromOld, buildBoard, curves, sliceInfo, sectionAt, sectionBase, specSheet, toSTL, toOBJ, zipOne, NULLABLE, BOTTOM_LABELS, posToX, FROM, TOOL_SHAPES, toolOutline, toolCenterLine } from './geometry.js';
import { DEFAULTS, PRESETS, GROUPS, STATION_TABLE, TAIL_TYPES, NOSE_TYPES } from './data.js';
import { traceFrame, traceHalf, tracePoints, fitOutline, pchip, traceCurve } from './trace.js';

const $ = (s) => document.querySelector(s);
const state = {
  schema: null, params: {}, board: null, fieldEls: {}, cellEls: {}, mirrors: [],
  dirty: false, busy: false, wire: false, stringer: true, fitted: false,
  sel: null,      // id of the cross-section slice being edited, or null while rolling through the board
  tool: null,     // id of the concave tool being shaped on the Plan graph, or null
  toolPt: null,   // the point of that tool's edge whose arms are showing
  scrub: null,    // where the Sections view is looking, inches from the tail (null = the wide point)
  pt: null,       // the anchor point whose handle arms are showing
  flip: false,    // 3D view: board turned bottom up
  focus: null,    // which view is expanded: 'view' | 'plan' | 'profile' | 'sections' | null
};
const TAIL_CLOSES = Object.keys(TAIL_TYPES).filter((k) => TAIL_TYPES[k].closes);

// Viewer preferences (not part of the design): kept per browser
const LIGHT_HOME = [-0.79, 0.59];     // fixed light: left and up, low and raking (about 10 degrees), so slight contours show
const prefs = { fix: true, vexProfile: 1, vexSections: 1, bay: true, bayGain: 0.3, fixedLight: true, edit: false, lightDir: LIGHT_HOME, layout: {} };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('surfboard.ui') || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem('surfboard.ui', JSON.stringify(prefs)); } catch {} };
const COARSE = matchMedia('(pointer: coarse)').matches;      // fingers rather than a mouse: bigger targets, share sheet
const COLORS = { foam: '#f3efe6', accent: '#3cc8b4', warm: '#ff8a5b', sand: '#e8c872', muted: '#84949f', line: '#24313b', wood: '#9a7650' };

/* =========================================================================
   Number formatting: shapers think in feet-inches and sixteenths
   ========================================================================= */
function fracIn(v, den = 16) {
  const neg = v < 0; v = Math.abs(v);
  let whole = Math.floor(v), n = Math.round((v - whole) * den), d = den;
  if (n === den) { whole++; n = 0; }
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  const s = n ? (whole ? `${whole} ${n}/${d}` : `${n}/${d}`) : `${whole}`;
  return (neg && (whole || n) ? '−' : '') + s;
}
const ftin = (v) => { const ft = Math.floor(v / 12 + 1e-9); return `${ft}'${fracIn(v - ft * 12)}"`; };
function fmt(v, unit) {
  switch (unit) {
    case 'in': return fracIn(v) + '″';
    case 'ftin': return ftin(v);
    case 'L': return v.toFixed(1) + ' L';
    default: return (+v).toFixed(2);
  }
}
// Same notation as surfboard/units.py: 19.5, 19 1/2, 19-1/2, 6'0", 6' 2 1/2", 6 ft 2 in, -1/2, 29.6 L
function parseVal(str) {
  let s = str.trim().toLowerCase().replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").replace(/−/g, '-').replace(/\s*l$/, '');
  const sign = s.startsWith('-') ? -1 : 1;
  if (sign < 0) s = s.slice(1);
  s = s.replace(/\b(feet|foot|ft)\b/g, "'").replace(/\b(inches|inch|in)\b/g, '"');
  let feet = 0;
  if (s.includes("'")) { const [f, rest] = s.split(/'(.*)/s); feet = Number(f.trim() || 0); s = rest; }
  const tokens = s.replace(/"/g, ' ').replace(/-/g, ' ').replace(/\s*\/\s*/g, '/').split(/\s+/).filter(Boolean);
  let inches = 0;
  for (const tok of tokens) {
    const m = tok.match(/^(\d+)\/(\d+)$/);
    inches += m ? (+m[2] ? m[1] / m[2] : NaN) : Number(tok);
  }
  if (!tokens.length && !str.includes("'")) return NaN;
  return sign * (feet * 12 + inches);
}

/* =========================================================================
   Controls, generated from data.js (built from the Python schema)
   ========================================================================= */
function buildControls() {
  const root = $('#controls');
  root.innerHTML = '';
  root.appendChild(buildStationTable());
  root.appendChild(buildSectionGroup());
  state.schema.groups.forEach((g, gi) => {
    const det = document.createElement('details');
    det.className = 'group';
    det.open = gi < 2;
    det.innerHTML = `<summary>${g.name}</summary><div class="fields"></div>`;
    g.fields.forEach((f) => det.querySelector('.fields').appendChild(makeField(f)));
    if (g.name === 'Bottom') {
      const note = document.createElement('div');
      note.className = 'bottom-note';
      note.innerHTML = 'Three ways to shape the bottom: the <b>contour stations</b> below (blended from spot to spot), the <b>concave tools</b> (hard-edged concaves you lay out on the Plan graph), or by hand on any cross section in the <b>cross section editor</b> (Sections graph, <i>Edit here</i>).';
      det.querySelector('.fields').prepend(note);
      det.querySelector('.fields').appendChild(buildBottomBox());
      det.querySelector('.fields').appendChild(buildToolsBox());
    }
    root.appendChild(det);
  });
}

/* Measurement table: stations x width / rocker / thickness. Its cells edit the same
   parameters as the sliders below: type exact numbers here, drag a slider to explore. */
function buildStationTable() {
  const t = state.schema.station_table;
  const det = document.createElement('details');
  det.className = 'group';
  det.open = true;
  det.innerHTML = `<summary>Measurements</summary>
    <div class="fields">
      <table class="stations">
        <thead><tr><th></th>${t.columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody></tbody>
      </table>
      <div class="wp-row"><span>Wide point</span><input class="cell" id="wp-offset" type="text" spellcheck="false" aria-label="Wide point from center"><span class="unit">from center (+ = nose)</span></div>
      <div class="bottom-actions"><button class="ghost" id="mark-add" title="Add a row to the table: hold the width, rocker and / or thickness at any other spot along the board">+ Add a measurement</button></div>
      <label class="toggle fix"><input type="checkbox" id="fix-dims"><span>Fix dimensions <small>only anchor points can be dragged on the graphs</small></span></label>
      <div class="help">Inches, fractions OK: 19 3/4. Leave a box blank and it is worked out from the rest of the board (shown as ~). Rocker is bottom height above a flat table.</div>
    </div>`;
  bindCell(det.querySelector('#wp-offset'), 'wide_point_offset', 0.25);
  det.querySelector('#mark-add').addEventListener('click', addMark);
  const fix = det.querySelector('#fix-dims');
  fix.checked = prefs.fix;
  fix.addEventListener('change', () => { prefs.fix = fix.checked; savePrefs(); drawPanels(); });
  const body = det.querySelector('tbody');
  marksUI.body = body;
  for (const [ri, row] of t.rows.entries()) {
    const tr = document.createElement('tr');
    tr.dataset.std = ri;                                 // a standard station: nose tip, 12" from nose, wide point, 12" from tail, tail end
    tr.innerHTML = `<th>${row.label}</th>`;
    for (let spec of row.cells) {
      if (typeof spec === 'string') spec = { key: spec };
      const td = document.createElement('td');
      let inp = null;
      if (spec.key) {
        const key = spec.key;
        inp = document.createElement('input');
        Object.assign(inp, { type: 'text', spellcheck: false, className: 'cell' });
        inp.setAttribute('aria-label', `${row.label} ${key.replace(/_/g, ' ')}`);
        bindCell(inp, key, 0.0625);
        td.appendChild(inp);
      }
      if (spec.mirror || spec.text !== undefined) {
        const span = document.createElement('span');
        span.className = 'fixed';
        span.textContent = spec.text ?? '';
        td.appendChild(span);
        if (spec.mirror) state.mirrors.push({ span, inp, key: spec.key, mirror: spec.mirror });
      }
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  return det;
}

/* Added measurements: width, rocker and / or thickness at any other spot along the board,
   typed like the table above. A blank box is not held there (it shows what the board has). */
const marksUI = { els: [] };
const markX = (r, L) => posToX(r, L);
/* "From" boxes: the nose, the tail, or the center. From the center the number is kept signed
   (+ toward the nose, - toward the tail) but shown as two choices, ahead of / behind center. */
const fromOf = (f) => (FROM.includes(f) ? f : 'tail');
const fromKey = (r) => (r.from === 'center' ? (r.pos < 0 ? 'back' : 'fwd') : r.from);
const showPos = (r) => Math.abs(r.pos);
/** Set from a "from" box: keep the spot's number, flip its sign for behind center. */
function setFrom(r, key) {
  const v = Math.abs(r.pos);
  if (key === 'fwd' || key === 'back') { r.from = 'center'; r.pos = key === 'back' ? -v : v; } else { r.from = key; r.pos = v; }
}
function setPos(r, v) { r.pos = r.from === 'center' && fromKey(r) === 'back' ? -Math.abs(v) : Math.abs(v); }
const FROM_SHORT = '<option value="nose">nose</option><option value="tail">tail</option><option value="fwd" title="ahead of center (toward the nose)">ctr ▲</option><option value="back" title="behind center (toward the tail)">ctr ▼</option>';
const FROM_LONG = '<option value="nose">from the nose</option><option value="tail">from the tail</option><option value="fwd">ahead of center</option><option value="back">behind center</option>';

function marksChanged(rebuild) {
  if (rebuild) renderMarks();
  saveLocal();
  schedule();
}

function addMark() {
  const P = state.params, L = have('length');
  const xs = [0, 12, L / 2, L - 12, L, ...P.marks.map((r) => markX(r, L))].sort((p, q) => p - q);
  let best = xs.length - 2;                             // the widest gap between the measurements there are, nose side first
  for (let i = xs.length - 2; i >= 0; i--) if (xs[i + 1] - xs[i] > xs[best + 1] - xs[best] + 1e-9) best = i;
  const x = clip(snap((xs[best] + xs[best + 1]) / 2, 1), 2, L - 2);
  P.marks.push({ pos: x > L / 2 ? L - x : x, from: x > L / 2 ? 'nose' : 'tail', width: null, rocker: null, thickness: null });
  marksChanged(true);
}

/** Rebuild the rows (nose first). Only on structural changes, so typing never loses focus. */
function renderMarks() {
  const P = state.params, body = marksUI.body;
  if (!body) return;
  body.querySelectorAll('tr.mark').forEach((tr) => tr.remove());
  marksUI.els = [];
  for (const r of P.marks) {
    const el = document.createElement('tr');
    el.className = 'mark';
    el.innerHTML = `<th><div class="mlabel"><input class="cell pos" type="text" spellcheck="false" aria-label="Position in inches"><select class="from" aria-label="Measured from" title="from the nose, the tail, or ahead of (▲) / behind (▼) center">${FROM_SHORT}</select><button class="x" title="Remove this measurement" aria-label="Remove">×</button></div></th>
      <td><input class="cell" data-k="width" type="text" spellcheck="false" aria-label="Width"></td>
      <td><input class="cell" data-k="rocker" type="text" spellcheck="false" aria-label="Rocker"></td>
      <td><input class="cell" data-k="thickness" type="text" spellcheck="false" aria-label="Thickness"></td>`;
    const pos = el.querySelector('.pos'), from = el.querySelector('.from');
    from.value = fromKey(r);
    const cells = {};
    for (const inp of el.querySelectorAll('input')) {
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
    pos.addEventListener('change', () => { const v = parseVal(pos.value); if (Number.isFinite(v)) setPos(r, clip(Math.abs(v), 0, 143)); marksChanged(false); orderTable(); });
    from.addEventListener('change', () => { setFrom(r, from.value); marksChanged(false); orderTable(); });
    for (const inp of el.querySelectorAll('[data-k]')) {
      const key = inp.dataset.k;
      cells[key] = inp;
      inp.addEventListener('change', () => {
        const v = inp.value.trim() === '' ? null : parseVal(inp.value);
        if (v === null || Number.isFinite(v)) { r[key] = v; if (v === null) delete r[{ width: 'hw', rocker: 'hr', thickness: 'ht' }[key]]; }
        marksChanged(false);
      });
    }
    el.querySelector('.x').addEventListener('click', () => { dropFrom(P.marks, r); state.pt = null; marksChanged(true); });
    body.appendChild(el);
    marksUI.els.push({ r, el, pos, cells });
  }
  orderTable();
}

/** Keep the table in order nose to tail: the added rows sit between the standard stations where they belong. */
function orderTable() {
  const body = marksUI.body; if (!body) return;
  const L = have('length'), xw = L / 2 + (have('wide_point_offset') || 0);
  const stdX = [L, L - 12, xw, 12, 0];
  const rows = [...body.children].map((tr) => ({ tr, x: tr.dataset.std !== undefined ? stdX[+tr.dataset.std] ?? 0 : markX(marksUI.els.find((m) => m.el === tr)?.r ?? { pos: 0, from: 'tail' }, L), std: tr.dataset.std !== undefined }));
  const want = [...rows].sort((a, b) => b.x - a.x || (a.std ? -1 : 1));
  if (want.some((q, i) => q.tr !== body.children[i])) for (const q of want) body.appendChild(q.tr);
}

/** Show each row's numbers, and in the blank boxes what the board measures there. */
function syncMarks(data) {
  const pr = data._profiles, L = data.params.length;
  for (const { r, el, pos, cells } of marksUI.els) {
    const x = markX(r, L), live = (inp) => document.activeElement === inp;
    if (!live(pos)) pos.value = fracIn(showPos(r));
    const now = { width: 2 * lerpAt(pr.x, pr.h, x), rocker: lerpAt(pr.x, pr.zb, x), thickness: lerpAt(pr.x, pr.t, x) };
    for (const [key, inp] of Object.entries(cells)) {
      if (!live(inp)) inp.value = r[key] === null || r[key] === undefined ? '' : fracIn(r[key]);
      inp.placeholder = `~${fracIn(now[key])}`;
    }
    const used = data.params.marks.some((m) => m.pos === r.pos && m.from === r.from);
    el.classList.toggle('off', !used);
    el.title = used ? '' : 'Not used: too close to the tip or to another measurement';
  }
  orderTable();
}

/* Bottom contours along the board: a short list of stations ("1/16 concave 12 from the nose,
   1/4 at 36 from the tail, vee 4 from the tail"). The geometry blends between them. */
const BOTTOM_OPTIONS = [['flat', 'Flat'], ['concave', 'Single concave'], ['double', 'Double concave'], ['concave_double', 'Single with double inside'],
  ['vee', 'Vee'], ['vee_double', 'Vee with double concave (spiral vee)'], ['roll', 'Roll / convex']];
const BOTTOM_DEPTHS = { flat: [], concave: ['depth'], roll: ['depth'], double: ['depth'], vee: ['depth'], concave_double: ['single', 'double'], vee_double: ['vee', 'double'] };
const bottomUI = {};

function buildBottomBox() {
  const box = document.createElement('div');
  box.className = 'bottom-box';
  box.innerHTML = `<div class="bottom-head">Contours along the board</div>
    <div class="bottom-rows"></div>
    <div class="bottom-actions"><button class="ghost" data-add>+ Add a station</button><button class="ghost" data-example title="Flat entry, single concave through the middle, double concave off the back foot, vee out the tail">Example</button></div>
    <div class="help" id="bottom-help"></div>`;
  bottomUI.rows = box.querySelector('.bottom-rows');
  bottomUI.help = box.querySelector('#bottom-help');
  box.querySelector('[data-add]').addEventListener('click', () => {
    const P = state.params, L = have('length');
    const xs = [0, ...P.bottom.flatMap((r) => [posToX(r, L), ...(r.to ? [posToX(r.to, L)] : [])]).sort((p, q) => p - q), L];
    let best = 0;
    for (let i = 1; i < xs.length - 1; i++) if (xs[i + 1] - xs[i] > xs[best + 1] - xs[best]) best = i;
    const x = snap((xs[best] + xs[best + 1]) / 2, 1);
    P.bottom.push({ pos: x > L / 2 ? L - x : x, from: x > L / 2 ? 'nose' : 'tail', type: 'concave', depth: 0.125, depth2: 0.0625 });
    bottomChanged(true);
  });
  box.querySelector('[data-example]').addEventListener('click', () => {
    const L = have('length');
    state.params.bottom = [
      { pos: 12, from: 'nose', type: 'concave', depth: 0.0625, depth2: 0.0625 },
      { pos: snap(L / 2, 1), from: 'tail', type: 'concave', depth: 0.25, depth2: 0.0625 },
      { pos: 12, from: 'tail', type: 'double', depth: 0.125, depth2: 0.0625 },
      { pos: 4, from: 'tail', type: 'vee', depth: 0.0625, depth2: 0.0625 },
    ];
    bottomChanged(true);
  });
  return box;
}

function bottomChanged(rebuild) {
  if (rebuild) renderBottomTable();
  updateVisibility();
  saveLocal();
  schedule();
}

/** Rebuild the station rows (nose first). Only on structural changes, so typing never loses focus. */
function renderBottomTable() {
  const P = state.params, L = P.length, box = bottomUI.rows;
  if (!box) return;
  const xn = (r) => L - posToX(r, L);
  P.bottom.sort((p, q) => xn(p) - xn(q));
  box.innerHTML = '';
  for (const r of P.bottom) {
    const el = document.createElement('div');
    el.className = 'brow';
    el.innerHTML = `<input class="cell pos" type="text" spellcheck="false" aria-label="Position in inches">
      <span>″</span>
      <select class="from" aria-label="Measured from">${FROM_LONG}</select>
      <button class="x" title="Remove this station" aria-label="Remove">×</button>
      <div class="line3"><span>until</span><input class="cell pos2" type="text" spellcheck="false" aria-label="Until, inches"><span>″</span>
        <select class="from2" aria-label="Until, measured from">${FROM_LONG}</select><button class="x x2" title="Just this spot, not a stretch" aria-label="Remove until">×</button></div>
      <div class="line4"><div class="trow where"><span>deepest</span><input class="cell p3" spellcheck="false" aria-label="Deepest at, inches"><span>″</span><select class="f3" aria-label="Measured from">${FROM_LONG}</select></div>
        <div class="trow blends">${BLEND_ROW}</div></div>
      <div class="line2"><select class="type" aria-label="Contour">${BOTTOM_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="cell d1" type="text" spellcheck="false"><input class="cell d2" type="text" spellcheck="false">
        <button class="ghost until" title="Make this a stretch: the same contour from here until another spot">until…</button></div>`;
    const q = (s) => el.querySelector(s);
    const paint = () => {
      const names = BOTTOM_DEPTHS[r.type];
      q('.line2').className = `line2 ${['none', 'one', ''][names.length]}`;
      q('.d1').hidden = names.length < 1; q('.d2').hidden = names.length < 2;
      q('.d1').value = fracIn(r.depth, 32); q('.d2').value = fracIn(r.depth2, 32);
      q('.d1').title = `${names[0] || ''} depth, inches`; q('.d2').title = `${names[1] || ''} depth, inches`;
      q('.d1').setAttribute('aria-label', q('.d1').title); q('.d2').setAttribute('aria-label', q('.d2').title);
      q('.pos').value = fracIn(showPos(r));
      q('.line3').hidden = !r.to; q('.until').hidden = !!r.to; q('.line4').hidden = !r.to;
      if (r.to) paintDeep(q, r, state.board?.params.bottom?.stretches?.find((S) => S.pos === r.pos && S.from === fromOf(r.from) && S.to.pos === r.to.pos), L);
      if (r.to) { q('.pos2').value = fracIn(showPos(r.to)); q('.from2').value = fromKey(r.to); }
    };
    q('.from').value = fromKey(r); q('.type').value = r.type;
    paint();
    el._paint = paint;
    const numeric = (sel, key, lo, hi) => {
      const inp = q(sel);
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => {
        const v = parseVal(inp.value);
        if (Number.isFinite(v)) r[key] = clip(v, lo, hi);
        paint(); bottomChanged(false);
      });
    };
    numeric('.d1', 'depth', 0, 0.75); numeric('.d2', 'depth2', 0, 0.75);
    for (const [sel, get] of [['.pos', () => r], ['.pos2', () => r.to]]) {
      const inp = q(sel);
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => { const v = parseVal(inp.value), t = get(); if (t && Number.isFinite(v)) setPos(t, clip(Math.abs(v), 0, 240)); paint(); bottomChanged(false); });
    }
    q('.from').addEventListener('change', () => { setFrom(r, q('.from').value); bottomChanged(false); });
    q('.from2').addEventListener('change', () => { if (r.to) setFrom(r.to, q('.from2').value); bottomChanged(false); });
    q('.until').addEventListener('click', () => {      // start the stretch a foot toward the tail (or the nose, near the tail)
      const x = posToX(r, L), x2 = x - 12 >= 2 ? x - 12 : Math.min(L - 2, x + 12);
      r.to = x2 > L / 2 ? { pos: snap(L - x2, 1), from: 'nose' } : { pos: snap(x2, 1), from: 'tail' };
      paint(); bottomChanged(false);
    });
    q('.x2').addEventListener('click', () => { delete r.to; delete r.deep; delete r.blendNose; delete r.blendTail; paint(); bottomChanged(false); });
    wireDeep(q, r, paint, () => bottomChanged(false));
    q('.type').addEventListener('change', () => { r.type = q('.type').value; paint(); bottomChanged(false); });
    q('.x').addEventListener('click', () => { dropFrom(P.bottom, r); bottomChanged(true); });
    box.appendChild(el);
  }
  bottomUI.help.textContent = P.bottom.length
    ? 'Blended smoothly from station to station; a stretch (until…) holds its contour all the way through. The nose tip is flat and the station nearest the tail carries out the tail. Depths in inches, fractions OK: 1/16, 3/32, 1/4.'
    : 'Say what the bottom does at a few spots (for example 1/16″ concave 12″ from the nose, 1/4″ at center, vee 4″ from the tail) and it is blended in between. A station can be a stretch: until… holds the same contour from one spot to another. With no stations, the two sliders above are used.';
}



/* "Deepest at" and the two blend sliders, shared by the concave tools and the contour stretches. */
const BLEND_ROW = `<label title="How the depth eases out toward the nose: left = holds full depth to the end, right = eases all the way from the deepest spot">blend → nose<input type="range" class="bn" min="0" max="1" step="0.05"></label>
  <label title="How the depth eases out toward the tail: left = holds full depth to the end, right = eases all the way from the deepest spot">blend → tail<input type="range" class="bt" min="0" max="1" step="0.05"></label>`;
function paintDeep(q, r, made, L) {
  const live = (el) => document.activeElement === el;
  if (!live(q('.p3'))) q('.p3').value = r.deep ? fracIn(showPos(r.deep)) : '';
  q('.f3').value = r.deep ? fromKey(r.deep) : 'nose';
  if (made && L && !r.deep) {                            // worked out: show where it is, from the nose
    const xd = made.xd ?? (made.x0 + made.x1) / 2;
    q('.p3').placeholder = `~${fracIn(L - xd)}`; q('.f3').value = 'nose';
  } else q('.p3').placeholder = 'auto';
  for (const [cls, key, def] of [['.bn', 'blendNose', made?.blendNose ?? made?.bn ?? 0], ['.bt', 'blendTail', made?.blendTail ?? made?.bt ?? 0]]) {
    const el = q(cls), v = Number.isFinite(r[key]) ? r[key] : def;
    if (!live(el)) el.value = v;
    el.style.setProperty('--pct', `${v * 100}%`);
  }
}
function wireDeep(q, r, paint, changed) {
  const set = () => {
    const v = parseVal(q('.p3').value);
    if (q('.p3').value.trim() === '') delete r.deep;
    else if (Number.isFinite(v)) { r.deep = { pos: Math.abs(v), from: 'tail' }; setFrom(r.deep, q('.f3').value); }
    paint(); changed();
  };
  q('.p3').addEventListener('change', set);
  q('.p3').addEventListener('focus', () => q('.p3').select());
  q('.f3').addEventListener('change', () => { if (r.deep) setFrom(r.deep, q('.f3').value); else if (q('.p3').placeholder.startsWith('~')) { r.deep = { pos: parseVal(q('.p3').placeholder.slice(1)), from: 'nose' }; setFrom(r.deep, q('.f3').value); } paint(); changed(); });
  for (const [cls, key] of [['.bn', 'blendNose'], ['.bt', 'blendTail']])
    q(cls).addEventListener('input', () => { r[key] = +q(cls).value; q(cls).style.setProperty('--pct', `${r[key] * 100}%`); changed(); });
}
/* Concave tools: hard-edged concaves (tear drop, straight edges, venturi), single or double,
   between two spots on the board. Each has a box here with its numbers; "Shape it" puts it
   on the Plan graph to drag its ends and edges. */
const TOOL_COL = '#7ec8ff', TOOL_COL2 = '#b7e0ff';
const toolsUI = {};
const rawTool = (id) => state.params.tools?.find((t) => t.id === id);
function toolsChanged(rebuild) { if (rebuild) renderTools(); saveLocal(); schedule(); }
function newTool(shape) {
  const P = state.params, L = have('length'), W = have('width');
  const id = 1 + Math.max(0, ...(P.tools || []).map((t) => t.id || 0));
  const r16 = (v) => Math.round(v * 16) / 16;
  const t = shape === 'teardrop'
    ? { id, shape, kind: 'single', edge: 'hard', start: { pos: 1, from: 'nose' }, end: { pos: snap(L * 0.33, 1), from: 'nose' }, depth: 0.1875, width: r16(0.62 * W), round: 'nose' }
    : shape === 'straight'
      ? { id, shape, kind: 'double', edge: 'hard', start: { pos: 0, from: 'center' }, end: { pos: 0, from: 'tail' }, depth: 0.125, w1: r16(0.55 * W), w2: r16(0.45 * W), ridge: 2 }
      : { id, shape, kind: 'double', edge: 'rail', start: { pos: snap(L * 0.38, 1), from: 'tail' }, end: { pos: 0, from: 'tail' }, depth: 0.1875,
        outer: [[0, r16(0.5 * W)], [0.55, r16(0.4 * W)], [1, r16(0.62 * W)]], inner: [[0, 2.5], [1, 3.5]] };
  (P.tools ||= []).push(t);
  state.tool = id;
  if (!prefs.edit) { prefs.edit = true; savePrefs(); syncPanelTools(); }
  toolsChanged(true);
}
function buildToolsBox() {
  const box = document.createElement('div');
  box.className = 'tools-box';
  box.innerHTML = `<div class="bottom-head">Concave tools <small>hard edges</small></div>
    <div class="tool-cards"></div>
    <div class="bottom-actions"><button class="ghost" data-shape="teardrop" title="A nose concave for noseriding: round at the nose, tapering toward the tail">+ Tear drop</button><button class="ghost" data-shape="straight" title="Straight hard edges, parallel or converging">+ Straight edges</button><button class="ghost" data-shape="venturi" title="Curved hard edges you shape with points, like a Bonzer's double concaves">+ Venturi</button></div>
    <div class="help">A tool lays a concave with hard edges over the bottom contours. Shape it on the Plan graph: drag the diamonds to move its ends and the dots to move its edges.</div>`;
  toolsUI.cards = box.querySelector('.tool-cards');
  box.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => newTool(b.dataset.shape)));
  return box;
}
function renderTools() {
  const P = state.params, box = toolsUI.cards;
  if (!box) return;
  box.innerHTML = '';
  for (const t of P.tools || []) {
    const el = document.createElement('div');
    el.className = 'tcard' + (state.tool === t.id ? ' on' : '');
    const opt = (o) => Object.entries(o).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    el.innerHTML = `<div class="trow top"><select class="shape" aria-label="Shape">${opt(TOOL_SHAPES)}</select><select class="kind" aria-label="Single or double">${opt({ single: 'Single', double: 'Double' })}</select><button class="x" title="Remove this concave" aria-label="Remove">×</button></div>
      <div class="trow where"><span>from</span><input class="cell p1" spellcheck="false" aria-label="Starts, inches"><span>″</span><select class="f1" aria-label="Measured from">${FROM_LONG}</select></div>
      <div class="trow where"><span>until</span><input class="cell p2" spellcheck="false" aria-label="Ends, inches"><span>″</span><select class="f2" aria-label="Measured from">${FROM_LONG}</select></div>
      <div class="trow nums">
        <label>deep<input class="cell n" data-k="depth" spellcheck="false"></label>
        <label data-for="teardrop">widest<input class="cell n" data-k="width" spellcheck="false"></label>
        <label data-for="teardrop">round end<select class="round">${opt({ nose: 'nose', tail: 'tail' })}</select></label>
        <label data-for="straight">nose end<input class="cell n" data-k="w1" spellcheck="false"></label>
        <label data-for="straight">tail end<input class="cell n" data-k="w2" spellcheck="false"></label>
        <label data-for="ridge">ridge<input class="cell n" data-k="ridge" spellcheck="false"></label>
        <label data-for="double">edges<select class="edge">${opt({ hard: 'hard both sides', rail: 'hard on the rail side' })}</select></label>
      </div>
      <div class="trow where"><span>center</span><select class="center" aria-label="Center line" title="How deep the concave is along the stringer">${opt({ blend: 'blended: deepest spot + blends', flat: 'flat: straight from end to end', custom: 'custom: points on the Profile graph' })}</select></div>
      <div class="trow where blendonly"><span>deepest</span><input class="cell p3" spellcheck="false" aria-label="Deepest at, inches"><span>″</span><select class="f3" aria-label="Measured from">${FROM_LONG}</select></div>
      <div class="trow blends blendonly">${BLEND_ROW}</div>
      <div class="trow foot"><button class="ghost edit"></button><span class="angle"></span></div>`;
    const q = (sel) => el.querySelector(sel);
    const paint = () => {
      const made = state.board?.params.tools?.find((m) => m.id === t.id);      // as the board has it (worked-out values)
      q('.shape').value = t.shape; q('.kind').value = t.kind; q('.round').value = t.round || 'nose'; q('.edge').value = t.edge || 'hard';
      paintDeep(q, t, made, state.board?.params.length);
      q('.center').value = t.center || 'blend';
      for (const el2 of el.querySelectorAll('.blendonly')) el2.hidden = (t.center || 'blend') !== 'blend';
      q('.p1').value = fracIn(showPos(t.start)); q('.f1').value = fromKey(t.start);
      q('.p2').value = fracIn(showPos(t.end)); q('.f2').value = fromKey(t.end);
      for (const inp of el.querySelectorAll('.n')) inp.value = Number.isFinite(t[inp.dataset.k]) ? fracIn(t[inp.dataset.k], inp.dataset.k === 'depth' ? 32 : 16) : '';
      if (t.shape !== 'straight' && made?.outer && document.activeElement !== q('[data-k="width"]')) q('[data-k="width"]').value = fracIn(2 * Math.max(...made.outer.Y));
      const dbl = t.kind === 'double';
      for (const lab of el.querySelectorAll('[data-for]')) {
        const f = lab.dataset.for;
        lab.hidden = f === 'double' ? !dbl : f === 'ridge' ? !(dbl && t.shape === 'straight') : f !== t.shape;
      }
      q('.edit').textContent = state.tool === t.id ? 'Done shaping' : 'Shape it on the Plan graph';
      let ang = '';
      if (t.shape === 'straight' && state.board) {
        const L = state.board.params.length, len = Math.abs(posToX(t.start, L) - posToX(t.end, L)) || 1;
        const a1 = posToX(t.start, L) >= posToX(t.end, L), w1 = a1 ? t.w1 : t.w2, w2 = a1 ? t.w2 : t.w1;
        const deg = (Math.atan(Math.abs(w1 - w2) / 2 / len) * 180) / Math.PI;
        ang = deg < 0.2 ? 'edges parallel' : `edges ${w1 > w2 ? 'converge' : 'spread'} ${deg.toFixed(1)}° each side toward the tail`;
      } else if (t.shape === 'venturi') ang = 'curved edges: shape them on the Plan graph';
      q('.angle').textContent = ang;
    };
    paint();
    for (const inp of el.querySelectorAll('input')) {
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
    const posBox = (sel, end) => q(sel).addEventListener('change', () => { const v = parseVal(q(sel).value); if (Number.isFinite(v)) setPos(t[end], clip(Math.abs(v), 0, 240)); paint(); toolsChanged(false); });
    posBox('.p1', 'start'); posBox('.p2', 'end');
    q('.f1').addEventListener('change', () => { setFrom(t.start, q('.f1').value); paint(); toolsChanged(false); });
    q('.f2').addEventListener('change', () => { setFrom(t.end, q('.f2').value); paint(); toolsChanged(false); });
    for (const inp of el.querySelectorAll('.n')) inp.addEventListener('change', () => {
      const v = parseVal(inp.value), k = inp.dataset.k;
      const made = state.board?.params.tools?.find((m) => m.id === t.id);
      if (Number.isFinite(v) && k === 'width' && made?.outer) {              // the widest: scale the whole edge to it
        const now = 2 * Math.max(...made.outer.Y), f = now > 0 ? Math.abs(v) / now : 1;
        if (!Array.isArray(t.outer)) t.outer = made.outer.pts.map((pq) => [...pq]);
        for (const pq of t.outer) { pq[1] *= f; if (Number.isFinite(pq[3])) pq[3] *= f; if (Number.isFinite(pq[4])) pq[4] *= f; }
        t.width = Math.abs(v);
      } else if (Number.isFinite(v)) t[k] = clip(Math.abs(v), 0, k === 'depth' ? 0.75 : 40);
      paint(); toolsChanged(false);
    });
    wireDeep(q, t, paint, () => toolsChanged(false));
    q('.shape').addEventListener('change', () => {               // a new shape starts from that shape's own defaults, at the same spot
      const keep = { id: t.id, kind: t.kind, start: t.start, end: t.end, depth: t.depth, edge: t.edge };
      const W = have('width'), r16 = (v) => Math.round(v * 16) / 16, sh = q('.shape').value;
      for (const k of Object.keys(t)) delete t[k];
      Object.assign(t, keep, { shape: sh }, sh === 'teardrop' ? { width: r16(0.62 * W), round: 'nose' } : sh === 'straight' ? { w1: r16(0.55 * W), w2: r16(0.45 * W), ridge: 2 }
        : { outer: [[0, r16(0.5 * W)], [0.55, r16(0.4 * W)], [1, r16(0.62 * W)]], inner: [[0, 2.5], [1, 3.5]] });
      state.toolPt = null;
      paint(); toolsChanged(false);
    });
    q('.kind').addEventListener('change', () => { t.kind = q('.kind').value; paint(); toolsChanged(false); });
    q('.center').addEventListener('change', () => {
      const c = q('.center').value, k = state.board?.params.tools.findIndex((m) => m.id === t.id);
      if (c === 'custom' && !(Array.isArray(t.cpts) && t.cpts.length >= 2) && k >= 0) {      // start from the line it has now
        const cl = toolCenterLine(state.board, k, 4);
        t.cpts = cl.pts.map((pt) => [+((cl.tool.x1 - pt.x) / cl.tool.len).toFixed(4), +pt.depth.toFixed(4)]);
      }
      t.center = c;
      if (c === 'custom') { state.tool = t.id; if (!prefs.edit) { prefs.edit = true; savePrefs(); syncPanelTools(); } }
      paint(); toolsChanged(true);
    });
    q('.round').addEventListener('change', () => {                // a fresh tear drop turned the other way, the same width
      const made = state.board?.params.tools?.find((m) => m.id === t.id);
      if (made?.outer) t.width = 2 * Math.max(...made.outer.Y);
      t.round = q('.round').value; delete t.outer; delete t.inner; delete t.deep; state.toolPt = null;
      toolsChanged(false);
    });
    q('.edge').addEventListener('change', () => { t.edge = q('.edge').value; toolsChanged(false); });
    q('.x').addEventListener('click', () => { dropFrom(P.tools, t); if (state.tool === t.id) state.tool = null; toolsChanged(true); });
    q('.edit').addEventListener('click', () => {
      state.tool = state.tool === t.id ? null : t.id;
      if (state.tool && !prefs.edit) { prefs.edit = true; savePrefs(); syncPanelTools(); }
      renderTools(); drawPanels();
    });
    el._paint = paint;
    box.appendChild(el);
  }
}
/** Keep the boxes' numbers current while shapes are dragged on the graph (without rebuilding them). */
function syncTools() { toolsUI.cards?.querySelectorAll('.tcard').forEach((c) => { if (!c.contains(document.activeElement)) c._paint?.(); }); }

/** The concave tools on the Plan graph (seen through the board from above). The one being shaped gets handles. */
function drawTools(v, ctx, data) {
  const P = state.params, tools = data.params.tools || [], L = data.params.length, W = data.params.width;
  let editing = null;
  for (let k = 0; k < tools.length; k++) {
    const o = toolOutline(data, k); if (!o) continue;
    const sel = state.tool !== null && o.tool.id === state.tool, pts = o.pts.filter((q) => q.e > 0.05);
    if (!pts.length) continue;
    ctx.save();
    ctx.strokeStyle = TOOL_COL; ctx.lineWidth = sel ? 1.6 : 1; ctx.globalAlpha = state.tool !== null && !sel ? 0.4 : 0.9;
    if (!sel) ctx.setLineDash([4, 3]);
    for (const sgn of [1, -1]) {
      v.path(ctx, pts.map((q) => q.x), pts.map((q) => sgn * q.e)); ctx.stroke();
      if (o.tool.kind === 'double') { v.path(ctx, pts.map((q) => q.x), pts.map((q) => sgn * q.r)); ctx.stroke(); }
    }
    const xs = [...pts.map((q) => q.x), ...[...pts].reverse().map((q) => q.x)];
    v.path(ctx, xs, [...pts.map((q) => q.e), ...[...pts].reverse().map((q) => (o.tool.kind === 'double' ? q.r : -q.e))], true);
    ctx.fillStyle = 'rgba(126,200,255,0.10)'; ctx.fill();
    if (o.tool.kind === 'double') { v.path(ctx, xs, [...pts.map((q) => -q.e), ...[...pts].reverse().map((q) => -q.r)], true); ctx.fill(); }
    ctx.restore();
    if (sel) editing = o;
  }
  if (!editing || !prefs.edit) return false;
  const tool = editing.tool, raw = rawTool(tool.id);
  if (!raw) return false;
  const frontIsStart = posToX(raw.start, L) >= posToX(raw.end, L);
  const setX = (end, wx) => { const x = clip(snap(wx, 0.25), -24, L + 24), r = raw[end]; r.pos = r.from === 'nose' ? L - x : r.from === 'center' ? x - L / 2 : x; };
  const H = [];                                          // this tool's handles
  const pt = (h) => { v.point(ctx, { ...h, tool: true }); };
  pt({ x: tool.x1, y: 0, kind: 'slice', color: TOOL_COL, drag: (wx) => setX(frontIsStart ? 'start' : 'end', wx) });
  pt({ x: tool.x0, y: 0, kind: 'slice', color: TOOL_COL, drag: (wx) => setX(frontIsStart ? 'end' : 'start', wx) });
  const yOf = (wy) => Math.abs(wy);
  // the deepest spot: a small triangle on the stringer, dragged along the board
  pt({ x: tool.xd, y: 0, kind: 'scrub', color: COLORS.sand, drag: (wx) => {
    const x = clip(snap(wx, 0.25), tool.x0, tool.x1);
    raw.deep = x > L / 2 ? { pos: L - x, from: 'nose' } : { pos: x, from: 'tail' };
  } });
  if (tool.shape === 'straight') {
    const [kf, kb] = frontIsStart ? ['w1', 'w2'] : ['w2', 'w1'];
    pt({ x: tool.x1, y: tool[frontIsStart ? 'w1' : 'w2'] / 2, kind: 'anchor', color: TOOL_COL, drag: (wx, wy) => { raw[kf] = clip(2 * yOf(wy), 0.5, 2 * W); } });
    pt({ x: tool.x0, y: tool[frontIsStart ? 'w2' : 'w1'] / 2, kind: 'anchor', color: TOOL_COL, drag: (wx, wy) => { raw[kb] = clip(2 * yOf(wy), 0.5, 2 * W); } });
    if (tool.kind === 'double') pt({ x: (tool.x0 + tool.x1) / 2, y: tool.ridge / 2, kind: 'anchor', color: TOOL_COL2, drag: (wx, wy) => { raw.ridge = clip(2 * yOf(wy), 0, W); } });
  } else {
    // tear drop and venturi: points along each edge, with arms like the outline's. A point is
    // [t, width, angle, left arm, right arm]; t runs 0 at the nose end to 1 at the tail end.
    const edges = [['outer', TOOL_COL, tool.outer]];
    if (tool.kind === 'double' && (tool.inner || tool.shape === 'venturi')) edges.push(['inner', TOOL_COL2, tool.inner]);
    else if (tool.kind === 'double' && tool.shape === 'teardrop')
      v.text(ctx, 'the ridge of a double tear drop follows its edge', v.X((tool.x0 + tool.x1) / 2), v.Y(0) + 14, TOOL_COL2);
    const len = tool.len, X = (q) => tool.x1 - q[0] * len;
    for (const [key, col, tab] of edges) {
      if (!tab) continue;
      if (!Array.isArray(raw[key]) || raw[key].some((q) => q.length < 2)) raw[key] = tab.pts.map((q) => [...q]);
      const arr = raw[key].sort((a, b) => a[0] - b[0]);
      arr.forEach((a, i) => {
        const end = i === 0 || i === arr.length - 1, lo = i > 0 ? arr[i - 1][0] + 0.02 : 0, hi = i < arr.length - 1 ? arr[i + 1][0] - 0.02 : 1;
        pt({ x: X(a), y: a[1] / 2, kind: 'anchor', color: col, on: state.toolPt === a, select: () => { state.toolPt = a; },
          drag: (wx, wy) => { if (!end) a[0] = clip((tool.x1 - wx) / len, lo, hi); a[1] = clip(2 * yOf(wy), 0, 2 * W); },
          remove: end || arr.length <= 2 ? null : () => dropFrom(arr, a) });
        if (state.toolPt !== a) return;
        // its arms: one direction (so the edge stays smooth), each side its own length
        const tabPt = tab.pts.find((q) => Math.abs(q[0] - a[0]) < 1e-6) || a;
        const gapL = i > 0 ? (a[0] - arr[i - 1][0]) * len : 0, gapR = i < arr.length - 1 ? (arr[i + 1][0] - a[0]) * len : 0;
        const ang = Number.isFinite(a[2]) ? a[2] : (() => {           // automatic: along the curve there
          const k = tab.X.findIndex((xx) => xx >= a[0] * len), j = clip(k, 1, tab.X.length - 1);
          return Math.atan2(tab.Y[j] - tab.Y[j - 1], Math.max(tab.X[j] - tab.X[j - 1], 1e-6)) * 180 / Math.PI;
        })();
        const th = (ang * Math.PI) / 180, px = X(a), py = a[1] / 2;
        for (const side of [-1, 1]) {
          const gap = side < 0 ? gapL : gapR;
          if (!(gap > 0)) continue;
          const len0 = Number.isFinite(a[side < 0 ? 3 : 4]) ? a[side < 0 ? 3 : 4] : gap / 3;
          const ex = px - side * len0 * Math.cos(th), ey = py + side * len0 * Math.sin(th);
          v.point(ctx, { x: ex, y: ey, kind: 'arm', color: col, ax: px, ay: py, tool: true,
            drag: (wx, wy) => {
              const dX = -(wx - px) * side, dY = (yOf(wy) - py) * side;          // back along the tool's own direction
              if (Math.hypot(dX, dY) < 0.05) return;
              while (a.length < 5) a.push(null);
              a[2] = clip(Math.atan2(dY, Math.max(dX, 0)) * 180 / Math.PI, -90, 90);
              a[side < 0 ? 3 : 4] = clip(Math.hypot(wx - px, yOf(wy) - py), 0.05, 0.98 * gap);
            },
            remove: () => { a.length = 2; } });
        }
        void tabPt;
      });
      const ys = editing.pts.map((q) => (key === 'outer' ? q.e : q.r)), xs2 = editing.pts.map((q) => q.x);
      H.push({
        dist: (wx, wy) => { let best = Infinity; for (let i = 0; i < xs2.length; i++) best = Math.min(best, Math.hypot(v.X(xs2[i]) - v.X(wx), v.Y(ys[i]) - v.Y(Math.abs(wy)))); return best; },
        add: (wx, wy) => {
          const a = [clip((tool.x1 - wx) / len, 0.02, 0.98), clip(2 * yOf(wy), 0, 2 * W)];
          arr.push(a); state.toolPt = a;
          return { fn: (x, y) => { a[0] = clip((tool.x1 - x) / len, 0.02, 0.98); a[1] = clip(2 * yOf(y), 0, 2 * W); }, undo: () => dropFrom(arr, a) };
        },
      });
    }
  }
  v.handles = v.handles.filter((h) => h.tool);           // while a tool is being shaped, only its own handles answer
  v.curves = H;
  return true;
}

/** Concave tools on the Profile graph: each one's center line (the stringer, lifted by the concave).
 *  A custom one being shaped gets points: drag them up or down (deeper or shallower) and along;
 *  the line runs straight between points, so each point is a kink. Returns true while shaping it. */
function drawToolCenters(v, ctx, data) {
  const tools = data.params.tools || [];
  let shaping = null;
  for (let k = 0; k < tools.length; k++) {
    const cl = toolCenterLine(data, k); if (!cl || !cl.pts.length) continue;
    const sel = state.tool !== null && cl.tool.id === state.tool;
    ctx.save(); ctx.strokeStyle = TOOL_COL; ctx.lineWidth = sel ? 1.6 : 1; ctx.globalAlpha = sel ? 1 : 0.6;
    if (!sel) ctx.setLineDash([4, 3]);
    v.path(ctx, cl.pts.map((q) => q.x), cl.pts.map((q) => q.zb + q.depth)); ctx.stroke(); ctx.restore();
    if (sel && cl.tool.center === 'custom' && prefs.edit) shaping = cl;
  }
  if (!shaping) return false;
  const tool = shaping.tool, raw = rawTool(tool.id), pr = data._profiles;
  if (!raw) return false;
  const zbAt = (xq) => lerpAt(pr.x, pr.zb, xq), X = (t) => tool.x1 - t * tool.len;
  if (!Array.isArray(raw.cpts) || raw.cpts.length < 2) raw.cpts = tool.cpts.map((q) => [...q]);
  const arr = raw.cpts.sort((a, b) => a[0] - b[0]);
  arr.forEach((a, i) => {
    const lo = i > 0 ? arr[i - 1][0] + 0.01 : 0, hi = i < arr.length - 1 ? arr[i + 1][0] - 0.01 : 1, end = i === 0 || i === arr.length - 1;
    const x = clip(X(a[0]), 0, data.params.length);
    v.point(ctx, { x, y: zbAt(x) + a[1], kind: 'anchor', color: TOOL_COL, tool: true,
      drag: (wx, wy) => { if (!end) a[0] = clip((tool.x1 - wx) / tool.len, lo, hi); const xx = clip(X(a[0]), 0, data.params.length); a[1] = clip(+(wy - zbAt(xx)).toFixed(4), 0, 0.75); },
      remove: end || arr.length <= 2 ? null : () => dropFrom(arr, a) });
  });
  const cx = shaping.pts.map((q) => q.x), cy = shaping.pts.map((q) => q.zb + q.depth);
  v.handles = v.handles.filter((h) => h.tool);           // only this line's points answer while shaping it
  v.curves = [{
    dist: (wx, wy) => { let best = Infinity; for (let i = 0; i < cx.length; i++) best = Math.min(best, Math.hypot(v.X(cx[i]) - v.X(wx), v.Y(cy[i]) - v.Y(wy))); return best; },
    add: (wx, wy) => {
      const a = [clip((tool.x1 - wx) / tool.len, 0.01, 0.99), clip(wy - zbAt(wx), 0, 0.75)];
      arr.push(a);
      return { fn: (x2, y2) => { a[0] = clip((tool.x1 - x2) / tool.len, 0.01, 0.99); a[1] = clip(y2 - zbAt(clip(x2, 0, data.params.length)), 0, 0.75); }, undo: () => dropFrom(arr, a) };
    },
  }];
  v.text(ctx, 'concave center line: drag points up (deeper) or down · click the line to add a point (each one is a kink)', v.X(data.params.length / 2), v.Y(Math.max(...cy)) - 18, TOOL_COL);
  return true;
}
/* Sliders for the cross section picked in the Sections graph. They show that section's own
   deck dome, rails and bottom; moving one changes the board there and blends out toward
   the neighbouring sections and the tips. The board-wide Rails and Bottom sliders still
   set the starting point for every section. */
const SECTION_SLIDERS = [
  ['deck_dome', 'Deck dome', 0, 1, 0.01, 'frac', '0 = flat deck, 1 = strongly domed'],
  ['rail_fullness', 'Rail fullness', 0, 1, 0.01, 'frac', 'how much foam the rail carries'],
  ['rail_apex_in', 'Rail apex height', 0.125, 2, 0.0625, 'in', 'up from the flat bottom line'],
  ['rail_tuck_in', 'Rail tuck', 0, 4, 0.0625, 'in', 'inches in from the apex to the flat bottom (or drag the edge point)'],
  ['edge', 'Edge', 0, 1, 0.01, 'frac', '0 = soft (meets the bottom smoothly), 1 = hard corner'],
  ['concave', 'Single concave', -0.5, 0.5, 0.01, 'in', 'below zero = roll (convex)'],
  ['double', 'Double concave', 0, 0.5, 0.01, 'in', ''],
  ['vee', 'Vee', 0, 0.5, 0.01, 'in', ''],
];
const sectionUI = { rows: {} };
const rawSlice = () => state.params.slices.find((q) => q.id === state.sel);

function sliderRow(label, min, max, step, unit, help, onInput) {
  const el = document.createElement('div');
  el.className = 'field';
  el.innerHTML = `<div class="row"><label>${label}</label><input class="val" type="text" spellcheck="false"></div>
    <input type="range" min="${min}" max="${max}" step="${step}">${help ? `<div class="help">${help}</div>` : ''}`;
  const r = el.querySelector('input[type=range]'), t = el.querySelector('.val');
  const set = (v) => { r.value = v; t.value = fmt(v, unit); r.style.setProperty('--pct', `${((v - r.min) / (r.max - r.min)) * 100}%`); };
  const fire = (v) => { v = Math.min(Math.max(v, +r.min), +r.max); set(v); onInput(v); saveLocal(); schedule(); };
  r.addEventListener('input', () => fire(parseFloat(r.value)));
  t.addEventListener('focus', () => t.select());
  t.addEventListener('change', () => { const v = parseVal(t.value); if (Number.isFinite(v)) fire(v); else set(parseFloat(r.value)); });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter') t.blur(); });
  return { el, set, range: r };
}

function buildSectionGroup() {
  const det = document.createElement('details');
  det.className = 'group section-group';
  det.id = 'section-group';
  det.hidden = true;
  det.open = true;
  det.innerHTML = `<summary>Cross section</summary><div class="fields"><div class="help" id="sec-title"></div></div>`;
  const body = det.querySelector('.fields');
  const done = document.createElement('button');
  done.className = 'primary';
  done.textContent = 'Done with this section';
  done.addEventListener('click', () => exitSection());
  body.appendChild(done);
  sectionUI.pos = sliderRow('Position from tail', 2, 70, 0.25, 'in', 'or drag its diamond in the Plan graph', (v) => { const s = rawSlice(); if (s) s.x = v; });
  body.appendChild(sectionUI.pos.el);
  for (const [key, label, min, max, step, unit, help] of SECTION_SLIDERS) {
    const row = sliderRow(label, min, max, step, unit, help, (v) => {
      const s = rawSlice(); if (!s) return;
      s.adj[key] = v - sectionBase(state.board.params, s.x)[key];      // stored as a change from the board-wide value
    });
    sectionUI.rows[key] = row;
    body.appendChild(row.el);
  }
  const reset = document.createElement('button');
  reset.className = 'ghost';
  reset.textContent = 'Reset this section to the board settings';
  reset.addEventListener('click', () => { const s = rawSlice(); if (s) { s.adj = {}; saveLocal(); schedule(); } });
  body.appendChild(reset);
  sectionUI.el = det;
  return det;
}

function refreshSectionGroup(data) {
  const k = sliceIndex(data), det = sectionUI.el;
  det.hidden = k < 0;
  if (k < 0) { sectionUI.shown = null; return; }
  const s = sliceInfo(data, k), L = data.params.length;
  $('#sec-title').textContent = `${s.x > L / 2 ? `${fracIn(L - s.x)}″ from the nose` : `${fracIn(s.x)}″ from the tail`}: ${fracIn(2 * s.h)}″ wide, ${fracIn(s.t)}″ thick. These sliders shape the board here and blend out toward the next sections and the tips.`;
  sectionUI.pos.range.max = L - 2;
  sectionUI.pos.set(s.x);
  for (const [key, , min, max] of SECTION_SLIDERS) sectionUI.rows[key].set(Math.min(Math.max(s.base[key] + s.adj[key], min), max));
  if (sectionUI.shown !== s.id) { sectionUI.shown = s.id; det.open = true; det.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

/** Wire a text box to a parameter. Blank means "work it out for me" where that is allowed. */
function bindCell(inp, key, step) {
  const nullable = NULLABLE.includes(key);
  const set = (v) => { inp.value = v === null || v === undefined ? '' : fracIn(v); };
  const commit = (v) => { set(v); setParam(key, v, 'cell'); };
  const current = () => state.params[key] ?? state.board?.params[key];
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('change', () => {
    const raw = inp.value.trim().toLowerCase();
    if (raw === '' || raw === 'auto') {
      if (nullable) commit(null);
      else { set(state.params[key]); toast('That measurement is needed to build the board.'); }
      return;
    }
    const v = parseVal(raw);
    if (Number.isFinite(v)) commit(v); else set(state.params[key]);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(+(current() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 8 : 1)).toFixed(5));
    }
  });
  state.cellEls[key] = { set, auto: (resolved) => { inp.placeholder = nullable ? `~${fracIn(resolved)}` : ''; } };
}

function makeField(f) {
  const el = document.createElement('div');
  el.className = 'field';
  const type = f.type || 'range';

  if (type === 'bool') {
    el.innerHTML = `<label class="toggle"><input type="checkbox"><span>${f.label}</span></label>`;
    const cb = el.querySelector('input');
    cb.addEventListener('change', () => setParam(f.key, cb.checked, 'field'));
    state.fieldEls[f.key] = { f, el, set: (v) => (cb.checked = !!v) };
  } else if (type === 'select') {
    el.innerHTML = `<div class="row"><label>${f.label}</label></div>
      <select>${f.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}</select>`;
    const sel = el.querySelector('select');
    sel.addEventListener('change', () => setParam(f.key, sel.value, 'field'));
    state.fieldEls[f.key] = { f, el, set: (v) => (sel.value = v) };
  } else {
    el.innerHTML = `<div class="row"><label>${f.label}</label><input class="val" type="text" spellcheck="false"></div>
      <input type="range" min="${f.min}" max="${f.max}" step="${f.step}">
      ${f.help ? `<div class="help">${f.help}</div>` : ''}<div class="note" hidden></div>`;
    const r = el.querySelector('input[type=range]');
    const t = el.querySelector('.val');
    const paint = (v) => r.style.setProperty('--pct', `${((v - f.min) / (f.max - f.min)) * 100}%`);
    const nullable = NULLABLE.includes(f.key);
    const current = () => state.params[f.key] ?? state.board?.params[f.key];
    const set = (v) => {
      el.classList.toggle('is-auto', v === null || v === undefined);
      if (v === null || v === undefined) { t.value = 'auto'; return; }
      r.value = v; t.value = fmt(v, f.unit); paint(v);
    };
    const auto = (resolved) => { if (state.params[f.key] === null) { r.value = resolved; paint(resolved); t.title = `worked out: ${fmt(resolved, f.unit)}`; } else t.title = ''; };
    r.addEventListener('input', () => { const v = parseFloat(r.value); set(v); setParam(f.key, v, 'slider'); });
    t.addEventListener('focus', () => t.select());
    t.addEventListener('change', () => {
      const raw = t.value.trim().toLowerCase();
      if (nullable && (raw === '' || raw === 'auto')) { set(null); setParam(f.key, null, 'field'); return; }
      const v = parseVal(raw);
      if (Number.isFinite(v)) { set(v); setParam(f.key, v, 'field'); } else set(state.params[f.key]);
    });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') t.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = +(current() + (e.key === 'ArrowUp' ? 1 : -1) * f.step * (e.shiftKey ? 8 : 1)).toFixed(5);
        set(v); setParam(f.key, v, 'field');
      }
    });
    state.fieldEls[f.key] = { f, el, set, auto, note: el.querySelector('.note') };
  }
  return el;
}

const isShown = (f) => !f.show_if || Object.entries(f.show_if).every(([k, cond]) =>
  Array.isArray(cond) ? cond.includes(state.params[k]) : state.params[k] === cond);

function updateVisibility() {
  for (const { f, el } of Object.values(state.fieldEls)) el.classList.toggle('hidden', !isShown(f));
  for (const k of ['concave_depth', 'vee_depth']) state.fieldEls[k]?.el.classList.toggle('hidden', !!state.params.bottom?.length);   // contour stations take over
  // table cells whose value is set by the nose / tail type show that type instead of a number
  for (const m of state.mirrors) {
    const editable = !!m.key && isShown(state.fieldEls[m.key].f);
    if (m.inp) m.inp.hidden = !editable;
    m.span.hidden = editable;
    m.span.textContent = String(state.params[m.mirror]).replace(/_/g, ' ');
  }
}

// Dragging a slider keeps a curve's shape: the 12" station follows the end it belongs to.
// Typing a number (in the table or next to a slider) is literal and moves nothing else.
// A blank 12" value follows on its own, so only explicit ones are moved.
const have = (k) => state.params[k] ?? state.board?.params[k];
const foil12 = (side, T0, e0, T1, e1) => {
  const k = `${side}_thickness_12`, v = state.params[k];
  return v !== null && T0 - e0 > 1e-6 ? { [k]: e1 + ((v - e0) / (T0 - e0)) * (T1 - e1) } : {};
};
const rocker12 = (side, o, n) => {
  const k = `${side}_rocker_12`, v = state.params[k];
  return v === null ? {} : { [k]: o > 1e-6 ? (v * n) / o : 0.42 * n };
};
const LINKS = {
  nose_rocker: (o, n) => rocker12('nose', o, n),
  tail_rocker: (o, n) => rocker12('tail', o, n),
  thickness: (o, n) => ({ ...foil12('nose', o, have('nose_thickness'), n, have('nose_thickness')), ...foil12('tail', o, have('tail_thickness'), n, have('tail_thickness')) }),
  nose_thickness: (o, n) => foil12('nose', have('thickness'), o, have('thickness'), n),
  tail_thickness: (o, n) => foil12('tail', have('thickness'), o, have('thickness'), n),
};

function showValue(key, v, except) {
  if (except !== 'cell') state.cellEls[key]?.set(v);
  if (except !== 'field') state.fieldEls[key]?.set(v);
}

function setParam(key, v, src) {
  const linked = src === 'slider' && LINKS[key] && state.board ? LINKS[key](have(key), v) : {};
  state.params[key] = v;
  showValue(key, v, src === 'slider' ? 'field' : src);
  for (const [k, lv] of Object.entries(linked)) { state.params[k] = lv; showValue(k, lv); }
  if (key === 'lock_volume' && v && state.board) {   // start the lock from the current volume
    state.params.target_volume = +state.board.stats.volume_l.toFixed(1);
    state.fieldEls.target_volume.set(state.params.target_volume);
  }
  updateVisibility();
  saveLocal();
  schedule();
}

/** Load a whole design (preset, file, saved copy, undo step). Tidies older files as it goes. */
function applyParams(p, keepSel = null) {
  state.params = structuredClone({ ...state.schema.defaults, ...p });
  const P = state.params, a = P.anchors && typeof P.anchors === 'object' ? P.anchors : {};
  railTuckFromOld(P);                                    // designs from before rail tucks (Rail edge 0..1) get tucks in inches
  const num = (v) => (Number.isFinite(v) ? v : null);
  // an anchor is [position, offset] plus, once its handle has been moved, [slope, left arm, right arm]
  const pts = (l) => (Array.isArray(l) ? l : []).filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
    .map((q) => (q.slice(2, 5).some(Number.isFinite) ? [+q[0], +q[1], num(q[2]), num(q[3]), num(q[4])] : [+q[0], +q[1]]));
  P.anchors = { outline: pts(a.outline), rocker: pts(a.rocker), thickness: pts(a.thickness), swallow: pts(a.swallow) };
  const hd3 = (q) => (Array.isArray(q) && q.slice(0, 3).some(Number.isFinite) ? [num(q[0]), num(q[1]), num(q[2])] : null);
  const hs = P.handles && typeof P.handles === 'object' ? P.handles : {};
  P.handles = {};
  for (const name of ['outline', 'rocker', 'thickness']) {            // handles on the 12" and center markers
    P.handles[name] = {};
    for (const key of ['tail', 'tail12', 'origin', 'nose12', 'nose']) { const q = hd3(hs[name]?.[key]); if (q) P.handles[name][key] = q; }
  }
  { const q = hd3(hs.swallow?.tail); P.handles.swallow = q ? { tail: q } : {};
  }
  P.marks = (Array.isArray(P.marks) ? P.marks : []).filter((r) => r && Number.isFinite(+r.pos)).map((r) => {      // added measurements
    const m = { pos: +r.pos, from: FROM.includes(r.from) ? r.from : 'tail', width: num(r.width), rocker: num(r.rocker), thickness: num(r.thickness) };
    for (const f of ['hw', 'hr', 'ht']) { const q = hd3(r[f]); if (q) m[f] = q; }
    return m;
  });
  const T = Number.isFinite(P.thickness) ? P.thickness : 2.5;
  if (!Number.isFinite(P.rail_apex_in))        // older designs gave the rail apex as a fraction of thickness
    P.rail_apex_in = clip(snap((Number.isFinite(P.rail_apex) ? P.rail_apex : 0.35) * T, 0.0625), 0.125, 2);
  const seen = new Set();
  P.slices = (Array.isArray(P.slices) ? P.slices : []).filter((s) => s && Number.isFinite(s.x)).map((s) => {
    let id = Number.isInteger(s.id) && !seen.has(s.id) ? s.id : 1;
    while (seen.has(id)) id++;
    seen.add(id);
    const adj = { ...(s.adj && typeof s.adj === 'object' ? s.adj : {}) };
    if (Number.isFinite(adj.rail_apex) && adj.rail_apex) { adj.rail_apex_in = (adj.rail_apex_in || 0) + adj.rail_apex * T; }
    delete adj.rail_apex;
    if (Number.isFinite(adj.rail_hardness)) { if (adj.rail_hardness) adj.edge = adj.rail_hardness; delete adj.rail_hardness; }   // older sections
    delete adj.rail_tuck;
    return { id, x: s.x, adj, deck: pts(s.deck), bottom: pts(s.bottom), v: s.v === 2 ? 2 : 1 };
  });
  P.bottom = (Array.isArray(P.bottom) ? P.bottom : []).filter((r) => r && Number.isFinite(+r.pos)).map((r) => ({
    pos: +r.pos, from: FROM.includes(r.from) ? r.from : 'tail', type: BOTTOM_LABELS[r.type] ? r.type : 'flat',
    ...(r.to && Number.isFinite(+r.to.pos) ? { to: { pos: +r.to.pos, from: FROM.includes(r.to.from) ? r.to.from : 'tail' } } : {}),
    ...(r.deep && Number.isFinite(+r.deep.pos) ? { deep: { pos: +r.deep.pos, from: FROM.includes(r.deep.from) ? r.deep.from : 'tail' } } : {}),
    ...(Number.isFinite(+r.blendNose) ? { blendNose: clip(+r.blendNose, 0, 1) } : {}), ...(Number.isFinite(+r.blendTail) ? { blendTail: clip(+r.blendTail, 0, 1) } : {}),
    depth: clip(+r.depth || 0, 0, 0.75), depth2: clip(+r.depth2 || 0, 0, 0.75) }));
  const tseen = new Set();
  P.tools = (Array.isArray(P.tools) ? P.tools : []).filter((t) => t && TOOL_SHAPES[t.shape] && t.start && t.end).map((t) => {
    let id = Number.isInteger(t.id) && !tseen.has(t.id) ? t.id : 1;
    while (tseen.has(id)) id++;
    tseen.add(id);
    const at = (r) => ({ pos: Number.isFinite(+r.pos) ? +r.pos : 0, from: FROM.includes(r.from) ? r.from : 'tail' });
    return { ...structuredClone(t), id, start: at(t.start), end: at(t.end) };
  });
  if (!P.tools.some((t) => t.id === state.tool)) state.tool = null;
  state.sel = P.slices.some((s) => s.id === keepSel) ? keepSel : null;
  state.pt = null;
  for (const [k, fe] of Object.entries(state.fieldEls)) fe.set(state.params[k]);
  for (const [k, ce] of Object.entries(state.cellEls)) ce.set(state.params[k]);
  renderBottomTable();
  renderTools();
  renderMarks();
  updateVisibility();
  saveLocal();
  schedule();
}

/**
 * Sections saved before anchor points could go around the rail stored a point's position as a
 * fraction of the half width. They now run by arc length along the line, so move each point
 * to the same place on the board (its handle, if any, goes back to automatic).
 */
function upgradeSlices(data) {
  let changed = false;
  for (const s of state.params.slices) {
    if (s.v === 2) continue;
    if (s.deck.length || s.bottom.length) {
      const sec = sectionAt(data, s.x), w = Math.max(sec.h - sec.yin, 1e-6);
      for (const which of ['deck', 'bottom']) {
        const ln = sec[which];
        for (const q of s[which]) {
          const y = sec.yin + q[0] * w;
          let i = 0;
          while (i < ln.y0.length - 1 && ln.y0[i] < y) i++;
          q[0] = ln.rho[i]; q.length = 2;
        }
      }
      changed = true;
    }
    s.v = 2;
  }
  return changed;
}

/* Undo / redo: a stack of whole designs. Every edit ends in saveLocal(), so that is where a
   step is recorded, a moment after the edit settles (one drag or one slider sweep = one step). */
const hist = { stack: [], i: -1, timer: 0, restoring: false };
function histCommit() {
  clearTimeout(hist.timer); hist.timer = 0;
  const s = JSON.stringify(state.params);
  if (s === hist.stack[hist.i]) return;
  hist.stack.length = hist.i + 1;
  hist.stack.push(s);
  if (hist.stack.length > 150) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  syncHistory();
}
function histGo(dir) {
  if (hist.timer) histCommit();
  const j = hist.i + dir;
  if (j < 0 || j >= hist.stack.length) return;
  hist.i = j;
  hist.restoring = true;
  applyParams(JSON.parse(hist.stack[j]), state.sel);
  hist.restoring = false;
  $('#preset').value = '';
  syncHistory();
}
function syncHistory() {
  $('#btn-undo').disabled = hist.i <= 0;
  $('#btn-redo').disabled = hist.i >= hist.stack.length - 1;
}

const saveLocal = () => {
  try { localStorage.setItem('surfboard.params', JSON.stringify(state.params)); } catch {}
  if (!hist.restoring) { clearTimeout(hist.timer); hist.timer = setTimeout(histCommit, 350); }
};
const loadLocal = () => { try { return JSON.parse(localStorage.getItem('surfboard.params')); } catch { return null; } };

/* =========================================================================
   Rebuild: the geometry runs right here in the browser (docs/geometry.js).
   Changes are coalesced to one rebuild per animation frame so sliders stay smooth.
   ========================================================================= */
function schedule() {
  if (state.busy) return;
  state.busy = true;
  requestAnimationFrame(() => {
    state.busy = false;
    try {
      const board = buildBoard(state.params);
      board.curves = curves(board);
      state.board = board;
      render(board);
    } catch (e) {
      console.error(e);
      $('#warnings').innerHTML = `<span>could not build this board: ${e.message}</span>`;
    }
  });
}

/* =========================================================================
   three.js viewer
   ========================================================================= */
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 2000);
camera.position.set(50, 45, 70);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
const UP = new THREE.Vector3(0, 1, 0);

// Studio lighting: soft key + fill, glossy glassed board.
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 80, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 40, bottom: -40, near: 1, far: 250 });
sun.shadow.radius = 6;
const fill = new THREE.DirectionalLight(0xcfe6ff, 0.7);
fill.position.set(-40, -60, -30);
const studioLights = new THREE.Group().add(sun, fill, new THREE.HemisphereLight(0xdfefff, 0x1a2228, 0.5));

// Shaping-bay lighting: a row of light along each side of the board, level with the rails,
// on a matte blank. The light only grazes the surface, so flat foam stays dim and anything
// that tilts toward either side (deck dome, a concave, a bump in the foil) picks up light
// from the side it faces and falls into shadow from the other, the same on both rails.
// One side is slightly warm and the other slightly cool, so which way a surface tilts
// (concave or vee) can be told apart. The lamps turn over with the board, so the bottom
// keeps its own, lower pair: its contours are a degree or two, far subtler than the deck's.
const bayLights = new THREE.Group();
const bayDeck = [], bayBottom = [];
const bayLamp = (color, x, y, z, set) => {
  const lamp = new THREE.DirectionalLight(color, 1);
  lamp.position.set(x, y, z);
  bayLights.add(lamp, lamp.target);                    // target in the same group: the direction turns with the board
  set?.push(lamp);
  return lamp;
};
// warm on one rail, cool on the other: a concave's halves face across (the colours cross over at the stringer),
// a vee's or a roll's face their own side, and flat foam takes neither
for (const [side, color] of [[1, 0xffd6ad], [-1, 0xb9d3ff]]) {   // tints mixed toward white: still tell-apart, less theatrical
  bayLamp(color, 0, 2.6, 60 * side, bayDeck);          // deck: about 2.5 degrees above level
  bayLamp(color, 0, -0.75, 60 * side, bayBottom);      // bottom: under 1 degree
}
for (const end of [1, -1]) for (const up of [1, -1]) bayLamp(0xf2f6ff, 60 * end, 14 * up, 0).intensity = 0.3;   // a little down the length, for rocker and foil
// organic shading: a soft overhead lamp a little off to one end (like the bay's ceiling light), and a
// sky / floor fill that is brighter from above than below, so the deck rolls off into the rails
// and the bottom sits in its own soft shadow instead of every flat face reading the same
const bayTop = bayLamp(0xfff6ea, 25, 60, 12);
const bayFill = new THREE.HemisphereLight(0xfff8ee, 0x4a5058, 0.05);
bayLights.add(bayFill);
/**
 * How hard the bay lights work. The side lamps make brightness follow the tilt of the
 * surface, which is what shows a contour; the even fill light shows nothing. Low strength =
 * mostly fill, so a mellow contour looks mellow; high = mostly side lamps, which exaggerates
 * every tilt (and the bottom more than the deck, because its contours are slighter).
 */
function setBayGain() {
  const g = clip(prefs.bayGain ?? 0.3, 0, 1);
  for (const lamp of bayDeck) lamp.intensity = 0.5 + 2.9 * g;
  for (const lamp of bayBottom) lamp.intensity = 0.5 + 7.8 * g * g;
  bayTop.intensity = 0.55 - 0.25 * g;
  bayFill.intensity = 0.75 - 0.55 * g;
  viewKey.intensity = 1.4 + 3.2 * g;
  viewFill.intensity = 0.58 - 0.46 * g;
}

// Fixed light: one raking lamp that stays where it is relative to the viewer (up and to the left,
// almost side-on), so the board moves through the light as it is turned, and every contour
// shows as the shading sweeps across it. This is how Shape3D lights a board.
const viewLights = new THREE.Group();
const viewKey = new THREE.DirectionalLight(0xffffff, 2);
viewKey.position.set(-75, 55, 35);                     // in the camera's own frame: left, up, a little toward the viewer (moved with the light pad)
const viewFill = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);
viewLights.add(viewKey, viewKey.target, viewFill);
camera.add(viewLights);
scene.add(camera);
scene.add(studioLights);
const envMap = scene.environment;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.28 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const boardMat = new THREE.MeshPhysicalMaterial({
  color: '#ece6d8', roughness: 0.45, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 0.75,
});
const boardMesh = new THREE.Mesh(new THREE.BufferGeometry(), boardMat);
boardMesh.castShadow = true;
const wireMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());   // only kept for its bounding box
wireMesh.visible = false;
// Skeleton view: the board as ribs (a cross section every 6") on its stringer and rail lines, like a boat frame
const ribs = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7fe6d6, transparent: true, opacity: 0.95 }));
ribs.visible = false;

function buildRibs(data) {
  const { x, h, Y, Z, M } = data._profiles, L = data.params.length, seg = [];
  const P3 = (i, m, side) => [x[i] - L / 2, Z[i * M + m], -side * Y[i * M + m]];
  const line = (p, q) => seg.push(...p, ...q);
  const rows = new Set();
  for (let s = 0; s <= L + 5.999; s += 6) {             // the station nearest every 6" from the tail, and the nose
    const want = Math.min(s, L);
    let b = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - want) < Math.abs(x[b] - want)) b = i;
    rows.add(b);
  }
  for (const i of rows) for (const side of [1, -1]) for (let m = 0; m < M - 1; m++) line(P3(i, m, side), P3(i, m + 1, side));
  const rail = [];                                      // the rail line: the widest part of each section
  for (let i = 0; i < x.length; i++) {
    let top = -Infinity, n = 0, z = 0;
    for (let m = 0; m < M; m++) top = Math.max(top, Y[i * M + m]);
    for (let m = 0; m < M; m++) if (Y[i * M + m] >= top - 0.01) { z += Z[i * M + m]; n++; }
    rail.push([x[i] - L / 2, z / n, h[i] < 1e-6 ? 0 : top]);
  }
  for (let i = 0; i < x.length - 1; i++) for (const side of [1, -1]) {
    for (const m of [0, M - 1]) line(P3(i, m, side), P3(i + 1, m, side));           // stringer, deck and bottom (the cut's edges on a swallow)
    line([rail[i][0], rail[i][1], -side * rail[i][2]], [rail[i + 1][0], rail[i + 1][1], -side * rail[i + 1][2]]);
  }
  ribs.geometry.dispose();
  ribs.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
}

function setWire() {
  ribs.visible = state.wire;
  boardMat.transparent = state.wire; boardMat.opacity = state.wire ? 0.13 : 1; boardMat.depthWrite = !state.wire;
  boardMat.needsUpdate = true;
  $('#t-wire').classList.toggle('on', state.wire);
}
const stringerMat = new THREE.MeshStandardMaterial({ color: COLORS.wood, roughness: 0.6 });
const stringerGroup = new THREE.Group();
// outline of the cross section the Sections view is looking at
const ring = new THREE.LineLoop(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.95, depthTest: false }));
ring.renderOrder = 5;
ring.visible = false;
const boardGroup = new THREE.Group().add(boardMesh, wireMesh, ribs, stringerGroup, ring, bayLights);   // turns over as one for "Bottom up"
scene.add(boardGroup);
let flipNow = 0;                                        // current turn-over angle, eased toward 0 or pi

function placeBoard() {
  const bb = wireMesh.geometry.boundingBox, cy = bb ? (bb.min.y + bb.max.y) / 2 : 0;
  boardGroup.rotation.x = flipNow;                      // turn about the board's own centre line
  boardGroup.position.set(0, cy * (1 - Math.cos(flipNow)), -cy * Math.sin(flipNow));
}

let ringTimer = 0;
/** Show the section outline on the 3D board: while a section is being edited, or briefly while rolling through. */
function showRing(data = state.board, linger = true) {
  if (!data) return;
  const L = data.params.length, pr = data._profiles, k = sliceIndex(data);
  const x = k >= 0 ? data.params.slices[k].x : scrubX(data);
  const s = sectionAt(data, x), o = sectionOutline(s, true, 5), zb = lerpAt(pr.x, pr.zb, x);
  const P = new Float32Array(o.X.length * 3);
  for (let i = 0; i < o.X.length; i++) { P[3 * i] = x - L / 2; P[3 * i + 1] = zb + o.Z[i]; P[3 * i + 2] = -o.X[i]; }
  ring.geometry.dispose();
  ring.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (k >= 0) { clearTimeout(ringTimer); ringTimer = 0; ring.visible = true; return; }
  if (linger) { clearTimeout(ringTimer); ring.visible = true; ringTimer = setTimeout(() => { ringTimer = 0; ring.visible = false; }, 2500); }
  else if (!ringTimer) ring.visible = false;
}

/**
 * The light pad: a disc that stands for the half of the world facing the viewer. The dot is
 * where the fixed light is (centre = straight from behind the viewer, rim = side-on, raking).
 * The ball under it is shaded by that light, so it is easy to see where it falls.
 */
function setLightDir() {
  let [u, w] = Array.isArray(prefs.lightDir) && prefs.lightDir.every(Number.isFinite) ? prefs.lightDir : LIGHT_HOME;
  const r = Math.hypot(u, w);
  if (r > 0.995) { u *= 0.995 / r; w *= 0.995 / r; }
  const z = Math.sqrt(Math.max(0, 1 - u * u - w * w));
  viewKey.position.set(100 * u, 100 * w, 100 * z);
  const pad = $('#lightpad'), lamp = $('#lamp'), ball = $('#lightball');
  lamp.style.left = `${50 + 50 * u}%`; lamp.style.top = `${50 - 50 * w}%`;
  ball.style.background = `radial-gradient(circle at ${50 + 42 * u}% ${50 - 42 * w}%, #fbf7ee 0%, #9aa3a8 ${18 + 30 * z}%, #20272c 78%)`;
  pad.dataset.u = u; pad.dataset.w = w;
}
function wireLightPad() {
  const pad = $('#lightpad');
  let dragging = false;
  const at = (e) => {
    const r = pad.querySelector('.ball').getBoundingClientRect();
    let u = ((e.clientX - r.left) / r.width) * 2 - 1, w = 1 - ((e.clientY - r.top) / r.height) * 2;
    const m = Math.hypot(u, w); if (m > 0.995) { u *= 0.995 / m; w *= 0.995 / m; }
    prefs.lightDir = [+u.toFixed(3), +w.toFixed(3)];
    setLightDir();
  };
  pad.addEventListener('pointerdown', (e) => { dragging = true; try { pad.setPointerCapture(e.pointerId); } catch {} at(e); e.preventDefault(); e.stopPropagation(); });
  pad.addEventListener('pointermove', (e) => { if (dragging) at(e); });
  const end = () => { if (dragging) { dragging = false; savePrefs(); } };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  pad.addEventListener('dblclick', () => { prefs.lightDir = LIGHT_HOME; savePrefs(); setLightDir(); });
}

function setLighting() {
  const bay = prefs.bay;
  const fixed = prefs.fixedLight !== false;
  bayLights.visible = bay && !fixed; viewLights.visible = bay && fixed; studioLights.visible = !bay; ground.visible = !bay;
  scene.environment = bay ? null : envMap;
  Object.assign(boardMat, bay
    ? { roughness: fixed ? 0.7 : 0.95, clearcoat: 0, envMapIntensity: 0 }
    : { roughness: 0.45, clearcoat: 0.9, envMapIntensity: 0.75 });
  boardMat.color.set(bay ? '#f4f1ea' : '#ece6d8');
  boardMat.needsUpdate = true;
  renderer.toneMappingExposure = bay ? 1.0 : 0.92;
  setBayGain();
  $('#bay-gain').hidden = !bay;
  $('#bay-gain').value = prefs.bayGain ?? 0.3;
  $('#t-fixed').hidden = !bay;
  $('#t-fixed').classList.toggle('on', fixed);
  $('#lightpad').hidden = !(bay && fixed);
  setLightDir();
  viewport.classList.toggle('bay', bay);
  $('#t-light').classList.toggle('on', bay);
}

// board space (x along, y across, z up) -> three space (X along, Y up, Z across), centered on length
const toThree = (x, y, z, L) => [x - L / 2, z, -y];

/**
 * Smooth shading within each patch of the board's surface (deck, rail below the apex, flat
 * bottom, notch walls, end caps), creased exactly where two patches meet. A soft rail's patches
 * meet smoothly, so no line shows; a hard edge stays crisp the whole length. (An angle test
 * would switch the crease on and off along the board as the edge softens, drawing a false line.)
 */
function patchNormals(P, idx, patches) {
  const nv = P.length / 3, K5 = 5, acc = new Float32Array(nv * K5 * 3);
  const nf = idx.length / 3, fn = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f] * 3, b = idx[3 * f + 1] * 3, c = idx[3 * f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;     // area weighted
    fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
    const k = patches[f];
    for (let j = 0; j < 3; j++) { const o = (idx[3 * f + j] * K5 + k) * 3; acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; }
  }
  const pos = new Float32Array(nf * 9), nor = new Float32Array(nf * 9);
  for (let f = 0; f < nf; f++) for (let j = 0; j < 3; j++) {
    const v = idx[3 * f + j], o = (v * K5 + patches[f]) * 3, q = 9 * f + 3 * j;
    pos[q] = P[3 * v]; pos[q + 1] = P[3 * v + 1]; pos[q + 2] = P[3 * v + 2];
    let nx = acc[o], ny = acc[o + 1], nz = acc[o + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nor[q] = nx / l; nor[q + 1] = ny / l; nor[q + 2] = nz / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function updateMesh(data) {
  const L = data.params.length;
  const pos = data.vertices;
  const idx = data.faces;
  const P = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    P[i] = pos[i] - L / 2; P[i + 1] = pos[i + 2]; P[i + 2] = -pos[i + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();

  boardMesh.geometry.dispose();
  boardMesh.geometry = data.patches ? patchNormals(P, idx, data.patches) : toCreasedNormals(g, THREE.MathUtils.degToRad(40));
  wireMesh.geometry.dispose();
  wireMesh.geometry = g;
  buildRibs(data);
  ground.position.y = g.boundingBox.min.y - 0.02;

  // wood stringer on deck and bottom
  stringerGroup.children.forEach((c) => c.geometry.dispose());
  stringerGroup.clear();
  const s = data.curves.stringer;
  for (const key of ['deck', 'bottom']) {
    if (s.x.length < 4) break;
    const pts = s.x.map((x, i) => new THREE.Vector3(...toThree(x, 0, s[key][i], L)));
    const curve = new THREE.CatmullRomCurve3(pts);
    stringerGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(400, pts.length * 2), 0.07, 6), stringerMat));
  }
  stringerGroup.visible = state.stringer;
  placeBoard();

  if (!state.fitted) { setView('threeq', false); state.fitted = true; }
}

/* camera views */
let tween = null;
function setView(name, animate = true) {
  const L = state.board?.params.length ?? 72;
  const d = L * 1.55 * Math.max(1, 1.6 / camera.aspect);   // scales with board length; back off on tall, narrow screens
  const bb = wireMesh.geometry.boundingBox;
  const cy = bb ? (bb.min.y + bb.max.y) / 2 : 2;
  const views = {
    threeq: [0.30 * d, 0.42 * d, 0.62 * d],
    deck: [0, 0.85 * d, 0.001],
    side: [0, 0.04 * d, 0.8 * d],
    tail: [-0.95 * d, 0.07 * d, 0.0],
  };
  const target = new THREE.Vector3(0, cy, 0);
  if (!views[name]) name = 'threeq';
  const to = new THREE.Vector3(...views[name]).add(target);
  state.view = name;
  document.querySelectorAll('#views button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (!animate) { camera.position.copy(to); camera.up.copy(UP); controls.target.copy(target); controls.update(); return; }
  tween = { t0: performance.now(), dur: 550, fromP: camera.position.clone(), toP: to, fromT: controls.target.clone(), toT: target, fromU: camera.up.clone() };
}

function animate(now) {
  requestAnimationFrame(animate);
  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(tween.fromP, tween.toP, e);
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
    camera.up.lerpVectors(tween.fromU, UP, e).normalize();          // a view puts the board upright again
    if (k === 1) tween = null;
  }
  const want = state.flip ? Math.PI : 0;
  if (flipNow !== want) {
    flipNow += (want - flipNow) * 0.2;
    if (Math.abs(want - flipNow) < 0.004) flipNow = want;
    placeBoard();
  }
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

function resize() {
  const r = viewport.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return;            // hidden while a graph is expanded
  renderer.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
  if (state.board && !state.userMoved && !tween) setView(state.view || 'threeq', false);   // keep the board framed until they grab it
}
controls.addEventListener('start', () => (state.userMoved = true));

new ResizeObserver(resize).observe(viewport);
renderer.domElement.addEventListener('pointerdown', () => $('#hint').classList.add('gone'), { once: true });
setTimeout(() => $('#hint').classList.add('gone'), 12000);
if (COARSE) $('#hint').textContent = 'Drag to rotate · pinch to zoom · on the graphs, turn on Edit points to reshape a curve';

/* =========================================================================
   2D views: plan, profile, sections. Each is a zoomable canvas you edit on.
   "Edit points" off: look only. Scroll or pinch to zoom, drag to pan.
   "Edit points" on:
     round dot  = anchor point: click a curve to add one, drag to shape,
                  double-click (or right-click) to remove
     small ring = a handle arm of the selected anchor point: drag it to set the
                  direction the curve passes through the point and how far it
                  holds that direction (double-click = back to automatic)
     square     = a measurement; draggable when "Fix dimensions" is off
     diamond    = a cross-section slice; drag it along the board
   ========================================================================= */
const snap = (v, step) => Math.round(v / step) * step;
const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function lerpAt(xs, ys, xq) {
  const n = xs.length;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= xq) lo = mid; else hi = mid; }
  return ys[lo] + ((xq - xs[lo]) / (xs[hi] - xs[lo])) * (ys[hi] - ys[lo]);
}

class View2D {
  constructor(canvas, drawFn) {
    Object.assign(this, { c: canvas, drawFn, zoom: 1, mx: 0, my: 0, s: 1, s0: 1, vex: 1, w: 1, h: 1, handles: [], curves: [], drag: null,
      ptrs: new Map(), pinch: null, touch: COARSE, lastTap: null });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('dblclick', (e) => { if (!this.touch) this.removeAt(e); });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.removeAt(e); });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }
  redraw() { if (state.board && this.c.clientWidth > 4) this.drawFn(this, state.board); }
  /** Points can be edited: Edit points is on, or this view is always for editing (the photo trace). */
  get editing() { return this.alwaysEdit || prefs.edit; }
  /** After a change: a view of its own (self) just redraws; the panels rebuild the board. */
  changed(light) { if (this.self) this.redraw(); else if (light) scrubChanged(); else schedule(); }

  /** Size the canvas, set the world -> pixel transform for extent [x0, x1, y0, y1], return the context. */
  begin([x0, x1, y0, y1], vex = 1, pad = 22) {
    const r = this.c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = this.c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.lineJoin = 'round';
    this.w = r.width; this.h = r.height; this.vex = vex;
    this.s0 = Math.max(1e-6, Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / ((y1 - y0) * vex)));
    if (this.zoom <= 1) { this.zoom = 1; this.mx = (x0 + x1) / 2; this.my = (y0 + y1) / 2; }
    this.s = this.s0 * this.zoom;
    this.handles = []; this.curves = [];
    return ctx;
  }
  X(x) { return this.w / 2 + (x - this.mx) * this.s; }
  Y(y) { return this.h / 2 - (y - this.my) * this.vex * this.s; }
  wx(px) { return this.mx + (px - this.w / 2) / this.s; }
  wy(py) { return this.my - (py - this.h / 2) / (this.vex * this.s); }
  pos(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  path(ctx, xs, ys, close = false) {
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) (i ? ctx.lineTo(this.X(xs[i]), this.Y(ys[i])) : ctx.moveTo(this.X(xs[i]), this.Y(ys[i])));
    if (close) ctx.closePath();
  }
  text(ctx, str, px, py, color = COLORS.muted, align = 'center') { ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(str, px, py); }

  /** Draw a point and remember it for hit-testing.
      h = { x, y, kind, color, locked, drag, remove, select, ghost, on, view (usable with Edit points off), light (drag needs no rebuild) } */
  point(ctx, h) {
    const px = this.X(h.x), py = this.Y(h.y);
    if (!h.ghost) this.handles.push({ ...h, px, py });
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = h.color; ctx.fillStyle = h.ghost ? 'transparent' : h.color;
    if (h.ghost) ctx.globalAlpha = 0.45;
    else if (!this.editing && !h.view) ctx.globalAlpha = 0.5;      // looking, not editing
    ctx.beginPath();
    const big = COARSE ? 1.45 : 1;
    if (h.kind === 'arm') {                               // handle arm: a line from its anchor to a small ring
      ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
      ctx.moveTo(this.X(h.ax), this.Y(h.ay)); ctx.lineTo(px, py); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 3.6 * big, 0, 7); ctx.fillStyle = '#0e1317'; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
    } else if (h.kind === 'scrub') {                      // where the Sections view is looking: a marker under the line
      ctx.moveTo(px - 6 * big, py + 9 * big); ctx.lineTo(px + 6 * big, py + 9 * big); ctx.lineTo(px, py + 1); ctx.closePath(); ctx.fill();
    } else if (h.kind === 'anchor') {
      ctx.arc(px, py, 4.5 * big, 0, 7); ctx.fill(); ctx.strokeStyle = '#0e1317'; ctx.stroke();
      if (h.on && this.editing) { ctx.beginPath(); ctx.arc(px, py, 8 * big, 0, 7); ctx.strokeStyle = h.color; ctx.lineWidth = 1; ctx.stroke(); }
    }
    else if (h.kind === 'apex') {                         // rail apex: a ring with up / down ticks, it only moves up and down
      ctx.arc(px, py, 5.5 * big, 0, 7); ctx.fillStyle = '#0e1317'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 2 * big, 0, 7); ctx.fillStyle = h.color; ctx.fill();
      ctx.beginPath(); ctx.lineWidth = 1.5;
      for (const d of [-1, 1]) { ctx.moveTo(px - 3 * big, py + d * 9 * big); ctx.lineTo(px, py + d * 12 * big); ctx.lineTo(px + 3 * big, py + d * 9 * big); }
      ctx.stroke();
    }
    else if (h.kind === 'slice') { ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#0e1317'; ctx.stroke(); }
    else {
      ctx.rect(px - 3.5 * big, py - 3.5 * big, 7 * big, 7 * big); if (h.locked) { ctx.fillStyle = '#141b21'; } ctx.fill(); ctx.stroke();
      if (h.on && this.editing) { ctx.beginPath(); ctx.arc(px, py, 8.5 * big, 0, 7); ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.restore();
  }

  hit(px, py, all = this.editing) {
    let best = null, bd = this.touch ? 24 : 13;
    for (const h of this.handles) {
      if (!all && !h.view) continue;
      const d = Math.hypot(h.px - px, h.py - py) - (h.kind === 'anchor' || h.kind === 'apex' ? 2 : 0) - (h.kind === 'scrub' ? -6 : 0);   // anchors win ties
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  curveHit(px, py) {
    let best = null, bd = this.touch ? 18 : 9;
    const wx = this.wx(px), wy = this.wy(py);
    for (const c of this.curves) {
      let d;
      if (c.dist) d = c.dist(wx, wy);                     // a line that is not a function of x (a cross section): its own distance, in pixels
      else {
        const y = c.at(wx, wy);
        if (y === null || !Number.isFinite(y)) continue;
        d = Math.abs(this.Y(y) - py);
      }
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [px, py] = this.pos(e);
    this.touch = e.pointerType !== 'mouse';
    this.ptrs.set(e.pointerId, [px, py]);
    if (this.ptrs.size === 2) {                         // second finger: pinch to zoom, drag to pan
      if (this.drag?.undo) { this.drag.undo(); this.changed(); }   // the first finger was not adding a point after all
      this.drag = null;
      const [a, b] = [...this.ptrs.values()], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      this.pinch = { d: Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1), zoom: this.zoom, wx: this.wx(mx), wy: this.wy(my) };
      return;
    }
    const h = this.hit(px, py);
    if (!this.editing) {                                // looking only: pan, and the few things that are not edits
      if (h) { h.select?.(); if (h.drag) this.drag = { fn: h.drag, light: h.light }; }
      else {
        if (this.hit(px, py, true)) hintEdit();
        if (this.zoom > 1) this.drag = { pan: [px, py, this.mx, this.my] };
      }
      if (this.drag) { try { this.c.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); }
      if (h) this.changed(h.light);
      return;
    }
    if (h && h.locked) {                                // a fixed measurement: it cannot move, but its handle arms can
      if (h.select) { const was = state.pt; h.select(); if (was !== state.pt) drawPanels(); }
      else toast('Measurements are fixed. Untick "Fix dimensions" to drag them.');
      return;
    }
    if (h && h.remove && this.touch) {                  // double-tap a point to remove it
      const now = performance.now(), t = this.lastTap;
      if (t && now - t.t < 420 && Math.hypot(t.px - px, t.py - py) < 30) { this.lastTap = null; h.remove(); if (!this.self) saveLocal(); this.changed(); return; }
      this.lastTap = { t: now, px, py };
    }
    const had = state.pt;
    if (h) { h.select?.(); if (h.drag) this.drag = { fn: h.drag, light: h.light }; }
    else {
      const c = this.curveHit(px, py);
      if (c) this.drag = c.add(this.wx(px), this.wy(py));
      else {
        state.pt = null;                                // clicked empty space: put the handle arms away
        if (this.zoom > 1) this.drag = { pan: [px, py, this.mx, this.my] };
      }
    }
    if (this.drag) { try { this.c.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); }
    if (this.self) this.redraw();
    else if (h?.light) scrubChanged();
    else if (this.drag?.fn || h) schedule();
    else if (had !== state.pt) drawPanels();
  }
  move(e) {
    const [px, py] = this.pos(e);
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, [px, py]);
    if (this.pinch && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      this.zoom = clip((this.pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / this.pinch.d, 1, 40);
      this.s = this.s0 * this.zoom;
      this.mx = this.pinch.wx - (mx - this.w / 2) / this.s; this.my = this.pinch.wy + (my - this.h / 2) / (this.vex * this.s);
      this.redraw();
      return;
    }
    if (!this.drag) {
      if (e.pointerType !== 'mouse') return;
      this.touch = false;
      const h = this.hit(px, py);
      this.c.style.cursor = h ? (h.locked ? 'not-allowed' : h.kind === 'apex' ? 'ns-resize' : 'grab') : this.editing && this.curveHit(px, py) ? (this.addCursor || 'copy') : this.zoom > 1 ? 'move' : 'default';
      return;
    }
    if (this.drag.pan) {
      const [sx, sy, mx, my] = this.drag.pan;
      this.mx = mx - (px - sx) / this.s; this.my = my + (py - sy) / (this.vex * this.s);
      this.redraw();
      return;
    }
    this.drag.undo = null;                              // it moved: this really is an edit
    this.drag.fn(this.wx(px), this.wy(py));
    this.changed(this.drag.light);
  }
  up(e) {
    if (e) this.ptrs.delete(e.pointerId); else this.ptrs.clear();
    if (this.ptrs.size < 2) this.pinch = null;
    if (this.drag) { const edit = !this.drag.light && !this.drag.pan && !this.self; this.drag = null; if (edit) saveLocal(); }
  }
  removeAt(e) {
    const h = this.hit(...this.pos(e));
    if (h?.remove) { h.remove(); if (!this.self) saveLocal(); this.changed(); }
  }
  wheel(e) {
    e.preventDefault();
    const [px, py] = this.pos(e), wx = this.wx(px), wy = this.wy(py);
    this.zoom = clip(this.zoom * Math.exp(-e.deltaY * 0.0015), 1, 40);
    this.s = this.s0 * this.zoom;
    this.mx = wx - (px - this.w / 2) / this.s; this.my = wy + (py - this.h / 2) / (this.vex * this.s);
    this.redraw();
  }
  zoomBy(f) { this.zoom = clip(this.zoom * f, 1, 40); this.redraw(); }
  fit() { this.zoom = 1; this.redraw(); }
}

/* ---- shared helpers for the three panels -------------------------------- */
const SLICE_COLOR = '#b48cff';
const dropFrom = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };
const sliceIndex = (board) => (state.sel === null ? -1 : board.params.slices.findIndex((s) => s.id === state.sel));
const tip = (v, ctx, msg) => {
  if (!prefs.edit) msg = 'looking · turn on Edit points to reshape';
  if (v.w > 300) v.text(ctx, COARSE ? msg.replace(/click/g, 'tap') : msg, v.w / 2, v.h - 6, 'rgba(132,148,159,.8)', 'center');
};
let hinted = 0;
function hintEdit() {
  if (performance.now() - hinted < 15000) return;
  hinted = performance.now();
  toast('Turn on "Edit points" (top of the graph) to move points.');
}
const rev = (arr) => [...arr].reverse();
const slopeAt = (xs, ys, xq, e = 0.4) => (lerpAt(xs, ys, xq + e) - lerpAt(xs, ys, xq - e)) / (2 * e);
const scrubX = (board) => clip(state.scrub ?? board.params.length / 2 + board.params.wide_point_offset, 0.5, board.params.length - 0.5);
const whereText = (x, L) => (x > L / 2 ? `${fracIn(L - x)}″ from nose` : `${fracIn(x)}″ from tail`);

/** Full outline of a section (from sectionAt): right deck, right bottom, then the left half. `step` thins the points. */
function sectionOutline(s, anchors = true, step = 1) {
  const pick = (arr) => arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
  const dy = pick(anchors ? s.deck.y : s.deck.y0), dz = pick(anchors ? s.deck.z : s.deck.z0);
  const by = pick(anchors ? s.bottom.y : s.bottom.y0), bz = pick(anchors ? s.bottom.z : s.bottom.z0);
  const X = [...dy, ...rev(by)], Z = [...dz, ...rev(bz)];     // stringer on the deck -> rail apex -> stringer on the bottom
  return { X: [...X, ...rev(X).map((q) => -q)], Z: [...Z, ...rev(Z)], d: dz, b: bz };
}

/* A handle = slope + two arm lengths, wherever it is kept: on an anchor point [x, offset, slope, left, right],
   on an added measurement (hw / hr / ht = [slope, left, right]) or on a 12" / center marker (params.handles). */
const anchorHandle = (a) => ({
  id: a,
  set: (m, side, d) => { while (a.length < 5) a.push(null); if (m !== null) a[2] = m; a[side < 0 ? 3 : 4] = d; },
  reset: () => { a.length = 2; },
});
const tripleHandle = (id, get, put) => ({
  id,
  set: (m, side, d) => { let hd = get(); if (!hd) put(hd = [null, null, null]); if (m !== null) hd[0] = m; hd[side < 0 ? 1 : 2] = d; },
  reset: () => put(null),
});
const pinHandle = (name, key) => tripleHandle(`p|${name}|${key}`, () => state.params.handles[name][key],
  (hd) => { if (hd) state.params.handles[name][key] = hd; else delete state.params.handles[name][key]; });
const MARK_HANDLE = { outline: 'hw', rocker: 'hr', thickness: 'ht' };
const markHandle = (raw, name) => tripleHandle(`m|${state.params.marks.indexOf(raw)}|${name}`, () => raw[MARK_HANDLE[name]],
  (hd) => { if (hd) raw[MARK_HANDLE[name]] = hd; else delete raw[MARK_HANDLE[name]]; });

/**
 * The two handle arms of the selected point. (x0, y0) is the point on the graph; `res` the handle the
 * geometry is using now; H where a change is kept. Along the unit direction T a step of 1 in position
 * is `kx` graph units; across it (N) the drawn curve is base + k * offset, the base sloping S0.
 * `level` = the point must stay level (a wide / low / thick point), so only the arm lengths change.
 */
function drawArms(v, ctx, H, x0, y0, res, { S0, k, kx = 1, color, mMax = 3, aMin = 0.5, aMax = 60, level = false, T = [1, 0], N = [0, 1] }) {
  if (!prefs.edit || state.pt !== H.id || !res) return;
  const S = S0 + k * res.m;                             // graph height per unit of position
  for (const side of [-1, 1]) {
    const len0 = side < 0 ? res.aL : res.aR;
    if (!Number.isFinite(len0)) continue;
    // a short arm is drawn at least 16 px out, so it can be grabbed (dragging sets its real length)
    const dir = [kx * T[0] + S * N[0], kx * T[1] + S * N[1]], px = Math.hypot(dir[0] * v.s, dir[1] * v.s * (v.vex || 1));
    const len = px > 0 ? Math.max(len0, 16 / px) : len0;
    v.point(ctx, {
      x: x0 + side * len * dir[0], y: y0 + side * len * dir[1], kind: 'arm', color, ax: x0, ay: y0,
      drag: (wx, wy) => {
        const along = (wx - x0) * T[0] + (wy - y0) * T[1], across = (wx - x0) * N[0] + (wy - y0) * N[1];
        const d = Math.max((side * along) / kx, aMin);
        H.set(level ? null : clip(((side * across) / d - S0) / k, -mMax, mMax), side, clip(d, aMin, aMax));
      },
      remove: () => H.reset(),                          // double-click: back to the automatic handle
    });
  }
}
const armOf = (list, a) => list.find((r) => Math.abs(r.x - a[0]) < 1e-6);
/** A measurement square. `apply(wx, wy)` receives the pointer in board inches. */
const station = (v, ctx, x, y, color, apply, id = null) =>
  v.point(ctx, { x, y, kind: 'station', color, locked: prefs.fix, drag: prefs.fix ? null : apply,
    on: id !== null && state.pt === id, select: id === null ? null : () => { state.pt = id; } });
const rawMark = (r) => state.params.marks.find((q) => q.pos === r.pos && q.from === r.from);
const markPos = (raw, wx) => { const L = state.board.params.length, x = clip(snap(wx, 0.25), 1.25, L - 1.25); raw.pos = raw.from === 'nose' ? L - x : raw.from === 'center' ? x - L / 2 : x; };

/* ---- plan: the outline --------------------------------------------------- */
function drawPlan(v, data) {
  const { x, h, yin } = data.curves.outline, p = data.params, P = state.params;
  const L = p.length, W = data.stats.width_in;
  const ctx = v.begin([0, L, -W / 2 - 1.5, W / 2 + 1.5]);
  if (state.photo && state.photoOn) drawPhoto(v, ctx, state.photo, 0.32);

  ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1;
  for (let gx = 0; gx <= L; gx += 12) { ctx.beginPath(); ctx.moveTo(v.X(gx), v.Y(-W / 2)); ctx.lineTo(v.X(gx), v.Y(W / 2)); ctx.stroke(); }

  const notch = [];
  for (let i = 0; i < x.length; i++) if (yin[i] > 0) notch.push(i);
  const rev = (a) => [...a].reverse();
  v.path(ctx, [...x, ...rev(x), ...notch.map((i) => x[i]), ...rev(notch).map((i) => x[i])],
    [...h, ...rev(h).map((q) => -q), ...notch.map((i) => -yin[i]), ...rev(notch).map((i) => yin[i])], true);
  ctx.fillStyle = 'rgba(243,239,230,0.08)'; ctx.fill();
  ctx.strokeStyle = COLORS.foam; ctx.lineWidth = 1.6; ctx.stroke();

  const s = data.curves.stringer;
  ctx.setLineDash([4, 4]); ctx.strokeStyle = COLORS.wood; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(v.X(s.x[0]), v.Y(0)); ctx.lineTo(v.X(s.x[s.x.length - 1]), v.Y(0)); ctx.stroke();

  // 12" stations and wide point
  const xw = L / 2 + p.wide_point_offset;
  const marks = [
    [12, `T12 ${fracIn(data.stats.tail_width_12_in)}″`, COLORS.warm],
    [L - 12, `N12 ${fracIn(data.stats.nose_width_12_in)}″`, COLORS.sand],
    [xw, `WP ${fracIn(W)}″`, COLORS.accent],
  ];
  for (const [mx, txt, col] of marks) {
    const half = lerpAt(x, h, mx);
    ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(v.X(mx), v.Y(-half)); ctx.lineTo(v.X(mx), v.Y(half)); ctx.stroke();
    v.text(ctx, txt, v.X(mx), v.Y(W / 2 + 0.6) - 3, col);
  }

  // bottom contour stations
  const SHORT = { flat: 'flat', concave: 'conc', roll: 'roll', double: 'dbl', concave_double: 'conc+dbl', vee: 'vee', vee_double: 'vee+dbl' };
  ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 1;
  for (const r of p.bottom) {
    ctx.beginPath(); ctx.moveTo(v.X(r.x), v.Y(-W / 2 - 0.2)); ctx.lineTo(v.X(r.x), v.Y(-W / 2 - 0.2) + 5); ctx.stroke();
    if (v.s * 12 > 70) v.text(ctx, SHORT[r.type], v.X(r.x), v.Y(-W / 2 - 0.2) + 15, COLORS.muted);
  }

  // where the Sections view is looking
  if (state.sel === null) {
    const sx = scrubX(data), half = lerpAt(x, h, sx);
    ctx.strokeStyle = SLICE_COLOR; ctx.globalAlpha = 0.9; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(v.X(sx), v.Y(-half)); ctx.lineTo(v.X(sx), v.Y(half)); ctx.stroke(); ctx.globalAlpha = 1;
    v.point(ctx, { x: sx, y: -half, kind: 'scrub', color: SLICE_COLOR, view: true, light: true,
      drag: (wx) => { state.scrub = clip(snap(wx, 0.25), 0.5, state.board.params.length - 0.5); } });
  }

  // cross-section slices
  for (const sl of p.slices) {
    const raw = P.slices.find((q) => q.id === sl.id);
    const half = lerpAt(x, h, sl.x), on = sl.id === state.sel;
    ctx.strokeStyle = SLICE_COLOR; ctx.globalAlpha = on ? 1 : 0.55; ctx.setLineDash(on ? [] : [2, 3]);
    ctx.beginPath(); ctx.moveTo(v.X(sl.x), v.Y(-half)); ctx.lineTo(v.X(sl.x), v.Y(half)); ctx.stroke();
    ctx.globalAlpha = 1;
    if (raw) v.point(ctx, {
      x: sl.x, y: 0, kind: 'slice', color: SLICE_COLOR, view: true,
      select: () => { state.sel = sl.id; state.pt = null; },
      drag: prefs.edit ? (wx) => { raw.x = clip(snap(wx, 0.25), 2, state.board.params.length - 2); } : null,
    });
  }
  ctx.setLineDash([]);

  // measurements
  const pq = data._profiles;
  const pinArms = (key, px, py, color) => {
    let res = pq.arms.outline.pins[key];
    if (res && key === 'tail') res = { ...res, aL: NaN };   // the tips only have an arm on the board's side
    if (res && key === 'nose') res = { ...res, aR: NaN };
    drawArms(v, ctx, pinHandle('outline', key), px, py, res, { S0: slopeAt(pq.x, pq.h0, px), k: 1, color, level: key === 'origin' });
  };
  station(v, ctx, 12, lerpAt(x, h, 12), COLORS.warm, (wx, wy) => setParam('tail_width_12', snap(2 * Math.abs(wy), 0.0625), 'graph'), 'p|outline|tail12');
  pinArms('tail12', 12, lerpAt(x, h, 12), COLORS.warm);
  station(v, ctx, L - 12, lerpAt(x, h, L - 12), COLORS.sand, (wx, wy) => setParam('nose_width_12', snap(2 * Math.abs(wy), 0.0625), 'graph'), 'p|outline|nose12');
  pinArms('nose12', L - 12, lerpAt(x, h, L - 12), COLORS.sand);
  station(v, ctx, xw, W / 2, COLORS.accent, (wx, wy) => {
    setParam('wide_point_offset', snap(wx - state.board.params.length / 2, 0.25), 'graph');
    setParam('width', snap(2 * Math.abs(wy), 0.125), 'graph');
  }, 'p|outline|origin');
  pinArms('origin', xw, W / 2, COLORS.accent);
  for (const r of p.marks) {                            // added width measurements
    const raw = rawMark(r);
    if (!raw || r.width === null || !armOf(pq.arms.outline, [r.x])) continue;
    const y = lerpAt(x, h, r.x), H = markHandle(raw, 'outline');
    station(v, ctx, r.x, y, COLORS.sand, (wx, wy) => { markPos(raw, wx); raw.width = snap(clip(2 * Math.abs(wy), 0.5, 30), 0.0625); }, H.id);
    v.text(ctx, `${fracIn(2 * y)}″`, v.X(r.x), v.Y(y) - 9, COLORS.sand);
    drawArms(v, ctx, H, r.x, y, armOf(pq.arms.outline, [r.x]), { S0: slopeAt(pq.x, pq.h0, r.x), k: 1, color: COLORS.sand });
  }
  // the tail end and the nose tip: their arms set how the outline leaves them (blunter or more pointed)
  const yTail = lerpAt(x, h, 0);
  station(v, ctx, 0, yTail, COLORS.warm, TAIL_CLOSES.includes(p.tail_type) ? null : (wx, wy) => setParam('tail_block_width', snap(2 * Math.abs(wy), 0.125), 'graph'), 'p|outline|tail');
  pinArms('tail', 0, yTail, COLORS.warm);
  station(v, ctx, L, 0, COLORS.sand, null, 'p|outline|nose');
  pinArms('nose', L, 0, COLORS.sand);

  // anchor points on the outline (shown on both rails, they are one point)
  const dragFn = (a) => (wx, wy) => {
    const q = state.board._profiles, LL = state.board.params.length;
    a[0] = clip(wx, 0.8, LL - 0.8);
    a[1] = clip(Math.abs(wy) - lerpAt(q.x, q.h0, a[0]), -6, 6);
  };
  for (const a of P.anchors.outline) {
    const y = lerpAt(x, h, a[0]);
    v.point(ctx, { x: a[0], y, kind: 'anchor', color: COLORS.foam, on: state.pt === a, select: () => { state.pt = a; }, drag: dragFn(a), remove: () => dropFrom(P.anchors.outline, a) });
    v.point(ctx, { x: a[0], y: -y, kind: 'anchor', color: COLORS.foam, ghost: true });
    drawArms(v, ctx, anchorHandle(a), a[0], y, armOf(pq.arms.outline, a), { S0: slopeAt(pq.x, pq.h0, a[0]), k: 1, color: COLORS.foam });
  }

  // the cut of a swallow tail: its own anchor points, so it can be curved
  if (p.tail_type === 'swallow') {
    const D = p.swallow_depth, yn = (xq) => lerpAt(x, yin, xq), S0 = -p.swallow_width / 2 / D;
    const cutDrag = (a) => (wx, wy) => {
      const b = state.board.params;
      a[0] = clip(wx, 0.35, b.swallow_depth - 0.35);
      a[1] = clip(Math.abs(wy) - (b.swallow_width / 2) * (1 - a[0] / b.swallow_depth), -3, 3);
    };
    for (const a of P.anchors.swallow) {
      const y = yn(a[0]);
      v.point(ctx, { x: a[0], y, kind: 'anchor', color: COLORS.warm, on: state.pt === a, select: () => { state.pt = a; }, drag: cutDrag(a), remove: () => dropFrom(P.anchors.swallow, a) });
      v.point(ctx, { x: a[0], y: -y, kind: 'anchor', color: COLORS.warm, ghost: true });
      drawArms(v, ctx, anchorHandle(a), a[0], y, armOf(pq.arms.swallow, a), { S0, k: 1, color: COLORS.warm, aMin: 0.2 });
    }
    // the swallow tip's second arm: how the cut leaves the tail end (shown with the tail end's own arm)
    const cutTip = tripleHandle('p|outline|tail', () => state.params.handles.swallow?.tail,
      (hd) => { state.params.handles.swallow ||= {}; if (hd) state.params.handles.swallow.tail = [hd[0], null, hd[2]]; else delete state.params.handles.swallow.tail; });
    drawArms(v, ctx, cutTip, 0, yn(0), pq.arms.swallow?.tip && { ...pq.arms.swallow.tip, aL: NaN }, { S0, k: 1, color: COLORS.warm, aMin: 0.2 });
    v.curves.push({
      at: (wx, wy) => (wx < 0.35 || wx > D - 0.35 ? null : (wy < 0 ? -1 : 1) * yn(wx)),
      add: (wx) => {
        const a = [wx, yn(wx) - (p.swallow_width / 2) * (1 - wx / D)];
        P.anchors.swallow.push(a);
        state.pt = a;
        return { fn: cutDrag(a), undo: () => dropFrom(P.anchors.swallow, a) };
      },
    });
  }
  v.curves.push({
    at: (wx, wy) => (wx < 0.8 || wx > L - 0.8 ? null : (wy < 0 ? -1 : 1) * lerpAt(x, h, wx)),
    add: (wx) => {
      const q = data._profiles, a = [wx, lerpAt(q.x, q.h, wx) - lerpAt(q.x, q.h0, wx)];
      P.anchors.outline.push(a);
      state.pt = a;
      return { fn: dragFn(a), undo: () => dropFrom(P.anchors.outline, a) };
    },
  });

  v.text(ctx, 'tail', v.X(0), v.h - 6, COLORS.muted, 'left');
  v.text(ctx, 'nose', v.X(L), v.h - 6, COLORS.muted, 'right');
  if (drawTools(v, ctx, data)) {
    const long = v.w > 760;
    tip(v, ctx, long ? 'shaping a concave: drag the diamonds to move its ends, the dots to move its edges' + (rawTool(state.tool)?.shape === 'venturi' ? ' · click an edge to add a point' : '') + ' · Esc when done'
      : 'diamonds = ends · dots = edges · Esc when done');
    return;
  }
  tip(v, ctx, P.anchors.outline.length + P.anchors.swallow.length ? 'drag a point · drag its arms to blend · double-click removes'
    : p.tail_type === 'swallow' ? 'click the outline or the swallow cut to add a point · click a square for its arms' : 'click the outline to add a point · click a square for its arms');
}

/* ---- profile: rocker (bottom line) and foil (deck line) ------------------ */
function drawProfile(v, data) {
  const { x, bottom, deck } = data.curves.rocker, p = data.params, P = state.params, sc = data.thickness_scale;
  const L = p.length;
  const ctx = v.begin([0, L, Math.min(0, ...bottom) - 0.5, Math.max(...deck) + 0.7], prefs.vexProfile);

  ctx.strokeStyle = COLORS.line; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(0)); ctx.lineTo(v.X(L), v.Y(0)); ctx.stroke(); ctx.setLineDash([]);

  v.path(ctx, [...x, ...[...x].reverse()], [...deck, ...[...bottom].reverse()], true);
  ctx.fillStyle = 'rgba(243,239,230,0.08)'; ctx.fill();
  v.path(ctx, x, deck); ctx.strokeStyle = COLORS.foam; ctx.lineWidth = 1.5; ctx.stroke();
  v.path(ctx, x, bottom); ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1.8; ctx.stroke();

  const zb = (xq) => lerpAt(x, bottom, xq), dk = (xq) => lerpAt(x, deck, xq);
  const xl = L / 2 + p.rocker_low_point, xt = L / 2 + p.thickness_point_offset;
  const [, n12, , t12] = data.stats.stations;
  for (const [sx, col] of [[12, COLORS.warm], [L - 12, COLORS.sand]]) {
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(v.X(sx), v.Y(zb(sx))); ctx.lineTo(v.X(sx), v.Y(dk(sx))); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const sl of p.slices) {
    ctx.strokeStyle = SLICE_COLOR; ctx.globalAlpha = sl.id === state.sel ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(v.X(sl.x), v.Y(zb(sl.x))); ctx.lineTo(v.X(sl.x), v.Y(dk(sl.x))); ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (state.sel === null) {                             // where the Sections view is looking
    const sx = scrubX(data);
    ctx.strokeStyle = SLICE_COLOR; ctx.globalAlpha = 0.9; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(v.X(sx), v.Y(zb(sx))); ctx.lineTo(v.X(sx), v.Y(dk(sx))); ctx.stroke(); ctx.globalAlpha = 1;
    v.point(ctx, { x: sx, y: zb(sx), kind: 'scrub', color: SLICE_COLOR, view: true, light: true,
      drag: (wx) => { state.scrub = clip(snap(wx, 0.25), 0.5, state.board.params.length - 0.5); } });
  }

  if (drawToolCenters(v, ctx, data)) return;

  // measurements: rocker on the bottom line, thickness on the deck line
  const now = () => state.board, bz = (xq) => lerpAt(now()._profiles.x, now()._profiles.zb, xq);
  station(v, ctx, 0, bottom[0], COLORS.warm, (wx, wy) => setParam('tail_rocker', snap(Math.max(wy, 0), 0.0625), 'graph'));
  const q = data._profiles, inside = (wx) => wx > 0.8 && wx < L - 0.8;
  const deckS0 = (xq) => slopeAt(q.x, q.zb, xq) + sc * slopeAt(q.x, q.foil0, xq);
  const pinArms = (name, key, px, py, color) => drawArms(v, ctx, pinHandle(name, key), px, py, q.arms[name].pins[key],
    name === 'rocker' ? { S0: slopeAt(q.x, q.zb0, px), k: 1, color, level: key === 'origin' } : { S0: deckS0(px), k: sc, color, level: key === 'origin' });
  station(v, ctx, 12, zb(12), COLORS.warm, (wx, wy) => setParam('tail_rocker_12', snap(Math.max(wy, 0), 0.0625), 'graph'), 'p|rocker|tail12');
  pinArms('rocker', 'tail12', 12, zb(12), COLORS.warm);
  station(v, ctx, L - 12, zb(L - 12), COLORS.sand, (wx, wy) => setParam('nose_rocker_12', snap(Math.max(wy, 0), 0.0625), 'graph'), 'p|rocker|nose12');
  pinArms('rocker', 'nose12', L - 12, zb(L - 12), COLORS.sand);
  station(v, ctx, L, bottom[bottom.length - 1], COLORS.sand, (wx, wy) => setParam('nose_rocker', snap(Math.max(wy, 0), 0.0625), 'graph'));
  station(v, ctx, xl, 0, COLORS.accent, (wx) => setParam('rocker_low_point', snap(wx - now().params.length / 2, 0.25), 'graph'), 'p|rocker|origin');
  pinArms('rocker', 'origin', xl, zb(xl), COLORS.accent);
  station(v, ctx, 12, dk(12), COLORS.warm, (wx, wy) => setParam('tail_thickness_12', snap(Math.max(wy - bz(12), 0.3) / now().thickness_scale, 0.0625), 'graph'), 'p|thickness|tail12');
  pinArms('thickness', 'tail12', 12, dk(12), COLORS.warm);
  station(v, ctx, L - 12, dk(L - 12), COLORS.sand, (wx, wy) => setParam('nose_thickness_12', snap(Math.max(wy - bz(now().params.length - 12), 0.3) / now().thickness_scale, 0.0625), 'graph'), 'p|thickness|nose12');
  pinArms('thickness', 'nose12', L - 12, dk(L - 12), COLORS.sand);
  station(v, ctx, xt, dk(xt), COLORS.foam, (wx, wy) => {
    const LL = now().params.length;
    setParam('thickness_point_offset', snap(wx - LL / 2, 0.25), 'graph');
    setParam('thickness', snap(Math.max(wy - bz(clip(wx, 0, LL)), 1.5) / now().thickness_scale, 0.0625), 'graph');
  }, 'p|thickness|origin');
  pinArms('thickness', 'origin', xt, dk(xt), COLORS.foam);
  for (const r of p.marks) {                            // added rocker and thickness measurements
    const raw = rawMark(r);
    if (!raw) continue;
    if (r.rocker !== null && armOf(q.arms.rocker, [r.x])) {
      const H = markHandle(raw, 'rocker'), y = zb(r.x);
      station(v, ctx, r.x, y, COLORS.accent, (wx, wy) => { markPos(raw, wx); raw.rocker = snap(clip(wy, -2, 16), 0.0625); }, H.id);
      v.text(ctx, `${fracIn(y)}″`, v.X(r.x), v.Y(y) + 15, COLORS.accent);
      drawArms(v, ctx, H, r.x, y, armOf(q.arms.rocker, [r.x]), { S0: slopeAt(q.x, q.zb0, r.x), k: 1, color: COLORS.accent });
    }
    if (r.thickness !== null && armOf(q.arms.thickness, [r.x])) {
      const H = markHandle(raw, 'thickness'), y = dk(r.x);
      station(v, ctx, r.x, y, COLORS.foam, (wx, wy) => { markPos(raw, wx); raw.thickness = snap(clip((wy - bz(markX(raw, now().params.length))) / now().thickness_scale, 0.2, 6), 0.0625); }, H.id);
      v.text(ctx, `${fracIn(y - zb(r.x))}″`, v.X(r.x), v.Y(y) - 9, COLORS.foam);
      drawArms(v, ctx, H, r.x, y, armOf(q.arms.thickness, [r.x]), { S0: deckS0(r.x), k: sc, color: COLORS.foam });
    }
  }

  // anchor points
  const rockerDrag = (a) => (wx, wy) => {
    const q = now()._profiles, LL = now().params.length;
    a[0] = clip(wx, 0.8, LL - 0.8);
    a[1] = clip(wy - lerpAt(q.x, q.zb0, a[0]), -4, 4);
  };
  const deckDrag = (a) => (wx, wy) => {
    const q = now()._profiles, LL = now().params.length;
    a[0] = clip(wx, 0.8, LL - 0.8);
    a[1] = clip((wy - lerpAt(q.x, q.zb, a[0])) / now().thickness_scale - lerpAt(q.x, q.foil0, a[0]), -2, 2);
  };
  for (const a of P.anchors.rocker) {
    v.point(ctx, { x: a[0], y: zb(a[0]), kind: 'anchor', color: COLORS.accent, on: state.pt === a, select: () => { state.pt = a; }, drag: rockerDrag(a), remove: () => dropFrom(P.anchors.rocker, a) });
    drawArms(v, ctx, anchorHandle(a), a[0], zb(a[0]), armOf(q.arms.rocker, a), { S0: slopeAt(q.x, q.zb0, a[0]), k: 1, color: COLORS.accent });
  }
  for (const a of P.anchors.thickness) {
    v.point(ctx, { x: a[0], y: dk(a[0]), kind: 'anchor', color: COLORS.foam, on: state.pt === a, select: () => { state.pt = a; }, drag: deckDrag(a), remove: () => dropFrom(P.anchors.thickness, a) });
    drawArms(v, ctx, anchorHandle(a), a[0], dk(a[0]), armOf(q.arms.thickness, a), { S0: deckS0(a[0]), k: sc, color: COLORS.foam });
  }
  v.curves.push({
    at: (wx) => (inside(wx) ? zb(wx) : null),
    add: (wx) => { const a = [wx, lerpAt(q.x, q.zb, wx) - lerpAt(q.x, q.zb0, wx)]; P.anchors.rocker.push(a); state.pt = a; return { fn: rockerDrag(a), undo: () => dropFrom(P.anchors.rocker, a) }; },
  }, {
    at: (wx) => (inside(wx) ? dk(wx) : null),
    add: (wx) => { const a = [wx, lerpAt(q.x, q.t, wx) / sc - lerpAt(q.x, q.foil0, wx)]; P.anchors.thickness.push(a); state.pt = a; return { fn: deckDrag(a), undo: () => dropFrom(P.anchors.thickness, a) }; },
  });

  const wide = v.w > 430;                              // narrow panels only have room for the tip rocker
  v.text(ctx, `tail ${fracIn(bottom[0])}″${wide ? ` · ${fracIn(t12.rocker_in)}″ at 12″` : ''}`, 4, 12, COLORS.warm, 'left');
  v.text(ctx, `nose ${fracIn(bottom[bottom.length - 1])}″${wide ? ` · ${fracIn(n12.rocker_in)}″ at 12″` : ''}`, v.w - 4, 12, COLORS.sand, 'right');
  v.text(ctx, `${fracIn(data.stats.thickness_in)}″ thick`, v.X(xt), v.Y(dk(xt)) - 9, COLORS.foam);
  v.text(ctx, `low pt ${p.rocker_low_point > 0 ? '+' : ''}${fracIn(p.rocker_low_point)}″`, v.X(xl), v.Y(0) + 15, COLORS.accent);
  tip(v, ctx, P.anchors.rocker.length || P.anchors.thickness.length ? 'drag a point · drag its arms to blend · double-click removes' : 'click the bottom or deck line to add a point');
}

/* ---- sections: roll through the board, or shape one section ---------------- */
const fine = (v) => fracIn(v, 32);
function shapeText(sh) {
  const parts = [];
  if (sh.con > 1 / 64) parts.push(`concave ${fine(sh.con)}″`);
  if (sh.con < -1 / 64) parts.push(`roll ${fine(-sh.con)}″`);
  if (sh.dbl > 1 / 64) parts.push(`double ${fine(sh.dbl)}″`);
  if (sh.vee > 1 / 64) parts.push(`vee ${fine(sh.vee)}″`);
  return parts.length ? parts.join(' + ') : 'flat bottom';
}

/** The flat bottom line every depth is measured from, and the rail apex height above it. */
function sectionGuides(v, ctx, s, color) {
  ctx.save();
  ctx.setLineDash([2, 4]); ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(v.X(-s.h - 0.4), v.Y(0)); ctx.lineTo(v.X(s.h + 0.4), v.Y(0)); ctx.stroke();
  ctx.setLineDash([]); ctx.strokeStyle = color;
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(v.X(side * s.h), v.Y(s.apex_in)); ctx.lineTo(v.X(side * s.h) + side * 7, v.Y(s.apex_in)); ctx.stroke(); }
  ctx.restore();
}

function sectionCaption(v, ctx, data, s, color) {
  const L = data.params.length;
  v.text(ctx, `${whereText(s.x, L)} · ${fracIn(2 * s.h)}″ wide · ${fracIn(s.t)}″ thick`, 4, 12, color, 'left');
  const here = (data.params.tools || []).filter((t) => s.x >= t.x0 && s.x <= t.x1).map((t) => `${TOOL_SHAPES[t.shape].toLowerCase()}${t.kind === 'double' ? ' double' : ''} concave`);
  v.text(ctx, `${shapeText(s.shape)}${here.length ? ' + ' + here.join(' + ') : ''} · rail apex ${fracIn(s.apex_in)}″ up`, 4, 25, COLORS.sand, 'left');
}

/** A point of a section line at arc-length position rho: where it is, where it was before anchor points, and the frame there. */
function lineAt(ln, rho) {
  let lo = 0, hi = ln.rho.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ln.rho[mid] <= rho) lo = mid; else hi = mid; }
  const span = ln.rho[hi] - ln.rho[lo], f = span > 0 ? clip((rho - ln.rho[lo]) / span, 0, 1) : 0;
  const mix = (arr) => arr[lo] + f * (arr[hi] - arr[lo]);
  return { y: mix(ln.y), z: mix(ln.z), y0: mix(ln.y0), z0: mix(ln.z0), ny: mix(ln.ny), nz: mix(ln.nz) };
}
/** The spot on a section line (before anchor points) nearest to (wy, wz): its rho, and how far along the normal the pointer is. */
function nearestOnLine(ln, wy, wz) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < ln.y0.length; i++) { const d = (ln.y0[i] - wy) ** 2 + (ln.z0[i] - wz) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { rho: ln.rho[bi], off: (wy - ln.y0[bi]) * ln.ny[bi] + (wz - ln.z0[bi]) * ln.nz[bi] };
}

function drawSections(v, data) {
  const k = sliceIndex(data), P = state.params;
  const W = data.stats.width_in, T = data.stats.thickness_in;
  if (k < 0) {                                         // rolling through: the section at the scrub position, on fixed axes
    const s = sectionAt(data, scrubX(data));
    const ctx = v.begin([-W / 2 - 0.6, W / 2 + 0.6, -0.75, T + 0.45], prefs.vexSections, 16);
    ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(-0.6)); ctx.lineTo(v.X(0), v.Y(T + 0.3)); ctx.stroke();
    const ref = sectionOutline(sectionAt(data, data.params.length / 2 + data.params.wide_point_offset), true, 4);   // the wide point, for scale
    v.path(ctx, ref.X, ref.Z, true); ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(132,148,159,.45)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    sectionGuides(v, ctx, s, COLORS.sand);
    const o = sectionOutline(s);
    v.path(ctx, o.X, o.Z, true);
    ctx.fillStyle = 'rgba(180,140,255,0.08)'; ctx.fill();
    ctx.strokeStyle = SLICE_COLOR; ctx.lineWidth = 1.8; ctx.stroke();
    sectionCaption(v, ctx, data, s, SLICE_COLOR);
    if (v.w > 300) v.text(ctx, 'slide to roll through the board · Edit here to shape this section', v.w / 2, v.h - 6, 'rgba(132,148,159,.8)', 'center');
    return;
  }

  const s = sliceInfo(data, k), raw = P.slices.find((q) => q.id === s.id);
  const cur = sectionOutline(s);
  const lowest = Math.min(...cur.b, 0), highest = Math.max(...cur.d);
  const ctx = v.begin([-s.h - 0.6, s.h + 0.6, lowest - 0.3, highest + 0.4], prefs.vexSections, 18);
  ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(lowest - 0.2)); ctx.lineTo(v.X(0), v.Y(highest + 0.2)); ctx.stroke();
  sectionGuides(v, ctx, s, COLORS.sand);
  if (raw.deck.length || raw.bottom.length) {          // the shape without this slice's anchor points
    const o0 = sectionOutline(s, false);
    v.path(ctx, o0.X, o0.Z, true); ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  v.path(ctx, cur.X, cur.Z, true);
  ctx.fillStyle = 'rgba(180,140,255,0.08)'; ctx.fill();
  ctx.strokeStyle = SLICE_COLOR; ctx.lineWidth = 1.8; ctx.stroke();

  // Anchor points sit anywhere along the deck or bottom line, right around the rail. A point is kept as
  // [how far along the line, how far the surface is moved along its normal there (fraction of thickness)].
  const info = () => { const b = state.board, i = sliceIndex(b); return i < 0 ? null : sliceInfo(b, i); };
  for (const which of ['deck', 'bottom']) {
    const list = raw[which], col = which === 'deck' ? COLORS.foam : COLORS.accent, ln = s[which], G = Math.max(s.girth[which], 1e-6);
    const dragFn = (a) => (wx, wz) => {
      const si = info(); if (!si) return;
      const hit = nearestOnLine(si[which], Math.abs(wx), wz);
      a[0] = clip(hit.rho, 0.02, 0.995);
      a[1] = clip(hit.off / si.t, -0.6, 0.6);
    };
    for (const a of list) {
      const q = lineAt(ln, a[0]);
      v.point(ctx, { x: q.y, y: q.z, kind: 'anchor', color: col, on: state.pt === a, select: () => { state.pt = a; }, drag: dragFn(a), remove: () => dropFrom(list, a) });
      v.point(ctx, { x: -q.y, y: q.z, kind: 'anchor', color: col, ghost: true });
      drawArms(v, ctx, anchorHandle(a), q.y, q.z, s.arms[which].find((r) => Math.abs(r.x - a[0]) < 1e-9),
        { S0: 0, k: s.t, kx: G, color: col, mMax: 12, aMin: 0.008, aMax: 1, T: [q.nz, -q.ny], N: [q.ny, q.nz] });
    }
    v.curves.push({
      dist: (wx, wz) => {                               // pixels from the pointer to this line, on either half of the board
        let best = Infinity;
        for (let i = 0; i < ln.y.length; i += 2) best = Math.min(best, Math.hypot(v.X(ln.y[i]) - v.X(Math.abs(wx)), v.Y(ln.z[i]) - v.Y(wz)));
        return best;
      },
      add: (wx, wz) => {
        const base = nearestOnLine(ln, Math.abs(wx), wz), rho = clip(base.rho, 0.02, 0.995), q = lineAt(ln, rho);
        const a = [rho, ((q.y - q.y0) * q.ny + (q.z - q.z0) * q.nz) / s.t];        // starts on the line as it is now
        list.push(a); state.pt = a;
        return { fn: dragFn(a), undo: () => dropFrom(list, a) };
      },
    });
  }
  // The rail apex: a point of its own. Drag it up or down to set the apex height of this section
  // (a change from the board-wide value, like the slider). It cannot move in or out: the width is the outline's.
  const apexDrag = (wx, wz) => {
    const sl = rawSlice(); if (!sl || !state.board) return;
    const base = sectionBase(state.board.params, sl.x).rail_apex_in, hi = 0.6 * s.t;
    // the geometry eases the apex into 60% of the thickness; ask for the height that lands where the pointer is
    const want = clip(snap(wz, 1 / 32), 0.125, 0.97 * hi), ask = (want ** -6 - hi ** -6) ** (-1 / 6);
    sl.adj.rail_apex_in = clip(clip(ask, 0.125, 2) - base, -1.5, 1.5);
  };
  // Click the apex to show its two arms: one toward the deck, one toward the bottom. Each arm has its own
  // angle (in from upright) and length, so the two sides can meet at a point for a pinched rail.
  // Upright arms = a round rail. Double-click an arm to put that side back.
  const APEX_ID = 'apex', MIN_PX = 16;
  const sides = { deck: [Math.max(s.t - s.apex_in, 0.05), 1, s.shape.pd, s.shape.ld], bottom: [Math.max(s.apex_in, 0.05), -1, s.shape.pb, s.shape.lb] };
  const armDrag = (which, rail) => (wx, wz) => {
    const sl = rawSlice(); if (!sl) return;
    const [span, up] = sides[which];
    const inward = -rail * (wx - rail * s.h), along = up * (wz - s.apex_in);      // board inches, from the apex
    const deg = clip((Math.atan2(Math.max(inward, 0), Math.max(along, 1e-6)) * 180) / Math.PI, 0, 80);
    sl.adj[`apex_${which}_angle`] = +deg.toFixed(1);
    sl.adj[`apex_${which}_arm`] = +clip(Math.hypot(Math.max(inward, 0), Math.max(along, 0)) / span, 0.01, 0.5).toFixed(4);
  };
  const armReset = (which) => () => { const sl = rawSlice(); if (sl) { delete sl.adj[`apex_${which}_angle`]; delete sl.adj[`apex_${which}_arm`]; } };
  // the edge: where the rail's tuck meets the flat bottom. Drag it in or out (the tuck, in inches).
  if (prefs.edit) {
    const ey = s.h - Math.min(s.shape.tuck, 0.97 * s.h);
    let ez = 0, bd = Infinity;
    s.bottom.y.forEach((yy, i) => { const d0 = Math.abs(yy - ey); if (d0 < bd) { bd = d0; ez = s.bottom.z[i]; } });
    for (const rail of [1, -1]) {
      v.point(ctx, { x: rail * ey, y: ez, kind: 'anchor', color: COLORS.warm,
        drag: (wx) => {
          const sl = rawSlice(); if (!sl || !state.board) return;
          const w = clip(snap(s.h - Math.abs(wx), 1 / 16), 0, 4);
          sl.adj.rail_tuck_in = clip(+(w - sectionBase(state.board.params, sl.x).rail_tuck_in).toFixed(4), -4, 4);
        },
        remove: () => { const sl = rawSlice(); if (sl) delete sl.adj.rail_tuck_in; } });
      if (rail < 0 && v.w > 300) v.text(ctx, `edge · tuck ${fracIn(s.shape.tuck)}″`, v.X(-ey) + 8, v.Y(ez) + 13, COLORS.warm, 'left');
    }
  }
  for (const rail of [1, -1]) {
    const ax = rail * s.h;
    v.point(ctx, { x: ax, y: s.apex_in, kind: 'apex', color: COLORS.sand, drag: apexDrag, on: state.pt === APEX_ID,
      select: () => { state.pt = APEX_ID; },
      remove: () => { const sl = rawSlice(); if (sl) delete sl.adj.rail_apex_in; } });   // double-click: back to the board-wide height
    if (!prefs.edit || state.pt !== APEX_ID) continue;
    for (const [which, [span, up, deg, frac]] of Object.entries(sides)) {
      const a = (deg * Math.PI) / 180, len = (frac > 0 ? frac : 0.3) * span;          // not set yet: show it upright, ready to grab
      const dx = -rail * Math.sin(a), dz = up * Math.cos(a);
      const px = Math.hypot(dx * len * v.s, dz * len * v.s * v.vex), k = px < MIN_PX ? MIN_PX / Math.max(px, 1e-6) : 1;
      const ex = ax + dx * len * k, ez = s.apex_in + dz * len * k;
      v.point(ctx, { x: ex, y: ez, kind: 'arm', color: COLORS.sand, ax, ay: s.apex_in, drag: armDrag(which, rail), remove: armReset(which) });
      if (rail < 0 && v.w > 300) v.text(ctx, `${which} ${frac > 0 ? `${Math.round(deg)}°` : 'round'}`, v.X(ex) + 8, v.Y(ez) + (up > 0 ? -4 : 12), COLORS.sand, 'left');
    }
  }
  sectionCaption(v, ctx, data, s, SLICE_COLOR);
  tip(v, ctx, raw.deck.length || raw.bottom.length ? 'drag a point · drag its arms to blend · double-click removes' : 'rail apex: drag up or down, click it for its arms (angle them in to pinch the rail) · click a line to add a point');
}

const views2d = {
  plan: new View2D($('#c-plan'), drawPlan),
  profile: new View2D($('#c-rocker'), drawProfile),
  sections: new View2D($('#c-sections'), drawSections),
};
function drawPanels() { for (const v of Object.values(views2d)) v.redraw(); }

/* ---- slice bar, panel tools, expand / collapse ---------------------------- */
function sliceLabel(s, L) { return s.x > L / 2 ? `N ${fracIn(L - s.x)}″` : `T ${fracIn(s.x)}″`; }

/** Under the Sections title: a slider to roll through the board, or the controls of the section being shaped. */
function renderSliceBar(data) {
  const bar = $('#slicebar'), L = data.params.length, list = data.params.slices, x = scrubX(data);
  const near = state.sel === null ? list.find((s) => Math.abs(s.x - x) < 0.4) : null;
  const sig = JSON.stringify([state.sel, L, near?.id ?? null, list.map((s) => [s.id, sliceLabel(s, L)])]);
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    const chips = list.filter((s) => s.id !== state.sel)
      .map((s) => `<button data-id="${s.id}" title="Shaped section ${s.x > L / 2 ? 'from the nose' : 'from the tail'}: open it">${sliceLabel(s, L)}</button>`).join('');
    if (state.sel === null) {
      bar.innerHTML = `<input type="range" id="scrub" min="0.5" max="${L - 0.5}" step="0.25" aria-label="Position along the board"><span class="where" id="scrub-where"></span>
        <button data-edit title="Shape the section at this spot with sliders and points">${near ? 'Edit this one' : 'Edit here'}</button>${chips}`;
    } else {
      const s = list.find((q) => q.id === state.sel);
      bar.innerHTML = `<span class="editing">Shaping ${s ? sliceLabel(s, L) : ''}</span><button data-done title="Finish and go back to rolling through the board (Esc)">Done</button>
        <button data-del title="Remove this shaped section">Remove</button>${chips}`;
    }
  }
  const r = $('#scrub');
  if (r) {
    if (document.activeElement !== r || Math.abs(+r.value - x) > 0.13) r.value = x;
    r.style.setProperty('--pct', `${((x - 0.5) / (L - 1)) * 100}%`);
    $('#scrub-where').textContent = x > L / 2 ? `N ${fracIn(L - x)}″` : `T ${fracIn(x)}″`;
  }
}

/** The scrub position moved: nothing about the board changed, so just redraw. */
function scrubChanged() {
  if (!state.board) return;
  drawPanels();
  renderSliceBar(state.board);
  showRing(state.board);
}

function exitSection() {
  const s = state.params.slices.find((q) => q.id === state.sel);
  if (s) state.scrub = s.x;
  state.sel = null; state.pt = null;
  views2d.sections.zoom = 1;
  schedule();
}

function addSlice(x) {
  const P = state.params;
  const id = 1 + Math.max(0, ...P.slices.map((s) => s.id || 0));
  P.slices.push({ id, x, adj: {}, deck: [], bottom: [], v: 2 });
  state.sel = id;
}

function setFocus(name) {
  state.focus = state.focus === name ? null : name;
  $('.stage').dataset.focus = state.focus || '';
  document.querySelectorAll('[data-act="max"]').forEach((b) => {
    const mine = (b.closest('[data-panel]')?.dataset.panel || 'view') === state.focus;
    b.textContent = mine ? '⤡' : '⤢';
    b.title = mine ? 'Back to all views (Esc)' : 'Expand';
  });
}

function wirePanels() {
  $('#slicebar').addEventListener('input', (e) => {
    if (e.target.id !== 'scrub') return;
    state.scrub = +e.target.value;
    scrubChanged();
  });
  $('#slicebar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const P = state.params;
    if ('edit' in b.dataset) {                          // shape the section at the scrub position (reuse one that is already there)
      const x = scrubX(state.board), near = P.slices.find((s) => Math.abs(s.x - x) < 0.4);
      if (near) state.sel = near.id; else addSlice(clip(snap(x, 0.25), 2, state.board.params.length - 2));
      if (!prefs.edit) { prefs.edit = true; savePrefs(); syncPanelTools(); }
    } else if ('done' in b.dataset) { exitSection(); return; }
    else if ('del' in b.dataset) { const s = P.slices.find((q) => q.id === state.sel); if (s) state.scrub = s.x; P.slices = P.slices.filter((q) => q.id !== state.sel); state.sel = null; }
    else state.sel = Number(b.dataset.id);
    state.pt = null;
    views2d.sections.zoom = 1;
    saveLocal(); schedule();
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    const name = panel.dataset.panel, v = views2d[name];
    panel.querySelector('.tools').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act; if (!act) return;
      if (act === 'max') setFocus(name);
      if (act === 'trace') openTrace();
      if (act === 'photo') { state.photoOn = !state.photoOn; syncPhotoButton(); v.redraw(); }
      if (act === 'edit') { prefs.edit = !prefs.edit; if (!prefs.edit) state.pt = null; savePrefs(); syncPanelTools(); drawPanels(); }
      if (act === 'fit') v.fit();
      if (act === 'in') v.zoomBy(1.6);
      if (act === 'vex') {
        const key = name === 'profile' ? 'vexProfile' : 'vexSections';
        prefs[key] = prefs[key] === 1 ? 3 : 1; savePrefs(); v.zoom = 1; syncPanelTools(); v.redraw();
      }
      if (act === 'clear') {
        const P = state.params;
        if (name === 'plan') { P.anchors.outline = []; P.anchors.swallow = []; }
        if (name === 'profile') { P.anchors.rocker = []; P.anchors.thickness = []; }
        if (name === 'sections') { const s = P.slices.find((q) => q.id === state.sel); if (s) { s.deck = []; s.bottom = []; } }
        state.pt = null;
        saveLocal(); schedule();
      }
    });
  });
  $('#t-max').addEventListener('click', () => setFocus('view'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#feedback').hidden || !$('#trace').hidden) return;
    if (state.tool != null) { state.tool = null; renderTools(); drawPanels(); }
    else if (state.sel !== null) exitSection();              // Esc leaves the section being shaped first, then an expanded view
    else if (state.focus) setFocus(state.focus);
  });
  syncPanelTools();
}

function syncPanelTools() {
  document.querySelectorAll('.tools [data-act="edit"]').forEach((b) => {
    b.classList.toggle('on', prefs.edit);
    const short = b.closest('[data-panel]').dataset.panel === 'sections';
    b.textContent = prefs.edit ? (short ? 'Editing' : 'Editing points') : (short ? 'Edit' : 'Edit points');
  });
  for (const [name, key] of [['profile', 'vexProfile'], ['sections', 'vexSections']]) {
    const b = document.querySelector(`.panel[data-panel="${name}"] [data-act="vex"]`);
    b.textContent = prefs[key] === 1 ? 'true scale' : 'height ×3';
    b.classList.toggle('on', prefs[key] !== 1);
  }
}

function syncClearButtons() {
  const P = state.params, sl = P.slices.find((q) => q.id === state.sel);
  const has = { plan: P.anchors.outline.length + P.anchors.swallow.length, profile: P.anchors.rocker.length + P.anchors.thickness.length, sections: sl ? sl.deck.length + sl.bottom.length : 0 };
  for (const [name, n] of Object.entries(has)) document.querySelector(`.panel[data-panel="${name}"] [data-act="clear"]`).hidden = !n;
}

/* =========================================================================
   Stats and render
   ========================================================================= */
function render(data) {
  updateMesh(data);
  drawPanels();
  renderSliceBar(data);
  if (upgradeSlices(data)) { saveLocal(); schedule(); }
  refreshSectionGroup(data);
  syncMarks(data);
  syncTools();
  bottomUI.rows?.querySelectorAll('.brow').forEach((el) => { if (!el.contains(document.activeElement)) el._paint?.(); });
  syncClearButtons();
  showRing(data, false);
  const s = data.stats;
  $('#s-vol').textContent = s.volume_l.toFixed(2);
  $('#s-dims').textContent = `${ftin(s.length_in)} × ${fracIn(s.width_in)}″ × ${fracIn(s.thickness_in)}″`;
  $('#stats').title = `nose 12″ ${fracIn(s.nose_width_12_in)}″ · tail 12″ ${fracIn(s.tail_width_12_in)}″ · plan area ${s.plan_area_in2.toFixed(0)} sq in · ${(s.triangles / 1000).toFixed(1)}k triangles · ${data.build_ms} ms`;
  $('#warnings').innerHTML = data.warnings.map((w) => `<span>${w}</span>`).join('');

  for (const k of NULLABLE) {                          // blank measurements: show what was worked out
    state.cellEls[k]?.auto(data.params[k]);
    state.fieldEls[k]?.auto?.(data.params[k]);
  }
  const th = state.fieldEls.thickness;
  if (th) {
    const locked = data.params.lock_volume;
    th.el.classList.toggle('auto', locked);
    th.note.hidden = !locked;
    if (locked) th.note.textContent = `foil scaled ×${s.thickness_scale.toFixed(3)} → ${fracIn(s.thickness_in)}″ actual`;
  }
}

/* =========================================================================
   Toolbar, presets, save/load, export
   ========================================================================= */

/* =========================================================================
   Photo trace: a photo of a board -> the outline.
   1. choose a photo   2. tap the nose tip and the tail end, type the length
   3. the edge is found on one side (the board is symmetric, so the other side is its mirror)
   4. "Does this look good?"  yes -> use it, no -> fix the line with points, then use it
   The straightened photo stays behind the Plan graph (Photo button) until the page is reloaded.
   ========================================================================= */
const TR = { step: 'pick', img: null, mark: { nose: null, tail: null }, L: 72, side: 1, frame: null, rect: null, traces: {}, pts: null, auto: null, arms: { tail: null, nose: null }, cut: null };
const traceView = new View2D($('#c-trace'), (v) => drawTrace(v));
Object.assign(traceView, { alwaysEdit: true, self: true });
const TRACE_COL = '#e8c872';

function openTrace() {
  TR.step = TR.img ? 'mark' : 'pick';
  TR.L = state.board?.params.length ?? 72;
  $('#trace').hidden = false;
  traceStep(TR.step);
}
function closeTrace() { $('#trace').hidden = true; }

function traceStep(step) {
  TR.step = step;
  traceView.zoom = 1;
  $('#tr-pick').hidden = step !== 'pick';
  const msg = $('#tr-msg'), act = $('#tr-actions');
  const btn = (label, fn, cls = 'ghost', title = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  act.replaceChildren();
  if (step === 'pick') {
    msg.textContent = 'Pick a photo of the board. It stays on this device.';
    act.append(btn('Cancel', closeTrace));
  } else if (step === 'mark') {
    const next = !TR.mark.nose ? 'the <b>nose tip</b>' : !TR.mark.tail ? 'the <b>tail end</b> (middle of the tail)' : null;
    msg.innerHTML = next ? `Tap ${next} on the photo.` : 'Drag the marks to fine-tune, check the length, then trace.';
    const lab = document.createElement('label');
    lab.innerHTML = 'Board length <input class="cell" id="tr-len" spellcheck="false">';
    const len = lab.querySelector('input');
    len.value = ftin(TR.L);
    len.addEventListener('change', () => { const v = parseVal(len.value); if (Number.isFinite(v) && v >= 40 && v <= 144) TR.L = v; len.value = ftin(TR.L); });
    const go = btn('Trace', () => runTrace(), 'primary');
    go.disabled = !(TR.mark.nose && TR.mark.tail);
    act.append(btn('Another photo', () => $('#tr-file').click()), btn('Clear marks', () => { TR.mark = { nose: null, tail: null }; traceStep('mark'); }),
      document.createElement('span'), lab, btn('Cancel', closeTrace), go);
    act.children[2].className = 'spacer';
  } else if (step === 'review') {
    msg.innerHTML = `Does this look good? The <b>yellow line</b> is the edge it found; the dashed line is its mirror on the other side.${TR.cut ? ' It found a <b>swallow</b> cut (the V at the tail).' : ''}`;
    act.append(btn('Back', () => traceStep('mark')), btn('Trace the other side', () => { TR.side = -TR.side; useTrace(); traceStep('review'); }, 'ghost', 'Use the other edge of the board in the photo'),
      Object.assign(document.createElement('span'), { className: 'spacer' }), btn('No, fix it', () => traceStep('fix')), btn('Yes, use it', applyTrace, 'primary'));
  } else if (step === 'fix') {
    msg.innerHTML = `Drag a point onto the edge of the board, click the line to add a point, double-click a point to remove it. The <b>end points</b> move too (the length follows: <b id="tr-L">${ftin(traceLen())}</b>), and their <b>arms</b> set how the line leaves the tips.${TR.cut ? ' The dashed V is the swallow cut: drag its two points.' : ''}`;
    act.append(btn('Start over', () => { TR.pts = TR.auto.map((p) => [...p]); TR.arms = { tail: null, nose: null }; TR.cut = TR.autoCut && { ...TR.autoCut }; traceView.redraw(); }, 'ghost', 'Go back to the line it found'),
      btn(TR.cut ? 'No swallow cut' : 'Add a swallow cut', () => { TR.cut = TR.cut ? null : { depth: 4, half: 2.5 }; traceStep('fix'); }, 'ghost', 'The tail has a swallow cut (or does not)'),
      Object.assign(document.createElement('span'), { className: 'spacer' }), btn('Cancel', closeTrace), btn('Use this outline', applyTrace, 'primary'));
  }
  requestAnimationFrame(() => traceView.redraw());
}

function loadTracePhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));      // plenty for a trace, and quick
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    TR.img = c; TR.mark = { nose: null, tail: null }; TR.traces = {};
    traceStep('mark');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('That file could not be opened as a picture.'); };
  img.src = url;
}

/** Straighten the photo onto the stringer (tail on the left, nose on the right) and find the edge on both sides. */
function runTrace() {
  const [tx, ty] = TR.mark.tail, [nx, ny] = TR.mark.nose, L = TR.L;
  const dpx = Math.hypot(nx - tx, ny - ty);
  if (dpx < 20) { toast('The nose and tail marks are too close together.'); return; }
  const ppi = Math.min(24, Math.max(6, 1800 / (L + 4)));
  const f = traceFrame(L, ppi, Math.max(15, 0.2 * L), 6);       // room past each end to move the nose and tail points
  const e1 = [(nx - tx) / dpx, (ny - ty) / dpx], e2 = [e1[1], -e1[0]], k = (L / dpx) * ppi;    // e2: up in the photo when the nose points right
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  // photo pixel P -> frame: u = (pad + k/ppi (P - T).e1) ppi,  v = (ymax - k/ppi (P - T).e2) ppi
  g.setTransform(k * e1[0], -k * e2[0], k * e1[1], -k * e2[1],
    f.pad * ppi - k * (e1[0] * tx + e1[1] * ty), f.ymax * ppi + k * (e2[0] * tx + e2[1] * ty));
  g.drawImage(TR.img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const data = g.getImageData(0, 0, f.width, f.height);
  TR.frame = f; TR.rect = c;
  TR.traces = { 1: traceHalf(data, f, 1), '-1': traceHalf(data, f, -1) };
  const peak = (t) => Math.max(...t.hw);
  // start with the side that found a board and stands out more from the floor
  TR.side = peak(TR.traces[1]) < 2 ? -1 : peak(TR.traces[-1]) < 2 ? 1 : TR.traces[1].contrast >= TR.traces[-1].contrast ? 1 : -1;
  useTrace();
  if (peak(TR.traces[TR.side]) < 2) {
    toast('Could not find the edge of the board. Check the nose and tail marks, or try a photo on a floor that contrasts more.');
    return;
  }
  traceStep('review');
  if (TR.traces[TR.side].contrast < 45) toast('The board and the floor are close in colour, so check the line carefully.');
}
function useTrace() {
  const tr = TR.traces[TR.side];
  TR.auto = tracePoints(tr, TR.L);
  TR.pts = TR.auto.map((p) => [...p]);
  TR.arms = { tail: null, nose: null };
  TR.cut = tr.notch ? { depth: tr.notch.depth, half: tr.notch.half } : null;
  TR.autoCut = TR.cut && { ...TR.cut };
}
/** The traced line's length now (its tail end and nose tip can be moved while fixing it). */
const traceLen = () => { const p = [...TR.pts].sort((a, b) => a[0] - b[0]); return p[p.length - 1][0] - p[0][0]; };

function applyTrace() {
  if (!TR.pts) return;
  const sorted = [...TR.pts].sort((a, b) => a[0] - b[0]), x0 = sorted[0][0];
  const L = sorted[sorted.length - 1][0] - x0, pts = sorted.map(([x, y]) => [x - x0, y]);      // tail end at 0
  const cut = TR.cut && TR.cut.depth >= 0.75 ? TR.cut : null;
  const fit = fitOutline(pts, L, state.params, buildBoard, { NOSE_TYPES, TAIL_TYPES }, cut, traceCurve(pts, TR.arms));
  applyParams(fit.params);
  $('#preset').value = '';
  state.photo = { canvas: TR.rect, ...TR.frame, flip: TR.side < 0, shift: x0 };
  state.photoOn = true;
  syncPhotoButton();
  closeTrace();
  const nice = (t) => t.replace(/_/g, ' ');
  toast(`Outline traced: ${nice(fit.nose)} nose, ${nice(fit.tail)} tail, within ${fracIn(Math.max(fit.error, 1 / 32), 32)}″ of the line. Fine-tune it with Edit points.`);
}
function syncPhotoButton() {
  const b = document.querySelector('.panel[data-panel="plan"] [data-act="photo"]');
  b.hidden = !state.photo;
  b.classList.toggle('on', !!state.photoOn);
}
/** The straightened photo, faint, behind the Plan graph (world = board inches). */
function drawPhoto(v, ctx, ph, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const x0 = v.X(-ph.pad - (ph.shift || 0)), w = (ph.L + 2 * ph.pad) * v.s, h = 2 * ph.ymax * v.s * v.vex;
  if (ph.flip) { ctx.translate(0, v.Y(0)); ctx.scale(1, -1); ctx.translate(0, -v.Y(0)); }    // the traced side drawn on top, like the graph
  ctx.drawImage(ph.canvas, x0, v.Y(ph.ymax), w, h);
  ctx.restore();
}

function drawTrace(v) {
  if (TR.step === 'pick' || !TR.img) { const ctx = v.begin([0, 1, 0, 1]); return ctx; }
  if (TR.step === 'mark') {
    const iw = TR.img.width, ih = TR.img.height;
    const ctx = v.begin([0, iw, -ih, 0], 1, 12);
    ctx.drawImage(TR.img, v.X(0), v.Y(0), iw * v.s, ih * v.s);
    const { nose, tail } = TR.mark;
    if (nose && tail) {
      ctx.save(); ctx.setLineDash([6, 5]); ctx.strokeStyle = TRACE_COL; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(v.X(tail[0]), v.Y(-tail[1])); ctx.lineTo(v.X(nose[0]), v.Y(-nose[1])); ctx.stroke(); ctx.restore();
    }
    for (const key of ['tail', 'nose']) {
      const m = TR.mark[key]; if (!m) continue;
      v.point(ctx, { x: m[0], y: -m[1], kind: 'anchor', color: TRACE_COL, drag: (wx, wy) => { TR.mark[key] = [clip(wx, 0, iw), clip(-wy, 0, ih)]; } });
      ctx.save(); ctx.font = '600 12px "IBM Plex Sans", sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#0e1317';
      ctx.strokeText(key, v.X(m[0]) + 10, v.Y(-m[1]) - 8); ctx.fillStyle = TRACE_COL; ctx.fillText(key, v.X(m[0]) + 10, v.Y(-m[1]) - 8); ctx.restore();
    }
    v.curves.push({                                     // tapping anywhere places the next mark
      dist: () => (!TR.mark.nose || !TR.mark.tail ? 0 : Infinity),
      add: (wx, wy) => {
        const key = !TR.mark.nose ? 'nose' : 'tail';
        TR.mark[key] = [clip(wx, 0, iw), clip(-wy, 0, ih)];
        setTimeout(() => traceStep('mark'));
        return { fn: (x, y) => { TR.mark[key] = [clip(x, 0, iw), clip(-y, 0, ih)]; } };
      },
    });
    return ctx;
  }
  // review / fix: the straightened photo in board inches, the traced edge and its mirror
  const f = TR.frame, L = TR.L, sd = TR.side;
  const ctx = v.begin([-f.pad, L + f.pad, -f.ymax * 0.8, f.ymax * 0.8], 1, 14);
  drawPhoto(v, ctx, { canvas: TR.rect, ...f, flip: sd < 0 }, 0.9);
  const pts = [...TR.pts].sort((a, b) => a[0] - b[0]), fn = traceCurve(pts, TR.arms), n = pts.length;
  const xa = pts[0][0], xb = pts[n - 1][0];
  const xs = []; for (let x = xa; x < xb; x += 0.25) xs.push(x); xs.push(xb);
  ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(14,19,23,.7)';
  v.path(ctx, xs, xs.map((x) => fn(x))); ctx.stroke();
  ctx.lineWidth = 1.8; ctx.strokeStyle = TRACE_COL; v.path(ctx, xs, xs.map((x) => fn(x))); ctx.stroke();
  ctx.setLineDash([5, 5]); ctx.lineWidth = 1.2; v.path(ctx, xs, xs.map((x) => -fn(x))); ctx.stroke();
  if (TR.cut) {                                           // the swallow cut: a V from the tail end to its point
    ctx.beginPath(); ctx.moveTo(v.X(xa), v.Y(TR.cut.half)); ctx.lineTo(v.X(xa + TR.cut.depth), v.Y(0)); ctx.lineTo(v.X(xa), v.Y(-TR.cut.half)); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.strokeStyle = 'rgba(232,200,114,.5)'; ctx.beginPath(); ctx.moveTo(v.X(xa), v.Y(0)); ctx.lineTo(v.X(xb), v.Y(0)); ctx.stroke();
  ctx.restore();
  if (TR.step !== 'fix') return ctx;
  const sayLen = () => { const el = $('#tr-L'); if (el) el.textContent = ftin(traceLen()); };
  for (const p of TR.pts) {
    const i = pts.indexOf(p), tail = i === 0, nose = i === n - 1;
    const lo = i > 0 ? pts[i - 1][0] + 0.25 : -f.pad, hi = i < n - 1 ? pts[i + 1][0] - 0.25 : L + f.pad;
    v.point(ctx, { x: p[0], y: p[1], kind: 'anchor', color: TRACE_COL,
      drag: (wx, wy) => { p[0] = clip(wx, lo, hi); if (!nose) p[1] = clip(wy, 0, f.ymax); if (tail || nose) sayLen(); },
      remove: tail || nose ? null : () => dropFrom(TR.pts, p) });
  }
  // arms at the two ends: the direction the line leaves the tip, and how far it holds it
  for (const [key, A, B, dir] of [['tail', pts[0], pts[1], 1], ['nose', pts[n - 1], pts[n - 2], -1]]) {
    const g = Math.abs(B[0] - A[0]), auto = Math.atan(dir * fn.slopes[key === 'tail' ? 0 : n - 1]) * 180 / Math.PI;
    const [deg, len] = TR.arms[key] || [key === 'nose' ? Math.max(auto, 0) : auto, g / 3];
    const a = (deg * Math.PI) / 180, px = Math.max(len * v.s, 18) / v.s;      // at least 18 px out, so it can be grabbed
    v.point(ctx, { x: A[0] + dir * px * Math.cos(a), y: A[1] + px * Math.sin(a), kind: 'arm', color: TRACE_COL, ax: A[0], ay: A[1],
      drag: (wx, wy) => {
        const dx = dir * (wx - A[0]), dy = wy - A[1];
        TR.arms[key] = [clip(Math.atan2(dy, Math.max(dx, 1e-3)) * 180 / Math.PI, key === 'nose' ? 0 : -80, 89), clip(Math.hypot(dx, dy), 0.1, 0.95 * g)];
      },
      remove: () => { TR.arms[key] = null; } });
  }
  if (TR.cut) {
    const c = TR.cut;
    v.point(ctx, { x: xa, y: c.half, kind: 'anchor', color: TRACE_COL, drag: (wx, wy) => { c.half = clip(wy, 0.25, fn(xa) + 0.01); } });
    v.point(ctx, { x: xa + c.depth, y: 0, kind: 'slice', color: TRACE_COL, drag: (wx) => { c.depth = clip(wx - xa, 0.75, 12); } });
  }
  v.curves.push({
    dist: (wx, wy) => { if (wx < xa || wx > xb) return Infinity; return Math.abs(v.Y(fn(wx)) - v.Y(wy)); },
    add: (wx, wy) => {
      const p = [clip(wx, xa + 0.3, xb - 0.3), clip(wy, 0, f.ymax)];
      TR.pts.push(p);
      return { fn: (x, y) => { p[0] = clip(x, xa + 0.3, xb - 0.3); p[1] = clip(y, 0, f.ymax); }, undo: () => dropFrom(TR.pts, p) };
    },
  });
  return ctx;
}

function wireTrace() {
  $('#tr-file').addEventListener('change', (e) => { loadTracePhoto(e.target.files[0]); e.target.value = ''; });
  $('#tr-close').addEventListener('click', closeTrace);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#trace').hidden) { e.stopPropagation(); closeTrace(); } }, true);
}

/* =========================================================================
   Resizable layout: drag the dividers between the sidebar and the views, between the 3D
   view and the graphs, and between the graphs. Double-click a divider to put it back.
   Kept in prefs.layout: side (px), panels (px), cols (three widths, as fr).
   ========================================================================= */
const NARROW = matchMedia('(max-width: 820px)');
function applyLayout() {
  const L = prefs.layout || (prefs.layout = {}), root = document.documentElement.style, stage = $('.stage').style, panels = $('.panels').style;
  if (Number.isFinite(L.side)) root.setProperty('--side-w', `${L.side}px`); else root.removeProperty('--side-w');
  if (Number.isFinite(L.panels)) stage.setProperty('--panels-h', `${L.panels}px`); else stage.removeProperty('--panels-h');
  if (Array.isArray(L.cols) && L.cols.length === 3 && L.cols.every((c) => c > 0)) panels.setProperty('--panel-cols', L.cols.map((c) => `${c.toFixed(3)}fr`).join(' '));
  else panels.removeProperty('--panel-cols');
}
function placeSplitters() {
  const narrow = NARROW.matches;
  for (const el of document.querySelectorAll('.splitter')) {
    const a = el._a, host = el.parentElement, hr = host.getBoundingClientRect(), ar = a.getBoundingClientRect();
    const off = narrow || ar.width < 4 || ar.height < 4 || (el._b && el._b.getBoundingClientRect().width < 4);
    el.hidden = off;
    if (off) continue;
    if (el._dir === 'col') el.style.left = `${ar.right - hr.left}px`; else el.style.top = `${ar.bottom - hr.top}px`;
  }
}
function wireSplitters() {
  const layout = $('.layout'), stage = $('.stage'), panelsEl = $('.panels'), side = $('.sidebar');
  const panels = [...document.querySelectorAll('.panel')];
  const make = (host, dir, a, b, title, drag, reset) => {
    const el = document.createElement('div');
    el.className = `splitter ${dir}`; el.title = title; el.setAttribute('role', 'separator');
    Object.assign(el, { _a: a, _b: b, _dir: dir });
    host.appendChild(el);
    let on = false;
    el.addEventListener('pointerdown', (e) => { on = true; el.classList.add('on'); try { el.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); });
    el.addEventListener('pointermove', (e) => { if (!on) return; drag(e); applyLayout(); placeSplitters(); });
    const end = () => { if (!on) return; on = false; el.classList.remove('on'); savePrefs(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { reset(); applyLayout(); savePrefs(); requestAnimationFrame(placeSplitters); });
  };
  make(layout, 'col', side, null, 'Drag to make the sidebar wider or narrower · double-click to reset', (e) => {
    const r = layout.getBoundingClientRect();
    prefs.layout.side = Math.round(clip(e.clientX - r.left, 240, Math.max(260, Math.min(720, r.width - 420))));
  }, () => delete prefs.layout.side);
  make(stage, 'row', $('#viewport'), panelsEl, 'Drag to share the space between the 3D view and the graphs · double-click to reset', (e) => {
    const r = stage.getBoundingClientRect();
    prefs.layout.panels = Math.round(clip(r.bottom - e.clientY, 120, Math.max(130, r.height - 120)));
  }, () => delete prefs.layout.panels);
  for (let i = 0; i < 2; i++) {
    make(panelsEl, 'col', panels[i], panels[i + 1], 'Drag to make these graphs wider or narrower · double-click to reset', (e) => {
      const w = panels.map((p) => p.getBoundingClientRect().width), left = panels[i].getBoundingClientRect().left;
      const pair = w[i] + w[i + 1], min = Math.min(150, pair / 2 - 1);
      w[i] = clip(e.clientX - left, min, pair - min); w[i + 1] = pair - w[i];
      const tot = w[0] + w[1] + w[2];
      prefs.layout.cols = w.map((x) => (3 * x) / tot);
    }, () => delete prefs.layout.cols);
  }
  const ro = new ResizeObserver(() => placeSplitters());
  for (const el of [layout, stage, panelsEl, side, $('#viewport'), ...panels]) ro.observe(el);
  NARROW.addEventListener?.('change', placeSplitters);
  applyLayout();
  placeSplitters();
}

function wireUI() {
  wireTrace();
  wireSplitters();
  wireLightPad();
  document.querySelectorAll('#views button[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#t-wire').addEventListener('click', (e) => {
    state.wire = !state.wire; setWire();
  });
  $('#bay-gain').addEventListener('input', (e) => { prefs.bayGain = +e.target.value; savePrefs(); setBayGain(); });
  $('#t-light').addEventListener('click', () => { prefs.bay = !prefs.bay; savePrefs(); setLighting(); });
  $('#t-fixed').addEventListener('click', () => { prefs.fixedLight = prefs.fixedLight === false; savePrefs(); setLighting(); });
  $('#t-flip').addEventListener('click', (e) => { state.flip = !state.flip; e.currentTarget.classList.toggle('on', state.flip); });
  $('#btn-undo').addEventListener('click', () => histGo(-1));
  $('#btn-redo').addEventListener('click', () => histGo(1));
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase(), el = document.activeElement;
    if (key !== 'z' && key !== 'y') return;
    if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) return;   // typing has its own undo
    e.preventDefault();
    histGo(key === 'y' || e.shiftKey ? 1 : -1);
  });
  setLighting();
  wirePanels();
  $('#t-stringer').addEventListener('click', (e) => {
    state.stringer = !state.stringer; stringerGroup.visible = state.stringer; e.currentTarget.classList.toggle('on', state.stringer);
  });

  const sel = $('#preset');
  sel.innerHTML = `<option value="">Custom</option>` +
    Object.keys(state.schema.presets).map((k) => `<option>${k.replace(/"/g, '&quot;')}</option>`).join('');
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    state.fitted = false;
    applyParams(state.schema.presets[sel.value]);
  });

  $('#btn-save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.params, null, 2)], { type: 'application/json' });
    download(blob, `board_${ftin(state.params.length).replace(/'/g, 'ft').replace(/"/g, 'in').replace(/ /g, '')}.json`);
  });
  $('#file-load').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { applyParams(JSON.parse(await f.text())); sel.value = ''; state.fitted = false; } catch (err) { toast('Could not read that design file.'); }
    e.target.value = '';
  });

  const menu = $('#export-menu');
  $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => (menu.hidden = true));
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const { fmt, units } = b.dataset;
    const board = fmt === 'txt' ? state.board : buildBoard({ ...state.params, stations: 321, section_points: 160 });
    const name = `surfboard_${ftin(board.params.length).replace(/'/g, 'ft').replace(/"/g, 'in')}_${board.volume_l.toFixed(1)}L`;
    if (fmt === 'stl') saveFile(`${name}.stl`, toSTL(board, units));
    if (fmt === 'obj') saveFile(`${name}.obj`, toOBJ(board, units));
    if (fmt === 'txt') saveFile(`${name}_spec.txt`, specSheet(board));
  }));

  wireFeedback();
}

/* =========================================================================
   Saving files. On a normal website this is a plain download. Inside a
   claude.ai page, downloads go through the host, which only accepts some
   file types, so STL / OBJ are wrapped in a .zip there.
   ========================================================================= */
async function saveFile(name, data) {
  const host = typeof window.claude?.use === 'function' ? window.claude : null;
  if (host) {
    let hostDownloads = null;
    try { hostDownloads = await host.use('downloads'); } catch {}
    if (!hostDownloads) { toast('Saving files is not available in this view.'); return; }
    let filename = name, payload = data;
    if (/\.(stl|obj)$/i.test(name)) {
      payload = zipOne(name, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      filename = `${name}.zip`;
    }
    try { await hostDownloads.save({ filename, data: payload }); toast(`Saved ${filename}`); }
    catch (e) { if (e?.code !== 'declined') toast(`Could not save: ${e?.message || e?.code || e}`); }
    return;
  }
  if (COARSE && navigator.canShare) {                    // iPhone / iPad: hand the file to the share sheet (Save to Files, AirDrop, Messages)
    const type = { json: 'application/json', txt: 'text/plain', obj: 'text/plain', stl: 'model/stl' }[name.split('.').pop()] || 'application/octet-stream';
    const file = new File([data], name, { type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e?.name === 'AbortError') return; }   // anything else: fall through to a plain download
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const download = (blob, name) => saveFile(name, blob);

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* =========================================================================
   Feedback: a short form whose answers (plus the open design) are copied
   so the tester can paste them into a text or email.
   ========================================================================= */
function feedbackText() {
  const f = $('#feedback-form');
  const q = [['tried', 'Trying to design'], ['worked', 'Worked well'], ['confusing', 'Confusing / wrong'], ['wanted', 'Want next']];
  const lines = ['Surfboard Designer feedback', ''];
  for (const [k, label] of q) { const v = f.elements[k].value.trim(); if (v) lines.push(`${label}: ${v}`, ''); }
  if (f.elements.design.checked && state.board) {
    const s = state.board.stats;
    lines.push(`Board: ${ftin(s.length_in)} x ${fracIn(s.width_in)}" x ${fracIn(s.thickness_in)}", ${s.volume_l.toFixed(1)} L`,
      `Design: ${JSON.stringify(state.params)}`);
  }
  return lines.join('\n');
}

function wireFeedback() {
  const modal = $('#feedback'), form = $('#feedback-form');
  const close = () => (modal.hidden = true);
  $('#btn-feedback').addEventListener('click', () => { modal.hidden = false; form.elements.tried.focus(); });
  $('#fb-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  $('#fb-save').addEventListener('click', () => saveFile('surfboard_feedback.txt', feedbackText()));
  const canShareText = COARSE && typeof navigator.share === 'function';
  if (canShareText) $('#fb-send').textContent = 'Send feedback';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (canShareText) {                                  // straight into Messages / Mail
      try { await navigator.share({ title: 'Surfboard Designer feedback', text: feedbackText() }); return; }
      catch (err) { if (err?.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(feedbackText());
      toast('Copied. Paste it into a text or email.');
    } catch {
      toast('Copy was blocked here. Use "Save as file" instead.');
    }
  });
}

/* ========================================================================= */
function init() {
  state.schema = { groups: GROUPS, station_table: STATION_TABLE, defaults: DEFAULTS, presets: PRESETS };
  buildControls();
  wireUI();
  const saved = loadLocal();
  const first = Object.keys(state.schema.presets)[0];
  if (!saved) $('#preset').value = first;
  applyParams(saved || state.schema.presets[first]);
  histCommit();                                         // the starting point for undo
  resize();
}
init();

/* Installable app: offline copy via the service worker, and a one-time tip on iPhone / iPad
   (Safari has no install button of its own; it lives under Share). */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  try { navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch {}
}
(() => {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let seen = false;
  try { seen = localStorage.getItem('surfboard.installTip') === '1'; } catch {}
  const native = !!window.Capacitor?.isNativePlatform?.();      // already the App Store app
  if (!ios || installed || native || seen || window.self !== window.top) return;
  $('#install').hidden = false;
  $('#install-x').addEventListener('click', () => { $('#install').hidden = true; try { localStorage.setItem('surfboard.installTip', '1'); } catch {} });
})();
