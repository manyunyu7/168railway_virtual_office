import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-cx-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x', approvals: { holdKantorSec: 0, holdManualSec: 0 } }));
const cx = await import('../server/codex.js');
const live = await import('../server/live.js');
const tm = await import('../server/tmux.js');
const { setCodexModel, setCodexMode } = await import('../server/codexpick.js');
const { readTranscript } = await import('../server/transcript.js');

/* ---------------- CLI arguments ---------------- */
test('codex modes map to explicit CLI flags, and Claude mode names fall back safely', () => {
  assert.deepEqual(cx.codexModeArgs('default'), ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']);
  assert.deepEqual(cx.codexModeArgs('auto'), ['--approve-for-me']);
  assert.deepEqual(cx.codexModeArgs('readOnly'), ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
  assert.deepEqual(cx.codexModeArgs('bypassPermissions'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(cx.codexMode('plan'), 'readOnly');
  assert.equal(cx.codexMode('acceptEdits'), 'default');
  assert.equal(cx.codexMode('ikut'), 'default');
  assert.equal(cx.codexMode(null), 'default');
});

test('codex shift arguments: hooks per session, trust, model, effort, instructions, MCP without a token', () => {
  const a = cx.codexArgs({ model: 'gpt-6.1-sol', effort: 'low', mode: 'auto', cwd: '/work/my repo', task: 'Kerjakan "X"',
    instructions: 'Baris 1\nBaris "2" \\ akhir', mcp: { command: '/usr/bin/node', args: ['/k/mcp-stdio.js'], env: { KANTOR_OFFICE: 'o', KANTOR_ROLE: 'r', KANTOR_SID: 's' } } });
  const joined = a.join('\n');
  assert.ok(a.includes('--dangerously-bypass-hook-trust'));
  assert.ok(a.includes('--approve-for-me'));
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'gpt-6.1-sol']);
  assert.ok(a.includes('model_reasoning_effort="low"'));
  assert.ok(a.includes('projects={"/work/my repo"={trust_level="trusted"}}'));
  assert.ok(a.includes('project_doc_fallback_filenames=["CLAUDE.md"]'));
  const instr = a.find(x => x.startsWith('developer_instructions='));
  assert.equal(JSON.parse(instr.slice('developer_instructions='.length)), 'Baris 1\nBaris "2" \\ akhir'); // valid TOML basic string == JSON string
  const mcp = a.find(x => x.startsWith('mcp_servers.kantor='));
  assert.match(mcp, /command="\/usr\/bin\/node"/);
  assert.match(mcp, /env=\{KANTOR_OFFICE="o",KANTOR_ROLE="r",KANTOR_SID="s"\}/);
  assert.match(mcp, /default_tools_approval_mode="approve"/);
  assert.ok(!/token/i.test(mcp));
  for (const ev of cx.CODEX_HOOK_EVENTS) assert.ok(a.some(x => x.startsWith(`hooks.${ev}=`)), ev);
  assert.match(a.find(x => x.startsWith('hooks.PermissionRequest=')), /timeout=600/);
  assert.match(a.find(x => x.startsWith('hooks.Interrupt=')), /timeout=2/);
  assert.match(a.find(x => x.startsWith('hooks.Stop=')), /kantor-hook\.cjs/);
  assert.deepEqual(a.slice(-2), ['--', 'Kerjakan "X"']);
  assert.ok(!joined.includes('auth'));
});

test('resume puts the session id first and sends no new task', () => {
  const a = cx.codexArgs({ resumeSid: '01a1-abc', task: 'abaikan', mode: 'default' });
  assert.deepEqual(a.slice(0, 3), ['resume', '01a1-abc', '--dangerously-bypass-hook-trust']);
  assert.ok(!a.includes('--'));
});

test('launch script exports the session env, quotes every argument and never contains an auth token', () => {
  const sh = cx.codexScript({ bin: '/opt/homebrew/bin/codex', args: ['-c', "x='y'"], env: { KANTOR_SID: 'abc', KANTOR_ENGINE: 'codex', KANTOR_HOME: '' } });
  assert.match(sh, /^#!\/bin\/zsh\n/);
  assert.match(sh, /export KANTOR_SID='abc'/);
  assert.ok(!sh.includes('KANTOR_HOME'));
  assert.match(sh, /exec '\/opt\/homebrew\/bin\/codex' '-c' 'x='\\''y'\\'''/);
});

test('toml strings survive newlines, quotes and the characters TOML forbids', () => {
  assert.equal(cx.tomlStr('a\u007fb\u2028c'), '"a b c"');
  assert.equal(cx.tomlStr('tab\tnl\n"q"'), '"tab\\tnl\\n\\"q\\""');
});

/* ---------------- models ---------------- */
test('parseModels keeps listed models in priority order with their efforts', () => {
  const m = cx.parseModels({ models: [
    { slug: 'b', display_name: 'B', priority: 2, visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low', description: 'l' }, { effort: 'medium', description: 'm' }] },
    { slug: 'hidden', visibility: 'hide', priority: 0 },
    { slug: 'a', display_name: 'A', priority: 1, description: 'desc', supported_reasoning_levels: [] }] });
  assert.deepEqual(m.map(x => x.slug), ['a', 'b']);
  assert.deepEqual(m[1].efforts.map(e => e.effort), ['low', 'medium']);
  assert.equal(m[1].defaultEffort, 'medium');
  assert.deepEqual(cx.parseModels(null), []);
});

/* ---------------- screens ---------------- */
const MODEL_SCREEN = `
  Select Model and Effort
› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.
  2. GPT-6-Astra            Frontier intelligence for the most demanding work.
  3. GPT-5.6-Luna           Older fast and efficient model.
  enter select · esc back`;
const EFFORT_SCREEN = `
  Select Reasoning Level for GPT-6-Astra
  1. Low               Fast responses with lighter reasoning
› 2. Medium (default)  Balances speed and reasoning depth for everyday tasks
  3. High              Greater reasoning depth for complex problems
  4. Extra high        Extra high reasoning depth for complex problems
  5. More reasoning…   Max and Ultra consume usage limits faster
  enter default · s session · esc back`;
const PERM_SCREEN = `
  Update Model Permissions
› 1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace
  2. Approve for me              Only ask for actions detected as potentially unsafe
  3. Full Access                 Use with caution: Codex can edit files outside this workspace and access the internet without approval
  4. Read Only                   Read workspace files, with approval required for edits or internet access
  enter select · esc back`;
const ADV_SCREEN = `
  Advanced Reasoning
  ⚠ Consumes usage limits faster
› 1. Max    For difficult problems when quality matters more than speed · higher usage
  2. Ultra  For demanding work using multiple agents · highest usage
  enter default · s session · esc back`;

test('model picker rows: label, description, current and cursor', () => {
  const rows = cx.parseModelPicker(MODEL_SCREEN);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { index: 1, label: 'GPT-6.1-Sol', raw: 'GPT-6.1-Sol (current)', desc: 'Latest workhorse model for coding and everyday work.', current: true, isDefault: false, cursor: true });
  assert.equal(rows[2].label, 'GPT-5.6-Luna');
  assert.equal(cx.parseModelPicker('nothing here'), null);
});

test('effort picker, "more reasoning" screen and permission preset rows', () => {
  const e = cx.parseEffortPicker(EFFORT_SCREEN);
  assert.deepEqual(e.map(r => r.label), ['Low', 'Medium', 'High', 'Extra high', 'More reasoning…']);
  assert.equal(e.find(r => r.isDefault).label, 'Medium');
  assert.equal(e.find(r => r.cursor).index, 2);
  assert.ok(cx.effortLabelRe('xhigh').test('Extra high'));
  assert.deepEqual(cx.parseEffortPicker(ADV_SCREEN).map(r => r.label), ['Max', 'Ultra']);
  const p = cx.parsePermPicker(PERM_SCREEN);
  assert.equal(p.find(r => r.current).label, 'Ask for approval');
  for (const m of cx.CODEX_MODES) assert.equal(p.filter(r => cx.modeLabelRe(m).test(r.label)).length, 1, m);
});

test('codexScreen tells working, approval dialog, picker and idle composer apart', () => {
  const idle = '• selesai\n  Worked for 8s\n› Ask Codex to do anything\n  GPT-6.1-Sol low · /tmp/x\n  ? for shortcuts';
  assert.deepEqual(cx.codexScreen(idle), { picker: null, approval: false, busy: false, composer: true, idle: true });
  assert.equal(cx.codexScreen('• Working (5s • esc to interrupt)\n› Ask Codex to do anything\n  ? for shortcuts').busy, true);
  const dlg = '• Running touch a\n  Would you like to run the following command?\n  $ touch a\n› 1. Yes, proceed (y)\n  3. No, and tell Codex what to do differently (esc)\n  Press enter to confirm or esc to cancel';
  const d = cx.codexScreen(dlg);
  assert.equal(d.approval, true); assert.equal(d.idle, false);
  assert.equal(cx.codexScreen(MODEL_SCREEN).picker, 'model');
  assert.equal(cx.codexScreen(EFFORT_SCREEN).picker, 'effort');
  assert.equal(cx.codexScreen(ADV_SCREEN).picker, 'effort');
  assert.equal(cx.codexScreen(PERM_SCREEN).picker, 'permissions');
});

test('footer shows the active model and effort', () => {
  assert.deepEqual(cx.footerModel('› Ask Codex\n  GPT-6-Astra low · /tmp/x · Jalankan perintah\n  ? for shortcuts'), { name: 'GPT-6-Astra', effort: 'low' });
  assert.deepEqual(cx.footerModel('  GPT-6.1-Sol extra high · /tmp'), { name: 'GPT-6.1-Sol', effort: 'xhigh' });
  assert.equal(cx.footerModel('nothing'), null);
});

/* ---------------- hooks ---------------- */
const PATCH = '*** Begin Patch\n*** Update File: src/app/main.go\n@@\n-a\n+b\n*** Add File: docs/new.md\n+hi\n*** End Patch';
test('hook payloads from Codex are mapped to the names the office already knows', () => {
  assert.deepEqual(cx.patchFiles(PATCH), [{ op: 'update', path: 'src/app/main.go' }, { op: 'add', path: 'docs/new.md' }]);
  const e = cx.normalizeHook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH } });
  assert.equal(e.tool_name, 'Edit'); assert.equal(e.tool_input.file_path, 'src/app/main.go'); assert.deepEqual(e.tool_input.files, ['src/app/main.go', 'docs/new.md']);
  const w = cx.normalizeHook({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch' } });
  assert.equal(w.tool_name, 'Write');
  assert.equal(cx.normalizeHook({ tool_name: 'update_plan', tool_input: { plan: [{}, {}] } }).tool_input.todos.length, 2);
  assert.equal(cx.normalizeHook({ tool_name: 'spawn_agent', tool_input: { agent_type: 'explorer', message: 'cari' } }).tool_name, 'Agent');
  const b = cx.normalizeHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(b.tool_name, 'Bash'); assert.equal(b.tool_input.command, 'ls');
  assert.equal(cx.normalizeHook(null), null);
});

test('a Codex session through the hook handler: engine, tool, label, permission inbox, interrupt', async () => {
  const sid = 'codex-thread-1';
  const base = { session_id: sid, cwd: tmp, kantor_engine: 'codex', model: 'gpt-6.1-sol', permission_mode: 'default' };
  await live.handleHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await live.handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'ubah main.go' });
  let s = live.live.get(sid);
  assert.equal(s.engine, 'codex'); assert.equal(s.status, 'working'); assert.equal(s.model, 'gpt-6.1-sol');
  await live.handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_use_id: 'u1' });
  assert.equal(s.tool.name, 'Edit'); assert.equal(s.tool.label, 'main.go');
  await live.handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_use_id: 'u1' });
  assert.equal(s.tool, null);
  await live.handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__kantor__board_list', tool_input: {}, tool_use_id: 'u2' });
  assert.equal(s.tool.name, 'kantor');
  const res = await live.handleHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf x', description: 'hapus' } });
  assert.equal(res, null); // no hold configured: Codex shows its own prompt
  assert.equal(live.openInbox().find(i => i.sid === sid)?.summary, 'rm -rf x');
  assert.equal(live.serialize(s).engine, 'codex');
  await live.handleHook({ ...base, hook_event_name: 'Interrupt' });
  assert.equal(s.status, 'idle'); assert.equal(s.waiting, null);
  await live.handleHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'selesai' });
  assert.equal(s.status, 'idle');
  // the permission mode comes from the rollout, not from the hook's constant "default"
  assert.equal(s.permMode ?? null, null);
});

