// Headless screenshot tool. Starts the static server, opens the game paused in headless Chrome,
// runs __golf API calls, and saves a PNG. Prints the final game state as JSON.
//
//   node scripts/shot.mjs --seed 7 --mode cheat --do "setPower(0.4)" --out shots/a.png
//   node scripts/shot.mjs --seed 7 --do "putt(undefined, 0.5)" --cam overhead --out shots/b.png
//   node scripts/shot.mjs --seed 7 --do "dispatch({type:'swingPress'})" --do "step(40)" --out shots/swing.png
//
// Flags: --seed N  --mode normal|cheat  --cam auto|overhead  --grid 0|1  --hud 0|1
//        --do EXPR (repeatable; evaluated as `__golf.EXPR` in order)  --out FILE
//        --width W --height H  --frames DIR (with --putt-frames K: saves a frame every K ticks while rolling)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './serve.mjs';

function parseArgs(argv) {
  const a = { do: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2), val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    if (key === 'do') a.do.push(val); else a[key] = val;
  }
  return a;
}

export async function launchBrowser() {
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  try { return await chromium.launch({ channel: 'chrome', headless: true, args }); }
  catch { return await chromium.launch({ headless: true, args }); }
}

export async function openGame(browser, port, { seed = 1, mode = 'normal', cam = 'auto', grid = '1', hud = '1', width = 1280, height = 800 } = {}) {
  const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?seed=${seed}&mode=${mode}&cam=${cam}&grid=${grid}&hud=${hud}&paused=1`);
  await page.waitForFunction(() => window.__golfReady === true, null, { timeout: 30000 });
  await page.evaluate(() => window.__golf.render());
  return { page, errors };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const port = Number(a.port || 5199 + Math.floor(Math.random() * 500));
  const server = await startServer(port);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openGame(browser, port, a);
    for (const expr of a.do) await page.evaluate(e => { (0, eval)('window.__golf.' + e); }, expr);
    if (a.frames) {
      // capture an animation: putt with current settings and save a frame every K ticks
      const k = Number(a['putt-frames'] || 10);
      fs.mkdirSync(a.frames, { recursive: true });
      await page.evaluate(() => window.__golf.dispatch({ type: 'putt' }));
      for (let f = 0; f < 200; f++) {
        const st = await page.evaluate(n => window.__golf.step(n), k);
        await page.screenshot({ path: path.join(a.frames, `f${String(f).padStart(3, '0')}.png`) });
        if (st.phase !== 'rolling') break;
      }
    }
    await page.evaluate(() => window.__golf.render());
    const out = a.out || 'shots/shot.png';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    const state = await page.evaluate(() => window.__golf.state());
    console.log(JSON.stringify({ out, errors, state }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
