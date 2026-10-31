import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-engines-'));
process.env.KANTOR_HOME = tmp;
const { buildEngineCatalog } = await import('../server/engines.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test('catalog describes models, efforts, native permissions and availability for generic clients', () => {
  const c = buildEngineCatalog({ claudeAvailable: true,
    codex: { available: false, default: { model: 'gpt-new', effort: 'high' },
      models: [{ slug: 'gpt-new', name: 'New GPT', efforts: [{ effort: 'high' }] }] },
    antigravity: { available: true, models: [{ slug: 'gemini-new', name: 'New Gemini' }, { slug: 'claude-other' }] } });
  assert.equal(c.version, 1);
  assert.equal(c.defaultEngine, 'claude');
  const [claude, codex, gemini] = c.engines;
  assert.equal(codex.available, false);
  assert.equal(codex.defaultModel, 'gpt-new');
  assert.equal(codex.supportsEffort, true);
  assert.equal(codex.models[0].efforts[0].effort, 'high');
  assert.deepEqual(gemini.models.map(m => m.slug), ['gemini-new']);
  assert.ok(gemini.permissionModes.some(m => m.id === 'plan'));
  assert.ok(!gemini.permissionModes.some(m => m.id === 'readOnly'));
  assert.ok(codex.permissionModes.some(m => m.id === 'readOnly'));
  assert.ok(claude.permissionModes.some(m => m.id === ''));
  for (const e of c.engines) {
    assert.ok(e.id && e.name);
    assert.ok(e.permissionModes.some(m => m.id === e.defaultPermissionMode));
    assert.ok(e.permissionModes.find(m => m.id === 'bypassPermissions').warning);
  }
});
