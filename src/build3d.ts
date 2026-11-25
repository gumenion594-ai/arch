// Turns a building into 3D geometry (structural / detailed views).
import * as THREE from 'three';
import {
  Building, Floor, OpeningShape, Placement, PlanObject, PlanSegment, StructurePlan, Texture, WinPoint, divisionBorders, elevation, hasCeiling, hasFloor,
  BALCONY_AT, PILASTER_REF_H, PilasterShape, mainFloorIndex, newPlan, nextMainFloor, planForFloor, segColT, segConnect, segConnectSmooth, segDivLen, segKind, segMaterial, segSmoothSpan,
  openingUse,
} from './model';
import { fitDesign, fitDesignSliced } from './assets';
import { REF_WALL } from './deco';
import { SPIRAL_POST, stairLayout } from './stairs';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import polygonClipping, { MultiPolygon } from 'polygon-clipping';
import { V2, areaFaces, enclosedFaces, enclosedFacesSegs, planarize, pointInPoly, smoothClosed, polyAt, polyLength, polyParams, sampleSeg, samplePath, shortestPath, signedArea } from './geometry';

export type Mats = {
  wall(material: string): THREE.Material;
  column(material: string): THREE.Material;
  color(css: string): THREE.Material; // a user-chosen colour
  slab: THREE.Material;
  object: THREE.Material;
  deco: THREE.Material; // cornices, pilasters, balconies, balusters (plain stone)
  edge: THREE.LineBasicMaterial;
  selected: THREE.Material;
  selLine: THREE.LineBasicMaterial;
  tex: (id: string) => THREE.Material | null;
  /** A material's Detailed-view look, tinted by a colour (default: the material's own). */
  look: (material: string, color?: string | null) => THREE.Material;
  /** Loaded imported design (null while loading / in views that don't show designs). */
  design?: (id: string | null | undefined) => THREE.Object3D | null;
};

/** What a mesh represents: used for clicking (selection) and for weight calculation. */
export interface PickInfo {
  floorId: string;
  floorIndex: number;
  segId?: string;
  interior?: boolean;
  placementId?: string;
  /** Division borders of the wall as u (0..1 along it). */
  borders?: number[];
  /** Openings / niches on the wall: their extent in u/v, to pick them by clicking the wall. */
  holes?: { id: string; u0: number; u1: number; v0: number; v1: number }[];
  /** Wall coordinates (u along the wall 0..1, v up the wall 0..1) of a point on its surface. */
  uvOf?: (p: THREE.Vector3) => { u: number; v: number };
}
export interface StatInfo { cat: 'ext' | 'int' | 'col'; material: string }

/** ids: floors floorId · walls floorId|segId · divisions floorId|segId|k · borders floorId|segId|k · elements placement id */
export interface Selection { floors: Set<string>; walls: Set<string>; divisions: Set<string>; borders: Set<string>; elements: Set<string> }
export const emptySelection = (): Selection => ({ floors: new Set(), walls: new Set(), divisions: new Set(), borders: new Set(), elements: new Set() });

