export const app = document.getElementById('app')!;
// ---------- tiny DOM helper ----------
type Attrs = Record<string, any>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]) {
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
let toastTimer = 0;
export function toast(msg: string) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 2200);
}
export const num = (s: string) => { const v = parseFloat(s.replace(',', '.')); return isFinite(v) ? v : NaN; };
/** Append children, skipping null / false entries. */
export function put(el: HTMLElement, ...kids: (Node | string | null | false | undefined)[]) {
  for (const k of kids) if (k !== null && k !== false && k !== undefined) el.append(k);
}

/** In-page text prompt (browser prompt() is blocked in some embeds). Resolves null on cancel. */
export function askText(title: string, value: string): Promise<string | null> {
  return new Promise(res => {
    const inp = h('input', { value, style: 'width:100%' });
    const overlay = h('div', { class: 'overlay' });
    const done = (v: string | null) => { overlay.remove(); res(v); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); });
    overlay.append(h('div', { class: 'dialog' },
      h('h2', {}, title), inp,
      h('div', { class: 'row end' }, h('button', { onclick: () => done(null) }, 'Cancel'), h('button', { class: 'primary', onclick: () => done(inp.value) }, 'OK')),
    ));
    document.body.append(overlay);
    inp.focus(); inp.select();
  });
}

/** In-page confirmation (browser confirm() is blocked in some embeds). */
export function askConfirm(message: string, okLabel = 'Delete'): Promise<boolean> {
  return new Promise(res => {
    const overlay = h('div', { class: 'overlay' });
    const done = (v: boolean) => { overlay.remove(); res(v); };
    overlay.append(h('div', { class: 'dialog' },
      h('p', { style: 'white-space:pre-line' }, message),
      h('div', { class: 'row end' }, h('button', { onclick: () => done(false) }, 'Cancel'), h('button', { class: 'danger', onclick: () => done(true) }, okLabel)),
    ));
    document.body.append(overlay);
  });
}
