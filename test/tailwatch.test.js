import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tw-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const tw = await import('../server/tailwatch.js');
const { live, bus } = await import('../server/live.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('debounce: a burst fires once, after the quiet period', async () => {
  let n = 0, last;
  const d = tw.debounce(v => { n++; last = v; }, 50);
  d(1); d(2); d(3);
  await wait(20); assert.equal(n, 0);
  await wait(60); assert.equal(n, 1); assert.equal(last, 3);
  d(4); d.cancel(); await wait(80); assert.equal(n, 1);
});

test('headSessionId reads the first sessionId', () => {
  assert.equal(tw.headSessionId('{"type":"mode","sessionId":"53e40efa-adbd-48af-aa4d-adc0e919e236"}\n{"sessionId":"x"}'), '53e40efa-adbd-48af-aa4d-adc0e919e236');
  assert.equal(tw.headSessionId('{"type":"summary"}'), null);
});

test('successorFor: only a fresher file of the reported conversation, in the same folder, nobody else owns', () => {
  const dir = '/p/-Users-x-repo', A = 'aaaaaaaa-1111', B = 'bbbbbbbb-2222';
  const cur = { file: path.join(dir, A + '.jsonl'), mtimeMs: 100 };
  const ok = { exists: true, headSid: B, mtimeMs: 200 };
  const none = { sids: new Set(), files: new Set() };
  assert.equal(tw.successorFor(cur, B, ok, none), path.join(dir, B + '.jsonl'));
  assert.equal(tw.successorFor(cur, A, { ...ok, headSid: A }, none), null, 'same conversation');
  assert.equal(tw.successorFor(cur, B, { ...ok, exists: false }, none), null, 'no file');
  assert.equal(tw.successorFor(cur, B, { ...ok, headSid: 'cccccccc-3' }, none), null, 'file declares another session');
  assert.equal(tw.successorFor(cur, B, { ...ok, mtimeMs: 50 }, none), null, 'older than current');
  assert.equal(tw.successorFor(cur, B, ok, { sids: new Set([B]), files: new Set() }), null, 'another live session owns it');
  assert.equal(tw.successorFor(cur, B, ok, { sids: new Set(), files: new Set([path.join(dir, B + '.jsonl')]) }), null, 'another live session watches it');
  assert.equal(tw.successorFor(cur, '../../etc/passwd', ok, none), null, 'not an id');
  assert.equal(tw.successorFor(cur, null, ok, none), null);
});

test('watcher pushes { t: transcript } when the file grows', async () => {
  const file = path.join(tmp, 'sess.jsonl');
  fs.writeFileSync(file, '{"sessionId":"dddddddd-4"}\n');
  live.set('tw-1', { sid: 'tw-1', office: 'o1', status: 'working', transcript: file, subs: new Map() });
  const got = [];
  const on = m => { if (m.t === 'transcript') got.push(m); };
  bus.on('msg', on);
  try {
    tw.sweep();
    fs.appendFileSync(file, '{"type":"assistant"}\n');
    fs.appendFileSync(file, '{"type":"user"}\n');
    await wait(1300);
    tw.sweep();
    assert.ok(got.length >= 1);
    assert.equal(got.at(-1).sid, 'tw-1');
    assert.equal(got.at(-1).size, fs.statSync(file).size);
    const n = got.length; tw.sweep(); await wait(300); assert.equal(got.length, n, 'no event without change');
  } finally { bus.off('msg', on); live.delete('tw-1'); tw.stopTailWatch(); }
});
