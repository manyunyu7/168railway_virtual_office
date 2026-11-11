// Ruangan di mesin lain dan pemetaan hook sesi remote (docs/MULTI-PC.md). Mesin memakai transport 'local:'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-ruang-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
// "Mac 2": folder yang hanya dikenal lewat mesin 'local:'. Sengaja di dalam roots: kalau cwd remote bocor ke
// officeForCwd, folder ini akan didaftarkan sebagai kantor baru dan tesnya gagal.
const remote = path.join(root, 'mac2');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'shop/api'), { recursive: true });
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.mkdirSync(path.join(remote, 'be/svc/inner'), { recursive: true });
fs.writeFileSync(path.join(remote, 'be/package.json'), JSON.stringify({ dependencies: { next: '1' } }));
fs.writeFileSync(path.join(remote, 'be/svc/go.mod'), 'module svc');
fs.mkdirSync(path.join(remote, 'manual'), { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let mx, offices, live, db, office;
before(async () => {
  mx = await import('../server/machines.js');
  offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  db = await import('../server/db.js');
  mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
  office = offices.officeForCwd(path.join(root, 'shop/api'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const room = (id, rid) => offices.officeModel(id).plan.rooms.find(r => r.id === rid);

test('addRoom remote: folder dicek di mesin itu, stack terdeteksi, path lokal null', () => {
  const rid = offices.addRoom(office, { name: 'Backend', machine: 'mac-dua', remotePath: path.join(remote, 'be') + '/' });
  const r = room(office, rid);
  assert.equal(r.machine, 'mac-dua');
  assert.equal(r.remotePath, path.join(remote, 'be'));
  assert.equal(r.path, null);
  assert.equal(r.stack, 'Next.js');
  const extra = JSON.parse(db.one(db.officeDb(office), "SELECT value FROM meta WHERE key = 'extraRooms'").value);
  assert.deepEqual(Object.keys(extra.find(x => x.id === rid)).sort(), ['id', 'kind', 'machine', 'name', 'path', 'remotePath', 'stack']);
  assert.deepEqual(offices.roomCwd(offices.officeModel(office), r), { machine: 'mac-dua', cwd: path.join(remote, 'be') });
  assert.deepEqual(offices.roomCwd(offices.officeModel(office), rid), { machine: 'mac-dua', cwd: path.join(remote, 'be') });
  // ruangan lokal tetap seperti sebelumnya
  assert.deepEqual(offices.roomCwd(offices.officeModel(office), room(office, 'api')), { machine: 'local', cwd: path.join(root, 'shop/api') });
  assert.deepEqual(offices.roomCwd(offices.officeModel(office), room(office, 'meeting')), { machine: 'local', cwd: path.join(root, 'shop') });
});

test('addRoom remote: input salah ditolak dengan pesan jelas', () => {
  assert.throws(() => offices.addRoom(office, { name: 'X', machine: 'tidak-ada', remotePath: '/tmp' }), /Mesin tidak ditemukan/);
  assert.throws(() => offices.addRoom(office, { name: 'X', machine: 'mac-dua', remotePath: 'relatif/saja' }), /path absolut/);
  assert.throws(() => offices.addRoom(office, { name: 'X', machine: 'mac-dua', remotePath: path.join(remote, 'tidak-ada') }), /tidak ada di mesin Mac Dua/);
  assert.throws(() => offices.addRoom(office, { name: 'X', machine: 'mac-dua', remotePath: path.join(remote, 'be') }), /sudah punya ruangan/);
});

test('mesin offline: addRoom gagal dengan pesan offline, bukan "folder tidak ada"', () => {
  mx.addMachine({ name: 'Mati', ssh: 'nobody@host-yang-tidak-ada.invalid', hubUrl: 'http://hub.local:4317' });
  assert.throws(() => offices.addRoom(office, { name: 'Y', machine: 'mati', remotePath: '/Users/x/repo' }), /Mesin Mati (tidak terjangkau|sedang offline)/);
  assert.ok(mx.isOffline('mati'));
  assert.throws(() => offices.addRoom(office, { name: 'Y', machine: 'mati', remotePath: '/Users/x/repo' }), /Mesin Mati sedang offline/);
  mx.removeMachine('mati');
});

test('roomForRemote: folder terdalam menang, mesin lain dan folder lain tidak cocok', () => {
  const svc = offices.addRoom(office, { name: 'Layanan', machine: 'mac-dua', remotePath: path.join(remote, 'be/svc') });
  assert.equal(room(office, svc).stack, 'Go');
  assert.deepEqual(offices.roomForRemote('mac-dua', path.join(remote, 'be/svc/inner')), { office, room: svc });
  assert.deepEqual(offices.roomForRemote('mac-dua', path.join(remote, 'be/svc')), { office, room: svc });
  assert.deepEqual(offices.roomForRemote('mac-dua', path.join(remote, 'be')), { office, room: 'backend' });
  assert.equal(offices.roomForRemote('mac-dua', path.join(remote, 'be-lain')), null);
  assert.equal(offices.roomForRemote('mac-dua', path.join(remote, 'manual')), null);
  assert.equal(offices.roomForRemote('mesin-lain', path.join(remote, 'be')), null);
  assert.equal(offices.roomForRemote('local', path.join(remote, 'be')), null);
  // cache ikut berubah saat ruangan dihapus
  offices.updateRoom(office, svc, { remove: true });
  assert.deepEqual(offices.roomForRemote('mac-dua', path.join(remote, 'be/svc/inner')), { office, room: 'backend' });
});

test('previewRoom remote dan updateRoom pindah folder', () => {
  const { room: pv } = offices.previewRoom(office, { name: 'Coba', machine: 'mac-dua', remotePath: path.join(remote, 'be/svc') });
  assert.equal(pv.machine, 'mac-dua');
  assert.equal(pv.stack, 'Go');
  assert.equal(pv.path, null);
  const rid = offices.addRoom(office, { name: 'Pindah', machine: 'mac-dua', remotePath: path.join(remote, 'manual') });
  offices.updateRoom(office, rid, { remotePath: path.join(remote, 'be/svc') });
  assert.equal(room(office, rid).remotePath, path.join(remote, 'be/svc'));
  assert.equal(room(office, rid).stack, 'Go');
  assert.throws(() => offices.updateRoom(office, rid, { remotePath: path.join(remote, 'be') }), /sudah punya ruangan/);
  offices.updateRoom(office, rid, { remove: true });
});

test('scanRoot dan roomForCwd tidak menyentuh ruangan remote', () => {
  const m = offices.officeModel(office);
  assert.equal(m.scan.repos.length + m.scan.folders.length, 1, 'hanya folder lokal shop/api');
  // path remote yang kebetulan absolut tidak jatuh ke ruangan remote lewat roomForCwd
  assert.notEqual(offices.roomForCwd(m, path.join(remote, 'be')).room, 'backend');
});

test('sessionFor remote: tidak mendaftarkan kantor baru, ruangan dari roomForRemote, transkrip ke cermin', async () => {
  const before = db.all(db.globalDb(), 'SELECT id FROM offices').length;
  const tr = path.join(remote, '.claude/projects/be/s1.jsonl');
  await live.handleHook({ session_id: 'r-1', hook_event_name: 'SessionStart', source: 'startup', cwd: path.join(remote, 'be'), transcript_path: tr, kantor_machine: 'mac-dua' });
  const s = live.live.get('r-1');
  assert.equal(s.machine, 'mac-dua');
  assert.equal(s.office, office);
  assert.equal(s.room, 'backend');
  assert.equal(s.transcript, mx.mirrorPath('mac-dua', tr));
  assert.equal(db.one(db.globalDb(), 'SELECT machine FROM sessions WHERE sid = ?', 'r-1').machine, 'mac-dua');
  assert.equal(live.serialize(s).machine, 'mac-dua');

  // sesi manual remote yang tidak cocok dengan ruangan mana pun: tanpa kantor, tanpa kantor baru
  assert.ok(offices.officeRootFor(path.join(remote, 'manual')), 'kontrol: lewat jalur lokal folder ini memang akan jadi kantor');
  await live.handleHook({ session_id: 'r-2', hook_event_name: 'SessionStart', source: 'startup', cwd: path.join(remote, 'manual'), transcript_path: path.join(remote, 'x.jsonl'), kantor_machine: 'mac-dua' });
  const s2 = live.live.get('r-2');
  assert.equal(s2.office, null);
  assert.equal(s2.machine, 'mac-dua');
  assert.equal(db.all(db.globalDb(), 'SELECT id FROM offices').length, before);
  assert.equal(offices.officeForCwd(path.join(remote, 'manual'), { create: false }), null);
});

test('shift remote: expectSession, /clear mempertahankan mesin, SubagentStop Codex ke cermin', async () => {
  live.expectSession({ sid: 'r-shift', office, role: null, room: 'backend', cwd: path.join(remote, 'be'), tmux: 'kc-ruang-be', machine: 'mac-dua' });
  // id baru di pane yang sama (KANTOR_SID); hook datang dari token mesin
  await live.handleHook({ session_id: 'r-shift-2', hook_event_name: 'SessionStart', source: 'clear', cwd: path.join(remote, 'be'), kantor_sid: 'r-shift', kantor_machine: 'mac-dua', kantor_engine: 'codex' });
  const s = live.live.get('r-shift-2');
  assert.equal(s.machine, 'mac-dua');
  assert.equal(s.tmux, 'kc-ruang-be');
  assert.equal(s.room, 'backend');
  assert.equal(mx.tmuxMachineOf('kc-ruang-be'), 'mac-dua');
  const rollout = '/Users/x/.codex/sessions/2026/11/11/rollout-2026-11-11T10-00-00-abc.jsonl';
  await live.handleHook({ session_id: 'r-shift-2', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'worker', kantor_machine: 'mac-dua', kantor_engine: 'codex' });
  await live.handleHook({ session_id: 'r-shift-2', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_transcript_path: rollout, last_assistant_message: 'ok', kantor_machine: 'mac-dua', kantor_engine: 'codex' });
  assert.equal(s.subs.get('a1').transcript, mx.mirrorPath('mac-dua', rollout));
});

test('event mesin: sesi milik mesin itu dikabarkan ulang hanya saat status offline berubah', () => {
  const got = [];
  const on = m => { if (m.t === 'session') got.push(m.session); };
  live.bus.on('msg', on);
  mx._setOnlineForTests('mac-dua', true);
  mx.events.emit('machine', mx.publicMachine(mx.getMachine('mac-dua'))); // mis. hasil Tes/Pasang: status sama
  const quiet = got.length;
  mx._setOnlineForTests('mac-dua', false);
  live.bus.off('msg', on);
  const after = got.slice(quiet);
  assert.ok(after.some(s => s.sid === 'r-1' && s.machineOffline));
  assert.ok(after.some(s => s.sid === 'r-shift-2' && s.machineOffline));
  mx._setOnlineForTests('mac-dua', true);
});

test('sesi lokal tidak berubah: tanpa kantor_machine tetap lewat officeForCwd/roomForCwd', async () => {
  await live.handleHook({ session_id: 'l-1', hook_event_name: 'SessionStart', source: 'startup', cwd: path.join(root, 'shop/api'), transcript_path: '/tmp/l1.jsonl' });
  const s = live.live.get('l-1');
  assert.equal(s.machine, null);
  assert.equal(s.office, office);
  assert.equal(s.room, 'api');
  assert.equal(s.transcript, '/tmp/l1.jsonl');
});
