// 3D-view side panel (selecting, adding elements, colours, imported designs) and the
// design modes for openings, niches and balconies.
import type { Editor } from './editor';
import {
  BalconyShape, DESIGN_CATEGORIES, Design, DesignCategory, OpeningShape, Placement, PlacementType, PlanSegment, StructurePlan, WinPoint,
  divisionBorders, floorLabel, planForFloor, segDivLen, segKind, uid,
} from './model';
import { polyLength, sampleSeg } from './geometry';
import { Hit } from './viewer';
import { ShapeEditor, ShapeHost } from './shapeeditor';
import { formatOf, importDesignFile, deleteAsset } from './assets';
import { askConfirm, askText, h, num, put, toast } from './ui';
import { fmt } from './planner';

export type PickMode = 'element' | 'division' | 'border' | 'wall' | 'floor';

/** Division borders (m from the wall start) of a wall on a floor. */
export function wallBorders(ed: Editor, plan: StructurePlan, seg: PlanSegment): number[] {
  const L = polyLength(sampleSeg(plan, seg)) * ed.b.baseLength;
  return divisionBorders(L, segDivLen(ed.b, seg));
}

// ---------------------------------------------------------------- picking
export function onPick(ed: Editor, hit: Hit | null, e: MouseEvent) {
  if (!hit) { if (!e.shiftKey) ed.clearSel(); return; }
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  const toggle = (set: Set<string>, key: string) => {
    if (!add) { ed.clearSets(); set.add(key); return; }
    set.has(key) ? set.delete(key) : set.add(key);
  };
  const uv = hit.uvOf ? hit.uvOf(hit.point) : null;
  const pl = hit.placementId ? ed.b.placements.find(x => x.id === hit.placementId) : undefined;
  const mode = ed.pickMode;
  if (mode === 'element') {
    let id = hit.placementId;
    if (!id && uv && hit.holes) id = hit.holes.find(o => uv.u >= o.u0 && uv.u <= o.u1 && uv.v >= o.v0 && uv.v <= o.v1)?.id;
    if (id) toggle(ed.selElements, id); else if (!add) ed.clearSets();
  } else if (mode === 'floor' || !hit.segId || hit.interior) {
    toggle(ed.selFloors, hit.floorId);
  } else if (mode === 'wall') {
    toggle(ed.selWalls, `${hit.floorId}|${hit.segId}`);
  } else {
    const bs = hit.borders ?? [0, 1];
    let k: number;
    if (pl) k = pl.div ?? 0;
    else if (!uv) k = 0;
    else if (mode === 'border') k = bs.reduce((best, b, i) => (Math.abs(b - uv.u) < Math.abs(bs[best] - uv.u) ? i : best), 0);
    else k = Math.max(0, Math.min(bs.length - 2, bs.findIndex((b, i) => i < bs.length - 1 && uv.u >= b && uv.u <= bs[i + 1])));
    toggle(mode === 'border' ? ed.selBorders : ed.selDivs, `${hit.floorId}|${hit.segId}|${k}`);
  }
  ed.refresh();
}

/** Targets of the 3D selection: wall divisions, borders, and the walls they are on. */
function targets(ed: Editor) {
  const b = ed.b;
  const divs: { floorId: string; seg: PlanSegment; k: number }[] = [];
  const borders: { floorId: string; seg: PlanSegment; k: number }[] = [];
  const walls: { floorId: string; seg: PlanSegment }[] = [];
  const segOf = (fid: string, sid: string) => planForFloor(b, fid)?.segments.find(s => s.id === sid);
  const addWall = (fid: string, seg: PlanSegment, corners: 'all' | 'start') => {
    if (segKind(seg) !== 'wall') return;
    walls.push({ floorId: fid, seg });
    const n = wallBorders(ed, planForFloor(b, fid)!, seg).length - 1;
    for (let k = 0; k < n; k++) divs.push({ floorId: fid, seg, k });
    for (let k = 0; k <= (corners === 'all' ? n : n - 1); k++) borders.push({ floorId: fid, seg, k });
  };
  for (const fid of ed.selFloors) planForFloor(b, fid)?.segments.forEach(s => addWall(fid, s, 'start')); // corners once per floor
  for (const key of ed.selWalls) { const [fid, sid] = key.split('|'); const s = segOf(fid, sid); if (s) addWall(fid, s, 'all'); }
  for (const key of ed.selDivs) { const [fid, sid, k] = key.split('|'); const s = segOf(fid, sid); if (s && segKind(s) === 'wall') divs.push({ floorId: fid, seg: s, k: +k }); }
  for (const key of ed.selBorders) { const [fid, sid, k] = key.split('|'); const s = segOf(fid, sid); if (s && segKind(s) === 'wall') borders.push({ floorId: fid, seg: s, k: +k }); }
  const segs = [...new Set([...ed.selWalls].map(k => k.split('|')).map(([f, s]) => segOf(f, s)).filter(Boolean) as PlanSegment[])];
  for (const fid of ed.selFloors) planForFloor(b, fid)?.segments.forEach(s => segs.includes(s) || segs.push(s));
  return { divs, borders, walls, segs };
}

