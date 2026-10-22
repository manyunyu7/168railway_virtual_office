// Subscription limits (Claude 5h/weekly, Codex) and usage statistics for the Usage screens.
//
// Claude: the only official source is the `rate_limits` object Claude Code hands to a statusline command
// (https://code.claude.com/docs/en/statusline). hooks/kantor-statusline.cjs forwards it here. No OAuth token is read.
// Codex: `token_count` events in the rollouts carry `rate_limits` (read-only, the rollout is Codex's own log).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR } from './config.js';
import { globalDb, officeDb, all, one, run } from './db.js';
import { priceFor, modelLabel } from './pricing.js';
import { bus } from './live.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KV_CLAUDE = 'usage.limits.claude';
const WARN = 80, CRIT = 90;

/* ---------------- limits ---------------- */

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = v => { const n = num(v); return n == null ? null : Math.max(0, Math.min(100, n)); };

function windowOf(key, label, w, minutes, now) {
  const used = pct(w?.used_percentage ?? w?.used_percent);
  if (used == null) return null;
  const at = num(w.resets_at);
  const resetsAt = at == null ? null : (at < 1e12 ? at * 1000 : at); // epoch seconds from both sources
  return { key, label, windowMinutes: minutes ?? null, usedPercent: used, remainingPercent: Math.round((100 - used) * 10) / 10, resetsAt, expired: resetsAt != null && resetsAt <= now };
}

/** Keep only well-formed windows of the Claude Code statusline `rate_limits` object. */
export function normalizeClaude(rl, now = Date.now()) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  const five = windowOf('five_hour', '5 jam', rl.five_hour, 300, now);
  const week = windowOf('seven_day', 'Mingguan', rl.seven_day, 10080, now);
  if (five) windows.push(five);
  if (week) windows.push(week);
  let spend = null;
  const sp = rl.spend_limit;
  if (sp && pct(sp.used_percentage) != null) {
    spend = { ...windowOf('spend_limit', 'Batas belanja', sp, null, now), period: ['daily', 'weekly', 'monthly'].includes(sp.period) ? sp.period : null, usedUsd: num(sp.used_usd), limitUsd: num(sp.limit_usd) };
  }
  return windows.length || spend ? { windows, spend } : null;
}

let claudeCache = null;
const loadClaude = () => {
  if (claudeCache) return claudeCache;
  try { claudeCache = JSON.parse(one(globalDb(), 'SELECT value FROM kv WHERE key = ?', KV_CLAUDE)?.value || 'null'); } catch { claudeCache = null; }
  return claudeCache;
};

/** Called with the statusline input. Returns true if the picture changed (and tells the clients). */
export function recordClaudeLimits(input, now = Date.now()) {
  const n = normalizeClaude(input?.rate_limits, now);
  if (!n) return false;
  const prev = loadClaude();
  const rec = { ...n, updatedAt: now, model: typeof input.model?.display_name === 'string' ? input.model.display_name.slice(0, 60) : null };
  const sig = x => JSON.stringify([...(x?.windows || []), x?.spend].map(w => w && [w.key, Math.round(w.usedPercent), w.resetsAt]));
  claudeCache = rec;
  run(globalDb(), 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KV_CLAUDE, JSON.stringify(rec));
  const changed = sig(prev) !== sig(rec);
  if (changed) bus.emit('msg', { t: 'usage-limits', limits: limits(now) });
  return changed;
}

const codexDir = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const label = m => (m == null ? 'Kuota' : m >= 10080 ? 'Mingguan' : m >= 1440 ? `${Math.round(m / 1440)} hari` : m >= 60 ? `${Math.round(m / 60)} jam` : `${m} menit`);

