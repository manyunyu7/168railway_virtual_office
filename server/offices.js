import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config, HOME } from './config.js';
import { globalDb, officeDb, all, one, run, nowIso, newId, j, tx } from './db.js';
import { autoLayout, railwayLayout, appendRow } from './layout.js';
import { seedOffice } from './seed.js';
import { checkPlaced } from './furniture.js';

const SKIP = new Set(['node_modules', 'build', 'dist', 'vendor', '.git', '.idea', '.vscode', '__pycache__', 'Pods', '.dart_tool', 'target', 'out', 'tmp']);

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kantor';
const pretty = s => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function detectStack(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  if (has('pubspec.yaml')) return 'Flutter';
  if (has('artisan')) return 'Laravel';
  if (has('composer.json')) return 'PHP';
  if (has('go.mod')) return 'Go';
  if (has('Cargo.toml')) return 'Rust';
  if (has('build.gradle.kts') || has('build.gradle') || has('settings.gradle.kts')) return 'Kotlin';
  if (has('package.json')) { try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); const d = { ...p.dependencies, ...p.devDependencies }; if (d.next) return 'Next.js'; if (d.vite) return 'Vite'; if (d.react) return 'React'; } catch {} return 'Node'; }
  if (has('pyproject.toml') || has('requirements.txt')) return 'Python';
  if (has('CMakeLists.txt')) return 'C++';
  if (has('index.html')) return 'Web';
  return '';
}

/** Scan an office root for repos (rooms), worktrees and plain folders. */
export function scanRoot(root) {
  const res = { rootIsGit: fs.existsSync(path.join(root, '.git')), repos: [], worktrees: [], folders: [] };
  let names = [];
  try { names = fs.readdirSync(root); } catch { return res; }
  for (const name of names.sort()) {
    if (name.startsWith('.') || SKIP.has(name)) continue;
    const dir = path.join(root, name);
    if (!isDir(dir)) continue;
    const g = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch {}
    if (st && st.isDirectory()) res.repos.push({ dir: name, stack: detectStack(dir), md: fs.existsSync(path.join(dir, 'CLAUDE.md')) });
    else if (st && st.isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
      const parent = m ? path.basename(m[1].trim().split('/.git/')[0]) : null;
      res.worktrees.push({ dir: name, parent });
    } else {
      let files = [];
      try { files = fs.readdirSync(dir); } catch {}
      if (files.length) res.folders.push({ dir: name, stack: detectStack(dir), md: files.includes('CLAUDE.md') });
    }
  }
  return res;
}

const RAIL_MAP = { lib: 'docs', web: 'web', ltc: '168railway-golang-ltc', gopk: 'go-pk', mobile: 'mobile', admin: 'admin', live: 'android-live', lite: 'android-lite', ppka: 'ppka-wannabe', gallery: 'gallery-scanner', minikilla: 'mini-killa' };
const RAIL_ALIASES = { gallery: ['gallery-audit'] };

