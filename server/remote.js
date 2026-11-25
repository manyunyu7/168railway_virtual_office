// Ravel Remote: signaling WebRTC antara ravel-host (LaunchAgent di tiap Mac) dan app Ravel (viewer).
// Kantor hanya meneruskan pesan JSON (offer/answer/ice/bye) dan memeriksa bahwa setiap pesan milik sesi pengirimnya.
// Media mengalir langsung host ↔ viewer lewat Tailscale; kantor tidak pernah menyentuhnya.
// Kontrak: ravel-remote/docs/PROTOCOL.md bagian 1 dan 4. Ringkasan dan cara pakai: docs/REMOTE.md.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export const MAX_SESSIONS = 2;
export const MAX_MESSAGE = 256 * 1024;
export const PING_MS = 20_000;

const HOST_TYPES = new Set(['offer', 'ice', 'bye', 'error']);
const VIEWER_TYPES = new Set(['answer', 'ice', 'bye']);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const num = v => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);

/** Info viewer dari query (?device=&w=&h=&dpr=), dipotong supaya tidak bisa membengkakkan pesan join. */
export function viewerInfo(params) {
  const g = k => (params?.get ? params.get(k) : params?.[k]);
  return { device: str(g('device'), 80) || 'Ravel', w: num(g('w')), h: num(g('h')), dpr: num(g('dpr')) };
}

function cleanDisplays(d) {
  if (!Array.isArray(d)) return [];
  return d.slice(0, 16).map(x => ({ id: num(x?.id), name: str(x?.name, 80), w: num(x?.w), h: num(x?.h), scale: num(x?.scale) }));
}

/**
 * Registry host online + sesi. Tidak tahu apa-apa soal auth: index.js memutuskan siapa boleh masuk dan
 * memberi id mesin (host) atau actor (viewer).
 * opts: { record(kind, info), emit(event), knownMachines() → [{id,name}], maxSessions, pingMs, maxPayload, revalidateMs }
 */
