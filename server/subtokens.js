// Token count of a running Claude Code subagent, like the "↓ 126.3k tokens" in Claude Code's own agent list.
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
    if (!l.includes('"usage"')) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type === 'assistant' && d.message?.usage) return usageTotal(d.message.usage);
  }
  return null;
}

export const subagentFile = (transcript, agentId) => transcript && agentId && /^[\w-]+$/.test(agentId)
  ? path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`) : null;

/** Tokens of one subagent, or null when its transcript is not there. Re-reads only when the file grew. */
export function subagentTokens(transcript, agentId) {
  const f = subagentFile(transcript, agentId);
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
