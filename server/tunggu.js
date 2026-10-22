// Tool `tunggu_kerja`: the agent ends its turn and says what it waits for; the daemon wakes the session with ONE short
// prompt when that happens (or when the time runs out). No turn is spent while waiting, unlike sleep, Monitor or ScheduleWakeup.
// A wait goes through: registered (the agent is still finishing its turn) -> armed (the session went idle) -> fired.
import { bus, live, logOffice, serialize } from './live.js';
import { globalDb, officeDb, one, run, all } from './db.js';
import * as st from './store.js';
import { officeModel } from './offices.js';
import { sessionAction } from './tmux.js';
import { headOf } from './gitinfo.js';
import { exhausted } from './budget.js';

export const EVENTS = ['kartu_masuk', 'kartu_untukku', 'pesan', 'commit_baru', 'review_diminta'];
export const DEFAULT_MAX_MIN = 180;
export const LIMIT_MAX_MIN = 720;
const COALESCE_MS = 1500; // events arriving together wake the session once
const COMMIT_POLL_MS = 30e3;

let sender = (sid, text) => sessionAction(sid, 'text', text);
/** Tests replace the way text reaches a session. */
export function setSender(fn) { sender = fn; }

/** sid -> { sid, office, role, events, until, since, armed, pending: [{ev, text}], pendingAt, repos: {room: sha}, timedOut } */
const waits = new Map();
const kvKey = sid => `tunggu.${sid}`;
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const waitOf = sid => waits.get(sid) || null;

function persist(w) {
  try {
    run(globalDb(), 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', kvKey(w.sid),
      JSON.stringify({ sid: w.sid, office: w.office, role: w.role, events: w.events, until: w.until, since: w.since, repos: w.repos }));
  } catch {}
}
function forget(sid) { try { run(globalDb(), 'DELETE FROM kv WHERE key = ?', kvKey(sid)); } catch {} }

function show(s, w) {
  if (!s) return;
  s.tunggu = w ? { events: w.events, until: w.until ? new Date(w.until).toISOString() : null, label: `menunggu: ${w.events.join(', ') || 'waktu'}` } : null;
  bus.emit('msg', { t: 'session', office: s.office, session: serialize(s), by: 'tunggu' });
}

function drop(sid) {
  const w = waits.get(sid);
  if (!w) return;
  waits.delete(sid);
  forget(sid);
  show(live.get(sid), null);
}

