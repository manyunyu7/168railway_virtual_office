// File manager for an office: browse, read, serve, upload and make folders, always inside the office folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { officeModel } from './offices.js';
import * as offices from './offices.js';
import * as mx from './machines.js';

const { q } = mx;

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

const modelOf = officeId => { const m = officeModel(officeId); if (!m) throw Object.assign(new Error('Kantor tidak ditemukan'), { code: 404 }); return m; };

export function listDir(officeId, rel = '', { all = false } = {}) {
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return listRemote(modelOf(officeId), rv, all);
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
  // ruangan di Mac lain tampil di akar sebagai folder virtual @<id> (hanya kalau kantor punya ruangan seperti itu)
  const rooms = r ? [] : remoteRooms(modelOf(officeId));
  if (rooms.length) {
    const fresh = rooms.map(x => { const w = remoteRoomOf(modelOf(officeId), x); return { name: `${x.name || x.id} (${machineLabel(w.machine)})`, path: `@${x.id}`, dir: true, size: null, mtime: null, remote: true, room: x.id, roomName: x.name, machine: w.machine, machineName: machineLabel(w.machine), machineOffline: mx.isOffline(w.machine), remotePath: w.cwd }; });
    return { path: r, root, abs, entries: [...fresh, ...entries], hidden, more: entries.length >= MAX_LIST };
  }
  return { path: r, root, abs, entries, hidden, more: entries.length >= MAX_LIST };
}

