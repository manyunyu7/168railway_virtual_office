// Alat agen untuk ruangan dan sesi di Mac lain (docs/MULTI-PC.md), lewat mesin 'local:' (jalur kode remote, perintah di Mac ini).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-alat-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
process.env.KANTOR_NO_GH = '1';
const root = path.join(tmp, 'Developer');
const remote = path.join(tmp, 'mac2', 'repo-be'); // "folder di Mac kedua"
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));
fs.mkdirSync(path.join(root, 'kantor', 'web'), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'kantor', 'web') });
fs.mkdirSync(path.join(remote, 'src'), { recursive: true });
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: remote, encoding: 'utf8' });
git('init', '-q');
fs.writeFileSync(path.join(remote, 'README.md'), 'halo\n');
fs.writeFileSync(path.join(remote, 'src', 'app.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(remote, 'package.json'), JSON.stringify({ scripts: { dev: 'node src/app.js' } }));
git('add', '-A'); git('commit', '-q', '-m', 'awal');
fs.mkdirSync(path.join(tmp, 'mac2', 'rahasia'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'mac2', 'rahasia', 'kunci.txt'), 'jangan');
fs.symlinkSync(path.join(tmp, 'mac2', 'rahasia'), path.join(remote, 'tautan'));

let mx, offices, files, office, roomId, db, live, att, gi, agent, actor, shows, pr;
const tmuxOk = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
before(async () => {
  mx = await import('../server/machines.js');
  offices = await import('../server/offices.js');
  files = await import('../server/files.js');
  db = await import('../server/db.js');
  live = await import('../server/live.js');
  att = await import('../server/attachments.js');
  gi = await import('../server/gitinfo.js');
  agent = await import('../server/agent.js');
  actor = await import('../server/actor.js');
  shows = await import('../server/shows.js');
  pr = await import('../server/procs.js');
  mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
  office = offices.officeForCwd(path.join(root, 'kantor', 'web'));
  roomId = offices.addRoom(office, { name: 'Backend', machine: 'mac-dua', remotePath: remote });
});
after(() => {
  try { for (const p of pr.listProcs(office)) try { execFileSync('tmux', ['kill-session', '-t', pr.sessName(office, p)]); } catch {} } catch {}
  try { for (const t of pr.listTerms(office)) try { execFileSync('tmux', ['kill-session', '-t', t.name]); } catch {} } catch {}
  db?.closeAll?.(); fs.rmSync(tmp, { recursive: true, force: true });
});
const remoteSession = sid => live.expectSession({ sid, office, role: null, room: roomId, cwd: remote, tmux: null, slot: 0, title: 'BE', machine: 'mac-dua' });
const viaMachine = fn => actor.withActor(actor.machineActor('mac-dua', 'Mac Dua'), fn);

test('files: ruangan remote tampil di akar dan bisa dijelajah lewat @ruangan', () => {
  const top = files.listDir(office, '');
  const v = top.entries.find(e => e.path === `@${roomId}`);
  assert.ok(v, 'folder virtual ruangan remote ada di akar');
  assert.equal(v.machine, 'mac-dua');
  const d = files.listDir(office, `@${roomId}`);
  assert.deepEqual(d.entries.map(e => e.name), ['src', 'tautan', 'package.json', 'README.md']);
  assert.equal(d.entries.find(e => e.name === 'README.md').size, 5);
  assert.equal(d.machine, 'mac-dua');
  assert.ok(files.listDir(office, `@${roomId}`, { all: true }).entries.some(e => e.name === '.git'));
  assert.deepEqual(files.listDir(office, `@${roomId}/src`).entries.map(e => e.path), [`@${roomId}/src/app.js`]);
  const t = files.readText(office, `@${roomId}/README.md`);
  assert.equal(t.kind, 'text'); assert.equal(t.text, 'halo\n');
  assert.deepEqual(files.findFiles(office, `@${roomId}`, 'APP').map(f => f.path), [`@${roomId}/src/app.js`]);
});

test('files: path remote tidak bisa keluar dari folder ruangan', () => {
  assert.throws(() => files.listDir(office, `@${roomId}/..`), /luar folder/);
  assert.throws(() => files.readText(office, `@${roomId}/../rahasia/kunci.txt`), /luar folder/);
  assert.throws(() => files.readText(office, `@${roomId}/tautan/kunci.txt`), /luar folder/);
  assert.throws(() => files.listDir(office, `@${roomId}/tautan`), /luar folder/);
});

test('files: mkdir, upload, dan raw di ruangan remote', async () => {
  files.makeDir(office, `@${roomId}`, 'baru');
  assert.ok(fs.statSync(path.join(remote, 'baru')).isDirectory());
  assert.throws(() => files.makeDir(office, `@${roomId}`, 'baru'), /Sudah ada/);
  const { Readable } = await import('node:stream');
  const mkReq = buf => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
  const up = await files.upload(office, `@${roomId}/baru`, 'catatan.txt', mkReq(Buffer.from('isi satu')));
  assert.equal(up.path, `@${roomId}/baru/catatan.txt`);
  const up2 = await files.upload(office, `@${roomId}/baru`, 'catatan.txt', mkReq(Buffer.from('isi dua')));
  assert.equal(up2.name, 'catatan (2).txt');
  assert.equal(fs.readFileSync(path.join(remote, 'baru', 'catatan (2).txt'), 'utf8'), 'isi dua');
  const chunks = [];
  await new Promise((resolve, reject) => {
    const res = { headers: null, destroyed: false, writeHead(c, h) { this.code = c; this.headers = h; }, write(b) { chunks.push(Buffer.from(b)); return true; }, end: resolve, destroy: () => reject(new Error('putus')), once() {} };
    files.sendRaw(office, `@${roomId}/baru/catatan.txt`, res);
  });
  assert.equal(Buffer.concat(chunks).toString(), 'isi satu');
});

test('lampiran: kirim_ke_pemilik dari sesi remote menarik file ke Mac ini', async () => {
  remoteSession('rs-1');
  const big = Buffer.alloc(9 * 1024 * 1024 + 123, 7); // > satu potongan 4 MB
  fs.mkdirSync(path.join(remote, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(remote, 'dist', 'besar.bin'), big);
  const it = await att.sendToOwner({ office, sid: 'rs-1', by: 'BE', machine: 'mac-dua', cwd: remote }, 'dist/besar.bin', 'hasil');
  assert.equal(it.size, big.length);
  assert.equal(it.path, 'dist/besar.bin');
  assert.equal(it.machine, 'mac-dua');
  const row = db.one(db.globalDb(), 'SELECT path FROM attachments WHERE id = ?', it.id);
  assert.ok(!row.path.startsWith(remote), 'salinan lokal, bukan path di mesin itu');
  assert.ok(fs.readFileSync(row.path).equals(big));
  await assert.rejects(att.sendToOwner({ office, sid: 'rs-1', machine: 'mac-dua', cwd: remote }, '/etc/hosts'), /folder kerja/);
  await assert.rejects(att.sendToOwner({ office, sid: 'rs-1', machine: 'mac-dua', cwd: remote }, 'tidak-ada.txt'), /Tidak ada file/);
});

test('lampiran: upload pemilik ke sesi remote sampai di .kantor/inbox mesin itu', async () => {
  remoteSession('rs-2');
  const { Readable } = await import('node:stream');
  const data = Buffer.from('halo dari pemilik');
  const u = att.createUpload('rs-2', { name: 'catatan.txt', size: data.length });
  const req = Object.assign(Readable.from([data]), { headers: { 'upload-offset': '0', 'content-length': String(data.length) } });
  const r = await att.appendUpload(u.id, req);
  assert.ok(r.done);
  let got = null;
  for (let i = 0; i < 100 && !got; i++) {
    await new Promise(res => setTimeout(res, 50));
    const a = att.getAttachment(r.attachment.id);
    if (!a.processing) got = a;
  }
  assert.ok(got, 'pemrosesan selesai');
  assert.match(got.path, /^\.kantor\/inbox\/\d{8}-\d{4}-catatan\.txt$/);
  assert.equal(fs.readFileSync(path.join(remote, got.path), 'utf8'), 'halo dari pemilik');
  assert.match(fs.readFileSync(path.join(remote, '.git', 'info', 'exclude'), 'utf8'), /^\.kantor\/$/m);
});

test('gambar transkrip dari sesi remote disajikan lewat salinan', async () => {
  remoteSession('rs-3');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  fs.writeFileSync(path.join(remote, 'shot.png'), png);
  const chunks = [];
  const res = { writeHead(c, h) { this.code = c; this.h = h; }, end() {}, write() {}, on() { return this; }, once() { return this; }, emit() {}, removeListener() { return this; } };
  const { Writable } = await import('node:stream');
  const sink = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  sink.writeHead = (c, h) => { sink.code = c; };
  await att.sendSessionImage('rs-3', path.join(remote, 'shot.png'), false, { method: 'GET', headers: {} }, sink);
  await new Promise(r => sink.on('finish', r));
  assert.equal(sink.code, 200);
  assert.ok(Buffer.concat(chunks).equals(png));
  await assert.rejects(att.sendSessionImage('rs-3', path.join(tmp, 'mac2', 'rahasia', 'x.png'), false, { method: 'GET', headers: {} }, res), /tidak ada|luar/i);
});

test('git: status, diff, dan commit ruangan remote jalan di mesin itu', async () => {
  fs.writeFileSync(path.join(remote, 'README.md'), 'halo\ndunia\n');
  fs.writeFileSync(path.join(remote, 'baru.txt'), 'a\nb\nc');
  const g = await gi.officeGit(office, { fresh: true });
  assert.ok(g[roomId], 'ruangan remote punya info git');
  assert.ok(g[roomId].dirty >= 2);
  const d = await gi.gitDiff(office, roomId);
  const readme = d.files.find(f => f.file === 'README.md'), baru = d.files.find(f => f.file === 'baru.txt');
  assert.deepEqual([readme.add, readme.del], [1, 0]);
  assert.deepEqual([baru.untracked, baru.add], [true, 3]);
  const one = await gi.gitDiff(office, roomId, 'README.md');
  assert.match(one.diff, /\+dunia/);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  const c = await gi.gitCommit(office, roomId, { message: 'ubah readme', files: ['README.md'] });
  assert.equal(c.subject, 'ubah readme');
  assert.equal(git('log', '-1', '--format=%s').trim(), 'ubah readme');
  assert.ok(git('status', '--porcelain').includes('baru.txt'), 'file lain tidak ikut');
  const h = await gi.headOf(office, roomId);
  assert.equal(h.subject, 'ubah readme');
  assert.equal(h.sha, git('rev-parse', 'HEAD').trim(), 'headOf (dipakai tunggu_kerja commit_baru) membaca repo di mesin itu');
  assert.equal(gi.roomOfToolUse(office, { tool_name: 'Edit', tool_input: { file_path: path.join(remote, 'src', 'app.js') }, kantor_machine: 'mac-dua' }, null), roomId);
});

test('agen: identitas dari token mesin dan sessions_list menandai mesin', async () => {
  remoteSession('rs-4');
  const ident = viaMachine(() => agent.resolveIdentity({ sid: 'rs-4', cwd: remote }));
  assert.equal(ident.office, office);
  assert.equal(ident.machine, 'mac-dua');
  const byCwd = viaMachine(() => agent.resolveIdentity({ cwd: path.join(remote, 'src') }));
  assert.equal(byCwd.office, office, 'kantor dicari lewat ruangan remote, bukan folder di Mac ini');
  assert.throws(() => viaMachine(() => agent.resolveIdentity({ cwd: '/tidak/ada/di/kantor' })), /bukan ruangan kantor/);
  const out = await agent.callTool(ident, 'sessions_list', {});
  const list = JSON.parse(out.content[0].text);
  const me = list.find(x => x.id === 'rs-4');
  assert.equal(me.mesin, 'Mac Dua');
  assert.equal(me.kamu, true);
});

test('tunjukkan: localhost dari sesi remote dijelaskan, file remote jadi path @ruangan', () => {
  assert.throws(() => shows.addShow({ office, sid: 'rs-4', machine: 'mac-dua', cwd: remote, url: 'http://localhost:5173/' }), /localhost di Mac Mac Dua.*\.local:5173/s);
  const okUrl = shows.addShow({ office, sid: 'rs-4', machine: 'mac-dua', cwd: remote, url: 'http://mac-dua.local:5173/' });
  assert.equal(okUrl.kind, 'url');
  const f = shows.addShow({ office, sid: 'rs-4', machine: 'mac-dua', cwd: remote, path: 'src/app.js' });
  assert.deepEqual([f.kind, f.target], ['file', `@${roomId}/src/app.js`]);
  assert.throws(() => shows.addShow({ office, sid: 'rs-4', machine: 'mac-dua', cwd: remote, path: '../rahasia/kunci.txt' }), /hanya isi folder ruangan/);
  return assert.rejects(shows.openLocal(office, `@${roomId}/src/app.js`, 'finder'), /belum didukung untuk ruangan di Mac lain/);
});

test('attach_file dari sesi remote', async () => {
  const ident = viaMachine(() => agent.resolveIdentity({ sid: 'rs-4', cwd: remote }));
  const st = await import('../server/store.js');
  st.saveWiki(office, { slug: 'catatan', title: 'Catatan', body: 'isi' }, 'uji');
  const out = await agent.callTool(ident, 'attach_file', { path: 'src/app.js', wiki: 'catatan' });
  assert.match(out.content[0].text, /app\.js .* dilampirkan ke wiki/);
});

test('proses: jalan, log, dan berhenti di mesin ruangan remote', { skip: !tmuxOk && 'tmux tidak ada' }, async () => {
  const v = pr.createProc(office, { room: roomId, cmd: 'echo halo-remote; sleep 30' });
  assert.equal(v.machine, 'mac-dua');
  const s = pr.startProc(office, v.id);
  assert.equal(s.status, 'jalan');
  assert.equal(mx.tmuxMachineOf(pr.sessName(office, v)), 'mac-dua');
  const log = path.join(mx.machineRoot('mac-dua'), 'proc', office.replace(/[^A-Za-z0-9_-]/g, '-'), `${v.id}.log`);
  let txt = '';
  for (let i = 0; i < 60 && !txt.includes('halo-remote'); i++) { await new Promise(r => setTimeout(r, 100)); txt = pr.logLines(office, v.id); }
  assert.match(txt, /halo-remote/);
  assert.ok(fs.existsSync(log), 'log ada di root kantor-node mesin itu');
  assert.match(pr.readLog(office, v.id).text, /halo-remote/);
  const list = JSON.parse(JSON.stringify(pr.agentList(office)));
  assert.equal(list.find(x => x.id === v.id).mesin, 'Mac Dua');
  assert.ok(pr.dockSessionOk(pr.sessName(office, v)));
  pr.stopProc(office, v.id);
  for (let i = 0; i < 60 && pr.getProc(office, v.id).status === 'jalan'; i++) await new Promise(r => setTimeout(r, 100));
  assert.notEqual(pr.getProc(office, v.id).status, 'jalan');
  pr.removeProc(office, v.id);
  assert.ok(!fs.existsSync(log));
  assert.deepEqual(pr.suggestRoom(office, roomId).map(x => x.cmd), ['npm run dev']);
});

test('terminal dok di ruangan remote', { skip: !tmuxOk && 'tmux tidak ada' }, () => {
  const t = pr.createTerm(office, roomId);
  assert.equal(t.machine, 'mac-dua');
  const found = pr.listTerms(office).find(x => x.name === t.name);
  assert.ok(found);
  assert.equal(found.machine, 'mac-dua', 'tercatat sebagai terminal di mesin itu');
  assert.ok(pr.dockSessionOk(t.name));
  pr.closeTerm(office, t.name);
});

test('pratinjau_kirim dari sesi remote: berkas lepas dan folder situs ditarik', async () => {
  const ident = viaMachine(() => agent.resolveIdentity({ sid: 'rs-4', cwd: remote }));
  fs.mkdirSync(path.join(remote, 'site', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(remote, 'site', 'index.html'), '<h1>hai</h1>');
  fs.writeFileSync(path.join(remote, 'site', 'node_modules', 'x.js'), '1');
  fs.writeFileSync(path.join(remote, 'a.txt'), 'satu');
  const p1 = await agent.callTool(ident, 'pratinjau_kirim', { judul: 'Berkas', files: ['a.txt', 'src/app.js'] });
  const r1 = JSON.parse(p1.content[0].text);
  assert.equal(r1.berkas.length, 2);
  const p2 = await agent.callTool(ident, 'pratinjau_kirim', { judul: 'Situs', folder: 'site' });
  const r2 = JSON.parse(p2.content[0].text);
  assert.equal(r2.mode, 'bundle');
  assert.deepEqual(r2.berkas, ['f1 index.html (html)']);
  await assert.rejects(agent.callTool(ident, 'pratinjau_kirim', { judul: 'X', files: ['/etc/hosts'] }), /di luar folder ruangan/);
});
