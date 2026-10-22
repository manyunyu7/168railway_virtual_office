// MCP tools to build the office itself: roles (employees), rooms, the floor plan, templates and furniture. See docs/MCP.md.
// Everything here goes through the same functions as the web editor (saveLayout, saveFurniture, applyTemplate, createRole …), so the same
// validation applies. A change that makes the office worse (overlaps, unreachable rooms or desks, furniture out of place) is refused whole:
// each tool runs in one transaction and compares the office's problems before and after.
import { officeDb, all, one, run, tx, nowIso, j } from './db.js';
import { officeModel, invalidate, addRoom, updateRoom, saveLayout, saveFurniture, ROOM_KINDS } from './offices.js';
import { applyTemplate, previewTemplate, restoreTemplate, templateList, templateState, resultProblems } from './templates.js';
import { furniture } from './furniture.js';
import { WH, builtIns, fillRoom, deskRects, mulberry, hashStr, interior, doorLands, overlap } from '../web/js/furnish-core.js';
import { bus, logOffice, live } from './live.js';
import * as st from './store.js';

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const MAX_PLAN = 400, MAX_OPS = 60, MAX_ROLES = 40, MAX_SNAPS = 8;
const FLOORS = ['wood', 'teal', 'teal2', 'wood2', 'carpet', 'carpetGreen', 'marble', 'tile', 'metal', 'plum', 'frozen', 'musholla', 'lounge', 'gymMat', 'grass'];
const SIDES = ['t', 'b', 'l', 'r'];
const HAIR_STYLES = ['short', 'long', 'ponytail', 'bob', 'bun', 'pigtails', 'curly', 'hijab'];
const OUTFITS = ['kemeja', 'rok', 'dress', 'hoodie', 'jas'];
const ACCS = ['', 'kacamata', 'anting', 'topi'];
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const HEX = /^#[0-9a-fA-F]{6}$/;

/* ---------------- tool definitions ---------------- */
const roomRef = { type: 'string', description: 'id atau nama ruangan (lihat denah_lihat)' };
const doorSchema = { type: 'array', description: 'pintu: s = sisi (t atas, b bawah, l kiri, r kanan), at = jarak dari pojok sisi itu (tile), w = lebar 2-6', items: { type: 'object', properties: { s: { type: 'string', enum: SIDES }, at: { type: 'integer' }, w: { type: 'integer' } }, required: ['s', 'at'] } };
const lookSchema = { type: 'object', description: 'penampilan karakter: color (baju), hair, skin = #RRGGBB; hairStyle, outfit, acc, hijab (#RRGGBB), tie (boolean)', properties: { color: { type: 'string' }, hair: { type: 'string' }, skin: { type: 'string' }, hairStyle: { type: 'string', enum: HAIR_STYLES }, outfit: { type: 'string', enum: OUTFITS }, acc: { type: 'string', enum: ACCS }, hijab: { type: 'string' }, tie: { type: 'boolean' } } };
const roleProps = {
  nama: { type: 'string', description: 'nama panggilan, unik di kantor (maks 40 huruf)' },
  jabatan: { type: 'string', description: 'mis. "Flutter Dev" (maks 60 huruf)' },
  kepribadian: { type: 'string', description: 'persona / cara kerja, dipakai sebagai instruksi sesinya (maks 4000 huruf)' },
  skills: { type: 'array', items: { type: 'string' }, description: 'daftar keahlian singkat' },
  ruangan: { type: 'string', description: 'id atau nama ruangan tempat mejanya; harus masih punya meja kosong' },
  model: { type: 'string', description: 'claude: opus | sonnet | haiku | fable; codex: nama model Codex' },
  mesin: { type: 'string', enum: ['claude', 'codex'] },
  effort: { type: 'string', description: 'khusus codex: low | medium | high | xhigh' },
  atasan: { type: 'string', description: 'id role atasannya (kosongkan untuk melepas)' },
  tampilan: lookSchema,
};

