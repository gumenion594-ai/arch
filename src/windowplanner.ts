// Window planner: draw a window outline on a 0..1 grid (x across a wall division, y up the floor).
import { WindowShape, clamp } from './model';
import { V2, distToSeg, segmentsConflict } from './geometry';

export interface WindowHost {
  getShape(): WindowShape | null;
  begin(): void;
  commit(): void;
  toast(msg: string): void;
  floorHeight(): number; // for the metre readout
}

export class WindowPlanner {
  canvas = document.createElement('canvas');
  ctx = this.canvas.getContext('2d')!;
  sel: number | null = null;
  private drag: { i: number; began: boolean } | null = null;
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
  /** The closed outline must not cross itself. */
  private valid(pts: V2[]): boolean {
    const n = pts.length;
    if (n < 4) return true;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsConflict(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
    return true;
  }
  private hitPoint(sh: WindowShape, p: V2) {
    const tol = 9 / this.box.s;
    let best: number | null = null, bd = tol;
    sh.points.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = i; } });
    return best;
  }
  private hitEdge(sh: WindowShape, p: V2) {
    const tol = 9 / this.box.s, n = sh.points.length;
    for (let i = 0; i < n; i++) if (distToSeg(p, sh.points[i], sh.points[(i + 1) % n]) <= tol) return i;
    return null;
  }

  private down(e: MouseEvent) {
    const sh = this.h.getShape();
    if (!sh || e.button !== 0) return;
    const p = this.P(e);
    const hit = this.hitPoint(sh, p);
    if (hit !== null) { this.sel = hit; this.drag = { i: hit, began: false }; this.draw(); return; }
    if (this.hitEdge(sh, p) !== null) return; // double-click inserts
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    // add a point at the end of the outline (it closes back to the first point)
    const np = this.snap(p, !e.altKey);
    const pts = [...sh.points, np];
    if (!this.valid(pts)) return this.h.toast('The window outline cannot cross itself');
    this.h.begin(); sh.points.push(np); this.sel = sh.points.length - 1; this.h.commit(); this.draw();
  }
  private dbl(e: MouseEvent) {
    const sh = this.h.getShape();
    if (!sh) return;
    const p = this.P(e);
    const i = this.hitEdge(sh, p);
    if (i === null || this.hitPoint(sh, p) !== null) return;
    const pts = [...sh.points];
    pts.splice(i + 1, 0, this.snap(p, !e.altKey));
    if (!this.valid(pts)) return;
    this.h.begin(); sh.points = pts; this.sel = i + 1; this.h.commit(); this.draw();
  }
  private move = (e: MouseEvent) => {
    const sh = this.h.getShape();
    if (!sh) return;
    this.hover = e.target === this.canvas ? this.P(e) : null;
    if (this.drag) {
      const np = this.snap(this.P(e), !e.altKey);
      const pts = sh.points.map((q, i) => (i === this.drag!.i ? np : q));
      if (this.valid(pts)) {
        if (!this.drag.began) { this.h.begin(); this.drag.began = true; }
        sh.points[this.drag.i] = np;
      }
    }
    this.draw();
  };
  private up = () => { if (this.drag?.began) this.h.commit(); this.drag = null; };

  deleteSelected() {
    const sh = this.h.getShape();
    if (!sh || this.sel === null) return;
    this.h.begin(); sh.points.splice(this.sel, 1); this.sel = null; this.h.commit(); this.draw();
  }
  clear() {
    const sh = this.h.getShape();
    if (!sh) return;
    this.h.begin(); sh.points = []; this.sel = null; this.h.commit(); this.draw();
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; c.style.width = w + 'px'; c.style.height = hh + 'px'; }
    const g = this.ctx, b = this.box;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#232323'; g.fillRect(0, 0, w, hh);
    // the wall division
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
    const pts = sh.points.map(p => this.S(p));
    if (pts.length) {
      g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath();
      g.fillStyle = 'rgba(30,30,30,0.95)'; if (pts.length >= 3) g.fill();
      g.strokeStyle = '#9fd3ff'; g.lineWidth = 2; g.stroke();
    }
    pts.forEach((q, i) => {
      g.fillStyle = i === this.sel ? '#ffd400' : '#fff';
      g.beginPath(); g.arc(q.x, q.y, i === this.sel ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
    });
    if (this.hover && this.hover.x >= 0 && this.hover.x <= 1 && this.hover.y >= 0 && this.hover.y <= 1) {
      g.fillStyle = '#aaa';
      g.fillText(`x ${this.hover.x.toFixed(2)}  y ${this.hover.y.toFixed(2)}  (${(this.hover.y * this.h.floorHeight()).toFixed(2)} m up on a ${this.h.floorHeight().toFixed(2)} m floor)`, 12, hh - 12);
    }
  }
}
