import { $, $$, esc, ago, api, post, del, toast, modal, confirmDo, md, toggleTask, debounce } from './util.js';
import { showDrawer, closeDrawer, drawerEl, drawerState } from './panel.js';

const COLORS = ['kuning', 'hijau', 'biru', 'merah', 'ungu', 'abu'];
const VIEWS = [['aktif', 'Aktif'], ['arsip', 'Arsip'], ['sampah', 'Sampah']];

let S = null;   // state tampilan: {el, ctx, view, q, tag, color, notes, tags}
let D = null;   // catatan yang sedang dibuka di editor (salinan lokal)
let wired = null;

const oid = () => S.ctx.office.id;
const isK = () => oid() === '_kompleks';
const base = () => (isK() ? '#/kompleks' : '#/o/' + oid());
const url = (p = '') => `/api/offices/${encodeURIComponent(oid())}/notes${p}`;
const roles = () => (S.ctx.office.roles || []).filter(r => !r.archived);
const cards = () => S.ctx.office.cards || [];
const rooms = () => S.ctx.office.plan?.rooms || [];
const roomName = id => rooms().find(r => r.id === id)?.name || id;
const mdOpts = (taskIndex) => ({ roles: S.ctx.office.roles || [], cardIds: new Set(cards().map(c => c.id)), wiki: () => true, taskIndex });

/* ---------------- daftar ---------------- */
export async function render(el, ctx, route) {
  S = { el, ctx, view: 'aktif', q: '', tag: '', color: '', notes: [], tags: [] };
  el.innerHTML = `<div class="notes-layout">
    <aside class="notes-side">
      <input type="search" id="ntQ" placeholder="Cari catatan" aria-label="Cari catatan">
      <button class="btn primary" data-act="nt-new">Catatan baru</button>
      <div class="seg nt-views" id="ntViews"></div>
      <div><p class="eyebrow">Warna</p><div class="nt-colors" id="ntColorF"></div></div>
      <div><p class="eyebrow">Tag</p><div class="chips" id="ntTags"></div></div>
    </aside>
    <div id="ntMain"></div>
  </div>`;
  el.addEventListener('click', onListClick);
  $('#ntQ', el).addEventListener('input', debounce(e => { S.q = e.target.value.trim(); load(); }, 250));
  wire();
  paintSide();
  await load();
  if (route?.rest?.[0]) openNote(route.rest[0]);
}

export function route(r) { if (S && r?.rest?.[0]) openNote(r.rest[0]); }

export function unmount() {
  unwire();
  S = null; D = null;
}

function wire() {
  unwire();
  const d = drawerEl();
  wired = { d, click: onDrawerClick, input: onDrawerInput, key: onDrawerKey, change: onDrawerInput };
  d.addEventListener('click', wired.click);
  d.addEventListener('input', wired.input);
  d.addEventListener('change', wired.change);
  d.addEventListener('keydown', wired.key);
}
function unwire() {
  if (!wired) return;
  wired.d.removeEventListener('click', wired.click);
  wired.d.removeEventListener('input', wired.input);
  wired.d.removeEventListener('change', wired.change);
  wired.d.removeEventListener('keydown', wired.key);
  wired = null;
}

async function load() {
  if (!S) return;
  const qs = new URLSearchParams({ view: S.view });
  if (S.q) qs.set('q', S.q);
  if (S.tag) qs.set('tag', S.tag);
  try {
    const r = await api(url('?' + qs));
    if (!S) return;
    S.notes = r.notes || []; S.tags = r.tags || [];
  } catch (e) { toast(e.message, 'bad'); }
  paintSide(); paintMain();
}

