import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; globalThis.dispatchEvent = () => true; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem() { return null; }, setItem() {} }; globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ addEventListener() {}, matches: false });
const fired = [];
globalThis.document = { dispatchEvent(e) { fired.push(e.type); return true; }, addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { style: { setProperty() {} }, dataset: {} } };
const M = await import('../web/js/mesin.js');

test('statusOf: online, offline, belum dicek, nonaktif', () => {
  assert.equal(M.statusOf({ online: true }).k, 'online');
  assert.equal(M.statusOf({ online: false }).k, 'offline');
  assert.equal(M.statusOf({ online: null }).k, 'unknown');
  assert.equal(M.statusOf({}).label, 'Belum dicek');
  assert.equal(M.statusOf({ online: true, disabled: true }).k, 'disabled');
  assert.equal(M.statusOf(null).k, 'unknown');
});

test('latencyText dan metaLine', () => {
  assert.equal(M.latencyText(null), '');
  assert.equal(M.latencyText(0.4), '<1 ms');
  assert.equal(M.latencyText(23.6), '24 ms');
  assert.equal(M.metaLine({ online: null }), 'belum pernah terhubung');
  const ln = M.metaLine({ online: true, latencyMs: 12, lastSeen: new Date().toISOString() }, { version: '3', current: true });
  assert.equal(ln, 'latensi 12 ms · terakhir terlihat baru saja · skrip 3 terpasang (terbaru)');
  // latensi tidak ditampilkan saat offline (angka lama menyesatkan)
  assert.ok(!M.metaLine({ online: false, latencyMs: 12 }).includes('latensi'));
});

test('status pemasangan skrip', () => {
  assert.equal(M.installText(null), '');
  assert.equal(M.installText({ version: null }), 'skrip belum dipasang');
  assert.equal(M.installText({ version: 'cf1bd77e830a', current: false }), 'skrip cf1bd77 terpasang (perlu diperbarui)');
  assert.equal(M.installLabel(null), 'Pasang skrip');
  assert.equal(M.installLabel({ version: '2', current: false }), 'Perbarui skrip');
  assert.equal(M.installLabel({ version: '3', current: true }), 'Pasang ulang');
});

test('validateMachineForm menyamai server dan menolak localhost', () => {
  const ok = { name: 'Mac Studio', ssh: 'henry@mac-studio.tail1234.ts.net', hubUrl: 'http://air.tail1234.ts.net:4317' };
  assert.equal(M.validateMachineForm(ok), null);
  assert.equal(M.validateMachineForm({ ...ok, ssh: 'local:' }), null);
  assert.match(M.validateMachineForm({ ...ok, name: '  ' }), /Nama/);
  assert.match(M.validateMachineForm({ ...ok, ssh: '' }), /SSH wajib/);
  assert.match(M.validateMachineForm({ ...ok, ssh: 'henry@mac studio' }), /tidak valid/);
  assert.match(M.validateMachineForm({ ...ok, ssh: '-oProxyCommand=x' }), /tidak valid/);
  assert.match(M.validateMachineForm({ ...ok, hubUrl: '' }), /URL hub wajib/);
  assert.match(M.validateMachineForm({ ...ok, hubUrl: 'air:4317' }), /http atau https|tidak valid/);
  assert.match(M.validateMachineForm({ ...ok, hubUrl: 'ftp://air' }), /http atau https/);
  assert.match(M.validateMachineForm({ ...ok, hubUrl: 'http://127.0.0.1:4317' }), /localhost/);
  assert.match(M.validateMachineForm({ ...ok, hubUrl: 'http://localhost:4317' }), /localhost/);
  // transport local: (tes di satu Mac) boleh memakai localhost
  assert.equal(M.validateMachineForm({ ...ok, ssh: 'local:', hubUrl: 'http://127.0.0.1:4317' }), null);
});

test('defaultHubUrl: origin kecuali loopback', () => {
  assert.equal(M.defaultHubUrl({ origin: 'http://127.0.0.1:4317', hostname: '127.0.0.1', port: '4317' }), '');
  assert.equal(M.defaultHubUrl({ origin: 'http://localhost:4317', hostname: 'localhost' }), '');
  assert.equal(M.defaultHubUrl({ origin: 'http://air.tail1234.ts.net:4317', hostname: 'air.tail1234.ts.net' }), 'http://air.tail1234.ts.net:4317');
  assert.equal(M.defaultHubUrl(null), '');
  assert.equal(M.hubPlaceholder({ port: '4400' }), 'http://macbook-air.tail1234.ts.net:4400');
});

test('machineOptions: Mac ini dulu, offline dan nonaktif tidak bisa dipilih', () => {
  const o = M.machineOptions([{ id: 'a', name: 'A', online: true }, { id: 'b', name: 'B', online: false }, { id: 'c', name: 'C', online: null }, { id: 'd', name: 'D', online: true, disabled: true }]);
  assert.deepEqual(o.map(x => [x.id, x.disabled, x.note]), [['', false, ''], ['a', false, ''], ['b', true, 'offline'], ['c', false, 'belum dicek'], ['d', true, 'nonaktif']]);
  assert.equal(o[0].label, 'Mac ini');
});

test('crumbsOf dan baseName', () => {
  assert.deepEqual(M.crumbsOf('/Users/henry/dev'), [{ name: '/', dir: '/' }, { name: 'Users', dir: '/Users' }, { name: 'henry', dir: '/Users/henry' }, { name: 'dev', dir: '/Users/henry/dev' }]);
  assert.deepEqual(M.crumbsOf('/'), [{ name: '/', dir: '/' }]);
  assert.equal(M.baseName('/Users/henry/web-app/'), 'web-app');
  assert.equal(M.baseName(null), '');
});

test('cache: onMachineEvent menambah dan memperbarui, machineName', () => {
  M.onMachineEvent({ id: 'studio', name: 'Mac Studio', online: null });
  M.onMachineEvent({ id: 'studio', name: 'Mac Studio', online: true, latencyMs: 9 });
  M.onMachineEvent(null);
  assert.equal(M.machines().length, 1);
  assert.equal(M.machines()[0].online, true);
  assert.equal(M.machineName('studio'), 'Mac Studio');
  assert.equal(M.machineName('local'), 'Mac ini');
  assert.equal(M.machineName(null), 'Mac ini');
  assert.equal(M.machineName('lain'), 'lain');
  M.onMachineEvent({ t: 'machine', machine: { id: 'x2', name: 'X2', online: false } });
  assert.equal(M.machines().length, 2);
  M.onMachineEvent({ id: 'x2' }, { t: 'machine', removed: true });
  assert.deepEqual(M.machines().map(m => m.id), ['studio']);
  // setiap perubahan cache memberi tahu modul lain (lencana)
  assert.ok(fired.length >= 4 && fired.every(t => t === 'kantor:machines'));
});

test('canManage: mode tunggal semua boleh, mode akun hanya admin', () => {
  assert.equal(M.canManage({ akun: false }), true);
  assert.equal(M.canManage({ akun: true, me: { role: 'admin' } }), true);
  assert.equal(M.canManage({ akun: true, me: { role: 'anggota' } }), false);
  assert.equal(M.canManage({ akun: true }), false);
});