export const DENAH_TOOLS = [
  /* roles */
  { name: 'role_create', description: 'Khusus manager: rekrut karyawan tetap baru (role) beserta meja di sebuah ruangan. Tidak bisa membuat manager. Setelah dibuat, mulai kerjanya dengan shift_start. Penampilan bebas; tanpa tampilan dipilihkan otomatis.',
    inputSchema: { type: 'object', properties: roleProps, required: ['nama', 'jabatan'] } },
  { name: 'role_update', description: 'Khusus manager: ubah role yang ada (nama, jabatan, kepribadian, skills, ruangan, model, mesin, effort, atasan, tampilan). Sesi yang sedang jalan memakai pengaturan baru pada shift berikutnya. Status manager tidak bisa diubah dari sini.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'id role' }, ...roleProps }, required: ['role'] } },
  { name: 'role_arsipkan', description: 'Khusus manager: arsipkan role (berhenti kerja, mejanya hilang dari denah; riwayat tetap ada). Tidak ada penghapusan permanen. pulihkan=true mengembalikan role yang diarsipkan. Manager dan role yang sedang shift tidak bisa diarsipkan.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' }, pulihkan: { type: 'boolean' } }, required: ['role'] } },
  /* rooms */
  { name: 'room_create', description: 'Khusus manager: tambah ruangan baru di kantor. path = folder relatif terhadap folder kantor (create=true membuat foldernya, git_init=true sekalian git init). ukuran {w,h} dan posisi {x,y} (tile, pojok kiri atas) opsional; tanpa posisi, ruangan masuk baris baru di bawah denah. Ditolak bila tabrakan atau tak terjangkau.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ROOM_KINDS }, path: { type: 'string' }, create: { type: 'boolean' }, git_init: { type: 'boolean' },
      ukuran: { type: 'object', properties: { w: { type: 'integer' }, h: { type: 'integer' } }, required: ['w', 'h'] }, posisi: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } }, required: ['name'] } },
  { name: 'room_update', description: 'Khusus manager: ubah ruangan: nama, jenis (hanya ruangan tambahan), catatan, ukuran {w,h}, posisi {x,y}. Satu paket: bila ada yang tidak lolos validasi, tidak ada yang berubah. Perabot ikut pindah bila hanya posisi yang berubah.',
    inputSchema: { type: 'object', properties: { room: roomRef, nama: { type: 'string' }, jenis: { type: 'string', enum: ROOM_KINDS }, catatan: { type: 'string' },
      ukuran: { type: 'object', properties: { w: { type: 'integer' }, h: { type: 'integer' } }, required: ['w', 'h'] }, posisi: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } }, required: ['room'] } },
  { name: 'room_pindah', description: 'Khusus manager: pindahkan ruangan ke posisi baru (tile, pojok kiri atas). Perabot dan zonanya ikut. Ditolak bila menabrak ruangan lain atau membuat ruangan/meja tak terjangkau.',
    inputSchema: { type: 'object', properties: { room: roomRef, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['room', 'x', 'y'] } },
  { name: 'room_resize', description: 'Khusus manager: ubah ukuran ruangan (w, h tile; minimal 8x8). Perabot tetap di tempatnya; ditolak bila ada yang keluar ruangan, tabrakan, atau meja penghuni tak cukup.',
    inputSchema: { type: 'object', properties: { room: roomRef, w: { type: 'integer' }, h: { type: 'integer' } }, required: ['room', 'w', 'h'] } },
  { name: 'room_hapus', description: 'Khusus manager: hapus ruangan TAMBAHAN yang bukan repo (tanpa folder), kosong dari penghuni dan sesi. Perabotnya ikut dihapus. Cadangan otomatis, pulihkan dengan denah_pulihkan.',
    inputSchema: { type: 'object', properties: { room: roomRef }, required: ['room'] } },
  /* floor plan */
  { name: 'denah_lihat', description: 'Ringkasan denah kantor: ukuran, tiap ruangan (jenis, posisi, ukuran, pintu, lantai, penghuni, jumlah perabot), template aktif, dan masalah yang ada sekarang. Dengan room: sekalian daftar perabot ruangan itu (uid, item, posisi).',
    inputSchema: { type: 'object', properties: { room: { type: 'string', description: 'id atau nama ruangan (opsional)' } } } },
  { name: 'denah_ubah', description: 'Khusus manager: rombak tata letak dengan sejumlah operasi sekaligus, divalidasi dan diterapkan atomik (semua atau tidak sama sekali; cadangan otomatis). Operasi: {op:"pindah",room,x,y} | {op:"ukuran",room,w,h} | {op:"atur",room,x?,y?,w?,h?} | {op:"pintu",room,pintu:[{s,at,w}]} | {op:"lantai",room,lantai} | {op:"denah",w,h} | {op:"rapikan"}. Lantai: ' + FLOORS.join(', ') + '. coba=true hanya menguji tanpa menyimpan. Bila ditolak, daftar masalah dikembalikan.',
    inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['pindah', 'ukuran', 'atur', 'pintu', 'lantai', 'denah', 'rapikan'] }, room: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, pintu: doorSchema, lantai: { type: 'string', enum: FLOORS } }, required: ['op'] } }, coba: { type: 'boolean' } }, required: ['ops'] } },
  { name: 'denah_rapikan', description: 'Khusus manager: "Rapikan otomatis" seperti di editor web: susun ulang semua ruangan ke baris rapi dengan koridor di antaranya (ukuran ruangan tetap, perabot ikut). Cadangan otomatis.',
    inputSchema: { type: 'object', properties: { coba: { type: 'boolean', description: 'true = hanya uji' } } } },
  { name: 'denah_pulihkan', description: 'Khusus manager: kembalikan denah, perabot, dan ruangan tambahan ke cadangan yang disimpan sebelum perombakan (denah_ubah, denah_rapikan, room_hapus, template_terapkan, perabot_isi_ruangan, pulihkan sebelumnya). Tanpa id: yang terbaru. daftar=true hanya menampilkan cadangan.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, daftar: { type: 'boolean' } } } },
  /* templates */
  { name: 'template_list', description: 'Daftar template suasana kantor (denah + perabot bertema) beserta template yang sedang aktif dan apakah ada cadangan sebelum template.', inputSchema: { type: 'object', properties: {} } },
  { name: 'template_pratinjau', description: 'Lihat apa yang terjadi bila template dipasang, tanpa menyimpan: ukuran denah, ruangan baru/dibuang, jumlah perabot, dan masalah (kalau ada, template belum bisa dipasang).',
    inputSchema: { type: 'object', properties: { template: { type: 'string', description: 'id template dari template_list' }, seed: { type: 'integer', description: 'variasi penataan, bawaan 1' } }, required: ['template'] } },
  { name: 'template_terapkan', description: 'Khusus manager: pasang template: tata ulang semua ruangan dan isi perabot bertema. Keadaan sebelumnya dicadangkan; kembalikan dengan template_pulihkan atau denah_pulihkan.',
    inputSchema: { type: 'object', properties: { template: { type: 'string' }, seed: { type: 'integer' } }, required: ['template'] } },
  { name: 'template_pulihkan', description: 'Khusus manager: kembalikan denah, perabot, dan ruangan seperti sebelum template pertama dipasang.', inputSchema: { type: 'object', properties: {} } },
  /* furniture */
  { name: 'perabot_katalog', description: 'Katalog perabot (sekitar 250 jenis). Tanpa argumen: daftar kategori. Dengan kategori dan/atau cari: daftar item (id, nama, ukuran, apakah menempel di dinding, cocok untuk jenis ruangan apa).',
    inputSchema: { type: 'object', properties: { kategori: { type: 'string' }, cari: { type: 'string', description: 'kata dari id atau nama' } } } },
  { name: 'perabot_taruh', description: 'Taruh satu perabot di ruangan. Tanpa x,y dicarikan tempat yang muat (tidak menutup pintu, meja, atau jalan). Manager: ruangan mana pun; role biasa: hanya ruangannya sendiri.',
    inputSchema: { type: 'object', properties: { room: roomRef, item: { type: 'string', description: 'id atau nama item dari perabot_katalog' }, x: { type: 'integer', description: 'tile absolut, pojok kiri atas' }, y: { type: 'integer' } }, required: ['room', 'item'] } },
  { name: 'perabot_pindah', description: 'Pindahkan satu perabot (uid dari denah_lihat dengan room) ke posisi baru di ruangan yang sama. Role biasa hanya di ruangannya sendiri.',
    inputSchema: { type: 'object', properties: { uid: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['uid', 'x', 'y'] } },
  { name: 'perabot_hapus', description: 'Hapus perabot berdasarkan uid (satu atau beberapa). Role biasa hanya di ruangannya sendiri.',
    inputSchema: { type: 'object', properties: { uid: { type: 'string' }, uids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'perabot_isi_ruangan', description: 'Isi otomatis ruangan dengan perabot yang cocok dengan jenisnya (seperti "Isi otomatis" di editor); perabot yang sudah ada dipertahankan. kepadatan 0.2-2 (bawaan 1). Manager: ruangan mana pun; role biasa: ruangannya sendiri. Cadangan otomatis.',
    inputSchema: { type: 'object', properties: { room: roomRef, kepadatan: { type: 'number' }, seed: { type: 'integer' } }, required: ['room'] } },
];
export const DENAH_NAMES = new Set(DENAH_TOOLS.map(t => t.name));

/* ---------------- guards ---------------- */
const hits = new Map();
let rateMax = 40;
/** Test hook: how many changes one role may make per minute. */
export function setRateLimit(n) { rateMax = n; hits.clear(); }
function rate(ident) {
  const key = `${ident.office}:${ident.role?.id || ident.by}`, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= rateMax) throw new Error(`Terlalu banyak perubahan denah (maks ${rateMax} per menit). Tunggu sebentar lalu lanjutkan.`);
  list.push(now); hits.set(key, list);
}
function needMgr(ident, what) {
  if (!ident.role?.isMgr) throw new Error(`Hanya manager yang boleh ${what}.`);
  rate(ident);
}
const int = (v, lo, hi, what) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} harus bilangan bulat ${lo}..${hi}`); return v; };
const clean = (s, max, what) => {
  const v = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (v.length > max) throw new Error(`${what} terlalu panjang (maks ${max} huruf)`);
  return v;
};

/* ---------------- office helpers ---------------- */
const getMeta = (db, k) => one(db, 'SELECT value FROM meta WHERE key = ?', k)?.value ?? null;
const putMeta = (db, k, v) => v === null || v === undefined ? run(db, 'DELETE FROM meta WHERE key = ?', k) : run(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
const roleRows = office => all(officeDb(office), 'SELECT id, room, archived, is_mgr FROM roles WHERE archived = 0 ORDER BY ord, created_at');
const problemsOf = office => resultProblems(officeModel(office).plan, roleRows(office));
const emit = (office, what) => bus.emit('msg', { t: 'changed', office, what });
const listMore = (a, n = 6) => `${a.slice(0, n).join('; ')}${a.length > n ? ` (+${a.length - n} lagi)` : ''}`;

class DryRun extends Error {}
/**
 * Run `fn` in one transaction; afterwards the office must have no problem it did not already have, else everything is rolled back.
 * dry = verify, then roll back anyway (returns what fn returned).
 */
function atomic(office, fn, { dry = false } = {}) {
  const base = new Set(problemsOf(office));
  let out;
  try {
    tx(officeDb(office), () => {
      out = fn();
      invalidate(office);
      const bad = problemsOf(office).filter(p => !base.has(p));
      if (bad.length) { const e = new Error(`Perubahan ditolak, tidak ada yang diubah. Masalah:\n- ${bad.slice(0, 8).join('\n- ')}${bad.length > 8 ? `\n(+${bad.length - 8} lagi)` : ''}`); e.problems = bad; throw e; }
      if (dry) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; } finally { invalidate(office); }
  return out;
}

/* ---------------- backups ---------------- */
const SNAP_KEYS = ['layout', 'furniture', 'extraRooms', 'rooms'];
function snapshot(office, why, by) {
  const db = officeDb(office);
  const list = j(getMeta(db, 'denah-backup'), []);
  const id = (list.at(-1)?.id || 0) + 1;
  list.push({ id, at: nowIso(), why, by, meta: Object.fromEntries(SNAP_KEYS.map(k => [k, getMeta(db, k)])) });
  putMeta(db, 'denah-backup', JSON.stringify(list.slice(-MAX_SNAPS)));
  return id;
}
function snapshots(office) { return j(getMeta(officeDb(office), 'denah-backup'), []); }
function restoreSnapshot(office, id, by) {
  const list = snapshots(office);
  const s = id ? list.find(x => x.id === id) : list.at(-1);
  if (!s) throw new Error(id ? `Cadangan ${id} tidak ada. Pakai denah_pulihkan dengan daftar=true.` : 'Belum ada cadangan denah.');
  const db = officeDb(office);
  try {
    tx(db, () => {
      snapshot(office, `sebelum memulihkan cadangan ${s.id}`, by);
      for (const k of SNAP_KEYS) putMeta(db, k, s.meta[k]);
    });
  } finally { invalidate(office); }
  return { s, masalah: problemsOf(office) };
}

/* ---------------- plan editing (ports of layout-editor.js helpers) ---------------- */
function fitDoors(r) {
  for (const d of r.doors || []) { const len = d.s === 't' || d.s === 'b' ? r.w : r.h; d.w = Math.max(2, Math.min(6, d.w || 3)); d.at = Math.max(1, Math.min(d.at, len - 1 - d.w)); }
}
function moveRoom(pl, r, x, y) {
  const dx = x - r.x, dy = y - r.y; if (!dx && !dy) return;
  r.x = x; r.y = y;
  for (const z of pl.rooms) if (z.kind === 'zone' && z.zoneOf === r.id) { z.x += dx; if (Number.isFinite(z.y)) z.y += dy; }
}
function growPlan(pl) {
  for (const r of pl.rooms) if (r.kind !== 'zone') { pl.w = Math.min(MAX_PLAN, Math.max(pl.w, r.x + r.w)); pl.h = Math.min(MAX_PLAN, Math.max(pl.h, r.y + r.h)); }
}
/** Re-pack every room except the lobby into tidy rows right of it, corridors between row pairs (same as "Rapikan otomatis" in the editor). */
function tidyPlan(pl) {
  const vis = pl.rooms.filter(r => r.kind !== 'zone');
  const lobby = vis.find(r => r.kind === 'lobby'), rest = vis.filter(r => r !== lobby).sort((a, b) => a.y - b.y || a.x - b.x);
  const bands = [];
  for (const r of rest) { const b = bands.at(-1); if (b && r.y - b[0].y <= Math.max(6, b[0].h * .5)) b.push(r); else bands.push([r]); }
  const order = bands.flatMap(b => b.sort((p, q) => p.x - q.x));
  const total = order.reduce((s, r) => s + r.w - 1, 0), nRows = Math.max(1, Math.ceil(total / 112)), target = Math.ceil(total / nRows) + 10;
  const rows = [[]]; let acc = 0;
  for (const r of order) { if (acc + r.w - 1 > target && rows.at(-1).length) { rows.push([]); acc = 0; } rows.at(-1).push(r); acc += r.w - 1; }
  if (lobby) moveRoom(pl, lobby, 0, 0);
  const x0 = lobby ? lobby.x + lobby.w - 1 : 0, corridors = [];
  let y = 0, right = x0 + 1;
  rows.forEach((row, i) => {
    const down = i % 2 === 0, hMax = Math.max(...row.map(r => r.h)); let x = x0;
    for (const r of row) {
      moveRoom(pl, r, x, down ? y + hMax - r.h : y);
      const face = down ? 'b' : 't', keep = (r.doors || []).filter(d => d.s === face);
      r.doors = keep.length ? keep : [{ s: face, at: Math.max(1, Math.floor(r.w / 2) - 1), w: 3 }];
      fitDoors(r); x += r.w - 1; right = Math.max(right, x + 1);
    }
    y += hMax;
    if (down) { corridors.push(y); y += 7; }
  });
  if (lobby) {
    lobby.h = Math.max(30, y);
    lobby.doors = [...(lobby.doors || []).filter(d => d.s !== 'r'), ...corridors.map(cy => ({ s: 'r', at: cy + 2 - lobby.y, w: 3 }))];
  }
  pl.w = Math.min(MAX_PLAN, Math.max(20, right)); pl.h = Math.min(MAX_PLAN, Math.max(30, y));
  pl.runners = corridors.map(cy => ({ x: (x0 + 1) * 8, y: (cy + 3) * 8 - 2, w: (pl.w - x0 - 1) * 8, h: 12 }));
  pl.decor = corridors.flatMap((cy, i) => [...Array.from({ length: Math.max(0, Math.ceil((pl.w - 3 - (x0 + 5)) / 22)) }, (_, k) => { const x = x0 + 5 + k * 22; return { t: (x / 22 | 0) % 3 === 1 ? 'bench' : 'plant', x, y: cy + (i % 2 ? 5 : 1) }; }), { t: 'vending', x: pl.w - 4, y: cy + 1 }]);
  pl.wings = [];
}
/** Furniture goes with its room: items of every room that moved without changing size shift along (a resize keeps them in place). */
function carryFurn(base, list, now) {
  const move = new Map();
  for (const r of now.rooms) {
    const b = r.kind !== 'zone' && base.rooms.find(x => x.id === r.id);
    if (b && b.w === r.w && b.h === r.h && (b.x !== r.x || b.y !== r.y)) move.set(r.id, [r.x - b.x, r.y - b.y]);
  }
  if (!move.size || !list.length) return list;
  const rooms = base.rooms.filter(r => r.kind !== 'zone');
  return list.map(f => {
    const own = rooms.find(r => f.x > r.x && f.x < r.x + r.w - 1 && f.y >= r.y + WH && f.y < r.y + r.h - 1) || rooms.find(r => f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h);
    const d = own && move.get(own.id);
    return d ? { ...f, x: f.x + d[0], y: f.y + d[1] } : f;
  });
}
function findRoom(plan, ref, { zone = false } = {}) {
  const q = String(ref ?? '').trim().toLowerCase();
  if (!q) throw new Error('Ruangan wajib diisi');
  const r = plan.rooms.find(x => x.id.toLowerCase() === q) || plan.rooms.find(x => x.name.toLowerCase() === q);
  if (!r) throw new Error(`Ruangan "${ref}" tidak ada. Pakai denah_lihat untuk daftar ruangan.`);
  if (!zone && r.kind === 'zone') throw new Error(`"${r.name}" adalah zona di dalam ${plan.rooms.find(x => x.id === r.zoneOf)?.name || 'ruangan terbuka'}; ubah ruangan induknya.`);
  return r;
}
function applyOp(plan, op, i) {
  const at = `operasi #${i + 1}`;
  try {
    if (!op || typeof op !== 'object') throw new Error('bukan objek');
    switch (op.op) {
      case 'pindah': { const r = findRoom(plan, op.room); moveRoom(plan, r, int(op.x, 0, MAX_PLAN, 'x'), int(op.y, 0, MAX_PLAN, 'y')); return; }
      case 'ukuran': { const r = findRoom(plan, op.room); r.w = int(op.w, 8, MAX_PLAN, 'w'); r.h = int(op.h, 8, MAX_PLAN, 'h'); fitDoors(r); return; }
      case 'atur': {
        const r = findRoom(plan, op.room);
        if (!['x', 'y', 'w', 'h'].some(k => op[k] !== undefined)) throw new Error('isi minimal satu dari x, y, w, h');
        if (op.w !== undefined) r.w = int(op.w, 8, MAX_PLAN, 'w');
        if (op.h !== undefined) r.h = int(op.h, 8, MAX_PLAN, 'h');
        if (op.x !== undefined || op.y !== undefined) moveRoom(plan, r, op.x !== undefined ? int(op.x, 0, MAX_PLAN, 'x') : r.x, op.y !== undefined ? int(op.y, 0, MAX_PLAN, 'y') : r.y);
        fitDoors(r); return;
      }
      case 'pintu': {
        const r = findRoom(plan, op.room);
        if (!Array.isArray(op.pintu) || op.pintu.length < 1 || op.pintu.length > 6) throw new Error('pintu harus array 1-6 pintu');
        r.doors = op.pintu.map(d => {
          if (!SIDES.includes(d?.s)) throw new Error('sisi pintu harus t, b, l, atau r');
          return { s: d.s, at: int(d.at, 1, MAX_PLAN, 'at'), w: int(d.w ?? 3, 2, 6, 'lebar pintu') };
        });
        return;
      }
      case 'lantai': { const r = findRoom(plan, op.room); if (!FLOORS.includes(op.lantai)) throw new Error(`lantai harus salah satu: ${FLOORS.join(', ')}`); r.floor = op.lantai; return; }
      case 'denah': plan.w = int(op.w, 20, MAX_PLAN, 'w'); plan.h = int(op.h, 20, MAX_PLAN, 'h'); return;
      case 'rapikan': tidyPlan(plan); return;
      default: throw new Error(`jenis operasi "${op.op}" tidak dikenal`);
    }
  } catch (e) { throw new Error(`${at}: ${e.message}`); }
}
const layoutOf = (plan, hidden) => ({
  w: plan.w, h: plan.h, hidden,
  rooms: plan.rooms.map(r => r.kind === 'zone' ? { id: r.id, x: r.x, w: r.w } : { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, floor: r.floor, doors: r.doors }),
  decor: plan.decor || [], runners: plan.runners || [], wings: plan.wings || [],
});
/** Edit a copy of the plan and save it as the office layout (furniture moves with rooms that only moved). Throws before writing if it does not fit. */
function editLayout(office, edit) {
  const before = officeModel(office).plan;
  const plan = structuredClone(before), furn = structuredClone(before.furniture || []);
  edit(plan);
  growPlan(plan);
  saveLayout(office, layoutOf(plan, j(getMeta(officeDb(office), 'layout'), {})?.hidden || []));
  const moved = carryFurn(before, furn, plan);
  if (moved !== furn) saveFurniture(office, moved);
}
function runOps(ident, ops, { why, coba = false }) {
  const { office, by } = ident;
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops harus array berisi minimal satu operasi');
  if (ops.length > MAX_OPS) throw new Error(`Terlalu banyak operasi (maks ${MAX_OPS})`);
  atomic(office, () => {
    if (!coba) snapshot(office, why, by);
    editLayout(office, plan => ops.forEach((op, i) => applyOp(plan, op, i)));
  }, { dry: coba });
  if (!coba) { emit(office, 'plan'); logOffice(office, by, why, 'denah'); }
}

