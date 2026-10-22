import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-metrics-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
const repo = path.join(root, 'shop/api');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'go.mod'), 'module api');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));

// fixed shift: 2030-01-10 10:00Z .. 14:00Z (explicit range, so the machine timezone does not matter)
const T = (h, m = 0, s = 0) => new Date(Date.UTC(2030, 0, 10, h, m, s)).toISOString();
const NOW = Date.parse(T(14, 30));
const Q = { range: 'custom', from: T(10), to: T(14) };

let M, db, odb, g, bayu, sinta;
before(async () => {
  const offices = await import('../server/offices.js');
  const store = await import('../server/store.js');
  db = await import('../server/db.js');
  M = await import('../server/metrics.js');
  offices.officeForCwd(repo);
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Dev', room: 'api' });
  sinta = store.createRole('shop', { name: 'Sinta', title: 'QA', room: 'api' });
  odb = db.officeDb('shop'); g = db.globalDb();
  const card = (id, col, who, created, moved) => odb.prepare('INSERT INTO cards (id, title, col, who, created_at, moved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'Kartu ' + id, col, who, created, moved, moved);
  const hist = (id, text, at) => odb.prepare('INSERT INTO card_hist (card_id, who, text, at) VALUES (?, ?, ?, ?)').run(id, 'x', text, at);
  // c1: Dikerjakan 10:10 -> Review 10:50 -> Selesai 11:10 (1h); c2: Dikerjakan 10:20 -> Review -> back to Dikerjakan -> Review -> Selesai 13:20 (3h)
  card('c1', 4, bayu.id, T(10, 5), T(11, 10)); hist('c1', 'membuat kartu di Backlog', T(10, 5)); hist('c1', 'memindahkan Backlog → Dikerjakan', T(10, 10)); hist('c1', 'memindahkan Dikerjakan → Review', T(10, 50)); hist('c1', 'memindahkan Review → Selesai', T(11, 10));
  card('c2', 4, sinta.id, T(10, 6), T(13, 20)); hist('c2', 'membuat kartu di Backlog', T(10, 6)); hist('c2', 'memindahkan Backlog → Dikerjakan', T(10, 20)); hist('c2', 'memindahkan Dikerjakan → Review', T(11)); hist('c2', 'memindahkan Review → Dikerjakan', T(11, 30)); hist('c2', 'memindahkan Dikerjakan → Review', T(12)); hist('c2', 'memindahkan Review → Selesai', T(13, 20));
  // c3 sits in Dikerjakan since 10:30 (stuck at 14:30); c4 moved recently; c5 was created before the shift
  card('c3', 2, bayu.id, T(10, 30), T(10, 30)); hist('c3', 'membuat kartu di Dikerjakan', T(10, 30));
  card('c4', 2, sinta.id, T(14, 10), T(14, 20)); hist('c4', 'memindahkan Siap → Dikerjakan', T(14, 20));
  card('c5', 4, bayu.id, T(8), T(8, 30)); hist('c5', 'memindahkan Dikerjakan → Selesai', T(8, 30));
  // dm: m1 typed after 10 min, answered after 20; m2 typed at once; m3 a question nobody answered; m4 still waiting
  const dm = (id, from, to, kind, status, at, sent, read, rep) => odb.prepare('INSERT INTO dm (id, from_role, to_role, kind, status, at, sent_at, read_at, replied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, from, to, kind, status, at, sent, read, rep);
  dm('m1', bayu.id, sinta.id, 'pesan', 'dibalas', T(10, 30), T(10, 40), T(10, 40), T(10, 50));
  dm('m2', sinta.id, bayu.id, 'balasan', 'dibaca', T(10, 50), T(10, 50), T(10, 50), null);
  dm('m3', bayu.id, sinta.id, 'tanya', 'terkirim', T(11), T(11, 0, 5), null, null);
  dm('m4', bayu.id, sinta.id, 'pesan', 'menunggu', T(13, 50), null, null, null);
  // log: Bayu works 10:00-10:02 (3 events 1 min apart + 180 s tail), then 10:30 alone; two failures, one compaction; announcements
  const log = (who, text, at, kind) => odb.prepare('INSERT INTO log (who, text, at, kind) VALUES (?, ?, ?, ?)').run(who, text, at, kind);
  log('Bayu', 'Bash ls', T(10), 'tool'); log('Bayu', 'Bash ls', T(10, 1), 'tool'); log('Bayu', 'Bash ls', T(10, 2), 'tool'); log('Bayu', 'Read a', T(10, 30), 'tool');
  log('Bayu', 'gagal: Bash - exit 1', T(10, 3), 'tool'); log('Bayu', 'gagal: Bash - exit 1', T(10, 4), 'tool'); log('Bayu', 'gagal: mcp__kantor__card_check', T(10, 5), 'tool');
  log('Bayu', 'merapikan konteks (kompaksi)', T(12), 'session'); log('Sinta', 'diinterupsi (Esc)', T(12, 5), 'session');
  odb.prepare('INSERT INTO news (text, at, author) VALUES (?, ?, ?)').run('aturan', T(11), 'x');
  // sessions + permission inbox + usage
  g.prepare('INSERT INTO sessions (sid, office, role, started_at, ended_at, status, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)').run('s1', 'shop', bayu.id, T(9), T(15), 'ended', T(15));
  const inbox = (id, st, a, b) => g.prepare('INSERT INTO inbox (id, office, role, tool, created_at, decided_at, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'shop', bayu.id, 'Bash', a, b, st, 'kantor');
  inbox('i1', 'terminal', T(10, 10), T(10, 11)); inbox('i2', 'allowed', T(10, 20), T(10, 20, 10));
  const use = (sid, role, model, day, cost, tok) => g.prepare('INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cache_w, cache_r, cost) VALUES (?, ?, ?, ?, ?, 10, ?, ?, 0, 0, ?)').run(sid, 'shop', role, model, day, tok, tok, cost);
  const day = new Date(Date.parse(T(12))); const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  use('s1', bayu.id, 'claude-opus', dayKey, 12, 100); use('s2', sinta.id, 'gpt-codex', dayKey, 0, 500);
  // git: 3 commits (one revert) inside the shift, 1 outside
  const sh = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, stdio: 'pipe' });
  sh('init', '-q');
  const commit = (msg, when, n) => { fs.writeFileSync(path.join(repo, 'f' + n), String(n)); sh('add', '.'); execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }); };
  commit('feat: a', T(7), 0); commit('feat: b', T(10, 30), 1); commit('fix(x): c', T(11, 30), 2); commit('Revert "feat: b"', T(12, 30), 3);
});
after(() => { db.closeAll(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('stats: persentil nearest-rank, median, kosong', () => {
  const s = M.stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.avg, 55); assert.equal(s.median, 55); assert.equal(s.p90, 90); assert.equal(s.max, 100);
  assert.equal(M.stats([]).avg, null);
});

test('rentang: kustom, batas, dan galat', () => {
  const r = M.resolveRange(Q, NOW);
  assert.equal(r.bucket, 'hour');
  assert.throws(() => M.resolveRange({ range: 'custom' }, NOW), /from/);
  assert.throws(() => M.resolveRange({ range: 'custom', from: '2029-01-01', to: '2030-01-01' }, NOW), /93 hari/);
  assert.equal(M.resolveRange({ range: '7d' }, NOW).bucket, 'day');
});

test('kartu: dibuat, selesai, siklus, bolak-balik Review, macet', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  assert.equal(m.cards.created, 3);          // c1..c3 (c4 dibuat setelah rentang, c5 sebelum)
  assert.equal(m.cards.done, 2);             // c5 selesai sebelum rentang
  assert.equal(m.cards.cycle.n, 2);
  assert.equal(m.cards.cycle.avgH, 2);       // (1h + 3h) / 2 ... c1 10:10->11:10, c2 10:20->13:20
  assert.equal(m.cards.cycle.medianH, 2);
  assert.equal(m.cards.cycle.maxH, 3);
  assert.equal(m.cards.review.bounces, 1);
  assert.equal(m.cards.review.bouncedCards, 1);
  assert.deepEqual(m.cards.stuck.cards.map(c => c.id), ['c3']);
  assert.equal(m.cards.stuck.cards[0].hours, 4);
  assert.equal(m.series.done.reduce((a, b) => a + b, 0), 2);
  assert.equal(m.series.done[1], 1);         // c1 selesai 11:10 -> jam ke-1 (10:00 = 0)
  assert.equal(m.series.created[0], 3);
});

test('dm: latensi kirim/balas, per penerima, tanya timeout, menunggu sekarang', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  assert.equal(m.dm.total, 4);
  assert.equal(m.dm.tanya, 1); assert.equal(m.dm.balasan, 1);
  assert.equal(m.dm.deliver.n, 3);
  assert.equal(m.dm.deliver.maxSec, 600);
  assert.equal(m.dm.deliver.avgSec, 202);    // (600 + 0 + 5) / 3
  assert.equal(m.dm.reply.n, 1);
  assert.equal(m.dm.reply.avgSec, 1200);
  assert.equal(m.dm.slow1, 1);
  assert.equal(m.dm.askTimeout, 1);
  assert.equal(m.dm.waitingNow.count, 1);
  assert.equal(m.dm.waitingNow.oldestSec, 2400);
  const s = m.dm.perRole.find(x => x.name === 'Sinta');
  assert.equal(s.n, 3); assert.equal(s.waiting, 1); assert.equal(s.deliver.maxSec, 600);
});

