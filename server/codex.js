// OpenAI Codex CLI as a second engine for Kantor shifts (see docs/CODEX.md).
// Pure helpers live here (CLI arguments, hook wiring, screen and rollout parsing) so they can be tested without
// a terminal; driving the TUI is in codexpick.js and starting a shift is in tmux.js.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { config, ROOT_DIR } from './config.js';

export const ENGINES = ['claude', 'codex', 'antigravity'];
export const engineOf = v => ENGINES.includes(v) ? v : 'claude';

/* ---------------- binary ---------------- */
let CODEX = null;
export function codexBin() {
  if (CODEX) return CODEX;
  const cfg = config().codex?.bin;
  if (cfg && path.isAbsolute(cfg) && fs.existsSync(cfg)) return (CODEX = cfg);
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(process.env.HOME || '', '.local/bin')]) {
    const f = path.join(p, 'codex');
    if (fs.existsSync(f)) return (CODEX = f);
  }
  try { CODEX = execFileSync('/bin/zsh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim() || null; } catch { CODEX = null; }
  return CODEX;
}

/* ---------------- permission modes ---------------- */
// Same names the Claude side uses where the meaning matches, so clients can share their mode chips.
// default = Codex "Ask for approval" (workspace-write sandbox, asks for the rest)
// auto    = "Approve for me" (automatic review decides, only unsafe things reach you)
// readOnly = "Read Only"; bypassPermissions = "Full Access" (no sandbox, no approvals)
export const CODEX_MODES = ['default', 'auto', 'readOnly', 'bypassPermissions'];
const MODE_LABEL = { default: /^ask for approval/i, auto: /^approve for me/i, readOnly: /^read only/i, bypassPermissions: /^full access/i };
export const modeLabelRe = mode => MODE_LABEL[mode];

/** Map any mode name (Claude's included, e.g. from a manager's shift_start) to a Codex mode. */
export function codexMode(mode) {
  if (CODEX_MODES.includes(mode)) return mode;
  if (mode === 'bypassPermissions') return 'bypassPermissions';
  if (mode === 'plan') return 'readOnly';
  if (mode === 'ikut' || !mode) return config().codex?.defaultMode && CODEX_MODES.includes(config().codex.defaultMode) ? config().codex.defaultMode : 'default';
  return 'default'; // acceptEdits, dontAsk, anything else: the safe middle
}

/** CLI flags for a mode. Always explicit, so the shift does not depend on the sandbox/approval in ~/.codex/config.toml. */
export function codexModeArgs(mode) {
  switch (codexMode(mode)) {
    case 'bypassPermissions': return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'auto': return ['--approve-for-me'];
    case 'readOnly': return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
    default: return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
  }
}

/* ---------------- effort ---------------- */
// how the TUI words an effort in its picker
const EFFORT_LABEL = { minimal: /^minimal/i, low: /^low/i, medium: /^medium/i, high: /^high/i, xhigh: /^extra high/i, max: /^max/i, ultra: /^ultra/i };
export const effortLabelRe = e => EFFORT_LABEL[e];
export const EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh'];
export const validEffort = e => /^[a-z]{3,10}$/.test(String(e || ''));

/* ---------------- TOML for -c ---------------- */
// JSON strings are valid TOML basic strings once DEL and the unicode line separators are gone
export const tomlStr = s => JSON.stringify(String(s)).replace(/[\u007f\u2028\u2029]/g, ' ');
export const tomlArr = a => `[${a.map(tomlStr).join(',')}]`;
export const tomlTable = o => `{${Object.entries(o).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k)}=${tomlStr(v)}`).join(',')}}`;
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/* ---------------- hooks ---------------- */
// Events Codex fires. Hooks are passed per session with -c, so ~/.codex/config.toml stays untouched.
export const CODEX_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'Interrupt'];
const hookTimeout = ev => ev === 'PermissionRequest' ? 600 : (ev === 'SessionEnd' || ev === 'Interrupt') ? 2 : 5;
/** ['-c', 'hooks.X=[...]', ...] pointing every event at hooks/kantor-hook.cjs. */
export function codexHookArgs(node = process.execPath) {
  const cmd = `${shq(node)} ${shq(path.join(ROOT_DIR, 'hooks', 'kantor-hook.cjs'))}`;
  return CODEX_HOOK_EVENTS.flatMap(ev => ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${tomlStr(cmd)},timeout=${hookTimeout(ev)}}]}]`]);
}