function paintSide() {
  $('#ntViews', S.el).innerHTML = VIEWS.map(([k, l]) => `<button data-act="nt-view" data-v="${k}" aria-pressed="${S.view === k}">${l}</button>`).join('');
  $('#ntColorF', S.el).innerHTML = COLORS.map(c => `<button class="nt-sw" data-act="nt-color" data-c="${c}" title="${c}" aria-label="Warna ${c}" aria-pressed="${S.color === c}" style="--nc:var(--n-${c})"></button>`).join('');
  const tags = S.tags.length || !S.tag ? S.tags : [{ tag: S.tag, n: 0 }];
  $('#ntTags', S.el).innerHTML = tags.length
    ? tags.map(t => `<button class="chip" data-act="nt-tag" data-tag="${esc(t.tag)}" aria-pressed="${S.tag === t.tag}">${esc(t.tag)} <span class="nt-n">${t.n}</span></button>`).join('')
    : '<span class="hint">Belum ada tag.</span>';
}

function noteCard(n) {
  const wall = n.wall && !isK() ? '<span class="chip">di dinding</span>' : '';
  const room = n.room ? `<span class="chip">${esc(roomName(n.room))}</span>` : '';
  return `<article class="note" tabindex="0" role="button" data-act="nt-open" data-id="${esc(n.id)}" style="--nc:var(--n-${COLORS.includes(n.color) ? n.color : 'kuning'})">
    <h4>${esc(n.title || 'Tanpa judul')}</h4>
    ${n.body ? `<div class="nbody">${md(n.body, mdOpts(false))}</div>` : ''}
    ${(n.tags?.length || wall || room) ? `<div class="chips">${(n.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}${wall}${room}</div>` : ''}
    <div class="nmeta"><span>${esc(n.author || '')}</span><span>${ago(n.updatedAt)}</span></div>
  </article>`;
}

function emptyHTML() {
  if (S.q || S.tag || S.color) return '<p class="empty-line">Tidak ada catatan yang cocok dengan penyaring ini.</p>';
  if (S.view === 'arsip') return '<p class="empty-line">Arsip kosong. Catatan yang sudah tidak dipakai bisa dipindah ke sini.</p>';
  if (S.view === 'sampah') return '<p class="empty-line">Sampah kosong. Catatan yang dihapus mampir di sini dulu sebelum hilang permanen.</p>';
  return `<div class="card nt-empty"><h2>Belum ada catatan</h2>
    <p>Tulis catatan umum untuk ${isK() ? 'semua kantor' : 'kantor ini'}: daftar tugas, ide, tautan, apa saja. Pakai tag dan warna supaya gampang dicari.</p>
    <p class="hint">Role dan agen lain juga bisa membaca dan menulis di sini lewat alat MCP <code>notes_list</code> dan <code>note_write</code>.</p>
    <div class="btn-row"><button class="btn primary" data-act="nt-new">Catatan baru</button></div></div>`;
}

function paintMain() {
  const m = $('#ntMain', S.el);
  const list = S.color ? S.notes.filter(n => n.color === S.color) : S.notes;
  if (!list.length) { m.innerHTML = emptyHTML(); return; }
  const pinned = list.filter(n => n.pinned), rest = list.filter(n => !n.pinned);
  m.innerHTML = (pinned.length ? `<p class="eyebrow nt-grp">Disematkan</p><div class="masonry">${pinned.map(noteCard).join('')}</div>` : '')
    + (pinned.length && rest.length ? '<p class="eyebrow nt-grp">Lainnya</p>' : '')
    + (rest.length ? `<div class="masonry">${rest.map(noteCard).join('')}</div>` : '');
}

function onListClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) {
    const wl = e.target.closest('a.wl'); if (wl) { e.preventDefault(); gotoWiki(wl.dataset.wiki); }
    return;
  }
  const a = b.dataset.act;
  if (!a.startsWith('nt-')) return;
  if (e.target.closest('a.wl')) { e.preventDefault(); gotoWiki(e.target.closest('a.wl').dataset.wiki); return; }
  if (e.target.closest('a[data-card]')) { e.preventDefault(); location.hash = `${base()}/board/${e.target.closest('a[data-card]').dataset.card}`; return; }
  if (a === 'nt-view') { S.view = b.dataset.v; load(); }
  else if (a === 'nt-tag') { S.tag = S.tag === b.dataset.tag ? '' : b.dataset.tag; load(); }
  else if (a === 'nt-color') { S.color = S.color === b.dataset.c ? '' : b.dataset.c; paintSide(); paintMain(); }
  else if (a === 'nt-new') newNote();
  else if (a === 'nt-open') openNote(b.dataset.id);
}
function gotoWiki(title) { location.hash = `${base()}/wiki/${encodeURIComponent(title)}`; }

