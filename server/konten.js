import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Tab Konten: manajemen konten sosial media sebuah kantor. Kontrak lengkap di docs/KONTEN.md.
// Satu post = satu kartu di papan `konten` + satu baris tabel `konten`. File tetap di folder proyek (conf.root); kantor hanya menyimpan path relatif.
// Tidak ada auto-post: tayang selalu dicatat manual oleh pemilik (atau agen yang diberi tahu pemilik).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OFFICE_DIR } from './config.js';
import { officeDb, all, one, run, nowIso, newId, j } from './db.js';
import { officeModel, listOffices } from './offices.js';
import { bus } from './live.js';
import * as st from './store.js';
import * as bd from './boards.js';
import * as dm from './dm.js';
import { thumbFile } from './attachments.js';
import { parseRange } from './media.js';
import { who as actorName } from './actor.js';
import { detectMedia, listFiles, parseCaption, readCaptionFile, replaceSection, hasCaption, scan, CAPTION_FILE, CAP_PLATS, baseName, jenisOf } from './konten-import.js';

const err = (code, message) => Object.assign(new Error(message), { code });
export const BOARD = 'konten';
export const STAGES = [
  { id: 'ide', name: 'Ide', kind: 'antre' }, { id: 'riset', name: 'Riset', kind: 'antre' }, { id: 'produksi', name: 'Produksi', kind: 'dikerjakan' },
  { id: 'review', name: 'Review kamu', kind: 'review' }, { id: 'revisi', name: 'Revisi', kind: 'dikerjakan' }, { id: 'siap', name: 'Siap tayang', kind: 'selesai' },
  { id: 'terjadwal', name: 'Terjadwal', kind: 'selesai' }, { id: 'tayang', name: 'Tayang', kind: 'selesai' }, { id: 'arsip', name: 'Arsip', kind: 'selesai' },
];
export const STAGE_IDS = STAGES.map(s => s.id);
export const PLATFORMS = ['instagram', 'threads', 'tiktok', 'youtube'];
export const PLAT_LABEL = { instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube' };
export const JENIS = ['carousel', 'video', 'lain'];
export const KIT_JENIS = ['logo', 'outro', 'slide-jualan', 'acuan', 'sfx', 'lain'];
export const METRIK = ['reach', 'like', 'comment', 'save', 'share'];
export const DEFAULT_PENGINGAT = { aktif: true, pagi: '08:00', sebelumMenit: 15, terlewatMenit: 120, susulanJam: 3 };
export const DEFAULT_CONF = { root: '', targetPerMinggu: 5, targetPerHari: 0, pengingat: DEFAULT_PENGINGAT, platforms: ['instagram', 'threads', 'tiktok', 'youtube'], jamDefault: '19:00', pindahFolder: true, statusFile: '', wikiTayang: '', wikiBelum: '', editor: '' };
export const WIKI_MARK = '<!-- digenerate Kantor: tab Konten -->';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const JAM = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = n => String(n).padStart(2, '0');
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = v => { v = String(v ?? '').slice(0, 10); if (v && !DATE.test(v)) throw err(400, `Tanggal harus YYYY-MM-DD: ${v}`); return v; };
const parseDay = s => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || ''); if (!m) return null; const d = new Date(+m[1], m[2] - 1, +m[3]); return d.getMonth() === m[2] - 1 ? d : null; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const emit = (office, id) => bus.emit('msg', { t: 'changed', office, what: 'konten', ...(id ? { id } : {}) });

/* ---------------- conf ---------------- */
export function getConf(office) {
  const row = one(officeDb(office), "SELECT value FROM meta WHERE key = 'konten.conf'");
  const c = { ...DEFAULT_CONF, ...(j(row?.value, {}) || {}) };
  c.platforms = (Array.isArray(c.platforms) ? c.platforms : DEFAULT_CONF.platforms).filter(p => PLATFORMS.includes(p));
  return c;
}
/** Path relatif yang aman: tanpa awalan /, tanpa "..". '' tetap ''. */
export function cleanRel(v, what = 'Path') {
  const s = String(v ?? '').replace(/\\/g, '/').trim();
  if (!s) return '';
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\0')) throw err(400, `${what} harus relatif (tanpa awalan /): ${s}`);
  const n = path.posix.normalize(s).replace(/\/+$/, '');
  if (n === '..' || n.startsWith('../') || n.split('/').includes('..')) throw err(400, `${what} tidak boleh keluar folder: ${s}`);
  return n === '.' ? '.' : n;
}
export function setConf(office, patch = {}) {
  const cur = getConf(office), next = { ...cur };
  if (patch.root !== undefined) next.root = cleanRel(patch.root, 'root');
  if (patch.targetPerHari !== undefined) { const n = Math.round(Number(patch.targetPerHari)); if (!Number.isFinite(n) || n < 0 || n > 10) throw err(400, 'targetPerHari harus 0 sampai 10'); next.targetPerHari = n; }
  if (patch.targetPerMinggu !== undefined) { const n = Math.round(Number(patch.targetPerMinggu)); if (!Number.isFinite(n) || n < 0 || n > 50) throw err(400, 'targetPerMinggu harus 0 sampai 50'); next.targetPerMinggu = n; }
  if (patch.platforms !== undefined) {
    if (!Array.isArray(patch.platforms) || patch.platforms.some(p => !PLATFORMS.includes(p))) throw err(400, `platforms harus berisi: ${PLATFORMS.join(', ')}`);
    next.platforms = [...new Set(patch.platforms)];
  }
  if (patch.jamDefault !== undefined) { if (!JAM.test(String(patch.jamDefault))) throw err(400, 'jamDefault harus HH:MM'); next.jamDefault = String(patch.jamDefault); }
  if (patch.pindahFolder !== undefined) next.pindahFolder = !!patch.pindahFolder;
  if (patch.pengingat !== undefined) {
    const p = { ...DEFAULT_PENGINGAT, ...(cur.pengingat || {}), ...(patch.pengingat || {}) };
    if (p.pagi && !JAM.test(String(p.pagi))) throw err(400, 'jam pengingat pagi harus HH:MM, atau kosong untuk mematikan');
    for (const [k, hi] of [['sebelumMenit', 240], ['terlewatMenit', 1440], ['susulanJam', 48]]) { const n = Math.round(Number(p[k])); if (!Number.isFinite(n) || n < 0 || n > hi) throw err(400, `${k} harus 0 sampai ${hi}`); p[k] = n; }
    next.pengingat = { aktif: p.aktif !== false, pagi: String(p.pagi || ''), sebelumMenit: p.sebelumMenit, terlewatMenit: p.terlewatMenit, susulanJam: p.susulanJam };
  }
  for (const k of ['statusFile', 'wikiTayang', 'wikiBelum', 'editor']) if (patch[k] !== undefined) next[k] = k === 'statusFile' ? cleanRel(patch[k], k) : String(patch[k] ?? '').trim().slice(0, 120);
  run(officeDb(office), "INSERT OR REPLACE INTO meta (key, value) VALUES ('konten.conf', ?)", JSON.stringify(next));
  emit(office);
  return getConf(office);
}

/** Folder konten (absolut), atau null bila conf.root belum diisi. Menolak root yang keluar dari folder kantor. */
export function rootAbs(office, conf = getConf(office)) {
  if (!conf.root) return null;
  const m = officeModel(office);
  if (!m) throw err(404, 'Kantor tidak ditemukan');
  const abs = path.resolve(m.root, conf.root);
  let base = m.root, real = abs;
  try { base = fs.realpathSync(m.root); } catch {}
  try { real = fs.realpathSync(abs); } catch {}
  const inside = (p, b) => p === b || p.startsWith(b + path.sep);
  if (!inside(abs, path.resolve(m.root)) && !inside(abs, base)) throw err(403, 'conf.root di luar folder kantor');
  if (!inside(real, base) && !inside(real, path.resolve(m.root))) throw err(403, 'conf.root di luar folder kantor');
  return abs;
}
/**
 * Path absolut berkas/folder di dalam root konten; menolak ".." dan symlink yang keluar (realpath). Kode 403 keluar, 404 tidak ada.
 * mustExist=false: untuk tujuan tulis yang belum ada (induknya yang diperiksa).
 */
