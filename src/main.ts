import './style.css';
import { createProject, deleteProject, loadProjects, saveProject } from './model';
import { buildingDialog } from './dialogs';
import { fmt } from './planner';
import { Editor } from './editor';
import { app, h } from './ui';


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
      h('div', { class: 'muted' }, `${p.buildings.length} building${p.buildings.length === 1 ? '' : 's'} · ${p.buildings.reduce((s, b) => s + b.floors.length, 0)} floors · edited ${new Date(p.updated).toLocaleString()}`),
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
  buildingDialog({
    title: 'New project', nameLabel: 'Project name', defaultName: 'Untitled project',
    onCreate: (spec, name) => {
      const p = createProject(name, { ...spec, name: 'Building 1' });
      saveProject(p); openProject(p.id);
    },
  });
}

let editor: Editor | null = null;
function openProject(id: string) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return showList();
  editor?.destroy();
  editor = new Editor(p, showList);
}

showList();
