import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-boards-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const api = path.join(root, 'shop/api');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(api, { recursive: true });
fs.writeFileSync(path.join(api, 'go.mod'), 'module api');
fs.writeFileSync(path.join(api, 'poster.png'), 'PNGDATA');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', pratinjau: { batchSec: 60 } }));

let db, cfg, store, bd, ag, pv, dm, live, M, bayu, priskilla, zora;
const ident = (r, sid) => ({ office: 'shop', role: r, by: r.name, sid, cwd: api });
const call = async (r, tool, a) => (await ag.callTool(ident(r), tool, a)).content[0].text;
const json = async (r, tool, a) => JSON.parse(await call(r, tool, a));

before(async () => {
  const offices = await import('../server/offices.js');
  db = await import('../server/db.js');
  cfg = await import('../server/config.js');
  store = await import('../server/store.js');
  bd = await import('../server/boards.js');
  ag = await import('../server/agent.js');
  pv = await import('../server/pratinjau.js');
  dm = await import('../server/dm.js');
  live = await import('../server/live.js');
  M = await import('../server/metrics.js');
  offices.officeForCwd(api);
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Dev', room: 'api' });
  priskilla = store.createRole('shop', { name: 'Priskilla', title: 'Head of Creative', room: 'ruang-kreatif' });
  zora = store.createRole('shop', { name: 'Zora', title: 'Creative Associate', room: 'ruang-kreatif' });
  dm.setSender(async () => {});
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('migrasi: kartu lama masuk papan Utama, kolom 0..4 jadi jenis, riwayat jadi card_moves; aman diulang', () => {
  const steps = db.OFFICE_MIGRATIONS, at = steps.findIndex(s => s.includes('CREATE TABLE boards'));
  assert.ok(at > 0);
  cfg.ensureDirs();
  const file = path.join(cfg.OFFICE_DIR, 'lama.db');
  const raw = new DatabaseSync(file);
  for (let i = 0; i < at; i++) raw.exec(steps[i]);
  raw.exec(`PRAGMA user_version = ${at}`);
  const ins = raw.prepare("INSERT INTO cards (id, title, col, created_at, updated_at) VALUES (?, ?, ?, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')");
  ['a', 'b', 'c', 'd', 'e'].forEach((id, i) => ins.run(id, 'Kartu ' + id, i));
  raw.prepare("INSERT INTO card_hist (card_id, who, text, at) VALUES ('e', 'x', 'membuat kartu di Backlog', '2030-01-01T00:00:00Z')").run();
  raw.prepare("INSERT INTO card_hist (card_id, who, text, at) VALUES ('e', 'x', 'memindahkan Review → Selesai', '2030-01-02T00:00:00Z')").run();
  raw.close();
  const o = db.officeDb('lama');
  const rows = db.all(o, 'SELECT id, board, col, kind FROM cards ORDER BY id');
  assert.deepEqual(rows.map(r => [r.board, r.col, r.kind]), [['utama', 0, 'antre'], ['utama', 1, 'siap'], ['utama', 2, 'dikerjakan'], ['utama', 3, 'review'], ['utama', 4, 'selesai']]);
  const moves = db.all(o, "SELECT from_kind, to_kind, to_name FROM card_moves WHERE card_id = 'e' ORDER BY at");
  assert.deepEqual(moves.map(m => [m.from_kind, m.to_kind]), [[null, 'antre'], ['review', 'selesai']]);
  const cards = store.listCards('lama');
  assert.deepEqual(cards.map(c => c.colName), ['Backlog', 'Siap', 'Dikerjakan', 'Review', 'Selesai']);
  assert.deepEqual(cards.map(c => c.stage), [0, 1, 2, 3, 4]);
  assert.equal(cards.find(c => c.id === 'e').done, true);
  // diulang: tidak ada yang berubah, papan tidak dobel
  db.closeAll();
  const again = db.officeDb('lama');
  assert.equal(db.one(again, 'SELECT COUNT(*) n FROM boards').n, 1);
  assert.equal(db.one(again, 'SELECT COUNT(*) n FROM card_moves').n, 2);
});

test('papan: buat dari template, validasi kolom, ubah/urut/hapus kolom dengan pemindahan kartu', () => {
  const list = bd.listBoards('shop');
  assert.deepEqual(list.map(b => b.id), ['utama']);
  const k = bd.createBoard('shop', { template: 'kreatif', rooms: ['ruang-kreatif'] });
  assert.equal(k.name, 'Kreatif');
  assert.deepEqual(k.columns.map(c => c.name), ['Brief', 'Konsep', 'Produksi', 'Review', 'Revisi', 'Final', 'Tayang', 'Arsip']);
  assert.throws(() => bd.createBoard('shop', { template: 'kreatif' }), /Sudah ada papan/);
  assert.throws(() => bd.createBoard('shop', { name: 'X', columns: [{ name: 'A', kind: 'antre' }] }), /selesai/);
  assert.throws(() => bd.createBoard('shop', { name: 'X', columns: [{ name: 'A', kind: 'aneh' }, { name: 'B', kind: 'selesai' }] }), /tidak sah/);
  assert.throws(() => bd.createBoard('shop', { name: 'X', columns: [{ name: 'A', kind: 'antre' }, { name: 'a', kind: 'selesai' }] }), /dobel/);
  assert.throws(() => bd.deleteBoard('shop', 'utama'), /tidak bisa/);

  const c = store.createCard('shop', { title: 'Poster', board: 'Kreatif', col: 'Produksi' }, 'Kamu');
  assert.equal(c.board, 'kreatif'); assert.equal(c.col, 2); assert.equal(c.colKind, 'dikerjakan'); assert.equal(c.done, false);
  // nama kolom lama dan jenis tetap dipahami di papan lain
  assert.equal(store.updateCard('shop', c.id, { col: 'Selesai' }, 'Kamu').colName, 'Final');
  assert.equal(store.updateCard('shop', c.id, { col: 'review' }, 'Kamu').colName, 'Review');
  assert.throws(() => store.updateCard('shop', c.id, { col: 'Tidak Ada' }, 'Kamu'), /Kolom tidak dikenal/);

  // hapus kolom berisi kartu: ditolak tanpa tujuan; dengan tujuan kartunya ikut pindah
  const cols = bd.getBoard('shop', 'kreatif').columns;
  const without = cols.filter(x => x.name !== 'Review');
  assert.throws(() => bd.updateBoard('shop', 'kreatif', { columns: without }), /masih berisi 1 kartu/);
  bd.updateBoard('shop', 'kreatif', { columns: without, moveTo: { review: 'revisi' } });
  let now = store.getCard('shop', c.id);
  assert.equal(now.colName, 'Revisi'); assert.equal(now.colKind, 'dikerjakan');
  // urutan & ganti nama & ganti jenis: kartu ikut kolomnya, jenis tersimpan ikut berubah
  const b2 = bd.getBoard('shop', 'kreatif').columns;
  const rev = b2.find(x => x.id === 'revisi');
  bd.updateBoard('shop', 'kreatif', { columns: [{ ...rev, name: 'Perbaikan', kind: 'review' }, ...b2.filter(x => x.id !== 'revisi')] });
  now = store.getCard('shop', c.id);
  assert.equal(now.col, 0); assert.equal(now.colName, 'Perbaikan'); assert.equal(now.colKind, 'review');
  assert.throws(() => bd.updateBoard('shop', 'kreatif', { columns: [{ name: 'Satu', kind: 'antre' }] }), /selesai/);
  // kembalikan ke template untuk tes berikutnya
  bd.updateBoard('shop', 'kreatif', { columns: bd.TEMPLATES.kreatif.columns });
  assert.equal(store.getCard('shop', c.id).colName, 'Revisi', 'kolom yang sama (id revisi) kembali ke nama template');
  assert.equal(store.getCard('shop', c.id).colKind, 'dikerjakan');

  // pindah papan: kolom ikut jenis yang sama
  const moved = store.updateCard('shop', c.id, { board: 'utama' }, 'Kamu');
  assert.equal(moved.board, 'utama'); assert.equal(moved.colName, 'Dikerjakan');
  store.updateCard('shop', c.id, { board: 'kreatif', col: 'Brief' }, 'Kamu');

  // arsipkan papan: kartu pindah ke Utama lewat jenis
  const tmpB = bd.createBoard('shop', { name: 'Sementara' });
  const t = store.createCard('shop', { title: 'Sementara', board: tmpB.id, col: 'Review' }, 'Kamu');
  bd.deleteBoard('shop', tmpB.id);
  assert.equal(store.getCard('shop', t.id).board, 'utama');
  assert.equal(store.getCard('shop', t.id).colKind, 'review');
  assert.ok(bd.getBoard('shop', tmpB.id).archived);
});

test('API lama: tanpa papan = Utama; card_moves terekam; publishAt dan sampul', () => {
  const u = store.createCard('shop', { title: 'Fitur', col: 2 }, 'Kamu');
  assert.equal(u.board, 'utama'); assert.equal(u.colName, 'Dikerjakan');
  assert.ok(store.listCards('shop', { board: 'utama' }).every(c => c.board === 'utama'));
  assert.ok(store.listCards('shop', { board: 'all' }).some(c => c.board === 'kreatif'));
  const c = store.createCard('shop', { title: 'Reels', board: 'kreatif', publishAt: '2030-02-01' }, 'Kamu');
  assert.equal(c.publishAt, '2030-02-01');
  assert.equal(store.updateCard('shop', c.id, { publishAt: '' }, 'Kamu').publishAt, '');
  assert.throws(() => store.updateCard('shop', c.id, { publishAt: 'besok' }, 'Kamu'), /YYYY-MM-DD/);
  const withCover = store.updateCard('shop', c.id, { cover: 'pv:p0123456789:f1' }, 'Kamu');
  assert.match(withCover.coverUrl, /^\/pvt\/shop\/p0123456789\/[0-9a-f]{24}\/f1\.jpg$/);
  assert.equal(store.updateCard('shop', c.id, { cover: 'm123' }, 'Kamu').coverUrl, '/api/offices/shop/media/m123');
  store.updateCard('shop', c.id, { col: 'Konsep' }, 'Kamu');
  const g = store.getCard('shop', c.id);
  assert.deepEqual(g.moves.map(m => [m.fromKind, m.toKind, m.toName]), [[null, 'antre', 'Brief'], ['antre', 'dikerjakan', 'Konsep']]);
});

test('logika jenis kolom: selesai di kolom mana pun yang berjenis selesai dihitung di metrik', async () => {
  const c = store.createCard('shop', { title: 'Video', board: 'kreatif', col: 'Konsep' }, 'Kamu');
  store.updateCard('shop', c.id, { col: 'Review' }, 'Kamu');
  store.updateCard('shop', c.id, { col: 'Tayang' }, 'Kamu');
  const card = store.getCard('shop', c.id);
  assert.equal(card.done, true); assert.equal(card.stage, 4);
  const m = await M.officeMetrics('shop', { range: '24h' });
  assert.ok(m.cards.done >= 1, 'kartu di kolom Tayang (jenis selesai) dihitung selesai');
  assert.ok(m.cards.started >= 1);
  assert.ok(Object.keys(m.cards.board).some(k => k.startsWith('Kreatif · ')));
});

test('dependensi lintas papan diizinkan, siklus tetap ditolak', () => {
  const a = store.createCard('shop', { title: 'API banner', board: 'utama' }, 'Kamu');
  const b = store.createCard('shop', { title: 'Banner', board: 'kreatif', deps: [a.id] }, 'Kamu');
  assert.deepEqual(store.getCard('shop', b.id).deps.map(d => [d.id, d.board]), [[a.id, 'utama']]);
  assert.throws(() => store.updateCard('shop', a.id, { deps: [b.id] }, 'Kamu'), /melingkar/);
});

test('MCP: papan bawaan dari ruangan role, papan eksplisit, semua papan', async () => {
  const mine = await json(zora, 'board_list', {});
  assert.equal(mine.papan_ini, 'kreatif');
  assert.ok(mine.papan.some(p => p.id === 'utama') && mine.papan.some(p => p.id === 'kreatif'));
  assert.ok(mine.kartu.every(k => k.papan === 'kreatif'));
  assert.equal((await json(bayu, 'board_list', {})).papan_ini, 'utama');
  assert.equal((await json(bayu, 'board_list', { papan: 'Kreatif' })).papan_ini, 'kreatif');
  const all = await json(bayu, 'board_list', { papan: 'semua', col: 'selesai' });
  assert.ok(all.kartu.length && all.kartu.every(k => k.jenis_kolom === 'selesai'));
  assert.match(await call(zora, 'card_create', { title: 'Carousel', col: 'Konsep', publish_at: '2030-03-01' }), /papan Kreatif, kolom Konsep/);
  assert.match(await call(bayu, 'card_create', { title: 'Endpoint' }), /papan Utama, kolom Backlog/);
  assert.match(await call(bayu, 'card_create', { title: 'Thumbnail', papan: 'kreatif' }), /papan Kreatif/);
  const id = (await json(zora, 'board_list', {})).kartu.find(k => k.judul === 'Carousel').id;
  assert.equal((await json(zora, 'board_list', {})).kartu.find(k => k.id === id).tayang, '2030-03-01');
  assert.match(await call(zora, 'card_update', { id, col: 'Review' }), /papan Kreatif, Review/);
  assert.match(await call(zora, 'card_update', { id, papan: 'utama' }), /Review/);
  await assert.rejects(() => ag.callTool(ident(zora), 'board_list', { papan: 'tidakada' }), /tidak ditemukan/);
  const tool = ag.TOOLS.find(t => t.name === 'card_create');
  assert.ok(tool.inputSchema.properties.papan);
  // papan per role mengalahkan ruangan
  bd.updateBoard('shop', 'utama', { roles: [zora.id] });
  assert.equal((await json(zora, 'board_list', {})).papan_ini, 'utama');
  bd.updateBoard('shop', 'utama', { roles: [] });
});

test('pratinjau terkait kartu: setuju memindah Review → Final, revisi → kolom Revisi plus komentar', async () => {
  const s = live.expectSession({ sid: 's-zora', office: 'shop', role: zora.id, room: 'ruang-kreatif', cwd: api, tmux: 'kc-test-b', slot: 0, title: 't' });
  s.status = 'idle';
  const c = store.createCard('shop', { title: 'Feed IG', board: 'kreatif', col: 'Review' }, 'Kamu');
  const it = await pv.sendItem({ office: 'shop', role: zora, by: 'Zora', sid: 's-zora', cwd: api }, { judul: 'Feed', files: ['poster.png'], kartu: c.id });
  await pv.requestRevision('shop', it.id, { catatan: 'Warna logo salah' });
  let now = store.getCard('shop', c.id);
  assert.equal(now.colName, 'Revisi');
  assert.match(now.comments.at(-1).text, /Warna logo salah/);
  // revisi -> kembali ke Review -> disetujui -> Final
  store.updateCard('shop', c.id, { col: 'Review' }, 'Kamu');
  await pv.approveAll('shop', it.id, {});
  now = store.getCard('shop', c.id);
  assert.equal(now.colName, 'Final'); assert.equal(now.done, true);
  // disetujui padahal tidak sedang di review: kartu tidak dipindah
  const d = store.createCard('shop', { title: 'Story', board: 'kreatif', col: 'Konsep' }, 'Kamu');
  const it2 = await pv.sendItem({ office: 'shop', role: zora, by: 'Zora', sid: 's-zora', cwd: api }, { judul: 'Story', files: ['poster.png'], kartu: d.id });
  await pv.approveAll('shop', it2.id, {});
  assert.equal(store.getCard('shop', d.id).colName, 'Konsep');
  // papan tanpa kolom bernama Revisi: ke kolom 'dikerjakan' pertama
  const e = store.createCard('shop', { title: 'Fitur', board: 'utama', col: 'Review' }, 'Kamu');
  const it3 = await pv.sendItem({ office: 'shop', role: zora, by: 'Zora', sid: 's-zora', cwd: api }, { judul: 'UI', files: ['poster.png'], kartu: e.id });
  await pv.requestRevision('shop', it3.id, { catatan: 'Tombol terlalu kecil' });
  assert.equal(store.getCard('shop', e.id).colName, 'Dikerjakan');
  pv.flushDecisions();
});
