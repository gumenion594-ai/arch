import './style.css';
import { createProject, createSite, deleteProject, loadProjects, saveProject, totalHeight } from './model';
import { buildingDialog } from './dialogs';
import { fmt } from './planner';
import { Editor } from './editor';
import { SiteEditor } from './site';
import { app, h } from './ui';

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
      h('button', { onclick: () => { const n = prompt('Rename project', p.name); if (n?.trim()) { p.name = n.trim(); saveProject(p); showList(); } } }, 'Rename'),
      h('button', {
        class: 'danger',
        onclick: () => {
          const warn = usedBy.length ? `\n\nIt is used on: ${usedBy.join(', ')}.` : '';
          if (confirm(`Delete "${p.name}"? This cannot be undone.${warn}`)) { deleteProject(p.id); showList(); }
        },
      }, 'Delete'),
    );
  };
  const buildings = list.filter(p => p.kind === 'building'), sites = list.filter(p => p.kind === 'site');
  app.append(h('div', { class: 'list-screen' },
    h('h1', {}, 'Arch'),
    h('div', { class: 'row' }, h('h2', {}, 'Buildings'), h('button', { class: 'primary', onclick: newProjectDialog }, '+ New building project')),
    buildings.length ? h('div', { class: 'projects' }, ...buildings.map(row)) : h('p', { class: 'muted' }, 'No building projects yet.'),
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

function newSite() {
  const name = prompt('Site name', 'Untitled site');
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

showList();
