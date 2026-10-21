import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, OFFICE_DIR, ensureDirs } from './config.js';

export const nowIso = () => new Date().toISOString();
export const newId = (p = '') => p + crypto.randomBytes(5).toString('hex');

const GLOBAL_MIGRATIONS = [
  `CREATE TABLE offices (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, style TEXT, created_at TEXT, layout TEXT, hidden INTEGER DEFAULT 0);
   CREATE TABLE sessions (sid TEXT PRIMARY KEY, office TEXT, room TEXT, role TEXT, cwd TEXT, transcript TEXT, source TEXT, tmux TEXT, title TEXT,
     model TEXT, status TEXT, started_at TEXT, last_seen TEXT, ended_at TEXT, first_prompt TEXT);
   CREATE INDEX sessions_office ON sessions(office, last_seen);
   CREATE TABLE usage (sid TEXT, office TEXT, role TEXT, model TEXT, day TEXT, msgs INTEGER DEFAULT 0, input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
     cache_w INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cost REAL DEFAULT 0, PRIMARY KEY (sid, model, day));
   CREATE INDEX usage_office_day ON usage(office, day);
   CREATE TABLE usage_files (path TEXT PRIMARY KEY, offset INTEGER, size INTEGER, mtime REAL, sid TEXT, office TEXT, last_msg TEXT);
   CREATE TABLE inbox (id TEXT PRIMARY KEY, office TEXT, sid TEXT, role TEXT, tool TEXT, input TEXT, summary TEXT, created_at TEXT,
     status TEXT, decided_at TEXT, source TEXT);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);`,
  `ALTER TABLE sessions ADD COLUMN tty TEXT;`,
  `ALTER TABLE offices ADD COLUMN fav INTEGER DEFAULT 0;`,
];

const OFFICE_MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT, model TEXT, room TEXT, color TEXT, hair TEXT, skin TEXT, hair_style TEXT,
     tie INTEGER DEFAULT 0, is_mgr INTEGER DEFAULT 0, persona TEXT, skills TEXT DEFAULT '[]', notes TEXT DEFAULT '', budget_usd REAL,
     created_at TEXT, ord INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);
   CREATE TABLE shifts (sid TEXT PRIMARY KEY, role TEXT, title TEXT, card TEXT, started_at TEXT, ended_at TEXT, cwd TEXT, tmux TEXT, status TEXT);
   CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, desc TEXT DEFAULT '', col INTEGER DEFAULT 0, who TEXT, repo TEXT, prio TEXT DEFAULT 'P2',
     due TEXT DEFAULT '', blocked TEXT DEFAULT '', epic INTEGER DEFAULT 0, epic_id TEXT, files INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT,
     moved_by TEXT, moved_at TEXT, ord REAL DEFAULT 0, archived INTEGER DEFAULT 0);
   CREATE TABLE card_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, text TEXT, done INTEGER DEFAULT 0, ord INTEGER DEFAULT 0);
   CREATE TABLE card_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, who TEXT, text TEXT, at TEXT);
   CREATE TABLE card_hist (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, who TEXT, text TEXT, at TEXT);
   CREATE TABLE card_links (card_id TEXT, kind TEXT, value TEXT, at TEXT);
   CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT DEFAULT '', body TEXT DEFAULT '', color TEXT DEFAULT 'kuning', tags TEXT DEFAULT '[]',
     pinned INTEGER DEFAULT 0, wall INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, room TEXT, author TEXT,
     created_at TEXT, updated_at TEXT);
   CREATE TABLE wiki (slug TEXT PRIMARY KEY, title TEXT, body TEXT, author TEXT, created_at TEXT, updated_at TEXT);
   CREATE TABLE wiki_revs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, title TEXT, body TEXT, author TEXT, at TEXT, msg TEXT);
   CREATE TABLE meetings (id TEXT PRIMARY KEY, topic TEXT, agenda TEXT, status TEXT, participants TEXT, rounds INTEGER, chair TEXT, created_at TEXT,
     ended_at TEXT, summary TEXT, decisions TEXT DEFAULT '[]', actions TEXT DEFAULT '[]', cost REAL DEFAULT 0, wiki_slug TEXT, error TEXT);
   CREATE TABLE meeting_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, who TEXT, text TEXT, at TEXT, cost REAL DEFAULT 0, kind TEXT);
   CREATE TABLE news (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, at TEXT, author TEXT);
   CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT, text TEXT, at TEXT, kind TEXT);
   CREATE INDEX log_at ON log(id DESC);`,
  // who a role reports to (its boss); null = reports to the manager
  `ALTER TABLE roles ADD COLUMN reports_to TEXT;`,
];

function migrate(db, steps) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < steps.length; i++) {
    db.exec('BEGIN');
    try { db.exec(steps[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

let gdb = null;
export function globalDb() {
  if (!gdb) { ensureDirs(); gdb = migrate(new DatabaseSync(path.join(DATA_DIR, 'kantor.db')), GLOBAL_MIGRATIONS); }
  return gdb;
}

const odbs = new Map();
export function officeDb(id) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('id kantor tidak valid');
  let db = odbs.get(id);
  if (!db) { ensureDirs(); db = migrate(new DatabaseSync(path.join(OFFICE_DIR, `${id}.db`)), OFFICE_MIGRATIONS); odbs.set(id, db); }
  return db;
}

export function closeAll() {
  for (const db of odbs.values()) try { db.close(); } catch {}
  odbs.clear();
  if (gdb) try { gdb.close(); } catch {}
  gdb = null;
}

// small helpers
export const all = (db, sql, ...a) => db.prepare(sql).all(...a);
export const one = (db, sql, ...a) => db.prepare(sql).get(...a);
export const run = (db, sql, ...a) => db.prepare(sql).run(...a);
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
