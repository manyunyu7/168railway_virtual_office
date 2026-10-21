import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { globalDb, officeDb, one, run, all, nowIso, newId } from './db.js';
import { officeForCwd, officeModel, roomForCwd } from './offices.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/** sid -> live session */
export const live = new Map();
/** inbox id -> resolver for a held PermissionRequest hook */
const held = new Map();

const shortStr = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function toolLabel(name, input = {}) {
  const base = p => p ? path.basename(String(p)) : '';
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return base(input.file_path || input.notebook_path);
    case 'Bash': return shortStr(input.command, 70);
    case 'Grep': return shortStr(input.pattern, 40);
    case 'Glob': return shortStr(input.pattern, 40);
    case 'WebSearch': return shortStr(input.query, 50);
    case 'WebFetch': try { return new URL(input.url).host; } catch { return shortStr(input.url, 40); }
    case 'Task': case 'Agent': return shortStr(`${input.subagent_type || 'agent'}: ${input.description || ''}`, 60);
    case 'TodoWrite': return `${(input.todos || []).length} todo`;
    default:
      if (name?.startsWith('mcp__')) return shortStr(name.split('__').slice(2).join(' '), 40);
      return shortStr(JSON.stringify(input), 40);
  }
}
const toolName = n => n?.startsWith('mcp__') ? n.split('__')[1] : n;

export function serialize(s) {
  return {
    sid: s.sid, office: s.office, room: s.room, role: s.role, kind: s.kind, worktree: s.worktree || null, cwd: s.cwd,
    status: s.status, tool: s.tool, title: s.title, model: s.model, startedAt: s.startedAt, lastSeen: s.lastSeen, tmux: s.tmux || null,
    waiting: s.waiting || null, slot: s.slot || 0, compacting: !!s.compacting, tty: s.tty || null, host: s.host || null, permMode: s.permMode || null,
    subs: [...s.subs.values()].map(x => ({ id: x.id, type: x.type, desc: x.desc, status: x.status, tool: x.tool, started: x.started })),
  };
}

function emitSession(s) { bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); }

export function logOffice(office, who, text, kind = 'act') {
  if (!office) return;
  const at = nowIso();
  try {
    const db = officeDb(office);
    run(db, 'INSERT INTO log (who, text, at, kind) VALUES (?, ?, ?, ?)', who, text, at, kind);
  } catch {}
  bus.emit('msg', { t: 'log', office, entry: { who, text, at, kind } });
}

function roleName(office, roleId) {
  if (!roleId) return null;
  try { return one(officeDb(office), 'SELECT name FROM roles WHERE id = ?', roleId)?.name || null; } catch { return null; }
}
export function whoOf(s) { return roleName(s.office, s.role) || (s.title ? `Sesi: ${shortStr(s.title, 24)}` : 'Sesi manual'); }

/** Pre-register a session the daemon is about to start in tmux. */
export function expectSession({ sid, office, role, room, cwd, tmux, slot, title }) {
  const s = blank(sid);
  Object.assign(s, { office, role, room, cwd, tmux, slot: slot || 0, kind: 'kantor', status: 'starting', title: title || null });
  live.set(sid, s);
  persist(s);
  // a resumed session is open again
  run(globalDb(), 'UPDATE sessions SET ended_at = NULL WHERE sid = ?', sid);
  emitSession(s);
  return s;
}

function blank(sid) {
  return { sid, office: null, room: null, role: null, kind: 'manual', cwd: null, status: 'idle', tool: null, title: null, model: null,
    startedAt: nowIso(), lastSeen: nowIso(), subs: new Map(), pendingAgents: [], waiting: null, worktree: null, slot: 0, tmux: null };
}

function restoreFromDb(sid) {
  const row = one(globalDb(), 'SELECT * FROM sessions WHERE sid = ?', sid);
  if (!row) return null;
  const s = blank(sid);
  Object.assign(s, { office: row.office, room: row.room, role: row.role, cwd: row.cwd, kind: row.source || 'manual', tmux: row.tmux, title: row.title, model: row.model, startedAt: row.started_at, tty: row.tty, transcript: row.transcript });
  return s;
}

function persist(s) {
  run(globalDb(), `INSERT INTO sessions (sid, office, room, role, cwd, transcript, source, tmux, title, model, status, started_at, last_seen, tty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET office=excluded.office, room=excluded.room, role=excluded.role, cwd=excluded.cwd,
      transcript=COALESCE(excluded.transcript, sessions.transcript), tmux=COALESCE(excluded.tmux, sessions.tmux), title=COALESCE(excluded.title, sessions.title),
      model=COALESCE(excluded.model, sessions.model), status=excluded.status, last_seen=excluded.last_seen, tty=COALESCE(excluded.tty, sessions.tty),
      ended_at=CASE WHEN excluded.status = 'ended' THEN sessions.ended_at ELSE NULL END`,
    s.sid, s.office, s.room, s.role, s.cwd, s.transcript || null, s.kind, s.tmux || null, s.title, s.model, s.status, s.startedAt, s.lastSeen, s.tty || null);
}

