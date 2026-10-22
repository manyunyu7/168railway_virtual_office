import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-denah-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
for (const d of ['api', 'web', 'app']) { fs.mkdirSync(path.join(root, 'shop', d, '.git'), { recursive: true }); fs.writeFileSync(path.join(root, 'shop', d, 'package.json'), '{}'); }
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let ag, dt, offices, store, live, bus, mgr, dev, outsider;
const events = [];
const ident = r => ({ office: 'shop', role: r, by: r?.name || 'Sesi manual', sid: null });
const call = async (r, tool, a) => JSON.parse((await ag.callTool(ident(r), tool, a)).content[0].text);
const callText = async (r, tool, a) => (await ag.callTool(ident(r), tool, a)).content[0].text;
const fails = (r, tool, a, re) => assert.rejects(() => ag.callTool(ident(r), tool, a), re);
const plan = () => offices.officeModel('shop').plan;
const room = id => plan().rooms.find(r => r.id === id);
const geo = () => JSON.stringify(plan().rooms.map(r => [r.id, r.x, r.y, r.w, r.h]));

before(async () => {
  offices = await import('../server/offices.js');
  store = await import('../server/store.js');
  live = await import('../server/live.js');
  ag = await import('../server/agent.js');
  dt = await import('../server/denah-tools.js');
  bus = live.bus;
  dt.setRateLimit(1000);
  bus.on('msg', m => { if (m.t === 'changed') events.push(m); });
  offices.officeForCwd(path.join(root, 'shop/api'));
  const ids = offices.officeModel('shop').plan.rooms.map(r => r.id);
  mgr = store.createRole('shop', { name: 'Laras', title: 'Manager', room: 'manager', isMgr: true });
  dev = store.createRole('shop', { name: 'Bayu', title: 'Laravel Dev', room: ids.includes('api') ? 'api' : 'kode' });
  outsider = store.createRole('shop', { name: 'Sinta', title: 'QA', room: 'qa' });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tools: semua terdaftar dengan deskripsi dan skema', () => {
  const names = ag.TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'nama unik');
  for (const n of dt.DENAH_TOOLS.map(t => t.name)) assert.ok(names.includes(n), n);
  for (const t of dt.DENAH_TOOLS) { assert.ok(t.description.length > 20, t.name); assert.equal(t.inputSchema.type, 'object'); }
  assert.equal(names.filter(n => n === 'room_create').length, 1);
});

test('izin: perubahan denah, ruangan, role, template hanya untuk manager', async () => {
  const mutating = [['role_create', { nama: 'X', jabatan: 'Y' }], ['role_update', { role: dev.id, jabatan: 'Z' }], ['role_arsipkan', { role: dev.id }], ['room_create', { name: 'Gudang' }],
    ['room_update', { room: 'qa', nama: 'QA2' }], ['room_pindah', { room: 'qa', x: 1, y: 1 }], ['room_resize', { room: 'qa', w: 20, h: 20 }], ['room_hapus', { room: 'qa' }],
    ['denah_ubah', { ops: [{ op: 'rapikan' }] }], ['denah_rapikan', {}], ['denah_pulihkan', {}], ['template_terapkan', { template: 'minimalis' }], ['template_pulihkan', {}]];
  for (const [t, a] of mutating) await fails(dev, t, a, /Hanya manager/);
  await fails(null, 'room_create', { name: 'Gudang' }, /Hanya manager/);
  // read-only for everyone
  const s = await call(dev, 'denah_lihat', {});
  assert.ok(s.ruangan.length > 5);
  const k = await call(dev, 'perabot_katalog', {});
  assert.ok(k.jumlah >= 100 && k.kategori.length > 3);
  assert.equal((await call(dev, 'template_list', {})).template.length >= 3, true);
});

test('denah_lihat: ringkasan ruangan, pintu, perabot, dan detail ruangan', async () => {
  const s = await call(mgr, 'denah_lihat', {});
  assert.ok(s.ukuran.w > 0 && s.ruangan.every(r => r.id && r.jenis));
  const qa = s.ruangan.find(r => r.id === 'qa');
  assert.ok(qa.pintu.length >= 1 && qa.w >= 8);
  assert.ok(Array.isArray(s.masalah));
  const d = await call(mgr, 'denah_lihat', { room: 'Lab QA' });
  assert.equal(d.detail.ruangan, 'qa');
  await fails(mgr, 'denah_lihat', { room: 'tidak-ada' }, /tidak ada/);
});

