import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBoard, curves, sliceInfo, specSheet, toSTL, toOBJ, zipOne, NULLABLE } from './geometry.js';
import { DEFAULTS, PRESETS, GROUPS, STATION_TABLE, TAIL_TYPES } from './data.js';

const $ = (s) => document.querySelector(s);
const state = {
  schema: null, params: {}, board: null, fieldEls: {}, cellEls: {}, mirrors: [],
  dirty: false, busy: false, wire: false, stringer: true, fitted: false,
  sel: null,      // id of the cross-section slice being edited, or null for the overview
  focus: null,    // which view is expanded: 'view' | 'plan' | 'profile' | 'sections' | null
};
const TAIL_CLOSES = Object.keys(TAIL_TYPES).filter((k) => TAIL_TYPES[k].closes);

// Viewer preferences (not part of the design): kept per browser
const prefs = { fix: true, vexProfile: 1, vexSections: 1, bay: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('surfboard.ui') || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem('surfboard.ui', JSON.stringify(prefs)); } catch {} };
const COLORS = { foam: '#f3efe6', accent: '#3cc8b4', warm: '#ff8a5b', sand: '#e8c872', muted: '#84949f', line: '#24313b', wood: '#9a7650' };

/* =========================================================================
   Number formatting: shapers think in feet-inches and sixteenths
   ========================================================================= */
