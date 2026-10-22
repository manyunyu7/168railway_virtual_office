// Layar: panel melayang untuk file/folder/URL yang dibukakan agen (tool MCP `tunjukkan`).
// Agen hanya memanggil ini kalau kamu minta; kamu dapat notifikasi, lalu membukanya sendiri.
import { $, esc, short, api, post, toast, ago, md } from './util.js';

const LS = 'kc.viewer';
const MIN_W = 360, MIN_H = 240;
const V = {
  ctx: null, items: new Map(),          // id -> item (yang masih terbuka + yang pernah dilihat)
  history: null, showHistory: false,    // daftar riwayat (semua) kalau toggle aktif
  tabs: [], active: null, views: new Map(),
  open: false, min: false, max: false, geo: null,
  opener: null, listOpen: false, ready: false,
};

const size = n => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const narrow = () => matchMedia('(max-width:699px)').matches;
const enc = p => String(p).split('/').map(encodeURIComponent).join('/');
const norm = p => String(p || '').replace(/^\.?\/+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
const officeOf = id => V.ctx?.st?.offices?.find(o => o.id === id);
const officeName = id => officeOf(id)?.name || id;
const apiUrl = (office, p, q = {}) => `/api/offices/${encodeURIComponent(office)}/files${p}?${new URLSearchParams(q)}`;
const kindIcon = k => k === 'folder' ? '▸' : k === 'url' ? '↗' : '≡';
const fileIcon = e => e.dir ? '▸' : /\.(png|jpe?g|gif|webp|svg)$/i.test(e.name) ? '▣' : /\.pdf$/i.test(e.name) ? '▤' : /\.(md|txt)$/i.test(e.name) ? '≡' : '·';
const label = it => it.kind === 'url' ? it.target : (norm(it.target) || officeName(it.office));
const open0 = () => [...V.items.values()].filter(i => !i.closed).sort((a, b) => b.at.localeCompare(a.at));
const unseen = () => open0().filter(i => !i.seen);
const parseLines = s => { const m = /^\s*(\d+)\s*(?:[-–:]\s*(\d+))?\s*$/.exec(s || ''); if (!m) return null; const a = +m[1], b = m[2] ? +m[2] : a; return [Math.min(a, b), Math.max(a, b)]; };
function store(patch) { try { localStorage.setItem(LS, JSON.stringify({ ...load(), ...patch })); } catch {} }
function load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }

/* ---------- boot + live ---------- */
export function initViewer(ctx) {
  V.ctx = ctx;
  // other parts of the page (e.g. the process dock's "Pratinjau") open things here directly, without a notification
  window.kantorViewer = {
    openUrl(url, { who = 'Kamu', office = ctx.office?.id || '', note = '' } = {}) {
      const id = 'local-' + Date.now().toString(36);
      V.items.set(id, { id, office, who, kind: 'url', target: String(url), note, lines: null, at: new Date().toISOString(), seen: true, closed: false, local: true });
      openItem(id);
    },
  };
  const s = load();
  V.geo = s.geo || null; V.max = !!s.max;
  build();
  refresh();
}
export function viewerLive(msg) {
  if (!V.ctx) return;
  if (msg.t === 'reconnected') { if (V.ready) refresh(); return; }
  if (msg.t === 'show' && msg.item) {
    const fresh = !V.items.has(msg.item.id);
    V.items.set(msg.item.id, msg.item);
    badge(); if (V.listOpen) drawList();
    if (fresh) announce(msg.item);
  } else if (msg.t === 'show-update' && msg.item) {
    const it = msg.item;
    if (it.closed) { V.items.delete(it.id); dropTab(it.id); } else V.items.set(it.id, it);
    if (V.history) { const i = V.history.findIndex(x => x.id === it.id); if (i >= 0) V.history[i] = it; }
    badge(); if (V.listOpen) drawList();
  }
}
async function refresh() {
  try {
    const list = await api('/api/shows?open=1');
    const keep = new Map(V.items);
    V.items.clear();
    for (const it of list) V.items.set(it.id, it);
    for (const id of V.tabs.slice()) if (!V.items.has(id) && !keep.get(id)?.closed) V.items.set(id, keep.get(id));
    V.ready = true; badge(); if (V.listOpen) drawList();
  } catch (e) { console.error(e); }
}
function badge() {
  const n = unseen().length, b = $('#showCount');
  if (b) { b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
  $('#showBtn')?.classList.toggle('hot', n > 0);
}
async function mark(it, patch) {
  Object.assign(it, patch);
  if (it.local) { if (patch.closed) { dropTab?.(it.id); V.items.delete(it.id); } return; }
  try { await post(`/api/shows/${encodeURIComponent(it.id)}`, patch); } catch (e) { console.error(e); }
}

/* ---------- notifikasi ---------- */
function announce(it) {
  const text = `${it.who} membuka ${short(label(it), 60)} untukmu`;
  const card = document.createElement('div');
  card.className = 'vw-note'; card.setAttribute('role', 'status');
  card.innerHTML = `<div class="vw-note-ic" aria-hidden="true">${kindIcon(it.kind)}</div>
    <div class="vw-note-b"><b>${esc(it.who)}</b> membuka <code>${esc(short(label(it), 60))}</code> untukmu
      ${it.note ? `<p>${esc(short(it.note, 140))}</p>` : ''}<span class="vw-meta">${esc(officeName(it.office))}</span></div>
    <div class="vw-note-a"><button class="btn sm primary" data-a="see">Lihat</button><button class="vw-x" data-a="x" aria-label="Tutup notifikasi">✕</button></div>`;
  const wrap = $('#vwNotes'); wrap.prepend(card);
  while (wrap.children.length > 3) wrap.lastChild.remove();
  const kill = () => { card.classList.add('out'); setTimeout(() => card.remove(), 180); };
  const t = setTimeout(kill, 14000);
  card.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    clearTimeout(t); kill(); if (a === 'see') openItem(it.id);
  });
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Kantor Claude', { body: text + (it.note ? '\n' + it.note : ''), tag: it.id });
      n.onclick = () => { window.focus(); openItem(it.id); n.close(); };
    }
  } catch {}
}

