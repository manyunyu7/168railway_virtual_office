// Member accounts for a shared office (config `akun.enabled`): username + password + TOTP, invites, browser sessions.
// Off by default; a single-user Mac keeps the one config token. Stored in ~/.kantor-claude/akun.db.
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, ensureDirs } from './config.js';

const scrypt = promisify(crypto.scrypt);

const MIGRATIONS = [
  `CREATE TABLE members (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'anggota',
     pass TEXT, totp TEXT, totp_last INTEGER DEFAULT 0, active INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0,
     invite TEXT, invite_until TEXT, created_at TEXT, created_by TEXT, last_login TEXT);
   CREATE TABLE member_sessions (id TEXT PRIMARY KEY, member TEXT NOT NULL, created_at TEXT, seen_at TEXT, until TEXT, ip TEXT, ua TEXT);
   CREATE INDEX member_sessions_member ON member_sessions(member);`,
];

let db = null;
function kdb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(path.join(DATA_DIR, 'akun.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) { db.exec('BEGIN'); try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  return db;
}
export function closeAkun() { if (db) try { db.close(); } catch {} db = null; }

const nowIso = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });

export const INVITE_HOURS = 72;
export const ROLES = ['admin', 'anggota'];

/* ---------------- passwords (scrypt) ---------------- */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
// a wrong username costs as much time as a wrong password
let dummyHash = null;
const dummy = async () => dummyHash || (dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex')));

export function passwordProblem(pw, username = '') {
  const s = String(pw || '');
  if (s.length < 10) return 'Password minimal 10 karakter.';
  if (s.length > 200) return 'Password terlalu panjang.';
  if (username && s.toLowerCase().includes(String(username).toLowerCase())) return 'Password tidak boleh memuat username.';
  if (/^(.)\1+$/.test(s)) return 'Password terlalu mudah ditebak.';
  return null;
}

/* ---------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[\s=]/g, '')) {
    const i = B32.indexOf(c); if (i < 0) throw fail('kunci TOTP tidak valid');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export const totpStep = (t = Date.now()) => Math.floor(t / 30000);
/** Returns the matching time step (±1 for clock drift), or null. */
export function totpMatch(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = totpStep(t);
  for (const s of [now, now - 1, now + 1]) if (crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(c))) return s;
  return null;
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));
export const otpauthUrl = (secret, username, issuer = 'Kantor Claude') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ---------------- login throttling (memory) ---------------- */
// per username: 5 misses lock it for 15 minutes; per IP: 20 misses per 15 minutes
const LOCK_MS = 15 * 60 * 1000, USER_MAX = 5, IP_MAX = 20;
const userFails = new Map(), ipFails = new Map();
function bump(map, key) {
  const now = Date.now(), cur = map.get(key);
  const e = cur && now - cur.first < LOCK_MS ? cur : { n: 0, first: now };
  e.n++; map.set(key, e); return e.n;
}
const over = (map, key, max) => { const e = map.get(key); return !!e && Date.now() - e.first < LOCK_MS && e.n >= max; };
export function resetThrottle() { userFails.clear(); ipFails.clear(); }

/* ---------------- members ---------------- */
const pub = m => m && ({ id: m.id, username: m.username, name: m.name, role: m.role, active: !!m.active, disabled: !!m.disabled,
  invitePending: !!m.invite && m.invite_until > nowIso(), inviteUntil: m.invite ? m.invite_until : null, createdAt: m.created_at, createdBy: m.created_by, lastLogin: m.last_login });
const row = id => kdb().prepare('SELECT * FROM members WHERE id = ?').get(id);

export const listMembers = () => kdb().prepare('SELECT * FROM members ORDER BY disabled, name COLLATE NOCASE').all().map(pub);
export const getMember = id => pub(row(id));
export const memberCount = () => kdb().prepare('SELECT COUNT(*) n FROM members').get().n;
const activeAdmins = () => kdb().prepare("SELECT COUNT(*) n FROM members WHERE role = 'admin' AND disabled = 0").get().n;

