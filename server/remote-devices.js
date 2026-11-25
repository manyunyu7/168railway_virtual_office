// Ravel Remote: perangkat viewer yang boleh membuka remote desktop, dan pairing perangkat baru.
// Token owner Kantor TIDAK cukup untuk /api/remote/ws: token itu dipakai banyak klien lain (hook, MCP, agen).
// Tiap perangkat punya token sendiri (awalan kcview_) yang didapat lewat pairing:
// app meminta dengan token owner, lalu disetujui dengan kode 6 digit yang tampil di Mac (ravel-host) ATAU dari
// perangkat yang sudah ter-pair. Hanya hash token yang disimpan (DATA_DIR/remote-devices.json, mode 600).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ensureDirs } from './config.js';

export const VIEWER_PREFIX = 'kcview_';
export const PAIR_TTL_MS = 5 * 60e3;
export const PAIR_MAX_ATTEMPTS = 5;

const FILE = () => path.join(DATA_DIR, 'remote-devices.json');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const nowIso = () => new Date().toISOString();

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { cache = {}; }
  if (!Array.isArray(cache.devices)) cache.devices = [];
  return cache;
}
function save() {
  ensureDirs();
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}
const pub = d => d && ({ id: d.id, device: d.device, createdAt: d.createdAt, lastUsed: d.lastUsed || null, lastIp: d.lastIp || null, via: d.via });

export const listDevices = () => load().devices.map(pub);
export const getDevice = id => pub(load().devices.find(d => d.id === id));

/** Perangkat pemilik token viewer, atau null. lastUsed diperbarui paling sering sekali per menit. */
export function deviceForToken(tok, ip = null) {
  if (!tok || !String(tok).startsWith(VIEWER_PREFIX)) return null;
  const h = sha(tok);
  const d = load().devices.find(x => eq(x.hash, h));
  if (!d) return null;
  if (!d.lastUsed || Date.now() - Date.parse(d.lastUsed) > 60e3 || d.lastIp !== ip) { d.lastUsed = nowIso(); d.lastIp = ip; try { save(); } catch {} }
  return pub(d);
}

function issue(device, via) {
  const token = VIEWER_PREFIX + crypto.randomBytes(32).toString('base64url');
  const d = { id: 'rd_' + rid(), device: String(device || 'Perangkat').slice(0, 80), hash: sha(token), createdAt: nowIso(), via };
  load().devices.push(d); save();
  return { token, device: pub(d) };
}

export function revokeDevice(id) {
  const c = load(), n = c.devices.length;
  c.devices = c.devices.filter(d => d.id !== id);
  if (c.devices.length === n) return false;
  save(); return true;
}

/* ---------------- pairing (di memori; daemon restart = minta ulang) ---------------- */
const pairs = new Map(); // id → { id, device, code, claim, ip, created, expires, status, attempts, result? }
const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });
function sweep(now = Date.now()) { for (const [id, p] of pairs) if (p.expires < now) pairs.delete(id); }

/** Permintaan pairing baru. `claim` hanya diberikan ke peminta; dipakai untuk mengambil token setelah disetujui. */
export function createPair({ device, ip = null } = {}) {
  sweep();
  if (pairs.size >= 20) throw fail('Terlalu banyak permintaan pairing yang menunggu.', 429);
  const p = { id: 'rp_' + rid(), device: String(device || '').trim().slice(0, 80) || 'Perangkat', code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'),
    claim: rid(24), ip, created: Date.now(), expires: Date.now() + PAIR_TTL_MS, status: 'pending', attempts: 0 };
  pairs.set(p.id, p);
  return p;
}
const pairPub = p => ({ id: p.id, device: p.device, ip: p.ip, createdAt: new Date(p.created).toISOString(), expiresAt: new Date(p.expires).toISOString() });
export const pendingPairs = () => { sweep(); return [...pairs.values()].filter(p => p.status === 'pending').map(pairPub); };
function pending(id) {
  sweep();
  const p = pairs.get(id);
  if (!p) throw fail('Permintaan pairing tidak ada atau sudah kedaluwarsa.', 404);
  if (p.status !== 'pending') throw fail('Permintaan pairing ini sudah diproses.', 409);
  return p;
}
/** Disetujui dengan kode 6 digit dari Mac + claim peminta → token langsung dikembalikan. */
export function approveWithCode(id, { code, claim } = {}) {
  const p = pending(id);
  if (!eq(p.claim, claim || '')) throw fail('Permintaan pairing ini bukan milikmu.', 403);
  if (!eq(p.code, String(code ?? '').trim())) {
    if (++p.attempts >= PAIR_MAX_ATTEMPTS) { pairs.delete(id); throw Object.assign(fail('Kode salah terlalu sering. Minta pairing ulang.', 403), { gone: true }); }
    throw fail(`Kode salah (sisa ${PAIR_MAX_ATTEMPTS - p.attempts} percobaan).`, 403);
  }
  pairs.delete(id);
  return { ...issue(p.device, 'kode'), id };
}
/** Disetujui dari perangkat yang sudah ter-pair; peminta mengambil token lewat claimPair. */
export function approveByDevice(id, approver) {
  const p = pending(id);
  p.status = 'approved'; p.approver = approver?.id || null;
  p.result = issue(p.device, `perangkat ${approver?.device || approver?.id}`);
  return { id, device: p.result.device };
}
/** Status untuk peminta (butuh claim). Token disetujui hanya diberikan sekali. */
export function claimPair(id, claim) {
  sweep();
  const p = pairs.get(id);
  if (!p) return { status: 'expired' };
  if (!eq(p.claim, claim || '')) throw fail('Permintaan pairing ini bukan milikmu.', 403);
  if (p.status === 'pending') return { status: 'pending', expiresAt: new Date(p.expires).toISOString() };
  pairs.delete(id);
  return { status: 'approved', token: p.result.token, device: p.result.device };
}
export function cancelPair(id) { return pairs.delete(id); }

/* ---------------- batas laju sederhana (jendela geser per kunci) ---------------- */
export function limiter(max, windowMs) {
  const hits = new Map();
  const fresh = key => (hits.get(key) || []).filter(t => Date.now() - t < windowMs);
  return Object.assign(key => {
    const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return true;
  }, { /** true kalau kunci ini sudah mencapai batas (tanpa mencatat hit). */ full: key => fresh(key).length >= max });
}

export function _resetForTests() { cache = null; pairs.clear(); }