// ---------------------------------------------------------------- 3D view panel
const TYPE_LABEL: Record<PlacementType, string> = { opening: 'Opening', niche: 'Niche', balcony: 'Balcony', cornice: 'Cornice', pilaster: 'Pilaster', model: '3D model' };

export function renderViewPanel(ed: Editor) {
  const b = ed.b, p = ed.p;
  const nSel = ed.selFloors.size + ed.selWalls.size + ed.selDivs.size + ed.selBorders.size + ed.selElements.size;
  const pm = (m: PickMode, label: string, title: string) => h('button', { class: ed.pickMode === m ? 'tab active' : 'tab', title, onclick: () => { ed.pickMode = m; ed.refresh(); } }, label);
  const parts = [
    ed.selFloors.size && `${ed.selFloors.size} floor(s)`, ed.selWalls.size && `${ed.selWalls.size} wall(s)`,
    ed.selDivs.size && `${ed.selDivs.size} division(s)`, ed.selBorders.size && `${ed.selBorders.size} border(s)`,
    ed.selElements.size && `${ed.selElements.size} element(s)`,
  ].filter(Boolean);
  const firstWall = [...ed.selWalls, ...ed.selDivs, ...ed.selBorders][0]?.split('|') ?? (ed.selFloors.size ? [[...ed.selFloors][0]] : null);
  const elems = b.placements.filter(x => ed.selElements.has(x.id));
  const T = nSel ? targets(ed) : null;

  ed.right.innerHTML = '';
  put(ed.right,
    h('div', { class: 'box-title' }, 'Select in 3D'),
    h('div', { class: 'row' },
      pm('element', 'Element', 'Openings, niches, cornices, pilasters, balconies, models'),
      pm('division', 'Division', 'A division of a wall'),
      pm('border', 'Border', 'The border between two divisions (for pilasters)'),
      pm('wall', 'Wall', 'A whole wall on one floor'),
      pm('floor', 'Floor', 'Everything on a floor')),
    h('div', { class: 'muted small' }, 'Click in the 3D view (Shift = add). Esc clears. Imported designs and textures show in the Detailed view.'),
    h('div', { class: 'row views' }, h('span', { class: 'muted small' }, 'View from'),
      ...(['front', 'back', 'left', 'right', 'top', 'corner'] as const).map(d => h('button', { onclick: () => ed.viewer?.look(d) }, d[0].toUpperCase() + d.slice(1)))),
    nSel ? h('div', { class: 'box' },
      h('div', { class: 'box-title' }, `Selected: ${parts.join(', ')}`),
      firstWall ? h('div', { class: 'row' },
        h('button', { onclick: () => ed.editFloorIn('structure', firstWall[0], firstWall[1]) }, 'Edit in structure planner'),
        h('button', { onclick: () => ed.editFloorIn('floorplan', firstWall[0]) }, 'Edit floor plan'),
      ) : null,
      T && (T.divs.length || T.borders.length) ? addBox(ed, T) : null,
      elems.length ? elementBox(ed, elems) : null,
      appearanceBox(ed, T, elems),
      T && T.segs.length ? divisionBox(ed, T.segs) : null,
      h('button', { onclick: () => ed.clearSel() }, 'Clear selection'),
    ) : null,
    ed.viewer?.stats.windowSkipped ? h('div', { class: 'warn' }, `${ed.viewer.stats.windowSkipped} opening(s)/niche(s) are not built: they overlap another one on the same wall, or fall outside it. Move them (select with Element).`) : null,
    h('div', { class: 'row' },
      h('button', { onclick: () => addModel(ed), disabled: !p.designs.some(d => d.category === 'model') , title: 'Import a 3D model in the library below first' }, 'Add 3D model'),
      h('label', { class: 'inline' }, 'Default division (m)', ed.numInput(b.divLen, v => (b.divLen = v), 0.3, 1000)),
    ),
    libraryBox(ed),
    ed.reportBox(),
  );
}

