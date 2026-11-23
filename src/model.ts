// Data model, persistence and undo history.

export const MAX_M = 10000; // 10 km cap for every length
export const MAX_AREA = MAX_M * MAX_M;

export interface Floor {
  id: string;
  height: number; // m
  sub?: boolean; // a subfloor (5.1, 5.2 …) of the main floor below it
  hasFloor?: boolean; // floor slab at the bottom of this floor (default on)
  hasCeiling?: boolean; // ceiling slab at the top of this floor (default on)
  color?: string | null; // slab colour
  texture?: string | null; // slab texture
  /**
   * Floor mask: where this floor's slab is, in plan coordinates (0..1). null = automatic (what the
   * walls enclose). areas are added, carves are cut out (stair openings, double-height spaces …).
   */
  mask?: { areas: WinPoint[][]; carves: WinPoint[][] } | null;
}

export interface PlanPoint {
  id: string;
  n: number; // order in which it was placed
  x: number; // 0..1 inside building area
  y: number; // 0..1
}

/** 'door' only in floor (interior) plans; 'balustrade' = a 1 m railing of balusters. */
export type SegKind = 'wall' | 'colonnade' | 'balustrade' | 'open' | 'door';
export type ConnectMode = 'straight' | 'loft';

export interface PlanSegment {
  id: string;
  a: string; // point id
  b: string; // point id
  kind?: SegKind; // default 'wall'
  divLen?: number | null; // division length in m (null = the building's default)
  divisions?: number; // (older projects: number of divisions)
  columns?: number[] | null; // colonnade: hand-placed column positions, m from the wall's start (null = on the division borders)
  columnThickness?: number | null; // null = plan wall thickness
  smooth?: number | null; // 0..1, null = plan default
  connect?: ConnectMode | null; // null = plan default
  connectSmooth?: number | null; // 0..1, null = plan default
  smoothSpan?: boolean | null; // connection smoothness across all connected floors (true) or per pair of floors (false)
  texture?: string | null; // texture id
  material?: string | null; // null = plan material
  color?: string | null; // '#rrggbb', shown in structural and detailed views
  columnDesign?: string | null; // imported column design for colonnade columns (detailed view)
  balusterDesign?: string | null; // imported baluster design (detailed view)
}

/** Stairs / elevator placed in a floor plan. x, y = centre (0..1), w × d in metres, rot in degrees. */
export interface PlanObject { id: string; type: 'stairs' | 'elevator'; x: number; y: number; w: number; d: number; rot: number }

/** A point of a drawn outline or profile; s = this point's smoothness (null = the shape's). */
export interface WinPoint { x: number; y: number; s?: number | null }

/**
 * Opening (window, door, arch …) or niche, drawn on a 0..1 grid that fills a w × h box in metres.
 * anchor: 'center' = centred on the wall height (windows), 'bottom' = standing on the floor (entrances).
 * Niches also have a depth and two profiles (0..1): side view (x = depth, y = height) and
 * bottom view (x = width, y = depth); the recess depth at a point is depth × min(side, bottom).
 */
export interface OpeningShape {
  id: string; name: string;
  kind: 'opening' | 'niche';
  outlines: WinPoint[][];
  smooth: number;
  w: number; h: number;
  anchor: 'center' | 'bottom';
  depth?: number; // niche
  side?: WinPoint[]; // niche side-view profile
  bottom?: WinPoint[]; // niche bottom-view profile
}

/** Balcony platform: outline in a w × d box (x across the wall, y outwards from it), thickness in m. */
export interface BalconyShape { id: string; name: string; outline: WinPoint[]; smooth: number; w: number; d: number; thickness: number; railing: boolean }

