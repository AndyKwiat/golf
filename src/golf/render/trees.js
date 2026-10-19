// Procedural tree meshes (render-only). Geometry is built in UNIT space so instances can be
// scaled to exactly the collision volumes used by the sim:
//   pine crown:  y in [0, 1] (crownBase..crownTop), radius 1 at the bottom (cone)
//   round crown: unit ellipsoid centered at 0 (scaled by crownR / crownRy)
//   trunks:      y in [0, 1], radius 1 at the base
// Several variants of each are generated; trees are distributed across them by hash.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../sim/rng.js';

function noise3(x, y, z) {
  return Math.sin(x * 3.1 + y * 1.7) * Math.sin(y * 2.3 - z * 2.9) * Math.sin(z * 1.9 + x * 2.6);
}

function colorize(geo, fn) {
  const p = geo.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const [r, g, b] = fn(p.getX(i), p.getY(i), p.getZ(i), i); c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * Layered pine: 7 whorls of branches. Each whorl is two offset star-shaped drooping cones
 * (branch tips + gaps), darker toward the trunk, lighter at the tips.
 */
export function pineCrown(seed, lod = 0) {
  const rand = mulberry32(seed);
  const tiers = lod ? 5 : 7, parts = [];
  const BR = lod ? 9 : 13;                           // branch tips per whorl
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    for (let layer = 0; layer < (lod ? 1 : 2); layer++) {
      const y0 = f * 0.84 + layer * 0.03, h = 0.27 - f * 0.11, r = 1.08 * (1 - f * 0.84) * (layer ? 0.88 : 1);
      const g = new THREE.ConeGeometry(r, h, BR * (lod ? 2 : 3), lod ? 1 : 2, true);
      g.translate(0, y0 + h / 2, 0);
      const p = g.attributes.position;
      const ph = rand() * 6.28 + layer * Math.PI / BR;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const rr = Math.hypot(x, z);
        if (rr < 1e-4) continue;
        const a = Math.atan2(z, x), e = rr / r;      // e: 0 at the trunk, 1 at the rim
        const tri = Math.abs(((a * BR + ph) / Math.PI) % 2 - 1);   // 0 at a branch tip .. 1 in a gap
        const star = 1 - 0.32 * tri * e + 0.06 * Math.sin(a * 3 + ph * 2);
        const droop = e * e * (0.1 + 0.06 * Math.sin(a * 2 + ph)) * (1 - 0.5 * tri);
        p.setXYZ(i, x * star, y - droop, z * star);
      }
      g.computeVertexNormals();
      colorize(g, (x, y, z) => {
        const e = Math.min(1, Math.hypot(x, z) / Math.max(0.05, r));
        const k = (0.45 + 0.65 * e) * (layer ? 1.08 : 0.95) * (0.92 + 0.15 * f);
        return [0.15 * k, 0.4 * k, 0.19 * k];
      });
      parts.push(g.toNonIndexed());
    }
  }
  const tip = new THREE.ConeGeometry(0.06, 0.16, 8).translate(0, 0.95, 0);
  colorize(tip, () => [0.2, 0.5, 0.24]);
  parts.push(tip.toNonIndexed());
  return mergeGeometries(parts);
}