document.addEventListener('keydown', e => {
  if (!S || (e.key !== 'Enter' && e.key !== ' ')) return;
  const n = e.target.closest?.('.note[data-act="nt-open"]');
  if (n && e.target === n) { e.preventDefault(); openNote(n.dataset.id); }
});

/* ---------------- editor ---------------- */
async function newNote() {
  try {
    const n = await post(url(), { title: '', body: '', color: S.color || 'kuning', tags: S.tag ? [S.tag] : [] });
    if (S.view !== 'aktif') { S.view = 'aktif'; }
    load();
    openNote(n.id, n);
    setTimeout(() => $('#ntTitle', drawerEl())?.focus(), 30);
  } catch (e) { toast(e.message, 'bad'); }
}

async function fetchNote(id) {
  for (const v of ['aktif', 'arsip', 'sampah']) {
    const r = await api(url('?view=' + v));
    const n = (r.notes || []).find(x => x.id === id);
    if (n) return n;
  }
  return null;
}

async function openNote(id, known) {
  if (!S) return;
  if (D && D.id === id && drawerState().open) return;
  let n = known || S.notes.find(x => x.id === id);
  if (!n) { try { n = await fetchNote(id); } catch (e) { toast(e.message, 'bad'); return; } }
  if (!n || !S) { toast('Catatan tidak ditemukan.', 'warn'); return; }
  const mine = D = { ...n, tags: [...(n.tags || [])], dirty: false, mode: 'tulis', fresh: !n.title && !n.body, touched: false };
  showDrawer(editorHTML(), { key: 'note:' + id, wide: true, close: () => onClosed(mine) });
  try { history.replaceState(null, '', `${base()}/notes/${encodeURIComponent(id)}`); } catch {}
  paintBody();
}

function onClosed(mine) {
  clearTimeout(mine.timer);
  if (mine.gone) { if (D === mine) D = null; return; }
  if (mine.dirty) flush(mine);
  else if (mine.fresh && !mine.touched && !mine.title && !mine.body) post(url(), { id: mine.id, deleted: true }).then(() => S && load()).catch(() => {});
  if (D === mine) D = null;
  try { if (S && location.hash.includes('/notes/')) history.replaceState(null, '', `${base()}/notes`); } catch {}
  if (S) load();
}

