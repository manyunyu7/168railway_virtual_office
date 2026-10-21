import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, config } from './config.js';
import { globalDb, officeDb, all, one, run, tx } from './db.js';
import { costOf, modelLabel } from './pricing.js';
import { officeForCwd } from './offices.js';
import { bus } from './live.js';

const CHUNK = 8 * 1024 * 1024;
let scanning = false;
export const scanState = { running: false, files: 0, done: 0, lastRun: null, error: null };

function listFiles(days) {
  const cutoff = Date.now() - days * 86400e3;
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const p of projects) {
    const dir = path.join(PROJECTS_DIR, p);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      if (n.endsWith('.jsonl')) { try { const st = fs.statSync(f); if (st.mtimeMs >= cutoff) out.push({ f, st }); } catch {} }
      else if (!n.includes('.')) {
        const sub = path.join(f, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sub); } catch { continue; }
        for (const s of subs) if (s.endsWith('.jsonl')) { const sf = path.join(sub, s); try { const st = fs.statSync(sf); if (st.mtimeMs >= cutoff) out.push({ f: sf, st, parent: n }); } catch {} }
      }
    }
  }
  return out;
}

const localDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function scanUsage() {
  if (scanning) return;
  scanning = true;
  scanState.running = true; scanState.error = null;
  try {
    const g = globalDb();
    const files = listFiles(config().payroll.scanDays);
    scanState.files = files.length; scanState.done = 0;
    const known = new Map(all(g, 'SELECT * FROM usage_files').map(r => [r.path, r]));
    const roleOf = new Map(all(g, 'SELECT sid, role, office FROM sessions WHERE role IS NOT NULL').map(r => [r.sid, r]));
    const officeCache = new Map();
    let touched = false;
    for (const { f, st, parent } of files) {
      scanState.done++;
      const prev = known.get(f);
      let offset = prev?.offset || 0;
      if (prev && st.size < offset) offset = 0;
      if (prev && st.size === prev.size && offset >= st.size) continue;
      const acc = new Map();
      let lastMsg = prev?.last_msg || null;
      let fileSid = prev?.sid || parent || null, fileOffice = prev?.office || null;
      const fd = fs.openSync(f, 'r');
      try {
        let pos = offset, rest = '';
        while (pos < st.size) {
          const len = Math.min(CHUNK, st.size - pos);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, pos);
          pos += len;
          const text = rest + buf.toString('utf8');
          const lastNl = text.lastIndexOf('\n');
          if (lastNl < 0) { rest = text; continue; }
          rest = text.slice(lastNl + 1);
          for (const line of text.slice(0, lastNl).split('\n')) {
            if (!line.includes('"usage"') || !line.includes('"assistant"')) {
              if (!fileOffice && line.includes('"cwd"')) { try { const d = JSON.parse(line); if (d.cwd) fileOffice = officeOf(d.cwd, officeCache); if (d.sessionId && !fileSid) fileSid = d.sessionId; } catch {} }
              continue;
            }
            let d; try { d = JSON.parse(line); } catch { continue; }
            const m = d.message;
            if (d.type !== 'assistant' || !m?.usage || !m.id || m.model === '<synthetic>') continue;
            if (m.id === lastMsg) continue;
            lastMsg = m.id;
            const sid = parent || d.sessionId || fileSid;
            fileSid ||= sid;
            if (!fileOffice && d.cwd) fileOffice = officeOf(d.cwd, officeCache);
            const day = localDay(d.timestamp || Date.now());
            const key = `${sid}|${m.model}|${day}`;
            const a = acc.get(key) || { sid, model: m.model, day, msgs: 0, input: 0, output: 0, cache_w: 0, cache_r: 0, cost: 0 };
            const u = m.usage;
            a.msgs++; a.input += u.input_tokens || 0; a.output += u.output_tokens || 0; a.cache_w += u.cache_creation_input_tokens || 0; a.cache_r += u.cache_read_input_tokens || 0;
            a.cost += costOf(m.model, u);
            acc.set(key, a);
          }
        }
        const consumed = st.size - Buffer.byteLength(rest, 'utf8');
        tx(g, () => {
          for (const a of acc.values()) {
            const r = roleOf.get(a.sid);
            run(g, `INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cache_w, cache_r, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(sid, model, day) DO UPDATE SET msgs = msgs + excluded.msgs, input = input + excluded.input, output = output + excluded.output,
                    cache_w = cache_w + excluded.cache_w, cache_r = cache_r + excluded.cache_r, cost = cost + excluded.cost,
                    office = COALESCE(usage.office, excluded.office), role = COALESCE(usage.role, excluded.role)`,
              a.sid, r?.office || fileOffice, r?.role || null, a.model, a.day, a.msgs, a.input, a.output, a.cache_w, a.cache_r, a.cost);
          }
          run(g, `INSERT INTO usage_files (path, offset, size, mtime, sid, office, last_msg) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime = excluded.mtime, sid = excluded.sid, office = excluded.office, last_msg = excluded.last_msg`,
            f, consumed, st.size, st.mtimeMs, fileSid, fileOffice, lastMsg);
        });
        if (acc.size) touched = true;
      } finally { fs.closeSync(fd); }
      await new Promise(r => setImmediate(r));
    }
    // attribute sessions that got a role after their usage was first counted
    run(g, `UPDATE usage SET role = (SELECT role FROM sessions s WHERE s.sid = usage.sid), office = COALESCE(office, (SELECT office FROM sessions s WHERE s.sid = usage.sid))
            WHERE role IS NULL AND sid IN (SELECT sid FROM sessions WHERE role IS NOT NULL)`);
    scanState.lastRun = new Date().toISOString();
    if (touched) bus.emit('msg', { t: 'changed', office: '*', what: 'payroll' });
  } catch (e) {
    scanState.error = e.message;
  } finally {
    scanning = false; scanState.running = false;
  }
}