/* ---------------- plan summary ---------------- */
function summary(office, roomRef_) {
  const m = officeModel(office), p = m.plan, cat = furniture().byId;
  const roles = roleRows(office);
  const furn = p.furniture || [];
  const roomAt = f => p.rooms.filter(r => r.kind !== 'zone').find(r => f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h);
  const count = new Map();
  for (const f of furn) { const r = roomAt(f); if (r) count.set(r.id, (count.get(r.id) || 0) + 1); }
  const rooms = p.rooms.map(r => ({
    id: r.id, nama: r.name, jenis: r.kind, ...(r.kind === 'zone' ? { zona_dari: r.zoneOf, x: r.x, lebar: r.w } : { x: r.x, y: r.y, w: r.w, h: r.h }),
    ...(r.doors?.length ? { pintu: r.doors } : {}), ...(r.floor ? { lantai: r.floor } : {}), ...(r.path ? { folder: r.path } : {}),
    penghuni: roles.filter(x => x.room === r.id).map(x => x.id), ...(count.get(r.id) ? { perabot: count.get(r.id) } : {}),
    ...(r.extra ? { tambahan: true } : {}),
  }));
  const out = { ukuran: { w: p.w, h: p.h }, kustom: !!m.custom, template: j(getMeta(officeDb(office), 'template'), null)?.id || null, ruangan: rooms, perabot_total: furn.length, masalah: resultProblems(p, roles), cadangan: snapshots(office).length };
  if (roomRef_) {
    const r = findRoom(p, roomRef_, { zone: true });
    const host = r.kind === 'zone' ? p.rooms.find(x => x.id === r.zoneOf) : r;
    out.detail = { ruangan: r.id, perabot: furn.filter(f => roomAt(f) === host).map(f => { const d = cat.get(f.item); return { uid: f.uid, item: f.item, nama: d?.name, x: f.x, y: f.y, w: d?.w, h: d?.h }; }) };
  }
  return out;
}

