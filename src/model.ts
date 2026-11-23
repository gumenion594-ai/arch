// Data model, persistence and undo history.

export const MAX_M = 10000; // 10 km cap for every length
export const MAX_AREA = MAX_M * MAX_M;

export interface Floor {
  id: string;
  height: number; // m
}

export interface PlanPoint {
  id: string;
  n: number; // order in which it was placed
  x: number; // 0..1 inside building area
  y: number; // 0..1
}

export type SegKind = 'wall' | 'colonnade' | 'open';
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
}

export interface Texture { id: string; name: string; data: string; w: number; h: number; }

export interface StructurePlan {
  id: string;
  name: string;
  floorIds: string[]; // floors this plan applies to
  wallThickness: number; // m
  floorThickness: number; // m
  floorEnabled: boolean;
  smooth: number; // default plan smoothness 0..1
  connect: ConnectMode; // default connection to the plan above
  connectSmooth: number; // 0..1
  nextN: number;
  points: PlanPoint[];
  segments: PlanSegment[];
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
}

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  buildings: Building[];
  textures: Texture[];
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const totalHeight = (b: Building) => b.floors.reduce((s, f) => s + f.height, 0);
/** Height of the bottom of floor i above the lowest floor's bottom. */
export const floorBase = (b: Building, i: number) => b.floors.slice(0, i).reduce((s, f) => s + f.height, 0);
/** World elevation of the bottom of floor i (0 = ground level). */
export const elevation = (b: Building, i: number) => floorBase(b, i) - floorBase(b, b.ground);
/** Floor label: G = ground, 1, 2 … above, B1, B2 … underground. */
export const floorLabel = (b: Building, i: number) => (i === b.ground ? 'G' : i > b.ground ? `${i - b.ground}` : `B${b.ground - i}`);

export function newPlan(name: string, floorIds: string[] = []): StructurePlan {
  return {
    id: uid(), name, floorIds, wallThickness: 0.3, floorThickness: 0.25, floorEnabled: true,
    smooth: 0, connect: 'straight', connectSmooth: 0,
    nextN: 1, points: [], segments: [],
  };
}

export interface BuildingSpec { name: string; baseLength: number; floors: number; floorHeight: number; ground: number; x: number; y: number }

export function createBuilding(s: BuildingSpec): Building {
  const fl: Floor[] = Array.from({ length: s.floors }, () => ({ id: uid(), height: s.floorHeight }));
  const plan = newPlan('Plan 1', fl.map(f => f.id));
  return { id: uid(), name: s.name, baseLength: s.baseLength, x: s.x, y: s.y, ground: s.ground, floors: fl, plans: [plan], topPlanId: null };
}

export function createProject(name: string, first: BuildingSpec): Project {
  return { id: uid(), name, created: Date.now(), updated: Date.now(), buildings: [createBuilding(first)], textures: [] };
}

/** Plan that applies to a floor (a floor belongs to at most one plan). */
export const planForFloor = (b: Building, floorId: string) => b.plans.find(pl => pl.floorIds.includes(floorId));

/** Fill defaults for projects saved by older versions. */
export function normalize(p: Project): Project {
  const old = p as any;
  if (!p.buildings) {
    // v1/v2 projects had a single building stored directly on the project
    p.buildings = [{
      id: uid(), name: 'Building 1', baseLength: old.baseLength, x: 0, y: 0, ground: 0,
      floors: old.floors, plans: old.plans, topPlanId: old.topPlanId ?? null,
    }];
    delete old.baseLength; delete old.floors; delete old.plans; delete old.topPlanId;
  }
  p.textures ??= [];
  for (const b of p.buildings) {
    b.ground ??= 0;
    for (const pl of b.plans) { pl.smooth ??= 0; pl.connect ??= 'straight'; pl.connectSmooth ??= 0; }
  }
  return p;
}

// resolved segment properties
export const segKind = (s: PlanSegment): SegKind => s.kind ?? 'wall';
export const segSmooth = (pl: StructurePlan, s: PlanSegment) => s.smooth ?? pl.smooth;
export const segConnect = (pl: StructurePlan, s: PlanSegment): ConnectMode => s.connect ?? pl.connect;
export const segConnectSmooth = (pl: StructurePlan, s: PlanSegment) => s.connectSmooth ?? pl.connectSmooth;
export const segColT = (pl: StructurePlan, s: PlanSegment) => s.columnThickness ?? pl.wallThickness;

/** Floor label ("B2", "G", "5") -> floor index, or null. */
function labelToIndex(b: Building, t: string): number | null {
  t = t.trim().toUpperCase();
  if (t === 'G' || t === '0') return b.ground;
  let m = t.match(/^B(\d+)$/);
  if (m) return b.ground - +m[1];
  m = t.match(/^(\d+)$/);
  return m ? b.ground + +m[1] : null;
}

/** "B2-G, 3, 5-10" -> sorted floor indices (clamped to existing floors). */
export function parseRanges(txt: string, b: Building): number[] | null {
  const out = new Set<number>();
  for (const part of txt.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(B\d+|G|\d+)\s*(?:-\s*(B\d+|G|\d+))?$/i);
    if (!m) return null;
    let a = labelToIndex(b, m[1])!, c = m[2] ? labelToIndex(b, m[2])! : a;
    if (a > c) [a, c] = [c, a];
    for (let i = Math.max(0, a); i <= Math.min(b.floors.length - 1, c); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
/** floor indices -> "B2-G, 3, 5-10" */
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
  try { return (JSON.parse(localStorage.getItem(KEY) || '[]') as Project[]).map(normalize); } catch { return []; }
}
export function saveProjects(list: Project[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { console.error('save failed', e); return false; }
}
export function saveProject(p: Project) {
  p.updated = Date.now();
  const list = loadProjects();
  const i = list.findIndex(x => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  if (!saveProjects(list)) alert('Could not save: browser storage is full (textures take the most space).');
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
