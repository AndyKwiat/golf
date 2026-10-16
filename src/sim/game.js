// Game state machine. Pure & deterministic: all input goes through dispatch(action), actions are
// applied at the start of the next step(), and every applied action is logged with its tick so a
// session can be replayed exactly (see Game.replay).
//
// Phases:  'aim' -> ('swing' in normal mode) -> 'rolling' -> 'aim' ... -> 'holed'
import { atan2 } from './math.js';
import { DT, SWING, MAX_ROLL_TICKS } from './constants.js';
import { generateGreen, Terrain } from './terrain.js';
import { launchBall, stepBall, simulatePutt } from './physics.js';

export const MODES = ['normal', 'cheat'];

export class Game {
  /**
   * @param {object} opts
   * @param {number} [opts.seed=1]      green seed
   * @param {'normal'|'cheat'} [opts.mode='normal']
   * @param {object} [opts.terrainParams] use an explicit green instead of a seed
   */
  constructor({ seed = 1, mode = 'normal', terrainParams = null } = {}) {
    this.initial = { seed, mode, terrainParams };  // for Game.replay(game.initial, game.log)
    this.tick = 0;
    this.mode = mode;
    this.pending = [];
    this.log = [];
    this.events = [];
    this.card = [];
    this._loadGreen(seed, terrainParams);
  }

  _loadGreen(seed, terrainParams) {
    this.terrain = terrainParams ? new Terrain(terrainParams) : generateGreen(seed);
    this.seed = this.terrain.params.seed;
    const s = this.terrain.start;
    this.ball = { x: s.x, z: s.z, vx: 0, vz: 0 };
    this.prevBall = { ...this.ball };
    this.shotStart = { x: s.x, z: s.z };
    this.strokes = 0;
    const d = this.terrain.distToHole(s.x, s.z);
    this.par = d > 18 ? 3 : 2;
    this.phase = 'aim';
    this.swing = null;
    this.rollCtx = null;
    this.rollTicks = 0;
    this.lastShot = null;
    this.cheatPower = this.cheatPower ?? 0.3;
    this.aim = this.aimToHole();
  }

  // ---------------------------------------------------------------- input
  /** Queue an action; it is applied at the start of the next step(). */
  dispatch(action) {
    this.pending.push(action);
    return this;
  }

  aimToHole() {
    return atan2(this.terrain.hole.z - this.ball.z, this.terrain.hole.x - this.ball.x);
  }

  _apply(a) {
    switch (a.type) {
      case 'setAim':
        if (this.phase === 'aim') this.aim = a.aim;
        break;
      case 'setPower':
        this.cheatPower = Math.min(1, Math.max(0, a.power));
        break;
      case 'setMode':
        if (this.phase === 'swing') { this.phase = 'aim'; this.swing = null; }
        this.mode = a.mode;
        break;
      case 'newGreen':
        this._loadGreen(a.seed ?? (this.seed + 1), a.terrainParams || null);
        this.events.push({ type: 'newGreen', seed: this.seed });
        break;
      case 'putt': // direct putt (cheat mode button, agents, tests). aim/power default to current.
        if (this.phase === 'aim') this._launch(a.aim ?? this.aim, a.power ?? this.cheatPower, 0);
        break;
      case 'swingPress':
        this._swingPress();
        break;
      default:
        throw new Error(`unknown action ${a.type}`);
    }
  }

  _swingPress() {
    if (this.phase === 'aim' && this.mode === 'normal') {
      this.phase = 'swing';
      this.swing = { stage: 'power', value: 0, dir: 1, power: 0 };
    } else if (this.phase === 'swing') {
      const sw = this.swing;
      if (sw.stage === 'power') {
        sw.power = Math.max(0.005, sw.value);
        sw.stage = 'accuracy';
      } else if (sw.stage === 'accuracy') {
        this._hitFromSwing();
      }
    }
  }

  _hitFromSwing() {
    const sw = this.swing;
    const off = sw.value; // 0 == perfect impact; >0 early, <0 late
    const err = Math.abs(off) <= SWING.perfect ? 0 : Math.sign(off) * (Math.abs(off) - SWING.perfect) * SWING.errPerUnit;
    this.swing = null;
    this._launch(this.aim + err, sw.power, off);
  }

  _launch(aim, power, accuracy) {
    this.strokes++;
    this.shotStart = { x: this.ball.x, z: this.ball.z };
    this.ball = launchBall(this.ball.x, this.ball.z, aim, power);
    this.rollCtx = {};
    this.rollTicks = 0;
    this.phase = 'rolling';
    this.lastShot = { aim, power, accuracy, from: { ...this.shotStart }, result: null };
    this.events.push({ type: 'putt', aim, power, accuracy, strokes: this.strokes });
  }