/* ---------- build DOM ---------- */
function build() {
  const root = document.createElement('div');
  root.id = 'vw';
  root.innerHTML = `<div class="vw-notes" id="vwNotes" aria-live="polite"></div>
    <div class="vw-list" id="vwList" hidden role="dialog" aria-label="Dibuka untukmu"></div>
    <button class="vw-pill" id="vwPill" type="button" hidden></button>
    <section class="vw-panel" id="vwPanel" role="dialog" aria-label="Layar" tabindex="-1" hidden></section>`;
  document.body.appendChild(root);
  $('#showBtn').addEventListener('click', e => { e.stopPropagation(); toggleList(); });
  $('#vwList').addEventListener('click', onListClick);
  $('#vwPill').addEventListener('click', () => { V.min = false; applyPanel(); $('#vwPanel').focus(); });
  $('#vwPanel').addEventListener('click', onPanelClick);
  $('#vwPanel').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('#vwAddr')) e.preventDefault(); });
  document.addEventListener('click', e => { if (V.listOpen && !e.target.closest('#vwList')) closeList(); });
  document.addEventListener('keydown', onKey);
  addEventListener('resize', () => { clampGeo(); applyPanel(); if (V.listOpen) placeList(); });
  setInterval(() => { if (V.open) drawTitle(); if (V.listOpen) drawList(); }, 30000);
}
function onKey(e) {
  if (e.key !== 'Escape') return;
  if (!$('#modal')?.hidden) return;
  const z = $('.vw-zoom.zoom', $('#vwPanel'));
  if (V.listOpen) { closeList(); $('#showBtn').focus(); e.preventDefault(); }
  else if (z) { z.classList.remove('zoom'); }
  else if (V.open && !V.min) { closePanel(); e.preventDefault(); }
}

