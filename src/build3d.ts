// Turns a building into 3D geometry (structural / detailed views).
import * as THREE from 'three';
import {
  Building, PlanObject, PlanSegment, StructurePlan, Texture, elevation, hasCeiling, hasFloor, planForFloor, segColT, segConnect, segConnectSmooth,
  segKind, segMaterial, windowKey,
} from './model';
import { V2, enclosedFacesSegs, smoothClosed, polyAt, polyLength, polyParams, sampleSeg, samplePath, shortestPath, signedArea } from './geometry';

export type Mats = {
  wall(material: string): THREE.Material;
  column(material: string): THREE.Material;
  slab: THREE.Material;
  object: THREE.Material;
  edge: THREE.LineBasicMaterial;
  selected: THREE.Material;
  selLine: THREE.LineBasicMaterial;
  tex: (id: string) => THREE.Material | null;
};

/** What a mesh represents: used for clicking (selection) and for weight calculation. */
export interface PickInfo {
  floorId: string;
  floorIndex: number;
  segId?: string;
  interior?: boolean;
  divisions?: number;
  /** Wall coordinates (u along the wall 0..1, v up the wall 0..1) of a point on its surface. */
  uvOf?: (p: THREE.Vector3) => { u: number; v: number };
}
export interface StatInfo { cat: 'ext' | 'int' | 'col'; material: string }

export interface Selection { floors: Set<string>; walls: Set<string>; divisions: Set<string> } // ids: floorId, floorId|segId, floorId|segId|k
export const emptySelection = (): Selection => ({ floors: new Set(), walls: new Set(), divisions: new Set() });

export interface BuildOpts {
  detailed: boolean;
  interior: boolean; // build floor-plan (internal) walls, stairs, elevators
  mats: Mats;
  selection?: Selection;
  textures: Texture[];
}
export interface BuildStats { windowCount: number; windowArea: number; windowSkipped: number }

/** Plan that sits at a level (0..N). Level N is the "Top" (roof) level. */
export function planAtLevel(b: Building, k: number): StructurePlan | null {
  if (k < b.floors.length) return planForFloor(b, b.floors[k].id) ?? null;
  return b.plans.find(pl => pl.id === b.topPlanId) ?? null;
}
export const interiorForFloor = (b: Building, floorId: string) => b.interiorPlans.find(pl => pl.floorIds.includes(floorId)) ?? null;

/** Plan coordinates (0..1) + elevation -> world. Plan y grows towards -z. */
export const toWorld = (b: Building, v: V2, y: number) => new THREE.Vector3(b.x + v.x * b.baseLength, y, -(b.y + v.y * b.baseLength));

/** Areas a floor's own floor slab covers: everything its external walls enclose. */
function floorFaces(b: Building, i: number): V2[][] {
  const pl = planAtLevel(b, i);
  return pl ? enclosedFacesSegs(pl).map(f => f.poly) : [];
}
/**
 * Areas a floor's ceiling covers: enclosed areas whose walls go straight up; where walls
 * connect to the plan above, the ceiling takes the shape they end in (the plan above).
 * A plan above that encloses nothing (a ridge or a point: a roof) needs no ceiling.
 */
function ceilingFaces(b: Building, i: number): V2[][] {
  const pl = planAtLevel(b, i);
  if (!pl) return [];
  const out: V2[][] = [];
  let lofted = false;
  for (const f of enclosedFacesSegs(pl)) {
    if (f.segIds.every(id => segConnect(pl, pl.segments.find(s => s.id === id)!) === 'straight')) out.push(f.poly);
    else lofted = true;
  }
  const above = planAtLevel(b, i + 1);
  if (lofted && above && above !== pl) out.push(...enclosedFacesSegs(above).map(f => f.poly));
  return out;
}
/** Floor / ceiling slab thickness of floor i (0 when switched off or nothing to cover). */
export function slabThickness(b: Building, i: number): { floor: number; ceiling: number } {
  const f = b.floors[i], pl = planAtLevel(b, i);
  if (!pl) return { floor: 0, ceiling: 0 };
  const fl = hasFloor(f) && floorFaces(b, i).length ? Math.min(pl.floorThickness, f.height * 0.45) : 0;
  const ce = hasCeiling(f) && ceilingFaces(b, i).length ? Math.min(pl.ceilingThickness, f.height * 0.45) : 0;
  return { floor: fl, ceiling: ce };
}

