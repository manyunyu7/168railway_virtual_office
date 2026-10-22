// Messages the owner sent to a session (sessionAction 'text'). While Claude is busy, Claude Code queues them and the
// transcript does not show them yet; this keeps them visible in the chat until the session actually reads them.
import { globalDb, all, one, run, nowIso, newId } from './db.js';
import { bus, live } from './live.js';
import { readTranscript, unpaste } from './transcript.js';

const norm = t => unpaste(t).replace(/\s+/g, ' ').trim();
const SAFE_MS = 10_000; // an unmatched prompt may stand for a message sent at least this long ago
const KEEP = 200;

const item = r => r && { id: r.id, sid: r.sid, text: r.text, at: r.at, status: r.status, readAt: r.read_at || null };
const officeOf = sid => live.get(sid)?.office || one(globalDb(), 'SELECT office FROM sessions WHERE sid = ?', sid)?.office || null;
const emit = r => { const it = item(r); bus.emit('msg', { t: 'outbox', office: officeOf(r.sid), sid: r.sid, item: it }); return it; };
const get = id => one(globalDb(), 'SELECT * FROM outbox WHERE id = ?', id);

/** Remember a message that was just typed into the session. */
export function recordOutgoing(sid, text) {
  const t = String(text ?? '').slice(0, 4000);
  if (!sid || !norm(t)) return null;
  const id = newId('q');
  run(globalDb(), "INSERT INTO outbox (id, sid, text, at, status) VALUES (?, ?, ?, ?, 'pending')", id, sid, t, nowIso());
  run(globalDb(), 'DELETE FROM outbox WHERE sid = ? AND id NOT IN (SELECT id FROM outbox WHERE sid = ? ORDER BY at DESC, rowid DESC LIMIT ?)', sid, sid, KEEP);
  return emit(get(id));
}

const pendingOf = sid => all(globalDb(), "SELECT * FROM outbox WHERE sid = ? AND status = 'pending' ORDER BY at, rowid", sid);
function markRead(r) {
  run(globalDb(), "UPDATE outbox SET status = 'read', read_at = ? WHERE id = ? AND status = 'pending'", nowIso(), r.id);
  return emit(get(r.id));
}
// either side may be clipped (transcript items end in "…", the outbox keeps 4000 chars)
const unclip = t => t.replace(/…$/, '').trim();
export const same = (a, b) => { a = unclip(norm(a)); b = unclip(norm(b)); return a === b || (a.length > 20 && b.length > 20 && (a.startsWith(b) || b.startsWith(a))); };

/** A UserPromptSubmit hook arrived: the oldest identical pending message was read. */
export function promptSeen(sid, prompt, now = Date.now()) {
  const p = norm(prompt);
  if (!p) return null;
  const pend = pendingOf(sid);
  let hit = pend.find(r => same(norm(r.text), p));
  // no identical text (Claude Code rewrote it): the oldest message that has been waiting long enough
  if (!hit) hit = pend.find(r => now - Date.parse(r.at) >= SAFE_MS);
  return hit ? markRead(hit) : null;
}

/** Pending messages whose text now appears as a user message in the transcript are read. Returns how many changed. */
export function reconcile(sid) {
  const pend = pendingOf(sid);
  if (!pend.length) return 0;
  const file = live.get(sid)?.transcript || one(globalDb(), 'SELECT transcript FROM sessions WHERE sid = ?', sid)?.transcript;
  if (!file) return 0;
  const users = readTranscript(file, 120).items.filter(i => i.k === 'user');
  let n = 0;
  const used = new Set();
  for (const r of pend) { // oldest first, each transcript line serves one message
    const t = norm(r.text).slice(0, 2000);
    const idx = users.findIndex((u, i) => !used.has(i) && (!u.at || Date.parse(u.at) >= Date.parse(r.at) - 2000) && same(norm(u.s), t));
    if (idx >= 0) { used.add(idx); markRead(r); n++; }
  }
  return n;
}

/** Pending + read, newest 50, oldest first. */
export function listOutbox(sid) {
  reconcile(sid);
  return { items: all(globalDb(), "SELECT * FROM outbox WHERE sid = ? AND status IN ('pending', 'read') ORDER BY at DESC, rowid DESC LIMIT 50", sid).reverse().map(item) };
}

/**
 * Cancel hides a pending message in the office only. Once Claude Code has queued it there is no safe way to take it back
 * (Esc also interrupts the running turn, and editing the queue means typing into its input), so Claude may still read it.
 */
export function cancelOutgoing(sid, id) {
  const r = get(id);
  if (!r || r.sid !== sid) throw Object.assign(new Error('Pesan tidak ditemukan'), { code: 404 });
  if (r.status !== 'pending') throw new Error(r.status === 'read' ? 'Pesan sudah dibaca Claude' : 'Pesan sudah dibatalkan');
  run(globalDb(), "UPDATE outbox SET status = 'cancelled' WHERE id = ?", id);
  return { ok: true, item: emit(get(id)), stillQueued: true, note: 'Disembunyikan dari kantor saja. Pesan yang sudah masuk antrean Claude Code tidak bisa dicabut dari sini, jadi Claude masih mungkin membacanya.' };
}

let started = false;
export function startOutbox() {
  if (started) return;
  started = true;
  bus.on('prompt', ev => { try { promptSeen(ev.sid, ev.prompt); } catch (e) { console.error(`outbox: ${e.message}`); } });
  // the transcript catches up without a hook (resumed, typed in the terminal)
  setInterval(() => {
    try { for (const r of all(globalDb(), "SELECT DISTINCT sid FROM outbox WHERE status = 'pending'")) reconcile(r.sid); } catch {}
  }, 15e3).unref();
}
