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
  `CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, ord INTEGER DEFAULT 0);
   CREATE TABLE playlist_items (playlist_id TEXT NOT NULL, path TEXT NOT NULL, ord INTEGER DEFAULT 0, PRIMARY KEY (playlist_id, path));`,
  // a session without a role can still work under someone (a temporary helper)
  `ALTER TABLE sessions ADD COLUMN boss TEXT;`,
  // things an agent opened for the user to look at (the floating viewer)
  `CREATE TABLE shows (id TEXT PRIMARY KEY, office TEXT, sid TEXT, who TEXT, kind TEXT, target TEXT, note TEXT, lines TEXT, at TEXT, seen INTEGER DEFAULT 0, closed INTEGER DEFAULT 0);`,
  // files in an agent conversation: dir 'in' = from the owner (inbox), 'out' = from the agent (outbox); meta = json (base folder, duration, frames, ...)
  `CREATE TABLE attachments (id TEXT PRIMARY KEY, sid TEXT, office TEXT, dir TEXT NOT NULL, path TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER, caption TEXT, at TEXT, meta TEXT);
   CREATE INDEX attachments_sid ON attachments(sid, at);`,
  // messages sent to a session; pending until the session reads them (status: pending | read | cancelled)
  `CREATE TABLE outbox (id TEXT PRIMARY KEY, sid TEXT NOT NULL, text TEXT, at TEXT, status TEXT DEFAULT 'pending', read_at TEXT);
   CREATE INDEX outbox_sid ON outbox(sid, at);`,
  // which coding agent runs the session: 'claude' (null) or 'codex'; effort = reasoning effort picked at start (codex)
  `ALTER TABLE sessions ADD COLUMN engine TEXT; ALTER TABLE sessions ADD COLUMN effort TEXT;`,
];

