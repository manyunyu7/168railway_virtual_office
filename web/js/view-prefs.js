// Ukuran huruf dan tampilan Chat serta Terminal. Tersimpan per browser dan langsung berlaku.
const DEF = { chatFs: 0, chatCode: 0, chatLh: 1.5, chatW: 'normal', termFs: 13, termLh: 1, termTheme: 'kantor', termFace: 'jetbrains' };
/** Font terminal. `gf`: keluarga Google Fonts yang dimuat saat dipilih (JetBrains Mono sudah dimuat index.html). */
export const TERM_FACES = {
  jetbrains: { label: 'JetBrains Mono', family: 'JetBrains Mono' },
  ubuntu: { label: 'Ubuntu Mono', family: 'Ubuntu Mono', gf: 'Ubuntu+Mono:wght@400;700' },
  fira: { label: 'Fira Code', family: 'Fira Code', gf: 'Fira+Code:wght@400;600' },
  source: { label: 'Source Code Pro', family: 'Source Code Pro', gf: 'Source+Code+Pro:wght@400;600' },
  plex: { label: 'IBM Plex Mono', family: 'IBM Plex Mono', gf: 'IBM+Plex+Mono:wght@400;600' },
  roboto: { label: 'Roboto Mono', family: 'Roboto Mono', gf: 'Roboto+Mono:wght@400;600' },
};
const faceCss = k => `"${(TERM_FACES[k] || TERM_FACES.jetbrains).family}", ui-monospace, Menlo, monospace`;
/** Preset warna terminal: latar, teks, kursor, dan 16 warna ANSI (dipakai Claude Code untuk diff dan sorotan kode). */
const ansi = (c, b) => ({ black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: b[0], brightRed: b[1], brightGreen: b[2], brightYellow: b[3], brightBlue: b[4], brightMagenta: b[5], brightCyan: b[6], brightWhite: b[7] });
export const TERM_THEMES = {
  kantor: { label: 'Kantor gelap', theme: { background: '#0E1218', foreground: '#D4DAE3', cursor: '#E4A445', selectionBackground: '#2A3445',
    ...ansi(['#1B2130', '#F26D6D', '#7DDB3A', '#E4A445', '#5AA9F0', '#C792EA', '#4FD1C5', '#D4DAE3'], ['#5C6773', '#FF8A8A', '#A3F06B', '#FFC66B', '#82C4FF', '#DDB3FF', '#7DEAE0', '#FFFFFF']) } },
  kertas: { label: 'Kertas terang', light: true, theme: { background: '#FBF8F1', foreground: '#2B2A26', cursor: '#B96F00', selectionBackground: '#E7DCC4',
    ...ansi(['#2B2A26', '#C0392B', '#3B8700', '#A06A00', '#1F5FBF', '#8E3FA8', '#127A7A', '#E6E1D6'], ['#6B675E', '#E04A3A', '#4FA30F', '#B97F00', '#2F74D9', '#A653C4', '#1A9494', '#FFFFFF']) } },
  dracula: { label: 'Dracula', theme: { background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', selectionBackground: '#44475A',
    ...ansi(['#21222C', '#FF5555', '#50FA7B', '#F1FA8C', '#BD93F9', '#FF79C6', '#8BE9FD', '#F8F8F2'], ['#6272A4', '#FF6E6E', '#69FF94', '#FFFFA5', '#D6ACFF', '#FF92DF', '#A4FFFF', '#FFFFFF']) } },
  solarized: { label: 'Solarized', theme: { background: '#002B36', foreground: '#93A1A1', cursor: '#B58900', selectionBackground: '#0A4555',
    ...ansi(['#073642', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#EEE8D5'], ['#586E75', '#CB4B16', '#9FB300', '#D4A017', '#4FA3E0', '#6C71C4', '#3CC2B5', '#FDF6E3']) } },
  kontras: { label: 'Kontras tinggi', theme: { background: '#000000', foreground: '#FFFFFF', cursor: '#FFD400', selectionBackground: '#4A4A4A',
    ...ansi(['#000000', '#FF4D4D', '#4DFF4D', '#FFE600', '#4DA6FF', '#FF66FF', '#33FFFF', '#FFFFFF'], ['#7F7F7F', '#FF8080', '#99FF99', '#FFF280', '#99CCFF', '#FF99FF', '#99FFFF', '#FFFFFF']) } },
};
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
  if (Object.hasOwn(TERM_THEMES, raw.termTheme)) out.termTheme = raw.termTheme;
  if (Object.hasOwn(TERM_FACES, raw.termFace)) out.termFace = raw.termFace;
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
  st.setProperty('--term-bg', termView().theme.background); // bingkai di sekitar terminal ikut warna latarnya
}
const termView = () => ({ fs: P.termFs, lh: P.termLh, theme: (TERM_THEMES[P.termTheme] || TERM_THEMES.kantor).theme, name: P.termTheme, face: faceCss(P.termFace) });
/** Muat font Google sekali; setelah siap terminal diukur ulang (xterm mengukur sel dari font yang sudah ada). */
const loaded = new Set(['jetbrains']);
function ensureFace(k) {
  const f = TERM_FACES[k]; if (!f?.gf || loaded.has(k) || typeof document === 'undefined') return;
  loaded.add(k);
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${f.gf}&display=swap`;
  document.head.appendChild(l);
  l.onload = () => document.fonts?.load(`13px "${f.family}"`).then(() => { if (P.termFace === k) emitTerm(); }).catch(() => {});
}
const emitTerm = () => { ensureFace(P.termFace); for (const f of subs) f(termView()); };
export const termPrefs = termView;
export const onTermPrefs = fn => { subs.add(fn); return () => subs.delete(fn); };
export function setTermPref(k, v) {
  P = cleanPrefs({ ...P, [k === 'fs' ? 'termFs' : 'termLh']: k === 'fs' ? Math.min(24, Math.max(9, v)) : v });
  save(); emitTerm();
}
applyChat();
ensureFace(P.termFace);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// nilai yang sedang terlihat bila pemilik belum mengatur ukuran sendiri
const shownChat = () => matchMedia('(max-width: 900px)').matches ? 15 : 14.5;
const stepper = (k, label, value) => `<div class="vp-row"><span>${esc(label)}</span><span class="vp-step"><button type="button" data-vp="step" data-k="${k}" data-d="-1" aria-label="Perkecil ${esc(label)}">−</button><b>${esc(value)}</b><button type="button" data-vp="step" data-k="${k}" data-d="1" aria-label="Perbesar ${esc(label)}">+</button></span></div>`;
const seg = (k, label, opts) => `<div class="vp-row"><span>${esc(label)}</span><span class="vp-seg" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" data-vp="set" data-k="${k}" data-v="${esc(v)}" aria-pressed="${String(P[k]) === String(v)}">${esc(l)}</button>`).join('')}</span></div>`;
/** `scope`: 'chat' atau 'terminal' hanya menampilkan bagian tab yang sedang dibuka; kosong = keduanya. */
function bodyHTML(scope) {
  const chat = `<h3 class="vp-h">Chat</h3>
    ${stepper('chatFs', 'Ukuran teks', P.chatFs || 'Bawaan')}
    ${stepper('chatCode', 'Ukuran kode', P.chatCode || 'Bawaan')}
    ${seg('chatLh', 'Jarak baris', [[1.35, 'Rapat'], [1.5, 'Biasa'], [1.7, 'Longgar']])}
    <div class="vp-wide">${seg('chatW', 'Lebar percakapan', [['normal', 'Biasa'], ['lebar', 'Lebar'], ['penuh', 'Penuh']])}</div>
`;
  const term = `<h3 class="vp-h">Terminal</h3>
    ${stepper('termFs', 'Ukuran huruf', P.termFs)}
    ${seg('termLh', 'Jarak baris', [[1, 'Rapat'], [1.15, 'Biasa'], [1.3, 'Longgar']])}
    <div class="vp-faces" role="group" aria-label="Font terminal">${Object.entries(TERM_FACES).map(([k, f]) => `<button type="button" class="vp-face" data-vp="set" data-k="termFace" data-v="${k}" aria-pressed="${P.termFace === k}"><span style="font-family:${esc(faceCss(k))}">Aa 0O il1 {}</span>${esc(f.label)}</button>`).join('')}</div>
    <div class="vp-themes" role="group" aria-label="Tema warna terminal">${Object.entries(TERM_THEMES).map(([k, t]) => `<button type="button" class="vp-th" data-vp="set" data-k="termTheme" data-v="${k}" aria-pressed="${P.termTheme === k}" style="--bg:${t.theme.background};--fg:${t.theme.foreground}"><span class="vp-th-sw"><i style="background:${t.theme.green}"></i><i style="background:${t.theme.red}"></i><i style="background:${t.theme.yellow}"></i><i style="background:${t.theme.blue}"></i><code>$ ok</code></span>${esc(t.label)}</button>`).join('')}</div>
    ${TERM_THEMES[P.termTheme]?.light ? '<p class="vp-note">Tema terang: ketik <code>/theme</code> di sesi Claude lalu pilih tema light supaya teks Claude Code tetap terbaca.</p>' : ''}
`;
  return `${scope === 'terminal' ? '' : chat}${scope === 'chat' ? '' : term}
    <button type="button" class="btn sm vp-reset" data-vp="reset">Kembalikan ke bawaan</button>`;
}
/** Dialog pengaturan; perubahan langsung terlihat di belakangnya. */
export async function openViewPrefs(scope = '') {
  const { modal, $ } = await import('./util.js');
  if (!document.getElementById('vpCss')) {
    const l = document.createElement('link');
    l.id = 'vpCss'; l.rel = 'stylesheet'; l.href = new URL('../css/view-prefs.css', import.meta.url).href;
    document.head.appendChild(l);
  }
  if (scope !== 'chat') for (const k of Object.keys(TERM_FACES)) ensureFace(k); // contoh di tombol pakai fontnya sendiri
  modal({ title: scope === 'terminal' ? 'Tampilan terminal' : scope === 'chat' ? 'Tampilan chat' : 'Ukuran huruf & tampilan', html: `<div class="vp" id="vpBox">${bodyHTML(scope)}</div>`, actions: [{ label: 'Selesai', kind: 'primary' }] });
  const box = $('#vpBox'); if (!box) return;
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-vp]'); if (!b) return;
    const { vp, k } = b.dataset;
    if (vp === 'reset') P = scope === 'terminal' ? { ...P, termFs: DEF.termFs, termLh: DEF.termLh, termTheme: DEF.termTheme, termFace: DEF.termFace } : scope === 'chat' ? { ...P, chatFs: DEF.chatFs, chatCode: DEF.chatCode, chatLh: DEF.chatLh, chatW: DEF.chatW } : { ...DEF };
    else if (vp === 'step') P = cleanPrefs({ ...P, [k]: stepPref(k, P[k], k === 'chatFs' ? shownChat() : k === 'chatCode' ? 12.5 : P[k], Number(b.dataset.d)) });
    else P = cleanPrefs({ ...P, [k]: b.dataset.v });
    save(); applyChat(); emitTerm();
    box.innerHTML = bodyHTML(scope);
  });
}
