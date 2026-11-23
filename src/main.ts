import './style.css';
import { MAX_AREA, MAX_M, createProject, deleteProject, loadProjects, saveProject, totalHeight } from './model';
import { fmt } from './planner';
import { Editor } from './editor';
import { app, h, num } from './ui';


// ======================================================================
// Project list
// ======================================================================
function showList() {
  editor?.destroy(); editor = null;
  app.innerHTML = '';
  const list = loadProjects().sort((a, b) => b.updated - a.updated);
  const rows = list.map(p => h('div', { class: 'proj' },
    h('div', { class: 'proj-main', onclick: () => openProject(p.id) },
      h('div', { class: 'proj-name' }, p.name),
      h('div', { class: 'muted' }, `${p.floors.length} floors · ${fmt(totalHeight(p))} m tall · base ${fmt(p.baseLength)} m · edited ${new Date(p.updated).toLocaleString()}`),
    ),
    h('button', { onclick: () => openProject(p.id) }, 'Open'),
    h('button', { onclick: () => { const n = prompt('Rename project', p.name); if (n?.trim()) { p.name = n.trim(); saveProject(p); showList(); } } }, 'Rename'),
    h('button', { class: 'danger', onclick: () => { if (confirm(`Delete "${p.name}"? This cannot be undone.`)) { deleteProject(p.id); showList(); } } }, 'Delete'),
  ));
  app.append(h('div', { class: 'list-screen' },
    h('h1', {}, 'Arch'),
    h('div', { class: 'row' }, h('h2', {}, 'Projects'), h('button', { class: 'primary', onclick: newProjectDialog }, '+ New project')),
    rows.length ? h('div', { class: 'projects' }, ...rows) : h('p', { class: 'muted' }, 'No projects yet. Create one to start.'),
  ));
}

function newProjectDialog() {
  type Combo = 'nf' | 'nt' | 'ft';
  let combo: Combo = 'nf';
  let baseMode: 'len' | 'area' = 'len';
  const name = h('input', { value: 'Untitled project' });
  const comboSel = h('select', {},
    h('option', { value: 'nf' }, 'Number of floors + floor height'),
    h('option', { value: 'nt' }, 'Number of floors + total height'),
    h('option', { value: 'ft' }, 'Floor height + total height'),
  );
  const inN = h('input', { type: 'number', min: 1, step: 1, value: 3 });
  const inF = h('input', { type: 'number', min: 0.1, step: 0.1, value: 3 });
  const inT = h('input', { type: 'number', min: 0.1, step: 0.1, value: 9 });
  const baseSel = h('select', {}, h('option', { value: 'len' }, 'Base length (m)'), h('option', { value: 'area' }, 'Surface area (m²)'));
  const inB = h('input', { type: 'number', min: 0.1, step: 0.1, value: 20 });
  const out = h('div', { class: 'calc' });
  const createBtn = h('button', { class: 'primary' }, 'Create');
  const rowN = h('label', {}, 'Number of floors', inN);
  const rowF = h('label', {}, 'Floor height (m)', inF);
  const rowT = h('label', {}, 'Total height (m)', inT);

  let result: { n: number; f: number; L: number } | null = null;
  const calc = () => {
    combo = comboSel.value as Combo; baseMode = baseSel.value as any;
    rowN.style.display = combo === 'ft' ? 'none' : '';
    rowF.style.display = combo === 'nt' ? 'none' : '';
    rowT.style.display = combo === 'nf' ? 'none' : '';
    let n = num(inN.value), f = num(inF.value), t = num(inT.value);
    const errs: string[] = [];
    if (combo === 'nf') t = n * f;
    if (combo === 'nt') f = t / n;
    if (combo === 'ft') { n = Math.max(1, Math.round(t / f)); f = t / n; }
    if (combo !== 'ft' && (!Number.isInteger(n) || n < 1)) errs.push('Number of floors must be a whole number ≥ 1');
    if (!(f > 0)) errs.push('Floor height must be > 0');
    if (!(t > 0) || t > MAX_M) errs.push('Total height must be between 0 and 10 000 m');
    if (f > MAX_M) errs.push('Floor height is capped at 10 000 m');
    if (n > 2000) errs.push('Too many floors (max 2000)');
    const b = num(inB.value);
    let L = baseMode === 'len' ? b : Math.sqrt(b);
    if (!(b > 0)) errs.push('Base must be > 0');
    if (baseMode === 'len' && b > MAX_M) errs.push('Base length is capped at 10 000 m');
    if (baseMode === 'area' && b > MAX_AREA) errs.push('Area is capped at 100 000 000 m² (10 km × 10 km)');
    const lines = [
      `${n} floor${n === 1 ? '' : 's'} × ${fmt(f)} m = ${fmt(t)} m total`,
      baseMode === 'len' ? `Area: ${fmt(b * b)} m²` : `Base length: ${fmt(L)} m`,
    ];
    out.innerHTML = '';
    lines.forEach(l => out.append(h('div', {}, l)));
    errs.forEach(e => out.append(h('div', { class: 'err' }, e)));
    result = errs.length ? null : { n, f, L };
    createBtn.disabled = !result || !name.value.trim();
  };
  [comboSel, inN, inF, inT, baseSel, inB, name].forEach(el => el.addEventListener('input', calc));
  calc();

  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  createBtn.addEventListener('click', () => {
    if (!result) return;
    const p = createProject(name.value.trim(), result.L, result.n, result.f);
    saveProject(p); close(); openProject(p.id);
  });
  overlay.append(h('div', { class: 'dialog' },
    h('h2', {}, 'New project'),
    h('label', {}, 'Name', name),
    h('label', {}, 'Height defined by', comboSel),
    rowN, rowF, rowT,
    h('label', {}, 'Base defined by', baseSel),
    h('label', {}, 'Value', inB),
    h('p', { class: 'muted small' }, 'The building area is a square. The base length cannot be changed later.'),
    out,
    h('div', { class: 'row end' }, h('button', { onclick: close }, 'Cancel'), createBtn),
  ));
  document.body.append(overlay);
  name.focus(); name.select();
}

let editor: Editor | null = null;
function openProject(id: string) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return showList();
  editor?.destroy();
  editor = new Editor(p, showList);
}

showList();
