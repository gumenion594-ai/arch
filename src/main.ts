import './style.css';
import {
  MAX_AREA, MAX_M, History, Project, StructurePlan, clamp, createProject, deleteProject, floorBase,
  loadProjects, newPlan, planForFloor, saveProject, totalHeight, uid,
} from './model';
import { Viewer, ViewMode } from './viewer';
import { Planner, fmt } from './planner';
import { planValid } from './geometry';

// ---------- tiny DOM helper ----------
type Attrs = Record<string, any>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== false) el.append(c);
  return el;
}
const app = document.getElementById('app')!;
let toastTimer = 0;
function toast(msg: string) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 2200);
}
const num = (s: string) => { const v = parseFloat(s.replace(',', '.')); return isFinite(v) ? v : NaN; };

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

// ======================================================================
// Editor
// ======================================================================
type Mode = 'view' | 'structure';

class Editor {
  p: Project;
  hist = new History();
  mode: Mode = 'view';
  viewMode: ViewMode = 'structural';
  selFloor: string | null = null;
  activePlan: string | null;
  root = h('div', { class: 'editor' });
  left = h('div', { class: 'left panel' });
  center = h('div', { class: 'center' });
  right = h('div', { class: 'right panel' });
  header = h('div', { class: 'header' });
  viewer: Viewer | null = null;
  planner: Planner | null = null;

  constructor(p: Project) {
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
    if (this.selFloor && !this.p.floors.some(f => f.id === this.selFloor)) this.selFloor = null;
    if (!this.p.plans.some(pl => pl.id === this.activePlan)) this.activePlan = this.p.plans[0]?.id ?? null;
    saveProject(this.p);
    this.planner?.prune();
    this.refresh();
  }

  refresh() {
    this.renderHeader();
    this.renderLeft();
    if (this.mode === 'structure') { this.renderRight(); this.planner?.draw(); }
    else this.viewer?.update(this.p, this.viewMode, this.selFloor);
  }

