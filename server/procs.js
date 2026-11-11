// Proses jangka panjang per ruangan (npm run dev, php artisan serve, …) dan terminal dok.
// Tiap proses jalan di sesi tmux sendiri (kcp-…), jadi selamat dari restart daemon dan reload browser.
// Status diturunkan dari tmux + berkas kode keluar; log lewat tmux pipe-pane ke <data>/offices/<kantor>/proc/<id>.log.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DIR } from './config.js';
import { officeDb, all, one, run, nowIso, newId } from './db.js';
import { officeModel, listOffices } from './offices.js';
import { bus } from './live.js';
import { tmux, tmuxSessions } from './tmux.js';
import * as mx from './machines.js';
import { remoteRoomOf, machineLabel } from './files.js';

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, '-');
const GRACE_MS = 5000, LOG_MAX = 2 * 1024 * 1024, LOG_KEEP = 1024 * 1024;
export const procDir = office => path.join(OFFICE_DIR, safe(office), 'proc');
const file = (office, id, ext) => path.join(procDir(office), `${safe(id)}.${ext}`);
export const sessName = (office, r) => `kcp-${safe(office)}-${safe(r.room)}-${safe(r.id)}`;

/* ---------------- membaca log ---------------- */
// ESC sequences out; a carriage return rewrites the line, so keep what is after the last one
export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, '')
    .split('\n').map(l => { const p = l.replace(/\r+$/, '').split('\r').filter(Boolean); return p.length ? p[p.length - 1] : ''; }).join('\n');
}
export function readTail(f, bytes = 48 * 1024) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return { text: buf.toString('utf8'), size };
  } catch { return { text: '', size: 0 }; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

/* ---------------- deteksi port ---------------- */
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s\]\)'"<>]*)?/gi;
const LOOSE_RE = /\b(?:listening|listen|serving|running|started|server)\b[^\n]{0,50}?(?:\bport\s+|(?:^|[\s\[*]|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):)(\d{2,5})\b(?!:)/gi;
/** Last local port mentioned in the text: {port, url} or null. */
export function detectPort(text) {
  const t = stripAnsi(text);
  let best = null;
  const take = (m, url) => { const port = Number(m[1]); if (port >= 80 && port <= 65535 && (!best || m.index >= best.at)) best = { port, url, at: m.index }; };
  for (const m of t.matchAll(URL_RE)) take(m, `http://localhost:${m[1]}${(m[2] || '').replace(/[.,;:]+$/, '')}`);
  // a URL beats a loose "listening on :8080" unless the loose line came later and names another port
  const urlBest = best; best = null;
  for (const m of t.matchAll(LOOSE_RE)) take(m, `http://localhost:${m[1]}`);
  const loose = best;
  const r = urlBest && (!loose || loose.at < urlBest.at || loose.port === urlBest.port) ? urlBest : loose || urlBest;
  return r ? { port: r.port, url: r.url } : null;
}

/* ---------------- saran perintah dari folder ---------------- */
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const has = (d, n) => fs.existsSync(path.join(d, n));
export function suggest(dir) {
  return suggestFrom({
    has: n => has(dir, n),
    json: n => readJson(path.join(dir, n)),
    text: n => fs.readFileSync(path.join(dir, n), 'utf8'),
    cmds: () => { try { return fs.readdirSync(path.join(dir, 'cmd'), { withFileTypes: true }).filter(e => e.isDirectory() && has(path.join(dir, 'cmd', e.name), 'main.go')).map(e => e.name); } catch { return []; } },
  });
}
const MARKERS = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'artisan', 'composer.json', 'go.mod', 'Makefile', 'makefile', 'GNUmakefile', 'pubspec.yaml', 'manage.py', 'Cargo.toml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const sugCache = new Map(); // mesin\0folder -> { at, list }
/** Saran perintah untuk ruangan, juga ruangan di Mac lain (satu panggilan ssh, disimpan 60 detik). */
export function suggestRoom(office, roomId) {
  const pl = placeOf(office, roomId);
  if (!pl.machine) return suggest(pl.dir);
  const key = `${pl.machine}\0${pl.dir}`, c = sugCache.get(key);
  if (c && Date.now() - c.at < 60e3) return c.list;
  if (mx.isOffline(pl.machine)) return c?.list || [];
  let out = '';
  try {
    out = mx.shSync(pl.machine, `cd ${mx.q(pl.dir)} || exit 0
for f in ${MARKERS.join(' ')}; do [ -e "$f" ] && printf 'H %s\n' "$f"; done
for d in cmd/*/; do [ -f "\${d}main.go" ] && printf 'C %s\n' "$(basename "$d")"; done
for f in package.json Makefile makefile GNUmakefile; do [ -f "$f" ] && { printf 'F %s\n' "$f"; head -c 65536 "$f" | base64; printf '\nE\n'; }; done
exit 0`, { timeout: 10000 });
  } catch { return c?.list || []; }
  const hasS = new Set(), cmds = [], txt = {};
  let cur = null, buf = [];
  for (const l of String(out).split('\n')) {
    if (cur) { if (l === 'E') { txt[cur] = Buffer.from(buf.join(''), 'base64').toString('utf8'); cur = null; buf = []; } else buf.push(l.trim()); continue; }
    if (l.startsWith('H ')) hasS.add(l.slice(2)); else if (l.startsWith('C ')) cmds.push(l.slice(2)); else if (l.startsWith('F ')) cur = l.slice(2);
  }
  const list = suggestFrom({ has: n => hasS.has(n), json: n => { try { return JSON.parse(txt[n]); } catch { return null; } }, text: n => { if (txt[n] == null) throw new Error('tidak ada'); return txt[n]; }, cmds: () => cmds });
  sugCache.set(key, { at: Date.now(), list });
  return list;
}
function suggestFrom({ has: hasF, json, text, cmds: cmdDirs }) {
  const has = (_, n) => hasF(n), dir = '';
  const out = [], add = (cmd, why) => { if (!out.some(x => x.cmd === cmd)) out.push({ name: cmd.replace(/^(npm run|pnpm run|bun run|yarn|php artisan|python manage.py|make) ?/, '').trim() || cmd, cmd, why }); };
  const pkg = has(dir, 'package.json') && json('package.json');
  if (pkg?.scripts) {
    const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm run' : has(dir, 'yarn.lock') ? 'yarn' : has(dir, 'bun.lockb') || has(dir, 'bun.lock') ? 'bun run' : 'npm run';
    const names = Object.keys(pkg.scripts), rank = n => ['dev', 'start', 'serve', 'develop', 'preview'].indexOf(n.split(':')[0]);
    for (const n of names.filter(n => /^(dev|start|serve|develop|preview)(:[\w-]+)?$/.test(n)).sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, 5)) add(`${pm} ${n}`, `package.json: ${n}`);
  }
  if (has(dir, 'artisan') && has(dir, 'composer.json')) add('php artisan serve', 'composer.json + artisan');
  if (has(dir, 'go.mod')) {
    const cmds = cmdDirs();
    if (cmds.length) for (const c of cmds.slice(0, 4)) add(`go run ./cmd/${c}`, `go.mod: cmd/${c}`); else add('go run .', 'go.mod');
  }
  const mk = ['Makefile', 'makefile', 'GNUmakefile'].find(n => has(dir, n));
  if (mk) { try { for (const m of text(mk).matchAll(/^((?:run|dev|serve|start|up|watch)(?:[-_][\w-]+)?)\s*:(?!=)/gm)) add(`make ${m[1]}`, `Makefile: ${m[1]}`); } catch {} }
  if (has(dir, 'pubspec.yaml')) add('flutter run -d chrome', 'pubspec.yaml');
  if (has(dir, 'manage.py')) add('python manage.py runserver', 'manage.py');
  if (has(dir, 'Cargo.toml')) add('cargo run', 'Cargo.toml');
  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(n => has(dir, n))) add('docker compose up', 'compose');
  return out.slice(0, 8);
}

