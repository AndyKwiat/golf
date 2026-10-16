// Headless CLI for the simulation (no browser).
//
//   node scripts/sim.mjs info  --seed 7                       # green summary
//   node scripts/sim.mjs putt  --seed 7 --power 0.5 [--aim RAD | --aim-offset RAD] [--path]
//   node scripts/sim.mjs solve --seed 7                       # bot plays the hole out with the solver
//   node scripts/sim.mjs bench --from 1 --to 50               # solver over many seeds (playability check)
import { Game } from '../src/sim/game.js';
import { solvePutt } from '../src/sim/solver.js';

const [cmd = 'info', ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
const seed = Number(a.seed ?? 1);
const r3 = v => Math.round(v * 1000) / 1000;

if (cmd === 'info') {
  const g = new Game({ seed });
  const t = g.terrain;
  console.log(JSON.stringify({ seed, R0: r3(t.R0), hole: t.hole, start: t.start, dist: r3(g.distToHole()), par: g.par, aimToHole: r3(g.aim), bumps: t.bumps.length, slopeAtHole: r3(t.slope(t.hole.x, t.hole.z)), slopeAtStart: r3(t.slope(t.start.x, t.start.z)) }, null, 2));
} else if (cmd === 'putt') {
  const g = new Game({ seed });
  const aim = a.aim !== undefined ? Number(a.aim) : g.aim + Number(a['aim-offset'] ?? 0);
  const pv = g.preview(aim, Number(a.power ?? 0.5));
  const out = { seed, aim: r3(aim), power: Number(a.power ?? 0.5), result: pv.result, ticks: pv.ticks, end: { x: r3(pv.end.x), z: r3(pv.end.z) }, distToHole: r3(g.terrain.distToHole(pv.end.x, pv.end.z)) };
  if (a.path) out.path = pv.path.filter((_, i) => i % 10 === 0).map(p => [r3(p.x), r3(p.z)]);
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === 'solve') {
  const g = new Game({ seed });
  const shots = [];
  while (g.phase !== 'holed' && g.strokes < 8) {
    const s = solvePutt(g.terrain, g.ball);
    g.dispatch({ type: 'putt', aim: s.aim, power: s.power }); g.runUntilSettled();
    shots.push({ aim: r3(s.aim), power: r3(s.power), result: g.lastShot.result, left: r3(g.distToHole()) });
  }
  console.log(JSON.stringify({ seed, strokes: g.strokes, par: g.par, holed: g.phase === 'holed', shots }, null, 2));
} else if (cmd === 'bench') {
  const from = Number(a.from ?? 1), to = Number(a.to ?? 20);
  let total = 0, n = 0, worst = [];
  for (let s = from; s <= to; s++) {
    const g = new Game({ seed: s });
    while (g.phase !== 'holed' && g.strokes < 8) {
      const p = solvePutt(g.terrain, g.ball);
      g.dispatch({ type: 'putt', aim: p.aim, power: p.power }); g.runUntilSettled();
    }
    total += g.strokes; n++;
    if (g.strokes > 1) worst.push({ seed: s, strokes: g.strokes });
  }
  console.log(JSON.stringify({ seeds: n, avgStrokes: r3(total / n), notOnePutt: worst }, null, 2));
} else {
  console.error('commands: info | putt | solve | bench'); process.exit(1);
}
