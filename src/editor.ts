// Project editor: header, floor panel, 3D view / structure planner and their panels.
import {
  ConnectMode, History, MAX_M, PlanSegment, Project, SegKind, StructurePlan, clamp, floorBase, formatRanges,
  newPlan, parseRanges, planForFloor, saveProject, segKind, totalHeight, uid,
} from './model';
import { Viewer, ViewMode } from './viewer';
import { Planner, fmt } from './planner';
import { planValid } from './geometry';
import { app, h, num, toast } from './ui';

type Mode = 'view' | 'structure';
const PLAN_COLORS = ['#4a90d9', '#d97a4a', '#5cb85c', '#b05cd9', '#d9c84a', '#4ad9c8', '#d94a7a', '#8a8a8a'];

export class Editor {
  p: Project;
  hist = new History();
  mode: Mode = 'view';
  viewMode: ViewMode = 'structural';
  selFloors = new Set<string>();
  private anchor: string | null = null; // for shift-click range selection
  activePlan: string | null;
  root = h('div', { class: 'editor' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  right = h('div', { class: 'right panel' });
  header = h('div', { class: 'header' });
  viewer: Viewer | null = null;
  planner: Planner | null = null;

  constructor(p: Project, private onBack: () => void) {
    this.p = p;
    this.activePlan = p.plans[0]?.id ?? null;
    this.root.append(this.header, this.left, this.center, this.right);
    app.innerHTML = '';
    app.append(this.root);
    window.addEventListener('keydown', this.onKey);
    this.setMode('view');
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    this.viewer?.dispose(); this.planner?.dispose();
  }

  // ---- change management ----
  begin() { this.hist.push(this.p); }
  commit() { saveProject(this.p); this.refresh(); }
  mutate(fn: () => void) { this.begin(); fn(); this.commit(); }
  undo() {
    const prev = this.hist.pop();
    if (!prev) return toast('Nothing to undo');
    this.p = prev;
    for (const id of [...this.selFloors]) if (!this.p.floors.some(f => f.id === id)) this.selFloors.delete(id);
    if (!this.p.plans.some(pl => pl.id === this.activePlan)) this.activePlan = this.p.plans[0]?.id ?? null;
    saveProject(this.p);
    this.planner?.prune();
    this.refresh();
  }

  refresh() {
    this.renderHeader();
    this.renderLeft();
    if (this.mode === 'structure') { this.renderRight(); this.planner?.draw(); }
    else this.viewer?.update(this.p, this.viewMode, this.selFloors);
  }

  setMode(m: Mode) {
    this.mode = m;
    this.viewer?.dispose(); this.viewer = null;
    this.planner?.dispose(); this.planner = null;
    this.center.innerHTML = '';
    this.root.classList.toggle('with-right', m === 'structure');
    if (m === 'view') {
      this.viewer = new Viewer(this.center);
      this.viewer.onTexture = () => this.refresh();
    } else {
      this.planner = new Planner(this.center, {
        getPlan: () => this.plan(),
        getGhost: () => this.ghostPlan(),
        baseLength: () => this.p.baseLength,
        begin: () => this.begin(),
        commit: () => this.commit(),
        toast,
        selectionChanged: () => this.renderRight(),
      });
    }
    this.refresh();
  }

  plan(): StructurePlan | null { return this.p.plans.find(pl => pl.id === this.activePlan) ?? null; }

  /** The plan just below where the active plan starts (Top level -> top floor's plan). */
  ghostPlan(): StructurePlan | null {
    const pl = this.plan();
    if (!pl) return null;
    const idx = this.p.floors.findIndex(f => pl.floorIds.includes(f.id));
    if (idx > 0) return planForFloor(this.p, this.p.floors[idx - 1].id) ?? null;
    if (idx < 0 && this.p.topPlanId === pl.id) return planForFloor(this.p, this.p.floors[this.p.floors.length - 1].id) ?? null;
    return null;
  }

  planColor(pl: StructurePlan | null | undefined) {
    if (!pl) return 'transparent';
    return PLAN_COLORS[this.p.plans.indexOf(pl) % PLAN_COLORS.length];
  }

  private onKey = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    const typing = tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undo(); return; }
    if (typing || !this.planner) return;
    if (e.key === 'Escape') this.planner.endChain();
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.planner.deleteSelection(); }
    if (e.key === 'd') { this.planner.tool = 'draw'; this.refresh(); }
    if (e.key === 's') { this.planner.tool = 'select'; this.planner.endChain(); this.refresh(); }
  };

  // ---- header ----
  renderHeader() {
    const nameIn = h('input', {
      class: 'title-input', value: this.p.name,
      onchange: () => { const v = nameIn.value.trim(); if (v && v !== this.p.name) this.mutate(() => { this.p.name = v; }); else nameIn.value = this.p.name; },
    });
    const tab = (m: Mode, label: string) => h('button', { class: this.mode === m ? 'tab active' : 'tab', onclick: () => this.setMode(m) }, label);
    const vm = h('select', { onchange: () => { this.viewMode = vm.value as ViewMode; this.refresh(); } },
      h('option', { value: 'plan' }, 'Floor plan view'),
      h('option', { value: 'structural' }, 'Structural view'),
      h('option', { value: 'detailed' }, 'Detailed view'),
    );
    vm.value = this.viewMode;
    this.header.innerHTML = '';
    this.header.append(
      h('button', { onclick: () => this.onBack() }, '← Projects'),
      nameIn,
      h('div', { class: 'tabs' }, tab('view', '3D view'), tab('structure', 'Structure planner')),
      this.mode === 'view' ? vm : h('span'),
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => toast('Importing 3D models is planned — not implemented yet') }, 'Import 3D model'),
      h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, 'Undo'),
    );
  }

  // ---- floors panel ----
  private clickFloor(e: MouseEvent, id: string) {
    const ids = this.p.floors.map(f => f.id);
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
    this.refresh();
  }

  renderLeft() {
    const p = this.p, H = totalHeight(p);
    const bar = h('div', { class: 'floorbar' });
    const total = h('input', {
      type: 'number', step: 0.1, value: fmt(H),
      onchange: () => {
        const v = num(total.value);
        if (!(v > 0) || v > MAX_M) { toast('Total height must be between 0 and 10 000 m'); return this.refresh(); }
        const k = v / H;
        this.mutate(() => p.floors.forEach(f => (f.height *= k)));
      },
    });
    const count = h('input', {
      type: 'number', step: 1, min: 1, value: p.floors.length,
      onchange: () => {
        const n = Math.round(num(count.value));
        if (!(n >= 1) || n > 2000) { toast('Floors must be between 1 and 2000'); return this.refresh(); }
        const top = p.floors[p.floors.length - 1];
        const add = n - p.floors.length;
        if (add > 0 && H + add * top.height > MAX_M) { toast('That would exceed 10 000 m'); return this.refresh(); }
        this.mutate(() => {
          if (add > 0) {
            const pl = planForFloor(p, top.id);
            for (let i = 0; i < add; i++) { const f = { id: uid(), height: top.height }; p.floors.push(f); pl?.floorIds.push(f.id); }
          } else {
            const removed = p.floors.splice(n).map(f => f.id);
            p.plans.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !removed.includes(id))));
          }
        });
      },
    });

    // floor bar: floors stacked bottom-up, sized by height, coloured stripe = plan
    const top = p.plans.find(pl => pl.id === p.topPlanId);
    bar.append(h('div', { class: 'ftop', title: 'Top level (roof)', style: `border-left-color:${this.planColor(top)}` }, `Top · ${top?.name ?? 'no plan'}`));
    p.floors.forEach((f, i) => {
      const bottom = (floorBase(p, i) / H) * 100, hp = (f.height / H) * 100;
      const pl = planForFloor(p, f.id);
      const seg = h('div', {
        class: 'fseg' + (this.selFloors.has(f.id) ? ' sel' : ''),
        style: `bottom:${bottom}%;height:${hp}%;border-left-color:${this.planColor(pl)}`,
        title: `Floor ${i + 1} · ${fmt(f.height)} m · ${pl?.name ?? 'no plan'}\nClick: select · Shift: range · Ctrl: add · Double-click: split here`,
        onclick: (e: MouseEvent) => this.clickFloor(e, f.id),
        ondblclick: (e: MouseEvent) => {
          const r = seg.getBoundingClientRect();
          const ratio = clamp((r.bottom - e.clientY) / r.height, 0.05, 0.95);
          this.splitFloor(f.id, ratio);
        },
      }, h('span', {}, `F${i + 1} · ${fmt(f.height)} m`));
      // drag handle on the top edge changes only this floor's height
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

    this.left.innerHTML = '';
    this.left.append(
      h('div', { class: 'box-title' }, 'Floors'),
      h('label', {}, 'Total height (m)', total),
      h('label', {}, 'Number of floors', count),
      h('div', { class: 'muted small' }, `Base ${fmt(p.baseLength)} m × ${fmt(p.baseLength)} m (${fmt(p.baseLength ** 2)} m²)`),
      h('div', { class: 'floorbar-wrap' }, bar),
      this.floorSelectionBox(),
    );
    // hide labels of floors too thin to read
    bar.querySelectorAll<HTMLElement>('.fseg').forEach(el => { if (el.clientHeight < 14) el.querySelector('span')?.remove(); });
  }

  private floorSelectionBox(): HTMLElement {
    const p = this.p, H = totalHeight(p);
    const idx = p.floors.map((f, i) => (this.selFloors.has(f.id) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return h('div', { class: 'muted small' }, 'Click a floor to select it (Shift = range, Ctrl = add). Drag its top edge to resize, double-click to split.');
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
    // plan for the selected floors
    const plans = new Set(sel.map(f => planForFloor(p, f.id)?.id ?? ''));
    const planSel = h('select', {
      onchange: () => this.mutate(() => {
        const ids = sel.map(f => f.id);
        p.plans.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.includes(id))));
        p.plans.find(pl => pl.id === planSel.value)?.floorIds.push(...ids);
      }),
    }, ...(plans.size > 1 ? [h('option', { value: '__mixed', disabled: true }, 'mixed')] : []),
      h('option', { value: '' }, '— none —'), ...p.plans.map(pl => h('option', { value: pl.id }, pl.name)));
    planSel.value = plans.size > 1 ? '__mixed' : [...plans][0];

    return h('div', { class: 'box' },
      h('div', { class: 'box-title' }, one ? `Floor ${idx[0] + 1}` : `${sel.length} floors: ${formatRanges(idx.map(i => i + 1))}`),
      h('label', {}, one ? 'Height (m)' : 'Height of each (m)', hin),
      h('label', {}, 'Structure plan', planSel),
      one ? h('div', { class: 'muted small' }, `Starts at ${fmt(floorBase(p, idx[0]))} m`) : null,
      h('div', { class: 'row' },
        one ? h('button', { onclick: () => this.splitFloor(one.id, 0.5) }, 'Split') : null,
        h('button', {
          class: 'danger', disabled: sel.length >= p.floors.length,
          onclick: () => this.mutate(() => {
            const ids = sel.map(f => f.id);
            p.floors = p.floors.filter(f => !ids.includes(f.id));
            p.plans.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => !ids.includes(id))));
            this.selFloors.clear();
          }),
        }, 'Delete'),
      ),
    );
  }

  splitFloor(id: string, ratio: number) {
    const i = this.p.floors.findIndex(f => f.id === id);
    const f = this.p.floors[i];
    this.mutate(() => {
      const lower = Math.round(f.height * ratio * 100) / 100;
      const nf = { id: uid(), height: Math.round((f.height - lower) * 100) / 100 };
      f.height = lower;
      this.p.floors.splice(i + 1, 0, nf);
      planForFloor(this.p, f.id)?.floorIds.push(nf.id);
      this.selFloors = new Set([nf.id]);
    });
  }

  // ---- structure planner panel ----
  renderRight() {
    if (this.mode !== 'structure' || !this.planner) return;
    const p = this.p, pl = this.plan(), pn = this.planner;
    const floorNums = (x: StructurePlan) => p.floors.map((f, i) => (x.floorIds.includes(f.id) ? i + 1 : 0)).filter(Boolean);
    const plans = h('div', { class: 'plans' }, ...p.plans.map(x => h('div', {
      class: 'plan-row' + (x.id === this.activePlan ? ' active' : ''),
      style: `border-left-color:${this.planColor(x)}`,
      onclick: () => { this.activePlan = x.id; pn.head = null; pn.selPoints.clear(); pn.selSegs.clear(); this.refresh(); },
    }, x.name, h('span', { class: 'muted small' }, ` ${formatRanges(floorNums(x)) || 'no floors'}${p.topPlanId === x.id ? ' + Top' : ''}`))));

    const body: (Node | null)[] = [];
    if (pl) {
      // floor assignment: range text, All / None / Selected floors, Top level
      const ranges = h('input', {
        value: formatRanges(floorNums(pl)), placeholder: 'e.g. 1-20, 25',
        onchange: () => {
          const nums = parseRanges(ranges.value, p.floors.length);
          if (!nums) { toast('Use floor numbers and ranges, e.g. 1-20, 25'); return this.refresh(); }
          this.assign(pl, nums.map(n => p.floors[n - 1].id));
        },
      });
      const topCb = h('input', { type: 'checkbox', checked: p.topPlanId === pl.id, onchange: () => this.mutate(() => (p.topPlanId = topCb.checked ? pl.id : null)) });

      const toolBtn = (t: 'draw' | 'select', label: string) => h('button', {
        class: pn.tool === t ? 'tab active' : 'tab',
        onclick: () => { pn.tool = t; if (t === 'select') pn.head = null; this.refresh(); },
      }, label);
      body.push(
        h('div', { class: 'box-title' }, 'Tool'),
        h('div', { class: 'row' }, toolBtn('draw', 'Draw (D)'), toolBtn('select', 'Select (S)'),
          pn.tool === 'draw' ? h('button', { onclick: () => pn.endChain() }, 'End chain (Esc)') : null),
        this.selectionBox(pl),
        h('div', { class: 'muted small help' },
          pn.tool === 'draw'
            ? 'Click to add points; each new point connects to the previous one. Click an existing point to connect to it (closing a loop) and continue from there. Esc starts a new, unconnected chain. The orange dashed outline is the plan of the floor below.'
            : 'Click points or walls to select (Shift = add). Drag points to move. Double-click a wall to insert a point. Delete removes the selection.'),
      );
      body.push(
        h('div', { class: 'box-title' }, 'Applies to floors'),
        ranges,
        h('div', { class: 'row' },
          h('button', { onclick: () => this.assign(pl, p.floors.map(f => f.id)) }, 'All'),
          h('button', { onclick: () => this.assign(pl, []) }, 'None'),
          h('button', { disabled: !this.selFloors.size, title: 'Floors selected in the floor bar', onclick: () => this.assign(pl, [...pl.floorIds, ...this.selFloors]) }, '+ Selected floors'),
        ),
        h('label', { class: 'chk', title: 'The shape at the very top of the building. The top floor can connect up to it (e.g. a single point = pyramid roof). It has no walls of its own.' }, topCb, 'Top level (roof)'),
        h('details', { open: !pn.selPoints.size && !pn.selSegs.size }, h('summary', {}, 'Plan defaults'),
          this.numField('External wall thickness (m)', pl.wallThickness, v => (pl.wallThickness = v!), p.baseLength / 2),
          this.numField('Floor thickness (m)', pl.floorThickness, v => (pl.floorThickness = v!), MAX_M),
          this.checkField('Build floor slab', pl.floorEnabled, v => (pl.floorEnabled = v)),
          this.slider('Smoothness', pl.smooth, v => (pl.smooth = v)),
          this.connectField(pl.connect, v => (pl.connect = v!), false),
          this.slider('Connection smoothness', pl.connectSmooth, v => (pl.connectSmooth = v)),
          this.textureField('Texture for all walls', null, id => pl.segments.forEach(s => (s.texture = id))),
        ),
      );
    }

    this.right.innerHTML = '';
    this.right.append(
      h('div', { class: 'box-title' }, 'Structure plans'),
      plans,
      h('div', { class: 'row' },
        h('button', { onclick: () => this.mutate(() => { const np = newPlan(`Plan ${p.plans.length + 1}`); p.plans.push(np); this.activePlan = np.id; }) }, 'New'),
        h('button', {
          disabled: !pl, title: 'Copy this plan (walls and settings), assigned to no floors',
          onclick: () => pl && this.mutate(() => {
            const c: StructurePlan = JSON.parse(JSON.stringify(pl));
            c.id = uid(); c.name = `${pl.name} copy`; c.floorIds = [];
            p.plans.push(c); this.activePlan = c.id;
          }),
        }, 'Duplicate'),
        h('button', { disabled: !pl, onclick: () => { const n = pl && prompt('Rename plan', pl.name); if (pl && n?.trim()) this.mutate(() => (pl.name = n.trim())); } }, 'Rename'),
        h('button', {
          class: 'danger', disabled: !pl,
          onclick: () => {
            if (pl && confirm(`Delete ${pl.name}?`)) this.mutate(() => {
              p.plans = p.plans.filter(x => x !== pl);
              if (p.topPlanId === pl.id) p.topPlanId = null;
              this.activePlan = p.plans[0]?.id ?? null;
            });
          },
        }, 'Delete'),
      ),
      ...body.filter(Boolean) as Node[],
    );
  }

  /** Assign floors to a plan (taking them away from any other plan). */
  assign(pl: StructurePlan, ids: string[]) {
    this.mutate(() => {
      const set = new Set(ids);
      this.p.plans.forEach(o => (o.floorIds = o.floorIds.filter(id => !set.has(id))));
      pl.floorIds = this.p.floors.map(f => f.id).filter(id => set.has(id));
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
  /** 0..100% slider. val null = "default" (only when a reset callback is given). */
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

  selectionBox(pl: StructurePlan): HTMLElement | null {
    const pn = this.planner!, L = this.p.baseLength;
    const nP = pn.selPoints.size, nS = pn.selSegs.size;
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
    if (segs.length) box.append(this.segmentProps(pl, segs));
    box.append(h('button', { class: 'danger', onclick: () => pn.deleteSelection() }, nP ? 'Delete selected' : 'Delete wall(s)'));
    return box;
  }

  /** Properties of one or more selected walls. */
  segmentProps(pl: StructurePlan, segs: PlanSegment[]): HTMLElement {
    const L = this.p.baseLength, pn = this.planner!;
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
          const k = v / len; // keep A, move B along the wall direction
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
    wrap.append(h('div', { class: 'box-title' }, 'Type'), h('div', { class: 'row' }, kindBtn('wall', 'Wall'), kindBtn('colonnade', 'Colonnade'), kindBtn('open', 'Open')));
    if (kind === 'colonnade') {
      const div = common(s => s.divisions ?? 1);
      const dIn = h('input', {
        type: 'number', min: 1, step: 1, value: div === 'mixed' ? '' : div, placeholder: 'mixed',
        onchange: () => { const v = Math.round(num(dIn.value)); if (!(v >= 1 && v <= 500)) { toast('Divisions: 1 to 500'); return this.refresh(); } setAll(s => (s.divisions = v)); },
      });
      const ct = common(s => s.columnThickness ?? null);
      wrap.append(
        h('label', {}, 'Divisions (columns sit between them)', dIn),
        this.numField('Column thickness (m), empty = wall thickness', ct === 'mixed' ? null : ct, v => segs.forEach(s => (s.columnThickness = v)), L / 2, true),
      );
    }
    const sm = common(s => s.smooth ?? null);
    const cs = common(s => s.connectSmooth ?? null);
    wrap.append(
      this.slider(`Smoothness${sm === null ? ' (plan default)' : ''}`, sm === 'mixed' ? null : sm, v => segs.forEach(s => (s.smooth = v)), () => segs.forEach(s => (s.smooth = null))),
      this.connectField(common(s => s.connect ?? null), v => segs.forEach(s => (s.connect = v)), true),
      this.slider(`Connection smoothness${cs === null ? ' (plan default)' : ''}`, cs === 'mixed' ? null : cs, v => segs.forEach(s => (s.connectSmooth = v)), () => segs.forEach(s => (s.connectSmooth = null))),
      this.textureField('Texture', common(s => s.texture ?? null), id => segs.forEach(s => (s.texture = id))),
    );
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