export function buildStructure(p: Building, o: BuildOpts): { group: THREE.Group; stats: BuildStats } {
  const g = new THREE.Group();
  const L = p.baseLength, N = p.floors.length, mats = o.mats;
  const W = (v: V2, y: number) => toWorld(p, v, y);
  const stats: BuildStats = { windowCount: 0, windowArea: 0, windowSkipped: 0 };
  const sel = o.selection ?? emptySelection();

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pick?: PickInfo, stat?: StatInfo, edges = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.userData = { pick, stat };
    g.add(m);
    if (edges) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), mats.edge));
    return m;
  };
  const line = (pts: THREE.Vector3[], mat: THREE.LineBasicMaterial) => g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));

  // ---------- each floor's own floor and ceiling slabs ----------
  const slabs = p.floors.map((_, i) => slabThickness(p, i));
  const slab = (faces: V2[][], y: number, t: number, i: number) => faces.forEach((f, k) => {
    const shape = new THREE.Shape(f.map(v => new THREE.Vector2(v.x * L, v.y * L)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(p.x, y + k * 1e-4 * t, -p.y); // tiny offset: overlapping slabs don't flicker
    add(geo, sel.floors.has(p.floors[i].id) ? mats.selected : mats.slab, { floorId: p.floors[i].id, floorIndex: i });
  });
  for (let i = 0; i < N; i++) {
    if (slabs[i].floor) slab(floorFaces(p, i), elevation(p, i), slabs[i].floor, i);
    if (slabs[i].ceiling) slab(ceilingFaces(p, i), elevation(p, i + 1) - slabs[i].ceiling, slabs[i].ceiling, i);
  }

  // ---------- walls / columns per floor ----------
  for (let i = 0; i < N; i++) {
    const floor = p.floors[i];
    // external walls run the full floor height; internal walls stand between floor and ceiling
    const yBase = elevation(p, i), yTop = elevation(p, i + 1);
    if (yTop - yBase <= 1e-6) continue;
    const floorSel = sel.floors.has(floor.id);

    const plans: { plan: StructurePlan; interior: boolean }[] = [];
    const ext = planAtLevel(p, i);
    if (ext) plans.push({ plan: ext, interior: false });
    const inner = o.interior ? interiorForFloor(p, floor.id) : null;
    if (inner) plans.push({ plan: inner, interior: true });

    for (const { plan, interior } of plans) {
      const y0 = interior ? yBase + slabs[i].floor : yBase;
      const y1 = interior ? yTop - slabs[i].ceiling : yTop;
      const above = interior ? null : planAtLevel(p, i + 1);
      const rowsBySeg = new Map<string, { rows: Row[]; bottom: V2[] }>();
      const colAlong = (rows: Row[], t: number, ct: number, bottom: V2[], pick: PickInfo, material: string, selected: boolean) => {
        const pts = rows.map((r, ri) => W(polyAt(r.poly, r.params, t), y0 + (y1 - y0) * (ri / (rows.length - 1))));
        for (let k = 0; k + 1 < pts.length; k++) {
          add(column(pts[k], pts[k + 1], ct, bottom), selected ? mats.selected : mats.column(material), pick, { cat: 'col', material });
        }
      };

      for (const seg of plan.segments) {
        const kind = segKind(seg);
        if (kind === 'open') continue;
        const material = segMaterial(plan, seg);
        const bottom = sampleSeg(plan, seg);
        let top = bottom;
        const loft = !interior && segConnect(plan, seg) === 'loft' && above && above.points.length > 0;
        if (loft) top = loftTarget(plan, above!, seg);
        const rows = buildGrid(bottom, top, loft ? segConnectSmooth(plan, seg) : 0);
        const d = Math.max(1, seg.divisions ?? 1);
        const wallKey = `${floor.id}|${seg.id}`;
        const selected = floorSel || sel.walls.has(wallKey);
        const pick: PickInfo = { floorId: floor.id, floorIndex: i, segId: seg.id, interior, divisions: d };

        if (kind === 'wall' || kind === 'door') {
          const offs = offsets(plan, seg, bottom, plan.wallThickness / 2 / L);
          const tex = o.detailed && seg.texture ? mats.tex(seg.texture) : null;
          const texInfo = tex ? o.textures.find(t => t.id === seg.texture) : undefined;
          const tileH = floor.height, tileW = texInfo ? tileH * (texInfo.w / texInfo.h) : 1;
          // a door segment is just the lintel above a 2.1 m opening
          const yb = kind === 'door' ? y0 + Math.min(2.1, (y1 - y0) * 0.8) : y0;
          const holes: V2[][] = [];
          if (kind === 'wall' && !interior) {
            for (let k = 0; k < d; k++) {
              const shapeId = p.windows[windowKey(floor.id, seg.id, k)];
              const shape = shapeId && p.windowShapes.find(s => s.id === shapeId);
              if (!shape) continue;
              // fixed-size windows: scale the outline into a w × h box (measured along the bottom of the wall)
              const divLen = (polyLength(bottom) * L) / d, wallH = y1 - y0;
              const fx = shape.fixed;
              if (fx && !windowFits(fx, divLen, wallH)) { stats.windowSkipped++; continue; }
              const map = fx
                ? (q: V2) => ({ x: 0.5 + (q.x - 0.5) * (fx.w / divLen), y: (fx.sill + q.y * fx.h) / wallH })
                : (q: V2) => q;
              for (const outline of shape.outlines) {
                if (outline.length < 3) continue;
                let hole = smoothClosed(outline, shape.smooth).map(map).map(q => ({
                  x: clamp01((k + clamp(q.x, 0.004, 0.996)) / d),
                  y: clamp(q.y, 0.004, 0.996),
                }));
                if (Math.abs(signedArea(hole)) < 1e-9) continue;
                if (signedArea(hole) > 0) hole = hole.reverse(); // holes run clockwise
                holes.push(hole);
              }
            }
          }
          const wall = new WallSolid(rows, offs, polyParams(bottom), yb, y1, W, L, tileW, tileH);
          const geo = wall.build(holes);
          stats.windowCount += holes.length;
          stats.windowArea += holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0) * wall.lenM * (y1 - yb);
          pick.uvOf = q => wall.uvOf(q);
          add(geo, selected ? mats.selected : tex ?? mats.wall(o.detailed ? material : 'structural'), pick, { cat: interior ? 'int' : 'ext', material });
          // division lines + selected division outlines
          for (let k = 0; k <= d; k++) {
            if (k > 0 && k < d) for (const side of [1, -1] as const) line(wall.vline(k / d, side), mats.edge);
            if (k < d && sel.divisions.has(`${wallKey}|${k}`)) {
              for (const side of [1.03, -1.03]) line(wall.rect(k / d, (k + 1) / d, side), mats.selLine);
            }
          }
        } else {
          // colonnade: columns between divisions (+ free-standing ends)
          for (let k = 1; k < d; k++) colAlong(rows, k / d, segColT(plan, seg), bottom, pick, material, selected);
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
        const selected = floorSel || sel.walls.has(`${floor.id}|${c.id}`);
        colAlong(r.rows, c.a === pt.id ? 0 : 1, segColT(plan, c), r.bottom, { floorId: floor.id, floorIndex: i, segId: c.id, interior }, segMaterial(plan, c), selected);
      }

      // (single unconnected points build nothing: they only serve as targets for the floor below)

      // stairs climb to the top of the next floor's slab (top floor: to its ceiling)
      const yStairs = i + 1 < N ? elevation(p, i + 1) + slabs[i + 1].floor : y1;
      if (interior) for (const ob of plan.objects) buildObject(ob, p, y0, y1, yStairs, mats.object, (geo: THREE.BufferGeometry) => add(geo, mats.object, { floorId: floor.id, floorIndex: i, interior: true }));
    }
  }
  return { group: g, stats };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Stairs (a flight of steps along d) or an elevator shaft (four thin walls). */
function buildObject(ob: PlanObject, b: Building, y0: number, y1: number, yStairs: number, _mat: THREE.Material, add: (g: THREE.BufferGeometry) => void) {
  const c = toWorld(b, ob, 0);
  const rot = (ob.rot * Math.PI) / 180;
  const place = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number) => {
    geo.translate(lx, ly, lz);
    geo.rotateY(rot);
    geo.translate(c.x, 0, c.z);
    add(geo);
  };
  if (ob.type === 'stairs') {
    const rise = yStairs - y0;
    const n = Math.max(2, Math.round(rise / 0.18));
    const run = ob.d / n;
    for (let k = 0; k < n; k++) {
      const h = (rise * (k + 1)) / n;
      place(new THREE.BoxGeometry(ob.w, h, run), 0, y0 + h / 2, ob.d / 2 - run * (k + 0.5));
    }
  } else {
    const t = 0.15, h = y1 - y0;
    place(new THREE.BoxGeometry(ob.w, h, t), 0, y0 + h / 2, ob.d / 2 - t / 2);
    place(new THREE.BoxGeometry(ob.w, h, t), 0, y0 + h / 2, -ob.d / 2 + t / 2);
    place(new THREE.BoxGeometry(t, h, ob.d - 2 * t), ob.w / 2 - t / 2, y0 + h / 2, 0);
    place(new THREE.BoxGeometry(t, h, ob.d - 2 * t), -ob.w / 2 + t / 2, y0 + h / 2, 0);
  }
}

/** A fixed-size window fits a division if it is narrower than the division and fits the wall height. */
export const windowFits = (fx: { w: number; h: number; sill: number }, divLen: number, wallH: number) =>
  fx.w <= divLen - 0.02 && fx.sill + fx.h <= wallH - 0.02;

/** Can this window shape be built in this wall division? (fixed-size shapes need room) */
export function slotFits(b: Building, floorId: string, segId: string, shapeId: string): boolean {
  const shape = b.windowShapes.find(s => s.id === shapeId);
  if (!shape?.fixed) return true;
  const fl = b.floors.find(f => f.id === floorId), plan = fl && planForFloor(b, floorId);
  const seg = plan?.segments.find(s => s.id === segId);
  if (!fl || !plan || !seg) return false;
  const d = Math.max(1, seg.divisions ?? 1);
  return windowFits(shape.fixed, (polyLength(sampleSeg(plan, seg)) * b.baseLength) / d, fl.height);
}

/** The point of the plan above nearest to v. */
export function nearestPoint(above: StructurePlan, v: V2) {
  return above.points.reduce((best, q) => (Math.hypot(q.x - v.x, q.y - v.y) < Math.hypot(best.x - v.x, best.y - v.y) ? q : best));
}

/** A closed outline with arc-length parameters (0..1) for its vertices and corners. */
interface Loop { poly: V2[]; params: number[]; corner: Map<string, number>; next: Map<string, string>; segIds: Set<string>; c: V2 }
function loopsOf(plan: StructurePlan): Loop[] {
  return enclosedFacesSegs(plan).map(f => {
    const poly = [...f.poly, f.poly[0]];
    const params = polyParams(poly);
    const corner = new Map(f.ids.map((id, k) => [id, params[f.starts[k]]]));
    const c = f.poly.reduce((s, p) => ({ x: s.x + p.x / f.poly.length, y: s.y + p.y / f.poly.length }), { x: 0, y: 0 });
    const next = new Map(f.ids.map((id, k) => [id, f.ids[(k + 1) % f.ids.length]]));
    return { poly, params, corner, next, segIds: new Set(f.segIds), c };
  });
}
const loopAt = (l: Loop, t: number) => polyAt(l.poly, l.params, ((t % 1) + 1) % 1);

/**
 * How a closed outline morphs into the outline above: both are walked counter-clockwise by
 * arc length; `off` is the rotation that lines them up best (least total distance).
 */
interface Morph { lb: Loop; la: Loop; off: number }
const morphCache = new Map<string, Morph[]>();
const planKey = (pl: StructurePlan) => JSON.stringify([pl.points, pl.segments, pl.smooth]);
function morphs(plan: StructurePlan, above: StructurePlan): Morph[] {
  const key = planKey(plan) + '|' + planKey(above);
  let m = morphCache.get(key);
  if (m) return m;
  const below = loopsOf(plan), up = loopsOf(above);
  m = [];
  if (up.length) {
    for (const lb of below) {
      const la = up.reduce((best, l) => (Math.hypot(l.c.x - lb.c.x, l.c.y - lb.c.y) < Math.hypot(best.c.x - lb.c.x, best.c.y - lb.c.y) ? l : best));
      const K = 96, B = Array.from({ length: K }, (_, k) => loopAt(lb, k / K));
      const cost = (off: number) => B.reduce((s, p, k) => { const q = loopAt(la, k / K + off); return s + (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }, 0);
      let off = 0, best = Infinity;
      for (let k = 0; k < 240; k++) { const c = cost(k / 240); if (c < best) { best = c; off = k / 240; } }
      for (let k = -10; k <= 10; k++) { const o = off + k / 2400, c = cost(o); if (c < best) { best = c; off = o; } } // refine
      m.push({ lb, la, off });
    }
  }
  if (morphCache.size > 200) morphCache.clear();
  morphCache.set(key, m);
  return m;
}

/** Where a point of this plan connects to on the plan above (shown as connection lines). */
export function loftPointTarget(plan: StructurePlan, above: StructurePlan, pt: { id: string; x: number; y: number }): V2 {
  for (const { lb, la, off } of morphs(plan, above)) {
    const t = lb.corner.get(pt.id);
    if (t !== undefined) return loopAt(la, t + off);
  }
  return nearestPoint(above, pt);
}

/**
 * The line on the plan above that a wall connects to. Walls around an enclosed area morph
 * into the matching outline above; other walls (or a ridge / point above) go to the nearest
 * points and the walls between them.
 */
function loftTarget(plan: StructurePlan, above: StructurePlan, seg: PlanSegment): V2[] {
  for (const { lb, la, off } of morphs(plan, above)) {
    if (!lb.segIds.has(seg.id)) continue;
    const ta = lb.corner.get(seg.a)!, tb = lb.corner.get(seg.b)!;
    // walk the outline the way this wall runs (a -> b): forward if b follows a counter-clockwise
    const span = lb.next.get(seg.a) === seg.b ? (((tb - ta) % 1) + 1) % 1 || 1 : -((((ta - tb) % 1) + 1) % 1 || 1);
    if (Math.abs(span) < 1e-9) break;
    const from = ta + off, to = ta + off + span;
    const out: V2[] = [loopAt(la, from)];
    // include the corners of the outline above that fall inside this stretch
    const inner = la.params.slice(0, -1).map(p => {
      const rel = span > 0 ? (((p - from) % 1) + 1) % 1 : (((from - p) % 1) + 1) % 1;
      return { p, rel };
    }).filter(x => x.rel > 1e-6 && x.rel < Math.abs(span) - 1e-6).sort((x, y) => x.rel - y.rel);
    for (const x of inner) out.push(loopAt(la, x.p));
    out.push(loopAt(la, to));
    return out;
  }
  const A = plan.points.find(p => p.id === seg.a)!, B = plan.points.find(p => p.id === seg.b)!;
  const ma = nearestPoint(above, A), mb = nearestPoint(above, B);
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

/**
 * A wall as a closed solid between grid rows, thickened by the offsets.
 * Surface coordinates: u along the wall (0..1), v up the wall (0..1).
 * Window holes are cut in (u, v) space; all faces keep a consistent winding
 * so the mesh volume can be measured.
 */
class WallSolid {
  R: number; C: number; params: number[]; O: V2[]; lenM: number;
  constructor(public rows: Row[], offs: V2[], offParams: number[], public y0: number, public y1: number,
    public W: (v: V2, y: number) => THREE.Vector3, L: number, public tileW: number, public tileH: number) {
    this.R = rows.length - 1; this.C = rows[0].poly.length; this.params = rows[0].params;
    this.O = this.params.map((t, c) => (c === 0 ? offs[0] : c === this.C - 1 ? offs[offs.length - 1] : polyAt(offs, offParams, t)));
    this.lenM = polyLength(rows[0].poly) * L;
  }
  /** Point on the wall surface. side: +1 / -1 = the two faces (scaled for outlines). */
  at(u: number, v: number, side: number): THREE.Vector3 {
    const rf = v * this.R, r0 = Math.min(this.R - 1, Math.floor(rf)), f = rf - r0;
    const a = polyAt(this.rows[r0].poly, this.params, u), b = polyAt(this.rows[r0 + 1].poly, this.params, u);
    const o = polyAt(this.O, this.params, u);
    return this.W({ x: a.x + (b.x - a.x) * f + o.x * side, y: a.y + (b.y - a.y) * f + o.y * side }, this.y0 + (this.y1 - this.y0) * v);
  }
  uvOf(q: THREE.Vector3): { u: number; v: number } {
    const v = clamp01((q.y - this.y0) / (this.y1 - this.y0));
    let best = 0, bd = Infinity;
    for (let k = 0; k <= 200; k++) {
      const p = this.at(k / 200, v, 0), d = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
      if (d < bd) { bd = d; best = k / 200; }
    }
    return { u: best, v };
  }
  vline(u: number, side: number) { return Array.from({ length: this.R + 1 }, (_, r) => this.at(u, r / this.R, side * 1.01)); }
  rect(u0: number, u1: number, side: number) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) pts.push(this.at(u0 + ((u1 - u0) * k) / 10, 0.002, side));
    for (let r = 0; r <= this.R; r++) pts.push(this.at(u1, r / this.R, side));
    for (let k = 10; k >= 0; k--) pts.push(this.at(u0 + ((u1 - u0) * k) / 10, 0.998, side));
    for (let r = this.R; r >= 0; r--) pts.push(this.at(u0, r / this.R, side));
    return pts;
  }

  build(holes: V2[][]): THREE.BufferGeometry {
    const pos: number[] = [], uv: number[] = [];
    const uvOf = (u: number, v: number) => [(u * this.lenM) / this.tileW, ((this.y1 - this.y0) * v) / this.tileH];
    const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
      const A = this.at(a[0], a[1], a[2]), B = this.at(b[0], b[1], b[2]), Cc = this.at(c[0], c[1], c[2]);
      const area = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(Cc, A)).lengthSq();
      if (area < 1e-14) return;
      pos.push(A.x, A.y, A.z, B.x, B.y, B.z, Cc.x, Cc.y, Cc.z);
      uv.push(...uvOf(a[0], a[1]), ...uvOf(b[0], b[1]), ...uvOf(c[0], c[1]));
    };
    // boundary edge a -> b (wall material on its left in u/v): quad joining the two faces
    const edgeQuad = (a: V2, b: V2) => {
      tri([a.x, a.y, -1], [b.x, b.y, -1], [b.x, b.y, 1]);
      tri([a.x, a.y, -1], [b.x, b.y, 1], [a.x, a.y, 1]);
    };
    const P = this.params, R = this.R;

    if (!holes.length) {
      for (let r = 0; r < R; r++) for (let c = 0; c + 1 < this.C; c++) {
        const u0 = P[c], u1 = P[c + 1], v0 = r / R, v1 = (r + 1) / R;
        tri([u0, v0, 1], [u1, v0, 1], [u1, v1, 1]); tri([u0, v0, 1], [u1, v1, 1], [u0, v1, 1]);
        tri([u0, v0, -1], [u1, v1, -1], [u1, v0, -1]); tri([u0, v0, -1], [u0, v1, -1], [u1, v1, -1]);
      }
    } else {
      // triangulate the face with holes in metric u/v space, then subdivide so curved walls stay curved
      const sx = Math.max(this.lenM, 1e-6), sy = Math.max(this.y1 - this.y0, 1e-6);
      const outer: V2[] = [];
      for (let c = 0; c < this.C; c++) outer.push({ x: P[c], y: 0 });
      for (let r = 1; r <= R; r++) outer.push({ x: 1, y: r / R });
      for (let c = this.C - 2; c >= 0; c--) outer.push({ x: P[c], y: 1 });
      for (let r = R - 1; r >= 1; r--) outer.push({ x: 0, y: r / R });
      const toV = (q: V2) => new THREE.Vector2(q.x * sx, q.y * sy);
      const tris = THREE.ShapeUtils.triangulateShape(outer.map(toV), holes.map(h => h.map(toV)));
      const all = [...outer, ...holes.flat()];
      const curved = this.C > 2 || R > 1;
      const du = curved ? Math.max(1 / 64, Math.min(...P.slice(1).map((t, k) => t - P[k]).filter(x => x > 1e-6), 1)) : 2;
      const dv = curved ? 1 / R : 2;
      const emit = (a: V2, b: V2, c: V2, depth: number) => {
        const us = [a.x, b.x, c.x], vs = [a.y, b.y, c.y];
        if (depth < 7 && (Math.max(...us) - Math.min(...us) > du * 1.01 || Math.max(...vs) - Math.min(...vs) > dv * 1.01)) {
          const m = (p: V2, q: V2) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          const ab = m(a, b), bc = m(b, c), ca = m(c, a);
          emit(a, ab, ca, depth + 1); emit(ab, b, bc, depth + 1); emit(ca, bc, c, depth + 1); emit(ab, bc, ca, depth + 1);
          return;
        }
        tri([a.x, a.y, 1], [b.x, b.y, 1], [c.x, c.y, 1]);
        tri([a.x, a.y, -1], [c.x, c.y, -1], [b.x, b.y, -1]);
      };
      for (const [i, j, k] of tris) {
        let a = all[i], b = all[j], c = all[k];
        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) [b, c] = [c, b]; // counter-clockwise on the + face
        emit(a, b, c, 0);
      }
      // window reveals (holes run clockwise, so the wall is on their left)
      for (const h of holes) for (let k = 0; k < h.length; k++) edgeQuad(h[k], h[(k + 1) % h.length]);
    }
    // outer boundary, counter-clockwise: bottom, end, top, start
    for (let c = 0; c + 1 < this.C; c++) edgeQuad({ x: P[c], y: 0 }, { x: P[c + 1], y: 0 });
    for (let r = 0; r < R; r++) edgeQuad({ x: 1, y: r / R }, { x: 1, y: (r + 1) / R });
    for (let c = this.C - 1; c > 0; c--) edgeQuad({ x: P[c], y: 1 }, { x: P[c - 1], y: 1 });
    for (let r = R; r > 0; r--) edgeQuad({ x: 0, y: r / R }, { x: 0, y: (r - 1) / R });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return geo;
  }
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

/** Volume of a closed triangle mesh (non-indexed or indexed). */
export function meshVolume(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  let v = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
    v += a.dot(new THREE.Vector3().crossVectors(b, c));
  }
  return Math.abs(v / 6);
}

/** Gross floor area of floor i (m²): area enclosed by its external walls (or the slab under it). */
export function floorArea(b: Building, i: number): number {
  const L2 = b.baseLength ** 2;
  const pl = planAtLevel(b, i);
  return (pl ? enclosedFacesSegs(pl).reduce((s, f) => s + Math.abs(signedArea(f.poly)), 0) : 0) * L2;
}
