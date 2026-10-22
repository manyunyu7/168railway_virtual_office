// Direct messages between agents (Claude and Codex alike): pesan_ke, kabari, siaran, tanya, balas, pesan_list.
// A message is stored first (office db, table dm). It reaches the recipient two ways: as a short reminder appended to the
// result of the next kantor tool the recipient calls (or a PostToolUse/UserPromptSubmit hook), so it arrives mid-turn; or typed
// into its tmux session once that is idle. A message shown as a reminder is marked read and never typed afterwards.
// kind: pesan | tanya | balasan | fyi (no reply wanted, never wakes an idle session on its own)
// status: menunggu (stored, not shown yet) -> terkirim (typed in) -> dibaca (shown / the session received the prompt) -> dibalas
import { officeDb, all, one, run, nowIso, newId } from './db.js';
import { bus, live, logOffice, setHookContext } from './live.js';
import * as st from './store.js';
import { config } from './config.js';
import { sessionAction, startShift } from './tmux.js';

const MAX_TEXT = 4000;
export const ASK_DEFAULT_SEC = 300;
export const ASK_MAX_SEC = 900;

let sender = (sid, text) => sessionAction(sid, 'text', text);
/** Tests replace the way text reaches a session. */
export function setSender(fn) { sender = fn; }

const turnStart = new Map(); // office:role -> ISO time of the role's latest prompt (a "turn" for dm.maxPerTurn)
const waiters = new Map(); // id of a tanya -> resolve(reply row)
const delivering = new Set(); // office:role while a delivery is in flight

const db = office => officeDb(office);
const get = (office, id) => one(db(office), 'SELECT * FROM dm WHERE id = ?', id);
const pairKey = (a, b) => [a, b].sort().join('|');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const OWNER = 'pemilik'; // from_role of messages the owner sends from the office (pratinjau decisions)
function nameOf(office, roleId) {
  if (roleId === OWNER) return { id: OWNER, name: 'Pemilik', title: '' };
  const r = st.getRole(office, roleId);
  return r ? { id: r.id, name: r.name, title: r.title || '' } : { id: roleId, name: roleId, title: '' };
}

export function view(office, r) {
  if (!r) return null;
  const a = nameOf(office, r.from_role), b = nameOf(office, r.to_role);
  return { id: r.id, from: r.from_role, to: r.to_role, fromName: a.name, toName: b.name, kind: r.kind, text: r.text, card: r.card || null, replyTo: r.reply_to || null,
    group: r.grp || null, status: r.status, at: r.at, sentAt: r.sent_at || null, readAt: r.read_at || null, repliedAt: r.replied_at || null };
}
const emit = (office, r, extra = {}) => { const item = view(office, r); bus.emit('msg', { t: 'dm', office, from: r.from_role, to: r.to_role, kind: r.kind, status: r.status, item, ...extra }); return item; };

/** Role by id, then name (any case), then first name; "manager" = the manager role. */
export function resolveRole(office, ref) {
  const q = String(ref ?? '').trim().toLowerCase();
  const roles = st.listRoles(office);
  const list = () => roles.map(r => `${r.id} (${r.name})`).join(', ');
  if (!q) throw new Error(`Isi "ke" dengan id/nama role atau "manager". Role: ${list()}.`);
  const hit = (q === 'manager' || q === 'manajer') ? roles.find(r => r.isMgr)
    : roles.find(r => r.id.toLowerCase() === q) || roles.find(r => r.name.toLowerCase() === q) || roles.find(r => r.name.toLowerCase().split(/\s+/)[0] === q);
  if (!hit) throw new Error(`Role "${ref}" tidak ada di kantor ini. Role: ${list()}.`);
  return hit;
}

function checkRate(office, a, b, { reply = false } = {}) {
  const { maxPerPair = 20, windowMin = 10 } = config().dm || {};
  const since = new Date(Date.now() - windowMin * 60000).toISOString();
  const pair = one(db(office), 'SELECT COUNT(*) n FROM dm WHERE ((from_role = ? AND to_role = ?) OR (from_role = ? AND to_role = ?)) AND at > ?', a, b, b, a, since).n;
  if (!reply && pair >= maxPerPair) throw new Error(`Terlalu banyak pesan antara kamu dan ${nameOf(office, b).name} (${pair} dalam ${windowMin} menit, batas ${maxPerPair}). Tunggu sebentar, atau selesaikan dengan komentar di kartu.`);
  const mine = one(db(office), 'SELECT COUNT(*) n FROM dm WHERE from_role = ? AND at > ?', a, since).n;
  if (!reply && mine >= maxPerPair * 3) throw new Error(`Kamu sudah mengirim ${mine} pesan dalam ${windowMin} menit. Tunggu sebentar.`);
}

