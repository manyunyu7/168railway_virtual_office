import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// isolated data dir + a fake projects root, set before any server module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', approvals: { holdKantorSec: 2, holdManualSec: 0 } }));
for (const d of ['shop/api', 'shop/app', 'shop/app-wt']) fs.mkdirSync(path.join(root, d), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'shop/api') });
execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'shop/app') });
fs.writeFileSync(path.join(root, 'shop/app/pubspec.yaml'), 'name: app');
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.writeFileSync(path.join(root, 'shop/app-wt/.git'), `gitdir: ${path.join(root, 'shop/app/.git/worktrees/app-wt')}\n`);

let offices, live, store, pricing, layout;
before(async () => {
  offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  pricing = await import('../server/pricing.js');
  layout = await import('../server/layout.js');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('pricing: opus 5.5 with 1h cache writes and reads', () => {
  const usd = pricing.costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } });
  assert.equal(Math.round(usd * 100) / 100, 4 + 20 + 0.2 + 8);
  assert.equal(pricing.priceFor('claude-sonnet-4-5-20250929').input, 3);
  assert.equal(pricing.costOf('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1e6, speed: 'fast' }), 1);
});

test('office detection: repos become rooms, worktree attaches to its repo', () => {
  const id = offices.officeForCwd(path.join(root, 'shop/app/lib'));
  assert.equal(id, 'shop');
  const m = offices.officeModel(id);
  const app = m.plan.rooms.find(r => r.path === 'app');
  assert.ok(app, 'app room exists');
  assert.equal(app.stack, 'Flutter');
  assert.deepEqual(app.worktrees, ['app-wt']);
  assert.equal(offices.roomForCwd(m, path.join(root, 'shop/app-wt/src')).room, app.id);
  assert.equal(offices.roomForCwd(m, path.join(root, 'shop/app-wt')).worktree, 'app-wt');
  assert.ok(m.plan.rooms.some(r => r.kind === 'lobby'));
  assert.equal(store.listRoles(id).length, 2, 'manager + generalis seeded');
});

test('layout: rooms never overlap except on shared walls', () => {
  const plan = layout.autoLayout(Array.from({ length: 9 }, (_, i) => ({ id: 'r' + i, name: 'R' + i, kind: 'kode', desks: 2 })));
  const rooms = plan.rooms;
  for (const a of rooms) for (const b of rooms) {
    if (a === b) continue;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    assert.ok(ox <= 1 || oy <= 1, `${a.id} overlaps ${b.id}`);
  }
  assert.ok(rooms.every(r => r.x + r.w <= plan.w && r.y + r.h <= plan.h));
});

test('user-added room appears in the plan and maps cwd', () => {
  const rid = offices.addRoom('shop', { name: 'Docs Baru', kind: 'kode', path: 'docs-baru', create: true });
  const m = offices.officeModel('shop');
  assert.ok(m.plan.rooms.find(r => r.id === rid));
  assert.equal(offices.roomForCwd(m, path.join(root, 'shop/docs-baru')).room, rid);
  assert.throws(() => offices.addRoom('shop', { name: 'X', path: '../luar' }));
});

test('hooks: session lifecycle, tool, subagent', async () => {
  const sid = 'sess-1', cwd = path.join(root, 'shop/api');
  await live.handleHook({ session_id: sid, hook_event_name: 'SessionStart', cwd, source: 'startup' });
  await live.handleHook({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd, prompt: 'perbaiki bug login' });
  await live.handleHook({ session_id: sid, hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'go test ./...' }, tool_use_id: 't1' });
  let s = live.live.get(sid);
  assert.equal(s.office, 'shop');
  assert.equal(s.status, 'working');
  assert.equal(s.tool.label, 'go test ./...');
  await live.handleHook({ session_id: sid, hook_event_name: 'PreToolUse', cwd, tool_name: 'Task', tool_input: { subagent_type: 'Explore', description: 'cari handler' }, tool_use_id: 't2' });
  await live.handleHook({ session_id: sid, hook_event_name: 'SubagentStart', cwd, agent_id: 'a1', agent_type: 'Explore' });
  await live.handleHook({ session_id: sid, hook_event_name: 'PreToolUse', cwd, agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'login' }, tool_use_id: 't3' });
  s = live.live.get(sid);
  const sub = s.subs.get('a1');
  assert.equal(sub.desc, 'cari handler');
  assert.equal(sub.tool.name, 'Grep');
  assert.equal(s.tool.name, 'Task', 'subagent tools do not replace the main tool');
  await live.handleHook({ session_id: sid, hook_event_name: 'SubagentStop', cwd, agent_id: 'a1', agent_type: 'Explore', last_assistant_message: '3 temuan' });
  assert.equal(s.subs.get('a1').status, 'done');
  await live.handleHook({ session_id: sid, hook_event_name: 'Stop', cwd });
  assert.equal(s.status, 'idle');
});

