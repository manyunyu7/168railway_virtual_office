import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.KANTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ma-'));
const mx = await import('../server/machines.js');
const api = await import('../server/machines-api.js');
const { live, bus } = await import('../server/live.js');
const { registerOffice } = await import('../server/offices.js');
const { officeDb, run } = await import('../server/db.js');

// router palsu: rute yang didaftarkan machineRoutes, dipanggil seperti index.js memanggilnya
const routes = {};
api.machineRoutes((method, pattern, fn) => { routes[`${method} ${pattern}`] = fn; }, async req => req.b || {});
const call = (sig, params = {}, b = {}, query = '') => routes[sig]({ b }, null, params, new URLSearchParams(query));

const servers = [];
function hub(status) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => { res.writeHead(status); res.end(); }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}
after(() => { for (const s of servers) s.close(); });

test('rute terdaftar sesuai kontrak', () => {
  for (const r of ['GET /api/machines', 'POST /api/machines', 'PATCH /api/machines/:id', 'DELETE /api/machines/:id', 'POST /api/machines/:id/test', 'POST /api/machines/:id/install', 'GET /api/machines/:id/browse'])
    assert.equal(typeof routes[r], 'function', r);
});

test('CRUD: token tidak pernah ikut jawaban', async () => {
  const events = [];
  const on = m => { if (m.t === 'machine') events.push(m); };
  bus.on('msg', on);
  const { machine } = await call('POST /api/machines', {}, { name: 'Mac Studio', ssh: 'local:', hubUrl: 'http://hub.test:4317/' });
  assert.equal(machine.id, 'mac-studio');
  const tok = mx.getMachine('mac-studio').token;
  assert.ok(tok.startsWith('kcmesin_'));
  const list = await call('GET /api/machines');
  assert.equal(list.machines.length, 1);
  assert.ok(!JSON.stringify(list).includes(tok), 'token bocor di GET');
  assert.ok(!JSON.stringify(machine).includes(tok), 'token bocor di POST');

  const r = await call('PATCH /api/machines/:id', { id: 'mac-studio' }, { name: 'Studio', rotateToken: true, disabled: true });
  const tok2 = mx.getMachine('mac-studio').token;
  assert.notEqual(tok2, tok);
  assert.ok(tok2.startsWith('kcmesin_'), 'rotateToken memakai awalan baru');
  assert.equal(r.machine.name, 'Studio');
  assert.equal(r.machine.disabled, true);
  assert.ok(!JSON.stringify(r).includes(tok2), 'token bocor di PATCH');
  await call('PATCH /api/machines/:id', { id: 'mac-studio' }, { disabled: false });
  assert.ok(events.length >= 3 && events.every(e => !JSON.stringify(e).includes(tok2)), 'event machine tanpa token');
  bus.off('msg', on);

  await assert.rejects(async () => call('PATCH /api/machines/:id', { id: 'tidak-ada' }, { name: 'x' }), e => e.code === 404);
  await assert.rejects(async () => call('POST /api/machines', {}, { name: 'x', ssh: 'local:', hubUrl: 'http://a', root: 'relatif/x' }), /absolut/);
});