/** The tmux session that can take typed text for a role (a Terminal or VS Code session cannot). */
function recipient(office, roleId) {
  const rows = [...live.values()].filter(s => s.office === office && s.role === roleId && s.tmux && s.status !== 'ended' && s.kind !== 'rapat');
  rows.sort((a, b) => (a.slot || 0) - (b.slot || 0));
  return rows.find(s => s.status === 'idle') || rows[0] || null;
}

function format(office, r) {
  const f = nameOf(office, r.from_role);
  const who = `${f.name}${f.title ? ` (${f.title})` : ''}`;
  const card = r.card ? ` (kartu ${r.card})` : '';
  const text = String(r.text).trim();
  if (r.kind === 'fyi') return `[FYI dari ${who} · id ${r.id}] ${text}${card} (Informasi saja, tidak perlu dibalas.)`;
  if (r.kind === 'balasan') return `[Balasan dari ${who} untuk pesanmu ${r.reply_to}] ${text}${card} (Tidak perlu dibalas lagi kecuali ada yang kurang.)`;
  if (r.kind === 'tanya') return `[Pertanyaan dari ${who} · id ${r.id}] ${text}${card} ${f.name} menunggu jawabanmu. Jawab dengan tool kantor balas(id="${r.id}", teks="..."). Jangan menjawab lewat chat biasa.`;
  return `[Pesan dari ${who} · id ${r.id}] ${text}${card} Balas dengan tool kantor balas(id="${r.id}") kalau perlu.`;
}

/** Type every waiting message for a role into its session when that session is idle. Returns how many went in. */
export async function deliver(office, roleId) {
  const lock = `${office}:${roleId}`;
  if (delivering.has(lock)) return 0;
  const pend = all(db(office), "SELECT * FROM dm WHERE to_role = ? AND status = 'menunggu' ORDER BY at, rowid", roleId);
  // fyi alone never wakes a session; it rides along when something else is typed, or shows up as a reminder
  if (!pend.some(r => r.kind !== 'fyi')) return 0;
  const s = recipient(office, roleId);
  if (!s || s.status !== 'idle') return 0;
  delivering.add(lock);
  const at = nowIso();
  try {
    for (const r of pend) run(db(office), "UPDATE dm SET status = 'terkirim', sent_at = ? WHERE id = ? AND status = 'menunggu'", at, r.id);
    const body = pend.map(r => format(office, r)).join('\n');
    try { await sender(s.sid, pend.length > 1 ? `📨 ${pend.length} pesan masuk:\n${body}` : body); }
    catch {
      for (const r of pend) run(db(office), "UPDATE dm SET status = 'menunggu', sent_at = NULL WHERE id = ? AND status = 'terkirim'", r.id);
      return 0;
    }
    for (const r of pend) emit(office, get(office, r.id));
    return pend.length;
  } finally { delivering.delete(lock); }
}

const SNIPPET = 280, MAX_SHOWN = 5;
/**
 * Mid-turn delivery. A short block listing the messages waiting for a role, to append to a kantor tool result (agent.js) or
 * to hand back from a PostToolUse/UserPromptSubmit hook (live.js). What it lists counts as read: it is never typed afterwards.
 * Returns null when nothing waits.
 */
