// Two-way attachments in an agent conversation.
//   owner -> agent: resumable chunked uploads (large videos from a phone), landing in <session folder>/.kantor/inbox/
//   agent -> owner: kirim_ke_pemilik / tangkap_layar, copied to <session folder>/.kantor/outbox/
// Both directions are rows in `attachments` (global DB) so the chat can list them. See docs/ATTACHMENTS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, config } from './config.js';
import { globalDb, all, one, run, nowIso, newId } from './db.js';
import { officeModel } from './offices.js';
import { live, bus } from './live.js';
import { sessionAction } from './tmux.js';

const execFileP = promisify(execFile);
const UPLOADS = path.join(DATA_DIR, 'uploads');
const THUMBS = path.join(UPLOADS, 'thumbs');
const MAX_PUT = 64 * 1024 * 1024; // one PUT request; bigger files arrive in several
const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const conf = () => ({ maxBytes: 4 * 1024 ** 3, chunkBytes: 4 * 1024 ** 2, staleHours: 48, ...(config().attachments || {}) });

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const extOf = name => path.extname(String(name || '')).slice(1).toLowerCase();
/** Type from the extension; the client's own mime only when the extension says nothing. */
const mimeOf = (name, hint) => TYPES[extOf(name)] || (/^[\w.+-]+\/[\w.+-]+$/.test(String(hint || '')) ? hint : 'application/octet-stream');
const kindOf = mime => /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file';
const INLINE = /^(image|video|audio)\/|^application\/pdf/;

