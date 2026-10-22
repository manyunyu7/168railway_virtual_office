import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

// isolated data dir + a fake projects root, set before any server module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
// furniture fixtures live in the test dir; the real catalog (written by other hands) is never read
const furnDir = path.join(tmp, 'furniture');
fs.mkdirSync(furnDir, { recursive: true });
process.env.KANTOR_FURNITURE_DIR = furnDir;
// a stand-in for `claude -p`: answers every turn with a short line, and the notulen prompt with JSON
const fakeClaude = path.join(tmp, 'fake-claude');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
const result = p.includes('Tulis notulen') ? JSON.stringify({ ringkasan: 'Ringkasan ' + (p.match(/giliran/g) || []).length, keputusan: ['Lanjut'], tindak_lanjut: [{ judul: 'Tugas ' + Date.now(), untuk: '', prioritas: 'P1', detail: '' }] }) : 'Pendapat saya.';
const ev = e => process.stdout.write(JSON.stringify({ type: 'stream_event', event: e }) + '\\n');
ev({ type: 'message_start' }); ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result } });
process.stdout.write(JSON.stringify({ type: 'result', result, total_cost_usd: 0.001 }) + '\\n');
`, { mode: 0o755 });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', approvals: { holdKantorSec: 2, holdManualSec: 0 }, claudeBin: fakeClaude }));
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

test('mcp: sessions_list shows who works where, marking the caller', async () => {
  const ag = await import('../server/agent.js');
  const cwd = path.join(root, 'shop/app');
  await live.handleHook({ session_id: 'sl-1', hook_event_name: 'UserPromptSubmit', cwd, prompt: 'rapikan tombol' });
  await live.handleHook({ session_id: 'sl-1', hook_event_name: 'PreToolUse', cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'lib/a.dart') }, tool_use_id: 'x' });
  const out = JSON.parse((await ag.callTool({ office: 'shop', role: null, by: 'x', sid: 'sl-1' }, 'sessions_list', {})).content[0].text);
  const me = out.find(x => x.kamu);
  assert.equal(me.folder, './app');
  assert.equal(me.status, 'working');
  assert.match(me.sedang, /^Edit /);
  await assert.rejects(() => ag.callTool({ office: 'shop', role: { isMgr: false }, by: 'x' }, 'meeting_start', { topic: 't', participants: ['a', 'b'] }), /manager/);
});

test('planning: dates, labels by name, dependencies without cycles', () => {
  const a = store.createCard('shop', { title: 'Desain', start: '2026-11-02', due: '2026-11-04', labels: ['ui', 'Penting'] }, 'x');
  const b = store.createCard('shop', { title: 'Bangun', start: '2026-11-05', estDays: 3, deps: [a.id], labels: ['UI'] }, 'x');
  assert.equal(b.deps[0].id, a.id);
  assert.equal(store.getCard('shop', a.id).blocks[0].id, b.id);
  assert.equal(store.listLabels('shop').length, 2, 'label names are matched case-insensitively');
  assert.throws(() => store.updateCard('shop', a.id, { deps: [b.id] }, 'x'), /melingkar/);
  assert.throws(() => store.updateCard('shop', a.id, { due: '4 Nov' }, 'x'), /YYYY-MM-DD/);
  store.archiveCard('shop', a.id, 'x');
  assert.deepEqual(store.listCards('shop').find(c => c.id === b.id).deps, [], 'deps on an archived card go away');
});

test('wiki tree: children, no cycles, children move up when the parent is deleted', () => {
  store.saveWiki('shop', { title: 'Proyek' , body: 'induk' }, 'x');
  store.saveWiki('shop', { title: 'Backend', body: 'b', parent: 'proyek' }, 'x');
  store.saveWiki('shop', { title: 'API', body: 'c', parent: 'backend' }, 'x');
  const api = store.getWiki('shop', 'api');
  assert.deepEqual(api.crumbs.map(c => c.slug), ['proyek', 'backend']);
  assert.deepEqual(store.getWiki('shop', 'proyek').children.map(c => c.slug), ['backend']);
  assert.throws(() => store.moveWiki('shop', 'proyek', { parent: 'api' }), /anaknya sendiri/);
  store.deleteWiki('shop', 'backend');
  assert.equal(store.getWiki('shop', 'api').parent, 'proyek');
});

test('media: files on disk, same content stored once, agents attach only from office or /tmp', async () => {
  const md = await import('../server/media.js');
  const ag = await import('../server/agent.js');
  const { Readable } = await import('node:stream');
  const req = buf => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const m1 = await md.saveUpload('shop', 'logo.png', req(png), 'x');
  const m2 = await md.saveUpload('shop', 'lagi.png', req(png), 'x');
  assert.equal(m1.id, m2.id);
  assert.ok(m1.image && fs.existsSync(path.join(process.env.KANTOR_HOME, 'offices/shop/media', `${m1.id}.png`)));
  store.saveWiki('shop', { title: 'Galeri', body: `![logo](${m1.url})` }, 'x');
  assert.deepEqual(md.listMedia('shop').find(x => x.id === m1.id).used, [{ kind: 'wiki', ref: 'galeri' }]);
  const tmpFile = path.join(os.tmpdir(), `kc-test-${Date.now()}.csv`); fs.writeFileSync(tmpFile, 'a,b\n1,2\n');
  const c = store.createCard('shop', { title: 'Laporan' }, 'x');
  const out = await ag.callTool({ office: 'shop', role: null, by: 'x' }, 'attach_file', { path: tmpFile, card: c.id, wiki: 'Galeri' });
  assert.match(out.content[0].text, /kartu .* dan wiki/);
  assert.equal(store.getCard('shop', c.id).attachments.length, 1);
  assert.match(store.getWiki('shop', 'galeri').body, /📎/);
  await assert.rejects(() => md.saveFromPath('shop', '/etc/hosts', 'x'), /folder kantor/);
});

test('media: video served with HTTP Range (206/416), extension suffix, markdown embed', async () => {
  const md = await import('../server/media.js');
  const { Readable, PassThrough } = await import('node:stream');
  const req = buf => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const v = await md.saveUpload('shop', 'Klip Demo.mp4', req(data), 'x');
  assert.ok(v.video && !v.image && v.mime === 'video/mp4');
  assert.equal(md.mediaMarkdown(v), `![Klip Demo](${v.url}.mp4)`);
  const get = async (range, id = v.id) => {
    const res = new PassThrough(), chunks = []; let status, h;
    res.writeHead = (s, hd) => { status = s; h = hd; };
    res.on('data', c => chunks.push(c));
    const done = new Promise(r => res.on('end', r));
    md.sendMedia('shop', id, res, false, range); await done;
    return { status, h, body: Buffer.concat(chunks) };
  };
  const full = await get('');
  assert.equal(full.status, 200); assert.equal(full.h['Accept-Ranges'], 'bytes'); assert.equal(full.h['Content-Type'], 'video/mp4'); assert.equal(full.body.length, 1000);
  const part = await get('bytes=100-199');
  assert.equal(part.status, 206); assert.equal(part.h['Content-Range'], 'bytes 100-199/1000'); assert.equal(part.h['Content-Length'], 100);
  assert.deepEqual(part.body, data.subarray(100, 200));
  assert.equal((await get('bytes=900-')).h['Content-Range'], 'bytes 900-999/1000');
  assert.equal((await get('bytes=-50')).h['Content-Range'], 'bytes 950-999/1000');
  assert.equal(md.parseRange('bytes=5000-', 1000), false);
  assert.equal(md.parseRange('bytes=0-1,5-6', 1000), null, 'multi-range falls back to the whole file');
  assert.equal((await get('bytes=0-9', v.id + '.mp4')).status, 206, 'id.ext resolves');
  const bad = new PassThrough(); let st416; bad.writeHead = s => { st416 = s; };
  md.sendMedia('shop', v.id, bad, false, 'bytes=5000-'); assert.equal(st416, 416);
});

test('tunjukkan: relative paths from the caller, never outside the office', async () => {
  const ag = await import('../server/agent.js');
  const sh = await import('../server/shows.js');
  const me = { office: 'shop', role: null, by: 'Dina', sid: null, cwd: path.join(root, 'shop/api') };
  await ag.callTool(me, 'tunjukkan', { path: 'main.go', catatan: 'lihat fungsi main', baris: '1-3' });
  await ag.callTool(me, 'tunjukkan', { url: 'http://localhost:5173/' });
  const [u, f] = sh.listShows({ open: true });
  assert.deepEqual([f.kind, f.target, f.lines, f.who], ['file', 'api/main.go', '1-3', 'Dina']);
  assert.equal(u.kind, 'url');
  await assert.rejects(() => ag.callTool(me, 'tunjukkan', { path: '../../../../etc/hosts' }), /folder kantor|Tidak ada/);
  await assert.rejects(() => ag.callTool(me, 'tunjukkan', { url: 'file:///etc/passwd' }), /http/);
  sh.markShow(f.id, { closed: true });
  assert.equal(sh.listShows({ open: true }).length, 1);
});

test('tunjukkan html: signed /sv path with sandbox CSP, relative assets load, nothing escapes', async () => {
  const ag = await import('../server/agent.js');
  const sh = await import('../server/shows.js');
  const dir = path.join(root, 'shop/app/post/pratinjau');
  fs.mkdirSync(path.join(root, 'shop/app/post/slides'), { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'feed.html'), '<img src="../slides/1.png">');
  assert.equal(sh.upDepth(`<img src="../../../a/b.png"> x='../b.css'`), 3);
  assert.equal(sh.upDepth('<p>no links</p>'), 1);
  fs.writeFileSync(path.join(root, 'shop/app/post/slides/1.png'), 'PNG');
  fs.writeFileSync(path.join(root, 'shop/app/post/.env'), 'SECRET');
  fs.writeFileSync(path.join(root, 'shop/app/secret.txt'), 'nope');
  fs.symlinkSync(path.join(root, 'shop/app/secret.txt'), path.join(root, 'shop/app/post/link.txt'));
  const me = { office: 'shop', role: null, by: 'Dina', sid: null, cwd: path.join(root, 'shop/app') };
  await ag.callTool(me, 'tunjukkan', { path: 'post/pratinjau/feed.html' });
  const it = sh.listShows({ open: true }).find(x => x.target === 'app/post/pratinjau/feed.html');
  assert.equal(it.html, true);
  assert.match(it.view, /^\/sv\/t[0-9a-f]+\/[0-9a-f]{24}\/pratinjau\/feed\.html$/);
  const get = p => { const out = { body: '' }; const res = { writeHead(c, h) { out.code = c; out.h = h; }, write(d) { out.body += d; return true; }, end(d) { if (d) out.body += d; out.done = true; }, on() { return this; }, once() { return this; }, emit() { return true; }, destroy() {} };
    sh.serveShow({ method: 'GET', headers: {} }, res, p);
    return new Promise(r => { const t = setInterval(() => { if (out.done) { clearInterval(t); r(out); } }, 5); }); };
  const page = await get(it.view);
  assert.equal(page.code, 200); assert.match(page.h['Content-Type'], /text\/html/);
  assert.match(page.h['Content-Security-Policy'], /^sandbox allow-scripts/); assert.doesNotMatch(page.h['Content-Security-Policy'], /same-origin/);
  const base = it.view.replace(/pratinjau\/feed\.html$/, '');
  assert.equal((await get(base + 'slides/1.png')).code, 200);
  assert.equal((await get(base + '.env')).code, 403);
  assert.equal((await get(base + '..%2Fsecret.txt')).code, 403);
  assert.equal((await get(base + '../secret.txt')).code, 403);
  assert.equal((await get(base + 'link.txt')).code, 403, 'symlink out of the folder');
  assert.equal((await get(it.view.replace(/\/[0-9a-f]{24}\//, '/' + '0'.repeat(24) + '/'))).code, 404, 'bad key');
  const md = sh.listShows({ open: true }).find(x => x.kind === 'url');
  assert.equal(md.html, undefined);
  sh.markShow(it.id, { closed: true });
});

test('playbooks: held by roles, in their prompt, agents propose instead of writing', async () => {
  const ag = await import('../server/agent.js');
  const tm = await import('../server/tmux.js');
  const db = await import('../server/db.js');
  const ops = store.createRole('shop', { name: 'Raka', title: 'DevOps', room: 'api' });
  store.saveWiki('shop', { title: 'Deploy API', body: '1. build\n2. upload' }, 'x');
  store.setPlaybook('shop', 'deploy-api', { roles: [ops.id], when: 'saat diminta deploy API', approval: true });
  const prompt = tm.rolePrompt('shop', db.one(db.officeDb('shop'), 'SELECT * FROM roles WHERE id = ?', ops.id));
  assert.match(prompt, /Deploy API\*\* — saat diminta deploy API — \*\*minta persetujuan/);
  const me = { office: 'shop', role: store.getRole('shop', ops.id), by: 'Raka' };
  await assert.rejects(() => ag.callTool(me, 'wiki_write', { title: 'Deploy API', body: 'diubah' }), /playbook_usul/);
  await ag.callTool(me, 'playbook_usul', { page: 'deploy-api', body: '1. build\n2. test\n3. upload', alasan: 'lupa tes' });
  const [u] = store.listProposals('shop');
  assert.equal(store.getWiki('shop', 'deploy-api').body, '1. build\n2. upload', 'nothing changes until accepted');
  store.decideProposal('shop', u.id, true);
  assert.match(store.getWiki('shop', 'deploy-api').body, /2\. test/);
  assert.equal(store.listProposals('shop').length, 0);
});

test('layout editor: saved positions apply, overlaps are refused, new rooms still appear, reset works', () => {
  const m = offices.officeModel('shop');
  const plan = structuredClone(m.plan);
  const a = plan.rooms.find(r => r.kind === 'kode'), others = plan.rooms.filter(r => r !== a && r.kind !== 'zone');
  // move one room to a free spot at the bottom of a taller plan
  plan.h += 30; a.x = 0; a.y = plan.h - 22; a.w = 20; a.h = 20; a.doors = [{ s: 't', at: 5, w: 3 }];
  const saved = offices.saveLayout('shop', { w: plan.w, h: plan.h, rooms: plan.rooms, decor: [] });
  const moved = saved.rooms.find(r => r.id === a.id);
  assert.deepEqual([moved.x, moved.y, moved.w, moved.h], [0, plan.h - 22, 20, 20]);
  assert.equal(offices.officeModel('shop').custom, true);
  // put it on top of another room: refused, nothing saved
  const b = others[0], clash = structuredClone(plan); const ca = clash.rooms.find(r => r.id === a.id);
  Object.assign(ca, { x: b.x + 2, y: b.y + 2 });
  assert.throws(() => offices.saveLayout('shop', { w: clash.w, h: clash.h, rooms: clash.rooms }), /menabrak/);
  assert.equal(offices.officeModel('shop').plan.rooms.find(r => r.id === a.id).y, plan.h - 22);
  // a room added later still shows up (placed automatically)
  const rid = offices.addRoom('shop', { name: 'Gudang Baru', kind: 'pantry' });
  offices.invalidate('shop');
  assert.ok(offices.officeModel('shop').plan.rooms.some(r => r.id === rid));
  offices.resetLayout('shop');
  assert.equal(offices.officeModel('shop').custom, false);
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

test('AskUserQuestion: answer via hook returns updatedInput with answers, multiSelect, free text and notes', async () => {
  const sid = 'sess-ask', cwd = path.join(root, 'shop/app');
  live.expectSession({ sid, office: 'shop', role: 'generalis', room: 'app', cwd, tmux: 'kc-test-ask' });
  const input = { questions: [
    { question: 'Hewan?', header: 'Hewan', multiSelect: false, options: [{ label: 'Kucing', description: '' }, { label: 'Anjing', description: '' }] },
    { question: 'Buah?', header: 'Buah', multiSelect: true, options: [{ label: 'Apel', description: '' }, { label: 'Mangga', description: '' }] },
    { question: 'Warna?', header: 'Warna', multiSelect: false, options: [{ label: 'Merah', description: '' }] },
  ] };
  const pending = live.handleHook({ session_id: sid, hook_event_name: 'PermissionRequest', cwd, tool_name: 'AskUserQuestion', tool_input: input });
  await new Promise(r => setTimeout(r, 50));
  const item = live.openInbox().find(i => i.sid === sid);
  assert.ok(item && item.held);
  assert.throws(() => live.answerAsk(item.id, [{ q: 0, choice: 2 }]), /belum ada/);
  live.answerAsk(item.id, [{ q: 0, choice: 2, note: 'dua-duanya lucu' }, { q: 'Buah?', choices: ['Apel', 2], text: 'Pisang' }, { q: 2, text: 'Ungu' }]);
  const out = await pending;
  const d = out.hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.answers, { 'Hewan?': 'Anjing', 'Buah?': 'Apel, Mangga, Pisang', 'Warna?': 'Ungu' });
  assert.deepEqual(d.updatedInput.annotations, { 'Hewan?': { notes: 'dua-duanya lucu' } });
  assert.equal(d.updatedInput.questions.length, 3);
  assert.throws(() => live.answerAsk(item.id, []), /sudah dijawab/);
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

test('rapat: rapat selesai bisa dilanjutkan dengan ronde baru, kartu tindak lanjut tetap, notulen di halaman wiki yang sama', async () => {
  const mt = await import('../server/meetings.js');
  const a = store.createRole('shop', { name: 'Ketua Rapat', title: 'Manager', room: 'api' });
  const b = store.createRole('shop', { name: 'Peserta Dua', title: 'Dev', room: 'app' });
  const until = async st => { for (let i = 0; i < 200; i++) { if (mt.getMeeting('shop', id).status === st) return; await new Promise(r => setTimeout(r, 25)); } assert.fail('rapat tidak ' + st); };
  const id = mt.startMeeting('shop', { topic: 'Uji lanjut', participants: [a.id, b.id], rounds: 1, chair: a.id }).id;
  await until('selesai');
  let m = mt.getMeeting('shop', id);
  assert.equal(m.messages.filter(x => x.kind === 'bicara').length, 2);
  const slug = m.wiki_slug;
  mt.actionToCard('shop', id, 0);
  const carded = mt.getMeeting('shop', id).actions[0];
  assert.ok(carded.card);
  assert.throws(() => mt.resumeMeeting('shop', id), /tidak sedang terhenti/);
  mt.continueMeeting('shop', id, { rounds: 2, note: 'Bagaimana kalau harga naik?' });
  assert.throws(() => mt.continueMeeting('shop', id, {}), /masih ada rapat|hanya rapat/i);
  await until('selesai');
  m = mt.getMeeting('shop', id);
  assert.equal(m.rounds, 3);
  assert.equal(m.messages.filter(x => x.kind === 'bicara').length, 6);
  assert.ok(m.messages.some(x => x.kind === 'kamu' && x.text.includes('harga naik')));
  assert.equal(m.wiki_slug, slug);
  assert.ok(m.actions.some(x => x.card === carded.card), 'kartu lama tetap tersambung');
  assert.ok(m.actions.length >= 2);
});

/* ---------------- daemon: embedding, cookies, push to Ghina ---------------- */
test('daemon: frame-ancestors, login cookie per scheme, bearer on pages, push to Ghina', async t => {
  const http = await import('node:http');
  const https = await import('node:https');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const [port, tlsPort, fakePort] = [await freePort(), await freePort(), await freePort()];
  const home = path.join(tmp, 'daemon-home');
  fs.mkdirSync(home, { recursive: true });
  const key = path.join(home, 'k.pem'), cert = path.join(home, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  // fake Ghina notify endpoint
  const got = [];
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"sent":true}'); }); });
  await new Promise(r => fake.listen(fakePort, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, roots: [root], token: 'demotoken', approvals: { holdKantorSec: 0, holdManualSec: 0 },
    tls: { host: '127.0.0.1', port: tlsPort, cert, key, names: ['office.tentrem.space', 'zenoffice.tentrem.space'] },
    ghinaNotify: { url: `http://127.0.0.1:${fakePort}/v1/notify`, token: 'ghina-secret', debounceSec: 30 } }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../server/index.js')], { env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: 'ignore' });
  t.after(() => { child.kill(); fake.close(); });
  const req = (secure, p, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const r = mod.request({ host: '127.0.0.1', port: secure ? tlsPort : port, path: p, method, headers, rejectUnauthorized: false }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); r.end(body);
  });
  for (let i = 0; ; i++) { try { await req(false, '/'); break; } catch { if (i > 50) throw new Error('daemon tidak jalan'); await new Promise(r => setTimeout(r, 200)); } }
  for (let i = 0; i < 30; i++) { try { await req(true, '/'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }

  const FA = "frame-ancestors 'self'";
  assert.equal((await req(false, '/')).headers['content-security-policy'], FA, 'login page');
  assert.equal((await req(false, '/api/state')).headers['content-security-policy'], FA, '401 api');
  const authH = { Authorization: 'Bearer demotoken' };
  const page = await req(false, '/', authH);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], FA);
  // login cookie unchanged: Strict, Secure only on https
  const login = await req(false, '/?token=demotoken&next=%23/o/shop/kantor');
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/#/o/shop/kantor');
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  assert.doesNotMatch(login.headers['set-cookie'][0], /Secure/);
  assert.match((await req(true, '/?token=demotoken')).headers['set-cookie'][0], /SameSite=Strict.*; Secure/);

  // native app: Bearer on API, media/file/music downloads and the websockets, under every allowed host
  const { WebSocket } = await import('ws');
  for (const [secure, host] of [[false, `127.0.0.1:${port}`], [true, 'office.tentrem.space'], [true, 'zenoffice.tentrem.space']]) {
    const h = { Host: host, Authorization: 'Bearer demotoken' };
    for (const p of ['/api/state', '/api/offices/shop', '/api/offices/shop/media', '/api/music', '/api/music/playlists', '/api/offices/shop/files?path=', '/api/offices/shop/files/raw?path=nope.txt', '/api/music/file?path=nope.mp3', '/api/offices/shop/media/nope']) {
      const r = await req(secure, p, h);
      assert.notEqual(r.status, 401, `${host} ${p} must accept Bearer`);
      assert.equal((await req(secure, p, { Host: host })).status, 401, `${host} ${p} without token`);
      assert.equal((await req(secure, p, { Host: host, Authorization: 'Bearer salah' })).status, 401);
    }
    assert.equal((await req(secure, '/api/state', { Host: 'evil.example', Authorization: 'Bearer demotoken' })).status, 401, 'foreign host');
    const url = `${secure ? 'wss' : 'ws'}://127.0.0.1:${secure ? tlsPort : port}/ws`;
    const opened = ws => new Promise(r => { ws.on('open', () => { ws.close(); r('open'); }); ws.on('unexpected-response', (q, res) => r(res.statusCode)); ws.on('error', () => r('error')); });
    assert.equal(await opened(new WebSocket(url, { headers: h, rejectUnauthorized: false })), 'open', `${host} ws bearer`);
    assert.equal(await opened(new WebSocket(url, { headers: { Host: host }, rejectUnauthorized: false })), 401, `${host} ws no token`);
    assert.equal(await opened(new WebSocket(url.replace('/ws', '/ws/term?kind=shell&office=shop&room=x'), { headers: { Host: host }, rejectUnauthorized: false })), 401, `${host} ws/term no token`);
  }

  // push to Ghina: question, permission request, debounce
  const hook = (o) => req(false, '/api/hook', { ...authH, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ session_id: 'push-1', cwd: path.join(root, 'shop/app'), ...o }));
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Pakai Postgres?' }] } });
  await hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Lagi?' }] } });
  for (let i = 0; i < 40 && got.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 2, 'question once (debounced), permission once');
  assert.ok(got.every(g => g.auth === 'Bearer ghina-secret'));
  const q = got.find(g => g.body.event === 'question').body;
  assert.deepEqual({ office: q.office, sid: q.sid, path: q.path }, { office: 'shop', sid: 'push-1', path: '#/o/shop/kantor' });
  assert.match(q.title, /bertanya$/);
  assert.match(q.body, /Pakai Postgres/);
  const perm = got.find(g => g.body.event === 'permission').body;
  assert.match(perm.title, /minta izin$/);
  assert.match(perm.body, /Bash rm -rf build/);
  assert.ok(q.title.length <= 120 && q.body.length <= 500);
});

