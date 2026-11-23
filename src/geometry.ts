// 2D helpers for plans (coordinates in the 0..1 building square).
import type { StructurePlan } from './model';

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
      if (poly.length >= 3 && signedArea(poly) > 1e-9) faces.push(poly);
    }
  }
  return faces;
}
