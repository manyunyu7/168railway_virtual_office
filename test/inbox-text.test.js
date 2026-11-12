import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; globalThis.dispatchEvent = () => true; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.matchMedia = () => ({ addEventListener() {}, matches: false });
globalThis.document = { addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} } };
const { inboxText } = await import('../web/js/util.js');

test('pertanyaan AskUserQuestion dibaca dari JSON, bukan ditampilkan mentah', () => {
  const t = inboxText({ tool: 'AskUserQuestion', summary: JSON.stringify({ questions: [{ question: 'Kode galeri mana yang dipakai?' }, { question: 'b' }] }) });
  assert.equal(t.kind, 'tanya');
  assert.equal(t.body, 'Kode galeri mana yang dipakai? (+1 pertanyaan lagi)');
  assert.equal(inboxText({ tool: 'AskUserQuestion', summary: '{rusak' }).body, '');
});

test('izin tool biasa: judul menyebut tool, Bash ditandai kode', () => {
  const t = inboxText({ tool: 'Bash', summary: 'npm test' });
  assert.deepEqual(t, { kind: 'izin', title: 'minta izin · Bash', body: 'npm test', code: true });
});
