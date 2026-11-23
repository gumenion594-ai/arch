// Turns a project into 3D geometry (structural / detailed views).
import * as THREE from 'three';
import {
  Building, PlanSegment, StructurePlan, Texture, elevation, planForFloor, segColT, segConnect, segConnectSmooth, segKind,
} from './model';
import { V2, enclosedFaces, polyAt, polyLength, polyParams, sampleSeg, samplePath, shortestPath } from './geometry';

type Mats = {
  wall: THREE.Material; column: THREE.Material; slab: THREE.Material; edge: THREE.LineBasicMaterial;
  tex: (id: string) => THREE.Material | null;
};

/** Plan that sits at a level (0..N). Level N is the "Top" (roof) level. */
export function planAtLevel(b: Building, k: number): StructurePlan | null {
  if (k < b.floors.length) return planForFloor(b, b.floors[k].id) ?? null;
  return b.plans.find(pl => pl.id === b.topPlanId) ?? null;
}

/** Plan coordinates (0..1) + elevation -> world. Plan y grows towards -z. */
export const toWorld = (b: Building, v: V2, y: number) => new THREE.Vector3(b.x + v.x * b.baseLength, y, -(b.y + v.y * b.baseLength));

export function buildStructure(p: Building, textures: Texture[], detailed: boolean, mats: Mats): THREE.Group {
  const g = new THREE.Group();
  const L = p.baseLength, N = p.floors.length;
  const W = (v: V2, y: number) => toWorld(p, v, y);
  const floorBase = (_: Building, i: number) => elevation(p, i);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, edges = true) => {
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    if (edges) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), mats.edge));
  };

  // ---------- slabs at each level ----------
  const slabT: number[] = [];
  for (let k = 0; k <= N; k++) {
    const own = planAtLevel(p, k);
    const below = k > 0 ? planAtLevel(p, k - 1) : null;
    const settings = own ?? below;
    let t = 0;
    if (settings && settings.floorEnabled) {
      const faces: V2[][] = [];
      if (own) faces.push(...enclosedFaces(own));
      // walls of the floor below going straight up also close this level
      if (below && below !== own && below.connect === 'straight') faces.push(...enclosedFaces(below));
      if (faces.length) {
        const hFloor = k < N ? p.floors[k].height : p.floors[N - 1].height;
        t = Math.min(settings.floorThickness, hFloor * 0.9);
        const y = k === N ? floorBase(p, N) - t : floorBase(p, k);
        faces.forEach((f, i) => {
          const shape = new THREE.Shape(f.map(v => new THREE.Vector2(v.x * L, v.y * L)));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
          geo.rotateX(-Math.PI / 2);
          // tiny offset so overlapping slabs from two plans don't flicker
          geo.translate(p.x, y + i * 1e-4 * t, -p.y);
          add(geo, mats.slab);
        });
      }
    }
    slabT.push(k < N ? t : 0);
  }

  // ---------- walls / columns per floor ----------
  for (let i = 0; i < N; i++) {
    const plan = planAtLevel(p, i);
    if (!plan) continue;
    const above = planAtLevel(p, i + 1);
    const y0 = floorBase(p, i) + slabT[i];
    const y1 = floorBase(p, i + 1);
    if (y1 - y0 <= 1e-6) continue;
    const rowsBySeg = new Map<string, { rows: Row[]; bottom: V2[] }>();
    const colAlong = (rows: Row[], t: number, ct: number, bottom: V2[]) => {
      const pts = rows.map((r, ri) => W(polyAt(r.poly, r.params, t), y0 + (y1 - y0) * (ri / (rows.length - 1))));
      for (let k = 0; k + 1 < pts.length; k++) add(column(pts[k], pts[k + 1], ct, bottom), mats.column);
    };

    for (const seg of plan.segments) {
      const kind = segKind(seg);
      if (kind === 'open') continue;
      const bottom = sampleSeg(plan, seg);
      let top = bottom;
      const loft = segConnect(plan, seg) === 'loft' && above && above.points.length > 0;
      if (loft) top = loftTarget(plan, above!, seg);
      const rows = buildGrid(bottom, top, loft ? segConnectSmooth(plan, seg) : 0);

      if (kind === 'wall') {
        const offs = offsets(plan, seg, bottom, plan.wallThickness / 2 / L);
        const tex = detailed && seg.texture ? mats.tex(seg.texture) : null;
        const texInfo = tex ? textures.find(t => t.id === seg.texture) : undefined;
        const tileH = p.floors[i].height, tileW = texInfo ? tileH * (texInfo.w / texInfo.h) : 1;
        add(solidFromGrid(rows, offs, polyParams(bottom), y0, y1, W, L, tileW, tileH), tex ?? mats.wall);
      } else {
        // colonnade: columns between divisions (+ free-standing ends)
        const d = Math.max(1, seg.divisions ?? 1);
        for (let k = 1; k < d; k++) colAlong(rows, k / d, segColT(plan, seg), bottom);
        rowsBySeg.set(seg.id, { rows, bottom });
      }
    }

    // free corners of colonnades (no solid wall meeting there) get one column
    for (const pt of plan.points) {
      const segs = plan.segments.filter(s => s.a === pt.id || s.b === pt.id);
      if (segs.some(s => segKind(s) === 'wall')) continue;
      const c = segs.find(s => segKind(s) === 'colonnade');
      if (!c) continue;
      const r = rowsBySeg.get(c.id)!;
      colAlong(r.rows, c.a === pt.id ? 0 : 1, segColT(plan, c), r.bottom);
    }

    // lone points: a pillar of wall thickness (only when going straight up)
    const used = new Set(plan.segments.flatMap(s => [s.a, s.b]));
    for (const pt of plan.points) {
      if (used.has(pt.id)) continue;
      add(column(W(pt, y0), W(pt, y1), plan.wallThickness, null), mats.wall);
    }
  }
  return g;
}

