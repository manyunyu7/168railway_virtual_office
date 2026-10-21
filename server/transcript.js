// Read the tail of a Claude Code transcript as a simple, watchable conversation.
import fs from 'node:fs';
import { toolLabel } from './live.js';

const TAIL = 1.5 * 1024 * 1024;
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

export function readTranscript(file, n = 120) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
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
      if (typeof c === 'string') { if (!/^\s*</.test(c)) items.push({ k: 'user', s: clip(c, 2000), at }); continue; }
      for (const b of c || []) {
        if (b.type === 'text' && !/^\s*</.test(b.text)) items.push({ k: 'user', s: clip(b.text, 2000), at });
        if (b.type === 'tool_result') items.push({ k: 'result', s: clip(textOf(b.content), 300), err: !!b.is_error, at });
      }
    } else if (d.type === 'assistant') {
      for (const b of c || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ k: 'text', s: clip(b.text, 4000), at });
        if (b.type === 'tool_use') items.push({ k: 'tool', s: `${b.name} ${toolLabel(b.name, b.input || {})}`.trim(), at });
      }
    }
  }
  return { items: items.slice(-n), size: st.size };
}