export interface BuildOpts {
  detailed: boolean;
  interior: boolean; // build floor-plan (internal) walls, stairs, elevators
  mats: Mats;
  selection?: Selection;
  textures: Texture[];
  /** Cutaway: build floors up to this index only, without its ceiling (to look inside). */
  upTo?: number | null;
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

/**
 * Automatic floor area of floor i: what its external walls enclose, plus the areas of the floor below
 * whose walls go straight up (so a setback room is covered by the floor of the storey above) — but not
 * open terraces (areas edged by a railing), which stay open to the sky.
 */
export function autoFloorAreas(b: Building, i: number): V2[][] {
  const own = planAtLevel(b, i);
  const below = i > 0 ? planAtLevel(b, i - 1) : null;
  const out: V2[][] = own ? enclosedFacesSegs(own).map(f => f.poly) : [];
  if (below && below !== own) {
    const same = (a: V2[], c: V2[]) => a.length === c.length && a.every(q => c.some(r => Math.hypot(q.x - r.x, q.y - r.y) < 1e-6));
    for (const f of enclosedFacesSegs(below)) {
      const segs = f.segIds.map(id => below.segments.find(s => s.id === id)!);
      if (segs.some(s => segKind(s) === 'balustrade')) continue; // an open terrace below: no floor over it (it would hang with nothing holding it)
      if (segs.every(s => segConnect(below, s) !== 'loft') && !out.some(o => same(o, f.poly))) out.push(f.poly); // skip exact repeats
    }
  }
  return out;
}
/**
 * Rooms of a floor plan: the areas closed in by the external walls of a floor using it together with its own
 * walls (smallest first). Each has `filled` when a fill mark lies in it.
 */
export function roomFaces(b: Building, ip: StructurePlan): { poly: V2[]; area: number; filled: boolean }[] {
  const fid = b.floors.find(f => ip.floorIds.includes(f.id))?.id;
  const ext = b.plans.find(pl => pl.id === ip.structureId) ?? (fid ? planForFloor(b, fid) : undefined);
  const key = 'rooms:' + JSON.stringify([ext?.points, ext?.segments.map(s => [s.a, s.b]), ip.points, ip.segments.map(s => [s.a, s.b])]);
  let polys = roomCache.get(key);
  if (!polys) {
    const tmp: StructurePlan = { ...newPlan('tmp'), points: [], segments: [] };
    const take = (pl: StructurePlan) => {
      for (const q of pl.points) tmp.points.push({ ...q });
      for (const sg of pl.segments) if (segKind(sg) !== 'open') { const sp = sampleSeg(pl, sg); let prev = sg.a;
        for (let k = 1; k < sp.length - 1; k++) { const id = `${sg.id}~${k}`; tmp.points.push({ id, n: 0, x: sp[k].x, y: sp[k].y }); tmp.segments.push({ id: `${sg.id}#${k}`, a: prev, b: id }); prev = id; }
        tmp.segments.push({ id: `${sg.id}#e`, a: prev, b: sg.b }); }
    };
    if (ext) take(ext);
    take(ip);
    let n = 0;
    planarize(tmp, () => `r${n++}`);
    polys = enclosedFaces(tmp);
    roomCache.set(key, polys);
  }
  return polys.map(poly => ({ poly, area: Math.abs(signedArea(poly)), filled: false })).sort((a, c) => a.area - c.area)
    .map((f, _i, all) => ({ ...f, filled: (ip.filled ?? []).some(s => pointInPoly(s, f.poly) && all.find(g => pointInPoly(s, g.poly)) === f) }));
}
const roomCache = new Map<string, V2[][]>();

/** A floor's floor area: the one drawn in its structure plan (none: automatic, inside the walls). */
export const areaForFloor = (b: Building, floorId: string) => planForFloor(b, floorId)?.area ?? null;
/** A region of the plan: outer ring (counter-clockwise) and holes. */
export type Region = { outer: V2[]; holes: V2[][] };
const regionCache = new Map<string, Region[]>();
/** Exact union of polygons minus carves: no part of the plan is covered twice. */
export function unionRegions(areas: V2[][], carves: V2[][] = []): Region[] {
  const key = JSON.stringify([areas, carves]);
  const hit = regionCache.get(key);
  if (hit) return hit;
  const ring = (a: V2[]) => a.map(q => [q.x, q.y] as [number, number]);
  let out: Region[] = [];
  try {
    const polys = areas.filter(a => a.length >= 3 && Math.abs(signedArea(a)) > 1e-10).map(a => [ring(a)]);
    let mp: MultiPolygon = polys.length ? polygonClipping.union(polys[0], ...polys.slice(1)) : [];
    const cs = carves.filter(c => c.length >= 3 && Math.abs(signedArea(c)) > 1e-10).map(c => [ring(c)]);
    if (mp.length && cs.length) mp = polygonClipping.difference(mp, ...cs);
    const back = (r: [number, number][]) => { const v = r.map(([x, y]) => ({ x, y })); if (v.length > 1 && Math.hypot(v[0].x - v[v.length - 1].x, v[0].y - v[v.length - 1].y) < 1e-12) v.pop(); return v; };
    out = mp.map(poly => {
      const outer = back(poly[0]), holes = poly.slice(1).map(back);
      if (signedArea(outer) < 0) outer.reverse();
      for (const h of holes) if (signedArea(h) > 0) h.reverse();
      return { outer, holes };
    }).filter(r => r.outer.length >= 3);
  } catch {
    out = areas.filter(a => a.length >= 3).map(a => ({ outer: signedArea(a) < 0 ? [...a].reverse() : a, holes: [] })); // degenerate input: fall back
  }
  if (regionCache.size > 300) regionCache.clear();
  regionCache.set(key, out);
  return out;
}
const regionArea = (rs: Region[]) => rs.reduce((s, r) => s + Math.abs(signedArea(r.outer)) - r.holes.reduce((h, q) => h + Math.abs(signedArea(q)), 0), 0);
const inRegions = (rs: Region[], q: V2) => rs.some(r => pointInPoly(q, r.outer) && !r.holes.some(h => pointInPoly(q, h)));
/** Floor i's slab as non-overlapping regions. */
export function floorRegions(b: Building, i: number): Region[] {
  const f = b.floors[i];
  if (!f) return [];
  const ap = areaForFloor(b, f.id);
  const base = ap ? areaPlanRegions(ap) : unionRegions(autoFloorAreas(b, i));
  return base; // (stairs do not cut the floor above: carve an opening in the structure's floor area where you want one)
}
/** Floor j's walls set to run over the next slab: bands (as wide as the wall on both sides of its line) cut out of that slab. */
function wrapBands(b: Building, j: number): V2[][] {
  const f = b.floors[j], pl = f && planForFloor(b, f.id);
  if (!pl) return [];
  const out: V2[][] = [], hw = pl.wallThickness / b.baseLength;
  for (const sg of pl.segments) {
    const k = segKind(sg);
    if ((k !== 'wall' && k !== 'door' && k !== 'steel') || segConnect(pl, sg) !== 'wrap') continue;
    const bt = sampleSeg(pl, sg);
    for (let q = 0; q + 1 < bt.length; q++) {
      const a = bt[q], c = bt[q + 1], d = norm({ x: c.x - a.x, y: c.y - a.y }), n = { x: -d.y * hw, y: d.x * hw };
      const a2 = { x: a.x - d.x * hw, y: a.y - d.y * hw }, c2 = { x: c.x + d.x * hw, y: c.y + d.y * hw };
      out.push([{ x: a2.x + n.x, y: a2.y + n.y }, { x: c2.x + n.x, y: c2.y + n.y }, { x: c2.x - n.x, y: c2.y - n.y }, { x: a2.x - n.x, y: a2.y - n.y }]);
    }
  }
  return out;
}
function regionsMinus(base: Region[], holes: V2[][]): Region[] {
  const key = 'minus:' + JSON.stringify([base, holes]);
  const hit = regionCache.get(key);
  if (hit) return hit;
  const ring = (a: V2[]) => a.map(q => [q.x, q.y] as [number, number]);
  let out: Region[] = base;
  try {
    const mp = polygonClipping.difference(base.map(r => [ring(r.outer), ...r.holes.map(ring)]), ...holes.map(hh => [ring(hh)]));
    out = unionRegions(mp.map(poly => poly[0].map(([x, y]) => ({ x, y }))), mp.flatMap(poly => poly.slice(1).map(hh => hh.map(([x, y]) => ({ x, y })))));
  } catch { /* keep the floor whole */ }
  regionCache.set(key, out);
  return out;
}
/** A floor-area plan's floor: its enclosed shapes, carved ones removed (a shape inside another one decides for itself). */
export function areaPlanRegions(pl: StructurePlan): Region[] {
  const key = 'area:' + JSON.stringify([pl.points, pl.segments.map(s => [s.a, s.b]), pl.carved]);
  const hit = regionCache.get(key);
  if (hit) return hit;
  const ring = (a: V2[]) => [a.map(q => [q.x, q.y] as [number, number])];
  let mp: MultiPolygon = [];
  try {
    for (const f of areaFaces(pl)) { // largest first: smaller shapes inside them come later and win
      if (f.area < 1e-10) continue;
      mp = f.carved ? (mp.length ? polygonClipping.difference(mp, ring(f.poly)) : mp) : polygonClipping.union(mp, ring(f.poly));
    }
  } catch { mp = []; }
  const out = unionRegions(mp.map(poly => poly[0].map(([x, y]) => ({ x, y }))), mp.flatMap(poly => poly.slice(1).map(h => h.map(([x, y]) => ({ x, y })))));
  regionCache.set(key, out);
  return out;
}
/** Is plan point q on floor i's slab? */
export function floorCovers(b: Building, i: number, q: V2): boolean {
  return inRegions(floorRegions(b, i), q);
}
/**
 * Roof of the top floor (nothing above it to be its ceiling): areas enclosed by walls going straight
 * up; where walls connect to the Top level, its shape. A ridge or a point (a pitched roof) needs none.
 */
function roofFaces(b: Building, i: number): V2[][] {
  const pl = planAtLevel(b, i);
  if (!pl) return [];
  const out: V2[][] = [];
  let lofted = false;
  for (const f of enclosedFacesSegs(pl)) {
    const segs = f.segIds.map(id => pl.segments.find(s => s.id === id)!);
    if (segs.some(s => segKind(s) === 'balustrade')) continue; // an open terrace
    if (segs.every(s => segConnect(pl, s) !== 'loft')) out.push(f.poly);
    else lofted = true;
  }
  const above = planAtLevel(b, i + 1);
  if (lofted && above && above !== pl) out.push(...enclosedFacesSegs(above).map(f => f.poly));
  return out;
}
const roofRegions = (b: Building, i: number) => unionRegions(roofFaces(b, i));
/** Slab thicknesses of floor i: its floor (each floor's floor is the ceiling of the one below) and, on the top floor only, the roof. */
export function slabThickness(b: Building, i: number): { floor: number; ceiling: number } {
  const f = b.floors[i], pl = planAtLevel(b, i) ?? (i > 0 ? planAtLevel(b, i - 1) : null);
  if (!pl) return { floor: 0, ceiling: 0 };
  const fl = hasFloor(f) && floorRegions(b, i).length ? Math.min(pl.floorThickness, f.height * 0.45) : 0;
  const top = i === b.floors.length - 1;
  const ce = top && hasCeiling(f) && roofFaces(b, i).length ? Math.min(pl.ceilingThickness, f.height * 0.45) : 0;
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
  const slab = (regions: Region[], y: number, t: number, i: number) => regions.forEach(r => {
    const shape = new THREE.Shape(r.outer.map(v => new THREE.Vector2(v.x * L, v.y * L)));
    for (const h of r.holes) shape.holes.push(new THREE.Path(h.map(v => new THREE.Vector2(v.x * L, v.y * L))));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(p.x, y, -p.y);
    const fl = p.floors[i];
    const tex = o.detailed && fl.texture ? mats.tex(fl.texture) : null;
    const top = sel.floors.has(fl.id) ? mats.selected : tex ?? (fl.color ? mats.color(fl.color) : mats.slab);
    // the slab's edge is flush with the outside of the walls: give it the wall's look so the facade reads as one surface
    // (it reads as the top of the storey below, so it takes that storey's wall look — never the roof's)
    const pl = (i > 0 ? planAtLevel(p, i - 1) : null) ?? planAtLevel(p, i), w = pl?.segments.find(sg => segKind(sg) === 'wall');
    const edge = sel.floors.has(fl.id) ? mats.selected : !pl || !w ? top
      : (o.detailed && w.texture ? mats.tex(w.texture) : null) ?? (w.color ? mats.color(w.color) : mats.wall(o.detailed ? segMaterial(pl, w) : 'structural'));
    const m = add(geo, top, { floorId: fl.id, floorIndex: i });
    (m as unknown as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>).material = [top, edge]; // ExtrudeGeometry groups: 0 = top / bottom, 1 = sides
  });
  const cut = o.upTo ?? null;
  const hidden = (i: number) => cut !== null && i > cut;
  for (let i = 0; i < N; i++) {
    if (hidden(i)) continue;
    // (walls of the floor below that run up over this slab's edge: the slab stops at their inner face)
    const wb = i > 0 ? wrapBands(p, i - 1) : [];
    if (slabs[i].floor) slab(wb.length ? regionsMinus(floorRegions(p, i), wb) : floorRegions(p, i), elevation(p, i), slabs[i].floor, i);
    const wt = slabs[i].ceiling ? wrapBands(p, i) : [];
    if (slabs[i].ceiling && i !== cut) slab(wt.length ? regionsMinus(roofRegions(p, i), wt) : roofRegions(p, i), elevation(p, i + 1) - slabs[i].ceiling, slabs[i].ceiling, i); // the roof (top floor)
  }

  // ---------- walls / columns per floor ----------
  const segMat = (seg: PlanSegment, material: string, column = false) => {
    // Structural view: only the colour. Detailed view: the material's look tinted by the colour; a texture covers everything
    if (o.detailed) return (seg.texture ? mats.tex(seg.texture) : null) ?? mats.look(material, seg.color);
    return seg.color ? mats.color(seg.color) : column ? mats.column(material) : mats.wall('structural');
  };
  const placeMat = (pl: Placement, fallback: THREE.Material) => {
    if (sel.elements.has(pl.id)) return mats.selected;
    const tex = o.detailed && pl.texture ? mats.tex(pl.texture) : null;
    return tex ?? (pl.color ? mats.color(pl.color) : fallback);
  };
  /** An imported design fitted into a box, only in the detailed view (null otherwise). */
  let passDesign = false; // designs being placed in a door: you can walk through them
  const designAt = (id: string | null | undefined, c: THREE.Vector3, along: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3, w: number, h: number, d: number, recolor?: THREE.Material | null, pick?: PickInfo, sliced = false, clip?: THREE.Plane[], cutouts?: Cutouts) => {
    if (!o.detailed || !id || !mats.design) return false;
    const src = mats.design(id);
    if (!src) return false;
    if (src.userData.decoType && recolor !== mats.selected) recolor = null; // a design keeps its parts' own looks (only the selection highlight replaces them)
    const obj = sliced ? fitDesignSliced(src, c, along, up, out, w, h, d) : fitDesign(src, c, along, up, out, w, h, d);
    let glass = false;
    obj.traverse(x => {
      const m = x as THREE.Mesh;
      if (!m.isMesh) return;
      const was = m.material as THREE.Material;
      if (!Array.isArray(was) && was.transparent && (was as THREE.MeshStandardMaterial).opacity < 0.9) glass = true;
      if (recolor) m.material = recolor;
      if (clip?.length || cutouts) { // cut to the element's own outline (each placement its own planes) and its openings
        // one copy per source material for everything sharing these planes (all the copies of a pattern in a division)
        const key = (clip ?? cutouts) as object;
        let cache = cutMatCache.get(key);
        if (!cache) cutMatCache.set(key, (cache = new Map()));
        const one = (x: THREE.Material) => {
          let c2 = cache!.get(x);
          if (!c2) { c2 = x.clone(); if (clip?.length) c2.clippingPlanes = clip; if (cutouts) withCutouts(c2, cutouts); cache!.set(x, c2); }
          return c2;
        };
        m.material = Array.isArray(m.material) ? m.material.map(one) : one(m.material as THREE.Material);
      }
      // doors walk-through; wall / roof patterns too (only drawn cut out over the openings: the wall under them, which
      // has real holes, is what you bump into)
      m.userData = { pick, passThrough: passDesign || !!cutouts || !!clip?.length };
    });
    g.add(obj);
    return glass ? 'glass' : true;
  };

  // roofs (segments of type Roof): how far the eaves run out and how steep they are, per floor
  const OVERHANG = 0.5, ROOF_T = 0.2;
  const roofInfo = p.floors.map((_, i) => {
    const ext = planAtLevel(p, i), above = planAtLevel(p, i + 1);
    if (!ext || !above || !above.points.length) return null;
    let dmin = Infinity;
    for (const sg of ext.segments) {
      if (segKind(sg) !== 'roof') continue;
      const bt = sampleSeg(ext, sg), tp = loftTarget(ext, above, sg);
      const bm = polyAt(bt, polyParams(bt), 0.5), tm = polyAt(tp, polyParams(tp), 0.5);
      const d = Math.hypot(tm.x - bm.x, tm.y - bm.y) * L;
      if (d > 0.05) dmin = Math.min(dmin, d);
    }
    if (!isFinite(dmin)) return null;
    const H = elevation(p, i + 1) - elevation(p, i), slope = H / dmin;
    return { k: OVERHANG / dmin, slope, lift: (ROOF_T / 2) * Math.sqrt(1 + slope * slope) };
  });

  type ColPiece = { a: THREE.Vector3; c: THREE.Vector3; ct: number; bottom: V2[]; pick: PickInfo; seg: PlanSegment; material: string; selected: boolean };
  type PilPiece = { base: THREE.Vector3; out: THREE.Vector3; along: THREE.Vector3; y0: number; y1: number; pw: number; pd: number; pl: Placement; mat: THREE.Material; pick: PickInfo; floor: number };
  const colPieces: ColPiece[] = [], pilPieces: PilPiece[] = [];

  for (let i = 0; i < N; i++) {
    const floor = p.floors[i];
    // external walls run the full floor height; internal walls stand between floor and ceiling
    const yBase = elevation(p, i), yTop = elevation(p, i + 1);
    if (yTop - yBase <= 1e-6 || hidden(i)) continue;
    const floorSel = sel.floors.has(floor.id);

    const plans: { plan: StructurePlan; interior: boolean }[] = [];
    const ext = planAtLevel(p, i);
    if (ext) plans.push({ plan: ext, interior: false });
    const inner = o.interior ? interiorForFloor(p, floor.id) : null;
    if (inner) plans.push({ plan: inner, interior: true });

    // footprints of the external walls (plan), for trimming internal walls
    const extBands: V2[][] = [];
    if (ext) for (const sg of ext.segments) {
      if (segKind(sg) !== 'wall' && segKind(sg) !== 'door') continue;
      const bt = sampleSeg(ext, sg), fs = faceSide(ext, sg), half = (fs !== 0 ? ext.wallThickness : ext.wallThickness / 2) / L;
      for (let k = 0; k + 1 < bt.length; k++) {
        const a = bt[k], c = bt[k + 1], d = norm({ x: c.x - a.x, y: c.y - a.y }), n = { x: -d.y * half, y: d.x * half };
        const a2 = { x: a.x - d.x * half, y: a.y - d.y * half }, c2 = { x: c.x + d.x * half, y: c.y + d.y * half };
        extBands.push([{ x: a2.x + n.x, y: a2.y + n.y }, { x: c2.x + n.x, y: c2.y + n.y }, { x: c2.x - n.x, y: c2.y - n.y }, { x: a2.x - n.x, y: a2.y - n.y }]);
      }
    }
    for (const { plan, interior } of plans) {
      const y0 = interior ? yBase + slabs[i].floor : yBase;
      const y1 = interior ? yTop - slabs[i].ceiling : yTop;
      const above = interior ? null : planAtLevel(p, i + 1);
      let vert: Vertical | undefined;
      const rowsBySeg = new Map<string, { rows: Row[]; bottom: V2[] }>();
      const colAlong = (rows: Row[], t: number, ct: number, bottom: V2[], pick: PickInfo, seg: PlanSegment, material: string, selected: boolean, shift?: V2) => {
        // columns stand inside the line, their outer face on it (like the walls); corner columns get their own shift
        const fs = interior ? 0 : faceSide(plan, seg);
        const d0 = norm({ x: bottom[bottom.length - 1].x - bottom[0].x, y: bottom[bottom.length - 1].y - bottom[0].y });
        const inward = shift ?? { x: -d0.y * fs * (ct / 2 / L), y: d0.x * fs * (ct / 2 / L) };
        // straight columns stand on the floor where there is floor under them, and reach the next floor (or the roof)
        const q0 = polyAt(rows[0].poly, rows[0].params, t);
        const onSlab = rows.length === 2 && slabs[i].floor > 0 && floorCovers(p, i, { x: q0.x + inward.x, y: q0.y + inward.y });
        const c0 = onSlab ? y0 + slabs[i].floor : y0, c1 = rows.length === 2 ? y1 - slabs[i].ceiling : y1;
        const pts = rows.map((r, ri) => { const q = polyAt(r.poly, r.params, t); return W({ x: q.x + inward.x, y: q.y + inward.y }, c0 + (c1 - c0) * (ri / (rows.length - 1))); });
        if (pts.length === 2) {
          // straight columns are collected and joined with the ones above / below after all floors are built
          colPieces.push({ a: pts[0], c: pts[1], ct, bottom, pick, seg, material, selected });
          return;
        }
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k], c = pts[k + 1];
          // imported column design (detailed view), else a plain square column
          const dir = norm({ x: bottom[bottom.length - 1].x - bottom[0].x, y: bottom[bottom.length - 1].y - bottom[0].y });
          const along = new THREE.Vector3(dir.x, 0, -dir.y), up = new THREE.Vector3().subVectors(c, a);
          const mid = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
          const out = new THREE.Vector3().crossVectors(along, up).normalize();
          if (pts.length === 2 && designAt(seg.columnDesign, mid, along, up, out, ct, a.distanceTo(c), ct, selected ? mats.selected : seg.color ? mats.color(seg.color) : null, pick)) continue;
          add(column(a, c, ct, bottom), selected ? mats.selected : segMat(seg, material, true), pick, { cat: 'col', material });
        }
      };
      const placements = interior ? [] : p.placements.filter(pl => pl.floorId === floor.id);

      for (const seg of plan.segments) {
        const kind = segKind(seg);
        if (kind === 'open') continue;
        const material = segMaterial(plan, seg);
        let bottom = sampleSeg(plan, seg);
        if (interior) { // internal walls stop at the inside face of the external walls (no overlap)
          const tr = trimOutside(bottom, extBands);
          if (!tr) continue;
          bottom = tr;
        }
        const lenM = polyLength(bottom) * L;
        const borders = divisionBorders(lenM, segDivLen(p, seg)).map(x => (lenM > 0 ? x / lenM : 0));
        const wallKey = `${floor.id}|${seg.id}`;
        const selected = floorSel || sel.walls.has(wallKey);
        const pick: PickInfo = { floorId: floor.id, floorIndex: i, segId: seg.id, interior, borders };

        if (kind === 'balustrade') {
          const yb = y0 + slabs[i].floor;
          const fs = faceSide(plan, seg), d0 = norm({ x: bottom[bottom.length - 1].x - bottom[0].x, y: bottom[bottom.length - 1].y - bottom[0].y });
          const inw = { x: -d0.y * fs * (0.1 / L), y: d0.x * fs * (0.1 / L) }; // the railing stands just inside the line
          balusters(bottom.map(q => W({ x: q.x + inw.x, y: q.y + inw.y }, yb)), seg.balusterDesign, selected ? mats.selected : seg.color ? mats.color(seg.color) : mats.deco, pick);
          continue;
        }
        let top = bottom;
        // a roof rises to the plan above (whatever its connection setting)
        const isRoof = kind === 'roof' && !interior;
        const loft = !interior && (segConnect(plan, seg) === 'loft' || isRoof) && above && above.points.length > 0;
        if (loft) top = loftTarget(plan, above!, seg);
        let rows = buildGrid(bottom, top, loft ? segConnectSmooth(plan, seg) : 0,
          loft && segSmoothSpan(plan, seg) ? (vert ??= verticalFor(p, i)) : undefined);
        const eave = isRoof && loft ? roofInfo[i] : null;
        if (eave) {
          // eaves: the roof runs on past the wall line, down its own slope, by the overhang
          const r0 = rows[0].poly, rR = rows[rows.length - 1].poly, R = rows.length - 1;
          const ext = r0.map((q, j) => ({ x: q.x + (q.x - rR[j].x) * eave.k, y: q.y + (q.y - rR[j].y) * eave.k }));
          rows = rows.map((row, r) => ({ poly: ext.map((e, j) => ({ x: e.x + (rR[j].x - e.x) * (r / R), y: e.y + (rR[j].y - e.y) * (r / R) })), params: row.params }));
        }

        if (kind === 'steel') {
          // a steel frame instead of a wall: I-beams up every division border and the middle of every division,
          // and along the bottom and top, all following the segment's shape (curved, sloped, lofted)
          const fs = interior ? 0 : faceSide(plan, seg), B = 0.2;
          const offs = offsets(plan, seg, bottom, B / 2 / L).map(v => (!interior && fs !== -1 ? { x: -v.x, y: -v.y } : v));
          const frame = new WallSolid(rows, offs, polyParams(bottom), y0 + (slabs[i].floor > 0 ? slabs[i].floor : 0), y1, W, L, 1, 1, B);
          if (fs !== 0 && !loft) frame.shift = -1; // inside the line, like walls
          const mat = selected ? mats.selected : segMat(seg, material);
          const us = new Set<number>();
          borders.forEach((b, k) => { us.add(b); if (k + 1 < borders.length) us.add((b + borders[k + 1]) / 2); });
          const steps = Math.max(2, rows.length - 1) * (loft ? 4 : 1);
          for (const u of us) {
            const pts = Array.from({ length: steps + 1 }, (_, k) => frame.at(clamp01(u), k / steps, 0));
            for (let k = 0; k < steps; k++) add(steelBeam(pts[k], pts[k + 1], frame.frame(clamp01(u), (k + 0.5) / steps).along, B), mat, pick, { cat: 'col', material });
          }
          const ps = [...new Set([...frame.params, ...borders])].sort((a, c) => a - c);
          for (const v of [0, 1]) {
            const yv = v === 0 ? 0.0001 : 0.9999;
            for (let k = 0; k + 1 < ps.length; k++) {
              const a = frame.at(ps[k], yv, 0), c = frame.at(ps[k + 1], yv, 0);
              add(steelBeam(a, c, new THREE.Vector3(0, 1, 0), B), mat, pick, { cat: 'col', material });
            }
          }
          continue;
        }

        if (kind === 'wall' || kind === 'door' || kind === 'roof') {
          // +1 side of the wall = outside of the building
          // external walls stand inside the line (outer face on it, flush with floors and ceilings);
          // walls not around an enclosed area, and internal walls, stay centred on it
          const fs = interior ? 0 : faceSide(plan, seg);
          const flip = !interior && fs !== -1;
          const thick = isRoof ? ROOF_T : plan.wallThickness;
          const offs = offsets(plan, seg, bottom, thick / 2 / L).map(v => (flip ? { x: -v.x, y: -v.y } : v));
          const texInfo = seg.texture ? o.textures.find(t => t.id === seg.texture) : undefined;
          const tileH = texInfo ? floor.height : 1, tileW = texInfo ? tileH * (texInfo.w / texInfo.h) : 1; // material looks: 1 tile = 1 m
          // a door segment is just the lintel above a 2.1 m opening
          const wall = new WallSolid(rows, offs, polyParams(bottom), y0, y1, W, L, tileW, tileH, thick);
          if (fs !== 0 && !loft) wall.shift = -1; // sloped (connected) walls such as roofs stay centred: they overhang a little
          const wsh = seg.wallShape ? p.wallShapes.find(x => x.id === seg.wallShape) : undefined;
          if (wsh && wsh.profile.length) {
            const half = plan.wallThickness / 2;
            wall.prof = v => (profileAt(wsh.profile, v) * wsh.depth) / half;
            wall.profBreaks = profileBreaks(wsh.profile);
          }
          // no overlaps: an external wall stands on its floor's slab and stops under the roof (the next floor's slab starts where it ends)
          const toPlan = (v: THREE.Vector3): V2 => ({ x: (v.x - p.x) / L, y: (-v.z - p.y) / L });
          // (tested a little to each side of the wall's middle: a wall centred on the slab's edge still counts)
          const sides = [0, 0.5, -0.5];
          const onSlab = !interior && slabs[i].floor > 0 && (isRoof || sides.some(k => floorCovers(p, i, toPlan(wall.at(0.5, 0, k)))));
          const underRoof = !interior && slabs[i].ceiling > 0 && sides.some(k => inRegions(roofRegions(p, i), toPlan(wall.at(0.5, 1, k))));
          // "over the next floor's slab": the wall runs on up past the floor and covers the slab edge above (or the roof's)
          const wrapUp = !interior && !isRoof && !loft && segConnect(plan, seg) === 'wrap';
          const yw0 = onSlab ? y0 + slabs[i].floor : y0;
          const yw1 = wrapUp ? (underRoof ? y1 : i + 1 < N ? y1 + slabs[i + 1].floor : y1) : underRoof ? y1 - slabs[i].ceiling : y1;
          // a door segment is just the lintel above a 2.1 m opening
          const yb = kind === 'door' ? yw0 + Math.min(2.1, (yw1 - yw0) * 0.8) : yw0;
          wall.y0 = yb; wall.y1 = yw1;
          if (eave) {
            // the eaves drop below the wall top by the overhang's share of the slope; the whole roof rises by half its
            // thickness, so its underside meets the slab top at the wall line (resting on it, not cutting into it)
            wall.y0 = yb - (yw1 - yb) * eave.k + eave.lift;
            wall.y1 = yw1 + eave.lift;
          }
          const wallH = wall.y1 - wall.y0;

          // openings and niches: holes in u/v; big ones reach into the neighbouring divisions
          const holes: Hole[] = [];
          pick.holes = [];
          for (const pl of placements) {
            if (pl.segId !== seg.id || (pl.type !== 'opening' && pl.type !== 'niche') || (kind !== 'wall' && kind !== 'roof')) continue;
            const shape = p.openingShapes.find(x => x.id === pl.shapeId);
            if (!shape || !shape.outlines.some(ol => ol.length >= 3)) continue;
            const k = Math.min(Math.max(0, pl.div ?? 0), borders.length - 2);
            const sc = ((borders[k] + borders[k + 1]) / 2) * lenM + pl.dx;
            const yLow = shape.anchor === 'bottom' ? (onSlab || interior ? 0 : slabs[i].floor) + pl.dy : (wallH - shape.h) / 2 + pl.dy;
            const polys = shape.outlines.filter(ol => ol.length >= 3).map(ol => smoothClosed(ol, shape.smooth).map(q => ({
              x: (sc + (q.x - 0.5) * shape.w) / lenM,
              y: (yLow + q.y * shape.h) / wallH,
            }))).map(poly => clipRect(poly, 0.003, 0.997)).filter(poly => poly.length >= 3 && Math.abs(signedArea(poly)) > 1e-7);
            if (!polys.length) { stats.windowSkipped++; continue; }
            const bb = { u0: Math.min(...polys.flat().map(q => q.x)), u1: Math.max(...polys.flat().map(q => q.x)), v0: Math.min(...polys.flat().map(q => q.y)), v1: Math.max(...polys.flat().map(q => q.y)) };
            // overlapping another opening on this wall: not built (it would tear the wall)
            if (pick.holes.some(hb => hb.u0 < bb.u1 && bb.u0 < hb.u1 && hb.v0 < bb.v1 && bb.v0 < hb.v1)) { stats.windowSkipped++; continue; }
            pick.holes.push({ id: pl.id, ...bb });
            const nicheDepth = shape.kind === 'niche' ? nicheDepthFn(shape, bb, Math.min(shape.depth ?? 0.2, plan.wallThickness * 0.85)) : undefined;
            for (const poly0 of polys) {
              // niches: enough points along every edge for the recess to follow the side / bottom profiles
              const poly = nicheDepth ? densify(poly0, (bb.u1 - bb.u0 + bb.v1 - bb.v0) / 30) : poly0;
              holes.push({ poly: signedArea(poly) > 0 ? [...poly].reverse() : poly, depth: nicheDepth });
            }
            if (shape.kind === 'opening') {
              stats.windowCount++;
              stats.windowArea += polys.reduce((sum, q) => sum + Math.abs(signedArea(q)), 0) * lenM * wallH;
            }
            // frames / surrounds / niche decorations (imported designs, detailed view)
            const uc = (bb.u0 + bb.u1) / 2, vc = (bb.v0 + bb.v1) / 2;
            const fr = wall.frame(uc, vc);
            const ww = (bb.u1 - bb.u0) * lenM, hh = (bb.v1 - bb.v0) * wallH;
            const sm = sel.elements.has(pl.id) ? mats.selected : pl.color ? mats.color(pl.color) : null;
            const ppick: PickInfo = { floorId: floor.id, floorIndex: i, segId: seg.id, placementId: pl.id };
            // a design: its shape plane lands on the outside face, over the shape's whole box
            const use = shape.kind === 'opening' ? openingUse(shape) : null;
            let made: boolean | 'glass' = false;
            if (pl.designId) {
              const fd = wall.frame(clamp01(sc / lenM), clamp01((yLow + shape.h / 2) / wallH));
              passDesign = use === 'door'; // walk through doors
              made = designAt(pl.designId, fd.face, fd.along, fd.up, fd.out, shape.w, shape.h, REF_WALL, sm, ppick);
              passDesign = false;
            }
            // what fills it: glass in windows (unless the design brings its own), a plain door without a design, nothing in arches
            if ((use === 'window' && made !== 'glass') || (use === 'door' && !made)) {
              const fill = use === 'window' ? (sel.elements.has(pl.id) ? mats.selected : GLASS) : sm ?? DOOR;
              for (const poly of polys) {
                const tris = THREE.ShapeUtils.triangulateShape(poly.map(q => new THREE.Vector2(q.x * lenM, q.y * wallH)), []);
                const pos: number[] = [];
                for (const t of tris) for (const k2 of t) { const v = wall.at(poly[k2].x, poly[k2].y, use === 'door' ? 0.3 : 0); pos.push(v.x, v.y, v.z); }
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                geo.computeVertexNormals();
                const m = add(geo, fill, ppick, undefined, false);
                if (use === 'door') m.userData.passThrough = true;
              }
            }
            if (shape.kind === 'opening') { // imported frames / surrounds (older projects)
              designAt(pl.frameId, fr.mid, fr.along, fr.up, fr.out, ww, hh, plan.wallThickness * 0.9, sm, ppick);
              designAt(pl.surroundId, fr.face.clone().addScaledVector(fr.out, 0.04), fr.along, fr.up, fr.out, ww * 1.3, hh * 1.15, 0.08, sm, ppick);
            }
            if (sel.elements.has(pl.id)) for (const poly of polys) line([...poly, poly[0]].map(q => wall.at(q.x, q.y, 1.06)), mats.selLine);
            // invisible surface across the opening, so clicking it picks this element
            for (const poly of polys) {
              const tris = THREE.ShapeUtils.triangulateShape(poly.map(q => new THREE.Vector2(q.x * lenM, q.y * wallH)), []);
              const pos: number[] = [];
              for (const t of tris) for (const k2 of t) { const v = wall.at(poly[k2].x, poly[k2].y, shape.kind === 'niche' ? 0.6 : 0); pos.push(v.x, v.y, v.z); }
              const geo = new THREE.BufferGeometry();
              geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
              add(geo, HIDDEN, ppick, undefined, false);
            }
          }
          const geo = wall.build(holes);
          pick.uvOf = q => wall.uvOf(q);
          add(geo, selected ? mats.selected : segMat(seg, material), pick, { cat: interior ? 'int' : 'ext', material });
          // division lines + selected division / border outlines
          for (let k = 0; k < borders.length; k++) {
            if (k > 0 && k < borders.length - 1) for (const side of [1, -1] as const) line(wall.vline(borders[k], side), mats.edge);
            if (k < borders.length - 1 && sel.divisions.has(`${wallKey}|${k}`)) for (const side of [1.03, -1.03]) line(wall.rect(borders[k], borders[k + 1], side), mats.selLine);
            if (sel.borders.has(`${wallKey}|${k}`)) for (const side of [1.08, -1.08]) line(wall.vline(borders[k], side), mats.selLine);
          }
          // a wall / roof design on every division (centred in the thickness); cut off along the division's sides, so on
          // a sloping or tapering division (a hip roof's triangle) it stops at the edges instead of sticking out
          // the openings / niches in this wall, as outlines in a division's own frame (the design is cut out there)
          const cutoutsFor = (u0: number, u1: number, U: THREE.Vector3, V: THREE.Vector3): Cutouts | undefined => {
            const O = wall.at(u0, 0, 0), polys: V2[][] = [];
            for (const hl of holes) {
              const us = hl.poly.map(q => q.x);
              if (Math.max(...us) < u0 || Math.min(...us) > u1) continue;
              polys.push(hl.poly.map(q => { const P = wall.at(q.x, q.y, 0).sub(O); return { x: P.dot(U), y: P.dot(V) }; }));
            }
            return polys.length ? { O, U: U.clone(), V: V.clone(), polys } : undefined;
          };
          if (seg.wallDesign && o.detailed) for (let k = 0; k + 1 < borders.length; k++) {
            const u0 = borders[k], u1 = borders[k + 1], uc = (u0 + u1) / 2, fd = wall.frame(uc, 0.5);
            const wb = wall.at(u0, 0, 0).distanceTo(wall.at(u1, 0, 0)), wt = wall.at(u0, 1, 0).distanceTo(wall.at(u1, 1, 0));
            const hS = wall.at(uc, 0, 0).distanceTo(wall.at(uc, 1, 0)); // up the face (a roof: up the slope)
            const side = (u: number) => {
              const a = wall.at(u, 0, 0), dir = wall.at(u, 1, 0).sub(a);
              if (dir.lengthSq() < 1e-12) return null;
              const n = new THREE.Vector3().crossVectors(dir, fd.out).normalize();
              if (n.dot(fd.mid.clone().sub(a)) < 0) n.negate();
              return new THREE.Plane().setFromNormalAndCoplanarPoint(n, a);
            };
            const clip = [side(u0), side(u1)].filter((x): x is THREE.Plane => !!x);
            // a square frame (a twisted division, e.g. a hip, would otherwise shear the design)
            const out = new THREE.Vector3().crossVectors(fd.along, fd.up).normalize();
            if (out.dot(fd.out) < 0) out.negate();
            const src = mats.design?.(seg.wallDesign);
            if (src?.userData.tile) {
              // a pattern: copies at its own size, courses level (up = straight up the face), lined up from the wall's start
              // so neighbouring divisions continue it; cut to this division (its sides, bottom and top)
              const R = src.userData.size as THREE.Vector3;
              const up = new THREE.Vector3(0, 1, 0).addScaledVector(out, -out.y);
              if (up.lengthSq() < 1e-6) up.copy(fd.up); else up.normalize();
              const along = new THREE.Vector3().crossVectors(up, out).normalize();
              const edge = (v: number) => { // the bottom / top of the division
                const a = wall.at(u0, v, 0), dir = wall.at(u1, v, 0).sub(a);
                if (dir.lengthSq() < 1e-12) return null;
                const n = new THREE.Vector3().crossVectors(out, dir).normalize();
                if (n.dot(fd.mid.clone().sub(a)) < 0) n.negate();
                return new THREE.Plane().setFromNormalAndCoplanarPoint(n, a);
              };
              const cut = [...clip, edge(0), edge(1)].filter((x): x is THREE.Plane => !!x);
              const A = wall.at(0, 0, 0); // pattern origin
              const corners = [wall.at(u0, 0, 0), wall.at(u1, 0, 0), wall.at(u0, 1, 0), wall.at(u1, 1, 0), wall.at(uc, 0, 0), wall.at(uc, 1, 0)];
              const pa = corners.map(c => c.clone().sub(A).dot(along)), pb = corners.map(c => c.clone().sub(A).dot(up));
              const i0 = Math.floor(Math.min(...pa) / R.x) - 1, i1 = Math.ceil(Math.max(...pa) / R.x);
              const j0 = Math.floor(Math.min(...pb) / R.y) - 1, j1 = Math.ceil(Math.max(...pb) / R.y);
              const base = A.clone().addScaledVector(out, fd.mid.clone().sub(A).dot(out)); // in the plane of this division's middle
              const cuts = cutoutsFor(u0, u1, along, up);
              for (let ii = i0; ii < i1 && ii - i0 < 40; ii++) for (let jj = j0; jj < j1 && jj - j0 < 40; jj++) {
                const c = base.clone().addScaledVector(along, (ii + 0.5) * R.x).addScaledVector(up, (jj + 0.5) * R.y);
                designAt(seg.wallDesign, c, along, up, out, R.x, R.y, thick, selected ? mats.selected : null, pick, false, cut, cuts);
              }
              continue;
            }
            const along = new THREE.Vector3().crossVectors(fd.up, out).normalize();
            designAt(seg.wallDesign, fd.mid, along, fd.up, out, Math.max(wb, wt), Math.max(hS, 0.01), thick, selected ? mats.selected : null, pick, false, clip, cutoutsFor(u0, u1, along, fd.up));
          }
          // (cornices under a roof's eaves sit lower, clear of them)
          const under = roofInfo[i + 1];
          if (!interior && !isRoof) decorate(wall, seg, plan, borders, lenM, wallH, i, floor, placements.filter(pl => pl.segId === seg.id), yBase, yTop,
            yTop + (i + 1 < N ? slabs[i + 1].floor : 0) - (under ? (CORNICE[1][0] + 0.02) * under.slope : 0));
        } else {
          // colonnade: columns on the division borders (+ free-standing ends)
          // columns: on the division borders, unless they have been moved / added / removed by hand
          columnPositions(plan, seg, borders, lenM, segColT(plan, seg)).forEach((u, k) => {
            const id = `col:${seg.id}:${k}`;
            colAlong(rows, u, segColT(plan, seg), bottom, { ...pick, placementId: id }, seg, material, selected || sel.elements.has(id));
          });
          rowsBySeg.set(seg.id, { rows, bottom });
        }
      }

      // filled rooms (floor plans): solid from the floor to the ceiling, inside the wall faces (no overlap with the walls)
      if (interior && plan.filled?.length) {
        const rooms = roomFaces(p, plan).filter(f => f.filled);
        if (rooms.length) {
          const ring = (a: V2[]) => a.map(q => [q.x, q.y] as [number, number]);
          const bands: V2[][] = [...extBands];
          for (const sg of plan.segments) {
            if (segKind(sg) === 'open') continue;
            const bt = sampleSeg(plan, sg), hw = plan.wallThickness / 2 / L;
            for (let k = 0; k + 1 < bt.length; k++) {
              const a = bt[k], c = bt[k + 1], d = norm({ x: c.x - a.x, y: c.y - a.y }), n = { x: -d.y * hw, y: d.x * hw };
              const a2 = { x: a.x - d.x * hw, y: a.y - d.y * hw }, c2 = { x: c.x + d.x * hw, y: c.y + d.y * hw };
              bands.push([{ x: a2.x + n.x, y: a2.y + n.y }, { x: c2.x + n.x, y: c2.y + n.y }, { x: c2.x - n.x, y: c2.y - n.y }, { x: a2.x - n.x, y: a2.y - n.y }]);
            }
          }
          for (const room of rooms) {
            let mp: MultiPolygon = [];
            try { mp = bands.length ? polygonClipping.difference([ring(room.poly)], ...bands.map(bd => [ring(bd)])) : [[ring(room.poly)]]; } catch { mp = [[ring(room.poly)]]; }
            for (const poly of mp) {
              const toV = (r: [number, number][]) => r.slice(0, -1).map(([x, y]) => { const w = W({ x, y }, 0); return new THREE.Vector2(w.x, -w.z); });
              const shape = new THREE.Shape(toV(poly[0]));
              for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(toV(hole)));
              const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 });
              geo.rotateX(-Math.PI / 2);
              geo.translate(0, y0, 0);
              add(geo, o.detailed ? mats.look(plan.material) : mats.wall('structural'), { floorId: floor.id, floorIndex: i, interior: true }, { cat: 'int', material: plan.material });
            }
          }
        }
      }

      // (single unconnected points build nothing: they only serve as targets for the floor below)

      // stairs climb to the next main floor (subfloors are part of the same floor)
      // stairs set to reach the next floor climb to the next main floor (past intermediate ones), whatever is there
      const nm = nextMainFloor(p, i);
      const yStairs = nm < N ? elevation(p, nm) + slabs[nm].floor : y1;
      if (interior) for (const ob of plan.objects) {
        const opick: PickInfo = { floorId: floor.id, floorIndex: i, interior: true };
        // a stairs design (Design tab) on every step, in the detailed view
        const step: StepDesign | undefined = ob.designId && o.detailed ? (c, along, up, out, w, hh, d) => designAt(ob.designId, c, along, up, out, w, hh, d, null, opick) !== false : undefined;
        buildObject(ob, p, y0, y1, yStairs, (nm < N ? elevation(p, nm) : yTop) - yBase, mats.object, (geo: THREE.BufferGeometry) => add(geo, mats.object, opick), step);
      }
    }
  }

  // ---------- columns and pilasters: stacked pieces join into one (one base, one top) ----------
  const joined = <T>(list: T[], key: (x: T) => string, lo: (x: T) => number, hi: (x: T) => number, gap: number, apart?: (a: T, b: T) => boolean) => {
    const groups = new Map<string, T[]>();
    for (const x of list) { const k = key(x); (groups.get(k) ?? groups.set(k, []).get(k)!).push(x); }
    const runs: T[][] = [];
    for (const g2 of groups.values()) {
      g2.sort((x, y) => lo(x) - lo(y));
      let cur: T[] = [];
      for (const x of g2) {
        if (cur.length && (lo(x) - hi(cur[cur.length - 1]) > gap || apart?.(cur[cur.length - 1], x))) { runs.push(cur); cur = []; }
        cur.push(x);
      }
      if (cur.length) runs.push(cur);
    }
    return runs;
  };
  const r2 = (v: number) => Math.round(v * 50) / 50; // 2 cm grid
  for (const run of joined(colPieces, x => `${r2(x.a.x)},${r2(x.a.z)},${r2(x.ct)},${x.seg.columnDesign ?? ''}`, x => x.a.y, x => x.c.y, 0.01)) { // only when nothing (no floor / ceiling) separates them
    const first = run[0], last = run[run.length - 1];
    const a = first.a.clone(), c = new THREE.Vector3(a.x, last.c.y, a.z);
    const selected = run.some(x => x.selected), seg = first.seg;
    const dir = norm({ x: first.bottom[first.bottom.length - 1].x - first.bottom[0].x, y: first.bottom[first.bottom.length - 1].y - first.bottom[0].y });
    const along = new THREE.Vector3(dir.x, 0, -dir.y), up = new THREE.Vector3(0, 1, 0);
    const mid = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
    const out = new THREE.Vector3().crossVectors(along, up).normalize();
    if (designAt(seg.columnDesign, mid, along, up, out, first.ct, c.y - a.y, first.ct, selected ? mats.selected : seg.color ? mats.color(seg.color) : null, first.pick, true)) continue;
    add(column(a, c, first.ct, first.bottom), selected ? mats.selected : segMat(seg, first.material, true), first.pick, { cat: 'col', material: first.material });
  }
  for (const run of joined(pilPieces, x => `${r2(x.base.x)},${r2(x.base.z)},${r2(x.out.x)},${r2(x.out.z)},${x.pl.designId ?? ''}`, x => x.y0, x => x.y1, 0.05,
    // a floor or ceiling between the two storeys keeps them as separate pilasters (one per storey), unless they run through (giant order)
    (a, b) => slabs[b.floor].floor > 0 && !(a.pl.giant && b.pl.giant))) {
    const f0 = run[0], y0 = f0.y0, y1 = run[run.length - 1].y1, H = y1 - y0;
    const { pw, pd, out } = f0;
    const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3().crossVectors(up, out);
    const selected = run.some(x => sel.elements.has(x.pl.id));
    const mat = selected ? mats.selected : f0.mat;
    const box = (w: number, h: number, d: number, yMid: number) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(side, up, out));
      const c = f0.base.clone().addScaledVector(out, d / 2);
      geo.translate(c.x, y0 + yMid, c.z);
      add(geo, mat, f0.pick);
    };
    const shaftC = f0.base.clone().addScaledVector(out, pd / 2); shaftC.y = y0 + H / 2;
    if (designAt(f0.pl.designId, shaftC, f0.along, up, out, pw, H, pd, f0.pl.color || selected ? mat : null, f0.pick, true)) continue;
    const psh = f0.pl.shapeId ? p.pilasterShapes.find(x => x.id === f0.pl.shapeId) : undefined;
    if (psh && psh.front.length && psh.side.length) { add(pilasterGeometry(psh, f0.base, side.clone().normalize(), out, y0, H, pw), mat, f0.pick); continue; }
    box(pw, H, pd, H / 2);
    box(pw + 0.14, 0.3, pd + 0.08, 0.15); // one base at the bottom
    box(pw + 0.14, 0.24, pd + 0.08, H - 0.12); // one capital at the top
  }

  // free-standing imported 3D models (detailed view only)
  for (const pl of p.placements) {
    if (pl.type !== 'model' || !o.detailed || !mats.design) continue;
    const src = mats.design(pl.designId);
    const fl = p.floors.findIndex(f => f.id === pl.floorId);
    if (!src || fl < 0 || hidden(fl)) continue;
    const size = (src.userData.size as THREE.Vector3) ?? new THREE.Vector3(1, 1, 1);
    const k = (pl.scale ?? 1) / Math.max(size.x, size.y, size.z, 1e-9);
    const pos = pl.pos ?? { x: 0, y: 0, z: 0 };
    const c = new THREE.Vector3(p.x + pos.x, pos.y + (size.y * k) / 2, -(p.y + pos.z));
    const r = ((pl.rot ?? 0) * Math.PI) / 180;
    const along = new THREE.Vector3(Math.cos(r), 0, -Math.sin(r)), up = new THREE.Vector3(0, 1, 0);
    designAt(pl.designId, c, along, up, new THREE.Vector3().crossVectors(along, up), size.x * k, size.y * k, size.z * k,
      sel.elements.has(pl.id) ? mats.selected : pl.color ? mats.color(pl.color) : null, { floorId: pl.floorId, floorIndex: fl, placementId: pl.id });
  }
  return { group: g, stats };

  /** Cornices, pilasters and balconies on a wall. */
  function decorate(wall: WallSolid, seg: PlanSegment, plan: StructurePlan, borders: number[], lenM: number, wallH: number, i: number, floor: Floor, list: Placement[], fy0: number, fy1: number, cy: number) {
    void wallH;
    const t = plan.wallThickness;
    // pilasters stop under a cornice on this wall (or on a wall meeting it at a corner)
    const near = new Set([seg.id, ...plan.segments.filter(o => o.a === seg.a || o.b === seg.a || o.a === seg.b || o.b === seg.b).map(o => o.id)]);
    const hasCornice = p.placements.some(x => x.type === 'cornice' && x.floorId === floor.id && near.has(x.segId ?? ''));
    const underCornice = (y: number) => (hasCornice ? Math.min(y, cy - CORNICE_H) : y);
    /** A pilaster at the end of the wall that meets this one at its start (the other face of the corner)? */
    const cornerMate = (sg: PlanSegment, floorId: string) => {
      const other = plan.segments.find(o => o.id !== sg.id && o.b === sg.a && segKind(o) === 'wall');
      if (!other) return false;
      const nb = divisionBorders(polyLength(sampleSeg(plan, other)) * L, segDivLen(p, other)).length - 1;
      return p.placements.some(x => x.type === 'pilaster' && x.floorId === floorId && x.segId === other.id && (x.div ?? 0) === nb);
    };
    for (const pl of list) {
      const pick: PickInfo = { floorId: floor.id, floorIndex: i, segId: seg.id, placementId: pl.id };
      const k = Math.min(Math.max(0, pl.div ?? 0), borders.length - (pl.type === 'pilaster' ? 1 : 2));
      if (pl.type === 'cornice') {
        // runs along the top of the division, hanging from the top of the floor
        const u0 = borders[k], u1 = borders[k + 1];
        const fr = wall.frame((u0 + u1) / 2, 1);
        const mat = placeMat(pl, mats.deco);
        // at a corner, run past it (by the cornice's projection) only where the next wall has a cornice too, so they meet
        // at a corner where the next wall has a cornice too, the two meet in a mitre (no overlap)
        const otherAt = (pointId: string) => plan.segments.find(o => o.id !== seg.id && (o.a === pointId || o.b === pointId) && segKind(o) !== 'open' &&
          p.placements.some(x => x.type === 'cornice' && x.floorId === floor.id && x.segId === o.id));
        const mitre = (pointId: string, end: 0 | 1) => {
          const o = otherAt(pointId);
          if (!o) return 0;
          const sp = sampleSeg(plan, o);
          if (o.a !== pointId) sp.reverse();
          const dB = norm({ x: sp[1].x - sp[0].x, y: sp[1].y - sp[0].y }); // into the other wall (plan)
          const f = wall.frame(end, 1);
          const into = end === 0 ? { x: f.along.x, y: -f.along.z } : { x: -f.along.x, y: f.along.z }; // into this wall (plan)
          const nOut = norm({ x: f.out.x, y: -f.out.z });
          const cos = Math.max(-1, Math.min(1, into.x * dB.x + into.y * dB.y)), phi = Math.acos(cos);
          if (phi < 0.2 || phi > Math.PI - 0.02) return 0;
          const k = 1 / Math.tan(phi / 2);
          return Math.max(-3, Math.min(3, dB.x * nOut.x + dB.y * nOut.y > 0 ? -k : k)); // inside corner: cut back
        };
        const reach = (wall.shift ? 0 : t / 2) / lenM;
        const ua = k === 0 ? u0 - reach : u0, ub = k === borders.length - 2 ? u1 + reach : u1;
        const m0 = k === 0 ? mitre(seg.a, 0) : 0, m1 = k === borders.length - 2 ? mitre(seg.b, 1) : 0;
        const fr2 = { ...fr, face: fr.face.clone().setY(cy) }; // the cornice crowns the storey, the slab above included
        if (designAt(pl.designId, fr2.face.clone().addScaledVector(fr.out, CORNICE[1][0] / 2).addScaledVector(fr.up, -0.16), fr.along, fr.up, fr.out, (ub - ua) * lenM, 0.32, 0.34, pl.color ? mat : sel.elements.has(pl.id) ? mats.selected : null, pick)) continue;
        add(sweepProfile(wall, ua, ub, CORNICE, cy, m0, m1), mat, pick);
      } else if (pl.type === 'pilaster') {
        const psh = pl.shapeId ? p.pilasterShapes.find(x => x.id === pl.shapeId) : undefined;
        let pw = psh?.w ?? 0.5;
        const pd = psh?.d ?? 0.12;
        let s0 = borders[k] * lenM + pl.dx;
        const corner = wall.shift ? 0 : t / 2; // where the outer corner is, relative to the wall's ends
        if (k === 0) s0 = -corner + pw / 2 + pl.dx; // flush with the outer corner
        // a pilaster on the other face of this corner too: this one runs on across the corner, so the two make an L
        if (k === 0 && cornerMate(seg, floor.id)) { pw += pd; s0 -= pd / 2; }
        if (k === borders.length - 1) s0 = lenM + corner - pw / 2 + pl.dx;
        const u = s0 / lenM;
        const fr = wall.frame(Math.min(1, Math.max(0, u)), 0.5);
        const base = fr.face.clone().addScaledVector(fr.along, (u - Math.min(1, Math.max(0, u))) * lenM);
        const mat = placeMat(pl, mats.deco);
        const box = (w: number, h: number, d: number, yMid: number) => {
          const geo = new THREE.BoxGeometry(w, h, d);
          const up = new THREE.Vector3(0, 1, 0), flat = new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize();
          const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, flat), up, flat);
          geo.applyMatrix4(m);
          const c = base.clone().addScaledVector(fr.out, d / 2);
          geo.translate(c.x, wall.y0 + yMid, c.z);
          add(geo, mat, pick);
        };
        void box;
        pilPieces.push({ base, out: new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize(), along: fr.along.clone(), y0: fy0, y1: underCornice(fy1), pw, pd, pl, mat, pick, floor: i }); // outside the face: the full storey, slab edge included
      } else if (pl.type === 'balcony') {
        const shape = p.balconyShapes.find(x => x.id === pl.shapeId) ?? p.balconyShapes[0];
        if (!shape) continue;
        const uc = (borders[k] + borders[k + 1]) / 2 + pl.dx / lenM;
        const fr = wall.frame(Math.min(1, Math.max(0, uc)), 0);
        // platform top: lower than the middle of the division
        const yTopB = fy0 + (fy1 - fy0) * BALCONY_HEIGHT + pl.dy;
        const mat = placeMat(pl, mats.deco);
        const flat = new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize();
        const along = new THREE.Vector3(fr.along.x, 0, fr.along.z).normalize();
        const origin = new THREE.Vector3(fr.face.x, yTopB, fr.face.z);
        const P = (q: V2) => origin.clone().addScaledVector(along, (q.x - 0.5) * shape.w).addScaledVector(flat, q.y * shape.d);
        const outline = smoothClosed(shape.outline, shape.smooth, 10);
        const c = origin.clone().addScaledVector(flat, shape.d / 2); c.y -= shape.thickness / 2;
        if (!designAt(pl.designId, c, along, new THREE.Vector3(0, 1, 0), flat, shape.w, shape.thickness, shape.d, pl.color ? mat : sel.elements.has(pl.id) ? mats.selected : null, pick)) {
          // local (x along, y out, z down) -> world, kept a proper rotation (mirror x if needed)
          const sg = new THREE.Vector3().crossVectors(along, flat).y < 0 ? 1 : -1;
          const sh = new THREE.Shape(outline.map(q => new THREE.Vector2(sg * (q.x - 0.5) * shape.w, q.y * shape.d)));
          const geo = new THREE.ExtrudeGeometry(sh, { depth: shape.thickness, bevelEnabled: false, curveSegments: 1 });
          const m = new THREE.Matrix4().makeBasis(along.clone().multiplyScalar(sg), flat, new THREE.Vector3(0, -1, 0));
          geo.applyMatrix4(m);
          geo.translate(origin.x, origin.y, origin.z);
          add(geo, mat, pick);
        }
        if (shape.railing) {
          // balusters along the edges away from the wall
          const runs: THREE.Vector3[][] = [];
          let cur: THREE.Vector3[] = [];
          for (let j = 0; j <= outline.length; j++) {
            const q = outline[j % outline.length], prev = outline[(j - 1 + outline.length) % outline.length];
            const onWall = q.y < 0.02 && prev.y < 0.02;
            if (j > 0 && !onWall) { if (!cur.length) cur.push(P(prev)); cur.push(P(q)); } else if (cur.length) { runs.push(cur); cur = []; }
          }
          if (cur.length) runs.push(cur);
          const inset = (v: THREE.Vector3) => v; // railing sits on the platform edge
          for (const r of runs) balusters(r.map(inset), seg.balusterDesign, placeMat(pl, mats.deco), pick);
        }
      }
    }
  }

  /** A simple 1 m railing along a polyline: bottom rail, top rail and turned balusters. */
  function balusters(path: THREE.Vector3[], designId: string | null | undefined, mat: THREE.Material, pick: PickInfo) {
    // a railing design (Design tab): 1 m sections of railing, stretched to fit each run evenly
    const section = o.detailed && designId && mats.design?.(designId)?.userData.decoType === 'baluster';
    for (let j = 0; j + 1 < path.length; j++) {
      const a = path[j], c = path[j + 1];
      const len = a.distanceTo(c);
      if (len < 1e-3) continue;
      const along = new THREE.Vector3().subVectors(c, a).normalize();
      const up = new THREE.Vector3(0, 1, 0), out = new THREE.Vector3().crossVectors(along, up).normalize();
      if (section) {
        const n = Math.max(1, Math.round(len));
        for (let q = 0; q < n; q++) {
          const m = a.clone().lerp(c, (q + 0.5) / n); m.y = a.y + 0.5;
          designAt(designId, m, along, up, out, len / n, 1, 0.2, null, pick);
        }
        continue;
      }
      const rail = (h: number, w: number, y: number) => {
        const geo = new THREE.BoxGeometry(len, h, w);
        geo.applyMatrix4(new THREE.Matrix4().makeBasis(along, up, out));
        const m = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
        geo.translate(m.x, a.y + y, m.z);
        add(geo, mat, pick, undefined, false);
      };
      rail(0.12, 0.2, 0.06); // plinth
      rail(0.08, 0.18, 0.96); // handrail
      const n = Math.max(1, Math.round(len / 0.2));
      for (let q = 0; q < n; q++) {
        const pnt = a.clone().lerp(c, (q + 0.5) / n);
        const center = new THREE.Vector3(pnt.x, a.y + 0.12 + 0.4, pnt.z);
        if (designAt(designId, center, along, up, out, 0.13, 0.8, 0.13, null, pick)) continue;
        const geo = new THREE.LatheGeometry(BALUSTER, 8);
        geo.translate(pnt.x, a.y + 0.12, pnt.z);
        add(geo, mat, pick, undefined, false);
      }
    }
  }
}

