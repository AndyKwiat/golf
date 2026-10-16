// Headless sim tests: `npm test` (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/sim/game.js';
import { generateGreenParams, flatGreen } from '../src/sim/terrain.js';
import { simulatePutt, powerToSpeed } from '../src/sim/physics.js';
import { solvePutt } from '../src/sim/solver.js';
import { MAX_FLAT_DIST, SWING } from '../src/sim/constants.js';

test('same seed => identical green params', () => {
  assert.deepEqual(generateGreenParams(42), generateGreenParams(42));
  assert.notDeepEqual(generateGreenParams(42), generateGreenParams(43));
});

test('generated greens: cup and start are on the green and a sane distance apart', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = new Game({ seed });
    const t = g.terrain;
    assert.equal(t.surface(t.hole.x, t.hole.z), 'green', `seed ${seed} hole`);
    assert.equal(t.surface(t.start.x, t.start.z), 'green', `seed ${seed} start`);
    assert.ok(g.distToHole() >= 6, `seed ${seed} too short: ${g.distToHole()}`);
  }
});

test('flat green: power maps linearly to roll distance', () => {
  const t = flatGreen({ R0: 40, hole: { x: 100, z: 100 } });
  for (const p of [0.1, 0.25, 0.5, 1]) {
    const r = simulatePutt(t, { x: -15, z: 0 }, 0, p);
    assert.equal(r.result, 'rest');
    assert.ok(Math.abs(r.end.x + 15 - p * MAX_FLAT_DIST) < 0.05 * p * MAX_FLAT_DIST + 0.05, `p=${p} rolled ${r.end.x + 15}`);
    assert.ok(Math.abs(r.end.z) < 1e-9);
  }
  assert.ok(powerToSpeed(1) > powerToSpeed(0.5));
});

test('ball breaks downhill on a side slope', () => {
  const t = flatGreen({ R0: 40, hole: { x: 100, z: 100 }, tilt: [0, 0.03] }); // height rises with +z
  const r = simulatePutt(t, { x: -10, z: 0 }, 0, 0.5);
  assert.ok(r.end.z < -0.3, `expected break toward -z, got ${r.end.z}`);
});

test('cup: firm-but-makeable putt drops, very fast one does not', () => {
  const t = flatGreen({ hole: { x: 5, z: 0 } });
  const soft = simulatePutt(t, { x: 0, z: 0 }, 0, 6 / MAX_FLAT_DIST);  // would roll 6 m: 1 m past
  assert.equal(soft.result, 'holed');
  const fast = simulatePutt(t, { x: 0, z: 0 }, 0, 1);
  assert.notEqual(fast.result, 'holed');
  const short = simulatePutt(t, { x: 0, z: 0 }, 0, 4.5 / MAX_FLAT_DIST);
  assert.equal(short.result, 'rest');
});

test('cheat-mode preview exactly matches the live putt (tick for tick)', () => {
  for (const seed of [3, 11, 27]) {
    const g = new Game({ seed, mode: 'cheat' });
    const aim = g.aim + 0.03, power = 0.42;
    const pv = g.preview(aim, power);
    g.dispatch({ type: 'putt', aim, power });
    const live = [{ x: g.ball.x, z: g.ball.z }];
    do { g.step(); live.push({ x: g.ball.x, z: g.ball.z }); } while (g.phase === 'rolling');
    if (pv.result !== 'holed' && pv.result !== 'oob') {
      assert.deepEqual(live, pv.path, `seed ${seed}`);
    } else {
      assert.equal(g.lastShot.result, pv.result);
    }
  }
});

test('determinism: identical runs give bit-identical state', () => {
  const run = () => {
    const g = new Game({ seed: 99 });
    g.dispatch({ type: 'putt', aim: g.aim - 0.05, power: 0.6 }); g.runUntilSettled();
    g.dispatch({ type: 'putt', power: 0.2 }); g.runUntilSettled();
    return g.snapshot();
  };
  assert.deepEqual(run(), run());
});

