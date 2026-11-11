import { test } from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../web/js/lencana.js');
let list = [];
L.setMachineSource({ machines: () => list, machineName: id => list.find(m => m.id === id)?.name || id });

const studio = (online = true) => ({ id: 'mac-studio', name: 'Mac Studio', online });

test('Mac ini (null atau local) tidak pernah berlencana atau offline', () => {
  list = [studio(false)];
  for (const machine of [null, undefined, 'local']) {
    const s = { sid: 'a', status: 'idle', machine, machineOffline: true };
    assert.equal(L.sessBadge(s), '');
    assert.equal(L.sessOffline(s), false);
    assert.equal(L.offlineBanner(s), '');
    assert.equal(L.blockReason(s), '');
    assert.equal(L.blockAttr(s), '');
    assert.equal(L.outboxWaitText(s), '');
    assert.equal(L.roomBadge({ id: 'fe', machine }), '');
    assert.equal(L.roomOffline({ id: 'fe', machine }), false);
    assert.equal(L.machineLabel(machine), '');
  }
  assert.equal(L.sessBadge(null), '');
  assert.equal(L.sessOffline(null), false);
});

test('lencana remote memakai nama mesin dan menandai offline', () => {
  list = [studio(true)];
  const s = { sid: 'b', status: 'working', machine: 'mac-studio', machineOffline: false };
  const b = L.sessBadge(s);
  assert.match(b, /class="mx-badge"/);
  assert.match(b, /Mac Studio/);
  assert.doesNotMatch(b, /offline/);
  list = [studio(false)];
  assert.match(L.sessBadge(s), /mx-badge off/);
  assert.match(L.sessBadge(s), /offline/);
  assert.match(L.roomBadge({ id: 'be', machine: 'mac-studio' }), /Mac Studio/);
});

test('status mesin dari event mengalahkan salinan di sesi; tanpa data mesin pakai machineOffline', () => {
  const s = { sid: 'c', status: 'idle', machine: 'mac-studio', machineOffline: true };
  list = [studio(true)];
  assert.equal(L.sessOffline(s), false);
  list = [studio(false)];
  assert.equal(L.sessOffline({ ...s, machineOffline: false }), true);
  list = [];
  assert.equal(L.sessOffline(s), true);
  assert.equal(L.sessOffline({ ...s, machineOffline: false }), false);
  list = [{ id: 'mac-studio', name: 'Mac Studio', online: null }]; // belum pernah dicek
  assert.equal(L.sessOffline(s), true);
  assert.equal(L.sessOffline({ ...s, status: 'ended' }), false);
});

test('offline: banner, alasan tombol, dan label antrean pesan', () => {
  list = [studio(false)];
  const s = { sid: 'd', status: 'idle', machine: 'mac-studio' };
  assert.equal(L.offlineText(s), 'Mac Studio offline. Pesan disimpan dan dikirim saat tersambung lagi; terminal tidak tersedia.');
  assert.match(L.offlineBanner(s), /class="mx-banner" role="status"/);
  assert.equal(L.blockReason(s), 'Tidak tersedia: Mac Studio sedang offline');
  assert.equal(L.blockAttr(s), ' disabled title="Tidak tersedia: Mac Studio sedang offline"');
  assert.equal(L.outboxWaitText(s), 'Tersimpan · dikirim saat Mac Studio tersambung lagi');
  assert.equal(L.roomBlockReason({ id: 'be', machine: 'mac-studio' }), 'Tidak bisa mulai shift: Mac Studio sedang offline');
  list = [studio(true)];
  assert.equal(L.blockAttr(s), '');
  assert.equal(L.offlineBanner(s), '');
  assert.equal(L.roomBlockReason({ id: 'be', machine: 'mac-studio' }), '');
});

test('nama mesin tak dikenal jatuh ke id; teks dari server di-escape', () => {
  list = [];
  assert.equal(L.machineLabel('mesin-x'), 'mesin-x');
  list = [{ id: 'evil', name: '<img src=x onerror=alert(1)>"', online: false }];
  const b = L.machineBadge('evil');
  assert.doesNotMatch(b, /<img/);
  assert.match(b, /&lt;img/);
  assert.doesNotMatch(L.offlineBanner({ sid: 'e', status: 'idle', machine: 'evil' }), /<img/);
  const attr = L.blockAttr({ sid: 'e', status: 'idle', machine: 'evil' });
  assert.match(attr, /&lt;img/);
  assert.equal(attr.split('"').length, 3); // tanda kutip dari nama tidak memecah atribut
});

test('mesin role mengikuti ruangannya', () => {
  const plan = { rooms: [{ id: 'fe', machine: null }, { id: 'be', machine: 'mac-studio', remotePath: '/Users/x/be' }] };
  assert.equal(L.roleMachine(plan, { room: 'fe' }), null);
  assert.equal(L.roleMachine(plan, { room: 'be' }), 'mac-studio');
  assert.equal(L.roleMachine(plan, { room: 'nope' }), null);
});

test('sumber mesin yang melempar error tidak merusak tampilan', () => {
  L.setMachineSource({ machines: () => { throw new Error('x'); }, machineName: () => { throw new Error('y'); } });
  assert.equal(L.machineLabel('mac-studio'), 'mac-studio');
  assert.equal(L.sessOffline({ sid: 'f', status: 'idle', machine: 'mac-studio', machineOffline: true }), true);
  assert.equal(L.anyRemote(), false);
});