/** Add openings, niches, balconies, cornices or pilasters to the selection. */
function addBox(ed: Editor, T: ReturnType<typeof targets>) {
  const b = ed.b, p = ed.p;
  const typeSel = h('select', {}, ...(['opening', 'niche', 'balcony', 'cornice', 'pilaster'] as PlacementType[]).map(t => h('option', { value: t }, TYPE_LABEL[t])));
  typeSel.value = ed.addType;
  const choice = h('select', {});
  const fill = () => {
    ed.addType = typeSel.value as PlacementType;
    choice.innerHTML = '';
    const t = ed.addType;
    if (t === 'opening' || t === 'niche') b.openingShapes.filter(s => s.kind === t).forEach(s => choice.append(h('option', { value: s.id }, `${s.name} (${fmt(s.w)} × ${fmt(s.h)} m)`)));
    else if (t === 'balcony') b.balconyShapes.forEach(s => choice.append(h('option', { value: s.id }, s.name)));
    else {
      const cat: DesignCategory = t === 'cornice' ? 'cornice' : 'column';
      choice.append(h('option', { value: '' }, t === 'cornice' ? 'Plain cornice' : 'Plain pilaster'));
      p.designs.filter(d => d.category === cat).forEach(d => choice.append(h('option', { value: d.id }, d.name)));
    }
  };
  typeSel.addEventListener('change', fill);
  fill();
  const count = () => (ed.addType === 'pilaster' ? T.borders.length : T.divs.length);
  return h('div', { class: 'sub' },
    h('div', { class: 'box-title' }, 'Add'),
    h('div', { class: 'row' }, typeSel, choice),
    h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        onclick: () => {
          const t = ed.addType, id = choice.value || null;
          const list = t === 'pilaster' ? T.borders : T.divs;
          if (!list.length) return toast(t === 'pilaster' ? 'Select borders (or walls / floors) for pilasters' : 'Select divisions, walls or floors');
          if ((t === 'opening' || t === 'niche' || t === 'balcony') && !id) return toast(`Design a ${t} shape first`);
          ed.mutate(() => {
            for (const tg of list) {
              // one of each kind per division / border: replace what is there
              b.placements = b.placements.filter(x => !(x.type === t && x.floorId === tg.floorId && x.segId === tg.seg.id && x.div === tg.k && (t !== 'opening' && t !== 'niche' || true)));
              b.placements.push({
                id: uid(), type: t, floorId: tg.floorId, segId: tg.seg.id, div: tg.k, dx: 0, dy: 0,
                ...(t === 'opening' || t === 'niche' || t === 'balcony' ? { shapeId: id } : { designId: id }),
              });
            }
          });
          toast(`Added ${list.length} ${TYPE_LABEL[t].toLowerCase()}${list.length === 1 ? '' : 's'}`);
        },
      }, `Add (${count()})`),
      h('button', {
        onclick: () => {
          const t = ed.addType, list = t === 'pilaster' ? T.borders : T.divs;
          const before = b.placements.length;
          ed.mutate(() => { b.placements = b.placements.filter(x => !(x.type === t && list.some(tg => tg.floorId === x.floorId && tg.seg.id === x.segId && tg.k === x.div))); });
          toast(`Removed ${before - b.placements.length}`);
        },
      }, 'Remove'),
    ),
    h('div', { class: 'muted small' }, 'Openings, niches, balconies and cornices go in each selected division; pilasters on each selected border (walls / floors: on all of them). Openings bigger than a division cut into the ones beside it.'),
  );
}