test('an unrelated tool finishing does not release a held permission (it used to fall through to the TUI prompt)', async () => {
  assert.equal(live.finishedWaitingTool({ tool: 'write_stdin', toolUseId: 'a' }, { tool_name: 'Bash', tool_use_id: 'b' }), false);
  assert.equal(live.finishedWaitingTool({ tool: 'write_stdin', toolUseId: 'a' }, { tool_name: 'write_stdin', tool_use_id: 'a' }), true);
  assert.equal(live.finishedWaitingTool({ tool: 'write_stdin' }, { tool_name: 'Bash', tool_use_id: 'b' }), false);
  assert.equal(live.finishedWaitingTool({ tool: 'Bash' }, { tool_name: 'Bash', tool_use_id: 'b' }), true);
  const sid = 'codex-thread-hold';
  const base = { session_id: sid, cwd: tmp, kantor_engine: 'codex' };
  await live.handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  const s = live.live.get(sid);
  await live.handleHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'write_stdin', tool_input: { chars: '\u0003' }, tool_use_id: 'w1' });
  assert.ok(s.waiting);
  await live.handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'other' });
  assert.ok(s.waiting, 'still waiting for the inbox');
  await live.handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'write_stdin', tool_input: {}, tool_use_id: 'w1' });
  assert.equal(s.waiting, null);
});

