// Context health of a session, read from the tail of its Claude Code transcript (JSONL).
// The file is scanned incrementally (only bytes appended since the last look), so asking again is cheap.
import fs from 'node:fs';

// Context window per model, first match wins. Transcripts record the bare model id (no "[1m]"), so a window that
// is already exceeded is taken as the 1M variant. Edit this table when a new model changes the window.
export const WINDOWS = [
  [/\[1m\]/i, 1_000_000],
];
export const DEFAULT_WINDOW = 200_000;
const BIG_WINDOW = 1_000_000;

// upper bounds (percent, exclusive) of each level
export const LEVELS = [[50, 'segar'], [75, 'sedang'], [90, 'lelah'], [Infinity, 'kritis']];

export function contextLimit(model, used = 0) {
  const m = String(model || '');
  const hit = WINDOWS.find(([re]) => re.test(m));
  const lim = hit ? hit[1] : DEFAULT_WINDOW;
  return used > lim ? Math.max(lim, BIG_WINDOW) : lim;
}
export const healthLevel = pct => LEVELS.find(([max]) => pct < max)[1];

const FIRST_SCAN_MAX = 32 * 1024 * 1024; // a huge transcript is only counted from its last 32 MB the first time
const CHUNK = 4 * 1024 * 1024;
const states = new Map();

function fresh() { return { off: 0, boundary: 0, summary: 0, streak: 0, last: null, rest: Buffer.alloc(0) }; }

function eat(st, line) {
  if (line.includes('"compact_boundary"')) st.boundary++;
  else if (line.includes('"isCompactSummary":true')) st.summary++;
  const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"');
  const isResult = !isAssistant && line.includes('"tool_result"');
  if (!isAssistant && !isResult) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  if (d.isSidechain) return;
  if (isAssistant && d.type === 'assistant') {
    const u = d.message?.usage;
    const model = d.message?.model;
    if (!u || model === '<synthetic>' || d.isApiErrorMessage) return;
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (used > 0) st.last = { used, model: model || null, at: d.timestamp || null };
  } else if (d.type === 'user' && Array.isArray(d.message?.content)) {
    for (const b of d.message.content) if (b?.type === 'tool_result') st.streak = b.is_error ? st.streak + 1 : 0;
  }
}

function scan(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { states.delete(file); return null; }
  let st = states.get(file);
  if (st && size < st.off) st = null; // truncated or replaced
  if (!st) {
    st = fresh();
    st.off = Math.max(0, size - FIRST_SCAN_MAX);
    st.skipFirst = st.off > 0; // we landed mid-line
  }
  states.delete(file); states.set(file, st); // most recently used last
  if (states.size > 200) states.delete(states.keys().next().value);
  if (st.off >= size && !st.rest.length) return st;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = st.off + st.rest.length;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const all = st.rest.length ? Buffer.concat([st.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = all.lastIndexOf(10);
      if (nl < 0) { st.rest = Buffer.from(all); continue; }
      const lines = all.subarray(0, nl).toString('utf8').split('\n');
      if (st.skipFirst) { lines.shift(); st.skipFirst = false; }
      for (const line of lines) if (line) eat(st, line);
      st.rest = Buffer.from(all.subarray(nl + 1));
    }
    st.off = pos - st.rest.length;
  } finally { fs.closeSync(fd); }
  return st;
}

export const EMPTY = { ctx: null, health: null, errStreak: 0, compactions: 0 };

/** { ctx:{used,limit,pct,at}|null, health:'segar'|'sedang'|'lelah'|'kritis'|null, errStreak, compactions } */
export function sessionHealth(file, model = null) {
  if (!file) return EMPTY;
  let st;
  try { st = scan(file); } catch { return EMPTY; }
  if (!st) return EMPTY;
  const compactions = Math.max(st.boundary, st.summary);
  if (!st.last) return { ...EMPTY, errStreak: st.streak, compactions };
  const limit = contextLimit(/\[1m\]/i.test(model || '') ? model : st.last.model, st.last.used);
  const pct = Math.round(st.last.used / limit * 1000) / 10;
  return { ctx: { used: st.last.used, limit, pct, at: st.last.at }, health: healthLevel(pct), errStreak: st.streak, compactions };
}