/* ---------------- registri ---------------- */
function room(office, id) {
  const m = officeModel(office);
  return { m, room: m.plan.rooms.find(r => r.id === id) };
}
/** Folder ruangan. Ruangan di Mac lain: path di mesin itu (pakai placeOf/suggestRoom untuk tahu mesinnya). */
export function roomDir(office, roomId) {
  const { m, room: r } = room(office, roomId);
  const w = remoteRoomOf(m, r);
  if (w) return w.cwd;
  const d = r?.path ? path.join(m.root, r.path) : m.root;
  return fs.existsSync(d) ? d : m.root;
}
/** Tempat proses ruangan jalan: { machine: id Mac lain | null, dir }. */
export function placeOf(office, roomId) {
  const { m, room: r } = room(office, roomId);
  const w = remoteRoomOf(m, r);
  return w ? { machine: w.machine, dir: w.cwd } : { machine: null, get dir() { return roomDir(office, roomId); } }; // lokal: folder dicek hanya kalau dipakai
}
// berkas proses di Mac lain: <root kantor-node>/proc/<kantor>/<id>.{log,exit,go}; log ditulis pipe-pane di mesin itu
const rfile = (machine, office, id, ext) => path.posix.join(mx.machineRoot(machine), 'proc', safe(office), `${safe(id)}.${ext}`);
const offlineErr = machine => Object.assign(new Error(`Mesin ${machineLabel(machine)} sedang tidak terjangkau. Coba lagi setelah mesinnya online.`), { code: 503 });
/** Sesi tmux yang hidup, per mesin, sekali per putaran: null = mesin tak terjangkau (jangan dianggap mati). */
function sessCtx() {
  let local = null;
  const rem = new Map();
  return machine => {
    if (!machine) return local ||= new Set(tmuxSessions());
    if (!rem.has(machine)) { const n = mx.isOffline(machine) ? null : mx.remoteTmuxSessions(machine); rem.set(machine, n ? new Set(n) : null); }
    return rem.get(machine);
  };
}
/** Fakta berkas proses di Mac lain dalam satu panggilan: { go, size, mtime, exit }. */
function remoteFacts(machine, office, id) {
  const st = f => `stat -f '%z %m' ${mx.q(f)} 2>/dev/null || stat -c '%s %Y' ${mx.q(f)} 2>/dev/null || echo -`;
  try {
    const [g, l, e] = mx.shSync(machine, `${st(rfile(machine, office, id, 'go'))}; ${st(rfile(machine, office, id, 'log'))}; cat ${mx.q(rfile(machine, office, id, 'exit'))} 2>/dev/null || echo -`, { timeout: 8000 }).split('\n');
    const n = x => (x && x !== '-' ? x.split(' ').map(Number) : null);
    const go = n(g), lg = n(l), code = parseInt(e, 10);
    return { go: go ? go[1] * 1000 : null, size: lg ? lg[0] : 0, mtime: lg ? lg[1] * 1000 : 0, logExists: !!lg, exit: Number.isFinite(code) ? code : null };
  } catch { return null; }
}
const rows = office => all(officeDb(office), 'SELECT * FROM procs ORDER BY rowid');
const rowOf = (office, id) => one(officeDb(office), 'SELECT * FROM procs WHERE id = ?', id);
const need = (office, id) => { const r = rowOf(office, id); if (!r) throw Object.assign(new Error('Proses tidak ditemukan'), { code: 404 }); return r; };
const mem = new Map(); // office/id -> { stopping, port cache }
const M = (office, id) => { const k = `${office}/${id}`; let v = mem.get(k); if (!v) mem.set(k, v = {}); return v; };