// /clear and /resume give the conversation a new session id inside the same tmux pane. The hook carries the id
// the office started it with (KANTOR_SID), so the new id takes over that pane's role, room and shift.
function inheritShift(s, p) {
  const origin = one(globalDb(), 'SELECT * FROM sessions WHERE sid = ?', p.kantor_sid);
  if (!origin?.tmux) return;
  const prev = [...live.values()].find(x => x.tmux === origin.tmux && x.sid !== s.sid);
  const src = prev || restoreFromDb(origin.sid);
  Object.assign(s, { office: src.office, role: src.role, room: src.room, tmux: origin.tmux, slot: prev?.slot || 0, kind: 'kantor',
    worktree: prev?.worktree || null, cwd: src.cwd || s.cwd, startedAt: src.startedAt || origin.started_at });
  if (s.office && s.role) try {
    run(officeDb(s.office), "UPDATE shifts SET sid = ?, status = 'aktif', ended_at = NULL WHERE sid = (SELECT sid FROM shifts WHERE tmux = ? ORDER BY started_at DESC LIMIT 1)", s.sid, origin.tmux);
  } catch {}
  if (prev) {
    live.delete(prev.sid);
    run(globalDb(), 'UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE sid = ?', nowIso(), prev.sid);
    bus.emit('msg', { t: 'session-gone', office: prev.office, sid: prev.sid });
  }
}

function sessionFor(p) {
  let s = live.get(p.session_id) || restoreFromDb(p.session_id);
  if (!s) s = blank(p.session_id);
  if (p.kantor_sid && p.kantor_sid !== s.sid && !s.tmux && p.hook_event_name !== 'SessionEnd') inheritShift(s, p);
  live.set(s.sid, s);
  if (p.cwd && (!s.cwd || !s.office)) {
    s.cwd = p.cwd;
    s.office = s.office || officeForCwd(p.cwd);
  }
  if (s.office && !s.room) {
    const m = officeModel(s.office);
    if (m) { const r = roomForCwd(m, s.cwd || p.cwd); s.room = r.room; s.worktree = r.worktree || null; }
  }
  if (p.transcript_path) s.transcript = p.transcript_path;
  if (p.kantor_tty) {
    s.tty = p.kantor_tty;
    // the process scanner may be showing this terminal as a placeholder; the real session replaces it
    for (const x of [...live.values()]) if (x.placeholder && x.tty === s.tty) { live.delete(x.sid); bus.emit('msg', { t: 'session-gone', office: x.office, sid: x.sid }); }
  }
  if (p.model && typeof p.model === 'string') s.model = p.model;
  if (p.permission_mode && typeof p.permission_mode === 'string') s.permMode = p.permission_mode;
  s.lastSeen = nowIso();
  return s;
}

/**
 * Handle one hook payload. Returns the JSON the hook script should print (or null).
 * PermissionRequest may wait for a decision from the inbox.
 */
