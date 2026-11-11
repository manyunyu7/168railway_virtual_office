// Ringkasan `machines` per kantor untuk GET /api/state (server/kantor-mesin.js). Mesin memakai transport 'local:'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-kmesin-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const remote = path.join(tmp, 'mac2');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
for (const d of ['shop/api', 'shop/web']) { fs.mkdirSync(path.join(root, d), { recursive: true }); fs.writeFileSync(path.join(root, d, 'go.mod'), 'module x'); }
for (const d of ['be', 'ml', 'web']) fs.mkdirSync(path.join(remote, d), { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let mx, offices, km, office;
before(async () => {
  mx = await import('../server/machines.js');
  offices = await import('../server/offices.js');
  km = await import('../server/kantor-mesin.js');
  mx.addMachine({ name: 'Mac mini', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
  office = offices.officeForCwd(path.join(root, 'shop/api'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('machineSummary: hanya ruangan berfolder, terbanyak dulu', () => {
  assert.deepEqual(km.machineSummary([{ path: null }, { path: '' }, { path: 'a' }, { machine: 'm2', remotePath: '/x' }]), [{ id: 'local', rooms: 2 }, { id: 'm2', rooms: 1 }]);
  assert.deepEqual(km.machineSummary([{ machine: 'm2' }, { machine: 'm2' }, { path: 'a' }]), [{ id: 'm2', rooms: 2 }, { id: 'local', rooms: 1 }]);
  assert.deepEqual(km.machineSummary(null), []);
});

test('officeMachines: kantor lokal tanpa field; ruangan remote dihitung per mesin', () => {
  assert.equal(km.officeMachines(office), undefined);
  const local = offices.officeModel(office).plan.rooms.filter(r => r.path != null).length;
  assert.ok(local >= 2);
  offices.addRoom(office, { name: 'Backend', machine: 'mac-mini', remotePath: path.join(remote, 'be') });
  assert.deepEqual(km.officeMachines(office), [{ id: 'local', rooms: local }, { id: 'mac-mini', rooms: 1 }]);
  offices.addRoom(office, { name: 'ML', machine: 'mac-mini', remotePath: path.join(remote, 'ml') });
  const web = offices.officeModel(office).plan.rooms.find(r => r.path === 'web');
  // ruangan hasil scan dipindah ke mesin lain lewat override (meta 'rooms'), bukan extraRooms
  offices.updateRoom(office, web.id, { machine: 'mac-mini', remotePath: path.join(remote, 'web') });
  assert.deepEqual(km.officeMachines(office), [{ id: 'mac-mini', rooms: 3 }, { id: 'local', rooms: local - 1 }]);
});

test('officeMachines tidak melempar untuk kantor yang tidak ada', () => {
  assert.equal(km.officeMachines('tidak-ada'), undefined);
});
