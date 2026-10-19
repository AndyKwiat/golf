// Random golf hole: tee at the origin, hole runs toward +z along a smooth centerline x = cx(z).
// Everything derives from a JSON params object (generateHoleParams(seed)) so holes can be saved,
// tweaked and loaded in tests. Surfaces (priority order):
//   oob > tee > green > fringe > water > sand > fairway > rough
import { mulberry32 } from '../../sim/rng.js';
import { len2, exp, sin, cos, atan2 } from '../../sim/math.js';
import { FRINGE_WIDTH, CUP_R } from './constants.js';

const PI = Math.PI;
const SCALE = 1.3;   // hole lengths / dogleg offsets vs. real-world sizes (matches the long clubs)
export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- blobs (green, bunkers, ponds)
/** Signed-ish edge distance for a blob: < 0 inside. Blob: {x,z,R0,rot,sx,harm:[{k,a,p}]} */
export function blobDist(bl, x, z) {
  const dx = x - bl.x, dz = z - bl.z;
  const c = bl._c ?? (bl._c = cos(bl.rot || 0)), s = bl._s ?? (bl._s = sin(bl.rot || 0));
  const lx = (dx * c + dz * s) / (bl.sx || 1), lz = -dx * s + dz * c;
  const r = len2(lx, lz);
  const th = atan2(lz, lx);
  let f = 1;
  for (const h of bl.harm) f += h.a * cos(h.k * th + h.p);
  return r - bl.R0 * f;
}
function blobBound(bl) {
  let a = 0; for (const h of bl.harm) a += Math.abs(h.a);
  return bl.R0 * (1 + a) * Math.max(1, bl.sx || 1);
}
function makeHarm(rand, n, amp) {
  const out = [];
  for (let k = 2; k < 2 + n; k++) out.push({ k, a: (rand() * amp) / (k - 1), p: rand() * PI * 2 });
  return out;
}

/** Pond signed distance (< 0 = water), honoring an optional island (e.g. an island green). */
export function pondDist(p, x, z) {
  const d = blobDist(p, x, z);
  if (!p.island) return d;
  return Math.max(d, p.island.R - len2(x - p.island.x, z - p.island.z));
}

/**
 * Cliffs. kind 'step': a terrace edge along a straight line (n = unit normal, h > 0 = higher on
 * the +n side), 'ravine': a gully along a line (depth, flat bottom half-width hw, wall width),
 * 'side': a wall/drop alongside the hole at lateral offset `off` on `side`, over z in [za, zb].
 */
export function cliffSD(hole, c, x, z) {
  if (c.kind === 'side') return c.side * hole.lat(x, Math.min(Math.max(z, 0), hole.L)) - c.off;
  return (x - c.x) * c.nx + (z - c.z) * c.nz;
}
function cliffHeight(hole, c, x, z) {
  const sd = cliffSD(hole, c, x, z);
  if (c.kind === 'ravine') { const a = Math.abs(sd); return a > c.hw + c.wall ? 0 : -c.depth * (1 - smoothstep(c.hw, c.hw + c.wall, a)); }
  let k = c.h * smoothstep(-c.w / 2, c.w / 2, sd);
  if (c.kind === 'side') k *= smoothstep(c.za - 50, c.za, z) * smoothstep(c.zb + 50, c.zb, z);
  return k;
}

/** Cache a river's bounding box (with bank margin). River: { pts: [[x,z]...], w, levels: [] } */
function prepRiver(r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of r.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const m = r.w / 2 + 7;
  r._bb = [x0 - m, x1 + m, z0 - m, z1 + m];
  // per-segment bounding squares for quick rejection. Margin (w/2 + 25 m) exceeds every distance
  // threshold callers use, so culling never changes a result that matters.
  r._segs = [];
  for (let i = 0; i < r.pts.length - 1; i++) {
    const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
    r._segs.push({ cx: (ax + bx) / 2, cz: (az + bz) / 2, rad: len2(bx - ax, bz - az) / 2 + r.w / 2 + 25 });
  }
}

/**
 * Tree dimensions by type (shared by the sim generator and the view's decorative forest).
 * shape 'cone': crown from crownBase..crownTop, radius crownR at the bottom.
 * shape 'ellipsoid': crown centered at crownY with radii crownR (horizontal) / crownRy.
 */
export const TREE_TYPES = ['pine', 'round', 'redwood', 'poplar', 'birch'];
export function makeTree(type, sc, x, z, y0, id = 0) {
  const t = { id, x, z, type, s: sc, y0 };
  switch (type) {
    case 'pine': return Object.assign(t, { shape: 'cone', trunkR: 0.22 * sc, trunkTop: 1.8 * sc, crownBase: 1.2 * sc, crownTop: 9.5 * sc, crownR: 2.6 * sc });
    case 'redwood': return Object.assign(t, { shape: 'cone', trunkR: 0.55 * sc, trunkTop: 9 * sc, crownBase: 8 * sc, crownTop: 30 * sc, crownR: 3.8 * sc });
    case 'poplar': return Object.assign(t, { shape: 'ellipsoid', trunkR: 0.3 * sc, trunkTop: 3 * sc, crownY: 11.5 * sc, crownR: 2.4 * sc, crownRy: 9 * sc });
    case 'birch': return Object.assign(t, { shape: 'ellipsoid', trunkR: 0.2 * sc, trunkTop: 3.5 * sc, crownY: 6.2 * sc, crownR: 2.7 * sc, crownRy: 3.3 * sc });
    default: return Object.assign(t, { shape: 'ellipsoid', trunkR: 0.28 * sc, trunkTop: 3.0 * sc, crownY: 5.2 * sc, crownR: 3.0 * sc, crownRy: 2.6 * sc });
  }
}
/** Weighted random tree type. */
export function pickTreeType(r) { return r < 0.3 ? 'pine' : r < 0.52 ? 'round' : r < 0.68 ? 'redwood' : r < 0.82 ? 'poplar' : 'birch'; }

