// Tab Pratinjau: hasil kerja yang agen kirim lewat pratinjau_kirim untuk dilihat pemilik (info), diputuskan (persetujuan), atau dipilih (pilihan).
// Berkas dilayani di /pv/... (jalur bertanda tangan, CSP sandbox); HTML tampil di <iframe sandbox="allow-scripts">.
// Penampil layar penuh dan gelembung chat (chatBubble/chatClick) bisa dipakai dari luar tab ini (web/js/chat.js).
import { $, $$, esc, ago, api, post, toast, modal } from './util.js';
import './docs.js'; // [data-pdf] membuka penampil PDF bersama

const FILTERS = [['baru', 'Baru'], ['perlu', 'Perlu keputusan'], ['semua', 'Semua'], ['disimpan', 'Disimpan'], ['arsip', 'Arsip']];
const STATUS = { baru: 'Baru', menunggu: 'Baru', dilihat: 'Dilihat', dikomentari: 'Dikomentari', sebagian: 'Sebagian', disetujui: 'Disetujui', revisi: 'Revisi', dipilih: 'Dipilih', oke: 'Oke' };
const JENIS = { persetujuan: 'Persetujuan', info: 'Info', pilihan: 'Pilihan' };
const MODE = { set: 'Set', pilihan: 'Pilihan', bundle: 'Situs' };
const REACTIONS = ['👍', '❤️', '🔥', '🤔'];
const DEVICES = [['hp', 'HP', 390], ['tablet', 'Tablet', 820], ['desktop', 'Desktop', 0]];
const KIND_ICON = { html: '</>', pdf: 'PDF', video: '▶', doc: 'TXT', other: 'FILE', image: 'IMG' };

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const igGet = () => pref('kantor.pv.ig', '0') === '1';
const igRatio = () => pref('kantor.pv.igr', '4:5');

let S = null; // tab: {el, ctx, filter, items, counts, slide:{id:index}, usage}
let V = null; // penampil: {el, office, item, i, compare, device, sel:[{item,fid}], sync}