function editorHTML() {
  const k = isK();
  return `<div class="dr-head"><div class="dr-id"><h2 class="dr-name">Catatan</h2><span class="hint" id="ntSave">Tersimpan</span></div>
      <button class="icon-btn" data-act="close-drawer" aria-label="Tutup">&times;</button></div>
    <div class="dr-body"><div class="note-editor" style="--nc:var(--n-${D.color})" id="ntEd">
      <input class="ttl" id="ntTitle" data-f="title" placeholder="Judul catatan" value="${esc(D.title)}" aria-label="Judul">
      <div class="nt-colors" id="ntColorE">${COLORS.map(c => `<button class="nt-sw" data-act="nt-setcolor" data-c="${c}" title="${c}" aria-label="Warna ${c}" aria-pressed="${D.color === c}" style="--nc:var(--n-${c})"></button>`).join('')}</div>
      <div class="nt-tagbox"><span class="chips" id="ntTagChips"></span><input type="text" id="ntTagIn" placeholder="Tambah tag, Enter" aria-label="Tambah tag"></div>
      <div class="nt-bar">
        <div class="seg"><button data-act="nt-mode" data-m="tulis" aria-pressed="true">Tulis</button><button data-act="nt-mode" data-m="lihat" aria-pressed="false">Pratinjau</button></div>
        <div class="btn-row nt-tools" id="ntTools">
          <button class="btn sm" data-act="nt-ins" data-s="- [ ] " title="Item daftar centang">Centang</button>
          <button class="btn sm" data-act="nt-ins" data-s="## " title="Judul bagian">Judul</button>
          <button class="btn sm" data-act="nt-bold" title="Tebalkan teks terpilih">Tebal</button>
          <button class="btn sm" data-act="nt-wiki" title="Tautan ke halaman wiki">[[Wiki]]</button>
          ${k ? '' : `<button class="btn sm" data-act="nt-pick" data-p="role" title="Sebut role">@Role</button><button class="btn sm" data-act="nt-pick" data-p="card" title="Rujuk kartu board">#Kartu</button>`}
        </div>
      </div>
      <div id="ntPick"></div>
      <div id="ntEdit"></div>
      <div id="ntActs"></div>
      <p class="hint">Perubahan tersimpan otomatis. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> untuk menutup.</p>
    </div></div>`;
}

function paintTags() {
  $('#ntTagChips', drawerEl()).innerHTML = D.tags.map(t => `<span class="chip">${esc(t)}<button data-act="nt-deltag" data-tag="${esc(t)}" aria-label="Hapus tag ${esc(t)}">&times;</button></span>`).join('');
}

function paintBody() {
  const d = drawerEl(), box = $('#ntEdit', d);
  if (!box) return;
  paintTags(); paintActs();
  $$('[data-act="nt-mode"]', d).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === D.mode)));
  $('#ntTools', d).hidden = D.mode !== 'tulis';
  if (D.mode === 'tulis') {
    box.innerHTML = `<textarea id="ntBody" data-f="body" placeholder="Tulis dengan markdown. Daftar tugas: - [ ] langkah" aria-label="Isi catatan">${esc(D.body)}</textarea>`;
  } else {
    box.innerHTML = D.body.trim() ? `<div class="nt-preview" id="ntView">${md(D.body, mdOpts(true))}</div>` : '<p class="empty-line">Belum ada isi.</p>';
  }
}

function paintActs() {
  const box = $('#ntActs', drawerEl()); if (!box) return;
  const k = isK();
  if (D.deleted) {
    box.innerHTML = `<div class="notice info"><span>Catatan ini ada di Sampah.</span></div>
      <div class="btn-row"><button class="btn" data-act="nt-restore">Pulihkan</button><button class="btn danger" data-act="nt-purge">Hapus permanen</button><button class="btn" data-act="nt-copy">Salin markdown</button></div>`;
    return;
  }
  box.innerHTML = `<div class="btn-row">
      <button class="btn sm" data-act="nt-pin" aria-pressed="${!!D.pinned}">${D.pinned ? 'Lepas sematan' : 'Sematkan'}</button>
      ${k ? '' : `<button class="btn sm" data-act="nt-wall" aria-pressed="${!!D.wall}">${D.wall ? 'Lepas dari dinding' : 'Tempel di dinding kantor'}</button>`}
      <button class="btn sm" data-act="nt-archive">${D.archived ? 'Keluarkan dari arsip' : 'Arsipkan'}</button>
      <button class="btn sm danger" data-act="nt-trash">Hapus</button>
    </div>
    ${k ? '' : `<div class="field"><label for="ntRoom">Ruangan (opsional)</label><select id="ntRoom" data-f="room"><option value="">Tanpa ruangan</option>${rooms().map(r => `<option value="${esc(r.id)}" ${D.room === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>`}
    <div class="btn-row">
      ${k ? '' : '<button class="btn sm" data-act="nt-tocard">Jadikan kartu</button><button class="btn sm" data-act="nt-sendrole">Kirim ke role</button>'}
      <button class="btn sm" data-act="nt-copy">Salin markdown</button>
    </div>`;
}

/* ---------------- simpan ---------------- */
function setState(txt, bad) {
  const s = $('#ntSave', drawerEl()); if (!s) return;
  s.textContent = txt; s.style.color = bad ? 'var(--bad)' : '';
}
function touch(note = D) {
  note.dirty = true; note.touched = true;
  setState('Menyimpan…');
  clearTimeout(note.timer);
  note.timer = setTimeout(() => flush(note), 600);
}
async function flush(note, extra = {}) {
  clearTimeout(note.timer);
  const payload = { id: note.id, title: note.title, body: note.body, color: note.color, tags: note.tags, ...extra };
  note.dirty = false;
  try {
    const r = await post(url(), payload);
    for (const k of ['updatedAt', 'author', 'pinned', 'wall', 'archived', 'deleted', 'room']) if (r && k in r) note[k] = r[k];
    if (D === note) setState(note.dirty ? 'Menyimpan…' : 'Tersimpan');
    return r;
  } catch (e) {
    note.dirty = true;
    if (D === note) setState('Gagal menyimpan', true);
    toast(e.message, 'bad');
    return null;
  }
}
async function setFlag(extra) {
  const r = await flush(D, extra);
  if (r) { if (S) load(); paintActs(); }
  return r;
}
function finish(note) { note.gone = true; closeDrawer(); if (S) load(); }

/* ---------------- aksi editor ---------------- */
function onDrawerInput(e) {
  if (!D || !S) return;
  const f = e.target.dataset?.f;
  if (!f) return;
  if (f === 'room') { setFlag({ room: e.target.value }); return; }
  if (e.type === 'change') return;
  if (f === 'title') D.title = e.target.value;
  else if (f === 'body') D.body = e.target.value;
  touch();
}

function onDrawerKey(e) {
  if (!D) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeDrawer(); return; }
  if (e.target.id === 'ntTagIn') {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(e.target); }
    else if (e.key === 'Backspace' && !e.target.value && D.tags.length) { D.tags.pop(); paintTags(); touch(); }
  }
}
document.addEventListener('focusout', e => { if (D && e.target?.id === 'ntTagIn') addTag(e.target); });