/* ---------------- launch ---------------- */
/**
 * Everything after `codex` for a shift. instructions = role prompt (becomes developer_instructions: the
 * official "extra developer message", the built-in Codex prompt stays), mcp = the kantor MCP server.
 */
export function codexArgs({ resumeSid = null, model = '', effort = '', mode = 'default', instructions = '', cwd = '', mcp = null, task = '' } = {}) {
  const a = [];
  if (resumeSid) a.push('resume', resumeSid);
  // run the Kantor hooks without persisting a trust decision into ~/.codex/config.toml
  a.push('--dangerously-bypass-hook-trust');
  // the folder trust prompt would otherwise block an unattended start (and save the answer in the global config)
  if (cwd) a.push('-c', `projects={${tomlStr(cwd)}={trust_level="trusted"}}`);
  if (model) a.push('-m', model);
  if (effort && validEffort(effort)) a.push('-c', `model_reasoning_effort=${tomlStr(effort)}`);
  a.push(...codexModeArgs(mode));
  // repos written for Claude often only have CLAUDE.md; Codex reads it where a folder has no AGENTS.md
  a.push('-c', `project_doc_fallback_filenames=${tomlArr(['CLAUDE.md'])}`);
  // the "Update available" menu would hold an unattended start until someone answers it
  a.push('-c', 'check_for_update_on_startup=false');
  if (instructions) a.push('-c', `developer_instructions=${tomlStr(instructions)}`);
  if (mcp) a.push('-c', `mcp_servers.kantor={command=${tomlStr(mcp.command)},args=${tomlArr(mcp.args)},env=${tomlTable(mcp.env)},default_tools_approval_mode="approve",tool_timeout_sec=960}`);
  a.push(...codexHookArgs());
  if (task && !resumeSid) a.push('--', task);
  return a;
}

/** Shell script that starts Codex (kept in a file: the role prompt is long and should not sit in `ps`). */
export function codexScript({ bin, args, env = {} }) {
  const exp = Object.entries(env).filter(([, v]) => v != null && v !== '').map(([k, v]) => `export ${k}=${shq(v)}`);
  return ['#!/bin/zsh', ...exp, `exec ${[bin, ...args].map(shq).join(' ')}`, ''].join('\n');
}

/* ---------------- models ---------------- */
let modelCache = null;
const MODEL_TTL = 10 * 60e3;

/** Default model and effort from ~/.codex/config.toml top level (two plain keys; nothing else is read). */
export function codexDefaults() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'config.toml'), 'utf8'); } catch {}
  const top = txt.split(/^\s*\[/m)[0];
  const get = k => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1] || null;
  return { model: get('model'), effort: get('model_reasoning_effort') };
}

/** Turn `codex debug models` JSON into {slug, name, desc, efforts, defaultEffort}; hidden models are dropped. */
export function parseModels(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  return list.filter(m => m && m.slug && (m.visibility || 'list') === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map(m => ({
    slug: m.slug, name: m.display_name || m.slug, desc: m.description || '',
    efforts: (m.supported_reasoning_levels || []).map(e => ({ effort: e.effort, desc: e.description || '' })),
    defaultEffort: m.default_reasoning_level || null,
  }));
}

/** Models this account can pick, read from the Codex CLI itself. Falls back to the configured one. */
export function codexModels({ fresh = false } = {}) {
  const def = codexDefaults();
  if (!fresh && modelCache && Date.now() - modelCache.at < MODEL_TTL) return Promise.resolve(modelCache.value);
  const bin = codexBin();
  const done = (models, source) => {
    const value = { models, default: def, source, efforts: EFFORTS_FALLBACK };
    if (models.length) modelCache = { at: Date.now(), value };
    return value;
  };
  if (!bin) return Promise.resolve(done([], 'none'));
  return new Promise(resolve => execFile(bin, ['debug', 'models'], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
    if (err) return resolve(done([], 'config'));
    let json = null; try { json = JSON.parse(out); } catch {}
    const models = parseModels(json);
    resolve(done(models, models.length ? 'codex' : 'config'));
  }));
}

