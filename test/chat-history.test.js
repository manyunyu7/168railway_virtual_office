import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistory } from '../web/js/chat-history.js';
const item = (s, k = 'text') => ({ k, s, at: '2026-11-18T12:00:00Z' });
const full = { gen: 'root', cursor: 'a', first: 0, older: false, reset: true, items: [item('pesan pemilik', 'user'), item('jawaban Cyrus')] };

test('more than 200 tool updates and reconnect keep already displayed messages', () => {
  let h = mergeHistory({ items: [] }, full);
  h = mergeHistory(h, { gen: 'root', cursor: 'b', first: 2, reset: false, items: Array.from({ length: 500 }, (_, i) => item('tool' + i, 'tool')) });
  assert.equal(h.items.length, 502);
  h = mergeHistory(h, { gen: 'root', cursor: 'c', first: 302, older: true, reset: true, items: h.items.slice(302) });
  assert.equal(h.items.length, 502);
  assert.deepEqual(h.items.slice(0, 2), full.items);
  assert.equal(h.first, 0);
  assert.equal(mergeHistory(h, { missing: true }), h);
});

test('paging deduplicates by sequence without discarding repeated identical messages', () => {
  const same = item('ya');
  let h = mergeHistory({ items: [] }, { ...full, first: 2, older: true, items: [same, same] });
  h = mergeHistory(h, { gen: 'root', first: 0, older: false, items: [same, same, same] });
  assert.equal(h.items.length, 4);
  assert.equal(h.cursor, 'a');
  assert.equal(h.older, false);
});

test('a real generation switch replaces old conversation, while sparse resets retain sequence identity', () => {
  let h = mergeHistory({ items: [] }, full);
  h = mergeHistory(h, { ...full, first: 3000, items: [item('baru')] });
  h = mergeHistory(h, { ...full, first: 3001, items: [item('berikutnya')] });
  assert.equal(h.items.length, 4);
  h = mergeHistory(h, { ...full, gen: 'after-clear', items: [item('percakapan baru')] });
  assert.deepEqual(h.items.map(i => i.s), ['percakapan baru']);
});
