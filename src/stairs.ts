// Staircase layout, shared by the 3D builder (steps, landings) and the planner (outline, arrows).
// Stairs follow a path drawn by the user (plan coordinates, from the bottom step up): each leg is a flight of
// steps, each corner a landing as wide as the stairs. Spiral stairs wind up around a post on their own.
// Everything here is in plan coordinates (0..1 of the building square); heights in metres from the floor.
import type { PlanObject } from './model';

export const RISER_MAX = 0.18; // m: steeper than this is flagged
export const RISER_MIN = 0.14; // m: shallower than this is flagged (not steep enough)
export const RISER_STD = 0.17; // m: step height of stairs that do not have to reach a floor
export const GOING = 0.28; // m: tread depth the flights are divided into
export const SPIRAL_STEPS_PER_TURN = 16;
export const SPIRAL_POST = 0.1; // m: radius of the central post

type P = { x: number; y: number };
export interface StairLayout {
  risers: number; riser: number; // number of risers up to the next floor and their height
  treads: { pts: P[]; top: number }[]; // outline of each tread and its top height
  platforms: { pts: P[]; top: number }[]; // landings
  footprint: P[][]; // outlines, for clicking
  path: P[]; // the walking line, from the first step up (for the arrows)
  flights: number;
  length: number; // m along the path
  rise: number; // m: how high they climb
  fit: 'good' | 'steep' | 'shallow';
  problem?: string;
}

const add = (a: P, b: P, k = 1): P => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: P) => Math.hypot(a.x, a.y);

/** How a staircase climbs `rise` metres (L: building base length, to turn metres into plan units). */
export function stairLayout(ob: PlanObject, rise: number, L: number): StairLayout {
  return ob.type === 'spiral' ? spiral(ob, rise, L) : drawn(ob, rise, L);
}

/** The path of drawn stairs (older stairs without one: a single flight along their length). */
export function stairPath(ob: PlanObject, L: number): P[] {
  if (ob.path && ob.path.length >= 2) return ob.path;
  return [localToPlan(ob, L, [0, ob.d / 2]), localToPlan(ob, L, [0, -ob.d / 2])];
}

/** Drawn stairs: flights along the path, a square landing at every corner; risers shared out over all the steps. */
function drawn(ob: PlanObject, rise: number, L: number): StairLayout {
  const path = stairPath(ob, L), w = ob.w / L, half = w / 2;
  const legs = path.slice(1).map((q, i) => { const d = sub(q, path[i]), l = len(d); return { a: path[i], b: q, d: l > 1e-12 ? { x: d.x / l, y: d.y / l } : { x: 0, y: 1 }, l }; });
  // each flight runs between the landings at its ends (half a stairs' width into each corner)
  const runs = legs.map((g, i) => Math.max(0, g.l - (i > 0 ? half : 0) - (i < legs.length - 1 ? half : 0)));
  const steps = runs.map(r => Math.floor((r * L) / GOING + 1e-6)); // treads per flight
  const risersOf = (s: number) => (s > 0 ? s + 1 : 0); // a flight of s treads climbs s + 1 risers (onto the landing / floor)
  // up to the next floor: the steps share out its height; else standard steps, as high as the path takes them
  const n = Math.max(1, steps.reduce((t, s) => t + risersOf(s), 0));
  if (!ob.toFloor) rise = n * RISER_STD;
  const riser = rise / n;
  const treads: StairLayout['treads'] = [], platforms: StairLayout['platforms'] = [];
  let done = 0;
  legs.forEach((g, i) => {
    const nrm = { x: -g.d.y, y: g.d.x }, s = steps[i];
    const start = add(g.a, g.d, i > 0 ? half : 0), go = s > 0 ? runs[i] / s : 0;
    for (let j = 0; j < s; j++) {
      const p0 = add(start, g.d, j * go), p1 = add(start, g.d, (j + 1) * go);
      treads.push({ pts: [add(p0, nrm, half), add(p1, nrm, half), add(p1, nrm, -half), add(p0, nrm, -half)], top: (done + j + 1) * riser });
    }
    done += risersOf(s);
    // the landing at the end of this leg (not after the last one: that is the floor above)
    if (i < legs.length - 1) {
      const c = g.b;
      platforms.push({ pts: [add(add(c, g.d, -half), nrm, half), add(add(c, g.d, half), nrm, half), add(add(c, g.d, half), nrm, -half), add(add(c, g.d, -half), nrm, -half)], top: done * riser });
    }
  });
  const total = legs.reduce((t, g) => t + g.l, 0) * L;
  let problem: string | undefined, fit: StairLayout['fit'] = 'good';
  const treadsNow = steps.reduce((t, s) => t + s, 0);
  if (riser > RISER_MAX + 1e-6) {
    fit = 'steep';
    const need = (Math.ceil(rise / RISER_MAX) - legs.length - treadsNow) * GOING;
    problem = `Too steep: steps of ${Math.round(riser * 100)} cm (at most ${RISER_MAX * 100} cm). Make the flights about ${Math.max(0.3, need).toFixed(1)} m longer in all.`;
  } else if (riser < RISER_MIN - 1e-6) {
    fit = 'shallow';
    const extra = treadsNow + legs.length - Math.ceil(rise / RISER_STD);
    problem = `Not steep enough: steps of only ${Math.round(riser * 100)} cm. The flights could be about ${Math.max(0.3, extra * GOING).toFixed(1)} m shorter in all.`;
  }
  return {
    risers: n, riser, treads, platforms, path, flights: legs.length, length: total, problem, rise, fit,
    footprint: [...treads.map(t => t.pts), ...platforms.map(p => p.pts)],
  };
}

