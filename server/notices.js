// Per-session reminders that ride along with the next hook answer (PreToolUse / UserPromptSubmit additionalContext).
// They never cost a turn: the session sees them the next time it uses a tool or gets a prompt, exactly once.
const queues = new Map(); // sid -> Map(key -> text)
const MAX_PER_SID = 10;

/** Queue a reminder for a session. The same key replaces an older, not yet delivered reminder. */
export function pushNotice(sid, text, key = text) {
  if (!sid || !text) return;
  let q = queues.get(sid);
  if (!q) queues.set(sid, q = new Map());
  q.delete(key);
  q.set(key, String(text));
  while (q.size > MAX_PER_SID) q.delete(q.keys().next().value);
}

/** Take (and clear) everything waiting for a session. */
export function takeNotices(sid) {
  const q = queues.get(sid);
  if (!q?.size) return [];
  queues.delete(sid);
  return [...q.values()];
}

export const pendingNotices = sid => queues.get(sid)?.size || 0;
export function dropNotices(sid) { queues.delete(sid); }
