// Imported 3D design files: stored in IndexedDB (too big for the project's localStorage),
// parsed once with three.js loaders and kept in memory as a single mesh-able object.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Design } from './model';
import { BUILTIN_DESIGNS } from './builtin';

const DB = 'arch-assets', STORE = 'files';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function putAsset(id: string, data: ArrayBuffer) {
  const d = await db();
  await new Promise<void>((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(data, id); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
export async function getAsset(id: string): Promise<ArrayBuffer | undefined> {
  const d = await db();
  return new Promise((res, rej) => { const r = d.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
export async function deleteAsset(id: string) {
  const d = await db();
  d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
}

export const formatOf = (name: string): Design['format'] | null => {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'stl' ? ext : null;
};

/** Parse a design file into one object, normalised to fit a 1 × 1 × 1 box at the origin (x: width, y: height, z: depth). */
async function parse(format: Design['format'], data: ArrayBuffer): Promise<THREE.Object3D> {
  let obj: THREE.Object3D;
  if (format === 'builtin') throw new Error('built-in designs are generated');
  if (format === 'stl') {
    const geo = new STLLoader().parse(data);
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.7 }));
  } else if (format === 'obj') {
    obj = new OBJLoader().parse(new TextDecoder().decode(data));
    obj.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.7 }); });
  } else {
    const gltf = await new GLTFLoader().parseAsync(data, '');
    obj = gltf.scene;
  }
  return normalizeObject(obj);
}

/** Wrap an object so it fills a 1 × 1 × 1 box at the origin; its original size is kept in userData.size. */
function normalizeObject(obj: THREE.Object3D): THREE.Object3D {
  const wrap = new THREE.Group();
  wrap.add(obj);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  obj.position.sub(c);
  const outer = new THREE.Group();
  outer.add(wrap);
  outer.scale.set(1 / (size.x || 1), 1 / (size.y || 1), 1 / (size.z || 1));
  outer.userData.size = size; // original proportions
  return outer;
}

const cache = new Map<string, THREE.Object3D>();
const pending = new Map<string, Promise<void>>();

/** The design's object if loaded; otherwise starts loading it and calls onLoad when ready. */
export function designObject(d: Design, onLoad: () => void): THREE.Object3D | null {
  const hit = cache.get(d.id);
  if (hit) return hit;
  if (d.format === 'builtin') {
    const b = d.builtin ? BUILTIN_DESIGNS[d.builtin] : undefined;
    if (!b) return null;
    const o = normalizeObject(b.make());
    cache.set(d.id, o);
    return o;
  }
  if (!pending.has(d.id)) {
    pending.set(d.id, (async () => {
      try {
        const data = await getAsset(d.id);
        if (data) { cache.set(d.id, await parse(d.format, data)); onLoad(); }
      } catch (e) { console.error('Could not load design', d.name, e); }
    })());
  }
  return null;
}

/** Check a file parses (so a bad import is refused right away), then store it. */
export async function importDesignFile(id: string, format: Design['format'], data: ArrayBuffer) {
  cache.set(id, await parse(format, data));
  await putAsset(id, data);
}

/**
 * A copy of a design fitted into a box: width along `along`, height up, depth along `out`,
 * with its centre at `center`. Stretches as needed (designs distort to fit).
 */
export function fitDesign(src: THREE.Object3D, center: THREE.Vector3, along: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3, w: number, h: number, d: number): THREE.Object3D {
  const o = src.clone(true);
  const inner = new THREE.Group();
  inner.add(o);
  inner.scale.set(w, h, d);
  const frame = new THREE.Group();
  frame.add(inner);
  // a proper rotation: if along × up points away from `out`, run along the other way
  const a = along.clone().normalize(), u = up.clone().normalize();
  if (new THREE.Vector3().crossVectors(a, u).dot(out) < 0) a.negate();
  const m = new THREE.Matrix4().makeBasis(a, u, new THREE.Vector3().crossVectors(a, u).normalize());
  frame.quaternion.setFromRotationMatrix(m);
  frame.position.copy(center);
  return frame;
}
