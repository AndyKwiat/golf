// Browser entry: fixed-timestep loop, input -> actions, HUD, and the window.__golf agent API.
import { Game } from './sim/game.js';
import { DT, SWING, MAX_FLAT_DIST } from './sim/constants.js';
import { randomSeed } from './sim/rng.js';
import { View } from './render/view.js';
import { solvePutt } from './sim/solver.js';

const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) : randomSeed();
const game = new Game({ seed, mode: params.get('mode') === 'cheat' ? 'cheat' : 'normal' });
const view = new View(document.getElementById('c'), game);
if (params.get('cam') === 'overhead') view.camMode = 'overhead';
if (params.get('grid') === '0') view.setGrid(false);
let paused = params.get('paused') === '1';
const $ = id => document.getElementById(id);
if (params.get('hud') === '0') $('hud').classList.add('hidden');

// ------------------------------------------------------------------ input state
const keys = new Set();
const AIM_RATE = 0.5, AIM_RATE_FINE = 0.06, POWER_RATE = 0.25, POWER_RATE_FINE = 0.03;

function newGreen(s = randomSeed()) { game.dispatch({ type: 'newGreen', seed: s }); }
function toggleMode() { game.dispatch({ type: 'setMode', mode: game.mode === 'normal' ? 'cheat' : 'normal' }); }
function cycleCam() { view.camMode = view.camMode === 'auto' ? 'overhead' : 'auto'; view.zoom = 1; }
function primaryAction() {
  if (game.phase === 'holed') return newGreen();
  if (game.mode === 'cheat') game.dispatch({ type: 'putt' });
  else game.dispatch({ type: 'swingPress' });
}

