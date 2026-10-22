import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tolerant-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
for (const d of ['api', 'web']) { fs.mkdirSync(path.join(root, 'shop', d, '.git'), { recursive: true }); fs.writeFileSync(path.join(root, 'shop', d, 'package.json'), '{}'); }
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let ag, dt, offices, store, live, mq, mgr, card;
const ident = r => ({ office: 'shop', role: r, by: r?.name || 'Sesi manual', sid: null });
const callText = async (r, tool, a) => (await ag.callTool(ident(r), tool, a)).content[0].text;
const fails = (r, tool, a, re) => assert.rejects(() => ag.callTool(ident(r), tool, a), re);

before(async () => {
  offices = await import('../server/offices.js');
  store = await import('../server/store.js');
  live = await import('../server/live.js');
  ag = await import('../server/agent.js');
  dt = await import('../server/denah-tools.js');
  mq = await import('../server/modeq.js');
  dt.setRateLimit(1000);
  offices.officeForCwd(path.join(root, 'shop/api'));
  mgr = store.createRole('shop', { name: 'Laras', title: 'Manager', room: 'manager', isMgr: true });
  card = store.createCard('shop', { title: 'Uji', checklist: ['Tulis migrasi database', 'Jalankan tes e2e', 'Update dokumentasi'] }, 'Laras');
});
after(() => { mq.cancelModes(); fs.rmSync(tmp, { recursive: true, force: true }); });

const state = () => store.getCard('shop', card.id).checklist.map(x => x.done);

test('card_check: nomor, id item, teks utuh, potongan teks, dan isi item', async () => {
  const items = store.getCard('shop', card.id).checklist;
  await callText(mgr, 'card_check', { id: card.id, nomor: 1, done: true });
  assert.deepEqual(state(), [true, false, false]);
  await callText(mgr, 'card_check', { id: card.id, item: items[1].id, done: true });
  assert.deepEqual(state(), [true, true, false]);
  await callText(mgr, 'card_check', { id: card.id, item: '3', done: true });
  assert.deepEqual(state(), [true, true, true]);
  await callText(mgr, 'card_check', { id: card.id, text: 'MIGRASI', done: false });
  assert.deepEqual(state(), [false, true, true]);
  await callText(mgr, 'card_check', { id: card.id, text: '2. [x] Jalankan tes e2e', done: false });
  assert.deepEqual(state(), [false, false, true]);
  await callText(mgr, 'card_check', { id: card.id, text: 'item 3', done: false });
  assert.deepEqual(state(), [false, false, false]);
  const out = await callText(mgr, 'card_check', { id: card.id, index: 0, done: true });
  assert.match(out, /^1\. \[x\] Tulis migrasi/m);
});

