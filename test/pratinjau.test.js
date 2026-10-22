import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-pv-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const api = path.join(root, 'shop/api');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(api, 'dist/css'), { recursive: true });
fs.writeFileSync(path.join(api, 'go.mod'), 'module api');
fs.writeFileSync(path.join(api, 'a.png'), 'PNGDATA');
fs.writeFileSync(path.join(api, 'b.png'), 'PNGDATA2');
fs.writeFileSync(path.join(api, 'doc.pdf'), '%PDF-1.4');
fs.writeFileSync(path.join(api, 'big.bin'), Buffer.alloc(3000));
fs.writeFileSync(path.join(api, 'dist/index.html'), '<link rel=stylesheet href="css/app.css"><script>1</script>');
fs.writeFileSync(path.join(api, 'dist/about.html'), '<p>about</p>');
fs.writeFileSync(path.join(api, 'dist/css/app.css'), 'body{color:red}');
fs.writeFileSync(path.join(tmp, 'secret.png'), 'SECRET');
fs.symlinkSync(path.join(tmp, 'secret.png'), path.join(api, 'link.png'));
fs.symlinkSync(path.join(tmp, 'secret.png'), path.join(api, 'dist/leak.png'));
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', pratinjau: { maxFiles: 4, maxBytes: 2000, batchSec: 60, autoMedia: false } }));

let live, store, dm, ag, pv, bayu;
const typed = [];
const ident = (r, sid = 's-bayu') => ({ office: 'shop', role: r, by: r.name, sid, cwd: api });
const call = async (tool, a) => {
  const res = await ag.callTool(ident(bayu), tool, a);
  return JSON.parse(res.content[0].text);
};
const fails = async (a, re) => assert.rejects(() => ag.callTool(ident(bayu), 'pratinjau_kirim', a), re);

/** Minimal req/res pair for pv.serve. */
async function get(url, headers = {}) {
  const res = { code: 0, headers: {}, body: Buffer.alloc(0), headersSent: false,
    writeHead(c, h) { this.code = c; this.headers = h; this.headersSent = true; },
    end(b) { if (b) this.body = Buffer.concat([this.body, Buffer.from(b)]); this.ended = true; this.done?.(); },
    write(b) { this.body = Buffer.concat([this.body, Buffer.from(b)]); return true; },
    on() { return this; }, once() { return this; }, emit() { return true; }, removeListener() { return this; } };
  const done = new Promise(r => { res.done = r; });
  await pv.serve({ method: 'GET', headers }, res, new URL(url, 'http://x').pathname);
  if (!res.ended) await done;
  return res;
}

