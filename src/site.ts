// Site project: a neighbourhood. Building projects placed on a terrain (linked: edits to a building show up
// here), moved around, raised / lowered and turned; roads, gravel, trees, imported 3D models and water on the
// ground; the ground shaped with brushes; a first-person walk through it all.
import * as THREE from 'three';
import { Building, Design, History, Project, SiteData, SiteXY, loadProjects, newSiteData, saveProject, uid } from './model';
import { Viewer, ViewMode } from './viewer';
import { LANE, brush, buildSite, heightAt, levelUnder } from './sitebuild';
import { formatOf, importDesignFile } from './assets';
import { BUILTIN_DESIGNS } from './builtin';
import { fmt } from './planner';
import { app, askConfirm, h, num, put, toast } from './ui';

type SiteTool = 'select' | 'building' | 'road' | 'gravel' | 'tree' | 'model' | 'water' | 'raise' | 'lower' | 'smooth' | 'flatten';
const TOOLS: [SiteTool, string, string][] = [
  ['select', 'Select / move', 'Click a building or anything on the ground to select it; drag it to move it.'],
  ['building', 'Building', 'Pick a building project below, then click the ground where it goes.'],
  ['road', 'Road', 'Click along the road; Enter or double-click finishes it. Set the number of lanes first (or after, on the selected road).'],
  ['gravel', 'Gravel', 'Click around the area; Enter or double-click closes it.'],
  ['tree', 'Tree', 'Click the ground to plant a tree.'],
  ['model', '3D model', 'Pick a model below, then click the ground to place it.'],
  ['water', 'Water', 'Click to place a water surface. Where the ground is higher than the water it is hidden, so in a valley it makes a lake.'],
  ['raise', 'Raise ground', 'Drag over the ground to raise it (hills).'],
  ['lower', 'Lower ground', 'Drag over the ground to lower it (valleys).'],
  ['smooth', 'Smooth', 'Drag over the ground to smooth it.'],
  ['flatten', 'Flatten', 'Drag over the ground to bring it to the height where you started.'],
];