function readExit(office, id) {
  try { const n = parseInt(fs.readFileSync(file(office, id, 'exit'), 'utf8'), 10); return Number.isFinite(n) ? n : null; } catch { return null; }
}
function view(office, r, ctx = sessCtx()) {
  const pl = placeOf(office, r.room);
  if (pl.machine) return viewRemote(office, r, pl, ctx);
  const sessions = ctx(null);
  const running = sessions.has(sessName(office, r)), v = M(office, r.id), logf = file(office, r.id, 'log');
  let st = 'berhenti', code = null, since = null, port = null, url = null;
  if (running) {
    st = 'jalan';
    try { since = fs.statSync(file(office, r.id, 'go')).mtime.toISOString(); } catch {}
    let sz = 0, mt = 0; try { const s = fs.statSync(logf); sz = s.size; mt = s.mtimeMs; } catch {}
    if (v.pk !== `${sz}:${mt}`) { v.pk = `${sz}:${mt}`; v.pd = detectPort(readTail(logf).text); }
    if (v.pd) ({ port, url } = v.pd);
  } else {
    v.stopping = false; v.pd = null; v.pk = null;
    code = readExit(office, r.id);
    // 130/143/137 = Ctrl-C / SIGTERM / SIGKILL: stopped on purpose, not a crash
    if (code != null && code !== 0 && ![130, 143, 137].includes(code)) st = 'gagal';
  }
  const rm = room(office, r.room).room;
  return { id: r.id, room: r.room, roomName: rm?.name || r.room, name: r.name, cmd: r.cmd, auto: !!r.auto, pending: !!r.pending, status: st, code, port, url, since, stopping: !!(running && v.stopping), ran: fs.existsSync(logf) };
}
function viewRemote(office, r, pl, ctx) {
  const name = sessName(office, r), v = M(office, r.id), rm = room(office, r.room).room;
  mx.setTmuxMachine(name, pl.machine);
  const base = { id: r.id, room: r.room, roomName: rm?.name || r.room, name: r.name, cmd: r.cmd, auto: !!r.auto, pending: !!r.pending, machine: pl.machine, machineName: machineLabel(pl.machine) };
  const names = ctx(pl.machine), f = names && remoteFacts(pl.machine, office, r.id);
  if (!names || !f) return { ...base, status: 'tak terjangkau', machineOffline: true, code: null, port: null, url: null, since: null, stopping: false, ran: false };
  const running = names.has(name);
  let st = 'berhenti', code = null, since = null, port = null, url = null;
  if (running) {
    st = 'jalan';
    if (f.go) since = new Date(f.go).toISOString();
    if (v.pk !== `${f.size}:${f.mtime}`) {
      v.pk = `${f.size}:${f.mtime}`;
      const n = Math.min(f.size, 48 * 1024);
      v.pd = detectPort(mx.readFrom(pl.machine, rfile(pl.machine, office, r.id, 'log'), f.size - n, n).toString('utf8'));
    }
    if (v.pd) ({ port, url } = v.pd);
  } else {
    v.stopping = false; v.pd = null; v.pk = null;
    code = f.exit;
    if (code != null && code !== 0 && ![130, 143, 137].includes(code)) st = 'gagal';
  }
  v.size = f.size;
  return { ...base, status: st, code, port, url, since, stopping: !!(running && v.stopping), ran: f.logExists };
}
export function listProcs(office) {
  const s = sessCtx();
  const out = rows(office).map(r => view(office, r, s));
  for (const v of out) if (v.machine && v.status === 'jalan' && !watching.has(`${office}/${v.id}`)) watch(office, v.id); // setelah daemon mulai ulang
  return out;
}
export function getProc(office, id) { return view(office, need(office, id)); }
const emit = (office, proc) => bus.emit('msg', { t: 'proc', office, proc });

