// Ball physics. A ball is a plain object {x, z, vx, vz}; height comes from the terrain.
// stepBall() advances exactly one fixed tick (DT) using SUBSTEPS semi-implicit Euler substeps.
// The SAME function is used for live play and for the cheat-mode preview, so previews are exact.
import { len2, cos, sin } from './math.js';
import { DT, SUBSTEPS, G, ROLL_FACTOR, FRICTION, REST_SPEED, CUP_R, CUP_CAPTURE_SPEED, MAX_FLAT_DIST } from './constants.js';

/** Initial speed for a given power so that the ball rolls power*MAX_FLAT_DIST on a flat green. */
export function powerToSpeed(power) {
  const p = Math.min(1, Math.max(0, power));
  return Math.sqrt(2 * FRICTION.green * G * p * MAX_FLAT_DIST);
}

export function launchBall(x, z, aim, power) {
  const v = powerToSpeed(power);
  return { x, z, vx: cos(aim) * v, vz: sin(aim) * v };
}

/**
 * Advance the ball one tick. Mutates `ball`. Returns one of:
 *  'rolling' | 'rest' | 'holed' | 'oob'
 * `ctx` carries per-putt state (e.g. whether we've already lipped out over the cup).
 */
export function stepBall(ball, terrain, ctx = {}) {
  const h = DT / SUBSTEPS;
  const hole = terrain.hole;
  for (let i = 0; i < SUBSTEPS; i++) {
    const surf = terrain.surface(ball.x, ball.z);
    if (surf === 'oob') return 'oob';
    const mu = FRICTION[surf];
    const [gx, gz] = terrain.grad(ball.x, ball.z);
    const n = Math.sqrt(1 + gx * gx + gz * gz);
    const ax = -ROLL_FACTOR * G * gx / n;
    const az = -ROLL_FACTOR * G * gz / n;

    ball.vx += ax * h;
    ball.vz += az * h;
    const sp = len2(ball.vx, ball.vz);
    const fr = mu * G * h;
    if (sp <= fr) { ball.vx = 0; ball.vz = 0; }
    else { const k = (sp - fr) / sp; ball.vx *= k; ball.vz *= k; }

    ball.x += ball.vx * h;
    ball.z += ball.vz * h;

    // Cup: capture if the ball is over the cup and slow enough for how centered it is.
    const dx = ball.x - hole.x, dz = ball.z - hole.z;
    const d = len2(dx, dz);
    const speed = len2(ball.vx, ball.vz);
    if (d < CUP_R) {
      const off = d / CUP_R;
      const vcap = CUP_CAPTURE_SPEED * Math.sqrt(Math.max(0, 1 - off * off));
      if (speed <= vcap || speed < REST_SPEED) return 'holed';
      if (!ctx.overCup) {
        // Lip-out: deflect away from the cup center a little and bleed some speed.
        ctx.overCup = true;
        ctx.lipouts = (ctx.lipouts || 0) + 1;
        const tx = -ball.vz / speed, tz = ball.vx / speed;     // left-hand normal of travel
        const side = Math.sign(dx * tx + dz * tz) || 1;         // which side of center we're on
        const turn = side * 0.25 * off;
        const c = cos(turn), s = sin(turn);
        const vx = ball.vx * c - ball.vz * s, vz = ball.vx * s + ball.vz * c;
        ball.vx = vx * 0.85; ball.vz = vz * 0.85;
      }
    } else if (ctx.overCup && d > CUP_R + 0.01) {
      ctx.overCup = false;
    }

    if (speed < REST_SPEED && len2(ax, az) <= mu * G) {
      ball.vx = 0; ball.vz = 0;
      return 'rest';
    }
  }
  return 'rolling';
}

/**
 * Simulate a full putt without touching game state. Returns
 * { result, ticks, path: [{x,z}] (one sample per tick, including the start), end: {x,z} }.
 */
export function simulatePutt(terrain, from, aim, power, { maxTicks = 60 * 90, recordPath = true } = {}) {
  const ball = launchBall(from.x, from.z, aim, power);
  const ctx = {};
  const path = recordPath ? [{ x: ball.x, z: ball.z }] : null;
  let result = 'rolling', ticks = 0;
  while (result === 'rolling' && ticks < maxTicks) {
    result = stepBall(ball, terrain, ctx);
    ticks++;
    if (path) path.push({ x: ball.x, z: ball.z });
  }
  if (result === 'rolling') result = 'rest';
  return { result, ticks, path, end: { x: ball.x, z: ball.z }, lipouts: ctx.lipouts || 0 };
}
