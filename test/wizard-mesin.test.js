// Wizard Tambah kantor untuk project di mesin lain (docs/MULTI-PC.md). Mesin memakai transport 'local:'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-wzmx-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
// "Mac mini": folder yang hanya dikenal lewat mesin 'local:'. Sengaja di dalam roots: kalau path remote bocor ke
// registerOffice/officeForCwd, folder ini akan didaftarkan sebagai kantor lokal dan tesnya gagal.
const mini = path.join(root, 'mini');
const proj = path.join(mini, 'toko');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'lokal/app'), { recursive: true });
fs.writeFileSync(path.join(root, 'lokal/app/index.html'), '<p>');
fs.mkdirSync(path.join(proj, 'api/.git'), { recursive: true });
fs.writeFileSync(path.join(proj, 'api/go.mod'), 'module api');
fs.mkdirSync(path.join(proj, 'web/.git'), { recursive: true });
fs.writeFileSync(path.join(proj, 'web/package.json'), JSON.stringify({ dependencies: { next: '15' } }));
fs.writeFileSync(path.join(proj, 'web/CLAUDE.md'), '# web');
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.writeFileSync(path.join(proj, 'docs/README.md'), 'docs');
fs.mkdirSync(path.join(proj, 'node_modules/x'), { recursive: true });
fs.mkdirSync(path.join(proj, 'kosong'), { recursive: true });
// satu repo di root
const solo = path.join(mini, 'solo');
fs.mkdirSync(path.join(solo, '.git'), { recursive: true });
fs.writeFileSync(path.join(solo, 'Cargo.toml'), '[package]');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let mx, offices, wz, db;
before(async () => {
  mx = await import('../server/machines.js');
  offices = await import('../server/offices.js');
  wz = await import('../server/wizard.js');
  db = await import('../server/db.js');
  mx.addMachine({ name: 'Mac mini', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
});
after(() => { try { db.closeAll(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

const team = [{ name: 'Bu Ratna', title: 'Manager', isMgr: true }, { name: 'Dimas', title: 'Frontend', room: 'web' }, { name: 'Arya', title: 'Backend', room: 'api' }];
const rootsOf = () => db.all(db.globalDb(), 'SELECT root FROM offices').map(r => r.root);
const noLocalLeak = () => { for (const r of rootsOf()) assert.ok(!r.startsWith(mini), `kantor lokal palsu terdaftar: ${r}`); };

test('scanRemoteRoot: struktur folder setara scanRoot, dalam satu panggilan', () => {
  const s = offices.scanRemoteRoot('mac-mini', proj + '/');
  const local = offices.scanRoot(proj);
  assert.equal(s.exists, true);
  for (const k of ['rootIsGit', 'repos', 'worktrees', 'folders']) assert.deepEqual(s[k], local[k], k);
  assert.deepEqual(s.dirs, ['api', 'docs', 'kosong', 'web']);
  assert.equal(offices.scanRemoteRoot('mac-mini', path.join(mini, 'tidak-ada')).exists, false);
});

test('preview folder remote: ruangan bertanda mesin dan path di sana, tidak ada kantor terdaftar', () => {
  const before = rootsOf().length;
  const pv = wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: proj, team });
  assert.equal(pv.name, 'toko');
  assert.equal(pv.machine, 'mac-mini');
  assert.deepEqual(pv.warnings, []);
  const byId = Object.fromEntries(pv.plan.rooms.map(r => [r.id, r]));
  assert.deepEqual([byId.api.machine, byId.api.remotePath, byId.api.path, byId.api.stack], ['mac-mini', path.join(proj, 'api'), null, 'Go']);
  assert.deepEqual([byId.web.remotePath, byId.web.stack], [path.join(proj, 'web'), 'Next.js']);
  assert.equal(byId.lib.remotePath, path.join(proj, 'docs'));
  assert.equal(byId.meeting.machine, undefined);
  assert.deepEqual(pv.rooms.map(r => r.id).sort(), ['api', 'web']);
  assert.equal(pv.team.find(t => t.name === 'Dimas').room, 'web');
  assert.equal(rootsOf().length, before);
});

test('create folder remote: root placeholder, ruangan remote, roomCwd ke Mac mini', () => {
  const pv = wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: proj, team });
  const r = wz.wizardCreate({ mode: 'existing', machine: 'mac-mini', root: proj, team, firstCard: true });
  noLocalLeak();
  const row = db.one(db.globalDb(), 'SELECT * FROM offices WHERE id = ?', r.id);
  assert.equal(r.id, 'toko');
  assert.equal(row.name, 'toko');
  assert.ok(row.root.startsWith(offices.REMOTE_ROOTS_DIR + path.sep), row.root);
  assert.deepEqual(fs.readdirSync(row.root), []);
  assert.ok(r.card);
  const m = offices.officeModel(r.id);
  assert.deepEqual(m.remote, { machine: 'mac-mini', root: proj });
  // ruangan sama dengan pratinjau
  assert.deepEqual(m.plan.rooms.map(x => x.id).sort(), pv.plan.rooms.map(x => x.id).sort());
  const room = id => m.plan.rooms.find(x => x.id === id);
  assert.deepEqual([room('api').machine, room('api').remotePath, room('api').path], ['mac-mini', path.join(proj, 'api'), null]);
  assert.equal(room('web').stack, 'Next.js');
  assert.deepEqual(offices.roomCwd(m, 'api'), { machine: 'mac-mini', cwd: path.join(proj, 'api') });
  assert.deepEqual(offices.roomCwd(m, 'lib'), { machine: 'mac-mini', cwd: path.join(proj, 'docs') });
  // ruangan tanpa folder sendiri (manager, meeting) bekerja di root project di Mac mini, bukan di placeholder hub
  assert.deepEqual(offices.roomCwd(m, 'manager'), { machine: 'mac-mini', cwd: proj });
  assert.deepEqual(offices.roomCwd(m, 'meeting'), { machine: 'mac-mini', cwd: proj });
  // tim duduk di ruangan yang dipilih; shift role-nya akan jalan di mesin itu
  const roles = db.all(db.officeDb(r.id), 'SELECT name, room, is_mgr FROM roles WHERE archived = 0');
  const dimas = roles.find(x => x.name === 'Dimas');
  assert.equal(dimas.room, 'web');
  assert.deepEqual(offices.roomCwd(m, dimas.room), { machine: 'mac-mini', cwd: path.join(proj, 'web') });
  assert.equal(roles.find(x => x.is_mgr).room, 'manager');
  assert.deepEqual(offices.roomForRemote('mac-mini', path.join(proj, 'web/src')), { office: r.id, room: 'web' });
  // tercatat juga di meta 'rooms' (dibaca kantor-mesin.js untuk lencana mesin)
  const ov = JSON.parse(db.one(db.officeDb(r.id), "SELECT value FROM meta WHERE key = 'rooms'").value);
  assert.deepEqual(ov.api, { path: null, machine: 'mac-mini', remotePath: path.join(proj, 'api'), stack: 'Go' });
  assert.match(JSON.stringify(ov), /"machine"\s*:\s*"(?!local")[^"]+"/);
  // CLAUDE.md tidak diminta: isi folder di sana tidak berubah
  assert.equal(fs.existsSync(path.join(proj, 'CLAUDE.md')), false);
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: proj, team }), /sudah jadi kantor/);
  assert.throws(() => wz.wizardCreate({ mode: 'existing', machine: 'mac-mini', root: proj, team }), /sudah jadi kantor/);
});

