// MCP tools for office rules (aturan_list, aturan_set) and harness-managed locks (kunci_ambil, kunci_lepas, kunci_list). See docs/ATURAN-KUNCI.md.
import { listRules, setRule, KATEGORI } from './aturan.js';
import { acquire, release, listLocks, DEFAULT_MIN, MAX_MIN, WAIT_DEFAULT_MIN, WAIT_MAX_MIN } from './locks.js';

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const KATS = Object.keys(KATEGORI);

export const RULE_TOOLS = [
  { name: 'aturan_list', description: `Aturan resmi kantor ini per kategori (${KATS.join(', ')}) beserta versinya. Aturan ini sudah ada di prompt awalmu; panggil tool ini untuk memastikan versi terbaru, terutama setelah ada pemberitahuan "Aturan Kantor berubah". riwayat=true menambah 30 perubahan terakhir.`,
    inputSchema: { type: 'object', properties: { riwayat: { type: 'boolean', description: 'sertakan riwayat perubahan' } } } },
  { name: 'aturan_set', description: `Khusus manager: tambah/ubah/hapus aturan satu kategori (${KATS.join(', ')}). Isi kosong = hapus. Tiap perubahan menaikkan versi aturan kantor, dicatat dengan alasannya, dan semua sesi yang sedang bekerja diberi tahu sekali pada tool-call atau prompt berikutnya (tanpa membuka giliran baru). Pakai ini untuk aturan yang berlaku terus; announce hanya untuk kabar sesaat atau insiden. versi_dasar (opsional) = versi yang kamu lihat di aturan_list; ditolak bila sudah berubah.`,
    inputSchema: { type: 'object', properties: { kategori: { type: 'string', enum: KATS }, isi: { type: 'string', description: 'isi aturan (markdown ringkas, maks 2000 karakter); kosong untuk menghapus' }, alasan: { type: 'string', description: 'kenapa diubah (ikut dicatat dan diberitahukan)' }, versi_dasar: { type: 'integer' } }, required: ['kategori', 'isi'] } },
  { name: 'kunci_ambil', description: `Ambil kunci sumber daya bersama (mis. "e2e", "migrasi-db", "dev-server-3100", "git-commit") sebelum memakainya, supaya dua agen tidak saling timpa. Kalau dipegang agen lain kamu masuk antrean dan tool ini menunggu sampai kunci jadi milikmu (maks tunggu_menit, bawaan ${WAIT_DEFAULT_MIN}, maksimal ${WAIT_MAX_MIN}; 0 = coba sekali tanpa antre). Kunci lepas sendiri saat kamu memanggil kunci_lepas, saat waktunya habis (maks_menit, bawaan ${DEFAULT_MIN}, maksimal ${MAX_MIN}), atau saat sesimu berakhir. Jangan membuat kunci sendiri dengan mkdir/file. Status: didapat | dipegang (sudah milikmu) | belum (masih dipegang orang lain setelah menunggu).`,
    inputSchema: { type: 'object', properties: { nama: { type: 'string', description: 'nama kunci, huruf kecil, mis. "e2e"' }, alasan: { type: 'string', description: 'untuk apa kunci dipakai (dilihat yang antre)' }, maks_menit: { type: 'number', description: `perkiraan lama pakai; lewat itu kunci dilepas otomatis (1-${MAX_MIN}, bawaan ${DEFAULT_MIN})` }, tunggu_menit: { type: 'number', description: `lama menunggu di antrean (0-${WAIT_MAX_MIN}, bawaan ${WAIT_DEFAULT_MIN})` } }, required: ['nama', 'alasan'] } },
  { name: 'kunci_lepas', description: 'Lepaskan kunci yang kamu pegang segera setelah selesai, supaya yang antre bisa lanjut. Manager boleh melepas kunci orang lain dengan paksa=true (mis. pemegangnya macet).',
    inputSchema: { type: 'object', properties: { nama: { type: 'string' }, paksa: { type: 'boolean', description: 'khusus manager' } }, required: ['nama'] } },
  { name: 'kunci_list', description: 'Semua kunci yang sedang dipegang di kantor ini: pemegang, alasan, sisa waktu, dan antreannya.', inputSchema: { type: 'object', properties: {} } },
];
export const RULE_NAMES = new Set(RULE_TOOLS.map(t => t.name));

export async function callRule(ident, name, a = {}) {
  const { office, role, by } = ident;
  switch (name) {
    case 'aturan_list': return text(listRules(office, { riwayat: !!a.riwayat }));
    case 'aturan_set':
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh mengubah aturan kantor. Usulkan lewat manager (pesan_ke) atau catat di kartu.');
      return text(setRule(office, { kategori: a.kategori, isi: a.isi, alasan: a.alasan, by, versiDasar: a.versi_dasar, bySid: ident.sid }));
    case 'kunci_ambil': return text(await acquire(ident, a));
    case 'kunci_lepas': return text(release(ident, a));
    case 'kunci_list': return text({ kunci: listLocks(office) });
  }
  throw new Error(`Tool ${name} tidak dikenal`);
}