/* ---------- dropdown "Dibuka untukmu" ---------- */
function toggleList() { V.listOpen ? closeList() : openList(); }
async function openList() {
  V.listOpen = true; $('#vwList').hidden = false; $('#showBtn').setAttribute('aria-expanded', 'true');
  drawList(); placeList();
  refresh();
  if (V.showHistory) loadHistory();
}
function closeList() { V.listOpen = false; $('#vwList').hidden = true; $('#showBtn').setAttribute('aria-expanded', 'false'); }
function placeList() {
  const r = $('#showBtn').getBoundingClientRect(), el = $('#vwList');
  el.style.top = Math.round(r.bottom + 8) + 'px';
  el.style.right = Math.max(8, Math.round(innerWidth - r.right - 8)) + 'px';
}
async function loadHistory() {
  try { V.history = await api('/api/shows'); } catch (e) { toast(e.message, 'bad'); V.history = []; }
  if (V.listOpen) drawList();
}
function drawList() {
  const el = $('#vwList'); if (!el) return;
  const row = (it, hist) => `<li class="vw-row${it.seen ? '' : ' new'}${it.closed ? ' done' : ''}" data-id="${esc(it.id)}">
      <span class="vw-ic" aria-hidden="true">${kindIcon(it.kind)}</span>
      <div class="vw-rb"><div class="vw-rt"><b>${esc(it.who)}</b> <code>${esc(short(label(it), 52))}</code></div>
        ${it.note ? `<p>${esc(short(it.note, 120))}</p>` : ''}
        <span class="vw-meta">${esc(officeName(it.office))} · ${esc(ago(it.at))}${it.lines ? ' · baris ' + esc(it.lines) : ''}${it.closed ? ' · selesai' : ''}</span></div>
      <div class="vw-ra"><button class="btn sm${it.closed ? '' : ' primary'}" data-a="see">Lihat</button>${it.closed ? '' : '<button class="btn sm" data-a="done">Tutup</button>'}</div></li>`;
  const cur = open0();
  const hist = V.showHistory ? (V.history || []).filter(i => i.closed) : [];
  const perm = 'Notification' in window && Notification.permission === 'default';
  el.innerHTML = `<div class="vw-lh"><h3>Dibuka untukmu</h3>
      <label class="check sm"><input type="checkbox" id="vwHist"${V.showHistory ? ' checked' : ''}> Riwayat</label></div>
    ${cur.length ? `<ul>${cur.map(i => row(i)).join('')}</ul>` : '<p class="empty-line">Belum ada yang dibukakan. Minta agen: "tunjukkan file itu".</p>'}
    ${V.showHistory ? `<div class="vw-sep">Sudah ditutup</div>${hist.length ? `<ul>${hist.map(i => row(i, true)).join('')}</ul>` : '<p class="empty-line">' + (V.history ? 'Riwayat kosong.' : 'Memuat…') + '</p>'}` : ''}
    ${perm ? '<button class="vw-perm" data-a="perm">Aktifkan notifikasi desktop</button>' : ''}`;
}
function onListClick(e) {
  const t = e.target.closest('[data-a],#vwHist'); if (!t) return;
  if (t.id === 'vwHist') { V.showHistory = t.checked; drawList(); if (V.showHistory) loadHistory(); return; }
  if (t.dataset.a === 'perm') { Notification.requestPermission().then(drawList); return; }
  const id = t.closest('.vw-row')?.dataset.id;
  const it = V.items.get(id) || V.history?.find(i => i.id === id); if (!it) return;
  if (t.dataset.a === 'see') { closeList(); if (it.closed) V.items.set(it.id, it); openItem(it.id); }
  else if (t.dataset.a === 'done') finish(it);
}

/* ---------- panel ---------- */
function openItem(id) {
  const it = V.items.get(id); if (!it) return;
  if (!V.tabs.includes(id)) V.tabs.push(id);
  V.active = id;
  if (!V.open) V.opener = document.activeElement;
  V.open = true; V.min = false;
  if (!it.seen) { mark(it, { seen: true }); badge(); }
  if (!V.views.has(id)) V.views.set(id, { cwd: it.kind === 'folder' ? norm(it.target) : '', file: null, raw: false, req: 0 });
  applyPanel(); drawPanel();
  $('#vwPanel').focus({ preventScroll: true });
}
function closePanel() {
  V.open = false; applyPanel();
  const o = V.opener; V.opener = null;
  (o && document.contains(o) ? o : $('#showBtn')).focus?.();
}
function dropTab(id) {
  const i = V.tabs.indexOf(id); if (i < 0) return;
  V.tabs.splice(i, 1); V.views.delete(id);
  if (V.active === id) V.active = V.tabs[Math.min(i, V.tabs.length - 1)] || null;
  if (!V.tabs.length) { V.open = false; applyPanel(); } else if (V.open) { applyPanel(); drawPanel(); }
}
async function finish(it) {
  await mark(it, { closed: true });
  V.items.delete(it.id); dropTab(it.id); badge(); if (V.listOpen) drawList();
  toast('Ditandai selesai', 'ok');
}