/** Properties of selected elements: shape / design, frames, moving them, deleting. */
function elementBox(ed: Editor, elems: Placement[]) {
  const b = ed.b, p = ed.p;
  const one = elems.length === 1 ? elems[0] : null;
  const types = new Set(elems.map(e => e.type));
  const t = types.size === 1 ? elems[0].type : null;
  const designSel = (cat: DesignCategory, key: 'designId' | 'frameId' | 'surroundId', label: string, plain: string) => {
    const vals = new Set(elems.map(e => e[key] ?? ''));
    const s = h('select', { onchange: () => ed.mutate(() => elems.forEach(e => (e[key] = s.value || null))) },
      vals.size > 1 ? h('option', { value: '__m', disabled: true }, 'mixed') : null,
      h('option', { value: '' }, plain), ...p.designs.filter(d => d.category === cat).map(d => h('option', { value: d.id }, d.name)));
    s.value = vals.size > 1 ? '__m' : [...vals][0];
    return h('label', {}, label, s);
  };
  const shapeSel = () => {
    const list: { id: string; name: string }[] = t === 'balcony' ? b.balconyShapes : b.openingShapes.filter(s => s.kind === t);
    const vals = new Set(elems.map(e => e.shapeId ?? ''));
    const s = h('select', { onchange: () => ed.mutate(() => elems.forEach(e => (e.shapeId = s.value))) },
      vals.size > 1 ? h('option', { value: '__m', disabled: true }, 'mixed') : null, ...list.map(x => h('option', { value: x.id }, x.name)));
    s.value = vals.size > 1 ? '__m' : [...vals][0];
    return h('label', {}, 'Shape', s);
  };
  const nudge = (dx: number, dy: number) => ed.mutate(() => elems.forEach(e => { e.dx = Math.round((e.dx + dx) * 100) / 100; e.dy = Math.round((e.dy + dy) * 100) / 100; }));
  const step = 0.1;
  const box = h('div', { class: 'sub' }, h('div', { class: 'box-title' }, t ? `${TYPE_LABEL[t]}${elems.length > 1 ? 's' : ''}` : 'Elements'));
  if (t === 'opening' || t === 'niche' || t === 'balcony') box.append(shapeSel());
  if (t === 'opening') box.append(designSel('frame', 'frameId', 'Frame (detailed view)', 'None'), designSel('surround', 'surroundId', 'Surround (detailed view)', 'None'));
  if (t === 'niche') box.append(designSel('nicheDeco', 'designId', 'Decoration (detailed view)', 'None'));
  if (t === 'cornice') box.append(designSel('cornice', 'designId', 'Cornice design', 'Plain'));
  if (t === 'pilaster') box.append(designSel('column', 'designId', 'Pilaster design', 'Plain'));
  if (t === 'balcony') box.append(designSel('balcony', 'designId', 'Balcony design', 'Plain platform'));
  if (t === 'model' && one) {
    const pos = one.pos ?? { x: 0, y: 0, z: 0 };
    const f = (label: string, get: () => number, set: (v: number) => void) => h('label', {}, label, ed.numInput(get(), set, -10000, 10000, true));
    box.append(
      designSel('model', 'designId', 'Model', 'None'),
      h('div', { class: 'row' }, f('East (m)', () => pos.x, v => (one.pos = { ...pos, x: v })), f('Up (m)', () => pos.y, v => (one.pos = { ...pos, y: v })), f('North (m)', () => pos.z, v => (one.pos = { ...pos, z: v }))),
      h('div', { class: 'row' }, f('Turn (°)', () => one.rot ?? 0, v => (one.rot = v)), f('Size (m)', () => one.scale ?? 1, v => (one.scale = Math.max(0.01, v)))),
    );
  }
  if (t !== 'model') {
    box.append(
      h('div', { class: 'row move' },
        h('span', { class: 'muted small' }, one ? `Moved ${fmt(one.dx)} m along, ${fmt(one.dy)} m up` : 'Move'),
        h('button', { title: 'Left along the wall', onclick: () => nudge(-step, 0) }, '◀'),
        h('button', { title: 'Down', onclick: () => nudge(0, -step) }, '▼'),
        h('button', { title: 'Up', onclick: () => nudge(0, step) }, '▲'),
        h('button', { title: 'Right along the wall', onclick: () => nudge(step, 0) }, '▶'),
        h('button', { onclick: () => ed.mutate(() => elems.forEach(e => { e.dx = 0; e.dy = 0; })) }, 'Reset'),
      ),
    );
    if (one) box.append(h('div', { class: 'row' },
      h('label', {}, 'Along (m)', ed.numInput(one.dx, v => (one.dx = v), -1000, 1000, true)),
      h('label', {}, 'Up (m)', ed.numInput(one.dy, v => (one.dy = v), -1000, 1000, true))));
  }
  box.append(h('button', { class: 'danger', onclick: () => { ed.mutate(() => (b.placements = b.placements.filter(x => !ed.selElements.has(x.id)))); ed.selElements.clear(); ed.refresh(); } }, 'Delete'));
  return box;
}

