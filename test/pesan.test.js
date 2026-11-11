// Pesan antaragen ke sesi di Mac lain (docs/MULTI-PC.md): mesin offline menahan pesan, event online mengirimnya,
// pengirim diberi tahu, dan teks ke satu sesi diketik bergiliran. Mesin remote memakai transport 'local:'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-pesan-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const remoteRepo = path.join(tmp, 'mac2', 'api'); // "folder di Mac 2" (transport local: menjalankan perintah di sini)
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'toko/web'), { recursive: true });
fs.mkdirSync(remoteRepo, { recursive: true });
fs.writeFileSync(path.join(root, 'toko/web/package.json'), '{"name":"web"}');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', dm: { maxPerPair: 50, autoStart: true } }));

let live, store, dm, ag, mx, offices, tunggu, fe, be, ops, studio, remoteRoom;
const typed = [], starts = [];
const ident = r => ({ office: 'toko', role: r, by: r.name });
const call = async (r, tool, a) => JSON.parse((await ag.callTool(ident(r), tool, a)).content[0].text);
const wait = ms => new Promise(r => setTimeout(r, ms));
const goOffline = () => { assert.throws(() => mx.shSync(studio, 'exit 255')); assert.ok(mx.isOffline(studio)); };
const goOnline = () => { mx.shSync(studio, 'true'); assert.ok(!mx.isOffline(studio)); };
const session = (sid, role, { machine = null, status = 'idle' } = {}) => {
  const s = live.expectSession({ sid, office: 'toko', role: role.id, room: role.room, cwd: machine ? remoteRepo : path.join(root, 'toko/web'), tmux: 'kc-pesan-' + sid, slot: 0, title: 't', machine });
  s.status = status;
  return s;
};

before(async () => {
  offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  mx = await import('../server/machines.js');
  dm = await import('../server/dm.js');
  ag = await import('../server/agent.js');
  tunggu = await import('../server/tunggu.js');
  offices.officeForCwd(path.join(root, 'toko/web'));
  studio = mx.addMachine({ name: 'Mac Studio', ssh: 'local:', hubUrl: 'http://hub.test:4317' }).id;
  mx.shSync(studio, 'true');
  remoteRoom = offices.addRoom('toko', { name: 'API', kind: 'kode', machine: studio, remotePath: remoteRepo });
  const roomId = remoteRoom?.id || remoteRoom?.room?.id || offices.officeModel('toko').plan.rooms.find(r => r.machine === studio)?.id;
  assert.ok(roomId, 'ruangan di Mac Studio terbuat');
  fe = store.createRole('toko', { name: 'Fajar', title: 'FE', room: 'web' });
  be = store.createRole('toko', { name: 'Bela', title: 'BE', room: roomId });
  ops = store.createRole('toko', { name: 'Oki', title: 'Ops', room: roomId });
  dm.setSender(async (sid, text) => { typed.push({ sid, text, at: Date.now() }); });
  dm.setStarter((office, role, opts) => { starts.push({ office, role, task: opts.task }); return { sid: 'auto-' + role, tmux: 'kc-auto-' + role, slot: 0 }; });
  dm.setSettle(() => 0);
  dm.setAdoptWait(20);
  tunggu.setSender(async (sid, text) => { typed.push({ sid, text, at: Date.now(), by: 'tunggu' }); });
  dm.startDm();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('pesan: penerima di mesin offline ditahan, pengirim diberi tahu, lalu terkirim setelah online', async () => {
  typed.length = 0;
  assert.equal(dm.roleMachine('toko', be.id), studio);
  assert.equal(dm.roleMachine('toko', fe.id), null);
  session('s-be', be, { machine: studio });
  goOffline();
  const out = await call(fe, 'pesan_ke', { ke: 'Bela', teks: 'Endpoint /orders butuh field total' });
  assert.equal(out.status, 'menunggu');
  assert.match(out.pengiriman, /Bela ada di Mac Studio yang sedang offline; pesan disimpan dan dikirim saat tersambung lagi\./);
  assert.equal(typed.length, 0, 'tidak mengetik ke mesin offline');
  assert.equal(await dm.deliver('toko', be.id), 0, 'deliver berkala juga menahan');
  // pesan kedua ikut tertahan, lalu keduanya masuk bersama
  await call(fe, 'pesan_ke', { ke: 'Bela', teks: 'Sekalian tambah field ongkir' });
  goOnline(); // events 'machine' online → flushMachine setelah jeda adopsi
  await wait(120);
  const got = typed.filter(t => t.sid === 's-be');
  assert.equal(got.length, 1, 'dua pesan diketik sekali, bersama');
  assert.match(got[0].text, /2 pesan masuk/);
  assert.match(got[0].text, /field total/);
  assert.match(got[0].text, /ongkir/);
  assert.ok(dm.thread('toko', fe.id, be.id).items.every(i => i.status === 'terkirim'));
});

test('pesan: sesi lokal tidak berubah (diketik langsung)', async () => {
  typed.length = 0;
  session('s-fe', fe);
  const out = await call(be, 'pesan_ke', { ke: 'Fajar', teks: 'Field total sudah ada' });
  assert.equal(out.status, 'terkirim');
  assert.equal(out.pengiriman, 'sudah diketik ke sesi penerima');
  assert.equal(typed.length, 1);
});

test('pesan: autoStart untuk role yang ruangannya di mesin offline diantrekan, lalu dimulai saat online', async () => {
  typed.length = 0; starts.length = 0;
  goOffline();
  const out = await call(fe, 'pesan_ke', { ke: 'Oki', teks: 'Tolong cek log server staging' });
  assert.equal(out.status, 'menunggu');
  assert.match(out.pengiriman, /Oki ada di Mac Studio yang sedang offline; pesan disimpan dan dikirim saat tersambung lagi\./);
  assert.match(out.pengiriman, /dimulai otomatis/);
  assert.equal(starts.length, 0, 'shift tidak dicoba di mesin offline');
  // fyi juga menyebut mesinnya, tapi tidak memulai shift
  const fyi = await call(fe, 'kabari', { ke: 'Oki', teks: 'staging dipakai demo jam 3' });
  assert.match(fyi.pengiriman, /Mac Studio yang sedang offline/);
  goOnline();
  await wait(120);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].role, ops.id);
  assert.match(starts[0].task, /cek log server staging/);
  assert.match(starts[0].task, /staging dipakai demo/, 'fyi yang menunggu ikut jadi tugas pertama');
  assert.ok(dm.thread('toko', fe.id, ops.id).items.every(i => i.status === 'terkirim'));
});

