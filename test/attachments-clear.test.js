import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-clear-'));
process.env.KANTOR_HOME = path.join(dir, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
const { globalDb, run } = await import('../server/db.js');
const { listAttachments } = await import('../server/attachments.js');

test('berkas dari sebelum /clear disembunyikan, bisa diminta semua', () => {
  const db = globalDb();
  for (const sid of ['lama', 'baru']) run(db, 'INSERT INTO sessions (sid, office, tmux, started_at, status) VALUES (?, ?, ?, ?, ?)', sid, 'o', 'kc-o-zora', '2026-11-12T01:00:00Z', 'idle');
  const add = (id, sid, at) => run(db, 'INSERT INTO attachments (id, sid, office, dir, path, name, mime, size, caption, at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, sid, 'o', 'out', `/x/${id}.apk`, `${id}.apk`, 'application/octet-stream', 1, '', at, '{}');
  add('a1', 'lama', '2026-11-12T02:00:00Z');
  add('a2', 'baru', '2026-11-12T04:00:00Z');
  // tanpa /clear (mis. /resume): seluruh keluarga tampil
  assert.deepEqual(listAttachments('baru').items.map(x => x.id), ['a1', 'a2']);
  run(db, 'INSERT INTO kv (key, value) VALUES (?, ?)', 'cleared.baru', '2026-11-12T03:00:00Z');
  const r = listAttachments('baru');
  assert.deepEqual(r.items.map(x => x.id), ['a2']);
  assert.equal(r.hiddenBeforeClear, 1);
  assert.deepEqual(listAttachments('baru', { all: true }).items.map(x => x.id), ['a1', 'a2']);
});
