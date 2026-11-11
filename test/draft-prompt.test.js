import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftOnScreen, draftsWaiting, inputEmpty } from '../server/draft-prompt.js';

const box = '╭───╮\n│ ✻ Bug report drafted: Carousel options rejected twice        │\n│ │ - What happened: Asked…        │\n│ 1 to review · 2 to send · 0 to dismiss      │\n╰───╯\n';

test('draf terbaca dari layar, teks biasa tidak', () => {
  assert.equal(draftOnScreen(box), 'Carousel options rejected twice');
  assert.equal(draftOnScreen('Bug report drafted: tanpa tombol'), null);
  assert.equal(draftOnScreen(''), null);
});
test('kotak input kosong atau berisi', () => {
  assert.equal(inputEmpty(`${box}\n───\n❯ \n───`), true);
  assert.equal(inputEmpty(`${box}\n───\n❯ 2 dan 3 aja\n───`), false);
});
test('draf tersimpan terbaca dari baris bawah walau tombolnya tidak tampil', () => {
  const foot = '❯ \n  ⏵⏵ bypass permissions on · 1 feedback draft\n';
  assert.equal(draftsWaiting(foot), true);
  assert.equal(draftOnScreen(foot), null);
  assert.equal(draftsWaiting('❯ \n  ⏵⏵ bypass permissions on\n'), false);
});
