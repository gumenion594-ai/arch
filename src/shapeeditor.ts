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
  /** Points and lines new / dragged points snap to (e.g. wall corners and wall lines). */
  snapPoints?(): V2[];
  snapLines?(): V2[][];
  /** Grid step (0..1 units) for snapping; default 1/20. */
  gridStep?(): number;
  /** Closed areas the "pick" tool adds with one click (e.g. rooms). */
  faces?(): V2[][];
  /** Fill colour of the outlines (default: dark, opaque). */
  fill?(): string;
}
export type ShapeTool = 'points' | 'rect' | 'pick';
export type ShapeMode = 'closed' | 'profileX' | 'profileY';

export class ShapeEditor {
  canvas = document.createElement('canvas');
  ctx = this.canvas.getContext('2d')!;
  sel: { o: number; i: number } | null = null;
  cur: number | null = null; // outline receiving new points (closed mode)
  private drag: { o: number; i: number; began: boolean } | null = null;
  private hover: V2 | null = null;
  private ro: ResizeObserver;
  /** closed mode: how a click adds shapes (points one by one, a dragged rectangle, or a whole room). */
  tool: ShapeTool = 'points';
  private rect: { a: V2; b: V2 } | null = null;
  private snapped: { q: V2; kind: 'point' | 'line' | 'grid' | 'free' } | null = null;
  // view: zoom (mouse wheel, at the cursor) and pan (right / middle drag)
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private panning: { x: number; y: number } | null = null;
  /** Points picked with the selection box (right-drag), as "outline:index"; they move and delete together. */
  multi = new Set<string>();
  private boxSel: { a: V2; b: V2; add: boolean } | null = null;
  private dragFrom: V2 | null = null;