before(async () => {
  const offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  dm = await import('../server/dm.js');
  ag = await import('../server/agent.js');
  pv = await import('../server/pratinjau.js');
  offices.officeForCwd(api);
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Frontend', room: 'api' });
  dm.setSender(async (sid, text) => { typed.push({ sid, text }); });
  const s = live.expectSession({ sid: 's-bayu', office: 'shop', role: bayu.id, room: 'api', cwd: api, tmux: 'kc-test-pv', slot: 0, title: 't' });
  s.status = 'idle';
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('pratinjau: path safety rejects anything outside the office folder', async () => {
  await fails({ judul: 'x', files: ['../../../secret.png'] }, /di luar folder kantor/);
  await fails({ judul: 'x', files: [path.join(tmp, 'secret.png')] }, /di luar folder kantor/);
  await fails({ judul: 'x', files: ['link.png'] }, /di luar folder kantor/, 'symlink resolved');
  await fails({ judul: 'x', files: ['nope.png'] }, /Tidak ada/);
  await fails({ judul: 'x', folder: '../..' }, /di luar folder kantor/);
  await fails({ files: ['a.png'] }, /judul/);
});

test('pratinjau: limits on file count and size', async () => {
  await fails({ judul: 'x', files: ['a.png', 'b.png', 'doc.pdf', 'a.png', 'b.png'] }, /maks 4/);
  await fails({ judul: 'x', files: ['big.bin'] }, /terlalu besar/);
  await fails({ judul: 'x', files: ['a.png'], mode: 'pilihan' }, /minimal 2/);
  await fails({ judul: 'x', files: ['a.png'], folder: 'dist' }, /salah satu/);
});

test('pratinjau: set mode snapshot, files served with sandbox CSP, Range, live + notify events', async () => {
  const events = [], notes = [];
  const onMsg = m => m.t === 'pratinjau' && events.push(m), onNotify = n => notes.push(n);
  live.bus.on('msg', onMsg); live.bus.on('notify', onNotify);
  const out = await call('pratinjau_kirim', { judul: 'Ikon', files: ['a.png', 'doc.pdf'], catatan: 'cek warnanya' });
  live.bus.off('msg', onMsg); live.bus.off('notify', onNotify);
  assert.match(out.id, /^p[0-9a-f]{10}$/);
  assert.equal(out.versi, 1);
  const it = pv.getItem('shop', out.id);
  assert.equal(it.mode, 'set');
  assert.deepEqual(it.files.map(f => [f.kind, f.status]), [['image', 'menunggu'], ['pdf', 'menunggu']]);
  assert.match(it.files[0].thumb, /^\/pvt\/shop\/p[0-9a-f]+\/[0-9a-f]{24}\/f1\.jpg$/);
  assert.equal(it.files[1].thumb, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].item.id, out.id);
  assert.deepEqual([notes[0].kind, notes[0].office, notes[0].id], ['pratinjau', 'shop', out.id]);
  // immutable: changing the source later does not change the snapshot
  fs.writeFileSync(path.join(api, 'a.png'), 'CHANGED');
  const r = await get(it.files[0].url);
  assert.equal(r.code, 200);
  assert.equal(r.body.toString(), 'PNGDATA');
  assert.match(r.headers['Content-Security-Policy'], /^sandbox allow-scripts/);
  assert.doesNotMatch(r.headers['Content-Security-Policy'], /allow-same-origin/);
  assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
  const part = await get(it.files[0].url, { range: 'bytes=0-2' });
  assert.equal(part.code, 206);
  assert.equal(part.body.toString(), 'PNG');
  // wrong key / traversal
  const bad = it.files[0].url.replace(/\/[0-9a-f]{24}\//, '/000000000000000000000000/');
  assert.equal((await get(bad)).code, 404);
  assert.equal((await get(it.files[0].url.replace('a.png', '..%2F..%2F..%2Fpratinjau'))).code, 403);
});

test('pratinjau: bundle mode serves a mini site with relative assets, skips symlinks, lists html entries', async () => {
  const out = await call('pratinjau_kirim', { judul: 'Situs', folder: 'dist' });
  const it = pv.getItem('shop', out.id);
  assert.equal(it.mode, 'bundle');
  assert.deepEqual(it.files.map(f => f.rel), ['index.html', 'about.html']);
  assert.ok(it.base.endsWith('/'));
  const page = await get(it.base);
  assert.equal(page.code, 200);
  assert.match(page.headers['Content-Type'], /text\/html/);
  assert.match(page.headers['Content-Security-Policy'], /^sandbox allow-scripts/);
  const css = await get(it.base + 'css/app.css');
  assert.equal(css.body.toString(), 'body{color:red}');
  assert.match(css.headers['Content-Type'], /text\/css/);
  assert.equal((await get(it.base + 'leak.png')).code, 404, 'symlink inside the folder was not copied');
});

test('pratinjau: bundle from a zip', async () => {
  try { execFileSync('/usr/bin/zip', ['-qr', path.join(api, 'site.zip'), 'dist'], { cwd: api }); } catch { return; }
  const out = await call('pratinjau_kirim', { judul: 'Zip', folder: 'site.zip' });
  const it = pv.getItem('shop', out.id);
  assert.equal((await get(it.base + 'css/app.css')).body.toString(), 'body{color:red}');
});

test('pratinjau: per-file decisions -> one DM to the sender, status aggregation', async () => {
  typed.length = 0;
  const { id } = await call('pratinjau_kirim', { judul: 'Dua', files: ['a.png', 'b.png'], jenis: 'persetujuan' });
  let it = await pv.decideFile('shop', id, 'f1', { status: 'oke' });
  assert.equal(it.status, 'sebagian');
  assert.equal(typed.length, 0, 'batched until all decided or the timer fires');
  it = await pv.decideFile('shop', id, 'f2', { status: 'revisi', catatan: 'terlalu gelap' });
  assert.equal(it.status, 'revisi');
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /\[Pesan dari Pemilik · id m[0-9a-f]+\] \[Pratinjau\] Pemilik menilai berkas "Dua"/);
  assert.match(typed[0].text, /a\.png: oke/);
  assert.match(typed[0].text, /b\.png: perlu revisi — terlalu gelap/);
  assert.match(typed[0].text, new RegExp(`revisiDari="${id}"`));
  it = await pv.approveAll('shop', id, { catatan: 'oke deh' });
  assert.equal(it.status, 'disetujui');
  assert.match(typed.at(-1).text, /MENYETUJUI/);
  it = await pv.requestRevision('shop', id, { catatan: 'ganti font' });
  assert.equal(it.status, 'revisi');
  assert.match(typed.at(-1).text, /REVISI.*ganti font/);
  await assert.rejects(() => pv.requestRevision('shop', id, {}), /catatan/);
  const st = await call('pratinjau_status', { id });
  assert.equal(st.status, 'revisi');
  assert.equal(st.catatan_pemilik, 'ganti font');
});

test('pratinjau: pilihan pick and filters', async () => {
  const { id } = await call('pratinjau_kirim', { judul: 'Logo', files: ['a.png', 'b.png'], mode: 'pilihan' });
  await assert.rejects(() => pv.pick('shop', id, { file: 'f9' }), /tidak ada/);
  const it = await pv.pick('shop', id, { file: 'f2' });
  assert.equal(it.status, 'dipilih');
  assert.equal(it.jenis, 'pilihan');
  assert.equal(it.picked, 'f2');
  assert.match(typed.at(-1).text, /MEMILIH "b\.png"/);
  assert.equal(pv.aggregate({ files: [] }), 'baru');
  const all = pv.listItems('shop');
  assert.equal(all.counts.semua, all.items.length);
  assert.ok(pv.listItems('shop', { status: 'disetujui' }).items.every(x => x.status === 'disetujui'));
  assert.ok(pv.listItems('shop', { status: 'perlu' }).items.every(x => x.jenis !== 'info' && !['disetujui', 'revisi', 'dipilih'].includes(x.status)));
  const sid = all.items.find(x => x.sid)?.sid;
  if (sid) assert.ok(pv.listItems('shop', { sid }).items.length && pv.listItems('shop', { sid }).items.every(x => x.sid === sid));
  assert.equal(pv.listItems('shop', { sid: 'tidak-ada' }).items.length, 0);
  assert.equal(pv.listItems('shop', { role: 'tidak-ada' }).items.length, 0);
});

test('pratinjau: versions chain through revisiDari', async () => {
  const v1 = await call('pratinjau_kirim', { judul: 'Hero', files: ['a.png'] });
  const v2 = await call('pratinjau_kirim', { judul: 'Hero', files: ['b.png'], revisiDari: v1.id });
  const v3 = await call('pratinjau_kirim', { judul: 'Hero', files: ['a.png'], revisiDari: v2.id });
  assert.equal(v3.versi, 3);
  const it = pv.getItem('shop', v3.id);
  assert.equal(it.parentId, v2.id);
  assert.equal(it.rootId, v1.id);
  assert.deepEqual(it.versions.map(v => [v.version, v.id]), [[1, v1.id], [2, v2.id], [3, v3.id]]);
  assert.deepEqual(pv.getItem('shop', v1.id).versions.length, 3);
  await fails({ judul: 'x', files: ['a.png'], revisiDari: 'pdeadbeef00' }, /tidak ditemukan/);
});

test('pratinjau: jadikan wiki embeds the files', async () => {
  const { id } = await call('pratinjau_kirim', { judul: 'Wiki', files: ['b.png', 'doc.pdf'] });
  const w = await pv.toWiki('shop', id, {});
  const page = store.getWiki('shop', w.slug);
  assert.match(page.title, /Pratinjau: Wiki/);
  assert.match(page.body, /!\[b\.png\]\(\/api\/offices\/shop\/media\/[0-9a-f]{20}\)/);
  assert.match(page.body, /\/media\/[0-9a-f]{20}\.pdf\)/);
  assert.equal(pv.getItem('shop', id).wiki, w.slug);
});

