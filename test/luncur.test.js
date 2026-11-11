// Shift di Mac lain lewat transport 'local:' dengan tmux, claude, dan codex palsu (tidak ada agen sungguhan yang jalan).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-luncur-')));
const home = path.join(tmp, 'home'), fake = path.join(tmp, 'bin');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(fake, { recursive: true });
process.env.KANTOR_HOME = path.join(tmp, 'kantor');
process.env.HOME = home;
process.env.ZDOTDIR = home; // probe memakai zsh -l: .zprofile di sini menaruh bin palsu paling depan
fs.writeFileSync(path.join(home, '.zprofile'), `export PATH=${fake}:$PATH\n`);
const LOG = process.env.FAKE_TMUX_LOG = path.join(tmp, 'tmux.log');
const STATE = process.env.FAKE_TMUX_STATE = path.join(tmp, 'tmux.state');
fs.writeFileSync(path.join(fake, 'tmux'), `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), st = process.env.FAKE_TMUX_STATE;
fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(a) + '\\n');
const names = () => { try { return fs.readFileSync(st, 'utf8').split('\\n').filter(Boolean); } catch { return []; } };
if (a[0] === 'list-sessions') { const n = names(); if (!n.length) { process.stderr.write('no server running on /tmp/tmux-0/default\\n'); process.exit(1); } process.stdout.write(n.join('\\n') + '\\n'); }
else if (a[0] === 'new-session') fs.writeFileSync(st, [...names(), a[a.indexOf('-s') + 1]].join('\\n') + '\\n');
else if (a[0] === 'kill-session') fs.writeFileSync(st, names().filter(n => n !== a[a.indexOf('-t') + 1]).join('\\n') + '\\n');
`, { mode: 0o755 });
for (const b of ['claude', 'codex']) fs.writeFileSync(path.join(fake, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const mx = await import('../server/machines.js');
const db = await import('../server/db.js');
const offices = await import('../server/offices.js');
const { createRole } = await import('../server/store.js');
const { live, expectSession } = await import('../server/live.js');
const T = await import('../server/tmux.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tmuxCalls = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const setTmux = names => fs.writeFileSync(STATE, names.map(n => n + '\n').join(''));

// Mac "kedua": folder repo dan skrip kantor yang sudah dipasang
const repo = path.join(tmp, 'mac2', 'be');
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'awal');
const mac = mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.test:4317' });
const token = mx.getMachine(mac.id).token;
const root = mx.machineRoot(mac.id);
for (const f of ['server/mcp-stdio.js', 'hooks/kantor-hook.cjs', 'hooks/kantor-statusline.cjs']) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), '//'); }

const officeRoot = path.join(tmp, 'kantor-repo');
fs.mkdirSync(officeRoot);
const oid = offices.registerOffice(officeRoot);
const room = offices.addRoom(oid, { name: 'Backend', machine: mac.id, remotePath: repo });
const roomId = room?.id || offices.officeModel(oid).plan.rooms.find(r => r.machine === mac.id).id;
const be = createRole(oid, { name: 'Bima', title: 'Backend', room: roomId });
const cx = createRole(oid, { name: 'Citra', title: 'Backend Codex', room: roomId, engine: 'codex' });
const ag = createRole(oid, { name: 'Gita', title: 'Gemini', room: roomId, engine: 'antigravity' });

test('roomPlace: ruangan remote memberi mesin dan path remote, ruangan lokal tetap seperti dulu', () => {
  const m = offices.officeModel(oid);
  assert.deepEqual(T.roomPlace(m, m.plan.rooms.find(r => r.id === roomId)), { machine: mac.id, cwd: repo });
  const local = T.roomPlace(m, null);
  assert.equal(local.machine, null);
  assert.equal(local.cwd, m.root);
});

