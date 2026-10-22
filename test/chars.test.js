import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolated data dir, set before any server module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-chars-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'toko/api'), { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

let store, db, seed;
before(async () => {
  store = await import('../server/store.js');
  db = await import('../server/db.js');
  seed = await import('../server/seed.js');
});
after(() => { db.closeAll?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('createRole persists outfit, acc and hijab; roleRow returns them', () => {
  const r = store.createRole('toko', { name: 'Aulia', title: 'Dev', room: 'api', hairStyle: 'hijab', outfit: 'dress', acc: 'kacamata', hijab: '#2F5D9E' });
  const got = store.getRole('toko', r.id);
  assert.equal(got.hairStyle, 'hijab'); assert.equal(got.outfit, 'dress'); assert.equal(got.acc, 'kacamata'); assert.equal(got.hijab, '#2F5D9E');
  assert.equal(store.listRoles('toko').find(x => x.id === r.id).outfit, 'dress');
});

test('updateRole changes the look fields', () => {
  const r = store.createRole('toko', { name: 'Bima', title: 'QA', room: 'api' });
  assert.equal(r.outfit, 'kemeja'); assert.equal(r.acc, ''); // defaults for roles made without a look
  const up = store.updateRole('toko', r.id, { hairStyle: 'ponytail', outfit: 'rok', acc: 'anting', hijab: '#C2417A' });
  assert.deepEqual([up.hairStyle, up.outfit, up.acc, up.hijab], ['ponytail', 'rok', 'anting', '#C2417A']);
  assert.equal(store.updateRole('toko', r.id, { acc: '' }).acc, '');
});

test('old rows without the new columns still load with defaults', () => {
  const d = db.officeDb('toko');
  seed.insertRole(d, { id: 'lama', name: 'Lama', title: 'Dev', model: 'sonnet', room: 'api', color: '#2F5D9E', hair: '#2B1D14', skin: '#F1C9A5' }, 9);
  d.prepare('UPDATE roles SET outfit = NULL, acc = NULL, hijab = NULL WHERE id = ?').run('lama');
  const got = store.getRole('toko', 'lama');
  assert.equal(got.outfit, 'kemeja'); assert.equal(got.acc, ''); assert.ok(got.hijab); assert.equal(got.hairStyle, 'short');
});