/** Plain cornice profile (metres): x = out from the wall face, y = down from the top. */
const CORNICE_H = 0.32;
export const CORNICE: [number, number][] = [[0, 0], [0.34, 0], [0.34, 0.06], [0.26, 0.1], [0.2, 0.16], [0.1, 0.2], [0.1, 0.27], [0, 0.32]];
/** Platform top of a balcony as a fraction of the floor height (lower than the middle). */
export const BALCONY_HEIGHT = BALCONY_AT;
/** Baluster silhouette (radius, height) turned on a lathe. */
export const BALUSTER = [[0, 0], [0.055, 0], [0.055, 0.05], [0.035, 0.1], [0.06, 0.32], [0.065, 0.4], [0.03, 0.55], [0.025, 0.7], [0.045, 0.75], [0.045, 0.8], [0, 0.8]].map(([x, y]) => new THREE.Vector2(x, y));

/**
 * Columns of a colonnade line, as metres from its start: the ones placed by hand, or automatically
 * one on every inner division border plus a corner column at each free end (a corner with no wall),
 * which belongs to the first colonnade line meeting there.
 */
export function autoColumns(plan: StructurePlan, seg: PlanSegment, borders: number[], lenM: number, ct: number): number[] {
  const owns = (id: string) => {
    const segs = plan.segments.filter(x => x.a === id || x.b === id);
    if (segs.some(x => segKind(x) === 'wall')) return false;
    return segs.find(x => segKind(x) === 'colonnade') === seg;
  };
  const list = borders.slice(1, -1).map(u => u * lenM);
  if (owns(seg.a)) list.unshift(ct / 2);
  if (owns(seg.b)) list.push(lenM - ct / 2);
  return list;
}
/** Where a column's centre may be (m from the line's start): the whole column stays on its line. */
export function columnRange(_plan: StructurePlan, _seg: PlanSegment, lenM: number, ct: number): [number, number] {
  return ct <= lenM ? [ct / 2, lenM - ct / 2] : [lenM / 2, lenM / 2];
}
/** Column positions as u (0..1), kept on the line. Sideways they stand inside it, so a column at an end fills the corner. */
export function columnPositions(plan: StructurePlan, seg: PlanSegment, borders: number[], lenM: number, ct: number): number[] {
  const [lo, hi] = columnRange(plan, seg, lenM, ct);
  const list = seg.columns ?? autoColumns(plan, seg, borders, lenM, ct);
  return list.map(m => (lenM ? Math.min(hi, Math.max(lo, m)) / lenM : 0));
}