export function reminder(office, roleId) {
  if (!office || !roleId || config().dm?.midTurn === false) return null;
  const pend = all(db(office), "SELECT * FROM dm WHERE to_role = ? AND status = 'menunggu' ORDER BY at, rowid LIMIT ?", roleId, MAX_SHOWN + 1);
  if (!pend.length) return null;
  const show = pend.slice(0, MAX_SHOWN), more = pend.length - show.length, now = nowIso();
  const lines = show.map(r => {
    run(db(office), "UPDATE dm SET status = 'dibaca', seen_at = ?, read_at = ? WHERE id = ? AND status = 'menunggu'", now, now, r.id);
    emit(office, get(office, r.id));
    const f = nameOf(office, r.from_role).name, cut = String(r.text).trim().replace(/\s+/g, ' ');
    const tail = cut.length > SNIPPET ? ' (dipotong; isi lengkap di pesan_list)' : '';
    const how = r.kind === 'tanya' ? `tanya, id ${r.id}; ${f} menunggu jawabanmu: balas(id="${r.id}", teks="...")`
      : r.kind === 'balasan' ? `balasan untuk pesanmu ${r.reply_to}, tidak perlu dibalas lagi`
      : r.kind === 'fyi' ? `fyi, id ${r.id}, tidak perlu dibalas`
      : `pesan, id ${r.id}; balas(id="${r.id}", teks="...") kalau perlu`;
    return `- dari ${f} (${how}): "${clip(cut, SNIPPET)}"${tail}`;
  });
  const n = show.length;
  return `📨 ${n} pesan menunggu${more ? ` (+${more} lagi, lihat pesan_list)` : ''}, sudah ditandai terbaca dan tidak diketik lagi ke sesimu:\n${lines.join('\n')}\nBaca semuanya dengan pesan_list. Pertanyaan (tanya) ditunggu pengirimnya: jawab dulu dengan balas, lalu lanjutkan kerjamu.`;
}

/** The prompt the session received contains the message id: it was read. */
function promptSeen(sid, prompt) {
  const s = live.get(sid);
  if (!s?.office || !s.role) return;
  const rows = all(db(s.office), "SELECT * FROM dm WHERE to_role = ? AND status = 'terkirim'", s.role);
  for (const r of rows) {
    const mark = r.kind === 'balasan' ? `untuk pesanmu ${r.reply_to}]` : `id ${r.id}]`;
    if (!String(prompt).includes(mark)) continue;
    run(db(s.office), "UPDATE dm SET status = 'dibaca', read_at = ? WHERE id = ? AND status = 'terkirim'", nowIso(), r.id);
    emit(s.office, get(s.office, r.id));
  }
}