addEventListener('keydown', e => {
  if (e.repeat && !e.key.startsWith('Arrow')) return;
  keys.add(e.key.toLowerCase());
  switch (e.key.toLowerCase()) {
    case ' ': primaryAction(); e.preventDefault(); break;
    case 'enter': if (game.mode === 'cheat' || game.phase === 'holed') primaryAction(); break;
    case 'n': newGreen(); break;
    case 'm': toggleMode(); break;
    case 'c': cycleCam(); break;
    case 'g': view.setGrid(!view.showGrid); break;
    case 'h': $('hud').classList.toggle('hidden'); break;
    case 'p': paused = !paused; break;
  }
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

/** Continuous inputs are sampled once per sim tick so they are part of the deterministic log. */
function sampleHeldInput() {
  const fine = keys.has('shift');
  let da = 0, dp = 0;
  if (keys.has('arrowleft') || keys.has('a')) da -= 1;
  if (keys.has('arrowright') || keys.has('d')) da += 1;
  if (keys.has('arrowup') || keys.has('w')) dp += 1;
  if (keys.has('arrowdown') || keys.has('s')) dp -= 1;
  if (da && game.phase === 'aim') game.dispatch({ type: 'setAim', aim: game.aim + da * (fine ? AIM_RATE_FINE : AIM_RATE) * DT });
  if (dp && game.mode === 'cheat') game.dispatch({ type: 'setPower', power: game.cheatPower + dp * (fine ? POWER_RATE_FINE : POWER_RATE) * DT });
}

// Mouse: click/drag on the green to aim, wheel to zoom
const canvas = $('c');
let aimDrag = false;
function aimAtPointer(e) {
  const r = canvas.getBoundingClientRect();
  const p = view.pick(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  if (p && game.phase === 'aim') game.dispatch({ type: 'setAim', aim: Math.atan2(p.z - game.ball.z, p.x - game.ball.x) });
}
canvas.addEventListener('pointerdown', e => { if (e.button === 0) { aimDrag = true; aimAtPointer(e); } });
addEventListener('pointermove', e => { if (aimDrag) aimAtPointer(e); });
addEventListener('pointerup', () => { aimDrag = false; meterDrag = false; });
canvas.addEventListener('wheel', e => { view.zoom = Math.min(4, Math.max(0.4, view.zoom * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });

// Meter: in cheat mode, click/drag to set the exact power
const meter = $('meter');
let meterDrag = false;
const vToPct = v => ((v - SWING.zoneMin) / (1 - SWING.zoneMin)) * 100;
function meterSet(e) {
  const r = meter.getBoundingClientRect();
  const v = SWING.zoneMin + ((e.clientX - r.left) / r.width) * (1 - SWING.zoneMin);
  game.dispatch({ type: 'setPower', power: Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000 });
}
meter.addEventListener('pointerdown', e => { if (game.mode === 'cheat') { meterDrag = true; meterSet(e); } });
addEventListener('pointermove', e => { if (meterDrag) meterSet(e); });

$('btn-new').onclick = () => newGreen();
$('btn-mode').onclick = () => toggleMode();
$('btn-cam').onclick = () => cycleCam();
$('btn-grid').onclick = () => view.setGrid(!view.showGrid);
$('btn-putt').onclick = () => game.dispatch({ type: 'putt' });
for (const b of document.querySelectorAll('button')) b.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });

// meter tick marks
$('meter-ticks').innerHTML = [0.25, 0.5, 0.75].map(p => `<div style="left:${vToPct(p)}%"><span>${(p * MAX_FLAT_DIST).toFixed(1)}m</span></div>`).join('');
$('meter-impact').style.left = `calc(${vToPct(0)}% - 1px)`;

// ------------------------------------------------------------------ HUD
let toastTimer = 0;
function toast(html, secs = 2.2) {
  const t = $('toast'); t.innerHTML = html; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), secs * 1000);
}
const SCORE_NAMES = { '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' };
function handleEvents() {
  for (const e of game.takeEvents()) {
    if (e.type === 'holed') {
      const diff = e.strokes - e.par;
      const name = SCORE_NAMES[diff] ?? `+${diff}`;
      toast(`${e.strokes === 1 ? 'Drained it!' : 'In the hole!'}\n<small>${name} — ${e.strokes} putt${e.strokes > 1 ? 's' : ''} · Space for next green</small>`, 4);
    } else if (e.type === 'oob') toast('Out of bounds\n<small>+1 stroke, replay from previous spot</small>');
    else if (e.type === 'rest') toast(`${e.lipouts ? 'Lipped out!\n' : ''}<small>${e.dist.toFixed(2)} m to go</small>`, 1.6);
    else if (e.type === 'newGreen') { $('toast').classList.remove('show'); view.snap = true; }
    else if (e.type === 'swingCancel') toast('<small>swing cancelled</small>', 1);
  }
}

function updateHud() {
  const s = game;
  const total = s.card.reduce((a, c) => a + c.strokes - c.par, 0);
  const lie = s.terrain.surface(s.ball.x, s.ball.z);
  $('info').innerHTML = `
    <div class="big">Hole ${s.card.length + (s.phase === 'holed' ? 0 : 1)} · Par ${s.par}</div>
    <div>Strokes: <b>${s.strokes}</b></div>
    <div>To hole: <b>${s.distToHole().toFixed(2)} m</b> · ${lie}</div>
    <div>Round: <b>${total === 0 ? 'E' : (total > 0 ? '+' : '') + total}</b> (${s.card.length} holes)</div>
    <div>Mode: <span class="${s.mode === 'cheat' ? 'mode-cheat' : ''}">${s.mode === 'cheat' ? 'CHEAT (preview)' : 'Normal'}</span> · seed ${s.seed}</div>`;
  $('btn-mode').classList.toggle('on', s.mode === 'cheat');
  $('btn-grid').classList.toggle('on', view.showGrid);
  $('btn-cam').classList.toggle('on', view.camMode === 'overhead');

  const cheat = s.mode === 'cheat';
  meter.classList.toggle('interactive', cheat);
  $('cheat-row').style.display = cheat && s.phase === 'aim' ? 'block' : 'none';
  const marker = $('meter-marker'), pw = $('meter-power'), fill = $('meter-fill');
  if (cheat) {
    marker.style.display = 'none'; pw.style.display = 'none';
    fill.style.left = vToPct(0) + '%'; fill.style.width = (vToPct(s.cheatPower) - vToPct(0)) + '%';
    $('meter-label').textContent = `Power ${(s.cheatPower * 100).toFixed(1)}%  (≈ ${(s.cheatPower * MAX_FLAT_DIST).toFixed(2)} m on flat)`;
    $('help').textContent = '←/→ or click green: aim (Shift = fine) · ↑/↓ or drag bar: power · Enter/Space: putt';
  } else {
    const sw = s.swing;
    fill.style.left = vToPct(0) + '%';
    if (sw) {
      const shown = sw.stage === 'power' ? sw.value : sw.power;
      fill.style.width = (vToPct(shown) - vToPct(0)) + '%';
      marker.style.display = 'block'; marker.style.left = `calc(${vToPct(sw.value)}% - 2px)`;
      pw.style.display = sw.stage === 'accuracy' ? 'block' : 'none'; pw.style.left = `calc(${vToPct(sw.power)}% - 1px)`;
      $('meter-label').textContent = sw.stage === 'power' ? 'Space to set power' : 'Space on the white line to hit straight!';
    } else {
      const lp = s.lastShot && s.phase !== 'rolling' ? s.lastShot.power : 0;
      fill.style.width = (vToPct(lp) - vToPct(0)) + '%';
      marker.style.display = 'none'; pw.style.display = 'none';
      $('meter-label').textContent = s.lastShot ? `Last: ${(s.lastShot.power * 100).toFixed(0)}% power` : '';
    }
    $('help').textContent = '←/→ or click green: aim (Shift = fine) · Space: start / set power / hit · wheel: zoom';
  }
  if (s.phase === 'holed') $('help').textContent = 'Space / N: next green';
}

// ------------------------------------------------------------------ cheat preview (memoized)
let previewKey = '';
function updatePreview() {
  if (game.mode !== 'cheat' || game.phase !== 'aim') { previewKey = ''; view.setPreview(null); return; }
  const key = `${game.seed}|${game.ball.x}|${game.ball.z}|${game.aim}|${game.cheatPower}|${view.camMode}`;
  if (key === previewKey) return;
  previewKey = key;
  view.setPreview(game.preview());
}

// ------------------------------------------------------------------ loop
function resize() { view.resize(innerWidth, innerHeight); }
addEventListener('resize', resize); resize();

function simTick() { sampleHeldInput(); game.step(); handleEvents(); }
function draw(alpha, dtReal, snap) { updatePreview(); updateHud(); view.render(alpha, dtReal, snap); }

let acc = 0, last = performance.now();
function frame(now) {
  const dtReal = Math.min(0.25, (now - last) / 1000); last = now;
  if (!paused) {
    acc += dtReal;
    while (acc >= DT) { simTick(); acc -= DT; }
  }
  draw(paused ? 1 : acc / DT, paused ? 0 : dtReal, false);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ agent API
// Everything an automated agent needs: pause the realtime loop, step deterministically, drive
// actions, read state, and grab screenshots. See AGENTS.md.
window.__golf = {
  game, view,
  pause() { paused = true; acc = 0; }, resume() { paused = false; last = performance.now(); },
  get paused() { return paused; },
  /** Step n sim ticks (no held-key sampling), then render a snapped frame. */
  step(n = 1) { for (let i = 0; i < n; i++) { game.step(); handleEvents(); } draw(1, n * DT, true); return game.snapshot(); },
  /** Step until the current swing/putt settles. */
  settle() { game.runUntilSettled(); handleEvents(); draw(1, DT, true); return game.snapshot(); },
  dispatch(a) { game.dispatch(a); return this; },
  newGreen(s) { game.dispatch({ type: 'newGreen', seed: s ?? randomSeed() }); return this.step(1); },
  setMode(mode) { game.dispatch({ type: 'setMode', mode }); return this.step(1); },
  setAim(aim) { game.dispatch({ type: 'setAim', aim }); return this.step(1); },
  aimAtHole() { return this.setAim(game.aimToHole()); },
  setPower(power) { game.dispatch({ type: 'setPower', power }); return this.step(1); },
  /** Direct putt; aim/power optional (defaults: current aim / cheat power). Returns settled state. */
  putt(aim, power) { game.dispatch({ type: 'putt', aim, power }); return this.settle(); },
  preview(aim, power) { const r = game.preview(aim, power); return { result: r.result, end: r.end, ticks: r.ticks }; },
  state() { return game.snapshot(); },
  /** Solver's best putt {aim, power, result, dist} from the current ball position (slow-ish: ~0.5s). */
  solve() { return solvePutt(game.terrain, game.ball); },
  /** Let the solver take the putt. Returns settled state. */
  autoPutt() { const s = this.solve(); return this.putt(s.aim, s.power); },
  setCamera(mode, zoom = 1) { view.camMode = mode; view.zoom = zoom; draw(1, 0, true); },
  setGrid(on) { view.setGrid(on); draw(1, 0, true); },
  setHud(on) { $('hud').classList.toggle('hidden', !on); },
  /** Render a snapped frame and return it as a PNG data URL (canvas only, no HUD). */
  screenshot() { draw(1, 0, true); return view.renderer.domElement.toDataURL('image/png'); },
  render() { draw(1, 0, true); },
};
window.__golfReady = true;