function defaultGeo() {
  const w = Math.min(760, innerWidth - 40), h = Math.min(540, innerHeight - 110);
  return { x: innerWidth - w - 24, y: 72, w, h };
}
function clampGeo() {
  const g = V.geo || defaultGeo();
  g.w = Math.max(Math.min(MIN_W, innerWidth), Math.min(g.w, innerWidth));
  g.h = Math.max(Math.min(MIN_H, innerHeight), Math.min(g.h, innerHeight));
  g.x = Math.max(0, Math.min(g.x, innerWidth - g.w));
  g.y = Math.max(0, Math.min(g.y, innerHeight - g.h));
  V.geo = g;
}
function applyPanel() {
  const p = $('#vwPanel'), pill = $('#vwPill');
  p.hidden = !V.open || V.min;
  pill.hidden = !(V.open && V.min);
  p.classList.toggle('max', V.max);
  if (!V.open) return;
  clampGeo();
  const g = V.geo;
  p.style.left = g.x + 'px'; p.style.top = g.y + 'px'; p.style.width = g.w + 'px'; p.style.height = g.h + 'px';
  const it = V.items.get(V.active);
  if (it) pill.innerHTML = `<span aria-hidden="true">${kindIcon(it.kind)}</span> <b>${esc(it.who)}</b> <span class="vw-pill-t">${esc(short(label(it), 34))}</span>${V.tabs.length > 1 ? `<i>${V.tabs.length}</i>` : ''}`;
}

function drawPanel() {
  const p = $('#vwPanel'), it = V.items.get(V.active); if (!it) return;
  const multi = V.tabs.length > 1;
  p.innerHTML = `<div class="vw-head" id="vwHead">
      <div class="vw-ttl"><span class="vw-ic" aria-hidden="true">${kindIcon(it.kind)}</span><div class="vw-tt"><b id="vwWho"></b><span class="vw-meta" id="vwOff"></span></div></div>
      <div class="vw-ctl"><button data-a="min" title="Kecilkan" aria-label="Kecilkan">–</button><button data-a="max" title="${V.max ? 'Pulihkan' : 'Perbesar'}" aria-label="${V.max ? 'Pulihkan' : 'Perbesar'}">${V.max ? '❐' : '□'}</button><button data-a="close" title="Tutup panel (Esc)" aria-label="Tutup panel">✕</button></div></div>
    ${multi ? `<div class="vw-tabs" role="tablist">${V.tabs.map(id => { const x = V.items.get(id); return x ? `<button role="tab" aria-selected="${id === V.active}" class="${id === V.active ? 'on' : ''}" data-a="tab" data-id="${esc(id)}" title="${esc(x.who + ' · ' + label(x))}">${kindIcon(x.kind)} ${esc(short(label(x).split('/').pop() || label(x), 22))}</button>` : ''; }).join('')}</div>` : ''}
    ${it.note ? `<div class="vw-nt"><span>Catatan</span> ${esc(it.note)}${it.lines ? ` <code>baris ${esc(it.lines)}</code>` : ''}</div>` : ''}
    <div class="vw-bar" id="vwBar"></div>
    <div class="vw-body" id="vwBody"></div>
    ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `<i class="vw-rz z-${d}" data-rz="${d}"></i>`).join('')}`;
  drawTitle();
  bindDrag();
  render();
}
function drawTitle() {
  const it = V.items.get(V.active); if (!it) return;
  const w = $('#vwWho'), o = $('#vwOff'); if (!w) return;
  w.textContent = `Dibuka oleh ${it.who} · ${ago(it.at)}`;
  o.textContent = officeName(it.office);
}

