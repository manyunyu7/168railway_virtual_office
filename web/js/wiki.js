import { $, $$, esc, ago, api, post, del, toast, modal, closeModal, confirmDo, md, diffLines, debounce, dateLong, sprite, mini } from './util.js';
import { PB_TEMPLATE } from './playbooks.js';

let W = null; // {el, ctx, pages, sources, page, ref, mode, ed, q, hint, open, pop, up}

const oid = () => W.ctx.office.id;
const isK = () => oid() === '_kompleks';
const base = () => (isK() ? '#/kompleks' : '#/o/' + oid());
const url = (p = '') => `/api/offices/${encodeURIComponent(oid())}/${p}`;
const href = slug => `${base()}/wiki/${encodeURIComponent(slug)}`;
const slugify = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const EMOJI = '📄 📘 📗 📙 📕 📓 📚 🗂️ 📁 🧭 🚀 🛠️ ⚙️ 🔧 🧪 🐛 🔒 🔑 🌐 📱 💻 🖥️ 🗄️ ☁️ 📦 🧩 🎯 💡 ⭐ 🔥 ✅ ⚠️ 📌 📝 📊 📈 💰 🧾 👥 🤝 📅 ⏱️ 🏗️ 🎨 🎵 🚆 🗺️ 🏠 ❓'.split(' ');
const ic = i => (i ? `<span class="wk-ic" aria-hidden="true">${esc(i)}</span>` : '');
const OPEN_KEY = () => 'kc.wiki.open.' + oid();
const loadOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY()) || '[]')); } catch { return new Set(); } };
const saveOpen = () => { try { localStorage.setItem(OPEN_KEY(), JSON.stringify([...W.open])); } catch {} };
const byId = slug => W.pages.find(p => p.slug === slug);
/** Children of a parent slug ('' = top level), in display order. */
function kids(parent) {
  const has = new Set(W.pages.map(p => p.slug));
  return W.pages.filter(p => (p.parent && has.has(p.parent) ? p.parent : '') === (parent || ''))
    .sort((a, b) => (a.ord - b.ord) || (a.slug === 'beranda' ? -1 : b.slug === 'beranda' ? 1 : a.title.localeCompare(b.title, 'id')));
}
const isDesc = (slug, anc) => { for (let c = byId(slug), i = 0; c && i < 100; c = byId(c.parent), i++) if (c.parent === anc) return true; return false; };
function descendants(slug) { const out = []; (function walk(s) { for (const k of kids(s)) { out.push(k); walk(k.slug); } })(slug); return out; }
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

const roleById = id => (W.ctx.office.roles || []).find(r => r.id === id);
const roleNames = ids => (ids || []).map(id => roleById(id)?.name || id);

