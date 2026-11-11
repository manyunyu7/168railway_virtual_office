// Terminal web dan poller untuk sesi di mesin lain (docs/MULTI-PC.md): attach lewat ssh, mesin offline dilewati,
// poller tidak menahan event loop, dan tty/berkas Mac lain tidak pernah disentuh di Mac ini.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-term-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
process.env.TMUX_TMPDIR = tmp; // server tmux sendiri, terpisah dari tmux pengguna (lokal maupun transport local:)
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));

const mx = await import('../server/machines.js');
const ta = await import('../server/termapp.js');
const ld = await import('../server/laporan-draft.js');
const lv = await import('../server/live.js');
const { startHookContext } = await import('../server/hookctx.js');

const M = mx.addMachine({ name: 'Mac Dua', ssh: 'local:', hubUrl: 'http://hub.local:4317' }).id;
const FAR = mx.addMachine({ name: 'Mac Jauh', ssh: 'henry@mac-jauh.example', hubUrl: 'http://hub.local:4317' }).id;
const goOffline = id => { try { mx.shSync(id, 'exit 255'); } catch {} }; // ssh gagal (255) → offline
const goOnline = id => mx.shSync(id, 'true');
const sh = (...a) => mx.execSync(M, 'tmux', a);
const made = [];
after(() => { for (const n of made) try { sh('kill-session', '-t', n); } catch {} try { sh('kill-server'); } catch {} });

test('attachArgs: lokal tetap tmux attach-session apa adanya', () => {
  const r = ta.attachArgs('kc-o-fe', '/opt/homebrew/bin/tmux');
  assert.deepEqual(r, { file: '/opt/homebrew/bin/tmux', args: ['attach-session', '-t', 'kc-o-fe'], machine: null });
});

