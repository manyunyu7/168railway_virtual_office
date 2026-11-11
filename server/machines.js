// Mesin lain (Mac kedua dan seterusnya) tempat agen kantor jalan, dikendalikan dari kantor ini (hub) lewat SSH.
// Desain dan kontraknya: docs/MULTI-PC.md. Mesin 'local' adalah Mac tempat daemon ini jalan dan tidak perlu didaftarkan.
//
// Transport:
//   ssh: 'user@mac2.tailnet.ts.net'  → perintah dijalankan lewat ssh dengan ControlMaster (satu koneksi dipakai ulang)
//   ssh: 'local:'                    → perintah dijalankan di Mac ini lewat /bin/sh, tapi lewat jalur kode "remote"
//                                      (untuk tes dan mencoba fitur di satu Mac)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync, execFile } from 'node:child_process';
import { config, saveConfig, RUN_DIR, DATA_DIR } from './config.js';

export const LOCAL = 'local';
export const events = new EventEmitter(); // 'machine' → publicMachine(m) setiap status online/offline berubah

/** Kutip satu argumen untuk shell POSIX. */
export const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

const list = () => (Array.isArray(config().machines) ? config().machines : []);
/** Data lengkap mesin (termasuk token) atau null. 'local' dan id tak dikenal → null. */
export function getMachine(id) {
  if (!id || id === LOCAL) return null;
  return list().find(m => m.id === id) || null;
}
/** true kalau id menunjuk mesin terdaftar selain Mac ini. */
export const isRemote = id => !!getMachine(id);
const isLoopTransport = m => String(m.ssh || '').startsWith('local:');

/* ---------------- status ---------------- */
const state = new Map(); // id → { online, lastSeen, lastError, latencyMs, home, bins }
const st = id => { let s = state.get(id); if (!s) state.set(id, s = { online: null, lastSeen: null, lastError: null, latencyMs: null, home: null, bins: null }); return s; };
function setOnline(id, online, err = null) {
  const s = st(id), was = s.online;
  s.online = online;
  if (online) { s.lastSeen = new Date().toISOString(); s.lastError = null; } else s.lastError = err ? String(err).slice(0, 300) : s.lastError;
  if (was !== online) { const m = getMachine(id); if (m) events.emit('machine', publicMachine(m)); }
}
/** Status terakhir yang diketahui: { online (true|false|null=belum dicek), lastSeen, lastError, latencyMs }. */
export function machineStatus(id) { const s = st(id); return { online: s.online, lastSeen: s.lastSeen, lastError: s.lastError, latencyMs: s.latencyMs }; }
/** true hanya kalau mesin remote terakhir diketahui offline. 'local' tidak pernah offline. */
export const isOffline = id => isRemote(id) && st(id).online === false;

/* skrip kantor di mesin itu: versi terakhir yang terbaca (Tes, Pasang, atau detak jantung) dibanding versi di hub */
let wantedVersion = null;
const installedSeen = new Map(); // id → isi VERSION ('' = belum terpasang)
/** Versi skrip yang dipasang hub (machines-api.js menghitungnya dari isi skrip). */
export function setWantedVersion(v) { wantedVersion = v || null; }
/** { version, current } dari pengecekan terakhir, atau null bila belum pernah dicek. */
export function installedOf(id) {
  if (!installedSeen.has(id)) return null;
  const version = installedSeen.get(id) || null;
  return { version, current: !!version && !!wantedVersion && version === wantedVersion };
}
/** Catat isi VERSION yang terbaca di mesin itu (null/'' = belum terpasang). Berubah → events 'machine'. */
export function setInstalledVersion(id, version) {
  const v = version ? String(version).trim() : '';
  if (installedSeen.has(id) && installedSeen.get(id) === v) return;
  installedSeen.set(id, v);
  const m = getMachine(id); if (m) events.emit('machine', publicMachine(m));
}
export function publicMachine(m) {
  return { id: m.id, name: m.name, ssh: m.ssh, hubUrl: m.hubUrl, root: m.root || null, disabled: !!m.disabled, ...machineStatus(m.id), installed: installedOf(m.id) };
}
export const listMachines = () => list().map(publicMachine);