/** Register a wait for the calling session. Returns the text the agent gets back. */
export async function daftar(s, a = {}) {
  if (!s) throw new Error('Sesi ini tidak dikenali kantor, jadi tidak bisa dibangunkan.');
  if (!s.tmux) throw new Error('Sesi ini tidak jalan di tmux kantor, jadi harness tidak bisa membangunkannya. Selesaikan saja gilirannya.');
  const raw = Array.isArray(a.kejadian) ? a.kejadian : a.kejadian ? [a.kejadian] : [];
  const events = [...new Set(raw.map(x => String(x).trim()))].filter(Boolean);
  const bad = events.find(x => !EVENTS.includes(x));
  if (bad) throw new Error(`Kejadian "${bad}" tidak dikenal. Pilihan: ${EVENTS.join(', ')}.`);
  if (!s.role && events.some(e => e === 'kartu_untukku' || e === 'pesan')) throw new Error('kartu_untukku dan pesan butuh sesi yang terikat ke role.');
  const now = Date.now();
  let until = null;
  if (a.sampai) {
    until = Date.parse(a.sampai);
    if (!Number.isFinite(until)) throw new Error(`"sampai" harus waktu ISO, mis. 2026-10-22T09:30:00+07:00: ${a.sampai}`);
  }
  const mins = a.maks_menit === undefined || a.maks_menit === null || a.maks_menit === '' ? null : Number(a.maks_menit);
  if (mins !== null && !(mins > 0)) throw new Error('maks_menit harus angka lebih dari 0.');
  if (!events.length && until === null && mins === null) throw new Error('Isi kejadian, sampai, atau maks_menit: apa yang kamu tunggu?');
  const cap = now + Math.min(mins ?? DEFAULT_MAX_MIN, LIMIT_MAX_MIN) * 60e3;
  until = until === null ? cap : Math.min(until, cap);
  if (until <= now) throw new Error('Waktu "sampai" sudah lewat.');

  const repos = {};
  if (events.includes('commit_baru')) {
    const rooms = Array.isArray(a.repo) ? a.repo : a.repo ? [a.repo] : [s.room].filter(Boolean);
    const known = new Set((officeModel(s.office)?.plan.rooms || []).map(r => r.id));
    for (const r of rooms) {
      if (!known.has(r)) throw new Error(`Ruangan "${r}" tidak ada. Isi repo dengan id ruangan.`);
      const h = await headOf(s.office, r);
      if (h) repos[r] = h.sha;
    }
    if (!Object.keys(repos).length) throw new Error('commit_baru butuh ruangan yang repo git. Isi repo dengan id ruangan yang punya repo.');
  }

  const w = { sid: s.sid, office: s.office, role: s.role || null, events, until, since: now, armed: false, pending: [], pendingAt: 0, repos, timedOut: false };
  waits.set(s.sid, w);
  persist(w);
  show(s, w);
  logOffice(s.office, st.getRole(s.office, s.role)?.name || 'Sesi', `menunggu: ${events.join(', ') || 'waktu'} (maks ${Math.round((until - now) / 60e3)} menit)`, 'tunggu');
  const when = new Date(until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return `Menunggu ${events.length ? events.join(' atau ') : 'waktu saja'}, paling lama sampai ${when}. AKHIRI GILIRANMU SEKARANG: jangan panggil tool lain, jangan sleep, jangan Monitor atau ScheduleWakeup; cukup balas satu kata "menunggu". Harness membangunkanmu dengan satu prompt begitu ada kejadian atau waktu habis.`;
}

/* ---------------- what counts as an event ---------------- */
function boardEvents(m, w) {
  const db = officeDb(m.office);
  const c = one(db, 'SELECT * FROM cards WHERE id = ?', m.card);
  if (!c || c.archived || c.epic) return [];
  const me = w.role, mine = me && c.who === me;
  const meName = me ? st.getRole(m.office, me)?.name : null;
  if (meName && m.by === meName) return []; // my own change
  const from = m.from; // undefined = the card was just created
  const out = [];
  // jenis kolom, bukan nomor: papan lain punya kolom sendiri
  const queued = c.kind === 'antre' || c.kind === 'siap', moved = from && (from.col !== c.col || (from.board || 'utama') !== (c.board || 'utama'));
  const where = `${st.colNameOf(m.office, c)}${c.board && c.board !== 'utama' ? `, papan ${c.board}` : ''}`;
  const toMe = w.events.includes('kartu_untukku') && mine && queued && !c.blocked && (!from || from.who !== me || moved);
  if (toMe) out.push({ ev: 'kartu_untukku', text: `kartu untukmu ${c.id} "${clip(c.title, 70)}" (${c.prio}, ${where})` });
  else if (w.events.includes('kartu_masuk') && queued && !c.blocked && (!c.who || mine) && (!from || moved))
    out.push({ ev: 'kartu_masuk', text: `kartu masuk ${c.id} "${clip(c.title, 70)}" (${c.prio}, ${where}${c.who ? '' : ', tanpa pemilik'})` });
  if (w.events.includes('review_diminta') && c.kind === 'review' && from && (from.kind ? from.kind !== 'review' : moved) && !mine)
    out.push({ ev: 'review_diminta', text: `review diminta ${c.id} "${clip(c.title, 70)}"${c.who ? ` (milik ${st.getRole(m.office, c.who)?.name || c.who})` : ''}` });
  return out;
}

function note(w, items) {
  if (!items.length) return;
  w.pending.push(...items);
  if (!w.pendingAt) w.pendingAt = Date.now();
}

function onMsg(m) {
  switch (m.t) {
    case 'changed':
      if (m.what !== 'board' || !m.card || !m.office) return;
      for (const w of waits.values()) if (w.office === m.office && w.events.length) { try { note(w, boardEvents(m, w)); } catch {} }
      return;
    case 'dm':
      // the message itself is typed into the session by dm.js once it is idle; the wait only ends
      if (m.status !== 'menunggu' || !m.to) return;
      for (const w of waits.values()) if (w.office === m.office && w.role === m.to && w.events.includes('pesan')) note(w, [{ ev: 'pesan', text: 'pesan masuk' }]);
      return;
    case 'session':
      if (m.session?.status === 'idle' && m.by !== 'tunggu') { const w = waits.get(m.session.sid); if (w) w.armed = true; }
      return;
    case 'session-gone':
      drop(m.sid);
  }
}

/* ---------------- waking ---------------- */
function wakeText(w) {
  const lines = w.pending.filter(p => p.ev !== 'pesan').map(p => p.text);
  if (w.timedOut && !lines.length) return `[Kantor · waktu tunggu habis] Tidak ada kejadian yang kamu tunggu (${w.events.join(', ') || 'waktu'}). Cek board_list(mine: true) dan pesan_list; kalau memang tidak ada kerja, panggil tunggu_kerja lagi.`;
  return `[Kantor · bangun dari tunggu] ${lines.join('; ')}. Kerjakan (card_get / board_list); kalau sudah tidak ada kerja, panggil tunggu_kerja lagi.`;
}

async function fire(w, s) {
  waits.delete(w.sid);
  forget(w.sid);
  show(s, null);
  const text = wakeText(w);
  const onlyDm = w.pending.length && w.pending.every(p => p.ev === 'pesan');
  const who = st.getRole(w.office, w.role)?.name || 'Sesi';
  if (onlyDm) { logOffice(w.office, who, 'bangun dari tunggu: pesan masuk', 'tunggu'); return; } // dm.js types the message
  try { await sender(w.sid, text); logOffice(w.office, who, `bangun dari tunggu: ${w.timedOut && !w.pending.length ? 'waktu habis' : w.pending.map(p => p.ev).join(', ')}`, 'tunggu'); }
  catch (e) { logOffice(w.office, who, `gagal membangunkan: ${e.message}`, 'tunggu'); }
}

/** One pass: arm waits whose session went idle, notice timeouts, wake what is due. Exported for tests. */
export async function tick(now = Date.now()) {
  const fired = [];
  for (const w of [...waits.values()]) {
    const s = live.get(w.sid);
    if (!s || s.status === 'ended') { drop(w.sid); continue; }
    if (!w.armed && s.status === 'idle') w.armed = true;
    if (!w.armed || s.status !== 'idle' || s.waiting) continue;
    if (w.until && now >= w.until && !w.timedOut) w.timedOut = true;
    const due = (w.pending.length && now - w.pendingAt >= COALESCE_MS) || (w.timedOut && !w.pending.length);
    if (!due) continue;
    if (w.role && exhausted(w.office, w.role)) continue; // out of budget: waking it would only spend more
    await fire(w, s);
    fired.push(w.sid);
  }
  return fired;
}

/** Poll HEAD of the rooms waits care about; a different sha is a new commit. Exported for tests. */
export async function pollCommits() {
  for (const w of [...waits.values()]) {
    if (!w.events.includes('commit_baru')) continue;
    for (const [room, sha] of Object.entries(w.repos)) {
      const h = await headOf(w.office, room).catch(() => null);
      if (!h || h.sha === sha) continue;
      w.repos[room] = h.sha;
      note(w, [{ ev: 'commit_baru', text: `commit baru di ${room}: ${h.sha.slice(0, 7)} "${clip(h.subject, 70)}" oleh ${clip(h.author, 30)}` }]);
    }
  }
}

let started = false;
export function startTunggu() {
  if (started) return;
  started = true;
  // waits survive a daemon restart for sessions that are still there
  for (const r of all(globalDb(), "SELECT key, value FROM kv WHERE key LIKE 'tunggu.%'")) {
    try {
      const w = JSON.parse(r.value);
      if (live.get(w.sid)?.status === 'ended' || !live.has(w.sid)) { run(globalDb(), 'DELETE FROM kv WHERE key = ?', r.key); continue; }
      waits.set(w.sid, { ...w, armed: false, pending: [], pendingAt: 0, timedOut: false });
      show(live.get(w.sid), waits.get(w.sid));
    } catch {}
  }
  bus.on('msg', m => { try { onMsg(m); } catch (e) { console.error(`tunggu: ${e.message}`); } });
  // any prompt that reaches an armed session (a message, the owner typing, an offer) already woke it
  bus.on('prompt', ev => { const w = waits.get(ev.sid); if (w?.armed) drop(ev.sid); });
  setInterval(() => { tick().catch(e => console.error(`tunggu: ${e.message}`)); }, 1000).unref();
  setInterval(() => { pollCommits().catch(() => {}); }, COMMIT_POLL_MS).unref();
}