function fracIn(v) {
  const neg = v < 0; v = Math.abs(v);
  let whole = Math.floor(v), n = Math.round((v - whole) * 16), d = 16;
  if (n === 16) { whole++; n = 0; }
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
  state.schema.groups.forEach((g, gi) => {
    const det = document.createElement('details');
    det.className = 'group';
    det.open = gi < 2;
    det.innerHTML = `<summary>${g.name}</summary><div class="fields"></div>`;
    g.fields.forEach((f) => det.querySelector('.fields').appendChild(makeField(f)));
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

function applyParams(p) {
  state.params = structuredClone({ ...state.schema.defaults, ...p });
  const P = state.params, a = P.anchors && typeof P.anchors === 'object' ? P.anchors : {};
  const pairs = (l) => (Array.isArray(l) ? l.filter((q) => Array.isArray(q) && q.length >= 2).map((q) => [+q[0], +q[1]]) : []);
  P.anchors = { outline: pairs(a.outline), rocker: pairs(a.rocker), thickness: pairs(a.thickness) };
  P.slices = (Array.isArray(P.slices) ? P.slices : []).filter((s) => s && Number.isFinite(s.x))
    .map((s, i) => ({ id: i + 1, x: s.x, deck: pairs(s.deck), bottom: pairs(s.bottom) }));
  state.sel = null;
  for (const [k, fe] of Object.entries(state.fieldEls)) fe.set(state.params[k]);
  for (const [k, ce] of Object.entries(state.cellEls)) ce.set(state.params[k]);
  updateVisibility();
  saveLocal();
  schedule();
}

const saveLocal = () => { try { localStorage.setItem('surfboard.params', JSON.stringify(state.params)); } catch {} };
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

// Shaping-bay lighting: hard light raking almost flat across the board from one side, with
// a weak fill from the other, above and below the rail line, on a matte blank. Because
// the light only grazes the surface, a degree or two of slope (deck dome, concave, a bump
// in the foil) shows up as a clear change in shade.
const bayLights = new THREE.Group();
for (const up of [1, -1]) {
  const key = new THREE.DirectionalLight(0xf2f6ff, 6.5), weak = new THREE.DirectionalLight(0xf2f6ff, 1.5);
  key.position.set(0, 6.3 * up, -60);       // about 6 degrees above / below level
  weak.position.set(0, 6.3 * up, 60);
  bayLights.add(key, weak);
}
bayLights.add(new THREE.HemisphereLight(0xffffff, 0x10151a, 0.06));
scene.add(studioLights, bayLights);
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
scene.add(boardMesh, wireMesh, stringerGroup);

function setLighting() {
  const bay = prefs.bay;
  bayLights.visible = bay; studioLights.visible = !bay; ground.visible = !bay;
  scene.environment = bay ? null : envMap;
  Object.assign(boardMat, bay
    ? { roughness: 0.95, clearcoat: 0, envMapIntensity: 0 }
    : { roughness: 0.45, clearcoat: 0.9, envMapIntensity: 0.75 });
  boardMat.color.set(bay ? '#f4f1ea' : '#ece6d8');
  boardMat.needsUpdate = true;
  renderer.toneMappingExposure = bay ? 1.05 : 0.92;
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
    bottom: [0, -0.85 * d, 0.001],
    side: [0, 0.04 * d, 0.8 * d],
    tail: [-0.95 * d, 0.07 * d, 0.0],
  };
  const target = new THREE.Vector3(0, cy, 0);
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

/* =========================================================================
   2D views: plan, profile, sections. Each is a zoomable canvas you edit on.
     round dot  = anchor point: click a curve to add one, drag to shape,
                  double-click (or right-click) to remove
     square     = a measurement; draggable when "Fix dimensions" is off
     diamond    = a cross-section slice; drag it along the board
   Scroll to zoom, drag empty space to pan when zoomed in.
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
    Object.assign(this, { c: canvas, drawFn, zoom: 1, mx: 0, my: 0, s: 1, s0: 1, vex: 1, w: 1, h: 1, handles: [], curves: [], drag: null });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
    canvas.addEventListener('dblclick', (e) => this.removeAt(e));
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

  /** Draw a point and remember it for hit-testing. h = { x, y, kind, color, locked, drag, remove, select, ghost } */
  point(ctx, h) {
    const px = this.X(h.x), py = this.Y(h.y);
    if (!h.ghost) this.handles.push({ ...h, px, py });
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = h.color; ctx.fillStyle = h.ghost ? 'transparent' : h.color;
    if (h.ghost) ctx.globalAlpha = 0.45;
    ctx.beginPath();
    if (h.kind === 'anchor') { ctx.arc(px, py, 4.5, 0, 7); ctx.fill(); ctx.strokeStyle = '#0e1317'; ctx.stroke(); }
    else if (h.kind === 'slice') { ctx.moveTo(px, py - 6); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 6); ctx.lineTo(px - 6, py); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#0e1317'; ctx.stroke(); }
    else { ctx.rect(px - 3.5, py - 3.5, 7, 7); if (h.locked) { ctx.fillStyle = '#141b21'; } ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }

  hit(px, py) {
    let best = null, bd = 13;
    for (const h of this.handles) {
      const d = Math.hypot(h.px - px, h.py - py) - (h.kind === 'anchor' ? 2 : 0);   // anchors win ties
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  curveHit(px, py) {
    let best = null, bd = 9;
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
    if (e.button !== 0) return;
    const [px, py] = this.pos(e);
    const h = this.hit(px, py);
    if (h && h.locked) { toast('Measurements are fixed. Untick "Fix dimensions" to drag them.'); return; }
    if (h) { h.select?.(); if (h.drag) this.drag = { fn: h.drag }; }
    else {
      const c = this.curveHit(px, py);
      if (c) this.drag = { fn: c.add(this.wx(px), this.wy(py)) };
      else if (this.zoom > 1) this.drag = { pan: [px, py, this.mx, this.my] };
    }
    if (this.drag) { this.c.setPointerCapture(e.pointerId); e.preventDefault(); }
    if (this.drag?.fn || h) schedule();
  }
  move(e) {
    const [px, py] = this.pos(e);
    if (!this.drag) {
      const h = this.hit(px, py);
      this.c.style.cursor = h ? (h.locked ? 'not-allowed' : 'grab') : this.curveHit(px, py) ? 'copy' : this.zoom > 1 ? 'move' : 'default';
      return;
    }
    if (this.drag.pan) {
      const [sx, sy, mx, my] = this.drag.pan;
      this.mx = mx - (px - sx) / this.s; this.my = my + (py - sy) / (this.vex * this.s);
      this.redraw();
      return;
    }
    this.drag.fn(this.wx(px), this.wy(py));
    schedule();
  }
  up() { if (this.drag) { this.drag = null; saveLocal(); } }
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
const tip = (v, ctx, msg) => { if (v.w > 300) v.text(ctx, msg, v.w / 2, v.h - 6, 'rgba(132,148,159,.8)', 'center'); };
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

  // cross-section slices
  for (const sl of p.slices) {
    const raw = P.slices.find((q) => q.id === sl.id);
    const half = lerpAt(x, h, sl.x), on = sl.id === state.sel;
    ctx.strokeStyle = SLICE_COLOR; ctx.globalAlpha = on ? 1 : 0.55; ctx.setLineDash(on ? [] : [2, 3]);
    ctx.beginPath(); ctx.moveTo(v.X(sl.x), v.Y(-half)); ctx.lineTo(v.X(sl.x), v.Y(half)); ctx.stroke();
    ctx.globalAlpha = 1;
    if (raw) v.point(ctx, {
      x: sl.x, y: 0, kind: 'slice', color: SLICE_COLOR,
      select: () => { state.sel = sl.id; },
      drag: (wx) => { raw.x = clip(snap(wx, 0.25), 2, state.board.params.length - 2); },
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
  for (const a of P.anchors.outline) {
    const y = lerpAt(x, h, a[0]);
    v.point(ctx, { x: a[0], y, kind: 'anchor', color: COLORS.foam, drag: dragFn(a), remove: () => dropFrom(P.anchors.outline, a) });
    v.point(ctx, { x: a[0], y: -y, kind: 'anchor', color: COLORS.foam, ghost: true });
  }
  v.curves.push({
    at: (wx, wy) => (wx < 0.8 || wx > L - 0.8 ? null : (wy < 0 ? -1 : 1) * lerpAt(x, h, wx)),
    add: (wx) => {
      const q = data._profiles, a = [wx, lerpAt(q.x, q.h, wx) - lerpAt(q.x, q.h0, wx)];
      P.anchors.outline.push(a);
      return dragFn(a);
    },
  });

  v.text(ctx, 'tail', v.X(0), v.h - 6, COLORS.muted, 'left');
  v.text(ctx, 'nose', v.X(L), v.h - 6, COLORS.muted, 'right');
  if (!P.anchors.outline.length) tip(v, ctx, 'click the outline to add a point');
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
  for (const a of P.anchors.rocker)
    v.point(ctx, { x: a[0], y: zb(a[0]), kind: 'anchor', color: COLORS.accent, drag: rockerDrag(a), remove: () => dropFrom(P.anchors.rocker, a) });
  for (const a of P.anchors.thickness)
    v.point(ctx, { x: a[0], y: dk(a[0]), kind: 'anchor', color: COLORS.foam, drag: deckDrag(a), remove: () => dropFrom(P.anchors.thickness, a) });
  const q = data._profiles, inside = (wx) => wx > 0.8 && wx < L - 0.8;
  v.curves.push({
    at: (wx) => (inside(wx) ? zb(wx) : null),
    add: (wx) => { const a = [wx, lerpAt(q.x, q.zb, wx) - lerpAt(q.x, q.zb0, wx)]; P.anchors.rocker.push(a); return rockerDrag(a); },
  }, {
    at: (wx) => (inside(wx) ? dk(wx) : null),
    add: (wx) => { const a = [wx, lerpAt(q.x, q.t, wx) / sc - lerpAt(q.x, q.foil0, wx)]; P.anchors.thickness.push(a); return deckDrag(a); },
  });

  v.text(ctx, `tail ${fracIn(bottom[0])}″ · ${fracIn(t12.rocker_in)}″ at 12″`, 4, 12, COLORS.warm, 'left');
  v.text(ctx, `nose ${fracIn(bottom[bottom.length - 1])}″ · ${fracIn(n12.rocker_in)}″ at 12″`, v.w - 4, 12, COLORS.sand, 'right');
  v.text(ctx, `${fracIn(data.stats.thickness_in)}″ thick`, v.X(xt), v.Y(dk(xt)) - 9, COLORS.foam);
  v.text(ctx, `low pt ${p.rocker_low_point > 0 ? '+' : ''}${fracIn(p.rocker_low_point)}″`, v.X(xl), v.Y(0) + 15, COLORS.accent);
  if (!P.anchors.rocker.length && !P.anchors.thickness.length) tip(v, ctx, 'click the bottom or deck line to add a point');
}

/* ---- sections: overview, or one slice you can shape ----------------------- */
function drawSections(v, data) {
  const k = sliceIndex(data), P = state.params;
  if (k < 0) {                                         // overview of the three reference sections (+ any slices)
    const secs = data.curves.sections, W = data.stats.width_in;
    let zmax = 0, zmin = 0;
    for (const s of Object.values(secs)) { zmax = Math.max(zmax, ...s.z); zmin = Math.min(zmin, ...s.z); }
    const ctx = v.begin([-W / 2 - 0.5, W / 2 + 0.5, zmin - 0.15, zmax + 0.15], prefs.vexSections, 16);
    ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(zmin - 0.1)); ctx.lineTo(v.X(0), v.Y(zmax + 0.1)); ctx.stroke();
    const cols = { center: COLORS.accent, tail_12: COLORS.warm, nose_12: COLORS.sand };
    for (const name of ['center', 'tail_12', 'nose_12']) {
      v.path(ctx, secs[name].y, secs[name].z, true);
      if (name === 'center') { ctx.fillStyle = 'rgba(60,200,180,0.08)'; ctx.fill(); }
      ctx.strokeStyle = cols[name]; ctx.lineWidth = 1.6; ctx.stroke();
    }
    tip(v, ctx, '+ Add a section to shape its deck and bottom');
    return;
  }

  const s = sliceInfo(data, k), raw = P.slices.find((q) => q.id === s.id);
  const N = 160, eta = Array.from({ length: N + 1 }, (_, i) => 1 - (1 - i / N) ** 2);   // denser toward the rail
  const ys = eta.map(s.y), dz = eta.map((e) => s.deck(e)), bz = eta.map((e) => s.bottom(e));
  const ctx = v.begin([-s.h - 0.5, s.h + 0.5, Math.min(...bz) - 0.3, Math.max(...dz) + 0.3], prefs.vexSections, 18);
  ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(v.X(0), v.Y(Math.min(...bz) - 0.2)); ctx.lineTo(v.X(0), v.Y(Math.max(...dz) + 0.2)); ctx.stroke();

  // right half deck (stringer -> rail), back along the bottom, across the left bottom, back along the left deck
  const outline = (d, b) => {
    const X = [...ys, ...[...ys].reverse(), ...ys.map((q) => -q), ...[...ys].reverse().map((q) => -q)];
    const Z = [...d, ...[...b].reverse(), ...b, ...[...d].reverse()];
    return [X, Z];
  };
  if (raw.deck.length || raw.bottom.length) {          // the shape without this slice's anchor points
    const [X0, Z0] = outline(eta.map((e) => s.deck(e, false)), eta.map((e) => s.bottom(e, false)));
    v.path(ctx, X0, Z0, true); ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  const [X1, Z1] = outline(dz, bz);
  v.path(ctx, X1, Z1, true);
  ctx.fillStyle = 'rgba(180,140,255,0.08)'; ctx.fill();
  ctx.strokeStyle = SLICE_COLOR; ctx.lineWidth = 1.8; ctx.stroke();

  const info = () => { const b = state.board, i = sliceIndex(b); return i < 0 ? null : sliceInfo(b, i); };
  const etaOf = (si, wx) => clip((Math.abs(wx) - si.yin) / Math.max(si.h - si.yin, 1e-6), 0.04, 0.96);
  for (const which of ['deck', 'bottom']) {
    const list = raw[which], col = which === 'deck' ? COLORS.foam : COLORS.accent;
    const dragFn = (a) => (wx, wz) => {
      const si = info(); if (!si) return;
      a[0] = etaOf(si, wx);
      a[1] = clip((wz - si[which](a[0], false)) / si.t, -0.6, 0.6);
    };
    for (const a of list) {
      v.point(ctx, { x: s.y(a[0]), y: s[which](a[0]), kind: 'anchor', color: col, drag: dragFn(a), remove: () => dropFrom(list, a) });
      v.point(ctx, { x: -s.y(a[0]), y: s[which](a[0]), kind: 'anchor', color: col, ghost: true });
    }
    v.curves.push({
      at: (wx) => { const e = (Math.abs(wx) - s.yin) / Math.max(s.h - s.yin, 1e-6); return e < 0.04 || e > 0.96 ? null : s[which](e); },
      add: (wx) => { const e = etaOf(s, wx), a = [e, s.offset(which, e)]; list.push(a); return dragFn(a); },
    });
  }
  const L = data.params.length;
  v.text(ctx, `${s.x > L / 2 ? `${fracIn(L - s.x)}″ from nose` : `${fracIn(s.x)}″ from tail`} · ${fracIn(2 * s.h)}″ wide · ${fracIn(s.t)}″ thick`, 4, 12, SLICE_COLOR, 'left');
  if (!raw.deck.length && !raw.bottom.length) tip(v, ctx, 'click the deck or bottom line to add a point');
}

const views2d = {
  plan: new View2D($('#c-plan'), drawPlan),
  profile: new View2D($('#c-rocker'), drawProfile),
  sections: new View2D($('#c-sections'), drawSections),
};
function drawPanels() { for (const v of Object.values(views2d)) v.redraw(); }

/* ---- slice bar, panel tools, expand / collapse ---------------------------- */
function sliceLabel(s, L) { return s.x > L / 2 ? `N ${fracIn(L - s.x)}″` : `T ${fracIn(s.x)}″`; }

function renderSliceBar(data) {
  const bar = $('#slicebar'), L = data.params.length, list = data.params.slices;
  const sig = JSON.stringify([state.sel, list.map((s) => [s.id, sliceLabel(s, L)])]);
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  bar.innerHTML = `<button data-id="" class="${state.sel === null ? 'on' : ''}">Overview</button>` +
    list.map((s) => `<button data-id="${s.id}" class="${s.id === state.sel ? 'on' : ''}" title="${s.x > L / 2 ? 'from the nose' : 'from the tail'}">${sliceLabel(s, L)}</button>`).join('') +
    `<button data-add title="Add a cross section you can shape">+ Add</button>` +
    (state.sel !== null ? `<button data-del title="Remove this cross section">Remove</button>` : '');
}

function addSlice() {
  const P = state.params, L = state.board.params.length;
  const xs = [0, ...P.slices.map((s) => s.x).filter((q) => q > 0 && q < L).sort((a, b) => a - b), L];
  let best = 0;
  for (let i = 1; i < xs.length - 1; i++) if (xs[i + 1] - xs[i] > xs[best + 1] - xs[best]) best = i;
  const id = 1 + Math.max(0, ...P.slices.map((s) => s.id || 0));
  P.slices.push({ id, x: snap((xs[best] + xs[best + 1]) / 2, 0.25), deck: [], bottom: [] });
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
  $('#slicebar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if ('add' in b.dataset) addSlice();
    else if ('del' in b.dataset) { state.params.slices = state.params.slices.filter((s) => s.id !== state.sel); state.sel = null; }
    else state.sel = b.dataset.id === '' ? null : Number(b.dataset.id);
    views2d.sections.zoom = 1;
    saveLocal(); schedule();
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    const name = panel.dataset.panel, v = views2d[name];
    panel.querySelector('.tools').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act; if (!act) return;
      if (act === 'max') setFocus(name);
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
        saveLocal(); schedule();
      }
    });
  });
  $('#t-max').addEventListener('click', () => setFocus('view'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.focus && $('#feedback').hidden) setFocus(state.focus); });
  syncPanelTools();
}

function syncPanelTools() {
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
  syncClearButtons();
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
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
  resize();
}
init();