export class Hole {
  constructor(params) {
    this.params = params;
    Object.assign(this, {
      seed: params.seed, par: params.par, L: params.L, ctrl: params.ctrl, fw: params.fairway,
      roughW: params.roughW, base: params.base, elev: params.elev, green: params.green,
      tee: params.tee, bunkers: params.bunkers, ponds: params.ponds, trees: params.trees, cup: params.cup,
      wind: params.wind || { x: 0, z: 0 }, rivers: params.rivers || [], outer: params.outer || [],
      theme: params.theme || 'parkland', cliffs: params.cliffs || [], islands: params.islands || [],
    });
    for (const r of this.rivers) prepRiver(r);
    for (const b of this.bunkers) b._bound = blobBound(b);
    for (const p of this.ponds) p._bound = blobBound(p);
    this.green._bound = blobBound(this.green);
    this._Hg = null; this._Ht = null;
    this._Hg = this.baseHeight(this.green.x, this.green.z);
    this._Ht = this.baseHeight(this.tee.x, this.tee.z);
    this._buildTreeIndex();
    this.length = this.pathLength();
  }

  // ---------------------------------------------------------------- centerline
  cx(z) {
    const c = this.ctrl;
    if (z <= c[0][0]) return c[0][1];
    for (let i = 0; i < c.length - 1; i++) {
      const [z0, x0] = c[i], [z1, x1] = c[i + 1];
      if (z <= z1) { const t = (z - z0) / (z1 - z0); return x0 + (x1 - x0) * (1 - cos(PI * t)) / 2; }
    }
    return c[c.length - 1][1];
  }
  cxd(z) {
    const c = this.ctrl;
    for (let i = 0; i < c.length - 1; i++) {
      const [z0, x0] = c[i], [z1, x1] = c[i + 1];
      if (z >= z0 && z <= z1) { const t = (z - z0) / (z1 - z0); return (x1 - x0) * PI * sin(PI * t) / (2 * (z1 - z0)); }
    }
    return 0;
  }
  /** lateral distance from the centerline (approx, signed: + is toward +x) */
  lat(x, z) { const d = this.cxd(z); return (x - this.cx(z)) / Math.sqrt(1 + d * d); }
  fairwayHalf(z) {
    const f = this.fw;
    const k = Math.min(1, (z - f.z0) / 12, (f.z1 - z) / 12);
    if (k <= 0) return 0;
    let w = f.w;
    for (const wb of f.wobble) w *= 1 + wb.a * sin(wb.f * z + wb.p);
    return w * Math.sqrt(k);
  }
  corridor() { return this.fw.w + this.roughW + 32; }
  pathLength() {
    let s = 0;
    for (let z = 0; z < this.L; z += 2) { const d = this.cxd(z + 1); s += 2 * Math.sqrt(1 + d * d); }
    return s;
  }

  // ---------------------------------------------------------------- height
  baseHeight(x, z) {
    let h = this.elev * smoothstep(-20, this.L, z);
    for (const b of this.base) {
      const dx = x - b.x, dz = z - b.z;
      h += b.a * exp(-(dx * dx + dz * dz) / (2 * b.s * b.s));
    }
    const la = Math.abs(this.lat(x, z));
    h += 2.2 * smoothstep(this.fw.w + 4, this.fw.w + this.roughW + 18, la);
    for (const c of this.cliffs) h += cliffHeight(this, c, x, z);
    // big rolling hills out in the forest; faded to zero inside the playable corridor
    const cor = this.corridor();
    if (this.outer.length && (la > cor - 8 || z < -40 || z > this.L + 45)) {
      const k = Math.max(smoothstep(cor - 8, cor + 40, la), smoothstep(-40, -90, z), smoothstep(this.L + 45, this.L + 95, z));
      let o = 0;
      for (const b of this.outer) {
        const dx = x - b.x, dz = z - b.z;
        o += b.a * exp(-(dx * dx + dz * dz) / (2 * b.s * b.s));
      }
      h += o * k;
    }
    return h;
  }

  /** Nearest river info at (x, z): { d: distance to the river centerline, half, level } or null. */
  riverAt(x, z) {
    let best = null;
    for (const r of this.rivers) {
      const bb = r._bb;
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      const P = r.pts, S = r._segs;
      for (let i = 0; i < P.length - 1; i++) {
        const sg = S[i], ox = x - sg.cx, oz = z - sg.cz;
        if (ox > sg.rad || ox < -sg.rad || oz > sg.rad || oz < -sg.rad) continue;
        const ax = P[i][0], az = P[i][1], bx = P[i + 1][0], bz = P[i + 1][1];
        const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz;
        let t = L2 > 0 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (ax + vx * t), dz = z - (az + vz * t), d = Math.sqrt(dx * dx + dz * dz);
        if (!best || d < best.d) best = { d, half: r.w / 2, level: r.levels[i] + (r.levels[i + 1] - r.levels[i]) * t, river: r };
      }
    }
    return best;
  }

