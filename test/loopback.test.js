// fromLoopback: hanya listener HTTP lokal (cfg.port) yang dianggap "Mac ini". Koneksi ke listener TLS juga datang dari
// 127.0.0.1 kalau lewat TCP passthrough atau tunnel, jadi tidak boleh dihitung loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-loop-'));
const key = path.join(tmp, 'k.pem'), cert = path.join(tmp, 'c.pem');
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const kids = [];
after(() => { for (const k of kids) k.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function daemon(name, extra = {}) {
  const port = await freePort(), tlsPort = await freePort();
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [tmp], token: 'tok', port, sysmon: { enabled: false }, tls: { host: '127.0.0.1', port: tlsPort, cert, key, names: ['office.test'] }, ...extra }));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: 'ignore' });
  kids.push(child);
  const d = { port, tlsPort };
  for (let i = 0; i < 100; i++) { try { await call(d, false, '/api/state'); await call(d, true, '/api/state'); return d; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('daemon tidak jalan');
}
function call(d, secure, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = (secure ? https : http).request({ host: '127.0.0.1', port: secure ? d.tlsPort : d.port, path: p, rejectUnauthorized: false,
      headers: { Host: secure ? 'office.test' : `127.0.0.1:${d.port}`, ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end();
  });
}
// status jawaban upgrade WebSocket
function upgrade(d, secure, p, headers = {}) {
  return new Promise(resolve => {
    const r = (secure ? https : http).request({ host: '127.0.0.1', port: secure ? d.tlsPort : d.port, path: p, rejectUnauthorized: false, headers: {
      Host: secure ? 'office.test' : `127.0.0.1:${d.port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    r.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    r.on('response', res => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0));
    r.end();
  });
}

let single, akun;
before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=office.test', '-addext', 'subjectAltName=DNS:office.test,IP:127.0.0.1'], { stdio: 'ignore' });
  [single, akun] = await Promise.all([daemon('tunggal'), daemon('akun', { akun: { enabled: true, names: ['kantor.test'] } })]);
});

const B = { Authorization: 'Bearer tok' };

test('loopback: host remote dengan token config hanya lewat listener HTTP lokal', async () => {
  assert.equal(await upgrade(single, false, '/api/remote/host', B), 101);
  assert.equal(await upgrade(single, true, '/api/remote/host', B), 403, 'TLS dari 127.0.0.1 = passthrough / tunnel');
  assert.equal(await upgrade(single, false, '/api/remote/host', { ...B, 'X-Forwarded-For': '100.64.0.9' }), 403);
  // di luar remote, mode tunggal tidak berubah: token config berlaku dari mana pun
  assert.equal(await call(single, true, '/api/state', B), 200);
});

test('loopback: mode akun, token config (SYSTEM) tidak berlaku lewat listener TLS', async () => {
  assert.equal(await call(akun, false, '/api/state', B), 200);
  assert.equal(await call(akun, true, '/api/state', B), 401);
  assert.equal(await call(akun, false, '/api/state', { ...B, 'X-Real-IP': '100.64.0.9' }), 401);
  assert.equal(await upgrade(akun, false, '/api/remote/host', B), 101);
  assert.equal(await upgrade(akun, true, '/api/remote/host', B), 401);
});
