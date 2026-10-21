import fs from 'node:fs';
import path from 'node:path';
import { officeDb, all, one, run, tx, nowIso, newId, j } from './db.js';
import { bus, logOffice } from './live.js';
import { officeModel, slug } from './offices.js';
import { insertRole } from './seed.js';
import { PROJECTS_DIR } from './config.js';

export const COLS = ['Backlog', 'Siap', 'Dikerjakan', 'Review', 'Selesai'];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];
const changed = (office, what, extra = {}) => bus.emit('msg', { t: 'changed', office, what, ...extra });

export function colIndex(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return Math.max(0, Math.min(4, Number(v)));
  const i = COLS.findIndex(c => c.toLowerCase() === String(v).trim().toLowerCase());
  if (i < 0) throw new Error(`Kolom tidak dikenal: ${v}. Pilihan: ${COLS.join(', ')}`);
  return i;
}

/* ---------------- roles ---------------- */
export function roleRow(r) {
  return { id: r.id, name: r.name, title: r.title, model: r.model, room: r.room, color: r.color, hair: r.hair, skin: r.skin, hairStyle: r.hair_style,
    tie: !!r.tie, isMgr: !!r.is_mgr, persona: r.persona, skills: j(r.skills, []), notes: r.notes, budget: r.budget_usd, archived: !!r.archived, reportsTo: r.reports_to || null };
}
export function listRoles(office, { archived = false } = {}) {
  return all(officeDb(office), `SELECT * FROM roles ${archived ? '' : 'WHERE archived = 0'} ORDER BY ord, created_at`).map(roleRow);
}
export function getRole(office, id) { if (!id) return null; const r = one(officeDb(office), 'SELECT * FROM roles WHERE id = ?', id); return r ? roleRow(r) : null; }
export function createRole(office, f) {
  if (!f.name?.trim() || !f.title?.trim()) throw new Error('Nama dan jabatan wajib diisi');
  const db = officeDb(office);
  let id = slug(f.name).replace(/-/g, '') || newId('r');
  while (one(db, 'SELECT 1 FROM roles WHERE id = ?', id)) id = id + Math.floor(Math.random() * 9);
  const ord = (one(db, 'SELECT MAX(ord) m FROM roles')?.m ?? 0) + 1;
  insertRole(db, { id, name: f.name.trim(), title: f.title.trim(), model: f.model || 'sonnet', room: f.room, color: f.color || '#2F5D9E', hair: f.hair || '#2B1D14', skin: f.skin || '#F1C9A5',
    hairStyle: f.hairStyle || 'short', tie: !!f.tie, isMgr: !!f.isMgr, persona: f.persona || '', skills: f.skills || [], notes: '' }, ord);
  if (f.reportsTo) setBoss(db, id, f.reportsTo);
  logOffice(office, f.name.trim(), `bergabung sebagai ${f.title.trim()}${f.reportsTo ? `, anak buah ${one(db, 'SELECT name FROM roles WHERE id = ?', f.reportsTo)?.name || f.reportsTo}` : ''}`, 'role');
  changed(office, 'roles');
  return getRole(office, id);
}
// a boss must exist and must not end up reporting (directly or not) to its own subordinate
function setBoss(db, id, boss) {
  boss = boss || null;
  if (boss) {
    if (!one(db, 'SELECT 1 FROM roles WHERE id = ?', boss)) throw new Error('Atasan tidak ditemukan');
    for (let cur = boss, i = 0; cur && i < 50; cur = one(db, 'SELECT reports_to FROM roles WHERE id = ?', cur)?.reports_to, i++)
      if (cur === id) throw new Error('Atasan itu justru anak buahnya sendiri');
  }
  run(db, 'UPDATE roles SET reports_to = ? WHERE id = ?', boss, id);
}
export function updateRole(office, id, f) {
  const db = officeDb(office);
  const cur = one(db, 'SELECT * FROM roles WHERE id = ?', id);
  if (!cur) throw new Error('Role tidak ditemukan');
  const map = { name: 'name', title: 'title', model: 'model', room: 'room', color: 'color', hair: 'hair', skin: 'skin', hairStyle: 'hair_style', persona: 'persona', notes: 'notes', budget: 'budget_usd' };
  for (const [k, col] of Object.entries(map)) if (f[k] !== undefined) run(db, `UPDATE roles SET ${col} = ? WHERE id = ?`, f[k], id);
  if (f.skills !== undefined) run(db, 'UPDATE roles SET skills = ? WHERE id = ?', JSON.stringify(f.skills), id);
  if (f.tie !== undefined) run(db, 'UPDATE roles SET tie = ? WHERE id = ?', f.tie ? 1 : 0, id);
  if (f.isMgr !== undefined) run(db, 'UPDATE roles SET is_mgr = ? WHERE id = ?', f.isMgr ? 1 : 0, id);
  if (f.archived !== undefined) run(db, 'UPDATE roles SET archived = ? WHERE id = ?', f.archived ? 1 : 0, id);
  if (f.reportsTo !== undefined) setBoss(db, id, f.reportsTo);
  changed(office, 'roles');
  return getRole(office, id);
}
export function writeRoleNotes(office, id, text, mode = 'replace', by) {
  const r = getRole(office, id);
  if (!r) throw new Error('Role tidak ditemukan');
  const notes = mode === 'append' ? `${r.notes ? r.notes + '\n' : ''}${text}` : text;
  run(officeDb(office), 'UPDATE roles SET notes = ? WHERE id = ?', notes.slice(0, 20000), id);
  if (by) logOffice(office, by, `memperbarui buku catatan ${r.name}`, 'role');
  changed(office, 'roles');
  return notes;
}

