// Built-in designs generated in code (no file to import): an Ionic column.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DesignCategory } from './model';

/** Classic Ionic column: Attic base, fluted shaft with entasis, capital with volutes, echinus and abacus. Height ≈ 9 diameters. */
export function ionicColumn(): THREE.Object3D {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.65, side: THREE.DoubleSide });
  const D = 1, R = D / 2; // lower shaft diameter / radius
  const add = (geo: THREE.BufferGeometry, y = 0) => { geo.translate(0, y, 0); geo.computeVertexNormals(); g.add(new THREE.Mesh(geo, stone)); };

  // --- Attic base: square plinth, lower torus, scotia, upper torus, fillet
  const plinthH = 0.18, plinthW = D * 1.45;
  add(new THREE.BoxGeometry(plinthW, plinthH, plinthW), plinthH / 2);
  const base: [number, number][] = [
    [0, 0], [0.7, 0], [0.72, 0.03], [0.73, 0.08], [0.71, 0.13], [0.66, 0.155], // lower torus
    [0.6, 0.16], [0.56, 0.19], [0.555, 0.23], [0.57, 0.26], // scotia (hollow)
    [0.6, 0.27], [0.62, 0.3], [0.61, 0.33], [0.57, 0.355], // upper torus
    [0.53, 0.36], [0.52, 0.38], [0, 0.38],
  ];
  add(new THREE.LatheGeometry(base.map(([r, y]) => new THREE.Vector2(r * D, y * D)), 48), plinthH);
  const shaftY = plinthH + 0.38 * D;

  // --- fluted shaft: 24 flutes separated by fillets, entasis (slight swelling, tapering to 5/6 at the top)
  const H = 7.1 * D, flutes = 24, seg = flutes * 6, rows = 40;
  const pos: number[] = [], idx: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows, y = t * H;
    const rad = R * (1 - (1 / 6) * Math.pow(t, 1.6)) * (1 + 0.012 * Math.sin(Math.PI * t * 0.8));
    // flutes stop just short of both ends (plain bands)
    const fl = t < 0.025 || t > 0.975 ? 0 : 1;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const f = ((k % 6) / 6); // position within one flute + fillet
      // fillet for the last 1/6, a semicircular groove for the rest
      const groove = f < 5 / 6 ? Math.sin((f / (5 / 6)) * Math.PI) : 0;
      const rr = rad - fl * groove * rad * 0.07;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  for (let r = 0; r < rows; r++) for (let k = 0; k < seg; k++) {
    const a = r * seg + k, b = r * seg + ((k + 1) % seg), c = (r + 1) * seg + ((k + 1) % seg), d = (r + 1) * seg + k;
    idx.push(a, c, b, a, d, c);
  }
  const shaft = new THREE.BufferGeometry();
  shaft.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shaft.setIndex(idx);
  add(shaft, shaftY);
  const topR = R * (5 / 6);
  const capY = shaftY + H;

  // --- astragal (bead) and echinus (egg-and-dart band, simplified as a rounded ring)
  add(new THREE.TorusGeometry(topR * 1.04, 0.03 * D, 10, 48).rotateX(Math.PI / 2), capY + 0.01);
  const echinus: [number, number][] = [[0, 0], [topR * 1.02, 0], [topR * 1.12, 0.05], [topR * 1.16, 0.11], [topR * 1.1, 0.16], [0, 0.16]];
  add(new THREE.LatheGeometry(echinus.map(([r, y]) => new THREE.Vector2(r, y * D)), 48), capY + 0.03);

  // --- volutes: a cushion (pulvinus) whose two faces are spiral scrolls, one on each side
  const scrollY = capY + 0.1 * D;
  const volR = 0.34 * D, cushionDepth = topR * 2.05;
  for (const side of [-1, 1]) {
    const cx = side * (topR * 1.18), cy = scrollY - 0.02 * D;
    // spiral band: outer edge spirals inwards 2.25 turns; the band narrows towards the eye
    const turns = 2.25, n = 140;
    const outer: THREE.Vector2[] = [], inner: THREE.Vector2[] = [];
    for (let i = 0; i <= n; i++) {
      // starts at the top and winds outwards, down and back in towards the eye (mirrored on the left)
      const t = i / n, phi = Math.PI / 2 - t * turns * Math.PI * 2;
      const r = volR * Math.pow(0.12, t * 0.75);
      const w = 0.055 * D * (1 - t * 0.6);
      const at = (rr: number) => new THREE.Vector2(cx + side * Math.cos(phi) * rr, cy + Math.sin(phi) * rr);
      const p = at(r), q = at(Math.max(0, r - w));
      outer.push(p); inner.push(q);
    }
    // the band as a ribbon, extruded through the depth of the capital (front + back faces and the rolled cushion)
    const vp: number[] = [], vi: number[] = [];
    const z0 = -cushionDepth / 2, z1 = cushionDepth / 2;
    const push = (v: THREE.Vector2, z: number) => { vp.push(v.x, v.y, z); return vp.length / 3 - 1; };
    for (let i = 0; i < n; i++) {
      const o0 = outer[i], o1 = outer[i + 1], i0 = inner[i], i1 = inner[i + 1];
      for (const z of [z0, z1]) { // spiral faces
        const a = push(o0, z), b = push(o1, z), c = push(i1, z), d = push(i0, z);
        vi.push(a, b, c, a, c, d);
      }
      // outer and inner surfaces of the roll
      for (const [p0, p1] of [[o0, o1], [i0, i1]]) {
        const a = push(p0, z0), b = push(p1, z0), c = push(p1, z1), d = push(p0, z1);
        vi.push(a, b, c, a, c, d);
      }
    }
    const vol = new THREE.BufferGeometry();
    vol.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
    vol.setIndex(vi);
    add(vol);
    // the eye of the volute and the filled spiral face (a disc behind the band)
    add(new THREE.CylinderGeometry(volR * 0.13, volR * 0.13, cushionDepth + 0.02, 20).rotateX(Math.PI / 2).translate(cx, cy, 0));
    add(new THREE.CylinderGeometry(volR * 0.92, volR * 0.92, cushionDepth * 0.9, 40).rotateX(Math.PI / 2).translate(cx, cy, 0));
  }
  // channel joining the two volutes across the front and back
  add(new THREE.BoxGeometry(topR * 2.4, 0.12 * D, cushionDepth * 0.96), scrollY + volR * 0.72);

  // --- abacus: thin square slab with a small ogee edge
  const abW = D * 1.2, abY = scrollY + volR + 0.02 * D;
  add(new THREE.BoxGeometry(abW, 0.06 * D, abW), abY + 0.03 * D);
  add(new THREE.BoxGeometry(abW * 1.04, 0.05 * D, abW * 1.04), abY + 0.085 * D);
  // base (plinth + Attic base) and top (capital) bands: these keep their size when the column is stretched
  const total = abY + 0.11 * D;
  g.userData.baseFrac = shaftY / total;
  g.userData.topFrac = (total - capY) / total;
  return g;
}