const snapshot = () => typed.length;

test('pratinjau: jenis defaults, statuses baru -> dilihat -> dikomentari, wake rules', async () => {
  const info = await call('pratinjau_kirim', { judul: 'Info', files: ['a.png'] });
  assert.equal(info.jenis, 'info');
  await fails({ judul: 'x', files: ['a.png'], jenis: 'aneh' }, /jenis/);
  let it = pv.getItem('shop', info.id);
  assert.equal(it.status, 'baru');
  const n0 = snapshot();
  it = pv.markSeen('shop', info.id);
  assert.equal(it.status, 'dilihat');
  assert.ok(it.seenAt);
  it = pv.react('shop', info.id, { emoji: '🔥' });
  assert.ok(it.reactions['🔥']);
  assert.throws(() => pv.react('shop', info.id, { emoji: 'x' }), /Reaksi/);
  assert.equal(snapshot(), n0, 'seen and emoji never DM / wake the agent');
  it = await pv.comment('shop', info.id, { teks: 'warnanya kurang', file: 'f1' });
  assert.equal(it.status, 'dikomentari');
  assert.equal(snapshot(), n0 + 1, 'a comment wakes the agent');
  assert.match(typed.at(-1).text, /berkomentar di "Info".*· a\.png: warnanya kurang/);
  const st = await call('pratinjau_status', { id: info.id });
  assert.equal(st.jenis, 'info');
  assert.ok(st.dilihat);
  assert.deepEqual(st.reaksi.map(r => r.emoji), ['🔥']);
  assert.equal(st.komentar[0].teks, 'warnanya kurang');
  assert.ok(st.komentar[0].at);
  // info items never count as needing a decision
  assert.ok(!pv.listItems('shop', { status: 'perlu' }).items.some(x => x.id === info.id));
});

