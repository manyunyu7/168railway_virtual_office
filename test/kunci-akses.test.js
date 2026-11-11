// Token mesin (hook/MCP dari Mac lain) dan skrip yang jalan di Mac itu. Lihat docs/MULTI-PC.md bagian Auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kunci-'));
const TOK = 'kcm_tokenmesinuntuktes0123456789abcdef';
const TOK4 = 'kcmesin_tokenmesinempat0123456789abcdef'; // awalan baru; TOK meniru token mesin lama (kcm_)
const MACHINES = [
  { id: 'mac-dua', name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.test:{PORT}', token: TOK },
  { id: 'mac-tiga', name: 'Mac Tiga', ssh: 'local:', hubUrl: 'http://hub3.test', token: 'kcm_mesinmati', disabled: true },
  { id: 'mac-empat', name: 'Mac Empat', ssh: 'local:', hubUrl: 'http://hub.test:{PORT}', token: TOK4 },
];

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const daemons = [];
async function startDaemon(name, extra = {}) {
  const port = await freePort();
  const home = path.join(tmp, name, 'home'), root = path.join(tmp, name, 'Developer');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'kt/api'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'kt/api') });
  const machines = MACHINES.map(m => ({ ...m, hubUrl: m.hubUrl.replace('{PORT}', port) }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [root], token: 'tok', port, machines, sysmon: { enabled: false }, ...extra }));
  const d = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; d.stderr.on('data', c => { err += c; });
  daemons.push(d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/state'); return { port, base, home, cwd: path.join(root, 'kt/api') }; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('daemon tidak jalan: ' + err);
}

// fetch tidak bisa mengganti header Host, jadi pakai node:http
function req(d, p, { method = 'GET', token, host, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: d.port, path: p, method, headers: {
      Host: host || `127.0.0.1:${d.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers,
    } }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => { s += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json, text: s }); });
    });
    r.on('error', reject);
    r.end(data);
  });
}
// status jawaban upgrade WebSocket (401/403) atau 101
function wsStatus(d, p, token) {
  return new Promise(resolve => {
    const s = net.connect(d.port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`));
    let buf = ''; s.on('data', c => { buf += c; const m = /^HTTP\/1\.1 (\d+)/.exec(buf); if (m) { resolve(Number(m[1])); s.destroy(); } });
    s.on('error', () => resolve(0)); s.on('close', () => resolve(0));
  });
}

