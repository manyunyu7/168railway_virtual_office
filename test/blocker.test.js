// Layar yang menahan agen (server/blocker-screen.js): pembaca layar, validasi callback login, aksi → tombol tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-blocker-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const { parseBlocker, parseRows, joinedUrl, checkCallback, checkCode, runAction, sameBlocker, wantsScan, ACTIONS } = await import('../server/blocker-screen.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-17T10:00:00Z');
const P = (t, o = {}) => parseBlocker(t, { engine: 'codex', who: 'Viodex', now: NOW, ...o });

// Codex v0.163 (contoh nyata dari tmux)
const CODEX_MENU = `  >_ OpenAI Codex (v0.163.0)

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Team, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use

  Press enter to continue
`;
// Codex v0.167 (capture-pane di Mac mini, CODEX_HOME kosong)
const CODEX_MENU_167 = `  Welcome to Codex, OpenAI's command-line coding agent

  Choose how you want to use Codex.

  1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

> 2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Sign in another way
     Use an API key or another provider

  Press enter to continue
`;
const STATE = 'Zm9vYmFyU3RhdGVfMTIzNDU2Nzg5MA';
const AUTH = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access&code_challenge=Q0hBTExFTkdFX0FCQ0RFRkdISUpLTE1OT1BRUlNU&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=${STATE}&originator=codex_cli_rs`;
const wrap = (s, w) => s.match(new RegExp(`.{1,${w}}`, 'g')).map(x => '  ' + x).join('\n');
const CODEX_BROWSER = `  >_ OpenAI Codex (v0.163.0)

> Finish signing in via your browser

  If the link doesn't open automatically, press c to copy it:

${wrap(AUTH, 96)}

  On a remote or headless machine? Press esc and choose Sign in with Device Code.

  Press Esc to cancel
`;
const CODEX_DEVICE = `  Welcome to Codex, OpenAI's command-line coding agent

  Finish signing in via your browser

  1. Open this link in your browser and sign in

  https://auth.openai.com/codex/device

  2. Enter this one-time code after you are signed in (expires in 15 minutes)

  M4MP-5D75U

  Continue only if you started this login in Codex. If a website or another person gave you this
code, cancel.

  Press esc to cancel
`;
const CODEX_DONE = `  >_ OpenAI Codex (v0.163.0)

✓ Signed in with your ChatGPT account

  Before you start:
  Decide how much autonomy you want to grant Codex

  Press enter to continue
`;
const CODEX_TRUST = `> You are running Codex in /Users/henry/Developer/envi-ops

  Since this folder is version controlled, you may wish to allow Codex to work in this folder without asking for approval.

> 1. Yes, allow Codex to work in this folder without asking for approval
  2. No, ask me to approve edits and commands

  Press enter to continue
`;
const CODEX_TRUST_NEW = `  Do you trust the files in this folder?
  ~/Developer/envi-ops/deliverables

> 1. Yes, continue
  2. No, quit

  Press enter to continue
`;
const CODEX_IDLE = `• Siap, Viodex aktif. Pesan tes diterima. Press enter to continue
  Worked for 4s • 03:57
› Ask Codex to do anything
  GPT-6.1-Sol medium · ~/Developer/envi-ops/deliverables · Uji
  ? for shortcuts                     ⚠ 4 warnings · f2 to view
`;
// Claude Code v2.1 (capture-pane di Mac mini, CLAUDE_CONFIG_DIR kosong), URL terpotong di lebar 100
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=rxl_iomfV2Vqzc-r10Ofsn0LqwSAi5YNn2vxGilJUpE&code_challenge_method=S256&state=TGDBIg9pz2B5et4HJxKRju0oLhlJypn5ZFYSBBXxM6M';
const CLAUDE_LOGIN = ` Browser didn't open? Use the url below to sign in (c to copy)

${CLAUDE_URL.match(/.{1,100}/g).join('\n')}

 Paste code here if prompted >
`;
const CLAUDE_MENU = ` Claude Code can be used with your Claude subscription or billed based on API usage through your
 Console account.

 Select login method:

 ❯ 1. Claude account with subscription · Individual, Team, or Enterprise

   2. Anthropic Console account · API usage billing

   3. 3rd-party platform · Bedrock, Microsoft Foundry, Google Vertex AI