  constructor(private host: HTMLElement, private h: ShapeHost, private mode: ShapeMode = 'closed') {
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.canvas.addEventListener('mousedown', e => this.down(e));
    this.canvas.addEventListener('dblclick', e => this.dbl(e));
    this.canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mousemove', this.move);
    window.addEventListener('mouseup', this.up);
  }
  dispose() {
    this.ro.disconnect();
    window.removeEventListener('mousemove', this.move);
    window.removeEventListener('mouseup', this.up);
    this.canvas.remove();
  }
  reset() { this.sel = null; this.cur = null; this.rect = null; this.multi.clear(); }
  resetView() { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.draw(); }
  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const before = this.P(e);
    this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), 0.5, 40);
    // keep the point under the cursor where it is
    const b = this.box, sx = b.x0 + before.x * b.sw, sy = b.y0 + (1 - before.y) * b.sh;
    this.pan.x += mx - sx; this.pan.y += my - sy;
    this.draw();
  }

  private get box() {
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight;
    const aspect = this.h.aspect() || 1;
    const avail = Math.max(40, Math.min(w, hh) - 56);
    const sw0 = aspect >= 1 ? avail : avail * aspect, sh0 = aspect >= 1 ? avail / aspect : avail;
    const z = this.zoom, sw = sw0 * z, sh = sh0 * z;
    return { x0: w / 2 - sw / 2 + this.pan.x, y0: hh / 2 - sh / 2 + this.pan.y, s: Math.min(sw, sh), sw, sh };
  }
  private S(p: V2) { const b = this.box; return { x: b.x0 + p.x * b.sw, y: b.y0 + (1 - p.y) * b.sh }; }
  private P(e: MouseEvent): V2 {
    const r = this.canvas.getBoundingClientRect(), b = this.box;
    return { x: (e.clientX - r.left - b.x0) / b.sw, y: 1 - (e.clientY - r.top - b.y0) / b.sh };
  }
  /** Snap: wall corners / other points first, then wall lines, then the grid (Alt: no snapping). */
  private snap(p: V2, on: boolean, exclude?: WinPoint): V2 {
    const q = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
    const res = (r: V2, kind: 'point' | 'line' | 'grid' | 'free') => { this.snapped = { q: r, kind }; return r; };
    if (!on) return res(q, 'free');
    const b = this.box, px = (a: V2, c: V2) => Math.hypot((a.x - c.x) * b.sw, (a.y - c.y) * b.sh);
    const own = (this.h.getOutlines() ?? []).flat().filter(r => !exclude || r.x !== exclude.x || r.y !== exclude.y);
    let best: V2 | null = null, bd = 11;
    for (const r of [...(this.h.snapPoints?.() ?? []), ...own]) { const d = px(r, q); if (d < bd) { bd = d; best = r; } }
    if (best) return res({ x: best.x, y: best.y }, 'point');
    let line: V2 | null = null; bd = 8;
    for (const pl of this.h.snapLines?.() ?? []) for (let i = 0; i + 1 < pl.length; i++) {
      const a = pl[i], c = pl[i + 1], dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      const t = clamp(((q.x - a.x) * dx + (q.y - a.y) * dy) / l2, 0, 1), f = { x: a.x + dx * t, y: a.y + dy * t };
      const d = px(f, q);
      if (d < bd) { bd = d; line = f; }
    }
    if (line) return res(line, 'line');
    const g = this.h.gridStep?.() ?? 1 / 20;
    return res({ x: clamp(Math.round(q.x / g) * g, 0, 1), y: clamp(Math.round(q.y / g) * g, 0, 1) }, 'grid');
  }
  /** Shift: keep the new point level / plumb with the previous one. */
  private lock(p: V2, e: MouseEvent, prev?: V2): V2 {
    if (!e.shiftKey || !prev) return p;
    return Math.abs(p.x - prev.x) > Math.abs(p.y - prev.y) ? { x: p.x, y: prev.y } : { x: prev.x, y: p.y };
  }
  private faceAt(p: V2): V2[] | null {
    const fs = (this.h.faces?.() ?? []).filter(f => f.length >= 3 && pointInPoly(p, f));
    if (!fs.length) return null;
    const area = (f: V2[]) => Math.abs(f.reduce((s, a, i) => { const c = f[(i + 1) % f.length]; return s + a.x * c.y - c.x * a.y; }, 0));
    return fs.sort((a, c) => area(a) - area(c))[0]; // the smallest (innermost) room
  }
  private addOutline(pts: V2[]) {
    const next = this.copy();
    next.push(pts.map(q => ({ x: q.x, y: q.y })));
    if (!this.valid(next)) return this.h.toast('Outlines cannot cross themselves');
    this.h.begin(); this.h.setOutlines(next); this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
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
    if (e.button === 1) { e.preventDefault(); this.panning = { x: e.clientX, y: e.clientY }; return; } // middle-drag pans
    if (e.button === 2) { e.preventDefault(); const q = this.P(e); this.boxSel = { a: q, b: q, add: e.shiftKey || e.ctrlKey || e.metaKey }; return; } // right-drag: selection box
    const ols = this.h.getOutlines();
    if (!ols || e.button !== 0) return;
    const p = this.P(e);
    const hit = this.hitPoint(ols, p);
    if (hit) {
      // clicking the first point of the outline being drawn closes it
      const closing = !this.profile && hit.o === this.cur && hit.i === 0 && ols[hit.o].length >= 3 && this.sel?.o === hit.o && this.sel.i === ols[hit.o].length - 1;
      if (!this.multi.has(`${hit.o}:${hit.i}`)) this.multi.clear(); // clicking outside the boxed points drops them
      this.dragFrom = { x: ols[hit.o][hit.i].x, y: ols[hit.o][hit.i].y };
      this.sel = hit; this.cur = this.profile || closing ? null : hit.o; this.drag = { ...hit, began: false }; this.h.selectionChanged(); this.draw(); return;
    }
    if (!this.profile && this.hitEdge(ols, p)) return; // double-click inserts a point there
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    if (!this.profile && this.tool === 'pick') {
      const f = this.faceAt(p);
      if (!f) return this.h.toast('No closed area here: click inside a room');
      return this.addOutline(f);
    }
    if (!this.profile && this.tool === 'rect') { const a = this.snap(p, !e.altKey); this.rect = { a, b: a }; return; }
    const curOl = !this.profile && this.cur !== null ? ols[this.cur] : undefined;
    const np = this.lock(this.snap(p, !e.altKey), e, curOl?.[curOl.length - 1]);
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
    if (this.boxSel) { this.boxSel.b = this.P(e); this.draw(); return; }
    if (this.panning) {
      this.pan.x += e.clientX - this.panning.x; this.pan.y += e.clientY - this.panning.y;
      this.panning = { x: e.clientX, y: e.clientY };
      this.draw(); return;
    }
    const ols = this.h.getOutlines();
    if (!ols) return;
    this.hover = e.target === this.canvas ? this.P(e) : null;
    this.snapped = null;
    if (this.rect) { this.rect.b = this.snap(this.P(e), !e.altKey); this.draw(); return; }
    if (this.hover && !this.drag && !this.profile && this.tool !== 'pick') {
      const curOl = this.cur !== null ? ols[this.cur] : undefined;
      this.hover = this.lock(this.snap(this.hover, !e.altKey), e, this.tool === 'points' ? curOl?.[curOl.length - 1] : undefined);
      const sn = this.snapped as { q: V2 } | null; if (sn) sn.q = this.hover;
    }
    if (this.drag && this.multi.size > 1 && this.multi.has(`${this.drag.o}:${this.drag.i}`) && this.dragFrom) {
      // the boxed points move together, by how far the grabbed one moved
      const d = this.drag, np = this.snap(this.P(e), !e.altKey, ols[d.o]?.[d.i]);
      const dx = np.x - this.dragFrom.x, dy = np.y - this.dragFrom.y;
      const base = this.copy(), next = this.copy();
      const cur = ols[d.o][d.i], ox = cur.x - this.dragFrom.x, oy = cur.y - this.dragFrom.y; // already moved so far
      for (const k of this.multi) { const [o, i] = k.split(':').map(Number); const q = next[o]?.[i]; if (q) { q.x = base[o][i].x - ox + dx; q.y = base[o][i].y - oy + dy; } }
      const inBox = next.flat().every(q => q.x >= -1e-9 && q.x <= 1 + 1e-9 && q.y >= -1e-9 && q.y <= 1 + 1e-9);
      if (inBox && this.valid(next)) {
        if (!d.began) { this.h.begin(); d.began = true; }
        this.h.setOutlines(next);
      }
      this.draw();
      return;
    }
    if (this.drag) {
      const d = this.drag, np = this.snap(this.P(e), !e.altKey, ols[d.o]?.[d.i]);
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
  private up = () => {
    this.panning = null;
    if (this.boxSel) {
      const { a, b, add } = this.boxSel, ols = this.h.getOutlines() ?? [];
      this.boxSel = null;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (!add) this.multi.clear();
      ols.forEach((ol, o) => ol.forEach((q, i) => { if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) this.multi.add(`${o}:${i}`); }));
      const first = [...this.multi][0];
      if (first) { const [o, i] = first.split(':').map(Number); this.sel = { o, i }; } else this.sel = null;
      this.h.selectionChanged();
      this.draw();
      return;
    }
    if (this.rect) {
      const { a, b } = this.rect;
      this.rect = null;
      if (Math.abs(a.x - b.x) > 1e-4 && Math.abs(a.y - b.y) > 1e-4) this.addOutline([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]);
      else this.draw();
      return;
    }
    if (this.drag?.began) this.h.commit();
    this.drag = null;
  };

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
    if (this.multi.size > 1) {
      // every boxed point (highest index first, so the others keep their place)
      const keys = [...this.multi].map(k => k.split(':').map(Number)).sort((p, q) => q[0] - p[0] || q[1] - p[1]);
      for (const [o, i] of keys) ols[o]?.splice(i, 1);
      const left = ols.filter(ol => (this.profile ? ol.length >= 2 : ol.length > 0));
      if (this.profile && left.length < ols.length) return this.h.toast('A profile needs at least 2 points');
      this.multi.clear();
      this.h.begin(); this.h.setOutlines(left); this.sel = null; this.cur = null; this.h.commit(); this.h.selectionChanged(); this.draw();
      return;
    }
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
        g.fillStyle = this.h.fill?.() ?? 'rgba(25,25,25,0.95)'; g.fill();
        g.strokeStyle = active ? '#9fd3ff' : '#d0d0d0'; g.lineWidth = 2; g.stroke();
      }
      const pts = ol.map(p => this.S(p));
      if (!this.profile) {
        g.setLineDash([4, 4]); g.strokeStyle = 'rgba(159,211,255,0.45)'; g.lineWidth = 1;
        g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        if (ol.length >= 3 && !active) g.closePath();
        g.stroke(); g.setLineDash([]);
        if (active && this.hover && pts.length) {
          const q = this.S(this.hover);
          g.setLineDash([5, 5]); g.strokeStyle = '#7fc8ff';
          g.beginPath(); g.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y); g.lineTo(q.x, q.y);
          if (pts.length >= 2) g.lineTo(pts[0].x, pts[0].y);
          g.stroke(); g.setLineDash([]);
        }
      }
      ol.forEach((p, i) => {
        const q = pts[i], selected = (this.sel?.o === o && this.sel.i === i) || this.multi.has(`${o}:${i}`);
        g.fillStyle = selected ? '#ffd400' : '#fff';
        g.beginPath(); g.arc(q.x, q.y, selected ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
        if (p.s != null) { g.strokeStyle = '#9fd3ff'; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, 8, 0, Math.PI * 2); g.stroke(); }
      });
    });
    if (this.h.fill) for (const gl of this.h.ghostLines?.() ?? []) { // reference lines stay visible over see-through fills
      if (gl.length < 2) continue;
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1.5;
      g.beginPath(); gl.forEach((q, i) => { const p2 = this.S(q); i ? g.lineTo(p2.x, p2.y) : g.moveTo(p2.x, p2.y); }); g.stroke();
    }
    if (this.boxSel) {
      const A = this.S(this.boxSel.a), B = this.S(this.boxSel.b);
      g.fillStyle = 'rgba(255,212,0,0.12)'; g.strokeStyle = '#ffd400'; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
      g.strokeRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
      g.setLineDash([]);
    }
    if (this.rect) {
      const a = this.S(this.rect.a), c = this.S(this.rect.b);
      g.fillStyle = 'rgba(127,200,255,0.2)'; g.fillRect(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y));
      g.strokeStyle = '#7fc8ff'; g.lineWidth = 2; g.strokeRect(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y));
      const L = this.h.readout({ x: Math.abs(this.rect.b.x - this.rect.a.x), y: Math.abs(this.rect.b.y - this.rect.a.y) });
      g.fillStyle = '#cfe8ff'; g.fillText(L.replace(', ', ' × '), Math.max(a.x, c.x) + 6, Math.min(a.y, c.y) - 4);
    }
    if (!this.profile && this.tool === 'pick' && this.hover && !this.drag) {
      const f = this.faceAt(this.hover);
      if (f) {
        g.beginPath(); f.forEach((q, i) => { const s2 = this.S(q); i ? g.lineTo(s2.x, s2.y) : g.moveTo(s2.x, s2.y); }); g.closePath();
        g.fillStyle = 'rgba(127,200,255,0.25)'; g.fill(); g.strokeStyle = '#7fc8ff'; g.lineWidth = 2; g.stroke();
      }
    }
    if (this.snapped && this.snapped.kind !== 'free' && !this.profile && (this.tool !== 'pick' || this.drag)) {
      const s2 = this.S(this.snapped.q);
      g.strokeStyle = this.snapped.kind === 'point' ? '#ffd400' : this.snapped.kind === 'line' ? '#7fffb0' : 'rgba(255,255,255,0.5)'; g.lineWidth = 1.5;
      if (this.snapped.kind === 'point') g.strokeRect(s2.x - 6, s2.y - 6, 12, 12);
      else if (this.snapped.kind === 'line') { g.beginPath(); g.moveTo(s2.x - 6, s2.y - 6); g.lineTo(s2.x + 6, s2.y + 6); g.moveTo(s2.x + 6, s2.y - 6); g.lineTo(s2.x - 6, s2.y + 6); g.stroke(); }
      else { g.beginPath(); g.arc(s2.x, s2.y, 3, 0, Math.PI * 2); g.stroke(); }
    }
    if (this.hover && this.hover.x >= 0 && this.hover.x <= 1 && this.hover.y >= 0 && this.hover.y <= 1) {
      g.fillStyle = '#aaa';
      g.fillText(this.h.readout(this.hover), 8, hh - 8);
    }
  }
}