/* ---------------- rollout ---------------- */
const line = (type, payload, timestamp = '2026-10-21T13:00:00.000Z') => JSON.stringify({ timestamp, type, payload });
const item = it => line('event_msg', { type: 'item_completed', item: it });
function rollout(extra = []) {
  const f = path.join(tmp, `rollout-${Math.random().toString(36).slice(2)}.jsonl`);
  const rows = [
    line('session_meta', { id: 'x', cwd: tmp }),
    line('event_msg', { type: 'task_started', turn_id: 't1', model_context_window: 400000 }),
    line('turn_context', { turn_id: 't1', approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_policy: { type: 'read-only' }, effort: 'high', model: 'gpt-6.1-sol' }),
    item({ type: 'UserMessage', content: [{ type: 'text', text: 'ubah file' }] }),
    item({ type: 'UserMessage', content: [{ type: 'text', text: '<environment_context>x</environment_context>' }] }),
    item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Saya kerjakan.' }], phase: 'commentary' }),
    item({ type: 'Reasoning', summary: [] }),
    item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'ls -la'], aggregated_output: 'a\nb\n', exit_code: 0 }),
    item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'false'], aggregated_output: '', exit_code: 1 }),
    item({ type: 'FileChange', status: 'completed', changes: { '/p/a.js': { type: 'update', unified_diff: '@@ -1,2 +1,3 @@\n x\n+y\n+z\n-w\n' }, '/p/new.md': { type: 'add', content: 'l1\nl2\n' } } }),
    item({ type: 'McpToolCall', server: 'kantor', tool: 'board_list', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: '{"kartu":[]}' }] } }),
    item({ type: 'ContextCompaction', id: 'c' }),
    line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 40000, total_tokens: 40500 }, model_context_window: 400000 } }),
    item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'selesai' }], phase: 'final_answer' }),
    ...extra,
  ];
  fs.writeFileSync(f, rows.join('\n') + '\n');
  return f;
}

