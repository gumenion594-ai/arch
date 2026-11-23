// "New project" and "New building" dialogs (same parameters; buildings also get placed).
import { BuildingSpec, MAX_AREA, MAX_M, Project, clamp } from './model';
import { fmt } from './planner';
import { h, num } from './ui';

interface Opts {
  title: string;
  nameLabel: string;
  defaultName: string;
  project?: Project; // when adding a building: existing buildings to place against
  onCreate(spec: BuildingSpec, name: string): void;
}

export function buildingDialog(o: Opts) {
  type Combo = 'nf' | 'nt' | 'ft';
  const name = h('input', { value: o.defaultName });
  const comboSel = h('select', {},
    h('option', { value: 'nf' }, 'Number of floors + floor height'),
    h('option', { value: 'nt' }, 'Number of floors + total height'),
    h('option', { value: 'ft' }, 'Floor height + total height'),
  );
  const inN = h('input', { type: 'number', min: 1, step: 1, value: 3 });
  const inF = h('input', { type: 'number', min: 0.1, step: 0.1, value: 3 });
  const inT = h('input', { type: 'number', min: 0.1, step: 0.1, value: 9 });
  const inU = h('input', { type: 'number', min: 0, step: 1, value: 0 });
  const baseSel = h('select', {}, h('option', { value: 'len' }, 'Base length (m)'), h('option', { value: 'area' }, 'Surface area (m²)'));
  const inB = h('input', { type: 'number', min: 0.1, step: 0.1, value: 20 });
  const out = h('div', { class: 'calc' });
  const placing = !!o.project?.buildings.length;
  const okBtn = h('button', { class: 'primary' }, placing ? 'Next: place it →' : 'Create');
  const rowN = h('label', {}, 'Number of floors (in total)', inN);
  const rowF = h('label', {}, 'Floor height (m)', inF);
  const rowT = h('label', {}, 'Total height (m)', inT);

  let result: { n: number; f: number; L: number; u: number } | null = null;
  const calc = () => {
    const combo = comboSel.value as Combo, baseMode = baseSel.value;
    rowN.style.display = combo === 'ft' ? 'none' : '';
    rowF.style.display = combo === 'nt' ? 'none' : '';
    rowT.style.display = combo === 'nf' ? 'none' : '';
    let n = num(inN.value), f = num(inF.value), t = num(inT.value);
    const u = num(inU.value);
    const errs: string[] = [];
    if (combo === 'nf') t = n * f;
    if (combo === 'nt') f = t / n;
    if (combo === 'ft') { n = Math.max(1, Math.round(t / f)); f = t / n; }
    if (combo !== 'ft' && (!Number.isInteger(n) || n < 1)) errs.push('Number of floors must be a whole number ≥ 1');
    if (!(f > 0)) errs.push('Floor height must be > 0');
    if (!(t > 0) || t > MAX_M) errs.push('Total height must be between 0 and 10 000 m');
    if (n > 2000) errs.push('Too many floors (max 2000)');
    if (!Number.isInteger(u) || u < 0 || u >= n) errs.push('Underground floors: a whole number, less than the number of floors');
    const b = num(inB.value);
    const L = baseMode === 'len' ? b : Math.sqrt(b);
    if (!(b > 0)) errs.push('Base must be > 0');
    if (baseMode === 'len' && b > MAX_M) errs.push('Base length is capped at 10 000 m');
    if (baseMode === 'area' && b > MAX_AREA) errs.push('Area is capped at 100 000 000 m² (10 km × 10 km)');
    out.innerHTML = '';
    out.append(
      h('div', {}, `${n} floor${n === 1 ? '' : 's'} × ${fmt(f)} m = ${fmt(t)} m total`),
      h('div', {}, u > 0 && u < n ? `${u} underground (${fmt(u * f)} m deep) · ground floor + ${n - u - 1} above` : 'No underground floors'),
      h('div', {}, baseMode === 'len' ? `Area: ${fmt(b * b)} m²` : `Base length: ${fmt(L)} m`),
      ...errs.map(e => h('div', { class: 'err' }, e)),
    );
    result = errs.length ? null : { n, f, L, u };
    okBtn.disabled = !result || !name.value.trim();
  };
  [comboSel, inN, inF, inT, inU, baseSel, inB, name].forEach(el => el.addEventListener('input', calc));
  calc();

  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  const dialog = h('div', { class: 'dialog' });
  const form = h('div', {},
    h('h2', {}, o.title),
    h('label', {}, o.nameLabel, name),
    h('label', {}, 'Height defined by', comboSel),
    rowN, rowF, rowT,
    h('label', {}, 'Underground floors (the floor above them is the ground floor)', inU),
    h('label', {}, 'Base defined by', baseSel),
    h('label', {}, 'Value', inB),
    h('p', { class: 'muted small' }, 'The building area is a square. The base length cannot be changed later.'),
    out,
    h('div', { class: 'row end' }, h('button', { onclick: close }, 'Cancel'), okBtn),
  );
  dialog.append(form);

  const spec = (x = 0, y = 0): BuildingSpec => ({ name: name.value.trim(), baseLength: result!.L, floors: result!.n, floorHeight: result!.f, ground: result!.u, x, y });
  okBtn.addEventListener('click', () => {
    if (!result) return;
    if (!placing) { close(); o.onCreate(spec(), name.value.trim()); return; }
    form.style.display = 'none';
    dialog.append(placement(o.project!, result.L, (x, y) => { close(); o.onCreate(spec(x, y), name.value.trim()); }, () => {
      dialog.lastChild!.remove(); form.style.display = '';
    }));
  });
  overlay.append(dialog);
  document.body.append(overlay);
  name.focus(); name.select();
}

