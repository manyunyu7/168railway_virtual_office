import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { globalDb, officeDb, one, run, all, nowIso, newId } from './db.js';
import { officeForCwd, officeModel, roomForCwd } from './offices.js';
import { sessionHealth } from './health.js';
import { subagentTokens, fileTokens, codexSubagentFile } from './subtokens.js';
import * as gitinfo from './gitinfo.js';
import { codexHealth, normalizeHook, engineOf, readCodexSettings } from './codex.js';
import { who as actorName } from './actor.js';

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
    case 'WaitAgent': return 'subagent';
    case 'Task': case 'Agent': return shortStr(`${input.subagent_type || 'agent'}: ${input.description || ''}`, 60);
    case 'TodoWrite': return `${(input.todos || []).length} todo`;
    case 'AskUserQuestion': return shortStr((input.questions || []).map(q => q.question || q.header).filter(Boolean).join(' · '), 90);
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
    waiting: s.waiting || null, slot: s.slot || 0, compacting: !!s.compacting, tty: s.tty || null, host: s.host || null, permMode: s.permMode || null, boss: s.boss || null, engine: s.engine || 'claude', effort: s.effort || null,
    tunggu: s.tunggu || null, anggaran: s.anggaran || null,
    subs: [...s.subs.values()].map(x => ({ id: x.id, type: x.type, desc: x.desc, status: x.status, tool: x.tool, started: x.started, ended: x.ended || null, tokens: s.engine === 'codex' ? fileTokens(x.transcript || codexSubagentFile(x.id, x.started)) : subagentTokens(s.transcript, x.id) })),
    bgAgents: [...s.subs.values()].filter(x => x.status !== 'done').length,
    ...(s.engine === 'codex' ? codexHealth(s.transcript) : sessionHealth(s.transcript, s.model)),
  };
}

function emitSession(s) { bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); }

gitinfo.setSink({ emit: m => bus.emit('msg', m), log: (office, who, text, kind) => logOffice(office, who, text, kind) });