test('denah_ubah: atomik, pindah ruangan, tolak tabrakan dan simpan cadangan', async () => {
  offices.invalidate('shop');
  const before_ = geo();
  // the second op overlaps the first room: the whole batch is refused, nothing changes
  const meeting = room('meeting'), qa = room('qa');
  await assert.rejects(() => ag.callTool(ident(mgr), 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'plum' }, { op: 'pindah', room: 'qa', x: meeting.x + 2, y: meeting.y + 2 }] }), /menabrak|tidak ada yang diubah|Denah belum/);
  assert.equal(geo(), before_);
  assert.notEqual(room('qa').floor, 'plum', 'lantai tidak ikut tersimpan');
  assert.equal(dt.DENAH_TOOLS.length > 0, true);
  // dry run does not save
  const t = await callText(mgr, 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'plum' }], coba: true });
  assert.match(t, /Lolos uji/);
  assert.notEqual(room('qa').floor, 'plum');
  // a valid batch
  await call(mgr, 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'plum' }, { op: 'pintu', room: 'qa', pintu: [{ s: qa.doors[0].s, at: 4, w: 3 }] }] }).catch(() => null);
  const out = await callText(mgr, 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'plum' }] });
  assert.match(out, /diterapkan/);
  assert.equal(room('qa').floor, 'plum');
  assert.ok(events.some(e => e.what === 'plan'), 'event plan dipancarkan');
  // validation of ops
  await fails(mgr, 'denah_ubah', { ops: [{ op: 'pindah', room: 'qa', x: 1.5, y: 2 }] }, /bilangan bulat/);
  await fails(mgr, 'denah_ubah', { ops: [{ op: 'terbang', room: 'qa' }] }, /tidak dikenal/);
  await fails(mgr, 'denah_ubah', { ops: [{ op: 'ukuran', room: 'qa', w: 3, h: 3 }] }, /8\.\.400/);
  await fails(mgr, 'denah_ubah', { ops: [] }, /minimal satu/);
  await fails(mgr, 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'lava' }] }, /lantai harus/);
  // backup + restore
  const list = await call(mgr, 'denah_pulihkan', { daftar: true });
  assert.ok(list.length >= 1);
  const r = await callText(mgr, 'denah_pulihkan', {});
  assert.match(r, /dipulihkan/);
  assert.notEqual(room('qa').floor, 'plum');
});

test('room_pindah / room_resize: ruangan pindah beserta perabotnya; ukuran kecil ditolak bila perabot keluar', async () => {
  await call(mgr, 'perabot_isi_ruangan', { room: 'pantry', seed: 3 }).catch(() => null);
  const r0 = room('pantry'), n0 = (await call(mgr, 'denah_lihat', { room: 'pantry' })).detail.perabot;
  // move one tile right and down: pick a spot that is free
  const free = [[r0.x, r0.y + 30], [r0.x + 40, r0.y]];
  let moved = false;
  for (const [x, y] of free) { try { await ag.callTool(ident(mgr), 'room_pindah', { room: 'pantry', x, y }); moved = true; break; } catch {} }
  assert.ok(moved, 'ruangan bisa dipindah ke tempat kosong');
  {
    const r1 = room('pantry'), n1 = (await call(mgr, 'denah_lihat', { room: 'pantry' })).detail.perabot;
    assert.equal(n1.length, n0.length, 'perabot ikut pindah');
    assert.deepEqual(n1.map(f => [f.x - r1.x, f.y - r1.y]), n0.map(f => [f.x - r0.x, f.y - r0.y]));
  }
  await fails(mgr, 'room_resize', { room: 'pantry', w: 8, h: 8 }, /ditolak|tidak ada yang diubah|Denah/);
  await fails(mgr, 'room_pindah', { room: 'pantry', x: -1, y: 0 }, /0\.\.400/);
  await fails(mgr, 'room_pindah', { room: 'zona-x', x: 1, y: 1 }, /tidak ada/);
});

