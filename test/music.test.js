import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-music-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const music = path.join(tmp, 'Music'), outside = path.join(tmp, 'outside');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(music, 'album'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(music, '01 - Lagu_Satu.mp3'), Buffer.alloc(1000, 1));
fs.writeFileSync(path.join(music, 'album', 'dua.wav'), Buffer.alloc(500, 2));
fs.writeFileSync(path.join(music, 'catatan.txt'), 'bukan musik');
fs.writeFileSync(path.join(music, '.rahasia.mp3'), 'x');
fs.writeFileSync(path.join(outside, 'rahasia.mp3'), 'secret');
fs.symlinkSync(path.join(outside, 'rahasia.mp3'), path.join(music, 'link.mp3'));
fs.symlinkSync(outside, path.join(music, 'linkdir'));
fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ token: 'x', roots: [tmp], musicDir: music }));

let m;
before(async () => { m = await import('../server/music.js'); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('listMusic: only audio, no dotfiles, no outside symlinks', () => {
  const { dir, files } = m.listMusic();
  assert.equal(dir, music);
  const paths = files.map(f => f.path).sort();
  assert.deepEqual(paths, ['01 - Lagu_Satu.mp3', 'album/dua.wav']);
  assert.equal(files.find(f => f.path.endsWith('.mp3')).name, 'Lagu Satu');
  assert.equal(files[0].size > 0, true);
});

async function stream(rel, range) {
  const { Writable } = await import('node:stream');
  const out = { code: 0, headers: {}, chunks: [] };
  const w = new Writable({ write(c, _, cb) { out.chunks.push(c); cb(); } });
  w.writeHead = (c, h) => { out.code = c; out.headers = h; };
  const done = new Promise(r => w.on('finish', r));
  m.sendMusic(rel, { headers: range ? { range } : {}, method: 'GET' }, w);
  if (out.code === 416) w.end();
  await done;
  out.body = Buffer.concat(out.chunks.map(c => Buffer.from(c)));
  return out;
}

test('sendMusic: full file and range (206)', async () => {
  const a = await stream('01 - Lagu_Satu.mp3');
  assert.equal(a.code, 200);
  assert.equal(a.headers['Accept-Ranges'], 'bytes');
  assert.equal(a.headers['Content-Type'], 'audio/mpeg');
  assert.equal(a.body.length, 1000);
  const b = await stream('01 - Lagu_Satu.mp3', 'bytes=100-199');
  assert.equal(b.code, 206);
  assert.equal(b.headers['Content-Range'], 'bytes 100-199/1000');
  assert.equal(b.body.length, 100);
  const c = await stream('01 - Lagu_Satu.mp3', 'bytes=-50');
  assert.equal(c.code, 206);
  assert.equal(c.body.length, 50);
  const d = await stream('album/dua.wav', 'bytes=9999-');
  assert.equal(d.code, 416);
});

test('sendMusic: refuses traversal, symlinks, non-audio, dotfiles, missing', () => {
  const bad = ['../outside/rahasia.mp3', 'album/../../outside/rahasia.mp3', path.join(outside, 'rahasia.mp3'), 'link.mp3', 'linkdir/rahasia.mp3', 'catatan.txt', '.rahasia.mp3', 'nggakada.mp3', '', 'album'];
  for (const rel of bad) {
    assert.throws(() => m.sendMusic(rel, { headers: {} }, {}), e => e.code === 404, rel);
  }
});

const body = (buf, extra = {}) => Object.assign(Readable.from([Buffer.from(buf)]), { headers: { 'content-length': String(buf.length), ...extra } });

test('upload: lands in "Kantor Claude", never overwrites, rejects non-audio', async () => {
  const a = await m.uploadMusic('lagu baru.mp3', body('aaaa'));
  assert.equal(a.path, 'Kantor Claude/lagu baru.mp3');
  const b = await m.uploadMusic('lagu baru.mp3', body('bbbb'));
  assert.equal(b.path, 'Kantor Claude/lagu baru (2).mp3');
  assert.equal(b.renamed, true);
  assert.equal(fs.readFileSync(path.join(music, a.path), 'utf8'), 'aaaa');
  assert.equal(fs.readFileSync(path.join(music, b.path), 'utf8'), 'bbbb');
  await assert.rejects(m.uploadMusic('virus.sh', body('x')), /audio/);
  await assert.rejects(m.uploadMusic('../../evil.mp3', body('x')).then(r => { assert.ok(r.path.startsWith('Kantor Claude/')); throw new Error('audio ok'); }), /audio ok/);
  await assert.rejects(m.uploadMusic('x.mp3', body('x', { 'content-length': String(300 * 1024 * 1024) })), /terlalu besar/);
  assert.equal(fs.readdirSync(path.join(music, 'Kantor Claude')).some(f => f.endsWith('.kc-upload')), false);
  assert.ok(m.listMusic().files.some(f => f.path === a.path));
});

test('playlists: CRUD, reorder, containment, missing files', () => {
  const pl = m.createPlaylist('Kerja', ['01 - Lagu_Satu.mp3', 'album/dua.wav', 'link.mp3', 'nggakada.mp3']);
  assert.deepEqual(pl.items.map(i => i.path), ['01 - Lagu_Satu.mp3', 'album/dua.wav']);
  assert.throws(() => m.createPlaylist('X', ['../outside/rahasia.mp3']), e => e.code === 400);
  assert.throws(() => m.createPlaylist('X', ['/etc/passwd.mp3']), e => e.code === 400);
  assert.throws(() => m.createPlaylist('   '), e => e.code === 400);
  let u = m.updatePlaylist(pl.id, { items: ['album/dua.wav', '01 - Lagu_Satu.mp3'] });
  assert.deepEqual(u.items.map(i => i.path), ['album/dua.wav', '01 - Lagu_Satu.mp3']);
  u = m.updatePlaylist(pl.id, { name: 'Santai', add: ['Kantor Claude/lagu baru.mp3', 'album/dua.wav'] });
  assert.equal(u.name, 'Santai');
  assert.equal(u.items.length, 3);
  assert.throws(() => m.updatePlaylist(pl.id, { add: ['link.mp3'] }), e => e.code === 404);
  assert.throws(() => m.updatePlaylist(pl.id, { add: ['linkdir/rahasia.mp3'] }), e => e.code === 404);
  assert.throws(() => m.updatePlaylist(pl.id, { items: ['../x.mp3'] }), e => e.code === 400);
  fs.unlinkSync(path.join(music, 'Kantor Claude', 'lagu baru.mp3'));
  assert.equal(m.listPlaylists().find(p => p.id === pl.id).items.find(i => i.path.endsWith('lagu baru.mp3')).missing, true);
  m.deletePlaylist(pl.id);
  assert.equal(m.listPlaylists().some(p => p.id === pl.id), false);
  assert.throws(() => m.deletePlaylist(pl.id), e => e.code === 404);
});