function clean(b, cur = {}) {
  const cmd = String(b.cmd ?? cur.cmd ?? '').trim();
  if (!cmd) throw new Error('Perintah belum diisi');
  if (cmd.length > 2000) throw new Error('Perintah terlalu panjang');
  const name = String(b.name ?? cur.name ?? '').trim().slice(0, 60) || cmd.slice(0, 40);
  return { cmd, name };
}
export function createProc(office, b, { pending = false, auto = false } = {}) {
  const roomId = String(b.room || '');
  if (!room(office, roomId).room) throw new Error('Ruangan tidak ditemukan');
  const { cmd, name } = clean(b);
  const id = newId('p');
  run(officeDb(office), 'INSERT INTO procs (id, room, name, cmd, auto, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, roomId, name, cmd, auto ? 1 : 0, pending ? 1 : 0, nowIso());
  const v = getProc(office, id); emit(office, v); return v;
}
export function updateProc(office, id, b) {
  const cur = need(office, id), { cmd, name } = clean(b, cur);
  let roomId = cur.room;
  if (b.room && b.room !== cur.room) { if (!room(office, b.room).room) throw new Error('Ruangan tidak ditemukan'); if (isUp(office, cur)) throw new Error('Hentikan proses dulu sebelum memindahkannya ke ruangan lain'); roomId = b.room; }
  if (isUp(office, cur) && cmd !== cur.cmd) throw new Error('Hentikan proses dulu sebelum mengganti perintahnya');
  run(officeDb(office), 'UPDATE procs SET name = ?, cmd = ?, room = ? WHERE id = ?', name, cmd, roomId, id);
  const v = getProc(office, id); emit(office, v); return v;
}
export function approveProc(office, id) {
  need(office, id);
  run(officeDb(office), 'UPDATE procs SET pending = 0 WHERE id = ?', id);
  const v = getProc(office, id); emit(office, v); return v;
}
export function removeProc(office, id) {
  const r = need(office, id), name = sessName(office, r), pl = placeOf(office, r.room);
  const up = isUp(office, r);
  if (up === null) throw offlineErr(pl.machine); // jangan tinggalkan proses yatim di mesin itu
  if (up) try { tmux(['kill-session', '-t', name]); } catch {}
  run(officeDb(office), 'DELETE FROM procs WHERE id = ?', id);
  if (pl.machine) try { mx.shSync(pl.machine, `rm -f ${['log', 'exit', 'go'].map(e => mx.q(rfile(pl.machine, office, id, e))).join(' ')}`); } catch {}
  for (const e of ['log', 'exit', 'go']) try { fs.unlinkSync(file(office, id, e)); } catch {}
  mem.delete(`${office}/${id}`); watching.delete(`${office}/${id}`);
  bus.emit('msg', { t: 'proc', office, removed: id });
  return { ok: true };
}
/** Sesi tmux proses ini hidup? null = mesinnya tak terjangkau. */
const isUp = (office, r) => {
  const pl = placeOf(office, r.room), name = sessName(office, r);
  if (!pl.machine) return tmuxSessions().includes(name);
  mx.setTmuxMachine(name, pl.machine);
  if (mx.isOffline(pl.machine)) return null;
  const n = mx.remoteTmuxSessions(pl.machine, { fresh: true });
  return n ? n.includes(name) : null;
};

/* ---------------- menjalankan ---------------- */
function trimLog(f) {
  try {
    if (fs.statSync(f).size <= LOG_MAX) return;
    const { text } = readTail(f, LOG_KEEP), i = text.indexOf('\n');
    fs.truncateSync(f, 0); // writers append (O_APPEND), so they continue at the new end
    fs.appendFileSync(f, '[… log lama dipotong …]\n' + (i >= 0 ? text.slice(i + 1) : text));
  } catch {}
}
export function startProc(office, id) {
  const r = need(office, id);
  if (r.pending) throw new Error('Perintah ini menunggu persetujuanmu dulu');
  const name = sessName(office, r), pl = placeOf(office, r.room);
  const up = isUp(office, r);
  if (up === null) throw offlineErr(pl.machine);
  if (up) return view(office, r);
  if (pl.machine) return startRemote(office, r, pl);
  fs.mkdirSync(procDir(office), { recursive: true, mode: 0o700 });
  const go = file(office, id, 'go'), ex = file(office, id, 'exit'), log = file(office, id, 'log');
  for (const f of [go, ex]) try { fs.unlinkSync(f); } catch {}
  trimLog(log);
  fs.appendFileSync(log, `\x1b[2m── ${r.cmd} · ${new Date().toLocaleString('id-ID')} ──\x1b[0m\r\n`);
  // wait for the gate file so pipe-pane is attached before the first byte; trap : INT keeps this wrapper alive on Ctrl-C (children still get the default handler); the command runs in a subshell so its own `exit` still reports a code
  const inner = `trap : INT; until [ -e ${q(go)} ]; do sleep 0.05; done\n(\n${r.cmd}\n)\nkc=$?; echo $kc > ${q(ex)}; printf '\\n[proses selesai, kode %s]\\n' "$kc"`;
  tmux(['new-session', '-d', '-s', name, '-c', roomDir(office, r.room), '-x', '160', '-y', '50', '/bin/zsh', '-lc', inner]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'history-limit', '20000']); tmux(['set-option', '-t', name, 'mouse', 'on']); } catch {}
  tmux(['pipe-pane', '-t', name, `cat >> ${q(log)}`]);
  fs.writeFileSync(go, nowIso());
  M(office, id).stopping = false;
  watch(office, id);
  const v = view(office, r); emit(office, v); return v;
}
/** Proses di Mac lain: sesi tmux, gerbang, kode keluar, dan log semuanya di mesin itu. */
function startRemote(office, r, pl) {
  const { machine } = pl, name = sessName(office, r), id = r.id;
  const go = rfile(machine, office, id, 'go'), ex = rfile(machine, office, id, 'exit'), log = rfile(machine, office, id, 'log');
  const head = `\x1b[2m── ${r.cmd} · ${new Date().toLocaleString('id-ID')} ──\x1b[0m\r\n`;
  mx.shSync(machine, `umask 077; mkdir -p ${mx.q(path.posix.dirname(log))} && rm -f ${mx.q(go)} ${mx.q(ex)} && ${trimRemote(log)}; printf '%s' ${mx.q(head)} >> ${mx.q(log)}`);
  const inner = `trap : INT; until [ -e ${q(go)} ]; do sleep 0.05; done\n(\n${r.cmd}\n)\nkc=$?; echo $kc > ${q(ex)}; printf '\\n[proses selesai, kode %s]\\n' "$kc"`;
  mx.setTmuxMachine(name, machine);
  tmux(['new-session', '-d', '-s', name, '-c', pl.dir, '-x', '160', '-y', '50', '/bin/zsh', '-lc', inner], { machine });
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'history-limit', '20000']); tmux(['set-option', '-t', name, 'mouse', 'on']); } catch {}
  tmux(['pipe-pane', '-t', name, `cat >> ${q(log)}`]);
  mx.writeFile(machine, go, nowIso());
  M(office, id).stopping = false;
  watch(office, id);
  const v = view(office, r); emit(office, v); return v;
}
/** Potong log di mesin itu kalau lewat LOG_MAX (sama seperti trimLog: sisakan LOG_KEEP, mulai dari baris utuh). */
const trimRemote = log => `{ f=${mx.q(log)}; s=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0); if [ "$s" -gt ${LOG_MAX} ]; then tail -c ${LOG_KEEP} "$f" | tail -n +2 > "$f.kc-trim" && : > "$f" && printf '[… log lama dipotong …]\\n' >> "$f" && cat "$f.kc-trim" >> "$f"; rm -f "$f.kc-trim"; fi; }`;

