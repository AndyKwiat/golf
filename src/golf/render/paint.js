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
export function paintPixels(h, r, px, shadeAmt, withGrid, hstep, light, canopy = null, shadow = null) {
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
        default: {
          const k = 1 + n * 2.2 + mott * 1.6; cr = 0.25 * k; cg = 0.55 * k; cb = 0.17 * k;
          // forest floor: fades in beyond the playable rough, everywhere out of bounds
          const zc = z < 0 ? 0 : z > h.L ? h.L : z, la = Math.abs(h.lat(x, zc));
          const ff = surf === 'oob' ? 1 : smoothstep(h.fw.w + h.roughW - 4, h.fw.w + h.roughW + 10, la);
          if (ff > 0) {
            const [fr, fg, fb] = forestFloor(x, z, n);
            cr += (fr - cr) * ff; cg += (fg - cg) * ff; cb += (fb - cb) * ff;
          }
        }
      }
      // shade under tree canopies (soft, from the canopy coverage grid)
      if (canopy) {
        const ci = Math.round((x - canopy.x0) / canopy.cell), cj = Math.round((z - canopy.z0) / canopy.cell);
        if (ci >= 0 && cj >= 0 && ci < canopy.nx && cj < canopy.nz) {
          const c = canopy.data[cj * canopy.nx + ci];
          if (c > 0) { const k = 1 - 0.18 * Math.min(1, c * 0.8); cr *= k; cg *= k; cb *= k * 0.97; }
        }
      }
      // baked tree shadows (sun and trees are static, so these never pop)
      if (shadow) { const sh = sampleGrid(shadow, x, z); if (sh > 0) { const k = 1 - SHADOW_DARK * sh; cr *= k; cg *= k; cb *= k * 1.04; } }
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

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Forest floor color: patches of moss, pine needles, leaf litter, bare dirt and grass tufts. */
export function forestFloor(x, z, n) {
  const n1 = valueNoise(x * 0.11, z * 0.11), n2 = valueNoise(x * 0.42 + 5, z * 0.42), n3 = valueNoise(x * 1.6, z * 1.6 + 3);
  const t1 = smoothstep(0.35, 0.65, n1);                          // moss <-> needles
  let r = 0.21 + (0.40 - 0.21) * t1, g = 0.37 + (0.30 - 0.37) * t1, b = 0.14 + (0.17 - 0.14) * t1;
  const t2 = smoothstep(0.58, 0.82, n2);                          // leaf litter
  r += (0.47 - r) * t2; g += (0.37 - g) * t2; b += (0.19 - b) * t2;
  const t3 = smoothstep(0.7, 0.85, n3) * (1 - t2);                // bare dirt
  r += (0.35 - r) * t3; g += (0.27 - g) * t3; b += (0.19 - b) * t3;
  const t4 = smoothstep(0.32, 0.18, n2);                          // grass tufts
  r += (0.26 - r) * t4; g += (0.5 - g) * t4; b += (0.17 - b) * t4;
  const k = 0.92 + n * 3 + (n3 - 0.5) * 0.12;
  return [r * k, g * k, b * k];
}

export const SHADOW_DARK = 0.42;

/** Bilinear sample of a {x0, z0, cell, nx, nz, data (Uint8 0..255)} grid -> 0..1. */
export function sampleGrid(g, x, z) {
  const fx = (x - g.x0) / g.cell, fz = (z - g.z0) / g.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.nz - 1) return 0;
  const tx = fx - i, tz = fz - j, k = j * g.nx + i, d = g.data;
  return ((d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + g.nx] * (1 - tx) + d[k + g.nx + 1] * tx) * tz) / 255;
}

const DENSITY = { pine: 0.9, redwood: 0.92, round: 0.85, poplar: 0.8, birch: 0.62 };

/**
 * Rasterize ground shadows of all trees for a static directional light (unit vector pointing
 * TOWARD the light). Crowns: ellipsoids project to ellipses, cones to a teardrop from the base
 * circle to the projected tip; trunks to thin strips. Overlaps combine like translucent layers.
 */
export function bakeTreeShadows(trees, light, cell = 1) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const t of trees) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x); z0 = Math.min(z0, t.z); z1 = Math.max(z1, t.z); }
  const M = 50; x0 -= M; x1 += M; z0 -= M; z1 += M;
  const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const keep = new Float32Array(nx * nz).fill(1);           // fraction of light that gets through
  const hl = Math.hypot(light.x, light.z) || 1e-6, ux = -light.x / hl, uz = -light.z / hl;   // shadow direction
  const cot = hl / light.y, sinE = light.y / Math.hypot(light.x, light.y, light.z), cosE = Math.sqrt(1 - sinE * sinE);
  const stamp = (cx, cz, sMin, sMax, wMax, fn) => {      // fn(s, w) -> opacity; s along shadow dir from (cx,cz)
    const ext = Math.max(Math.abs(sMin), Math.abs(sMax)) + wMax;
    const i0 = Math.max(0, Math.floor((cx - ext - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((cx + ext - x0) / cell));
    const j0 = Math.max(0, Math.floor((cz - ext - z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((cz + ext - z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = x0 + i * cell - cx, dz = z0 + j * cell - cz, sv = dx * ux + dz * uz, w = Math.abs(-dx * uz + dz * ux);
      if (sv < sMin || sv > sMax || w > wMax) continue;
      const o = fn(sv, w);
      if (o > 0) keep[j * nx + i] *= 1 - o;
    }
  };
  for (const t of trees) {
    const dens = DENSITY[t.type] ?? 0.85;
    if (t.shape === 'cone') {
      const R = t.crownR, H = t.crownTop - t.crownBase, bs = t.crownBase * cot, Lt = H * cot;
      const bx = t.x + ux * bs, bz = t.z + uz * bs;
      stamp(bx, bz, -R, Lt, R, (sv, w) => {
        const half = sv < 0 ? Math.sqrt(Math.max(0, R * R - sv * sv)) : R * (1 - sv / Lt) * 0.95 + R * 0.05;
        const q = 1 - (w / Math.max(half, 1e-3)) ** 2;
        return q > 0 ? dens * smoothstep(0, 0.45, q) : 0;
      });
    } else {
      const R = t.crownR, Ry = t.crownRy, cs = t.crownY * cot;
      const a = Math.sqrt(R * R * sinE * sinE + Ry * Ry * cosE * cosE) / sinE;
      stamp(t.x + ux * cs, t.z + uz * cs, -a, a, R, (sv, w) => {
        const q = 1 - (sv / a) ** 2 - (w / R) ** 2;
        return q > 0 ? dens * smoothstep(0, 0.4, q) : 0;
      });
    }
    // trunk (matters for redwoods / poplars with long bare trunks)
    const th = t.shape === 'cone' ? t.crownBase : t.crownY - t.crownRy * 0.7;
    if (th > 1.5) {
      const tw = Math.max(t.trunkR, cell * 0.35);
      stamp(t.x, t.z, 0, th * cot, tw + cell * 0.5, (sv, w) => (w < tw + cell * 0.5 ? 0.6 * (1 - Math.max(0, w - tw) / (cell * 0.5)) : 0));
    }
  }
  const data = new Uint8Array(nx * nz);
  for (let k = 0; k < data.length; k++) data[k] = Math.round((1 - keep[k]) * 255);
  return { x0, z0, cell, nx, nz, data };
}
