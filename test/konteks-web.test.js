import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; globalThis.dispatchEvent = () => true; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem() { return null; }, setItem() {} }; globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ addEventListener() {}, matches: false });
globalThis.document = { addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { style: { setProperty() {} }, dataset: {} } };
const { detailOf, topicOf, pillHTML, panelHTML, subHTML } = await import('../web/js/konteks.js');
const { resolveNav } = await import('../web/js/nav-memory.js');

const kx = (k, more = {}) => ({ topic: 'Rapikan <login>', ask: null, reply: null, err: null, files: null, card: null, branch: null, state: { k, label: 'L ' + k }, ...more });

test('detailOf memilih bahan sesuai keadaan', () => {
  assert.equal(detailOf({ konteks: kx('izin'), waiting: { summary: 'Bash npm test' } }), 'Bash npm test');
  assert.equal(detailOf({ konteks: kx('tanya', { reply: { s: 'x', q: 'Lanjut?' } }) }), 'Lanjut?');
  assert.equal(detailOf({ konteks: kx('jalan'), tool: { name: 'Edit', label: 'a.js' } }, 'fb'), 'Edit a.js');
  assert.equal(detailOf({ konteks: kx('selesai', { reply: { s: 'Sudah beres' } }) }), 'Sudah beres');
  assert.equal(detailOf({ konteks: kx('gagal', { err: 'Rate limit' }) }), 'Rate limit');
  assert.equal(detailOf({ konteks: kx('kosong') }, 'idle'), 'idle');
});

test('aman tanpa konteks (data lama)', () => {
  assert.equal(detailOf({}, 'fb'), 'fb');
  assert.equal(topicOf(undefined), '');
  assert.equal(pillHTML({}), '');
  assert.equal(panelHTML({}), '');
  assert.ok(subHTML({}, 'idle').includes('idle'));
});

test('teks di-escape di pil dan panel', () => {
  const s = { konteks: kx('tanya', { reply: { s: '<b>hi</b>', q: 'a "b"?', at: null }, branch: '<x>' }) };
  const h = panelHTML(s, true);
  assert.ok(!h.includes('<b>hi') && !h.includes('<x>') && !h.includes('<login>'));
  assert.ok(h.includes('<details class="kx" open>'));
  assert.ok(pillHTML(s).includes('k-tanya'));
});

test('resolveNav: tab global ikut pindah kantor, sesi per kantor, link eksplisit menang', () => {
  const ok = { tab: () => true, session: sid => sid === 'a', pending: null, pendingTab: null };
  const bare = { id: 'o2', tab: 'kantor', explicit: false, rest: [] };
  const out = { name: 'office', id: 'o1', tab: 'chat' };
  assert.deepEqual(resolveNav(bare, out, { tab: 'board', sid: '' }, ok), { tab: 'board', rest: [], usedPending: false });
  assert.deepEqual(resolveNav(bare, null, { tab: 'chat', sid: 'a' }, ok), { tab: 'chat', rest: ['a'], usedPending: false });
  assert.deepEqual(resolveNav(bare, null, { tab: 'chat', sid: 'gone' }, ok), { tab: 'chat', rest: [], usedPending: false });
  assert.equal(resolveNav(bare, null, { tab: 'kantor', sid: 'a' }, ok), null);
  assert.equal(resolveNav(bare, null, { tab: 'performa', sid: '' }, { ...ok, tab: k => k !== 'performa' }), null);
  assert.equal(resolveNav({ ...bare, tab: 'kantor', explicit: true }, null, { tab: 'chat', sid: 'a' }, ok), null);
  assert.equal(resolveNav({ id: 'o2', tab: 'chat', explicit: true, rest: ['z'] }, null, { tab: 'chat', sid: 'a' }, ok), null);
  // balik ke daftar di dalam tab chat tidak membuka sesi lagi
  assert.equal(resolveNav({ id: 'o', tab: 'chat', explicit: true, rest: [] }, { name: 'office', id: 'o', tab: 'chat' }, { tab: 'chat', sid: 'a' }, ok), null);
});

test('resolveNav: pilih agen saat di tab chat mendarat di chat dengan sesi itu', () => {
  const ok = { tab: () => true, session: sid => ['a', 'p'].includes(sid), pending: 'p', pendingTab: 'chat' };
  const bare = { id: 'o2', tab: 'kantor', explicit: false, rest: [] };
  assert.deepEqual(resolveNav(bare, { name: 'office', id: 'o1', tab: 'chat' }, { tab: 'chat', sid: 'a' }, ok), { tab: 'chat', rest: ['p'], usedPending: true });
  // kantor yang sama, sedang di chat: tetap pindah ke sesi pilihan
  assert.deepEqual(resolveNav({ ...bare, id: 'o1' }, { name: 'office', id: 'o1', tab: 'chat' }, { tab: 'chat', sid: 'a' }, ok), { tab: 'chat', rest: ['p'], usedPending: true });
  // minta terminal: tidak memaksa chat, jatuh ke sesi terakhir
  assert.deepEqual(resolveNav(bare, null, { tab: 'chat', sid: 'a' }, { ...ok, pendingTab: 'term' }), { tab: 'chat', rest: ['a'], usedPending: false });
  // dari tab kantor: perilaku lama (drawer), tidak ada perubahan
  assert.equal(resolveNav(bare, null, { tab: 'kantor', sid: 'a' }, ok), null);
  // sesi pilihan sudah hilang: sesi terakhir kantor itu
  assert.deepEqual(resolveNav(bare, null, { tab: 'chat', sid: 'a' }, { ...ok, pending: 'x' }), { tab: 'chat', rest: ['a'], usedPending: false });
});

test('tab Terminal ikut pindah kantor dan membuka sesi seperti Chat', () => {
  const ok = { tab: () => true, session: sid => sid === 's1' };
  const prev = { name: 'office', id: 'a', tab: 'terminal' };
  assert.deepEqual(resolveNav({ id: 'b', tab: 'kantor', explicit: false, rest: [] }, prev, { tab: 'terminal', sid: 's1' }, ok), { tab: 'terminal', rest: ['s1'], usedPending: false });
  assert.deepEqual(resolveNav({ id: 'b', tab: 'kantor', explicit: false, rest: [] }, prev, { tab: 'terminal', sid: '' }, { ...ok, pending: 's1', pendingTab: 'term' }), { tab: 'terminal', rest: ['s1'], usedPending: true });
});