test('DELETE ditolak selama ada sesi hidup atau ruangan di mesin itu', async () => {
  await call('POST /api/machines', {}, { name: 'Hapus Saya', ssh: 'local:', hubUrl: 'http://hub.test:4317' });
  live.set('sid-remote', { sid: 'sid-remote', machine: 'hapus-saya', status: 'working' });
  await assert.rejects(async () => call('DELETE /api/machines/:id', { id: 'hapus-saya' }), e => e.code === 409 && /sesi hidup/.test(e.message));
  live.get('sid-remote').status = 'ended';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ma-office-'));
  const oid = registerOffice(root);
  run(officeDb(oid), "INSERT INTO meta (key, value) VALUES ('extraRooms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify([{ id: 'be', name: 'Backend', kind: 'kode', path: null, machine: 'hapus-saya', remotePath: '/Users/x/be' }]));
  await assert.rejects(async () => call('DELETE /api/machines/:id', { id: 'hapus-saya' }), e => e.code === 409 && /Backend/.test(e.message));
  run(officeDb(oid), "UPDATE meta SET value = '[]' WHERE key = 'extraRooms'");

  assert.deepEqual(await call('DELETE /api/machines/:id', { id: 'hapus-saya' }), { ok: true });
  assert.equal(mx.getMachine('hapus-saya'), null);
  live.delete('sid-remote');
});

test('browse: folder saja, tandai git, validasi path', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ma-br-'));
  fs.mkdirSync(path.join(d, 'repo b', '.git'), { recursive: true });
  fs.mkdirSync(path.join(d, "a'pos"));
  fs.mkdirSync(path.join(d, '.tersembunyi'));
  fs.writeFileSync(path.join(d, 'file.txt'), 'x');
  const real = fs.realpathSync(d);
  const r = await call('GET /api/machines/:id/browse', { id: 'mac-studio' }, {}, `dir=${encodeURIComponent(real)}`);
  assert.equal(r.dir, real);
  assert.equal(r.parent, path.dirname(real));
  assert.deepEqual(r.entries.map(e => [e.name, e.git]), [["a'pos", false], ['repo b', true]]);
  assert.equal(r.entries[1].path, path.join(real, 'repo b'));

  const home = await call('GET /api/machines/:id/browse', { id: 'mac-studio' });
  const H = process.env.HOME;
  assert.equal(home.dir, fs.existsSync(path.join(H, 'Developer')) ? path.join(H, 'Developer') : H);

  await assert.rejects(async () => call('GET /api/machines/:id/browse', { id: 'mac-studio' }, {}, 'dir=relatif'), /absolut/);
  await assert.rejects(async () => call('GET /api/machines/:id/browse', { id: 'mac-studio' }, {}, `dir=${encodeURIComponent(real + '/tidak-ada')}`), /tidak ditemukan/);
  await assert.rejects(async () => call('GET /api/machines/:id/browse', { id: 'tidak-ada' }), e => e.code === 404);
});