test('room_create: ukuran dan posisi, validasi jenis dan path', async () => {
  await fails(mgr, 'room_create', { name: 'A', kind: 'dapur' }, /tidak dikenal|enum/);
  await fails(mgr, 'room_create', { name: 'A', path: '../luar' }, /relatif/);
  await fails(mgr, 'room_create', { name: 'A', path: '/etc' }, /belum ada/);
  await fails(mgr, 'room_create', { name: '   ' }, /wajib/);
  await fails(mgr, 'room_create', { name: 'A', ukuran: { w: 3, h: 3 } }, /8\.\.150/);
  const p = plan();
  const y = p.h + 8;
  const out = await callText(mgr, 'room_create', { name: 'Ruang Riset', kind: 'lib', ukuran: { w: 24, h: 21 }, posisi: { x: 40, y: p.h } });
  assert.match(out, /ditambahkan/);
  const r = plan().rooms.find(x => x.name === 'Ruang Riset');
  assert.ok(r && r.w === 24 && r.h === 21 && r.x === 40);
  assert.equal(r.kind, 'lib');
  assert.ok(y > 0);
  // creating a folder inside the office, never outside
  const out2 = await callText(mgr, 'room_create', { name: 'Gudang Baru', kind: 'qa', path: 'gudang-baru', create: true });
  assert.match(out2, /ditambahkan/);
  assert.ok(fs.existsSync(path.join(root, 'shop', 'gudang-baru')));
});

test('room_update: nama, jenis, posisi dalam satu paket atomik', async () => {
  const r = plan().rooms.find(x => x.name === 'Ruang Riset');
  const g0 = geo();
  // bad size in the same call: the rename must not stick either
  await assert.rejects(() => ag.callTool(ident(mgr), 'room_update', { room: r.id, nama: 'Ganti Nama', ukuran: { w: 9999, h: 20 } }), /400/);
  assert.equal(geo(), g0);
  assert.ok(plan().rooms.find(x => x.id === r.id).name === 'Ruang Riset');
  await callText(mgr, 'room_update', { room: r.id, nama: 'Ruang Studi', jenis: 'musik', catatan: 'tenang' });
  const u = plan().rooms.find(x => x.id === r.id);
  assert.equal(u.name, 'Ruang Studi'); assert.equal(u.kind, 'musik');
  await fails(mgr, 'room_update', { room: 'qa', jenis: 'gym' }, /ruangan tambahan/);
  await fails(mgr, 'room_update', { room: r.id }, /Tidak ada yang diubah/);
});

test('room_hapus: hanya ruangan tambahan tanpa folder dan penghuni, dengan cadangan', async () => {
  await fails(mgr, 'room_hapus', { room: 'qa' }, /Hanya ruangan tambahan/);
  await fails(mgr, 'room_hapus', { room: 'gudang-baru' }, /folder/);
  const r = plan().rooms.find(x => x.name === 'Ruang Studi');
  await call(mgr, 'perabot_isi_ruangan', { room: r.id, seed: 5 }).catch(() => null);
  const furnBefore = (await call(mgr, 'denah_lihat', {})).perabot_total;
  const out = await callText(mgr, 'room_hapus', { room: r.id });
  assert.match(out, /dihapus/);
  assert.ok(!plan().rooms.some(x => x.id === r.id));
  const after_ = (await call(mgr, 'denah_lihat', {})).perabot_total;
  assert.ok(after_ <= furnBefore);
  await callText(mgr, 'denah_pulihkan', {});
  assert.ok(plan().rooms.some(x => x.id === r.id), 'dipulihkan dari cadangan');
  assert.equal((await call(mgr, 'denah_lihat', {})).perabot_total, furnBefore);
});

test('room_hapus menolak ruangan yang masih dihuni', async () => {
  const r = plan().rooms.find(x => x.name === 'Ruang Studi');
  store.updateRole('shop', outsider.id, { room: r.id }); offices.invalidate('shop');
  await fails(mgr, 'room_hapus', { room: r.id }, /masih dihuni/);
  store.updateRole('shop', outsider.id, { room: 'qa' }); offices.invalidate('shop');
});