export function safeIn(root, rel, { mustExist = true } = {}) {
  if (!root) throw err(404, 'Folder konten belum diatur (conf.root).');
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  let rootReal; try { rootReal = fs.realpathSync(root); } catch { throw err(404, 'Folder konten tidak ada.'); }
  const abs = path.resolve(root, clean);
  const inside = p => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!(abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep))) throw err(403, 'Path di luar folder konten');
  let real;
  try { real = fs.realpathSync(abs); }
  catch {
    if (mustExist) throw err(404, 'Berkas tidak ada');
    try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { throw err(404, 'Folder tujuan tidak ada'); }
  }
  if (!inside(real)) throw err(403, 'Path di luar folder konten');
  return { abs, real, rel: path.relative(path.resolve(root), abs).split(path.sep).join('/') };
}

/* ---------------- papan ---------------- */
export function ensureBoard(office) {
  const db = officeDb(office);
  bd.boardsOf(db);
  let b = bd.listBoards(office).find(x => x.id === BOARD);
  if (!b) b = bd.createBoard(office, { name: 'Konten', template: 'konten' });
  else if (b.archived) b = bd.updateBoard(office, BOARD, { archived: false });
  if (!b.columns.some(c => c.id === 'review')) throw err(409, 'Papan "konten" ada tetapi kolomnya bukan kolom tab Konten (id ide, riset, produksi, review, revisi, siap, terjadwal, tayang, arsip).');
  return b;
}
const colOf = (board, tahap) => { const i = board.columns.findIndex(c => c.id === tahap); if (i < 0) throw err(400, `Tahap tidak dikenal: ${tahap}. Pilihan: ${STAGE_IDS.join(', ')}`); return i; };
const tahapAt = (board, col) => board.columns[col]?.id || 'ide';

/* ---------------- item ---------------- */
const fileUrl = (office, cid, rel, thumb) => `/api/offices/${encodeURIComponent(office)}/konten/${encodeURIComponent(cid)}/file?path=${encodeURIComponent(rel)}${thumb ? '&thumb=1' : ''}`;
const SQL_ITEMS = `SELECT c.id, c.title, c.desc, c.col, c.who, c.labels, c.cover, c.publish_at, c.created_at, c.updated_at, k.folder, k.jenis, k.seri, k.jam, k.jadwal_status,
  k.lagu, k.sensitif, k.acuan, k.platforms, k.perf, k.media, k.catatan, k.updated_at k_updated
  FROM cards c JOIN konten k ON k.card_id = c.id WHERE c.board = '${BOARD}' AND c.archived = 0`;

const coverCache = new Map();
const COVER_TTL = 60e3;
/** Sampul untuk daftar: penimpa media.cover, lalu cards.cover (kt:), lalu deteksi (cache 60 detik per folder). */
function coverRel(office, root, r, media) {
  if (media.cover) return media.cover;
  const kt = /^kt:[^:]+:(.+)$/.exec(r.cover || '');
  if (kt) return kt[1];
  if (!root || !r.folder) return null;
  const key = `${office}:${r.id}:${r.folder}`, now = Date.now(), hit = coverCache.get(key);
  if (hit && now - hit.at < COVER_TTL) return hit.rel;
  let rel = null;
  try { rel = detectMedia(root, r.folder, { light: true }).cover; } catch {}
  coverCache.set(key, { at: now, rel });
  if (coverCache.size > 2000) for (const [k, v] of coverCache) if (now - v.at > COVER_TTL) coverCache.delete(k);
  return rel;
}
const roleName = (office, id, cache) => { if (!id) return ''; if (!cache.has(id)) { let n = ''; try { n = st.getRole(office, id)?.name || ''; } catch {} cache.set(id, n || id); } return cache.get(id); };
function pratinjauMap(office) {
  const m = new Map();
  try {
    for (const p of all(officeDb(office), "SELECT id, status, json_extract(data, '$.card') card, json_extract(data, '$.title') title FROM pratinjau WHERE json_extract(data, '$.card') IS NOT NULL ORDER BY created_at"))
      (m.get(p.card) || m.set(p.card, []).get(p.card)).push({ id: p.id, title: p.title, status: p.status });
  } catch {}
  return m;
}
const platformTarget = (conf, jenis) => conf.platforms.filter(p => !(jenis === 'carousel' && p === 'youtube'));

function buildItem(office, board, conf, root, r, ctx) {
  const media = j(r.media, {}) || {};
  const tahap = tahapAt(board, r.col);
  const rel = coverRel(office, root, r, media);
  return {
    id: r.id, title: r.title, tahap, tahapNama: board.columns[r.col]?.name || tahap, board: BOARD, who: r.who || null, whoName: roleName(office, r.who, ctx.roles),
    folder: r.folder || '', jenis: r.jenis || 'lain', seri: r.seri || '', labels: j(r.labels, []).map(id => ctx.labels.get(id) || id),
    publishAt: r.publish_at || '', jam: r.jam || '', jadwalStatus: r.jadwal_status || '', lagu: r.lagu || '', sensitif: !!r.sensitif, acuan: !!r.acuan, catatan: r.catatan || '',
    updatedAt: r.updated_at > (r.k_updated || '') ? r.updated_at : r.k_updated, createdAt: r.created_at,
    coverUrl: rel ? fileUrl(office, r.id, rel, true) : null,
    platforms: j(r.platforms, {}) || {}, perf: j(r.perf, {}) || {}, pratinjau: ctx.pv.get(r.id) || [],
  };
}
const itemCtx = office => ({ roles: new Map(), labels: new Map(st.listLabels(office).map(l => [l.id, l.name])), pv: pratinjauMap(office) });

/** Item ringkas untuk daftar: tanpa membaca caption dan tanpa memindai folder per item (kecuali sampul, ber-cache). */
function listRows(office, filter = null) {
  const board = ensureBoard(office), conf = getConf(office);
  const root = (() => { try { return rootAbs(office, conf); } catch { return null; } })();
  const ctx = itemCtx(office);
  const rows = all(officeDb(office), `${SQL_ITEMS} ${filter ? `AND ${filter.sql}` : ''} ORDER BY c.created_at, c.id`, ...(filter?.args || []));
  return { board, conf, items: rows.map(r => buildItem(office, board, conf, root, r, ctx)) };
}

export function getItem(office, cid) {
  const board = ensureBoard(office), conf = getConf(office);
  const r = one(officeDb(office), `${SQL_ITEMS} AND c.id = ?`, cid);
  if (!r) throw err(404, 'Konten tidak ditemukan');
  const root = (() => { try { return rootAbs(office, conf); } catch { return null; } })();
  const it = buildItem(office, board, conf, root, r, itemCtx(office));
  const ov = j(r.media, {}) || {};
  let auto = { slides: [], video: null, cover: null };
  if (root && r.folder) { try { auto = detectMedia(root, r.folder); } catch {} }
  const slides = Array.isArray(ov.slides) && ov.slides.length ? ov.slides : auto.slides;
  const video = ov.video || auto.video, cover = ov.cover || auto.cover;
  const info = rel => { let size = 0; try { size = fs.statSync(path.join(root, rel)).size; } catch {} return { rel, name: path.basename(rel), url: fileUrl(office, cid, rel, false), thumb: fileUrl(office, cid, rel, true), size }; };
  it.media = {
    slides: slides.map(rel => { const { size, ...x } = info(rel); return x; }),
    video: video ? info(video) : null,
    cover: cover ? { rel: cover, url: fileUrl(office, cid, cover, false), thumb: fileUrl(office, cid, cover, true) } : null,
  };
  let caps = { instagram: null, threads: null, tiktok: null, youtube: null }, sumber = null;
  if (root && r.folder) {
    const { text } = readCaptionFile(path.join(root, r.folder));
    if (text != null) { caps = parseCaption(text); sumber = `${r.folder}/${CAPTION_FILE}`; }
  }
  it.captions = { ...caps, sumber };
  it.platformTarget = platformTarget(conf, it.jenis);
  it.desc = r.desc || '';
  return it;
}

