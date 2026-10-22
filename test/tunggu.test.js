import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tunggu-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'shop/api'), { recursive: true });
fs.mkdirSync(path.join(root, 'shop/web'), { recursive: true });
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.writeFileSync(path.join(root, 'shop/web/package.json'), '{}');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));
const git = (...a) => execFileSync('git', ['-C', path.join(root, 'shop/api'), '-c', 'user.name=T', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'awal');

let live, store, tg, ap, bg, db, dm, ag, bayu, sinta, mgr;
const typed = [];
const ident = (r, sid) => ({ office: 'shop', role: r, by: r.name, sid });
const call = async (r, sid, tool, a) => (await ag.callTool(ident(r, sid), tool, a)).content.map(c => c.text).join('\n');
const session = (sid, role, status = 'idle', room = 'api') => {
  const s = live.expectSession({ sid, office: 'shop', role: role.id, room, cwd: path.join(root, 'shop/api'), tmux: 'kc-test-' + sid, slot: 0, title: 't' });
  s.status = status; s.lastSeen = new Date(Date.now() - 3600e3).toISOString();
  return s;
};
const last = sid => typed.filter(t => t.sid === sid).at(-1)?.text;
const idle = s => { s.status = 'idle'; live.bus.emit('msg', { t: 'session', office: 'shop', session: live.serialize(s) }); };
const clearSessions = () => { for (const k of [...live.live.keys()]) live.live.delete(k); };
const later = (ms = 2000) => Date.now() + ms;

before(async () => {
  const offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  db = await import('../server/db.js');
  dm = await import('../server/dm.js');
  ag = await import('../server/agent.js');
  tg = await import('../server/tunggu.js');
  ap = await import('../server/autopilot.js');
  bg = await import('../server/budget.js');
  offices.officeForCwd(path.join(root, 'shop/api'));
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Laravel Dev', room: 'api' });
  sinta = store.createRole('shop', { name: 'Sinta', title: 'QA', room: 'api', engine: 'codex' });
  mgr = store.createRole('shop', { name: 'Laras', title: 'Manager', room: 'api', isMgr: true });
  const send = async (sid, text) => { typed.push({ sid, text }); };
  dm.setSender(send); tg.setSender(send); ap.setSender(send); bg.setSender(send);
  dm.startDm();
  tg.startTunggu();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tunggu_kerja: input salah ditolak dengan petunjuk', async () => {
  const s = session('s-bad', bayu);
  await assert.rejects(() => call(bayu, 's-bad', 'tunggu_kerja', {}), /apa yang kamu tunggu/);
  await assert.rejects(() => call(bayu, 's-bad', 'tunggu_kerja', { kejadian: ['ngopi'] }), /tidak dikenal/);
  await assert.rejects(() => call(bayu, 's-bad', 'tunggu_kerja', { sampai: 'kemarin' }), /waktu ISO/);
  await assert.rejects(() => call(bayu, 's-bad', 'tunggu_kerja', { sampai: '2020-01-01T00:00:00Z' }), /sudah lewat/);
  s.tmux = null;
  await assert.rejects(() => call(bayu, 's-bad', 'tunggu_kerja', { maks_menit: 5 }), /bukan tmux|tidak jalan di tmux/);
});

test('tunggu_kerja: kartu_untukku membangunkan sesi yang idle dengan satu prompt, tanpa turn di antaranya', async () => {
  typed.length = 0;
  const s = session('s-bayu', bayu, 'working');
  const out = await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_untukku'], maks_menit: 30 });
  assert.match(out, /AKHIRI GILIRANMU/);
  assert.equal(s.tunggu.label, 'menunggu: kartu_untukku');
  assert.ok(tg.waitOf('s-bayu'));
  // a card for somebody else, and one Bayu made himself: nothing
  store.createCard('shop', { title: 'Untuk Sinta', who: sinta.id, col: 'Siap' }, 'Laras');
  store.createCard('shop', { title: 'Buatan sendiri', who: bayu.id }, 'Bayu');
  // the card for Bayu arrives while he is still finishing his turn: noted, but no prompt yet
  const c = store.createCard('shop', { title: 'Endpoint pesanan', who: bayu.id, col: 'Siap', prio: 'P1' }, 'Laras');
  assert.deepEqual(await tg.tick(later()), [], 'masih bekerja');
  assert.equal(typed.length, 0);
  idle(s);
  assert.deepEqual(await tg.tick(later()), ['s-bayu']);
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, new RegExp(`^\\[Kantor · bangun dari tunggu\\] kartu untukmu ${c.id} "Endpoint pesanan" \\(P1, Siap\\)`));
  assert.equal(s.tunggu, null);
  assert.equal(tg.waitOf('s-bayu'), null);
  // the wake prompt itself does not count as something that cancels a wait registered later
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_untukku'] });
  live.bus.emit('prompt', { sid: 's-bayu', office: 'shop', prompt: typed[0].text });
  assert.ok(tg.waitOf('s-bayu'), 'belum idle sejak daftar: prompt itu bukan pembangun');
});