/** Log line for a failed tool: name plus a short, scrubbed reason (~160 chars). */
export function failLine(p) {
  const raw = typeof p.error === 'string' ? p.error : p.error?.message || (typeof p.tool_response === 'string' ? p.tool_response : '');
  const why = String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/(Bearer\s+)[\w.~+\/=-]+/gi, '$1***')
    .replace(/([?&](?:token|key|secret|password|access_token)=)[^\s&"']+/gi, '$1***')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***')
    .replace(/\b(?:sk|ghp|gho|xox[bap]|AIza)[-_A-Za-z0-9]{16,}/g, '***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
  return `gagal: ${p.tool_name}${why ? ` - ${why.length > 160 ? why.slice(0, 159) + '…' : why}` : ''}`;
}
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
export function expectSession({ sid, office, role, room, cwd, tmux, slot, title, engine, effort, model, permMode }) {
  const s = blank(sid);
  Object.assign(s, { office, role, room, cwd, tmux, slot: slot || 0, kind: 'kantor', status: 'starting', title: title || null, engine: engineOf(engine), effort: effort || null });
  if (model) s.model = model;
  if (permMode) s.permMode = permMode;
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
  Object.assign(s, { office: row.office, room: row.room, role: row.role, cwd: row.cwd, kind: row.source || 'manual', tmux: row.tmux, title: row.title, model: row.model, startedAt: row.started_at, tty: row.tty, transcript: row.transcript, boss: row.boss || null, engine: engineOf(row.engine), effort: row.effort || null });
  return s;
}

function persist(s) {
  run(globalDb(), `INSERT INTO sessions (sid, office, room, role, cwd, transcript, source, tmux, title, model, status, started_at, last_seen, tty, engine, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET office=excluded.office, room=excluded.room, role=excluded.role, cwd=excluded.cwd,
      transcript=COALESCE(excluded.transcript, sessions.transcript), tmux=COALESCE(excluded.tmux, sessions.tmux), title=COALESCE(excluded.title, sessions.title),
      model=COALESCE(excluded.model, sessions.model), status=excluded.status, last_seen=excluded.last_seen, tty=COALESCE(excluded.tty, sessions.tty), engine=excluded.engine, effort=COALESCE(excluded.effort, sessions.effort),
      ended_at=CASE WHEN excluded.status = 'ended' THEN sessions.ended_at ELSE NULL END`,
    s.sid, s.office, s.room, s.role, s.cwd, s.transcript || null, s.kind, s.tmux || null, s.title, s.model, s.status, s.startedAt, s.lastSeen, s.tty || null, s.engine === 'codex' ? 'codex' : null, s.effort || null);
}

// /clear and /resume give the conversation a new session id inside the same tmux pane. The hook carries the id
// the office started it with (KANTOR_SID), so the new id takes over that pane's role, room and shift.
function inheritShift(s, p) {
  const origin = one(globalDb(), 'SELECT * FROM sessions WHERE sid = ?', p.kantor_sid);
  if (!origin?.tmux) return;
  const prev = [...live.values()].find(x => x.tmux === origin.tmux && x.sid !== s.sid);
  const src = prev || restoreFromDb(origin.sid);
  Object.assign(s, { office: src.office, role: src.role, room: src.room, tmux: origin.tmux, slot: prev?.slot || 0, kind: 'kantor',
    worktree: prev?.worktree || null, cwd: src.cwd || s.cwd, startedAt: src.startedAt || origin.started_at,
    engine: engineOf(prev?.engine || src.engine || origin.engine), effort: prev?.effort || src.effort || origin.effort || null, permMode: prev?.permMode || s.permMode || null });
  if (s.office && s.role) try {
    run(officeDb(s.office), "UPDATE shifts SET sid = ?, status = 'aktif', ended_at = NULL WHERE sid = (SELECT sid FROM shifts WHERE tmux = ? ORDER BY started_at DESC LIMIT 1)", s.sid, origin.tmux);
  } catch {}
  if (prev) {
    live.delete(prev.sid);
    run(globalDb(), 'UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE sid = ?', nowIso(), prev.sid);
    // announce the new id first, so a chat or drawer open on the old id can follow it (`next`) instead of showing "ended";
    // Codex always takes this path on its first hook, since its session id can't be chosen up front like Claude's
    live.set(s.sid, s); emitSession(s);
    bus.emit('msg', { t: 'session-gone', office: prev.office, sid: prev.sid, next: s.sid });
  }
}

function sessionFor(p) {
  let s = live.get(p.session_id) || restoreFromDb(p.session_id);
  if (!s) s = blank(p.session_id);
  if (p.kantor_engine === 'codex') s.engine = 'codex'; // before inheritShift, which keeps it
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
  if (s.engine === 'codex') {
    // Codex reports permission_mode 'default' whatever the sandbox is; its rollout records the real policy each turn
    const cs = readCodexSettings(s.transcript);
    if (cs?.effort) s.effort = cs.effort;
    if (cs?.mode) s.permMode = cs.mode;
  } else if (p.permission_mode && typeof p.permission_mode === 'string') s.permMode = p.permission_mode;
  s.lastSeen = nowIso();
  return s;
}

/** dm.js registers this: extra context for the model (a reminder of waiting messages) to hand back from a PostToolUse / UserPromptSubmit hook. */
let hookContext = null;
export function setHookContext(fn) { hookContext = fn; }
/** More hook-context providers (aturan/reminders in hookctx.js): fn(session, event, payload) -> string | null. Several may answer; their texts are joined. */
const hookProviders = [];
export function addHookContext(fn) { hookProviders.push(fn); }
/** Called after every finished tool (PostToolUse / PostToolUseFailure) so providers can record what happened. */
const toolObservers = [];
export function addToolObserver(fn) { toolObservers.push(fn); }

/**
 * Handle one hook payload. Returns the JSON the hook script should print (or null).
 * PermissionRequest may wait for a decision from the inbox.
 */
export async function handleHook(p) {
  if (!p || !p.session_id || !p.hook_event_name) return null;
  if (p.kantor_engine === 'codex') p = normalizeHook(p);
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
      if (p.prompt) bus.emit('prompt', { sid: s.sid, office: s.office, prompt: p.prompt });
      if (human) logOffice(s.office, who, `dapat perintah: ${shortStr(human, 80)}`, 'prompt');
      break;
    case 'PreToolUse': {
      if (p.tool_name === 'AskUserQuestion' && !sub) bus.emit('notify', { kind: 'question', sid: s.sid, office: s.office, who, text: shortStr(p.tool_input?.questions?.[0]?.question, 100) });
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
        if (ev === 'PostToolUseFailure') logOffice(s.office, who, failLine(p), 'tool');
      }
      // only the tool that asked releases the hold: Codex keeps running other tools while an approval waits
      if (s.waiting && finishedWaitingTool(s.waiting, p)) clearWaiting(s, 'terminal');
      if (s.office) gitinfo.touch(s.office, gitinfo.roomOfToolUse(s.office, p, s.room));
      break;
    case 'SubagentStart': addSub(s, p.agent_id, p.agent_type); logOffice(s.office, who, `memanggil subagent ${p.agent_type || ''}`.trim(), 'sub'); break;
    case 'SubagentStop': { const x = s.subs.get(p.agent_id); if (x) { if (/\/sessions\/.+\/rollout-[\w.:-]+\.jsonl$/.test(p.agent_transcript_path || '')) x.transcript = p.agent_transcript_path; x.result = shortStr(p.last_assistant_message, 120); finishSub(s, x); } break; }
    case 'Notification':
      if (p.notification_type === 'elicitation_dialog') bus.emit('notify', { kind: 'question', sid: s.sid, office: s.office, who, text: shortStr(p.message, 100) });
      if (p.notification_type === 'idle_prompt') { s.status = 'idle'; s.tool = null; }
      else if (p.notification_type === 'permission_prompt' && !s.waiting) s.status = 'waiting';
      break;
    case 'PreCompact': s.compacting = true; s.tool = { name: 'Compact', label: 'merapikan konteks', at: Date.now() };
      logOffice(s.office, who, 'merapikan konteks (kompaksi)', 'session'); // counted by the metrics dashboard
      if (s.engine === 'codex' && p.trigger === 'manual') s.status = 'working'; // /compact runs outside a turn, so no prompt hook marked it busy
      break;
    case 'PostCompact': s.compacting = false; s.tool = null;
      if (s.engine === 'codex' && p.trigger === 'manual') s.status = 'idle';
      break;
    case 'Interrupt': // Codex: the turn was interrupted (Esc); it fires no Stop
      logOffice(s.office, who, 'diinterupsi (Esc)', 'session');
      s.status = 'idle'; s.tool = null;
      if (s.waiting) clearWaiting(s, 'terminal');
      break;
    case 'Stop':
      s.status = 'idle'; s.tool = null;
      if (s.waiting) clearWaiting(s, 'terminal');
      if (s.office && s.room) gitinfo.touch(s.office, s.room);
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
  // Claude Code and Codex both accept hookSpecificOutput.additionalContext from PostToolUse and UserPromptSubmit (see docs/FRONTEND-CONTRACT.md, "Pesan langsung")
  if (!sub && (ev === 'PostToolUse' || ev === 'PostToolUseFailure')) for (const fn of toolObservers) { try { fn(s, p, ev === 'PostToolUseFailure'); } catch {} }
  if (!sub && (ev === 'PreToolUse' || ev === 'PostToolUse' || ev === 'UserPromptSubmit')) {
    const parts = [];
    if (hookContext && ev !== 'PreToolUse') { try { const x = hookContext(s, ev); if (x) parts.push(x); } catch {} }
    for (const fn of hookProviders) { try { const x = fn(s, ev, p); if (x) parts.push(x); } catch {} }
    if (parts.length) return { hookSpecificOutput: { hookEventName: ev, additionalContext: parts.join('\n\n') } };
  }
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
  setTimeout(() => { if (s.subs.get(x.id) === x) { s.subs.delete(x.id); emitSession(s); } }, 60000).unref(); // the chat shows it dimmed meanwhile
}

/* ---------------- permission inbox ---------------- */
function summarizeInput(tool, input) {
  if (!input) return '';
  // clients parse the questions and options out of this JSON, so keep it whole
  if (tool === 'AskUserQuestion') return JSON.stringify(input).slice(0, 4000);
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
  s.waiting = { id, tool: p.tool_name, toolUseId: p.tool_use_id || null, summary: shortStr(p.tool_name === 'AskUserQuestion' ? toolLabel(p.tool_name, p.tool_input || {}) : summary, 80) };
  emitSession(s);
  bus.emit('msg', { t: 'inbox', item: inboxView(item, who) });
  logOffice(s.office, who, `minta izin: ${p.tool_name} ${shortStr(p.tool_name === 'AskUserQuestion' ? toolLabel(p.tool_name, p.tool_input || {}) : summary, 60)}`, 'perm');

  const cfg = config().approvals;
  const holdSec = s.kind === 'kantor' ? cfg.holdKantorSec : cfg.holdManualSec;
  if (!holdSec) return null;
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => { held.delete(id); resolve(null); }, holdSec * 1000);
    held.set(id, d => { clearTimeout(timer); held.delete(id); askInputs.delete(id); resolve(d); });
    if (p.tool_name === 'AskUserQuestion') askInputs.set(id, p.tool_input || {});
  });
  if (!decision) {
    // nobody answered in the inbox; the normal prompt now shows in the terminal
    run(globalDb(), "UPDATE inbox SET status = 'terminal' WHERE id = ? AND status = 'open'", id);
    bus.emit('msg', { t: 'inbox-update', id, status: 'terminal' });
    return null;
  }
  s.waiting = null;
  s.status = 'working';
  if (decision.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision.updatedInput ? { behavior: 'allow', updatedInput: decision.updatedInput } : { behavior: 'allow' } } };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: decision.message || 'Ditolak dari kotak masuk Kantor Claude.', ...(decision.interrupt && s.engine !== 'codex' ? { interrupt: true } : {}) } } }; // Codex rejects interrupt here: Esc does it
}

