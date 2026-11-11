import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrefs, chatVars, stepPref } from '../web/js/view-prefs.js';

test('nilai rusak kembali ke bawaan, nilai sah dipakai', () => {
  const p = cleanPrefs({ chatFs: 99, chatCode: '13', chatLh: 3, chatW: 'x', termFs: 16, termLh: 1.3 });
  assert.deepEqual(p, { chatFs: 0, chatCode: 13, chatLh: 1.5, chatW: 'normal', termFs: 16, termLh: 1.3 });
});

test('bawaan tidak mengisi variabel CSS supaya ukuran HP dan desktop tetap', () => {
  assert.ok(Object.values(chatVars(cleanPrefs())).every(v => v === ''));
  const v = chatVars(cleanPrefs({ chatFs: 16, chatW: 'lebar' }));
  assert.equal(v['--ch-fs'], '16px');
  assert.equal(v['--ch-col'], '1100px');
});

test('langkah mulai dari ukuran yang terlihat dan berhenti di batas', () => {
  assert.equal(stepPref('chatFs', 0, 14.5, 1), 15);
  assert.equal(stepPref('chatFs', 22, 14.5, 1), 22);
  assert.equal(stepPref('termFs', 9, 9, -1), 9);
});
