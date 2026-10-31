import fs from 'node:fs';

const parse = l => { try { return JSON.parse(l); } catch { return null; } };

/**
 * Incremental JSONL reader: calls onLine(parsed) for every complete line appended since `state.offset` whose first
 * bytes contain one of `marks` (null reads all record types, regardless of key order). Other lines are skipped without being assembled or parsed: a tool output carrying
 * screenshots can be several MB per line, and a tail window of the file used to fill up with them (the chat then showed
 * only the last few messages). The first call reads the whole file once; later calls only what was appended.
 * `reset()` runs first when the file was replaced or truncated. The last, unfinished line is read again next time.
 */
const HEAD = 320, CHUNK = 4 << 20;
export function scanAppended(file, state, marks, onLine, reset, includeFinal = false) {
  const st = fs.statSync(file);
  if (state.ino !== st.ino || st.size < state.offset) { state.ino = st.ino; state.offset = 0; reset(); }
  if (st.size === state.offset) return st;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = state.offset, lineStart = pos, parts = [], keep = marks ? null : true, head = '';
    const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos));
    while (pos < st.size) {
      const got = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (got <= 0) break;
      for (let from = 0; ;) {
        const nl = buf.indexOf(10, from), end = nl === -1 || nl >= got ? got : nl;
        const piece = buf.subarray(from, end);
        if (keep === null) {
          head += piece.toString('utf8', 0, Math.min(piece.length, HEAD - head.length));
          if (head.length >= HEAD || end < got) keep = marks.some(m => head.includes(m));
        }
        if (keep !== false) parts.push(Buffer.from(piece));
        if (end === got) break;
        if (keep) { const d = parse(Buffer.concat(parts).toString('utf8')); if (d) onLine(d); }
        parts = []; keep = marks ? null : true; head = ''; from = nl + 1; lineStart = pos + from;
      }
      pos += got;
    }
    // Native transcripts can end with a complete JSON record before its newline.
    // Only advance when it parses, so a half-written record is retried next time.
    if (includeFinal && keep && parts.length) {
      const d = parse(Buffer.concat(parts).toString('utf8'));
      if (d) { onLine(d); lineStart = pos; }
    }
    state.offset = lineStart;
  } finally { fs.closeSync(fd); }
  return st;
}
