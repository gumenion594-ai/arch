// Building project editor: floors panel, 3D view, structure / floor / window planners.
import {
  Building, BalconyShape, DecoDesign, DecoType, PilasterShape, WallShape, ConnectMode, DesignCategory, Floor, History, OpeningShape, PlacementType, segConnect, MATERIALS, MAX_M, PlanObject, PlanSegment, Project, SegKind, StructurePlan,
  addLoops, clamp, elevation, floorBase, floorLabel, formatRanges, newAreaPlan, newInteriorPlan, newPlan, parseRanges, planForFloor, saveProject,
  segKind, totalHeight, uid,
} from './model';
import { Hit, Viewer, ViewMode } from './viewer';
import { Planner, Tool, fmt } from './planner';
import { DesignView } from './designview';
import { renderDecoPanel } from './decopanel';
import { ShapeEditor, ShapeTool } from './shapeeditor';
import { DesignMode, PickMode, onPick, renderDesignPanel, renderViewPanel, setupDesignMode } from './decor';
import { V2, enclosedFaces, planValid, sampleSeg, signedArea } from './geometry';
import { Selection, areaForFloor, autoFloorAreas, interiorForFloor, loftPointTarget } from './build3d';
import { calculate, Report } from './stats';
import { app, askConfirm, askText, h, num, put, toast } from './ui';

type Mode = 'view' | 'structure' | 'floorplan' | 'floorarea' | DesignMode | 'decos';
const isDesign = (m: Mode): m is DesignMode => m === 'openings' || m === 'niches' || m === 'balconies' || m === 'walls' || m === 'pilasters';
const PLAN_COLORS = ['#4a90d9', '#d97a4a', '#5cb85c', '#b05cd9', '#d9c84a', '#4ad9c8', '#d94a7a', '#8a8a8a'];

const pref = (k: string, d: string) => { try { return localStorage.getItem('arch.pref.' + k) ?? d; } catch { return d; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem('arch.pref.' + k, v); } catch { /* ignore */ } };

