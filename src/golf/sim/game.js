// Full-hole game state machine. Same design as the putting game: all input is an action applied
// at the start of the next step(), logged with its tick; Game.replay rebuilds any session.
//
// Phases: 'aim' -> ('swing' in normal mode) -> 'moving' -> 'aim' ... -> 'holed'
import { DT, SWING, G, SURF, LIE, PUTT_MAX_FLAT, MAX_SHOT_TICKS } from './constants.js';
import { CLUBS, PUTTER, DRIVER, nominalTotal } from './clubs.js';
import { Hole, generateHole } from './hole.js';
import { stepShot, simulateShot, newShotCtx } from './ball.js';
import { len2, sin, cos, atan2 } from '../../sim/math.js';

/** Build the launched ball for a club/aim/power from a resting position and lie. */
export function launchBall(hole, pos, club, aim, power, lie) {
  const p = Math.min(1, Math.max(0, power));
  const y = hole.height(pos.x, pos.z);
  if (club.putter) {
    const mu = SURF[lie === 'green' ? 'green' : 'green'].roll;
    const v = Math.sqrt(2 * mu * G * p * PUTT_MAX_FLAT);
    return { x: pos.x, y, z: pos.z, vx: cos(aim) * v, vy: 0, vz: sin(aim) * v, spin: 0, air: false };
  }
  const L = LIE[lie] || LIE.rough;
  const sm = club.wedge && L.wedgeSpeed ? L.wedgeSpeed : L.speed;
  const v = club.speed * Math.sqrt(p) * sm;   // sqrt: carry is roughly proportional to power
  const vh = v * cos(club.angle), vy = v * sin(club.angle);
  return { x: pos.x, y: y + 0.001, z: pos.z, vx: cos(aim) * vh, vy, vz: sin(aim) * vh, spin: club.spin * L.spin, air: true };
}

export class GolfGame {
  constructor({ seed = 1, mode = 'cheat', holeParams = null } = {}) {
    this.initial = { seed, mode, holeParams };
    this.tick = 0;
    this.mode = mode;
    this.pending = [];
    this.log = [];
    this.events = [];
    this.card = [];
    this.power = 1;
    this._loadHole(seed, holeParams);
  }

  _loadHole(seed, holeParams) {
    this.hole = holeParams ? new Hole(holeParams) : generateHole(seed);
    this.seed = this.hole.seed;
    const t = this.hole.tee;
    this.ball = { x: t.x, y: this.hole.height(t.x, t.z), z: t.z, vx: 0, vy: 0, vz: 0, spin: 0, air: false };
    this.prevBall = { ...this.ball };
    this.shotStart = { x: t.x, z: t.z };
    this.strokes = 0;
    this.phase = 'aim';
    this.swing = null;
    this.shotCtx = null;
    this.shotTicks = 0;
    this.lastShot = null;
    this.tracer = [];
    this._newLie();
  }

  get lie() { return this.hole.surface(this.ball.x, this.ball.z); }
  get club() { return CLUBS[this.clubId]; }

  /** Called whenever the ball comes to rest somewhere new: auto club, aim and power. */
  _newLie() {
    const lie = this.lie;
    const d = this.distToHole();
    if (lie === 'green') this.clubId = PUTTER;
    else this.clubId = this.suggestClub(d, lie);
    this.aim = this.suggestAim(this.club);
    this.power = this.suggestPower(this.club, d, this.aim);
  }

  suggestClub(dist, lie = this.lie) {
    let pick = null;
    for (let i = CLUBS.length - 2; i >= 0; i--) {   // shortest first
      if (i === DRIVER && lie !== 'tee') continue;
      if (nominalTotal(CLUBS[i]) >= dist * 0.95) { pick = i; break; }
    }
    if (pick === null) pick = lie === 'tee' ? DRIVER : 1;
    if (dist < 25 && lie === 'fringe') pick = PUTTER;
    return pick;
  }

  /** Aim at the cup if in range, else at the centerline point about one club-length ahead. */
  suggestAim(club) {
    const h = this.hole, b = this.ball;
    const dCup = this.distToHole();
    const reach = club.putter ? Infinity : nominalTotal(club);
    if (dCup <= reach * 1.05) return atan2(h.cup.z - b.z, h.cup.x - b.x);
    let target = null;
    for (let z = b.z; z <= h.L; z += 2) {
      const x = h.cx(z);
      if (len2(x - b.x, z - b.z) >= reach) { target = { x, z }; break; }
    }
    if (!target) target = h.cup;
    return atan2(target.z - b.z, target.x - b.x);
  }

