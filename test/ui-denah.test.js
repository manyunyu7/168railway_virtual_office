// Denah dikelompokkan per mesin (docs/MULTI-PC.md): ruangan remote dapat sayap sendiri, ruangan lokal tidak bergeser,
// layout tersimpan dihormati, dan tanpa ruangan remote denah identik dengan penempatan lama (basePlan + appendRow).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-denah-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const remote = path.join(tmp, 'mac2'); // folder "di Mac lain" (transport local:), di luar roots
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
for (const d of ['shop/api', 'shop/web', 'solo/app', 'solo/lib']) fs.mkdirSync(path.join(root, d, '.git'), { recursive: true });
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.writeFileSync(path.join(root, 'shop/web/package.json'), '{}');
for (const d of ['be', 'ml', 'ops', 'etl', 'gpu', 'baru']) fs.mkdirSync(path.join(remote, d), { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let mx, offices, layout, db, shop, solo;
before(async () => {
  mx = await import('../server/machines.js');
  offices = await import('../server/offices.js');
  layout = await import('../server/layout.js');
  db = await import('../server/db.js');
  shop = offices.officeForCwd(path.join(root, 'shop/api'));
  solo = offices.officeForCwd(path.join(root, 'solo/app'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const plan = id => offices.officeModel(id).plan;
const geo = r => ({ x: r.x, y: r.y, w: r.w, h: r.h, doors: r.doors });
const byId = (p, id) => p.rooms.find(r => r.id === id);
// penempatan sebelum fitur ini: basePlan lalu SATU appendRow untuk semua ruangan tambahan
function legacyPlan(id) {
  const m = offices.officeModel(id);
  const roles = db.all(db.officeDb(id), 'SELECT id, room FROM roles WHERE archived = 0');
  const p = structuredClone(offices.basePlan(m.root, m.scan, roles));
  const extra = JSON.parse(db.one(db.officeDb(id), "SELECT value FROM meta WHERE key = 'extraRooms'")?.value || '[]');
  if (extra.length) layout.appendRow(p, extra.map(x => ({ ...x, extra: true })));
  return p;
}
const strip = p => { const { furniture, ...rest } = structuredClone(p); return rest; };

test('tanpa ruangan remote: plan identik dengan penempatan lama, tanpa kunci baru', () => {
  assert.deepEqual(strip(plan(shop)), strip(legacyPlan(shop)));
  offices.addRoom(shop, { name: 'Gudang', kind: 'pantry' });
  offices.addRoom(shop, { name: 'Lab Dua', kind: 'kode' });
  const before = structuredClone(plan(shop));
  assert.deepEqual(strip(before), strip(legacyPlan(shop)));
  assert.equal('machineAreas' in before, false);
  // mendaftarkan mesin saja tidak mengubah denah
  mx.addMachine({ name: 'Mac Studio', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
  mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
  offices.invalidate(shop);
  assert.deepEqual(plan(shop), before);
  assert.deepEqual(offices.layoutProblems(before), []);
});

test('ruangan remote: satu sayap per mesin, urut daftar mesin; ruangan lokal tetap di tempatnya', () => {
  const localOnly = structuredClone(plan(shop));
  // diselang-seling dan Mac Dua lebih dulu: hasilnya tetap dikelompokkan, Mac Studio (urutan config) di atas
  const a = offices.addRoom(shop, { name: 'ML', machine: 'mac-dua', remotePath: path.join(remote, 'ml') });
  const b = offices.addRoom(shop, { name: 'Backend', machine: 'mac-studio', remotePath: path.join(remote, 'be') });
  const c = offices.addRoom(shop, { name: 'Ops', machine: 'mac-dua', remotePath: path.join(remote, 'ops') });
  const lok = offices.addRoom(shop, { name: 'Lokal Tiga', kind: 'qa' }); // lokal yang ditambah setelah ruangan remote
  const p = plan(shop);
  for (const r of localOnly.rooms) {
    if (r.kind === 'lobby') { assert.deepEqual([r.x, r.y, r.w], [byId(p, r.id).x, byId(p, r.id).y, byId(p, r.id).w]); continue; } // lobi hanya memanjang ke bawah
    assert.deepEqual(geo(byId(p, r.id)), geo(r), `ruangan lokal ${r.id} tidak bergeser`);
  }
  // ruangan lokal baru masuk baris lokal, bukan sayap mesin
  const gudang = p.rooms.find(r => r.name === 'Gudang');
  assert.equal(byId(p, lok).y, gudang.y);
  const ra = byId(p, a), rb = byId(p, b), rc = byId(p, c);
  assert.equal(ra.y, rc.y, 'ruangan satu mesin satu baris');
  assert.ok(rb.y > gudang.y && ra.y > rb.y, 'lokal, lalu Mac Studio, lalu Mac Dua');
  assert.deepEqual(offices.layoutProblems(p), []);
  // area per mesin: nama dari config, papan nama di koridor di atas ruangannya, tidak menimpa ruangan lain
  assert.deepEqual(p.machineAreas.map(x => [x.machine, x.name]), [['mac-studio', 'Mac Studio'], ['mac-dua', 'Mac Dua']]);
  for (const ar of p.machineAreas) {
    const mine = p.rooms.filter(r => r.machine === ar.machine);
    for (const r of mine) assert.ok(r.x >= ar.x && r.y >= ar.y && r.x + r.w <= ar.x + ar.w && r.y + r.h <= ar.y + ar.h);
    assert.ok(ar.label && ar.label.y > ar.y && ar.label.y < Math.min(...mine.map(r => r.y)), 'papan nama di koridor');
    for (const r of p.rooms.filter(r => r.machine !== ar.machine && r.kind !== 'zone')) {
      const ox = Math.min(r.x + r.w, ar.x + ar.w) - Math.max(r.x, ar.x), oy = Math.min(r.y + r.h, ar.y + ar.h) - Math.max(r.y, ar.y);
      assert.ok(!(ox > 1 && oy > 1), `area ${ar.machine} tidak menimpa ${r.id}`);
    }
  }
});

test('pratinjau ruangan remote masuk sayap mesinnya', () => {
  const p = plan(shop);
  const { model } = offices.previewRoom(shop, { name: 'ETL', machine: 'mac-dua', remotePath: path.join(remote, 'etl') });
  const pv = byId(model.plan, '__pv'), ml = model.plan.rooms.find(r => r.name === 'ML');
  assert.equal(pv.y, ml.y);
  assert.equal(pv.x, Math.max(...p.rooms.filter(r => r.machine === 'mac-dua').map(r => r.x + r.w)) - 1);
});

test('layout tersimpan dihormati: hanya ruangan remote tanpa posisi tersimpan yang dikelompokkan', () => {
  const p = structuredClone(plan(shop));
  // geser satu ruangan Mac Studio ke pojok kanan bawah yang bebas lalu simpan semuanya
  const be = p.rooms.find(r => r.name === 'Backend');
  p.h += 30; Object.assign(be, { x: p.w - 22, y: p.h - 22, w: 20, h: 20, doors: [{ s: 't', at: 5, w: 3 }] });
  const saved = offices.saveLayout(shop, { w: p.w, h: p.h, rooms: p.rooms, decor: p.decor });
  assert.deepEqual([byId(saved, be.id).x, byId(saved, be.id).y], [p.w - 22, p.h - 22]);
  const savedGeo = Object.fromEntries(saved.rooms.map(r => [r.id, geo(r)]));
  // ruangan baru: satu remote (Mac Studio) dan satu lokal, tanpa posisi tersimpan
  const nb = offices.addRoom(shop, { name: 'GPU', machine: 'mac-studio', remotePath: path.join(remote, 'gpu') });
  const nl = offices.addRoom(shop, { name: 'Lokal Empat', kind: 'kode' });
  const q = plan(shop);
  for (const [id, g] of Object.entries(savedGeo)) {
    const r = byId(q, id);
    if (r.kind === 'lobby') { assert.deepEqual([r.x, r.y, r.w], [g.x, g.y, g.w]); continue; } // lobi memanjang ke baris baru (perilaku lama)
    assert.deepEqual(geo(r), g, `${id} tetap di posisi tersimpan`);
  }
  assert.ok(byId(q, nb).y > byId(q, nl).y, 'ruangan lokal baru di baris lokal, ruangan remote baru di sayapnya sendiri');
  assert.ok(byId(q, nb).y >= saved.h, 'ditaruh di bawah denah tersimpan');
  // Backend sendirian di pojok, GPU di sayap baru: dua area Mac Studio, masing-masing tidak menimpa ruangan lain
  const studio = q.machineAreas.filter(x => x.machine === 'mac-studio');
  assert.equal(studio.length, 2);
  assert.ok(studio.some(x => x.label), 'sayap baru punya papan nama');
  assert.deepEqual(offices.layoutProblems(q), []);
  offices.resetLayout(shop);
});

test('kantor lain tanpa ruangan remote tidak terpengaruh (dengan layout tersimpan dan ruangan baru)', () => {
  offices.addRoom(solo, { name: 'Satu', kind: 'kode' });
  const p0 = structuredClone(plan(solo));
  assert.deepEqual(strip(p0), strip(legacyPlan(solo)));
  p0.h += 10;
  offices.saveLayout(solo, { w: p0.w, h: p0.h, rooms: p0.rooms, decor: p0.decor });
  offices.addRoom(solo, { name: 'Dua', kind: 'pantry' });
  const p1 = plan(solo);
  assert.equal('machineAreas' in p1, false);
  // ruangan baru di baris baru di bawah denah tersimpan, persis seperti appendRow lama
  const dua = p1.rooms.find(r => r.name === 'Dua');
  assert.equal(dua.y, p0.h + 7);
  assert.equal(dua.x, byId(p1, 'lobby').x + byId(p1, 'lobby').w - 1);
});

test('machineAreas: ruangan remote di tengah ruangan lokal tidak membuat area yang menimpa', () => {
  const p = { w: 60, h: 40, rooms: [
    { id: 'a', kind: 'kode', x: 0, y: 0, w: 20, h: 20, machine: 'm1' },
    { id: 'l', kind: 'kode', x: 19, y: 0, w: 20, h: 20 },
    { id: 'b', kind: 'kode', x: 38, y: 0, w: 20, h: 20, machine: 'm1' },
  ] };
  const ar = offices.machineAreas(p);
  assert.equal(ar.length, 2);
  assert.ok(ar.every(x => x.label === null), 'tidak ada koridor di atas: tanpa papan nama');
  assert.deepEqual(offices.machineAreas({ rooms: [{ id: 'x', kind: 'kode', x: 0, y: 0, w: 10, h: 10 }] }), []);
});
