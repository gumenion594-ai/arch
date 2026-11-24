// Design tab, right panel: design types, the designs of a type, the reference shape, the placed models
// (position / rotation / size) and the library of imported 3D models.
import type { Editor } from './editor';
import { DECO_TYPES, DecoDesign, DecoPart, DecoType, Design, DesignCategory, uid } from './model';
import { decoRef } from './deco';
import { formatOf, importDesignFile, deleteAsset } from './assets';
import { BUILTIN_DESIGNS } from './builtin';
import { askConfirm, askText, h, num, put, toast } from './ui';
import { fmt } from './planner';

const ONE: Record<DecoType, string> = { opening: 'opening', niche: 'niche', balcony: 'balcony', pilaster: 'pilaster', column: 'column', cornice: 'cornice', wall: 'wall', baluster: 'baluster' };
/** Library category a model imported for a design type goes in (only used to group the list). */
const CAT: Record<DecoType, DesignCategory> = { opening: 'surround', niche: 'nicheDeco', balcony: 'balcony', pilaster: 'column', column: 'column', cornice: 'cornice', wall: 'model', baluster: 'baluster' };

/** Shapes a design of this type can be made on. */
function shapesFor(ed: Editor, t: DecoType): { id: string; name: string }[] | null {
  const b = ed.b;
  if (t === 'opening' || t === 'niche') return b.openingShapes.filter(s => s.kind === t);
  if (t === 'balcony') return b.balconyShapes;
  if (t === 'pilaster') return b.pilasterShapes;
  return null;
}

/** Where a design is used, and how to use it everywhere it fits. */
function usage(ed: Editor, d: DecoDesign) {
  const b = ed.b, segs = [...b.plans, ...b.interiorPlans].flatMap(pl => pl.segments);
  const places = b.placements.filter(x => x.type === d.type && (d.type === 'cornice' || !d.shapeId || x.shapeId === d.shapeId));
  switch (d.type) {
    case 'opening': case 'niche': case 'balcony': case 'pilaster': case 'cornice':
      return { used: b.placements.filter(x => x.designId === d.id).length, all: () => places.forEach(x => (x.designId = d.id)), none: () => b.placements.forEach(x => { if (x.designId === d.id) x.designId = null; }) };
    case 'column': {
      const list = segs.filter(s => s.kind === 'colonnade');
      return { used: segs.filter(s => s.columnDesign === d.id).length, all: () => list.forEach(s => (s.columnDesign = d.id)), none: () => segs.forEach(s => { if (s.columnDesign === d.id) s.columnDesign = null; }) };
    }
    case 'baluster': {
      const list = segs.filter(s => s.kind === 'balustrade' || !s.kind || s.kind === 'wall');
      return { used: segs.filter(s => s.balusterDesign === d.id).length, all: () => list.forEach(s => (s.balusterDesign = d.id)), none: () => segs.forEach(s => { if (s.balusterDesign === d.id) s.balusterDesign = null; }) };
    }
    case 'wall': {
      const list = b.plans.flatMap(pl => pl.segments).filter(s => !s.kind || s.kind === 'wall');
      return { used: segs.filter(s => s.wallDesign === d.id).length, all: () => list.forEach(s => (s.wallDesign = d.id)), none: () => segs.forEach(s => { if (s.wallDesign === d.id) s.wallDesign = null; }) };
    }
  }
}

