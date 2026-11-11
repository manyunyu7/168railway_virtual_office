// REST API mesin (Pengaturan → Mesin) dan wiring daemon untuk mesin lain. Kontrak: docs/MULTI-PC.md.
// Token mesin tidak pernah keluar dari sini: semua jawaban memakai publicMachine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as mx from './machines.js';
import { ROOT_DIR } from './config.js';
import { officeDb, one } from './db.js';
import { listOffices } from './offices.js';
import { bus, live } from './live.js';
import * as tmuxMod from './tmux.js';
import * as mirror from './mirror.js';

const notFound = () => Object.assign(new Error('Mesin tidak ditemukan'), { code: 404 });
const need = id => { const m = mx.getMachine(id); if (!m) throw notFound(); return m; };
const pub = id => mx.listMachines().find(m => m.id === id);
const emit = (machine, extra = {}) => bus.emit('msg', { t: 'machine', machine, ...extra });
const errText = e => String(e?.stderr || e?.message || e || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);

/* ---------------- skrip yang dipasang di mesin ---------------- */
// Titik masuk; file lokal yang mereka require/import ikut disalin (dicari dari isinya).
const ENTRY = ['hooks/kantor-hook.cjs', 'hooks/kantor-statusline.cjs', 'server/mcp-stdio.js'];
const REL_IMPORT = /(?:require\s*\(\s*|\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;
/** [{ rel, content }] semua file yang perlu ada di <root>, urut. */
export function payloadFiles() {
  const seen = new Map(), todo = [...ENTRY];
  while (todo.length) {
    const rel = todo.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(ROOT_DIR, rel);
    const content = fs.readFileSync(abs);
    seen.set(rel, content);
    for (const m of content.toString('utf8').matchAll(REL_IMPORT)) {
      let dep = path.relative(ROOT_DIR, path.resolve(path.dirname(abs), m[1]));
      if (dep.startsWith('..') || path.isAbsolute(dep)) continue;
      if (!fs.existsSync(path.join(ROOT_DIR, dep))) for (const ext of ['.js', '.cjs', '.mjs']) if (fs.existsSync(path.join(ROOT_DIR, dep + ext))) { dep += ext; break; }
      if (fs.existsSync(path.join(ROOT_DIR, dep))) todo.push(dep.split(path.sep).join('/'));
    }
  }
  // mcp-stdio.js memakai import ESM; di <root> tidak ada package.json kantor, jadi tandai sendiri
  seen.set('package.json', Buffer.from(JSON.stringify({ name: 'kantor-node', private: true, type: 'module' }) + '\n'));
  return [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([rel, content]) => ({ rel, content }));
}
/** Hash isi skrip: sama dengan isi VERSION di mesin bila skripnya mutakhir. */
export function payloadVersion(files = payloadFiles()) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f.rel).update('\0').update(f.content).update('\0');
  const v = h.digest('hex').slice(0, 12);
  mx.setWantedVersion(v);
  return v;
}

/** Salin skrip ke <root> di mesin itu, tulis VERSION dan hub.json (0600). */
export function installMachine(id) {
  need(id);
  const root = mx.machineRoot(id);
  const files = payloadFiles(), version = payloadVersion(files);
  try {
    for (const f of files) mx.writeFile(id, path.posix.join(root, f.rel), f.content, 0o644);
    mx.shSync(id, `mkdir -p ${mx.q(path.posix.join(root, 'run'))} && chmod 700 ${mx.q(path.posix.join(root, 'run'))}`, { timeout: 10000 });
    mx.writeFile(id, path.posix.join(root, 'VERSION'), version + '\n', 0o644);
    // untuk sesi manual di Mac itu (hook/MCP global tanpa env): ke hub mana dan dengan token apa. Ganti token → Pasang lagi.
    const m = mx.getMachine(id);
    mx.writeFile(id, path.posix.join(root, 'hub.json'), JSON.stringify({ url: m.hubUrl, token: m.token, machine: m.id }) + '\n', 0o600);
  } catch (e) { throw new Error(`Gagal memasang skrip di ${root}: ${errText(e)}`); }
  mx.setInstalledVersion(id, version);
  return { ok: true, version, root, files: files.map(f => f.rel) };
}