/* ---------------- screen parsing ---------------- */
const ROW = /^\s*(›|>)?\s*(\d+)\.\s+(.*?)\s*$/;
/** Rows of a numbered Codex picker on a captured screen. {index, label, desc, current, isDefault, cursor} */
export function parsePickerRows(text, titleRe) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (titleRe.test(l)) at = i; });
  if (at < 0) return null;
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    const m = ROW.exec(l);
    if (!m) { if (rows.length && /enter |esc /i.test(l)) break; continue; }
    const [label, ...rest] = m[3].split(/\s{2,}/);
    rows.push({ index: +m[2], label: label.replace(/\s*\((current|default)\)\s*$/i, '').trim(), raw: label.trim(), desc: rest.join(' ').trim(),
      current: /\(current\)/i.test(label), isDefault: /\(default\)/i.test(label), cursor: m[1] === '›' || m[1] === '>' });
  }
  return rows.length ? rows : null;
}
export const MODEL_TITLE = /Select Model and Effort/i;
export const EFFORT_TITLE = /Select Reasoning Level|Advanced Reasoning/i; // Max and Ultra sit behind "More reasoning…" on their own screen
export const PERM_TITLE = /Update Model Permissions/i;
export const parseModelPicker = t => parsePickerRows(t, MODEL_TITLE);
export const parseEffortPicker = t => parsePickerRows(t, EFFORT_TITLE);
export const parsePermPicker = t => parsePickerRows(t, PERM_TITLE);

/** What the visible screen of a Codex pane shows. */
export function codexScreen(text) {
  const t = String(text || '');
  const lines = t.split('\n').filter(l => l.trim());
  const tail = lines.slice(-16).join('\n');
  const picker = MODEL_TITLE.test(tail) ? 'model' : EFFORT_TITLE.test(tail) ? 'effort' : PERM_TITLE.test(tail) ? 'permissions' : null;
  const approval = /Would you like to (run|make|apply|allow)|Press enter to confirm or esc to cancel/i.test(tail) && !picker;
  const busy = /esc to interrupt/i.test(tail);
  const composer = lines.slice(-6).some(l => /^\s*›/.test(l));
  return { picker, approval, busy, composer, idle: composer && !picker && !approval && !busy };
}

/** model + effort from the footer line "GPT-6-Astra low · /path ...". */
export function footerModel(text) {
  const lines = String(text || '').split('\n').filter(l => l.trim());
  for (const l of lines.slice(-6).reverse()) {
    const m = /^\s*([A-Za-z][\w.\- ]*?)\s+(minimal|low|medium|high|xhigh|extra high|max|ultra)\s+·/i.exec(l);
    if (m) return { name: m[1].trim(), effort: m[2].toLowerCase().replace('extra high', 'xhigh') };
  }
  return null;
}

/* ---------------- hook payloads ---------------- */
/** Files an apply_patch patch touches: [{path, op}] */
export function patchFiles(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gm)) out.push({ op: m[1].toLowerCase(), path: m[2] });
  return out;
}