/** Imported 3D designs (stretched to fit what they are assigned to). Files live in IndexedDB (assets.ts). */
export type DesignCategory = 'frame' | 'surround' | 'cornice' | 'column' | 'baluster' | 'balcony' | 'nicheDeco' | 'model';
export const DESIGN_CATEGORIES: Record<DesignCategory, string> = {
  frame: 'Opening frames', surround: 'Opening surrounds', cornice: 'Cornices', column: 'Columns / pilasters',
  baluster: 'Balusters', balcony: 'Balconies', nicheDeco: 'Niche decorations', model: '3D models',
};
export interface Design {
  id: string; name: string; category: DesignCategory; format: 'glb' | 'gltf' | 'obj' | 'stl' | 'builtin'; builtin?: string;
  baseFrac?: number | null; topFrac?: number | null; // columns: base / top bands (fractions of height) kept unstretched
}

/** Something added onto the structure. Openings / niches / balconies / cornices sit in a wall division, pilasters on a border between divisions. */
export type PlacementType = 'opening' | 'niche' | 'balcony' | 'cornice' | 'pilaster' | 'model';
export interface Placement {
  id: string;
  type: PlacementType;
  floorId: string;
  segId?: string;
  div?: number; // division index (pilaster: border index 0..n)
  shapeId?: string | null; // opening / niche / balcony shape
  designId?: string | null; // imported design (cornice, pilaster column, balcony, niche decoration, model)
  frameId?: string | null; // opening frame design
  surroundId?: string | null; // opening surround design
  dx: number; dy: number; // moved along the wall / up, in m
  color?: string | null;
  texture?: string | null;
  pos?: { x: number; y: number; z: number }; // free 3D model: metres from the building's corner (x east, y up, z north)
  rot?: number; // degrees
  scale?: number; // 3D model: size of its largest side in m
}

export const hasFloor = (f: Floor) => f.hasFloor !== false;
export const hasCeiling = (f: Floor) => f.hasCeiling !== false;

/** Wall materials with density in kg/m³. */
export const MATERIALS: Record<string, { name: string; density: number; color: number }> = {
  concrete: { name: 'Reinforced concrete', density: 2400, color: 0xbdbdbd },
  brick: { name: 'Brick', density: 1800, color: 0xb87a5e },
  stone: { name: 'Stone', density: 2600, color: 0xcfc6b4 },
  aerated: { name: 'Aerated concrete block', density: 600, color: 0xe2e2dc },
  timber: { name: 'Timber (CLT)', density: 480, color: 0xc9a46a },
  steel: { name: 'Steel', density: 7850, color: 0x8a96a3 },
  glass: { name: 'Glass', density: 2500, color: 0x9fc7d9 },
};

export interface Texture { id: string; name: string; data: string; w: number; h: number; }

export interface StructurePlan {
  id: string;
  name: string;
  floorIds: string[]; // floors this plan applies to
  wallThickness: number; // m
  floorThickness: number; // m
  ceilingThickness: number; // m
  floorEnabled: boolean; // (older projects; floors now have their own floor / ceiling switches)
  smooth: number; // default plan smoothness 0..1
  connect: ConnectMode; // default connection to the plan above
  connectSmooth: number; // 0..1
  smoothSpan: boolean; // connection smoothness flows across all connected floors (else only between this floor and the next)
  nextN: number;
  points: PlanPoint[];
  segments: PlanSegment[];
  material: string; // default wall material (key of MATERIALS)
  objects: PlanObject[]; // stairs / elevators (floor plans only)
}

export interface Building {
  id: string;
  name: string;
  baseLength: number; // m, fixed after creation
  x: number; // m, world position of the base square's (0,0) corner
  y: number; // m
  ground: number; // index of the ground floor; floors below it are underground
  floors: Floor[]; // index 0 = lowest floor
  plans: StructurePlan[];
  topPlanId: string | null; // plan at the very top of the building (roof level), no walls of its own
  interiorPlans: StructurePlan[]; // floor plans: internal walls, doors, stairs, elevators
  divLen: number; // default wall division length, m
  openingShapes: OpeningShape[]; // openings and niches
  balconyShapes: BalconyShape[];
  placements: Placement[];
}

