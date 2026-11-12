// Ukuran huruf dan tampilan Chat serta Terminal. Tersimpan per browser dan langsung berlaku.
const DEF = { chatFs: 0, chatCode: 0, chatLh: 1.5, chatW: 'normal', termFs: 13, termLh: 1, termTheme: 'kantor', termFace: 'jetbrains', chatWall: 'polos', chatBub: 'kantor', chatMe: 'hijau', chatPeek: 'none' };
/** Tampilan Chat ala WA/TikTok: wallpaper, bentuk gelembung, warna pesanmu, dan maskot pixel di atas pesanmu. */
export const CHAT_WALLS = { polos: 'Polos', titik: 'Titik', kertas: 'Kertas', doodle: 'Doodle kantor', rel: 'Rel kereta', laut: 'Laut', senja: 'Senja', malam: 'Malam', foto: 'Fotomu' };
export const CHAT_BUBS = { kantor: 'Kantor', bulat: 'Bulat', ekor: 'Berekor', kotak: 'Kotak', pixel: 'Pixel', awan: 'Awan' };
export const CHAT_ME = {
  hijau: { label: 'Hijau', bg: 'var(--accent)', ink: 'var(--accent-ink)' },
  biru: { label: 'Biru', bg: '#2F6FEB', ink: '#FFFFFF' },
  ungu: { label: 'Ungu', bg: '#7C4DFF', ink: '#FFFFFF' },
  oranye: { label: 'Oranye', bg: '#F28C28', ink: '#1D1200' },
  pink: { label: 'Pink', bg: '#E84393', ink: '#FFFFFF' },
  gelap: { label: 'Gelap', bg: '#2B2F36', ink: '#FFFFFF' },
  gradasi: { label: 'Gradasi', bg: 'linear-gradient(135deg,#7C4DFF,#E84393)', ink: '#FFFFFF' },
};
// maskot pixel buatan sendiri: tiap huruf satu piksel, '.' kosong
const SPRITES = {
  kucing: { label: 'Kucing', px: ['.k.....k.', 'kok...kok', 'koooooook', 'koeoooeok', 'kooopoook', '.kkkkkkk.'], pal: { k: '#3B2414', o: '#F4A259', e: '#1B1B1B', p: '#FF8FA3' } },
  kodok: { label: 'Kodok', px: ['.ww...ww.', 'wew...wew', 'ggggggggg', 'ggggggggg', 'grrrrrrrg', '.ggggggg.'], pal: { w: '#FFFFFF', e: '#111111', g: '#5CC85A', r: '#2F7D32' } },
  kereta: { label: 'Kereta', px: ['..rrrrr..', '.rbbbbbr.', '.rbbbbbr.', '.rrrrrrr.', '.ryrrryr.', '.rrrrrrr.', '..k...k..'], pal: { r: '#D94F3D', b: '#9AD1FF', y: '#FFD84D', k: '#333333' } },
  hantu: { label: 'Hantu', px: ['...ooooo...', '..owwwwwo..', '.owwewewwo.', '.owwwwwwwo.', '.owwwwwwwo.', '.owowowowo.', '..o.o.o.o..'], pal: { w: '#EEF2FF', e: '#3B3B58', o: '#7C83A8' } },
};
export const CHAT_PEEKS = { none: 'Tanpa', ...Object.fromEntries(Object.entries(SPRITES).map(([k, v]) => [k, v.label])) };
/** SVG data URI dari sprite; skala 3 piksel per titik. */
export function spriteUri(k) {
  const s = SPRITES[k]; if (!s) return '';
  const rects = s.px.flatMap((row, y) => [...row].map((c, x) => s.pal[c] ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${s.pal[c]}"/>` : '')).join('');
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s.px[0].length} ${s.px.length}" shape-rendering="crispEdges">${rects}</svg>`)}")`;
}
const WALL_KEY = 'kc.chat.wall';
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
  samudra: { label: 'Samudra biru', theme: { background: '#0B1D33', foreground: '#CFE6FF', cursor: '#5FD4FF', selectionBackground: '#1D3D63',
    ...ansi(['#0F2742', '#FF7A85', '#5EE3B0', '#FFD479', '#4DA8FF', '#B69CFF', '#4FE0F0', '#CFE6FF'], ['#3E5C80', '#FF9EA6', '#86F0C8', '#FFE29E', '#7DC0FF', '#CDB9FF', '#82EEF8', '#FFFFFF']) } },
  ubuntu: { label: 'Ubuntu', theme: { background: '#300A24', foreground: '#EEEEEC', cursor: '#E95420', selectionBackground: '#5E2750',
    ...ansi(['#2E3436', '#CC0000', '#4E9A06', '#C4A000', '#3465A4', '#75507B', '#06989A', '#D3D7CF'], ['#555753', '#EF2929', '#8AE234', '#FCE94F', '#729FCF', '#AD7FA8', '#34E2E2', '#EEEEEC']) } },
  nord: { label: 'Nord', theme: { background: '#2E3440', foreground: '#D8DEE9', cursor: '#88C0D0', selectionBackground: '#434C5E',
    ...ansi(['#3B4252', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#88C0D0', '#E5E9F0'], ['#4C566A', '#D08770', '#B5D19C', '#F0D9A0', '#94B4D6', '#C6A3BF', '#8FBCBB', '#ECEFF4']) } },
  gruvbox: { label: 'Gruvbox', theme: { background: '#282828', foreground: '#EBDBB2', cursor: '#FE8019', selectionBackground: '#504945',
    ...ansi(['#282828', '#CC241D', '#98971A', '#D79921', '#458588', '#B16286', '#689D6A', '#A89984'], ['#928374', '#FB4934', '#B8BB26', '#FABD2F', '#83A598', '#D3869B', '#8EC07C', '#EBDBB2']) } },
  monokai: { label: 'Monokai', theme: { background: '#272822', foreground: '#F8F8F2', cursor: '#F8F8F0', selectionBackground: '#49483E',
    ...ansi(['#272822', '#F92672', '#A6E22E', '#F4BF75', '#66D9EF', '#AE81FF', '#A1EFE4', '#F8F8F2'], ['#75715E', '#FF4F8B', '#BEF056', '#FFD596', '#8BE5F6', '#C5A3FF', '#C1F7EE', '#F9F8F5']) } },
  onedark: { label: 'One Dark', theme: { background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', selectionBackground: '#3E4451',
    ...ansi(['#282C34', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#ABB2BF'], ['#5C6370', '#EA858D', '#B0D693', '#F0D197', '#7FC1F5', '#D493E8', '#74C8D3', '#FFFFFF']) } },
  tokyo: { label: 'Tokyo Night', theme: { background: '#1A1B26', foreground: '#C0CAF5', cursor: '#C0CAF5', selectionBackground: '#33467C',
    ...ansi(['#15161E', '#F7768E', '#9ECE6A', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#A9B1D6'], ['#414868', '#FF8FA3', '#B5E08A', '#EBC28A', '#94B6FF', '#CDB2FF', '#9DDBFF', '#C0CAF5']) } },
  catppuccin: { label: 'Catppuccin', theme: { background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC', selectionBackground: '#45475A',
    ...ansi(['#45475A', '#F38BA8', '#A6E3A1', '#F9E2AF', '#89B4FA', '#F5C2E7', '#94E2D5', '#BAC2DE'], ['#585B70', '#F5A3BA', '#BCEBB8', '#FBEAC4', '#A3C4FB', '#F8D3EC', '#AEEBE0', '#A6ADC8']) } },
  github: { label: 'GitHub terang', light: true, theme: { background: '#FFFFFF', foreground: '#1F2328', cursor: '#0969DA', selectionBackground: '#CCE2FF',
    ...ansi(['#24292F', '#CF222E', '#116329', '#9A6700', '#0969DA', '#8250DF', '#1B7C83', '#6E7781'], ['#57606A', '#A40E26', '#1A7F37', '#7D4E00', '#218BFF', '#A475F9', '#3192AA', '#8C959F']) } },
  matrix: { label: 'Matrix', theme: { background: '#020A04', foreground: '#3BFF6E', cursor: '#3BFF6E', selectionBackground: '#0E3B19',
    ...ansi(['#031A09', '#3BCC5C', '#3BFF6E', '#9DFF7A', '#2FBF71', '#5BE38C', '#7CFFA8', '#A8FFBF'], ['#1C5A2B', '#5CE07A', '#6BFF92', '#C2FF9E', '#4FDB8E', '#80F0A8', '#A3FFC4', '#D4FFE0']) } },
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
  if (Object.hasOwn(CHAT_WALLS, raw.chatWall)) out.chatWall = raw.chatWall;
  if (Object.hasOwn(CHAT_BUBS, raw.chatBub)) out.chatBub = raw.chatBub;
  if (Object.hasOwn(CHAT_ME, raw.chatMe)) out.chatMe = raw.chatMe;
  if (Object.hasOwn(CHAT_PEEKS, raw.chatPeek)) out.chatPeek = raw.chatPeek;
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
  const root = document.documentElement.dataset, me = CHAT_ME[P.chatMe] || CHAT_ME.hijau;
  root.chWall = P.chatWall; root.chBub = P.chatBub; root.chPeek = P.chatPeek;
  st.setProperty('--ch-me', me.bg); st.setProperty('--ch-me-ink', me.ink);
  if (P.chatPeek !== 'none') st.setProperty('--ch-peek', spriteUri(P.chatPeek)); else st.removeProperty('--ch-peek');
  let img = null; try { img = localStorage.getItem(WALL_KEY); } catch {}
  if (img) st.setProperty('--ch-wall-img', `url("${img}")`); else st.removeProperty('--ch-wall-img');
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

function hasWallImg() { try { return !!localStorage.getItem(WALL_KEY); } catch { return false; } }
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
    <div class="vp-sub">Wallpaper</div>
    <div class="vp-walls" role="group" aria-label="Wallpaper chat">${Object.entries(CHAT_WALLS).map(([k, l]) => k === 'foto'
      ? `<label class="vp-wall${P.chatWall === k ? ' on' : ''}" data-w="foto"><input type="file" accept="image/*" id="vpWallFile" hidden><span class="vp-wall-sw">${hasWallImg() ? '' : '＋'}</span>${esc(l)}</label>`
      : `<button type="button" class="vp-wall${P.chatWall === k ? ' on' : ''}" data-w="${k}" data-vp="set" data-k="chatWall" data-v="${k}" aria-pressed="${P.chatWall === k}"><span class="vp-wall-sw"></span>${esc(l)}</button>`).join('')}</div>
    <div class="vp-sub">Gelembung</div>
    <div class="vp-bubs" role="group" aria-label="Bentuk gelembung">${Object.entries(CHAT_BUBS).map(([k, l]) => `<button type="button" class="vp-bub" data-b="${k}" data-vp="set" data-k="chatBub" data-v="${k}" aria-pressed="${P.chatBub === k}"><span class="vp-bub-ai"></span><span class="vp-bub-me"></span>${esc(l)}</button>`).join('')}</div>
    <div class="vp-row"><span>Warna pesanmu</span><span class="vp-mes" role="group" aria-label="Warna pesanmu">${Object.entries(CHAT_ME).map(([k, m]) => `<button type="button" data-vp="set" data-k="chatMe" data-v="${k}" aria-pressed="${P.chatMe === k}" title="${esc(m.label)}" aria-label="${esc(m.label)}" style="background:${m.bg}"></button>`).join('')}</span></div>
    <div class="vp-row"><span>Maskot di pesanmu</span><span class="vp-peeks" role="group" aria-label="Maskot">${Object.entries(CHAT_PEEKS).map(([k, l]) => `<button type="button" data-vp="set" data-k="chatPeek" data-v="${k}" aria-pressed="${P.chatPeek === k}" title="${esc(l)}">${k === 'none' ? '✕' : `<i style="background-image:${esc(spriteUri(k))}"></i>`}<small>${esc(l)}</small></button>`).join('')}</span></div>
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
    if (vp === 'reset' && scope !== 'terminal') { try { localStorage.removeItem(WALL_KEY); } catch {} }
    if (vp === 'reset') P = scope === 'terminal' ? { ...P, termFs: DEF.termFs, termLh: DEF.termLh, termTheme: DEF.termTheme, termFace: DEF.termFace } : scope === 'chat' ? { ...P, chatFs: DEF.chatFs, chatCode: DEF.chatCode, chatLh: DEF.chatLh, chatW: DEF.chatW, chatWall: DEF.chatWall, chatBub: DEF.chatBub, chatMe: DEF.chatMe, chatPeek: DEF.chatPeek } : { ...DEF };
    else if (vp === 'step') P = cleanPrefs({ ...P, [k]: stepPref(k, P[k], k === 'chatFs' ? shownChat() : k === 'chatCode' ? 12.5 : P[k], Number(b.dataset.d)) });
    else P = cleanPrefs({ ...P, [k]: b.dataset.v });
    save(); applyChat(); emitTerm();
    box.innerHTML = bodyHTML(scope);
  });
  // foto sendiri: diperkecil (sisi terpanjang 1600 px, JPEG) lalu disimpan di browser ini saja
  box.addEventListener('change', async e => {
    if (e.target.id !== 'vpWallFile' || !e.target.files?.[0]) return;
    try {
      const url = await shrinkImage(e.target.files[0], 1600);
      localStorage.setItem(WALL_KEY, url);
      P = cleanPrefs({ ...P, chatWall: 'foto' }); save(); applyChat();
      box.innerHTML = bodyHTML(scope);
    } catch (x) { const { toast } = await import('./util.js'); toast(x?.name === 'QuotaExceededError' ? 'Fotonya terlalu besar untuk disimpan di browser. Coba foto lain.' : 'Foto tidak bisa dibuka.', 'bad'); }
  });
}

function shrinkImage(file, max) {
  return new Promise((ok, bad) => {
    const img = new Image(), src = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src); ok(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(src); bad(new Error('gambar rusak')); };
    img.src = src;
  });
}
