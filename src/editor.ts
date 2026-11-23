// Building project editor: floors panel, 3D view, structure / floor / window planners.
import {
  Building, ConnectMode, Floor, History, segConnect, MATERIALS, MAX_M, PlanObject, PlanSegment, Project, SegKind, StructurePlan, WindowShape,
  clamp, elevation, floorBase, floorLabel, formatRanges, newInteriorPlan, newPlan, parseRanges, planForFloor, saveProject,
  segKind, totalHeight, uid, windowKey,
} from './model';
import { Hit, Viewer, ViewMode } from './viewer';
import { Planner, Tool, fmt } from './planner';
import { WindowPlanner } from './windowplanner';
import { V2, enclosedFaces, planValid } from './geometry';
import { Selection, interiorForFloor, loftPointTarget } from './build3d';
import { calculate, Report } from './stats';
import { app, askConfirm, askText, h, num, put, toast } from './ui';

type Mode = 'view' | 'structure' | 'floorplan' | 'window';
type PickMode = 'division' | 'wall' | 'floor';
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
  activePlan: Record<'structure' | 'floorplan', string | null> = { structure: null, floorplan: null };
  activeShape: string | null = null;
  carveShape: string | null = null;
  report: Report | null = null;
  root = h('div', { class: 'editor' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  right = h('div', { class: 'right panel' });
  header = h('div', { class: 'header' });
  viewer: Viewer | null = null;
  planner: Planner | null = null;
  wplanner: WindowPlanner | null = null;

  constructor(p: Project, private onBack: () => void) {
    this.p = p;
    this.activePlan.structure = this.b.plans[0]?.id ?? null;
    this.activePlan.floorplan = this.b.interiorPlans[0]?.id ?? null;
    this.activeShape = this.b.windowShapes[0]?.id ?? null;
    this.carveShape = this.activeShape;
    this.root.append(this.header, this.left, this.center, this.right);
    app.innerHTML = '';
    app.append(this.root);
    window.addEventListener('keydown', this.onKey);
    this.setMode('view');
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    this.viewer?.dispose(); this.planner?.dispose(); this.wplanner?.dispose();
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
    if (!this.b.windowShapes.some(s => s.id === this.activeShape)) this.activeShape = this.b.windowShapes[0]?.id ?? null;
    saveProject(this.p);
    this.report = null;
    this.planner?.prune();
    this.refresh();
  }

  get selection(): Selection { return { floors: this.selFloors, walls: this.selWalls, divisions: this.selDivs }; }

  refresh() {
    this.renderHeader();
    this.renderLeft();
    this.renderRight();
    if (this.mode === 'view') this.viewer?.update({ id: this.p.id, buildings: this.p.buildings, textures: this.p.textures }, { activeId: '*', mode: this.viewMode, selection: this.selection, showArea: this.showArea });
    this.planner?.draw();
    this.wplanner?.draw();
  }

  setMode(m: Mode) {
    this.mode = m;
    this.viewer?.dispose(); this.viewer = null;
    this.planner?.dispose(); this.planner = null;
    this.wplanner?.dispose(); this.wplanner = null;
    this.center.innerHTML = '';
    this.root.classList.add('with-right');
    if (m === 'view') {
      this.viewer = new Viewer(this.center);
      this.viewer.onTexture = () => this.refresh();
      this.viewer.onPick = (hit, e) => this.onPick(hit, e);
    } else if (m === 'window') {
      this.wplanner = new WindowPlanner(this.center, {
        getShape: () => this.shape(),
        begin: () => this.begin(),
        commit: () => this.commit(),
        toast,
        floorHeight: () => this.b.floors[this.b.ground]?.height ?? 3,
        selectionChanged: () => this.renderRight(),
      });
    } else {
      this.planner = new Planner(this.center, {
        getPlan: () => this.plan(),
        getGhost: () => this.ghostPlan(),
        links: () => this.ghostLinks(),
        allowed: () => (this.mode === 'floorplan' ? this.allowedArea() : null),
        baseLength: () => this.b.baseLength,
        begin: () => this.begin(),
        commit: () => this.commit(),
        toast,
        selectionChanged: () => this.renderRight(),
      });
    }
    this.refresh();
  }

  plans(): StructurePlan[] { return this.mode === 'floorplan' ? this.b.interiorPlans : this.b.plans; }
  plan(): StructurePlan | null {
    const key = this.mode === 'floorplan' ? 'floorplan' : 'structure';
    return this.plans().find(pl => pl.id === this.activePlan[key]) ?? null;
  }
  setActivePlan(id: string | null) { this.activePlan[this.mode === 'floorplan' ? 'floorplan' : 'structure'] = id; }
  shape(): WindowShape | null { return this.b.windowShapes.find(s => s.id === this.activeShape) ?? null; }

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
    const idx = this.b.floors.findIndex(f => pl.floorIds.includes(f.id));
    if (idx > 0) return planForFloor(this.b, this.b.floors[idx - 1].id) ?? null;
    if (idx < 0 && this.b.topPlanId === pl.id) return planForFloor(this.b, this.b.floors[this.b.floors.length - 1].id) ?? null;
    return null;
  }

  planColor(pl: StructurePlan | null | undefined) {
    if (!pl) return 'transparent';
    const list = this.b.plans.includes(pl) ? this.b.plans : this.b.interiorPlans;
    return PLAN_COLORS[list.indexOf(pl) % PLAN_COLORS.length];
  }

  private onKey = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    const typing = tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undo(); return; }
    if (typing) return;
    const finishKey = e.key === 'Enter' || e.key === ' ';
    if (this.wplanner && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); this.wplanner.deleteSelected(); return; }
    if (this.wplanner && (finishKey || e.key === 'Escape')) { e.preventDefault(); this.wplanner.finish(); return; }
    if (this.mode === 'view' && e.key === 'Escape') { this.clearSel(); return; }
    if (!this.planner) return;
    if (e.key === 'Escape' || finishKey) { e.preventDefault(); this.planner.endChain(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.planner.deleteSelection(); }
    if (e.key === 'd') this.setTool('draw');
    if (e.key === 's') this.setTool('select');
    if (e.key === 'm') this.setTool('move');
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
    const tab = (m: Mode, label: string) => h('button', { class: this.mode === m ? 'tab active' : 'tab', onclick: () => this.setMode(m) }, label);
    const vm = h('select', { onchange: () => { this.viewMode = vm.value as ViewMode; this.refresh(); } },
      h('option', { value: 'plan' }, 'Floor plan view'),
      h('option', { value: 'structural' }, 'Structural view'),
      h('option', { value: 'detailed' }, 'Detailed view'),
    );
    vm.value = this.viewMode;
    const area = h('input', { type: 'checkbox', checked: this.showArea, onchange: () => { this.showArea = area.checked; setPref('showArea', area.checked ? '1' : '0'); this.refresh(); } });
    this.header.innerHTML = '';
    put(this.header, 
      h('button', { onclick: () => this.onBack() }, '← Projects'),
      nameIn,
      h('div', { class: 'tabs' }, tab('view', '3D view'), tab('structure', 'Structure planner'), tab('floorplan', 'Floor planner'), tab('window', 'Window planner')),
      this.mode === 'view' ? vm : null,
      this.mode === 'view' ? h('label', { class: 'chk', title: 'Show the building-area outline and floor lines' }, area, 'Area lines') : null,
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => toast('Importing 3D models is planned — not implemented yet') }, 'Import 3D model'),
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
    if ((this.mode === 'structure' || this.mode === 'floorplan') && this.selFloors.has(id)) {
      const pl = this.mode === 'structure' ? planForFloor(this.b, id) : interiorForFloor(this.b, id);
      if (pl && pl.id !== this.plan()?.id) {
        this.setActivePlan(pl.id);
        if (this.planner) { this.planner.head = null; this.planner.selPoints.clear(); this.planner.selSegs.clear(); this.planner.selObj = null; }
      } else if (!pl) toast(`Floor ${floorLabel(this.b, this.b.floors.findIndex(f => f.id === id))} has no ${this.mode === 'structure' ? 'structure' : 'floor'} plan yet: pick one in the floor panel or press Edit`);
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
      h('div', { class: 'row' }, this.floorToggle(sel, 'hasFloor', 'Floor'), this.floorToggle(sel, 'hasCeiling', 'Ceiling')),
      one ? h('div', { class: 'muted small' }, `Starts at ${fmt(elevation(p, idx[0]))} m`) : null,
      h('div', { class: 'row' },
        h('button', { onclick: () => this.editFloorIn('structure', sel[0].id) }, 'Edit structure'),
        h('button', { onclick: () => this.editFloorIn('floorplan', sel[0].id) }, 'Edit floor plan'),
      ),
      h('div', { class: 'row' },
        one ? h('button', { onclick: () => this.splitFloor(one.id, 0.5) }, 'Split') : null,
        one && idx[0] !== p.ground ? h('button', { title: 'Floors below this one become underground', onclick: () => this.mutate(() => (p.ground = idx[0])) }, 'Make ground floor') : null,
        h('button', {
          class: 'danger', disabled: sel.length >= p.floors.length,
          onclick: () => this.mutate(() => {
            const ids = sel.map(f => f.id);
            const groundId = p.floors[p.ground].id;
            const removedBelow = idx.filter(i => i < p.ground).length;
            p.floors = p.floors.filter(f => !ids.includes(f.id));
            [...p.plans, ...p.interiorPlans].forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.includes(id))));
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

  splitFloor(id: string, ratio: number) {
    const i = this.b.floors.findIndex(f => f.id === id);
    const f = this.b.floors[i];
    this.mutate(() => {
      const lower = Math.round(f.height * ratio * 100) / 100;
      const nf = { id: uid(), height: Math.round((f.height - lower) * 100) / 100 };
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
  editFloorIn(mode: 'structure' | 'floorplan', floorId: string, segId?: string) {
    const b = this.b;
    let pl = mode === 'structure' ? planForFloor(b, floorId) : interiorForFloor(b, floorId);
    if (!pl) {
      this.begin();
      pl = mode === 'structure' ? newPlan(`Plan ${b.plans.length + 1}`, [floorId]) : newInteriorPlan(`Floor plan ${b.interiorPlans.length + 1}`);
      if (mode === 'floorplan') pl.floorIds = [floorId];
      (mode === 'structure' ? b.plans : b.interiorPlans).push(pl);
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
    if (this.mode === 'view') return this.renderViewPanel();
    if (this.mode === 'window') return this.renderWindowPanel();
    this.renderPlanPanel();
  }

  // ---- 3D view: selection, actions, calculation ----
  private onPick(hit: Hit | null, e: MouseEvent) {
    if (!hit) { if (!e.shiftKey) this.clearSel(); return; }
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const toggle = (set: Set<string>, key: string) => {
      if (!add) { this.selFloors.clear(); this.selWalls.clear(); this.selDivs.clear(); set.add(key); return; }
      set.has(key) ? set.delete(key) : set.add(key);
    };
    if (this.pickMode === 'floor' || !hit.segId || hit.interior) toggle(this.selFloors, hit.floorId);
    else if (this.pickMode === 'wall' || !hit.uvOf) toggle(this.selWalls, `${hit.floorId}|${hit.segId}`);
    else {
      const d = hit.divisions ?? 1;
      const k = Math.min(d - 1, Math.floor(hit.uvOf(hit.point).u * d));
      toggle(this.selDivs, `${hit.floorId}|${hit.segId}|${k}`);
    }
    this.refresh();
  }
  clearSel() { this.selFloors.clear(); this.selWalls.clear(); this.selDivs.clear(); this.refresh(); }

  /** Window slots (floorId|segId|k) covered by the 3D selection. */
  private selectedSlots(): string[] {
    const b = this.b, out: string[] = [];
    const segSlots = (floorId: string, seg: PlanSegment) => {
      if (segKind(seg) !== 'wall') return;
      for (let k = 0; k < Math.max(1, seg.divisions ?? 1); k++) out.push(windowKey(floorId, seg.id, k));
    };
    for (const fid of this.selFloors) planForFloor(b, fid)?.segments.forEach(s => segSlots(fid, s));
    for (const key of this.selWalls) {
      const [fid, sid] = key.split('|');
      const seg = planForFloor(b, fid)?.segments.find(s => s.id === sid);
      if (seg) segSlots(fid, seg);
    }
    out.push(...this.selDivs);
    return [...new Set(out)];
  }

  private renderViewPanel() {
    const b = this.b;
    const nSel = this.selFloors.size + this.selWalls.size + this.selDivs.size;
    const pm = (m: PickMode, label: string) => h('button', { class: this.pickMode === m ? 'tab active' : 'tab', onclick: () => { this.pickMode = m; this.refresh(); } }, label);
    const first = [...this.selWalls, ...this.selDivs][0]?.split('|') ?? (this.selFloors.size ? [[...this.selFloors][0]] : null);
    const shapeSel = h('select', { onchange: () => (this.carveShape = shapeSel.value) },
      ...b.windowShapes.map(s => h('option', { value: s.id }, s.name)));
    if (!b.windowShapes.some(s => s.id === this.carveShape)) this.carveShape = b.windowShapes[0]?.id ?? null;
    if (this.carveShape) shapeSel.value = this.carveShape;
    const slots = nSel ? this.selectedSlots() : [];

    this.right.innerHTML = '';
    put(this.right, 
      h('div', { class: 'box-title' }, 'Select in 3D'),
      h('div', { class: 'row' }, pm('division', 'Division'), pm('wall', 'Wall'), pm('floor', 'Floor')),
      h('div', { class: 'muted small' }, 'Click a wall in the 3D view (Shift = add). Selection is yellow. Esc clears. Floors can also be picked in the floor bar.'),
      nSel ? h('div', { class: 'box' },
        h('div', { class: 'box-title' }, `Selected: ${[this.selFloors.size && `${this.selFloors.size} floor(s)`, this.selWalls.size && `${this.selWalls.size} wall(s)`, this.selDivs.size && `${this.selDivs.size} division(s)`].filter(Boolean).join(', ')}`),
        first ? h('div', { class: 'row' },
          h('button', { onclick: () => this.editFloorIn('structure', first[0], first[1]) }, 'Edit in structure planner'),
          h('button', { onclick: () => this.editFloorIn('floorplan', first[0]) }, 'Edit floor plan'),
        ) : null,
        h('div', { class: 'box-title' }, 'Windows'),
        b.windowShapes.length ? h('label', {}, 'Window shape', shapeSel) : h('div', { class: 'muted small' }, 'Draw a window shape in the Window planner first.'),
        h('div', { class: 'row' },
          h('button', {
            class: 'primary', disabled: !this.carveShape || !slots.length,
            onclick: () => this.mutate(() => slots.forEach(k => (b.windows[k] = this.carveShape!))),
          }, `Carve windows (${slots.length})`),
          h('button', { disabled: !slots.length, onclick: () => this.mutate(() => slots.forEach(k => delete b.windows[k])) }, 'Remove windows'),
        ),
        h('div', { class: 'muted small' }, 'One window per wall division. Give a wall more divisions (structure planner) for more windows.'),
        h('button', { onclick: () => this.clearSel() }, 'Clear selection'),
      ) : null,
      this.reportBox(),
    );
  }

  private reportBox() {
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
  private renderWindowPanel() {
    const b = this.b, sh = this.shape(), wp = this.wplanner;
    const used = (id: string) => Object.values(b.windows).filter(x => x === id).length;
    const pt = wp?.selectedPoint() ?? null;
    this.right.innerHTML = '';
    put(this.right,
      h('div', { class: 'box-title' }, 'Window shapes'),
      h('div', { class: 'plans' }, ...b.windowShapes.map(s => h('div', {
        class: 'plan-row' + (s.id === this.activeShape ? ' active' : ''),
        onclick: () => { this.activeShape = s.id; wp?.reset(); this.refresh(); },
      }, s.name, h('span', { class: 'muted small' }, ` ${s.outlines.length} opening${s.outlines.length === 1 ? '' : 's'} · used ${used(s.id)}×`)))),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.mutate(() => { const s: WindowShape = { id: uid(), name: `Window ${b.windowShapes.length + 1}`, outlines: [], smooth: 0 }; b.windowShapes.push(s); this.activeShape = s.id; wp?.reset(); }) }, 'New'),
        h('button', { disabled: !sh, onclick: () => sh && this.mutate(() => { const c = { ...JSON.parse(JSON.stringify(sh)), id: uid(), name: `${sh.name} copy` }; b.windowShapes.push(c); this.activeShape = c.id; wp?.reset(); }) }, 'Duplicate'),
        h('button', { disabled: !sh, onclick: async () => { const n = sh && await askText('Rename window shape', sh.name); if (sh && n?.trim()) this.mutate(() => (sh.name = n.trim())); } }, 'Rename'),
        h('button', {
          class: 'danger', disabled: !sh,
          onclick: async () => {
            if (sh && await askConfirm(`Delete ${sh.name}? Windows using it are removed.`)) this.mutate(() => {
              b.windowShapes = b.windowShapes.filter(x => x !== sh);
              for (const [k, v] of Object.entries(b.windows)) if (v === sh.id) delete b.windows[k];
              this.activeShape = b.windowShapes[0]?.id ?? null;
              wp?.reset();
            });
          },
        }, 'Delete'),
      ),
      sh ? this.slider('Smoothness (whole shape)', sh.smooth, v => (sh.smooth = v)) : null,
      pt ? h('div', { class: 'box' },
        h('div', { class: 'box-title' }, 'Selected point'),
        this.slider(`Smoothness at this point${pt.s == null ? ' (shape default)' : ''}`, pt.s ?? null, v => (pt.s = v), () => (pt.s = null)),
        h('div', { class: 'row' },
          h('button', { onclick: () => wp?.deleteSelected() }, 'Delete point'),
          h('button', { onclick: () => wp?.deleteOutline() }, 'Delete this opening'),
        ),
      ) : null,
      sh ? h('div', { class: 'row' },
        h('button', { disabled: wp?.cur == null, onclick: () => wp?.finish() }, 'Finish outline (Enter)'),
        h('button', { class: 'danger', disabled: !sh.outlines.length, onclick: () => wp?.clear() }, 'Clear all'),
      ) : null,
      h('div', { class: 'muted small help' },
        'Click to add points; the outline closes back to its first point. Press Enter or Space to finish it: the next click starts another opening in the same shape. ',
        'Drag points to move them, double-click an edge to add a point. Points snap to a 0.05 grid (hold Alt for free placement). ',
        'Smoothness rounds the corners; set it on single points for shapes like arches (a ring marks points with their own value). ',
        'x runs across one wall division, y up the floor: points at y = 0 make a door. Then select walls, divisions or floors in the 3D view and press Carve windows.'),
    );
  }


  // ---- structure / floor planner panel ----
  private renderPlanPanel() {
    if (!this.planner) return;
    const p = this.b, pl = this.plan(), pn = this.planner, interior = this.mode === 'floorplan';
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
        draw: 'Click to add points; each new point connects to the previous one. Click an existing point to connect to it (closing a loop) and continue from there. Enter, Space or Esc ends the chain: the next point starts a new, unconnected one.'
          + (interior ? ' Internal walls must stay inside the external walls (orange dashed).' : ' The orange dashed outline is the plan of the floor below; dotted orange lines show where its points connect up to this plan.'),
        select: 'Click points or walls to select (Shift = add). Drag points to move. Double-click a wall to insert a point. Delete removes the selection.',
        move: 'Drag anywhere to move every point and wall (and stairs / elevators) together.',
        stairs: 'Click inside the building to place a staircase. Select it to change size and rotation.',
        elevator: 'Click inside the building to place an elevator shaft.',
      };
      if (interior && !this.refStructure()) body.push(h('div', { class: 'warn' }, 'Assign this floor plan to floors that have external walls (a structure plan) first; internal walls can only go inside them.'));
      body.push(
        h('div', { class: 'box-title' }, 'Tool'),
        h('div', { class: 'row' }, toolBtn('draw', 'Draw (D)'), toolBtn('select', 'Select (S)'), toolBtn('move', 'Move all (M)'),
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
          interior ? null : this.numField('Ceiling thickness (m)', pl.ceilingThickness, v => (pl.ceilingThickness = v!), MAX_M),
          interior ? null : h('div', { class: 'muted small' }, 'Each floor has its own floor and ceiling; switch them on or off per floor in the floor panel.'),
          this.slider('Smoothness', pl.smooth, v => (pl.smooth = v)),
          interior ? null : this.connectField(pl.connect, v => (pl.connect = v!), false),
          interior ? null : this.slider('Connection smoothness', pl.connectSmooth, v => (pl.connectSmooth = v)),
          interior ? null : this.textureField('Texture for all walls', null, id => pl.segments.forEach(s => (s.texture = id))),
        ),
      );
    }

    this.right.innerHTML = '';
    put(this.right, 
      h('div', { class: 'box-title' }, interior ? 'Floor plans (internal walls)' : 'Structure plans (external walls)'),
      plansEl,
      h('div', { class: 'row' },
        h('button', {
          onclick: () => this.mutate(() => {
            const np = interior ? newInteriorPlan(`Floor plan ${list.length + 1}`) : newPlan(`Plan ${list.length + 1}`);
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
      kindBtn('wall', 'Wall'), interior ? kindBtn('door', 'Door') : null, kindBtn('colonnade', 'Colonnade'), kindBtn('open', 'Open')));
    if (kind === 'wall' || kind === 'colonnade') {
      const div = common(s => s.divisions ?? 1);
      const dIn = h('input', {
        type: 'number', min: 1, step: 1, value: div === 'mixed' ? '' : div, placeholder: 'mixed',
        onchange: () => { const v = Math.round(num(dIn.value)); if (!(v >= 1 && v <= 500)) { toast('Divisions: 1 to 500'); return this.refresh(); } setAll(s => (s.divisions = v)); },
      });
      wrap.append(h('label', {}, kind === 'colonnade' ? 'Divisions (columns sit between them)' : 'Divisions (one window slot each)', dIn));
    }
    if (kind === 'colonnade') {
      const ct = common(s => s.columnThickness ?? null);
      wrap.append(this.numField('Column thickness (m), empty = wall thickness', ct === 'mixed' ? null : ct, v => segs.forEach(s => (s.columnThickness = v)), L / 2, true));
    }
    wrap.append(this.materialField(common(s => s.material ?? null), v => segs.forEach(s => (s.material = v)), true));
    const sm = common(s => s.smooth ?? null);
    wrap.append(this.slider(`Smoothness${sm === null ? ' (plan default)' : ''}`, sm === 'mixed' ? null : sm, v => segs.forEach(s => (s.smooth = v)), () => segs.forEach(s => (s.smooth = null))));
    if (!interior) {
      const cs = common(s => s.connectSmooth ?? null);
      wrap.append(
        this.connectField(common(s => s.connect ?? null), v => segs.forEach(s => (s.connect = v)), true),
        this.slider(`Connection smoothness${cs === null ? ' (plan default)' : ''}`, cs === 'mixed' ? null : cs, v => segs.forEach(s => (s.connectSmooth = v)), () => segs.forEach(s => (s.connectSmooth = null))),
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
