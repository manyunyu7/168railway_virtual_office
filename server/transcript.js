// Read the tail of a Claude Code transcript as a simple, watchable conversation.
import fs from 'node:fs';
import { toolLabel } from './live.js';
import { isRollout, readRollout } from './codex.js';

const TAIL = 1.5 * 1024 * 1024;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp)$/i;
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Claude Code stores a bracketed paste (tmux sendText for long/multi-line text) as `<pasted_content id="x">…</pasted_content id="x">`: keep the text. */
export const unpaste = t => String(t ?? '').replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1');
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

export function readTranscript(file, n = 120) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
  if (isRollout(file)) return readRollout(file, n, toolLabel); // OpenAI Codex rollout, same items
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - TAIL);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  let lines = buf.toString('utf8').split('\n');
  if (start > 0) lines = lines.slice(1);
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain || d.isMeta) continue;
    const at = d.timestamp;
    const c = d.message?.content;
    if (d.type === 'user') {
      if (typeof c === 'string') { const u = unpaste(c); if (!/^\s*</.test(u)) items.push({ k: 'user', s: clip(u, 2000), at }); continue; }
      for (const b of c || []) {
        if (b.type === 'text') { const u = unpaste(b.text); if (!/^\s*</.test(u)) items.push({ k: 'user', s: clip(u, 2000), at }); }
        if (b.type === 'tool_result') items.push({ k: 'result', s: clip(textOf(b.content), 300), err: !!b.is_error, at });
      }
    } else if (d.type === 'assistant') {
      for (const b of c || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ k: 'text', s: clip(b.text, 4000), at });
        if (b.type === 'tool_use') items.push({ k: 'tool', s: `${b.name} ${toolLabel(b.name, b.input || {})}`.trim(), name: b.name, ...editStat(b.name, b.input || {}), at });
        // Claude looked at an image file: show it like Codex's image views (served by /api/sessions/:sid/image)
        if (b.type === 'tool_use' && b.name === 'Read' && IMG_RE.test(b.input?.file_path || '') && b.input.file_path.startsWith('/')) items.push({ k: 'image', src: 'view', path: b.input.file_path, name: b.input.file_path.split('/').pop(), at });
      }
    }
  }
  return { items: items.slice(-n), size: st.size };
}

// Lines added/removed by an edit, so chat views can show "+28 −6" without the diff itself
const lines = t => (typeof t === 'string' && t ? t.split('\n').length : 0);
function editStat(name, input) {
  if (name === 'Edit') return { add: lines(input.new_string), del: lines(input.old_string) };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce((a, e) => ({ add: a.add + lines(e.new_string), del: a.del + lines(e.old_string) }), { add: 0, del: 0 });
  if (name === 'Write') return { add: lines(input.content), del: 0 };
  return {};
}
