import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-open-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const { readTranscript } = await import('../server/transcript.js');
const { transcriptArgs, openSession } = await import('../server/session-open.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const row = text => JSON.stringify({ type: 'assistant', timestamp: '2026-11-16T12:00:00Z', message: { content: [{ type: 'text', text }] } }) + '\n';
const file = path.join(tmp, 's.jsonl');
fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => row('o' + i)).join(''));
// same shape as the route in index.js: readTranscript(file, ...transcriptArgs(sid, q))
const transcript = (sid, q) => readTranscript(file, ...transcriptArgs(sid, q));
const Q = s => new URLSearchParams(s);

test('transcriptArgs keeps legacy, delta and before modes', () => {
  assert.deepEqual(transcriptArgs('a', Q('n=5')), [5, undefined]);
  assert.deepEqual(transcriptArgs('a', Q('')), [120, undefined]);
  assert.deepEqual(transcriptArgs('a', Q('delta=1')), [120, { sid: 'a', after: null }]);
  assert.deepEqual(transcriptArgs('a', Q('after=xyz&n=7')), [7, { sid: 'a', after: 'xyz' }]);
  assert.deepEqual(transcriptArgs('a', Q('before=10&gen=g&n=3')), [3, { sid: 'a', before: '10', gen: 'g' }]);
});

test('open = transcript delta + attachments + live session', () => {
  const seen = [];
  const deps = {
    transcript,
    attachments: (sid, q) => { seen.push([sid, q.toString()]); return { items: [{ id: 'x' }], clearedAt: null, hiddenBeforeClear: 0 }; },
    session: sid => ({ sid, status: 'idle' }),
  };
  const o = openSession('s1', Q('n=10'), deps);
  assert.deepEqual(Object.keys(o), ['transcript', 'attachments', 'session']);
  assert.deepEqual(o.transcript, transcript('s1', Q('n=10&delta=1')));
  assert.equal(o.transcript.first, 20); assert.equal(o.transcript.older, true); assert.equal(o.transcript.reset, true);
  assert.deepEqual(o.attachments, { items: [{ id: 'x' }], clearedAt: null, hiddenBeforeClear: 0 });
  assert.deepEqual(seen, [['s1', '']]); // the attachments route with no query
  assert.deepEqual(o.session, { sid: 's1', status: 'idle' });
  fs.appendFileSync(file, row('o30'));
  const d = openSession('s1', Q('n=10&after=' + o.transcript.cursor), deps);
  assert.deepEqual(d.transcript, transcript('s1', Q('n=10&after=' + o.transcript.cursor)));
  assert.equal(d.transcript.reset, false); assert.deepEqual(d.transcript.items.map(i => i.s), ['o30']); assert.equal(d.transcript.first, 30);
});

test('open: failing attachments and no live session give null', () => {
  const o = openSession('s2', Q(''), { transcript, attachments: () => { throw new Error('boom'); }, session: () => undefined });
  assert.equal(o.attachments, null); assert.equal(o.session, null);
  assert.equal(o.transcript.items.length, 31); assert.equal(o.transcript.first, 0); assert.equal(o.transcript.older, false);
});