/** Needle texture for pines (short dark/light strokes), tiled around each whorl. */
export function needleTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#c9dcc0'; x.fillRect(0, 0, S, S);
  const rand = mulberry32(5);
  x.lineCap = 'round';
  for (let i = 0; i < 3000; i++) {
    const px = rand() * S, py = rand() * S, a = 1.2 + rand() * 0.7, L = 4 + rand() * 7;
    x.strokeStyle = `hsl(${95 + rand() * 30}, ${30 + rand() * 25}%, ${45 + rand() * 45}%)`;
    x.lineWidth = 0.8 + rand();
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 2); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Lumpy deciduous crown: a cluster of noise-displaced spheres inside the unit ellipsoid. */
export function roundCrown(seed, lod = 0) {
  const rand = mulberry32(seed);
  const parts = [];
  const blobs = [{ x: 0, y: 0, z: 0, r: 0.72 }];
  const n = lod ? 4 : 6 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, el = (rand() - 0.35) * 1.2, d = 0.35 + rand() * 0.2;
    blobs.push({ x: Math.cos(a) * Math.cos(el) * d, y: Math.sin(el) * d * 0.8, z: Math.sin(a) * Math.cos(el) * d, r: 0.42 + rand() * 0.2 });
  }
  const hue = rand() * 0.04;
  for (const b of blobs) {
    const g = new THREE.IcosahedronGeometry(b.r, lod ? 1 : 2);
    const p = g.attributes.position;
    const ph = rand() * 20;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.13 * noise3(x * 4 + ph, y * 4, z * 4 - ph) + 0.06 * noise3(x * 11, y * 11 + ph, z * 11);
      p.setXYZ(i, b.x + x * k, b.y + y * k, b.z + z * k);
    }
    g.computeVertexNormals();
    const shade = 0.85 + rand() * 0.3;
    colorize(g, (x, y, z) => {
      const out = Math.min(1, Math.hypot(x, y * 1.1, z) / 0.95);   // outer surface lighter
      const ao = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.9) / 1.4)); // darker underneath
      const k = shade * ao * (0.6 + 0.5 * out);
      return [(0.2 + hue) * k, 0.46 * k, 0.15 * k];
    });
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  // keep inside the unit ellipsoid used for collisions
  const geo = mergeGeometries(parts);
  geo.computeBoundingBox();
  const bb = geo.boundingBox, s = 1 / Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z, -bb.min.y, bb.max.y);
  geo.scale(s * 1.05, s * 1.05, s * 1.05);
  return geo;
}

/** Tapered trunk; for round trees a few branches reach up into the crown. */
export function trunkGeometry(withBranches, seed) {
  const rand = mulberry32(seed);
  const parts = [new THREE.CylinderGeometry(0.55, 1, 1, 9, 3).translate(0, 0.5, 0)];
  if (withBranches) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rand();
      const br = new THREE.CylinderGeometry(0.18, 0.32, 0.55, 6).translate(0, 0.27, 0);
      br.rotateZ(0.6 + rand() * 0.3); br.rotateY(a);
      br.translate(0, 0.72 + rand() * 0.15, 0);
      parts.push(br);
    }
  }
  const geo = mergeGeometries(parts.map(g => g.toNonIndexed()));
  geo.computeVertexNormals();
  colorize(geo, (x, y, z) => { const k = 0.75 + 0.35 * Math.sin(y * 30 + Math.atan2(z, x) * 3) * 0.3 + y * 0.2; return [0.36 * k, 0.25 * k, 0.16 * k]; });
  return geo;
}

/** Speckled leaf texture to break up the crowns at close range. */
export function leafTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#d8e8c8'; x.fillRect(0, 0, S, S);
  const rand = mulberry32(99);
  for (let i = 0; i < 2600; i++) {
    const l = 55 + rand() * 45, px = rand() * S, py = rand() * S, r = 1.5 + rand() * 3.5;
    x.fillStyle = `hsl(${85 + rand() * 30}, ${35 + rand() * 30}%, ${l}%)`;
    x.beginPath(); x.ellipse(px, py, r, r * 0.6, rand() * 3.14, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Additional species + level-of-detail variants. All crowns are unit-space like the originals.

/** Coast redwood: tall narrow cone of many short drooping whorls (unit: y 0..1, radius 1 at base). */
export function redwoodCrown(seed, lod = 0) {
  const rand = mulberry32(seed);
  const tiers = lod ? 7 : 12, BR = lod ? 8 : 11, parts = [];
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers, y0 = f * 0.9, h = 0.16 - f * 0.05, r = 1.0 * (1 - f * 0.8) * (0.85 + 0.3 * rand());
    const g = new THREE.ConeGeometry(r, h, BR * (lod ? 2 : 3), 1, true).translate(0, y0 + h / 2, 0);
    const p = g.attributes.position, ph = rand() * 6.28;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), rr = Math.hypot(x, z);
      if (rr < 1e-4) continue;
      const a = Math.atan2(z, x), e = rr / r, tri = Math.abs(((a * BR + ph) / Math.PI) % 2 - 1);
      const star = 1 - 0.35 * tri * e;
      p.setXYZ(i, x * star, y - e * e * 0.05, z * star);
    }
    g.computeVertexNormals();
    colorize(g, (x, y, z) => { const e = Math.min(1, Math.hypot(x, z) / Math.max(0.05, r)); const k = 0.45 + 0.6 * e; return [0.13 * k, 0.33 * k, 0.17 * k]; });
    parts.push(g.toNonIndexed());
  }
  return mergeGeometries(parts);
}

