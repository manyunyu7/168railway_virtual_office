// Autopilot per kantor: offer a fitting Backlog/Siap card to an idle agent (pullWork), and a manager round that only
// runs when Siap/Review cards have not moved. Config lives in the office db (meta 'autopilot'); every offer is logged.
import { officeDb, one, all, run } from './db.js';
import { bus, live, logOffice } from './live.js';
import * as st from './store.js';
import { sessionAction } from './tmux.js';
import { exhausted } from './budget.js';

export const DEFAULTS = {
  pullWork: false,
  idleMinutes: 3,          // how long a session must have been idle before it gets an offer
  maxPerHour: 4,           // offers per role per hour
  cooldownMinutes: 60,     // the same card is not offered to the same role again within this time
  skipLabels: ['menunggu', 'klien', 'pemilik', 'blokir'], // cards carrying one of these labels (substring, any case) are never offered
  budgetPeriod: 'hari',    // 'hari' | 'shift': what a role's budget_usd counts
  managerRound: { enabled: false, staleMinutes: 45, cooldownMinutes: 30 },
};

let sender = (sid, text) => sessionAction(sid, 'text', text);
/** Tests replace the way text reaches a session. */
export function setSender(fn) { sender = fn; }

const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export function getConf(office) {
  let raw = {};
  try { raw = JSON.parse(one(officeDb(office), "SELECT value FROM meta WHERE key = 'autopilot'")?.value || '{}'); } catch {}
  return normalize(raw);
}
function normalize(raw) {
  const mr = raw.managerRound || {};
  return {
    pullWork: raw.pullWork === true,
    idleMinutes: num(raw.idleMinutes, DEFAULTS.idleMinutes, 0, 240),
    maxPerHour: Math.round(num(raw.maxPerHour, DEFAULTS.maxPerHour, 1, 60)),
    cooldownMinutes: num(raw.cooldownMinutes, DEFAULTS.cooldownMinutes, 1, 1440),
    skipLabels: Array.isArray(raw.skipLabels) ? raw.skipLabels.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 20) : DEFAULTS.skipLabels,
    budgetPeriod: raw.budgetPeriod === 'shift' ? 'shift' : 'hari',
    managerRound: { enabled: mr.enabled === true, staleMinutes: num(mr.staleMinutes, DEFAULTS.managerRound.staleMinutes, 5, 1440), cooldownMinutes: num(mr.cooldownMinutes, DEFAULTS.managerRound.cooldownMinutes, 5, 1440) },
  };
}
/** Merge a partial change into the stored config. */
export function setConf(office, patch = {}) {
  const cur = getConf(office);
  const next = normalize({ ...cur, ...patch, managerRound: { ...cur.managerRound, ...(patch.managerRound || {}) } });
  run(officeDb(office), "INSERT INTO meta (key, value) VALUES ('autopilot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
  bus.emit('msg', { t: 'changed', office, what: 'autopilot' });
  return next;
}
/** Latest autopilot entries of the office log (newest first). */
export function autopilotLog(office, limit = 50) {
  return all(officeDb(office), "SELECT who, text, at FROM log WHERE kind = 'autopilot' ORDER BY id DESC LIMIT ?", limit);
}

/* ---------------- pullWork ---------------- */
const offered = new Map(); // office:role:card -> ms of the last offer
const perRole = new Map(); // office:role -> [ms of offers in the last hour]

/** Cards that could go to this role: its own Backlog/Siap cards first, then unowned ones that match its room or a label with its name. */
export function candidates(office, role, conf = getConf(office), now = Date.now()) {
  const db = officeDb(office);
  const rows = all(db, "SELECT * FROM cards WHERE archived = 0 AND epic = 0 AND kind IN ('antre', 'siap') AND (blocked IS NULL OR blocked = '') AND (who = ? OR who IS NULL OR who = '')", role.id);
  const open = new Set(all(db, "SELECT id FROM cards WHERE kind <> 'selesai' AND archived = 0").map(r => r.id));
  const labelNames = new Map(st.listLabels(office).map(l => [l.id, String(l.name).toLowerCase()]));
  const mine = [role.id, role.name, role.room].filter(Boolean).map(x => String(x).toLowerCase());
  const out = [];
  for (const c of rows) {
    // a dependency that is not Selesai yet keeps the card out
    if (all(db, 'SELECT dep_id FROM card_deps WHERE card_id = ?', c.id).some(d => open.has(d.dep_id))) continue;
    let labels = []; try { labels = JSON.parse(c.labels || '[]').map(id => labelNames.get(id) || String(id).toLowerCase()); } catch {}
    if (labels.some(l => conf.skipLabels.some(k => l.includes(k)))) continue;
    const own = c.who === role.id;
    if (!own && !(role.room && c.repo === role.room) && !labels.some(l => mine.includes(l))) continue;
    if (now - (offered.get(`${office}:${role.id}:${c.id}`) || 0) < conf.cooldownMinutes * 60e3) continue;
    out.push({ ...c, own });
  }
  const prio = p => ({ P0: 0, P1: 1, P2: 2, P3: 3 }[p] ?? 2);
  return out.sort((a, b) => (b.own - a.own) || ((b.kind === 'siap') - (a.kind === 'siap')) || (prio(a.prio) - prio(b.prio)) || String(a.created_at).localeCompare(String(b.created_at)));
}

const offerText = (office, role, c) => `[Kantor · tawaran kerja] Ada kartu yang cocok untukmu: ${c.id} "${c.title}" (${c.prio}, ${st.colNameOf(office, c)}${c.board && c.board !== 'utama' ? `, papan ${c.board}` : ''}${c.own ? ', ditugaskan padamu' : ', belum ada pemilik'}). Ambil dengan card_update(id="${c.id}", col="Dikerjakan", who="${role.id}") lalu kerjakan; kalau tidak cocok atau sudah tidak ada waktu, abaikan dan panggil tunggu_kerja.`;

const idleFor = (s, now) => (s.status === 'idle' && !s.waiting && !s.compacting ? now - Date.parse(s.lastSeen || 0) : -1);

export async function pullWorkTick(office, now = Date.now()) {
  const conf = getConf(office);
  if (!conf.pullWork) return [];
  const done = [];
  const db = officeDb(office);
  const offeredTo = new Set(); // one session per role, even when it runs several shifts
  for (const s of [...live.values()].sort((a, b) => (a.slot || 0) - (b.slot || 0))) {
    if (s.office !== office || !s.role || offeredTo.has(s.role) || !s.tmux || s.kind === 'rapat' || s.status === 'ended') continue;
    if (idleFor(s, now) < conf.idleMinutes * 60e3) continue;
    const role = st.getRole(office, s.role);
    if (!role || role.archived) continue;
    if (exhausted(office, role.id)) continue;
    if (one(db, "SELECT 1 FROM dm WHERE to_role = ? AND status = 'menunggu'", role.id)) continue; // a message is about to go in
    if (one(db, "SELECT 1 FROM cards WHERE who = ? AND kind = 'dikerjakan' AND archived = 0 AND (blocked IS NULL OR blocked = '')", role.id)) continue; // still has something in progress
    const key = `${office}:${role.id}`;
    const recent = (perRole.get(key) || []).filter(t => now - t < 3600e3);
    perRole.set(key, recent);
    if (recent.length >= conf.maxPerHour) continue;
    const c = candidates(office, role, conf, now)[0];
    if (!c) continue;
    offeredTo.add(s.role);
    try {
      await sender(s.sid, offerText(office, role, c));
    } catch (e) { logOffice(office, role.name, `tawaran kerja ${c.id} gagal: ${e.message}`, 'autopilot'); continue; }
    offered.set(`${key}:${c.id}`, now);
    recent.push(now);
    logOffice(office, role.name, `ditawari kartu ${c.id} "${String(c.title).slice(0, 50)}" (pullWork)`, 'autopilot');
    done.push({ role: role.id, card: c.id });
  }
  return done;
}

/* ---------------- manager round ---------------- */
const lastRound = new Map(); // office -> ms

/** Siap/Review cards with nobody moving them for staleMinutes. */
export function staleCards(office, minutes, now = Date.now()) {
  const cut = new Date(now - minutes * 60e3).toISOString();
  return all(officeDb(office), "SELECT id, title, col, board, kind, who, updated_at FROM cards WHERE archived = 0 AND epic = 0 AND kind IN ('siap', 'review') AND (blocked IS NULL OR blocked = '') AND updated_at < ? ORDER BY updated_at", cut);
}

export async function managerRoundTick(office, now = Date.now()) {
  const conf = getConf(office);
  const mr = conf.managerRound;
  if (!mr.enabled) return null;
  if (now - (lastRound.get(office) || 0) < mr.cooldownMinutes * 60e3) return null;
  const stale = staleCards(office, mr.staleMinutes, now);
  if (!stale.length) return null;
  const mgr = [...live.values()].find(s => s.office === office && s.tmux && s.status === 'idle' && !s.waiting && s.kind !== 'rapat' && st.getRole(office, s.role)?.isMgr);
  if (!mgr || now - Date.parse(mgr.lastSeen || 0) < conf.idleMinutes * 60e3) return null;
  if (exhausted(office, mgr.role)) return null;
  const mins = c => Math.round((now - Date.parse(c.updated_at)) / 60e3);
  const list = stale.slice(0, 8).map(c => `${c.id} "${String(c.title).slice(0, 50)}" (${st.colNameOf(office, c)}, ${mins(c)} menit${c.who ? `, ${st.getRole(office, c.who)?.name || c.who}` : ', tanpa pemilik'})`).join('; ');
  lastRound.set(office, now);
  try { await sender(mgr.sid, `[Kantor · ronde manager] ${stale.length} kartu Siap/Review tidak bergerak lebih dari ${mr.staleMinutes} menit: ${list}${stale.length > 8 ? ', …' : ''}. Tindak lanjuti: tanya pemegangnya, tugaskan ulang, atau tutup. Kalau tidak ada yang perlu dilakukan, panggil tunggu_kerja.`); }
  catch (e) { logOffice(office, 'Autopilot', `ronde manager gagal: ${e.message}`, 'autopilot'); return null; }
  logOffice(office, st.getRole(office, mgr.role)?.name || 'Manager', `ronde manager: ${stale.length} kartu tidak bergerak`, 'autopilot');
  return { manager: mgr.role, cards: stale.map(c => c.id) };
}

let timer = null;
export function startAutopilot() {
  if (timer) return;
  timer = setInterval(async () => {
    const offices = new Set([...live.values()].filter(s => s.office && s.status !== 'ended').map(s => s.office));
    for (const o of offices) {
      try { await pullWorkTick(o); await managerRoundTick(o); } catch (e) { console.error(`autopilot: ${e.message}`); }
    }
  }, 60e3);
  timer.unref();
}