test('card_check: id kartu longgar, tidak ketemu -> daftar item, ambigu -> kandidat, teks baru -> tambah', async () => {
  await callText(mgr, 'card_check', { id: '#' + card.id.toUpperCase(), nomor: 2, done: true });
  assert.equal(store.getCard('shop', card.id).checklist[1].done, true);
  await callText(mgr, 'card_check', { id: card.id.slice(0, 6), nomor: 2, done: false });
  await fails(mgr, 'card_check', { id: card.id, nomor: 9 }, /tidak ditemukan di kartu[\s\S]*"nomor":1[\s\S]*"teks":"Tulis migrasi[\s\S]*"status"/);
  await fails(mgr, 'card_check', { id: card.id, item: 'zzz', nomor: 7 }, /daftar|nomor/);
  await fails(mgr, 'card_check', { id: card.id, text: 'e' }, /cocok dengan 3 item/);
  await callText(mgr, 'card_check', { id: card.id, text: 'Rilis ke produksi' });
  assert.equal(store.getCard('shop', card.id).checklist.length, 4);
  const empty = store.createCard('shop', { title: 'Kosong' }, 'Laras');
  await fails(mgr, 'card_check', { id: empty.id, nomor: 1 }, /belum punya checklist/);
  await fails(mgr, 'card_check', { id: 'tidak-ada', nomor: 1 }, /Kartu tidak-ada tidak ditemukan/);
  assert.match(await callText(mgr, 'card_get', { id: card.id.toUpperCase() }), /Uji/);
});

test('isi kosong ditolak dengan petunjuk', async () => {
  await fails(mgr, 'announce', { text: '   ' }, /Isi `text` \(isi pengumuman\)/);
  await fails(mgr, 'announce', {}, /Isi `text`/);
  await fails(mgr, 'card_comment', { id: card.id, text: '' }, /Isi `text` \(isi komentar\)/);
  await fails(mgr, 'card_comment', { text: 'x' }, /Isi `id`/);
  await fails(mgr, 'card_create', { title: '' }, /Isi `title`/);
  await fails(mgr, 'note_write', { title: 'x', body: '' }, /Isi `body`/);
  assert.match(await callText(mgr, 'announce', { text: 'halo' }), /ditempel/);
});

test('modeq: mode diantre selama dialog, diterapkan setelah hilang, batal bila habis waktu', async () => {
  const logs = [];
  const sess = { sid: 'sid-q1', office: 'shop', status: 'idle' };
  live.live.set(sess.sid, sess);
  let calls = 0;
  const applied = await new Promise(res => {
    mq.queueMode(sess, 'acceptEdits', { office: 'shop', who: 'Laras', label: 'bayu', pollMs: 5, waitMs: 2000, log: (o, w, t) => logs.push(t), done: ok => res(ok),
      apply: async () => { if (++calls < 3) throw new Error('Sesi ini sedang menampilkan dialog. Jawab dulu'); return { mode: 'acceptEdits' }; } });
    assert.equal(mq.pendingMode(sess.sid), 'acceptEdits');
  });
  assert.equal(applied, true); assert.equal(calls, 3); assert.equal(mq.pendingMode(sess.sid), null);
  assert.match(logs.at(-1), /jadi acceptEdits \(sesuai jadwal\)/);

  const timedOut = await new Promise(res => mq.queueMode(sess, 'plan', { office: 'shop', who: 'Laras', label: 'bayu', pollMs: 5, waitMs: 30, log: (o, w, t) => logs.push(t), done: ok => res(ok), apply: async () => { throw new Error('Sesi ini sedang menampilkan dialog'); } }));
  assert.equal(timedOut, false); assert.match(logs.at(-1), /batal: dialog tidak hilang/);

  const failed = await new Promise(res => mq.queueMode(sess, 'plan', { office: 'shop', who: 'Laras', label: 'bayu', pollMs: 5, log: (o, w, t) => logs.push(t), done: ok => res(ok), apply: async () => { throw new Error('Bypass tidak ada'); } }));
  assert.equal(failed, false); assert.match(logs.at(-1), /gagal: Bypass tidak ada/);
  live.live.delete(sess.sid);
});

test('shift_mode: sesi tanpa tmux tetap error biasa; error dialog dikenali', async () => {
  assert.equal(mq.isDialogError(new Error('Sesi ini sedang menampilkan dialog. Jawab dulu di terminalnya, lalu coba lagi.')), true);
  assert.equal(mq.isDialogError(new Error('lain')), false);
});

test('role_create: ruangan penuh diperbesar otomatis, lobi (tak punya meja) tetap ditolak', async () => {
  const room = () => offices.officeModel('shop').plan.rooms.find(r => r.id === 'manager');
  const w0 = room().w, h0 = room().h;
  let note = '', n = 0;
  for (; n < 30 && !note; n++) {
    const out = await callText(mgr, 'role_create', { nama: `Staf${n}`, jabatan: 'Staf', ruangan: 'manager' });
    if (/otomatis diperbesar|ditempatkan di/.test(out)) note = out;
  }
  assert.ok(note, 'akhirnya ruangan penuh dan ditangani');
  assert.match(note, /meja kosong lagi/);
  assert.ok(room().w > w0 || room().h > h0 || /ditempatkan di/.test(note));
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'lobby' }, /meja kosong[\s\S]*tidak menampung/);
});

test('log harness: gagal menyertakan alasan terpotong tanpa rahasia', () => {
  assert.equal(live.failLine({ tool_name: 'Bash' }), 'gagal: Bash');
  assert.equal(live.failLine({ tool_name: 'mcp__kantor__card_check', error: 'Item checklist tidak ditemukan' }), 'gagal: mcp__kantor__card_check - Item checklist tidak ditemukan');
  const long = live.failLine({ tool_name: 'Bash', error: 'x'.repeat(500) });
  assert.ok(long.length <= 'gagal: Bash - '.length + 160);
  const sec = live.failLine({ tool_name: 'Bash', error: 'curl https://a/b?token=abc123def failed; Authorization: Bearer sk-abcdefghijklmnopqrstuvwx and ' + 'a'.repeat(40) });
  assert.doesNotMatch(sec, /abc123def|sk-abcdef|a{32}/);
  assert.match(sec, /\*\*\*/);
});