/* ---------------- siklus ---------------- */
export async function render(el, ctx, route) {
  W = { el, ctx, pages: [], sources: [], page: null, ref: null, mode: 'view', ed: null, q: '', hint: '', src: null, open: null, pop: null, up: 0, props: [], pbOnly: false, showProps: false, prop: null };
  W.open = loadOpen();
  el.innerHTML = `<div class="wiki-layout">
    <aside class="wiki-side">
      <input type="search" id="wkQ" placeholder="Cari di wiki" aria-label="Cari di wiki">
      <div class="btn-row"><button class="btn primary" data-act="wk-new">Halaman baru</button><button class="btn" data-act="wk-pb-new" title="Prosedur baku yang dipegang satu role atau lebih">+ Playbook baru</button></div>
      <div class="chips" id="wkFilt"></div>
      <div id="wkProps"></div>
      <div id="wkList" class="wk-list"></div>
      ${isK() ? '' : '<div id="wkSrc"></div>'}
    </aside>
    <div id="wkMain"></div></div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  for (const t of ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend']) el.addEventListener(t, onDrag);
  el.addEventListener('paste', onPaste);
  el.addEventListener('change', e => { if (e.target.id === 'wkFile') { uploadFiles([...e.target.files], $('#wkBody', W.el)); e.target.value = ''; } });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'wkIcoIn') { e.preventDefault(); setIcon(e.target.value.trim()); } });
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
  try { W.props = isK() ? [] : await api(url('wiki-proposals')) || []; } catch { W.props = []; }
  openAncestors(W.page?.slug);
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
  W.ref = ref; W.page = p; W.pop = null;
  openAncestors(p?.slug);
  if (p?.children?.length && !W.open.has(p.slug)) { W.open.add(p.slug); saveOpen(); }
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
  const cur = W.src ? null : W.page?.slug;
  paintFilter();
  if (W.pbOnly) {
    const pbs = W.pages.filter(p => p.playbook).sort((a, b) => a.title.localeCompare(b.title, 'id'));
    box.innerHTML = `<h3 class="wk-h">Playbook</h3>${pbs.length ? `<ul class="wk-tree pb-list" role="list">${pbs.map(p => `<li><div class="wk-row${p.slug === cur ? ' cur' : ''}" data-slug="${esc(p.slug)}"><a href="${href(p.slug)}" ${p.slug === cur ? 'aria-current="true"' : ''} title="${esc(p.title)}">${p.icon ? ic(p.icon) : '<span class="wk-ic" aria-hidden="true">📘</span>'}<span class="wk-t">${esc(p.title)}</span></a></div>${p.roles?.length ? `<div class="pb-who">${p.roles.map(id => roleById(id) ? mini(roleById(id)) : '').join('')}<span>${esc(roleNames(p.roles).join(', '))}</span></div>` : ''}</li>`).join('')}</ul>` : '<p class="hint">Belum ada playbook. Buka halaman lalu pilih "Jadikan playbook".</p>'}`;
    return;
  }
  const row = p => {
    const ks = kids(p.slug), open = ks.length && W.open.has(p.slug);
    return `<li role="treeitem" ${ks.length ? `aria-expanded="${!!open}"` : ''}><div class="wk-row${p.slug === cur ? ' cur' : ''}" draggable="true" data-slug="${esc(p.slug)}">
      ${ks.length ? `<button class="wk-tg" data-act="wk-tg" data-slug="${esc(p.slug)}" aria-label="${open ? 'Ciutkan' : 'Buka'} ${esc(p.title)}">${open ? '▾' : '▸'}</button>` : '<span class="wk-tg"></span>'}
      <a href="${href(p.slug)}" ${p.slug === cur ? 'aria-current="true"' : ''} title="${esc(p.title)}">${p.icon ? ic(p.icon) : '<span class="wk-ic dim" aria-hidden="true">·</span>'}<span class="wk-t">${esc(p.title)}</span>${p.playbook ? '<span class="pb-mark" title="Playbook" aria-label="Playbook">📘</span>' : ''}</a></div>
      ${open ? `<ul role="group">${ks.map(row).join('')}</ul>` : ''}</li>`;
  };
  box.innerHTML = `<h3 class="wk-h">Halaman</h3>${W.pages.length
    ? `<ul class="wk-tree" role="tree">${kids('').map(row).join('')}</ul><div class="wk-rootzone" data-root="1">Lepas di sini untuk jadikan halaman utama</div>`
    : '<p class="hint">Belum ada halaman.</p>'}`;
}
function paintFilter() {
  const f = $('#wkFilt', W.el), pr = $('#wkProps', W.el); if (!f) return;
  const n = W.pages.filter(p => p.playbook).length;
  f.innerHTML = `<button class="chip" data-act="wk-pbf" aria-pressed="${W.pbOnly}">📘 Playbook${n ? ` · ${n}` : ''}</button>`;
  if (!pr) return;
  const k = W.props.length;
  pr.innerHTML = k ? `<button class="pb-badge" data-act="wk-props" aria-expanded="${W.showProps}"><b>${k}</b> usulan menunggu</button>${W.showProps ? `<ul class="pb-props">${W.props.map(x => `<li><a href="${href(x.slug)}" data-act="wk-prop" data-slug="${esc(x.slug)}" data-uid="${esc(x.id)}"><b>${esc(x.title || x.page?.title || x.slug)}</b><span>${esc(x.by || '')} · ${esc(x.reason || '')}</span></a></li>`).join('')}</ul>` : ''}` : '';
}
function openAncestors(slug) {
  let ch = false;
  for (let c = byId(byId(slug)?.parent), i = 0; c && i < 100; c = byId(c.parent), i++) if (!W.open.has(c.slug)) { W.open.add(c.slug); ch = true; }
  if (ch) saveOpen();
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
  if (W.mode === 'prop') return paintProposal(m);
  const p = W.page;
  if (!p) {
    const title = W.ref && W.ref !== 'beranda' ? W.ref.replace(/-/g, ' ') : 'Beranda';
    m.innerHTML = `<div class="wiki-page wk-empty"><h1>${esc(W.ref === 'beranda' ? 'Beranda belum ditulis' : 'Halaman belum ada')}</h1>
      <p>${W.ref === 'beranda' ? 'Beranda adalah halaman pertama yang dibuka orang dan agen.' : 'Belum ada halaman dengan nama ini.'} Wiki ini bisa dibaca dan ditulis oleh kamu maupun para role lewat MCP kantor (wiki_search, wiki_read, wiki_write).</p>
      <div class="btn-row"><button class="btn primary" data-act="wk-create" data-title="${esc(title.charAt(0).toUpperCase() + title.slice(1))}">Buat halaman ini</button></div></div>`;
    return;
  }
  const hasKids = p.children?.length;
  m.innerHTML = `<article class="wiki-page" id="wkArt">
    ${p.crumbs?.length ? `<nav class="wk-crumbs" aria-label="Jalur halaman"><a href="${href('beranda')}">Wiki</a>${p.crumbs.map(c => `<span aria-hidden="true">›</span><a href="${href(c.slug)}">${ic(c.icon)}${esc(c.title)}</a>`).join('')}</nav>` : ''}
    <div class="wiki-meta"><span>${esc(p.author || 'Tidak diketahui')} · ${ago(p.updatedAt)} · ${p.revs || 1} revisi</span>
      <span class="btn-row"><button class="btn sm" data-act="wk-edit">Ubah</button><button class="btn sm" data-act="wk-sub">+ Sub-halaman</button>${p.playbook ? '' : '<button class="btn sm" data-act="wk-pb-set">📘 Jadikan playbook</button>'}<button class="btn sm" data-act="wk-icon" aria-expanded="${W.pop === 'icon'}">${p.icon ? esc(p.icon) + ' ' : ''}Ikon</button><button class="btn sm" data-act="wk-hist">Riwayat</button>${p.slug === 'beranda' ? '' : '<button class="btn sm" data-act="wk-mv">Pindahkan…</button>'}<button class="btn sm" data-act="wk-pdf">Unduh PDF</button>${hasKids ? '<button class="btn sm" data-act="wk-pdf-all" title="Cetak halaman ini diikuti semua sub-halamannya">PDF + sub-halaman</button>' : ''}${p.slug === 'beranda' ? '' : '<button class="btn sm danger" data-act="wk-del">Hapus</button>'}</span></div>
    ${W.pop === 'icon' ? `<div class="wk-pop" role="dialog" aria-label="Pilih ikon"><div class="wk-emo">${EMOJI.map(e => `<button data-act="wk-ico" data-e="${e}" aria-label="${e}">${e}</button>`).join('')}</div>
      <div class="btn-row"><input type="text" id="wkIcoIn" maxlength="4" placeholder="Ketik emoji sendiri" aria-label="Emoji sendiri"><button class="btn sm" data-act="wk-ico-in">Pakai</button>${p.icon ? '<button class="btn sm" data-act="wk-ico" data-e="">Hapus ikon</button>' : ''}</div></div>` : ''}
    ${W.hint ? `<p class="notice info">${esc(W.hint)}</p>` : ''}
    ${p.playbook ? playbookHead(p) : ''}
    ${(p.proposals || []).map(x => `<div class="pb-ban"><span><b>${esc(x.by || 'Seorang role')}</b> mengusulkan perubahan${x.reason ? ` · alasan: ${esc(x.reason)}` : ''} <small>${ago(x.at)}</small></span><button class="btn sm primary" data-act="wk-prop" data-slug="${esc(p.slug)}" data-uid="${esc(x.id)}">Lihat usulan</button></div>`).join('')}
    ${pageBody(p)}
    <section class="wk-kids"><div class="wk-kids-h"><h3 class="wk-h">Sub-halaman</h3><button class="btn sm" data-act="wk-sub">+ Sub-halaman</button></div>
      ${hasKids ? `<div class="wk-cards">${p.children.map(c => `<a class="wk-card" href="${href(c.slug)}"><span class="wk-card-i">${esc(c.icon || '📄')}</span><b>${esc(c.title)}</b><small>${ago(c.updated_at)}</small></a>`).join('')}</div>` : '<p class="hint">Belum ada sub-halaman.</p>'}</section>
    ${p.backlinks?.length ? `<section class="wk-back"><h3 class="wk-h">Ditautkan dari</h3><div class="chips">${p.backlinks.map(b => `<a class="chip" href="${href(b.slug)}">${esc(b.title)}</a>`).join('')}</div></section>` : ''}
  </article>`;
}

function playbookHead(p) {
  const b = p.playbook, ids = b.roles || [];
  return `<section class="pb-head" aria-label="Playbook">
    <div class="pb-top"><span class="pb-badge-t">📘 Playbook</span><button class="btn sm" data-act="wk-pb-set">Atur</button></div>
    <dl class="pb-facts">
      <div><dt>Dipegang oleh</dt><dd>${ids.length ? ids.map(id => { const r = roleById(id); return `<span class="pb-role">${r ? mini(r) : ''}${esc(r?.name || id)}</span>`; }).join('') : '<span class="hint">Belum ada role. Atur supaya ada yang membacanya.</span>'}</dd></div>
      <div><dt>Kapan dipakai</dt><dd>${b.when ? esc(b.when) : '<span class="hint">Belum diisi</span>'}</dd></div>
      ${b.always || b.approval ? `<div><dt>Aturan</dt><dd>${b.always ? '<span class="chip pb-flag">Selalu dibacakan</span>' : ''}${b.approval ? '<span class="chip pb-flag warn">Minta persetujuan</span>' : ''}</dd></div>` : ''}
    </dl></section>`;
}

/** Title (or the body's own h1, with the page icon) followed by the rendered body. */
function pageBody(p, o = {}) {
  let html = md(p.body, { ...mdOpts(), ...o });
  if (/^\s*#\s/.test(p.body || '')) return p.icon ? html.replace('<h1>', `<h1>${ic(p.icon)} `) : html;
  return `<h1 class="wk-title">${ic(p.icon)}${esc(p.title)}</h1>${html}`;
}

/* ---------------- playbook ---------------- */
/** Dialog "Atur playbook". `after(page)` runs once saved; page may be unsaved (preset only). */
function pbDialog(p, { roles = [], onSave = null } = {}) {
  const b = p?.playbook || { roles, when: '', always: false, approval: false };
  const all = (W.ctx.office.roles || []).filter(r => !r.archived);
  modal({
    title: p?.playbook ? `Atur playbook "${p.title}"` : `Jadikan "${p?.title || 'halaman'}" playbook`,
    html: `<div class="pb-form">
      <div class="field"><label>Dipegang oleh</label><div class="pb-roles">${all.map(r => `<label class="pb-pick"><input type="checkbox" name="pbRole" value="${esc(r.id)}" ${b.roles.includes(r.id) ? 'checked' : ''}>${mini(r)}<span><b>${esc(r.name)}</b><small>${esc(r.title)}</small></span></label>`).join('')}</div>
        <p class="hint">Role ini melihat playbook di daftar saat shift dan wajib membacanya.</p></div>
      <div class="field"><label for="pbWhen">Kapan dipakai</label><input type="text" id="pbWhen" value="${esc(b.when || '')}" placeholder="mis. Setiap kali akan merilis web ke produksi" maxlength="200"></div>
      <label class="check"><input type="checkbox" id="pbAlways" ${b.always ? 'checked' : ''}> Selalu dibacakan <small class="hint">isi lengkap ikut di prompt; pakai untuk yang singkat</small></label>
      <label class="check"><input type="checkbox" id="pbAppr" ${b.approval ? 'checked' : ''}> Minta persetujuan <small class="hint">agen bertanya dulu sebelum langkah berisiko</small></label>
    </div>`,
    actions: [
      { label: 'Simpan', kind: 'primary', fn: () => { pbSave(p, onSave); return false; } },
      ...(p?.playbook ? [{ label: 'Jadikan halaman biasa', kind: 'danger', fn: () => { pbOff(p); return false; } }] : []),
      { label: 'Batal' }],
  });
}
async function pbSave(p, onSave) {
  const roles = $$('input[name=pbRole]:checked').map(x => x.value);
  const when = $('#pbWhen').value.trim(), always = $('#pbAlways').checked, approval = $('#pbAppr').checked;
  if (onSave && !p?.slug) { closeModal(); onSave({ roles, when, always, approval }); return; }
  try {
    const page = await post(url('wiki-playbook'), { slug: p.slug, roles, when, always, approval });
    closeModal(); toast('Playbook disimpan.', 'ok');
    if (W.page?.slug === p.slug) W.page = page;
    await loadList(); if (W.mode === 'view') paintMain();
  } catch (e) { toast(e.message, 'bad'); }
}
async function pbOff(p) {
  try {
    const page = await post(url('wiki-playbook'), { slug: p.slug, on: false, roles: [], when: '', always: false, approval: false });
    closeModal(); toast('Kembali jadi halaman biasa.', 'ok');
    if (W.page?.slug === p.slug) W.page = page;
    await loadList(); if (W.mode === 'view') paintMain();
  } catch (e) { toast(e.message, 'bad'); }
}

/** Compact line diff: ops [{k:' '|'+'|'-', t}] */
function lineOps(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4e6) return [...A.map(t => ({ k: '-', t })), ...B.map(t => ({ k: '+', t }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ k: ' ', t: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ k: '-', t: A[i++] });
    else ops.push({ k: '+', t: B[j++] });
  }
  while (i < n) ops.push({ k: '-', t: A[i++] });
  while (j < m) ops.push({ k: '+', t: B[j++] });
  return ops;
}
function diffHTML(a, b, ctx = 2) {
  const ops = lineOps(a, b), keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.k !== ' ') for (let d = -ctx; d <= ctx; d++) if (ops[i + d]) keep[i + d] = true; });
  if (!ops.some(o => o.k !== ' ')) return '<span class="pb-same">Tidak ada perbedaan dengan versi sekarang.</span>';
  let out = '', skip = 0;
  const flush = () => { if (skip) { out += `<span class="pb-skip">… ${skip} baris sama</span>`; skip = 0; } };
  ops.forEach((o, i) => {
    if (!keep[i]) { skip++; return; }
    flush();
    out += o.k === '+' ? `<span class="add">+ ${esc(o.t)}</span>` : o.k === '-' ? `<span class="del">- ${esc(o.t)}</span>` : `<span class="same">  ${esc(o.t)}</span>`;
  });
  flush();
  return out;
}
async function openProposal(slug, uid) {
  guard(async () => {
    let pr = null;
    try { pr = await api(url('wiki-proposals/' + encodeURIComponent(uid))); } catch (e) { toast(e.message, 'bad'); return; }
    if (!W || !pr) return;
    if (!W.page || W.page.slug !== slug) { try { W.page = await api(url('wiki/page?ref=' + encodeURIComponent(slug))); } catch {} }
    W.src = null; W.ed = null; W.mode = 'prop'; W.prop = pr;
    if (location.hash !== href(slug)) try { history.replaceState(null, '', href(slug)); } catch {}
    paintList(); paintMain();
  });
}
function paintProposal(m) {
  const p = W.page, x = W.prop;
  m.innerHTML = `<div class="wiki-page"><div class="wiki-meta"><b>Usulan untuk: ${esc(p?.title || x.title)}</b><button class="btn sm" data-act="wk-back">Kembali ke halaman</button></div>
    <div class="pb-ban static"><span><b>${esc(x.by || 'Seorang role')}</b> mengusulkan isi baru ${x.at ? `<small>${ago(x.at)}</small>` : ''}${x.reason ? `<br>Alasan: ${esc(x.reason)}` : ''}</span></div>
    <section class="wk-diff"><h3 class="wk-h">Halaman sekarang menjadi usulan</h3>
      <pre class="diff pb-diff">${diffHTML(p?.body || '', x.body || '')}</pre>
      <div class="btn-row"><button class="btn primary" data-act="wk-prop-yes">Terima</button><button class="btn danger" data-act="wk-prop-no">Tolak</button><button class="btn" data-act="wk-back">Nanti dulu</button></div></section></div>`;
}
async function decide(accept) {
  const x = W.prop, slug = W.page?.slug || x.slug;
  try {
    await post(url('wiki-proposals/' + encodeURIComponent(x.id)), { accept });
    toast(accept ? 'Usulan diterima, halaman diperbarui.' : 'Usulan ditolak.', 'ok');
    W.mode = 'view'; W.prop = null;
    await loadList(); await show(slug);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- ikon, pindah, sub-halaman ---------------- */
async function setIcon(icon) {
  const p = W.page; if (!p) return;
  try {
    W.page = await post(url('wiki'), { title: p.title, body: p.body, prevSlug: p.slug, icon, msg: icon ? 'Ikon diubah' : 'Ikon dihapus' });
    W.pop = null; await loadList(); paintMain();
  } catch (err) { toast(err.message, 'bad'); }
}

/** Put `slug` under `parent` at position `idx` among its siblings; renumbers only what changed. */
async function placePage(slug, parent, idx) {
  const me = byId(slug); if (!me) return;
  if (parent && (parent === slug || isDesc(parent, slug))) { toast('Halaman tidak bisa dipindah ke dalam anaknya sendiri.', 'warn'); return; }
  const sibs = kids(parent).filter(x => x.slug !== slug);
  sibs.splice(idx == null ? sibs.length : Math.min(idx, sibs.length), 0, me);
  const jobs = [];
  sibs.forEach((x, i) => {
    const ord = (i + 1) * 10, body = {};
    if (x.slug === slug && (x.parent || null) !== (parent || null)) body.parent = parent || '';
    if (x.ord !== ord) body.ord = ord;
    if (Object.keys(body).length) jobs.push({ slug: x.slug, ...body });
  });
  if (!jobs.length) return;
  try {
    let list = null;
    for (const j of jobs) list = await post(url('wiki-move'), j);
    if (list) W.pages = list;
    if (parent) { W.open.add(parent); saveOpen(); }
    if (W.mode === 'view' && W.page && !W.src) show(W.page.slug);
    paintList();
  } catch (err) { toast(err.message, 'bad'); loadList(); }
}

function moveDialog() {
  const p = W.page; if (!p) return;
  const opts = []; (function walk(par, d) { for (const k of kids(par)) { if (k.slug === p.slug || isDesc(k.slug, p.slug)) continue; opts.push(`<option value="${esc(k.slug)}" ${k.slug === p.parent ? 'selected' : ''}>${'\u00a0\u00a0'.repeat(d)}${esc((k.icon || '') + ' ' + k.title)}</option>`); walk(k.slug, d + 1); } })('', 0);
  modal({
    title: `Pindahkan "${p.title}"`,
    html: `<div class="field"><label for="wkMvSel">Jadikan sub-halaman dari</label><select id="wkMvSel"><option value="" ${p.parent ? '' : 'selected'}>(Halaman utama)</option>${opts.join('')}</select></div>`,
    actions: [{ label: 'Pindahkan', kind: 'primary', fn: () => { const v = $('#wkMvSel').value; if (v !== (p.parent || '')) placePage(p.slug, v || null, null); } }, { label: 'Batal' }],
  });
}

/* drag & drop pada pohon: bagian atas/bawah baris = urutan, tengah = jadi anak */
let drag = null;
function dropSpot(e) {
  const zone = e.target.closest?.('.wk-rootzone');
  if (zone) return { el: zone, parent: null, idx: null };
  const row = e.target.closest?.('.wk-row'); if (!row || !drag) return null;
  const t = row.dataset.slug; if (t === drag || isDesc(t, drag)) return null;
  const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height, pg = byId(t);
  if (y > .28 && y < .72) return { el: row, cls: 'in', parent: t, idx: null };
  const sibs = kids(pg.parent || '').filter(x => x.slug !== drag), at = sibs.findIndex(x => x.slug === t);
  return y <= .28 ? { el: row, cls: 'before', parent: pg.parent || null, idx: at } : { el: row, cls: 'after', parent: pg.parent || null, idx: at + 1 };
}
function clearDz() { $$('.dz-in,.dz-before,.dz-after,.dz-root', W.el).forEach(x => x.classList.remove('dz-in', 'dz-before', 'dz-after', 'dz-root')); }
function onDrag(e) {
  if (!W) return;
  if (e.type === 'dragstart') {
    const r = e.target.closest?.('.wk-row'); if (!r) return;
    drag = r.dataset.slug; e.dataTransfer.setData('text/plain', drag); e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => $('#wkList', W.el)?.classList.add('dragging'), 0);
    return;
  }
  if (e.type === 'dragend') { drag = null; clearDz(); $('#wkList', W.el)?.classList.remove('dragging'); return; }
  const ed = e.target.id === 'wkBody' || e.target.closest?.('#wkBody');
  if (ed) { // berkas dari luar dijatuhkan ke editor
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (e.type === 'dragover') e.target.classList.add('drop-files');
    else { e.target.classList.remove('drop-files'); if (e.type === 'drop') uploadFiles([...e.dataTransfer.files], e.target); }
    return;
  }
  if (!drag) return;
  if (e.type === 'dragleave') return;
  const sp = dropSpot(e);
  clearDz();
  if (!sp) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  if (e.type === 'dragover') sp.el.classList.add(sp.el.classList.contains('wk-rootzone') ? 'dz-root' : 'dz-' + sp.cls);
  else if (e.type === 'drop') { const s = drag; drag = null; $('#wkList', W.el)?.classList.remove('dragging'); placePage(s, sp.parent, sp.idx); }
}

/* ---------------- unggah gambar / lampiran ---------------- */
document.addEventListener('kantor:wiki-changed', () => { if (W && W.pages) loadList(); }); // penampil dokumen mengimpor .md jadi halaman
let upN = 0;
const safeName = n => String(n || 'berkas').replace(/[\[\]()\n]/g, ' ').trim() || 'berkas';
function insertAt(ta, text) {
  const e = W.ed, a = ta.selectionStart ?? e.body.length, b = ta.selectionEnd ?? a;
  e.body = e.body.slice(0, a) + text + e.body.slice(b); ta.value = e.body;
  const pos = a + text.length; ta.setSelectionRange(pos, pos); paintPreview();
}
async function uploadFiles(files, ta) {
  if (!W || W.mode !== 'edit' || !W.ed || !files.length) return;
  ta = ta?.tagName === 'TEXTAREA' ? ta : $('#wkBody', W.el);
  for (const f of files) {
    const name = safeName(f.name || 'berkas'), mark = `⏳ Mengunggah ${name} (${++upN})…`;
    insertAt(ta, (ta.selectionStart > 0 && W.ed.body[ta.selectionStart - 1] !== '\n' ? '\n' : '') + mark + '\n');
    W.up++;
    let md_ = '';
    try {
      const res = await fetch(url('media?name=' + encodeURIComponent(f.name || 'berkas')), { method: 'POST', body: f, credentials: 'same-origin' });
      const r = await res.json().catch(() => null);
      if (!res.ok || !r) throw new Error(r?.error || `Gagal (${res.status})`);
      const label = safeName(r.name || name);
      md_ = r.image ? `![${label.replace(/\.[a-z0-9]+$/i, '')}](${r.url})` : r.pdf || r.doc ? `![${label.replace(/\.[a-z0-9]+$/i, '')}](${r.url}.${(/\.([a-z0-9]{1,8})$/i.exec(r.name || '') || [, r.pdf ? 'pdf' : 'md'])[1].toLowerCase()})` : r.video ? `![${label.replace(/\.[a-z0-9]+$/i, '')}](${r.url}.${(/\.([a-z0-9]{1,8})$/i.exec(r.name || '') || [, 'mp4'])[1].toLowerCase()})` : `[📎 ${label}](${r.url})`;
    } catch (err) { toast(`Gagal mengunggah ${name}: ${err.message}`, 'bad'); }
    W.up--;
    if (!W || !W.ed) return;
    const cur = $('#wkBody', W.el), i = W.ed.body.indexOf(mark), keepPos = cur?.selectionStart ?? 0;
    if (i < 0) continue;
    const tail = md_ ? '' : '\n'; // bila gagal, hapus juga baris pembungkus
    W.ed.body = W.ed.body.replace(mark + tail, md_ || '').replace(mark, md_);
    if (cur) { cur.value = W.ed.body; const np = keepPos > i ? Math.max(i, keepPos - (mark.length + 1 - md_.length)) : keepPos; cur.setSelectionRange(np, np); }
    paintPreview();
  }
}
function onPaste(e) {
  if (!W || W.mode !== 'edit' || e.target.id !== 'wkBody') return;
  const fs = [...(e.clipboardData?.files || [])]; if (!fs.length) return;
  e.preventDefault();
  uploadFiles(fs.map(f => (f.name && f.name !== 'image.png' ? f : new File([f], `gambar-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))), e.target);
}

