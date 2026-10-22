import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-aturan-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'shop/api'), { recursive: true });
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x' }));
const cwd = path.join(root, 'shop/api');

let live, store, ag, tmuxMod, locks, repeat, bayu, sinta, mgr;
const ident = (r, sid) => ({ office: 'shop', role: r, by: r.name, sid });
const call = async (r, sid, tool, a) => JSON.parse((await ag.callTool(ident(r, sid), tool, a)).content[0].text);
const session = (sid, role, status = 'idle') => live.expectSession({ sid, office: 'shop', role: role.id, room: 'api', cwd, tmux: 'kc-test-' + sid, slot: 0, title: role.name });
const hook = (sid, ev, extra = {}) => live.handleHook({ session_id: sid, hook_event_name: ev, cwd, ...extra });
const ctx = r => r?.hookSpecificOutput?.additionalContext || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  const offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  ag = await import('../server/agent.js');
  tmuxMod = await import('../server/tmux.js');
  locks = await import('../server/locks.js');
  repeat = await import('../server/repeat.js');
  const hc = await import('../server/hookctx.js');
  hc.startHookContext();
  offices.officeForCwd(cwd);
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Laravel Dev', room: 'api' });
  sinta = store.createRole('shop', { name: 'Sinta', title: 'QA', room: 'api' });
  mgr = store.createRole('shop', { name: 'Laras', title: 'Manager', room: 'api', isMgr: true });
  session('s-bayu', bayu); session('s-sinta', sinta); session('s-laras', mgr);
});
after(() => { locks.resetLocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('aturan: only the manager sets rules; version bumps; base version guards; prompt carries them', async () => {
  await assert.rejects(call(bayu, 's-bayu', 'aturan_set', { kategori: 'commit', isi: 'x' }), /Hanya manager/);
  let r = await call(mgr, 's-laras', 'aturan_set', { kategori: 'commit', isi: 'Satu commit per kartu, pakai kunci git-commit.', alasan: 'index git bersama' });
  assert.equal(r.versi, 1);
  r = await call(mgr, 's-laras', 'aturan_set', { kategori: 'jendela-beku', isi: 'Beku 22.00-06.00 WIB' });
  assert.equal(r.versi, 2);
  await assert.rejects(call(mgr, 's-laras', 'aturan_set', { kategori: 'e2e', isi: 'x', versi_dasar: 1 }), /sudah berubah/);
  await assert.rejects(call(mgr, 's-laras', 'aturan_set', { kategori: 'tidak-ada', isi: 'x' }), /tidak dikenal/);
  const list = await call(bayu, 's-bayu', 'aturan_list', { riwayat: true });
  assert.equal(list.versi, 2);
  assert.equal(list.kategori.find(k => k.id === 'commit').isi.startsWith('Satu commit'), true);
  assert.equal(list.kategori.find(k => k.id === 'e2e').isi, '');
  assert.equal(list.riwayat.length, 2);
  const prompt = tmuxMod.rolePrompt('shop', bayu);
  assert.match(prompt, /Aturan kantor terstruktur \(versi 2\)/);
  assert.match(prompt, /### Commit\nSatu commit per kartu/);
  // same text again: no new version
  assert.equal((await call(mgr, 's-laras', 'aturan_set', { kategori: 'commit', isi: 'Satu commit per kartu, pakai kunci git-commit.' })).berubah, false);
});

test('aturan: running sessions hear about a change exactly once, the author does not', async () => {
  await hook('s-bayu', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a1' }); // drain notices from the earlier changes
  await hook('s-sinta', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a2' });
  const r = await call(mgr, 's-laras', 'aturan_set', { kategori: 'e2e', isi: 'Suite penuh hanya setelah kunci e2e.', alasan: 'DB bersama' });
  assert.equal(r.diberitahu, 2, 'bayu and sinta, not the author');
  const first = await hook('s-bayu', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b1' });
  assert.match(ctx(first), /Aturan Kantor berubah \(versi 3\).*Tes e2e: Suite penuh/s);
  assert.match(ctx(first), /Alasan: DB bersama/);
  const second = await hook('s-bayu', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b2' });
  assert.equal(ctx(second), '', 'only once');
  // idle session: it arrives with the next prompt
  const p = await hook('s-sinta', 'UserPromptSubmit', { prompt: 'halo' });
  assert.match(ctx(p), /Aturan Kantor berubah/);
  assert.equal(ctx(await hook('s-laras', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'c1' })), '');
  // two changes to the same category before delivery collapse into the latest
  await call(mgr, 's-laras', 'aturan_set', { kategori: 'migrasi', isi: 'v1' });
  await call(mgr, 's-laras', 'aturan_set', { kategori: 'migrasi', isi: 'v2' });
  const c = ctx(await hook('s-bayu', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b3' }));
  assert.match(c, /Migrasi database: v2/);
  assert.doesNotMatch(c, /Migrasi database: v1/);
  // removing
  assert.match((await call(mgr, 's-laras', 'aturan_set', { kategori: 'migrasi', isi: '' })).kategori, /migrasi/);
  assert.equal((await call(bayu, 's-bayu', 'aturan_list')).kategori.find(k => k.id === 'migrasi').isi, '');
});

test('kunci: free lock is granted, the second waits in line and gets it after release', async () => {
  locks.resetLocks();
  const a = await call(bayu, 's-bayu', 'kunci_ambil', { nama: 'E2E', alasan: 'suite penuh', maks_menit: 5 });
  assert.equal(a.status, 'didapat');
  assert.equal(a.nama, 'e2e');
  assert.equal((await call(bayu, 's-bayu', 'kunci_ambil', { nama: 'e2e', alasan: 'lagi' })).status, 'dipegang', 're-entrant');
  const waiting = call(sinta, 's-sinta', 'kunci_ambil', { nama: 'e2e', alasan: 'tes cepat', tunggu_menit: 1 });
  await sleep(50);
  let l = (await call(sinta, 's-sinta', 'kunci_list')).kunci;
  assert.equal(l.length, 1);
  assert.equal(l[0].pemegang.nama, 'Bayu');
  assert.deepEqual(l[0].antrean.map(q => q.nama), ['Sinta']);
  await assert.rejects(call(sinta, 's-sinta', 'kunci_lepas', { nama: 'e2e' }), /dipegang Bayu/);
  await assert.rejects(call(sinta, 's-sinta', 'kunci_ambil', { nama: 'e2e', alasan: 'dobel' }), /sudah antre/);
  assert.equal((await call(bayu, 's-bayu', 'kunci_lepas', { nama: 'e2e' })).berikutnya, 'Sinta');
  const got = await waiting;
  assert.equal(got.status, 'didapat');
  assert.equal(got.pemegang.nama, 'Sinta');
  assert.ok(got.menunggu_detik >= 0);
  assert.equal((await call(sinta, 's-sinta', 'kunci_lepas', { nama: 'e2e' })).status, 'dilepas');
  assert.deepEqual((await call(sinta, 's-sinta', 'kunci_list')).kunci, []);
});

test('kunci: order is FIFO, tunggu_menit 0 does not queue, waiting times out, a manager can force', async () => {
  locks.resetLocks();
  await call(bayu, 's-bayu', 'kunci_ambil', { nama: 'git-commit', alasan: 'commit' });
  assert.equal((await call(sinta, 's-sinta', 'kunci_ambil', { nama: 'git-commit', alasan: 'x', tunggu_menit: 0 })).status, 'belum');
  assert.equal((await call(bayu, 's-bayu', 'kunci_list')).kunci[0].antrean.length, 0);
  const t = await call(sinta, 's-sinta', 'kunci_ambil', { nama: 'git-commit', alasan: 'x', tunggu_menit: 0.01 });
  assert.equal(t.status, 'belum');
  assert.match(t.catatan, /keluar dari antrean/);
  assert.equal((await call(bayu, 's-bayu', 'kunci_list')).kunci[0].antrean.length, 0);
  const order = [];
  const w1 = call(sinta, 's-sinta', 'kunci_ambil', { nama: 'git-commit', alasan: 'satu', tunggu_menit: 1 }).then(r => order.push(['sinta', r.status]));
  await sleep(20);
  const w2 = call(mgr, 's-laras', 'kunci_ambil', { nama: 'git-commit', alasan: 'dua', tunggu_menit: 1 }).then(r => order.push(['laras', r.status]));
  await sleep(20);
  await assert.rejects(call(sinta, 's-sinta', 'kunci_lepas', { nama: 'git-commit', paksa: true }), /dipegang Bayu/, 'non-manager cannot force');
  await call(mgr, 's-laras', 'kunci_lepas', { nama: 'git-commit', paksa: true }).catch(() => {}); // laras is queued, not holder: forced release by manager frees Bayu's lock
  await w1;
  assert.deepEqual(order, [['sinta', 'didapat']]);
  await call(sinta, 's-sinta', 'kunci_lepas', { nama: 'git-commit' });
  await w2;
  assert.deepEqual(order[1], ['laras', 'didapat']);
  await call(mgr, 's-laras', 'kunci_lepas', { nama: 'git-commit' });
});

test('kunci: released on timeout and when the holder session ends; the line moves on', async () => {
  locks.resetLocks();
  await call(bayu, 's-bayu', 'kunci_ambil', { nama: 'migrasi-db', alasan: 'migrasi', maks_menit: 0.02 });
  const t0 = Date.now();
  const next = await call(sinta, 's-sinta', 'kunci_ambil', { nama: 'migrasi-db', alasan: 'giliranku', tunggu_menit: 1 });
  assert.equal(next.status, 'didapat');
  assert.ok(Date.now() - t0 < 5000);
  // the holder is told once that its lock ran out
  assert.match(ctx(await hook('s-bayu', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'k1' })), /Kunci "migrasi-db".*dilepas otomatis/);
  // Sinta's session ends: Laras (waiting) gets it
  const waiting = call(mgr, 's-laras', 'kunci_ambil', { nama: 'migrasi-db', alasan: 'aku', tunggu_menit: 1 });
  await sleep(30);
  await hook('s-sinta', 'SessionEnd', { reason: 'other' });
  const got = await waiting;
  assert.equal(got.status, 'didapat');
  assert.equal(got.pemegang.nama, 'Laras');
  // a waiting session that ends leaves the line
  session('s-sinta', sinta);
  const w = call(sinta, 's-sinta', 'kunci_ambil', { nama: 'migrasi-db', alasan: 'antre', tunggu_menit: 1 });
  await sleep(30);
  await hook('s-sinta', 'SessionEnd', { reason: 'other' });
  assert.equal((await w).status, 'sesi-berakhir');
  assert.equal((await call(mgr, 's-laras', 'kunci_list')).kunci[0].antrean.length, 0);
  await call(mgr, 's-laras', 'kunci_lepas', { nama: 'migrasi-db' });
  await assert.rejects(call(mgr, 's-laras', 'kunci_ambil', { nama: 'Nama Salah!', alasan: 'x' }), /tidak valid/);
  await assert.rejects(call(mgr, 's-laras', 'kunci_ambil', { nama: 'ok', alasan: ' ' }), /alasan/);
});

test('ulang: the same unchanged image is flagged, a changed one is not; never blocks', async () => {
  repeat.resetRepeat();
  session('s-bayu', bayu);
  const img = path.join(cwd, 'test-failed-1.png');
  fs.writeFileSync(img, Buffer.from('fake-png-1'));
  const read = (sid, id) => hook(sid, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: img }, tool_use_id: id });
  assert.equal(ctx(await read('s-bayu', 'r1')), '', 'first look is free');
  const again = await read('s-bayu', 'r2');
  assert.match(ctx(again), /\[Pengingat Kantor\] Gambar test-failed-1\.png sudah kamu baca .*ke-2 kalinya/);
  assert.equal(again.hookSpecificOutput.permissionDecision, undefined, 'no permission decision: only a warning');
  assert.match(ctx(await read('s-bayu', 'r3')), /ke-3 kalinya/);
  // somebody else reads the same picture
  assert.match(ctx(await read('s-sinta', 'r4')), /sudah dilihat Bayu pukul/);
  // new content: new picture
  fs.writeFileSync(img, Buffer.from('fake-png-2-different'));
  assert.equal(ctx(await read('s-bayu', 'r5')), '');
  // other files are untouched
  assert.equal(ctx(await hook('s-bayu', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'go.mod') }, tool_use_id: 'r6' })), '');
});

test('ulang: the summary comes from what the assistant wrote after the first look', async () => {
  repeat.resetRepeat();
  const img = path.join(cwd, 'shot.png');
  fs.writeFileSync(img, Buffer.from('shot-1'));
  const tr = path.join(tmp, 't.jsonl');
  fs.writeFileSync(tr, [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: 'img' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Tombol Simpan tertutup banner cookie di layar checkout.' }] } },
  ].map(x => JSON.stringify(x)).join('\n'));
  live.live.get('s-bayu').transcript = tr;
  await hook('s-bayu', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: img }, tool_use_id: 'toolu_img' });
  assert.match(ctx(await hook('s-bayu', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: img }, tool_use_id: 'x2' })), /Tombol Simpan tertutup banner cookie/);
});