export const OFFICE_MIGRATIONS = [
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
  // look: outfit (kemeja|rok|dress|hoodie|jas), accessory (kacamata|anting|topi), headscarf colour
  `ALTER TABLE roles ADD COLUMN outfit TEXT; ALTER TABLE roles ADD COLUMN acc TEXT; ALTER TABLE roles ADD COLUMN hijab TEXT;`,
  // planning (timeline/gantt, labels, dependencies), files kept on disk, nested wiki pages
  `ALTER TABLE cards ADD COLUMN start TEXT DEFAULT '';
   ALTER TABLE cards ADD COLUMN est_days REAL;
   ALTER TABLE cards ADD COLUMN progress INTEGER;
   ALTER TABLE cards ADD COLUMN labels TEXT DEFAULT '[]';
   ALTER TABLE cards ADD COLUMN milestone INTEGER DEFAULT 0;
   ALTER TABLE cards ADD COLUMN cover TEXT;
   CREATE TABLE card_deps (card_id TEXT, dep_id TEXT, kind TEXT DEFAULT 'fs', PRIMARY KEY (card_id, dep_id));
   CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT, color TEXT, ord INTEGER DEFAULT 0);
   CREATE TABLE media (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, ext TEXT, by TEXT, at TEXT);
   CREATE TABLE media_use (media_id TEXT, kind TEXT, ref TEXT, at TEXT, PRIMARY KEY (media_id, kind, ref));
   ALTER TABLE wiki ADD COLUMN parent TEXT;
   ALTER TABLE wiki ADD COLUMN ord REAL DEFAULT 0;
   ALTER TABLE wiki ADD COLUMN icon TEXT;`,
  // long-running commands per room (npm run dev, …); pending = proposed by an agent, waiting for the user's approval
  `CREATE TABLE procs (id TEXT PRIMARY KEY, room TEXT NOT NULL, name TEXT NOT NULL, cmd TEXT NOT NULL, auto INTEGER DEFAULT 0, pending INTEGER DEFAULT 0, created_at TEXT);`,
  // playbooks: wiki pages a role follows (who holds it, when to use it, read in full, needs approval) + edit proposals from agents
  `ALTER TABLE wiki ADD COLUMN playbook INTEGER DEFAULT 0;
   ALTER TABLE wiki ADD COLUMN pb_roles TEXT DEFAULT '[]';
   ALTER TABLE wiki ADD COLUMN pb_when TEXT DEFAULT '';
   ALTER TABLE wiki ADD COLUMN pb_always INTEGER DEFAULT 0;
   ALTER TABLE wiki ADD COLUMN pb_approval INTEGER DEFAULT 0;
   CREATE TABLE wiki_proposals (id TEXT PRIMARY KEY, slug TEXT, title TEXT, body TEXT, reason TEXT, by TEXT, at TEXT, status TEXT DEFAULT 'baru', decided_at TEXT);`,
  // the engine a role runs on by default ('claude' | 'codex'; null = claude) and its reasoning effort (codex)
  `ALTER TABLE roles ADD COLUMN engine TEXT; ALTER TABLE roles ADD COLUMN effort TEXT;`,
  // pesan langsung antaragen: kind pesan|tanya|balasan, status menunggu|terkirim|dibaca|dibalas, reply_to = id pesan yang dibalas
  `CREATE TABLE dm (id TEXT PRIMARY KEY, from_role TEXT NOT NULL, to_role TEXT NOT NULL, kind TEXT DEFAULT 'pesan', text TEXT, card TEXT, reply_to TEXT,
     status TEXT DEFAULT 'menunggu', at TEXT, sent_at TEXT, read_at TEXT, replied_at TEXT);
   CREATE INDEX dm_pair ON dm(from_role, to_role, at);
   CREATE INDEX dm_to ON dm(to_role, status);`,
  // kind baru 'fyi' (tanpa balasan, tidak memicu turn); seen_at = kapan pesan muncul sebagai pengingat di tengah kerja; grp = id siaran
  `ALTER TABLE dm ADD COLUMN seen_at TEXT; ALTER TABLE dm ADD COLUMN grp TEXT;`,
  // banyak papan per kantor. cards.col = indeks kolom di papan kartu itu; cards.kind = jenis kolomnya (antre|siap|dikerjakan|review|selesai),
  // disimpan ganda supaya logika "selesai/WIP" tidak bergantung pada nomor kolom. Kartu lama masuk papan "utama" (template Dev, kolom 0..4 sama persis).
  // card_moves = riwayat pindah kolom yang terstruktur (metrik, segmen tahap di Timeline), diisi ulang dari card_hist lama.
  `CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT, template TEXT, columns TEXT NOT NULL, ord INTEGER DEFAULT 0,
     archived INTEGER DEFAULT 0, rooms TEXT DEFAULT '[]', roles TEXT DEFAULT '[]', created_at TEXT);
   INSERT OR IGNORE INTO boards (id, name, icon, color, template, columns, ord, created_at) VALUES ('utama', 'Utama', '▦', '#2F5D9E', 'dev',
     '[{"id":"backlog","name":"Backlog","kind":"antre"},{"id":"siap","name":"Siap","kind":"siap"},{"id":"dikerjakan","name":"Dikerjakan","kind":"dikerjakan"},{"id":"review","name":"Review","kind":"review"},{"id":"selesai","name":"Selesai","kind":"selesai"}]',
     0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
   ALTER TABLE cards ADD COLUMN board TEXT DEFAULT 'utama';
   ALTER TABLE cards ADD COLUMN kind TEXT DEFAULT 'antre';
   ALTER TABLE cards ADD COLUMN publish_at TEXT DEFAULT '';
   UPDATE cards SET board = 'utama' WHERE board IS NULL OR board = '';
   UPDATE cards SET col = MAX(0, MIN(4, COALESCE(col, 0)));
   UPDATE cards SET kind = CASE col WHEN 0 THEN 'antre' WHEN 1 THEN 'siap' WHEN 2 THEN 'dikerjakan' WHEN 3 THEN 'review' ELSE 'selesai' END;
   CREATE INDEX cards_board ON cards(board, archived);
   CREATE TABLE card_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, board TEXT, from_col INTEGER, to_col INTEGER, from_kind TEXT, to_kind TEXT,
     from_name TEXT, to_name TEXT, by TEXT, at TEXT);
   CREATE INDEX card_moves_card ON card_moves(card_id, at);
   INSERT INTO card_moves (card_id, board, from_col, to_col, from_kind, to_kind, from_name, to_name, by, at)
     SELECT card_id, 'utama', NULL, NULL, NULL, NULL, NULL, substr(text, 18), who, at FROM card_hist WHERE text LIKE 'membuat kartu di %';
   INSERT INTO card_moves (card_id, board, from_col, to_col, from_kind, to_kind, from_name, to_name, by, at)
     SELECT card_id, 'utama', NULL, NULL, NULL, NULL, substr(text, 13, instr(text, ' → ') - 13), substr(text, instr(text, ' → ') + 3), who, at
     FROM card_hist WHERE text LIKE 'memindahkan % → %' AND instr(text, ' → ') > 13;
   UPDATE card_moves SET from_col = CASE from_name WHEN 'Backlog' THEN 0 WHEN 'Siap' THEN 1 WHEN 'Dikerjakan' THEN 2 WHEN 'Review' THEN 3 WHEN 'Selesai' THEN 4 END,
     to_col = CASE to_name WHEN 'Backlog' THEN 0 WHEN 'Siap' THEN 1 WHEN 'Dikerjakan' THEN 2 WHEN 'Review' THEN 3 WHEN 'Selesai' THEN 4 END;
   UPDATE card_moves SET from_kind = CASE from_col WHEN 0 THEN 'antre' WHEN 1 THEN 'siap' WHEN 2 THEN 'dikerjakan' WHEN 3 THEN 'review' WHEN 4 THEN 'selesai' END,
     to_kind = CASE to_col WHEN 0 THEN 'antre' WHEN 1 THEN 'siap' WHEN 2 THEN 'dikerjakan' WHEN 3 THEN 'review' WHEN 4 THEN 'selesai' END;
   CREATE TRIGGER cards_kind_ins AFTER INSERT ON cards BEGIN
     UPDATE cards SET board = COALESCE(NULLIF(NEW.board, ''), 'utama'),
       kind = COALESCE((SELECT json_extract(columns, '$[' || NEW.col || '].kind') FROM boards WHERE id = COALESCE(NULLIF(NEW.board, ''), 'utama')), NEW.kind) WHERE id = NEW.id; END;
   CREATE TRIGGER cards_kind_upd AFTER UPDATE OF col, board ON cards BEGIN
     UPDATE cards SET kind = COALESCE((SELECT json_extract(columns, '$[' || NEW.col || '].kind') FROM boards WHERE id = NEW.board), NEW.kind) WHERE id = NEW.id; END;`,
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
