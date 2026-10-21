// File manager for an office: browse, read, serve, upload and make folders, always inside the office folder.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { officeModel } from './offices.js';

const HIDE = new Set(['node_modules', '.git', '.dart_tool', 'Pods', '__pycache__', '.idea', '.DS_Store', 'build', 'dist', 'vendor', 'target', '.gradle']);
const MAX_LIST = 2000, MAX_TEXT = 1024 * 1024, MAX_UPLOAD = 512 * 1024 * 1024;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8' };

/** Absolute path for a path relative to the office folder; refuses anything that leaves it (.., symlinks). */
export function resolveIn(officeId, rel = '') {
  const m = officeModel(officeId);
  if (!m) throw Object.assign(new Error('Kantor tidak ditemukan'), { code: 404 });
  const rootReal = fs.realpathSync(m.root);
  const clean = String(rel || '').replace(/^\/+/, '');
  const abs = path.resolve(m.root, clean);
  const inside = p => p === rootReal || p.startsWith(rootReal + path.sep) || p === m.root || p.startsWith(m.root + path.sep);
  if (!inside(abs)) throw new Error('Path di luar folder kantor');
  // follow symlinks for paths that exist, so a link cannot point outside
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch {} }
  if (!inside(real)) throw new Error('Path di luar folder kantor');
  return { abs, rel: path.relative(m.root, abs).split(path.sep).join('/'), root: m.root };
}

export function listDir(officeId, rel = '', { all = false } = {}) {
  const { abs, rel: r, root } = resolveIn(officeId, rel);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('Bukan folder');
  const entries = [];
  let hidden = 0;
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!all && (d.name.startsWith('.') || HIDE.has(d.name))) { hidden++; continue; }
    let s = null; try { s = fs.statSync(path.join(abs, d.name)); } catch { continue; }
    entries.push({ name: d.name, path: r ? `${r}/${d.name}` : d.name, dir: s.isDirectory(), size: s.isDirectory() ? null : s.size, mtime: s.mtimeMs });
    if (entries.length >= MAX_LIST) break;
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: r, root, abs, entries, hidden, more: entries.length >= MAX_LIST };
}

/** Find files by name under a folder (breadth first, bounded). */
export function findFiles(officeId, rel = '', q = '', limit = 200) {
  const { abs, rel: base } = resolveIn(officeId, rel);
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const out = [], queue = [[abs, base]];
  let seen = 0;
  while (queue.length && out.length < limit && seen < 20000) {
    const [dir, r] = queue.shift();
    let ds = []; try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ds) {
      seen++;
      if (d.name.startsWith('.') || HIDE.has(d.name)) continue;
      const p = r ? `${r}/${d.name}` : d.name;
      if (d.name.toLowerCase().includes(needle)) out.push({ name: d.name, path: p, dir: d.isDirectory() });
      if (d.isDirectory()) queue.push([path.join(dir, d.name), p]);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Text content for the viewer, or a note that the file is binary / too large. */
export function readText(officeId, rel) {
  const { abs, rel: r } = resolveIn(officeId, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('Ini folder');
  const ext = path.extname(abs).toLowerCase();
  const base = { path: r, abs, size: st.size, mtime: st.mtimeMs, ext, type: TYPES[ext] || null };
  if (TYPES[ext] && !TYPES[ext].startsWith('application/json')) return { ...base, kind: TYPES[ext].split('/')[0] === 'application' ? 'pdf' : TYPES[ext].split('/')[0] };
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', text: buf.toString('utf8'), truncated: st.size > MAX_TEXT };
  } finally { fs.closeSync(fd); }
}

/** Stream a file. Sandboxed, so an HTML or SVG file from a project cannot run script on the office's origin. */
export function sendRaw(officeId, rel, res, download = false) {
  const { abs } = resolveIn(officeId, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('Ini folder');
  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext] && ext !== '.svg' ? TYPES[ext] : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': download ? 'application/octet-stream' : type, 'Content-Length': st.size, 'Cache-Control': 'no-store',
    // PDFs need the browser's viewer, which a sandboxed document cannot load; PDF script never runs on the page's origin
    ...(ext === '.pdf' && !download ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" }), 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}` });
  fs.createReadStream(abs).pipe(res);
}

const safeName = n => String(n || '').replace(/[\/\\\0]/g, '').replace(/^\.+$/, '').trim().slice(0, 200);
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) { const n = `${stem} (${i})${ext}`; if (!fs.existsSync(path.join(dir, n))) return n; }
  throw new Error('Terlalu banyak file dengan nama sama');
}

/** Save an uploaded file into a folder; never overwrites (adds " (2)" instead). */
export async function upload(officeId, rel, name, req) {
  const { abs, rel: r } = resolveIn(officeId, rel);
  if (!fs.statSync(abs).isDirectory()) throw new Error('Tujuan upload harus folder');
  const clean = safeName(name);
  if (!clean) throw new Error('Nama file tidak valid');
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) throw new Error('File terlalu besar (maks 512 MB)');
  const final = freeName(abs, clean);
  const tmp = path.join(abs, `.${final}.kc-upload`);
  let bytes = 0;
  req.on('data', c => { bytes += c.length; if (bytes > MAX_UPLOAD) req.destroy(new Error('File terlalu besar')); });
  try { await pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' })); fs.renameSync(tmp, path.join(abs, final)); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return { path: r ? `${r}/${final}` : final, name: final, size: bytes, renamed: final !== clean };
}

export function makeDir(officeId, rel, name) {
  const { abs, rel: r } = resolveIn(officeId, rel);
  const clean = safeName(name);
  if (!clean) throw new Error('Nama folder tidak valid');
  const target = path.join(abs, clean);
  if (fs.existsSync(target)) throw new Error('Sudah ada file atau folder dengan nama itu');
  fs.mkdirSync(target);
  return { path: r ? `${r}/${clean}` : clean };
}
