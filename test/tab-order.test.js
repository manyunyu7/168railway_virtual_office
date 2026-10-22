import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOrder, defaultOrder } from '../web/js/tab-order.js';
import { validateTabOrder } from '../server/tab-order.js';

const KNOWN = ['kantor', 'chat', 'board', 'timeline', 'file', 'rapat', 'notes', 'wiki', 'payroll', 'metrik', 'role', 'arsip'];

test('default order: kantor, wiki, then the rest', () => {
  assert.deepEqual(defaultOrder(KNOWN), ['kantor', 'wiki', 'chat', 'board', 'timeline', 'file', 'rapat', 'notes', 'payroll', 'metrik', 'role', 'arsip']);
  assert.deepEqual(mergeOrder(null, KNOWN), defaultOrder(KNOWN));
});

test('mergeOrder keeps saved order, drops unknown, inserts new tabs at default spot', () => {
  const saved = ['arsip', 'kantor', 'wiki', 'gone', 'chat', 'board', 'timeline', 'file', 'rapat', 'notes', 'payroll', 'metrik', 'role', 'chat'];
  assert.deepEqual(mergeOrder(saved, KNOWN), ['arsip', 'kantor', 'wiki', 'chat', 'board', 'timeline', 'file', 'rapat', 'notes', 'payroll', 'metrik', 'role']);
  const withNew = [...KNOWN.slice(0, 3), 'pratinjau', ...KNOWN.slice(3)];
  const m = mergeOrder(['board', 'kantor', 'wiki', 'chat'], withNew);
  assert.deepEqual(m.filter(k => ['board', 'kantor', 'wiki', 'chat'].includes(k)), ['board', 'kantor', 'wiki', 'chat']);
  assert.equal(m.length, withNew.length);
  assert.equal(m.indexOf('pratinjau'), m.indexOf('board') + 1);
});

test('validateTabOrder', () => {
  assert.deepEqual(validateTabOrder(['wiki', 'kantor', 'wiki']), ['wiki', 'kantor']);
  assert.throws(() => validateTabOrder('wiki'));
  assert.throws(() => validateTabOrder(['Wiki']));
  assert.throws(() => validateTabOrder(['../x']));
  assert.throws(() => validateTabOrder([1]));
  assert.throws(() => validateTabOrder(Array.from({ length: 65 }, (_, i) => `t${i}`)));
});
