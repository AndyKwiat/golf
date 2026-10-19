// Full-hole game sim tests (headless): `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';
import { GolfGame, launchBall } from '../src/golf/sim/game.js';
import { generateHoleParams, cleanParams, Hole } from '../src/golf/sim/hole.js';
import { CLUBS, PUTTER, flatCarry } from '../src/golf/sim/clubs.js';
import { simulateShot } from '../src/golf/sim/ball.js';
import { botPlayHole } from '../src/golf/sim/bot.js';

/** A flat, hazard-free version of a generated hole (handy for controlled experiments). */
function flatHole(seed = 3, edit = () => {}) {
  const p = cleanParams(generateHoleParams(seed));
  p.base = []; p.elev = 0; p.bunkers = []; p.ponds = []; p.trees = []; p.green.bumps = []; p.green.lift = 0;
  p.wind = { x: 0, z: 0 }; p.ctrl = [[0, 0], [p.L, 0]]; p.corners = []; p.green.x = 0;
  p.fairway.z0 = -60;   // fairway right from the tee, so rolling tests start on fairway
  edit(p);
  return p;
}

test('same seed => identical hole', () => {
  assert.deepEqual(cleanParams(generateHoleParams(17)), cleanParams(generateHoleParams(17)));
  assert.notDeepEqual(cleanParams(generateHoleParams(17)), cleanParams(generateHoleParams(18)));
});

test('generated holes are sane across many seeds', () => {
  const pars = new Set(); let water = 0, sand = 0;
  for (let s = 1; s <= 40; s++) {
    const g = new GolfGame({ seed: s }), h = g.hole;
    pars.add(h.par);
    assert.equal(h.surface(h.tee.x, h.tee.z), 'tee', `seed ${s} tee`);
    assert.equal(h.surface(h.cup.x, h.cup.z), 'green', `seed ${s} cup`);
    assert.ok(h.slope(h.cup.x, h.cup.z) < 0.08, `seed ${s} cup slope`);
    const range = { 3: [130, 235], 4: [325, 470], 5: [455, 600] }[h.par];   // meters (≈150-250 / 380-500 / 520-640 yd)
    assert.ok(h.length > range[0] && h.length < range[1], `seed ${s} par ${h.par} length ${h.length}`);
    for (const t of h.trees) assert.equal(h.surface(t.x, t.z), 'rough', `seed ${s} tree ${t.id} not in rough`);
    if (h.ponds.length) water++;
    for (const p of h.ponds) assert.notEqual(h.surface(h.cup.x, h.cup.z), 'water');
    const w = Math.hypot(h.wind.x, h.wind.z);
    assert.ok(w >= 3 && w <= 13, `seed ${s} wind ${w}`);
    if (h.bunkers.length) sand++;
  }
  assert.deepEqual([...pars].sort(), [3, 4, 5]);
  assert.ok(water >= 26 && sand >= 30, `water ${water} sand ${sand}`);
});

test('clubs carry their nominal distance at full power on flat ground', () => {
  for (const c of CLUBS) {
    if (c.putter) continue;
    const carry = flatCarry(c.speed, c.angle, c.spin);
    assert.ok(Math.abs(carry - c.carry) < 0.5, `${c.short}: ${carry}`);
  }
  // longer clubs go further
  for (let i = 1; i < PUTTER; i++) assert.ok(CLUBS[i].carry < CLUBS[i - 1].carry);
});

test('cheat preview exactly matches the live shot (full shot and putt)', () => {
  for (const seed of [2, 9]) {
    const g = new GolfGame({ seed });
    const pv = g.preview();
    g.dispatch({ type: 'shoot' });
    const live = [{ x: g.ball.x, y: g.ball.y, z: g.ball.z }];
    do { g.step(); live.push({ x: g.ball.x, y: g.ball.y, z: g.ball.z }); } while (g.phase === 'moving');
    assert.equal(g.lastShot.result, pv.result);
    // path[0] is the launched ball (lifted 1 mm off the turf); compare every simulated tick after it
    if (pv.result === 'rest') assert.deepEqual(live.slice(1), pv.path.slice(1), `seed ${seed}`);
  }
});

