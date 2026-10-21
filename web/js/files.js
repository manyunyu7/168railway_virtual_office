// Tab File: jelajahi folder kantor, lihat isi file, upload, dan suruh role mengerjakan sesuatu di file tertentu.
import { $, $$, esc, short, api, post, toast, modal, closeModal, ago, md } from './util.js';

let F = null;
const base = () => `#/o/${encodeURIComponent(F.ctx.office.id)}/file`;
const url = (p, q = {}) => `/api/offices/${encodeURIComponent(F.ctx.office.id)}/files${p}?${new URLSearchParams(q)}`;
const size = n => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const icon = e => e.dir ? '▸' : /\.(png|jpe?g|gif|webp|svg)$/i.test(e.name) ? '▣' : /\.pdf$/i.test(e.name) ? '▤' : /\.(md|txt)$/i.test(e.name) ? '≡' : '·';
const tilde = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');

export async function render(el, ctx, r) {
  F = { el, ctx, dir: '', list: null, sel: null, view: null, picked: new Set(), all: false, q: '', results: null, qT: 0 };
  el.innerHTML = `<div class="fm">
    <div class="fm-bar"><nav class="fm-crumbs" id="fmCrumbs" aria-label="Lokasi"></nav>
      <input type="search" id="fmQ" placeholder="Cari nama file…" autocomplete="off" aria-label="Cari file">
      <label class="check sm"><input type="checkbox" id="fmAll"> Tersembunyi</label>
      <button class="btn sm" data-fm="mkdir">Folder baru</button>
      <label class="btn sm primary fm-up">Upload<input type="file" id="fmFile" multiple hidden></label></div>
    <div class="fm-body"><div class="fm-list" id="fmList" tabindex="-1"><p class="empty-line">Memuat…</p></div>
      <section class="fm-view" id="fmView"><p class="empty-line">Pilih file untuk melihat isinya. Centang beberapa file lalu klik <b>Suruh…</b> untuk memberi tugas ke role.</p></section></div>
    <div class="fm-pick" id="fmPick" hidden></div></div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  const list = $('#fmList', el);
  list.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); list.classList.add('drop'); } });
  list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop'); });
  list.addEventListener('drop', e => { e.preventDefault(); list.classList.remove('drop'); uploadFiles([...(e.dataTransfer?.files || [])]); });
  await route(r);
}
export function unmount() { F = null; }
export async function route(r) {
  if (!F) return;
  const p = (r?.rest || []).join('/');
  // a deep link can point at a file: open its folder and show it
  const info = p ? await api(url('/read', { path: p })).catch(() => null) : null;
  if (info && info.kind !== undefined) { await open(p.split('/').slice(0, -1).join('/')); show(info); }
  else await open(p);
}
export function live(msg) { if (F && msg.t === 'files' && msg.office === F.ctx.office.id && msg.path === F.dir) open(F.dir, true); }

async function open(dir, keep = false) {
  try { F.list = await api(url('', { path: dir, all: F.all ? '1' : '0' })); }
  catch (e) { toast(e.message, 'bad'); return; }
  F.dir = F.list.path;
  if (!keep) { F.picked.clear(); F.results = null; const q = $('#fmQ'); if (q) q.value = ''; }
  drawCrumbs(); drawList(); drawPick();
}
function drawCrumbs() {
  const parts = F.dir ? F.dir.split('/') : [];
  $('#fmCrumbs').innerHTML = `<a href="${base()}">${esc(F.ctx.office.name)}</a>` + parts.map((p, i) => `<span>/</span><a href="${base()}/${parts.slice(0, i + 1).map(encodeURIComponent).join('/')}">${esc(p)}</a>`).join('');
}
function drawList() {
  const rows = F.results || F.list.entries;
  const row = e => `<div class="fm-row${F.sel === e.path ? ' cur' : ''}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}">
      <input type="checkbox" data-fm="pick" aria-label="Pilih ${esc(e.name)}"${F.picked.has(e.path) ? ' checked' : ''}>
      <button type="button" class="fm-name" data-fm="${e.dir ? 'cd' : 'show'}"><span class="fm-ic${e.dir ? ' dir' : ''}">${icon(e)}</span><span class="fm-nm">${esc(F.results ? e.path : e.name)}</span></button>
      <span class="fm-sz">${e.dir ? '' : size(e.size)}</span><span class="fm-mt">${e.mtime ? ago(new Date(e.mtime).toISOString()) : ''}</span></div>`;
  $('#fmList').innerHTML = (F.dir && !F.results ? `<div class="fm-row up"><span></span><a class="fm-name" href="${base()}/${F.dir.split('/').slice(0, -1).map(encodeURIComponent).join('/')}"><span class="fm-ic dir">↑</span><span class="fm-nm">..</span></a></div>` : '')
    + (rows.length ? rows.map(row).join('') : `<p class="empty-line">${F.results ? 'Tidak ada yang cocok.' : 'Folder kosong. Seret file ke sini untuk upload.'}</p>`)
    + (!F.results && F.list.hidden ? `<p class="hint fm-foot">${F.list.hidden} item tersembunyi (dotfile, node_modules, build…)</p>` : '')
    + '<p class="hint fm-foot">Seret file dari Finder ke daftar ini untuk upload ke folder ini.</p>';
}
function drawPick() {
  const el = $('#fmPick'); if (!el) return;
  el.hidden = !F.picked.size;
  el.innerHTML = `<span><b>${F.picked.size}</b> dipilih</span><button class="btn sm primary" data-fm="tell">Suruh…</button><button class="btn sm" data-fm="copy-paths">Salin path</button><button class="btn sm" data-fm="unpick">Batal pilih</button>`;
}

async function show(info) {
  if (typeof info === 'string') { try { info = await api(url('/read', { path: info })); } catch (e) { toast(e.message, 'bad'); return; } }
  F.sel = info.path; F.view = info;
  $$('.fm-row', F.el).forEach(r => r.classList.toggle('cur', r.dataset.path === info.path));
  const raw = url('/raw', { path: info.path });
  let body = '';
  if (info.kind === 'image') body = `<div class="fm-media"><img src="${raw}" alt="${esc(info.path)}"></div>`;
  else if (info.kind === 'video') body = `<video class="fm-media" src="${raw}" controls></video>`;
  else if (info.kind === 'audio') body = `<audio src="${raw}" controls></audio>`;
  else if (info.kind === 'pdf') body = `<iframe class="fm-pdf" src="${raw}" title="${esc(info.path)}"></iframe>`;
  else if (info.kind === 'binary') body = '<p class="empty-line">File biner, tidak bisa ditampilkan di sini. Unduh untuk membukanya.</p>';
  else if (info.ext === '.md') body = `<div class="fm-md md">${md(info.text)}</div>`;
  else body = `<pre class="fm-code"><code>${info.text.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')}</code></pre>`;
  $('#fmView').innerHTML = `<div class="fm-vh"><div style="min-width:0"><h3>${esc(info.path.split('/').pop())}</h3><p class="hint"><code>${esc(info.path)}</code> · ${size(info.size)} · diubah ${ago(new Date(info.mtime).toISOString())}${info.truncated ? ' · hanya 1 MB pertama' : ''}</p></div>
      <div class="btn-row"><button class="btn sm primary" data-fm="tell-one">Suruh…</button><button class="btn sm" data-fm="copy-one">Salin path</button><a class="btn sm" href="${url('/raw', { path: info.path, dl: '1' })}" download>Unduh</a></div></div>${body}`;
  history.replaceState(null, '', `${base()}/${info.path.split('/').map(encodeURIComponent).join('/')}`);
}

function onClick(e) {
  const t = e.target.closest('[data-fm]'); if (!t) return;
  const row = t.closest('.fm-row'), a = t.dataset.fm;
  if (a === 'cd') location.hash = `${base()}/${row.dataset.path.split('/').map(encodeURIComponent).join('/')}`;
  else if (a === 'show') show(row.dataset.path);
  else if (a === 'unpick') { F.picked.clear(); drawList(); drawPick(); }
  else if (a === 'tell') tellDialog([...F.picked]);
  else if (a === 'tell-one') tellDialog([F.sel]);
  else if (a === 'copy-paths') copy([...F.picked].map(p => absOf(p)).join('\n'));
  else if (a === 'copy-one') copy(absOf(F.sel));
  else if (a === 'mkdir') mkdirDialog();
}
function onChange(e) {
  if (e.target.dataset.fm === 'pick') { const p = e.target.closest('.fm-row').dataset.path; e.target.checked ? F.picked.add(p) : F.picked.delete(p); drawPick(); }
  else if (e.target.id === 'fmAll') { F.all = e.target.checked; open(F.dir, true); }
  else if (e.target.id === 'fmFile') { uploadFiles([...e.target.files]); e.target.value = ''; }
}
function onInput(e) {
  if (e.target.id !== 'fmQ') return;
  clearTimeout(F.qT);
  const q = e.target.value.trim();
  F.qT = setTimeout(async () => {
    if (!q) { F.results = null; drawList(); return; }
    try { F.results = (await api(url('', { path: F.dir, q }))).results.map(r => ({ ...r, size: null })); drawList(); } catch (err) { toast(err.message, 'bad'); }
  }, 250);
}
const absOf = p => `${F.list.root}/${p}`;
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Path disalin', 'ok'), () => toast('Gagal menyalin', 'bad')); }

async function uploadFiles(files) {
  if (!files.length) return;
  const dir = F.dir;
  for (const [i, f] of files.entries()) {
    toast(`Upload ${i + 1}/${files.length}: ${f.name}`);
    try {
      const res = await fetch(url('/upload', { path: dir, name: f.name }), { method: 'POST', body: f, credentials: 'same-origin' });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || res.statusText);
      if (r.renamed) toast(`${f.name} sudah ada, disimpan sebagai ${r.name}`, 'warn');
      F?.picked.add(r.path);
    } catch (err) { toast(`${f.name}: ${err.message}`, 'bad'); }
  }
  if (F) { await open(dir, true); toast(files.length > 1 ? `${files.length} file diupload` : 'File diupload', 'ok'); }
}
function mkdirDialog() {
  modal({ title: 'Folder baru', html: `<div class="field"><label for="fmNew">Nama folder di <code>${esc(F.dir || './')}</code></label><input id="fmNew" autocomplete="off"></div>`,
    actions: [{ label: 'Buat', kind: 'primary', fn: () => {
      const name = $('#fmNew').value.trim(); if (!name) return false;
      post(url('/mkdir'), { path: F.dir, name }).then(r => { closeModal(); location.hash = `${base()}/${r.path.split('/').map(encodeURIComponent).join('/')}`; }).catch(err => toast(err.message, 'bad'));
      return false;
    } }, { label: 'Batal' }] });
}

