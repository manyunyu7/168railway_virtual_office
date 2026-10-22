import test from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../server/live.js';
import { createLineParser, createClaudeStream, createTyper, getTyping } from '../server/meeting-stream.js';

const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const start = { type: 'stream_event', event: { type: 'message_start', message: {} } };

test('line parser handles split chunks, blank and bad lines', () => {
  const got = [];
  const p = createLineParser(o => got.push(o));
  p.feed('{"a":1}\n{"b"'); p.feed(':2}\nnot json\n\n{"c":3}');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  p.flush();
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('claude stream accumulates text, resets per message, ignores subagents, keeps result', () => {
  const seen = [];
  const s = createClaudeStream(t => seen.push(t));
  s.handle(start); s.handle(delta('Ha')); s.handle(delta('lo'));
  s.handle({ ...delta('XX'), parent_tool_use_id: 'tool1' });
  s.handle(start); s.handle(delta('Baru'));
  s.handle({ type: 'result', result: 'Baru', total_cost_usd: 0.01 });
  assert.deepEqual(seen, ['Ha', 'Halo', '', 'Baru']);
  assert.equal(s.result.result, 'Baru');
});

test('typer throttles, exposes state, and closes with done', async () => {
  const ev = [];
  const on = m => { if (m.t === 'meeting-typing') ev.push(m); };
  bus.on('msg', on);
  const ty = createTyper('o1', 'm1', { id: 'bayu', name: 'Bayu' });
  ty.start();
  assert.equal(getTyping('o1', 'm1').who, 'Bayu');
  ty.text('a'); ty.text('ab'); ty.text('abc');
  await new Promise(r => setTimeout(r, 150));
  ty.end();
  bus.off('msg', on);
  assert.deepEqual(ev.map(e => [e.text, e.done]), [['', false], ['abc', false], ['abc', true]]);
  assert.equal(ev[0].role, 'bayu');
  assert.equal(getTyping('o1', 'm1'), null);
});