const fmtSize = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
const fmtDur = s => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} menit ${s % 60} detik` : `${s} detik`; };
const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Filesystem-safe name: no separators or control chars, keeps letters/digits/dot/dash/underscore, keeps the extension. */
export function safeName(n) {
  let s = path.basename(String(n || '').replace(/\\/g, '/')).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/_{2,}/g, '_').replace(/^[._]+/, '');
  const ext = path.extname(s);
  if (s.length > 120) s = s.slice(0, 120 - ext.length) + ext;
  return s || 'file';
}
const stamp = (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) { const n = `${stem}-${i}${ext}`; if (!fs.existsSync(path.join(dir, n))) return n; }
  throw err(400, 'Terlalu banyak file dengan nama sama');
}

/* ---------------- where a session works ---------------- */

/** The session's office and working folder; falls back to the office folder when the working folder is gone. */
function sessionWhere(sid) {
  const s = live.get(sid);
  const row = one(globalDb(), 'SELECT office, cwd FROM sessions WHERE sid = ?', sid);
  const office = s?.office || row?.office;
  if (!office && !s && !row) throw err(404, 'Sesi tidak ditemukan');
  let base = s?.cwd || row?.cwd;
  if (!base || !fs.existsSync(base)) { try { base = officeModel(office).root; } catch { base = null; } }
  if (!base || !fs.existsSync(base)) throw err(404, 'Folder kerja sesi tidak ditemukan');
  return { office, base: fs.realpathSync(base) };
}

const gitDone = new Map();
/** Keep .kantor/ out of git without touching .gitignore: one line in .git/info/exclude. */
async function ensureExclude(dir) {
  if (gitDone.get(dir)) return;
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { timeout: 5000 });
    const f = stdout.trim();
    if (!f) return;
    let cur = '';
    try { cur = fs.readFileSync(f, 'utf8'); } catch {}
    if (!cur.split(/\r?\n/).some(l => ['.kantor/', '.kantor', '/.kantor/', '/.kantor'].includes(l.trim()))) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '.kantor/\n');
    }
    gitDone.set(dir, true);
  } catch { /* not a git repo, or no git */ }
}

/* ---------------- ffmpeg / ffprobe ---------------- */

const binCache = {};
function bin(name) {
  if (binCache[name] !== undefined) return binCache[name];
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return (binCache[name] = dirs.map(d => path.join(d, name)).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null);
}
async function probe(file) {
  const ffprobe = bin('ffprobe');
  if (!ffprobe) return null;
  try {
    const { stdout } = await execFileP(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000, maxBuffer: 8 * 1024 ** 2 });
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const dur = Number(j.format?.duration) || Number(v?.duration) || 0;
    return { duration: dur ? Math.round(dur * 10) / 10 : null, width: v?.width || null, height: v?.height || null, hasVideo: !!v, hasAudio: (j.streams || []).some(s => s.codec_type === 'audio') };
  } catch { return null; }
}
/** 1 frame per second, at most 60 (a longer video is sampled evenly to 60), jpg, width <= 1280. */
async function extractFrames(file, dir, duration) {
  const ffmpeg = bin('ffmpeg');
  if (!ffmpeg) return 0;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const fps = duration > 60 ? (60 / duration).toFixed(5) : '1';
  try {
    await execFileP(ffmpeg, ['-v', 'error', '-y', '-i', file, '-an', '-sn', '-vf', `fps=${fps},scale='min(1280,iw)':-2`, '-frames:v', '60', '-q:v', '4', path.join(dir, '%03d.jpg')], { timeout: 10 * 60e3 });
  } catch { /* partial output is still useful */ }
  return fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
}

/* ---------------- rows ---------------- */

const metaOf = r => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } };
function serialize(r) {
  const meta = metaOf(r), kind = kindOf(r.mime), base = meta.base;
  const rel = base && r.path.startsWith(base + path.sep) ? path.relative(base, r.path).split(path.sep).join('/') : r.path;
  return {
    id: r.id, sid: r.sid, office: r.office, dir: r.dir, name: r.name, path: rel, mime: r.mime, size: r.size, caption: r.caption || '', at: r.at, kind,
    duration: meta.duration ?? null, width: meta.width ?? null, height: meta.height ?? null,
    frames: meta.frames ? { dir: meta.frames.dir, count: meta.frames.count } : null,
    processing: !!meta.processing, delivered: r.dir === 'in' ? !!meta.delivered : null,
    url: `/api/attachments/${r.id}/raw`, thumb: kind === 'image' || kind === 'video' ? `/api/attachments/${r.id}/thumb` : null,
  };
}
const getRow = id => one(globalDb(), 'SELECT * FROM attachments WHERE id = ?', String(id));
function setMeta(id, patch) {
  const r = getRow(id);
  if (!r) return null;
  run(globalDb(), 'UPDATE attachments SET meta = ? WHERE id = ?', JSON.stringify({ ...metaOf(r), ...patch }), id);
  return getRow(id);
}
const emit = r => { const item = serialize(r); bus.emit('msg', { t: 'attachment', office: r.office, sid: r.sid, item }); return item; };

function insert({ sid, office, dir, file, name, mime, size, caption, meta }) {
  const id = newId('a');
  run(globalDb(), 'INSERT INTO attachments (id, sid, office, dir, path, name, mime, size, caption, at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, sid || null, office || null, dir, file, name, mime, size, clip(caption, 1000), nowIso(), JSON.stringify(meta || {}));
  return getRow(id);
}

/**
 * The session an agent's MCP server means today. The MCP process keeps the KANTOR_SID it was started with, but a Codex
 * shift gets its real id from Codex a moment later (and /clear or /resume give a new one), see live.js inheritShift.
 */
export function currentSid(sid) {
  if (!sid) return sid;
  const s = live.get(sid);
  if (s && s.status !== 'ended') return sid;
  const row = one(globalDb(), 'SELECT tmux FROM sessions WHERE sid = ?', sid);
  const now = row?.tmux && [...live.values()].find(x => x.tmux === row.tmux && x.status !== 'ended');
  return now?.sid || sid;
}
/** The session plus the ids it took over in the same pane and shift (same tmux and start), so older files still show. */
function sidFamily(sid) {
  const rows = all(globalDb(), `SELECT b.sid FROM sessions a JOIN sessions b ON b.tmux = a.tmux AND b.started_at = a.started_at WHERE a.sid = ? AND a.tmux IS NOT NULL`, sid);
  return [...new Set([sid, ...rows.map(r => r.sid)])];
}

export function listAttachments(sid, { limit = 200, after = '' } = {}) {
  const fam = sidFamily(sid);
  const rows = all(globalDb(), `SELECT * FROM attachments WHERE sid IN (${fam.map(() => '?').join(',')}) ${after ? 'AND at > ?' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`, ...[...fam, ...(after ? [after] : []), Math.min(500, Math.max(1, Number(limit) || 200))]);
  return { items: rows.reverse().map(serialize) };
}
export const getAttachment = id => { const r = getRow(id); return r ? serialize(r) : null; };

/* ---------------- owner -> agent: resumable uploads ---------------- */

const partPath = id => path.join(UPLOADS, `${id}.part`);
const metaPath = id => path.join(UPLOADS, `${id}.json`);
const okId = id => /^[a-f0-9]{16,32}$/.test(String(id));
function readUpload(id) {
  if (!okId(id)) throw err(404, 'Upload tidak ditemukan');
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { throw err(404, 'Upload tidak ditemukan atau sudah kedaluwarsa'); }
}
const writeUpload = m => fs.writeFileSync(metaPath(m.id), JSON.stringify(m), { mode: 0o600 });
const partSize = id => { try { return fs.statSync(partPath(id)).size; } catch { return 0; } };

export function createUpload(sid, b = {}) {
  const where = sessionWhere(sid); // fails early if the session or its folder is gone
  const c = conf();
  const name = String(b.name || '').trim();
  const size = Number(b.size);
  if (!name) throw err(400, 'Isi name');
  if (!Number.isInteger(size) || size <= 0) throw err(400, 'size harus bilangan bulat > 0');
  if (size > c.maxBytes) throw err(413, `File terlalu besar (maks ${fmtSize(c.maxBytes)})`);
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(12).toString('hex');
  const m = { id, sid, office: where.office, name: path.basename(name.replace(/\\/g, '/')), size, mime: mimeOf(name, b.mime), caption: clip(b.caption, 1000), createdAt: nowIso(), done: false };
  fs.writeFileSync(partPath(id), '', { mode: 0o600 });
  writeUpload(m);
  return { id, offset: 0, size, chunk: c.chunkBytes };
}

export function uploadInfo(id) {
  const m = readUpload(id);
  const offset = m.done ? m.size : partSize(id);
  return { id, offset, size: m.size, done: !!m.done, chunk: conf().chunkBytes, ...(m.attachment ? { attachment: serialize(getRow(m.attachment)) } : {}) };
}

const busy = new Set();
/** Append one chunk. The body must start at Upload-Offset, which has to match what is on disk (409 with the right offset otherwise). */
export async function appendUpload(id, req) {
  const m = readUpload(id);
  if (m.done) throw err(409, 'Upload sudah selesai', { offset: m.size });
  const cur = partSize(id);
  const hdr = req.headers['upload-offset'];
  const off = hdr === undefined ? 0 : Number(hdr);
  if (!Number.isInteger(off) || off < 0) throw err(400, 'Upload-Offset tidak valid');
  if (off !== cur) throw err(409, `Offset salah, lanjutkan dari ${cur}`, { offset: cur });
  if (busy.has(id)) throw err(409, 'Potongan lain untuk upload ini sedang berjalan', { offset: cur });
  const remaining = m.size - cur;
  const len = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
  if (len !== null && (len > remaining || len > MAX_PUT)) throw err(413, len > remaining ? 'Potongan melebihi ukuran file' : `Potongan terlalu besar (maks ${fmtSize(MAX_PUT)})`, { offset: cur });
  busy.add(id);
  try { const t = new Date(); fs.utimesSync(metaPath(id), t, t); } catch {} // keeps a slow upload from looking stale
  let n = 0;
  try {
    const count = new Transform({ transform(c, e, cb) { n += c.length; cb(n > remaining || n > MAX_PUT ? err(413, 'Potongan terlalu besar') : null, c); } });
    try { await pipeline(req, count, fs.createWriteStream(partPath(id), { flags: 'a' })); }
    catch (e) { if (e.code === 413) { try { fs.truncateSync(partPath(id), cur); } catch {} e.offset = cur; } throw e; } // a dropped connection keeps its bytes: the client resumes from HEAD
  } finally { busy.delete(id); }
  const offset = partSize(id);
  if (offset < m.size) return { offset, done: false };
  return { offset, done: true, attachment: await finalizeUpload(m) };
}

async function finalizeUpload(m) {
  const where = sessionWhere(m.sid);
  const inbox = path.join(where.base, '.kantor', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  await ensureExclude(where.base);
  const name = freeName(inbox, `${stamp()}-${safeName(m.name)}`);
  const dest = path.join(inbox, name);
  try { fs.renameSync(partPath(m.id), dest); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(partPath(m.id), dest); fs.unlinkSync(partPath(m.id)); }
  const kind = kindOf(m.mime);
  const row = insert({ sid: m.sid, office: where.office, dir: 'in', file: dest, name: m.name, mime: m.mime, size: m.size, caption: m.caption,
    meta: { base: where.base, processing: kind === 'video' || kind === 'audio' || m.mime === 'application/octet-stream' } });
  writeUpload({ ...m, done: true, attachment: row.id });
  const item = emit(row);
  processIncoming(row.id).catch(e => console.error(`lampiran ${row.id}: ${e.message}`));
  return item;
}

/** Probe, cut frames out of a video, then tell the session. Runs after the upload response was sent. */
async function processIncoming(id) {
  let r = getRow(id);
  const meta = metaOf(r), patch = { processing: false };
  try {
    let kind = kindOf(r.mime);
    const info = kind === 'video' || kind === 'audio' || r.mime === 'application/octet-stream' ? await probe(r.path) : null;
    if (info) {
      Object.assign(patch, { duration: info.duration, width: info.width, height: info.height });
      if (kind === 'file' && info.hasVideo && info.duration) kind = 'video'; // unknown extension, but it plays
    }
    if (kind === 'video') {
      const dir = path.join(path.dirname(r.path), `${path.basename(r.path, path.extname(r.path))}-frames`);
      const count = await extractFrames(r.path, dir, info?.duration || 0);
      if (count) patch.frames = { dir, count, everySec: info?.duration > 60 ? Math.round(info.duration / 60 * 10) / 10 : 1 };
    }
  } catch (e) { console.error(`lampiran ${id}: ${e.message}`); }
  r = setMeta(id, patch);
  const item = serialize(r);
  const text = describeIncoming(r, { ...meta, ...patch });
  let delivered = false;
  try { await sessionAction(r.sid, 'text', text); delivered = true; } catch { /* not typeable: the file stays in the inbox and the chat shows it */ }
  r = setMeta(id, { delivered, message: text });
  emit(r);
  return { item, delivered, text };
}

function describeIncoming(r, meta) {
  const it = serialize({ ...r, meta: JSON.stringify(meta) });
  const rel = it.path;
  const parts = [`Kamu menerima file dari pemilik: ${rel} (${fmtSize(r.size)}, ${r.mime}).`];
  if (it.kind === 'image') parts.push('Itu gambar; lihat dengan membaca file-nya.');
  if (it.frames) {
    const rf = path.relative(meta.base, it.frames.dir).split(path.sep).join('/');
    parts.push(`Frame ${meta.frames.everySec > 1 ? `tiap ${meta.frames.everySec} detik` : 'tiap detik'} ada di ${rf}/ (${it.frames.count} gambar${it.duration ? `, durasi ${fmtDur(it.duration)}` : ''}${it.width ? `, ${it.width}x${it.height}` : ''}).`);
  } else if (it.duration) parts.push(`Durasi ${fmtDur(it.duration)}${it.width ? `, ${it.width}x${it.height}` : ''}.`);
  if (r.caption) parts.push(`Pesan pemilik: ${r.caption}`);
  return parts.join(' ');
}

/* ---------------- agent -> owner ---------------- */

/** Where an agent may send files from: its working folder, the office folder, or temp. */
function sendRoots(base, office) {
  const roots = [base, os.tmpdir(), '/tmp', '/private/tmp', codexImagesDir()]; // Codex saves image generations under ~/.codex
  try { roots.push(officeModel(office).root); } catch {}
  return roots.map(p => { try { return fs.realpathSync(p); } catch { return p; } });
}
const dirOf = ident => {
  if (ident.sid) { try { return sessionWhere(ident.sid); } catch {} }
  let base = ident.cwd && fs.existsSync(ident.cwd) ? ident.cwd : null;
  if (!base) { try { base = officeModel(ident.office).root; } catch {} }
  if (!base || !fs.existsSync(base)) throw err(404, 'Folder kerja tidak ditemukan');
  return { office: ident.office, base: fs.realpathSync(base) };
};

export async function sendToOwner(ident, p, caption) {
  const { office, base } = dirOf(ident);
  const abs = path.resolve(base, String(p || ''));
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new Error(`Tidak ada file ${p}`); }
  if (!sendRoots(base, office).some(r => real === r || real.startsWith(r + path.sep))) throw new Error('File harus berada di folder kerja, folder kantor, atau folder sementara (/tmp)');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('Bukan file');
  if (!st.size) throw new Error('File kosong');
  if (st.size > conf().maxBytes) throw new Error(`File terlalu besar (maks ${fmtSize(conf().maxBytes)})`);
  const outbox = path.join(base, '.kantor', 'outbox');
  let file = real;
  if (path.dirname(real) !== outbox) {
    fs.mkdirSync(outbox, { recursive: true });
    await ensureExclude(base);
    file = path.join(outbox, freeName(outbox, `${stamp()}-${safeName(path.basename(real))}`));
    fs.copyFileSync(real, file);
  } else await ensureExclude(base);
  const mime = mimeOf(file);
  const info = kindOf(mime) === 'video' || kindOf(mime) === 'audio' ? await probe(file) : null;
  const row = insert({ sid: currentSid(ident.sid), office, dir: 'out', file, name: path.basename(real), mime, size: st.size, caption,
    meta: { base, ...(info ? { duration: info.duration, width: info.width, height: info.height } : {}) } });
  const item = emit(row);
  bus.emit('notify', { kind: 'file', sid: row.sid, office, who: ident.by || 'Sesi', text: `${item.name}${item.caption ? ` — ${item.caption}` : ''}`, dedupe: item.id });
  return item;
}

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)$/i;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Screenshot of the Mac screen or of a local page, saved into the outbox and sent to the owner. */
export async function captureScreen(ident, { target, url, caption } = {}) {
  const { base } = dirOf(ident);
  const outbox = path.join(base, '.kantor', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  await ensureExclude(base);
  const t = target || (url ? 'url' : 'layar');
  const file = path.join(outbox, `${stamp()}-${t === 'url' ? 'halaman' : 'layar'}-${crypto.randomBytes(2).toString('hex')}.png`);
  if (t === 'layar') {
    try { await execFileP('/usr/sbin/screencapture', ['-x', '-t', 'png', file], { timeout: 20000 }); } catch (e) { throw new Error(`screencapture gagal: ${clip(e.stderr || e.message, 200)}`); }
  } else if (t === 'url') {
    let u;
    try { u = new URL(String(url)); } catch { throw new Error('url tidak valid'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL harus http atau https');
    if (!LOCAL_HOST.test(u.hostname) && !LOCAL_HOST.test(`[${u.hostname}]`)) throw new Error('Hanya halaman lokal (localhost, jaringan rumah) yang boleh ditangkap');
    if (!fs.existsSync(CHROME)) throw new Error('Google Chrome tidak ditemukan di /Applications');
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-shot-'));
    try {
      await execFileP(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${prof}`, `--screenshot=${file}`, '--window-size=1280,900', '--virtual-time-budget=6000', u.href], { timeout: 45000 });
    } catch (e) { if (!fs.existsSync(file)) throw new Error(`Chrome gagal menangkap halaman: ${clip(e.stderr || e.message, 200)}`); }
    finally { fs.rmSync(prof, { recursive: true, force: true }); }
  } else throw new Error("target harus 'layar' atau 'url'");
  if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error('Tangkapan layar kosong. Cek izin Screen Recording untuk daemon di Pengaturan Sistem.');
  return sendToOwner({ ...ident, cwd: base }, file, caption);
}