function recentRollouts(dir, limit) {
  const out = [];
  const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
  const years = ls(dir).sort().reverse();
  for (const y of years) for (const m of ls(path.join(dir, y)).sort().reverse()) for (const d of ls(path.join(dir, y, m)).sort().reverse()) {
    const base = path.join(dir, y, m, d);
    for (const f of ls(base)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) { try { out.push({ f: path.join(base, f), mtime: fs.statSync(path.join(base, f)).mtimeMs }); } catch {} }
    if (out.length >= limit) return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** The newest `rate_limits` per limit id, read from the tail of the latest rollouts. */
export function readCodexLimits({ dir = codexDir(), files = 6, tail = 512 * 1024, now = Date.now() } = {}) {
  const best = new Map();
  for (const { f } of recentRollouts(dir, files)) {
    let text = '';
    try {
      const st = fs.statSync(f), len = Math.min(tail, st.size), fd = fs.openSync(f, 'r');
      try { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const rl = d.payload?.rate_limits;
      if (!rl || typeof rl !== 'object') continue;
      const at = Date.parse(d.timestamp) || 0;
      const id = rl.limit_id || 'codex';
      if (!best.has(id) || best.get(id).at < at) best.set(id, { at, rl });
      break; // lines are in time order; the last match of this file is its newest
    }
  }
  const items = [...best.entries()].sort((a, b) => b[1].at - a[1].at).map(([id, { at, rl }]) => {
    const windows = [rl.primary, rl.secondary].map((w, i) => windowOf(i ? 'secondary' : 'primary', label(num(w?.window_minutes)), w, num(w?.window_minutes), now)).filter(Boolean);
    return { id, name: typeof rl.limit_name === 'string' ? rl.limit_name : null, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, reached: rl.rate_limit_reached_type || null, updatedAt: at, windows };
  }).filter(x => x.windows.length);
  return items;
}

let codexCache = { at: 0, items: [] };
function codexLimits(now) {
  if (now - codexCache.at > 20e3) { try { codexCache = { at: now, items: readCodexLimits({ now }) }; } catch { codexCache = { at: now, items: [] }; } }
  return codexCache.items;
}

/** Everything the "Pemakaian" cards show. `alert` is the highest live percentage across all windows. */
export function limits(now = Date.now()) {
  const c = loadClaude();
  const claude = c ? { available: true, source: 'statusline', updatedAt: c.updatedAt, model: c.model || null, windows: (c.windows || []).map(w => ({ ...w, expired: w.resetsAt != null && w.resetsAt <= now })), spend: c.spend || null } : { available: false, source: 'statusline', windows: [], spend: null };
  const cx = codexLimits(now);
  const codex = cx.length ? { available: true, source: 'rollout', updatedAt: cx[0].updatedAt, plan: cx[0].plan, reached: cx[0].reached, windows: cx[0].windows.map(w => ({ ...w, expired: w.resetsAt != null && w.resetsAt <= now })), extra: cx.slice(1) } : { available: false, source: 'rollout', windows: [], extra: [] };
  const live = [...claude.windows, ...codex.windows].filter(w => !w.expired).map(w => w.usedPercent);
  const alert = live.length ? Math.max(...live) : 0;
  return { claude, codex, alert, level: alert >= CRIT ? 'critical' : alert >= WARN ? 'warn' : 'ok', warnAt: WARN, criticalAt: CRIT, at: now };
}

/** Poll the Codex rollouts for a change; the Claude side is pushed by the statusline. */
let lastCodexSig = null;
export function pollCodexLimits() {
  codexCache = { at: 0, items: [] };
  const c = codexLimits(Date.now());
  const sig = JSON.stringify(c.map(x => x.windows.map(w => [w.key, Math.round(w.usedPercent), w.resetsAt])));
  if (lastCodexSig != null && sig !== lastCodexSig) bus.emit('msg', { t: 'usage-limits', limits: limits() });
  lastCodexSig = sig;
}

/** Per-session settings that make a Kantor shift report its limits. Left out when the user has a statusline of their own. */
export function statusLineSettings() {
  try { if (JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8')).statusLine) return {}; } catch {}
  return { statusLine: { type: 'command', command: `node '${path.join(ROOT, 'hooks', 'kantor-statusline.cjs').replace(/'/g, `'\\''`)}'`, padding: 0 } };
}

/* ---------------- statistics ---------------- */

const localDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const RANGES = { today: 1, '7d': 7, '30d': 30 };
export const engineOfModel = m => (priceFor(m) || /claude|opus|sonnet|haiku|fable/i.test(m || '') ? 'claude' : 'codex');

const blank = () => ({ input: 0, output: 0, cacheW: 0, cacheR: 0, tokens: 0, cost: 0, msgs: 0 });
function add(t, r) {
  t.input += r.input || 0; t.output += r.output || 0; t.cacheW += r.cache_w || 0; t.cacheR += r.cache_r || 0;
  t.tokens += (r.input || 0) + (r.output || 0) + (r.cache_w || 0) + (r.cache_r || 0); t.cost += r.cost || 0; t.msgs += r.msgs || 0;
}
const round = t => ({ ...t, cost: Math.round(t.cost * 1e4) / 1e4 });

/** Usage statistics for `range` (today | 7d | 30d), for one office or all. Pure SQL over the `usage` table the scanners fill. */
export function summary({ range = '7d', office = null, now = Date.now() } = {}) {
  const days = RANGES[range] || RANGES['7d'];
  const from = localDay(now - (days - 1) * 86400e3), to = localDay(now);
  const g = globalDb();
  const filter = office && office !== '_kompleks';
  const rows = all(g, `SELECT u.sid, u.office, u.role, u.model, u.day, u.msgs, u.input, u.output, u.cache_w, u.cache_r, u.cost,
      s.title, s.first_prompt, s.started_at, s.ended_at, s.last_seen, o.name office_name
    FROM usage u LEFT JOIN sessions s ON s.sid = u.sid LEFT JOIN offices o ON o.id = u.office
    WHERE u.day >= ? AND u.day <= ? ${filter ? 'AND u.office = ?' : ''}`, ...(filter ? [from, to, office] : [from, to]));

  const totals = blank(), engines = { claude: blank(), codex: blank() };
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) daily.set(localDay(now - i * 86400e3), { day: localDay(now - i * 86400e3), ...blank(), claudeTokens: 0, codexTokens: 0 });
  const groups = { office: new Map(), role: new Map(), model: new Map() };
  const sess = new Map(), sessSet = new Set();
  const roleNames = new Map();
  const roleName = (off, role) => {
    if (!role) return 'Tanpa peran';
    if (!roleNames.has(off)) { const m = new Map(); try { for (const r of all(officeDb(off), 'SELECT id, name FROM roles')) m.set(r.id, r.name); } catch {} roleNames.set(off, m); }
    return roleNames.get(off).get(role) || role;
  };
  const bump = (map, key, meta, r) => { let e = map.get(key); if (!e) { e = { ...meta, ...blank(), sessions: new Set() }; map.set(key, e); } add(e, r); e.sessions.add(r.sid); };

  for (const r of rows) {
    const eng = engineOfModel(r.model);
    add(totals, r); add(engines[eng], r);
    const dd = daily.get(r.day);
    if (dd) { add(dd, r); dd[eng + 'Tokens'] += (r.input || 0) + (r.output || 0) + (r.cache_w || 0) + (r.cache_r || 0); }
    sessSet.add(r.sid);
    bump(groups.office, r.office || '', { id: r.office || null, name: r.office_name || r.office || 'Tanpa kantor' }, r);
    bump(groups.role, `${r.office}/${r.role || ''}`, { id: r.role || null, office: r.office || null, officeName: r.office_name || null, name: roleName(r.office, r.role) }, r);
    bump(groups.model, r.model || '', { model: r.model || null, label: modelLabel(r.model), engine: eng }, r);
    let s = sess.get(r.sid);
    if (!s) { s = { sid: r.sid, title: r.title || (r.first_prompt || '').slice(0, 80) || null, office: r.office || null, officeName: r.office_name || null, role: r.role || null, roleName: roleName(r.office, r.role), engine: eng, ...blank(), days: new Set(), started: r.started_at, ended: r.ended_at || r.last_seen }; sess.set(r.sid, s); }
    add(s, r); s.days.add(r.day);
  }

  const fin = (map, key = 'tokens') => [...map.values()].map(({ sessions, ...e }) => round({ ...e, sessions: sessions.size })).sort((a, b) => b[key] - a[key]);
  const list = [...sess.values()].map(({ days: d, started, ended, ...s }) => ({ ...round(s), days: d.size }));
  const top = [...list].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens)).slice(0, 10);

  // session wall time, clipped to the range; an unfinished session counts until it was last seen
  const lo = Date.parse(from + 'T00:00:00') || 0;
  let seconds = 0, timed = 0;
  for (const s of sess.values()) {
    const a = Date.parse(s.started), b = Date.parse(s.ended);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) { seconds += (b - Math.max(a, lo)) / 1000; timed++; }
  }
  seconds = Math.max(0, Math.round(seconds));
  const n = sessSet.size;
  const host = os.hostname().split('.')[0] || 'lokal';
  return {
    range: RANGES[range] ? range : '7d', from, to, office: filter ? office : null,
    totals: { ...round(totals), sessions: n }, engines: { claude: round(engines.claude), codex: round(engines.codex) },
    avgPerSession: { tokens: n ? Math.round(totals.tokens / n) : 0, output: n ? Math.round(totals.output / n) : 0, cost: n ? Math.round(totals.cost / n * 1e4) / 1e4 : 0 },
    daily: [...daily.values()].map(round),
    byOffice: filter ? [] : fin(groups.office), byRole: fin(groups.role), byModel: fin(groups.model),
    byMachine: [{ id: 'local', name: host, ...round(totals), sessions: n }],
    topSessions: top,
    work: { sessions: n, seconds, avgSeconds: timed ? Math.round(seconds / timed) : 0 },
    // not recorded anywhere yet: tool calls and edited lines
    toolStats: null,
    costNote: 'Biaya ekuivalen tarif API untuk Claude; Codex (langganan ChatGPT) hanya token.',
  };
}
