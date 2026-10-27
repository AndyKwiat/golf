// Web Worker: runs the shot preview (simulateShot) off the main thread, so holding an aim or
// power key doesn't spend ~5 ms of every frame on it. Module worker; relative imports only
// (workers don't see the page's import map). Same sim code, so results are bit-identical.
import { Hole } from './sim/hole.js';
import { simulateShot } from './sim/ball.js';

let hole = null;
self.onmessage = e => {
  const { key, params, launch } = e.data;
  if (params) hole = new Hole(params);
  self.postMessage({ key, r: simulateShot(hole, launch) });
};
