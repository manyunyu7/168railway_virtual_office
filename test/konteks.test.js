import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konteks-'));
// laporan agen menulis ke DB: jangan sampai menyentuh ~/.kantor-claude milik daemon sungguhan
process.env.KANTOR_HOME = path.join(dir, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
const { sessionKonteks, askOf, closingQuestion, stateOf, plain, setKerjaan } = await import('../server/konteks.js');
let n = 0;
const write = rows => { const f = path.join(dir, `t${n++}.jsonl`); fs.writeFileSync(f, rows.map(r => JSON.stringify(r) + '\n').join('')); return f; };
const user = (content, extra = {}) => ({ parentUuid: 'p', isSidechain: false, type: 'user', message: { role: 'user', content }, timestamp: '2026-11-04T01:00:00Z', ...extra });
const said = (text, extra = {}) => ({ parentUuid: 'p', isSidechain: false, message: { model: 'claude-opus-5-5', id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text }] }, type: 'assistant', timestamp: '2026-11-04T01:01:00Z', ...extra });
const edit = file => ({ parentUuid: 'p', isSidechain: false, message: { model: 'claude-opus-5-5', id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] }, type: 'assistant' });
const sess = (transcript, more = {}) => ({ sid: 's', status: 'idle', title: null, transcript, subs: new Map(), ...more });

test('sepele dan pesan sistem bukan permintaan; DM agen disingkat', () => {
  for (const t of ['lanjut', 'ya', 'OK!', 'Gimana?', '/compact', '<command-name>x</command-name>', '[Kantor · waktu tunggu habis] x', '[Request interrupted by user]']) assert.equal(askOf(t), null, t);
  assert.deepEqual(askOf('[Pesan dari Sienna · id d1] cek video Balas dengan tool kantor balas(id="d1") kalau perlu', 'A'), { s: 'Sienna: cek video', at: 'A', from: 'agen' });
  assert.equal(askOf('tolong rapikan chat', 'A').from, 'kamu');
});

test('topik, permintaan, jawaban, dan berkas dari transcript Claude', () => {
  const f = write([user('perbaiki halaman login dong'), edit('/x/a.js'), { type: 'ai-title', aiTitle: 'Perbaikan login' }, said('Sudah **beres**.\n\n```js\nx\n```'), user('lanjut'), edit('/x/b.js')]);
  const k = sessionKonteks(sess(f));
  assert.equal(k.topic, 'Perbaikan login');
  assert.equal(k.ask.s, 'perbaiki halaman login dong');
  assert.equal(k.reply.s, 'Sudah beres.');
  assert.deepEqual(k.files, { names: ['b.js', 'a.js'], n: 2 });
  assert.deepEqual(k.state, { k: 'selesai', label: 'Selesai, nunggu arahan' });
});

test('balasan sekata tidak menimpa laporan', () => {
  const k = sessionKonteks(sess(write([user('cek video baru'), said('Video sudah terkirim ke Telegram.'), said('menunggu')])));
  assert.equal(k.reply.s, 'Video sudah terkirim ke Telegram.');
});

test('salah ketik satu kata tidak menggeser permintaan', () => {
  assert.equal(sessionKonteks(sess(write([user('cari data gapeka lama'), user('lnjurknb')]))).ask.s, 'cari data gapeka lama');
  assert.equal(sessionKonteks(sess(write([user('deploy')]))).ask.s, 'deploy');
});