test('sesi: kerja, menunggu izin, kompaksi, interrupt, izin ke terminal', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  const b = m.sessions.perRole.find(x => x.name === 'Bayu');
  // aktivitas 10:00..10:05 -> 5 x 60 s + ekor 180 s; 10:30 -> 180 s (kompaksi bukan aktivitas)
  assert.equal(b.workSec + b.waitSec, 5 * 60 + 180 + 180);
  assert.equal(b.waitSec, 70);
  assert.equal(b.compactions, 1);
  assert.equal(m.sessions.interrupts, 1);
  assert.equal(b.spanSec, 4 * 3600);         // sesi s1 dipotong ke rentang
  assert.equal(b.workSec + b.waitSec + b.idleSec, b.spanSec);
  assert.equal(m.sessions.permissions.total, 2);
  assert.equal(m.sessions.permissions.toTerminal, 1);
});

test('biaya: per kartu selesai, per commit, per role; Codex token-only', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  assert.equal(m.cost.total, 12);
  assert.equal(m.cost.perDoneCard, 6);
  assert.equal(m.cost.perCommit, 4);         // 3 commit dalam rentang
  assert.equal(m.cost.perRole.find(x => x.name === 'Bayu').cost, 12);
  assert.equal(m.cost.tokenOnlyTokens, 1000);
  assert.equal(m.cost.perRole.find(x => x.name === 'Sinta').tokenOnlyTokens, 1000);
});