export function listItems(office, q = {}) {
  const { items, conf, board } = listRows(office);
  const text = String(q.q || '').trim().toLowerCase();
  const out = items.filter(it => (!q.tahap || it.tahap === q.tahap) && (!q.seri || it.seri === q.seri) && (!q.jenis || it.jenis === q.jenis)
    && (!text || `${it.title} ${it.seri} ${it.folder} ${it.catatan}`.toLowerCase().includes(text)));
  const n = new Map(), seri = new Map();
  for (const it of items) { n.set(it.tahap, (n.get(it.tahap) || 0) + 1); if (it.seri) seri.set(it.seri, (seri.get(it.seri) || 0) + 1); }
  return {
    items: out,
    stages: board.columns.map(c => ({ id: c.id, name: c.name, kind: c.kind, n: n.get(c.id) || 0 })),
    seri: [...seri].map(([nama, c]) => ({ nama, n: c })).sort((a, b) => a.nama.localeCompare(b.nama)),
    conf,
  };
}

/* ---------------- tulis ---------------- */
function folderIn(office, folder, conf = getConf(office)) {
  const f = cleanRel(folder, 'folder');
  if (!f) return '';
  const root = rootAbs(office, conf);
  if (root) { try { safeIn(root, f, { mustExist: false }); } catch (e) { if (e.code === 403) throw err(400, 'folder di luar folder konten'); } }
  return f;
}
const usedFolder = (office, folder, except = null) => folder ? one(officeDb(office), 'SELECT card_id FROM konten WHERE folder = ? AND card_id <> ?', folder, except || '')?.card_id || null : null;
const kontenTouch = (office, cid) => run(officeDb(office), 'UPDATE konten SET updated_at = ? WHERE card_id = ?', nowIso(), cid);

export function refreshCover(office, cid) {
  try {
    const conf = getConf(office), root = rootAbs(office, conf);
    const r = one(officeDb(office), 'SELECT folder, media FROM konten WHERE card_id = ?', cid);
    if (!root || !r?.folder) return;
    const media = j(r.media, {}) || {};
    const rel = media.cover || detectMedia(root, r.folder, { light: true }).cover;
    run(officeDb(office), 'UPDATE cards SET cover = ? WHERE id = ?', rel ? `kt:${cid}:${rel}` : null, cid);
  } catch {}
}

export function createItem(office, a = {}, by = actorName()) {
  const title = String(a.title ?? '').trim();
  if (!title) throw err(400, 'Judul konten wajib diisi');
  const board = ensureBoard(office), conf = getConf(office);
  const folder = folderIn(office, a.folder, conf);
  const dupe = usedFolder(office, folder);
  if (dupe) throw err(409, `Folder ${folder} sudah dipakai konten ${dupe}`);
  const jenis = a.jenis === undefined || a.jenis === '' ? (folder ? jenisOf(folder) : 'lain') : String(a.jenis);
  if (!JENIS.includes(jenis)) throw err(400, `jenis harus salah satu: ${JENIS.join(', ')}`);
  const tahap = a.tahap || 'ide';
  const col = colOf(board, tahap);
  const card = st.createCard(office, { title, board: BOARD, col, who: a.who || null, labels: a.labels || [], publishAt: a.publishAt || '' }, by);
  const t = nowIso();
  try {
    run(officeDb(office), `INSERT INTO konten (card_id, folder, jenis, seri, jam, jadwal_status, lagu, sensitif, acuan, platforms, perf, media, catatan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`, card.id, folder, jenis, String(a.seri || '').slice(0, 80), JAM.test(a.jam || '') ? a.jam : '', String(a.lagu || '').slice(0, 200),
      a.sensitif ? 1 : 0, a.acuan ? 1 : 0, JSON.stringify(a.platforms || {}), String(a.catatan || '').slice(0, 2000), t, t);
  } catch (e) { st.archiveCard(office, card.id, by); throw e; }
  refreshCover(office, card.id);
  emit(office, card.id);
  if (tahap === 'review') notifyReview(office, title, card.id);
  return getItem(office, card.id);
}

function rowOf(office, cid) {
  const r = one(officeDb(office), `${SQL_ITEMS} AND c.id = ?`, cid);
  if (!r) throw err(404, 'Konten tidak ditemukan');
  return r;
}

export function patchItem(office, cid, b = {}, by = actorName()) {
  const board = ensureBoard(office), conf = getConf(office);
  const r = rowOf(office, cid), db = officeDb(office);
  const t0 = tahapAt(board, r.col);
  let t1 = b.tahap !== undefined ? String(b.tahap) : t0;
  if (b.tahap !== undefined) colOf(board, t1);
  if (t1 === 'tayang' && t0 !== 'tayang') throw err(400, 'Untuk menandai tayang pakai POST /:cid/tayang (butuh platform).');
  const f = {};
  const k = {};
  if (b.title !== undefined) { if (!String(b.title).trim()) throw err(400, 'Judul tidak boleh kosong'); f.title = String(b.title); }
  if (b.who !== undefined) { f.who = b.who || null; if (b.who) { const ro = st.getRole(office, b.who); if (!ro) throw err(400, `Role tidak ditemukan: ${b.who}`); f.whoName = ro.name; } }
  if (b.desc !== undefined) f.desc = String(b.desc);
  if (b.publishAt !== undefined) {
    const pa = day(b.publishAt);
    f.publishAt = pa;
    if (pa && t1 === 'siap') t1 = 'terjadwal';
    else if (!pa && t1 === 'terjadwal') t1 = 'siap';
    k.jadwal_status = pa ? 'fix' : '';
    if (!pa && b.jam === undefined) k.jam = '';
  }
  if (b.jam !== undefined) { if (b.jam !== '' && !JAM.test(String(b.jam))) throw err(400, 'jam harus HH:MM'); k.jam = String(b.jam); }
  if (b.seri !== undefined) k.seri = String(b.seri || '').slice(0, 80);
  if (b.jenis !== undefined) { if (!JENIS.includes(b.jenis)) throw err(400, `jenis harus salah satu: ${JENIS.join(', ')}`); k.jenis = b.jenis; }
  if (b.lagu !== undefined) k.lagu = String(b.lagu || '').slice(0, 200);
  if (b.sensitif !== undefined) k.sensitif = b.sensitif ? 1 : 0;
  if (b.acuan !== undefined) k.acuan = b.acuan ? 1 : 0;
  if (b.catatan !== undefined) k.catatan = String(b.catatan || '').slice(0, 2000);
  if (b.folder !== undefined) {
    const nf = folderIn(office, b.folder, conf);
    const dupe = usedFolder(office, nf, cid);
    if (nf && dupe) throw err(409, `Folder ${nf} sudah dipakai konten ${dupe}`);
    k.folder = nf;
  }
  if (b.media !== undefined) k.media = JSON.stringify(cleanMedia(b.media));
  if (t1 !== t0) f.col = colOf(board, t1);
  for (const [col, v] of Object.entries(k)) run(db, `UPDATE konten SET ${col} = ? WHERE card_id = ?`, v, cid);
  if (Object.keys(k).length) kontenTouch(office, cid);
  if (Object.keys(f).length) st.updateCard(office, cid, f, by);
  if (k.folder !== undefined || k.media !== undefined) refreshCover(office, cid);
  coverCache.clear();
  emit(office, cid);
  if (t1 === 'review' && t0 !== 'review') notifyReview(office, f.title || r.title, cid);
  return getItem(office, cid);
}
function cleanMedia(m) {
  if (m === null || m === '') return {};
  if (typeof m !== 'object') throw err(400, 'media harus objek { slides, video, cover }');
  const out = {};
  if (m.slides !== undefined) { if (!Array.isArray(m.slides)) throw err(400, 'media.slides harus daftar'); out.slides = m.slides.map(s => cleanRel(s, 'media.slides')).filter(Boolean); }
  if (m.video) out.video = cleanRel(m.video, 'media.video');
  if (m.cover) out.cover = cleanRel(m.cover, 'media.cover');
  return out;
}