/** +1: the wall runs counter-clockwise around an enclosed area (inside on its left), −1: clockwise, 0: not around one. */
function faceSide(plan: StructurePlan, seg: PlanSegment): number {
  for (const f of enclosedFacesSegs(plan)) {
    const k = f.segIds.indexOf(seg.id);
    if (k >= 0) return f.ids[k] === seg.a ? 1 : -1;
  }
  return 0;
}

/** Is the outside of the building on the wall's right (−1 side)? True when the wall runs counter-clockwise around an enclosed area. */
function outsideIsMinus(plan: StructurePlan, seg: PlanSegment): boolean {
  for (const f of enclosedFacesSegs(plan)) {
    const k = f.segIds.indexOf(seg.id);
    if (k < 0) continue;
    return f.ids[k] === seg.a; // traversed a -> b counter-clockwise: the area (inside) is on the left
  }
  return true;
}

/** Insert points so no edge of the closed polygon is longer than step. */
function densify(poly: V2[], step: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Sutherland–Hodgman clip of a polygon to the square [lo, hi]². */
function clipRect(poly: V2[], lo: number, hi: number): V2[] {
  const clip = (pts: V2[], inside: (p: V2) => boolean, cut: (a: V2, b: V2) => V2) => {
    const out: V2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
    }
    return out;
  };
  const atX = (x: number) => (a: V2, b: V2) => ({ x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) });
  const atY = (y: number) => (a: V2, b: V2) => ({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y });
  let r = poly;
  r = clip(r, p => p.x >= lo, atX(lo)); if (!r.length) return r;
  r = clip(r, p => p.x <= hi, atX(hi)); if (!r.length) return r;
  r = clip(r, p => p.y >= lo, atY(lo)); if (!r.length) return r;
  return clip(r, p => p.y <= hi, atY(hi));
}

