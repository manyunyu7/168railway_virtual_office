import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-reap-'));
process.env.KANTOR_HOME = home;
const db = await import('../server/db.js');
const { expectSession, live } = await import('../server/live.js');
const { reapGoneTmux, adoptRunning } = await import('../server/tmux.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

function shift(sid, tmux, startedAt) {
  const s = expectSession({ sid, office: 'shop', role: 'engineer', room: 'web', cwd: home, tmux });
  s.startedAt = startedAt;
  db.run(db.officeDb('shop'),
    "INSERT INTO shifts (sid, role, started_at, cwd, tmux, status) VALUES (?, 'engineer', ?, ?, ?, 'aktif')",
    sid, startedAt, home, tmux);
  return s;
}

test('reaper closes a dead starting shift after startup grace period', () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  const recent = new Date().toISOString();
  shift('dead-start', 'kc-shop-dead', old);
  shift('new-start', 'kc-shop-new', recent);
  shift('alive-start', 'kc-shop-alive', old);

  assert.equal(reapGoneTmux(['kc-shop-alive']), 1);
  assert.equal(live.get('dead-start').status, 'ended');
  assert.equal(db.one(db.globalDb(), "SELECT status FROM sessions WHERE sid = 'dead-start'").status, 'ended');
  assert.equal(db.one(db.officeDb('shop'), "SELECT status FROM shifts WHERE sid = 'dead-start'").status, 'selesai');
  assert.equal(live.get('new-start').status, 'starting');
  assert.equal(live.get('alive-start').status, 'starting');
});

test('daemon adoption closes the shift row when its tmux pane is gone', () => {
  shift('orphan-start', 'kc-shop-orphan', new Date(Date.now() - 120_000).toISOString());
  adoptRunning(['kc-shop-new', 'kc-shop-alive']);

  const session = db.one(db.globalDb(), "SELECT status, ended_at FROM sessions WHERE sid = 'orphan-start'");
  const row = db.one(db.officeDb('shop'), "SELECT status, ended_at FROM shifts WHERE sid = 'orphan-start'");
  assert.equal(session.status, 'ended');
  assert.ok(session.ended_at);
  assert.equal(row.status, 'selesai');
  assert.equal(row.ended_at, session.ended_at);
});
