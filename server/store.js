import fs from 'node:fs';
import path from 'node:path';
import { officeDb, all, one, run, tx, nowIso, newId, j } from './db.js';
import { bus, logOffice } from './live.js';
import { officeModel, slug } from './offices.js';
import { insertRole } from './seed.js';
import { PROJECTS_DIR, config } from './config.js';
import crypto from 'node:crypto';
import * as bd from './boards.js';
import { who, isHuman } from './actor.js';

export const COLS = ['Backlog', 'Siap', 'Dikerjakan', 'Review', 'Selesai'];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];
/** Nama kolom untuk baris kartu mentah (dari SQL): papannya + indeks kolom. */
export function colNameOf(office, c) {
  try { return bd.nameAt(bd.getBoard(office, c.board || bd.DEFAULT_BOARD), c.col); } catch { return COLS[c.col] || String(c.col); }
}
const changed = (office, what, extra = {}) => bus.emit('msg', { t: 'changed', office, what, ...extra });

/** Indeks kolom dari input (angka, nama/id kolom, kind, atau nama kolom lama) di sebuah papan (bawaan Utama). */
export function colIndex(v, board) {
  return bd.colIn(board || bd.TEMPLATES.dev, v);
}

/* ---------------- roles ---------------- */
export function roleRow(r) {
  return { id: r.id, name: r.name, title: r.title, model: r.model, room: r.room, color: r.color, hair: r.hair, skin: r.skin, hairStyle: r.hair_style, outfit: r.outfit || 'kemeja', acc: r.acc || '', hijab: r.hijab || '#E8EEF8',
    engine: r.engine === 'codex' ? 'codex' : 'claude', effort: r.effort || null, tie: !!r.tie, isMgr: !!r.is_mgr, persona: r.persona, skills: j(r.skills, []), notes: r.notes, budget: r.budget_usd, archived: !!r.archived, reportsTo: r.reports_to || null };
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
  insertRole(db, { id, name: f.name.trim(), title: f.title.trim(), model: f.model || (f.engine === 'codex' ? '' : 'sonnet'), room: f.room, color: f.color || '#2F5D9E', hair: f.hair || '#2B1D14', skin: f.skin || '#F1C9A5',
    hairStyle: f.hairStyle || 'short', outfit: f.outfit, acc: f.acc, hijab: f.hijab, tie: !!f.tie, isMgr: !!f.isMgr, persona: f.persona || '', skills: f.skills || [], notes: '' }, ord);
  if (f.engine === 'codex') run(db, 'UPDATE roles SET engine = ?, effort = ? WHERE id = ?', 'codex', f.effort || null, id);
  if (Number(f.budget) > 0) run(db, 'UPDATE roles SET budget_usd = ? WHERE id = ?', Number(f.budget), id);
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
  if (f.budget !== undefined) { const n = Number(f.budget); f = { ...f, budget: Number.isFinite(n) && n > 0 ? n : null }; } // empty or 0 = no limit
  const map = { name: 'name', title: 'title', model: 'model', room: 'room', color: 'color', hair: 'hair', skin: 'skin', hairStyle: 'hair_style', outfit: 'outfit', acc: 'acc', hijab: 'hijab', persona: 'persona', notes: 'notes', budget: 'budget_usd', effort: 'effort' };
  for (const [k, col] of Object.entries(map)) if (f[k] !== undefined) run(db, `UPDATE roles SET ${col} = ? WHERE id = ?`, f[k], id);
  if (f.engine !== undefined) run(db, 'UPDATE roles SET engine = ? WHERE id = ?', f.engine === 'codex' ? 'codex' : null, id);
  if (f.skills !== undefined) run(db, 'UPDATE roles SET skills = ? WHERE id = ?', JSON.stringify(f.skills), id);
  if (f.tie !== undefined) run(db, 'UPDATE roles SET tie = ? WHERE id = ?', f.tie ? 1 : 0, id);
  if (f.isMgr !== undefined) run(db, 'UPDATE roles SET is_mgr = ? WHERE id = ?', f.isMgr ? 1 : 0, id);
  if (f.archived !== undefined) run(db, 'UPDATE roles SET archived = ? WHERE id = ?', f.archived ? 1 : 0, id);
  if (f.reportsTo !== undefined) setBoss(db, id, f.reportsTo);
  changed(office, 'roles');
  return getRole(office, id);
}
/** Put roles in this order (the strip, the Role tab); ids not listed keep their place after these. */
export function orderRoles(office, ids) {
  const db = officeDb(office);
  const all_ = all(db, 'SELECT id FROM roles ORDER BY ord, created_at').map(r => r.id);
  const want = (ids || []).filter(x => all_.includes(x));
  [...want, ...all_.filter(x => !want.includes(x))].forEach((x, i) => run(db, 'UPDATE roles SET ord = ? WHERE id = ?', i, x));
  return listRoles(office);
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
// col = indeks kolom di papan kartu itu; colKind = jenis kolomnya; stage = nomor kolom lama (0..4) menurut jenis; done = jenis 'selesai'
function cardRow(c, extra, boards, office) {
  const b = boards?.get(c.board || bd.DEFAULT_BOARD), kind = c.kind || bd.kindAt(b, c.col);
  return { id: c.id, title: c.title, desc: c.desc, col: c.col, colName: b ? bd.nameAt(b, c.col) : COLS[c.col], colKind: kind, stage: bd.KIND_IDX[kind] ?? 0, done: kind === 'selesai',
    board: c.board || bd.DEFAULT_BOARD, boardName: b?.name || c.board, publishAt: c.publish_at || '', coverUrl: coverUrl(office, c.cover), who: c.who, repo: c.repo, prio: c.prio, due: c.due, blocked: c.blocked,
    epic: !!c.epic, epicId: c.epic_id, files: c.files, createdAt: c.created_at, updatedAt: c.updated_at, movedBy: c.moved_by, movedAt: c.moved_at, ord: c.ord,
    start: c.start || '', estDays: c.est_days ?? null, progress: c.progress ?? null, labels: j(c.labels, []), milestone: !!c.milestone, cover: c.cover || null, ...extra };
}
/** Sampul kartu: id media, atau "pv:<idPratinjau>:<idBerkas>" (berkas dari pratinjau). */
function coverUrl(office, cover) {
  if (!cover || !office) return null;
  const o = encodeURIComponent(office);
  const m = /^pv:([^:]+):(.+)$/.exec(cover);
  // gambar kecil bertanda tangan dari pratinjau (sama dengan keyOf di pratinjau.js; tidak diimpor supaya tidak melingkar)
  if (m) return `/pvt/${o}/${m[1]}/${crypto.createHmac('sha256', String(config().token || '')).update(`pratinjau:${office}:${m[1]}`).digest('hex').slice(0, 24)}/${encodeURIComponent(m[2])}.jpg`;
  return `/api/offices/${o}/media/${encodeURIComponent(cover)}`;
}
/** Catat perpindahan kolom terstruktur (untuk metrik dan segmen tahap di Timeline). */
function logMove(db, id, board, from, to, by, at) {
  run(db, 'INSERT INTO card_moves (card_id, board, from_col, to_col, from_kind, to_kind, from_name, to_name, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, board.id, from?.col ?? null, to.col, from ? from.kind : null, to.kind, from ? from.name : null, to.name, by || null, at || nowIso());
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = v => { v = String(v || '').slice(0, 10); if (v && !DATE.test(v)) throw new Error(`Tanggal harus YYYY-MM-DD: ${v}`); return v; };
// a card may not depend on itself, directly or through others
function setDeps(db, id, deps, by) {
  deps = [...new Set((deps || []).map(String).filter(d => d && d !== id))];
  for (const d of deps) {
    if (!one(db, 'SELECT 1 FROM cards WHERE id = ?', d)) throw new Error(`Kartu ${d} tidak ditemukan`);
    const seen = new Set(), stack = [d];
    while (stack.length) { const x = stack.pop(); if (x === id) throw new Error(`Dependensi melingkar: ${d} sudah bergantung pada ${id}`); if (seen.has(x)) continue; seen.add(x); stack.push(...all(db, 'SELECT dep_id FROM card_deps WHERE card_id = ?', x).map(r => r.dep_id)); }
  }
  const before = all(db, 'SELECT dep_id FROM card_deps WHERE card_id = ?', id).map(r => r.dep_id).sort().join();
  run(db, 'DELETE FROM card_deps WHERE card_id = ?', id);
  for (const d of deps) run(db, 'INSERT INTO card_deps (card_id, dep_id) VALUES (?, ?)', id, d);
  if (before !== [...deps].sort().join()) hist(db, id, by, deps.length ? `menunggu ${deps.join(', ')}` : 'melepas dependensi');
}
function setLabels(db, labels) {
  // labels by id or by name; unknown names become new labels
  return [...new Set((labels || []).map(l => {
    const v = String(l).trim(); if (!v) return null;
    const hit = one(db, 'SELECT id FROM labels WHERE id = ? OR name = ? COLLATE NOCASE', v, v);
    if (hit) return hit.id;
    const id = 'l' + newId().slice(0, 5), n = one(db, 'SELECT COUNT(*) n FROM labels').n;
    run(db, 'INSERT INTO labels (id, name, color, ord) VALUES (?, ?, ?, ?)', id, v.slice(0, 40), LABEL_COLORS[n % LABEL_COLORS.length], n);
    return id;
  }).filter(Boolean))];
}
const LABEL_COLORS = ['#D2553F', '#D98A1E', '#3E9A5B', '#2F7F86', '#4F79B8', '#7A3E9D', '#C2417A', '#8B818B'];
export function listLabels(office) { return all(officeDb(office), 'SELECT id, name, color, ord FROM labels ORDER BY ord, name'); }
export function saveLabel(office, { id, name, color }) {
  const db = officeDb(office);
  if (!name?.trim()) throw new Error('Nama label wajib diisi');
  if (id && one(db, 'SELECT 1 FROM labels WHERE id = ?', id)) run(db, 'UPDATE labels SET name = ?, color = COALESCE(?, color) WHERE id = ?', name.trim().slice(0, 40), color || null, id);
  else { id = setLabels(db, [name])[0]; if (color) run(db, 'UPDATE labels SET color = ? WHERE id = ?', color, id); }
  changed(office, 'board');
  return one(db, 'SELECT id, name, color, ord FROM labels WHERE id = ?', id);
}
export function deleteLabel(office, id) {
  const db = officeDb(office);
  run(db, 'DELETE FROM labels WHERE id = ?', id);
  for (const c of all(db, "SELECT id, labels FROM cards WHERE labels LIKE ?", `%${id}%`)) run(db, 'UPDATE cards SET labels = ? WHERE id = ?', JSON.stringify(j(c.labels, []).filter(x => x !== id)), c.id);
  changed(office, 'board');
}
/** Kartu aktif. opts.board: id/nama papan, atau kosong/'all' = semua papan. */
export function listCards(office, opts = {}) {
  const db = officeDb(office);
  const boards = bd.boardMap(db);
  const only = opts.board && opts.board !== 'all' ? bd.resolveBoard(office, opts.board).id : null;
  const checks = all(db, 'SELECT card_id, COUNT(*) n, SUM(done) d FROM card_checks GROUP BY card_id');
  const comments = all(db, 'SELECT card_id, COUNT(*) n FROM card_comments GROUP BY card_id');
  const cm = new Map(checks.map(c => [c.card_id, c])), mm = new Map(comments.map(c => [c.card_id, c.n]));
  const deps = all(db, 'SELECT card_id, dep_id FROM card_deps'), att = all(db, "SELECT ref, COUNT(*) n FROM media_use WHERE kind = 'card' GROUP BY ref");
  const am = new Map(att.map(a => [a.ref, a.n]));
  return all(db, `SELECT * FROM cards WHERE archived = 0 ${only ? 'AND board = ?' : ''} ORDER BY col, ord, created_at`, ...(only ? [only] : [])).map(c => cardRow(c, {
    checks: { total: cm.get(c.id)?.n || 0, done: cm.get(c.id)?.d || 0 }, comments: mm.get(c.id) || 0,
    deps: deps.filter(d => d.card_id === c.id).map(d => d.dep_id), attachments: am.get(c.id) || 0 }, boards, office));
}
/** Riwayat pindah kolom per kartu (untuk segmen tahap di Timeline): { idKartu: [{at, board, toCol, toKind, toName}] }. */
export function cardMoves(office, ids) {
  const db = officeDb(office), out = {};
  const want = ids ? new Set(ids) : null;
  for (const m of all(db, 'SELECT card_id, board, to_col, to_kind, to_name, at FROM card_moves ORDER BY at, id')) {
    if (want && !want.has(m.card_id)) continue;
    (out[m.card_id] ||= []).push({ at: m.at, board: m.board, toCol: m.to_col, toKind: m.to_kind, toName: m.to_name });
  }
  return out;
}
export function getCard(office, id) {
  const db = officeDb(office);
  const c = one(db, 'SELECT * FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  const boards = bd.boardMap(db);
  const lite = x => { const b = boards.get(x.board || bd.DEFAULT_BOARD); return { id: x.id, title: x.title, col: x.col, repo: x.repo, who: x.who, board: x.board || bd.DEFAULT_BOARD,
    colName: b ? bd.nameAt(b, x.col) : COLS[x.col], colKind: x.kind, done: x.kind === 'selesai' }; };
  return cardRow(c, {
    checklist: all(db, 'SELECT id, text, done FROM card_checks WHERE card_id = ? ORDER BY ord, id', id).map(x => ({ ...x, done: !!x.done })),
    comments: all(db, 'SELECT id, who, text, at FROM card_comments WHERE card_id = ? ORDER BY id', id),
    history: all(db, 'SELECT who, text, at FROM card_hist WHERE card_id = ? ORDER BY id DESC LIMIT 60', id),
    links: all(db, 'SELECT kind, value, at FROM card_links WHERE card_id = ? ORDER BY at DESC', id),
    children: c.epic ? all(db, 'SELECT id, title, col, repo, who, board, kind FROM cards WHERE epic_id = ? AND archived = 0', id).map(lite) : [],
    deps: all(db, 'SELECT d.dep_id id, c.title, c.col, c.repo, c.who, c.board, c.kind FROM card_deps d LEFT JOIN cards c ON c.id = d.dep_id WHERE d.card_id = ?', id).map(lite),
    blocks: all(db, 'SELECT d.card_id id, c.title, c.col, c.repo, c.who, c.board, c.kind FROM card_deps d LEFT JOIN cards c ON c.id = d.card_id WHERE d.dep_id = ?', id).map(lite),
    moves: all(db, 'SELECT board, from_col fromCol, to_col toCol, from_kind fromKind, to_kind toKind, from_name fromName, to_name toName, by, at FROM card_moves WHERE card_id = ? ORDER BY at, id', id),
    attachments: all(db, "SELECT m.* FROM media_use u JOIN media m ON m.id = u.media_id WHERE u.kind = 'card' AND u.ref = ? ORDER BY u.at", id)
      .map(m => ({ id: m.id, name: m.name, mime: m.mime, size: m.size, url: `/api/offices/${encodeURIComponent(office)}/media/${m.id}`, image: /^image\//.test(m.mime) })),
  }, boards, office);
}
const hist = (db, id, who, text) => run(db, 'INSERT INTO card_hist (card_id, who, text, at) VALUES (?, ?, ?, ?)', id, who, text, nowIso());

export function createCard(office, f, by) {
  if (!f.title?.trim()) throw new Error('Judul kartu wajib diisi');
  const db = officeDb(office);
  const id = 'k' + newId().slice(0, 6);
  const t = nowIso();
  // papan: eksplisit, lalu papan induk epic, lalu Utama
  const board = f.board ? bd.resolveBoard(office, f.board) : f.epicId && one(db, 'SELECT board FROM cards WHERE id = ?', f.epicId) ? bd.resolveBoard(office, one(db, 'SELECT board FROM cards WHERE id = ?', f.epicId).board) : bd.resolveBoard(office);
  if (board.archived) throw new Error(`Papan ${board.name} sudah diarsipkan`);
  const col = bd.colIn(board, f.col) ?? 0, kind = bd.kindAt(board, col);
  tx(db, () => {
    run(db, `INSERT INTO cards (id, title, desc, col, who, repo, prio, due, blocked, epic, epic_id, created_at, updated_at, moved_by, moved_at, ord, board, kind, publish_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, f.title.trim().slice(0, 200), f.desc || '', col, f.who || null, f.repo || '', PRIOS.includes(f.prio) ? f.prio : 'P2', f.due || '', f.blocked || '',
      f.epic ? 1 : 0, f.epicId || null, t, t, by, t, Date.now(), board.id, kind, day(f.publishAt));
    hist(db, id, by, `membuat kartu di ${bd.nameAt(board, col)}${board.id === bd.DEFAULT_BOARD ? '' : ` (papan ${board.name})`}`);
    logMove(db, id, board, null, { col, kind, name: bd.nameAt(board, col) }, by, t);
    if (f.cover) run(db, 'UPDATE cards SET cover = ? WHERE id = ?', String(f.cover), id);
    (f.checklist || []).forEach((txt, i) => run(db, 'INSERT INTO card_checks (card_id, text, ord) VALUES (?, ?, ?)', id, String(txt).slice(0, 300), i));
    if (f.ord !== undefined) run(db, 'UPDATE cards SET ord = ? WHERE id = ?', Number(f.ord) || 0, id);
    run(db, 'UPDATE cards SET start = ?, due = ?, est_days = ?, progress = ?, labels = ?, milestone = ? WHERE id = ?', day(f.start), day(f.due), f.estDays ?? null, f.progress ?? null,
      JSON.stringify(setLabels(db, f.labels)), f.milestone ? 1 : 0, id);
    if (f.deps?.length) setDeps(db, id, f.deps, by);
    if (f.epicId) { run(db, 'UPDATE cards SET epic = 1 WHERE id = ?', f.epicId); }
  });
  logOffice(office, by, `membuat kartu "${f.title.trim().slice(0, 60)}"`, 'board');
  changed(office, 'board', { card: id, created: true, by });
  return getCard(office, id);
}

export function updateCard(office, id, f, by) {
  const db = officeDb(office);
  const c = one(db, 'SELECT * FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  const t = nowIso();
  // pindah kolom dan/atau papan. Pindah papan tanpa kolom: kolom pertama dengan jenis yang sama, kalau tidak ada kolom pertama.
  const fromBoard = bd.resolveBoard(office, c.board || bd.DEFAULT_BOARD), fromName = bd.nameAt(fromBoard, c.col);
  let mv = null;
  {
    const toBoard = f.board !== undefined && f.board !== null && f.board !== '' ? bd.resolveBoard(office, f.board) : fromBoard;
    if (toBoard.id !== fromBoard.id && toBoard.archived) throw new Error(`Papan ${toBoard.name} sudah diarsipkan`);
    let col = bd.colIn(toBoard, f.col);
    if (col === undefined && toBoard.id !== fromBoard.id) col = bd.firstOfKind(toBoard, c.kind) ?? 0;
    if (col !== undefined && (col !== c.col || toBoard.id !== fromBoard.id)) mv = { board: toBoard, col, kind: bd.kindAt(toBoard, col), name: bd.nameAt(toBoard, col) };
  }
  tx(db, () => {
    if (f.title !== undefined && f.title.trim() && f.title !== c.title) { run(db, 'UPDATE cards SET title = ? WHERE id = ?', f.title.trim().slice(0, 200), id); hist(db, id, by, 'mengubah judul'); }
    if (f.desc !== undefined && f.desc !== c.desc) run(db, 'UPDATE cards SET desc = ? WHERE id = ?', f.desc, id);
    if (mv) {
      run(db, 'UPDATE cards SET board = ?, col = ?, kind = ?, moved_by = ?, moved_at = ? WHERE id = ?', mv.board.id, mv.col, mv.kind, by, t, id);
      hist(db, id, by, mv.board.id !== fromBoard.id ? `memindahkan ke papan ${mv.board.name} (${mv.name})` : `memindahkan ${fromName} → ${mv.name}`);
      logMove(db, id, mv.board, { col: c.col, kind: c.kind, name: fromName }, mv, by, t);
    }
    if (f.publishAt !== undefined && day(f.publishAt) !== (c.publish_at || '')) { run(db, 'UPDATE cards SET publish_at = ? WHERE id = ?', day(f.publishAt), id); hist(db, id, by, f.publishAt ? `tanggal tayang ${day(f.publishAt)}` : 'menghapus tanggal tayang'); }
    if (f.who !== undefined && (f.who || null) !== c.who) { run(db, 'UPDATE cards SET who = ? WHERE id = ?', f.who || null, id); hist(db, id, by, f.who ? `menugaskan ke ${f.whoName || f.who}` : 'melepas penugasan'); }
    if (f.prio !== undefined && PRIOS.includes(f.prio) && f.prio !== c.prio) { run(db, 'UPDATE cards SET prio = ? WHERE id = ?', f.prio, id); hist(db, id, by, `prioritas jadi ${f.prio}`); }
    if (f.repo !== undefined && f.repo !== c.repo) run(db, 'UPDATE cards SET repo = ? WHERE id = ?', f.repo, id);
    if (f.due !== undefined && day(f.due) !== c.due) { run(db, 'UPDATE cards SET due = ? WHERE id = ?', day(f.due), id); hist(db, id, by, f.due ? `tenggat ${day(f.due)}` : 'menghapus tenggat'); }
    if (f.blocked !== undefined && f.blocked !== c.blocked) { run(db, 'UPDATE cards SET blocked = ? WHERE id = ?', f.blocked, id); hist(db, id, by, f.blocked ? `menandai terblokir: ${f.blocked}` : 'melepas blokir'); }
    if (f.epicId !== undefined && f.epicId !== c.epic_id) { run(db, 'UPDATE cards SET epic_id = ? WHERE id = ?', f.epicId || null, id); if (f.epicId) run(db, 'UPDATE cards SET epic = 1 WHERE id = ?', f.epicId); }
    if (f.ord !== undefined) run(db, 'UPDATE cards SET ord = ? WHERE id = ?', f.ord, id);
    if (f.start !== undefined && day(f.start) !== (c.start || '')) { run(db, 'UPDATE cards SET start = ? WHERE id = ?', day(f.start), id); hist(db, id, by, f.start ? `mulai ${day(f.start)}` : 'menghapus tanggal mulai'); }
    if (f.estDays !== undefined) run(db, 'UPDATE cards SET est_days = ? WHERE id = ?', f.estDays === null || f.estDays === '' ? null : Math.max(0, Number(f.estDays) || 0), id);
    if (f.progress !== undefined) run(db, 'UPDATE cards SET progress = ? WHERE id = ?', f.progress === null || f.progress === '' ? null : Math.max(0, Math.min(100, Math.round(Number(f.progress) || 0))), id);
    if (f.labels !== undefined) run(db, 'UPDATE cards SET labels = ? WHERE id = ?', JSON.stringify(setLabels(db, f.labels)), id);
    if (f.milestone !== undefined) run(db, 'UPDATE cards SET milestone = ? WHERE id = ?', f.milestone ? 1 : 0, id);
    if (f.cover !== undefined) run(db, 'UPDATE cards SET cover = ? WHERE id = ?', f.cover || null, id);
    if (f.deps !== undefined) setDeps(db, id, f.deps, by);
    run(db, 'UPDATE cards SET updated_at = ? WHERE id = ?', t, id);
  });
  if (mv) logOffice(office, by, `memindahkan "${c.title.slice(0, 50)}" ke ${mv.name}${mv.board.id !== fromBoard.id || mv.board.id !== bd.DEFAULT_BOARD ? ` (papan ${mv.board.name})` : ''}`, 'board');
  changed(office, 'board', { card: id, from: { col: c.col, kind: c.kind, board: c.board || bd.DEFAULT_BOARD, who: c.who || null }, by });
  return getCard(office, id);
}
export function archiveCard(office, id, by) {
  const db = officeDb(office);
  run(db, 'UPDATE cards SET archived = 1 WHERE id = ? OR epic_id = ?', id, id);
  run(db, 'DELETE FROM card_deps WHERE card_id = ? OR dep_id = ?', id, id);
  hist(db, id, by, 'menghapus kartu');
  changed(office, 'board');
}
/** Card id from what an agent typed: exact id, "#id", other casing, or a unique id prefix. Returns the input untouched when nothing matches (callers throw their own error). */
export function resolveCardId(office, ref) {
  const raw = String(ref ?? '').trim().replace(/^#/, '');
  if (!raw) return ref;
  const db = officeDb(office);
  if (one(db, 'SELECT 1 FROM cards WHERE id = ?', raw)) return raw;
  const hits = all(db, "SELECT id FROM cards WHERE lower(id) = lower(?) OR lower(id) LIKE lower(?) || '%' LIMIT 3", raw, raw.replace(/[%_]/g, ''));
  return hits.length === 1 ? hits[0].id : ref;
}
const plainItem = t => String(t || '').toLowerCase().replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]?\]\s*)?(?:#?\d+[.)]\s+)?/, '').replace(/\s+/g, ' ').trim();
/** Checklist item from an id, 1-based number, 0-based index (legacy), or whole/partial text. Returns { it } or { error } (ambiguous). */
function findCheckItem(items, { itemId, item, nomor, index, text }) {
  const num = v => (v === undefined || v === null || v === '' ? null : /^#?\d+$/.test(String(v).trim()) ? Number(String(v).trim().replace('#', '')) : null);
  const byId = n => items.find(x => x.id === n);
  const byNo = n => (n >= 1 && n <= items.length ? items[n - 1] : undefined);
  const id = num(itemId); if (id !== null && byId(id)) return { it: byId(id) };
  const no = num(nomor); if (no !== null && byNo(no)) return { it: byNo(no) };
  const ix = Number.isInteger(index) ? index : num(index); if (ix !== null && items[ix]) return { it: items[ix] };
  for (const v of [item, text]) {
    if (v === undefined || v === null || v === '') continue;
    const n = num(v);
    if (n !== null) { if (byId(n)) return { it: byId(n) }; if (byNo(n)) return { it: byNo(n) }; }
    const q = plainItem(v);
    if (!q) continue;
    const exact = items.filter(x => x.text.toLowerCase() === String(v).toLowerCase() || plainItem(x.text) === q);
    if (exact.length) return { it: exact[0] };
    const part = items.filter(x => plainItem(x.text).includes(q) || (q.length >= 8 && q.includes(plainItem(x.text))));
    if (part.length === 1) return { it: part[0] };
    if (part.length > 1) return { error: 'ambigu', cands: part };
    const m = String(v).match(/^\s*(?:item|nomor|no\.?|#)\s*(\d+)\b/i);
    if (m && byNo(Number(m[1]))) return { it: byNo(Number(m[1])) };
  }
  return {};
}
export const checklistView = items => items.map((x, i) => ({ id: x.id, nomor: i + 1, teks: x.text, status: x.done ? 'selesai' : 'belum' }));
export function checkItem(office, id, { text, index, itemId, item, nomor, done, remove }, by) {
  id = resolveCardId(office, id);
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM cards WHERE id = ?', id)) throw new Error(`Kartu ${id} tidak ditemukan`);
  const items = all(db, 'SELECT * FROM card_checks WHERE card_id = ? ORDER BY ord, id', id);
  const { it, error, cands } = findCheckItem(items, { itemId, item, nomor, index, text });
  const addText = String(text ?? '').trim();
  const selectors = [itemId, item, nomor, index].some(v => v !== undefined && v !== null && v !== '');
  if (error) throw new Error(`Teks "${String(text ?? item).slice(0, 60)}" cocok dengan ${cands.length} item. Pilih satu pakai nomor atau id: ${JSON.stringify(checklistView(cands.map(c => ({ ...c, done: !!c.done }))))}`);
  if (remove) { if (it) { run(db, 'DELETE FROM card_checks WHERE id = ?', it.id); hist(db, id, by, `menghapus checklist "${it.text}"`); } }
  else if (!it && addText && !selectors) { run(db, 'INSERT INTO card_checks (card_id, text, done, ord) VALUES (?, ?, ?, ?)', id, addText.slice(0, 300), done ? 1 : 0, items.length); hist(db, id, by, `menambah checklist "${addText}"`); }
  else if (it) { run(db, 'UPDATE card_checks SET done = ? WHERE id = ?', done === undefined ? (it.done ? 0 : 1) : (done ? 1 : 0), it.id); hist(db, id, by, `${(done ?? !it.done) ? 'mencentang' : 'membatalkan'} "${it.text}"`); }
  else {
    const ref = [nomor, itemId, item, index, text].find(v => v !== undefined && v !== null && v !== '');
    throw new Error(`Item checklist ${ref === undefined ? '' : `"${String(ref).slice(0, 60)}" `}tidak ditemukan di kartu ${id}. Pilih salah satu (pakai nomor, id, atau potongan teks): ${items.length ? JSON.stringify(checklistView(items.map(c => ({ ...c, done: !!c.done })))) : 'kartu ini belum punya checklist; kirim text untuk menambah item'}`);
  }
  run(db, 'UPDATE cards SET updated_at = ? WHERE id = ?', nowIso(), id);
  changed(office, 'board', { card: id });
  return getCard(office, id);
}
export function attachToCard(office, id, mediaId, by, on = true) {
  const db = officeDb(office);
  const c = one(db, 'SELECT title FROM cards WHERE id = ?', id);
  if (!c) throw new Error(`Kartu ${id} tidak ditemukan`);
  const m = one(db, 'SELECT name FROM media WHERE id = ?', mediaId);
  if (!m) throw new Error('File tidak ditemukan');
  if (on) run(db, "INSERT OR IGNORE INTO media_use (media_id, kind, ref, at) VALUES (?, 'card', ?, ?)", mediaId, id, nowIso());
  else { run(db, "DELETE FROM media_use WHERE media_id = ? AND kind = 'card' AND ref = ?", mediaId, id); run(db, 'UPDATE cards SET cover = NULL WHERE id = ? AND cover = ?', id, mediaId); }
  hist(db, id, by, `${on ? 'melampirkan' : 'melepas'} ${m.name}`);
  changed(office, 'board', { card: id });
  return getCard(office, id);
}
export function orderChecks(office, id, order) {
  const db = officeDb(office);
  const ids = new Set(all(db, 'SELECT id FROM card_checks WHERE card_id = ?', id).map(r => r.id));
  (order || []).map(Number).filter(x => ids.has(x)).forEach((x, i) => run(db, 'UPDATE card_checks SET ord = ? WHERE id = ?', i, x));
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

/* ---------------- playbooks (wiki pages held by roles) ---------------- */
/** Turn a page into a playbook (or back), set who holds it and how it is used. */
export function setPlaybook(office, slug, f) {
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM wiki WHERE slug = ?', slug)) throw new Error('Halaman tidak ditemukan');
  if (f.on === false) run(db, 'UPDATE wiki SET playbook = 0 WHERE slug = ?', slug);
  else {
    const roles = (f.roles || []).filter(r => one(db, 'SELECT 1 FROM roles WHERE id = ?', r));
    run(db, 'UPDATE wiki SET playbook = 1, pb_roles = ?, pb_when = ?, pb_always = ?, pb_approval = ? WHERE slug = ?', JSON.stringify(roles), String(f.when || '').slice(0, 300), f.always ? 1 : 0, f.approval ? 1 : 0, slug);
  }
  changed(office, 'wiki', { slug });
  return getWiki(office, slug);
}
/** Playbooks a role holds (all playbooks when role is omitted). */
export function listPlaybooks(office, role = null) {
  return all(officeDb(office), 'SELECT slug, title, icon, body, pb_roles, pb_when, pb_always, pb_approval, updated_at FROM wiki WHERE playbook = 1 ORDER BY ord, title COLLATE NOCASE')
    .map(p => ({ slug: p.slug, title: p.title, icon: p.icon, body: p.body, roles: j(p.pb_roles, []), when: p.pb_when || '', always: !!p.pb_always, approval: !!p.pb_approval, updatedAt: p.updated_at }))
    .filter(p => !role || p.roles.includes(role));
}
/** An agent may not rewrite a playbook: it proposes, the user decides. */
export function proposeWiki(office, slug, { title, body, reason }, by) {
  const db = officeDb(office);
  const p = one(db, 'SELECT * FROM wiki WHERE slug = ?', slug);
  if (!p) throw new Error('Halaman tidak ditemukan');
  if (!body?.trim()) throw new Error('Isi usulan kosong');
  const id = 'u' + newId().slice(0, 6);
  run(db, 'INSERT INTO wiki_proposals (id, slug, title, body, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, slug, title || p.title, body, String(reason || '').slice(0, 500), by, nowIso());
  logOffice(office, by, `mengusulkan perubahan playbook "${p.title.slice(0, 40)}"`, 'wiki');
  changed(office, 'wiki', { slug, proposal: id });
  return { id };
}
export function getProposal(office, id) { return one(officeDb(office), 'SELECT * FROM wiki_proposals WHERE id = ?', id); }
export function listProposals(office) { return all(officeDb(office), "SELECT p.id, p.slug, p.title, p.reason, p.by, p.at, w.title page FROM wiki_proposals p LEFT JOIN wiki w ON w.slug = p.slug WHERE p.status = 'baru' ORDER BY p.at"); }
export function decideProposal(office, id, accept, by = who()) {
  const db = officeDb(office);
  const u = one(db, 'SELECT * FROM wiki_proposals WHERE id = ?', id);
  if (!u || u.status !== 'baru') throw new Error('Usulan tidak ditemukan atau sudah diputuskan');
  if (accept) saveWiki(office, { slug: u.slug, prevSlug: u.slug, title: u.title, body: u.body, msg: `Usulan ${u.by} diterima${u.reason ? ': ' + u.reason : ''}` }, by);
  run(db, 'UPDATE wiki_proposals SET status = ?, decided_at = ? WHERE id = ?', accept ? 'diterima' : 'ditolak', nowIso(), id);
  logOffice(office, by, `${accept ? 'menerima' : 'menolak'} usulan ${u.by} untuk playbook`, 'wiki');
  changed(office, 'wiki', { slug: u.slug });
  return getWiki(office, u.slug);
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
  if (!isHuman(by)) logOffice(office, by, `menulis catatan "${(f.title || 'tanpa judul').slice(0, 40)}"`, 'notes');
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
  return all(officeDb(office), 'SELECT slug, title, author, updated_at, parent, ord, icon, playbook, pb_roles FROM wiki ORDER BY ord, title COLLATE NOCASE').map(p => ({ ...p, playbook: !!p.playbook, pb_roles: undefined, roles: j(p.pb_roles, []) }));
}
// a page cannot end up under itself or one of its own children
function checkParent(db, slug, parent) {
  if (!parent) return null;
  if (!one(db, 'SELECT 1 FROM wiki WHERE slug = ?', parent)) throw new Error('Halaman induk tidak ditemukan');
  for (let cur = parent, i = 0; cur && i < 100; cur = one(db, 'SELECT parent FROM wiki WHERE slug = ?', cur)?.parent, i++)
    if (cur === slug) throw new Error('Halaman tidak bisa dipindah ke dalam anaknya sendiri');
  return parent;
}
/** Move a page under another one (or to the top) and/or change its order among siblings. */
export function moveWiki(office, slug, { parent, ord }) {
  const db = officeDb(office);
  if (!one(db, 'SELECT 1 FROM wiki WHERE slug = ?', slug)) throw new Error('Halaman tidak ditemukan');
  if (parent !== undefined) run(db, 'UPDATE wiki SET parent = ? WHERE slug = ?', checkParent(db, slug, parent || null), slug);
  if (ord !== undefined) run(db, 'UPDATE wiki SET ord = ? WHERE slug = ?', Number(ord) || 0, slug);
  changed(office, 'wiki', { slug });
  return listWiki(office);
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
  const crumbs = [];
  for (let cur = p.parent, i = 0; cur && i < 50; i++) { const x = one(db, 'SELECT slug, title, parent, icon FROM wiki WHERE slug = ?', cur); if (!x) break; crumbs.unshift({ slug: x.slug, title: x.title, icon: x.icon }); cur = x.parent; }
  const children = all(db, 'SELECT slug, title, icon, updated_at FROM wiki WHERE parent = ? ORDER BY ord, title COLLATE NOCASE', p.slug);
  const proposals = all(db, "SELECT id, title, reason, by, at FROM wiki_proposals WHERE slug = ? AND status = 'baru' ORDER BY at", p.slug);
  return { slug: p.slug, title: p.title, body: p.body, author: p.author, createdAt: p.created_at, updatedAt: p.updated_at, backlinks, revs, parent: p.parent || null, icon: p.icon || null, ord: p.ord, crumbs, children,
    playbook: p.playbook ? { roles: j(p.pb_roles, []), when: p.pb_when || '', always: !!p.pb_always, approval: !!p.pb_approval } : null, proposals };
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function saveWiki(office, { slug: s, title, body, msg, prevSlug, parent, icon }, by) {
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
      run(db, 'UPDATE wiki SET parent = ? WHERE parent = ?', target, prevSlug);
      run(db, "UPDATE media_use SET ref = ? WHERE kind = 'wiki' AND ref = ?", target, prevSlug);
    }
    if (cur) run(db, 'UPDATE wiki SET title = ?, body = ?, author = ?, updated_at = ? WHERE slug = ?', title.trim(), body || '', by, t, target);
    else run(db, 'INSERT INTO wiki (slug, title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', target, title.trim(), body || '', by, t, t);
    run(db, 'INSERT INTO wiki_revs (slug, title, body, author, at, msg) VALUES (?, ?, ?, ?, ?, ?)', target, title.trim(), body || '', by, t, msg || (cur ? 'Perubahan' : 'Halaman baru'));
    if (parent !== undefined) run(db, 'UPDATE wiki SET parent = ? WHERE slug = ?', checkParent(db, target, parent || null), target);
    if (icon !== undefined) run(db, 'UPDATE wiki SET icon = ? WHERE slug = ?', String(icon || '').slice(0, 8) || null, target);
    // which uploaded files this page shows
    run(db, "DELETE FROM media_use WHERE kind = 'wiki' AND ref = ?", target);
    for (const m of [...new Set([...String(body || '').matchAll(/\/media\/([0-9a-f]{20})\b/g)].map(x => x[1]))]) run(db, "INSERT OR IGNORE INTO media_use (media_id, kind, ref, at) VALUES (?, 'wiki', ?, ?)", m, target, t);
    if (!isHuman(by)) logOffice(office, by, `${cur ? 'memperbarui' : 'membuat'} wiki "${title.trim().slice(0, 40)}"`, 'wiki');
    changed(office, 'wiki', { slug: target });
    return getWiki(office, target);
  });
}
export function deleteWiki(office, s) {
  const db = officeDb(office);
  // children move up one level instead of disappearing
  const parent = one(db, 'SELECT parent FROM wiki WHERE slug = ?', s)?.parent || null;
  run(db, 'UPDATE wiki SET parent = ? WHERE parent = ?', parent, s);
  run(db, 'DELETE FROM wiki WHERE slug = ?', s);
  run(db, "DELETE FROM media_use WHERE kind = 'wiki' AND ref = ?", s);
  changed(office, 'wiki');
}
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
