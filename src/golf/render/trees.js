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
      const g = new THREE.ConeGeometry(r, h, BR * (lod ? 2 : 4), lod ? 1 : 3, true);
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
