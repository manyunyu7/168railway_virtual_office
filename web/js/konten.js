// Tab Konten: galeri, review, kalender, grid, kit, performa, dan Paket Posting (/konten/p/<cid>).
// Logika murni ada di konten-lib.js, Paket Posting di konten-paket.js.
import { $, $$, esc, short, api, post, patch, del, toast, modal, closeModal, confirmDo } from './util.js';
import * as L from './konten-lib.js';
import { PLAT, SUBS, SUB_LABEL, JENIS, KIT_JENIS, METRIK, METRIK_LABEL, MONTHS, DOW, fmtTanggal, fmtTanggalPanjang, fmtNum, ds, pdl, addD } from './konten-lib.js';
import { paketHTML, paketAct, paketInput, mediaHTML, keepState, clearFileCache, ICON_JENIS, bindMedia, tayangDialog } from './konten-paket.js';

const LS = id => 'kc.konten.' + id;
const S = {
  el: null, oid: null, ctx: null, sub: 'galeri', cid: null, loaded: false, err: '', missing: false,
  items: [], stages: [], seri: [], conf: {}, filter: { tahap: '', seri: '', jenis: '', q: '' },
  detail: null, detailErr: '', jadwal: null, kit: null, kitErr: '',
  cursor: new Date(), day: '', pick: '', drag: '', perf: { plat: '', metric: 'reach', dir: -1 },
  rv: { id: '', cache: {}, form: false }, timer: null, last: '', h: null, seq: 0,
};
const base = () => `/api/offices/${encodeURIComponent(S.oid)}/konten`;
const todayS = () => ds(new Date());
const link = (sub, cid) => L.hashFor(S.oid, sub, cid);
const pill = (t, c = '') => `<span class="kt-pill ${c}">${esc(t)}</span>`;
const tahapName = id => S.stages.find(s => s.id === id)?.name || id;

/* ---------------- preferensi ---------------- */
const prefGet = () => { try { return JSON.parse(localStorage.getItem(LS(S.oid)) || '{}'); } catch { return {}; } };
const prefSet = o => { try { localStorage.setItem(LS(S.oid), JSON.stringify({ ...prefGet(), ...o })); } catch {} };

/* ---------------- muat data ---------------- */
async function fetchList() {
  try {
    const d = await api(base());
    S.items = Array.isArray(d?.items) ? d.items : []; S.stages = d?.stages || []; S.seri = d?.seri || []; S.conf = d?.conf || {};
    S.err = ''; S.missing = false;
  } catch (e) { S.err = e.message; S.missing = /404|tidak ditemukan|not found/i.test(e.message); if (!S.loaded) { S.items = []; S.stages = []; } }
  S.loaded = true;
}
async function fetchDetail() {
  if (!S.cid) { S.detail = null; return; }
  try { const d = await api(`${base()}/${encodeURIComponent(S.cid)}`); d._oid = S.oid; S.detail = d; S.detailErr = ''; }
  catch (e) { S.detailErr = e.message; if (S.detail?.id !== S.cid) S.detail = null; }
}
async function fetchReviewDetail() {
  const q = L.reviewQueue(S.items); if (!q.length) { S.rv.id = ''; return; }
  if (!q.some(x => x.id === S.rv.id)) S.rv.id = q[0].id;
  const id = S.rv.id;
  try { const d = await api(`${base()}/${encodeURIComponent(id)}`); S.rv.cache[id] = d; } catch { /* tetap pakai cache */ }
}
function weekRange() {
  const w = L.monthWeeks(S.cursor); return { from: w[0][0], to: w[w.length - 1][6] };
}
async function fetchJadwal() {
  const { from, to } = weekRange();
  try { S.jadwal = await api(`${base()}/jadwal?from=${from}&to=${to}`); } catch { S.jadwal = null; }
}
async function fetchKit() { try { const d = await api(`${base()}/kit`); S.kit = Array.isArray(d) ? d : d?.items || []; S.kitErr = ''; } catch (e) { S.kit = S.kit || []; S.kitErr = e.message; } }
async function fetchExtra() {
  if (S.cid) return fetchDetail();
  if (S.sub === 'review') return fetchReviewDetail();
  if (S.sub === 'kalender') return fetchJadwal();
  if (S.sub === 'kit') return fetchKit();
}
async function refresh() {
  const n = ++S.seq;
  await Promise.all([fetchList(), fetchExtra()]);
  if (n !== S.seq || !S.el) return;
  paint();
}

/* ---------------- tampilan umum ---------------- */
function thumb(it, cls = '') {
  return it.coverUrl ? `<img class="${cls}" src="${esc(it.coverUrl)}" alt="" loading="lazy" decoding="async">` : `<span class="kt-ph-img ${cls}" aria-hidden="true">${ICON_JENIS[it.jenis] || '◇'}</span>`;
}
function emptyState() {
  const noRoot = !S.conf?.root;
  return `<div class="kt-emptybox"><h3>Belum ada konten</h3><p>${S.missing ? 'Server ini belum mendukung tab Konten.' : noRoot ? 'Folder konten belum diatur. Atur dulu di Pengaturan, lalu impor folder yang sudah ada atau mulai dari satu ide.' : 'Impor folder yang sudah ada, atau mulai dari satu ide.'}</p>
    <div class="kt-row"><button type="button" class="btn primary kt-btn" data-act="kt-baru">Konten baru</button><button type="button" class="btn kt-btn" data-act="kt-impor">Impor folder</button><button type="button" class="btn kt-btn" data-act="kt-conf">Pengaturan</button></div></div>`;
}

