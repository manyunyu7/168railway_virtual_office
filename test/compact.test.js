import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactSummary } from '../web/js/compact.js';
import { readTranscript } from '../server/transcript.js';

const SUM = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<system-reminder>\nx\n</system-reminder>\nSummary:\n1. Primary Request and Intent:\n   - Pemilik minta cek **foto** yang lolos.\n\n2. Key Technical Concepts:\n   - Laravel';

test('ringkasan kompaksi: pengantar dan system-reminder dibuang, pratinjau dari permintaan utama', () => {
  const c = compactSummary(`<pasted_content id="1">\n${SUM}\n</pasted_content>`);
  assert.ok(c.body.startsWith('1. Primary Request and Intent:'));
  assert.ok(!c.body.includes('system-reminder'));
  assert.equal(c.preview, 'Pemilik minta cek foto yang lolos.');
  assert.equal(compactSummary('tolong cek foto'), null);
});

test('transcript: record isCompactSummary jadi item compact, bukan pesan pemilik', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')), 't.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: SUM }, timestamp: '2026-11-12T01:00:00Z' }) + '\n');
  const { items } = readTranscript(f, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].k, 'compact');
  assert.ok(items[0].s.includes('Primary Request'));
});

test('ringkasan ditempel setelah kalimat pemilik: kalimatnya tetap jadi pesan', () => {
  const c = compactSummary(`ini juga baiknya di chat jadi tampilan yang bagus\n\n<pasted_content id="2">\n${SUM}\n</pasted_content>`);
  assert.equal(c.rest, 'ini juga baiknya di chat jadi tampilan yang bagus');
  assert.equal(c.preview, 'Pemilik minta cek foto yang lolos.');
});
