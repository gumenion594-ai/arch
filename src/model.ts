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

export interface PlanSegment {
  id: string;
  a: string; // point id
  b: string; // point id
}

export interface StructurePlan {
  id: string;
  name: string;
  floorIds: string[]; // floors this plan applies to
  wallThickness: number; // m
  floorThickness: number; // m
  floorEnabled: boolean;
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
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const totalHeight = (p: Project) => p.floors.reduce((s, f) => s + f.height, 0);
export const floorBase = (p: Project, i: number) => p.floors.slice(0, i).reduce((s, f) => s + f.height, 0);

export function newPlan(name: string, floorIds: string[] = []): StructurePlan {
  return {
    id: uid(), name, floorIds, wallThickness: 0.3, floorThickness: 0.25, floorEnabled: true,
    nextN: 1, points: [], segments: [],
  };
}

export function createProject(name: string, baseLength: number, floors: number, floorHeight: number): Project {
  const fl: Floor[] = Array.from({ length: floors }, () => ({ id: uid(), height: floorHeight }));
  const plan = newPlan('Plan 1', fl.map(f => f.id));
  return { id: uid(), name, created: Date.now(), updated: Date.now(), baseLength, floors: fl, plans: [plan] };
}

/** Plan that applies to a floor (a floor belongs to at most one plan). */
export const planForFloor = (p: Project, floorId: string) => p.plans.find(pl => pl.floorIds.includes(floorId));

// ---------- persistence (localStorage) ----------
const KEY = 'arch.projects.v1';

export function loadProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function saveProjects(list: Project[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { console.error('save failed', e); }
}
export function saveProject(p: Project) {
  p.updated = Date.now();
  const list = loadProjects();
  const i = list.findIndex(x => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  saveProjects(list);
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