export class SiteEditor {
  hist = new History();
  viewMode: ViewMode = 'detailed';
  tool: SiteTool = 'select';
  sel: string | null = null; // a building item id or a site object id
  draft: SiteXY[] = [];
  lanes = 2; treeKind: 'round' | 'conifer' = 'round'; treeSize = 8;
  radius = 12; strength = 0.6;
  addProject = ''; addModel = '';
  waterSize = 30;
  root = h('div', { class: 'editor with-left-only' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  header = h('div', { class: 'header' });
  viewer: Viewer;
  private terrain: THREE.Mesh | null = null;
  private preview: THREE.Object3D | null = null;
  private drag: { id: string; kind: 'building' | 'object'; start: SiteXY; obj: THREE.Object3D | null; orig: THREE.Vector3; began: boolean } | null = null;
  private painting: { level: number } | null = null;

  constructor(public p: Project, private onBack: () => void, private openProject: (id: string) => void) {
    p.site ??= newSiteData();
    this.root.append(this.header, this.left, this.center);
    app.innerHTML = '';
    app.append(this.root);
    this.viewer = new Viewer(this.center);
    this.viewer.onTexture = () => this.refresh();
    this.viewer.onPick = () => {}; // selection is handled here (buildings and things on the ground)
    this.viewer.onWalkChange = walking => { this.root.classList.toggle('site-walk', walking); this.renderHeader(); setTimeout(() => this.viewer['resize']?.(), 0); };
    const el = this.viewer.renderer.domElement;
    el.addEventListener('pointerdown', this.down, { capture: true });
    el.addEventListener('dblclick', () => this.finishDraft());
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('keydown', this.onKey);
    this.refresh();
  }
  destroy() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    this.viewer.dispose();
  }
  get s(): SiteData { return this.p.site!; }

  private onKey = (e: KeyboardEvent) => {
    if (this.viewer.walk) return;
    const t = (e.target as HTMLElement).tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
    if (e.key === 'Enter') { e.preventDefault(); this.finishDraft(); }
    if (e.key === 'Escape') { this.draft = []; this.sel = null; this.refresh(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.removeSelected(); }
  };
  mutate(fn: () => void) { this.hist.push(this.p); fn(); saveProject(this.p); this.refresh(); }
  undo() { const prev = this.hist.pop(); if (!prev) return toast('Nothing to undo'); this.p = prev; this.p.site ??= newSiteData(); saveProject(this.p); this.refresh(); }

  /** Building projects available to place. */
  private library() { return loadProjects().filter(x => x.kind === 'building'); }
  private resolved(lib = this.library()) {
    const buildings: Building[] = [], textures: Project['textures'] = [], designs: Project['designs'] = [...this.p.designs], decos: Project['decos'] = [];
    const poses: Record<string, { y: number; rot: number }> = {};
    for (const it of this.p.items) {
      const src = lib.find(x => x.id === it.projectId);
      if (!src) continue;
      const b = src.buildings[0];
      buildings.push({ ...b, id: it.id, x: it.x, y: it.y });
      poses[it.id] = { y: it.z ?? heightAt(this.s, it.x + b.baseLength / 2, it.y + b.baseLength / 2), rot: it.rot ?? 0 };
      textures.push(...src.textures); designs.push(...src.designs); decos.push(...(src.decos ?? []));
    }
    return { buildings, textures, designs, decos, poses };
  }

  refresh() {
    const lib = this.library();
    const r = this.resolved(lib);
    const { group, terrain } = buildSite(this.s, { detailed: this.viewMode === 'detailed' || !!this.viewer.walk, selected: this.sel, designs: this.p.designs, onLoad: () => this.refresh() });
    this.terrain = terrain;
    const half = this.s.size / 2;
    this.viewer.update(
      { id: this.p.id, buildings: r.buildings, textures: r.textures, designs: r.designs, decos: r.decos, extra: group, poses: r.poses, frameKey: this.p.id + ':site', frameBox: { x0: -half / 2, x1: half / 2, z0: -half / 2, z1: half / 2, y1: 20 } },
      { activeId: this.p.items.some(i => i.id === this.sel) ? this.sel : '*', mode: this.viewMode === 'plan' ? 'structural' : this.viewMode, showArea: false },
    );
    this.updatePreview();
    this.renderHeader();
    this.renderLeft(lib);
  }

  // ---------------------------------------------------------------- the ground under the pointer
  private ground(e: { clientX: number; clientY: number }): SiteXY | null {
    const el = this.viewer.renderer.domElement, rect = el.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.viewer.camera);
    const hit = this.terrain ? ray.intersectObject(this.terrain, false)[0] : undefined;
    if (hit) return { x: hit.point.x, y: -hit.point.z };
    const t = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), t) ? { x: t.x, y: -t.z } : null;
  }
  /** What is under the pointer: a building item or a site object. */
  private pickThing(e: PointerEvent): { id: string; kind: 'building' | 'object'; obj: THREE.Object3D } | null {
    const el = this.viewer.renderer.domElement, rect = el.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.viewer.camera);
    for (const hit of ray.intersectObjects(this.viewer.content.children, true)) {
      if (!(hit.object as THREE.Mesh).isMesh || hit.object.userData.siteTerrain) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o.userData.buildingPivot) return { id: o.userData.buildingPivot, kind: 'building', obj: o };
        if (o.userData.siteId) return { id: o.userData.siteId, kind: 'object', obj: o };
        o = o.parent;
      }
    }
    return null;
  }

  private down = (e: PointerEvent) => {
    if (e.button !== 0 || this.viewer.walk) return;
    const q = this.ground(e);
    const stop = () => { this.viewer.controls.enabled = false; };
    switch (this.tool) {
      case 'select': {
        const t = this.pickThing(e);
        if (!t) { if (this.sel) { this.sel = null; this.refresh(); } return; }
        stop();
        this.sel = t.id;
        this.drag = { id: t.id, kind: t.kind, start: q ?? { x: 0, y: 0 }, obj: t.obj, orig: t.obj.position.clone(), began: false };
        this.renderLeft(this.library());
        return;
      }
      case 'raise': case 'lower': case 'smooth': case 'flatten':
        if (!q) return;
        stop();
        this.hist.push(this.p);
        this.painting = { level: heightAt(this.s, q.x, q.y) };
        this.paint(q);
        return;
      case 'road': case 'gravel':
        if (!q) return;
        stop();
        this.draft.push(q);
        this.updatePreview();
        return;
    }
    if (!q) return;
    stop();
    if (this.tool === 'building') {
      const src = this.library().find(x => x.id === this.addProject);
      if (!src) return toast('Pick a building project in the panel first');
      const L = src.buildings[0].baseLength, id = uid();
      this.mutate(() => this.p.items.push({ id, projectId: src.id, x: q.x - L / 2, y: q.y - L / 2, z: heightAt(this.s, q.x, q.y), rot: 0 }));
      this.sel = id; this.refresh();
    } else if (this.tool === 'tree') {
      const id = uid();
      this.mutate(() => this.s.trees.push({ id, x: q.x, y: q.y, kind: this.treeKind, size: this.treeSize }));
    } else if (this.tool === 'model') {
      if (!this.p.designs.some(d => d.id === this.addModel)) return toast('Import or pick a 3D model in the panel first');
      const id = uid();
      this.mutate(() => this.s.models.push({ id, designId: this.addModel, x: q.x, y: q.y, rot: 0, scale: 5 }));
      this.sel = id; this.refresh();
    } else if (this.tool === 'water') {
      const id = uid();
      this.mutate(() => this.s.water.push({ id, x: q.x, y: q.y, w: this.waterSize, d: this.waterSize, level: Math.round((heightAt(this.s, q.x, q.y) + 0.5) * 100) / 100 }));
      this.sel = id; this.refresh();
    }
  };
  private move = (e: PointerEvent) => {
    if (this.painting) { const q = this.ground(e); if (q) this.paint(q); return; }
    if (this.drag) {
      const q = this.ground(e);
      if (!q || !this.drag.obj) return;
      const dx = q.x - this.drag.start.x, dy = q.y - this.drag.start.y;
      if (!this.drag.began && Math.hypot(dx, dy) < 0.05) return;
      this.drag.began = true;
      this.drag.obj.position.set(this.drag.orig.x + dx, this.drag.orig.y, this.drag.orig.z - dy); // live, without rebuilding
      return;
    }
    if (this.draft.length && (this.tool === 'road' || this.tool === 'gravel')) { const q = this.ground(e); if (q) this.updatePreview(q); }
  };
  private up = (e: PointerEvent) => {
    this.viewer.controls.enabled = true;
    if (this.painting) { this.painting = null; saveProject(this.p); this.refresh(); return; }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.began) { this.refresh(); return; }
    const q = this.ground(e);
    if (!q) { this.refresh(); return; }
    const dx = q.x - d.start.x, dy = q.y - d.start.y;
    this.mutate(() => {
      const it = this.p.items.find(x => x.id === d.id);
      if (it) {
        // a building keeps its height above the ground it moves onto
        const b = this.library().find(x => x.id === it.projectId)?.buildings[0], L = b?.baseLength ?? 0;
        const was = heightAt(this.s, it.x + L / 2, it.y + L / 2), above = (it.z ?? was) - was;
        it.x += dx; it.y += dy;
        it.z = Math.round((heightAt(this.s, it.x + L / 2, it.y + L / 2) + above) * 100) / 100;
        return;
      }
      const s = this.s;
      for (const t of [...s.trees, ...s.models, ...s.water]) if (t.id === d.id) { t.x += dx; t.y += dy; if ('z' in t && t.z != null) t.z = undefined; }
      for (const r of [...s.roads, ...s.gravel]) if (r.id === d.id) r.points = r.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    });
  };

  /** One dab of the terrain brush; only the terrain is redrawn while painting. */
  private paint(q: SiteXY) {
    const mode = this.tool as 'raise' | 'lower' | 'smooth' | 'flatten';
    brush(this.s, q.x, q.y, this.radius, this.strength * (mode === 'smooth' || mode === 'flatten' ? 1 : 0.25), mode, this.painting?.level ?? 0);
    const t = this.terrain;
    if (!t) return;
    const pos = t.geometry.getAttribute('position');
    for (let k = 0; k < pos.count; k++) pos.setY(k, heightAt(this.s, pos.getX(k), -pos.getZ(k)));
    pos.needsUpdate = true;
    t.geometry.computeVertexNormals();
  }

  /** The road / gravel being drawn: a line on the ground (and on to the pointer). */
  private updatePreview(hover?: SiteXY) {
    if (this.preview) { this.viewer.scene.remove(this.preview); this.preview = null; }
    if (!this.draft.length) return;
    const pts = [...this.draft, ...(hover ? [hover] : [])];
    if (this.tool === 'gravel' && pts.length > 2) pts.push(pts[0]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(q => new THREE.Vector3(q.x, heightAt(this.s, q.x, q.y) + 0.3, -q.y))),
      new THREE.LineBasicMaterial({ color: this.tool === 'road' ? 0xffd400 : 0xffffff, depthTest: false }));
    line.renderOrder = 10;
    this.preview = line;
    this.viewer.scene.add(line);
  }
  private finishDraft() {
    const d = this.draft;
    this.draft = [];
    if (this.tool === 'road' && d.length >= 2) { const id = uid(); this.mutate(() => this.s.roads.push({ id, points: d, lanes: this.lanes })); this.sel = id; }
    else if (this.tool === 'gravel' && d.length >= 3) { const id = uid(); this.mutate(() => this.s.gravel.push({ id, points: d })); this.sel = id; }
    this.refresh();
  }
  private removeSelected() {
    const id = this.sel;
    if (!id) return;
    this.mutate(() => {
      const s = this.s;
      this.p.items = this.p.items.filter(x => x.id !== id);
      s.roads = s.roads.filter(x => x.id !== id); s.gravel = s.gravel.filter(x => x.id !== id); s.trees = s.trees.filter(x => x.id !== id);
      s.models = s.models.filter(x => x.id !== id); s.water = s.water.filter(x => x.id !== id);
    });
    this.sel = null; this.refresh();
  }

  // ---------------------------------------------------------------- header and panel
  private renderHeader() {
    const nameIn = h('input', { class: 'title-input', value: this.p.name, onchange: () => { const v = nameIn.value.trim(); if (v) this.mutate(() => (this.p.name = v)); } });
    const vm = h('select', {
      onchange: () => {
        vm.blur();
        if (vm.value === 'walk') { this.viewMode = 'detailed'; this.refresh(); this.viewer.enterWalk(); return; }
        this.viewer.exitWalk();
        this.viewMode = vm.value as ViewMode; this.refresh();
      },
    }, h('option', { value: 'structural' }, 'Structural view'), h('option', { value: 'detailed' }, 'Detailed view'), h('option', { value: 'walk' }, 'First person view'));
    vm.value = this.viewer.walk ? 'walk' : this.viewMode === 'plan' ? 'structural' : this.viewMode;
    this.header.innerHTML = '';
    put(this.header,
      h('button', { onclick: () => this.onBack() }, '← Projects'),
      h('span', { class: 'badge' }, 'Site'),
      nameIn, vm,
      h('div', { class: 'spacer' }),
      h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, 'Undo'),
    );
  }

  private renderLeft(lib: Project[]) {
    const s = this.s;
    const toolBtn = ([t, label]: [SiteTool, string, string]) => h('button', {
      class: this.tool === t ? 'tab active' : 'tab',
      onclick: () => { if (this.draft.length) this.finishDraft(); this.tool = t; this.refresh(); },
    }, label);
    const field = (label: string, v: number, set: (x: number) => void, min: number, max: number, step = 0.5) => {
      const inp = h('input', { type: 'number', step, value: String(v), onchange: () => { const x = num(inp.value); if (x >= min && x <= max) set(x); else { toast(`${label}: ${min} to ${max}`); this.refresh(); } } });
      return h('label', {}, label, inp);
    };
    const settings: (Node | null)[] = [];
    if (this.tool === 'building') {
      const sel = h('select', { onchange: () => (this.addProject = sel.value) }, h('option', { value: '' }, 'Choose a building project…'), ...lib.map(x => h('option', { value: x.id }, x.name)));
      sel.value = this.addProject;
      settings.push(lib.length ? sel : h('div', { class: 'muted small' }, 'Create a building project first.'));
    }
    if (this.tool === 'road') settings.push(field('Lanes', this.lanes, v => (this.lanes = Math.round(v)), 1, 8, 1), h('div', { class: 'muted small' }, `${fmt(this.lanes * LANE)} m wide (${LANE} m a lane).`));
    if (this.tool === 'tree') {
      const k = h('select', { onchange: () => (this.treeKind = k.value as 'round' | 'conifer') }, h('option', { value: 'round' }, 'Round (leafy)'), h('option', { value: 'conifer' }, 'Conifer'));
      k.value = this.treeKind;
      settings.push(h('label', {}, 'Kind', k), field('Height (m)', this.treeSize, v => (this.treeSize = v), 1, 60));
    }
    if (this.tool === 'model') settings.push(this.modelLibrary());
    if (this.tool === 'water') settings.push(field('Size (m)', this.waterSize, v => (this.waterSize = v), 1, this.s.size));
    if (this.tool === 'raise' || this.tool === 'lower' || this.tool === 'smooth' || this.tool === 'flatten') {
      settings.push(field('Brush radius (m)', this.radius, v => (this.radius = v), 1, 100), field('Strength', this.strength, v => (this.strength = v), 0.05, 5, 0.05));
    }

    this.left.innerHTML = '';
    put(this.left,
      h('div', { class: 'box-title' }, 'Tools'),
      h('div', { class: 'row tools-grid' }, ...TOOLS.map(toolBtn)),
      h('div', { class: 'muted small' }, TOOLS.find(t => t[0] === this.tool)![2]),
      ...settings.filter(Boolean) as Node[],
      this.selectedBox(lib),
      h('div', { class: 'box-title' }, `Buildings (${this.p.items.length})`),
      h('div', { class: 'plans' }, ...this.p.items.map(it => {
        const src = lib.find(x => x.id === it.projectId);
        return h('div', { class: 'plan-row' + (it.id === this.sel ? ' active' : ''), onclick: () => { this.sel = it.id; this.refresh(); } },
          src?.name ?? '(deleted project)');
      })),
      h('div', { class: 'muted small' }, `Ground: ${s.size} × ${s.size} m. Roads ${s.roads.length} · gravel ${s.gravel.length} · trees ${s.trees.length} · models ${s.models.length} · water ${s.water.length}.`),
    );
  }

  /** The selected thing: its numbers and actions. */
  private selectedBox(lib: Project[]): HTMLElement | null {
    const id = this.sel, s = this.s;
    if (!id) return null;
    const box = h('div', { class: 'box' });
    const field = (label: string, v: number, set: (x: number) => void, step = 0.5) => {
      const inp = h('input', { type: 'number', step, value: String(Math.round(v * 100) / 100), onchange: () => { const x = num(inp.value); if (isFinite(x)) this.mutate(() => set(x)); } });
      return h('label', {}, label, inp);
    };
    const del = h('button', { class: 'danger', onclick: () => this.removeSelected() }, 'Remove (Del)');
    const it = this.p.items.find(x => x.id === id);
    if (it) {
      const src = lib.find(x => x.id === it.projectId), L = src?.buildings[0].baseLength ?? 10;
      const ground = heightAt(s, it.x + L / 2, it.y + L / 2), z = it.z ?? ground;
      put(box,
        h('div', { class: 'box-title' }, src?.name ?? 'Building'),
        h('div', { class: 'row' }, field('East (m)', it.x, x => (it.x = x)), field('North (m)', it.y, x => (it.y = x))),
        h('div', { class: 'row' }, field('Height (m)', z, x => (it.z = x), 0.1), field('Turn (°)', it.rot ?? 0, x => (it.rot = x), 5)),
        h('div', { class: 'row' },
          h('button', { onclick: () => this.mutate(() => (it.z = Math.round((z + 0.5) * 100) / 100)) }, '▲ Up'),
          h('button', { onclick: () => this.mutate(() => (it.z = Math.round((z - 0.5) * 100) / 100)) }, '▼ Down'),
          h('button', { title: 'Stand it on the ground under its middle', onclick: () => this.mutate(() => (it.z = Math.round(ground * 100) / 100)) }, 'On the ground'),
          h('button', {
            title: 'Make the ground under it level with its ground floor',
            onclick: () => this.mutate(() => {
              const c = { x: it.x + L / 2, y: it.y + L / 2 }, r = ((it.rot ?? 0) * Math.PI) / 180;
              const corner = (dx: number, dy: number) => ({ x: c.x + dx * Math.cos(r) + dy * Math.sin(r), y: c.y - dx * Math.sin(r) + dy * Math.cos(r) });
              levelUnder(s, [corner(-L / 2, -L / 2), corner(L / 2, -L / 2), corner(L / 2, L / 2), corner(-L / 2, L / 2)], z);
            }),
          }, 'Level the ground under it')),
        h('div', { class: 'muted small' }, `Drag it in the view to move it. The ground under its middle is at ${fmt(ground)} m.`),
        h('div', { class: 'row' }, src ? h('button', { onclick: () => this.openProject(src.id) }, 'Open building') : null, del),
      );
      return box;
    }
    const road = s.roads.find(x => x.id === id), gr = s.gravel.find(x => x.id === id), tr = s.trees.find(x => x.id === id), m = s.models.find(x => x.id === id), w = s.water.find(x => x.id === id);
    if (road) put(box, h('div', { class: 'box-title' }, 'Road'), field('Lanes', road.lanes, x => (road.lanes = Math.max(1, Math.min(8, Math.round(x)))), 1), h('div', { class: 'muted small' }, `${fmt(road.lanes * LANE)} m wide, ${road.points.length} points.`), del);
    if (gr) put(box, h('div', { class: 'box-title' }, 'Gravel'), h('div', { class: 'muted small' }, `${gr.points.length} corners. Drag it to move it.`), del);
    if (tr) {
      const k = h('select', { onchange: () => this.mutate(() => (tr.kind = k.value as 'round' | 'conifer')) }, h('option', { value: 'round' }, 'Round (leafy)'), h('option', { value: 'conifer' }, 'Conifer'));
      k.value = tr.kind;
      put(box, h('div', { class: 'box-title' }, 'Tree'), h('label', {}, 'Kind', k), field('Height (m)', tr.size, x => (tr.size = Math.max(1, x))), del);
    }
    if (m) put(box, h('div', { class: 'box-title' }, this.p.designs.find(d => d.id === m.designId)?.name ?? '3D model'),
      h('div', { class: 'row' }, field('Size (m)', m.scale, x => (m.scale = Math.max(0.1, x))), field('Turn (°)', m.rot, x => (m.rot = x), 5)),
      field('Height (m, empty = on the ground)', m.z ?? heightAt(s, m.x, m.y), x => (m.z = x), 0.1), del);
    if (w) put(box, h('div', { class: 'box-title' }, 'Water'),
      h('div', { class: 'row' }, field('Width (m)', w.w, x => (w.w = Math.max(1, x))), field('Depth (m)', w.d, x => (w.d = Math.max(1, x)))),
      field('Water level (m)', w.level, x => (w.level = x), 0.1),
      h('div', { class: 'muted small' }, 'Where the ground is higher than the water, the water is hidden under it: lower the ground (Lower ground) to make a lake.'), del);
    return box;
  }

  /** Imported 3D models of this site (and the built-in ones). */
  private modelLibrary(): HTMLElement {
    const file = h('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const format = formatOf(f.name);
      if (!format) return toast('Use a .glb, .gltf (self-contained), .obj or .stl file');
      const d: Design = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), category: 'model', format };
      try { await importDesignFile(d.id, format, await f.arrayBuffer()); this.addModel = d.id; this.mutate(() => this.p.designs.push(d)); }
      catch { toast('Could not read that 3D file'); }
    });
    const sel = h('select', { onchange: () => (this.addModel = sel.value) }, h('option', { value: '' }, 'Choose a model…'), ...this.p.designs.map(d => h('option', { value: d.id }, d.name)));
    sel.value = this.addModel;
    return h('div', {},
      this.p.designs.length ? sel : null,
      h('div', { class: 'row' }, h('button', { onclick: () => file.click() }, 'Import 3D file…'), file,
        ...Object.entries(BUILTIN_DESIGNS).map(([key, bd]) => h('button', {
          disabled: this.p.designs.some(d => d.builtin === key),
          onclick: () => { const d: Design = { id: uid(), name: bd.name, category: bd.category, format: 'builtin', builtin: key }; this.addModel = d.id; this.mutate(() => this.p.designs.push(d)); },
        }, `+ ${bd.name}`))),
    );
  }
}

void askConfirm;