/* ---------------- furniture ---------------- */
function itemDef(ref) {
  const q = String(ref ?? '').trim().toLowerCase();
  const cat = furniture();
  const d = cat.byId.get(String(ref)) || cat.items.find(x => x.id.toLowerCase() === q) || cat.items.find(x => x.name.toLowerCase() === q);
  if (!d) throw new Error(`Perabot "${ref}" tidak ada di katalog. Cari dengan perabot_katalog.`);
  return d;
}
const roomAtTile = (plan, x, y) => plan.rooms.filter(r => r.kind !== 'zone').find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
/** Managers may touch any room's furniture; other roles only their own desk room (or the open-plan room their zone is part of). */
function allowFurn(ident, plan, room) {
  const role = ident.role;
  if (role?.isMgr) return;
  const own = role && (role.room === room.id || plan.rooms.some(z => z.kind === 'zone' && z.id === role.room && z.zoneOf === room.id));
  if (!own) throw new Error(role ? `Kamu hanya boleh mengubah perabot di ruanganmu sendiri (${plan.rooms.find(r => r.id === role.room)?.name || role.room}).` : 'Sesi ini tidak terikat ke role, jadi tidak boleh mengubah perabot.');
}
function newUid(list) {
  const used = new Set(list.map(f => f.uid));
  let uid; do uid = `m${Math.random().toString(36).slice(2, 8)}`; while (used.has(uid));
  return uid;
}
/** Free spots for `def` in `room`, best first (hugging walls), checked against furniture, desks, door landings and built-ins. */
function spotsFor(plan, room, def, roles) {
  const world = builtIns(plan, roles), desks = deskRects(world.desks), cat = furniture().byId;
  const I = interior(room), lands = doorLands(room);
  const solids = [...desks], flats = [];
  for (const f of plan.furniture || []) { const d = cat.get(f.item); if (d) (d.solid ? solids : flats).push({ x: f.x, y: f.y, w: d.w, h: d.h }); }
  const out = [];
  for (let y = I.y0; y + def.h <= I.y1; y++) {
    if (def.wall && y !== I.y0) continue;
    for (let x = I.x0; x + def.w <= I.x1; x++) {
      const b = { x, y, w: def.w, h: def.h };
      if (def.solid) {
        if (solids.some(o => overlap(b, o)) || lands.some(o => overlap(b, o))) continue;
        let free = true;
        for (let yy = y; yy < y + def.h && free; yy++) for (let xx = x; xx < x + def.w; xx++) if (world.walk[yy * world.W + xx] === 0) { free = false; break; }
        if (!free) continue;
      } else if (flats.some(o => overlap(b, o))) continue;
      const wallDist = Math.min(x - I.x0, I.x1 - (x + def.w), y - I.y0, I.y1 - (y + def.h));
      out.push({ x, y, score: wallDist * 100 + Math.abs(x - (I.x0 + I.x1) / 2) });
    }
  }
  return out.sort((p, q) => p.score - q.score);
}
const fmtItem = d => ({ id: d.id, nama: d.name, kategori: d.cat, ukuran: `${d.w}x${d.h}`, ...(d.wall ? { dinding: true } : {}), ...(d.solid ? {} : { datar: true }), ...(d.rooms?.length ? { untuk: d.rooms } : {}) });