/** Niche recess depth (m) at wall u/v: depth × min(side profile at height, bottom profile at width). */
function nicheDepthFn(shape: OpeningShape, bb: { u0: number; u1: number; v0: number; v1: number }, depth: number) {
  const prof = (pts: WinPoint[] | undefined, along: 'x' | 'y') => {
    if (!pts || pts.length < 2) return () => 1;
    const poly = smoothOpen(pts, shape.smooth).sort((a, b) => (along === 'x' ? a.x - b.x : a.y - b.y));
    return (t: number) => {
      // value (the other axis) at position t along `along`
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const ta = along === 'x' ? a.x : a.y, tb = along === 'x' ? b.x : b.y;
        if (t <= tb || i === poly.length - 1) {
          const k = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
          const va = along === 'x' ? a.y : a.x, vb = along === 'x' ? b.y : b.x;
          return va + (vb - va) * k;
        }
      }
      return 1;
    };
  };
  const side = prof(shape.side, 'y'), bottom = prof(shape.bottom, 'x');
  return (u: number, v: number) => {
    const x = (u - bb.u0) / Math.max(1e-9, bb.u1 - bb.u0), y = (v - bb.v0) / Math.max(1e-9, bb.v1 - bb.v0);
    return depth * Math.max(0, Math.min(side(y), bottom(x)));
  };
}

