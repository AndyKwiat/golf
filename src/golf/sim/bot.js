// Simple bot: searches clubs x aim offsets x powers with the exact simulator and picks the shot
// whose result scores best (distance to cup plus hazard penalties). Used by tests and by
// agents (window.__golf.autoShot()) to play holes out deterministically.
import { CLUBS, PUTTER } from './clubs.js';
import { launchBall } from './game.js';
import { simulateShot } from './ball.js';

const LIE_COST = { green: 0, fringe: 2, fairway: 3, tee: 3, rough: 8, sand: 14 };

export function botShot(game) {
  const h = game.hole, b = game.ball, lie = game.lie;
  const base = game.aimToHole();
  const score = (clubId, aim, power) => {
    const r = simulateShot(h, launchBall(h, b, CLUBS[clubId], aim, power, lie), { recordPath: false });
    if (r.result === 'holed') return { cost: -100, clubId, aim, power, result: r.result };
    if (r.result === 'water' || r.result === 'oob') return { cost: 1e6, clubId, aim, power, result: r.result };
    const d = h.distToCup(r.end.x, r.end.z), s = h.surface(r.end.x, r.end.z);
    return { cost: d + (LIE_COST[s] ?? 10) * (d > 30 ? 1 : 0.3), clubId, aim, power, result: r.result };
  };
  let best = null;
  const consider = s => { if (!best || s.cost < best.cost) best = s; };
  if (lie === 'green' || (lie === 'fringe' && game.distToHole() < 20)) {
    for (let i = -10; i <= 10; i++) for (let j = 1; j <= 24; j++) consider(score(PUTTER, base + i * 0.02, j / 24 * Math.min(1, game.distToHole() / 15 + 0.2)));
    // refine
    const b0 = best;
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) consider(score(PUTTER, b0.aim + i * 0.004, Math.max(0.005, b0.power + j * 0.006)));
    return best;
  }
  const dist = game.distToHole();
  const sug = game.suggestClub(dist, lie);
  const short = dist < 90;
  const clubs = (short ? [9, 10, 11, 12] : [sug - 1, sug, sug + 1]).filter(c => c >= 0 && c < PUTTER && (c !== 0 || lie === 'tee'));
  const powers = short ? [0.04, 0.08, 0.13, 0.2, 0.3, 0.42, 0.56, 0.72, 0.88, 1] : [0.5, 0.65, 0.8, 0.9, 1];
  const aim0 = short ? base : game.suggestAim(CLUBS[sug]);
  const da = short ? 0.03 : 0.04;
  for (const c of clubs) for (let i = -4; i <= 4; i++) for (const p of powers) consider(score(c, aim0 + i * da, p));
  if (short && dist < 30) for (let j = 1; j <= 12; j++) consider(score(PUTTER, base, j / 12 * Math.min(1, dist / 12)));
  const b0 = best;
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) consider(score(b0.clubId, b0.aim + i * (short ? 0.008 : 0.012), Math.min(1, Math.max(0.01, b0.power * (1 + j * 0.05)))));
  return best;
}

/** Play the current hole out with the bot. Returns the number of strokes. */
export function botPlayHole(game, maxStrokes = 12) {
  while (game.phase !== 'holed' && game.strokes < maxStrokes) {
    const s = botShot(game);
    game.dispatch({ type: 'shoot', club: s.clubId, aim: s.aim, power: s.power });
    game.runUntilSettled();
  }
  return game.strokes;
}
