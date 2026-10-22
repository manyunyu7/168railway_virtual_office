import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { globalDb, all, one, run, tx, newId } from './db.js';

const TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg; codecs=opus' };
const MAX_FILES = 500, MAX_DEPTH = 4;
const notFound = () => Object.assign(new Error('Lagu tidak ditemukan'), { code: 404 });

const titleOf = file => path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').replace(/^\d{1,3}[\s.\-)]+(?=\S)/, '').trim() || file;

/** Audio files under config().musicDir (depth <= 4, max 500, no dotfiles). */
export function listMusic() {
  const dir = config().musicDir;
  const files = [];
  const walk = (abs, rel, depth) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = fs.statSync(a); } catch { continue; } // follows symlinks; sendMusic still enforces the boundary
      if (st.isDirectory()) { if (depth < MAX_DEPTH && !e.isSymbolicLink()) walk(a, r, depth + 1); }
      else if (st.isFile() && TYPES[path.extname(e.name).toLowerCase()] && inside(dir, a)) files.push({ path: r, name: titleOf(e.name), size: st.size });
    }
  };
  walk(dir, '', 0);
  return { dir, files };
}

function inside(dir, abs) {
  try {
    const base = fs.realpathSync(dir), real = fs.realpathSync(abs);
    return real === base || real.startsWith(base + path.sep);
  } catch { return false; }
}

