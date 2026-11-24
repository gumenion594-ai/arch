// Project templates that use 3D designs (they need three.js to measure the built-in models).
import * as THREE from 'three';
import { DecoDesign, Design, Floor, OpeningShape, PlanPoint, PlanSegment, Project, createProject, divisionBorders, newPlan, segDivLen, uid } from './model';
import { ARCH_WIN, BUILTIN_DESIGNS } from './builtin';

/** The "Tall arched window" shape: 1.4 × 3.5 m with a semicircular head (spring at 80 % of the height); smaller ones keep the proportions. */
export function tallArchedWindow(w = ARCH_WIN.w, name = 'Tall arched window'): OpeningShape {
  const spring = 1 - ARCH_WIN.w / 2 / ARCH_WIN.h; // 0.8
  const arc = Array.from({ length: 15 }, (_, k) => {
    const t = ((k + 1) / 16) * Math.PI;
    return { x: 0.5 + 0.5 * Math.cos(t), y: spring + (ARCH_WIN.w / 2 / ARCH_WIN.h) * Math.sin(t) };
  });
  return {
    id: uid(), name, kind: 'opening', smooth: 0, w, h: (w * ARCH_WIN.h) / ARCH_WIN.w, anchor: 'center',
    outlines: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: spring }, ...arc, { x: 0, y: spring }]],
  };
}

/** A part placed exactly where a built-in model was modelled (its own box, in the reference frame). */
function partFor(key: string, modelId: string) {
  const box = new THREE.Box3().setFromObject(BUILTIN_DESIGNS[key].make());
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { id: uid(), modelId, pos: [r(c.x), r(c.y), r(c.z)] as [number, number, number], rot: [0, 0, 0] as [number, number, number], size: [r(s.x), r(s.y), r(s.z)] as [number, number, number] };
}

/** The arched window design (built-in frame + surround on the Tall arched window shape), added to a project. */
export function addArchedWindowDesign(p: Project): { shape: OpeningShape; deco: DecoDesign } {
  const b = p.buildings[0];
  const shape = tallArchedWindow();
  b.openingShapes.push(shape);
  const frame: Design = { id: uid(), name: BUILTIN_DESIGNS.archFrame.name, category: 'frame', format: 'builtin', builtin: 'archFrame' };
  const surround: Design = { id: uid(), name: BUILTIN_DESIGNS.archSurround.name, category: 'surround', format: 'builtin', builtin: 'archSurround' };
  p.designs.push(frame, surround);
  const deco: DecoDesign = { id: uid(), name: 'Arched window', type: 'opening', shapeId: shape.id, parts: [partFor('archFrame', frame.id), partFor('archSurround', surround.id)] };
  p.decos.push(deco);
  return { shape, deco };
}

/**
 * The villa template with the arched windows: same proportions as the design (so the arch stays round),
 * 1.1 × 2.75 m on the ground floor and 0.86 × 2.15 m upstairs (a little lower, clear of the cornice).
 */
export function dressVilla(p: Project): Project {
  const b = p.buildings[0];
  const { deco } = addArchedWindowDesign(p);
  const ground = tallArchedWindow(1.1, 'Arched window, ground floor'), upper = tallArchedWindow(0.86, 'Arched window, upper floor');
  b.openingShapes.push(ground, upper);
  const name = (id?: string | null) => b.openingShapes.find(s => s.id === id)?.name;
  for (const pl of b.placements) {
    if (pl.type !== 'opening') continue;
    if (name(pl.shapeId) === 'Arched window') { pl.shapeId = ground.id; pl.designId = deco.id; }
    else if (name(pl.shapeId) === 'Window') { pl.shapeId = upper.id; pl.designId = deco.id; pl.dy = -0.1; }
  }
  // windows next to a corner pilaster move along the wall until their surround clears it
  const L = b.baseLength;
  for (const pl of b.placements) {
    if (pl.type !== 'opening' || pl.designId !== deco.id) continue;
    const plan = b.plans.find(x => x.floorIds.includes(pl.floorId)), seg = plan?.segments.find(x => x.id === pl.segId);
    const shape = b.openingShapes.find(x => x.id === pl.shapeId);
    if (!plan || !seg || !shape) continue;
    const A = plan.points.find(q => q.id === seg.a)!, C = plan.points.find(q => q.id === seg.b)!;
    const len = Math.hypot(C.x - A.x, C.y - A.y) * L, bs = divisionBorders(len, segDivLen(b, seg));
    const centre = (bs[pl.div ?? 0] + bs[(pl.div ?? 0) + 1]) / 2 + pl.dx;
    const half = 1.15 * (shape.w / ARCH_WIN.w); // half the surround's width
    const pil = (k: number) => b.placements.find(x => x.type === 'pilaster' && x.floorId === pl.floorId && x.segId === seg.id && x.div === k);
    const reach = (x?: { shapeId?: string | null }) => { const ps = b.pilasterShapes.find(q => q.id === x?.shapeId); return (ps?.w ?? 0.5) + (ps?.d ?? 0.12); }; // across the corner (an L)
    const p0 = pil(0), p1 = pil(bs.length - 1);
    if (p0) { const need = reach(p0) + half + 0.05; if (centre < need) pl.dx += Math.round((need - centre) * 100) / 100; }
    if (p1) { const need = reach(p1) + half + 0.05; if (len - centre < need) pl.dx -= Math.round((need - (len - centre)) * 100) / 100; }
  }
  // where two windows now overlap (a short wall), keep one, centred in the space the pilasters leave
  const groups = new Map<string, typeof b.placements>();
  for (const pl of b.placements) if (pl.type === 'opening' && pl.designId === deco.id) (groups.get(pl.floorId + '|' + pl.segId) ?? groups.set(pl.floorId + '|' + pl.segId, []).get(pl.floorId + '|' + pl.segId)!).push(pl);
  const drop = new Set<string>();
  for (const list of groups.values()) {
    const pl0 = list[0];
    const plan = b.plans.find(x => x.floorIds.includes(pl0.floorId)), seg = plan?.segments.find(x => x.id === pl0.segId);
    const shape = b.openingShapes.find(x => x.id === pl0.shapeId);
    if (!plan || !seg || !shape || list.length < 2) continue;
    const A = plan.points.find(q => q.id === seg.a)!, C = plan.points.find(q => q.id === seg.b)!;
    const len = Math.hypot(C.x - A.x, C.y - A.y) * L, bs = divisionBorders(len, segDivLen(b, seg));
    const centreOf = (x: typeof pl0) => (bs[x.div ?? 0] + bs[(x.div ?? 0) + 1]) / 2 + x.dx;
    const half = 1.15 * (shape.w / ARCH_WIN.w);
    const sorted = [...list].sort((x, y) => centreOf(x) - centreOf(y));
    const clash = sorted.some((x, i) => i > 0 && centreOf(x) - centreOf(sorted[i - 1]) < 2 * half + 0.05);
    if (!clash || sorted.length !== 2) continue;
    const pil = (k: number) => b.placements.some(x => x.type === 'pilaster' && x.floorId === pl0.floorId && x.segId === seg.id && x.div === k);
    const reach = 0.8, from = pil(0) ? reach : 0, to = pil(bs.length - 1) ? len - reach : len;
    const keep = sorted[0], gone = sorted[1];
    keep.dx = Math.round(((from + to) / 2 - (bs[keep.div ?? 0] + bs[(keep.div ?? 0) + 1]) / 2) * 100) / 100;
    drop.add(gone.id);
  }
  b.placements = b.placements.filter(x => !drop.has(x.id));
  return p;
}