test('normal mode: 3-press swing meter, perfect timing goes straight', () => {
  const g = new Game({ seed: 5 });
  const aim0 = g.aim;
  g.dispatch({ type: 'swingPress' }).step();
  assert.equal(g.phase, 'swing');
  g.run(30); // marker rises
  const v = g.swing.value;
  assert.ok(v > 0.3 && v < 0.5, `value ${v}`);
  g.dispatch({ type: 'swingPress' }).step(); // set power
  assert.equal(g.swing.stage, 'accuracy');
  const power = g.swing.power;
  while (g.swing.value > 0.005) g.step();   // wait until the marker is on the impact line
  g.dispatch({ type: 'swingPress' }).step();
  assert.equal(g.phase, 'rolling');
  assert.equal(g.lastShot.aim, aim0);
  assert.ok(Math.abs(g.lastShot.power - power) < 1e-12);
  assert.equal(g.strokes, 1);
});

test('normal mode: missing the accuracy press auto-hits with max push', () => {
  const g = new Game({ seed: 5 });
  g.dispatch({ type: 'swingPress' }).run(20);
  g.dispatch({ type: 'swingPress' }).step();
  let n = 0; while (g.phase === 'swing' && n++ < 600) g.step();
  assert.equal(g.phase, 'rolling');
  const expected = -(Math.abs(SWING.zoneMin) - SWING.perfect) * SWING.errPerUnit;
  assert.ok(Math.abs(g.lastShot.accuracy - SWING.zoneMin) < 1e-9);
  assert.ok(Math.abs(g.lastShot.aim - (g.aim + expected)) < 1e-9);
});

test('replaying the action log reproduces the session exactly', () => {
  const g = new Game({ seed: 12 });
  g.dispatch({ type: 'setAim', aim: g.aim + 0.02 }).run(3);
  g.dispatch({ type: 'swingPress' }).run(40);
  g.dispatch({ type: 'swingPress' }).run(25);
  g.dispatch({ type: 'swingPress' });
  g.runUntilSettled();
  g.dispatch({ type: 'setMode', mode: 'cheat' }).dispatch({ type: 'setPower', power: 0.33 }).run(2);
  g.dispatch({ type: 'putt' }); g.runUntilSettled();
  g.dispatch({ type: 'newGreen', seed: 777 }).run(5);
  const r = Game.replay(g.initial, g.log, g.tick);
  assert.deepEqual(r.snapshot(), g.snapshot());
});

test('out of bounds: ball returns to previous spot with a penalty stroke', () => {
  // A huge green so the world edge (|x| > WORLD_SIZE/2 - 1) is reachable on fast green surface.
  const t = flatGreen({ R0: 60, hole: { x: 0, z: 0 }, start: { x: 40, z: 0 } });
  const g = new Game({ terrainParams: t.params });
  g.dispatch({ type: 'putt', aim: 0, power: 1 });
  g.runUntilSettled();
  assert.equal(g.lastShot.result, 'oob');
  assert.equal(g.strokes, 2);
  assert.deepEqual({ x: g.ball.x, z: g.ball.z }, { x: 40, z: 0 });
  assert.equal(g.phase, 'aim');
});

test('holing out ends the hole and records the card', () => {
  const g = new Game({ seed: 4, mode: 'cheat' });
  let guard = 0;
  while (g.phase !== 'holed' && guard++ < 6) {
    const s = solvePutt(g.terrain, g.ball);
    g.dispatch({ type: 'putt', aim: s.aim, power: s.power }); g.runUntilSettled();
  }
  assert.equal(g.phase, 'holed');
  assert.equal(g.card.length, 1);
  g.dispatch({ type: 'putt', power: 0.5 }).step(); // ignored after holing
  assert.equal(g.phase, 'holed');
});

test('solver can hole out every one of a batch of random greens', () => {
  for (let seed = 100; seed < 106; seed++) {
    const g = new Game({ seed });
    while (g.phase !== 'holed' && g.strokes < 4) {
      const s = solvePutt(g.terrain, g.ball);
      g.dispatch({ type: 'putt', aim: s.aim, power: s.power }); g.runUntilSettled();
    }
    assert.equal(g.phase, 'holed', `seed ${seed} not holed in 4`);
  }
});
