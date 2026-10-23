export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (s, n = 38) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const usd = (v, d = 2) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const num = v => Number(v || 0).toLocaleString('id-ID');
export const tok = v => { v = Number(v || 0); return v >= 1e9 ? (v / 1e9).toFixed(1) + 'M' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'jt' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'rb' : String(v); };
export const hhmm = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`; };
export function ago(iso) {
  const t = Date.parse(iso); if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} hari lalu`;
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
export const dateLong = iso => new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const MODELS = { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5', fable: 'Fable 5.1' };
// Full ids ("claude-opus-5-5", "claude-opus-5-5[1m]") come from transcripts; show them like the aliases.
export const modelName = m => MODELS[m] || String(m || '').replace(/^claude-/, '').replace(/\[.*\]$/, '')
  .replace(/^([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`) || m;
export const hashStr = s => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
export const SKINS = ['#F1C9A5', '#D9A47C', '#B97E57', '#8D5A3B', '#E8B98F'];
export const HAIRS = ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A', '#C9A15A', '#3D2B4F'];
export const SWATCHES = ['#2F5D9E', '#2C8452', '#A9620F', '#7A3E9D', '#BC3B34', '#1C7379', '#55606E', '#C2417A'];
const GUEST_STYLES = ['short', 'long', 'short', 'ponytail', 'bob', 'short', 'curly', 'bun'];
/** A stable look for sessions that are not bound to a role. */
export function guestLook(key) { const h = hashStr(key), st = GUEST_STYLES[(h >> 5) % GUEST_STYLES.length]; return { color: '#9AA3AF', hair: HAIRS[h % HAIRS.length], skin: SKINS[(h >> 3) % SKINS.length], hairStyle: st, outfit: ['long', 'bun', 'ponytail', 'bob'].includes(st) && h % 2 ? 'rok' : 'kemeja' }; }

/* ---------------- avatar: 12x16 pixel grid, built from layers ---------------- */
const FEM_STYLES = ['long', 'bun', 'ponytail', 'bob', 'pigtails', 'hijab'];
export const isFem = l => FEM_STYLES.includes(l?.hairStyle) || l?.outfit === 'rok' || l?.outfit === 'dress';
export function shade(hex, f) { const n = parseInt(String(hex).slice(1, 7), 16) || 0; return '#' + [16, 8, 0].map(s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f))).toString(16).padStart(2, '0')).join(''); }
function spriteCells(r) {
  const W = 12, H = 16, g = Array.from({ length: H }, () => Array(W).fill(null));
  const P = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (j >= 0 && j < H && i >= 0 && i < W) g[j][i] = c; };
  const st = r.hairStyle || 'short', of = r.outfit || 'kemeja', acc = r.acc || '', hair = r.hair, skin = r.skin, col = r.color, dk = shade(col, .7), hj = r.hijab || '#E8EEF8';
  const fem = isFem(r), hijab = st === 'hijab', eye = '#1B1B22', white = '#F4F4F4', tie = '#C2413A', gold = '#F5C84C', shoe = '#15181E';
  const hl = shade(hair, 1.45), accent = shade(col, 1.25);
  // behind the body
  if (st === 'long') { P(1, 3, 10, 9, hair); P(0, 5, 12, 6, hair); P(1, 11, 10, 1, hair); }
  else if (st === 'bob') { P(1, 3, 10, 5, hair); P(2, 8, 1, 1, hair); P(9, 8, 1, 1, hair); }
  else if (st === 'curly') { P(3, 0, 6, 1, hair); P(1, 1, 10, 1, hair); P(0, 2, 12, 6, hair); P(1, 8, 1, 1, hair); P(10, 8, 1, 1, hair); P(2, 1, 1, 1, hl); P(6, 0, 1, 1, hl); P(9, 2, 1, 1, hl); P(1, 5, 1, 1, hl); P(10, 6, 1, 1, hl); }
  else if (st === 'ponytail') { P(9, 2, 3, 2, hair); P(10, 4, 2, 5, hair); P(10, 9, 1, 1, hair); P(9, 3, 3, 1, accent); }
  else if (st === 'pigtails') { P(0, 5, 2, 5, hair); P(10, 5, 2, 5, hair); P(0, 10, 1, 1, hair); P(11, 10, 1, 1, hair); P(0, 4, 2, 1, accent); P(10, 4, 2, 1, accent); }
  // legs
  if (of === 'dress') { P(3, 15, 2, 1, shoe); P(7, 15, 2, 1, shoe); }
  else if (of === 'rok') { P(3, 14, 2, 1, skin); P(7, 14, 2, 1, skin); P(2, 15, 3, 1, shoe); P(7, 15, 3, 1, shoe); }
  else { const pc = of === 'hoodie' ? '#3B4F78' : '#2B3242'; P(3, 13, 6, 1, pc); P(3, 14, 2, 1, pc); P(7, 14, 2, 1, pc); P(2, 15, 3, 1, shoe); P(7, 15, 3, 1, shoe); }
  // torso + arms
  P(3, 9, 6, 4, col); P(2, 9, 1, 2, col); P(9, 9, 1, 2, col); P(2, 11, 1, 1, skin); P(9, 11, 1, 1, skin);
  if (of === 'kemeja') { if (r.tie) { P(4, 9, 4, 1, white); P(5, 10, 2, 3, tie); } else P(5, 9, 2, 1, skin); }
  else if (of === 'jas') { P(5, 9, 2, 3, white); P(4, 9, 1, 3, dk); P(7, 9, 1, 3, dk); if (r.tie) P(5, 10, 2, 2, tie); P(3, 12, 6, 1, dk); P(2, 11, 1, 1, white); P(9, 11, 1, 1, white); P(2, 10, 1, 1, col); }
  else if (of === 'hoodie') { P(3, 9, 6, 1, dk); P(2, 9, 1, 1, dk); P(9, 9, 1, 1, dk); P(5, 10, 1, 2, white); P(6, 10, 1, 2, white); P(4, 12, 4, 1, dk); P(2, 10, 1, 1, dk); P(9, 10, 1, 1, dk); }
  else if (of === 'rok') { P(5, 9, 2, 1, skin); P(3, 12, 6, 1, shade(col, .55)); P(2, 13, 8, 1, shade(col, .55)); }
  else if (of === 'dress') { P(5, 9, 2, 1, skin); P(3, 12, 6, 1, dk); P(2, 13, 8, 1, col); P(1, 14, 10, 1, col); P(2, 14, 8, 1, col); P(3, 13, 1, 1, accent); P(6, 14, 1, 1, accent); P(9, 13, 1, 1, accent); }
  // head
  P(2, 3, 8, 6, skin); P(2, 8, 1, 1, null); P(9, 8, 1, 1, null);
  P(4, 5, 1, 2, eye); P(7, 5, 1, 2, eye);
  if (fem) { P(3, 5, 1, 1, eye); P(8, 5, 1, 1, eye); P(3, 7, 1, 1, '#F29C9C'); P(8, 7, 1, 1, '#F29C9C'); P(5, 8, 2, 1, '#D46A6A'); }
  else P(5, 8, 2, 1, shade(skin, .78));
  // in front: hair or scarf
  const cap = () => { P(3, 1, 6, 1, hair); P(2, 2, 8, 1, hair); };
  const bang = () => { P(2, 3, 3, 1, hair); P(7, 3, 3, 1, hair); };
  if (hijab) {
    P(3, 1, 6, 1, hj); P(2, 2, 8, 2, hj); P(2, 4, 1, 4, hj); P(9, 4, 1, 4, hj); P(2, 8, 2, 1, hj); P(8, 8, 2, 1, hj);
    P(2, 3, 8, 1, shade(hj, .88)); P(3, 4, 1, 1, shade(hj, .9)); P(8, 4, 1, 1, shade(hj, .9));
    P(2, 9, 8, 1, hj); P(3, 10, 6, 1, hj); P(4, 11, 4, 1, hj); P(2, 9, 1, 1, shade(hj, .85)); P(9, 9, 1, 1, shade(hj, .85)); P(5, 11, 2, 1, shade(hj, .88));
  } else if (st === 'short') { cap(); bang(); P(2, 4, 1, 1, hair); P(9, 4, 1, 1, hair); }
  else if (st === 'long') { cap(); P(2, 3, 5, 1, hair); P(2, 4, 1, 4, hair); P(9, 3, 1, 5, hair); P(3, 1, 2, 1, hl); P(3, 9, 1, 3, hair); P(8, 9, 1, 3, hair); }
  else if (st === 'bob') { cap(); P(2, 3, 8, 1, hair); P(2, 4, 1, 4, hair); P(9, 4, 1, 4, hair); P(4, 2, 2, 1, hl); }
  else if (st === 'curly') { P(2, 3, 2, 1, hair); P(5, 3, 2, 1, hair); P(8, 3, 2, 1, hair); P(2, 4, 1, 2, hair); P(9, 4, 1, 2, hair); }
  else if (st === 'ponytail') { cap(); P(2, 3, 5, 1, hair); P(2, 4, 1, 2, hair); P(9, 4, 1, 1, hair); P(4, 1, 2, 1, hl); }
  else if (st === 'pigtails') { cap(); P(2, 3, 8, 1, hair); P(2, 4, 1, 2, hair); P(9, 4, 1, 2, hair); P(4, 2, 2, 1, hl); }
  else if (st === 'bun') { P(4, 0, 4, 2, hair); P(5, 0, 1, 1, hl); P(2, 2, 8, 1, hair); bang(); P(2, 4, 1, 1, hair); P(9, 4, 1, 1, hair); }
  // accessories
  if (acc === 'topi' && !hijab) { P(3, 1, 6, 1, col); P(2, 2, 8, 1, col); P(1, 3, 10, 1, dk); P(5, 1, 2, 1, accent); }
  if (acc === 'anting') { P(2, 8, 1, 1, gold); P(9, 8, 1, 1, gold); }
  if (acc === 'kacamata') { const fr = '#D9A21B'; P(3, 4, 6, 1, fr); P(3, 5, 1, 2, fr); P(8, 5, 1, 2, fr); P(5, 5, 2, 1, fr); P(2, 5, 1, 1, fr); P(9, 5, 1, 1, fr); P(4, 7, 1, 1, fr); P(7, 7, 1, 1, fr); }
  return g;
}
export function sprite(r, px = 3) {
  if (!r) r = guestLook('x');
  const g = spriteCells(r);
  let out = '';
  g.forEach((row, y) => { for (let x = 0; x < row.length;) { const c = row[x]; if (!c) { x++; continue; } let n = 1; while (row[x + n] === c) n++; out += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${c}"/>`; x += n; } });
  return `<svg viewBox="0 0 12 16" width="${12 * px}" height="${16 * px}" shape-rendering="crispEdges" aria-hidden="true">${out}</svg>`;
}
export const mini = r => `<span class="mini">${sprite(r, 2)}</span>`;
export const ICON = {
  chat: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 2h10v6H5l-3 2V8H1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  file: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1h5l2 2v8h-7z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  clock: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.5V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
};

