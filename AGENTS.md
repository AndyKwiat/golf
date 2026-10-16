# Putting Green — notes for agents

A three.js golf **putting** game (Mario-Golf-style meter, plus a "cheat" mode with exact path preview).
The simulation is pure, deterministic JS that runs identically in Node and the browser, so you
can iterate on gameplay without ever opening a browser, and take screenshots headlessly when you do
need visuals.

## Commands

```bash
npm start                 # http://localhost:5173  (zero-dep static server, no build step)
npm test                  # headless sim + math tests (~5 s), no browser
npm run test:browser      # headless Chrome smoke test: boots page, checks node<->browser bit-exactness
npm run sim -- info  --seed 7
npm run sim -- putt  --seed 7 --power 0.5 --aim-offset 0.02 --path
npm run sim -- solve --seed 7          # solver bot plays the hole out
npm run sim -- bench --from 1 --to 50  # playability check across many greens
npm run shot -- --seed 7 --mode cheat --do "setPower(0.45)" --out shots/a.png
```

Screenshots: `scripts/shot.mjs` starts its own server on a random port, opens the page **paused**
in headless Chrome (system Chrome via Playwright `channel: 'chrome'`, falling back to bundled
Chromium; SwiftShader WebGL), runs each `--do EXPR` as `window.__golf.EXPR` in order, saves a PNG
and prints the final state JSON (plus any page errors — check `errors` is `[]`). Flags:
`--seed --mode normal|cheat --cam auto|overhead --grid 0|1 --hud 0|1 --width --height --out`.
`--frames DIR --putt-frames K` putts with the current settings and saves a frame every K ticks.
Read the PNG with your image-viewing tool to check visuals. `shots/` is scratch output.

## Layout

```
src/sim/          PURE simulation: no three.js, no DOM, no Math.random, no wall clock
  constants.js    every tunable (friction, cup size, meter speeds, power scale, world size)
  math.js         deterministic exp/sin/cos/atan2/len2 (see "Determinism")
  rng.js          mulberry32 seeded PRNG
  terrain.js      Terrain class + generateGreenParams(seed) + flatGreen() for tests
  physics.js      stepBall() one fixed tick; simulatePutt() full putt; powerToSpeed()
  game.js         Game state machine, action queue, log, replay, snapshot
  solver.js       brute-force best putt (coarse-to-fine aim x power search)
src/render/view.js  three.js scene; reads Game, never mutates it
src/main.js       fixed-timestep loop, input -> actions, HUD, window.__golf agent API
scripts/          serve.mjs, shot.mjs (screenshots), sim.mjs (headless CLI)
tests/            node:test suites
```

## Simulation model

- Fixed timestep `DT = 1/60` s, `SUBSTEPS = 4` semi-implicit Euler substeps per tick.
  Rendering is decoupled: `main.js` accumulates wall time and calls `game.step()` per 1/60 s,
  then renders with `alpha` interpolation between `game.prevBall` and `game.ball`.
- Ball is a point `{x, z, vx, vz}` moving in the horizontal plane; height = `terrain.height(x,z)`.
  Slope accel = `-(5/7) g ∇h / sqrt(1+|∇h|²)` (rolling sphere); rolling resistance `mu·g`
  opposite velocity, `mu` by surface (`green 0.055` ≈ stimp 10, `fringe`, `rough`). Ball rests
  when slow AND slope accel ≤ `mu·g`.
- Power ∈ [0,1] is defined as **fraction of `MAX_FLAT_DIST` (40 m) the ball would roll on a flat
  green**; `powerToSpeed` inverts that. So meter tick labels are honest flat distances.
- Cup: capture when center within `CUP_R` and speed ≤ `1.63·sqrt(1-(d/R)²)`; otherwise a one-time
  lip-out deflection (+15% speed loss).
- Surfaces by radial distance outside the green outline: green → fringe (1.2 m) → rough (8 m) →
  OOB. OOB (or leaving the world square) = ball back to previous spot, +1 penalty stroke.
- Terrain: sum of 7–12 gaussian hills + tilt + a raised collar outside the green. Hills are big
  on purpose (2–4 m relief, ~10% mean slope) and rescaled so the green's max slope ≤ 25%
  (`MAX_GREEN_SLOPE` in terrain.js). Cup goes on a ≤4% spot (flattest sample as fallback); start
  slope ≤7%, which must stay under the rest threshold `mu·7/5 ≈ 7.7%` or the ball won't sit still.
  Balls can't stop on steeper ground, so they run off into hollows — intended.
  Gradient is central-difference (`grad()`), so you can change `height()` freely.