test('a room for a nested folder wins over its parent room', () => {
  fs.mkdirSync(path.join(root, 'shop/app/admin'), { recursive: true });
  offices.addRoom('shop', { name: 'Admin', path: 'app/admin' });
  const m = offices.officeModel('shop');
  assert.equal(offices.roomForCwd(m, path.join(root, 'shop/app/admin/lib')).room, m.plan.rooms.find(r => r.path === 'app/admin').id);
  assert.equal(offices.roomForCwd(m, path.join(root, 'shop/app/lib')).room, m.plan.rooms.find(r => r.path === 'app').id);
});

test('wizard: a new multi-repo project gets folders, team, card and home page', async () => {
  const wz = await import('../server/wizard.js');
  const store2 = await import('../server/store.js');
  const team = [{ name: 'Bu Tes', title: 'Manager', isMgr: true, model: 'opus' }, { name: 'Andi', title: 'Backend', room: 'api' }, { name: 'Sinta', title: 'Mobile', room: 'app' }];
  const spec = { mode: 'new', base: root, name: 'Toko Baru', layout: 'multi', subs: ['api', 'app'], gitInit: true, claudeMd: true, description: 'Toko online kecil.', team, firstCard: true };
  const pv = wz.wizardPreview(spec);
  assert.deepEqual(pv.rooms.map(r => r.path).sort(), ['api', 'app']);
  assert.equal(pv.team.find(r => r.name === 'Andi').room, pv.rooms.find(r => r.path === 'api').id);
  const r = wz.wizardCreate(spec);
  assert.ok(fs.existsSync(path.join(root, 'toko-baru/api/.git')));
  assert.ok(fs.existsSync(path.join(root, 'toko-baru/CLAUDE.md')));
  const roles = store2.listRoles(r.id);
  assert.deepEqual(roles.map(x => x.name), ['Bu Tes', 'Andi', 'Sinta']);
  assert.equal(roles[0].isMgr, true);
  assert.equal(roles.find(x => x.name === 'Sinta').room, offices.officeModel(r.id).plan.rooms.find(x => x.path === 'app').id);
  assert.ok(r.card);
  assert.match(store2.getWiki ? store2.getWiki(r.id, 'beranda').body : '', /Toko online kecil/);
  assert.throws(() => wz.wizardCreate(spec), /sudah/);
  assert.throws(() => wz.wizardPreview({ ...spec, mode: 'existing', root: '/etc' }), /folder induk/);
});

test('files: stays inside the office, uploads never overwrite', async () => {
  const f = await import('../server/files.js');
  const { Readable } = await import('node:stream');
  fs.writeFileSync(path.join(root, 'shop/api/main.go'), 'package main\n');
  fs.symlinkSync('/etc', path.join(root, 'shop/api/escape'));
  const ls = f.listDir('shop', 'api');
  assert.ok(ls.entries.some(e => e.name === 'main.go' && !e.dir));
  assert.equal(f.readText('shop', 'api/main.go').text, 'package main\n');
  assert.throws(() => f.listDir('shop', '../..'), /luar/);
  assert.throws(() => f.readText('shop', 'api/escape/hosts'), /luar/);
  const req = body => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-length': String(body.length) } });
  const a = await f.upload('shop', 'api', 'catatan.txt', req('satu'));
  const b = await f.upload('shop', 'api', 'catatan.txt', req('dua'));
  assert.equal(a.path, 'api/catatan.txt');
  assert.equal(b.name, 'catatan (2).txt');
  assert.equal(fs.readFileSync(path.join(root, 'shop/api/catatan.txt'), 'utf8'), 'satu');
  const sneaky = await f.upload('shop', 'api', '../../x.txt', req('x'));
  assert.equal(path.dirname(sneaky.path), 'api', 'slashes in the name cannot climb out of the folder');
  assert.deepEqual(f.findFiles('shop', '', 'main').map(x => x.path), ['api/main.go']);
});

test('roles: a boss is recorded, cycles are refused, prompts name both sides', async () => {
  const tm = await import('../server/tmux.js');
  const db = await import('../server/db.js');
  const boss = store.createRole('shop', { name: 'Bayu', title: 'Laravel Dev', room: 'api' });
  const kid = store.createRole('shop', { name: 'Gilang', title: 'Asisten', room: 'api', reportsTo: boss.id });
  assert.equal(store.getRole('shop', kid.id).reportsTo, boss.id);
  assert.throws(() => store.updateRole('shop', boss.id, { reportsTo: kid.id }), /anak buahnya sendiri/);
  const row = id => db.one(db.officeDb('shop'), 'SELECT * FROM roles WHERE id = ?', id);
  assert.match(tm.rolePrompt('shop', row(kid.id)), /Atasanmu: \*\*Bayu\*\*/);
  assert.match(tm.rolePrompt('shop', row(boss.id)), /Anak buahmu: \*\*Gilang\*\*/);
});

