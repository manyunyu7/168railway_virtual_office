// Gemini through the subscription-backed Antigravity CLI. Credentials stay with agy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, ROOT_DIR } from './config.js';

export const AGY_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
export const agyMode = mode => AGY_MODES.includes(mode) ? mode : mode === 'readOnly' ? 'plan' : 'default';
export function agyBin() {
  const custom = config().antigravity?.bin;
  return [custom, ...String(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'agy')),
    path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']
    .find(p => p && path.isAbsolute(p) && fs.existsSync(p)) || null;
}
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const readJSON = file => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Konfigurasi Antigravity bukan objek JSON: ${file}`);
  return value;
};
function saveJSON(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.kantor-backup-${Date.now()}`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// agy does NOT load hooks or MCP from --settings. Add only our named entries,
// preserving other integrations. Hooks are inert outside a Kantor-started shift.
export function installAgyIntegration(dir = path.join(os.homedir(), '.gemini/config')) {
  const file = path.join(dir, 'hooks.json'), hooks = readJSON(file);
  const command = `${q(process.execPath)} ${q(path.join(ROOT_DIR, 'hooks/antigravity-hook.cjs'))}`;
  hooks['kantor-claude'] = Object.fromEntries(['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'].map(ev => [ev,
    ['PreToolUse', 'PostToolUse'].includes(ev)
      ? [{ matcher: '.*', hooks: [{ type: 'command', command: `${command} ${ev}`, timeout: 5 }] }]
      : [{ type: 'command', command: `${command} ${ev}`, timeout: 5 }]]));
  const mcpFile = path.join(dir, 'mcp_config.json'), mcp = readJSON(mcpFile);
  mcp.mcpServers ||= {};
  const entry = mcp.mcpServers.kantor;
  if (entry && !entry.args?.some(x => /[/\\]server[/\\]mcp-stdio\.js$/.test(x)))
    throw new Error('MCP bernama kantor sudah dipakai integrasi lain di Antigravity. Ganti nama integrasi itu dulu.');
  mcp.mcpServers.kantor = { command: process.execPath, args: [path.join(ROOT_DIR, 'server/mcp-stdio.js')], timeoutSeconds: 960 };
  saveJSON(file, hooks); saveJSON(mcpFile, mcp);
}

export function agyArgs({ cwd, model, effort, mode, resumeSid, task, settingsFile }) {
  const a = ['--settings', settingsFile];
  if (resumeSid) a.push('--conversation', resumeSid);
  if (model) a.push('--model', model);
  if (effort) a.push('--effort', effort);
  const m = agyMode(mode);
  if (m === 'bypassPermissions') a.push('--dangerously-skip-permissions');
  else if (m !== 'default') a.push('--mode', m === 'acceptEdits' ? 'accept-edits' : m);
  if (task && !resumeSid) a.push('--prompt-interactive', task);
  return a;
}
export function agySettings(cwd, previous = null) {
  if (!previous) {
    try { previous = readJSON(path.join(os.homedir(), '.gemini/antigravity-cli/settings.json')).permissions; } catch {}
  }
  const permissions = { ...(previous || {}), allow: [...new Set([...(previous?.allow || []), 'mcp(kantor/*)'])] };
  return { trustedWorkspaces: [cwd], agentMode: '', toolPermission: 'request-review',
    permissions, useG1Credits: false, showTips: false, showFeedbackSurvey: false, altScreenMode: 'never' };
}
let modelsCache = null;
export function parseAgyModels(text) {
  return String(text).split('\n').flatMap(line => {
    const m = /^([a-z][\w.-]+)\t(.+)$/.exec(line.trim());
    return m ? [{ slug: m[1], name: m[2], desc: '' }] : [];
  });
}
export async function agyModels() {
  const bin = agyBin();
  if (!bin) return { available: false, models: [], modes: AGY_MODES };
  if (modelsCache && Date.now() - modelsCache.at < 600e3) return modelsCache.value;
  return new Promise(resolve => execFile(bin, ['models'], { timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
    const models = parseAgyModels(stdout);
    const value = { available: true, models, modes: AGY_MODES, ...(err ? { error: 'Daftar model belum terbaca; jalankan agy dan login Google di mesin ini.' } : {}) };
    if (models.length) modelsCache = { at: Date.now(), value };
    resolve(value);
  }));
}

export function agyTool(name, a = {}) {
  const decoded = value => { try { return JSON.parse(value); } catch { return value; } };
  if (name === 'call_mcp_tool') {
    const server = decoded(a.ServerName), tool = decoded(a.ToolName), input = decoded(a.Arguments);
    if (typeof server === 'string' && typeof tool === 'string') return { name: `mcp__${server}__${tool}`, input: input && typeof input === 'object' ? input : {} };
  }
  const names = { run_command: 'Bash', view_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit',
    grep_search: 'Grep', find_by_name: 'Glob', search_web: 'WebSearch', read_url_content: 'WebFetch' };
  return { name: names[name] || name, input: { ...a, command: a.CommandLine || a.command,
    file_path: a.AbsolutePath || a.TargetFile || a.file_path, pattern: a.Query || a.Pattern || a.pattern,
    query: a.Query || a.query, url: a.Url || a.url } };
}
export function normalizeAgyHook(event, p) {
  const t = agyTool(p.toolCall?.name, p.toolCall?.args);
  return { session_id: p.conversationId, cwd: p.workspacePaths?.[0], transcript_path: p.transcriptPath, model: p.modelName,
    hook_event_name: event === 'PreInvocation' ? 'UserPromptSubmit' : event === 'PostToolUse' && p.error ? 'PostToolUseFailure' : event,
    tool_name: t.name, tool_input: t.input, tool_use_id: String(p.stepIdx ?? ''), error: p.error,
    kantor_engine: 'antigravity', kantor_sid: p.kantor_sid };
}
export const isAgyTranscript = file => /[/\\]antigravity(?:-cli|-ide)?[/\\]brain[/\\].+[/\\]transcript(?:_full)?\.jsonl$/.test(file || '');
export function readAgyTranscript(file, n = 120) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
  const stat = fs.statSync(file), start = Math.max(0, stat.size - 4 * 1024 * 1024), fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(stat.size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n'); if (start) lines.shift();
  const items = [];
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const at = d.created_at, content = typeof d.content === 'string' ? d.content : '';
    if (d.type === 'USER_INPUT') {
      const user = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] || content;
      if (user.trim()) items.push({ k: 'user', s: user.slice(0, 8000), at });
    } else if (['PLANNER_RESPONSE', 'MODEL_RESPONSE', 'AGENT_MESSAGE'].includes(d.type)) {
      if (content.trim()) items.push({ k: 'text', s: content.slice(0, 16000), at });
      for (const call of d.tool_calls || []) {
        const tool = agyTool(call.name, call.args);
        items.push({ k: 'tool', name: tool.name, s: `${tool.name} ${JSON.stringify(tool.input)}`.slice(0, 1000), at });
      }
    } else if (d.type === 'TOOL_CALL') {
      items.push({ k: 'tool', name: d.tool_name || 'Tool', s: content.slice(0, 1000), at });
    } else if (['TOOL_RESULT', 'GENERIC'].includes(d.type) && content.trim()) items.push({ k: 'result', s: content.slice(0, 500), err: d.status === 'ERROR', at });
  }
  return { items: items.slice(-n), size: stat.size };
}