const ENCRYPTED = /^gAAAA[\w-]{20,}/;
const taskWords = t => String(t || '').replace(/^.*\//, '').replace(/_/g, ' ').trim();
/** Readable subagent task: task_name ("check_other_file" -> "check other file"), else a plain-text message. */
export function agentTask(input) {
  const m = typeof input?.message === 'string' && !ENCRYPTED.test(input.message) ? input.message : '';
  return taskWords(input?.task_name) || m || String(input?.task || '');
}

/**
 * Codex hook payload -> the shape the daemon already understands for Claude Code: tool names Claude's UI has verbs
 * and icons for (apply_patch -> Edit, update_plan -> TodoWrite, spawn_agent -> Agent) and file_path for edits.
 */
export function normalizeHook(p) {
  if (!p || typeof p !== 'object') return p;
  const q = { ...p };
  // multi-agent tools come namespaced (collaborationspawn_agent, collaborationwait_agent)
  const name = typeof p.tool_name === 'string' ? p.tool_name.replace(/^collaboration/, '') : p.tool_name;
  const input = p.tool_input;
  if (name !== p.tool_name) q.tool_name = name;
  if (name === 'apply_patch') {
    const files = patchFiles(typeof input === 'string' ? input : input?.command);
    q.tool_name = files.length === 1 && files[0].op === 'add' ? 'Write' : 'Edit';
    q.tool_input = { file_path: files[0]?.path || '', files: files.map(f => f.path), patch: typeof input === 'string' ? input : input?.command || '', ...(input?.description ? { description: input.description } : {}) };
  } else if (name === 'update_plan') {
    q.tool_name = 'TodoWrite';
    q.tool_input = { todos: Array.isArray(input?.plan) ? input.plan : [] };
  } else if (name === 'spawn_agent') {
    // SubagentStart reports agent_type 'default' when none was asked for; the message is encrypted, task_name is readable
    q.tool_name = 'Agent';
    q.tool_input = { subagent_type: input?.agent_type || input?.role || 'default', description: agentTask(input) };
  } else if (name === 'wait_agent') {
    q.tool_name = 'WaitAgent';
    q.tool_input = {};
  } else if (typeof input === 'string') q.tool_input = { command: input };
  return q;
}

/* ---------------- rollout (transcript) ---------------- */
const lineCount = t => (typeof t === 'string' && t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);
/** {add, del} from a unified diff or a whole new file */
export function changeStat(c) {
  if (!c) return { add: 0, del: 0 };
  if (typeof c.unified_diff === 'string') {
    let add = 0, del = 0;
    for (const l of c.unified_diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
    return { add, del };
  }
  if (c.type === 'add') return { add: lineCount(c.content), del: 0 };
  if (c.type === 'delete') return { add: 0, del: lineCount(c.content) };
  return { add: 0, del: 0 };
}

const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text || '').join('') : '';
/** Absolute file path from a path or file:// URL, or '' (the chat serves it through /api/sessions/:sid/image). */
const imgPath = p => {
  let s = String(p || '');
  if (s.startsWith('file://')) { try { s = decodeURIComponent(new URL(s).pathname); } catch { return ''; } }
  return path.isAbsolute(s) ? s : '';
};
const cmdOf = it => {
  const c = it.command;
  if (Array.isArray(c)) { const i = c.findIndex(x => /^-l?c$/.test(x)); return i >= 0 && c[i + 1] ? c[i + 1] : c.join(' '); }
  return String(c || it.parsed_cmd?.[0]?.cmd || '');
};

/**
 * One rollout line -> chat items ({k:'user'|'text'|'tool'|'result', s, name?, add?, del?, err?, at},
 * or {k:'image', src:'gen'|'view'|'user', path, name, s?, at} for images, see docs/FRONTEND-CONTRACT.md).
 * Items come from `item_completed` events, which carry one clean entry per message / command / patch / MCP call.
 * `toolLabel` is injected to keep this file free of imports from live.js.
 */
export function rolloutItems(d, toolLabel) {
  if (d?.type !== 'event_msg' || d.payload?.type !== 'item_completed') return [];
  const it = d.payload.item || {};
  const at = d.timestamp;
  switch (it.type) {
    case 'UserMessage': {
      const s = textOf(it.content);
      const imgs = (Array.isArray(it.content) ? it.content : []).filter(b => b?.type === 'local_image' && b.path)
        .map(b => ({ k: 'image', src: 'user', path: imgPath(b.path), name: path.basename(String(b.path)), at })).filter(x => x.path);
      return [...imgs, ...(s.trim() && !/^\s*</.test(s) ? [{ k: 'user', s: clip(s, 2000), at }] : [])];
    }
    case 'AgentMessage': {
      const s = textOf(it.content);
      return s.trim() ? [{ k: 'text', s: clip(s, 4000), at }] : [];
    }
    case 'CommandExecution': {
      const cmd = cmdOf(it);
      const out = [{ k: 'tool', s: `Bash ${clip(cmd, 70)}`.trim(), name: 'Bash', at }];
      const res = clip(it.aggregated_output, 300);
      const err = it.exit_code != null && it.exit_code !== 0;
      if (res || err) out.push({ k: 'result', s: res || `exit ${it.exit_code}`, err, at });
      return out;
    }
    case 'FileChange': {
      const out = [];
      for (const [file, c] of Object.entries(it.changes || {})) {
        out.push({ k: 'tool', s: `${c.type === 'add' ? 'Write' : 'Edit'} ${path.basename(file)}`, name: c.type === 'add' ? 'Write' : 'Edit', ...changeStat(c), at });
      }
      if (it.status === 'failed' || it.status === 'declined') out.push({ k: 'result', s: clip(it.stderr || it.status, 300), err: true, at });
      return out;
    }
    case 'Extension': { // built-in image generation; `result` is the base64 PNG, never sent: the chat loads savedPath
      if (it.kind !== 'image_gen.generation') return [];
      if (it.savedPath && it.status !== 'failed') return [{ k: 'image', src: 'gen', path: it.savedPath, name: path.basename(it.savedPath), s: clip(it.revisedPrompt, 300), at }];
      return it.status === 'failed' ? [{ k: 'result', s: clip(typeof it.failure === 'string' ? it.failure : JSON.stringify(it.failure || 'gambar gagal dibuat'), 300), err: true, at }] : [];
    }
    case 'ImageView': { // Codex looked at an image file (view_image)
      const p = imgPath(it.path);
      return p ? [{ k: 'image', src: 'view', path: p, name: path.basename(p), at }] : [];
    }
    case 'SubAgentActivity': { // a subagent started or finished; agent_path ends with its task_name
      const task = taskWords(it.agent_path) || 'subagent';
      if (it.kind === 'started') return [{ k: 'tool', s: `Agent ${toolLabel('Agent', { subagent_type: 'default', description: task })}`, name: 'Agent', at }];
      return it.kind === 'completed' ? [{ k: 'result', s: `subagent ${task} selesai`, at }] : [];
    }
    case 'CollabAgentToolCall': // the agent waited for its subagents
      return it.tool === 'wait' ? [{ k: 'tool', s: 'WaitAgent subagent', name: 'WaitAgent', at }] : [];
    case 'McpToolCall': {
      const name = `mcp__${it.server}__${it.tool}`;
      const out = [{ k: 'tool', s: `${name} ${toolLabel(name, it.arguments || {})}`.trim(), name, at }];
      const r = it.result;
      const res = clip(Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('\n') : '', 300);
      const err = it.status === 'failed' || !!it.error || !!r?.isError;
      if (res || err) out.push({ k: 'result', s: res || clip(JSON.stringify(it.error || ''), 300), err, at });
      return out;
    }
    default: return [];
  }
}

const parse = l => { try { return JSON.parse(l); } catch { return null; } };

/**
 * Incremental rollout reader: calls onLine(parsed) for every complete line appended since `state.offset` whose first
 * bytes contain one of `marks`. Other lines are skipped without being assembled or parsed: a tool output carrying
 * screenshots can be several MB per line, and a tail window of the file used to fill up with them (the chat then showed
 * only the last few messages). The first call reads the whole file once; later calls only what was appended.
 * `reset()` runs first when the file was replaced or truncated. The last, unfinished line is read again next time.
 */
const HEAD = 320, CHUNK = 4 << 20;
function scanAppended(file, state, marks, onLine, reset) {
  const st = fs.statSync(file);
  if (state.ino !== st.ino || st.size < state.offset) { state.ino = st.ino; state.offset = 0; reset(); }
  if (st.size === state.offset) return st;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = state.offset, lineStart = pos, parts = [], keep = null, head = '';
    const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos));
    while (pos < st.size) {
      const got = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (got <= 0) break;
      for (let from = 0; ;) {
        const nl = buf.indexOf(10, from), end = nl === -1 || nl >= got ? got : nl;
        const piece = buf.subarray(from, end);
        if (keep === null) {
          head += piece.toString('utf8', 0, Math.min(piece.length, HEAD - head.length));
          if (head.length >= HEAD || end < got) keep = marks.some(m => head.includes(m));
        }
        if (keep !== false) parts.push(Buffer.from(piece));
        if (end === got) break;
        if (keep) { const d = parse(Buffer.concat(parts).toString('utf8')); if (d) onLine(d); }
        parts = []; keep = null; head = ''; from = nl + 1; lineStart = pos + from;
      }
      pos += got;
    }
    state.offset = lineStart;
  } finally { fs.closeSync(fd); }
  return st;
}
const capCache = m => { if (m.size > 100) m.delete(m.keys().next().value); };

