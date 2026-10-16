// three.js view for the full-hole game. Reads GolfGame state, never mutates it.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { BALL_R, CUP_R, FRINGE_WIDTH } from '../sim/constants.js';
import { blobDist } from '../sim/hole.js';
import { mulberry32 } from '../../sim/rng.js';
import { Sky, SUN_DIR, HORIZON, radialTexture } from './sky.js';

// Readability exaggerations (deliberately unrealistic so terrain shape is obvious)
const NORMAL_EXAGGERATION = 1.4;
const SHADE_MAIN = 3.0, SHADE_GREEN = 4.5;
const CONTOUR_STEP = 0.15;

export class GolfView {
  constructor(canvas, game) {
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = HORIZON.clone();
    this.fog = new THREE.Fog(HORIZON.clone(), 350, 2600);
    this.scene.fog = this.fog;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 9000);
    this.camMode = 'auto';   // 'auto' | 'overhead'
    this.zoom = 1;
    this.showGrid = true;
    this.camPos = new THREE.Vector3(0, 5, -10);
    this.camLook = new THREE.Vector3(0, 0, 50);
    this.time = 0;
    this.sinkT = 0;
    this.lineMats = [];

    this.sky = new Sky(this.scene);

    this.scene.add(new THREE.HemisphereLight(0xe8f6ff, 0x4a7a35, 1.15));
    const fill = new THREE.DirectionalLight(0xbcd6ff, 0.75);
    fill.position.set(-SUN_DIR.x, 0.5, -SUN_DIR.z);
    this.scene.add(fill);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 300;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    // Ball + halo
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
    this.ball.castShadow = true;
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.085, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthWrite: false }));
    this.halo.rotation.x = -Math.PI / 2;
    this.scene.add(this.ball, this.halo);

    // Lines: preview (cheat), tracer (flight trail), aim guide (normal mode)
    this.previewLine = this.makeLine(0xffffff, 4, true);
    this.tracerLine = this.makeLine(0xffffff, 3, false, 0.85);
    this.aimLine = this.makeLine(0xffffff, 3, false, 0.8);
    const ringGeo = new THREE.RingGeometry(0.7, 1, 40).rotateX(-Math.PI / 2);
    this.landMarker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffe14d, depthWrite: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    this.endMarker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    this.targetMarker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    this.scene.add(this.landMarker, this.endMarker, this.targetMarker);

    // Floating pin marker visible from far away
    this.pinMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(), sizeAttenuation: false, depthTest: false, transparent: true }));
    this.pinMarker.scale.set(0.035, 0.05, 1);
    this.pinMarker.renderOrder = 10;
    this.scene.add(this.pinMarker);

    this.holeGroup = new THREE.Group();
    this.scene.add(this.holeGroup);
    this.buildHole();
  }

  makeLine(color, width, vertexColors, opacity = 1) {
    const mat = new LineMaterial({ color, linewidth: width, vertexColors, transparent: true, opacity, depthTest: true, worldUnits: false });
    this.lineMats.push(mat);
    const line = new Line2(new LineGeometry(), mat);
    line.visible = false;
    line.frustumCulled = false;
    this.scene.add(line);
    return line;
  }

  setLine(line, pts, colors) {
    if (pts.length < 2) { line.visible = false; return; }
    const g = new LineGeometry();
    const arr = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
    g.setPositions(arr);
    if (colors) g.setColors(colors);
    line.geometry.dispose();
    line.geometry = g;
    line.computeLineDistances();
    line.visible = true;
  }

  // ------------------------------------------------------------------ hole building
  buildHole() {
    const game = this.game, h = game.hole;
    for (const c of [...this.holeGroup.children]) {
      this.holeGroup.remove(c);
      c.traverse(o => { o.geometry?.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m) { m.map?.dispose(); m.dispose(); } } });
    }
    this.builtHole = h;
    const t0 = performance.now();

    // In-play rectangle
    let xmin = Infinity, xmax = -Infinity;
    const cor = h.corridor() + 6;
    for (let z = -45; z <= h.L + 50; z += 5) { const c = h.cx(z), d = h.cxd(z), k = Math.sqrt(1 + d * d); xmin = Math.min(xmin, c - cor * k); xmax = Math.max(xmax, c + cor * k); }
    const zmin = -48, zmax = h.L + 52;
    this.playRect = { xmin, xmax, zmin, zmax };
    const g = h.green, P = g.R0 * 1.45 + 7;
    this.patch = { xmin: g.x - P, xmax: g.x + P, zmin: g.z - P, zmax: g.z + P };

    const xs = axis(xmin, xmax, this.patch.xmin, this.patch.xmax, 320);
    const zs = axis(zmin, zmax, this.patch.zmin, this.patch.zmax, 320);
    const NX = xs.length, NZ = zs.length, NV = NX * NZ;
    const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), uv1 = new Float32Array(NV * 2), uv2 = new Float32Array(NV * 2);
    const H = new Float64Array(NV);
    const pr = this.playRect, pa = this.patch;
    for (let j = 0, k = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++, k++) {
        const x = xs[i], z = zs[j], y = h.height(x, z);
        H[k] = y;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = (x - pr.xmin) / (pr.xmax - pr.xmin); uv[k * 2 + 1] = (z - pr.zmin) / (pr.zmax - pr.zmin);
        uv1[k * 2] = (x - pa.xmin) / (pa.xmax - pa.xmin); uv1[k * 2 + 1] = (z - pa.zmin) / (pa.zmax - pa.zmin);
        uv2[k * 2] = x / 7; uv2[k * 2 + 1] = z / 7;
      }
    }
    // Skirt: the outermost ring of vertices drops down to the horizon ground disk
    let hMin = Infinity; for (let k = 0; k < NV; k++) hMin = Math.min(hMin, H[k]);
    const farY = hMin - 6;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      if (i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) { const k = j * NX + i; H[k] = farY; pos[k * 3 + 1] = farY; }
    }
    const nrm = new Float32Array(NV * 3);
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        const i0 = Math.max(0, i - 1), i1 = Math.min(NX - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NZ - 1, j + 1);
        const gx = (H[j * NX + i1] - H[j * NX + i0]) / (xs[i1] - xs[i0]);
        const gz = (H[j1 * NX + i] - H[j0 * NX + i]) / (zs[j1] - zs[j0]);
        const nx = -gx * NORMAL_EXAGGERATION, nz = -gz * NORMAL_EXAGGERATION, L = Math.sqrt(nx * nx + 1 + nz * nz);
        nrm[k * 3] = nx / L; nrm[k * 3 + 1] = 1 / L; nrm[k * 3 + 2] = nz / L;
      }
    }
    // triangles split into groups: 0 outer (tiled), 1 in-play (main texture), 2 green patch
    const groups = [[], [], []];
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
        const gi = (cx > pa.xmin && cx < pa.xmax && cz > pa.zmin && cz < pa.zmax) ? 2 : (cx > pr.xmin && cx < pr.xmax && cz > pr.zmin && cz < pr.zmax) ? 1 : 0;
        groups[gi].push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    geo.setAttribute('uv2', new THREE.BufferAttribute(uv2, 2));
    const all = new Uint32Array(groups[0].length + groups[1].length + groups[2].length);
    let off = 0;
    groups.forEach((gr, gi) => { all.set(gr, off); geo.addGroup(off, gr.length, gi); off += gr.length; });
    geo.setIndex(new THREE.BufferAttribute(all, 1));

    const outerTex = this.makeOuterTexture();
    const mainTex = this.makeMainTexture(h);
    const [greenPlain, greenGrid] = this.makeGreenTextures(h);
    this.greenTex = { plain: greenPlain, grid: greenGrid };
    outerTex.channel = 2; greenPlain.channel = 1; greenGrid.channel = 1;
    this.greenMat = new THREE.MeshStandardMaterial({ map: this.showGrid ? greenGrid : greenPlain, roughness: 0.95 });
    const mats = [new THREE.MeshStandardMaterial({ map: outerTex, roughness: 1 }), new THREE.MeshStandardMaterial({ map: mainTex, roughness: 0.95 }), this.greenMat];
    this.terrainMesh = new THREE.Mesh(geo, mats);
    this.terrainMesh.receiveShadow = true;
    this.holeGroup.add(this.terrainMesh);

    // Ground plane to the horizon
    const far = new THREE.Mesh(new THREE.CircleGeometry(4000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2f5c2a, roughness: 1 }));
    far.position.set((xmin + xmax) / 2, farY - 0.05, h.L / 2);
    this.holeGroup.add(far);

    // Water
    for (const p of h.ponds) {
      const N = 160, pts = [];
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        let f = 1; for (const hm of p.harm) f += hm.a * Math.cos(hm.k * th + hm.p);
        const r = p.R0 * f + 0.4, lx = Math.cos(th) * r * p.sx, lz = Math.sin(th) * r;
        pts.push(new THREE.Vector2(p.x + lx * c - lz * s, p.z + lx * s + lz * c));
      }
      const shape = new THREE.Shape(pts);
      const wg = new THREE.ShapeGeometry(shape, 1).rotateX(Math.PI / 2);
      const water = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x2f7fc4, emissive: 0x0b2f55, roughness: 0.15, metalness: 0, envMap: this.sky.envMap(this.renderer), envMapIntensity: 1.2, transparent: true, opacity: 0.93, side: THREE.DoubleSide }));
      water.position.y = p.level;
      water.receiveShadow = true;
      this.holeGroup.add(water);
      // foam line
      const foam = pts.map(v => new THREE.Vector3(v.x, p.level + 0.02, v.y));
      foam.push(foam[0]);
      const fl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(foam), new THREE.LineBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.8 }));
      this.holeGroup.add(fl);
    }

    // Cup, pin, flag
    const cup = h.cup;
    const cupMesh = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 40), new THREE.MeshBasicMaterial({ color: 0x0b0f08, side: THREE.DoubleSide }));
    const liner = new THREE.Mesh(new THREE.RingGeometry(CUP_R, CUP_R + 0.006, 40), new THREE.MeshBasicMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide }));
    for (const m of [cupMesh, liner]) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i) + cup.x, z = -p.getY(i) + cup.z; p.setXYZ(i, x, h.height(x, z) + 0.004, z); }
      this.holeGroup.add(m);
    }
    const hy = h.height(cup.x, cup.z);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }));
    pin.position.set(cup.x, hy + 1.2, cup.z); pin.castShadow = true;
    const flagGeo = new THREE.PlaneGeometry(0.75, 0.5, 10, 4); flagGeo.translate(0.375, 0, 0);
    this.flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xe53935, emissive: 0x7a1010, side: THREE.DoubleSide }));
    this.flag.position.set(cup.x, hy + 2.12, cup.z);
    this.flag.rotation.y = Math.atan2(-h.wind.z, h.wind.x);   // flag streams downwind
    this.windStrength = Math.hypot(h.wind.x, h.wind.z);
    this.flagBase = flagGeo.attributes.position.array.slice();
    this.holeGroup.add(pin, this.flag);
    this.pinMarker.position.set(cup.x, hy + 3.6, cup.z);

    // Tee markers
    for (const sx of [-2.2, 2.2]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ color: 0x1e5bd8 }));
      m.position.set(h.tee.x + sx, h.height(h.tee.x + sx, h.tee.z + 1) + 0.1, h.tee.z + 1);
      this.holeGroup.add(m);
    }

    this.buildTrees(h, xmin, xmax, zmin, zmax);
    this.buildSlopeDots(h);
    this.sky.build(h.seed, new THREE.Vector3((xmin + xmax) / 2, 0, h.L / 2), h.wind);
    this.buildMs = performance.now() - t0;
    this.snap = true;
  }

  buildTrees(h, xmin, xmax, zmin, zmax) {
    const rand = mulberry32((h.seed ^ 0x7ee5) >>> 0);
    const list = h.trees.map(t => ({ ...t }));
    // decorative forest outside the playable corridor (no collisions needed: it's out of bounds)
    const cor = h.corridor();
    for (let z = zmin - 120; z < zmax + 120; z += 4) {
      for (const side of [-1, 1]) {
        if (rand() < 0.35) continue;
        const c = z < -20 ? 0 : h.cx(Math.min(z, h.L)), d = h.cxd(Math.min(Math.max(z, 0), h.L)), k = Math.sqrt(1 + d * d);
        const la = side * (cor + 2 + rand() * 90);
        const x = c + la * k + (rand() - 0.5) * 6;
        if (z > -40 && z < h.L + 45 && Math.abs(h.lat(x, z)) < cor + 1) continue;
        list.push(decorTree(rand, x, z, h.height(x, z)));
      }
    }
    for (let x = xmin - 100; x < xmax + 100; x += 5) {
      for (const z0 of [zmin - 30, zmax + 25]) {
        if (rand() < 0.3) continue;
        const z = z0 + (z0 < 0 ? -1 : 1) * rand() * 60;
        list.push(decorTree(rand, x, z, h.height(x, z)));
      }
    }
    const pines = list.filter(t => t.type === 'pine'), rounds = list.filter(t => t.type !== 'pine');
    const trunkGeo = new THREE.CylinderGeometry(1, 1, 1, 7).translate(0, 0.5, 0);
    const coneGeo = new THREE.ConeGeometry(1, 1, 9).translate(0, 0.5, 0);
    const blobGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    const mk = (geo, mat, n) => { const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n)); im.count = n; im.castShadow = true; im.receiveShadow = true; this.holeGroup.add(im); return im; };
    const pt = mk(trunkGeo, trunkMat, pines.length), pc = mk(coneGeo, leafMat, pines.length);
    pines.forEach((t, i) => {
      m4.compose(new THREE.Vector3(t.x, t.y0 - 0.3, t.z), q, new THREE.Vector3(t.trunkR, t.crownBase + 1.3, t.trunkR)); pt.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(t.x, t.y0 + t.crownBase, t.z), q, new THREE.Vector3(t.crownR, t.crownTop - t.crownBase, t.crownR)); pc.setMatrixAt(i, m4);
      col.setHSL(0.36 + (hashf(t.x, t.z) - 0.5) * 0.05, 0.55, 0.2 + hashf(t.z, t.x) * 0.08); pc.setColorAt(i, col);
    });
    const rt = mk(trunkGeo, trunkMat, rounds.length), rc = mk(blobGeo, leafMat, rounds.length);
    rounds.forEach((t, i) => {
      m4.compose(new THREE.Vector3(t.x, t.y0 - 0.3, t.z), q, new THREE.Vector3(t.trunkR, t.crownY + 0.3, t.trunkR)); rt.setMatrixAt(i, m4);
      const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hashf(t.x, t.z) * 6);
      m4.compose(new THREE.Vector3(t.x, t.y0 + t.crownY, t.z), qq, new THREE.Vector3(t.crownR, t.crownRy, t.crownR)); rc.setMatrixAt(i, m4);
      col.setHSL(0.27 + (hashf(t.x, t.z) - 0.5) * 0.08, 0.5, 0.28 + hashf(t.z, t.x) * 0.1); rc.setColorAt(i, col);
    });
    for (const im of [pc, rc]) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  buildSlopeDots(h) {
    const g = h.green, dots = [];
    for (let x = Math.floor(g.x - g.R0 * 1.4); x <= g.x + g.R0 * 1.4; x++) {
      for (let z = Math.floor(g.z - g.R0 * 1.4); z <= g.z + g.R0 * 1.4; z++) {
        const cx = x + 0.5, cz = z + 0.5;
        if (blobDist(g, cx, cz) > -0.3) continue;
        const [gx, gz] = h.grad(cx, cz), sl = Math.hypot(gx, gz);
        dots.push({ x: cx, z: cz, dx: sl > 1e-6 ? -gx / sl : 0, dz: sl > 1e-6 ? -gz / sl : 0, sl, ph: hashf(x + 999, z + 999) });
      }
    }
    this.dots = dots;
    this.dotMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.045, 10).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }), Math.max(1, dots.length));
    this.dotMesh.count = dots.length;
    this.dotMesh.frustumCulled = false;
    this.holeGroup.add(this.dotMesh);
  }

  makeOuterTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d'), img = x.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const n = hashf(i, j) * 0.1 + valueNoise(i / 16, j / 16) * 0.15 - 0.12, o = (j * S + i) * 4;
      img.data[o] = c255(0.18 * (1 + n)); img.data[o + 1] = c255(0.38 * (1 + n)); img.data[o + 2] = c255(0.14 * (1 + n)); img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
    return t;
  }

  /** Sample heights on a regular grid (for baked shading). */
  heightGrid(h, x0, z0, x1, z1, step) {
    const nx = Math.ceil((x1 - x0) / step) + 1, nz = Math.ceil((z1 - z0) / step) + 1;
    const H = new Float64Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = h.height(x0 + i * step, z0 + j * step);
    return { H, nx, nz, x0, z0, step };
  }

  /** Paint one texture over rect r with pixel size px. Returns [plainCanvas, gridCanvas?]. */
  paint(h, r, px, shadeAmt, withGrid) {
    const W = Math.round((r.xmax - r.xmin) / px), Ht = Math.round((r.zmax - r.zmin) / px);
    const hg = this.heightGrid(h, r.xmin - 1, r.zmin - 1, r.xmax + 1, r.zmax + 1, Math.max(px, withGrid ? 0.25 : 1));
    const { H, nx, step } = hg;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = Ht; return c; };
    const c1 = mk(), c2 = withGrid ? mk() : null;
    const ctx1 = c1.getContext('2d'), img1 = ctx1.createImageData(W, Ht), a = img1.data;
    const ctx2 = c2?.getContext('2d'), img2 = ctx2?.createImageData(W, Ht), b = img2?.data;
    const lx = SUN_DIR.x, ly = SUN_DIR.y, lz = SUN_DIR.z;
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
        const surf = h.surface(x, z);
        const n = hashf(i, j) * 0.06 - 0.03;
        const mott = valueNoise(x * 0.9, z * 0.9) * 0.08 + valueNoise(x * 4, z * 4) * 0.04 - 0.06;
        let cr, cg, cb, amt = shadeAmt;
        switch (surf) {
          case 'green': {
            const stripe = (Math.floor((x * 0.8 + z * 0.6) / 1.6) & 1) ? 0.035 : -0.035, k = 1 + stripe + n * 0.5 + mott * 0.6;
            const hn = Math.min(1, Math.max(0, (y - hmin) / hspan));
            cr = (0.17 + 0.25 * hn) * k; cg = (0.54 + 0.22 * hn) * k; cb = (0.34 - 0.14 * hn) * k; amt = shadeAmt * 1.25; break;
          }
          case 'fringe': { const k = 1 + n + mott; cr = 0.25 * k; cg = 0.56 * k; cb = 0.21 * k; break; }
          case 'fairway': case 'tee': {
            const stripe = (Math.floor(z / (surf === 'tee' ? 1.5 : 8)) & 1) ? 0.05 : -0.05, k = 1 + stripe + n * 0.6 + mott * 0.7;
            cr = 0.33 * k; cg = 0.66 * k; cb = 0.24 * k; break;
          }
          case 'sand': { const k = 1 + n * 2 + mott * 0.6; cr = 0.88 * k; cg = 0.79 * k; cb = 0.57 * k; amt = shadeAmt * 0.8; break; }
          case 'water': cr = 0.16; cg = 0.27; cb = 0.2; break;
          default: { const k = 1 + n * 2.2 + mott * 1.6; cr = 0.2 * k; cg = 0.47 * k; cb = 0.14 * k; if (surf === 'oob') { cr *= 0.92; cg *= 0.92; cb *= 0.92; } }
        }
        const ex = -gx * SHADE_MAIN, ez = -gz * SHADE_MAIN, el = Math.sqrt(ex * ex + 1 + ez * ez);
        const shade = (ex * lx + ly + ez * lz) / el - ly;
        const m = Math.min(1.6, Math.max(surf === 'green' || surf === 'fringe' ? 0.42 : 0.62, 1 + amt * shade));
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
          if (surf === 'green' || surf === 'fringe') {
            const fx = Math.abs(x - Math.round(x)), fz = Math.abs(z - Math.round(z));
            if (fx < px * 0.55 || fz < px * 0.55) { b[o] = c255(cr * 0.72 + 0.26); b[o + 1] = c255(cg * 0.72 + 0.26); b[o + 2] = c255(cb * 0.72 + 0.26); }
          }
        }
      }
    }
    ctx1.putImageData(img1, 0, 0);
    if (ctx2) ctx2.putImageData(img2, 0, 0);
    return [c1, c2];
  }

  toTex(c) {
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }
  makeMainTexture(h) {
    const r = this.playRect;
    const px = Math.max(0.25, Math.max(r.xmax - r.xmin, r.zmax - r.zmin) / 4096);
    return this.toTex(this.paint(h, r, px, SHADE_MAIN * 0.3, false)[0]);
  }
  makeGreenTextures(h) {
    const r = this.patch, px = (r.xmax - r.xmin) / 1280;   // ~4.7 cm/px, like the putting game
    const [a, b] = this.paint(h, r, px, SHADE_GREEN * 0.4, true);
    return [this.toTex(a), this.toTex(b)];
  }

  setGrid(on) {
    this.showGrid = on;
    this.greenMat.map = on ? this.greenTex.grid : this.greenTex.plain;
    this.greenMat.needsUpdate = true;
  }

  /** Cheat-mode preview path (game.preview() result) or null. */
  setPreview(r) {
    this.previewResult = r;
    if (!r) { this.previewLine.visible = false; this.landMarker.visible = false; this.endMarker.visible = false; return; }
    const h = this.game.hole, pts = [], cols = [];
    const holed = r.result === 'holed', bad = r.result === 'water' || r.result === 'oob';
    const step = r.path.length > 600 ? 2 : 1;
    for (let i = 0; i < r.path.length; i += step) {
      const p = r.path[i], gy = h.height(p.x, p.z), air = p.y - gy > 0.05;
      pts.push({ x: p.x, y: Math.max(p.y, gy) + 0.06, z: p.z });
      const c = bad ? [1, 0.35, 0.3] : holed ? [0.36, 1, 0.48] : air ? [1, 0.88, 0.3] : [1, 1, 1];
      cols.push(...c);
    }
    const last = r.path[r.path.length - 1];
    pts.push({ x: last.x, y: last.y + 0.06, z: last.z }); cols.push(...cols.slice(-3));
    this.setLine(this.previewLine, pts, cols);
    if (r.landing) {
      this.landMarker.position.set(r.landing.x, h.height(r.landing.x, r.landing.z) + 0.05, r.landing.z);
      this.landMarker.visible = true;
    } else this.landMarker.visible = false;
    this.endMarker.position.set(r.end.x, h.height(r.end.x, r.end.z) + 0.05, r.end.z);
    this.endMarker.material.color.set(bad ? 0xff5a4d : holed ? 0x5cff7a : 0xffffff);
    this.endMarker.visible = true;
  }

  resize(w, hgt) {
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMats) m.resolution.set(w, hgt);
  }

  // ------------------------------------------------------------------ per-frame
  render(alpha = 1, dtReal = 1 / 60, snap = false) {
    const game = this.game, h = game.hole;
    if (h !== this.builtHole) this.buildHole();
    snap = snap || this.snap; this.snap = false;
    this.time += dtReal;

    const pb = game.prevBall, cb = game.ball;
    const bx = pb.x + (cb.x - pb.x) * alpha, bz = pb.z + (cb.z - pb.z) * alpha;
    let by = pb.y + (cb.y - pb.y) * alpha;
    const gy = h.height(bx, bz);
    if (!cb.air || by < gy) by = Math.max(by, gy);
    if (game.phase === 'holed') { this.sinkT = Math.min(1, this.sinkT + dtReal * 3); by = gy - this.sinkT * 0.08; } else this.sinkT = 0;
    this.ball.position.set(bx, by + BALL_R, bz);
    const camDist = this.camera.position.distanceTo(this.ball.position);
    const bs = cb.air ? Math.max(2.5, camDist / 10) : Math.max(1, camDist / 35);  // exaggerated in flight so it's trackable
    this.ball.scale.setScalar(bs);
    this.halo.position.set(bx, gy + 0.03, bz);
    this.halo.scale.setScalar(Math.max(1, camDist / 25));
    this.halo.visible = game.phase !== 'holed' && game.phase !== 'moving';

    const aiming = game.phase === 'aim' || game.phase === 'swing';
    if (!(aiming && game.mode === 'cheat')) { this.previewLine.visible = false; this.landMarker.visible = false; this.endMarker.visible = false; }
    // normal-mode aim guide: ground line + full-power target ring
    if (aiming && game.mode === 'normal') {
      const club = game.club, len = club.putter ? 3 : Math.min(club.carry, 260);
      const pts = [];
      const n = club.putter ? 30 : 60;
      for (let i = 1; i <= n; i++) { const s = 0.1 + (len - 0.1) * i / n, x = cb.x + Math.cos(game.aim) * s, z = cb.z + Math.sin(game.aim) * s; pts.push({ x, y: h.height(x, z) + 0.05, z }); }
      this.setLine(this.aimLine, pts);
      if (!club.putter) {
        const x = cb.x + Math.cos(game.aim) * club.carry, z = cb.z + Math.sin(game.aim) * club.carry;
        this.targetMarker.position.set(x, h.height(x, z) + 0.06, z); this.targetMarker.visible = true;
      } else this.targetMarker.visible = false;
    } else { this.aimLine.visible = false; this.targetMarker.visible = false; }

    // tracer (current/last flight)
    if (game.tracer.length > 1 && game.phase !== 'aim' || (game.phase === 'aim' && game.lastShot && game.tracer.length > 1 && game.mode === 'normal')) {
      const tr = game.tracer, pts = [];
      const step = Math.max(1, Math.floor(tr.length / 500));
      for (let i = 0; i < tr.length; i += step) pts.push({ x: tr[i].x, y: tr[i].y + 0.06, z: tr[i].z });
      pts.push({ x: bx, y: by + 0.06, z: bz });
      this.setLine(this.tracerLine, pts);
    } else this.tracerLine.visible = false;

    // markers scale with distance so they're visible
    for (const m of [this.landMarker, this.endMarker, this.targetMarker]) if (m.visible) m.scale.setScalar(Math.max(0.25, this.camera.position.distanceTo(m.position) * 0.012));

    // flag wave, slope dots
    const fp = this.flag.geometry.attributes.position;
    const wk = 0.4 + this.windStrength / 8;
    for (let i = 0; i < fp.count; i++) { const x0 = this.flagBase[i * 3]; fp.setZ(i, Math.sin(x0 * 6 - this.time * (3 + wk * 3)) * 0.05 * wk * x0); }
    fp.needsUpdate = true;
    this.pinMarker.visible = this.camera.position.distanceTo(this.flag.position) > 35;
    this.updateDots();

    this.updateCamera(bx, by, bz, dtReal, snap);
    this.sky.update(dtReal, this.camera);
    this.sun.position.set(bx + SUN_DIR.x * 150, by + SUN_DIR.y * 150, bz + SUN_DIR.z * 150);
    this.sun.target.position.set(bx, by, bz);
    this.scene.fog = this.camMode === 'overhead' ? null : this.fog;
    this.renderer.render(this.scene, this.camera);
  }

  updateDots() {
    const on = this.showGrid && this.game.lie === 'green' || this.showGrid && this.game.hole.distToCup(this.game.ball.x, this.game.ball.z) < 40;
    this.dotMesh.visible = on;
    if (!on) return;
    const h = this.game.hole, m4 = new THREE.Matrix4();
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i];
      const ph = (d.ph + this.time * Math.min(d.sl, 0.15) * 10) % 1;
      const x = d.x + d.dx * (ph - 0.5), z = d.z + d.dz * (ph - 0.5);
      const sc = Math.sin(Math.PI * ph) * Math.min(1, 0.35 + d.sl * 25);
      m4.makeScale(sc, 1, sc).setPosition(x, h.height(x, z) + 0.01, z);
      this.dotMesh.setMatrixAt(i, m4);
    }
    this.dotMesh.instanceMatrix.needsUpdate = true;
  }

  updateCamera(bx, by, bz, dtReal, snap) {
    const game = this.game, h = game.hole;
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    const putting = game.club.putter && game.phase !== 'moving';
    const ax = Math.cos(game.aim), az = Math.sin(game.aim);
    let k = 6;
    if (this.camMode === 'overhead') {
      // frame ball + (preview end | cup)
      const tgt = (game.mode === 'cheat' && this.previewResult && game.phase === 'aim') ? this.previewResult.end : h.cup;
      const tx = game.phase === 'moving' ? bx : tgt.x, tz = game.phase === 'moving' ? bz : tgt.z;
      const sx = game.phase === 'moving' ? game.shotStart.x : bx, sz = game.phase === 'moving' ? game.shotStart.z : bz;
      const mx = (sx + tx) / 2, mz = (sz + tz) / 2, d = Math.hypot(tx - sx, tz - sz);
      const hgt = (Math.max(8, d * 1.25) + 6) * this.zoom;
      pos.set(mx, h.height(mx, mz) + hgt, mz);
      look.set(mx, h.height(mx, mz), mz);
      this.camera.up.set(ax, 0, az);
    } else {
      this.camera.up.set(0, 1, 0);
      if (game.phase === 'moving') {
        let vx = game.ball.vx, vz = game.ball.vz;
        const sp = Math.hypot(vx, vz);
        if (sp < 1e-3) { vx = ax; vz = az; } else { vx /= sp; vz /= sp; }
        const air = game.ball.air;
        const back = (air ? 14 : 5) * this.zoom, up = (air ? 4 : 1.8) * this.zoom;
        pos.set(bx - vx * back, 0, bz - vz * back);
        pos.y = Math.max(h.height(pos.x, pos.z) + 0.6, by + up);
        look.set(bx + vx * 3, by, bz + vz * 3);
        k = air ? 4 : 3;
      } else if (putting) {
        const back = 2.6 * this.zoom, up = 1.15 * this.zoom;
        pos.set(bx - ax * back, 0, bz - az * back);
        pos.y = Math.max(h.height(pos.x, pos.z) + 0.3, by + up);
        const lx = bx + ax * 7, lz = bz + az * 7;
        look.set(lx, h.height(lx, lz), lz);
      } else {
        // behind the ball, tilted ~8 degrees down so the ball sits in the lower third
        const back = 6 * this.zoom, up = 2.2 * this.zoom;
        pos.set(bx - ax * back, 0, bz - az * back);
        pos.y = Math.max(h.height(pos.x, pos.z) + 0.8, by + up);
        look.set(pos.x + ax * 100, pos.y - 100 * Math.tan(8 * Math.PI / 180), pos.z + az * 100);
      }
    }
    if (snap) { this.camPos.copy(pos); this.camLook.copy(look); }
    else { const f = 1 - Math.exp(-dtReal * k); this.camPos.lerp(pos, f); this.camLook.lerp(look, f); }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  pick(nx, ny) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hit = rc.intersectObject(this.terrainMesh, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }
}

