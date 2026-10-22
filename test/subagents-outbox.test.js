import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-subob-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));

const { readTranscript, unpaste } = await import('../server/transcript.js');
const outbox = await import('../server/outbox.js');
const { live } = await import('../server/live.js');
const { subagentTokens, lastUsageTokens } = await import('../server/subtokens.js');
const { subRows, fmtTokens, fmtElapsed } = await import('../web/js/subagents.js');

const MSG = '[Balasan dari Laras (Analis Bisnis) untuk pesanmu m3385dff6db] Bu, kb8cf53 sudah di Review.\nIsi:\n- §5 revisi\n- §7.1';
const pasted = `\n\n<pasted_content id="30d9">\n${MSG}\n</pasted_content id="30d9">\n`;
const line = (content, at) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content } });

test('unpaste: a bracketed paste stored by Claude Code becomes the plain text', () => {
  assert.equal(unpaste(pasted).trim(), MSG);
  assert.equal(unpaste('plain'), 'plain');
});

test('readTranscript shows a pasted prompt as a user message (it used to be dropped as "<…" markup)', () => {
  const f = path.join(tmp, 't1.jsonl');
  fs.writeFileSync(f, line(pasted, new Date().toISOString()) + '\n' + line('<command-name>/clear</command-name>', new Date().toISOString()) + '\n');
  const users = readTranscript(f).items.filter(i => i.k === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].s, MSG);
});

test('outbox: a pasted (bracketed) delivery is matched as read, from the transcript or the prompt hook', () => {
  const f = path.join(tmp, 't2.jsonl'), sid = 'sid-paste';
  live.set(sid, { sid, transcript: f, subs: new Map() });
  const a = outbox.recordOutgoing(sid, MSG);
  fs.writeFileSync(f, line(pasted, new Date(Date.now() + 500).toISOString()) + '\n');
  assert.equal(outbox.reconcile(sid), 1);
  const items = outbox.listOutbox(sid).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, a.id);
  assert.equal(items[0].status, 'read');
  // hook path: the prompt carries the wrapper too
  const b = outbox.recordOutgoing(sid, MSG + ' kedua');
  assert.equal(outbox.promptSeen(sid, `<pasted_content id="1">\n${MSG} kedua\n</pasted_content id="1">`)?.id, b.id);
  live.delete(sid);
});

test('outbox same(): clipped transcript text ("…") still matches a long message', () => {
  const long = 'x'.repeat(2500);
  assert.ok(outbox.same(long.slice(0, 1999) + '…', long));
  assert.ok(!outbox.same('halo apa kabar semuanya ya', 'yang lain sama sekali bukan ini'));
});

test('subagentTokens: latest assistant usage of agent-<id>.jsonl, cached by size', () => {
  const tr = path.join(tmp, 'proj', 'abc.jsonl');
  const dir = path.join(tmp, 'proj', 'abc', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const u = (o, i) => JSON.stringify({ type: 'assistant', message: { id: 'm' + i, usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: o } } });
  const f = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(f, [u(5, 1), u(7, 2), JSON.stringify({ type: 'user', message: { content: 'x' } })].join('\n') + '\n');
  assert.equal(subagentTokens(tr, 'a1'), 119);
  fs.appendFileSync(f, u(50, 3) + '\n');
  assert.equal(subagentTokens(tr, 'a1'), 162);
  assert.equal(subagentTokens(tr, 'nope'), null);
  assert.equal(subagentTokens(tr, '../x'), null);
  assert.equal(lastUsageTokens('garbage{"usage"\n'), null);
});

test('subRows groups identical type+desc as (+n), running first, finished kept ~1 minute', () => {
  const now = 1_000_000;
  const rows = subRows([
    { id: '1', type: 'general-purpose', desc: 'Wiring', status: 'working', started: now - 995_000, tokens: 1000, tool: { name: 'Bash', label: 'npm test' } },
    { id: '2', type: 'general-purpose', desc: 'Adding helper', status: 'working', started: now - 194_000, tokens: 100 },
    { id: '3', type: 'general-purpose', desc: 'Adding helper', status: 'working', started: now - 100_000, tokens: 26 },
    { id: '4', type: 'Explore', desc: 'old', status: 'done', started: now - 300_000, ended: now - 120_000 },
    { id: '5', type: 'Explore', desc: 'recent', status: 'done', started: now - 60_000, ended: now - 10_000 },
  ], now);
  assert.deepEqual(rows.map(r => r.label), ['general-purpose', 'general-purpose (+1)', 'Explore']);
  assert.equal(rows[0].act, 'Bash npm test');
  assert.equal(rows[1].tokens, 126);
  assert.equal(rows[1].elapsed, 194_000);
  assert.ok(rows[2].done);
  assert.equal(rows[2].elapsed, 50_000);
  assert.equal(fmtTokens(162_600), '162.6k');
  assert.equal(fmtElapsed(995_000), '16m 35s');
});