test('startShift Claude di Mac lain: file run di machineRunDir, env pane berisi token mesin, tanpa KANTOR_HOME', () => {
  fs.rmSync(LOG, { force: true });
  const r = T.startShift(oid, be.id, { task: 'Cek API' });
  const run = mx.machineRunDir(mac.id);
  const node = mx.ensureProbed(mac.id).node;
  const mcp = JSON.parse(fs.readFileSync(path.join(run, `${r.sid}.mcp.json`), 'utf8')).mcpServers.kantor;
  assert.equal(mcp.command, node);
  assert.deepEqual(mcp.args, [path.join(root, 'server', 'mcp-stdio.js')]);
  assert.deepEqual(mcp.env, { KANTOR_SID: r.sid, KANTOR_URL: 'http://hub.test:4317', KANTOR_TOKEN: token, KANTOR_MACHINE: mac.id, KANTOR_OFFICE: oid, KANTOR_ROLE: be.id });
  const set = JSON.parse(fs.readFileSync(path.join(run, `${r.sid}.settings.json`), 'utf8'));
  assert.ok(set.hooks.Stop[0].hooks[0].command.includes(path.join(root, 'hooks', 'kantor-hook.cjs')));
  assert.ok(set.hooks.Stop[0].hooks[0].command.startsWith(`'${node}'`));
  assert.ok(set.statusLine.command.includes(path.join(root, 'hooks', 'kantor-statusline.cjs')));
  assert.ok(fs.readFileSync(path.join(run, `${r.sid}.prompt.md`), 'utf8').includes('di Mac **Mac Dua**'));
  assert.ok(!fs.existsSync(path.join(process.env.KANTOR_HOME, 'run', `${r.sid}.mcp.json`)), 'tidak ditulis ke RUN_DIR lokal');

  const ns = tmuxCalls().find(a => a[0] === 'new-session');
  assert.equal(ns[ns.indexOf('-s') + 1], r.tmux);
  assert.equal(ns[ns.indexOf('-c') + 1], repo);
  for (const e of [`KANTOR_SID=${r.sid}`, 'KANTOR_URL=http://hub.test:4317', `KANTOR_MACHINE=${mac.id}`]) assert.ok(ns.includes(e), e);
  assert.ok(!ns.some(a => a.includes('KANTOR_HOME')));
  assert.ok(!JSON.stringify(ns).includes(token), 'token tidak ada di argv tmux/ssh');
  const envFile = path.join(run, `${r.sid}.env`);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const envTxt = fs.readFileSync(envFile, 'utf8');
  for (const l of [`KANTOR_TOKEN='${token}'`, `KANTOR_SID='${r.sid}'`, "KANTOR_URL='http://hub.test:4317'", `KANTOR_MACHINE='${mac.id}'`]) assert.ok(envTxt.includes(l), l);
  // file env benar-benar terbaca oleh sh: set -a mengekspor semuanya
  assert.equal(execFileSync('/bin/sh', ['-c', `set -a; . '${envFile}'; set +a; sh -c 'echo $KANTOR_TOKEN'`], { encoding: 'utf8' }).trim(), token);
  const cmd = ns[ns.length - 1];
  assert.ok(cmd.startsWith(`set -a; . '${envFile}'; set +a; exec '${path.join(fake, 'claude')}'`), cmd);
  assert.ok(cmd.includes(path.join(run, `${r.sid}.mcp.json`)));
  assert.ok(tmuxCalls().some(a => a[0] === 'set-option' && a.includes(r.tmux)), 'set-option ikut ke mesin itu');

  const s = live.get(r.sid);
  assert.equal(s.machine, mac.id);
  assert.equal(s.cwd, repo);
  assert.equal(mx.tmuxMachineOf(r.tmux), mac.id);
  assert.equal(db.one(db.globalDb(), 'SELECT machine FROM sessions WHERE sid = ?', r.sid).machine, mac.id);
});

test('slot kedua dengan worktree: git worktree dibuat lewat mesin itu', () => {
  const r = T.startShift(oid, be.id, { worktree: true });
  assert.equal(r.slot, 1);
  const wt = path.join(path.dirname(repo), `be-kc-${be.id}-2`);
  assert.ok(fs.existsSync(path.join(wt, '.git')));
  assert.equal(live.get(r.sid).cwd, wt);
});