test('attachArgs: sesi remote menempel lewat transport mesinnya', () => {
  mx.setTmuxMachine('kc-o-be', M);
  goOnline(M);
  const r = ta.attachArgs('kc-o-be', '/lokal/tmux');
  assert.equal(r.machine, M);
  assert.equal(r.file, '/bin/sh', 'transport local: lewat /bin/sh');
  assert.match(r.args.at(-1), /tmux' '-u' 'attach-session' '-t' 'kc-o-be'$/);
  assert.ok(!r.args.join(' ').includes('/lokal/tmux'), 'bin lokal tidak dipakai untuk mesin lain');
});

test('spawnArgs ssh: -t dan perintah dikutip di akhir', () => {
  const r = mx.spawnArgs(FAR, 'tmux', ['-u', 'attach-session', '-t', "kc-x'y"]);
  assert.equal(r.file, 'ssh');
  assert.equal(r.args[0], '-t');
  assert.equal(r.args.at(-2), '--');
  assert.ok(r.args.includes('henry@mac-jauh.example'));
  assert.equal(r.args.at(-1), `'tmux' '-u' 'attach-session' '-t' 'kc-x'\\''y'`);
});

test('attachArgs: mesin offline → pesan jelas, tanpa ssh', () => {
  mx.setTmuxMachine('kc-o-off', M);
  goOffline(M);
  try {
    assert.ok(mx.isOffline(M));
    assert.throws(() => ta.attachArgs('kc-o-off', '/lokal/tmux'), /Mesin Mac Dua sedang offline/);
  } finally { goOnline(M); }
});

test('termapp tidak pernah mengetik atau mencari pid untuk tty mesin lain', async () => {
  // /dev/ttys000 ada di Mac ini juga: justru itu bahayanya
  await assert.rejects(ta.typeInto('/dev/ttys000', 'halo', { machine: M }), /mesin lain/);
  assert.equal(ta.claudePid('/dev/ttys000', { machine: M }), null);
  assert.equal(ta.claudePid(null), null);
});

const DRAFT = 'Claude drafted: Tombol simpan tidak jalan\\n1 to review · 2 to send · 0 to dismiss\\n';
function draftPane(name) {
  mx.setTmuxMachine(name, M);
  sh('new-session', '-d', '-s', name, '-x', '120', '-y', '30', `printf '${DRAFT}'; sleep 120`);
  made.push(name);
  for (let i = 0; i < 50 && !/to dismiss/.test(sh('capture-pane', '-p', '-t', name)); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
}

test('laporan-draft: pane remote dibaca async, mesin offline dilewati', async () => {
  goOnline(M);
  const name = 'kcterm-draft';
  draftPane(name);
  const s = lv.expectSession({ sid: 'term-remote-1', office: null, role: null, room: null, cwd: tmp, tmux: name, machine: M });
  s.status = 'idle';
  assert.equal(await ld.checkRemote(s), true);
  assert.deepEqual(s.draftState, { title: 'Tombol simpan tidak jalan', siap: true });

  // event loop tetap jalan selama satu putaran poller (capture lewat proses anak, bukan execFileSync)
  s.draftState = null;
  let beats = 0;
  const iv = setInterval(() => beats++, 1);
  await ld.tick();
  clearInterval(iv);
  assert.ok(s.draftState?.siap, 'tick membaca pane remote');
  assert.ok(beats > 0, 'timer lain sempat jalan selama tick');

  // offline: tidak dibaca sama sekali, status lama dibiarkan
  s.draftState = null;
  goOffline(M);
  try {
    await ld.tick();
    assert.equal(s.draftState, null);
    assert.equal(await ld.checkRemote(s), false);
    await assert.rejects(ld.decideDraft(s.sid, 'kirim'), /Mesin Mac Dua sedang offline/);
  } finally { goOnline(M); lv.live.delete(s.sid); }
});

test('hookctx: pengingat gambar berulang hanya untuk sesi lokal', async () => {
  startHookContext();
  const img = path.join(tmp, 'layar.png');
  fs.writeFileSync(img, 'png palsu');
  const read = sid => lv.handleHook({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: img }, cwd: tmp });
  const mk = (sid, machine) => { const s = lv.expectSession({ sid, office: 'o-term', role: null, room: null, cwd: tmp, tmux: null, machine }); s.status = 'working'; s.startedAt = new Date(0).toISOString(); return s; };
  mk('term-loc-a', null); mk('term-loc-b', null); mk('term-rem-a', M); mk('term-rem-b', M);
  try {
    // remote dulu: walau path-nya ada di Mac ini, itu bukan file yang dilihat agen di Mac lain
    assert.equal(await read('term-rem-a'), null);
    assert.equal(await read('term-rem-b'), null);
    assert.equal(await read('term-loc-a'), null, 'bacaan pertama tidak diingatkan');
    const r = await read('term-loc-b');
    assert.match(r?.hookSpecificOutput?.additionalContext || '', /Gambar layar\.png dengan isi persis sama/, 'sesi lokal tetap diingatkan');
  } finally { for (const sid of ['term-loc-a', 'term-loc-b', 'term-rem-a', 'term-rem-b']) lv.live.delete(sid); }
});

test('modeq: mesin offline tidak memanggil apply; remote online menunggu layar async dulu', async () => {
  const mq = await import('../server/modeq.js');
  const name = 'kcterm-modeq';
  mx.setTmuxMachine(name, M);
  const s = { sid: 'term-mq-1', office: null, status: 'idle', tmux: name, machine: M, engine: 'claude' };
  lv.live.set(s.sid, s);
  const logs = [];
  try {
    // offline: tidak ada apply maupun probe sampai waktunya habis
    goOffline(M);
    let applied = 0, probed = 0;
    const offline = await new Promise(res => mq.queueMode(s, 'plan', { label: 'x', pollMs: 5, waitMs: 60, log: (o, w, t) => logs.push(t), done: ok => res(ok),
      apply: async () => { applied++; return { mode: 'plan' }; }, probe: async () => { probed++; return 'default'; } }));
    assert.equal(offline, false);
    assert.equal(applied + probed, 0);
    assert.match(logs.at(-1), /mesin Mac Dua offline/);

    // online: selama layar masih dialog (probe null) apply tidak dipanggil; begitu kotak input kembali, apply sekali
    goOnline(M);
    applied = 0; probed = 0;
    const ok = await new Promise(res => mq.queueMode(s, 'plan', { label: 'x', pollMs: 5, waitMs: 5000, log: (o, w, t) => logs.push(t), done: v => res(v),
      apply: async () => { applied++; return { mode: 'plan' }; }, probe: async () => (++probed < 4 ? null : 'default') }));
    assert.equal(ok, true);
    assert.equal(probed, 4);
    assert.equal(applied, 1, 'setPermMode (ssh sinkron) hanya sekali, saat dialog sudah hilang');

    // sesi lokal: tanpa probe, persis seperti sebelumnya
    const loc = { sid: 'term-mq-2', office: null, status: 'idle', tmux: 'kc-lokal-mq', engine: 'claude' };
    lv.live.set(loc.sid, loc);
    probed = 0;
    let calls = 0;
    const lok = await new Promise(res => mq.queueMode(loc, 'plan', { label: 'y', pollMs: 5, waitMs: 5000, log: () => {}, done: v => res(v),
      apply: async () => { if (++calls < 3) throw new Error('Sesi ini sedang menampilkan dialog'); return { mode: 'plan' }; }, probe: async () => { probed++; return null; } }));
    assert.equal(lok, true);
    assert.equal(calls, 3);
    assert.equal(probed, 0);
    lv.live.delete(loc.sid);

    // antrean baru untuk sesi yang sama menggantikan yang lama (satu loop saja)
    let first = 0;
    mq.queueMode(s, 'plan', { label: 'x', pollMs: 5, waitMs: 5000, log: () => {}, apply: async () => { first++; return { mode: 'plan' }; }, probe: async () => null });
    const second = await new Promise(res => mq.queueMode(s, 'plan', { label: 'x', pollMs: 5, waitMs: 5000, log: () => {}, done: v => res(v), apply: async () => ({ mode: 'plan' }), probe: async () => 'default' }));
    assert.equal(second, true);
    assert.equal(first, 0);
    assert.equal(mq.pendingMode(s.sid), null);
  } finally { goOnline(M); lv.live.delete(s.sid); }
});
