import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBoard, curves, sliceInfo, sectionAt, sectionBase, specSheet, toSTL, toOBJ, zipOne, NULLABLE, BOTTOM_LABELS } from './geometry.js';
import { DEFAULTS, PRESETS, GROUPS, STATION_TABLE, TAIL_TYPES } from './data.js';

const $ = (s) => document.querySelector(s);
const state = {
  schema: null, params: {}, board: null, fieldEls: {}, cellEls: {}, mirrors: [],
  dirty: false, busy: false, wire: false, stringer: true, fitted: false,
  sel: null,      // id of the cross-section slice being edited, or null while rolling through the board
  scrub: null,    // where the Sections view is looking, inches from the tail (null = the wide point)
  pt: null,       // the anchor point whose handle arms are showing
  flip: false,    // 3D view: board turned bottom up
  focus: null,    // which view is expanded: 'view' | 'plan' | 'profile' | 'sections' | null
};
const TAIL_CLOSES = Object.keys(TAIL_TYPES).filter((k) => TAIL_TYPES[k].closes);

// Viewer preferences (not part of the design): kept per browser
const prefs = { fix: true, vexProfile: 1, vexSections: 1, bay: true, edit: false };
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
    if (g.name === 'Bottom') det.querySelector('.fields').appendChild(buildBottomBox());
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
      <label class="toggle fix"><input type="checkbox" id="fix-dims"><span>Fix dimensions <small>only anchor points can be dragged on the graphs</small></span></label>
      <div class="help">Inches, fractions OK: 19 3/4. Leave a box blank and it is worked out from the rest of the board (shown as ~). Rocker is bottom height above a flat table.</div>
    </div>`;
  bindCell(det.querySelector('#wp-offset'), 'wide_point_offset', 0.25);
  const fix = det.querySelector('#fix-dims');
  fix.checked = prefs.fix;
  fix.addEventListener('change', () => { prefs.fix = fix.checked; savePrefs(); drawPanels(); });
  const body = det.querySelector('tbody');
  for (const row of t.rows) {
    const tr = document.createElement('tr');
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
    const xs = [0, ...P.bottom.map((r) => (r.from === 'nose' ? L - r.pos : r.pos)).sort((p, q) => p - q), L];
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
  const xn = (r) => (r.from === 'nose' ? r.pos : L - r.pos);
  P.bottom.sort((p, q) => xn(p) - xn(q));
  box.innerHTML = '';
  for (const r of P.bottom) {
    const el = document.createElement('div');
    el.className = 'brow';
    el.innerHTML = `<input class="cell pos" type="text" spellcheck="false" aria-label="Position in inches">
      <span>″ from the</span>
      <select class="from" aria-label="Measured from"><option value="nose">nose</option><option value="tail">tail</option></select>
      <button class="x" title="Remove this station" aria-label="Remove">×</button>
      <div class="line2"><select class="type" aria-label="Contour">${BOTTOM_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="cell d1" type="text" spellcheck="false"><input class="cell d2" type="text" spellcheck="false"></div>`;
    const q = (s) => el.querySelector(s);
    const paint = () => {
      const names = BOTTOM_DEPTHS[r.type];
      q('.line2').className = `line2 ${['none', 'one', ''][names.length]}`;
      q('.d1').hidden = names.length < 1; q('.d2').hidden = names.length < 2;
      q('.d1').value = fracIn(r.depth, 32); q('.d2').value = fracIn(r.depth2, 32);
      q('.d1').title = `${names[0] || ''} depth, inches`; q('.d2').title = `${names[1] || ''} depth, inches`;
      q('.d1').setAttribute('aria-label', q('.d1').title); q('.d2').setAttribute('aria-label', q('.d2').title);
      q('.pos').value = fracIn(r.pos);
    };
    q('.from').value = r.from; q('.type').value = r.type;
    paint();
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
    numeric('.pos', 'pos', 0, 240); numeric('.d1', 'depth', 0, 0.75); numeric('.d2', 'depth2', 0, 0.75);
    q('.from').addEventListener('change', () => { r.from = q('.from').value; bottomChanged(false); });
    q('.type').addEventListener('change', () => { r.type = q('.type').value; paint(); bottomChanged(false); });
    q('.x').addEventListener('click', () => { dropFrom(P.bottom, r); bottomChanged(true); });
    box.appendChild(el);
  }
  bottomUI.help.textContent = P.bottom.length
    ? 'Blended smoothly from station to station. The nose tip is flat and the station nearest the tail carries out the tail. Depths in inches, fractions OK: 1/16, 3/32, 1/4.'
    : 'Say what the bottom does at a few spots (for example 1/16″ concave 12″ from the nose, 1/4″ at center, vee 4″ from the tail) and it is blended in between. With no stations, the two sliders above are used.';
}

/* Sliders for the cross section picked in the Sections graph. They show that section's own
   deck dome, rails and bottom; moving one changes the board there and blends out toward
   the neighbouring sections and the tips. The board-wide Rails and Bottom sliders still
   set the starting point for every section. */
const SECTION_SLIDERS = [
  ['deck_dome', 'Deck dome', 0, 1, 0.01, 'frac', '0 = flat deck, 1 = strongly domed'],
  ['rail_fullness', 'Rail fullness', 0, 1, 0.01, 'frac', 'how much foam the rail carries'],
  ['rail_apex_in', 'Rail apex height', 0.125, 2, 0.0625, 'in', 'up from the flat bottom line'],
  ['rail_hardness', 'Rail edge', 0, 1, 0.01, 'frac', '0 = soft, 1 = hard edge'],
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
  const num = (v) => (Number.isFinite(v) ? v : null);
  // an anchor is [position, offset] plus, once its handle has been moved, [slope, left arm, right arm]
  const pts = (l) => (Array.isArray(l) ? l : []).filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
    .map((q) => (q.slice(2, 5).some(Number.isFinite) ? [+q[0], +q[1], num(q[2]), num(q[3]), num(q[4])] : [+q[0], +q[1]]));
  P.anchors = { outline: pts(a.outline), rocker: pts(a.rocker), thickness: pts(a.thickness) };
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
    return { id, x: s.x, adj, deck: pts(s.deck), bottom: pts(s.bottom) };
  });
  P.bottom = (Array.isArray(P.bottom) ? P.bottom : []).filter((r) => r && Number.isFinite(+r.pos)).map((r) => ({
    pos: +r.pos, from: r.from === 'nose' ? 'nose' : 'tail', type: BOTTOM_LABELS[r.type] ? r.type : 'flat',
    depth: clip(+r.depth || 0, 0, 0.75), depth2: clip(+r.depth2 || 0, 0, 0.75) }));
  state.sel = P.slices.some((s) => s.id === keepSel) ? keepSel : null;
  state.pt = null;
  for (const [k, fe] of Object.entries(state.fieldEls)) fe.set(state.params[k]);
  for (const [k, ce] of Object.entries(state.cellEls)) ce.set(state.params[k]);
  renderBottomTable();
  updateVisibility();
  saveLocal();
  schedule();
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
const bayLamp = (color, intensity, x, y, z) => {
  const lamp = new THREE.DirectionalLight(color, intensity);
  lamp.position.set(x, y, z);
  bayLights.add(lamp, lamp.target);                    // target in the same group: the direction turns with the board
};
for (const [side, color] of [[1, 0xfff6ec], [-1, 0xeef3ff]]) {
  bayLamp(color, 4.6, 0, 2.6, 60 * side);              // deck: about 2.5 degrees above level
  bayLamp(color, 11, 0, -0.75, 60 * side);             // bottom: under 1 degree, and brighter
}
for (const end of [1, -1]) for (const up of [1, -1]) bayLamp(0xf2f6ff, 0.3, 60 * end, 14 * up, 0);   // a little down the length, for rocker and foil
bayLights.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 0.05));
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
const wireMesh = new THREE.Mesh(new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: 0x1f5f57, wireframe: true, transparent: true, opacity: 0.35 }));
wireMesh.visible = false;
const stringerMat = new THREE.MeshStandardMaterial({ color: COLORS.wood, roughness: 0.6 });
const stringerGroup = new THREE.Group();
// outline of the cross section the Sections view is looking at
const ring = new THREE.LineLoop(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.95, depthTest: false }));
ring.renderOrder = 5;
ring.visible = false;
const boardGroup = new THREE.Group().add(boardMesh, wireMesh, stringerGroup, ring, bayLights);   // turns over as one for "Bottom up"
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
  const s = sectionAt(data, x), o = sectionOutline(s, 40), zb = lerpAt(pr.x, pr.zb, x);
  const P = new Float32Array(o.X.length * 3);
  for (let i = 0; i < o.X.length; i++) { P[3 * i] = x - L / 2; P[3 * i + 1] = zb + o.Z[i]; P[3 * i + 2] = -o.X[i]; }
  ring.geometry.dispose();
  ring.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (k >= 0) { clearTimeout(ringTimer); ringTimer = 0; ring.visible = true; return; }
  if (linger) { clearTimeout(ringTimer); ring.visible = true; ringTimer = setTimeout(() => { ringTimer = 0; ring.visible = false; }, 2500); }
  else if (!ringTimer) ring.visible = false;
}

function setLighting() {
  const bay = prefs.bay;
  bayLights.visible = bay; studioLights.visible = !bay; ground.visible = !bay;
  scene.environment = bay ? null : envMap;
  Object.assign(boardMat, bay
    ? { roughness: 0.95, clearcoat: 0, envMapIntensity: 0 }
    : { roughness: 0.45, clearcoat: 0.9, envMapIntensity: 0.75 });
  boardMat.color.set(bay ? '#f4f1ea' : '#ece6d8');
  boardMat.needsUpdate = true;
  renderer.toneMappingExposure = bay ? 1.0 : 0.92;
  viewport.classList.toggle('bay', bay);
  $('#t-light').classList.toggle('on', bay);
}

// board space (x along, y across, z up) -> three space (X along, Y up, Z across), centered on length
const toThree = (x, y, z, L) => [x - L / 2, z, -y];

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
  boardMesh.geometry = toCreasedNormals(g, THREE.MathUtils.degToRad(40));
  wireMesh.geometry.dispose();
  wireMesh.geometry = g;
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
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (!animate) { camera.position.copy(to); controls.target.copy(target); controls.update(); return; }
  tween = { t0: performance.now(), dur: 550, fromP: camera.position.clone(), toP: to, fromT: controls.target.clone(), toT: target };
}

function animate(now) {
  requestAnimationFrame(animate);
  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(tween.fromP, tween.toP, e);
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
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
    else if (!prefs.edit && !h.view) ctx.globalAlpha = 0.5;      // looking, not editing
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
      if (h.on && prefs.edit) { ctx.beginPath(); ctx.arc(px, py, 8 * big, 0, 7); ctx.strokeStyle = h.color; ctx.lineWidth = 1; ctx.stroke(); }
    }
    else if (h.kind === 'slice') { ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#0e1317'; ctx.stroke(); }
    else { ctx.rect(px - 3.5 * big, py - 3.5 * big, 7 * big, 7 * big); if (h.locked) { ctx.fillStyle = '#141b21'; } ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }

  hit(px, py, all = prefs.edit) {
    let best = null, bd = this.touch ? 24 : 13;
    for (const h of this.handles) {
      if (!all && !h.view) continue;
      const d = Math.hypot(h.px - px, h.py - py) - (h.kind === 'anchor' ? 2 : 0) - (h.kind === 'scrub' ? -6 : 0);   // anchors win ties
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  curveHit(px, py) {
    let best = null, bd = this.touch ? 18 : 9;
    const wx = this.wx(px), wy = this.wy(py);
    for (const c of this.curves) {
      const y = c.at(wx, wy);
      if (y === null || !Number.isFinite(y)) continue;
      const d = Math.abs(this.Y(y) - py);
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
      if (this.drag?.undo) { this.drag.undo(); schedule(); }   // the first finger was not adding a point after all
      this.drag = null;
      const [a, b] = [...this.ptrs.values()], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      this.pinch = { d: Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1), zoom: this.zoom, wx: this.wx(mx), wy: this.wy(my) };
      return;
    }
    const h = this.hit(px, py);
    if (!prefs.edit) {                                  // looking only: pan, and the few things that are not edits
      if (h) { h.select?.(); if (h.drag) this.drag = { fn: h.drag, light: h.light }; }
      else {
        if (this.hit(px, py, true)) hintEdit();
        if (this.zoom > 1) this.drag = { pan: [px, py, this.mx, this.my] };
      }
      if (this.drag) { try { this.c.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); }
      if (h) (h.light ? scrubChanged() : schedule());
      return;
    }
    if (h && h.locked) { toast('Measurements are fixed. Untick "Fix dimensions" to drag them.'); return; }
    if (h && h.remove && this.touch) {                  // double-tap a point to remove it
      const now = performance.now(), t = this.lastTap;
      if (t && now - t.t < 420 && Math.hypot(t.px - px, t.py - py) < 30) { this.lastTap = null; h.remove(); saveLocal(); schedule(); return; }
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
    if (h?.light) scrubChanged();
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
      this.c.style.cursor = h ? (h.locked ? 'not-allowed' : 'grab') : prefs.edit && this.curveHit(px, py) ? 'copy' : this.zoom > 1 ? 'move' : 'default';
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
    if (this.drag.light) scrubChanged(); else schedule();
  }
  up(e) {
    if (e) this.ptrs.delete(e.pointerId); else this.ptrs.clear();
    if (this.ptrs.size < 2) this.pinch = null;
    if (this.drag) { const edit = !this.drag.light && !this.drag.pan; this.drag = null; if (edit) saveLocal(); }
  }
  removeAt(e) {
    const h = this.hit(...this.pos(e));
    if (h?.remove) { h.remove(); saveLocal(); schedule(); }
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

/** Full outline of a section (from sectionAt): right deck, right bottom, left bottom, left deck. */
function sectionOutline(s, N = 160, anchors = true) {
  const eta = Array.from({ length: N + 1 }, (_, i) => 1 - (1 - i / N) ** 2);   // denser toward the rail
  const ys = eta.map(s.y), d = eta.map((e) => s.deck(e, anchors)), b = eta.map((e) => s.bottom(e, anchors));
  return { X: [...ys, ...rev(ys), ...ys.map((q) => -q), ...rev(ys).map((q) => -q)], Z: [...d, ...rev(b), ...b, ...rev(d)], d, b };
}

/**
 * The two handle arms of the selected anchor point `a` = [position, offset, slope, left arm, right arm].
 * (x0, y0) is the point on the graph; `res` the handle the geometry is using now; a step of 1 in
 * position is `kx` graph units across; the drawn curve is base + k * offset with the base sloping S0.
 */
function drawArms(v, ctx, a, x0, y0, res, { S0, k, kx = 1, color, mMax = 3, aMin = 0.5, aMax = 60 }) {
  if (!prefs.edit || state.pt !== a || !res) return;
  const S = S0 + k * res.m;                             // graph height per unit of position
  for (const side of [-1, 1]) {
    const len = side < 0 ? res.aL : res.aR, slot = side < 0 ? 3 : 4;
    v.point(ctx, {
      x: x0 + side * len * kx, y: y0 + side * len * S, kind: 'arm', color, ax: x0, ay: y0,
      drag: (wx, wy) => {
        const d = Math.max((side * (wx - x0)) / kx, aMin);
        while (a.length < 5) a.push(null);
        a[2] = clip(((side * (wy - y0)) / d - S0) / k, -mMax, mMax);
        a[slot] = clip(d, aMin, aMax);
      },
      remove: () => { a.length = 2; },                  // double-click: back to the automatic handle
    });
  }
}
const armOf = (list, a) => list.find((r) => Math.abs(r.x - a[0]) < 1e-6);
/** A measurement square. `apply(wx, wy)` receives the pointer in board inches. */
const station = (v, ctx, x, y, color, apply) =>
  v.point(ctx, { x, y, kind: 'station', color, locked: prefs.fix, drag: prefs.fix ? null : apply });

/* ---- plan: the outline --------------------------------------------------- */
function drawPlan(v, data) {
  const { x, h, yin } = data.curves.outline, p = data.params, P = state.params;
  const L = p.length, W = data.stats.width_in;
  const ctx = v.begin([0, L, -W / 2 - 1.5, W / 2 + 1.5]);

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
  station(v, ctx, 12, lerpAt(x, h, 12), COLORS.warm, (wx, wy) => setParam('tail_width_12', snap(2 * Math.abs(wy), 0.0625), 'graph'));
  station(v, ctx, L - 12, lerpAt(x, h, L - 12), COLORS.sand, (wx, wy) => setParam('nose_width_12', snap(2 * Math.abs(wy), 0.0625), 'graph'));
  station(v, ctx, xw, W / 2, COLORS.accent, (wx, wy) => {
    setParam('wide_point_offset', snap(wx - state.board.params.length / 2, 0.25), 'graph');
    setParam('width', snap(2 * Math.abs(wy), 0.125), 'graph');
  });
  if (!TAIL_CLOSES.includes(p.tail_type))
    station(v, ctx, 0, p.tail_block_width / 2, COLORS.warm, (wx, wy) => setParam('tail_block_width', snap(2 * Math.abs(wy), 0.125), 'graph'));

  // anchor points on the outline (shown on both rails, they are one point)
  const dragFn = (a) => (wx, wy) => {
    const q = state.board._profiles, LL = state.board.params.length;
    a[0] = clip(wx, 0.8, LL - 0.8);
    a[1] = clip(Math.abs(wy) - lerpAt(q.x, q.h0, a[0]), -6, 6);
  };
  const pq = data._profiles;
  for (const a of P.anchors.outline) {
    const y = lerpAt(x, h, a[0]);
    v.point(ctx, { x: a[0], y, kind: 'anchor', color: COLORS.foam, on: state.pt === a, select: () => { state.pt = a; }, drag: dragFn(a), remove: () => dropFrom(P.anchors.outline, a) });
    v.point(ctx, { x: a[0], y: -y, kind: 'anchor', color: COLORS.foam, ghost: true });
    drawArms(v, ctx, a, a[0], y, armOf(pq.arms.outline, a), { S0: slopeAt(pq.x, pq.h0, a[0]), k: 1, color: COLORS.foam });
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
  tip(v, ctx, P.anchors.outline.length ? 'drag a point · drag its arms to blend · double-click removes' : 'click the outline to add a point');
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

  // measurements: rocker on the bottom line, thickness on the deck line
  const now = () => state.board, bz = (xq) => lerpAt(now()._profiles.x, now()._profiles.zb, xq);
  station(v, ctx, 0, bottom[0], COLORS.warm, (wx, wy) => setParam('tail_rocker', snap(Math.max(wy, 0), 0.0625), 'graph'));
  station(v, ctx, 12, zb(12), COLORS.warm, (wx, wy) => setParam('tail_rocker_12', snap(Math.max(wy, 0), 0.0625), 'graph'));
  station(v, ctx, L - 12, zb(L - 12), COLORS.sand, (wx, wy) => setParam('nose_rocker_12', snap(Math.max(wy, 0), 0.0625), 'graph'));
  station(v, ctx, L, bottom[bottom.length - 1], COLORS.sand, (wx, wy) => setParam('nose_rocker', snap(Math.max(wy, 0), 0.0625), 'graph'));
  station(v, ctx, xl, 0, COLORS.accent, (wx) => setParam('rocker_low_point', snap(wx - now().params.length / 2, 0.25), 'graph'));
  station(v, ctx, 12, dk(12), COLORS.warm, (wx, wy) => setParam('tail_thickness_12', snap(Math.max(wy - bz(12), 0.3) / now().thickness_scale, 0.0625), 'graph'));
  station(v, ctx, L - 12, dk(L - 12), COLORS.sand, (wx, wy) => setParam('nose_thickness_12', snap(Math.max(wy - bz(now().params.length - 12), 0.3) / now().thickness_scale, 0.0625), 'graph'));
  station(v, ctx, xt, dk(xt), COLORS.foam, (wx, wy) => {
    const LL = now().params.length;
    setParam('thickness_point_offset', snap(wx - LL / 2, 0.25), 'graph');
    setParam('thickness', snap(Math.max(wy - bz(clip(wx, 0, LL)), 1.5) / now().thickness_scale, 0.0625), 'graph');
  });

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
  const q = data._profiles, inside = (wx) => wx > 0.8 && wx < L - 0.8;
  for (const a of P.anchors.rocker) {
    v.point(ctx, { x: a[0], y: zb(a[0]), kind: 'anchor', color: COLORS.accent, on: state.pt === a, select: () => { state.pt = a; }, drag: rockerDrag(a), remove: () => dropFrom(P.anchors.rocker, a) });
    drawArms(v, ctx, a, a[0], zb(a[0]), armOf(q.arms.rocker, a), { S0: slopeAt(q.x, q.zb0, a[0]), k: 1, color: COLORS.accent });
  }
  for (const a of P.anchors.thickness) {
    v.point(ctx, { x: a[0], y: dk(a[0]), kind: 'anchor', color: COLORS.foam, on: state.pt === a, select: () => { state.pt = a; }, drag: deckDrag(a), remove: () => dropFrom(P.anchors.thickness, a) });
    drawArms(v, ctx, a, a[0], dk(a[0]), armOf(q.arms.thickness, a), { S0: slopeAt(q.x, q.zb, a[0]) + sc * slopeAt(q.x, q.foil0, a[0]), k: sc, color: COLORS.foam });
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
  v.text(ctx, `${shapeText(s.shape)} · rail apex ${fracIn(s.apex_in)}″ up`, 4, 25, COLORS.sand, 'left');
}

function drawSections(v, data) {
  const k = sliceIndex(data), P = state.params;
  const W = data.stats.width_in, T = data.stats.thickness_in;
  if (k < 0) {                                         // rolling through: the section at the scrub position, on fixed axes
    const s = sectionAt(data, scrubX(data));
    const ctx = v.begin([-W / 2 - 0.6, W / 2 + 0.6, -0.75, T + 0.45], prefs.vexSections, 16);
    ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(-0.6)); ctx.lineTo(v.X(0), v.Y(T + 0.3)); ctx.stroke();
    const ref = sectionOutline(sectionAt(data, data.params.length / 2 + data.params.wide_point_offset), 60);   // the wide point, for scale
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
  const ctx = v.begin([-s.h - 0.6, s.h + 0.6, Math.min(...cur.b, 0) - 0.3, Math.max(...cur.d) + 0.4], prefs.vexSections, 18);
  ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(Math.min(...cur.b) - 0.2)); ctx.lineTo(v.X(0), v.Y(Math.max(...cur.d) + 0.2)); ctx.stroke();
  sectionGuides(v, ctx, s, COLORS.sand);
  if (raw.deck.length || raw.bottom.length) {          // the shape without this slice's anchor points
    const o0 = sectionOutline(s, 160, false);
    v.path(ctx, o0.X, o0.Z, true); ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  v.path(ctx, cur.X, cur.Z, true);
  ctx.fillStyle = 'rgba(180,140,255,0.08)'; ctx.fill();
  ctx.strokeStyle = SLICE_COLOR; ctx.lineWidth = 1.8; ctx.stroke();

  const info = () => { const b = state.board, i = sliceIndex(b); return i < 0 ? null : sliceInfo(b, i); };
  const etaOf = (si, wx) => clip((Math.abs(wx) - si.yin) / Math.max(si.h - si.yin, 1e-6), 0.04, 0.96);
  const span = Math.max(s.h - s.yin, 1e-6);            // one unit of eta, in inches across
  for (const which of ['deck', 'bottom']) {
    const list = raw[which], col = which === 'deck' ? COLORS.foam : COLORS.accent;
    const dragFn = (a) => (wx, wz) => {
      const si = info(); if (!si) return;
      a[0] = etaOf(si, wx);
      a[1] = clip((wz - si[which](a[0], false)) / si.t, -0.6, 0.6);
    };
    for (const a of list) {
      const y0 = s.y(a[0]), z0 = s[which](a[0]), de = 0.01;
      v.point(ctx, { x: y0, y: z0, kind: 'anchor', color: col, on: state.pt === a, select: () => { state.pt = a; }, drag: dragFn(a), remove: () => dropFrom(list, a) });
      v.point(ctx, { x: -y0, y: z0, kind: 'anchor', color: col, ghost: true });
      const S0 = (s[which](Math.min(a[0] + de, 1), false) - s[which](Math.max(a[0] - de, 0), false)) / (2 * de);
      drawArms(v, ctx, a, y0, z0, s.arms[which].find((r) => Math.abs(r.x - a[0]) < 1e-9), { S0, k: s.t, kx: span, color: col, mMax: 6, aMin: 0.03, aMax: 1 });
    }
    v.curves.push({
      at: (wx) => { const e = (Math.abs(wx) - s.yin) / span; return e < 0.04 || e > 0.96 ? null : s[which](e); },
      add: (wx) => { const e = etaOf(s, wx), a = [e, s.offset(which, e)]; list.push(a); state.pt = a; return { fn: dragFn(a), undo: () => dropFrom(list, a) }; },
    });
  }
  sectionCaption(v, ctx, data, s, SLICE_COLOR);
  tip(v, ctx, raw.deck.length || raw.bottom.length ? 'drag a point · drag its arms to blend · double-click removes' : 'sliders on the left · click a line to add a point');
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
  P.slices.push({ id, x, adj: {}, deck: [], bottom: [] });
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
      if (act === 'edit') { prefs.edit = !prefs.edit; if (!prefs.edit) state.pt = null; savePrefs(); syncPanelTools(); drawPanels(); }
      if (act === 'fit') v.fit();
      if (act === 'in') v.zoomBy(1.6);
      if (act === 'vex') {
        const key = name === 'profile' ? 'vexProfile' : 'vexSections';
        prefs[key] = prefs[key] === 1 ? 3 : 1; savePrefs(); v.zoom = 1; syncPanelTools(); v.redraw();
      }
      if (act === 'clear') {
        const P = state.params;
        if (name === 'plan') P.anchors.outline = [];
        if (name === 'profile') { P.anchors.rocker = []; P.anchors.thickness = []; }
        if (name === 'sections') { const s = P.slices.find((q) => q.id === state.sel); if (s) { s.deck = []; s.bottom = []; } }
        state.pt = null;
        saveLocal(); schedule();
      }
    });
  });
  $('#t-max').addEventListener('click', () => setFocus('view'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#feedback').hidden) return;
    if (state.sel !== null) exitSection();              // Esc leaves the section being shaped first, then an expanded view
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
  const has = { plan: P.anchors.outline.length, profile: P.anchors.rocker.length + P.anchors.thickness.length, sections: sl ? sl.deck.length + sl.bottom.length : 0 };
  for (const [name, n] of Object.entries(has)) document.querySelector(`.panel[data-panel="${name}"] [data-act="clear"]`).hidden = !n;
}

/* =========================================================================
   Stats and render
   ========================================================================= */
function render(data) {
  updateMesh(data);
  drawPanels();
  renderSliceBar(data);
  refreshSectionGroup(data);
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
function wireUI() {
  document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#t-wire').addEventListener('click', (e) => {
    state.wire = !state.wire; wireMesh.visible = state.wire; e.currentTarget.classList.toggle('on', state.wire);
  });
  $('#t-light').addEventListener('click', () => { prefs.bay = !prefs.bay; savePrefs(); setLighting(); });
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
    const board = fmt === 'txt' ? state.board : buildBoard({ ...state.params, stations: 321, section_points: 96 });
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
