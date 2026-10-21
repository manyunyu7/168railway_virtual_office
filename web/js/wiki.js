import { $, $$, esc, ago, api, post, del, toast, modal, closeModal, confirmDo, md, diffLines, debounce } from './util.js';

let W = null; // {el, ctx, pages, sources, page, ref, mode, ed, q, hint}

const oid = () => W.ctx.office.id;
const isK = () => oid() === '_kompleks';
const base = () => (isK() ? '#/kompleks' : '#/o/' + oid());
const url = (p = '') => `/api/offices/${encodeURIComponent(oid())}/${p}`;
const href = slug => `${base()}/wiki/${encodeURIComponent(slug)}`;
const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const findPage = t => { const l = String(t).toLowerCase(); return W.pages.find(p => p.title.toLowerCase() === l || p.slug === slugify(t)); };

const TEMPLATES = [
  ['Kosong', ''],
  ['Runbook deploy', `# Runbook deploy

## Kapan dipakai
Jelaskan situasi yang membutuhkan runbook ini.

## Prasyarat
- [ ] Branch sudah di-merge dan tes lulus
- [ ] Akses ke server / layanan tersedia

## Langkah
1. Langkah pertama
2. Langkah kedua
3. Langkah ketiga

## Verifikasi
Apa yang dicek setelah deploy selesai.

## Rollback
Cara membatalkan bila ada masalah.

## Kontak
Siapa yang dihubungi bila macet.
`],
  ['Keputusan (ADR)', `# Keputusan: judul singkat

Status: diusulkan
Tanggal:

## Konteks
Masalah apa yang sedang dihadapi dan batasan apa yang berlaku.

## Keputusan
Apa yang diputuskan, dalam satu atau dua kalimat.

## Alternatif yang dipertimbangkan
- Opsi A: kelebihan dan kekurangan
- Opsi B: kelebihan dan kekurangan

## Konsekuensi
Apa yang jadi lebih mudah, apa yang jadi lebih sulit, dan apa yang perlu dikerjakan setelahnya.
`],
  ['Onboarding repo', `# Onboarding repo

## Gambaran
Repo ini untuk apa dan siapa pemakainya.

## Menjalankan di lokal
\`\`\`
# perintah instalasi
# perintah menjalankan
\`\`\`

## Struktur folder
- \`src/\` — kode utama
- \`tests/\` — tes

## Perintah penting
- Tes:
- Lint:
- Build:

## Yang perlu diketahui
- Konvensi commit dan branch
- Hal-hal yang jangan disentuh
`],
  ['Panduan role', `# Panduan role: nama role

## Tugas utama
Apa yang menjadi tanggung jawab role ini.

## Cara kerja
- Mulai dari kartu di board yang ditugaskan
- Catat progres di komentar kartu

## Batasan
Hal yang tidak boleh dilakukan tanpa izin.

## Serah terima
Kapan dan kepada siapa pekerjaan diserahkan.
`],
  ['Notulen rapat', `# Notulen rapat: topik

Tanggal:
Peserta:

## Agenda
1.

## Pembahasan
-

## Keputusan
-

## Tindak lanjut
- [ ] Tugas — penanggung jawab
`],
];