test('push to Ghina: off without token, failures never throw, events can be switched off', async () => {
  const cfgMod = await import('../server/config.js');
  const notify = await import('../server/notify.js');
  const c = cfgMod.config();
  const saved = c.ghinaNotify;
  try {
    c.ghinaNotify = { ...saved, url: '', token: '' };
    assert.equal(notify.notifyConf(), null);
    assert.equal(await notify.pushGhina({ kind: 'question', sid: 'x' }), false);
    c.ghinaNotify = { ...saved, url: 'http://127.0.0.1:1/v1/notify', token: 't', events: ['question'] };
    assert.equal(await notify.pushGhina({ kind: 'question', sid: 'y', who: 'A' }), false, 'connection refused is swallowed');
    assert.equal(await notify.pushGhina({ kind: 'meeting', office: 'shop' }), false, 'event not enabled');
  } finally { c.ghinaNotify = saved; }
});

/* ---------------- furniture ---------------- */
const sprite = (w, h, ch = 'a') => ({ w: w * 8, h, palette: { a: '#2A2430', b: '#9AA3AF' }, rows: Array.from({ length: h }, (_, y) => (y % 2 ? 'b' : ch).repeat(w * 8)) });
const piece = (id, extra = {}) => ({ id, name: id, cat: 'kerja', w: 2, h: 1, sprite: sprite(2, 10), affords: ['type'], spots: [{ dx: 0, dy: 1, pose: 'sit', face: 'up' }], rooms: ['kode'], ...extra });

