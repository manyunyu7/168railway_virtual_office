// Papan (board) per kantor: tiap kantor punya N papan, tiap papan punya kolom sendiri. Tiap kolom punya `kind`
// (antre|siap|dikerjakan|review|selesai) dan SEMUA logika (selesai, WIP, metrik, autopilot, kurir...) membaca kind, bukan nomor kolom.
// cards.col = indeks kolom di papan kartu itu; cards.kind = kind kolom itu (disimpan ganda supaya query SQL mudah).
import { officeDb, all, one, run, tx, nowIso, newId, j } from './db.js';
import { bus } from './live.js';

export const KINDS = ['antre', 'siap', 'dikerjakan', 'review', 'selesai'];
export const KIND_LABEL = { antre: 'Antre', siap: 'Siap', dikerjakan: 'Dikerjakan', review: 'Review', selesai: 'Selesai' };
/** Nomor kolom lama (0..4) untuk tiap kind: dipakai klien lama dan kanban mini di papan tulis kantor. */
export const KIND_IDX = { antre: 0, siap: 1, dikerjakan: 2, review: 3, selesai: 4 };
export const DEFAULT_BOARD = 'utama';
// nama kolom lama: tetap bisa dipakai agen/klien lama di papan mana pun (dipetakan ke kind)
const LEGACY = { backlog: 'antre', siap: 'siap', dikerjakan: 'dikerjakan', review: 'review', selesai: 'selesai', antre: 'antre', done: 'selesai', todo: 'antre', doing: 'dikerjakan' };

const col = (name, kind) => ({ id: slugify(name), name, kind });
export const TEMPLATES = {
  dev: { id: 'dev', name: 'Dev', icon: '▦', color: '#2F5D9E', columns: [col('Backlog', 'antre'), col('Siap', 'siap'), col('Dikerjakan', 'dikerjakan'), col('Review', 'review'), col('Selesai', 'selesai')] },
  kreatif: { id: 'kreatif', name: 'Kreatif', icon: '✦', color: '#C2417A', columns: [col('Brief', 'antre'), col('Konsep', 'dikerjakan'), col('Produksi', 'dikerjakan'), col('Review', 'review'),
    col('Revisi', 'dikerjakan'), col('Final', 'selesai'), col('Tayang', 'selesai'), col('Arsip', 'selesai')] },
};
export const BOARD_COLORS = ['#2F5D9E', '#C2417A', '#3E9A5B', '#D98A1E', '#7A3E9D', '#2F7F86', '#D2553F', '#8B818B'];

function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); }
const changed = office => bus.emit('msg', { t: 'changed', office, what: 'board', boards: true });

export function boardRow(b) {
  return { id: b.id, name: b.name, icon: b.icon || '', color: b.color || BOARD_COLORS[0], template: b.template || '', columns: j(b.columns, []), ord: b.ord || 0,
    archived: !!b.archived, rooms: j(b.rooms, []), roles: j(b.roles, []), isDefault: b.id === DEFAULT_BOARD, createdAt: b.created_at };
}
/** Papan mentah dari db (dengan cache per panggilan tidak perlu: tabelnya kecil). Selalu ada papan utama. */
export function boardsOf(db, { archived = true } = {}) {
  if (!one(db, 'SELECT 1 FROM boards WHERE id = ?', DEFAULT_BOARD))
    run(db, 'INSERT OR IGNORE INTO boards (id, name, icon, color, template, columns, ord, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', DEFAULT_BOARD, 'Utama', '▦', '#2F5D9E', 'dev', JSON.stringify(TEMPLATES.dev.columns), nowIso());
  return all(db, `SELECT * FROM boards ${archived ? '' : 'WHERE archived = 0'} ORDER BY ord, created_at`).map(boardRow);
}
export function boardMap(db) { return new Map(boardsOf(db).map(b => [b.id, b])); }
export function listBoards(office, opts) { return boardsOf(officeDb(office), opts); }
export function getBoard(office, id) { const b = boardsOf(officeDb(office)).find(x => x.id === id); if (!b) throw new Error(`Papan ${id} tidak ditemukan`); return b; }

/** Papan dari id atau nama (tidak peka huruf besar). Kosong = papan utama. */
export function resolveBoard(office, ref) {
  const list = boardsOf(officeDb(office));
  if (ref === undefined || ref === null || String(ref).trim() === '') return list.find(b => b.id === DEFAULT_BOARD);
  const v = String(ref).trim().toLowerCase();
  const hit = list.find(b => b.id === v) || list.find(b => b.name.toLowerCase() === v) || list.find(b => slugify(b.name) === slugify(v));
  if (!hit) throw new Error(`Papan "${ref}" tidak ditemukan. Pilihan: ${list.filter(b => !b.archived).map(b => `${b.name} (${b.id})`).join(', ')}`);
  return hit;
}
/** Papan bawaan untuk sebuah role: papan yang memetakan role itu, lalu ruangannya, lalu Utama. */
export function boardForRole(office, role) {
  const list = boardsOf(officeDb(office), { archived: false });
  if (role) {
    const byRole = list.find(b => b.roles.includes(role.id));
    if (byRole) return byRole;
    const byRoom = role.room && list.find(b => b.rooms.includes(role.room));
    if (byRoom) return byRoom;
  }
  return list.find(b => b.id === DEFAULT_BOARD);
}

