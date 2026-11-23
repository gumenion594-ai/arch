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
