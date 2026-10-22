// Pratinjau: an agent sends files (images, PDF, HTML, video) or a whole static site for the owner to look at and decide on.
// Files are copied at send time into <office dir>/pratinjau/<id>/files/ (an immutable snapshot) and served under
// /pv/<office>/<id>/<key>/<path>, a signed path that needs no cookie, with `Content-Security-Policy: sandbox allow-scripts`
// so a page runs in an opaque origin: no Kantor cookies, token, or same-origin API access. See docs/FRONTEND-CONTRACT.md.
// Owner decisions travel back to the sending role as a DM (dm.fromOwner); new items push to Ghina (kind 'pratinjau').
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OFFICE_DIR, config, saveConfig } from './config.js';
import { officeDb, all, one, run, nowIso, newId, j } from './db.js';
import { officeModel, listOffices } from './offices.js';
import { bus, live, logOffice } from './live.js';
import * as st from './store.js';
import { getBoard, firstOfKind } from './boards.js';
import * as dm from './dm.js';
import { sessionAction } from './tmux.js';
import { parseRange, saveFromFile, mediaMarkdown } from './media.js';
import { thumbFile, safeName } from './attachments.js';
import { who as actorName } from './actor.js';

const execFileP = promisify(execFile);
const err = (code, message) => Object.assign(new Error(message), { code });
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fmtSize = n => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** Limits per item; config().pratinjau may override (tests use small ones). */
export const conf = () => ({ maxFiles: 30, maxBytes: 200 * 1024 ** 2, maxBundleEntries: 3000, batchSec: 20, ...(config().pratinjau || {}) });