/** Mesin pemilik token (untuk hook dan MCP dari Mac lain), atau null. */
export function machineForToken(tok) {
  if (!tok) return null;
  const b = Buffer.from(String(tok));
  for (const m of list()) {
    if (!m.token || m.disabled) continue;
    const a = Buffer.from(m.token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return m.id;
  }
  return null;
}

/* ---------------- CRUD (disimpan di config.json, mode 600) ---------------- */
// awalan sendiri: 'kcm_' sudah dipakai token aplikasi anggota (akun.TOKEN_PREFIX). Token lama tetap berlaku.
export const MACHINE_TOKEN_PREFIX = 'kcmesin_';
const newToken = () => MACHINE_TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mesin';
function validate({ name, ssh, hubUrl }) {
  if (name !== undefined && !String(name).trim()) throw new Error('Nama mesin wajib diisi');
  if (ssh !== undefined) {
    const v = String(ssh).trim();
    if (!v) throw new Error('Alamat SSH wajib diisi, mis. henry@mac-studio.tail1234.ts.net');
    if (v !== 'local:' && !/^[A-Za-z0-9._@:\[\]-]+$/.test(v)) throw new Error('Alamat SSH tidak valid');
    if (v.startsWith('-')) throw new Error('Alamat SSH tidak valid');
  }
  if (hubUrl !== undefined) {
    let u; try { u = new URL(String(hubUrl)); } catch { throw new Error('URL hub tidak valid, mis. http://macbook-air.tail1234.ts.net:4317'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL hub harus http atau https');
  }
}
export function addMachine({ name, ssh, hubUrl, root = null }) {
  validate({ name, ssh, hubUrl });
  const cfg = config();
  const machines = Array.isArray(cfg.machines) ? cfg.machines : [];
  let id = slug(name);
  if (id === LOCAL) id = 'mesin-local';
  while (machines.some(m => m.id === id)) id += '2';
  const m = { id, name: String(name).trim(), ssh: String(ssh).trim(), hubUrl: String(hubUrl).replace(/\/+$/, ''), root: root || null, token: newToken() };
  cfg.machines = [...machines, m];
  saveConfig(cfg);
  return publicMachine(m);
}
export function updateMachine(id, patch = {}) {
  const cfg = config();
  const m = (cfg.machines || []).find(x => x.id === id);
  if (!m) throw new Error('Mesin tidak ditemukan');
  const p = {};
  for (const k of ['name', 'ssh', 'hubUrl', 'root']) if (patch[k] !== undefined) p[k] = patch[k] === null ? null : String(patch[k]).trim();
  validate(p);
  if (p.hubUrl) p.hubUrl = p.hubUrl.replace(/\/+$/, '');
  Object.assign(m, p);
  if (patch.disabled !== undefined) m.disabled = !!patch.disabled;
  if (patch.rotateToken) m.token = newToken();
  if (p.ssh) { const s = st(id); s.bins = null; s.home = null; }
  if (p.ssh || p.root !== undefined) installedSeen.delete(id); // root lain: versi lama tidak berlaku
  saveConfig(cfg);
  return publicMachine(m);
}
export function removeMachine(id) {
  const cfg = config();
  if (!(cfg.machines || []).some(m => m.id === id)) throw new Error('Mesin tidak ditemukan');
  cfg.machines = cfg.machines.filter(m => m.id !== id);
  saveConfig(cfg);
  state.delete(id); installedSeen.delete(id);
  return { ok: true };
}

/* ---------------- menjalankan perintah ---------------- */
/** Argumen ssh (tanpa perintah) untuk mesin ini. ControlMaster membuat panggilan berikutnya ~10-50 ms. */
export function sshArgs(m, { tty = false } = {}) {
  return [...(tty ? ['-t'] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(controlDir(), '%C')}`, '-o', 'ControlPersist=600', m.ssh];
}
// Socket ControlMaster: path socket Unix di macOS maksimal ~104 byte, %C = 40 karakter. Folder data yang panjang
// (mis. KANTOR_HOME sementara) dipindah ke /tmp/kcssh-<uid> (mode 700, harus milik kita).
let ctlDir = null;
export function controlDir() {
  if (ctlDir) return ctlDir;
  const own = path.join(RUN_DIR, 'ssh');
  if (own.length + 41 <= 100) { fs.mkdirSync(own, { recursive: true, mode: 0o700 }); return (ctlDir = own); }
  const uid = process.getuid?.() ?? 'u';
  const short = `/tmp/kcssh-${uid}`;
  try { fs.mkdirSync(short, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(short);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${short} bukan folder milikmu; hapus dulu`);
  fs.chmodSync(short, 0o700);
  return (ctlDir = short);
}

// perintah yang dicari path absolutnya di mesin remote (shell non-login lewat ssh tidak memuat PATH homebrew)
const KNOWN_BINS = ['tmux', 'node', 'claude', 'codex', 'agy', 'git'];
const binOf = (id, cmd) => (KNOWN_BINS.includes(cmd) && st(id).bins?.[cmd]) || cmd;
const lineOf = (id, cmd, args) => [binOf(id, cmd), ...args].map(q).join(' ');

function wrap(id, err) {
  // ssh sendiri gagal (bukan perintahnya): status 255
  if (err && err.status === 255) setOnline(id, false, String(err.stderr || err.message || '').trim());
  return err;
}

/**
 * Jalankan perintah di mesin `id` secara sinkron, seperti execFileSync. 'local' (atau null) = Mac ini.
 * opts: input, timeout (ms, bawaan 15000), encoding (bawaan 'utf8'; 'buffer' untuk biner), cwd (hanya lokal).
 * Untuk perintah shell utuh (pipa, redirect) pakai shSync.
 */
export function execSync(id, cmd, args = [], opts = {}) {
  const m = getMachine(id);
  const o = { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts };
  if (!m) return execFileSync(cmd, args, o);
  return shSync(id, lineOf(id, cmd, args), o);
}
/** Jalankan satu baris shell di mesin `id` (sinkron). Pemanggil wajib mengutip argumennya sendiri dengan q(). */
export function shSync(id, line, opts = {}) {
  const m = getMachine(id);
  const o = { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts };
  if (!m) return execFileSync('/bin/sh', ['-c', line], o);
  delete o.cwd;
  try {
    const out = isLoopTransport(m) ? execFileSync('/bin/sh', ['-c', line], o) : execFileSync('ssh', [...sshArgs(m), '--', line], o);
    setOnline(id, true);
    return out;
  } catch (e) { throw wrap(id, e); }
}
/** Versi async: resolve { stdout, stderr, code }; tidak pernah reject (code -1 bila ssh/perintah gagal dijalankan). */
export function execAsync(id, cmd, args = [], opts = {}) {
  const m = getMachine(id);
  if (!m) return run(cmd, args, opts);
  return shAsync(id, lineOf(id, cmd, args), opts);
}
export function shAsync(id, line, opts = {}) {
  const m = getMachine(id);
  if (!m) return run('/bin/sh', ['-c', line], opts);
  const o = { ...opts }; delete o.cwd;
  return (isLoopTransport(m) ? run('/bin/sh', ['-c', line], o) : run('ssh', [...sshArgs(m), '--', line], o)).then(r => {
    if (r.code === 255) setOnline(id, false, r.stderr.trim()); else if (r.code !== -1) setOnline(id, true);
    return r;
  });
}
function run(file, args, { input, timeout = 15000, encoding = 'utf8', cwd, env } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout, encoding, maxBuffer: 64 << 20, cwd, env }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: String(stderr ?? ''), code: err ? (typeof err.code === 'number' ? err.code : -1) : 0 });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

/** { file, args } untuk pty.spawn: perintah interaktif di mesin itu (mis. tmux attach). Lokal: perintah apa adanya. */
export function spawnArgs(id, cmd, args = []) {
  const m = getMachine(id);
  if (!m) return { file: cmd, args };
  const line = lineOf(id, cmd, args);
  if (isLoopTransport(m)) return { file: '/bin/sh', args: ['-c', line] };
  return { file: 'ssh', args: [...sshArgs(m, { tty: true }), '--', line] };
}

/* ---------------- file ---------------- */
/** Tulis file di mesin itu (folder dibuat). Konten string atau Buffer. */
export function writeFile(id, file, content, mode = 0o600) {
  if (!getMachine(id)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode }); return; }
  shSync(id, `umask 077 && mkdir -p ${q(path.dirname(file))} && cat > ${q(file)} && chmod ${(mode & 0o777).toString(8)} ${q(file)}`, { input: content });
}
/** Ukuran dan mtime file di mesin itu, atau null bila tidak ada. */
export function statFile(id, file) {
  if (!getMachine(id)) { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } }
  try {
    const out = shSync(id, `stat -f '%z %m' ${q(file)} 2>/dev/null || stat -c '%s %Y' ${q(file)}`, { timeout: 8000 }).trim();
    const [size, mtime] = out.split(/\s+/).map(Number);
    return Number.isFinite(size) ? { size, mtimeMs: mtime * 1000 } : null;
  } catch { return null; }
}
/** Byte file mulai `offset`, paling banyak `max` byte (Buffer). Kosong bila file tidak ada. */
export function readFrom(id, file, offset = 0, max = 4 << 20) {
  if (!getMachine(id)) {
    try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, offset); return b.subarray(0, n); } finally { fs.closeSync(fd); } } catch { return Buffer.alloc(0); }
  }
  try { return shSync(id, `tail -c +${Math.floor(offset) + 1} ${q(file)} 2>/dev/null | head -c ${Math.floor(max)}`, { encoding: 'buffer', timeout: 20000 }); } catch { return Buffer.alloc(0); }
}
/** Versi async dari readFrom (untuk poller). */
export async function readFromAsync(id, file, offset = 0, max = 4 << 20) {
  if (!getMachine(id)) return readFrom(id, file, offset, max);
  const r = await shAsync(id, `tail -c +${Math.floor(offset) + 1} ${q(file)} 2>/dev/null | head -c ${Math.floor(max)}`, { encoding: 'buffer', timeout: 20000 });
  return r.code === 0 && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
}