const chatCache = new Map(); // file -> { ino, offset, items }
const CHAT_KEEP = 2000;
export function readRollout(file, n, toolLabel) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
  const c = chatCache.get(file) || { ino: null, offset: 0, items: [] };
  const st = scanAppended(file, c, ['item_completed'], d => { c.items.push(...rolloutItems(d, toolLabel)); }, () => { c.items = []; });
  if (c.items.length > CHAT_KEEP) c.items = c.items.slice(-CHAT_KEEP);
  chatCache.set(file, c); capCache(chatCache);
  return { items: c.items.slice(-n), size: st.size };
}

/** True for a Codex rollout (first line is session_meta). */
export function isRollout(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(300); fs.readSync(fd, b, 0, 300, 0); return /^\{"timestamp":"[^"]+","(?:ordinal":\d+,"|)type":"session_meta"/.test(b.toString('utf8')); } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/* ---------------- settings and health from the rollout ---------------- */
/** Permission mode implied by approval policy + sandbox + reviewer, as Codex records them each turn. */
export function modeFromSettings(s) {
  if (!s) return null;
  const sandbox = s.sandbox_policy?.type || (s.permission_profile?.type === 'disabled' ? 'danger-full-access' : null);
  if (s.approval_policy === 'never' && sandbox === 'danger-full-access') return 'bypassPermissions';
  if (sandbox === 'read-only') return 'readOnly';
  if (s.approvals_reviewer === 'auto_review') return 'auto';
  return 'default';
}

const settingsCache = new Map(); // file -> { ino, offset, turn, thread }
/** {model, effort, mode} from the latest turn_context / thread_settings_applied in a rollout (null if none yet). */
export function readCodexSettings(file) {
  if (!file) return null;
  const c = settingsCache.get(file) || { ino: null, offset: 0, turn: null, thread: null };
  try {
    scanAppended(file, c, ['"turn_context"', '"thread_settings_applied"'], d => {
      if (d.type === 'turn_context') c.turn = d.payload;
      else if (d.payload?.type === 'thread_settings_applied') c.thread = d.payload.thread_settings;
    }, () => { c.turn = c.thread = null; });
  } catch { return null; }
  settingsCache.set(file, c); capCache(settingsCache);
  if (!c.turn && !c.thread) return null;
  const src = { ...(c.thread || {}), ...(c.turn || {}) };
  return { model: src.model || null, effort: src.effort || src.reasoning_effort || null, mode: modeFromSettings(src) };
}

const healthCache = new Map(); // file -> { ino, offset, last, limit, compactions }
const LEVELS = [[50, 'segar'], [75, 'sedang'], [90, 'lelah'], [Infinity, 'kritis']];
/** Same shape as health.js sessionHealth, from the rollout's token_count events. */
export function codexHealth(file) {
  const empty = { ctx: null, health: null, errStreak: 0, compactions: 0 };
  if (!file) return empty;
  const c = healthCache.get(file) || { ino: null, offset: 0, last: null, limit: null, compactions: 0 };
  try {
    scanAppended(file, c, ['"token_count"', 'item_completed'], d => {
      const p = d.payload;
      if (p?.type === 'item_completed') { if (p.item?.type === 'ContextCompaction') c.compactions++; return; }
      const info = p?.type === 'token_count' ? p.info : null;
      if (!info) return;
      const u = info.last_token_usage || info.total_token_usage;
      if (u) c.last = { used: u.input_tokens || 0, at: d.timestamp };
      if (info.model_context_window) c.limit = info.model_context_window;
    }, () => { c.last = c.limit = null; c.compactions = 0; });
  } catch { return empty; }
  healthCache.set(file, c); capCache(healthCache);
  const { last, limit, compactions } = c;
  let value = { ...empty, compactions };
  if (last && last.used > 0) {
    const lim = limit || 258400;
    const pct = Math.round(last.used / lim * 1000) / 10;
    value = { ctx: { used: last.used, limit: lim, pct, at: last.at }, health: LEVELS.find(([max]) => pct < max)[1], errStreak: 0, compactions };
  }
  return value;
}
