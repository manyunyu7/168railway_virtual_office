// "Streaming" jawaban agen ke chat app HP: selama chat sesi dibuka (POST /api/sessions/:sid/watch, berlaku 30 dtk) dan
// agennya sedang bekerja, layar pane tmux dibaca (capture-pane, read-only, tanpa tombol) tiap 350–400 ms di Mac ini atau
// ±1000 ms di Mac lain, teks jawaban yang sedang ditulis diambil (server/stream-screen.js), dan bila berubah dikirim
// sebagai event WS {t:'stream', office, sid, text, seq, at, partial?} (partial:true = awal jawaban tidak terlihat). Selesai (teks sama dengan pesan asisten terakhir di
// transkrip, layar tidak lagi menampilkan teks, atau sesi idle) → sekali {t:'stream', …, text:null, done:true}.
// Hanya sesi tmux engine claude dan codex. Per mesin hanya satu capture-pane sekaligus, dipakai bersama blocker.js.
import fs from 'node:fs';
import { live, bus } from './live.js';
import * as mx from './machines.js';
import { readTranscript } from './transcript.js';
import { busy, machineOf, tmuxAsync } from './blocker.js';
import { extractStream, lastAssistantText, sameAsTranscript, signature, norm } from './stream-screen.js';

// LOCAL_MS + TICK_MS = jarak baca terlama di Mac ini (350–400 ms); lastScan dicatat saat capture dimulai, jadi lama
// capture-pane tidak menambah jarak, dan kunci per mesin mencegah dua capture sekaligus untuk sesi yang sama.
export const WATCH_TTL_S = 30, LOCAL_MS = 350, REMOTE_MS = 1000, ACTIVE_MS = 15000;
export const HISTORY_LOCAL = 400, HISTORY_REMOTE = 150; // baris riwayat yang ikut dibaca (Claude Code memakai layar biasa)
export const TICK_MS = 50;
const ENGINES = ['claude', 'codex'];

/**
 * Inti streaming tanpa tmux/bus, supaya bisa dites:
 *   sessions: Map sid → sesi live; capture(s, machine) → Promise<teks capture-pane -e | null>;
 *   emit(event); lastText(s) → teks asisten terakhir sesudah prompt terakhir di transkrip | null;
 *   mtime(s) → mtimeMs transkrip | null; machine(s) → id mesin; offline(machine) → bool; busy: Set mesin yang sedang dibaca.
 */
