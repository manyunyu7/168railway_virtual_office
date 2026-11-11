import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KANTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cermin-'));
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [process.env.KANTOR_HOME], token: 'x' }));
const mx = await import('../server/machines.js');
const mirror = await import('../server/mirror.js');
const { subagentTokens } = await import('../server/subtokens.js');

const REMOTE = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cermin-remote-'));
const m = mx.addMachine({ name: 'Mac Cermin', ssh: 'local:', hubUrl: 'http://hub.local:4317' });
const later = () => Date.now() + 3600e3; // semua entri jatuh tempo
const line = (o) => JSON.stringify(o) + '\n';

test('mirrorTranscript: tarikan awal sinkron, lalu append bertahap tercermin', async () => {
  const rf = path.join(REMOTE, '.claude', 'projects', '-x', 'a.jsonl');
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, line({ type: 'user', n: 1 }));
  const local = mirror.mirrorTranscript(m.id, rf);
  assert.equal(local, mx.mirrorPath(m.id, rf));
  assert.deepEqual(mx.remoteOfMirror(local), { machine: m.id, file: rf });
  assert.equal(fs.readFileSync(local, 'utf8'), fs.readFileSync(rf, 'utf8'));
  const ino = fs.statSync(local).ino;

  for (let i = 2; i <= 4; i++) {
    fs.appendFileSync(rf, line({ type: 'assistant', n: i }));
    await mirror.tick(later());
    assert.equal(fs.readFileSync(local, 'utf8'), fs.readFileSync(rf, 'utf8'), `putaran ${i}`);
  }
  assert.equal(fs.statSync(local).ino, ino, 'append tidak mengganti inode (fs.watch tetap jalan)');
  // panggilan kedua tidak menarik sinkron tapi tetap mengembalikan path yang sama
  fs.appendFileSync(rf, line({ n: 5 }));
  assert.equal(mirror.mirrorTranscript(m.id, rf), local);
  assert.equal(await mirror.syncNow(local), fs.statSync(rf).size);
  assert.equal(fs.readFileSync(local, 'utf8'), fs.readFileSync(rf, 'utf8'));
});

test('file remote mengecil: salinan dibuat ulang', async () => {
  const rf = path.join(REMOTE, 'b.jsonl');
  fs.writeFileSync(rf, 'satu\ndua\ntiga\n');
  const local = mirror.mirrorTranscript(m.id, rf);
  const ino = fs.statSync(local).ino;
  fs.writeFileSync(rf, 'baru\n');
  await mirror.tick(later());
  assert.equal(fs.readFileSync(local, 'utf8'), 'baru\n');
  assert.notEqual(fs.statSync(local).ino, ino, 'inode baru supaya pembaca inkremental mulai dari awal');
  fs.appendFileSync(rf, 'lagi\n');
  await mirror.tick(later());
  assert.equal(fs.readFileSync(local, 'utf8'), 'baru\nlagi\n');
});

test('file besar ditarik bertahap', async () => {
  const rf = path.join(REMOTE, 'besar.jsonl');
  const big = Buffer.alloc(9 << 20, 'x'); big[big.length - 1] = 10;
  fs.writeFileSync(rf, big);
  const local = mirror.mirrorTranscript(m.id, rf);
  assert.ok(fs.statSync(local).size < big.length, 'tarikan sinkron dibatasi');
  for (let i = 0; i < 10 && fs.statSync(local).size < big.length; i++) await mirror.tick(later());
  assert.equal(fs.statSync(local).size, big.length);
  assert.ok(fs.readFileSync(local).equals(big));
});

test('mesin offline dilewati, lalu menyusul saat online lagi', async () => {
  const rf = path.join(REMOTE, 'c.jsonl');
  fs.writeFileSync(rf, 'a\n');
  const local = mirror.mirrorTranscript(m.id, rf);
  await mx.shAsync(m.id, 'exit 255'); // ssh gagal → mesin offline
  assert.ok(mx.isOffline(m.id));
  fs.appendFileSync(rf, 'b\n');
  await mirror.tick(later());
  assert.equal(fs.readFileSync(local, 'utf8'), 'a\n');
  // file baru di mesin offline: terdaftar, belum ditarik, tidak memblokir
  const rf2 = path.join(REMOTE, 'd.jsonl');
  fs.writeFileSync(rf2, 'd\n');
  const l2 = mirror.mirrorTranscript(m.id, rf2);
  assert.equal(fs.readFileSync(l2, 'utf8'), '');
  await mx.shAsync(m.id, 'true');
  assert.ok(!mx.isOffline(m.id));
  await mirror.tick(later());
  assert.equal(fs.readFileSync(local, 'utf8'), 'a\nb\n');
  assert.equal(fs.readFileSync(l2, 'utf8'), 'd\n');
});