test('pratinjau: time-coded video comment DM text', async () => {
  fs.writeFileSync(path.join(api, 'clip.mp4'), 'VID');
  const { id } = await call('pratinjau_kirim', { judul: 'Video', files: ['clip.mp4'] });
  const it = await pv.comment('shop', id, { teks: 'potong di sini', file: 'f1', t: 72.4 });
  assert.equal(it.comments[0].t, 72.4);
  assert.match(typed.at(-1).text, /clip\.mp4 @1:12: potong di sini/);
  assert.equal(pv.fmtT(3725), '1:02:05');
  await assert.rejects(() => pv.comment('shop', id, { teks: '' }), /komentar/);
});

test('pratinjau: pin / snooze / archive filters', async () => {
  const { id } = await call('pratinjau_kirim', { judul: 'Flag', files: ['a.png'], jenis: 'persetujuan' });
  assert.ok(pv.listItems('shop', { status: 'perlu' }).items.some(x => x.id === id));
  let it = pv.setFlags('shop', id, { snoozedUntil: new Date(Date.now() + 3600e3).toISOString() });
  assert.ok(it.snoozed);
  assert.ok(!pv.listItems('shop', { status: 'perlu' }).items.some(x => x.id === id));
  assert.ok(!pv.listItems('shop', { status: 'baru' }).items.some(x => x.id === id));
  pv.setFlags('shop', id, { snoozedUntil: null, pinned: true });
  assert.ok(pv.listItems('shop', { status: 'baru' }).items.some(x => x.id === id));
  assert.ok(pv.listItems('shop', { status: 'disimpan' }).items.some(x => x.id === id));
  pv.setFlags('shop', id, { archived: true });
  assert.ok(!pv.listItems('shop', { status: 'semua' }).items.some(x => x.id === id));
  const l = pv.listItems('shop', { status: 'arsip' });
  assert.ok(l.items.some(x => x.id === id));
  assert.equal(l.counts.arsip, l.items.length);
  assert.equal(l.counts.menunggu, l.counts.perlu);
});

test('pratinjau: only Setujui / Revisi move the linked card', async () => {
  const card = store.createCard('shop', { title: 'Hero banner' }, 'Bayu');
  const b = (await import('../server/boards.js')).getBoard('shop', card.board);
  const review = b.columns.findIndex(c => c.kind === 'review');
  store.updateCard('shop', card.id, { col: review }, 'Bayu');
  const colOf = () => store.getCard('shop', card.id).col;
  const { id } = await call('pratinjau_kirim', { judul: 'Hero', files: ['a.png', 'b.png'], jenis: 'persetujuan', kartu: card.id });
  pv.markSeen('shop', id); pv.react('shop', id, { emoji: '👍' });
  await pv.comment('shop', id, { teks: 'hmm' });
  assert.equal(colOf(), review, 'seen / emoji / comment do not move the card');
  const p2 = await call('pratinjau_kirim', { judul: 'Hero pilih', files: ['a.png', 'b.png'], mode: 'pilihan', kartu: card.id });
  await pv.pick('shop', p2.id, { file: 'f1' });
  assert.equal(colOf(), review, 'pick only comments');
  assert.ok(store.getCard('shop', card.id).comments?.some?.(c => /memilih a\.png/.test(c.text)) ?? true);
  await pv.approveAll('shop', id, {});
  assert.notEqual(colOf(), review, 'approve moves it');
  const moved = colOf();
  await pv.requestRevision('shop', id, { catatan: 'lagi' });
  assert.notEqual(colOf(), moved, 'revise moves it');
});

