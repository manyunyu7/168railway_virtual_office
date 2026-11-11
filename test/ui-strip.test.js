import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; globalThis.dispatchEvent = () => true; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem() { return null; }, setItem() {} }; globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ addEventListener() {}, matches: false });
globalThis.document = { dispatchEvent() { return true; }, addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { style: { setProperty() {} }, dataset: {} } };
const S = await import('../web/js/mesin-strip.js');

const agoFn = () => '2 mnt lalu';
const studio = { id: 'mac-studio', name: 'Mac Studio', online: true, latencyMs: 38.4, lastSeen: '2026-11-11T10:00:00Z', lastError: null };
const mini = { id: 'mini', name: 'Mac mini', online: false, latencyMs: 12, lastSeen: '2026-11-11T09:00:00Z', lastError: 'ssh: connect to host mini port 22: Connection refused' };
const baru = { id: 'baru', name: 'Mac Baru', online: null };
const mati = { id: 'mati', name: 'Mac Mati', online: true, latencyMs: 5, disabled: true };

test('tanpa mesin: strip kosong (header satu-PC tidak berubah)', () => {
  assert.equal(S.stripHTML([]), '');
  assert.equal(S.stripHTML(), '');
  assert.equal(S.stripHTML(null), '');
  assert.equal(S.stripHTML([{ name: 'tanpa id' }]), '');
});

test('stripItems: titik per status dan latensi hanya saat online', () => {
  const it = S.stripItems([studio, mini, baru, mati], agoFn);
  assert.deepEqual(it.map(x => x.dot), ['on', 'off', 'unk', 'dis']);
  assert.deepEqual(it.map(x => x.lat), ['38 ms', '', '', '']);
  assert.equal(it[0].name, 'Mac Studio');
  assert.equal(S.stripItems([{ id: 'x' }])[0].name, 'x');
});

test('chipTitle: status, lastSeen, lastError', () => {
  const t = S.chipTitle(studio, agoFn).split('\n');
  assert.equal(t[0], 'Mac Studio: Online · 38 ms');
  assert.equal(t[1], 'Terakhir terlihat 2 mnt lalu');
  assert.ok(!t.some(l => l.startsWith('Galat')));
  const o = S.chipTitle(mini, agoFn);
  assert.match(o, /^Mac mini: Offline\n/);
  assert.match(o, /Galat terakhir: ssh: connect/);
  assert.match(S.chipTitle(baru, agoFn), /Belum dicek\nBelum pernah terhubung/);
  assert.match(S.chipTitle(mati, agoFn), /^Mac Mati: Nonaktif\n/);
  // galat lama tidak ditampilkan bila mesin sudah online lagi
  assert.ok(!S.chipTitle({ ...studio, lastError: 'lama' }, agoFn).includes('lama'));
});

test('stripHTML: satu chip per mesin, escape nama, membuka pengaturan', () => {
  const h = S.stripHTML([studio, { id: 'x"y', name: '<b>Jahat</b>', online: false }], { agoFn });
  assert.equal((h.match(/class="mxs-chip /g) || []).length, 2);
  assert.equal((h.match(/data-mxs="open"/g) || []).length, 2);
  assert.ok(h.includes('<span class="mxs-lat">38 ms</span>'));
  assert.ok(h.includes('&lt;b&gt;Jahat&lt;/b&gt;'));
  assert.ok(!h.includes('<b>Jahat'));
  assert.ok(h.includes('data-id="x&quot;y"'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(h));
});

test('mesin banyak: satu chip ringkas', () => {
  const list = [studio, mini, baru, mati, { id: 'e', name: 'E', online: true }];
  assert.deepEqual(S.stripSummary(list), { total: 5, online: 2, text: '2/5 online' });
  const h = S.stripHTML(list, { agoFn });
  assert.equal((h.match(/class="mxs-chip /g) || []).length, 1);
  assert.equal((h.match(/class="mxs-dot /g) || []).length, 5);
  assert.ok(h.includes('2/5 online'));
  assert.equal((S.stripHTML(list.slice(0, 4), { agoFn }).match(/class="mxs-chip /g) || []).length, 4);
});