test('pesan: tanya ke mesin offline langsung kembali dengan keterangan, balasan nanti jadi pesan', async () => {
  typed.length = 0;
  goOffline();
  const t0 = Date.now();
  const got = await call(fe, 'tanya', { ke: 'Bela', teks: 'Sudah deploy?', timeout_detik: 60 });
  assert.ok(Date.now() - t0 < 2000, 'tidak menunggu sampai timeout');
  assert.equal(got.status, 'belum dibalas');
  assert.match(got.pengiriman, /Mac Studio yang sedang offline/);
  goOnline();
  await wait(120);
  assert.ok(typed.some(t => t.sid === 's-be' && /Sudah deploy\?/.test(t.text)));
  const r = await call(be, 'balas', { id: got.id, teks: 'Sudah' });
  assert.equal(r.status, 'terkirim', 'balasan diketik ke penanya (lokal)');
});

test('pesan: siaran memberi catatan per penerima yang offline', async () => {
  goOffline();
  const out = await call(fe, 'siaran', { ke: ['Bela', 'Oki'], teks: 'Rilis ditunda besok' });
  assert.equal(out.terkirim.length, 2);
  for (const t of out.terkirim) assert.match(t.catatan, /Mac Studio yang sedang offline/);
  goOnline();
  await wait(120);
});

test('pesan: teks ke satu sesi remote diketik bergiliran, tidak saling menimpa', async () => {
  dm.setSettle(() => 60);
  const log = [];
  const send = async (sid, text) => { log.push(['mulai', text, Date.now()]); await wait(30); log.push(['selesai', text, Date.now()]); };
  await Promise.all([dm.typeSerial('s-be', 'satu', send), dm.typeSerial('s-be', 'dua', send), dm.typeSerial('s-be', 'tiga', send)]);
  assert.deepEqual(log.map(l => l[0] + ':' + l[1]), ['mulai:satu', 'selesai:satu', 'mulai:dua', 'selesai:dua', 'mulai:tiga', 'selesai:tiga']);
  assert.ok(log[2][2] - log[1][2] >= 55, 'teks berikutnya menunggu Enter teks sebelumnya');
  // mesin offline di tengah antrean: sisa teks gagal cepat (pemanggil menahannya), tidak macet di ssh
  goOffline();
  await assert.rejects(() => dm.typeSerial('s-be', 'empat', send), /offline/);
  goOnline();
  dm.setSettle(() => 0);
});

test('pesan: tunggu_kerja tidak membangunkan sesi di mesin offline, lalu bangun setelah online', async () => {
  typed.length = 0;
  const s = live.live.get('s-be');
  s.status = 'idle';
  await tunggu.daftar(s, { maks_menit: 1 });
  tunggu.waitOf('s-be').armed = true;
  goOffline();
  const later = Date.now() + 2 * 60e3;
  assert.deepEqual(await tunggu.tick(later), []);
  assert.ok(tunggu.waitOf('s-be'), 'tunggu tetap ada');
  goOnline();
  assert.deepEqual(await tunggu.tick(later), ['s-be']);
  assert.match(typed.find(t => t.by === 'tunggu').text, /waktu tunggu habis/);
});

test('rapat: peserta dengan ruangan di mesin lain jalan di root kantor hub, dengan keterangan', async () => {
  const { meetingCwd } = await import('../server/meetings.js');
  const m = offices.officeModel('toko');
  const local = meetingCwd(m, store.getRole('toko', fe.id));
  assert.equal(local.cwd, path.join(root, 'toko/web'));
  assert.equal(local.remote, '');
  const far = meetingCwd(m, store.getRole('toko', be.id));
  assert.equal(far.cwd, m.root, 'path remote tidak dipakai sebagai folder di hub');
  assert.match(far.remote, /Repo ruanganmu ada di mesin Mac Studio/);
  assert.match(far.remote, /tidak menjangkau repo itu/);
});
