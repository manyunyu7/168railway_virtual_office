// Sesi manual di Mac mesin: skrip yang dipasang hub membaca <root>/hub.json bila env KANTOR_URL tidak ada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.KANTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-hub-'));
const mx = await import('../server/machines.js');
const api = await import('../server/machines-api.js');

test('Pasang menulis hub.json 0600; hook tanpa env memakai hub.json dengan token mesin', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: b }); res.end('{}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const m = mx.addMachine({ name: 'Mac Manual', ssh: 'local:', hubUrl: `http://127.0.0.1:${port}` });
  const r = api.installMachine(m.id);
  const hj = path.join(r.root, 'hub.json');
  assert.equal(fs.statSync(hj).mode & 0o777, 0o600);
  const tok = mx.getMachine(m.id).token;
  assert.deepEqual(JSON.parse(fs.readFileSync(hj, 'utf8')), { url: `http://127.0.0.1:${port}`, token: tok, machine: m.id });
  const env = { ...process.env, KANTOR_URL: '', KANTOR_TOKEN: '', HOME: process.env.KANTOR_HOME };
  await new Promise((resolve, reject) => {
    const c = require_spawn(process.execPath, [path.join(r.root, 'hooks', 'kantor-hook.cjs')], env);
    c.stdin.end(JSON.stringify({ session_id: 'man-1', hook_event_name: 'SessionStart', cwd: '/x' }));
    c.on('exit', resolve); c.on('error', reject);
  });
  srv.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/api/hook');
  assert.equal(got[0].auth, `Bearer ${tok}`);
});

import { spawn } from 'node:child_process';
function require_spawn(cmd, args, env) { return spawn(cmd, args, { env, stdio: ['pipe', 'ignore', 'ignore'] }); }
