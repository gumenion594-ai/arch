// Structure planner: 2D canvas editor for a structure plan (external walls).
import { PlanObject, PlanPoint, PlanSegment, StructurePlan, clamp, divisionBorders, segColT, segKind, uid } from './model';
import { columnPositions } from './build3d';
import { V2, alignMiddle, distToSeg, enclosedFaces, enclosedFacesSegs, planValid, pointInPoly, polyAt, polyLength, polyParams, sampleSeg } from './geometry';

export type Tool = 'draw' | 'select' | 'move' | 'stairs' | 'elevator';

export interface PlannerHost {
  getPlan(): StructurePlan | null;
  getGhost(): StructurePlan | null; // plan below (or external walls), drawn faintly for reference
  /** Floor planner: areas enclosed by the external walls; points and walls must stay inside. null = anywhere. */
  allowed?(): V2[][] | null;
  /** Lines from points of the plan below to the points they connect to here (lofted walls). */
  links?(): [V2, V2][];
  baseLength(): number;
  divLen(s: PlanSegment): number; // division length of a wall
  begin(): void; // snapshot for undo, before a change
  commit(): void; // persist + refresh UI after a change
  toast(msg: string): void;
  selectionChanged(): void;
}

const HIT = 9; // px

export class Planner {
  canvas = document.createElement('canvas');
  ctx = this.canvas.getContext('2d')!;
  tool: Tool = 'draw';
  head: string | null = null; // last point of the chain being drawn
  selPoints = new Set<string>();
  selSegs = new Set<string>();
  selObj: string | null = null;
  private objDrag: { id: string; dx: number; dy: number; began: boolean } | null = null;
  private moveAll: { x: number; y: number; began: boolean; orig: Map<string, V2> } | null = null;
  private hover: V2 | null = null;
  private drag: { id: string; moved: boolean; began: boolean } | null = null;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private h: PlannerHost) {
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.canvas.addEventListener('mousedown', e => this.down(e));
    this.canvas.addEventListener('dblclick', e => this.dbl(e));
    window.addEventListener('mousemove', this.move);
    this.canvas.addEventListener('mouseenter', () => (this.canvas.style.cursor = this.tool === 'move' ? 'move' : 'crosshair'));
    window.addEventListener('mouseup', this.up);
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
  }

  dispose() {
    this.ro.disconnect();
    window.removeEventListener('mousemove', this.move);
    window.removeEventListener('mouseup', this.up);
    this.canvas.remove();
  }

  // ---- coordinate mapping ----
  private get box() {
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight;
    const s = Math.max(50, Math.min(w, hh) - 80);
    return { x0: (w - s) / 2, y0: (hh - s) / 2, s };
  }
  private toScreen(p: V2) { const b = this.box; return { x: b.x0 + p.x * b.s, y: b.y0 + (1 - p.y) * b.s }; }
  private toPlan(e: MouseEvent): V2 {
    const r = this.canvas.getBoundingClientRect(), b = this.box;
    return { x: (e.clientX - r.left - b.x0) / b.s, y: 1 - (e.clientY - r.top - b.y0) / b.s };
  }
  private inside(p: V2) { return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1; }

  private hitPoint(plan: StructurePlan, p: V2): PlanPoint | null {
    const tol = HIT / this.box.s;
    let best: PlanPoint | null = null, bd = tol;
    for (const pt of plan.points) {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d <= bd) { bd = d; best = pt; }
    }
    return best;
  }
  private hitSeg(plan: StructurePlan, p: V2) {
    const tol = HIT / this.box.s;
    let best: PlanSegment | null = null, bd = tol;
    for (const s of plan.segments) {
      const sp = sampleSeg(plan, s);
      for (let i = 0; i + 1 < sp.length; i++) {
        const d = distToSeg(p, sp[i], sp[i + 1]);
        if (d <= bd) { bd = d; best = s; }
      }
    }
    return best;
  }

  /** Remove selections pointing at things that no longer exist (e.g. after undo). */
  prune() {
    const plan = this.h.getPlan();
    const pids = new Set(plan?.points.map(p => p.id));
    const sids = new Set(plan?.segments.map(s => s.id));
    for (const id of [...this.selPoints]) if (!pids.has(id)) this.selPoints.delete(id);
    for (const id of [...this.selSegs]) if (!sids.has(id)) this.selSegs.delete(id);
    if (this.head && !pids.has(this.head)) this.head = null;
    if (this.selObj && !plan?.objects.some(o => o.id === this.selObj)) this.selObj = null;
  }

  clearSelection() { this.selPoints.clear(); this.selSegs.clear(); this.selObj = null; this.h.selectionChanged(); this.draw(); }

  // ---- constraints (floor planner: stay inside the external walls) ----
  private okPoint(p: V2): boolean {
    if (!this.inside(p)) return false;
    const faces = this.h.allowed?.();
    return !faces || faces.some(f => pointInPoly(p, f));
  }
  private okSeg(a: V2, b: V2): boolean {
    const faces = this.h.allowed?.();
    if (!faces) return true;
    return faces.some(f => {
      for (let k = 1; k < 10; k++) if (!pointInPoly({ x: a.x + ((b.x - a.x) * k) / 10, y: a.y + ((b.y - a.y) * k) / 10 }, f)) return false;
      return true;
    });
  }
  private okPointWithWalls(plan: StructurePlan, id: string, np: V2): boolean {
    if (!this.okPoint(np)) return false;
    for (const sg of plan.segments) {
      if (sg.a !== id && sg.b !== id) continue;
      const other = plan.points.find(q => q.id === (sg.a === id ? sg.b : sg.a))!;
      if (!this.okSeg(np, other)) return false;
    }
    return true;
  }

  /**
   * Move / scale everything at once. fn maps a point to its new position.
   * Rejected (returns false) if anything would leave the allowed area.
   */
  transformAll(fn: (p: V2) => V2, extra?: () => void): boolean {
    const plan = this.h.getPlan();
    if (!plan) return false;
    const pts = plan.points.map(p => fn(p)), objs = plan.objects.map(o => fn(o));
    if (![...pts, ...objs].every(p => p.x >= -1e-9 && p.x <= 1 + 1e-9 && p.y >= -1e-9 && p.y <= 1 + 1e-9)) return false;
    if (this.h.allowed?.() && !pts.every(p => this.okPoint(p))) return false;
    this.h.begin();
    plan.points.forEach((p, i) => { p.x = clamp(pts[i].x, 0, 1); p.y = clamp(pts[i].y, 0, 1); });
    plan.objects.forEach((o, i) => { o.x = objs[i].x; o.y = objs[i].y; });
    extra?.();
    this.h.commit();
    this.draw();
    return true;
  }

  // ---- stairs / elevators ----
  private objCorners(o: PlanObject): V2[] {
    const L = this.h.baseLength(), r = (o.rot * Math.PI) / 180;
    const hw = o.w / 2 / L, hd = o.d / 2 / L;
    // rotation in plan space: world rotY(rot) maps local (x, z) -> plan (x, -z)
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => ({
      x: o.x + x * Math.cos(r) + z * Math.sin(r),
      y: o.y - (-x * Math.sin(r) + z * Math.cos(r)),
    }));
  }
  private hitObj(plan: StructurePlan, p: V2): PlanObject | null {
    for (let k = plan.objects.length - 1; k >= 0; k--) if (pointInPoly(p, this.objCorners(plan.objects[k]))) return plan.objects[k];
    return null;
  }
  endChain() { this.head = null; this.h.selectionChanged(); this.draw(); }

  // ---- mouse ----
  private down(e: MouseEvent) {
    const plan = this.h.getPlan();
    if (!plan || e.button !== 0) return;
    const p = this.toPlan(e);
    const pt = this.hitPoint(plan, p);

    if (this.tool === 'draw') {
      if (pt) {
        if (this.head && this.head !== pt.id && !plan.segments.some(s => (s.a === this.head && s.b === pt.id) || (s.b === this.head && s.a === pt.id))) {
          if (!planValid(plan, undefined, [[this.head, pt.id]])) return this.h.toast('That wall would cross an existing wall');
          if (!this.okSeg(plan.points.find(q => q.id === this.head)!, pt)) return this.h.toast('Internal walls must stay inside the external walls');
          this.h.begin();
          plan.segments.push({ id: uid(), a: this.head, b: pt.id });
          this.h.commit();
        }
        this.head = pt.id;
        this.draw();
        return;
      }
      if (!this.inside(p)) return this.h.toast('Points must be inside the building area');
      if (!this.okPoint(p)) return this.h.toast('Internal walls can only be drawn inside areas enclosed by external walls');
      if (this.head && !this.okSeg(plan.points.find(q => q.id === this.head)!, p)) return this.h.toast('Internal walls must stay inside the external walls');
      const np: PlanPoint = { id: uid(), n: plan.nextN, x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
      const test: StructurePlan = { ...plan, points: [...plan.points, np] };
      if (!planValid(test, undefined, this.head ? [[this.head, np.id]] : [])) return this.h.toast('That wall would cross an existing wall');
      this.h.begin();
      plan.nextN++;
      plan.points.push(np);
      if (this.head) plan.segments.push({ id: uid(), a: this.head, b: np.id });
      this.head = np.id;
      this.h.commit();
      this.draw();
      return;
    }

    if (this.tool === 'move') {
      this.moveAll = { x: p.x, y: p.y, began: false, orig: new Map([...plan.points, ...plan.objects].map(q => [q.id, { x: q.x, y: q.y }])) };
      return;
    }
    if (this.tool === 'stairs' || this.tool === 'elevator') {
      if (!this.okPoint(p)) return this.h.toast('Place it inside the building (inside the external walls)');
      this.h.begin();
      const o: PlanObject = this.tool === 'stairs'
        ? { id: uid(), type: 'stairs', x: p.x, y: p.y, w: 1.2, d: 3.6, rot: 0 }
        : { id: uid(), type: 'elevator', x: p.x, y: p.y, w: 2, d: 2, rot: 0 };
      plan.objects.push(o);
      this.selPoints.clear(); this.selSegs.clear(); this.selObj = o.id;
      this.h.commit(); this.h.selectionChanged(); this.draw();
      return;
    }

    // select tool
    const ob = !pt ? this.hitObj(plan, p) : null;
    this.selObj = null;
    if (ob) {
      this.selPoints.clear(); this.selSegs.clear(); this.selObj = ob.id;
      this.objDrag = { id: ob.id, dx: ob.x - p.x, dy: ob.y - p.y, began: false };
    } else if (pt) {
      if (e.shiftKey) {
        this.selPoints.has(pt.id) ? this.selPoints.delete(pt.id) : this.selPoints.add(pt.id);
      } else if (!this.selPoints.has(pt.id)) {
        this.selPoints.clear(); this.selSegs.clear(); this.selPoints.add(pt.id);
      }
      this.drag = { id: pt.id, moved: false, began: false };
    } else {
      const s = this.hitSeg(plan, p);
      if (s) {
        if (e.shiftKey) this.selSegs.has(s.id) ? this.selSegs.delete(s.id) : this.selSegs.add(s.id);
        else { this.selPoints.clear(); this.selSegs.clear(); this.selSegs.add(s.id); }
      } else if (!e.shiftKey) { this.selPoints.clear(); this.selSegs.clear(); }
    }
    this.h.selectionChanged();
    this.draw();
  }

  private move = (e: MouseEvent) => {
    const plan = this.h.getPlan();
    if (!plan) return;
    const p = this.toPlan(e);
    if (e.target === this.canvas) this.hover = p;
    if (this.moveAll) {
      const m = this.moveAll;
      let dx = p.x - m.x, dy = p.y - m.y;
      // keep everything inside the square
      const all = [...m.orig.values()];
      dx = clamp(dx, -Math.min(...all.map(q => q.x)), 1 - Math.max(...all.map(q => q.x)));
      dy = clamp(dy, -Math.min(...all.map(q => q.y)), 1 - Math.max(...all.map(q => q.y)));
      if (!m.began) { this.h.begin(); m.began = true; }
      for (const q of [...plan.points, ...plan.objects]) { const o = m.orig.get(q.id); if (o) { q.x = o.x + dx; q.y = o.y + dy; } }
      this.draw();
      return;
    }
    if (this.objDrag) {
      const o = plan.objects.find(x => x.id === this.objDrag!.id);
      const np = { x: p.x + this.objDrag.dx, y: p.y + this.objDrag.dy };
      if (o && this.okPoint(np)) {
        if (!this.objDrag.began) { this.h.begin(); this.objDrag.began = true; }
        o.x = np.x; o.y = np.y;
        this.draw();
      }
      return;
    }
    if (this.drag) {
      const pt = plan.points.find(x => x.id === this.drag!.id);
      if (!pt) return;
      const np = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
      if (planValid(plan, new Map([[pt.id, np]])) && this.okPointWithWalls(plan, pt.id, np)) {
        if (!this.drag.began) { this.h.begin(); this.drag.began = true; }
        pt.x = np.x; pt.y = np.y;
        this.drag.moved = true;
        this.h.selectionChanged();
      }
    }
    if (e.target === this.canvas || this.drag) this.draw();
  };

  private up = () => {
    if (this.drag?.moved || this.objDrag?.began || this.moveAll?.began) this.h.commit();
    this.drag = null; this.objDrag = null; this.moveAll = null;
  };

  private dbl(e: MouseEvent) {
    const plan = this.h.getPlan();
    if (!plan || this.tool !== 'select') return;
    const p = this.toPlan(e);
    if (this.hitPoint(plan, p)) return;
    const s = this.hitSeg(plan, p);
    if (!s) return;
    this.insertPoint(plan, s.id, p);
  }

  /** Split a wall by inserting a point on it (projected onto the line). */
  insertPoint(plan: StructurePlan, segId: string, near?: V2) {
    const s = plan.segments.find(x => x.id === segId)!;
    const A = plan.points.find(x => x.id === s.a)!, B = plan.points.find(x => x.id === s.b)!;
    const sp = sampleSeg(plan, s), pp = polyParams(sp);
    let t = 0.5;
    if (near) {
      // closest position along the (possibly curved) wall
      let bd = Infinity;
      for (let k = 0; k <= 200; k++) {
        const q = polyAt(sp, pp, k / 200), d = Math.hypot(q.x - near.x, q.y - near.y);
        if (d < bd) { bd = d; t = k / 200; }
      }
      t = clamp(t, 0.02, 0.98);
    }
    void A; void B;
    const q = polyAt(sp, pp, t);
    this.h.begin();
    const np: PlanPoint = { id: uid(), n: plan.nextN++, x: q.x, y: q.y };
    plan.points.push(np);
    const i = plan.segments.indexOf(s);
    // both halves keep the wall's properties
    const { id: _id, a: _a, b: _b, ...props } = s;
    plan.segments.splice(i, 1, { ...props, id: uid(), a: s.a, b: np.id }, { ...props, id: uid(), a: np.id, b: s.b });
    this.selPoints.clear(); this.selSegs.clear(); this.selPoints.add(np.id);
    this.h.commit();
    this.h.selectionChanged();
    this.draw();
  }

  /** The two selected walls meeting at a point: their shared (middle) point and the two other ends. */
  pairOfSelected(): { M: PlanPoint; A: PlanPoint; C: PlanPoint } | null {
    const plan = this.h.getPlan();
    if (!plan || this.selSegs.size !== 2) return null;
    const [s1, s2] = plan.segments.filter(s => this.selSegs.has(s.id));
    if (!s1 || !s2) return null;
    const mid = [s1.a, s1.b].find(id => id === s2.a || id === s2.b);
    if (!mid) return null;
    const P = (id: string) => plan.points.find(q => q.id === id)!;
    return { M: P(mid), A: P(s1.a === mid ? s1.b : s1.a), C: P(s2.a === mid ? s2.b : s2.a) };
  }
  /** Right angle / one straight line between the two selected walls: only the middle point moves. */
  alignSelected(kind: 'right' | 'straight') {
    const plan = this.h.getPlan(), pr = this.pairOfSelected();
    if (!plan || !pr) return this.h.toast('Select two walls that meet at a point');
    const np = alignMiddle(pr.A, pr.M, pr.C, kind);
    if (np.x < 0 || np.x > 1 || np.y < 0 || np.y > 1) return this.h.toast('That would put the point outside the building area');
    if (!planValid(plan, new Map([[pr.M.id, np]])) || !this.okPointWithWalls(plan, pr.M.id, np)) return this.h.toast('That would make walls cross');
    this.h.begin();
    pr.M.x = np.x; pr.M.y = np.y;
    this.h.commit();
    this.draw();
  }

  deleteSelection() {
    const plan = this.h.getPlan();
    if (!plan || (!this.selPoints.size && !this.selSegs.size && !this.selObj)) return;
    this.h.begin();
    plan.objects = plan.objects.filter(o => o.id !== this.selObj);
    this.selObj = null;
    plan.points = plan.points.filter(p => !this.selPoints.has(p.id));
    plan.segments = plan.segments.filter(s => !this.selSegs.has(s.id) && !this.selPoints.has(s.a) && !this.selPoints.has(s.b));
    this.selPoints.clear(); this.selSegs.clear();
    this.prune();
    this.h.commit();
    this.h.selectionChanged();
    this.draw();
  }

  // ---- drawing ----
  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (c.width !== w * dpr || c.height !== hh * dpr) {
      c.width = w * dpr; c.height = hh * dpr; c.style.width = w + 'px'; c.style.height = hh + 'px';
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#232323'; g.fillRect(0, 0, w, hh);
    const b = this.box;
    // area + grid
    g.fillStyle = '#2c2c2c'; g.fillRect(b.x0, b.y0, b.s, b.s);
    g.strokeStyle = '#383838'; g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const o = (b.s * i) / 10;
      g.beginPath(); g.moveTo(b.x0 + o, b.y0); g.lineTo(b.x0 + o, b.y0 + b.s); g.stroke();
      g.beginPath(); g.moveTo(b.x0, b.y0 + o); g.lineTo(b.x0 + b.s, b.y0 + o); g.stroke();
    }
    g.strokeStyle = '#e6e6e6'; g.strokeRect(b.x0, b.y0, b.s, b.s);
    g.fillStyle = '#888'; g.font = '11px system-ui';
    g.fillText('(0,0)', b.x0 - 14, b.y0 + b.s + 14);
    g.fillText('(1,1)', b.x0 + b.s - 14, b.y0 - 6);
    g.fillText(`${fmt(this.h.baseLength())} m`, b.x0 + b.s / 2 - 16, b.y0 + b.s + 14);

    const plan = this.h.getPlan();
    if (!plan) { g.fillStyle = '#aaa'; g.fillText('No structure plan selected', b.x0 + 10, b.y0 + 20); return; }
    const pts = new Map(plan.points.map(p => [p.id, p]));
    const path = (poly: V2[]) => {
      g.beginPath();
      poly.forEach((v, i) => { const q = this.toScreen(v); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    };

    // ghost of the plan below
    const ghost = this.h.getGhost();
    if (ghost && ghost !== plan) {
      g.strokeStyle = 'rgba(255,160,96,0.45)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      for (const s of ghost.segments) { path(sampleSeg(ghost, s)); g.stroke(); }
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,160,96,0.5)';
      for (const p of ghost.points) { const q = this.toScreen(p); g.fillRect(q.x - 2, q.y - 2, 4, 4); }
    }

    // connections from the plan below (walls that connect up instead of going straight)
    const links = this.h.links?.() ?? [];
    if (links.length) {
      g.strokeStyle = 'rgba(255,176,112,0.7)'; g.lineWidth = 1; g.setLineDash([2, 3]);
      for (const [a, c] of links) { const A = this.toScreen(a), C = this.toScreen(c); g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(C.x, C.y); g.stroke(); }
      g.setLineDash([]);
    }

    // enclosed areas
    g.fillStyle = 'rgba(58,123,213,0.18)';
    for (const f of enclosedFaces(plan)) {
      g.beginPath();
      f.forEach((v, i) => { const s = this.toScreen(v); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
      g.closePath(); g.fill();
    }

    // walls: translucent band showing thickness + centre line
    const tpx = Math.max(2, (plan.wallThickness / this.h.baseLength()) * b.s);
    const sideOf = new Map<string, number>(); // +1: inside on the wall's left, -1: on its right
    for (const f of enclosedFacesSegs(plan)) f.segIds.forEach((id, k) => { if (!sideOf.has(id)) sideOf.set(id, f.ids[k] === plan.segments.find(x => x.id === id)?.a ? 1 : -1); });
    g.lineCap = 'round';
    for (const s of plan.segments) {
      const sp = sampleSeg(plan, s);
      const sel = this.selSegs.has(s.id);
      const kind = segKind(s);
      if (kind === 'wall') {
        // wall thickness: inside the line for walls around an enclosed area (as built in 3D), centred otherwise
        const side = sideOf.get(s.id) ?? 0, t = plan.wallThickness / this.h.baseLength();
        const d0 = { x: sp[sp.length - 1].x - sp[0].x, y: sp[sp.length - 1].y - sp[0].y }, dl = Math.hypot(d0.x, d0.y) || 1;
        const n = { x: (-d0.y / dl) * side * t, y: (d0.x / dl) * side * t };
        g.fillStyle = sel ? 'rgba(255,212,0,0.35)' : 'rgba(255,255,255,0.15)';
        if (side) {
          path([...sp, ...[...sp].reverse().map(q => ({ x: q.x + n.x, y: q.y + n.y }))]); g.fill();
        } else {
          g.strokeStyle = g.fillStyle; g.lineWidth = tpx; path(sp); g.stroke();
        }
      }
      g.strokeStyle = sel ? '#ffd400' : kind === 'open' ? '#9fb4c8' : kind === 'door' ? '#e0a060' : kind === 'balustrade' ? '#c9b8ff' : '#f0f0f0';
      g.lineWidth = sel ? 2.5 : 1.5;
      g.setLineDash(kind === 'colonnade' ? [2, 5] : kind === 'open' ? [12, 4, 2, 4] : kind === 'door' ? [8, 4] : kind === 'balustrade' ? [1, 3] : []);
      path(sp); g.stroke();
      g.setLineDash([]);
      // division borders (by length: full divisions in the middle, shorter ones at the ends)
      const pp = polyParams(sp), lenM = polyLength(sp) * this.h.baseLength();
      const us = divisionBorders(lenM, this.h.divLen(s)).map(x => (lenM ? x / lenM : 0)).slice(1, -1);
      if (kind === 'colonnade') {
        const cus = columnPositions(plan, s, divisionBorders(lenM, this.h.divLen(s)).map(x => (lenM ? x / lenM : 0)), lenM, segColT(plan, s));
        const cpx = Math.max(4, (segColT(plan, s) / this.h.baseLength()) * b.s);
        g.fillStyle = sel ? '#ffd400' : '#f0f0f0';
        for (const u of cus) { const q = this.toScreen(polyAt(sp, pp, u)); g.fillRect(q.x - cpx / 2, q.y - cpx / 2, cpx, cpx); }
      } else if (kind === 'wall') {
        g.strokeStyle = sel ? '#ffd400' : 'rgba(240,240,240,0.7)'; g.lineWidth = 1;
        for (const u of us) {
          const A = this.toScreen(polyAt(sp, pp, Math.max(0, u - 0.002))), C = this.toScreen(polyAt(sp, pp, Math.min(1, u + 0.002))), q = this.toScreen(polyAt(sp, pp, u));
          const nx = -(C.y - A.y), ny = C.x - A.x, nl = Math.hypot(nx, ny) || 1, len = tpx / 2 + 3;
          g.beginPath(); g.moveTo(q.x + (nx / nl) * len, q.y + (ny / nl) * len); g.lineTo(q.x - (nx / nl) * len, q.y - (ny / nl) * len); g.stroke();
        }
      }
    }

    // rubber band from chain head
    if (this.tool === 'draw' && this.head && this.hover && pts.get(this.head)) {
      const A = this.toScreen(pts.get(this.head)!), B = this.toScreen(this.hover);
      g.lineWidth = 1;
      g.setLineDash([5, 5]); g.strokeStyle = '#7fc8ff'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke(); g.setLineDash([]);
    }

    // stairs / elevators
    for (const o of plan.objects) {
      const cs = this.objCorners(o).map(c => this.toScreen(c));
      const sel = o.id === this.selObj;
      g.fillStyle = sel ? 'rgba(255,212,0,0.25)' : 'rgba(160,190,220,0.18)';
      g.strokeStyle = sel ? '#ffd400' : '#a8c0d8'; g.lineWidth = 1.5;
      g.beginPath(); cs.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y))); g.closePath(); g.fill(); g.stroke();
      g.lineWidth = 1;
      if (o.type === 'stairs') {
        const n = 12;
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const a = { x: cs[0].x + (cs[3].x - cs[0].x) * t, y: cs[0].y + (cs[3].y - cs[0].y) * t };
          const b2 = { x: cs[1].x + (cs[2].x - cs[1].x) * t, y: cs[1].y + (cs[2].y - cs[1].y) * t };
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b2.x, b2.y); g.stroke();
        }
      } else {
        g.beginPath(); g.moveTo(cs[0].x, cs[0].y); g.lineTo(cs[2].x, cs[2].y); g.moveTo(cs[1].x, cs[1].y); g.lineTo(cs[3].x, cs[3].y); g.stroke();
      }
    }

    const connected = new Set(plan.segments.flatMap(sg => [sg.a, sg.b]));
    for (const p of plan.points) {
      const s = this.toScreen(p);
      const sel = this.selPoints.has(p.id);
      if (!connected.has(p.id)) {
        // unconnected point: hollow orange ring so stray clicks are easy to spot and delete
        g.strokeStyle = sel ? '#ffd400' : '#ff9b4a'; g.lineWidth = 2;
        g.beginPath(); g.arc(s.x, s.y, 5.5, 0, Math.PI * 2); g.stroke();
      } else {
        g.fillStyle = sel ? '#ffd400' : '#ffffff';
        g.beginPath(); g.arc(s.x, s.y, sel ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
      }
      if (p.id === this.head && this.tool === 'draw') {
        g.strokeStyle = '#4cd964'; g.lineWidth = 2;
        g.beginPath(); g.arc(s.x, s.y, 8, 0, Math.PI * 2); g.stroke();
      }
    }

    // cursor readout
    if (this.hover && this.inside(this.hover)) {
      const L = this.h.baseLength();
      g.fillStyle = '#aaa';
      g.fillText(`x ${this.hover.x.toFixed(3)}  y ${this.hover.y.toFixed(3)}   (${fmt(this.hover.x * L)} m, ${fmt(this.hover.y * L)} m)`, 12, hh - 12);
    }
  }
}

export const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