/** Polyline on the plan above that a wall connects to: nearest points + the walls between them. */
function loftTarget(plan: StructurePlan, above: StructurePlan, seg: PlanSegment): V2[] {
  const A = plan.points.find(p => p.id === seg.a)!, B = plan.points.find(p => p.id === seg.b)!;
  const near = (v: V2) => above.points.reduce((best, q) => (Math.hypot(q.x - v.x, q.y - v.y) < Math.hypot(best.x - v.x, best.y - v.y) ? q : best));
  const ma = near(A), mb = near(B);
  const path = shortestPath(above, ma.id, mb.id);
  return path ? samplePath(above, path) : [{ x: ma.x, y: ma.y }, { x: mb.x, y: mb.y }];
}

type Row = { poly: V2[]; params: number[] };

/**
 * Rows of matching vertices from the bottom polyline to the top one.
 * Both are resampled on the union of their arc-length parameters, so
 * mismatched point counts are triangulated automatically.
 * smooth > 0 bends the vertical profile into a curve (dome-like).
 */
function buildGrid(bottom: V2[], top: V2[], smooth: number): Row[] {
  const pb = polyParams(bottom), pt = top.length > 1 ? polyParams(top) : [0];
  const ts = [...new Set([...pb, ...pt].map(t => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
  const B = ts.map(t => polyAt(bottom, pb, t)), T = ts.map(t => polyAt(top, pt, t));
  const R = smooth > 0 ? 10 : 1;
  const rows: Row[] = [];
  for (let r = 0; r <= R; r++) {
    const t = r / R;
    const u = (1 - smooth) * t + smooth * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
    rows.push({ poly: B.map((b, c) => ({ x: b.x + (T[c].x - b.x) * u, y: b.y + (T[c].y - b.y) * u })), params: ts });
  }
  return rows;
}

const perp = (d: V2): V2 => ({ x: -d.y, y: d.x });
const norm = (d: V2): V2 => { const l = Math.hypot(d.x, d.y) || 1; return { x: d.x / l, y: d.y / l }; };

/** Half-thickness offset vector per vertex of the bottom polyline, mitred where two walls meet. */
function offsets(plan: StructurePlan, seg: PlanSegment, poly: V2[], half: number): V2[] {
  const n = poly.length;
  const ns = poly.map((_, i) => {
    const a = poly[Math.max(0, i - 1)], b = poly[Math.min(n - 1, i + 1)];
    return perp(norm({ x: b.x - a.x, y: b.y - a.y }));
  });
  const miter = (endId: string, u: V2, nrm: V2): V2 => {
    const others = plan.segments.filter(s => s !== seg && (s.a === endId || s.b === endId) && segKind(s) === 'wall');
    if (others.length !== 1) return nrm;
    const o = others[0];
    const sp = sampleSeg(plan, o);
    if (o.a !== endId) sp.reverse();
    const w = norm({ x: sp[1].x - sp[0].x, y: sp[1].y - sp[0].y });
    const bis = norm({ x: u.x + w.x, y: u.y + w.y });
    const dot = bis.x * nrm.x + bis.y * nrm.y;
    if (Math.abs(u.x + w.x) + Math.abs(u.y + w.y) < 1e-6 || Math.abs(dot) < 0.25) return nrm;
    return { x: bis.x / dot, y: bis.y / dot };
  };
  const u0 = norm({ x: poly[1].x - poly[0].x, y: poly[1].y - poly[0].y });
  const u1 = norm({ x: poly[n - 2].x - poly[n - 1].x, y: poly[n - 2].y - poly[n - 1].y });
  ns[0] = miter(seg.a, u0, ns[0]);
  ns[n - 1] = miter(seg.b, u1, ns[n - 1]);
  return ns.map(v => ({ x: v.x * half, y: v.y * half }));
}

/** Closed solid between the rows, thickened by the offsets. */
function solidFromGrid(rows: Row[], offs: V2[], offParams: number[], y0: number, y1: number, W: (v: V2, y: number) => THREE.Vector3, L: number, tileW: number, tileH: number) {
  const R = rows.length - 1, C = rows[0].poly.length;
  // offsets are defined on the bottom resampled vertices: map by parameter to the source polyline vertices
  const params = rows[0].params;
  // offsets live on the original bottom vertices; interpolate them at the resampled parameters
  const O = params.map((t, c) => (c === 0 ? offs[0] : c === C - 1 ? offs[offs.length - 1] : polyAt(offs, offParams, t)));
  const len = polyLength(rows[0].poly) * L;
  const pos: number[] = [], uv: number[] = [];
  const v = (r: number, c: number, side: 1 | -1) => {
    const q = rows[r].poly[c], o = O[c];
    return W({ x: q.x + o.x * side, y: q.y + o.y * side }, y0 + (y1 - y0) * (r / R));
  };
  const uvOf = (r: number, c: number) => [(params[c] * len) / tileW, ((y1 - y0) * (r / R)) / tileH];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ua: number[], ub: number[], uc: number[]) => {
    const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).lengthSq();
    if (area < 1e-14) return;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    uv.push(...ua, ...ub, ...uc);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ua = [0, 0], ub = [0, 0], uc = [0, 0], ud = [0, 0]) => {
    tri(a, b, c, ua, ub, uc); tri(a, c, d, ua, uc, ud);
  };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c + 1 < C; c++) {
      quad(v(r, c, 1), v(r, c + 1, 1), v(r + 1, c + 1, 1), v(r + 1, c, 1), uvOf(r, c), uvOf(r, c + 1), uvOf(r + 1, c + 1), uvOf(r + 1, c));
      quad(v(r, c, -1), v(r + 1, c, -1), v(r + 1, c + 1, -1), v(r, c + 1, -1), uvOf(r, c), uvOf(r + 1, c), uvOf(r + 1, c + 1), uvOf(r, c + 1));
    }
  }
  for (let c = 0; c + 1 < C; c++) {
    quad(v(0, c, -1), v(0, c + 1, -1), v(0, c + 1, 1), v(0, c, 1)); // bottom
    quad(v(R, c, 1), v(R, c + 1, 1), v(R, c + 1, -1), v(R, c, -1)); // top
  }
  for (let r = 0; r < R; r++) {
    quad(v(r, 0, 1), v(r + 1, 0, 1), v(r + 1, 0, -1), v(r, 0, -1)); // start cap
    quad(v(r, C - 1, -1), v(r + 1, C - 1, -1), v(r + 1, C - 1, 1), v(r, C - 1, 1)); // end cap
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/** Square column from a to b (may be slanted), faces aligned with the wall direction. */
function column(a: THREE.Vector3, b: THREE.Vector3, t: number, wall: V2[] | null) {
  const len = a.distanceTo(b);
  const geo = new THREE.BoxGeometry(t, len, t);
  const up = new THREE.Vector3().subVectors(b, a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  if (wall && wall.length > 1) {
    const d = norm({ x: wall[wall.length - 1].x - wall[0].x, y: wall[wall.length - 1].y - wall[0].y });
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.y, d.x));
    q.multiply(spin);
  }
  geo.applyQuaternion(q);
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