/** Colour and texture for selected walls, floors (their slabs) and elements. */
function appearanceBox(ed: Editor, T: ReturnType<typeof targets> | null, elems: Placement[]) {
  const b = ed.b;
  const segs = T?.segs ?? [];
  const floors = b.floors.filter(f => ed.selFloors.has(f.id));
  const items: { color?: string | null; texture?: string | null }[] = [...segs, ...floors, ...elems];
  if (!items.length) return null;
  const first = items.find(x => x.color)?.color ?? '#d8cfc0';
  const col = h('input', { type: 'color', value: first });
  return h('div', { class: 'sub' },
    h('div', { class: 'box-title' }, 'Colour'),
    h('div', { class: 'row' }, col,
      h('button', { onclick: () => ed.mutate(() => items.forEach(x => (x.color = col.value))) }, 'Apply colour'),
      h('button', { onclick: () => ed.mutate(() => items.forEach(x => (x.color = null))) }, 'Clear')),
    h('div', { class: 'muted small' }, `${segs.length ? 'Walls: the colour applies to that wall on every floor using the same plan. ' : ''}${floors.length ? 'Floors: colours their floor and ceiling slabs. ' : ''}Visible in Structural and Detailed views; a texture replaces it in Detailed view.`),
    ed.textureField('Texture', null, id => items.forEach(x => (x.texture = id))),
  );
}

/** Division length of the selected walls. */
function divisionBox(ed: Editor, segs: PlanSegment[]) {
  const b = ed.b;
  const vals = new Set(segs.map(s => s.divLen ?? null));
  const inp = h('input', {
    type: 'number', step: 0.1, value: vals.size === 1 && [...vals][0] !== null ? fmt([...vals][0]!) : '',
    placeholder: vals.size > 1 ? 'mixed' : `default ${fmt(b.divLen)}`,
    onchange: () => {
      if (inp.value.trim() === '') return ed.mutate(() => segs.forEach(s => (s.divLen = null)));
      const v = num(inp.value);
      if (!(v >= 0.3 && v <= 1000)) { toast('Division length: 0.3 to 1000 m'); return ed.refresh(); }
      ed.mutate(() => segs.forEach(s => (s.divLen = v)));
    },
  });
  return h('div', { class: 'sub' },
    h('label', {}, 'Division length of these walls (m, empty = default)', inp),
    h('div', { class: 'muted small' }, 'Full divisions fill the middle of each wall; if they do not fit exactly, the two end divisions are a little shorter.'));
}

function addModel(ed: Editor) {
  const b = ed.b, d = ed.p.designs.find(x => x.category === 'model');
  if (!d) return;
  const id = uid();
  ed.mutate(() => b.placements.push({ id, type: 'model', floorId: b.floors[b.ground].id, designId: d.id, dx: 0, dy: 0, pos: { x: b.baseLength / 2, y: 0, z: b.baseLength / 2 }, rot: 0, scale: 2 }));
  ed.clearSets(); ed.selElements.add(id); ed.pickMode = 'element';
  if (ed.viewMode !== 'detailed') { ed.viewMode = 'detailed'; toast('Switched to Detailed view: imported models only show there'); }
  ed.refresh();
}

/** Imported 3D designs, by category. */
function libraryBox(ed: Editor) {
  const p = ed.p;
  const cat = h('select', {}, ...Object.entries(DESIGN_CATEGORIES).map(([k, v]) => h('option', { value: k }, v)));
  cat.value = ed.libCategory;
  cat.addEventListener('change', () => (ed.libCategory = cat.value as DesignCategory));
  const file = h('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl', style: 'display:none' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const format = formatOf(f.name);
    if (!format) return toast('Use a .glb, .gltf (self-contained), .obj or .stl file');
    const d: Design = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), category: cat.value as DesignCategory, format };
    try {
      await importDesignFile(d.id, format, await f.arrayBuffer());
      ed.mutate(() => p.designs.push(d));
      toast(`Imported “${d.name}” into ${DESIGN_CATEGORIES[d.category]}`);
    } catch (e) { console.error(e); toast('Could not read that 3D file'); }
  });
  const groups = Object.entries(DESIGN_CATEGORIES).map(([k, label]) => {
    const list = p.designs.filter(d => d.category === k);
    if (!list.length) return null;
    return h('div', {}, h('div', { class: 'muted small' }, label),
      ...list.map(d => h('div', { class: 'lib-row' }, d.name,
        h('button', {
          class: 'danger', title: 'Remove from the library',
          onclick: async () => {
            if (!(await askConfirm(`Remove “${d.name}”? Elements using it go back to the plain look.`, 'Remove'))) return;
            ed.mutate(() => {
              p.designs = p.designs.filter(x => x !== d);
              for (const bl of p.buildings) for (const x of bl.placements) for (const k2 of ['designId', 'frameId', 'surroundId'] as const) if (x[k2] === d.id) x[k2] = null;
              for (const bl of p.buildings) for (const pl of bl.plans) for (const s of pl.segments) { if (s.columnDesign === d.id) s.columnDesign = null; if (s.balusterDesign === d.id) s.balusterDesign = null; }
            });
            deleteAsset(d.id);
          },
        }, '×'))));
  });
  return h('details', { class: 'box', open: p.designs.length > 0 },
    h('summary', {}, `Imported designs (${p.designs.length})`),
    h('div', { class: 'row' }, cat, h('button', { onclick: () => file.click() }, 'Import 3D file')), file,
    h('div', { class: 'muted small' }, '3D files (.glb, .obj, .stl) stretch to fit what you assign them to: frames and surrounds to openings, cornices to divisions, columns to colonnades and pilasters, balusters to railings. They show in the Detailed view and are stored in this browser.'),
    ...groups.filter(Boolean) as HTMLElement[],
  );
}