function addTag(inp) {
  const parts = inp.value.split(',').map(s => s.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
  inp.value = '';
  let ch = false;
  for (const t of parts) if (!D.tags.includes(t)) { D.tags.push(t); ch = true; }
  if (ch) { paintTags(); touch(); }
}

function insertText(text, { wrapSel = false, cursorBack = 0 } = {}) {
  if (D.mode !== 'tulis') { D.mode = 'tulis'; paintBody(); }
  const ta = $('#ntBody', drawerEl()); if (!ta) return;
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  let ins = text;
  if (wrapSel) ins = text + sel + text;
  // snippet awal baris: pastikan di awal baris
  if (/^(- \[ \] |## )$/.test(text) && a > 0 && ta.value[a - 1] !== '\n') ins = '\n' + text;
  ta.setRangeText(ins, a, b, 'end');
  if (cursorBack) ta.setSelectionRange(ta.selectionStart - cursorBack, ta.selectionStart - cursorBack);
  ta.focus();
  D.body = ta.value; touch();
}

function showPicker(kind) {
  const box = $('#ntPick', drawerEl());
  if (box.dataset.p === kind && box.innerHTML) { box.innerHTML = ''; box.dataset.p = ''; return; }
  box.dataset.p = kind;
  const items = kind === 'role'
    ? roles().map(r => `<button class="chip" data-act="nt-pickit" data-ins="@${esc(r.id)} ">@${esc(r.name)}</button>`)
    : cards().map(c => `<button class="chip" data-act="nt-pickit" data-ins="#${esc(c.id)} " title="${esc(c.title)}">#${esc(c.id)} ${esc(c.title.slice(0, 28))}</button>`);
  box.innerHTML = `<div class="nt-pick">${items.length ? items.join('') : `<span class="hint">${kind === 'role' ? 'Belum ada role di kantor ini.' : 'Belum ada kartu di board.'}</span>`}</div>`;
}

async function onDrawerClick(e) {
  const b = e.target.closest('[data-act]');
  if (!D || !S) return;
  if (!b) {
    const wl = e.target.closest('a.wl');
    if (wl) { e.preventDefault(); gotoWiki(wl.dataset.wiki); return; }
    const cd = e.target.closest('a[data-card]');
    if (cd) { e.preventDefault(); location.hash = `${base()}/board/${cd.dataset.card}`; }
    return;
  }
  const a = b.dataset.act;
  if (!a.startsWith('nt-')) return;
  if (a === 'nt-mode') { D.mode = b.dataset.m; paintBody(); }
  else if (a === 'nt-ins') insertText(b.dataset.s);
  else if (a === 'nt-bold') insertText('**', { wrapSel: true });
  else if (a === 'nt-wiki') insertText('[[]]', { cursorBack: 2 });
  else if (a === 'nt-pick') showPicker(b.dataset.p);
  else if (a === 'nt-pickit') { insertText(b.dataset.ins); }
  else if (a === 'nt-setcolor') {
    D.color = b.dataset.c;
    $('#ntEd', drawerEl()).style.setProperty('--nc', `var(--n-${D.color})`);
    $$('[data-act="nt-setcolor"]', drawerEl()).forEach(x => x.setAttribute('aria-pressed', String(x.dataset.c === D.color)));
    touch();
  }
  else if (a === 'nt-deltag') { D.tags = D.tags.filter(t => t !== b.dataset.tag); paintTags(); touch(); }
  else if (a === 'nt-pin') setFlag({ pinned: !D.pinned });
  else if (a === 'nt-wall') setFlag({ wall: !D.wall });
  else if (a === 'nt-archive') { const r = await flush(D, { archived: !D.archived }); if (r) { toast(D.archived ? 'Dipindah ke arsip.' : 'Dikeluarkan dari arsip.', 'ok'); finish(D); } }
  else if (a === 'nt-trash') { const r = await flush(D, { deleted: true }); if (r) { toast('Dipindah ke sampah.', 'ok'); finish(D); } }
  else if (a === 'nt-restore') { const r = await flush(D, { deleted: false }); if (r) { toast('Catatan dipulihkan.', 'ok'); finish(D); } }
  else if (a === 'nt-purge') purge(D);
  else if (a === 'nt-copy') copyMd();
  else if (a === 'nt-tocard') toCardModal(D);
  else if (a === 'nt-sendrole') sendRoleModal(D);
}

// centang di pratinjau (delegasi pada change agar tidak bentrok dengan klik biasa)
document.addEventListener('change', e => {
  const cb = e.target;
  if (!D || !S || cb.type !== 'checkbox' || cb.dataset.task === undefined || !cb.closest('#ntView')) return;
  D.body = toggleTask(D.body, Number(cb.dataset.task));
  $('#ntEdit', drawerEl()).innerHTML = `<div class="nt-preview" id="ntView">${md(D.body, mdOpts(true))}</div>`;
  touch();
});

function purge(note) {
  confirmDo('Hapus permanen?', 'Catatan ini tidak bisa dikembalikan lagi.', 'Hapus permanen', async () => {
    try { await del(url('/' + encodeURIComponent(note.id))); toast('Catatan dihapus permanen.', 'ok'); finish(note); }
    catch (e) { toast(e.message, 'bad'); }
  });
}

async function copyMd() {
  const text = (D.title ? `# ${D.title}\n\n` : '') + D.body;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    t.remove();
    if (!ok) { toast('Gagal menyalin. Salin manual dari kotak teks.', 'bad'); return; }
  }
  toast('Markdown disalin.', 'ok');
}

function toCardModal(note) {
  const rs = roles();
  modal({
    title: 'Jadikan kartu',
    html: `<div class="nt-form">
      <label class="check"><input type="radio" name="ntMode" value="one" checked> Satu kartu untuk seluruh catatan (item centang jadi checklist)</label>
      <label class="check"><input type="radio" name="ntMode" value="each"> Satu kartu per item centang yang belum selesai</label>
      <div class="grid2">
        <div class="field"><label for="ntWho">Penanggung jawab</label><select id="ntWho"><option value="">Belum ditugaskan</option>${rs.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="ntRepo">Repo / ruangan</label><input type="text" id="ntRepo" list="ntRepoL" value="${esc(note.room || '')}"><datalist id="ntRepoL">${rooms().map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</datalist></div>
      </div></div>`,
    actions: [{
      label: 'Buat kartu', kind: 'primary', fn: () => {
        const mode = document.querySelector('input[name=ntMode]:checked')?.value || 'one';
        const who = $('#ntWho').value, repo = $('#ntRepo').value.trim();
        post(url(`/${encodeURIComponent(note.id)}/to-card`), { mode, who: who || undefined, repo: repo || undefined }).then(r => {
          const ids = r.cards || [];
          toast(ids.length > 1 ? `${ids.length} kartu dibuat.` : 'Kartu dibuat.', 'ok');
          if (ids[0]) {
            const a = document.createElement('a');
            a.href = `${base()}/board/${ids[0]}`; a.textContent = 'Buka di board'; a.style.cssText = 'color:inherit;text-decoration:underline;margin-left:8px';
            $('#toasts').lastElementChild?.append(a);
          }
        }).catch(err => toast(err.message, 'bad'));
      },
    }, { label: 'Batal' }],
  });
}

function sendRoleModal(note) {
  const rs = roles();
  if (!rs.length) { toast('Belum ada role di kantor ini.', 'warn'); return; }
  modal({
    title: 'Kirim ke role',
    body: 'Catatan ditambahkan ke buku catatan role yang dipilih.',
    html: `<div class="nt-form"><div class="field"><label for="ntRole">Role</label><select id="ntRole">${rs.map(r => `<option value="${esc(r.id)}">${esc(r.name)}${r.title ? ' · ' + esc(r.title) : ''}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="ntLive"> Kirim juga ke sesi yang sedang jalan</label></div>`,
    actions: [{
      label: 'Kirim', kind: 'primary', fn: () => {
        const role = $('#ntRole').value, live = $('#ntLive').checked;
        post(url(`/${encodeURIComponent(note.id)}/send-role`), { role, live })
          .then(r => toast(r.live ? 'Terkirim ke buku catatan dan sesi yang jalan.' : 'Masuk ke buku catatan role.', 'ok'))
          .catch(err => toast(err.message, 'bad'));
      },
    }, { label: 'Batal' }],
  });
}

/* ---------------- realtime ---------------- */
const reload = debounce(() => load(), 300);
const refreshOpen = debounce(async () => {
  if (!S || !D) return;
  const mine = D;
  if (mine.dirty) return;
  const ta = document.activeElement;
  if (ta && drawerEl().contains(ta) && /^(TEXTAREA|INPUT)$/.test(ta.tagName)) return;
  let n; try { n = await fetchNote(mine.id); } catch { return; }
  if (!n || D !== mine || mine.dirty || n.updatedAt === mine.updatedAt) return;
  Object.assign(mine, n, { tags: [...(n.tags || [])], dirty: false });
  $('#ntTitle', drawerEl()).value = mine.title;
  $('#ntEd', drawerEl()).style.setProperty('--nc', `var(--n-${mine.color})`);
  $$('[data-act="nt-setcolor"]', drawerEl()).forEach(x => x.setAttribute('aria-pressed', String(x.dataset.c === mine.color)));
  paintBody();
  setState('Diperbarui oleh ' + (n.author || 'orang lain'));
}, 400);

export function live(msg) {
  if (!S || msg.t !== 'changed' || msg.what !== 'notes') return;
  if (msg.office !== '*' && msg.office !== oid()) return;
  reload();
  if (D && (!msg.note || msg.note === D.id)) refreshOpen();
}
