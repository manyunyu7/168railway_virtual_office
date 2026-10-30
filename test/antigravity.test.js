import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-agy-test-'));
process.env.KANTOR_HOME = path.join(tmp, 'kantor');
const agy = await import('../server/antigravity.js');
const { engineOf } = await import('../server/codex.js');
const store = await import('../server/store.js');
const offices = await import('../server/offices.js');
const { live, handleHook, expectSession } = await import('../server/live.js');
const { globalDb, one, closeAll } = await import('../server/db.js');
after(() => { closeAll(); fs.rmSync(tmp, { recursive: true, force: true }); });
test('engine Antigravity round-trips through role/session persistence; legacy engine defaults to Claude', async () => {
  const root = path.join(tmp, 'project'); fs.mkdirSync(root);
  const office = offices.registerOffice(root);
  const r = store.createRole(office, { name:'Gemini',title:'Dev',room:'manager',engine:'antigravity',model:'gemini-flash' });
  assert.equal(r.engine,'antigravity'); assert.equal(store.getRole(office,r.id).model,'gemini-flash');
  expectSession({sid:'agy-1',office,room:'manager',role:r.id,cwd:root,engine:'antigravity',tmux:'fixture'});
  assert.equal(one(globalDb(),'SELECT engine FROM sessions WHERE sid = ?','agy-1').engine,'antigravity');
  await handleHook(agy.normalizeAgyHook('PreInvocation',{conversationId:'agy-1',workspacePaths:[root],modelName:'gemini-flash'}));
  assert.equal(live.get('agy-1').status,'working');
  await handleHook(agy.normalizeAgyHook('Stop',{conversationId:'agy-1',workspacePaths:[root]}));
  assert.equal(live.get('agy-1').status,'idle');
  store.updateRole(office,r.id,{engine:'claude',model:'sonnet'});
  assert.equal(store.getRole(office,r.id).engine,'claude'); assert.equal(engineOf(null),'claude');
});
test('settings stay per invocation, disable credit overages, retain deny rules and scope trust to cwd', () => {
  const s=agy.agySettings('/tmp/work',{deny:['command(rm *)'],allow:['read_file(/tmp/work)']});
  assert.deepEqual(s.trustedWorkspaces,['/tmp/work']); assert.equal(s.useG1Credits,false);
  assert.deepEqual(s.permissions.deny,['command(rm *)']); assert.ok(s.permissions.allow.includes('mcp(kantor/*)'));
  const a=agy.agyArgs({cwd:'/tmp/work',settingsFile:'/private/shift.json',mode:'acceptEdits',model:'gemini-flash',task:'Kerjakan ini'});
  assert.ok(a.includes('accept-edits')); assert.ok(!a.includes('--dangerously-skip-permissions'));
  const resume=agy.agyArgs({settingsFile:'s',resumeSid:'old-id',task:'Jangan kirim ulang',mode:'plan'});
  assert.ok(resume.includes('--conversation'));assert.ok(resume.includes('old-id'));assert.ok(!resume.includes('--prompt-interactive'));
  assert.equal(agy.agyMode('dontAsk'),'default');
});
test('integration installer preserves foreign hooks/MCP, accepts an empty initial file and rejects a conflicting MCP name', () => {
  const dir=path.join(tmp,'config');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'hooks.json'),JSON.stringify({linter:{Stop:[]}}));
  fs.writeFileSync(path.join(dir,'mcp_config.json'),'');
  agy.installAgyIntegration(dir);
  const h=JSON.parse(fs.readFileSync(path.join(dir,'hooks.json')));
  assert.deepEqual(h.linter,{Stop:[]});assert.ok(h['kantor-claude'].PreInvocation);
  assert.match(h['kantor-claude'].Stop[0].command,/antigravity-hook\.cjs/);
  const file=path.join(dir,'mcp_config.json');const m=JSON.parse(fs.readFileSync(file));
  assert.ok(m.mcpServers.kantor.args[0].endsWith('mcp-stdio.js')); assert.ok(!JSON.stringify(m).includes('token'));
  m.mcpServers.kantor={command:'foreign'};fs.writeFileSync(file,JSON.stringify(m));
  assert.throws(()=>agy.installAgyIntegration(dir),/sudah dipakai/);
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.kantor.command,'foreign');
});
test('native hooks normalize tool names and failures without weakening permissions', () => {
  const p=agy.normalizeAgyHook('PostToolUse',{conversationId:'x',workspacePaths:['/w'],transcriptPath:'/log',modelName:'gemini',toolCall:{name:'run_command',args:{CommandLine:'git status'}},stepIdx:2,error:'failed'});
  assert.equal(p.hook_event_name,'PostToolUseFailure');assert.equal(p.tool_name,'Bash');assert.equal(p.tool_input.command,'git status');assert.equal(p.kantor_engine,'antigravity');
  assert.equal(agy.normalizeAgyHook('PreInvocation',{conversationId:'x'}).hook_event_name,'UserPromptSubmit');
});
test('model list and native transcript parse user/model text without exposing system persona', () => {
  assert.deepEqual(agy.parseAgyModels('Fetching models...\ngemini-flash\tGemini Flash\n'),[{slug:'gemini-flash',name:'Gemini Flash',desc:''}]);
  const file=path.join(tmp,'transcript.jsonl');
  fs.writeFileSync(file,[{type:'USER_INPUT',created_at:'now',content:'<USER_REQUEST>\nHai\n</USER_REQUEST>\n<ADDITIONAL_METADATA>secret</ADDITIONAL_METADATA>'},{type:'SYSTEM_MESSAGE',content:'private persona'},{type:'PLANNER_RESPONSE',created_at:'now',content:'Halo'}].map(JSON.stringify).join('\n'));
  assert.deepEqual(agy.readAgyTranscript(file).items.map(i=>[i.k,i.s]),[['user','Hai'],['text','Halo']]);
});

