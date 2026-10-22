// Metrik siklus kerja: kartu, DM, sesi, biaya, git, gesekan. Hanya membaca; semua angka dihitung dari data yang sudah dicatat harness.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { globalDb, officeDb, all, one } from './db.js';
import { officeModel } from './offices.js';
import { boardMap, nameAt, DEFAULT_BOARD } from './boards.js';

const HOUR = 3600e3, DAY = 86400e3;
const WORK_GAP = 180e3;      // a gap between two log lines up to this long counts as working time
const WAIT_CAP = 3600e3;     // one permission wait is never counted longer than this
const DELIV_SLOW = [60e3, 300e3];

/* ---------------- range ---------------- */
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseWhen = (v, endOfDay) => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d + (endOfDay ? 1 : 0)).getTime(); }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** range: today | night | 24h | 7d | 30d | custom (from, to). Returns {key, label, from, to, bucket}. */
export function resolveRange(q = {}, now = Date.now()) {
  const key = String(q.range || 'today');
  let from, to = now, label;
  if (key === 'night') { // semalam: 18.00 kemarin sampai 08.00 pagi ini
    const d0 = startOfDay(now);
    from = d0 - 6 * HOUR; to = Math.min(now, d0 + 8 * HOUR);
    label = 'Semalam (18.00 – 08.00)';
  } else if (key === '24h') { from = now - DAY; label = '24 jam terakhir'; }
  else if (key === '7d') { from = startOfDay(now) - 6 * DAY; label = '7 hari'; }
  else if (key === '30d') { from = startOfDay(now) - 29 * DAY; label = '30 hari'; }
  else if (key === 'custom' || q.from) {
    from = parseWhen(q.from, false); const t = parseWhen(q.to, true);
    if (from == null) throw Object.assign(new Error('Rentang kustom perlu from yang valid'), { code: 400 });
    if (t != null) to = Math.min(t, now);
    label = 'Kustom';
  } else { from = startOfDay(now); label = 'Hari ini'; }
  if (!(to > from)) throw Object.assign(new Error('Rentang tidak valid'), { code: 400 });
  if (to - from > 93 * DAY) throw Object.assign(new Error('Rentang maksimal 93 hari'), { code: 400 });
  return { key: q.from && key !== 'custom' ? 'custom' : key, label, from, to, bucket: to - from <= 3 * DAY ? 'hour' : 'day' };
}
const iso = ms => new Date(ms).toISOString();

/* ---------------- small stats ---------------- */
const sum = a => a.reduce((x, y) => x + y, 0);
export function stats(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return { n: 0, avg: null, median: null, p90: null, max: null, min: null };
  const pick = p => v[Math.max(0, Math.ceil(p * v.length) - 1)];
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, avg: sum(v) / v.length, median: mid, p90: pick(0.9), max: v[v.length - 1], min: v[0] };
}
const ms = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const rnd = (x, d = 2) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
const hoursOf = x => x == null ? null : rnd(x / HOUR);
const sec = x => x == null ? null : Math.round(x / 1000);