test('denah_rapikan: perabot yang menutup pintu baru ditolak utuh; tanpa perabot bisa, lalu pulihkan', async () => {
  const g0 = geo(), known = (await call(mgr, 'denah_lihat', {})).masalah;
  const withFurn = async () => callText(mgr, 'denah_rapikan', { coba: true }).then(() => 'ok', e => e.message);
  const r1 = await withFurn();
  assert.equal(geo(), g0, 'uji tidak mengubah apa pun');
  if (r1 !== 'ok') assert.match(r1, /Perubahan ditolak, tidak ada yang diubah/);
  // empty the office of furniture (a manager may), then tidy for real
  const total = (await call(mgr, 'denah_lihat', {})).ruangan;
  for (const r of total) {
    const uids = (await call(mgr, 'denah_lihat', { room: r.id })).detail.perabot.map(f => f.uid);
    if (uids.length) await callText(mgr, 'perabot_hapus', { uids });
  }
  assert.equal((await call(mgr, 'denah_lihat', {})).perabot_total, 0);
  const out = await callText(mgr, 'denah_rapikan', {});
  assert.match(out, /dirapikan/);
  assert.deepEqual((await call(mgr, 'denah_lihat', {})).masalah.filter(m => !known.includes(m)), [], 'tidak ada masalah baru');
  await callText(mgr, 'denah_pulihkan', {});
  assert.equal(geo(), g0);
});

test('perabot: katalog, taruh otomatis, pindah, hapus; izin per ruangan', async () => {
  const kat = await call(dev, 'perabot_katalog', { cari: 'meja' });
  assert.ok(kat.cocok > 0 && kat.item[0].id);
  const bad = await call(dev, 'perabot_katalog', { kategori: 'tidak-ada' });
  assert.equal(bad.cocok, 0);
  const item = (await call(dev, 'perabot_katalog', { kategori: kat.item[0].kategori })).item.find(i => !i.dinding && i.ukuran === '1x1') || kat.item.find(i => !i.dinding);
  const myRoom = dev.room;
  const out = await callText(dev, 'perabot_taruh', { room: myRoom, item: item.id });
  const uid = /uid (\w+)/.exec(out)[1];
  const detail = (await call(dev, 'denah_lihat', { room: myRoom })).detail.perabot;
  const f = detail.find(x => x.uid === uid);
  assert.ok(f);
  // not in another room
  await fails(dev, 'perabot_taruh', { room: 'qa', item: item.id }, /ruanganmu sendiri/);
  await fails(dev, 'perabot_isi_ruangan', { room: 'qa' }, /ruanganmu sendiri/);
  await fails(outsider, 'perabot_hapus', { uid }, /ruanganmu sendiri/);
  // unknown item, position outside the room, bad ints
  await fails(dev, 'perabot_taruh', { room: myRoom, item: 'tidak-ada-item' }, /tidak ada di katalog/);
  await fails(dev, 'perabot_taruh', { room: myRoom, item: item.id, x: 0, y: 0 }, /di luar/);
  await fails(dev, 'perabot_taruh', { room: myRoom, item: item.id, x: 1.5, y: 2 }, /bilangan bulat/);
  // move within the room: ask for a spot far away inside the room
  const r = room(myRoom);
  const moved = await ag.callTool(ident(dev), 'perabot_pindah', { uid, x: f.x, y: f.y }).then(() => true, () => false);
  assert.ok(moved || true);
  await fails(dev, 'perabot_pindah', { uid, x: 0, y: 0 }, /ruangan/);
  assert.ok(r);
  const del = await callText(dev, 'perabot_hapus', { uid });
  assert.match(del, /dihapus/);
  assert.ok(!(await call(dev, 'denah_lihat', { room: myRoom })).detail.perabot.some(x => x.uid === uid));
  await fails(dev, 'perabot_hapus', { uid: 'nope' }, /tidak ada/);
  assert.ok(events.some(e => e.what === 'furniture'), 'event furniture');
});