/** Generic lumpy crown with options (used for round / poplar / birch). Unit ellipsoid. */
export function blobCrown(seed, { lod = 0, blobs = 7, spreadY = 0.8, spreadXZ = 1, color = [0.2, 0.46, 0.15], blobR = [0.42, 0.62] } = {}) {
  const rand = mulberry32(seed);
  const n = lod ? Math.max(3, Math.round(blobs / 2)) : blobs, parts = [];
  const list = [{ x: 0, y: 0, z: 0, r: 0.7 }];
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, el = (rand() - 0.4) * 1.3, d = 0.32 + rand() * 0.25;
    list.push({ x: Math.cos(a) * Math.cos(el) * d * spreadXZ, y: Math.sin(el) * d * spreadY + (rand() - 0.5) * (spreadY - 0.8), z: Math.sin(a) * Math.cos(el) * d * spreadXZ, r: blobR[0] + rand() * (blobR[1] - blobR[0]) });
  }
  for (const b of list) {
    const g = new THREE.IcosahedronGeometry(b.r, lod ? 1 : 2);
    const p = g.attributes.position, ph = rand() * 20;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.14 * noise3(x * 4 + ph, y * 4, z * 4 - ph) + 0.06 * noise3(x * 11, y * 11 + ph, z * 11);
      p.setXYZ(i, b.x + x * k, b.y + y * k, b.z + z * k);
    }
    g.computeVertexNormals();
    const shade = 0.85 + rand() * 0.3;
    colorize(g, (x, y, z) => {
      const out = Math.min(1, Math.hypot(x, y * 1.1, z) / 0.95), ao = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.9) / 1.4));
      const k = shade * ao * (0.6 + 0.5 * out);
      return [color[0] * k, color[1] * k, color[2] * k];
    });
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  const geo = mergeGeometries(parts);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.scale(1.05 / Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), 1.05 / Math.max(-bb.min.y, bb.max.y), 1.05 / Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z));
  return geo;
}

/** Ultra-cheap far-forest crowns (~20-30 triangles). kind: 'cone' | 'blob'. */
export function farCrown(kind, color) {
  const g = kind === 'cone' ? new THREE.ConeGeometry(1, 1, 7, 1).translate(0, 0.5, 0) : new THREE.IcosahedronGeometry(1, 0);
  const geo = g.index ? g.toNonIndexed() : g;
  geo.computeVertexNormals();
  return colorize(geo, (x, y) => { const k = 0.7 + 0.35 * (kind === 'cone' ? 1 - y : (y + 1) / 2); return [color[0] * k, color[1] * k, color[2] * k]; });
}

/** Neutral (light grey) trunk so per-instance color can tint it to any bark (brown, red, birch white). */
export function barkTrunk(lod = 0) {
  const g = new THREE.CylinderGeometry(0.55, 1, 1, lod === 2 ? 3 : lod ? 5 : 9, lod ? 1 : 3, lod === 2).translate(0, 0.5, 0).toNonIndexed();
  g.computeVertexNormals();
  return colorize(g, (x, y, z) => { const k = 0.8 + 0.2 * Math.sin(y * 40 + Math.atan2(z, x) * 5) * 0.5; return [k, k, k]; });
}

/** Bush: 3-4 merged lumpy blobs (unit: ~1 m across, sitting on y = 0). */
export function bushGeometry(seed) {
  const rand = mulberry32(seed), parts = [];
  for (let i = 0; i < 3 + Math.floor(rand() * 2); i++) {
    const r = 0.35 + rand() * 0.25, g = new THREE.IcosahedronGeometry(r, 0);
    const p = g.attributes.position, ox = (rand() - 0.5) * 0.6, oz = (rand() - 0.5) * 0.6;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k), n = 1 + 0.18 * noise3(x * 6, y * 6, z * 6);
      p.setXYZ(k, ox + x * n, Math.max(0, r * 0.6 + y * n * 0.8), oz + z * n);
    }
    g.computeVertexNormals();
    colorize(g, (x, y) => { const k = 0.55 + 0.6 * Math.min(1, y / 0.8); return [0.17 * k, 0.4 * k, 0.13 * k]; });
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  return mergeGeometries(parts);
}

/** Rock: flattened noisy icosahedron (unit ~1 m). */
export function rockGeometry(seed) {
  const rand = mulberry32(seed), g = new THREE.IcosahedronGeometry(0.5, 1), p = g.attributes.position, ph = rand() * 9;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k), n = 1 + 0.25 * noise3(x * 3 + ph, y * 3, z * 3);
    p.setXYZ(k, x * n * 1.2, y * n * 0.55 + 0.12, z * n);
  }
  g.computeVertexNormals();
  return colorize(g, (x, y) => { const k = 0.75 + 0.3 * y; return [0.52 * k, 0.5 * k, 0.47 * k]; });
}