test('tunggu_kerja: kartu yang dipindah ke Siap atau ditugaskan ulang ke aku juga dihitung', async () => {
  typed.length = 0;
  const s = live.live.get('s-bayu');
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_untukku'] });
  idle(s);
  const c = store.createCard('shop', { title: 'Belum siap', who: sinta.id }, 'Laras');
  await tg.tick(later());
  assert.equal(typed.length, 0);
  store.updateCard('shop', c.id, { who: bayu.id, whoName: 'Bayu', col: 'Siap' }, 'Laras');
  assert.deepEqual(await tg.tick(later()), ['s-bayu']);
  assert.match(typed[0].text, /kartu untukmu .* "Belum siap"/);
});

test('tunggu_kerja: kartu_masuk (tanpa pemilik), review_diminta, dan beberapa kejadian digabung jadi satu prompt', async () => {
  typed.length = 0;
  const s = live.live.get('s-bayu');
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_masuk', 'review_diminta'] });
  idle(s);
  store.createCard('shop', { title: 'Bug login', col: 'Backlog' }, 'Laras');
  store.createCard('shop', { title: 'Punya Sinta', who: sinta.id, col: 'Backlog' }, 'Laras');
  const r = store.createCard('shop', { title: 'Siap diperiksa', who: sinta.id, col: 'Dikerjakan' }, 'Laras');
  store.updateCard('shop', r.id, { col: 'Review' }, 'Sinta');
  assert.deepEqual(await tg.tick(later()), ['s-bayu']);
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /kartu masuk .* "Bug login" \(P2, Backlog, tanpa pemilik\); review diminta .* "Siap diperiksa" \(milik Sinta\)/);
  assert.doesNotMatch(typed[0].text, /Punya Sinta/);
});

test('tunggu_kerja: waktu habis membangunkan dengan "waktu tunggu habis"', async () => {
  typed.length = 0;
  const s = live.live.get('s-bayu');
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['commit_baru'], maks_menit: 1 });
  idle(s);
  assert.deepEqual(await tg.tick(Date.now() + 30e3), [], 'belum');
  assert.deepEqual(await tg.tick(Date.now() + 61e3), ['s-bayu']);
  assert.match(typed[0].text, /^\[Kantor · waktu tunggu habis\]/);
  // "sampai" caps maks_menit
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_masuk'], maks_menit: 600, sampai: new Date(Date.now() + 120e3).toISOString() });
  assert.ok(tg.waitOf('s-bayu').until - Date.now() <= 121e3);
  // no event and no time given beyond "sampai": a plain alarm
  tg.waitOf('s-bayu').armed = true;
  assert.deepEqual(await tg.tick(Date.now() + 121e3), ['s-bayu']);
});

