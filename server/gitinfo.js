// Git state per room: read-only snapshots (status, log, stash, diff) and an explicit, narrow commit.
// git runs through execFile (no shell), with timeouts, at most 4 processes at once, and never takes optional locks.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { officeModel, roomForCwd } from './offices.js';

const TTL = 30e3;
const PR_TTL = 5 * 60e3;
const MAX_DIFF = 200 * 1024;
const MAX_UNTRACKED = 512 * 1024;
const MAX_PROCS = 4;

let sink = { emit() {}, log() {} };
/** live.js hands over the event bus and the office log, so this module never imports it. */
export function setSink(s) { sink = { ...sink, ...s }; }

const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });

/* ---------------- process pool ---------------- */
let busy = 0;
const waiting = [];
const slot = () => new Promise(r => { if (busy < MAX_PROCS) { busy++; r(); } else waiting.push(r); });
const release = () => { const n = waiting.shift(); if (n) n(); else busy--; };

/** Resolves {code, out, err, cut} for any exit code; rejects only when the binary cannot run or times out. */
async function exec(bin, args, { cwd, timeout = 8000, max = 4e6, input } = {}) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile(bin, args, {
        cwd, timeout, maxBuffer: max, encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, out: stdout, err: stderr });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: 0, out: String(err.stdout || '').slice(0, max), err: '', cut: true });
        if (typeof err.code === 'number') return resolve({ code: err.code, out: stdout || '', err: stderr || '' });
        reject(err.killed ? new Error('git terlalu lama') : err);
      });
      if (input !== undefined) child.stdin.end(input);
    });
  } finally { release(); }
}
const git = (args, o) => exec('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], o);

/* ---------------- room -> repo ---------------- */
const tops = new Map(); // dir -> {top, prefix} | null

async function repoOf(dir) {
  if (tops.has(dir)) return tops.get(dir);
  let r = null;
  if (fs.existsSync(dir)) {
    const t = await git(['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: dir, timeout: 5000 }).catch(() => null);
    if (t && t.code === 0) {
      const [top, prefix = ''] = t.out.split('\n');
      r = { top, prefix: prefix.replace(/\/$/, '') };
    }
  }
  if (r) tops.set(dir, r); // a folder that is not a repo yet is asked again next time
  return r;
}

/** { abs, room } for a room that has a folder; null when the office or room is unknown. */
function locate(office, roomId) {
  const m = officeModel(office);
  const room = m?.plan.rooms.find(r => r.id === roomId);
  if (!room || typeof room.path !== 'string') return null;
  const abs = path.resolve(m.root, room.path);
  if (abs !== m.root && !abs.startsWith(m.root + path.sep)) return null;
  return { abs, room };
}

async function target(office, roomId) {
  const loc = locate(office, roomId);
  if (!loc) throw fail('Ruangan ini tidak punya folder', 404);
  const repo = await repoOf(loc.abs);
  if (!repo) throw fail('Ruangan ini bukan repo git');
  return { ...loc, ...repo };
}

/* ---------------- status ---------------- */
const scopeOf = repo => repo.prefix || '.';

function parseStatus(out) {
  const recs = out.split('\0');
  const head = recs.shift() || '';
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2), file = rec.slice(3);
    let from = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') from = recs[++i] || null;
    files.push({ file, xy, from, untracked: xy === '??', conflict: /U|AA|DD/.test(xy) });
  }
  let branch = null, upstream = null, ahead = 0, behind = 0, detached = false;
  const h = head.replace(/^## /, '');
  let m;
  if ((m = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(h))) branch = m[1];
  else if (/^HEAD \(no branch\)/.test(h)) { branch = 'HEAD'; detached = true; }
  else {
    m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
    if (m) {
      branch = m[1]; upstream = m[2] || null;
      const a = /ahead (\d+)/.exec(m[3] || ''), b = /behind (\d+)/.exec(m[3] || '');
      ahead = a ? Number(a[1]) : 0; behind = b ? Number(b[1]) : 0;
    }
  }
  return { branch, upstream, ahead, behind, detached, files };
}

const statusOf = repo => git(['status', '--porcelain=v1', '-b', '-z', '--', scopeOf(repo)], { cwd: repo.top });

/* ---------------- snapshot ---------------- */
const cache = new Map(); // top+prefix -> {at, info, p}
const prCache = new Map(); // top -> {at, list, busy}
let ghMissing = !!process.env.KANTOR_NO_GH;

function prsFor(repo, office, remote) {
  if (ghMissing || !/github\.com/.test(remote || '')) return undefined;
  const c = prCache.get(repo.top) || {};
  if (!c.busy && !(c.at && Date.now() - c.at < PR_TTL)) {
    const next = { ...c, busy: true };
    prCache.set(repo.top, next);
    exec('gh', ['pr', 'list', '--json', 'number,title,headRefName,url', '--limit', '5'], { cwd: repo.top, timeout: 5000, max: 1e6 })
      .then(r => {
        const list = r.code === 0 ? JSON.parse(r.out || '[]') : null;
        prCache.set(repo.top, { at: Date.now(), list, busy: false });
        cache.delete(keyOf(repo));
        sink.emit({ t: 'changed', office, what: 'git' });
      })
      .catch(e => {
        if (e.code === 'ENOENT') ghMissing = true;
        prCache.set(repo.top, { at: Date.now(), list: null, busy: false });
      });
  }
  return c.list === undefined ? null : c.list; // null: not known (yet)
}

const keyOf = repo => repo.top + '\0' + repo.prefix;

async function compute(repo, office) {
  const [st, log, stash, remote] = await Promise.all([
    statusOf(repo),
    git(['log', '-1', '--format=%h%x00%s%x00%cI'], { cwd: repo.top }),
    git(['stash', 'list'], { cwd: repo.top }),
    git(['remote', 'get-url', 'origin'], { cwd: repo.top, timeout: 3000 }),
  ]);
  if (st.code !== 0) return null;
  const s = parseStatus(st.out);
  const [hash, subject, at] = log.code === 0 ? log.out.trim().split('\0') : [];
  const info = {
    branch: s.detached ? '(detached)' : s.branch, upstream: s.upstream,
    dirty: s.files.length, untracked: s.files.filter(f => f.untracked).length,
    ahead: s.ahead, behind: s.behind,
    last: hash ? { hash, subject, at } : null,
    stash: stash.code === 0 ? stash.out.split('\n').filter(Boolean).length : 0,
  };
  const prs = prsFor(repo, office, remote.code === 0 ? remote.out.trim() : '');
  if (prs !== undefined) info.prs = prs;
  return info;
}

async function snapshot(repo, office, force = false) {
  const key = keyOf(repo);
  const c = cache.get(key);
  if (c && !force && (c.p || Date.now() - c.at < TTL)) return c.p || c.info;
  const p = compute(repo, office);
  cache.set(key, { at: Date.now(), info: c?.info || null, p });
  try {
    const info = await p;
    cache.set(key, { at: Date.now(), info });
    return info;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

/** Git info for every room of an office that sits in a repo (`fresh` skips the 30 s cache): { <roomId>: {branch, dirty, ahead, …} } */
export async function officeGit(office, { fresh = false } = {}) {
  const m = officeModel(office);
  const rooms = {};
  if (!m) return rooms;
  await Promise.all(m.plan.rooms.map(async r => {
    const loc = locate(office, r.id);
    if (!loc) return;
    try {
      const repo = await repoOf(loc.abs);
      if (!repo) return;
      const info = await snapshot(repo, office, fresh);
      if (info) rooms[r.id] = info;
    } catch {}
  }));
  return rooms;
}

/* ---------------- refresh after work in a room ---------------- */
const timers = new Map();
/** Called from hooks (edits, git commands, Stop): recompute shortly after and announce only if something changed. */
export function touch(office, roomId) {
  if (!office || !roomId) return;
  const key = office + '\0' + roomId;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    try {
      const loc = locate(office, roomId);
      const repo = loc && await repoOf(loc.abs);
      if (!repo) return;
      const before = cache.get(keyOf(repo))?.info;
      const after = await snapshot(repo, office, true);
      if (after && JSON.stringify(before) !== JSON.stringify(after)) sink.emit({ t: 'changed', office, what: 'git', room: roomId });
    } catch {}
  }, 1500).unref());
}

/** The room a PostToolUse touched, or null when it cannot have changed a repo. */
export function roomOfToolUse(office, p, fallbackRoom) {
  const tool = p.tool_name, input = p.tool_input || {};
  const edit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
  if (!edit && !(tool === 'Bash' && /\b(git|gh)\b/.test(input.command || ''))) return null;
  const m = officeModel(office);
  if (!m) return fallbackRoom || null;
  const where = edit ? (input.file_path || input.notebook_path) : p.cwd;
  if (where && path.isAbsolute(where)) return roomForCwd(m, where).room;
  return fallbackRoom || null;
}

/* ---------------- changed files and diffs ---------------- */
async function changes(repo) {
  const st = await statusOf(repo);
  if (st.code !== 0) throw fail('Gagal membaca status git');
  const { files } = parseStatus(st.out);
  const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo.top })).code === 0;
  const num = new Map();
  const ns = await git(['diff', '--numstat', '--no-ext-diff', '--no-renames', ...(hasHead ? ['HEAD'] : ['--cached']), '--', scopeOf(repo)], { cwd: repo.top });
  if (ns.code === 0) for (const l of ns.out.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(l);
    if (m) num.set(m[3], m[1] === '-' ? { binary: true } : { add: Number(m[1]), del: Number(m[2]) });
  }
  return { hasHead, files: files.map(f => {
    const n = num.get(f.file) || {};
    let add = n.add ?? null, del = n.del ?? null, binary = !!n.binary;
    if (f.untracked) {
      try {
        const abs = path.join(repo.top, f.file);
        const stt = fs.statSync(abs);
        if (stt.isFile() && stt.size <= MAX_UNTRACKED) {
          const buf = fs.readFileSync(abs);
          if (buf.includes(0)) binary = true;
          else { add = buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0); del = 0; }
        } else binary = stt.isFile();
      } catch {}
    }
    return { file: f.file, status: f.untracked ? '?' : f.xy.replace(/ /g, '').slice(0, 2), untracked: f.untracked, from: f.from, conflict: f.conflict, add, del, ...(binary ? { binary: true } : {}) };
  }) };
}