/** Stream one file with Range support; anything outside musicDir is a 404. */
export function sendMusic(rel, req, res) {
  const dir = config().musicDir;
  if (!rel || rel.includes('\0')) throw notFound();
  const abs = path.resolve(dir, rel);
  const ext = path.extname(abs).toLowerCase();
  if (!TYPES[ext] || path.relative(dir, abs).split(path.sep).some(s => s === '..' || s.startsWith('.')) || !inside(dir, abs)) throw notFound();
  let st;
  try { st = fs.statSync(abs); } catch { throw notFound(); }
  if (!st.isFile()) throw notFound();
  const head = { 'Content-Type': TYPES[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
    else { start = Math.max(0, st.size - Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    code = 206;
    head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  head['Content-Length'] = end - start + 1;
  res.writeHead(code, head);
  if (req.method === 'HEAD' || st.size === 0) { res.end(); return; }
  const rs = fs.createReadStream(abs, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

/* ---------------- upload ---------------- */
const MAX_UPLOAD = 200 * 1024 * 1024, UP_DIR = 'Kantor Claude';
const bad = msg => Object.assign(new Error(msg), { code: 400 });

/** Save an uploaded audio file into <musicDir>/Kantor Claude; never overwrites (adds " (2)"). */
export async function uploadMusic(name, req) {
  const clean = String(name || '').replace(/[\/\\\0]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  const ext = path.extname(clean).toLowerCase();
  if (!clean || !TYPES[ext]) throw bad('Hanya file audio (mp3, m4a, aac, wav, ogg, flac, opus) yang bisa diunggah');
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) throw bad('File terlalu besar (maks 200 MB)');
  const base = config().musicDir;
  if (!fs.existsSync(base)) throw bad('Folder musik belum ada. Atur di Pengaturan.');
  const dir = path.join(base, UP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  if (!inside(base, dir)) throw bad('Folder unggahan tidak valid');
  const stem = clean.slice(0, clean.length - ext.length);
  let final = clean;
  for (let i = 2; fs.existsSync(path.join(dir, final)); i++) { if (i > 999) throw bad('Terlalu banyak file dengan nama sama'); final = `${stem} (${i})${ext}`; }
  const tmp = path.join(dir, `.${final}.kc-upload`);
  let bytes = 0;
  req.on('data', c => { bytes += c.length; if (bytes > MAX_UPLOAD) req.destroy(new Error('File terlalu besar (maks 200 MB)')); });
  try { await pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' })); if (!bytes) throw bad('File kosong'); fs.renameSync(tmp, path.join(dir, final)); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return { path: `${UP_DIR}/${final}`, name: titleOf(final), size: bytes, renamed: final !== clean };
}

/* ---------------- playlists (global DB) ---------------- */
// lexical check for stored paths: relative, audio extension, no dot/.. segments. Existence is checked separately.
function cleanRel(rel) {
  rel = String(rel || '');
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || !TYPES[path.extname(rel).toLowerCase()]) throw bad('Path lagu tidak valid');
  const segs = rel.split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.')) || rel.includes('\\')) throw bad('Path lagu tidak valid');
  return rel;
}
function playable(rel) {
  try { const dir = config().musicDir, abs = path.resolve(dir, rel); return fs.statSync(abs).isFile() && inside(dir, abs); } catch { return false; }
}
const itemsOf = id => all(globalDb(), 'SELECT path FROM playlist_items WHERE playlist_id = ? ORDER BY ord', id)
  .map(r => ({ path: r.path, name: titleOf(path.basename(r.path)), missing: !playable(r.path) }));
const plOrThrow = id => { const r = one(globalDb(), 'SELECT * FROM playlists WHERE id = ?', id); if (!r) throw notFound(); return r; };
const cleanName = n => { n = String(n || '').trim().slice(0, 80); if (!n) throw bad('Nama playlist kosong'); return n; };

export const listPlaylists = () => all(globalDb(), 'SELECT id, name FROM playlists ORDER BY ord, created_at').map(p => ({ ...p, items: itemsOf(p.id) }));
export function createPlaylist(name, paths = []) {
  const db = globalDb(), id = newId('pl');
  const rels = [...new Set(paths.map(cleanRel))].filter(playable);
  tx(db, () => {
    const ord = (one(db, 'SELECT MAX(ord) m FROM playlists')?.m ?? -1) + 1;
    run(db, 'INSERT INTO playlists (id, name, created_at, ord) VALUES (?, ?, ?, ?)', id, cleanName(name), new Date().toISOString(), ord);
    rels.forEach((r, i) => run(db, 'INSERT INTO playlist_items (playlist_id, path, ord) VALUES (?, ?, ?)', id, r, i));
  });
  return { id, name: cleanName(name), items: itemsOf(id) };
}
/** body: { name?, items?: [path] (full replace = reorder/remove), add?: [path] (must exist inside musicDir) } */
export function updatePlaylist(id, b) {
  const db = globalDb(); plOrThrow(id);
  tx(db, () => {
    if (b.name !== undefined) run(db, 'UPDATE playlists SET name = ? WHERE id = ?', cleanName(b.name), id);
    if (Array.isArray(b.items)) {
      const rels = [...new Set(b.items.map(cleanRel))];
      run(db, 'DELETE FROM playlist_items WHERE playlist_id = ?', id);
      rels.forEach((r, i) => run(db, 'INSERT INTO playlist_items (playlist_id, path, ord) VALUES (?, ?, ?)', id, r, i));
    }
    if (Array.isArray(b.add)) {
      let ord = (one(db, 'SELECT MAX(ord) m FROM playlist_items WHERE playlist_id = ?', id)?.m ?? -1) + 1;
      for (const r of [...new Set(b.add.map(cleanRel))]) {
        if (!playable(r)) throw notFound();
        if (one(db, 'SELECT 1 FROM playlist_items WHERE playlist_id = ? AND path = ?', id, r)) continue;
        run(db, 'INSERT INTO playlist_items (playlist_id, path, ord) VALUES (?, ?, ?)', id, r, ord++);
      }
    }
  });
  return { id, name: one(db, 'SELECT name FROM playlists WHERE id = ?', id).name, items: itemsOf(id) };
}
export function deletePlaylist(id) {
  const db = globalDb(); plOrThrow(id);
  tx(db, () => { run(db, 'DELETE FROM playlist_items WHERE playlist_id = ?', id); run(db, 'DELETE FROM playlists WHERE id = ?', id); });
  return { ok: true };
}
