// Mengetik ke pane yang sedang di copy-mode (server/tmux-keys.js). Tanpa `copy-mode -q` di depan, huruf seperti
// t/g membuka command-prompt yang menahan `tmux send-keys` selamanya, dan daemon membeku bersamanya.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { leaveModeFirst } from '../server/tmux-keys.js';

const PRE = t => ['copy-mode', '-q', '-t', t, ';'];

test('send-keys teks dan tombol: keluar dari copy-mode dulu', () => {
  assert.deepEqual(leaveModeFirst(['send-keys', '-t', 'kc-a', '-l', 'google coba']), [...PRE('kc-a'), 'send-keys', '-t', 'kc-a', '-l', 'google coba']);
  assert.deepEqual(leaveModeFirst(['send-keys', '-t', 'kc-a', 'Enter']), [...PRE('kc-a'), 'send-keys', '-t', 'kc-a', 'Enter']);
  assert.deepEqual(leaveModeFirst(['send-keys', '-t', 'kc-a', '-l', '--', '-X']), [...PRE('kc-a'), 'send-keys', '-t', 'kc-a', '-l', '--', '-X']);
});

test('paste-buffer ke pane: keluar dari copy-mode dulu', () => {
  const a = ['paste-buffer', '-p', '-d', '-b', 'kc-1', '-t', 'kc-a'];
  assert.deepEqual(leaveModeFirst(a), [...PRE('kc-a'), ...a]);
});

test('perintah untuk mode itu sendiri, tanpa target, atau bukan mengetik: apa adanya', () => {
  for (const a of [
    ['send-keys', '-X', '-t', 'kc-a', 'cancel'],
    ['send-keys', '-t', 'kc-a', '-X', 'cancel'],
    ['send-keys', '-M', '-t', 'kc-a'],
    ['send-keys', 'Enter'],
    ['capture-pane', '-p', '-t', 'kc-a'],
    ['set-buffer', '-b', 'x', '--', 'teks'],
    ['list-sessions', '-F', '#{session_name}'],
  ]) assert.deepEqual(leaveModeFirst(a), a);
});

// Integrasi: server tmux sendiri (-L), klien ter-attach lewat pty (script), pane di copy-mode emacs.
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => fs.existsSync(p));
const SOCK = `kc-test-keys-${process.pid}`;
const T = (args, o = {}) => execFileSync(TMUX, ['-L', SOCK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000, ...o });
let client = null;
after(() => {
  try { client?.kill(); } catch {}
  let sock = null;
  try { sock = T(['display', '-p', '-t', 'x', '#{socket_path}']).trim(); } catch {}
  try { T(['kill-server']); } catch {}
  if (sock) fs.rmSync(sock, { force: true }); // kill-server tidak menghapus file socket-nya
});

test('pane di copy-mode dengan klien ter-attach: send-keys tidak macet', { skip: !TMUX || !fs.existsSync('/usr/bin/script') }, async () => {
  T(['-f', '/dev/null', 'new-session', '-d', '-s', 'x', '-x', '100', '-y', '30', 'sleep 600']);
  T(['set', '-g', 'mode-keys', 'emacs']);
  client = spawn('/usr/bin/script', ['-q', '/dev/null', TMUX, '-L', SOCK, 'attach', '-t', 'x'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !T(['list-clients']).trim(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(T(['list-clients']).trim(), 'klien tidak ter-attach');

  // kontrol: tanpa perbaikan, `t` membuka "(jump to forward)" dan send-keys menunggu selamanya
  T(['copy-mode', '-t', 'x']);
  assert.throws(() => T(['send-keys', '-t', 'x', '-l', 'tinggal'], { timeout: 1500 }), e => e.code === 'ETIMEDOUT');
  try { T(['send-keys', '-t', 'x', 'Escape']); T(['copy-mode', '-q', '-t', 'x']); } catch {}

  for (const text of ['tinggal nunggu 1 subagent nih?', 'google coba cek apa aja itu']) {
    T(['copy-mode', '-t', 'x']);
    assert.equal(T(['display', '-p', '-t', 'x', '#{pane_in_mode}']).trim(), '1');
    T(leaveModeFirst(['send-keys', '-t', 'x', '-l', text])); // melempar ETIMEDOUT bila macet
    assert.equal(T(['display', '-p', '-t', 'x', '#{pane_in_mode}']).trim(), '0');
  }
  T(['copy-mode', '-t', 'x']);
  T(['set-buffer', '-b', 'b', '--', 'tes']);
  T(leaveModeFirst(['paste-buffer', '-p', '-d', '-b', 'b', '-t', 'x']));
  assert.equal(T(['display', '-p', '-t', 'x', '#{pane_in_mode}']).trim(), '0');
});
