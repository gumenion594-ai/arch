// Site project: places existing building projects together (linked: edits to a building show up here).
import { Building, History, Project, loadProjects, saveProject, uid } from './model';
import { Viewer, ViewMode } from './viewer';
import { placeDialog } from './dialogs';
import { fmt } from './planner';
import { app, h, put, toast } from './ui';

export class SiteEditor {
  hist = new History();
  viewMode: ViewMode = 'structural';
  showArea = true;
  selItem: string | null = null;
  root = h('div', { class: 'editor with-left-only' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  header = h('div', { class: 'header' });
  viewer: Viewer;

  constructor(public p: Project, private onBack: () => void, private openProject: (id: string) => void) {
    this.root.append(this.header, this.left, this.center);
    app.innerHTML = '';
    app.append(this.root);
    this.viewer = new Viewer(this.center);
    this.viewer.onTexture = () => this.refresh();
    this.viewer.onPick = hit => { this.selItem = hit?.buildingId ?? null; this.refresh(); };
    window.addEventListener('keydown', this.onKey);
    this.refresh();
  }
  destroy() { window.removeEventListener('keydown', this.onKey); this.viewer.dispose(); }

  private onKey = (e: KeyboardEvent) => {
    const t = (e.target as HTMLElement).tagName;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && t !== 'INPUT') { e.preventDefault(); this.undo(); }
  };
  mutate(fn: () => void) { this.hist.push(this.p); fn(); saveProject(this.p); this.refresh(); }
  undo() { const prev = this.hist.pop(); if (!prev) return toast('Nothing to undo'); this.p = prev; saveProject(this.p); this.refresh(); }

  /** Building projects available to place. */
  private library() { return loadProjects().filter(x => x.kind === 'building'); }
  /** The site's items resolved to buildings at their site positions (id = item id). */
  private resolved(lib = this.library()): { buildings: Building[]; textures: Project['textures']; designs: Project['designs']; decos: Project['decos'] } {
    const buildings: Building[] = [], textures: Project['textures'] = [], designs: Project['designs'] = [], decos: Project['decos'] = [];
    for (const it of this.p.items) {
      const src = lib.find(x => x.id === it.projectId);
      if (!src) continue;
      buildings.push({ ...src.buildings[0], id: it.id, x: it.x, y: it.y });
      textures.push(...src.textures);
      designs.push(...src.designs);
      decos.push(...(src.decos ?? []));
    }
    return { buildings, textures, designs, decos };
  }

  refresh() {
    const lib = this.library();
    const { buildings, textures, designs, decos } = this.resolved(lib);
    this.viewer.update({ id: this.p.id, buildings, textures, designs, decos }, { activeId: this.selItem ?? '*', mode: this.viewMode, showArea: this.showArea });

    const nameIn = h('input', {
      class: 'title-input', value: this.p.name,
      onchange: () => { const v = nameIn.value.trim(); if (v) this.mutate(() => (this.p.name = v)); },
    });
    const vm = h('select', { onchange: () => { this.viewMode = vm.value as ViewMode; this.refresh(); } },
      h('option', { value: 'plan' }, 'Floor plan view'), h('option', { value: 'structural' }, 'Structural view'), h('option', { value: 'detailed' }, 'Detailed view'));
    vm.value = this.viewMode;
    const area = h('input', { type: 'checkbox', checked: this.showArea, onchange: () => { this.showArea = area.checked; this.refresh(); } });
    this.header.innerHTML = '';
    put(this.header,
      h('button', { onclick: () => this.onBack() }, '← Projects'),
      h('span', { class: 'badge' }, 'Site'),
      nameIn, vm,
      h('label', { class: 'chk' }, area, 'Area lines'),
      h('div', { class: 'spacer' }),
      h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, 'Undo'),
    );

    // left: buildings on this site + library to add from
    const addSel = h('select', {}, h('option', { value: '' }, 'Add a building project…'), ...lib.map(x => h('option', { value: x.id }, x.name)));
    addSel.addEventListener('change', () => {
      const src = lib.find(x => x.id === addSel.value);
      addSel.value = '';
      if (!src) return;
      placeDialog(`Place “${src.name}”`, buildings, src.buildings[0].baseLength, null, (x, y) => {
        const id = uid();
        this.mutate(() => this.p.items.push({ id, projectId: src.id, x, y }));
        this.selItem = id; this.refresh();
      });
    });
    this.left.innerHTML = '';
    put(this.left,
      h('div', { class: 'box-title' }, 'Buildings on this site'),
      h('div', { class: 'muted small' }, 'Buildings are linked to their own projects: open one to edit it, and the change shows here.'),
      lib.length ? addSel : h('div', { class: 'muted small' }, 'Create a building project first, then add it here.'),
      h('div', { class: 'plans' }, ...this.p.items.map(it => {
        const src = lib.find(x => x.id === it.projectId);
        const b = src?.buildings[0];
        return h('div', { class: 'plan-row site-row' + (it.id === this.selItem ? ' active' : ''), onclick: () => { this.selItem = this.selItem === it.id ? null : it.id; this.refresh(); } },
          h('div', {}, src?.name ?? '(deleted project)'),
          h('div', { class: 'muted small' }, b ? `${fmt(b.baseLength)} m base · at ${fmt(it.x)}, ${fmt(it.y)} m` : 'This building project no longer exists'),
          it.id === this.selItem ? h('div', { class: 'row' },
            b ? h('button', {
              onclick: (e: Event) => {
                e.stopPropagation();
                placeDialog(`Move “${src!.name}”`, buildings.filter(x => x.id !== it.id), b.baseLength, { x: it.x, y: it.y }, (x, y) => this.mutate(() => { it.x = x; it.y = y; }));
              },
            }, 'Move') : null,
            src ? h('button', { onclick: (e: Event) => { e.stopPropagation(); this.openProject(src.id); } }, 'Open building') : null,
            h('button', { class: 'danger', onclick: (e: Event) => { e.stopPropagation(); this.mutate(() => (this.p.items = this.p.items.filter(x => x !== it))); this.selItem = null; this.refresh(); } }, 'Remove'),
          ) : null,
        );
      })),
      this.p.items.length ? null : h('p', { class: 'muted small' }, 'No buildings yet.'),
    );
  }
}