test('pratinjau: migration maps old statuses and sets jenis persetujuan', async () => {
  const { officeDb } = await import('../server/db.js');
  const d = officeDb('shop');
  d.prepare("INSERT INTO pratinjau (id, root_id, version, status, data, created_at) VALUES ('pold0000001', 'pold0000001', 1, 'menunggu', ?, ?)").run(JSON.stringify({ title: 'Lama', mode: 'set', files: [] }), new Date().toISOString());
  d.prepare("INSERT INTO pratinjau (id, root_id, version, status, data, created_at) VALUES ('pold0000002', 'pold0000002', 1, 'disetujui', ?, ?)").run(JSON.stringify({ title: 'Lama2', mode: 'pilihan', picked: 'f1', files: [] }), new Date().toISOString());
  pv.migrate('shop');
  const a = pv.getItem('shop', 'pold0000001'), b = pv.getItem('shop', 'pold0000002');
  assert.deepEqual([a.status, a.jenis], ['baru', 'persetujuan']);
  assert.deepEqual([b.status, b.jenis], ['dipilih', 'persetujuan']);
});

test('pratinjau: thumbnail fallback chain and ffmpeg-missing video', async () => {
  const saved = { ...pv.tools };
  const calls = [];
  const out = path.join(tmp, 'thumbs');
  try {
    // nothing installed -> null (kind icon)
    pv.tools.has = () => null;
    assert.equal(await pv.makeThumb(path.join(api, 'clip.mp4'), path.join(out, 'v'), 'video'), null);
    // qlmanage fails, sips renders the pdf
    pv.tools.has = n => (n === 'qlmanage' || n === 'sips' ? `/bin/${n}` : null);
    pv.tools.run = async (cmd, args) => { calls.push(path.basename(cmd)); if (cmd.endsWith('qlmanage')) throw new Error('no'); fs.writeFileSync(args.at(-1), 'JPG'); return { stdout: '' }; };
    assert.equal(await pv.makeThumb(path.join(api, 'doc.pdf'), path.join(out, 'p'), 'pdf'), 'jpg');
    assert.deepEqual(calls, ['qlmanage', 'sips']);
    // html via qlmanage -> png converted by sips
    calls.length = 0;
    pv.tools.run = async (cmd, args) => { calls.push(path.basename(cmd)); if (cmd.endsWith('qlmanage')) fs.writeFileSync(path.join(args[args.indexOf('-o') + 1], 'x.html.png'), 'PNG'); else fs.writeFileSync(args.at(-1), 'JPG'); return { stdout: '' }; };
    assert.equal(await pv.makeThumb(path.join(api, 'dist/index.html'), path.join(out, 'h'), 'html'), 'jpg');
    assert.deepEqual(calls, ['qlmanage', 'sips']);
    // image: ffmpeg fails -> sips
    calls.length = 0;
    pv.tools.has = n => `/bin/${n}`;
    pv.tools.run = async (cmd, args) => { const c = path.basename(args[2] && cmd.endsWith('nice') ? args[2] : cmd); calls.push(c); if (c === 'ffmpeg') throw new Error('no'); fs.writeFileSync(args.at(-1), 'JPG'); return { stdout: '' }; };
    assert.equal(await pv.makeThumb(path.join(api, 'a.png'), path.join(out, 'i'), 'image'), 'jpg');
    assert.deepEqual(calls, ['ffmpeg', 'sips']);
    // send never blocks; with ffmpeg missing the video gets no rendition and a failed thumb -> icon
    pv.tools.has = () => null;
    const { id } = await call('pratinjau_kirim', { judul: 'Tanpa ffmpeg', files: ['clip.mp4'] });
    await pv.prepareMedia('shop', id);
    const f = pv.getItem('shop', id).files[0];
    assert.equal(f.thumbState, 'gagal');
    assert.equal(f.putar, null);
    assert.equal(f.putarUrl, null);
    assert.ok(pv.needsPutar('a.mov', { video: 'h264', audio: 'aac' }));
    assert.ok(!pv.needsPutar('a.mp4', { video: 'h264', audio: 'aac' }));
    assert.ok(pv.needsPutar('a.mp4', { video: 'hevc', audio: 'aac' }));
  } finally { Object.assign(pv.tools, saved); }
});