  height(x, z, skipPonds = false) {
    let h = this.baseHeight(x, z);
    const g = this.green;
    const dg = len2(x - g.x, z - g.z);
    if (this._Hg !== null) {
      const wg = 1 - smoothstep(g.R0 + 4, g.R0 + 30, dg);
      h += (this._Hg - h) * wg;
      const dt = len2(x - this.tee.x, z - this.tee.z);
      const wt = 1 - smoothstep(6, 22, dt);
      h += (this._Ht - h) * wt;
      h += 0.3 * (1 - smoothstep(4.5, 7, dt));               // raised tee box
    }
    h += g.lift * (1 - smoothstep(g.R0 * 0.85, g.R0 + 10, dg)); // green sits on a gentle plateau
    if (dg < g.R0 * 2.5 + 25) {
      for (const b of g.bumps) {
        const dx = x - b.x, dz = z - b.z;
        h += b.a * exp(-(dx * dx + dz * dz) / (2 * b.s * b.s));
      }
    }
    for (const b of this.bunkers) {
      if (Math.abs(x - b.x) > b._bound + 2 || Math.abs(z - b.z) > b._bound + 2) continue;
      const d = blobDist(b, x, z);
      if (d < 1.0) h -= b.depth * smoothstep(1.0, -1.6, d);
    }
    if (!skipPonds && this.rivers.length) {
      const rv = this.riverAt(x, z);
      if (rv && rv.d < rv.half + 5) {   // channel + ~5 m banks (same profile as ponds)
        const hp = rv.level - 0.06 - 1.3 * smoothstep(0, rv.half, rv.half - rv.d);
        h = hp + (h - hp) * smoothstep(rv.half - 0.3, rv.half + 5, rv.d);
      }
    }
    if (!skipPonds) {
      for (const p of this.ponds) {
        if (Math.abs(x - p.x) > p._bound + 6 || Math.abs(z - p.z) > p._bound + 6) continue;
        const d = pondDist(p, x, z);
        if (d < 5) {   // shore: blend from the pond bed up to the terrain over ~5 m (gentle banks)
          const hp = p.level - 0.06 - 1.6 * smoothstep(0, 4, -d);
          h = hp + (h - hp) * smoothstep(-0.3, 5, d);
        }
      }
    }
    return h;
  }

  grad(x, z) {
    const e = 0.01;
    return [(this.height(x + e, z) - this.height(x - e, z)) / (2 * e), (this.height(x, z + e) - this.height(x, z - e)) / (2 * e)];
  }
  slope(x, z) { const [a, b] = this.grad(x, z); return len2(a, b); }

  // ---------------------------------------------------------------- surface
  surface(x, z) {
    if (z < -40 || z > this.L + 45) return 'oob';
    const la = this.lat(x, z);
    if (Math.abs(la) > this.corridor()) return 'oob';
    if (Math.abs(x - this.tee.x) < 3 && Math.abs(z - this.tee.z) < 4.5) return 'tee';
    const g = this.green;
    if (Math.abs(x - g.x) < g._bound + FRINGE_WIDTH + 1 && Math.abs(z - g.z) < g._bound + FRINGE_WIDTH + 1) {
      const d = blobDist(g, x, z);
      if (d <= 0) return 'green';
      if (d <= FRINGE_WIDTH) return 'fringe';
    }
    for (const p of this.ponds) {
      if (Math.abs(x - p.x) > p._bound || Math.abs(z - p.z) > p._bound) continue;
      if (pondDist(p, x, z) < 0) return 'water';
    }
    if (this.rivers.length) { const rv = this.riverAt(x, z); if (rv && rv.d < rv.half) return 'water'; }
    for (const b of this.bunkers) {
      if (Math.abs(x - b.x) > b._bound || Math.abs(z - b.z) > b._bound) continue;
      if (blobDist(b, x, z) < 0) return 'sand';
    }
    for (const c of this.cliffs) if (c.kind === 'ravine' && Math.abs(cliffSD(this, c, x, z)) < c.hw + c.wall * 0.7) return 'rough';
    for (const t of this.islands) if (len2(x - t.x, z - t.z) < t.R) return 'rough';   // tree islands
    if (Math.abs(la) < this.fairwayHalf(z)) return 'fairway';
    return 'rough';
  }

  distToCup(x, z) { return len2(x - this.cup.x, z - this.cup.z); }

  // ---------------------------------------------------------------- trees
  _buildTreeIndex() {
    this._cell = 10;
    this._grid = new Map();
    for (const t of this.trees) {
      const r = Math.max(t.crownR, t.trunkR) + 0.5;
      for (let i = Math.floor((t.x - r) / 10); i <= Math.floor((t.x + r) / 10); i++) {
        for (let j = Math.floor((t.z - r) / 10); j <= Math.floor((t.z + r) / 10); j++) {
          const k = i * 100003 + j;
          if (!this._grid.has(k)) this._grid.set(k, []);
          this._grid.get(k).push(t);
        }
      }
    }
  }
  treesNear(x, z) { return this._grid.get(Math.floor(x / 10) * 100003 + Math.floor(z / 10)) || EMPTY; }
}
const EMPTY = [];

