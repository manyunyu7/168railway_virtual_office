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
function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
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
  remote = createRemote({ record: (k, i) => audits.push({ k, ...i }), emit: e => events.push(e), knownMachines: () => [{ id: 'local', name: 'Mac mini' }, { id: 'mbp', name: 'MacBook' }], pingMs: 60_000 });
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

async function host(machine, name = 'Mac') {
  const h = client(`${base}/host?as=${machine}`); await h.open();
  h.send({ type: 'register', machine, name, version: '1.0.0', displays: [{ id: 1, name: 'Built-in', w: 3024, h: 1964, scale: 2 }] });
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

test('remote: host register ulang menggantikan koneksi lama', async () => {
  const old = await host('m4', 'Lama');
  const v = await viewer('m4'); await v.next('ready'); await old.next('join');
  const neu = await host('m4', 'Baru');
  assert.equal((await old.closed()).code, 4000);
  assert.equal((await v.next('bye')).reason, 'host-diganti');
  const h = remote.listHosts().find(x => x.machine === 'm4');
  assert.equal(h.online, true); assert.equal(h.name, 'Baru');
  const v2 = await viewer('m4'); await v2.next('ready');
  assert.ok((await neu.next('join')).session);
  v2.close(); neu.close(); await neu.closed();
});

test('remote: register harus pertama, mesin harus cocok dengan token, pesan > 256 KB diputus', async () => {
  const a = client(`${base}/host?as=m5`); await a.open();
  a.send({ type: 'offer', session: 'x' });
  assert.match((await a.next('error')).message, /register/);
  await a.closed();
  const b = client(`${base}/host?as=m5`); await b.open();
  b.send({ type: 'register', machine: 'mesin-lain' });
  assert.match((await b.next('error')).message, /mesin-lain/);
  assert.equal((await b.closed()).code, 4403);
  const h = await host('m5');
  h.send({ type: 'register', machine: 'm5', pad: 'x'.repeat(300 * 1024) });
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

test('remote daemon: tanpa token ditolak, token mesin hanya untuk host', async () => {
  assert.equal(await wsStatus('/api/remote/host'), 401);
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp'), 401);
  assert.equal((await fetch(d.http + '/api/remote/hosts')).status, 401);
  assert.equal(await wsStatus('/api/remote/host', bearer('salah')), 401);
  // token mesin tidak bisa membuka sesi viewer atau membaca daftar host
  assert.equal(await wsStatus('/api/remote/ws?machine=mbp', bearer(TOKM)), 403);
  assert.equal((await fetch(d.http + '/api/remote/hosts', { headers: bearer(TOKM) })).status, 403);
  // token config lewat cookie (bukan Bearer) tidak dipakai untuk host
  assert.equal(await wsStatus('/api/remote/host', { Cookie: 'kc_token=tok' }), 403);
  const list = await (await fetch(d.http + '/api/remote/hosts', { headers: bearer('tok') })).json();
  assert.deepEqual(list.map(x => [x.machine, x.online]).sort(), [['mbp', false], ['mini', false]], "tanpa entri 'local' ganda");
});

test('remote daemon: host bertoken mesin + viewer pemilik saling relay', async () => {
  const ev = client(d.ws + '/ws', { Cookie: 'kc_token=tok' }); await ev.open();
  const h = client(d.ws + '/api/remote/host', bearer(TOKM)); await h.open();
  h.send({ type: 'register', machine: 'mbp', name: 'MacBook Pro', version: '1.0.0', displays: [{ id: 1, w: 3024, h: 1964, scale: 2 }] });
  await h.next('registered');
  const e = await ev.next('remote-hosts', 3000);
  assert.ok(e.hosts.some(x => x.machine === 'mbp' && x.online));
  const list = await (await fetch(d.http + '/api/remote/hosts', { headers: bearer('tok') })).json();
  assert.equal(list.find(x => x.machine === 'mbp').name, 'MacBook Pro');
  const v = client(d.ws + '/api/remote/ws?machine=mbp&device=Fold%208&w=1080&h=2400&dpr=3', { Cookie: 'kc_token=tok' }); await v.open();
  const sid = (await v.next('ready')).session;
  assert.deepEqual((await h.next('join')).viewer, { device: 'Fold 8', w: 1080, h: 2400, dpr: 3 });
  h.send({ type: 'offer', session: sid, sdp: 'o' });
  assert.equal((await v.next('offer')).sdp, 'o');
  v.close();
  assert.equal((await h.next('bye')).reason, 'viewer-putus');
  // Mac ini sendiri: token config dari loopback → id mesin 'local:' (mini); 'local' diterima sebagai alias
  const loc = client(d.ws + '/api/remote/host', bearer('tok')); await loc.open();
  loc.send({ type: 'register', machine: 'local', name: 'Mac mini' });
  assert.equal((await loc.next('registered')).machine, 'mini');
  // token mesin MacBook tidak boleh mendaftar sebagai mesin lain
  const evil = client(d.ws + '/api/remote/host', bearer(TOKM)); await evil.open();
  evil.send({ type: 'register', machine: 'local' });
  assert.equal((await evil.closed()).code, 4403);
  h.close(); loc.close(); ev.close();
});
