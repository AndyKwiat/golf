// Brute-force putt solver (coarse-to-fine search over aim offset and power using the exact
// physics). Used by tests to check greens are playable and by agents for "bot" play-throughs.
import { atan2 } from './math.js';
import { simulatePutt } from './physics.js';

/**
 * Find a good putt from `from` on `terrain`.
 * Returns { aim, power, result, dist } where dist is the end distance to the hole (0 if holed).
 */
export function solvePutt(terrain, from, { aimSpan = 0.5, aimSteps = 21, powerSteps = 24, refine = 3 } = {}) {
  const base = atan2(terrain.hole.z - from.z, terrain.hole.x - from.x);
  const score = (aim, power) => {
    const r = simulatePutt(terrain, from, aim, power, { recordPath: false });
    if (r.result === 'holed') return { aim, power, result: 'holed', dist: 0, cost: -1 + power * 0.01 }; // prefer softer makes
    if (r.result === 'oob') return { aim, power, result: 'oob', dist: Infinity, cost: Infinity };
    const dist = terrain.distToHole(r.end.x, r.end.z);
    return { aim, power, result: r.result, dist, cost: dist };
  };
  let best = null;
  let aLo = base - aimSpan, aHi = base + aimSpan, pLo = 0.01, pHi = 1;
  for (let it = 0; it <= refine; it++) {
    for (let i = 0; i < aimSteps; i++) {
      const aim = aLo + (aHi - aLo) * (i / (aimSteps - 1));
      for (let j = 0; j < powerSteps; j++) {
        const power = pLo + (pHi - pLo) * (j / (powerSteps - 1));
        const s = score(aim, power);
        if (!best || s.cost < best.cost) best = s;
      }
    }
    if (best.result === 'holed') break;
    const da = (aHi - aLo) / (aimSteps - 1) * 1.5, dp = (pHi - pLo) / (powerSteps - 1) * 1.5;
    aLo = best.aim - da; aHi = best.aim + da;
    pLo = Math.max(0.005, best.power - dp); pHi = Math.min(1, best.power + dp);
  }
  return { aim: best.aim, power: best.power, result: best.result, dist: best.dist };
}