// ---------------------------------------------------------------- tall round-arched window (from a photo)
// Made around the "Tall arched window" shape: 1.4 × 3.5 m, semicircular head (spring at 80 % of the height).
// Reference frame of an opening design: x across, y up (centred on the shape), z out of the wall; z = 0 is the
// outside face of the wall (the wall is behind it), so the frame sits a little back inside the opening.
export const ARCH_WIN = { w: 1.4, h: 3.5 };
const AW = ARCH_WIN.w, AH = ARCH_WIN.h, AR = AW / 2, ACY = AH / 2 - AR; // arch radius and centre height

/** Outline of a round-headed shape: straight sides from y0 up to the springing at cy, then a half circle of radius r. */
function archShape(cx: number, r: number, y0: number, cy: number, segs = 32): THREE.Shape {
  const sh = new THREE.Shape();
  sh.moveTo(cx - r, y0); sh.lineTo(cx + r, y0); sh.lineTo(cx + r, cy);
  sh.absarc(cx, cy, r, 0, Math.PI, false);
  sh.lineTo(cx - r, y0);
  void segs;
  return sh;
}
function archPath(cx: number, r: number, y0: number, cy: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(cx - r, y0); p.lineTo(cx + r, y0); p.lineTo(cx + r, cy);
  p.absarc(cx, cy, r, 0, Math.PI, false);
  p.lineTo(cx - r, y0);
  return p;
}

