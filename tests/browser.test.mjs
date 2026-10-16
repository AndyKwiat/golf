// Browser smoke test (headless Chrome via Playwright): `npm run test:browser`.
// Checks the page boots without errors, the agent API works, and the browser sim is
// bit-identical to the Node sim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../scripts/serve.mjs';
import { launchBrowser, openGame } from '../scripts/shot.mjs';
import { Game } from '../src/sim/game.js';

test('browser boots, renders, and matches the node sim exactly', async () => {
  const port = 5800 + Math.floor(Math.random() * 100);
  const server = await startServer(port);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openGame(browser, port, { page: 'putting.html', seed: 21, mode: 'cheat', width: 800, height: 500 });

    // Same putt in browser and in node -> identical end state
    const browserState = await page.evaluate(() => {
      const g = window.__golf;
      g.setPower(0.37);
      g.setAim(g.state().aim + 0.02);
      return g.putt();
    });
    const node = new Game({ seed: 21, mode: 'cheat' });
    node.dispatch({ type: 'setPower', power: 0.37 }).step();
    node.dispatch({ type: 'setAim', aim: node.aim + 0.02 }).step();
    node.dispatch({ type: 'putt' }); node.runUntilSettled();
    assert.deepEqual(browserState.ball, node.snapshot().ball);
    assert.equal(browserState.tick, node.tick);

    // Screenshot is non-trivial (not a blank canvas)
    const stats = await page.evaluate(() => {
      const url = window.__golf.screenshot();
      return new Promise(res => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = 64; c.height = 64;
          const x = c.getContext('2d'); x.drawImage(img, 0, 0, 64, 64);
          const d = x.getImageData(0, 0, 64, 64).data; const set = new Set();
          for (let i = 0; i < d.length; i += 4) set.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4));
          res({ colors: set.size });
        };
        img.src = url;
      });
    });
    assert.ok(stats.colors > 20, `canvas looks blank (${stats.colors} colors)`);

    // Normal-mode swing through the real UI key path
    await page.evaluate(() => { window.__golf.setMode('normal'); window.__golf.resume(); });
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__golf.state().phase !== 'swing', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__golf.state().strokes), 2);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('golf page boots, matches the node sim exactly, and plays a hole', async () => {
  const { GolfGame } = await import('../src/golf/sim/game.js');
  const port = 5900 + Math.floor(Math.random() * 90);
  const server = await startServer(port);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openGame(browser, port, { seed: 11, width: 900, height: 560 });
    const st0 = await page.evaluate(() => window.__golf.state());
    assert.equal(st0.mode, 'cheat', 'cheat mode is the default');

    const browserState = await page.evaluate(() => { const g = window.__golf; g.setClub('3W'); g.setAim(g.state().aim - 0.02); return g.shoot(); });
    const node = new GolfGame({ seed: 11 });
    node.dispatch({ type: 'setClub', club: 1 }).step();
    node.dispatch({ type: 'setAim', aim: node.aim - 0.02 }).step();
    node.dispatch({ type: 'shoot' }); node.runUntilSettled();
    assert.deepEqual(browserState.ball, node.snapshot().ball);

    // normal-mode swing through real key presses
    await page.evaluate(() => { window.__golf.setMode('normal'); window.__golf.resume(); });
    for (const wait of [600, 350, 0]) { await page.keyboard.press('Space'); if (wait) await page.waitForTimeout(wait); }
    await page.waitForFunction(() => window.__golf.state().phase === 'moving' || window.__golf.state().strokes >= 2, null, { timeout: 5000 });
    await page.evaluate(() => window.__golf.pause());
    const fin = await page.evaluate(() => { window.__golf.setMode('cheat'); return window.__golf.playHole(); });
    assert.equal(fin.phase, 'holed');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