/** Smoothed open polyline through the points (ends fixed). */
function smoothOpen(pts: WinPoint[], def: number, steps = 10): V2[] {
  const n = pts.length, out: V2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const A = pts[i], B = pts[i + 1], P = pts[Math.max(0, i - 1)], Q = pts[Math.min(n - 1, i + 2)];
    const sa = i === 0 ? 0 : A.s ?? def, sb = i + 1 === n - 1 ? 0 : B.s ?? def;
    const ma = { x: ((B.x - P.x) / 2) * sa, y: ((B.y - P.y) / 2) * sa }, mb = { x: ((Q.x - A.x) / 2) * sb, y: ((Q.y - A.y) / 2) * sb };
    const k = sa > 0 || sb > 0 ? steps : 1;
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push({ x: h00 * A.x + h10 * ma.x + h01 * B.x + h11 * mb.x, y: h00 * A.y + h10 * ma.y + h01 * B.y + h11 * mb.y });
    }
  }
  out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}
export { smoothOpen };

/** Sweep a profile (out, down in m) along the top outside edge of a wall between u0 and u1. */
/** A profile (x out from the face, y down from yTop) swept along the wall; m0 / m1: mitre at the ends (extension per metre of projection). */
function sweepProfile(wall: WallSolid, u0: number, u1: number, prof: [number, number][], yTop: number, m0 = 0, m1 = 0): THREE.BufferGeometry {
  const n = Math.max(2, Math.ceil((u1 - u0) * 40) + 1);
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j < n; j++) {
    const u = u0 + ((u1 - u0) * j) / (n - 1);
    const fr = wall.frame(Math.min(1, Math.max(0, u)), 1);
    const base = wall.at(Math.min(1, Math.max(0, u)), 1, 1).addScaledVector(fr.along, (u - Math.min(1, Math.max(0, u))) * wall.lenM);
    const flat = new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize();
    base.y = yTop;
    const ext = j === 0 ? -m0 : j === n - 1 ? m1 : 0;
    const al = new THREE.Vector3(fr.along.x, 0, fr.along.z).normalize();
    rings.push(prof.map(([x, y]) => base.clone().addScaledVector(flat, x).addScaledVector(al, x * ext).add(new THREE.Vector3(0, -y, 0))));
  }
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const m = prof.length;
  for (let j = 0; j + 1 < n; j++) for (let k = 0; k < m; k++) {
    const a = rings[j][k], b = rings[j][(k + 1) % m], c = rings[j + 1][(k + 1) % m], d = rings[j + 1][k];
    tri(a, b, c); tri(a, c, d);
  }
  const cap = THREE.ShapeUtils.triangulateShape(prof.map(([x, y]) => new THREE.Vector2(x, y)), []);
  for (const [a, b, c] of cap) { tri(rings[0][a], rings[0][c], rings[0][b]); tri(rings[n - 1][a], rings[n - 1][b], rings[n - 1][c]); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

type Hole = { poly: V2[]; depth?: (u: number, v: number) => number };
/** Not drawn, but still hit by clicks. */
/** Outlines (in a frame O + x·U + y·V) where a design is not drawn: the openings of the wall it covers. */
const cutMatCache = new WeakMap<object, Map<THREE.Material, THREE.Material>>();
type Cutouts = { O: THREE.Vector3; U: THREE.Vector3; V: THREE.Vector3; polys: V2[][] };
const MAX_CUT_PTS = 256, MAX_CUTS = 12;
/** Makes a material skip whatever lies over the cut-out outlines (tested per pixel, so arches stay round). */
function withCutouts(m: THREE.Material, c: Cutouts) {
  const polys = c.polys.slice(0, MAX_CUTS), pts: THREE.Vector2[] = [], start: number[] = [];
  for (const poly of polys) { start.push(pts.length); for (const q of poly) if (pts.length < MAX_CUT_PTS) pts.push(new THREE.Vector2(q.x, q.y)); }
  start.push(pts.length);
  while (pts.length < MAX_CUT_PTS) pts.push(new THREE.Vector2());
  while (start.length < MAX_CUTS + 1) start.push(pts.length);
  const uni = { cutO: { value: c.O }, cutU: { value: c.U }, cutV: { value: c.V }, cutPts: { value: pts }, cutStart: { value: start }, cutN: { value: polys.length } };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = 'varying vec3 vCutW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvCutW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `varying vec3 vCutW;
uniform vec3 cutO; uniform vec3 cutU; uniform vec3 cutV; uniform vec2 cutPts[${MAX_CUT_PTS}]; uniform int cutStart[${MAX_CUTS + 1}]; uniform int cutN;
` + sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{
  vec2 q = vec2(dot(vCutW - cutO, cutU), dot(vCutW - cutO, cutV));
  for (int h = 0; h < ${MAX_CUTS}; h++) {
    if (h >= cutN) break;
    int s = cutStart[h], e = cutStart[h + 1];
    bool inside = false;
    for (int i = 0; i < ${MAX_CUT_PTS}; i++) {
      int a = s + i;
      if (a >= e) break;
      int b = a == s ? e - 1 : a - 1;
      vec2 A = cutPts[a], B = cutPts[b];
      if ((A.y > q.y) != (B.y > q.y) && q.x < (B.x - A.x) * (q.y - A.y) / (B.y - A.y) + A.x) inside = !inside;
    }
    if (inside) discard;
  }
}`);
  };
  m.customProgramCacheKey = () => 'cutouts';
}
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
const DOOR = new THREE.MeshStandardMaterial({ color: 0x6e4a2c, roughness: 0.75, side: THREE.DoubleSide });

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Stairs (a flight of steps along d) or an elevator shaft (four thin walls). */
type StepDesign = (c: THREE.Vector3, along: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3, w: number, h: number, d: number) => boolean;
function buildObject(ob: PlanObject, b: Building, y0: number, y1: number, yStairs: number, layoutRise: number, _mat: THREE.Material, add: (g: THREE.BufferGeometry) => void, step?: StepDesign) {
  const c = toWorld(b, ob, 0);
  const rot = (ob.rot * Math.PI) / 180;
  const place = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number) => {
    geo.translate(lx, ly, lz);
    geo.rotateY(rot);
    geo.translate(c.x, 0, c.z);
    add(geo);
  };
  if (ob.type === 'stairs' || ob.type === 'spiral') {
    // steps (a stepped slab, open underneath) and landings, in plan coordinates; risers scaled to the real floor-to-floor height
    const lay = stairLayout(ob, layoutRise, b.baseLength);
    const k = ob.type === 'stairs' && !ob.toFloor ? 1 : (yStairs - y0) / Math.max(1e-9, layoutRise); // free stairs: standard steps as drawn
    const prism = (pts: { x: number; y: number }[], top: number, t: number) => {
      const w = pts.map(q => toWorld(b, q, 0));
      const geo = new THREE.ExtrudeGeometry(new THREE.Shape(w.map(v => new THREE.Vector2(v.x, -v.z))), { depth: t, bevelEnabled: false, curveSegments: 1 });
      geo.rotateX(-Math.PI / 2); // shape (x, −z) -> world (x, z); the depth goes up
      geo.translate(0, y0 + top * k - t, 0);
      add(geo);
    };
    for (const tr of lay.treads) {
      // a designed step: the design's step box stretched onto this tread (its front, +z, facing down the stairs)
      if (step && ob.type === 'stairs' && tr.pts.length === 4) {
        const w = tr.pts.map(q => toWorld(b, q, 0));
        const rise = lay.riser * k, c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(0.25).setY(y0 + tr.top * k - rise / 2);
        const climb = w[1].clone().sub(w[0]), across = w[3].clone().sub(w[0]);
        const up = new THREE.Vector3(0, 1, 0), out = climb.clone().setY(0).normalize().negate(), along = new THREE.Vector3().crossVectors(up, out);
        if (step(c, along, up, out, across.length(), rise, climb.length())) continue;
      }
      prism(tr.pts, tr.top, lay.riser * k + 0.12);
    }
    for (const pf of lay.platforms) prism(pf.pts, pf.top, 0.2);
    if (ob.type === 'spiral') place(new THREE.CylinderGeometry(SPIRAL_POST, SPIRAL_POST, yStairs - y0, 16), 0, y0 + (yStairs - y0) / 2, 0);
  } else {
    const t = 0.15, h = y1 - y0;
    place(new THREE.BoxGeometry(ob.w, h, t), 0, y0 + h / 2, ob.d / 2 - t / 2);
    place(new THREE.BoxGeometry(ob.w, h, t), 0, y0 + h / 2, -ob.d / 2 + t / 2);
    place(new THREE.BoxGeometry(t, h, ob.d - 2 * t), ob.w / 2 - t / 2, y0 + h / 2, 0);
    place(new THREE.BoxGeometry(t, h, ob.d - 2 * t), -ob.w / 2 + t / 2, y0 + h / 2, 0);
  }
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