/** The wooden window: frame, two casements with glazing bars, transom with dentils, two small arched lights and a round light, glass. */
export function archedWindowFrame(): THREE.Object3D {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6e4a2c, roughness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const zBack = -0.2, D = 0.12; // the frame is 12 cm deep, set 8 cm back from the face
  const extrude = (sh: THREE.Shape, depth = D, z = zBack, mat: THREE.Material = wood) => {
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 24 }), mat);
    m.position.z = z; g.add(m); return m;
  };
  const box = (x0: number, x1: number, y0: number, y1: number, depth = D, z = zBack) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, depth), wood);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, z + depth / 2); g.add(m);
  };
  const ring = (outer: THREE.Shape, inner: THREE.Path, depth = D, z = zBack) => { outer.holes.push(inner); extrude(outer, depth, z); };
  const fw = 0.07, y0 = -AH / 2;
  // outer frame (follows the opening)
  ring(archShape(0, AR, y0, ACY), archPath(0, AR - fw, y0 + fw, ACY));
  // transom with a band of dentils, at 61.5 % of the height
  const yt = y0 + 0.615 * AH, tb = 0.1;
  box(-AR + fw, AR - fw, yt - tb / 2, yt + tb / 2, D + 0.02, zBack);
  for (let x = -AR + fw + 0.04; x < AR - fw - 0.03; x += 0.06) box(x, x + 0.03, yt - 0.035, yt + 0.005, 0.025, zBack + D + 0.02);
  // two casements below: a sash frame each, a mullion between, glazing bars (three panes left, two right, as in the photo)
  const sx = 0.035, ib = y0 + fw, it = yt - tb / 2;
  box(-sx, sx, ib, it); // mullion
  for (const [a, b] of [[-AR + fw, -sx], [sx, AR - fw]]) {
    const sh = new THREE.Shape([new THREE.Vector2(a, ib), new THREE.Vector2(b, ib), new THREE.Vector2(b, it), new THREE.Vector2(a, it)]);
    sh.holes.push(new THREE.Path([new THREE.Vector2(a + 0.05, ib + 0.05), new THREE.Vector2(a + 0.05, it - 0.05), new THREE.Vector2(b - 0.05, it - 0.05), new THREE.Vector2(b - 0.05, ib + 0.05)]));
    extrude(sh, D - 0.02, zBack + 0.01);
  }
  const bar = (a: number, b: number, f: number) => box(a, b, y0 + f * AH - 0.02, y0 + f * AH + 0.02, D - 0.04, zBack + 0.02);
  bar(-AR + fw, -sx, 0.43); bar(-AR + fw, -sx, 0.21); bar(sx, AR - fw, 0.43);
  // above the transom: a mullion up to the round light, two small round-arched lights and the round light
  const yu = yt + tb / 2, lr = 0.22, lcx = 0.3, lspring = yu + 0.36;
  box(-sx, sx, yu, lspring + lr + 0.05);
  for (const cx of [-lcx, lcx]) ring(archShape(cx, lr + 0.04, yu, lspring), archPath(cx, lr - 0.01, yu + 0.05, lspring), D - 0.02, zBack + 0.01);
  const ccy = ACY + 0.3, cr = 0.21;
  const circ = new THREE.Shape(); circ.absarc(0, ccy, cr + 0.045, 0, Math.PI * 2, false);
  const hole = new THREE.Path(); hole.absarc(0, ccy, cr, 0, Math.PI * 2, true);
  circ.holes.push(hole); extrude(circ, D - 0.02, zBack + 0.01);
  // glass, in the middle of the frame
  const pane = new THREE.Mesh(new THREE.ShapeGeometry(archShape(0, AR - fw, y0 + fw, ACY), 24), glass);
  pane.position.z = zBack + D / 2; g.add(pane);
  return g;
}