/** Non-uniform axis: 1.5 m spacing in play, 0.3 m in [f0,f1], growing spacing outside to +-margin. */
function axis(min, max, f0, f1, margin) {
  const out = [];
  let v = min, s = 1.5;
  const lo = [];
  for (let u = min - s; u > min - margin; u -= s, s *= 1.09) lo.push(u);
  out.push(...lo.reverse());
  for (v = min; v < f0; v += 1.5) out.push(v);
  for (v = f0; v < f1; v += 0.3) out.push(v);
  for (v = f1; v < max; v += 1.5) out.push(v);
  out.push(max);
  s = 1.5;
  for (let u = max + s; u < max + margin; u += s, s *= 1.09) out.push(u);
  return out;
}

function decorTree(rand, x, z, y0) {
  const pine = rand() < 0.6, s = 0.9 + rand() * 0.8;
  return pine ? { type: 'pine', x, z, y0, trunkR: 0.22 * s, crownBase: 1.2 * s, crownTop: 9.5 * s, crownR: 2.6 * s }
    : { type: 'round', x, z, y0, trunkR: 0.28 * s, crownY: 5.2 * s, crownR: 3.0 * s, crownRy: 2.6 * s };
}

function pinTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.strokeStyle = '#000'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(8, 8); x.lineTo(56, 8); x.lineTo(32, 88); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = '#e53935'; x.beginPath(); x.moveTo(18, 16); x.lineTo(46, 16); x.lineTo(32, 62); x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function c255(v) { return Math.max(0, Math.min(255, Math.round(v * 255))); }
function hashf(i, j) {
  let h = (Math.floor(i * 1000) * 374761393 + Math.floor(j * 1000) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hashf(i, j), b = hashf(i + 1, j), c = hashf(i, j + 1), d = hashf(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
export { radialTexture };