let one, akunD;
before(async () => { [one, akunD] = await Promise.all([startDaemon('tunggal'), startDaemon('akun', { akun: { enabled: true, names: ['kantor.test'] } })]); });
after(() => { for (const d of daemons) d.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('actor: stampHook membuang kantor_machine dari body dan mengisinya dari token mesin', async () => {
  const { stampHook, machineActor } = await import('../server/actor.js');
  const a = machineActor('mac-dua', 'Mac Dua', '100.1.2.3');
  assert.deepEqual([a.kind, a.machine, a.name, a.id], ['machine', 'mac-dua', 'Mesin Mac Dua', null]);
  assert.deepEqual(stampHook({ x: 1, kantor_machine: 'palsu', kantor_tty: '/dev/ttys001' }, { kind: 'local' }), { x: 1, kantor_tty: '/dev/ttys001' });
  assert.deepEqual(stampHook({ x: 1, kantor_machine: 'palsu', kantor_tty: '/dev/ttys001' }, a), { x: 1, kantor_machine: 'mac-dua' });
  assert.equal(stampHook(null, a), null);
});

for (const mode of ['tunggal', 'akun']) {
  test(`token mesin (mode ${mode}): hanya hook, agen, dan limit; sisanya 403`, async () => {
    const d = mode === 'tunggal' ? one : akunD;
    // diizinkan, juga lewat Host nama hub dari hubUrl
    for (const host of [undefined, `hub.test:${d.port}`]) {
      const h = await req(d, '/api/hook', { method: 'POST', token: TOK, host, body: { session_id: `rem-${mode}-${host ? 1 : 0}`, hook_event_name: 'Notification', cwd: d.cwd } });
      assert.equal(h.status, 200, `hook via ${host || 'loopback'}: ${h.text}`);
    }
    const tools = await req(d, '/api/agent/tools', { token: TOK });
    assert.equal(tools.status, 200);
    assert.ok(Array.isArray(tools.json.tools) && tools.json.tools.length > 5);
    assert.equal((await req(d, '/api/usage/limits/claude', { method: 'POST', token: TOK, body: { rate_limits: {} } })).status, 200);
    // ditolak: API lain, file statis, WebSocket
    for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/settings'], ['GET', '/api/machines'], ['GET', '/api/audit'], ['POST', '/api/hooks/install']]) {
      const r = await req(d, p, { method: m, token: TOK, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    }
    assert.equal((await req(d, '/', { token: TOK })).status, 403);
    assert.equal((await req(d, '/app.js', { token: TOK })).status, 403);
    assert.equal(await wsStatus(d, '/ws', TOK), 403);
    assert.equal(await wsStatus(d, '/ws/term?sid=x', TOK), 403);
    // mesin nonaktif, token salah, host asing
    assert.equal((await req(d, '/api/agent/tools', { token: 'kcm_mesinmati' })).status, 401);
    assert.equal((await req(d, '/api/agent/tools', { token: 'kcm_salah' })).status, 401);
    assert.equal((await req(d, '/api/agent/tools', { token: TOK, host: 'evil.test' })).status, 401);
    // host hubUrl mesin nonaktif tetap host kantor, tapi tidak membuka apa-apa tanpa token
    assert.equal((await req(d, '/api/state', { host: 'hub3.test' })).status, 401);
  });
}

test('token lokal tetap seperti dulu, dan host hubUrl ikut diterima', async () => {
  assert.equal((await req(one, '/api/state', { token: 'tok' })).status, 200);
  assert.equal((await req(one, '/api/state', { token: 'tok', host: `hub.test:${one.port}` })).status, 200);
  assert.equal((await req(one, '/api/state', { token: 'tok', host: 'hub.test:1' })).status, 401, 'port lain bukan hub ini');
  assert.equal(await wsStatus(one, '/ws', 'tok'), 101);
  // mode akun: token config hanya dari loopback, tetap boleh hook
  assert.equal((await req(akunD, '/api/agent/tools', { token: 'tok' })).status, 200);
});

test('hook: kantor_machine palsu dibuang, tty mesin dibuang, sesi milik mesin lain ditolak', async () => {
  const sess = async sid => (await req(one, '/api/offices/kt', { token: 'tok' })).json?.sessions?.find(s => s.sid === sid);
  // token lokal memalsukan kantor_machine → sesi tetap lokal
  const loc = await req(one, '/api/hook', { method: 'POST', token: 'tok', body: { session_id: 'lokal-1', hook_event_name: 'SessionStart', cwd: one.cwd, kantor_machine: 'mac-dua', kantor_tty: '/dev/ttys009' } });
  assert.equal(loc.status, 200, loc.text);
  const s1 = await sess('lokal-1');
  assert.ok(s1, 'sesi lokal tercatat di kantor kt');
  assert.equal(s1.machine ?? null, null);
  assert.equal(s1.tty, '/dev/ttys009', 'tty lokal tetap dipakai');
  // ruangan kt di mac-dua (transport local:, jadi foldernya di Mac ini)
  const remoteDir = path.join(tmp, 'mac-dua-repo');
  fs.mkdirSync(remoteDir, { recursive: true });
  const room = await req(one, '/api/offices/kt/rooms', { method: 'POST', token: 'tok', body: { name: 'BE Remote', kind: 'kode', machine: 'mac-dua', remotePath: remoteDir } });
  assert.equal(room.status, 200, room.text);
  // token mesin: kantor_machine dari token (bukan 'mac-tiga' dari body), tty dibuang
  const rem = await req(one, '/api/hook', { method: 'POST', token: TOK, body: { session_id: 'remote-1', hook_event_name: 'SessionStart', cwd: remoteDir, kantor_tty: '/dev/ttys004', kantor_machine: 'mac-tiga' } });
  assert.equal(rem.status, 200, rem.text);
  const s2 = await sess('remote-1');
  assert.ok(s2, 'sesi remote tercatat di ruangan mesin');
  assert.equal(s2.machine, 'mac-dua');
  assert.equal(s2.tty ?? null, null);
  // sesi milik mesin sendiri boleh: hook berikutnya dan agent/call (kantor dari sesi, bukan body)
  assert.equal((await req(one, '/api/hook', { method: 'POST', token: TOK, body: { session_id: 'remote-1', hook_event_name: 'Stop', cwd: remoteDir } })).status, 200);
  const own = await req(one, '/api/agent/call', { method: 'POST', token: TOK, body: { sid: 'remote-1', office: 'kantor-lain', tool: 'notes_list', args: {} } });
  assert.equal(own.status, 200, own.text);
  // token mesin menyebut sesi lokal (session_id atau kantor_sid) → 403, dan sesinya tidak berubah
  for (const body of [{ session_id: 'lokal-1', hook_event_name: 'Stop' }, { session_id: 'baru-x', kantor_sid: 'lokal-1', hook_event_name: 'SessionStart' }]) {
    const r = await req(one, '/api/hook', { method: 'POST', token: TOK, body: { cwd: one.cwd, ...body } });
    assert.equal(r.status, 403, JSON.stringify(body));
  }
  // /api/agent/call dari token mesin dengan sid sesi lokal → 403; tanpa sid tetap diteruskan ke agen
  const c = await req(one, '/api/agent/call', { method: 'POST', token: TOK, body: { sid: 'lokal-1', tool: 'notes_list', args: {} } });
  assert.equal(c.status, 403);
  assert.match(c.json.error, /bukan milik mesin ini/);
  const c2 = await req(one, '/api/agent/call', { method: 'POST', token: TOK, body: { callerSid: 'lokal-1', tool: 'notes_list', args: {} } });
  assert.equal(c2.status, 403);
  const c3 = await req(one, '/api/agent/call', { method: 'POST', token: TOK, body: { office: 'kt', tool: 'notes_list', args: {} } });
  assert.equal(c3.status, 200, c3.text);
  // token lokal tidak terkena aturan mesin
  assert.equal((await req(one, '/api/agent/call', { method: 'POST', token: 'tok', body: { office: 'kt', sid: 'lokal-1', tool: 'notes_list', args: {} } })).status, 200);
});

/* ---------------- skrip di Mac 2 ---------------- */
// server tes kecil: mencatat permintaan, jawaban per path bisa diatur
function fakeHub({ tls } = {}) {
  const got = [];
  const answer = { '/api/hook': (b, res) => res.end('null') };
  const handler = (rq, res) => {
    let s = ''; rq.on('data', c => { s += c; });
    rq.on('end', () => {
      let b = null; try { b = JSON.parse(s); } catch {}
      got.push({ method: rq.method, path: rq.url, auth: rq.headers.authorization, host: rq.headers.host, body: b });
      const f = answer[rq.url];
      if (f) return f(b, res);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  };
  const srv = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, got, answer, url: `${tls ? 'https' : 'http'}://127.0.0.1:${srv.address().port}` })));
}
// KANTOR_HOME kosong: kalau skrip masih membaca server.json, tidak ada yang terkirim
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kunci-home-'));
after(() => fs.rmSync(emptyHome, { recursive: true, force: true }));
function runScript(file, input, env, args = []) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(REPO, file), ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KANTOR_HOME: emptyHome, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { err += c; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('kantor-hook.cjs: KANTOR_URL + KANTOR_TOKEN, tanpa server.json; tidak pernah memblokir', async () => {
  const hub = await fakeHub();
  const env = { KANTOR_URL: hub.url + '/', KANTOR_TOKEN: TOK, KANTOR_SID: 'shift-1' };
  const r = await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'hai' }, env);
  assert.equal(r.code, 0);
  assert.equal(hub.got.length, 1);
  const g = hub.got[0];
  assert.deepEqual([g.method, g.path, g.auth], ['POST', '/api/hook', `Bearer ${TOK}`]);
  assert.equal(g.body.kantor_sid, 'shift-1');
  assert.equal(g.body.kantor_tty, undefined, 'tty Mac 2 tidak dikirim');
  // PermissionRequest menunggu keputusan yang lama datang, lalu mencetaknya
  const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  hub.answer['/api/hook'] = (b, res) => setTimeout(() => res.end(JSON.stringify(decision)), 2000);
  const w = await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'PermissionRequest' }, env);
  assert.equal(w.code, 0);
  assert.ok(w.ms >= 1900, 'menunggu lebih lama dari batas 1,5 s hook biasa');
  assert.deepEqual(JSON.parse(w.out), decision);
  // hub lambat untuk hook biasa: menyerah setelah ±1,5 s, exit 0, tanpa output
  hub.answer['/api/hook'] = (b, res) => setTimeout(() => res.end('{"x":1}'), 4000);
  const slow = await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'PreToolUse' }, env);
  assert.deepEqual([slow.code, slow.out], [0, '']);
  assert.ok(slow.ms < 3500, `berhenti sendiri (${slow.ms} ms)`);
  // hub menolak (403) dan hub mati: exit 0 tanpa output
  hub.answer['/api/hook'] = (b, res) => { res.writeHead(403); res.end('{"error":"x"}'); };
  assert.deepEqual(Object.values((({ code, out }) => ({ code, out }))(await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'PreToolUse' }, env))), [0, '']);
  hub.srv.close();
  const dead = await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'PreToolUse' }, env);
  assert.deepEqual([dead.code, dead.out], [0, '']);
  // URL rusak: tetap exit 0
  assert.equal((await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'Stop' }, { KANTOR_URL: 'bukan url', KANTOR_TOKEN: TOK })).code, 0);
});