test('ulang: tsc / tests with no file change are flagged; a change or another command is not', async () => {
  repeat.resetRepeat();
  const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T'); git('add', '-A'); git('commit', '-m', 'init');
  const bash = (sid, command, id) => hook(sid, 'PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  const done = (sid, command, id, ev = 'PostToolUse') => hook(sid, ev, { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  assert.equal(repeat.isCheckCommand('npx tsc --noEmit 2>&1 | tail -20'), true);
  assert.equal(repeat.isCheckCommand('npm run dev'), false);
  assert.equal(repeat.isCheckCommand('npm test -- --watch'), false);
  assert.equal(repeat.isCheckCommand('ls -la'), false);
  assert.equal(ctx(await bash('s-bayu', 'npx tsc --noEmit 2>&1 | tail -20', 't1')), '');
  await done('s-bayu', 'npx tsc --noEmit 2>&1 | tail -20', 't1', 'PostToolUseFailure');
  const warn = ctx(await bash('s-bayu', 'npx tsc --noEmit | head -5', 't2'));
  assert.match(warn, /sudah dijalankan kamu pukul .*hasil terakhir: gagal.*tidak ada file yang berubah/);
  await done('s-bayu', 'npx tsc --noEmit | head -5', 't2');
  assert.match(ctx(await bash('s-sinta', 'npx tsc --noEmit', 't3')), /sudah dijalankan Bayu/);
  fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const a = 1;\n');
  assert.equal(ctx(await bash('s-bayu', 'npx tsc --noEmit', 't4')), '', 'a file changed');
  await done('s-bayu', 'npx tsc --noEmit', 't4');
  assert.match(ctx(await bash('s-bayu', 'npx tsc --noEmit', 't5')), /hasil terakhir: lulus/);
  fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const a = 2;\n'); // same status line, different content
  assert.equal(ctx(await bash('s-bayu', 'npx tsc --noEmit', 't6')), '', 'edit of an already-modified file counts');
  assert.equal(ctx(await bash('s-bayu', 'ls -la', 't7')), '');
});