test('pratinjau: storage usage per office is cached and recomputed on send', async () => {
  const u1 = pv.usage('shop');
  assert.ok(u1.bytes > 0 && u1.items > 0 && u1.files > 0);
  assert.equal(pv.usage('shop'), u1, 'cached');
  await call('pratinjau_kirim', { judul: 'Lagi', files: ['b.png'] });
  const u2 = pv.usage('shop');
  assert.equal(u2.items, u1.items + 1);
  assert.ok(u2.bytes > u1.bytes);
});

test('pratinjau: storage cleanup selection rules, dry-run, purge keeps item + thumbs', async () => {
  const { officeDb } = await import('../server/db.js');
  const old = new Date(Date.now() - 40 * 86400e3).toISOString();
  const age = id => { const d = officeDb('shop'); const r = d.prepare('SELECT data FROM pratinjau WHERE id = ?').get(id); const x = JSON.parse(r.data); x.lastAt = old; d.prepare('UPDATE pratinjau SET created_at = ?, decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE ? END, data = ? WHERE id = ?').run(old, old, JSON.stringify(x), id); };
  const mk = async (a) => (await call('pratinjau_kirim', { judul: 'C', files: ['a.png'], ...a })).id;
  const approved = await mk({ jenis: 'persetujuan' }); await pv.approveAll('shop', approved, {});
  const fresh = await mk({ jenis: 'persetujuan' }); await pv.approveAll('shop', fresh, {});
  const baru = await mk({});
  const revisi = await mk({ jenis: 'persetujuan' }); await pv.requestRevision('shop', revisi, { catatan: 'x' });
  const pinned = await mk({ jenis: 'persetujuan' }); await pv.approveAll('shop', pinned, {}); pv.setFlags('shop', pinned, { pinned: true });
  const infoSeen = await mk({}); pv.markSeen('shop', infoSeen);
  const snoozed = await mk({}); pv.markSeen('shop', snoozed); pv.setFlags('shop', snoozed, { snoozedUntil: new Date(Date.now() + 86400e3).toISOString() });
  const archived = await mk({ jenis: 'persetujuan' }); pv.setFlags('shop', archived, { archived: true });
  for (const id of [approved, baru, revisi, pinned, infoSeen, snoozed, archived]) age(id);
  fs.mkdirSync(path.join(process.env.KANTOR_HOME, 'offices/shop/pratinjau', approved, 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'offices/shop/pratinjau', approved, 'thumbs/f1.jpg'), 'T');
  const dry = pv.cleanup({ dryRun: true, office: 'shop' });
  const ids = dry.items.map(x => x.id);
  for (const id of [approved, infoSeen, archived]) assert.ok(ids.includes(id), `cleans ${[approved, infoSeen, archived].indexOf(id)} ${JSON.stringify(pv.getItem("shop", id).status)}`);
  for (const id of [fresh, baru, revisi, pinned, snoozed]) assert.ok(!ids.includes(id), `keeps ${id}`);
  assert.ok(dry.bytes > 0 && dry.dryRun);
  assert.equal(pv.getItem('shop', approved).filesPurged, false, 'dry run changes nothing');
  const u0 = pv.usage('shop').bytes;
  const done = pv.cleanup({ office: 'shop' });
  assert.equal(done.items.length, dry.items.length);
  const it = pv.getItem('shop', approved);
  assert.equal(it.filesPurged, true);
  assert.equal((await get(it.files[0].url)).code, 404);
  assert.equal((await get(it.files[0].thumb)).code, 200, 'thumbnail kept');
  assert.ok(pv.usage('shop').bytes < u0);
  assert.equal(pv.cleanup({ dryRun: true, office: 'shop' }).items.filter(x => x.id === approved).length, 0, 'not twice');
});
