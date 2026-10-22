import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// isolated data dir + a fake projects root, set before any server module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-procs-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));
for (const d of ['lab/web', 'lab/api', 'lab/cms', 'lab/app', 'lab/py']) { fs.mkdirSync(path.join(root, d), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: path.join(root, d) }); }
const W = n => path.join(root, 'lab', n);
fs.writeFileSync(path.join(W('web'), 'package.json'), JSON.stringify({ scripts: { build: 'vite build', dev: 'vite', start: 'node .', test: 'vitest', preview: 'vite preview' } }));
fs.writeFileSync(path.join(W('web'), 'pnpm-lock.yaml'), '');
fs.writeFileSync(path.join(W('web'), 'Makefile'), 'VAR := 1\nrun:\n\techo\nbuild:\n\techo\ndev-all:\n\techo\n');
fs.writeFileSync(path.join(W('cms'), 'composer.json'), '{}'); fs.writeFileSync(path.join(W('cms'), 'artisan'), '');
fs.writeFileSync(path.join(W('app'), 'pubspec.yaml'), 'name: app');
fs.writeFileSync(path.join(W('py'), 'manage.py'), '');
fs.writeFileSync(path.join(W('api'), 'go.mod'), 'module api');
fs.mkdirSync(path.join(W('api'), 'cmd/server'), { recursive: true }); fs.writeFileSync(path.join(W('api'), 'cmd/server/main.go'), 'package main');