/* ---------------- notifikasi ---------------- */
export function notifyReview(office, title, cid) {
  bus.emit('notify', { kind: 'konten', office, id: cid, who: 'Konten perlu review', text: title, dedupe: `review:${cid}:${Date.now()}` });
}

/* ---------------- review ---------------- */
export async function review(office, cid, b = {}, by = actorName()) {
  const board = ensureBoard(office), r = rowOf(office, cid);
  const keputusan = String(b.keputusan || '');
  if (!['setuju', 'revisi'].includes(keputusan)) throw err(400, "keputusan harus 'setuju' atau 'revisi'");
  if (tahapAt(board, r.col) !== 'review') throw err(409, `Konten ini tidak sedang di Review (tahap: ${tahapAt(board, r.col)}).`);
  const catatan = String(b.catatan || '').trim();
  const slides = (Array.isArray(b.slide) ? b.slide : b.slide === undefined || b.slide === null || b.slide === '' ? [] : [b.slide]).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (keputusan === 'revisi' && !catatan) throw err(400, 'Revisi butuh catatan: apa yang perlu diubah?');
  const pesan = keputusan === 'setuju'
    ? `Konten "${r.title}" disetujui${catatan ? `: ${catatan}` : '.'}`
    : `Konten "${r.title}" perlu revisi${slides.length ? ` (slide ${slides.join(', ')})` : ''}: ${catatan}`;
  st.updateCard(office, cid, { col: colOf(board, keputusan === 'setuju' ? 'siap' : 'revisi') }, by);
  st.commentCard(office, cid, pesan, by);
  kontenTouch(office, cid);
  let dmRes = null;
  if (r.who) { try { dmRes = await dm.fromOwner(office, r.who, pesan, { card: cid }); } catch (e) { dmRes = { error: e.message }; } }
  emit(office, cid);
  return { ...getItem(office, cid), dm: dmRes };
}

/* ---------------- jadwal ---------------- */
const SCHED = new Set(['siap', 'terjadwal', 'tayang']);
function weekList(from, to) {
  const out = []; let d = mondayOf(from);
  while (d <= to && out.length < 120) { out.push(d); d = addDays(d, 7); }
  return out;
}
export function jadwal(office, q = {}) {
  const { items: all0, conf } = listRows(office), root = (() => { try { return rootAbs(office, conf); } catch { return null; } })();
  const dated = all0.filter(it => it.tahap !== 'arsip' && it.publishAt && DATE.test(it.publishAt));
  const from = q.from ? day(q.from) : '', to = q.to ? day(q.to) : '';
  const items = dated.filter(it => (!from || it.publishAt >= from) && (!to || it.publishAt <= to))
    .sort((a, b) => `${a.publishAt}T${a.jam || '00:00'}`.localeCompare(`${b.publishAt}T${b.jam || '00:00'}`) || a.id.localeCompare(b.id));
  const now = q.now ? new Date(q.now) : new Date();
  const peringatan = [];
  const warn = (kode, pesan, ids, tanggal) => peringatan.push({ kode, pesan, ids, tanggal });
  // seri berdempet: seri sama di dua hari berurutan (atau hari yang sama)
  const bySeri = new Map();
  for (const it of items) if (it.seri && it.tahap !== 'tayang') (bySeri.get(it.seri) || bySeri.set(it.seri, []).get(it.seri)).push(it);
  for (const [seri, list] of bySeri) {
    for (let i = 1; i < list.length; i++) {
      const a = parseDay(list[i - 1].publishAt), b2 = parseDay(list[i].publishAt);
      if (a && b2 && Math.round((b2 - a) / 864e5) <= 1) warn('seri-berdempet', `Seri "${seri}" tayang berdempetan: "${list[i - 1].title}" dan "${list[i].title}"`, [list[i - 1].id, list[i].id], list[i].publishAt);
    }
  }
  // sensitif berjejer: dua yang sensitif berurutan di urutan tayang
  for (let i = 1; i < items.length; i++) if (items[i].sensitif && items[i - 1].sensitif && items[i].tahap !== 'tayang')
    warn('sensitif-berjejer', `Dua konten sensitif berurutan: "${items[i - 1].title}" lalu "${items[i].title}"`, [items[i - 1].id, items[i].id], items[i].publishAt);
  // minggu ISO (Senin awal)
  const dates = (from && to ? [from, to] : items.length ? [items[0].publishAt, items[items.length - 1].publishAt] : []).map(parseDay).filter(Boolean);
  const minggu = [];
  if (dates.length === 2) {
    const target = conf.targetPerMinggu, today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (const w of weekList(dates[0], dates[1])) {
      const mulai = dayOf(w), akhir = dayOf(addDays(w, 6));
      const inWeek = items.filter(it => it.tahap !== 'arsip' && it.publishAt >= mulai && it.publishAt <= akhir);
      minggu.push({ mulai, n: inWeek.length, target });
      if (!target) continue;
      if (inWeek.length > target) warn('target-lebih', `Minggu ${mulai}: ${inWeek.length} post, target ${target}`, inWeek.map(x => x.id), mulai);
      else if (inWeek.length < target && addDays(w, 6) >= today) warn('target-kurang', `Minggu ${mulai}: ${inWeek.length} post, target ${target}`, inWeek.map(x => x.id), mulai);
    }
  }
  // lebih dari target harian, hanya untuk yang belum tayang
  if (conf.targetPerHari) {
    const perHari = new Map();
    for (const it of items) if (it.publishAt && it.tahap !== 'tayang' && it.tahap !== 'arsip') perHari.set(it.publishAt, [...(perHari.get(it.publishAt) || []), it.id]);
    for (const [hari, ids] of perHari) if (ids.length > conf.targetPerHari) warn('harian-lebih', `${hari}: ${ids.length} post, target ${conf.targetPerHari} per hari`, ids, hari);
  }
  // tanpa caption / media (hanya yang belum tayang)
  for (const it of items) {
    if (it.tahap === 'tayang') continue;
    const dir = root && it.folder ? path.join(root, it.folder) : null;
    const ov = (() => { try { return j(one(officeDb(office), 'SELECT media FROM konten WHERE card_id = ?', it.id)?.media, {}) || {}; } catch { return {}; } })();
    if (!dir || !hasCaption(dir)) warn('tanpa-caption', `"${it.title}" belum punya caption`, [it.id], it.publishAt);
    const has = !!(ov.slides?.length || ov.video) || (dir && (() => { try { const m = detectMedia(root, it.folder, { light: true }); return !!(m.slides.length || m.video); } catch { return false; } })());
    if (!has) warn('tanpa-media', `"${it.title}" belum punya media`, [it.id], it.publishAt);
  }
  return { items, peringatan, minggu };
}

