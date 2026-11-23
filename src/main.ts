import './style.css';
import { Project, createProject, createSite, deleteProject, initStorage, loadProjects, normalize, sampleProject, saveProject, storageInfo, totalHeight, uid } from './model';
import { getAsset, putAsset } from './assets';
import { buildingDialog } from './dialogs';
import { fmt } from './planner';
import { Editor } from './editor';
import { SiteEditor } from './site';
import { app, h, toast } from './ui';
import { askConfirm, askText } from './ui';
window.addEventListener('arch-save-failed', () => toast('Could not save: browser storage is full. Save projects to files and delete ones you no longer need.'));

// ======================================================================
// Project list: building projects (one building) and site projects (several placed buildings)
// ======================================================================
let editor: { destroy(): void } | null = null;

function showList() {
  editor?.destroy(); editor = null;
  app.innerHTML = '';
  const list = loadProjects().sort((a, b) => b.updated - a.updated);
  const row = (p: (typeof list)[number]) => {
    const b = p.buildings[0];
    const info = p.kind === 'site'
      ? `${p.items.length} building${p.items.length === 1 ? '' : 's'}`
      : `${b.floors.length} floors (${b.ground} underground) · ${fmt(totalHeight(b))} m · base ${fmt(b.baseLength)} m`;
    const usedBy = p.kind === 'building' ? list.filter(s => s.kind === 'site' && s.items.some(it => it.projectId === p.id)).map(s => s.name) : [];
    return h('div', { class: 'proj' },
      h('div', { class: 'proj-main', onclick: () => openProject(p.id) },
        h('div', { class: 'proj-name' }, p.name),
        h('div', { class: 'muted' }, `${info} · edited ${new Date(p.updated).toLocaleString()}${usedBy.length ? ` · on site: ${usedBy.join(', ')}` : ''}`),
      ),
      h('button', { onclick: () => openProject(p.id) }, 'Open'),
      h('button', { title: 'Save this project (with its imported 3D designs) as a file', onclick: () => exportProject(p) }, 'Save file'),
      h('button', { onclick: async () => { const n = await askText('Rename project', p.name); if (n?.trim()) { p.name = n.trim(); saveProject(p); showList(); } } }, 'Rename'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          const warn = usedBy.length ? `\n\nIt is used on: ${usedBy.join(', ')}.` : '';
          if (await askConfirm(`Delete "${p.name}"? This cannot be undone.${warn}`)) { deleteProject(p.id); showList(); }
        },
      }, 'Delete'),
    );
  };
  const usage = h('div', { class: 'muted small' });
  storageInfo().then(i => {
    if (!i) return;
    const mb = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${(v / 1e6).toFixed(1)} MB`);
    usage.textContent = `Stored in this browser: ${mb(i.usage)} of ${mb(i.quota)} available${i.persisted ? ' · kept safe from automatic clean-up' : ''}. Use “Save file” for backups.`;
  });
  const buildings = list.filter(p => p.kind === 'building'), sites = list.filter(p => p.kind === 'site');
  app.append(h('div', { class: 'list-screen' },
    h('div', { class: 'row' }, h('h1', { style: 'flex:1' }, 'Arch'),
      h('button', { title: 'Open a project saved as a file', onclick: importProject }, 'Open file…')),
    usage,
    h('div', { class: 'row' }, h('h2', {}, 'Buildings'), h('div', { class: 'row' },
      h('button', { title: 'Add the example villa as a new project', onclick: () => { const p = sampleProject(); saveProject(p); openProject(p.id); } }, 'Load example villa'),
      h('button', { class: 'primary', onclick: newProjectDialog }, '+ New building project'))),
    buildings.length ? h('div', { class: 'projects' }, ...buildings.map(row)) : h('div', { class: 'row' }, h('span', { class: 'muted' }, 'No building projects yet.'),
      h('button', { onclick: () => { const p = sampleProject(); saveProject(p); openProject(p.id); } }, 'Load example')),
    h('div', { class: 'row' }, h('h2', {}, 'Sites'), h('button', { class: 'primary', onclick: newSite }, '+ New site')),
    h('p', { class: 'muted small' }, 'A site places several of your building projects together.'),
    sites.length ? h('div', { class: 'projects' }, ...sites.map(row)) : h('p', { class: 'muted' }, 'No sites yet.'),
  ));
}

function newProjectDialog() {
  buildingDialog({
    title: 'New building project', nameLabel: 'Project name', defaultName: 'Untitled building',
    onCreate: (spec, name) => {
      const p = createProject(name, { ...spec, name });
      saveProject(p); openProject(p.id);
    },
  });
}

async function newSite() {
  const name = await askText('Site name', 'Untitled site');
  if (!name?.trim()) return;
  const p = createSite(name.trim());
  saveProject(p); openProject(p.id);
}

function openProject(id: string) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return showList();
  editor?.destroy();
  editor = p.kind === 'site' ? new SiteEditor(p, showList, openProject) : new Editor(p, showList);
}

// ---------------------------------------------------------------- project files (backup / move between computers)
const b64 = (buf: ArrayBuffer) => { let s2 = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s2 += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s2); };
const unb64 = (t: string) => { const s2 = atob(t), u = new Uint8Array(s2.length); for (let i = 0; i < s2.length; i++) u[i] = s2.charCodeAt(i); return u.buffer; };

async function exportProject(p: Project) {
  const assets: Record<string, string> = {};
  for (const d of p.designs ?? []) {
    if (d.format === 'builtin') continue;
    const data = await getAsset(d.id).catch(() => undefined);
    if (data) assets[d.id] = b64(data);
  }
  const blob = new Blob([JSON.stringify({ arch: 1, project: p, assets })], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${p.name.replace(/[^\w\- ]+/g, '_') || 'project'}.arch.json` }) as HTMLAnchorElement;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importProject() {
  const inp = h('input', { type: 'file', accept: '.json,.arch,application/json' }) as HTMLInputElement;
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const p = normalize((data.arch ? data.project : data) as Project);
      if (!p?.id || !Array.isArray(p.buildings)) throw new Error('not a project');
      for (const [id, v] of Object.entries((data.assets ?? {}) as Record<string, string>)) await putAsset(id, unb64(v));
      if (loadProjects().some(x => x.id === p.id)) { p.id = uid(); p.name = `${p.name} (opened copy)`; }
      saveProject(p);
      toast(`Opened “${p.name}”`);
      showList();
    } catch (e) { console.error(e); toast('That file is not an Arch project'); }
  };
  inp.click();
}

initStorage().then(showList);