export class Editor {
  p: Project;
  hist = new History();
  mode: Mode = 'view';
  viewMode: ViewMode = 'structural';
  showArea = pref('showArea', '1') === '1';
  // selection shared by the floor bar and the 3D view
  selFloors = new Set<string>();
  selWalls = new Set<string>(); // floorId|segId
  selDivs = new Set<string>(); // floorId|segId|k
  pickMode: PickMode = 'wall';
  private anchor: string | null = null;
  activePlan: Record<'structure' | 'floorplan' | 'floorarea', string | null> = { structure: null, floorplan: null, floorarea: null };
  activeDesign: Record<DesignMode, string | null> = { openings: null, niches: null, balconies: null, walls: null, pilasters: null };
  selBorders = new Set<string>(); // floorId|segId|k
  selElements = new Set<string>(); // placement ids
  addType: PlacementType = 'opening';
  libCategory: DesignCategory = 'frame';
  upTo: number | null = null; // cutaway (3D view)
  shapeEds: ShapeEditor[] = [];
  report: Report | null = null;
  root = h('div', { class: 'editor' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  right = h('div', { class: 'right panel' });
  header = h('div', { class: 'header' });
  viewer: Viewer | null = null;
  planner: Planner | null = null;

  constructor(p: Project, private onBack: () => void) {
    this.p = p;
    this.activePlan.structure = this.b.plans[0]?.id ?? null;
    this.activePlan.floorplan = this.b.interiorPlans[0]?.id ?? null;
    this.root.append(this.header, this.left, this.center, this.right, this.leftToggle, this.rightToggle);
    app.innerHTML = '';
    app.append(this.root);
    window.addEventListener('keydown', this.onKey);
    this.setMode('view');
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    this.viewer?.dispose(); this.planner?.dispose(); this.shapeEds.forEach(e => e.dispose()); this.decoView?.dispose();
  }

  /** The building (a building project has exactly one). */
  get b(): Building { return this.p.buildings[0]; }

  // ---- change management ----
  begin() { this.hist.push(this.p); }
  commit() { this.report = null; saveProject(this.p); this.refresh(); }
  mutate(fn: () => void) { this.begin(); fn(); this.commit(); }
  undo() {
    const prev = this.hist.pop();
    if (!prev) return toast('Nothing to undo');
    this.p = prev;
    const fids = new Set(this.b.floors.map(f => f.id));
    for (const id of [...this.selFloors]) if (!fids.has(id)) this.selFloors.delete(id);
    if (!this.b.plans.some(pl => pl.id === this.activePlan.structure)) this.activePlan.structure = this.b.plans[0]?.id ?? null;
    if (!this.b.interiorPlans.some(pl => pl.id === this.activePlan.floorplan)) this.activePlan.floorplan = this.b.interiorPlans[0]?.id ?? null;
    if (!this.b.areaPlans.some(pl => pl.id === this.activePlan.floorarea)) this.activePlan.floorarea = this.b.areaPlans[0]?.id ?? null;
    const pids = new Set(this.b.placements.map(x => x.id));
    for (const id of [...this.selElements]) if (!pids.has(id)) this.selElements.delete(id);
    saveProject(this.p);
    this.report = null;
    this.planner?.prune();
    this.refresh();
  }

  get selection(): Selection { return { floors: this.selFloors, walls: this.selWalls, divisions: this.selDivs, borders: this.selBorders, elements: this.selElements }; }

  refresh() {
    this.renderHeader();
    this.renderLeft();
    // 3D first: the side panel shows numbers the build produces (e.g. windows that no longer fit)
    if (this.mode === 'view') this.viewer?.update({ id: this.p.id, buildings: this.p.buildings, textures: this.p.textures, designs: this.p.designs, decos: this.p.decos }, { activeId: '*', mode: this.viewMode, selection: this.selection, showArea: this.showArea, upTo: this.upTo });
    this.renderRight();
    this.planner?.draw();
    this.shapeEds.forEach(e => e.draw());
    if (this.mode === 'decos') { this.decoView?.set(this.deco(), this.b, this.p.designs, () => this.refresh()); this.decoView?.select(this.decoPart); }
  }

  /** Design tab: the 3D editor, the design type shown, the design open (per type) and its selected part. */
  decoView: DesignView | null = null;
  decoType: DecoType = 'opening';
  activeDeco: Partial<Record<DecoType, string>> = {};
  decoPart: string | null = null;
  deco(): DecoDesign | null {
    const list = this.p.decos.filter(d => d.type === this.decoType);
    return list.find(d => d.id === this.activeDeco[this.decoType]) ?? list[0] ?? null;
  }
  /** Last shape category opened in the Shape tab. */
  designKind: DesignMode = 'openings';
  private preWalkMode: ViewMode | null = null;
  /** Side panels hidden (each on its own, with the small arrow buttons); both hidden automatically in first person. */
  hideLeft = false;
  hideRight = false;
  private preWalkPanels: [boolean, boolean] | null = null;
  private leftToggle = h('button', { class: 'panel-toggle', onclick: () => this.setPanels(!this.hideLeft, this.hideRight) });
  private rightToggle = h('button', { class: 'panel-toggle', onclick: () => this.setPanels(this.hideLeft, !this.hideRight) });
  setPanels(hideLeft: boolean, hideRight: boolean) {
    this.hideLeft = hideLeft; this.hideRight = hideRight;
    const r = this.root;
    r.classList.toggle('hide-left', hideLeft);
    r.classList.toggle('hide-right', hideRight);
    const right = r.classList.contains('with-right') && !hideRight;
    const cols = [hideLeft ? null : '230px', '1fr', right ? '290px' : null].filter(Boolean);
    const areas = [hideLeft ? null : 'l', 'c', right ? 'r' : null].filter(Boolean);
    r.style.gridTemplateColumns = cols.join(' ');
    r.style.gridTemplateAreas = `"${areas.map(() => 'h').join(' ')}" "${areas.join(' ')}"`;
    // the arrows sit at the top corner of each panel (or at the window edge when it is hidden)
    Object.assign(this.leftToggle.style, { left: hideLeft ? '4px' : '234px' });
    Object.assign(this.rightToggle.style, { right: hideRight ? '4px' : right ? '294px' : '4px', display: r.classList.contains('with-right') ? '' : 'none' });
    this.leftToggle.textContent = hideLeft ? '▶' : '◀'; this.leftToggle.title = hideLeft ? 'Show the floors panel' : 'Hide the floors panel';
    this.rightToggle.textContent = hideRight ? '◀' : '▶'; this.rightToggle.title = hideRight ? 'Show the tools panel' : 'Hide the tools panel';
    requestAnimationFrame(() => { this.planner?.draw(); this.shapeEds.forEach(e => e.draw()); });
  }
  setMode(m: Mode) {
    this.mode = m;
    if (isDesign(m)) this.designKind = m;
    this.viewer?.dispose(); this.viewer = null;
    this.decoView?.dispose(); this.decoView = null;
    this.planner?.dispose(); this.planner = null;
    this.shapeEds.forEach(e => e.dispose()); this.shapeEds = [];
    this.center.innerHTML = '';
    this.center.classList.toggle('niche-grid', m === 'niches');
    this.center.classList.toggle('pair-grid', m === 'pilasters');
    this.root.classList.add('with-right');
    this.setPanels(this.hideLeft, this.hideRight);
    if (m === 'view') {
      this.viewer = new Viewer(this.center);
      this.viewer.onTexture = () => this.refresh();
      this.viewer.onPick = (hit, e) => onPick(this, hit, e);
      this.viewer.onWalkChange = walking => {
        if (walking && this.preWalkPanels === null) { this.preWalkPanels = [this.hideLeft, this.hideRight]; this.setPanels(true, true); }
        if (!walking && this.preWalkPanels !== null) { const [l, rr] = this.preWalkPanels; this.preWalkPanels = null; this.setPanels(l, rr); }
        if (!walking && this.preWalkMode) { this.viewMode = this.preWalkMode; this.preWalkMode = null; this.refresh(); return; }
        this.renderHeader(); this.renderRight();
      };
    } else if (m === 'decos') {
      this.decoView = new DesignView(this.center, {
        select: id => { this.decoPart = id; this.decoView?.select(id); this.renderRight(); },
        begin: () => this.begin(), commit: () => this.commit(), live: () => this.renderRight(),
      });
    } else if (isDesign(m)) {
      const list: { id: string }[] = m === 'balconies' ? this.b.balconyShapes : m === 'walls' ? this.b.wallShapes : m === 'pilasters' ? this.b.pilasterShapes
        : this.b.openingShapes.filter(x => x.kind === (m === 'openings' ? 'opening' : 'niche'));
      if (!list.some(x => x.id === this.activeDesign[m])) this.activeDesign[m] = list[0]?.id ?? null;
      setupDesignMode(this, m);
    } else {
      this.planner = new Planner(this.center, {
        getPlan: () => this.plan(),
        getGhost: () => this.ghostPlan(),
        links: () => this.ghostLinks(),
        allowed: () => (this.mode === 'floorplan' ? this.allowedArea() : null),
        baseLength: () => this.b.baseLength,
        divLen: sg => sg.divLen ?? this.b.divLen,
        begin: () => this.begin(),
        commit: () => this.commit(),
        toast,
        selectionChanged: () => this.renderRight(),
        area: m === 'floorarea',
        snapPlans: () => this.areaRefs(),
      });
      if (m === 'floorarea') this.planner.tool = 'draw';
    }
    this.refresh();
  }

  plans(): StructurePlan[] { return this.mode === 'floorplan' ? this.b.interiorPlans : this.mode === 'floorarea' ? this.b.areaPlans : this.b.plans; }
  private planKey(): 'structure' | 'floorplan' | 'floorarea' { return this.mode === 'floorplan' ? 'floorplan' : this.mode === 'floorarea' ? 'floorarea' : 'structure'; }
  /** Floor of the active floor-area plan: the selected floor if it uses it, else its first floor. */
  private areaFloor(): number {
    const pl = this.plan();
    const sel = this.b.floors.findIndex(f => this.selFloors.has(f.id) && pl?.floorIds.includes(f.id));
    return sel >= 0 ? sel : this.b.floors.findIndex(f => pl?.floorIds.includes(f.id));
  }
  /** Walls a floor-area plan snaps to: the floor's structure and floor plan, and the structure of the floor below. */
  areaRefs(): StructurePlan[] {
    const i = this.areaFloor();
    if (i < 0) return [];
    const f = this.b.floors[i], out = [planForFloor(this.b, f.id), interiorForFloor(this.b, f.id), i > 0 ? planForFloor(this.b, this.b.floors[i - 1].id) : undefined];
    return out.filter((x, k): x is StructurePlan => !!x && out.indexOf(x) === k);
  }
  plan(): StructurePlan | null {
    return this.plans().find(pl => pl.id === this.activePlan[this.planKey()]) ?? null;
  }
  setActivePlan(id: string | null) { this.activePlan[this.planKey()] = id; }
  /** Opening / niche shape being designed. */
  oshape(): OpeningShape | null { const m = this.mode === 'niches' ? 'niches' : 'openings'; return this.b.openingShapes.find(s => s.id === this.activeDesign[m]) ?? null; }
  balcony(): BalconyShape | null { return this.b.balconyShapes.find(s => s.id === this.activeDesign.balconies) ?? null; }
  wshape(): WallShape | null { return this.b.wallShapes.find(s => s.id === this.activeDesign.walls) ?? null; }
  pshape(): PilasterShape | null { return this.b.pilasterShapes.find(s => s.id === this.activeDesign.pilasters) ?? null; }

  /** Floor planner: external-wall plan of the first floor this floor plan is used on. */
  private refStructure(): StructurePlan | null {
    const pl = this.plan();
    const fid = pl ? this.b.floors.find(f => pl.floorIds.includes(f.id))?.id : undefined;
    return fid ? planForFloor(this.b, fid) ?? null : null;
  }
  private allowedArea(): V2[][] | null {
    const ref = this.refStructure();
    return ref ? enclosedFaces(ref) : [];
  }

  /** Reference outline drawn faintly: the plan below (structure) or the external walls (floor plan). */
  ghostPlan(): StructurePlan | null {
    const pl = this.plan();
    if (!pl) return null;
    if (this.mode === 'floorplan') return this.refStructure();
    if (this.mode === 'floorarea') { const i = this.areaFloor(); return i >= 0 ? planForFloor(this.b, this.b.floors[i].id) ?? null : null; }
    const idx = this.b.floors.findIndex(f => pl.floorIds.includes(f.id));
    if (idx > 0) return planForFloor(this.b, this.b.floors[idx - 1].id) ?? null;
    if (idx < 0 && this.b.topPlanId === pl.id) return planForFloor(this.b, this.b.floors[this.b.floors.length - 1].id) ?? null;
    return null;
  }

  planColor(pl: StructurePlan | null | undefined) {
    if (!pl) return 'transparent';
    const list = this.b.plans.includes(pl) ? this.b.plans : this.b.interiorPlans.includes(pl) ? this.b.interiorPlans : this.b.areaPlans;
    return PLAN_COLORS[list.indexOf(pl) % PLAN_COLORS.length];
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.viewer?.walk) return; // walk mode has its own keys
    const tgt = e.target as HTMLElement;
    const typing = tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undo(); return; }
    if (typing) return;
    const finishKey = e.key === 'Enter' || e.key === ' ';
    if (this.shapeEds.length && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); this.shapeEds.forEach(x => x.selectedPoint() && x.deleteSelected()); return; }
    if (this.shapeEds.length && (finishKey || e.key === 'Escape')) { e.preventDefault(); this.shapeEds.forEach(x => x.finish()); return; }
    if (this.mode === 'view' && e.key === 'Escape') { this.clearSel(); return; }
    if (this.mode === 'decos' && this.decoView) {
      // gizmo: W move, E rotate, R scale; Delete removes the selected part
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'e' || k === 'r') { this.decoView.setMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale'); this.renderRight(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.decoPart) { e.preventDefault(); const d = this.deco(); if (d) this.mutate(() => (d.parts = d.parts.filter(x => x.id !== this.decoPart))); this.decoPart = null; }
      if (e.key === 'Escape') { this.decoPart = null; this.decoView.select(null); this.renderRight(); }
      return;
    }
    if (!this.planner) return;
    if (e.key === 'Escape' || finishKey) { e.preventDefault(); this.planner.endChain(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.planner.deleteSelection(); }
    if (e.key === 'd') this.setTool('draw');
    if (e.key === 's') this.setTool('select');
    if (e.key === 'm') this.setTool('move');
    if (e.key === 'c' && this.mode === 'floorarea') this.setTool('carve');
  };
  setTool(t: Tool) {
    if (!this.planner) return;
    this.planner.tool = t;
    if (t !== 'draw') this.planner.head = null;
    this.refresh();
  }