/** Find files by name under a folder (breadth first, bounded). */
export function findFiles(officeId, rel = '', q = '', limit = 200) {
  const needle = String(q || '').toLowerCase().trim();
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return needle ? findRemote(modelOf(officeId), rv, needle, limit) : [];
  const { abs, rel: base } = resolveIn(officeId, rel);
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
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return readRemote(modelOf(officeId), rv);
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
const rawHeaders = (abs, size, download) => {
  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext] && ext !== '.svg' ? TYPES[ext] : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
  return { 'Content-Type': download ? 'application/octet-stream' : type, 'Content-Length': size, 'Cache-Control': 'no-store',
    // PDFs need the browser's viewer, which a sandboxed document cannot load; PDF script never runs on the page's origin
    ...(ext === '.pdf' && !download ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" }), 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}` };
};
export function sendRaw(officeId, rel, res, download = false) {
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return sendRemote(modelOf(officeId), rv, res, download);
  const { abs } = resolveIn(officeId, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('Ini folder');
  res.writeHead(200, rawHeaders(abs, st.size, download));
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
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return uploadRemote(modelOf(officeId), rv, name, req);
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
  const rv = remoteOf(modelOf(officeId), rel);
  if (rv) return makeDirRemote(modelOf(officeId), rv, name);
  const { abs, rel: r } = resolveIn(officeId, rel);
  const clean = safeName(name);
  if (!clean) throw new Error('Nama folder tidak valid');
  const target = path.join(abs, clean);
  if (fs.existsSync(target)) throw new Error('Sudah ada file atau folder dengan nama itu');
  fs.mkdirSync(target);
  return { path: r ? `${r}/${clean}` : clean };
}

/* ---------------- ruangan di Mac lain (docs/MULTI-PC.md) ----------------
   Ruangan remote tidak punya folder di bawah root kantor. File manager menyebutnya dengan path virtual
   `@<id ruangan>/sub/path`; semua akses lewat machines.js (ssh), path selalu dikutip q() dan dikurung di folder ruangan. */

const PX = path.posix;
const insideP = (root, p) => p === root || p.startsWith(root === '/' ? '/' : root + '/');
const errC = (code, message) => Object.assign(new Error(message), { code });
/** Nama mesin untuk pesan ke pengguna. */
export const machineLabel = id => mx.getMachine(id)?.name || id;
/** Error seragam untuk fitur yang belum ada di mesin lain. */
export const remoteUnsupported = (what, machine) => errC(400, `${what} belum didukung untuk ruangan di Mac lain${machine ? ` (${machineLabel(machine)})` : ''}.`);

/** { machine, cwd } kalau ruangan ini ada di Mac lain, selain itu null. */
export function remoteRoomOf(model, room) {
  if (!room) return null;
  let w = null;
  if (typeof offices.roomCwd === 'function') { try { w = offices.roomCwd(model, room); } catch {} }
  else if (room.machine && room.remotePath) w = { machine: room.machine, cwd: room.remotePath };
  return w && w.machine && w.machine !== mx.LOCAL && mx.isRemote(w.machine) && w.cwd ? { machine: w.machine, cwd: w.cwd } : null;
}

/** Satu baris shell di mesin itu; ssh putus jadi pesan yang jelas. */
export function rsh(machine, line, opts = {}) {
  try { return mx.shSync(machine, line, { timeout: 20000, ...opts }); }
  catch (e) {
    if (e.status === 255 || e.code === 'ETIMEDOUT') throw errC(503, `Mesin ${machineLabel(machine)} tidak terjangkau${mx.isOffline(machine) ? ' (offline)' : ''}. Coba lagi setelah mesinnya online.`);
    throw e;
  }
}
export async function rshAsync(machine, line, opts = {}) {
  const r = await mx.shAsync(machine, line, { timeout: 30000, ...opts });
  if (r.code === 255 || (r.code === -1 && !mx.getMachine(machine)?.ssh?.startsWith('local:'))) throw errC(503, `Mesin ${machineLabel(machine)} tidak terjangkau. Coba lagi setelah mesinnya online.`);
  return r;
}

// realpath (macOS 13+), dengan cadangan cd/pwd -P untuk sistem tanpa realpath
const RP = `rp() { if command -v realpath >/dev/null 2>&1; then realpath "$1" 2>/dev/null; elif [ -d "$1" ]; then (cd "$1" 2>/dev/null && pwd -P); elif [ -e "$1" ]; then d=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) && printf '%s/%s\\n' "\${d%/}" "$(basename "$1")"; else return 1; fi; }`;
const STAT1 = f => `stat -L -f '%HT|%z|%m' ${f} 2>/dev/null || stat -L -c '%F|%s|%Y' ${f} 2>/dev/null`;
const typeOf = t => /^dir/i.test(t) ? 'dir' : /regular/i.test(t) ? 'file' : t ? 'other' : null;

/**
 * Resolusi path di mesin lain dalam satu panggilan ssh: path asli (symlink diikuti), jenis, ukuran, mtime,
 * plus folder sementara dan HOME mesin itu. p relatif terhadap root. Tidak melempar bila file tidak ada (exists: false).
 */
export function remoteResolve(machine, root, p = '') {
  const abs = PX.resolve(root, String(p || ''));
  const out = rsh(machine, `${RP}
R=$(rp ${q(root)}) || R=
A=${q(abs)}
if X=$(rp "$A"); then E=1; else E=0; D=$(rp "$(dirname "$A")") && X="\${D%/}/$(basename "$A")" || X=; fi
printf 'R=%s\\nX=%s\\nT=%s\\nH=%s\\n' "$R" "$X" "$(rp "\${TMPDIR:-/tmp}")" "$HOME"
if [ $E = 1 ]; then printf 'S=%s\\n' "$(${STAT1('"$X"')})"; fi
exit 0`);
  const kv = {};
  for (const l of String(out).split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
  const [t, size, mt] = String(kv.S || '').split('|');
  return { root, rootReal: kv.R || null, abs, real: kv.X || null, exists: !!kv.S, type: typeOf(t), size: Number(size) || 0, mtimeMs: (Number(mt) || 0) * 1000, tmp: kv.T || null, home: kv.H || null };
}

/** Tarik file dari mesin itu ke `local`, bertahap (4 MB per panggilan). Ukuran harus cocok, kalau tidak dibuang. */
export async function pullFile(machine, remote, local, { size = null, max = Infinity, chunk = 4 << 20 } = {}) {
  const want = size ?? mx.statFile(machine, remote)?.size;
  if (want == null) throw errC(404, `File ${remote} tidak ada di ${machineLabel(machine)}`);
  if (want > max) throw errC(413, `File terlalu besar untuk ditarik dari ${machineLabel(machine)}`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const tmp = `${local}.kc-pull`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    let off = 0;
    while (off < want) {
      const buf = await mx.readFromAsync(machine, remote, off, Math.min(chunk, want - off));
      if (!buf.length) throw errC(502, `Gagal menarik ${PX.basename(remote)} dari ${machineLabel(machine)} (berhenti di ${off} dari ${want} byte)`);
      fs.writeSync(fd, buf, 0, buf.length, off);
      off += buf.length;
    }
  } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
  fs.closeSync(fd);
  fs.renameSync(tmp, local);
  return { path: local, size: want };
}

/** Dorong file lokal ke mesin itu, bertahap (8 MB per panggilan), lewat file .kc-push lalu mv. Folder dibuat. */
export async function pushFile(machine, local, remote, { chunk = 8 << 20, mode = null } = {}) {
  const size = fs.statSync(local).size, tmp = `${PX.dirname(remote)}/.${PX.basename(remote)}.kc-push`;
  const fd = fs.openSync(local, 'r');
  try {
    let off = 0, first = true;
    do {
      const n = Math.min(chunk, size - off), buf = Buffer.alloc(n);
      if (n) fs.readSync(fd, buf, 0, n, off);
      const r = await rshAsync(machine, first ? `mkdir -p ${q(PX.dirname(remote))} && cat > ${q(tmp)}` : `cat >> ${q(tmp)}`, { input: buf, timeout: 120000 });
      if (r.code !== 0) { await mx.shAsync(machine, `rm -f ${q(tmp)}`); throw errC(502, `Gagal mengirim file ke ${machineLabel(machine)}: ${String(r.stderr).trim().slice(0, 200)}`); }
      off += n; first = false;
    } while (off < size);
  } finally { fs.closeSync(fd); }
  const r = await rshAsync(machine, `mv -f ${q(tmp)} ${q(remote)}${mode != null ? ` && chmod ${(mode & 0o777).toString(8)} ${q(remote)}` : ''}`);
  if (r.code !== 0) throw errC(502, `Gagal menaruh file di ${machineLabel(machine)}: ${String(r.stderr).trim().slice(0, 200)}`);
  return { path: remote, size };
}

/** Nama yang belum dipakai di folder mesin lain (gaya freeName: "nama (2).ext" atau "nama-2.ext"). */
export function remoteFreeName(machine, dir, name, sep = ' (%d)') {
  const ext = PX.extname(name), stem = name.slice(0, name.length - ext.length);
  const out = rsh(machine, `d=${q(dir)}; n=${q(name)}; [ -e "$d/$n" ] || [ -L "$d/$n" ] || { printf '%s' "$n"; exit 0; }
i=2; while [ $i -lt 1000 ]; do n=${q(stem)}$(printf ${q(sep)} $i)${q(ext)}; [ -e "$d/$n" ] || [ -L "$d/$n" ] || { printf '%s' "$n"; exit 0; }; i=$((i+1)); done; exit 9`).trim();
  if (!out) throw new Error('Terlalu banyak file dengan nama sama');
  return out;
}

/** `@<ruangan>/sisa` → { machine, root, rest, room } untuk ruangan remote; null untuk path biasa. */
function remoteOf(m, rel) {
  const s = String(rel || '').replace(/^\/+/, '');
  const mm = /^@([^/]+)(?:\/(.*))?$/.exec(s);
  if (!mm) return null;
  const room = m.plan?.rooms.find(r => r.id === mm[1]);
  const w = remoteRoomOf(m, room);
  return w ? { machine: w.machine, root: w.cwd, rest: mm[2] || '', room, prefix: `@${room.id}` } : null;
}
function resolveRemote(m, rv) {
  const abs = PX.resolve(rv.root, rv.rest);
  if (!insideP(rv.root, abs)) throw new Error('Path di luar folder ruangan');
  const info = remoteResolve(rv.machine, rv.root, rv.rest);
  if (!info.rootReal) throw errC(404, `Folder ruangan ${rv.root} tidak ada di ${machineLabel(rv.machine)}`);
  if (info.real && !insideP(info.rootReal, info.real) && !insideP(rv.root, info.real)) throw new Error('Path di luar folder ruangan');
  const r = PX.relative(rv.root, abs);
  return { ...info, abs, rel: r ? `${rv.prefix}/${r}` : rv.prefix, machine: rv.machine };
}
const remoteRooms = m => (m.plan?.rooms || []).filter(r => remoteRoomOf(m, r));

function listRemote(m, rv, all) {
  const t = resolveRemote(m, rv);
  if (!t.exists) throw errC(404, 'Folder tidak ditemukan');
  if (t.type !== 'dir') throw new Error('Bukan folder');
  // satu panggilan: tiap entri "jenis|ukuran|mtime|./nama" (stat -L mengikuti symlink seperti fs.statSync)
  const out = rsh(t.machine, `cd ${q(t.real)} || exit 3; find . -mindepth 1 -maxdepth 1 -exec stat -L -f '%HT|%z|%m|%N' {} + 2>/dev/null; exit 0`, { timeout: 30000 });
  const entries = [];
  let hidden = 0;
  for (const line of String(out).split('\n')) {
    const p = line.split('|');
    if (p.length < 4) continue;
    const name = p.slice(3).join('|').replace(/^\.\//, '');
    if (!name || name.includes('/')) continue;
    if (!all && (name.startsWith('.') || HIDE.has(name))) { hidden++; continue; }
    const dir = typeOf(p[0]) === 'dir';
    entries.push({ name, path: `${t.rel}/${name}`, dir, size: dir ? null : Number(p[1]) || 0, mtime: (Number(p[2]) || 0) * 1000 });
    if (entries.length >= MAX_LIST) break;
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: t.rel, root: rv.root, abs: t.abs, machine: t.machine, machineName: machineLabel(t.machine), entries, hidden, more: entries.length >= MAX_LIST };
}

function findRemote(m, rv, needle, limit) {
  const t = resolveRemote(m, rv);
  if (t.type !== 'dir') return [];
  const pat = '*' + needle.replace(/[\\*?[\]]/g, c => '\\' + c) + '*';
  const prune = ['.*', ...HIDE].map(n => `-name ${q(n)}`).join(' -o ');
  const out = rsh(t.machine, `cd ${q(t.real)} || exit 3; find . -mindepth 1 -maxdepth 12 \\( ${prune} \\) -prune -o -iname ${q(pat)} -print 2>/dev/null | head -n ${Math.floor(limit)} | while IFS= read -r f; do if [ -d "$f" ]; then printf 'd|%s\\n' "$f"; else printf 'f|%s\\n' "$f"; fi; done; exit 0`, { timeout: 30000 });
  return String(out).split('\n').filter(Boolean).map(l => {
    const rel = l.slice(2).replace(/^\.\//, '');
    return { name: PX.basename(rel), path: `${t.rel}/${rel}`, dir: l[0] === 'd' };
  }).slice(0, limit);
}

function readRemote(m, rv) {
  const t = resolveRemote(m, rv);
  if (!t.exists) throw errC(404, 'File tidak ditemukan');
  if (t.type === 'dir') throw new Error('Ini folder');
  const ext = PX.extname(t.abs).toLowerCase();
  const base = { path: t.rel, abs: t.abs, size: t.size, mtime: t.mtimeMs, ext, type: TYPES[ext] || null, machine: t.machine, machineName: machineLabel(t.machine) };
  if (TYPES[ext] && !TYPES[ext].startsWith('application/json')) return { ...base, kind: TYPES[ext].split('/')[0] === 'application' ? 'pdf' : TYPES[ext].split('/')[0] };
  const buf = mx.readFrom(t.machine, t.real, 0, Math.min(t.size, MAX_TEXT));
  if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
  return { ...base, kind: 'text', text: buf.toString('utf8'), truncated: t.size > MAX_TEXT };
}

/** File dari mesin lain dialirkan per 4 MB (backpressure dihormati); putus di tengah = koneksi ditutup. */
function sendRemote(m, rv, res, download) {
  const t = resolveRemote(m, rv);
  if (!t.exists) throw errC(404, 'File tidak ditemukan');
  if (t.type === 'dir') throw new Error('Ini folder');
  res.writeHead(200, rawHeaders(t.abs, t.size, download));
  (async () => {
    let off = 0;
    while (off < t.size && !res.destroyed) {
      const buf = await mx.readFromAsync(t.machine, t.real, off, Math.min(4 << 20, t.size - off));
      if (!buf.length) throw new Error('baca terputus');
      off += buf.length;
      if (!res.write(buf)) await new Promise(r => { res.once('drain', r); res.once('close', r); });
    }
    res.end();
  })().catch(() => res.destroy());
}

async function uploadRemote(m, rv, name, req) {
  const t = resolveRemote(m, rv);
  if (!t.exists || t.type !== 'dir') throw new Error('Tujuan upload harus folder');
  const clean = safeName(name);
  if (!clean) throw new Error('Nama file tidak valid');
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) throw new Error('File terlalu besar (maks 512 MB)');
  // tampung dulu di Mac ini, baru dikirim ke mesinnya (koneksi browser dan ssh tidak saling menunggu)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-up-'));
  const tmp = path.join(dir, 'isi');
  let bytes = 0;
  req.on('data', c => { bytes += c.length; if (bytes > MAX_UPLOAD) req.destroy(new Error('File terlalu besar')); });
  try {
    await pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' }));
    const final = remoteFreeName(t.machine, t.real, clean);
    await pushFile(t.machine, tmp, `${t.real}/${final}`);
    return { path: `${t.rel}/${final}`, name: final, size: bytes, renamed: final !== clean, machine: t.machine };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function makeDirRemote(m, rv, name) {
  const t = resolveRemote(m, rv);
  if (!t.exists || t.type !== 'dir') throw new Error('Bukan folder');
  const clean = safeName(name);
  if (!clean) throw new Error('Nama folder tidak valid');
  const target = `${t.real}/${clean}`;
  const out = rsh(t.machine, `if [ -e ${q(target)} ] || [ -L ${q(target)} ]; then echo ADA; else mkdir ${q(target)} && echo OK; fi`).trim();
  if (out === 'ADA') throw new Error('Sudah ada file atau folder dengan nama itu');
  if (out !== 'OK') throw new Error('Gagal membuat folder');
  return { path: `${t.rel}/${clean}` };
}

/** Untuk modul lain: `@<ruangan>/sisa` ke { machine, abs, real, rel, … } (sudah dikurung di folder ruangan), atau null. */
export function resolveRemoteRel(officeId, rel) {
  const m = modelOf(officeId), rv = remoteOf(m, rel);
  return rv ? resolveRemote(m, rv) : null;
}
/** Kebalikannya: path absolut di mesin itu → `@<ruangan>/sisa` di kantor ini (ruangan terdalam menang), atau null. */
export function remoteRelOf(officeId, machine, abs) {
  const m = modelOf(officeId);
  const hits = remoteRooms(m).map(r => ({ r, w: remoteRoomOf(m, r) })).filter(x => x.w.machine === machine && insideP(x.w.cwd, abs)).sort((a, b) => b.w.cwd.length - a.w.cwd.length);
  if (!hits.length) return null;
  const rest = PX.relative(hits[0].w.cwd, abs);
  return rest ? `@${hits[0].r.id}/${rest}` : `@${hits[0].r.id}`;
}
/** Tanpa ssh: apakah path virtual ini menunjuk ruangan di Mac lain. */
export function isRemoteRel(officeId, rel) {
  try { return !!remoteOf(modelOf(officeId), rel); } catch { return false; }
}
