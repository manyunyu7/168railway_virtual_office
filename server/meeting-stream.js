import { bus } from './live.js';

const THROTTLE_MS = 80;
const typing = new Map(); // office -> Map(meetingId -> { who, role, text })

/** Splits a byte stream into JSON lines; bad lines are skipped. */
export function createLineParser(onObj) {
  let buf = '';
  const line = l => { l = l.trim(); if (!l) return; try { onObj(JSON.parse(l)); } catch {} };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    flush() { line(buf); buf = ''; },
  };
}

/**
 * Reads `claude -p --output-format stream-json --include-partial-messages` events.
 * onText receives the cumulative text of the assistant message being written
 * (a new message, e.g. after a tool call, starts from empty). `result` ends up as
 * the final `type:'result'` object, the same shape `--output-format json` printed.
 */
export function createClaudeStream(onText) {
  let text = '';
  const st = { result: null, handle(o) {
    if (o.type === 'result') { st.result = o; return; }
    if (o.type !== 'stream_event' || o.parent_tool_use_id) return;
    const e = o.event || {};
    if (e.type === 'message_start') { if (text) { text = ''; onText(text); } }
    else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) { text += e.delta.text; onText(text); }
  } };
  return st;
}

/** Live "who is speaking" state for a meeting turn, broadcast as `meeting-typing` events. */
export function createTyper(office, meeting, role) {
  const key = { who: role.name, role: role.id, text: '' };
  let timer = null, dirty = false, closed = false;
  const emit = done => bus.emit('msg', { t: 'meeting-typing', office, meeting, who: key.who, role: key.role, text: key.text, done });
  const flush = () => { timer = null; if (dirty && !closed) { dirty = false; emit(false); } };
  return {
    start() {
      if (!typing.has(office)) typing.set(office, new Map());
      typing.get(office).set(meeting, key);
      emit(false);
    },
    /** Cumulative text so far. */
    text(t) {
      if (closed || t === key.text) return;
      key.text = t; dirty = true;
      if (!timer) timer = setTimeout(flush, THROTTLE_MS);
    },
    end() {
      if (closed) return;
      closed = true; clearTimeout(timer);
      typing.get(office)?.delete(meeting);
      emit(true);
    },
  };
}

export const getTyping = (office, meeting) => typing.get(office)?.get(meeting) || null;