/** The stone surround: an arch of voussoirs with an outer moulding, impost blocks, panelled side strips and a sill. */
export function archedWindowSurround(): THREE.Object3D {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xdcd6ca, roughness: 0.85 });
  const extrude = (sh: THREE.Shape, depth: number) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 6 }), stone); g.add(m); return m; };
  const box = (x0: number, x1: number, y0: number, y1: number, depth: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, depth), stone);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, depth / 2); g.add(m);
  };
  const y0 = -AH / 2, ri = AR + 0.04, ro = AR + 0.3;
  // the arch: 13 voussoirs with thin joints between them
  const n = 13, gap = 0.006;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI + gap, a1 = ((k + 1) / n) * Math.PI - gap;
    const sh = new THREE.Shape();
    sh.moveTo(ri * Math.cos(a0), ACY + ri * Math.sin(a0));
    sh.absarc(0, ACY, ro, a0, a1, false);
    sh.lineTo(ri * Math.cos(a1), ACY + ri * Math.sin(a1));
    sh.absarc(0, ACY, ri, a1, a0, true);
    extrude(sh, 0.07);
  }
  // outer moulding round the arch, standing a little further out
  const mo = new THREE.Shape(); mo.absarc(0, ACY, ro + 0.07, 0, Math.PI, false); mo.absarc(0, ACY, ro, Math.PI, 0, true);
  extrude(mo, 0.1);
  // impost blocks at the springing, and the side strips below them (a raised frame round a recessed panel)
  const xi = ri, xo = ro + 0.07, yImp = ACY - 0.13;
  for (const s of [-1, 1]) {
    const [a, b] = s < 0 ? [-xo - 0.04, -xi + 0.02] : [xi - 0.02, xo + 0.04];
    box(a, b, yImp, ACY, 0.12);
    const [c, d] = s < 0 ? [-xo, -xi] : [xi, xo];
    box(c, c + 0.05, y0, yImp, 0.07); box(d - 0.05, d, y0, yImp, 0.07);
    box(c, d, y0, y0 + 0.05, 0.07); box(c, d, yImp - 0.05, yImp, 0.07);
    box(c + 0.05, d - 0.05, y0 + 0.05, yImp - 0.05, 0.03);
  }
  // sill
  box(-xo - 0.1, xo + 0.1, y0 - 0.1, y0, 0.14);
  return g;
}


// ---------------------------------------------------------------- ready-made design models
// Each is modelled in its design type's reference frame (metres, centred on the reference box; x along the
// element, y up, z out of the wall / towards the front), so the design fits it exactly as made.

