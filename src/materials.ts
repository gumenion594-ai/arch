// How materials look in the Detailed view: small drawn textures at real size (1 texture tile = 1 m × 1 m),
// light and greyish so a colour can tint them (the wall's colour from the Structure tab).
import * as THREE from 'three';
import { MATERIALS } from './model';

const cache = new Map<string, THREE.Texture>();
const PX = 512; // pixels per metre

function rng(seed: number) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
const grey = (v: number) => `rgb(${v},${v},${v})`;

function draw(key: string): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = PX;
  const g = c.getContext('2d')!, r = rng(key.length * 977 + 13);
  const noise = (amount: number, size = 2) => {
    for (let i = 0; i < (PX * PX) / (size * size * 3); i++) {
      const v = Math.round(255 - r() * amount);
      g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.fillRect(r() * PX, r() * PX, size, size);
    }
  };
  if (key === 'brick') {
    // running bond: 21.5 × 6.5 cm bricks, 1 cm joints
    g.fillStyle = grey(236); g.fillRect(0, 0, PX, PX);
    const bw = 0.225 * PX, bh = 0.075 * PX, j = 0.01 * PX;
    for (let row = 0; row * bh < PX + bh; row++) for (let x = (row % 2) * -bw / 2; x < PX; x += bw) {
      g.fillStyle = grey(Math.round(190 + r() * 40)); g.fillRect(x + j / 2, row * bh + j / 2, bw - j, bh - j);
    }
    noise(60, 2);
  } else if (key === 'stone') {
    // ashlar: courses of 50 cm blocks of varying length, fine joints
    g.fillStyle = grey(210); g.fillRect(0, 0, PX, PX);
    const ch = 0.25 * PX, j = 0.008 * PX;
    for (let y = 0; y < PX; y += ch) {
      let x = -r() * 0.3 * PX;
      while (x < PX) { const w = (0.35 + r() * 0.4) * PX; g.fillStyle = grey(Math.round(215 + r() * 30)); g.fillRect(x + j, y + j, w - 2 * j, ch - 2 * j); x += w; }
    }
    noise(70, 3);
  } else if (key === 'metal') {
    // standing seams every 50 cm
    g.fillStyle = grey(225); g.fillRect(0, 0, PX, PX);
    for (let x = 0; x < PX; x += 0.5 * PX) {
      g.fillStyle = grey(250); g.fillRect(x, 0, 0.012 * PX, PX);
      g.fillStyle = grey(170); g.fillRect(x + 0.012 * PX, 0, 0.008 * PX, PX);
    }
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, r() * PX, PX, 1); }
  } else if (key === 'concrete' || key === 'aerated') {
    g.fillStyle = grey(232); g.fillRect(0, 0, PX, PX);
    noise(key === 'aerated' ? 50 : 90, key === 'aerated' ? 4 : 2);
    if (key === 'concrete') { g.fillStyle = grey(150); for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { g.beginPath(); g.arc(x * PX, y * PX, 0.012 * PX, 0, Math.PI * 2); g.fill(); } }
    if (key === 'aerated') { g.strokeStyle = grey(200); g.lineWidth = 2; for (let y = 0; y < PX; y += 0.25 * PX) { g.beginPath(); g.moveTo(0, y); g.lineTo(PX, y); g.stroke(); } }
  } else if (key === 'timber') {
    g.fillStyle = grey(225); g.fillRect(0, 0, PX, PX);
    for (let y = 0; y < PX; y += 3) { g.fillStyle = `rgba(120,120,120,${0.05 + r() * 0.12})`; g.fillRect(0, y + Math.sin(y * 0.05) * 3, PX, 1); }
  } else {
    g.fillStyle = grey(235); g.fillRect(0, 0, PX, PX);
    noise(30, 2);
  }
  return c;
}

/** The look of a material, tinted by a colour (the wall's colour, else the material's own). */
export function materialLook(key: string, color?: string | null): THREE.Material {
  let tex = cache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(draw(key));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    cache.set(key, tex);
  }
  const base = new THREE.Color(color ?? MATERIALS[key]?.color ?? 0xd8d2c4);
  return new THREE.MeshStandardMaterial({
    map: tex, color: base, side: THREE.DoubleSide,
    roughness: key === 'metal' || key === 'steel' ? 0.45 : key === 'glass' ? 0.1 : 0.9, metalness: key === 'metal' || key === 'steel' ? 0.4 : 0,
    transparent: key === 'glass', opacity: key === 'glass' ? 0.45 : 1,
  });
}
