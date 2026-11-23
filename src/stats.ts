// Quantities: height, floor area, wall / column volumes and weights (run on demand).
import * as THREE from 'three';
import { Building, MATERIALS, Texture, elevation } from './model';
import { Mats, StatInfo, buildStructure, floorArea, meshVolume } from './build3d';

export interface Amount { volume: number; weight: number }
export interface Report {
  height: number; depth: number; floorArea: number; floors: number;
  windowCount: number; windowArea: number;
  ext: Amount; int: Amount; col: Amount;
  byMaterial: Record<string, Amount>;
}

export function calculate(b: Building, textures: Texture[]): Report {
  const m = new THREE.MeshBasicMaterial();
  const line = new THREE.LineBasicMaterial();
  const mats: Mats = { wall: () => m, column: () => m, slab: m, object: m, edge: line, selected: m, selLine: line, tex: () => null };
  const { group, stats } = buildStructure(b, { detailed: false, interior: true, mats, textures });
  const zero = (): Amount => ({ volume: 0, weight: 0 });
  const r: Report = {
    height: 0, depth: -elevation(b, 0), floorArea: 0, floors: b.floors.length,
    windowCount: stats.windowCount, windowArea: stats.windowArea,
    ext: zero(), int: zero(), col: zero(), byMaterial: {},
  };
  const box = new THREE.Box3();
  group.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!);
    const st = mesh.userData.stat as StatInfo | undefined;
    if (!st) return;
    const v = meshVolume(mesh.geometry);
    const w = v * (MATERIALS[st.material]?.density ?? 0);
    const add = (a: Amount) => { a.volume += v; a.weight += w; };
    add(r[st.cat]);
    add((r.byMaterial[st.material] ??= zero()));
  });
  group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
  r.height = Math.max(0, box.isEmpty() ? elevation(b, b.floors.length) : box.max.y);
  for (let i = 0; i < b.floors.length; i++) r.floorArea += floorArea(b, i);
  return r;
}