test('furniture loader: valid items load, defective ones are skipped and reported, ids stay unique', async () => {
  const fx = await import('../server/furniture.js');
  const dir = path.join(tmp, 'fx-loader');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([
    piece('meja', { solid: true }),
    piece('salah-lebar', { sprite: sprite(3, 10) }),                               // sprite.w != w*8
    piece('salah-baris', { sprite: { ...sprite(2, 10), rows: ['a'.repeat(16)] } }), // wrong row count
    piece('salah-warna', { sprite: { ...sprite(2, 10), rows: Array(10).fill('z'.repeat(16)) } }), // char not in palette
    piece('salah-afford', { affords: ['terbang'] }),
    piece('salah-pose', { spots: [{ dx: 0, dy: 1, pose: 'melayang' }] }),
    piece('id jelek!'),                                                             // bad id
    piece('lampu', { frames: [{ rows: sprite(2, 10, 'b').rows }, { rows: sprite(2, 10, 'a').rows }], fps: 4, active: { rows: sprite(2, 10, 'b').rows }, wall: true, solid: false, weight: 2 }),
  ]));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ items: [piece('meja'), piece('rak', { affords: [], spots: [] })] }));
  fs.writeFileSync(path.join(dir, 'rusak.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'behaviors.json'), JSON.stringify({ rules: [
    { id: 'ok', when: { status: 'working', tools: ['Edit'] }, pick: [{ a: 'type' }], dwell: [5, 10] },
    { id: 'afford-gaib', pick: [{ a: 'terbang' }], dwell: [5, 10] },
    { id: 'regex', when: { bash: '(' }, pick: [{ a: 'type' }], dwell: [5, 10] },
    { id: 'when-aneh', when: { cuaca: 'hujan' }, pick: [{ a: 'type' }], dwell: [5, 10] },
  ] }));
  const logs = [];
  fx.setLogger(m => logs.push(m));
  const f = fx.furniture({ dir });
  fx.setLogger(null);
  assert.deepEqual(f.items.map(i => i.id).sort(), ['lampu', 'meja', 'rak']);
  assert.equal(f.items.find(i => i.id === 'meja').spots[0].face, 'up');
  assert.equal(f.byId.get('lampu').fps, 4);
  assert.equal(f.byId.get('rak').solid, true, 'solid defaults to true');
  const errs = f.problems.map(p => `${p.id}:${p.error}`).join('\n');
  for (const id of ['salah-lebar', 'salah-baris', 'salah-warna', 'salah-afford', 'salah-pose', 'jelek']) assert.match(errs, new RegExp(id), id);
  assert.ok(f.problems.some(p => p.file === 'b.json' && p.id === 'meja' && /dobel/.test(p.error)), 'duplicate id');
  assert.ok(f.problems.some(p => p.file === 'rusak.json'), 'broken JSON');
  assert.ok(logs.length >= 8, 'problems are logged');
  assert.deepEqual(f.behaviors.rules.map(r => r.id), ['ok'], 'only the sound rule survives');
  assert.equal(f.problems.filter(p => p.file === 'behaviors.json').length, 3);
  // version is stable until a file changes; a changed file is picked up
  fx.setLogger(() => {});
  assert.equal(fx.reloadFurniture({ dir }).version, f.version, 'same files, same version');
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([piece('baru')]));
  const f2 = fx.reloadFurniture({ dir });
  assert.notEqual(f2.version, f.version);
  assert.ok(f2.byId.has('baru'));
  fx.setLogger(null);
});