test('rollout becomes the same chat items as a Claude transcript', () => {
  const f = rollout();
  assert.ok(cx.isRollout(f));
  const { items } = readTranscript(f, 50);
  assert.deepEqual(items.map(i => `${i.k}:${i.name || ''}`), ['user:', 'text:', 'tool:Bash', 'result:', 'tool:Bash', 'result:', 'tool:Edit', 'tool:Write', 'tool:mcp__kantor__board_list', 'result:', 'text:']);
  assert.equal(items[0].s, 'ubah file');
  assert.equal(items[2].s, 'Bash ls -la');
  assert.equal(items[3].s, 'a\nb'); assert.equal(items[3].err, false);
  assert.equal(items[5].err, true); assert.equal(items[5].s, 'exit 1');
  assert.deepEqual([items[6].s, items[6].add, items[6].del], ['Edit a.js', 2, 1]);
  assert.deepEqual([items[7].s, items[7].add, items[7].del], ['Write new.md', 2, 0]);
  assert.match(items[8].s, /^mcp__kantor__board_list/);
  assert.equal(items.at(-1).s, 'selesai');
  assert.equal(readTranscript(f, 3).items.length, 3);
  assert.equal(readTranscript(path.join(tmp, 'nope.jsonl')).missing, true);
});

test('a Claude transcript is not mistaken for a rollout', () => {
  const f = path.join(tmp, 'claude.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'halo' }, timestamp: 't' }) + '\n');
  assert.equal(cx.isRollout(f), false);
  assert.equal(readTranscript(f, 5).items[0].s, 'halo');
});

test('settings and context health are read from the rollout', () => {
  const f = rollout();
  assert.deepEqual(cx.readCodexSettings(f), { model: 'gpt-6.1-sol', effort: 'high', mode: 'readOnly' });
  assert.equal(cx.modeFromSettings({ approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } }), 'bypassPermissions');
  assert.equal(cx.modeFromSettings({ approval_policy: 'never', permission_profile: { type: 'disabled' } }), 'bypassPermissions');
  assert.equal(cx.modeFromSettings({ approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_policy: { type: 'workspace-write' } }), 'auto');
  assert.equal(cx.modeFromSettings({ approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_policy: { type: 'workspace-write' } }), 'default');
  const h = cx.codexHealth(f);
  assert.deepEqual([h.ctx.used, h.ctx.limit, h.ctx.pct, h.health, h.compactions], [40000, 400000, 10, 'segar', 1]);
  assert.deepEqual(cx.codexHealth(null), { ctx: null, health: null, errStreak: 0, compactions: 0 });
});