/** Ctrl-C first; if it is still there after the grace period, kill the session. */
export function stopProc(office, id) {
  const r = need(office, id), name = sessName(office, r);
  const up = isUp(office, r);
  if (up === null) throw offlineErr(placeOf(office, r.room).machine);
  if (!up) return view(office, r);
  M(office, id).stopping = true;
  try { tmux(['send-keys', '-t', name, 'C-c']); } catch {}
  setTimeout(() => { try { if (isUp(office, r)) tmux(['kill-session', '-t', name]); } catch {} }, GRACE_MS).unref();
  watch(office, id);
  const v = view(office, r); emit(office, v); return v;
}
export async function restartProc(office, id) {
  const r = need(office, id);
  if (isUp(office, r)) {
    stopProc(office, id);
    for (let i = 0; i < 40 && isUp(office, r); i++) await new Promise(res => setTimeout(res, 200));
    if (isUp(office, r)) throw new Error('Proses belum berhenti, coba lagi sebentar lagi');
  }
  return startProc(office, id);
}

/* ---------------- pantauan: kirim perubahan ke browser ---------------- */
const watching = new Map(); // office/id -> last signature
let timer = null;
function watch(office, id) {
  watching.set(`${office}/${id}`, null);
  timer ||= setInterval(tick, 2000).unref();
}
function tick() {
  if (!watching.size) return;
  const s = sessCtx();
  for (const k of [...watching.keys()]) {
    const [office, id] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
    let r; try { r = rowOf(office, id); } catch {}
    if (!r) { watching.delete(k); continue; }
    const v = view(office, r, s), sig = `${v.status}|${v.code}|${v.url}|${v.stopping}`;
    if (watching.get(k) !== sig) { if (watching.get(k) !== null) emit(office, v); watching.set(k, sig); }
    if (v.machine) { // Mac lain: tak terjangkau tetap dipantau (sesinya mungkin masih jalan); log dipotong di sana
      if (v.status === 'berhenti' || v.status === 'gagal') watching.delete(k);
      else if (v.status === 'jalan' && M(office, id).size > LOG_MAX) try { mx.shSync(v.machine, trimRemote(rfile(v.machine, office, id, 'log'))); } catch {}
      continue;
    }
    if (v.status !== 'jalan') watching.delete(k); else trimLog(file(office, id, 'log'));
  }
}
/** On daemon start: processes whose tmux session survived are watched again. */
export function discoverProcs() {
  const s = new Set(tmuxSessions());
  for (const o of listOffices()) {
    let rs = []; try { rs = rows(o.id); } catch { continue; }
    for (const r of rs) {
      let pl; try { pl = placeOf(o.id, r.room); } catch { continue; }
      // Mac lain: hanya catat mesinnya (tanpa ssh saat daemon mulai); dipantau lagi begitu listProcs melihatnya jalan
      if (pl.machine) { mx.setTmuxMachine(sessName(o.id, r), pl.machine); continue; }
      if (s.has(sessName(o.id, r))) watch(o.id, r.id);
    }
  }
}

