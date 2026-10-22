// "Tunjukkan": an agent puts a file, folder or local URL in front of the user (only when the user asked for it).
// Items are kept so the notification survives a reload; the browser shows them in a floating panel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { globalDb, all, one, run, nowIso, newId } from './db.js';
import { officeModel } from './offices.js';
import { bus } from './live.js';
import { config } from './config.js';
import { mimeOf } from './pratinjau.js';

const isHtml = t => /\.html?$/i.test(String(t || ''));
const row = r => r && { id: r.id, office: r.office, sid: r.sid, who: r.who, kind: r.kind, target: r.target, note: r.note, lines: r.lines || null, at: r.at, seen: !!r.seen, closed: !!r.closed,
  ...(r.kind === 'file' && isHtml(r.target) ? { html: true, view: viewUrl(r) } : {}) };

/* ---------- rendered HTML: /sv/<id>/<key>/<path> ----------
   A shown .html file is served from a signed path (no cookie: a sandboxed page has an opaque origin) with a sandbox CSP,
   so it runs its scripts but cannot touch the Kantor origin. Its relative assets load too: the served root is the
   file's folder's parent (so `../slides/x.png` works), never above the office root, no dotfiles, symlinks resolved. */
export const SHOW_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups';
export const showKey = id => crypto.createHmac('sha256', String(config().token || '')).update(`show:${id}`).digest('hex').slice(0, 24);
/** How many folders up the page reaches with relative links (`../../x.png` → 2); at least 1. */
export function upDepth(html) {
  let n = 1;
  for (const m of String(html).matchAll(/(?:^|[\s"'(=,])((?:\.\.\/)+)/g)) n = Math.max(n, m[1].length / 3);
  return Math.min(n, 12);
}
/** Folder (relative to the office root) whose files the page may load: the file's folder, raised as far as its own
 *  relative links reach, never above the office root. */
export function viewRoot(target, office) {
  const dir = String(target).split('/').slice(0, -1);
  let depth = 1;
  try {
    const root = fs.realpathSync(officeModel(office).root), abs = path.join(root, ...String(target).split('/'));
    const fd = fs.openSync(abs, 'r'), buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    depth = upDepth(buf.toString('utf8'));
  } catch {}
  return dir.slice(0, Math.max(0, dir.length - depth)).join('/');
}
function viewUrl(r) {
  const root = viewRoot(r.target, r.office), rel = root ? r.target.slice(root.length + 1) : r.target;
  return `/sv/${r.id}/${showKey(r.id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
/** GET/HEAD /sv/<id>/<key>/<path>. The key is the permission. */
export function serveShow(req, res, pathname) {
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': SHOW_CSP, 'Cache-Control': 'no-store' }); res.end(msg); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Metode tidak didukung');
  const m = /^\/sv\/(t[0-9a-z]+)\/([0-9a-f]{24})(\/.*)?$/.exec(pathname);
  if (!m) return fail(404, 'Tidak ditemukan');
  const a = Buffer.from(m[2]), b = Buffer.from(showKey(m[1]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(404, 'Tidak ditemukan');
  const r = one(globalDb(), 'SELECT * FROM shows WHERE id = ?', m[1]);
  if (!r || r.kind !== 'file' || !isHtml(r.target)) return fail(404, 'Tidak ditemukan');
  let segs;
  try { segs = (m[3] || '/').split('/').filter(Boolean).map(decodeURIComponent); } catch { return fail(400, 'Path tidak valid'); }
  if (segs.some(s => s === '..' || s.startsWith('.') || s.includes('/') || s.includes('\\') || s.includes('\0'))) return fail(403, 'Path tidak diizinkan');
  try {
    const office = fs.realpathSync(officeModel(r.office).root);
    const base = fs.realpathSync(path.resolve(office, viewRoot(r.target, r.office)));
    if (base !== office && !base.startsWith(office + path.sep)) return fail(403, 'Di luar folder kantor');
    let file = fs.realpathSync(path.join(base, ...segs));
    if (fs.statSync(file).isDirectory()) file = fs.realpathSync(path.join(file, 'index.html'));
    if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) return fail(403, 'Di luar folder yang ditunjukkan');
    const size = fs.statSync(file).size;
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': SHOW_CSP, 'Cross-Origin-Resource-Policy': 'cross-origin' });
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(file);
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  } catch { return fail(404, 'Tidak ditemukan'); }
}

/** Record something to show. path is resolved against the caller's folder, and must stay inside the office. */
export function addShow({ office, sid, who, cwd, path: p, url, note, lines }) {
  let kind, target;
  if (url) {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL harus http atau https');
    kind = 'url'; target = u.href;
  } else if (p) {
    const m = officeModel(office);
    const abs = path.resolve(cwd || m.root, String(p));
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : null;
    if (!real) throw new Error(`Tidak ada file atau folder ${p}`);
    const root = fs.realpathSync(m.root);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Yang bisa ditunjukkan hanya isi folder kantor. File lain: lampirkan dengan attach_file.');
    kind = fs.statSync(real).isDirectory() ? 'folder' : 'file';
    target = path.relative(root, real).split(path.sep).join('/');
  } else throw new Error('Isi path atau url');
  const ln = lines && /^\d+(-\d+)?$/.test(String(lines)) ? String(lines) : null;
  const id = newId('t');
  run(globalDb(), 'INSERT INTO shows (id, office, sid, who, kind, target, note, lines, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, office, sid || null, who || 'Agen', kind, target, String(note || '').slice(0, 500), ln, nowIso());
  const item = row(one(globalDb(), 'SELECT * FROM shows WHERE id = ?', id));
  bus.emit('msg', { t: 'show', office, item });
  return item;
}
export function listShows({ open = false } = {}) {
  return all(globalDb(), `SELECT * FROM shows ${open ? 'WHERE closed = 0' : ''} ORDER BY at DESC, rowid DESC LIMIT 60`).map(row);
}
export function markShow(id, { seen, closed }) {
  if (seen !== undefined) run(globalDb(), 'UPDATE shows SET seen = ? WHERE id = ?', seen ? 1 : 0, id);
  if (closed !== undefined) run(globalDb(), 'UPDATE shows SET closed = ? WHERE id = ?', closed ? 1 : 0, id);
  const item = row(one(globalDb(), 'SELECT * FROM shows WHERE id = ?', id));
  if (item) bus.emit('msg', { t: 'show-update', office: item.office, item });
  return item;
}

/** Open an office path on this Mac: in VS Code, or revealed in Finder. */
export function openLocal(office, rel, app) {
  const m = officeModel(office);
  const root = fs.realpathSync(m.root);
  const abs = fs.realpathSync(path.resolve(root, String(rel || '')));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path di luar folder kantor');
  return new Promise((resolve, reject) => {
    const [cmd, args] = app === 'finder' ? ['/usr/bin/open', ['-R', abs]] : ['/usr/bin/open', ['-a', 'Visual Studio Code', abs]];
    execFile(cmd, args, { timeout: 10000 }, err => err ? reject(new Error(app === 'finder' ? 'Gagal membuka Finder' : 'Gagal membuka VS Code. Sudah terpasang?')) : resolve({ ok: true }));
  });
}