test('ball on the green auto-selects the putter', () => {
  const g = new GolfGame({ seed: 7 });
  botPlayHole(g, 1); // one bot shot
  if (g.lie === 'green') assert.equal(g.clubId, PUTTER);
  // force it: drop the ball on the green next to the cup
  const p = cleanParams(g.hole.params);
  p.tee = { x: p.cup.x + 0.01, z: p.cup.z - 30 };
  const g2 = new GolfGame({ holeParams: p });
  assert.notEqual(g2.lie, 'green');
  g2.ball.x = p.cup.x + 2; g2.ball.z = p.cup.z;
  g2._newLie();
  assert.equal(g2.clubId, PUTTER);
});

test('trees: a shot into a tree is knocked down short', () => {
  const p0 = flatHole(3);
  const free = new GolfGame({ holeParams: p0 });
  free.dispatch({ type: 'shoot', club: 6, aim: Math.PI / 2, power: 1 });
  free.runUntilSettled();
  const p1 = flatHole(3, p => {
    p.trees = [{ id: 0, x: 0, z: 20, type: 'round', s: 1, y0: 0, trunkR: 0.3, trunkTop: 3, crownY: 6, crownR: 4, crownRy: 4 }];
  });
  // check the free shot actually passes through that crown region
  const g = new GolfGame({ holeParams: p1 });
  const pv = g.preview(Math.PI / 2, 1, 6);
  assert.ok(pv.treeHits > 0, 'expected a tree hit');
  g.dispatch({ type: 'shoot', club: 6, aim: Math.PI / 2, power: 1 }); g.runUntilSettled();
  assert.ok(g.ball.z < free.ball.z - 50, `tree didn't stop it: ${g.ball.z} vs ${free.ball.z}`);
  assert.ok(g.lastShot.treeHits > 0);
});

test('trees: rolling into a trunk bounces back', () => {
  const p = flatHole(3, p => { p.trees = [{ id: 0, x: 0, z: 10, type: 'pine', s: 1, y0: 0, trunkR: 0.3, trunkTop: 2, crownBase: 1.2, crownTop: 9, crownR: 2.5 }]; });
  const h = new Hole(p);
  const r = simulateShot(h, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 8, spin: 0, air: false });
  assert.ok(r.treeHits > 0);
  assert.ok(r.end.z < 10, `ended at ${r.end.z}`);
});

test('water: penalty stroke and a drop on dry land', () => {
  const p = flatHole(3, p => {
    p.ponds = [{ x: 0, z: 190, R0: 15, rot: 0, sx: 1, harm: [], level: -0.2 }];
  });
  const g = new GolfGame({ holeParams: p });
  assert.equal(g.hole.surface(0, 190), 'water');
  g.dispatch({ type: 'shoot', club: 6, aim: Math.PI / 2, power: 1 }); g.runUntilSettled();
  assert.equal(g.lastShot.result, 'water');
  assert.equal(g.strokes, 2);
  assert.notEqual(g.lie, 'water');
  assert.ok(g.ball.z < 190 && g.ball.z > 150, `drop at z=${g.ball.z}`);
  assert.equal(g.phase, 'aim');
});

test('out of bounds: back to the previous spot with a penalty', () => {
  const p = flatHole(3);
  const g = new GolfGame({ holeParams: p });
  g.dispatch({ type: 'shoot', club: 0, aim: 0.15, power: 1 }); g.runUntilSettled(); // driver nearly sideways
  assert.equal(g.lastShot.result, 'oob');
  assert.equal(g.strokes, 2);
  assert.deepEqual([g.ball.x, g.ball.z], [p.tee.x, p.tee.z]);
});

test('sand stops a rolling ball fast', () => {
  const p = flatHole(3, p => { p.bunkers = [{ x: 0, z: 20, R0: 6, rot: 0, sx: 1, harm: [], depth: 0 }]; });
  const h = new Hole(p);
  const r = simulateShot(h, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 12, spin: 0, air: false });
  assert.equal(h.surface(r.end.x, r.end.z), 'sand');
  assert.ok(r.end.z < 20, `rolled to ${r.end.z}`);
});

