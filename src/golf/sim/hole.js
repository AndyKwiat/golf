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

export class Hole {
  constructor(params) {
    this.params = params;
    Object.assign(this, {
      seed: params.seed, par: params.par, L: params.L, ctrl: params.ctrl, fw: params.fairway,
      roughW: params.roughW, base: params.base, elev: params.elev, green: params.green,
      tee: params.tee, bunkers: params.bunkers, ponds: params.ponds, trees: params.trees, cup: params.cup,
      wind: params.wind || { x: 0, z: 0 },
    });
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
    return h;
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
    if (!skipPonds) {
      for (const p of this.ponds) {
        if (Math.abs(x - p.x) > p._bound + 6 || Math.abs(z - p.z) > p._bound + 6) continue;
        const d = blobDist(p, x, z);
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
      if (blobDist(p, x, z) < 0) return 'water';
    }
    for (const b of this.bunkers) {
      if (Math.abs(x - b.x) > b._bound || Math.abs(z - b.z) > b._bound) continue;
      if (blobDist(b, x, z) < 0) return 'sand';
    }
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

  // Centerline control points [z, x]. Doglegs: par 4s usually bend once, par 5s bend twice
  // (often an S). corners[] records each bend (z, turn direction) for hazards/trees.
  let ctrl;
  const corners = [];
  if (par === 3) ctrl = [[0, 0], [L, U(-20, 20) * SCALE]];
  else if (par === 4) {
    const xa = U(-8, 8);
    if (rand() < 0.8) {
      const dir = sign(), za = L * U(0.55, 0.66);
      ctrl = [[0, 0], [za, xa], [L, xa + dir * U(35, 85) * SCALE]];
      corners.push({ z: za, dir });
    } else ctrl = [[0, 0], [L * 0.6, xa], [L, xa + U(-15, 15)]];
  } else {
    const d1 = sign(), d2 = rand() < 0.65 ? -d1 : d1;
    const z1 = L * U(0.36, 0.44), z2 = L * U(0.68, 0.76);
    const x1 = d1 * U(12, 35) * SCALE, x2 = x1 + d2 * U(30, 70) * SCALE;
    ctrl = [[0, 0], [z1, x1], [z2, x2], [L, x2 + sign() * U(10, 40) * SCALE]];
    corners.push({ z: z1, dir: Math.sign(x2 - x1) || 1 }, { z: z2, dir: Math.sign(ctrl[3][1] - x2) || 1 });
  }

  const fairway = {
    w: U(14, 21), z0: par === 3 ? L - 50 : U(70, 120), z1: L - 6,
    wobble: [{ a: U(0.06, 0.14), f: U(0.01, 0.03), p: U(0, 6.3) }, { a: U(0.03, 0.08), f: U(0.04, 0.07), p: U(0, 6.3) }],
  };
  const roughW = U(14, 22);
  const elev = (rand() - 0.45) * (par === 3 ? 18 : 12);

  const params = { seed, par, L, ctrl, fairway, roughW, elev, base: [], green: null, tee: { x: 0, z: 0 }, bunkers: [], ponds: [], trees: [], cup: { x: 0, z: 0 } };
  const tmp = new Hole({ ...params, green: { x: 0, z: L, R0: 10, harm: [], bumps: [], lift: 0 }, trees: [] });

  for (let i = 0; i < 16; i++) {
    const z = U(-40, L + 60), s = U(18, 50);
    params.base.push({ x: tmp.cx(z) + U(-90, 90), z, s, a: sign() * U(0.8, 4) * (s / 35) });
  }
  // green
  const R0 = par === 3 ? U(11, 14) : U(12, 16);
  const green = { x: tmp.cx(L), z: L, R0, rot: 0, sx: 1, harm: makeHarm(rand, 3, 0.14), bumps: [], lift: 0.5 };
  const nb = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < nb; i++) {
    const a = rand() * PI * 2, r = Math.sqrt(rand()) * R0 * 1.1, s = U(3, 7);
    green.bumps.push({ x: green.x + cos(a) * r, z: green.z + sin(a) * r, s, a: sign() * U(0.25, 0.8) * (s / 5) });
  }
  params.green = green;

  // greenside bunkers
  const approach = atan2(L - (L - 40), green.x - tmp.cx(L - 40)); // direction of play into the green
  const ngb = par === 3 ? 2 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3);
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
    for (const z of zs) {
      if (z > L - 70) continue;
      const side = sign(), d = tmp.cxd(z);
      const lat = side * fairway.w * U(0.6, 1.15);
      params.bunkers.push({ x: tmp.cx(z) + lat * Math.sqrt(1 + d * d), z, R0: U(4, 7), rot: atan2(1, d), sx: U(1.5, 2.6), harm: makeHarm(rand, 3, 0.15), depth: 0.6 });
    }
  }
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
    if (kept >= 2) break;
    p.harm = makeHarm(rand, 3, 0.12);
    p.level = 0;
    p._bound = blobBound(p);
    const okGreen = blobDist(p, green.x, green.z) > 0 && gEdge.every(([x, z]) => blobDist(p, x, z) > 0);
    const okTee = len2(p.x, p.z) > p._bound + 35;
    const okOthers = params.ponds.every(q => len2(p.x - q.x, p.z - q.z) > (p._bound + q._bound) * 0.8);
    if (okGreen && okTee && okOthers) {
      params.ponds.push(p); kept++;
      params.bunkers = params.bunkers.filter(b => blobDist(p, b.x, b.z) > b.R0 * Math.max(1, b.sx) + 3);
    }
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
    }
    p.level = lo - 0.15;
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

  // Trees: belts along both sides, a few in the rough, a backdrop behind the green.
  const trees = [];
  const addTree = (x, z) => {
    const s = hole.surface(x, z);
    if (s !== 'rough') return;
    if (len2(x - green.x, z - green.z) < R0 + 10 || len2(x, z) < 14) return;
    for (const b of params.bunkers) if (blobDist(b, x, z) < 4) return;
    for (const p of params.ponds) if (blobDist(p, x, z) < 4) return;
    const pine = rand() < 0.55, sc = U(0.8, 1.4);
    const t = { id: trees.length, x, z, type: pine ? 'pine' : 'round', s: sc, y0: hole.height(x, z) };
    if (pine) Object.assign(t, { trunkR: 0.22 * sc, trunkTop: 1.8 * sc, crownBase: 1.2 * sc, crownTop: 9.5 * sc, crownR: 2.6 * sc });
    else Object.assign(t, { trunkR: 0.28 * sc, trunkTop: 3.0 * sc, crownY: 5.2 * sc, crownR: 3.0 * sc, crownRy: 2.6 * sc });
    trees.push(t);
  };
  for (const side of [-1, 1]) {
    for (let z = -25; z < L + 35; z += U(5, 10)) {
      const la = side * (fairway.w + roughW + U(-6, 22)), d = tmp.cxd(z);
      addTree(hole.cx(z) + la * Math.sqrt(1 + d * d), z);
      if (rand() < 0.4) addTree(hole.cx(z) + (la + side * U(5, 10)) * Math.sqrt(1 + d * d), z + U(-3, 3));
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
