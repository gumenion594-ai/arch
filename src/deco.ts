// Designs (decos): imported 3D models arranged around a reference shape. Shared by the Design editor and the builder.
import * as THREE from 'three';
import { Building, DecoDesign, DecoPart, DecoType, Design, PILASTER_REF_H } from './model';
import { designObject } from './assets';

/**
 * Size (m) of the reference shape a design is made around; the builder stretches this box onto the real element.
 * The box is centred on the origin. Openings / niches: the shape is a plane at z = 0, the outside face of the wall
 * (the wall is behind it, z < 0); the box depth is not stretched, so parts keep their distance from the face.
 */
export interface RefBox { w: number; h: number; d: number }
export const REF_WALL = 0.3; // wall thickness shown behind openings / niches
export function decoRef(deco: { type: DecoType; shapeId?: string | null }, b: Building): RefBox {
  switch (deco.type) {
    case 'opening': case 'niche': {
      const s = b.openingShapes.find(x => x.id === deco.shapeId);
      return { w: s?.w ?? 1.2, h: s?.h ?? 1.5, d: REF_WALL };
    }
    case 'balcony': {
      const s = b.balconyShapes.find(x => x.id === deco.shapeId) ?? b.balconyShapes[0];
      return { w: s?.w ?? 2.4, h: s?.thickness ?? 0.2, d: s?.d ?? 1.1 };
    }
    case 'pilaster': return { w: 0.5, h: PILASTER_REF_H, d: 0.15 }; // a plain rectangular column against the wall
    case 'column': return { w: 0.4, h: 3, d: 0.4 };
    case 'cornice': return { w: 3, h: 0.32, d: 0.34 };
    case 'wall': return { w: 3, h: 3, d: REF_WALL };
    case 'baluster': return { w: 1, h: 1, d: 0.2 }; // a 1 m section of railing (plinth, balusters, handrail), repeated along it
  }
}
/** Shape kinds a design type is made on (null: no choice of shape). */
export const decoShapeKind = (t: DecoType): 'opening' | 'niche' | 'balcony' | null =>
  t === 'opening' || t === 'niche' || t === 'balcony' ? t : null;

const rad = (d: number) => (d * Math.PI) / 180;

/** One part as an object in the reference frame (metres): the model fills its size box, rotated, at its position. */
export function partObject(src: THREE.Object3D, part: { pos: number[]; rot: number[]; size: number[] }): THREE.Group {
  const g = new THREE.Group();
  g.add(src.clone(true));
  g.position.set(part.pos[0], part.pos[1], part.pos[2]);
  g.rotation.set(rad(part.rot[0]), rad(part.rot[1]), rad(part.rot[2]));
  g.scale.set(part.size[0], part.size[1], part.size[2]);
  return g;
}

/**
 * A design as one object normalised like an imported model: its reference box becomes the 1 × 1 × 1 box at the
 * origin, so fitDesign / fitDesignSliced map the reference shape onto the real element (parts outside the box
 * keep their place relative to it). null while nothing of it is loaded.
 */
/** A part's look: texture > material > colour (null: keep the model's own). */
export type PartLook = (part: DecoPart) => THREE.Material | null;
export function applyLook(obj: THREE.Object3D, mat: THREE.Material | null) {
  if (!mat) return;
  // solid surfaces only: glass (see-through materials) stays glass
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const was = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(was) ? was.some(x => x.transparent && x.opacity < 0.9) : was.transparent && was.opacity < 0.9) return;
    m.material = mat;
  });
}
export function decoObject(deco: DecoDesign, b: Building, models: Design[], onLoad: () => void, look?: PartLook): THREE.Object3D | null {
  const R = decoRef(deco, b);
  const holder = new THREE.Group();
  holder.scale.set(1 / R.w, 1 / R.h, 1 / R.d);
  let any = false;
  for (const part of deco.parts) {
    const m = models.find(x => x.id === part.modelId);
    const src = m ? designObject(m, onLoad) : null;
    if (!src) continue;
    const po = partObject(src, part);
    applyLook(po, look?.(part) ?? null);
    holder.add(po);
    any = true;
  }
  if (!any) return null;
  const root = new THREE.Group();
  root.add(holder);
  root.userData.size = new THREE.Vector3(R.w, R.h, R.d);
  if (deco.type === 'column' || deco.type === 'pilaster') { root.userData.baseFrac = deco.base ?? 0.12; root.userData.topFrac = deco.top ?? 0.12; }
  root.userData.decoType = deco.type;
  root.updateMatrixWorld(true);
  return root;
}
