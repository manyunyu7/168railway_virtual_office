import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-inbox-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));

const { live, openInbox, sweepInbox, bus } = await import('../server/live.js');
const { globalDb, run, one } = await import('../server/db.js');

const put = (id, sid) => run(globalDb(), "INSERT INTO inbox (id, office, sid, role, tool, input, summary, created_at, status, source) VALUES (?, 'o', ?, 'r', 'AskUserQuestion', '{}', '{}', ?, 'open', 'kantor')", id, sid, new Date().toISOString());
const status = id => one(globalDb(), 'SELECT status FROM inbox WHERE id = ?', id).status;

test('pertanyaan milik sesi yang sudah tidak hidup tidak nyangkut di "Menunggu kamu"', () => {
  live.set('hidup', { sid: 'hidup', status: 'waiting', subs: new Map() });
  live.set('selesai', { sid: 'selesai', status: 'ended', subs: new Map() });
  put('ib-hidup', 'hidup'); put('ib-selesai', 'selesai'); put('ib-hilang', 'tak-dikenal');
  const updates = [];
  const on = m => { if (m.t === 'inbox-update') updates.push(m.id); };
  bus.on('msg', on);
  const ids = openInbox().map(x => x.id);
  bus.off('msg', on);
  assert.deepEqual(ids, ['ib-hidup']);
  assert.equal(status('ib-selesai'), 'expired');
  assert.equal(status('ib-hilang'), 'expired');
  assert.equal(status('ib-hidup'), 'open');
  assert.deepEqual(updates.sort(), ['ib-hilang', 'ib-selesai']);
  assert.equal(sweepInbox(), 0);
});

test('sesi hidup: kartu kembaran dan kartu dari sebelum restart pindah ke terminal, kartu yang ditunggu tetap', () => {
  const old = new Date(Date.now() - 60000).toISOString();
  const putAt = (id, sid, at) => run(globalDb(), "INSERT INTO inbox (id, office, sid, role, tool, input, summary, created_at, status, source) VALUES (?, 'o', ?, 'r', 'AskUserQuestion', '{}', '{}', ?, 'open', 'kantor')", id, sid, at);
  live.set('jalan', { sid: 'jalan', status: 'waiting', waiting: { id: 'ib-ditunggu', tool: 'AskUserQuestion' }, subs: new Map() });
  putAt('ib-ditunggu', 'jalan', old); putAt('ib-kembar', 'jalan', old);
  live.set('restart', { sid: 'restart', status: 'idle', waiting: null, subs: new Map() });
  putAt('ib-yatim', 'restart', old); putAt('ib-baru', 'restart', new Date().toISOString());
  sweepInbox();
  assert.equal(status('ib-ditunggu'), 'open');
  assert.equal(status('ib-kembar'), 'terminal');
  assert.equal(status('ib-yatim'), 'terminal');
  assert.equal(status('ib-baru'), 'open', 'kartu yang baru dibuat diberi jeda');
});

test('kejadian hook yang persis sama dalam 3 detik dianggap kembar', async () => {
  const { duplicateHook } = await import('../server/live.js');
  const p = { session_id: 's-kembar', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' };
  assert.equal(duplicateHook(p, 1000), false);
  assert.equal(duplicateHook({ ...p }, 1500), true);
  assert.equal(duplicateHook({ ...p, tool_use_id: 't2' }, 1600), false, 'tool lain bukan kembar');
  assert.equal(duplicateHook({ ...p }, 5000), false, 'lewat 3 detik dihitung kejadian baru');
});