test('native MCP tool wrapper and tool-call transcript become normal Kantor chat items', () => {
  const a = { ServerName:'"kantor"', ToolName:'"sessions_list"', Arguments:'{}' };
  assert.equal(agy.agyTool('call_mcp_tool',a).name,'mcp__kantor__sessions_list');
  const file=path.join(tmp,'mcp-transcript.jsonl');
  fs.writeFileSync(file,[{type:'PLANNER_RESPONSE',tool_calls:[{name:'call_mcp_tool',args:a}],thinking:'private thoughts'},{type:'GENERIC',content:'tool result'}].map(JSON.stringify).join('\n'));
  const items=agy.readAgyTranscript(file).items;
  assert.equal(items[0].k,'tool'); assert.equal(items[0].name,'mcp__kantor__sessions_list');
  assert.equal(items[1].k,'result'); assert.ok(!JSON.stringify(items).includes('private thoughts'));
});

test('hook transcript_full.jsonl is dispatched to the native reader, including on resume', async () => {
  const dir=path.join(tmp,'antigravity-cli/brain/id/.system_generated/logs'); fs.mkdirSync(dir,{recursive:true});
  const f=path.join(dir,'transcript_full.jsonl'); fs.writeFileSync(f,JSON.stringify({type:'PLANNER_RESPONSE',content:'Jawaban setelah resume',created_at:'now'}));
  assert.ok(agy.isAgyTranscript(f)); assert.ok(agy.isAgyTranscript(f.replace('_full','')));
  const {readTranscript}=await import('../server/transcript.js');
  assert.equal(readTranscript(f).items[0].s,'Jawaban setelah resume');
});

test('unsupported Gemini payroll does not pretend to enforce a dollar budget', async () => {
  const {status}=await import('../server/budget.js');
  assert.equal(status('none',{id:'gemini',engine:'antigravity',budget:100}),null);
});