  // ---------------------------------------------------------------- simulation
  /** Advance exactly one fixed tick (DT seconds). */
  step() {
    this.prevBall = { ...this.ball };
    for (const a of this.pending) { this.log.push({ tick: this.tick, action: a }); this._apply(a); }
    this.pending.length = 0;

    if (this.phase === 'swing') this._stepSwing();
    else if (this.phase === 'rolling') this._stepRoll();
    this.tick++;
  }

  _stepSwing() {
    const sw = this.swing;
    if (sw.stage === 'power') {
      sw.value += sw.dir * SWING.upRate * DT;
      if (sw.value >= 1) { sw.value = 1; sw.dir = -1; }
      if (sw.value <= 0 && sw.dir < 0) { this.phase = 'aim'; this.swing = null; this.events.push({ type: 'swingCancel' }); }
    } else {
      sw.value -= SWING.returnRate * DT;
      if (sw.value <= SWING.zoneMin) { sw.value = SWING.zoneMin; this._hitFromSwing(); }
    }
  }

  _stepRoll() {
    const r = stepBall(this.ball, this.terrain, this.rollCtx);
    this.rollTicks++;
    if (r === 'rolling' && this.rollTicks < MAX_ROLL_TICKS) return;
    const result = r === 'rolling' ? 'rest' : r;
    this.lastShot.result = result;
    this.ball.vx = 0; this.ball.vz = 0;
    if (result === 'holed') {
      this.ball.x = this.terrain.hole.x; this.ball.z = this.terrain.hole.z;
      this.phase = 'holed';
      this.card.push({ seed: this.seed, strokes: this.strokes, par: this.par });
      this.events.push({ type: 'holed', strokes: this.strokes, par: this.par });
    } else if (result === 'oob') {
      this.ball.x = this.shotStart.x; this.ball.z = this.shotStart.z;
      this.prevBall = { ...this.ball };
      this.strokes++; // penalty stroke
      this.phase = 'aim';
      this.aim = this.aimToHole();
      this.events.push({ type: 'oob', strokes: this.strokes });
    } else {
      this.phase = 'aim';
      this.aim = this.aimToHole();
      this.events.push({ type: 'rest', dist: this.distToHole(), lipouts: this.rollCtx.lipouts || 0 });
    }
  }

  /** Step n ticks. */
  run(n) { for (let i = 0; i < n; i++) this.step(); return this; }

  /** Step until the current putt finishes (phase leaves 'rolling'/'swing'). Returns ticks stepped. */
  runUntilSettled(maxTicks = MAX_ROLL_TICKS + 600) {
    let n = 0;
    do { this.step(); n++; } while ((this.phase === 'rolling' || this.phase === 'swing' || this.pending.length) && n < maxTicks);
    return n;
  }

  // ---------------------------------------------------------------- queries
  distToHole() { return this.terrain.distToHole(this.ball.x, this.ball.z); }

  /** Exact predicted path for a putt from the ball's current position (what cheat mode draws). */
  preview(aim = this.aim, power = this.cheatPower) {
    return simulatePutt(this.terrain, this.ball, aim, power);
  }

  /** Drain and return events since last call (UI uses this for messages/sounds). */
  takeEvents() { const e = this.events; this.events = []; return e; }

  /** JSON-friendly snapshot of everything interesting. */
  snapshot() {
    return {
      tick: this.tick, time: this.tick * DT, seed: this.seed, mode: this.mode, phase: this.phase,
      ball: { ...this.ball }, aim: this.aim, cheatPower: this.cheatPower,
      swing: this.swing ? { ...this.swing } : null,
      strokes: this.strokes, par: this.par, distToHole: this.distToHole(),
      surface: this.terrain.surface(this.ball.x, this.ball.z),
      hole: { ...this.terrain.hole }, start: { ...this.terrain.start },
      lastShot: this.lastShot, card: this.card.slice(),
    };
  }

  /** Re-run a recorded action log from scratch. Returns the new Game at tick `untilTick`. */
  static replay({ seed, mode = 'normal', terrainParams = null }, log, untilTick) {
    const g = new Game({ seed, mode, terrainParams });
    let i = 0;
    const end = untilTick ?? (log.length ? log[log.length - 1].tick + 1 : 0);
    while (g.tick < end) {
      while (i < log.length && log[i].tick === g.tick) g.dispatch(log[i++].action);
      g.step();
    }
    return g;
  }
}
