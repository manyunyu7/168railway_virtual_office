// Ravel Remote signaling (server/remote.js + wiring di index.js). Lihat docs/REMOTE.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { createRemote } from '../server/remote.js';

const REPO = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-remote-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Klien WS palsu: antrean pesan JSON, tunggu pesan berikutnya (opsional dengan tipe tertentu), tunggu close. */
function client(url, headers = {}, wsOpts = {}) {
  const ws = new WebSocket(url, { headers, ...wsOpts });
  const q = [], waiters = [];
  let closed = null; const closeWaiters = [];
  ws.on('message', d => { const m = JSON.parse(String(d)); const i = waiters.findIndex(w => !w.type || w.type === (m.type ?? m.t)); if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else q.push(m); });
  ws.on('close', (code, reason) => { closed = { code, reason: String(reason) }; for (const r of closeWaiters.splice(0)) r(closed); });
  ws.on('error', () => {});
  return {
    ws,
    open: () => new Promise((res, rej) => { if (ws.readyState === 1) return res(); ws.once('open', res); ws.once('unexpected-response', (_, r) => rej(Object.assign(new Error('status ' + r.statusCode), { status: r.statusCode }))); ws.once('error', rej); }),
    send: m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: (type, ms = 2000) => {
      const i = q.findIndex(m => !type || (m.type ?? m.t) === type);
      if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
      return new Promise((resolve, reject) => { const w = { type, resolve }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout menunggu ${type || 'pesan'}`)); } }, ms); });
    },
    closed: () => closed ? Promise.resolve(closed) : new Promise(r => closeWaiters.push(r)),
    close: () => ws.close(),
  };
}

/* ---------------- unit: createRemote di server http sendiri ---------------- */
let srv, base, remote;
const audits = [], events = [];
before(async () => {
  remote = createRemote({ record: (k, i) => audits.push({ k, ...i }), emit: e => events.push(e), knownMachines: () => [{ id: 'local', name: 'Mac mini' }, { id: 'mbp', name: 'MacBook' }], pingMs: 60_000, replaceProbeMs: 150 });
  srv = http.createServer((q, r) => r.end());
  srv.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/host') remote.hostUpgrade(req, sock, head, u.searchParams.get('as'));
    else remote.viewerUpgrade(req, sock, head, { kind: 'local', name: 'Kamu' }, u.searchParams.get('machine'), { device: 'Fold', w: 1080, h: 2400, dpr: 3 });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${srv.address().port}`;
});
after(() => { remote.close(); srv.close(); });

async function host(machine, name = 'Mac', extra = {}, wsOpts = {}) {
  const h = client(`${base}/host?as=${machine}`, {}, wsOpts); await h.open();
  h.send({ type: 'register', machine, name, version: '1.0.0', displays: [{ id: 1, name: 'Built-in', w: 3024, h: 1964, scale: 2 }], ...extra });
  assert.equal((await h.next('registered')).machine, machine);
  return h;
}
async function viewer(machine) { const v = client(`${base}/viewer?machine=${machine}`); await v.open(); return v; }

test('remote: host offline → viewer dapat error', async () => {
  const v = await viewer('mbp');
  assert.match((await v.next('error')).message, /offline/);
  await v.closed();
});

test('remote: relay offer/answer/ice antar dua klien, session diperiksa', async () => {
  const h = await host('m1', 'Mac Satu');
  const listed = remote.listHosts().find(x => x.machine === 'm1');
  assert.equal(listed.online, true); assert.equal(listed.displays[0].w, 3024);
  assert.ok(remote.listHosts().some(x => x.machine === 'mbp' && x.online === false), 'mesin terdaftar tampil offline');
  const v = await viewer('m1');
  const ready = await v.next('ready');
  const join = await h.next('join');
  assert.equal(join.session, ready.session);
  assert.deepEqual(join.viewer, { device: 'Fold', w: 1080, h: 2400, dpr: 3 });
  const sid = ready.session;
  h.send({ type: 'offer', session: sid, sdp: 'v=0 offer' });
  assert.deepEqual(await v.next('offer'), { type: 'offer', session: sid, sdp: 'v=0 offer' });
  v.send({ type: 'answer', sdp: 'v=0 answer' }); // session boleh tidak diisi viewer: kantor menambahkannya
  assert.deepEqual(await h.next('answer'), { type: 'answer', session: sid, sdp: 'v=0 answer' });
  v.send({ type: 'ice', session: sid, candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal((await h.next('ice')).candidate, 'candidate:1');
  h.send({ type: 'ice', session: sid, candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal((await v.next('ice')).candidate, 'candidate:2');
  // session orang lain / tak dikenal ditolak, tidak diteruskan
  v.send({ type: 'answer', session: 's_palsu', sdp: 'x' });
  assert.match((await v.next('error')).message, /bukan milik/);
  h.send({ type: 'offer', session: 's_palsu', sdp: 'x' });
  assert.match((await h.next('error')).message, /tidak dikenal/);
  v.send({ type: 'offer', session: sid, sdp: 'x' }); // viewer tidak boleh membuat offer
  assert.match((await v.next('error')).message, /Tipe/);
  h.send('bukan json');
  assert.match((await h.next('error')).message, /JSON/);
  assert.ok(audits.some(a => a.k === 'remote' && /membuka remote desktop Mac Satu dari Fold/.test(a.text)));
  assert.ok(events.some(e => e.t === 'remote-hosts' && e.hosts.some(x => x.machine === 'm1' && x.busy)));
  // bye dari viewer → host menerima bye, WS viewer ditutup
  v.send({ type: 'bye', reason: 'selesai' });
  assert.deepEqual(await h.next('bye'), { type: 'bye', session: sid, reason: 'selesai' });
  await v.closed();
  assert.ok(audits.some(a => /menutup remote desktop Mac Satu/.test(a.text)));
  h.close(); await h.closed();
});

test('remote: viewer putus → host dapat bye; host putus → viewer dapat bye', async () => {
  const h = await host('m2');
  const v1 = await viewer('m2'); const s1 = (await v1.next('ready')).session; await h.next('join');
  v1.close();
  assert.deepEqual(await h.next('bye'), { type: 'bye', session: s1, reason: 'viewer-putus' });
  const v2 = await viewer('m2'); const s2 = (await v2.next('ready')).session; await h.next('join');
  h.close();
  assert.deepEqual(await v2.next('bye'), { type: 'bye', session: s2, reason: 'host-putus' });
  await v2.closed();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(remote.listHosts().find(x => x.machine === 'm2').online, false);
  assert.equal(remote._state().sessions.size, 0);
});

test('remote: batas 2 sesi per host', async () => {
  const h = await host('m3');
  const a = await viewer('m3'); await a.next('ready');
  const b = await viewer('m3'); await b.next('ready');
  const c = await viewer('m3');
  assert.match((await c.next('error')).message, /maksimal 2/);
  await c.closed();
  a.close(); await h.next('bye');
  const d = await viewer('m3'); await d.next('ready'); // slot kosong lagi
  b.close(); d.close(); h.close(); await h.closed();
});

test('remote (P1): host baru ditolak 4409 selama host lama punya sesi aktif', async () => {
  const old = await host('m4', 'Lama', { fingerprint: 'sha-256 AA' });
  const v = await viewer('m4'); const sid = (await v.next('ready')).session; await old.next('join');
  const neu = client(`${base}/host?as=m4`); await neu.open();
  neu.send({ type: 'register', machine: 'm4', name: 'Baru', fingerprint: 'sha-256 AA' }); // fingerprint sama pun tidak boleh merebut sesi
  assert.match((await neu.next('error')).message, /sesi aktif/);
  assert.equal((await neu.closed()).code, 4409);
  assert.equal(remote.listHosts().find(x => x.machine === 'm4').name, 'Lama');
  old.send({ type: 'offer', session: sid, sdp: 'masih' });
  assert.equal((await v.next('offer')).sdp, 'masih', 'sesi lama tidak terganggu');
  v.close(); await old.next('bye'); old.close(); await old.closed();
});

test('remote (P1): tanpa sesi, ganti hanya kalau fingerprint/instance sama atau host lama mati', async () => {
  // fingerprint sama → langsung diganti
  const a = await host('m6', 'A', { fingerprint: 'sha-256 11', instance: 'i-1' });
  const b = await host('m6', 'B', { fingerprint: 'sha-256 11', instance: 'i-9' });
  assert.equal((await a.closed()).code, 4000);
  // instance sama (fingerprint baru, mis. sertifikat diganti) → diganti
  const c = await host('m6', 'C', { instance: 'i-9', fingerprint: 'sha-256 22' });
  assert.equal((await b.closed()).code, 4000);
  assert.equal(remote.listHosts().find(x => x.machine === 'm6').name, 'C');
  // host lama hidup, identitas berbeda → 4409 setelah ping dijawab
  const d2 = client(`${base}/host?as=m6`); await d2.open();
  d2.send({ type: 'register', machine: 'm6', name: 'D', fingerprint: 'sha-256 33' });
  assert.match((await d2.next('error')).message, /masih hidup/);
  assert.equal((await d2.closed()).code, 4409);
  assert.equal(remote.listHosts().find(x => x.machine === 'm6').name, 'C');
  c.close(); await c.closed();
  // host lama tidak menjawab ping (macet/hilang jaringan) → diganti
  const dead = await host('m7', 'Macet', { fingerprint: 'sha-256 44' }, { autoPong: false });
  const fresh = await host('m7', 'Segar', { fingerprint: 'sha-256 55' });
  await dead.closed();
  const listed = remote.listHosts().find(x => x.machine === 'm7');
  assert.equal(listed.name, 'Segar'); assert.equal(listed.fingerprint, 'sha-256 55');
  assert.ok(audits.some(x => /fingerprint host Segar berubah/.test(x.text)));
  // fingerprint diteruskan ke viewer di ready; field asing tidak ikut di-relay
  const v = await viewer('m7');
  const ready = await v.next('ready');
  assert.equal(ready.fingerprint, 'sha-256 55');
  await fresh.next('join');
  fresh.send({ type: 'offer', session: ready.session, sdp: 'o', extra: 'sisipan', type2: 'x' });
  assert.deepEqual(await v.next('offer'), { type: 'offer', session: ready.session, sdp: 'o' });
  v.send({ type: 'ice', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, evil: 1 });
  assert.deepEqual(await fresh.next('ice'), { type: 'ice', session: ready.session, candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
  v.close(); fresh.close(); await fresh.closed();
});

test('remote: register harus pertama, mesin harus cocok dengan token, pesan > 64 KB diputus', async () => {
  const a = client(`${base}/host?as=m5`); await a.open();
  a.send({ type: 'offer', session: 'x' });
  assert.match((await a.next('error')).message, /register/);
  await a.closed();
  const b = client(`${base}/host?as=m5`); await b.open();
  b.send({ type: 'register', machine: 'mesin-lain' });
  assert.match((await b.next('error')).message, /mesin-lain/);
  assert.equal((await b.closed()).code, 4403);
  const h = await host('m5');
  h.send({ type: 'register', machine: 'm5', pad: 'x'.repeat(60 * 1024) }); // di bawah 64 KB: masih diterima
  h.send({ type: 'register', machine: 'm5', pad: 'x'.repeat(70 * 1024) });
  assert.equal((await h.closed()).code, 1009);
});

/* ---------------- integrasi: auth lewat daemon sungguhan (KANTOR_HOME sementara, KANTOR_DEMO) ---------------- */
const TOKM = 'kcmesin_tesremote_' + 'a'.repeat(20);
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let d;
before(async () => {
  const port = await freePort();
  const home = path.join(tmp, 'home'), root = path.join(tmp, 'Developer');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [root], token: 'tok', port, sysmon: { enabled: false },
    // tanpa cert: tidak ada listener TLS, tapi nama-namanya ikut allowedHosts (untuk tes Origin)
    tls: { host: '127.0.0.1', names: ['office.test', 'aplikasi.test'], proxy: { 'aplikasi.test': 'http://127.0.0.1:9' } },
    // batas laju dilonggarkan di sini (semua tes dari 127.0.0.1); batas aslinya dites di daemon kedua
    remote: { revalidateMs: 200, rate: { join: [100, 60e3], pair: [100, 60e3], approve: [100, 60e3], authFail: [100, 60e3] } },
    machines: [{ id: 'mbp', name: 'MacBook', ssh: 'pemilik@mbp.test', hubUrl: `http://127.0.0.1:${port}`, token: TOKM },
      // Mac hub sendiri terdaftar sebagai mesin ssh 'local:' (seperti di Mac mini pemilik)
      { id: 'mini', name: 'Mac mini', ssh: 'local:', hubUrl: `http://127.0.0.1:${port}`, token: TOKM + 'mini' }] }));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', c => { err += c; });
  d = { child, port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
  for (let i = 0; i < 100; i++) { try { await fetch(d.http + '/api/state'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('daemon tidak jalan: ' + err);
});
after(() => d?.child.kill());

const wsStatus = async (p, headers) => { const c = client(d.ws + p, headers); try { await c.open(); c.close(); return 101; } catch (e) { return e.status || 0; } };
const bearer = t => ({ Authorization: `Bearer ${t}` });
const api = async (p, { token, method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(d.http + p, { method, headers: { ...(token ? bearer(token) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
let H; // host MacBook (token mesin), tetap tersambung untuk tes berikutnya
/** Pairing lewat kode yang dikirim ke host: hasilnya token perangkat kcview_. */
async function pairWithCode(device) {
  const r = await api('/api/remote/pair', { token: 'tok', method: 'POST', body: { device } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const msg = await H.next('pair');
  assert.equal(msg.id, r.json.id); assert.equal(msg.device, device); assert.match(msg.code, /^\d{6}$/);
  const ok = await api(`/api/remote/pair/${r.json.id}/approve`, { token: 'tok', method: 'POST', body: { code: msg.code, claim: r.json.claim } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  let done; do done = await H.next('pair-done'); while (done.id !== r.json.id); // pair-done dari tes sebelumnya dilewati
  assert.equal(done.status, 'approved');
  return ok.json;
}

test('remote daemon: tanpa token ditolak, token mesin hanya untuk host', async () => {
  assert.equal(await wsStatus('/api/remote/host'), 401);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp'), 401);
  assert.equal((await api('/api/remote/hosts')).status, 401);
  assert.equal(await wsStatus('/api/remote/host', bearer('salah')), 401);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', bearer('kcview_palsu')), 401);
  // token mesin tidak bisa membuka sesi viewer, membaca daftar host, atau meminta pairing
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', bearer(TOKM)), 403);
  assert.equal((await api('/api/remote/hosts', { token: TOKM })).status, 403);
  assert.equal((await api('/api/remote/pair', { token: TOKM, method: 'POST', body: {} })).status, 403);
  // token config lewat cookie (bukan Bearer) tidak dipakai untuk host
  assert.equal(await wsStatus('/api/remote/host', { Cookie: 'kc_token=tok' }), 403);
});

test('remote daemon (K1): token owner dan cookie tidak cukup untuk viewer', async () => {
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', bearer('tok')), 403);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', { Cookie: 'kc_token=tok' }), 401);
  assert.equal((await api('/api/remote/hosts', { token: 'tok' })).status, 403);
  assert.equal((await api('/api/remote/hosts', { headers: { Cookie: 'kc_token=tok' } })).status, 401);
});

test('remote daemon: pairing dengan kode dari Mac, lalu host bertoken mesin + viewer saling relay', async () => {
  const ev = client(d.ws + '/ws', { Cookie: 'kc_token=tok' }); await ev.open();
  H = client(d.ws + '/api/remote/host', bearer(TOKM)); await H.open();
  H.send({ type: 'register', machine: 'mbp', name: 'MacBook Pro', version: '1.0.0', displays: [{ id: 1, w: 3024, h: 1964, scale: 2 }] });
  await H.next('registered');
  assert.ok((await ev.next('remote-hosts', 3000)).hosts.some(x => x.machine === 'mbp' && x.online));
  ev.close();

  // kode salah: dibatasi 5 percobaan, claim wajib
  const r = await api('/api/remote/pair', { token: 'tok', method: 'POST', body: { device: 'Tablet' } });
  assert.equal(r.json.hostsNotified, 1);
  const code = (await H.next('pair')).code;
  assert.equal((await api(`/api/remote/pair/${r.json.id}/approve`, { token: 'tok', method: 'POST', body: { code, claim: 'bukan' } })).status, 403);
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 4; i++) assert.match((await api(`/api/remote/pair/${r.json.id}/approve`, { token: 'tok', method: 'POST', body: { code: wrong, claim: r.json.claim } })).json.error, /Kode salah/);
  assert.match((await api(`/api/remote/pair/${r.json.id}/approve`, { token: 'tok', method: 'POST', body: { code: wrong, claim: r.json.claim } })).json.error, /terlalu sering/);
  assert.equal((await H.next('pair-done')).status, 'gagal');
  assert.equal((await api(`/api/remote/pair/${r.json.id}/approve`, { token: 'tok', method: 'POST', body: { code, claim: r.json.claim } })).status, 404);

  const fold = await pairWithCode('Fold 8');
  assert.match(fold.token, /^kcview_/);
  const list = await api('/api/remote/hosts', { token: fold.token });
  assert.equal(list.status, 200);
  assert.equal(list.json.find(x => x.machine === 'mbp').name, 'MacBook Pro');

  const v = client(d.ws + '/api/remote/ws?machine=mbp&device=Palsu&w=1080&h=2400&dpr=3', bearer(fold.token)); await v.open();
  const sid = (await v.next('ready')).session;
  assert.deepEqual((await H.next('join')).viewer, { device: 'Fold 8', w: 1080, h: 2400, dpr: 3 }, 'nama perangkat dari pairing, bukan query');
  H.send({ type: 'offer', session: sid, sdp: 'o' });
  assert.equal((await v.next('offer')).sdp, 'o');
  v.close();
  assert.equal((await H.next('bye')).reason, 'viewer-putus');
});

test('remote daemon: approve dari perangkat ter-pair, daftar dan cabut perangkat menutup sesinya', async () => {
  const fold = await pairWithCode('Fold lama');
  const r = await api('/api/remote/pair', { token: 'tok', method: 'POST', body: { device: 'HP baru' } });
  await H.next('pair');
  assert.equal((await api(`/api/remote/pair/${r.json.id}?claim=${r.json.claim}`, { token: 'tok' })).json.status, 'pending');
  assert.equal((await api('/api/remote/pair', { token: 'tok' })).status, 403, 'daftar permintaan hanya untuk perangkat');
  const pend = await api('/api/remote/pair', { token: fold.token });
  assert.ok(pend.json.some(p => p.id === r.json.id && p.device === 'HP baru' && !('code' in p) && !('claim' in p)));
  assert.equal((await api(`/api/remote/pair/${r.json.id}/approve`, { token: fold.token, method: 'POST' })).json.status, 'approved');
  assert.equal((await api(`/api/remote/pair/${r.json.id}`, { token: 'tok' })).status, 403, 'tanpa claim');
  const got = await api(`/api/remote/pair/${r.json.id}`, { token: 'tok', headers: { 'X-Pair-Claim': r.json.claim } });
  assert.equal(got.json.status, 'approved'); assert.match(got.json.token, /^kcview_/);
  assert.equal((await api(`/api/remote/pair/${r.json.id}?claim=${r.json.claim}`, { token: 'tok' })).json.status, 'expired', 'token hanya diberikan sekali');
  const hp = got.json.token;

  const devs = await api('/api/remote/devices', { token: hp });
  const me = devs.json.find(x => x.current);
  assert.equal(me.device, 'HP baru'); assert.ok(!('hash' in me));
  assert.equal((await api('/api/remote/devices', { token: 'tok' })).status, 200);

  const v = client(d.ws + '/api/remote/ws?machine=mbp', bearer(hp)); await v.open();
  const sid = (await v.next('ready')).session; await H.next('join');
  assert.equal((await api(`/api/remote/devices/${me.id}`, { token: fold.token, method: 'DELETE' })).status, 200);
  assert.deepEqual(await H.next('bye'), { type: 'bye', session: sid, reason: 'perangkat-dicabut' });
  await v.closed();
  assert.equal((await api('/api/remote/hosts', { token: hp })).status, 401, 'token dicabut');
  assert.ok(!fs.readFileSync(path.join(tmp, 'home', 'remote-devices.json'), 'utf8').includes(fold.token.slice(7)), 'hanya hash yang disimpan');
  assert.equal(fs.statSync(path.join(tmp, 'home', 'remote-devices.json')).mode & 0o777, 0o600);
});

test('remote daemon (P3): Origin browser selain kantor sendiri ditolak, app native tanpa Origin boleh', async () => {
  const fold = await pairWithCode('Fold origin');
  const tok = bearer(fold.token);
  assert.equal((await api('/api/remote/hosts', { token: fold.token, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await api('/api/remote/hosts', { token: fold.token, headers: { Origin: 'https://aplikasi.test' } })).status, 403, 'nama proxy satu sertifikat');
  assert.equal((await api('/api/remote/hosts', { token: fold.token, headers: { Origin: 'null' } })).status, 403);
  assert.equal((await api('/api/remote/hosts', { token: fold.token, headers: { Origin: 'https://office.test' } })).status, 200);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', { ...tok, Origin: 'https://evil.test' }), 403);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', { ...tok, Origin: 'https://aplikasi.test' }), 403);
  assert.equal(await wsStatus('/api/remote/host', { ...bearer(TOKM), Origin: 'https://evil.test' }), 403);
  assert.equal((await api('/api/remote/pair', { token: 'tok', method: 'POST', body: {}, headers: { Origin: 'https://aplikasi.test' } })).status, 403);
});

test('remote daemon: GET /api/remote/relay-owner hanya untuk token owner, dari remote-relay.json mode 600', async () => {
  const file = path.join(tmp, 'home', 'remote-relay.json');
  assert.equal((await api('/api/remote/relay-owner', { token: 'tok' })).status, 404, 'belum dikonfigurasi');
  const RT = 'kcowner_' + 'r'.repeat(43);
  fs.writeFileSync(file, JSON.stringify({ url: 'https://relay.example.test/', token: RT }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.match((await api('/api/remote/relay-owner', { token: 'tok' })).json.error, /mode 600/);
  fs.chmodSync(file, 0o600);
  const ok = await api('/api/remote/relay-owner', { token: 'tok' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { url: 'https://relay.example.test', token: RT });
  // app mengirim ?url=<origin relay>: harus cocok (origin, wss sama dengan https), kalau tidak 404
  assert.deepEqual((await api('/api/remote/relay-owner?url=' + encodeURIComponent('https://relay.example.test'), { token: 'tok' })).json, { url: 'https://relay.example.test', token: RT });
  assert.equal((await api('/api/remote/relay-owner?url=' + encodeURIComponent('wss://relay.example.test/api/remote/ws'), { token: 'tok' })).status, 200);
  assert.equal((await api('/api/remote/relay-owner?url=' + encodeURIComponent('https://lain.example.test'), { token: 'tok' })).status, 404);
  const RT2 = 'kcowner_' + 's'.repeat(43);
  fs.writeFileSync(file, JSON.stringify([{ url: 'https://relay.example.test', token: RT }, { url: 'https://dua.example.test', token: RT2 }]), { mode: 0o600 });
  assert.equal((await api('/api/remote/relay-owner?url=https://dua.example.test', { token: 'tok' })).json.token, RT2, 'daftar relay');
  const view = await pairWithCode('Fold relay');
  assert.equal((await api('/api/remote/relay-owner', { token: view.token })).status, 403, 'token perangkat tidak boleh');
  assert.equal((await api('/api/remote/relay-owner', { headers: { Cookie: 'kc_token=tok' } })).status, 401, 'cookie tidak dipakai');
  assert.equal((await api('/api/remote/relay-owner', { token: 'tok', headers: { Origin: 'https://evil.test' } })).status, 403);
  fs.writeFileSync(file, JSON.stringify({ url: 'http://relay.example.test', token: RT }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.equal((await api('/api/remote/relay-owner', { token: 'tok' })).status, 409, 'harus https/wss');
  fs.rmSync(file);
});

test('remote daemon: Mac hub lewat token config loopback memakai id mesin local:', async () => {
  const loc = client(d.ws + '/api/remote/host', bearer('tok')); await loc.open();
  loc.send({ type: 'register', machine: 'local', name: 'Mac mini' });
  assert.equal((await loc.next('registered')).machine, 'mini');
  // token mesin MacBook tidak boleh mendaftar sebagai mesin lain
  const evil = client(d.ws + '/api/remote/host', bearer(TOKM)); await evil.open();
  evil.send({ type: 'register', machine: 'local' });
  assert.equal((await evil.closed()).code, 4403);
  loc.close(); H.close();
});

test('remote daemon: token mesin dirotasi → host diputus 4401, token lama tidak bisa tersambung lagi', async () => {
  const h = client(d.ws + '/api/remote/host', bearer(TOKM)); await h.open();
  h.send({ type: 'register', machine: 'mbp', name: 'MacBook' }); await h.next('registered');
  const r = await api('/api/machines/mbp', { token: 'tok', method: 'PATCH', body: { rotateToken: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await h.closed()).code, 4401);
  assert.equal(await wsStatus('/api/remote/host', bearer(TOKM)), 401);
});

/* ---------------- batas laju per IP (daemon kedua, batas kecil) ---------------- */
test('remote daemon: batas laju pair, join, dan auth gagal per IP', async () => {
  const port = await freePort();
  const home = path.join(tmp, 'home-rate');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [tmp], token: 'tok', port, sysmon: { enabled: false },
    remote: { rate: { pair: [1, 60e3], join: [2, 60e3], authFail: [3, 60e3] } } }));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`, wsb = `ws://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const post = () => fetch(base + '/api/remote/pair', { method: 'POST', headers: { ...bearer('tok'), 'Content-Type': 'application/json' }, body: '{"device":"x"}' });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
    const join = async () => { const c = client(wsb + '/api/remote/ws?machine=x', bearer('kcview_salah')); try { await c.open(); c.close(); return 101; } catch (e) { return e.status; } };
    assert.equal(await join(), 401); // auth gagal 1
    assert.equal(await join(), 401); // auth gagal 2
    assert.equal(await join(), 429, 'join ke-3 dalam semenit');
    assert.equal((await fetch(base + '/api/remote/hosts', { headers: bearer('kcview_salah') })).status, 401); // auth gagal 3
    assert.equal((await fetch(base + '/api/remote/hosts', { headers: bearer('kcview_salah') })).status, 429);
    assert.equal((await post()).status, 429, 'IP yang terlalu sering gagal ditahan untuk semua rute remote');
    assert.equal((await fetch(base + '/api/state', { headers: bearer('tok') })).status, 200, 'API kantor lain tidak terpengaruh');
  } finally { child.kill(); }
});

