// 2D helpers for plans (coordinates in the 0..1 building square).
import type { PlanSegment, StructurePlan } from './model';
import { segSmooth } from './model';

export type V2 = { x: number; y: number };

const EPS = 1e-9;
const cross = (o: V2, a: V2, b: V2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const same = (a: V2, b: V2) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

function onSeg(p: V2, a: V2, b: V2) {
  return Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS;
}

/** True if segments p1p2 and q1q2 cross or overlap. Touching only at a shared endpoint is allowed. */
export function segmentsConflict(p1: V2, p2: V2, q1: V2, q2: V2): boolean {
  const shared = [p1, p2].filter(p => same(p, q1) || same(p, q2)).length;
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  const z = (d: number) => Math.abs(d) < EPS;
  if (z(d1) && z(d2)) {
    // collinear: conflict if they overlap more than a shared endpoint
    if (shared >= 1) {
      const s = same(p1, q1) || same(p1, q2) ? p1 : p2;
      const pOther = same(s, p1) ? p2 : p1;
      const qOther = same(s, q1) ? q2 : q1;
      const dot = (pOther.x - s.x) * (qOther.x - s.x) + (pOther.y - s.y) * (qOther.y - s.y);
      return dot > EPS; // same direction from the shared point -> overlap
    }
    return onSeg(p1, q1, q2) || onSeg(p2, q1, q2) || onSeg(q1, p1, p2) || onSeg(q2, p1, p2);
  }
  if (shared >= 1) return false;
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  if (z(d1) && onSeg(p1, q1, q2)) return true;
  if (z(d2) && onSeg(p2, q1, q2)) return true;
  if (z(d3) && onSeg(q1, p1, p2)) return true;
  if (z(d4) && onSeg(q2, p1, p2)) return true;
  return false;
}

/** Does the plan stay valid (no crossing walls)? Optionally override point positions. */
export function planValid(plan: StructurePlan, override?: Map<string, V2>, extra?: [string, string][]): boolean {
  const pos = (id: string): V2 => override?.get(id) ?? plan.points.find(p => p.id === id)!;
  const segs: [string, string][] = plan.segments.map(s => [s.a, s.b]);
  if (extra) segs.push(...extra);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = segs[i], [c, d] = segs[j];
      if (segmentsConflict(pos(a), pos(b), pos(c), pos(d))) return false;
    }
  }
  // a point lying exactly on another wall (not its own) is also invalid
  for (const p of plan.points) {
    const pp = pos(p.id);
    for (const [a, b] of segs) {
      if (a === p.id || b === p.id) continue;
      const A = pos(a), B = pos(b);
      if (Math.abs(cross(A, B, pp)) < 1e-7 && onSeg(pp, A, B)) return false;
    }
  }
  return true;
}