test('determinism + replay of a full hole (mixed modes, clubs, swing meter)', () => {
  const g = new GolfGame({ seed: 21 });
  g.dispatch({ type: 'setClub', club: 1 }).run(2);
  g.dispatch({ type: 'setAim', aim: g.aim + 0.01 }).run(1);
  g.dispatch({ type: 'shoot' }); g.runUntilSettled();
  g.dispatch({ type: 'setMode', mode: 'normal' }).run(1);
  g.dispatch({ type: 'swingPress' }).run(50);
  g.dispatch({ type: 'swingPress' }).run(30);
  g.dispatch({ type: 'swingPress' }); g.runUntilSettled();
  g.dispatch({ type: 'cycleClub', dir: -1 }).dispatch({ type: 'setMode', mode: 'cheat' }).run(2);
  g.dispatch({ type: 'shoot' }); g.runUntilSettled();
  const r = GolfGame.replay(g.initial, g.log, g.tick);
  assert.deepEqual(r.snapshot(), g.snapshot());
});

test('launch from rough/sand is weaker than from fairway', () => {
  const h = new Hole(flatHole(3));
  const c = CLUBS[6], pos = { x: 0, z: 0 };
  const sp = l => { const b = launchBall(h, pos, c, 0, 1, l); return Math.hypot(b.vx, b.vy, b.vz); };
  assert.ok(sp('rough') < sp('fairway') && sp('sand') < sp('rough'));
});

test('bot can play holes out in a sensible number of strokes', () => {
  for (const seed of [5, 12, 30]) {
    const g = new GolfGame({ seed });
    const strokes = botPlayHole(g);
    assert.equal(g.phase, 'holed', `seed ${seed}`);
    assert.ok(strokes <= g.hole.par + 2, `seed ${seed}: ${strokes} on par ${g.hole.par}`);
  }
});

test('wind: tailwind carries further, headwind shorter, crosswind drifts downwind', () => {
  const carry = wind => {
    const g = new GolfGame({ holeParams: flatHole(3, p => { p.wind = wind; }) });
    const r = g.preview(Math.PI / 2, 1, 0, 0);
    return r.landing;
  };
  const calm = carry({ x: 0, z: 0 }), head = carry({ x: 0, z: -10 }), tail = carry({ x: 0, z: 10 }), cross = carry({ x: 10, z: 0 });
  assert.ok(head.z < calm.z - 20, `head ${head.z} vs ${calm.z}`);
  assert.ok(tail.z > calm.z + 10, `tail ${tail.z} vs ${calm.z}`);
  assert.ok(cross.x > 15, `cross drift ${cross.x}`);
  assert.ok(Math.abs(calm.x) < 1e-9);
});

test('wind does not affect putts', () => {
  const a = new GolfGame({ holeParams: flatHole(3) }), b = new GolfGame({ holeParams: flatHole(3, p => { p.wind = { x: 12, z: 0 }; }) });
  const pa = a.preview(Math.PI / 2, 0.5, PUTTER), pb = b.preview(Math.PI / 2, 0.5, PUTTER);
  assert.deepEqual(pa.end, pb.end);
});

test('draw curves left (+x from the tee), fade curves right (-x)', () => {
  const g = new GolfGame({ holeParams: flatHole(3, p => { p.roughW = 250; }) });   // wide corridor: full curve leaves a normal one
  const draw = g.preview(Math.PI / 2, 1, 0, -1).landing, fade = g.preview(Math.PI / 2, 1, 0, 1).landing, straight = g.preview(Math.PI / 2, 1, 0, 0).landing;
  assert.ok(draw.x > 90 && fade.x < -90, `full curve should bend a drive ~100+ m: draw ${draw.x} fade ${fade.x}`);
  assert.ok(Math.abs(draw.x + fade.x) < 1e-6, 'symmetric');
  assert.ok(Math.abs(straight.x) < 1e-9);
});

