import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KANTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-mx-'));
const mx = await import('../server/machines.js');

test('mesin loopback: tambah, token, exec, file, cermin', () => {
  const m = mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.local:4317/' });
  assert.equal(m.id, 'mac-dua');
  assert.equal(m.token, undefined, 'token tidak pernah keluar lewat publicMachine');
  assert.equal(m.hubUrl, 'http://hub.local:4317');
  assert.ok(mx.isRemote('mac-dua'));
  assert.ok(!mx.isRemote('local'));
  const full = mx.getMachine('mac-dua');
  assert.equal(mx.machineForToken(full.token), 'mac-dua');
  assert.equal(mx.machineForToken('salah'), null);
  assert.equal(mx.execSync('mac-dua', 'echo', ["it's ok"]).trim(), "it's ok");
  const f = path.join(mx.machineRunDir('mac-dua'), 'a b.txt');
  mx.writeFile('mac-dua', f, 'halo dunia');
  assert.equal(mx.statFile('mac-dua', f).size, 10);
  assert.equal(mx.readFrom('mac-dua', f, 5).toString(), 'dunia');
  assert.equal(mx.statFile('mac-dua', f + 'x'), null);
  const mp = mx.mirrorPath('mac-dua', '/Users/x/.claude/projects/a/b.jsonl');
  assert.deepEqual(mx.remoteOfMirror(mp), { machine: 'mac-dua', file: '/Users/x/.claude/projects/a/b.jsonl' });
  mx.setTmuxMachine('kc-o-be', 'mac-dua');
  assert.equal(mx.tmuxMachineOf('kc-o-be:0.0'), 'mac-dua');
  assert.equal(mx.tmuxMachineOf('kc-o-fe'), 'local');
  assert.equal(mx.spawnArgs('mac-dua', 'echo', ['x']).file, '/bin/sh');
});

test('validasi alamat ssh dan url hub', () => {
  assert.throws(() => mx.addMachine({ name: 'x', ssh: '-oProxyCommand=evil', hubUrl: 'http://a' }));
  assert.throws(() => mx.addMachine({ name: 'x', ssh: 'a b', hubUrl: 'http://a' }));
  assert.throws(() => mx.addMachine({ name: 'x', ssh: 'h@m', hubUrl: 'ftp://a' }));
});