/* ---------------- lightbox + cetak ---------------- */
function lightbox(img) {
  const o = document.createElement('div'); o.className = 'wk-lb'; o.tabIndex = -1; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Gambar');
  o.innerHTML = `<img src="${esc(img.currentSrc || img.src)}" alt="${esc(img.alt)}"><a class="btn sm" href="${esc(img.src)}" target="_blank" rel="noreferrer">Buka ukuran asli</a><button class="btn sm" aria-label="Tutup">Tutup ✕</button>`;
  const close = () => { o.remove(); document.removeEventListener('keydown', key, true); };
  const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  o.addEventListener('click', ev => { if (!ev.target.closest('a')) close(); });
  document.addEventListener('keydown', key, true);
  document.body.appendChild(o); o.focus();
}

async function printPage(withKids) {
  const p = W.page; if (!p) return;
  let pages = [p];
  if (withKids) {
    try { pages = [p, ...await Promise.all(descendants(p.slug).map(d => api(url('wiki/page?ref=' + encodeURIComponent(d.slug)))))].filter(Boolean); }
    catch (err) { toast(err.message, 'bad'); return; }
  }
  const root = document.createElement('div'); root.id = 'wkPrint';
  root.innerHTML = pages.map(x => `<section class="wk-pp">
    ${x.crumbs?.length ? `<div class="wk-pp-crumbs">${x.crumbs.map(c => esc((c.icon ? c.icon + ' ' : '') + c.title)).join(' › ')}</div>` : ''}
    ${/^\s*#\s/.test(x.body || '') ? '' : `<h1 class="wk-title">${ic(x.icon)}${esc(x.title)}</h1>`}
    <div class="wk-pp-meta">${esc(W.ctx.office.name || '')} · Diperbarui ${esc(dateLong(x.updatedAt))} oleh ${esc(x.author || 'Tidak diketahui')}</div>
    ${/^\s*#\s/.test(x.body || '') ? pageBody(x, { taskIndex: false }) : md(x.body, { ...mdOpts(), taskIndex: false })}</section>`).join('');
  const done = () => { root.remove(); document.body.classList.remove('wk-printing'); window.removeEventListener('afterprint', done); };
  document.body.appendChild(root); document.body.classList.add('wk-printing');
  window.addEventListener('afterprint', done);
  const t0 = document.title; document.title = p.title;
  const imgs = $$('img', root).filter(i => !i.complete);
  imgs.forEach(i => { i.loading = 'eager'; });
  await Promise.race([Promise.all(imgs.map(i => i.decode().catch(() => {}))), new Promise(r => setTimeout(r, 4000))]);
  window.print();
  document.title = t0;
  setTimeout(done, 120000);
}

