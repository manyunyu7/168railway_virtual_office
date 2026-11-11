// Cermin transkrip dari mesin lain (docs/MULTI-PC.md, "Cermin transkrip").
// Transkrip Claude (~/.claude/projects/...) dan rollout Codex (~/.codex/sessions/...) di Mac 2 disalin byte demi byte
// ke DATA_DIR/mirror/<mesin>/<path asli>. s.transcript menunjuk ke salinan itu, jadi semua pembaca transkrip lokal
// (chat, kesehatan, konteks, payroll) jalan tanpa diubah.
//
// - mirrorTranscript(): sinkron. Mendaftarkan file, membuat salinan lokal (kosong dulu), menarik sekali, lalu
//   mengembalikan path lokal. Tarikan pertama dibatasi; sisanya dilanjutkan poller.
// - Poller: per mesin satu panggilan ssh yang men-stat semua file yang jatuh tempo, lalu hanya byte tambahan yang
//   ditarik (tail -c +N) dan di-append ke salinan. File yang baru berubah dicek tiap ≈1 s, yang diam mundur sampai
//   beberapa detik. Mesin offline dilewati. File remote mengecil → salinan dibuat ulang (inode baru, jadi pembaca
//   inkremental seperti jsonl.scanAppended mulai dari awal).
// - Pendaftaran tidak disimpan; saat daemon mulai, startMirror() memanggil rearmFromDb() untuk sesi remote yang belum berakhir.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECTS_DIR } from './config.js';
import { globalDb, all } from './db.js';
import * as mx from './machines.js';

const TICK_MS = 250;
const FAST_MS = 1000;          // interval file yang baru berubah
const SLOW_MS = 5000;          // batas mundur saat diam
const MISSING_MS = 15000;      // file remote (belum) ada
const INITIAL_MAX = 4 << 20;   // tarikan sinkron pertama
const PULL_MAX = 2 << 20;      // satu tarikan poller
const MAX_PARALLEL = 4;        // panggilan ssh bersamaan (semua mesin)
const STAT_BATCH = 200;        // file per skrip stat
const PRUNE_EVERY = 60e3;
const IDLE_DROP_MS = 10 * 60e3; // file tanpa sesi hidup dan diam selama ini dilepas

const files = new Map(); // path lokal → entri

/** Root folder cermin. */
export const MIRROR_DIR = path.join(DATA_DIR, 'mirror');

const usable = id => { const m = mx.getMachine(id); return !!m && !m.disabled; };
const localSize = f => { try { return fs.statSync(f).size; } catch { return -1; } };
function ensureLocal(f) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); } catch {}
  if (localSize(f) < 0) try { fs.closeSync(fs.openSync(f, 'a', 0o600)); } catch {}
}

function entryFor(machine, remote) {
  const local = mx.mirrorPath(machine, remote);
  let e = files.get(local);
  if (!e) {
    e = { machine, remote: path.resolve('/', String(remote)), local, remoteSize: null, mtime: 0, interval: FAST_MS, nextAt: 0, changedAt: Date.now(), busy: false, missing: false, gen: 0 };
    files.set(local, e);
  }
  e.touchedAt = Date.now();
  return e;
}

