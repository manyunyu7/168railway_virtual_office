// Token count of a running Claude Code or Codex subagent, like the "↓ 126.3k tokens" in Claude Code's own agent list.
// Claude Code writes each subagent's transcript next to the parent's: <dir>/<sessionId>/subagents/agent-<agentId>.jsonl.
// The figure is the size of the subagent's latest turn (input + cache read + cache creation + output of its last
// assistant message), which is what Claude Code reports as the agent's total tokens.
import fs from 'node:fs';
import path from 'node:path';

const TAIL = 256 * 1024;
const cache = new Map(); // file -> { size, tokens }

export const usageTotal = u => u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : 0;

/** Latest assistant usage total in some JSONL text (lines may be cut at the start). */
export function lastUsageTokens(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('usage"')) continue; // "usage" (Claude) or "last_token_usage" (Codex)
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type === 'assistant' && d.message?.usage) return usageTotal(d.message.usage);
    // Codex rollout: the latest turn's size, the same figure as Claude's above
    if (d.type === 'event_msg' && d.payload?.type === 'token_count' && d.payload.info?.last_token_usage) return d.payload.info.last_token_usage.total_tokens || 0;
  }
  return null;
}

export const subagentFile = (transcript, agentId) => transcript && agentId && /^[\w-]+$/.test(agentId)
  ? path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`) : null;

export const subagentTokens = (transcript, agentId) => fileTokens(subagentFile(transcript, agentId));

const codexFiles = new Map(); // agentId -> rollout file
const pad = n => String(n).padStart(2, '0');
/** A Codex subagent's own rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<agentId>.jsonl (local date of its start). */
export function codexSubagentFile(agentId, at = Date.now()) {
  if (!agentId || !/^[\w-]+$/.test(agentId)) return null;
  if (codexFiles.has(agentId)) return codexFiles.get(agentId);
  const root = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions');
  for (const t of new Set([at, Date.now()])) {
    const d = new Date(t), dir = path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let name = null; try { name = fs.readdirSync(dir).find(n => n.endsWith(`-${agentId}.jsonl`)); } catch {}
    if (name) { if (codexFiles.size > 500) codexFiles.clear(); codexFiles.set(agentId, path.join(dir, name)); return codexFiles.get(agentId); }
  }
  return null;
}

/** Latest-turn tokens of a transcript or rollout file, or null when it is not there. Re-reads only when the file grew. */
export function fileTokens(f) {
  if (!f) return null;
  let st; try { st = fs.statSync(f); } catch { return null; }
  const c = cache.get(f);
  if (c && c.size === st.size) return c.tokens;
  let tokens = c?.tokens ?? null;
  try {
    const start = Math.max(0, st.size - TAIL), buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    tokens = lastUsageTokens(buf.toString('utf8')) ?? tokens;
  } catch {}
  if (cache.size > 500) cache.clear();
  cache.set(f, { size: st.size, tokens });
  return tokens;
}