test('kantor-hook.cjs: tanpa env tetap memakai server.json lokal (dengan cek pid)', async () => {
  const hub = await fakeHub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kunci-loc-'));
  try {
    const port = Number(new URL(hub.url).port);
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port, token: 'loktok', pid: process.pid }));
    const r = await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'Stop' }, { KANTOR_HOME: home });
    assert.equal(r.code, 0);
    assert.equal(hub.got.length, 1);
    assert.deepEqual([hub.got[0].auth, hub.got[0].host], ['Bearer loktok', `127.0.0.1:${port}`]);
    // pid mati → tidak mengirim
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port, token: 'loktok', pid: 2 ** 22 + 12345 }));
    await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'Stop' }, { KANTOR_HOME: home });
    assert.equal(hub.got.length, 1);
  } finally { hub.srv.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('kantor-statusline.cjs: limit dikirim ke KANTOR_URL', async () => {
  const hub = await fakeHub();
  try {
    const rl = { five_hour: { used_percentage: 41.6 }, seven_day: { used_percentage: 7 } };
    const r = await runScript('hooks/kantor-statusline.cjs', { rate_limits: rl, model: { id: 'claude-opus-5-5' } }, { KANTOR_URL: hub.url, KANTOR_TOKEN: TOK });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), '5j 42% · 7h 7%');
    assert.equal(hub.got.length, 1);
    assert.deepEqual([hub.got[0].path, hub.got[0].auth], ['/api/usage/limits/claude', `Bearer ${TOK}`]);
    assert.deepEqual(hub.got[0].body.rate_limits, rl);
  } finally { hub.srv.close(); }
});

