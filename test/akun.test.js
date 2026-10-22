import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-akun-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));

let akun, audit, actor;
before(async () => {
  akun = await import('../server/akun.js');
  audit = await import('../server/audit.js');
  actor = await import('../server/actor.js');
});
after(() => { akun.closeAkun(); audit.closeAudit(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('totp: RFC 6238 SHA-1 vectors (last 6 digits)', () => {
  const secret = akun.base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(akun.hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(akun.hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(akun.hotp(secret, Math.floor(20000000000 / 30)), '353130');
  const t = 1111111109 * 1000;
  assert.equal(akun.totpMatch(secret, '081804', t), Math.floor(1111111109 / 30));
  assert.equal(akun.totpMatch(secret, '081 804', t + 30e3), Math.floor(1111111109 / 30), 'one step of drift and spaces are fine');
  assert.equal(akun.totpMatch(secret, '081804', t + 90e3), null, 'three steps later it is gone');
  assert.equal(akun.totpMatch(secret, 'abc', t), null);
});

test('password: scrypt round trip and the policy', async () => {
  const h = await akun.hashPassword('kopi hitam tanpa gula');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await akun.checkPassword('kopi hitam tanpa gula', h), true);
  assert.equal(await akun.checkPassword('kopi hitam tanpa gulA', h), false);
  assert.equal(await akun.checkPassword('apa saja', 'bukan-hash'), false);
  assert.ok(akun.passwordProblem('pendek'));
  assert.ok(akun.passwordProblem('budi12345678', 'budi'));
  assert.ok(akun.passwordProblem('aaaaaaaaaaaa'));
  assert.equal(akun.passwordProblem('kalimat yang panjang', 'budi'), null);
});

const code = (secret, ahead = 0) => akun.hotp(secret, akun.totpStep() + ahead);

test('invite → password + 2FA → login; codes are single use; throttling; disable', async () => {
  const { member, invite } = akun.createMember({ username: 'Budi', name: 'Budi Santoso' }, 'Henry');
  assert.equal(member.username, 'budi');
  assert.equal(member.active, false);
  assert.equal(member.invitePending, true);
  assert.throws(() => akun.createMember({ username: 'budi', name: 'Lain' }), /sudah dipakai/);
  assert.throws(() => akun.createMember({ username: 'b' }), /Username/);

  const info = akun.inviteInfo(invite.token);
  assert.equal(info.member.id, member.id);
  assert.match(info.otpauth, /^otpauth:\/\/totp\/Kantor%20Claude:budi\?secret=[A-Z2-7]+/);
  assert.equal(akun.inviteInfo('salah'), null);
  await assert.rejects(akun.acceptInvite(invite.token, { password: 'kalimat yang panjang', code: '000000' }), /Kode 2FA salah/);
  const acc = await akun.acceptInvite(invite.token, { password: 'kalimat yang panjang', code: code(info.secret) });
  assert.equal(acc.member.active, true);
  assert.equal(akun.memberForCookie(acc.cookie).name, 'Budi Santoso');
  assert.equal(akun.inviteInfo(invite.token), null, 'an invite works once');

  // the code used to accept cannot sign in again; the next one can
  await assert.rejects(akun.login({ username: 'budi', password: 'kalimat yang panjang', code: code(info.secret) }), e => e.code === 401);
  const ok = await akun.login({ username: 'BUDI', password: 'kalimat yang panjang', code: code(info.secret, 1), ip: '10.0.0.1' });
  assert.ok(ok.cookie);
  await assert.rejects(akun.login({ username: 'budi', password: 'kalimat yang panjang', code: code(info.secret, 1) }), /salah/, 'replay refused');

  // five misses lock the username, whatever comes next
  akun.resetThrottle();
  for (let i = 0; i < 5; i++) await assert.rejects(akun.login({ username: 'budi', password: 'salah sekali', code: '123456', ip: '10.0.0.2' }), e => e.code === 401);
  await assert.rejects(akun.login({ username: 'budi', password: 'kalimat yang panjang', code: code(info.secret, 1), ip: '10.0.0.3' }), e => e.code === 429);
  akun.resetThrottle();
  await assert.rejects(akun.login({ username: 'tidakada', password: 'x', code: '123456' }), /Username, password, atau kode 2FA salah/, 'same message for an unknown user');

  akun.updateMember(member.id, { disabled: true });
  assert.equal(akun.memberForCookie(ok.cookie), null, 'disabling signs out');
  akun.updateMember(member.id, { disabled: false });
  assert.equal(akun.memberForCookie(ok.cookie), null, 'and the old session stays gone');

  // reset: new invite, old password no longer works
  const r = akun.resetMember(member.id);
  assert.equal(r.member.active, false);
  await assert.rejects(akun.login({ username: 'budi', password: 'kalimat yang panjang', code: code(akun.inviteInfo(r.invite.token).secret) }), e => e.code === 401);
});

test('the last active admin cannot be demoted or disabled', () => {
  const { member } = akun.createMember({ username: 'henry', name: 'Henry', role: 'admin' });
  assert.throws(() => akun.updateMember(member.id, { role: 'anggota' }), /minimal satu admin/);
  assert.throws(() => akun.updateMember(member.id, { disabled: true }), /minimal satu admin/);
  const second = akun.createMember({ username: 'sari', name: 'Sari', role: 'admin' }).member;
  assert.equal(akun.updateMember(member.id, { role: 'anggota' }).role, 'anggota');
  assert.throws(() => akun.updateMember(second.id, { disabled: true }), /minimal satu admin/);
});

test('audit: actor from the request, secrets masked, chain verifies and catches edits', () => {
  const budi = { kind: 'member', id: 'mbudi', name: 'Budi', role: 'anggota', ip: '10.1.1.1' };
  actor.withActor(budi, () => {
    assert.equal(actor.who(), 'Budi');
    assert.equal(actor.isHuman('Budi'), true);
    assert.equal(actor.isHuman('Bayu'), false);
    audit.record('api', { text: 'membuat kartu', office: 'shop', meta: { body: { title: 'x', password: 'rahasia', nested: { totp: '123' } } } });
  });
  assert.equal(actor.who(), 'Kamu', 'outside a request it is the local owner');
  audit.record('api', { text: 'oleh pemilik lokal' });
  audit.record('agen', { as: { kind: 'agent', id: null, name: 'Bayu' }, text: 'card_update' });

  const mine = audit.query({ self: 'mbudi' }).rows;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].actor, 'Budi');
  assert.equal(mine[0].ip, '10.1.1.1');
  assert.equal(mine[0].meta.body.password, '•••');
  assert.equal(mine[0].meta.body.nested.totp, '•••');
  assert.equal(audit.query({ actor: '_lain' }).rows.length >= 2, true);
  assert.equal(audit.query({ q: 'kartu' }).rows.length, 1);
  assert.equal(audit.query({ q: '100%_' }).rows.length, 0, 'LIKE wildcards are literal');
  assert.match(audit.toCsv(mine), /^id,at,actor/);

  assert.equal(audit.verify().ok, true);
  const raw = new DatabaseSync(path.join(process.env.KANTOR_HOME, 'audit.db'));
  assert.throws(() => raw.exec("UPDATE audit SET text = 'diubah' WHERE id = 1"), /tidak boleh diubah/);
  assert.throws(() => raw.exec('DELETE FROM audit WHERE id = 1'), /tidak boleh dihapus/);
  // someone with file access drops the trigger and edits a row: verify points at it
  raw.exec("DROP TRIGGER audit_no_update; UPDATE audit SET text = 'diubah' WHERE id = 1");
  const v = audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  raw.close();
});

test('audit: prompts go to whoever typed in the pane; agent messages carry the human origin', () => {
  const budi = { kind: 'member', id: 'mbudi', name: 'Budi', role: 'anggota' };
  const mgr = { sid: 's-mgr', office: 'shop', role: 'r-mgr', tmux: 'kc-shop-mgr' };
  const be = { sid: 's-be', office: 'shop', role: 'r-be', tmux: 'kc-shop-be' };
  audit.markTyping('kc-shop-mgr', budi);
  const p1 = audit.recordPrompt(mgr, 'bagi tugas fitur riwayat');
  assert.equal(p1.actor, 'Budi');
  assert.equal(p1.actor_id, 'mbudi');
  assert.equal(p1.origin, 'Budi');
  // the manager messages the backend role; its next prompt arrives with nobody typing
  audit.passOrigin('shop', 's-mgr', 'r-be');
  const p2 = audit.recordPrompt(be, '[Pesan dari Laras] kerjakan API riwayat');
  assert.equal(p2.actor, 'Pesan agen');
  assert.equal(p2.origin, 'Budi');
  assert.equal(audit.originOf('s-be'), 'Budi');
  // a prompt nobody typed through the office and no agent sent (e.g. tmux attach over SSH)
  const p3 = audit.recordPrompt({ sid: 's-x', office: 'shop', role: 'r-x', tmux: 'kc-x' }, 'halo');
  assert.equal(p3.actor, 'Tidak diketahui');
  assert.equal(p3.origin, null);
  // a typing mark is used once
  assert.equal(audit.recordPrompt(mgr, 'lagi').actor, 'Tidak diketahui');
});

/* ---------------- the daemon over HTTP, akun mode ---------------- */
const dtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-akun-http-'));
const PORT = 47000 + Math.floor(Math.random() * 1500);
const BASE = `http://127.0.0.1:${PORT}`;
let daemon;
const req = (p, { method = 'GET', headers = {}, body, cookie } = {}) => fetch(BASE + p, {
  method, redirect: 'manual',
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const sys = (p, opts = {}) => req(p, { ...opts, headers: { Authorization: 'Bearer tok', ...(opts.headers || {}) } });
const form = o => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];

before(async () => {
  const home = path.join(dtmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [dtmp], token: 'tok', port: PORT, akun: { enabled: true, names: ['kantor.test'] }, sysmon: { enabled: false } }));
  daemon = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; daemon.stderr.on('data', d => { err += d; });
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/masuk'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('daemon tidak jalan: ' + err);
});
after(() => { daemon?.kill(); fs.rmSync(dtmp, { recursive: true, force: true }); });

test('http: sign-in flow, roles, origin check, audit visibility', async () => {
  // not signed in: pages go to /masuk, the API says 401, the old ?token= login is gone
  assert.equal((await req('/')).headers.get('location'), '/masuk');
  assert.equal((await req('/api/state')).status, 401);
  assert.equal((await req('/?token=tok')).headers.get('location'), '/masuk');
  assert.equal((await req('/', { cookie: 'kc_token=tok' })).status, 302, 'the single-user cookie means nothing here');
  const login = await req('/masuk');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-security-policy'), /default-src 'none'/);

  // the config token: only from loopback, never through a proxy, and never for the browser routes of members
  assert.equal((await sys('/api/state')).status, 200);
  assert.equal((await sys('/api/state', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 401);
  assert.equal((await req('/api/state', { headers: { Host: 'evil.test' } })).status, 401);

  // an admin (from the CLI) invites Budi
  const inv = await (await sys('/api/akun/anggota', { method: 'POST', body: { username: 'budi', name: 'Budi', role: 'anggota' } })).json();
  assert.match(inv.link, /^https:\/\/kantor\.test\/undangan\?k=/, 'links point at the public name');
  const k = new URL(inv.link).searchParams.get('k');
  const page = await (await req('/undangan?k=' + encodeURIComponent(k))).text();
  const secret = /class="secret"[^>]*>([^<]+)</.exec(page)[1].replace(/\s/g, '');
  assert.match(page, /<svg/);

  assert.equal((await req('/undangan', { method: 'POST', headers: { ...FORM, Origin: 'http://evil.test' }, body: form({ k, password: 'kalimat yang panjang', password2: 'kalimat yang panjang', code: code(secret) }) })).status, 403, 'cross-site form refused');
  assert.equal((await req('/undangan', { method: 'POST', headers: FORM, body: form({ k, password: 'kalimat yang panjang', password2: 'beda sekali ya', code: code(secret) }) })).status, 400);
  const accepted = await req('/undangan', { method: 'POST', headers: FORM, body: form({ k, password: 'kalimat yang panjang', password2: 'kalimat yang panjang', code: code(secret) }) });
  assert.equal(accepted.status, 303);
  assert.match(accepted.headers.get('set-cookie'), /^kc_sesi=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
  let budi = cookieFrom(accepted);

  const me = await (await req('/api/state', { cookie: budi })).json();
  assert.deepEqual([me.akun, me.me.name, me.me.role], [true, 'Budi', 'anggota']);

  // members work, admins administer, only the daemon's own clients call the agent API
  assert.equal((await req('/api/music/playlists', { method: 'POST', cookie: budi, headers: { Origin: BASE }, body: { name: 'Fokus' } })).status, 200);
  assert.equal((await req('/api/settings', { method: 'POST', cookie: budi, headers: { Origin: BASE }, body: {} })).status, 403);
  assert.equal((await req('/api/akun/anggota', { cookie: budi })).status, 403);
  assert.equal((await req('/api/agent/call', { method: 'POST', cookie: budi, headers: { Origin: BASE }, body: { tool: 'notes_list' } })).status, 403);
  assert.equal((await req('/api/music/playlists', { method: 'POST', cookie: budi, headers: { Origin: 'http://evil.test' }, body: { name: 'X' } })).status, 403, 'cross-site API call refused');

  // a wrong sign-in is logged too
  assert.equal((await req('/masuk', { method: 'POST', headers: FORM, body: form({ username: 'budi', password: 'salah sekali', code: '123456' }) })).status, 401);
  const again = await req('/masuk', { method: 'POST', headers: FORM, body: form({ username: 'budi', password: 'kalimat yang panjang', code: code(secret, 1) }) });
  assert.equal(again.status, 303);

  // Budi sees only Budi; the admin token sees everyone and a verified chain
  const own = await (await req('/api/audit', { cookie: budi })).json();
  assert.ok(own.rows.length >= 3);
  assert.ok(own.rows.every(r => r.actor_id === me.me.id), 'only own rows');
  assert.ok(own.rows.some(r => r.text === 'POST /api/music/playlists'));
  assert.ok(own.rows.some(r => /settings/.test(r.text)) === false, 'refused requests never reached a handler, so they are not audit rows');
  const everyone = await (await sys('/api/audit?limit=200')).json();
  assert.ok(everyone.rows.some(r => r.kind === 'masuk-gagal' && r.actor === 'budi'));
  assert.ok(everyone.rows.some(r => r.text === 'membuat akun budi (anggota)' && r.actor === 'Sistem'));
  const csv = await sys('/api/audit.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /mengaktifkan akun dari undangan/);
  assert.equal((await (await sys('/api/audit/verify')).json()).ok, true);

  // sign out ends that session
  budi = cookieFrom(again);
  assert.equal((await req('/keluar', { method: 'POST', cookie: budi, headers: { Origin: BASE } })).headers.get('location'), '/masuk');
  assert.equal((await req('/api/state', { cookie: budi })).status, 401);
});