const merged = (geos: THREE.BufferGeometry[]) => { const m = mergeGeometries(geos.map(x => x.index ? x.toNonIndexed() : x)); m.computeVertexNormals(); return m; };
/** A reproducible pseudo-random number 0..1 (the same model every time). */
const rnd = (k: number) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** Brick facing for a 3 × 3 m wall division (0.3 m thick): bricks in running bond standing 12 mm out of the face; the joints show the wall. */
export function brickWall(): THREE.Object3D {
  // 13 bricks across and 40 courses up: the pattern repeats exactly every 3 m, so copies side by side join seamlessly
  const W = 3, H = 3, j = 0.01, bl = W / 13 - j, bh = H / 40 - j, z0 = 0.15 - 0.004, z1 = 0.15 + 0.012;
  const geos: THREE.BufferGeometry[] = [];
  const cols: number[] = [];
  let n = 0;
  for (let r = 0, y = -H / 2; r < 40; r++, y += bh + j) {
    const off = r % 2 ? (bl + j) / 2 : 0;
    for (let x = -W / 2 - off; x < W / 2; x += bl + j) {
      const a = Math.max(-W / 2, x), b = Math.min(W / 2, x + bl);
      if (b - a < 0.02) continue;
      const geo = new THREE.BoxGeometry(b - a, bh, z1 - z0).translate((a + b) / 2, y + j / 2 + bh / 2, (z0 + z1) / 2).toNonIndexed();
      // each brick a slightly different red-brown
      const t = rnd(++n), c = new THREE.Color().setHSL(0.03 + t * 0.025, 0.55 - t * 0.15, 0.36 + rnd(n + 0.5) * 0.12);
      for (let k = 0; k < geo.getAttribute('position').count; k++) cols.push(c.r, c.g, c.b);
      geos.push(geo);
    }
  }
  const geo = merged(geos);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 })));
  // mortar bed just behind the bricks (light grey), so the joints read as joints whatever the wall looks like
  g.add(new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.004).translate(0, 0, 0.15 - 0.002 - 0.004), new THREE.MeshStandardMaterial({ color: 0xbdb7ad, roughness: 1 })));
  return g;
}

/** Clay pan tiles for a 3 × 3 m roof division: courses of curved tiles up the slope, each overlapping the one below. */
export function roofTiles(): THREE.Object3D {
  const W = 3, H = 3, pitch = 0.2, course = 0.32, amp = 0.035, th = 0.014, n = Math.round(W / pitch) * 12;
  // the wavy cross-section of a course (x across, y out of the roof)
  const sh = new THREE.Shape();
  const wave = (x: number) => amp * (1 + Math.cos((2 * Math.PI * (x + W / 2)) / pitch)) / 2;
  sh.moveTo(-W / 2, wave(-W / 2));
  for (let k = 1; k <= n; k++) { const x = -W / 2 + (W * k) / n; sh.lineTo(x, wave(x)); }
  for (let k = n; k >= 0; k--) { const x = -W / 2 + (W * k) / n; sh.lineTo(x, wave(x) + th); }
  const geos: THREE.BufferGeometry[] = [];
  for (let y = -H / 2; y < H / 2 - 1e-6; y += 0.3) { // 10 courses: repeats every 3 m up the slope
    const len = course;
    const geo = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2); // profile y -> out (z); the extrusion runs up the slope (y)
    geo.rotateX(0.06); // the lower edge of a course lifts a little over the course below
    geo.translate(0, y, 0.15 + 0.01);
    geos.push(geo);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(merged(geos), new THREE.MeshStandardMaterial({ color: 0xa9512f, roughness: 0.8, side: THREE.DoubleSide })));
  return g;
}