function newInvite(id) {
  const token = randomToken(), until = new Date(Date.now() + INVITE_HOURS * 3600e3).toISOString();
  kdb().prepare('UPDATE members SET invite = ?, invite_until = ?, totp = ?, totp_last = 0 WHERE id = ?').run(sha(token), until, newTotpSecret(), id);
  return { token, until };
}

/** Creates a member that still has to accept the invite. Returns { member, invite: { token, until } }. */
export function createMember({ username, name, role = 'anggota' } = {}, by = null) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(u)) throw fail('Username 2–32 karakter: huruf kecil, angka, titik, minus, garis bawah.');
  const n = String(name || '').trim().slice(0, 60) || u;
  if (!ROLES.includes(role)) throw fail('Peran harus admin atau anggota.');
  if (kdb().prepare('SELECT 1 FROM members WHERE username = ?').get(u)) throw fail('Username sudah dipakai.', 409);
  if (kdb().prepare('SELECT 1 FROM members WHERE name = ? COLLATE NOCASE').get(n)) throw fail('Nama tampilan sudah dipakai anggota lain.', 409);
  const id = 'm' + crypto.randomBytes(6).toString('hex');
  kdb().prepare('INSERT INTO members (id, username, name, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, u, n, role, nowIso(), by);
  const invite = newInvite(id);
  return { member: getMember(id), invite };
}

export function updateMember(id, { name, role, disabled } = {}) {
  const m = row(id); if (!m) throw fail('Anggota tidak ditemukan.', 404);
  const next = { name: name === undefined ? m.name : String(name).trim().slice(0, 60), role: role === undefined ? m.role : role, disabled: disabled === undefined ? m.disabled : disabled ? 1 : 0 };
  if (!next.name) throw fail('Nama tidak boleh kosong.');
  if (!ROLES.includes(next.role)) throw fail('Peran harus admin atau anggota.');
  if (next.name !== m.name && kdb().prepare('SELECT 1 FROM members WHERE name = ? COLLATE NOCASE AND id != ?').get(next.name, id)) throw fail('Nama tampilan sudah dipakai anggota lain.', 409);
  const losesAdmin = m.role === 'admin' && !m.disabled && (next.role !== 'admin' || next.disabled);
  if (losesAdmin && activeAdmins() <= 1) throw fail('Harus tersisa minimal satu admin aktif.', 409);
  kdb().prepare('UPDATE members SET name = ?, role = ?, disabled = ? WHERE id = ?').run(next.name, next.role, next.disabled, id);
  if (next.disabled || next.role !== m.role) revokeSessions(id);
  return getMember(id);
}

/** Forgets the password and 2FA, signs the member out everywhere, and hands back a fresh invite. */
export function resetMember(id) {
  if (!row(id)) throw fail('Anggota tidak ditemukan.', 404);
  kdb().prepare('UPDATE members SET pass = NULL, active = 0 WHERE id = ?').run(id);
  revokeSessions(id);
  const invite = newInvite(id);
  return { member: getMember(id), invite };
}

/* ---------------- invites ---------------- */
function byInvite(token) {
  if (!token || typeof token !== 'string') return null;
  const m = kdb().prepare('SELECT * FROM members WHERE invite = ?').get(sha(token));
  return m && m.invite_until > nowIso() && !m.disabled ? m : null;
}
/** What the invite page shows: who it is for and the TOTP secret to scan. */
export function inviteInfo(token) {
  const m = byInvite(token);
  return m ? { member: pub(m), secret: m.totp, otpauth: otpauthUrl(m.totp, m.username) } : null;
}
/** Sets the password, confirms 2FA with a first code, and signs in. Returns { member, cookie, until }. */
export async function acceptInvite(token, { password, code, ip = null, ua = null } = {}) {
  const m = byInvite(token);
  if (!m) throw fail('Undangan tidak berlaku lagi. Minta link baru ke admin.', 410);
  const bad = passwordProblem(password, m.username); if (bad) throw fail(bad);
  const step = totpMatch(m.totp, code);
  if (step == null) throw fail('Kode 2FA salah. Pastikan jam di HP benar, lalu coba kode berikutnya.');
  kdb().prepare('UPDATE members SET pass = ?, active = 1, invite = NULL, invite_until = NULL, totp_last = ? WHERE id = ?').run(await hashPassword(password), step, m.id);
  return { member: getMember(m.id), ...openSession(m.id, { ip, ua }) };
}