const askInputs = new Map(); // inbox id -> tool_input of a held AskUserQuestion

/** Build the updatedInput Claude Code expects for AskUserQuestion: answers keyed by question text, notes under annotations. */
export function buildAskAnswers(input, answers) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length) throw new Error('Pertanyaan tidak ditemukan');
  const list = Array.isArray(answers) ? answers : [];
  const out = {}, notes = {};
  qs.forEach((q, i) => {
    const a = list.find(x => x && (x.q === i || x.q === q.question)) || list[i];
    if (!a) throw new Error(`Jawaban untuk pertanyaan ${i + 1} belum ada`);
    const label = v => {
      const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
      return Number.isInteger(n) && q.options?.[n - 1] ? q.options[n - 1].label : String(v);
    };
    const picks = [];
    if (a.choice != null && a.choice !== '') picks.push(label(a.choice));
    if (Array.isArray(a.choices)) for (const c of a.choices) picks.push(label(c));
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (text) picks.push(text);
    if (!picks.length) throw new Error(`Pilih atau tulis jawaban untuk pertanyaan ${i + 1}`);
    out[q.question] = q.multiSelect ? picks.join(', ') : picks[picks.length - 1];
    const note = typeof a.note === 'string' ? a.note.trim() : '';
    if (note) notes[q.question] = { notes: note };
  });
  const updatedInput = { ...input, answers: out };
  if (Object.keys(notes).length) updatedInput.annotations = notes;
  return updatedInput;
}