/** Without `file`: the changed files with +/- per file. With `file`: its unified diff, capped. */
export async function gitDiff(office, roomId, file) {
  const t = await target(office, roomId);
  const { hasHead, files } = await changes(t);
  if (!file) return { files };
  const f = files.find(x => x.file === file);
  if (!f) throw fail('File itu tidak ada di daftar perubahan', 404);
  if (f.binary) return { file, binary: true, diff: '', truncated: false };
  let r;
  if (f.untracked) r = await git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], { cwd: t.top, max: MAX_DIFF });
  else r = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...(hasHead ? ['HEAD'] : ['--cached']), '--', file], { cwd: t.top, max: MAX_DIFF });
  let diff = r.out, truncated = !!r.cut;
  if (diff.length > MAX_DIFF) { diff = diff.slice(0, MAX_DIFF); truncated = true; }
  return { file, diff, truncated };
}

/* ---------------- commit ---------------- */
const locks = new Map();
const serial = (key, fn) => {
  const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
  return run;
};

/**
 * Commit only what was asked for, never push. `files` = paths from the changed list (new files included only when
 * named); without files, every changed tracked file. Anything else already staged stays out (git commit --only).
 */
export async function gitCommit(office, roomId, { message, files } = {}) {
  const msg = typeof message === 'string' ? message.trim() : '';
  if (!msg) throw fail('Pesan commit kosong');
  if (msg.length > 5000) throw fail('Pesan commit terlalu panjang');
  if (files !== undefined && files !== null && !Array.isArray(files)) throw fail('files harus berupa daftar path');
  const t = await target(office, roomId);
  return serial(keyOf(t), async () => {
    const { files: changed } = await changes(t);
    if (changed.some(f => f.conflict)) throw fail('Ada konflik merge yang belum selesai', 409);
    let picked;
    if (files?.length) {
      picked = [];
      for (const name of files) {
        const f = changed.find(x => x.file === name);
        if (!f) throw fail(`Tidak ada perubahan di file: ${name}`, 409);
        picked.push(f);
      }
    } else picked = changed.filter(f => !f.untracked);
    if (!picked.length) throw fail('Tidak ada perubahan untuk di-commit', 409);
    const paths = [...new Set(picked.flatMap(f => f.from ? [f.file, f.from] : [f.file]))];
    const add = await git(['add', '-A', '--', ...paths], { cwd: t.top, timeout: 20000 });
    if (add.code !== 0) throw fail(`git add gagal: ${add.err.trim().slice(0, 300)}`);
    const c = await git(['commit', '-m', msg, '--only', '--', ...paths], { cwd: t.top, timeout: 90000 });
    if (c.code !== 0) throw fail(`git commit gagal: ${(c.err || c.out).trim().slice(0, 600)}`);
    const log = await git(['log', '-1', '--format=%h%x00%s%x00%cI'], { cwd: t.top });
    const [hash, subject, at] = log.out.trim().split('\0');
    const info = await snapshot(t, office, true);
    sink.log(office, 'Kamu', `commit di ${t.room.name || roomId}: ${hash} ${subject} (${picked.length} file)`, 'git');
    sink.emit({ t: 'changed', office, what: 'git', room: roomId });
    return { ok: true, hash, subject, at, files: picked.length, git: info };
  });
}

/** HEAD of a room's repo, for waits on a new commit: { sha, author, subject } or null when the room is no repo. One cheap git call. */
export async function headOf(office, roomId) {
  const t = await target(office, roomId).catch(() => null);
  if (!t) return null;
  const r = await git(['log', '-1', '--format=%H%x09%an%x09%s'], { cwd: t.abs, timeout: 5000 }).catch(() => null);
  if (!r || r.code !== 0 || !r.out.trim()) return null;
  const [sha, author = '', subject = ''] = r.out.trim().split('\t');
  return { sha, author, subject };
}