/* ---------------- sign in / sessions ---------------- */
export const SESSION_DAYS = 14;
function openSession(memberId, { ip, ua, days = SESSION_DAYS } = {}) {
  const cookie = randomToken(), until = new Date(Date.now() + days * 86400e3).toISOString();
  kdb().prepare('INSERT INTO member_sessions (id, member, created_at, seen_at, until, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(cookie), memberId, nowIso(), nowIso(), until, ip, String(ua || '').slice(0, 200));
  kdb().prepare('UPDATE members SET last_login = ? WHERE id = ?').run(nowIso(), memberId);
  return { cookie, until };
}

/**
 * One message for every failure so the form does not tell which part was wrong.
 * Returns { member, cookie, until } or throws (code 401, or 429 when locked).
 */
export async function login({ username, password, code, ip = null, ua = null, days } = {}) {
  const u = String(username || '').trim().toLowerCase();
  if (over(userFails, u, USER_MAX) || (ip && over(ipFails, ip, IP_MAX))) throw fail('Terlalu banyak percobaan. Coba lagi 15 menit lagi.', 429);
  const m = u ? kdb().prepare('SELECT * FROM members WHERE username = ?').get(u) : null;
  const okPass = m?.pass ? await checkPassword(password, m.pass) : (await checkPassword(password, await dummy()), false);
  const step = okPass && m.active && !m.disabled ? totpMatch(m.totp, code) : null;
  // a code is single use: the same or an older step is refused even inside its window
  if (!okPass || !m.active || m.disabled || step == null || step <= (m.totp_last || 0)) {
    bump(userFails, u); if (ip) bump(ipFails, ip);
    throw fail('Username, password, atau kode 2FA salah.', 401);
  }
  userFails.delete(u);
  kdb().prepare('UPDATE members SET totp_last = ? WHERE id = ?').run(step, m.id);
  return { member: getMember(m.id), ...openSession(m.id, { ip, ua, days }) };
}

/** The member behind a session cookie, or null. Touches seen_at at most once a minute. */
export function memberForCookie(cookie) {
  if (!cookie) return null;
  const id = sha(cookie);
  const s = kdb().prepare('SELECT * FROM member_sessions WHERE id = ?').get(id);
  if (!s || s.until <= nowIso()) return null;
  const m = row(s.member);
  if (!m || m.disabled || !m.active) return null;
  if (Date.now() - Date.parse(s.seen_at) > 60e3) kdb().prepare('UPDATE member_sessions SET seen_at = ? WHERE id = ?').run(nowIso(), id);
  return { id: m.id, username: m.username, name: m.name, role: m.role };
}
export function logout(cookie) { if (cookie) kdb().prepare('DELETE FROM member_sessions WHERE id = ?').run(sha(cookie)); }
export function revokeSessions(memberId) { kdb().prepare('DELETE FROM member_sessions WHERE member = ?').run(memberId); }
export const sessionsOf = memberId => kdb().prepare('SELECT created_at, seen_at, until, ip, ua FROM member_sessions WHERE member = ? AND until > ? ORDER BY seen_at DESC').all(memberId, nowIso());

/** Change your own password: needs the current one and a fresh code. Other sessions are signed out. */
export async function changePassword(memberId, { current, next, code, keepCookie } = {}) {
  const m = row(memberId); if (!m) throw fail('Anggota tidak ditemukan.', 404);
  if (!(await checkPassword(current, m.pass))) throw fail('Password sekarang salah.', 401);
  const step = totpMatch(m.totp, code);
  if (step == null || step <= (m.totp_last || 0)) throw fail('Kode 2FA salah atau sudah dipakai.', 401);
  const bad = passwordProblem(next, m.username); if (bad) throw fail(bad);
  kdb().prepare('UPDATE members SET pass = ?, totp_last = ? WHERE id = ?').run(await hashPassword(next), step, memberId);
  kdb().prepare('DELETE FROM member_sessions WHERE member = ? AND id != ?').run(memberId, keepCookie ? sha(keepCookie) : '');
}