/** Lencana status per platform, mis. IG hijau, TT abu-abu. */
const platBadges = it => `<span class="kt-plats" aria-label="Status posting">${L.platStatus(it, S.conf).map(x => `<i class="kt-plat${x.done ? ' on' : ''}" title="${esc(x.nama)}: ${x.done ? 'sudah tayang' : 'belum'}">${esc(x.singkat)}</i>`).join('')}</span>`;
/** Yang perlu diposting hari ini, tampil di atas tab Konten. */
function hariIniHTML() {
  const list = L.todayItems(S.items, todayS(), S.conf), target = S.conf?.targetPerHari || 0;
  if (!list.length && !target) return '';
  return `<section class="kt-today"><b>Hari ini</b>${list.map(it => `<a class="kt-tchip" href="${link('', it.id)}">${thumb(it)}<span>${esc(L.validJam(it.jam) ? it.jam : S.conf?.jamDefault || '')} ${esc(short(it.title, 44))}</span>${platBadges(it)}</a>`).join('') || `<span class="kt-muted">Belum ada post terjadwal, target ${esc(target)} per hari.</span>`}</section>`;
}
function subNav() {
  const nR = L.reviewQueue(S.items).length;
  return `<nav class="kt-sub" aria-label="Tampilan Konten">${SUBS.map(s => `<a href="${link(s)}" class="${S.sub === s ? 'on' : ''}" ${S.sub === s ? 'aria-current="page"' : ''}>${SUB_LABEL[s]}${s === 'review' && nR ? `<b>${nR}</b>` : ''}</a>`).join('')}
    <span class="kt-sp"></span><button type="button" class="btn ghost kt-btn sm" data-act="kt-conf" aria-label="Pengaturan Konten">Pengaturan</button></nav>`;
}

