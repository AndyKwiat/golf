// Terrain texture painter (pure: no DOM / three.js) so it can run in Web Workers.
// Bakes surface colors + exaggerated hillshade + green height tint + contours + bunker lips.
import { blobDist } from '../sim/hole.js';

export const SHADE_MAIN = 3.0, SHADE_GREEN = 4.5;
export const CONTOUR_STEP = 0.15;

/** Sample heights on a regular grid (for baked shading). */
function heightGrid(h, x0, z0, x1, z1, step) {
  const nx = Math.ceil((x1 - x0) / step) + 1, nz = Math.ceil((z1 - z0) / step) + 1;
  const H = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = h.height(x0 + i * step, z0 + j * step);
  return { H, nx, nz, x0, z0, step };
}

/**
 * Paint one terrain texture over rect r (world meters) with pixel size px.
 * Returns { W, H, a, b }: RGBA pixel arrays (b = same plus the 1 m putting grid, if withGrid).
 * light = {x,y,z} unit light direction for the baked hillshade.
 */
export function paintPixels(h, r, px, shadeAmt, withGrid, hstep, light) {
  const W = Math.round((r.xmax - r.xmin) / px), Ht = Math.round((r.zmax - r.zmin) / px);
  const hg = heightGrid(h, r.xmin - 1, r.zmin - 1, r.xmax + 1, r.zmax + 1, Math.max(px, hstep));
  const { H, nx, step } = hg;
  const a = new Uint8ClampedArray(W * Ht * 4), b = withGrid ? new Uint8ClampedArray(W * Ht * 4) : null;
  const lx = light.x, ly = light.y, lz = light.z;
  const g = h.green;
  let hmin = Infinity, hmax = -Infinity;
  for (let k = 0; k < 400; k++) { const th = k * 0.7, rr = (k / 400) * g.R0; const y = h.height(g.x + Math.cos(th) * rr, g.z + Math.sin(th) * rr); hmin = Math.min(hmin, y); hmax = Math.max(hmax, y); }
  const hspan = Math.max(0.2, hmax - hmin);
  for (let j = 0; j < Ht; j++) {
    const z = r.zmin + (j + 0.5) * px;
    for (let i = 0; i < W; i++) {
      const x = r.xmin + (i + 0.5) * px;
      const fu = (x - hg.x0) / step, fv = (z - hg.z0) / step;
      const iu = Math.min(nx - 2, Math.floor(fu)), iv = Math.min(hg.nz - 2, Math.floor(fv)), tu = fu - iu, tv = fv - iv, k0 = iv * nx + iu;
      const h00 = H[k0], h10 = H[k0 + 1], h01 = H[k0 + nx], h11 = H[k0 + nx + 1];
      const y = h00 * (1 - tu) * (1 - tv) + h10 * tu * (1 - tv) + h01 * (1 - tu) * tv + h11 * tu * tv;
      const gx = ((h10 - h00) * (1 - tv) + (h11 - h01) * tv) / step, gz = ((h01 - h00) * (1 - tu) + (h11 - h10) * tu) / step;
      let surf = h.surface(x, z);
      const n = hashf(i, j) * 0.06 - 0.03;
      // distance to the nearest bunker edge (for the grass lip / sand rim)
      let bd = Infinity;
      for (const bk of h.bunkers) {
        if (Math.abs(x - bk.x) > bk._bound + 1 || Math.abs(z - bk.z) > bk._bound + 1) continue;
        bd = Math.min(bd, blobDist(bk, x, z));
      }
      const mott = valueNoise(x * 0.9, z * 0.9) * 0.08 + valueNoise(x * 4, z * 4) * 0.04 - 0.06;
      let cr, cg, cb, amt = shadeAmt;
      switch (surf) {
        case 'green': {
          const stripe = (Math.floor((x * 0.8 + z * 0.6) / 1.6) & 1) ? 0.035 : -0.035, k = 1 + stripe + n * 0.5 + mott * 0.6;
          const hn = Math.min(1, Math.max(0, (y - hmin) / hspan));
          cr = (0.21 + 0.25 * hn) * k; cg = (0.63 + 0.19 * hn) * k; cb = (0.36 - 0.14 * hn) * k; amt = shadeAmt * 1.25; break;
        }
        case 'fringe': { const k = 1 + n + mott; cr = 0.29 * k; cg = 0.64 * k; cb = 0.23 * k; break; }
        case 'fairway': case 'tee': {
          const stripe = (Math.floor(z / (surf === 'tee' ? 1.5 : 8)) & 1) ? 0.05 : -0.05, k = 1 + stripe + n * 0.6 + mott * 0.7;
          cr = 0.35 * k; cg = 0.69 * k; cb = 0.25 * k;
          // anti-aliased fairway edge: fade toward rough over ~1.5 px
          if (surf === 'fairway') {
            const fe = Math.abs(h.lat(x, z)) - h.fairwayHalf(z);
            if (fe > -1.5 * px) { const t = Math.min(1, (fe + 1.5 * px) / (1.5 * px)) * 0.5; cr += (0.25 - cr) * t; cg += (0.55 - cg) * t; cb += (0.17 - cb) * t; }
          }
          break;
        }
        case 'sand': {
          const ripple = 0.025 * Math.sin((x * 0.8 + z * 0.6) * 9 + valueNoise(x * 0.5, z * 0.5) * 4);
          const k = 1 + n * 2.2 + mott * 0.5 + ripple;
          cr = 0.86 * k; cg = 0.77 * k; cb = 0.58 * k; amt = shadeAmt * 0.7;
          if (bd > -0.45) { const t = Math.min(1, (bd + 0.45) / 0.45); cr *= 1 - 0.18 * t; cg *= 1 - 0.2 * t; cb *= 1 - 0.24 * t; } // shaded rim under the lip
          break;
        }
        case 'water': cr = 0.18; cg = 0.3; cb = 0.22; break;
        default: { const k = 1 + n * 2.2 + mott * 1.6; cr = 0.25 * k; cg = 0.55 * k; cb = 0.17 * k; if (surf === 'oob') { cr *= 0.94; cg *= 0.94; cb *= 0.94; } }
      }
      // grass lip around bunkers: a thin darker, lusher band
      if (surf !== 'sand' && bd < 0.35) { const t = 1 - Math.max(0, bd) / 0.35; cr *= 1 - 0.25 * t; cg *= 1 - 0.12 * t; cb *= 1 - 0.25 * t; }
      const ex = -gx * SHADE_MAIN, ez = -gz * SHADE_MAIN, el = Math.sqrt(ex * ex + 1 + ez * ez);
      const shade = (ex * lx + ly + ez * lz) / el - ly;
      const m = Math.min(1.5, Math.max(surf === 'green' || surf === 'fringe' ? 0.5 : 0.72, 1 + amt * shade));
      cr *= m; cg *= m; cb *= m;
      if (surf === 'green' || surf === 'fringe') {
        const f = y / CONTOUR_STEP, gl = Math.sqrt(gx * gx + gz * gz);
        const dm = Math.abs(f - Math.round(f)) * CONTOUR_STEP / Math.max(gl, 1e-4);
        if (dm < 0.055) { const c = 1 - 0.12 * (1 - (dm / 0.055) ** 2); cr *= c; cg *= c; cb *= c; }
      }
      const o = (j * W + i) * 4;
      a[o] = c255(cr); a[o + 1] = c255(cg); a[o + 2] = c255(cb); a[o + 3] = 255;
      if (b) {
        b[o] = a[o]; b[o + 1] = a[o + 1]; b[o + 2] = a[o + 2]; b[o + 3] = 255;
        if (surf === 'green') {
          const fx = Math.abs(x - Math.round(x)), fz = Math.abs(z - Math.round(z));
          if (fx < px * 0.55 || fz < px * 0.55) { b[o] = c255(cr * 0.72 + 0.26); b[o + 1] = c255(cg * 0.72 + 0.26); b[o + 2] = c255(cb * 0.72 + 0.26); }
        }
      }
    }
  }
  return { W, H: Ht, a, b };
}

export function c255(v) { return Math.max(0, Math.min(255, Math.round(v * 255))); }
export function hashf(i, j) {
  let h = (Math.floor(i * 1000) * 374761393 + Math.floor(j * 1000) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function valueNoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hashf(i, j), b = hashf(i + 1, j), c = hashf(i, j + 1), d = hashf(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