test('prayer times: Kemenag method gives sane Jakarta and Surabaya values', async () => {
  const { prayerTimes } = await import('../server/prayer.js');
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const near = (got, want, tol = 4) => assert.ok(Math.abs(mins(got) - mins(want)) <= tol, `${got} vs ${want}`);
  const j = prayerTimes('2026-10-21', { lat: -6.2, lng: 106.8, tz: 'Asia/Jakarta' });
  near(j.subuh, '04:12'); near(j.dzuhur, '11:40'); near(j.ashar, '14:51'); near(j.maghrib, '17:48'); near(j.isya, '18:58');
  const order = [j.subuh, j.terbit, j.dzuhur, j.ashar, j.maghrib, j.isya].map(mins);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'times ascend through the day');
  const sby = prayerTimes('2026-10-21', { lat: -7.25, lng: 112.75, tz: 'Asia/Jakarta' });
  assert.ok(mins(sby.dzuhur) < mins(j.dzuhur) - 20, 'east of Jakarta, noon comes earlier');
  assert.deepEqual(Object.keys(prayerTimes('2026-03-20')).sort(), ['ashar', 'dzuhur', 'isya', 'maghrib', 'subuh', 'terbit']);
  assert.throws(() => prayerTimes('besok'), /YYYY-MM-DD/);
});

test('room kinds: new kinds can be added, with their width and floor', async () => {
  const lay = await import('../server/layout.js');
  const want = { musholla: [20, 'musholla'], lounge: [28, 'lounge'], game: [24, 'wood'], gym: [24, 'gymMat'], taman: [30, 'grass'], telepon: [10, 'carpet'], tidur: [18, 'carpet'] };
  for (const [k, [w, floor]] of Object.entries(want)) {
    assert.ok(offices.ROOM_KINDS.includes(k), k);
    assert.equal(lay.FN_WIDTH[k], w, `${k} width`);
    assert.equal(lay.FLOOR[k], floor, `${k} floor`);
    const rid = offices.addRoom('shop', { name: 'Uji ' + k, kind: k });
    const r = offices.officeModel('shop').plan.rooms.find(x => x.id === rid);
    assert.equal(r.kind, k);
    assert.equal(r.w, w, `${k} placed with its width`);
    assert.equal(r.floor, floor);
    offices.updateRoom('shop', rid, { remove: true });
  }
  assert.deepEqual(offices.layoutProblems(offices.officeModel('shop').plan), []);
  assert.throws(() => offices.addRoom('shop', { name: 'X', kind: 'kolam' }), /tidak dikenal/);
});

