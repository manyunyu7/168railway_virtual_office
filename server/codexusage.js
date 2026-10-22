// Token usage of Codex shifts, read from rollouts (~/.codex/sessions) into the same `usage` table payroll uses.
// Cost stays 0: a ChatGPT subscription is not billed per token, so only tokens are shown.
import fs from 'node:fs';
import path from 'node:path';
import { globalDb, one, run, all, tx } from './db.js';
import { officeForCwd } from './offices.js';

const DIR = () => path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions');
const localDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function* rollouts(dir, sinceMs) {
  let years; try { years = fs.readdirSync(dir); } catch { return; }
  for (const y of years) for (const m of safe(path.join(dir, y))) for (const d of safe(path.join(dir, y, m))) {
    const base = path.join(dir, y, m, d);
    for (const f of safe(base)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
      const full = path.join(base, f);
      try { if (fs.statSync(full).mtimeMs >= sinceMs) yield full; } catch {}
    }
  }
}
const safe = d => { try { return fs.readdirSync(d); } catch { return []; } };

/** Add up new token_usage_record lines of rollouts whose folder belongs to an office. Returns true if anything changed. */
export function scanCodexUsage({ days = 60 } = {}) {
  const g = globalDb();
  let touched = false;
  for (const f of rollouts(DIR(), Date.now() - days * 864e5)) {
    const st = fs.statSync(f);
    const prev = one(g, 'SELECT * FROM usage_files WHERE path = ?', f);
    if (prev && prev.size === st.size) continue;
    let office = prev?.office || null, sid = prev?.sid || null, model = prev?.last_msg || null;
    const fd = fs.openSync(f, 'r');
    const acc = new Map();
    let consumed = prev?.offset || 0;
    try {
      const buf = Buffer.alloc(st.size - consumed);
      fs.readSync(fd, buf, 0, buf.length, consumed);
      const nl = buf.lastIndexOf(10);
      if (nl < 0) continue;
      for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
        const meta = line.includes('"session_meta"'), tc = line.includes('"turn_context"'), tu = line.includes('"token_usage_record"');
        if (!meta && !tc && !tu) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d.payload || {};
        if (d.type === 'session_meta') { sid = p.id || sid; office = p.cwd ? officeForCwd(p.cwd, { create: false }) : office; }
        else if (d.type === 'turn_context') model = p.model || model;
        else if (d.type === 'token_usage_record' && p.usage && office) {
          const day = localDay(d.timestamp || Date.now());
          const key = `${model}|${day}`;
          const a = acc.get(key) || { model: model || 'codex', day, msgs: 0, input: 0, output: 0, cache_r: 0 };
          const u = p.usage;
          a.msgs++; a.input += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)); a.output += u.output_tokens || 0; a.cache_r += u.cached_input_tokens || 0;
          acc.set(key, a);
        }
      }
      consumed += nl + 1;
    } finally { fs.closeSync(fd); }
    const role = sid ? one(g, 'SELECT role FROM sessions WHERE sid = ?', sid)?.role || null : null;
    tx(g, () => {
      for (const a of acc.values()) {
        run(g, `INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cache_w, cache_r, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)
                ON CONFLICT(sid, model, day) DO UPDATE SET msgs = msgs + excluded.msgs, input = input + excluded.input, output = output + excluded.output, cache_r = cache_r + excluded.cache_r,
                office = COALESCE(usage.office, excluded.office), role = COALESCE(usage.role, excluded.role)`,
          sid, office, role, a.model, a.day, a.msgs, a.input, a.output, a.cache_r);
      }
      run(g, `INSERT INTO usage_files (path, offset, size, mtime, sid, office, last_msg) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime = excluded.mtime, sid = excluded.sid, office = excluded.office, last_msg = excluded.last_msg`,
        f, consumed, st.size, st.mtimeMs, sid, office, model);
    });
    if (acc.size) touched = true;
  }
  return touched;
}