/* ---------------- layout editor ---------------- */
const GEO = ['x', 'y', 'w', 'h', 'floor', 'doors'];
// a saved layout repositions rooms by id; rooms it doesn't know (a repo cloned later) go in a new row below
function applyLayout(plan, L) {
  if (!L?.rooms) return false;
  const hidden = new Set(L.hidden || []);
  const known = [], fresh = [];
  for (const r of plan.rooms) {
    if (hidden.has(r.id)) continue;
    const g = L.rooms[r.id];
    if (g) { for (const k of GEO) if (g[k] !== undefined) r[k] = g[k]; known.push(r); }
    else fresh.push(r);
  }
  plan.rooms = known;
  plan.w = L.w || plan.w; plan.h = L.h || plan.h;
  for (const k of ['decor', 'runners', 'wings']) if (Array.isArray(L[k])) plan[k] = L[k];
  // zones live inside their open-plan room and follow it
  if (fresh.length) appendRow(plan, fresh.filter(r => r.kind !== 'zone'));
  return true;
}
/** Problems with a layout: overlaps (other than shared walls), out of bounds, doors off the wall, too small. */
export function layoutProblems(plan) {
  const out = [], rooms = plan.rooms.filter(r => r.kind !== 'zone');
  for (const r of rooms) {
    if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) out.push(`${r.name}: posisi dan ukuran harus bilangan bulat`);
    if (r.w < 8 || r.h < 8) out.push(`${r.name}: terlalu kecil (minimal 8×8)`);
    if (r.x < 0 || r.y < 0 || r.x + r.w > plan.w || r.y + r.h > plan.h) out.push(`${r.name}: keluar dari batas denah`);
    for (const d of r.doors || []) {
      const len = d.s === 't' || d.s === 'b' ? r.w : r.h;
      if (!['t', 'b', 'l', 'r'].includes(d.s) || d.at < 1 || d.at + (d.w || 3) > len - 1) out.push(`${r.name}: pintu tidak pas di dinding`);
    }
  }
  for (let i = 0; i < rooms.length; i++) for (let k = i + 1; k < rooms.length; k++) {
    const a = rooms[i], b = rooms[k];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 1 && oy > 1) out.push(`${a.name} menabrak ${b.name}`);
  }
  return out;
}
/** Save the editor's layout (geometry by room id + decor). Refused with the list of problems if it doesn't fit. */
export function saveLayout(id, L) {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  const w = Math.max(20, Math.min(400, Math.round(L.w || m.plan.w))), h = Math.max(20, Math.min(400, Math.round(L.h || m.plan.h)));
  // the rooms a layout may place: everything the office has before any layout is applied
  const base = () => { const t = structuredClone(basePlan(m.root, m.scan, [])); const ex = j(one(officeDb(id), "SELECT value FROM meta WHERE key = 'extraRooms'")?.value, []).filter(x => !t.rooms.some(r => r.id === x.id)); if (ex.length) appendRow(t, ex.map(x => ({ ...x, extra: true }))); return t; };
  const ids = new Set(base().rooms.map(r => r.id));
  const rooms = {};
  for (const r of L.rooms || []) {
    if (!ids.has(r.id)) continue;
    rooms[r.id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...(r.floor ? { floor: String(r.floor) } : {}),
      doors: (r.doors || []).map(d => ({ s: d.s, at: Math.round(d.at), w: Math.max(2, Math.min(6, Math.round(d.w || 3))) })) };
  }
  const saved = { w, h, rooms, hidden: (L.hidden || []).map(String), ...Object.fromEntries(['decor', 'runners', 'wings'].filter(k => Array.isArray(L[k])).map(k => [k, L[k]])) };
  // check the result exactly as it will be built
  const trial = base();
  applyLayout(trial, saved);
  const bad = layoutProblems(trial);
  if (bad.length) throw new Error(`Denah belum bisa disimpan: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` (+${bad.length - 4} lagi)` : ''}`);
  run(officeDb(id), "INSERT INTO meta (key, value) VALUES ('layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(saved));
  invalidate(id);
  return officeModel(id).plan;
}
/** Furniture placed in an office: [{uid,item,x,y}] with absolute tile coordinates. */
export function getFurniture(id) {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  return m.plan.furniture || [];
}
/** Replace the office's furniture. Refused with the list of problems when an item is unknown or outside the plan. */
export function saveFurniture(id, list) {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  const { items, problems } = checkPlaced(list, m.plan);
  if (problems.length) throw new Error(`Perabot belum bisa disimpan: ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? ` (+${problems.length - 4} lagi)` : ''}`);
  run(officeDb(id), "INSERT INTO meta (key, value) VALUES ('furniture', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(items));
  invalidate(id);
  return items;
}
export function resetLayout(id) { run(officeDb(id), "DELETE FROM meta WHERE key = 'layout'"); invalidate(id); return officeModel(id).plan; }

/** The floor plan a folder gets from its contents (before user-added rooms and overrides). */
export function basePlan(root, scan, roles = []) {
  let plan;
  const repoDirs = new Set(scan.repos.map(r => r.dir));
  const railFit = repoDirs.has('mobile') && repoDirs.has('web') && repoDirs.has('android-live') &&
    [...repoDirs].every(d => Object.values(RAIL_MAP).includes(d));
  if (railFit) {
    const paths = {};
    for (const [k, d] of Object.entries(RAIL_MAP)) if (fs.existsSync(path.join(root, d))) paths[k] = d;
    plan = railwayLayout(paths);
    for (const r of plan.rooms) {
      if (RAIL_ALIASES[r.id]) r.aliases = RAIL_ALIASES[r.id].filter(d => fs.existsSync(path.join(root, d)));
      const rep = scan.repos.find(x => x.dir === r.path);
      if (rep) { r.stack = r.stack || rep.stack; r.md = rep.md; r.git = true; }
      if (r.id === 'lib' && r.path) r.stack = 'docs';
    }
  } else {
    const code = [];
    if (scan.repos.length) {
      for (const r of scan.repos) code.push({ id: slug(r.dir), name: pretty(r.dir), kind: 'kode', path: r.dir, stack: r.stack, md: r.md, git: true });
      for (const f of scan.folders) if (f.stack && f.dir !== 'docs') code.push({ id: slug(f.dir), name: pretty(f.dir), kind: 'kode', path: f.dir, stack: f.stack || 'folder', md: f.md });
    } else if (scan.rootIsGit) {
      const subs = scan.folders.filter(f => !['docs', 'deploy', 'scripts', 'test', 'tests', 'assets'].includes(f.dir)).slice(0, 6);
      if (subs.length) for (const f of subs) code.push({ id: slug(f.dir), name: pretty(f.dir), kind: 'kode', path: f.dir, stack: f.stack || 'folder', md: f.md });
      else code.push({ id: 'kode', name: 'Kode', kind: 'kode', path: '', stack: detectStack(root), md: fs.existsSync(path.join(root, 'CLAUDE.md')) });
    } else {
      for (const f of scan.folders.slice(0, 8)) code.push({ id: slug(f.dir), name: pretty(f.dir), kind: 'kode', path: f.dir, stack: f.stack || 'folder', md: f.md });
      if (!code.length) code.push({ id: 'kode', name: 'Kode', kind: 'kode', path: '', stack: detectStack(root) });
    }
    // a folder named like a facility (server/, qa/, lib/ …) must not take that room's id
    const taken = new Set(['lobby', 'manager', 'meeting', 'lib', 'qa', 'server', 'musik', 'pantry']);
    for (const r of code) { let id = taken.has(r.id) ? `${r.id}-repo` : r.id; for (let n = 2; taken.has(id); n++) id = `${r.id}-${n}`; r.id = id; taken.add(id); }
    for (const r of code) r.desks = roles.filter(x => x.room === r.id).length + 1;
    const docs = scan.folders.find(f => f.dir === 'docs');
    const fn = [
      { id: 'manager', name: 'Ruang Manager', kind: 'manager', path: scan.rootIsGit && !code.some(c => c.path === '') ? '' : null },
      { id: 'meeting', name: 'Ruang Meeting', kind: 'meeting' },
      { id: 'lib', name: 'Perpustakaan', kind: 'lib', path: docs ? 'docs' : null, stack: docs ? 'docs' : '' },
    ];
    const tail = [{ id: 'qa', name: 'Lab QA', kind: 'qa' }, { id: 'server', name: 'Ruang Server', kind: 'server' }, { id: 'musik', name: 'Ruang Musik', kind: 'musik' }, { id: 'pantry', name: 'Pantry', kind: 'pantry' }];
    plan = autoLayout([...fn, ...code, ...tail]);
  }
  return plan;
}

/** Build rooms + floor plan for an office row. Cached until invalidate(). */
const cache = new Map();
export function invalidate(id) { cache.delete(id); }
export function officeModel(id, { preview = null } = {}) {
  if (!preview && cache.has(id)) return cache.get(id);
  const row = one(globalDb(), 'SELECT * FROM offices WHERE id = ?', id);
  if (!row) return null;
  const scan = scanRoot(row.root);
  const db = officeDb(id);
  const roles = all(db, 'SELECT id, room FROM roles WHERE archived = 0');
  const overrides = j(one(db, "SELECT value FROM meta WHERE key = 'rooms'")?.value, {});
  const plan = basePlan(row.root, scan, roles);
  // rooms added by the user (or an agent) on top of the scanned ones
  const extra = j(one(db, "SELECT value FROM meta WHERE key = 'extraRooms'")?.value, []).filter(x => !plan.rooms.some(r => r.id === x.id));
  // a room that is only being considered: laid out exactly as it would be after saving
  if (preview) extra.push(preview);
  if (extra.length) appendRow(plan, extra.map(x => ({ ...x, extra: true })));
  for (const wt of scan.worktrees) {
    const room = plan.rooms.find(r => r.path && r.path === wt.parent);
    if (room) (room.worktrees ||= []).push(wt.dir);
  }
  for (const r of plan.rooms) Object.assign(r, overrides[r.id] || {});
  const custom = applyLayout(plan, j(one(db, "SELECT value FROM meta WHERE key = 'layout'")?.value, null));
  plan.furniture = j(one(db, "SELECT value FROM meta WHERE key = 'furniture'")?.value, []);
  const model = { id: row.id, name: row.name, root: row.root, style: row.style || describe(scan), plan, scan, custom };
  if (!preview) cache.set(id, model);
  return model;
}

function describe(scan) {
  if (scan.repos.length > 1) return `Folder induk · ${scan.repos.length} repo`;
  if (scan.rootIsGit) return 'Satu repo';
  return 'Folder';
}

/** Which room a cwd belongs to, plus worktree name if any. */
export function roomForCwd(model, cwd) {
  const rel = path.relative(model.root, cwd);
  if (rel.startsWith('..')) return { room: 'lobby' };
  const first = rel.split(path.sep)[0] || '';
  const rooms = model.plan.rooms;
  // the deepest room folder that contains cwd wins, so web/admin beats web
  let r = rooms.filter(x => x.path && (rel === x.path || rel.startsWith(x.path + path.sep))).sort((a, b) => b.path.length - a.path.length)[0]
    || rooms.find(x => (x.aliases || []).includes(first));
  if (r) return { room: r.id };
  r = rooms.find(x => (x.worktrees || []).includes(first));
  if (r) return { room: r.id, worktree: first };
  if (first === '') return { room: rooms.find(x => x.path === '' && x.kind !== 'manager')?.id || 'manager' };
  return { room: rooms.find(x => x.path === '')?.id || 'lobby' };
}

/** Find (or register) the office that owns a cwd. */
export function officeForCwd(cwd, { create = true } = {}) {
  if (!cwd) return null;
  const g = globalDb();
  const rows = all(g, 'SELECT id, root FROM offices');
  const hit = rows.filter(r => cwd === r.root || cwd.startsWith(r.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0];
  if (hit) return hit.id;
  if (!create) return null;
  const root = officeRootFor(cwd);
  if (!root) return null;
  return registerOffice(root);
}

export function officeRootFor(cwd) {
  for (const base of config().roots) {
    if (cwd.startsWith(base + path.sep)) {
      const first = path.relative(base, cwd).split(path.sep)[0];
      return path.join(base, first);
    }
  }
  // outside the roots: only a real git repo becomes an office (never temp or home folders)
  if (/^\/(private\/)?(tmp|var)\//.test(cwd) || cwd.startsWith(path.join(HOME, '.'))) return null;
  let d = cwd;
  while (d && d !== HOME && d !== path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) return d; d = path.dirname(d); }
  return null;
}

export function registerOffice(root, { team = null } = {}) {
  const g = globalDb();
  const existing = one(g, 'SELECT id FROM offices WHERE root = ?', root);
  if (existing) return existing.id;
  let id = slug(path.basename(root));
  if (id.startsWith('_')) id = 'k' + id;
  let n = 2; const base = id;
  while (one(g, 'SELECT 1 FROM offices WHERE id = ?', id)) id = `${base}-${n++}`;
  run(g, 'INSERT INTO offices (id, name, root, created_at) VALUES (?, ?, ?, ?)', id, path.basename(root), root, nowIso());
  invalidate(id);
  const model = officeModel(id);
  tx(officeDb(id), () => seedOffice(id, model, team));
  invalidate(id);
  return id;
}

export function listOffices() {
  return all(globalDb(), 'SELECT * FROM offices WHERE hidden = 0 ORDER BY created_at');
}

export function candidateFolders() {
  const known = new Set(all(globalDb(), 'SELECT root FROM offices').map(r => r.root));
  const out = [];
  for (const base of config().roots) {
    let names = [];
    try { names = fs.readdirSync(base); } catch {}
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      const p = path.join(base, n);
      if (isDir(p) && !known.has(p)) out.push({ root: p, name: n });
    }
  }
  return out;
}

export { newId };

/* ---------------- user-added rooms ---------------- */
/** One level of the office folder, for the folder picker. dir is relative to the office root. */
export function browseFolder(id, dir = '') {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  dir = String(dir || '').replace(/^\/+|\/+$/g, '');
  const abs = path.resolve(m.root, dir);
  if (abs !== m.root && !abs.startsWith(m.root + path.sep)) throw new Error('Folder di luar kantor');
  if (!isDir(abs)) throw new Error('Folder tidak ditemukan');
  const roomOf = rel => m.plan.rooms.find(r => r.path === rel || (r.aliases || []).includes(rel) || (r.worktrees || []).includes(rel));
  let names = [];
  try { names = fs.readdirSync(abs).sort((a, b) => a.localeCompare(b)); } catch {}
  const entries = [];
  for (const name of names) {
    if (name.startsWith('.') || SKIP.has(name)) continue;
    const full = path.join(abs, name);
    if (!isDir(full)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    let kids = false;
    try { kids = fs.readdirSync(full).some(n => !n.startsWith('.') && !SKIP.has(n) && isDir(path.join(full, n))); } catch {}
    entries.push({ name, rel, git: fs.existsSync(path.join(full, '.git')), stack: detectStack(full), md: fs.existsSync(path.join(full, 'CLAUDE.md')), room: roomOf(rel)?.name || null, kids });
    if (entries.length >= 300) break;
  }
  return { dir, root: m.root, info: folderInfo(abs, dir, roomOf(dir)?.name || null), entries };
}
function folderInfo(abs, rel, room) {
  let branch = null, readme = null, files = 0;
  try { const h = fs.readFileSync(path.join(abs, '.git', 'HEAD'), 'utf8'); branch = /ref: refs\/heads\/(.+)/.exec(h)?.[1]?.trim() || h.trim().slice(0, 8); } catch {}
  try { files = fs.readdirSync(abs).filter(n => !n.startsWith('.')).length; } catch {}
  for (const f of ['README.md', 'readme.md', 'README']) {
    try { readme = fs.readFileSync(path.join(abs, f), 'utf8').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('![') && !l.startsWith('<')) || null; break; } catch {}
  }
  return { rel, git: fs.existsSync(path.join(abs, '.git')), branch, stack: detectStack(abs), md: fs.existsSync(path.join(abs, 'CLAUDE.md')), readme: readme ? readme.slice(0, 200) : null, files, room };
}

/** The floor plan as it would look with one more room, without saving anything. */
export function previewRoom(id, { name, kind = 'kode', path: folder = '' }) {
  if (!ROOM_KINDS.includes(kind)) throw new Error('Jenis ruangan tidak dikenal');
  folder = String(folder || '').trim().replace(/^\/+|\/+$/g, '');
  const m = officeModel(id);
  const abs = folder ? path.join(m.root, folder) : null;
  const room = { id: '__pv', name: (name || '').trim() || (folder ? pretty(path.basename(folder)) : 'Ruangan baru'), kind, path: folder || null, extra: true, preview: true,
    stack: abs && isDir(abs) ? detectStack(abs) || 'folder' : '', md: abs ? fs.existsSync(path.join(abs, 'CLAUDE.md')) : false };
  return { model: officeModel(id, { preview: room }), room };
}

export const ROOM_KINDS = ['kode', 'meeting', 'lib', 'qa', 'server', 'pantry', 'beku', 'game', 'manager', 'musik', 'musholla', 'lounge', 'gym', 'taman', 'telepon', 'tidur'];
export function addRoom(id, { name, kind = 'kode', path: folder = '', create = false, gitInit = false }) {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  if (!name?.trim()) throw new Error('Nama ruangan wajib diisi');
  if (!ROOM_KINDS.includes(kind)) throw new Error('Jenis ruangan tidak dikenal');
  folder = String(folder || '').trim().replace(/^\/+|\/+$/g, '');
  if (folder && (folder.includes('..') || path.isAbsolute(folder))) throw new Error('Folder harus relatif terhadap folder kantor');
  if (folder) {
    const abs = path.join(m.root, folder);
    if (!fs.existsSync(abs)) {
      if (!create) throw new Error(`Folder ${folder} belum ada. Centang "buat folder" untuk membuatnya.`);
      fs.mkdirSync(abs, { recursive: true });
      if (gitInit) execFileSync('git', ['init', '-q'], { cwd: abs });
    }
    if (m.plan.rooms.some(r => r.path === folder)) throw new Error('Folder itu sudah punya ruangan');
  }
  const db = officeDb(id);
  const extra = j(one(db, "SELECT value FROM meta WHERE key = 'extraRooms'")?.value, []);
  let rid = slug(name);
  while (m.plan.rooms.some(r => r.id === rid) || extra.some(r => r.id === rid)) rid += '2';
  extra.push({ id: rid, name: name.trim(), kind, path: folder || null, stack: folder ? detectStack(path.join(m.root, folder)) || 'folder' : '' });
  run(db, "INSERT INTO meta (key, value) VALUES ('extraRooms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(extra));
  invalidate(id);
  return rid;
}
export function updateRoom(id, roomId, patch) {
  const db = officeDb(id);
  const extra = j(one(db, "SELECT value FROM meta WHERE key = 'extraRooms'")?.value, []);
  const ex = extra.find(r => r.id === roomId);
  if (patch.remove) {
    if (!ex) throw new Error('Hanya ruangan tambahan yang bisa dihapus. Ruangan dari repo bisa diganti nama atau dibekukan.');
    run(db, "UPDATE meta SET value = ? WHERE key = 'extraRooms'", JSON.stringify(extra.filter(r => r.id !== roomId)));
  } else if (ex) {
    if (patch.name) ex.name = patch.name.trim();
    if (patch.kind && ROOM_KINDS.includes(patch.kind)) ex.kind = patch.kind;
    if (patch.note !== undefined) ex.note = patch.note;
    run(db, "UPDATE meta SET value = ? WHERE key = 'extraRooms'", JSON.stringify(extra));
  } else {
    const ov = j(one(db, "SELECT value FROM meta WHERE key = 'rooms'")?.value, {});
    ov[roomId] = { ...(ov[roomId] || {}) };
    if (patch.name) ov[roomId].name = patch.name.trim();
    if (patch.note !== undefined) ov[roomId].note = patch.note;
    if (patch.frozen !== undefined) { if (patch.frozen) { ov[roomId].kind = 'beku'; ov[roomId].floor = 'frozen'; } else { delete ov[roomId].kind; delete ov[roomId].floor; } }
    run(db, "INSERT INTO meta (key, value) VALUES ('rooms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(ov));
  }
  invalidate(id);
}
