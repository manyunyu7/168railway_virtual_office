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
  if (options && options.before !== undefined && options.before !== null) return transcriptPage(state, options.before, options.gen, n);
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
  const base = state.next - state.items.length; // sequence of the oldest item still cached
  const valid = prior?.v === 1 && prior.g === state.generation && prior.s === scope &&
    Number.isSafeInteger(prior.i) && prior.i >= base && prior.i <= state.next && state.next - prior.i <= limit;
  // first: absolute sequence of items[0]; older: the cache still holds items before it (page with ?before=first&gen=)
  const first = valid ? prior.i : state.next - full.length;
  return {
    items: valid ? state.items.slice(prior.i - base) : full,
    size: stat.size,
    cursor,
    reset: !valid,
    first,
    gen: state.generation,
    older: first > base,
  };
}

/** Paging backwards: at most n (1..200) items right before sequence `before`, only within the same generation and cached window. */
export function transcriptPage(state, before, gen, n) {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(n)) || 120));
  const base = state.next - state.items.length;
  const seq = typeof before === 'number' ? before : /^\d{1,15}$/.test(String(before)) ? Number(before) : NaN;
  if (!gen || gen !== state.generation || !Number.isSafeInteger(seq) || seq < base || seq > state.next) {
    return { items: [], reset: true, gen: state.generation };
  }
  const first = Math.max(base, seq - limit);
  return { items: state.items.slice(first - base, seq - base), first, gen: state.generation, older: first > base };
}