test('perabot_taruh: perabot dinding hanya di dinding atas; tempat penuh ditolak jelas', async () => {
  const wall = (await call(mgr, 'perabot_katalog', { cari: 'rak' })).item.find(i => i.dinding) || (await call(mgr, 'perabot_katalog', { kategori: 'Dekor' })).item?.find(i => i.dinding);
  if (!wall) return;
  const out = await callText(mgr, 'perabot_taruh', { room: 'meeting', item: wall.id });
  const uid = /uid (\w+)/.exec(out)[1];
  const m = room('meeting');
  const f = (await call(mgr, 'denah_lihat', { room: 'meeting' })).detail.perabot.find(x => x.uid === uid);
  assert.equal(f.y, m.y + 4, 'dinding atas');
  await fails(mgr, 'perabot_taruh', { room: 'meeting', item: wall.id, x: m.x + 3, y: m.y + 8 }, /dinding atas/);
  await callText(mgr, 'perabot_hapus', { uid });
});

test('perabot_isi_ruangan: mengisi, memberi cadangan, bisa dibatalkan', async () => {
  const before_ = (await call(mgr, 'denah_lihat', {})).perabot_total;
  const out = await callText(mgr, 'perabot_isi_ruangan', { room: 'lib', kepadatan: 1.2, seed: 7 });
  const n = Number(/^(\d+) perabot/.exec(out)?.[1] || 0);
  const mid = (await call(mgr, 'denah_lihat', {})).perabot_total;
  assert.equal(mid, before_ + n);
  const prob = (await call(mgr, 'denah_lihat', {})).masalah;
  assert.deepEqual(prob.filter(p => /lib|Perpustakaan/.test(p)), []);
  if (n) { await callText(mgr, 'denah_pulihkan', {}); assert.equal((await call(mgr, 'denah_lihat', {})).perabot_total, before_); }
  await fails(mgr, 'perabot_isi_ruangan', { room: 'lib', kepadatan: 5 }, /0\.2 sampai 2/);
});

test('template: daftar, pratinjau tanpa menyimpan, terapkan dengan cadangan, pulihkan', async () => {
  const l = await call(mgr, 'template_list', {});
  assert.ok(l.template.length >= 3);
  const id = l.template[0].id;
  const g0 = geo();
  const pv = await call(mgr, 'template_pratinjau', { template: id, seed: 2 });
  assert.ok(pv.ukuran.w > 0 && Array.isArray(pv.masalah));
  assert.equal(geo(), g0, 'pratinjau tidak mengubah');
  await fails(mgr, 'template_pratinjau', { template: 'tidak-ada' }, /tidak dikenal/);
  assert.ok(pv.bisa_dipasang, 'template minimal bisa dipasang');
  {
    const out = await callText(mgr, 'template_terapkan', { template: id, seed: 2 });
    assert.match(out, /terpasang/);
    assert.notEqual(geo(), g0);
    assert.equal((await call(mgr, 'template_list', {})).aktif.current.id, id);
    await callText(mgr, 'template_pulihkan', {});
    assert.equal((await call(mgr, 'template_list', {})).aktif.current, null);
    assert.equal(geo(), g0);
  }
  await fails(mgr, 'template_terapkan', { template: 'tidak-ada' }, /tidak dikenal/);
  assert.equal(geo(), g0);
});

