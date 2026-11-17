// Jawaban agen yang sedang ditulis, dibaca dari layar pane (server/stream-screen.js + server/stream.js).
// Fixture di test/fixtures/stream/ adalah capture-pane -p -J -e asli dari Claude Code 2.1.326 (64/72 kolom) dan
// Codex 0.167 (100/120 kolom) yang sedang menulis jawaban (sesi scratch, path disamarkan), plus pesan finalnya dari
// transkrip/rollout (*.txt). claude-headings/claude-links/codex-server-*/codex-backup-*: judul #/##/###, kode inline,
// blok kode tanpa bahasa (juga yang memuat baris kosong), tautan, kutipan, daftar bersarang, tabel, markdown mentah.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-stream-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const { extractStream, parseAnsi, stitch, formatLines, closeTail, sameAsTranscript, lastAssistantText, tailText, norm, MAX_TEXT } = await import('../server/stream-screen.js');
const { createStreamer, WATCH_TTL_S, LOCAL_MS, REMOTE_MS, TICK_MS } = await import('../server/stream.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream');
const fx = name => fs.readFileSync(path.join(DIR, name), 'utf8');
const JUNK = /❯|⏵⏵|esc to interrupt|shift\+tab|ctrl\+o|⎿|Listed \d|✻|✳|Sautéed|weekly limit|Ask Codex|for shortcuts|Worked for|• Working|Explored|└ |Show details|GPT-6/;