/** Neighbouring floors used to shape a smooth vertical profile across several floors. */
interface Vertical {
  pOf(b: V2): V2 | null; // matching point one level below (null: the floor below goes straight up)
  nOf(t: V2): V2 | null; // matching point one level above the top (null: nothing connects further up)
  apex: boolean; // the plan above encloses nothing (a point or ridge): close the profile round
  H: number; hBelow: number; hAbove: number; // floor heights
}

/**
 * Rows of matching vertices from the bottom polyline to the top one.
 * Both are resampled on the union of their arc-length parameters, so
 * mismatched point counts are triangulated automatically.
 * smooth > 0 bends the vertical profile: it becomes a curve through the outlines of
 * the neighbouring floors too (Catmull-Rom style), so stacked lofted floors form one
 * smooth surface: vertical where it leaves a straight floor, round where it closes at a point.
 */
function buildGrid(bottom: V2[], top: V2[], smooth: number, v?: Vertical): Row[] {
  const pb = polyParams(bottom), pt = top.length > 1 ? polyParams(top) : [0];
  const ts = [...new Set([...pb, ...pt].map(t => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
  const B = ts.map(t => polyAt(bottom, pb, t)), T = ts.map(t => polyAt(top, pt, t));
  if (smooth <= 0) return [{ poly: B, params: ts }, { poly: T, params: ts }];
  const R = 12;
  const rows: Row[] = [];
  if (!v) {
    // between these two floors only: a quarter-round profile within this floor
    for (let r = 0; r <= R; r++) {
      const t = r / R;
      const u = (1 - smooth) * t + smooth * (1 - Math.sqrt(Math.max(0, 1 - t * t)));
      rows.push({ poly: B.map((b, c) => ({ x: b.x + (T[c].x - b.x) * u, y: b.y + (T[c].y - b.y) * u })), params: ts });
    }
    return rows;
  }
  const sub = (a: V2, b: V2) => ({ x: a.x - b.x, y: a.y - b.y });
  const mul = (a: V2, k: number) => ({ x: a.x * k, y: a.y * k });
  const mix = (a: V2, b: V2, k: number) => ({ x: a.x * (1 - k) + b.x * k, y: a.y * (1 - k) + b.y * k });
  // per column: a function giving the plan position at height fraction t
  const cols = B.map((b, c) => {
    const t = T[c], lin = sub(t, b);
    const P = v.pOf(b), N = v.nOf(t);
    const mb = P ? mul(sub(t, P), v.H / (v.H + v.hBelow)) : { x: 0, y: 0 }; // straight floor below: rise vertically
    const linear = (k: number) => ({ x: b.x + lin.x * k, y: b.y + lin.y * k });
    const r0 = Math.hypot(lin.x, lin.y);
    if (!N && v.apex && r0 > 1e-9) {
      // closing at a point: an elliptical cap that continues the slope coming from below
      // and meets the top point level (round, like the top of a dome)
      const dir = { x: -lin.x / r0, y: -lin.y / r0 }; // outward from the top point
      const k = Math.max(0, -(mb.x * dir.x + mb.y * dir.y) / v.H); // inward slope, plan units per metre
      const cap = ellipseCap(r0, k, v.H);
      return (tt: V2 | number) => {
        const f = tt as number;
        return mix(linear(f), { x: t.x + dir.x * r0 * cap(f * v.H), y: t.y + dir.y * r0 * cap(f * v.H) }, smooth);
      };
    }
    const mt = N ? mul(sub(N, b), v.H / (v.H + v.hAbove)) : lin;
    const m0 = mix(lin, mb, smooth), m1 = mix(lin, mt, smooth);
    return (tt: V2 | number) => {
      const f = tt as number, f2 = f * f, f3 = f2 * f;
      const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
      return { x: h00 * b.x + h10 * m0.x + h01 * t.x + h11 * m1.x, y: h00 * b.y + h10 * m0.y + h01 * t.y + h11 * m1.y };
    };
  });
  for (let r = 0; r <= R; r++) rows.push({ params: ts, poly: cols.map(fn => fn(r / R)) });
  return rows;
}

/**
 * Quarter-ellipse-like cap: radius r0 at height 0 shrinking to 0 at height d, starting with
 * inward slope k (radius lost per metre) and ending flat. Returns radius fraction at height y.
 */
function ellipseCap(r0: number, k: number, d: number): (y: number) => number {
  // ellipse x = a·√(1 − ((y − yc)/b)²) with its top at d; find b so the slope at y = 0 is k
  const slope = (b: number) => { const u = 1 - d / b; return (r0 * u) / (b * Math.max(1e-12, 1 - u * u)); };
  let lo = d, hi = d * 1e4;
  if (k <= 0) hi = d; // vertical start: quarter ellipse
  else if (slope(hi) < k) lo = hi; // too steep for an ellipse: as close as it gets
  else for (let it = 0; it < 60; it++) { const m = Math.sqrt(lo * hi); if (slope(m) < k) lo = m; else hi = m; }
  const b = (lo + hi) / 2, u0 = 1 - d / b, a = r0 / Math.sqrt(Math.max(1e-12, 1 - u0 * u0));
  return y => { const u = (y + b - d) / b; return (a * Math.sqrt(Math.max(0, 1 - u * u))) / r0; };
}

/** Arc-length parameter of the point of a loop nearest to p (and that distance). */
function paramOnLoop(l: Loop, p: V2): { t: number; d: number } {
  let best = { t: 0, d: Infinity };
  for (let k = 0; k + 1 < l.poly.length; k++) {
    const a = l.poly[k], b = l.poly[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
    if (d < best.d) best = { t: l.params[k] + (l.params[k + 1] - l.params[k]) * u, d };
  }
  return best;
}
const loftsUp = (pl: StructurePlan | null) => !!pl && pl.segments.some(sg => segKind(sg) !== 'open' && segConnect(pl, sg) === 'loft');

/** Neighbour lookups for floor i's lofted walls (see Vertical). */
function verticalFor(b: Building, i: number): Vertical {
  const below = i > 0 ? planAtLevel(b, i - 1) : null, plan = planAtLevel(b, i)!;
  const above = planAtLevel(b, i + 1), above2 = planAtLevel(b, i + 2);
  const downMorphs = below && loftsUp(below) ? morphs(below, plan) : [];
  const upMorphs = above && above2 && loftsUp(above) ? morphs(above, above2) : [];
  const apex = !above || !loopsOf(above).length;
  const nearestMorph = (ms: Morph[], p: V2, side: 'la' | 'lb') => {
    let best: { m: Morph; t: number } | null = null, bd = Infinity;
    for (const m of ms) { const r = paramOnLoop(m[side], p); if (r.d < bd) { bd = r.d; best = { m, t: r.t }; } }
    return best;
  };
  return {
    pOf: p => { const r = nearestMorph(downMorphs, p, 'la'); return r ? loopAt(r.m.lb, r.t - r.m.off) : null; },
    nOf: p => {
      if (!above || !above2 || !loftsUp(above)) return null;
      const r = nearestMorph(upMorphs, p, 'lb');
      if (r) return loopAt(r.m.la, r.t + r.m.off);
      return above2.points.length ? nearestPoint(above2, p) : null; // the level above that is a point / ridge
    },
    apex,
    H: b.floors[i].height,
    hBelow: i > 0 ? b.floors[i - 1].height : b.floors[i].height,
    hAbove: i + 1 < b.floors.length ? b.floors[i + 1].height : b.floors[i].height,
  };
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
    const same = (k: string) => (k === 'roof' ? 'roof' : k === 'wall' || k === 'door' ? 'wall' : k);
    const others = plan.segments.filter(s => s !== seg && (s.a === endId || s.b === endId) && same(segKind(s)) === same(segKind(seg)) && (segKind(s) === 'wall' || segKind(s) === 'roof'));
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
  /** −1: the outside face (+1) lies on the line and the wall extends inwards; 0: centred on the line. */
  shift = 0;
  /** Wall design: how far the outside face sticks out at height v (in half-thicknesses), and the heights where it bends / steps. */
  prof: ((v: number) => number) | null = null;
  profBreaks: number[] = [];
  constructor(public rows: Row[], offs: V2[], offParams: number[], public y0: number, public y1: number,
    public W: (v: V2, y: number) => THREE.Vector3, L: number, public tileW: number, public tileH: number, public thick = 0.3) {
    this.R = rows.length - 1; this.C = rows[0].poly.length; this.params = rows[0].params;
    this.O = this.params.map((t, c) => (c === 0 ? offs[0] : c === this.C - 1 ? offs[offs.length - 1] : polyAt(offs, offParams, t)));
    this.lenM = polyLength(rows[0].poly) * L;
  }
  /** Point on the wall surface. side: +1 / -1 = the two faces (scaled for outlines). */
  at(u: number, v: number, side: number): THREE.Vector3 {
    const rf = v * this.R, r0 = Math.min(this.R - 1, Math.floor(rf)), f = rf - r0;
    const a = polyAt(this.rows[r0].poly, this.params, u), b = polyAt(this.rows[r0 + 1].poly, this.params, u);
    const o = polyAt(this.O, this.params, u);
    const k = side + this.shift + (side > 0 && this.prof ? side * this.prof(v) : 0);
    return this.W({ x: a.x + (b.x - a.x) * f + o.x * k, y: a.y + (b.y - a.y) * f + o.y * k }, this.y0 + (this.y1 - this.y0) * v);
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
  /** Local frame at (u, v): point on the outside face, mid-wall point, and unit directions. */
  frame(u: number, v: number) {
    const e = 1e-3;
    const face = this.at(u, v, 1), mid = this.at(u, v, 0);
    const along = this.at(Math.min(1, u + e), v, 0).sub(this.at(Math.max(0, u - e), v, 0)).normalize();
    const up = this.at(u, Math.min(1, v + e), 0).sub(this.at(u, Math.max(0, v - e), 0));
    if (up.lengthSq() < 1e-12) up.set(0, 1, 0); else up.normalize();
    const out = new THREE.Vector3().subVectors(face, this.at(u, v, -1));
    if (out.lengthSq() < 1e-12) out.crossVectors(along, up);
    out.normalize();
    return { face, mid, along, up, out };
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

  build(holes: Hole[]): THREE.BufferGeometry {
    const pos: number[] = [], uv: number[] = [];
    const uvOf = (u: number, v: number) => [(u * this.lenM) / this.tileW, ((this.y1 - this.y0) * v) / this.tileH];
    const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
      const A = this.at(a[0], a[1], a[2]), B = this.at(b[0], b[1], b[2]), Cc = this.at(c[0], c[1], c[2]);
      const area = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(Cc, A)).lengthSq();
      if (area < 1e-14) return;
      pos.push(A.x, A.y, A.z, B.x, B.y, B.z, Cc.x, Cc.y, Cc.z);
      uv.push(...uvOf(a[0], a[1]), ...uvOf(b[0], b[1]), ...uvOf(c[0], c[1]));
    };
    // boundary edge a -> b (wall material on its left in u/v): quad joining side sa (back) to sb (front)
    const edgeQuad = (a: V2, b: V2, sa: (q: V2) => number = () => -1) => {
      tri([a.x, a.y, sa(a)], [b.x, b.y, sa(b)], [b.x, b.y, 1]);
      tri([a.x, a.y, sa(a)], [b.x, b.y, 1], [a.x, a.y, 1]);
    };
    const P = this.params, R = this.R;
    const curved = this.C > 2 || R > 1;
    const du = curved ? Math.max(1 / 64, Math.min(...P.slice(1).map((t, k) => t - P[k]).filter(x => x > 1e-6), 1)) : 2;
    const dv = curved ? 1 / R : 2;
    const sx = Math.max(this.lenM, 1e-6), sy = Math.max(this.y1 - this.y0, 1e-6);
    const toV = (q: V2) => new THREE.Vector2(q.x * sx, q.y * sy);
    /** Triangulate a region (outer counter-clockwise, holes clockwise) and emit it, subdividing to du × dv. */
    const fill = (outer: V2[], hs: V2[][], side: (q: V2) => number, front: boolean, du2 = du, dv2 = dv) => {
      const tris = THREE.ShapeUtils.triangulateShape(outer.map(toV), hs.map(h => h.map(toV)));
      const all = [...outer, ...hs.flat()];
      const emit = (a: V2, b: V2, c: V2, depth: number) => {
        const us = [a.x, b.x, c.x], vs = [a.y, b.y, c.y];
        if (depth < 7 && (Math.max(...us) - Math.min(...us) > du2 * 1.01 || Math.max(...vs) - Math.min(...vs) > dv2 * 1.01)) {
          const m = (p: V2, q: V2) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          const ab = m(a, b), bc = m(b, c), ca = m(c, a);
          emit(a, ab, ca, depth + 1); emit(ab, b, bc, depth + 1); emit(ca, bc, c, depth + 1); emit(ab, bc, ca, depth + 1);
          return;
        }
        if (front) tri([a.x, a.y, side(a)], [b.x, b.y, side(b)], [c.x, c.y, side(c)]);
        else tri([a.x, a.y, side(a)], [c.x, c.y, side(c)], [b.x, b.y, side(b)]);
      };
      for (const [i, j, k] of tris) {
        let a = all[i], b = all[j], c = all[k];
        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) [b, c] = [c, b]; // counter-clockwise in u/v
        emit(a, b, c, 0);
      }
    };
    // rows: the grid rows, plus every height where the wall design bends or steps
    const VS = [...new Set([...Array.from({ length: R + 1 }, (_, r) => r / R), ...(this.prof ? this.profBreaks : [])].map(v => clamp01(v)))].sort((a, c) => a - c);
    const grid = (front: boolean) => {
      for (let r = 0; r + 1 < VS.length; r++) for (let c = 0; c + 1 < this.C; c++) {
        const u0 = P[c], u1 = P[c + 1], v0 = VS[r], v1 = VS[r + 1];
        if (front) { tri([u0, v0, 1], [u1, v0, 1], [u1, v1, 1]); tri([u0, v0, 1], [u1, v1, 1], [u0, v1, 1]); }
        else { tri([u0, v0, -1], [u1, v1, -1], [u1, v0, -1]); tri([u0, v0, -1], [u0, v1, -1], [u1, v1, -1]); }
      }
    };
    const outer: V2[] = [];
    for (let c = 0; c < this.C; c++) outer.push({ x: P[c], y: 0 });
    for (let r = 1; r < VS.length; r++) outer.push({ x: 1, y: VS[r] });
    for (let c = this.C - 2; c >= 0; c--) outer.push({ x: P[c], y: 1 });
    for (let r = VS.length - 2; r >= 1; r--) outer.push({ x: 0, y: VS[r] });
    /** Outside face with a wall design: filled band by band (between bends / steps), so steps stay sharp. */
    const fillFront = (hs: V2[][]) => {
      if (!this.prof) return fill(outer, hs, () => 1, true);
      const ring = (a: V2[]) => a.map(q => [q.x, q.y] as [number, number]);
      for (let r = 0; r + 1 < VS.length; r++) {
        const va = VS[r], vb = VS[r + 1];
        if (vb - va < 1e-9) continue;
        let mp: MultiPolygon = [];
        try { mp = polygonClipping.intersection([ring(outer), ...hs.map(ring)], [[[0, va], [1, va], [1, vb], [0, vb]]]); } catch { continue; }
        for (const poly of mp) {
          const back = (rr: [number, number][]) => rr.slice(0, -1).map(([x, y]) => ({ x, y }));
          fill(back(poly[0]), poly.slice(1).map(back), () => 1, true);
        }
      }
    };

    const through = holes.filter(h => !h.depth), niches = holes.filter(h => h.depth);
    // outside face (+1): every opening and niche cut out; inside face (−1): only openings
    if (holes.length) fillFront(holes.map(h => h.poly)); else grid(true);
    if (through.length) fill(outer, through.map(h => h.poly), () => -1, false); else grid(false);
    // window reveals (holes run clockwise, so the wall is on their left)
    for (const h of through) for (let k = 0; k < h.poly.length; k++) edgeQuad(h.poly[k], h.poly[(k + 1) % h.poly.length]);
    // niches: the recess surface (a front-facing surface pushed in by the depth) and its sides
    for (const h of niches) {
      const sideAt = (q: V2) => 1 - (2 * Math.min(h.depth!(q.x, q.y), this.thick * 0.95)) / this.thick;
      const ccw = [...h.poly].reverse();
      const xs = ccw.map(q => q.x), ys = ccw.map(q => q.y);
      // recess surface as rings shrinking from the outline to its centre (niche outlines are convex-ish arches)
      void xs; void ys;
      const cx = ccw.reduce((a, q) => a + q.x, 0) / ccw.length, cy = ccw.reduce((a, q) => a + q.y, 0) / ccw.length;
      const RINGS = 28;
      const ring = (k: number) => ccw.map(q => ({ x: cx + (q.x - cx) * (1 - k / RINGS), y: cy + (q.y - cy) * (1 - k / RINGS) }));
      for (let k = 0; k < RINGS; k++) {
        const o = ring(k), n = ring(k + 1);
        for (let j = 0; j < ccw.length; j++) {
          const j2 = (j + 1) % ccw.length;
          tri([o[j].x, o[j].y, sideAt(o[j])], [o[j2].x, o[j2].y, sideAt(o[j2])], [n[j2].x, n[j2].y, sideAt(n[j2])]);
          tri([o[j].x, o[j].y, sideAt(o[j])], [n[j2].x, n[j2].y, sideAt(n[j2])], [n[j].x, n[j].y, sideAt(n[j])]);
        }
      }
      for (let k = 0; k < h.poly.length; k++) edgeQuad(h.poly[k], h.poly[(k + 1) % h.poly.length], sideAt);
    }
    // outer boundary, counter-clockwise: bottom, end, top, start
    for (let c = 0; c + 1 < this.C; c++) edgeQuad({ x: P[c], y: 0 }, { x: P[c + 1], y: 0 });
    for (let r = 0; r + 1 < VS.length; r++) edgeQuad({ x: 1, y: VS[r] }, { x: 1, y: VS[r + 1] });
    for (let c = this.C - 1; c > 0; c--) edgeQuad({ x: P[c], y: 1 }, { x: P[c - 1], y: 1 });
    for (let r = VS.length - 1; r > 0; r--) edgeQuad({ x: 0, y: VS[r] }, { x: 0, y: VS[r - 1] });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return geo;
  }
}

/** Square column from a to b (may be slanted), faces aligned with the wall direction. */
function column(a: THREE.Vector3, b: THREE.Vector3, t: number, wall: V2[] | null) {
  // a round shaft between a square base and a square top (abacus), each as wide as the column
  const len = a.distanceTo(b);
  const band = Math.min(0.2, len * 0.12);
  const parts = [
    new THREE.BoxGeometry(t, band, t).translate(0, -len / 2 + band / 2, 0),
    new THREE.CylinderGeometry(t * 0.4, t * 0.42, len - 2 * band, 24).translate(0, 0, 0),
    new THREE.BoxGeometry(t, band, t).translate(0, len / 2 - band / 2, 0),
  ].map(g => g.toNonIndexed());
  parts.forEach(g => { g.deleteAttribute('uv'); });
  const geo = mergeGeometries(parts, false)!;
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

/** An I-beam from a to b (flanges facing `side`, across the beam), b × b in section. */
function steelBeam(a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, t: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  if (len < 1e-4) return new THREE.BufferGeometry();
  const y = new THREE.Vector3().subVectors(b, a).normalize();
  let x = side.clone().addScaledVector(y, -side.dot(y));
  if (x.lengthSq() < 1e-8) x = Math.abs(y.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(y) : new THREE.Vector3(1, 0, 0);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const f = 0.022, web = 0.014;
  const parts = [
    new THREE.BoxGeometry(t, len, f).translate(0, 0, t / 2 - f / 2),
    new THREE.BoxGeometry(t, len, f).translate(0, 0, -t / 2 + f / 2),
    new THREE.BoxGeometry(web, len, t - 2 * f),
  ].map(g => { const n = g.toNonIndexed(); n.deleteAttribute('uv'); return n; });
  const geo = mergeGeometries(parts, false)!;
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z));
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
  return regionArea(floorRegions(b, i)) * L2;
}

/** The part of a polyline between the first and the last point outside all the bands (null: all inside). */
function trimOutside(poly: V2[], bands: V2[][]): V2[] | null {
  if (!bands.length || poly.length < 2) return poly;
  const params = polyParams(poly), at = (t: number) => polyAt(poly, params, t);
  const inside = (t: number) => { const q = at(t); return bands.some(b => pointInPoly(q, b)); };
  const N = 200;
  let i0 = -1, i1 = -1;
  for (let k = 0; k <= N; k++) if (!inside(k / N)) { if (i0 < 0) i0 = k; i1 = k; }
  if (i0 < 0) return null;
  const edge = (tin: number, tout: number) => { for (let r = 0; r < 30; r++) { const m = (tin + tout) / 2; if (inside(m)) tin = m; else tout = m; } return tout; };
  const t0 = i0 === 0 ? 0 : edge((i0 - 1) / N, i0 / N), t1 = i1 === N ? 1 : edge((i1 + 1) / N, i1 / N);
  if (t1 - t0 < 1e-4) return null;
  if (t0 === 0 && t1 === 1) return poly;
  return [at(t0), ...poly.filter((_, k) => params[k] > t0 && params[k] < t1), at(t1)];
}

/** Value of a profile (points ordered by y) at height v; at a step (two points at one height) the lower part wins at that height. */
export function profileAt(pts: { x: number; y: number }[], v: number): number {
  if (!pts.length) return 0;
  const sp = [...pts].sort((a, b) => a.y - b.y);
  if (v <= sp[0].y) return sp[0].x;
  for (let i = 0; i + 1 < sp.length; i++) {
    const a = sp[i], b = sp[i + 1];
    if (b.y - a.y < 1e-9) continue;
    if (v <= b.y) return a.x + ((b.x - a.x) * (v - a.y)) / (b.y - a.y);
  }
  return sp[sp.length - 1].x;
}
/** Heights where a profile bends or steps (a step gets two rows a hair apart, so it comes out as a flat ledge). */
export function profileBreaks(pts: { x: number; y: number }[]): number[] {
  const out: number[] = [];
  for (const q of pts) out.push(q.y, Math.min(1, q.y + 1e-4));
  return out;
}

/**
 * A pilaster from its design: rectangular cross-sections (half width from the front outline, depth from the
 * side outline) stacked up the height. Base and capital keep their drawn size (at PILASTER_REF_H); the shaft stretches.
 */
export function pilasterGeometry(sh: PilasterShape, base: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3, y0: number, H: number, w = sh.w): THREE.BufferGeometry {
  const bandB = Math.min(sh.base * PILASTER_REF_H, H * 0.3), bandT = Math.min(sh.top * PILASTER_REF_H, H * 0.3);
  // height (m from the bottom) -> design y
  const yOf = (t: number) => t <= bandB ? (t / Math.max(bandB, 1e-9)) * sh.base
    : t >= H - bandT ? 1 - ((H - t) / Math.max(bandT, 1e-9)) * sh.top
    : sh.base + ((t - bandB) / Math.max(H - bandB - bandT, 1e-9)) * (1 - sh.base - sh.top);
  // design y -> height
  const tOf = (y: number) => y <= sh.base ? (y / Math.max(sh.base, 1e-9)) * bandB
    : y >= 1 - sh.top ? H - ((1 - y) / Math.max(sh.top, 1e-9)) * bandT
    : bandB + ((y - sh.base) / Math.max(1 - sh.base - sh.top, 1e-9)) * (H - bandB - bandT);
  const ys = [...new Set([0, 1, sh.base, 1 - sh.top, ...profileBreaks(sh.front), ...profileBreaks(sh.side)].map(y => clamp01(y)))].sort((a, b) => a - b);
  void yOf;
  const up = new THREE.Vector3(0, 1, 0);
  const rings = ys.map(y => {
    // wider than drawn (a corner pilaster running across the corner): the extra width stays solid, only the drawn part steps in
    const extra = Math.max(0, w - sh.w) / 2, hw = extra + (sh.w / 2) * profileAt(sh.front, y), dd = sh.d * profileAt(sh.side, y), t = tOf(y);
    const c = base.clone(); c.y = y0 + t;
    const P = (a: number, o: number) => c.clone().addScaledVector(along, a).addScaledVector(out, o);
    return [P(-hw, 0), P(hw, 0), P(hw, dd), P(-hw, dd)]; // against the wall, then the front
  });
  void up;
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let r = 0; r + 1 < rings.length; r++) for (let k = 0; k < 4; k++) {
    const a = rings[r][k], b = rings[r][(k + 1) % 4], c = rings[r + 1][(k + 1) % 4], d = rings[r + 1][k];
    tri(a, c, b); tri(a, d, c);
  }
  const bot = rings[0], top = rings[rings.length - 1];
  tri(bot[0], bot[1], bot[2]); tri(bot[0], bot[2], bot[3]);
  tri(top[0], top[2], top[1]); tri(top[0], top[3], top[2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