`;
const CLAUDE_TRUST = ` Do you trust the files in this folder?

 /Users/henry/Developer/envi-ops

 Claude Code may read, write, or execute files contained in this directory.

 ❯ 1. Yes, proceed
   2. No, exit

 Enter to confirm · Esc to exit
`;
const CLAUDE_IDLE = `⏺ Selesai. Ketik "Press enter to continue" kalau mau lanjut.

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

test('menu login Codex (v0.163 dan v0.167)', () => {
  for (const t of [CODEX_MENU, CODEX_MENU_167]) {
    const b = P(t);
    assert.equal(b.kind, 'login'); assert.equal(b.engine, 'codex'); assert.equal(b.method, 'menu');
    assert.equal(b.title, 'Viodex perlu login ChatGPT');
    assert.deepEqual(b.actions, [{ id: 'device', label: 'Login dengan kode', primary: true }, { id: 'browser', label: 'Login lewat browser', primary: false }]);
    assert.equal(b.input, null); assert.equal(b.url, null); assert.equal(b.code, null);
  }
  assert.deepEqual(parseRows(CODEX_MENU_167).map(r => [r.index, r.label, r.cursor]),
    [[1, 'Sign in with ChatGPT', false], [2, 'Sign in with Device Code', true], [3, 'Sign in another way', false]]);
});

test('login browser Codex: URL terpotong digabung, input callback', () => {
  const b = P(CODEX_BROWSER);
  assert.equal(b.method, 'browser'); assert.equal(b.kind, 'login');
  assert.equal(b.url, AUTH);
  assert.deepEqual(b.input, { id: 'callback', label: 'Tempel alamat halaman setelah login', placeholder: 'http://127.0.0.1:1455/auth/callback?code=…' });
  assert.deepEqual(b.actions, [{ id: 'device', label: 'Pakai kode saja', primary: false }]);
  // URL dari host lain di layar tidak ditampilkan sebagai tautan
  assert.equal(P(CODEX_BROWSER.replace('https://auth.openai.com', 'https://evil.example')).url, null);
});

test('kode perangkat Codex: url + kode + kedaluwarsa', () => {
  const b = P(CODEX_DEVICE);
  assert.equal(b.method, 'device');
  assert.equal(b.url, 'https://auth.openai.com/codex/device');
  assert.equal(b.code, 'M4MP-5D75U');
  assert.equal(b.expiresAt, new Date(NOW + 15 * 60e3).toISOString());
  assert.deepEqual(b.actions, [{ id: 'browser', label: 'Cara lain', primary: false }]);
  assert.equal(P(CODEX_DEVICE.replace('M4MP-5D75U', 'M5A6-BASQR')).code, 'M5A6-BASQR');
});

test('selesai login, percayai folder, Enter', () => {
  const done = P(CODEX_DONE);
  assert.equal(done.kind, 'prompt'); assert.equal(done.title, 'Viodex sudah login ChatGPT');
  assert.deepEqual(done.actions, [{ id: 'enter', label: 'Lanjut', primary: true }]);
  for (const [t, engine] of [[CODEX_TRUST, 'codex'], [CODEX_TRUST_NEW, 'codex'], [CLAUDE_TRUST, 'claude']]) {
    const b = P(t, { engine });
    assert.equal(b.kind, 'prompt', t); assert.equal(b.engine, engine);
    assert.deepEqual(b.actions, [{ id: 'yes', label: 'Ya, percaya', primary: true }, { id: 'no', label: 'Tidak', primary: false }]);
  }
  assert.match(P(CLAUDE_TRUST, { engine: 'claude' }).detail, /\/Users\/henry\/Developer\/envi-ops/);
  const ok = P(' Login successful. Press Enter to continue…\n', { engine: 'claude' });
  assert.equal(ok.kind, 'prompt'); assert.deepEqual(ok.actions.map(a => a.id), ['enter']);
});

test('login Claude: menu dan URL + kode', () => {
  const m = P(CLAUDE_MENU, { engine: 'claude', who: 'Cyrus' });
  assert.equal(m.engine, 'claude'); assert.equal(m.kind, 'login'); assert.equal(m.title, 'Cyrus perlu login Claude');
  assert.deepEqual(m.actions, [{ id: 'enter', label: 'Login akun Claude', primary: true }]);
  const b = P(CLAUDE_LOGIN, { engine: 'claude' });
  assert.equal(b.method, 'claude'); assert.equal(b.url, CLAUDE_URL);
  assert.equal(b.input.id, 'code');
});