test('startShift Codex di Mac lain: hook dan MCP lewat -c menunjuk ke skrip di mesin itu', () => {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-remote"\nmodel_reasoning_effort = "high"\n');
  fs.rmSync(LOG, { force: true });
  const r = T.startShift(oid, cx.id, { task: 'Tulis tes' });
  assert.equal(r.engine, 'codex');
  const script = fs.readFileSync(path.join(mx.machineRunDir(mac.id), `${r.sid}.codex.sh`), 'utf8');
  assert.ok(!script.includes(token), 'token tidak ada di skrip maupun argv codex');
  assert.ok(script.includes(`set -a; . '${path.join(mx.machineRunDir(mac.id), `${r.sid}.env`)}'; set +a`));
  assert.ok(fs.readFileSync(path.join(mx.machineRunDir(mac.id), `${r.sid}.env`), 'utf8').includes(`KANTOR_TOKEN='${token}'`));
  assert.ok(script.includes(`export KANTOR_URL='http://hub.test:4317'`));
  assert.ok(!script.includes('KANTOR_HOME'));
  assert.ok(script.includes(`exec '${path.join(fake, 'codex')}'`));
  assert.ok(script.includes(path.join(root, 'hooks', 'kantor-hook.cjs')));
  assert.ok(script.includes(path.join(root, 'server', 'mcp-stdio.js')));
  assert.ok(script.includes('env_vars=["KANTOR_TOKEN"]'), 'token diteruskan ke MCP lewat env_vars');
  const ns = tmuxCalls().find(a => a[0] === 'new-session');
  assert.ok(ns.includes('KANTOR_ENGINE=codex') && ns.includes(`KANTOR_MACHINE=${mac.id}`));
  assert.ok(!JSON.stringify(tmuxCalls()).includes(token));
  const s = live.get(r.sid);
  assert.equal(s.machine, mac.id);
  assert.equal(s.model, 'gpt-remote', 'model bawaan dibaca dari config.toml di mesin itu');
  assert.equal(s.effort, 'high');
});

test('Antigravity di Mac lain ditolak dengan pesan jelas', () => {
  assert.throws(() => T.startShift(oid, ag.id), /Antigravity belum bisa jalan di Mac lain/);
});

test('mesin dinonaktifkan, skrip belum dipasang, folder hilang: pesan jelas', () => {
  mx.updateMachine(mac.id, { disabled: true });
  try { assert.throws(() => T.startShift(oid, be.id), /Mac Mac Dua sedang offline/); }
  finally { mx.updateMachine(mac.id, { disabled: false }); }
  const hook = path.join(root, 'hooks', 'kantor-hook.cjs');
  fs.renameSync(hook, hook + '.x');
  try { assert.throws(() => T.startShift(oid, be.id), /Skrip kantor belum terpasang di Mac Mac Dua/); }
  finally { fs.renameSync(hook + '.x', hook); }
});

test('sessionAction ke sesi remote lewat tmux mesin itu; adoptSession ditolak', async () => {
  const s = [...live.values()].find(x => x.role === be.id && x.slot === 0);
  fs.rmSync(LOG, { force: true });
  await T.sessionAction(s.sid, 'text', 'halo');
  assert.ok(tmuxCalls().some(a => a[0] === 'send-keys' && a.includes(s.tmux) && a.includes('halo')));
  await assert.rejects(T.adoptSession(s.sid), /jalan di Mac Mac Dua/);
  // tmux-nya hilang di mesin yang online: aksi teks memberi pesan jelas, bukan jalur Terminal
  setTmux(fs.readFileSync(STATE, 'utf8').split('\n').filter(n => n && n !== s.tmux));
  mx.invalidateTmuxList(mac.id);
  await assert.rejects(T.sessionAction(s.sid, 'text', 'halo'), /tmux-nya sudah tidak ada di sana/);
});