function mcpCall(env, msgs) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(REPO, 'server/mcp-stdio.js')], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KANTOR_HOME: emptyHome, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let buf = '';
    p.stdout.on('data', c => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (out.length >= msgs.length) { p.kill(); resolve(out); }
    });
    for (const m of msgs) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('mcp-stdio.js: tools/list dan tools/call ke KANTOR_URL dengan token mesin', async () => {
  const hub = await fakeHub();
  hub.answer['/api/agent/tools'] = (b, res) => res.end(JSON.stringify({ tools: [{ name: 'notes_list' }] }));
  hub.answer['/api/agent/call'] = (b, res) => res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok ' + b.tool }] }));
  try {
    const out = await mcpCall({ KANTOR_URL: hub.url, KANTOR_TOKEN: TOK, KANTOR_SID: 'shift-9', KANTOR_ROLE: 'be' }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notes_list', arguments: {} } },
    ]);
    const byId = Object.fromEntries(out.map(m => [m.id, m]));
    assert.deepEqual(byId[1].result.tools, [{ name: 'notes_list' }]);
    assert.equal(byId[2].result.content[0].text, 'ok notes_list');
    assert.ok(hub.got.every(g => g.auth === `Bearer ${TOK}`));
    const call = hub.got.find(g => g.path === '/api/agent/call');
    assert.deepEqual([call.body.sid, call.body.role], ['shift-9', 'be']);
  } finally { hub.srv.close(); }
});