/**
 * Template: a small two-storey house (12 × 9 m) with tall round-arched windows, each with the
 * "Arched window" design (wooden frame + stone surround, built in), a hip roof and a cornice.
 */
export function houseProject(name: string): Project {
  const L = 16, H = 4.6;
  const p = createProject(name, { name, baseLength: L, floors: 3, floorHeight: H, ground: 0, x: 0, y: 0 });
  const b = p.buildings[0];
  b.floors[2].height = 2.8; // roof storey
  const [f0, f1, f2] = b.floors;
  const X = (m: number) => m / L;
  let n = 1;
  const pt = (x: number, y: number): PlanPoint => ({ id: uid(), n: n++, x: X(x), y: X(y) });
  const rectPlan = (nm: string, floors: Floor[]) => {
    const pl = newPlan(nm, floors.map(f => f.id));
    n = 1;
    const a = pt(2, 3.5), c = pt(14, 3.5), d = pt(14, 12.5), e = pt(2, 12.5);
    pl.points = [a, c, d, e];
    const seg = (u: PlanPoint, v: PlanPoint): PlanSegment => ({ id: uid(), a: u.id, b: v.id, color: '#e4dccb' });
    pl.segments = [seg(a, c), seg(c, d), seg(d, e), seg(e, a)];
    pl.nextN = n; pl.wallThickness = 0.45;
    return pl;
  };
  const house = rectPlan('House', [f0, f1]);
  const roof = rectPlan('Roof storey', [f2]);
  roof.connect = 'loft';
  roof.segments.forEach(s => (s.color = '#9c5a3c'));
  const ridge = newPlan('Ridge');
  n = 1;
  ridge.points = [pt(5, 8), pt(11, 8)];
  ridge.segments = [{ id: uid(), a: ridge.points[0].id, b: ridge.points[1].id }];
  b.plans = [house, roof, ridge];
  b.topPlanId = ridge.id;
  b.divLen = 3; // 12 m and 9 m walls: 4 and 3 bays of 3 m

  // the window shape, the two built-in models and the design that puts them together
  const { shape: win, deco } = addArchedWindowDesign(p);

  const door = b.openingShapes.find(s => s.name === 'Door')!;
  door.w = 1.2; door.h = 2.6;
  const bays = (s: PlanSegment) => (s === house.segments[0] || s === house.segments[2] ? 4 : 3);
  for (const f of [f0, f1]) for (const s of house.segments) for (let k = 0; k < bays(s); k++) {
    const entrance = f === f0 && s === house.segments[0] && k === 1;
    b.placements.push({ id: uid(), type: 'opening', floorId: f.id, segId: s.id, div: k, dx: 0, dy: 0, shapeId: entrance ? door.id : win.id, designId: entrance ? null : deco.id });
    if (f === f1) b.placements.push({ id: uid(), type: 'cornice', floorId: f.id, segId: s.id, div: k, dx: 0, dy: 0 });
  }
  f0.color = '#b9b0a0';
  return p;
}
