// Structure planner: 2D canvas editor for a structure plan (external walls).
import { PlanPoint, PlanSegment, StructurePlan, clamp, segColT, segKind, uid } from './model';
import { V2, distToSeg, enclosedFaces, planValid, polyAt, polyParams, sampleSeg } from './geometry';

export type Tool = 'draw' | 'select';

export interface PlannerHost {
  getPlan(): StructurePlan | null;
  getGhost(): StructurePlan | null; // plan below, drawn faintly for reference
  baseLength(): number;
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
  }

  clearSelection() { this.selPoints.clear(); this.selSegs.clear(); this.h.selectionChanged(); this.draw(); }
  endChain() { this.head = null; this.draw(); }

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
          this.h.begin();
          plan.segments.push({ id: uid(), a: this.head, b: pt.id });
          this.h.commit();
        }
        this.head = pt.id;
        this.draw();
        return;
      }
      if (!this.inside(p)) return this.h.toast('Points must be inside the building area');
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

    // select tool
    if (pt) {
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
    if (this.drag) {
      const pt = plan.points.find(x => x.id === this.drag!.id);
      if (!pt) return;
      const np = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
      if (planValid(plan, new Map([[pt.id, np]]))) {
        if (!this.drag.began) { this.h.begin(); this.drag.began = true; }
        pt.x = np.x; pt.y = np.y;
        this.drag.moved = true;
        this.h.selectionChanged();
      }
    }
    if (e.target === this.canvas || this.drag) this.draw();
  };

  private up = () => {
    if (this.drag?.moved) this.h.commit();
    this.drag = null;
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

  deleteSelection() {
    const plan = this.h.getPlan();
    if (!plan || (!this.selPoints.size && !this.selSegs.size)) return;
    this.h.begin();
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

    // enclosed areas
    g.fillStyle = 'rgba(58,123,213,0.18)';
    for (const f of enclosedFaces(plan)) {
      g.beginPath();
      f.forEach((v, i) => { const s = this.toScreen(v); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
      g.closePath(); g.fill();
    }

    // walls: translucent band showing thickness + centre line
    const tpx = Math.max(2, (plan.wallThickness / this.h.baseLength()) * b.s);
    g.lineCap = 'round';
    for (const s of plan.segments) {
      const sp = sampleSeg(plan, s);
      const sel = this.selSegs.has(s.id);
      const kind = segKind(s);
      if (kind === 'wall') {
        g.strokeStyle = sel ? 'rgba(255,212,0,0.35)' : 'rgba(255,255,255,0.15)'; g.lineWidth = tpx;
        path(sp); g.stroke();
      }
      g.strokeStyle = sel ? '#ffd400' : kind === 'open' ? '#9fb4c8' : '#f0f0f0';
      g.lineWidth = sel ? 2.5 : 1.5;
      g.setLineDash(kind === 'colonnade' ? [2, 5] : kind === 'open' ? [12, 4, 2, 4] : []);
      path(sp); g.stroke();
      g.setLineDash([]);
      if (kind === 'colonnade') {
        // column positions at the division points
        const d = Math.max(1, s.divisions ?? 1), pp = polyParams(sp);
        const cpx = Math.max(4, (segColT(plan, s) / this.h.baseLength()) * b.s);
        g.fillStyle = sel ? '#ffd400' : '#f0f0f0';
        for (let k = 1; k < d; k++) {
          const q = this.toScreen(polyAt(sp, pp, k / d));
          g.fillRect(q.x - cpx / 2, q.y - cpx / 2, cpx, cpx);
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

    for (const p of plan.points) {
      const s = this.toScreen(p);
      const sel = this.selPoints.has(p.id);
      g.fillStyle = sel ? '#ffd400' : '#ffffff';
      g.beginPath(); g.arc(s.x, s.y, sel ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
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