let pr, offices, tools, office, db;
const tmuxOk = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
before(async () => {
  offices = await import('../server/offices.js');
  pr = await import('../server/procs.js');
  tools = await import('../server/agent.js');
  db = await import('../server/db.js');
  office = offices.officeForCwd(W('web'));
});
after(() => {
  try { if (office) for (const p of pr.listProcs(office)) try { pr.removeProc(office, p.id); } catch {} } catch {}
  try { if (office) for (const t of pr.listTerms(office)) pr.closeTerm(office, t.name); } catch {}
  db.closeAll?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const roomOf = p => offices.officeModel(office).plan.rooms.find(r => r.path === p).id;
const cmds = d => pr.suggest(d).map(s => s.cmd);

test('suggest: package.json scripts, lockfile picks the runner', () => {
  assert.deepEqual(cmds(W('web')).filter(c => c.startsWith('pnpm')), ['pnpm run dev', 'pnpm run start', 'pnpm run preview']);
  assert.ok(!cmds(W('web')).some(c => /build|test/.test(c)));
});
test('suggest: Makefile run/dev targets only', () => {
  const c = cmds(W('web'));
  assert.ok(c.includes('make run') && c.includes('make dev-all') && !c.includes('make build'));
});
test('suggest: artisan, go, flutter, django', () => {
  assert.deepEqual(cmds(W('cms')), ['php artisan serve']);
  assert.deepEqual(cmds(W('api')), ['go run ./cmd/server']);
  assert.deepEqual(cmds(W('app')), ['flutter run -d chrome']);
  assert.deepEqual(cmds(W('py')), ['python manage.py runserver']);
  fs.writeFileSync(path.join(W('py'), 'go.mod'), 'module x');
  assert.ok(cmds(W('py')).includes('go run .'));
});

test('detectPort: vite, laravel, go, node, ANSI, timestamps ignored', () => {
  const d = t => pr.detectPort(t)?.port;
  assert.equal(d('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  Network: use --host'), 5173);
  assert.equal(pr.detectPort('Local: http://localhost:5173/app/').url, 'http://localhost:5173/app/');
  assert.equal(d('   INFO  Server running on [http://127.0.0.1:8000].'), 8000);
  assert.equal(pr.detectPort('Server running on [http://127.0.0.1:8000].').url, 'http://localhost:8000');
  assert.equal(d('2026/10/21 10:23:45 listening on :8080'), 8080);
  assert.equal(d('server listening on 0.0.0.0:9090'), 9090);
  assert.equal(d('Listening on port 3000'), 3000);
  assert.equal(d('Starting development server at http://127.0.0.1:8001/'), 8001);
  assert.equal(d('started at 10:23:45 and nothing else'), undefined);
  assert.equal(d('Local: http://localhost:3000\nNetwork: http://192.168.1.5:3000'), 3000);
  assert.equal(d('Port 3000 is in use, trying another one...\n  Local: http://localhost:3001/'), 3001);
});
test('stripAnsi: escapes out, carriage return keeps the last rewrite', () => {
  assert.equal(pr.stripAnsi('\x1b[31mmerah\x1b[0m\nprogress 10%\rprogress 100%\r\nok'), 'merah\nprogress 100%\nok');
});

test('registry: create / update / delete, validation, room check', () => {
  const room = roomOf('web');
  const a = pr.createProc(office, { room, name: 'Dev', cmd: 'npm run dev' });
  assert.equal(a.status, 'berhenti'); assert.equal(a.pending, false); assert.equal(a.roomName, 'Web');
  assert.throws(() => pr.createProc(office, { room, cmd: '  ' }), /Perintah/);
  assert.throws(() => pr.createProc(office, { room: 'tidak-ada', cmd: 'ls' }), /Ruangan/);
  const b = pr.updateProc(office, a.id, { name: 'Dev server', cmd: 'npm run dev -- --host' });
  assert.equal(b.name, 'Dev server'); assert.equal(b.cmd, 'npm run dev -- --host');
  assert.equal(pr.listProcs(office).length, 1);
  pr.removeProc(office, a.id);
  assert.equal(pr.listProcs(office).length, 0);
  assert.throws(() => pr.getProc(office, a.id), /tidak ditemukan/);
});

test('agent: registered runs, unregistered becomes a pending suggestion that does not run', { skip: !tmuxOk }, async () => {
  const room = roomOf('web');
  const out = await tools.callTool({ office }, 'proses_jalankan', { room: 'web', perintah: 'touch /tmp/kc-should-not-exist-' + process.pid });
  assert.match(out.content[0].text, /TIDAK dijalankan/);
  const list = JSON.parse((await tools.callTool({ office }, 'proses_list', {})).content[0].text);
  assert.equal(list.length, 1); assert.equal(list[0].menunggu_persetujuan, true); assert.equal(list[0].status, 'berhenti');
  // same command again: still pending, still not run; running it by id is refused too
  assert.match((await tools.callTool({ office }, 'proses_jalankan', { room, perintah: list[0].perintah })).content[0].text, /menunggu persetujuan/);
  assert.match((await tools.callTool({ office }, 'proses_jalankan', { id: list[0].id })).content[0].text, /menunggu persetujuan/);
  assert.throws(() => pr.startProc(office, list[0].id), /persetujuan/);
  assert.ok(!fs.existsSync('/tmp/kc-should-not-exist-' + process.pid));
  pr.approveProc(office, list[0].id);
  assert.equal(pr.getProc(office, list[0].id).pending, false);
  pr.removeProc(office, list[0].id);
});

test('process lifecycle in tmux: start, port from log, log tail, stop, failure exit code', { skip: !tmuxOk, timeout: 40000 }, async () => {
  const room = roomOf('web');
  const wait = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 150)); } };
  const p = pr.createProc(office, { room, name: 'Demo', cmd: `node -e "console.log('Local: http://localhost:4999'); setTimeout(()=>{},30000)"` });
  const v = pr.startProc(office, p.id);
  assert.equal(v.status, 'jalan');
  assert.ok(execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).includes(pr.sessName(office, p)));
  const up = await wait(() => { const x = pr.getProc(office, p.id); return x.port ? x : null; });
  assert.equal(up.port, 4999); assert.equal(up.url, 'http://localhost:4999');
  assert.match(pr.logLines(office, p.id, 10), /Local: http:\/\/localhost:4999/);
  assert.match((await tools.callTool({ office }, 'proses_log', { id: p.id })).content[0].text, /localhost:4999/);
  assert.equal(pr.readLog(office, p.id).next > 0, true);
  // "discovery after a daemon restart" = state comes from tmux alone
  assert.equal(pr.listProcs(office)[0].status, 'jalan');
  pr.stopProc(office, p.id);
  const down = await wait(() => { const x = pr.getProc(office, p.id); return x.status !== 'jalan' ? x : null; }, 12000);
  assert.equal(down.status, 'berhenti');
  // a crash is "gagal" with its exit code
  const f = pr.createProc(office, { room, name: 'Rusak', cmd: 'echo gagal-total; exit 3' });
  pr.startProc(office, f.id);
  const bad = await wait(() => { const x = pr.getProc(office, f.id); return x.status === 'gagal' ? x : null; });
  assert.equal(bad.code, 3);
  assert.match(pr.logLines(office, f.id), /gagal-total/);
  pr.removeProc(office, p.id); pr.removeProc(office, f.id);
});

test('dock terminals: create, rename, list, close', { skip: !tmuxOk }, () => {
  const room = roomOf('api');
  const t = pr.createTerm(office, room);
  assert.match(t.name, /^kct-lab-[0-9a-f]{6}$/); assert.equal(t.title, 'Api');
  assert.equal(pr.dockSessionOk(t.name), true);
  assert.equal(pr.dockSessionOk('kc-lab-manager'), false);
  assert.equal(pr.renameTerm(office, t.name, 'Server').title, 'Server');
  assert.deepEqual(pr.listTerms(office).map(x => x.title), ['Server']);
  assert.equal(pr.createTerm(office, room).title, 'Api');
  pr.closeTerm(office, t.name);
  for (const x of pr.listTerms(office)) pr.closeTerm(office, x.name);
  assert.equal(pr.listTerms(office).length, 0);
});