/** Drag the new building's square relative to the existing ones (overlap allowed, edges snap). */
function placement(p: Project, L: number, done: (x: number, y: number) => void, back: () => void) {
  const others = p.buildings;
  // default: to the right of everything, aligned with the lowest edge
  const maxX = Math.max(...others.map(b => b.x + b.baseLength));
  const minY = Math.min(...others.map(b => b.y));
  let x = maxX + Math.max(2, L * 0.1), y = minY;

  const size = 380;
  const c = h('canvas', { width: size * 2, height: size * 2, style: `width:${size}px;height:${size}px;cursor:move;border-radius:4px;display:block;margin:8px auto` });
  const g = c.getContext('2d')!;
  const inX = h('input', { type: 'number', step: 0.5 });
  const inY = h('input', { type: 'number', step: 0.5 });
  let view = { x0: 0, y0: 0, k: 1 };

  const fit = () => {
    const xs = [...others.flatMap(b => [b.x, b.x + b.baseLength]), x, x + L];
    const ys = [...others.flatMap(b => [b.y, b.y + b.baseLength]), y, y + L];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const span = Math.max(x1 - x0, y1 - y0) * 1.5 || 1;
    view = { x0: (x0 + x1) / 2 - span / 2, y0: (y0 + y1) / 2 - span / 2, k: size / span };
  };
  const S = (wx: number, wy: number) => ({ x: (wx - view.x0) * view.k, y: size - (wy - view.y0) * view.k });
  const draw = () => {
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.fillStyle = '#232323'; g.fillRect(0, 0, size, size);
    const rect = (bx: number, by: number, l: number, fill: string, stroke: string, label: string) => {
      const a = S(bx, by + l), s = l * view.k;
      g.fillStyle = fill; g.fillRect(a.x, a.y, s, s);
      g.strokeStyle = stroke; g.lineWidth = 1.5; g.strokeRect(a.x, a.y, s, s);
      g.fillStyle = stroke; g.font = '11px system-ui'; g.fillText(label, a.x + 4, a.y + 14);
    };
    for (const b of others) rect(b.x, b.y, b.baseLength, 'rgba(255,255,255,0.06)', '#cfcfcf', `${b.name} (${fmt(b.baseLength)} m)`);
    rect(x, y, L, 'rgba(255,212,0,0.15)', '#ffd400', `New (${fmt(L)} m)`);
    inX.value = fmt(x); inY.value = fmt(y);
  };
  const snap = (v: number, edges: number[]) => {
    const tol = 8 / view.k;
    let best = v, bd = tol;
    for (const e of edges) for (const cand of [e, e - L]) if (Math.abs(cand - v) < bd) { bd = Math.abs(cand - v); best = cand; }
    return best;
  };
  let drag: { mx: number; my: number; x: number; y: number } | null = null;
  c.addEventListener('mousedown', e => { drag = { mx: e.clientX, my: e.clientY, x, y }; });
  const mv = (e: MouseEvent) => {
    if (!drag) return;
    x = snap(drag.x + (e.clientX - drag.mx) / view.k, others.flatMap(b => [b.x, b.x + b.baseLength]));
    y = snap(drag.y - (e.clientY - drag.my) / view.k, others.flatMap(b => [b.y, b.y + b.baseLength]));
    x = clamp(x, -MAX_M, MAX_M); y = clamp(y, -MAX_M, MAX_M);
    draw();
  };
  const up = () => { if (drag) { drag = null; fit(); draw(); } };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  const onIn = () => { const nx = num(inX.value), ny = num(inY.value); if (isFinite(nx) && isFinite(ny)) { x = clamp(nx, -MAX_M, MAX_M); y = clamp(ny, -MAX_M, MAX_M); fit(); draw(); } };
  inX.addEventListener('change', onIn); inY.addEventListener('change', onIn);
  const cleanup = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  fit(); draw();
  return h('div', {},
    h('h2', {}, 'Place the building'),
    h('p', { class: 'muted small' }, 'Drag the yellow square. It may overlap other buildings; edges snap to theirs. Position = its lower-left corner, in metres.'),
    c,
    h('div', { class: 'row' }, h('label', {}, 'x (m)', inX), h('label', {}, 'y (m)', inY)),
    h('div', { class: 'row end' },
      h('button', { onclick: () => { cleanup(); back(); } }, '← Back'),
      h('button', { class: 'primary', onclick: () => { cleanup(); done(x, y); } }, 'Create building'),
    ),
  );
}