## Game / input model (important for determinism)

All input goes through `game.dispatch(action)`; actions are applied at the start of the next
`step()` and logged as `{tick, action}` in `game.log`. `Game.replay(game.initial, game.log, tick)`
rebuilds the exact state. Held keys (aim/power) are sampled once per tick in `main.js` and turned
into `setAim`/`setPower` actions, so even live keyboard play is replayable.

Actions: `setAim {aim}` · `setPower {power}` (cheat power) · `setMode {mode}` · `newGreen {seed}` ·
`putt {aim?, power?}` (direct, no meter; what cheat mode and agents use) · `swingPress`
(normal-mode meter: press 1 starts the marker, press 2 locks power, press 3 sets accuracy; marker
running past `SWING.zoneMin` auto-hits with max push; falling back to 0 before press 2 cancels).
Phases: `aim → swing → rolling → aim … → holed`. Aim is radians in the x/z plane
(`atan2(dz, dx)`); increasing aim turns the shot to the right on screen.

Cheat preview = `game.preview(aim, power)` = `simulatePutt` with the same `stepBall`, so the
drawn path is exactly the live path (tested tick-for-tick).

## Browser agent API (`window.__golf`)

Load with `?seed=N&mode=cheat&paused=1&cam=overhead&grid=0&hud=0`. When paused, nothing advances
unless you call:
`step(n)` · `settle()` · `putt(aim?, power?)` (returns settled snapshot) · `autoPutt()` · `solve()` ·
`setAim(a)` · `aimAtHole()` · `setPower(p)` · `setMode(m)` · `newGreen(seed?)` · `dispatch(action)` ·
`preview(aim?, power?)` · `state()` · `setCamera('auto'|'overhead', zoom)` · `setGrid(bool)` ·
`setHud(bool)` · `screenshot()` (canvas PNG data URL) · `render()` · `pause()/resume()`.
Calls that step also render a "snapped" (unsmoothed) camera frame so screenshots are reproducible.
`window.__golfReady === true` once booted. Keys in the real game: ←/→ aim (Shift fine), Space
meter/putt, ↑/↓ cheat power, Enter putt, N new green, M mode, C camera, G grid, H hud, P pause;
click/drag the green to aim; drag the meter in cheat mode; wheel zooms.

## Determinism — lessons learned

- **Never use `Math.exp/sin/cos/atan2/log/hypot/pow` in `src/sim/`.** Node 24 and current Chrome
  ship different libm code; results differed in the last bits and a putt ended 1e-14 m apart.
  Use `src/sim/math.js` (pure + − × ÷ sqrt; IEEE-exact everywhere). `tests/math.test.mjs` checks
  accuracy; `test:browser` checks Node vs Chrome bit-equality of a full putt. Render code may use
  `Math.*` freely.
- No `Math.random`/`Date`/`performance` in sim. Random seeds for new greens are chosen by the UI
  and passed in the `newGreen` action.
- Visual-only animation (flag wave, slope dots, camera smoothing, hole sink) lives in `view.js` and
  is driven by `dtReal`; in paused/agent mode `step(n)` advances it by `n·DT`, so shots are stable.
  HUD toasts use wall-clock timeouts — use `--hud 0` if a screenshot must be pixel-stable.

## Tips

- Iterate physics/terrain with `npm test` + `npm run sim`; only screenshot for visual changes.
- `npm run sim -- bench` after terrain changes: every green should be holeable (solver avg ≈ 1–1.3).
- A specific bug repro = seed + action log; put it in a test with `Game.replay`.
- The 2048² surface texture and 400² terrain mesh are rebuilt per green in `View.buildGreen()`
  (~0.3 s); the grid/dots are a texture swap + an InstancedMesh.
- Hill readability (deliberately unrealistic) is tuned by constants at the top of `view.js`:
  `NORMAL_EXAGGERATION` (mesh normals as if hills were steeper), `SHADE_EXAGGERATION` (baked
  hillshade in the texture, fixed light direction so it's view-independent), `CONTOUR_STEP`
  (contour lines). The texture also tints by height (low = bluer/darker, high = yellower) and
  darkens hollows via the laplacian. Lights: low warm sun + cool opposite fill + dim hemisphere.
  Check changes with `npm run shot -- --seed 11 --grid 0`.
- `view.js` maps world x/z directly to mesh x/z (no rotated PlaneGeometry); textures use
  `flipY = false` so canvas row j ↔ world z.