test('https: hook dan MCP lewat hub ber-TLS (CA lewat NODE_EXTRA_CA_CERTS)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kunci-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch { return t.skip('openssl tidak tersedia'); }
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  const hub = await fakeHub({ tls: { key: fs.readFileSync(path.join(dir, 'key.pem')), cert } });
  hub.answer['/api/agent/tools'] = (b, res) => res.end(JSON.stringify({ tools: [] }));
  try {
    const env = { KANTOR_URL: hub.url, KANTOR_TOKEN: TOK, NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') };
    assert.equal((await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'Stop' }, env)).code, 0);
    await runScript('hooks/kantor-statusline.cjs', { rate_limits: { five_hour: { used_percentage: 1 } } }, env);
    const out = await mcpCall(env, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    assert.deepEqual(out[0].result.tools, []);
    assert.deepEqual(hub.got.map(g => g.path), ['/api/hook', '/api/usage/limits/claude', '/api/agent/tools']);
    // sertifikat tak dipercaya: hook tetap exit 0, tidak ada yang terkirim
    const before = hub.got.length;
    assert.equal((await runScript('hooks/kantor-hook.cjs', { session_id: 's', hook_event_name: 'Stop' }, { KANTOR_URL: hub.url, KANTOR_TOKEN: TOK })).code, 0);
    assert.equal(hub.got.length, before);
  } finally { hub.srv.close(); }
});

test('hook dari token mesin tidak bisa membajak sesi yang sudah tercatat (live atau DB)', async () => {
  const hook = (token, body) => req(one, '/api/hook', { method: 'POST', token, body: { hook_event_name: 'Stop', cwd: one.cwd, ...body } });
  // sesi milik mac-empat (hidup di memori daemon)
  assert.equal((await hook(TOK4, { session_id: 'empat-1', hook_event_name: 'SessionStart' })).status, 200);
  assert.equal((await hook(TOK4, { session_id: 'empat-1' })).status, 200, 'pemiliknya sendiri boleh');
  assert.equal((await hook(TOK, { session_id: 'empat-1' })).status, 403, 'mac-dua tidak boleh memakai sesi mac-empat');
  assert.equal((await hook(TOK, { session_id: 'baru-y', kantor_sid: 'empat-1', hook_event_name: 'SessionStart' })).status, 403, 'juga lewat kantor_sid');
  // sesi yang hanya ada di DB (mis. setelah daemon restart): lokal dan milik mesin lain
  const db = new DatabaseSync(path.join(one.home, 'kantor.db'));
  try {
    const ins = db.prepare('INSERT INTO sessions (sid, office, cwd, source, status, started_at, last_seen, machine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const at = new Date().toISOString();
    ins.run('db-lokal', 'kt', one.cwd, 'manual', 'ended', at, at, null);
    ins.run('db-empat', 'kt', one.cwd, 'kantor', 'ended', at, at, 'mac-empat');
  } finally { db.close(); }
  assert.equal((await hook(TOK, { session_id: 'db-lokal' })).status, 403, 'sesi lokal di DB');
  assert.equal((await hook(TOK, { session_id: 'db-empat' })).status, 403, 'sesi mesin lain di DB');
  assert.equal((await hook(TOK4, { session_id: 'db-empat' })).status, 200, 'pemiliknya boleh melanjutkan');
  // sesi baru yang belum dikenal tetap boleh; token lokal tidak terkena aturan ini
  assert.equal((await hook(TOK, { session_id: 'benar-benar-baru' })).status, 200);
  assert.equal((await hook('tok', { session_id: 'empat-1' })).status, 200);
});