  setMode(m: Mode) {
    this.mode = m;
    this.viewer?.dispose(); this.viewer = null;
    this.planner?.dispose(); this.planner = null;
    this.center.innerHTML = '';
    this.root.classList.toggle('with-right', m === 'structure');
    if (m === 'view') {
      this.viewer = new Viewer(this.center);
    } else {
      this.planner = new Planner(this.center, {
        getPlan: () => this.plan(),
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
      h('button', { onclick: () => showList() }, '← Projects'),
      nameIn,
      h('div', { class: 'tabs' }, tab('view', '3D view'), tab('structure', 'Structure planner')),
      this.mode === 'view' ? vm : h('span'),
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => toast('Importing 3D models is planned — not implemented yet') }, 'Import 3D model'),
      h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, 'Undo'),
    );
  }

  // ---- floors panel ----
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

    // floor bar: floors stacked bottom-up, sized by height
    p.floors.forEach((f, i) => {
      const bottom = (floorBase(p, i) / H) * 100, hp = (f.height / H) * 100;
      const pl = planForFloor(p, f.id);
      const seg = h('div', {
        class: 'fseg' + (f.id === this.selFloor ? ' sel' : ''),
        style: `bottom:${bottom}%;height:${hp}%`,
        title: `Floor ${i + 1} · ${fmt(f.height)} m · ${pl?.name ?? 'no plan'}\nClick: select · Double-click: split here`,
        onclick: () => { this.selFloor = this.selFloor === f.id ? null : f.id; this.refresh(); },
        ondblclick: (e: MouseEvent) => {
          const r = seg.getBoundingClientRect();
          const ratio = clamp((r.bottom - e.clientY) / r.height, 0.05, 0.95);
          this.splitFloor(f.id, ratio);
        },
      }, h('span', {}, `F${i + 1} · ${fmt(f.height)} m${pl ? '' : ' · –'}`));
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

    const sel = p.floors.findIndex(f => f.id === this.selFloor);
    let selBox: HTMLElement;
    if (sel >= 0) {
      const f = p.floors[sel];
      const hin = h('input', {
        type: 'number', step: 0.1, value: fmt(f.height),
        onchange: () => {
          const v = num(hin.value);
          if (!(v > 0) || H - f.height + v > MAX_M) { toast('Invalid floor height'); return this.refresh(); }
          this.mutate(() => (f.height = v));
        },
      });
      selBox = h('div', { class: 'box' },
        h('div', { class: 'box-title' }, `Floor ${sel + 1}`),
        h('label', {}, 'Height (m)', hin),
        h('div', { class: 'muted small' }, `Starts at ${fmt(floorBase(p, sel))} m · plan: ${planForFloor(p, f.id)?.name ?? 'none'}`),
        h('div', { class: 'row' },
          h('button', { onclick: () => this.splitFloor(f.id, 0.5) }, 'Split'),
          h('button', {
            class: 'danger', disabled: p.floors.length <= 1,
            onclick: () => this.mutate(() => {
              p.floors.splice(sel, 1);
              p.plans.forEach(pl => (pl.floorIds = pl.floorIds.filter(id => id !== f.id)));
              this.selFloor = null;
            }),
          }, 'Delete'),
        ),
      );
    } else selBox = h('div', { class: 'muted small' }, 'Click a floor in the bar to select it. Drag its top edge to resize, double-click to split.');

    this.left.innerHTML = '';
    this.left.append(
      h('div', { class: 'box-title' }, 'Floors'),
      h('label', {}, 'Total height (m)', total),
      h('label', {}, 'Number of floors', count),
      h('div', { class: 'muted small' }, `Base ${fmt(p.baseLength)} m × ${fmt(p.baseLength)} m (${fmt(p.baseLength ** 2)} m²)`),
      h('div', { class: 'floorbar-wrap' }, bar),
      selBox,
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
      this.selFloor = nf.id;
    });
  }

  // ---- structure planner panel ----
  renderRight() {
    if (this.mode !== 'structure' || !this.planner) return;
    const p = this.p, pl = this.plan(), pn = this.planner;
    const plans = h('div', { class: 'plans' }, ...p.plans.map(x => h('div', {
      class: 'plan-row' + (x.id === this.activePlan ? ' active' : ''),
      onclick: () => { this.activePlan = x.id; pn.head = null; pn.selPoints.clear(); pn.selSegs.clear(); this.refresh(); },
    }, x.name, h('span', { class: 'muted small' }, ` ${x.floorIds.length} floor(s)`))));

    const body: (Node | null)[] = [];
    if (pl) {
      const floorChecks = h('div', { class: 'floor-checks' }, ...p.floors.map((f, i) => {
        const cb = h('input', {
          type: 'checkbox', checked: pl.floorIds.includes(f.id),
          onchange: () => this.mutate(() => {
            if (cb.checked) { p.plans.forEach(o => (o.floorIds = o.floorIds.filter(id => id !== f.id))); pl.floorIds.push(f.id); }
            else pl.floorIds = pl.floorIds.filter(id => id !== f.id);
          }),
        });
        const other = planForFloor(p, f.id);
        return h('label', { class: 'chk', title: other && other !== pl ? `Currently uses ${other.name}` : '' }, cb, `F${i + 1}`);
      }).reverse());
      const numField = (label: string, val: number, set: (v: number) => void, max = 100) => {
        const inp = h('input', {
          type: 'number', step: 0.05, value: fmt(val),
          onchange: () => { const v = num(inp.value); if (!(v > 0) || v > max) { toast(`${label} must be between 0 and ${max}`); return this.refresh(); } this.mutate(() => set(v)); },
        });
        return h('label', {}, label, inp);
      };
      const floorEn = h('input', { type: 'checkbox', checked: pl.floorEnabled, onchange: () => this.mutate(() => (pl.floorEnabled = floorEn.checked)) });
      const toolBtn = (t: 'draw' | 'select', label: string) => h('button', {
        class: pn.tool === t ? 'tab active' : 'tab',
        onclick: () => { pn.tool = t; if (t === 'select') pn.head = null; this.refresh(); },
      }, label);

      body.push(
        h('div', { class: 'box-title' }, 'Applies to floors'), floorChecks,
        numField('External wall thickness (m)', pl.wallThickness, v => (pl.wallThickness = v), p.baseLength / 2),
        numField('Floor thickness (m)', pl.floorThickness, v => (pl.floorThickness = v), MAX_M),
        h('label', { class: 'chk' }, floorEn, 'Build floor slab'),
        h('div', { class: 'box-title' }, 'Tool'),
        h('div', { class: 'row' }, toolBtn('draw', 'Draw (D)'), toolBtn('select', 'Select (S)'),
          pn.tool === 'draw' ? h('button', { onclick: () => pn.endChain() }, 'End chain (Esc)') : null),
        this.selectionBox(pl),
        h('div', { class: 'muted small help' },
          pn.tool === 'draw'
            ? 'Click to add points; each new point connects to the previous one. Click an existing point to connect to it (closing a loop) and continue from there. Esc starts a new, unconnected chain.'
            : 'Click points or walls to select (Shift = add). Drag points to move. Double-click a wall to insert a point. Delete removes the selection.'),
      );
    }

    this.right.innerHTML = '';
    this.right.append(
      h('div', { class: 'box-title' }, 'Structure plans'),
      plans,
      h('div', { class: 'row' },
        h('button', { onclick: () => this.mutate(() => { const np = newPlan(`Plan ${p.plans.length + 1}`); p.plans.push(np); this.activePlan = np.id; }) }, 'New'),
        h('button', { disabled: !pl, onclick: () => { const n = pl && prompt('Rename plan', pl.name); if (pl && n?.trim()) this.mutate(() => (pl.name = n.trim())); } }, 'Rename'),
        h('button', {
          class: 'danger', disabled: !pl,
          onclick: () => { if (pl && confirm(`Delete ${pl.name}?`)) this.mutate(() => { p.plans = p.plans.filter(x => x !== pl); this.activePlan = p.plans[0]?.id ?? null; }); },
        }, 'Delete'),
      ),
      ...body.filter(Boolean) as Node[],
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
    if (nS === 1 && !nP) {
      const s = pl.segments.find(x => x.id === [...pn.selSegs][0])!;
      const A = pl.points.find(x => x.id === s.a)!, B = pl.points.find(x => x.id === s.b)!;
      const len = Math.hypot(B.x - A.x, B.y - A.y) * L;
      const inp = h('input', {
        type: 'number', step: 0.1, value: fmt(len),
        onchange: () => {
          const v = num(inp.value);
          if (!(v > 0)) { toast('Length must be > 0'); return this.refresh(); }
          // keep point A, move B along the wall direction
          const k = v / len;
          const nb = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k };
          if (nb.x < -1e-9 || nb.x > 1 + 1e-9 || nb.y < -1e-9 || nb.y > 1 + 1e-9) { toast('That length would leave the building area'); return this.refresh(); }
          if (!validMove(pl, B.id, nb)) { toast('That length would make walls cross'); return this.refresh(); }
          this.mutate(() => { B.x = clamp(nb.x, 0, 1); B.y = clamp(nb.y, 0, 1); });
        },
      });
      box.append(
        h('label', {}, `Wall length (m) · #${A.n} → #${B.n}`, inp),
        h('button', { onclick: () => pn.insertPoint(pl, s.id) }, 'Insert point in middle'),
      );
    }
    box.append(h('button', { class: 'danger', onclick: () => pn.deleteSelection() }, nP ? 'Delete selected' : 'Delete wall(s)'));
    return box;
  }
}

const validMove = (pl: StructurePlan, id: string, np: { x: number; y: number }) => planValid(pl, new Map([[id, np]]));

let editor: Editor | null = null;
function openProject(id: string) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return showList();
  editor?.destroy();
  editor = new Editor(p);
}

showList();