test('furniture API: catalog, prayer-times, per-office placement validated and broadcast', async t => {
  const http = await import('node:http');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { WebSocket } = await import('ws');
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const home = path.join(tmp, 'furn-home');
  fs.mkdirSync(home, { recursive: true });
  const dir = path.join(tmp, 'fx-api');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'k.json'), JSON.stringify([piece('meja'), piece('kursi', { w: 1 , sprite: sprite(1, 12)})]));
  fs.writeFileSync(path.join(dir, 'behaviors.json'), JSON.stringify({ rules: [{ id: 'x', when: { status: 'working' }, pick: [{ a: 'type' }], dwell: [5, 9] }] }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, roots: [root], token: 'demotoken', approvals: { holdKantorSec: 0, holdManualSec: 0 } }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../server/index.js')], { env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1', KANTOR_FURNITURE_DIR: dir }, stdio: 'ignore' });
  t.after(() => child.kill());
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Authorization: 'Bearer demotoken', 'Content-Type': 'application/json' } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  for (let i = 0; ; i++) { try { await call('/api/state'); break; } catch { if (i > 50) throw new Error('daemon tidak jalan'); await new Promise(r => setTimeout(r, 200)); } }

  const cat = (await call('/api/furniture')).json;
  assert.deepEqual(cat.items.map(i => i.id), ['meja', 'kursi']);
  assert.equal(cat.behaviors.rules[0].id, 'x');
  assert.match(cat.version, /^[0-9a-f]{12}$/);

  const pt = (await call('/api/prayer-times?date=2026-10-21')).json;
  assert.equal(pt.date, '2026-10-21');
  for (const k of ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya']) assert.match(pt[k], /^\d\d:\d\d$/, k);
  assert.equal((await call('/api/prayer-times?date=nanti')).status, 400);
  assert.match((await call('/api/prayer-times')).json.date, /^\d{4}-\d{2}-\d{2}$/, 'defaults to today');

  const reg = await call('/api/offices', 'POST', { root: path.join(root, 'shop') });
  assert.equal(reg.status, 200);
  const plan = (await call('/api/offices/shop')).json.plan;
  assert.deepEqual(plan.furniture, []);
  assert.deepEqual((await call('/api/offices/shop/furniture')).json.items, []);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: 'Bearer demotoken' } });
  const events = [];
  ws.on('message', m => { try { events.push(JSON.parse(m)); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  const bad = await call('/api/offices/shop/furniture', 'PUT', { items: [{ item: 'tak-ada', x: 1, y: 1 }, { item: 'meja', x: plan.w, y: 0 }, { item: 'meja', x: 1.5, y: 2 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /tidak dikenal/);
  assert.match(bad.json.error, /keluar dari batas/);
  assert.deepEqual((await call('/api/offices/shop/furniture')).json.items, [], 'nothing saved on refusal');

  const ok = await call('/api/offices/shop/furniture', 'PUT', { items: [{ uid: 'm1', item: 'meja', x: 5, y: 6 }, { item: 'kursi', x: 6, y: 7 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.items.map(i => [i.uid, i.item, i.x, i.y]), [['m1', 'meja', 5, 6], ['f2', 'kursi', 6, 7]]);
  assert.deepEqual((await call('/api/offices/shop')).json.plan.furniture, ok.json.items, 'rides along in GET /api/offices/:id');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(events.some(e => e.t === 'changed' && e.what === 'furniture' && e.office === 'shop'), 'live event');
  // owner avatar over HTTP
  assert.equal((await call('/api/offices/shop/owner')).json.present, false);
  const put = await call('/api/offices/shop/owner', 'PUT', { x: 5, y: 9, face: 'up', present: true, client: 't' });
  assert.equal(put.status, 200); assert.equal(put.json.present, true);
  assert.equal((await call('/api/offices/shop/owner', 'PUT', { face: 'atas' })).status, 400);
  assert.equal((await call('/api/offices/tidakada/owner', 'PUT', { x: 1, y: 1, present: true })).status, 404);
  assert.equal((await call('/api/owner/look', 'PUT', { color: '#123456' })).json.color, '#123456');
  assert.equal((await call('/api/offices/shop/owner')).json.look.color, '#123456');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(events.some(e => e.t === 'owner' && e.office === 'shop' && e.owner.x === 5 && e.owner.face === 'up'), 'owner event');
  // Magang (NPC kosmetik): default 6, atur 0-30, usir satu / semua, event live
  const mg0 = (await call('/api/offices/shop/minions')).json;
  assert.equal(mg0.count, 6); assert.equal(mg0.minions.length, 6); assert.equal(mg0.auto, false); assert.equal(mg0.max, 30);
  assert.equal(new Set(mg0.minions.map(m => m.name)).size, 6, 'names unique');
  assert.ok(new Set(mg0.minions.map(m => m.look.color + m.look.hairStyle + m.look.skin)).size >= 4, 'looks vary');
  assert.ok(mg0.minions.every(m => m.look.lanyard === '#F2842B'), 'the lanyard is the only Magang marker');
  assert.deepEqual((await call('/api/offices/shop/minions')).json.minions, mg0.minions, 'identity is stable');
  assert.equal((await call('/api/offices/shop')).json.minions.count, 6, 'rides along in GET /api/offices/:id');
  assert.equal((await call('/api/offices/shop/minions', 'PUT', { count: 31 })).status, 400);
  assert.equal((await call('/api/offices/shop/minions', 'PUT', { count: -1 })).status, 400);
  assert.equal((await call('/api/offices/shop/minions', 'PUT', { auto: 'ya' })).status, 400);
  const mg12 = (await call('/api/offices/shop/minions', 'PUT', { count: 12, auto: true })).json;
  assert.equal(mg12.minions.length, 12); assert.equal(mg12.auto, true);
  assert.deepEqual(mg12.minions.slice(0, 6), mg0.minions, 'raising the count keeps the first ones');
  const gone = mg12.minions[2].id;
  const us = await call(`/api/offices/shop/minions/${gone}/usir`, 'POST');
  assert.equal(us.status, 200); assert.equal(us.json.count, 11);
  assert.ok(!us.json.minions.some(m => m.id === gone), 'dismissed one is gone');
  assert.deepEqual(us.json.minions.map(m => m.id), mg12.minions.filter(m => m.id !== gone).map(m => m.id));
  assert.equal((await call(`/api/offices/shop/minions/${gone}/usir`, 'POST')).status, 400, 'already gone');
  assert.equal((await call('/api/offices/tidakada/minions')).status, 404);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(events.some(e => e.t === 'minions' && e.office === 'shop' && e.minions.count === 11), 'minions event');
  const all0 = await call('/api/offices/shop/minions/semua/usir', 'POST');
  assert.equal(all0.json.count, 0); assert.deepEqual(all0.json.minions, []);
  assert.equal((await call('/api/offices/shop/minions', 'PUT', { count: 3 })).json.minions.length, 3);
  ws.close();
  assert.equal((await call('/api/offices/tidakada/furniture')).status, 404);
});

/* ---------------- owner avatar ---------------- */
test('owner: position per office, look global, leaves after 2 minutes, events', async () => {
  const ow = await import('../server/owner.js');
  const events = [];
  const on = m => { if (m.t === 'owner') events.push(m); };
  live.bus.on('msg', on);
  try {
    const t0 = 1_000_000;
    assert.equal(ow.getOwner('shop', t0).present, false, 'nobody yet');
    assert.equal(ow.getOwner('shop', t0).look.crown, true);
    assert.throws(() => ow.putOwner('shop', { present: true }, t0), /butuh x,y/);
    assert.throws(() => ow.putOwner('shop', { x: -1, y: 2 }, t0), /tile/);
    assert.throws(() => ow.putOwner('shop', { x: 1, y: 2, face: 'atas' }, t0), /face/);
    assert.throws(() => ow.putOwner('shop', { x: 1, y: 2, look: { color: 'merah' } }, t0), /#rrggbb/);
    const a = ow.putOwner('shop', { x: 10.256, y: 20, face: 'left', room: 'lobby', present: true, client: 'web-1', pose: 'sit', fx: 'sofa', look: { color: '#2F5D9E', hairStyle: 'hijab', hijab: '#2C8452', evil: 1 } }, t0);
    assert.deepEqual([a.x, a.y, a.face, a.room, a.present, a.client, a.pose, a.fx], [10.26, 20, 'left', 'lobby', true, 'web-1', 'sit', 'sofa']);
    assert.equal(a.look.color, '#2F5D9E'); assert.equal(a.look.hijab, '#2C8452'); assert.equal(a.look.evil, undefined);
    assert.equal(ow.getOwner('app-office', t0).look.color, '#2F5D9E', 'look is shared by every office');
    assert.equal(ow.getOwner('app-office', t0).present, false, 'position is per office');
    // partial update keeps the rest
    const b = ow.putOwner('shop', { x: 11, y: 20 }, t0 + 1000);
    assert.equal(b.face, 'left'); assert.equal(b.present, true);
    assert.equal(events.at(-1).office, 'shop'); assert.equal(events.at(-1).owner.x, 11);
    // no heartbeat for 2 minutes: gone (on read and by the sweeper, which sends one event)
    const late = t0 + 1000 + ow.PRESENT_MS;
    assert.equal(ow.getOwner('shop', late).present, false);
    const n = events.length;
    assert.deepEqual(ow.sweep(late), ['shop']);
    assert.equal(events.length, n + 1); assert.equal(events.at(-1).owner.present, false); assert.equal(events.at(-1).owner.pose, null);
    assert.deepEqual(ow.sweep(late + 1), [], 'only once');
    // leaving on purpose
    ow.putOwner('shop', { x: 3, y: 4, present: true }, late + 2);
    assert.equal(ow.putOwner('shop', { present: false }, late + 3).present, false);
    assert.equal(ow.setLook({ acc: 'kacamata' }).acc, 'kacamata');
    assert.equal(ow.getLook().color, '#2F5D9E', 'look update merges');
  } finally { live.bus.off('msg', on); }
});

/* ---------------- attachments: uploads in, files out ---------------- */
const mkReq = (buf, headers = {}) => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length), ...headers } });

test('attachments: resumable upload lands in .kantor/inbox, git-excluded, video gets frames', async () => {
  const att = await import('../server/attachments.js');
  const dbm = await import('../server/db.js');
  const cwd = path.join(root, 'shop/api');
  dbm.run(dbm.globalDb(), 'INSERT OR REPLACE INTO sessions (sid, office, cwd, status) VALUES (?, ?, ?, ?)', 'sid-att', 'shop', cwd, 'idle');
  const vid = path.join(tmp, 'uji.mp4');
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', vid]);
  const data = fs.readFileSync(vid);
  const events = [];
  live.bus.on('msg', m => { if (m.t === 'attachment') events.push(m); });

  assert.throws(() => att.createUpload('tidak-ada', { name: 'a.mp4', size: 10 }), /Sesi tidak ditemukan/);
  assert.throws(() => att.createUpload('sid-att', { name: 'a.mp4', size: 0 }), /size/);
  const u = att.createUpload('sid-att', { name: 'uji saya (1).mp4', size: data.length, caption: 'lihat tengah' });
  assert.equal(u.offset, 0);
  assert.ok(u.chunk >= 1024 * 1024);

  const cut = Math.floor(data.length / 2);
  let r = await att.appendUpload(u.id, mkReq(data.subarray(0, cut), { 'upload-offset': '0' }));
  assert.deepEqual(r, { offset: cut, done: false });
  // wrong offset -> 409 with the right one
  await assert.rejects(() => att.appendUpload(u.id, mkReq(data.subarray(cut), { 'upload-offset': '5' })), e => e.code === 409 && e.offset === cut);
  assert.equal(att.uploadInfo(u.id).offset, cut);
  // a chunk past the end is refused and leaves the file as it was
  await assert.rejects(() => att.appendUpload(u.id, mkReq(Buffer.concat([data.subarray(cut), Buffer.from('x')]), { 'upload-offset': String(cut) })), e => e.code === 413);
  assert.equal(att.uploadInfo(u.id).offset, cut);
  r = await att.appendUpload(u.id, mkReq(data.subarray(cut), { 'upload-offset': String(cut) }));
  assert.equal(r.done, true);
  const item = r.attachment;
  assert.match(item.path, /^\.kantor\/inbox\/\d{8}-\d{4}-uji_saya_1_\.mp4$/);
  assert.equal(item.dir, 'in');
  assert.equal(item.caption, 'lihat tengah');
  assert.equal(fs.readFileSync(path.join(cwd, item.path)).length, data.length);
  assert.ok(att.uploadInfo(u.id).done);
  await assert.rejects(() => att.appendUpload(u.id, mkReq(Buffer.from('x'), { 'upload-offset': '0' })), e => e.code === 409);
  // .git/info/exclude got the line once; .gitignore untouched
  const ex = fs.readFileSync(path.join(cwd, '.git/info/exclude'), 'utf8');
  assert.equal(ex.split('\n').filter(l => l === '.kantor/').length, 1);
  assert.ok(!fs.existsSync(path.join(cwd, '.gitignore')));

  // frames + message arrive after the response
  let done;
  for (let i = 0; i < 100 && !(done = att.getAttachment(item.id)).frames; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(done.frames.count, 3);
  assert.equal(done.kind, 'video');
  assert.equal(done.width, 320);
  assert.ok(Math.abs(done.duration - 3) < 0.5);
  assert.equal(fs.readdirSync(done.frames.dir).length, 3);
  assert.match(path.basename(done.frames.dir), /-frames$/);
  for (let i = 0; i < 50 && att.getAttachment(item.id).delivered === false && !events.some(e => e.item.id === item.id && e.item.processing === false && e.item.frames); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 200));
  const row = dbm.one(dbm.globalDb(), 'SELECT meta FROM attachments WHERE id = ?', item.id);
  const meta = JSON.parse(row.meta);
  assert.equal(meta.delivered, false, 'no tmux for this session: saved only');
  assert.match(meta.message, /Kamu menerima file dari pemilik: \.kantor\/inbox\/.*uji_saya_1_\.mp4 \(.* KB, video\/mp4\)\. Frame tiap detik ada di \.kantor\/inbox\/.*-frames\/ \(3 gambar, durasi 3 detik, 320x240\)\. Pesan pemilik: lihat tengah/);
  assert.ok(events.length >= 2, 'created + updated events');
  assert.equal(att.listAttachments('sid-att').items.length, 1);
});

test('attachments: stale uploads are removed; kirim_ke_pemilik copies to the outbox and notifies', async () => {
  const att = await import('../server/attachments.js');
  const ag = await import('../server/agent.js');
  const cwd = path.join(root, 'shop/api');
  const u = att.createUpload('sid-att', { name: 'lama.bin', size: 100 });
  assert.equal(att.cleanStale(Date.now()), 0);
  assert.ok(att.cleanStale(Date.now() + 49 * 3600e3) >= 2);
  assert.throws(() => att.uploadInfo(u.id), /tidak ditemukan/);

  const notes = [], evs = [];
  live.bus.on('notify', n => notes.push(n));
  live.bus.on('msg', m => { if (m.t === 'attachment') evs.push(m); });
  fs.writeFileSync(path.join(cwd, 'hasil.png'), execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']));
  const me = { office: 'shop', role: null, by: 'Dina', sid: 'sid-att', cwd };
  await ag.callTool(me, 'kirim_ke_pemilik', { path: 'hasil.png', caption: 'ini hasilnya' });
  const items = att.listAttachments('sid-att').items;
  const out = items.find(i => i.dir === 'out');
  assert.match(out.path, /^\.kantor\/outbox\/\d{8}-\d{4}-hasil\.png$/);
  assert.deepEqual([out.kind, out.mime, out.caption], ['image', 'image/png', 'ini hasilnya']);
  assert.ok(fs.existsSync(path.join(cwd, out.path)) && fs.existsSync(path.join(cwd, 'hasil.png')));
  assert.equal(evs.at(-1).item.id, out.id);
  assert.deepEqual([notes.at(-1).kind, notes.at(-1).who, notes.at(-1).sid], ['file', 'Dina', 'sid-att']);
  await assert.rejects(() => ag.callTool(me, 'kirim_ke_pemilik', { path: '/etc/hosts' }), /folder kerja/);
  await assert.rejects(() => ag.callTool(me, 'kirim_ke_pemilik', { path: 'tidak-ada.txt' }), /Tidak ada file/);
  await assert.rejects(() => ag.callTool(me, 'tangkap_layar', { url: 'https://example.com/' }), /lokal/);
  await assert.rejects(() => ag.callTool(me, 'tangkap_layar', { target: 'aneh' }), /target/);
  assert.ok(ag.TOOLS.some(t => t.name === 'tangkap_layar' && /MEMINTA/.test(t.description)));
  assert.match(String(await import('../server/tmux.js').then(m => m.rolePrompt('shop', store.listRoles('shop')[0]))), /tangkap_layar/);
});

test('attachments over HTTP: upload, 409, Range, thumb, list, ghina push for files', async t => {
  const http = await import('node:http');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const [port, fakePort] = [await freePort(), await freePort()];
  const home = path.join(tmp, 'att-home');
  fs.mkdirSync(home, { recursive: true });
  const got = [];
  const fake = http.createServer((rq, rs) => { let b = ''; rq.on('data', c => { b += c; }); rq.on('end', () => { got.push(JSON.parse(b)); rs.end('{"ok":true}'); }); });
  await new Promise(r => fake.listen(fakePort, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, roots: [root], token: 'demotoken', approvals: { holdKantorSec: 0, holdManualSec: 0 }, ghinaNotify: { url: `http://127.0.0.1:${fakePort}/n`, token: 's', events: [], debounceSec: 30 } }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../server/index.js')], { env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: 'ignore' });
  t.after(() => { child.kill(); fake.close(); });
  const req = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Authorization: 'Bearer demotoken', ...headers } }, res => {
      const bufs = []; res.on('data', c => bufs.push(c)); res.on('end', () => { const raw = Buffer.concat(bufs); let json = null; try { json = JSON.parse(raw.toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    r.on('error', reject); r.end(body);
  });
  for (let i = 0; ; i++) { try { await req('/api/state'); break; } catch { if (i > 50) throw new Error('daemon tidak jalan'); await new Promise(r => setTimeout(r, 200)); } }
  const cwd = path.join(root, 'shop/app');
  const sdb = new DatabaseSync(path.join(home, 'kantor.db'));
  sdb.prepare('INSERT OR REPLACE INTO sessions (sid, office, cwd, status) VALUES (?, ?, ?, ?)').run('sid-http', 'shop', cwd, 'idle');
  sdb.close();
  const J = { 'Content-Type': 'application/json' };

  assert.equal((await req('/api/sessions/nope/uploads', { method: 'POST', headers: J, body: '{"name":"a","size":3}' })).status, 404);
  const c = await req('/api/sessions/sid-http/uploads', { method: 'POST', headers: J, body: JSON.stringify({ name: 'catatan.txt', size: 10, caption: 'halo' }) });
  assert.equal(c.status, 201);
  const id = c.json.id;
  const bad = await req(`/api/uploads/${id}`, { method: 'PUT', headers: { 'Upload-Offset': '3' }, body: 'abcd' });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.offset, 0);
  assert.equal((await req(`/api/uploads/${id}`, { method: 'PUT', headers: { 'Upload-Offset': '0' }, body: 'abcd' })).json.offset, 4);
  const head = await req(`/api/uploads/${id}`, { method: 'HEAD' });
  assert.equal(head.headers['upload-offset'], '4');
  assert.equal((await req(`/api/uploads/${id}`)).json.done, false);
  assert.equal((await req(`/api/uploads/${id}`, { method: 'PUT', headers: { 'Upload-Offset': '4' }, body: 'abcdefgh' })).status, 413);
  const fin = await req(`/api/uploads/${id}`, { method: 'PUT', headers: { 'Upload-Offset': '4' }, body: '567890' });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.done, true);
  const a = fin.json.attachment;
  assert.equal(a.mime, 'text/plain; charset=utf-8');
  assert.equal(fs.readFileSync(path.join(cwd, a.path), 'utf8'), 'abcd567890');
  assert.equal((await req(`/api/uploads/${id}`)).json.attachment.id, a.id);

  // raw with Range
  const full = await req(a.url);
  assert.equal(full.status, 200);
  assert.equal(full.raw.toString(), 'abcd567890');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-type'], 'text/plain; charset=utf-8');
  const part = await req(a.url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.raw.toString(), 'cd56');
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal((await req(a.url, { headers: { Range: 'bytes=-3' } })).raw.toString(), '890');
  assert.equal((await req(a.url, { headers: { Range: 'bytes=4-' } })).raw.toString(), '567890');
  assert.equal((await req(a.url, { headers: { Range: 'bytes=50-60' } })).status, 416);
  assert.equal((await req('/api/attachments/zzz/raw')).status, 404);
  assert.equal((await req(a.url.replace('/raw', '/thumb'))).status, 404, 'text has no thumb');
  assert.equal((await req(a.url, { headers: { Authorization: 'Bearer salah' } })).status, 401);

  // outgoing image: thumb <= 480 wide, jpeg, cached
  const att = await import('../server/attachments.js');
  fs.writeFileSync(path.join(cwd, 'besar.png'), execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1200x800', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']));
  const call = await req('/api/agent/call', { method: 'POST', headers: J, body: JSON.stringify({ office: 'shop', sid: 'sid-http', tool: 'kirim_ke_pemilik', args: { path: 'besar.png', caption: 'tangkapan' } }) });
  assert.equal(call.status, 200, call.raw.toString());
  const list = await req('/api/sessions/sid-http/attachments');
  assert.deepEqual(list.json.items.map(i => i.dir), ['in', 'out']);
  const out = list.json.items[1];
  const th = await req(out.thumb);
  assert.equal(th.status, 200);
  assert.equal(th.headers['content-type'], 'image/jpeg');
  const dim = execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: th.raw }).toString().trim();
  assert.equal(dim, '480,320');
  assert.equal((await req(out.thumb)).raw.length, th.raw.length);
  assert.equal((await req(`/api/sessions/sid-http/attachments?after=${encodeURIComponent(out.at)}`)).json.items.length, 0);
  // video: Range on raw + thumb of a frame
  const vsrc = path.join(tmp, 'uji.mp4');
  fs.copyFileSync(vsrc, path.join(cwd, 'uji.mp4'));
  await req('/api/agent/call', { method: 'POST', headers: J, body: JSON.stringify({ office: 'shop', sid: 'sid-http', tool: 'kirim_ke_pemilik', args: { path: 'uji.mp4' } }) });
  const v = (await req('/api/sessions/sid-http/attachments')).json.items.find(i => i.kind === 'video');
  assert.equal(v.mime, 'video/mp4');
  assert.equal(Math.round(v.duration), 3);
  assert.equal((await req(v.url, { headers: { Range: 'bytes=0-99' } })).raw.length, 100);
  assert.equal((await req(v.thumb)).headers['content-type'], 'image/jpeg');
  // outbox routes
  const sdb2 = new DatabaseSync(path.join(home, 'kantor.db'));
  sdb2.prepare("INSERT INTO outbox (id, sid, text, at, status) VALUES ('q1', 'sid-http', 'halo', ?, 'pending'), ('q2', 'sid-http', 'dua', ?, 'pending')").run(new Date().toISOString(), new Date().toISOString());
  sdb2.close();
  assert.deepEqual((await req('/api/sessions/sid-http/outbox')).json.items.map(i => i.id), ['q1', 'q2']);
  const cx = await req('/api/sessions/sid-http/outbox/q1', { method: 'DELETE' });
  assert.equal(cx.status, 200);
  assert.equal(cx.json.stillQueued, true);
  assert.deepEqual((await req('/api/sessions/sid-http/outbox')).json.items.map(i => i.id), ['q2']);
  assert.equal((await req('/api/sessions/sid-http/outbox/zzz', { method: 'DELETE' })).status, 404);
  // Ghina got the file push even though events: []
  for (let i = 0; i < 30 && got.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].event, got[0].title, got[0].sid, got[0].office], ['file', 'Sesi manual mengirim file', 'sid-http', 'shop']);
  assert.match(got[0].body, /besar\.png — tangkapan/);
});

