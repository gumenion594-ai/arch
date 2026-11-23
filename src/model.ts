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

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  baseLength: number; // m, fixed after creation
  floors: Floor[]; // index 0 = ground floor
  plans: StructurePlan[];
  topPlanId: string | null; // plan at the very top of the building (roof level), no walls of its own
  textures: Texture[];
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const totalHeight = (p: Project) => p.floors.reduce((s, f) => s + f.height, 0);
export const floorBase = (p: Project, i: number) => p.floors.slice(0, i).reduce((s, f) => s + f.height, 0);

export function newPlan(name: string, floorIds: string[] = []): StructurePlan {
  return {
    id: uid(), name, floorIds, wallThickness: 0.3, floorThickness: 0.25, floorEnabled: true,
    smooth: 0, connect: 'straight', connectSmooth: 0,
    nextN: 1, points: [], segments: [],
  };
}

export function createProject(name: string, baseLength: number, floors: number, floorHeight: number): Project {
  const fl: Floor[] = Array.from({ length: floors }, () => ({ id: uid(), height: floorHeight }));
  const plan = newPlan('Plan 1', fl.map(f => f.id));
  return { id: uid(), name, created: Date.now(), updated: Date.now(), baseLength, floors: fl, plans: [plan], topPlanId: null, textures: [] };
}

/** Plan that applies to a floor (a floor belongs to at most one plan). */
export const planForFloor = (p: Project, floorId: string) => p.plans.find(pl => pl.floorIds.includes(floorId));

/** Fill defaults for projects saved by older versions. */
export function normalize(p: Project): Project {
  p.topPlanId ??= null;
  p.textures ??= [];
  for (const pl of p.plans) {
    pl.smooth ??= 0; pl.connect ??= 'straight'; pl.connectSmooth ??= 0;
  }
  return p;
}

// resolved segment properties
export const segKind = (s: PlanSegment): SegKind => s.kind ?? 'wall';
export const segSmooth = (pl: StructurePlan, s: PlanSegment) => s.smooth ?? pl.smooth;
export const segConnect = (pl: StructurePlan, s: PlanSegment): ConnectMode => s.connect ?? pl.connect;
export const segConnectSmooth = (pl: StructurePlan, s: PlanSegment) => s.connectSmooth ?? pl.connectSmooth;
export const segColT = (pl: StructurePlan, s: PlanSegment) => s.columnThickness ?? pl.wallThickness;

/** "1-5, 8, 10-12" -> sorted 1-based floor numbers (clamped to 1..n). */
export function parseRanges(txt: string, n: number): number[] | null {
  const out = new Set<number>();
  for (const part of txt.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) return null;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
/** [1,2,3,5,7,8] -> "1-3, 5, 7-8" */
export function formatRanges(nums: number[]): string {
  const r: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    r.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
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