export function renderDecoPanel(ed: Editor) {
  const p = ed.p, b = ed.b, t = ed.decoType;
  const list = p.decos.filter(d => d.type === t);
  const cur = ed.deco();
  const view = ed.decoView;
  const select = (id: string | null) => { if (id) ed.activeDeco[t] = id; ed.decoPart = null; ed.refresh(); };
  const typeBtn = (k: DecoType) => h('button', { class: t === k ? 'tab active' : 'tab', onclick: () => { ed.decoType = k; ed.decoPart = null; ed.refresh(); } }, DECO_TYPES[k]);
  const create = async () => {
    const name = await askText(`Name the new ${ONE[t]} design`, `${ONE[t][0].toUpperCase() + ONE[t].slice(1)} design ${list.length + 1}`);
    if (!name?.trim()) return;
    const d: DecoDesign = { id: uid(), name: name.trim(), type: t, shapeId: shapesFor(ed, t)?.[0]?.id ?? null, parts: [] };
    ed.mutate(() => p.decos.push(d));
    select(d.id);
  };
  const shapes = shapesFor(ed, t);
  const part = cur?.parts.find(x => x.id === ed.decoPart) ?? null;
  const R = cur ? decoRef(cur, b) : null;
  const use = cur ? usage(ed, cur) : null;

  ed.right.innerHTML = '';
  put(ed.right,
    h('div', { class: 'box-title' }, 'Design type'),
    h('div', { class: 'row' }, ...(Object.keys(DECO_TYPES) as DecoType[]).map(typeBtn)),
    h('div', { class: 'box-title' }, `${ONE[t][0].toUpperCase() + ONE[t].slice(1)} designs`),
    list.length ? h('div', { class: 'plans' }, ...list.map(d => h('div', { class: 'plan-row' + (d.id === cur?.id ? ' active' : ''), onclick: () => select(d.id) },
      d.name, h('span', { class: 'muted small' }, ` ${d.parts.length} model${d.parts.length === 1 ? '' : 's'}`)))) : h('div', { class: 'muted small' }, `No ${ONE[t]} designs yet.`),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: create }, 'New design'),
      h('button', { disabled: !cur, onclick: () => cur && ed.mutate(() => { const c: DecoDesign = { ...JSON.parse(JSON.stringify(cur)), id: uid(), name: `${cur.name} copy` }; p.decos.push(c); ed.activeDeco[t] = c.id; }) }, 'Save as copy'),
      h('button', { disabled: !cur, onclick: async () => { const n = cur && await askText('Rename design', cur.name); if (cur && n?.trim()) ed.mutate(() => (cur.name = n.trim())); } }, 'Rename'),
      h('button', {
        class: 'danger', disabled: !cur,
        onclick: async () => {
          if (!cur || !(await askConfirm(`Delete the design “${cur.name}”? What uses it goes back to the plain look.`))) return;
          ed.mutate(() => { usage(ed, cur).none(); p.decos = p.decos.filter(x => x !== cur); });
          select(null);
        },
      }, 'Delete'),
    ),
    cur && shapes ? shapeField(ed, cur, shapes) : null,
    cur && (t === 'column' || t === 'pilaster') ? h('div', { class: 'row' },
      pctField(ed, 'Base (% of height)', cur.base ?? 0.12, v => (cur.base = v)),
      pctField(ed, 'Top (% of height)', cur.top ?? 0.12, v => (cur.top = v))) : null,
    cur && R ? h('div', { class: 'muted small' }, `Reference: ${fmt(R.w)} × ${fmt(R.h)} m${t === 'opening' || t === 'niche' ? ' (the blue plane is the outside face of the opening)' : ''}. The orange dashed box is stretched onto the real ${ONE[t]} in the Detailed view; models keep their place around it.`) : null,
    cur ? partsBox(ed, cur, part) : null,
    cur && part && view ? partBox(ed, cur, part) : null,
    cur && use ? h('div', { class: 'box' },
      h('div', { class: 'box-title' }, `Used ${use.used}×`),
      h('div', { class: 'row' },
        h('button', { onclick: () => ed.mutate(() => use.all()), title: 'Put this design on every one that fits in this building' },
          t === 'opening' || t === 'niche' || t === 'balcony' || t === 'pilaster' ? `Use on every ${ONE[t]} with this shape` : `Use on every ${ONE[t]}`),
        h('button', { disabled: !use.used, onclick: () => ed.mutate(() => use.none()) }, 'Stop using')),
      h('div', { class: 'muted small' }, t === 'wall' ? 'Wall designs go on every division of the walls that use them (the structure plan’s walls, all floors using it).' : 'Or pick it on single elements: select them in the 3D view (or walls in the Structure tab).')) : null,
    libraryBox(ed, cur),
  );
}