export function setujuiJadwal(office, ids, by = actorName()) {
  const board = ensureBoard(office);
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))];
  if (!list.length) throw err(400, 'ids kosong');
  const rows = list.map(id => rowOf(office, id));
  const bad = rows.filter(r => !r.publish_at).map(r => r.id);
  if (bad.length) throw err(400, `Belum punya tanggal: ${bad.join(', ')}`);
  for (const r of rows) {
    run(officeDb(office), "UPDATE konten SET jadwal_status = 'fix' WHERE card_id = ?", r.id);
    kontenTouch(office, r.id);
    if (tahapAt(board, r.col) === 'siap') st.updateCard(office, r.id, { col: colOf(board, 'terjadwal') }, by);
  }
  emit(office);
  return { items: rows.map(r => getItem(office, r.id)) };
}

/** Usulan editor (tool konten_jadwal_usul): hanya kartu `siap`; tanggal diisi tanpa memindah tahap; pemilik menyetujui lewat setujuiJadwal. */
export function usulJadwal(office, list, by = actorName()) {
  const board = ensureBoard(office), conf = getConf(office);
  const ok = [], ditolak = [];
  for (const x of Array.isArray(list) ? list : []) {
    try {
      const r = rowOf(office, String(x.id));
      const tahap = tahapAt(board, r.col);
      if (tahap !== 'siap') throw new Error(`belum siap tayang (tahap: ${tahap}); hanya kartu di Siap tayang yang bisa diusulkan`);
      const tanggal = day(x.tanggal);
      if (!tanggal) throw new Error('tanggal kosong');
      const jam = x.jam ? String(x.jam) : conf.jamDefault;
      if (!JAM.test(jam)) throw new Error('jam harus HH:MM');
      run(officeDb(office), "UPDATE konten SET jam = ?, jadwal_status = 'usulan' WHERE card_id = ?", jam, r.id);
      kontenTouch(office, r.id);
      st.updateCard(office, r.id, { publishAt: tanggal }, by);
      ok.push({ id: r.id, tanggal, jam });
    } catch (e) { ditolak.push({ id: x?.id ?? null, alasan: e.message }); }
  }
  let peringatan = [];
  if (ok.length) {
    const ds = ok.map(o => o.tanggal).sort();
    const a = addDays(parseDay(ds[0]), -7), b = addDays(parseDay(ds[ds.length - 1]), 7);
    peringatan = jadwal(office, { from: dayOf(a), to: dayOf(b) }).peringatan;
  }
  emit(office);
  return { diusulkan: ok, ditolak, peringatan };
}

/* ---------------- performa ---------------- */
export function setPerforma(office, cid, b = {}) {
  const board = ensureBoard(office), r = rowOf(office, cid);
  const plat = String(b.platform || '');
  if (!PLATFORMS.includes(plat)) throw err(400, `platform harus salah satu: ${PLATFORMS.join(', ')}`);
  if (tahapAt(board, r.col) !== 'tayang') throw err(409, 'Performa hanya diisi untuk konten yang sudah tayang.');
  const cur = j(r.perf, {}) || {}, p = { ...(cur[plat] || {}) };
  let any = false;
  for (const m of METRIK) if (b[m] !== undefined && b[m] !== null && b[m] !== '') {
    const n = Number(b[m]);
    if (!Number.isFinite(n) || n < 0) throw err(400, `${m} harus angka >= 0`);
    p[m] = Math.round(n); any = true;
  }
  if (!any) throw err(400, `Isi minimal satu: ${METRIK.join(', ')}`);
  p.at = nowIso();
  cur[plat] = p;
  run(officeDb(office), 'UPDATE konten SET perf = ?, updated_at = ? WHERE card_id = ?', JSON.stringify(cur), nowIso(), cid);
  emit(office, cid);
  return getItem(office, cid);
}

/* ---------------- caption ---------------- */
export function putCaption(office, cid, b = {}) {
  const r = rowOf(office, cid), conf = getConf(office), root = rootAbs(office, conf);
  const plat = String(b.platform || '').toLowerCase();
  if (!CAP_PLATS[plat]) throw err(400, `platform harus salah satu: ${Object.keys(CAP_PLATS).join(', ')}`);
  if (!root) throw err(404, 'Folder konten belum diatur (conf.root).');
  if (!r.folder) throw err(409, 'Konten ini belum punya folder; isi folder dulu.');
  if (typeof b.text !== 'string') throw err(400, 'text harus teks');
  const { abs: dir } = safeIn(root, r.folder);
  if (!fs.statSync(dir).isDirectory()) throw err(400, 'folder bukan direktori');
  const file = path.join(dir, CAPTION_FILE);
  let old = ''; try { old = fs.readFileSync(file, 'utf8'); } catch {}
  safeIn(root, `${r.folder}/${CAPTION_FILE}`, { mustExist: false }); // symlink caption yang menunjuk ke luar ditolak
  const tmp = `${file}.kc-tmp`;
  fs.writeFileSync(tmp, replaceSection(old, plat, b.text));
  fs.renameSync(tmp, file);
  kontenTouch(office, cid);
  emit(office, cid);
  return getItem(office, cid);
}

/* ---------------- tayang ---------------- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.html', '.css', '.js', '.mjs', '.cjs', '.py', '.sh', '.yml', '.yaml', '.csv', '.toml']);
const SEARCH_SKIP = new Set(['node_modules', 'out', '_hasil', '_arsip', '.git', '__pycache__']);
/** Berkas teks di bawah root yang menyebut path lama. Terbatas: lewati folder berat, maks berkas, maks waktu, maks hasil. */
export function pathPerluCek(rootDir, oldRel, { maxFiles = 4000, maxMs = 1500, maxHits = 50, maxSize = 512 * 1024 } = {}) {
  const hits = [], t0 = Date.now(), queue = [rootDir];
  let seen = 0;
  while (queue.length && hits.length < maxHits && seen < maxFiles && Date.now() - t0 < maxMs) {
    const dir = queue.shift();
    let ds = []; try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ds) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { if (!SEARCH_SKIP.has(d.name) && !d.name.startsWith('.')) queue.push(path.join(dir, d.name)); continue; }
      if (!d.isFile() || !TEXT_EXT.has(path.extname(d.name).toLowerCase())) continue;
      if (++seen > maxFiles || Date.now() - t0 >= maxMs) break;
      const f = path.join(dir, d.name);
      try { if (fs.statSync(f).size > maxSize || !fs.readFileSync(f, 'utf8').includes(oldRel)) continue; } catch { continue; }
      hits.push(path.relative(rootDir, f).split(path.sep).join('/'));
      if (hits.length >= maxHits) break;
    }
  }
  return hits;
}
const tglPanjang = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;

function writeSudahPosting(dir, { plat, link, title, at }) {
  const f = path.join(dir, 'SUDAH-POSTING.txt'), label = PLAT_LABEL[plat], lk = link || '(link belum dicatat)';
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `SUDAH DIPOSTING di ${label}\n${lk}\nJudul IG: ${title}\nDicek: ${tglPanjang(at)} (konfirmasi pemilik)\n`);
    return 'dibuat';
  }
  const cur = fs.readFileSync(f, 'utf8');
  if (link && cur.includes(link)) return 'sudah-ada';
  fs.appendFileSync(f, `${cur.endsWith('\n') ? '' : '\n'}${label}: ${lk}\n`);
  return 'ditambah';
}
/** Baris tabel baru ditambahkan di akhir tabel pertama (yang berkepala "| Folder |"); tidak menulis ulang bagian lain. */
function appendStatusRow(file, folder, link, title) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (text.includes(`| ${folder} |`)) return false;
  const row = `| ${folder} | ${link || '(link belum dicatat)'} | ${String(title).replace(/\|/g, '/')} |`;
  const lines = text.split('\n');
  const head = lines.findIndex(l => /^\|\s*Folder\s*\|/i.test(l));
  if (head < 0) { fs.writeFileSync(file, `${text.replace(/\s*$/, '\n')}${row}\n`); return true; }
  let end = head;
  while (end + 1 < lines.length && lines[end + 1].startsWith('|')) end++;
  lines.splice(end + 1, 0, row);
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

