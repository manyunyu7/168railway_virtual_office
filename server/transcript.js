import { resetTranscript, appendTranscript, transcriptResponse } from './transcript-delta.js';
// Read recent conversation items incrementally without losing chat behind large transcript records.
import fs from 'node:fs';
import { toolLabel } from './live.js';
import { isAgyTranscript, readAgyTranscript } from './antigravity.js';
import { isRollout, readRollout, stepRollout } from './codex.js';
import { isOcTranscript, readOcTranscript } from './opencode.js';
import { scanAppended } from './jsonl.js';

// Keep normalized conversation items, not a byte window filled by screenshots.
const cache = new Map(), KEEP = 2000;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp)$/i;
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Claude Code stores a bracketed paste (tmux sendText for long/multi-line text) as `<pasted_content id="x">…</pasted_content id="x">`: keep the text. */
export const unpaste = t => String(t ?? '').replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1');
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

export function readTranscript(file, n = 120, options) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
  if (isAgyTranscript(file)) return readAgyTranscript(file, n, options);
  if (isRollout(file)) return readRollout(file, n, toolLabel, options); // OpenAI Codex rollout, same items
  if (isOcTranscript(file)) return readOcTranscript(file, n, options, toolLabel); // OpenCode message snapshot (hooks/opencode-run.cjs)
  const { c, st } = scanClaude(file);
  return transcriptResponse(c, st, n, options);
}

function scanClaude(file, budget = 0) {
  const c = cache.get(file) || { ino: null, offset: 0, items: [] };
  const st = scanAppended(file, c, null, d => {
    appendTranscript(c, claudeItems(d), KEEP);
  }, () => { resetTranscript(c); }, true, budget);
  cache.delete(file); cache.set(file, c); // paling baru dipakai di belakang: yang dibuang yang paling lama tidak dibuka
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return { c, st };
}

// Membaca transcript yang belum ada di cache (sesudah restart, atau chat yang lama tidak dibuka) bisa berarti
// 150-300 MB JSONL penuh screenshot. Sekali jalan itu menahan event loop 0,15 dtk di Mac yang santai, dan 2+ dtk
// saat load tinggi dan swap, sehingga semua chat dan board ikut macet. Route chat memanggil ini dulu: bacaan dicicil
// per WARM_SLICE dan event loop sempat jalan di antaranya; readTranscript sesudahnya tinggal membaca dari cache.
const WARM_SLICE = 4 << 20;
const tick = () => new Promise(r => setImmediate(r));
export async function warmTranscript(file) {
  if (!file || !fs.existsSync(file) || isAgyTranscript(file) || isOcTranscript(file)) return;
  const step = isRollout(file) ? () => stepRollout(file, toolLabel, WARM_SLICE) : () => scanClaude(file, WARM_SLICE).c.more;
  for (let i = 0; i < 1e5 && step(); i++) await tick();
}

function claudeItems(d) {
  const items = [];
  if (d.isSidechain || d.isMeta) return items;
  const at = d.timestamp;
  const c = d.message?.content;
  if (d.type === 'user') {
    // ringkasan kompaksi: kartu sendiri di chat, isinya utuh (bisa panjang)
    if (d.isCompactSummary) { const t = typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); items.push({ k: 'compact', s: clip(t, 40000), at }); return items; }
    if (typeof c === 'string') { const u = unpaste(c); if (!/^\s*</.test(u)) items.push({ k: 'user', s: clip(u, 2000), at }); return items; }
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
  return items;
}

// Lines added/removed by an edit, so chat views can show "+28 −6" without the diff itself
const lines = t => (typeof t === 'string' && t ? t.split('\n').length : 0);
function editStat(name, input) {
  if (name === 'Edit') return { add: lines(input.new_string), del: lines(input.old_string) };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce((a, e) => ({ add: a.add + lines(e.new_string), del: a.del + lines(e.old_string) }), { add: 0, del: 0 });
  if (name === 'Write') return { add: lines(input.content), del: 0 };
  return {};
}