test('tunggu_kerja: pesan langsung mengakhiri tunggu, teksnya diketik dm.js (bukan prompt kedua)', async () => {
  typed.length = 0;
  const s = live.live.get('s-bayu');
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['pesan'] });
  idle(s);
  session('s-laras', mgr);
  await call(mgr, 's-laras', 'pesan_ke', { ke: 'bayu', teks: 'Cek deploy ya' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(typed.filter(t => t.sid === 's-bayu').length, 1);
  assert.match(last('s-bayu'), /^\[Pesan dari Laras/);
  live.bus.emit('prompt', { sid: 's-bayu', office: 'shop', prompt: last('s-bayu') });
  assert.equal(tg.waitOf('s-bayu'), null, 'prompt masuk ke sesi yang menunggu = sudah bangun');
  await tg.tick(later());
  assert.equal(typed.filter(t => t.sid === 's-bayu').length, 1, 'tidak ada prompt bangun tambahan');
});

test('tunggu_kerja: prompt dari pemilik membatalkan tunggu; sesi yang berakhir dibuang', async () => {
  const s = live.live.get('s-bayu');
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_masuk'] });
  live.bus.emit('prompt', { sid: 's-bayu', office: 'shop', prompt: 'ada kerjaan' });
  assert.ok(tg.waitOf('s-bayu'), 'sesi belum pernah idle sejak daftar, jadi masih akhir giliran yang sama');
  idle(s);
  live.bus.emit('prompt', { sid: 's-bayu', office: 'shop', prompt: 'ada kerjaan' });
  assert.equal(tg.waitOf('s-bayu'), null);
  s.status = 'working';
  await call(bayu, 's-bayu', 'tunggu_kerja', { kejadian: ['kartu_masuk'] });
  live.bus.emit('msg', { t: 'session-gone', office: 'shop', sid: 's-bayu' });
  assert.equal(tg.waitOf('s-bayu'), null);
});

test('tunggu_kerja: commit_baru memantau HEAD ruangan dan membangunkan saat berubah', async () => {
  typed.length = 0;
  const s = session('s-bayu2', bayu, 'working');
  await assert.rejects(() => call(bayu, 's-bayu2', 'tunggu_kerja', { kejadian: ['commit_baru'], repo: ['web'] }), /repo git/);
  await assert.rejects(() => call(bayu, 's-bayu2', 'tunggu_kerja', { kejadian: ['commit_baru'], repo: ['xx'] }), /tidak ada/);
  await call(bayu, 's-bayu2', 'tunggu_kerja', { kejadian: ['commit_baru'] });
  idle(s);
  await tg.pollCommits();
  assert.deepEqual(await tg.tick(later()), []);
  fs.writeFileSync(path.join(root, 'shop/api/main.go'), 'package main');
  git('add', '.'); git('commit', '-q', '-m', 'tambah main');
  await tg.pollCommits();
  assert.deepEqual(await tg.tick(later()), ['s-bayu2']);
  assert.match(typed[0].text, /commit baru di api: [0-9a-f]{7} "tambah main" oleh T/);
});

test('tunggu_kerja: tunggu sampai anggaran dibuka lagi, dan sesi yang dibangunkan tidak diganggu bila anggarannya habis', async () => {
  typed.length = 0;
  const s = session('s-bayu3', bayu, 'working');
  store.updateRole('shop', bayu.id, { budget: 1 });
  const today = new Date(); const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  db.run(db.globalDb(), "INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cost) VALUES ('s-bayu3', 'shop', ?, 'claude-sonnet-5-5', ?, 3, 100, 100, 2.5)", bayu.id, day);
  await bg.check('shop');
  typed.length = 0;
  await call(bayu, 's-bayu3', 'tunggu_kerja', { kejadian: ['kartu_masuk'] });
  idle(s);
  store.createCard('shop', { title: 'Tidak boleh membangunkan', col: 'Siap' }, 'Laras');
  assert.deepEqual(await tg.tick(later()), [], 'anggaran habis: tidak dibangunkan');
  store.updateRole('shop', bayu.id, { budget: 100 });
  await bg.check('shop');
  assert.deepEqual(await tg.tick(later()), ['s-bayu3']);
  store.updateRole('shop', bayu.id, { budget: null });
  await bg.check('shop');
});

test('autopilot pullWork: tawarkan kartu cocok ke sesi idle, dengan log, jeda, dan batas', async () => {
  typed.length = 0;
  clearSessions();
  for (const c of store.listCards('shop')) store.archiveCard('shop', c.id, 'tes');
  const s = session('s-bayu4', bayu);
  assert.deepEqual(await ap.pullWorkTick('shop'), [], 'pullWork mati secara bawaan');
  assert.equal(ap.getConf('shop').pullWork, false);
  ap.setConf('shop', { pullWork: true, idleMinutes: 3 });
  const own = store.createCard('shop', { title: 'Punya Bayu', who: bayu.id, col: 'Backlog', prio: 'P2' }, 'Laras');
  const room = store.createCard('shop', { title: 'Satu ruangan', repo: 'api', col: 'Siap', prio: 'P3' }, 'Laras');
  store.createCard('shop', { title: 'Ruangan lain', repo: 'web', col: 'Siap', prio: 'P0' }, 'Laras');
  store.createCard('shop', { title: 'Terblokir', who: bayu.id, col: 'Siap', blocked: 'tunggu klien' }, 'Laras');
  store.createCard('shop', { title: 'Menunggu klien', who: bayu.id, col: 'Siap', labels: ['Menunggu klien'] }, 'Laras');
  const dep = store.createCard('shop', { title: 'Prasyarat', who: sinta.id, col: 'Dikerjakan' }, 'Laras');
  store.createCard('shop', { title: 'Punya syarat', who: bayu.id, col: 'Siap', deps: [dep.id] }, 'Laras');
  store.createCard('shop', { title: 'Punya Sinta', who: sinta.id, col: 'Siap' }, 'Laras');
  assert.deepEqual(ap.candidates('shop', bayu).map(c => c.id), [own.id, room.id], 'milik sendiri dulu, lalu yang cocok ruangan');
  s.lastSeen = new Date().toISOString();
  assert.deepEqual(await ap.pullWorkTick('shop'), [], 'baru saja idle');
  s.lastSeen = new Date(Date.now() - 10 * 60e3).toISOString();
  s.status = 'working';
  assert.deepEqual(await ap.pullWorkTick('shop'), [], 'sedang bekerja');
  s.status = 'idle';
  assert.deepEqual(await ap.pullWorkTick('shop'), [{ role: bayu.id, card: own.id }]);
  assert.match(typed[0].text, new RegExp(`^\\[Kantor · tawaran kerja\\] .* ${own.id} "Punya Bayu" \\(P2, Backlog, ditugaskan padamu\\).*card_update\\(id="${own.id}", col="Dikerjakan", who="${bayu.id}"\\)`));
  assert.ok(ap.autopilotLog('shop').some(l => /ditawari kartu .* \(pullWork\)/.test(l.text)));
  // the same card is not offered again; the next one is
  assert.deepEqual(await ap.pullWorkTick('shop'), [{ role: bayu.id, card: room.id }]);
  assert.deepEqual(await ap.pullWorkTick('shop'), [], 'tidak ada lagi yang cocok');
  // someone already working on a card gets no offer
  store.updateCard('shop', own.id, { col: 'Dikerjakan' }, 'Bayu');
  assert.deepEqual(await ap.pullWorkTick('shop', Date.now() + 2 * 3600e3), []);
});

test('autopilot: konfigurasi per kantor dinormalkan dan disimpan', () => {
  const c = ap.setConf('shop', { idleMinutes: 'x', maxPerHour: 9999, managerRound: { enabled: true, staleMinutes: 1 } });
  assert.equal(c.pullWork, true);
  assert.equal(c.idleMinutes, 3);
  assert.equal(c.maxPerHour, 60);
  assert.deepEqual(c.managerRound, { enabled: true, staleMinutes: 5, cooldownMinutes: 30 });
  assert.equal(ap.getConf('shop').managerRound.enabled, true);
  assert.equal(ap.setConf('shop', { pullWork: false }).pullWork, false);
});

test('autopilot ronde manager: hanya jika ada kartu Siap/Review yang tidak bergerak', async () => {
  typed.length = 0;
  clearSessions();
  session('s-laras2', mgr);
  ap.setConf('shop', { managerRound: { enabled: true, staleMinutes: 45, cooldownMinutes: 30 } });
  const now = Date.now();
  assert.equal(await ap.managerRoundTick('shop', now), null, 'semua kartu baru bergerak');
  assert.equal(typed.length, 0);
  assert.equal(await ap.managerRoundTick('shop', now + 50 * 60e3) !== null, true);
  assert.match(typed[0].text, /^\[Kantor · ronde manager\] \d+ kartu Siap\/Review tidak bergerak lebih dari 45 menit/);
  assert.equal(await ap.managerRoundTick('shop', now + 60 * 60e3), null, 'jeda 30 menit');
});

test('anggaran: 80% mengingatkan di hasil tool, 100% mengirim pesan berhenti, menandai role, dan memberi tahu Ghina sekali', async () => {
  typed.length = 0;
  clearSessions();
  const pushed = [];
  live.bus.on('notify', e => { if (e.kind === 'budget') pushed.push(e); });
  const s = session('s-bayu5', bayu);
  const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const put = cost => db.run(db.globalDb(), "INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cost) VALUES ('s-bayu5', 'shop', ?, 'claude-sonnet-5-5', ?, 1, 10, 10, ?) ON CONFLICT(sid, model, day) DO UPDATE SET cost = excluded.cost", bayu.id, day, cost);
  db.run(db.globalDb(), 'DELETE FROM usage');
  store.updateRole('shop', bayu.id, { budget: '10' });
  assert.equal(store.getRole('shop', bayu.id).budget, 10);
  put(5);
  assert.deepEqual(await bg.check('shop'), []);
  assert.doesNotMatch(await call(bayu, 's-bayu5', 'roles_list', {}), /anggaran/);
  put(8.2);
  assert.deepEqual(await bg.check('shop'), [{ role: bayu.id, level: 'peringatan' }]);
  assert.equal(s.anggaran, 'peringatan');
  assert.match(await call(bayu, 's-bayu5', 'roles_list', {}), /\[Kantor · anggaran 82%\] Anggaran harianmu terpakai USD 8,20 dari USD 10,00/);
  assert.equal(typed.length, 0, 'di 80% hanya pengingat, tidak ada pesan diketik');
  assert.deepEqual(await bg.check('shop'), [], 'sekali saja');
  put(10.5);
  assert.deepEqual(await bg.check('shop'), [{ role: bayu.id, level: 'habis' }]);
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /^\[Kantor · anggaran habis\] Anggaran harianmu habis \(USD 10,50 dari USD 10,00\)\. Simpan pekerjaanmu sekarang.*berhenti/);
  assert.equal(s.anggaran, 'habis');
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].text, /habis/);
  assert.deepEqual(await bg.check('shop'), [], 'masih habis, tetapi pesan tidak diulang');
  assert.equal(typed.length, 1);
  assert.equal(pushed.length, 1);
  assert.match(await call(bayu, 's-bayu5', 'roles_list', {}), /anggaran habis/);
  assert.equal(bg.overview('shop').find(x => x.role === bayu.id).level, 'habis');
  // a shift started afterwards, same day, is told too
  const s2 = session('s-bayu6', bayu);
  await bg.check('shop');
  assert.equal(last('s-bayu6') && /anggaran habis/.test(last('s-bayu6')), true);
  assert.equal(s2.anggaran, 'habis');
  // raising the limit reopens it
  store.updateRole('shop', bayu.id, { budget: 100 });
  await bg.check('shop');
  assert.equal(s.anggaran, null);
  assert.equal(pushed.length, 1);
});