/* ---------------- board ---------------- */
function cardRow(c, extra) {
  return { id: c.id, title: c.title, desc: c.desc, col: c.col, colName: COLS[c.col], who: c.who, repo: c.repo, prio: c.prio, due: c.due, blocked: c.blocked,
    epic: !!c.epic, epicId: c.epic_id, files: c.files, createdAt: c.created_at, updatedAt: c.updated_at, movedBy: c.moved_by, movedAt: c.moved_at, ord: c.ord, ...extra };
}
export function listCards(office) {
  const db = officeDb(office);
  const checks = all(db, 'SELECT card_id, COUNT(*) n, SUM(done) d FROM card_checks GROUP BY card_id');
  const comments = all(db, 'SELECT card_id, COUNT(*) n FROM card_comments GROUP BY card_id');
  const cm = new Map(checks.map(c => [c.card_id, c])), mm = new Map(comments.map(c => [c.card_id, c.n]));
  return all(db, 'SELECT * FROM cards WHERE archived = 0 ORDER BY col, ord, created_at').map(c => cardRow(c, {
    checks: { total: cm.get(c.id)?.n || 0, done: cm.get(c.id)?.d || 0 }, comments: mm.get(c.id) || 0 }));
}
export function getCard(office, id) {
  const db = officeDb(office);
  const c = one(db, 'SELECT * FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  return cardRow(c, {
    checklist: all(db, 'SELECT id, text, done FROM card_checks WHERE card_id = ? ORDER BY ord, id', id).map(x => ({ ...x, done: !!x.done })),
    comments: all(db, 'SELECT id, who, text, at FROM card_comments WHERE card_id = ? ORDER BY id', id),
    history: all(db, 'SELECT who, text, at FROM card_hist WHERE card_id = ? ORDER BY id DESC LIMIT 60', id),
    links: all(db, 'SELECT kind, value, at FROM card_links WHERE card_id = ? ORDER BY at DESC', id),
    children: c.epic ? all(db, 'SELECT id, title, col, repo, who FROM cards WHERE epic_id = ? AND archived = 0', id).map(x => ({ ...x, colName: COLS[x.col] })) : [],
  });
}
const hist = (db, id, who, text) => run(db, 'INSERT INTO card_hist (card_id, who, text, at) VALUES (?, ?, ?, ?)', id, who, text, nowIso());