/* ---------------- driving the real menus (a stand-in TUI in tmux) ---------------- */
const tmuxOk = (() => { try { return !!tm.bins().tmux; } catch { return false; } })();
const fakeTui = path.join(tmp, 'fake-codex.js');
fs.writeFileSync(fakeTui, `
const MODELS = [['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6-luna', 'GPT-6-Luna']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['more', 'More reasoning…']];
const ADV = [['max', 'Max'], ['ultra', 'Ultra']];
const PERMS = [['default', 'Ask for approval'], ['auto', 'Approve for me'], ['bypassPermissions', 'Full Access'], ['readOnly', 'Read Only']];
let model = 0, effort = 'medium', perm = 'default', screen = 'idle', cur = 0, picked = 0, msgs = [], typed = '';
const rows = () => screen === 'model' ? MODELS.map((m, i) => [m[1] + (i === model ? ' (current)' : ''), 'desc'])
  : screen === 'effort' ? EFFORTS.map(e => [e[1] + (e[0] === 'medium' ? ' (default)' : ''), 'd']) : screen === 'adv' ? ADV.map(e => [e[1], 'd'])
  : PERMS.map(p => [p[1] + (p[0] === perm ? ' (current)' : ''), 'd']);
const title = { model: 'Select Model and Effort', effort: 'Select Reasoning Level for ' + MODELS[picked][1], adv: 'Advanced Reasoning', perm: 'Update Model Permissions' };
function draw() {
  process.stdout.write('\\x1b[2J\\x1b[H');
  for (const m of msgs.slice(-6)) console.log('• ' + m);
  if (screen === 'idle') { console.log('› ' + typed); console.log('  ' + MODELS[model][1] + ' ' + effort + ' · /tmp/x'); console.log('  ? for shortcuts'); return; }
  console.log('  ' + title[screen]);
  rows().forEach((r, i) => console.log((i === cur ? '› ' : '  ') + (i + 1) + '. ' + r[0].padEnd(24) + r[1]));
  console.log(screen === 'model' || screen === 'perm' ? '  enter select · esc back' : '  enter default · s session · esc back');
}
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', d => {
  const k = d.toString();
  if (screen === 'idle') {
    if (k === '\\r') { if (typed === '/model') { screen = 'model'; cur = model; } else if (typed === '/permissions') { screen = 'perm'; cur = PERMS.findIndex(p => p[0] === perm); } typed = ''; }
    else if (k === '\\x15') typed = ''; else typed += k.replace(/[^ -~]/g, '');
  } else if (k === '\\x1b[B') cur = (cur + 1) % rows().length;
  else if (k === '\\x1b[A') cur = (cur - 1 + rows().length) % rows().length;
  else if (k === '\\x1b') screen = screen === 'effort' || screen === 'adv' ? 'model' : 'idle';
  else if (k === '\\r') {
    if (screen === 'model') { picked = cur; screen = 'effort'; cur = 1; }
    else if (screen === 'effort' && EFFORTS[cur][0] === 'more') { screen = 'adv'; cur = 0; }
    else if (screen === 'perm') { perm = PERMS[cur][0]; msgs.push('Permission selection requested: ' + PERMS[cur][1]); screen = 'idle'; }
  } else if (k === 's' && (screen === 'effort' || screen === 'adv')) {
    model = picked; effort = screen === 'adv' ? ADV[cur][0] : EFFORTS[cur][0]; msgs.push('Model changed to ' + MODELS[model][0] + ' ' + effort + ' for this session only'); screen = 'idle';
  }
  draw();
});
draw();
`);

