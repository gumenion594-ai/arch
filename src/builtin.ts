// Built-in designs generated in code (no file to import): an Ionic column.
import * as THREE from 'three';

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
  return g;
}

export const BUILTIN_DESIGNS: Record<string, { name: string; category: 'column'; make: () => THREE.Object3D }> = {
  ionic: { name: 'Ionic column', category: 'column', make: ionicColumn },
};
