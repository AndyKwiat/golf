// 3D ball physics for full shots + rolling. A ball is
//   {x, y, z, vx, vy, vz, spin, side, air}
// spin = backspin (lift coefficient), side = sidespin (+ fades / curves right, - draws / left).
// Wind {x, z} (m/s) acts on the airborne ball through air-relative velocity.
// stepShot() advances exactly one tick (DT) using SUBSTEPS substeps. The same function drives
// live play and the cheat-mode preview, so previews are exact.
import { DT, SUBSTEPS, G, ROLL_FACTOR, KD, KL, SPIN_DECAY, SURF, BACKSPIN_BITE, BOUNCE_TO_ROLL, BALL_R, CUP_R, CUP_CAPTURE_SPEED, REST_SPEED, MAX_SHOT_TICKS } from './constants.js';
import { len2, sin, cos } from '../../sim/math.js';

const NO_WIND = { x: 0, z: 0 };

/** Pure aerodynamic step (no ground, no trees). Shared with club calibration. */
export function airStep(b, h, wind = NO_WIND) {
  // air-relative velocity
  const rx = b.vx - wind.x, ry = b.vy, rz = b.vz - wind.z;
  const sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
  let ax = 0, ay = -G, az = 0;
  if (sp > 1e-6) {
    ax -= KD * sp * rx; ay -= KD * sp * ry; az -= KD * sp * rz;
    // lift: perpendicular to v_rel, in the vertical plane, pointing "up"
    const uy = ry / sp;
    const nx = -uy * rx / sp, ny = 1 - uy * uy, nz = -uy * rz / sp;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 1e-9) {
      const L = KL * b.spin * sp * sp / nl;
      ax += nx * L; ay += ny * L; az += nz * L;
    }
    // sidespin: horizontal force to the right of travel (+side = fade/right, - = draw/left)
    const hl = Math.sqrt(rx * rx + rz * rz);
    if (b.side && hl > 1e-6) {
      const S = KL * b.side * sp * sp / hl;
      ax += -rz * S; az += rx * S;
    }
  }
  b.vx += ax * h; b.vy += ay * h; b.vz += az * h;
  b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
  const k = 1 - h / SPIN_DECAY;
  b.spin *= k;
  if (b.side) b.side *= k;
}

function hashAngle(a, b) {
  let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 7, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5);
}

function treeCollide(b, hole, ctx, h) {
  const trees = hole.treesNear(b.x, b.z);
  let insideCrown = null;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const dx = b.x - t.x, dz = b.z - t.z;
    const hd = len2(dx, dz);
    // trunk (vertical cylinder)
    if (b.y < t.y0 + t.trunkTop && hd < t.trunkR + BALL_R && hd > 1e-9) {
      const nx = dx / hd, nz = dz / hd;
      b.x = t.x + nx * (t.trunkR + BALL_R + 1e-4); b.z = t.z + nz * (t.trunkR + BALL_R + 1e-4);
      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) { b.vx -= 1.45 * vn * nx; b.vz -= 1.45 * vn * nz; b.vx *= 0.8; b.vz *= 0.8; b.vy *= 0.8; }
      ctx.treeHits++;
      continue;
    }
    if (!b.air) continue;
    // crown
    let inside = false, nx = 0, ny = 0, nz = 0;
    if (t.shape ? t.shape === 'cone' : t.type === 'pine') {
      const H = t.crownTop - t.crownBase, yr = b.y - (t.y0 + t.crownBase);
      if (yr > 0 && yr < H && hd < t.crownR * (1 - yr / H)) {
        inside = true;
        const hdx = hd > 1e-9 ? dx / hd : 1, hdz = hd > 1e-9 ? dz / hd : 0;
        nx = hdx; ny = t.crownR / H; nz = hdz;
      }
    } else {
      const cy = t.y0 + t.crownY, ex = dx / t.crownR, ey = (b.y - cy) / t.crownRy, ez = dz / t.crownR;
      if (ex * ex + ey * ey + ez * ez < 1) {
        inside = true;
        nx = ex / t.crownR; ny = ey / t.crownRy; nz = ez / t.crownR;
      }
    }
    if (!inside) continue;
    insideCrown = t.id;
    if (ctx.inCrown !== t.id) {
      // entering the leaves: bounce off the crown surface, lose most of the speed, deflect a bit
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const vn = b.vx * nx + b.vy * ny + b.vz * nz;
      if (vn < 0) { b.vx -= 1.3 * vn * nx; b.vy -= 1.3 * vn * ny; b.vz -= 1.3 * vn * nz; }
      b.vx *= 0.45; b.vy *= 0.45; b.vz *= 0.45;
      const ang = hashAngle(t.id, ctx.treeHits) * 0.9, c = cos(ang), s = sin(ang);
      const vx = b.vx * c - b.vz * s, vz = b.vx * s + b.vz * c;
      b.vx = vx; b.vz = vz;
      b.spin *= 0.3;
      ctx.treeHits++;
    } else {
      // inside the branches: heavy damping, the ball drops out
      const k = 1 - 2.5 * h;
      b.vx *= k; b.vy *= k; b.vz *= k;
    }
  }
  ctx.inCrown = insideCrown;
}

