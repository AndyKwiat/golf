// Web Worker: paints terrain textures off the main thread. Module worker; relative imports only
// (workers don't see the page's import map).
import { Hole } from '../sim/hole.js';
import { paintPixels } from './paint.js';

let cache = { key: null, hole: null };
self.onmessage = e => {
  const { id, key, params, job } = e.data;
  if (cache.key !== key) cache = { key, hole: new Hole(params) };
  const o = paintPixels(cache.hole, job.r, job.px, job.shadeAmt, job.withGrid, job.hstep, job.light, job.canopy, job.shadow);
  self.postMessage({ id, W: o.W, H: o.H, a: o.a, b: o.b }, o.b ? [o.a.buffer, o.b.buffer] : [o.a.buffer]);
};