test('anggaran: role Codex dihitung dengan token, bukan dolar', async () => {
  typed.length = 0;
  clearSessions();
  db.run(db.globalDb(), 'DELETE FROM usage');
  const s = session('s-sinta', sinta);
  const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  db.run(db.globalDb(), "INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cost) VALUES ('s-sinta', 'shop', ?, 'gpt-5.5', ?, 4, 900000, 150000, 0)", sinta.id, day);
  store.updateRole('shop', sinta.id, { budget: 1000000 });
  const st = bg.overview('shop').find(x => x.role === sinta.id);
  assert.equal(st.unit, 'token');
  assert.equal(st.percent, 105);
  assert.deepEqual(await bg.check('shop'), [{ role: sinta.id, level: 'habis' }]);
  assert.match(typed[0].text, /habis \(1,05 jt token dari 1 jt token\)/);
  assert.equal(s.anggaran, 'habis');
  store.updateRole('shop', sinta.id, { budget: 0 });
  assert.equal(store.getRole('shop', sinta.id).budget, null, '0 = tanpa batas');
  await bg.check('shop');
  assert.equal(s.anggaran, null);
});

test('anggaran: period shift menghitung dari sesi yang sedang jalan', async () => {
  db.run(db.globalDb(), 'DELETE FROM usage');
  ap.setConf('shop', { budgetPeriod: 'shift' });
  const s = session('s-bayu7', bayu);
  s.status = 'idle';
  const old = new Date(Date.now() - 86400e3 * 2); const d = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
  db.run(db.globalDb(), "INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cost) VALUES ('s-bayu7', 'shop', ?, 'claude-sonnet-5-5', ?, 1, 1, 1, 7)", bayu.id, d);
  store.updateRole('shop', bayu.id, { budget: 10 });
  const x = bg.overview('shop').find(r => r.role === bayu.id);
  assert.equal(x.period, 'shift');
  assert.equal(x.used, 7, 'shift mencakup pemakaian sesi walau harinya lain');
  ap.setConf('shop', { budgetPeriod: 'hari' });
  assert.equal(bg.overview('shop').find(r => r.role === bayu.id).used, 0);
  store.updateRole('shop', bayu.id, { budget: null });
});