test('adoptRemote: ambil lagi yang tmux-nya ada, akhiri yang hilang; reapRemote hanya mesin itu', () => {
  live.clear();
  const old = new Date(Date.now() - 120e3).toISOString();
  for (const [sid, tm] of [['r-ada', 'kc-x-ada'], ['r-hilang', 'kc-x-hilang']]) {
    expectSession({ sid, office: oid, role: be.id, room: roomId, cwd: repo, tmux: tm, machine: mac.id });
    db.run(db.globalDb(), 'UPDATE sessions SET started_at = ?, last_seen = ?, transcript = ? WHERE sid = ?', old, old, mx.mirrorPath(mac.id, `/r/${sid}.jsonl`), sid);
  }
  live.clear();
  setTmux(['kc-x-ada']);
  assert.deepEqual(T.adoptRemote(mac.id), { adopted: 1, ended: 1 });
  const s = live.get('r-ada');
  assert.equal(s.status, 'idle');
  assert.equal(s.machine, mac.id);
  assert.equal(s.transcript, mx.mirrorPath(mac.id, '/r/r-ada.jsonl'));
  assert.ok(db.one(db.globalDb(), "SELECT ended_at FROM sessions WHERE sid = 'r-hilang'").ended_at);
  // putaran berikutnya tidak menyetel ulang sesi yang sudah dipegang
  s.status = 'working';
  assert.deepEqual(T.adoptRemote(mac.id), { adopted: 0, ended: 0 });
  assert.equal(s.status, 'working');

  // sesi lokal tidak disentuh reapRemote
  expectSession({ sid: 'l-1', office: oid, role: be.id, room: null, cwd: officeRoot, tmux: 'kc-lokal' });
  live.get('l-1').startedAt = old; s.startedAt = old;
  setTmux([]);
  assert.equal(T.reapRemote(mac.id), 1);
  assert.equal(s.status, 'ended');
  assert.equal(live.get('l-1').status, 'starting');
});

test('ATURAN KERAS: sesi di mesin offline tidak pernah diakhiri', () => {
  const dead = mx.addMachine({ name: 'Mac Mati', ssh: 'kc-test@nonexistent.invalid', hubUrl: 'http://hub.test:4317' });
  const old = new Date(Date.now() - 120e3).toISOString();
  expectSession({ sid: 'off-1', office: oid, role: be.id, room: roomId, cwd: '/x', tmux: 'kc-off-1', machine: dead.id });
  live.get('off-1').startedAt = old;
  db.run(db.globalDb(), 'UPDATE sessions SET started_at = ? WHERE sid = ?', old, 'off-1');
  assert.equal(T.adoptRemote(dead.id), null);
  assert.equal(T.reapRemote(dead.id), 0);
  assert.ok(mx.isOffline(dead.id));
  T.reapGoneTmux([]); // daftar tmux lokal kosong tidak menyentuh sesi remote
  assert.notEqual(live.get('off-1').status, 'ended');
  assert.equal(db.one(db.globalDb(), "SELECT ended_at FROM sessions WHERE sid = 'off-1'").ended_at, null);
  // aksi ke sesi di mesin offline: pesan offline, sesi tetap hidup
  return assert.rejects(T.sessionAction('off-1', 'kill'), /Mac Mac Mati sedang offline/).then(() => assert.notEqual(live.get('off-1').status, 'ended'));
});

test('mesin offline: hasTmux, sessionAction, dan ensureShell langsung menolak tanpa ssh', async () => {
  const dead = mx.listMachines().find(m => m.name === 'Mac Mati');
  assert.ok(mx.isOffline(dead.id));
  mx.setTmuxMachine('kc-off-1', dead.id);
  const t0 = Date.now();
  assert.equal(T.hasTmux('kc-off-1'), false);
  await assert.rejects(T.sessionAction('off-1', 'text', 'halo'), /Mac Mac Mati sedang offline/);
  assert.ok(Date.now() - t0 < 500, 'tidak menunggu ssh');
  assert.equal(T.adoptRemote(dead.id), null);
  assert.equal(T.reapRemote(dead.id), 0);
  const rid = roomId; // ruangan Backend di Mac Dua
  mx.updateMachine(mac.id, { disabled: true });
  try { assert.throws(() => T.ensureShell(oid, rid), /Mac Mac Dua sedang offline/); }
  finally { mx.updateMachine(mac.id, { disabled: false }); }
});

test('resume lintas mesin (Claude): transkrip dibawa ke ~/.claude/projects mesin tujuan dengan folder cwd yang sama', async () => {
  const tm = await import('../server/tmux.js');
  const src = path.join(home, 'asal', 'abc.jsonl');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"type":"user"}\n{"type":"assistant"}\n');
  const id = mx.addMachine({ name: 'Mac Tujuan', ssh: 'local:', hubUrl: 'http://hub.test:4317' }).id;
  const cwd = '/Users/x/Developer/168Railway/web';
  const dest = tm.carryClaudeTranscript({ transcript: src, machine: null }, 'abc', id, cwd);
  assert.equal(dest, path.join(mx.machineHome(id), '.claude', 'projects', '-Users-x-Developer-168Railway-web', 'abc.jsonl'));
  assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'));
  fs.rmSync(dest);
});
