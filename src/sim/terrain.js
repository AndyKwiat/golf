// Procedural green: a smooth heightfield (sum of gaussian hills + tilt) and an irregular
// green outline (circle with a few low-frequency harmonics). Everything is derived from a
// plain JSON "params" object so greens can be saved, hand-edited and loaded in tests.
import { len2, exp, cos, sin, atan2 } from './math.js';
import { mulberry32 } from './rng.js';
import { FRINGE_WIDTH, ROUGH_WIDTH, WORLD_SIZE, CUP_R } from './constants.js';

const MAX_GREEN_SLOPE = 0.25;  // generated greens are rescaled so no point on the green is steeper than 25%
const MAX_CUP_SLOPE = 0.04;
const MAX_START_SLOPE = 0.07;  // must stay below the rest threshold (~mu*7/5 = 0.077) so the ball sits still

export class Terrain {
  constructor(params) {
    this.params = params;
    this.R0 = params.R0;
    this.harmonics = params.harmonics;
    this.bumps = params.bumps;
    this.tilt = params.tilt;
    this.collar = params.collar;
    this.hole = params.hole;
    this.start = params.start;
  }

  /** Radius of the green edge in direction theta. */
  greenRadius(theta) {
    let f = 1;
    for (const h of this.harmonics) f += h.a * cos(h.k * theta + h.p);
    return this.R0 * f;
  }

  /** Signed distance-ish value: < 0 inside green, > 0 outside (meters, radial). */
  edgeDist(x, z) {
    const r = len2(x, z);
    return r - this.greenRadius(atan2(z, x));
  }

  height(x, z) {
    let h = this.tilt[0] * x + this.tilt[1] * z;
    for (const b of this.bumps) {
      const dx = x - b.x, dz = z - b.z;
      h += b.a * exp(-(dx * dx + dz * dz) / (2 * b.s * b.s));
    }
    if (this.collar) {
      const d = this.edgeDist(x, z);
      h += this.collar * smoothstep(FRINGE_WIDTH, FRINGE_WIDTH + 6, d);
    }
    return h;
  }

  /** Gradient [dh/dx, dh/dz] by central differences (deterministic, smooth enough). */
  grad(x, z) {
    const e = 0.005;
    return [
      (this.height(x + e, z) - this.height(x - e, z)) / (2 * e),
      (this.height(x, z + e) - this.height(x, z - e)) / (2 * e),
    ];
  }

  slope(x, z) {
    const [gx, gz] = this.grad(x, z);
    return len2(gx, gz);
  }

  /** 'green' | 'fringe' | 'rough' | 'oob' */
  surface(x, z) {
    const half = WORLD_SIZE / 2 - 1;
    if (Math.abs(x) > half || Math.abs(z) > half) return 'oob';
    const d = this.edgeDist(x, z);
    if (d <= 0) return 'green';
    if (d <= FRINGE_WIDTH) return 'fringe';
    if (d <= FRINGE_WIDTH + ROUGH_WIDTH) return 'rough';
    return 'oob';
  }

  distToHole(x, z) {
    return len2(x - this.hole.x, z - this.hole.z);
  }
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Generate params for a random green from a seed. Same seed => identical green. */
export function generateGreenParams(seed) {
  const rand = mulberry32(seed);
  const R0 = 15 + rand() * 6;
  const harmonics = [];
  for (let k = 2; k <= 5; k++) {
    harmonics.push({ k, a: (0.03 + rand() * 0.09) / (k - 1) * 1.4, p: rand() * Math.PI * 2 });
  }
  const bumps = [];
  const n = 7 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * R0 * 1.15;
    const s = 3 + rand() * 5;
    const sign = rand() < 0.6 ? 1 : -1;
    bumps.push({ x: cos(ang) * rad, z: sin(ang) * rad, s, a: sign * (0.6 + rand() * 1.2) * (s / 5) });
  }
  const tAng = rand() * Math.PI * 2;
  const tMag = rand() * 0.04;
  const params = {
    seed, R0, harmonics, bumps,
    tilt: [cos(tAng) * tMag, sin(tAng) * tMag],
    collar: 0.35,
    hole: { x: 0, z: 0 },
    start: { x: 0, z: 0 },
  };

  // Rescale the hills so the green never gets absurdly steep.
  let t = new Terrain(params);
  let maxSlope = 0;
  for (let x = -R0 * 1.3; x <= R0 * 1.3; x += 0.5) {
    for (let z = -R0 * 1.3; z <= R0 * 1.3; z += 0.5) {
      if (t.edgeDist(x, z) <= 0) maxSlope = Math.max(maxSlope, t.slope(x, z));
    }
  }
  if (maxSlope > MAX_GREEN_SLOPE) {
    const k = MAX_GREEN_SLOPE / maxSlope;
    for (const b of bumps) b.a *= k;
    params.tilt = [params.tilt[0] * k, params.tilt[1] * k];
  }
  t = new Terrain(params);

  // Cup: inside the green, away from the edge, on a gentle slope.
  // Takes the first spot under MAX_CUP_SLOPE, else the flattest one sampled.
  let hole = null, flattest = null;
  for (let i = 0; i < 600 && !hole; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * t.greenRadius(ang) * 0.75;
    const x = cos(ang) * rad, z = sin(ang) * rad;
    if (t.edgeDist(x, z) < -2.5) {
      const slope = Math.max(t.slope(x, z), ...[0, 1, 2, 3].map(j => t.slope(x + CUP_R * cos(j * 1.57), z + CUP_R * sin(j * 1.57))));
      if (slope < MAX_CUP_SLOPE) hole = { x, z };
      else if (!flattest || slope < flattest.slope) flattest = { x, z, slope };
    }
  }
  params.hole = hole || (flattest ? { x: flattest.x, z: flattest.z } : { x: 0, z: 0 });

  // Ball start: on the green, a decent distance from the cup, prefer longer putts.
  let best = null;
  for (let i = 0; i < 300; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * t.greenRadius(ang);
    const x = cos(ang) * rad, z = sin(ang) * rad;
    if (t.edgeDist(x, z) > -1) continue;
    if (t.slope(x, z) > MAX_START_SLOPE) continue;
    const d = len2(x - params.hole.x, z - params.hole.z);
    if (d < 6) continue;
    // aim for 8-22 m putts, random within that
    const target = 8 + rand() * 14;
    const score = -Math.abs(d - target);
    if (!best || score > best.score) best = { x, z, score };
  }
  params.start = best ? { x: best.x, z: best.z } : { x: params.hole.x + 8, z: params.hole.z };
  return params;
}

export function generateGreen(seed) {
  return new Terrain(generateGreenParams(seed));
}

/** A perfectly flat circular green, handy for physics tests. */
export function flatGreen({ R0 = 20, hole = { x: 10, z: 0 }, start = { x: 0, z: 0 }, tilt = [0, 0], bumps = [] } = {}) {
  return new Terrain({ seed: 0, R0, harmonics: [], bumps, tilt, collar: 0, hole, start });
}
