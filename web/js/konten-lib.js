// Logika murni tab Konten (tanpa DOM): tanggal, pengelompokan kalender per minggu, urutan grid, filter, format, rute.
// Dites di test/konten-web.test.js.

export const PLAT = { instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube' };
export const PLAT_ALL = Object.keys(PLAT);
export const JENIS = { carousel: 'Carousel', video: 'Video', lain: 'Lain' };
export const SUBS = ['galeri', 'review', 'kalender', 'grid', 'kit', 'performa'];
export const SUB_LABEL = { galeri: 'Galeri', review: 'Review', kalender: 'Kalender', grid: 'Grid', kit: 'Kit', performa: 'Performa' };
export const KIT_JENIS = { logo: 'Logo', outro: 'Outro', 'slide-jualan': 'Slide jualan', acuan: 'Acuan', sfx: 'SFX', lain: 'Lain' };
export const METRIK = ['reach', 'like', 'comment', 'save', 'share'];
export const METRIK_LABEL = { reach: 'Jangkauan', like: 'Suka', comment: 'Komen', save: 'Simpan', share: 'Bagikan' };
export const WARN_LABEL = {
  'seri-berdempet': 'Seri sama berdempetan', 'sensitif-berjejer': 'Dua konten sensitif berurutan',
  'harian-lebih': 'Melebihi target harian', 'target-lebih': 'Melebihi target mingguan', 'target-kurang': 'Kurang dari target mingguan',
  'tanpa-caption': 'Belum ada caption', 'tanpa-media': 'Belum ada media',
};
export const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const DOW = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/* ---------------- tanggal (string YYYY-MM-DD, waktu lokal) ---------------- */
const pad = n => String(n).padStart(2, '0');
export const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const pdl = s => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || ''); if (!m) return null; const d = new Date(+m[1], m[2] - 1, +m[3]); return d.getMonth() === m[2] - 1 ? d : null; };
export const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const monday = d => addD(d, -((d.getDay() + 6) % 7));
export const mondayOf = s => { const d = pdl(s); return d ? ds(monday(d)) : ''; };
export const validDate = s => !!pdl(s);
export const validJam = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

