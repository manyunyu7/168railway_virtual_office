// Budget per role: roles.budget_usd is a daily (or per-shift) limit counted from the usage table.
// Claude roles count dollars (API-equivalent), Codex roles count tokens because their cost is 0.
// 80%: a reminder is appended to the result of every office tool. 100%: the session is told to save its work and stop,
// the role is marked, and Ghina gets a notification. Each crossing is reported once per day (or shift).
import { globalDb, one } from './db.js';
import { bus, live, logOffice, serialize } from './live.js';
import * as st from './store.js';
import { sessionAction } from './tmux.js';
import { getConf } from './autopilot.js';

export const WARN = 80, FULL = 100;
const TTL = 20e3;

let sender = (sid, text) => sessionAction(sid, 'text', text);
/** Tests replace the way text reaches a session. */
export function setSender(fn) { sender = fn; }

const localDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sessionsOf = (office, roleId) => [...live.values()].filter(s => s.office === office && s.role === roleId && s.status !== 'ended' && s.kind !== 'rapat');

export function fmt(v, unit) {
  if (unit === 'token') return v >= 1e6 ? `${(v / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 2 })} jt token` : `${Math.round(v).toLocaleString('id-ID')} token`;
  return `USD ${v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Budget picture of one role, or null when it has none. */
export function status(office, role, now = Date.now()) {
  const limit = Number(role.budget);
  if (!(limit > 0)) return null;
  const unit = role.engine === 'codex' ? 'token' : 'usd';
  const period = getConf(office).budgetPeriod;
  const sql = 'SELECT COALESCE(SUM(cost), 0) cost, COALESCE(SUM(input + output), 0) tokens FROM usage';
  let row, key;
  if (period === 'shift') {
    const sids = sessionsOf(office, role.id).map(s => s.sid).sort();
    row = sids.length ? one(globalDb(), `${sql} WHERE sid IN (${sids.map(() => '?').join(',')})`, ...sids) : { cost: 0, tokens: 0 };
    key = `shift:${sids.join(',')}`;
  } else {
    row = one(globalDb(), `${sql} WHERE office = ? AND role = ? AND day = ?`, office, role.id, localDay(now));
    key = localDay(now);
  }
  const used = unit === 'token' ? row.tokens : row.cost;
  const percent = Math.round(used / limit * 1000) / 10;
  return { role: role.id, name: role.name, limit, unit, period, key, used, percent, level: percent >= FULL ? 'habis' : percent >= WARN ? 'peringatan' : 'ok' };
}

const cache = new Map(); // office:role -> { at, st }
function cached(office, roleId, now = Date.now()) {
  const k = `${office}:${roleId}`, c = cache.get(k);
  if (c && now - c.at < TTL) return c.st;
  const role = st.getRole(office, roleId);
  const s = role ? status(office, role, now) : null;
  cache.set(k, { at: now, st: s });
  return s;
}
export function exhausted(office, roleId) { try { return !!roleId && cached(office, roleId)?.level === 'habis'; } catch { return false; } }

/** Every role of the office with its budget picture (roles without a limit are left out). */
export function overview(office, now = Date.now()) {
  return st.listRoles(office).map(r => status(office, r, now)).filter(Boolean);
}

/** Reminder text for the result of an office tool, or null while the role is under 80%. */
export function reminder(office, roleId) {
  if (!roleId) return null;
  let s; try { s = cached(office, roleId); } catch { return null; }
  if (!s || s.level === 'ok') return null;
  const per = s.period === 'shift' ? 'shift' : 'harian';
  if (s.level === 'habis') return `[Kantor · anggaran habis] Anggaran ${per}mu terpakai ${s.percent}% (${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}). Simpan pekerjaan dan berhenti; jangan mulai yang baru.`;
  return `[Kantor · anggaran ${Math.round(s.percent)}%] Anggaran ${per}mu terpakai ${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}. Rampungkan yang paling penting, simpan catatan (role_notes_write), dan hindari pekerjaan besar yang baru.`;
}

const stopText = s => `[Kantor · anggaran habis] Anggaran ${s.period === 'shift' ? 'shift' : 'harian'}mu habis (${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}). Simpan pekerjaanmu sekarang: commit atau simpan perubahan yang aman, tulis role_notes_write dan card_comment berisi posisi terakhir, lalu berhenti dan jangan mulai pekerjaan baru. ${s.period === 'shift' ? 'Anggaran dibuka lagi di shift berikutnya' : 'Anggaran dibuka lagi besok'} atau bila pemilik menaikkannya.`;

const flags = new Map(); // office:role -> { key, level }
const mark = (office, roleId, level) => {
  for (const x of sessionsOf(office, roleId)) {
    const v = level === 'ok' ? null : level;
    if ((x.anggaran || null) !== v) { x.anggaran = v; bus.emit('msg', { t: 'session', office, session: serialize(x) }); }
  }
};

/** Compare every role against its limit and act on crossings. Safe to call often. */
export async function check(office, now = Date.now()) {
  const acted = [];
  for (const role of st.listRoles(office)) {
    const s = status(office, role, now);
    cache.set(`${office}:${role.id}`, { at: now, st: s });
    const fk = `${office}:${role.id}`;
    const prev = flags.get(fk);
    const before = prev && prev.key === s?.key ? prev.level : 'ok';
    if (!s) { if (prev) { flags.delete(fk); mark(office, role.id, 'ok'); } continue; }
    flags.set(fk, { key: s.key, level: s.level });
    const stale = sessionsOf(office, role.id).filter(x => x.tmux && x.anggaran !== 'habis'); // includes a shift started after the limit was hit
    if (s.level === 'habis' && (before !== 'habis' || stale.length)) {
      const targets = before !== 'habis' ? sessionsOf(office, role.id).filter(x => x.tmux) : stale;
      for (const x of targets) { try { await sender(x.sid, stopText(s)); } catch {} }
      mark(office, role.id, 'habis');
      if (before !== 'habis') {
        logOffice(office, role.name, `anggaran habis: ${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}`, 'budget');
        bus.emit('msg', { t: 'budget', office, role: role.id, level: 'habis', used: s.used, limit: s.limit, unit: s.unit });
        bus.emit('notify', { kind: 'budget', office, sid: targets[0]?.sid || null, who: role.name, text: `Anggaran ${s.period === 'shift' ? 'shift' : 'harian'} habis: ${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}. Sesinya diminta menyimpan pekerjaan dan berhenti.`, dedupe: s.key });
      }
      acted.push({ role: role.id, level: 'habis' });
    } else if (s.level === 'peringatan' && before === 'ok') {
      mark(office, role.id, 'peringatan');
      logOffice(office, role.name, `anggaran ${Math.round(s.percent)}%: ${fmt(s.used, s.unit)} dari ${fmt(s.limit, s.unit)}`, 'budget');
      bus.emit('msg', { t: 'budget', office, role: role.id, level: 'peringatan', used: s.used, limit: s.limit, unit: s.unit });
      acted.push({ role: role.id, level: 'peringatan' });
    } else if (s.level !== before) { // back down: the limit was raised or a new day began
      mark(office, role.id, s.level);
      if (before === 'habis') logOffice(office, role.name, 'anggaran dibuka lagi', 'budget');
      bus.emit('msg', { t: 'budget', office, role: role.id, level: s.level, used: s.used, limit: s.limit, unit: s.unit });
    } else if (s.level === 'peringatan') mark(office, role.id, 'peringatan'); // a session that started after the crossing
  }
  return acted;
}

let started = false;
export function startBudget(listOffices) {
  if (started) return;
  started = true;
  const run = () => { for (const o of listOffices()) check(o.id).catch(e => console.error(`anggaran: ${e.message}`)); };
  let t = null;
  const soon = () => { clearTimeout(t); t = setTimeout(run, 2000); t.unref(); };
  // right after every usage scan, and when a role (its limit) changes
  bus.on('msg', m => { if (m.t === 'changed' && (m.what === 'payroll' || m.what === 'roles' || m.what === 'plan')) soon(); });
  setInterval(run, 60e3).unref();
}