export async function tayang(office, cid, b = {}, by = actorName()) {
  const board = ensureBoard(office), conf = getConf(office);
  const r = rowOf(office, cid), db = officeDb(office);
  const plat = String(b.platform || '').toLowerCase();
  if (!PLATFORMS.includes(plat)) throw err(400, `platform harus salah satu: ${PLATFORMS.join(', ')}`);
  if (r.jenis === 'carousel' && plat === 'youtube') throw err(400, 'Carousel tidak ditawarkan ke YouTube.');
  const t0 = tahapAt(board, r.col);
  if (t0 === 'arsip') throw err(409, 'Konten di Arsip; pindahkan dulu dari Arsip.');
  const at = b.at ? new Date(b.at) : new Date();
  if (Number.isNaN(at.getTime())) throw err(400, '`at` bukan waktu yang sah (ISO)');
  const link = String(b.link || '').trim().slice(0, 500);
  const first = t0 !== 'tayang';
  const root = (() => { try { return rootAbs(office, conf); } catch { return null; } })();
  const out = { dipindah: null, pathPerluCek: [], peringatan: [], sudahPosting: null, statusFile: false, wiki: null };

  // 1. pindah folder lebih dulu (galat jelas sebelum ada yang berubah di database)
  let folder = r.folder;
  const m = first && conf.pindahFolder && root && folder ? /^belum-posting\/([^/]+)\/([^/]+)$/.exec(folder) : null;
  if (m) {
    const to = `sudah-posting/${m[1]}/${m[2]}`;
    const src = safeIn(root, folder, { mustExist: false });
    if (fs.existsSync(src.abs)) {
      if (fs.lstatSync(src.abs).isSymbolicLink() || !fs.lstatSync(src.abs).isDirectory()) throw err(409, `${folder} bukan folder biasa; tidak dipindahkan.`);
      const dst = safeIn(root, to, { mustExist: false });
      if (fs.existsSync(dst.abs)) throw err(409, `Tujuan ${to} sudah ada; tidak ditimpa. Pindahkan atau ganti nama salah satunya, lalu ulangi.`);
      fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
      try { fs.renameSync(src.abs, dst.abs); }
      catch (e) { throw err(409, `Gagal memindah ${folder} ke ${to}: ${e.code || e.message}`); }
      out.dipindah = { dari: folder, ke: to };
      folder = to;
    } else out.peringatan.push(`Folder ${folder} tidak ada di disk, jadi tidak dipindahkan.`);
  }

  // 2. database
  const plats = j(r.platforms, {}) || {};
  // idempoten: panggilan ulang untuk platform yang sudah tayang memperbarui link; waktu tayang awal dipertahankan kecuali `at` diberikan
  plats[plat] = { link: link || plats[plat]?.link || '', at: b.at || !plats[plat]?.at ? at.toISOString() : plats[plat].at };
  run(db, 'UPDATE konten SET platforms = ?, folder = ?, jadwal_status = ?, updated_at = ? WHERE card_id = ?', JSON.stringify(plats), folder, first ? 'fix' : r.jadwal_status || '', nowIso(), cid);
  const f = {};
  if (first) { f.col = colOf(board, 'tayang'); f.publishAt = dayOf(at); }
  if (Object.keys(f).length) st.updateCard(office, cid, f, by);
  if (first) st.commentCard(office, cid, `Ditandai tayang di ${PLAT_LABEL[plat]}${link ? `: ${link}` : ''}`, by);
  refreshCover(office, cid);
  coverCache.clear();

  // 3. berkas di folder proyek (gagal di sini tidak membatalkan tayang; dilaporkan sebagai peringatan)
  if (root && folder) {
    try {
      const dir = safeIn(root, folder).abs;
      if (fs.statSync(dir).isDirectory()) out.sudahPosting = writeSudahPosting(dir, { plat, link, title: r.title, at });
    } catch (e) { out.peringatan.push(`SUDAH-POSTING.txt tidak ditulis: ${e.message}`); }
    if (first && conf.statusFile) {
      try { out.statusFile = appendStatusRow(safeIn(root, conf.statusFile).abs, folder, plats.instagram?.link || link, r.title); }
      catch (e) { out.peringatan.push(`statusFile tidak diperbarui: ${e.message}`); }
    }
    if (out.dipindah) { try { out.pathPerluCek = pathPerluCek(root, out.dipindah.dari); } catch {} }
  }
  if (first) out.wiki = refreshWiki(office, by);
  emit(office, cid);
  return { ...getItem(office, cid), ...out };
}

/** Segarkan halaman wiki daftar tayang / belum tayang bila conf.wikiTayang / wikiBelum diisi. Halaman tulisan tangan (tanpa penanda) tidak ditimpa. */
export function refreshWiki(office, by = actorName()) {
  const conf = getConf(office), res = {};
  if (!conf.wikiTayang && !conf.wikiBelum) return null;
  let items;
  try { items = listRows(office).items; } catch (e) { return { galat: e.message }; }
  const cell = s => String(s ?? '').replace(/\|/g, '/');
  const pages = {
    wikiTayang: ['Status Posting', [`| Tanggal | Judul | ${conf.platforms.map(p => PLAT_LABEL[p]).join(' | ')} |`, `|---|---|${conf.platforms.map(() => '---').join('|')}|`, ...items.filter(i => i.tahap === 'tayang').sort((a, b) => b.publishAt.localeCompare(a.publishAt) || a.title.localeCompare(b.title))
      .map(i => `| ${i.publishAt || '-'} | ${cell(i.title)} | ${conf.platforms.map(p => { const t = i.platforms[p]; return t ? (t.link ? `[✓](${t.link})` : '✓') : i.jenis === 'carousel' && p === 'youtube' ? '–' : 'belum'; }).join(' | ')} |`)]],
    wikiBelum: ['Konten belum tayang', ['| Tahap | Judul | Tanggal |', '|---|---|---|', ...items.filter(i => !['tayang', 'arsip'].includes(i.tahap))
      .sort((a, b) => STAGE_IDS.indexOf(b.tahap) - STAGE_IDS.indexOf(a.tahap) || a.title.localeCompare(b.title)).map(i => `| ${i.tahapNama} | ${cell(i.title)} | ${i.publishAt || '-'} |`)]],
  };
  for (const [key, [title, lines]] of Object.entries(pages)) {
    const ref = conf[key];
    if (!ref) continue;
    try {
      const cur = (() => { try { return st.getWiki(office, ref); } catch { return null; } })();
      if (cur && !String(cur.body || '').includes(WIKI_MARK)) { res[key] = { dilewati: cur.slug, alasan: 'halaman sudah ada dan bukan buatan tab Konten (tidak ditimpa)' }; continue; }
      const body = `${WIKI_MARK}\n\nDiperbarui otomatis oleh tab Konten. Jangan disunting tangan, perubahan akan tertimpa.\n\n${lines.join('\n')}\n`;
      const saved = st.saveWiki(office, { slug: cur?.slug || undefined, title: cur?.title || (/^[\w-]+$/.test(ref) && ref === ref.toLowerCase() ? title : ref), body, msg: 'Konten: segarkan' }, by);
      res[key] = { slug: saved.slug };
    } catch (e) { res[key] = { galat: e.message }; }
  }
  return res;
}