// ---------------------------------------------------------------- design modes
export type DesignMode = 'openings' | 'niches' | 'balconies';

/** Build the drawing area(s) for a design mode. */
export function setupDesignMode(ed: Editor, mode: DesignMode) {
  ed.shapeEds = [];
  const common = (extra: Partial<ShapeHost> & Pick<ShapeHost, 'getOutlines' | 'setOutlines' | 'aspect' | 'labels' | 'readout'>): ShapeHost => ({
    smooth: () => (mode === 'balconies' ? ed.balcony()?.smooth : ed.oshape()?.smooth) ?? 0,
    begin: () => ed.begin(), commit: () => ed.commit(), toast, selectionChanged: () => ed.renderRight(),
    ...extra,
  });
  const cell = (cls: string) => { const d = h('div', { class: `edcell ${cls}` }); return d; };
  if (mode === 'balconies') {
    const c = cell('one'); ed.center.append(c);
    ed.shapeEds.push(new ShapeEditor(c, common({
      single: true,
      getOutlines: () => { const s = ed.balcony(); return s ? [s.outline] : null; },
      setOutlines: o => { const s = ed.balcony(); if (s) s.outline = o[0] ?? []; },
      aspect: () => { const s = ed.balcony(); return s ? s.w / s.d : 1; },
      labels: { bottom: 'wall side (top view)', top: 'outer edge' },
      readout: q => { const s = ed.balcony()!; return `${fmt((q.x - 0.5) * s.w)} m along the wall, ${fmt(q.y * s.d)} m out`; },
    })));
    return;
  }
  const kind = mode === 'openings' ? 'opening' : 'niche';
  const front = cell(mode === 'openings' ? 'one' : 'front');
  ed.center.append(front);
  ed.shapeEds.push(new ShapeEditor(front, common({
    getOutlines: () => ed.oshape()?.outlines ?? null,
    setOutlines: o => { const s = ed.oshape(); if (s) s.outlines = o; },
    aspect: () => { const s = ed.oshape(); return s ? s.w / s.h : 1; },
    labels: { bottom: kind === 'opening' ? 'front view (bottom = floor side)' : 'front view', top: '' },
    readout: q => { const s = ed.oshape()!; return `${fmt(q.x * s.w)} m across, ${fmt(q.y * s.h)} m up`; },
  })));
  void kind;
  if (mode === 'niches') {
    const side = cell('side'), bottom = cell('bottom');
    ed.center.append(side, bottom);
    ed.shapeEds.push(new ShapeEditor(side, common({
      getOutlines: () => { const s = ed.oshape(); return s ? [s.side ?? []] : null; },
      setOutlines: o => { const s = ed.oshape(); if (s) s.side = o[0] ?? []; },
      aspect: () => 0.55,
      labels: { bottom: 'side view: wall face ← → depth', left: 'height' },
      readout: q => { const s = ed.oshape()!; return `${fmt(q.x * (s.depth ?? 0.2))} m deep at ${fmt(q.y * s.h)} m up`; },
    }), 'profileY'));
    ed.shapeEds.push(new ShapeEditor(bottom, common({
      getOutlines: () => { const s = ed.oshape(); return s ? [s.bottom ?? []] : null; },
      setOutlines: o => { const s = ed.oshape(); if (s) s.bottom = o[0] ?? []; },
      aspect: () => 2,
      labels: { bottom: 'bottom view: width (wall face at the bottom)', left: 'depth' },
      readout: q => { const s = ed.oshape()!; return `${fmt(q.y * (s.depth ?? 0.2))} m deep at ${fmt(q.x * s.w)} m across`; },
    }), 'profileX'));
  }
}

