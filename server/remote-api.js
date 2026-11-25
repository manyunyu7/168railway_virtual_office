// Ravel Remote: auth dan rute /api/remote/* (HTTP dan WebSocket). Relay-nya di server/remote.js,
// perangkat dan pairing di server/remote-devices.js. Kontrak: docs/REMOTE.md.
//
// Siapa boleh apa:
//   host   (WS /api/remote/host)  token mesin, atau token config lewat listener HTTP lokal (Mac hub)
//   viewer (WS /api/remote/ws, GET /api/remote/hosts, approve tanpa kode)  token perangkat kcview_ saja
//   owner  (POST /api/remote/pair, ambil hasil pairing, approve dengan kode,
//           GET /api/remote/relay-owner)  token owner/admin lewat Bearer
// Cookie tidak pernah dipakai di /api/remote/*.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createRemote, viewerInfo } from './remote.js';
import * as rd from './remote-devices.js';
import * as authMx from './machines.js';
import * as audit from './audit.js';
import { bus } from './live.js';
import { sameToken } from './safe-eq.js';

const err = (message, code) => Object.assign(new Error(message), { code });

/** Relay signaling publik (ravel-remote/relay): { url, token owner relay } dari DATA_DIR/remote-relay.json, dibuat manual
 *  dengan mode 600. Supaya app bisa meminta pairing ke relay tanpa mengetik token. null kalau berkas tidak ada. */
export function readRelayOwner(file = path.join(DATA_DIR, 'remote-relay.json')) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (st.mode & 0o077) throw err(`${path.basename(file)} harus mode 600 (chmod 600).`, 409);
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw err(`${path.basename(file)} bukan JSON yang valid.`, 409); }
  let u; try { u = new URL(String(j.url || '')); } catch { throw err('url relay tidak valid.', 409); }
  if (!/^(https|wss):$/.test(u.protocol)) throw err('url relay harus https:// atau wss://.', 409);
  if (!/^kcowner_[A-Za-z0-9_-]{20,}$/.test(String(j.token || ''))) throw err('token owner relay tidak valid (awalan kcowner_).', 409);
  return { url: u.href.replace(/\/+$/, ''), token: j.token };
}

