// Audit log: who did what, kept apart from the office data in ~/.kantor-claude/audit.db.
// Append-only (triggers refuse UPDATE/DELETE) and hash-chained: every row stores the hash of the one before,
// so an edited or removed row shows up in verify(). The real protection on a shared server is that the
// agents run as a different Unix user than the daemon (see docs/AKUN.md); the chain makes tampering visible.
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, ensureDirs } from './config.js';
import { actor, LOCAL } from './actor.js';

const MIGRATIONS = [
  `CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, actor TEXT NOT NULL, actor_kind TEXT NOT NULL,
     kind TEXT NOT NULL, office TEXT, sid TEXT, text TEXT NOT NULL, meta TEXT, ip TEXT, origin TEXT, prev TEXT NOT NULL, hash TEXT NOT NULL);
   CREATE INDEX audit_actor ON audit(actor_id, id);
   CREATE INDEX audit_kind ON audit(kind, id);
   CREATE INDEX audit_office ON audit(office, id);
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit tidak boleh diubah'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit tidak boleh dihapus'); END;`,
];

let db = null;
function adb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(path.join(DATA_DIR, 'audit.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) { db.exec('BEGIN'); try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  return db;
}
export function closeAudit() { if (db) try { db.close(); } catch {} db = null; }

const GENESIS = '0'.repeat(64);
const FIELDS = ['at', 'actor_id', 'actor', 'actor_kind', 'kind', 'office', 'sid', 'text', 'meta', 'ip', 'origin'];
const digest = (prev, row) => crypto.createHash('sha256').update(prev + '\n' + JSON.stringify(FIELDS.map(f => row[f] ?? null))).digest('hex');

/* ---------------- writing ---------------- */
const SECRET_KEY = /pass|kode|code|token|secret|otp|totp|cookie/i;
/** Shrinks a request body for the log: secrets masked, long strings cut, the whole thing capped. */
export function summarize(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => summarize(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = SECRET_KEY.test(k) ? '•••' : summarize(x, depth + 1);
    return o;
  }
  return String(v);
}

/**
 * Appends one row. The actor comes from the running request unless `as` is given.
 * kind: api | masuk | akun | terminal | prompt | izin | agen | …
 */
export function record(kind, { text, office = null, sid = null, meta = null, as = null, ip = null, origin = null } = {}) {
  const a = as || actor() || LOCAL;
  const d = adb();
  const row = {
    at: new Date().toISOString(), actor_id: a.id || null, actor: a.name, actor_kind: a.kind, kind,
    office, sid, text: String(text || '').slice(0, 4000), meta: meta == null ? null : JSON.stringify(summarize(meta)).slice(0, 4000),
    ip: ip || a.ip || null, origin: origin || null,
  };
  // the chain is read and extended inside one transaction so two writers never share a `prev`
  d.exec('BEGIN IMMEDIATE');
  try {
    const prev = d.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash || GENESIS;
    row.prev = prev; row.hash = digest(prev, row);
    const r = d.prepare(`INSERT INTO audit (${FIELDS.join(', ')}, prev, hash) VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?)`).run(...FIELDS.map(f => row[f]), row.prev, row.hash);
    d.exec('COMMIT');
    return { id: Number(r.lastInsertRowid), ...row };
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} console.error('audit gagal ditulis:', e.message); return null; }
}

/* ---------------- reading ---------------- */
/**
 * Newest first. `self` limits the rows to one member (what a non-admin may see).
 * Filters: actor (member id), kind, office, sid, q (text contains), from/to (ISO), before (id, for paging), limit.
 */
export function query({ self = null, actor: actorId = null, kind = null, office = null, sid = null, q = null, from = null, to = null, before = null, limit = 100 } = {}) {
  const w = [], a = [];
  const add = (sql, v) => { w.push(sql); a.push(v); };
  if (self) add('actor_id = ?', self);
  // '_lain' = rows without a member: the local owner, the daemon, agents, unattributed prompts
  else if (actorId === '_lain') w.push('actor_id IS NULL');
  else if (actorId) add('actor_id = ?', actorId);
  if (kind) add('kind = ?', kind);
  if (office) add('office = ?', office);
  if (sid) add('sid = ?', sid);
  if (q) add("text LIKE ? ESCAPE '\\'", '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%');
  if (from) add('at >= ?', from);
  if (to) add('at <= ?', to);
  if (before) add('id < ?', Number(before));
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const rows = adb().prepare(`SELECT id, at, actor_id, actor, actor_kind, kind, office, sid, text, meta, ip, origin FROM audit ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${n + 1}`).all(...a);
  const more = rows.length > n;
  return { rows: rows.slice(0, n).map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })), more };
}

const csvCell = v => { const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(rows) {
  const cols = ['id', 'at', 'actor', 'actor_kind', 'kind', 'office', 'sid', 'text', 'origin', 'ip', 'meta'];
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** Walks the whole chain. ok=false names the first row whose hash or link does not match. */
export function verify() {
  let prev = GENESIS, count = 0;
  for (const r of adb().prepare(`SELECT id, ${FIELDS.join(', ')}, prev, hash FROM audit ORDER BY id`).iterate()) {
    if (r.prev !== prev) return { ok: false, count, brokenAt: r.id, why: 'rantai terputus (ada baris yang hilang atau disisipkan)' };
    if (digest(prev, r) !== r.hash) return { ok: false, count, brokenAt: r.id, why: 'isi baris berubah' };
    prev = r.hash; count++;
  }
  return { ok: true, count, last: prev };
}

/* ---------------- who typed the prompt ---------------- */
// Keystrokes from the browser terminal and text sent from the panel mark the tmux pane with the person behind them.
// When Claude then reports UserPromptSubmit, the prompt is credited to whoever typed in that pane last.
const TYPED_MS = 2 * 60 * 1000;
const typed = new Map();          // tmux name -> { actor, at }
const lastOrigin = new Map();     // sid -> person name whose prompt this session is working on
const roleOrigin = new Map();     // `${office}:${roleId}` -> person name that set an agent message to that role in motion

export function markTyping(tmuxName, a) { if (tmuxName && a) typed.set(tmuxName, { actor: a, at: Date.now() }); }

/** Called by live.js for every UserPromptSubmit with human text. Returns the row written. */
export function recordPrompt(session, prompt) {
  if (!session || !prompt) return null;
  const t = session.tmux && typed.get(session.tmux);
  const fresh = t && Date.now() - t.at < TYPED_MS;
  const base = { office: session.office || null, sid: session.sid, meta: { role: session.role || null, tmux: session.tmux || null } };
  const text = String(prompt).slice(0, 2000);
  if (fresh) {
    typed.delete(session.tmux);
    lastOrigin.set(session.sid, t.actor.name);
    return record('prompt', { ...base, as: t.actor, text, origin: t.actor.name });
  }
  // nobody typed through the office: an agent message delivered into the pane, or someone attached to tmux directly
  const from = session.role && roleOrigin.get(`${session.office}:${session.role}`);
  if (from) lastOrigin.set(session.sid, from);
  return record('prompt', { ...base, as: { kind: 'system', id: null, name: from ? 'Pesan agen' : 'Tidak diketahui' }, text, origin: from || null });
}

export const originOf = sid => lastOrigin.get(sid) || null;
/** An agent (session `sid`) set work in motion for `roleId`: that role's next prompt inherits the same human origin. */
export function passOrigin(office, sid, roleId) {
  const o = originOf(sid);
  if (o && office && roleId) roleOrigin.set(`${office}:${roleId}`, o);
}
export function forgetSession(sid) { lastOrigin.delete(sid); }
