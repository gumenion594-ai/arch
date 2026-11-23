// Data model, persistence and undo history.

export const MAX_M = 10000; // 10 km cap for every length
export const MAX_AREA = MAX_M * MAX_M;

export interface Floor {
  id: string;
  height: number; // m
  hasFloor?: boolean; // floor slab at the bottom of this floor (default on)
  hasCeiling?: boolean; // ceiling slab at the top of this floor (default on)
}

export interface PlanPoint {
  id: string;
  n: number; // order in which it was placed
  x: number; // 0..1 inside building area
  y: number; // 0..1
}

export type SegKind = 'wall' | 'colonnade' | 'open' | 'door'; // 'door' only in floor (interior) plans
export type ConnectMode = 'straight' | 'loft';

export interface PlanSegment {
  id: string;
  a: string; // point id
  b: string; // point id
  kind?: SegKind; // default 'wall'
  divisions?: number; // default 1 (no columns); columns sit between divisions
  columnThickness?: number | null; // null = plan wall thickness
  smooth?: number | null; // 0..1, null = plan default
  connect?: ConnectMode | null; // null = plan default
  connectSmooth?: number | null; // 0..1, null = plan default
  texture?: string | null; // texture id
  material?: string | null; // null = plan material
}

/** Stairs / elevator placed in a floor plan. x, y = centre (0..1), w × d in metres, rot in degrees. */
export interface PlanObject { id: string; type: 'stairs' | 'elevator'; x: number; y: number; w: number; d: number; rot: number }

/** Window outline drawn on a 0..1 grid: x across a wall division, y up the floor height. */
/** One closed outline of a window; s = this point's smoothness (null = the shape's). */
export interface WinPoint { x: number; y: number; s?: number | null }
export interface WindowShape {
  id: string; name: string;
  outlines: WinPoint[][]; // several openings may share one wall division
  smooth: number; // default smoothness 0..1
  /** Fixed size in metres: the outline fills a w × h box, centred in the division, sill metres above the floor. */
  fixed?: { w: number; h: number; sill: number } | null;
  points?: WinPoint[]; // (older projects: single outline)
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
  windowShapes: WindowShape[];
  windows: Record<string, string>; // "floorId|segmentId|division" -> window shape id
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
}

export const windowKey = (floorId: string, segId: string, div: number) => `${floorId}|${segId}|${div}`;

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const totalHeight = (b: Building) => b.floors.reduce((s, f) => s + f.height, 0);
/** Height of the bottom of floor i above the lowest floor's bottom. */
export const floorBase = (b: Building, i: number) => b.floors.slice(0, i).reduce((s, f) => s + f.height, 0);
/** World elevation of the bottom of floor i (0 = ground level). */
export const elevation = (b: Building, i: number) => floorBase(b, i) - floorBase(b, b.ground);
/** Floor label: G = ground, 1, 2 … above, B1, B2 … underground. */
/** Floors are numbered 0 (lowest) to n-1; underground ones are only shaded differently. */
export const floorLabel = (_b: Building, i: number) => `${i}`;

export function newPlan(name: string, floorIds: string[] = []): StructurePlan {
  return {
    id: uid(), name, floorIds, wallThickness: 0.3, floorThickness: 0.25, ceilingThickness: 0.15, floorEnabled: true,
    smooth: 0, connect: 'straight', connectSmooth: 0,
    nextN: 1, points: [], segments: [], material: 'concrete', objects: [],
  };
}

export interface BuildingSpec { name: string; baseLength: number; floors: number; floorHeight: number; ground: number; x: number; y: number }

export function createBuilding(s: BuildingSpec): Building {
  const fl: Floor[] = Array.from({ length: s.floors }, () => ({ id: uid(), height: s.floorHeight }));
  const plan = newPlan('Plan 1', fl.map(f => f.id));
  return {
    id: uid(), name: s.name, baseLength: s.baseLength, x: s.x, y: s.y, ground: s.ground, floors: fl, plans: [plan], topPlanId: null,
    interiorPlans: [], windowShapes: defaultWindowShapes(), windows: {},
  };
}

export function defaultWindowShapes(): WindowShape[] {
  return [
    { id: uid(), name: 'Window', smooth: 0, outlines: [[{ x: 0.25, y: 0.3 }, { x: 0.75, y: 0.3 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.8 }]] },
    { id: uid(), name: 'Door', smooth: 0, outlines: [[{ x: 0.3, y: 0 }, { x: 0.7, y: 0 }, { x: 0.7, y: 0.75 }, { x: 0.3, y: 0.75 }]] },
    // round-topped: sharp bottom corners, smooth top
    { id: uid(), name: 'Arched window', smooth: 0, outlines: [[{ x: 0.3, y: 0.25 }, { x: 0.7, y: 0.25 }, { x: 0.7, y: 0.6, s: 1 }, { x: 0.5, y: 0.82, s: 1 }, { x: 0.3, y: 0.6, s: 1 }]] },
  ];
}

export function createProject(name: string, first: BuildingSpec): Project {
  return { id: uid(), name, kind: 'building', created: Date.now(), updated: Date.now(), buildings: [createBuilding(first)], items: [], textures: [] };
}
export function createSite(name: string): Project {
  return { id: uid(), name, kind: 'site', created: Date.now(), updated: Date.now(), buildings: [], items: [], textures: [] };
}