/** deps: { cfg, identify, allowedHosts, clientIp, fromLoopback, logDenied, send(res, code, data), body(req) } */
export function remoteApi(deps) {
  const { cfg, identify, allowedHosts, clientIp, fromLoopback, logDenied, send, body } = deps;
  // Mac hub sendiri bisa terdaftar sebagai mesin ssh 'local:' (punya hub.json dan token mesin); kalau ada, itulah id Mac ini
  const loopMachine = () => authMx.listMachines().find(m => !m.disabled && String(m.ssh).startsWith('local:'))?.id || null;
  const isOwner = a => !!a && (a.kind === 'local' || a.kind === 'system' || (a.kind === 'member' && a.role === 'admin'));

  const remote = createRemote({
    record: (kind, info) => audit.record(kind, info),
    emit: m => bus.emit('msg', m),
    knownMachines: () => {
      const ms = authMx.listMachines().filter(m => !m.disabled);
      return loopMachine() ? ms : [{ id: authMx.LOCAL, name: cfg.remote?.localName || os.hostname().split('.')[0] }, ...ms];
    },
    maxSessions: cfg.remote?.maxSessions,
    revalidateMs: cfg.remote?.revalidateMs, // token mesin dirotasi/dinonaktifkan, perangkat dicabut → koneksi diputus
  });

  // batas laju per IP: [jumlah, jendela ms], bisa diubah di config.json → remote.rate
  const R = { join: [10, 60e3], pair: [5, 10 * 60e3], approve: [10, 60e3], authFail: [20, 10 * 60e3], ...(cfg.remote?.rate || {}) };
  const lim = Object.fromEntries(Object.entries(R).map(([k, [n, ms]]) => [k, rd.limiter(n, ms)]));
  const tooMany = () => err('Terlalu banyak percobaan. Coba lagi nanti.', 429);

  /** Pemanggil /api/remote/*: { kind: 'viewer'|'owner'|'other', actor, device? } atau null (tanpa/ salah token). */
  function caller(req) {
    if (!allowedHosts().has(req.headers.host)) return null;
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return null;
    const tok = h.slice(7), ip = clientIp(req);
    if (tok.startsWith(rd.VIEWER_PREFIX)) {
      const d = rd.deviceForToken(tok, ip);
      return d ? { kind: 'viewer', device: d, actor: { kind: 'remote-device', id: null, name: `Perangkat ${d.device}`, role: 'viewer', device: d.id, ip } } : null;
    }
    const a = identify(req);
    if (!a) return null;
    return { kind: isOwner(a) ? 'owner' : 'other', actor: a };
  }

  /** P3: app native tidak mengirim Origin. Kalau ada, harus asal kantor ini sendiri, dan bukan nama aplikasi lain
   *  yang diproksikan di sertifikat yang sama (cfg.tls.proxy: satu site, tapi bukan kantor). */
  function originAllowed(req) {
    const o = req.headers.origin;
    if (o === undefined) return true;
    let u; try { u = new URL(String(o)); } catch { return false; }
    if (Object.hasOwn(cfg.tls?.proxy || {}, u.hostname)) return false;
    return allowedHosts().has(u.host);
  }

  const pairOut = p => ({ id: p.id, claim: p.claim, device: p.device, expiresAt: new Date(p.expires).toISOString() });

  async function api(req, res, url, c) {
    const p = url.pathname.slice('/api/remote'.length), m = req.method;
    const need = (...kinds) => { if (!kinds.includes(c.kind)) throw err(c.kind === 'viewer' ? 'Token perangkat remote tidak berlaku di sini.' : 'Butuh token perangkat remote (pairing dulu: POST /api/remote/pair).', 403); };
    if (m === 'GET' && p === '/hosts') { need('viewer'); return remote.listHosts(); }
    if (m === 'POST' && p === '/pair') {
      need('owner');
      if (!lim.pair(clientIp(req))) throw tooMany();
      const b = await body(req);
      const pr = rd.createPair({ device: b.device, ip: clientIp(req) });
      const hostsNotified = remote.notifyPair(pr);
      audit.record('remote', { as: c.actor, text: `meminta pairing perangkat remote "${pr.device}"`, meta: { pair: pr.id, hostsNotified } });
      return { ...pairOut(pr), hostsNotified };
    }
    if (m === 'GET' && p === '/pair') { need('viewer'); return rd.pendingPairs(); }
    let mm;
    if (m === 'GET' && (mm = /^\/pair\/([^/]+)$/.exec(p))) {
      need('owner');
      const r = rd.claimPair(mm[1], req.headers['x-pair-claim'] || url.searchParams.get('claim'));
      if (r.status === 'approved') remote.pairDone(mm[1], 'approved');
      return r;
    }
    if (m === 'POST' && (mm = /^\/pair\/([^/]+)\/approve$/.exec(p))) {
      need('owner', 'viewer');
      if (!lim.approve(clientIp(req))) throw tooMany();
      const id = mm[1];
      if (c.kind === 'viewer') {
        const r = rd.approveByDevice(id, c.device);
        audit.record('remote', { as: c.actor, text: `menyetujui perangkat remote "${r.device.device}"`, meta: { pair: id, device: r.device.id } });
        return { id, status: 'approved', device: r.device };
      }
      const b = await body(req);
      try {
        const r = rd.approveWithCode(id, { code: b.code, claim: b.claim });
        remote.pairDone(id, 'approved');
        audit.record('remote', { as: c.actor, text: `perangkat remote "${r.device.device}" dipasangkan dengan kode dari Mac`, meta: { pair: id, device: r.device.id } });
        return { id, status: 'approved', token: r.token, device: r.device };
      } catch (e) { if (e.gone) remote.pairDone(id, 'gagal'); throw e; }
    }
    if (m === 'GET' && p === '/relay-owner') {
      // hanya token owner kantor (bukan token perangkat): yang boleh meminta pairing di sini juga boleh di relay
      need('owner');
      const r = readRelayOwner();
      if (!r) throw err('Relay belum dikonfigurasi (remote-relay.json tidak ada).', 404);
      audit.record('remote', { as: c.actor, text: 'mengambil token owner relay', meta: { url: r.url } });
      return r;
    }
    if (m === 'GET' && p === '/devices') { need('owner', 'viewer'); return rd.listDevices().map(d => ({ ...d, current: c.device?.id === d.id })); }
    if (m === 'DELETE' && (mm = /^\/devices\/([^/]+)$/.exec(p))) {
      need('owner', 'viewer');
      const d = rd.getDevice(mm[1]);
      if (!d || !rd.revokeDevice(d.id)) throw err('Perangkat tidak ditemukan.', 404);
      remote.closeDevice(d.id);
      audit.record('remote', { as: c.actor, text: `mencabut perangkat remote "${d.device}"`, meta: { device: d.id } });
      return { ok: true };
    }
    throw err('Tidak ditemukan', 404);
  }

  return {
    remote,
    /** HTTP /api/remote/*. */
    async http(req, res, url) {
      if (!originAllowed(req)) { logDenied(req, 'remote origin'); return send(res, 403, { error: 'Asal permintaan ditolak.' }); }
      const ip = clientIp(req);
      if (lim.authFail.full(ip)) { logDenied(req, 'remote dibatasi'); return send(res, 429, { error: 'Terlalu banyak percobaan gagal. Coba lagi nanti.' }); }
      const c = caller(req);
      if (!c) { lim.authFail(ip); logDenied(req, 'remote'); return send(res, 401, { error: 'Butuh token (Bearer).' }); }
      try { const out = await api(req, res, url, c); if (!res.headersSent) send(res, 200, out); }
      catch (e) { if (!res.headersSent) send(res, [401, 403, 404, 409, 429].includes(e.code) ? e.code : 400, { error: e.message }); }
    },
    /** WS /api/remote/host dan /api/remote/ws. true = sudah ditangani (diterima atau ditolak). */
    upgrade(req, sock, head, url) {
      const deny = (code, why) => { logDenied(req, why); sock.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : code === 429 ? 'Too Many Requests' : 'Forbidden'}\r\n\r\n`); sock.destroy(); return true; };
      if (!originAllowed(req)) return deny(403, 'remote origin');
      const ip = clientIp(req);
      if (lim.authFail.full(ip)) return deny(429, 'remote dibatasi');
      if (url.pathname === '/api/remote/host') {
        const a = allowedHosts().has(req.headers.host) ? identify(req) : null;
        if (!a) { lim.authFail(ip); return deny(401, 'remote host'); }
        const tok = String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
        if (!tok) return deny(403, 'remote host');
        if (a.kind === 'machine') { const mid = a.machine; return remote.hostUpgrade(req, sock, head, mid, { actor: a, valid: () => authMx.machineForToken(tok) === mid }), true; }
        // token config hanya dari listener HTTP lokal (bukan passthrough/tunnel ke listener TLS, lihat fromLoopback)
        if ((a.kind === 'local' || a.kind === 'system') && sameToken(tok, cfg.token) && fromLoopback(req)) {
          return remote.hostUpgrade(req, sock, head, loopMachine() || authMx.LOCAL, { loopback: true, actor: a, valid: () => sameToken(tok, cfg.token) }), true;
        }
        return deny(403, 'remote host');
      }
      if (url.pathname === '/api/remote/ws') {
        if (!lim.join(ip)) return deny(429, 'remote join dibatasi');
        const c = caller(req);
        if (!c) { lim.authFail(ip); return deny(401, 'remote viewer'); }
        if (c.kind !== 'viewer') return deny(403, 'remote viewer tanpa token perangkat');
        const id = c.device.id;
        // nama perangkat dari pairing, bukan dari query (query bisa dipalsukan); ukuran layar tetap dari query
        const info = { ...viewerInfo(url.searchParams), device: c.device.device };
        return remote.viewerUpgrade(req, sock, head, c.actor, url.searchParams.get('machine') || '', info, { deviceId: id, valid: () => !!rd.getDevice(id) }), true;
      }
      return false;
    },
  };
}