test('auto caddie compensates for wind: default shot finishes on its target line', () => {
  for (const wind of [{ x: 12, z: 0 }, { x: -9, z: 6 }, { x: 5, z: -10 }]) {
    const g = new GolfGame({ holeParams: flatHole(3, p => { p.wind = wind; }) });
    const t = g.suggestTarget(g.club), b = g.ball, r = g.preview();
    const tAng = Math.atan2(t.z - b.z, t.x - b.x), eAng = Math.atan2(r.end.z - b.z, r.end.x - b.x);
    const miss = Math.abs(Math.sin(eAng - tAng)) * Math.hypot(r.end.x - b.x, r.end.z - b.z);
    assert.ok(miss < 3, `wind ${JSON.stringify(wind)}: ${miss.toFixed(1)} m off line`);
  }
});

test('auto caddie: the default tee shot never finds water or out of bounds', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = new GolfGame({ seed });
    const r = g.preview();
    assert.ok(r.result !== 'water' && r.result !== 'oob', `seed ${seed}: ${r.result}`);
  }
});

test('replay includes curve actions', () => {
  const g = new GolfGame({ seed: 33 });
  g.dispatch({ type: 'setCurve', curve: -0.5 }).run(2);
  g.dispatch({ type: 'shoot' }); g.runUntilSettled();
  assert.equal(g.lastShot.curve, -0.5);
  assert.equal(g.curve, 0, 'curve resets on the new lie');
  const r = GolfGame.replay(g.initial, g.log, g.tick);
  assert.deepEqual(r.snapshot(), g.snapshot());
});

test('surface speeds: green fastest, fairway slower, rough much slower; rough lie costs distance', () => {
  const h = new Hole(flatHole(3));
  const rollOn = surf => { const hh = Object.create(h); hh.surface = () => surf; return simulateShot(hh, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 5, spin: 0, side: 0, air: false }).end.z; };
  const g = rollOn('green'), f = rollOn('fairway'), r = rollOn('rough');
  assert.ok(g > 3 * f && f > 2.5 * r, `green ${g} fairway ${f} rough ${r}`);
  const carry = lie => simulateShot(h, launchBall(h, { x: 0, z: 0 }, CLUBS[6], Math.PI / 2, 1, lie)).landing.z;
  assert.ok(carry('rough') < carry('fairway') * 0.8, `rough ${carry('rough')} vs fairway ${carry('fairway')}`);
  // a full driver shouldn't run out more than ~20 m on a flat fairway
  assert.ok(CLUBS[0].total - CLUBS[0].carry < 30, `driver roll ${CLUBS[0].total - CLUBS[0].carry}`);
  // video-game distances: a full drive totals ~350 yd
  assert.ok(Math.abs(CLUBS[0].total * 1.0936 - 350) < 10, `driver total ${CLUBS[0].total * 1.0936} yd`);
});

test('hole variety: every theme appears, with cliffs, island greens, tree islands and plenty of hazards', () => {
  const themes = new Set(); let cliffs = 0, islandGreens = 0, treeIslands = 0, bunkers = 0, ponds = 0;
  for (let s = 1; s <= 60; s++) {
    const g = new GolfGame({ seed: s }), h = g.hole;
    themes.add(h.theme); cliffs += h.cliffs.length; treeIslands += h.islands.length; bunkers += h.bunkers.length; ponds += h.ponds.length;
    if (h.ponds.some(p => p.island)) { islandGreens++; assert.equal(h.surface(h.cup.x, h.cup.z), 'green'); }
    for (const t of h.islands) assert.equal(h.surface(t.x, t.z), 'rough', `seed ${s} tree island`);
  }
  assert.deepEqual([...themes].sort(), ['canyon', 'forest', 'lakes', 'links', 'parkland']);
  assert.ok(cliffs >= 10 && islandGreens >= 2 && treeIslands >= 10, `cliffs ${cliffs} islandGreens ${islandGreens} treeIslands ${treeIslands}`);
  assert.ok(bunkers / 60 >= 5 && ponds / 60 >= 1.1, `bunkers ${bunkers / 60} ponds ${ponds / 60}`);
});
