// Staircase layout, shared by the 3D builder (steps, platforms) and the planner (footprint, UP arrow).
// Local coordinates (metres) of a stairs object: x across, z along its length; you climb towards −z,
// starting at the near end z = +d/2. Heights are from the floor the stairs start on.
import type { PlanObject } from './model';

export const RISER_MAX = 0.18; // m: no step higher than this
export const GOING = 0.28; // m: every tread is this deep (straight stairs)
export const SPIRAL_STEPS_PER_TURN = 16;
export const SPIRAL_POST = 0.1; // m: radius of the central post

type P2 = [number, number];
export interface StairLayout {
  risers: number; riser: number; // number of risers and their height
  treads: { pts: P2[]; top: number }[]; // the tread outline and its top height
  platforms: { pts: P2[]; top: number }[];
  footprint: P2[]; // what the stairs occupy (a hole in every floor they pass through / arrive at)
  path: P2[]; // the walking line, from the first step up (for the UP arrow)
  flights: number;
  length: number; // length used along the stairs (straight) or the diameter (spiral)
  problem?: string; // e.g. too short to reach the next floor
}

const rect = (x0: number, x1: number, z0: number, z1: number): P2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** How a staircase of this size climbs `rise` metres. */
export function stairLayout(ob: PlanObject, rise: number): StairLayout {
  const n = Math.max(2, Math.ceil(rise / RISER_MAX - 1e-9));
  const riser = rise / n;
  return ob.type === 'spiral' ? spiral(ob, n, riser) : straight(ob, n, riser);
}

/**
 * Straight stairs: one flight if it fits the length; otherwise a flight up to a platform (the platform is
 * within the length), back the other way beside it, and so on until the next floor. Each flight of k risers
 * has k − 1 treads; its last riser steps onto the platform (or the floor above).
 */
function straight(ob: PlanObject, n: number, riser: number): StairLayout {
  const w = ob.w, L = ob.d, P = Math.max(1, w); // platforms at least as deep as the stairs are wide (and 1 m)
  const fit = (len: number) => Math.floor(len / GOING + 1e-6) + 1; // risers a flight of this length can take
  const counts: number[] = [];
  let left = n, problem: string | undefined;
  if (fit(L) >= n) counts.push(n);
  else {
    for (let i = 0; left > 0 && i < 50; i++) {
      const last = fit(i === 0 ? L : L - P); // as the final flight
      if (left <= last) { counts.push(left); left = 0; break; }
      const k = fit(i === 0 ? L - P : L - 2 * P); // with a platform at each end it touches
      if (k < 2) { problem = `Too short: make it at least ${(2 * P + GOING + 0.01).toFixed(2)} m long (or wider apart floors need longer stairs)`; counts.push(left); left = 0; break; }
      counts.push(k); left -= k;
    }
  }
  const side = ob.flip ? -1 : 1; // the next flight goes on the right (or left)
  const laneX = (i: number) => (i % 2 === 0 ? 0 : side * w);
  const zOf = (s: number) => L / 2 - s; // distance from the near end -> local z
  const treads: StairLayout['treads'] = [], platforms: StairLayout['platforms'] = [], path: P2[] = [];
  let done = 0, used = 0;
  let start = 0; // where the next flight starts (distance from the near end)
  for (let i = 0; i < counts.length; i++) {
    const k = counts[i], dir = i % 2 === 0 ? 1 : -1, last = i === counts.length - 1, cx = laneX(i);
    const run = (k - 1) * GOING;
    // the last flight ends right at the end of the stairs, so it steps straight onto the floor above
    let s0 = start;
    if (last && counts.length > 1) s0 = dir > 0 ? L - run : run;
    // platform before this flight: from where the previous flight ended to the end, on both lanes
    if (i > 0) {
      const prevEnd = start, endS = dir > 0 ? 0 : L, top = done * riser;
      const span = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
      const [a0, a1] = span(prevEnd, endS), [b0, b1] = span(s0, endS);
      platforms.push({ pts: rect(laneX(i - 1) - w / 2, laneX(i - 1) + w / 2, zOf(a1), zOf(a0)), top });
      platforms.push({ pts: rect(cx - w / 2, cx + w / 2, zOf(b1), zOf(b0)), top });
      path.push([(laneX(i - 1) + cx) / 2, zOf(dir > 0 ? Math.min(prevEnd, s0) / 2 : (Math.max(prevEnd, s0) + L) / 2)]);
    }
    path.push([cx, zOf(s0)]);
    for (let j = 0; j < k - 1; j++) {
      const a = s0 + dir * j * GOING, b = s0 + dir * (j + 1) * GOING;
      treads.push({ pts: rect(cx - w / 2, cx + w / 2, zOf(Math.max(a, b)), zOf(Math.min(a, b))), top: (done + j + 1) * riser });
    }
    const end = s0 + dir * run;
    path.push([cx, zOf(end)]);
    used = Math.max(used, dir > 0 ? end : s0);
    done += k;
    start = end;
  }
  if (counts.length > 1) used = L;
  const xs = counts.length > 1 ? [Math.min(0, side * w) - w / 2, Math.max(0, side * w) + w / 2] : [-w / 2, w / 2];
  return {
    risers: n, riser, treads, platforms, path, flights: counts.length, length: used, problem,
    footprint: rect(xs[0], xs[1], zOf(used), zOf(0)),
  };
}

/** Spiral stairs: wedge steps around a post, turning until the floor above (no platforms). */
function spiral(ob: PlanObject, n: number, riser: number): StairLayout {
  const R = ob.w / 2, th = (2 * Math.PI) / SPIRAL_STEPS_PER_TURN, dir = ob.flip ? -1 : 1;
  const a0 = Math.PI / 2; // first step points to local +z (the "near" side)
  const at = (r: number, a: number): P2 => [r * Math.cos(a), r * Math.sin(a)];
  const treads: StairLayout['treads'] = [];
  for (let j = 0; j < n - 1; j++) {
    const aA = a0 + dir * j * th, aB = a0 + dir * (j + 1) * th;
    const pts: P2[] = [at(SPIRAL_POST, aA)];
    for (let q = 0; q <= 4; q++) pts.push(at(R, aA + ((aB - aA) * q) / 4));
    pts.push(at(SPIRAL_POST, aB));
    treads.push({ pts, top: (j + 1) * riser });
  }
  const walk = R * 0.62, path: P2[] = [];
  for (let j = 0; j <= (n - 1) * 3; j++) path.push(at(walk, a0 + dir * (j / 3) * th + dir * th * 0.5));
  const footprint: P2[] = Array.from({ length: 32 }, (_, k) => at(R + 0.05, (k / 32) * 2 * Math.PI));
  return { risers: n, riser, treads, platforms: [], footprint, path, flights: 1, length: ob.w,
    problem: R < 0.6 ? 'Narrow: spiral stairs are usually at least 1.2 m across' : undefined };
}

/** Local (metres) -> plan (0..1) for an object, matching the 3D builder's rotation. */
export function localToPlan(ob: PlanObject, L: number, p: P2): { x: number; y: number } {
  const r = (ob.rot * Math.PI) / 180, x = p[0], z = p[1];
  return { x: ob.x + (x * Math.cos(r) + z * Math.sin(r)) / L, y: ob.y - (-x * Math.sin(r) + z * Math.cos(r)) / L };
}