test('layar normal = null (teks dialog di percakapan tidak dihitung)', () => {
  assert.equal(P(CODEX_IDLE), null);
  assert.equal(P(CLAUDE_IDLE, { engine: 'claude' }), null);
  assert.equal(P(''), null);
  assert.equal(P(CODEX_IDLE + CODEX_MENU.split('\n').slice(0, 3).join('\n')), null);
});

test('joinedUrl berhenti di baris berspasi atau URL lain', () => {
  const lines = ['x https://a.example/p?q=1', 'abc&d=2', 'Press esc', 'zzz'];
  assert.equal(joinedUrl(lines, /https:\/\/\S+/), 'https://a.example/p?q=1abc&d=2');
});

test('sameBlocker mengabaikan at dan expiresAt selama kodenya sama', () => {
  const a = { ...P(CODEX_DEVICE), at: '1' }, b = { ...P(CODEX_DEVICE, { now: NOW + 5000 }), at: '2' };
  assert.ok(sameBlocker(a, b)); assert.ok(sameBlocker(null, null)); assert.ok(!sameBlocker(a, null));
  assert.ok(!sameBlocker(a, P(CODEX_DEVICE.replace('M4MP-5D75U', 'AAAA-BBBBB'))));
});

/* ---------------- callback ---------------- */
const BROWSER = P(CODEX_BROWSER);
const cb = (q, base = 'http://127.0.0.1:1455/auth/callback') => `${base}?${q}`;
test('callback valid → URL yang di-GET di mesin agen', () => {
  assert.equal(checkCallback(cb(`code=ac_123&scope=openid&state=${STATE}`), BROWSER), `http://127.0.0.1:1455/auth/callback?code=ac_123&scope=openid&state=${STATE}`);
  assert.equal(checkCallback(`  http://localhost:1455/auth/callback?code=x&state=${STATE}\n`, BROWSER), `http://localhost:1455/auth/callback?code=x&state=${STATE}`);
});
test('callback ditolak: host, port, path, state, https, kosong', () => {
  const rej = (v, re, b = BROWSER) => assert.throws(() => checkCallback(v, b), e => e.code >= 400 && e.code < 500 && re.test(e.message), v);
  rej(cb(`code=x&state=${STATE}`, 'http://evil.example:1455/auth/callback'), /127\.0\.0\.1/);
  rej(cb(`code=x&state=${STATE}`, 'http://169.254.169.254:1455/auth/callback'), /127\.0\.0\.1/);
  rej(cb(`code=x&state=${STATE}`, 'http://127.0.0.1.evil.example:1455/auth/callback'), /127\.0\.0\.1/);
  rej(cb(`code=x&state=${STATE}`, 'http://127.0.0.1:8080/auth/callback'), /Port/);
  rej(cb(`code=x&state=${STATE}`, 'http://127.0.0.1/auth/callback'), /Port/);
  rej(cb(`code=x&state=${STATE}`, 'http://127.0.0.1:1455/admin'), /\/auth\/callback/);
  rej(cb(`code=x&state=${STATE}`, 'http://127.0.0.1:1455/auth/callback/../../x'), /\/auth\/callback/);
  rej(cb('code=x&state=lain'), /state berbeda/);
  rej(cb(`state=${STATE}`), /code/);
  rej(cb('code=x'), /state/);
  rej(cb(`code=x&state=${STATE}`, 'https://127.0.0.1:1455/auth/callback'), /http:\/\//);
  rej(cb(`code=x&state=${STATE}`, 'https://auth.openai.com/auth/callback'), /http:\/\//);
  rej(cb(`code=x&state=${STATE}`, 'http://user:pw@127.0.0.1:1455/auth/callback'), /sandi/);
  rej('file:///etc/passwd', /http:\/\//);
  rej('', /Tempel/);
  rej('bukan url', /valid/);
  // blocker bukan layar browser, atau URL authorize tanpa state
  rej(cb(`code=x&state=${STATE}`), /tidak sedang menunggu/, P(CODEX_DEVICE));
  rej(cb(`code=x&state=${STATE}`), /state tidak ada/, { ...BROWSER, url: AUTH.replace(/&state=[^&]+/, '') });
  // port mengikuti redirect_uri di URL authorize
  const b2 = { ...BROWSER, url: AUTH.replace('%3A1455', '%3A1600') };
  assert.match(checkCallback(cb(`code=x&state=${STATE}`, 'http://127.0.0.1:1600/auth/callback'), b2), /:1600\//);
  rej(cb(`code=x&state=${STATE}`), /1600/, b2);
});
test('checkCode hanya karakter aman', () => {
  assert.equal(checkCode(' abcDEF123_-#xyz.~ '), 'abcDEF123_-#xyz.~');
  for (const v of ['', '-flag', "a'; rm -rf /", 'abc def', 'a\nb', 'x'.repeat(600)]) assert.throws(() => checkCode(v), e => e.code === 400, v);
});

/* ---------------- aksi → tombol tmux (send-keys tiruan) ---------------- */
// layar tiruan: menu Codex dengan kursor yang ikut tombol panah, layar lain sebagai urutan
function fakePane(screens) {
  const sent = [], fetched = [];
  let i = 0;
  const io = {
    screen: async () => { const s = screens[Math.min(i, screens.length - 1)]; return typeof s === 'function' ? s() : s; },
    keys: async k => { sent.push(...k); if (k.includes('Escape') || k.includes('Enter')) i++; },
    literal: async t => { sent.push(`literal:${t}`); },
    fetchAt: async u => { fetched.push(u); return { status: 200 }; },
    sleep: async () => {},
  };
  return { io, sent, fetched };
}
function menuWithCursor(sentRef, start = 1) {
  return () => {
    let c = start;
    for (const k of sentRef()) { if (k === 'Down') c = Math.min(3, c + 1); if (k === 'Up') c = Math.max(1, c - 1); }
    return CODEX_MENU.replace(/^> 1\./m, '  1.').replace(new RegExp(`^  ${c}\\.`, 'm'), `> ${c}.`);
  };
}

test('device dari menu: Down sekali, cek kursor, Enter', async () => {
  let sent;
  const p = fakePane([menuWithCursor(() => sent)]); sent = p.sent;
  assert.deepEqual(await runAction(P(CODEX_MENU), 'device', undefined, p.io), { sent: 'device' });
  assert.deepEqual(p.sent, ['Down', 'Enter']);
});
test('device dari layar browser: Esc, lalu pilih kode', async () => {
  let sent;
  const p = fakePane([CODEX_BROWSER, menuWithCursor(() => sent.slice(1))]); sent = p.sent;
  await runAction(P(CODEX_BROWSER), 'device', undefined, p.io);
  assert.deepEqual(p.sent, ['Escape', 'Down', 'Enter']);
});
test('browser dari layar kode: Esc, kursor naik ke ChatGPT, Enter', async () => {
  let sent;
  const p = fakePane([CODEX_DEVICE, menuWithCursor(() => sent.slice(1), 2)]); sent = p.sent;
  await runAction(P(CODEX_DEVICE), 'browser', undefined, p.io);
  assert.deepEqual(p.sent, ['Escape', 'Up', 'Enter']);
});
test('kursor tidak bergerak → tidak menekan Enter', async () => {
  const p = fakePane([CODEX_MENU]);
  await assert.rejects(runAction(P(CODEX_MENU), 'device', undefined, p.io), e => e.code === 409);
  assert.ok(!p.sent.includes('Enter'));
});
test('enter, esc, yes/no, code, callback', async () => {
  let p = fakePane([CODEX_DONE]);
  await runAction(P(CODEX_DONE), 'enter', undefined, p.io); assert.deepEqual(p.sent, ['Enter']);
  p = fakePane([CODEX_TRUST_NEW]);
  await runAction(P(CODEX_TRUST_NEW), 'yes', undefined, p.io); assert.deepEqual(p.sent, ['Enter']);
  let sent;
  const trustScreen = () => sent.includes('Down') ? CODEX_TRUST_NEW.replace('> 1.', '  1.').replace('  2. No', '> 2. No') : CODEX_TRUST_NEW;
  p = fakePane([trustScreen]); sent = p.sent;
  await runAction(P(CODEX_TRUST_NEW), 'no', undefined, p.io); assert.deepEqual(p.sent, ['Down', 'Enter']);
  p = fakePane([CLAUDE_MENU]);
  await runAction(P(CLAUDE_MENU, { engine: 'claude' }), 'enter', undefined, p.io); assert.deepEqual(p.sent, ['Enter']);
  p = fakePane([CLAUDE_LOGIN]);
  await runAction(P(CLAUDE_LOGIN, { engine: 'claude' }), 'code', 'abc123#xyz', p.io); assert.deepEqual(p.sent, ['literal:abc123#xyz', 'Enter']);
  p = fakePane([' Paste or type your API key below.\n']);
  await runAction(P(' Paste or type your API key below.\n'), 'esc', undefined, p.io); assert.deepEqual(p.sent, ['Escape']);
  p = fakePane([CODEX_BROWSER]);
  const r = await runAction(P(CODEX_BROWSER), 'callback', cb(`code=c1&state=${STATE}`), p.io);
  assert.deepEqual(r, { sent: 'callback', callback: { status: 200 } });
  assert.deepEqual(p.fetched, [cb(`code=c1&state=${STATE}`)]); assert.deepEqual(p.sent, []);
});
test('aksi di luar whitelist atau tidak ada di blocker ditolak tanpa tombol', async () => {
  const p = fakePane([CODEX_MENU]);
  for (const [b, a] of [[P(CODEX_MENU), 'kill'], [P(CODEX_MENU), 'yes'], [P(CODEX_MENU), 'callback'], [P(CODEX_DEVICE), 'device'], [null, 'enter'], [P(CODEX_DONE), 'code']]) {
    await assert.rejects(runAction(b, a, 'x', p.io), e => e.code >= 400 && e.code < 500, a);
  }
  await assert.rejects(runAction(P(CODEX_BROWSER), 'callback', 'http://169.254.169.254/latest/meta-data', p.io), e => e.code === 400);
  assert.deepEqual(p.sent, []); assert.deepEqual(p.fetched, []);
  assert.deepEqual(ACTIONS, ['device', 'browser', 'enter', 'esc', 'yes', 'no', 'code', 'callback']);
});

/* ---------------- kapan layar dibaca ---------------- */
test('wantsScan', () => {
  const now = NOW, old = new Date(now - 3600e3).toISOString();
  const s = o => ({ tmux: 'kc-x', status: 'idle', startedAt: old, ...o });
  assert.equal(wantsScan(s({}), { now, stat: null }), true, 'transkrip belum ada');
  assert.equal(wantsScan(s({}), { now, stat: { size: 0, mtimeMs: now } }), true, 'transkrip kosong');
  assert.equal(wantsScan(s({}), { now, stat: { size: 10, mtimeMs: now - 30e3 } }), true, 'idle dan sepi > 20 dtk');
  assert.equal(wantsScan(s({}), { now, stat: { size: 10, mtimeMs: now - 5e3 } }), false, 'transkrip baru saja bergerak');
  assert.equal(wantsScan(s({ status: 'working' }), { now, stat: { size: 10, mtimeMs: now - 60e3 } }), false);
  assert.equal(wantsScan(s({ status: 'working', startedAt: new Date(now - 30e3).toISOString() }), { now, stat: { size: 10, mtimeMs: now } }), true, 'baru dibuat');
  assert.equal(wantsScan(s({ status: 'working', blocker: {} }), { now, stat: { size: 10, mtimeMs: now } }), true, 'blocker masih tampil');
  assert.equal(wantsScan(s({ waiting: { id: 1 } }), { now, stat: null }), false);
  assert.equal(wantsScan(s({ tmux: null }), { now, stat: null }), false);
  assert.equal(wantsScan(s({ status: 'ended' }), { now, stat: null }), false);
});

/* ---------------- blocker ikut objek sesi (serialize → /api/offices/:id?lite=1, /open, WS 'session') ---------------- */
test('serialize dan liveFor membawa blocker', async () => {
  const live = await import('../server/live.js');
  const s = live.expectSession({ sid: 'blk-1', office: 'envi', role: null, room: null, cwd: tmp, tmux: 'kc-envi-viodex', engine: 'codex' });
  assert.equal(live.serialize(s).blocker, null);
  s.blocker = { ...P(CODEX_DEVICE), at: new Date(NOW).toISOString() };
  assert.equal(live.serialize(s).blocker.code, 'M4MP-5D75U');
  assert.equal(live.liveFor('envi').find(x => x.sid === 'blk-1').blocker.method, 'device'); // sessions di GET /api/offices/:id (lite maupun tidak)
});