export const kindAt = (board, i) => board?.columns[i]?.kind || 'antre';
export const nameAt = (board, i) => board?.columns[i]?.name ?? `Kolom ${i}`;
export const firstOfKind = (board, kind) => { const i = board.columns.findIndex(c => c.kind === kind); return i < 0 ? null : i; };
/** Kolom pertama berjenis kind; kalau papan tidak punya jenis itu, jenis terdekat (mundur dulu, lalu maju). */
export function nearestOfKind(board, kind) {
  const at = KIND_IDX[kind];
  for (let d = 0; d < KINDS.length; d++) for (const k of [KINDS[at - d], KINDS[at + d]]) { const i = k ? firstOfKind(board, k) : null; if (i !== null && i !== undefined) return i; }
  return 0;
}
/** Kolom dari input: angka (indeks di papan), id/nama kolom, kind, atau nama kolom lama (Backlog/Siap/...). */
export function colIn(board, v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = board.columns.length;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) return Math.max(0, Math.min(n - 1, Number(v)));
  const s = String(v).trim().toLowerCase();
  let i = board.columns.findIndex(c => c.name.toLowerCase() === s || c.id === s);
  const k = LEGACY[s] || (KINDS.includes(s) ? s : null);
  if (i < 0 && k) i = nearestOfKind(board, k);
  if (i < 0) throw new Error(`Kolom tidak dikenal di papan ${board.name}: ${v}. Pilihan: ${board.columns.map(c => c.name).join(', ')}`);
  return i;
}

/** Periksa & rapikan daftar kolom: nama unik tak kosong, kind sah, minimal satu 'selesai'. */
export function cleanColumns(cols) {
  if (!Array.isArray(cols) || !cols.length) throw new Error('Papan harus punya minimal satu kolom');
  if (cols.length > 20) throw new Error('Maksimal 20 kolom per papan');
  const seen = new Set(), ids = new Set();
  const out = cols.map((c, i) => {
    const name = String(c?.name || '').trim().slice(0, 40);
    if (!name) throw new Error(`Nama kolom ke-${i + 1} kosong`);
    if (seen.has(name.toLowerCase())) throw new Error(`Nama kolom dobel: ${name}`);
    seen.add(name.toLowerCase());
    const kind = String(c.kind || '').toLowerCase();
    if (!KINDS.includes(kind)) throw new Error(`Jenis kolom ${name} tidak sah: ${c.kind}. Pilihan: ${KINDS.join(', ')}`);
    let id = String(c.id || slugify(name) || 'k').slice(0, 40);
    while (ids.has(id)) id += '-' + i;
    ids.add(id);
    return { id, name, kind };
  });
  if (!out.some(c => c.kind === 'selesai')) throw new Error("Papan harus punya minimal satu kolom berjenis 'selesai'");
  return out;
}
const cleanList = (db, table, v) => [...new Set((Array.isArray(v) ? v : []).map(String))].slice(0, 50);

export function createBoard(office, f = {}) {
  const db = officeDb(office);
  boardsOf(db);
  const tpl = TEMPLATES[f.template] || null;
  const name = String(f.name || tpl?.name || '').trim().slice(0, 40);
  if (!name) throw new Error('Nama papan wajib diisi');
  if (all(db, 'SELECT name FROM boards WHERE archived = 0').some(b => b.name.toLowerCase() === name.toLowerCase())) throw new Error(`Sudah ada papan bernama ${name}`);
  const columns = cleanColumns(f.columns || tpl?.columns || TEMPLATES.dev.columns);
  let id = slugify(name) || 'papan';
  if (id === 'all' || id === 'semua') id = 'papan-' + id;
  while (one(db, 'SELECT 1 FROM boards WHERE id = ?', id)) id = `${slugify(name) || 'papan'}-${newId().slice(0, 3)}`;
  const n = one(db, 'SELECT COUNT(*) n, MAX(ord) m FROM boards');
  run(db, 'INSERT INTO boards (id, name, icon, color, template, columns, ord, archived, rooms, roles, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    id, name, String(f.icon || tpl?.icon || '').slice(0, 4), f.color || tpl?.color || BOARD_COLORS[n.n % BOARD_COLORS.length], tpl?.id || f.template || 'custom',
    JSON.stringify(columns), (n.m ?? 0) + 1, JSON.stringify(cleanList(db, 'rooms', f.rooms)), JSON.stringify(cleanList(db, 'roles', f.roles)), nowIso());
  changed(office);
  return getBoard(office, id);
}

/**
 * Ubah papan. columns = daftar kolom baru (urutan baru); kolom lama dikenali dari id-nya. Kartu di kolom yang dihapus harus dipindah:
 * moveTo = { [idKolomLama]: idKolomBaru } (atau satu id untuk semua). Tanpa moveTo, kolom berisi kartu tidak boleh dihapus.
 */
