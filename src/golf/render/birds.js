// Ambient birds: flocks soaring high over the hole + small songbirds hopping between tree tops.
// Render-only (never touches the sim). Seeded with mulberry32 so screenshots are stable; time
// only advances through update(dt). Two InstancedMeshes; wing flapping happens in the vertex
// shader (onBeforeCompile) from a per-vertex wing coordinate + per-instance flap params.
import * as THREE from 'three';
import { mulberry32 } from '../../sim/rng.js';
import { pondDist } from '../sim/hole.js';

const TAU = Math.PI * 2;
const G = 9.81;
// Video-game scale: real-size birds are invisible from a golf camera, so they're ~2-2.5x
// oversized, fly lower, and are spread along the whole hole so some are always near the player.
const MAX_SKY = 9 * 10;
const MAX_SMALL = 120;
const MAX_DUCKS = 48;

// Unit bird (wingspan 1, forward +z, up +y, wings along x). aWing = signed span fraction
// (0 on the body) so the shader knows what to rotate. `body` scales the fuselage (songbirds are
// chunkier relative to their wings than gulls/crows).
function birdGeometry(body = 1, sweep = 1, fat = 1) {
  const pos = [], wing = [];
  const tri = (a, b, c) => { for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); wing.push(v[0] / 0.5); } };
  const B = (x, y, z) => [x * body, y * body, z * body];
  // fuselage: two pyramids around a diamond ring + a tail fan
  const nose = B(0, 0.005, 0.24), tail = B(0, 0, -0.16);
  const ring = [B(0, 0.045 * fat, 0.04), B(0.05 * fat, 0, 0.04), B(0, -0.04 * fat, 0.04), B(-0.05 * fat, 0, 0.04)];
  for (let i = 0; i < 4; i++) { const a = ring[i], b = ring[(i + 1) % 4]; tri(nose, b, a); tri(tail, a, b); }
  tri(B(0, 0, -0.1), B(-0.07, 0, -0.3), B(0.07, 0, -0.3));
  // wings: inner quad + swept outer triangle per side; root sits inside the body
  for (const s of [-1, 1]) {
    const r0 = [s * 0.03, 0.01, 0.1 * body], r1 = [s * 0.03, 0.01, -0.07 * body];
    const m0 = [s * 0.26, 0.01, 0.07], m1 = [s * 0.26, 0.01, -0.1];
    const tip = [s * 0.5, 0.01, -0.1 * sweep];
    tri(r0, m0, r1); tri(r1, m0, m1); tri(m0, tip, m1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing.map(w => (Math.abs(w) < 0.07 ? 0 : w)), 1));
  return g;
}

/** Duck at 2x scale (~1 m long), facing +z, waterline at y = 0. Vertex colors: mallard drake
 * (tinted brown per instance for hens via the instance color multiply). */
