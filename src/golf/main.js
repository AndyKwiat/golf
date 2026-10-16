// Full-hole game entry: fixed-timestep loop, input -> actions, HUD, minimap, window.__golf API.
import { GolfGame } from './sim/game.js';
import { CLUBS, PUTTER, flatCarry } from './sim/clubs.js';
import { DT, SWING, LIE, PUTT_MAX_FLAT } from './sim/constants.js';
import { botShot, botPlayHole } from './sim/bot.js';
import { randomSeed } from '../sim/rng.js';
import { GolfView } from './render/view.js';

const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) : randomSeed();
const game = new GolfGame({ seed, mode: params.get('mode') === 'normal' ? 'normal' : 'cheat' });
const view = new GolfView(document.getElementById('c'), game);
if (params.get('cam') === 'overhead') view.camMode = 'overhead';
if (params.get('grid') === '0') view.setGrid(false);
let paused = params.get('paused') === '1';
const $ = id => document.getElementById(id);
if (params.get('hud') === '0') $('hud').classList.add('hidden');

// ------------------------------------------------------------------ input
const keys = new Set();
function newHole(s = randomSeed()) { game.dispatch({ type: 'newHole', seed: s }); }
function toggleMode() { game.dispatch({ type: 'setMode', mode: game.mode === 'normal' ? 'cheat' : 'normal' }); }
function cycleCam() { view.camMode = view.camMode === 'auto' ? 'overhead' : 'auto'; view.zoom = 1; }
/** Change draw/fade; the caddie re-aims so the shaped shot still finishes on the target line. */
function setCurve(c) { if (!game.club.putter) game.dispatch({ type: 'setCurve', curve: Math.round(Math.max(-1, Math.min(1, c)) * 4) / 4, reaim: true }); }
function primary() {
  if (game.phase === 'holed') return newHole();
  if (game.mode === 'cheat') game.dispatch({ type: 'shoot' });
  else game.dispatch({ type: 'swingPress' });
}
addEventListener('keydown', e => {
  if (e.repeat && !e.key.startsWith('Arrow')) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  switch (k) {
    case ' ': primary(); e.preventDefault(); break;
    case 'enter': if (game.mode === 'cheat' || game.phase === 'holed') primary(); break;
    case 'n': newHole(); break;
    case 'm': toggleMode(); break;
    case 'c': cycleCam(); break;
    case 'g': view.setGrid(!view.showGrid); break;
    case 'h': $('hud').classList.toggle('hidden'); break;
    case 'p': paused = !paused; break;
    case 'z': setCurve(game.curve - 0.25); break;
    case 'x': setCurve(game.curve + 0.25); break;
    case 'q': case '[': game.dispatch({ type: 'cycleClub', dir: -1 }); break;
    case 'e': case ']': game.dispatch({ type: 'cycleClub', dir: 1 }); break;
  }
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

function sampleHeldInput() {
  const fine = keys.has('shift'), putt = game.club.putter;
  let da = 0, dp = 0;
  if (keys.has('arrowleft') || keys.has('a')) da -= 1;
  if (keys.has('arrowright') || keys.has('d')) da += 1;
  if (keys.has('arrowup') || keys.has('w')) dp += 1;
  if (keys.has('arrowdown') || keys.has('s')) dp -= 1;
  const rate = putt ? (fine ? 0.06 : 0.5) : (fine ? 0.02 : 0.25);
  if (da && game.phase === 'aim') game.dispatch({ type: 'setAim', aim: game.aim + da * rate * DT });
  if (dp && game.mode === 'cheat') game.dispatch({ type: 'setPower', power: game.power + dp * (fine ? 0.03 : 0.25) * DT });
}

const canvas = $('c');
let aimDrag = false, meterDrag = false;
function aimAt(p) { if (p && game.phase === 'aim') game.dispatch({ type: 'setAim', aim: Math.atan2(p.z - game.ball.z, p.x - game.ball.x) }); }
function aimAtPointer(e) {
  const r = canvas.getBoundingClientRect();
  aimAt(view.pick(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
}
canvas.addEventListener('pointerdown', e => { if (e.button === 0) { aimDrag = true; aimAtPointer(e); } });
addEventListener('pointermove', e => { if (aimDrag) aimAtPointer(e); if (meterDrag) meterSet(e); if (mapDrag) mapAim(e); });
addEventListener('pointerup', () => { aimDrag = meterDrag = mapDrag = false; });
canvas.addEventListener('wheel', e => { view.zoom = Math.min(4, Math.max(0.3, view.zoom * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });

const meter = $('meter');
const vToPct = v => ((v - SWING.zoneMin) / (1 - SWING.zoneMin)) * 100;
function meterSet(e) {
  const r = meter.getBoundingClientRect();
  const v = SWING.zoneMin + ((e.clientX - r.left) / r.width) * (1 - SWING.zoneMin);
  game.dispatch({ type: 'setPower', power: Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000 });
}
meter.addEventListener('pointerdown', e => { if (game.mode === 'cheat') { meterDrag = true; meterSet(e); } });

$('btn-new').onclick = () => newHole();
$('btn-mode').onclick = () => toggleMode();
$('btn-cam').onclick = () => cycleCam();
$('btn-grid').onclick = () => view.setGrid(!view.showGrid);
$('btn-shoot').onclick = () => game.dispatch({ type: 'shoot' });
$('btn-draw').onclick = () => setCurve(game.curve - 0.25);
$('btn-fade').onclick = () => setCurve(game.curve + 0.25);
for (const b of document.querySelectorAll('button')) b.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });

// Club list
$('clubs').innerHTML = CLUBS.map(c => `<div class="club" data-id="${c.id}"><b>${c.short}</b><span>${c.putter ? '' : c.carry + 'm'}</span></div>`).join('');
$('clubs').addEventListener('click', e => { const el = e.target.closest('.club'); if (el) game.dispatch({ type: 'setClub', club: Number(el.dataset.id) }); });

// ------------------------------------------------------------------ minimap
const mm = $('minimap'), mmx = mm.getContext('2d');
let mmBase = null, mmHole = null, mmT = null, mapDrag = false;
function buildMinimap() {
  const h = game.hole, r = view.playRect;
  const W = mm.width, H = mm.height;
  const sc = Math.min(W / (r.xmax - r.xmin), H / (r.zmax - r.zmin));
  const ox = (W - (r.xmax - r.xmin) * sc) / 2, oz = (H - (r.zmax - r.zmin) * sc) / 2;
  // screen x is flipped (looking down +z from the tee, +x is to the LEFT)
  mmT = { toS: (x, z) => [W - ox - (x - r.xmin) * sc, H - oz - (z - r.zmin) * sc], toW: (sx, sy) => ({ x: r.xmin + (W - ox - sx) / sc, z: r.zmin + (H - oz - sy) / sc }) };
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), img = x.createImageData(W, H);
  const COL = { rough: [52, 110, 42], fairway: [92, 170, 66], green: [110, 205, 90], fringe: [80, 155, 60], sand: [225, 205, 150], water: [50, 120, 200], tee: [100, 180, 75], oob: [34, 70, 30] };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const p = mmT.toW(i + 0.5, j + 0.5), col = COL[h.surface(p.x, p.z)] || [0, 0, 0], o = (j * W + i) * 4;
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  x.fillStyle = 'rgba(15,45,20,0.85)';
  for (const t of h.trees) { const [sx, sy] = mmT.toS(t.x, t.z); x.beginPath(); x.arc(sx, sy, Math.max(1.2, t.crownR * sc), 0, 7); x.fill(); }
  mmBase = c; mmHole = h;
}
function drawMinimap(preview) {
  if (mmHole !== game.hole || !view.playRect) buildMinimap();
  mmx.drawImage(mmBase, 0, 0);
  const pathOf = (pts, color, w) => {
    if (!pts || pts.length < 2) return;
    mmx.strokeStyle = color; mmx.lineWidth = w; mmx.beginPath();
    pts.forEach((p, i) => { const [sx, sy] = mmT.toS(p.x, p.z); i ? mmx.lineTo(sx, sy) : mmx.moveTo(sx, sy); });
    mmx.stroke();
  };
  if (game.tracer.length > 1) pathOf(game.tracer, 'rgba(255,255,255,0.7)', 1.5);
  if (preview && game.phase === 'aim') pathOf(preview.path, preview.result === 'water' || preview.result === 'oob' ? '#ff5a4d' : '#ffe14d', 2);
  if (game.phase === 'aim' && game.mode === 'normal' && !game.club.putter) {
    const L = game.club.carry, b = game.ball;
    pathOf([b, { x: b.x + Math.cos(game.aim) * L, z: b.z + Math.sin(game.aim) * L }], 'rgba(255,255,255,0.8)', 1.5);
  }
  const [cx, cy] = mmT.toS(game.hole.cup.x, game.hole.cup.z);
  mmx.fillStyle = '#e53935'; mmx.beginPath(); mmx.arc(cx, cy, 3.5, 0, 7); mmx.fill();
  // wind arrow (top-left corner of the map)
  const w = game.hole.wind, ws = Math.hypot(w.x, w.z);
  if (ws > 0.1) {
    const [x0, y0] = mmT.toS(0, 0), [x1, y1] = mmT.toS(w.x / ws, w.z / ws);
    const dx = (x1 - x0), dy = (y1 - y0), L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, cx0 = 22, cy0 = 22, R = 14;
    mmx.fillStyle = 'rgba(0,0,0,0.45)'; mmx.beginPath(); mmx.arc(cx0, cy0, 19, 0, 7); mmx.fill();
    mmx.strokeStyle = '#9fe0ff'; mmx.fillStyle = '#9fe0ff'; mmx.lineWidth = 2.5;
    mmx.beginPath(); mmx.moveTo(cx0 - ux * R, cy0 - uy * R); mmx.lineTo(cx0 + ux * R, cy0 + uy * R); mmx.stroke();
    mmx.beginPath(); mmx.moveTo(cx0 + ux * R, cy0 + uy * R); mmx.lineTo(cx0 + ux * (R - 7) - uy * 5, cy0 + uy * (R - 7) + ux * 5); mmx.lineTo(cx0 + ux * (R - 7) + uy * 5, cy0 + uy * (R - 7) - ux * 5); mmx.fill();
  }
  const [bx, by] = mmT.toS(game.ball.x, game.ball.z);
  mmx.fillStyle = '#fff'; mmx.strokeStyle = '#000'; mmx.lineWidth = 1; mmx.beginPath(); mmx.arc(bx, by, 3.5, 0, 7); mmx.fill(); mmx.stroke();
}
function mapAim(e) { const r = mm.getBoundingClientRect(); aimAt(mmT.toW((e.clientX - r.left) * mm.width / r.width, (e.clientY - r.top) * mm.height / r.height)); }
mm.addEventListener('pointerdown', e => { mapDrag = true; mapAim(e); });

function THREE_Vec(cam) { const e = cam.matrixWorld.elements; return { x: -e[8], y: -e[9], z: -e[10] }; }

// ------------------------------------------------------------------ HUD
let toastTimer = 0;
function toast(html, secs = 2.2) {
  const t = $('toast'); t.innerHTML = html; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), secs * 1000);
}
const SCORE = { '-4': 'Condor!!', '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', 0: 'Par', 1: 'Bogey', 2: 'Double bogey', 3: 'Triple bogey' };
function handleEvents() {
  for (const e of game.takeEvents()) {
    if (e.type === 'holed') {
      const d = e.strokes - e.par, name = e.strokes === 1 ? 'HOLE IN ONE!' : (SCORE[d] ?? `+${d}`);
      toast(`${name}\n<small>${e.strokes} stroke${e.strokes > 1 ? 's' : ''} on a par ${e.par} · Space for a new hole</small>`, 5);
    } else if (e.type === 'water') toast('Splash!\n<small>+1 penalty · dropped near where it went in</small>');
    else if (e.type === 'oob') toast('Out of bounds\n<small>+1 penalty · replay from previous spot</small>');
    else if (e.type === 'rest') {
      const parts = [];
      if (e.treeHits) parts.push('Hit a tree!');
      if (e.lipouts) parts.push('Lipped out!');
      const carry = e.carry > 1 ? `carry ${e.carry.toFixed(0)} m · ` : '';
      toast(`${parts.join(' ')}${parts.length ? '\n' : ''}<small>${carry}${e.total.toFixed(e.total < 20 ? 1 : 0)} m · ${e.lie} · ${e.dist.toFixed(e.dist < 20 ? 1 : 0)} m to go</small>`, 2.2);
    } else if (e.type === 'newHole') { $('toast').classList.remove('show'); view.snap = true; }
    else if (e.type === 'swingCancel') toast('<small>swing cancelled</small>', 1);
  }
}

const tickCache = new Map();
function meterTicks() {
  const c = game.club, lie = game.phase === 'moving' && game.lastShot ? game.lastShot.lie : game.lie, key = `${c.id}|${lie}`;
  if (!tickCache.has(key)) {
    const L = LIE[lie] || LIE.rough, sm = c.wedge && L.wedgeSpeed ? L.wedgeSpeed : L.speed;
    tickCache.set(key, [0.25, 0.5, 0.75, 1].map(p => c.putter ? p * PUTT_MAX_FLAT : flatCarry(c.speed * Math.sqrt(p) * sm, c.angle, c.spin * L.spin)));
  }
  return tickCache.get(key);
}

let lastTicksKey = '';
function updateHud(preview) {
  const g = game, h = g.hole;
  const total = g.card.reduce((a, c) => a + c.strokes - c.par, 0);
  $('info').innerHTML = `
    <div class="big">Par ${h.par} · ${h.length.toFixed(0)} m</div>
    <div>Stroke: <b>${g.strokes + (g.phase === 'holed' || g.phase === 'moving' ? 0 : 1)}</b> · Lie: <b>${g.phase === 'moving' ? (g.ball.air ? 'in flight' : 'rolling') : g.lie}</b></div>
    <div>To pin: <b>${g.distToHole().toFixed(g.distToHole() < 30 ? 1 : 0)} m</b></div>
    <div>Round: <b>${total === 0 ? 'E' : (total > 0 ? '+' : '') + total}</b> (${g.card.length} holes)</div>
    <div>Mode: <span class="${g.mode === 'cheat' ? 'mode-cheat' : ''}">${g.mode === 'cheat' ? 'CHEAT (preview)' : 'Normal'}</span> · seed ${g.seed}</div>`;
  $('btn-mode').classList.toggle('on', g.mode === 'cheat');
  $('btn-grid').classList.toggle('on', view.showGrid);
  $('btn-cam').classList.toggle('on', view.camMode === 'overhead');
  for (const el of $('clubs').children) el.classList.toggle('on', Number(el.dataset.id) === g.clubId);

  const tk = meterTicks(), tkKey = tk.join();
  if (tkKey !== lastTicksKey) {
    lastTicksKey = tkKey;
    $('meter-ticks').innerHTML = tk.slice(0, 3).map((d, i) => `<div style="left:${vToPct((i + 1) * 0.25)}%"><span>${d.toFixed(d < 20 ? 1 : 0)}m</span></div>`).join('')
      + `<div style="left:calc(100% - 1px)"><span style="transform:translateX(-110%)">${tk[3].toFixed(0)}m</span></div>`;
  }
  // wind: arrow relative to the camera view (up = blowing away from you), plus help/hurt vs aim
  const w = h.wind, ws = Math.hypot(w.x, w.z);
  const cam = view.camera, fwd0 = THREE_Vec(cam), fwd = Math.hypot(fwd0.x, fwd0.z) > 0.2 ? fwd0 : cam.up, fl = Math.hypot(fwd.x, fwd.z) || 1;  // overhead: screen-up = camera.up
  const fx = fwd.x / fl, fz = fwd.z / fl, rx = -fz, rz = fx;               // screen right = (-fz, fx)
  const sAng = Math.atan2(w.x * rx + w.z * rz, w.x * fx + w.z * fz);       // 0 = away from camera
  $('wind-arrow').style.transform = `rotate(${sAng}rad)`;   // svg arrow points up at 0
  $('wind-speed').textContent = `Wind ${ws.toFixed(1)} m/s`;
  const ax = Math.cos(g.aim), az = Math.sin(g.aim), along = w.x * ax + w.z * az, cross = w.x * -az + w.z * ax;
  $('wind-desc').textContent = `${Math.abs(along) < 0.5 ? '' : along > 0 ? `helping ${along.toFixed(0)}` : `into ${(-along).toFixed(0)}`}${Math.abs(along) >= 0.5 && Math.abs(cross) >= 0.5 ? ' · ' : ''}${Math.abs(cross) < 0.5 ? '' : cross > 0 ? `→ ${cross.toFixed(0)} to the right` : `← ${(-cross).toFixed(0)} to the left`}`;
  // shot shape
  const showShape = g.phase === 'aim' && !g.club.putter;
  $('shape-row').classList.toggle('hidden', !showShape);
  $('shape-mark').style.left = `${(g.curve + 1) * 50}%`;
  $('btn-draw').classList.toggle('on', g.curve < 0); $('btn-fade').classList.toggle('on', g.curve > 0);

  const cheat = g.mode === 'cheat';
  meter.classList.toggle('interactive', cheat);
  $('cheat-row').style.display = cheat && g.phase === 'aim' ? 'block' : 'none';
  const marker = $('meter-marker'), pw = $('meter-power'), fill = $('meter-fill');
  fill.style.left = vToPct(0) + '%';
  if (cheat) {
    marker.style.display = 'none'; pw.style.display = 'none';
    fill.style.width = (vToPct(g.power) - vToPct(0)) + '%';
    const shape = g.club.putter || !g.curve ? '' : ` · ${g.curve < 0 ? 'draw' : 'fade'} ${Math.abs(g.curve * 100).toFixed(0)}%`;
    let txt = `${g.club.name} · Power ${(g.power * 100).toFixed(1)}%${shape}`;
    if (preview && g.phase === 'aim') {
      const carry = preview.landing ? Math.hypot(preview.landing.x - g.ball.x, preview.landing.z - g.ball.z) : 0;
      const tot = Math.hypot(preview.end.x - g.ball.x, preview.end.z - g.ball.z);
      const endLie = preview.result === 'holed' ? 'IN THE HOLE' : preview.result === 'water' ? 'WATER' : preview.result === 'oob' ? 'OUT OF BOUNDS' : h.surface(preview.end.x, preview.end.z);
      txt += ` — ${carry > 1 ? `carry ${carry.toFixed(0)} m, ` : ''}total ${tot.toFixed(tot < 20 ? 1 : 0)} m → ${endLie}${preview.treeHits ? ' (hits tree)' : ''}`;
    }
    $('meter-label').textContent = txt;
    $('help').textContent = '←/→ or click: aim (Shift fine) · ↑/↓ or drag bar: power · Q/E: club · Z/X: draw/fade · Enter/Space: shoot';
  } else {
    const sw = g.swing;
    if (sw) {
      fill.style.width = (vToPct(sw.stage === 'power' ? sw.value : sw.power) - vToPct(0)) + '%';
      marker.style.display = 'block'; marker.style.left = `calc(${vToPct(sw.value)}% - 2px)`;
      pw.style.display = sw.stage === 'accuracy' ? 'block' : 'none'; pw.style.left = `calc(${vToPct(sw.power)}% - 1px)`;
      $('meter-label').textContent = sw.stage === 'power' ? `${g.club.name}: Space to set power` : 'Space on the white line to hit straight!';
    } else {
      fill.style.width = '0%'; marker.style.display = 'none'; pw.style.display = 'none';
      $('meter-label').textContent = `${g.club.name}${g.club.putter ? '' : ` · full carry ≈ ${tk[3].toFixed(0)} m`}`;
    }
    $('help').textContent = '←/→ or click: aim (Shift fine) · Q/E: club · Z/X: draw/fade · Space: start / set power / hit';
  }
  if (g.phase === 'holed') $('help').textContent = 'Space / N: new hole';
}

// ------------------------------------------------------------------ preview (memoized)
let previewKey = '', preview = null;
function updatePreview() {
  if (game.mode !== 'cheat' || game.phase !== 'aim') { previewKey = ''; preview = null; view.setPreview(null); return; }
  const key = `${game.seed}|${game.ball.x}|${game.ball.z}|${game.aim}|${game.power}|${game.clubId}|${game.curve}`;
  if (key === previewKey) return;
  previewKey = key;
  preview = game.preview();
  view.setPreview(preview);
}

// ------------------------------------------------------------------ loop
function resize() { view.resize(innerWidth, innerHeight); }
addEventListener('resize', resize); resize();
function simTick() { sampleHeldInput(); game.step(); handleEvents(); }
function draw(alpha, dtReal, snap) { updatePreview(); updateHud(preview); view.render(alpha, dtReal, snap); drawMinimap(preview); }

let acc = 0, last = performance.now();
function frame(now) {
  const dtReal = Math.min(0.25, (now - last) / 1000); last = now;
  if (!paused) { acc += dtReal; while (acc >= DT) { simTick(); acc -= DT; } }
  draw(paused ? 1 : acc / DT, paused ? 0 : dtReal, false);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ agent API (see AGENTS.md)
window.__golf = {
  game, view, CLUBS,
  pause() { paused = true; acc = 0; }, resume() { paused = false; last = performance.now(); },
  get paused() { return paused; },
  step(n = 1) { for (let i = 0; i < n; i++) { game.step(); handleEvents(); } draw(1, n * DT, true); return game.snapshot(); },
  settle() { game.runUntilSettled(); handleEvents(); draw(1, DT, true); return game.snapshot(); },
  dispatch(a) { game.dispatch(a); return this; },
  newHole(s) { game.dispatch({ type: 'newHole', seed: s ?? randomSeed() }); return this.step(1); },
  setMode(mode) { game.dispatch({ type: 'setMode', mode }); return this.step(1); },
  setAim(aim) { game.dispatch({ type: 'setAim', aim }); return this.step(1); },
  aimAtHole() { return this.setAim(game.aimToHole()); },
  setPower(power) { game.dispatch({ type: 'setPower', power }); return this.step(1); },
  /** club: index or short name ('7i', 'Dr', 'Pt'...) */
  setClub(club) { const id = typeof club === 'string' ? CLUBS.findIndex(c => c.short === club) : club; game.dispatch({ type: 'setClub', club: id }); return this.step(1); },
  shoot(aim, power, club, curve) { const id = typeof club === 'string' ? CLUBS.findIndex(c => c.short === club) : club; game.dispatch({ type: 'shoot', aim, power, club: id, curve }); return this.settle(); },
  /** curve in [-1,1]: -1 full draw, +1 full fade. reaim (default true) lets the caddie re-aim. */
  setCurve(curve, reaim = true) { game.dispatch({ type: 'setCurve', curve, reaim }); return this.step(1); },
  /** Bot picks and plays the best shot it can find (exact sim search). */
  autoShot() { const s = botShot(game); return this.shoot(s.aim, s.power, s.clubId); },
  playHole() { botPlayHole(game); handleEvents(); draw(1, DT, true); return game.snapshot(); },
  preview(aim, power, club, curve) { const r = game.preview(aim, power, club, curve); return { result: r.result, end: r.end, landing: r.landing, ticks: r.ticks, treeHits: r.treeHits }; },
  state() { return game.snapshot(); },
  /** Drop the ball at (x, z), optionally aiming at (lookX, lookZ). Great for screenshots of a spot. */
  placeBall(x, z, lookX, lookZ) { game.dispatch({ type: 'placeBall', x, z, lookX, lookZ }); return this.step(1); },
  /** Place the ball `dist` m short of bunker i (or pond i with kind='pond'), looking at it. */
  lookAtHazard(i = 0, kind = 'bunker', dist = 9) {
    const hz = (kind === 'pond' ? game.hole.ponds : game.hole.bunkers)[i];
    const dx = hz.x - game.ball.x, dz = hz.z - game.ball.z, L = Math.hypot(dx, dz) || 1, r = hz.R0 + dist;
    return this.placeBall(hz.x - dx / L * r, hz.z - dz / L * r, hz.x, hz.z);
  },
  setCamera(mode, zoom = 1) { view.camMode = mode; view.zoom = zoom; draw(1, 0, true); },
  setGrid(on) { view.setGrid(on); draw(1, 0, true); },
  setHud(on) { $('hud').classList.toggle('hidden', !on); },
  /** Advance only the visual clock (clouds, flag) by `secs` without stepping the sim. */
  advanceVisuals(secs) { draw(1, secs, true); },
  screenshot() { draw(1, 0, true); return view.renderer.domElement.toDataURL('image/png'); },
  render() { draw(1, 0, true); },
  buildMs() { return view.buildMs; },
  /** Resolves when the current hole's textures have finished painting (await before screenshots). */
  whenReady() { return view.ready.then(() => { draw(1, 0, true); return true; }); },
};
window.__golfReady = true;
