# Golf — notes for agents

Two three.js games sharing one deterministic-sim architecture:

- **Full golf** (`index.html`, `src/golf/`): one random par 3/4/5 hole at a time — fairway, rough,
  bunkers, ponds, trees (balls bounce off them), 14 clubs, auto-putter on the green. **Cheat mode is
  the default** (set power exactly, see the exact flight + roll before you shoot); normal mode is
  the Mario-Golf 3-press meter.
- **Putting only** (`putting.html`, `src/sim/` + `src/main.js`): the original putting-green game.

Both sims are pure JS that runs bit-identically in Node and Chrome, so you can iterate on gameplay
without a browser and take headless screenshots when you need visuals.

## Commands

```bash
npm start                  # http://localhost:5173 (golf) and /putting.html — zero-dep server, no build
npm test                   # headless sim tests: putting + math + golf (~20 s), no browser
npm run test:browser       # headless Chrome: both pages boot clean, node<->browser bit-exact, bot plays a hole
npm run golf -- info  --seed 7
npm run golf -- shot  --seed 7 --club 7i --power 0.9 [--aim-offset 0.02] [--path]
npm run golf -- play  --seed 7          # bot plays the hole out, shot by shot
npm run golf -- bench --from 1 --to 12  # bot over many holes (~4 s/hole)
npm run sim  -- info|putt|solve|bench   # same for the putting game (see scripts/sim.mjs)
npm run shot -- --seed 7 --do "setClub('5i')" --do "shoot()" --out shots/a.png        # golf page
npm run shot -- --page putting.html --seed 7 --mode cheat --do "setPower(0.45)" --out shots/p.png
```

Screenshots: `scripts/shot.mjs` starts its own server on a random port, opens the page **paused**
in headless Chrome (system Chrome via Playwright `channel: 'chrome'`, falling back to bundled
Chromium; SwiftShader WebGL), runs each `--do EXPR` as `window.__golf.EXPR` in order, saves a PNG
and prints final state JSON plus page `errors` (must be `[]`). Flags: `--page --seed --mode
normal|cheat --cam auto|overhead --grid 0|1 --hud 0|1 --width --height --out`. Look at the PNG
with your image tool. `shots/` is gitignored scratch. Hole build takes ~1.2 s in SwiftShader.

## Layout

```
src/sim/              shared + putting-game sim (pure: no three.js/DOM/Math.random/clock)
  math.js             deterministic exp/sin/cos/atan2/len2 — USE THESE in all sim code
  rng.js              mulberry32
  constants.js terrain.js physics.js game.js solver.js   (putting game)
src/golf/sim/         full-hole sim (pure)
  constants.js        physics + surface tables (SURF), lie modifiers (LIE), meter, aero (KD, KL)
  clubs.js            club table; launch speed solved at load so full-power flat carry == target
  hole.js             Hole class (height/grad/surface/trees) + generateHoleParams(seed)
  ball.js             3D ball: airStep (drag+lift), bounces, rolling, trees, cup; stepShot/simulateShot
  game.js             GolfGame state machine, auto club/aim/power, penalties, log/replay
  bot.js              brute-force shot search (tests, autoShot/playHole)
src/golf/render/      view.js (terrain, textures, water, trees, lines, cameras), sky.js (dome,
                      sun, toon clouds, horizon rings)
src/golf/main.js      loop, input, HUD, minimap, window.__golf
src/render/view.js, src/main.js   putting game view/entry
scripts/              serve.mjs, shot.mjs, golf.mjs, sim.mjs
tests/                sim.test (putting), math.test, golf.test, browser.test
```

## Full-hole sim model

- Fixed timestep `DT = 1/60`, `SUBSTEPS = 8` (fast ball vs 0.25 m trunks). Rendering interpolates
  `prevBall → ball` with the accumulator alpha.
- Coordinates: tee at origin, hole runs toward **+z** along centerline `x = cx(z)` (cosine-eased
  between control points → doglegs). `lat(x,z)` = lateral offset from it. Looking from the tee,
  **+x is screen-LEFT** (the minimap is flipped to match). Aim = `atan2(dz, dx)`, ≈ π/2 at the tee;
  increasing aim turns right on screen.
- Surfaces, priority: `oob > tee > green > fringe > water > sand > fairway > rough`. Green,
  bunkers and ponds are "blobs" (circle + harmonics, rotated & stretched, `blobDist` < 0 inside).
  OOB = beyond `corridor()` laterally or past the ends.
- Height = rolling gaussians + elevation ramp + side banks, flattened toward constants near green
  and tee, + green plateau + green bumps (rescaled so green slope ≤ 12%) − bunker bowls; ponds
  replace terrain inside the blob with a bed below the water `level` (level = lowest shore − 0.15).
- Flight: gravity + drag `KD|v|v` + lift `KL·spin·|v|²` ⟂ v (up); spin decays (`SPIN_DECAY`).
  Ground contact: reflect with surface restitution `e`, lose tangential speed `tf + 1.5·spin`;
  below `BOUNCE_TO_ROLL` it rolls (putting-game rolling model with per-surface `roll` friction).
- Trees: pine = cone crown, round = ellipsoid crown, plus trunk cylinder. Entering a crown bounces
  off its surface, keeps 45% speed, deterministic deflection (hash of tree id/hit count), then
  heavy damping inside → ball drops. Trunks reflect (also while rolling). Spatial hash, 10 m cells.