export function renderDesignPanel(ed: Editor, mode: DesignMode) {
  const b = ed.b;
  const eds = ed.shapeEds, main = eds[0];
  const isBal = mode === 'balconies';
  const list: (OpeningShape | BalconyShape)[] = isBal ? b.balconyShapes : b.openingShapes.filter(s => s.kind === (mode === 'openings' ? 'opening' : 'niche'));
  const cur = isBal ? ed.balcony() : ed.oshape();
  const used = (id: string) => b.placements.filter(x => x.shapeId === id).length;
  const select = (id: string | null) => { ed.activeDesign[mode] = id; eds.forEach(e => e.reset()); ed.refresh(); };
  const pt = eds.map(e => e.selectedPoint()).find(Boolean) ?? null;
  const field = (label: string, get: () => number, set: (v: number) => void, min = 0.05) => h('label', {}, label, ed.numInput(get(), set, min, 100));
  const create = () => ed.mutate(() => {
    let s: OpeningShape | BalconyShape;
    if (isBal) s = { id: uid(), name: `Balcony ${list.length + 1}`, outline: [], smooth: 0, w: 2.4, d: 1.1, thickness: 0.2, railing: true };
    else if (mode === 'openings') s = { id: uid(), name: `Opening ${list.length + 1}`, kind: 'opening', outlines: [], smooth: 0, w: 1.2, h: 1.5, anchor: 'center' };
    else s = { id: uid(), name: `Niche ${list.length + 1}`, kind: 'niche', outlines: [], smooth: 0, w: 0.9, h: 1.8, anchor: 'bottom', depth: 0.2, side: [{ x: 1, y: 0 }, { x: 1, y: 1 }], bottom: [{ x: 0, y: 1 }, { x: 1, y: 1 }] };
    (isBal ? b.balconyShapes : b.openingShapes as (OpeningShape | BalconyShape)[]).push(s as any);
    select(s.id);
  });

  ed.right.innerHTML = '';
  put(ed.right,
    h('div', { class: 'box-title' }, isBal ? 'Balcony shapes' : mode === 'openings' ? 'Opening shapes (windows, doors, arches)' : 'Niche shapes'),
    h('div', { class: 'plans' }, ...list.map(s => h('div', {
      class: 'plan-row' + (s.id === cur?.id ? ' active' : ''), onclick: () => select(s.id),
    }, s.name, h('span', { class: 'muted small' }, ` ${fmt(s.w)} × ${fmt('h' in s ? s.h : s.d)} m · used ${used(s.id)}×`)))),
    h('div', { class: 'row' },
      h('button', { onclick: create }, 'New'),
      h('button', { disabled: !cur, title: 'Save a copy to tweak', onclick: () => cur && ed.mutate(() => { const c = { ...JSON.parse(JSON.stringify(cur)), id: uid(), name: `${cur.name} copy` }; (isBal ? b.balconyShapes : b.openingShapes as any[]).push(c); select(c.id); }) }, 'Save as copy'),
      h('button', { disabled: !cur, onclick: async () => { const n = cur && await askText('Rename', cur.name); if (cur && n?.trim()) ed.mutate(() => (cur.name = n.trim())); } }, 'Rename'),
      h('button', {
        class: 'danger', disabled: !cur,
        onclick: async () => {
          if (!cur || !(await askConfirm(`Delete ${cur.name}? Elements using it are removed.`))) return;
          ed.mutate(() => {
            if (isBal) b.balconyShapes = b.balconyShapes.filter(x => x !== cur); else b.openingShapes = b.openingShapes.filter(x => x !== cur);
            b.placements = b.placements.filter(x => x.shapeId !== cur.id);
          });
          select(list.find(x => x !== cur)?.id ?? null);
        },
      }, 'Delete'),
    ),
    cur ? h('div', { class: 'row' },
      field('Width (m)', () => cur.w, v => (cur.w = v)),
      isBal ? field('Depth (m)', () => (cur as BalconyShape).d, v => ((cur as BalconyShape).d = v)) : field('Height (m)', () => (cur as OpeningShape).h, v => ((cur as OpeningShape).h = v)),
      isBal ? field('Thickness (m)', () => (cur as BalconyShape).thickness, v => ((cur as BalconyShape).thickness = v), 0.02) : null,
      mode === 'niches' ? field('Depth (m)', () => (cur as OpeningShape).depth ?? 0.2, v => ((cur as OpeningShape).depth = v), 0.01) : null,
    ) : null,
    cur && !isBal ? anchorField(ed, cur as OpeningShape) : null,
    cur && isBal ? ed.checkField('Railing of balusters', (cur as BalconyShape).railing, v => ((cur as BalconyShape).railing = v)) : null,
    cur ? ed.slider('Smoothness (whole shape)', cur.smooth, v => (cur.smooth = v)) : null,
    pt ? h('div', { class: 'box' },
      h('div', { class: 'box-title' }, 'Selected point'),
      ed.slider(`Smoothness at this point${pt.s == null ? ' (shape default)' : ''}`, pt.s ?? null, v => (pt.s = v), () => (pt.s = null)),
      h('div', { class: 'row' },
        h('button', { onclick: () => eds.forEach(e => e.deleteSelected()) }, 'Delete point'),
        !isBal ? h('button', { onclick: () => main.deleteOutline() }, 'Delete this outline') : null),
    ) : null,
    cur ? h('div', { class: 'row' },
      !isBal ? h('button', { disabled: main?.cur == null, onclick: () => main.finish() }, 'Finish outline (Enter)') : null,
      h('button', { title: 'Stretch the drawing to fill the whole box', onclick: () => main.fit() }, 'Fit to box'),
      h('button', { class: 'danger', onclick: () => main.clear() }, 'Clear'),
    ) : null,
    cur ? h('div', { class: 'row' },
      h('button', { title: 'Copy this shape as text to use in another project', onclick: () => exportShape(cur) }, 'Export'),
      h('button', { onclick: () => importShape(ed, mode) }, 'Import'),
    ) : h('div', { class: 'row' }, h('button', { onclick: () => importShape(ed, mode) }, 'Import')),
    h('div', { class: 'muted small help' }, isBal
      ? 'Top view of the platform: the bottom edge is against the wall. Click to add points, drag to move, double-click an edge to insert one. Balconies sit lower than the middle of the division they are added to; move them up or down after adding.'
      : mode === 'openings'
        ? 'Draw the opening in its box (the box is the size above). Enter / Space finishes an outline; the next click starts another one in the same shape. Windows are centred on the wall height, entrances stand on the floor. An opening wider than a division, or taller than the floor, cuts into the divisions around it.'
        : 'Front view: the niche outline. Side view: how deep it is at each height (wall face on the left). Bottom view: how deep it is across its width (wall face at the bottom). The recess depth is the smaller of the two, so a curved bottom view and a rounded top give a classic half-dome niche.'),
  );
}