/* ---------------- roles ---------------- */
const PALETTE = ['#2F5D9E', '#2C8452', '#1C7379', '#8A4B9C', '#B5532B', '#C2417A', '#55606E', '#9A7B1F'];
const HAIRS = ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A'];
const SKINS = ['#F1C9A5', '#D9A47C', '#B97E57', '#E8B98F'];
function look(t, name) {
  const h = hashStr(name);
  const out = { color: PALETTE[h % PALETTE.length], hair: HAIRS[(h >> 3) % HAIRS.length], skin: SKINS[(h >> 5) % SKINS.length], hairStyle: HAIR_STYLES[(h >> 7) % HAIR_STYLES.length] };
  for (const [k, v] of Object.entries(t || {})) {
    if (['color', 'hair', 'skin', 'hijab'].includes(k)) { if (!HEX.test(v)) throw new Error(`tampilan.${k} harus #RRGGBB`); out[k] = v; }
    else if (k === 'hairStyle') { if (!HAIR_STYLES.includes(v)) throw new Error(`tampilan.hairStyle: ${HAIR_STYLES.join(', ')}`); out[k] = v; }
    else if (k === 'outfit') { if (!OUTFITS.includes(v)) throw new Error(`tampilan.outfit: ${OUTFITS.join(', ')}`); out[k] = v; }
    else if (k === 'acc') { if (!ACCS.includes(v)) throw new Error(`tampilan.acc: ${ACCS.filter(Boolean).join(', ')} atau kosong`); out[k] = v; }
    else if (k === 'tie') out.tie = !!v;
    else throw new Error(`tampilan.${k} tidak dikenal`);
  }
  return out;
}
/** Fields shared by role_create / role_update, validated. Returns the store.js shape. */
function roleFields(office, a, cur) {
  const f = {};
  if (a.nama !== undefined) {
    f.name = clean(a.nama, 40, 'nama'); if (!f.name) throw new Error('nama kosong');
    if (st.listRoles(office, { archived: true }).some(r => r.id !== cur?.id && r.name.toLowerCase() === f.name.toLowerCase())) throw new Error(`Sudah ada role bernama ${f.name}`);
  }
  if (a.jabatan !== undefined) { f.title = clean(a.jabatan, 60, 'jabatan'); if (!f.title) throw new Error('jabatan kosong'); }
  if (a.kepribadian !== undefined) f.persona = clean(a.kepribadian, 4000, 'kepribadian');
  if (a.skills !== undefined) {
    if (!Array.isArray(a.skills) || a.skills.length > 20) throw new Error('skills harus array maks 20 item');
    f.skills = a.skills.map(s => clean(s, 60, 'skill')).filter(Boolean);
  }
  const engine = a.mesin ?? (cur ? undefined : 'claude');
  if (engine !== undefined) { if (!['claude', 'codex'].includes(engine)) throw new Error('mesin harus claude atau codex'); f.engine = engine; }
  const eng = f.engine ?? cur?.engine ?? 'claude';
  if (a.model !== undefined) {
    const m = clean(a.model, 60, 'model');
    if (eng === 'claude' && !MODELS.includes(m) && !/^claude-[a-z0-9.-]+$/.test(m)) throw new Error(`model claude: ${MODELS.join(', ')} atau id claude-…`);
    if (eng === 'codex' && m && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/.test(m)) throw new Error('nama model codex tidak valid');
    f.model = m;
  } else if (cur && f.engine && f.engine !== cur.engine) f.model = f.engine === 'codex' ? '' : 'sonnet';
  if (a.effort !== undefined) {
    if (eng !== 'codex' && a.effort) throw new Error('effort hanya untuk mesin codex');
    if (a.effort && !['low', 'medium', 'high', 'xhigh'].includes(a.effort)) throw new Error('effort: low, medium, high, atau xhigh');
    f.effort = a.effort || null;
  }
  if (a.atasan !== undefined) f.reportsTo = a.atasan || null;
  if (a.tampilan !== undefined) {
    if (typeof a.tampilan !== 'object' || Array.isArray(a.tampilan) || !a.tampilan) throw new Error('tampilan harus objek');
    Object.assign(f, look(a.tampilan, f.name || cur?.name || ''));
    if (cur) for (const k of ['color', 'hair', 'skin', 'hairStyle']) if (a.tampilan[k] === undefined) delete f[k];
  }
  return f;
}
/** Does room `roomId` still have a free desk for one more role? (`except` = a role that is being moved out of its current desk.) */
function deskFree(office, roomId, except = null) {
  const plan = officeModel(office).plan;
  const roles = [...roleRows(office).filter(r => r.id !== except), { id: '__baru', room: roomId, archived: 0 }];
  return builtIns(plan, roles).desks.some(d => d.role === '__baru');
}
/** Would `roomId` have a free desk for one more role if it were w×h? Computed on a copy of the plan, nothing is saved. */
function deskFitsAt(office, roomId, w, h) {
  const plan = structuredClone(officeModel(office).plan);
  const r = plan.rooms.find(x => x.id === roomId);
  if (!r) return false;
  r.w = w; r.h = h;
  const roles = [...roleRows(office), { id: '__baru', room: roomId, archived: 0 }];
  return builtIns(plan, roles).desks.some(d => d.role === '__baru');
}
/** A room with a free desk for a new role: the wanted one, else enlarged (validated like room_resize, with backup), else another room. Returns { room, note }. */
function roomWithDesk(ident, want) {
  const { office } = ident;
  if (deskFree(office, want.id)) return { room: want };
  const full = `${want.name} tidak punya meja kosong lagi.`;
  const plan0 = officeModel(office).plan;
  const w0 = want.w, h0 = want.h;
  const sizes = [[w0 + 4, h0], [w0, h0 + 4], [w0 + 4, h0 + 4], [w0 + 8, h0 + 8]].filter(([w, h]) => w <= MAX_PLAN && h <= MAX_PLAN);
  const canEver = want.kind !== 'zone' && deskFitsAt(office, want.id, Math.min(MAX_PLAN, w0 + 40), Math.min(MAX_PLAN, h0 + 40));
  if (!canEver) throw new Error(`${full} Ruangan jenis ${want.kind} tidak menampung meja walau diperbesar; pilih ruangan lain (denah_lihat).`);
  for (const [w, h] of sizes) {
    if (!deskFitsAt(office, want.id, w, h)) continue;
    try { runOps(ident, [{ op: 'ukuran', room: want.id, w, h }], { why: `memperbesar ${want.name} jadi ${w}×${h} untuk meja role baru` }); } catch { continue; }
    if (deskFree(office, want.id)) return { room: officeModel(office).plan.rooms.find(r => r.id === want.id), note: ` ${full} Ruangannya otomatis diperbesar ${w0}×${h0} jadi ${w}×${h} (cadangan ada; kembalikan dengan denah_pulihkan).` };
  }
  const alt = plan0.rooms.filter(r => r.id !== want.id && r.kind !== 'zone' && r.kind === want.kind && deskFree(office, r.id))[0]
    || plan0.rooms.filter(r => r.id !== want.id && ['kode', 'qa', 'server', 'manager', 'meeting', 'lib'].includes(r.kind) && deskFree(office, r.id))[0];
  if (alt) return { room: alt, note: ` ${full} Ruangannya tidak bisa diperbesar (terhalang ruangan lain), jadi ditempatkan di ${alt.name}. Pindahkan dengan role_update bila perlu.` };
  throw new Error(`${full} Memperbesarnya terhalang ruangan lain dan tidak ada ruangan lain yang kosong. Kosongkan/geser ruangan sekitarnya (denah_ubah) atau buat ruangan baru (room_create).`);
}
function pickRoom(office, ref, ident) {
  const plan = officeModel(office).plan;
  const r = ref ? findRoom(plan, ref, { zone: true }) : plan.rooms.find(x => x.id === ident.role?.room) || null;
  if (!r) throw new Error('Isi ruangan (id atau nama). Pakai denah_lihat untuk daftar ruangan.');
  return r;
}

