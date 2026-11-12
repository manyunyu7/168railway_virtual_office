import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teammateMsgs, teammateRest } from '../web/js/teammate.js';
import { askOf } from '../server/konteks.js';

test('JSON idle_notification jadi kartu: pengirim, jenis, ringkasan, isi', () => {
  const t = 'Another Claude session sent a message:\n<teammate-message teammate_id="token-galeri" color="green">\n{"type":"idle_notification","from":"token-galeri","summary":"Kabari file","result":"Sudah di-push **main**."}\n</teammate-message>';
  assert.deepEqual(teammateMsgs(t), [{ from: 'token-galeri', color: 'green', summary: 'Kabari file', body: 'Sudah di-push **main**.', kind: 'selesai' }]);
});

test('teks biasa dengan atribut summary, JSON terpotong tetap tampil, bukan pesan antar-sesi = null', () => {
  const [m] = teammateMsgs('<teammate-message teammate_id="team-lead" summary="Pecah jadi 3 deck">Ubah jadi tiga deck.</teammate-message>');
  assert.equal(m.summary, 'Pecah jadi 3 deck'); assert.equal(m.body, 'Ubah jadi tiga deck.'); assert.equal(m.kind, 'pesan');
  assert.equal(teammateMsgs('<teammate-message teammate_id="x">{"type":"idle_noti').length, 1);
  assert.equal(teammateMsgs('tolong cek galeri'), null);
});

test('konteks: pesan antar-sesi dihitung permintaan agen, bukan pemilik', () => {
  const a = askOf('Another Claude session sent a message:\n<teammate-message teammate_id="thumb" summary="Cek thumbnail">isi</teammate-message>', 'A');
  assert.deepEqual(a, { s: 'thumb: Cek thumbnail', at: 'A', from: 'agen' });
});

test('kalimat pemilik di luar tag tetap jadi pesannya', () => {
  const t = '<pasted_content id="1">\nAnother Claude session sent a message:\n<teammate-message teammate_id="a">x</teammate-message>\n</pasted_content>\n\n terus ini bisa beda tampilannya';
  assert.equal(teammateRest(t), 'terus ini bisa beda tampilannya');
  assert.equal(teammateRest('<teammate-message teammate_id="a">x</teammate-message>'), '');
});

test('tanpa ringkasan: baris pertama isi jadi pratinjau', () => {
  const [m] = teammateMsgs('<teammate-message teammate_id="beranda-a">\n# Laporan **revisi** beranda\n\nIsi panjang</teammate-message>');
  assert.equal(m.summary, 'Laporan revisi beranda');
});
