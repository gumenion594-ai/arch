// Sites in 3D: the terrain (a height grid), roads and gravel laid on it, trees, imported models and water.
// Plan coordinates in metres: x east, y north; world x = x, world z = −y, heights in world y.
import * as THREE from 'three';
import { Design, SiteData, SiteXY } from './model';
import { designObject } from './assets';
import { materialLook } from './materials';

export const LANE = 3.5; // m per lane
const n1 = (s: SiteData) => Math.round(s.size / s.res) + 1;

/** Ground height at plan point (x, y), bilinear between grid points (0 outside the site). */
export function heightAt(s: SiteData, x: number, y: number): number {
  const n = n1(s), h = s.size / 2;
  const gx = (x + h) / s.res, gy = (y + h) / s.res;
  if (gx < 0 || gy < 0 || gx > n - 1 || gy > n - 1) return 0;
  const i = Math.min(n - 2, Math.floor(gx)), j = Math.min(n - 2, Math.floor(gy)), fx = gx - i, fy = gy - j;
  const H = (a: number, b: number) => s.heights[b * n + a] ?? 0;
  return H(i, j) * (1 - fx) * (1 - fy) + H(i + 1, j) * fx * (1 - fy) + H(i, j + 1) * (1 - fx) * fy + H(i + 1, j + 1) * fx * fy;
}

/**
 * Terrain brush at (x, y): 'raise' / 'lower' by up to `amount` m (smooth falloff to the radius), 'smooth' towards
 * the neighbours' average, 'flatten' towards `level`.
 */
export function brush(s: SiteData, x: number, y: number, radius: number, amount: number, mode: 'raise' | 'lower' | 'smooth' | 'flatten', level = 0) {
  const n = n1(s), h = s.size / 2, r = Math.ceil(radius / s.res);
  const ci = Math.round((x + h) / s.res), cj = Math.round((y + h) / s.res);
  const old = mode === 'smooth' ? s.heights.slice() : null;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const d = Math.hypot(i * s.res - h - x, j * s.res - h - y) / radius;
    if (d >= 1) continue;
    const w = 0.5 * (1 + Math.cos(Math.PI * d)), k = j * n + i;
    if (mode === 'raise') s.heights[k] += amount * w;
    else if (mode === 'lower') s.heights[k] -= amount * w;
    else if (mode === 'flatten') s.heights[k] += (level - s.heights[k]) * Math.min(1, w * 1.5);
    else {
      let sum = 0, cnt = 0;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < n && jj < n) { sum += old![jj * n + ii]; cnt++; } }
      s.heights[k] += (sum / cnt - s.heights[k]) * w * 0.6;
    }
    s.heights[k] = Math.round(s.heights[k] * 1000) / 1000;
  }
}

/** Set the ground under a footprint (plan polygon) to a level, easing out over `edge` m around it. */
export function levelUnder(s: SiteData, poly: SiteXY[], level: number, edge = 4) {
  const n = n1(s), h = s.size / 2;
  const inside = (q: SiteXY) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  const distTo = (q: SiteXY) => Math.min(...poly.map((a, i) => { const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0; return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t); }));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = { x: i * s.res - h, y: j * s.res - h }, k = j * n + i;
    if (inside(q)) s.heights[k] = level;
    else { const d = distTo(q); if (d < edge) { const w = 0.5 * (1 + Math.cos((Math.PI * d) / edge)); s.heights[k] += (level - s.heights[k]) * w; } }
  }
}

export interface SiteBuildOpts { detailed: boolean; selected: string | null; designs: Design[]; onLoad: () => void }

/** A smooth curve through the points (centripetal Catmull–Rom), sampled about every `step` m. */
export function smoothLine(pts: SiteXY[], step: number): SiteXY[] {
  if (pts.length < 3) {
    const out: SiteXY[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 0; k < m; k++) out.push({ x: a.x + ((b.x - a.x) * k) / m, y: a.y + ((b.y - a.y) * k) / m });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  const P = [{ x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }, ...pts, { x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x, y: 2 * pts[pts.length - 1].y - pts[pts.length - 2].y }];
  const out: SiteXY[] = [];
  const tj = (a: SiteXY, b: SiteXY, t: number) => t + Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const t0 = 0, t1 = tj(p0, p1, t0), t2 = tj(p1, p2, t1), t3 = tj(p2, p3, t2);
    const m = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / step));
    for (let k = 0; k < m; k++) {
      const t = t1 + ((t2 - t1) * k) / m;
      const L = (a: SiteXY, b: SiteXY, ta: number, tb: number) => ({ x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta), y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta) });
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Lays roads, gravel and trees back on the ground after it changed (models and buildings keep their height). */
export function redrape(s: SiteData, group: THREE.Object3D) {
  group.traverse(o => {
    const d = o.userData.drape as { xy: number[]; lift: number } | undefined;
    if (d && (o as THREE.Mesh).isMesh) {
      const pos = (o as THREE.Mesh).geometry.getAttribute('position');
      for (let k = 0; k < pos.count; k++) pos.setY(k, heightAt(s, d.xy[k * 2], d.xy[k * 2 + 1]) + d.lift);
      pos.needsUpdate = true;
      (o as THREE.Mesh).geometry.computeVertexNormals();
      (o as THREE.Mesh).geometry.computeBoundingSphere();
    }
    const gp = o.userData.onGround as SiteXY | undefined;
    if (gp) o.position.y = heightAt(s, gp.x, gp.y);
  });
}