/* ---------------- kit ---------------- */
const kitUrl = (office, rel, thumb) => `/api/offices/${encodeURIComponent(office)}/konten/kit/file?path=${encodeURIComponent(rel)}${thumb ? '&thumb=1' : ''}`;
const KIT_MEDIA = /\.(png|jpe?g|webp|gif|mp4|m4v|webm|mov)$/i, KIT_HTML = /\.html?$/i, KIT_MAX = 24;
/** Isi yang layak dipratinjau dari sebuah folder kit: berkas jadi dulu, lalu desain HTML, lalu aset. */
export function kitFiles(root, rel) {
  const dir = path.join(root, rel), inDir = (sub, re) => listFiles(path.join(dir, sub)).filter(n => re.test(n) && !/^preview\./i.test(n)).sort().map(n => path.join(rel, sub, n));
  const slides = (() => { try { return detectMedia(root, rel).slides || []; } catch { return []; } })();
  const groups = [slides, inDir('', KIT_MEDIA), inDir('out', KIT_MEDIA), inDir('html', KIT_HTML), inDir('', KIT_HTML), inDir('frames', KIT_MEDIA), inDir('aset', KIT_MEDIA)];
  const all = groups.find(g => g.length) || [];
  // folder berisi ribuan frame: ambil merata, bukan hanya yang awal
  const step = all.length > KIT_MAX ? all.length / KIT_MAX : 1;
  return { n: all.length, files: step > 1 ? Array.from({ length: KIT_MAX }, (_, i) => all[Math.floor(i * step)]) : all };
}
const kitFileRow = (office, rel) => ({ name: path.basename(rel), rel, kind: KIT_HTML.test(rel) ? 'html' : /\.(mp4|m4v|webm|mov)$/i.test(rel) ? 'video' : 'image', url: kitUrl(office, rel, false), thumb: kitUrl(office, rel, true) });
const kitRow = (office, root, k) => {
  let ada = false, isFile = false, isi = [], n = 0;
  if (root) {
    try {
      const s = safeIn(root, k.path); ada = true; isFile = fs.statSync(s.real || s.abs).isFile();
      if (isFile) { isi = [kitFileRow(office, k.path)]; n = 1; }
      else { const f = kitFiles(root, k.path); n = f.n; isi = f.files.map(r => kitFileRow(office, r)); }
    } catch {}
  }
  return { id: k.id, jenis: k.jenis, nama: k.nama, path: k.path, catatan: k.catatan || '', ord: k.ord, createdAt: k.created_at, ada, isi, n,
    url: isi[0]?.url || null, thumb: isi[0]?.thumb || null };
};
export function listKit(office, { jenis } = {}) {
  const root = (() => { try { return rootAbs(office); } catch { return null; } })();
  return { items: all(officeDb(office), `SELECT * FROM konten_kit ${jenis ? 'WHERE jenis = ?' : ''} ORDER BY jenis, ord, created_at`, ...(jenis ? [jenis] : [])).map(k => kitRow(office, root, k)) };
}
export function addKit(office, b = {}) {
  const jenis = String(b.jenis || 'lain');
  if (!KIT_JENIS.includes(jenis)) throw err(400, `jenis harus salah satu: ${KIT_JENIS.join(', ')}`);
  const nama = String(b.nama || '').trim().slice(0, 120);
  if (!nama) throw err(400, 'nama wajib diisi');
  const p = cleanRel(b.path, 'path');
  if (!p) throw err(400, 'path wajib diisi (relatif ke folder konten)');
  const root = rootAbs(office);
  if (root) { try { safeIn(root, p); } catch (e) { throw err(e.code === 403 ? 400 : e.code || 400, e.code === 404 ? `Berkas tidak ada di folder konten: ${p}` : e.message); } }
  const db = officeDb(office), id = 'kit' + newId().slice(0, 6);
  run(db, 'INSERT INTO konten_kit (id, jenis, nama, path, catatan, ord, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, jenis, nama, p, String(b.catatan || '').slice(0, 500),
    (one(db, 'SELECT MAX(ord) m FROM konten_kit WHERE jenis = ?', jenis)?.m ?? -1) + 1, nowIso());
  emit(office);
  return kitRow(office, root, one(db, 'SELECT * FROM konten_kit WHERE id = ?', id));
}
export function removeKit(office, id) {
  const r = run(officeDb(office), 'DELETE FROM konten_kit WHERE id = ?', id);
  if (!r?.changes) throw err(404, 'Item kit tidak ditemukan');
  emit(office);
  return { ok: true };
}

/* ---------------- impor ---------------- */
/** Impor folder konten ke kartu. Idempoten per folder. dryRun: hanya hitung. Tidak menyentuh berkas di disk. */
export function impor(office, { dryRun = false } = {}, by = actorName()) {
  const conf = getConf(office);
  if (!conf.root) throw err(400, 'Isi dulu conf.root (folder konten relatif ke folder kantor) lewat PATCH /konten/conf; impor ditolak.');
  const root = rootAbs(office, conf);
  if (!root || !fs.existsSync(root)) throw err(400, `Folder konten tidak ada: ${conf.root}`);
  const plan = scan(root);
  const known = new Set(all(officeDb(office), "SELECT folder FROM konten WHERE folder <> ''").map(x => x.folder));
  const res = { dibuat: 0, dilewati: 0, perTahap: {}, contoh: [] };
  if (!dryRun) ensureBoard(office);
  for (const e of plan) {
    if (known.has(e.folder)) { res.dilewati++; continue; }
    res.dibuat++;
    res.perTahap[e.tahap] = (res.perTahap[e.tahap] || 0) + 1;
    if (res.contoh.length < 10) res.contoh.push({ folder: e.folder, title: e.title, tahap: e.tahap, jenis: e.jenis, seri: e.seri, publishAt: e.publishAt });
    if (dryRun) continue;
    const it = createItem(office, { title: e.title, jenis: e.jenis, folder: e.folder, seri: e.seri, tahap: e.tahap, sensitif: e.sensitif, labels: e.labels, publishAt: e.publishAt, platforms: e.platforms }, by);
    if (e.tahap === 'tayang') run(officeDb(office), "UPDATE konten SET jadwal_status = 'fix' WHERE card_id = ?", it.id);
  }
  if (!dryRun && res.dibuat) emit(office);
  return res;
}

/* ---------------- file ---------------- */
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' };
const extOf = n => path.extname(n).slice(1).toLowerCase();
const kindOfExt = e => (/^(png|jpe?g|gif|webp|avif|heic)$/.test(e) ? 'image' : /^(mp4|m4v|webm|mov)$/.test(e) ? 'video' : 'other');
const CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