/** Answer a held AskUserQuestion through the hook (official path), including notes, free text and multiSelect. */
export function answerAsk(id, answers) {
  const row = one(globalDb(), 'SELECT * FROM inbox WHERE id = ?', id);
  if (!row) throw new Error('Pertanyaan tidak ditemukan');
  if (row.tool !== 'AskUserQuestion') throw new Error('Bukan pertanyaan');
  if (row.status !== 'open') throw new Error('Pertanyaan ini sudah dijawab atau sudah pindah ke terminal');
  const input = askInputs.get(id);
  if (!held.has(id) || !input) throw new Error('Sesi ini sudah menampilkan pertanyaan di terminalnya. Jawab dari terminal.');
  const updatedInput = buildAskAnswers(input, answers);
  const fn = held.get(id);
  run(globalDb(), "UPDATE inbox SET status = 'allowed', decided_at = ? WHERE id = ?", nowIso(), id);
  bus.emit('msg', { t: 'inbox-update', id, status: 'allowed' });
  const s = live.get(row.sid);
  if (s) { s.waiting = null; s.status = 'working'; emitSession(s); logOffice(s.office, actorName(), `menjawab pertanyaan ${whoOf(s)}`, 'perm'); }
  fn({ behavior: 'allow', updatedInput });
}

/** Does this PostToolUse belong to the tool a held permission is waiting for? Same call id when both sides have one, else same tool name. */
export function finishedWaitingTool(waiting, p) {
  if (waiting.toolUseId && p.tool_use_id) return waiting.toolUseId === p.tool_use_id;
  return !waiting.tool || waiting.tool === p.tool_name;
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
export function decide(id, behavior, message, interrupt = false) {
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
  if (s) { s.waiting = null; s.status = 'working'; emitSession(s); logOffice(s.office, actorName(), `${behavior === 'allow' ? 'mengizinkan' : 'menolak'} ${row.tool} untuk ${whoOf(s)}`, 'perm'); }
  fn({ behavior, message, interrupt });
}

/** Hentikan: a held permission/question keeps Claude waiting on the hook, so Esc alone does nothing. Deny + interrupt them. */
export function stopHeld(sid) {
  let n = 0;
  for (const r of all(globalDb(), "SELECT id FROM inbox WHERE sid = ? AND status = 'open'", sid)) {
    if (!held.has(r.id)) continue;
    try { decide(r.id, 'deny', 'Dihentikan dari Kantor.', true); n++; } catch {}
  }
  return n;
}

export function inboxView(row, who) {
  return { id: row.id, office: row.office, sid: row.sid, role: row.role, who: who || null, tool: row.tool, summary: row.tool === 'AskUserQuestion' && row.input ? row.input : row.summary, created_at: row.created_at, status: row.status, held: held.has(row.id) };
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