/* ---------------- antrean pesan (outbox) ---------------- */
test('outbox: pending until the prompt hook or transcript shows it; cancel only hides', async () => {
  const ob = await import('../server/outbox.js');
  const dbm = await import('../server/db.js');
  ob.startOutbox();
  const cwd = path.join(root, 'shop/api');
  const sid = 'sid-ob';
  await live.handleHook({ session_id: sid, hook_event_name: 'SessionStart', cwd, source: 'startup' });
  const evs = [];
  live.bus.on('msg', m => { if (m.t === 'outbox') evs.push(m); });

  const a = ob.recordOutgoing(sid, 'tolong   cek\ntest-nya');
  const b = ob.recordOutgoing(sid, 'pesan kedua');
  const c = ob.recordOutgoing(sid, 'pesan kedua'); // same text twice: oldest first
  assert.equal(a.status, 'pending');
  assert.deepEqual(ob.listOutbox(sid).items.map(i => i.status), ['pending', 'pending', 'pending']);
  assert.equal(evs.at(-1).item.id, c.id);
  assert.equal(evs.at(-1).office, 'shop');

  // hook with the same text (whitespace differs) reads the oldest match
  await live.handleHook({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd, prompt: 'tolong cek test-nya' });
  let items = ob.listOutbox(sid).items;
  assert.deepEqual(items.map(i => i.status), ['read', 'pending', 'pending']);
  assert.ok(items[0].readAt);
  await live.handleHook({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd, prompt: 'pesan kedua' });
  items = ob.listOutbox(sid).items;
  assert.deepEqual([items[1].status, items[2].status], ['read', 'pending'], 'the second identical one stays queued');

  // unmatched prompt: only a message that waited >= 10 s counts
  const d = ob.recordOutgoing(sid, 'ditulis ulang oleh Claude Code');
  assert.equal(ob.promptSeen(sid, 'teks lain sama sekali', Date.now()), null, 'too fresh to be guessed');
  assert.equal(ob.listOutbox(sid).items.find(i => i.id === c.id).status, 'pending');
  const late = ob.promptSeen(sid, 'teks lain sama sekali', Date.now() + 11000);
  assert.equal(late.id, c.id, 'oldest pending older than 10 s');

  // cancel: hides, never claims it was withdrawn
  const r = ob.cancelOutgoing(sid, d.id);
  assert.equal(r.stillQueued, true);
  assert.ok(!ob.listOutbox(sid).items.some(i => i.id === d.id));
  assert.throws(() => ob.cancelOutgoing(sid, d.id), /sudah dibatalkan/);
  assert.throws(() => ob.cancelOutgoing(sid, a.id), /sudah dibaca/);
  assert.throws(() => ob.cancelOutgoing('lain', a.id), /tidak ditemukan/);

  // transcript catches up without a hook
  const tr = path.join(tmp, 'ob-transcript.jsonl');
  const e = ob.recordOutgoing(sid, 'lewat transkrip saja');
  fs.writeFileSync(tr, [JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60000).toISOString(), message: { content: 'lewat transkrip saja' } }),
    JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: 'lewat   transkrip saja' } })].join('\n'));
  dbm.run(dbm.globalDb(), 'UPDATE sessions SET transcript = ? WHERE sid = ?', tr, sid);
  const s = live.live.get(sid); if (s) s.transcript = tr;
  assert.equal(ob.listOutbox(sid).items.find(i => i.id === e.id).status, 'read', 'older transcript line is ignored, the newer one counts');
  const f = ob.recordOutgoing(sid, 'belum ada di transkrip');
  assert.equal(ob.listOutbox(sid).items.find(i => i.id === f.id).status, 'pending');

  // keeps only the newest 50 in the listing
  for (let i = 0; i < 60; i++) ob.recordOutgoing(sid, `banyak ${i}`);
  assert.equal(ob.listOutbox(sid).items.length, 50);
});