/* ---------------- editor ---------------- */
function startEdit(page, { title = '', tpl = true, parent = null, pb = null } = {}) {
  const isNew = !page;
  W.mode = 'edit'; W.src = null;
  W.ed = isNew
    ? { isNew, title, body: pb ? PB_TEMPLATE : '', title0: '', body0: '', msg: '', ref: '', tpl: 0, showTpl: tpl && !pb, parent, pb }
    : { isNew, title: page.title, body: page.body, title0: page.title, body0: page.body, msg: '', prevSlug: page.slug, ref: page.slug };
  if (isNew && (title || pb)) W.ed.title0 = ''; // judul bawaan dihitung sebagai perubahan agar tidak hilang diam-diam
  paintList(); paintMain();
  setTimeout(() => $(isNew && !title ? '#wkTitle' : '#wkBody', W.el)?.focus(), 20);
}

function paintEditor(m) {
  const e = W.ed;
  m.innerHTML = `<div class="wiki-page wk-editor">
    ${e.isNew && e.showTpl ? `<div class="field"><label>Mulai dari</label><div class="chips">${TEMPLATES.map(([n], i) => `<button class="chip" data-act="wk-tpl" data-i="${i}" aria-pressed="${e.tpl === i}">${esc(n)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label for="wkTitle">Judul</label><input type="text" id="wkTitle" data-f="title" value="${esc(e.title)}" placeholder="Judul halaman"></div>
    ${e.isNew ? `<label class="check pb-chk"><input type="checkbox" data-act="wk-pb-ed" ${e.pb ? 'checked' : ''}> 📘 Jadikan playbook <small class="hint">prosedur baku yang dipegang role</small></label>` : ''}
    ${e.isNew && e.pb?.roles?.length ? `<p class="hint">Dipegang oleh ${esc(roleNames(e.pb.roles).join(', '))}</p>` : ''}
    ${e.isNew && e.parent ? `<p class="hint">Sub-halaman dari <b>${esc(byId(e.parent)?.title || e.parent)}</b></p>` : ''}
    <div class="wk-tools"><button class="btn sm" data-act="wk-attach" type="button">📎 Lampirkan</button><input type="file" id="wkFile" multiple hidden><span class="hint">Tempel gambar (Ctrl/Cmd+V) atau seret berkas ke kolom isi.</span></div>
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
  if (W.up) { toast('Tunggu unggahan selesai dulu.', 'warn'); return; }
  try {
    let p = await post(url('wiki'), { title, body: e.body, msg: e.msg.trim() || undefined, prevSlug: e.prevSlug, parent: e.isNew && e.parent ? e.parent : undefined });
    if (e.isNew && e.pb) { try { p = await post(url('wiki-playbook'), { slug: p.slug, ...e.pb }); } catch (err) { toast('Halaman tersimpan, playbook gagal: ' + err.message, 'warn'); } }
    toast(e.isNew && e.pb ? 'Playbook disimpan.' : 'Halaman disimpan.', 'ok');
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
  const im = e.target.closest('img.md-img'); if (im) { e.preventDefault(); lightbox(im); return; }
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
  else if (act === 'wk-pb-new') guard(() => startEdit(null, { pb: { roles: [], when: '', always: false, approval: false } }));
  else if (act === 'wk-pb-set') pbDialog(W.page);
  else if (act === 'wk-pb-ed') {
    const ed = W.ed;
    if (!b.checked) { ed.pb = null; if (ed.body === PB_TEMPLATE) { ed.body = ''; } paintMain(); return; }
    b.checked = false;
    pbDialog({ title: ed.title.trim() || 'halaman baru' }, { roles: [], onSave: v => { ed.pb = v; if (!ed.body.trim()) ed.body = PB_TEMPLATE; paintMain(); } });
  }
  else if (act === 'wk-pbf') { W.pbOnly = !W.pbOnly; paintList(); }
  else if (act === 'wk-props') { W.showProps = !W.showProps; paintFilter(); }
  else if (act === 'wk-prop') { e.preventDefault(); openProposal(b.dataset.slug, b.dataset.uid); }
  else if (act === 'wk-prop-yes') decide(true);
  else if (act === 'wk-prop-no') decide(false);
  else if (act === 'wk-create') startEdit(null, { title: b.dataset.title });
  else if (act === 'wk-edit') startEdit(W.page);
  else if (act === 'wk-sub') guard(() => startEdit(null, { parent: W.page.slug }));
  else if (act === 'wk-tg') { const s = b.dataset.slug; W.open.has(s) ? W.open.delete(s) : W.open.add(s); saveOpen(); paintList(); }
  else if (act === 'wk-icon') { W.pop = W.pop === 'icon' ? null : 'icon'; paintMain(); $('#wkIcoIn', W.el)?.focus(); }
  else if (act === 'wk-ico') setIcon(b.dataset.e);
  else if (act === 'wk-ico-in') { const v = $('#wkIcoIn', W.el).value.trim(); if (v) setIcon(v); }
  else if (act === 'wk-mv') moveDialog();
  else if (act === 'wk-pdf') printPage(false);
  else if (act === 'wk-pdf-all') printPage(true);
  else if (act === 'wk-attach') $('#wkFile', W.el).click();
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
  else if (act === 'wk-back') { W.mode = 'view'; W.prop = null; paintMain(); paintList(); }
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
  if (p && W.page && p.updatedAt === W.page.updatedAt) { const re = (p.proposals || []).length !== (W.page.proposals || []).length; W.page = p; if (re) paintMain(); return; }
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
