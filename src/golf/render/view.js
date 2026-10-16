// three.js view for the full-hole game. Reads GolfGame state, never mutates it.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { BALL_R, CUP_R, FRINGE_WIDTH } from '../sim/constants.js';
import { blobDist, cleanParams } from '../sim/hole.js';
import { mulberry32 } from '../../sim/rng.js';
import { Sky, LIGHT_DIR as SUN_DIR, HORIZON, radialTexture } from './sky.js';
import { pineCrown, roundCrown, trunkGeometry, leafTexture, needleTexture } from './trees.js';

import { paintPixels, SHADE_MAIN, SHADE_GREEN, hashf, valueNoise, c255 } from './paint.js';

// Readability exaggeration (deliberately unrealistic so terrain shape is obvious)
const NORMAL_EXAGGERATION = 1.4;

export class GolfView {
  constructor(canvas, game) {
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;   // keeps colors vivid while allowing brighter lights
    this.renderer.toneMappingExposure = 1.15;

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

    this.scene.add(new THREE.HemisphereLight(0xf2f9ff, 0x7aa858, 1.6));
    const fill = new THREE.DirectionalLight(0xd2e4ff, 0.7);
    fill.position.set(-SUN_DIR.x, 0.5, -SUN_DIR.z);
    this.scene.add(fill);
    this.sun = new THREE.DirectionalLight(0xfff5e2, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 300;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.intensity = 0.6;   // lighter, friendlier shadows
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
    this.buildGen = (this.buildGen || 0) + 1;
    if (!this.pool) this.pool = new PaintPool(Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1)));
    this.paramsClean = cleanParams(h.params); this.paramsKey = `${h.seed}|${this.buildGen}`;
    const paints = [];
    this.greenTex = null;

    // In-play rectangle, snapped to the 1.5 m base grid
    const STEP = 1.5, FINE = 6;   // base grid spacing; patches subdivide each base cell FINE x FINE (0.25 m)
    let xmin = Infinity, xmax = -Infinity;
    const cor = h.corridor() + 6;
    for (let z = -45; z <= h.L + 50; z += 5) { const c = h.cx(z), d = h.cxd(z), k = Math.sqrt(1 + d * d); xmin = Math.min(xmin, c - cor * k); xmax = Math.max(xmax, c + cor * k); }
    xmin = Math.floor(xmin / STEP) * STEP; xmax = Math.ceil(xmax / STEP) * STEP;
    const zmin = -48, zmax = Math.ceil((h.L + 52) / STEP) * STEP;
    this.playRect = { xmin, xmax, zmin, zmax };