export function createRemote(opts = {}) {
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const record = opts.record || (() => {});
  const emit = opts.emit || (() => {});
  const known = opts.knownMachines || (() => []);
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? MAX_MESSAGE });
  const hosts = new Map(); // machine → { ws, machine, name, version, displays, since, valid(), sessions: Map<sid, session> }
  const seen = new Map(); // machine → { name, version, displays } host yang pernah register (tetap tampil saat offline)
  const sessions = new Map(); // sid → { id, machine, host, viewer: ws, actor, deviceId, valid(), device, opened }

  const send = (ws, m) => { if (ws && ws.readyState === 1) try { ws.send(JSON.stringify(m)); } catch {} };
  const changed = () => { try { emit({ t: 'remote-hosts', hosts: listHosts() }); } catch {} };

  function listHosts() {
    const out = new Map();
    for (const m of known()) out.set(m.id, { machine: m.id, name: m.name || m.id, online: false, displays: [], version: null, busy: false, sessions: 0 });
    for (const [id, s] of seen) out.set(id, { machine: id, name: s.name, online: false, displays: s.displays, version: s.version, busy: false, sessions: 0 });
    for (const h of hosts.values()) out.set(h.machine, { machine: h.machine, name: h.name, online: true, displays: h.displays, version: h.version, busy: h.sessions.size > 0, sessions: h.sessions.size, maxSessions });
    return [...out.values()].sort((a, b) => (b.online - a.online) || String(a.name).localeCompare(String(b.name)));
  }

  /** Akhiri sesi: kirim bye ke pihak yang masih tersambung (kecuali `from`), tutup WS viewer, catat ke audit. */
  function endSession(s, reason, from = null) {
    if (!sessions.delete(s.id)) return;
    s.host.sessions.delete(s.id);
    const bye = { type: 'bye', session: s.id, reason };
    if (from !== 'host') send(s.host.ws, bye);
    if (from !== 'viewer') send(s.viewer, bye);
    if (s.viewer.readyState === 1) s.viewer.close(1000, 'bye');
    const min = Math.round((Date.now() - s.opened) / 60000);
    record('remote', { as: s.actor, text: `menutup remote desktop ${s.host.name} (${min < 1 ? '<1' : min} menit, ${reason})`, meta: { machine: s.machine, session: s.id, device: s.device, reason } });
    changed();
  }

  function dropHost(h, reason) {
    for (const s of [...h.sessions.values()]) endSession(s, reason, 'host');
    if (hosts.get(h.machine) === h) { hosts.delete(h.machine); changed(); }
  }

  /* ---------------- host ---------------- */
  function onHost(ws, machine, loopback, valid) {
    let h = null;
    const fail = (message, code = 4400) => { send(ws, { type: 'error', message }); ws.close(code, message.slice(0, 120)); };
    ws.on('message', (data, isBinary) => {
      let m; try { if (isBinary) throw 0; m = JSON.parse(String(data)); } catch { return send(ws, { type: 'error', message: 'Pesan harus JSON teks.' }); }
      if (!m || typeof m !== 'object') return send(ws, { type: 'error', message: 'Pesan harus objek JSON.' });
      if (!h) {
        if (m.type !== 'register') return fail('Kirim register dulu.');
        if (m.machine != null && String(m.machine) !== machine && !(m.machine === 'local' && loopback)) return fail(`Token ini untuk mesin "${machine}", bukan "${m.machine}".`, 4403);
        const old = hosts.get(machine);
        h = { ws, machine, name: str(m.name, 80) || old?.name || machine, version: str(m.version, 40), displays: cleanDisplays(m.displays), since: Date.now(), valid, sessions: new Map() };
        if (old) { dropHost(old, 'host-diganti'); try { old.ws.close(4000, 'diganti koneksi baru'); } catch {} }
        hosts.set(machine, h);
        seen.set(machine, { name: h.name, version: h.version, displays: h.displays });
        send(ws, { type: 'registered', machine, maxSessions });
        return changed();
      }
      if (m.type === 'register') { // display berubah: register lagi di koneksi yang sama
        h.name = str(m.name, 80) || h.name; h.version = str(m.version, 40) || h.version; h.displays = cleanDisplays(m.displays);
        seen.set(machine, { name: h.name, version: h.version, displays: h.displays });
        return changed();
      }
      if (!HOST_TYPES.has(m.type)) return send(ws, { type: 'error', message: `Tipe pesan tidak dikenal: ${String(m.type).slice(0, 40)}` });
      const s = h.sessions.get(m.session);
      if (!s) return send(ws, { type: 'error', session: m.session ?? null, message: 'Sesi tidak dikenal.' });
      if (m.type === 'bye' || m.type === 'error') {
        if (m.type === 'error') send(s.viewer, { type: 'error', session: s.id, message: str(m.message, 500) || 'Host menolak sesi.' });
        return endSession(s, str(m.reason ?? m.message, 200) || 'host', 'host');
      }
      send(s.viewer, { ...m, session: s.id });
    });
    ws.on('close', () => { if (h) dropHost(h, 'host-putus'); });
    ws.on('error', () => {});
  }

  /* ---------------- viewer ---------------- */
  function onViewer(ws, actor, machine, info, { deviceId = null, valid = () => true } = {}) {
    const h = hosts.get(machine);
    const refuse = message => { send(ws, { type: 'error', message }); ws.close(1000, 'error'); };
    if (!machine) return refuse('Parameter machine wajib diisi.');
    if (!h) return refuse('Host offline atau belum terpasang.');
    if (h.sessions.size >= maxSessions) return refuse(`Host sudah dipakai ${h.sessions.size} sesi (maksimal ${maxSessions}).`);
    const id = 's_' + crypto.randomBytes(12).toString('base64url');
    const s = { id, machine, host: h, viewer: ws, actor, deviceId, valid, device: info.device, opened: Date.now() };
    sessions.set(id, s); h.sessions.set(id, s);
    send(h.ws, { type: 'join', session: id, viewer: info });
    send(ws, { type: 'ready', session: id, machine, name: h.name, displays: h.displays });
    record('remote', { as: actor, text: `membuka remote desktop ${h.name} dari ${info.device}`, meta: { machine, session: id, device: info.device } });
    changed();
    ws.on('message', (data, isBinary) => {
      if (!sessions.has(id)) return;
      let m; try { if (isBinary) throw 0; m = JSON.parse(String(data)); } catch { return send(ws, { type: 'error', session: id, message: 'Pesan harus JSON teks.' }); }
      if (!m || typeof m !== 'object' || !VIEWER_TYPES.has(m.type)) return send(ws, { type: 'error', session: id, message: `Tipe pesan tidak dikenal: ${String(m?.type).slice(0, 40)}` });
      if (m.session != null && m.session !== id) return send(ws, { type: 'error', session: id, message: 'Sesi bukan milik koneksi ini.' });
      if (m.type === 'bye') return endSession(s, str(m.reason, 200) || 'viewer', 'viewer');
      send(h.ws, { ...m, session: id });
    });
    ws.on('close', () => { const cur = sessions.get(id); if (cur) endSession(cur, 'viewer-putus', 'viewer'); });
    ws.on('error', () => {});
  }

  // ping WS: klien yang tidak membalas pong sampai ping berikutnya diputus (close → bye ke pihak lain)
  const alive = new WeakMap();
  wss.on('connection', ws => { alive.set(ws, true); ws.on('pong', () => alive.set(ws, true)); });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false); try { ws.ping(); } catch {}
    }
  }, opts.pingMs ?? PING_MS);
  beat.unref?.();

  // token dicabut atau dirotasi (perangkat viewer, token mesin, token config) → koneksi remote yang memakainya ditutup
  function revalidate() {
    for (const h of [...hosts.values()]) {
      let ok = true; try { ok = h.valid ? !!h.valid() : true; } catch { ok = false; }
      if (!ok) { dropHost(h, 'token-dicabut'); try { h.ws.close(4401, 'token dicabut'); } catch {} }
    }
    for (const s of [...sessions.values()]) {
      let ok = true; try { ok = !!s.valid(); } catch { ok = false; }
      if (!ok) endSession(s, 'token-dicabut');
    }
  }
  const recheck = setInterval(revalidate, opts.revalidateMs ?? 5000);
  recheck.unref?.();

  return {
    listHosts,
    revalidate,
    /** Pairing perangkat: kode tampil di semua Mac yang online (status bar/notifikasi ravel-host). Jumlah host yang dikabari. */
    notifyPair(p) { let n = 0; for (const h of hosts.values()) if (h.ws.readyState === 1) { send(h.ws, { type: 'pair', id: p.id, device: p.device, code: p.code, expiresAt: new Date(p.expires).toISOString() }); n++; } return n; },
    /** Pairing selesai (disetujui/kedaluwarsa/dibatalkan): host menutup notifikasinya. */
    pairDone(id, status) { for (const h of hosts.values()) send(h.ws, { type: 'pair-done', id, status }); },
    /** Perangkat dicabut: sesi-sesinya langsung diakhiri. */
    closeDevice(deviceId, reason = 'perangkat-dicabut') { for (const s of [...sessions.values()]) if (s.deviceId === deviceId) endSession(s, reason); },
    /** WS /api/remote/host: `machine` sudah diverifikasi dari token (mesin) atau 'local' (token config dari loopback). */
    // loopback=true: token config dari Mac ini; register boleh menyebut machine 'local' walau id-nya mesin ssh 'local:'
    // valid(): dicek ulang tiap revalidateMs; false → host diputus (token mesin dirotasi/mesin dinonaktifkan)
    hostUpgrade(req, sock, head, machine, { loopback = false, valid = () => true } = {}) { wss.handleUpgrade(req, sock, head, ws => { wss.emit('connection', ws, req); onHost(ws, machine, loopback, valid); }); },
    /** WS /api/remote/ws: actor sudah diverifikasi (perangkat viewer ter-pair). opts: { deviceId, valid() } */
    viewerUpgrade(req, sock, head, actor, machine, info, o = {}) { wss.handleUpgrade(req, sock, head, ws => { wss.emit('connection', ws, req); onViewer(ws, actor, machine, info, o); }); },
    close() { clearInterval(beat); clearInterval(recheck); for (const ws of wss.clients) ws.terminate(); wss.close(); },
    _state: () => ({ hosts, sessions }),
  };
}