function shapeField(ed: Editor, cur: DecoDesign, shapes: { id: string; name: string }[]) {
  const sel = h('select', { onchange: () => ed.mutate(() => (cur.shapeId = sel.value)) }, ...shapes.map(s => h('option', { value: s.id }, s.name)));
  sel.value = cur.shapeId ?? shapes[0]?.id ?? '';
  return h('label', { title: 'The shape this design is made around (drawn in the Shape tab)' }, 'Made on the shape', sel);
}

function pctField(ed: Editor, label: string, v: number, set: (v: number) => void) {
  const inp = h('input', { type: 'number', step: 1, min: 0, max: 45, value: String(Math.round(v * 100)), onchange: () => { const x = num(inp.value); if (x >= 0 && x <= 45) ed.mutate(() => set(x / 100)); else ed.refresh(); } });
  return h('label', { title: 'These parts keep their size on the building; the part between them stretches' }, label, inp);
}

/** The models in the design. */
function partsBox(ed: Editor, cur: DecoDesign, part: DecoPart | null) {
  const name = (pp: DecoPart) => ed.p.designs.find(m => m.id === pp.modelId)?.name ?? '(missing model)';
  return h('div', { class: 'box' },
    h('div', { class: 'box-title' }, `Models in this design (${cur.parts.length})`),
    cur.parts.length ? h('div', { class: 'plans' }, ...cur.parts.map(pp => h('div', {
      class: 'plan-row' + (pp.id === part?.id ? ' active' : ''), onclick: () => { ed.decoPart = pp.id; ed.decoView?.select(pp.id); ed.renderRight(); },
    }, name(pp)))) : h('div', { class: 'muted small' }, 'Add models from the library below. They start the size of the shape; then move, turn and scale them into place.'),
  );
}

/** The selected model: gizmo mode and exact numbers. */
function partBox(ed: Editor, cur: DecoDesign, part: DecoPart) {
  const view = ed.decoView!, R = decoRef(cur, ed.b);
  const modeBtn = (m: 'translate' | 'rotate' | 'scale', label: string) => h('button', { class: view.mode === m ? 'tab active' : 'tab', onclick: () => { view.setMode(m); ed.renderRight(); } }, label);
  const trio = (label: string, key: 'pos' | 'rot' | 'size', step: number) => h('div', {},
    h('div', { class: 'muted small' }, label),
    h('div', { class: 'row' }, ...(['x', 'y', 'z'] as const).map((ax, i) => {
      const inp = h('input', {
        type: 'number', step, value: String(part[key][i]), title: ax,
        onchange: () => {
          const v = num(inp.value);
          if (!isFinite(v) || (key === 'size' && v <= 0)) return ed.refresh();
          ed.mutate(() => { const a = [...part[key]] as [number, number, number]; a[i] = v; part[key] = a; });
        },
      });
      return h('label', {}, ax, inp);
    })));
  return h('div', { class: 'box' },
    h('div', { class: 'box-title' }, 'Selected model'),
    h('div', { class: 'row' }, modeBtn('translate', 'Move (W)'), modeBtn('rotate', 'Rotate (E)'), modeBtn('scale', 'Scale (R)')),
    h('div', { class: 'muted small' }, 'Drag the arrows / rings / handles in the view. x = along, y = up, z = out from the wall (metres, degrees).'),
    trio('Position (m)', 'pos', 0.01), trio('Rotation (°)', 'rot', 5), trio('Size (m)', 'size', 0.01),
    h('div', { class: 'row' },
      h('button', { title: 'Back to the size and place of the shape', onclick: () => ed.mutate(() => { part.pos = [0, 0, 0]; part.rot = [0, 0, 0]; part.size = [R.w, R.h, R.d]; }) }, 'Fit to the shape'),
      h('button', { onclick: () => { const c: DecoPart = { ...JSON.parse(JSON.stringify(part)), id: uid() }; ed.mutate(() => cur.parts.push(c)); ed.decoPart = c.id; ed.refresh(); } }, 'Duplicate'),
      h('button', { title: 'Mirror left ↔ right (a copy on the other side)', onclick: () => { const c: DecoPart = { ...JSON.parse(JSON.stringify(part)), id: uid() }; c.pos = [-part.pos[0], part.pos[1], part.pos[2]]; c.rot = [part.rot[0], -part.rot[1], -part.rot[2]]; ed.mutate(() => cur.parts.push(c)); ed.decoPart = c.id; ed.refresh(); } }, 'Mirrored copy'),
      h('button', { class: 'danger', onclick: () => { ed.mutate(() => (cur.parts = cur.parts.filter(x => x !== part))); ed.decoPart = null; ed.refresh(); } }, 'Remove (Del)')),
  );
}