    // Hi-res patches (green + each bunker + each pond), snapped to base grid lines and merged
    // where they overlap. Inside them the base mesh is cut out and replaced by a 0.25 m grid
    // whose border vertices lie exactly on the base mesh edges (watertight, no T-junction cracks).
    const snapRect = (x0, x1, z0, z1) => ({
      xmin: Math.max(xmin, xmin + Math.floor((x0 - xmin) / STEP) * STEP), xmax: Math.min(xmax, xmin + Math.ceil((x1 - xmin) / STEP) * STEP),
      zmin: Math.max(zmin, zmin + Math.floor((z0 - zmin) / STEP) * STEP), zmax: Math.min(zmax, zmin + Math.ceil((z1 - zmin) / STEP) * STEP),
    });
    const g = h.green, P = g.R0 * 1.45 + 6;
    let rects = [{ ...snapRect(g.x - P, g.x + P, g.z - P, g.z + P), green: true, px: 0.04 }];
    for (const b of h.bunkers) { const r = b._bound + 3; rects.push({ ...snapRect(b.x - r, b.x + r, b.z - r, b.z + r), px: 0.04 }); }
    for (const p of h.ponds) { const r = p._bound + 4; rects.push({ ...snapRect(p.x - r, p.x + r, p.z - r, p.z + r), px: 0.08 }); }
    for (let merged = true; merged;) {
      merged = false;
      outer: for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        if (A.xmin < B.xmax && B.xmin < A.xmax && A.zmin < B.zmax && B.zmin < A.zmax) {
          rects[a] = { xmin: Math.min(A.xmin, B.xmin), xmax: Math.max(A.xmax, B.xmax), zmin: Math.min(A.zmin, B.zmin), zmax: Math.max(A.zmax, B.zmax), green: A.green || B.green, px: Math.min(A.px, B.px) };
          rects.splice(b, 1); merged = true; break outer;
        }
      }
    }
    this.patches = rects;
    const inPatch = (x, z) => rects.some(r => x > r.xmin && x < r.xmax && z > r.zmin && z < r.zmax);

    // Base mesh: uniform 1.5 m in play, spacing growing outside to a 320 m margin
    const xs = axis(xmin, xmax, STEP, 320), zs = axis(zmin, zmax, STEP, 320);
    const NX = xs.length, NZ = zs.length, NV = NX * NZ;
    const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), uv2 = new Float32Array(NV * 2);
    const H = new Float64Array(NV);
    const pr = this.playRect;
    for (let j = 0, k = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++, k++) {
        const x = xs[i], z = zs[j], y = h.height(x, z);
        H[k] = y;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = (x - pr.xmin) / (pr.xmax - pr.xmin); uv[k * 2 + 1] = (z - pr.zmin) / (pr.zmax - pr.zmin);
        uv2[k * 2] = x / 7; uv2[k * 2 + 1] = z / 7;
      }
    }
    // Skirt: the outermost ring of vertices drops down to the horizon ground disk
    let hMin = Infinity; for (let k = 0; k < NV; k++) hMin = Math.min(hMin, H[k]);
    const farY = hMin - 6;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      if (i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) { const k = j * NX + i; H[k] = farY; pos[k * 3 + 1] = farY; }
    }
    const nrm = gridNormals(H, NX, NZ, i => xs[i], j => zs[j]);
    const groups = [[], []];   // 0 outer (tiled), 1 in-play (baked texture); patch cells are skipped
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
        if (inPatch(cx, cz)) continue;
        groups[(cx > pr.xmin && cx < pr.xmax && cz > pr.zmin && cz < pr.zmax) ? 1 : 0].push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uv2', new THREE.BufferAttribute(uv2, 2));
    const all = new Uint32Array(groups[0].length + groups[1].length);
    all.set(groups[0], 0); all.set(groups[1], groups[0].length);
    geo.addGroup(0, groups[0].length, 0); geo.addGroup(groups[0].length, groups[1].length, 1);
    geo.setIndex(new THREE.BufferAttribute(all, 1));
    const outerTex = this.makeOuterTexture(); outerTex.channel = 2;
    this.buildTimes = { mesh: performance.now() - t0 };
    const PLACEHOLDER = 0x5aa040;   // flat grass color shown until the worker-painted texture arrives
    const mainMat = new THREE.MeshStandardMaterial({ color: PLACEHOLDER, roughness: 0.95 });
    const mpx = Math.max(0.25, Math.max(pr.xmax - pr.xmin, pr.zmax - pr.zmin) / 4096);
    this.terrainMesh = new THREE.Mesh(geo, [new THREE.MeshStandardMaterial({ map: outerTex, roughness: 1 }), mainMat]);
    this.terrainMesh.receiveShadow = true;
    this.holeGroup.add(this.terrainMesh);
    this.pickMeshes = [this.terrainMesh];

    // Patch meshes
    const tp0 = performance.now();
    const baseH = (x, z) => h.height(x, z);
    for (const r of rects) {
      const nx = Math.round((r.xmax - r.xmin) / STEP) * FINE + 1, nz = Math.round((r.zmax - r.zmin) / STEP) * FINE + 1, d = STEP / FINE;
      const pp = new Float32Array(nx * nz * 3), pu = new Float32Array(nx * nz * 2), PH = new Float64Array(nx * nz);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i, x = r.xmin + i * d, z = r.zmin + j * d;
          let y;
          const onX = i === 0 || i === nx - 1, onZ = j === 0 || j === nz - 1;
          if (onZ && i % FINE) { const i0 = i - (i % FINE); const t = (i % FINE) / FINE; y = baseH(r.xmin + i0 * d, z) * (1 - t) + baseH(r.xmin + (i0 + FINE) * d, z) * t; }
          else if (onX && j % FINE) { const j0 = j - (j % FINE); const t = (j % FINE) / FINE; y = baseH(x, r.zmin + j0 * d) * (1 - t) + baseH(x, r.zmin + (j0 + FINE) * d) * t; }
          else y = baseH(x, z);
          PH[k] = y; pp[k * 3] = x; pp[k * 3 + 1] = y; pp[k * 3 + 2] = z;
          pu[k * 2] = i / (nx - 1); pu[k * 2 + 1] = j / (nz - 1);
        }
      }
      const pidx = new Uint32Array((nx - 1) * (nz - 1) * 6);
      for (let j = 0, q = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
        pidx[q++] = a; pidx[q++] = c; pidx[q++] = b; pidx[q++] = b; pidx[q++] = c; pidx[q++] = e;
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
      pg.setAttribute('normal', new THREE.BufferAttribute(gridNormals(PH, nx, nz, i => r.xmin + i * d, j => r.zmin + j * d), 3));
      pg.setAttribute('uv', new THREE.BufferAttribute(pu, 2));
      pg.setIndex(new THREE.BufferAttribute(pidx, 1));
      const px = Math.max(r.px, Math.max(r.xmax - r.xmin, r.zmax - r.zmin) / 2048);
      const mat = new THREE.MeshStandardMaterial({ color: PLACEHOLDER, roughness: 0.95 });
      if (r.green) this.greenMat = mat;
      paints.push({ area: (r.xmax - r.xmin) * (r.zmax - r.zmin) / (px * px), run: () => this.paintInto(mat, r, px, r.green ? SHADE_GREEN * 0.4 : SHADE_MAIN * 0.3, !!r.green, 0.25,
        r.green ? (plain, grid) => { this.greenTex = { plain, grid }; mat.map = this.showGrid ? grid : plain; } : null) });
      const mesh = new THREE.Mesh(pg, mat);
      mesh.receiveShadow = true;
      this.holeGroup.add(mesh);
      this.pickMeshes.push(mesh);
    }

    // Ground plane to the horizon
    const far = new THREE.Mesh(new THREE.CircleGeometry(4000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3f7f34, roughness: 1 }));
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

    this.buildTimes.patches = performance.now() - tp0;
    // Paint textures in workers, biggest first; `ready` resolves when every texture is in.
    paints.push({ area: (pr.xmax - pr.xmin) * (pr.zmax - pr.zmin) / (mpx * mpx), run: () => this.paintInto(mainMat, pr, mpx, SHADE_MAIN * 0.3, false, 1) });
    paints.sort((a, b) => b.area - a.area);
    const tpaint = performance.now();
    this.ready = Promise.all(paints.map(p => p.run())).then(() => { this.buildTimes.paintAsync = performance.now() - tpaint; });
    const tt0 = performance.now();
    this.buildTrees(h, xmin, xmax, zmin, zmax);
    this.buildTimes.trees = performance.now() - tt0;
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
    // Instanced, 3 variants each of pine and deciduous; geometry is unit-sized so each instance
    // is scaled to exactly the sim's collision volume.
    const leafTex = this.leafTex || (this.leafTex = leafTexture());
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: leafTex, roughness: 0.85, side: THREE.DoubleSide });
    const needleMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.needleTex || (this.needleTex = needleTexture()), roughness: 0.9, side: THREE.DoubleSide });
    const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    // LOD: detailed meshes for the in-play trees (they can be right next to the camera), cheap
    // ones for the decorative out-of-bounds forest.
    const geos = this.treeGeos || (this.treeGeos = {
      pine: [11, 22, 33].map(s => pineCrown(s, 0)), round: [44, 55, 66].map(s => roundCrown(s, 0)),
      pineLo: [11, 22, 33].map(s => pineCrown(s, 1)), roundLo: [44, 55, 66].map(s => roundCrown(s, 1)),
      trunk: trunkGeometry(false, 7),
    });
    const m4 = new THREE.Matrix4(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    const mk = (geo, mat, n) => { const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n)); im.count = n; im.castShadow = true; im.receiveShadow = true; this.holeGroup.add(im); return im; };
    const trunks = mk(geos.trunk, barkMat, list.length);
    const buckets = { pine: [[], [], []], round: [[], [], []], pineLo: [[], [], []], roundLo: [[], [], []] };
    const nPlay = h.trees.length;
    list.forEach((t, i) => {
      const kind = t.type === 'pine' ? 'pine' : 'round';
      buckets[kind + (i < nPlay ? '' : 'Lo')][Math.floor(hashf(t.x * 1.3, t.z * 0.7) * 3) % 3].push(t);
      const trunkH = kind === 'pine' ? t.crownBase + 1.3 : t.crownY + 0.3;
      m4.compose(new THREE.Vector3(t.x, t.y0 - 0.3, t.z), new THREE.Quaternion(), new THREE.Vector3(t.trunkR, trunkH, t.trunkR));
      trunks.setMatrixAt(i, m4);
    });
    for (const kind of ['pine', 'round', 'pineLo', 'roundLo']) {
      const isPine = kind.startsWith('pine');
      buckets[kind].forEach((arr, v) => {
        const im = mk(geos[kind][v], isPine ? needleMat : leafMat, arr.length);
        arr.forEach((t, i) => {
          const q = new THREE.Quaternion().setFromAxisAngle(up, hashf(t.x, t.z) * 6.28);
          if (isPine) m4.compose(new THREE.Vector3(t.x, t.y0 + t.crownBase, t.z), q, new THREE.Vector3(t.crownR, t.crownTop - t.crownBase, t.crownR));
          else m4.compose(new THREE.Vector3(t.x, t.y0 + t.crownY, t.z), q, new THREE.Vector3(t.crownR, t.crownRy, t.crownR));
          im.setMatrixAt(i, m4);
          const r = hashf(t.z, t.x), b = 0.92 + r * 0.25;
          col.setRGB(b * (0.95 + r * 0.1), b, b * (0.9 + (1 - r) * 0.15)); im.setColorAt(i, col);
        });
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      });
    }
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
      img.data[o] = c255(0.23 * (1 + n)); img.data[o + 1] = c255(0.5 * (1 + n)); img.data[o + 2] = c255(0.16 * (1 + n)); img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
    return t;
  }

  /** RGBA pixel array -> sRGB DataTexture with mipmaps. */
  pixelsToTex(W, H, data) {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  }

  /** Queue a texture paint; when done, assign to mat (and optional grid variant). */
  paintInto(mat, r, px, shadeAmt, withGrid, hstep, onDone) {
    const h = this.game.hole, gen = this.buildGen;
    const job = { r: { xmin: r.xmin, xmax: r.xmax, zmin: r.zmin, zmax: r.zmax }, px, shadeAmt, withGrid, hstep, light: { x: SUN_DIR.x, y: SUN_DIR.y, z: SUN_DIR.z } };
    return this.pool.run(this.paramsKey, this.paramsClean, job, h).then(o => {
      if (gen !== this.buildGen) return;   // a newer hole replaced this one
      const plain = this.pixelsToTex(o.W, o.H, o.a), grid = o.b ? this.pixelsToTex(o.W, o.H, o.b) : null;
      if (onDone) onDone(plain, grid); else mat.map = plain;
      mat.color.set(0xffffff); mat.needsUpdate = true;
    });
  }

  toTex(c) {
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  setGrid(on) {
    this.showGrid = on;
    if (this.greenTex) { this.greenMat.map = on ? this.greenTex.grid : this.greenTex.plain; this.greenMat.needsUpdate = true; }
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
    const hit = rc.intersectObjects(this.pickMeshes, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }
}

/** Small pool of module workers running paintPixels (falls back to the main thread). */
class PaintPool {
  constructor(n) {
    this.jobs = new Map(); this.next = 1; this.queue = []; this.idle = [];
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./paint.worker.js', import.meta.url), { type: 'module' });
        w.onmessage = e => { const j = this.jobs.get(e.data.id); this.jobs.delete(e.data.id); this.idle.push(w); this.pump(); j.resolve(e.data); };
        w.onerror = e => { console.error('paint worker error', e.message); };
        this.idle.push(w);
      }
    } catch (err) { this.idle = []; }
    this.workers = this.idle.length;
  }
  run(key, params, job, hole) {
    if (!this.workers) { const o = paintPixels(hole, job.r, job.px, job.shadeAmt, job.withGrid, job.hstep, job.light); return Promise.resolve(o); }
    return new Promise(resolve => { const id = this.next++; this.jobs.set(id, { resolve }); this.queue.push({ id, key, params, job }); this.pump(); });
  }
  pump() { while (this.idle.length && this.queue.length) this.idle.pop().postMessage(this.queue.shift()); }
}

