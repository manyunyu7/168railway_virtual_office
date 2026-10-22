// "Magang": NPC kosmetik yang meramaikan kantor. Bukan agen: tidak memanggil model apa pun.
// Server hanya menyimpan konfigurasi per kantor (meta office DB) dan menurunkan identitas (nama + tampilan) secara deterministik dari seed,
// supaya web dan Ghina menampilkan Magang yang sama. Simulasi gerak berjalan di klien.
import { officeDb, one, run } from './db.js';
import { bus } from './live.js';
import { officeModel } from './offices.js';

export const MAX_MINIONS = 30;
export const DEFAULT_COUNT = 6;
const MAX_DISMISSED = 400;

const NAMES = ['Ade', 'Aji', 'Alam', 'Ananda', 'Bayu', 'Bintang', 'Cahya', 'Danu', 'Dwi', 'Eka', 'Fajar', 'Galih', 'Gemi', 'Hari', 'Indra', 'Jati', 'Kencana', 'Lintang', 'Mega', 'Nanda',
  'Oka', 'Pelangi', 'Rani', 'Rama', 'Sekar', 'Surya', 'Tunas', 'Tri', 'Ujang', 'Wahyu', 'Yoga', 'Yuni', 'Zahra', 'Arum', 'Bagas', 'Citra', 'Dian', 'Erlin', 'Fitri', 'Gilang'];
const SKINS = ['#F1C9A5', '#D9A47C', '#B97E57', '#8D5A3B', '#E8B98F'];
const HAIRS = ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A', '#C9A15A', '#3D2B4F'];
const SWATCHES = ['#2F5D9E', '#2C8452', '#A9620F', '#7A3E9D', '#BC3B34', '#1C7379', '#55606E', '#C2417A', '#E5A93C', '#4F8F5B', '#6B7FD7', '#D9694A'];
const HIJABS = ['#E8EEF8', '#2F5D9E', '#C2417A', '#2C8452', '#7A3E9D', '#F2D7DC', '#55606E', '#1F1F26'];
const STYLES = ['short', 'long', 'ponytail', 'bob', 'bun', 'pigtails', 'curly', 'hijab', 'short', 'hijab', 'curly', 'short'];
const OUTFITS_F = ['kemeja', 'rok', 'dress', 'hoodie', 'jas', 'rok'];
const OUTFITS_M = ['kemeja', 'hoodie', 'jas', 'kemeja'];
const FEM = new Set(['long', 'ponytail', 'bob', 'bun', 'pigtails', 'hijab']);
const ACCS = ['', '', 'kacamata', 'topi', 'anting', ''];
// Penanda Magang hanya lanyard kecil + name tag; tampilan beragam seperti role asli
export const LANYARD = '#F2842B';

const j = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
// mulberry32 + hash string -> 32 bit; implementasi tunggal di server, klien tidak perlu menirunya
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Identitas Magang nomor `i` untuk `seed`: nama unik per seed (daftar diacak dulu), tampilan beragam dan tetap. */
export function identity(seed, i) {
  const order = NAMES.map((n, k) => [rng(seed * 7 + k * 131 + 1)(), n]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const r = rng(seed * 31 + i * 977 + 5), pick = a => a[Math.floor(r() * a.length)];
  const style = pick(STYLES), fem = FEM.has(style) || r() < .2;
  let outfit = pick(fem ? OUTFITS_F : OUTFITS_M), acc = pick(ACCS);
  if (style === 'hijab' && acc === 'topi') acc = 'kacamata';
  const look = { color: pick(SWATCHES), hair: pick(HAIRS), skin: pick(SKINS), hairStyle: style, outfit, acc, hijab: style === 'hijab' ? pick(HIJABS) : null, lanyard: LANYARD };
  const lap = Math.floor(i / order.length);
  return { id: `mg-${i}`, name: order[i % order.length] + (lap ? ` ${lap + 1}` : ''), look };
}

const KEY = 'minions';
function read(office) {
  const v = j(one(officeDb(office), 'SELECT value FROM meta WHERE key = ?', KEY)?.value, null) || {};
  const seed = Number.isInteger(v.seed) ? v.seed : 1;
  return {
    count: Number.isInteger(v.count) ? Math.max(0, Math.min(MAX_MINIONS, v.count)) : DEFAULT_COUNT,
    auto: !!v.auto, seed, dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter(Number.isInteger) : [],
  };
}
function write(office, c) {
  run(officeDb(office), 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(c));
}
/** `count` Magang pertama (urut indeks) yang belum diusir. */
function activeIds(c) {
  const out = [], gone = new Set(c.dismissed);
  for (let i = 0; out.length < c.count && i < MAX_MINIONS + MAX_DISMISSED; i++) if (!gone.has(i)) out.push(i);
  return out;
}
const viewOf = c => ({ count: c.count, auto: c.auto, seed: c.seed, max: MAX_MINIONS, minions: activeIds(c).map(i => identity(c.seed, i)) });

function must(office) { if (!officeModel(office)) throw new Error('Kantor tidak ditemukan'); }
const announce = (office, v) => { bus.emit('msg', { t: 'minions', office, minions: v }); return v; };

export function getMinions(office) { must(office); return viewOf(read(office)); }

/** PUT: {count?, auto?, usirSemua?}. Mengubah jumlah memunculkan/memulangkan Magang dari ujung daftar. */
export function putMinions(office, b = {}) {
  must(office);
  const c = read(office);
  if (b.count !== undefined) {
    if (!Number.isInteger(b.count) || b.count < 0 || b.count > MAX_MINIONS) throw new Error(`count harus bilangan bulat 0–${MAX_MINIONS}`);
    c.count = b.count;
  }
  if (b.auto !== undefined) { if (typeof b.auto !== 'boolean') throw new Error('auto harus true/false'); c.auto = b.auto; }
  if (b.usirSemua) { c.count = 0; c.dismissed = []; c.seed = (c.seed % 1000003) + 1 + Math.floor(Math.random() * 9999); }
  write(office, c);
  return announce(office, viewOf(c));
}

/** Usir satu Magang (id `mg-N`): jumlah berkurang satu, yang lain tetap. `semua` = usir semua. */
export function usir(office, mid) {
  must(office);
  if (mid === 'semua') return putMinions(office, { usirSemua: true });
  const m = /^mg-(\d+)$/.exec(String(mid));
  const c = read(office);
  if (!m || !activeIds(c).includes(Number(m[1]))) throw new Error('Magang tidak ada di kantor ini');
  c.dismissed = [...c.dismissed, Number(m[1])].slice(-MAX_DISMISSED);
  c.count = Math.max(0, c.count - 1);
  write(office, c);
  return announce(office, viewOf(c));
}