/* ---------------- tata letak di mesin remote ---------------- */
/** Folder kantor-node di mesin itu (skrip hook, MCP, file run per sesi). Absolut. */
export function machineRoot(id) {
  const m = getMachine(id);
  if (!m) return null;
  if (m.root) {
    if (!m.root.startsWith('~/')) return m.root;
    const home = st(id).home || probeSync(id).home;
    if (!home) throw new Error(`HOME di mesin ${m.name || id} belum diketahui (mesin tak terjangkau?)`);
    return path.join(home, m.root.slice(2));
  }
  if (isLoopTransport(m)) return path.join(DATA_DIR, 'machine-local', id);
  const home = st(id).home || probeSync(id).home;
  return path.join(home || '/tmp', '.kantor-node');
}
export const machineRunDir = id => path.join(machineRoot(id), 'run');
/** Path lokal tempat salinan file remote disimpan (transkrip yang dicerminkan). */
export const mirrorPath = (id, remoteFile) => path.join(DATA_DIR, 'mirror', id, path.resolve('/', String(remoteFile)).slice(1));
/** Kebalikan mirrorPath: path remote dari path cermin lokal, atau null. */
export function remoteOfMirror(localFile) {
  const base = path.join(DATA_DIR, 'mirror') + path.sep;
  if (!String(localFile || '').startsWith(base)) return null;
  const rest = localFile.slice(base.length), i = rest.indexOf(path.sep);
  return i < 0 ? null : { machine: rest.slice(0, i), file: '/' + rest.slice(i + 1) };
}

