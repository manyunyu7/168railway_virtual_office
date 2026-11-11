import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// KANTOR_HOME sementara SEBELUM modul server diimpor (import dinamis di before): import statis akan menulis ke DB sungguhan
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-konten-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const app = path.join(root, 'toko/app');
const kroot = path.join(root, 'toko/konten');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, 'go.mod'), 'module app');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));
const OFFICE = 'toko';

const w = (rel, content = 'x') => { const f = path.join(kroot, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
const PNG = 'PNGDATA';
let K, T, live, store, dm, ag, bd, ap, bus, kimi;
const typed = [];
const notes = [];
const ident = () => ({ office: OFFICE, role: kimi, by: kimi.name, sid: 's-kimi', cwd: app });
const tool = async (name, a) => JSON.parse((await ag.callTool(ident(), name, a)).content[0].text);
const cardOf = id => store.getCard(OFFICE, id);

/** res tiruan untuk serveFile */
async function serve(rel, { thumb = false, range } = {}) {
  const res = { code: 0, headers: {}, body: Buffer.alloc(0), headersSent: false,
    writeHead(c, h) { this.code = c; this.headers = h; this.headersSent = true; },
    end(b) { if (b) this.body = Buffer.concat([this.body, Buffer.from(b)]); this.ended = true; this.done?.(); },
    write(b) { this.body = Buffer.concat([this.body, Buffer.from(b)]); return true; },
    on() { return this; }, once() { return this; }, emit() { return true; }, removeListener() { return this; } };
  res.pipe = undefined;
  const done = new Promise(r => { res.done = r; });
  // createReadStream.pipe(res) memanggil res.on/once/emit/write/end; cukup dengan stub di atas
  await K.serveFile(OFFICE, rel, { thumb }, { headers: range ? { range } : {} }, res);
  if (!res.ended) await Promise.race([done, new Promise(r => setTimeout(r, 1500))]);
  return res;
}

before(async () => {
  const offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  dm = await import('../server/dm.js');
  ag = await import('../server/agent.js');
  bd = await import('../server/boards.js');
  ap = await import('../server/autopilot.js');
  K = await import('../server/konten.js');
  T = await import('../server/konten-import.js');
  bus = live.bus;
  offices.officeForCwd(app);
  kimi = store.createRole(OFFICE, { name: 'Kimi', title: 'Editor', room: 'app' });
  dm.setSender(async (sid, text) => { typed.push({ sid, text }); });
  const s = live.expectSession({ sid: 's-kimi', office: OFFICE, role: kimi.id, room: 'app', cwd: app, tmux: 'kc-test-konten', slot: 0, title: 't' });
  s.status = 'idle';
  bus.on('notify', ev => { if (ev.kind === 'konten') notes.push(ev); });
  fs.mkdirSync(kroot, { recursive: true });
  K.setConf(OFFICE, { root: 'konten', statusFile: 'STATUS.md', targetPerMinggu: 2 });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------------- pure: caption, shortcode, media ---------------- */
test('caption: bagian per platform, YouTube jatuh ke TikTok, tanpa bagian = Instagram', () => {
  const c = T.parseCaption('# Judul\n\n## Instagram\nIG satu\nbaris dua\n\n## TikTok\nTT\n\n## Threads\nTH\n');
  assert.equal(c.instagram, 'IG satu\nbaris dua');
  assert.equal(c.tiktok, 'TT');
  assert.equal(c.threads, 'TH');
  assert.equal(c.youtube, 'TT', 'YouTube kosong memakai TikTok');
  assert.equal(T.parseCaption('Cuma satu caption\nlagi').instagram, 'Cuma satu caption\nlagi');
  assert.equal(T.parseCaption('## Instagram\n   \n').instagram, null);
  const real = T.parseCaption('# Caption\n\n## Instagram\nIG\n#tag1 #tag2\n\n## TikTok\nTT\n\n## Threads\nTH\n\n## Threads balasan\nBALAS\n\n## Catatan\nmeta internal\n');
  assert.equal(real.instagram, 'IG\n#tag1 #tag2'); assert.equal(real.threads, 'TH', 'judul ## lain mengakhiri bagian'); assert.equal(real.youtube, 'TT');
  assert.equal(T.parseCaption('## Caption\nIsi\n\n## Catatan redaksi\nmeta').instagram, 'Isi', '## Caption dibaca sebagai Instagram');
});
test('caption: catatan kerja di berkas lama tidak ikut tersalin', () => {
  const P = T.parseCaption;
  assert.equal(P('# Judul\n\nIsi caption\n#tag\n\n## Catatan redaksi\nrahasia\n\n## Build ulang\n```\n# skrip\n```\n').instagram, 'Isi caption\n#tag');
  assert.equal(P('# J\n\nStatus: FINAL\n\n---\n\n## Versi A — Lengkap\n\nPanjang\n\n---\n\n## Versi B — Pendek\nPendek\n').instagram, 'Panjang', 'versi pertama, status di pembuka dibuang');
  assert.equal(P('# J\n\nAturan tim\n\n---\n\n## 01 — Reel satu\nSatu\n\n## 02 — Reel dua\nDua\n').instagram, 'Satu');
  assert.equal(P('# J\n\nCaption\n\n---\n\nCatatan: untuk tim\n').instagram, 'Caption');
  const j = P('Utama\n\n## Versi Threads (≤500 karakter)\nPendek\n\n## Catatan redaksi\nx\n');
  assert.equal(j.instagram, 'Utama'); assert.equal(j.threads, 'Pendek');
  assert.equal(P('Hanya catatan\n').instagram, 'Hanya catatan');
  assert.equal(P('## Catatan\nmeta\n').instagram, null);
});
test('caption: menulis satu bagian tidak menyentuh bagian lain', () => {
  const src = '# Caption X\n\n## Instagram\nlama\n\n## TikTok\ntt lama\n';
  const out = T.replaceSection(src, 'instagram', 'baru\nbaris');
  assert.equal(out, '# Caption X\n\n## Instagram\nbaru\nbaris\n\n## TikTok\ntt lama\n');
  assert.equal(T.replaceSection(src, 'threads', 'th').includes('## Threads\nth\n'), true);
  const withMeta = '# C\n\n## Instagram\nA\n\n## Threads\nB\n\n## Threads balasan\nR\n\n## Catatan\nmeta\n';
  assert.equal(T.replaceSection(withMeta, 'threads', 'B2'), '# C\n\n## Instagram\nA\n\n## Threads\nB2\n\n## Threads balasan\nR\n\n## Catatan\nmeta\n', 'blok ## lain dijaga');
  assert.equal(T.parseCaption(T.replaceSection(src, 'threads', 'th')).instagram, 'lama');
  assert.equal(T.replaceSection('', 'tiktok', 'a'), '## TikTok\na\n');
  assert.equal(T.replaceSection('polos', 'tiktok', 'a'), '## Instagram\npolos\n\n## TikTok\na\n', 'berkas tanpa bagian dipertahankan sebagai Instagram');
  assert.throws(() => T.replaceSection('', 'x', 'a'), /tidak dikenal/);
  const lama = '# J\n\nCaption lama\n\n---\n\nCatatan: tim\n\n## Catatan redaksi\nmeta\n\n## Build ulang\nnode x\n';
  const baru = T.replaceSection(lama, 'instagram', 'Caption baru');
  assert.equal(T.parseCaption(baru).instagram, 'Caption baru');
  for (const sisa of ['# J', 'Catatan: tim', '## Catatan redaksi\nmeta', '## Build ulang\nnode x']) assert.ok(baru.includes(sisa), `menulis caption tidak menghapus: ${sisa}`);
  const tt = T.replaceSection(lama, 'tiktok', 'TT');
  assert.equal(T.parseCaption(tt).instagram, 'Caption lama', 'catatan tidak ikut masuk bagian Instagram');
  assert.equal(T.parseCaption(tt).tiktok, 'TT');
  const v = '# J\n\nStatus: FINAL\n\n## Versi A\nPanjang\n\n## Versi B\nPendek\n';
  const vb = T.replaceSection(v, 'threads', 'th');
  assert.equal(T.parseCaption(vb).instagram, 'Panjang'); assert.ok(vb.includes('## Versi B\nPendek') && vb.includes('Status: FINAL'));
  const j = T.replaceSection('Utama\n\n## Versi Threads (≤500)\nPendek\n', 'instagram', 'U2');
  assert.equal(T.parseCaption(j).threads, 'Pendek', 'versi Threads dipertahankan'); assert.equal(T.parseCaption(j).instagram, 'U2');
});
test('media: render saudara, old-*, dan video carousel tidak salah ambil', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-media-'));
  const mk = (f, isi = 'x') => { const a = path.join(root, f); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, isi); T.clearDirCache(); };
  mk('belum-posting/video/video-kumbo/riset.md'); mk('belum-posting/video/video-kumbo-duo/riset.md');
  mk('_hasil/siap/kumbo-duo.mp4');
  assert.equal(T.detectMedia(root, 'belum-posting/video/video-kumbo').video, null, 'render saudara bukan miliknya');
  assert.equal(T.detectMedia(root, 'belum-posting/video/video-kumbo-duo').video, '_hasil/siap/kumbo-duo.mp4');
  mk('belum-posting/video/video-kumbo/out/old-1-opsi.mp4'); mk('belum-posting/video/video-kumbo/out/scene-1.mp4');
  assert.equal(T.detectMedia(root, 'belum-posting/video/video-kumbo').video, null, 'old- dan scene- bukan hasil');
  mk('belum-posting/video/video-kumbo/out/opsi.mp4');
  assert.equal(T.detectMedia(root, 'belum-posting/video/video-kumbo').video, 'belum-posting/video/video-kumbo/out/opsi.mp4');
  mk('belum-posting/carousel/post-kumbo/out/slide-1.png'); mk('_hasil/siap/kumbo.mp4'); mk('_hasil/siap/kumbo-cover.png');
  const c = T.detectMedia(root, 'belum-posting/carousel/post-kumbo');
  assert.equal(c.video, null); assert.equal(c.cover, 'belum-posting/carousel/post-kumbo/out/slide-1.png');
  mk('belum-posting/_hasil/siap/kumbo.mp4');
  assert.ok(!T.scan(root).some(e => e.folder.includes('_hasil')), 'keluaran salah tempat bukan kartu');
  fs.rmSync(root, { recursive: true, force: true });
});
test('shortcode Instagram: round trip dan tanggal wajar, tidak mengarang', () => {
  const enc = ms => { let id = (BigInt(ms) - 1314220021721n) << 23n, s = ''; const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; while (id > 0n) { s = A[Number(id & 63n)] + s; id >>= 6n; } return s; };
  const ms = Math.floor(Date.UTC(2026, 9, 21, 5, 0, 0) / 2 ** 23) * 2 ** 23; // kelipatan 2^23 supaya tepat
  const code = enc(ms);
  assert.ok(code.length <= 11);
  assert.ok(Math.abs(T.shortcodeMs(code) - ms) < 2 ** 23 + 1);
  assert.equal(T.shortcodeOf('https://www.instagram.com/reel/DeEgWMpTfxK/'), 'DeEgWMpTfxK');
  const m = T.shortcodeMs('Dei1E7mk1Am');
  assert.ok(m > Date.UTC(2026, 0, 1) && m < Date.UTC(2027, 0, 1), `tanggal ${new Date(m).toISOString()}`);
  assert.equal(T.shortcodeMs(''), null);
  assert.equal(T.shortcodeMs('(link belum dicatat)'), null);
  assert.equal(T.shortcodeOf('(link belum dicatat)'), null);
});
test('deteksi media: urutan slide, folder opsi diabaikan, video FINAL, sampul', () => {
  w('belum-posting/carousel/post-a/out/slide-02.png', PNG); w('belum-posting/carousel/post-a/out/slide-10.png', PNG); w('belum-posting/carousel/post-a/out/slide-01.png', PNG);
  w('belum-posting/carousel/post-a/out/opsi/slide-99.png', PNG);
  w('belum-posting/carousel/post-b/clean/b.png', PNG); w('belum-posting/carousel/post-b/out/z.png', PNG);
  w('belum-posting/carousel/post-c/out/z.png', PNG);
  w('_hasil/FINAL/vid-FINAL.mp4', 'MP4'); w('_hasil/FINAL/vid-cover-1.png', PNG); w('_hasil/siap/vid-lama.mp4', 'MP4');
  T.clearDirCache();
  const a = T.detectMedia(kroot, 'belum-posting/carousel/post-a');
  assert.deepEqual(a.slides.map(x => path.basename(x)), ['slide-01.png', 'slide-02.png', 'slide-10.png']);
  assert.equal(a.cover, 'belum-posting/carousel/post-a/out/slide-01.png');
  assert.deepEqual(T.detectMedia(kroot, 'belum-posting/carousel/post-b').slides.map(x => path.basename(x)), ['b.png'], 'clean menang atas out/*.png');
  assert.deepEqual(T.detectMedia(kroot, 'belum-posting/carousel/post-c').slides.map(x => path.basename(x)), ['z.png']);
  const v = T.detectMedia(kroot, 'belum-posting/video/video-vid');
  assert.equal(v.video, '_hasil/FINAL/vid-FINAL.mp4');
  assert.equal(v.cover, '_hasil/FINAL/vid-cover-1.png');
  assert.equal(T.detectMedia(kroot, 'belum-posting/video/video-nol').video, null);
});

/* ---------------- papan, tahap, jadwal ---------------- */
test('papan konten dibuat otomatis, kolom sesuai kontrak', () => {
  const b = K.ensureBoard(OFFICE);
  assert.equal(b.id, 'konten');
  assert.deepEqual(b.columns.map(c => c.id), ['ide', 'riset', 'produksi', 'review', 'revisi', 'siap', 'terjadwal', 'tayang', 'arsip']);
  assert.equal(K.ensureBoard(OFFICE).id, 'konten', 'idempoten');
  assert.equal(bd.listBoards(OFFICE).filter(x => x.id === 'konten').length, 1);
});
test('alur tahap: tanggal memindah siap <-> terjadwal, tayang lewat PATCH ditolak', () => {
  const it = K.createItem(OFFICE, { title: 'Post alur', jenis: 'carousel' });
  assert.equal(it.tahap, 'ide');
  assert.equal(K.patchItem(OFFICE, it.id, { tahap: 'siap' }).tahap, 'siap');
  const t = K.patchItem(OFFICE, it.id, { publishAt: '2026-11-10', jam: '18:30' });
  assert.equal(t.tahap, 'terjadwal'); assert.equal(t.jadwalStatus, 'fix'); assert.equal(t.publishAt, '2026-11-10'); assert.equal(t.jam, '18:30');
  const back = K.patchItem(OFFICE, it.id, { publishAt: '' });
  assert.equal(back.tahap, 'siap'); assert.equal(back.jadwalStatus, '');
  assert.throws(() => K.patchItem(OFFICE, it.id, { tahap: 'tayang' }), /POST \/:cid\/tayang/);
  assert.throws(() => K.patchItem(OFFICE, it.id, { tahap: 'ngawur' }), /Tahap tidak dikenal/);
  assert.throws(() => K.patchItem(OFFICE, it.id, { publishAt: '10/11/2026' }), /YYYY-MM-DD/);
  assert.throws(() => K.patchItem(OFFICE, it.id, { jam: '25:00' }), /HH:MM/);
  assert.throws(() => K.createItem(OFFICE, { title: '' }), /Judul/);
  assert.throws(() => K.createItem(OFFICE, { title: 'x', folder: '../luar' }), /keluar/);
  assert.throws(() => K.createItem(OFFICE, { title: 'x', folder: '/abs' }), /relatif/);
  const l = K.listItems(OFFICE, { tahap: 'siap' });
  assert.ok(l.items.some(x => x.id === it.id));
  assert.equal(l.stages.find(s => s.id === 'siap').n >= 1, true);
  assert.equal(l.conf.root, 'konten');
});
test('peringatan jadwal: berdempet, sensitif berjejer, target, tanpa caption/media', () => {
  const mk = (title, seri, sens, tgl, withMedia) => {
    const dir = `belum-posting/carousel/post-j-${title}`;
    if (withMedia) { w(`${dir}/out/slide-01.png`, PNG); w(`${dir}/caption-instagram.md`, '## Instagram\nada\n'); }
    const it = K.createItem(OFFICE, { title, jenis: 'carousel', folder: dir, seri, sensitif: sens, tahap: 'siap' });
    return K.patchItem(OFFICE, it.id, { publishAt: tgl });
  };
  const a = mk('JA', 'seri-x', true, '2030-03-04', true);   // Senin
  const b = mk('JB', 'seri-x', true, '2030-03-05', true);   // Selasa: berdempet + sensitif berjejer
  const c = mk('JC', '', false, '2030-03-06', false);       // tanpa caption dan media; minggu ini jadi 3 > target 2
  T.clearDirCache();
  const r = K.jadwal(OFFICE, { from: '2030-03-04', to: '2030-03-10', now: '2030-03-01T00:00:00' });
  const kode = k => r.peringatan.filter(p => p.kode === k);
  assert.deepEqual(kode('seri-berdempet')[0].ids, [a.id, b.id]);
  assert.deepEqual(kode('sensitif-berjejer')[0].ids, [a.id, b.id]);
  assert.equal(kode('target-lebih').length, 1);
  assert.equal(kode('target-lebih')[0].tanggal, '2030-03-04');
  assert.deepEqual(kode('tanpa-caption').map(p => p.ids[0]), [c.id]);
  assert.deepEqual(kode('tanpa-media').map(p => p.ids[0]), [c.id]);
  assert.deepEqual(r.minggu, [{ mulai: '2030-03-04', n: 3, target: 2 }]);
  const kurang = K.jadwal(OFFICE, { from: '2030-03-11', to: '2030-03-17', now: '2030-03-01T00:00:00' });
  assert.equal(kurang.peringatan.filter(p => p.kode === 'target-kurang').length, 1, 'minggu kosong di masa depan kurang dari target');
  const lewat = K.jadwal(OFFICE, { from: '2030-03-11', to: '2030-03-17', now: '2030-04-01T00:00:00' });
  assert.equal(lewat.peringatan.filter(p => p.kode === 'target-kurang').length, 0, 'minggu yang sudah lewat tidak diperingatkan');
  assert.equal(r.items.length, 3);
});
test('peringatan jadwal: melewati target harian', () => {
  K.setConf(OFFICE, { targetPerHari: 2 });
  const mk = n => K.patchItem(OFFICE, K.createItem(OFFICE, { title: `H${n}`, jenis: 'carousel', tahap: 'siap' }).id, { publishAt: '2031-05-06' });
  mk(1); mk(2);
  const pas = K.jadwal(OFFICE, { from: '2031-05-05', to: '2031-05-11' }).peringatan;
  assert.equal(pas.some(p => p.kode === 'harian-lebih'), false);
  mk(3);
  const lebih = K.jadwal(OFFICE, { from: '2031-05-05', to: '2031-05-11' }).peringatan.find(p => p.kode === 'harian-lebih');
  assert.equal(lebih.tanggal, '2031-05-06');
  assert.equal(lebih.ids.length, 3);
  K.setConf(OFFICE, { targetPerHari: 0 });
});

test('media: PNG kerja di proyek video tidak dianggap slide', () => {
  w('_hasil/FINAL/uji-kerja-FINAL.mp4', 'x'); w('belum-posting/video/video-uji-kerja/out/cek-rute.png', PNG);
  T.clearDirCache();
  const m = T.detectMedia(kroot, 'belum-posting/video/video-uji-kerja');
  assert.deepEqual(m.slides, []); assert.equal(m.cover, m.video);
  w('belum-posting/carousel/post-uji-kerja/out/slide-01.png', PNG);
  assert.equal(T.detectMedia(kroot, 'belum-posting/carousel/post-uji-kerja').slides.length, 1);
});

test('media: render tanpa akhiran versi dan nama dengan awalan tetap ketemu, video jadi sampul', () => {
  w('_hasil/FINAL/uji-juanda-FINAL.mp4', 'x'); w('_hasil/FINAL/video-uji-malabar-FINAL.mp4', 'x'); w('_hasil/FINAL/uji-juanda-lain-FINAL.mp4', 'x');
  fs.mkdirSync(path.join(kroot, 'sudah-posting/video/video-uji-juanda-v2'), { recursive: true });
  fs.mkdirSync(path.join(kroot, 'sudah-posting/video/video-uji-malabar'), { recursive: true });
  T.clearDirCache();
  const a = T.detectMedia(kroot, 'sudah-posting/video/video-uji-juanda-v2');
  assert.equal(a.video, '_hasil/FINAL/uji-juanda-FINAL.mp4'); assert.equal(a.cover, a.video);
  assert.equal(T.detectMedia(kroot, 'sudah-posting/video/video-uji-malabar').video, '_hasil/FINAL/video-uji-malabar-FINAL.mp4');
});

test('kit: folder punya pratinjau dari berkas jadi, desain HTML, atau frame merata', () => {
  w('kit-t/logo/a.png', PNG); w('kit-t/logo/b.png', PNG);
  w('kit-t/jual/html/x.html', '<p>x</p>'); w('kit-t/jual/aset/foto.png', PNG); w('kit-t/jual/preview.html', '<p>y</p>');
  for (let i = 0; i < 60; i++) w(`kit-t/outro/frames/f${String(i).padStart(3, '0')}.png`, PNG);
  const add = (nama, path) => K.addKit(OFFICE, { jenis: 'lain', nama, path });
  const logo = add('L', 'kit-t/logo'), jual = add('J', 'kit-t/jual'), outro = add('O', 'kit-t/outro');
  assert.deepEqual(logo.isi.map(f => f.name), ['a.png', 'b.png']);
  assert.deepEqual(jual.isi.map(f => [f.name, f.kind]), [['x.html', 'html']]);
  assert.equal(outro.n, 60); assert.equal(outro.isi.length, 24); assert.equal(outro.isi[0].name, 'f000.png'); assert.ok(outro.isi[23].name > 'f050.png');
  for (const k of [logo, jual, outro]) K.removeKit(OFFICE, k.id);
});

test('jadwal memuat kartu tahap awal yang sudah bertanggal', () => {
  const it = K.createItem(OFFICE, { title: 'Rencana awal', jenis: 'carousel', tahap: 'ide' });
  K.patchItem(OFFICE, it.id, { publishAt: '2032-02-03' });
  assert.ok(K.jadwal(OFFICE, { from: '2032-02-01', to: '2032-02-07' }).items.some(x => x.id === it.id));
  assert.equal(K.getItem ? K.getItem(OFFICE, it.id).tahap : 'ide', 'ide');
});

test('usulan jadwal: hanya kartu siap, tampil usulan, disetujui pemilik jadi terjadwal', async () => {
  const siap = K.createItem(OFFICE, { title: 'Usul siap', tahap: 'siap' });
  const belum = K.createItem(OFFICE, { title: 'Usul belum', tahap: 'produksi' });
  const r = K.usulJadwal(OFFICE, [{ id: siap.id, tanggal: '2031-05-05' }, { id: belum.id, tanggal: '2031-05-06' }, { id: 'nope', tanggal: '2031-05-07' }]);
  assert.equal(r.diusulkan.length, 1);
  assert.equal(r.ditolak.length, 2);
  assert.match(r.ditolak.find(x => x.id === belum.id).alasan, /belum siap/);
  const it = K.getItem(OFFICE, siap.id);
  assert.equal(it.tahap, 'siap', 'usulan tidak memindah tahap'); assert.equal(it.jadwalStatus, 'usulan'); assert.equal(it.publishAt, '2031-05-05'); assert.equal(it.jam, '19:00');
  assert.throws(() => K.setujuiJadwal(OFFICE, [belum.id]), /Belum punya tanggal/);
  const ok = K.setujuiJadwal(OFFICE, [siap.id]);
  assert.equal(ok.items[0].tahap, 'terjadwal'); assert.equal(ok.items[0].jadwalStatus, 'fix');
});

/* ---------------- review ---------------- */
test('review: setuju -> siap, revisi -> revisi, DM ke pengerja lewat pemilik, komentar kartu', async () => {
  typed.length = 0; notes.length = 0;
  const a = K.createItem(OFFICE, { title: 'Review A', who: kimi.id, tahap: 'review' });
  assert.equal(notes.length, 1, 'masuk review: satu notify');
  assert.equal(notes[0].text, 'Review A');
  await assert.rejects(() => K.review(OFFICE, a.id, { keputusan: 'revisi' }), /catatan/);
  await assert.rejects(() => K.review(OFFICE, a.id, { keputusan: 'mungkin' }), /setuju/);
  const r = await K.review(OFFICE, a.id, { keputusan: 'revisi', catatan: 'warna judul terlalu pucat', slide: [2, 3] });
  assert.equal(r.tahap, 'revisi'); assert.ok(r.dm.id);
  assert.ok(typed.some(t => /slide 2, 3/.test(t.text) && /warna judul/.test(t.text)), 'DM sampai ke sesi');
  assert.ok(cardOf(a.id).comments.some(c => /perlu revisi/.test(c.text)));
  await assert.rejects(() => K.review(OFFICE, a.id, { keputusan: 'setuju' }), /tidak sedang di Review/);
  K.patchItem(OFFICE, a.id, { tahap: 'review' });
  assert.equal(notes.length, 2);
  const s = await K.review(OFFICE, a.id, { keputusan: 'setuju' });
  assert.equal(s.tahap, 'siap');
  const noWho = K.createItem(OFFICE, { title: 'Tanpa pengerja', tahap: 'review' });
  const s2 = await K.review(OFFICE, noWho.id, { keputusan: 'setuju', catatan: 'oke' });
  assert.equal(s2.dm, null); assert.equal(s2.tahap, 'siap');
  assert.ok(cardOf(noWho.id).comments.some(c => /disetujui/.test(c.text)), 'komentar kartu selalu');
});

/* ---------------- tayang ---------------- */
test('tayang: pindah folder, SUDAH-POSTING, statusFile, pathPerluCek, tidak menimpa tujuan', async () => {
  fs.writeFileSync(path.join(kroot, 'STATUS.md'), '# Status\n\n| Folder | Link IG | Judul IG |\n|---|---|---|\n| sudah-posting/carousel/post-lama | https://x/p/1/ | Lama |\n\n## Catatan\nteks lain\n');
  w('belum-posting/carousel/post-t1/out/slide-01.png', PNG);
  w('belum-posting/carousel/post-t1/caption-instagram.md', '## Instagram\nHalo\n');
  w('belum-posting/carousel/post-t1/shot.mjs', "const dir = 'belum-posting/carousel/post-t1/out';");
  w('_kit/catatan.md', 'lihat belum-posting/carousel/post-t1 untuk contoh');
  w('_hasil/jangan.md', 'belum-posting/carousel/post-t1 (di _hasil, dilewati)');
  w('belum-posting/carousel/post-t1/node_modules/x.md', 'belum-posting/carousel/post-t1');
  const it = K.createItem(OFFICE, { title: 'Post tayang satu', folder: 'belum-posting/carousel/post-t1', tahap: 'siap' });
  assert.equal(it.jenis, 'carousel');
  await assert.rejects(() => K.tayang(OFFICE, it.id, { platform: 'youtube' }), /tidak ditawarkan ke YouTube/);
  await assert.rejects(() => K.tayang(OFFICE, it.id, { platform: 'facebook' }), /platform/);
  // tujuan sudah ada: galat jelas, tidak ada yang berubah
  w('sudah-posting/carousel/post-t1/ada.txt', 'jangan ditimpa');
  await assert.rejects(() => K.tayang(OFFICE, it.id, { platform: 'instagram', link: 'https://www.instagram.com/p/AAA/' }), /sudah ada; tidak ditimpa/);
  assert.equal(K.getItem(OFFICE, it.id).tahap, 'siap');
  assert.ok(fs.existsSync(path.join(kroot, 'belum-posting/carousel/post-t1/caption-instagram.md')));
  assert.equal(fs.readFileSync(path.join(kroot, 'sudah-posting/carousel/post-t1/ada.txt'), 'utf8'), 'jangan ditimpa');
  fs.rmSync(path.join(kroot, 'sudah-posting/carousel/post-t1'), { recursive: true });

  const at = '2026-11-03T10:00:00.000Z';
  const r = await K.tayang(OFFICE, it.id, { platform: 'instagram', link: 'https://www.instagram.com/p/AAA/', at });
  assert.equal(r.tahap, 'tayang');
  assert.equal(r.folder, 'sudah-posting/carousel/post-t1');
  assert.deepEqual(r.dipindah, { dari: 'belum-posting/carousel/post-t1', ke: 'sudah-posting/carousel/post-t1' });
  assert.equal(r.platforms.instagram.link, 'https://www.instagram.com/p/AAA/');
  assert.ok(!fs.existsSync(path.join(kroot, 'belum-posting/carousel/post-t1')));
  const sp = fs.readFileSync(path.join(kroot, 'sudah-posting/carousel/post-t1/SUDAH-POSTING.txt'), 'utf8');
  assert.match(sp, /^SUDAH DIPOSTING di Instagram\nhttps:\/\/www\.instagram\.com\/p\/AAA\/\nJudul IG: Post tayang satu\nDicek: \d+ \w+ 2026 \(konfirmasi pemilik\)\n$/);
  assert.equal(r.sudahPosting, 'dibuat');
  // berkas lain tidak ditulis ulang
  assert.equal(fs.readFileSync(path.join(kroot, 'sudah-posting/carousel/post-t1/shot.mjs'), 'utf8'), "const dir = 'belum-posting/carousel/post-t1/out';");
  const st = fs.readFileSync(path.join(kroot, 'STATUS.md'), 'utf8');
  assert.match(st, /post-lama \| https:\/\/x\/p\/1\/ \| Lama \|\n\| sudah-posting\/carousel\/post-t1 \| https:\/\/www\.instagram\.com\/p\/AAA\/ \| Post tayang satu \|\n\n## Catatan\nteks lain\n/);
  assert.equal(r.statusFile, true);
  assert.deepEqual(r.pathPerluCek.sort(), ['_kit/catatan.md', 'sudah-posting/carousel/post-t1/shot.mjs'], 'node_modules dan _hasil dilewati');
  assert.equal(r.publishAt.length, 10);
  assert.ok(cardOf(it.id).done);
  // platform kedua: tidak memindah lagi, menambah baris di SUDAH-POSTING
  const r2 = await K.tayang(OFFICE, it.id, { platform: 'threads', link: 'https://threads.net/x' });
  assert.equal(r2.dipindah, null); assert.equal(r2.sudahPosting, 'ditambah'); assert.equal(r2.statusFile, false);
  assert.deepEqual(Object.keys(r2.platforms).sort(), ['instagram', 'threads']);
  assert.match(fs.readFileSync(path.join(kroot, 'sudah-posting/carousel/post-t1/SUDAH-POSTING.txt'), 'utf8'), /Threads: https:\/\/threads\.net\/x\n$/);
  // pindahFolder dimatikan: folder tetap
  K.setConf(OFFICE, { pindahFolder: false });
  w('belum-posting/video/video-t2/x.txt');
  const t2 = K.createItem(OFFICE, { title: 'Tayang dua', folder: 'belum-posting/video/video-t2' });
  const r3 = await K.tayang(OFFICE, t2.id, { platform: 'tiktok' });
  assert.equal(r3.dipindah, null); assert.equal(r3.folder, 'belum-posting/video/video-t2');
  assert.match(fs.readFileSync(path.join(kroot, 'belum-posting/video/video-t2/SUDAH-POSTING.txt'), 'utf8'), /\(link belum dicatat\)/);
  K.setConf(OFFICE, { pindahFolder: true });
});
test('tayang idempoten: ulang untuk platform sama memperbarui link tanpa galat atau pindah dua kali', async () => {
  w('belum-posting/carousel/post-idem/x.txt');
  const it = K.createItem(OFFICE, { title: 'Idem', folder: 'belum-posting/carousel/post-idem', tahap: 'siap' });
  const a = await K.tayang(OFFICE, it.id, { platform: 'instagram', at: '2026-11-01T01:00:00.000Z' });
  const b = await K.tayang(OFFICE, it.id, { platform: 'instagram', link: 'https://www.instagram.com/p/BBB/' });
  assert.equal(b.dipindah, null); assert.equal(b.folder, a.folder); assert.equal(b.tahap, 'tayang');
  assert.equal(b.platforms.instagram.link, 'https://www.instagram.com/p/BBB/'); assert.equal(b.platforms.instagram.at, '2026-11-01T01:00:00.000Z');
  const c = await K.tayang(OFFICE, it.id, { platform: 'instagram' });
  assert.equal(c.platforms.instagram.link, 'https://www.instagram.com/p/BBB/', 'tanpa link tidak menghapus link');
});
test('performa: hanya untuk yang sudah tayang, angka divalidasi', async () => {
  const it = K.createItem(OFFICE, { title: 'Perf', tahap: 'siap' });
  assert.throws(() => K.setPerforma(OFFICE, it.id, { platform: 'instagram', reach: 5 }), /sudah tayang/);
  await K.tayang(OFFICE, it.id, { platform: 'instagram' });
  const r = K.setPerforma(OFFICE, it.id, { platform: 'instagram', reach: '1200', like: 30, save: 4 });
  assert.equal(r.perf.instagram.reach, 1200); assert.equal(r.perf.instagram.like, 30); assert.ok(r.perf.instagram.at);
  assert.throws(() => K.setPerforma(OFFICE, it.id, { platform: 'instagram', reach: -1 }), />= 0/);
  assert.throws(() => K.setPerforma(OFFICE, it.id, { platform: 'instagram' }), /minimal satu/);
});

/* ---------------- caption lewat API, kit, file ---------------- */
test('PUT caption menulis balik hanya satu bagian di berkas folder', () => {
  w('belum-posting/carousel/post-cap/caption-instagram.md', '# Cap\n\n## Instagram\nIG lama\n\n## TikTok\nTT tetap\n');
  const it = K.createItem(OFFICE, { title: 'Cap', folder: 'belum-posting/carousel/post-cap' });
  assert.equal(K.getItem(OFFICE, it.id).captions.instagram, 'IG lama');
  const r = K.putCaption(OFFICE, it.id, { platform: 'instagram', text: 'IG baru' });
  assert.equal(r.captions.instagram, 'IG baru'); assert.equal(r.captions.tiktok, 'TT tetap');
  assert.equal(fs.readFileSync(path.join(kroot, 'belum-posting/carousel/post-cap/caption-instagram.md'), 'utf8'), '# Cap\n\n## Instagram\nIG baru\n\n## TikTok\nTT tetap\n');
  assert.throws(() => K.putCaption(OFFICE, it.id, { platform: 'x', text: 'a' }), /platform/);
});
test('kit: tambah, daftar, hapus; path di luar folder konten ditolak', () => {
  w('_kit/logo.png', PNG);
  const k1 = K.addKit(OFFICE, { jenis: 'logo', nama: 'Logo utama', path: '_kit/logo.png' });
  assert.equal(k1.ada, true); assert.match(k1.url, /\/konten\/kit\/file\?path=_kit%2Flogo\.png$/);
  assert.equal(K.listKit(OFFICE).items.length, 1);
  assert.equal(K.listKit(OFFICE, { jenis: 'sfx' }).items.length, 0);
  assert.throws(() => K.addKit(OFFICE, { jenis: 'logo', nama: 'x', path: '../rahasia.png' }), /keluar/);
  assert.throws(() => K.addKit(OFFICE, { jenis: 'logo', nama: 'x', path: '_kit/tidak-ada.png' }), /tidak ada/);
  assert.throws(() => K.addKit(OFFICE, { jenis: 'aneh', nama: 'x', path: '_kit/logo.png' }), /jenis/);
  assert.deepEqual(K.removeKit(OFFICE, k1.id), { ok: true });
  assert.throws(() => K.removeKit(OFFICE, k1.id), /tidak ditemukan/);
});
test('endpoint file: path traversal, symlink keluar, absolut ditolak; Range jalan', async () => {
  fs.writeFileSync(path.join(tmp, 'rahasia.png'), 'RAHASIA');
  fs.writeFileSync(path.join(root, 'toko/di-luar.txt'), 'LUAR');
  w('aman/ok.mp4', '0123456789');
  fs.symlinkSync(path.join(tmp, 'rahasia.png'), path.join(kroot, 'aman/leak.png'));
  fs.symlinkSync(path.join(root, 'toko'), path.join(kroot, 'aman/folder-luar'));
  await assert.rejects(() => serve('../di-luar.txt'), { code: 403 });
  await assert.rejects(() => serve('aman/../../di-luar.txt'), { code: 403 });
  await assert.rejects(() => serve(path.join(tmp, 'rahasia.png')), { code: 404 }, 'path absolut dibaca relatif ke root, bukan ke disk');
  await assert.rejects(() => serve('aman/leak.png'), { code: 403 }, 'symlink berkas keluar');
  await assert.rejects(() => serve('aman/folder-luar/di-luar.txt'), { code: 403 }, 'symlink folder keluar');
  await assert.rejects(() => serve('aman/tidak-ada.png'), { code: 404 });
  await assert.rejects(() => serve('aman'), /folder/i);
  await assert.rejects(() => serve(''), /path/);
  const full = await serve('aman/ok.mp4');
  assert.equal(full.code, 200); assert.equal(full.headers['Content-Type'], 'video/mp4'); assert.equal(full.headers['Accept-Ranges'], 'bytes'); assert.equal(String(full.body), '0123456789');
  const part = await serve('aman/ok.mp4', { range: 'bytes=2-5' });
  assert.equal(part.code, 206); assert.equal(part.headers['Content-Range'], 'bytes 2-5/10'); assert.equal(String(part.body), '2345');
  const tail = await serve('aman/ok.mp4', { range: 'bytes=-3' });
  assert.equal(String(tail.body), '789');
  const bad = await serve('aman/ok.mp4', { range: 'bytes=50-60' });
  assert.equal(bad.code, 416);
  // conf.root belum diatur: tidak melayani apa pun
  K.setConf(OFFICE, { root: '' });
  await assert.rejects(() => serve('aman/ok.mp4'), { code: 404 });
  assert.throws(() => K.setConf(OFFICE, { root: '../luar' }), /keluar/);
  assert.throws(() => K.setConf(OFFICE, { root: '/etc' }), /relatif/);
  K.setConf(OFFICE, { root: 'konten' });
});

/* ---------------- impor ---------------- */
test('impor: tahap, judul, seri, sensitif, tanggal dari shortcode, idempoten, tanpa mengubah berkas', () => {
  // dunia terpisah supaya angka bisa dipastikan
  const kr2 = path.join(root, 'toko/konten2');
  const f = (rel, c = 'x') => { const p = path.join(kr2, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  const IG = 'https://www.instagram.com/reel/DeEgWMpTfxK/';
  f('sudah-posting/video/video-langen-2011/SUDAH-POSTING.txt', `SUDAH DIPOSTING di Instagram\n${IG}\nJudul IG: PLH Langen 2011\n`);
  f('sudah-posting/video/video-langen-2011-v2/SUDAH-POSTING.txt', 'SUDAH DIPOSTING di Instagram\n(link belum dicatat)\n');
  f('sudah-posting/video/video-langen-2011-v2/caption-instagram.md', '## Instagram\nCaption pertama yang cukup panjang supaya perlu dipotong di batas kata tepat sembilan puluh karakter ya ini lanjutannya\n');
  f('sudah-posting/carousel/voorijder/SUDAH-POSTING.txt', 'SUDAH DIPOSTING di Instagram\n(link belum dicatat)\nJudul IG: Voorijder\n');
  f('belum-posting/carousel/post-ok/out/slide-01.png', PNG); f('belum-posting/carousel/post-ok/caption-instagram.md', '## Instagram\nSiap review\n');
  f('belum-posting/carousel/post-prod/out/slide-01.png', PNG);
  f('belum-posting/carousel/post-riset/riset.md', 'r');
  f('belum-posting/carousel/post-kosong/catatan.txt', 'k');
  f('belum-posting/carousel/_kit/x.md', 'x'); f('belum-posting/carousel/node_modules/x.md', 'x'); f('belum-posting/carousel/berkas.txt', 'bukan folder');
  f('cek-dulu/carousel/post-cek/out/slide-01.png', PNG);
  f('belum-posting/video/video-gapeka-1999/OPSI.md', 'o');
  const before = JSON.stringify(fs.readdirSync(kr2, { recursive: true }).sort());
  K.setConf(OFFICE, { root: 'konten2' });
  const dry = K.impor(OFFICE, { dryRun: true });
  assert.equal(dry.dibuat, 9); assert.equal(dry.dilewati, 0);
  assert.deepEqual(dry.perTahap, { tayang: 3, review: 2, produksi: 1, riset: 2, ide: 1 });
  assert.equal(K.listItems(OFFICE).items.filter(x => x.folder.startsWith('sudah-posting/video')).length, 0, 'dry-run tidak menulis');
  const res = K.impor(OFFICE, {});
  assert.equal(res.dibuat, 9);
  const again = K.impor(OFFICE, {});
  assert.equal(again.dibuat, 0); assert.equal(again.dilewati, 9, 'idempoten per folder');
  const by = fo => K.listItems(OFFICE).items.find(x => x.folder === fo);
  const lg = by('sudah-posting/video/video-langen-2011');
  assert.equal(lg.tahap, 'tayang'); assert.equal(lg.title, 'PLH Langen 2011'); assert.equal(lg.jenis, 'video'); assert.equal(lg.seri, 'langen-2011'); assert.equal(lg.sensitif, true);
  assert.equal(lg.platforms.instagram.link, IG);
  assert.equal(Date.parse(lg.platforms.instagram.at), T.shortcodeMs('DeEgWMpTfxK'));
  assert.match(lg.publishAt, /^2026-/);
  const v2 = by('sudah-posting/video/video-langen-2011-v2');
  assert.equal(v2.seri, 'langen-2011'); assert.equal(v2.platforms.instagram.at, '', 'tanpa shortcode: tanggal dibiarkan kosong'); assert.equal(v2.publishAt, '');
  assert.ok(v2.title.length <= 90 && v2.title.endsWith('…') && !v2.title.includes('lanjutannya'), v2.title);
  const vo = by('sudah-posting/carousel/voorijder');
  assert.equal(vo.jenis, 'carousel'); assert.equal(vo.sensitif, false); assert.equal(vo.title, 'Voorijder'); assert.equal(vo.seri, '');
  assert.equal(by('belum-posting/carousel/post-ok').tahap, 'review');
  assert.equal(by('belum-posting/carousel/post-prod').tahap, 'produksi');
  assert.equal(by('belum-posting/carousel/post-riset').tahap, 'riset');
  assert.equal(by('belum-posting/carousel/post-kosong').tahap, 'ide');
  assert.equal(by('belum-posting/carousel/post-kosong').title, 'Kosong', 'nama folder dimanusiakan');
  assert.equal(by('belum-posting/video/video-gapeka-1999').tahap, 'riset');
  assert.equal(by('belum-posting/video/video-gapeka-1999').sensitif, true, 'tahun di nama folder video');
  const cek = by('cek-dulu/carousel/post-cek');
  assert.equal(cek.tahap, 'review'); assert.deepEqual(cek.labels, ['cek-dulu']);
  assert.equal(K.listItems(OFFICE).items.filter(x => /_kit|node_modules/.test(x.folder)).length, 0);
  assert.equal(JSON.stringify(fs.readdirSync(kr2, { recursive: true }).sort()), before, 'impor tidak mengubah berkas apa pun');
  assert.ok(by('belum-posting/carousel/post-ok').coverUrl, 'sampul terdeteksi');
  assert.equal(by('belum-posting/carousel/post-kosong').coverUrl, null);
  K.setConf(OFFICE, { root: 'konten' });
});
test('impor tanpa conf.root ditolak dengan pesan jelas', () => {
  K.setConf(OFFICE, { root: '' });
  assert.throws(() => K.impor(OFFICE, { dryRun: true }), /conf\.root/);
  K.setConf(OFFICE, { root: 'konten' });
});

/* ---------------- autopilot ---------------- */
test('autopilot melewati papan konten: tidak ada tawaran kerja dan tidak ada ronde manager', () => {
  const role = store.getRole(OFFICE, kimi.id);
  const konten = K.createItem(OFFICE, { title: 'Stok lama di ide', who: kimi.id, tahap: 'ide' });
  const biasa = store.createCard(OFFICE, { title: 'Kartu biasa', who: kimi.id, col: 'Backlog' }, 'Kamu');
  const cands = ap.candidates(OFFICE, role, undefined, Date.now()).map(c => c.id);
  assert.ok(cands.includes(biasa.id), 'kartu papan utama tetap ditawarkan');
  assert.ok(!cands.includes(konten.id), 'kartu papan konten tidak');
  const rev = K.createItem(OFFICE, { title: 'Stok lama di review', tahap: 'review' });
  const stale = ap.staleCards(OFFICE, 0, Date.now() + 3600e3).map(c => c.id);
  assert.ok(!stale.includes(rev.id));
  const reviewBiasa = store.createCard(OFFICE, { title: 'Review biasa', col: 'Review' }, 'Kamu');
  assert.ok(ap.staleCards(OFFICE, 0, Date.now() + 3600e3).map(c => c.id).includes(reviewBiasa.id));
});

/* ---------------- tool MCP ---------------- */
test('tool MCP: buat, set (tidak boleh ke siap/terjadwal/tayang), kirim, usul, tayang, performa, kit', async () => {
  notes.length = 0;
  const lst = (await ag.callTool(ident(), 'konten_list', {})).content[0].text;
  assert.match(lst, /total/);
  const made = await tool('konten_buat', { judul: 'Dari agen', jenis: 'video', folder: 'belum-posting/video/video-agen', seri: 'agen' });
  assert.equal(made.tahap, 'ide'); assert.equal(made.pengerja, 'Kimi', 'identitas pemanggil jadi who');
  for (const t of ['siap', 'terjadwal', 'tayang']) await assert.rejects(() => ag.callTool(ident(), 'konten_set', { id: made.id, tahap: t }), /keputusan pemilik/);
  assert.equal((await tool('konten_set', { id: made.id, tahap: 'produksi', lagu: 'Lagu A', catatan: 'cat' })).tahap, 'produksi');
  const got = await tool('konten_get', { id: made.id });
  assert.equal(got.lagu, 'Lagu A');
  await assert.rejects(() => ag.callTool(ident(), 'konten_set', { id: made.id }), /Tidak ada yang diubah/);
  const sent = await tool('konten_kirim', { id: made.id, catatan: 'tolong cek musiknya' });
  assert.equal(sent.tahap, 'review'); assert.match(sent.paket, /konten\/p\//);
  assert.equal(notes.length, 1);
  assert.ok(cardOf(made.id).comments.some(c => /cek musiknya/.test(c.text)));
  await assert.rejects(() => ag.callTool(ident(), 'konten_kirim', { id: made.id }), /sudah menunggu review/);
  const u1 = await tool('konten_jadwal_usul', { jadwal: [{ id: made.id, tanggal: '2032-01-05' }] });
  assert.equal(u1.diusulkan.length, 0); assert.match(u1.ditolak[0].alasan, /belum siap/);
  await K.review(OFFICE, made.id, { keputusan: 'setuju' });
  const u2 = await tool('konten_jadwal_usul', { jadwal: [{ id: made.id, tanggal: '2032-01-05', jam: '08:15' }] });
  assert.equal(u2.diusulkan.length, 1); assert.ok(Array.isArray(u2.peringatan));
  assert.equal(K.getItem(OFFICE, made.id).jadwalStatus, 'usulan');
  const ty = await tool('konten_tayang', { id: made.id, platform: 'tiktok', link: 'https://tiktok.com/x' });
  assert.equal(ty.tahap, 'tayang'); assert.deepEqual(Object.keys(ty.platforms), ['tiktok']);
  assert.equal((await tool('konten_performa', { id: made.id, platform: 'tiktok', reach: 10 })).tahap, 'tayang');
  const kit = await tool('kit_tambah', { jenis: 'outro', nama: 'Outro', path: '_kit/logo.png' });
  assert.equal(kit.jenis, 'outro');
  assert.equal((await tool('kit_list', { jenis: 'outro' })).length, 1);
  await assert.rejects(() => ag.callTool(ident(), 'konten_get', { id: 'tidak-ada' }), /tidak ditemukan/);
});

/* ---------------- pengingat ---------------- */
test('pengingat: terjadwal yang sudah lewat memicu satu notify per kartu per tanggal', () => {
  K.setConf(OFFICE, { pengingat: { pagi: '', terlewatMenit: 0, susulanJam: 0 } });
  notes.length = 0;
  const a = K.createItem(OFFICE, { title: 'Ingatkan aku', tahap: 'siap' });
  K.patchItem(OFFICE, a.id, { publishAt: '2033-06-01', jam: '10:00' });
  const nowBefore = new Date(2033, 5, 1, 9, 40), nowAfter = new Date(2033, 5, 1, 9, 50);
  assert.deepEqual(K.remindOffice(OFFICE, nowBefore), []);
  assert.deepEqual(K.remindOffice(OFFICE, nowAfter), [a.id]);
  assert.equal(notes.length, 1); assert.equal(notes[0].text, '10:00 Ingatkan aku'); assert.equal(notes[0].id, a.id);
  assert.deepEqual(K.remindOffice(OFFICE, new Date(2033, 5, 1, 10, 30)), [], 'sekali per kartu per tanggal');
  K.patchItem(OFFICE, a.id, { publishAt: '2033-06-02' });
  assert.deepEqual(K.remindOffice(OFFICE, new Date(2033, 5, 2, 11, 0)), [a.id], 'tanggal baru, notify baru');
  assert.deepEqual(K.remindOffice(OFFICE, new Date(2033, 7, 1)), [], 'terlewat lebih dari seminggu tidak diingatkan');
});
test('pengingat: ringkasan pagi, terlewat, dan susulan platform, masing-masing sekali', async () => {
  K.setConf(OFFICE, { pengingat: { pagi: '08:00', sebelumMenit: 15, terlewatMenit: 120, susulanJam: 3 }, targetPerHari: 2 });
  const got = []; const on = e => { if (e.kind === 'konten') got.push(e); }; bus.on('notify', on);
  const a = K.patchItem(OFFICE, K.createItem(OFFICE, { title: 'Pagi A', jenis: 'video', tahap: 'siap' }).id, { publishAt: '2034-03-07', jam: '12:00' });
  K.remindOffice(OFFICE, new Date(2034, 2, 7, 8, 5));
  assert.ok(got.some(e => e.who === 'Konten hari ini' && /12:00 Pagi A/.test(e.text)));
  const nPagi = got.length; K.remindOffice(OFFICE, new Date(2034, 2, 7, 8, 30)); assert.equal(got.length, nPagi, 'ringkasan pagi sekali sehari');
  K.remindOffice(OFFICE, new Date(2034, 2, 7, 11, 50)); assert.ok(got.some(e => e.who === 'Waktunya posting' && e.id === a.id));
  K.remindOffice(OFFICE, new Date(2034, 2, 7, 14, 10)); assert.ok(got.some(e => e.who === 'Belum ditandai tayang' && e.id === a.id));
  await K.tayang(OFFICE, a.id, { platform: 'instagram', at: new Date(2034, 2, 7, 15, 0).toISOString() });
  K.remindOffice(OFFICE, new Date(2034, 2, 7, 16, 0)); assert.ok(!got.some(e => e.who.startsWith('Belum di ')), 'belum 3 jam');
  K.remindOffice(OFFICE, new Date(2034, 2, 7, 18, 30));
  const s = got.filter(e => e.who.startsWith('Belum di ')); assert.equal(s.length, 1); assert.match(s[0].who, /Threads, TikTok, YouTube/);
  bus.off('notify', on);
  K.setConf(OFFICE, { targetPerHari: 0, pengingat: { aktif: false } });
  assert.deepEqual(K.remindOffice(OFFICE, new Date(2034, 2, 7, 18, 31)), []);
  K.setConf(OFFICE, { pengingat: { aktif: true } });
});
test('notify.js meneruskan kind konten ke Ghina (event pratinjau, path ke tab Konten)', async () => {
  const notify = await import('../server/notify.js');
  const cfgMod = await import('../server/config.js');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; };
  const prev = cfgMod.config().ghinaNotify;
  cfgMod.config().ghinaNotify = { enabled: true, url: 'http://ghina.test/n', token: 't', debounceSec: 0 };
  try {
    assert.equal(await notify.pushGhina({ kind: 'konten', office: OFFICE, id: 'k1', who: 'Konten perlu review', text: 'Judul', dedupe: 'a' }), true);
    assert.equal(sent[0].event, 'pratinjau'); assert.equal(sent[0].path, `#/o/${OFFICE}/konten/p/k1`); assert.equal(sent[0].title, 'Konten perlu review'); assert.equal(sent[0].body, 'Judul');
    cfgMod.config().ghinaNotify = { enabled: true, url: 'http://ghina.test/n', token: 't', debounceSec: 0, konten: false };
    assert.equal(await notify.pushGhina({ kind: 'konten', office: OFFICE, id: 'k2', who: 'x', text: 'y', dedupe: 'b' }), false);
  } finally { globalThis.fetch = realFetch; cfgMod.config().ghinaNotify = prev; }
});