test('file remote belum ada: salinan kosong, muncul belakangan', async () => {
  const rf = path.join(REMOTE, 'nanti.jsonl');
  const local = mirror.mirrorTranscript(m.id, rf);
  assert.equal(fs.readFileSync(local, 'utf8'), '');
  fs.writeFileSync(rf, 'ada\n');
  await mirror.tick(later());
  assert.equal(fs.readFileSync(local, 'utf8'), 'ada\n');
});

test('mesin lokal: path asli dikembalikan apa adanya', () => {
  assert.equal(mirror.mirrorTranscript(null, '/tmp/x.jsonl'), '/tmp/x.jsonl');
  assert.equal(mirror.mirrorTranscript('local', '/tmp/x.jsonl'), '/tmp/x.jsonl');
});

test('statScript dan parseStat: banyak file dalam satu panggilan', async () => {
  const a = path.join(REMOTE, "it's.txt"); fs.writeFileSync(a, '12345');
  const r = await mx.shAsync(m.id, mirror.statScript([a, path.join(REMOTE, 'tidak-ada')]));
  const s = mirror.parseStat(r.stdout, 2);
  assert.equal(s[0].size, 5);
  assert.equal(s[1].size, -1);
});

test('token subagent remote dibaca dari cermin', async () => {
  const rf = path.join(REMOTE, '.claude', 'projects', '-y', 'sess.jsonl');
  const sub = path.join(REMOTE, '.claude', 'projects', '-y', 'sess', 'subagents', 'agent-abc.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(rf, line({ type: 'user' }));
  fs.writeFileSync(sub, line({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }));
  const local = mirror.mirrorTranscript(m.id, rf);
  assert.equal(subagentTokens(local, 'abc'), null, 'belum ditarik; jalur panas tidak memanggil ssh sinkron');
  await mirror.tick(later());
  assert.equal(subagentTokens(local, 'abc'), 15);
});

test('mirrorRoots menemukan folder projects cermin; loopback yang menyalin folder lokal dilewati', () => {
  const roots = mirror.mirrorRoots('claude', { localDir: '/tidak/ada' });
  assert.ok(roots.some(r => r.machine === m.id && r.dir === mx.mirrorPath(m.id, path.join(REMOTE, '.claude', 'projects'))));
  const same = mirror.mirrorRoots('claude', { localDir: path.join(REMOTE, '.claude', 'projects') });
  assert.ok(!same.some(r => r.machine === m.id));
});

test('payroll: listFiles ikut memindai transkrip cermin dan menandai mesinnya', async () => {
  const { listFiles } = await import('../server/payroll.js');
  const roots = mirror.mirrorRoots('claude', { localDir: '/tidak/ada' });
  const got = listFiles(30, roots);
  const want = mx.mirrorPath(m.id, path.join(REMOTE, '.claude', 'projects', '-y', 'sess.jsonl'));
  const sub = mx.mirrorPath(m.id, path.join(REMOTE, '.claude', 'projects', '-y', 'sess', 'subagents', 'agent-abc.jsonl'));
  assert.ok(got.some(x => x.f === want && x.machine === m.id));
  assert.ok(got.some(x => x.f === sub && x.parent === 'sess' && x.machine === m.id));
});

test('tailwatch: append oleh cermin memicu pembaruan chat, juga setelah salinan dibuat ulang', async () => {
  const tw = await import('../server/tailwatch.js');
  const { live, bus } = await import('../server/live.js');
  const rf = path.join(REMOTE, '.claude', 'projects', '-z', 'tw.jsonl');
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, line({ type: 'user', sessionId: 'aaaaaaaa-0000' }));
  const local = mirror.mirrorTranscript(m.id, rf);
  const s = { sid: 'remote-1', office: 'o1', status: 'idle', transcript: local, machine: m.id, tmux: 'kc-o1-be', subs: new Map(), pendingAgents: [] };
  live.set(s.sid, s);
  const seen = [];
  const on = msg => { if (msg.t === 'transcript' && msg.sid === s.sid) seen.push(msg.size); };
  bus.on('msg', on);
  try {
    tw.sweep();
    const wait = async (n) => { for (let i = 0; i < 60 && seen.length < n; i++) await new Promise(r => setTimeout(r, 50)); };
    fs.appendFileSync(rf, line({ type: 'assistant' }));
    await mirror.tick(later());
    await wait(1);
    assert.equal(seen.at(-1), fs.statSync(rf).size, 'fs.watch pada salinan memicu event transcript');
    fs.writeFileSync(rf, line({ type: 'user', n: 'baru' }));
    await mirror.tick(later());
    tw.sweep(); // sapuan 1 s: inode baru ditonton ulang
    await wait(2);
    assert.equal(seen.at(-1), fs.statSync(rf).size);
    fs.appendFileSync(rf, line({ type: 'assistant', n: 'lagi' }));
    await mirror.tick(later());
    await wait(3);
    assert.equal(seen.at(-1), fs.statSync(rf).size, 'watcher baru tetap jalan setelah salinan dibuat ulang');
  } finally { bus.off('msg', on); live.delete(s.sid); tw.stopTailWatch(); }
});