/** Bin dan HOME di mesin itu, dicari sekali lewat shell login lalu disimpan. */
export function probeSync(id) {
  const m = getMachine(id);
  if (!m) return { ok: true, home: process.env.HOME, bins: {} };
  const t0 = Date.now();
  // installer resmi Claude dan Homebrew sering hanya menambah PATH di .zshrc (tidak dibaca shell login non-interaktif)
  const script = `PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; echo "HOME=$HOME"; uname -sm | sed 's/^/OS=/'; for b in ${KNOWN_BINS.join(' ')}; do p=$(command -v $b 2>/dev/null); echo "BIN_$b=$p"; done`;
  try {
    const out = shSync(id, `/bin/zsh -lc ${q(script)} 2>/dev/null || /bin/bash -lc ${q(script)}`, { timeout: 20000 });
    const kv = Object.fromEntries(out.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
    const bins = Object.fromEntries(KNOWN_BINS.map(b => [b, kv[`BIN_${b}`] || null]));
    const s = st(id);
    Object.assign(s, { home: kv.HOME || null, bins, latencyMs: Date.now() - t0 });
    return { ok: true, home: s.home, os: kv.OS || null, bins, latencyMs: s.latencyMs };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e).trim().slice(0, 400), latencyMs: Date.now() - t0 };
  }
}
/** HOME di mesin itu (dicari sekali). null bila tak terjangkau. */
export function machineHome(id) { if (!getMachine(id)) return process.env.HOME; ensureProbed(id); return st(id).home || null; }
/** Pastikan bin remote sudah dicari (dipanggil sebelum perintah pertama ke mesin itu). */
export function ensureProbed(id) { if (getMachine(id) && !st(id).bins) probeSync(id); return st(id).bins || {}; }