/* ---------------- serving ---------------- */

const fileOfRow = r => {
  if (!r) throw err(404, 'Lampiran tidak ditemukan');
  if (!fs.existsSync(r.path)) throw err(404, 'Berkas sudah tidak ada di disk');
  return r.path;
};

/** Stream the file with Range support (video seeking). Sandboxed like the file manager, so an SVG/HTML cannot run on this origin. */
export function sendRaw(id, req, res, download = false) {
  const r = getRow(id), file = fileOfRow(r);
  const size = fs.statSync(file).size;
  const inline = !download && INLINE.test(r.mime);
  const h = { 'Content-Type': r.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    ...(r.mime === 'application/pdf' && inline ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" }),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.name)}` };
  let start = 0, end = size - 1, code = 200;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (rg && (rg[1] || rg[2])) {
    if (rg[1] === '') { start = Math.max(0, size - Number(rg[2])); } // suffix: last N bytes
    else { start = Number(rg[1]); if (rg[2]) end = Math.min(end, Number(rg[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206; h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(code, { ...h, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

const thumbJobs = new Map();
async function makeThumb(r) {
  fs.mkdirSync(THUMBS, { recursive: true, mode: 0o700 });
  return thumbFile(r.path, path.join(THUMBS, `${r.id}.jpg`), kindOf(r.mime), kindOf(r.mime) === 'video' ? Math.min(1, (metaOf(r).duration || 0) / 10) : 0);
}
/** JPEG <= 480 px wide of an image or a video frame (ffmpeg, then sips for HEIC and friends). Cached at `out`. Also used by pratinjau.js. */
export async function thumbFile(src, out, kind, at = 0) {
  if (fs.existsSync(out)) return out;
  const ffmpeg = bin('ffmpeg');
  const tmp = `${out}.tmp.jpg`;
  let ok = false;
  if (ffmpeg) {
    try { await execFileP(ffmpeg, ['-v', 'error', '-y', ...(at ? ['-ss', String(at)] : []), '-i', src, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '5', tmp], { timeout: 30000 }); ok = fs.existsSync(tmp); } catch {}
  }
  if (!ok && kind === 'image') { // HEIC and friends that ffmpeg cannot read
    try { await execFileP('/usr/bin/sips', ['-Z', '480', '-s', 'format', 'jpeg', src, '--out', tmp], { timeout: 30000 }); ok = fs.existsSync(tmp); } catch {}
  }
  if (!ok) { fs.rmSync(tmp, { force: true }); throw err(404, 'Gambar kecil tidak bisa dibuat untuk berkas ini'); }
  fs.renameSync(tmp, out);
  return out;
}
export async function sendThumb(id, req, res) {
  const r = getRow(id);
  fileOfRow(r);
  if (!['image', 'video'].includes(kindOf(r.mime))) throw err(404, 'Hanya gambar dan video yang punya gambar kecil');
  let job = thumbJobs.get(id);
  if (!job) { job = makeThumb(r).finally(() => thumbJobs.delete(id)); thumbJobs.set(id, job); }
  const file = await job;
  const size = fs.statSync(file).size;
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------------- images named in a transcript (Codex image generation, image views, pasted images, Claude Read) ---------------- */

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp']); // no svg: it can carry script
export const codexImagesDir = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
const realOr = p => { try { return fs.realpathSync(p); } catch { return null; } };
/** Folders a transcript image may be served from: Codex's generated_images, the session's working and office folder, temp (pasted images). */
export function imageRoots(sid) {
  const roots = [codexImagesDir(), os.tmpdir(), '/tmp'];
  try { const w = sessionWhere(sid); roots.push(w.base); try { roots.push(officeModel(w.office).root); } catch {} } catch {}
  return [...new Set(roots.map(realOr).filter(Boolean))];
}
/** Absolute real path of an image the chat may show, or an error: image extension only, inside imageRoots, a regular file. */
export function resolveImage(p, roots) {
  let s = String(p || '');
  if (s.startsWith('file://')) { try { s = decodeURIComponent(new URL(s).pathname); } catch { throw err(400, 'path tidak valid'); } }
  if (!path.isAbsolute(s) || s.includes('\0')) throw err(400, 'path harus absolut');
  if (!IMG_EXT.has(extOf(s))) throw err(400, 'Hanya berkas gambar');
  const real = realOr(s);
  if (!real) throw err(404, 'Gambar sudah tidak ada di disk');
  if (!IMG_EXT.has(extOf(real))) throw err(400, 'Hanya berkas gambar');
  if (!roots.some(r => real === r || real.startsWith(r + path.sep))) throw err(403, 'Gambar di luar folder sesi');
  if (!fs.statSync(real).isFile()) throw err(404, 'Bukan berkas');
  return real;
}
/** GET /api/sessions/:sid/image?path=…[&thumb=1]: one image named by a chat item {k:'image'}. */
export async function sendSessionImage(sid, p, thumb, req, res) {
  let file = resolveImage(p, imageRoots(sid));
  let type = TYPES[extOf(file)];
  if (thumb) {
    const st = fs.statSync(file);
    fs.mkdirSync(THUMBS, { recursive: true, mode: 0o700 });
    const out = path.join(THUMBS, `p-${crypto.createHash('sha1').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 24)}.jpg`);
    try { file = await thumbFile(file, out, 'image'); type = 'image/jpeg'; } catch {} // no ffmpeg/sips: the original is fine
  }
  const size = fs.statSync(file).size;
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/* ---------------- housekeeping ---------------- */

/** Remove unfinished uploads (and finished upload records) older than staleHours. */
export function cleanStale(now = Date.now()) {
  const limit = conf().staleHours * 3600e3;
  let n = 0;
  try {
    for (const f of fs.readdirSync(UPLOADS)) {
      if (!/\.(part|json)$/.test(f)) continue;
      const p = path.join(UPLOADS, f);
      try { if (now - fs.statSync(p).mtimeMs > limit) { fs.unlinkSync(p); n++; } } catch {}
    }
  } catch {}
  return n;
}
export function startAttachments() {
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  cleanStale();
  setInterval(() => cleanStale(), 3600e3).unref();
}