/* ---------------- siklus ---------------- */
export async function render(el, ctx, route) {
  W = { el, ctx, pages: [], sources: [], page: null, ref: null, mode: 'view', ed: null, q: '', hint: '', src: null };
  el.innerHTML = `<div class="wiki-layout">
    <aside class="wiki-side">
      <input type="search" id="wkQ" placeholder="Cari di wiki" aria-label="Cari di wiki">
      <button class="btn primary" data-act="wk-new">Halaman baru</button>
      <div id="wkList"></div>
      ${isK() ? '' : '<div id="wkSrc"></div>'}
    </aside>
    <div id="wkMain"></div></div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  $('#wkQ', el).addEventListener('input', debounce(e => { W.q = e.target.value.trim(); paintList(); }, 250));
  window.addEventListener('beforeunload', onBeforeUnload);
  await Promise.all([loadList(), loadSources()]);
  await show(route?.rest?.[0] || 'beranda');
}

export function unmount() { window.removeEventListener('beforeunload', onBeforeUnload); W = null; }

function onBeforeUnload(e) { if (W && dirty()) { e.preventDefault(); e.returnValue = ''; } }

const dirty = () => W.mode === 'edit' && W.ed && (W.ed.title !== W.ed.title0 || W.ed.body !== W.ed.body0);

export function route(r) {
  if (!W) return;
  const ref = r?.rest?.[0] || 'beranda';
  if (W.mode === 'view' && W.page && !W.src && (ref === W.page.slug || ref.toLowerCase() === W.page.title.toLowerCase())) return;
  if (W.mode === 'edit' && W.ed && ref === (W.ed.prevSlug || W.ed.ref)) return;
  guard(() => show(ref), () => {
    const cur = W.ed?.prevSlug || W.page?.slug;
    if (cur) try { history.replaceState(null, '', href(cur)); } catch {}
  });
}

/** Jalankan fn; bila ada perubahan yang belum disimpan, tanya dulu. */
function guard(fn, onStay) {
  if (!dirty()) { fn(); return; }
  onStay?.();
  modal({
    title: 'Perubahan belum disimpan',
    body: 'Halaman yang sedang diubah punya perubahan yang belum disimpan. Kalau pindah sekarang, perubahan itu hilang.',
    actions: [{ label: 'Buang dan pindah', kind: 'danger', fn: () => { W.mode = 'view'; W.ed = null; fn(); } }, { label: 'Lanjut menyunting' }],
  });
}

function navTo(slug) { const h = href(slug); if (location.hash === h) show(slug); else location.hash = h; }

/* ---------------- data ---------------- */
async function loadList() {
  try { W.pages = await api(url('wiki')) || []; } catch (e) { toast(e.message, 'bad'); }
  W.pages.sort((a, b) => (a.slug === 'beranda' ? -1 : b.slug === 'beranda' ? 1 : a.title.localeCompare(b.title, 'id')));
  paintList();
}
async function loadSources() {
  if (isK()) return;
  try { W.sources = await api(url('wiki-sources')) || []; } catch { W.sources = []; }
  paintSources();
}

async function show(ref) {
  W.src = null; W.mode = 'view'; W.ed = null; W.hint = '';
  let p = null;
  try { p = await api(url('wiki/page?ref=' + encodeURIComponent(ref))); } catch (e) { toast(e.message, 'bad'); }
  if (!W) return;
  W.ref = ref; W.page = p;
  if (p && p.slug !== ref) try { history.replaceState(null, '', href(p.slug)); } catch {}
  paintList(); paintMain();
}

/* ---------------- sidebar ---------------- */
async function paintList() {
  const box = $('#wkList', W.el); if (!box) return;
  if (W.q) {
    let res = [];
    try { res = await api(url('wiki-search?q=' + encodeURIComponent(W.q))) || []; } catch (e) { toast(e.message, 'bad'); }
    if (!W || !W.q) return;
    box.innerHTML = `<h3 class="wk-h">Hasil pencarian</h3>${res.length
      ? `<ul class="wk-res">${res.map(r => `<li><a href="${href(r.slug)}"><b>${esc(r.title)}</b><span>${esc(r.snippet || '')}</span></a></li>`).join('')}</ul>`
      : '<p class="hint">Tidak ada halaman yang cocok.</p>'}`;
    return;
  }
  const cur = W.page?.slug;
  box.innerHTML = `<h3 class="wk-h">Halaman</h3>${W.pages.length
    ? `<ul>${W.pages.map(p => `<li><a href="${href(p.slug)}" ${!W.src && p.slug === cur ? 'aria-current="true"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul>`
    : '<p class="hint">Belum ada halaman.</p>'}`;
}
function paintSources() {
  const box = $('#wkSrc', W.el); if (!box) return;
  box.innerHTML = `<h3 class="wk-h">Dari repo (hanya baca)</h3>${W.sources.length
    ? `<ul>${W.sources.map(s => `<li><button data-act="wk-src" data-file="${esc(s.file)}" data-label="${esc(s.label)}" ${W.src?.file === s.file ? 'aria-current="true"' : ''} title="${esc(s.file)}">${esc(s.label)}</button></li>`).join('')}</ul>`
    : '<p class="hint">Tidak ada CLAUDE.md, AGENTS.md, atau memory yang ditemukan.</p>'}`;
}

/* ---------------- konten utama ---------------- */
function mdOpts() {
  const o = W.ctx.office;
  return { roles: o.roles || [], cardIds: new Set((o.cards || []).map(c => c.id)), wiki: t => !!findPage(t) };
}

function paintMain() {
  const m = $('#wkMain', W.el); if (!m) return;
  paintSources();
  if (W.src) return paintSource(m);
  if (W.mode === 'edit') return paintEditor(m);
  if (W.mode === 'hist') return paintHistory(m);
  const p = W.page;
  if (!p) {
    const title = W.ref && W.ref !== 'beranda' ? W.ref.replace(/-/g, ' ') : 'Beranda';
    m.innerHTML = `<div class="wiki-page wk-empty"><h1>${esc(W.ref === 'beranda' ? 'Beranda belum ditulis' : 'Halaman belum ada')}</h1>
      <p>${W.ref === 'beranda' ? 'Beranda adalah halaman pertama yang dibuka orang dan agen.' : 'Belum ada halaman dengan nama ini.'} Wiki ini bisa dibaca dan ditulis oleh kamu maupun para role lewat MCP kantor (wiki_search, wiki_read, wiki_write).</p>
      <div class="btn-row"><button class="btn primary" data-act="wk-create" data-title="${esc(title.charAt(0).toUpperCase() + title.slice(1))}">Buat halaman ini</button></div></div>`;
    return;
  }
  m.innerHTML = `<article class="wiki-page">
    <div class="wiki-meta"><span>${esc(p.author || 'Tidak diketahui')} · ${ago(p.updatedAt)} · ${p.revs || 1} revisi</span>
      <span class="btn-row"><button class="btn sm" data-act="wk-edit">Ubah</button><button class="btn sm" data-act="wk-hist">Riwayat</button>${p.slug === 'beranda' ? '' : '<button class="btn sm danger" data-act="wk-del">Hapus</button>'}</span></div>
    ${W.hint ? `<p class="notice info">${esc(W.hint)}</p>` : ''}
    ${/^\s*#\s/.test(p.body || '') ? '' : `<h1 class="wk-title">${esc(p.title)}</h1>`}
    ${md(p.body, mdOpts())}
    ${p.backlinks?.length ? `<section class="wk-back"><h3 class="wk-h">Ditautkan dari</h3><div class="chips">${p.backlinks.map(b => `<a class="chip" href="${href(b.slug)}">${esc(b.title)}</a>`).join('')}</div></section>` : ''}
  </article>`;
}

/* ---------------- editor ---------------- */
function startEdit(page, { title = '', tpl = true } = {}) {
  const isNew = !page;
  W.mode = 'edit'; W.src = null;
  W.ed = isNew
    ? { isNew, title, body: '', title0: '', body0: '', msg: '', ref: '', tpl: 0, showTpl: tpl }
    : { isNew, title: page.title, body: page.body, title0: page.title, body0: page.body, msg: '', prevSlug: page.slug, ref: page.slug };
  if (isNew && title) W.ed.title0 = ''; // judul bawaan dihitung sebagai perubahan agar tidak hilang diam-diam
  paintList(); paintMain();
  setTimeout(() => $(isNew && !title ? '#wkTitle' : '#wkBody', W.el)?.focus(), 20);
}

function paintEditor(m) {
  const e = W.ed;
  m.innerHTML = `<div class="wiki-page wk-editor">
    ${e.isNew && e.showTpl ? `<div class="field"><label>Mulai dari</label><div class="chips">${TEMPLATES.map(([n], i) => `<button class="chip" data-act="wk-tpl" data-i="${i}" aria-pressed="${e.tpl === i}">${esc(n)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label for="wkTitle">Judul</label><input type="text" id="wkTitle" data-f="title" value="${esc(e.title)}" placeholder="Judul halaman"></div>
    <div class="wiki-edit">
      <div class="field"><label for="wkBody">Isi (markdown)</label><textarea id="wkBody" data-f="body" placeholder="Tulis dengan markdown. Tautkan halaman lain dengan [[Judul]].">${esc(e.body)}</textarea></div>
      <div class="field"><label>Pratinjau</label><div class="preview" id="wkPrev"></div></div>
    </div>
    <div class="field"><label for="wkMsg">Ringkasan perubahan</label><input type="text" id="wkMsg" data-f="msg" value="${esc(e.msg)}" placeholder="Opsional, mis. menambah langkah rollback"></div>
    <div class="btn-row"><button class="btn primary" data-act="wk-save">Simpan</button><button class="btn" data-act="wk-cancel">Batal</button></div></div>`;
  paintPreview();
}
function paintPreview() { const p = $('#wkPrev', W.el); if (p) p.innerHTML = W.ed.body.trim() ? md(W.ed.body, { ...mdOpts(), taskIndex: false }) : '<p class="empty-line">Pratinjau muncul di sini.</p>'; }

function onInput(e) {
  if (!W || W.mode !== 'edit' || !W.ed) return;
  const f = e.target.dataset?.f; if (!f) return;
  W.ed[f] = e.target.value;
  if (f === 'body') paintPreview();
}

async function save() {
  const e = W.ed;
  const title = e.title.trim();
  if (!title) { toast('Judul wajib diisi.', 'warn'); $('#wkTitle', W.el)?.focus(); return; }
  try {
    const p = await post(url('wiki'), { title, body: e.body, msg: e.msg.trim() || undefined, prevSlug: e.prevSlug });
    toast('Halaman disimpan.', 'ok');
    W.mode = 'view'; W.ed = null; W.page = p; W.ref = p.slug; W.hint = '';
    await loadList();
    try { history.replaceState(null, '', href(p.slug)); } catch {}
    paintMain();
  } catch (err) { toast(err.message, 'bad'); }
}

/* ---------------- riwayat ---------------- */
async function openHistory() {
  W.mode = 'hist'; W.revs = null; W.sel = null;
  paintMain();
  try { W.revs = await api(url('wiki-revs/' + encodeURIComponent(W.page.slug))) || []; } catch (e) { toast(e.message, 'bad'); W.revs = []; }
  if (W?.mode === 'hist') paintMain();
}
function paintHistory(m) {
  const p = W.page;
  const rows = W.revs ? W.revs.map(r => `<tr class="click" data-act="wk-rev" data-id="${esc(r.id)}" ${W.sel?.id == r.id ? 'aria-selected="true"' : ''}><td>#${esc(r.id)}</td><td>${esc(r.author || '')}</td><td>${ago(r.at)}</td><td>${esc(r.msg || '')}</td><td class="num">${esc(r.size ?? '')}</td></tr>`).join('') : '';
  m.innerHTML = `<div class="wiki-page">
    <div class="wiki-meta"><b>Riwayat: ${esc(p.title)}</b><button class="btn sm" data-act="wk-back">Kembali ke halaman</button></div>
    ${!W.revs ? '<p class="empty-line">Memuat riwayat…</p>' : !W.revs.length ? '<p class="empty-line">Belum ada riwayat.</p>'
      : `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rev</th><th>Penulis</th><th>Kapan</th><th>Ringkasan</th><th class="num">Ukuran</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Pilih satu revisi untuk melihat perbedaannya dengan versi sekarang.</p>`}
    ${W.sel ? `<section class="wk-diff"><h3 class="wk-h">Versi sekarang menjadi revisi #${esc(W.sel.id)}</h3>
      <pre class="diff">${diffLines(p.body || '', W.sel.body || '')}</pre>
      <div class="btn-row"><button class="btn primary" data-act="wk-restore">Pulihkan versi ini</button></div></section>` : ''}
  </div>`;
}
async function pickRev(id) {
  try { W.sel = await api(url('wiki-rev/' + encodeURIComponent(id))); } catch (e) { toast(e.message, 'bad'); return; }
  if (W?.mode === 'hist') paintMain();
}
async function restore() {
  const r = W.sel; if (!r) return;
  try {
    const p = await post(url('wiki'), { title: r.title, body: r.body, msg: `Pulihkan revisi #${r.id}`, prevSlug: W.page.slug });
    toast('Versi dipulihkan.', 'ok');
    W.mode = 'view'; W.page = p; W.ref = p.slug; W.sel = null;
    await loadList();
    try { history.replaceState(null, '', href(p.slug)); } catch {}
    paintMain();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- sumber repo ---------------- */
async function openSource(file, label) {
  guard(async () => {
    W.mode = 'view'; W.ed = null; W.src = { file, label, text: null };
    paintList(); paintMain();
    try { const r = await api(url('wiki-source?file=' + encodeURIComponent(file))); if (W?.src?.file === file) W.src.text = r.text || ''; }
    catch (e) { toast(e.message, 'bad'); if (W?.src) W.src.text = ''; }
    if (W?.src?.file === file) paintMain();
  });
}
function paintSource(m) {
  const s = W.src;
  m.innerHTML = `<article class="wiki-page"><div class="wiki-meta"><b>${esc(s.label)}</b><span>${esc(s.file)}</span></div>
    <p class="notice info">Sumber dari disk, ubah lewat repo.</p>
    ${s.text === null ? '<p class="empty-line">Memuat…</p>' : s.text.trim() ? md(s.text, { wiki: () => true, taskIndex: false }) : '<p class="empty-line">File kosong.</p>'}</article>`;
}

/* ---------------- klik ---------------- */
function onClick(e) {
  if (!W) return;
  const wl = e.target.closest('a.wl');
  if (wl) {
    e.preventDefault();
    const t = wl.dataset.wiki, p = findPage(t);
    if (W.src) { if (p) guard(() => navTo(p.slug)); else guard(() => startEdit(null, { title: t })); return; }
    guard(() => p ? navTo(p.slug) : startEdit(null, { title: t }));
    return;
  }
  const cd = e.target.closest('a[data-card]');
  if (cd) { e.preventDefault(); location.hash = `${base()}/board/${cd.dataset.card}`; return; }
  const a = e.target.closest('a[href^="#/"]');
  if (a && W.mode === 'edit' && dirty()) { e.preventDefault(); guard(() => { location.hash = a.getAttribute('href'); }); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (!act.startsWith('wk-')) return;
  if (act === 'wk-new') guard(() => startEdit(null));
  else if (act === 'wk-create') startEdit(null, { title: b.dataset.title });
  else if (act === 'wk-edit') startEdit(W.page);
  else if (act === 'wk-cancel') guard(() => { W.mode = 'view'; W.ed = null; if (!W.page && W.ref) show(W.ref); else paintMain(); paintList(); });
  else if (act === 'wk-save') save();
  else if (act === 'wk-tpl') {
    const i = Number(b.dataset.i), ed = W.ed, prev = TEMPLATES[ed.tpl][1];
    if (ed.body && ed.body !== prev) { toast('Isi sudah ditulis, template tidak menimpa.', 'warn'); return; }
    ed.tpl = i; ed.body = TEMPLATES[i][1];
    $('#wkBody', W.el).value = ed.body; paintPreview();
    $$('[data-act="wk-tpl"]', W.el).forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.i) === i)));
  }
  else if (act === 'wk-hist') openHistory();
  else if (act === 'wk-back') { W.mode = 'view'; paintMain(); }
  else if (act === 'wk-rev') pickRev(b.dataset.id);
  else if (act === 'wk-restore') restore();
  else if (act === 'wk-src') openSource(b.dataset.file, b.dataset.label);
  else if (act === 'wk-del') {
    const p = W.page;
    confirmDo('Hapus halaman?', `Halaman "${esc(p.title)}" dan riwayatnya akan dihapus.`, 'Hapus', async () => {
      try { await del(url('wiki/' + encodeURIComponent(p.slug))); toast('Halaman dihapus.', 'ok'); await loadList(); navTo('beranda'); }
      catch (err) { toast(err.message, 'bad'); }
    });
  }
}

/* ---------------- realtime ---------------- */
const refreshCurrent = debounce(async () => {
  if (!W || W.mode !== 'view' || W.src) return;
  const ref = W.page?.slug || W.ref;
  let p = null;
  try { p = await api(url('wiki/page?ref=' + encodeURIComponent(ref))); } catch { return; }
  if (!W || W.mode !== 'view' || W.src) return;
  if (!p && !W.page) return;
  if (p && W.page && p.updatedAt === W.page.updatedAt) { W.page = p; return; }
  W.hint = p ? `Halaman diperbarui oleh ${p.author || 'seseorang'} ${ago(p.updatedAt)}.` : '';
  W.page = p;
  paintMain();
}, 400);

export function live(msg) {
  if (!W || msg.t !== 'changed' || msg.what !== 'wiki') return;
  if (msg.office !== '*' && msg.office !== oid()) return;
  loadList();
  if (!msg.slug || msg.slug === (W.page?.slug || W.ref)) refreshCurrent();
}
