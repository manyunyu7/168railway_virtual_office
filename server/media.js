// Images and attachments for wiki pages and cards. Files live on disk (offices/<id>/media/<hash>.<ext>);
// the office DB only keeps metadata and where each file is used. Same content = same file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { OFFICE_DIR } from './config.js';
import { officeDb, one, all, run, nowIso } from './db.js';
import { officeModel } from './offices.js';

const MAX = 500 * 1024 * 1024;
const MAX_LABEL = 'maks 500 MB';
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
  zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const INLINE = /^(image|video|audio)\/|^application\/pdf/;

const dir = office => { const d = path.join(OFFICE_DIR, office, 'media'); fs.mkdirSync(d, { recursive: true }); return d; };
const extOf = name => { const e = path.extname(String(name || '')).slice(1).toLowerCase(); return /^[a-z0-9]{1,8}$/.test(e) ? e : 'bin'; };
const fileOf = (office, m) => path.join(dir(office), `${m.id}.${m.ext}`);
export const mediaUrl = (office, id) => `/api/offices/${encodeURIComponent(office)}/media/${id}`;
const row = (office, m) => m && { id: m.id, name: m.name, mime: m.mime, size: m.size, by: m.by, at: m.at, url: mediaUrl(office, m.id), image: /^image\//.test(m.mime), video: /^video\//.test(m.mime), pdf: m.mime === 'application/pdf', doc: /^text\/(?:markdown|plain)/.test(m.mime) };
/** Markdown for a file: images, videos, PDFs and md/txt documents embed (their url carries the extension so readers can tell), others become a 📎 link. */
export const mediaMarkdown = (m, label) => m.image ? `![${label || m.name}](${m.url})` : m.video || m.pdf || m.doc ? `![${label || m.name.replace(/\.[a-z0-9]+$/i, '')}](${m.url}.${extOf(m.name)})` : `[📎 ${label || m.name}](${m.url})`;

async function store(office, name, source, by) {
  const ext = extOf(name), tmp = path.join(dir(office), `.up-${crypto.randomUUID()}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  source.on('data', c => { size += c.length; hash.update(c); if (size > MAX) source.destroy(new Error(`File terlalu besar (${MAX_LABEL})`)); });
  try { await pipeline(source, fs.createWriteStream(tmp, { flags: 'wx' })); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  if (!size) { fs.rmSync(tmp, { force: true }); throw new Error('File kosong'); }
  const id = hash.digest('hex').slice(0, 20);
  const db = officeDb(office);
  const have = one(db, 'SELECT * FROM media WHERE id = ?', id);
  if (have && fs.existsSync(fileOf(office, have))) { fs.rmSync(tmp, { force: true }); return row(office, have); }
  fs.renameSync(tmp, path.join(dir(office), `${id}.${ext}`));
  const clean = path.basename(String(name || 'file')).replace(/[\0\/\\]/g, '').slice(0, 200) || 'file';
  run(db, 'INSERT OR REPLACE INTO media (id, name, mime, size, ext, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, clean, TYPES[ext] || 'application/octet-stream', size, ext, by, nowIso());
  return row(office, one(db, 'SELECT * FROM media WHERE id = ?', id));
}

/** Upload from an HTTP request body (raw bytes). */
export function saveUpload(office, name, req, by) {
  if (Number(req.headers['content-length'] || 0) > MAX) throw new Error(`File terlalu besar (${MAX_LABEL})`);
  return store(office, name, req, by);
}

/** Attach a file an agent made: it must be inside the office folder or the temp folder. */
export async function saveFromPath(office, file, by) {
  const m = officeModel(office);
  const real = fs.realpathSync(path.resolve(m.root, String(file || '')));
  const okRoots = [m.root, os.tmpdir(), '/tmp', '/private/tmp'].map(p => { try { return fs.realpathSync(p); } catch { return p; } });
  if (!okRoots.some(r => real === r || real.startsWith(r + path.sep))) throw new Error('File harus berada di folder kantor atau folder sementara (/tmp)');
  if (!fs.statSync(real).isFile()) throw new Error('Bukan file');
  return store(office, path.basename(real), fs.createReadStream(real), by);
}

/** Store a file the daemon itself owns (e.g. a pratinjau snapshot); no path checks, callers pass trusted paths only. */
export function saveFromFile(office, file, by, name) { return store(office, name || path.basename(file), fs.createReadStream(file), by); }

export function getMedia(office, id) { return row(office, one(officeDb(office), 'SELECT * FROM media WHERE id = ?', String(id))); }
export function listMedia(office) {
  const uses = all(officeDb(office), 'SELECT media_id, kind, ref FROM media_use');
  return all(officeDb(office), 'SELECT * FROM media ORDER BY at DESC LIMIT 500').map(m => ({ ...row(office, m), used: uses.filter(u => u.media_id === m.id).map(u => ({ kind: u.kind, ref: u.ref })) }));
}

/** Remember where a file is used ('wiki' + slug, 'card' + id). */
export function useMedia(office, id, kind, ref, on = true) {
  const db = officeDb(office);
  if (on) run(db, 'INSERT OR IGNORE INTO media_use (media_id, kind, ref, at) VALUES (?, ?, ?, ?)', id, kind, ref, nowIso());
  else run(db, 'DELETE FROM media_use WHERE media_id = ? AND kind = ? AND ref = ?', id, kind, ref);
}
/** Media ids referenced from markdown (links to /api/offices/<office>/media/<id>). */
export const mediaIn = text => [...new Set([...String(text || '').matchAll(/\/media\/([0-9a-f]{20})\b/g)].map(m => m[1]))];

/** Parse a single `Range: bytes=` header against a file size: {start,end}, null = no/ignored range, false = unsatisfiable. */
export function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return false; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? false : { start, end };
}

export function sendMedia(office, id, res, download = false, rangeHeader = '') {
  id = String(id).replace(/\.[a-z0-9]{1,8}$/i, ''); // video links may carry an extension: <id>.mp4
  const m = one(officeDb(office), 'SELECT * FROM media WHERE id = ?', id);
  if (!m) throw Object.assign(new Error('File tidak ditemukan'), { code: 404 });
  const file = fileOf(office, m);
  if (!fs.existsSync(file)) throw Object.assign(new Error('File sudah tidak ada di disk'), { code: 404 });
  const inline = !download && INLINE.test(m.mime);
  const size = fs.statSync(file).size, rg = parseRange(rangeHeader, size);
  if (rg === false) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }); return res.end(); }
  res.writeHead(rg ? 206 : 200, { 'Content-Type': m.mime, 'Content-Length': rg ? rg.end - rg.start + 1 : size, 'Accept-Ranges': 'bytes', ...(rg ? { 'Content-Range': `bytes ${rg.start}-${rg.end}/${size}` } : {}), 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    // never let an uploaded SVG/HTML run script on the office's origin (PDF needs the browser viewer, which a sandbox blocks)
    ...(m.mime === 'application/pdf' && inline ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" }),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}` });
  const rs = fs.createReadStream(file, rg ? { start: rg.start, end: rg.end } : {});
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}