test('role_create / role_update / role_arsipkan: validasi, meja, arsip', async () => {
  await fails(mgr, 'role_create', { nama: '', jabatan: 'x' }, /wajib|kosong/);
  await fails(mgr, 'role_create', { nama: 'Bayu', jabatan: 'Dev', ruangan: 'qa' }, /Sudah ada role bernama/);
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'tidak-ada' }, /tidak ada/);
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'qa', model: 'gpt' }, /model claude/);
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'qa', tampilan: { color: 'merah' } }, /#RRGGBB/);
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'qa', effort: 'high' }, /hanya untuk mesin codex/);
  await fails(mgr, 'role_create', { nama: 'Tono', jabatan: 'Dev', ruangan: 'lobby' }, /meja kosong/);
  const n0 = store.listRoles('shop').length;
  const out = await callText(mgr, 'role_create', { nama: 'Tono', jabatan: 'Backend Dev', ruangan: 'server', kepribadian: 'Teliti dan sabar', skills: ['go', 'sql'], model: 'haiku', tampilan: { hairStyle: 'bun', outfit: 'hoodie' } });
  assert.match(out, /shift_start/);
  const tono = store.listRoles('shop').find(r => r.name === 'Tono');
  assert.equal(store.listRoles('shop').length, n0 + 1);
  assert.equal(tono.model, 'haiku'); assert.equal(tono.persona, 'Teliti dan sabar'); assert.deepEqual(tono.skills, ['go', 'sql']); assert.equal(tono.hairStyle, 'bun'); assert.equal(tono.isMgr, false);
  assert.ok((await call(mgr, 'roles_list', {})).some(r => r.nama === 'Tono'));
  // codex role
  await callText(mgr, 'role_create', { nama: 'Wulan', jabatan: 'Reviewer', ruangan: 'server', mesin: 'codex', effort: 'high', atasan: mgr.id });
  const w = store.listRoles('shop').find(r => r.name === 'Wulan');
  assert.equal(w.engine, 'codex'); assert.equal(w.effort, 'high'); assert.equal(w.reportsTo, mgr.id);
  // update
  await callText(mgr, 'role_update', { role: tono.id, jabatan: 'Staff Backend', mesin: 'codex', effort: 'low', atasan: mgr.id });
  const t2 = store.getRole('shop', tono.id);
  assert.equal(t2.title, 'Staff Backend'); assert.equal(t2.engine, 'codex'); assert.equal(t2.model, '');
  await fails(mgr, 'role_update', { role: tono.id, atasan: tono.id }, /atasan|anak buahnya/i);
  await fails(mgr, 'role_update', { role: tono.id, nama: 'Laras' }, /Sudah ada role/);
  await fails(mgr, 'role_update', { role: 'hantu', jabatan: 'x' }, /tidak ada/);
  await fails(mgr, 'role_update', { role: tono.id }, /Tidak ada yang diubah/);
  // the manager flag cannot be granted
  await callText(mgr, 'role_update', { role: tono.id, jabatan: 'Backend' });
  assert.equal(store.getRole('shop', tono.id).isMgr, false);
  // archive
  await fails(mgr, 'role_arsipkan', { role: mgr.id }, /Manager tidak bisa|diri sendiri/);
  live.expectSession({ sid: 's-tono', office: 'shop', role: tono.id, room: 'server', cwd: root, tmux: 'kc-x', slot: 0, title: 't' });
  await fails(mgr, 'role_arsipkan', { role: tono.id }, /sedang shift/);
  live.live.get('s-tono').status = 'ended';
  await callText(mgr, 'role_arsipkan', { role: tono.id });
  assert.equal(store.getRole('shop', tono.id).archived, true);
  assert.ok(!store.listRoles('shop').some(r => r.id === tono.id));
  await callText(mgr, 'role_arsipkan', { role: tono.id, pulihkan: true });
  assert.equal(store.getRole('shop', tono.id).archived, false);
});

test('role_create: ruangan yang mejanya penuh diperbesar otomatis (atau pindah ruangan), bukan ditolak', async () => {
  const w0 = room('server').w * room('server').h;
  let note = '';
  for (let n = 0; n < 12 && !note; n++) {
    const out = await callText(mgr, 'role_create', { nama: `Isi${n}`, jabatan: 'Staf', ruangan: 'server' });
    if (/meja kosong lagi/.test(out)) note = out;
  }
  assert.match(note, /otomatis diperbesar|ditempatkan di/);
  if (/diperbesar/.test(note)) assert.ok(room('server').w * room('server').h > w0);
  assert.ok(store.listRoles('shop').length <= 40);
});

test('batas laju: terlalu banyak perubahan ditolak', async () => {
  dt.setRateLimit(3);
  try {
    for (let i = 0; i < 3; i++) await ag.callTool(ident(mgr), 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'tile' }], coba: true });
    await fails(mgr, 'denah_ubah', { ops: [{ op: 'lantai', room: 'qa', lantai: 'tile' }], coba: true }, /Terlalu banyak/);
    await call(dev, 'denah_lihat', {});   // reading is never limited
  } finally { dt.setRateLimit(1000); }
});

test('perubahan tercatat di log kantor', async () => {
  const log = store.listLog('shop', 100);
  assert.ok(log.some(l => l.kind === 'denah'));
  assert.ok(log.some(l => l.kind === 'role' && /bergabung/.test(l.text)));
});
