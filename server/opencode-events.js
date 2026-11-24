// OpenCode (sst/opencode v2) adapter: pure helpers shared by the daemon (server/opencode.js),
// the shift supervisor (hooks/opencode-run.cjs) and the tests. No imports from the rest of the
// server, so the supervisor can load this file without opening Kantor's databases.
import path from 'node:path';

export const OC_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
/** Any mode name (Claude's or Codex's too, e.g. from a manager's shift_start) → an OpenCode mode. Unknown = ask first. */
export function ocMode(mode, fallback = 'default') {
  if (OC_MODES.includes(mode)) return mode;
  if (mode === 'readOnly') return 'plan';
  if (!mode || mode === 'ikut') return OC_MODES.includes(fallback) ? fallback : 'default';
  return 'default'; // auto, dontAsk and anything else: never more permissive than asking
}

/**
 * Session permission rules for a mode. OpenCode evaluates rules last-match-wins and puts session rules after the
 * agent's defaults (whose base is "* allow"), so the safe modes must say "ask" explicitly. Deny rules the owner set
 * in their own OpenCode config are appended again at the end so a Kantor mode never loosens them.
 */
export function ocPermissions(mode, userDeny = []) {
  const r = (action, effect, resource = '*') => ({ action, resource, effect });
  const ask = ['edit', 'shell', 'webfetch', 'websearch', 'external_directory'];
  let rules;
  switch (ocMode(mode)) {
    case 'bypassPermissions': rules = [r('*', 'allow')]; break;
    case 'acceptEdits': rules = [...ask.filter(a => a !== 'edit').map(a => r(a, 'ask')), r('edit', 'allow')]; break;
    case 'plan': rules = [...ask.filter(a => a !== 'edit').map(a => r(a, 'ask')), r('edit', 'deny')]; break;
    default: rules = ask.map(a => r(a, 'ask'));
  }
  // Kantor's own MCP tools (board, wiki, pesan, kunci, ...) never need a prompt, same as on the other engines
  rules.push(r('kantor_*', 'allow'));
  const deny = (Array.isArray(userDeny) ? userDeny : []).filter(x => x && x.effect === 'deny' && typeof x.action === 'string' && typeof x.resource === 'string');
  return [...rules, ...deny.map(x => r(x.action, 'deny', x.resource))];
}

