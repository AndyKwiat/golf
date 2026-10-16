// Club table. Each club is defined by its target full-power CARRY on flat ground; the launch
// speed is solved at load time (deterministic bisection on the same flight integrator).
import { airStep, simulateShot } from './ball.js';
import { DT, SUBSTEPS, G } from './constants.js';
import { sin, cos } from '../../sim/math.js';

const DEG = Math.PI / 180;
// name, short label, target carry (m), launch angle, spin (lift coefficient).
// Video-game distances: driver carries ~330 yd and totals ~350 yd with roll.
const TABLE = [
  ['Driver', 'Dr', 305, 11, 0.16],
  ['3 Wood', '3W', 273, 12, 0.18],
  ['5 Wood', '5W', 254, 13.5, 0.19],
  ['4 Iron', '4i', 234, 15, 0.20],
  ['5 Iron', '5i', 221, 16.5, 0.21],
  ['6 Iron', '6i', 208, 18, 0.22],
  ['7 Iron', '7i', 192, 20, 0.23],
  ['8 Iron', '8i', 177, 22.5, 0.24],
  ['9 Iron', '9i', 161, 25, 0.25],
  ['Pitching Wedge', 'PW', 143, 28, 0.26],
  ['Gap Wedge', 'GW', 124, 31, 0.27],
  ['Sand Wedge', 'SW', 104, 35, 0.28],
  ['Lob Wedge', 'LW', 78, 42, 0.28],
];

/** Carry (horizontal distance until y returns to 0) for a launch on flat ground, no trees. */
export function flatCarry(speed, angle, spin) {
  const b = { x: 0, y: 0, z: 0, vx: cos(angle) * speed, vy: sin(angle) * speed, vz: 0, spin, air: true };
  const h = DT / SUBSTEPS;
  for (let i = 0; i < 60 * 30 * SUBSTEPS; i++) {
    const py = b.y, px = b.x;
    airStep(b, h);
    if (b.y <= 0 && b.vy < 0) { const t = py / (py - b.y); return px + (b.x - px) * t; }
  }
  return b.x;
}

function solveSpeed(carry, angle, spin) {
  let lo = 5, hi = 250;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (flatCarry(mid, angle, spin) < carry) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const CLUBS = TABLE.map(([name, short, carry, angDeg, spin], i) => ({
  id: i, name, short, carry, angle: angDeg * DEG, spin, wedge: short.endsWith('W') && i >= 9,
  speed: solveSpeed(carry, angDeg * DEG, spin),
}));
CLUBS.push({ id: CLUBS.length, name: 'Putter', short: 'Pt', carry: 0, angle: 0, spin: 0, putter: true, speed: 0 });
export const PUTTER = CLUBS.length - 1;
export const DRIVER = 0;

// Flat, calm, all-fairway stand-in hole used to measure each club's typical total (carry + roll).
const FLAT_FAIRWAY = { height: () => 0, grad: () => [0, 0], surface: () => 'fairway', treesNear: () => [], cup: { x: 1e9, z: 1e9 }, wind: { x: 0, z: 0 } };
for (const c of CLUBS) {
  if (c.putter) { c.total = 0; continue; }
  const r = simulateShot(FLAT_FAIRWAY, { x: 0, y: 0.001, z: 0, vx: c.speed * cos(c.angle), vy: c.speed * sin(c.angle), vz: 0, spin: c.spin, side: 0, air: true }, { recordPath: false });
  c.total = r.end.x;
}

/** Full-power total distance (carry + roll) on a flat calm fairway; used for auto club selection. */
export function nominalTotal(club) { return club.total; }
export { G };