export function createStreamer({ sessions, capture, emit, lastText = () => null, mtime = () => null, machine = () => mx.LOCAL,
  offline = () => false, busy: lock = new Set(), now = Date.now, local = mx.LOCAL } = {}) {
  const watched = new Map(); // sid → ms kedaluwarsa
  const state = new Map();   // sid → { text, seq, at, partial, lines, linesPartial, doneSig, shrink }
  const lastScan = new Map();
  const st = sid => { let x = state.get(sid); if (!x) state.set(sid, x = { text: null, seq: 0, at: null, partial: false, lines: null, linesPartial: false, doneSig: null, shrink: null }); return x; };
  // seq naik terus walau daemon restart: basis waktu (µs), minimal +1 dari yang terakhir
  const bump = x => { x.seq = Math.max(now() * 1000, x.seq + 1); x.at = new Date(now()).toISOString(); };

  function finish(s) {
    const x = state.get(s.sid);
    if (!x) return;
    x.lines = null; x.linesPartial = false; x.shrink = null;
    if (x.text == null) return;
    x.text = null; x.partial = false; bump(x);
    emit({ t: 'stream', office: s.office, sid: s.sid, text: null, seq: x.seq, at: x.at, done: true });
  }
  const eligible = s => !!s && !!s.tmux && s.status !== 'ended' && !s.placeholder && !s.blocker && ENGINES.includes(s.engine || 'claude');
  const active = s => {
    if (s.status === 'working' || s.compacting) return true;
    if (s.status === 'idle') return false;
    const m = mtime(s);
    return m != null && now() - m < ACTIVE_MS;
  };

  /** Satu layar hasil capture → event bila teksnya berubah. */
  function process(s, screen) {
    const x = st(s.sid);
    const ex = extractStream(screen, s.engine || 'claude', x.lines, x.linesPartial);
    if (!ex) { x.doneSig = null; return finish(s); }
    const text = ex.text, sig = signature(text);
    const keep = () => { x.lines = ex.lines; x.linesPartial = ex.partial; };
    if (x.doneSig && sig === x.doneSig) return keep(); // jawaban yang sudah selesai masih di layar
    if (sameAsTranscript(text, lastText(s))) { x.doneSig = sig; finish(s); return keep(); }
    if (text === x.text) return keep();
    // layar yang sedang digambar ulang bisa terbaca setengah jadi: teks yang menyusut dengan awal yang sama baru
    // dipercaya bila terbaca sama dua kali berturut-turut (baris yang terkumpul juga tidak diganti dulu)
    if (x.text && signature(x.text) === sig && norm(text).length < norm(x.text).length && x.shrink !== text) { x.shrink = text; return; }
    x.shrink = null; keep(); x.doneSig = null;
    x.text = text; x.partial = ex.partial; bump(x);
    emit({ t: 'stream', office: s.office, sid: s.sid, text, seq: x.seq, at: x.at, ...(ex.partial ? { partial: true } : {}) });
  }

  async function scan(s, m) {
    lastScan.set(s.sid, now());
    const screen = await capture(s, m);
    if (screen == null || sessions.get(s.sid) !== s || !watched.has(s.sid)) return;
    if (!eligible(s)) return finish(s);
    process(s, screen);
  }

  function tick() {
    const t = now();
    for (const sid of state.keys()) if (!sessions.has(sid) && !watched.has(sid)) state.delete(sid);
    for (const sid of lastScan.keys()) if (!watched.has(sid)) lastScan.delete(sid);
    const due = new Map();
    for (const [sid, exp] of watched) {
      const s = sessions.get(sid);
      if (exp <= t) { watched.delete(sid); if (s) finish(s); continue; }
      if (!eligible(s) || !active(s)) { if (s) finish(s); continue; }
      const m = machine(s);
      if (m !== local && offline(m)) continue;
      if (t - (lastScan.get(sid) || 0) < (m === local ? LOCAL_MS : REMOTE_MS)) continue;
      if (!due.has(m)) due.set(m, []);
      due.get(m).push(s);
    }
    const runs = [];
    for (const [m, list] of due) {
      if (lock.has(m)) continue; // mesin ini sedang dibaca (stream atau blocker): putaran berikutnya
      lock.add(m);
      runs.push((async () => { for (const s of list) { try { await scan(s, m); } catch {} } })().finally(() => lock.delete(m)));
    }
    return Promise.all(runs);
  }

  return {
    tick, process, finish,
    /** App membuka chat sesi ini (diulang ±20 dtk). */
    watch(sid) { watched.set(sid, now() + WATCH_TTL_S * 1000); lastScan.delete(sid); return { ok: true, ttl: WATCH_TTL_S }; },
    isWatched: sid => (watched.get(sid) || 0) > now(),
    /** Keadaan terakhir untuk app yang baru membuka chat. */
    get(sid) { const x = state.get(sid); return x ? { text: x.text, seq: x.seq, at: x.at, partial: x.text != null && x.partial } : { text: null, seq: 0, at: null, partial: false }; },
    /** Transkrip bertambah: baca layar lagi secepatnya (pesan yang selesai menutup stream). */
    kick(sid) { if (state.get(sid)?.text != null) lastScan.delete(sid); },
  };
}

/* ---------------- kabel ke daemon ---------------- */
function transcriptLast(s) {
  if (!s.transcript) return null;
  try { return lastAssistantText(readTranscript(s.transcript, 40).items); } catch { return null; }
}
function transcriptMtime(s) {
  if (!s.transcript) return null;
  try { return fs.statSync(s.transcript).mtimeMs; } catch { return null; }
}
async function capturePane(s, m) {
  const r = await tmuxAsync(m, ['capture-pane', '-p', '-J', '-e', '-S', `-${m === mx.LOCAL ? HISTORY_LOCAL : HISTORY_REMOTE}`, '-t', s.tmux], 4000);
  return r.code === 0 ? r.stdout : null;
}

export const streamer = createStreamer({
  sessions: live, capture: capturePane, emit: ev => bus.emit('msg', ev), lastText: transcriptLast, mtime: transcriptMtime,
  machine: machineOf, offline: m => mx.isOffline(m) || !!mx.getMachine(m)?.disabled, busy,
});
export const watchStream = sid => streamer.watch(sid);
export const streamState = sid => streamer.get(sid);

let timer = null;
export function startStreamWatch() {
  if (timer) return;
  timer = setInterval(() => { streamer.tick().catch(() => {}); }, TICK_MS); timer.unref?.();
  bus.on('msg', m => { if (m?.t === 'transcript' && m.sid) streamer.kick(m.sid); });
}