// gambar kecil dibuat paling banyak 3 sekaligus (galeri bisa meminta ratusan); permintaan sama menunggu hasil yang sama
const thumbJobs = new Map();
let thumbRunning = 0;
const thumbWaiters = [];
async function thumbSlot() { if (thumbRunning < 3) { thumbRunning++; return; } await new Promise(r => thumbWaiters.push(r)); thumbRunning++; }
const thumbDone = () => { thumbRunning--; thumbWaiters.shift()?.(); };
const execFileP = promisify(execFile);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Desain slide yang cuma ada sebagai HTML: dirender Chrome headless seukuran slide (1440x1800), hasilnya di cache kantor. */
async function htmlThumb(abs, out) {
  if (!fs.existsSync(CHROME)) throw err(404, 'Chrome tidak ada, pratinjau HTML tidak bisa dibuat');
  const png = `${out}.tmp.png`;
  try {
    await execFileP(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--window-size=1440,1800', '--virtual-time-budget=2500', `--screenshot=${png}`, pathToFileURL(abs).href], { timeout: 40000 });
    return await thumbFile(png, out, 'image');
  } finally { fs.rmSync(png, { force: true }); }
}
function makeThumb(office, abs, st0, kind) {
  const dir = path.join(OFFICE_DIR, office, 'konten-thumb');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${crypto.createHash('sha1').update(`${abs}:${st0.size}:${st0.mtimeMs}`).digest('hex').slice(0, 24)}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  let job = thumbJobs.get(out);
  if (!job) {
    job = (async () => { await thumbSlot(); try { return kind === 'html' ? await htmlThumb(abs, out) : await thumbFile(abs, out, kind, kind === 'video' ? 1 : 0); } finally { thumbDone(); } })().finally(() => thumbJobs.delete(out));
    thumbJobs.set(out, job);
  }
  return job;
}

/** GET /:cid/file?path=<rel>[&thumb=1][&download=1]. Hanya berkas di dalam conf.root (realpath), dengan Range untuk video. */
export async function serveFile(office, rel, { thumb = false, download = false } = {}, req, res) {
  const root = rootAbs(office);
  if (!String(rel || '').trim()) throw err(400, 'path wajib diisi');
  const { abs, real } = safeIn(root, rel);
  const s = fs.statSync(real);
  if (!s.isFile()) throw err(400, 'Ini folder');
  const e = extOf(abs), kind = thumb && /^html?$/.test(e) ? 'html' : kindOfExt(e);
  if (thumb && kind !== 'other') {
    try {
      const f = await makeThumb(office, real, s, kind);
      const size = fs.statSync(f).size;
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return void fs.createReadStream(f).pipe(res);
    } catch (x) { if (kind !== 'image') throw err(404, 'Gambar kecil tidak bisa dibuat untuk berkas ini'); /* gambar: jatuh ke berkas aslinya */ }
  }
  const type = MIME[e] || 'application/octet-stream', size = s.size;
  const rg = parseRange(req?.headers?.range, size);
  if (rg === false) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }); return void res.end(); }
  res.writeHead(rg ? 206 : 200, {
    'Content-Type': download ? 'application/octet-stream' : type, 'Content-Length': rg ? rg.end - rg.start + 1 : size, 'Accept-Ranges': 'bytes', ...(rg ? { 'Content-Range': `bytes ${rg.start}-${rg.end}/${size}` } : {}),
    'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', ...(e === 'pdf' && !download ? {} : { 'Content-Security-Policy': CSP }),
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}` });
  const rs = fs.createReadStream(real, rg ? { start: rg.start, end: rg.end } : {});
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

/* ---------------- pengingat ---------------- */
const REMIND_MAX_MS = 7 * 864e5; // yang terlewat lebih dari seminggu tidak diingatkan (mencegah ledakan setelah daemon lama mati)
/** Kartu terjadwal yang tanggal dan jamnya sudah lewat dan belum tayang: satu notify per kartu per tanggal (diingat di meta, selamat dari restart). */
const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atClock = (d, jam) => { const [h, m] = jam.split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m); };
/**
 * Semua pengingat ke pemilik; tiap satu terkirim sekali (dicatat di meta, jadi tahan restart). Mengembalikan id kartu yang diingatkan.
 * Ringkasan pagi, "waktunya posting" sebelum jam tayang, "belum ditandai tayang" sesudahnya, dan platform yang belum disusul.
 */
export function remindOffice(office, now = new Date()) {
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM boards WHERE id = ?', BOARD)) return [];
  const board = bd.listBoards(office).find(b => b.id === BOARD);
  const conf = getConf(office), rem = { ...DEFAULT_PENGINGAT, ...(conf.pengingat || {}) }, sent = [];
  if (!board || !rem.aktif) return sent;
  const send = (key, stamp, who, text, id = null) => {
    const k = `konten.remind.${key}`;
    if (one(db, 'SELECT value FROM meta WHERE key = ?', k)?.value === stamp) return false;
    run(db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', k, stamp);
    bus.emit('notify', { kind: 'konten', office, id, who, text, dedupe: `${key}:${stamp}` });
    return true;
  };
  const rows = all(db, `SELECT c.id, c.title, c.col, c.publish_at, k.jam, k.jenis, k.platforms FROM cards c JOIN konten k ON k.card_id = c.id WHERE c.board = ? AND c.archived = 0`, BOARD)
    .map(r => ({ ...r, tahap: tahapAt(board, r.col) }));
  const dated = rows.filter(r => r.publish_at && !['tayang', 'arsip'].includes(r.tahap) && parseDay(r.publish_at));
  const jamOf = r => (JAM.test(r.jam || '') ? r.jam : conf.jamDefault);

  // ringkasan pagi, maksimal 3 jam sesudah jamnya supaya daemon yang baru hidup siang hari tidak mengirim ringkasan basi
  if (rem.pagi && JAM.test(rem.pagi)) {
    const start = atClock(now, rem.pagi), today = dayStr(now);
    if (now >= start && now - start < 3 * 3600e3) {
      const list = dated.filter(r => r.publish_at === today).sort((a, b) => jamOf(a).localeCompare(jamOf(b)));
      const nReview = rows.filter(r => r.tahap === 'review').length;
      const isi = list.length ? `${list.length} post: ${list.map(r => `${jamOf(r)} ${r.title}`).join('; ')}` : conf.targetPerHari ? `Belum ada post terjadwal, target ${conf.targetPerHari} per hari` : '';
      if (isi || nReview) send('pagi', today, 'Konten hari ini', [isi, nReview ? `${nReview} menunggu review` : ''].filter(Boolean).join(' · '));
    }
  }
  for (const r of dated) {
    const jam = jamOf(r), due = atClock(parseDay(r.publish_at), jam), stamp = `${r.publish_at} ${jam}`;
    if (now - due > REMIND_MAX_MS) continue;
    const belum = !['siap', 'terjadwal'].includes(r.tahap) ? ' (belum kamu setujui)' : '';
    if (now >= new Date(due.getTime() - rem.sebelumMenit * 60e3) && now - due < 864e5 && send(r.id, stamp, 'Waktunya posting', `${jam} ${r.title}${belum}`, r.id)) sent.push(r.id);
    else if (rem.terlewatMenit && now - due >= rem.terlewatMenit * 60e3 && now - due < 864e5 && send(`${r.id}.lewat`, stamp, 'Belum ditandai tayang', r.title, r.id)) sent.push(r.id);
  }
  // sudah tayang di sebagian platform: ingatkan sisanya sekali. Hanya post baru, supaya arsip lama tidak ikut menagih.
  if (rem.susulanJam) for (const r of rows.filter(x => x.tahap === 'tayang')) {
    const done = j(r.platforms, {}), times = Object.values(done).map(v => Date.parse(v?.at)).filter(Boolean);
    if (!times.length) continue;
    const age = now - Math.min(...times);
    if (age < rem.susulanJam * 3600e3 || age > 48 * 3600e3) continue;
    const missing = conf.platforms.filter(p => !done[p] && !(r.jenis === 'carousel' && p === 'youtube'));
    if (missing.length && send(`${r.id}.susul`, missing.join(','), `Belum di ${missing.map(p => PLAT_LABEL[p]).join(', ')}`, r.title, r.id)) sent.push(r.id);
  }
  return sent;
}
/** Satu notifikasi percobaan, untuk memastikan pengingat sampai ke HP. */
export function testReminder(office) {
  bus.emit('notify', { kind: 'konten', office, id: null, who: 'Tes pengingat', text: 'Kalau ini muncul di HP, pengingat Konten sudah jalan.', dedupe: `tes:${Date.now()}` });
  return { ok: true };
}
let timer = null;
/** Pengingat dicek tiap menit. Timer unref; index.js tidak memulainya di mode KANTOR_DEMO. */
export function startKonten() {
  if (timer) return;
  const tick = () => { for (const o of listOffices()) { try { remindOffice(o.id); } catch (e) { console.error(`konten ${o.id}: ${e.message}`); } } };
  setTimeout(tick, 30e3).unref?.();
  timer = setInterval(tick, 60e3);
  timer.unref?.();
}
export const stopKonten = () => { if (timer) clearInterval(timer); timer = null; };