/** Imported 3D models (the library): import, add to the design, delete. */
function libraryBox(ed: Editor, cur: DecoDesign | null) {
  const p = ed.p;
  const file = h('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl', multiple: true, style: 'display:none' });
  file.addEventListener('change', async () => {
    const files = [...(file.files ?? [])];
    file.value = '';
    for (const f of files) {
      const format = formatOf(f.name);
      if (!format) { toast(`${f.name}: use a .glb, .gltf (self-contained), .obj or .stl file`); continue; }
      const d: Design = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), category: CAT[ed.decoType], format };
      try {
        await importDesignFile(d.id, format, await f.arrayBuffer());
        ed.mutate(() => p.designs.push(d));
        toast(`Imported “${d.name}”`);
      } catch (e) { console.error(e); toast(`Could not read ${f.name}`); }
    }
  });
  const add = (m: Design) => {
    if (!cur) return toast('Create a design first (New design)');
    const R = decoRef(cur, ed.b);
    const part: DecoPart = { id: uid(), modelId: m.id, pos: [0, 0, 0], rot: [0, 0, 0], size: [R.w, R.h, R.d] }; // starts as big as the shape, where it is
    ed.mutate(() => cur.parts.push(part));
    ed.decoPart = part.id;
    ed.refresh();
  };
  return h('div', { class: 'box' },
    h('div', { class: 'box-title' }, `3D models (${p.designs.length})`),
    h('div', { class: 'row' }, h('button', { onclick: () => file.click() }, 'Import 3D files…'), file,
      ...Object.entries(BUILTIN_DESIGNS).map(([key, bd]) => h('button', {
        disabled: p.designs.some(d => d.builtin === key), title: 'A model made by the app',
        onclick: () => ed.mutate(() => p.designs.push({ id: uid(), name: bd.name, category: bd.category, format: 'builtin', builtin: key })),
      }, `+ ${bd.name}`))),
    p.designs.length ? h('div', {}, ...p.designs.map(m => h('div', { class: 'lib-row' },
      h('span', { style: 'flex:1' }, m.name),
      h('button', { disabled: !cur, title: cur ? `Add to “${cur.name}”` : 'Create a design first', onclick: () => add(m) }, 'Add'),
      h('button', {
        class: 'danger', title: 'Delete from the library',
        onclick: async () => {
          if (!(await askConfirm(`Delete the model “${m.name}”? Designs lose it.`, 'Delete'))) return;
          ed.mutate(() => {
            p.designs = p.designs.filter(x => x !== m);
            p.decos.forEach(d => (d.parts = d.parts.filter(x => x.modelId !== m.id)));
          });
          if (m.format !== 'builtin') deleteAsset(m.id);
        },
      }, '×')))) : h('div', { class: 'muted small' }, 'Import .glb, .gltf, .obj or .stl files. They are kept in this browser and saved with the project file.'),
  );
}
