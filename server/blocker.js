// Agen yang tertahan di layar terminal (login Codex/Claude, percayai folder, "Press enter to continue"): layar pane
// dibaca seperlunya, hasilnya disimpan di s.blocker (ikut serialize → /api/state, /open, event WS 'session'),
// dan app HP menjawabnya lewat POST /api/sessions/:sid/blocker. Pembaca layar dan validasinya ada di blocker-screen.js.
//
// Kapan layar dibaca (murah): sesi tmux yang transkripnya kosong/belum ada, baru dibuat (< 2 menit), atau idle tanpa
// aktivitas transkrip > 20 detik, serta selama blocker masih tampil. Tiap sesi paling sering 5 detik (Mac ini) atau
// 12 detik (Mac lain), dan per mesin hanya satu capture-pane yang berjalan sekaligus (ssh memakai ControlMaster yang ada).
import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { live, bus, serialize, whoOf, logOffice } from './live.js';
import { bins } from './tmux.js';
import { who as actorName } from './actor.js';
import * as mx from './machines.js';
import { parseBlocker, runAction, sameBlocker, wantsScan, ACTIONS } from './blocker-screen.js';

export const LOCAL_MS = 5000, REMOTE_MS = 12000;
const TICK_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (msg, code = 409) => Object.assign(new Error(msg), { code });
export const machineOf = s => { const m = s.tmux ? mx.tmuxMachineOf(s.tmux) : s.machine; return m && mx.isRemote(m) ? m : mx.LOCAL; };
const machineName = id => mx.getMachine(id)?.name || id;

/** tmux di mesin sesi itu, async: { code, stdout, stderr }. */
export function tmuxAsync(machine, args, timeout = 5000) {
  if (machine !== mx.LOCAL) return mx.execAsync(machine, 'tmux', args, { timeout });
  const { tmux: t } = bins();
  if (!t) return Promise.resolve({ code: -1, stdout: '', stderr: 'tmux belum terpasang' });
  return new Promise(res => execFile(t, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
    res({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: String(stderr || '') })));
}
/** Layar terlihat pane sesi (bukan riwayat), atau null bila tak terbaca. */
async function screenOf(s) {
  const r = await tmuxAsync(machineOf(s), ['capture-pane', '-p', '-t', s.tmux]);
  return r.code === 0 ? r.stdout : null;
}
function transcriptStat(s) {
  if (!s.transcript) return null; // sesi Mac lain: s.transcript adalah salinan cermin lokal, jadi stat tetap murah
  try { const st = fs.statSync(s.transcript); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
}

/** Simpan blocker baru (at = saat pertama terlihat; expiresAt kode tetap selama kodenya sama) dan kabarkan bila berubah. */
export function setBlocker(s, b) {
  const old = s.blocker || null;
  if (sameBlocker(old, b)) return old;
  s.blocker = b ? { ...b, expiresAt: b.code && old?.code === b.code ? old.expiresAt : b.expiresAt, at: new Date().toISOString() } : null;
  if (b && b.kind === 'login' && old?.kind !== 'login') logOffice(s.office, whoOf(s), `tertahan di layar login (${b.engine === 'claude' ? 'Claude' : b.engine === 'codex' ? 'ChatGPT' : 'terminal'})`, 'session');
  bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
  return s.blocker;
}
const parseFor = (s, text) => parseBlocker(text, { engine: s.engine || 'claude', who: whoOf(s) });

const lastScan = new Map(); // sid → ms terakhir layar dibaca
export const busy = new Set(); // mesin yang sedang dibaca (dipakai bersama stream.js: satu capture-pane per mesin)
async function scan(s) {
  lastScan.set(s.sid, Date.now());
  const text = await screenOf(s);
  if (text == null || live.get(s.sid) !== s || s.status === 'ended') return; // tak terbaca: blocker lama dibiarkan
  setBlocker(s, parseFor(s, text));
}
function tick() {
  const now = Date.now();
  const due = new Map();
  for (const sid of lastScan.keys()) if (!live.has(sid)) lastScan.delete(sid);
  for (const s of live.values()) {
    if (s.blocker && (s.waiting || !s.tmux || s.status === 'ended')) { setBlocker(s, null); continue; }
    if (!wantsScan(s, { now, stat: transcriptStat(s) })) continue;
    const m = machineOf(s);
    if (m !== mx.LOCAL && (mx.isOffline(m) || mx.getMachine(m)?.disabled)) continue; // tanpa ssh yang bisa menggantung
    if (now - (lastScan.get(s.sid) || 0) < (m === mx.LOCAL ? LOCAL_MS : REMOTE_MS)) continue;
    if (!due.has(m)) due.set(m, []);
    due.get(m).push(s);
  }
  for (const [m, list] of due) {
    if (busy.has(m)) continue;
    busy.add(m);
    (async () => { for (const s of list) { try { await scan(s); } catch {} } })().finally(() => busy.delete(m));
  }
}
let timer = null;
export function startBlockerWatch() { if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.(); } }
/** App membuka chat sesi ini: baca layarnya di putaran berikutnya tanpa menunggu jedanya. */
export function kickBlocker(sid) { lastScan.delete(sid); }