export type ProjectKind = 'building' | 'site';
export interface SiteItem { id: string; projectId: string; x: number; y: number }

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  created: number;
  updated: number;
  buildings: Building[]; // building project: exactly one
  items: SiteItem[]; // site project: placed building projects
  textures: Texture[];
  designs: Design[]; // imported 3D designs
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const totalHeight = (b: Building) => b.floors.reduce((s, f) => s + f.height, 0);
/** Height of the bottom of floor i above the lowest floor's bottom. */
export const floorBase = (b: Building, i: number) => b.floors.slice(0, i).reduce((s, f) => s + f.height, 0);
/** World elevation of the bottom of floor i (0 = ground level). */
export const elevation = (b: Building, i: number) => floorBase(b, i) - floorBase(b, b.ground);

/** Main floors are numbered 0, 1, 2 …; subfloors after a main floor are 5.1, 5.2 … */
export function floorLabel(b: Building, i: number): string {
  let main = -1, sub = 0;
  for (let k = 0; k <= i && k < b.floors.length; k++) {
    if (b.floors[k].sub && main >= 0) sub++; else { main++; sub = 0; }
  }
  return sub ? `${main}.${sub}` : `${main}`;
}
/** Index of the main floor a floor belongs to (itself, or the main floor below a subfloor). */
export function mainFloorIndex(b: Building, i: number): number {
  while (i > 0 && b.floors[i].sub) i--;
  return i;
}
/** Index of the next main floor above floor i (or floors.length). */
export function nextMainFloor(b: Building, i: number): number {
  let k = i + 1;
  while (k < b.floors.length && b.floors[k].sub) k++;
  return k;
}

export function newPlan(name: string, floorIds: string[] = []): StructurePlan {
  return {
    id: uid(), name, floorIds, wallThickness: 0.3, floorThickness: 0.25, ceilingThickness: 0.15, floorEnabled: true,
    smooth: 0, connect: 'straight', connectSmooth: 0, smoothSpan: true,
    nextN: 1, points: [], segments: [], material: 'concrete', objects: [],
  };
}

export interface BuildingSpec { name: string; baseLength: number; floors: number; floorHeight: number; ground: number; x: number; y: number }

export function createBuilding(s: BuildingSpec): Building {
  const fl: Floor[] = Array.from({ length: s.floors }, () => ({ id: uid(), height: s.floorHeight }));
  const plan = newPlan('Plan 1', fl.map(f => f.id));
  return {
    id: uid(), name: s.name, baseLength: s.baseLength, x: s.x, y: s.y, ground: s.ground, floors: fl, plans: [plan], topPlanId: null,
    interiorPlans: [], divLen: 3, openingShapes: defaultOpeningShapes(), balconyShapes: defaultBalconyShapes(), placements: [],
  };
}

const rect = (x0: number, y0: number, x1: number, y1: number): WinPoint[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const circle = (n = 8): WinPoint[] => Array.from({ length: n }, (_, k) => ({ x: 0.5 + 0.5 * Math.cos((k / n) * 2 * Math.PI), y: 0.5 + 0.5 * Math.sin((k / n) * 2 * Math.PI), s: 1 }));
const arch = (spring: number): WinPoint[] => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: spring, s: 1 }, { x: 0.5, y: 1, s: 1 }, { x: 0, y: spring, s: 1 }];

export function defaultOpeningShapes(): OpeningShape[] {
  const o = (name: string, outline: WinPoint[], w: number, h: number, anchor: 'center' | 'bottom'): OpeningShape =>
    ({ id: uid(), name, kind: 'opening', outlines: [outline], smooth: 0, w, h, anchor });
  return [
    o('Window', rect(0, 0, 1, 1), 1.2, 1.5, 'center'),
    o('Door', rect(0, 0, 1, 1), 1.0, 2.2, 'bottom'),
    o('Arched window', arch(0.72), 1.1, 1.9, 'center'),
    o('Arch', arch(0.7), 1.6, 2.8, 'bottom'),
    o('Round window', circle(), 1.0, 1.0, 'center'),
    {
      id: uid(), name: 'Niche', kind: 'niche', outlines: [arch(0.72)], smooth: 0, w: 0.9, h: 1.9, anchor: 'bottom', depth: 0.2,
      side: [{ x: 1, y: 0 }, { x: 1, y: 0.72, s: 1 }, { x: 0, y: 1 }], // full depth, rounding off at the top (half dome)
      bottom: [{ x: 0, y: 0 }, { x: 0.5, y: 1, s: 1 }, { x: 1, y: 0 }], // semicircular in plan
    },
  ];
}
export const defaultBalconyShapes = (): BalconyShape[] => [
  { id: uid(), name: 'Balcony', outline: rect(0, 0, 1, 1), smooth: 0, w: 2.4, d: 1.1, thickness: 0.2, railing: true },
  { id: uid(), name: 'Round balcony', outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.4, s: 1 }, { x: 0.5, y: 1, s: 1 }, { x: 0, y: 0.4, s: 1 }], smooth: 0, w: 2.4, d: 1.2, thickness: 0.2, railing: true },
];