/** A simple stone arch round an Arch opening (1.6 × 2.8 m, springing at 70 %): voussoirs with a keystone, impost blocks, jamb strips, plinths. */
export const SIMPLE_ARCH = { w: 1.6, h: 2.8, spring: 0.7 };
export function simpleArch(): THREE.Object3D {
  const g = new THREE.Group(), { w, h } = SIMPLE_ARCH;
  const stone = new THREE.MeshStandardMaterial({ color: 0xd9d1c2, roughness: 0.85 });
  const y0 = -h / 2, cy = y0 + h * SIMPLE_ARCH.spring, r = w / 2, ri = r + 0.02, ro = r + 0.3;
  const extrude = (sh: THREE.Shape, depth: number) => { const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 8 }), stone); g.add(m); return m; };
  const box = (x0: number, x1: number, ya: number, yb: number, depth: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, yb - ya, depth), stone);
    m.position.set((x0 + x1) / 2, (ya + yb) / 2, depth / 2); g.add(m);
  };
  // 11 voussoirs; the middle one is the keystone, taller and standing further out
  const n = 11, gap = 0.008;
  for (let k = 0; k < n; k++) {
    const key = k === (n - 1) / 2;
    const a0 = (k / n) * Math.PI + gap, a1 = ((k + 1) / n) * Math.PI - gap, o = key ? ro + 0.12 : ro;
    const sh = new THREE.Shape();
    sh.moveTo(ri * Math.cos(a0), cy + ri * Math.sin(a0));
    sh.lineTo(o * Math.cos(a0), cy + o * Math.sin(a0));
    sh.absarc(0, cy, o, a0, a1, false);
    sh.lineTo(ri * Math.cos(a1), cy + ri * Math.sin(a1));
    sh.absarc(0, cy, ri, a1, a0, true);
    extrude(sh, key ? 0.12 : 0.07);
  }
  // impost blocks at the springing, jamb strips below them, plinth blocks at the bottom
  for (const s of [-1, 1]) {
    const a = s * ri, b = s * (ro + 0.06), [x0, x1] = a < b ? [a, b] : [b, a];
    box(x0 - 0.03, x1 + 0.03, cy - 0.16, cy, 0.11);
    const [j0, j1] = s < 0 ? [-ro, -ri] : [ri, ro];
    box(j0, j1, y0 + 0.35, cy - 0.16, 0.05);
    box(j0 - 0.04, j1 + 0.04, y0, y0 + 0.35, 0.09);
  }
  return g;
}

/** A classical cornice, 3 m long: cyma recta, corona with a drip, a row of dentils, an ovolo bed moulding. Wall face at z = −0.17, top at y = 0.16. */
export function classicalCornice(): THREE.Object3D {
  const L = 3, face = -0.17, top = 0.16;
  const pts: [number, number][] = [[0, 0], [0.54, 0], [0.54, -0.03]]; // (out, down from the top)
  for (let k = 1; k <= 12; k++) { const t = k / 12; pts.push([0.42 + 0.12 * (0.5 + 0.5 * Math.cos(Math.PI * t)), -0.03 - 0.13 * t]); } // cyma recta
  pts.push([0.44, -0.16], [0.44, -0.18]); // fillet
  pts.push([0.45, -0.18], [0.45, -0.34], [0.43, -0.35], [0.31, -0.355], [0.31, -0.37]); // corona, drip, soffit
  pts.push([0.22, -0.37], [0.22, -0.47]); // dentil band (the dentils stand out from it)
  for (let k = 0; k <= 8; k++) { const a = (k / 8) * (Math.PI / 2); pts.push([0.1 + 0.12 * Math.cos(a), -0.47 - 0.1 * Math.sin(a)]); } // ovolo
  pts.push([0.06, -0.57], [0.06, -0.62], [0, -0.62]);
  const sh = new THREE.Shape(pts.map(([o, y]) => new THREE.Vector2(o, y)));
  const geo = new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false, curveSegments: 1 });
  geo.rotateY(-Math.PI / 2); // profile x -> out (z), the extrusion runs along x
  geo.translate(L / 2, top, face);
  const dent: THREE.BufferGeometry[] = [];
  for (let x = -L / 2 + 0.06; x + 0.075 <= L / 2; x += 0.12) dent.push(new THREE.BoxGeometry(0.075, 0.1, 0.085).translate(x + 0.0375, top - 0.42, face + 0.22 + 0.0425));
  const stone = new THREE.MeshStandardMaterial({ color: 0xece5d8, roughness: 0.8 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(merged([geo, ...dent]), stone));
  return g;
}

