// The deterministic math replacements must stay accurate vs. the engine's libm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exp, sin, cos, atan2, len2 } from '../src/sim/math.js';
import { mulberry32 } from '../src/sim/rng.js';

const rand = mulberry32(7);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test('exp', () => { for (let i = 0; i < 20000; i++) { const x = (rand() - 0.7) * 100; close(exp(x), Math.exp(x), 4e-16 * 4, `exp(${x})`); } assert.equal(exp(-800), 0); });
test('sin/cos', () => { for (let i = 0; i < 20000; i++) { const x = (rand() - 0.5) * 200; close(sin(x), Math.sin(x), 1e-15, `sin(${x})`); close(cos(x), Math.cos(x), 1e-15, `cos(${x})`); } });
test('atan2', () => {
  for (let i = 0; i < 20000; i++) { const y = (rand() - 0.5) * 50, x = (rand() - 0.5) * 50; close(atan2(y, x), Math.atan2(y, x), 1e-15, `atan2(${y},${x})`); }
  assert.equal(atan2(0, 0), 0); close(atan2(1, 0), Math.PI / 2, 1e-16, 'pi/2'); close(atan2(0, -1), Math.PI, 1e-16, 'pi');
});
test('len2', () => { assert.equal(len2(3, 4), 5); });
