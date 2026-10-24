// Full-hole game state machine. Same design as the putting game: all input is an action applied
// at the start of the next step(), logged with its tick; Game.replay rebuilds any session.
//
// Phases: 'aim' -> ('swing' in normal mode) -> 'moving' -> 'aim' ... -> 'holed'
import { DT, SWING, G, SURF, LIE, PUTT_MAX_FLAT, MAX_SHOT_TICKS, CURVE_SIDESPIN } from './constants.js';
import { CLUBS, PUTTER, DRIVER, nominalTotal } from './clubs.js';
import { Hole, generateHole } from './hole.js';
import { stepShot, simulateShot, newShotCtx } from './ball.js';
import { len2, sin, cos, atan2 } from '../../sim/math.js';
import { scoreMouseSwing, MOUSE } from './mouseswing.js';

/**
 * Build the launched ball for a club/aim/power from a resting position and lie.
 * curve in [-1, 1]: -1 = full draw (curves left), +1 = full fade (curves right). Ignored for putts.
 */
export function launchBall(hole, pos, club, aim, power, lie, curve = 0) {
  const p = Math.min(MOUSE.maxPower, Math.max(0, power));   // > 1 only via a long, straight mouse swing
  const y = hole.height(pos.x, pos.z);
  if (club.putter) {
    const mu = SURF[lie === 'green' ? 'green' : 'green'].roll;
    const v = Math.sqrt(2 * mu * G * p * PUTT_MAX_FLAT);
    return { x: pos.x, y, z: pos.z, vx: cos(aim) * v, vy: 0, vz: sin(aim) * v, spin: 0, side: 0, air: false };
  }
  const L = LIE[lie] || LIE.rough;
  const sm = club.wedge && L.wedgeSpeed ? L.wedgeSpeed : L.speed;
  const v = club.speed * Math.sqrt(p) * sm;   // sqrt: carry is roughly proportional to power
  const vh = v * cos(club.angle), vy = v * sin(club.angle);
  const side = Math.max(-1, Math.min(1, curve)) * CURVE_SIDESPIN * L.spin;
  return { x: pos.x, y: y + 0.001, z: pos.z, vx: cos(aim) * vh, vy, vz: sin(aim) * vh, spin: club.spin * L.spin, side, air: true };
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
    this.ball = { x: t.x, y: this.hole.height(t.x, t.z), z: t.z, vx: 0, vy: 0, vz: 0, spin: 0, side: 0, air: false };
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
    this.curve = 0;
    if (lie === 'green') this.clubId = PUTTER;
    else this.clubId = this.suggestClub(d, lie);
    this._caddie(true);
  }

  /**
   * Auto caddie for the current club: aim at the target (cup if reachable, else the fairway
   * ahead), set power, then correct the aim for wind/curve drift using the real simulator so
   * the default shot (what cheat mode previews) actually finishes on the target line.
   */
  _caddie(mayChangeClub = false) {
    this._mayChangeClub = mayChangeClub;
    const club = this.club, b = this.ball;
    const tgt = this.suggestTarget(club);
    const tAng = atan2(tgt.z - b.z, tgt.x - b.x), tDist = len2(tgt.x - b.x, tgt.z - b.z);
    this.aim = tAng;
    this.power = this.suggestPower(club, this.distToHole(), this.aim);
    if (club.putter) return;
    this._steerTo(tAng, this.curve);
    const toCup = tgt.x === this.hole.cup.x && tgt.z === this.hole.cup.z;
    if (!toCup) {
      // fairway target: hit it full if a full shot still finishes in the fairway
      const r = simulateShot(this.hole, this.launchFor(this.aim, 1), { recordPath: false });
      if (r.result === 'rest' && this.hole.surface(r.end.x, r.end.z) === 'fairway') { this.power = 1; return; }
    }
    this.power = this.suggestPower(club, Math.min(this.distToHole(), tDist * 1.02 + 1), this.aim);
    this._avoidHazards();
  }

  /**
   * Direction from the ball to where a shot finishes, ignoring trees. The aim corrections use
   * this: with trees, one deflection sends the end point anywhere and the aim jumps wildly
   * (trees are handled separately by _avoidHazards). `landing` uses the first bounce instead:
   * smooth in aim/curve (the roll-out can tip off a slope). null if the shot barely moves.
   */
  _finishDir(aim, power, curve, landing = false) {
    if (!this._treeless || this._treelessOf !== this.hole) {
      this._treeless = Object.create(this.hole);
      this._treelessOf = this.hole;
      this._treeless.treesNear = () => [];
    }
    const r = simulateShot(this._treeless, launchBall(this.hole, this.ball, this.club, aim, power, this.lie, curve), { recordPath: false });
    const p = landing && r.landing ? r.landing : r.end;
    const ex = p.x - this.ball.x, ez = p.z - this.ball.z;
    return len2(ex, ez) < 1 ? null : atan2(ez, ex);
  }

  /** Correct this.aim (up to `iters` sims) so the shot with `curve` finishes (or lands) along direction `ang`. */
  _steerTo(ang, curve, iters = 3, landing = false) {
    for (let it = 0; it < iters; it++) {
      const d = this._finishDir(this.aim, this.power, curve, landing);
      if (d === null) break;
      let err = d - ang;
      err = atan2(sin(err), cos(err));
      this.aim -= Math.max(-0.2, Math.min(0.2, err));
      if (Math.abs(err) < 2e-4) break;
    }
  }

  /**
   * If the caddie's shot finds water / OOB / sand, search nearby aims and shorter powers for one
   * that doesn't (preferring fairway/green and staying close to the original plan).
   */
  _avoidHazards() {
    const BAD = { water: 1, oob: 1 };
    const evalShot = (aim, power, clubId = this.clubId) => {
      const r = simulateShot(this.hole, this.launchFor(aim, power, clubId), { recordPath: false });
      const lie = r.result === 'holed' ? 'green' : r.result === 'rest' ? this.hole.surface(r.end.x, r.end.z) : r.result;
      return { lie, d: this.hole.distToCup(r.end.x, r.end.z), trees: r.treeHits };
    };
    const cur = evalShot(this.aim, this.power);
    if (!BAD[cur.lie] && cur.lie !== 'sand' && !cur.trees) return;
    const rank = { green: 0, fringe: 1, fairway: 1, tee: 1, rough: 3, sand: 6 };
    let best = null;
    // when the caddie picked the club itself (new lie), it may also try one/two clubs either side
    const clubs = [this.clubId];
    if (this._mayChangeClub) for (const dc of [1, -1, 2, -2]) { const c = this.clubId + dc; if (c >= 0 && c < PUTTER && (c !== 0 || this.lie === 'tee')) clubs.push(c); }
    for (const c of clubs) {
      const base = c === this.clubId ? this.power : Math.min(1, this.suggestPower(CLUBS[c], this.distToHole(), this.aim));
      for (const dp of [1, 0.92, 0.84, 0.75, 0.65, 0.55]) {
        for (const da of [0, -0.03, 0.03, -0.06, 0.06, -0.1, 0.1]) {
          const p = Math.min(1, base * dp), a = this.aim + da, r = evalShot(a, p, c);
          if (BAD[r.lie]) continue;
          const cost = rank[r.lie] * 25 + r.d + Math.abs(da) * 200 + (r.trees ? 60 : 0) + (c === this.clubId ? 0 : 8);
          if (!best || cost < best.cost) best = { a, p, c, cost };
        }
        if (best && best.cost < 40) break;
      }
      if (best && best.cost < 40) break;
    }
    if (best) { this.aim = best.a; this.power = Math.round(best.p * 1000) / 1000; this.clubId = best.c; }
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

  /** Target point: the cup if in range, else the centerline point about one club-length ahead. */
  suggestTarget(club) {
    const h = this.hole, b = this.ball;
    const reach = club.putter ? Infinity : nominalTotal(club);
    if (this.distToHole() <= reach * 1.05) return { x: h.cup.x, z: h.cup.z };
    for (let z = b.z; z <= h.L; z += 2) {
      const x = h.cx(z);
      if (len2(x - b.x, z - b.z) >= reach) return { x, z };
    }
    return { x: h.cup.x, z: h.cup.z };
  }
  suggestAim(club) { const t = this.suggestTarget(club), b = this.ball; return atan2(t.z - b.z, t.x - b.x); }

  /**
   * Auto-caddie power: bisection on the real simulation so the ball finishes about `dist` along
   * the aim line (accounts for slopes, roll and lie). Full power when out of range.
   */
  suggestPower(club, dist, aim = this.aim) {
    const ax = cos(aim), az = sin(aim);
    const along = p => {
      const r = simulateShot(this.hole, launchBall(this.hole, this.ball, club, aim, p, this.lie, this.curve), { recordPath: false });
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
          if (a.reaim !== false) this._caddie();
          else this.power = this.suggestPower(this.club, this.distToHole());
        }
        break;
      case 'cycleClub':
        if (this.phase === 'aim') this._apply({ type: 'setClub', club: (this.clubId + a.dir + CLUBS.length) % CLUBS.length, reaim: false });
        break;
      case 'setCurve':
        if (this.phase === 'aim') {
          const prev = this.curve;
          this.curve = Math.max(-1, Math.min(1, a.curve));
          // keep the player's own line: shift the aim only by the change in curve drift
          // (the line is cached while the curve keeps changing with nothing else touched, e.g. Z/X held)
          if (a.reaim && !this.club.putter && this.curve !== prev) {
            const k = this._curveLine;
            const want = k && k.aim === this.aim && k.power === this.power && k.clubId === this.clubId && k.tick === this.tick - 1 && k.x === this.ball.x && k.z === this.ball.z
              ? k.want : this._finishDir(this.aim, this.power, prev, true);
            if (want !== null) this._steerTo(want, this.curve, 2, true);
            this._curveLine = { want, aim: this.aim, power: this.power, clubId: this.clubId, tick: this.tick, x: this.ball.x, z: this.ball.z };
          }
        }
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
          if (a.curve !== undefined) this.curve = Math.max(-1, Math.min(1, a.curve));
          this._launch(a.aim ?? this.aim, a.power ?? this.power, 0);
        }
        break;
      case 'swingPress': this._swingPress(); break;
      case 'mouseSwing': {   // {pts: [[x,y]...] screen px, screenH}: see mouseswing.js
        if (this.phase !== 'aim' || this.mode !== 'mouse') break;
        const r = scoreMouseSwing(a.pts, a.screenH, { putter: this.club.putter });
        if (!r) { this.events.push({ type: 'swingCancel' }); break; }
        this._launch(this.aim + r.aimErr, this.power * r.powerMul, r.aimErr);
        this.lastShot.mouse = { powerMul: r.powerMul, accuracy: r.accuracy, aimErr: r.aimErr };
        this.events.push({ type: 'mouseSwing', ...this.lastShot.mouse });
        break;
      }
      case 'placeBall':   // debug/agent helper: drop the ball anywhere (logged, so replays still work)
        if (this.phase === 'aim' || this.phase === 'holed') {
          this._placeBall({ x: a.x, z: a.z }); this.phase = 'aim'; this._newLie();
          if (a.lookX !== undefined) this.aim = atan2(a.lookZ - a.z, a.lookX - a.x);
        }
        break;
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
  launchFor(aim = this.aim, power = this.power, clubId = this.clubId, curve = this.curve) {
    return launchBall(this.hole, this.ball, CLUBS[clubId], aim, power, this.lie, curve);
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
    this.lastShot = { club: this.club.short, aim, power, curve: this.club.putter ? 0 : this.curve, accuracy, lie, from: { ...this.shotStart }, result: null };
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
    this.ball.vx = this.ball.vy = this.ball.vz = 0; this.ball.air = false; this.ball.spin = 0; this.ball.side = 0;
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
    this.ball = { x: p.x, y: this.hole.height(p.x, p.z), z: p.z, vx: 0, vy: 0, vz: 0, spin: 0, side: 0, air: false };
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
  preview(aim = this.aim, power = this.power, clubId = this.clubId, curve = this.curve) {
    return simulateShot(this.hole, this.launchFor(aim, power, clubId, curve));
  }

  takeEvents() { const e = this.events; this.events = []; return e; }

  snapshot() {
    return {
      tick: this.tick, seed: this.seed, mode: this.mode, phase: this.phase, par: this.hole.par,
      holeLength: this.hole.length, ball: { ...this.ball }, aim: this.aim, power: this.power,
      club: this.club.short, clubId: this.clubId, curve: this.curve, wind: { ...this.hole.wind }, lie: this.lie, strokes: this.strokes,
      theme: this.hole.theme, distToHole: this.distToHole(), cup: { ...this.hole.cup }, swing: this.swing ? { ...this.swing } : null,
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
