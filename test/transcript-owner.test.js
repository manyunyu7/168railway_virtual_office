import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownedTranscript } from '../server/transcript-owner.js';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-owner-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const parent = '01a1eeaa-43d6-7b22-8d4d-9a55034bb500';
const child = '01a1ef07-6ff8-75b3-b340-88cf9b1eea1a';
const other = '01a1ef07-3a64-7f80-a783-0c39ed3b0111';
const dir = path.join(tmp, 'sessions', '2026', '11', '18');
fs.mkdirSync(dir, { recursive: true });
const file = id => path.join(dir, `rollout-2026-11-18T19-38-18-${id}.jsonl`);
const own = file(parent), sub = file(child);
fs.writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: parent } }) + '\n');
fs.writeFileSync(sub, JSON.stringify({ type: 'session_meta', payload: { id: child } }) + '\n');

test('recover wrong saved Codex pointer; reject a different owner; preserve Claude', () => {
  assert.equal(ownedTranscript(parent, sub, 'codex'), own);
  assert.equal(ownedTranscript(parent, own, 'codex'), own);
  assert.equal(ownedTranscript(other, sub, 'codex'), null);
  assert.equal(ownedTranscript(parent, sub, 'claude'), sub);
});

test('parent chat survives child hook paths, DB restore and subsequent parent hooks', async () => {
  const lv = await import('../server/live.js');
  const { globalDb, one, run } = await import('../server/db.js');
  const base = { session_id: parent, cwd: tmp, kantor_engine: 'codex' };
  await lv.handleHook({ ...base, hook_event_name: 'SessionStart', transcript_path: own });
  for (const [i, ev] of ['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop'].entries()) {
    await lv.handleHook({ ...base, hook_event_name: ev, transcript_path: sub,
      agent_id: child, agent_transcript_path: sub, tool_name: 'Bash', tool_use_id: `call-${i}`, tool_input: { command: 'true' } });
    assert.equal(lv.live.get(parent).transcript, own, ev);
    assert.equal(one(globalDb(), 'SELECT transcript FROM sessions WHERE sid = ?', parent).transcript, own, ev + ' persisted');
  }
  assert.equal(lv.live.get(parent).subs.get(child).transcript, sub, 'child keeps its own transcript');
  run(globalDb(), 'UPDATE sessions SET transcript = ? WHERE sid = ?', sub, parent);
  lv.live.delete(parent);
  await lv.handleHook({ ...base, hook_event_name: 'Stop', transcript_path: sub });
  assert.equal(lv.live.get(parent).transcript, own, 'restored session remains owned');
  assert.equal(one(globalDb(), 'SELECT transcript FROM sessions WHERE sid = ?', parent).transcript, own, 'wrong legacy pointer repaired in DB');
  await lv.handleHook({ ...base, hook_event_name: 'SessionStart', transcript_path: own });
  assert.equal(lv.live.get(parent).transcript, own);
});