/** Spiral stairs: wedge steps around a post, turning until the floor above (no landings). */
function spiral(ob: PlanObject, rise: number, L: number): StairLayout {
  const n = Math.max(2, Math.ceil(rise / RISER_MAX - 1e-9)), riser = rise / n;
  const R = ob.w / 2, th = (2 * Math.PI) / SPIRAL_STEPS_PER_TURN, dir = ob.flip ? -1 : 1;
  const a0 = Math.PI / 2; // first step points to local +z (the "near" side)
  const at = (r: number, a: number) => localToPlan(ob, L, [r * Math.cos(a), r * Math.sin(a)]);
  const treads: StairLayout['treads'] = [];
  for (let j = 0; j < n - 1; j++) {
    const aA = a0 + dir * j * th, aB = a0 + dir * (j + 1) * th;
    const pts: P[] = [at(SPIRAL_POST, aA)];
    for (let q = 0; q <= 4; q++) pts.push(at(R, aA + ((aB - aA) * q) / 4));
    pts.push(at(SPIRAL_POST, aB));
    treads.push({ pts, top: (j + 1) * riser });
  }
  const walk = R * 0.62, path: P[] = [];
  for (let j = 0; j <= (n - 1) * 3; j++) path.push(at(walk, a0 + dir * (j / 3) * th + dir * th * 0.5));
  const circle = Array.from({ length: 32 }, (_, k) => at(R + 0.05, (k / 32) * 2 * Math.PI));
  return { risers: n, riser, treads, platforms: [], footprint: [circle], path, flights: 1, length: ob.w, rise, fit: 'good',
    problem: R < 0.6 ? 'Narrow: spiral stairs are usually at least 1.2 m across' : undefined };
}

/** Local (metres; x across, z along, climbing towards −z) -> plan (0..1) for an object, matching the 3D builder's rotation. */
export function localToPlan(ob: PlanObject, L: number, p: [number, number]): { x: number; y: number } {
  const r = (ob.rot * Math.PI) / 180, x = p[0], z = p[1];
  return { x: ob.x + (x * Math.cos(r) + z * Math.sin(r)) / L, y: ob.y - (-x * Math.sin(r) + z * Math.cos(r)) / L };
}