/** The whole site: terrain, roads, gravel, trees, models and water (each piece tagged with userData.siteId for picking). */
export function buildSite(s: SiteData, o: SiteBuildOpts): { group: THREE.Group; terrain: THREE.Mesh } {
  const g = new THREE.Group();
  const sel = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x6b5800, roughness: 0.8, side: THREE.DoubleSide });
  const tag = (obj: THREE.Object3D, id: string) => { obj.userData.siteId = id; if (id === o.selected) obj.traverse(x => { const m = x as THREE.Mesh; if (m.isMesh) m.material = sel; }); return obj; };
  const H = (x: number, y: number) => heightAt(s, x, y);

  // terrain
  const n = n1(s), geo = new THREE.PlaneGeometry(s.size, s.size, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2); // plane (x, y) -> world (x, −z): grid row j of the geometry runs from north to south
  const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = -pos.getZ(k);
    pos.setY(k, H(x, y));
    uv.setXY(k, x / 4, y / 4); // grass tiles of 4 m
  }
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, o.detailed ? materialLook('grass', '#6f9a48') : new THREE.MeshStandardMaterial({ color: 0x6f8a62, roughness: 1, side: THREE.DoubleSide }));
  terrain.userData.ground = true;
  terrain.userData.siteTerrain = true;
  g.add(terrain);

  // a strip along a (smoothed) line, draped on the ground (lift: how far above it): a fine grid, so the ground never pokes through
  const strip = (dense: SiteXY[], width: number, lift: number, mat: THREE.Material, from = -0.5, to = 0.5) => {
    const across = Math.max(1, Math.ceil((width * (to - from)) / 1));
    const v: number[] = [], t: number[] = [], idx: number[] = [], xy: number[] = [];
    let along = 0;
    dense.forEach((q, i) => {
      const p0 = dense[Math.max(0, i - 1)], p1 = dense[Math.min(dense.length - 1, i + 1)];
      const dx = p1.x - p0.x, dy = p1.y - p0.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      if (i > 0) along += Math.hypot(q.x - dense[i - 1].x, q.y - dense[i - 1].y);
      for (let c = 0; c <= across; c++) {
        const f = from + ((to - from) * c) / across, x = q.x + nx * width * f, y = q.y + ny * width * f;
        v.push(x, H(x, y) + lift, -y); t.push(width * f, along); xy.push(x, y);
      }
      if (i > 0) for (let c = 0; c < across; c++) {
        const a = (i - 1) * (across + 1) + c, b = i * (across + 1) + c;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    });
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
    sg.setIndex(idx); sg.computeVertexNormals();
    const m = new THREE.Mesh(sg, mat);
    m.userData.drape = { xy, lift };
    return m;
  };

  // roads: a smooth curve through the clicked points; asphalt, lane markings (dashed between lanes, solid at the edges)
  const asphalt = o.detailed ? materialLook('asphalt', '#55575a') : new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1, side: THREE.DoubleSide });
  const paint = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide });
  for (const r of s.roads) {
    if (r.points.length < 2) continue;
    const grp = new THREE.Group(), W = r.lanes * LANE;
    const c = smoothLine(r.points, 0.75);
    grp.add(strip(c, W, 0.06, asphalt));
    const line = (off: number, dashed: boolean) => {
      const f = off / W, a = f - 0.06 / W, b = f + 0.06 / W;
      if (!dashed) { grp.add(strip(c, W, 0.075, paint, a, b)); return; }
      // dashes: 3 m painted, 6 m gap, measured along the curve
      let acc = 0, run: SiteXY[] = [];
      c.forEach((q, i) => {
        if (i > 0) acc += Math.hypot(q.x - c[i - 1].x, q.y - c[i - 1].y);
        if (acc % 9 < 3) run.push(q);
        else if (run.length) { if (run.length > 1) grp.add(strip(run, W, 0.075, paint, a, b)); run = []; }
      });
      if (run.length > 1) grp.add(strip(run, W, 0.075, paint, a, b));
    };
    line(-W / 2 + 0.25, false); line(W / 2 - 0.25, false);
    for (let k = 1; k < r.lanes; k++) line(-W / 2 + k * LANE, true);
    g.add(tag(grp, r.id));
  }

  // gravel areas: the polygon, cut into small triangles that follow the ground
  const gravel = o.detailed ? materialLook('gravel', '#a49e92') : new THREE.MeshStandardMaterial({ color: 0x9d988e, roughness: 1, side: THREE.DoubleSide });
  for (const gr of s.gravel) {
    if (gr.points.length < 3) continue;
    const tris = THREE.ShapeUtils.triangulateShape(gr.points.map(q => new THREE.Vector2(q.x, q.y)), []);
    const v: number[] = [], t: number[] = [];
    const emit = (a: SiteXY, b: SiteXY, c: SiteXY, depth: number) => {
      const l = Math.max(Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(b.x - c.x, b.y - c.y), Math.hypot(c.x - a.x, c.y - a.y));
      if (l > 1 && depth < 9) { const m = (p: SiteXY, q: SiteXY) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }); const ab = m(a, b), bc = m(b, c), ca = m(c, a); emit(a, ab, ca, depth + 1); emit(ab, b, bc, depth + 1); emit(ca, bc, c, depth + 1); emit(ab, bc, ca, depth + 1); return; }
      for (const q of [a, b, c]) { v.push(q.x, H(q.x, q.y) + 0.045, -q.y); t.push(q.x, q.y); }
    };
    for (const [a, b, c] of tris) emit(gr.points[a], gr.points[b], gr.points[c], 0);
    if (v.length > 30000 * 9) continue;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
    gg.computeVertexNormals();
    const gm = new THREE.Mesh(gg, gravel);
    gm.userData.drape = { xy: t.slice(), lift: 0.045 };
    g.add(tag(gm, gr.id));
  }

  // trees: a trunk and a crown (round: a ball of leaves; conifer: stacked cones)
  const bark = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 });
  const leaves = new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 0.9, flatShading: true });
  const needles = new THREE.MeshStandardMaterial({ color: 0x2f6a3a, roughness: 0.9, flatShading: true });
  for (const tr of s.trees) {
    const t = new THREE.Group(), S = tr.size, y0 = H(tr.x, tr.y);
    if (tr.kind === 'conifer') {
      t.add(new THREE.Mesh(new THREE.CylinderGeometry(S * 0.025, S * 0.035, S * 0.3, 8).translate(0, S * 0.15, 0), bark));
      for (let k = 0; k < 3; k++) t.add(new THREE.Mesh(new THREE.ConeGeometry(S * (0.28 - k * 0.07), S * 0.38, 9).translate(0, S * (0.38 + k * 0.2), 0), needles));
    } else {
      t.add(new THREE.Mesh(new THREE.CylinderGeometry(S * 0.035, S * 0.05, S * 0.45, 8).translate(0, S * 0.225, 0), bark));
      t.add(new THREE.Mesh(new THREE.IcosahedronGeometry(S * 0.32, 1).translate(0, S * 0.66, 0), leaves));
    }
    t.position.set(tr.x, y0, -tr.y);
    t.userData.onGround = { x: tr.x, y: tr.y };
    g.add(tag(t, tr.id));
  }

  // imported 3D models standing on the ground
  for (const m of s.models) {
    const d = o.designs.find(x => x.id === m.designId);
    const src = d ? designObject(d, o.onLoad) : null;
    if (!src) continue;
    const size = (src.userData.size as THREE.Vector3) ?? new THREE.Vector3(1, 1, 1), k = m.scale / Math.max(size.x, size.y, size.z, 1e-9);
    const obj = src.clone(true);
    const holder = new THREE.Group();
    holder.add(obj);
    obj.scale.multiply(new THREE.Vector3(size.x * k, size.y * k, size.z * k));
    obj.position.y = (size.y * k) / 2;
    holder.position.set(m.x, m.z ?? H(m.x, m.y), -m.y);
    holder.rotation.y = (m.rot * Math.PI) / 180;
    g.add(tag(holder, m.id));
  }

  // water: a flat surface at its level; wherever the ground is higher it is simply hidden under it (a lake in a valley)
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x3f7fb8, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  for (const w of s.water) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w.w, w.d), waterMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(w.x, w.level, -w.y);
    m.userData.passThrough = true;
    g.add(tag(m, w.id));
  }
  return { group: g, terrain };
}