test('setCodexModel and setCodexMode drive Codex menus by text, session only', { skip: !tmuxOk }, async () => {
  const name = `kcx-test-${process.pid}`;
  const sid = 'cx-pick-1';
  tm.tmux(['new-session', '-d', '-s', name, '-x', '160', '-y', '40', process.execPath, fakeTui]);
  try {
    live.expectSession({ sid, office: null, role: null, room: null, cwd: tmp, tmux: name, slot: 0, title: 't', engine: 'codex', effort: 'medium' });
    await new Promise(r => setTimeout(r, 600));
    const cap = () => tm.capture(name, 40);
    // model + effort together
    assert.deepEqual(await setCodexModel(sid, { model: 'gpt-6-luna', effort: 'high' }), { ok: true, model: 'gpt-6-luna', effort: 'high' });
    assert.match(cap(), /GPT-6-Luna high/);
    // effort only keeps the model; max/ultra sit behind "More reasoning…"
    assert.deepEqual(await setCodexModel(sid, { effort: 'ultra' }), { ok: true, model: 'gpt-6-luna', effort: 'ultra' });
    // the same change twice still gets its own confirmation
    assert.deepEqual(await setCodexModel(sid, { model: 'gpt-6-luna', effort: 'ultra' }), { ok: true, model: 'gpt-6-luna', effort: 'ultra' });
    // no effort given: kept when the model has it
    assert.equal((await setCodexModel(sid, { model: 'gpt-6-astra' })).effort, 'ultra');
    assert.equal(live.live.get(sid).effort, 'ultra');
    await assert.rejects(() => setCodexModel(sid, { effort: 'nonsense!' }), /tidak valid/);
    // modes by label, and read back through /permissions
    assert.deepEqual(await setCodexMode(sid, 'readOnly'), { mode: 'readOnly' });
    assert.deepEqual(await setCodexMode(sid, 'bypassPermissions'), { mode: 'bypassPermissions' });
    assert.equal(live.live.get(sid).permMode, 'bypassPermissions');
    assert.deepEqual(await setCodexMode(sid, 'default'), { mode: 'default' });
    await assert.rejects(() => setCodexMode(sid, 'plan'), /Mode tidak dikenal/);
    // routed through the same function the web and phone use
    assert.deepEqual(await tm.setPermMode(sid, 'auto'), { mode: 'auto' });
    assert.match(cap(), /^›$/m); // no menu left open, composer empty
  } finally { try { tm.tmux(['kill-session', '-t', name]); } catch {} live.live.delete(sid); }
});

test('model and mode changes refuse a busy or non-Codex session', { skip: !tmuxOk }, async () => {
  const name = `kcx-test-b-${process.pid}`;
  tm.tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '30', '/bin/sh', '-c', 'echo "• Working (3s • esc to interrupt)"; echo "› Ask Codex"; sleep 30']);
  try {
    live.expectSession({ sid: 'cx-busy', office: null, role: null, room: null, cwd: tmp, tmux: name, slot: 0, title: 't', engine: 'codex' });
    live.expectSession({ sid: 'cl-1', office: null, role: null, room: null, cwd: tmp, tmux: name, slot: 0, title: 't', engine: 'claude' });
    await new Promise(r => setTimeout(r, 300));
    await assert.rejects(() => setCodexModel('cx-busy', { effort: 'low' }), /sedang bekerja/);
    await assert.rejects(() => setCodexMode('cx-busy', 'auto'), /sedang bekerja/);
    await assert.rejects(() => setCodexModel('cl-1', { effort: 'low' }), /bukan sesi Codex/);
  } finally { try { tm.tmux(['kill-session', '-t', name]); } catch {} live.live.delete('cx-busy'); live.live.delete('cl-1'); }
});