/* ---------------- log ---------------- */
/** Raw bytes from `offset` (for the dock's live log); offset omitted = last 64 KB. */
export function readLog(office, id, offset) {
  const r = need(office, id), pl = placeOf(office, r.room);
  const f = pl.machine ? rfile(pl.machine, office, id, 'log') : file(office, id, 'log');
  let size = 0;
  if (pl.machine) size = mx.statFile(pl.machine, f)?.size || 0; else try { size = fs.statSync(f).size; } catch {}
  let from = offset == null || !Number.isFinite(offset) ? Math.max(0, size - 64 * 1024) : offset;
  if (from > size) from = Math.max(0, size - 64 * 1024); // log was cut
  let n = Math.min(size - from, 256 * 1024), buf = Buffer.alloc(n);
  if (n > 0 && pl.machine) { buf = mx.readFrom(pl.machine, f, from, n); n = buf.length; }
  else if (n > 0) { const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, n, from); } finally { fs.closeSync(fd); } }
  // never split a UTF-8 character between two polls
  let skip = 0; while (skip < n && skip < 3 && (buf[skip] & 0xC0) === 0x80 && from > 0) skip++;
  for (let i = n - 1; i >= Math.max(skip, n - 3); i--) if (buf[i] >= 0xC0) { if (i + (buf[i] >= 0xF0 ? 4 : buf[i] >= 0xE0 ? 3 : 2) > n) n = i; break; }
  return { from: from + skip, next: from + n, size, text: buf.subarray(skip, n).toString('utf8') };
}
export function logLines(office, id, lines = 80) {
  const r = need(office, id), pl = placeOf(office, r.room);
  let raw;
  if (pl.machine) {
    const f = rfile(pl.machine, office, id, 'log'), size = mx.statFile(pl.machine, f)?.size || 0, n = Math.min(size, 256 * 1024);
    raw = n ? mx.readFrom(pl.machine, f, size - n, n).toString('utf8') : '';
  } else raw = readTail(file(office, id, 'log'), 256 * 1024).text;
  const t = stripAnsi(raw).split('\n');
  while (t.length && !t.at(-1).trim()) t.pop();
  return t.slice(-Math.max(1, Math.min(2000, lines))).join('\n');
}

