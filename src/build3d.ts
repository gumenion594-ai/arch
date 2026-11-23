// Turns a building into 3D geometry (structural / detailed views).
import * as THREE from 'three';
import {
  Building, Floor, OpeningShape, Placement, PlanObject, PlanSegment, StructurePlan, Texture, WinPoint, divisionBorders, elevation, hasCeiling, hasFloor,
  BALCONY_AT, nextMainFloor, planForFloor, segColT, segConnect, segConnectSmooth, segDivLen, segKind, segMaterial, segSmoothSpan,
} from './model';
import { fitDesign, fitDesignSliced } from './assets';
import { V2, enclosedFacesSegs, smoothClosed, polyAt, polyLength, polyParams, sampleSeg, samplePath, shortestPath, signedArea } from './geometry';

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
    const segs = f.segIds.map(id => pl.segments.find(s => s.id === id)!);
    if (segs.some(s => segKind(s) === 'balustrade')) continue; // an open terrace
    if (segs.every(s => segConnect(pl, s) === 'straight')) out.push(f.poly);
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
    const fl = p.floors[i];
    const tex = o.detailed && fl.texture ? mats.tex(fl.texture) : null;
    const top = sel.floors.has(fl.id) ? mats.selected : tex ?? (fl.color ? mats.color(fl.color) : mats.slab);
    // the slab's edge is flush with the outside of the walls: give it the wall's look so the facade reads as one surface
    const pl = planAtLevel(p, i), w = pl?.segments.find(sg => segKind(sg) === 'wall');
    const edge = sel.floors.has(fl.id) ? mats.selected : !pl || !w ? top
      : (o.detailed && w.texture ? mats.tex(w.texture) : null) ?? (w.color ? mats.color(w.color) : mats.wall(o.detailed ? segMaterial(pl, w) : 'structural'));
    const m = add(geo, top, { floorId: fl.id, floorIndex: i });
    (m as unknown as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>).material = [top, edge]; // ExtrudeGeometry groups: 0 = top / bottom, 1 = sides
  });
  const cut = o.upTo ?? null;
  const hidden = (i: number) => cut !== null && i > cut;
  for (let i = 0; i < N; i++) {
    if (hidden(i)) continue;
    if (slabs[i].floor) slab(floorFaces(p, i), elevation(p, i), slabs[i].floor, i);
    if (slabs[i].ceiling && i !== cut) slab(ceilingFaces(p, i), elevation(p, i + 1) - slabs[i].ceiling, slabs[i].ceiling, i);
  }

  // ---------- walls / columns per floor ----------
  const segMat = (seg: PlanSegment, material: string, column = false) => {
    const tex = o.detailed && seg.texture ? mats.tex(seg.texture) : null;
    return tex ?? (seg.color ? mats.color(seg.color) : column ? mats.column(material) : mats.wall(o.detailed ? material : 'structural'));
  };
  const placeMat = (pl: Placement, fallback: THREE.Material) => {
    if (sel.elements.has(pl.id)) return mats.selected;
    const tex = o.detailed && pl.texture ? mats.tex(pl.texture) : null;
    return tex ?? (pl.color ? mats.color(pl.color) : fallback);
  };
  /** An imported design fitted into a box, only in the detailed view (null otherwise). */
  const designAt = (id: string | null | undefined, c: THREE.Vector3, along: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3, w: number, h: number, d: number, recolor?: THREE.Material | null, pick?: PickInfo, sliced = false) => {
    if (!o.detailed || !id || !mats.design) return false;
    const src = mats.design(id);
    if (!src) return false;
    const obj = sliced ? fitDesignSliced(src, c, along, up, out, w, h, d) : fitDesign(src, c, along, up, out, w, h, d);
    obj.traverse(x => {
      const m = x as THREE.Mesh;
      if (!m.isMesh) return;
      if (recolor) m.material = recolor;
      m.userData = { pick };
    });
    g.add(obj);
    return true;
  };

  type ColPiece = { a: THREE.Vector3; c: THREE.Vector3; ct: number; bottom: V2[]; pick: PickInfo; seg: PlanSegment; material: string; selected: boolean };
  type PilPiece = { base: THREE.Vector3; out: THREE.Vector3; along: THREE.Vector3; y0: number; y1: number; pw: number; pd: number; pl: Placement; mat: THREE.Material; pick: PickInfo };
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
        // around a floored area (a porch), straight columns stand on the floor slab and reach the ceiling
        const onSlab = fs !== 0 && rows.length === 2;
        const c0 = onSlab ? y0 + slabs[i].floor : y0, c1 = onSlab ? y1 - slabs[i].ceiling : y1;
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
        const bottom = sampleSeg(plan, seg);
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
        const loft = !interior && segConnect(plan, seg) === 'loft' && above && above.points.length > 0;
        if (loft) top = loftTarget(plan, above!, seg);
        const rows = buildGrid(bottom, top, loft ? segConnectSmooth(plan, seg) : 0,
          loft && segSmoothSpan(plan, seg) ? (vert ??= verticalFor(p, i)) : undefined);

        if (kind === 'wall' || kind === 'door') {
          // +1 side of the wall = outside of the building
          // external walls stand inside the line (outer face on it, flush with floors and ceilings);
          // walls not around an enclosed area, and internal walls, stay centred on it
          const fs = interior ? 0 : faceSide(plan, seg);
          const flip = !interior && fs !== -1;
          const offs = offsets(plan, seg, bottom, plan.wallThickness / 2 / L).map(v => (flip ? { x: -v.x, y: -v.y } : v));
          const texInfo = seg.texture ? o.textures.find(t => t.id === seg.texture) : undefined;
          const tileH = floor.height, tileW = texInfo ? tileH * (texInfo.w / texInfo.h) : 1;
          // a door segment is just the lintel above a 2.1 m opening
          const yb = kind === 'door' ? y0 + Math.min(2.1, (y1 - y0) * 0.8) : y0;
          const wall = new WallSolid(rows, offs, polyParams(bottom), yb, y1, W, L, tileW, tileH, plan.wallThickness);
          if (fs !== 0 && !loft) wall.shift = -1; // sloped (connected) walls such as roofs stay centred: they overhang a little
          const wallH = y1 - yb;

          // openings and niches: holes in u/v; big ones reach into the neighbouring divisions
          const holes: Hole[] = [];
          pick.holes = [];
          for (const pl of placements) {
            if (pl.segId !== seg.id || (pl.type !== 'opening' && pl.type !== 'niche') || kind !== 'wall') continue;
            const shape = p.openingShapes.find(x => x.id === pl.shapeId);
            if (!shape || !shape.outlines.some(ol => ol.length >= 3)) continue;
            const k = Math.min(Math.max(0, pl.div ?? 0), borders.length - 2);
            const sc = ((borders[k] + borders[k + 1]) / 2) * lenM + pl.dx;
            const yLow = shape.anchor === 'bottom' ? slabs[i].floor + pl.dy : (wallH - shape.h) / 2 + pl.dy;
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
            if (shape.kind === 'opening') {
              designAt(pl.frameId, fr.mid, fr.along, fr.up, fr.out, ww, hh, plan.wallThickness * 0.9, sm, ppick);
              designAt(pl.surroundId, fr.face.clone().addScaledVector(fr.out, 0.04), fr.along, fr.up, fr.out, ww * 1.3, hh * 1.15, 0.08, sm, ppick);
            } else {
              designAt(pl.designId, fr.face.clone().addScaledVector(fr.out, 0.05), fr.along, fr.up, fr.out, ww * 1.25, hh * 1.1, 0.1, sm, ppick);
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
          if (!interior) decorate(wall, seg, plan, borders, lenM, wallH, i, floor, placements.filter(pl => pl.segId === seg.id));
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

      // (single unconnected points build nothing: they only serve as targets for the floor below)

      // stairs climb to the next main floor (subfloors are part of the same floor)
      const nm = nextMainFloor(p, i);
      const yStairs = nm < N ? elevation(p, nm) + slabs[nm].floor : y1;
      if (interior) for (const ob of plan.objects) buildObject(ob, p, y0, y1, yStairs, mats.object, (geo: THREE.BufferGeometry) => add(geo, mats.object, { floorId: floor.id, floorIndex: i, interior: true }));
    }
  }

  // ---------- columns and pilasters: stacked pieces join into one (one base, one top) ----------
  const joined = <T>(list: T[], key: (x: T) => string, lo: (x: T) => number, hi: (x: T) => number, gap: number) => {
    const groups = new Map<string, T[]>();
    for (const x of list) { const k = key(x); (groups.get(k) ?? groups.set(k, []).get(k)!).push(x); }
    const runs: T[][] = [];
    for (const g2 of groups.values()) {
      g2.sort((x, y) => lo(x) - lo(y));
      let cur: T[] = [];
      for (const x of g2) {
        if (cur.length && lo(x) - hi(cur[cur.length - 1]) > gap) { runs.push(cur); cur = []; }
        cur.push(x);
      }
      if (cur.length) runs.push(cur);
    }
    return runs;
  };
  const r2 = (v: number) => Math.round(v * 50) / 50; // 2 cm grid
  for (const run of joined(colPieces, x => `${r2(x.a.x)},${r2(x.a.z)},${r2(x.ct)},${x.seg.columnDesign ?? ''}`, x => x.a.y, x => x.c.y, 1.0)) {
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
  for (const run of joined(pilPieces, x => `${r2(x.base.x)},${r2(x.base.z)},${r2(x.out.x)},${r2(x.out.z)},${x.pl.designId ?? ''}`, x => x.y0, x => x.y1, 0.05)) {
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
  function decorate(wall: WallSolid, seg: PlanSegment, plan: StructurePlan, borders: number[], lenM: number, wallH: number, i: number, floor: Floor, list: Placement[]) {
    const t = plan.wallThickness;
    for (const pl of list) {
      const pick: PickInfo = { floorId: floor.id, floorIndex: i, segId: seg.id, placementId: pl.id };
      const k = Math.min(Math.max(0, pl.div ?? 0), borders.length - (pl.type === 'pilaster' ? 1 : 2));
      if (pl.type === 'cornice') {
        // runs along the top of the division, hanging from the top of the floor
        const u0 = borders[k], u1 = borders[k + 1];
        const fr = wall.frame((u0 + u1) / 2, 1);
        const mat = placeMat(pl, mats.deco);
        // at a corner, run past it (by the cornice's projection) only where the next wall has a cornice too, so they meet
        const corniceAt = (pointId: string) => p.placements.some(x => x.type === 'cornice' && x.floorId === floor.id && x.segId !== seg.id &&
          plan.segments.some(o => o.id === x.segId && (o.a === pointId || o.b === pointId)));
        const reach = (wall.shift ? 0 : t / 2) / lenM, proj = CORNICE[1][0] / lenM;
        const ua = k === 0 ? u0 - reach - (corniceAt(seg.a) ? proj : 0) : u0;
        const ub = k === borders.length - 2 ? u1 + reach + (corniceAt(seg.b) ? proj : 0) : u1;
        if (designAt(pl.designId, fr.face.clone().addScaledVector(fr.out, CORNICE[1][0] / 2).addScaledVector(fr.up, -0.16), fr.along, fr.up, fr.out, (ub - ua) * lenM, 0.32, 0.32, pl.color ? mat : sel.elements.has(pl.id) ? mats.selected : null, pick)) continue;
        add(sweepProfile(wall, ua, ub, CORNICE), mat, pick);
      } else if (pl.type === 'pilaster') {
        const pw = 0.5, pd = 0.12;
        let s0 = borders[k] * lenM + pl.dx;
        const corner = wall.shift ? 0 : t / 2; // where the outer corner is, relative to the wall's ends
        if (k === 0) s0 = -corner + pw / 2 + pl.dx; // flush with the outer corner
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
        pilPieces.push({ base, out: new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize(), along: fr.along.clone(), y0: wall.y0, y1: wall.y0 + wallH, pw, pd, pl, mat, pick });
      } else if (pl.type === 'balcony') {
        const shape = p.balconyShapes.find(x => x.id === pl.shapeId) ?? p.balconyShapes[0];
        if (!shape) continue;
        const uc = (borders[k] + borders[k + 1]) / 2 + pl.dx / lenM;
        const fr = wall.frame(Math.min(1, Math.max(0, uc)), 0);
        // platform top: lower than the middle of the division
        const yTopB = wall.y0 + wallH * BALCONY_HEIGHT + pl.dy;
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
    for (let j = 0; j + 1 < path.length; j++) {
      const a = path[j], c = path[j + 1];
      const len = a.distanceTo(c);
      if (len < 1e-3) continue;
      const along = new THREE.Vector3().subVectors(c, a).normalize();
      const up = new THREE.Vector3(0, 1, 0), out = new THREE.Vector3().crossVectors(along, up).normalize();
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
const CORNICE: [number, number][] = [[0, 0], [0.34, 0], [0.34, 0.06], [0.26, 0.1], [0.2, 0.16], [0.1, 0.2], [0.1, 0.27], [0, 0.32]];
/** Platform top of a balcony as a fraction of the floor height (lower than the middle). */
export const BALCONY_HEIGHT = BALCONY_AT;
/** Baluster silhouette (radius, height) turned on a lathe. */
const BALUSTER = [[0, 0], [0.055, 0], [0.055, 0.05], [0.035, 0.1], [0.06, 0.32], [0.065, 0.4], [0.03, 0.55], [0.025, 0.7], [0.045, 0.75], [0.045, 0.8], [0, 0.8]].map(([x, y]) => new THREE.Vector2(x, y));

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
function sweepProfile(wall: WallSolid, u0: number, u1: number, prof: [number, number][]): THREE.BufferGeometry {
  const n = Math.max(2, Math.ceil((u1 - u0) * 40) + 1);
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j < n; j++) {
    const u = u0 + ((u1 - u0) * j) / (n - 1);
    const fr = wall.frame(Math.min(1, Math.max(0, u)), 1);
    const base = wall.at(Math.min(1, Math.max(0, u)), 1, 1).addScaledVector(fr.along, (u - Math.min(1, Math.max(0, u))) * wall.lenM);
    const flat = new THREE.Vector3(fr.out.x, 0, fr.out.z).normalize();
    rings.push(prof.map(([x, y]) => base.clone().addScaledVector(flat, x).add(new THREE.Vector3(0, -y, 0))));
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
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

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
  /** −1: the outside face (+1) lies on the line and the wall extends inwards; 0: centred on the line. */
  shift = 0;
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
    const k = side + this.shift;
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
    const grid = (front: boolean) => {
      for (let r = 0; r < R; r++) for (let c = 0; c + 1 < this.C; c++) {
        const u0 = P[c], u1 = P[c + 1], v0 = r / R, v1 = (r + 1) / R;
        if (front) { tri([u0, v0, 1], [u1, v0, 1], [u1, v1, 1]); tri([u0, v0, 1], [u1, v1, 1], [u0, v1, 1]); }
        else { tri([u0, v0, -1], [u1, v1, -1], [u1, v0, -1]); tri([u0, v0, -1], [u0, v1, -1], [u1, v1, -1]); }
      }
    };
    const outer: V2[] = [];
    for (let c = 0; c < this.C; c++) outer.push({ x: P[c], y: 0 });
    for (let r = 1; r <= R; r++) outer.push({ x: 1, y: r / R });
    for (let c = this.C - 2; c >= 0; c--) outer.push({ x: P[c], y: 1 });
    for (let r = R - 1; r >= 1; r--) outer.push({ x: 0, y: r / R });

    const through = holes.filter(h => !h.depth), niches = holes.filter(h => h.depth);
    // outside face (+1): every opening and niche cut out; inside face (−1): only openings
    if (holes.length) fill(outer, holes.map(h => h.poly), () => 1, true); else grid(true);
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