function anchorField(ed: Editor, s: OpeningShape) {
  const sel = h('select', { onchange: () => ed.mutate(() => (s.anchor = sel.value as 'center' | 'bottom')) },
    h('option', { value: 'center' }, 'Central (like windows)'), h('option', { value: 'bottom' }, 'Bottom (like entrances)'));
  sel.value = s.anchor;
  return h('label', {}, 'Position on the wall', sel);
}

function exportShape(s: OpeningShape | BalconyShape) {
  const text = JSON.stringify({ arch: 'shape', ...s });
  const ta = h('textarea', { value: text, rows: 6, style: 'width:100%' });
  const overlay = h('div', { class: 'overlay' });
  overlay.append(h('div', { class: 'dialog' }, h('h2', {}, `Export “${s.name}”`), h('p', { class: 'muted small' }, 'Copy this text and use Import in another project.'), ta,
    h('div', { class: 'row end' },
      h('button', { onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { ta.select(); } } }, 'Copy'),
      h('button', { class: 'primary', onclick: () => overlay.remove() }, 'Done'))));
  document.body.append(overlay);
  ta.select();
}

async function importShape(ed: Editor, mode: DesignMode) {
  const text = await askText('Paste an exported shape', '');
  if (!text) return;
  try {
    const o = JSON.parse(text);
    if (o.arch !== 'shape') throw new Error('not a shape');
    delete o.arch;
    o.id = uid();
    const isBal = 'outline' in o;
    if (isBal !== (mode === 'balconies') || (!isBal && o.kind !== (mode === 'openings' ? 'opening' : 'niche'))) return toast(`That is a ${isBal ? 'balcony' : o.kind} shape: import it in its own mode`);
    ed.mutate(() => (isBal ? ed.b.balconyShapes : ed.b.openingShapes as any[]).push(o));
    ed.activeDesign[mode] = o.id;
    ed.refresh();
  } catch { toast('That text is not an exported shape'); }
}

export const shapePoints = (pts: WinPoint[]) => pts.length;
export { floorLabel };