function duckGeometry() {
  const parts = [];
  const add = (g, color, map = null) => {
    g = g.toNonIndexed(); g.computeVertexNormals();
    const p = g.attributes.position, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const k = map ? map(p.getX(i), p.getY(i), p.getZ(i)) : color; c.set(k, i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };
  // body: squashed sphere, grey back, brown chest, white neck ring
  add(new THREE.IcosahedronGeometry(1, 2).scale(0.24, 0.17, 0.42).translate(0, 0.07, 0), null,
    (x, y, z) => (z > 0.22 ? [0.45, 0.27, 0.16] : y > 0.12 ? [0.55, 0.55, 0.52] : [0.75, 0.74, 0.7]));
  add(new THREE.ConeGeometry(0.12, 0.3, 6).rotateX(-Math.PI / 2).translate(0, 0.14, -0.45), [0.2, 0.2, 0.22]);   // tail
  add(new THREE.IcosahedronGeometry(0.13, 1).translate(0, 0.36, 0.34), [0.08, 0.4, 0.18]);                         // green head
  add(new THREE.CylinderGeometry(0.06, 0.08, 0.2, 6).translate(0, 0.24, 0.32), null, (x, y) => (y < 0.2 ? [0.95, 0.95, 0.95] : [0.08, 0.4, 0.18]));
  add(new THREE.BoxGeometry(0.07, 0.035, 0.14).translate(0, 0.33, 0.49), [0.95, 0.75, 0.15]);                     // bill
  const pos = [], col = [];
  for (const g of parts) { pos.push(...g.attributes.position.array); col.push(...g.attributes.color.array); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Lambert (fog + lights + tone mapping for free) with a flapping vertex stage.
function birdMaterial(uniforms) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float aWing;
        attribute vec4 aFlap;   // x: flap rate (rad/s), y: phase, z: glide 0..1, w: fold 0..1`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float w = abs(aWing);
          if (w > 0.0) {
            float s = sin(uTime * aFlap.x + aFlap.y);
            // flapping: big stroke; gliding: wings held in a slight dihedral with a faint tremble
            float ang = mix(s * 0.95 + 0.15, 0.13 + s * 0.03, aFlap.z) * (0.65 + 0.6 * w);
            float sx = sign(aWing);
            float ax = abs(transformed.x);
            transformed.y += ax * sin(ang);
            transformed.x = sx * ax * cos(ang);
            // folded (perched): wings tucked along the body
            float f = aFlap.w;
            transformed.x *= mix(1.0, 0.18, f);
            transformed.y = mix(transformed.y, 0.03 + 0.02 * w, f);
            transformed.z -= f * w * 0.18;
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'golf-birds-v1';
  return mat;
}

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// Orientation from velocity + acceleration: face travel direction, roll so "up" leans into the
// turn (coordinated-turn bank = lift tilts toward the centripetal acceleration).
function poseMatrix(out, p, v, a, scale, bankK = 1.4, maxBank = 0.75) {
  _z.copy(v);
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
  _z.normalize();
  // centripetal (horizontal, ⟂ forward) part of the acceleration
  const al = a.dot(_z);
  _y.copy(a).addScaledVector(_z, -al); _y.y = 0;
  const lat = _y.length(), lim = G * Math.tan(maxBank) / bankK;
  if (lat > lim) _y.multiplyScalar(lim / lat);
  _y.multiplyScalar(bankK); _y.y += G;
  _x.crossVectors(_y, _z).normalize();
  _y.crossVectors(_z, _x).normalize();
  out.makeBasis(_x.multiplyScalar(scale), _y.multiplyScalar(scale), _z.multiplyScalar(scale));
  out.setPosition(p);
  return out;
}

export class Birds {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = { uTime: { value: 0 } };
    const mk = (geo, n) => {
      const flap = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      flap.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFlap', flap);
      const im = new THREE.InstancedMesh(geo, birdMaterial(this.uniforms), n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;   // instances roam far from the origin
      im.castShadow = false; im.receiveShadow = false;
      scene.add(im);
      return im;
    };
    this.skyMesh = mk(birdGeometry(1, 1.2), MAX_SKY);
    this.smallMesh = mk(birdGeometry(1.4, 0.6, 1.9), MAX_SMALL);
    this.flocks = []; this.sky = []; this.small = [];
    // ducks: paddle around ponds and drift along rivers (2x real size like the other birds)
    this.duckMesh = new THREE.InstancedMesh(duckGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), MAX_DUCKS);
    this.duckMesh.count = 0; this.duckMesh.frustumCulled = false;
    scene.add(this.duckMesh);
    this.ducks = [];
    this.t = 0;
  }

  build(seed, hole, trees, center) {
    const rand = this.rand = mulberry32(((seed >>> 0) ^ 0xb12d5) >>> 0);
    const U = (a, b) => a + (b - a) * rand();
    this.t = 0;
    this.hole = hole;
    const col = new THREE.Color();

    // ---- sky flocks: big lazy loops (ellipse + a harmonic) at 40–150 m over/around the hole
    const groundY = hole.height(center.x, center.z);
    this.flocks = []; this.sky = [];
    const nF = 4 + Math.floor(rand() * 2);   // (incl. the camera-following flock)
    for (let f = 0; f < nF; f++) {
      const R = U(45, 170);
      const fz = -30 + (hole.L + 60) * ((f + U(0.2, 0.8)) / nF);       // evenly along the hole
      const fl = {
        cx: hole.cx(Math.min(Math.max(fz, 0), hole.L)) + U(-60, 60), cz: fz,
        rx: R, rz: R * U(0.5, 1.1), rot: U(0, TAU), th0: U(0, TAU),
        dir: rand() < 0.5 ? -1 : 1, w: U(9, 14) / R,          // ~9–14 m/s ground speed
        h2: U(0.05, 0.2), ph2: U(0, TAU),
        y: groundY + U(22, 75), dy: U(3, 10), phy: U(0, TAU),
        v: rand() < 0.5,                                      // V formation, else loose cluster
        n: 5 + Math.floor(rand() * 5),
      };
      fl.dark = rand() < 0.5 ? 0x1d1d22 : 0x3b3d44;           // crows vs. darker gulls
      if (f === 0) {   // one flock loosely shadows the player so birds are always around
        Object.assign(fl, { follow: true, rx: U(25, 35), rz: U(18, 28), w: U(9, 12) / 30, dyAbove: U(7, 13), n: 7 + Math.floor(rand() * 3) });
      }
      this.flocks.push(fl);
      for (let i = 0; i < fl.n; i++) {
        let ox, oz, oy = U(-1.5, 1.5);
        if (fl.v) { const r = Math.ceil(i / 2), s = i % 2 ? 1 : -1; ox = s * r * U(4, 5.5); oz = -r * U(3.5, 5); }
        else { ox = U(-16, 16); oz = U(-16, 16); oy = U(-6, 6); }
        const b = {
          fl, ox, oy, oz, span: U(2.6, 3.4),
          wob: [U(0.2, 0.5), U(0, TAU), U(0.2, 0.5), U(0, TAU), U(0.4, 1.0)],
          rate: TAU * U(2.4, 3.6), phase: U(0, TAU), glide: rand() < 0.3 ? 1 : 0, glideT: U(1, 6), glideTarget: 0,
        };
        b.glideTarget = b.glide;
        col.set(fl.dark).multiplyScalar(U(0.85, 1.15));
        this.skyMesh.setColorAt(this.sky.length, col);
        this.sky.push(b);
      }
    }
    this.skyMesh.count = this.sky.length;

    // ---- songbirds: perch on crowns near the fairway, hop between trees 10–60 m apart
    // perch on the front rows of trees lining the fairway (that's where the camera looks)
    const edge = hole.fw.w + hole.roughW + 16;
    const near = trees.filter(t => {
      const zc = Math.min(Math.max(t.z, 0), hole.L);
      return t.z > -40 && t.z < hole.L + 60 && Math.abs(hole.lat(t.x, zc)) < edge;
    });
    this.perches = near.length ? near : trees.slice(0, 50);
    const P = this.perches;
    this.nbrs = P.map((t, i) => {
      const out = [];
      for (let j = 0; j < P.length; j++) {
        if (j === i) continue;
        const d = Math.hypot(P[j].x - t.x, P[j].z - t.z);
        if (d >= 10 && d <= 95) out.push(j);   // long hops cross the fairway
      }
      return out;
    });
    const tints = [0x8a5a2c, 0x3f6fd0, 0x2f8be0, 0xd8402a, 0xe8b22a, 0xf0f0f0, 0x6a3fa8];   // bright, readable against foliage
    this.small = [];
    const nS = P.length ? Math.min(MAX_SMALL, 45 + Math.floor(rand() * 13)) : 0;
    for (let i = 0; i < nS; i++) {
      const tree = Math.floor(rand() * P.length);
      const b = {
        span: U(0.75, 0.95), rate: TAU * U(8, 11), phase: U(0, TAU),
        state: 'perch', tree, p: this.perchPoint(P[tree]), yaw: U(0, TAU), timer: U(0.2, 6),
        hop: 0, hopT: U(0.5, 2), from: null, to: null, s: 0, dur: 1, arc: 1, und: 0, fold: 1,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(0, 0, 1), acc: new THREE.Vector3(),
      };
      col.set(tints[Math.floor(rand() * tints.length)]).multiplyScalar(U(0.85, 1.15));
      this.smallMesh.setColorAt(i, col);
      this.small.push(b);
    }
    this.smallMesh.count = this.small.length;
    this.buildDucks(hole, rand);
    for (const im of [this.skyMesh, this.smallMesh]) if (im.instanceColor) im.instanceColor.needsUpdate = true;
    this.update(0);
  }

  // a spot on the top of a crown: the tip of a pine, or on the upper cap of a round tree
  perchPoint(t) {
    const r = this.rand;
    if (t.crownTop !== undefined && (t.shape === 'cone' || t.type === 'pine')) {
      // the rendered pine (trees.js) ends in a small spike at ~1.03 of the crown height
      const base = t.crownBase || 0;
      return new THREE.Vector3(t.x, t.y0 + base + (t.crownTop - base) * 1.03 - 0.02, t.z);
    }
    const R = t.crownR || 3, Ry = t.crownRy || R, cy = t.crownY !== undefined ? t.crownY : (t.crownTop || 8) - Ry;
    const a = r() * TAU, rr = Math.sqrt(r()) * 0.45 * R, k = rr / R;
    return new THREE.Vector3(t.x + Math.cos(a) * rr, t.y0 + cy + Ry * Math.sqrt(Math.max(0, 1 - k * k)) - 0.1, t.z + Math.sin(a) * rr);
  }

  // ---- sky birds are a pure function of time (finite differences give velocity/acceleration)
  flockPos(fl, t, out) {
    const th = fl.th0 + fl.dir * fl.w * t;
    const k = 1 + fl.h2 * Math.sin(2 * th + fl.ph2);
    const ex = Math.cos(th) * fl.rx * k, ez = Math.sin(th) * fl.rz * k;
    const c = Math.cos(fl.rot), s = Math.sin(fl.rot);
    return out.set(fl.cx + ex * c - ez * s, fl.y + fl.dy * Math.sin(th * 2 + fl.phy), fl.cz + ex * s + ez * c);
  }

  skyBirdPos(b, t, out) {
    const fl = b.fl, e = 0.25;
    const p0 = this.flockPos(fl, t - e, _tmpA), p1 = this.flockPos(fl, t + e, _tmpB);
    let fx = p1.x - p0.x, fz = p1.z - p0.z; const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
    this.flockPos(fl, t, out);
    const w = b.wob;
    const wx = Math.sin(t * w[0] + w[1]) * 0.8, wy = Math.sin(t * w[4] + w[3]) * 0.5, wz = Math.sin(t * w[2] + w[3]) * 0.8;
    // offset in the flock frame (right = (fz, -fx) when forward = (fx, fz))
    const rx = b.ox + wx, rz = b.oz + wz;
    out.x += -fz * rx + fx * rz; out.z += fx * rx + fz * rz; out.y += b.oy + wy;
    return out;
  }

  update(dt, camera) {
    if (!this.hole) return;
    this.updateDucks(dt);
    if (camera) {
      this.cam = camera.position;
      { const e0 = camera.matrixWorld.elements, l = Math.hypot(e0[8], e0[10]) || 1; this.camFwd = { x: -e0[8] / l, z: -e0[10] / l }; }
      // drift the follow flock toward a point ~60 m ahead of the camera
      const e = camera.matrixWorld.elements, fx = -e[8], fz = -e[10], fl0 = Math.hypot(fx, fz) || 1;
      const tx = camera.position.x + fx / fl0 * 85, tz = camera.position.z + fz / fl0 * 85;
      const k = 1 - Math.exp(-dt / 6);
      for (const fl of this.flocks) if (fl.follow) {
        if (fl.cx === undefined || Math.hypot(fl.cx - tx, fl.cz - tz) > 400) { fl.cx = tx; fl.cz = tz; }
        fl.cx += (tx - fl.cx) * k; fl.cz += (tz - fl.cz) * k;
        fl.y = this.hole.height(fl.cx, fl.cz) + fl.dyAbove + (fl.y0off || 0);
      }
    }
    // tree-bird state machine in small substeps (advanceVisuals may pass several seconds)
    let left = dt;
    while (left > 1e-9) { const h = Math.min(left, 1 / 30); this.stepSmall(h); this.stepGlide(h); left -= h; }
    if (dt === 0) this.stepSmall(0);
    this.t += dt;
    this.uniforms.uTime.value = this.t;

    // sky birds
    const t = this.t, e = 0.08, flap = this.skyMesh.geometry.attributes.aFlap;
    this.sky.forEach((b, i) => {
      const pm = this.skyBirdPos(b, t - e, _pm), p = this.skyBirdPos(b, t, _p), pp = this.skyBirdPos(b, t + e, _pp);
      _v.subVectors(pp, pm).multiplyScalar(1 / (2 * e));
      _a.copy(pp).add(pm).addScaledVector(p, -2).multiplyScalar(1 / (e * e));
      this.skyMesh.setMatrixAt(i, poseMatrix(_m, p, _v, _a, b.span, 1.6));
      flap.setXYZW(i, b.rate, b.phase, b.glide, 0);
    });
    flap.needsUpdate = true;
    this.skyMesh.instanceMatrix.needsUpdate = true;

    const sf = this.smallMesh.geometry.attributes.aFlap;
    this.small.forEach((b, i) => {
      if (b.state === 'perch') {
        _v.set(Math.sin(b.yaw), 0, Math.cos(b.yaw)); _a.set(0, 0, 0);
        _p.copy(b.p); _p.y += Math.sin(Math.PI * Math.min(1, b.hop / 0.22)) * 0.07 * (b.hop > 0 ? 1 : 0) + b.span * 0.1;
        this.smallMesh.setMatrixAt(i, poseMatrix(_m, _p, _v, _a, b.span));
      } else this.smallMesh.setMatrixAt(i, poseMatrix(_m, b.pos, b.vel, b.acc, b.span, 0.8, 0.5));
      sf.setXYZW(i, b.rate, b.phase, 0, b.fold);
    });
    sf.needsUpdate = true;
    this.smallMesh.instanceMatrix.needsUpdate = true;
  }

  buildDucks(hole, rand) {
    const U = (a, b) => a + (b - a) * rand();
    this.ducks = [];
    const water = [];
    for (const p of hole.ponds) water.push({ kind: 'pond', p });
    for (const r of hole.rivers) water.push({ kind: 'river', r });
    for (const w of water) {
      if (this.ducks.length >= MAX_DUCKS - 6 || rand() < 0.2) continue;
      const n = 3 + Math.floor(rand() * 4);
      let cx, cz, level;
      if (w.kind === 'pond') {
        const p = w.p;
        let ok = false;
        for (let k = 0; k < 40 && !ok; k++) { cx = p.x + U(-1, 1) * p._bound * 0.7; cz = p.z + U(-1, 1) * p._bound * 0.7; ok = pondDist(p, cx, cz) < -3; }
        if (!ok) continue;
        level = p.level;
      } else {
        const i = 4 + Math.floor(rand() * (w.r.pts.length - 8));
        [cx, cz] = w.r.pts[i]; level = w.r.levels[i];
      }
      const drake = rand();
      for (let j = 0; j < n; j++) {
        this.ducks.push({
          w, x: cx + U(-2, 2), z: cz + U(-2, 2), level, yaw: U(0, Math.PI * 2), speed: U(0.25, 0.5),
          turn: 0, turnT: U(1, 4), bob: U(0, 6.28), s: U(0.85, 1.1),
          drake: (j + drake * 3) % 2 < 1, ri: w.kind === 'river' ? null : null,
        });
      }
    }
    // colors: drakes = green head / grey body, hens = brown
    const col = new THREE.Color();
    this.ducks.forEach((d, i) => { col.setRGB(1, 1, 1); this.duckMesh.setColorAt(i, d.drake ? col.setRGB(1, 1, 1) : col.setRGB(0.62, 0.48, 0.32)); });
    this.duckMesh.count = this.ducks.length;
    if (this.duckMesh.instanceColor) this.duckMesh.instanceColor.needsUpdate = true;
  }

  /** Wander inside the water: steer away when the next position gets near the shore. */
  updateDucks(dt) {
    const hole = this.hole, M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const inWater = (d, x, z) => {
      if (d.w.kind === 'pond') return pondDist(d.w.p, x, z) < -1.2;
      const rv = hole.riverAt(x, z); if (!rv) return false;
      d.level = rv.level; return rv.d < rv.half - 1;
    };
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(left, 1 / 20); left -= h;
      for (const d of this.ducks) {
        d.turnT -= h;
        if (d.turnT <= 0) { d.turn = (this.rand() - 0.5) * 0.8; d.turnT = 1 + this.rand() * 4; }
        d.yaw += d.turn * h;
        const nx = d.x + Math.sin(d.yaw) * d.speed * h * 6, nz = d.z + Math.cos(d.yaw) * d.speed * h * 6;   // look ahead
        if (!inWater(d, nx, nz)) { d.yaw += 2.2 * h * (d.turn >= 0 ? 1 : -1) + 0.6 * h; continue; }   // turn away from the bank
        d.x += Math.sin(d.yaw) * d.speed * h; d.z += Math.cos(d.yaw) * d.speed * h;
      }
    }
    this.ducks.forEach((d, i) => {
      Q.setFromAxisAngle(up, d.yaw);
      P.set(d.x, d.level + 0.02 + Math.sin(this.t * 2.1 + d.bob) * 0.025, d.z);
      S.setScalar(d.s);
      this.duckMesh.setMatrixAt(i, M.compose(P, Q, S));
    });
    this.duckMesh.instanceMatrix.needsUpdate = true;
    if (this.ducks.length) this.duckMesh.computeBoundingSphere();
  }

  stepGlide(h) {
    for (const b of this.sky) {
      b.glideT -= h;
      if (b.glideT <= 0) {
        b.glideTarget = this.rand() < 0.35 ? 1 : 0;
        b.glideT = b.glideTarget ? 2 + this.rand() * 5 : 3 + this.rand() * 8;
      }
      b.glide += Math.max(-h * 2.5, Math.min(h * 2.5, b.glideTarget - b.glide));
    }
  }

  flightPos(b, s, out) {
    const e = s * s * (3 - 2 * s) * 0.6 + s * 0.4;   // gentle take-off / landing
    out.lerpVectors(b.from, b.to, e);
    out.y += b.arc * 4 * s * (1 - s) + b.und * Math.sin(TAU * b.nUnd * s) * Math.sin(Math.PI * s);
    return out;
  }

  stepSmall(h) {
    const r = this.rand, P = this.perches;
    for (const b of this.small) {
      if (b.state === 'perch') {
        b.timer -= h;
        b.fold = Math.min(1, b.fold + h * 6);
        if (b.hop > 0) { b.hop += h; if (b.hop > 0.22) b.hop = 0; }
        b.hopT -= h;
        if (b.hopT <= 0) { b.hopT = 0.6 + r() * 2.2; if (r() < 0.5) { b.hop = 1e-4; b.yaw += (r() - 0.5) * 2.4; } else b.yaw += (r() - 0.5) * 0.8; }
        if (b.timer <= 0) {
          const nb = this.nbrs[b.tree];
          let next = nb.length ? nb[Math.floor(r() * nb.length)] : Math.floor(r() * P.length);
          // birds far from the camera fly toward it (so the player always has some around)
          // and birds behind the camera move to trees in front of it, where they can be seen
          if (this.cam) {
            const F = this.camFwd || { x: 0, z: 1 };
            const ahead = (q, lo, hi) => { const dx = q.x - this.cam.x, dz = q.z - this.cam.z, d = Math.hypot(dx, dz); return d > lo && d < hi && (dx * F.x + dz * F.z) > 0.5 * d; };
            if (!ahead(b.p, 0, 140) && r() < 0.85) {
              for (let k = 0; k < 20; k++) { const c = Math.floor(r() * P.length); if (ahead(P[c], 20, 110)) { next = c; break; } }
            }
          }
          b.from = b.p.clone(); b.to = this.perchPoint(P[next]); b.tree = next;
          const D = b.from.distanceTo(b.to);
          b.dur = Math.max(0.8, D / (7 + r() * 4 + D * 0.04));
          b.arc = 1 + D * (0.08 + r() * 0.1);
          b.und = 0.25 + r() * 0.35; b.nUnd = Math.max(1, Math.round(D / 7));
          b.s = 0; b.state = 'fly';
          this.flightPos(b, 0, b.pos);
        }
      } else {
        b.fold = Math.max(0, b.fold - h * 8);
        b.s += h / b.dur;
        if (b.s >= 1) {
          b.state = 'perch'; b.p = b.to; b.timer = 1.2 + r() * 3; b.hopT = 0.4 + r();
          _v.subVectors(b.to, b.from); b.yaw = Math.atan2(_v.x, _v.z);
          continue;
        }
        const ds = 0.02;
        const pm = this.flightPos(b, Math.max(0, b.s - ds), _pm), pp = this.flightPos(b, Math.min(1, b.s + ds), _pp);
        this.flightPos(b, b.s, b.pos);
        const dts = ds * b.dur;
        b.vel.subVectors(pp, pm).multiplyScalar(1 / (2 * dts));
        b.acc.copy(pp).add(pm).addScaledVector(b.pos, -2).multiplyScalar(1 / (dts * dts));
        // don't pitch steeply with the undulation: keep the body mostly level
        b.vel.y *= 0.4;
      }
    }
  }
}

const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();
const _p = new THREE.Vector3(), _pm = new THREE.Vector3(), _pp = new THREE.Vector3();
const _v = new THREE.Vector3(), _a = new THREE.Vector3();