test('install ke mesin local: menyalin skrip dan VERSION; test melihatnya mutakhir', async () => {
  assert.equal(mx.listMachines().find(m => m.id === 'mac-studio').installed, null, 'belum pernah dicek → null');
  const before = await call('POST /api/machines/:id/test', { id: 'mac-studio' });
  assert.deepEqual(mx.listMachines().find(m => m.id === 'mac-studio').installed, { version: null, current: false });
  assert.equal(before.installed.version, null);
  assert.ok(before.problems.some(p => /belum terpasang di/.test(p)));

  const r = await call('POST /api/machines/:id/install', { id: 'mac-studio' });
  assert.equal(r.ok, true);
  assert.equal(r.root, mx.machineRoot('mac-studio'));
  for (const f of ['hooks/kantor-hook.cjs', 'hooks/kantor-statusline.cjs', 'server/mcp-stdio.js'])
    assert.equal(fs.readFileSync(path.join(r.root, f), 'utf8'), fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8'), f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, 'package.json'), 'utf8')).type, 'module');
  assert.equal(fs.readFileSync(path.join(r.root, 'VERSION'), 'utf8').trim(), r.version);
  assert.equal(r.version, api.payloadVersion());
  assert.ok(fs.statSync(path.join(r.root, 'run')).isDirectory());
  const listed = (await call('GET /api/machines')).machines.find(m => m.id === 'mac-studio');
  assert.deepEqual(listed.installed, { version: r.version, current: true }, 'publicMachine membawa hasil Pasang');

  // hub (palsu) membalas 401 seperti halaman login: terjangkau
  await call('PATCH /api/machines/:id', { id: 'mac-studio' }, { hubUrl: await hub(401) });
  const t = await call('POST /api/machines/:id/test', { id: 'mac-studio' });
  assert.deepEqual(t.installed, { version: r.version, current: true });
  assert.equal(t.hubReachable, true);
  assert.ok(!t.problems.some(p => /Skrip kantor|hub/.test(p)), t.problems.join(' | '));
  assert.equal(t.home, process.env.HOME);
  assert.ok(t.bins && 'tmux' in t.bins);

  // skrip lokal berubah → versi di mesin dianggap lama
  fs.writeFileSync(path.join(r.root, 'VERSION'), 'lama\n');
  const old = await call('POST /api/machines/:id/test', { id: 'mac-studio' });
  assert.equal(old.installed.current, false);
  assert.ok(old.problems.some(p => /versi lama/.test(p)));
  assert.deepEqual(mx.listMachines().find(m => m.id === 'mac-studio').installed, { version: 'lama', current: false });

  // detak jantung (async) membaca VERSION lagi dan mengirim event machine kalau berubah
  const seen = [];
  const on = m => { if (m.id === 'mac-studio') seen.push(m.installed); };
  mx.events.on('machine', on);
  fs.writeFileSync(path.join(r.root, 'VERSION'), r.version + '\n');
  await api.refreshInstalled('mac-studio');
  await api.refreshInstalled('mac-studio'); // tidak berubah → tanpa event
  mx.events.off('machine', on);
  assert.deepEqual(seen, [{ version: r.version, current: true }]);
});

test('test melaporkan problems: hub tak terjangkau, hub menolak host, SSH gagal', async () => {
  await call('PATCH /api/machines/:id', { id: 'mac-studio' }, { hubUrl: 'http://127.0.0.1:1' });
  const a = await call('POST /api/machines/:id/test', { id: 'mac-studio' });
  assert.equal(a.ok, false);
  assert.equal(a.hubReachable, false);
  assert.ok(a.problems.some(p => /tidak bisa menjangkau hub/.test(p)));

  await call('PATCH /api/machines/:id', { id: 'mac-studio' }, { hubUrl: await hub(403) });
  const b = await call('POST /api/machines/:id/test', { id: 'mac-studio' });
  assert.equal(b.hubReachable, false);
  assert.ok(b.problems.some(p => /menolak host/.test(p)), b.problems.join(' | '));

  const { machine } = await call('POST /api/machines', {}, { name: 'Jauh', ssh: 'kc-tidak-ada@127.0.0.1', hubUrl: 'http://hub.test:4317' });
  const c = await call('POST /api/machines/:id/test', { id: machine.id });
  assert.equal(c.ok, false);
  assert.equal(c.hubReachable, null);
  assert.ok(c.problems[0].startsWith('Tidak bisa SSH ke kc-tidak-ada@127.0.0.1'), c.problems[0]);
  assert.equal(mx.machineStatus(machine.id).online, false);
});

test('payload ikut menyalin file lokal yang di-require skrip', () => {
  const rels = api.payloadFiles().map(f => f.rel);
  for (const f of ['hooks/kantor-hook.cjs', 'hooks/kantor-statusline.cjs', 'server/mcp-stdio.js', 'package.json']) assert.ok(rels.includes(f), f);
  assert.ok(rels.every(r => !r.startsWith('..')));
});

test('startMachines meneruskan event mesin ke bus dan bisa dihentikan', async () => {
  const got = [];
  const on = m => { if (m.t === 'machine') got.push(m.machine.id); };
  bus.on('msg', on);
  api.startMachines({ watchSec: 3600, reapSec: 3600 });
  api.startMachines(); // kedua kali tidak memasang ulang
  mx.events.emit('machine', { id: 'x-uji', online: false });
  assert.deepEqual(got.filter(i => i === 'x-uji'), ['x-uji']);
  api.stopMachines();
  mx.events.emit('machine', { id: 'x-uji', online: false });
  assert.equal(got.filter(i => i === 'x-uji').length, 1);
  bus.off('msg', on);
});

