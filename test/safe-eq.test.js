import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sameToken } from '../server/safe-eq.js';

test('sameToken: cocok persis saja, kosong/null tidak pernah cocok', () => {
  assert.equal(sameToken('abc123', 'abc123'), true);
  assert.equal(sameToken('abc123', 'abc124'), false);
  assert.equal(sameToken('abc123', 'abc1234'), false);
  assert.equal(sameToken('', ''), false);
  assert.equal(sameToken(null, null), false);
  assert.equal(sameToken(undefined, 'x'), false);
  assert.equal(sameToken('ä', 'a'), false);
});

test('token owner dibandingkan lewat sameToken, bukan === / !==', () => {
  for (const f of ['server/index.js', 'server/remote-api.js']) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /[!=]==\s*cfg\.token\b|\bcfg\.token\s*[!=]==/, `${f} masih membandingkan cfg.token langsung`);
  }
});