export function createProject(name: string, first: BuildingSpec): Project {
  return { id: uid(), name, kind: 'building', created: Date.now(), updated: Date.now(), buildings: [createBuilding(first)], items: [], textures: [], designs: [] };
}
export function createSite(name: string): Project {
  return { id: uid(), name, kind: 'site', created: Date.now(), updated: Date.now(), buildings: [], items: [], textures: [], designs: [] };
}

export const newInteriorPlan = (name: string): StructurePlan => ({ ...newPlan(name), wallThickness: 0.15, material: 'brick', floorEnabled: false });

/** Plan that applies to a floor (a floor belongs to at most one plan). */
export const planForFloor = (b: Building, floorId: string) => b.plans.find(pl => pl.floorIds.includes(floorId));

/**
 * Division borders of a wall of length L (m), as distances from its start. Full divisions of
 * length len fill the middle; if they don't fit exactly, the two end divisions share the rest
 * (each a little shorter than len).
 */
export function divisionBorders(L: number, len: number): number[] {
  if (!(len > 0) || L <= len + 1e-6) return [0, L];
  const k = Math.floor(L / len + 1e-9), r = L - k * len;
  if (r < 1e-6) return Array.from({ length: k + 1 }, (_, i) => i * len);
  const edge = (len + r) / 2; // k-1 full divisions in the middle, two shorter ones at the ends
  const out = [0, edge];
  for (let i = 1; i < k; i++) out.push(edge + i * len);
  out[out.length - 1] = L - edge;
  out.push(L);
  return out;
}

/** Fill defaults for projects saved by older versions. */
export function normalize(p: Project): Project {
  const old = p as any;
  if (!p.buildings) {
    p.buildings = [{
      id: uid(), name: 'Building 1', baseLength: old.baseLength, x: 0, y: 0, ground: 0,
      floors: old.floors, plans: old.plans, topPlanId: old.topPlanId ?? null, interiorPlans: [],
    } as any];
    delete old.baseLength; delete old.floors; delete old.plans; delete old.topPlanId;
  }
  p.textures ??= [];
  p.items ??= [];
  p.kind ??= 'building';
  p.designs ??= [];
  for (const b of p.buildings) {
    const ob = b as any;
    b.ground ??= 0;
    b.interiorPlans ??= [];
    b.divLen ??= 3;
    b.balconyShapes ??= defaultBalconyShapes();
    b.placements ??= [];
    if (!b.openingShapes) {
      // windows from the window-planner version become openings (fixed size)
      b.openingShapes = defaultOpeningShapes();
      const map = new Map<string, string>();
      for (const w of ob.windowShapes ?? []) {
        const outlines: WinPoint[][] = w.outlines ?? (w.points ? [w.points] : []);
        if (!outlines.length) continue;
        const sh: OpeningShape = { id: uid(), name: w.name, kind: 'opening', outlines, smooth: w.smooth ?? 0, w: w.fixed?.w ?? 1.2, h: w.fixed?.h ?? 1.5, anchor: 'center' };
        b.openingShapes.push(sh);
        map.set(w.id, sh.id);
      }
      for (const [key, shapeId] of Object.entries(ob.windows ?? {}) as [string, string][]) {
        const [floorId, segId, div] = key.split('|');
        if (map.has(shapeId)) b.placements.push({ id: uid(), type: 'opening', floorId, segId, div: +div, shapeId: map.get(shapeId)!, dx: 0, dy: 0 });
      }
    }
    delete ob.windowShapes; delete ob.windows;
    for (const pl of [...b.plans, ...b.interiorPlans]) {
      pl.smooth ??= 0; pl.connect ??= 'straight'; pl.connectSmooth ??= 0; pl.smoothSpan ??= false;
      pl.material ??= 'concrete'; pl.objects ??= [];
      pl.ceilingThickness ??= Math.min(0.15, pl.floorThickness);
      if (pl.floorEnabled === false && b.plans.includes(pl)) {
        for (const f of b.floors) if (pl.floorIds.includes(f.id)) { f.hasFloor = false; f.hasCeiling = false; }
      }
      pl.floorEnabled = true;
      for (const s of pl.segments) {
        // old division counts -> a division length for that wall
        if (s.divisions && s.divisions > 1 && s.divLen == null) {
          const A = pl.points.find(q => q.id === s.a), B = pl.points.find(q => q.id === s.b);
          if (A && B) s.divLen = (Math.hypot(B.x - A.x, B.y - A.y) * b.baseLength) / s.divisions;
        }
        delete s.divisions;
      }
    }
  }
  return p;
}