// ---------------------------------------------------------------- generation
export function generateHoleParams(seed) {
  const rand = mulberry32(seed);
  const U = (a, b) => a + rand() * (b - a);
  const sign = () => (rand() < 0.5 ? -1 : 1);
  const par = [3, 4, 5][Math.floor(rand() * 3)];
  // Realistic tournament yardages (path length incl. doglegs): par 3 ~150-250 yd,
  // par 4 ~380-500 yd, par 5 ~520-640 yd. (With video-game drives, par 5s are reachable in two.)
  const L = par === 3 ? U(137, 228) : par === 4 ? U(330, 432) : U(450, 552);

  // Theme: gives each hole a distinct character (see AGENTS.md).
  const tr = mulberry32(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0)();   // own stream: consecutive seeds would correlate
  const theme = tr < 0.24 ? 'parkland' : tr < 0.44 ? 'lakes' : tr < 0.62 ? 'canyon' : tr < 0.8 ? 'links' : 'forest';
  const TH = {
    parkland: { trees: 0.75, fw: [15, 21], rough: [14, 22], dog: 1, bunk: 1, ponds: 1 },
    lakes:    { trees: 0.6, fw: [16, 22], rough: [14, 20], dog: 0.9, bunk: 0.8, ponds: 1.6 },
    canyon:   { trees: 0.6, fw: [16, 22], rough: [14, 20], dog: 1, bunk: 0.8, ponds: 0.6 },
    links:    { trees: 0.15, fw: [22, 30], rough: [24, 34], dog: 0.6, bunk: 1.8, ponds: 0.6 },
    forest:   { trees: 1, fw: [12, 16], rough: [11, 16], dog: 1.5, bunk: 0.8, ponds: 0.9 },
  }[theme];
  // Centerline control points [z, x]. Doglegs: par 4s usually bend once, par 5s bend twice
  // (often an S). corners[] records each bend (z, turn direction) for hazards/trees.
  let ctrl;
  const corners = [];
  if (par === 3) ctrl = [[0, 0], [L, U(-20, 20) * SCALE]];
  else if (par === 4) {
    const xa = U(-8, 8);
    if (rand() < 0.8) {
      const dir = sign(), za = L * U(0.55, 0.66);
      const big = rand() < (theme === 'forest' ? 0.7 : 0.3);   // hard doglegs: up to ~150 m sideways
      ctrl = [[0, 0], [za, xa], [L, xa + dir * (big ? U(95, 150) : U(35, 85) * SCALE) * Math.min(1.2, TH.dog)]];
      corners.push({ z: za, dir });
    } else ctrl = [[0, 0], [L * 0.6, xa], [L, xa + U(-15, 15)]];
  } else {
    const d1 = sign(), d2 = rand() < 0.65 ? -d1 : d1;
    const z1 = L * U(0.36, 0.44), z2 = L * U(0.68, 0.76);
    const big = rand() < (theme === 'forest' ? 0.6 : 0.25);
    const x1 = d1 * U(12, 35) * SCALE * TH.dog, x2 = x1 + d2 * (big ? U(90, 140) : U(30, 70) * SCALE);
    ctrl = [[0, 0], [z1, x1], [z2, x2], [L, x2 + sign() * U(10, 40) * SCALE]];
    corners.push({ z: z1, dir: Math.sign(x2 - x1) || 1 }, { z: z2, dir: Math.sign(ctrl[3][1] - x2) || 1 });
  }

  const fairway = {
    w: U(TH.fw[0], TH.fw[1]), z0: par === 3 ? L - 50 : U(70, 120), z1: L - 6,
    wobble: [{ a: U(0.06, 0.14), f: U(0.01, 0.03), p: U(0, 6.3) }, { a: U(0.03, 0.08), f: U(0.04, 0.07), p: U(0, 6.3) }],
  };
  const roughW = U(TH.rough[0], TH.rough[1]);
  const elev = (rand() - 0.45) * (par === 3 ? 18 : 12) * (theme === 'canyon' ? 2 : 1);

  const params = { seed, par, L, ctrl, fairway, roughW, elev, theme, base: [], cliffs: [], islands: [], green: null, tee: { x: 0, z: 0 }, bunkers: [], ponds: [], trees: [], cup: { x: 0, z: 0 } };
  const tmp = new Hole({ ...params, green: { x: 0, z: L, R0: 10, harm: [], bumps: [], lift: 0 }, trees: [] });

  for (let i = 0; i < 16; i++) {
    const z = U(-40, L + 60), s = U(18, 50);
    params.base.push({ x: tmp.cx(z) + U(-90, 90), z, s, a: sign() * U(0.8, 4) * (s / 35) });
  }
  if (theme === 'links') for (let i = 0; i < 40; i++) {     // dunes: lots of small humps and hollows
    const z = U(-20, L + 40), s = U(6, 16);
    params.base.push({ x: tmp.cx(Math.min(Math.max(z, 0), L)) + U(-70, 70), z, s, a: sign() * U(0.8, 2.6) });
  }
  // green
  const R0 = par === 3 ? U(11, 14) : U(12, 16);
  const green = { x: tmp.cx(L), z: L, R0, rot: 0, sx: 1, harm: makeHarm(rand, 3, 0.14), bumps: [], lift: theme === 'canyon' ? U(1.5, 3.5) : 0.5 };
  const nb = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < nb; i++) {
    const a = rand() * PI * 2, r = Math.sqrt(rand()) * R0 * 1.1, s = U(3, 7);
    green.bumps.push({ x: green.x + cos(a) * r, z: green.z + sin(a) * r, s, a: sign() * U(0.25, 0.8) * (s / 5) });
  }
  params.green = green;

  // Cliffs: canyon holes get 1-2, others occasionally one.
  const along0 = z => { const d = tmp.cxd(Math.min(Math.max(z, 0), L)), l = Math.sqrt(1 + d * d); return [d / l, 1 / l]; };   // unit play direction (x,z)
  const crossCliff = (kind, z, extra) => { const [ux, uz] = along0(z); return { kind, x: tmp.cx(Math.min(Math.max(z, 0), L)), z, nx: ux, nz: uz, ...extra }; };
  const nCliff = theme === 'canyon' ? 1 + (rand() < 0.5 ? 1 : 0) : rand() < 0.15 ? 1 : 0;
  const usedZ = [];
  for (let i = 0; i < nCliff; i++) {
    const kinds = par === 3 ? ['teeDrop', 'ravine', 'side'] : ['teeDrop', 'ravine', 'terrace', 'side'];
    const k = kinds[Math.floor(rand() * kinds.length)];
    const zMax = L - R0 - 50;
    let c = null;
    if (k === 'teeDrop' && zMax > 60) c = crossCliff('step', U(45, Math.min(90, zMax)), { h: -U(8, 18), w: U(4, 7) });
    else if (k === 'ravine' && zMax > 70) c = crossCliff('ravine', par === 3 ? U(60, zMax) : U(L * 0.35, Math.min(L * 0.7, zMax)), { depth: U(6, 14), hw: U(5, 10), wall: U(5, 9) });
    else if (k === 'terrace' && zMax > L * 0.5) c = crossCliff('step', U(L * 0.5, Math.min(L * 0.8, zMax)), { h: U(5, 12), w: U(4, 7) });
    else if (k === 'side') { const up = rand() < 0.6; c = { kind: 'side', side: sign(), off: fairway.w + U(6, 14), h: up ? U(8, 20) : -U(8, 15), w: U(4, 7), za: U(0, L * 0.4), zb: U(L * 0.6, L) }; }
    if (!c || usedZ.some(z => Math.abs(z - c.z) < 60)) continue;
    if (c.z !== undefined) usedZ.push(c.z);
    params.cliffs.push(c);
  }

  // greenside bunkers
  const approach = atan2(L - (L - 40), green.x - tmp.cx(L - 40)); // direction of play into the green
  const ngb = Math.round((par === 3 ? 3 + Math.floor(rand() * 3) : 2 + Math.floor(rand() * 3)) * Math.min(1.4, TH.bunk));
  for (let i = 0; i < ngb; i++) {
    const th = approach + PI + sign() * U(0.6, 2.4); // around the green, not dead front
    const rb = U(3, 5.5);
    const gr = R0 * 1.1 + FRINGE_WIDTH + 1.2 + rb;
    params.bunkers.push({ x: green.x + cos(th) * gr, z: green.z + sin(th) * gr, R0: rb, rot: th + PI / 2, sx: U(1.2, 2), harm: makeHarm(rand, 3, 0.18), depth: 0.75 });
  }
  // fairway bunkers
  if (par > 3) {
    const zs = (par === 4 ? [U(190, 250)] : [U(190, 250), U(370, 430)]).map(z => z * SCALE);
    if (rand() < 0.5) zs.push(U(140, 200) * SCALE);
    if (rand() < 0.6) zs.push(U(Math.max(100, L * 0.35), L - 90));
    for (const z0 of zs) {
      if (z0 > L - 70) continue;
      const n = 1 + Math.floor(rand() * 3 * Math.min(1.3, TH.bunk));          // bunker groups
      for (let j = 0; j < n; j++) {
        const z = z0 + U(-18, 18), side = sign(), d = tmp.cxd(z);
        const lat = side * fairway.w * U(0.55, 1.2);
        params.bunkers.push({ x: tmp.cx(z) + lat * Math.sqrt(1 + d * d), z, R0: U(3.5, 7), rot: atan2(1, d), sx: U(1.5, 2.6), harm: makeHarm(rand, 3, 0.15), depth: 0.6 });
      }
    }
    // cross bunker: a short wide trap across the fairway in front of the green or the layup zone
    if (rand() < 0.35) {
      const z = L - R0 - U(30, 60), d = tmp.cxd(z);
      params.bunkers.push({ x: tmp.cx(z) + U(-5, 5), z, R0: U(3, 4.5), rot: atan2(1, d) + PI / 2, sx: U(2.8, 4), harm: makeHarm(rand, 3, 0.12), depth: 0.7 });
    }
  }
  if (theme === 'links') {   // pot bunkers: small, deep, everywhere
    const n = 8 + Math.floor(rand() * 8);
    for (let j = 0; j < n; j++) {
      const z = U(par === 3 ? L * 0.4 : 90, L - R0 - 6), d = tmp.cxd(z);
      params.bunkers.push({ x: tmp.cx(z) + U(-1, 1) * (fairway.w + 6) * Math.sqrt(1 + d * d), z, R0: U(1.8, 3), rot: U(0, PI), sx: U(1, 1.3), harm: makeHarm(rand, 3, 0.1), depth: 1.1 });
    }
  }
  // no bunkers on cliff faces / ravines
  params.bunkers = params.bunkers.filter(b => params.cliffs.every(c => Math.abs(cliffSD(tmp, c, b.x, b.z)) > (c.kind === 'ravine' ? c.hw + c.wall : c.w) + b.R0 * Math.max(1, b.sx) + 4));
  // Water hazards: build a list of candidate ponds by hole type, keep the ones that fit.
  const pondCands = [];
  const along = z => atan2(1, tmp.cxd(z));                    // direction of play at z (angle in xz)
  const at = (z, latOff) => { const d = tmp.cxd(z); return { x: tmp.cx(z) + latOff * Math.sqrt(1 + d * d), z }; };
  const greenFront = () => { const R = U(7, 11), z = L - R0 - R - U(3, 10); return { ...at(z, U(-4, 4)), R0: R, rot: along(z) + PI / 2, sx: U(1.6, 2.6) }; };
  const greenSide = () => {
    const th = approach + PI + sign() * U(0.9, 1.9), R = U(8, 13), r = R0 * 1.15 + FRINGE_WIDTH + 3 + R;
    return { x: green.x + cos(th) * r, z: green.z + sin(th) * r, R0: R, rot: th + PI / 2, sx: U(1.3, 2) };
  };
  const sidePond = (z, side) => { const R = U(10, 18); return { ...at(z, side * (fairway.w * 0.55 + R)), R0: R, rot: along(z), sx: U(1.4, 2.4) }; };
  const cornerPond = c => { const z = c.z - U(-5, 25), R = U(11, 18); return { ...at(z, c.dir * (fairway.w * U(0.3, 0.8) + R * 0.75)), R0: R, rot: along(z), sx: U(1.2, 1.9) }; };
  const crossPond = z => ({ ...at(z, 0), R0: U(8, 11), rot: along(z) + PI / 2, sx: U(3, 4) });
  if (par === 3) {
    pondCands.push(rand() < 0.7 ? greenFront() : greenSide());
    if (rand() < 0.3) pondCands.push(greenSide());
  } else if (par === 4) {
    if (corners.length && rand() < 0.65) pondCands.push(cornerPond(corners[0]));
    if (rand() < 0.45) pondCands.push(rand() < 0.5 ? greenFront() : greenSide());
    if (rand() < 0.3) pondCands.push(sidePond(U(180, 240) * SCALE, sign()));
  } else {
    if (rand() < 0.5) pondCands.push(crossPond(L * U(0.52, 0.64)));
    else pondCands.push(cornerPond(corners[Math.floor(rand() * corners.length)]));
    if (rand() < 0.45) pondCands.push(rand() < 0.5 ? greenFront() : greenSide());
  }
  if (rand() < 0.5) pondCands.push(sidePond(L * U(0.3, 0.8), sign()));   // fallback / bonus
  if (theme === 'lakes') {
    // big water: island green (par 3), a lake biting into the fairway, a lake to carry off the tee
    if (par === 3 && rand() < 0.6) {
      pondCands.unshift({ x: green.x, z: green.z, R0: R0 + U(13, 20), rot: U(0, PI), sx: U(1.1, 1.5),
        island: { x: green.x, z: green.z, R: R0 * 1.3 + FRINGE_WIDTH + 3 } });
    }
    const bigSide = () => { const z = L * U(0.3, 0.75), R = U(24, 40); return { ...at(z, sign() * (fairway.w * 0.3 + R * 0.8)), R0: R, rot: along(z), sx: U(1.4, 2.3) }; };
    const carry = () => { const z = U(80, Math.min(150, L - R0 - 60)), R = U(16, 26); return { ...at(z, U(-10, 10)), R0: R, rot: along(z) + PI / 2, sx: U(2, 3) }; };
    pondCands.unshift(rand() < 0.5 ? bigSide() : carry());
    if (rand() < 0.5) pondCands.splice(1, 0, bigSide());
  } else if (rand() < 0.3 * TH.ponds) pondCands.push(sidePond(L * U(0.2, 0.9), sign()));
  // green outline sample points, so ponds can come close to the green without touching it
  green._bound = blobBound(green);
  const gEdge = [];
  for (let i = 0; i < 48; i++) {
    const th = (i / 48) * PI * 2;
    let f = 1; for (const hm of green.harm) f += hm.a * cos(hm.k * th + hm.p);
    const r = R0 * f + FRINGE_WIDTH + 2.5;
    gEdge.push([green.x + cos(th) * r, green.z + sin(th) * r]);
  }
  let kept = 0;
  for (const p of pondCands) {
    if (kept >= (theme === 'lakes' ? 3 : 2) || (kept >= 1 && rand() > TH.ponds)) break;
    p.harm = makeHarm(rand, 3, 0.12);
    p.level = 0;
    p._bound = blobBound(p);
    const okGreen = gEdge.every(([x, z]) => pondDist(p, x, z) > 0);
    const okCliff = params.cliffs.every(c => Math.abs(cliffSD(tmp, c, p.x, p.z)) > p._bound + 10);
    const okTee = len2(p.x, p.z) > p._bound + 35;
    const okOthers = params.ponds.every(q => len2(p.x - q.x, p.z - q.z) > (p._bound + q._bound) * 0.8);
    if (okGreen && okTee && okOthers && okCliff) {
      params.ponds.push(p); kept++;
      params.bunkers = params.bunkers.filter(b => pondDist(p, b.x, b.z) > b.R0 * Math.max(1, b.sx) + 3);
    }
  }

  // Rivers: a meandering creek crossing the hole, or running down one side of it.
  params.rivers = [];
  const rav = params.cliffs.find(c => c.kind === 'ravine');
  if (rav && rand() < 0.65) {   // creek running along the bottom of the ravine
    const cor = fairway.w + roughW + 32, tx = -rav.nz, tz = rav.nx, pts = [];
    const mA = U(1, Math.max(1.2, rav.hw - 4)), mF = U(0.02, 0.05), mP = U(0, 6.3);
    for (let i = 0; i <= 36; i++) { const u = (-1 + (2 * i) / 36) * (cor + 110), m = mA * sin(u * mF + mP); pts.push([rav.x + tx * u + rav.nx * m, rav.z + tz * u + rav.nz * m]); }
    const r = { kind: 'cross', pts, w: Math.min(9, rav.hw * 1.2), levels: pts.map(() => 0) };
    prepRiver(r);
    params.rivers.push(r);
  } else if (rand() < 0.5) {
    const cor = fairway.w + roughW + 32;
    const kind = par > 3 && rand() < 0.4 ? 'along' : 'cross';
    const w = kind === 'along' ? U(6, 10) : U(7, 13);
    const pts = [];
    if (kind === 'cross') {
      const zc = par === 3 ? U(40, Math.max(45, L - R0 - 28)) : U(Math.max(110, L * 0.3), L * 0.75), slant = U(-0.35, 0.35);
      const mA = U(4, 12), mF = U(0.015, 0.035), mP = U(0, 6.3), xc = tmp.cx(zc);
      for (let i = 0; i <= 36; i++) {
        const u = -1 + (2 * i) / 36, lx = u * (cor + 110);
        pts.push([xc + lx, zc + slant * lx + mA * sin(lx * mF + mP)]);
      }
    } else {
      const side = sign(), za = L * U(0.15, 0.35), zb = L * U(0.62, 0.9), lat0 = fairway.w + U(6, 14);
      const mA = U(2, 6), mF = U(0.02, 0.05), mP = U(0, 6.3);
      for (let i = 0; i <= 40; i++) {
        const t = i / 40, z = za - 60 + (zb - za + 120) * t;
        const exitK = smoothstep(za, za - 60, z) + smoothstep(zb, zb + 60, z);  // ends curve out into the forest
        const la = side * (lat0 + exitK * (cor + 80 - lat0) + mA * sin(z * mF + mP));
        const d = tmp.cxd(Math.max(0, Math.min(L, z)));
        pts.push([tmp.cx(Math.max(0, Math.min(L, z))) + la * Math.sqrt(1 + d * d), z]);
      }
    }
    const r = { kind, pts, w, levels: pts.map(() => 0) };
    prepRiver(r);
    const tH = new Hole({ ...params, rivers: [r] });
    // must stay clear of the tee and the green (+fringe)
    let ok = (tH.riverAt(0, 0)?.d ?? 1e9) > w / 2 + 40;
    for (let i = 0; i < 48 && ok; i++) {
      const th = (i / 48) * PI * 2;
      let f = 1; for (const hm of green.harm) f += hm.a * cos(hm.k * th + hm.p);
      const rr = R0 * f + FRINGE_WIDTH + 3;
      if ((tH.riverAt(green.x + cos(th) * rr, green.z + sin(th) * rr)?.d ?? 1e9) < w / 2 + 2) ok = false;
    }
    if (ok) {
      params.rivers.push(r);
      params.bunkers = params.bunkers.filter(b => (tH.riverAt(b.x, b.z)?.d ?? 1e9) > w / 2 + b.R0 * Math.max(1, b.sx) + 3);
      params.ponds = params.ponds.filter(p => (tH.riverAt(p.x, p.z)?.d ?? 1e9) > w / 2 + p.R0 * Math.max(1, p.sx) + 3);
    }
  }
  // Big hills out in the forest (outside the corridor) so the surroundings aren't a flat field.
  params.outer = [];
  for (let i = 0; i < 22; i++) {
    const z = U(-300, L + 300), side = sign(), cor = fairway.w + roughW + 32;
    params.outer.push({ x: tmp.cx(Math.max(0, Math.min(L, z))) + side * (cor + U(40, 320)), z, s: U(40, 110), a: U(5, 26) });
  }

  // Rescale green bumps so the putting surface isn't absurd (max 12% slope).
  let hole = new Hole(params);
  let maxSlope = 0;
  for (let x = green.x - R0 * 1.3; x <= green.x + R0 * 1.3; x += 0.7) {
    for (let z = green.z - R0 * 1.3; z <= green.z + R0 * 1.3; z += 0.7) {
      if (blobDist(green, x, z) <= 0) maxSlope = Math.max(maxSlope, hole.slope(x, z));
    }
  }
  if (maxSlope > 0.12) { const k = 0.12 / maxSlope; for (const b of green.bumps) b.a *= k; hole = new Hole(params); }

  // Pond water level: just below the lowest point of the surrounding shore.
  for (const p of params.ponds) {
    let lo = Infinity;
    for (let i = 0; i < 64; i++) {
      const th = (i / 64) * PI * 2;
      let f = 1; for (const hm of p.harm) f += hm.a * cos(hm.k * th + hm.p);
      const r = p.R0 * f + 0.5, lx = cos(th) * r * p.sx, lz = sin(th) * r;
      const c = cos(p.rot), s = sin(p.rot);
      lo = Math.min(lo, hole.height(p.x + lx * c - lz * s, p.z + lx * s + lz * c, true));
      if (p.island) lo = Math.min(lo, hole.height(p.island.x + cos(th) * (p.island.R + 0.5), p.island.z + sin(th) * (p.island.R + 0.5), true));
    }
    p.level = lo - 0.15;
  }
  // River water level: per point, just below the lower bank, then smoothed along the river.
  for (const r of params.rivers) {
    const raw = r.pts.map(([x, z], i) => {
      const [nx, nz] = r.pts[Math.min(i + 1, r.pts.length - 1)], [px, pz] = r.pts[Math.max(i - 1, 0)];
      let tx = nx - px, tz = nz - pz; const tl = len2(tx, tz) || 1; tx /= tl; tz /= tl;
      const off = r.w / 2 + 0.6;
      return Math.min(hole.height(x - tz * off, z + tx * off, true), hole.height(x + tz * off, z - tx * off, true)) - 0.25;
    });
    r.levels = raw.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const v = raw[i + k]; if (v !== undefined) { s += Math.min(v, raw[i]); n++; } } return s / n; });
  }
  hole = new Hole(params);

  // Cup
  let cup = null, best = null;
  for (let i = 0; i < 500 && !cup; i++) {
    const a = rand() * PI * 2, r = Math.sqrt(rand()) * R0 * 0.7;
    const x = green.x + cos(a) * r, z = green.z + sin(a) * r;
    if (blobDist(green, x, z) > -3) continue;
    const sl = hole.slope(x, z);
    if (sl < 0.04) cup = { x, z };
    else if (!best || sl < best.sl) best = { x, z, sl };
  }
  params.cup = cup || (best ? { x: best.x, z: best.z } : { x: green.x, z: green.z });

  // Tree islands: clumps of trees in the middle of the fairway, ringed by rough.
  const nIsl = par === 3 ? 0 : Math.floor(rand() * ({ parkland: 3, forest: 4, lakes: 2, canyon: 2, links: 1.6 }[theme]));
  for (let i = 0, tries = 0; i < nIsl && tries < 30; tries++) {
    const z = U(L * 0.25, L - R0 - 70), d = tmp.cxd(z), R = U(5, 10);
    const x = hole.cx(z) + U(-0.4, 0.4) * fairway.w * Math.sqrt(1 + d * d);
    if (len2(x, z) < 90) continue;
    if (params.bunkers.some(b => blobDist(b, x, z) < R + 4) || params.ponds.some(p => pondDist(p, x, z) < R + 6)) continue;
    if (hole.rivers.length) { const rv = hole.riverAt(x, z); if (rv && rv.d < rv.half + R + 6) continue; }
    if (params.cliffs.some(c => Math.abs(cliffSD(hole, c, x, z)) < R + 12)) continue;
    if (params.islands.some(t => len2(t.x - x, t.z - z) < 60)) continue;
    params.islands.push({ x, z, R }); i++;
  }
  hole = new Hole(params);
  // Trees: belts along both sides (with open meadow gaps), islands, a backdrop behind the green.
  const trees = [];
  const gaps = [-1, 1].map(() => { const g = []; const n = Math.floor(rand() * (theme === 'forest' ? 1.5 : 3.5)); for (let i = 0; i < n; i++) { const z = U(0, L); g.push([z, z + U(40, 120)]); } return g; });
  const dens = (side, z) => TH.trees * (gaps[side > 0 ? 1 : 0].some(([a, b]) => z > a && z < b) ? 0.08 : 1);
  const addTree = (x, z) => {
    const s = hole.surface(x, z);
    if (s !== 'rough') return;
    if (len2(x - green.x, z - green.z) < R0 + 10 || len2(x, z) < 14) return;
    for (const b of params.bunkers) if (blobDist(b, x, z) < 4) return;
    for (const p of params.ponds) if (pondDist(p, x, z) < 4) return;
    if (hole.rivers.length) { const rv = hole.riverAt(x, z); if (rv && rv.d < rv.half + 3) return; }
    if (hole.slope(x, z) > 1.1) return;   // not on cliff faces
    trees.push(makeTree(pickTreeType(rand()), U(0.8, 1.35), x, z, hole.height(x, z), trees.length));
  };
  for (const side of [-1, 1]) {
    // thick belts: a ragged front row plus 2-3 rows behind it out to the corridor edge
    for (let z = -25; z < L + 35; z += U(3, 6)) {
      const la = side * (fairway.w + roughW + U(-6, 10)), d = tmp.cxd(z), k = Math.sqrt(1 + d * d), D = dens(side, z);
      if (rand() < D) addTree(hole.cx(z) + la * k, z);
      if (rand() < 0.8 * D) addTree(hole.cx(z) + (la + side * U(5, 10)) * k, z + U(-2, 2));
      if (rand() < 0.7 * D) addTree(hole.cx(z) + (la + side * U(11, 18)) * k, z + U(-2, 2));
      if (rand() < 0.6 * D) addTree(hole.cx(z) + (la + side * U(19, 28)) * k, z + U(-2, 2));
    }
  }
  if (par > 3) {
    const n = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const z = U(140, L - 80), side = sign(), d = tmp.cxd(z);
      addTree(hole.cx(z) + side * (fairway.w + U(2, roughW)) * Math.sqrt(1 + d * d), z);
    }
  }
  // Guard the inside of each dogleg so you can't just bomb it over the corner for free.
  for (const c of corners) {
    const n = 8 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) {
      const z = c.z + U(-55, 15), d = tmp.cxd(z);
      addTree(hole.cx(z) + c.dir * (fairway.w + U(1, roughW + 8)) * Math.sqrt(1 + d * d), z);
    }
  }
  for (let i = 0; i < 14; i++) addTree(green.x + U(-45, 45), L + R0 + U(10, 40));
  for (const t of params.islands) {
    const n = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) { const a = rand() * PI * 2, r = Math.sqrt(rand()) * t.R * 0.65; addTree(t.x + cos(a) * r, t.z + sin(a) * r); }
  }
  params.trees = trees;
  // Wind: strong and per-hole. 3-13 m/s from any direction.
  const wa = rand() * PI * 2, ws = U(3, 13);
  params.wind = { x: cos(wa) * ws, z: sin(wa) * ws };
  params.corners = corners;
  return params;
}

export function generateHole(seed) { return new Hole(generateHoleParams(seed)); }

/** Strip cached underscore fields so params can be JSON-serialized / deep-compared. */
export function cleanParams(p) { return JSON.parse(JSON.stringify(p, (k, v) => (k.startsWith('_') ? undefined : v))); }
export { CUP_R };