/* ---------------- dispatcher ---------------- */
export async function callDenah(ident, name, a = {}) {
  const { office, role, by } = ident;
  switch (name) {
    /* ---- roles ---- */
    case 'role_create': {
      needMgr(ident, 'merekrut role baru');
      if (st.listRoles(office).length >= MAX_ROLES) throw new Error(`Sudah ada ${MAX_ROLES} role aktif; arsipkan yang tak terpakai dulu.`);
      const f = roleFields(office, a, null);
      if (!f.name || !f.title) throw new Error('nama dan jabatan wajib diisi');
      const placed = roomWithDesk(ident, pickRoom(office, a.ruangan, ident));
      const room = placed.room;
      const look_ = look(a.tampilan, f.name);
      const r = st.createRole(office, { name: f.name, title: f.title, persona: f.persona, skills: f.skills, engine: f.engine, model: f.model, effort: f.effort, reportsTo: f.reportsTo || undefined, room: room.id, ...look_ });
      invalidate(office); emit(office, 'plan');
      return text(`Role ${r.name} (id ${r.id}, ${r.title}) bergabung di ${room.name}, mesin ${r.engine}${r.model ? `, model ${r.model}` : ''}. Mulai kerjanya dengan shift_start(role: "${r.id}").${placed.note || ''}`);
    }
    case 'role_update': {
      needMgr(ident, 'mengubah role');
      const cur = st.getRole(office, a.role);
      if (!cur) throw new Error(`Role ${a.role} tidak ada. Pakai roles_list untuk melihat id role.`);
      const f = roleFields(office, a, cur);
      if (a.ruangan !== undefined) {
        const room = pickRoom(office, a.ruangan, ident);
        if (room.id !== cur.room) {
          if (!deskFree(office, room.id, cur.id)) throw new Error(`${room.name} tidak punya meja kosong lagi.`);
          f.room = room.id;
        }
      }
      if (!Object.keys(f).length) throw new Error('Tidak ada yang diubah. Isi minimal satu field selain role.');
      const r = st.updateRole(office, cur.id, f);
      invalidate(office); emit(office, 'plan');
      logOffice(office, by, `mengubah role ${r.name}`, 'role');
      const running = [...live.values()].some(s => s.office === office && s.role === r.id && s.status !== 'ended');
      return text(`Role ${r.name} diperbarui.${running ? ' Sesi yang sedang jalan memakai pengaturan baru pada shift berikutnya.' : ''}`);
    }
    case 'role_arsipkan': {
      needMgr(ident, 'mengarsipkan role');
      const cur = st.getRole(office, a.role);
      if (!cur) throw new Error(`Role ${a.role} tidak ada.`);
      if (a.pulihkan) {
        if (!cur.archived) return text(`${cur.name} tidak sedang diarsipkan.`);
        const room = officeModel(office).plan.rooms.find(r => r.id === cur.room);
        if (!room || !deskFree(office, cur.room)) throw new Error(`Ruangan ${cur.room} tidak ada atau penuh; pindahkan dulu dengan role_update setelah dipulihkan, atau kosongkan mejanya.`);
        st.updateRole(office, cur.id, { archived: false }); invalidate(office); emit(office, 'plan');
        logOffice(office, by, `memulihkan role ${cur.name} dari arsip`, 'role');
        return text(`${cur.name} aktif kembali.`);
      }
      if (cur.archived) return text(`${cur.name} sudah diarsipkan.`);
      if (cur.isMgr) throw new Error('Manager tidak bisa diarsipkan.');
      if (cur.id === role.id) throw new Error('Tidak bisa mengarsipkan diri sendiri.');
      if ([...live.values()].some(s => s.office === office && s.role === cur.id && s.status !== 'ended')) throw new Error(`${cur.name} sedang shift. Selesaikan sesinya dulu.`);
      st.updateRole(office, cur.id, { archived: true }); invalidate(office); emit(office, 'plan');
      logOffice(office, by, `mengarsipkan role ${cur.name}`, 'role');
      return text(`${cur.name} diarsipkan (riwayat tetap ada; pulihkan dengan pulihkan=true).`);
    }
    /* ---- rooms ---- */
    case 'room_create': {
      needMgr(ident, 'menambah ruangan');
      const nm = clean(a.name, 40, 'nama ruangan');
      if (!nm) throw new Error('Nama ruangan wajib diisi');
      const kind = a.kind || 'kode';
      if (!ROOM_KINDS.includes(kind)) throw new Error(`Jenis ruangan tidak dikenal. Pilihan: ${ROOM_KINDS.join(', ')}`);
      const size = a.ukuran ? { w: int(a.ukuran.w, 8, 150, 'ukuran.w'), h: int(a.ukuran.h, 8, 150, 'ukuran.h') } : null;
      const pos = a.posisi ? { x: int(a.posisi.x, 0, MAX_PLAN, 'posisi.x'), y: int(a.posisi.y, 0, MAX_PLAN, 'posisi.y') } : null;
      let rid;
      atomic(office, () => {
        if (size || pos) snapshot(office, `menambah ruangan ${nm}`, by);
        rid = addRoom(office, { name: nm, kind, path: a.path || '', create: !!a.create, gitInit: !!a.git_init && !!a.create });
        if (size || pos) editLayout(office, plan => {
          const r = plan.rooms.find(x => x.id === rid);
          if (size) { r.w = size.w; r.h = size.h; fitDoors(r); }
          if (pos) moveRoom(plan, r, pos.x, pos.y);
        });
      });
      emit(office, 'plan'); logOffice(office, by, `menambah ruangan ${nm}`, 'denah');
      return text(`Ruangan ${nm} (${rid}) ditambahkan ke denah.${size || pos ? '' : ' Isi perabotnya dengan perabot_isi_ruangan.'}`);
    }
    case 'room_update': {
      needMgr(ident, 'mengubah ruangan');
      const plan = officeModel(office).plan;
      const r = findRoom(plan, a.room);
      const size = a.ukuran ? { w: int(a.ukuran.w, 8, MAX_PLAN, 'ukuran.w'), h: int(a.ukuran.h, 8, MAX_PLAN, 'ukuran.h') } : null;
      const pos = a.posisi ? { x: int(a.posisi.x, 0, MAX_PLAN, 'posisi.x'), y: int(a.posisi.y, 0, MAX_PLAN, 'posisi.y') } : null;
      const patch = {};
      if (a.nama !== undefined) { patch.name = clean(a.nama, 40, 'nama'); if (!patch.name) throw new Error('nama kosong'); }
      if (a.jenis !== undefined) {
        if (!ROOM_KINDS.includes(a.jenis)) throw new Error(`Jenis ruangan tidak dikenal. Pilihan: ${ROOM_KINDS.join(', ')}`);
        if (!r.extra) throw new Error('Jenis hanya bisa diubah untuk ruangan tambahan, bukan ruangan dari repo atau fasilitas bawaan.');
        patch.kind = a.jenis;
      }
      if (a.catatan !== undefined) patch.note = clean(a.catatan, 300, 'catatan');
      if (!Object.keys(patch).length && !size && !pos) throw new Error('Tidak ada yang diubah. Isi nama, jenis, catatan, ukuran, atau posisi.');
      atomic(office, () => {
        if (size || pos) snapshot(office, `mengubah ruangan ${r.name}`, by);
        if (Object.keys(patch).length) updateRoom(office, r.id, patch);
        if (size || pos) editLayout(office, pl => {
          const x = pl.rooms.find(q => q.id === r.id);
          if (size) { x.w = size.w; x.h = size.h; fitDoors(x); }
          if (pos) moveRoom(pl, x, pos.x, pos.y);
        });
      });
      emit(office, 'plan'); logOffice(office, by, `mengubah ruangan ${r.name}`, 'denah');
      return text(`Ruangan ${patch.name || r.name} diperbarui.`);
    }
    case 'room_pindah': case 'room_resize': {
      needMgr(ident, 'mengubah denah');
      const r = findRoom(officeModel(office).plan, a.room);
      const op = name === 'room_pindah' ? { op: 'pindah', room: r.id, x: a.x, y: a.y } : { op: 'ukuran', room: r.id, w: a.w, h: a.h };
      runOps(ident, [op], { why: name === 'room_pindah' ? `memindahkan ${r.name} ke (${a.x}, ${a.y})` : `mengubah ukuran ${r.name} jadi ${a.w}×${a.h}` });
      return text(name === 'room_pindah' ? `${r.name} dipindah ke (${a.x}, ${a.y}).` : `${r.name} sekarang ${a.w}×${a.h}.`);
    }
    case 'room_hapus': {
      needMgr(ident, 'menghapus ruangan');
      const plan = officeModel(office).plan, r = findRoom(plan, a.room);
      const db = officeDb(office), extra = j(getMeta(db, 'extraRooms'), []);
      if (!extra.some(x => x.id === r.id)) throw new Error('Hanya ruangan tambahan yang bisa dihapus. Ruangan dari repo atau fasilitas bawaan tidak.');
      if (r.path) throw new Error(`${r.name} terhubung ke folder ${r.path} (repo). Ruangan berfolder tidak dihapus dari sini.`);
      const zoneIds = plan.rooms.filter(z => z.zoneOf === r.id).map(z => z.id);
      const people = roleRows(office).filter(x => x.room === r.id || zoneIds.includes(x.room)).map(x => x.id);
      if (people.length) throw new Error(`${r.name} masih dihuni: ${people.join(', ')}. Pindahkan dulu dengan role_update.`);
      const sess = [...live.values()].filter(s => s.office === office && s.room === r.id && s.status !== 'ended');
      if (sess.length) throw new Error(`${r.name} masih ada sesi yang berjalan.`);
      let removed = 0;
      atomic(office, () => {
        snapshot(office, `menghapus ruangan ${r.name}`, by);
        const inRoom = f => f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h;
        const keep = (plan.furniture || []).filter(f => !inRoom(f));
        removed = (plan.furniture || []).length - keep.length;
        updateRoom(office, r.id, { remove: true });
        invalidate(office);
        saveFurniture(office, keep);
        if (getMeta(db, 'layout')) editLayout(office, () => {});
      });
      emit(office, 'plan'); logOffice(office, by, `menghapus ruangan ${r.name}`, 'denah');
      return text(`Ruangan ${r.name} dihapus${removed ? ` beserta ${removed} perabot` : ''}. Pulihkan dengan denah_pulihkan bila keliru.`);
    }
    /* ---- floor plan ---- */
    case 'denah_lihat': return text(summary(office, a.room));
    case 'denah_ubah': {
      needMgr(ident, 'merombak denah');
      runOps(ident, a.ops, { why: `merombak denah (${a.ops?.length} operasi)`, coba: !!a.coba });
      return text(a.coba ? `Lolos uji: ${a.ops.length} operasi bisa diterapkan. Belum ada yang disimpan.` : `${a.ops.length} operasi diterapkan. Cadangan tersimpan (denah_pulihkan untuk membatalkan).`);
    }
    case 'denah_rapikan': {
      needMgr(ident, 'merapikan denah');
      runOps(ident, [{ op: 'rapikan' }], { why: 'merapikan denah otomatis', coba: !!a.coba });
      return text(a.coba ? 'Lolos uji: rapikan otomatis bisa diterapkan. Belum ada yang disimpan.' : 'Denah dirapikan. Cadangan tersimpan (denah_pulihkan untuk membatalkan).');
    }
    case 'denah_pulihkan': {
      if (a.daftar) return text(snapshots(office).map(s => ({ id: s.id, waktu: s.at, oleh: s.by, sebelum: s.why })).reverse());
      needMgr(ident, 'memulihkan denah');
      const { s, masalah } = restoreSnapshot(office, a.id, by);
      emit(office, 'plan');
      logOffice(office, by, `memulihkan denah ke cadangan ${s.id}`, 'denah');
      return text(`Denah dipulihkan ke keadaan sebelum "${s.why}" (cadangan ${s.id}).${masalah.length ? ` Catatan, masalah yang ada: ${listMore(masalah)}.` : ''}`);
    }
    /* ---- templates ---- */
    case 'template_list': {
      const l = templateList();
      return text({ aktif: templateState(office), template: l.templates.map(t => ({ id: t.id, nama: t.name, deskripsi: t.desc, suasana: t.mood, fasilitas: t.facilities.map(f => f.name) })), ...(l.problems ? { rusak: l.problems } : {}) });
    }
    case 'template_pratinjau': {
      const p = previewTemplate(office, a.template, a.seed === undefined ? 1 : int(a.seed, 0, 1e6, 'seed'));
      return text({ template: p.template, seed: p.seed, ukuran: { w: p.plan.w, h: p.plan.h }, ruangan_baru: p.newRooms.map(r => r.name), dibuang: p.dropped, perabot: p.furniture.length, masalah: p.problems, bisa_dipasang: !p.problems.length });
    }
    case 'template_terapkan': {
      needMgr(ident, 'memasang template');
      const seed = a.seed === undefined ? 1 : int(a.seed, 0, 1e6, 'seed');
      // applyTemplate has its own transaction and checks; only the backup is ours (dropped again if the template is refused)
      const snap = snapshot(office, `memasang template ${a.template}`, by);
      let r;
      try { r = applyTemplate(office, a.template, seed); }
      catch (e) { putMeta(officeDb(office), 'denah-backup', JSON.stringify(snapshots(office).filter(x => x.id !== snap))); throw e; }
      emit(office, 'plan'); logOffice(office, by, `memasang template ${r.template}`, 'denah');
      return text(`Template ${r.template} (seed ${r.seed}) terpasang. Ruangan baru: ${r.newRooms.map(x => x.name).join(', ') || '-'}. Kembalikan dengan template_pulihkan atau denah_pulihkan.`);
    }
    case 'template_pulihkan': {
      needMgr(ident, 'memulihkan susunan kantor');
      restoreTemplate(office);
      emit(office, 'plan'); logOffice(office, by, 'memulihkan susunan sebelum template', 'denah');
      return text('Denah, perabot, dan ruangan dikembalikan seperti sebelum template pertama dipasang.');
    }
    /* ---- furniture ---- */
    case 'perabot_katalog': {
      const items = furniture().items;
      const kat = a.kategori ? String(a.kategori).toLowerCase() : '', q = a.cari ? String(a.cari).toLowerCase() : '';
      if (!kat && !q) {
        const by_ = new Map();
        for (const d of items) by_.set(d.cat, (by_.get(d.cat) || 0) + 1);
        return text({ jumlah: items.length, kategori: [...by_].map(([nama, jumlah]) => ({ nama, jumlah })), petunjuk: 'Panggil lagi dengan kategori dan/atau cari untuk melihat item.' });
      }
      const hit = items.filter(d => (!kat || d.cat.toLowerCase() === kat) && (!q || d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)));
      return text({ cocok: hit.length, item: hit.slice(0, 60).map(fmtItem), ...(hit.length > 60 ? { catatan: 'Hanya 60 pertama; persempit pencarian.' } : {}) });
    }
    case 'perabot_taruh': {
      rate(ident);
      const plan = officeModel(office).plan, room = findRoom(plan, a.room), def = itemDef(a.item);
      allowFurn(ident, plan, room);
      const cur = plan.furniture || [];
      const put = (x, y) => { const uid = newUid(cur); atomic(office, () => saveFurniture(office, [...cur, { uid, item: def.id, x, y }])); return uid; };
      let uid, at;
      if (a.x !== undefined || a.y !== undefined) {
        at = { x: int(a.x, 0, MAX_PLAN, 'x'), y: int(a.y, 0, MAX_PLAN, 'y') };
        if (roomAtTile(plan, at.x, at.y) !== room) throw new Error(`Posisi (${at.x}, ${at.y}) di luar ${room.name}.`);
        uid = put(at.x, at.y);
      } else {
        const spots = spotsFor(plan, room, def, roleRows(office));
        let last;
        for (const s of spots.slice(0, 12)) { try { uid = put(s.x, s.y); at = s; break; } catch (e) { last = e; } }
        if (!uid) throw new Error(`Tidak ada tempat untuk ${def.name} di ${room.name}${spots.length ? ' yang tidak menutup jalan' : ' (ruangan penuh atau terlalu sempit)'}.${last ? ` ${last.message.split('\n')[0]}` : ''}`);
      }
      emit(office, 'furniture'); logOffice(office, by, `menaruh ${def.name} di ${room.name}`, 'denah');
      return text(`${def.name} ditaruh di ${room.name} pada (${at.x}, ${at.y}), uid ${uid}.`);
    }
    case 'perabot_pindah': {
      rate(ident);
      const plan = officeModel(office).plan, cur = plan.furniture || [];
      const f = cur.find(x => x.uid === a.uid);
      if (!f) throw new Error(`Perabot ${a.uid} tidak ada. Lihat uid di denah_lihat dengan room.`);
      const x = int(a.x, 0, MAX_PLAN, 'x'), y = int(a.y, 0, MAX_PLAN, 'y');
      const from = roomAtTile(plan, f.x, f.y), to = roomAtTile(plan, x, y);
      if (!from || !to) throw new Error('Perabot harus tetap di dalam sebuah ruangan.');
      allowFurn(ident, plan, from); allowFurn(ident, plan, to);
      if (from !== to) throw new Error(`Perabot hanya boleh dipindah dalam ${from.name}. Hapus lalu taruh lagi untuk ruangan lain.`);
      atomic(office, () => saveFurniture(office, cur.map(q => q.uid === f.uid ? { ...q, x, y } : q)));
      emit(office, 'furniture'); logOffice(office, by, `memindahkan perabot di ${from.name}`, 'denah');
      return text(`${furniture().byId.get(f.item)?.name || f.item} dipindah ke (${x}, ${y}).`);
    }
    case 'perabot_hapus': {
      rate(ident);
      const uids = [...new Set([...(a.uids || []), ...(a.uid ? [a.uid] : [])].map(String))];
      if (!uids.length) throw new Error('Isi uid atau uids.');
      if (uids.length > 100) throw new Error('Maks 100 perabot sekali hapus.');
      const plan = officeModel(office).plan, cur = plan.furniture || [];
      const gone = uids.map(u => cur.find(x => x.uid === u) || (() => { throw new Error(`Perabot ${u} tidak ada.`); })());
      for (const f of gone) { const r = roomAtTile(plan, f.x, f.y); if (r) allowFurn(ident, plan, r); else if (!ident.role?.isMgr) throw new Error('Hanya manager yang boleh menghapus perabot di luar ruangan.'); }
      atomic(office, () => saveFurniture(office, cur.filter(x => !uids.includes(x.uid))));
      emit(office, 'furniture'); logOffice(office, by, `menghapus ${gone.length} perabot`, 'denah');
      return text(`${gone.length} perabot dihapus.`);
    }
    case 'perabot_isi_ruangan': {
      rate(ident);
      const plan = officeModel(office).plan, room = findRoom(plan, a.room);
      allowFurn(ident, plan, room);
      const dens = a.kepadatan === undefined ? 1 : Number(a.kepadatan);
      if (!(dens >= .2 && dens <= 2)) throw new Error('kepadatan harus 0.2 sampai 2');
      const seed = a.seed === undefined ? Date.now() % 1e6 : int(a.seed, 0, 1e9, 'seed');
      let added = 0;
      atomic(office, () => {
        snapshot(office, `mengisi perabot ${room.name}`, by);
        const pl = structuredClone(officeModel(office).plan), r = pl.rooms.find(x => x.id === room.id);
        const roles = roleRows(office), world = builtIns(pl, roles), desks = deskRects(world.desks), cat = furniture();
        const list = pl.furniture || [];
        const pool = cat.items.filter(d => (d.rooms || []).some(k => k === r.kind || k === '*')).map(d => ({ ...d, weight: d.weight ?? 1 }));
        const blocked = (x, y) => x >= 0 && y >= 0 && x < world.W && y < world.H && world.walk[y * world.W + x] === 0;
        const n = [...list];
        const new_ = fillRoom(r, mulberry(hashStr(`${seed}:${r.id}`)), list, { def: id => cat.byId.get(id), uid: () => { const u = newUid(n); n.push({ uid: u }); return u; }, desks, blocked, cands: pool, density: dens, walls: 1, center: [] });
        added = new_.length;
        if (added) saveFurniture(office, [...list, ...new_]);
      });
      if (added) { emit(office, 'furniture'); logOffice(office, by, `mengisi ${room.name} dengan ${added} perabot`, 'denah'); }
      return text(added ? `${added} perabot ditambahkan ke ${room.name}. Cadangan tersimpan (denah_pulihkan untuk membatalkan).` : `Tidak ada perabot yang muat atau cocok ditambahkan ke ${room.name}.`);
    }
  }
  return null;
}