test('pesan yang masuk antrean saat agen bekerja ikut jadi permintaan; hasil gambar tidak', () => {
  const f = write([user('tugas pertama dong'), user('[Image: original 2160x1350, displayed at 2000x1250]'), { type: 'queue-operation', operation: 'enqueue', timestamp: 'T', content: 'buatkan postingan sangkuriang' }, { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>x</task-notification>' }]);
  assert.deepEqual(sessionKonteks(sess(f)).ask, { s: 'buatkan postingan sangkuriang', at: 'T', from: 'kamu' });
});

test('permintaan baru menghapus daftar berkas; hasil tool tidak dianggap permintaan', () => {
  const f = write([user('pertama yang panjang'), edit('/x/a.js'), user('kedua yang panjang'), user([{ tool_use_id: 't', type: 'tool_result', content: 'output' }])]);
  const k = sessionKonteks(sess(f));
  assert.equal(k.ask.s, 'kedua yang panjang');
  assert.equal(k.files, null);
});

test('judul bawaan shift diabaikan, jatuh ke permintaan terakhir', () => {
  const f = write([{ type: 'custom-title', customTitle: 'Zora · 168Railway' }, user('hapus video lama')]);
  assert.equal(sessionKonteks(sess(f, { role: 'zora', title: 'Zora · 168Railway' })).topic, 'hapus video lama');
});

test('keadaan: bertanya, dihentikan, galat, dan pulih sesudahnya', () => {
  assert.equal(sessionKonteks(sess(write([user('cek ya bro'), said('Sudah.\n\nMau aku deploy sekarang?')]))).state.k, 'tanya');
  assert.equal(sessionKonteks(sess(write([user('cek ya bro'), said('Mulai'), user([{ type: 'text', text: '[Request interrupted by user]' }])]))).state.k, 'henti');
  const err = said('API Error: overloaded', { isApiErrorMessage: true });
  assert.equal(sessionKonteks(sess(write([user('cek ya bro'), err]))).state.k, 'gagal');
  assert.equal(sessionKonteks(sess(write([user('cek ya bro'), err, said('Beres')]))).state.k, 'selesai');
});

test('status sesi mengalahkan isi transcript', () => {
  const c = { reply: { s: 'x', q: null } };
  assert.equal(stateOf({ status: 'working' }, c).k, 'jalan');
  assert.equal(stateOf({ status: 'idle', waiting: { tool: 'Bash' } }, c).k, 'izin');
  assert.equal(stateOf({ status: 'idle', waiting: { tool: 'AskUserQuestion' } }, c).k, 'tanya');
  assert.equal(stateOf({ status: 'idle', subs: [{ status: 'working' }] }, c).label, 'Subagent masih jalan');
  assert.equal(stateOf({ status: 'idle', tunggu: { label: 'menunggu: kartu' } }, c).k, 'tunggu');
});

test('scan bertambah mengikuti baris baru dan ganti file tetap aman', () => {
  const f = write([user('tugas pertama dong')]);
  const s = sess(f);
  assert.equal(sessionKonteks(s).ask.s, 'tugas pertama dong');
  fs.appendFileSync(f, JSON.stringify(user('tugas kedua dong')) + '\n');
  assert.equal(sessionKonteks(s).ask.s, 'tugas kedua dong');
  assert.equal(sessionKonteks(sess(path.join(dir, 'tidak-ada.jsonl'))).state.k, 'kosong');
});

test('pertanyaan penutup dan pembersihan markdown', () => {
  assert.equal(closingQuestion('Beres. Lanjut deploy?'), 'Lanjut deploy?');
  assert.equal(closingQuestion('Apa ini? Sudah aku cek.'), null);
  assert.equal(closingQuestion('Mau?\n\n```\nkode\n```').trim(), 'Mau?');
  assert.equal(plain('## Judul\n- **a** `b`').trim(), 'Judul\na b');
});

test('laporan agen jadi topik, dan kalah oleh permintaan yang datang sesudahnya', () => {
  const s = sess(write([user('tugas lama dong')]), { sid: `k${n}` });
  setKerjaan(s, { judul: 'Migrasi tabel tiket', langkah: 'menulis tes', persen: 40 });
  let k = sessionKonteks(s);
  assert.equal(k.topic, 'Migrasi tabel tiket');
  assert.equal(k.kerjaan.langkah, 'menulis tes');
  assert.equal(k.kerjaan.persen, 40);
  setKerjaan(s, { langkah: 'deploy' });
  assert.equal(sessionKonteks(s).kerjaan.judul, 'Migrasi tabel tiket');
  fs.appendFileSync(s.transcript, JSON.stringify(user('ganti kerjaan baru', { timestamp: '2099-01-01T00:00:00Z' })) + '\n');
  k = sessionKonteks(s);
  assert.equal(k.kerjaan, null);
  assert.equal(k.topic, 'ganti kerjaan baru');
  setKerjaan(s, { selesai: true });
  assert.throws(() => setKerjaan(s, {}), /judul/);
  assert.equal(setKerjaan(s, { judul: 'x', persen: 500 }).persen, null);
});
