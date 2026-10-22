// Push transcript changes to the UI instead of letting every chat view poll.
// One watcher per transcript file of a live session (fs.watch, with a 1 s stat sweep as fallback);
// a change is debounced and broadcast as { t: 'transcript', office, sid, size }.
// Also follows a session onto its new transcript after /clear, /compact or a resume when no hook said so.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './config.js';
import { globalDb, run } from './db.js';
import { live, bus, serialize } from './live.js';
import { isRollout } from './codex.js';
import { claudePid } from './termapp.js';

const DEBOUNCE_MS = 200;
const SWEEP_MS = 1000;
const STALE_MS = 4000;    // transcript quiet this long -> look for a successor
const SUCCESSOR_EVERY = 5000;

/** Trailing debounce; d.cancel() drops a pending call. */
export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.pending = () => t !== null;
  return d;
}

/** The sessionId a Claude Code transcript declares in its first lines (null if none). */
export function headSessionId(text) {
  const m = /"sessionId"\s*:\s*"([0-9a-f-]{8,})"/i.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Should a session move from `current` to the conversation its claude process now reports?
 * Only when that process record (~/.claude/sessions/<pid>.json) names another sessionId whose
 * file sits in the same project folder, declares that same sessionId in its head, is at least as
 * fresh as the current one, and no other live session owns it. Returns the new file or null.
 *   current: { file, mtimeMs }   reported: sessionId from the process record
 *   cand: { exists, headSid, mtimeMs } for path.join(dirname(current.file), reported + '.jsonl')
 *   others: { sids: Set, files: Set } of the other live sessions
 */
export function successorFor(current, reported, cand, others) {
  if (!current?.file || !reported || !cand?.exists) return null;
  if (!/^[0-9a-f-]{8,}$/i.test(reported)) return null;
  const file = path.join(path.dirname(current.file), `${reported}.jsonl`);
  if (file === current.file || path.basename(current.file, '.jsonl') === reported) return null;
  if (cand.headSid !== reported) return null;
  if ((cand.mtimeMs || 0) < (current.mtimeMs || 0)) return null;
  if (others?.sids?.has(reported) || others?.files?.has(file)) return null;
  return file;
}

const readHead = (file, n = 16384) => {
  try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, k); } finally { fs.closeSync(fd); } } catch { return ''; }
};

/** sessionId that the claude process behind a live session currently writes to (from ~/.claude/sessions). */
function reportedSessionId(s) {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  if (s.tmux) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch { return null; }
    let best = null;
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (typeof r.tmux === 'string' && r.tmux.split(':')[0] === s.tmux && (!best || (r.updatedAt || 0) > (best.updatedAt || 0))) best = r;
      } catch {}
    }
    if (best) try { process.kill(best.pid, 0); } catch { best = null; }
    return best?.sessionId || null;
  }
  if (s.tty) {
    const pid = claudePid(s.tty);
    if (!pid) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')).sessionId || null; } catch { return null; }
  }
  return null;
}

const watchers = new Map(); // file -> { w, poll, size, mtimeMs, changedAt, fire }

function statOf(file) { try { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } }

function emitFor(file, size) {
  for (const s of live.values()) if (s.transcript === file) bus.emit('msg', { t: 'transcript', office: s.office, sid: s.sid, size });
}

function check(file) {
  const w = watchers.get(file); if (!w) return;
  const st = statOf(file); if (!st) return;
  if (st.size === w.size && st.mtimeMs === w.mtimeMs) return;
  w.size = st.size; w.mtimeMs = st.mtimeMs; w.changedAt = Date.now();
  emitFor(file, st.size);
}

function watch(file) {
  if (watchers.has(file)) return;
  const st = statOf(file);
  const w = { w: null, poll: false, size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? 0, changedAt: Date.now(), lastSucc: 0 };
  w.fire = debounce(() => check(file), DEBOUNCE_MS);
  try { w.w = fs.watch(file, { persistent: false }, () => w.fire()); w.w.on('error', () => { try { w.w.close(); } catch {} w.w = null; }); }
  catch { try { fs.watchFile(file, { interval: SWEEP_MS, persistent: false }, () => w.fire()); w.poll = true; } catch {} }
  watchers.set(file, w);
}

function unwatch(file) {
  const w = watchers.get(file); if (!w) return;
  w.fire.cancel();
  try { w.w?.close(); } catch {}
  if (w.poll) try { fs.unwatchFile(file); } catch {}
  watchers.delete(file);
}

function maybeFollow(s, w) {
  const now = Date.now();
  if (isRollout(s.transcript) || s.engine === 'codex') return;
  if (now - w.changedAt < STALE_MS || now - (w.lastSucc || 0) < SUCCESSOR_EVERY) return;
  w.lastSucc = now;
  const reported = reportedSessionId(s);
  if (!reported) return;
  const candFile = path.join(path.dirname(s.transcript), `${reported}.jsonl`);
  const cst = statOf(candFile);
  const cand = { exists: !!cst, mtimeMs: cst?.mtimeMs || 0, headSid: cst ? headSessionId(readHead(candFile)) : null };
  const others = { sids: new Set(), files: new Set() };
  for (const x of live.values()) if (x !== s && x.status !== 'ended') { others.sids.add(x.sid); if (x.transcript) others.files.add(x.transcript); }
  const next = successorFor({ file: s.transcript, mtimeMs: w.mtimeMs }, reported, cand, others);
  if (!next) return;
  s.transcript = next;
  try { run(globalDb(), 'UPDATE sessions SET transcript = ? WHERE sid = ?', next, s.sid); } catch {}
  bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
  watch(next);
  bus.emit('msg', { t: 'transcript', office: s.office, sid: s.sid, size: cst.size, switched: true });
}

export function sweep() {
  const want = new Set();
  for (const s of live.values()) {
    if (!s.transcript || s.status === 'ended' || s.placeholder) continue;
    want.add(s.transcript);
    watch(s.transcript);
    check(s.transcript); // fallback when fs.watch misses an append
    const w = watchers.get(s.transcript);
    if (w) try { maybeFollow(s, w); } catch {}
  }
  for (const f of [...watchers.keys()]) if (!want.has(f)) unwatch(f);
}

let timer = null;
export function startTailWatch() {
  if (timer) return;
  timer = setInterval(sweep, SWEEP_MS); timer.unref?.();
  // a hook that names a new transcript_path: watch it right away
  bus.on('msg', m => { if (m.t === 'session' && m.session?.sid) { const s = live.get(m.session.sid); if (s?.transcript && !watchers.has(s.transcript) && s.status !== 'ended') setImmediate(sweep); } });
}
export function stopTailWatch() { clearInterval(timer); timer = null; for (const f of [...watchers.keys()]) unwatch(f); }