/* konten per item */
async function render() {
  const it = V.items.get(V.active), v = V.views.get(V.active), body = $('#vwBody'), bar = $('#vwBar');
  if (!it || !v) return;
  const my = ++v.req;
  const ok = () => v.req === my && V.active === it.id && $('#vwBody') === body;
  if (it.kind === 'url') return renderUrl(it, v, bar, body);
  if (it.kind === 'file' && it.view && !v.src) return renderHtml(it, v, bar, body);
  body.innerHTML = '<p class="empty-line">Memuat…</p>';
  try {
    if (v.file) { bar.innerHTML = crumbs(it, v) + actions(it, v); return fileView(it, v, v.file, body); }
    if (it.kind === 'folder') {
      const l = await api(apiUrl(it.office, '', { path: v.cwd }));
      if (!ok()) return;
      v.root = l.root; v.cwd = l.path;
      bar.innerHTML = crumbs(it, v) + actions(it, v);
      const es = l.entries.slice().sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      body.innerHTML = `<div class="vw-dir">${v.cwd ? `<button class="vw-er" data-a="up"><span class="vw-fi dir">↑</span><span class="vw-fn">..</span></button>` : ''}
        ${es.map(e => `<button class="vw-er" data-a="${e.dir ? 'cd' : 'file'}" data-path="${esc(e.path)}"><span class="vw-fi${e.dir ? ' dir' : ''}">${fileIcon(e)}</span><span class="vw-fn">${esc(e.name)}</span><span class="vw-fs">${e.dir ? '' : size(e.size)}</span></button>`).join('') || '<p class="empty-line">Folder kosong.</p>'}
        ${l.hidden ? `<p class="hint vw-foot">${l.hidden} item tersembunyi</p>` : ''}</div>`;
    } else {
      const info = await api(apiUrl(it.office, '/read', { path: norm(it.target) }));
      if (!ok()) return;
      v.file = info; v.single = true;
      bar.innerHTML = crumbs(it, v) + actions(it, v);
      fileView(it, v, info, body);
    }
  } catch (e) {
    if (!ok()) return;
    bar.innerHTML = crumbs(it, v) + actions(it, v);
    const dl = it.kind === 'file' ? `<a class="btn sm" href="${apiUrl(it.office, '/raw', { path: norm(it.target), dl: '1' })}" download>Unduh</a>` : '';
    body.innerHTML = `<div class="vw-err"><b>Tidak bisa dibuka</b><p>${esc(e.message)}</p><p class="hint">Mungkin file sudah dipindah atau dihapus.</p>${dl}</div>`;
  }
}
function crumbs(it, v) {
  const path = v.file ? v.file.path : v.cwd, parts = path ? path.split('/') : [];
  if (it.kind === 'file') return `<nav class="vw-cr"><code>${esc(path || norm(it.target))}</code></nav>`;
  const link = (p, t, last) => last ? `<b>${esc(t)}</b>` : `<a href="#" data-a="goto" data-path="${esc(p)}">${esc(t)}</a>`;
  return `<nav class="vw-cr" aria-label="Lokasi">${link('', officeName(it.office), !parts.length)}${parts.map((s, i) => `<span>/</span>${link(parts.slice(0, i + 1).join('/'), s, i === parts.length - 1)}`).join('')}</nav>`;
}
function curPath(it, v) { return v.file ? v.file.path : it.kind === 'url' ? it.target : (v.cwd ?? norm(it.target)); }
function actions(it, v) {
  const f = v.file;
  return `<div class="vw-act">
    <button class="btn sm" data-a="vscode" title="Buka di VS Code di Mac">VS Code</button>
    <button class="btn sm" data-a="finder" title="Tampilkan di Finder">Finder</button>
    <button class="btn sm" data-a="tabfile" title="Buka di tab File">Tab File</button>
    <button class="btn sm" data-a="copy">Salin path</button>
    ${f ? `<a class="btn sm" href="${apiUrl(it.office, '/raw', { path: f.path, dl: '1' })}" download>Unduh</a>` : ''}
    <button class="btn sm primary" data-a="done">Tandai selesai</button></div>`;
}