/* ---------------- tes koneksi ---------------- */
const versionLine = root => `cat ${mx.q(path.posix.join(root, 'VERSION'))} 2>/dev/null || true`;
/** Isi VERSION di mesin itu (null = belum terpasang); juga dicatat untuk publicMachine. undefined bila tidak bisa dibaca. */
function installedVersion(id, root) {
  let v;
  try { v = mx.shSync(id, versionLine(root), { timeout: 8000 }).trim() || null; } catch { return undefined; }
  mx.setInstalledVersion(id, v);
  return v;
}
/** Versi asinkron untuk detak jantung: murah, tidak memblokir. */
export async function refreshInstalled(id) {
  let root;
  try { root = mx.machineRoot(id); } catch { return; }
  const r = await mx.shAsync(id, versionLine(root), { timeout: 8000 });
  if (r.code === 0) mx.setInstalledVersion(id, String(r.stdout).trim() || null);
}
/**
 * HTTP status `/` hub dilihat dari mesin itu: '000' = tak terjangkau, null = tidak bisa dicek.
 * Harus async: curl itu memanggil daemon ini sendiri, dan execFileSync akan memblokir event loop yang mesti menjawabnya.
 */
async function hubStatusFrom(id, hubUrl) {
  const r = await mx.shAsync(id, `curl -s -o /dev/null -m 5 -w '%{http_code}' ${mx.q(hubUrl.replace(/\/+$/, '') + '/')} 2>/dev/null; true`, { timeout: 9000 });
  const out = String(r.stdout || '').trim();
  return r.code === 0 && /^\d{3}$/.test(out) ? out : null;
}
function nodeMajor(id, nodeBin) {
  try { const v = mx.shSync(id, `${mx.q(nodeBin)} -v`, { timeout: 8000 }).trim(); return { v, major: Number(/^v?(\d+)/.exec(v)?.[1]) || null }; } catch { return { v: null, major: null }; }
}

/** Cek mesin: SSH, bin yang dibutuhkan, skrip terpasang, dan apakah mesin itu bisa menjangkau hub. */
export async function testMachine(id) {
  const m = need(id);
  const problems = [];
  const p = mx.probeSync(id);
  if (!p.ok) {
    problems.push(m.ssh === 'local:'
      ? `Perintah lokal gagal: ${p.error || 'tanpa pesan'}`
      : `Tidak bisa SSH ke ${m.ssh}: ${p.error || 'tanpa pesan'}. Pastikan Remote Login di Mac itu nyala, Tailscale tersambung, public key hub ada di ~/.ssh/authorized_keys, dan host key sudah diterima (jalankan sekali di hub: ssh ${m.ssh} true).`);
    emit(pub(id));
    return { ok: false, latencyMs: p.latencyMs ?? null, os: null, home: null, bins: null, hubReachable: null, installed: { version: null, current: false }, problems };
  }
  const b = p.bins || {};
  if (!b.tmux) problems.push('tmux belum terpasang: brew install tmux');
  let node = null;
  if (!b.node) problems.push('node belum terpasang: brew install node (butuh versi 22 atau lebih baru)');
  else {
    node = nodeMajor(id, b.node);
    if (node.major && node.major < 22) problems.push(`node ${node.v} terlalu lama, butuh 22 atau lebih baru: brew upgrade node`);
  }
  if (!b.claude && !b.codex) problems.push('claude dan codex belum terpasang: npm i -g @anthropic-ai/claude-code, lalu jalankan claude sekali untuk login');

  const want = payloadVersion(), root = mx.machineRoot(id), version = installedVersion(id, root) ?? null;
  if (!version) problems.push(`Skrip kantor belum terpasang di ${root}: tekan Pasang.`);
  else if (version !== want) problems.push('Skrip kantor di mesin ini versi lama: tekan Pasang lagi.');

  const code = await hubStatusFrom(id, m.hubUrl);
  let hubReachable = null;
  if (code === null) problems.push(`Tidak bisa mengecek hub dari mesin ini (curl tidak ada?). Coba manual di mesin itu: curl ${m.hubUrl}/`);
  else if (code === '000') { hubReachable = false; problems.push(`Mesin ini tidak bisa menjangkau hub di ${m.hubUrl}. Pastikan Tailscale nyala di kedua Mac, alamat dan port URL hub benar, dan hub listen di alamat itu (extraHosts di config hub berisi IP Tailscale-nya, lalu mulai ulang daemon).`); }
  else if (code === '403') { hubReachable = false; problems.push(`Hub menolak host ${hostOf(m.hubUrl)} (403). Tambahkan host itu ke extraHosts di config hub, lalu mulai ulang daemon.`); }
  else hubReachable = true;

  emit(pub(id));
  return { ok: problems.length === 0, latencyMs: p.latencyMs, os: p.os || null, home: p.home || null, bins: b, node: node?.v || null, hubReachable, installed: { version, current: !!version && version === want }, root, problems };
}
const hostOf = u => { try { return new URL(u).host; } catch { return u; } };