/** Projects from the multi-building version: split into one building project each + a site. */
function splitMulti(list: Project[]): Project[] {
  const out: Project[] = [];
  for (const p of list) {
    if (p.kind === 'site' || p.buildings.length <= 1) { out.push(p); continue; }
    const site = createSite(p.name);
    for (const b of p.buildings) {
      const bp: Project = { ...createProject(`${p.name} – ${b.name}`, { name: b.name, baseLength: 1, floors: 1, floorHeight: 1, ground: 0, x: 0, y: 0 }), textures: p.textures };
      bp.buildings = [{ ...b, x: 0, y: 0 }];
      out.push(bp);
      site.items.push({ id: uid(), projectId: bp.id, x: b.x, y: b.y });
    }
    out.push(site);
  }
  return out;
}

// resolved segment properties
export const segKind = (s: PlanSegment): SegKind => s.kind ?? 'wall';
export const segSmooth = (pl: StructurePlan, s: PlanSegment) => s.smooth ?? pl.smooth;
export const segConnect = (pl: StructurePlan, s: PlanSegment): ConnectMode => s.connect ?? pl.connect;
export const segConnectSmooth = (pl: StructurePlan, s: PlanSegment) => s.connectSmooth ?? pl.connectSmooth;
export const segSmoothSpan = (pl: StructurePlan, s: PlanSegment) => s.smoothSpan ?? pl.smoothSpan;
export const segColT = (pl: StructurePlan, s: PlanSegment) => s.columnThickness ?? pl.wallThickness;
export const segMaterial = (pl: StructurePlan, s: PlanSegment) => s.material ?? pl.material;
export const segDivLen = (b: Building, s: PlanSegment) => s.divLen ?? b.divLen;

/** Floor label ("5", "5.1") -> floor index, or null. */
function labelToIndex(b: Building, t: string): number | null {
  t = t.trim();
  for (let i = 0; i < b.floors.length; i++) if (floorLabel(b, i) === t) return i;
  const m = t.match(/^(\d+)$/);
  if (m) { // a main floor number past the end -> clamp
    let last = -1;
    for (let i = 0; i < b.floors.length; i++) if (!b.floors[i].sub) last = i;
    return +m[1] > 0 ? last : 0;
  }
  return null;
}