function fileView(it, v, info, body) {
  const raw = apiUrl(it.office, '/raw', { path: info.path });
  const rng = it.kind === 'file' || v.single ? parseLines(it.lines) : null;
  const meta = `<p class="hint vw-fmeta"><code>${esc(info.path)}</code> · ${size(info.size)}${info.mtime ? ' · diubah ' + esc(ago(new Date(info.mtime).toISOString())) : ''}${info.truncated ? ' · hanya 1 MB pertama' : ''}${rng ? ` · baris ${rng[0]}${rng[1] > rng[0] ? '–' + rng[1] : ''} disorot` : ''}</p>`;
  const toggle = info.ext === '.md' && info.kind === 'text' ? `<button class="btn sm vw-tg" data-a="raw">${v.raw ? 'Tampilkan rapi' : 'Lihat mentah'}</button>`
    : it.view && v.src && info.path === norm(it.target) ? '<button class="btn sm vw-tg" data-a="rendered">Tampilkan halaman</button>' : '';
  let main = '';
  if (info.kind === 'image') main = `<div class="vw-media vw-zoom"><img src="${raw}" alt="${esc(info.path)}" data-a="zoom" title="Klik untuk perbesar"></div>`;
  else if (info.kind === 'video') main = `<div class="vw-media"><video src="${raw}" controls></video></div>`;
  else if (info.kind === 'audio') main = `<div class="vw-media"><audio src="${raw}" controls></audio></div>`;
  else if (info.kind === 'pdf') main = `<iframe class="vw-frame" src="${raw}" title="${esc(info.path)}"></iframe>`;
  else if (info.kind === 'binary') main = `<div class="vw-err"><b>File biner</b><p>Tidak bisa ditampilkan di sini (${size(info.size)}).</p><a class="btn primary" href="${apiUrl(it.office, '/raw', { path: info.path, dl: '1' })}" download>Unduh</a></div>`;
  else if (info.ext === '.md' && !(v.raw || rng)) main = `<div class="vw-md md">${md(info.text || '')}</div>`;
  else {
    const lines = String(info.text || '').split('\n');
    main = `<pre class="vw-code"><code>${lines.map((l, i) => `<span class="vl${rng && i + 1 >= rng[0] && i + 1 <= rng[1] ? ' hl' : ''}"><span class="ln">${i + 1}</span>${esc(l)}</span>`).join('')}</code></pre>`;
  }
  body.innerHTML = `<div class="vw-fh">${meta}${toggle}</div>${main}`;
  body.classList.toggle('flush', info.kind === 'pdf');
  const first = $('.vl.hl', body);
  if (first) {
    const sc = $('.vw-code', body);
    requestAnimationFrame(() => { sc.scrollTop = Math.max(0, first.offsetTop - sc.clientHeight / 3); });
  }
}

/* HTML yang ditunjukkan: dirender di iframe sandbox (skrip jalan, tanpa akses ke origin Kantor) dari path bertanda /sv/... */
function renderHtml(it, v, bar, body) {
  bar.innerHTML = `<div class="vw-addr"><button class="btn sm" data-a="reload" title="Muat ulang" aria-label="Muat ulang">↻</button>
      <input id="vwAddr" value="${esc(norm(it.target))}" readonly aria-label="File" spellcheck="false">
      <a class="btn sm" href="${esc(it.view)}" target="_blank" rel="noopener">Buka di tab baru</a>
      <button class="btn sm" data-a="src">Lihat sumber</button>
      <a class="btn sm" href="${apiUrl(it.office, '/raw', { path: norm(it.target), dl: '1' })}" download>Unduh</a>
      <button class="btn sm primary" data-a="done">Tandai selesai</button></div>`;
  body.classList.add('flush');
  body.innerHTML = `<iframe class="vw-frame" id="vwFrame" src="${esc(it.view)}" title="${esc(norm(it.target))}" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>`;
}

function renderUrl(it, v, bar, body) {
  bar.innerHTML = `<div class="vw-addr"><button class="btn sm" data-a="reload" title="Muat ulang" aria-label="Muat ulang">↻</button>
      <input id="vwAddr" value="${esc(it.target)}" readonly aria-label="Alamat" spellcheck="false">
      <a class="btn sm" href="${esc(it.target)}" target="_blank" rel="noopener">Buka di tab baru</a>
      <button class="btn sm" data-a="copy">Salin</button><button class="btn sm primary" data-a="done">Tandai selesai</button></div>`;
  body.classList.add('flush');
  body.innerHTML = `<iframe class="vw-frame" id="vwFrame" src="${esc(it.target)}" title="${esc(it.target)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
    <div class="vw-fhint">Beberapa situs menolak ditampilkan di dalam panel. Kalau kosong, <a href="${esc(it.target)}" target="_blank" rel="noopener">buka di tab baru</a>.</div>`;
}