export function newShotCtx() {
  return { treeHits: 0, inCrown: null, bounces: 0, landing: null, lastDry: null, overCup: false, lipouts: 0, maxHeight: 0, carry: 0 };
}

/**
 * Advance one tick. Mutates ball & ctx. Returns 'moving' | 'rest' | 'holed' | 'water' | 'oob'.
 */
export function stepShot(b, hole, ctx) {
  const h = DT / SUBSTEPS;
  const cup = hole.cup;
  for (let i = 0; i < SUBSTEPS; i++) {
    if (b.air) {
      airStep(b, h, hole.wind);
      treeCollide(b, hole, ctx, h);
      const gy = hole.height(b.x, b.z);
      if (b.y - gy > ctx.maxHeight) ctx.maxHeight = b.y - gy;
      if (b.y <= gy) {
        const surf = hole.surface(b.x, b.z);
        b.y = gy;
        if (surf === 'water') return 'water';
        if (surf === 'oob') return 'oob';
        if (!ctx.landing) ctx.landing = { x: b.x, y: gy, z: b.z };
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
        if (len2(b.x - cup.x, b.z - cup.z) < CUP_R && sp < 7) return 'holed';
        const [gx, gz] = hole.grad(b.x, b.z);
        let nx = -gx, ny = 1, nz = -gz;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz); nx /= nl; ny /= nl; nz /= nl;
        const vn = b.vx * nx + b.vy * ny + b.vz * nz;
        if (vn < 0) {
          const P = SURF[surf];
          const tx = b.vx - vn * nx, ty = b.vy - vn * ny, tz = b.vz - vn * nz;
          const keep = 1 - Math.min(0.95, P.tf + BACKSPIN_BITE * b.spin * P.grip);
          const out = -vn * P.e;
          b.vx = tx * keep + out * nx; b.vy = ty * keep + out * ny; b.vz = tz * keep + out * nz;
          b.spin *= 0.5;
          b.side = 0;
          ctx.bounces++;
          if (out < BOUNCE_TO_ROLL) { b.air = false; b.vy = 0; }
        }
      }
    } else {
      const surf = hole.surface(b.x, b.z);
      if (surf === 'water') return 'water';
      if (surf === 'oob') return 'oob';
      const mu = SURF[surf].roll;
      const [gx, gz] = hole.grad(b.x, b.z);
      const n = Math.sqrt(1 + gx * gx + gz * gz);
      const ax = -ROLL_FACTOR * G * gx / n, az = -ROLL_FACTOR * G * gz / n;
      b.vx += ax * h; b.vz += az * h;
      const sp = len2(b.vx, b.vz), fr = mu * G * h;
      if (sp <= fr) { b.vx = 0; b.vz = 0; } else { const k = (sp - fr) / sp; b.vx *= k; b.vz *= k; }
      b.x += b.vx * h; b.z += b.vz * h;
      treeCollide(b, hole, ctx, h);
      b.y = hole.height(b.x, b.z);

      const dx = b.x - cup.x, dz = b.z - cup.z, d = len2(dx, dz), speed = len2(b.vx, b.vz);
      if (d < CUP_R) {
        const off = d / CUP_R;
        if (speed <= CUP_CAPTURE_SPEED * Math.sqrt(Math.max(0, 1 - off * off)) || speed < REST_SPEED) return 'holed';
        if (!ctx.overCup) {
          ctx.overCup = true; ctx.lipouts++;
          const tx = -b.vz / speed, tz = b.vx / speed;
          const side = Math.sign(dx * tx + dz * tz) || 1, turn = side * 0.25 * off;
          const c = cos(turn), s = sin(turn);
          const vx = b.vx * c - b.vz * s, vz = b.vx * s + b.vz * c;
          b.vx = vx * 0.85; b.vz = vz * 0.85;
        }
      } else if (ctx.overCup && d > CUP_R + 0.01) ctx.overCup = false;

      if (speed < REST_SPEED && len2(ax, az) <= mu * G) { b.vx = 0; b.vz = 0; return 'rest'; }
    }
  }
  const s = hole.surface(b.x, b.z);
  if (s !== 'water' && s !== 'oob') ctx.lastDry = { x: b.x, z: b.z };
  return 'moving';
}

/**
 * Simulate a full shot from an already-launched ball (see launchBall in game.js).
 * Returns { result, ticks, path: [{x,y,z}], end, landing, treeHits, lastDry, maxHeight }.
 */
export function simulateShot(hole, ball0, { maxTicks = MAX_SHOT_TICKS, recordPath = true } = {}) {
  const b = { ...ball0 };
  const ctx = newShotCtx();
  ctx.lastDry = { x: b.x, z: b.z };
  const path = recordPath ? [{ x: b.x, y: b.y, z: b.z }] : null;
  let result = 'moving', ticks = 0;
  while (result === 'moving' && ticks < maxTicks) {
    result = stepShot(b, hole, ctx);
    ticks++;
    if (path) path.push({ x: b.x, y: b.y, z: b.z });
  }
  if (result === 'moving') result = 'rest';
  return { result, ticks, path, end: { x: b.x, y: b.y, z: b.z }, landing: ctx.landing, treeHits: ctx.treeHits, lastDry: ctx.lastDry, maxHeight: ctx.maxHeight, lipouts: ctx.lipouts };
}
