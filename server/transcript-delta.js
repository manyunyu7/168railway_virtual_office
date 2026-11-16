// Shared, bounded cursor contract for Claude, Codex and Antigravity transcripts.
import { randomUUID, createHash } from 'node:crypto';

export function resetTranscript(state) {
  state.items = [];
  state.next = 0;
  // A new identity after inode replacement, truncation, eviction or restart.
  state.generation = randomUUID();
}

export function appendTranscript(state, items, keep = 2000) {
  state.items.push(...items);
  state.next = (state.next || 0) + items.length;
  if (state.items.length > keep) state.items = state.items.slice(-keep);
}

export function transcriptResponse(state, stat, n, options) {
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(n)) || 120));
  const full = state.items.slice(-limit);
  if (!options) return { items: full, size: stat.size };
  const scope = createHash('sha256').update(String(options.sid || '')).digest('base64url').slice(0, 16);
  const cursor = Buffer.from(JSON.stringify({ v: 1, g: state.generation, s: scope, i: state.next })).toString('base64url');
  let prior;
  try {
    if (typeof options.after === 'string' && options.after.length <= 512) {
      prior = JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8'));
    }
  } catch { /* Invalid/expired cursors get a full reset, never an incorrect delta. */ }
  const first = state.next - state.items.length;
  const valid = prior?.v === 1 && prior.g === state.generation && prior.s === scope &&
    Number.isSafeInteger(prior.i) && prior.i >= first && prior.i <= state.next && state.next - prior.i <= limit;
  return {
    items: valid ? state.items.slice(prior.i - first) : full,
    size: stat.size,
    cursor,
    reset: !valid,
  };
}