test('git: commit per repo, jenis, revert', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  assert.equal(m.git.total, 3);
  assert.equal(m.git.reverts, 1);
  assert.equal(m.git.kinds.feat, 1); assert.equal(m.git.kinds.fix, 1);
  assert.equal(m.git.perRepo.length, 1);
  assert.deepEqual(m.series.commits, [1, 1, 1, 0]);
  assert.equal(m.series.commits.reduce((a, b) => a + b, 0), 3);
});

test('gesekan: error tool dengan alasan, pengumuman', async () => {
  const m = await M.officeMetrics('shop', Q, { now: NOW });
  assert.equal(m.friction.toolErrors.total, 3);
  const bash = m.friction.toolErrors.byTool.find(x => x.tool === 'Bash');
  assert.equal(bash.n, 2); assert.equal(bash.reasons[0].text, 'exit 1');
  assert.equal(m.friction.toolErrors.byTool.find(x => x.tool === 'card_check').n, 1);
  assert.equal(m.friction.announcements, 1);
});

test('kompleks dan laporan markdown', async () => {
  const c = await M.complexMetrics(Q, { now: NOW });
  const o = c.offices.find(x => x.id === 'shop');
  assert.equal(o.cardsDone, 2); assert.equal(o.commits, 3);
  assert.equal(c.total.cardsDone, 2);
  const md = M.reportMarkdown(await M.officeMetrics('shop', Q, { now: NOW }), 'Toko');
  assert.match(md, /^# Laporan shift Toko/);
  assert.match(md, /2 selesai/);
  assert.match(md, /## DM per penerima/);
  assert.match(md, /Sinta/);
});

test('rentang kosong tidak menghasilkan NaN', async () => {
  const m = await M.officeMetrics('shop', { range: 'custom', from: '2031-01-01', to: '2031-01-02' }, { now: Date.parse('2031-01-03') });
  assert.equal(m.cards.done, 0); assert.equal(m.cards.cycle.avgH, null); assert.equal(m.cost.perCommit, null);
  assert.ok(!JSON.stringify(m).includes('NaN'));
});