function officeOf(cwd, cache) {
  if (cache.has(cwd)) return cache.get(cwd);
  let id = null;
  try { id = officeForCwd(cwd, { create: true }); } catch {}
  cache.set(cwd, id);
  return id;
}

const monthOf = d => d.slice(0, 7);
export function currentMonth() { return localDay(Date.now()).slice(0, 7); }

/** Payroll view for one office (or all offices when office is null). */
export function payroll(office, month = currentMonth()) {
  const g = globalDb();
  const where = office ? 'office = ? AND substr(day, 1, 7) = ?' : 'substr(day, 1, 7) = ?';
  const args = office ? [office, month] : [month];
  const total = one(g, `SELECT COALESCE(SUM(cost),0) cost, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_w),0) cache_w, COALESCE(SUM(cache_r),0) cache_r, COALESCE(SUM(msgs),0) msgs, COUNT(DISTINCT sid) sessions FROM usage WHERE ${where}`, ...args);
  const byRole = all(g, `SELECT role, COALESCE(SUM(cost),0) cost, SUM(output) output, SUM(input + cache_w + cache_r) input, COUNT(DISTINCT sid) sessions FROM usage WHERE ${where} GROUP BY role ORDER BY cost DESC`, ...args);
  const byModel = all(g, `SELECT model, SUM(cost) cost, SUM(output) output FROM usage WHERE ${where} GROUP BY model ORDER BY cost DESC`, ...args).map(r => ({ ...r, label: modelLabel(r.model) }));
  const byDay = all(g, `SELECT day, SUM(cost) cost FROM usage WHERE ${office ? 'office = ? AND ' : ''} day >= ? GROUP BY day ORDER BY day`, ...(office ? [office] : []), localDay(Date.now() - 29 * 86400e3));
  const bySession = all(g, `SELECT u.sid, u.role, SUM(u.cost) cost, SUM(u.output) output, MIN(u.day) first, MAX(u.day) last, s.title, s.first_prompt, s.room, s.source
      FROM usage u LEFT JOIN sessions s ON s.sid = u.sid WHERE ${where.replace(/office/g, 'u.office').replace(/day/g, 'u.day')} GROUP BY u.sid ORDER BY cost DESC LIMIT 25`, ...args);
  const byOffice = office ? [] : all(g, `SELECT office, SUM(cost) cost, COUNT(DISTINCT sid) sessions FROM usage WHERE ${where} GROUP BY office ORDER BY cost DESC`, ...args);
  const months = all(g, `SELECT DISTINCT substr(day, 1, 7) m FROM usage ${office ? 'WHERE office = ?' : ''} ORDER BY m DESC LIMIT 12`, ...(office ? [office] : [])).map(r => r.m);
  let budget = null;
  if (office) { try { budget = Number(one(officeDb(office), "SELECT value FROM meta WHERE key = 'budget_month'")?.value) || null; } catch {} }
  return { month, months: months.includes(month) ? months : [month, ...months], total, byRole, byModel, byDay, bySession, byOffice, budget, scan: scanState };
}

export function setBudget(office, usd) {
  run(officeDb(office), "INSERT INTO meta (key, value) VALUES ('budget_month', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(usd || ''));
  bus.emit('msg', { t: 'changed', office, what: 'payroll' });
}

export function monthCost(office, month = currentMonth()) {
  return one(globalDb(), 'SELECT COALESCE(SUM(cost),0) c FROM usage WHERE office = ? AND substr(day,1,7) = ?', office, month).c;
}
export { monthOf };
