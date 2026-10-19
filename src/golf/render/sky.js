// Sky dome with sun, cartoon clouds that drift with the wind, and layered horizon scenery
// (mountains, hills, distant tree line). Render-only; seeded so screenshots are stable.
import * as THREE from 'three';
import { mulberry32 } from '../../sim/rng.js';

export const SUN_DIR = new THREE.Vector3(0.42, 0.24, 0.87).normalize();  // ahead-left of the tee, low enough to be in view
// Light direction: same azimuth as the visible sun but higher, so shadows stay short and friendly.
export const LIGHT_DIR = new THREE.Vector3(0.42, 0.68, 0.87).normalize();
export const HORIZON = new THREE.Color(0xe2f1fc);
const ZENITH = new THREE.Color(0x3d9cf0);

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    // Gradient dome + sun glow (shader so it's cheap and smooth)
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { horizon: { value: HORIZON }, zenith: { value: ZENITH }, sunDir: { value: SUN_DIR } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(horizon, zenith, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          col += vec3(1.0, 0.85, 0.55) * (pow(s, 12.0) * 0.35 + pow(s, 200.0) * 0.6);
          if (vDir.y < 0.0) col = horizon;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(4500, 32, 16), domeMat);
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    // Sun disk (cartoon: solid disk + soft halo sprite)
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff6d0, fog: false });
    this.sun = new THREE.Mesh(new THREE.CircleGeometry(95, 48), sunMat);
    this.sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,240,190,0.85)', 'rgba(255,220,150,0)'), fog: false, depthWrite: false, transparent: true }));
    this.sunHalo.scale.set(700, 700, 1);
    this.group.add(this.sun, this.sunHalo);

    this.domeMat = domeMat;
    this.clouds = [];
    this.horizon = new THREE.Group();
    this.group.add(this.horizon);
  }

  /** Rebuild seeded scenery around a center point (hole midpoint). */
  build(seed, center, wind = { x: 1, z: 0.35 }) {
    this.center = center.clone();
    const rand = mulberry32((seed * 2654435761) >>> 0);
    for (const c of this.clouds) { this.group.remove(c.mesh); }
    this.clouds = [];
    for (const o of [...this.horizon.children]) { this.horizon.remove(o); o.geometry?.dispose(); }

    // Clouds: puffy clusters of spheres with toon shading
    const grad = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]), 3, 1);
    grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
    const cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: grad, fog: false, emissive: 0x6a7f99, emissiveIntensity: 0.35 });
    const puff = new THREE.IcosahedronGeometry(1, 2);
    // clouds drift with the hole's wind (exaggerated a bit so it reads at cloud distance)
    const wl = Math.hypot(wind.x, wind.z) || 1;
    this.wind = new THREE.Vector3(wind.x / wl, 0, wind.z / wl).multiplyScalar(6 + wl * 1.6);
    for (let i = 0; i < 26; i++) {
      const g = new THREE.Group();
      const n = 5 + Math.floor(rand() * 6), w = 50 + rand() * 90;
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(puff, cloudMat);
        const t = n === 1 ? 0.5 : k / (n - 1);
        const r = w * (0.25 + 0.3 * Math.sin(Math.PI * t)) * (0.8 + rand() * 0.4);
        m.position.set((t - 0.5) * w * 1.6, r * 0.35 + rand() * w * 0.1, (rand() - 0.5) * w * 0.5);
        m.scale.set(r, r * 0.8, r);
        g.add(m);
      }
      const ang = rand() * Math.PI * 2, rad = 500 + rand() * 2300;
      g.position.set(center.x + Math.cos(ang) * rad, 260 + rand() * 300, center.z + Math.sin(ang) * rad);
      g.rotation.y = rand() * Math.PI;
      this.group.add(g);
      this.clouds.push({ mesh: g });
    }

    // Horizon layers: far mountains (with snow), mid hills, near tree line
    this.horizon.add(ring(center, 2900, 256, rand, 220, 650, 0x93a9cf, 0xd2def0, true));
    this.horizon.add(ring(center, 1900, 192, rand, 70, 230, 0x7fb08f, 0xc0d8cc, false));
    this.horizon.add(ring(center, 900, 256, rand, 18, 38, 0x3f7a45, 0x7aa585, false, true));
    this.horizon.add(ring(center, 620, 320, rand, 22, 48, 0x356b3a, 0x5f8f66, false, true));
  }

  /** Prefiltered sky environment map (for water reflections). */
  envMap(renderer) {
    if (this._env) return this._env;
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.domeMat));
    const pm = new THREE.PMREMGenerator(renderer);
    this._env = pm.fromScene(sc, 0, 0.1, 500).texture;
    pm.dispose();
    return this._env;
  }

  update(dt, camera) {
    // keep dome & sun centered on the camera so they're "at infinity"
    this.dome.position.copy(camera.position);
    const sp = camera.position.clone().addScaledVector(SUN_DIR, 3800);
    this.sun.position.copy(sp); this.sun.lookAt(camera.position);
    this.sunHalo.position.copy(sp);
    if (!this.center) return;
    for (const c of this.clouds) {
      c.mesh.position.addScaledVector(this.wind, dt);
      const dx = c.mesh.position.x - this.center.x, dz = c.mesh.position.z - this.center.z;
      const along = (dx * this.wind.x + dz * this.wind.z) / this.wind.length();
      if (along > 2800) c.mesh.position.addScaledVector(this.wind, -5600 / this.wind.length());
    }
  }
}

function ring(center, R, N, rand, hMin, hMax, colTop, colBottom, snow, bumpy = false) {
  // ROWS rows of vertices per column so the vertical color gradient interpolates smoothly
  const ROWS = 8;
  const pos = [], col = [], idx = [];
  const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const top = new THREE.Color(colTop), bot = new THREE.Color(colBottom), white = new THREE.Color(0xf4f7fb);
  const c = new THREE.Color();
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    let n = 0.5 + 0.25 * Math.sin(a * 3 + ph[0]) + 0.15 * Math.sin(a * 7 + ph[1]) + 0.08 * Math.sin(a * 17 + ph[2]) + 0.05 * Math.sin(a * 41 + ph[3]);
    if (bumpy) n = 0.4 + 0.6 * Math.abs(Math.sin(a * 140 + ph[0])) * (0.7 + 0.3 * Math.sin(a * 23 + ph[1]));
    n += (rand() - 0.5) * (bumpy ? 0.25 : 0.04);
    n = Math.max(0, Math.min(1, n));
    const h = hMin + (hMax - hMin) * n;
    const x = center.x + Math.cos(a) * R, z = center.z + Math.sin(a) * R;
    for (let r = 0; r <= ROWS; r++) {
      const t = r / ROWS, y = -60 + (h + 60) * t;
      pos.push(x, y, z);
      c.copy(bot).lerp(top, Math.pow(t, 0.7));
      if (snow && n > 0.7 && t > 0.82) c.lerp(white, Math.min(1, (n - 0.7) * 5) * (t - 0.82) / 0.18);
      col.push(c.r, c.g, c.b);
    }
    if (i < N) for (let r = 0; r < ROWS; r++) {
      const k = i * (ROWS + 1) + r, k2 = k + ROWS + 1;
      idx.push(k, k + 1, k2, k + 1, k2 + 1, k2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  mesh.renderOrder = -5;
  return mesh;
}

export function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
