// Office rules as data: a few fixed categories per office instead of dozens of announcements.
// Stored in the office db (meta, key "aturan") with a version that bumps on every change; the rules are injected into
// every role prompt at spawn (rolePrompt) and running sessions are told once when something changes (notices.js).
import { officeDb, one, run, nowIso, j } from './db.js';
import { live, logOffice, bus, whoOf } from './live.js';
import { pushNotice } from './notices.js';

const KEY = 'aturan';
export const KATEGORI = {
  commit: 'Commit',
  migrasi: 'Migrasi database',
  e2e: 'Tes e2e',
  'jendela-beku': 'Jendela beku',
  kunci: 'Kunci sumber daya bersama',
  lain: 'Lain-lain',
};
const MAX_BODY = 2000, MAX_LOG = 30;

const load = office => j(one(officeDb(office), 'SELECT value FROM meta WHERE key = ?', KEY)?.value, null) || { v: 0, items: {}, log: [] };
const save = (office, d) => run(officeDb(office), 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(d));

export function katId(ref) {
  const q = String(ref ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const hit = Object.keys(KATEGORI).find(k => k === q) || Object.entries(KATEGORI).find(([, t]) => t.toLowerCase() === String(ref ?? '').trim().toLowerCase())?.[0];
  if (!hit) throw new Error(`Kategori "${ref}" tidak dikenal. Pilihan: ${Object.keys(KATEGORI).join(', ')}.`);
  return hit;
}

/** { versi, kategori: [{id, judul, isi, versi, oleh, waktu}], riwayat } — every category is listed, empty ones with isi "". */
export function listRules(office, { riwayat = false } = {}) {
  const d = load(office);
  return {
    versi: d.v,
    kategori: Object.entries(KATEGORI).map(([id, judul]) => { const it = d.items[id]; return { id, judul, isi: it?.body || '', versi: it?.v || 0, oleh: it?.by || null, waktu: it?.at || null }; }),
    ...(riwayat ? { riwayat: d.log } : {}),
  };
}

/** Markdown block for the role prompt; '' when no rule is set. */
export function rulesBlock(office) {
  const d = load(office);
  const parts = Object.entries(KATEGORI).filter(([id]) => d.items[id]?.body).map(([id, judul]) => `### ${judul}\n${d.items[id].body}`);
  if (!parts.length) return '';
  return `\n## Aturan kantor terstruktur (versi ${d.v})\nIni aturan resmi kantor ini. Kalau berubah, kamu diberi tahu sekali di tengah kerja; lihat versi terbaru dengan \`aturan_list\`.\n${parts.join('\n\n')}`.slice(0, 7000);
}

/** Change one category. isi '' removes it. versi_dasar (optional) must match the current version, so two managers do not overwrite each other. */
export function setRule(office, { kategori, isi, alasan, by, versiDasar, bySid = null }) {
  const id = katId(kategori);
  const body = String(isi ?? '').trim();
  if (body.length > MAX_BODY) throw new Error(`Isi aturan terlalu panjang (maks ${MAX_BODY} karakter). Ringkas, atau taruh rincian di wiki dan tautkan.`);
  const d = load(office);
  if (versiDasar != null && Number(versiDasar) !== d.v) throw new Error(`Aturan sudah berubah (versi sekarang ${d.v}, kamu memakai ${versiDasar}). Panggil aturan_list lalu ulangi.`);
  const prev = d.items[id]?.body || '';
  if (prev === body) return { versi: d.v, kategori: id, berubah: false };
  d.v += 1;
  const at = nowIso();
  if (body) d.items[id] = { body, v: d.v, by, at }; else delete d.items[id];
  d.log = [...(d.log || []), { v: d.v, kategori: id, aksi: body ? (prev ? 'ubah' : 'tambah') : 'hapus', oleh: by, waktu: at, alasan: alasan ? String(alasan).slice(0, 300) : undefined }].slice(-MAX_LOG);
  save(office, d);
  logOffice(office, by, `${body ? (prev ? 'mengubah' : 'menambah') : 'menghapus'} aturan ${KATEGORI[id]} (versi ${d.v})${alasan ? `: ${String(alasan).slice(0, 80)}` : ''}`, 'aturan');
  bus.emit('msg', { t: 'changed', office, what: 'aturan' });
  const told = tellSessions(office, d.v, id, body, alasan, by, bySid);
  return { versi: d.v, kategori: id, berubah: true, diberitahu: told };
}

/** Everyone who is working in the office hears about it once, on their next tool call or prompt. */
function tellSessions(office, v, id, body, alasan, by, exceptSid) {
  const msg = `Aturan Kantor berubah (versi ${v}) oleh ${by}. ${KATEGORI[id]}: ${body ? body.replace(/\s+/g, ' ').slice(0, 700) : '(aturan dihapus)'}${alasan ? ` Alasan: ${String(alasan).slice(0, 200)}.` : ''} Daftar lengkap: tool aturan_list.`;
  let n = 0;
  for (const s of live.values()) {
    if (s.office !== office || s.status === 'ended' || s.sid === exceptSid || s.kind === 'rapat') continue;
    pushNotice(s.sid, msg, `aturan:${id}`);
    n++;
  }
  return n;
}