export function fmtTanggal(s, withYear = false) {
  const d = pdl(s); if (!d) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${withYear ? ' ' + d.getFullYear() : ''}`;
}
export function fmtTanggalPanjang(s) {
  const d = pdl(s); if (!d) return '';
  return `${['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** Tanggal dari ISO datetime ('at' platform) jadi "4 Nov 2026"; kosong kalau tidak terbaca. */
export function fmtAt(iso) {
  const t = Date.parse(iso || ''); if (!t) return '';
  const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}
export function fmtNum(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '').replace('.', ',') + ' jt';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '').replace('.', ',') + ' rb';
  return n.toLocaleString('id-ID');
}
export function fmtSize(b) {
  b = Number(b); if (!Number.isFinite(b) || b <= 0) return '';
  if (b >= 1048576) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
export const num = v => { const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

/* ---------------- rute: rest dari #/o/<id>/konten/... ---------------- */
export function parseRoute(rest = []) {
  const a = (rest || []).filter(Boolean);
  if (a[0] === 'p' && a[1]) return { sub: 'galeri', cid: a[1] };
  return { sub: SUBS.includes(a[0]) ? a[0] : '', cid: null };
}
export const hashFor = (oid, sub, cid) => `#/o/${encodeURIComponent(oid)}/konten${cid ? `/p/${encodeURIComponent(cid)}` : sub ? `/${sub}` : ''}`;

/* ---------------- item ---------------- */
export const isTayang = it => it?.tahap === 'tayang';
export const platformsOf = it => Object.keys(it?.platforms || {});
/** Platform yang ditawarkan untuk satu jenis: carousel tidak ke youtube. */
export function platformsFor(jenis, conf, item) {
  const base = item?.platformTarget?.length ? item.platformTarget : (conf?.platforms?.length ? conf.platforms : PLAT_ALL);
  return base.filter(p => PLAT[p] && !(jenis === 'carousel' && p === 'youtube'));
}
/** Waktu tayang paling awal dari platforms (ms), atau 0. */
export function tayangMs(it) {
  let best = 0;
  for (const v of Object.values(it?.platforms || {})) { const t = Date.parse(v?.at || ''); if (t && (!best || t < best)) best = t; }
  return best;
}
/** Kunci tanggal-jam untuk urut: publishAt + jam (default 00:00). */
const slot = it => (it?.publishAt ? `${it.publishAt}T${validJam(it.jam) ? it.jam : '00:00'}` : '');

/** Status tiap platform sebuah post: [{ p, nama, singkat, done, link }]. Carousel tidak ke YouTube. */
const PLAT_SINGKAT = { instagram: 'IG', threads: 'TH', tiktok: 'TT', youtube: 'YT' };
export function platStatus(it, conf) {
  return platformsFor(it?.jenis, conf, it).map(p => ({ p, nama: PLAT[p], singkat: PLAT_SINGKAT[p], done: !!it?.platforms?.[p], link: it?.platforms?.[p]?.link || '' }));
}
export const belumDi = (it, p, conf) => platformsFor(it?.jenis, conf, it).includes(p) && !it?.platforms?.[p];
/** Post tanggal `day` yang belum tayang, urut jam. */
export function todayItems(items, day, conf) {
  const jam = it => (validJam(it.jam) ? it.jam : conf?.jamDefault || '');
  return (items || []).filter(it => it.publishAt === day && it.tahap !== 'tayang' && it.tahap !== 'arsip').sort((a, b) => jam(a).localeCompare(jam(b)));
}
export function filterItems(items, f = {}) {
  const q = String(f.q || '').trim().toLowerCase();
  return (items || []).filter(it =>
    (!f.belum || belumDi(it, f.belum, f.conf)) && (!f.tahap || it.tahap === f.tahap) && (!f.seri || it.seri === f.seri) && (!f.jenis || it.jenis === f.jenis) &&
    (!q || `${it.title || ''} ${it.seri || ''} ${it.folder || ''} ${it.catatan || ''}`.toLowerCase().includes(q)));
}

/** Antrean review: paling lama menunggu dulu. */
export function reviewQueue(items) {
  return (items || []).filter(it => it.tahap === 'review').sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Urutan grid ala profil IG: terjadwal paling atas (tanggal terjauh dulu, jadi yang terdekat menempel ke yang sudah tayang),
 * lalu yang sudah tayang (terbaru dulu). Yang tanpa tanggal di tiap kelompok jatuh ke akhir kelompoknya.
 */
export function gridOrder(items) {
  const sched = [], done = [];
  for (const it of items || []) { if (it.tahap === 'terjadwal') sched.push(it); else if (it.tahap === 'tayang') done.push(it); }
  const byDesc = (key) => (a, b) => { const ka = key(a), kb = key(b); if (!ka && !kb) return String(a.id).localeCompare(String(b.id)); if (!ka) return 1; if (!kb) return -1; return kb < ka ? -1 : kb > ka ? 1 : String(a.id).localeCompare(String(b.id)); };
  sched.sort(byDesc(slot));
  done.sort(byDesc(it => { const t = tayangMs(it); return t ? new Date(t).toISOString() : slot(it); }));
  return [...sched, ...done];
}

/* ---------------- kalender ---------------- */
/** Minggu-minggu (Senin awal) yang menutupi satu bulan: [[7 string tanggal], ...]. */
export function monthWeeks(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1), last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const a = monday(first), n = Math.ceil((Math.round((last - a) / 864e5) + 1) / 7);
  return Array.from({ length: n }, (_, w) => Array.from({ length: 7 }, (_, i) => ds(addD(a, w * 7 + i))));
}
/** Kelompokkan item berjadwal menurut tanggal: Map(tanggal -> item[]), urut jam lalu judul. */
export function byDay(items) {
  const m = new Map();
  for (const it of items || []) { if (!validDate(it.publishAt) || it.tahap === 'arsip') continue; (m.get(it.publishAt) || m.set(it.publishAt, []).get(it.publishAt)).push(it); }
  for (const l of m.values()) l.sort((a, b) => (validJam(a.jam) ? a.jam : '99:99').localeCompare(validJam(b.jam) ? b.jam : '99:99') || String(a.title).localeCompare(String(b.title)));
  return m;
}
/** Hitung per minggu (kunci = tanggal Senin) dan nilai status terhadap target. */
export function weekStats(items, weeks, target) {
  const cnt = new Map();
  for (const it of items || []) { if (it.tahap === 'arsip' || !validDate(it.publishAt)) continue; const k = mondayOf(it.publishAt); cnt.set(k, (cnt.get(k) || 0) + 1); }
  return weeks.map(w => {
    const mulai = w[0], n = cnt.get(mulai) || 0, t = Number(target) || 0;
    return { mulai, akhir: w[6], n, target: t, state: !t ? 'ok' : n > t ? 'lebih' : n < t ? 'kurang' : 'ok' };
  });
}
/** Gabungkan minggu dari server (kalau ada) dengan hitungan lokal; server menang bila tanggalnya sama. */
export function mergeWeeks(local, server) {
  const sv = new Map((server || []).map(x => [x.mulai, x]));
  return local.map(w => { const s = sv.get(w.mulai); if (!s) return w; const n = Number.isFinite(+s.n) ? +s.n : w.n, t = Number.isFinite(+s.target) ? +s.target : w.target; return { ...w, n, target: t, state: !t ? 'ok' : n > t ? 'lebih' : n < t ? 'kurang' : 'ok' }; });
}
/** Item yang masih usulan editor dan layak disetujui. */
export const usulanIds = items => (items || []).filter(it => it.jadwalStatus === 'usulan' && it.publishAt && it.tahap !== 'tayang').map(it => it.id);
/** Panel "Siap tayang": tahap siap, belum bertanggal. */
export const siapList = items => (items || []).filter(it => it.tahap === 'siap' && !it.publishAt).sort((a, b) => String(a.title).localeCompare(String(b.title)));
export function peringatanText(p) {
  const base = WARN_LABEL[p?.kode] || p?.pesan || String(p?.kode || '');
  const when = p?.tanggal ? ` (${fmtTanggal(p.tanggal)})` : '';
  return p?.pesan && WARN_LABEL[p.kode] && p.pesan !== base ? `${base}${when}: ${p.pesan}` : `${base}${when}`;
}
/** Ganti tanggal dengan mempertahankan jam; mengembalikan badan PATCH. */
export const moveBody = (it, day, conf) => ({ publishAt: day, jam: validJam(it?.jam) ? it.jam : (validJam(conf?.jamDefault) ? conf.jamDefault : '19:00') });

/* ---------------- performa ---------------- */
export function perfRows(items, platform) {
  return (items || []).filter(it => it.tahap === 'tayang' && it.platforms?.[platform]).map(it => ({ it, p: it.perf?.[platform] || null }));
}
export function sortPerf(rows, metric, dir = -1) {
  const val = r => (metric === 'title' ? String(r.it.title || '').toLowerCase() : metric === 'at' ? Date.parse(r.it.platforms?.[Object.keys(r.it.platforms || {})[0]]?.at || '') || 0 : (r.p && Number.isFinite(+r.p[metric]) ? +r.p[metric] : null));
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; // yang belum diisi selalu di bawah
    return (x < y ? -1 : x > y ? 1 : 0) * dir || String(a.it.title).localeCompare(String(b.it.title));
  });
}

/* ---------------- caption ---------------- */
export const captionOf = (it, plat) => (it?.captions && typeof it.captions[plat] === 'string' ? it.captions[plat] : '');

/** Tangkap isian yang sedang diketik: { id: { v, dirty, focus, s, e } }. root = elemen berisi input [data-k]. */
export function snapshotFields(fields, activeKey) {
  const out = {};
  for (const f of fields) if (f.k) out[f.k] = { v: f.value, dirty: f.value !== f.base, focus: f.k === activeKey, s: f.s, e: f.e };
  return out;
}
/** Setelah render ulang: isian yang kotor (diubah pengguna) dipertahankan nilainya, yang bersih mengikuti server. */
export function restoreValue(snap, key, serverValue) { const s = snap?.[key]; return s && s.dirty ? s.v : serverValue; }

/** Hash ringan untuk melewati render ulang kalau data tidak berubah. */
export function sig(x) { const s = JSON.stringify(x ?? null); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return `${s.length}:${h}`; }