/* ---------------- tmux: sesi mana di mesin mana ---------------- */
const tmuxOwner = new Map(); // nama sesi tmux → id mesin (hanya yang remote)
export function setTmuxMachine(name, id) { if (!name) return; if (id && id !== LOCAL) tmuxOwner.set(name, id); else tmuxOwner.delete(name); }
/** Mesin tempat sesi tmux itu jalan ('local' bila tidak tercatat). Nama boleh berakhiran :window.pane. */
export const tmuxMachineOf = name => tmuxOwner.get(String(name || '').split(':')[0]) || LOCAL;

const listCache = new Map(); // id → { at, names }
/** Daftar sesi tmux di mesin remote (cache 1,5 s). null bila mesin tak terjangkau (jangan dianggap kosong). */
export function remoteTmuxSessions(id, { fresh = false } = {}) {
  const c = listCache.get(id);
  if (!fresh && c && Date.now() - c.at < 1500) return c.names;
  // mesin yang diketahui offline: jangan menunggu ssh (bisa 6 s) di jalur sinkron; detak jantung yang memulihkannya
  if (!fresh && isOffline(id)) return null;
  ensureProbed(id);
  const empty = t => /no server running|no sessions|error connecting to .*\(No such file or directory\)/i.test(String(t || ''));
  let names;
  try { names = shSync(id, `${q(binOf(id, 'tmux'))} list-sessions -F '#{session_name}' 2>&1`, { timeout: 8000 }).split('\n').filter(Boolean); }
  // hanya "tmux jalan tapi tanpa sesi" yang berarti kosong; timeout, ssh gagal, atau tmux hilang = tak terbaca (null)
  catch (e) { names = e.status === 1 && empty(e.stdout) ? [] : null; }
  if (names && names.some(empty)) names = [];
  listCache.set(id, { at: Date.now(), names });
  return names;
}
export const invalidateTmuxList = id => listCache.delete(id);

/* ---------------- detak jantung ---------------- */
let beat = null;
/** Cek setiap mesin tiap `sec` detik (async, tidak memblokir); status berubah → events 'machine'. */
export function startMachineWatch(sec = 15) {
  if (beat) return;
  const tick = async () => {
    for (const m of list()) {
      if (m.disabled) continue;
      const t0 = Date.now();
      const r = await shAsync(m.id, 'true', { timeout: 8000 });
      if (r.code === 0) { st(m.id).latencyMs = Date.now() - t0; if (!st(m.id).bins) probeSync(m.id); }
      else setOnline(m.id, false, r.stderr.trim() || `kode ${r.code}`);
    }
  };
  tick();
  beat = setInterval(tick, sec * 1000);
  beat.unref?.();
}
export function stopMachineWatch() { clearInterval(beat); beat = null; }

/** Hanya untuk tes: paksa status online/offline (memicu events 'machine' bila berubah). */
export const _setOnlineForTests = (id, online) => setOnline(id, online, online ? null : 'tes');
/** Hanya untuk tes: kosongkan status dan cache. */
export function _resetForTests() { state.clear(); tmuxOwner.clear(); listCache.clear(); installedSeen.clear(); }
