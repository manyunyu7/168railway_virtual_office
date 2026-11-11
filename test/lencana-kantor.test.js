// Lencana "di mesin mana kantor bekerja" (web/js/lencana.js: roomsMachines, officePlacement, officeBadge).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../web/js/lencana.js');
let list = [];
L.setMachineSource({ machines: () => list, machineName: id => list.find(m => m.id === id)?.name || id });

const mini = (online = true) => ({ id: 'mac-mini', name: 'Mac mini', online });
const studio = (online = true) => ({ id: 'mac-studio', name: 'Mac Studio', online });

test('kantor yang semuanya di Mac ini (atau tanpa data) tidak berlencana', () => {
  list = [mini()];
  for (const ms of [undefined, null, [], [{ id: 'local', rooms: 4 }], [{ id: 'mac-mini', rooms: 0 }, { id: 'local', rooms: 2 }]]) {
    assert.equal(L.officePlacement(ms), null);
    assert.equal(L.officeBadge(ms), '');
  }
});

test('semua ruangan di satu mesin remote: nama mesin saja', () => {
  list = [mini()];
  const p = L.officePlacement([{ id: 'mac-mini', rooms: 5 }]);
  assert.equal(p.text, 'Mac mini');
  assert.equal(p.off, false);
  assert.equal(p.solo, true);
  assert.equal(p.title, 'Ruangan kantor ini: Mac mini 5 ruangan');
  const b = L.officeBadge([{ id: 'mac-mini', rooms: 5 }], 'mx-lead');
  assert.match(b, /class="mx-badge mx-office mx-lead"/);
  assert.match(b, />Mac mini<\/span>$/);
});

test('campuran dua mesin: "A + B" sesuai urutan jumlah ruangan', () => {
  list = [mini()];
  assert.equal(L.officePlacement([{ id: 'local', rooms: 3 }, { id: 'mac-mini', rooms: 1 }]).text, 'Mac ini + Mac mini');
  assert.equal(L.officePlacement([{ id: 'mac-mini', rooms: 3 }, { id: 'local', rooms: 1 }]).text, 'Mac mini + Mac ini');
});

test('lebih dari dua mesin: mesin remote pertama + N lainnya', () => {
  list = [mini(), studio()];
  const ms = [{ id: 'local', rooms: 4 }, { id: 'mac-mini', rooms: 2 }, { id: 'mac-studio', rooms: 1 }];
  const p = L.officePlacement(ms);
  assert.equal(p.text, 'Mac mini + 2 lainnya');
  assert.equal(p.title, 'Ruangan kantor ini: Mac ini 4 ruangan, Mac mini 2 ruangan, Mac Studio 1 ruangan');
  assert.deepEqual(p.ids, ['mac-mini', 'mac-studio']);
});

test('offline: kelas .off, awalan "offline ·" hanya bila satu mesin, tooltip menyebut mesin yang offline', () => {
  list = [mini(false)];
  const solo = L.officeBadge([{ id: 'mac-mini', rooms: 2 }]);
  assert.match(solo, /mx-badge mx-office off/);
  assert.match(solo, /offline ·/);
  const mixed = L.officeBadge([{ id: 'local', rooms: 2 }, { id: 'mac-mini', rooms: 2 }]);
  assert.match(mixed, /mx-badge mx-office off/);
  assert.doesNotMatch(mixed, /mx-offl/);
  assert.match(mixed, /Mac mini 2 ruangan \(offline\)/);
  list = [mini(true), studio(false)];
  assert.equal(L.officePlacement([{ id: 'mac-mini', rooms: 2 }, { id: 'mac-studio', rooms: 1 }]).off, true);
  list = [{ ...mini(), online: null }]; // belum pernah dicek: bukan offline
  assert.equal(L.officePlacement([{ id: 'mac-mini', rooms: 1 }]).off, false);
});

test('mesin yang tidak dikenal memakai id-nya, nama di-escape', () => {
  list = [{ id: 'x', name: '<b>"Mac"</b>', online: true }];
  assert.equal(L.officePlacement([{ id: 'hilang', rooms: 1 }]).text, 'hilang');
  assert.doesNotMatch(L.officeBadge([{ id: 'x', rooms: 1 }]), /<b>/);
});

test('roomsMachines: hanya ruangan berfolder, remote menang atas path, terbanyak dulu, seri Mac ini dulu', () => {
  const rooms = [
    { id: 'lobby', path: null }, { id: 'pantry' }, { id: 'kode', path: '' }, { id: 'web', path: 'web' },
    { id: 'api', path: null, machine: 'mac-mini', remotePath: '/x/api' }, { id: 'be', path: null, machine: 'mac-mini', remotePath: '/x/be' },
    { id: 'ml', path: null, machine: 'mac-studio', remotePath: '/y' }, { id: 'lokal', path: 'lokal', machine: 'local' },
    { id: '__pv', path: null, machine: 'mac-studio', remotePath: '/z', preview: true },
  ];
  assert.deepEqual(L.roomsMachines(rooms), [{ id: 'local', rooms: 3 }, { id: 'mac-mini', rooms: 2 }, { id: 'mac-studio', rooms: 1 }]);
  assert.deepEqual(L.roomsMachines([{ id: 'a', path: 'a' }, { id: 'b', path: null, machine: 'mac-mini', remotePath: '/b' }]), [{ id: 'local', rooms: 1 }, { id: 'mac-mini', rooms: 1 }]);
  assert.deepEqual(L.roomsMachines(undefined), []);
});