/** GET callback login di mesin agen: lokal langsung, Mac lain lewat curl di sana (argumen dikutip, tanpa shell injection). */
function fetchOn(machine, url) {
  if (machine !== mx.LOCAL) {
    return mx.execAsync(machine, 'curl', ['-s', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', url], { timeout: 15000 })
      .then(r => ({ status: Number(String(r.stdout).trim()) || 0, ...(r.code ? { error: `curl ${r.code}` } : {}) }));
  }
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 10000 }, res => { res.resume(); resolve({ status: res.statusCode || 0 }); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
  });
}

/**
 * POST /api/sessions/:sid/blocker {action, value?}: layar dibaca ulang dulu (aksi dicocokkan dengan blocker saat ini,
 * bukan yang tersimpan), aksi dijalankan, lalu setelah jeda singkat layar dibaca lagi → { ok, blocker }.
 */
export async function blockerAction(sid, action, value) {
  const s = live.get(sid);
  if (!s || s.status === 'ended') throw fail('Sesi tidak ditemukan atau sudah selesai.', 404);
  if (!s.tmux) throw fail('Sesi ini tidak jalan di terminal kantor, jadi layarnya tidak bisa dijawab dari sini.');
  if (typeof action !== 'string' || !ACTIONS.includes(action)) throw fail('Aksi tidak dikenal.', 400);
  if (value != null && typeof value !== 'string') throw fail('value harus teks.', 400);
  const m = machineOf(s);
  if (m !== mx.LOCAL && (mx.isOffline(m) || mx.getMachine(m)?.disabled)) throw fail(`Mac ${machineName(m)} sedang offline.`);
  const io = {
    screen: async () => { const t = await screenOf(s); if (t == null) throw fail('Layar agen tidak terbaca. Coba lagi sebentar lagi.'); return t; },
    keys: async keys => { const r = await tmuxAsync(m, ['send-keys', '-t', s.tmux, ...keys]); if (r.code) throw fail('Tombol tidak terkirim ke terminal agen.'); },
    literal: async text => { const r = await tmuxAsync(m, ['send-keys', '-t', s.tmux, '-l', '--', text]); if (r.code) throw fail('Teks tidak terkirim ke terminal agen.'); },
    fetchAt: url => fetchOn(m, url),
    sleep,
  };
  setBlocker(s, parseFor(s, await io.screen()));
  const r = await runAction(s.blocker, action, value, io);
  const label = s.blocker?.actions.find(a => a.id === action)?.label || (action === 'callback' ? 'mengirim alamat login' : action === 'code' ? 'mengirim kode login' : action);
  logOffice(s.office, actorName(), `menjawab layar ${whoOf(s)}: ${label}`, 'session');
  await sleep(action === 'callback' ? 2000 : action === 'device' || action === 'browser' ? 2500 : 1200);
  const after = await screenOf(s);
  if (after != null) setBlocker(s, parseFor(s, after));
  lastScan.set(sid, Date.now());
  if (r.callback && !(r.callback.status >= 200 && r.callback.status < 400)) {
    throw fail(r.callback.status
      ? `Codex menolak alamat login (HTTP ${r.callback.status}). Mungkin login ini sudah kedaluwarsa: pilih "Pakai kode saja" atau buka lagi tautan login.`
      : `Codex di ${m === mx.LOCAL ? 'Mac ini' : `Mac ${machineName(m)}`} tidak menerima alamat login (${r.callback.error || 'tidak ada jawaban'}). Mungkin layar login sudah ditutup.`);
  }
  return { ok: true, blocker: s.blocker || null, ...(r.callback ? { callback: r.callback } : {}) };
}