/* ---------------- Claude Code ---------------- */
test('Claude: jawaban yang sedang ditulis, tanpa prompt, alat, spinner, kotak input, footer', () => {
  const r = extractStream(fx('claude-writing.ansi'), 'claude');
  assert.ok(r);
  assert.equal(r.head, true);
  assert.match(r.text, /^## Perawatan Rutin Sepeda\n\nSepeda yang dirawat dengan baik terasa lebih ringan dikayuh, lebih aman dipakai, dan awet bertahun-tahun\./);
  assert.doesNotMatch(r.text, JUNK);
  assert.doesNotMatch(r.text, /Saya akan menjalankan/); // blok teks sebelum alat sudah selesai (ada di transkrip)
  assert.doesNotMatch(r.text, /Mulai jawabanmu/);       // prompt pengguna
  // baris yang dibungkus terminal disambung lagi, daftar dan tebal dipertahankan
  assert.match(r.text, /\n1\. \*\*Periksa tekanan ban\.\*\* Ban yang kurang angin membuat kayuhan berat dan mudah bocor\. Cek seminggu sekali/);
  assert.match(r.text, /\n- Kencangkan baut sadel, stang, dan roda dengan kunci yang sesuai\.\n- Periksa kabel/);
  assert.match(r.text, /\*\*Rawat sedikit tapi sering, jangan menunggu sampai ada yang rusak\.\*\*/);
  // tabel kotak (masih setengah jadi) di dalam ```
  assert.match(r.text, /```\n┌─+┬/);
});

test('Claude: blok kode berwarna sintaks jadi ``` dengan indentasi aslinya', () => {
  const r = extractStream(fx('claude-writing-code.ansi'), 'claude');
  assert.match(r.text, /```\njarak_total = 0\ncatatan = \[12\.5, 8\.0, 20\.3, 15\.2\]\nfor km in catatan:\n {4}jarak_total \+= km\nprint\(f"Total: \{jarak_total\} km"\)\n.*\n```/);
  assert.match(r.text, /kempiskan ban sedikit dan gantung atau$/); // ekor yang sedang ditulis
  assert.doesNotMatch(r.text, JUNK);
});

test('Claude: alat sedang jalan sesudah teks → tidak ada teks sementara', () => {
  assert.equal(extractStream(fx('claude-tool-running.ansi'), 'claude'), null);
});

test('Claude: jawaban selesai di layar sama dengan pesan di transkrip', () => {
  const r = extractStream(fx('claude-done.ansi'), 'claude');
  assert.ok(r);
  assert.doesNotMatch(r.text, JUNK);
  const final = fx('claude-done.txt');
  assert.equal(sameAsTranscript(r.text, final), true);
  assert.equal(sameAsTranscript(r.text, 'Pesan lain sama sekali yang tidak berhubungan dengan sepeda.'), false);
  // markdown asli vs layar: huruf/angka sama persis (```python kehilangan nama bahasanya); hanya urutan kata di sel
  // tabel yang dibungkus berbeda
  assert.equal(norm(r.text).length, norm(final.replace('```python', '```')).length);
  assert.match(r.text, /\n## Jadwal dan Pencatatan\n/);
  assert.match(r.text, /Gunakan `oli rantai` khusus sepeda/);
});

test('Claude: awal jawaban sudah tergulir dari riwayat → ekor saja (head:false), tanpa footer', () => {
  const r = extractStream(fx('claude-scrolled.ansi'), 'claude');
  assert.ok(r);
  assert.equal(r.head, false);
  assert.match(r.text, /^mulai beroperasi pada 1867\.\n\nTujuan awalnya ekonomi\./);
  assert.match(r.text, /\*\*Peristiwa itu menjadi tonggak lahirnya perkeretaapian nasional dan diperingati setiap tahun\*\*$/);
  assert.doesNotMatch(r.text, JUNK);
});

/* ---------------- Codex ---------------- */
test('Codex: pesan pembuka saat "Working" → teks itu saja', () => {
  const r = extractStream(fx('codex-commentary.ansi'), 'codex');
  assert.equal(r.text, 'Rem cakram sepeda memperlambat putaran roda dengan mengubah energi gerak menjadi panas melalui gesekan.');
});

test('Codex: item alat terakhir → null; teks sesudah alat → hanya teks baru', () => {
  assert.equal(extractStream(fx('codex-tool-running.ansi'), 'codex'), null);
  const r = extractStream(fx('codex-after-tool.ansi'), 'codex');
  assert.equal(r.text, '## Cara Kerja Rem Cakram Sepeda\nRem cakram sepeda bekerja dengan menjepit sebuah piringan logam yang disebut rotor. Rotor terpasang pada hub,');
});

test('Codex: jawaban selesai sama dengan rollout, "Worked for" dan composer tidak ikut', () => {
  const r = extractStream(fx('codex-done.ansi'), 'codex');
  assert.doesNotMatch(r.text, JUNK);
  assert.equal(r.head, false); // layar alternatif: awal jawaban sudah tergulir, ekornya tetap cocok dengan rollout
  assert.equal(sameAsTranscript(r.text, fx('codex-done.txt')), true);
  assert.match(r.text, /^- Ketika tuas dilepas, kampas kembali memiliki celah kecil terhadap rotor/);
  assert.match(r.text, /panasnya dapat melukai kulit\.$/);
});

test('Codex: layar alternatif yang bergulir disambung jadi jawaban utuh', () => {
  const frames = fs.readdirSync(DIR).filter(f => /^codex-scroll-\d+\.ansi$/.test(f)).sort();
  assert.ok(frames.length >= 10);
  let prev = null, r = null, heads = [];
  for (const f of frames) { r = extractStream(fx(f), 'codex', prev); prev = r?.lines || null; heads.push(r.head); }
  assert.ok(heads.length > 5);
  const real = fx('codex-scroll-final.txt');
  assert.equal(norm(r.text), norm(real.replace('```python', '```')));
  assert.match(r.text, /^## Perawatan rutin agar sepeda nyaman dan awet\n\nMerawat sepeda/);
  assert.match(r.text, /\n```\nfrom datetime import date, timedelta\n/);
  // tanpa sambungan, layar terakhir hanya memuat ekornya
  const alone = extractStream(fx(frames[frames.length - 1]), 'codex');
  assert.equal(alone.head, false);
  assert.ok(alone.text.length < r.text.length / 2);
});

test('stitch: tumpukan baris (abaikan baris kosong, baris terakhir boleh dibungkus ulang), tanpa tumpukan → layar baru', () => {
  const L = s => parseAnsi(s);
  const prev = L('  satu\n  dua\n\n  tiga\n  empat setengah mengg');
  assert.deepEqual(stitch(prev, L('  dua\n  tiga\n  empat setengah\n  menggambarkan lima'), false).map(l => l.t.trim()),
    ['satu', 'dua', 'tiga', 'empat setengah', 'menggambarkan lima']);
  assert.deepEqual(stitch(prev, L('  x\n  y'), false).map(l => l.t.trim()), ['x', 'y']);
  assert.deepEqual(stitch(prev, L('  baru'), true).map(l => l.t.trim()), ['baru']);
});

test('formatLines, tailText, lastAssistantText', () => {
  assert.equal(formatLines(parseAnsi('  baris satu yang\n  terus-\n  menerus\n\n  - a\n    b\n  2. c')), 'baris satu yang terus-menerus\n\n- a b\n2. c');
  const long = Array.from({ length: 2000 }, (_, i) => `baris ${i}`).join('\n');
  const t = tailText(long);
  assert.ok(t.length <= MAX_TEXT + 1 && t.startsWith('…\n') && t.endsWith('baris 1999'));
  assert.equal(lastAssistantText([{ k: 'text', s: 'lama' }, { k: 'user', s: 'tanya' }, { k: 'tool', s: 'Bash ls' }]), null);
  assert.equal(lastAssistantText([{ k: 'user', s: 'tanya' }, { k: 'text', s: 'jawab' }, { k: 'tool', s: 'Bash ls' }]), 'jawab');
  assert.equal(sameAsTranscript('Oke', 'Oke, sudah kukirim semua filenya ke sini.'), false); // teks pendek tidak dianggap duplikat
});

/* ---------------- markdown dari gaya layar ---------------- */
const fence = t => (t.match(/^```/gm) || []).length;
const codexSeq = (files, prev = null, pp = false) => {
  let r = null;
  for (const f of files) { const x = extractStream(fx(f), 'codex', prev, pp); if (x) { r = x; prev = x.lines; pp = x.partial; } }
  return r;
};
const BACKUP = fs.readdirSync(DIR).filter(f => /^codex-backup-\d+\.ansi$/.test(f)).sort();

test('judul Claude: tebal+miring+garis bawah → #, tebal saja di baris sendiri → ##; paragraf tebal tetap **…**', () => {
  const r = extractStream(fx('claude-headings.ansi'), 'claude');
  assert.match(r.text, /^# Panduan Menyiapkan Server Kecil di Rumah\n\nServer rumahan cocok/);
  assert.match(r.text, /\n\n## Persiapan Perangkat dan Jaringan\n\nSebelum memasang/);
  assert.match(r.text, /\n\n## Instalasi dan Konfigurasi\n\n/);
  // ### di layar sama persis dengan ## (hanya tebal): jadi ##
  assert.match(r.text, /\n\n## Pengaturan dasar\n\nIkuti urutan/);
  // paragraf yang seluruhnya tebal tapi berupa kalimat (titik di akhir) bukan judul
  assert.match(r.text, /\n\n\*\*Selalu pasang pembaruan keamanan sebelum server Anda terhubung ke internet\.\*\*\n\n/);
  const r2 = extractStream(fx('claude-links.ansi'), 'claude');
  assert.match(r2.text, /^## Catatan Singkat Backup Data Rumahan\n\n/);
  assert.match(r2.text, /\n\n## Memilih alat\n\n/);
  // Codex menulis judulnya apa adanya
  assert.match(extractStream(fx('codex-backup-0007.ansi'), 'codex').text, /^## Catatan Backup Data Rumahan\n/);
  assert.match(extractStream(fx('codex-server-0058.ansi'), 'codex').text, /\n\n### Instalasi, Akses, dan Perawatan\n\n/);
});

test('kode inline: rentang sel berwarna kode jadi `…` (juga yang dibungkus ke baris berikutnya), tautan dan tebal tidak', () => {
  const r = extractStream(fx('claude-headings.ansi'), 'claude');
  assert.match(r.text, /dengan `ssh pengguna@192\.168\.1\.50`\.\n/); // terbungkus terminal di tengah kode
  assert.match(r.text, /berkas seperti `config\.yaml` untuk/);
  assert.match(r.text, /Jika `debug` dibiarkan aktif.*menjadi `false` sebelum/);
  assert.match(r.text, /di `\/etc\/ssh\/sshd_config` dan/);
  const l = extractStream(fx('claude-links.ansi'), 'claude').text;
  assert.match(l, /ada di \[situs restic\]\(https:\/\/restic\.net\)\. Anda/);
  assert.match(l, /pribadi di https:\/\/example\.com\/backup agar/);
  assert.doesNotMatch(l, /`[^`\n]*(?:restic\.net|example\.com)/);
  assert.match(l, /cukup dengan `restic backup ~\/foto`\. Contoh/);
  assert.match(l, /\*\*Backup yang belum pernah diuji pemulihannya belum bisa disebut backup\.\*\*/);
  assert.match(l, /\n\n> Aturan 3-2-1: simpan tiga salinan data, di dua jenis media berbeda, dengan satu salinan di luar rumah\.\n\n/);
  // Codex: kode hijau, tebal/miring berwarna, tautan "teks (url)" → [teks](url), kode di dalam kalimat tebal
  const c = extractStream(fx('codex-server-0072.ansi'), 'codex').text;
  assert.match(c, /Perintah `sudo apt update` memperbarui/);
  assert.match(c, /Aturan `OpenSSH` memberi/);
  assert.match(c, /seperti `config\.yaml` dalam/);
  assert.match(c, /secara \*bertahap\*: jalankan/);
  assert.match(c, /\*\*Cadangan yang berguna harus tersimpan terpisah dari server utama dan sudah pernah diuji untuk memulihkan berkas penting\.\*\*/);
  const b = codexSeq(BACKUP).text;
  assert.match(b, /melalui \[situs restic\]\(https:\/\/restic\.net\)\. Sebelum/);
  assert.match(b, /\*\*Sebelum menjalankan perintah `restic init` untuk membuat repositori cadangan, pastikan lokasi tujuan sudah benar dan kata sandinya tersimpan dengan aman\.\*\*/);
  assert.match(b, /\n> Cadangan baru benar-benar berguna/);
  assert.doesNotMatch(b, /`> /); // kutipan berwarna bukan kode
});

test('blok kode tanpa warna sintaks: tidak disambung jadi paragraf, baris kosong di dalamnya tetap satu blok', () => {
  const h = extractStream(fx('claude-headings.ansi'), 'claude').text;
  assert.match(h, /:\n\n```\nsudo apt update\nsudo apt upgrade -y\nsudo apt install openssh-server ufw\nsudo ufw allow 22\/tcp\nsudo ufw enable\n```\n\nSetelah itu/);
  assert.match(h, /\n```\nserver:\n {2}host: 0\.0\.0\.0\n {2}port: 8080\n {2}debug: false\n```\n/);
  assert.equal(fence(h), 6); // tabel + dua blok kode, prosa tidak ikut
  const l = extractStream(fx('claude-links.ansi'), 'claude').text;
  assert.match(l, /\n```\nexport RESTIC_REPOSITORY=\/mnt\/disk-backup\nexport RESTIC_PASSWORD_FILE=~\/\.restic-pass\nrestic init\n\nrestic backup ~\/foto ~\/dokumen\nrestic forget --keep-daily 7 --keep-weekly 4 --prune\n```\n/);
  assert.equal(fence(l), 2);
  // Codex: blok tanpa bahasa tampil polos; selama menulis paragraf sesudahnya menempel tanpa baris kosong
  const c = extractStream(fx('codex-server-0053.ansi'), 'codex').text;
  assert.match(c, /menggunakannya\.\n\n```\nsudo apt update\nsudo apt upgrade\nsudo apt install openssh-server ufw\nsudo ufw allow OpenSSH\nsudo ufw enable\n```\n\nPerintah `sudo apt update` memperbarui daftar paket/);
  const b = codexSeq(BACKUP).text;
  assert.match(b, /\n\n```\nexport RESTIC_REPOSITORY="\/media\/backup\/repositori"\nrestic init\nrestic backup "\$HOME\/Documents"\n\nrestic snapshots\nrestic check\n```\n\nContoh tersebut/);
  assert.equal(fence(b), 2);
  // tabel Codex (garis ━/─) di dalam ```, judul yang menempel sesudahnya tidak ikut masuk
  const t = extractStream(fx('codex-server-0038.ansi'), 'codex').text;
  assert.match(t, /```\n Komponen {9}Fungsi\n━+ {2}━+\n/);
  assert.match(t, /Disk cadangan {4}Menyimpan salinan pemulihan\n```\n\n### Instalasi,$/);
  // prosa pendek berbaris-baris (kalimat selesai) dan daftar bukan kode
  assert.equal(formatLines(parseAnsi('  Sudah kukirim.\n  Cek lagi nanti.\n\n  - a\n  - b'), 'codex'), 'Sudah kukirim. Cek lagi nanti.\n\n- a\n- b');
  assert.equal(formatLines(parseAnsi('  npm install\n  npm test\n  Selesai ditulis dalam satu kalimat yang cukup panjang untuk prosa'), 'codex'),
    '```\nnpm install\nnpm test\n```\n\nSelesai ditulis dalam satu kalimat yang cukup panjang untuk prosa');
});

test('Codex: markdown mentah yang belum tertutup di ekor dibersihkan, teks final tidak diubah', () => {
  assert.equal(closeTail('Paragraf.\n**Saat pengereman'), 'Paragraf.\n**Saat pengereman**');
  assert.equal(closeTail('Lalu **'), 'Lalu');
  assert.equal(closeTail('berkas `config.y'), 'berkas `config.y`');
  assert.equal(closeTail('**Sebelum `restic init` untuk'), '**Sebelum `restic init` untuk**');
  assert.equal(closeTail('kata *miring'), 'kata *miring*');
  assert.equal(closeTail('kata _miring'), 'kata _miring_');
  assert.equal(closeTail('Contoh:\n\n```\nls -la'), 'Contoh:\n\n```\nls -la\n```');
  for (const s of ['**tebal** dan `kode` serta *miring*', 'nama_berkas_ini.txt dan a * b', '```\nx = `y`\n```', '2 * 3 = 6']) assert.equal(closeTail(s), s);
  // layar asli: "**S" dan "**Sebelum … `restic init` … sudah benar" (Codex belum merender tebalnya)
  assert.match(extractStream(fx('codex-backup-0019.ansi'), 'codex').text, /memulihkan berkas\. \*\*S\*\*$/);
  assert.match(extractStream(fx('codex-backup-0020.ansi'), 'codex').text, / \*\*Sebelum menjalankan perintah `restic init` untuk membuat repositori cadangan, pastikan lokasi tujuan sudah benar\*\*$/);
  assert.match(extractStream(fx('codex-server-0058.ansi'), 'codex').text, / \*\*Cadangan yang\*\*$/);
  // jawaban selesai: sama dengan rollout, closeTail tidak mengubah apa pun
  const done = codexSeq(BACKUP).text;
  assert.equal(closeTail(done), done);
  assert.doesNotMatch(done, /\*\*\S[^*]*$/);
  // Claude tidak menampilkan markdown mentah: tidak disentuh
  assert.equal(extractStream(fx('claude-links.ansi'), 'claude').text.endsWith('secara acak.'), true);
});

test('partial: awal jawaban tidak terlihat → partial:true (tetap true saat disambung), terlihat → false', () => {
  assert.equal(extractStream(fx('claude-writing.ansi'), 'claude').partial, false);
  assert.equal(extractStream(fx('claude-scrolled.ansi'), 'claude').partial, true);
  assert.equal(extractStream(fx('codex-done.ansi'), 'codex').partial, true);
  // dari awal: semua bacaan partial:false walau layar terakhir hanya memuat ekor
  assert.equal(codexSeq(BACKUP).partial, false);
  assert.equal(extractStream(fx(BACKUP[BACKUP.length - 1]), 'codex').partial, true);
  // chat dibuka di tengah jawaban: partial:true sampai selesai
  const mid = BACKUP.filter(f => f >= 'codex-backup-0029.ansi');
  const r = codexSeq(mid);
  assert.equal(r.partial, true);
  assert.ok(!r.text.startsWith('## Catatan'));
  assert.equal(sameAsTranscript(r.text, fx('codex-backup-final.txt')), true);
});

test('streamer: partial ikut di event dan GET /stream', async () => {
  const screens = { a: fx('codex-backup-0029.ansi') };
  const r = rig({ engine: 'codex', screens });
  r.mk('a'); r.streamer.watch('a');
  await r.streamer.tick();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].partial, true);
  assert.equal(r.streamer.get('a').partial, true);
  screens.a = fx('codex-backup-0032.ansi');
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 2);
  assert.equal(r.events[1].partial, true); // disambung dari bacaan yang sudah partial
  const c = rig({ engine: 'codex', screens: { b: fx('codex-backup-0007.ansi') } });
  c.mk('b'); c.streamer.watch('b'); await c.streamer.tick();
  assert.ok(!('partial' in c.events[0]));
  assert.equal(c.streamer.get('b').partial, false);
});

test('interval capture lokal tetap 350–400 ms, layar sama tidak memicu event ganda, capture lambat tidak bertumpuk', async () => {
  assert.ok(LOCAL_MS >= 300 && LOCAL_MS + TICK_MS <= 400);
  const r = rig({ screens: { a: fx('claude-writing.ansi') } });
  r.mk('a'); r.streamer.watch('a');
  const at = [];
  const cap = r.calls.push.bind(r.calls);
  r.calls.push = (...x) => { at.push(r.now()); return cap(...x); };
  for (let t = 0; t < 5_000; t += TICK_MS) { await r.streamer.tick(); r.advance(TICK_MS); }
  const gaps = at.slice(1).map((x, i) => x - at[i]);
  assert.ok(gaps.length >= 12);
  for (const g of gaps) assert.ok(g >= 300 && g <= 400, `jarak ${g} ms`);
  assert.equal(r.events.length, 1);
  // capture yang lebih lama dari interval: putaran berikutnya tidak membaca sesi yang sama dua kali sekaligus
  const s = rig({ screens: { a: fx('claude-writing.ansi') } });
  s.mk('a'); s.streamer.watch('a'); s.hold = true;
  const ticks = [];
  for (let t = 0; t < 1_000; t += TICK_MS) { ticks.push(s.streamer.tick()); s.advance(TICK_MS); }
  assert.equal(s.calls.length, 1);
  while (s.pending.length) s.pending.shift()();
  await Promise.all(ticks);
  assert.equal(s.events.length, 1);
});

test('hasil akhir rekaman baru sama dengan transkrip/rollout', () => {
  const h = extractStream(fx('claude-headings.ansi'), 'claude').text;
  assert.equal(sameAsTranscript(h, fx('claude-headings.txt')), true);
  assert.equal(norm(h), norm(fx('claude-headings.txt')));
  const l = extractStream(fx('claude-links.ansi'), 'claude').text;
  assert.equal(norm(l), norm(fx('claude-links.txt')));
  assert.equal(norm(codexSeq(BACKUP).text), norm(fx('codex-backup-final.txt')));
  assert.equal(sameAsTranscript(extractStream(fx('codex-server-0072.ansi'), 'codex').text, fx('codex-server-final.txt')), true);
  // selisih yang tersisa: ### tampil sama dengan ## di layar Claude, tabel tetap gambar kotak di dalam ```
  const lines = new Set(h.split('\n'));
  const missing = fx('claude-headings.txt').split('\n').filter(x => x && !lines.has(x) && !/^\|/.test(x));
  assert.deepEqual(missing, ['### Pengaturan dasar']);
});

/* ---------------- streamer: watch, done, duplikat, throttle, seq ---------------- */
function rig({ engine = 'claude', machine = 'local', screens = {}, last = null } = {}) {
  let t = Date.parse('2026-11-17T10:00:00Z');
  const sessions = new Map();
  const events = [], calls = [];
  const lock = new Set();
  const mk = (sid, extra = {}) => { const s = { sid, office: 'o1', tmux: `kc-${sid}`, engine, status: 'working', ...extra }; sessions.set(sid, s); return s; };
  const pending = [];
  const r = {
    sessions, events, calls, lock, mk, pending, last,
    now: () => t, advance: ms => { t += ms; },
    hold: false,
    streamer: null,
  };
  r.streamer = createStreamer({
    sessions, emit: e => events.push(e), lastText: () => r.last, mtime: () => null,
    machine: s => s.machine || machine, offline: () => false, busy: lock, now: () => t,
    capture: (s, m) => { calls.push([s.sid, m]); const v = typeof screens[s.sid] === 'function' ? screens[s.sid]() : screens[s.sid]; if (!r.hold) return Promise.resolve(v ?? null); return new Promise(res => pending.push(() => res(v ?? null))); },
  });
  return r;
}

test('watch: {ok, ttl:30}; tanpa watch tidak dibaca; lewat 30 dtk berhenti dan done sekali', async () => {
  const r = rig({ screens: { a: fx('claude-writing.ansi') } });
  r.mk('a');
  await r.streamer.tick();
  assert.equal(r.calls.length, 0); // belum di-watch
  assert.deepEqual(r.streamer.watch('a'), { ok: true, ttl: 30 });
  assert.equal(WATCH_TTL_S, 30);
  await r.streamer.tick();
  assert.equal(r.calls.length, 1);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.t, 'stream'); assert.equal(e.office, 'o1'); assert.equal(e.sid, 'a');
  assert.match(e.text, /^## Perawatan Rutin Sepeda/);
  assert.ok(!('done' in e));
  assert.ok(!('partial' in e));
  assert.deepEqual(r.streamer.get('a'), { text: e.text, seq: e.seq, at: e.at, partial: false });
  // layar sama → tidak ada event baru
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.calls.length, 2); assert.equal(r.events.length, 1);
  // diperpanjang di detik ke-20, lalu dibiarkan habis
  r.advance(20_000); r.streamer.watch('a');
  r.advance(29_000); await r.streamer.tick();
  assert.equal(r.streamer.isWatched('a'), true);
  r.advance(1_500); await r.streamer.tick();
  assert.equal(r.streamer.isWatched('a'), false);
  const done = r.events.filter(x => x.done);
  assert.equal(done.length, 1);
  assert.equal(done[0].text, null);
  const n = r.calls.length;
  r.advance(5_000); await r.streamer.tick();
  assert.equal(r.calls.length, n);           // tidak dibaca lagi
  assert.equal(r.events.filter(x => x.done).length, 1);
  assert.equal(r.streamer.get('unknown').text, null);
});

test('done: sesi idle → {text:null, done:true} sekali; layar tanpa teks juga menutup stream', async () => {
  const screens = { a: fx('claude-writing.ansi') };
  const r = rig({ screens });
  const s = r.mk('a');
  r.streamer.watch('a');
  await r.streamer.tick();
  assert.equal(r.events.length, 1);
  s.status = 'idle';
  r.advance(LOCAL_MS); await r.streamer.tick();
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 2);
  assert.deepEqual({ ...r.events[1], seq: 0, at: 0 }, { t: 'stream', office: 'o1', sid: 'a', text: null, seq: 0, at: 0, done: true });
  assert.equal(r.calls.length, 1); // idle: layar tidak dibaca
  // kerja lagi, alat jalan sesudah teks → null → done
  s.status = 'working';
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 3);
  screens.a = fx('claude-tool-running.ansi');
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 4); assert.equal(r.events[3].done, true);
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 4);
});

test('duplikat: teks yang sama dengan pesan asisten terakhir di transkrip tidak dikirim; yang sedang jalan ditutup', async () => {
  // chat dibuka saat jawaban sudah selesai (status masih working sebentar): tidak ada event
  const r0 = rig({ screens: { a: fx('claude-done.ansi') }, last: fx('claude-done.txt') });
  r0.mk('a'); r0.streamer.watch('a'); await r0.streamer.tick();
  assert.equal(r0.events.length, 0);
  // sedang menulis lalu transkrip mendapat pesan finalnya
  const screens = { a: fx('claude-writing-code.ansi') };
  const r = rig({ screens });
  r.mk('a'); r.streamer.watch('a');
  await r.streamer.tick();
  assert.equal(r.events.length, 1);
  screens.a = fx('claude-done.ansi');
  r.last = fx('claude-done.txt');
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 2); assert.equal(r.events[1].done, true); assert.equal(r.events[1].text, null);
  // jawaban selesai yang masih di layar tidak dikirim ulang, walau transkripnya tidak terbaca
  r.last = null;
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 2);
  assert.equal(r.streamer.get('a').text, null);
  // Codex: sama
  const c = rig({ engine: 'codex', screens: { b: fx('codex-done.ansi') }, last: fx('codex-done.txt') });
  c.mk('b'); c.streamer.watch('b'); await c.streamer.tick();
  assert.equal(c.events.length, 0);
});

test('layar setengah digambar ulang (teks menyusut) diabaikan sekali', async () => {
  const screens = { a: fx('codex-before-torn.ansi') };
  const r = rig({ engine: 'codex', screens });
  r.mk('a'); r.streamer.watch('a');
  await r.streamer.tick();
  assert.equal(r.events.length, 1);
  screens.a = fx('codex-torn.ansi');
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 1); // dibuang
  r.advance(LOCAL_MS); await r.streamer.tick();
  assert.equal(r.events.length, 2); // terbaca sama dua kali → dipercaya
});

test('throttle: ±350 ms lokal, ±1000 ms Mac lain, satu capture per mesin (kunci dipakai bersama blocker)', async () => {
  const scr = fx('claude-writing.ansi');
  const r = rig({ screens: { a: scr, b: scr, c: scr } });
  r.mk('a'); r.mk('b'); r.mk('c', { machine: 'macbook' });
  for (const sid of ['a', 'b', 'c']) r.streamer.watch(sid);
  r.hold = true;
  const t1 = r.streamer.tick();
  // mesin lokal: a dulu, b menunggu a selesai; macbook jalan terpisah
  assert.deepEqual(r.calls, [['a', 'local'], ['c', 'macbook']]);
  r.streamer.tick(); // putaran berikutnya saat kedua mesin masih dibaca: tidak ada capture baru
  assert.equal(r.calls.length, 2);
  r.pending.shift()(); await new Promise(res => setImmediate(res));
  assert.deepEqual(r.calls[2], ['b', 'local']);
  while (r.pending.length) { r.pending.shift()(); await new Promise(res => setImmediate(res)); }
  await t1;
  r.hold = false;
  r.advance(LOCAL_MS - 50); await r.streamer.tick();
  assert.equal(r.calls.length, 3);
  r.advance(60); await r.streamer.tick();
  assert.deepEqual(r.calls.slice(3).map(x => x[0]).sort(), ['a', 'b']);
  r.advance(REMOTE_MS - LOCAL_MS); await r.streamer.tick();
  assert.ok(r.calls.slice(5).some(x => x[0] === 'c'));
  // mesin dikunci blocker → dilewati
  r.lock.add('local');
  const n = r.calls.length;
  r.advance(5_000); await r.streamer.tick();
  assert.ok(!r.calls.slice(n).some(x => x[1] === 'local'));
});

test('hanya sesi tmux claude/codex; antigravity dan sesi tanpa tmux dilewati', async () => {
  const scr = fx('claude-writing.ansi');
  const r = rig({ screens: { a: scr, b: scr, c: scr } });
  r.mk('a', { engine: 'antigravity' }); r.mk('b', { tmux: null }); r.mk('c', { blocker: { kind: 'login' } });
  for (const sid of ['a', 'b', 'c']) r.streamer.watch(sid);
  await r.streamer.tick();
  assert.equal(r.calls.length, 0);
});

test('seq berbasis waktu: naik terus, juga sesudah daemon restart', async () => {
  const screens = { a: fx('codex-scroll-0016.ansi') };
  const r = rig({ engine: 'codex', screens });
  r.mk('a'); r.streamer.watch('a');
  await r.streamer.tick();
  const s1 = r.events[0].seq;
  assert.ok(s1 >= r.now() * 1000, 'seq = Date.now() * 1000 (+ penghitung)');
  assert.ok(Number.isSafeInteger(s1));
  screens.a = fx('codex-scroll-0026.ansi');
  await r.streamer.process(r.sessions.get('a'), screens.a); // waktu yang sama: tetap naik
  screens.a = fx('codex-scroll-0036.ansi');
  await r.streamer.process(r.sessions.get('a'), screens.a);
  const seqs = r.events.map(e => e.seq);
  assert.equal(seqs.length, 3);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  assert.equal(r.streamer.get('a').seq, seqs[2]);
  // "restart": streamer baru, beberapa detik kemudian
  const r2 = rig({ engine: 'codex', screens: { a: fx('codex-scroll-0016.ansi') } });
  r2.advance(3_000);
  r2.mk('a'); r2.streamer.watch('a'); await r2.streamer.tick();
  assert.ok(r2.events[0].seq > seqs[2]);
});