export function createCard(office, f, by) {
  if (!f.title?.trim()) throw new Error('Judul kartu wajib diisi');
  const db = officeDb(office);
  const id = 'k' + newId().slice(0, 6);
  const t = nowIso();
  const col = colIndex(f.col) ?? 0;
  tx(db, () => {
    run(db, `INSERT INTO cards (id, title, desc, col, who, repo, prio, due, blocked, epic, epic_id, created_at, updated_at, moved_by, moved_at, ord)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, f.title.trim().slice(0, 200), f.desc || '', col, f.who || null, f.repo || '', PRIOS.includes(f.prio) ? f.prio : 'P2', f.due || '', f.blocked || '',
      f.epic ? 1 : 0, f.epicId || null, t, t, by, t, Date.now());
    hist(db, id, by, `membuat kartu di ${COLS[col]}`);
    (f.checklist || []).forEach((txt, i) => run(db, 'INSERT INTO card_checks (card_id, text, ord) VALUES (?, ?, ?)', id, String(txt).slice(0, 300), i));
    if (f.epicId) { run(db, 'UPDATE cards SET epic = 1 WHERE id = ?', f.epicId); }
  });
  logOffice(office, by, `membuat kartu "${f.title.trim().slice(0, 60)}"`, 'board');
  changed(office, 'board', { card: id });
  return getCard(office, id);
}

export function updateCard(office, id, f, by) {
  const db = officeDb(office);
  const c = one(db, 'SELECT * FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  const t = nowIso();
  tx(db, () => {
    if (f.title !== undefined && f.title.trim() && f.title !== c.title) { run(db, 'UPDATE cards SET title = ? WHERE id = ?', f.title.trim().slice(0, 200), id); hist(db, id, by, 'mengubah judul'); }
    if (f.desc !== undefined && f.desc !== c.desc) run(db, 'UPDATE cards SET desc = ? WHERE id = ?', f.desc, id);
    const col = colIndex(f.col);
    if (col !== undefined && col !== c.col) { run(db, 'UPDATE cards SET col = ?, moved_by = ?, moved_at = ? WHERE id = ?', col, by, t, id); hist(db, id, by, `memindahkan ${COLS[c.col]} → ${COLS[col]}`); }
    if (f.who !== undefined && (f.who || null) !== c.who) { run(db, 'UPDATE cards SET who = ? WHERE id = ?', f.who || null, id); hist(db, id, by, f.who ? `menugaskan ke ${f.whoName || f.who}` : 'melepas penugasan'); }
    if (f.prio !== undefined && PRIOS.includes(f.prio) && f.prio !== c.prio) { run(db, 'UPDATE cards SET prio = ? WHERE id = ?', f.prio, id); hist(db, id, by, `prioritas jadi ${f.prio}`); }
    if (f.repo !== undefined && f.repo !== c.repo) run(db, 'UPDATE cards SET repo = ? WHERE id = ?', f.repo, id);
    if (f.due !== undefined && f.due !== c.due) run(db, 'UPDATE cards SET due = ? WHERE id = ?', f.due, id);
    if (f.blocked !== undefined && f.blocked !== c.blocked) { run(db, 'UPDATE cards SET blocked = ? WHERE id = ?', f.blocked, id); hist(db, id, by, f.blocked ? `menandai terblokir: ${f.blocked}` : 'melepas blokir'); }
    if (f.epicId !== undefined && f.epicId !== c.epic_id) { run(db, 'UPDATE cards SET epic_id = ? WHERE id = ?', f.epicId || null, id); if (f.epicId) run(db, 'UPDATE cards SET epic = 1 WHERE id = ?', f.epicId); }
    if (f.ord !== undefined) run(db, 'UPDATE cards SET ord = ? WHERE id = ?', f.ord, id);
    run(db, 'UPDATE cards SET updated_at = ? WHERE id = ?', t, id);
  });
  const col = colIndex(f.col);
  if (col !== undefined && col !== c.col) logOffice(office, by, `memindahkan "${c.title.slice(0, 50)}" ke ${COLS[col]}`, 'board');
  changed(office, 'board', { card: id });
  return getCard(office, id);
}
export function archiveCard(office, id, by) {
  const db = officeDb(office);
  run(db, 'UPDATE cards SET archived = 1 WHERE id = ? OR epic_id = ?', id, id);
  hist(db, id, by, 'menghapus kartu');
  changed(office, 'board');
}
export function checkItem(office, id, { text, index, itemId, done, remove }, by) {
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM cards WHERE id = ?', id)) throw new Error(`Kartu ${id} tidak ditemukan`);
  const items = all(db, 'SELECT * FROM card_checks WHERE card_id = ? ORDER BY ord, id', id);
  let it = itemId ? items.find(x => x.id === Number(itemId)) : Number.isInteger(index) ? items[index] : text ? items.find(x => x.text.toLowerCase() === String(text).toLowerCase()) : null;
  if (remove) { if (it) { run(db, 'DELETE FROM card_checks WHERE id = ?', it.id); hist(db, id, by, `menghapus checklist "${it.text}"`); } }
  else if (!it && text) { run(db, 'INSERT INTO card_checks (card_id, text, done, ord) VALUES (?, ?, ?, ?)', id, String(text).slice(0, 300), done ? 1 : 0, items.length); hist(db, id, by, `menambah checklist "${text}"`); }
  else if (it) { run(db, 'UPDATE card_checks SET done = ? WHERE id = ?', done === undefined ? (it.done ? 0 : 1) : (done ? 1 : 0), it.id); hist(db, id, by, `${(done ?? !it.done) ? 'mencentang' : 'membatalkan'} "${it.text}"`); }
  else throw new Error('Item checklist tidak ditemukan');
  run(db, 'UPDATE cards SET updated_at = ? WHERE id = ?', nowIso(), id);
  changed(office, 'board', { card: id });
  return getCard(office, id);
}
export function commentCard(office, id, text, by) {
  if (!text?.trim()) throw new Error('Komentar kosong');
  const db = officeDb(office);
  const c = one(db, 'SELECT title FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  run(db, 'INSERT INTO card_comments (card_id, who, text, at) VALUES (?, ?, ?, ?)', id, by, text.trim().slice(0, 4000), nowIso());
  logOffice(office, by, `berkomentar di "${c.title.slice(0, 40)}"`, 'board');
  changed(office, 'board', { card: id });
  return getCard(office, id);
}
export function linkCard(office, id, kind, value) {
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM card_links WHERE card_id = ? AND kind = ? AND value = ?', id, kind, value))
    run(db, 'INSERT INTO card_links (card_id, kind, value, at) VALUES (?, ?, ?, ?)', id, kind, value, nowIso());
}

/* ---------------- notes ---------------- */
function noteRow(n) { return { id: n.id, title: n.title, body: n.body, color: n.color, tags: j(n.tags, []), pinned: !!n.pinned, wall: !!n.wall, archived: !!n.archived, deleted: !!n.deleted, room: n.room, author: n.author, createdAt: n.created_at, updatedAt: n.updated_at }; }
export function listNotes(office, { q = '', tag = '', view = 'aktif' } = {}) {
  const db = officeDb(office);
  const where = view === 'sampah' ? 'deleted = 1' : view === 'arsip' ? 'archived = 1 AND deleted = 0' : 'archived = 0 AND deleted = 0';
  let rows = all(db, `SELECT * FROM notes WHERE ${where} ORDER BY pinned DESC, updated_at DESC`).map(noteRow);
  if (q) { const s = q.toLowerCase(); rows = rows.filter(n => n.title.toLowerCase().includes(s) || n.body.toLowerCase().includes(s)); }
  if (tag) rows = rows.filter(n => n.tags.includes(tag));
  return rows;
}
export function getNote(office, id) { const n = one(officeDb(office), 'SELECT * FROM notes WHERE id = ?', id); if (!n) throw new Error('Catatan tidak ditemukan'); return noteRow(n); }
export function saveNote(office, f, by) {
  const db = officeDb(office);
  const t = nowIso();
  const tags = Array.isArray(f.tags) ? f.tags : (f.tags ? String(f.tags).split(',') : []);
  const cleanTags = [...new Set(tags.map(x => String(x).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 12);
  if (f.id) {
    const cur = one(db, 'SELECT * FROM notes WHERE id = ?', f.id);
    if (!cur) throw new Error('Catatan tidak ditemukan');
    run(db, `UPDATE notes SET title = ?, body = ?, color = ?, tags = ?, pinned = ?, wall = ?, archived = ?, deleted = ?, room = ?, updated_at = ? WHERE id = ?`,
      f.title ?? cur.title, f.body ?? cur.body, f.color ?? cur.color, JSON.stringify(f.tags !== undefined ? cleanTags : j(cur.tags, [])),
      f.pinned !== undefined ? (f.pinned ? 1 : 0) : cur.pinned, f.wall !== undefined ? (f.wall ? 1 : 0) : cur.wall,
      f.archived !== undefined ? (f.archived ? 1 : 0) : cur.archived, f.deleted !== undefined ? (f.deleted ? 1 : 0) : cur.deleted, f.room ?? cur.room, t, f.id);
    changed(office, 'notes', { note: f.id });
    return getNote(office, f.id);
  }
  const id = newId('n');
  run(db, `INSERT INTO notes (id, title, body, color, tags, pinned, wall, room, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, f.title || '', f.body || '', f.color || 'kuning', JSON.stringify(cleanTags), f.pinned ? 1 : 0, f.wall ? 1 : 0, f.room || null, by, t, t);
  if (by !== 'Kamu') logOffice(office, by, `menulis catatan "${(f.title || 'tanpa judul').slice(0, 40)}"`, 'notes');
  changed(office, 'notes', { note: id });
  return getNote(office, id);
}
export function purgeNote(office, id) { run(officeDb(office), 'DELETE FROM notes WHERE id = ? AND deleted = 1', id); changed(office, 'notes'); }
export function noteTags(office) {
  const counts = {};
  for (const n of all(officeDb(office), 'SELECT tags FROM notes WHERE deleted = 0')) for (const t of j(n.tags, [])) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n }));
}