export const newInteriorPlan = (name: string): StructurePlan => ({ ...newPlan(name), wallThickness: 0.15, material: 'brick', floorEnabled: false });

/** Plan that applies to a floor (a floor belongs to at most one plan). */
export const planForFloor = (b: Building, floorId: string) => b.plans.find(pl => pl.floorIds.includes(floorId));

/** Fill defaults for projects saved by older versions. */
export function normalize(p: Project): Project {
  const old = p as any;
  if (!p.buildings) {
    // v1/v2 projects had a single building stored directly on the project
    p.buildings = [{
      id: uid(), name: 'Building 1', baseLength: old.baseLength, x: 0, y: 0, ground: 0,
      floors: old.floors, plans: old.plans, topPlanId: old.topPlanId ?? null, interiorPlans: [], windowShapes: [], windows: {},
    }];
    delete old.baseLength; delete old.floors; delete old.plans; delete old.topPlanId;
  }
  p.textures ??= [];
  p.items ??= [];
  p.kind ??= 'building';
  for (const b of p.buildings) {
    b.ground ??= 0;
    b.interiorPlans ??= [];
    if (!b.windowShapes?.length) b.windowShapes = defaultWindowShapes();
    for (const w of b.windowShapes) {
      if (!w.outlines) w.outlines = w.points?.length ? [w.points] : [];
      delete w.points;
      w.smooth ??= 0;
    }
    b.windows ??= {};
    for (const pl of [...b.plans, ...b.interiorPlans]) {
      pl.smooth ??= 0; pl.connect ??= 'straight'; pl.connectSmooth ??= 0;
      pl.material ??= 'concrete'; pl.objects ??= [];
      pl.ceilingThickness ??= Math.min(0.15, pl.floorThickness);
      if (pl.floorEnabled === false && b.plans.includes(pl)) {
        // old plan-level "no floor slab" -> per-floor switches
        for (const f of b.floors) if (pl.floorIds.includes(f.id)) { f.hasFloor = false; f.hasCeiling = false; }
      }
      pl.floorEnabled = true;
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
export const segColT = (pl: StructurePlan, s: PlanSegment) => s.columnThickness ?? pl.wallThickness;
export const segMaterial = (pl: StructurePlan, s: PlanSegment) => s.material ?? pl.material;

/** Floor label ("B2", "G", "5") -> floor index, or null. */
function labelToIndex(_b: Building, t: string): number | null {
  const m = t.trim().match(/^(\d+)$/);
  return m ? +m[1] : null;
}

/** "0-3, 5, 7-10" -> sorted floor indices (clamped to existing floors). */
export function parseRanges(txt: string, b: Building): number[] | null {
  const out = new Set<number>();
  for (const part of txt.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) return null;
    let a = labelToIndex(b, m[1])!, c = m[2] ? labelToIndex(b, m[2])! : a;
    if (a > c) [a, c] = [c, a];
    for (let i = Math.max(0, a); i <= Math.min(b.floors.length - 1, c); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
/** floor indices -> "0-3, 5, 7-10" */
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
  } catch { return []; }
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

/** Example building for an empty project list: four storeys, a colonnade, windows and a hip roof. */
export function sampleProject(): Project {
  const p = createProject('Example house', { name: 'Example house', baseLength: 20, floors: 5, floorHeight: 3, ground: 1, x: 0, y: 0 });
  const b = p.buildings[0];
  const pt = (x: number, y: number, n: number) => ({ id: uid(), n, x, y });
  const loop = (pl: StructurePlan, coords: [number, number][]) => {
    pl.points = coords.map(([x, y], i) => pt(x, y, i + 1));
    pl.segments = pl.points.map((q, i) => ({ id: uid(), a: q.id, b: pl.points[(i + 1) % pl.points.length].id }));
    pl.nextN = coords.length + 1;
  };
  const base = b.plans[0];
  base.name = 'Main';
  loop(base, [[0.15, 0.2], [0.85, 0.2], [0.85, 0.8], [0.15, 0.8]]);
  base.floorIds = b.floors.slice(0, 4).map(f => f.id);
  base.segments[0].kind = 'colonnade'; base.segments[0].divisions = 6; // front colonnade
  base.segments.slice(1).forEach(s => (s.divisions = 4));
  const roof = newPlan('Roof storey', [b.floors[4].id]);
  loop(roof, [[0.15, 0.2], [0.85, 0.2], [0.85, 0.8], [0.15, 0.8]]);
  roof.connect = 'loft';
  const ridge = newPlan('Ridge');
  ridge.points = [pt(0.3, 0.5, 1), pt(0.7, 0.5, 2)];
  ridge.segments = [{ id: uid(), a: ridge.points[0].id, b: ridge.points[1].id }];
  b.plans.push(roof, ridge);
  b.topPlanId = ridge.id;
  b.floors[4].height = 3.5;
  const win = b.windowShapes[0];
  for (const f of b.floors.slice(1, 4)) for (const s of base.segments.slice(1)) for (let k = 0; k < 4; k++) b.windows[windowKey(f.id, s.id, k)] = win.id;
  return p;
}
