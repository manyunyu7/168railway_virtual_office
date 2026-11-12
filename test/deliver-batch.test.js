import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTimeline } from '../web/js/chat-timeline.js';

test('pesan gabungan lampiran tampil sebagai tulisan pemilik saja', () => {
  const msg = 'Ini foto atap timur, tolong cek bocornya\n\n[Lampiran dari pemilik, 2 file]\n- .kantor/inbox/a.jpg (1 MB, image/jpeg).\n- .kantor/inbox/b.jpg (1 MB, image/jpeg).';
  const items = [{ k: 'user', s: msg, at: '2026-11-12T10:00:05Z' }, { k: 'text', s: 'oke', at: '2026-11-12T10:00:09Z' }];
  const atts = [{ id: 'a', at: '2026-11-12T10:00:01Z', message: msg, note: 'Ini foto atap timur, tolong cek bocornya' }, { id: 'b', at: '2026-11-12T10:00:02Z', message: msg, note: 'Ini foto atap timur, tolong cek bocornya' }];
  const rows = chatTimeline(items, [], atts);
  assert.deepEqual(rows.map(r => r.k), ['attachment', 'attachment', 'user', 'text']);
  assert.equal(rows[2].s, 'Ini foto atap timur, tolong cek bocornya');
  // tanpa tulisan: pesan gabungannya disembunyikan, cukup kartu file
  const bare = chatTimeline([{ k: 'user', s: '[Lampiran dari pemilik] .kantor/inbox/a.jpg (1 MB, image/jpeg).', at: 'T' }], [], [{ id: 'a', at: 'T', message: '[Lampiran dari pemilik] .kantor/inbox/a.jpg (1 MB, image/jpeg).', note: '' }]);
  assert.deepEqual(bare.map(r => r.k), ['attachment']);
});

test('antrean pesan gabungan juga hanya menampilkan tulisan pemilik', () => {
  const msg = 'cek dua foto ini ya, yang kiri lebih baru\n\n[Lampiran dari pemilik, 2 file]\n- a.jpg';
  const rows = chatTimeline([], [{ id: 'q', text: msg, at: 'T2' }], [{ id: 'a', at: 'T1', message: msg, note: 'cek dua foto ini ya, yang kiri lebih baru' }]);
  assert.equal(rows.find(r => r.k === 'outbox').item.text, 'cek dua foto ini ya, yang kiri lebih baru');
});