test('/clear keeps the shift: the new session id takes over the pane', async () => {
  const db = await import('../server/db.js');
  const cwd = path.join(root, 'shop/api'), tmuxName = 'kc-shop-generalis';
  live.expectSession({ sid: 'shift-a', office: 'shop', role: 'generalis', room: 'api', cwd, tmux: tmuxName });
  db.run(db.officeDb('shop'), "INSERT INTO shifts (sid, role, started_at, cwd, tmux, status) VALUES (?, ?, ?, ?, ?, 'aktif')", 'shift-a', 'generalis', new Date().toISOString(), cwd, tmuxName);
  for (const [old, next] of [['shift-a', 'shift-b'], ['shift-b', 'shift-c']]) {
    await live.handleHook({ session_id: old, hook_event_name: 'SessionEnd', cwd, reason: 'clear', kantor_sid: 'shift-a' });
    await live.handleHook({ session_id: next, hook_event_name: 'SessionStart', cwd, source: 'clear', kantor_sid: 'shift-a' });
    const s = live.live.get(next);
    assert.equal(s.role, 'generalis');
    assert.equal(s.tmux, tmuxName);
    assert.equal(live.live.has(old), false, 'the old id leaves the floor');
    const shift = db.one(db.officeDb('shop'), 'SELECT sid, status, ended_at FROM shifts WHERE tmux = ?', tmuxName);
    assert.deepEqual({ ...shift }, { sid: next, status: 'aktif', ended_at: null });
  }
});

test('permission request: inbox decision returns allow JSON', async () => {
  const sid = 'sess-2', cwd = path.join(root, 'shop/app');
  live.expectSession({ sid, office: 'shop', role: 'generalis', room: 'app', cwd, tmux: 'kc-test' });
  const pending = live.handleHook({ session_id: sid, hook_event_name: 'PermissionRequest', cwd, tool_name: 'Bash', tool_input: { command: 'rsync -a x y:z' } });
  await new Promise(r => setTimeout(r, 50));
  const item = live.openInbox().find(i => i.sid === sid);
  assert.ok(item && item.held);
  live.decide(item.id, 'allow');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
});

test('permission request times out to the terminal', async () => {
  const sid = 'sess-3', cwd = path.join(root, 'shop/app');
  live.expectSession({ sid, office: 'shop', role: 'generalis', room: 'app', cwd, tmux: 'kc-test2' });
  const out = await live.handleHook({ session_id: sid, hook_event_name: 'PermissionRequest', cwd, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(out, null);
  assert.ok(!live.openInbox().some(i => i.sid === sid));
});

test('board: create, move, checklist, comment, history', () => {
  const c = store.createCard('shop', { title: 'Login error', checklist: ['reproduksi', 'perbaiki'], prio: 'P1' }, 'Kamu');
  assert.equal(c.col, 0);
  store.updateCard('shop', c.id, { col: 'Dikerjakan' }, 'Tari');
  store.checkItem('shop', c.id, { text: 'reproduksi', done: true }, 'Tari');
  store.commentCard('shop', c.id, 'sudah bisa direproduksi', 'Tari');
  const full = store.getCard('shop', c.id);
  assert.equal(full.colName, 'Dikerjakan');
  assert.equal(full.checklist.filter(x => x.done).length, 1);
  assert.equal(full.comments.length, 1);
  assert.ok(full.history.some(h => h.text.includes('Backlog → Dikerjakan')));
  assert.throws(() => store.updateCard('shop', c.id, { col: 'Entah' }, 'x'));
});

test('wiki: revisions, rename, backlinks, search', () => {
  store.saveWiki('shop', { title: 'Runbook Deploy', body: 'langkah 1' }, 'Kamu');
  store.saveWiki('shop', { title: 'Runbook Deploy', body: 'langkah 1\nlangkah 2', prevSlug: 'runbook-deploy' }, 'Tari');
  store.saveWiki('shop', { title: 'Catatan', body: 'lihat [[Runbook Deploy]]' }, 'Kamu');
  const p = store.getWiki('shop', 'Runbook Deploy');
  assert.equal(p.revs, 2);
  assert.deepEqual(p.backlinks.map(b => b.slug).sort(), ['beranda', 'catatan']);
  assert.equal(store.searchWiki('shop', 'langkah')[0].slug, 'runbook-deploy');
  store.saveWiki('shop', { title: 'Runbook Rilis', body: 'x', prevSlug: 'runbook-deploy' }, 'Kamu');
  assert.ok(store.getWiki('shop', 'runbook-rilis'));
  assert.equal(store.getWiki('shop', 'runbook-deploy'), null);
});

test('notes: tags, trash, to-card checklist parsing', () => {
  const n = store.saveNote('shop', { title: 'Ide', body: '- [ ] a\n- [x] b', tags: ['#Rilis', 'rilis', 'ux'] }, 'Kamu');
  assert.deepEqual(n.tags, ['rilis', 'ux']);
  store.saveNote('shop', { id: n.id, deleted: true }, 'Kamu');
  assert.equal(store.listNotes('shop').length, 0);
  assert.equal(store.listNotes('shop', { view: 'sampah' }).length, 1);
});