/** A stone step (1.2 m wide, 0.17 m rise, 0.28 m going): a solid block with a rounded nosing over the front (z+). */
export function stoneStep(): THREE.Object3D {
  const w = 1.2, rise = 0.17, go = 0.28, nose = 0.03, r = 0.02;
  // side section: (z: front +, y: up), from the back bottom, round the nosing
  const sh = new THREE.Shape();
  sh.moveTo(-go / 2, -rise / 2);
  sh.lineTo(go / 2 - 0.01, -rise / 2); // riser foot (set back a little under the nosing)
  sh.lineTo(go / 2 - 0.01, rise / 2 - 0.045);
  sh.lineTo(go / 2 + nose - r, rise / 2 - 0.045);
  sh.absarc(go / 2 + nose - r, rise / 2 - 0.045 + r, r, -Math.PI / 2, 0, false);
  sh.lineTo(go / 2 + nose, rise / 2 - r);
  sh.absarc(go / 2 + nose - r, rise / 2 - r, r, 0, Math.PI / 2, false);
  sh.lineTo(-go / 2, rise / 2);
  const geo = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false, curveSegments: 6 });
  geo.rotateY(Math.PI / 2); // section x -> z (front), extrusion -> x
  geo.translate(-w / 2, 0, 0);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.7 })));
  return g;
}

/** Big ashlar blocks for a 3 × 3 m wall: 6 courses of 0.5 m, blocks 0.6–1.2 m long with deep chamfered joints, standing about 4 cm out.
 * The pattern repeats every 3 m (blocks running past the right edge are the next copy's first ones). */
export function stoneWall(): THREE.Object3D {
  const W = 3, H = 3, rows = 6, rh = H / rows, gap = 0.012, bevel = 0.022, depth = 0.008; // ~4 cm proud of the wall: window surrounds still stand in front
  const geos: THREE.BufferGeometry[] = [], cols: number[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    // block lengths for this course, summing to exactly 3 m, starting at a different offset each course
    const lens: number[] = [];
    let sum = 0;
    while (sum < W - 1e-6) { let l = 0.6 + rnd(r * 31 + lens.length * 7.3) * 0.6; if (W - sum - l < 0.55) l = W - sum; lens.push(l); sum += l; }
    let x = -W / 2 + ((r * 0.37) % 1) * 0.9;
    for (const l of lens) {
      const w = l - gap - 2 * bevel, hgt = rh - gap - 2 * bevel;
      const sh = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(w, 0), new THREE.Vector2(w, hgt), new THREE.Vector2(0, hgt)]);
      const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 }).toNonIndexed();
      geo.translate(x + gap / 2 + bevel, -H / 2 + r * rh + gap / 2 + bevel, 0.15 - 0.01 + bevel);
      const t = rnd(++n * 3.1), c = new THREE.Color().setHSL(0.09 + t * 0.03, 0.12 + t * 0.08, 0.62 + rnd(n + 0.3) * 0.12);
      for (let k = 0; k < geo.getAttribute('position').count; k++) cols.push(c.r, c.g, c.b);
      geos.push(geo);
      x += l;
    }
  }
  const geo = merged(geos);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 })));
  return g;
}

export const BUILTIN_DESIGNS: Record<string, { name: string; category: DesignCategory; make: () => THREE.Object3D }> = {
  ionic: { name: 'Ionic column', category: 'column', make: ionicColumn },
  archFrame: { name: 'Arched window frame', category: 'frame', make: archedWindowFrame },
  archSurround: { name: 'Arched window surround', category: 'surround', make: archedWindowSurround },
  brickWall: { name: 'Brick facing', category: 'model', make: brickWall },
  stoneWall: { name: 'Ashlar stone blocks', category: 'model', make: stoneWall },
  roofTiles: { name: 'Clay roof tiles', category: 'model', make: roofTiles },
  simpleArch: { name: 'Simple stone arch', category: 'surround', make: simpleArch },
  classicalCornice: { name: 'Classical cornice', category: 'cornice', make: classicalCornice },
  stoneStep: { name: 'Stone step', category: 'model', make: stoneStep },
};
