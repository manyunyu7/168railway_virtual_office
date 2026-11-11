import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTimeline } from '../web/js/chat-timeline.js';

const at = minute => `2026-10-24T00:${String(minute).padStart(2, '0')}:00Z`;

test('old outbox messages are placed above later agent activity', () => {
  const transcript = [{ k: 'tool', s: 'Bash now', at: at(20) }, { k: 'text', s: 'done', at: at(21) }];
  const outbox = [{ id: 'old', status: 'read', text: 'chat semalam', at: at(1) }];
  assert.deepEqual(chatTimeline(transcript, outbox).map(x => x.k), ['outbox', 'tool', 'text']);
});

test('outbox matches a transcript message once, including while reconciliation is pending', () => {
  const transcript = [{ k: 'user', s: 'lihat ini', at: at(2) }, { k: 'user', s: 'lihat ini', at: at(3) }];
  const outbox = [{ id: 'a', status: 'read', text: 'lihat ini', at: at(2) }, { id: 'b', status: 'pending', text: 'lihat ini', at: at(3) }];
  assert.deepEqual(chatTimeline(transcript, outbox).map(x => x.k), ['user', 'user']);
});

test('pending messages and attachments sit between transcript events by time', () => {
  const transcript = [{ k: 'tool', at: at(1) }, { k: 'result', at: at(4) }];
  const outbox = [{ id: 'a', status: 'pending', text: 'halo', at: at(2) }];
  const attachments = [{ id: 'file', at: at(3) }];
  assert.deepEqual(chatTimeline(transcript, outbox, attachments).map(x => x.k), ['tool', 'outbox', 'attachment', 'result']);
});