export function distToSeg(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function signedArea(poly: V2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Enclosed areas of the wall graph: bounded faces of the planar graph,
 * found by walking half-edges always taking the next edge clockwise.
 */
export function enclosedFaces(plan: StructurePlan): V2[][] {
  const pts = new Map(plan.points.map(p => [p.id, p as V2]));
  const adj = new Map<string, string[]>();
  for (const s of plan.segments) {
    if (s.a === s.b) continue;
    (adj.get(s.a) ?? adj.set(s.a, []).get(s.a)!).push(s.b);
    (adj.get(s.b) ?? adj.set(s.b, []).get(s.b)!).push(s.a);
  }
  // sort neighbours by angle
  for (const [id, ns] of adj) {
    const o = pts.get(id)!;
    ns.sort((u, v) => {
      const a = pts.get(u)!, b = pts.get(v)!;
      return Math.atan2(a.y - o.y, a.x - o.x) - Math.atan2(b.y - o.y, b.x - o.x);
    });
  }
  const visited = new Set<string>();
  const faces: V2[][] = [];
  for (const [u, ns] of adj) {
    for (const v of ns) {
      if (visited.has(u + '>' + v)) continue;
      const face: string[] = [];
      let a = u, b = v, guard = 0;
      while (!visited.has(a + '>' + b) && guard++ < 10000) {
        visited.add(a + '>' + b);
        face.push(a);
        const nb = adj.get(b)!;
        const i = nb.indexOf(a);
        const next = nb[(i - 1 + nb.length) % nb.length]; // previous in CCW order = next clockwise
        a = b; b = next;
      }
      const poly = face.map(id => pts.get(id)!);
      if (poly.length >= 3 && signedArea(poly) > 1e-9) {
        // follow curved walls
        const out: V2[] = [];
        for (let k = 0; k < face.length; k++) {
          const u = face[k], w = face[(k + 1) % face.length];
          const seg = plan.segments.find(x => (x.a === u && x.b === w) || (x.a === w && x.b === u))!;
          const sp = sampleSeg(plan, seg);
          if (seg.a !== u) sp.reverse();
          out.push(...sp.slice(0, -1));
        }
        faces.push(out);
      }
    }
  }
  return faces;
}

/** The other neighbour of point `at` (excluding `from`) if `at` has exactly two walls. */
function continuation(plan: StructurePlan, at: string, from: string): V2 | null {
  const segs = plan.segments.filter(x => x.a === at || x.b === at);
  if (segs.length !== 2) return null;
  const o = segs.find(x => !((x.a === at && x.b === from) || (x.b === at && x.a === from)));
  if (!o) return null;
  const id = o.a === at ? o.b : o.a;
  return plan.points.find(p => p.id === id) ?? null;
}

/**
 * Points along a wall from a to b. With smoothness > 0 it becomes a
 * Catmull-Rom style curve through the neighbouring points.
 */
export function sampleSeg(plan: StructurePlan, seg: PlanSegment, steps = 20): V2[] {
  const A = plan.points.find(p => p.id === seg.a)!, B = plan.points.find(p => p.id === seg.b)!;
  const sm = segSmooth(plan, seg);
  if (sm <= 0) return [{ x: A.x, y: A.y }, { x: B.x, y: B.y }];
  const P = continuation(plan, seg.a, seg.b), N = continuation(plan, seg.b, seg.a);
  const ma = P ? { x: (B.x - P.x) / 2 * sm, y: (B.y - P.y) / 2 * sm } : { x: 0, y: 0 };
  const mb = N ? { x: (N.x - A.x) / 2 * sm, y: (N.y - A.y) / 2 * sm } : { x: 0, y: 0 };
  if (!P && !N) return [{ x: A.x, y: A.y }, { x: B.x, y: B.y }];
  const out: V2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out.push({
      x: Math.min(1, Math.max(0, h00 * A.x + h10 * ma.x + h01 * B.x + h11 * mb.x)),
      y: Math.min(1, Math.max(0, h00 * A.y + h10 * ma.y + h01 * B.y + h11 * mb.y)),
    });
  }
  return out;
}

export function polyLength(poly: V2[]) {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  return L;
}

/** Normalised arc-length parameter (0..1) of every vertex. */
export function polyParams(poly: V2[]): number[] {
  const L = polyLength(poly);
  const out = [0];
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    acc += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    out.push(L > 0 ? acc / L : i / (poly.length - 1));
  }
  return out;
}

/** Point at normalised arc-length parameter t. */
export function polyAt(poly: V2[], params: number[], t: number): V2 {
  if (poly.length === 1) return poly[0];
  for (let i = 1; i < poly.length; i++) {
    if (t <= params[i] + 1e-12 || i === poly.length - 1) {
      const span = params[i] - params[i - 1];
      const k = span > 0 ? Math.min(1, Math.max(0, (t - params[i - 1]) / span)) : 0;
      return { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * k, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * k };
    }
  }
  return poly[poly.length - 1];
}

/** Shortest wall path between two points of a plan, as point ids (null if not connected). */
export function shortestPath(plan: StructurePlan, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const pos = new Map(plan.points.map(p => [p.id, p]));
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const todo = new Set(plan.points.map(p => p.id));
  while (todo.size) {
    let u: string | null = null, best = Infinity;
    for (const id of todo) { const d = dist.get(id) ?? Infinity; if (d < best) { best = d; u = id; } }
    if (u === null) break;
    todo.delete(u);
    if (u === to) break;
    for (const sg of plan.segments) {
      const v = sg.a === u ? sg.b : sg.b === u ? sg.a : null;
      if (!v || !todo.has(v)) continue;
      const A = pos.get(u)!, B = pos.get(v)!;
      const nd = best + Math.hypot(A.x - B.x, A.y - B.y);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0])!);
  return path;
}

/** Sampled polyline following the walls along a point-id path. */
export function samplePath(plan: StructurePlan, path: string[]): V2[] {
  if (path.length === 1) { const p = plan.points.find(x => x.id === path[0])!; return [{ x: p.x, y: p.y }]; }
  const out: V2[] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const u = path[k], w = path[k + 1];
    const seg = plan.segments.find(x => (x.a === u && x.b === w) || (x.a === w && x.b === u))!;
    const sp = sampleSeg(plan, seg);
    if (seg.a !== u) sp.reverse();
    out.push(...(k ? sp.slice(1) : sp));
  }
  return out;
}
