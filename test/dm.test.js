import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-dm-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Developer');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.mkdirSync(path.join(root, 'shop/api'), { recursive: true });
fs.writeFileSync(path.join(root, 'shop/api/go.mod'), 'module api');
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [root], token: 'x', dm: { maxPerPair: 6 } }));

let live, store, dm, ag, bayu, sinta, mgr;
const typed = [];
const ident = (r, sid) => ({ office: 'shop', role: r, by: r.name, sid });
const call = async (r, tool, a) => JSON.parse((await ag.callTool(ident(r), tool, a)).content[0].text);
const session = (sid, role, status = 'idle') => { const s = live.expectSession({ sid, office: 'shop', role: role.id, room: 'api', cwd: path.join(root, 'shop/api'), tmux: 'kc-test-' + sid, slot: 0, title: 't' }); s.status = status; return s; };

before(async () => {
  const offices = await import('../server/offices.js');
  live = await import('../server/live.js');
  store = await import('../server/store.js');
  dm = await import('../server/dm.js');
  ag = await import('../server/agent.js');
  offices.officeForCwd(path.join(root, 'shop/api'));
  bayu = store.createRole('shop', { name: 'Bayu', title: 'Laravel Dev', room: 'api' });
  sinta = store.createRole('shop', { name: 'Sinta', title: 'QA', room: 'api', engine: 'codex' });
  mgr = store.createRole('shop', { name: 'Laras', title: 'Manager', room: 'api', isMgr: true });
  dm.setSender(async (sid, text) => { typed.push({ sid, text }); });
  dm.startDm();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('dm: pesan_ke without a session is stored, then typed in once the recipient is idle', async () => {
  const out = await call(bayu, 'pesan_ke', { ke: 'sinta', teks: 'API pesanan siap diuji' });
  assert.equal(out.status, 'menunggu');
  assert.match(out.pengiriman, /belum shift/);
  assert.equal(typed.length, 0);
  session('s-sinta', sinta, 'working');
  assert.equal(await dm.deliver('shop', sinta.id), 0, 'busy: not typed');
  live.live.get('s-sinta').status = 'idle';
  assert.equal(await dm.deliver('shop', sinta.id), 1);
  assert.match(typed[0].text, /^\[Pesan dari Bayu \(Laravel Dev\) · id m[0-9a-f]+\] API pesanan siap diuji/);
  assert.match(typed[0].text, /balas\(id="m/);
  const row = dm.thread('shop', bayu.id, sinta.id).items[0];
  assert.equal(row.status, 'terkirim');
  // the session received the prompt: read
  live.bus.emit('prompt', { sid: 's-sinta', office: 'shop', prompt: typed[0].text });
  assert.equal(dm.thread('shop', bayu.id, sinta.id).items[0].status, 'dibaca');
});

test('dm: tanya waits for balas and returns the answer', async () => {
  typed.length = 0;
  session('s-bayu', bayu);
  const asking = call(sinta, 'tanya', { ke: 'Bayu', teks: 'Endpoint mana yang berubah?', timeout_detik: 30 });
  await new Promise(r => setTimeout(r, 100));
  const id = /id (m[0-9a-f]+)\]/.exec(typed.find(t => t.sid === 's-bayu').text)[1];
  assert.match(typed.at(-1).text, /^\[Pertanyaan dari Sinta/);
  await assert.rejects(() => call(sinta, 'balas', { id, teks: 'x' }), /bukan ditujukan kepadamu/);
  const r = await call(bayu, 'balas', { id, teks: 'POST /orders' });
  assert.match(r.pengiriman, /sedang menunggu/);
  const got = await asking;
  assert.equal(got.status, 'dibalas');
  assert.equal(got.balasan, 'POST /orders');
  assert.equal(typed.filter(t => t.sid === 's-sinta').length, 0, 'the answer is not typed into the asker');
  // a second reply to the same message is answered kindly with the first one, not an error
  const again = await call(bayu, 'balas', { id, teks: 'lagi' });
  assert.equal(again.sudah_dibalas, true);
  assert.equal(again.balasan_pertama, 'POST /orders');
});

test('dm: tanya times out, a late reply is typed into the asker', async () => {
  typed.length = 0;
  const first = await call(sinta, 'pesan_ke', { ke: 'bayu', teks: 'pancingan' }); // makes a message to answer late
  void first;
  const t0 = Date.now();
  const got = await call(sinta, 'tanya', { ke: 'bayu', teks: 'Kamu di sana?', timeout_detik: 5 });
  assert.equal(got.status, 'belum dibalas');
  assert.ok(Date.now() - t0 >= 4900);
  const id = got.id;
  const r = await call(bayu, 'balas', { id, teks: 'Ya, maaf telat' });
  assert.equal(r.status, 'terkirim');
  assert.match(typed.at(-1).text, /^\[Balasan dari Bayu \(Laravel Dev\) untuk pesanmu m[0-9a-f]+\] Ya, maaf telat/);
  assert.equal(typed.at(-1).sid, 's-sinta');
});

test('dm: busy recipient queues, several messages go in together when idle', async () => {
  typed.length = 0;
  const mg = session('s-mgr', mgr, 'working');
  await call(bayu, 'pesan_ke', { ke: 'laras', teks: 'satu' });
  await call(bayu, 'pesan_ke', { ke: 'laras', teks: 'dua' });
  assert.equal(typed.length, 0);
  mg.status = 'idle';
  live.bus.emit('msg', { t: 'session', office: 'shop', session: live.serialize(mg) });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /satu[\s\S]*dua/);
});

test('dm: pesan_list marks waiting messages as read so they are not typed later', async () => {
  typed.length = 0;
  const mg = live.live.get('s-mgr');
  mg.status = 'working';
  await call(sinta, 'pesan_ke', { ke: 'laras', teks: 'cek PR' });
  const list = await call(mgr, 'pesan_list', { belum_dibaca: true });
  assert.ok(list.some(x => x.isi === 'cek PR' && x.baru));
  mg.status = 'idle';
  assert.equal(await dm.deliver('shop', mgr.id), 0);
});

test('dm: "manager" resolves to the manager role', () => {
  assert.ok(dm.resolveRole('shop', 'Manager').isMgr);
  assert.equal(dm.resolveRole('shop', 'LARAS').id, mgr.id);
});

test('dm: no self messages, unknown roles, empty text, unknown card', async () => {
  await assert.rejects(() => call(bayu, 'pesan_ke', { ke: 'bayu', teks: 'halo' }), /diri sendiri/);
  await assert.rejects(() => call(bayu, 'pesan_ke', { ke: 'budi', teks: 'halo' }), /tidak ada/);
  await assert.rejects(() => call(bayu, 'pesan_ke', { ke: 'sinta', teks: '  ' }), /kosong/);
  await assert.rejects(() => call(bayu, 'pesan_ke', { ke: 'sinta', teks: 'x', kartu: 'zzz' }), /Kartu/);
  await assert.rejects(() => ag.callTool({ office: 'shop', role: null, by: 'x' }, 'pesan_ke', { ke: 'sinta', teks: 'x' }), /tidak terikat/);
});

test('dm: rate limit per pair stops floods but never blocks a reply', async () => {
  const a = store.createRole('shop', { name: 'Ani', title: 'FE', room: 'api' });
  const b = store.createRole('shop', { name: 'Budi', title: 'BE', room: 'api' });
  const first = await call(a, 'pesan_ke', { ke: 'budi', teks: 'p0' });
  for (let i = 1; i < 6; i++) await call(a, 'pesan_ke', { ke: 'budi', teks: 'p' + i });
  await assert.rejects(() => call(b, 'pesan_ke', { ke: 'ani', teks: 'balik' }), /Terlalu banyak pesan/);
  const r = await call(b, 'balas', { id: first.id, teks: 'oke' });
  assert.ok(r.id);
});

test('dm: threads and events', async () => {
  const seen = [];
  const on = m => { if (m.t === 'dm') seen.push(m); };
  live.bus.on('msg', on);
  const c = store.createRole('shop', { name: 'Citra', title: 'Ops', room: 'api' });
  await call(c, 'pesan_ke', { ke: 'laras', teks: 'halo manager' });
  live.bus.off('msg', on);
  assert.equal(seen[0].office, 'shop');
  assert.equal(seen[0].from, c.id);
  assert.equal(seen[0].to, mgr.id);
  const t = dm.threads('shop');
  assert.ok(t.threads.length >= 4);
  assert.equal(dm.threads('shop', { role: c.id }).threads.length, 1);
  assert.ok(dm.thread('shop', c.id, mgr.id).items[0].text === 'halo manager');
  const db = await import('../server/db.js');
  assert.ok(db.all(db.officeDb('shop'), "SELECT * FROM log WHERE kind = 'dm'").length > 3);
});

/* ---------- mid-turn delivery, fyi, siaran, batch, maxPerTurn, tolerance ---------- */
const raw = async (r, tool, a) => (await ag.callTool(ident(r), tool, a)).content;
let dina, eko, fani;
const mk = (name, extra = {}) => store.createRole('shop', { name, title: 'Dev', room: 'api', ...extra });

test('dm: a tool result carries a reminder of waiting messages, and they are not typed again at idle', async () => {
  dina = mk('Dina'); eko = mk('Eko'); fani = mk('Fani');
  typed.length = 0;
  const d = session('s-dina', dina, 'working');
  const sent = await call(eko, 'pesan_ke', { ke: 'dina', teks: 'Tolong cek migrasi orders' });
  assert.match(sent.pengiriman, /pengingat/);
  const q = await call(fani, 'pesan_ke', { ke: 'dina', teks: 'Kolom total itu integer?', kartu: undefined });
  assert.equal(typed.length, 0, 'busy: nothing typed');
  // any kantor tool dina calls brings the reminder along
  const content = await raw(dina, 'roles_list', {});
  assert.equal(content.length, 2);
  assert.match(content[1].text, /^📨 2 pesan menunggu/);
  assert.match(content[1].text, /dari Eko \(pesan, id m[0-9a-f]+/);
  assert.match(content[1].text, /Tolong cek migrasi orders/);
  assert.match(content[1].text, new RegExp(`balas\\(id="${q.id}"`));
  assert.equal(dm.thread('shop', eko.id, dina.id).items[0].status, 'dibaca');
  // shown once: the next tool carries none, and going idle types nothing
  assert.equal((await raw(dina, 'roles_list', {})).length, 1);
  d.status = 'idle';
  assert.equal(await dm.deliver('shop', dina.id), 0);
  assert.equal(typed.length, 0);
  // and it can be answered right away
  const r = await call(dina, 'balas', { id: q.id, teks: 'Ya, integer' });
  assert.ok(r.id);
});

test('dm: the hook context returns the same reminder (PostToolUse / UserPromptSubmit additionalContext)', async () => {
  const d = live.live.get('s-dina'); d.status = 'working';
  await call(eko, 'pesan_ke', { ke: 'dina', teks: 'lewat hook' });
  const out = await live.handleHook({ session_id: 's-dina', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1', cwd: path.join(root, 'shop/api') });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /lewat hook/);
  const none = await live.handleHook({ session_id: 's-dina', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu2', cwd: path.join(root, 'shop/api') });
  assert.equal(none, null);
});

test('dm: fyi does not wake an idle session, rides along with other messages, and cannot be replied to', async () => {
  typed.length = 0;
  const d = live.live.get('s-dina'); d.status = 'idle';
  const f = await call(eko, 'kabari', { ke: 'dina', teks: 'deploy staging selesai' });
  assert.match(f.pengiriman, /tidak membangunkan/);
  assert.equal(await dm.deliver('shop', dina.id), 0, 'fyi alone: not typed');
  assert.equal(typed.length, 0);
  assert.equal(dm.thread('shop', eko.id, dina.id).items.at(-1).kind, 'fyi');
  assert.equal(dm.thread('shop', eko.id, dina.id).items.at(-1).status, 'menunggu');
  await call(fani, 'pesan_ke', { ke: 'dina', teks: 'butuh review' });
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /^📨 2 pesan masuk:/);
  assert.match(typed[0].text, /\[FYI dari Eko[^\]]*\] deploy staging selesai[\s\S]*\[Pesan dari Fani/);
  const fyi = dm.thread('shop', eko.id, dina.id).items.at(-1);
  await assert.rejects(() => call(dina, 'balas', { id: fyi.id, teks: 'ok' }), /FYI/);
  const viaFlag = await call(eko, 'pesan_ke', { ke: 'dina', teks: 'flag fyi', fyi: true });
  assert.equal(dm.thread('shop', eko.id, dina.id).items.find(x => x.id === viaFlag.id).kind, 'fyi');
});

test('dm: a fyi shows up in pesan_list but is not "perlu dibalas"', async () => {
  const d = live.live.get('s-dina'); d.status = 'working';
  await call(eko, 'kabari', { ke: 'dina', teks: 'fyi untuk daftar' });
  const list = await call(dina, 'pesan_list', { belum_dibaca: true });
  const x = list.find(m => m.isi === 'fyi untuk daftar');
  assert.ok(x && x.jenis === 'fyi' && x.baru && !x.perlu_dibalas);
});

test('dm: siaran reaches several roles, "semua" skips yourself, fyi variant', async () => {
  typed.length = 0;
  for (const r of [bayu, sinta, dina]) { const s = live.live.get('s-' + r.id) || session('s-' + r.id, r, 'working'); s.status = 'working'; }
  const out = await call(mgr, 'siaran', { ke: ['bayu', 'Sinta'], teks: 'Rapat kode jam 3' });
  assert.equal(out.terkirim.length, 2);
  assert.ok(out.siaran);
  const all = await call(mgr, 'siaran', { ke: 'semua', teks: 'Freeze merge sampai besok', fyi: true });
  assert.ok(all.terkirim.length >= 5);
  assert.ok(!all.terkirim.some(x => x.ke === 'Laras'));
  assert.equal(dm.thread('shop', mgr.id, bayu.id).items.at(-1).kind, 'fyi');
  assert.equal(dm.thread('shop', mgr.id, bayu.id).items.at(-1).group, all.siaran);
  assert.equal(typed.length, 0, 'busy recipients: nothing typed');
  const n = (await raw(bayu, 'roles_list', {}))[1].text;
  assert.match(n, /Rapat kode jam 3/);
  assert.match(n, /Freeze merge/);
  await assert.rejects(() => call(mgr, 'siaran', { ke: [], teks: 'x' }), /daftar role/);
  await assert.rejects(() => call(mgr, 'siaran', { ke: ['bayu'], teks: ' ' }), /kosong/);
});

test('dm: manager is capped at dm.maxPerTurn outgoing messages per turn; a new prompt resets it', async () => {
  const cfg = await import('../server/config.js');
  const boss = mk('Bos', { isMgr: false });
  boss.isMgr = true; // limit applies to the manager role object the tool receives
  const keys = cfg.config();
  keys.dm.maxPerTurn = 3;
  const m = session('s-boss', boss, 'working');
  live.bus.emit('prompt', { sid: 's-boss', office: 'shop', prompt: 'mulai giliran' });
  await new Promise(r => setTimeout(r, 5));
  for (let i = 0; i < 3; i++) await call(boss, 'kabari', { ke: ['bayu', 'sinta', 'dina'][i], teks: 'info ' + i });
  await assert.rejects(() => call(boss, 'kabari', { ke: 'eko', teks: 'ke empat' }), /batas 3/);
  await call(boss, 'balas', { id: dm.thread('shop', boss.id, boss.id).items?.[0]?.id || 'x', teks: 'y' }).catch(() => {});
  live.bus.emit('prompt', { sid: 's-boss', office: 'shop', prompt: 'giliran baru' });
  await new Promise(r => setTimeout(r, 5));
  await call(boss, 'kabari', { ke: 'eko', teks: 'giliran baru ok' });
  keys.dm.maxPerTurn = 8;
  void m;
});

test('dm: tolerance - empty text gets a hint, wrong balas id lists what waits, double reply returns the first', async () => {
  await assert.rejects(() => call(bayu, 'pesan_ke', { ke: 'sinta', teks: '' }), /satu-dua kalimat/);
  await assert.rejects(() => call(bayu, 'kabari', { ke: 'sinta' }), /kosong/);
  live.live.get('s-dina').status = 'working';
  const q = await call(eko, 'pesan_ke', { ke: 'dina', teks: 'ada waktu?' });
  await assert.rejects(() => call(dina, 'balas', { id: 'm-salah', teks: 'ya' }), new RegExp(`tidak ditemukan[\\s\\S]*${q.id}`));
  await assert.rejects(() => call(eko, 'balas', { id: q.id, teks: 'ya' }), /bukan ditujukan kepadamu/);
  const first = await call(dina, 'balas', { id: q.id, teks: 'ada' });
  const second = await call(dina, 'balas', { id: q.id, teks: 'ada, kok' });
  assert.equal(second.sudah_dibalas, true);
  assert.equal(second.id, first.id);
  assert.equal(second.balasan_pertama, 'ada');
  await assert.rejects(() => call(eko, 'balas', { id: first.id, teks: 'x' }), /sudah berupa balasan/);
});

test('dm: dm.midTurn=false turns the reminder off', async () => {
  const cfg = await import('../server/config.js');
  cfg.config().dm.midTurn = false;
  live.live.get('s-dina').status = 'working';
  const gita = mk('Gita');
  await call(gita, 'pesan_ke', { ke: 'dina', teks: 'tanpa pengingat' });
  assert.equal((await raw(dina, 'roles_list', {})).length, 1);
  cfg.config().dm.midTurn = true;
  assert.equal((await raw(dina, 'roles_list', {})).length, 2, 'it was still waiting');
});