export function updateBoard(office, id, f = {}) {
  const db = officeDb(office);
  const b = getBoard(office, id);
  tx(db, () => {
    if (f.name !== undefined) {
      const name = String(f.name).trim().slice(0, 40);
      if (!name) throw new Error('Nama papan wajib diisi');
      if (all(db, 'SELECT name FROM boards WHERE archived = 0 AND id <> ?', id).some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Sudah ada papan bernama ${name}`);
      run(db, 'UPDATE boards SET name = ? WHERE id = ?', name, id);
    }
    if (f.icon !== undefined) run(db, 'UPDATE boards SET icon = ? WHERE id = ?', String(f.icon || '').slice(0, 4), id);
    if (f.color !== undefined && /^#[0-9a-f]{6}$/i.test(f.color)) run(db, 'UPDATE boards SET color = ? WHERE id = ?', f.color, id);
    if (f.rooms !== undefined) run(db, 'UPDATE boards SET rooms = ? WHERE id = ?', JSON.stringify(cleanList(db, 'rooms', f.rooms)), id);
    if (f.roles !== undefined) run(db, 'UPDATE boards SET roles = ? WHERE id = ?', JSON.stringify(cleanList(db, 'roles', f.roles)), id);
    if (f.ord !== undefined) run(db, 'UPDATE boards SET ord = ? WHERE id = ?', Number(f.ord) || 0, id);
    if (f.archived !== undefined) {
      if (id === DEFAULT_BOARD && f.archived) throw new Error('Papan Utama tidak bisa diarsipkan');
      run(db, 'UPDATE boards SET archived = ? WHERE id = ?', f.archived ? 1 : 0, id);
    }
    if (f.columns !== undefined) setColumns(db, b, f.columns, f.moveTo);
  });
  changed(office);
  return getBoard(office, id);
}

function setColumns(db, b, raw, moveTo) {
  // kolom baru tanpa id dapat id dari namanya; kolom lama dikenali dari id
  const next = cleanColumns(raw.map(c => ({ ...c, id: c.id || undefined })));
  const oldIds = b.columns.map(c => c.id);
  const newIdx = new Map(next.map((c, i) => [c.id, i]));
  const counts = all(db, 'SELECT col, COUNT(*) n FROM cards WHERE board = ? AND archived = 0 GROUP BY col', b.id);
  const target = oldId => {
    if (newIdx.has(oldId)) return newIdx.get(oldId);
    const to = typeof moveTo === 'string' ? moveTo : moveTo?.[oldId];
    if (to !== undefined && newIdx.has(to)) return newIdx.get(to);
    return null;
  };
  for (const r of counts) {
    const oid = oldIds[r.col];
    if (oid === undefined) continue;
    if (target(oid) === null) throw new Error(`Kolom ${b.columns[r.col].name} masih berisi ${r.n} kartu. Pilih kolom tujuan untuk kartunya dulu.`);
  }
  // kolom baru disimpan dulu: trigger cards_kind_upd membaca jenis kolom dari boards.columns
  run(db, 'UPDATE boards SET columns = ? WHERE id = ?', JSON.stringify(next), b.id);
  // remap per kartu (termasuk arsip: kartu arsip tanpa tujuan masuk kolom pertama)
  const rows = all(db, 'SELECT id, col FROM cards WHERE board = ?', b.id);
  for (const r of rows) {
    const oid = oldIds[r.col];
    let to = oid === undefined ? null : target(oid);
    if (to === null) to = Math.max(0, Math.min(next.length - 1, r.col));
    run(db, 'UPDATE cards SET col = ?, kind = ? WHERE id = ?', to, next[to].kind, r.id);
  }
}

/** Arsipkan papan. Kartunya dipindah ke papan lain (moveTo, bawaan Utama), kolomnya dipetakan lewat kind. */
export function deleteBoard(office, id, { moveTo } = {}) {
  if (id === DEFAULT_BOARD) throw new Error('Papan Utama tidak bisa dihapus');
  const db = officeDb(office);
  const b = getBoard(office, id);
  const dest = resolveBoard(office, moveTo || DEFAULT_BOARD);
  if (dest.id === b.id) throw new Error('Papan tujuan sama dengan papan yang dihapus');
  tx(db, () => {
    for (const c of all(db, 'SELECT id, col, kind FROM cards WHERE board = ?', id)) {
      const to = firstOfKind(dest, c.kind) ?? 0;
      run(db, 'UPDATE cards SET board = ?, col = ?, kind = ? WHERE id = ?', dest.id, to, kindAt(dest, to), c.id);
    }
    run(db, 'UPDATE boards SET archived = 1 WHERE id = ?', id);
  });
  changed(office);
  return { ok: true, movedTo: dest.id };
}

export function orderBoards(office, ids) {
  const db = officeDb(office);
  const list = boardsOf(db).map(b => b.id);
  const want = (ids || []).filter(x => list.includes(x));
  [...want, ...list.filter(x => !want.includes(x))].forEach((x, i) => run(db, 'UPDATE boards SET ord = ? WHERE id = ?', i, x));
  changed(office);
  return listBoards(office);
}