/**
 * Reed / cattail clump: thin tapered blades 0.7-1.8 m tall with a few brown cattail heads.
 * Vertex attribute `sway` (0 at the base, 1 at the tip) drives the wind sway shader.
 */
export function reedClump(seed) {
  const rand = mulberry32(seed), pos = [], col = [], sway = [];
  const blade = (bx, bz, h, w, lean, a) => {
    const segs = 4, ca = Math.cos(a), sa = Math.sin(a);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const y0 = t0 * h, y1 = t1 * h, w0 = w * (1 - t0), w1 = w * (1 - t1);
      const l0 = lean * t0 * t0 * h, l1 = lean * t1 * t1 * h;
      const P = (t, ww, l, y) => [bx + ca * l - sa * ww, y, bz + sa * l + ca * ww];
      const A = P(t0, -w0, l0, y0), B = P(t0, w0, l0, y0), C = P(t1, -w1, l1, y1), D = P(t1, w1, l1, y1);
      pos.push(...A, ...B, ...C, ...B, ...D, ...C);
      for (const t of [t0, t0, t1, t0, t1, t1]) { const k = 0.6 + 0.6 * t; col.push(0.3 * k + 0.1 * t, 0.5 * k, 0.15 * k); sway.push(t); }
    }
  };
  const n = 9 + Math.floor(rand() * 7);
  for (let i = 0; i < n; i++) blade((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, 0.7 + rand() * 1.1, 0.02 + rand() * 0.015, (rand() - 0.5) * 0.5, rand() * Math.PI);
  // cattail heads: small brown boxes near the top of a couple of stems
  const heads = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < heads; i++) {
    const x = (rand() - 0.5) * 0.3, z = (rand() - 0.5) * 0.3, h = 1.3 + rand() * 0.5;
    blade(x, z, h, 0.008, 0, rand() * 3);   // stem
    const hg = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6).translate(x, h - 0.12, z).toNonIndexed();
    const p = hg.attributes.position;
    for (let k = 0; k < p.count; k++) { pos.push(p.getX(k), p.getY(k), p.getZ(k)); col.push(0.36, 0.22, 0.12); sway.push(p.getY(k) / 1.8); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
  g.computeVertexNormals();
  return g;
}

/** Material for reeds: double-sided, vertex colors, wind sway in the vertex shader. */
export function reedMaterial(windDir) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
  m.userData.time = { value: 0 };
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = m.userData.time;
    sh.uniforms.uWind = { value: new THREE.Vector2(windDir.x, windDir.y) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float uTime;\nuniform vec2 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float iph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
        #else
          float iph = 0.0;
        #endif
        float sw = sway * sway * (0.12 + 0.06 * sin(uTime * 1.7 + iph)) ;
        transformed.x += uWind.x * sw + 0.03 * sway * sin(uTime * 3.1 + iph * 2.0);
        transformed.z += uWind.y * sw + 0.03 * sway * cos(uTime * 2.7 + iph);`);
  };
  return m;
}

/** Tileable ripple normal map for water (animated by scrolling its offset). */
export function waterNormalTexture() {
  const S = 256, h = new Float32Array(S * S);
  const rand = mulberry32(77), waves = [];
  for (let i = 0; i < 9; i++) waves.push({ kx: Math.round((rand() - 0.5) * 12), kz: Math.round((rand() - 0.5) * 12) || 1, p: rand() * 6.28, a: 0.4 + rand() });
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    let v = 0; for (const w of waves) v += w.a * Math.sin((w.kx * i + w.kz * j) / S * Math.PI * 2 + w.p);
    h[j * S + i] = v;
  }
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), img = x.createImageData(S, S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const dx = h[j * S + (i + 1) % S] - h[j * S + (i + S - 1) % S], dz = h[((j + 1) % S) * S + i] - h[((j + S - 1) % S) * S + i];
    const nx = -dx * 0.6, nz = -dz * 0.6, L = Math.hypot(nx, nz, 1), o = (j * S + i) * 4;
    img.data[o] = (nx / L * 0.5 + 0.5) * 255; img.data[o + 1] = (nz / L * 0.5 + 0.5) * 255; img.data[o + 2] = (1 / L * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
