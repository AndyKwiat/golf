// Headless CLI for the full-hole golf sim (no browser).
//
//   node scripts/golf.mjs info  --seed 7                    # hole summary (par, length, hazards)
//   node scripts/golf.mjs shot  --seed 7 [--club 7i] [--power 0.8] [--aim-offset 0.02] [--path]
//   node scripts/golf.mjs play  --seed 7                    # bot plays the hole, shot by shot
//   node scripts/golf.mjs bench --from 1 --to 20            # bot over many holes (playability check)
import { GolfGame } from '../src/golf/sim/game.js';
import { CLUBS } from '../src/golf/sim/clubs.js';
import { botShot } from '../src/golf/sim/bot.js';

const [cmd = 'info', ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
const seed = Number(a.seed ?? 1);
const r1 = v => Math.round(v * 10) / 10;
const out = o => console.log(JSON.stringify(o, null, 2));

if (cmd === 'info') {
  const g = new GolfGame({ seed }), h = g.hole;
  out({ seed, par: h.par, length: r1(h.length), cup: { x: r1(h.cup.x), z: r1(h.cup.z) }, greenR: r1(h.green.R0), bunkers: h.bunkers.length, ponds: h.ponds.length, trees: h.trees.length, suggested: { club: g.club.short, power: g.power, aim: g.aim } });
} else if (cmd === 'shot') {
  const g = new GolfGame({ seed });
  if (a.club) g.dispatch({ type: 'setClub', club: CLUBS.findIndex(c => c.short === a.club) }).step();
  const aim = g.aim + Number(a['aim-offset'] ?? 0), power = a.power !== undefined ? Number(a.power) : g.power;
  const r = g.preview(aim, power);
  const o = { seed, club: g.club.short, aim: Math.round(aim * 1e4) / 1e4, power, result: r.result, ticks: r.ticks, treeHits: r.treeHits,
    carry: r.landing ? r1(Math.hypot(r.landing.x - g.ball.x, r.landing.z - g.ball.z)) : 0, total: r1(Math.hypot(r.end.x - g.ball.x, r.end.z - g.ball.z)),
    apex: r1(r.maxHeight), endLie: g.hole.surface(r.end.x, r.end.z), toPin: r1(g.hole.distToCup(r.end.x, r.end.z)) };
  if (a.path) o.path = r.path.filter((_, i) => i % 15 === 0).map(p => [r1(p.x), r1(p.y), r1(p.z)]);
  out(o);
} else if (cmd === 'play') {
  const g = new GolfGame({ seed }), shots = [];
  while (g.phase !== 'holed' && g.strokes < 15) {
    const s = botShot(g);
    g.dispatch({ type: 'shoot', club: s.clubId, aim: s.aim, power: s.power }); g.runUntilSettled();
    shots.push({ club: g.lastShot.club, power: Math.round(s.power * 1000) / 1000, result: g.lastShot.result, lie: g.lie, toPin: r1(g.distToHole()), treeHits: g.lastShot.treeHits });
  }
  out({ seed, par: g.hole.par, length: r1(g.hole.length), strokes: g.strokes, holed: g.phase === 'holed', shots });
} else if (cmd === 'bench') {
  const from = Number(a.from ?? 1), to = Number(a.to ?? 10), rows = [];
  let over = 0;
  for (let s = from; s <= to; s++) {
    const g = new GolfGame({ seed: s });
    while (g.phase !== 'holed' && g.strokes < 15) { const b = botShot(g); g.dispatch({ type: 'shoot', club: b.clubId, aim: b.aim, power: b.power }); g.runUntilSettled(); }
    over += g.strokes - g.hole.par;
    rows.push(`${s}: par ${g.hole.par} ${g.hole.length.toFixed(0)}m -> ${g.strokes}${g.phase === 'holed' ? '' : ' (NOT HOLED)'}`);
  }
  console.log(rows.join('\n') + `\ntotal vs par: ${over >= 0 ? '+' : ''}${over}`);
} else { console.error('commands: info | shot | play | bench'); process.exit(1); }