test('konteks: pemakaian dari transcript, jendela per model, galat beruntun, compaction', async () => {
  const health = await import('../server/health.js');
  const f = path.join(tmp, 'ctx.jsonl');
  const asst = (used, model = 'claude-opus-5-5', extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T01:00:00Z', message: { model, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 5, cache_read_input_tokens: used - 15, cache_creation_input_tokens: 10, output_tokens: 99 } }, ...extra });
  const res = errs => JSON.stringify({ type: 'user', message: { content: errs.map(e => ({ type: 'tool_result', tool_use_id: 't', is_error: e, content: 'x' })) } });
  fs.writeFileSync(f, [asst(60_000), res([false]), asst(100_000, 'claude-opus-5-5', { isSidechain: true }), res([true]), res([true])].join('\n') + '\n');
  let h = health.sessionHealth(f, 'claude-opus-5-5');
  assert.deepEqual(h.ctx, { used: 60_000, limit: 200_000, pct: 30, at: '2026-10-21T01:00:00Z' });
  assert.equal(h.health, 'segar');
  assert.equal(h.errStreak, 2);
  assert.equal(h.compactions, 0);
  // appended later (incremental read, partial last line waits for its newline)
  const more = asst(160_000) + '\n' + JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n';
  fs.appendFileSync(f, more.slice(0, 40));
  assert.equal(health.sessionHealth(f).ctx.used, 60_000);
  fs.appendFileSync(f, more.slice(40));
  h = health.sessionHealth(f);
  assert.equal(h.ctx.used, 160_000);
  assert.equal(h.health, 'lelah');
  assert.equal(h.compactions, 1);
  assert.equal(h.errStreak, 2);
  // [1m] variant, and a window that is already exceeded means the 1M variant
  assert.equal(health.sessionHealth(f, 'claude-opus-5-5[1m]').ctx.limit, 1_000_000);
  fs.appendFileSync(f, asst(450_000) + '\n');
  h = health.sessionHealth(f);
  assert.equal(h.ctx.limit, 1_000_000);
  assert.equal(h.health, 'segar');
  fs.appendFileSync(f, asst(195_000, '<synthetic>') + '\n');
  assert.equal(health.sessionHealth(f).ctx.used, 450_000, 'synthetic entries are ignored');
  assert.deepEqual([40, 60, 80, 95].map(health.healthLevel), ['segar', 'sedang', 'lelah', 'kritis']);
  assert.equal(health.sessionHealth(path.join(tmp, 'nope.jsonl')).ctx, null);
  // appears in the session payload
  await live.handleHook({ session_id: 'sess-ctx', hook_event_name: 'PostToolUse', cwd: path.join(root, 'shop/api'), transcript_path: f, tool_name: 'Read', tool_input: {}, tool_use_id: 'c1' });
  const ser = live.serialize(live.live.get('sess-ctx'));
  assert.equal(ser.ctx.used, 450_000);
  assert.equal(ser.health, 'segar');
  assert.equal(ser.compactions, 1);
});

test('git: status, diff, commit terbatas, tanpa push', async () => {
  const gi = await import('../server/gitinfo.js');
  const dir = path.join(root, 'shop/api');
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'satu\ndua\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bebas\n');
  g('add', '-A'); g('commit', '-qm', 'awal');
  // a bare "upstream" two commits behind us
  const bare = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  g('remote', 'add', 'origin', bare);
  g('push', '-q', '-u', 'origin', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'satu\ndua\ntiga\n');
  g('commit', '-qam', 'kedua');
  g('stash', 'list');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'satu\nDUA\ntiga\n');
  fs.writeFileSync(path.join(dir, 'baru.txt'), 'x\ny\n');
  g('stash', 'push', '-q', '-u'); g('stash', 'apply', '-q');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));

  const all = await gi.officeGit('shop', { fresh: true });
  const r = all.api;
  assert.ok(r, 'room api has git info');
  assert.match(r.branch, /^(main|master)$/);
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 0);
  assert.equal(r.dirty, 3);
  assert.equal(r.untracked, 2);
  assert.equal(r.stash, 1);
  assert.equal(r.last.subject, 'kedua');
  assert.match(r.last.hash, /^[0-9a-f]{7,}$/);
  assert.ok(!all.lobby, 'rooms without a repo are left out');
  assert.equal(r.prs, undefined, 'no GitHub remote, no PRs');

  const list = await gi.gitDiff('shop', 'api');
  const by = Object.fromEntries(list.files.map(f => [f.file, f]));
  assert.deepEqual([by['a.txt'].add, by['a.txt'].del], [1, 1]);
  assert.equal(by['baru.txt'].untracked, true);
  assert.equal(by['baru.txt'].add, 2);
  assert.equal(by['bin.dat'].binary, true);
  const d = await gi.gitDiff('shop', 'api', 'a.txt');
  assert.match(d.diff, /^-dua$/m);
  assert.match(d.diff, /^\+DUA$/m);
  assert.match((await gi.gitDiff('shop', 'api', 'baru.txt')).diff, /^\+x$/m);
  await assert.rejects(gi.gitDiff('shop', 'api', '../../etc/passwd'), /tidak ada di daftar/);
  await assert.rejects(gi.gitDiff('shop', 'lobby'), /folder/);

  // commit: only what was named, nothing pushed, other staged files stay out
  g('add', 'bin.dat');
  await assert.rejects(gi.gitCommit('shop', 'api', { message: '  ' }), /kosong/);
  await assert.rejects(gi.gitCommit('shop', 'api', { message: 'x', files: ['nope.txt'] }), /Tidak ada perubahan di file/);
  const c1 = await gi.gitCommit('shop', 'api', { message: 'ubah dua', files: ['a.txt'] });
  assert.equal(c1.files, 1);
  assert.equal(g('show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt');
  assert.equal(g('rev-list', '--count', '@{u}..HEAD').trim(), '2', 'not pushed');
  assert.match(g('status', '--porcelain'), /A  bin\.dat/, 'pre-staged file was left alone');
  assert.equal(c1.git.dirty, 2);
  // no files: tracked changes only, never untracked (a file staged as new counts as tracked, so unstage it here)
  g('reset', '-q', 'bin.dat');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'berubah\n');
  const c2 = await gi.gitCommit('shop', 'api', { message: 'ubah b' });
  assert.equal(g('show', '--name-only', '--format=', 'HEAD').trim(), 'b.txt');
  assert.match(g('status', '--porcelain'), /\?\? baru\.txt/);
  assert.equal(c2.git.last.subject, 'ubah b');
  fs.rmSync(path.join(dir, 'bin.dat'));
  await assert.rejects(gi.gitCommit('shop', 'api', { message: 'kosong' }), e => e.code === 409);
  const log = store.listLog('shop', 20);
  assert.ok(log.some(l => l.kind === 'git' && /ubah b/.test(l.text)), 'commit is in the office log');
});

/* ---------------- office templates ---------------- */
// templates name real catalog items, so these tests borrow the real catalog for a moment (structural checks only)
async function withRealCatalog(fn) {
  const fx = await import('../server/furniture.js');
  const aside = path.join(tmp, 'furn-aside');
  fs.mkdirSync(aside, { recursive: true });
  for (const f of fs.readdirSync(furnDir)) fs.renameSync(path.join(furnDir, f), path.join(aside, f));
  const real = path.join(import.meta.dirname, '..', 'server', 'furniture');
  for (const f of fs.readdirSync(real).filter(f => f.endsWith('.json'))) fs.copyFileSync(path.join(real, f), path.join(furnDir, f));
  fx.reloadFurniture();
  try { return await fn(); } finally {
    for (const f of fs.readdirSync(furnDir)) fs.rmSync(path.join(furnDir, f));
    for (const f of fs.readdirSync(aside)) fs.renameSync(path.join(aside, f), path.join(furnDir, f));
    fx.reloadFurniture();
  }
}
function tplOffice(name, repos) {
  for (const r of repos) { fs.mkdirSync(path.join(root, name, r), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: path.join(root, name, r) }); }
  return offices.officeForCwd(path.join(root, name, repos[0]));
}

test('templates: every template fits a 2-repo and an 11-repo office: no layout problems, every room reachable, furniture valid', async () => {
  const T = await import('../server/templates.js');
  await withRealCatalog(() => {
    const small = tplOffice('tpl-kecil', ['api', 'app']);
    const big = tplOffice('tpl-besar', ['web', 'api', 'mobile', 'admin', 'docs-site', 'infra', 'worker', 'billing', 'search', 'design', 'ml']);
    const list = T.templates().list;
    assert.ok(list.length >= 6, 'six templates or more');
    assert.deepEqual(T.templates().problems, []);
    for (const id of ['zen-garden', 'kafe-senja', 'perpustakaan-tenang', 'startup-loft', 'stasiun', 'minimalis']) assert.ok(list.some(t => t.id === id), id);
    for (const t of list) {
      if (t.id !== 'minimalis') assert.ok(t.facilities.some(f => f.kind === 'musholla'), `${t.id} punya musholla`);
      for (const o of [small, big]) {
        const before = offices.officeModel(o).plan.rooms.filter(r => r.kind === 'kode').map(r => r.id).sort();
        const pv = T.previewTemplate(o, t.id, 7);
        assert.deepEqual(pv.problems, [], `${t.id} @ ${o}`);
        // code rooms stay, and a template's facility rooms are there
        assert.deepEqual(pv.plan.rooms.filter(r => r.kind === 'kode').map(r => r.id).sort(), before);
        for (const f of t.facilities) assert.ok(pv.plan.rooms.some(r => r.kind === f.kind), `${t.id} @ ${o}: ${f.kind}`);
        assert.ok(pv.furniture.length > 5, `${t.id} @ ${o}: ada perabot`);
        assert.equal(new Set(pv.furniture.map(f => f.uid)).size, pv.furniture.length);
        // deterministic per seed, different for another seed
        assert.equal(JSON.stringify(T.previewTemplate(o, t.id, 7).furniture), JSON.stringify(pv.furniture));
        if (t.id !== 'minimalis') assert.notEqual(JSON.stringify(T.previewTemplate(o, t.id, 8).furniture), JSON.stringify(pv.furniture));
      }
    }
    // the checker itself catches a broken result
    const pv = T.previewTemplate(small, 'zen-garden', 1);
    const shut = structuredClone(pv.plan);
    shut.rooms.find(r => r.kind === 'taman').doors = [];
    assert.ok(T.resultProblems(shut).some(p => /tidak bisa dimasuki/.test(p)));
    const stacked = structuredClone(pv.plan);
    stacked.furniture = [...pv.furniture, { ...pv.furniture.find(f => !/sajadah|karpet|keset|rumput/.test(f.item)), uid: 'dup' }];
    assert.ok(T.resultProblems(stacked).some(p => /menabrak/.test(p)));
  });
});