/* ---------------- Galeri ---------------- */
function galeriGrid() {
  const list = L.filterItems(S.items, { ...S.filter, conf: S.conf });
  if (!S.items.length) return emptyState();
  if (!list.length) return '<p class="kt-empty">Tidak ada konten yang cocok dengan filter.</p>';
  return `<ul class="kt-cards">${list.map(it => `<li><a class="kt-card" href="${link('', it.id)}"><span class="kt-cv">${thumb(it)}${it.sensitif ? '<i class="kt-tag warn">Sensitif</i>' : ''}<i class="kt-tag j">${ICON_JENIS[it.jenis] || ''}</i></span>
    <span class="kt-ct">${esc(it.title || 'Tanpa judul')}</span><span class="kt-cm">${pill(it.tahapNama || tahapName(it.tahap), 'st-' + esc(it.tahap))}${it.publishAt ? `<small>${esc(fmtTanggal(it.publishAt))}</small>` : ''}</span><span class="kt-cplats">${platBadges(it)}</span></a></li>`).join('')}</ul>`;
}
function galeriHTML() {
  const f = S.filter, st = S.stages;
  const seriOpt = S.seri.map(s => `<option value="${esc(s.nama)}" ${f.seri === s.nama ? 'selected' : ''}>${esc(s.nama)} (${s.n})</option>`).join('');
  return `<div class="kt-bar">
    <div class="kt-pills-row" role="group" aria-label="Tahap"><button type="button" class="kt-chipbtn" data-act="kt-tahap" data-v="" aria-pressed="${!f.tahap}">Semua <b>${S.items.length}</b></button>${st.map(s => `<button type="button" class="kt-chipbtn" data-act="kt-tahap" data-v="${esc(s.id)}" aria-pressed="${f.tahap === s.id}">${esc(s.name)} <b>${s.n ?? 0}</b></button>`).join('')}</div>
    <div class="kt-filters"><input type="search" data-k="q" value="${esc(f.q)}" placeholder="Cari judul atau seri" aria-label="Cari"><select data-act="kt-seri" aria-label="Seri"><option value="">Semua seri</option>${seriOpt}</select>
      <select data-act="kt-belum" aria-label="Status platform"><option value="">Semua platform</option>${Object.entries(L.PLAT).filter(([p]) => (S.conf?.platforms || L.PLAT_ALL).includes(p)).map(([p, n]) => `<option value="${p}" ${f.belum === p ? 'selected' : ''}>Belum di ${esc(n)}</option>`).join('')}</select><select data-act="kt-jenis" aria-label="Jenis"><option value="">Semua jenis</option>${Object.entries(JENIS).map(([k, v]) => `<option value="${k}" ${f.jenis === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button type="button" class="btn primary kt-btn" data-act="kt-baru">Baru</button><button type="button" class="btn kt-btn" data-act="kt-impor">Impor</button></div></div>
    <div id="ktGrid">${galeriGrid()}</div>`;
}

/* ---------------- Review ---------------- */
function reviewHTML() {
  const q = L.reviewQueue(S.items);
  if (!q.length) return '<div class="kt-emptybox"><h3>Antrean review kosong</h3><p>Tidak ada konten yang menunggu keputusanmu.</p></div>';
  let i = q.findIndex(x => x.id === S.rv.id); if (i < 0) i = 0;
  const it = { ...q[i], ...(S.rv.cache[q[i].id] || {}) };
  return `<div class="kt-rv"><div class="kt-rv-nav"><button type="button" class="btn kt-btn" data-act="rv-go" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Sebelumnya">‹</button>
    <span aria-live="polite">${i + 1} dari ${q.length}</span><button type="button" class="btn kt-btn" data-act="rv-go" data-d="1" ${i === q.length - 1 ? 'disabled' : ''} aria-label="Berikutnya">›</button></div>
    <h2 class="kt-rv-t">${esc(it.title || 'Tanpa judul')}</h2><div class="kt-pills">${it.jenis ? pill(it.jenis) : ''}${it.seri ? pill('Seri ' + it.seri) : ''}${it.sensitif ? pill('Sensitif', 'warn') : ''}</div>
    <div class="kt-pk-grid"><div class="kt-pk-media">${S.rv.cache[it.id] ? mediaHTML(it, { full: false }) : '<p class="kt-empty">Memuat media…</p>'}</div><aside class="kt-pk-side">
    ${it.captions?.instagram ? `<section class="kt-card"><h3>Caption Instagram</h3><pre class="kt-capview">${esc(it.captions.instagram)}</pre></section>` : ''}
    ${it.catatan ? `<p class="kt-muted">${esc(it.catatan)}</p>` : ''}
    ${S.rv.form ? `<div class="kt-card"><h3>Minta revisi</h3><textarea data-k="rv-cat" rows="4" placeholder="Apa yang perlu diubah?" aria-label="Catatan revisi"></textarea>
      <label class="kt-f">Slide yang dimaksud (opsional)<input type="number" min="1" inputmode="numeric" data-k="rv-slide"></label>
      <div class="kt-row"><button type="button" class="btn primary kt-btn grow" data-act="rv-kirim">Kirim revisi</button><button type="button" class="btn ghost kt-btn" data-act="rv-batal">Batal</button></div></div>`
    : `<div class="kt-row kt-stick"><button type="button" class="btn primary kt-btn grow" data-act="rv-setuju">Setuju</button><button type="button" class="btn kt-btn grow" data-act="rv-form">Revisi</button><a class="btn ghost kt-btn" href="${link('', it.id)}">Paket</a></div>`}</aside></div></div>`;
}
async function reviewDecide(keputusan) {
  const id = S.rv.id; if (!id) return;
  const body = { keputusan };
  if (keputusan === 'revisi') {
    const c = $('[data-k="rv-cat"]', S.el)?.value.trim(), sl = parseInt($('[data-k="rv-slide"]', S.el)?.value, 10);
    if (!c) { toast('Tulis dulu apa yang perlu direvisi', 'warn'); return; }
    body.catatan = c; if (sl > 0) body.slide = sl;
  }
  const q = L.reviewQueue(S.items), i = q.findIndex(x => x.id === id), nxt = q[i + 1]?.id || q[i - 1]?.id || '';
  await post(`${base()}/${encodeURIComponent(id)}/review`, body);
  toast(keputusan === 'setuju' ? 'Disetujui, masuk Siap tayang' : 'Revisi dikirim', 'ok');
  S.rv.form = false; S.rv.id = nxt; delete S.rv.cache[id];
  await refresh();
}

/* ---------------- Kalender ---------------- */
function calChip(it) {
  const us = it.jadwalStatus === 'usulan';
  return `<span class="kt-cchip${us ? ' usulan' : ''}" draggable="true" data-id="${esc(it.id)}" title="${esc(it.title)}${us ? ' (usulan)' : ''}">${thumb(it)}</span>`;
}
function kalenderHTML() {
  const weeks = L.monthWeeks(S.cursor), m = L.byDay(S.items), month = S.cursor.getMonth(), t = todayS();
  const stats = L.mergeWeeks(L.weekStats(S.items, weeks, S.conf?.targetPerMinggu), S.jadwal?.minggu);
  const warn = (S.jadwal?.peringatan || []).filter(p => p.kode !== 'target-kurang'), us = L.usulanIds(S.items), siap = L.siapList(S.items);
  const pk = siap.find(x => x.id === S.pick) || S.items.find(x => x.id === S.pick);
  if (!S.day || !weeks.flat().includes(S.day)) S.day = weeks.flat().includes(t) ? t : weeks[0][0];
  const dayList = m.get(S.day) || [];
  return `<div class="kt-cal"><div class="kt-calnav"><button type="button" class="btn kt-btn" data-act="cal-prev" aria-label="Bulan sebelumnya">‹</button><h2 aria-live="polite">${MONTHS[month]} ${S.cursor.getFullYear()}</h2><button type="button" class="btn kt-btn" data-act="cal-next" aria-label="Bulan berikutnya">›</button><button type="button" class="btn ghost kt-btn" data-act="cal-today">Hari ini</button>
    <button type="button" class="btn kt-btn" data-act="cal-add">+ Tambah konten</button>
    ${us.length ? `<button type="button" class="btn primary kt-btn" data-act="cal-setujui">Setujui jadwal (${us.length})</button>` : ''}</div>
    ${warn.length ? `<details class="kt-warn" open><summary>${warn.length} peringatan jadwal</summary><ul>${warn.map(p => `<li class="w-${esc(p.kode)}">${esc(L.peringatanText(p))}</li>`).join('')}</ul></details>` : ''}
    ${pk ? `<div class="kt-pickbar" role="status">Pilih tanggal untuk <b>${esc(short(pk.title, 40))}</b><button type="button" class="btn ghost kt-btn sm" data-act="cal-unpick">Batal</button></div>` : ''}
    <div class="kt-calmain"><div class="kt-calgrid" role="grid" aria-label="${MONTHS[month]} ${S.cursor.getFullYear()}"><div class="kt-dow" role="row">${DOW.map(x => `<span role="columnheader">${x}</span>`).join('')}</div>
    ${weeks.map((w, wi) => { const s = stats[wi]; return `<div class="kt-week"><div class="kt-wsum ${s.state}" title="Target ${s.target} per minggu">${fmtTanggal(s.mulai)} - ${fmtTanggal(s.akhir)}: <b>${s.n}${s.target ? '/' + s.target : ''}</b> post${s.state === 'kurang' ? ', kurang' : s.state === 'lebih' ? ', lebih' : ''}</div><div class="kt-days" role="row">${w.map(k => { const d = pdl(k), list = m.get(k) || []; return `<div class="kt-day${d.getMonth() !== month ? ' out' : ''}${k === t ? ' today' : ''}${k === S.day ? ' sel' : ''}" role="gridcell" tabindex="0" data-day="${k}" data-act="cal-day" aria-label="${esc(fmtTanggalPanjang(k))}, ${list.length} konten"><span class="kt-dn">${d.getDate()}</span><span class="kt-dchips">${list.slice(0, 2).map(calChip).join('')}${list.length > 2 ? `<small>+${list.length - 2}</small>` : ''}</span></div>`; }).join('')}</div></div>`; }).join('')}</div>
    <aside class="kt-siap" aria-label="Siap tayang"><h3>Siap tayang <small>${siap.length}</small></h3><p class="kt-muted">Seret ke tanggal, atau tekan lalu pilih tanggal.</p>
      ${siap.map(it => `<button type="button" class="kt-sitem${S.pick === it.id ? ' on' : ''}" draggable="true" data-id="${esc(it.id)}" data-act="cal-pick" aria-pressed="${S.pick === it.id}">${thumb(it)}<span>${esc(short(it.title, 60))}</span></button>`).join('') || '<p class="kt-muted">Belum ada yang siap tayang.</p>'}</aside></div>
    <section class="kt-dayd"><div class="kt-dayh"><h3>${esc(fmtTanggalPanjang(S.day))}</h3><button type="button" class="btn kt-btn sm" data-act="cal-add">+ Tambah di tanggal ini</button></div>${dayList.map(it => `<div class="kt-drow">${thumb(it)}<div class="kt-dinfo"><a href="${link('', it.id)}">${esc(it.title)}</a>${platBadges(it)}<small>${esc(L.validJam(it.jam) ? it.jam : '')} ${it.jadwalStatus === 'usulan' ? '· usulan editor' : ''} ${esc(it.tahapNama || tahapName(it.tahap))}</small></div>
      <div class="kt-dacts">${it.tahap === 'tayang' ? '<span class="kt-pill ok">Tayang</span>' : `<button type="button" class="btn kt-btn sm" data-act="cal-tayang" data-id="${esc(it.id)}">Tandai tayang</button>`}<input type="date" class="kt-dd" data-act="cal-move" data-id="${esc(it.id)}" value="${esc(it.publishAt)}" aria-label="Pindah tanggal ${esc(it.title)}"></div></div>`).join('') || '<p class="kt-muted">Belum ada konten di tanggal ini.</p>'}</section></div>`;
}
/** Tambah ke tanggal terpilih: cari post yang belum berjadwal, atau buat yang baru. */
function calAddForm() {
  const day = S.day, pool = S.items.filter(x => !x.publishAt && x.tahap !== 'tayang' && x.tahap !== 'arsip').sort((a, b) => (b.tahap === 'siap') - (a.tahap === 'siap'));
  const row = it => `<button type="button" class="kt-addrow" data-pick="${esc(it.id)}" data-q="${esc(`${it.title} ${it.seri || ''}`.toLowerCase())}">${thumb(it)}<span><b>${esc(short(it.title, 70))}</b><small>${esc(it.tahapNama || tahapName(it.tahap))}${it.seri ? ` · ${esc(it.seri)}` : ''}</small></span></button>`;
  modal({ title: `Tambah konten, ${fmtTanggalPanjang(day)}`, html: `<div class="kt-form kt-addf"><input type="search" id="caQ" placeholder="Cari dari ${pool.length} post yang belum berjadwal" aria-label="Cari post"><div class="kt-addlist" id="caL">${pool.map(row).join('') || '<p class="kt-muted">Semua post sudah berjadwal.</p>'}</div>
    <h4>Atau buat baru</h4><label class="kt-f">Judul<input id="caT" type="text"></label><label class="kt-f">Jenis<select id="caJ">${Object.entries(JENIS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label></div>`,
  actions: [{ label: 'Buat di tanggal ini', kind: 'primary', fn: () => {
    const title = $('#caT').value.trim(); if (!title) { toast('Tulis judulnya, atau pilih post dari daftar', 'warn'); return false; }
    (async () => { const it = await post(base(), { title, jenis: $('#caJ').value, tahap: 'ide' }); await patch(`${base()}/${encodeURIComponent(it.id)}`, { publishAt: day, jam: S.conf?.jamDefault }); toast(`"${short(title, 36)}" ditambahkan`, 'ok'); await refresh(); })().catch(e => toast(e.message, 'bad'));
  } }, { label: 'Batal' }] });
  $('#caQ').addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); for (const b of $('#caL').querySelectorAll('[data-pick]')) b.hidden = !!q && !b.dataset.q.includes(q); });
  $('#caL').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (!b) return; closeModal(); calSchedule(b.dataset.pick, day); });
}
async function calSchedule(id, day) {
  const it = S.items.find(x => x.id === id); if (!it || !L.validDate(day) || it.publishAt === day) return;
  try {
    await patch(`${base()}/${encodeURIComponent(id)}`, L.moveBody(it, day, S.conf));
    toast(`"${short(it.title, 36)}" dijadwalkan ${fmtTanggal(day, true)}`, 'ok'); S.pick = ''; S.day = day;
  } catch (e) { toast(e.message, 'bad'); }
  await refresh();
}

/* ---------------- Grid ---------------- */
function gridHTML() {
  const list = L.gridOrder(S.items);
  if (!list.length) return '<div class="kt-emptybox"><h3>Grid masih kosong</h3><p>Isi grid dari konten yang sudah terjadwal atau tayang.</p></div>';
  return `<p class="kt-muted">Seperti profil: terjadwal paling atas, lalu yang sudah tayang.</p><ul class="kt-igrid">${list.map(it => `<li><a href="${link('', it.id)}" class="kt-gi${it.tahap === 'terjadwal' ? ' sched' : ''}${it.jadwalStatus === 'usulan' ? ' usulan' : ''}" aria-label="${esc(it.title)}">${thumb(it)}<i class="kt-tag j">${ICON_JENIS[it.jenis] || ''}</i>${it.tahap === 'terjadwal' ? `<i class="kt-tag when">${esc(fmtTanggal(it.publishAt))}${L.validJam(it.jam) ? ' ' + esc(it.jam) : ''}</i>` : ''}</a></li>`).join('')}</ul>`;
}

/* ---------------- Kit ---------------- */
function kitHTML() {
  const list = S.kit || [];
  const groups = Object.keys(KIT_JENIS).map(j => [j, list.filter(k => (KIT_JENIS[k.jenis] ? k.jenis : 'lain') === j)]).filter(([, l]) => l.length);
  return `<div class="kt-bar"><button type="button" class="btn primary kt-btn" data-act="kit-baru">Tambah ke kit</button>${S.kitErr ? `<span class="kt-muted">${esc(S.kitErr)}</span>` : ''}</div>
    ${groups.map(([j, l]) => `<section class="kt-kitg"><h3>${esc(KIT_JENIS[j])}</h3><ul class="kt-kit">${l.map(k => { const isi = k.isi || [], head = isi[0];
      return `<li class="kt-kcard"><div class="kt-khead">${head ? `<button type="button" class="kt-kmain" data-act="kit-lihat" data-url="${esc(head.url)}" data-thumb="${esc(head.thumb)}" data-kind="${esc(head.kind)}" data-name="${esc(head.name)}" aria-label="Lihat ${esc(k.nama)}"><img src="${esc(head.thumb)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.kt-kmain').classList.add('noimg')"><span>${esc(head.name)}</span></button>` : `<div class="kt-kmain none">${k.ada === false ? 'Berkas tidak ditemukan' : 'Tidak ada yang bisa dipratinjau'}</div>`}</div>
        ${isi.length > 1 ? `<div class="kt-kstrip">${isi.slice(1).map(f => `<button type="button" data-act="kit-lihat" data-url="${esc(f.url)}" data-thumb="${esc(f.thumb)}" data-kind="${esc(f.kind)}" data-name="${esc(f.name)}" title="${esc(f.name)}" aria-label="Lihat ${esc(f.name)}"><img src="${esc(f.thumb)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}
        <div class="kt-kinfo"><b>${esc(k.nama)}</b>${k.n > 1 ? `<small>${esc(k.n)} berkas</small>` : ''}${k.catatan ? `<small>${esc(k.catatan)}</small>` : ''}<code>${esc(k.path)}</code></div>
        <button type="button" class="btn ghost kt-btn sm" data-act="kit-hapus" data-id="${esc(k.id)}" data-n="${esc(k.nama)}">Hapus</button></li>`; }).join('')}</ul></section>`).join('') || '<div class="kt-emptybox"><h3>Kit masih kosong</h3><p>Simpan logo, outro, slide jualan, acuan, dan SFX supaya semua orang tahu letaknya.</p></div>'}`;
}
function kitLihat({ url, thumb: th, kind, name }) {
  const body = kind === 'video' ? `<video class="kt-kview" controls autoplay playsinline src="${esc(url)}"></video>` : `<img class="kt-kview" src="${esc(kind === 'html' ? th : url)}" alt="${esc(name)}">`;
  modal({ title: name, html: `${body}${kind === 'html' ? '<p class="kt-muted">Desain HTML, ditampilkan sebagai gambar.</p>' : ''}` });
}
function kitForm() {
  modal({ title: 'Tambah ke kit', html: `<div class="kt-form"><label class="kt-f">Jenis<select id="kitJenis">${Object.entries(KIT_JENIS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
    <label class="kt-f">Nama<input id="kitNama" type="text"></label><label class="kt-f">Path di folder konten<input id="kitPath" type="text" placeholder="_kit/logo.png"></label><label class="kt-f">Catatan<input id="kitCat" type="text"></label></div>`,
  actions: [{ label: 'Tambah', kind: 'primary', fn: () => { const b = { jenis: $('#kitJenis').value, nama: $('#kitNama').value.trim(), path: $('#kitPath').value.trim(), catatan: $('#kitCat').value.trim() }; if (!b.nama || !b.path) { toast('Nama dan path wajib diisi', 'warn'); return false; } post(`${base()}/kit`, b).then(() => { toast('Ditambahkan ke kit', 'ok'); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
}

/* ---------------- Performa ---------------- */
function performaHTML() {
  const plats = (S.conf?.platforms?.length ? S.conf.platforms : L.PLAT_ALL).filter(p => PLAT[p]);
  if (!S.perf.plat || !plats.includes(S.perf.plat)) S.perf.plat = plats[0] || 'instagram';
  const p = S.perf.plat, rows = L.sortPerf(L.perfRows(S.items, p), S.perf.metric, S.perf.dir);
  const th = (k, label) => `<button type="button" data-act="pf-sort" data-m="${k}" aria-label="Urutkan ${esc(label)}" class="${S.perf.metric === k ? 'on' : ''}">${esc(label)}${S.perf.metric === k ? (S.perf.dir < 0 ? ' ↓' : ' ↑') : ''}</button>`;
  return `<div class="kt-bar"><div class="kt-pills-row" role="group" aria-label="Platform">${plats.map(x => `<button type="button" class="kt-chipbtn" data-act="pf-plat" data-v="${x}" aria-pressed="${p === x}">${esc(PLAT[x])}</button>`).join('')}</div></div>
    ${rows.length ? `<div class="kt-pf" role="table" aria-label="Performa ${esc(PLAT[p])}"><div class="kt-pf-h" role="row"><span>${th('title', 'Post')}</span>${METRIK.map(m => `<span>${th(m, METRIK_LABEL[m])}</span>`).join('')}</div>
      ${rows.map(({ it, p: pf }) => `<div class="kt-pf-r" role="row"><a class="kt-pf-t" href="${link('', it.id)}">${esc(short(it.title, 70))}</a>${METRIK.map(m => `<span class="kt-pf-n" data-l="${esc(METRIK_LABEL[m])}">${esc(fmtNum(pf?.[m]))}</span>`).join('')}<button type="button" class="btn kt-btn sm kt-pf-b" data-act="pf-isi" data-id="${esc(it.id)}">${pf ? 'Ubah' : 'Isi'}</button></div>`).join('')}</div>`
    : `<div class="kt-emptybox"><h3>Belum ada post tayang di ${esc(PLAT[p])}</h3><p>Setelah ditandai tayang di Paket Posting, post muncul di sini untuk diisi angkanya.</p></div>`}`;
}
function perfForm(id) {
  const it = S.items.find(x => x.id === id); if (!it) return; const p = S.perf.plat, pf = it.perf?.[p] || {};
  modal({ title: `Performa ${PLAT[p]}`, body: esc(short(it.title, 80)), html: `<div class="kt-perf-g">${METRIK.map(m => `<label class="kt-f">${esc(METRIK_LABEL[m])}<input id="pf-${m}" type="number" min="0" inputmode="numeric" value="${pf[m] ?? ''}"></label>`).join('')}</div>`,
    actions: [{ label: 'Simpan', kind: 'primary', fn: () => { const b = { platform: p }; for (const m of METRIK) { const v = $('#pf-' + m).value; if (v !== '') b[m] = L.num(v); } post(`${base()}/${encodeURIComponent(id)}/performa`, b).then(() => { toast('Performa disimpan', 'ok'); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
}

/* ---------------- dialog: baru, impor, pengaturan, revisi ---------------- */
function baruForm() {
  modal({ title: 'Konten baru', html: `<div class="kt-form"><label class="kt-f">Judul<input id="nbT" type="text"></label><label class="kt-f">Jenis<select id="nbJ">${Object.entries(JENIS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
    <label class="kt-f">Seri (opsional)<input id="nbS" type="text"></label></div>`,
  actions: [{ label: 'Buat', kind: 'primary', fn: () => { const title = $('#nbT').value.trim(); if (!title) { toast('Judul wajib diisi', 'warn'); return false; } post(base(), { title, jenis: $('#nbJ').value, seri: $('#nbS').value.trim() || undefined, tahap: 'ide' }).then(it => { toast('Konten dibuat', 'ok'); if (it?.id) location.hash = link('', it.id); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
}
async function imporFlow() {
  try {
    const r = await post(`${base()}/impor`, { dryRun: true });
    const per = Object.entries(r?.perTahap || {}).map(([k, v]) => `<li>${esc(tahapName(k))}: <b>${esc(v)}</b></li>`).join('');
    modal({ title: 'Impor folder konten', html: `<p>Akan dibuat <b>${esc(r?.dibuat ?? 0)}</b> kartu baru, <b>${esc(r?.dilewati ?? 0)}</b> dilewati karena sudah ada. Tidak ada berkas yang dipindah atau diubah.</p>${per ? `<ul>${per}</ul>` : ''}${(r?.contoh || []).length ? `<p class="kt-muted">Contoh: ${esc((r.contoh || []).slice(0, 4).map(x => typeof x === 'string' ? x : x.title || x.folder || '').join(', '))}</p>` : ''}`,
      actions: [{ label: 'Impor sekarang', kind: 'primary', fn: () => { post(`${base()}/impor`, { dryRun: false }).then(x => { toast(`Impor selesai: ${x?.dibuat ?? 0} baru`, 'ok'); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
  } catch (e) { toast(e.message, 'bad'); }
}
async function confForm() {
  let c = S.conf || {};
  try { c = await api(`${base()}/conf`); } catch {}
  modal({ title: 'Pengaturan Konten', html: `<div class="kt-form"><label class="kt-f">Folder konten (relatif ke akar kantor)<input id="cfRoot" type="text" value="${esc(c.root || '')}"></label>
    <label class="kt-f">Target post per hari<input id="cfTH" type="number" min="0" inputmode="numeric" value="${esc(c.targetPerHari ?? 0)}"></label>
    <label class="kt-f">Target post per minggu<input id="cfT" type="number" min="0" inputmode="numeric" value="${esc(c.targetPerMinggu ?? 5)}"></label>
    <label class="kt-f">Jam default<input id="cfJ" type="time" value="${esc(c.jamDefault || '19:00')}"></label>
    <h4 class="kt-fh">Pengingat ke HP</h4>
    <label class="kt-check"><input id="cfRA" type="checkbox" ${c.pengingat?.aktif !== false ? 'checked' : ''}> Aktif</label>
    <label class="kt-f">Ringkasan pagi, jam (kosong = mati)<input id="cfRP" type="time" value="${esc(c.pengingat?.pagi ?? '08:00')}"></label>
    <label class="kt-f">Ingatkan sebelum jam tayang (menit)<input id="cfRS" type="number" min="0" inputmode="numeric" value="${esc(c.pengingat?.sebelumMenit ?? 15)}"></label>
    <label class="kt-f">Ingatkan kalau belum ditandai tayang (menit sesudahnya, 0 = mati)<input id="cfRL" type="number" min="0" inputmode="numeric" value="${esc(c.pengingat?.terlewatMenit ?? 120)}"></label>
    <label class="kt-f">Ingatkan platform yang belum disusul (jam sesudah tayang, 0 = mati)<input id="cfRU" type="number" min="0" inputmode="numeric" value="${esc(c.pengingat?.susulanJam ?? 3)}"></label>
    <button type="button" class="btn kt-btn" id="cfTes">Kirim tes ke HP</button>
    <label class="kt-check"><input id="cfP" type="checkbox" ${c.pindahFolder !== false ? 'checked' : ''}> Pindahkan folder ke sudah-posting saat ditandai tayang</label></div>`,
  actions: [{ label: 'Simpan', kind: 'primary', fn: () => { patch(`${base()}/conf`, { root: $('#cfRoot').value.trim(), pengingat: { aktif: $('#cfRA').checked, pagi: $('#cfRP').value, sebelumMenit: L.num($('#cfRS').value), terlewatMenit: L.num($('#cfRL').value), susulanJam: L.num($('#cfRU').value) }, targetPerHari: L.num($('#cfTH').value), targetPerMinggu: L.num($('#cfT').value), jamDefault: $('#cfJ').value || '19:00', pindahFolder: $('#cfP').checked }).then(() => { toast('Pengaturan disimpan', 'ok'); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
  $('#cfTes')?.addEventListener('click', () => post(`${base()}/pengingat/tes`, {}).then(() => toast('Tes dikirim, cek HP-mu', 'ok')).catch(e => toast(e.message, 'bad')));
}
function revisiForm(it) {
  modal({ title: 'Minta revisi', body: esc(short(it.title, 80)), html: `<div class="kt-form"><label class="kt-f">Apa yang perlu diubah?<textarea id="rvC" rows="4"></textarea></label><label class="kt-f">Slide (opsional)<input id="rvS" type="number" min="1" inputmode="numeric"></label></div>`,
    actions: [{ label: 'Kirim revisi', kind: 'primary', fn: () => { const c = $('#rvC').value.trim(); if (!c) { toast('Tulis dulu catatannya', 'warn'); return false; } const sl = parseInt($('#rvS').value, 10); post(`${base()}/${encodeURIComponent(it.id)}/review`, { keputusan: 'revisi', catatan: c, ...(sl > 0 ? { slide: sl } : {}) }).then(() => { toast('Revisi dikirim', 'ok'); return refresh(); }).catch(e => toast(e.message, 'bad')); } }, { label: 'Batal' }] });
}

/* ---------------- paint ---------------- */
function bodyHTML() {
  if (S.cid) {
    if (!S.detail) return `<a class="kt-back" href="${link(prefGet().sub || 'galeri')}">‹ Konten</a><div class="kt-emptybox"><h3>Konten tidak ditemukan</h3><p>${esc(S.detailErr || 'Mungkin sudah dihapus.')}</p></div>`;
    return paketHTML(S.detail, S.conf, link(prefGet().sub || 'galeri'));
  }
  if (S.err && !S.items.length && !S.missing) return `<div class="notice">${esc(S.err)} <button type="button" class="btn kt-btn sm" data-act="kt-retry">Coba lagi</button></div>${subNav()}${emptyState()}`;
  const v = { galeri: galeriHTML, review: reviewHTML, kalender: kalenderHTML, grid: gridHTML, kit: kitHTML, performa: performaHTML }[S.sub]();
  return `${subNav()}${S.err ? `<div class="notice info">${esc(S.err)}</div>` : ''}<div class="kt-view">${S.sub === 'galeri' || S.sub === 'kalender' ? hariIniHTML() : ''}${v}</div>`;
}
function paint() {
  if (!S.el) return;
  const html = `<div class="kt">${bodyHTML()}</div>`;
  keepState(S.el, () => { S.el.innerHTML = html; });
  bindMedia(S.el, S.cid || S.rv?.id || '');
  S.last = L.sig([S.items, S.stages, S.conf, S.detail, S.rv.cache[S.rv.id], S.jadwal, S.kit, S.sub, S.cid]);
}

/* ---------------- interaksi ---------------- */
const paketHost = {
  get root() { return S.el; }, get oid() { return S.oid; }, base, item: () => S.detail, conf: () => S.conf,
  refresh: () => refresh(), revisi: it => revisiForm(it),
};
function bind() {
  const el = S.el;
  const h = {
    click: async e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (a.startsWith('pk-')) { if (b.type === 'checkbox') return; if (await paketAct(a, b, paketHost)) return; }
      switch (a) {
        case 'kt-tahap': S.filter.tahap = b.dataset.v; paint(); break;
        case 'kt-baru': baruForm(); break;
        case 'kt-impor': imporFlow(); break;
        case 'kt-conf': confForm(); break;
        case 'kt-retry': refresh(); break;
        case 'rv-go': { const q = L.reviewQueue(S.items), i = q.findIndex(x => x.id === S.rv.id), n = q[i + Number(b.dataset.d)]; if (n) { S.rv.id = n.id; S.rv.form = false; await fetchReviewDetail(); paint(); } break; }
        case 'rv-setuju': b.disabled = true; try { await reviewDecide('setuju'); } catch (err) { toast(err.message, 'bad'); b.disabled = false; } break;
        case 'rv-form': S.rv.form = true; paint(); $('[data-k="rv-cat"]', el)?.focus(); break;
        case 'rv-batal': S.rv.form = false; paint(); break;
        case 'rv-kirim': b.disabled = true; try { await reviewDecide('revisi'); } catch (err) { toast(err.message, 'bad'); b.disabled = false; } break;
        case 'cal-prev': case 'cal-next': S.cursor = new Date(S.cursor.getFullYear(), S.cursor.getMonth() + (a === 'cal-prev' ? -1 : 1), 1); S.day = ''; await fetchJadwal(); paint(); break;
        case 'cal-today': S.cursor = new Date(); S.day = todayS(); await fetchJadwal(); paint(); break;
        case 'cal-pick': S.pick = S.pick === b.dataset.id ? '' : b.dataset.id; paint(); break;
        case 'cal-add': calAddForm(); break;
        case 'cal-tayang': { const it = S.items.find(x => x.id === b.dataset.id); if (it) tayangDialog(it, S.conf, base(), () => refresh()); break; }
        case 'kit-lihat': kitLihat(b.dataset); break;
        case 'cal-unpick': S.pick = ''; paint(); break;
        case 'cal-day': if (S.pick) calSchedule(S.pick, b.dataset.day); else { S.day = b.dataset.day; paint(); } break;
        case 'cal-setujui': {
          const ids = L.usulanIds(S.items); b.disabled = true;
          try { await post(`${base()}/jadwal/setujui`, { ids }); toast(`${ids.length} jadwal disetujui`, 'ok'); await refresh(); } catch (err) { toast(err.message, 'bad'); b.disabled = false; }
          break;
        }
        case 'kit-baru': kitForm(); break;
        case 'kit-hapus': confirmDo('Hapus dari kit?', esc(b.dataset.n), 'Hapus', async () => { try { await del(`${base()}/kit/${encodeURIComponent(b.dataset.id)}`); toast('Dihapus dari kit', 'ok'); await refresh(); } catch (err) { toast(err.message, 'bad'); } }); break;
        case 'pf-plat': S.perf.plat = b.dataset.v; paint(); break;
        case 'pf-sort': { const m = b.dataset.m; S.perf.dir = S.perf.metric === m ? -S.perf.dir : (m === 'title' ? 1 : -1); S.perf.metric = m; paint(); break; }
        case 'pf-isi': perfForm(b.dataset.id); break;
      }
    },
    change: async e => {
      const t = e.target, a = t.dataset?.act;
      if (a === 'pk-sensitif') { await paketAct(a, t, paketHost); return; }
      if (a === 'kt-seri') { S.filter.seri = t.value; paint(); }
      else if (a === 'kt-belum') { S.filter.belum = t.value; paint(); }
      else if (a === 'kt-jenis') { S.filter.jenis = t.value; paint(); }
      else if (a === 'cal-move') { await calSchedule(t.dataset.id, t.value); }
    },
    input: e => {
      if (e.target.dataset?.k === 'q') { S.filter.q = e.target.value; const g = $('#ktGrid', el); if (g) g.innerHTML = galeriGrid(); return; }
      paketInput(e);
    },
    keydown: e => { const d = e.target.closest?.('[data-act="cal-day"]'); if (d && (e.key === 'Enter' || e.key === ' ') && e.target === d) { e.preventDefault(); d.click(); } },
    dragstart: e => { const c = e.target.closest?.('[data-id][draggable="true"]'); if (!c) return; S.drag = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', S.drag); } catch {} },
    dragend: () => { S.drag = ''; $$('.dragging,.over', el).forEach(x => x.classList.remove('dragging', 'over')); },
    dragover: e => { const d = e.target.closest?.('.kt-day'); if (!d || !S.drag) return; e.preventDefault(); if (!d.classList.contains('over')) { $$('.over', el).forEach(x => x.classList.remove('over')); d.classList.add('over'); } },
    drop: e => { const d = e.target.closest?.('.kt-day'); if (!d || !S.drag) return; e.preventDefault(); const id = S.drag; h.dragend(); calSchedule(id, d.dataset.day); },
    error: e => { const t = e.target; if (t?.tagName === 'IMG') { t.classList.add('broken'); t.removeAttribute('src'); } },
  };
  for (const [n, f] of Object.entries(h)) el.addEventListener(n, f, n === 'error');
  S.h = h;
}
function unbind() { if (S.h && S.el) for (const [n, f] of Object.entries(S.h)) S.el.removeEventListener(n, f, n === 'error'); S.h = null; }

/* ---------------- modul ---------------- */
function applyRoute(r) {
  const { sub, cid } = L.parseRoute(r?.rest);
  S.cid = cid;
  S.sub = sub || (SUBS.includes(prefGet().sub) ? prefGet().sub : 'galeri');
  if (sub) prefSet({ sub });
}
export async function render(el, ctx, r) {
  unbind(); clearTimeout(S.timer);
  Object.assign(S, { ctx, el, oid: ctx.office.id, loaded: false, err: '', missing: false, items: [], stages: [], seri: [], conf: {}, detail: null, detailErr: '', jadwal: null, kit: null, pick: '', drag: '', day: '', cursor: new Date(), last: '', filter: { tahap: '', seri: '', jenis: '', q: '' }, rv: { id: '', cache: {}, form: false } });
  applyRoute(r);
  el.classList.add('kt-root');
  el.innerHTML = '<p class="empty-line">Memuat konten…</p>';
  bind();
  await refresh();
}
export async function route(r) {
  if (!S.el) return;
  const prevKey = `${S.sub}|${S.cid}`;
  applyRoute(r);
  if (prevKey === `${S.sub}|${S.cid}`) return;
  S.pick = ''; S.rv.form = false;
  S.el.innerHTML = '<p class="empty-line">Memuat…</p>';
  window.scrollTo({ top: 0, behavior: 'instant' });
  await refresh();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
export function live(msg, ctx) {
  if (!S.el || !S.oid) return;
  if (ctx) S.ctx = ctx;
  if ((msg.t === 'changed' && msg.what === 'konten' && (msg.office === S.oid || msg.office === '*')) || msg.t === 'reconnected') {
    clearTimeout(S.timer);
    S.timer = setTimeout(async () => {
      if (!S.el || S.drag) return;
      const n = ++S.seq;
      await Promise.all([fetchList(), fetchExtra()]);
      if (n !== S.seq || !S.el || S.drag) return;
      const now = L.sig([S.items, S.stages, S.conf, S.detail, S.rv.cache[S.rv.id], S.jadwal, S.kit, S.sub, S.cid]);
      if (now !== S.last) paint();
    }, 300);
  }
}
export function unmount() {
  unbind(); clearTimeout(S.timer); clearFileCache();
  S.el?.classList.remove('kt-root'); S.el = null; S.oid = null; S.seq++;
}