  // ---- header ----
  renderHeader() {
    const nameIn = h('input', {
      class: 'title-input', value: this.p.name,
      onchange: () => { const v = nameIn.value.trim(); if (v && v !== this.p.name) this.mutate(() => { this.p.name = v; this.b.name = v; }); else nameIn.value = this.p.name; },
    });
    const tab = (m: Mode, label: string) => h('button', { class: this.mode === m || (isDesign(m) && isDesign(this.mode)) ? 'tab active' : 'tab', onclick: () => this.setMode(m) }, label);
    const vm = h('select', {
      onchange: () => {
        vm.blur(); // keys go to the view (walking), not the list
        if (vm.value === 'walk') {
          this.preWalkMode = this.viewMode;
          this.viewMode = 'detailed'; // first person always shows the detailed building
          this.refresh();
          this.viewer?.enterWalk();
          return;
        }
        this.viewer?.exitWalk();
        this.viewMode = vm.value as ViewMode; this.refresh();
      },
    },
      h('option', { value: 'plan' }, 'Floor plan view'),
      h('option', { value: 'structural' }, 'Structural view'),
      h('option', { value: 'detailed' }, 'Detailed view'),
      h('option', { value: 'walk' }, 'First person view'),
    );
    vm.value = this.viewer?.walk ? 'walk' : this.viewMode;
    const area = h('input', { type: 'checkbox', checked: this.showArea, onchange: () => { this.showArea = area.checked; setPref('showArea', area.checked ? '1' : '0'); this.refresh(); } });
    this.header.innerHTML = '';
    put(this.header, 
      h('button', { onclick: () => this.onBack() }, '← Projects'),
      nameIn,
      h('div', { class: 'tabs' }, tab('view', '3D view'), tab('structure', 'Structure'), tab('floorplan', 'Floor plan'), tab('floorarea', 'Floor areas'), tab(this.designKind, 'Shape'), tab('decos', 'Design')),
      this.mode === 'view' ? vm : null,
      this.mode === 'view' ? h('label', { class: 'chk', title: 'Show the building-area outline and floor lines' }, area, 'Area lines') : null,
      h('div', { class: 'spacer' }),
      h('button', { title: 'Import 3D models and arrange them into designs', onclick: () => this.setMode('decos') }, 'Import 3D model'),
      h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, 'Undo'),
    );
  }

  // ---- floors panel ----
  private clickFloor(e: MouseEvent, id: string) {
    const ids = this.b.floors.map(f => f.id);
    if (e.shiftKey && this.anchor && ids.includes(this.anchor)) {
      const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(id)].sort((x, y) => x - y);
      this.selFloors = new Set(ids.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      this.selFloors.has(id) ? this.selFloors.delete(id) : this.selFloors.add(id);
      this.anchor = id;
    } else {
      this.selFloors = this.selFloors.size === 1 && this.selFloors.has(id) ? new Set() : new Set([id]);
      this.anchor = id;
    }
    this.selWalls.clear(); this.selDivs.clear();
    // in a planner, show the plan the clicked floor uses
    if ((this.mode === 'structure' || this.mode === 'floorplan' || this.mode === 'floorarea') && this.selFloors.has(id)) {
      const pl = this.mode === 'structure' ? planForFloor(this.b, id) : this.mode === 'floorplan' ? interiorForFloor(this.b, id) : areaForFloor(this.b, id);
      if (pl && pl.id !== this.plan()?.id) {
        this.setActivePlan(pl.id);
        if (this.planner) { this.planner.head = null; this.planner.selPoints.clear(); this.planner.selSegs.clear(); this.planner.selObj = null; }
      } else if (!pl) toast(`Floor ${floorLabel(this.b, this.b.floors.findIndex(f => f.id === id))} has no ${this.mode === 'structure' ? 'structure plan' : this.mode === 'floorplan' ? 'floor plan' : 'floor-area plan (its floor is automatic)'} yet: pick one in the floor panel or press Edit`);
    }
    this.refresh();
  }

  renderLeft() {
    const p = this.b, H = totalHeight(p);
    const bar = h('div', { class: 'floorbar' });
    const top = p.plans.find(pl => pl.id === p.topPlanId);
    bar.append(h('div', { class: 'ftop', title: 'Top level (roof)', style: `border-left-color:${this.planColor(top)}` }, `Top · ${top?.name ?? 'no plan'}`));
    p.floors.forEach((f, i) => {
      const bottom = (floorBase(p, i) / H) * 100, hp = (f.height / H) * 100;
      const pl = planForFloor(p, f.id);
      const seg = h('div', {
        class: 'fseg' + (this.selFloors.has(f.id) ? ' sel' : '') + (i < p.ground ? ' under' : ''),
        style: `bottom:${bottom}%;height:${hp}%;border-left-color:${this.planColor(pl)}`,
        title: `Floor ${floorLabel(p, i)} · ${fmt(f.height)} m · ${pl?.name ?? 'no plan'}\nClick: select · Shift: range · Ctrl: add · Double-click: split here`,
        onclick: (e: MouseEvent) => this.clickFloor(e, f.id),
        ondblclick: (e: MouseEvent) => {
          const r = seg.getBoundingClientRect();
          this.splitFloor(f.id, clamp((r.bottom - e.clientY) / r.height, 0.05, 0.95));
        },
      }, h('span', {}, `${floorLabel(p, i)} · ${fmt(f.height)} m`));
      const handle = h('div', { class: 'fhandle', title: 'Drag to change this floor height' });
      handle.addEventListener('mousedown', e => {
        e.stopPropagation(); e.preventDefault();
        const startY = e.clientY, startH = f.height, mPerPx = H / bar.clientHeight;
        const others = H - startH;
        let began = false;
        const mv = (ev: MouseEvent) => {
          const nh = clamp(startH + (startY - ev.clientY) * mPerPx, 0.1, MAX_M - others);
          if (!began) { this.begin(); began = true; }
          f.height = Math.round(nh * 100) / 100;
          this.refresh();
        };
        const upf = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', upf); if (began) this.commit(); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', upf);
      });
      seg.append(handle);
      bar.append(seg);
    });
    for (let k = 0; k <= p.floors.length; k++) {
      bar.append(h('button', {
        class: 'fins', style: `bottom:${(floorBase(p, k) / H) * 100}%`,
        title: k === 0 ? 'Add a floor at the bottom' : k === p.floors.length ? 'Add a floor on top' : `Insert a floor between ${floorLabel(p, k - 1)} and ${floorLabel(p, k)}`,
        onclick: (e: Event) => { e.stopPropagation(); this.insertFloor(k); },
      }, '+'));
    }
    bar.append(h('div', { class: 'gline', style: `bottom:${(floorBase(p, p.ground) / H) * 100}%` }, h('span', {}, 'ground')));

    const eqIn = h('input', { type: 'number', step: 0.1, value: fmt(H) });
    this.left.innerHTML = '';
    put(this.left, 
      h('div', { class: 'box-title' }, 'Floors'),
      h('div', { class: 'muted small' }, `${p.floors.length} floors (${p.ground} underground) · ${fmt(H)} m · base ${fmt(p.baseLength)} m (${fmt(p.baseLength ** 2)} m²)`),
      h('div', { class: 'row' }, h('button', { onclick: () => this.insertFloor(p.floors.length) }, '+ Top floor')),
      h('div', { class: 'row eq' },
        h('label', {}, 'Total height (m)', eqIn),
        h('button', {
          title: 'Make all floors the same height so they add up to this total',
          onclick: () => {
            const v = num(eqIn.value);
            if (!(v > 0) || v > MAX_M) return toast('Total height must be between 0 and 10 000 m');
            this.mutate(() => p.floors.forEach(f => (f.height = v / p.floors.length)));
          },
        }, 'Equalize'),
      ),
      h('div', { class: 'floorbar-wrap' }, bar),
      this.floorSelectionBox(),
    );
    bar.querySelectorAll<HTMLElement>('.fseg').forEach(el => { if (el.clientHeight < 14) el.querySelector('span')?.remove(); });
  }

  insertFloor(k: number) {
    const p = this.b;
    const ref = p.floors[Math.min(k, p.floors.length - 1)] ?? p.floors[k - 1];
    const below = p.floors[k - 1] ?? ref;
    if (totalHeight(p) + below.height > MAX_M) return toast('That would exceed 10 000 m');
    this.mutate(() => {
      const nf = { id: uid(), height: below.height };
      p.floors.splice(k, 0, nf);
      planForFloor(p, below.id)?.floorIds.push(nf.id);
      interiorForFloor(p, below.id)?.floorIds.push(nf.id);
      if (k <= p.ground && k < p.floors.length - 1) p.ground++;
      this.selFloors = new Set([nf.id]);
    });
  }

  private floorSelectionBox(): HTMLElement {
    const p = this.b, H = totalHeight(p);
    const idx = p.floors.map((f, i) => (this.selFloors.has(f.id) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return h('div', { class: 'muted small' }, 'Click a floor to select it (Shift = range, Ctrl = add). Drag its top edge to resize, double-click to split, + to insert a floor.');
    const sel = idx.map(i => p.floors[i]);
    const one = sel.length === 1 ? sel[0] : null;
    const sameH = sel.every(f => f.height === sel[0].height);
    const hin = h('input', {
      type: 'number', step: 0.1, value: sameH ? fmt(sel[0].height) : '', placeholder: 'mixed',
      onchange: () => {
        const v = num(hin.value);
        const newTotal = H - sel.reduce((s, f) => s + f.height, 0) + v * sel.length;
        if (!(v > 0) || newTotal > MAX_M) { toast('Invalid floor height'); return this.refresh(); }
        this.mutate(() => sel.forEach(f => (f.height = v)));
      },
    });
    const planPicker = (list: StructurePlan[], label: string) => {
      const cur = new Set(sel.map(f => list.find(pl => pl.floorIds.includes(f.id))?.id ?? ''));
      const s = h('select', {
        onchange: () => this.mutate(() => {
          const ids = sel.map(f => f.id);
          list.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.includes(id))));
          list.find(pl => pl.id === s.value)?.floorIds.push(...ids);
        }),
      }, ...(cur.size > 1 ? [h('option', { value: '__mixed', disabled: true }, 'mixed')] : []),
        h('option', { value: '' }, '— none —'), ...list.map(pl => h('option', { value: pl.id }, pl.name)));
      s.value = cur.size > 1 ? '__mixed' : [...cur][0];
      return h('label', {}, label, s);
    };
    return h('div', { class: 'box' },
      h('div', { class: 'box-title' }, one ? `Floor ${floorLabel(p, idx[0])}` : `${sel.length} floors: ${formatRanges(p, idx)}`),
      h('label', {}, one ? 'Height (m)' : 'Height of each (m)', hin),
      planPicker(p.plans, 'Structure plan'),
      planPicker(p.interiorPlans, 'Floor plan'),
      planPicker(p.areaPlans, 'Floor area'),
      h('div', { class: 'row' }, this.floorToggle(sel, 'hasFloor', 'Floor'),
        sel.some(f => f === p.floors[p.floors.length - 1]) ? this.floorToggle(sel.filter(f => f === p.floors[p.floors.length - 1]), 'hasCeiling', 'Roof') : null,
        h('button', { title: 'Draw where this floor has floor: lines enclose shapes, carve the ones without floor', onclick: () => this.editFloorIn('floorarea', sel[0].id) }, 'Edit floor area')),
      one ? h('div', { class: 'muted small' }, `Starts at ${fmt(elevation(p, idx[0]))} m`) : null,
      h('div', { class: 'row' },
        h('button', { onclick: () => this.editFloorIn('structure', sel[0].id) }, 'Edit structure'),
        h('button', { onclick: () => this.editFloorIn('floorplan', sel[0].id) }, 'Edit floor plan'),
      ),
      h('div', { class: 'row' },
        h('button', { title: 'Shape the selected floors into a dome, starting from the outline of the lowest one', onclick: () => this.makeDome(idx) }, 'Make dome'),
        one ? h('button', { onclick: () => this.splitFloor(one.id, 0.5) }, 'Split') : null,
        one && idx[0] !== p.ground ? h('button', { title: 'Floors below this one become underground', onclick: () => this.mutate(() => (p.ground = idx[0])) }, 'Make ground floor') : null,
        h('button', {
          class: 'danger', disabled: sel.length >= p.floors.length,
          onclick: () => this.mutate(() => {
            const ids = sel.map(f => f.id);
            const groundId = p.floors[p.ground].id;
            const removedBelow = idx.filter(i => i < p.ground).length;
            p.floors = p.floors.filter(f => !ids.includes(f.id));
            [...p.plans, ...p.interiorPlans, ...p.areaPlans].forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.includes(id))));
            const gi = p.floors.findIndex(f => f.id === groundId);
            p.ground = gi >= 0 ? gi : clamp(p.ground - removedBelow, 0, p.floors.length - 1);
            this.selFloors.clear();
          }),
        }, 'Delete'),
      ),
    );
  }

  /** Checkbox switching the floor / ceiling slab of the selected floors (indeterminate when mixed). */
  private floorToggle(sel: Floor[], key: 'hasFloor' | 'hasCeiling', label: string) {
    const on = sel.map(f => f[key] !== false);
    const cb = h('input', {
      type: 'checkbox', checked: on.every(Boolean),
      onchange: () => this.mutate(() => sel.forEach(f => (f[key] = cb.checked))),
    });
    cb.indeterminate = !on.every(Boolean) && on.some(Boolean);
    return h('label', { class: 'chk', title: key === 'hasFloor' ? 'Slab at the bottom of the floor' : 'Slab at the top of the floor' }, cb, label);
  }

  /** Planner: dashed lines from the plan below to the points its walls connect to (when not straight up). */
  ghostLinks(): [V2, V2][] {
    const pl = this.plan(), below = this.ghostPlan();
    if (this.mode !== 'structure' || !pl || !below || below === pl || !pl.points.length) return [];
    const ends = new Set(below.segments.filter(sg => segConnect(below, sg) === 'loft' && segKind(sg) !== 'open').flatMap(sg => [sg.a, sg.b]));
    return below.points.filter(q => ends.has(q.id)).map(q => [q, loftPointTarget(below, pl, q)] as [V2, V2]);
  }

  /**
   * Dome over the selected floors: each floor gets a copy of the lowest floor's outline,
   * shrunk like a sphere (radius × √(1 − (h/H)²) at height h of total H), all connecting up
   * with full smoothness. If the top floor is included, the Top level becomes the apex point.
   */
  makeDome(idx: number[]) {
    const b = this.b;
    const first = b.floors[idx[0]];
    const base = planForFloor(b, first.id);
    const faces = base ? enclosedFaces(base) : [];
    if (!base || !faces.length) return toast('The lowest selected floor needs a closed outline (external walls around an area) to build a dome on');
    const run = b.floors.slice(idx[0], idx[idx.length - 1] + 1);
    const H = run.reduce((s2, f) => s2 + f.height, 0);
    const poly = faces.reduce((a, f) => (Math.abs(signedArea(f)) > Math.abs(signedArea(a)) ? f : a));
    const c = poly.reduce((acc, q) => ({ x: acc.x + q.x / poly.length, y: acc.y + q.y / poly.length }), { x: 0, y: 0 });
    const top = idx[idx.length - 1] === b.floors.length - 1;
    this.mutate(() => {
      const ids = new Set(run.map(f => f.id));
      b.plans.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.has(id))));
      let y = 0;
      run.forEach((f, j) => {
        const k = Math.sqrt(Math.max(0, 1 - (y / H) ** 2));
        const pl: StructurePlan = JSON.parse(JSON.stringify(base));
        pl.id = uid(); pl.name = `Dome ${j + 1}`; pl.floorIds = [f.id];
        pl.connect = 'loft'; pl.connectSmooth = 1; pl.smoothSpan = true;
        pl.segments.forEach(sg => { sg.connect = null; sg.connectSmooth = null; sg.smoothSpan = null; });
        pl.points.forEach(q => { q.x = c.x + (q.x - c.x) * k; q.y = c.y + (q.y - c.y) * k; });
        b.plans.push(pl);
        y += f.height;
      });
      if (top) {
        const apex = newPlan('Dome apex');
        apex.points = [{ id: uid(), n: 1, x: c.x, y: c.y }];
        apex.nextN = 2;
        b.plans.push(apex);
        b.topPlanId = apex.id;
      }
    });
    toast(top ? `Dome over ${run.length} floor(s), closing at the top point` : `Dome over ${run.length} floor(s); it connects into the plan of the floor above`);
  }

  splitFloor(id: string, ratio: number) {
    const i = this.b.floors.findIndex(f => f.id === id);
    const f = this.b.floors[i];
    this.mutate(() => {
      const lower = Math.round(f.height * ratio * 100) / 100;
      // the new part becomes a subfloor (5 -> 5 and 5.1; later subfloors renumber in order)
      const nf: Floor = { id: uid(), height: Math.round((f.height - lower) * 100) / 100, sub: true };
      f.height = lower;
      this.b.floors.splice(i + 1, 0, nf);
      planForFloor(this.b, f.id)?.floorIds.push(nf.id);
      interiorForFloor(this.b, f.id)?.floorIds.push(nf.id);
      this.selFloors = new Set([nf.id]);
    });
  }

  /**
   * Jump to the structure / floor planner for a floor: opens the plan used by that floor
   * (creating a floor plan for it if it has none) and selects the given wall.
   */
  editFloorIn(mode: 'structure' | 'floorplan' | 'floorarea', floorId: string, segId?: string) {
    const b = this.b;
    let pl = mode === 'structure' ? planForFloor(b, floorId) : mode === 'floorplan' ? interiorForFloor(b, floorId) : areaForFloor(b, floorId);
    if (!pl) {
      this.begin();
      if (mode === 'floorarea') {
        // start from what the floor has now (the automatic floor), as lines you can change
        pl = newAreaPlan(`Floor area ${b.areaPlans.length + 1}`, [floorId]);
        addLoops(pl, autoFloorAreas(b, b.floors.findIndex(f => f.id === floorId)));
        b.areaPlans.push(pl);
      } else {
        pl = mode === 'structure' ? newPlan(`Plan ${b.plans.length + 1}`, [floorId]) : newInteriorPlan(`Floor plan ${b.interiorPlans.length + 1}`);
        if (mode === 'floorplan') pl.floorIds = [floorId];
        (mode === 'structure' ? b.plans : b.interiorPlans).push(pl);
      }
      saveProject(this.p);
    }
    this.activePlan[mode] = pl.id;
    this.selFloors = new Set([floorId]);
    this.setMode(mode);
    if (segId && this.planner) {
      this.planner.tool = 'select';
      this.planner.selSegs = new Set([segId]);
    }
    this.refresh();
  }

  // ---- right panel ----
  renderRight() {
    if (this.mode === 'view') return renderViewPanel(this);
    if (isDesign(this.mode)) return renderDesignPanel(this, this.mode);
    if (this.mode === 'decos') return renderDecoPanel(this);
    this.renderPlanPanel();
  }

  clearSets() { this.selFloors.clear(); this.selWalls.clear(); this.selDivs.clear(); this.selBorders.clear(); this.selElements.clear(); }
  clearSel() { this.clearSets(); this.refresh(); }

  /** Number input committing on change (with undo). */
  numInput(val: number, set: (v: number) => void, min: number, max: number, allowNeg = false) {
    const inp = h('input', {
      type: 'number', step: 0.05, value: fmt(val),
      onchange: () => {
        const v = num(inp.value);
        if (!isFinite(v) || v < (allowNeg ? -max : min) || v > max) { toast(`Use a value from ${allowNeg ? -max : min} to ${max}`); return this.refresh(); }
        this.mutate(() => set(v));
      },
    });
    return inp;
  }

  reportBox() {
    const r = this.report;
    const t = (rows: (string | number)[][]) => h('table', { class: 'stats' }, ...rows.map(cells => h('tr', {}, ...cells.map((c, i) => h(i ? 'td' : 'th', {}, String(c))))));
    const kg = (v: number) => (v >= 1000 ? `${fmt(v / 1000)} t` : `${fmt(v)} kg`);
    return h('div', { class: 'box' },
      h('div', { class: 'row' }, h('div', { class: 'box-title', style: 'margin:0;flex:1' }, 'Quantities'),
        h('button', { class: 'primary', onclick: () => { this.report = calculate(this.b, this.p.textures); this.refresh(); } }, 'Calculate')),
      r ? h('div', {},
        t([
          ['Building height', `${fmt(r.height)} m above ground`],
          ['Below ground', `${fmt(r.depth)} m`],
          ['Total floor area', `${fmt(r.floorArea)} m² (${r.floors} floors)`],
          ['Window openings', `${r.windowCount} · ${fmt(r.windowArea)} m²`],
        ]),
        h('div', { class: 'box-title' }, 'Walls & columns'),
        t([['', 'Volume', 'Weight'],
          ['External walls', `${fmt(r.ext.volume)} m³`, kg(r.ext.weight)],
          ['Internal walls', `${fmt(r.int.volume)} m³`, kg(r.int.weight)],
          ['Walls total', `${fmt(r.ext.volume + r.int.volume)} m³`, kg(r.ext.weight + r.int.weight)],
          ['Columns', `${fmt(r.col.volume)} m³`, kg(r.col.weight)],
        ]),
        h('div', { class: 'box-title' }, 'By material'),
        t(Object.entries(r.byMaterial).map(([m, v]) => [MATERIALS[m]?.name ?? m, `${fmt(v.volume)} m³`, kg(v.weight)])),
        h('div', { class: 'muted small' }, 'Window openings are subtracted from wall volume. Slabs are not included.'),
      ) : h('div', { class: 'muted small' }, 'Press Calculate for height, floor area, wall and column volumes and weights.'),
    );
  }

  // ---- window planner panel ----
  // ---- structure / floor planner panel ----
  private renderPlanPanel() {
    if (!this.planner) return;
    const p = this.b, pl = this.plan(), pn = this.planner, interior = this.mode === 'floorplan', area = this.mode === 'floorarea';
    const list = this.plans();
    const floorIdx = (x: StructurePlan) => p.floors.map((f, i) => (x.floorIds.includes(f.id) ? i : -1)).filter(i => i >= 0);
    const plansEl = h('div', { class: 'plans' }, ...list.map(x => h('div', {
      class: 'plan-row' + (x.id === pl?.id ? ' active' : ''),
      style: `border-left-color:${this.planColor(x)}`,
      onclick: () => { this.setActivePlan(x.id); pn.head = null; pn.selPoints.clear(); pn.selSegs.clear(); pn.selObj = null; this.refresh(); },
    }, x.name, h('span', { class: 'muted small' }, ` ${formatRanges(p, floorIdx(x)) || 'no floors'}${p.topPlanId === x.id ? ' + Top' : ''}`))));

    const body: (Node | null)[] = [];
    if (pl) {
      const ranges = h('input', {
        value: formatRanges(p, floorIdx(pl)), placeholder: 'e.g. 0-3, 5, 8-20',
        onchange: () => {
          const idx = parseRanges(ranges.value, p);
          if (!idx) { toast('Use floor numbers and ranges, e.g. 0-3, 5, 8-20'); return this.refresh(); }
          this.assign(pl, idx.map(i => p.floors[i].id));
        },
      });
      const topCb = h('input', { type: 'checkbox', checked: p.topPlanId === pl.id, onchange: () => this.mutate(() => (p.topPlanId = topCb.checked ? pl.id : null)) });
      const toolBtn = (t: Tool, label: string) => h('button', { class: pn.tool === t ? 'tab active' : 'tab', onclick: () => this.setTool(t) }, label);
      const help: Record<Tool, string> = {
        draw: 'Click to add points; each new point connects to the previous one. Click an existing point to connect to it (closing a loop) and continue from there. Enter, Space or Esc ends the chain: the next point starts a new, unconnected one. A point with no walls (orange ring) builds nothing; delete stray ones in Select mode.'
          + (interior ? ' Internal walls must stay inside the external walls (orange dashed).' : ' The orange dashed outline is the plan of the floor below; dotted orange lines show where its points connect up to this plan.'),
        select: 'Click points or walls to select (Shift = add). Drag points to move. Double-click a wall to insert a point. Delete removes the selection.',
        move: 'Drag anywhere to move every point and wall (and stairs / elevators) together.',
        stairs: 'Click inside the building to place a staircase. Select it to change size and rotation.',
        elevator: 'Click inside the building to place an elevator shaft.',
        carve: 'Click a shape to carve it out (no floor there); click a carved shape to give it its floor back.',
      };
      if (area) {
        help.draw = 'Click to add points; each connects to the previous one. Click a point to draw from it or to connect to it. Lines may cross: crossings become points. Clicks snap to this floor\'s walls (orange) and to your lines. Enter / Esc ends the line: the next click starts a new one anywhere. Every closed shape is floor until you carve it.';
        help.select = 'Click points or lines to select (Shift = add). Drag points (they snap to the walls). Double-click a line to add a point. Delete removes the selection.';
      }
      // points with no walls (stray clicks, or left behind when a wall is deleted) build nothing
      const wired = new Set(pl.segments.flatMap(sg => [sg.a, sg.b]));
      const lone = pl.points.filter(q => !wired.has(q.id) && q.id !== pn.head);
      if (lone.length) body.push(h('div', { class: 'warn' },
        `${lone.length} point${lone.length === 1 ? ' is' : 's are'} not connected to any wall (orange rings). They build nothing, but are kept as targets for the floor below. `,
        h('button', {
          onclick: () => this.mutate(() => {
            const ids = new Set(lone.map(q => q.id));
            pl.points = pl.points.filter(q => !ids.has(q.id));
            pn.prune();
          }),
        }, 'Delete them')));
      if (area) {
        const segs = pl.segments.filter(sg => pn.selSegs.has(sg.id)), pair = pn.pairOfSelected();
        const toolRow = h('div', { class: 'row' }, toolBtn('select', 'Select (S)'), toolBtn('draw', 'Draw (D)'), toolBtn('carve', 'Carve / restore (C)'), toolBtn('move', 'Move all (M)'),
          pn.tool === 'draw' ? h('button', { onclick: () => pn.endChain() }, 'End line (Enter)') : null);
        body.push(
          h('div', { class: 'box-title' }, 'Tool'), toolRow,
          pn.selPoints.size || segs.length ? h('div', { class: 'box' },
            h('div', { class: 'box-title' }, `Selected: ${pn.selPoints.size} point(s), ${segs.length} line(s)`),
            h('div', { class: 'row' },
              h('button', { class: 'danger', onclick: () => pn.deleteSelection() }, 'Delete (Del)'),
              pair ? h('button', { onclick: () => pn.alignSelected('right') }, 'Right angle') : null,
              pair ? h('button', { onclick: () => pn.alignSelected('straight') }, 'Same line') : null)) : null,
          h('div', { class: 'muted small help' }, help[pn.tool]),
          h('div', { class: 'row' }, h('button', { onclick: () => pn.resetView() }, 'Reset zoom'), h('span', { class: 'muted small' }, 'Wheel zooms · right-drag pans')),
          pn.tool === 'move' ? this.transformBox() : null,
          h('div', { class: 'box-title' }, 'Applies to floors'),
          ranges,
          h('div', { class: 'row' },
            h('button', { onclick: () => this.assign(pl, p.floors.map(f => f.id)) }, 'All'),
            h('button', { onclick: () => this.assign(pl, []) }, 'None'),
            h('button', { disabled: !this.selFloors.size, title: 'Floors selected in the floor bar', onclick: () => this.assign(pl, [...pl.floorIds, ...this.selFloors]) }, '+ Selected floors'),
          ),
          h('div', { class: 'row' },
            h('button', {
              disabled: !this.areaRefs().length, title: 'Add the lines of the walls (this floor and the floor below) to trace and carve',
              onclick: () => this.mutate(() => addLoops(pl, [], this.areaRefs().flatMap(r => r.segments.map(sg => sampleSeg(r, sg))))),
            }, 'Add lines from the walls'),
            h('button', { disabled: !(pl.carved ?? []).length, onclick: () => this.mutate(() => (pl.carved = [])) }, 'Restore all'),
          ),
          h('div', { class: 'muted small' }, 'Floors without a floor-area plan get their floor automatically from their walls. The Floor switch in the floor panel still turns a floor off completely.'),
        );
      }
      if (area) { /* panel built above */ } else {
      if (interior && !this.refStructure()) body.push(h('div', { class: 'warn' }, 'Assign this floor plan to floors that have external walls (a structure plan) first; internal walls can only go inside them.'));
      body.push(
        h('div', { class: 'box-title' }, 'Tool'),
        h('div', { class: 'row' }, toolBtn('select', 'Select (S)'), toolBtn('draw', 'Draw (D)'), toolBtn('move', 'Move all (M)'),
          interior ? toolBtn('stairs', 'Stairs') : null, interior ? toolBtn('elevator', 'Elevator') : null,
          pn.tool === 'draw' ? h('button', { onclick: () => pn.endChain() }, 'End chain (Enter)') : null),
        this.selectionBox(pl, interior),
        h('div', { class: 'muted small help' }, help[pn.tool]),
        pn.tool === 'move' ? this.transformBox() : null,
        h('div', { class: 'box-title' }, 'Applies to floors'),
        ranges,
        h('div', { class: 'row' },
          h('button', { onclick: () => this.assign(pl, p.floors.map(f => f.id)) }, 'All'),
          h('button', { onclick: () => this.assign(pl, []) }, 'None'),
          h('button', { disabled: !this.selFloors.size, title: 'Floors selected in the floor bar', onclick: () => this.assign(pl, [...pl.floorIds, ...this.selFloors]) }, '+ Selected floors'),
        ),
        interior ? null : h('label', { class: 'chk', title: 'The shape at the very top of the building. The top floor can connect up to it (e.g. a single point = pyramid roof). It has no walls of its own.' }, topCb, 'Top level (roof)'),
        h('details', { open: !pn.selPoints.size && !pn.selSegs.size && !pn.selObj }, h('summary', {}, 'Plan defaults'),
          this.numField(interior ? 'Internal wall thickness (m)' : 'External wall thickness (m)', pl.wallThickness, v => (pl.wallThickness = v!), p.baseLength / 2),
          this.materialField(pl.material, v => (pl.material = v!), false),
          interior ? null : this.numField('Floor thickness (m)', pl.floorThickness, v => (pl.floorThickness = v!), MAX_M),
          interior ? null : this.numField('Roof thickness, top floor (m)', pl.ceilingThickness, v => (pl.ceilingThickness = v!), MAX_M),
          interior ? null : h('div', { class: 'muted small' }, 'Each floor has its own floor and ceiling; switch them on or off per floor in the floor panel.'),
          this.slider('Smoothness', pl.smooth, v => (pl.smooth = v)),
          interior ? null : this.connectField(pl.connect, v => (pl.connect = v!), false),
          interior ? null : this.slider('Connection smoothness', pl.connectSmooth, v => (pl.connectSmooth = v)),
          interior ? null : this.spanField(pl.smoothSpan, v => (pl.smoothSpan = v ?? true), false),
          interior ? null : this.textureField('Texture for all walls', null, id => pl.segments.forEach(s => (s.texture = id))),
        ),
      );
      }
    }

    this.right.innerHTML = '';
    put(this.right, 
      h('div', { class: 'box-title' }, area ? 'Floor-area plans (where floors have floor)' : interior ? 'Floor plans (internal walls)' : 'Structure plans (external walls)'),
      plansEl,
      h('div', { class: 'row' },
        h('button', {
          onclick: () => this.mutate(() => {
            const np = area ? newAreaPlan(`Floor area ${list.length + 1}`) : interior ? newInteriorPlan(`Floor plan ${list.length + 1}`) : newPlan(`Plan ${list.length + 1}`);
            list.push(np); this.setActivePlan(np.id);
          }),
        }, 'New'),
        h('button', {
          disabled: !pl, title: 'Copy this plan (walls and settings), assigned to no floors',
          onclick: () => pl && this.mutate(() => {
            const c: StructurePlan = JSON.parse(JSON.stringify(pl));
            c.id = uid(); c.name = `${pl.name} copy`; c.floorIds = [];
            list.push(c); this.setActivePlan(c.id);
          }),
        }, 'Duplicate'),
        h('button', { disabled: !pl, onclick: async () => { const n = pl && await askText('Rename plan', pl.name); if (pl && n?.trim()) this.mutate(() => (pl.name = n.trim())); } }, 'Rename'),
        h('button', {
          class: 'danger', disabled: !pl,
          onclick: async () => {
            if (pl && await askConfirm(`Delete ${pl.name}?`)) this.mutate(() => {
              list.splice(list.indexOf(pl), 1);
              if (p.topPlanId === pl.id) p.topPlanId = null;
              this.setActivePlan(list[0]?.id ?? null);
            });
          },
        }, 'Delete'),
      ),
      ...body.filter(Boolean) as Node[],
    );
  }

  /** Move by an exact distance or scale everything about the centre of the drawing. */
  private transformBox() {
    const pl = this.plan(), pn = this.planner!, L = this.b.baseLength;
    if (!pl) return null;
    const dx = h('input', { type: 'number', step: 0.1, value: 0 }), dy = h('input', { type: 'number', step: 0.1, value: 0 });
    const sc = h('input', { type: 'number', step: 1, value: 100 });
    const pts = [...pl.points, ...pl.objects];
    const cx = pts.length ? (Math.min(...pts.map(q => q.x)) + Math.max(...pts.map(q => q.x))) / 2 : 0.5;
    const cy = pts.length ? (Math.min(...pts.map(q => q.y)) + Math.max(...pts.map(q => q.y))) / 2 : 0.5;
    return h('div', { class: 'box' },
      h('div', { class: 'box-title' }, 'Move / resize everything'),
      h('div', { class: 'row' }, h('label', {}, 'Move x (m)', dx), h('label', {}, 'Move y (m)', dy)),
      h('button', {
        onclick: () => {
          const ox = num(dx.value) / L, oy = num(dy.value) / L;
          if (!isFinite(ox) || !isFinite(oy)) return;
          if (!pn.transformAll(q => ({ x: q.x + ox, y: q.y + oy }))) toast('That would move something outside the allowed area');
        },
      }, 'Move'),
      h('label', {}, 'Resize (%) around the centre of the drawing', sc),
      h('button', {
        onclick: () => {
          const k = num(sc.value) / 100;
          if (!(k > 0)) return toast('Use a percentage above 0');
          if (!pn.transformAll(q => ({ x: cx + (q.x - cx) * k, y: cy + (q.y - cy) * k }), () => pl.objects.forEach(o => { o.w *= k; o.d *= k; }))) {
            toast('That would put something outside the allowed area');
          }
        },
      }, 'Resize'),
    );
  }

  assign(pl: StructurePlan, ids: string[]) {
    const list = this.plans();
    this.mutate(() => {
      const set = new Set(ids);
      list.forEach(o => (o.floorIds = o.floorIds.filter(id => !set.has(id))));
      pl.floorIds = this.b.floors.map(f => f.id).filter(id => set.has(id));
    });
  }

  // ---- small field builders ----
  numField(label: string, val: number | null, set: (v: number | null) => void, max = 100, allowEmpty = false) {
    const inp = h('input', {
      type: 'number', step: 0.05, value: val === null ? '' : fmt(val), placeholder: allowEmpty ? 'default' : '',
      onchange: () => {
        if (allowEmpty && inp.value.trim() === '') return this.mutate(() => set(null));
        const v = num(inp.value);
        if (!(v > 0) || v > max) { toast(`${label} must be between 0 and ${fmt(max)}`); return this.refresh(); }
        this.mutate(() => set(v));
      },
    });
    return h('label', {}, label, inp);
  }
  checkField(label: string, val: boolean, set: (v: boolean) => void) {
    const cb = h('input', { type: 'checkbox', checked: val, onchange: () => this.mutate(() => set(cb.checked)) });
    return h('label', { class: 'chk' }, cb, label);
  }
  slider(label: string, val: number | null, set: (v: number) => void, reset?: () => void) {
    const out = h('span', {}, val === null ? 'default' : `${Math.round(val * 100)}%`);
    const r = h('input', {
      type: 'range', min: 0, max: 100, value: Math.round((val ?? 0) * 100),
      oninput: () => (out.textContent = `${r.value}%`),
      onchange: () => this.mutate(() => set(+r.value / 100)),
    });
    return h('label', {}, h('span', { class: 'lbl-row' }, label, out,
      reset && val !== null ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.mutate(reset); } }, 'reset') : null), r);
  }
  connectField(val: ConnectMode | null | 'mixed', set: (v: ConnectMode | null) => void, allowDefault: boolean) {
    const s = h('select', { onchange: () => this.mutate(() => set(s.value === '' ? null : (s.value as ConnectMode))) },
      val === 'mixed' ? h('option', { value: 'mixed', disabled: true }, 'mixed') : null,
      allowDefault ? h('option', { value: '' }, 'Plan default') : null,
      h('option', { value: 'straight' }, 'Straight up'),
      h('option', { value: 'loft' }, 'Connect to plan above'),
    );
    s.value = val ?? '';
    return h('label', {}, 'Connection to floor above', s);
  }
  /** Connection smoothness: within each pair of floors, or flowing across all connected floors. */
  spanField(val: boolean | null | 'mixed', set: (v: boolean | null) => void, allowDefault: boolean) {
    const sel = h('select', { onchange: () => this.mutate(() => set(sel.value === '' ? null : sel.value === 'span')) },
      val === 'mixed' ? h('option', { value: 'mixed', disabled: true }, 'mixed') : null,
      allowDefault ? h('option', { value: '' }, 'Plan default') : null,
      h('option', { value: 'span' }, 'Across all connected floors (domes)'),
      h('option', { value: 'pair' }, 'Between these 2 floors only'),
    );
    sel.value = val === 'mixed' ? 'mixed' : val === null ? '' : val ? 'span' : 'pair';
    return h('label', { title: 'Across: the curve flows through the outlines of the floors below and above (one smooth surface over many floors). Between 2: each floor curves on its own.' }, 'Smoothness applies', sel);
  }

  materialField(val: string | null | 'mixed', set: (v: string | null) => void, allowDefault: boolean) {
    const s = h('select', { onchange: () => this.mutate(() => set(s.value === '' ? null : s.value)) },
      val === 'mixed' ? h('option', { value: 'mixed', disabled: true }, 'mixed') : null,
      allowDefault ? h('option', { value: '' }, 'Plan default') : null,
      ...Object.entries(MATERIALS).map(([k, m]) => h('option', { value: k }, `${m.name} (${m.density} kg/m³)`)),
    );
    s.value = val ?? '';
    return h('label', {}, 'Material', s);
  }
  textureField(label: string, current: string | null | 'mixed', set: (id: string | null) => void) {
    const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const tex = await loadTexture(f);
        this.mutate(() => { this.p.textures.push(tex); set(tex.id); });
        toast('Texture applied — visible in Detailed view');
      } catch { toast('Could not read that image'); }
    });
    const name = current === 'mixed' ? 'mixed' : this.p.textures.find(t => t.id === current)?.name;
    const existing = this.p.textures.length ? h('select', {
      onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) this.mutate(() => set(v)); },
    }, h('option', { value: '' }, 'Use existing…'), ...this.p.textures.map(t => h('option', { value: t.id }, t.name))) : null;
    return h('div', { class: 'tex-field' },
      h('div', { class: 'muted' }, label, name ? `: ${name}` : ''),
      h('div', { class: 'row' },
        h('button', { onclick: () => file.click() }, 'Import image'),
        existing,
        current ? h('button', { onclick: () => this.mutate(() => set(null)) }, 'Clear') : null,
      ),
      file,
    );
  }

  selectionBox(pl: StructurePlan, interior: boolean): HTMLElement | null {
    const pn = this.planner!, L = this.b.baseLength;
    const nP = pn.selPoints.size, nS = pn.selSegs.size;
    const ob = pl.objects.find(o => o.id === pn.selObj);
    if (ob) return this.objectBox(ob);
    if (!nP && !nS) return null;
    const box = h('div', { class: 'box' }, h('div', { class: 'box-title' }, `Selected: ${nP} point(s), ${nS} wall(s)`));
    if (nP === 1 && !nS) {
      const pt = pl.points.find(x => x.id === [...pn.selPoints][0])!;
      const coord = (axis: 'x' | 'y') => {
        const inp = h('input', {
          type: 'number', step: 0.01, min: 0, max: 1, value: pt[axis].toFixed(3),
          onchange: () => {
            const v = num(inp.value);
            if (!(v >= 0 && v <= 1)) { toast('Coordinates are between 0 and 1'); return this.refresh(); }
            const np = { x: pt.x, y: pt.y, [axis]: v };
            if (!validMove(pl, pt.id, np)) { toast('That would make walls cross'); return this.refresh(); }
            this.mutate(() => (pt[axis] = v));
          },
        });
        return h('label', {}, axis, inp);
      };
      box.append(h('div', { class: 'muted small' }, `Point #${pt.n} · ${fmt(pt.x * L)} m, ${fmt(pt.y * L)} m`), h('div', { class: 'row' }, coord('x'), coord('y')));
    }
    const segs = pl.segments.filter(s => pn.selSegs.has(s.id));
    if (segs.length) box.append(this.segmentProps(pl, segs, interior));
    if (pn.pairOfSelected()) box.append(h('div', { class: 'row' },
      h('button', { title: 'Move their shared point so the two walls meet at 90°', onclick: () => pn.alignSelected('right') }, 'Right angle'),
      h('button', { title: 'Move their shared point onto the line between the other two ends', onclick: () => pn.alignSelected('straight') }, 'One straight line')));
    box.append(h('button', { class: 'danger', onclick: () => pn.deleteSelection() }, nP ? 'Delete selected' : 'Delete wall(s)'));
    return box;
  }

  private objectBox(ob: PlanObject) {
    const f = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) => {
      const inp = h('input', {
        type: 'number', step: 0.1, value: fmt(get()),
        onchange: () => { const v = num(inp.value); if (!(v >= min && v <= max)) { toast(`${label}: ${min} to ${max}`); return this.refresh(); } this.mutate(() => set(v)); },
      });
      return h('label', {}, label, inp);
    };
    return h('div', { class: 'box' },
      h('div', { class: 'box-title' }, ob.type === 'stairs' ? 'Staircase' : 'Elevator'),
      h('div', { class: 'row' }, f('Width (m)', () => ob.w, v => (ob.w = v), 0.3, 50), f('Length (m)', () => ob.d, v => (ob.d = v), 0.3, 50)),
      f('Rotation (°)', () => ob.rot, v => (ob.rot = v), -360, 360),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.mutate(() => (ob.rot = (ob.rot + 90) % 360)) }, 'Rotate 90°'),
        h('button', { class: 'danger', onclick: () => this.planner!.deleteSelection() }, 'Delete'),
      ),
    );
  }

  /** Properties of one or more selected walls. */
  /** Wall shape (side profile) of walls; made in Shape → Walls. */
  wallShapeField(segs: PlanSegment[]): HTMLElement {
    const vals = new Set(segs.map(sg => sg.wallShape ?? ''));
    const sel = h('select', { onchange: () => { if (sel.value === '__new') { this.designKind = 'walls'; this.setMode('walls'); return; } this.mutate(() => segs.forEach(sg => (sg.wallShape = sel.value || null))); } },
      vals.size > 1 ? h('option', { value: '__m', disabled: true }, 'mixed') : null,
      h('option', { value: '' }, 'Flat'), ...this.b.wallShapes.map(x => h('option', { value: x.id }, x.name)),
      h('option', { value: '__new' }, 'Draw one…'));
    sel.value = vals.size > 1 ? '__m' : [...vals][0];
    return h('label', { title: 'Side profile of the wall: plinths, string courses, sloping walls (Shape → Walls)' }, 'Wall shape', sel);
  }

  segmentProps(pl: StructurePlan, segs: PlanSegment[], interior: boolean): HTMLElement {
    const L = this.b.baseLength, pn = this.planner!;
    const common = <T>(get: (s: PlanSegment) => T): T | 'mixed' => {
      const v = get(segs[0]);
      return segs.every(s => get(s) === v) ? v : 'mixed';
    };
    const wrap = h('div', {});
    if (segs.length === 1) {
      const s = segs[0];
      const A = pl.points.find(x => x.id === s.a)!, B = pl.points.find(x => x.id === s.b)!;
      const len = Math.hypot(B.x - A.x, B.y - A.y) * L;
      const inp = h('input', {
        type: 'number', step: 0.1, value: fmt(len),
        onchange: () => {
          const v = num(inp.value);
          if (!(v > 0)) { toast('Length must be > 0'); return this.refresh(); }
          const k = v / len;
          const nb = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k };
          if (nb.x < -1e-9 || nb.x > 1 + 1e-9 || nb.y < -1e-9 || nb.y > 1 + 1e-9) { toast('That length would leave the building area'); return this.refresh(); }
          if (!validMove(pl, B.id, nb)) { toast('That length would make walls cross'); return this.refresh(); }
          this.mutate(() => { B.x = clamp(nb.x, 0, 1); B.y = clamp(nb.y, 0, 1); });
        },
      });
      wrap.append(
        h('label', {}, `Length point to point (m) · #${A.n} → #${B.n}`, inp),
        h('button', { onclick: () => pn.insertPoint(pl, s.id) }, 'Insert point in middle'),
      );
    }
    const setAll = (fn: (s: PlanSegment) => void) => this.mutate(() => segs.forEach(fn));
    const kind = common(segKind);
    const kindBtn = (k: SegKind, label: string) => h('button', { class: kind === k ? 'tab active' : 'tab', onclick: () => setAll(s => (s.kind = k)) }, label);
    wrap.append(h('div', { class: 'box-title' }, 'Type'), h('div', { class: 'row' },
      kindBtn('wall', 'Wall'), interior ? kindBtn('door', 'Door') : null, kindBtn('colonnade', 'Colonnade'), kindBtn('balustrade', 'Balusters'), kindBtn('open', 'Open')));
    if (kind === 'wall' || kind === 'colonnade') {
      const dl = common(s => s.divLen ?? null);
      const dIn = h('input', {
        type: 'number', min: 0.3, step: 0.1, value: dl === 'mixed' || dl === null ? '' : fmt(dl), placeholder: dl === 'mixed' ? 'mixed' : `default ${fmt(this.b.divLen)}`,
        onchange: () => {
          if (dIn.value.trim() === '') return setAll(s => (s.divLen = null));
          const v = num(dIn.value);
          if (!(v >= 0.3 && v <= 1000)) { toast('Division length: 0.3 to 1000 m'); return this.refresh(); }
          setAll(s => (s.divLen = v));
        },
      });
      wrap.append(h('label', {}, kind === 'colonnade' ? 'Column spacing (m, empty = default division)' : 'Division length (m, empty = default)', dIn));
    }
    const designPick = (cat: DesignCategory, key: 'columnDesign' | 'balusterDesign' | 'wallDesign', label: string) => {
      const vals = new Set(segs.map(x => x[key] ?? ''));
      const dt = key === 'columnDesign' ? 'column' : key === 'balusterDesign' ? 'baluster' : 'wall';
      const sel = h('select', { onchange: () => setAll(x => (x[key] = sel.value || null)) },
        vals.size > 1 ? h('option', { value: '__m', disabled: true }, 'mixed') : null,
        h('option', { value: '' }, 'Plain'), ...this.p.decos.filter(d => d.type === dt).map(d => h('option', { value: d.id }, d.name)),
        ...this.p.designs.filter(d => d.category === cat).map(d => h('option', { value: d.id }, `${d.name} (imported model)`)));
      sel.value = vals.size > 1 ? '__m' : [...vals][0];
      return h('label', {}, label, sel);
    };
    if (kind === 'colonnade') {
      const ct = common(s => s.columnThickness ?? null);
      wrap.append(this.numField('Column thickness (m), empty = wall thickness', ct === 'mixed' ? null : ct, v => segs.forEach(s => (s.columnThickness = v)), L / 2, true));
      wrap.append(designPick('column', 'columnDesign', 'Column design (detailed view)'));
    }
    if (kind === 'wall') wrap.append(designPick('model', 'wallDesign', 'Wall design on every division (detailed view)'));
    if (kind === 'balustrade' || kind === 'wall') wrap.append(designPick('baluster', 'balusterDesign', kind === 'wall' ? 'Baluster design for balconies on this wall' : 'Baluster design (detailed view)'));
    const colIn = h('input', { type: 'color', value: segs.find(x => x.color)?.color ?? '#d8cfc0' });
    wrap.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Colour'), colIn,
      h('button', { onclick: () => setAll(x => (x.color = colIn.value)) }, 'Apply'),
      h('button', { onclick: () => setAll(x => (x.color = null)) }, 'Clear')));
    wrap.append(this.materialField(common(s => s.material ?? null), v => segs.forEach(s => (s.material = v)), true));
    if (segs.some(sg => segKind(sg) === 'wall' || segKind(sg) === 'door')) wrap.append(this.wallShapeField(segs));
    const sm = common(s => s.smooth ?? null);
    wrap.append(this.slider(`Smoothness${sm === null ? ' (plan default)' : ''}`, sm === 'mixed' ? null : sm, v => segs.forEach(s => (s.smooth = v)), () => segs.forEach(s => (s.smooth = null))));
    if (!interior) {
      const cs = common(s => s.connectSmooth ?? null);
      wrap.append(
        this.connectField(common(s => s.connect ?? null), v => segs.forEach(s => (s.connect = v)), true),
        this.slider(`Connection smoothness${cs === null ? ' (plan default)' : ''}`, cs === 'mixed' ? null : cs, v => segs.forEach(s => (s.connectSmooth = v)), () => segs.forEach(s => (s.connectSmooth = null))),
        this.spanField(common(s => s.smoothSpan ?? null), v => segs.forEach(s => (s.smoothSpan = v)), true),
        this.textureField('Texture', common(s => s.texture ?? null), id => segs.forEach(s => (s.texture = id))),
      );
    }
    return wrap;
  }
}

const validMove = (pl: StructurePlan, id: string, np: { x: number; y: number }) => planValid(pl, new Map([[id, np]]));

/** Read an image file, downscale to max 512 px (keeps storage small) and return a texture record. */
function loadTexture(f: File): Promise<{ id: string; name: string; data: string; w: number; h: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 512 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res({ id: uid(), name: f.name.replace(/\.[^.]+$/, ''), data: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height });
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(f);
  });
}
