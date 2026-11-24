import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-oc-test-'));
process.env.KANTOR_HOME = path.join(tmp, 'kantor');
const ev = await import('../server/opencode-events.js');
const oc = await import('../server/opencode.js');
const { engineOf, ENGINES } = await import('../server/codex.js');
const { buildEngineCatalog } = await import('../server/engines.js');
const store = await import('../server/store.js');
const offices = await import('../server/offices.js');
const { live, handleHook, expectSession } = await import('../server/live.js');
const { readTranscript } = await import('../server/transcript.js');
const { meetingOcConfig, meetingOcArgs } = await import('../server/meetings.js');
const { globalDb, one, closeAll } = await import('../server/db.js');
after(() => { closeAll(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('engine opencode persists on roles and sessions and is listed in the catalog', () => {
  assert.ok(ENGINES.includes('opencode')); assert.equal(engineOf('opencode'), 'opencode'); assert.equal(engineOf('bogus'), 'claude');
  const root = path.join(tmp, 'p1'); fs.mkdirSync(root);
  const office = offices.registerOffice(root);
  const r = store.createRole(office, { name: 'Oci', title: 'Dev', room: 'manager', engine: 'opencode', model: 'opencode-go/glm-5.3' });
  assert.equal(store.getRole(office, r.id).engine, 'opencode'); assert.equal(store.getRole(office, r.id).model, 'opencode-go/glm-5.3');
  const blank = store.createRole(office, { name: 'Oco', title: 'Dev', room: 'manager', engine: 'opencode' });
  assert.equal(store.getRole(office, blank.id).model, '', 'empty model = OpenCode default, not sonnet');
  expectSession({ sid: 'ses_kctest1', office, role: r.id, room: 'manager', cwd: root, engine: 'opencode', tmux: 'fixture' });
  assert.equal(one(globalDb(), 'SELECT engine FROM sessions WHERE sid = ?', 'ses_kctest1').engine, 'opencode');
  const cat = buildEngineCatalog({ claudeAvailable: true, codex: { available: false }, antigravity: { available: false },
    opencode: { available: true, models: ev.parseOcModels('opencode-go/glm-5.3\nopencode/big-pickle\n') } });
  const e = cat.engines.find(x => x.id === 'opencode');
  assert.equal(e.name, 'OpenCode'); assert.equal(e.available, true); assert.equal(e.allowDefaultModel, true);
  assert.deepEqual(e.models.map(m => m.slug), ['opencode-go/glm-5.3', 'opencode/big-pickle']);
  assert.deepEqual(e.permissionModes.map(m => m.id), ev.OC_MODES);
  assert.ok(e.permissionModes.find(m => m.id === 'bypassPermissions').warning);
  const off = buildEngineCatalog({ claudeAvailable: true, codex: {}, antigravity: {} }).engines.find(x => x.id === 'opencode');
  assert.equal(off.available, false);
});

test('models parser, model refs and modes', () => {
  assert.deepEqual(ev.parseOcModels('junk line\nopencode-go/kimi-k3\nopencode-go/kimi-k3\n\nError: x'), [{ slug: 'opencode-go/kimi-k3', name: 'kimi-k3', provider: 'opencode-go' }]);
  assert.deepEqual(ev.ocModelRef('opencode-go/glm-5.3#high'), { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' });
  assert.equal(ev.ocModelRef('sonnet'), null); assert.equal(ev.ocModelRef(''), null); assert.equal(ev.ocModelRef('a b/c'), null);
  assert.equal(ev.ocMode('readOnly'), 'plan'); assert.equal(ev.ocMode('auto'), 'default'); assert.equal(ev.ocMode('dontAsk'), 'default');
  assert.equal(ev.ocMode(''), 'default'); assert.equal(ev.ocMode('ikut', 'acceptEdits'), 'acceptEdits'); assert.equal(ev.ocMode('bypassPermissions'), 'bypassPermissions');
});

test('permission rules: safe default asks, bypass only when chosen, kantor MCP allowed, user deny rules kept last', () => {
  const find = (rules, action) => rules.filter(r => r.action === action).at(-1)?.effect;
  const def = ev.ocPermissions('default');
  for (const a of ['edit', 'shell', 'webfetch', 'external_directory']) assert.equal(find(def, a), 'ask', a);
  assert.equal(find(def, 'kantor_*'), 'allow'); assert.ok(!def.some(r => r.action === '*'));
  assert.equal(find(ev.ocPermissions('acceptEdits'), 'edit'), 'allow'); assert.equal(find(ev.ocPermissions('acceptEdits'), 'shell'), 'ask');
  assert.equal(find(ev.ocPermissions('plan'), 'edit'), 'deny');
  assert.deepEqual(ev.ocPermissions('bypassPermissions')[0], { action: '*', resource: '*', effect: 'allow' });
  assert.deepEqual(ev.ocPermissions('weird'), def);
  const kept = ev.ocPermissions('bypassPermissions', [{ action: 'shell', resource: 'rm *', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }]);
  assert.deepEqual(kept.at(-1), { action: 'shell', resource: 'rm *', effect: 'deny' });
  assert.ok(!kept.some(r => r.action === 'read'));
  const dir = path.join(tmp, 'occfg'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '// mine\n{ "permissions": [ {"action":"shell","resource":"git push *","effect":"deny"}, {"action":"edit","resource":"*","effect":"allow"} ] }');
  assert.deepEqual(oc.userDenyRules(dir), [{ action: 'shell', resource: 'git push *', effect: 'deny' }]);
  assert.deepEqual(oc.userDenyRules(path.join(tmp, 'nope')), []);
});

test('shift spec: identity in the MCP env, persona as instructions, no secrets of Kantor, unicode intact', () => {
  const sid = oc.newOcSessionId();
  assert.match(sid, /^ses_kc[0-9a-f]{24}$/); assert.ok(oc.isOcSessionId(sid)); assert.ok(!oc.isOcSessionId('3f2b-uuid'));
  const task = 'Perbaiki "login" — pakai `ünïcödé` dan \'kutip\' $HOME; echo hi';
  const spec = oc.ocSpec({ sid, cwd: '/tmp/w', officeId: 'kantor-a', roleId: 'oci', task, model: 'opencode-go/glm-5.3', mode: 'acceptEdits', bin: '/x/opencode', node: '/x/node', root: '/k', userDeny: [] });
  const k = spec.config.mcp.servers.kantor;
  assert.deepEqual(k.command, ['/x/node', '/k/server/mcp-stdio.js']);
  assert.equal(k.environment.KANTOR_OFFICE, 'kantor-a'); assert.equal(k.environment.KANTOR_ROLE, 'oci'); assert.equal(k.environment.KANTOR_SID, sid);
  assert.equal(k.codemode, false); assert.ok(!('KANTOR_TOKEN' in k.environment));
  assert.deepEqual(spec.config.instructions, [oc.ocFiles(sid).prompt]);
  assert.equal(spec.config.model, 'opencode-go/glm-5.3'); assert.equal(spec.config.share, 'disabled');
  assert.equal(spec.task, task); assert.equal(spec.mode, 'acceptEdits'); assert.ok(spec.password.length >= 30);
  assert.ok(!('model' in oc.ocSpec({ sid, cwd: '/tmp/w', officeId: 'a', roleId: 'b', bin: 'x', userDeny: [] }).config), 'empty model = OpenCode default');
  assert.notEqual(spec.password, oc.ocSpec({ sid, cwd: '/tmp/w', officeId: 'a', roleId: 'b', bin: 'x', userDeny: [] }).password);
});

test('tools and permission requests map to Kantor names; relative paths become absolute', () => {
  assert.deepEqual(ev.ocTool('kantor_sessions_list', { x: 1 }), { name: 'mcp__kantor__sessions_list', input: { x: 1 } });
  assert.equal(ev.ocTool('shell', { command: 'ls' }).input.command, 'ls');
  assert.equal(ev.ocTool('shell', {}).name, 'Bash');
  assert.equal(ev.ocTool('read', { path: 'a.txt' }, '/w').input.file_path, '/w/a.txt');
  assert.equal(ev.ocTool('write', { path: '/abs/b' }, '/w').input.file_path, '/abs/b');
  assert.equal(ev.ocTool('execute', { code: 'await tools.kantor.board_list(); tools.kantor.board_list()' }).input.description, 'kantor.board_list');
  assert.equal(ev.ocTool('subagent', { agent: 'explore', description: 'cari' }).name, 'Agent');
  assert.equal(ev.ocTool(undefined, null).name, 'Tool');
  assert.deepEqual(ev.ocPermissionTool({ action: 'shell', resources: ['echo hi'] }), { tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  assert.equal(ev.ocPermissionTool({ action: 'edit', resources: ['b.txt'], metadata: { files: [{ patch: '+ok' }] } }, '/w').tool_input.file_path, '/w/b.txt');
  assert.deepEqual(ev.ocPermissionTool({ action: 'kantor_card_update', resources: ['*'], metadata: { input: { id: 'c1' } } }), { tool_name: 'mcp__kantor__card_update', tool_input: { id: 'c1' } });
  assert.equal(ev.ocPermissionTool({ action: 'mystery', resources: ['*'] }).tool_name, 'mystery');
});

test('event stream → hook payloads: prompt, tools, permission, stop, interrupt, subagent; other sessions ignored', () => {
  const st = ev.createOcState({ sid: 'ses_A', cwd: '/w', transcript: '/t.jsonl' });
  const h = e => ev.mapOcEvent(e, st).hooks;
  assert.deepEqual(h({ type: 'session.execution.started', data: { sessionID: 'ses_OTHER' } }), []);
  assert.deepEqual(h({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_A', inboxID: 'm1', item: { type: 'user', payload: { text: 'halo "dunia" ✓' } } } }), []);
  assert.equal(h({ type: 'session.execution.started', data: { sessionID: 'ses_A' } })[0].hook_event_name, 'UserPromptSubmit');
  const del = ev.mapOcEvent({ type: 'session.inbox.delivered', data: { sessionID: 'ses_A', inboxID: 'm1' } }, st);
  assert.equal(del.hooks[0].prompt, 'halo "dunia" ✓'); assert.equal(del.snapshot, true);
  h({ type: 'session.step.started', data: { sessionID: 'ses_A', model: { providerID: 'opencode-go', id: 'glm-5.3' } } });
  h({ type: 'session.tool.input.started', data: { sessionID: 'ses_A', id: 'c1', name: 'shell' } });
  const pre = h({ type: 'session.tool.called', data: { sessionID: 'ses_A', id: 'c1', input: { command: 'echo hi' } } })[0];
  assert.equal(pre.hook_event_name, 'PreToolUse'); assert.equal(pre.tool_name, 'Bash'); assert.equal(pre.tool_use_id, 'c1');
  assert.equal(pre.model, 'opencode-go/glm-5.3'); assert.equal(pre.kantor_engine, 'opencode'); assert.equal(pre.kantor_sid, 'ses_A'); assert.equal(pre.transcript_path, '/t.jsonl');
  const perm = h({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_A', action: 'shell', resources: ['echo hi'], source: { id: 'c1' } } })[0];
  assert.equal(perm.hook_event_name, 'PermissionRequest'); assert.equal(perm.kantor_permission_id, 'per_1'); assert.equal(perm.tool_use_id, 'c1');
  const post = h({ type: 'session.tool.success', data: { sessionID: 'ses_A', id: 'c1', content: [{ type: 'text', text: 'hi\n' }] } })[0];
  assert.equal(post.hook_event_name, 'PostToolUse'); assert.equal(post.tool_input.command, 'echo hi');
  h({ type: 'session.tool.input.started', data: { sessionID: 'ses_A', id: 'c2', name: 'read' } });
  const fail = h({ type: 'session.tool.failed', data: { sessionID: 'ses_A', id: 'c2', error: { message: 'nope' } } })[0];
  assert.equal(fail.hook_event_name, 'PostToolUseFailure'); assert.equal(fail.error, 'nope');
  assert.equal(h({ type: 'session.created', data: { session: { id: 'ses_child', parentID: 'ses_A', agent: 'explore' } } })[0].hook_event_name, 'SubagentStart');
  assert.equal(h({ type: 'session.tool.called', data: { sessionID: 'ses_child', id: 'k1', name: 'grep', input: {} } })[0].agent_id, 'ses_child');
  assert.deepEqual(h({ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_child', action: 'shell', resources: ['x'] } }), []);
  assert.equal(h({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } })[0].hook_event_name, 'SubagentStop');
  assert.equal(h({ type: 'session.execution.failed', data: { sessionID: 'ses_A', error: { message: 'region' } } })[0].kantor_error, 'region');
  assert.equal(h({ type: 'session.execution.interrupted', data: { sessionID: 'ses_A' } })[0].hook_event_name, 'Interrupt');
  assert.deepEqual(h(null), []); assert.deepEqual(h({ type: 'session.tool.success', data: null }), []);
});

test('hook payloads drive session status, inbox and a terminal-answered permission', async () => {
  const root = path.join(tmp, 'p2'); fs.mkdirSync(root);
  const office = offices.registerOffice(root);
  const r = store.createRole(office, { name: 'Oca', title: 'Dev', room: 'manager', engine: 'opencode' });
  expectSession({ sid: 'ses_B', office, role: r.id, room: 'manager', cwd: root, engine: 'opencode', tmux: 'fixture-b' });
  const st = ev.createOcState({ sid: 'ses_B', cwd: root });
  const run = async e => { for (const p of ev.mapOcEvent(e, st).hooks) await handleHook(p); };
  await run({ type: 'session.execution.started', data: { sessionID: 'ses_B' } });
  assert.equal(live.get('ses_B').status, 'working');
  await run({ type: 'session.tool.input.started', data: { sessionID: 'ses_B', id: 'c9', name: 'kantor_board_list' } });
  await run({ type: 'session.tool.called', data: { sessionID: 'ses_B', id: 'c9', input: {} } });
  assert.equal(live.get('ses_B').tool.id, 'c9');
  // a permission that is answered in the terminal: the inbox card closes without waiting for the hold to time out
  const p = ev.mapOcEvent({ type: 'permission.asked', data: { id: 'per_9', sessionID: 'ses_B', action: 'shell', resources: ['ls'], source: { id: 'c9' } } }, st).hooks[0];
  const held = handleHook(p);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(live.get('ses_B').status, 'waiting');
  await handleHook({ session_id: 'ses_B', hook_event_name: 'PermissionResolved', kantor_engine: 'opencode', kantor_sid: 'ses_B', kantor_permission_id: 'per_9' });
  assert.equal(await held, null);
  assert.equal(live.get('ses_B').waiting, null);
  assert.equal(one(globalDb(), "SELECT status FROM inbox WHERE sid = 'ses_B'").status, 'terminal');
  await run({ type: 'session.execution.succeeded', data: { sessionID: 'ses_B' } });
  assert.equal(live.get('ses_B').status, 'idle');
  assert.equal(live.get('ses_B').engine, 'opencode');
});

test('transcript snapshot → chat items without reasoning; file name dispatch', () => {
  const file = path.join(tmp, 'ses_T.opencode.jsonl');
  const msgs = [
    { id: 'm1', type: 'user', text: 'Tolong cek "a.txt" ✓', time: { created: 1 } },
    { id: 'm2', type: 'assistant', time: { created: 2, completed: 3 }, content: [{ type: 'reasoning', text: 'RAHASIA' },
      { type: 'tool', name: 'kantor_sessions_list', state: { status: 'completed', input: {}, content: [{ type: 'text', text: '[]' }] } },
      { type: 'tool', name: 'shell', state: { status: 'error', input: { command: 'false' }, content: [{ type: 'text', text: 'exit 1' }] } }] },
    { id: 'm3', type: 'assistant', time: { created: 4, completed: 5 }, content: [{ type: 'text', text: 'Selesai.' }] },
    { id: 'm4', type: 'idle', outcome: 'succeeded' },
  ];
  fs.writeFileSync(file, msgs.map(m => JSON.stringify(m)).join('\n') + '\n');
  assert.ok(ev.isOcTranscript(file)); assert.ok(!ev.isOcTranscript('/x/rollout-1.jsonl'));
  const { items } = readTranscript(file, 50);
  assert.deepEqual(items.map(i => i.k), ['user', 'tool', 'result', 'tool', 'result', 'text']);
  assert.equal(items[0].s, 'Tolong cek "a.txt" ✓'); assert.equal(items[1].name, 'mcp__kantor__sessions_list');
  assert.equal(items[4].err, true); assert.equal(items.at(-1).s, 'Selesai.');
  assert.ok(!JSON.stringify(items).includes('RAHASIA'));
  fs.appendFileSync(file, JSON.stringify({ id: 'm5', type: 'user', text: 'lagi' }) + '\n');
  assert.equal(readTranscript(file, 50).items.at(-1).s, 'lagi');
});

test('meeting config denies everything but reading, and only when research is allowed', () => {
  const withTools = meetingOcConfig('/p.md', true), none = meetingOcConfig('/p.md', false);
  assert.deepEqual(withTools.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(withTools.permissions.some(r => r.action === 'read' && r.effect === 'allow'));
  assert.deepEqual(none.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.deepEqual(none.mcp, { servers: {} });
  const a = meetingOcArgs({ name: 'Oci', model: 'opencode-go/glm-5.3' }, 'Pendapatmu?');
  assert.ok(a.includes('--standalone') && a.includes('--archived')); assert.equal(a.at(-1), 'Pendapatmu?');
  assert.ok(!meetingOcArgs({ name: 'Oci', model: 'sonnet' }, 'x').includes('-m'), 'a non-OpenCode model is not passed');
});

// A fake `opencode` binary: `serve` is a tiny HTTP server speaking the bits of the v2 API the supervisor uses;
// the TUI just waits. Exercises hooks/opencode-run.cjs end to end without a real model.
test('supervisor: private server, session prepared with permissions, first task sent, events forwarded, snapshot, clean exit', { timeout: 30000 }, async () => {
  const dir = path.join(tmp, 'sup'); fs.mkdirSync(dir);
  const calls = [], hooks = [];
  const daemon = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hooks.push(JSON.parse(b)); res.end(JSON.stringify(null)); }); });
  await new Promise(r => daemon.listen(0, '127.0.0.1', r));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port: daemon.address().port, token: 't' }));
  const log = path.join(dir, 'fake.log');
  const fake = path.join(dir, 'opencode');
  fs.writeFileSync(fake, `#!${process.execPath}
const http = require('http'), fs = require('fs');
const log = m => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
if (process.argv[2] !== 'serve') { log({ tui: process.argv.slice(2), pw: process.env.OPENCODE_PASSWORD, cfg: !!process.env.OPENCODE_CONFIG_CONTENT }); setTimeout(() => process.exit(0), 1500); return; }
log({ serve: true, cfg: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), pw: process.env.OPENCODE_SERVER_PASSWORD });
const subs = [];
const emit = e => subs.forEach(s => s.write('data: ' + JSON.stringify(e) + '\\n\\n'));
const srv = http.createServer((req, res) => {
  const ok = req.headers.authorization === 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  if (!ok) { res.statusCode = 401; return res.end('{}'); }
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    log({ m: req.method, u: req.url, b: b ? JSON.parse(b) : null, dir: req.headers['x-opencode-directory'] });
    if (req.url === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); subs.push(res); res.write('data: {"type":"server.connected","data":{}}\\n\\n'); return; }
    if (req.method === 'GET' && /\\/api\\/session\\/[^/]+$/.test(req.url)) { res.statusCode = 404; return res.end('{"message":"not found"}'); }
    if (req.url.includes('/message')) return res.end(JSON.stringify({ data: [{ id: 'u1', type: 'user', text: 'tugas' }, { id: 'a1', type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: 'beres' }] }], cursor: {} }));
    if (req.url.endsWith('/prompt')) { const sid = req.url.split('/')[3];
      setTimeout(() => { emit({ type: 'session.inbox.enqueued', data: { sessionID: sid, inboxID: 'i1', item: { type: 'user', payload: JSON.parse(b) } } });
        emit({ type: 'session.execution.started', data: { sessionID: sid } }); emit({ type: 'session.inbox.delivered', data: { sessionID: sid, inboxID: 'i1' } });
        emit({ type: 'session.execution.succeeded', data: { sessionID: sid } }); }, 50); }
    res.end('{"data":{}}');
  });
});
srv.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + srv.address().port));
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });
  const sid = 'ses_kcsupervisortest01', task = 'Kerjakan "x" — ünïcödé';
  const spec = oc.ocSpec({ sid, cwd: dir, officeId: 'o', roleId: 'r', task, model: 'opencode-go/glm-5.3', mode: 'default', bin: fake, kantorHome: home, userDeny: [] });
  Object.assign(spec, { transcript: path.join(dir, 't.opencode.jsonl'), state: path.join(dir, 'state.json'), log: path.join(dir, 'server.log') });
  const specFile = path.join(dir, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../hooks/opencode-run.cjs'), specFile], { stdio: 'ignore' });
  const code = await new Promise(r => child.on('exit', r));
  daemon.close();
  assert.equal(code, 0);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const serve = lines.find(l => l.serve);
  assert.equal(serve.pw, spec.password); assert.equal(serve.cfg.mcp.servers.kantor.environment.KANTOR_SID, sid);
  const create = lines.find(l => l.m === 'POST' && l.u === '/api/session');
  assert.equal(create.b.id, sid); assert.deepEqual(create.b.permissions, spec.permissions); assert.deepEqual(create.b.model, { providerID: 'opencode-go', id: 'glm-5.3' });
  assert.equal(create.dir, dir);
  assert.equal(lines.find(l => l.u?.endsWith('/prompt')).b.text, task);
  const tui = lines.find(l => l.tui);
  assert.deepEqual(tui.tui.slice(2, 4), ['--session', sid]); assert.equal(tui.pw, spec.password); assert.equal(tui.cfg, false);
  const names = hooks.map(h => h.hook_event_name);
  for (const n of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) assert.ok(names.includes(n), n);
  assert.equal(hooks.find(h => h.prompt)?.prompt, task);
  assert.ok(hooks.every(h => h.session_id === sid && h.kantor_engine === 'opencode'));
  assert.deepEqual(fs.readFileSync(spec.transcript, 'utf8').trim().split('\n').map(l => JSON.parse(l).id), ['u1', 'a1']);
  assert.ok(!fs.existsSync(spec.state), 'state file removed after exit');
});
