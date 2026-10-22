import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-usage-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [path.join(tmp, 'Developer')], token: 'x' }));

let U, db;
before(async () => {
  U = await import('../server/usage.js');
  db = await import('../server/db.js');
});

const day = off => { const d = new Date(Date.now() - off * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('claude rate_limits dinormalkan; field rusak dibuang', () => {
  const now = 1_800_000_000_000;
  const n = U.normalizeClaude({ five_hour: { used_percentage: 23.5, resets_at: now / 1000 + 600 }, seven_day: { used_percentage: 150, resets_at: now / 1000 - 5 }, spend_limit: { used_percentage: 'x' } }, now);
  assert.equal(n.windows.length, 2);
  assert.equal(n.windows[0].usedPercent, 23.5);
  assert.equal(n.windows[0].resetsAt, now + 600e3);
  assert.equal(n.windows[0].expired, false);
  assert.equal(n.windows[1].usedPercent, 100); // dijepit
  assert.equal(n.windows[1].expired, true);
  assert.equal(n.spend, null);
  assert.equal(U.normalizeClaude({}), null);
  assert.equal(U.normalizeClaude(null), null);
  assert.equal(U.normalizeClaude({ five_hour: { used_percentage: NaN } }), null);
});

test('recordClaudeLimits menyimpan, memberi tahu hanya saat berubah, dan limits() memberi level', async () => {
  const { bus } = await import('../server/live.js');
  const seen = [];
  const f = m => { if (m.t === 'usage-limits') seen.push(m); };
  bus.on('msg', f);
  const soon = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(U.recordClaudeLimits({ rate_limits: { five_hour: { used_percentage: 40, resets_at: soon }, seven_day: { used_percentage: 92, resets_at: soon + 86400 } } }), true);
  assert.equal(U.recordClaudeLimits({ rate_limits: { five_hour: { used_percentage: 40.2, resets_at: soon }, seven_day: { used_percentage: 92.1, resets_at: soon + 86400 } } }), false);
  assert.equal(U.recordClaudeLimits({ nothing: 1 }), false);
  bus.off('msg', f);
  assert.equal(seen.length, 1);
  const l = U.limits();
  assert.equal(l.claude.available, true);
  assert.equal(l.claude.windows.length, 2);
  assert.equal(l.level, 'critical');
  assert.ok(l.alert >= 92);
});

test('limit Codex dibaca dari token_count di rollout, yang terbaru menang', () => {
  const dir = path.join(tmp, 'codex', '2026', '10', '21');
  fs.mkdirSync(dir, { recursive: true });
  const ev = (ts, used, extra = {}) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 10080, resets_at: 1893456000 }, secondary: null, plan_type: 'prolite', ...extra } } });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), [ev('2026-10-21T10:00:00Z', 10), '{"type":"x"}', ev('2026-10-21T11:00:00Z', 25), 'bukan json {'].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), ev('2026-10-21T09:00:00Z', 5) + '\n');
  const items = U.readCodexLimits({ dir: path.join(tmp, 'codex'), now: 1_790_000_000_000 });
  assert.equal(items.length, 1);
  assert.equal(items[0].plan, 'prolite');
  assert.equal(items[0].windows[0].usedPercent, 25);
  assert.equal(items[0].windows[0].label, 'Mingguan');
  assert.equal(items[0].windows[0].resetsAt, 1893456000 * 1000);
  assert.deepEqual(U.readCodexLimits({ dir: path.join(tmp, 'nope') }), []);
});

test('summary: total, per hari terisi nol, per mesin/model/kantor, sesi terboros', () => {
  const g = db.globalDb();
  db.run(g, "INSERT INTO offices (id, name, root) VALUES ('kantor-a', 'Kantor A', '/x/a'), ('kantor-b', 'Kantor B', '/x/b')");
  db.run(g, "INSERT INTO sessions (sid, office, role, title, started_at, ended_at) VALUES ('s1', 'kantor-a', 'dev', 'Sesi satu', ?, ?)", new Date(Date.now() - 7200e3).toISOString(), new Date(Date.now() - 3600e3).toISOString());
  const ins = (sid, office, role, model, d, input, output, cw, cr, cost) => db.run(g, 'INSERT INTO usage (sid, office, role, model, day, msgs, input, output, cache_w, cache_r, cost) VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?)', sid, office, role, model, d, input, output, cw, cr, cost);
  ins('s1', 'kantor-a', 'dev', 'claude-sonnet-4-6', day(0), 100, 50, 10, 1000, 1.5);
  ins('s2', 'kantor-a', null, 'gpt-5.5', day(2), 200, 80, 0, 500, 0);
  ins('s3', 'kantor-b', 'qa', 'claude-opus-4-7', day(20), 1, 1, 1, 1, 9);
  const s7 = U.summary({ range: '7d' });
  assert.equal(s7.daily.length, 7);
  assert.equal(s7.totals.sessions, 2);
  assert.equal(s7.totals.input, 300);
  assert.equal(s7.totals.tokens, 100 + 50 + 10 + 1000 + 200 + 80 + 500);
  assert.equal(s7.totals.cost, 1.5);
  assert.equal(s7.engines.codex.tokens, 780);
  assert.equal(s7.byOffice.length, 1);
  assert.equal(s7.byModel.find(m => m.engine === 'codex').model, 'gpt-5.5');
  assert.equal(s7.byMachine.length, 1);
  assert.equal(s7.topSessions[0].sid, 's1');
  assert.equal(s7.topSessions[0].title, 'Sesi satu');
  assert.equal(s7.avgPerSession.tokens, Math.round(s7.totals.tokens / 2));
  assert.ok(s7.work.seconds >= 3500 && s7.work.seconds <= 3700);
  assert.ok(s7.daily.every(d => Number.isFinite(d.tokens) && Number.isFinite(d.cost)));
  assert.equal(s7.daily.filter(d => d.tokens === 0).length, 5);
  assert.equal(U.summary({ range: 'today' }).totals.sessions, 1);
  assert.equal(U.summary({ range: '30d' }).totals.sessions, 3);
  const a = U.summary({ range: '30d', office: 'kantor-b' });
  assert.equal(a.totals.sessions, 1);
  assert.deepEqual(a.byOffice, []);
  assert.equal(U.summary({ range: 'ngawur' }).range, '7d');
  const empty = U.summary({ range: '7d', office: 'tidak-ada' });
  assert.equal(empty.totals.tokens, 0);
  assert.equal(empty.avgPerSession.tokens, 0);
  assert.equal(empty.work.avgSeconds, 0);
});

test('statusLineSettings menunjuk skrip statusline Kantor', () => {
  const s = U.statusLineSettings();
  if (s.statusLine) { assert.equal(s.statusLine.type, 'command'); assert.ok(s.statusLine.command.includes('kantor-statusline.cjs')); }
});
