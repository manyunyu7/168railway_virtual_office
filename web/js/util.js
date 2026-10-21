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
export const modelName = m => MODELS[m] || m;
export const hashStr = s => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
export const SKINS = ['#F1C9A5', '#D9A47C', '#B97E57', '#8D5A3B', '#E8B98F'];
export const HAIRS = ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A', '#C9A15A', '#3D2B4F'];
export const SWATCHES = ['#2F5D9E', '#2C8452', '#A9620F', '#7A3E9D', '#BC3B34', '#1C7379', '#55606E', '#C2417A'];
/** A stable look for sessions that are not bound to a role. */
export function guestLook(key) { const h = hashStr(key); return { color: '#9AA3AF', hair: HAIRS[h % HAIRS.length], skin: SKINS[(h >> 3) % SKINS.length], hairStyle: h % 3 ? 'short' : 'long' }; }

const SPR = ['..hhhh..', '.hhhhhh.', '.hssssh.', '.sesses.', '.ssssss.', '..ssss..', '.cccccc.', 'cccTcccc', 'sccTcccs', 's.cccc.s', '..pppp..', '..p..p..', '..k..k..'];
export function sprite(r, px = 3) {
  if (!r) r = guestLook('x');
  const m = { h: r.hair, s: r.skin, e: '#1B1B22', c: r.color, T: r.tie ? '#C2413A' : r.color, p: '#2B3242', k: '#15181E' };
  let out = '';
  SPR.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${m[ch]}"/>`; }));
  return `<svg viewBox="0 0 8 13" width="${8 * px}" height="${13 * px}" shape-rendering="crispEdges" aria-hidden="true">${out}</svg>`;
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
// Small, safe renderer: escapes everything first, then adds markup.
export function md(src, { wiki = () => null, roles = [], cardIds = new Set(), taskIndex = true } = {}) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let out = '', inList = null, inCode = false, code = [], para = [], task = 0;
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (inList) { out += `</${inList}>`; inList = null; } };
  const inline = s => {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, label) => { const w = wiki(t.trim()); return `<a class="wl${w ? '' : ' missing'}" href="#" data-wiki="${esc(t.trim())}">${label || t}</a>`; });
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    h = h.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    if (roles.length) h = h.replace(/(^|\s)@([A-Za-z][\w-]*)/g, (m, sp, n) => { const r = roles.find(x => x.id.toLowerCase() === n.toLowerCase() || x.name.toLowerCase().replace(/\s+/g, '') === n.toLowerCase()); return r ? `${sp}<span class="mention" data-role="${esc(r.id)}">@${esc(r.name)}</span>` : m; });
    h = h.replace(/(^|\s)#(k[0-9a-f]{5,8})\b/g, (m, sp, id) => cardIds.has(id) ? `${sp}<a href="#" data-card="${id}">#${id}</a>` : m);
    return h;
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