export const MODES = ['set', 'pilihan', 'bundle'];
/** jenis: what the agent wants from the owner. persetujuan = a decision (Setujui/Revisi), info = just look, pilihan = pick one. */
export const JENIS = ['persetujuan', 'info', 'pilihan'];
/** baru -> dilihat -> dikomentari; persetujuan: sebagian / disetujui / revisi; pilihan: dipilih. Plus flags arsip, pinned, snoozedUntil. */
export const STATUSES = ['baru', 'dilihat', 'dikomentari', 'sebagian', 'disetujui', 'revisi', 'dipilih'];
export const FILTERS = ['baru', 'perlu', 'semua', 'disimpan', 'arsip'];
export const REACTIONS = ['👍', '❤️', '🔥', '🤔'];
/** seconds -> "m:ss" (or "h:mm:ss") for time-coded video comments */
export const fmtT = t => { t = Math.max(0, Math.floor(Number(t) || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', heic: 'image/heic',
  pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', zip: 'application/zip',
};
const extOf = n => path.extname(String(n || '')).slice(1).toLowerCase();
export const mimeOf = n => TYPES[extOf(n)] || 'application/octet-stream';
export function kindOf(name) {
  const e = extOf(name);
  if (e === 'html' || e === 'htm') return 'html';
  if (/^(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/.test(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (/^(mp4|m4v|webm|mov)$/.test(e)) return 'video';
  if (/^(md|markdown|txt|csv|json)$/.test(e)) return 'doc';
  return 'other';
}

/* ---------------- storage ---------------- */

const seen = new WeakSet();
function db(office) {
  const d = officeDb(office);
  if (!seen.has(d)) {
    d.exec(`CREATE TABLE IF NOT EXISTS pratinjau (id TEXT PRIMARY KEY, root_id TEXT, parent_id TEXT, version INTEGER DEFAULT 1, status TEXT DEFAULT 'menunggu',
      from_role TEXT, data TEXT, created_at TEXT, decided_at TEXT);
      CREATE INDEX IF NOT EXISTS pratinjau_root ON pratinjau(root_id, version);
      CREATE INDEX IF NOT EXISTS pratinjau_at ON pratinjau(created_at);`);
    seen.add(d);
    migrate(office);
  }
  return d;
}
/** Idempotent migration: items from before jenis were all approval flow; 'menunggu' became 'baru'; a past pick is 'dipilih'. */
export function migrate(office) {
  {
    const d = officeDb(office);
    d.exec(`UPDATE pratinjau SET data = json_set(data, '$.jenis', 'persetujuan') WHERE json_extract(data, '$.jenis') IS NULL;
      UPDATE pratinjau SET status = 'baru' WHERE status = 'menunggu';
      UPDATE pratinjau SET status = 'dipilih' WHERE status = 'disetujui' AND json_extract(data, '$.mode') = 'pilihan' AND json_extract(data, '$.picked') IS NOT NULL;`);
  }
}
const itemDir = (office, id) => path.join(OFFICE_DIR, office, 'pratinjau', id);
const filesDir = (office, id) => path.join(itemDir(office, id), 'files');
const rowOf = (office, id) => one(db(office), 'SELECT * FROM pratinjau WHERE id = ?', String(id));

/** Signed path segment: whoever holds the item's url can read its files, nothing else. */
export const keyOf = (office, id) => crypto.createHmac('sha256', String(config().token || '')).update(`pratinjau:${office}:${id}`).digest('hex').slice(0, 24);
const okKey = (office, id, k) => { const a = Buffer.from(keyOf(office, id)), b = Buffer.from(String(k)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const enc = rel => rel.split('/').map(encodeURIComponent).join('/');
export const baseUrl = (office, id) => `/pv/${encodeURIComponent(office)}/${id}/${keyOf(office, id)}/`;

function view(office, r) {
  if (!r) return null;
  const d = j(r.data, {});
  const base = baseUrl(office, r.id);
  const role = r.from_role ? st.getRole(office, r.from_role) : null;
  const versions = all(db(office), 'SELECT id, version, status, created_at FROM pratinjau WHERE root_id = ? ORDER BY version, created_at', r.root_id)
    .map(v => ({ id: v.id, version: v.version, status: v.status, createdAt: v.created_at }));
  return {
    id: r.id, office, fromRole: r.from_role || null, fromName: role?.name || d.by || 'Agen', sid: d.sid || null,
    title: d.title, note: d.note || '', mode: d.mode, card: d.card || null, version: r.version, parentId: r.parent_id || null, rootId: r.root_id,
    jenis: jenisOf(d), status: r.status, filesPurged: !!d.filesPurged, purgedAt: d.purgedAt || null, picked: d.picked || null, ownerNote: d.ownerNote || null, wiki: d.wiki || null,
    createdAt: r.created_at, decidedAt: r.decided_at || null, size: d.size || 0,
    seenAt: d.seenAt || null, pinned: !!d.pinned, archived: !!d.archived, snoozedUntil: d.snoozedUntil || null,
    snoozed: !!(d.snoozedUntil && d.snoozedUntil > nowIso()),
    reactions: d.reactions || {}, comments: d.comments || [],
    base: d.mode === 'bundle' ? base : null,
    files: (d.files || []).map(f => {
      const tb = `/pvt/${encodeURIComponent(office)}/${r.id}/${keyOf(office, r.id)}/${f.id}`;
      return { id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind, rel: f.rel, url: base + enc(f.rel),
        // image/video thumbs are also made on demand; other kinds only once the background job made one
        thumb: f.kind === 'image' || f.kind === 'video' || f.thumb === 'siap' ? `${tb}.jpg` : null,
        thumbState: f.thumb || (f.kind === 'image' || f.kind === 'video' ? 'siap' : 'menyiapkan'),
        putar: f.putar || null, putarUrl: f.putar === 'siap' ? `${tb}.mp4` : null,
        status: f.status || 'menunggu', note: f.note || null };
    }),
    versions,
  };
}
export const getItem = (office, id) => { const r = rowOf(office, id); if (!r) throw err(404, `Pratinjau ${id} tidak ditemukan`); return view(office, r); };

export const jenisOf = d => JENIS.includes(d.jenis) ? d.jenis : d.mode === 'pilihan' ? 'pilihan' : 'persetujuan';
const DECIDED = ['disetujui', 'revisi', 'dipilih'];
/** Item status from its parts: an owner-wide revision wins, then a pick, then the per-file decisions, then comments / seen. */
export function aggregate(d) {
  if (d.revisiAll) return 'revisi';
  if (d.picked) return 'dipilih';
  const s = (d.files || []).map(f => f.status || 'menunggu');
  if (s.length && s.every(x => x === 'oke')) return 'disetujui';
  if (s.length && !s.includes('menunggu')) return 'revisi';
  if (s.some(x => x !== 'menunggu')) return 'sebagian';
  if ((d.comments || []).length) return 'dikomentari';
  if (d.seenAt) return 'dilihat';
  return 'baru';
}

function save(office, r, d) {
  const status = aggregate(d);
  d.lastAt = nowIso(); // last owner activity, for storage cleanup
  run(db(office), 'UPDATE pratinjau SET data = ?, status = ?, decided_at = ? WHERE id = ?', JSON.stringify(d), status, DECIDED.includes(status) || status === 'sebagian' ? (r.decided_at || nowIso()) : null, r.id);
  return emit(office, r.id);
}
function emit(office, id) {
  const item = view(office, rowOf(office, id));
  bus.emit('msg', { t: 'pratinjau', office, item });
  return item;
}

const ARCH = "COALESCE(json_extract(data, '$.archived'), 0) = 0";
const AWAKE = "(json_extract(data, '$.snoozedUntil') IS NULL OR json_extract(data, '$.snoozedUntil') <= ?)";
/** SQL condition + args per feed filter. Snoozed items stay out of Baru / Perlu keputusan until their time. */
function filterSql(f) {
  const now = nowIso();
  if (f === 'baru') return [`status = 'baru' AND ${ARCH} AND ${AWAKE}`, [now]];
  if (f === 'perlu' || f === 'menunggu') return [`json_extract(data, '$.jenis') != 'info' AND status NOT IN ('disetujui', 'revisi', 'dipilih') AND ${ARCH} AND ${AWAKE}`, [now]];
  if (f === 'disimpan') return ["COALESCE(json_extract(data, '$.pinned'), 0) != 0", []];
  if (f === 'arsip') return ["COALESCE(json_extract(data, '$.archived'), 0) != 0", []];
  if (STATUSES.includes(f)) return [`status = ? AND ${ARCH}`, [f]];
  return [ARCH, []];
}
export function listItems(office, { status = 'semua', limit = 60, sid = null, role = null } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 60));
  const conds = [], args = [];
  { const [c, a] = filterSql(status); conds.push(c); args.push(...a); }
  // optional sender filters (Ghina's per-session "Pratinjau" tab): sid lives in the JSON data, role in from_role
  if (sid) { conds.push("json_extract(data, '$.sid') = ?"); args.push(String(sid)); }
  if (role) { conds.push('from_role = ?'); args.push(String(role)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = all(db(office), `SELECT * FROM pratinjau ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${lim}`, ...args);
  const counts = Object.fromEntries(FILTERS.map(f => { const [c, a] = filterSql(f); return [f, one(db(office), `SELECT COUNT(*) n FROM pratinjau WHERE ${c}`, ...a).n]; }));
  counts.menunggu = counts.perlu; // old name (tab badge in older clients)
  return { items: rows.map(r => view(office, r)), counts };
}

/* ---------------- sending (agent) ---------------- */

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
/** Resolve a caller path against its folder; it must stay inside the office folder (symlinks resolved). */
export function resolveInOffice(office, cwd, p) {
  if (!p || !String(p).trim()) throw new Error('Path kosong');
  const root = real(officeModel(office).root);
  const base = cwd && fs.existsSync(cwd) ? cwd : root;
  const abs = path.resolve(base, String(p));
  if (!fs.existsSync(abs)) throw new Error(`Tidak ada file atau folder ${p}`);
  const r = fs.realpathSync(abs);
  if (r !== root && !r.startsWith(root + path.sep)) throw new Error(`${p} berada di luar folder kantor. Pratinjau hanya menerima berkas di dalam folder kantor (${root}).`);
  return r;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.kantor', '.DS_Store', '__MACOSX']);
/** Every regular file under dir (symlinks skipped, so nothing outside can sneak in). */
function walk(dir, max) {
  const out = [];
  const go = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) go(p, r);
      else if (e.isFile()) { out.push({ abs: p, rel: r, size: fs.statSync(p).size }); if (out.length > max) throw new Error(`Folder berisi lebih dari ${max} berkas. Kirim folder hasil build saja (mis. dist/).`); }
    }
  };
  go(dir, '');
  return out;
}

async function unzip(zip, to) {
  fs.mkdirSync(to, { recursive: true });
  try { await execFileP('/usr/bin/unzip', ['-qq', '-o', zip, '-d', to], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) { if (!fs.readdirSync(to).length) throw new Error(`Zip tidak bisa dibuka: ${clip(e.stderr || e.message, 160)}`); }
  // a zip holding one top folder: use that folder as the site root
  const top = fs.readdirSync(to).filter(n => !SKIP_DIRS.has(n));
  if (top.length === 1 && fs.statSync(path.join(to, top[0])).isDirectory()) return path.join(to, top[0]);
  return to;
}

const entryOrder = (a, b) => (b.rel === 'index.html') - (a.rel === 'index.html') || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel);

/**
 * pratinjau_kirim. a = {judul, files?, folder?, mode?, catatan?, kartu?, revisiDari?}. ident = {office, role, by, sid, cwd}.
 */
export async function sendItem(ident, a = {}) {
  const { office, role, by, sid, cwd } = ident;
  const lim = conf();
  const title = clip(a.judul, 140);
  if (!title) throw new Error('Isi `judul`: satu kalimat pendek tentang apa yang dipratinjau (mis. "Desain halaman checkout v2").');
  const list = Array.isArray(a.files) ? a.files.filter(x => String(x || '').trim()) : a.files ? [a.files] : [];
  if (a.folder && list.length) throw new Error('Pilih salah satu: `files` (berkas lepas) atau `folder` (situs statis/zip), jangan keduanya.');
  if (!a.folder && !list.length) throw new Error('Isi `files` (daftar path berkas) atau `folder` (folder hasil build atau .zip).');
  let mode = a.mode || (a.folder ? 'bundle' : 'set');
  if (!MODES.includes(mode)) throw new Error(`mode harus salah satu: ${MODES.join(', ')}`);
  const jenis = a.jenis || (mode === 'pilihan' ? 'pilihan' : 'info');
  if (!JENIS.includes(jenis)) throw new Error(`jenis harus salah satu: ${JENIS.join(', ')}`);
  if (jenis === 'pilihan' && list.length < 2 && mode !== 'bundle') throw new Error('Jenis pilihan butuh minimal 2 berkas untuk dipilih salah satunya.');
  if (a.folder && mode !== 'bundle') throw new Error('`folder` selalu mode bundle.');
  if (!a.folder && mode === 'bundle') throw new Error('Mode bundle butuh `folder` (folder atau .zip), bukan `files`.');
  if (mode === 'pilihan' && list.length < 2) throw new Error('Mode pilihan butuh minimal 2 berkas untuk dipilih salah satunya.');
  if (list.length > lim.maxFiles) throw new Error(`Terlalu banyak berkas (${list.length}, maks ${lim.maxFiles} per pratinjau). Pecah jadi beberapa pratinjau.`);
  let parent = null;
  if (a.revisiDari) { parent = rowOf(office, a.revisiDari); if (!parent) throw new Error(`Pratinjau ${a.revisiDari} (revisiDari) tidak ditemukan. Lihat id-nya di hasil pratinjau_kirim atau pratinjau_status.`); }
  let card = null;
  if (a.kartu) { try { card = st.resolveCardId(office, a.kartu); } catch { throw new Error(`Kartu ${a.kartu} tidak ditemukan.`); } }

  const id = newId('p');
  const dir = itemDir(office, id), stage = `${dir}.tmp`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
  const files = [];
  let total = 0;
  try {
    if (mode === 'bundle') {
      let src = resolveInOffice(office, cwd, a.folder);
      const isZip = fs.statSync(src).isFile();
      if (isZip && extOf(src) !== 'zip') throw new Error('`folder` harus folder atau berkas .zip.');
      if (isZip) src = await unzip(src, path.join(stage, 'unzip'));
      const tree = walk(src, lim.maxBundleEntries);
      total = tree.reduce((s, f) => s + f.size, 0);
      if (total > lim.maxBytes) throw new Error(`Folder terlalu besar (${fmtSize(total)}, maks ${fmtSize(lim.maxBytes)}).`);
      const entries = tree.filter(f => kindOf(f.rel) === 'html').sort(entryOrder);
      if (!entries.length) throw new Error('Folder tidak berisi halaman .html. Kirim folder hasil build yang punya index.html.');
      for (const f of tree) { const to = path.join(stage, 'files', f.rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(f.abs, to); }
      fs.rmSync(path.join(stage, 'unzip'), { recursive: true, force: true });
      entries.slice(0, lim.maxFiles).forEach((f, i) => files.push({ id: `f${i + 1}`, name: f.rel, rel: f.rel, mime: mimeOf(f.rel), size: f.size, kind: 'html', status: 'menunggu' }));
    } else {
      const used = new Set();
      const srcs = list.map(p => {
        const r = resolveInOffice(office, cwd, p);
        const s = fs.statSync(r);
        if (!s.isFile()) throw new Error(`${p} bukan berkas. Untuk folder/situs pakai \`folder\`.`);
        if (!s.size) throw new Error(`${p} kosong.`);
        total += s.size;
        return { abs: r, size: s.size };
      });
      if (total > lim.maxBytes) throw new Error(`Total berkas terlalu besar (${fmtSize(total)}, maks ${fmtSize(lim.maxBytes)}).`);
      srcs.forEach((s, i) => {
        const first = safeName(path.basename(s.abs)) || `berkas-${i + 1}`, ext = path.extname(first);
        let name = first;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${first.slice(0, first.length - ext.length)}-${n}${ext}`;
        used.add(name.toLowerCase());
        fs.copyFileSync(s.abs, path.join(stage, 'files', name));
        files.push({ id: `f${i + 1}`, name: path.basename(s.abs), rel: name, mime: mimeOf(name), size: s.size, kind: kindOf(name), status: 'menunggu' });
      });
    }
    fs.renameSync(stage, dir);
  } catch (e) { fs.rmSync(stage, { recursive: true, force: true }); throw e; }

  const data = { title, note: String(a.catatan || '').trim().slice(0, 2000), mode, jenis, card, sid: sid || null, by: by || 'Agen', files, size: total };
  const version = parent ? parent.version + 1 : 1;
  run(db(office), 'INSERT INTO pratinjau (id, root_id, parent_id, version, status, from_role, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, parent ? parent.root_id : id, parent?.id || null, version, 'baru', role?.id || null, JSON.stringify(data), nowIso());
  logOffice(office, by || 'Agen', `mengirim pratinjau "${clip(title, 60)}"${version > 1 ? ` (v${version})` : ''}`, 'pratinjau');
  usageDirty(office);
  const item = emit(office, id);
  if (conf().autoMedia !== false) prepareMedia(office, id); // thumbnails + playable video, in the background
  bus.emit('notify', { kind: 'pratinjau', office, sid: sid || null, id, who: by || 'Agen', text: `${title}${version > 1 ? ` (v${version})` : ''} — ${files.length} ${mode === 'bundle' ? 'halaman' : 'berkas'}`, dedupe: id });
  return item;
}

/** What an agent sees from pratinjau_status. */
export function statusFor(office, id) {
  const it = getItem(office, id);
  return {
    id: it.id, judul: it.title, versi: it.version, jenis: it.jenis, status: it.status, mode: it.mode, dipilih: it.picked ? it.files.find(f => f.id === it.picked)?.name : undefined,
    catatan_pemilik: it.ownerNote || undefined,
    berkas: it.files.map(f => ({ id: f.id, nama: f.name, status: f.status, catatan: f.note || undefined })),
    dilihat: it.seenAt || undefined,
    reaksi: Object.keys(it.reactions).length ? Object.entries(it.reactions).map(([emoji, at]) => ({ emoji, at })) : undefined,
    komentar: it.comments.length ? it.comments.map(c => ({ teks: c.text, berkas: c.file ? it.files.find(f => f.id === c.file)?.name || c.file : undefined, detik: c.t ?? undefined, waktu: c.t != null ? fmtT(c.t) : undefined, at: c.at })) : undefined,
    disimpan: it.pinned || undefined, arsip: it.archived || undefined, ditunda_sampai: it.snoozed ? it.snoozedUntil : undefined,
    versi_lain: it.versions.map(v => `v${v.version} ${v.id} (${v.status})`),
    petunjuk: it.status === 'revisi' || it.status === 'sebagian' ? `Perbaiki lalu kirim versi baru dengan pratinjau_kirim(revisiDari="${it.id}").` : undefined,
  };
}

/* ---------------- decisions (owner) ---------------- */

const pending = new Map(); // item key -> { timer, lines:Map(fileId -> text) } for per-file decisions, sent as one DM
async function tell(office, id, text) {
  const r = rowOf(office, id); if (!r) return null;
  const d = j(r.data, {});
  const msg = clip(`[Pratinjau] ${text}`, 3800);
  try {
    if (r.from_role && st.getRole(office, r.from_role)) return await dm.fromOwner(office, r.from_role, msg, { card: d.card || null });
    if (d.sid && live.get(d.sid)) { await sessionAction(d.sid, 'text', msg); return { pengiriman: 'diketik ke sesi' }; }
  } catch (e) { console.error(`pratinjau: pesan ke pengirim gagal: ${e.message}`); }
  return null;
}
const head = (d, r) => `"${d.title}" (v${r.version}, id ${r.id})`;
const followUp = r => `Diskusi lewat pesan (balas), bukan wiki. Revisi: kirim versi baru dengan pratinjau_kirim(revisiDari="${r.id}"). Detail: pratinjau_status(id="${r.id}").`;

/** Send the per-file decisions collected for an item (now). Returns the promise of the DM, or null. */
export function flushDecisions(office, id) {
  const keys = office ? [`${office}:${id}`] : [...pending.keys()];
  return Promise.all(keys.map(k => {
    const p = pending.get(k); if (!p) return null;
    clearTimeout(p.timer); pending.delete(k);
    const r = rowOf(p.office, p.id); if (!r) return null;
    const d = j(r.data, {});
    const lines = [...p.lines.values()].join('\n');
    return tell(p.office, p.id, `Pemilik menilai berkas ${head(d, r)}:\n${lines}\nStatus sekarang: ${r.status}. ${followUp(r)}`);
  }));
}

function fileRef(d, ref) {
  const f = (d.files || []).find(x => x.id === ref) || (d.files || []).find(x => x.name === ref || x.rel === ref);
  if (!f) throw err(404, `Berkas ${ref} tidak ada di pratinjau ini`);
  return f;
}

export async function decideFile(office, id, fid, { status, catatan } = {}) {
  if (!['oke', 'revisi', 'menunggu'].includes(status)) throw new Error("status harus 'oke' atau 'revisi'");
  const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan');
  const d = j(r.data, {});
  const f = fileRef(d, fid);
  f.status = status; f.note = String(catatan || '').trim().slice(0, 1000) || null;
  d.seenAt ||= nowIso();
  if (status === 'oke' && d.revisiAll && d.files.every(x => x.status === 'oke')) d.revisiAll = false;
  const item = save(office, r, d);
  if (status === 'oke' && d.files.every(x => x.status === 'oke')) followCard(office, d, r, 'setuju', null);
  if (status !== 'menunggu') {
    const k = `${office}:${id}`;
    const p = pending.get(k) || { office, id, lines: new Map() };
    p.lines.set(f.id, `- ${f.name}: ${status === 'oke' ? 'oke' : 'perlu revisi'}${f.note ? ` — ${f.note}` : ''}`);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flushDecisions(office, id).catch(() => {}), conf().batchSec * 1000);
    p.timer.unref?.();
    pending.set(k, p);
    // every file decided: no reason to wait
    if (d.files.every(x => x.status !== 'menunggu')) await flushDecisions(office, id);
  }
  return item;
}

/**
 * Pratinjau yang terkait kartu ikut menggerakkan kartunya. Disetujui semua: kartu di kolom berjenis review pindah ke kolom 'selesai' pertama.
 * Revisi: kartu pindah ke kolom bernama "Revisi" kalau ada, kalau tidak ke kolom 'dikerjakan' pertama, plus komentar berisi catatan.
 */
export function followCard(office, d, r, outcome, note) {
  if (!d.card) return null;
  try {
    const c = st.getCard(office, d.card);
    const b = getBoard(office, c.board);
    const who = 'Pemilik (pratinjau)';
    let to;
    if (outcome === 'setuju') { if (c.colKind === 'review') to = firstOfKind(b, 'selesai'); }
    else {
      const rv = b.columns.findIndex(x => x.name.toLowerCase() === 'revisi');
      to = rv >= 0 ? rv : firstOfKind(b, 'dikerjakan');
    }
    if (to !== null && to !== undefined && to !== c.col) st.updateCard(office, c.id, { col: to }, who);
    const text = outcome === 'setuju' ? `Pratinjau "${d.title}" v${r.version} disetujui pemilik.${note ? ` Catatan: ${note}` : ''}` : `Pratinjau "${d.title}" v${r.version} perlu revisi: ${note}`;
    st.commentCard(office, c.id, text, who);
    return st.getCard(office, c.id);
  } catch (e) { console.error(`pratinjau: kartu ${d.card} tidak bisa diperbarui: ${e.message}`); return null; }
}

export async function approveAll(office, id, { catatan } = {}) {
  const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan');
  const d = j(r.data, {});
  for (const f of d.files) if (f.status !== 'oke') { f.status = 'oke'; }
  d.revisiAll = false; d.seenAt ||= nowIso();
  d.ownerNote = String(catatan || '').trim().slice(0, 2000) || null;
  pending.delete(`${office}:${id}`);
  const item = save(office, r, d);
  followCard(office, d, r, 'setuju', d.ownerNote);
  await tell(office, id, `Pemilik MENYETUJUI semua berkas ${head(d, r)}.${d.ownerNote ? ` Catatan: ${d.ownerNote}` : ''} Lanjutkan pekerjaanmu.`);
  return item;
}

export async function requestRevision(office, id, { catatan } = {}) {
  const note = String(catatan || '').trim().slice(0, 2000);
  if (!note) throw new Error('Tulis catatan revisi: apa yang perlu diubah.');
  const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan');
  const d = j(r.data, {});
  d.revisiAll = true; d.ownerNote = note; d.seenAt ||= nowIso();
  const fileLines = d.files.filter(f => f.status === 'revisi' || f.note).map(f => `- ${f.name}: ${f.status}${f.note ? ` — ${f.note}` : ''}`);
  pending.delete(`${office}:${id}`);
  const item = save(office, r, d);
  followCard(office, d, r, 'revisi', note);
  await tell(office, id, `Pemilik minta REVISI untuk ${head(d, r)}: ${note}${fileLines.length ? `\nPer berkas:\n${fileLines.join('\n')}` : ''}\n${followUp(r)}`);
  return item;
}

export async function pick(office, id, { file, catatan } = {}) {
  const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan');
  const d = j(r.data, {});
  if (d.mode !== 'pilihan' && jenisOf(d) !== 'pilihan') throw new Error('Memilih satu hanya untuk pratinjau jenis pilihan.');
  const f = fileRef(d, file);
  d.picked = f.id; d.revisiAll = false; d.seenAt ||= nowIso();
  for (const x of d.files) { x.status = x.id === f.id ? 'oke' : x.status === 'oke' ? 'menunggu' : x.status; }
  d.ownerNote = String(catatan || '').trim().slice(0, 2000) || null;
  pending.delete(`${office}:${id}`);
  const item = save(office, r, d);
  // a pick never moves the card: just a comment on it
  if (d.card) { try { st.commentCard(office, d.card, `Pratinjau "${d.title}" v${r.version}: pemilik memilih ${f.name}.${d.ownerNote ? ` Catatan: ${d.ownerNote}` : ''}`, 'Pemilik (pratinjau)'); } catch (e) { console.error(`pratinjau: komentar kartu gagal: ${e.message}`); } }
  await tell(office, id, `Pemilik MEMILIH "${f.name}" (${f.id}) dari ${head(d, r)}.${d.ownerNote ? ` Catatan: ${d.ownerNote}` : ''} Lanjutkan dengan pilihan itu.`);
  return item;
}

/* ---------------- neutral actions (owner): comment wakes the agent; seen / reactions / pin / snooze / archive do not ---------------- */

function load(office, id) { const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan'); return [r, j(r.data, {})]; }

/** 💬 Komentar: a note to the agent (DM that wakes it), no decision. Optional file and video time `t` (seconds). */
export async function comment(office, id, { teks, file, t } = {}) {
  const text = String(teks || '').trim().slice(0, 2000);
  if (!text) throw new Error('Tulis komentarnya dulu.');
  const [r, d] = load(office, id);
  const f = file ? fileRef(d, file) : null;
  const sec = t === undefined || t === null || t === '' ? null : Math.max(0, Math.round(Number(t) * 10) / 10);
  if (sec !== null && !Number.isFinite(sec)) throw new Error('t harus angka detik');
  const c = { id: newId('k'), text, file: f?.id || null, t: sec, at: nowIso() };
  (d.comments ||= []).push(c); d.seenAt ||= c.at;
  if (d.comments.length > 300) d.comments = d.comments.slice(-300);
  const item = save(office, r, d);
  const where = `${f ? ` · ${f.name}` : ''}${sec !== null ? ` @${fmtT(sec)}` : ''}`;
  await tell(office, id, `Pemilik berkomentar di ${head(d, r)}${where}: ${text}\n(Ini komentar, bukan keputusan. ${followUp(r)})`);
  return item;
}
/** 👀 Sudah lihat: marks seen. No DM; the agent can read it via pratinjau_status. */
export function markSeen(office, id) {
  const [r, d] = load(office, id);
  if (d.seenAt) return view(office, r);
  d.seenAt = nowIso();
  return save(office, r, d);
}
/** Quick emoji reaction (toggle). Stored only; no DM. */
export function react(office, id, { emoji } = {}) {
  if (!REACTIONS.includes(emoji)) throw new Error(`Reaksi harus salah satu: ${REACTIONS.join(' ')}`);
  const [r, d] = load(office, id);
  d.reactions ||= {};
  if (d.reactions[emoji]) delete d.reactions[emoji]; else d.reactions[emoji] = nowIso();
  d.seenAt ||= nowIso();
  return save(office, r, d);
}
/** 📌 Simpan / 🗂 Arsipkan / ⏸ Nanti dulu: flags, no DM. */
export function setFlags(office, id, { pinned, archived, snoozedUntil } = {}) {
  const [r, d] = load(office, id);
  if (pinned !== undefined) d.pinned = !!pinned;
  if (archived !== undefined) { d.archived = !!archived; if (d.archived) d.seenAt ||= nowIso(); } // archiving counts as having looked
  if (snoozedUntil !== undefined) {
    if (!snoozedUntil) d.snoozedUntil = null;
    else { const t = new Date(snoozedUntil); if (isNaN(t)) throw new Error('Waktu "nanti dulu" tidak valid'); d.snoozedUntil = t.toISOString(); }
  }
  return save(office, r, d);
}

/* ---------------- storage usage (no cleanup yet: just the number) ---------------- */

const usageCache = new Map();
export function usageDirty(office) { usageCache.delete(office); }
function duSync(dir) {
  let bytes = 0, files = 0;
  const go = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++; } catch {} } } };
  go(dir);
  return { bytes, files };
}
/** GET /api/offices/:id/pratinjau/usage -> {bytes, items, files}. Cached; recomputed after a send or a media job. */
export function usage(office) {
  let u = usageCache.get(office);
  if (!u) {
    const { bytes, files } = duSync(path.join(OFFICE_DIR, office, 'pratinjau'));
    u = { bytes, items: one(db(office), 'SELECT COUNT(*) n FROM pratinjau').n, files };
    usageCache.set(office, u);
  }
  return u;
}

/* ---------------- storage cleanup: files of finished, old items (thumbnails kept; the item stays with filesPurged) ---------------- */

export const cleanupDays = () => { const v = Number(config().pratinjau?.cleanupDays); return Number.isFinite(v) && v >= 0 ? v : 30; };
/**
 * May this item's files be cleaned? Finished = disetujui / dipilih / archived, or an info item seen or commented.
 * Never: baru / revisi / sebagian, pinned, snoozed, turned into wiki, already purged. Age since the latest of decided / last activity / created.
 */
export function cleanable(r, d, days, now = Date.now()) {
  if (d.filesPurged || d.pinned || d.wiki) return false;
  if (d.snoozedUntil && Date.parse(d.snoozedUntil) > now) return false;
  if (['baru', 'menunggu', 'revisi', 'sebagian'].includes(r.status)) return false;
  const done = ['disetujui', 'dipilih'].includes(r.status) || d.archived || (jenisOf(d) === 'info' && ['dilihat', 'dikomentari'].includes(r.status));
  if (!done) return false;
  const last = Math.max(...[r.decided_at, d.lastAt, r.created_at].map(x => Date.parse(x) || 0));
  return now - last >= days * 86400e3;
}
/** Clean one office (or all). {dryRun, days, office} -> {days, dryRun, bytes, items:[{office,id,title,bytes}]}. */
export function cleanup({ dryRun = false, days = null, office = null } = {}) {
  const n = days === null || days === undefined || days === '' ? cleanupDays() : Math.max(0, Number(days));
  const out = { days: n, dryRun: !!dryRun, bytes: 0, items: [] };
  if (!n && (days === null || days === undefined || days === '')) return { ...out, off: true }; // 0 = off for the automatic job
  const offices = office ? [office] : listOffices().map(o => o.id);
  for (const o of offices) {
    let rows; try { rows = all(db(o), 'SELECT * FROM pratinjau'); } catch { continue; }
    const freed = [];
    for (const r of rows) {
      const d = j(r.data, {});
      if (!cleanable(r, d, n)) continue;
      const dirs = [filesDir(o, r.id), path.join(itemDir(o, r.id), 'putar')];
      const bytes = dirs.reduce((a, x) => a + duSync(x).bytes, 0);
      freed.push({ office: o, id: r.id, title: d.title, bytes });
      if (dryRun) continue;
      for (const x of dirs) fs.rmSync(x, { recursive: true, force: true });
      d.filesPurged = true; d.purgedAt = nowIso();
      for (const f of d.files || []) if (f.putar) f.putar = null;
      run(db(o), 'UPDATE pratinjau SET data = ? WHERE id = ?', JSON.stringify(d), r.id);
      emit(o, r.id);
    }
    if (freed.length && !dryRun) {
      usageDirty(o);
      logOffice(o, 'Kantor', `membersihkan berkas ${freed.length} pratinjau lama (${fmtSize(freed.reduce((a, x) => a + x.bytes, 0))})`, 'pratinjau');
    }
    out.items.push(...freed);
  }
  out.bytes = out.items.reduce((a, x) => a + x.bytes, 0);
  return out;
}
/** Settings: {cleanupDays} read / write, plus usage per office. */
export function storageSettings(b = null) {
  if (b && b.cleanupDays !== undefined) {
    const v = Math.max(0, Math.min(3650, Math.round(Number(b.cleanupDays))));
    if (!Number.isFinite(v)) throw new Error('cleanupDays harus angka hari (0 = mati)');
    const cfg = config(); cfg.pratinjau = { ...(cfg.pratinjau || {}), cleanupDays: v }; saveConfig(cfg);
  }
  return { cleanupDays: cleanupDays(), offices: listOffices().map(o => ({ id: o.id, name: o.name, ...(() => { try { return usage(o.id); } catch { return { bytes: 0, items: 0, files: 0 }; } })() })) };
}
let cleanTimer = null;
/** Daily job, first run a few minutes after startup. */
export function startCleanup() {
  if (cleanTimer) return;
  const tick = () => { try { const r = cleanup({}); if (r.items?.length) console.log(`pratinjau: ${r.items.length} item dibersihkan (${fmtSize(r.bytes)})`); } catch (e) { console.error(`pratinjau: pembersihan gagal: ${e.message}`); } };
  setTimeout(tick, 5 * 60e3).unref?.();
  cleanTimer = setInterval(tick, 24 * 3600e3); cleanTimer.unref?.();
}

/* ---------------- media jobs: thumbnails for every kind, playable mp4 for video ---------------- */

/** Command runners; tests swap these. has(name) -> path or null; run(cmd, args, opts) -> {stdout}. */
const binCache = {};
export const tools = {
  has(name) {
    if (binCache[name] !== undefined) return binCache[name];
    const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
    return (binCache[name] = dirs.map(d => path.join(d, name)).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null);
  },
  run: (cmd, args, opts = {}) => execFileP(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...opts }),
};
const THUMB = 480;
const lowPrio = (cmd, args) => { const nice = tools.has('nice'); return nice ? [nice, ['-n', '15', cmd, ...args]] : [cmd, args]; };
let queue = Promise.resolve();
/** One job at a time (thumbnails and transcodes), so a big video never starves the machine. */
export const enqueue = fn => (queue = queue.then(fn, fn).catch(e => console.error(`pratinjau: media: ${e.message}`)));

async function probeVideo(src) {
  const ffprobe = tools.has('ffprobe'); if (!ffprobe) return null;
  try {
    const { stdout } = await tools.run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height:format=duration', '-of', 'json', src], { timeout: 20000 });
    const o = JSON.parse(stdout);
    const v = (o.streams || []).find(x => x.codec_type === 'video'), a = (o.streams || []).find(x => x.codec_type === 'audio');
    return { video: v?.codec_name || null, audio: a?.codec_name || null, height: Number(v?.height) || 0, duration: Number(o.format?.duration) || 0 };
  } catch { return null; }
}
/** Needs an H.264/AAC rendition? .mov always (Safari-only codecs, Android players), else anything not h264 (+aac or silent). */
export const needsPutar = (name, p) => extOf(name) === 'mov' || !p || p.video !== 'h264' || (p.audio && p.audio !== 'aac');

/**
 * Thumbnail fallback chain -> 'jpg' | 'png' | null (null = show the kind icon).
 * video: ffmpeg frame at ~1s (10% for short clips); image: ffmpeg then sips; html/pdf/doc/other: QuickLook (qlmanage), then sips for pdf.
 */
export async function makeThumb(src, outBase, kind, info = null) {
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const jpg = `${outBase}.jpg`, tmp = `${outBase}.tmp.jpg`;
  const ok = f => { try { return fs.statSync(f).size > 0; } catch { return false; } };
  const ff = tools.has('ffmpeg'), sips = tools.has('sips'), ql = tools.has('qlmanage');
  const tryRun = async (cmd, args, timeout = 30000) => { try { const [c, a] = lowPrio(cmd, args); await tools.run(c, a, { timeout }); return true; } catch { return false; } };
  if (kind === 'video' && ff) {
    const dur = info?.duration || 0, at = dur ? Math.min(1, dur * 0.1) : 1;
    for (const ss of [at, 0]) if (await tryRun(ff, ['-v', 'error', '-y', '-ss', String(ss), '-i', src, '-frames:v', '1', '-vf', `scale='min(${THUMB},iw)':-2`, '-q:v', '5', tmp]) && ok(tmp)) { fs.renameSync(tmp, jpg); return 'jpg'; }
  }
  if (kind === 'image') {
    if (ff && await tryRun(ff, ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${THUMB},iw)':-2`, '-q:v', '5', tmp]) && ok(tmp)) { fs.renameSync(tmp, jpg); return 'jpg'; }
    if (sips && await tryRun(sips, ['-Z', String(THUMB), '-s', 'format', 'jpeg', src, '--out', tmp]) && ok(tmp)) { fs.renameSync(tmp, jpg); return 'jpg'; }
  }
  if (kind !== 'video' && kind !== 'image' && ql) {
    const qdir = `${outBase}.ql`;
    fs.rmSync(qdir, { recursive: true, force: true }); fs.mkdirSync(qdir, { recursive: true });
    if (await tryRun(ql, ['-t', '-s', String(THUMB), '-o', qdir, src], 30000)) {
      const png = fs.readdirSync(qdir).find(n => n.endsWith('.png'));
      if (png && ok(path.join(qdir, png))) {
        const from = path.join(qdir, png);
        if (sips && await tryRun(sips, ['-s', 'format', 'jpeg', from, '--out', tmp]) && ok(tmp)) { fs.renameSync(tmp, jpg); fs.rmSync(qdir, { recursive: true, force: true }); return 'jpg'; }
        fs.renameSync(from, `${outBase}.png`); fs.rmSync(qdir, { recursive: true, force: true }); return 'png';
      }
    }
    fs.rmSync(qdir, { recursive: true, force: true });
  }
  if (kind === 'pdf' && sips && await tryRun(sips, ['-Z', String(THUMB), '-s', 'format', 'jpeg', src, '--out', tmp]) && ok(tmp)) { fs.renameSync(tmp, jpg); return 'jpg'; }
  fs.rmSync(tmp, { force: true });
  return null;
}

async function transcode(src, out, p) {
  const ff = tools.has('ffmpeg'); if (!ff) return false;
  const tmp = `${out}.tmp.mp4`;
  const scale = p?.height > 1080 ? ['-vf', 'scale=-2:1080'] : ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
  try {
    const [c, a] = lowPrio(ff, ['-v', 'error', '-y', '-i', src, ...scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
    await tools.run(c, a, { timeout: (conf().transcodeSec || 1200) * 1000 });
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) throw new Error('hasil kosong');
    fs.renameSync(tmp, out); return true;
  } catch (e) { fs.rmSync(tmp, { force: true }); console.error(`pratinjau: transcode gagal: ${clip(e.stderr || e.message, 200)}`); return false; }
}

function patchFile(office, id, fid, patch) {
  const r = rowOf(office, id); if (!r) return;
  const d = j(r.data, {}); const f = (d.files || []).find(x => x.id === fid); if (!f) return;
  Object.assign(f, patch);
  run(db(office), 'UPDATE pratinjau SET data = ? WHERE id = ?', JSON.stringify(d), id);
  usageDirty(office);
  emit(office, id);
}

/** Queue thumbnails (all kinds) and, for videos that need it, an H.264/AAC "putar" rendition. Never blocks the send. Returns the queue promise. */
export function prepareMedia(office, id) {
  const r = rowOf(office, id); if (!r) return Promise.resolve();
  const d = j(r.data, {});
  const base = filesDir(office, id), tdir = path.join(itemDir(office, id), 'thumbs'), pdir = path.join(itemDir(office, id), 'putar');
  let last = queue;
  for (const f0 of d.files || []) {
    const src = path.join(base, f0.rel);
    last = enqueue(async () => {
      const info = f0.kind === 'video' ? await probeVideo(src) : null;
      const got = await makeThumb(src, path.join(tdir, f0.id), f0.kind, info).catch(() => null);
      const patch = { thumb: got ? 'siap' : 'gagal' };
      if (f0.kind === 'video' && tools.has('ffmpeg') && needsPutar(f0.name, info)) patch.putar = 'menyiapkan';
      patchFile(office, id, f0.id, patch);
      if (patch.putar) {
        enqueue(async () => {
          fs.mkdirSync(pdir, { recursive: true });
          const ok = await transcode(src, path.join(pdir, `${f0.id}.mp4`), info);
          patchFile(office, id, f0.id, { putar: ok ? 'siap' : 'gagal' });
        });
      }
    });
  }
  return last.then(() => queue);
}

/** A wiki page that embeds the snapshot (files copied into the office media store, so the page outlives the item). */
export async function toWiki(office, id, { judul } = {}, by = actorName()) {
  const r = rowOf(office, id); if (!r) throw err(404, 'Pratinjau tidak ditemukan');
  const d = j(r.data, {});
  const title = clip(judul || `Pratinjau: ${d.title}`, 140);
  const it = view(office, r);
  const parts = [`> Pratinjau v${r.version} dari ${it.fromName} · ${new Date(r.created_at).toLocaleDateString('id-ID')} · status: ${r.status}`];
  if (d.note) parts.push('', d.note);
  if (d.ownerNote) parts.push('', `**Catatan pemilik:** ${d.ownerNote}`);
  if (d.mode === 'bundle') {
    parts.push('', '## Halaman', ...it.files.map(f => `- [${f.name}](${f.url})`));
  } else {
    for (const f of d.files) {
      const m = await saveFromFile(office, path.join(filesDir(office, id), f.rel), by, f.name);
      parts.push('', `### ${f.name}${d.picked === f.id ? ' (dipilih)' : ''}`, mediaMarkdown(m), ...(f.note ? ['', `_${f.status}: ${f.note}_`] : []));
    }
  }
  const page = st.saveWiki(office, { title, body: parts.join('\n'), msg: `Dari pratinjau ${id}` }, by);
  d.wiki = page.slug;
  run(db(office), 'UPDATE pratinjau SET data = ? WHERE id = ?', JSON.stringify(d), id);
  emit(office, id);
  return { slug: page.slug, title: page.title };
}

/* ---------------- serving ---------------- */

const CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups';
/** GET/HEAD /pv/<office>/<id>/<key>/<path> (files) and /pvt/<office>/<id>/<key>/<fid>.jpg (thumbnails). No cookie: the key is the permission. */
export async function serve(req, res, pathname) {
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }); res.end(msg); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Metode tidak didukung');
  const m = /^\/(pvt?)\/([^/]+)\/(p[0-9a-f]{10})\/([0-9a-f]{24})(\/.*)?$/.exec(pathname);
  if (!m) return fail(404, 'Tidak ditemukan');
  let office, rest;
  try { office = decodeURIComponent(m[2]); rest = (m[5] || '/').split('/').map(decodeURIComponent).join('/'); } catch { return fail(400, 'Path tidak valid'); }
  if (!/^[a-z0-9_-]+$/i.test(office) || !okKey(office, m[3], m[4])) return fail(404, 'Tidak ditemukan');
  const r = (() => { try { return rowOf(office, m[3]); } catch { return null; } })();
  if (!r) return fail(404, 'Pratinjau tidak ditemukan');
  const base = filesDir(office, r.id);
  const send = (file, mime, cache) => {
    const size = fs.statSync(file).size, rg = parseRange(req.headers.range, size);
    const h = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (rg === false) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(rg ? 206 : 200, { ...h, 'Content-Length': rg ? rg.end - rg.start + 1 : size, ...(rg ? { 'Content-Range': `bytes ${rg.start}-${rg.end}/${size}` } : {}) });
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(file, rg || {});
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  };
  if (m[1] === 'pvt') {
    const files = j(r.data, {}).files || [];
    const pm = files.find(x => `/${x.id}.mp4` === rest);
    if (pm) { const out = path.join(itemDir(office, r.id), 'putar', `${pm.id}.mp4`); return fs.existsSync(out) ? send(out, 'video/mp4', 'private, max-age=31536000, immutable') : fail(404, 'Video sedang disiapkan'); }
    const f = files.find(x => `/${x.id}.jpg` === rest);
    if (!f) return fail(404, 'Tidak ada gambar kecil');
    for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png']]) {
      const made = path.join(itemDir(office, r.id), 'thumbs', `${f.id}.${ext}`);
      if (fs.existsSync(made)) return send(made, mime, 'private, max-age=86400');
    }
    if (f.kind !== 'image' && f.kind !== 'video') return fail(404, 'Tidak ada gambar kecil');
    try {
      const out = path.join(itemDir(office, r.id), 'thumbs', `${f.id}.jpg`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await thumbFile(path.join(base, f.rel), out, f.kind, f.kind === 'video' ? 1 : 0);
      return send(out, 'image/jpeg', 'private, max-age=86400');
    } catch { return fail(404, 'Gambar kecil tidak bisa dibuat'); }
  }
  let file = path.resolve(base, '.' + rest);
  if (file !== base && !file.startsWith(base + path.sep)) return fail(403, 'Di luar pratinjau');
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const rp = fs.realpathSync(file);
    if (!rp.startsWith(real(base) + path.sep)) return fail(403, 'Di luar pratinjau');
    if (!fs.statSync(rp).isFile()) return fail(404, 'Tidak ditemukan');
    return send(rp, mimeOf(rp), 'private, max-age=31536000, immutable');
  } catch { return fail(404, 'Tidak ditemukan'); }
}

/* ---------------- MCP tools ---------------- */

export const PRATINJAU_TOOLS = [
  { name: 'pratinjau_kirim', description: 'Kirim hasil kerja untuk DIPRATINJAU pemilik di tab Pratinjau web, chat sesi, dan app Ghina; pemilik mendapat notifikasi. Pakai ini kalau pemilik minta "pratinjau", "preview", "lihat dulu", "kirim desainnya", atau saat hasil visual (gambar/mockup, PDF, video, halaman HTML, situs statis hasil build) perlu dilihat. '
    + 'jenis: info (bawaan; cukup dilihat, pemilik bisa menandai "Sudah lihat" atau berkomentar), persetujuan (HANYA bila kamu benar-benar butuh keputusan Setujui/Revisi sebelum lanjut; menggerakkan kartu terkait), pilihan (2+ alternatif, pemilik memilih satu; bawaan untuk mode pilihan). Jangan pakai persetujuan untuk sekadar laporan. '
    + 'Komentar pemilik datang sebagai pesan langsung (bisa per berkas, dan untuk video bertanda waktu "@0:12"); tanda "Sudah lihat" dan reaksi emoji TIDAK dikirim sebagai pesan, cek lewat pratinjau_status. '
    + 'files = daftar path berkas (relatif terhadap folder kerjamu, harus di dalam folder kantor; maks 30 berkas / 200 MB). folder = folder hasil build (atau .zip) berisi index.html: dilayani sebagai situs mini dalam sandbox, link/CSS/gambar relatif tetap jalan. '
    + 'mode: set (bawaan, beberapa berkas dinilai satu per satu), pilihan (2+ alternatif, pemilik memilih satu), bundle (otomatis untuk folder). revisiDari = id pratinjau sebelumnya bila ini versi perbaikan (jadi v2, v3, ...). '
    + 'Berkas disalin saat dikirim (snapshot), jadi ubahan setelahnya tidak ikut: kirim versi baru. Keputusan pemilik datang sebagai pesan langsung ke kamu. Diskusi dan tanya-jawab lewat pesan (balas/pesan_ke) atau komentar kartu, BUKAN wiki; wiki hanya untuk hasil akhir.',
    inputSchema: { type: 'object', properties: {
      judul: { type: 'string', description: 'judul singkat, mis. "Desain checkout"' },
      files: { type: 'array', items: { type: 'string' }, description: 'path berkas' },
      folder: { type: 'string', description: 'folder situs statis atau berkas .zip (mode bundle)' },
      mode: { type: 'string', enum: MODES, description: 'tata letak berkas: set / pilihan / bundle' },
      jenis: { type: 'string', enum: JENIS, description: 'info (bawaan) | persetujuan (butuh keputusan) | pilihan (pilih satu)' },
      catatan: { type: 'string', description: 'apa yang perlu dilihat / diputuskan pemilik' },
      kartu: { type: 'string', description: 'id kartu terkait (opsional)' },
      revisiDari: { type: 'string', description: 'id pratinjau versi sebelumnya' } }, required: ['judul'] } },
  { name: 'pratinjau_status', description: 'Status satu pratinjau yang kamu kirim: jenis, status (baru/dilihat/dikomentari/sebagian/disetujui/revisi/dipilih), kapan dilihat, reaksi emoji dan komentar pemilik (dengan waktu, berkas, dan detik video), keputusan per berkas, pilihan, dan daftar versinya.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
export const PRATINJAU_NAMES = new Set(PRATINJAU_TOOLS.map(t => t.name));
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export async function callPratinjau(ident, name, a = {}) {
  if (name === 'pratinjau_kirim') {
    const it = await sendItem(ident, a);
    return text({ id: it.id, versi: it.version, jenis: it.jenis, mode: it.mode, berkas: it.files.map(f => `${f.id} ${f.name} (${f.kind})`), status: it.status,
      pesan: `Pratinjau terkirim ke pemilik. ${it.jenis === 'info' ? 'Komentar pemilik (kalau ada) datang sebagai pesan langsung; tidak perlu menunggu.' : 'Keputusannya datang sebagai pesan langsung.'} Cek kapan saja dengan pratinjau_status(id="${it.id}").` });
  }
  if (name === 'pratinjau_status') {
    if (!a.id) throw new Error('Isi `id` pratinjau (dari hasil pratinjau_kirim).');
    return text(statusFor(ident.office, String(a.id).replace(/^#/, '')));
  }
  throw new Error(`Tool tidak dikenal: ${name}`);
}