/** "provider/model" or "provider/model#variant" → OpenCode's Model.Ref; null for anything else. */
export function ocModelRef(slug) {
  const m = /^([^/#\s]+)\/([^#\s]+)(?:#([^#\s]+))?$/.exec(String(slug || '').trim());
  return m ? { providerID: m[1], id: m[2], ...(m[3] ? { variant: m[3] } : {}) } : null;
}
export const ocModelSlug = ref => ref && ref.providerID && ref.id ? `${ref.providerID}/${ref.id}` : null;

/** Lines of `opencode models` → [{slug, name, provider}]. */
// Free models (`*-free`) may train on request data; OpenCode Go refuses them unless the org allows that, so they are
// flagged and listed last instead of looking like a normal choice.
export const isFreeModel = slug => /-free$/.test(String(slug || '').replace(/#.*$/, ''));
export function parseOcModels(text) {
  const seen = new Set();
  const list = String(text || '').split('\n').flatMap(line => {
    const slug = line.trim();
    const ref = ocModelRef(slug);
    if (!ref || seen.has(slug)) return [];
    seen.add(slug);
    return [{ slug, name: ref.id, provider: ref.providerID, ...(isFreeModel(slug) ? { free: true, desc: 'Gratis: bisa melatih model dengan data permintaan; OpenCode Go menolaknya kecuali diizinkan di console.' } : {}) }];
  });
  return [...list.filter(m => !m.free), ...list.filter(m => m.free)];
}

/* ---------------- tools ---------------- */
// OpenCode tool names → the names Kantor's office log, chat and hook logic already know (Claude's).
const TOOL_NAMES = { read: 'Read', write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', patch: 'Edit', apply_patch: 'Edit', shell: 'Bash', bash: 'Bash',
  grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', todoread: 'TodoRead',
  subagent: 'Agent', task: 'Agent', question: 'AskUserQuestion', skill: 'Skill', execute: 'Code' };
const mcpName = name => {
  const m = /^kantor[_.](.+)$/.exec(String(name || ''));
  return m ? `mcp__kantor__${m[1]}` : null;
};
/** OpenCode tool call → {name, input} in Kantor's (Claude) vocabulary. `cwd` turns relative paths absolute. */
export function ocTool(name, input = {}, cwd = '') {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const mcp = mcpName(name);
  if (mcp) return { name: mcp, input: a };
  const abs = p => typeof p === 'string' && p && cwd && !path.isAbsolute(p) ? path.join(cwd, p) : p;
  const file = abs(a.filePath || a.file_path || a.path);
  const out = { ...a };
  if (file) out.file_path = file;
  if (a.command) out.command = a.command;
  if (a.pattern) out.pattern = a.pattern;
  if (a.url) out.url = a.url;
  if (a.query) out.query = a.query;
  if (name === 'subagent' || name === 'task') { out.description = a.description || a.prompt?.slice?.(0, 80) || ''; out.subagent_type = a.agent || a.subagent_type || 'general'; }
  if (name === 'execute') { // code mode: a script that calls MCP tools (tools.kantor.board_list())
    const calls = [...String(a.code || '').matchAll(/tools\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)/g)].map(x => `${x[1]}.${x[2]}`);
    out.description = calls.length ? [...new Set(calls)].join(', ') : 'skrip';
  }
  return { name: TOOL_NAMES[name] || name || 'Tool', input: out };
}

/** Permission request → {tool_name, tool_input} for Kantor's inbox. Resources are relative to the session folder. */
export function ocPermissionTool(req, cwd = '') {
  const res = Array.isArray(req?.resources) ? req.resources : [];
  const first = res[0] && res[0] !== '*' ? res[0] : '';
  const abs = p => p && cwd && !path.isAbsolute(p) ? path.join(cwd, p) : p;
  const meta = req?.metadata && typeof req.metadata === 'object' ? req.metadata : {};
  switch (req?.action) {
    case 'shell': return { tool_name: 'Bash', tool_input: { command: res.join('\n') } };
    case 'edit': return { tool_name: 'Edit', tool_input: { file_path: abs(first), ...(meta.files?.[0]?.patch ? { diff: String(meta.files[0].patch).slice(0, 3000) } : {}) } };
    case 'read': return { tool_name: 'Read', tool_input: { file_path: abs(first) } };
    case 'webfetch': return { tool_name: 'WebFetch', tool_input: { url: first } };
    case 'websearch': return { tool_name: 'WebSearch', tool_input: { query: first } };
    case 'external_directory': return { tool_name: 'Folder di luar ruangan', tool_input: { file_path: first } };
  }
  const mcp = mcpName(req?.action);
  if (mcp) return { tool_name: mcp, tool_input: meta.input && typeof meta.input === 'object' ? meta.input : {} };
  return { tool_name: String(req?.action || 'Izin'), tool_input: { resources: res, ...(meta.input ? { input: meta.input } : {}) } };
}

/* ---------------- events → Kantor hook payloads ---------------- */
export function createOcState({ sid, cwd = '', transcript = null, model = null } = {}) {
  return { sid, cwd, transcript, model, tools: new Map(), prompts: new Map(), children: new Map() };
}
const toolText = content => (Array.isArray(content) ? content : []).filter(c => c?.type === 'text').map(c => c.text).join('\n');

/**
 * One event from GET /api/event → { hooks: [payload...], snapshot: bool }.
 * payloads are Claude-shaped (hook_event_name, tool_name, ...) so live.js handles them like any other engine.
 * Events of other sessions are ignored, except the children (subagents) of this session.
 */
export function mapOcEvent(ev, st) {
  const out = { hooks: [], snapshot: false };
  if (!ev || typeof ev !== 'object' || !st) return out;
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
  const type = ev.type;
  // kantor_event: OpenCode's event id. Kantor drops a payload identical to one from the last 3 s (duplicateHook); without
  // the id, two quick failing turns sent identical Stop payloads and the second was dropped, leaving the session 'working'.
  const base = extra => ({ session_id: st.sid, cwd: st.cwd, ...(st.transcript ? { transcript_path: st.transcript } : {}), ...(st.model ? { model: st.model } : {}),
    kantor_engine: 'opencode', kantor_sid: st.sid, ...(ev.id ? { kantor_event: ev.id } : {}), ...extra });
  const sessionID = d.sessionID || d.session?.id;

  // a subagent: a child session created under ours
  if (type === 'session.created') { // data: { sessionID, parentID, agent, title, ... }
    const info = d.session || d.info || d, id = info?.sessionID || info?.id;
    if (info?.parentID === st.sid && id && !st.children.has(id)) {
      st.children.set(id, { type: info.agent || 'general' });
      out.hooks.push(base({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: info.agent || 'general' }));
    }
    return out;
  }
  const child = sessionID && sessionID !== st.sid ? st.children.get(sessionID) : null;
  if (sessionID !== st.sid && !child) return out;
  const sub = child ? { agent_id: sessionID, agent_type: child.type } : {};

  switch (type) {
    case 'session.inbox.enqueued':
      if (!child && d.item?.type === 'user' && typeof d.item.payload?.text === 'string') st.prompts.set(d.inboxID, d.item.payload.text);
      break;
    case 'session.inbox.delivered': {
      const text = st.prompts.get(d.inboxID);
      st.prompts.delete(d.inboxID);
      if (!child && text) { out.hooks.push(base({ hook_event_name: 'UserPromptSubmit', prompt: text })); out.snapshot = true; }
      break;
    }
    case 'session.execution.started':
      if (!child) out.hooks.push(base({ hook_event_name: 'UserPromptSubmit' }));
      break;
    case 'session.step.started':
      if (!child && d.model?.providerID && d.model?.id) st.model = `${d.model.providerID}/${d.model.id}`;
      break;
    case 'session.tool.input.started':
      st.tools.set(d.id, { name: d.name, input: {} });
      break;
    case 'session.tool.called': {
      const t = st.tools.get(d.id) || { name: d.name };
      t.input = d.input || {};
      st.tools.set(d.id, t);
      const tool = ocTool(t.name, t.input, st.cwd);
      out.hooks.push(base({ hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: tool.input, tool_use_id: d.id, ...sub }));
      break;
    }
    case 'session.tool.success': case 'session.tool.failed': {
      const t = st.tools.get(d.id) || { name: d.name, input: {} };
      st.tools.delete(d.id);
      const tool = ocTool(t.name, t.input, st.cwd);
      const failed = type === 'session.tool.failed';
      const text = toolText(d.content) || (typeof d.error === 'string' ? d.error : d.error?.message) || '';
      out.hooks.push(base({ hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool.name, tool_input: tool.input, tool_use_id: d.id,
        ...(failed ? { error: text.slice(0, 500) || 'gagal' } : { tool_response: text.slice(0, 2000) }), ...sub }));
      if (!child) out.snapshot = true;
      break;
    }
    case 'session.text.ended':
      if (!child) out.snapshot = true;
      break;
    case 'session.compaction.started':
      if (!child) out.hooks.push(base({ hook_event_name: 'PreCompact', trigger: 'auto' }));
      break;
    case 'session.compaction.ended': case 'session.compaction.failed':
      if (!child) { out.hooks.push(base({ hook_event_name: 'PostCompact', trigger: 'auto' })); out.snapshot = true; }
      break;
    case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted':
      if (child) { st.children.delete(sessionID); out.hooks.push(base({ hook_event_name: 'SubagentStop', ...sub })); break; }
      st.tools.clear();
      out.hooks.push(base(type === 'session.execution.interrupted' ? { hook_event_name: 'Interrupt' }
        : { hook_event_name: 'Stop', ...(type === 'session.execution.failed' ? { kantor_error: String(d.error?.message || d.message || 'gagal').slice(0, 300) } : {}) }));
      out.snapshot = true;
      break;
    case 'permission.asked': {
      // a subagent runs in the background and the TUI does not show its prompts: without the inbox it would wait forever
      const p = ocPermissionTool(d, st.cwd);
      out.hooks.push(base({ hook_event_name: 'PermissionRequest', ...p, tool_use_id: d.source?.id || null, kantor_permission_id: d.id,
        kantor_permission_session: sessionID, ...(child ? { kantor_subagent: child.type } : {}) }));
      break;
    }
  }
  return out;
}

/* ---------------- transcript (message list snapshot) ---------------- */
// The supervisor writes GET /api/session/:id/message as JSONL (one message per line). These become Chat items;
// reasoning is never shown.
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export function ocTranscriptItems(m, toolLabel = (name, input) => `${name} ${JSON.stringify(input)}`.slice(0, 300), cwd = '') {
  const items = [];
  if (!m || typeof m !== 'object') return items;
  const at = m.time?.created ? new Date(m.time.created).toISOString() : undefined;
  if (m.type === 'user') {
    const text = typeof m.text === 'string' ? m.text : typeof m.payload?.text === 'string' ? m.payload.text : '';
    if (text.trim()) items.push({ k: 'user', s: clip(text, 8000), at });
  } else if (m.type === 'assistant') {
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === 'text' && String(c.text || '').trim()) items.push({ k: 'text', s: clip(c.text, 16000), at });
      else if (c?.type === 'tool') {
        const t = ocTool(c.name, c.state?.input, cwd);
        items.push({ k: 'tool', name: t.name, s: clip(toolLabel(t.name, t.input) || t.name, 1000), at });
        const status = c.state?.status;
        const text = toolText(c.state?.content) || (typeof c.state?.error === 'string' ? c.state.error : c.state?.error?.message) || '';
        if (status === 'error' || status === 'failed') items.push({ k: 'result', s: clip(text || 'gagal', 500), err: true, at });
        else if (text.trim()) items.push({ k: 'result', s: clip(text, 500), at });
      }
    }
    if (m.error && (m.error.message || typeof m.error === 'string')) items.push({ k: 'result', s: clip(m.error.message || m.error, 500), err: true, at });
  } else if (m.type === 'compaction' && (m.summary || m.text)) items.push({ k: 'compact', s: clip(m.summary || m.text, 40000), at });
  return items;
}
export const isOcTranscript = file => /\.opencode\.jsonl$/.test(file || '');