/* ---------- "Suruh…": tell a running session, or make a card for a role ---------- */
function tellDialog(paths) {
  paths = paths.filter(Boolean); if (!paths.length) return;
  const o = F.ctx.office;
  const roleName = id => o.roles.find(r => r.id === id)?.name;
  // sessions the office can type into: its own tmux panes, and Terminal/iTerm tabs
  const live = o.sessions.filter(s => s.status !== 'ended' && (s.tmux || (s.tty && !['vscode', 'lain'].includes(s.host))));
  const opts = live.map(s => `<option value="s:${esc(s.sid)}">${esc((roleName(s.role) || short(s.title || 'Sesi manual', 30)) + (s.status === 'working' ? ' · sedang bekerja' : ''))}</option>`).join('');
  const roles = o.roles.filter(r => !r.archived).map(r => `<option value="c:${esc(r.id)}">Kartu baru untuk ${esc(r.name)}</option>`).join('');
  const list = paths.map(p => `<li><code>${esc(p)}</code></li>`).join('');
  modal({ title: 'Suruh mengerjakan', html: `<div class="fm-tell"><p class="hint">File yang dirujuk:</p><ul class="fm-tell-list">${list}</ul>
      <div class="field"><label for="fmTo">Kepada</label><select id="fmTo">${opts ? `<optgroup label="Sesi yang sedang jalan">${opts}</optgroup>` : ''}<optgroup label="Lewat board">${roles}</optgroup></select>
        <p class="hint">${opts ? 'Pesan langsung diketik ke sesinya. Kartu menunggu sampai role itu mengambilnya.' : 'Tidak ada sesi yang bisa diketik dari sini, jadi tugasnya jadi kartu.'}</p></div>
      <div class="field"><label for="fmMsg">Instruksi</label><textarea id="fmMsg" rows="4" placeholder="mis. Taruh fungsi format rupiah di file ini, lalu pakai di halaman checkout."></textarea></div></div>`,
    actions: [{ label: 'Kirim', kind: 'primary', fn: () => { sendTell(paths); return false; } }, { label: 'Batal' }] });
  setTimeout(() => $('#fmMsg')?.focus(), 30);
}
async function sendTell(paths) {
  const msg = $('#fmMsg').value.trim(), to = $('#fmTo').value;
  if (!msg) { toast('Tulis instruksinya dulu', 'warn'); return; }
  const files = paths.map(p => `- \`${absOf(p)}\``).join('\n');
  const text = `${msg}\n\nFile:\n${files}`;
  try {
    if (to.startsWith('s:')) {
      const r = await post(`/api/sessions/${encodeURIComponent(to.slice(2))}/action`, { action: 'text', text });
      toast(`Terkirim${r.via && r.via !== 'tmux' ? ' lewat ' + r.via : ''}`, 'ok');
    } else {
      const c = await post(`/api/offices/${encodeURIComponent(F.ctx.office.id)}/cards`, { title: short(msg.split('\n')[0], 90), desc: text, who: to.slice(2), col: 'Siap', prio: 'P2' });
      toast(`Kartu ${c.id} dibuat`, 'ok');
    }
    closeModal(); F.picked.clear(); drawList(); drawPick();
  } catch (err) { toast(err.message, 'bad'); }
}
