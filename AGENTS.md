# Golf — notes for agents

Two three.js games sharing one deterministic-sim architecture:

- **Full golf** (`index.html`, `src/golf/`): one random par 3/4/5 hole at a time — doglegs,
  fairway, rough, bunkers, ponds (95% of holes, often two), rivers (~50%), 5 tree species (balls
  bounce off them) inside a deep surrounding forest, birds, strong per-hole wind, draw/fade shot
  shaping, 14 clubs, auto-putter on the green. **Cheat mode is
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
npm run test:all           # both, sequentially (running them in parallel starves SwiftShader -> timeouts)
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
normal|cheat --cam auto|overhead --grid 0|1 --hud 0|1 --width --height --out`, and
`--eval CODE` (arbitrary JS with `g = window.__golf`, interleaved in order with `--do`), e.g.
`--eval "g.view.sun.castShadow = false; g.render()"` — great for isolating rendering artifacts by
hiding things one at a time. The tool awaits `__golf.whenReady()` after load and after every
step, so worker-painted textures are always final in the PNG. `shots/` is gitignored scratch.
`--lite 1` (URL `?lite=1`) skips the deep forest, understory and shadows — use it for
gameplay-only shots/tests; the full scene is slow in SwiftShader. Close-ups: `--do "lookAtHazard(0)"` (bunker 0), `--do "lookAtHazard(0, 'pond', 6)"`,
`--do "placeBall(x, z, lookX, lookZ)"`.

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
src/golf/render/      view.js (terrain + patches, water, lines, cameras), sky.js (dome, sun,
                      toon clouds, horizon rings), trees.js (procedural tree meshes),
                      paint.js (DOM-free texture painter) + paint.worker.js (runs it in workers)
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
- Surfaces, priority: `oob > tee > green > fringe > water (ponds, rivers) > sand > fairway > rough`.
- Rivers (`params.rivers = [{kind: 'cross'|'along', pts: [[x,z]...], w, levels}]`): a polyline
  centerline + width; `hole.riverAt(x,z)` → `{d, half, level}` (nearest segment, culled with
  per-segment bounding squares — keep the culling margin ≥ any distance threshold you query).
  Height carves a channel with ~5 m banks; water level per point = just below the lower bank,
  smoothed along the river (rivers don't need to flow downhill — the water ribbon just follows
  `levels`). They avoid tee and green; bunkers/ponds overlapping a river are dropped.
- Trees: `makeTree(type, scale, x, z, y0)` / `TREE_TYPES` / `pickTreeType` in hole.js define the
  five species and their collision volumes: pine & redwood = `shape: 'cone'` (redwood: 30 m tall,
  clean trunk to ~8 m), round / poplar (columnar, ~20 m) / birch = `shape: 'ellipsoid'`. ball.js
  collides by `shape`. The view uses the same `makeTree` for its decorative forest.
- `params.outer`: big gaussian hills out in the forest, faded to zero inside the corridor (so they
  never change play areas). Green,
  bunkers and ponds are "blobs" (circle + harmonics, rotated & stretched, `blobDist` < 0 inside).
  OOB = beyond `corridor()` laterally or past the ends.
- Height = rolling gaussians + elevation ramp + side banks, flattened toward constants near green
  and tee, + green plateau + green bumps (rescaled so green slope ≤ 12%) − bunker bowls; ponds
  replace terrain inside the blob with a bed below the water `level` (level = lowest shore − 0.15).
- Flight: gravity + drag `KD|v|v` + lift `KL·spin·|v|²` ⟂ v (up) + sidespin force
  `KL·side·|v|²` horizontal ⟂ v (+side = right/fade, − = left/draw); all computed on the
  **air-relative** velocity `v − wind`, so wind pushes, holds up and helps the ball. Spin and
  sidespin decay (`SPIN_DECAY`); sidespin is zeroed at the first bounce. Wind never affects
  rolling (putts are wind-free). `hole.wind = {x, z}` m/s, 3–13 m/s, from the seed.
  Shaping is deliberately exaggerated (`CURVE_SIDESPIN = 0.16`): full draw/fade bends a drive
  ~123 yd, a 7i ~52 yd, a SW ~18 yd; each 25% step ≈ 32 yd on a drive (Shift+Z/X = 5% steps).
  Ground contact: reflect with surface restitution `e`, lose tangential speed `tf + 1.5·spin`;
  below `BOUNCE_TO_ROLL` it rolls (putting-game rolling model with per-surface `roll` friction).
- Trees: pine = cone crown, round = ellipsoid crown, plus trunk cylinder. Entering a crown bounces
  off its surface, keeps 45% speed, deterministic deflection (hash of tree id/hit count), then
  heavy damping inside → ball drops. Trunks reflect (also while rolling). Spatial hash, 10 m cells.
- Units: the sim is **meters and m/s everywhere**; only the HUD converts (yards, feet on the
  green, mph for wind — helpers `yd()`, `ft()`, `MPH` in main.js). Distances are video-game long:
  driver carries ~333 yd and totals ~350 yd, but hole lengths are realistic (par 3 ≈ 150–250
  yd, par 4 ≈ 365–500 yd, par 5 ≈ 515–630 yd incl. doglegs); dogleg offsets / fairway-bunker
  positions are scaled up (`SCALE = 1.3` in hole.js) to suit the long drives.
- Hold **Shift while the ball is moving** = 2.5× fast-forward (main.js runs more fixed ticks per
  frame; the sim is unchanged).
- Surface feel (tuned on purpose, see `SURF` in constants.js): a 5 m/s roll goes ~23 m on green,
  ~5 m on fairway, ~2 m in rough. Landing: driver runs ~13 m on fairway, ~3 m in rough; greens
  "grip" backspin (`grip`) so a 7i holds within ~11 m and wedges within ~3 m. Rough lie = 85%
  launch speed and half spin (7i carries ~102 m instead of 148). `club.total` (shown nowhere,
  used by the caddie) is measured at load on a flat calm fairway with the real sim.
  Gotcha: tests that roll a ball from the tee must start on fairway (`flatHole` sets
  `fairway.z0 = -60`), otherwise the rough strip in front of the tee stops it.
- Power: full clubs launch at `club.speed·√power·lie` (√ makes carry ~ linear in power); putter
  power = fraction of 30 m flat-green roll. Lies (`LIE`) scale speed/spin (rough, sand, …).
- Results: `rest | holed | water | oob`. Water → +1 and drop at the last dry point, walked back
  toward the shot origin until clear of water/sand. OOB → +1, replay from the previous spot.
- Auto caddie (`_caddie`, on every new lie, club change and curve change): putter on the green;
  otherwise the shortest club whose nominal total reaches (driver only from the tee). Target =
  cup if in range, else the centerline one club-length ahead. Power by bisection on the real sim;
  then the aim is corrected (3 sim iterations) for wind + curve drift so the default shot really
  finishes on the target line — that's what keeps cheat mode easy in strong wind. On fairway
  targets it keeps full power if a full shot still finishes in the fairway.
- Generator layout: par 4s dogleg 80% of the time (35–85 m offset), par 5s always double-bend
  (often S). `params.corners = [{z, dir}]` records bends; tree clusters guard the inside corners.
  Pond candidates by type — dogleg corner, front of green, beside green, crossing the fairway,
  beside the landing zone — kept if they clear the green outline (+fringe +2.5 m), the tee and
  each other; max 2 per hole.

## Game / input model (both games)

All input goes through `game.dispatch(action)`, applied at the start of the next `step()`, logged
as `{tick, action}`; `GolfGame.replay(game.initial, game.log, tick)` (or `Game.replay`) rebuilds
the exact state. Held keys are sampled once per tick in main.js and turned into actions.

Golf actions: `setAim {aim}` · `setPower {power}` · `setClub {club, reaim?}` (re-suggests
aim/power) · `cycleClub {dir}` · `setCurve {curve ∈ [-1,1], reaim?}` (resets to 0 on each new
lie) · `setMode {mode}` · `newHole {seed}` · `shoot {aim?, power?, club?, curve?}`
· `swingPress` (normal mode meter, same as putting). Phases: `aim → swing → moving → aim … → holed`.
Cheat preview = `game.preview()` = `simulateShot(launchFor(...))` with the same `stepShot` — exact.

## Browser agent API (`window.__golf`, golf page)

URL: `?seed=N&mode=normal&paused=1&cam=overhead&grid=0&hud=0` (mode defaults to cheat).
`step(n)` · `settle()` · `shoot(aim?, power?, club?, curve?)` (club = index or `'7i'`) ·
`setCurve(c, reaim = true)` · `autoShot()` ·
`playHole()` · `setClub(c)` · `setAim(a)` · `aimAtHole()` · `setPower(p)` · `setMode(m)` ·
`newHole(seed?)` · `dispatch(a)` · `preview(...)` · `state()` · `setCamera('auto'|'overhead', zoom)`
· `setGrid(b)` · `setHud(b)` · `advanceVisuals(secs)` (clouds/flag only) · `screenshot()` ·
`render()` · `pause()/resume()` · `buildMs()` · `whenReady()` · `placeBall(x, z, lookX?, lookZ?)`
· `lookAtHazard(i, 'bunker'|'pond', dist)`. Also `game`, `view`, `CLUBS` objects for poking.
The putting page has the same style API (`putt`, `autoPutt`, `newGreen`, …).

Keys (golf): ←/→ aim (Shift fine), ↑/↓ power (cheat), Q/E or [ ] club, Z/X draw/fade (±25%,
re-aims), Space shoot / meter,
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

- Terrain = a base grid (uniform 1.5 m in play, growing spacing to 320 m outside, outer ring
  skirted down to a horizon ground disk; groups: outer tiled `uv2` / in-play baked `uv`) plus
  **hi-res patches** (0.25 m geometry, ~4 cm/px texture; ponds 8 cm) around the green, every
  bunker and every pond. Patches are snapped to base grid lines, merged when overlapping, the base
  cells inside are skipped, and patch border vertices are linearly interpolated from the base
  vertices so the seam is watertight (no T-junction cracks). This is what keeps bunker bowls and
  edges crisp — the old single 0.25 m/px texture looked pixelated.
- Textures are painted by `paint.js` in a pool of module Web Workers (`PaintPool`; falls back to
  the main thread). Materials show a flat grass placeholder until each texture arrives;
  `view.ready` / `__golf.whenReady()` resolves when all are in. Workers can't see the import map:
  everything they import must be relative and three.js-free. Stale results (new hole started)
  are dropped via `buildGen`.
- Baked textures = surface colors + hillshade + green height tint + contours + bunker grass lip
  and sand rim + anti-aliased fairway edge. Readability constants: `NORMAL_EXAGGERATION`
  (view.js), `SHADE_*`, `CONTOUR_STEP` (paint.js).
- Lighting: `LIGHT_DIR` (≈35° up) drives the sun light + baked hillshade; `SUN_DIR` (≈14° up)
  only places the visible sun disk so it's in frame from the tee. With light at 14° the tree
  shadows were huge streaks. NeutralToneMapping, exposure 1.15, shadow intensity 0.6, bright
  hemisphere — the user asked for a cheerful look; keep it bright.
- Forest (`planForest` → `buildTrees`): tier 0 = the sim's `hole.trees` (~550, collide), tier 1 =
  decorative trees within 45 m outside the corridor, tier 2 = deep forest out to ~280 m beyond
  the play rect (~17k, ultra-cheap 14-20 tri crowns). Tiers 0/1 use **dynamic LOD with a dithered
  cross-fade**: `refreshTreeLOD(cameraPos)` (when the camera moved > 8 m) fills a high- and a
  medium-detail mesh per (species, variant) bucket; both hold the instances inside the fade band
  (`lodUniform` = radius 110 m ± 20 m, plus a 12 m margin > the refresh step) and `lodMaterial`
  discards complementary screen-space dither patterns by per-instance camera distance, so there
  is no pop and never a gap. **Always `computeBoundingSphere()` after changing an InstancedMesh's
  instances** — three caches it, and stale bounds culled whole tree meshes (trees blinking in/out
  far from the tee).
- **Shadows**: trees cast no realtime shadows. Sun and trees are static, so `bakeTreeShadows`
  (paint.js) rasterizes every tree's ground shadow (ellipsoid/cone/trunk projections along
  `LIGHT_DIR`) into a 1 m grid that the paint workers multiply into the ground textures and the
  outer terrain gets as vertex colors — shadows everywhere, zero pop-in. The realtime shadow map
  only covers ±12 m around the ball (the ball is its only caster); the ball is darkened when it
  rests in a baked shadow (`sampleGrid`).
  Understory bushes/rocks behind the first tree rows. A canopy coverage grid (`canopyGrid`) is
  sent to the paint workers to darken the forest floor under trees; `forestFloor()` in paint.js
  paints moss / needles / leaf litter / dirt / grass patches beyond the rough and out of bounds.
  Beyond the planted forest the horizon ground uses a tiling canopy texture + tree-line rings.
  Budget: ~3-4M tris/frame incl. shadows; headless SwiftShader takes seconds per first frame
  (real GPUs are fine) — measure with `renderer.info` before adding more.
- Water: rivers are Catmull-Rom ribbons at the river's levels; rivers and ponds share a
  procedural ripple normal map whose offset scrolls (`this.flowing`, rivers flow ~0.3 m/s).
  Reeds/cattails (`reedClump`, `reedMaterial` with a wind-sway vertex shader) line shores where
  the surface is rough/oob/water.
- Birds (`birds.js`, render-only, seeded): ~2.5x oversized on purpose (real-size birds were
  invisible). 7-9 flocks spread along the hole 22-75 m up, plus one "follow" flock that drifts
  ~85 m ahead of the camera; ~100 songbirds on the fairway-edge trees that, when behind/far from
  the camera, hop to trees in front of it. Wing flapping is done in the vertex shader.
- Putting grid is **off by default** (G toggles; `?grid=1`).
- Trees (trees.js): unit-space geometry scaled per instance to the exact collision volumes.
  Pines = 7 whorls × 2 offset star-shaped drooping cones + needle texture; deciduous = cluster of
  noise-displaced spheres with vertex AO + leaf-speckle texture. 3 variants each, picked by hash.
  Redwood / poplar / birch crowns: `redwoodCrown`, `blobCrown` options; trunks are neutral grey
  and tinted per instance (birch white, redwood red-brown).
- The horizon ground disk must sit below the lowest terrain (it once poked through a valley and
  looked like a grey "pond"). Raycast debugging (see git history) found it quickly.
- Water needs an env map (PMREM of the sky dome, `Sky.envMap`) or it looks grey at grazing angles.
- Lines are `Line2`/`LineMaterial` (pixel widths); update `resolution` on resize.
- Headless SwiftShader is slow at ~2M tris: the realtime loop runs at a few fps there, so browser
  tests must wait on sim state (e.g. meter value) rather than wall-clock delays.
- Ball, markers and halo are scaled up with camera distance (ball ×2.5+ in flight) so they're
  trackable. `logarithmicDepthBuffer` is on (near 0.05, far 9000).
- Wind HUD arrow is drawn relative to the camera (up = blowing away from you); in overhead mode
  screen-up is `camera.up`. The flag streams downwind and clouds drift along `hole.wind`.
- Mountains/hills are vertex-colored rings with 8 rows per column (fewer rows = streaky shading).

## Tips

- Gameplay/physics: iterate with `npm test` + `npm run golf`; screenshot only for visuals.
- A bug repro = seed + action log → a test using `GolfGame.replay`. For controlled physics tests,
  `cleanParams(generateHoleParams(s))` then strip hazards/hills (see `flatHole()` in golf.test).
- Putting-game specifics: power = fraction of 40 m flat roll; greens deliberately steep (≤ 25%);
  `MAX_START_SLOPE` must stay below the rest threshold `mu·7/5 ≈ 7.7%`.