test('scanCodexUsage: rollout cermin dihitung sekali; salinan loopback dari folder lokal dilewati', async () => {
  const { scanCodexUsage } = await import('../server/codexusage.js');
  const { globalDb, run, one } = await import('../server/db.js');
  const g = globalDb();
  const emptyCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cermin-codex-'));
  process.env.CODEX_HOME = emptyCodex; // folder Codex lokal kosong
  const rf = path.join(REMOTE, '.codex', 'sessions', '2026', '11', '11', 'rollout-2026-11-11T10-00-00-cx-remote-1.jsonl');
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  const ts = '2026-11-11T10:00:00.000Z';
  const tu = () => line({ timestamp: ts, type: 'token_usage_record', payload: { usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } } });
  fs.writeFileSync(rf, line({ timestamp: ts, type: 'session_meta', payload: { id: 'cx-remote-1', cwd: '/Users/mac2/repo-be' } })
    + line({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5-codex' } }) + tu());
  const local = mirror.mirrorTranscript(m.id, rf);
  // kantor diambil dari sesi Kantor yang transkripnya salinan ini (tidak ada ruangan remote di tes ini)
  run(g, 'INSERT INTO sessions (sid, office, role, transcript, machine) VALUES (?, ?, ?, ?, ?)', 'kc-sid-1', 'kantor-be', 'be', local, m.id);
  const total = () => one(g, "SELECT COALESCE(SUM(msgs),0) msgs, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_r),0) cache_r FROM usage WHERE sid = 'cx-remote-1'");
  assert.equal(scanCodexUsage(), true);
  assert.deepEqual({ ...total() }, { msgs: 1, input: 80, output: 10, cache_r: 20 });
  const row = one(g, "SELECT office, role FROM usage WHERE sid = 'cx-remote-1'");
  assert.equal(row.office, 'kantor-be');
  assert.equal(row.role, 'be');
  // scan ulang tanpa perubahan: tidak dihitung dobel
  assert.equal(scanCodexUsage(), false);
  assert.equal(total().msgs, 1);
  // append di remote → tercermin → hanya baris baru yang dihitung
  fs.appendFileSync(rf, tu());
  await mirror.tick(later());
  scanCodexUsage();
  assert.equal(total().msgs, 2);
  // mesin loopback yang folder Codex-nya = folder lokal: hanya file asli yang dihitung, salinannya dilewati
  run(g, "DELETE FROM usage WHERE sid = 'cx-remote-1'");
  run(g, 'DELETE FROM usage_files');
  process.env.CODEX_HOME = path.join(REMOTE, '.codex');
  scanCodexUsage();
  const files = g.prepare('SELECT path FROM usage_files').all().map(r => r.path);
  assert.ok(files.includes(rf) && !files.includes(local), 'salinan cermin tidak dipindai');
  process.env.CODEX_HOME = emptyCodex;
});