const urlFor = (office, p = '') => `/api/offices/${encodeURIComponent(office)}/pratinjau${p}`;
const oid = () => S.ctx.office.id;
export const fmtT = t => { t = Math.max(0, Math.floor(Number(t) || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtSize = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
const playSrc = f => f.putarUrl || f.url;
const PURGED = '<p class="hint pv-purged">🧹 Berkas sudah dibersihkan (gambar kecil tetap ada).</p>';

export async function render(el, ctx, route) {
  S = { el, ctx, filter: 'semua', items: [], counts: {}, slide: {}, usage: null };
  el.innerHTML = `<div class="pv-wrap">
    <div class="pv-head"><div class="seg" id="pvFilter" role="group" aria-label="Saring"></div>
      <p class="hint">Agen mengirim lewat <code>pratinjau_kirim</code>. Komentar dan keputusanmu sampai ke agen sebagai pesan. <span id="pvUsage"></span></p></div>
    <div class="pv-feed" id="pvFeed"><p class="empty-line">Memuat…</p></div></div>`;
  el.addEventListener('click', onClick);
  await load();
  if (S && !route?.rest?.[0] && S.counts.perlu) { S.filter = 'perlu'; load(true); }
  if (route?.rest?.[0]) openViewer(oid(), route.rest[0]);
}
export function route(r) { if (S && r?.rest?.[0]) openViewer(oid(), r.rest[0]); }
export function unmount() { closeViewer(); S = null; }
export function live(m) {
  if (m.t !== 'pratinjau') return;
  liveViewer(m);
  if (!S || m.office !== oid()) return;
  const i = S.items.findIndex(x => x.id === m.item.id);
  if (i >= 0) S.items[i] = m.item;
  load(true);
}
/** Penampil yang sedang terbuka ikut diperbarui (dipanggil juga dari chat). */
export function liveViewer(m) {
  if (m.t !== 'pratinjau' || !V || V.office !== m.office) return;
  let hit = false;
  if (V.item.id === m.item.id) { V.item = m.item; hit = true; }
  for (const s of V.sel) if (s.item.id === m.item.id) { s.item = m.item; hit = true; }
  if (hit) paintViewer(true);
}

/** Jumlah yang perlu keputusan, untuk lencana tab (main.js). */
export async function badge(office) {
  try { const r = await api(`${urlFor(office)}?limit=1`); return r.counts?.perlu ?? r.counts?.menunggu ?? 0; } catch { return 0; }
}

async function load(quiet) {
  try {
    const [r, u] = await Promise.all([api(urlFor(oid(), `?status=${S.filter}&limit=80`)), api(urlFor(oid(), '/usage')).catch(() => null)]);
    if (!S) return;
    S.items = r.items; S.counts = r.counts; S.usage = u;
  } catch (e) { if (!quiet) toast(e.message, 'bad'); }
  if (!S) return;
  paintFilter(); paintFeed();
  const ue = $('#pvUsage', S.el); if (ue) ue.textContent = S.usage?.items ? `Penyimpanan pratinjau: ${fmtSize(S.usage.bytes)} (${S.usage.items} item).` : '';
  document.dispatchEvent(new CustomEvent('kantor:pratinjau-count', { detail: { office: oid(), n: S.counts.perlu || 0 } }));
}

function paintFilter() {
  $('#pvFilter', S.el).innerHTML = FILTERS.map(([k, t]) => `<button data-act="pv-filter" data-f="${k}" aria-pressed="${S.filter === k}">${t}${S.counts[k] ? ` <b class="pv-n">${S.counts[k]}</b>` : ''}</button>`).join('');
}

const pill = s => `<span class="pv-st pv-st-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const jenisTag = j => `<span class="pv-jn pv-jn-${esc(j)}">${esc(JENIS[j] || j)}</span>`;
const icon = f => `<span class="pv-ic pv-ic-${f.kind}">${KIND_ICON[f.kind] || 'FILE'}</span><span class="pv-ic-name">${esc(f.name)}</span>`;
const ICON_FALLBACK = `this.parentNode.classList.add('pv-noth');this.remove()`;
function preview(f) {
  if (f.kind === 'image') return `<img src="${esc(f.thumb || f.url)}" alt="${esc(f.name)}" loading="lazy" onerror="if(this.src!=='${esc(f.url)}')this.src='${esc(f.url)}'">`;
  if (f.thumb) return `<img src="${esc(f.thumb)}" alt="${esc(f.name)}" loading="lazy" onerror="${ICON_FALLBACK}">${f.kind === 'video' ? '<span class="pv-play">▶</span>' : ''}<span class="pv-fb">${icon(f)}</span>`;
  return icon(f) + (f.thumbState === 'menyiapkan' ? '<small class="hint">menyiapkan gambar kecil…</small>' : '');
}

/* ---------------- tombol aksi per jenis + aksi netral ---------------- */
/** Tombol utama per jenis. persetujuan: Setujui · Revisi · Komentar; info: Sudah lihat · Komentar; pilihan: Pilih · Komentar. */
function mainActs(it, { inViewer = false, fid = null } = {}) {
  const b = [];
  if (it.jenis === 'persetujuan') {
    if (it.status !== 'disetujui') b.push(`<button class="btn primary sm" data-act="pv-approve">Setujui</button>`);
    b.push(`<button class="btn sm" data-act="pv-revise">Revisi</button>`);
  } else if (it.jenis === 'pilihan') {
    b.push(inViewer && fid ? `<button class="btn primary sm" data-act="pv-pick" data-f="${fid}" ${it.picked === fid ? 'disabled' : ''}>${it.picked === fid ? '⭐ Dipilih' : '⭐ Pilih ini'}</button>`
      : `<button class="btn primary sm" data-act="pv-compare">⭐ Pilih</button>`);
  } else {
    b.push(`<button class="btn ${it.seenAt ? '' : 'primary'} sm" data-act="pv-seen" ${it.seenAt ? 'disabled' : ''}>👀 ${it.seenAt ? 'Sudah dilihat' : 'Sudah lihat'}</button>`);
  }
  b.push(`<button class="btn sm" data-act="pv-comment"${fid ? ` data-f="${fid}"` : ''}>💬 Komentar</button>`);
  return b.join('');
}
const reactRow = it => `<span class="pv-react" role="group" aria-label="Reaksi">${REACTIONS.map(e => `<button class="pv-rx" data-act="pv-react" data-e="${e}" aria-pressed="${!!it.reactions?.[e]}" title="Reaksi ${e}">${e}</button>`).join('')}</span>`;
function moreActs(it) {
  return `<span class="pv-more">
    ${it.jenis !== 'info' && !it.seenAt ? `<button class="btn ghost sm" data-act="pv-seen" title="Tandai sudah dilihat (tidak membangunkan agen)">👀</button>` : ''}
    <button class="btn ghost sm" data-act="pv-pin" aria-pressed="${it.pinned}" title="${it.pinned ? 'Lepas dari Disimpan' : 'Simpan (tidak ikut dibersihkan)'}">📌${it.pinned ? ' Disimpan' : ''}</button>
    <button class="btn ghost sm" data-act="pv-snooze" aria-pressed="${it.snoozed}" title="Nanti dulu">⏸${it.snoozed ? ` ${esc(new Date(it.snoozedUntil).toLocaleString('id-ID', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}</button>
    <button class="btn ghost sm" data-act="pv-archive" aria-pressed="${it.archived}" title="${it.archived ? 'Kembalikan dari arsip' : 'Arsipkan'}">🗂${it.archived ? ' Kembalikan' : ''}</button>
  </span>`;
}
const commentsHTML = (it, fid = null) => {
  const cs = (it.comments || []).filter(c => !fid || !c.file || c.file === fid);
  if (!cs.length) return '';
  return `<ul class="pv-cmts">${cs.slice(-6).map(c => { const f = c.file && it.files.find(x => x.id === c.file);
    return `<li>${c.t != null ? `<button class="pv-tc" data-act="pv-seek" data-t="${c.t}" data-f="${esc(c.file || '')}">@${fmtT(c.t)}</button> ` : ''}${f && !fid ? `<b>${esc(f.name)}:</b> ` : ''}${esc(c.text)} <small class="hint">${ago(c.at)}</small></li>`; }).join('')}</ul>`;
};

function card(it) {
  const i = Math.min(S.slide[it.id] || 0, it.files.length - 1), f = it.files[i];
  return `<article class="card pv-card${it.archived ? ' pv-arch' : ''}" data-id="${it.id}">
    <header class="pv-ch"><div><h3>${esc(it.title)}</h3><p class="hint">${esc(it.fromName)} · ${ago(it.createdAt)} · ${MODE[it.mode] || it.mode}${it.files.length > 1 ? ` · ${it.files.length} ${it.mode === 'bundle' ? 'halaman' : 'berkas'}` : ''}</p></div>
      <div class="pv-tags">${it.version > 1 ? `<span class="pv-ver">v${it.version}</span>` : ''}${jenisTag(it.jenis)}${pill(it.status)}</div></header>
    <div class="pv-car">
      <button class="pv-stage" data-act="pv-open" data-i="${i}" aria-label="Buka ${esc(f.name)}">${preview(f)}</button>
      ${it.files.length > 1 ? `<button class="pv-nav prev" data-act="pv-slide" data-d="-1" aria-label="Sebelumnya">‹</button><button class="pv-nav next" data-act="pv-slide" data-d="1" aria-label="Berikutnya">›</button>
        <div class="pv-dots">${it.files.map((x, k) => `<span class="${k === i ? 'on' : ''} pv-dot-${x.status}"></span>`).join('')}</div>` : ''}
    </div>
    <p class="pv-fname">${esc(f.name)} ${f.status !== 'menunggu' ? pill(f.status) : ''}${it.picked === f.id ? ' <span class="pv-ver">dipilih</span>' : ''}</p>
    ${it.filesPurged ? PURGED : ''}
    ${it.note ? `<p class="pv-note">${esc(it.note)}</p>` : ''}
    ${it.ownerNote ? `<p class="pv-note pv-own"><b>Catatanmu:</b> ${esc(it.ownerNote)}</p>` : ''}
    ${commentsHTML(it)}
    <div class="btn-row pv-acts">${mainActs(it)}${reactRow(it)}</div>
    <div class="btn-row pv-acts2">${moreActs(it)}
      ${it.wiki ? `<a class="btn ghost sm" href="#/o/${encodeURIComponent(S.ctx.office.id)}/wiki/${encodeURIComponent(it.wiki)}">Di wiki</a>` : `<button class="btn ghost sm" data-act="pv-wiki">Jadikan wiki</button>`}</div></article>`;
}
function paintFeed() {
  const el = $('#pvFeed', S.el);
  if (!S.items.length) { el.innerHTML = `<div class="card pv-empty"><p><b>${S.filter === 'semua' ? 'Belum ada pratinjau.' : 'Tidak ada pratinjau di sini.'}</b></p><p class="hint">Minta agen: "kirim pratinjaunya", lalu hasilnya muncul di sini, di chat sesinya, dan di Ghina.</p></div>`; return; }
  el.innerHTML = S.items.map(card).join('');
}

const itemOf = el => { const id = el.closest('[data-id]')?.dataset.id; return S?.items.find(x => x.id === id) || (V?.item.id === id ? V.item : null); };

async function onClick(e) {
  const b = e.target.closest('[data-act^="pv-"]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'pv-filter') { S.filter = b.dataset.f; return load(); }
  const it = itemOf(b); if (!it) return;
  if (a === 'pv-slide') { S.slide[it.id] = ((S.slide[it.id] || 0) + Number(b.dataset.d) + it.files.length) % it.files.length; return paintFeed(); }
  if (a === 'pv-open') return openViewer(oid(), it.id, Number(b.dataset.i) || 0);
  if (a === 'pv-compare') return openViewer(oid(), it.id, 0, true);
  if (a === 'pv-seek') return openViewer(oid(), it.id, Math.max(0, it.files.findIndex(f => f.id === b.dataset.f)), false, Number(b.dataset.t));
  const out = await act(oid(), a, it, b);
  if (out?.id && S) { const i = S.items.findIndex(x => x.id === out.id); if (i >= 0) S.items[i] = out; paintFeed(); load(true); }
}

/* ---------------- aksi (dipakai tab, penampil, dan chat) ---------------- */
function askNote({ title, label, required, ok, placeholder }) {
  return new Promise(res => modal({ title, html: `<label class="pv-lbl">${esc(label)}<textarea id="pvNote" rows="4" placeholder="${esc(placeholder || (required ? 'Apa yang perlu diubah?' : 'Opsional'))}"></textarea></label>`,
    actions: [{ label: 'Batal', fn: () => res(null) }, { label: ok, kind: 'primary', fn: () => { const v = $('#pvNote').value.trim(); if (required && !v) { toast('Tulis dulu isinya', 'warn'); return false; } res(v); } }] }));
}
function askSnooze(it) {
  const at = (h, m = 0, addDays = 0) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d; };
  const tonight = at(20); if (tonight <= new Date()) tonight.setDate(tonight.getDate() + 1);
  const opts = [['1 jam lagi', new Date(Date.now() + 3600e3)], ['Nanti malam (20.00)', tonight], ['Besok pagi (09.00)', at(9, 0, 1)], ['Minggu depan', at(9, 0, 7)]];
  return new Promise(res => modal({ title: `Nanti dulu: "${it.title}"`, body: 'Disembunyikan dari Baru dan Perlu keputusan sampai waktunya. Agen tidak diberi tahu.',
    actions: [...opts.map(([label, d]) => ({ label, fn: () => res(d.toISOString()) })), ...(it.snoozed ? [{ label: 'Tampilkan sekarang', fn: () => res('') }] : []), { label: 'Batal', fn: () => res(null) }] }));
}
/** Satu aksi pada item; kembalikan item terbaru (atau null). */
export async function act(office, a, it, b) {
  const fid = b?.dataset.f || null, U = p => urlFor(office, `/${it.id}${p}`);
  try {
    let out;
    if (a === 'pv-approve') { const n = await askNote({ title: `Setujui "${it.title}"`, label: 'Catatan untuk agen', ok: 'Setujui' }); if (n === null) return null; out = await post(U('/setujui'), { catatan: n }); toast('Disetujui. Agen diberi tahu.', 'ok'); }
    else if (a === 'pv-revise') { const n = await askNote({ title: `Minta revisi "${it.title}"`, label: 'Apa yang perlu diubah', required: true, ok: 'Kirim revisi' }); if (n === null) return null; out = await post(U('/revisi'), { catatan: n }); toast('Permintaan revisi terkirim.', 'ok'); }
    else if (a === 'pv-fok') out = await post(U(`/files/${fid}`), { status: 'oke' });
    else if (a === 'pv-frev') { const n = await askNote({ title: 'Berkas ini perlu revisi', label: 'Catatan untuk berkas ini', required: true, ok: 'Simpan' }); if (n === null) return null; out = await post(U(`/files/${fid}`), { status: 'revisi', catatan: n }); }
    else if (a === 'pv-pick') { out = await post(U('/pilih'), { file: fid }); toast('Pilihan terkirim ke agen.', 'ok'); }
    else if (a === 'pv-comment' || a === 'pv-tcomment') {
      const t = a === 'pv-tcomment' ? Number(b.dataset.t) : null, f = fid && it.files.find(x => x.id === fid);
      const n = await askNote({ title: t != null ? `Komentar di ${fmtT(t)}` : 'Komentar untuk agen', label: f ? `Tentang ${f.name}${t != null ? ` @${fmtT(t)}` : ''}` : `Tentang "${it.title}"`, required: true, ok: 'Kirim', placeholder: 'Catatan untuk agen (bukan keputusan)' });
      if (n === null) return null;
      out = await post(U('/komentar'), { teks: n, file: fid || undefined, t: t ?? undefined }); toast('Komentar terkirim ke agen.', 'ok');
    }
    else if (a === 'pv-seen') out = await post(U('/lihat'), {});
    else if (a === 'pv-react') out = await post(U('/reaksi'), { emoji: b.dataset.e });
    else if (a === 'pv-pin') { out = await post(U('/tanda'), { pinned: !it.pinned }); toast(out.pinned ? 'Disimpan.' : 'Dilepas dari Disimpan.', 'ok'); }
    else if (a === 'pv-archive') { out = await post(U('/tanda'), { archived: !it.archived }); toast(out.archived ? 'Diarsipkan.' : 'Dikembalikan dari arsip.', 'ok'); }
    else if (a === 'pv-snooze') { const s = await askSnooze(it); if (s === null) return null; out = await post(U('/tanda'), { snoozedUntil: s || null }); toast(s ? 'Ditunda.' : 'Ditampilkan lagi.', 'ok'); }
    else if (a === 'pv-wiki') { const w = await post(U('/wiki'), {}); toast(`Halaman wiki "${w.title}" dibuat.`, 'ok'); document.dispatchEvent(new CustomEvent('kantor:wiki-changed')); out = await api(U('')); }
    if (out?.id && V) liveViewer({ t: 'pratinjau', office, item: out });
    return out || null;
  } catch (err) { toast(err.message, 'bad'); return null; }
}

/* ---------------- gelembung chat (web/js/chat.js) ---------------- */
/** HTML satu pratinjau sebagai gelembung chat dari agen. */
export function chatBubble(it) {
  const f = it.files[0];
  const strip = it.files.length > 1 ? `<div class="pv-cb-strip">${it.files.slice(0, 6).map((x, k) => `<button class="pv-cb-th" data-act="pv-open" data-i="${k}" title="${esc(x.name)}">${preview(x)}</button>`).join('')}${it.files.length > 6 ? `<span class="pv-cb-more">+${it.files.length - 6}</span>` : ''}</div>` : '';
  return `<div class="pv-cb" data-id="${it.id}">
    <div class="pv-cb-h"><b>🖼 ${esc(it.title)}</b><span class="pv-tags">${it.version > 1 ? `<span class="pv-ver">v${it.version}</span>` : ''}${jenisTag(it.jenis)}${pill(it.status)}</span></div>
    ${it.files.length > 1 ? strip : `<button class="pv-stage pv-cb-stage" data-act="pv-open" data-i="0" aria-label="Buka ${esc(f.name)}">${preview(f)}</button>`}
    ${it.filesPurged ? PURGED : ''}
    ${it.note ? `<p class="pv-cb-note">${esc(it.note)}</p>` : ''}
    ${commentsHTML(it)}
    <div class="btn-row pv-acts">${mainActs(it)}${reactRow(it)}</div></div>`;
}
/** Klik di dalam gelembung chat. true bila ditangani. */
export async function chatClick(e, office, items, onItem) {
  const b = e.target.closest('.pv-cb [data-act^="pv-"]'); if (!b) return false;
  const id = b.closest('[data-id]').dataset.id, it = items.find(x => x.id === id); if (!it) return true;
  const a = b.dataset.act;
  if (a === 'pv-open') { openViewer(office, id, Number(b.dataset.i) || 0); return true; }
  if (a === 'pv-compare') { openViewer(office, id, 0, true); return true; }
  if (a === 'pv-seek') { openViewer(office, id, Math.max(0, it.files.findIndex(f => f.id === b.dataset.f)), false, Number(b.dataset.t)); return true; }
  const out = await act(office, a, it, b);
  if (out) onItem(out);
  return true;
}

/* ---------------- penampil layar penuh ---------------- */
export async function openViewer(office, id, i = 0, compare = false, seekT = null) {
  let item;
  try { item = await api(urlFor(office, `/${id}`)); } catch (e) { return toast(e.message, 'bad'); }
  closeViewer(true);
  const o = document.createElement('div');
  o.className = 'pv-ov'; o.tabIndex = -1; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
  document.body.appendChild(o);
  V = { el: o, office, item, i, compare, device: 'desktop', sel: item.files.slice(0, 3).map(f => ({ item, fid: f.id })), seekT };
  if (compare && item.files.length < 2 && item.versions.length > 1) await compareVersions();
  o.addEventListener('click', onViewerClick);
  o.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeViewer();
    else if (!V.compare && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest('textarea,input,video')) step(e.key === 'ArrowRight' ? 1 : -1);
  });
  paintViewer();
  o.focus();
  if (!item.seenAt && item.jenis === 'info') { /* "Sudah lihat" tetap pilihan pemilik: tidak otomatis */ }
}
function closeViewer(silent) {
  if (!V) return;
  V.el.remove(); V = null;
  if (!silent && /\/pratinjau\/p[0-9a-f]+/.test(location.hash)) history.replaceState(null, '', location.hash.replace(/\/pratinjau\/p[0-9a-f]+.*$/, '/pratinjau'));
}
function step(d) { const n = V.item.files.length; V.i = (V.i + d + n) % n; V.seekT = null; paintViewer(); }
/** Bandingkan berkas pertama versi ini dengan versi sebelumnya (mis. dua versi video). */
async function compareVersions() {
  const vs = V.item.versions, k = vs.findIndex(x => x.id === V.item.id), prev = vs[k > 0 ? k - 1 : 1];
  if (!prev || prev.id === V.item.id) return;
  try { const p = await api(urlFor(V.office, `/${prev.id}`)); const f = V.item.files[Math.min(V.i, V.item.files.length - 1)]; const pf = p.files.find(x => x.name === f.name) || p.files[0];
    V.sel = [{ item: p, fid: pf.id }, { item: V.item, fid: f.id }]; V.compare = true; } catch (e) { toast(e.message, 'bad'); }
}

const marks = (it, f) => (it.comments || []).filter(c => c.t != null && c.file === f.id);
function videoStage(it, f) {
  const prep = f.putar === 'menyiapkan' ? '<p class="pv-prep">⏳ menyiapkan video… (versi yang lebih kompatibel sedang dibuat; sementara memutar berkas asli)</p>' : '';
  return `<div class="pv-vid" data-f="${f.id}">${prep}<video src="${esc(playSrc(f))}" controls playsinline preload="metadata"${f.thumb ? ` poster="${esc(f.thumb)}"` : ''}></video>
    <div class="pv-marks" aria-label="Komentar bertanda waktu">${marks(it, f).map(c => `<button class="pv-mk" data-act="pv-seek" data-t="${c.t}" data-f="${f.id}" title="@${fmtT(c.t)} ${esc(c.text)}"></button>`).join('')}</div>
    <div class="btn-row pv-vbar"><button class="btn sm" data-act="pv-tcomment" data-f="${f.id}" data-t="0">💬 Komentar di 0:00</button></div></div>`;
}
function stage(it, f, v) {
  if (it.filesPurged) return `<figure class="pv-pdf">${f.thumb ? `<img class="pv-pdf-th" src="${esc(f.thumb)}" alt="">` : icon(f)}<figcaption>${esc(f.name)}</figcaption>${PURGED}</figure>`;
  if (f.kind === 'image') return `<div class="pv-img"><img src="${esc(f.url)}" alt="${esc(f.name)}"></div>`;
  if (f.kind === 'video') return videoStage(it, f);
  if (f.kind === 'html') {
    const w = DEVICES.find(d => d[0] === v.device)[2];
    return `<div class="pv-frame ${w ? 'dev' : ''}" style="${w ? `--w:${w}px` : ''}"><iframe src="${esc(f.url)}" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="${esc(f.name)}"></iframe></div>`;
  }
  if (f.kind === 'pdf') return `<figure class="pv-pdf" data-name="${esc(f.name)}">${f.thumb ? `<img class="pv-pdf-th" src="${esc(f.thumb)}" alt="">` : '<span class="pv-ic pv-ic-pdf">PDF</span>'}<figcaption>${esc(f.name)}</figcaption><button class="btn primary" data-pdf="${esc(f.url)}">Buka PDF</button></figure>`;
  if (f.kind === 'doc') return `<pre class="pv-doc" data-src="${esc(f.url)}">Memuat…</pre>`;
  return `<figure class="pv-pdf"><span class="pv-ic">FILE</span><figcaption>${esc(f.name)}</figcaption><a class="btn" href="${esc(f.url)}" download="${esc(f.name)}">Unduh</a></figure>`;
}
// "Bingkai Instagram": post 4:5 atau Reels 9:16; gambar dan video (video berputar tanpa suara, ketuk untuk suara)
function igStage(it, f) {
  const media = it.files.filter(x => x.kind === 'image' || x.kind === 'video'), k = media.indexOf(f), reel = igRatio() === '9:16';
  const who = String(it.fromName || 'agen').trim(), handle = who.toLowerCase().replace(/\s+/g, '_');
  const inner = f.kind === 'video' ? `<video src="${esc(playSrc(f))}" autoplay muted loop playsinline data-act="pv-unmute"></video><span class="pv-ig-snd">🔇</span>` : `<img src="${esc(f.url)}" alt="${esc(f.name)}">`;
  return `<div class="pv-ig ${reel ? 'reel' : ''}"><div class="pv-ig-h"><span class="pv-ig-av">${esc(who[0]?.toUpperCase() || '?')}</span><b>${esc(handle)}</b>${reel ? '<span class="hint">Reels</span>' : ''}</div>
    <div class="pv-ig-img">${inner}${media.length > 1 ? `<span class="pv-ig-n">${k + 1}/${media.length}</span>` : ''}</div>
    <div class="pv-ig-acts"><span>♡ 💬 ➤</span>${media.length > 1 ? `<span class="pv-ig-dots">${media.map((_, i) => `<i class="${i === k ? 'on' : ''}"></i>`).join('')}</span>` : '<span></span>'}<span>🔖</span></div>
    <p class="pv-ig-cap"><b>${esc(handle)}</b> ${esc(it.note || it.title)}</p></div>`;
}

function fileActs(it, f) {
  const dec = it.jenis === 'persetujuan' && it.mode !== 'pilihan'
    ? `<button class="btn sm" data-act="pv-fok" data-f="${f.id}" ${f.status === 'oke' ? 'disabled' : ''}>Oke</button><button class="btn sm danger" data-act="pv-frev" data-f="${f.id}">Revisi</button>`
    : it.jenis === 'pilihan' || it.mode === 'pilihan' ? `<button class="btn primary sm" data-act="pv-pick" data-f="${f.id}" ${it.picked === f.id ? 'disabled' : ''}>${it.picked === f.id ? '⭐ Dipilih' : '⭐ Pilih ini'}</button>` : '';
  return `<div class="btn-row pv-facts">${f.status !== 'menunggu' ? pill(f.status) : ''}${f.note ? `<span class="hint">${esc(f.note)}</span>` : ''}${dec}<button class="btn sm" data-act="pv-comment" data-f="${f.id}">💬</button></div>`;
}

function paintViewer(fromLive) {
  const v = V; if (!v) return;
  // jangan memotong video yang sedang diputar karena pembaruan live: cukup segarkan penanda dan tombol
  const playing = fromLive && [...v.el.querySelectorAll('video')].some(x => !x.paused);
  const it = v.item, f = it.files[Math.min(v.i, it.files.length - 1)];
  if (playing) { const mk = $('.pv-marks', v.el); if (mk && !v.compare) mk.innerHTML = marks(it, f).map(c => `<button class="pv-mk" data-act="pv-seek" data-t="${c.t}" data-f="${f.id}" title="@${fmtT(c.t)} ${esc(c.text)}"></button>`).join(''); placeMarks(); return; }
  const showDev = !v.compare && f.kind === 'html';
  const versions = it.versions.length > 1 ? `<span class="seg pv-vers" role="group" aria-label="Versi">${it.versions.map(x => `<button data-act="pv-ver" data-v="${x.id}" aria-pressed="${x.id === it.id}" title="${esc(STATUS[x.status] || x.status)}">v${x.version}</button>`).join('')}</span>` : '';
  const igAble = f.kind === 'image' || f.kind === 'video', ig = !v.compare && igAble && igGet();
  const canCmp = it.files.length > 1 || it.versions.length > 1;
  const body = v.compare ? compareBody(v) : `<div class="pv-main">${ig ? igStage(it, f) : stage(it, f, v)}</div>
      ${it.files.length > 1 ? `<button class="pv-nav prev" data-act="pv-step" data-d="-1" aria-label="Sebelumnya">‹</button><button class="pv-nav next" data-act="pv-step" data-d="1" aria-label="Berikutnya">›</button>` : ''}`;
  v.el.innerHTML = `<div class="pv-bar">
      <div class="pv-bt"><b>${esc(it.title)}</b> ${jenisTag(it.jenis)} ${pill(it.status)} <span class="hint">${esc(it.fromName)} · ${ago(it.createdAt)}</span></div>
      <div class="btn-row">${versions}
        ${showDev ? `<span class="seg" role="group" aria-label="Ukuran layar">${DEVICES.map(([k, t]) => `<button data-act="pv-dev" data-d="${k}" aria-pressed="${v.device === k}">${t}</button>`).join('')}</span>` : ''}
        ${canCmp ? `<button class="btn sm" data-act="pv-cmp" aria-pressed="${v.compare}">${v.compare ? 'Satu per satu' : 'Bandingkan'}</button>` : ''}
        ${it.versions.length > 1 && !v.compare ? `<button class="btn sm" data-act="pv-cmpver">Bandingkan versi</button>` : ''}
        ${!v.compare && igAble ? `<button class="btn sm" data-act="pv-ig" aria-pressed="${ig}" title="Tampilkan seperti post Instagram">Bingkai IG</button>` : ''}
        ${ig ? `<span class="seg" role="group" aria-label="Rasio IG">${['4:5', '9:16'].map(r => `<button data-act="pv-igr" data-r="${r}" aria-pressed="${igRatio() === r}">${r === '9:16' ? 'Reels 9:16' : 'Post 4:5'}</button>`).join('')}</span>` : ''}
        ${!v.compare ? `<a class="btn sm" href="${esc(f.kind === 'video' ? playSrc(f) : f.url)}" target="_blank" rel="noreferrer noopener">Tab baru</a>` : ''}
        <button class="btn sm" data-act="pv-close" aria-label="Tutup">Tutup ✕</button></div></div>
    <div class="pv-body ${v.compare ? 'cmp' : ''}">${body}</div>
    ${v.compare ? '' : `<div class="pv-foot"><div class="pv-fn"><b>${esc(f.name)}</b>${it.picked === f.id ? ' <span class="pv-ver">dipilih</span>' : ''}</div>${fileActs(it, f)}</div>`}
    ${it.files.length > 1 && !v.compare ? `<div class="pv-strip" role="listbox" aria-label="Berkas">${it.files.map((x, k) => `<button class="pv-th ${k === v.i ? 'on' : ''} pv-th-${x.status}" data-act="pv-go" data-i="${k}" role="option" aria-selected="${k === v.i}" title="${esc(x.name)}">${preview(x)}</button>`).join('')}</div>` : ''}
    <div class="pv-foot pv-item-acts"><div class="pv-fl">${it.note ? `<p class="pv-note">${esc(it.note)}</p>` : ''}${commentsHTML(it, v.compare ? null : f.id)}</div>
      <div class="btn-row">${mainActs(it, { inViewer: true, fid: it.jenis === 'pilihan' && !v.compare ? f.id : null })}${reactRow(it)}${moreActs(it)}${it.wiki ? '' : '<button class="btn ghost sm" data-act="pv-wiki">Jadikan wiki</button>'}</div></div>`;
  v.el.dataset.id = it.id;
  for (const pre of $$('.pv-doc', v.el)) fetch(pre.dataset.src).then(r => r.text()).then(t => { pre.textContent = t.slice(0, 200000); }).catch(() => { pre.textContent = 'Tidak bisa memuat berkas.'; });
  wireVideos();
}
/** Tombol "Komentar di m:ss" mengikuti posisi video; penanda diletakkan setelah durasi diketahui; seek awal dari penanda/komentar. */
function wireVideos() {
  for (const box of $$('.pv-vid', V.el)) {
    const vid = $('video', box), btn = $('[data-act="pv-tcomment"]', box);
    const upd = () => { if (btn) { btn.dataset.t = String(Math.round(vid.currentTime * 10) / 10); btn.textContent = `💬 Komentar di ${fmtT(vid.currentTime)}`; } };
    vid.addEventListener('timeupdate', upd); vid.addEventListener('seeked', upd);
    vid.addEventListener('loadedmetadata', () => { placeMarks(); if (V?.seekT != null && !V.compare) { vid.currentTime = V.seekT; V.seekT = null; } });
    // putar rendisi gagal dimuat (mis. belum siap): kembali ke berkas asli
    vid.addEventListener('error', () => { const f = V?.item.files.find(x => x.id === box.dataset.f); if (f && vid.src.endsWith('.mp4') && f.putarUrl && !vid.dataset.fb) { vid.dataset.fb = '1'; vid.src = f.url; } });
  }
  if (V.compare) wireSync();
}
function placeMarks() {
  for (const box of $$('.pv-vid', V?.el)) {
    const d = $('video', box).duration;
    for (const m of $$('.pv-mk', box)) { m.style.left = d ? `${Math.min(100, (Number(m.dataset.t) / d) * 100)}%` : '0'; m.hidden = !d; }
  }
}
function seekTo(t, fid) {
  const box = (fid && $(`.pv-vid[data-f="${fid}"]`, V.el)) || $('.pv-vid', V.el);
  const vid = box && $('video', box); if (!vid) return false;
  vid.currentTime = t; vid.play?.().catch(() => {}); return true;
}
/** Bandingkan dua+ video: putar/jeda/geser serentak (video pertama memimpin). */
function wireSync() {
  const vids = $$('.pv-cmp video', V.el); const bar = $('.pv-sync', V.el);
  if (vids.length < 2 || !bar) return;
  const [lead, ...rest] = vids, range = $('input', bar), pb = $('[data-act="pv-syncplay"]', bar);
  let lock = false;
  const all = fn => { lock = true; vids.forEach(fn); setTimeout(() => { lock = false; }, 50); };
  pb.onclick = () => (lead.paused ? all(v => v.play().catch(() => {})) : all(v => v.pause()));
  lead.addEventListener('play', () => { pb.textContent = '⏸ Jeda'; if (!lock) all(v => v !== lead && v.play().catch(() => {})); });
  lead.addEventListener('pause', () => { pb.textContent = '▶ Putar'; if (!lock) all(v => v !== lead && v.pause()); });
  lead.addEventListener('seeked', () => { if (!lock) rest.forEach(v => { v.currentTime = Math.min(lead.currentTime, v.duration || lead.currentTime); }); });
  lead.addEventListener('timeupdate', () => { if (lead.duration) range.value = String((lead.currentTime / lead.duration) * 1000); $('.pv-sync-t', bar).textContent = fmtT(lead.currentTime); });
  range.oninput = () => { const t = (Number(range.value) / 1000) * (lead.duration || 0); all(v => { v.currentTime = Math.min(t, v.duration || t); }); };
  for (const v of rest) v.muted = true;
}
function compareBody(v) {
  const sel = v.sel.map(s => ({ it: s.item, f: s.item.files.find(f => f.id === s.fid) })).filter(x => x.f);
  const sameItem = sel.every(x => x.it.id === v.item.id);
  const pickers = sameItem && v.item.files.length > 3 ? `<div class="chips pv-cmp-sel">${v.item.files.map(f => `<button class="chip" data-act="pv-cmpsel" data-f="${f.id}" aria-pressed="${v.sel.some(s => s.fid === f.id)}">${esc(f.name)}</button>`).join('')}</div>` : '';
  const vids = sel.filter(x => x.f.kind === 'video').length >= 2;
  const sync = vids ? `<div class="btn-row pv-sync"><button class="btn primary sm" data-act="pv-syncplay">▶ Putar</button><input type="range" min="0" max="1000" value="0" aria-label="Geser serentak"><span class="pv-sync-t hint">0:00</span><span class="hint">Putar, jeda, dan geser serentak</span></div>` : '';
  return `${pickers}${sync}<div class="pv-cmp n${sel.length}">${sel.map(({ it, f }) => `<section class="pv-col">${sameItem ? '' : `<p class="pv-fn"><span class="pv-ver">v${it.version}</span></p>`}<div class="pv-main">${stage(it, f, { ...v, device: 'desktop' })}</div><p class="pv-fn"><b>${esc(f.name)}</b></p>${sameItem ? fileActs(it, f) : ''}</section>`).join('')}</div>`;
}

async function onViewerClick(e) {
  const v = V; if (!v) return;
  if (e.target === v.el) return;
  const b = e.target.closest('[data-act^="pv-"]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'pv-close') return closeViewer();
  if (a === 'pv-step') return step(Number(b.dataset.d));
  if (a === 'pv-go') { v.i = Number(b.dataset.i); return paintViewer(); }
  if (a === 'pv-dev') { v.device = b.dataset.d; return paintViewer(); }
  if (a === 'pv-ig') { setPref('kantor.pv.ig', igGet() ? '0' : '1'); return paintViewer(); }
  if (a === 'pv-igr') { setPref('kantor.pv.igr', b.dataset.r); return paintViewer(); }
  if (a === 'pv-unmute') { const vid = b; vid.muted = !vid.muted; const s = $('.pv-ig-snd', v.el); if (s) s.textContent = vid.muted ? '🔇' : '🔊'; return; }
  if (a === 'pv-syncplay') return;
  if (a === 'pv-seek') {
    const fid = b.dataset.f, k = v.item.files.findIndex(f => f.id === fid);
    if (!v.compare && k >= 0 && k !== v.i) { v.i = k; v.seekT = Number(b.dataset.t); return paintViewer(); }
    if (!seekTo(Number(b.dataset.t), fid)) { v.seekT = Number(b.dataset.t); paintViewer(); }
    return;
  }
  if (a === 'pv-cmp') { v.compare = !v.compare; v.sel = v.item.files.slice(0, 3).map(f => ({ item: v.item, fid: f.id })); if (v.compare && v.item.files.length < 2) await compareVersions(); return paintViewer(); }
  if (a === 'pv-cmpver') { await compareVersions(); return paintViewer(); }
  if (a === 'pv-cmpsel') {
    const id = b.dataset.f, ids = v.sel.map(s => s.fid);
    let next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-3);
    if (next.length < 2) next = v.item.files.filter(f => !next.includes(f.id)).slice(0, 2 - next.length).map(f => f.id).concat(next);
    v.sel = next.map(fid => ({ item: v.item, fid }));
    return paintViewer();
  }
  if (a === 'pv-ver') {
    try { const it = await api(urlFor(v.office, `/${b.dataset.v}`)); v.item = it; v.i = 0; v.compare = false; v.sel = it.files.slice(0, 3).map(f => ({ item: it, fid: f.id })); paintViewer(); } catch (err) { toast(err.message, 'bad'); }
    return;
  }
  if (a === 'pv-tcomment') { const vid = $(`.pv-vid[data-f="${b.dataset.f}"] video`, v.el); vid?.pause(); if (vid) b.dataset.t = String(Math.round(vid.currentTime * 10) / 10); }
  const out = await act(v.office, a, v.item, b);
  if (out && S && S.ctx.office.id === v.office) { const i = S.items.findIndex(x => x.id === out.id); if (i >= 0) { S.items[i] = out; paintFeed(); } }
}