/* ---------------- pemilih folder ---------------- */
/** Subfolder `dir` di mesin itu (bawaan: ~/Developer bila ada, kalau tidak ~). */
export function browseMachine(id, dir = '') {
  need(id);
  dir = String(dir || '').trim();
  if (dir && (!dir.startsWith('/') || /[\0\n\r]/.test(dir))) throw new Error('Folder harus path absolut, mis. /Users/kamu/Developer');
  const go = dir ? `cd ${mx.q(path.posix.normalize(dir))} 2>/dev/null || exit 3` : `D="$HOME"; [ -d "$HOME/Developer" ] && D="$HOME/Developer"; cd "$D" || exit 3`;
  // baris 1: folder sekarang; baris 2: git atau tidak; sisanya: <git>\t<nama>
  const script = `${go}; pwd; [ -e .git ] && echo 1 || echo 0; for d in *; do [ -d "$d" ] || continue; [ -e "$d/.git" ] && g=1 || g=0; printf '%s\\t%s\\n' "$g" "$d"; done`;
  let out;
  // /bin/sh: shell login di Mac lain biasanya zsh, yang menghentikan `for d in *` di folder kosong
  try { out = mx.shSync(id, `/bin/sh -c ${mx.q(script)}`, { timeout: 12000 }); } catch (e) {
    if (e.status === 3) throw new Error('Folder tidak ditemukan');
    throw new Error(`Tidak bisa membuka folder di mesin itu: ${errText(e)}`);
  }
  const [cwd, isGit, ...rest] = out.split('\n');
  const entries = [];
  for (const l of rest) {
    const i = l.indexOf('\t');
    if (i < 0) continue;
    const name = l.slice(i + 1);
    if (!name || name === 'node_modules') continue;
    entries.push({ name, path: path.posix.join(cwd, name), git: l.slice(0, i) === '1' });
    if (entries.length >= 500) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { dir: cwd, parent: cwd === '/' ? null : path.posix.dirname(cwd), git: isGit === '1', entries };
}

/* ---------------- CRUD ---------------- */
const checkRoot = root => { if (root != null && root !== '' && !/^(\/|~\/)/.test(String(root))) throw new Error('Folder root harus absolut atau diawali ~/'); };
/** Ruangan (di kantor mana pun) dan sesi hidup yang masih memakai mesin itu. */
export function machineUsage(id) {
  const sessions = [...live.values()].filter(s => s.machine === id && s.status !== 'ended');
  const rooms = [];
  for (const o of listOffices()) {
    let extra = [];
    try { extra = JSON.parse(one(officeDb(o.id), "SELECT value FROM meta WHERE key = 'extraRooms'")?.value || '[]'); } catch {}
    for (const r of Array.isArray(extra) ? extra : []) if (r?.machine === id) rooms.push({ office: o.id, officeName: o.name || o.id, room: r.id, name: r.name || r.id });
  }
  return { sessions, rooms };
}
export function createMachine(b = {}) {
  checkRoot(b.root);
  const m = mx.addMachine({ name: b.name, ssh: b.ssh, hubUrl: b.hubUrl, root: b.root || null });
  emit(m);
  return { machine: m };
}
export function patchMachine(id, b = {}) {
  need(id);
  if (b.root !== undefined) checkRoot(b.root);
  const patch = {};
  for (const k of ['name', 'ssh', 'hubUrl', 'root', 'disabled', 'rotateToken']) if (b[k] !== undefined) patch[k] = b[k];
  if (patch.root === '') patch.root = null;
  const m = mx.updateMachine(id, patch);
  if (patch.ssh) mx.invalidateTmuxList(id);
  emit(m);
  return { machine: m };
}
export function deleteMachine(id) {
  need(id);
  const u = machineUsage(id);
  if (u.sessions.length) throw Object.assign(new Error(`Masih ada ${u.sessions.length} sesi hidup di mesin ini. Akhiri dulu sesinya.`), { code: 409 });
  if (u.rooms.length) throw Object.assign(new Error(`Masih ada ruangan di mesin ini: ${u.rooms.slice(0, 5).map(r => `${r.name} (${r.officeName})`).join(', ')}. Hapus atau pindahkan dulu ruangannya.`), { code: 409 });
  mx.removeMachine(id);
  emit({ id }, { removed: true });
  return { ok: true };
}

/** Daftarkan rute /api/machines ke router index.js. */
export function machineRoutes(route, body) {
  route('GET', '/api/machines', () => ({ machines: mx.listMachines() }));
  route('POST', '/api/machines', async req => createMachine(await body(req)));
  route('PATCH', '/api/machines/:id', async (req, res, p) => patchMachine(p.id, await body(req)));
  route('DELETE', '/api/machines/:id', (req, res, p) => deleteMachine(p.id));
  route('POST', '/api/machines/:id/test', (req, res, p) => testMachine(p.id));
  route('POST', '/api/machines/:id/install', (req, res, p) => installMachine(p.id));
  route('GET', '/api/machines/:id/browse', (req, res, p, q) => browseMachine(p.id, q.get('dir') || ''));
}

/* ---------------- wiring daemon ---------------- */
const safe = (what, fn) => { try { return fn(); } catch (e) { console.error(`mesin ${what}:`, e.message); } };
/** Mesin kembali (atau pertama kali) online: adopsi sesi tmux-nya dan pasang ulang cermin transkripnya. */
function onOnline(id) {
  safe(`adopsi ${id}`, () => tmuxMod.adoptRemote?.(id));
  safe(`cermin ${id}`, () => mirror.rearmFromDb?.(id));
  refreshInstalled(id).catch(() => {});
}
let started = false, reaper = null, listener = null, versionBeat = null;
/** Dipanggil sekali saat daemon mulai: event ke browser, detak jantung, adopsi saat online, reap tiap 60 detik. */
export function startMachines({ watchSec = 15, reapSec = 60, versionSec = 300 } = {}) {
  if (started) return;
  started = true;
  safe('versi skrip', () => payloadVersion());
  const wasOnline = new Map();
  mx.events.on('machine', listener = m => {
    emit(m);
    const before = wasOnline.get(m.id);
    wasOnline.set(m.id, m.online);
    // setImmediate: setOnline dipanggil dari dalam shSync pemanggil lain; jangan adopsi di tengah tumpukan itu
    if (m.online === true && before !== true && !m.disabled) setImmediate(() => onOnline(m.id));
  });
  safe('cermin', () => mirror.startMirror?.());
  for (const m of mx.listMachines()) if (m.online === true && !m.disabled) { wasOnline.set(m.id, true); setImmediate(() => onOnline(m.id)); }
  mx.startMachineWatch(watchSec);
  reaper = setInterval(() => {
    for (const m of mx.listMachines()) if (m.online === true && !m.disabled) safe(`reap ${m.id}`, () => tmuxMod.reapRemote?.(m.id));
  }, reapSec * 1000);
  reaper.unref?.();
  // status skrip untuk UI (installed di publicMachine) tanpa harus menekan Tes; jarang, karena jarang berubah
  versionBeat = setInterval(async () => {
    for (const m of mx.listMachines()) if (m.online === true && !m.disabled) await refreshInstalled(m.id).catch(() => {});
  }, versionSec * 1000);
  versionBeat.unref?.();
}
/** Saat daemon berhenti (dan di tes): hentikan detak jantung, reaper, dan poller cermin. */
export function stopMachines() {
  clearInterval(reaper); reaper = null; clearInterval(versionBeat); versionBeat = null;
  mx.stopMachineWatch();
  safe('cermin', () => mirror.stopMirror?.());
  if (listener) mx.events.off('machine', listener);
  listener = null; started = false;
}
export const _stopMachines = stopMachines;
