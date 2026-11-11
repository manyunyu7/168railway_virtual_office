// Ukuran huruf dan tampilan Chat serta Terminal. Tersimpan per browser dan langsung berlaku.
const DEF = { chatFs: 0, chatCode: 0, chatLh: 1.5, chatW: 'normal', termFs: 13, termLh: 1 };
const RANGE = { chatFs: [12, 22, 0.5], chatCode: [10, 18, 0.5], termFs: [9, 24, 1] };
const LH = { chatLh: [1.35, 1.5, 1.7], termLh: [1, 1.15, 1.3] };
const WIDTHS = { normal: { col: 820, bub: 640 }, lebar: { col: 1100, bub: 900 }, penuh: { col: 4000, bub: 4000 } };
const KEY = 'kc.view', TERM_KEY = 'kc.term.fs'; // kc.term.fs: kunci lama ukuran terminal, tetap dipakai

/** Isi yang tidak dikenal atau di luar rentang kembali ke bawaan; 0 = ikuti bawaan CSS (beda untuk HP dan desktop). */
export function cleanPrefs(raw = {}) {
  const out = { ...DEF };
  for (const k of Object.keys(RANGE)) { const n = Number(raw[k]), [lo, hi] = RANGE[k]; if (n >= lo && n <= hi) out[k] = n; }
  for (const k of Object.keys(LH)) if (LH[k].includes(Number(raw[k]))) out[k] = Number(raw[k]);
  if (WIDTHS[raw.chatW]) out.chatW = raw.chatW;
  return out;
}
/** Variabel CSS untuk Chat; ukuran yang belum diatur tidak diisi supaya bawaan CSS tetap berlaku. */
export function chatVars(p) {
  const w = WIDTHS[p.chatW] || WIDTHS.normal;
  return { '--ch-fs': p.chatFs ? `${p.chatFs}px` : '', '--ch-code': p.chatCode ? `${p.chatCode}px` : '', '--ch-lh': p.chatLh === DEF.chatLh ? '' : String(p.chatLh),
    '--ch-col': p.chatW === 'normal' ? '' : `${w.col}px`, '--ch-bub': p.chatW === 'normal' ? '' : `${w.bub}px` };
}
/** Satu langkah −/+; dari "bawaan" mulai dari nilai yang terlihat sekarang. */
export function stepPref(k, cur, seen, dir) {
  const [lo, hi, st] = RANGE[k];
  return Math.min(hi, Math.max(lo, (cur || seen) + dir * st));
}

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; const fs = localStorage.getItem(TERM_KEY); if (fs && raw.termFs == null) raw.termFs = fs; } catch {}
  return cleanPrefs(raw);
}
let P = typeof localStorage === 'undefined' ? { ...DEF } : load();
const subs = new Set();
function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); localStorage.setItem(TERM_KEY, String(P.termFs)); } catch {} }
function applyChat() {
  if (typeof document === 'undefined') return;
  const st = document.documentElement.style;
  for (const [k, v] of Object.entries(chatVars(P))) { if (v) st.setProperty(k, v); else st.removeProperty(k); }
}
const termView = () => ({ fs: P.termFs, lh: P.termLh });
const emitTerm = () => { for (const f of subs) f(termView()); };
export const termPrefs = termView;
export const onTermPrefs = fn => { subs.add(fn); return () => subs.delete(fn); };
export function setTermPref(k, v) {
  P = cleanPrefs({ ...P, [k === 'fs' ? 'termFs' : 'termLh']: k === 'fs' ? Math.min(24, Math.max(9, v)) : v });
  save(); emitTerm();
}
applyChat();

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// nilai yang sedang terlihat bila pemilik belum mengatur ukuran sendiri
const shownChat = () => matchMedia('(max-width: 900px)').matches ? 15 : 14.5;
const stepper = (k, label, value) => `<div class="vp-row"><span>${esc(label)}</span><span class="vp-step"><button type="button" data-vp="step" data-k="${k}" data-d="-1" aria-label="Perkecil ${esc(label)}">−</button><b>${esc(value)}</b><button type="button" data-vp="step" data-k="${k}" data-d="1" aria-label="Perbesar ${esc(label)}">+</button></span></div>`;
const seg = (k, label, opts) => `<div class="vp-row"><span>${esc(label)}</span><span class="vp-seg" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" data-vp="set" data-k="${k}" data-v="${esc(v)}" aria-pressed="${String(P[k]) === String(v)}">${esc(l)}</button>`).join('')}</span></div>`;
function bodyHTML() {
  return `<h3 class="vp-h">Chat</h3>
    ${stepper('chatFs', 'Ukuran teks', P.chatFs || 'Bawaan')}
    ${stepper('chatCode', 'Ukuran kode', P.chatCode || 'Bawaan')}
    ${seg('chatLh', 'Jarak baris', [[1.35, 'Rapat'], [1.5, 'Biasa'], [1.7, 'Longgar']])}
    <div class="vp-wide">${seg('chatW', 'Lebar percakapan', [['normal', 'Biasa'], ['lebar', 'Lebar'], ['penuh', 'Penuh']])}</div>
    <h3 class="vp-h">Terminal</h3>
    ${stepper('termFs', 'Ukuran huruf', P.termFs)}
    ${seg('termLh', 'Jarak baris', [[1, 'Rapat'], [1.15, 'Biasa'], [1.3, 'Longgar']])}
    <button type="button" class="btn sm vp-reset" data-vp="reset">Kembalikan ke bawaan</button>`;
}
/** Dialog pengaturan; perubahan langsung terlihat di belakangnya. */
export async function openViewPrefs() {
  const { modal, $ } = await import('./util.js');
  if (!document.getElementById('vpCss')) {
    const l = document.createElement('link');
    l.id = 'vpCss'; l.rel = 'stylesheet'; l.href = new URL('../css/view-prefs.css', import.meta.url).href;
    document.head.appendChild(l);
  }
  modal({ title: 'Ukuran huruf & tampilan', html: `<div class="vp" id="vpBox">${bodyHTML()}</div>`, actions: [{ label: 'Selesai', kind: 'primary' }] });
  const box = $('#vpBox'); if (!box) return;
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-vp]'); if (!b) return;
    const { vp, k } = b.dataset;
    if (vp === 'reset') P = { ...DEF };
    else if (vp === 'step') P = cleanPrefs({ ...P, [k]: stepPref(k, P[k], k === 'chatFs' ? shownChat() : k === 'chatCode' ? 12.5 : P[k], Number(b.dataset.d)) });
    else P = cleanPrefs({ ...P, [k]: b.dataset.v });
    save(); applyChat(); emitTerm();
    box.innerHTML = bodyHTML();
  });
}