test('templates: apply saves rooms, layout and furniture; trying another keeps the first backup; restore brings the office back', async () => {
  const T = await import('../server/templates.js');
  const { officeDb, one } = await import('../server/db.js');
  await withRealCatalog(() => {
    const o = tplOffice('tpl-pakai', ['web', 'api', 'app']);
    const meta = k => one(officeDb(o), 'SELECT value FROM meta WHERE key = ?', k)?.value ?? null;
    const plan0 = JSON.stringify(offices.officeModel(o).plan.rooms.map(r => [r.id, r.x, r.y, r.w, r.h]));
    const pv = T.previewTemplate(o, 'zen-garden', 3);
    const r = T.applyTemplate(o, 'zen-garden', 3);
    assert.deepEqual(r.newRooms.map(x => x.kind).sort(), ['musholla', 'taman', 'telepon', 'tidur']);
    const m = offices.officeModel(o);
    for (const x of pv.plan.rooms.filter(x => x.kind !== 'zone')) {
      const y = m.plan.rooms.find(q => q.id === x.id);
      assert.ok(y, x.id);
      assert.deepEqual([y.x, y.y, y.w, y.h, y.floor], [x.x, x.y, x.w, x.h, x.floor], x.id);
    }
    assert.equal(m.plan.furniture.length, pv.furniture.length);
    assert.deepEqual(T.resultProblems(m.plan, []).filter(p => !/meja/.test(p)), []);
    assert.equal(T.templateState(o).current.id, 'zen-garden');
    const backupAt = T.templateState(o).backup.at;
    // a second template: zen's empty extra rooms that kafe does not want are let go, the musholla is reused
    const r2 = T.applyTemplate(o, 'kafe-senja', 1);
    assert.ok(r2.dropped.length >= 2);
    const rooms2 = offices.officeModel(o).plan.rooms;
    assert.ok(!rooms2.some(x => x.kind === 'taman'));
    assert.equal(rooms2.filter(x => x.kind === 'musholla').length, 1);
    assert.equal(T.templateState(o).backup.at, backupAt);
    // restore: the plan from before any template, no backup left
    T.restoreTemplate(o);
    assert.equal(JSON.stringify(offices.officeModel(o).plan.rooms.map(r => [r.id, r.x, r.y, r.w, r.h])), plan0);
    assert.equal(meta('layout-backup'), null);
    assert.equal(meta('furniture'), null);
    assert.throws(() => T.restoreTemplate(o), /cadangan/);
    assert.throws(() => T.previewTemplate(o, 'tidak-ada', 1), /tidak dikenal/);
  });
});

test('templates: gallery thumbnails, wizard preview with a template, applied when the office is created', async () => {
  const T = await import('../server/templates.js');
  const wz = await import('../server/wizard.js');
  await withRealCatalog(() => {
    const g = T.templateList();
    assert.ok(g.templates.length >= 6);
    assert.match(g.templates[0].thumb, /^<svg/);
    const spec = { mode: 'new', base: root, name: 'Tpl Wizard', layout: 'multi', subs: ['api', 'web'], gitInit: false, team: [{ name: 'Bu Tpl', title: 'Manager', isMgr: true }], template: 'stasiun', seed: 2 };
    const pv = wz.wizardPreview(spec);
    assert.ok(pv.plan.rooms.some(r => r.name === 'Ruang Tunggu'));
    assert.ok(pv.plan.furniture.length > 0);
    assert.deepEqual(pv.warnings, []);
    const r = wz.wizardCreate(spec);
    assert.equal(r.template, 'stasiun');
    assert.equal(T.templateState(r.id).current.id, 'stasiun');
    assert.ok(offices.officeModel(r.id).plan.furniture.length > 0);
  });
});

test('templates: the hand-made 168Railway plan keeps its open-plan zones inside the moved room, everyone seated', async () => {
  const T = await import('../server/templates.js');
  await withRealCatalog(() => {
    const plan = layout.railwayLayout({ web: 'web', mobile: 'mobile', admin: 'admin', live: 'android-live', lib: 'docs', ppka: 'ppka' });
    const roles = [{ id: 'a', room: 'mobile' }, { id: 'b', room: 'mobile' }, { id: 'c', room: 'admin' }, { id: 'd', room: 'web' }, { id: 'm', room: 'manager' }];
    for (const t of T.templates().list) {
      const g = T.generateFrom({ rooms: plan.rooms, roles }, t.id, 1);
      assert.deepEqual(T.resultProblems(g.plan, roles), [], t.id);
      const op = g.plan.rooms.find(r => r.kind === 'openplan');
      for (const z of g.plan.rooms.filter(r => r.kind === 'zone')) assert.ok(z.x > op.x && z.x + z.w <= op.x + op.w, `${t.id}: ${z.id}`);
    }
  });
});

test('adegan Magang: scenes.json bawaan valid, mencakup semua jenis ruangan, dan tersaji lewat katalog', async () => {
  const { checkScenes, furniture } = await import('../server/furniture.js');
  const data = JSON.parse(fs.readFileSync(new URL('../server/furniture/scenes.json', import.meta.url), 'utf8'));
  const { scenes, problems } = checkScenes(data);
  assert.deepEqual(problems, []);
  assert.equal(scenes.length, data.scenes.length, 'no scene dropped');
  for (const sc of scenes) assert.ok(!sc.actors || (sc.actors[0] >= 1 && sc.actors[1] <= 3 && sc.actors[0] <= sc.actors[1]), `${sc.id} actors`);
  for (const kind of ['manager', 'qa', 'server', 'meeting', 'lib', 'pantry', 'lobby', 'kode', 'gym', 'game', 'musik', 'taman', 'tidur', 'musholla']) assert.ok(scenes.some(sc => sc.rooms.includes(kind)), `a scene for ${kind}`);
  assert.ok(scenes.some(sc => sc.id === 'ngobrol' && sc.withAgent), 'social scene');
  assert.equal(furniture({ dir: new URL('../server/furniture', import.meta.url).pathname }).scenes.length, scenes.length, 'loaded with the catalog');
  assert.equal(checkScenes({ scenes: [{ id: 'x', rooms: ['qa'], steps: [] }, { rooms: ['qa'], steps: [{}] }] }).scenes.length, 0, 'bad scenes dropped');
});

test('media: PDF and md/txt documents embed as cards, PDF stays inline with Range', async () => {
  const md = await import('../server/media.js');
  const { Readable, PassThrough } = await import('node:stream');
  const req = buf => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
  const pdf = await md.saveUpload('shop', 'Laporan Q3.pdf', req(Buffer.from('%PDF-1.4 laporan')), 'x');
  assert.ok(pdf.pdf && !pdf.doc && !pdf.image && !pdf.video);
  assert.equal(md.mediaMarkdown(pdf), `![Laporan Q3](${pdf.url}.pdf)`);
  const doc = await md.saveUpload('shop', 'catatan.md', req(Buffer.from('# Judul\n\nisi')), 'x');
  assert.ok(doc.doc && !doc.pdf);
  assert.equal(md.mediaMarkdown(doc), `![catatan](${doc.url}.md)`);
  const mk = await md.saveUpload('shop', 'README.markdown', req(Buffer.from('# R')), 'x');
  assert.ok(mk.doc); assert.equal(md.mediaMarkdown(mk), `![README](${mk.url}.markdown)`);
  const zip = await md.saveUpload('shop', 'a.zip', req(Buffer.from('PKzip')), 'x');
  assert.equal(md.mediaMarkdown(zip), `[📎 a.zip](${zip.url})`);
  assert.deepEqual(md.mediaIn(md.mediaMarkdown(pdf)), [pdf.id], 'pemakaian terlacak lewat url berekstensi');
  const get = async (id, range = '', dl = false) => {
    const res = new PassThrough(), chunks = []; let status, h;
    res.writeHead = (s, hd) => { status = s; h = hd; };
    res.on('data', c => chunks.push(c));
    const done = new Promise(r => res.on('end', r));
    md.sendMedia('shop', id, res, dl, range); await done;
    return { status, h, body: Buffer.concat(chunks).toString() };
  };
  const full = await get(pdf.id + '.pdf');
  assert.equal(full.h['Content-Type'], 'application/pdf'); assert.match(full.h['Content-Disposition'], /^inline;/); assert.ok(!full.h['Content-Security-Policy']);
  const part = await get(pdf.id, 'bytes=0-3');
  assert.equal(part.status, 206); assert.equal(part.body, '%PDF');
  assert.match((await get(pdf.id, '', true)).h['Content-Disposition'], /^attachment;/);
  const d = await get(doc.id + '.md');
  assert.match(d.h['Content-Disposition'], /^attachment;/); assert.match(d.h['Content-Security-Policy'], /sandbox/); assert.equal(d.body, '# Judul\n\nisi');
});