  /**
   * Auto-caddie power: bisection on the real simulation so the ball finishes about `dist` along
   * the aim line (accounts for slopes, roll and lie). Full power when out of range.
   */
  suggestPower(club, dist, aim = this.aim) {
    const ax = cos(aim), az = sin(aim);
    const along = p => {
      const r = simulateShot(this.hole, launchBall(this.hole, this.ball, club, aim, p, this.lie), { recordPath: false });
      return (r.end.x - this.ball.x) * ax + (r.end.z - this.ball.z) * az;
    };
    if (!club.putter && dist >= nominalTotal(club) * 1.05) return 1;
    let lo = club.putter ? 0.005 : 0.15, hi = 1;
    if (along(hi) <= dist) return hi;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (along(mid) < dist) lo = mid; else hi = mid; }
    return Math.round(((lo + hi) / 2) * 1000) / 1000;
  }

  aimToHole() { return atan2(this.hole.cup.z - this.ball.z, this.hole.cup.x - this.ball.x); }
  distToHole() { return this.hole.distToCup(this.ball.x, this.ball.z); }

  // ---------------------------------------------------------------- input
  dispatch(action) { this.pending.push(action); return this; }

  _apply(a) {
    switch (a.type) {
      case 'setAim': if (this.phase === 'aim') this.aim = a.aim; break;
      case 'setPower': this.power = Math.min(1, Math.max(0, a.power)); break;
      case 'setClub':
        if (this.phase === 'aim' && a.club >= 0 && a.club < CLUBS.length) {
          this.clubId = a.club;
          if (a.reaim !== false) { this.aim = this.suggestAim(this.club); this.power = this.suggestPower(this.club, this.distToHole()); }
          else this.power = this.suggestPower(this.club, this.distToHole());
        }
        break;
      case 'cycleClub':
        if (this.phase === 'aim') this._apply({ type: 'setClub', club: (this.clubId + a.dir + CLUBS.length) % CLUBS.length, reaim: false });
        break;
      case 'setMode':
        if (this.phase === 'swing') { this.phase = 'aim'; this.swing = null; }
        this.mode = a.mode; break;
      case 'newHole':
        this._loadHole(a.seed ?? this.seed + 1, a.holeParams || null);
        this.events.push({ type: 'newHole', seed: this.seed, par: this.hole.par });
        break;
      case 'shoot': case 'putt':
        if (this.phase === 'aim') {
          if (a.club !== undefined) this.clubId = a.club;
          this._launch(a.aim ?? this.aim, a.power ?? this.power, 0);
        }
        break;
      case 'swingPress': this._swingPress(); break;
      default: throw new Error(`unknown action ${a.type}`);
    }
  }

  _swingPress() {
    if (this.phase === 'aim' && this.mode === 'normal') {
      this.phase = 'swing';
      this.swing = { stage: 'power', value: 0, dir: 1, power: 0 };
    } else if (this.phase === 'swing') {
      const sw = this.swing;
      if (sw.stage === 'power') { sw.power = Math.max(0.005, sw.value); sw.stage = 'accuracy'; }
      else this._hitFromSwing();
    }
  }

  _hitFromSwing() {
    const sw = this.swing, off = sw.value;
    const err = Math.abs(off) <= SWING.perfect ? 0 : Math.sign(off) * (Math.abs(off) - SWING.perfect) * SWING.errPerUnit;
    this.swing = null;
    this._launch(this.aim + err, sw.power, off);
  }

  /** Launched ball for the current state (what preview and the real shot both use). */
  launchFor(aim = this.aim, power = this.power, clubId = this.clubId) {
    return launchBall(this.hole, this.ball, CLUBS[clubId], aim, power, this.lie);
  }

  _launch(aim, power, accuracy) {
    this.strokes++;
    const lie = this.lie;
    this.shotStart = { x: this.ball.x, z: this.ball.z };
    this.ball = this.launchFor(aim, power);
    this.shotCtx = newShotCtx();
    this.shotCtx.lastDry = { ...this.shotStart };
    this.shotTicks = 0;
    this.phase = 'moving';
    this.tracer = [{ x: this.ball.x, y: this.ball.y, z: this.ball.z }];
    this.lastShot = { club: this.club.short, aim, power, accuracy, lie, from: { ...this.shotStart }, result: null };
    this.events.push({ type: 'shot', club: this.club.short, power, accuracy, strokes: this.strokes });
  }

  // ---------------------------------------------------------------- simulation
  step() {
    this.prevBall = { ...this.ball };
    for (const a of this.pending) { this.log.push({ tick: this.tick, action: a }); this._apply(a); }
    this.pending.length = 0;
    if (this.phase === 'swing') this._stepSwing();
    else if (this.phase === 'moving') this._stepMove();
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

  _stepMove() {
    const r = stepShot(this.ball, this.hole, this.shotCtx);
    this.shotTicks++;
    this.tracer.push({ x: this.ball.x, y: this.ball.y, z: this.ball.z });
    if (r === 'moving' && this.shotTicks < MAX_SHOT_TICKS) return;
    const result = r === 'moving' ? 'rest' : r;
    const ls = this.lastShot;
    ls.result = result;
    ls.carry = this.shotCtx.landing ? len2(this.shotCtx.landing.x - ls.from.x, this.shotCtx.landing.z - ls.from.z) : 0;
    ls.total = len2(this.ball.x - ls.from.x, this.ball.z - ls.from.z);
    ls.treeHits = this.shotCtx.treeHits;
    this.ball.vx = this.ball.vy = this.ball.vz = 0; this.ball.air = false; this.ball.spin = 0;
    if (result === 'holed') {
      this.ball.x = this.hole.cup.x; this.ball.z = this.hole.cup.z;
      this.ball.y = this.hole.height(this.ball.x, this.ball.z);
      this.phase = 'holed';
      this.card.push({ seed: this.seed, par: this.hole.par, strokes: this.strokes });
      this.events.push({ type: 'holed', strokes: this.strokes, par: this.hole.par, club: ls.club });
      return;
    }
    if (result === 'water') {
      const drop = this.findDrop(this.shotCtx.lastDry || this.shotStart);
      this._placeBall(drop);
      this.strokes++;
      this.events.push({ type: 'water', strokes: this.strokes });
    } else if (result === 'oob') {
      this._placeBall(this.shotStart);
      this.strokes++;
      this.events.push({ type: 'oob', strokes: this.strokes });
    } else {
      this.ball.y = this.hole.height(this.ball.x, this.ball.z);
      this.events.push({ type: 'rest', lie: this.lie, dist: this.distToHole(), carry: ls.carry, total: ls.total, treeHits: ls.treeHits, lipouts: this.shotCtx.lipouts });
    }
    this.phase = 'aim';
    this._newLie();
  }

  _placeBall(p) {
    this.ball = { x: p.x, y: this.hole.height(p.x, p.z), z: p.z, vx: 0, vy: 0, vz: 0, spin: 0, air: false };
    this.prevBall = { ...this.ball };
  }

  /** Water drop: from the last dry point, walk back toward the shot origin until clear of hazards. */
  findDrop(from) {
    const h = this.hole, s = this.shotStart;
    const dx = s.x - from.x, dz = s.z - from.z, L = len2(dx, dz) || 1;
    const ok = (x, z) => {
      const surf = h.surface(x, z);
      if (surf === 'water' || surf === 'oob' || surf === 'sand') return false;
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; if (h.surface(x + cos(a) * 2, z + sin(a) * 2) === 'water') return false; }
      return true;
    };
    for (let t = 0; t <= L; t += 1) {
      const x = from.x + dx / L * t, z = from.z + dz / L * t;
      if (ok(x, z)) return { x, z };
    }
    return { ...s };
  }

  run(n) { for (let i = 0; i < n; i++) this.step(); return this; }
  runUntilSettled(maxTicks = MAX_SHOT_TICKS + 600) {
    let n = 0;
    do { this.step(); n++; } while ((this.phase === 'moving' || this.phase === 'swing' || this.pending.length) && n < maxTicks);
    return n;
  }

  /** Exact predicted shot from the current position (what cheat mode draws). */
  preview(aim = this.aim, power = this.power, clubId = this.clubId) {
    return simulateShot(this.hole, this.launchFor(aim, power, clubId));
  }

  takeEvents() { const e = this.events; this.events = []; return e; }

  snapshot() {
    return {
      tick: this.tick, seed: this.seed, mode: this.mode, phase: this.phase, par: this.hole.par,
      holeLength: this.hole.length, ball: { ...this.ball }, aim: this.aim, power: this.power,
      club: this.club.short, clubId: this.clubId, lie: this.lie, strokes: this.strokes,
      distToHole: this.distToHole(), cup: { ...this.hole.cup }, swing: this.swing ? { ...this.swing } : null,
      lastShot: this.lastShot, card: this.card.slice(),
    };
  }

  static replay({ seed, mode = 'cheat', holeParams = null }, log, untilTick) {
    const g = new GolfGame({ seed, mode, holeParams });
    let i = 0;
    const end = untilTick ?? (log.length ? log[log.length - 1].tick + 1 : 0);
    while (g.tick < end) {
      while (i < log.length && log[i].tick === g.tick) g.dispatch(log[i++].action);
      g.step();
    }
    return g;
  }
}

export { CLUBS, PUTTER };