/** Axis: uniform `step` spacing over [min, max] (min/max are grid lines), growing spacing outside to +-margin. */
function axis(min, max, step, margin) {
  const out = [], lo = [];
  let s = step;
  for (let u = min - s; u > min - margin; u -= s, s *= 1.09) lo.push(u);
  out.push(...lo.reverse());
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) out.push(min + i * step);
  s = step;
  for (let u = max + s; u < max + margin; u += s, s *= 1.09) out.push(u);
  return out;
}

/** Exaggerated normals for a (possibly non-uniform) height grid. */
function gridNormals(H, NX, NZ, X, Z) {
  const nrm = new Float32Array(NX * NZ * 3);
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      const i0 = Math.max(0, i - 1), i1 = Math.min(NX - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NZ - 1, j + 1);
      const gx = (H[j * NX + i1] - H[j * NX + i0]) / (X(i1) - X(i0));
      const gz = (H[j1 * NX + i] - H[j0 * NX + i]) / (Z(j1) - Z(j0));
      const nx = -gx * NORMAL_EXAGGERATION, nz = -gz * NORMAL_EXAGGERATION, L = Math.sqrt(nx * nx + 1 + nz * nz);
      nrm[k * 3] = nx / L; nrm[k * 3 + 1] = 1 / L; nrm[k * 3 + 2] = nz / L;
    }
  }
  return nrm;
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

export { radialTexture };
