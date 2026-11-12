import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hl } from '../web/js/hl.js';

test('kata kunci, string, angka, komentar diwarnai; isi selalu di-escape', () => {
  const h = hl('const a = "<x>"; // if\nreturn 42', 'js');
  assert.ok(h.includes('<span class="hl-k">const</span>'));
  assert.ok(h.includes('<span class="hl-s">&quot;&lt;x&gt;&quot;</span>'));
  assert.ok(h.includes('<span class="hl-c">// if</span>'), 'kata kunci di dalam komentar tidak diwarnai terpisah');
  assert.ok(h.includes('<span class="hl-n">42</span>'));
  assert.ok(!/<x>/.test(h));
});

test('diff per baris, bahasa tak dikenal tetap aman', () => {
  assert.equal(hl('+a\n-b\n c', 'diff'), '<span class="hl-add">+a</span>\n<span class="hl-del">-b</span>\n c');
  assert.equal(hl('<script>alert(1)</script>', 'xyz').includes('<script>'), false);
  assert.ok(hl('SELECT * FROM t', 'sql').includes('<span class="hl-k">SELECT</span>'));
});
