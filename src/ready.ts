// Ready-made designs (Design tab): built-in models arranged on their design type's reference shape.
import { Building, DecoDesign, DecoType, Design, OpeningShape, Project, uid } from './model';
import { BUILTIN_DESIGNS, SIMPLE_ARCH } from './builtin';
import { partFor } from './templates';

export const READY: { key: string; name: string; type: DecoType; models: string[]; about: string; tile?: boolean }[] = [
  { key: 'stone', name: 'Stone wall', type: 'wall', models: ['stoneWall'], about: 'Big ashlar blocks with deep chamfered joints', tile: true },
  { key: 'brick', name: 'Brick wall', type: 'wall', models: ['brickWall'], about: 'Brick facing in running bond', tile: true },
  { key: 'tiles', name: 'Clay tile roof', type: 'roof', models: ['roofTiles'], about: 'Courses of clay pan tiles up the slope', tile: true },
  { key: 'arch', name: 'Simple stone arch', type: 'opening', models: ['simpleArch'], about: 'Voussoirs with a keystone, imposts and jambs, on the Arch shape' },
  { key: 'cornice', name: 'Classical cornice', type: 'cornice', models: ['classicalCornice'], about: 'Cyma, corona with drip, dentils and an ovolo' },
  { key: 'step', name: 'Stone steps', type: 'stairs', models: ['stoneStep'], about: 'Solid stone steps with a rounded nosing' },
];

/** The Arch opening shape (made if the building has none). */
function archShape(b: Building): OpeningShape {
  const have = b.openingShapes.find(s => s.kind === 'opening' && (s.use === 'arch' || /^arch$/i.test(s.name)));
  if (have) return have;
  const sp = SIMPLE_ARCH.spring;
  const s: OpeningShape = {
    id: uid(), name: 'Arch', kind: 'opening', smooth: 0, w: SIMPLE_ARCH.w, h: SIMPLE_ARCH.h, anchor: 'bottom', use: 'arch',
    outlines: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: sp, s: 1 }, { x: 0.5, y: 1, s: 1 }, { x: 0, y: sp, s: 1 }]],
  };
  b.openingShapes.push(s);
  return s;
}

/** Adds a ready-made design (and the built-in models it uses) to the project; returns it. */
export function addReady(p: Project, b: Building, key: string): DecoDesign {
  const r = READY.find(x => x.key === key)!;
  const parts = r.models.map(m => {
    let d = p.designs.find(x => x.format === 'builtin' && x.builtin === m);
    if (!d) { d = { id: uid(), name: BUILTIN_DESIGNS[m].name, category: BUILTIN_DESIGNS[m].category, format: 'builtin', builtin: m } as Design; p.designs.push(d); }
    return partFor(m, d.id);
  });
  const deco: DecoDesign = { id: uid(), name: r.name, type: r.type, shapeId: r.type === 'opening' ? archShape(b).id : null, parts, ...(r.tile ? { tile: true } : {}) };
  p.decos.push(deco);
  return deco;
}