export async function handleHook(p) {
  if (!p || !p.session_id || !p.hook_event_name) return null;
  const ev = p.hook_event_name;
  const s = sessionFor(p);
  const who = whoOf(s);
  const sub = p.agent_id ? (s.subs.get(p.agent_id) || addSub(s, p.agent_id, p.agent_type)) : null;

  switch (ev) {
    case 'SessionStart':
      s.status = s.status === 'starting' ? 'idle' : (s.status === 'ended' ? 'idle' : s.status || 'idle');
      if (p.session_title) s.title = p.session_title;
      if (p.source === 'clear') { s.subs.clear(); logOffice(s.office, who, 'mereset percakapan (/clear)', 'session'); }
      else if (p.source === 'compact') { s.compacting = false; }
      else logOffice(s.office, who, p.source === 'resume' ? 'melanjutkan sesi lama' : `mulai sesi di ${s.room || 'kantor'}`, 'session');
      if (p.source === 'resume') run(globalDb(), 'UPDATE sessions SET ended_at = NULL WHERE sid = ?', s.sid);
      break;
    case 'UserPromptSubmit':
      s.status = 'working';
      // prompts injected by Claude Code itself (<task-notification>, <command-name>, …) are not the user's words
      const human = p.prompt && !/^\s*</.test(p.prompt) ? p.prompt : null;
      if (p.session_title) s.title = p.session_title;
      else if (human && (!s.title || /^\s*</.test(s.title) || /<[^>]+>/.test(s.title))) s.title = shortStr(human.replace(/<[^>]*>/g, ' '), 60) || null;
      if (human) logOffice(s.office, who, `dapat perintah: ${shortStr(human, 80)}`, 'prompt');
      break;
    case 'PreToolUse': {
      const label = toolLabel(p.tool_name, p.tool_input);
      const tool = { name: toolName(p.tool_name), label, at: Date.now(), id: p.tool_use_id, sub: p.tool_input?.subagent_type || null };
      if (sub) { sub.tool = tool; sub.status = 'working'; }
      else {
        s.status = 'working'; s.tool = tool;
        if (p.tool_name === 'Task' || p.tool_name === 'Agent') s.pendingAgents.push({ toolUseId: p.tool_use_id, type: p.tool_input?.subagent_type || 'general-purpose', desc: p.tool_input?.description || '' });
        if (!['TodoWrite'].includes(p.tool_name)) logOffice(s.office, who, `${tool.name} ${label}`.trim(), 'tool');
      }
      break;
    }
    case 'PostToolUse': case 'PostToolUseFailure':
      if (sub) { if (sub.tool && sub.tool.id === p.tool_use_id) sub.tool = null; }
      else {
        if ((p.tool_name === 'Task' || p.tool_name === 'Agent')) {
          for (const x of s.subs.values()) if (x.toolUseId === p.tool_use_id && x.status !== 'done') finishSub(s, x);
        }
        if (s.tool && s.tool.id === p.tool_use_id) s.tool = null;
        if (ev === 'PostToolUseFailure') logOffice(s.office, who, `gagal: ${p.tool_name}`, 'tool');
      }
      if (s.waiting) clearWaiting(s, 'terminal');
      break;
    case 'SubagentStart': addSub(s, p.agent_id, p.agent_type); logOffice(s.office, who, `memanggil subagent ${p.agent_type || ''}`.trim(), 'sub'); break;
    case 'SubagentStop': { const x = s.subs.get(p.agent_id); if (x) { x.result = shortStr(p.last_assistant_message, 120); finishSub(s, x); } break; }
    case 'Notification':
      if (p.notification_type === 'idle_prompt') { s.status = 'idle'; s.tool = null; }
      else if (p.notification_type === 'permission_prompt' && !s.waiting) s.status = 'waiting';
      break;
    case 'PreCompact': s.compacting = true; s.tool = { name: 'Compact', label: 'merapikan konteks', at: Date.now() }; break;
    case 'PostCompact': s.compacting = false; s.tool = null; break;
    case 'Stop':
      s.status = 'idle'; s.tool = null;
      if (s.waiting) clearWaiting(s, 'terminal');
      break;
    case 'SessionEnd':
      s.status = 'ended'; s.tool = null; s.endedAt = nowIso();
      if (s.waiting) clearWaiting(s, 'expired');
      run(globalDb(), 'UPDATE sessions SET ended_at = ? WHERE sid = ?', s.endedAt, s.sid);
      // /clear (and /resume) end this id but the shift goes on under the next one
      if (p.reason !== 'clear' && p.reason !== 'resume') {
        if (s.office && s.role) try { run(officeDb(s.office), 'UPDATE shifts SET ended_at = ?, status = ? WHERE sid = ?', s.endedAt, 'selesai', s.sid); } catch {}
        logOffice(s.office, who, 'sesi selesai', 'session');
      }
      setTimeout(() => { if (live.get(s.sid)?.status === 'ended') { live.delete(s.sid); bus.emit('msg', { t: 'session-gone', office: s.office, sid: s.sid }); } }, 20000).unref();
      break;
    case 'PermissionRequest': {
      const res = await permission(s, p, who);
      persist(s); emitSession(s);
      return res;
    }
  }
  persist(s);
  emitSession(s);
  return null;
}

function addSub(s, agentId, type) {
  let x = s.subs.get(agentId);
  if (x) return x;
  const i = s.pendingAgents.findIndex(a => !type || a.type === type);
  const pend = i >= 0 ? s.pendingAgents.splice(i, 1)[0] : null;
  x = { id: agentId, type: type || pend?.type || 'agent', desc: pend?.desc || '', toolUseId: pend?.toolUseId || null, status: 'working', tool: null, started: Date.now() };
  s.subs.set(agentId, x);
  return x;
}
function finishSub(s, x) {
  x.status = 'done'; x.tool = null; x.ended = Date.now();
  setTimeout(() => { if (s.subs.get(x.id) === x) { s.subs.delete(x.id); emitSession(s); } }, 15000).unref();
}