- Power: full clubs launch at `club.speed·√power·lie` (√ makes carry ~ linear in power); putter
  power = fraction of 30 m flat-green roll. Lies (`LIE`) scale speed/spin (rough, sand, …).
- Results: `rest | holed | water | oob`. Water → +1 and drop at the last dry point, walked back
  toward the shot origin until clear of water/sand. OOB → +1, replay from the previous spot.
- Auto caddie on every new lie (`_newLie`): putter on the green; otherwise the shortest club whose
  nominal total reaches (driver only from the tee); aim at the cup if in range, else at the
  centerline one club-length ahead; power by bisection on the real sim so the ball finishes at
  the pin distance along the aim line.

## Game / input model (both games)

All input goes through `game.dispatch(action)`, applied at the start of the next `step()`, logged
as `{tick, action}`; `GolfGame.replay(game.initial, game.log, tick)` (or `Game.replay`) rebuilds
the exact state. Held keys are sampled once per tick in main.js and turned into actions.

Golf actions: `setAim {aim}` · `setPower {power}` · `setClub {club, reaim?}` (re-suggests
aim/power) · `cycleClub {dir}` · `setMode {mode}` · `newHole {seed}` · `shoot {aim?, power?, club?}`
· `swingPress` (normal mode meter, same as putting). Phases: `aim → swing → moving → aim … → holed`.
Cheat preview = `game.preview()` = `simulateShot(launchFor(...))` with the same `stepShot` — exact.

## Browser agent API (`window.__golf`, golf page)

URL: `?seed=N&mode=normal&paused=1&cam=overhead&grid=0&hud=0` (mode defaults to cheat).
`step(n)` · `settle()` · `shoot(aim?, power?, club?)` (club = index or `'7i'`) · `autoShot()` ·
`playHole()` · `setClub(c)` · `setAim(a)` · `aimAtHole()` · `setPower(p)` · `setMode(m)` ·
`newHole(seed?)` · `dispatch(a)` · `preview(...)` · `state()` · `setCamera('auto'|'overhead', zoom)`
· `setGrid(b)` · `setHud(b)` · `advanceVisuals(secs)` (clouds/flag only) · `screenshot()` ·
`render()` · `pause()/resume()` · `buildMs()`. Also `game`, `view`, `CLUBS` objects for poking.
The putting page has the same style API (`putt`, `autoPutt`, `newGreen`, …).

Keys (golf): ←/→ aim (Shift fine), ↑/↓ power (cheat), Q/E or [ ] club, Space shoot / meter,
Enter shoot, N new hole, M mode, C overhead cam, G grid, H hud, P pause; click terrain or
minimap to aim; drag the meter (cheat); click a club in the list; wheel zooms.

## Determinism — lessons learned

- **Never use `Math.exp/sin/cos/atan2/log/hypot/pow` in sim code.** Node 24 and current Chrome
  ship different libm code (last-bit differences → a putt ended 1e-14 m apart). Use
  `src/sim/math.js` (only + − × ÷ sqrt; IEEE-exact everywhere). `Math.sqrt/floor/round/abs/imul`
  are fine. Render code may use `Math.*`.
- No `Math.random`/`Date`/`performance` in sim; random seeds come from the UI via actions.
- Visual-only animation (clouds, flag, slope dots, camera smoothing) is driven by `dtReal`; paused
  `step(n)` advances it by `n·DT`. HUD toasts use wall-clock timeouts → `--hud 0` for pixel-stable.

## Rendering notes / gotchas

- Terrain is one tensor-product grid with **non-uniform spacing**: 0.3 m in the green patch strip,
  1.5 m in play, growing to 320 m outside, outer ring skirted down to a horizon ground disk.
  Three material groups chosen per triangle: outer (tiled, `uv2`), in-play (one baked texture,
  `uv`), green patch (hi-res texture + grid variant, `uv1`; `texture.channel` selects the uv set).
- Baked textures (`paint()`) = surface colors + hillshade from `SUN_DIR` + green height tint +
  contours. Readability constants at the top of view.js (`NORMAL_EXAGGERATION`, `SHADE_*`).
- The horizon ground disk must sit below the lowest terrain (it once poked through a valley and
  looked like a grey "pond"). Raycast debugging (see git history) found it quickly.
- Water needs an env map (PMREM of the sky dome, `Sky.envMap`) or it looks grey at grazing angles.
- Lines are `Line2`/`LineMaterial` (pixel widths); update `resolution` on resize.
- Ball, markers and halo are scaled up with camera distance (ball ×2.5+ in flight) so they're
  trackable. `logarithmicDepthBuffer` is on (near 0.05, far 9000).
- Mountains/hills are vertex-colored rings with 8 rows per column (fewer rows = streaky shading).

## Tips

- Gameplay/physics: iterate with `npm test` + `npm run golf`; screenshot only for visuals.
- A bug repro = seed + action log → a test using `GolfGame.replay`. For controlled physics tests,
  `cleanParams(generateHoleParams(s))` then strip hazards/hills (see `flatHole()` in golf.test).
- Putting-game specifics: power = fraction of 40 m flat roll; greens deliberately steep (≤ 25%);
  `MAX_START_SLOPE` must stay below the rest threshold `mu·7/5 ≈ 7.7%`.
