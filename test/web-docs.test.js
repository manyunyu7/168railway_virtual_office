// md() turns own PDF / md / txt media into preview cards, and never lets file content become markup.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; globalThis.dispatchEvent = () => true; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem() { return null; }, setItem() {} }; globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ addEventListener() {}, matches: false });
globalThis.document = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { style: { setProperty() {} }, dataset: {} } };
const { md } = await import('../web/js/util.js');
const U = '/api/offices/shop/media/0123456789abcdef0123';

test('md: ![nama](…pdf) and the old 📎 link become a PDF card', () => {
  const a = md(`![Laporan](${U}.pdf)`);
  assert.match(a, /<figure class="md-pdf" data-src="[^"]+\.pdf" data-name="Laporan">/);
  assert.match(a, /data-pdf=/); assert.doesNotMatch(a, /<img/);
  const b = md(`[📎 Laporan.pdf](${U})`);
  assert.match(b, /<figure class="md-pdf"[^>]*data-name="Laporan\.pdf"/);
  assert.doesNotMatch(b, /file-chip/);
  assert.ok(!/^<div class="md"><p><figure/.test(a), 'kartu sendirian di baris tidak dibungkus <p>');
});

test('md: markdown and text attachments become document cards, other files stay chips', () => {
  for (const [s, n] of [[`![catatan](${U}.md)`, 'catatan'], [`![R](${U}.markdown)`, 'R'], [`![log](${U}.txt)`, 'log'], [`[📎 plan.md](${U})`, 'plan.md']])
    assert.match(md(s), new RegExp(`<figure class="md-doc"[^>]*data-name="${n.replace('.', '\\.')}"`));
  assert.match(md(`[📎 a.zip](${U})`), /file-chip/);
});

test('md: card attributes are escaped, foreign PDF urls are not made into cards', () => {
  const x = md(`![a"><script>alert(1)</script>](${U}.pdf)`);
  assert.doesNotMatch(x, /<script/); assert.match(x, /&lt;script&gt;/);
  assert.doesNotMatch(md('![x](https://evil.test/a.pdf)'), /md-pdf/);
  assert.doesNotMatch(md('[x](javascript:alert(1))'), /href="javascript/);
  assert.doesNotMatch(md('<img src=x onerror=alert(1)> `<b>`'), /<img/);
});
