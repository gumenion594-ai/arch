// Window planner: draw window outlines on a 0..1 grid (x across a wall division, y up the floor).
// A shape can hold several outlines (e.g. two openings side by side); each can be smoothed.
import { WinPoint, WindowShape, clamp } from './model';
import { V2, distToSeg, pointInPoly, segmentsConflict, smoothClosed } from './geometry';

export interface WindowHost {
  getShape(): WindowShape | null;
  begin(): void;
  commit(): void;
  toast(msg: string): void;
  floorHeight(): number; // for the metre readout
  selectionChanged(): void;
}

export class WindowPlanner {
  canvas = document.createElement('canvas');
  ctx = this.canvas.getContext('2d')!;
  sel: { o: number; i: number } | null = null;
  cur: number | null = null; // outline receiving new points (null = next click starts a new one)
  private drag: { o: number; i: number; began: boolean } | null = null;
  private hover: V2 | null = null;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private h: WindowHost) {
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.canvas.addEventListener('mousedown', e => this.down(e));
    this.canvas.addEventListener('dblclick', e => this.dbl(e));
    window.addEventListener('mousemove', this.move);
    window.addEventListener('mouseup', this.up);
  }
  dispose() {
    this.ro.disconnect();
    window.removeEventListener('mousemove', this.move);
    window.removeEventListener('mouseup', this.up);
    this.canvas.remove();
  }
  reset() { this.sel = null; this.cur = null; }

  private get box() {
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight;
    const s = Math.max(50, Math.min(w, hh) - 80);
    return { x0: (w - s) / 2, y0: (hh - s) / 2, s };
  }
  private S(p: V2) { const b = this.box; return { x: b.x0 + p.x * b.s, y: b.y0 + (1 - p.y) * b.s }; }
  private P(e: MouseEvent): V2 {
    const r = this.canvas.getBoundingClientRect(), b = this.box;
    return { x: (e.clientX - r.left - b.x0) / b.s, y: 1 - (e.clientY - r.top - b.y0) / b.s };
  }
  private snap(p: V2, on: boolean): V2 {
    const q = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
    return on ? { x: Math.round(q.x * 20) / 20, y: Math.round(q.y * 20) / 20 } : q;
  }

  /** Outlines may not cross themselves or each other, or sit inside one another. */
  private valid(outlines: WinPoint[][]): boolean {
    const edges = (pts: WinPoint[]) => (pts.length < 2 ? [] : pts.length === 2 ? [[pts[0], pts[1]]] : pts.map((p, i) => [p, pts[(i + 1) % pts.length]]));
    for (let a = 0; a < outlines.length; a++) {
      const A = outlines[a], ea = edges(A);
      // self crossing (non-neighbouring edges)
      for (let i = 0; i < ea.length; i++) for (let j = i + 1; j < ea.length; j++) {
        if (j === i + 1 || (i === 0 && j === ea.length - 1)) continue;
        if (segmentsConflict(ea[i][0], ea[i][1], ea[j][0], ea[j][1])) return false;
      }
      for (let b = a + 1; b < outlines.length; b++) {
        const B = outlines[b], eb = edges(B);
        for (const [p, q] of ea) for (const [r, t] of eb) if (segmentsConflict(p, q, r, t)) return false;
        if (B.length >= 3 && A.some(p => pointInPoly(p, B))) return false;
        if (A.length >= 3 && B.some(p => pointInPoly(p, A))) return false;
      }
    }
    return true;
  }
  private hitPoint(sh: WindowShape, p: V2) {
    const tol = 9 / this.box.s;
    let best: { o: number; i: number } | null = null, bd = tol;
    sh.outlines.forEach((ol, o) => ol.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = { o, i }; } }));
    return best as { o: number; i: number } | null;
  }
  private hitEdge(sh: WindowShape, p: V2) {
    const tol = 9 / this.box.s;
    for (let o = 0; o < sh.outlines.length; o++) {
      const ol = sh.outlines[o], n = ol.length;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) if (distToSeg(p, ol[i], ol[(i + 1) % n]) <= tol) return { o, i };
    }
    return null;
  }

  private down(e: MouseEvent) {
    const sh = this.h.getShape();
    if (!sh || e.button !== 0) return;
    const p = this.P(e);
    const hit = this.hitPoint(sh, p);
    if (hit) { this.sel = hit; this.cur = hit.o; this.drag = { ...hit, began: false }; this.h.selectionChanged(); this.draw(); return; }
    if (this.hitEdge(sh, p)) return; // double-click inserts a point there
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    const np = this.snap(p, !e.altKey);
    const next = sh.outlines.map(o => [...o]);
    let o = this.cur !== null && this.cur < next.length ? this.cur : -1;
    if (o < 0) { next.push([]); o = next.length - 1; }
    next[o].push(np);
    if (!this.valid(next)) return this.h.toast('Window outlines cannot cross themselves or each other');
    this.h.begin();
    sh.outlines = next;
    this.cur = o; this.sel = { o, i: next[o].length - 1 };
    this.h.commit(); this.draw();
  }
  private dbl(e: MouseEvent) {
    const sh = this.h.getShape();
    if (!sh) return;
    const p = this.P(e);
    const hit = this.hitEdge(sh, p);
    if (!hit || this.hitPoint(sh, p)) return;
    const next = sh.outlines.map(o => [...o]);
    next[hit.o].splice(hit.i + 1, 0, this.snap(p, !e.altKey));
    if (!this.valid(next)) return;
    this.h.begin(); sh.outlines = next; this.sel = { o: hit.o, i: hit.i + 1 }; this.h.commit(); this.draw();
  }
  private move = (e: MouseEvent) => {
    const sh = this.h.getShape();
    if (!sh) return;
    this.hover = e.target === this.canvas ? this.P(e) : null;
    if (this.drag) {
      const d = this.drag, np = this.snap(this.P(e), !e.altKey);
      const next = sh.outlines.map((ol, o) => ol.map((q, i) => (o === d.o && i === d.i ? { ...q, ...np } : q)));
      if (this.valid(next)) {
        if (!d.began) { this.h.begin(); d.began = true; }
        sh.outlines = next;
      }
    }
    this.draw();
  };
  private up = () => { if (this.drag?.began) this.h.commit(); this.drag = null; };

  /** Enter / Space: finish the outline being drawn; the next click starts a new one. */
  finish() {
    const sh = this.h.getShape();
    this.cur = null;
    if (sh && sh.outlines.some(o => o.length < 3)) {
      this.h.begin();
      sh.outlines = sh.outlines.filter(o => o.length >= 3);
      this.sel = null;
      this.h.commit();
      this.h.toast('Outlines need at least 3 points; shorter ones were removed');
    }
    this.h.selectionChanged();
    this.draw();
  }
  deleteSelected() {
    const sh = this.h.getShape();
    if (!sh || !this.sel) return;
    const { o, i } = this.sel;
    this.h.begin();
    sh.outlines[o].splice(i, 1);
    if (!sh.outlines[o].length) { sh.outlines.splice(o, 1); this.cur = null; }
    this.sel = null;
    this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  deleteOutline() {
    const sh = this.h.getShape();
    if (!sh || !this.sel) return;
    this.h.begin(); sh.outlines.splice(this.sel.o, 1); this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  clear() {
    const sh = this.h.getShape();
    if (!sh) return;
    this.h.begin(); sh.outlines = []; this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  selectedPoint(): WinPoint | null {
    const sh = this.h.getShape();
    return sh && this.sel ? sh.outlines[this.sel.o]?.[this.sel.i] ?? null : null;
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; c.style.width = w + 'px'; c.style.height = hh + 'px'; }
    const g = this.ctx, b = this.box;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#232323'; g.fillRect(0, 0, w, hh);
    g.fillStyle = '#5a5249'; g.fillRect(b.x0, b.y0, b.s, b.s);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    for (let i = 1; i < 20; i++) {
      const o = (b.s * i) / 20;
      g.beginPath(); g.moveTo(b.x0 + o, b.y0); g.lineTo(b.x0 + o, b.y0 + b.s); g.stroke();
      g.beginPath(); g.moveTo(b.x0, b.y0 + o); g.lineTo(b.x0 + b.s, b.y0 + o); g.stroke();
    }
    g.strokeStyle = '#e6e6e6'; g.strokeRect(b.x0, b.y0, b.s, b.s);
    g.fillStyle = '#888'; g.font = '11px system-ui';
    g.fillText('floor', b.x0 + 4, b.y0 + b.s + 14);
    g.fillText('ceiling', b.x0 + 4, b.y0 - 6);
    g.fillText('one wall division →', b.x0 + b.s - 110, b.y0 + b.s + 14);
    const sh = this.h.getShape();
    if (!sh) { g.fillStyle = '#aaa'; g.fillText('Create a window shape on the right', b.x0 + 10, b.y0 + 20); return; }
    sh.outlines.forEach((ol, o) => {
      if (!ol.length) return;
      const active = o === this.cur;
      // the opening (smoothed), then the control outline
      if (ol.length >= 3) {
        const poly = smoothClosed(ol, sh.smooth, 16).map(p => this.S(p));
        g.beginPath(); poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath();
        g.fillStyle = 'rgba(25,25,25,0.95)'; g.fill();
        g.strokeStyle = active ? '#9fd3ff' : '#d0d0d0'; g.lineWidth = 2; g.stroke();
      }
      const pts = ol.map(p => this.S(p));
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(159,211,255,0.45)'; g.lineWidth = 1;
      g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      if (ol.length >= 3 && !active) g.closePath();
      g.stroke(); g.setLineDash([]);
      // rubber band to the cursor while drawing
      if (active && this.hover && pts.length) {
        const q = this.S(this.snap(this.hover, true));
        g.setLineDash([5, 5]); g.strokeStyle = '#7fc8ff';
        g.beginPath(); g.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y); g.lineTo(q.x, q.y);
        if (pts.length >= 2) g.lineTo(pts[0].x, pts[0].y);
        g.stroke(); g.setLineDash([]);
      }
      ol.forEach((p, i) => {
        const q = pts[i], selected = this.sel?.o === o && this.sel.i === i;
        g.fillStyle = selected ? '#ffd400' : '#fff';
        g.beginPath(); g.arc(q.x, q.y, selected ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
        if (p.s != null) { g.strokeStyle = '#9fd3ff'; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, 8, 0, Math.PI * 2); g.stroke(); }
      });
    });
    if (this.hover && this.hover.x >= 0 && this.hover.x <= 1 && this.hover.y >= 0 && this.hover.y <= 1) {
      g.fillStyle = '#aaa';
      g.fillText(`x ${this.hover.x.toFixed(2)}  y ${this.hover.y.toFixed(2)}  (${(this.hover.y * this.h.floorHeight()).toFixed(2)} m up on a ${this.h.floorHeight().toFixed(2)} m floor)`, 12, hh - 12);
    }
  }
}