function onPanelClick(e) {
  const t = e.target.closest('[data-a]'); if (!t) return;
  const a = t.dataset.a, it = V.items.get(V.active), v = V.views.get(V.active);
  if (a !== 'goto' && t.tagName === 'A' && t.getAttribute('href') !== '#') return;
  if (t.tagName === 'A') e.preventDefault();
  if (a === 'close') return closePanel();
  if (a === 'min') { V.min = true; applyPanel(); return $('#vwPill').focus(); }
  if (a === 'max') { V.max = !V.max; store({ max: V.max }); applyPanel(); drawPanel(); return; }
  if (a === 'tab') { V.active = t.dataset.id; drawPanel(); return; }
  if (a === 'tabfile') return openTabFile(it, v);
  if (!it || !v) return;
  if (a === 'done') return finish(it);
  if (a === 'reload') { const f = $('#vwFrame'); if (f) f.src = it.kind === 'url' ? it.target : it.view; return; }
  if (a === 'src') { v.src = true; return render(); }
  if (a === 'rendered') { v.src = false; v.file = null; return render(); }
  if (a === 'zoom') return t.closest('.vw-zoom').classList.toggle('zoom');
  if (a === 'raw') { v.raw = !v.raw; return render(); }
  if (a === 'vscode' || a === 'finder') return openLocal(it, v, a === 'vscode' ? 'code' : 'finder');
  if (a === 'copy') return copy(it, v);
  if (a === 'goto') { v.file = null; v.cwd = t.dataset.path; return render(); }
  if (a === 'up') { v.cwd = v.cwd.split('/').slice(0, -1).join('/'); return render(); }
  if (a === 'cd') { v.cwd = t.dataset.path; return render(); }
  if (a === 'file') {
    api(apiUrl(it.office, '/read', { path: t.dataset.path })).then(info => { v.file = info; v.raw = false; render(); }).catch(err => toast(err.message, 'bad'));
  }
}
function openTabFile(it, v) {
  const p = it.kind === 'url' ? '' : curPath(it, v);
  location.hash = `#/o/${encodeURIComponent(it.office)}/file${p ? '/' + enc(p) : ''}`;
}
async function openLocal(it, v, app) {
  const path = curPath(it, v);
  try { await post(`/api/offices/${encodeURIComponent(it.office)}/open-local`, { path, app }); toast(app === 'code' ? 'Dibuka di VS Code' : 'Ditampilkan di Finder', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
}
function copy(it, v) {
  const root = v.root || officeOf(it.office)?.root;
  const p = it.kind === 'url' ? it.target : (root ? `${root}/${curPath(it, v)}`.replace(/\/$/, '') : curPath(it, v));
  navigator.clipboard.writeText(p).then(() => toast(it.kind === 'url' ? 'Alamat disalin' : 'Path disalin', 'ok'), () => toast('Gagal menyalin', 'bad'));
}

/* ---------- geser + ubah ukuran ---------- */
function bindDrag() {
  const p = $('#vwPanel');
  $('#vwHead').addEventListener('pointerdown', e => {
    if (e.target.closest('button') || V.max || narrow() || e.button) return;
    start(e, 'move');
  });
  $('#vwHead').addEventListener('dblclick', e => { if (!e.target.closest('button')) { V.max = !V.max; store({ max: V.max }); applyPanel(); drawPanel(); } });
  p.querySelectorAll('.vw-rz').forEach(h => h.addEventListener('pointerdown', e => { if (V.max || narrow() || e.button) return; start(e, h.dataset.rz); }));
}
function start(e, mode) {
  e.preventDefault();
  const p = $('#vwPanel'), el = e.currentTarget, g0 = { ...V.geo }, x0 = e.clientX, y0 = e.clientY;
  el.setPointerCapture(e.pointerId); p.classList.add('dragging');
  const move = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0, g = { ...g0 };
    if (mode === 'move') { g.x = g0.x + dx; g.y = g0.y + dy; }
    else {
      if (mode.includes('e')) g.w = g0.w + dx;
      if (mode.includes('s')) g.h = g0.h + dy;
      if (mode.includes('w')) { g.w = g0.w - dx; g.x = g0.x + dx; }
      if (mode.includes('n')) { g.h = g0.h - dy; g.y = g0.y + dy; }
      if (g.w < MIN_W) { if (mode.includes('w')) g.x -= MIN_W - g.w; g.w = MIN_W; }
      if (g.h < MIN_H) { if (mode.includes('n')) g.y -= MIN_H - g.h; g.h = MIN_H; }
    }
    V.geo = g; applyPanel();
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    p.classList.remove('dragging'); store({ geo: V.geo });
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