/* ---------------- terminal dok (tmux kct-<kantor>-<hex>) ---------------- */
const TERM_RE = /^kct-(.+)-([0-9a-f]{4,6})$/;
const TERM_FMT = '#{session_name}\t#{@kc_title}\t#{@kc_room}\t#{session_created}\t#{pane_current_command}';
const termRows = (out, office, machine) => out.split('\n').filter(Boolean).map(l => {
  const [name, title, rm, created, cur] = l.split('\t'), m = TERM_RE.exec(name);
  if (!m || m[1] !== safe(office)) return null;
  if (machine) mx.setTmuxMachine(name, machine);
  return { name, title: title || 'zsh', room: rm || null, created: Number(created) * 1000 || 0, busy: !!cur && !/^-?(zsh|bash|sh|fish|dash|tmux)$/.test(cur), ...(machine ? { machine, machineName: machineLabel(machine) } : {}) };
}).filter(Boolean);
/** Mesin lain yang punya ruangan di kantor ini. */
function officeMachines(office) {
  let m; try { m = officeModel(office); } catch { return []; }
  return [...new Set((m?.plan.rooms || []).map(r => remoteRoomOf(m, r)?.machine).filter(Boolean))];
}
export function listTerms(office) {
  let out = '';
  try { out = tmux(['list-sessions', '-F', TERM_FMT]); } catch { out = null; }
  const remote = officeMachines(office);
  if (out === null && !remote.length) return [];
  const byName = new Map((out ? termRows(out, office, null) : []).filter(t => !mx.isRemote(mx.tmuxMachineOf(t.name))).map(t => [t.name, t]));
  for (const machine of remote) { // terminal dok di Mac lain: tmux di mesin itu; mesin offline dilewati
    if (mx.isOffline(machine)) continue;
    try { for (const t of termRows(tmux(['list-sessions', '-F', TERM_FMT], { machine, timeout: 8000 }), office, machine)) byName.set(t.name, t); } catch {}
  }
  return [...byName.values()].sort((a, b) => a.created - b.created);
}
export function createTerm(office, roomId) {
  const { m, room: r } = room(office, roomId || '');
  if (roomId && !r) throw new Error('Ruangan tidak ditemukan');
  const name = `kct-${safe(office)}-${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
  const base = r?.name || 'zsh', n = listTerms(office).filter(t => t.title === base || t.title.startsWith(base + ' ')).length;
  const title = n ? `${base} ${n + 1}` : base;
  const pl = r ? placeOf(office, r.id) : { machine: null, dir: m.root };
  if (pl.machine) {
    if (mx.isOffline(pl.machine)) throw offlineErr(pl.machine);
    mx.setTmuxMachine(name, pl.machine);
  }
  tmux(['new-session', '-d', '-s', name, '-c', pl.dir, '-x', '200', '-y', '50'], pl.machine ? { machine: pl.machine } : {});
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); tmux(['set-option', '-t', name, '@kc_title', title]); tmux(['set-option', '-t', name, '@kc_room', r?.id || '']); } catch {}
  return { name, title, room: r?.id || null, created: Date.now(), ...(pl.machine ? { machine: pl.machine, machineName: machineLabel(pl.machine) } : {}) };
}
function termOf(office, name) {
  const t = listTerms(office).find(x => x.name === name);
  if (!t) throw Object.assign(new Error('Terminal tidak ditemukan'), { code: 404 });
  return t;
}
export function renameTerm(office, name, title) {
  termOf(office, name);
  const t = String(title || '').trim().slice(0, 40);
  if (!t) throw new Error('Nama kosong');
  tmux(['set-option', '-t', name, '@kc_title', t]);
  return termOf(office, name);
}
export function closeTerm(office, name) {
  termOf(office, name);
  try { tmux(['kill-session', '-t', name]); } catch {}
  return { ok: true };
}
/** Session names the dock WebSocket may attach to. */
export function dockSessionOk(name) {
  if (!/^kc[tp]-[A-Za-z0-9_-]+$/.test(name || '')) return false;
  const known = mx.tmuxMachineOf(name);
  if (mx.isRemote(known)) return !!mx.remoteTmuxSessions(known, { fresh: true })?.includes(name);
  if (tmuxSessions().includes(name)) return true;
  // belum tercatat (mis. daemon baru mulai ulang): cari di mesin lain yang online, lalu catat mesinnya untuk attach
  for (const m of mx.listMachines()) {
    if (m.disabled || mx.isOffline(m.id)) continue;
    if (mx.remoteTmuxSessions(m.id)?.includes(name)) { mx.setTmuxMachine(name, m.id); return true; }
  }
  return false;
}

/* ---------------- tool agen ---------------- */
const pick = v => ({ id: v.id, ruangan: v.roomName, ruangan_id: v.room, ...(v.machine ? { mesin: v.machineName, mesin_offline: v.machineOffline || undefined } : {}), nama: v.name, perintah: v.cmd, status: v.status, kode_keluar: v.code ?? undefined, port: v.port || undefined, url: v.url || undefined, menunggu_persetujuan: v.pending || undefined });
export const agentList = office => listProcs(office).map(pick);
export function agentRun(office, a) {
  if (a.id) {
    const r = need(office, a.id);
    if (r.pending) return 'Perintah itu masih menunggu persetujuan pengguna di dok Proses. Belum dijalankan.';
    const v = startProc(office, a.id);
    return `Proses "${v.name}" (${v.id}) dijalankan di ${v.roomName}${v.machine ? ` (Mac ${v.machineName})` : ''}. Pantau dengan proses_log.`;
  }
  const cmd = String(a.perintah || '').trim();
  if (!cmd) throw new Error('Isi id proses yang sudah terdaftar, atau room + perintah.');
  const m = officeModel(office), key = String(a.room || '').toLowerCase();
  const rm = m.plan.rooms.find(r => r.id === a.room) || m.plan.rooms.find(r => r.name.toLowerCase() === key);
  if (!rm) throw new Error(`Ruangan "${a.room || ''}" tidak ditemukan. Pakai room id dari proses_list atau sessions_list.`);
  const same = rows(office).find(r => r.room === rm.id && r.cmd === cmd);
  if (same?.pending) return 'Perintah itu sudah diusulkan dan menunggu persetujuan pengguna di dok Proses.';
  if (same) { const v = startProc(office, same.id); return `Perintah itu sudah terdaftar; proses "${v.name}" (${v.id}) dijalankan.`; }
  const v = createProc(office, { room: rm.id, cmd, name: a.nama }, { pending: true });
  return `Perintah "${cmd}" belum terdaftar, jadi TIDAK dijalankan. Sudah diusulkan (id ${v.id}) dan menunggu persetujuan pengguna di dok Proses (tombol ⌨ di atas). Beri tahu pengguna, lalu jalankan lagi dengan id ini setelah disetujui.`;
}
export function agentLog(office, a) {
  const t = logLines(office, a.id, a.baris || 80);
  return t || '(log kosong)';
}
export function agentStop(office, id) {
  const v = stopProc(office, id);
  return v.status === 'jalan' ? `Ctrl-C dikirim ke "${v.name}"; dihentikan paksa dalam ${GRACE_MS / 1000} detik bila belum berhenti.` : `"${v.name}" memang sedang tidak jalan.`;
}