/* ---------------- permission inbox ---------------- */
function summarizeInput(tool, input) {
  if (!input) return '';
  if (tool === 'Bash') return input.command || '';
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  return JSON.stringify(input).slice(0, 400);
}

async function permission(s, p, who) {
  const id = newId('ib');
  const summary = summarizeInput(p.tool_name, p.tool_input);
  const item = { id, office: s.office, sid: s.sid, role: s.role, tool: p.tool_name, input: JSON.stringify(p.tool_input || {}).slice(0, 4000), summary, created_at: nowIso(), status: 'open', source: s.kind };
  run(globalDb(), 'INSERT INTO inbox (id, office, sid, role, tool, input, summary, created_at, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, item.office, item.sid, item.role, item.tool, item.input, item.summary, item.created_at, item.status, item.source);
  s.status = 'waiting';
  s.waiting = { id, tool: p.tool_name, summary: shortStr(summary, 80) };
  emitSession(s);
  bus.emit('msg', { t: 'inbox', item: inboxView(item, who) });
  logOffice(s.office, who, `minta izin: ${p.tool_name} ${shortStr(summary, 60)}`, 'perm');

  const cfg = config().approvals;
  const holdSec = s.kind === 'kantor' ? cfg.holdKantorSec : cfg.holdManualSec;
  if (!holdSec) return null;
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => { held.delete(id); resolve(null); }, holdSec * 1000);
    held.set(id, d => { clearTimeout(timer); held.delete(id); resolve(d); });
  });
  if (!decision) {
    // nobody answered in the inbox; the normal prompt now shows in the terminal
    run(globalDb(), "UPDATE inbox SET status = 'terminal' WHERE id = ? AND status = 'open'", id);
    bus.emit('msg', { t: 'inbox-update', id, status: 'terminal' });
    return null;
  }
  s.waiting = null;
  s.status = 'working';
  if (decision.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: decision.message || 'Ditolak dari kotak masuk Kantor Claude.' } } };
}

function clearWaiting(s, status) {
  const id = s.waiting?.id;
  s.waiting = null;
  if (!id) return;
  const fn = held.get(id);
  if (fn) fn(null); // answered in the terminal; release the waiting hook
  const r = run(globalDb(), "UPDATE inbox SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'", status, nowIso(), id);
  if (r.changes) bus.emit('msg', { t: 'inbox-update', id, status });
}

/** Decide an inbox item from the UI. */
export function decide(id, behavior, message) {
  const row = one(globalDb(), 'SELECT * FROM inbox WHERE id = ?', id);
  if (!row) throw new Error('Permintaan izin tidak ditemukan');
  if (row.status !== 'open') throw new Error('Permintaan ini sudah dijawab atau sudah pindah ke terminal');
  const fn = held.get(id);
  if (!fn) {
    run(globalDb(), "UPDATE inbox SET status = 'terminal' WHERE id = ?", id);
    bus.emit('msg', { t: 'inbox-update', id, status: 'terminal' });
    throw new Error('Sesi ini sudah menampilkan prompt izin di terminalnya. Jawab dari terminal.');
  }
  const status = behavior === 'allow' ? 'allowed' : 'denied';
  run(globalDb(), 'UPDATE inbox SET status = ?, decided_at = ? WHERE id = ?', status, nowIso(), id);
  bus.emit('msg', { t: 'inbox-update', id, status });
  const s = live.get(row.sid);
  if (s) { s.waiting = null; s.status = 'working'; emitSession(s); logOffice(s.office, 'Kamu', `${behavior === 'allow' ? 'mengizinkan' : 'menolak'} ${row.tool} untuk ${whoOf(s)}`, 'perm'); }
  fn({ behavior, message });
}

export function inboxView(row, who) {
  return { id: row.id, office: row.office, sid: row.sid, role: row.role, who: who || null, tool: row.tool, summary: row.summary, created_at: row.created_at, status: row.status, held: held.has(row.id) };
}

export function openInbox() {
  return all(globalDb(), "SELECT * FROM inbox WHERE status = 'open' ORDER BY created_at DESC").map(r => {
    const s = live.get(r.sid);
    return inboxView(r, s ? whoOf(s) : null);
  });
}

export function liveFor(office) {
  return [...live.values()].filter(s => s.office === office && s.status !== 'ended').map(serialize);
}

/** Drop sessions we have not heard from in a long time (crashed terminals). */
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600e3;
  for (const s of live.values()) {
    if (s.kind === 'manual' && Date.parse(s.lastSeen) < cutoff) { live.delete(s.sid); bus.emit('msg', { t: 'session-gone', office: s.office, sid: s.sid }); }
  }
}, 600e3).unref();