/* ---------------- wiki ---------------- */
export const wikiSlug = t => slug(t).replace(/^-|-$/g, '') || 'halaman';
export function listWiki(office) {
  return all(officeDb(office), 'SELECT slug, title, author, updated_at FROM wiki ORDER BY title COLLATE NOCASE');
}
function findPage(db, ref) {
  return one(db, 'SELECT * FROM wiki WHERE slug = ?', ref) || one(db, 'SELECT * FROM wiki WHERE slug = ?', wikiSlug(ref)) || one(db, 'SELECT * FROM wiki WHERE title = ? COLLATE NOCASE', ref);
}
export function getWiki(office, ref) {
  const db = officeDb(office);
  const p = findPage(db, ref);
  if (!p) return null;
  const backlinks = all(db, 'SELECT slug, title, body FROM wiki WHERE slug != ?', p.slug)
    .filter(x => new RegExp(`\\[\\[(${escapeRe(p.title)}|${escapeRe(p.slug)})(\\|[^\\]]*)?\\]\\]`, 'i').test(x.body)).map(x => ({ slug: x.slug, title: x.title }));
  const revs = one(db, 'SELECT COUNT(*) n FROM wiki_revs WHERE slug = ?', p.slug).n;
  return { slug: p.slug, title: p.title, body: p.body, author: p.author, createdAt: p.created_at, updatedAt: p.updated_at, backlinks, revs };
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function saveWiki(office, { slug: s, title, body, msg, prevSlug }, by) {
  if (!title?.trim()) throw new Error('Judul halaman wajib diisi');
  const db = officeDb(office);
  const t = nowIso();
  const target = s || wikiSlug(title);
  return tx(db, () => {
    const cur = one(db, 'SELECT * FROM wiki WHERE slug = ?', prevSlug || target);
    if (cur && prevSlug && prevSlug !== target) {
      if (one(db, 'SELECT 1 FROM wiki WHERE slug = ?', target)) throw new Error('Sudah ada halaman dengan alamat itu');
      run(db, 'UPDATE wiki SET slug = ? WHERE slug = ?', target, prevSlug);
      run(db, 'UPDATE wiki_revs SET slug = ? WHERE slug = ?', target, prevSlug);
    }
    if (cur) run(db, 'UPDATE wiki SET title = ?, body = ?, author = ?, updated_at = ? WHERE slug = ?', title.trim(), body || '', by, t, target);
    else run(db, 'INSERT INTO wiki (slug, title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', target, title.trim(), body || '', by, t, t);
    run(db, 'INSERT INTO wiki_revs (slug, title, body, author, at, msg) VALUES (?, ?, ?, ?, ?, ?)', target, title.trim(), body || '', by, t, msg || (cur ? 'Perubahan' : 'Halaman baru'));
    if (by !== 'Kamu') logOffice(office, by, `${cur ? 'memperbarui' : 'membuat'} wiki "${title.trim().slice(0, 40)}"`, 'wiki');
    changed(office, 'wiki', { slug: target });
    return getWiki(office, target);
  });
}
export function deleteWiki(office, s) { const db = officeDb(office); run(db, 'DELETE FROM wiki WHERE slug = ?', s); changed(office, 'wiki'); }
export function wikiRevs(office, s) { return all(officeDb(office), 'SELECT id, title, author, at, msg, length(body) size FROM wiki_revs WHERE slug = ? ORDER BY id DESC', s); }
export function wikiRev(office, id) { return one(officeDb(office), 'SELECT * FROM wiki_revs WHERE id = ?', id); }
export function searchWiki(office, q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return [];
  const words = s.split(/\s+/);
  return all(officeDb(office), 'SELECT slug, title, body, updated_at FROM wiki').map(p => {
    const hay = (p.title + '\n' + p.body).toLowerCase();
    const score = words.reduce((a, w) => a + (hay.split(w).length - 1) + (p.title.toLowerCase().includes(w) ? 5 : 0), 0);
    if (!score) return null;
    const i = p.body.toLowerCase().indexOf(words[0]);
    return { slug: p.slug, title: p.title, score, snippet: i >= 0 ? p.body.slice(Math.max(0, i - 60), i + 140).replace(/\s+/g, ' ') : p.body.slice(0, 160).replace(/\s+/g, ' ') };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 20);
}
/** Read-only sources shown beside the wiki: CLAUDE.md files of each room and Claude's memory files. */
export function wikiSources(office) {
  const m = officeModel(office);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  const add = (kind, label, file) => { if (seen.has(file) || !fs.existsSync(file)) return; seen.add(file); out.push({ kind, label, file, size: fs.statSync(file).size }); };
  add('claude-md', 'CLAUDE.md (induk)', path.join(m.root, 'CLAUDE.md'));
  for (const r of m.plan.rooms) if (r.path) { add('claude-md', `CLAUDE.md · ${r.path}`, path.join(m.root, r.path, 'CLAUDE.md')); add('claude-md', `AGENTS.md · ${r.path}`, path.join(m.root, r.path, 'AGENTS.md')); }
  // memory dirs for this office's project folders
  const enc = p => p.replace(/[^A-Za-z0-9]/g, '-');
  const prefixes = [m.root, ...m.plan.rooms.filter(r => r.path).map(r => path.join(m.root, r.path))].map(enc);
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const d of dirs) if (prefixes.includes(d)) {
    const mem = path.join(PROJECTS_DIR, d, 'memory');
    let files = [];
    try { files = fs.readdirSync(mem).filter(f => f.endsWith('.md')); } catch {}
    for (const f of files) add('memory', `Memori · ${f.replace(/\.md$/, '')}`, path.join(mem, f));
  }
  return out;
}
export function readSource(office, file) {
  const ok = wikiSources(office).find(s => s.file === file);
  if (!ok) throw new Error('Sumber tidak dikenal');
  return fs.readFileSync(file, 'utf8').slice(0, 200000);
}

/* ---------------- news + log ---------------- */
export function listNews(office) { return all(officeDb(office), 'SELECT id, text, at, author FROM news ORDER BY id DESC LIMIT 20'); }
export function addNews(office, text, by) { if (!text?.trim()) throw new Error('Pengumuman kosong'); run(officeDb(office), 'INSERT INTO news (text, at, author) VALUES (?, ?, ?)', text.trim().slice(0, 500), nowIso(), by); logOffice(office, by, `mengumumkan: ${text.trim().slice(0, 60)}`, 'news'); changed(office, 'news'); }
export function delNews(office, id) { run(officeDb(office), 'DELETE FROM news WHERE id = ?', id); changed(office, 'news'); }
export function listLog(office, limit = 60) { return all(officeDb(office), 'SELECT who, text, at, kind FROM log ORDER BY id DESC LIMIT ?', limit); }

export function listShifts(office, limit = 80) {
  return all(officeDb(office), 'SELECT * FROM shifts ORDER BY started_at DESC LIMIT ?', limit);
}