function create(office, { from, to, kind, text, card, replyTo, grp }) {
  const id = newId('m');
  run(db(office), 'INSERT INTO dm (id, from_role, to_role, kind, text, card, reply_to, status, at, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, from, to, kind, text, card || null, replyTo || null, 'menunggu', nowIso(), grp || null);
  const r = get(office, id);
  const verb = kind === 'tanya' ? 'bertanya kepada' : kind === 'balasan' ? 'membalas' : kind === 'fyi' ? 'mengabari' : 'mengirim pesan ke';
  logOffice(office, nameOf(office, from).name, `${verb} ${nameOf(office, to).name}: ${clip(text, 90)}`, 'dm');
  emit(office, r);
  return r;
}

const WORKING_NOTE = 'penerima sedang bekerja; pesan muncul sebagai pengingat di hasil tool kantor berikutnya yang dia panggil, atau diketik begitu dia idle';
async function dispatch(office, r) {
  const to = r.to_role;
  if (r.kind === 'fyi') return { item: view(office, get(office, r.id)), pengiriman: 'FYI tersimpan: muncul sebagai pengingat di hasil tool penerima, atau ikut diketik bersama pesan lain; tidak membangunkan penerima dan tidak perlu dibalas' };
  await deliver(office, to);
  const cur = get(office, r.id);
  if (cur.status !== 'menunggu') return { item: view(office, cur), pengiriman: 'sudah diketik ke sesi penerima' };
  const s = recipient(office, to);
  if (s) return { item: view(office, cur), pengiriman: WORKING_NOTE };
  if (config().dm?.autoStart) {
    try {
      const sh = startShift(office, to, { task: format(office, cur) });
      run(db(office), "UPDATE dm SET status = 'terkirim', sent_at = ? WHERE id = ?", nowIso(), r.id);
      return { item: emit(office, get(office, r.id)), pengiriman: `shift ${nameOf(office, to).name} dimulai (tmux ${sh.tmux}) dengan pesan ini sebagai tugas pertama` };
    } catch (e) { return { item: view(office, cur), pengiriman: `penerima belum shift dan shift otomatis gagal: ${e.message}. Pesan tersimpan.` }; }
  }
  return { item: view(office, cur), pengiriman: `${nameOf(office, to).name} belum shift. Pesan tersimpan dan masuk begitu dia mulai; manager bisa memulainya dengan shift_start.` };
}

function clean(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Isi pesan kosong. Isi "teks" dengan satu-dua kalimat yang bisa dipahami penerima tanpa melihat percakapanmu (apa yang terjadi, apa yang kamu butuhkan, kartu terkait).');
  if (t.length > MAX_TEXT) throw new Error(`Pesan terlalu panjang (maks ${MAX_TEXT} karakter). Taruh yang panjang di wiki atau kartu, lalu tautkan.`);
  return t;
}
function me(role) {
  if (!role) throw new Error('Sesi ini tidak terikat ke role, jadi tidak bisa berkirim pesan ke agen lain.');
  return role;
}
/** A manager may send only so many outgoing messages per turn (dm.maxPerTurn): coordination goes through cards and siaran instead. */
function checkTurn(office, role) {
  const max = config().dm?.maxPerTurn ?? 8;
  if (!role.isMgr || !max) return;
  const since = turnStart.get(`${office}:${role.id}`);
  if (!since) return;
  const n = one(db(office), "SELECT COUNT(DISTINCT COALESCE(grp, id)) n FROM dm WHERE from_role = ? AND kind != 'balasan' AND at >= ?", role.id, since).n;
  if (n >= max) throw new Error(`Sudah ${n} pesan keluar di giliran ini (batas ${max} untuk manager). Gabungkan lewat siaran(ke:[...], teks), catat keputusan di kartu atau wiki, lalu selesaikan giliran; yang lain akan membaca dari sana.`);
}
function cardOf(office, id) {
  if (!id) return null;
  let card = null;
  try { card = st.getCard(office, id)?.id || null; } catch {}
  if (!card) throw new Error(`Kartu ${id} tidak ditemukan.`);
  return card;
}
function prepare(office, role, a) {
  const from = me(role);
  const to = resolveRole(office, a.ke);
  if (to.id === from.id) throw new Error('Tidak bisa mengirim pesan ke diri sendiri.');
  const text = clean(a.teks);
  const card = cardOf(office, a.kartu);
  checkRate(office, from.id, to.id);
  checkTurn(office, from);
  return { from: from.id, to: to.id, text, card };
}

export async function pesanKe(office, role, a) {
  const p = prepare(office, role, a);
  const r = create(office, { ...p, kind: a.fyi ? 'fyi' : 'pesan' });
  const d = await dispatch(office, r);
  return { id: r.id, ke: nameOf(office, p.to).name, status: d.item.status, pengiriman: d.pengiriman };
}

/** A message from the owner (not an agent) to a role, e.g. a pratinjau decision. kind 'pesan' so it wakes an idle session. No rate limit. */
export async function fromOwner(office, toRole, text, { card } = {}) {
  const to = resolveRole(office, toRole);
  const r = create(office, { from: OWNER, to: to.id, kind: 'pesan', text: clean(text).slice(0, MAX_TEXT), card: card || null });
  const d = await dispatch(office, r);
  return { id: r.id, ke: to.name, status: d.item.status, pengiriman: d.pengiriman };
}

export const kabari = (office, role, a) => pesanKe(office, role, { ...a, fyi: true });

/** One message to several roles: ke = [role, ...] or "semua". Each recipient gets its own row (grp ties them together). */
export async function siaran(office, role, a) {
  const from = me(role);
  const text = clean(a.teks);
  const card = cardOf(office, a.kartu);
  let refs = a.ke;
  if (typeof refs === 'string' && refs.trim().toLowerCase() !== 'semua') refs = refs.split(/[,;]/);
  const targets = new Map();
  if (typeof refs === 'string') for (const r of st.listRoles(office)) targets.set(r.id, r);
  else if (Array.isArray(refs) && refs.length) for (const ref of refs) { const r = resolveRole(office, ref); targets.set(r.id, r); }
  else throw new Error('Isi "ke" dengan daftar role (id/nama) atau "semua". Contoh: ke:["bayu","sinta"].');
  targets.delete(from.id);
  if (!targets.size) throw new Error('Tidak ada penerima selain dirimu.');
  checkTurn(office, from);
  const grp = newId('g'), kind = a.fyi ? 'fyi' : 'pesan', sent = [], skipped = [];
  for (const t of targets.values()) {
    try { checkRate(office, from.id, t.id); } catch (e) { skipped.push({ ke: t.name, alasan: e.message }); continue; }
    const r = create(office, { from: from.id, to: t.id, kind, text, card, grp });
    await dispatch(office, r);
    sent.push({ id: r.id, ke: t.name, status: get(office, r.id).status });
  }
  if (!sent.length) throw new Error(`Siaran tidak terkirim: ${skipped.map(x => x.alasan).join(' ')}`);
  return { siaran: grp, jenis: kind, terkirim: sent, dilewati: skipped.length ? skipped : undefined,
    pengiriman: kind === 'fyi' ? 'FYI: tidak membangunkan siapa pun dan tidak perlu dibalas' : 'tiap penerima menerimanya sebagai pengingat di tengah kerja, atau diketik begitu idle; mereka bisa membalas lewat balas(id)' };
}

export async function tanya(office, role, a) {
  const p = prepare(office, role, a);
  const sec = Math.min(ASK_MAX_SEC, Math.max(5, Number(a.timeout_detik) || ASK_DEFAULT_SEC));
  const r = create(office, { ...p, kind: 'tanya' });
  const reply = new Promise(resolve => waiters.set(r.id, resolve));
  let d;
  try { d = await dispatch(office, r); } catch (e) { waiters.delete(r.id); throw e; }
  const timer = setTimeout(() => { const w = waiters.get(r.id); if (w) { waiters.delete(r.id); w(null); } }, sec * 1000);
  const got = await reply;
  clearTimeout(timer);
  const to = nameOf(office, p.to).name;
  if (got) return { status: 'dibalas', id: r.id, dari: to, balasan: got.text };
  return { status: 'belum dibalas', id: r.id, ke: to, pengiriman: d.pengiriman, catatan: `Tidak ada balasan dalam ${sec} detik. Pertanyaan tetap tersimpan; kalau ${to} membalas nanti, jawabannya masuk ke sesimu sebagai pesan.` };
}

export async function balas(office, role, a) {
  const from = me(role);
  const q = get(office, String(a.id || '').trim());
  const waitingList = () => {
    const rows = all(db(office), "SELECT * FROM dm WHERE to_role = ? AND kind IN ('pesan','tanya') AND status != 'dibalas' ORDER BY at DESC LIMIT 10", from.id);
    return rows.length ? ` Yang menunggu balasanmu: ${rows.map(r => `${r.id} (dari ${nameOf(office, r.from_role).name}: "${clip(r.text, 40)}")`).join('; ')}.` : ' Tidak ada pesan yang menunggu balasanmu.';
  };
  if (!q) throw new Error(`Pesan "${a.id}" tidak ditemukan.${waitingList()}`);
  if (q.to_role !== from.id) throw new Error(`Pesan ${q.id} bukan ditujukan kepadamu, jadi tidak bisa kamu balas.${waitingList()}`);
  if (q.kind === 'balasan') throw new Error(`Itu sudah berupa balasan, tidak perlu dibalas lagi. Kalau ada hal baru, kirim dengan pesan_ke.${waitingList()}`);
  if (q.kind === 'fyi') throw new Error(`Itu FYI (informasi saja), tidak menunggu balasan. Kalau memang perlu menanggapi, kirim dengan pesan_ke ke ${nameOf(office, q.from_role).name}.${waitingList()}`);
  if (q.status === 'dibalas') { // double reply: friendly, return the first one
    const first = one(db(office), "SELECT * FROM dm WHERE kind = 'balasan' AND reply_to = ? ORDER BY at LIMIT 1", q.id);
    return { id: first?.id || null, status: first?.status || 'dibalas', sudah_dibalas: true, balasan_pertama: first?.text || undefined, pengiriman: 'pesan itu sudah kamu balas sebelumnya; balasan pertamamu yang dipakai, tidak ada pesan baru. Kalau ada tambahan, kirim dengan pesan_ke.' };
  }
  const text = clean(a.teks);
  checkRate(office, from.id, q.from_role, { reply: true });
  const r = create(office, { from: from.id, to: q.from_role, kind: 'balasan', text, replyTo: q.id });
  run(db(office), "UPDATE dm SET status = 'dibalas', replied_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?", nowIso(), nowIso(), q.id);
  emit(office, get(office, q.id));
  const w = waiters.get(q.id);
  if (w) { // the asker is still waiting inside tanya: the answer goes back as its tool result, not typed into the session
    waiters.delete(q.id);
    run(db(office), "UPDATE dm SET status = 'dibaca', sent_at = ?, read_at = ? WHERE id = ?", nowIso(), nowIso(), r.id);
    emit(office, get(office, r.id));
    w(get(office, r.id));
    return { id: r.id, status: 'dibaca', pengiriman: 'jawabanmu sudah diterima peminta yang sedang menunggu' };
  }
  const d = await dispatch(office, r);
  return { id: r.id, status: d.item.status, pengiriman: d.pengiriman };
}

export function pesanList(office, role, a = {}) {
  const meId = me(role).id;
  const rows = all(db(office), 'SELECT * FROM dm WHERE to_role = ? OR from_role = ? ORDER BY at DESC, rowid DESC LIMIT 60', meId, meId).reverse();
  // reading them here counts as reading: whatever was still waiting is not typed into the session afterwards
  const now = nowIso();
  for (const r of rows) if (r.to_role === meId && (r.status === 'menunggu' || r.status === 'terkirim')) {
    run(db(office), "UPDATE dm SET status = 'dibaca', read_at = ? WHERE id = ?", now, r.id);
    r.status = 'dibaca'; r.read_at = now; r._new = true;
    emit(office, get(office, r.id));
  }
  let out = rows.map(r => ({ id: r.id, arah: r.to_role === meId ? 'masuk' : 'keluar', dengan: nameOf(office, r.to_role === meId ? r.from_role : r.to_role).name, jenis: r.kind, isi: r.text, kartu: r.card || undefined,
    balasan_untuk: r.reply_to || undefined, status: r.status, waktu: r.at, perlu_dibalas: r.to_role === meId && r.kind !== 'balasan' && r.kind !== 'fyi' && r.status !== 'dibalas' ? true : undefined, baru: r._new || undefined }));
  if (a.belum_dibaca) out = out.filter(x => x.baru || x.perlu_dibalas);
  return out.length ? out : 'Kotak pesan kosong.';
}

/** Conversations in an office, newest first. role limits to those a role takes part in. */
export function threads(office, { role = null } = {}) {
  const rows = all(db(office), 'SELECT * FROM dm ORDER BY at DESC, rowid DESC LIMIT 2000');
  const map = new Map();
  for (const r of rows) {
    if (role && r.from_role !== role && r.to_role !== role) continue;
    const key = pairKey(r.from_role, r.to_role);
    let t = map.get(key);
    if (!t) { const [a, b] = key.split('|'); t = { key, a: nameOf(office, a), b: nameOf(office, b), count: 0, pending: 0, last: view(office, r) }; map.set(key, t); }
    t.count++;
    if (r.status === 'menunggu') t.pending++;
  }
  return { threads: [...map.values()] };
}

export function thread(office, a, b, limit = 200) {
  const rows = all(db(office), 'SELECT * FROM dm WHERE (from_role = ? AND to_role = ?) OR (from_role = ? AND to_role = ?) ORDER BY at DESC, rowid DESC LIMIT ?', a, b, b, a, limit).reverse();
  return { key: pairKey(a, b), a: nameOf(office, a), b: nameOf(office, b), items: rows.map(r => view(office, r)) };
}

export function itemsOfCard(office, card) { return all(db(office), 'SELECT * FROM dm WHERE card = ? ORDER BY at', card).map(r => view(office, r)); }

let started = false;
export function startDm() {
  if (started) return;
  started = true;
  bus.on('prompt', ev => {
    try {
      promptSeen(ev.sid, ev.prompt);
      const s = live.get(ev.sid);
      if (s?.office && s.role) turnStart.set(`${s.office}:${s.role}`, nowIso());
    } catch (e) { console.error(`dm: ${e.message}`); }
  });
  setHookContext((s, ev) => (ev === 'PostToolUse' || ev === 'UserPromptSubmit') && s.office && s.role ? reminder(s.office, s.role) : null);
  bus.on('msg', m => {
    if (m.t !== 'session' || m.session?.status !== 'idle' || !m.session.role) return;
    deliver(m.session.office, m.session.role).catch(() => {});
  });
  setInterval(() => {
    for (const s of live.values()) if (s.role && s.status === 'idle') deliver(s.office, s.role).catch(() => {});
  }, 20e3).unref();
}