/* ---------------- api + live events ---------------- */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch {}
  // akun mode: the session ended (signed out elsewhere, disabled, expired)
  if (res.status === 401 && /^Belum masuk/.test(data?.error || '')) { location.href = '/masuk'; }
  if (!res.ok) throw new Error(data?.error || `Gagal (${res.status})`);
  return data;
}
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = p => api(p, { method: 'DELETE' });

const listeners = new Set();
export const onLive = fn => { listeners.add(fn); return () => listeners.delete(fn); };
let ws = null, retry = 0;
export function connectLive() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const conn = $('#conn');
  ws.onopen = () => { retry = 0; conn.textContent = 'tersambung'; conn.title = 'Tersambung ke daemon'; conn.className = 'conn ok'; listeners.forEach(f => f({ t: 'reconnected' })); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } listeners.forEach(f => { try { f(m); } catch (err) { console.error(err); } }); };
  ws.onclose = () => { conn.textContent = 'terputus, menyambung lagi…'; conn.title = 'Terputus dari daemon, menyambung lagi…'; conn.className = 'conn bad'; setTimeout(connectLive, Math.min(10000, 500 * 2 ** retry++)); };
}

/* ---------------- toast + modal ---------------- */
export function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}
let modalActions = [];
export function modal({ title, body = '', html = '', actions = [{ label: 'Tutup' }] }) {
  modalActions = actions;
  $('#modalCard').innerHTML = `<h2>${esc(title)}</h2>${body ? `<p>${body}</p>` : ''}${html}<div class="btn-row">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-modal="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  $('#modal').hidden = false;
  ($('#modalCard input, #modalCard textarea, #modalCard select') || $('#modalCard button')).focus();
}
export function closeModal() { $('#modal').hidden = true; }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-modal]');
  if (b) { const a = modalActions[Number(b.dataset.modal)]; const keep = a?.fn ? a.fn() === false : false; if (!keep) closeModal(); return; }
  if (e.target.id === 'modal') closeModal();
});
export function confirmDo(title, body, label, fn, kind = 'danger') {
  modal({ title, body, actions: [{ label, kind, fn }, { label: 'Batal' }] });
}

/* ---------------- markdown ---------------- */
const FILE_ICON = { pdf: '📕', zip: '🗜️', gz: '🗜️', rar: '🗜️', '7z': '🗜️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', mp4: '🎞️', mov: '🎞️', webm: '🎞️', mp3: '🎵', wav: '🎵', m4a: '🎵', xls: '📊', xlsx: '📊', csv: '📊', doc: '📝', docx: '📝', txt: '📝', ppt: '📽️', pptx: '📽️', json: '🧾', md: '📝' };
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_URL = /\.(?:mp4|webm|mov|m4v)(?:[?#][^\s]*)?$/i;
// video player; `u` is already HTML-escaped. Own media gets a small download link, the player itself never autoplays
const videoHtml = (u, alt, file) => `<figure class="md-video"><video controls preload="metadata" playsinline src="${u}" aria-label="${alt || 'Video'}"></video><figcaption><span>${alt || file || 'Video'}</span><a href="${u}${u.includes('?') ? '&' : '?'}dl=1" download>Unduh</a></figcaption></figure>`;
// PDF and text documents (.md/.markdown/.txt) from the office's own media become preview cards; web/js/docs.js fills them in and opens the viewer.
const PDF_URL = /^\/api\/[^\s]*\.pdf(?:[?#][^\s]*)?$/i;
const DOC_URL = /^\/api\/[^\s]*\.(?:md|markdown|txt)(?:[?#][^\s]*)?$/i;
const DOC_EXT = new Set(['md', 'markdown', 'txt']);
const pdfHtml = (u, name) => `<figure class="md-pdf" data-src="${u}" data-name="${name}"><button type="button" class="pdf-open" data-pdf="${u}" aria-label="Buka PDF ${name}"><span class="pdf-thumb"><span class="pdf-ph" aria-hidden="true">📕</span></span><span class="pdf-info"><b>${name}</b><small>PDF</small></span></button><a class="pdf-dl" href="${u}${u.includes('?') ? '&' : '?'}dl=1" download>Unduh</a></figure>`;
const docHtml = (u, name) => `<figure class="md-doc" data-src="${u}" data-name="${name}"><button type="button" class="doc-open" data-doc="${u}" aria-label="Buka dokumen ${name}"><span class="doc-info"><b>${name}</b><small>Dokumen</small></span><span class="doc-snip"></span></button></figure>`;
const YT = /^\s*(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?(?:[^\s&]*&)*v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})(?:[&?#][^\s]*)?\s*$/;
// Small, safe renderer: escapes everything first, then adds markup.
export function md(src, { wiki = () => null, roles = [], cardIds = new Set(), taskIndex = true } = {}) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let out = '', inList = null, inCode = false, code = [], para = [], task = 0;
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (inList) { out += `</${inList}>`; inList = null; } };
  const inline = s => {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // images and uploaded-file chips are stashed so later passes cannot touch their attributes
    const keep = [], put = x => `\u0001${keep.push(x) - 1}\u0002`;
    h = h.replace(/!\[([^\]]*)\]\(((?:\/api\/|https:\/\/)[^)\s]+)\)/g, (_, alt, u) => put(PDF_URL.test(u) ? pdfHtml(u, alt || 'PDF') : DOC_URL.test(u) ? docHtml(u, alt || 'Dokumen') : VIDEO_URL.test(u) ? videoHtml(u, alt) : `<img class="md-img" src="${u}" alt="${alt}" loading="lazy" decoding="async">`));
    h = h.replace(/\[([^\]]+)\]\((\/api\/[^)\s]+)\)/g, (_, t, u) => { const n = t.replace(/^\s*📎\s*/, ''), ext = (/\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(n) || [])[1]?.toLowerCase(); if (VIDEO_EXT.has(ext)) return put(videoHtml(u, n.replace(/\.[a-z0-9]+$/i, ''), n)); if (ext === 'pdf') return put(pdfHtml(u, n)); if (DOC_EXT.has(ext)) return put(docHtml(u, n)); return put(`<a class="file-chip" href="${u}" target="_blank" rel="noreferrer"><span class="fc-i" aria-hidden="true">${FILE_ICON[ext] || '📎'}</span><span class="fc-n">${n}</span></a>`); });
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, label) => { const w = wiki(t.trim()); return `<a class="wl${w ? '' : ' missing'}" href="#" data-wiki="${esc(t.trim())}">${label || t}</a>`; });
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    h = h.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    if (roles.length) h = h.replace(/(^|\s)@([A-Za-z][\w-]*)/g, (m, sp, n) => { const r = roles.find(x => x.id.toLowerCase() === n.toLowerCase() || x.name.toLowerCase().replace(/\s+/g, '') === n.toLowerCase()); return r ? `${sp}<span class="mention" data-role="${esc(r.id)}">@${esc(r.name)}</span>` : m; });
    h = h.replace(/(^|\s)#(k[0-9a-f]{5,8})\b/g, (m, sp, id) => cardIds.has(id) ? `${sp}<a href="#" data-card="${id}">#${id}</a>` : m);
    return keep.length ? h.replace(/\u0001(\d+)\u0002/g, (_, i) => keep[i]) : h;
  };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) { if (inCode) { out += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = []; inCode = false; } else { flushPara(); closeList(); inCode = true; } continue; }
    if (inCode) { code.push(line); continue; }
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); closeList(); const n = m[1].length; out += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); closeList(); out += '<hr>'; continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); closeList(); out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (/^\|.*\|\s*$/.test(line)) {
      flushPara(); closeList();
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().slice(1, -1).split('|').map(c => inline(c.trim()));
      if (!out.endsWith('</tr>') || !out.includes('<table>')) out += '<table>';
      out += `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
      continue;
    } else if (out.endsWith('</tr>')) out += '</table>';
    if ((m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) {
      flushPara(); if (inList !== 'ul') { closeList(); out += '<ul>'; inList = 'ul'; }
      out += `<li class="task"><input type="checkbox" ${m[1] !== ' ' ? 'checked' : ''} ${taskIndex ? `data-task="${task}"` : 'disabled'}> ${inline(m[2])}</li>`; task++; continue;
    }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flushPara(); if (inList !== 'ul') { closeList(); out += '<ul>'; inList = 'ul'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (inList !== 'ol') { closeList(); out += '<ol>'; inList = 'ol'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = YT.exec(line))) { flushPara(); closeList(); out += `<figure class="md-video yt"><iframe src="https://www.youtube-nocookie.com/embed/${m[1]}" title="YouTube" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></figure>`; continue; }
    if (/^\s*(?:!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\(\/api\/[^)\s]+\))\s*$/.test(line)) { const h = inline(line.trim()); if (/^<figure class="md-(?:video|pdf|doc)"/.test(h)) { flushPara(); closeList(); out += h; continue; } }
    closeList();
    para.push(line.trim());
  }
  if (inCode) out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  flushPara(); closeList();
  if (out.endsWith('</tr>')) out += '</table>';
  return `<div class="md">${out}</div>`;
}
/** Toggle the n-th "- [ ]" task in a markdown string. */
export function toggleTask(src, n) {
  let i = -1;
  return src.replace(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)/gm, (m, a, b, c) => (++i === n ? a + (b === ' ' ? 'x' : ' ') + c : m));
}

/* simple line diff (LCS) for wiki revisions */
export function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 4e6) return `<span class="del">(terlalu besar untuk dibandingkan)</span>`;
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = '';
  while (i < n && j < m) {
    if (A[i] === B[j]) { out += esc(A[i]) + '\n'; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out += `<span class="del">- ${esc(A[i])}</span>`; i++; }
    else { out += `<span class="add">+ ${esc(B[j])}</span>`; j++; }
  }
  while (i < n) out += `<span class="del">- ${esc(A[i++])}</span>`;
  while (j < m) out += `<span class="add">+ ${esc(B[j++])}</span>`;
  return out;
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------- terminal renderer ---------------- */
// xterm's GPU renderer caches glyph bitmaps per pixel density. When the scale changes under it (browser zoom, a phone
// or DevTools device mode) the glyphs come out several times too big and lines are cut off, while the cell grid stays
// right. Phones and narrow windows get the plain DOM renderer; elsewhere the glyph cache is rebuilt on every scale change.
const GPU_TERMS = new Set();
export function attachTermRenderer(term) {
  if (!window.WebglAddon || matchMedia('(max-width: 900px), (pointer: coarse)').matches) return null;
  try {
    const gl = new window.WebglAddon.WebglAddon();
    gl.onContextLoss(() => { GPU_TERMS.delete(entry); gl.dispose(); term.refresh(0, term.rows - 1); });
    term.loadAddon(gl);
    const entry = { term, gl };
    GPU_TERMS.add(entry);
    const dispose = term.dispose.bind(term);
    term.dispose = () => { GPU_TERMS.delete(entry); dispose(); };
    return gl;
  } catch { return null; }
}
function watchScale() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    for (const { term, gl } of GPU_TERMS) try { gl.clearTextureAtlas(); term.refresh(0, term.rows - 1); } catch {}
    watchScale();
  }, { once: true });
}
watchScale();

/* ---------------- tema: terang / gelap / sistem ---------------- */
const THEME_KEY = 'kantor.theme';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const THEME_ICON = {
  light: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a.7.7 0 0 0-.9-.9A9.8 9.8 0 1 0 21.4 15.5a.7.7 0 0 0-.9-.9z"/></svg>',
};
const THEME_LABEL = { system: 'ikut sistem', light: 'terang', dark: 'gelap' };
/** Pilihan tersimpan: 'light' | 'dark' | 'system'. */
export function getTheme() { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } }
/** Tema yang benar-benar tampil: 'light' | 'dark'. */
export const effectiveTheme = () => { const t = getTheme(); return t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t; };
export function setTheme(mode) {
  if (mode !== 'light' && mode !== 'dark') mode = 'system';
  try { mode === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, mode); } catch {}
  applyTheme();
}
function applyTheme() {
  const t = getTheme(), eff = effectiveTheme(), root = document.documentElement;
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  const meta = document.getElementById('metaTheme'); if (meta) meta.content = eff === 'dark' ? '#131F24' : '#FFFFFF';
  const b = document.getElementById('themeBtn');
  if (b) { b.innerHTML = THEME_ICON[eff] + (t === 'system' ? '<i class="theme-auto" aria-hidden="true">A</i>' : ''); b.title = `Tema: ${THEME_LABEL[t]} (klik untuk ganti)`; b.setAttribute('aria-label', `Ganti tema, sekarang ${THEME_LABEL[t]}`); }
  document.querySelectorAll('[data-theme-set]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.themeSet === t)));
  window.dispatchEvent(new CustomEvent('kantor-theme', { detail: { mode: t, theme: eff } }));
}
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' };
document.addEventListener('click', e => {
  const set = e.target.closest?.('[data-theme-set]');
  if (set) { setTheme(set.dataset.themeSet); return; }
  if (e.target.closest?.('#themeBtn')) setTheme(NEXT_THEME[getTheme()]);
});
darkQuery.addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme(); });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyTheme); else applyTheme();

/* ---------------- deretan tab header: fade tepi saat bisa digeser ---------------- */
function tabFade(bar) {
  const max = bar.scrollWidth - bar.clientWidth, x = bar.scrollLeft;
  bar.style.setProperty('--fl', max > 1 && x > 2 ? 0 : 1);
  bar.style.setProperty('--fr', max > 1 && x < max - 2 ? 0 : 1);
}
function watchTabs() {
  const bar = document.querySelector('.top-tabs'); if (!bar) return;
  if (!bar._fade) { bar._fade = true; bar.addEventListener('scroll', () => tabFade(bar), { passive: true }); }
  tabFade(bar); requestAnimationFrame(() => tabFade(bar)); setTimeout(() => tabFade(bar), 120);
}
addEventListener('resize', watchTabs);
const crumbsEl = () => document.getElementById('crumbs');
function observeCrumbs() { const c = crumbsEl(); if (!c) return false; new MutationObserver(watchTabs).observe(c, { childList: true }); watchTabs(); return true; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeCrumbs); else observeCrumbs();
