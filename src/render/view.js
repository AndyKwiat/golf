// three.js view. Reads Game state, never writes it. Everything visual (camera smoothing, flag
// waving, ball sink animation) lives here so the sim stays deterministic.
import * as THREE from 'three';
import { WORLD_SIZE, BALL_R, CUP_R, FRINGE_WIDTH, ROUGH_WIDTH, MAX_FLAT_DIST } from '../sim/constants.js';
import { mulberry32 } from '../sim/rng.js';

const GRID_SEGS = 400;     // terrain mesh resolution (WORLD_SIZE / GRID_SEGS m per quad)
const TEX_SIZE = 2048;     // surface color texture resolution
// Readability exaggerations (deliberately unrealistic so hills are obvious without the grid):
const NORMAL_EXAGGERATION = 2.2;  // mesh normals are computed as if hills were this much steeper
const SHADE_EXAGGERATION = 4.5;   // baked hillshade in the texture uses this slope multiplier
const CONTOUR_STEP = 0.15;        // faint height contour line every N meters

export class View {
  constructor(canvas, game) {
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fd3f5);
    this.scene.fog = new THREE.Fog(0x9fd3f5, 45, 110);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 400);
    this.camMode = 'auto';   // 'auto' | 'overhead'
    this.zoom = 1;
    this.showGrid = true;
    this.camPos = new THREE.Vector3(0, 10, 10);
    this.camLook = new THREE.Vector3();

    const hemi = new THREE.HemisphereLight(0xdff2ff, 0x3a5a2a, 0.55);
    this.scene.add(hemi);
    // Cool fill light from the opposite side so slopes facing away from the sun read as bluish.
    const fill = new THREE.DirectionalLight(0x9cc2ff, 0.9);
    fill.position.set(-10, 6, -8);
    this.scene.add(fill);
    // Low, warm raking sun: strong light/dark contrast between opposing slopes.
    this.sun = new THREE.DirectionalLight(0xffeccc, 2.9);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -4; sc.right = 4; sc.top = 4; sc.bottom = -4; sc.near = 1; sc.far = 60;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    // Ball
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    // A soft halo ring so the ball is findable from far away / overhead
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.08, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.halo.rotation.x = -Math.PI / 2;
    this.scene.add(this.halo);

    // Aim ribbon (normal mode) and preview ribbon (cheat mode)
    this.aimMesh = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    this.previewMesh = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.endMarker = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.11, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, depthWrite: false, side: THREE.DoubleSide }));
    this.scene.add(this.aimMesh, this.previewMesh, this.endMarker);

    this.greenGroup = new THREE.Group();
    this.scene.add(this.greenGroup);
    this.time = 0;
    this.sinkT = 0;
    this.buildGreen();
  }

  // ------------------------------------------------------------------ green building
  buildGreen() {
    const g = this.game, t = g.terrain;
    for (const c of [...this.greenGroup.children]) {
      this.greenGroup.remove(c);
      c.traverse(o => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    }
    this.builtSeed = g.seed;
    this.builtTerrain = t;

    // Terrain mesh: explicit grid so world x/z map directly to vertex x/z.
    const N = GRID_SEGS, W = WORLD_SIZE;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const uv = new Float32Array((N + 1) * (N + 1) * 2);
    for (let j = 0, k = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++, k++) {
        const x = -W / 2 + (i / N) * W, z = -W / 2 + (j / N) * W;
        pos[k * 3] = x; pos[k * 3 + 1] = t.height(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = i / N; uv[k * 2 + 1] = j / N;
      }
    }
    const idx = new Uint32Array(N * N * 6);
    for (let j = 0, k = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    // Height field on the vertex grid: gradient + laplacian are reused for normals and texture.
    const NV = N + 1, step = W / N;
    const H = new Float64Array(NV * NV), GX = new Float64Array(NV * NV), GZ = new Float64Array(NV * NV), LAP = new Float64Array(NV * NV);
    for (let k = 0; k < NV * NV; k++) H[k] = pos[k * 3 + 1];
    const at = (i, j) => H[Math.min(N, Math.max(0, j)) * NV + Math.min(N, Math.max(0, i))];
    const nrm = new Float32Array(NV * NV * 3);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const k = j * NV + i;
        const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), gz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
        GX[k] = gx; GZ[k] = gz;
        LAP[k] = (at(i + 2, j) + at(i - 2, j) + at(i, j + 2) + at(i, j - 2) - 4 * H[k]) / (4 * step * step);
        const nx = -gx * NORMAL_EXAGGERATION, nz = -gz * NORMAL_EXAGGERATION, L = Math.sqrt(nx * nx + 1 + nz * nz);
        nrm[k * 3] = nx / L; nrm[k * 3 + 1] = 1 / L; nrm[k * 3 + 2] = nz / L;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const [plain, grid] = this.makeSurfaceTextures(t, { H, GX, GZ, LAP, N });
    this.texPlain = plain; this.texGrid = grid;
    this.terrainMat = new THREE.MeshStandardMaterial({ map: this.showGrid ? grid : plain, roughness: 0.95 });
    this.terrainMesh = new THREE.Mesh(geo, this.terrainMat);
    this.terrainMesh.receiveShadow = true;
    this.greenGroup.add(this.terrainMesh);

    // Cup: dark disc conformed to the surface + white liner ring
    const hole = t.hole;
    const cup = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 40), new THREE.MeshBasicMaterial({ color: 0x0b0f08 }));
    const liner = new THREE.Mesh(new THREE.RingGeometry(CUP_R, CUP_R + 0.006, 40), new THREE.MeshBasicMaterial({ color: 0xf0f0f0 }));
    for (const m of [cup, liner]) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + hole.x, z = -p.getY(i) + hole.z; // circle lies in XY; map to XZ
        p.setXYZ(i, x, t.height(x, z) + 0.003, z);
      }
      m.geometry.computeVertexNormals();
      m.material.side = THREE.DoubleSide;
      this.greenGroup.add(m);
    }

    // Pin + flag
    const hy = t.height(hole.x, hole.z);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 2.1, 8), new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }));
    pin.position.set(hole.x, hy + 1.05, hole.z);
    pin.castShadow = true;
    const flagGeo = new THREE.PlaneGeometry(0.6, 0.4, 10, 4);
    flagGeo.translate(0.3, 0, 0);
    this.flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xe53935, emissive: 0x7a1010, side: THREE.DoubleSide }));
    this.flag.position.set(hole.x, hy + 1.88, hole.z);
    this.flagBase = flagGeo.attributes.position.array.slice();
    this.greenGroup.add(pin, this.flag);

    // Scenery: a ring of simple trees (render-only randomness, seeded so screenshots are stable)
    const rand = mulberry32((g.seed ^ 0x5eed) >>> 0);
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 1.6, 6);
    const crownGeo = new THREE.ConeGeometry(1.6, 4.5, 8);
    const nTrees = 70;
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b3a1e }), nTrees);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 1 }), nTrees);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < nTrees; i++) {
      const ang = rand() * Math.PI * 2;
      const r = t.greenRadius(ang) + FRINGE_WIDTH + ROUGH_WIDTH + 3 + rand() * 18;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (Math.abs(x) > W / 2 - 2 || Math.abs(z) > W / 2 - 2) { i--; continue; }
      const y = t.height(x, z), sc = 0.8 + rand() * 0.8;
      s.set(sc, sc, sc);
      m4.compose(new THREE.Vector3(x, y + 0.8 * sc, z), q, s); trunks.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(x, y + (1.6 + 2.25) * sc, z), q, s); crowns.setMatrixAt(i, m4);
    }
    crowns.castShadow = true;
    this.greenGroup.add(trunks, crowns);

    // Slope dots: one per grid cell, drifting downhill at a speed proportional to the slope.
    const dots = [];
    for (let x = Math.floor(-t.R0 * 1.4); x <= t.R0 * 1.4; x++) {
      for (let z = Math.floor(-t.R0 * 1.4); z <= t.R0 * 1.4; z++) {
        const cx = x + 0.5, cz = z + 0.5;
        if (t.edgeDist(cx, cz) > -0.3) continue;
        const [gx, gz] = t.grad(cx, cz), sl = Math.hypot(gx, gz);
        dots.push({ x: cx, z: cz, dx: sl > 1e-6 ? -gx / sl : 0, dz: sl > 1e-6 ? -gz / sl : 0, sl, ph: hash2(x + 999, z + 999) });
      }
    }
    this.dots = dots;
    this.dotMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.045, 10).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }), dots.length);
    this.dotMesh.frustumCulled = false;
    this.dotMesh.visible = this.showGrid;
    this.greenGroup.add(this.dotMesh);
    this.snap = true;
  }

  makeSurfaceTextures(t, field) {
    const S = TEX_SIZE, W = WORLD_SIZE;
    const { H, GX, GZ, LAP, N } = field, NV = N + 1;
    // green height range for the height tint
    let hmin = Infinity, hmax = -Infinity;
    for (let j = 0; j <= N; j += 2) for (let i = 0; i <= N; i += 2) {
      const x = -W / 2 + (i / N) * W, z = -W / 2 + (j / N) * W;
      if (t.edgeDist(x, z) <= 0) { const h = H[j * NV + i]; hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
    }
    const hspan = Math.max(0.2, hmax - hmin);
    const Lx = -0.62, Ly = 0.5, Lz = -0.6, Ll = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz); // baked light direction
    const lx = Lx / Ll, ly = Ly / Ll, lz = Lz / Ll;
    const bil = (A, k, fx, fz) => A[k] * (1 - fx) * (1 - fz) + A[k + 1] * fx * (1 - fz) + A[k + NV] * (1 - fx) * fz + A[k + NV + 1] * fx * fz;
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
    const c1 = mk(), c2 = mk();
    const ctx1 = c1.getContext('2d'), ctx2 = c2.getContext('2d');
    const img1 = ctx1.createImageData(S, S), img2 = ctx2.createImageData(S, S);
    const a = img1.data, b = img2.data;
    const px = W / S;
    for (let j = 0; j < S; j++) {
      const z = -W / 2 + (j + 0.5) * px;
      for (let i = 0; i < S; i++) {
        const x = -W / 2 + (i + 0.5) * px;
        const d = t.edgeDist(x, z);
        const n = hash2(i, j) * 0.06 - 0.03;
        // sample the height field (bilinear on the vertex grid)
        const fu = (x + W / 2) / W * N, fv = (z + W / 2) / W * N;
        const iu = Math.min(N - 1, Math.floor(fu)), iv = Math.min(N - 1, Math.floor(fv)), k0 = iv * NV + iu;
        const h = bil(H, k0, fu - iu, fv - iv), gx = bil(GX, k0, fu - iu, fv - iv), gz = bil(GZ, k0, fu - iu, fv - iv);
        const lap = bil(LAP, k0, fu - iu, fv - iv);
        // exaggerated hillshade: lit slopes brighter, slopes facing away darker
        const ex = -gx * SHADE_EXAGGERATION, ez = -gz * SHADE_EXAGGERATION, el = Math.sqrt(ex * ex + 1 + ez * ez);
        const shade = (ex * lx + ly + ez * lz) / el - ly;
        // valleys (lap > 0) slightly darker, ridges slightly lighter
        const curv = Math.min(1.14, Math.max(0.84, 1 - lap * 1.6));
        // medium-scale mottling so the surface has texture
        const mott = valueNoise(x * 1.7, z * 1.7) * 0.07 + valueNoise(x * 6, z * 6) * 0.04 - 0.055;
        let r, gg, bb, shadeAmt;
        if (d <= 0) {
          const stripe = (Math.floor((x * 0.8 + z * 0.6) / 1.6) & 1) ? 0.035 : -0.035;
          const k = 1 + stripe + n * 0.5 + mott;
          const hn = Math.min(1, Math.max(0, (h - hmin) / hspan)); // low = deeper/bluer, high = lighter/yellower
          r = (0.15 + 0.29 * hn) * k; gg = (0.50 + 0.26 * hn) * k; bb = (0.36 - 0.16 * hn) * k;
          shadeAmt = 1.9;
        } else if (d <= FRINGE_WIDTH) {
          const k = 1 + n + mott;
          r = 0.22 * k; gg = 0.52 * k; bb = 0.20 * k;
          shadeAmt = 1.3;
        } else {
          const k = 1 + n * 2.5 + mott * 1.8 + 0.08 * Math.sin(x * 0.7) * Math.sin(z * 0.6);
          r = 0.19 * k; gg = 0.42 * k; bb = 0.15 * k;
          shadeAmt = 1.0;
        }
        const m = Math.min(1.6, Math.max(0.4, 1 + shadeAmt * shade)) * curv;
        r *= m; gg *= m; bb *= m;
        // faint height contours (constant on-screen width in meters regardless of slope)
        let contour = 0;
        if (d <= FRINGE_WIDTH) {
          const f = h / CONTOUR_STEP, g = Math.sqrt(gx * gx + gz * gz);
          const dm = Math.abs(f - Math.round(f)) * CONTOUR_STEP / Math.max(g, 1e-4);
          if (dm < 0.055) contour = 1 - (dm / 0.055) ** 2;
        }
        if (contour) { const c = 1 - 0.12 * contour; r *= c; gg *= c; bb *= c; }
        // soft dark edge line at the green boundary
        if (Math.abs(d) < 0.06) { r *= 0.85; gg *= 0.85; bb *= 0.85; }
        const o = (j * S + i) * 4;
        a[o] = b[o] = clamp255(r); a[o + 1] = b[o + 1] = clamp255(gg); a[o + 2] = b[o + 2] = clamp255(bb);
        a[o + 3] = b[o + 3] = 255;
        // 1 m grid over the green (Mario-Golf style slope reading)
        if (d <= FRINGE_WIDTH * 0.5) {
          const fx = Math.abs(x - Math.round(x)), fz = Math.abs(z - Math.round(z));
          if (fx < px * 0.55 || fz < px * 0.55) {
            b[o] = clamp255(r * 0.72 + 0.26); b[o + 1] = clamp255(gg * 0.72 + 0.26); b[o + 2] = clamp255(bb * 0.72 + 0.26);
          }
        }
      }
    }
    ctx1.putImageData(img1, 0, 0); ctx2.putImageData(img2, 0, 0);
    return [c1, c2].map(c => {
      const tex = new THREE.CanvasTexture(c);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      return tex;
    });
  }

  setGrid(on) {
    this.showGrid = on;
    this.terrainMat.map = on ? this.texGrid : this.texPlain;
    this.terrainMat.needsUpdate = true;
    if (this.dotMesh) this.dotMesh.visible = on;
  }

  updateDots() {
    if (!this.dotMesh?.visible) return;
    const t = this.game.terrain, m4 = new THREE.Matrix4();
    const big = this.camMode === 'overhead' ? 2.2 : 1;
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i];
      const ph = (d.ph + this.time * Math.min(d.sl, 0.15) * 10) % 1;   // 0.3 cells/s at 3%, capped at 1.5
      const x = d.x + d.dx * (ph - 0.5), z = d.z + d.dz * (ph - 0.5);
      const sc = big * Math.sin(Math.PI * ph) * Math.min(1, 0.35 + d.sl * 25);
      m4.makeScale(sc, 1, sc).setPosition(x, t.height(x, z) + 0.01, z);
      this.dotMesh.setMatrixAt(i, m4);
    }
    this.dotMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ ribbons
  /** Build a flat ribbon draped on the terrain through points [{x,z}]. */
  ribbon(mesh, pts, width, lift = 0.012) {
    const t = this.game.terrain;
    if (pts.length < 2) { mesh.visible = false; return; }
    const pos = new Float32Array(pts.length * 2 * 3);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      let dx = q.x - o.x, dz = q.z - o.z;
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = -dz * width / 2, nz = dx * width / 2;
      const y = t.height(p.x, p.z) + lift;
      pos.set([p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz], i * 6);
    }
    const idx = [];
    for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    mesh.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    mesh.geometry = geo;
    mesh.visible = true;
  }

  /** Called by the app whenever the cheat preview changes. pathResult = game.preview(...) or null */
  setPreview(pathResult) {
    if (!pathResult) { this.previewMesh.visible = false; this.endMarker.visible = false; return; }
    const pts = pathResult.path.filter((_, i, arr) => i % 2 === 0 || i === arr.length - 1);
    this.ribbon(this.previewMesh, pts, this.camMode === 'overhead' ? 0.12 : 0.035);
    const e = pathResult.end, t = this.game.terrain;
    this.endMarker.position.set(e.x, t.height(e.x, e.z) + 0.015, e.z);
    this.endMarker.rotation.set(-Math.PI / 2, 0, 0);
    const holed = pathResult.result === 'holed';
    this.previewMesh.material.color.set(holed ? 0x5cff7a : 0xffe14d);
    this.endMarker.material.color.set(holed ? 0x5cff7a : 0xffe14d);
    this.endMarker.visible = true;
  }

  // ------------------------------------------------------------------ per-frame
  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Render one frame. alpha in [0,1] interpolates the ball between the previous and current tick.
   * dtReal is wall-clock seconds since last frame (only used for smoothing/animation).
   * Pass snap=true (or set this.snap) for an unsmoothed, reproducible camera (screenshots).
   */
  render(alpha = 1, dtReal = 1 / 60, snap = false) {
    const g = this.game, t = g.terrain;
    if (g.seed !== this.builtSeed || t !== this.builtTerrain) this.buildGreen();
    snap = snap || this.snap; this.snap = false;
    this.time += dtReal;

    // Ball position (interpolated)
    const bx = g.prevBall.x + (g.ball.x - g.prevBall.x) * alpha;
    const bz = g.prevBall.z + (g.ball.z - g.prevBall.z) * alpha;
    let by = t.height(bx, bz) + BALL_R;
    if (g.phase === 'holed') { this.sinkT = Math.min(1, this.sinkT + dtReal * 3); by -= this.sinkT * 0.08; }
    else this.sinkT = 0;
    this.ball.position.set(bx, by, bz);
    this.halo.position.set(bx, t.height(bx, bz) + 0.004, bz);
    this.halo.visible = g.phase !== 'holed';
    const overhead = this.camMode === 'overhead';
    this.ball.scale.setScalar(overhead ? 3 : 1);
    this.halo.scale.setScalar(overhead ? 3 : 1);

    // Aim ribbon in normal mode while aiming / swinging
    const aiming = g.phase === 'aim' || g.phase === 'swing';
    if (aiming && g.mode === 'normal') {
      const pts = [];
      for (let s = 0.08; s <= 3.0; s += 0.1) pts.push({ x: g.ball.x + Math.cos(g.aim) * s, z: g.ball.z + Math.sin(g.aim) * s });
      this.ribbon(this.aimMesh, pts, 0.02);
    } else this.aimMesh.visible = false;
    if (!(aiming && g.mode === 'cheat')) { this.previewMesh.visible = false; this.endMarker.visible = false; }

    // Flag waving (visual only)
    const fp = this.flag.geometry.attributes.position;
    for (let i = 0; i < fp.count; i++) {
      const x0 = this.flagBase[i * 3];
      fp.setZ(i, Math.sin(x0 * 6 - this.time * 4) * 0.04 * x0);
    }
    fp.needsUpdate = true;
    this.updateDots();

    this.updateCamera(bx, by, bz, dtReal, snap);

    // Keep the tight shadow frustum on the ball
    this.sun.position.set(bx + 12, by + 6, bz + 5);
    this.sun.target.position.set(bx, by, bz);

    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(bx, by, bz, dtReal, snap) {
    const g = this.game, t = g.terrain;
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    if (this.camMode === 'overhead') {
      const hx = t.hole.x, hz = t.hole.z;
      const mx = bx * 0.55 + hx * 0.45, mz = bz * 0.55 + hz * 0.45;
      const d = Math.hypot(hx - bx, hz - bz);
      const hgt = (Math.max(6, d * 1.7) + 4) * this.zoom;
      // look straight down with the aim direction pointing "up" the screen
      const ax = Math.cos(g.aim), az = Math.sin(g.aim);
      pos.set(mx - ax * 0.01, t.height(mx, mz) + hgt, mz - az * 0.01);
      look.set(mx, t.height(mx, mz), mz);
    } else if (g.phase === 'rolling') {
      let vx = g.ball.vx, vz = g.ball.vz;
      const sp = Math.hypot(vx, vz);
      if (sp < 1e-3) { vx = Math.cos(g.aim); vz = Math.sin(g.aim); } else { vx /= sp; vz /= sp; }
      const back = 3.2 * this.zoom, up = 1.6 * this.zoom;
      pos.set(bx - vx * back, 0, bz - vz * back);
      pos.y = Math.max(t.height(pos.x, pos.z) + 0.4, by + up);
      look.set(bx + vx * 2, by, bz + vz * 2);
    } else {
      // behind the ball along the aim line, looking toward the target
      const ax = Math.cos(g.aim), az = Math.sin(g.aim);
      const back = 2.6 * this.zoom, up = 1.15 * this.zoom;
      pos.set(bx - ax * back, 0, bz - az * back);
      pos.y = Math.max(t.height(pos.x, pos.z) + 0.3, by + up);
      const ahead = 7;
      const lx = bx + ax * ahead, lz = bz + az * ahead;
      look.set(lx, t.height(lx, lz), lz);
    }
    if (snap) { this.camPos.copy(pos); this.camLook.copy(look); }
    else {
      const k = 1 - Math.exp(-dtReal * (g.phase === 'rolling' ? 4 : 8));
      this.camPos.lerp(pos, k); this.camLook.lerp(look, k);
    }
    this.camera.position.copy(this.camPos);
    if (this.camMode === 'overhead') {
      this.camera.up.set(Math.cos(g.aim), 0, Math.sin(g.aim));
    } else this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
  }

  /** Raycast a canvas-normalized point (-1..1) to the terrain. Returns {x,z} or null. */
  pick(nx, ny) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hit = rc.intersectObject(this.terrainMesh, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }
}

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v * 255))); }
function valueNoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export { MAX_FLAT_DIST };