/* ---------------- indexes (additive, idempotent, made once per db) ---------------- */
const indexed = new WeakSet();
function ensureIndexes(db) {
  if (indexed.has(db)) return;
  indexed.add(db);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS card_hist_card ON card_hist(card_id, at);
             CREATE INDEX IF NOT EXISTS card_hist_at ON card_hist(at);
             CREATE INDEX IF NOT EXISTS dm_at ON dm(at);
             CREATE INDEX IF NOT EXISTS log_kind_at ON log(kind, at);`);
  } catch { /* read-only copy or locked: the queries still work, only slower */ }
}

/* ---------------- buckets ---------------- */
function makeBuckets(r) {
  const out = [];
  const step = r.bucket === 'hour' ? HOUR : DAY;
  const d = new Date(r.from);
  if (r.bucket === 'hour') d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
  for (let t = d.getTime(); t < r.to; t = r.bucket === 'hour' ? t + step : new Date(t).setDate(new Date(t).getDate() + 1)) out.push(t);
  const idx = t => {
    if (r.bucket === 'hour') { const x = new Date(t); x.setMinutes(0, 0, 0); return out.indexOf(x.getTime()); }
    const x = new Date(t); x.setHours(0, 0, 0, 0); return out.indexOf(x.getTime());
  };
  return { starts: out, idx };
}

/* ---------------- cards ---------------- */
function cardMetrics(db, r, B, stuckHours, now, nameOf) {
  const inR = at => { const t = ms(at); return t != null && t >= r.from && t <= r.to; };
  const created = all(db, 'SELECT id, created_at FROM cards WHERE created_at >= ? AND created_at <= ?', iso(r.from), iso(r.to));
  // perpindahan terstruktur (card_moves, berisi jenis kolom). Selesai/mulai/review dibaca dari jenis kolom, bukan namanya.
  const rows = all(db, 'SELECT card_id, from_kind, to_kind, at FROM card_moves WHERE at <= ? ORDER BY at, id', iso(r.to));
  const moves = new Map(); // card -> [{to, from, t}] (to/from = kind)
  for (const h of rows) {
    const t = ms(h.at);
    if (t == null || !h.to_kind) continue;
    (moves.get(h.card_id) || moves.set(h.card_id, []).get(h.card_id)).push({ from: h.from_kind || null, to: h.to_kind, t });
  }
  // kartu tanpa card_moves (data lama yang ditulis langsung): baca riwayat teks, nama kolom lama dipetakan ke jenis
  const LEG = { backlog: 'antre', siap: 'siap', dikerjakan: 'dikerjakan', review: 'review', selesai: 'selesai' };
  const legacy = all(db, "SELECT card_id, text, at FROM card_hist WHERE (text LIKE 'memindahkan %' OR text LIKE 'membuat kartu di %') AND at <= ? ORDER BY at, id", iso(r.to));
  const fromMoves = new Set(moves.keys());
  for (const h of legacy) {
    if (fromMoves.has(h.card_id)) continue;
    let m = /^memindahkan (.+?) → (.+)$/.exec(h.text), from = null, to;
    if (m) { from = m[1]; to = m[2]; } else { m = /^membuat kartu di (.+)$/.exec(h.text); if (!m) continue; to = m[1]; }
    const t = ms(h.at), tk = LEG[String(to).toLowerCase()];
    if (t == null || !tk) continue;
    (moves.get(h.card_id) || moves.set(h.card_id, []).get(h.card_id)).push({ from: from ? LEG[from.toLowerCase()] || null : null, to: tk, t });
  }
  const doneIds = new Set(), startedIds = new Set(), bounceIds = new Set();
  const doneAt = [], cycles = [], cycleRows = [];
  let bounces = 0, reviewEntries = 0;
  const doneBuckets = new Array(B.starts.length).fill(0);
  const doneTimes = [];
  for (const [id, ms_] of moves) {
    for (const m of ms_) {
      if (m.t < r.from || m.t > r.to) continue;
      if (m.to === 'selesai' && m.from !== 'selesai') { doneIds.add(id); doneTimes.push(m.t); const i = B.idx(m.t); if (i >= 0) doneBuckets[i]++; }
      if (m.to === 'dikerjakan') startedIds.add(id);
      if (m.to === 'review' && m.from !== 'review') reviewEntries++;
      if (m.from === 'review' && m.to === 'dikerjakan') { bounces++; bounceIds.add(id); }
    }
  }
  for (const id of doneIds) {
    const list = moves.get(id);
    const lastDone = [...list].reverse().find(m => m.to === 'selesai' && m.t >= r.from && m.t <= r.to);
    const start = list.find(m => m.to === 'dikerjakan' && m.t <= lastDone.t);
    if (!start) continue;
    const c = lastDone.t - start.t;
    cycles.push(c); cycleRows.push({ id, ms: c });
  }
  // stuck: a card in Dikerjakan/Review whose last movement or note is older than stuckHours
  const boards = boardMap(db);
  const colLabel = c => { const b = boards.get(c.board || DEFAULT_BOARD); const n = b ? nameAt(b, c.col) : String(c.col); return b && b.id !== DEFAULT_BOARD ? `${b.name} · ${n}` : n; };
  const open = all(db, `SELECT c.id, c.title, c.col, c.board, c.who, c.moved_at, c.updated_at, c.created_at, c.blocked,
      (SELECT MAX(at) FROM card_hist h WHERE h.card_id = c.id) hist_at,
      (SELECT MAX(at) FROM card_comments k WHERE k.card_id = c.id) comment_at
    FROM cards c WHERE c.archived = 0 AND c.kind IN ('dikerjakan', 'review')`);
  const stuck = open.map(c => {
    const last = Math.max(...[c.moved_at, c.hist_at, c.comment_at, c.created_at].map(x => ms(x) || 0));
    return { id: c.id, title: c.title, col: colLabel(c), who: nameOf(c.who) || c.who || null, blocked: c.blocked || '', hours: rnd((now - last) / HOUR, 1), last: iso(last) };
  }).filter(c => c.hours >= stuckHours).sort((a, b) => b.hours - a.hours);
  const board = {};
  for (const row of all(db, 'SELECT board, col, COUNT(*) n FROM cards WHERE archived = 0 GROUP BY board, col ORDER BY board, col')) board[colLabel(row)] = (board[colLabel(row)] || 0) + row.n;
  const createdBuckets = new Array(B.starts.length).fill(0);
  for (const c of created) { const i = B.idx(ms(c.created_at)); if (i >= 0) createdBuckets[i]++; }
  const cyc = stats(cycles);
  return {
    created: created.length,
    done: doneIds.size,
    started: startedIds.size,
    cycle: { n: cyc.n, avgH: hoursOf(cyc.avg), medianH: hoursOf(cyc.median), p90H: hoursOf(cyc.p90), minH: hoursOf(cyc.min), maxH: hoursOf(cyc.max) },
    review: { entries: reviewEntries, bounces, bouncedCards: bounceIds.size },
    stuck: { hours: stuckHours, count: stuck.length, cards: stuck.slice(0, 20) },
    board,
    createdPerBucket: createdBuckets,
    donePerBucket: doneBuckets,
    doneIds: [...doneIds],
  };
}

/* ---------------- DM ---------------- */
function dmMetrics(db, r, nameOf, now) {
  const rows = all(db, 'SELECT id, from_role, to_role, kind, status, at, sent_at, read_at, replied_at FROM dm WHERE at >= ? AND at <= ?', iso(r.from), iso(r.to));
  const deliv = [], reply = [];
  const per = new Map();
  let askTimeout = 0;
  const counts = { pesan: 0, tanya: 0, balasan: 0 };
  for (const d of rows) {
    counts[d.kind] = (counts[d.kind] || 0) + 1;
    const at = ms(d.at), sent = ms(d.sent_at), rep = ms(d.replied_at);
    const lat = sent != null && at != null ? Math.max(0, sent - at) : null;
    const rl = rep != null && at != null ? Math.max(0, rep - at) : null;
    const p = per.get(d.to_role) || per.set(d.to_role, { role: d.to_role, name: nameOf(d.to_role) || d.to_role, n: 0, deliv: [], reply: [], slow1: 0, slow5: 0, waiting: 0 }).get(d.to_role);
    p.n++;
    if (lat != null) { deliv.push(lat); p.deliv.push(lat); if (lat > DELIV_SLOW[0]) p.slow1++; if (lat > DELIV_SLOW[1]) p.slow5++; }
    else if (d.status === 'menunggu') p.waiting++;
    if (rl != null && d.kind !== 'balasan') { reply.push(rl); p.reply.push(rl); }
    if (d.kind === 'tanya' && (rep == null || rep - at > 300e3)) askTimeout++;
  }
  const fmt = a => { const s = stats(a); return { n: s.n, avgSec: sec(s.avg), p90Sec: sec(s.p90), maxSec: sec(s.max), medianSec: sec(s.median) }; };
  const perRole = [...per.values()].map(p => ({ role: p.role, name: p.name, n: p.n, deliver: fmt(p.deliv), reply: fmt(p.reply), slow1: p.slow1, slow5: p.slow5, waiting: p.waiting }))
    .sort((a, b) => (b.deliver.avgSec ?? -1) - (a.deliver.avgSec ?? -1));
  const wait = all(db, "SELECT to_role, at FROM dm WHERE status = 'menunggu' ORDER BY at");
  const delivered = rows.filter(d => d.sent_at).length;
  return {
    total: rows.length, ...counts,
    delivered,
    deliver: fmt(deliv), reply: fmt(reply),
    slow1: deliv.filter(x => x > DELIV_SLOW[0]).length, slow5: deliv.filter(x => x > DELIV_SLOW[1]).length,
    askTimeout,
    perRole,
    waitingNow: { count: wait.length, oldestSec: wait.length ? sec(now - ms(wait[0].at)) : 0, perRole: Object.entries(wait.reduce((m, w) => (m[w.to_role] = (m[w.to_role] || 0) + 1, m), {})).map(([role, n]) => ({ role, name: nameOf(role) || role, n })) },
  };
}

/* ---------------- sessions ---------------- */
const ACTIVITY = ['tool', 'prompt', 'sub', 'dm', 'board', 'wiki', 'act'];
function unionSpan(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [s, e] of iv) { if (e <= s) continue; if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e); }
  if (cur) total += cur[1] - cur[0];
  return total;
}
function sessionMetrics(db, g, office, r, roles, now) {
  const byName = new Map(roles.map(x => [x.name, x.id]));
  const ev = all(db, `SELECT who, at, kind, text FROM log WHERE at >= ? AND at <= ? ORDER BY at, id`, iso(r.from), iso(r.to));
  const act = new Map();
  const marks = { compactions: 0, interrupts: 0, resets: 0, forced: 0 };
  const markBy = new Map();
  for (const e of ev) {
    const rid = byName.get(e.who);
    if (!rid) continue;
    const t = ms(e.at);
    if (e.kind === 'session') {
      const key = /kompaksi/.test(e.text) ? 'compactions' : /diinterupsi/.test(e.text) ? 'interrupts' : /mereset/.test(e.text) ? 'resets' : /dipulangkan paksa/.test(e.text) ? 'forced' : null;
      if (key) { marks[key]++; const m = markBy.get(rid) || markBy.set(rid, { compactions: 0, interrupts: 0, resets: 0, forced: 0 }).get(rid); m[key]++; }
    }
    if (!ACTIVITY.includes(e.kind)) continue;
    (act.get(rid) || act.set(rid, []).get(rid)).push(t);
  }
  const sess = all(g, 'SELECT sid, role, started_at, ended_at, last_seen, status FROM sessions WHERE office = ? AND role IS NOT NULL', office);
  const spans = new Map();
  for (const s of sess) {
    const st = ms(s.started_at); if (st == null) continue;
    const en = ms(s.ended_at) ?? (s.status === 'ended' ? ms(s.last_seen) : now) ?? now;
    const a = Math.max(st, r.from), b = Math.min(en, r.to);
    if (b > a) (spans.get(s.role) || spans.set(s.role, []).get(s.role)).push([a, b]);
  }
  const inbox = all(g, 'SELECT role, tool, created_at, decided_at, status FROM inbox WHERE office = ? AND created_at >= ? AND created_at <= ?', office, iso(r.from), iso(r.to));
  const waitBy = new Map();
  const permWaits = [];
  for (const p of inbox) {
    const a = ms(p.created_at), b = ms(p.decided_at) ?? (p.status === 'pending' ? Math.min(now, r.to) : a);
    const w = Math.min(WAIT_CAP, Math.max(0, b - a));
    permWaits.push(w);
    waitBy.set(p.role, (waitBy.get(p.role) || 0) + w);
  }
  const ids = new Set([...act.keys(), ...spans.keys(), ...waitBy.keys()]);
  const perRole = [];
  for (const rid of ids) {
    const ts = act.get(rid) || [];
    let work = 0;
    for (let i = 0; i < ts.length; i++) work += Math.min(ts[i + 1] != null ? ts[i + 1] - ts[i] : WORK_GAP, WORK_GAP);
    const wait = waitBy.get(rid) || 0;
    work = Math.max(0, work - wait);
    const span = Math.max(unionSpan(spans.get(rid) || []), work + wait);
    const role = roles.find(x => x.id === rid);
    perRole.push({ role: rid, name: role?.name || rid, workSec: sec(work), waitSec: sec(wait), idleSec: sec(Math.max(0, span - work - wait)), spanSec: sec(span), events: ts.length, ...(markBy.get(rid) || { compactions: 0, interrupts: 0, resets: 0, forced: 0 }) });
  }
  perRole.sort((a, b) => b.workSec - a.workSec);
  const byStatus = {}, byTool = {};
  for (const p of inbox) { byStatus[p.status] = (byStatus[p.status] || 0) + 1; byTool[p.tool] = (byTool[p.tool] || 0) + 1; }
  const w = stats(permWaits.filter(x => x > 0));
  return {
    perRole,
    totals: { workSec: sum(perRole.map(x => x.workSec)), idleSec: sum(perRole.map(x => x.idleSec)), waitSec: sum(perRole.map(x => x.waitSec)) },
    ...marks,
    permissions: {
      total: inbox.length, byStatus, byTool: Object.entries(byTool).map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n).slice(0, 8),
      toTerminal: byStatus.terminal || 0, waitAvgSec: sec(w.avg), waitMaxSec: sec(w.max),
    },
  };
}

/* ---------------- cost ---------------- */
function costMetrics(g, office, r, roles, done, commits) {
  const d1 = localDay(r.from), d2 = localDay(r.to);
  const rows = all(g, `SELECT role, model, SUM(msgs) msgs, SUM(input) input, SUM(output) output, SUM(cache_w) cache_w, SUM(cache_r) cache_r, SUM(cost) cost, COUNT(DISTINCT sid) sessions
    FROM usage WHERE office = ? AND day >= ? AND day <= ? GROUP BY role, model`, office, d1, d2);
  const tot = { cost: 0, msgs: 0, input: 0, output: 0, cache_w: 0, cache_r: 0, tokenOnlyTokens: 0 };
  const per = new Map();
  for (const x of rows) {
    const tokenOnly = !(x.cost > 0) && (x.input + x.output + x.cache_r + x.cache_w) > 0;
    for (const k of ['cost', 'msgs', 'input', 'output', 'cache_w', 'cache_r']) tot[k] += x[k] || 0;
    if (tokenOnly) tot.tokenOnlyTokens += x.input + x.output + x.cache_r + x.cache_w;
    const key = x.role || '';
    const p = per.get(key) || per.set(key, { role: x.role, name: roles.find(z => z.id === x.role)?.name || (x.role ? x.role : 'Sesi manual'), cost: 0, output: 0, msgs: 0, tokenOnlyTokens: 0 }).get(key);
    p.cost += x.cost || 0; p.output += x.output || 0; p.msgs += x.msgs || 0;
    if (tokenOnly) p.tokenOnlyTokens += x.input + x.output + x.cache_r + x.cache_w;
  }
  const perRole = [...per.values()].map(p => ({ ...p, cost: rnd(p.cost) })).sort((a, b) => b.cost - a.cost);
  return {
    // usage is stored per local day, so the range is rounded out to whole days
    days: [d1, d2], granularity: 'hari',
    total: rnd(tot.cost), msgs: tot.msgs, input: tot.input, output: tot.output, cacheRead: tot.cache_r, cacheWrite: tot.cache_w, tokenOnlyTokens: tot.tokenOnlyTokens,
    perDoneCard: done ? rnd(tot.cost / done) : null,
    perCommit: commits ? rnd(tot.cost / commits) : null,
    perRole,
  };
}

/* ---------------- git ---------------- */
function git(args, cwd) {
  return new Promise(resolve => execFile('git', args, { cwd, timeout: 8000, maxBuffer: 8e6, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
    (err, out) => resolve(err ? null : out)));
}
async function gitMetrics(office, r, B) {
  let model = null;
  try { model = officeModel(office); } catch {}
  const repos = new Map();
  for (const room of model?.plan?.rooms || []) {
    if (typeof room.path !== 'string') continue;
    const abs = path.resolve(model.root, room.path);
    if (abs !== model.root && !abs.startsWith(model.root + path.sep)) continue;
    if (!fs.existsSync(abs)) continue;
    const top = (await git(['rev-parse', '--show-toplevel'], abs))?.trim();
    if (top && !repos.has(top)) repos.set(top, room.name || path.basename(top));
  }
  const out = { total: 0, reverts: 0, kinds: {}, perRepo: [], perBucket: new Array(B.starts.length).fill(0) };
  for (const [top, name] of repos) {
    const txt = await git(['log', `--since=${iso(r.from)}`, `--until=${iso(r.to)}`, '--format=%cI\t%s'], top);
    if (txt == null) continue;
    const per = new Array(B.starts.length).fill(0);
    let n = 0, reverts = 0;
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const [when, subj = ''] = line.split('\t');
      const t = Date.parse(when);
      n++;
      if (/^revert\b/i.test(subj)) reverts++;
      const k = /^(\w+)(\(.+?\))?!?:/.exec(subj)?.[1]?.toLowerCase();
      if (k) out.kinds[k] = (out.kinds[k] || 0) + 1;
      const i = B.idx(t); if (i >= 0) { per[i]++; out.perBucket[i]++; }
    }
    out.total += n; out.reverts += reverts;
    out.perRepo.push({ repo: name, commits: n, reverts, perBucket: per });
  }
  out.perRepo.sort((a, b) => b.commits - a.commits);
  return out;
}

/* ---------------- friction ---------------- */
function frictionMetrics(db, g, r) {
  const rows = all(db, "SELECT text FROM log WHERE kind = 'tool' AND text LIKE 'gagal: %' AND at >= ? AND at <= ?", iso(r.from), iso(r.to));
  const by = new Map();
  for (const x of rows) {
    const m = /^gagal: (\S+)(?: - (.*))?$/s.exec(x.text);
    const tool = (m?.[1] || x.text.slice(7)).replace(/^mcp__kantor__/, '');
    const e = by.get(tool) || by.set(tool, { tool, n: 0, reasons: new Map() }).get(tool);
    e.n++;
    if (m?.[2]) { const k = m[2].slice(0, 100); e.reasons.set(k, (e.reasons.get(k) || 0) + 1); }
  }
  const toolErrors = [...by.values()].map(e => ({ tool: e.tool, n: e.n, reasons: [...e.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text, n]) => ({ text, n })) })).sort((a, b) => b.n - a.n);
  const news = one(db, 'SELECT COUNT(*) n FROM news WHERE at >= ? AND at <= ?', iso(r.from), iso(r.to))?.n || 0;
  const out = { toolErrors: { total: rows.length, byTool: toolErrors.slice(0, 12), withReasons: toolErrors.some(e => e.reasons.length) }, announcements: news, rules: null };
  // locks / rules (from the rules module) when their table exists
  for (const [dbx, name] of [[db, 'locks'], [db, 'rules'], [g, 'locks'], [g, 'rules']]) {
    try {
      if (!one(dbx, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)) continue;
      const cols = all(dbx, `PRAGMA table_info(${name})`).map(c => c.name);
      const col = ['at', 'created_at', 'taken_at'].find(c => cols.includes(c));
      const n = col ? one(dbx, `SELECT COUNT(*) n FROM ${name} WHERE ${col} >= ? AND ${col} <= ?`, iso(r.from), iso(r.to)).n : one(dbx, `SELECT COUNT(*) n FROM ${name}`).n;
      out.rules = { ...(out.rules || {}), [name]: n };
    } catch { /* table shape unknown: skip */ }
  }
  return out;
}

/* ---------------- one office ---------------- */
export async function officeMetrics(office, q = {}, { now = Date.now() } = {}) {
  const r = resolveRange(q, now);
  const db = officeDb(office), g = globalDb();
  ensureIndexes(db);
  const roles = all(db, 'SELECT id, name, title, model, engine FROM roles');
  const nameOf = id => roles.find(x => x.id === id)?.name || null;
  const stuckHours = Math.max(0.5, Number(q.stuck) || 3);
  const B = makeBuckets(r);
  const cards = cardMetrics(db, r, B, stuckHours, now, nameOf);
  const gitm = await gitMetrics(office, r, B);
  const dmm = dmMetrics(db, r, nameOf, now);
  const sessions = sessionMetrics(db, g, office, r, roles, now);
  const cost = costMetrics(g, office, r, roles, cards.done, gitm.total);
  const friction = frictionMetrics(db, g, r);
  const dmPerBucket = new Array(B.starts.length).fill(0);
  for (const d of all(db, 'SELECT at FROM dm WHERE at >= ? AND at <= ?', iso(r.from), iso(r.to))) { const i = B.idx(ms(d.at)); if (i >= 0) dmPerBucket[i]++; }
  const { doneIds, ...cardsOut } = cards;
  return {
    office, range: { key: r.key, label: r.label, from: iso(r.from), to: iso(r.to), bucket: r.bucket }, generatedAt: iso(now),
    series: { starts: B.starts.map(iso), created: cards.createdPerBucket, done: cards.donePerBucket, commits: gitm.perBucket, dm: dmPerBucket },
    cards: (({ createdPerBucket, donePerBucket, ...x }) => x)(cardsOut),
    dm: dmm, sessions, cost, git: { total: gitm.total, reverts: gitm.reverts, kinds: gitm.kinds, perRepo: gitm.perRepo },
    friction,
  };
}

/* ---------------- all offices ---------------- */
export async function complexMetrics(q = {}, { now = Date.now() } = {}) {
  const r = resolveRange(q, now);
  const offices = all(globalDb(), 'SELECT id, name FROM offices WHERE hidden = 0 OR hidden IS NULL');
  const parts = [];
  for (const o of offices) {
    try { parts.push({ id: o.id, name: o.name, m: await officeMetrics(o.id, q, { now }) }); } catch { /* an office with a broken db is skipped */ }
  }
  const busy = parts.filter(p => p.m.cards.created || p.m.cards.done || p.m.dm.total || p.m.git.total || p.m.cost.total || p.m.sessions.totals.workSec);
  const sumOf = f => sum(busy.map(p => f(p.m)));
  const cyc = busy.flatMap(p => p.m.cards.cycle.n ? [p.m.cards.cycle] : []);
  const cycN = sum(cyc.map(c => c.n));
  return {
    range: { key: r.key, label: r.label, from: iso(r.from), to: iso(r.to), bucket: r.bucket }, generatedAt: iso(now),
    total: {
      cardsCreated: sumOf(m => m.cards.created), cardsDone: sumOf(m => m.cards.done), commits: sumOf(m => m.git.total), reverts: sumOf(m => m.git.reverts),
      dm: sumOf(m => m.dm.total), dmWaiting: sumOf(m => m.dm.waitingNow.count), stuck: sumOf(m => m.cards.stuck.count),
      cost: rnd(sumOf(m => m.cost.total)), workSec: sumOf(m => m.sessions.totals.workSec), idleSec: sumOf(m => m.sessions.totals.idleSec), waitSec: sumOf(m => m.sessions.totals.waitSec),
      toolErrors: sumOf(m => m.friction.toolErrors.total), cycleAvgH: cycN ? rnd(sum(cyc.map(c => c.avgH * c.n)) / cycN) : null,
    },
    offices: busy.map(p => ({
      id: p.id, name: p.name, cardsCreated: p.m.cards.created, cardsDone: p.m.cards.done, cycleAvgH: p.m.cards.cycle.avgH, stuck: p.m.cards.stuck.count,
      dm: p.m.dm.total, dmDeliverMaxSec: p.m.dm.deliver.maxSec, commits: p.m.git.total, cost: p.m.cost.total, toolErrors: p.m.friction.toolErrors.total,
    })).sort((a, b) => b.cost - a.cost),
  };
}

/* ---------------- shift report (markdown, for the next postmortem) ---------------- */
const dur = s => s == null ? '-' : s < 90 ? `${s} dtk` : s < 5400 ? `${Math.round(s / 60)} mnt` : `${(s / 3600).toFixed(1)} jam`;
const hrs = h => h == null ? '-' : `${String(h).replace('.', ',')} jam`;
const usd = v => v == null ? '-' : `USD ${v.toFixed(2).replace('.', ',')}`;
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => rows.length ? `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(x => `| ${x.map(cell).join(' | ')} |`).join('\n')}\n` : '_Tidak ada data._\n';

export function reportMarkdown(m, officeName = m.office) {
  const w = new Date(m.range.from).toLocaleString('id-ID'), e = new Date(m.range.to).toLocaleString('id-ID');
  const c = m.cards, d = m.dm, s = m.sessions, k = m.cost, f = m.friction;
  const L = [];
  L.push(`# Laporan shift ${officeName}`, '', `Rentang: ${m.range.label} (${w} s.d. ${e}). Dibuat ${new Date(m.generatedAt).toLocaleString('id-ID')}.`, '');
  L.push('## Ringkasan', '',
    `- Kartu: ${c.created} dibuat, ${c.done} selesai.`,
    `- Siklus Dikerjakan ke Selesai: rata-rata ${hrs(c.cycle.avgH)}, median ${hrs(c.cycle.medianH)}, p90 ${hrs(c.cycle.p90H)} (${c.cycle.n} kartu terukur).`,
    `- Kartu macet (> ${c.stuck.hours} jam tanpa gerak): ${c.stuck.count}. Bolak-balik Review ke Dikerjakan: ${c.review.bounces} kali pada ${c.review.bouncedCards} kartu.`,
    `- Git: ${m.git.total} commit, ${m.git.reverts} revert.`,
    `- DM: ${d.total} (${d.pesan} pesan, ${d.balasan} balasan, ${d.tanya} tanya). Kirim sampai terlihat: rata-rata ${dur(d.deliver.avgSec)}, p90 ${dur(d.deliver.p90Sec)}, maks ${dur(d.deliver.maxSec)}. Tanya timeout: ${d.askTimeout}. Menunggu sekarang: ${d.waitingNow.count}.`,
    `- Biaya: ${usd(k.total)}${k.perDoneCard != null ? `, ${usd(k.perDoneCard)} per kartu selesai` : ''}${k.perCommit != null ? `, ${usd(k.perCommit)} per commit` : ''}. Granularitas per hari${k.tokenOnlyTokens ? `; ${k.tokenOnlyTokens.toLocaleString('id-ID')} token Codex tanpa harga` : ''}.`,
    `- Sesi: kerja ${dur(s.totals.workSec)}, idle ${dur(s.totals.idleSec)}, menunggu izin ${dur(s.totals.waitSec)}. Kompaksi ${s.compactions}, interrupt ${s.interrupts}, izin jatuh ke terminal ${s.permissions.toTerminal}.`,
    `- Gesekan: ${f.toolErrors.total} tool kantor/agen gagal, ${f.announcements} pengumuman.`, '');
  if (c.stuck.cards.length) L.push('## Kartu macet', '', table(['Kartu', 'Judul', 'Kolom', 'Pemilik', 'Diam'], c.stuck.cards.map(x => [x.id, x.title, x.col, x.who || '-', hrs(x.hours)])));
  L.push('## DM per penerima', '', table(['Penerima', 'DM', 'Kirim rata-rata', 'p90', 'Maks', '> 1 mnt', '> 5 mnt', 'Dibalas rata-rata'],
    d.perRole.map(p => [p.name, p.n, dur(p.deliver.avgSec), dur(p.deliver.p90Sec), dur(p.deliver.maxSec), p.slow1, p.slow5, dur(p.reply.avgSec)])));
  L.push('## Jam kerja per role', '', table(['Role', 'Kerja', 'Idle', 'Menunggu izin', 'Kompaksi', 'Interrupt'], s.perRole.map(p => [p.name, dur(p.workSec), dur(p.idleSec), dur(p.waitSec), p.compactions, p.interrupts])));
  L.push('## Biaya per role', '', table(['Role', 'Biaya', 'Pesan model'], k.perRole.map(p => [p.name, usd(p.cost), p.msgs])));
  L.push('## Git per repo', '', table(['Repo', 'Commit', 'Revert'], m.git.perRepo.map(p => [p.repo, p.commits, p.reverts])));
  L.push('## Gesekan', '', table(['Tool', 'Gagal', 'Alasan terbanyak'], f.toolErrors.byTool.map(x => [x.tool, x.n, x.reasons[0] ? `${x.reasons[0].text} (${x.reasons[0].n}x)` : 'alasan tidak tercatat'])));
  if (f.rules) L.push(`Kunci/aturan: ${Object.entries(f.rules).map(([a, b]) => `${a} ${b}`).join(', ')}`, '');
  L.push('_Catatan: jam kerja diperkirakan dari jejak aktivitas (jeda > 3 menit dianggap idle). Biaya per hari penuh._', '');
  return L.join('\n');
}