/** Tulis `buf` sebagai isi baru salinan (file baru lalu rename, supaya pembaca melihat inode baru). */
function recreate(e, buf) {
  const tmp = `${e.local}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, e.local);
  e.gen++;
}

/**
 * Bandingkan hasil stat remote dengan salinan: null bila tidak ada yang perlu ditarik, atau { offset, fresh }
 * (fresh = salinan dibuat ulang dari byte 0). size < 0 berarti file remote tidak ada.
 */
function plan(e, size, mtime) {
  if (size < 0) { e.missing = true; return null; }
  e.missing = false;
  const have = localSize(e.local);
  const changed = size !== e.remoteSize || mtime !== e.mtime;
  e.remoteSize = size; e.mtime = mtime;
  if (changed) e.changedAt = Date.now();
  if (have < 0) return { offset: 0, fresh: true };
  if (size < have) return { offset: 0, fresh: true };      // remote mengecil: buat ulang
  if (size === have) return null;
  return { offset: have, fresh: false };
}
/** Tulis hasil tarikan ke salinan; jumlah byte yang ditambahkan. */
function apply(e, p, buf) {
  if (!buf?.length && !p.fresh) return 0;
  if (p.fresh) { recreate(e, buf || Buffer.alloc(0)); return buf?.length || 0; }
  if (localSize(e.local) !== p.offset) return 0; // ada penulis lain di antara (tarikan sinkron); poller mencoba lagi
  fs.appendFileSync(e.local, buf);
  return buf.length;
}
function schedule(e, grew) {
  const now = Date.now();
  if (e.missing) e.interval = MISSING_MS;
  else if (grew) e.interval = FAST_MS;
  else e.interval = Math.min(SLOW_MS, Math.round(Math.max(FAST_MS, e.interval) * 1.5));
  const more = grew && e.remoteSize != null && localSize(e.local) < e.remoteSize; // file besar: lanjut putaran berikutnya
  e.nextAt = more ? now : now + e.interval;
}

function pullSync(e) {
  if (!usable(e.machine) || mx.isOffline(e.machine)) return 0;
  const st = mx.statFile(e.machine, e.remote);
  const p = plan(e, st ? st.size : -1, st ? Math.floor(st.mtimeMs / 1000) : 0);
  let n = 0;
  if (p) {
    const want = Math.min(INITIAL_MAX, e.remoteSize - p.offset);
    try { n = apply(e, p, want > 0 ? mx.readFrom(e.machine, e.remote, p.offset, want) : Buffer.alloc(0)); } catch {}
  }
  schedule(e, n > 0);
  return n;
}

/**
 * Daftarkan file `remoteFile` di mesin `machine` untuk dicerminkan dan kembalikan path salinan lokalnya.
 * Sinkron: salinan langsung ada (mungkin masih kosong) dan sudah ditarik sekali bila mesin online.
 * Mesin lokal (null/'local'/tak dikenal) → path aslinya dikembalikan apa adanya.
 */
export function mirrorTranscript(machine, remoteFile) {
  if (!remoteFile) return remoteFile;
  if (!mx.isRemote(machine)) return remoteFile;
  const known = files.has(mx.mirrorPath(machine, remoteFile));
  const e = entryFor(machine, remoteFile);
  ensureLocal(e.local);
  if (known) { e.nextAt = 0; return e.local; } // sudah dicerminkan: cukup percepat poller
  try { pullSync(e); } catch {}
  return e.local;
}

/** Seperti mirrorTranscript tapi tanpa tarikan sinkron (dipakai di jalur panas, mis. token subagent). */
export function mirrorLater(machine, remoteFile) {
  if (!remoteFile || !mx.isRemote(machine)) return remoteFile;
  const e = entryFor(machine, remoteFile);
  ensureLocal(e.local);
  return e.local;
}

/** Lepas pendaftaran (salinan lokal dibiarkan). */
export function forgetMirror(localPath) { return files.delete(localPath); }

/** Daftar pendaftaran (untuk debug dan tes). */
export const mirrorEntries = () => [...files.values()].map(e => ({ machine: e.machine, remote: e.remote, local: e.local, remoteSize: e.remoteSize, interval: e.interval, missing: e.missing }));

/* ---------------- poller ---------------- */
let active = 0;
const waiters = [];
async function slot(fn) {
  if (active >= MAX_PARALLEL) await new Promise(r => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

const STAT_FN = `if stat -f %z / >/dev/null 2>&1; then s() { stat -f '%z %m' "$1" 2>/dev/null; }; else s() { stat -c '%s %Y' "$1" 2>/dev/null; }; fi`;
/** Satu skrip shell yang mencetak "<i> <ukuran> <mtime>" untuk setiap file (-1 bila tidak ada). */
export const statScript = list => `${STAT_FN}; i=0; for f in ${list.map(mx.q).join(' ')}; do r=$(s "$f") || r='-1 0'; echo "$i $r"; i=$((i+1)); done`;
export function parseStat(out, n) {
  const res = new Array(n).fill(null);
  for (const line of String(out || '').split('\n')) {
    const [i, size, mtime] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(i) && i >= 0 && i < n && Number.isFinite(size)) res[i] = { size, mtime: Number.isFinite(mtime) ? mtime : 0 };
  }
  return res;
}

async function pullAsync(e, p) {
  const gen = e.gen;
  const want = Math.min(PULL_MAX, e.remoteSize - p.offset);
  const buf = want > 0 ? await slot(() => mx.readFromAsync(e.machine, e.remote, p.offset, want)) : Buffer.alloc(0);
  if (gen !== e.gen || !files.has(e.local)) return 0;
  if (want > 0 && !buf.length) return 0; // gagal baca: dicoba lagi nanti
  try { return apply(e, p, buf); } catch { return 0; }
}

const machineBusy = new Set();
async function pollMachine(machine, due) {
  machineBusy.add(machine);
  try {
    for (let k = 0; k < due.length; k += STAT_BATCH) {
      const part = due.slice(k, k + STAT_BATCH);
      const r = await slot(() => mx.shAsync(machine, statScript(part.map(e => e.remote)), { timeout: 10000 }));
      if (r.code !== 0) { for (const e of part) { e.interval = SLOW_MS; e.nextAt = Date.now() + SLOW_MS; } if (r.code === 255) return; continue; }
      const stats = parseStat(r.stdout, part.length);
      await Promise.all(part.map(async (e, i) => {
        const s = stats[i];
        if (!s) { schedule(e, false); return; }
        const p = plan(e, s.size, s.mtime);
        const n = p ? await pullAsync(e, p) : 0;
        schedule(e, n > 0);
      }));
    }
  } finally { for (const e of due) e.busy = false; machineBusy.delete(machine); }
}

/** Satu putaran: kelompokkan file jatuh tempo per mesin. Dipakai timer; diekspor untuk tes. */
export async function tick(now = Date.now()) {
  const byMachine = new Map();
  for (const e of files.values()) {
    if (e.busy || e.nextAt > now) continue;
    if (!usable(e.machine)) { if (!mx.getMachine(e.machine)) files.delete(e.local); continue; }
    if (mx.isOffline(e.machine)) continue; // ditarik lagi begitu detak jantung melihatnya online
    if (machineBusy.has(e.machine)) continue;
    if (!byMachine.has(e.machine)) byMachine.set(e.machine, []);
    byMachine.get(e.machine).push(e);
  }
  const jobs = [];
  for (const [m, due] of byMachine) { for (const e of due) e.busy = true; jobs.push(pollMachine(m, due)); }
  await Promise.all(jobs);
  const t = Date.now(); // `now` may be moved ahead (tests); pruning goes by the real clock
  if (t - lastPrune > PRUNE_EVERY) { lastPrune = t; try { prune(t); } catch {} }
}

/** Tarik sekarang juga untuk satu salinan (async). Mengembalikan ukuran salinan sesudahnya, atau null. */
export async function syncNow(localPath) {
  let e = files.get(localPath);
  if (!e) { const r = mx.remoteOfMirror(localPath); if (!r || !mx.isRemote(r.machine)) return null; e = entryFor(r.machine, r.file); ensureLocal(e.local); }
  if (!usable(e.machine) || mx.isOffline(e.machine)) return localSize(e.local);
  for (let i = 0; i < 64 && e.busy; i++) await new Promise(r => setTimeout(r, 25));
  e.busy = true;
  try {
    for (let round = 0; round < 32; round++) {
      const r = await slot(() => mx.shAsync(e.machine, statScript([e.remote]), { timeout: 10000 }));
      const s = r.code === 0 ? parseStat(r.stdout, 1)[0] : null;
      if (!s) break;
      const p = plan(e, s.size, s.mtime);
      const n = p ? await pullAsync(e, p) : 0;
      schedule(e, n > 0);
      if (!p || localSize(e.local) >= e.remoteSize || (!n && !p.fresh)) break;
    }
  } finally { e.busy = false; }
  return localSize(e.local);
}

/* ---------------- pendaftaran ulang dan pembersihan ---------------- */
const liveRows = () => {
  try { return all(globalDb(), 'SELECT transcript FROM sessions WHERE machine IS NOT NULL AND ended_at IS NULL AND transcript IS NOT NULL'); } catch { return []; }
};

/**
 * Daftarkan ulang transkrip sesi remote yang belum berakhir (dari DB) dan tarik di putaran berikutnya. Tanpa ssh sinkron.
 * `machineId` membatasi ke satu mesin (mis. saat mesin itu kembali online); tanpa argumen = semua mesin. Mengembalikan jumlahnya.
 */
export function rearmFromDb(machineId = null) {
  let n = 0;
  for (const { transcript } of liveRows()) {
    const r = mx.remoteOfMirror(transcript);
    if (!r || !mx.isRemote(r.machine) || (machineId && r.machine !== machineId)) continue;
    const e = entryFor(r.machine, r.file); ensureLocal(e.local); e.nextAt = 0; n++;
  }
  // file lain mesin itu (mis. subagent) juga langsung dicek
  if (machineId) for (const e of files.values()) if (e.machine === machineId) e.nextAt = 0;
  return n;
}

let lastPrune = Date.now();
/** Lepas file yang tidak lagi milik sesi hidup dan sudah lama diam. */
export function prune(now = Date.now()) {
  const keep = liveRows().map(r => r.transcript);
  const owned = f => keep.some(t => t === f || f.startsWith(t.replace(/\.jsonl$/, '') + path.sep));
  for (const e of [...files.values()]) {
    if (owned(e.local)) continue;
    if (now - Math.max(e.changedAt || 0, e.touchedAt || 0) > IDLE_DROP_MS) files.delete(e.local);
  }
}

let timer = null, running = false;
export function startMirror() {
  if (timer) return;
  try { rearmFromDb(); } catch {}
  timer = setInterval(() => { if (running) return; running = true; tick().catch(() => {}).finally(() => { running = false; }); }, TICK_MS);
  timer.unref?.();
}
export function stopMirror() { clearInterval(timer); timer = null; }

/* ---------------- folder cermin untuk pemindai (payroll, Codex) ---------------- */
const isLoop = id => String(mx.getMachine(id)?.ssh || '').startsWith('local:');
const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name); } catch { return []; } };

/**
 * Folder cermin yang setara dengan ~/.claude/projects (kind 'claude') atau ~/.codex/sessions (kind 'codex') di mesin lain:
 * [{ machine, dir }]. Untuk mesin loopback ('local:') folder yang menyalin folder lokal Mac ini dilewati, supaya tidak dihitung dobel.
 */
export function mirrorRoots(kind = 'claude', { localDir = null } = {}) {
  const [a, b] = kind === 'codex' ? ['.codex', 'sessions'] : ['.claude', 'projects'];
  const local = path.resolve(localDir || (kind === 'codex' ? path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions') : PROJECTS_DIR));
  const out = [];
  for (const machine of ls(MIRROR_DIR)) {
    const walk = (dir, depth) => {
      const names = ls(dir);
      if (names.includes(a) && ls(path.join(dir, a)).includes(b)) {
        const d = path.join(dir, a, b), remote = mx.remoteOfMirror(d)?.file;
        if (!(isLoop(machine) && remote && path.resolve(remote) === local)) out.push({ machine, dir: d });
      }
      if (depth < 8) for (const n of names) if (n !== '.claude' && n !== '.codex') walk(path.join(dir, n), depth + 1);
    };
    walk(path.join(MIRROR_DIR, machine), 0);
  }
  return out;
}

/** Hanya untuk tes. */
export function _resetMirrorForTests() { stopMirror(); files.clear(); machineBusy.clear(); }