/** "0-3, 5.1, 7-10" -> sorted floor indices. */
export function parseRanges(txt: string, b: Building): number[] | null {
  const out = new Set<number>();
  for (const part of txt.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    const a0 = labelToIndex(b, m[1]), c0 = m[2] ? labelToIndex(b, m[2]) : a0;
    if (a0 === null || c0 === null) return null;
    let a = a0, c = c0;
    if (a > c) [a, c] = [c, a];
    // a range ending on a main floor includes its subfloors
    if (m[2] && !b.floors[c].sub) while (c + 1 < b.floors.length && b.floors[c + 1].sub) c++;
    for (let i = Math.max(0, a); i <= Math.min(b.floors.length - 1, c); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
/** floor indices -> "0-3, 5.1, 7-10" */
export function formatRanges(b: Building, idx: number[]): string {
  const r: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    r.push(i === j ? floorLabel(b, idx[i]) : `${floorLabel(b, idx[i])}-${floorLabel(b, idx[j])}`);
    i = j + 1;
  }
  return r.join(', ');
}

// ---------- persistence (localStorage) ----------
const KEY = 'arch.projects.v1';

export function loadProjects(): Project[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as Project[];
    const list = splitMulti(raw.map(normalize));
    if (list.length !== raw.length) saveProjects(list);
    return list;
  } catch (e) { console.error(e); return []; }
}
export function saveProjects(list: Project[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { console.error('save failed', e); return false; }
}
export function saveProject(p: Project) {
  p.updated = Date.now();
  const list = loadProjects();
  const i = list.findIndex(x => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  if (!saveProjects(list)) window.dispatchEvent(new CustomEvent('arch-save-failed'));
}
export function deleteProject(id: string) {
  saveProjects(loadProjects().filter(p => p.id !== id));
}

// ---------- undo ----------
export class History {
  private stack: string[] = [];
  push(p: Project) {
    this.stack.push(JSON.stringify(p));
    if (this.stack.length > 200) this.stack.shift();
  }
  pop(): Project | null {
    const s = this.stack.pop();
    return s ? JSON.parse(s) : null;
  }
  clear() { this.stack = []; }
}

/** Balcony platforms sit at this fraction of the floor height by default (lower than the middle). */
export const BALCONY_AT = 0.3;

/**
 * Example: a two-storey villa with a columned porch (a balustraded terrace on top),
 * a big arched entrance, pilasters on the corners, a cornice under a hip roof,
 * a balcony, niches and a round window in the roof.
 */
export function sampleProject(): Project {
  const p = createProject('Villa', { name: 'Villa', baseLength: 24, floors: 3, floorHeight: 3.6, ground: 0, x: 0, y: 0 });
  const b = p.buildings[0];
  b.floors[0].height = 4.2; b.floors[2].height = 3.2;
  const [f0, f1, f2] = b.floors;
  let n = 1;
  const pt = (x: number, y: number) => ({ id: uid(), n: n++, x, y });
  const seg = (a: PlanPoint, c: PlanPoint, kind?: SegKind): PlanSegment => ({ id: uid(), a: a.id, b: c.id, ...(kind ? { kind } : {}) });
  const wallColor = '#e9dcc3';
  // house corners (counter-clockwise), the front wall split where the porch meets it
  const mk = (name: string, floorIds: string[], porchKind: SegKind | null) => {
    const pl = newPlan(name, floorIds);
    n = 1;
    const sw = pt(0.2, 0.3), A = pt(0.38, 0.3), B = pt(0.62, 0.3), se = pt(0.8, 0.3), ne = pt(0.8, 0.72), nw = pt(0.2, 0.72);
    pl.points = [sw, A, B, se, ne, nw];
    pl.segments = [seg(sw, A), seg(A, B), seg(B, se), seg(se, ne), seg(ne, nw), seg(nw, sw)];
    if (porchKind) {
      const C = pt(0.62, 0.17), D = pt(0.38, 0.17);
      pl.points.push(C, D);
      pl.segments.push(seg(B, C, porchKind), seg(C, D, porchKind), seg(D, A, porchKind));
    }
    pl.segments.forEach(s => { if (segKind(s) === 'wall') s.color = wallColor; });
    pl.nextN = n;
    pl.wallThickness = 0.4;
    return pl;
  };
  const g = mk('Ground floor', [f0.id], 'colonnade');
  // porch: Ionic columns (built-in design, detailed view)
  const ionic: Design = { id: uid(), name: 'Ionic column', category: 'column', format: 'builtin', builtin: 'ionic' };
  p.designs.push(ionic);
  g.segments.slice(6).forEach(s => { s.divLen = 1.9; s.color = '#efe9dd'; s.columnDesign = ionic.id; s.columnThickness = 0.62; });
  const up = mk('Upper floor', [f1.id], 'balustrade');
  const roof = mk('Roof storey', [f2.id], null);
  roof.connect = 'loft';
  roof.segments.forEach(s => (s.color = '#a95a40')); // terracotta roof
  const ridge = newPlan('Ridge');
  n = 1;
  ridge.points = [pt(0.36, 0.51), pt(0.64, 0.51)];
  ridge.segments = [seg(ridge.points[0], ridge.points[1])];
  b.plans = [g, up, roof, ridge];
  b.topPlanId = ridge.id;
  b.divLen = 2.8;
  f0.color = '#bdb5a6';

  const shape = (name: string) => b.openingShapes.find(s => s.name === name)!.id;
  const place = (type: PlacementType, floor: Floor, s: PlanSegment, div: number, extra: Partial<Placement> = {}) =>
    b.placements.push({ id: uid(), type, floorId: floor.id, segId: s.id, div, dx: 0, dy: 0, ...extra });
  const L = b.baseLength;
  const divCount = (pl: StructurePlan, s: PlanSegment) => {
    const a = pl.points.find(q => q.id === s.a)!, c = pl.points.find(q => q.id === s.b)!;
    return divisionBorders(Math.hypot(c.x - a.x, c.y - a.y) * L, segDivLen(b, s)).length - 1;
  };
  const walls = (pl: StructurePlan) => pl.segments.filter(s => segKind(s) === 'wall');
  // big arch entrance in the middle of the front wall (inside the porch)
  const front0 = g.segments[1];
  place('opening', f0, front0, Math.floor(divCount(g, front0) / 2), { shapeId: shape('Arch'), dy: 0 });
  b.openingShapes.find(s => s.name === 'Arch')!.w = 2.6;
  b.openingShapes.find(s => s.name === 'Arch')!.h = 3.6;
  // ground floor: arched windows, with niches on the sides of the porch; upper floor: windows
  for (const s of walls(g)) {
    if (s === front0) continue;
    for (let k = 0; k < divCount(g, s); k++) place('opening', f0, s, k, { shapeId: shape('Arched window') });
  }
  for (const s of walls(up)) {
    const nd = divCount(up, s);
    for (let k = 0; k < nd; k++) {
      if (s === up.segments[1] && k === Math.floor(nd / 2)) { place('opening', f1, s, k, { shapeId: shape('Door') }); continue; } // onto the terrace
      if (s === up.segments[3] && k === Math.floor(nd / 2)) { place('opening', f1, s, k, { shapeId: shape('Door') }); place('balcony', f1, s, k, { shapeId: b.balconyShapes[1].id, dy: 0.25 - f1.height * BALCONY_AT }); continue; } // moved down to the door's threshold
      place('opening', f1, s, k, { shapeId: shape('Window') });
    }
    // cornice along the top of the upper floor (where the roof starts)
    for (let k = 0; k < nd; k++) place('cornice', f1, s, k);
  }
  // niches either side of the entrance
  place('niche', f0, front0, 0, { shapeId: shape('Niche'), dy: 0.6 });
  place('niche', f0, front0, divCount(g, front0) - 1, { shapeId: shape('Niche'), dy: 0.6 });
  // pilasters on the house corners, both storeys (border 0 of every outer wall is a corner)
  for (const [pl, fl] of [[g, f0], [up, f1]] as const) {
    for (const s of [pl.segments[0], pl.segments[3], pl.segments[4], pl.segments[5]]) place('pilaster', fl, s, 0);
  }
  // round window in the roof (front slope)
  const roofFront = roof.segments[1];
  place('opening', f2, roofFront, Math.floor(divCount(roof, roofFront) / 2), { shapeId: shape('Round window'), dy: -0.2 });
  return p;
}