test('repo di root project jadi ruangan kode di root mesin itu; nama kantor = nama folder', () => {
  const spec = { mode: 'existing', machine: 'mac-mini', root: solo, team: [], claudeMd: true, description: 'Mesin hitung', template: 'zen-garden', seed: 3 };
  const pv = wz.wizardPreview(spec);
  assert.deepEqual(pv.warnings, []);
  const r = wz.wizardCreate(spec);
  noLocalLeak();
  assert.equal(r.template, 'zen-garden');
  const m = offices.officeModel(r.id);
  // template diterapkan di atas ruangan remote; susunannya sama dengan pratinjau
  assert.deepEqual(m.plan.rooms.map(x => x.id).sort(), pv.plan.rooms.map(x => x.id).sort());
  assert.equal(m.name, 'solo');
  const kode = m.plan.rooms.find(x => x.id === 'kode');
  assert.deepEqual([kode.machine, kode.remotePath, kode.stack], ['mac-mini', solo, 'Rust']);
  assert.deepEqual(offices.roomCwd(m, 'manager'), { machine: 'mac-mini', cwd: solo });
  // CLAUDE.md ditulis di mesin itu
  assert.match(fs.readFileSync(path.join(solo, 'CLAUDE.md'), 'utf8'), /# solo[\s\S]*Mesin hitung/);
});

test('project baru di mesin lain: folder, git init, dan CLAUDE.md dibuat di sana', () => {
  const spec = { mode: 'new', machine: 'mac-mini', name: 'Kedai Baru', base: mini, layout: 'multi', subs: ['be', 'fe'], gitInit: true, claudeMd: true, team };
  const pv = wz.wizardPreview(spec);
  assert.equal(pv.root, path.join(mini, 'kedai-baru'));
  assert.deepEqual(pv.rooms.map(x => [x.id, x.remotePath]), [['be', path.join(mini, 'kedai-baru/be')], ['fe', path.join(mini, 'kedai-baru/fe')]]);
  const r = wz.wizardCreate(spec);
  noLocalLeak();
  assert.deepEqual(r.created, [path.join(mini, 'kedai-baru')]);
  for (const s of ['be', 'fe']) {
    assert.ok(fs.existsSync(path.join(mini, 'kedai-baru', s, '.git')), `${s}/.git`);
    assert.ok(fs.existsSync(path.join(mini, 'kedai-baru', s, 'CLAUDE.md')), `${s}/CLAUDE.md`);
  }
  assert.ok(fs.existsSync(path.join(mini, 'kedai-baru/CLAUDE.md')));
  const m = offices.officeModel(r.id);
  assert.equal(m.name, 'Kedai Baru');
  assert.equal(m.plan.rooms.find(x => x.id === 'fe').remotePath, path.join(mini, 'kedai-baru/fe'));
  assert.ok(m.root.startsWith(offices.REMOTE_ROOTS_DIR));
  // folder sudah ada → pratinjau memperingatkan, create ditolak
  assert.match(wz.wizardPreview(spec).warnings.join(' '), /sudah ada di mesin Mac mini/);
  assert.throws(() => wz.wizardCreate(spec), /sudah ada di mesin Mac mini/);
  assert.throws(() => wz.wizardPreview({ ...spec, base: path.join(mini, 'tidak-ada') }), /Lokasi .* tidak ada di mesin Mac mini/);
});

test('input salah dan mesin offline ditolak dengan pesan jelas', () => {
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'tidak-ada', root: proj }), /Mesin tidak ditemukan/);
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: 'relatif/saja' }), /path absolut/);
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: '/' }), /akar/);
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: path.join(mini, 'hilang') }), /tidak ada di mesin Mac mini/);
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: `${proj}\n; rm -rf /` }), /tidak valid/);

  mx.addMachine({ name: 'Mati', ssh: 'nobody@host-yang-tidak-ada.invalid', hubUrl: 'http://hub.local:4317' });
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mati', root: '/Users/x/proj' }), /Mati (tidak terjangkau|sedang offline)/);
  assert.ok(mx.isOffline('mati'));
  const before = rootsOf().length;
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mati', root: '/Users/x/proj' }), /Mesin Mati sedang offline/);
  assert.throws(() => wz.wizardCreate({ mode: 'new', machine: 'mati', name: 'x', base: '/Users/x', team }), /Mesin Mati sedang offline/);
  assert.equal(rootsOf().length, before);
  assert.deepEqual(fs.readdirSync(offices.REMOTE_ROOTS_DIR).sort(), ['kedai-baru', 'solo', 'toko']);
  mx.removeMachine('mati');

  mx.updateMachine('mac-mini', { disabled: true });
  assert.throws(() => wz.wizardPreview({ mode: 'existing', machine: 'mac-mini', root: solo }), /dinonaktifkan/);
  mx.updateMachine('mac-mini', { disabled: false });
});

test('wizard lokal tidak berubah: machine kosong atau local memakai jalur lama', () => {
  const pv = wz.wizardPreview({ mode: 'existing', machine: 'local', root: path.join(root, 'lokal'), team: [] });
  assert.equal(pv.machine, undefined);
  assert.equal(pv.plan.rooms.find(x => x.id === 'app').path, 'app');
  const r = wz.wizardCreate({ mode: 'existing', machine: '', root: path.join(root, 'lokal'), team: [] });
  const m = offices.officeModel(r.id);
  assert.equal(m.root, path.join(root, 'lokal'));
  assert.equal(m.remote, undefined);
  assert.deepEqual(offices.roomCwd(m, 'meeting'), { machine: 'local', cwd: path.join(root, 'lokal') });
});
