// Point-and-line editor for designed shapes: opening / niche outlines, niche profiles, balcony bases.
// 'closed' edits one or more closed outlines; 'profileX' / 'profileY' edit one open profile line
// whose points stay ordered along x (bottom view) or y (side view).
import { WinPoint, clamp } from './model';
import { V2, alignMiddle, distToSeg, pointInPoly, segmentsConflict, smoothClosed } from './geometry';
import { smoothOpen } from './build3d';

export interface ShapeHost {
  getOutlines(): WinPoint[][] | null;
  setOutlines(o: WinPoint[][]): void;
  smooth(): number;
  begin(): void;
  commit(): void;
  toast(msg: string): void;
  selectionChanged(): void;
  aspect(): number; // width / height of the drawing box
  labels: { top?: string; bottom?: string; left?: string; right?: string };
  readout(p: V2): string;
  ghost?(): V2[] | null; // faint outline drawn behind (e.g. the front shape behind a profile)
  single?: boolean; // closed mode: only one outline (new points always join it)
  allowOverlap?: boolean; // closed mode: outlines may overlap each other (they add up), e.g. floor areas
  ghostLines?(): V2[][]; // faint reference lines (e.g. walls)
}
export type ShapeMode = 'closed' | 'profileX' | 'profileY';

export class ShapeEditor {
  canvas = document.createElement('canvas');
  ctx = this.canvas.getContext('2d')!;
  sel: { o: number; i: number } | null = null;
  cur: number | null = null; // outline receiving new points (closed mode)
  private drag: { o: number; i: number; began: boolean } | null = null;
  private hover: V2 | null = null;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private h: ShapeHost, private mode: ShapeMode = 'closed') {
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
    const aspect = this.h.aspect() || 1;
    const avail = Math.max(40, Math.min(w, hh) - 56);
    const sw = aspect >= 1 ? avail : avail * aspect, sh = aspect >= 1 ? avail / aspect : avail;
    return { x0: (w - sw) / 2, y0: (hh - sh) / 2, s: Math.min(sw, sh), sw, sh };
  }
  private S(p: V2) { const b = this.box; return { x: b.x0 + p.x * b.sw, y: b.y0 + (1 - p.y) * b.sh }; }
  private P(e: MouseEvent): V2 {
    const r = this.canvas.getBoundingClientRect(), b = this.box;
    return { x: (e.clientX - r.left - b.x0) / b.sw, y: 1 - (e.clientY - r.top - b.y0) / b.sh };
  }
  private snap(p: V2, on: boolean): V2 {
    const q = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
    return on ? { x: Math.round(q.x * 20) / 20, y: Math.round(q.y * 20) / 20 } : q;
  }
  private get profile() { return this.mode !== 'closed'; }
  private order(pts: WinPoint[]) { return this.mode === 'profileX' ? pts.sort((a, b) => a.x - b.x) : pts.sort((a, b) => a.y - b.y); }

  /** Outlines may not cross themselves or each other, or sit inside one another. */
  private valid(outlines: WinPoint[][]): boolean {
    if (this.profile) return true;
    const edges = (pts: WinPoint[]) => (pts.length < 2 ? [] : pts.length === 2 ? [[pts[0], pts[1]]] : pts.map((p, i) => [p, pts[(i + 1) % pts.length]]));
    for (let a = 0; a < outlines.length; a++) {
      const A = outlines[a], ea = edges(A);
      for (let i = 0; i < ea.length; i++) for (let j = i + 1; j < ea.length; j++) {
        if (j === i + 1 || (i === 0 && j === ea.length - 1)) continue;
        if (segmentsConflict(ea[i][0], ea[i][1], ea[j][0], ea[j][1])) return false;
      }
      if (this.h.allowOverlap) continue;
      for (let b = a + 1; b < outlines.length; b++) {
        const B = outlines[b], eb = edges(B);
        for (const [p, q] of ea) for (const [r, t] of eb) if (segmentsConflict(p, q, r, t)) return false;
        if (B.length >= 3 && A.some(p => pointInPoly(p, B))) return false;
        if (A.length >= 3 && B.some(p => pointInPoly(p, A))) return false;
      }
    }
    return true;
  }
  private hitPoint(ols: WinPoint[][], p: V2) {
    const b = this.box;
    let best: { o: number; i: number } | null = null, bd = 9;
    ols.forEach((ol, o) => ol.forEach((q, i) => { const d = Math.hypot((q.x - p.x) * b.sw, (q.y - p.y) * b.sh); if (d <= bd) { bd = d; best = { o, i }; } }));
    return best as { o: number; i: number } | null;
  }
  private hitEdge(ols: WinPoint[][], p: V2) {
    const tol = 9 / this.box.s;
    for (let o = 0; o < ols.length; o++) {
      const ol = ols[o], n = ol.length;
      if (n < 2) continue;
      for (let i = 0; i < (this.profile ? n - 1 : n); i++) if (distToSeg(p, ol[i], ol[(i + 1) % n]) <= tol) return { o, i };
    }
    return null;
  }
  private copy() { return (this.h.getOutlines() ?? []).map(o => o.map(q => ({ ...q }))); }

  private down(e: MouseEvent) {
    const ols = this.h.getOutlines();
    if (!ols || e.button !== 0) return;
    const p = this.P(e);
    const hit = this.hitPoint(ols, p);
    if (hit) { this.sel = hit; this.cur = this.profile ? null : hit.o; this.drag = { ...hit, began: false }; this.h.selectionChanged(); this.draw(); return; }
    if (!this.profile && this.hitEdge(ols, p)) return; // double-click inserts a point there
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    const np = this.snap(p, !e.altKey);
    const next = this.copy();
    let o: number, i: number;
    if (this.profile) {
      if (!next.length) next.push([]);
      o = 0;
      next[0].push(np); this.order(next[0]);
      i = next[0].indexOf(next[0].find(q => q.x === np.x && q.y === np.y)!);
    } else {
      o = this.h.single ? (next.length ? 0 : -1) : this.cur !== null && this.cur < next.length ? this.cur : -1;
      if (o < 0) { next.push([]); o = next.length - 1; }
      next[o].push(np);
      i = next[o].length - 1;
      if (!this.valid(next)) return this.h.toast('Outlines cannot cross themselves or each other');
      this.cur = o;
    }
    this.h.begin(); this.h.setOutlines(next); this.sel = { o, i }; this.h.commit(); this.draw();
  }
  private dbl(e: MouseEvent) {
    const ols = this.h.getOutlines();
    if (!ols || this.profile) return;
    const p = this.P(e);
    const hit = this.hitEdge(ols, p);
    if (!hit || this.hitPoint(ols, p)) return;
    const next = this.copy();
    next[hit.o].splice(hit.i + 1, 0, this.snap(p, !e.altKey));
    if (!this.valid(next)) return;
    this.h.begin(); this.h.setOutlines(next); this.sel = { o: hit.o, i: hit.i + 1 }; this.h.commit(); this.draw();
  }
  private move = (e: MouseEvent) => {
    const ols = this.h.getOutlines();
    if (!ols) return;
    this.hover = e.target === this.canvas ? this.P(e) : null;
    if (this.drag) {
      const d = this.drag, np = this.snap(this.P(e), !e.altKey);
      const next = this.copy();
      Object.assign(next[d.o][d.i], np);
      if (this.profile) { const moved = next[d.o][d.i]; this.order(next[d.o]); d.i = next[d.o].indexOf(moved); this.sel = { o: d.o, i: d.i }; }
      if (this.valid(next)) {
        if (!d.began) { this.h.begin(); d.began = true; }
        this.h.setOutlines(next);
      }
    }
    this.draw();
  };
  private up = () => { if (this.drag?.began) this.h.commit(); this.drag = null; };

  /** Enter / Space: finish the outline being drawn; the next click starts a new one. */
  finish() {
    const ols = this.h.getOutlines();
    this.cur = null;
    if (ols && !this.profile && ols.some(o => o.length < 3)) {
      this.h.begin();
      this.h.setOutlines(ols.filter(o => o.length >= 3));
      this.sel = null;
      this.h.commit();
      this.h.toast('Outlines need at least 3 points; shorter ones were removed');
    }
    this.h.selectionChanged();
    this.draw();
  }
  deleteSelected() {
    const ols = this.copy();
    if (!this.sel || !ols[this.sel.o]) return;
    const { o, i } = this.sel;
    if (this.profile && ols[o].length <= 2) return this.h.toast('A profile needs at least 2 points');
    ols[o].splice(i, 1);
    if (!ols[o].length) { ols.splice(o, 1); this.cur = null; }
    this.h.begin(); this.h.setOutlines(ols); this.sel = null; this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  deleteOutline() {
    if (!this.sel || this.profile) return;
    const ols = this.copy();
    ols.splice(this.sel.o, 1);
    this.h.begin(); this.h.setOutlines(ols); this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  clear() {
    this.h.begin(); this.h.setOutlines([]); this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
  }
  /** Stretch the drawing so it fills the whole box. */
  fit() {
    const ols = this.copy(), all = ols.flat();
    if (!all.length) return;
    const x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x)), y0 = Math.min(...all.map(p => p.y)), y1 = Math.max(...all.map(p => p.y));
    for (const p of all) { p.x = x1 > x0 ? (p.x - x0) / (x1 - x0) : 0.5; p.y = y1 > y0 ? (p.y - y0) / (y1 - y0) : 0.5; }
    this.h.begin(); this.h.setOutlines(ols); this.h.commit(); this.draw();
  }
  /** Right angle / straight line at the selected point, between its two neighbouring edges (only that point moves). */
  align(kind: 'right' | 'straight') {
    if (!this.sel) return;
    const ols = this.copy(), ol = ols[this.sel.o], i = this.sel.i, n = ol?.length ?? 0;
    if (!ol || n < 3 && !this.profile) return;
    const prev = this.profile ? ol[i - 1] : ol[(i - 1 + n) % n], next = this.profile ? ol[i + 1] : ol[(i + 1) % n];
    if (!prev || !next) return this.h.toast('This point needs a neighbour on each side');
    const np = alignMiddle(prev, ol[i], next, kind);
    if (np.x < 0 || np.x > 1 || np.y < 0 || np.y > 1) return this.h.toast('That would put the point outside the box');
    Object.assign(ol[i], np);
    if (!this.valid(ols)) return this.h.toast('That would make the outline cross itself');
    this.h.begin(); this.h.setOutlines(ols); this.h.commit(); this.draw();
  }
  selectedPoint(): WinPoint | null {
    const ols = this.h.getOutlines();
    return ols && this.sel ? ols[this.sel.o]?.[this.sel.i] ?? null : null;
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (!w || !hh) return;
    if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; c.style.width = w + 'px'; c.style.height = hh + 'px'; }
    const g = this.ctx, b = this.box;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#232323'; g.fillRect(0, 0, w, hh);
    g.fillStyle = '#3e4a55'; g.fillRect(b.x0, b.y0, b.sw, b.sh);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    for (let i = 1; i < 20; i++) {
      const ox = (b.sw * i) / 20, oy = (b.sh * i) / 20;
      g.beginPath(); g.moveTo(b.x0 + ox, b.y0); g.lineTo(b.x0 + ox, b.y0 + b.sh); g.stroke();
      g.beginPath(); g.moveTo(b.x0, b.y0 + oy); g.lineTo(b.x0 + b.sw, b.y0 + oy); g.stroke();
    }
    g.strokeStyle = '#e6e6e6'; g.strokeRect(b.x0, b.y0, b.sw, b.sh);
    g.fillStyle = '#999'; g.font = '11px system-ui';
    const lb = this.h.labels;
    if (lb.bottom) g.fillText(lb.bottom, b.x0 + 2, b.y0 + b.sh + 14);
    if (lb.top) g.fillText(lb.top, b.x0 + 2, b.y0 - 6);
    if (lb.left) { g.save(); g.translate(b.x0 - 6, b.y0 + b.sh); g.rotate(-Math.PI / 2); g.fillText(lb.left, 0, 0); g.restore(); }
    if (lb.right) { g.save(); g.translate(b.x0 + b.sw + 14, b.y0 + b.sh); g.rotate(-Math.PI / 2); g.fillText(lb.right, 0, 0); g.restore(); }
    for (const gl of this.h.ghostLines?.() ?? []) {
      if (gl.length < 2) continue;
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
      g.beginPath(); gl.forEach((q, i) => { const p2 = this.S(q); i ? g.lineTo(p2.x, p2.y) : g.moveTo(p2.x, p2.y); }); g.stroke();
    }
    const ghost = this.h.ghost?.();
    if (ghost && ghost.length > 2) {
      g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,176,112,0.6)';
      g.beginPath(); ghost.forEach((q, i) => { const s = this.S(q); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); }); g.closePath(); g.stroke(); g.setLineDash([]);
    }
    const ols = this.h.getOutlines();
    if (!ols) return;
    const def = this.h.smooth();
    ols.forEach((ol, o) => {
      if (!ol.length) return;
      const active = o === this.cur;
      if (this.profile) {
        // filled area between the profile and the axis it measures from
        const poly = (ol.length >= 2 ? smoothOpen(ol, def) : ol).map(p => this.S(p));
        g.beginPath(); poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        if (this.mode === 'profileX') { g.lineTo(poly[poly.length - 1].x, b.y0 + b.sh); g.lineTo(poly[0].x, b.y0 + b.sh); }
        else { g.lineTo(b.x0, poly[poly.length - 1].y); g.lineTo(b.x0, poly[0].y); }
        g.closePath(); g.fillStyle = 'rgba(25,25,25,0.9)'; g.fill();
        g.beginPath(); poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        g.strokeStyle = '#9fd3ff'; g.lineWidth = 2; g.stroke();
      } else if (ol.length >= 3) {
        const poly = smoothClosed(ol, def, 16).map(p => this.S(p));
        g.beginPath(); poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath();
        g.fillStyle = 'rgba(25,25,25,0.95)'; g.fill();
        g.strokeStyle = active ? '#9fd3ff' : '#d0d0d0'; g.lineWidth = 2; g.stroke();
      }
      const pts = ol.map(p => this.S(p));
      if (!this.profile) {
        g.setLineDash([4, 4]); g.strokeStyle = 'rgba(159,211,255,0.45)'; g.lineWidth = 1;
        g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        if (ol.length >= 3 && !active) g.closePath();
        g.stroke(); g.setLineDash([]);
        if (active && this.hover && pts.length) {
          const q = this.S(this.snap(this.hover, true));
          g.setLineDash([5, 5]); g.strokeStyle = '#7fc8ff';
          g.beginPath(); g.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y); g.lineTo(q.x, q.y);
          if (pts.length >= 2) g.lineTo(pts[0].x, pts[0].y);
          g.stroke(); g.setLineDash([]);
        }
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
      g.fillText(this.h.readout(this.hover), 8, hh - 8);
    }
  }
}
