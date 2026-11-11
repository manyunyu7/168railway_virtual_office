// Tool MCP tab Konten (docs/KONTEN.md). Didaftarkan di agent.js seperti PRATINJAU_TOOLS; semua role boleh memakainya.
// Keputusan tayang milik pemilik: agen tidak bisa memindah ke siap/terjadwal/tayang lewat konten_set, hanya usul jadwal dan kirim ke review.
import * as k from './konten.js';
import * as st from './store.js';

const J = { carousel: 'carousel', video: 'video', lain: 'lain' };
const need = (v, f, hint) => { if (v === undefined || v === null || !String(v).trim()) throw new Error(`Isi \`${f}\` (${hint}).`); return v; };
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
/** Tahap yang tidak boleh dituju agen lewat konten_set: itu keputusan pemilik. */
export const OWNER_ONLY = new Set(['siap', 'terjadwal', 'tayang']);

export const KONTEN_TOOLS = [
  { name: 'konten_list', description: 'Daftar konten sosial media kantor (ringkas): id, judul, tahap (ide, riset, produksi, review, revisi, siap, terjadwal, tayang, arsip), jenis, seri, tanggal. Filter: tahap, seri, q (cari judul/folder).',
    inputSchema: { type: 'object', properties: { tahap: { type: 'string', enum: k.STAGE_IDS }, seri: { type: 'string' }, q: { type: 'string' }, limit: { type: 'number', description: 'maks hasil, bawaan 60' } } } },
  { name: 'konten_get', description: 'Satu konten lengkap: tahap, folder, media (slide, video, sampul), caption per platform, status per platform, performa, pratinjau terkait.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'konten_buat', description: 'Catat konten sosial media baru (kartu di papan Konten). Pakai ini, bukan card_create, untuk post Instagram/Threads/TikTok/YouTube. folder = folder kerja konten, relatif ke folder konten kantor (mis. belum-posting/carousel/post-x). tahap bawaan ide.',
    inputSchema: { type: 'object', properties: { judul: { type: 'string' }, jenis: { type: 'string', enum: Object.keys(J) }, folder: { type: 'string' }, seri: { type: 'string' }, tahap: { type: 'string', enum: ['ide', 'riset', 'produksi', 'revisi', 'review'] }, who: { type: 'string', description: 'id role pengerja; bawaan kamu' } }, required: ['judul'] } },
  { name: 'konten_set', description: 'Ubah konten: tahap (ide, riset, produksi, revisi, review, arsip), judul, media ({slides?:[path], video?, cover?} penimpa deteksi otomatis), lagu, seri, sensitif, catatan, folder. TIDAK boleh memindah ke siap, terjadwal, atau tayang: itu keputusan pemilik. Untuk menyerahkan ke pemilik pakai konten_kirim.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, tahap: { type: 'string', enum: ['ide', 'riset', 'produksi', 'revisi', 'review', 'arsip'] }, judul: { type: 'string' }, media: { type: 'object' }, lagu: { type: 'string' }, seri: { type: 'string' }, sensitif: { type: 'boolean' }, catatan: { type: 'string' }, folder: { type: 'string' } }, required: ['id'] } },
  { name: 'konten_kirim', description: 'Kirim konten ke pemilik untuk direview: pindah ke tahap Review, pemilik dapat notifikasi, dan kartu muncul di Paket Posting. Pastikan media dan caption sudah ada di folder. catatan = apa yang perlu dilihat. Keputusan (setuju/revisi) datang sebagai pesan langsung dari Pemilik.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, catatan: { type: 'string' } }, required: ['id'] } },
  { name: 'konten_jadwal_usul', description: 'Usulkan jadwal tayang untuk konten yang sudah disetujui (tahap Siap tayang). Usulan tampil beda di kalender sampai pemilik menyetujui. Konten yang belum siap ditolak. Hasilnya memuat peringatan jadwal (seri berdempet, sensitif berjejer, target mingguan, tanpa caption/media).',
    inputSchema: { type: 'object', properties: { jadwal: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tanggal: { type: 'string', description: 'YYYY-MM-DD' }, jam: { type: 'string', description: 'HH:MM, bawaan jam default kantor' } }, required: ['id', 'tanggal'] } } }, required: ['jadwal'] } },
  { name: 'konten_tayang', description: 'Catat konten sudah tayang di satu platform. HANYA panggil kalau pemilik sudah bilang kontennya tayang (posting dilakukan manual oleh pemilik). Memindah folder ke sudah-posting, menulis SUDAH-POSTING.txt, dan memperbarui daftar status bila diatur. Hasilnya memuat pathPerluCek: berkas yang masih menyebut path lama dan perlu dicek.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, platform: { type: 'string', enum: k.PLATFORMS }, link: { type: 'string' }, at: { type: 'string', description: 'waktu tayang ISO, bawaan sekarang' } }, required: ['id', 'platform'] } },
  { name: 'konten_performa', description: 'Isi angka performa satu platform untuk konten yang sudah tayang (dari angka yang diberikan pemilik; jangan mengarang).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, platform: { type: 'string', enum: k.PLATFORMS }, reach: { type: 'number' }, like: { type: 'number' }, comment: { type: 'number' }, save: { type: 'number' }, share: { type: 'number' } }, required: ['id', 'platform'] } },
  { name: 'kit_list', description: 'Kit merek konten: logo, outro, slide jualan, acuan, sfx. Opsional filter jenis.',
    inputSchema: { type: 'object', properties: { jenis: { type: 'string', enum: k.KIT_JENIS } } } },
  { name: 'kit_tambah', description: 'Tambah berkas ke kit merek konten. path relatif ke folder konten kantor.',
    inputSchema: { type: 'object', properties: { jenis: { type: 'string', enum: k.KIT_JENIS }, nama: { type: 'string' }, path: { type: 'string' }, catatan: { type: 'string' } }, required: ['jenis', 'nama', 'path'] } },
];
export const KONTEN_NAMES = new Set(KONTEN_TOOLS.map(t => t.name));

const brief = it => ({ id: it.id, judul: it.title, tahap: it.tahap, jenis: it.jenis, seri: it.seri || undefined, tanggal: it.publishAt || undefined, jam: it.jam || undefined, folder: it.folder || undefined, pengerja: it.whoName || undefined });
const idOf = (office, a) => String(need(a.id, 'id', 'id konten dari konten_list')).replace(/^#/, '');

export async function callKonten(ident, name, a = {}) {
  const o = ident.office, by = ident.by || 'Agen';
  switch (name) {
    case 'konten_list': {
      const r = k.listItems(o, { tahap: a.tahap, seri: a.seri, q: a.q });
      const n = Math.max(1, Math.min(300, Number(a.limit) || 60));
      return text({ total: r.items.length, tahap: Object.fromEntries(r.stages.map(s => [s.id, s.n])), konten: r.items.slice(0, n).map(brief), terpotong: r.items.length > n });
    }
    case 'konten_get': {
      const it = k.getItem(o, idOf(o, a));
      return text({ ...brief(it), platforms: it.platforms, perf: it.perf, lagu: it.lagu || undefined, sensitif: it.sensitif, catatan: it.catatan || undefined, pratinjau: it.pratinjau,
        media: { slide: it.media.slides.map(s => s.rel), video: it.media.video?.rel || null, sampul: it.media.cover?.rel || null }, captions: it.captions, platformTarget: it.platformTarget });
    }
    case 'konten_buat': {
      const it = k.createItem(o, { title: need(a.judul, 'judul', 'judul konten'), jenis: a.jenis, folder: a.folder, seri: a.seri, tahap: a.tahap || 'ide', who: a.who || ident.role?.id || null }, by);
      return text({ ...brief(it), pesan: 'Konten tercatat di papan Konten.' });
    }
    case 'konten_set': {
      const id = idOf(o, a);
      if (a.tahap && OWNER_ONLY.has(String(a.tahap))) throw new Error(`Kamu tidak boleh memindah konten ke "${a.tahap}": itu keputusan pemilik. Kirim ke review dengan konten_kirim, atau usulkan jadwal dengan konten_jadwal_usul.`);
      const patch = {};
      for (const [from, to] of [['judul', 'title'], ['tahap', 'tahap'], ['media', 'media'], ['lagu', 'lagu'], ['seri', 'seri'], ['sensitif', 'sensitif'], ['catatan', 'catatan'], ['folder', 'folder']]) if (a[from] !== undefined) patch[to] = a[from];
      if (!Object.keys(patch).length) throw new Error('Tidak ada yang diubah: isi minimal salah satu dari tahap, judul, media, lagu, seri, sensitif, catatan, folder.');
      return text(brief(k.patchItem(o, id, patch, by)));
    }
    case 'konten_kirim': {
      const id = idOf(o, a), cur = k.getItem(o, id);
      if (OWNER_ONLY.has(cur.tahap)) throw new Error(`Konten ini sudah di tahap ${cur.tahap}; tidak perlu dikirim lagi ke review.`);
      if (cur.tahap === 'review') throw new Error('Konten ini sudah menunggu review pemilik.');
      const it = k.patchItem(o, id, { tahap: 'review' }, by);
      if (a.catatan) st.commentCard(o, id, String(a.catatan), by);
      return text({ ...brief(it), pesan: 'Terkirim ke pemilik untuk direview (notifikasi sudah dikirim). Keputusannya datang sebagai pesan langsung.', paket: `#/o/${o}/konten/p/${id}`, caption: !!(it.captions?.instagram) || undefined });
    }
    case 'konten_jadwal_usul': {
      if (!Array.isArray(a.jadwal) || !a.jadwal.length) throw new Error('Isi `jadwal` (daftar {id, tanggal, jam?}).');
      return text({ ...k.usulJadwal(o, a.jadwal, by), pesan: 'Usulan tampil di kalender sampai pemilik menyetujui.' });
    }
    case 'konten_tayang': {
      const r = await k.tayang(o, idOf(o, a), { platform: a.platform, link: a.link, at: a.at }, by);
      return text({ ...brief(r), platforms: r.platforms, dipindah: r.dipindah, sudahPosting: r.sudahPosting, statusFile: r.statusFile, wiki: r.wiki, pathPerluCek: r.pathPerluCek, peringatan: r.peringatan });
    }
    case 'konten_performa':
      return text(brief(k.setPerforma(o, idOf(o, a), a)));
    case 'kit_list':
      return text(k.listKit(o, { jenis: a.jenis }).items.map(({ url, thumb, isi, ...x }) => x));
    case 'kit_tambah': {
      const { url, thumb, isi, ...x } = k.addKit(o, { jenis: a.jenis, nama: a.nama, path: a.path, catatan: a.catatan });
      return text(x);
    }
  }
  throw new Error(`Tool tidak dikenal: ${name}`);
}
