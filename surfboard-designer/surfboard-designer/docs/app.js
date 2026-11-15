import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBoard, curves, specSheet, toSTL, toOBJ, zipOne } from './geometry.js';
import { DEFAULTS, PRESETS, GROUPS, STATION_TABLE } from './data.js';

const $ = (s) => document.querySelector(s);
const state = {
  schema: null, params: {}, board: null, fieldEls: {}, cellEls: {}, mirrors: [],
  dirty: false, busy: false, wire: false, stringer: true, fitted: false,
};
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
      <div class="help">Inches, fractions OK: 19 3/4. Rocker is bottom height above a flat table.</div>
    </div>`;
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
        const set = (v) => (inp.value = fracIn(v));
        const commit = (v) => { set(v); setParam(key, v, 'cell'); };
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('change', () => {
          const v = parseVal(inp.value);
          if (Number.isFinite(v)) commit(v); else set(state.params[key]);
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') inp.blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            commit(+(state.params[key] + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.5 : 0.0625)).toFixed(5));
          }
        });
        td.appendChild(inp);
        state.cellEls[key] = { set };
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
    const set = (v) => { r.value = v; t.value = fmt(v, f.unit); paint(v); };
    r.addEventListener('input', () => { const v = parseFloat(r.value); t.value = fmt(v, f.unit); paint(v); setParam(f.key, v, 'slider'); });
    t.addEventListener('change', () => {
      const v = parseVal(t.value);
      if (Number.isFinite(v)) { set(v); setParam(f.key, v, 'field'); } else set(state.params[f.key]);
    });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') t.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = +(state.params[f.key] + (e.key === 'ArrowUp' ? 1 : -1) * f.step * (e.shiftKey ? 8 : 1)).toFixed(5);
        set(v); setParam(f.key, v, 'field');
      }
    });
    state.fieldEls[f.key] = { f, el, set, note: el.querySelector('.note') };
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
const foil12 = (p, side, T0, e0, T1, e1) =>
  T0 - e0 > 1e-6 ? { [`${side}_thickness_12`]: e1 + ((p[`${side}_thickness_12`] - e0) / (T0 - e0)) * (T1 - e1) } : {};
const rocker12 = (p, side, o, n) => ({ [`${side}_rocker_12`]: o > 1e-6 ? (p[`${side}_rocker_12`] * n) / o : 0.42 * n });
const LINKS = {
  nose_rocker: (o, n, p) => rocker12(p, 'nose', o, n),
  tail_rocker: (o, n, p) => rocker12(p, 'tail', o, n),
  thickness: (o, n, p) => ({ ...foil12(p, 'nose', o, p.nose_thickness, n, p.nose_thickness), ...foil12(p, 'tail', o, p.tail_thickness, n, p.tail_thickness) }),
  nose_thickness: (o, n, p) => foil12(p, 'nose', p.thickness, o, p.thickness, n),
  tail_thickness: (o, n, p) => foil12(p, 'tail', p.thickness, o, p.thickness, n),
};

function showValue(key, v, except) {
  if (except !== 'cell') state.cellEls[key]?.set(v);
  if (except !== 'field') state.fieldEls[key]?.set(v);
}

function setParam(key, v, src) {
  const linked = src === 'slider' && LINKS[key] ? LINKS[key](state.params[key], v, state.params) : {};
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
  state.params = { ...state.schema.defaults, ...p };
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

const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 80, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 40, bottom: -40, near: 1, far: 250 });
sun.shadow.radius = 6;
const fill = new THREE.DirectionalLight(0xcfe6ff, 0.7);
fill.position.set(-40, -60, -30);
scene.add(sun, fill, new THREE.HemisphereLight(0xdfefff, 0x1a2228, 0.5));

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
  renderer.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
  if (state.board) {
    drawPanels(state.board);
    if (!state.userMoved && !tween) setView(state.view || 'threeq', false);   // keep the board framed until they grab it
  }
}
controls.addEventListener('start', () => (state.userMoved = true));
new ResizeObserver(resize).observe(viewport);
renderer.domElement.addEventListener('pointerdown', () => $('#hint').classList.add('gone'), { once: true });

/* =========================================================================
   2D views
   ========================================================================= */
function canvasCtx(c) {
  const r = c.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.lineJoin = 'round';
  return { ctx, w: r.width, h: r.height };
}

// equal-aspect fit (times a vertical exaggeration) into the canvas
function fit(w, h, [x0, x1, y0, y1], vex = 1, pad = 16) {
  const s = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / ((y1 - y0) * vex));
  const ox = (w - (x1 - x0) * s) / 2;
  const oy = (h - (y1 - y0) * vex * s) / 2;
  return { X: (x) => ox + (x - x0) * s, Y: (y) => h - (oy + (y - y0) * vex * s), s };
}

function path(ctx, xs, ys, T, close = false) {
  ctx.beginPath();
  xs.forEach((x, i) => (i ? ctx.lineTo(T.X(x), T.Y(ys[i])) : ctx.moveTo(T.X(x), T.Y(ys[i]))));
  if (close) ctx.closePath();
}

function label(ctx, text, x, y, color = COLORS.muted, align = 'center') {
  ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(text, x, y);
}

function drawPlan(data) {
  const { ctx, w, h } = canvasCtx($('#c-plan'));
  const { x, h: hw, yin } = data.curves.outline;
  const L = data.params.length, W = data.stats.width_in;
  const T = fit(w, h, [0, L, -W / 2 - 1.5, W / 2 + 1.5], 1, 18);

  ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1;
  for (let gx = 0; gx <= L; gx += 12) { ctx.beginPath(); ctx.moveTo(T.X(gx), T.Y(-W / 2)); ctx.lineTo(T.X(gx), T.Y(W / 2)); ctx.stroke(); }

  const n = x.length, notch = [];
  for (let i = 0; i < n; i++) if (yin[i] > 0) notch.push(i);
  const px = [...x, ...[...x].reverse(), ...notch.map((i) => x[i]), ...[...notch].reverse().map((i) => x[i])];
  const py = [...hw, ...[...hw].reverse().map((v) => -v), ...notch.map((i) => -yin[i]), ...[...notch].reverse().map((i) => yin[i])];
  path(ctx, px, py, T, true);
  ctx.fillStyle = 'rgba(243,239,230,0.08)'; ctx.fill();
  ctx.strokeStyle = COLORS.foam; ctx.lineWidth = 1.6; ctx.stroke();

  const s = data.curves.stringer;
  ctx.setLineDash([4, 4]); ctx.strokeStyle = COLORS.wood; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(T.X(s.x[0]), T.Y(0)); ctx.lineTo(T.X(s.x[s.x.length - 1]), T.Y(0)); ctx.stroke();

  // 12" stations and wide point
  const marks = [
    [12, `T12 ${fracIn(data.stats.tail_width_12_in)}″`, COLORS.warm],
    [L - 12, `N12 ${fracIn(data.stats.nose_width_12_in)}″`, COLORS.sand],
    [L / 2 + data.params.wide_point_offset, `WP ${fracIn(W)}″`, COLORS.accent],
  ];
  for (const [mx, txt, col] of marks) {
    const half = Math.max(...interpAt(x, hw, mx));
    ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(T.X(mx), T.Y(-half)); ctx.lineTo(T.X(mx), T.Y(half)); ctx.stroke();
    label(ctx, txt, T.X(mx), T.Y(W / 2 + 0.6) - 2, col);
  }
  ctx.setLineDash([]);
  label(ctx, 'tail', T.X(0), h - 4, COLORS.muted, 'left');
  label(ctx, 'nose', T.X(L), h - 4, COLORS.muted, 'right');
}

function interpAt(xs, ys, xq) {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] >= xq) { const t = (xq - xs[i - 1]) / (xs[i] - xs[i - 1]); return [ys[i - 1] + t * (ys[i] - ys[i - 1])]; }
  }
  return [ys[ys.length - 1]];
}

function drawRocker(data) {
  const { ctx, w, h } = canvasCtx($('#c-rocker'));
  const { x, bottom, deck } = data.curves.rocker;
  const L = data.params.length;
  const zmax = Math.max(...deck) + 0.6;
  const T = fit(w, h, [0, L, -0.4, zmax], 3, 18);

  ctx.strokeStyle = COLORS.line; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(T.X(0), T.Y(0)); ctx.lineTo(T.X(L), T.Y(0)); ctx.stroke(); ctx.setLineDash([]);

  path(ctx, [...x, ...[...x].reverse()], [...deck, ...[...bottom].reverse()], T, true);
  ctx.fillStyle = 'rgba(243,239,230,0.08)'; ctx.fill();
  path(ctx, x, deck, T); ctx.strokeStyle = COLORS.foam; ctx.lineWidth = 1.5; ctx.stroke();
  path(ctx, x, bottom, T); ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1.8; ctx.stroke();

  const p = data.params;
  const xl = L / 2 + p.rocker_low_point;
  ctx.fillStyle = COLORS.accent; ctx.beginPath(); ctx.arc(T.X(xl), T.Y(0), 3, 0, 7); ctx.fill();
  label(ctx, `low pt ${p.rocker_low_point > 0 ? '+' : ''}${fracIn(p.rocker_low_point)}″`, T.X(xl), T.Y(0) + 13, COLORS.accent);
  const [, n12, , t12] = data.stats.stations;   // nose tip, 12" from nose, wide point, 12" from tail, tail end
  for (const [sx, row, col] of [[12, t12, COLORS.warm], [L - 12, n12, COLORS.sand]]) {
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(T.X(sx), T.Y(row.rocker_in)); ctx.lineTo(T.X(sx), T.Y(row.rocker_in + row.thickness_in)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = col;
    for (const z of [row.rocker_in, row.rocker_in + row.thickness_in]) { ctx.beginPath(); ctx.arc(T.X(sx), T.Y(z), 2.5, 0, 7); ctx.fill(); }
  }
  label(ctx, `tail ${fracIn(bottom[0])}″ · ${fracIn(t12.rocker_in)}″ at 12″`, 4, 12, COLORS.warm, 'left');
  label(ctx, `nose ${fracIn(bottom[bottom.length - 1])}″ · ${fracIn(n12.rocker_in)}″ at 12″`, w - 4, 12, COLORS.sand, 'right');
  label(ctx, `${fracIn(data.stats.thickness_in)}″ thick`, T.X(L / 2 + p.thickness_point_offset), T.Y(Math.max(...deck)) - 6, COLORS.foam);
}

function drawSections(data) {
  const { ctx, w, h } = canvasCtx($('#c-sections'));
  const secs = data.curves.sections;
  const W = data.stats.width_in;
  let zmax = 0, zmin = 0;
  for (const s of Object.values(secs)) { zmax = Math.max(zmax, ...s.z); zmin = Math.min(zmin, ...s.z); }
  const T = fit(w, h, [-W / 2 - 0.5, W / 2 + 0.5, zmin - 0.1, zmax + 0.1], 2, 14);
  ctx.strokeStyle = COLORS.line; ctx.beginPath(); ctx.moveTo(T.X(0), T.Y(zmin - 0.1)); ctx.lineTo(T.X(0), T.Y(zmax + 0.1)); ctx.stroke();
  const cols = { center: COLORS.accent, tail_12: COLORS.warm, nose_12: COLORS.sand };
  for (const k of ['center', 'tail_12', 'nose_12']) {
    const s = secs[k];
    path(ctx, s.y, s.z, T, true);
    if (k === 'center') { ctx.fillStyle = 'rgba(60,200,180,0.08)'; ctx.fill(); }
    ctx.strokeStyle = cols[k]; ctx.lineWidth = 1.6; ctx.stroke();
  }
}

function drawPanels(data) { drawPlan(data); drawRocker(data); drawSections(data); }

/* =========================================================================
   Stats and render
   ========================================================================= */
function render(data) {
  updateMesh(data);
  drawPanels(data);
  const s = data.stats;
  $('#s-vol').textContent = s.volume_l.toFixed(2);
  $('#s-dims').textContent = `${ftin(s.length_in)} × ${fracIn(s.width_in)}″ × ${fracIn(s.thickness_in)}″`;
  $('#s-sub').textContent =
    `N12 ${fracIn(s.nose_width_12_in)}″   T12 ${fracIn(s.tail_width_12_in)}″\n` +
    `plan ${s.plan_area_in2.toFixed(0)} in²   ${(s.triangles / 1000).toFixed(1)}k tris   ${data.build_ms} ms`;
  $('#warnings').innerHTML = data.warnings.map((w) => `<span>${w}</span>`).join('');

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
