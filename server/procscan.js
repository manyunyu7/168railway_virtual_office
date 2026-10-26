// Find running `claude` processes so sessions show up even when their hooks have been quiet
// (e.g. right after the daemon restarted, or for sessions started before hooks were installed).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PROJECTS_DIR, CLAUDE_DIR } from './config.js';
import { readTranscript } from './transcript.js';
import { run as dbRun } from './db.js';
import { globalDb, officeDb, all, one, nowIso } from './db.js';
import { live, expectSession, bus, serialize } from './live.js';
import { officeForCwd, officeModel, roomForCwd } from './offices.js';
import { tmux, reapGoneTmux } from './tmux.js';

const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 8000, maxBuffer: 4 << 20 }, (err, out) => resolve(err && !out ? '' : String(out || ''))));

/** Which app owns the terminal a process runs in, found by walking up its parents. */
function hostOf(table, pid) {
  for (let cur = table.get(pid), i = 0; cur && i < 12; cur = table.get(cur.ppid), i++) {
    const c = cur.comm;
    if (/Visual Studio Code|Code Helper|\/Code$|Cursor|Windsurf/.test(c)) return 'vscode';
    if (/iTerm/.test(c)) return 'iterm';
    if (/Terminal\.app|\/Terminal$/.test(c)) return 'terminal';
    if (/(^|\/)tmux/.test(c)) return 'tmux';
    if (/Ghostty|WezTerm|Alacritty|kitty|Warp/i.test(c)) return 'lain';
  }
  return 'lain';
}

// claude processes running in the office's own tmux panes, filled in by claudeProcesses()
let officePanes = [];

/** Claude Code's own record of which conversation a process is in (~/.claude/sessions/<pid>.json). */
export function sessionIdOf(pid) {
  try { return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', `${pid}.json`), 'utf8')).sessionId || null; } catch { return null; }
}

/** [{pid, tty, cwd, host}] for interactive claude processes (ones with a terminal). */
export async function claudeProcesses() {
  officePanes = [];
  const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm=']);
  const procs = new Map(), table = new Map();
  for (const line of ps.split('\n')) {
    const [pid, ppid, tty, ...rest] = line.trim().split(/\s+/);
    const comm = rest.join(' ');
    if (!pid) continue;
    table.set(pid, { ppid, comm });
    if (!tty || tty === '??' || !/(^|\/)claude$/.test(comm)) continue;
    procs.set(pid, { pid: Number(pid), tty: '/dev/' + tty, cwd: null });
  }
  for (const [pid, p] of procs) p.host = hostOf(table, pid);
  // panes the office itself runs (kc-*, kcm-*) are tracked through their tmux name, not their terminal
  let panes = '';
  try { panes = tmux(['list-panes', '-a', '-F', '#{pane_tty} #{session_name}']); } catch {}
  const paneOf = new Map(panes.split('\n').map(l => l.split(' ')).filter(([, n]) => /^kcm?-/.test(n || '')));
  for (const [pid, p] of procs) if (paneOf.has(p.tty)) { officePanes.push({ ...p, pane: paneOf.get(p.tty) }); procs.delete(pid); }
  if (!procs.size) return [];
  const lsof = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', [...procs.keys()].join(',')]);
  let cur = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) cur = procs.get(line.slice(1));
    else if (line.startsWith('n') && cur) cur.cwd = line.slice(1);
  }
  const starts = await run('/bin/ps', ['-o', 'pid=,lstart=', '-p', [...procs.keys()].join(',')]);
  for (const line of starts.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m && procs.has(m[1])) procs.get(m[1]).started = Date.parse(m[2]);
  }
  return [...procs.values()].filter(p => p.cwd);
}

/** The transcript a process is writing: same folder, first entry within 2 minutes of the process start. */
function transcriptFor(p, taken) {
  const dir = path.join(PROJECTS_DIR, p.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  for (const f of files) {
    const sid = f.slice(0, -6);
    if (taken.has(sid)) continue;
    const file = path.join(dir, f);
    let first = null;
    try {
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      first = m ? Date.parse(m[1]) : null;
    } catch {}
    if (!first || !p.started) continue;
    const gap = Math.abs(first - p.started);
    if (gap < 120e3 && (!best || gap < best.gap)) best = { sid, file, gap };
  }
  return best;
}

/** Office panes nobody on the floor owns (e.g. after /clear went unnoticed): bring them back with their role. */
function recoverPanes(g) {
  const panes = new Set(officePanes.map(p => p.pane));
  for (const s of [...live.values()]) if (s.sid.startsWith('pane-') && !panes.has(s.tmux)) { live.delete(s.sid); bus.emit('msg', { t: 'session-gone', office: s.office, sid: s.sid }); }
  // shift panes (kc-) claim a conversation before copies made by "move to office" (kcm-)
  for (const p of [...officePanes].sort((a, b) => a.pane.startsWith('kcm-') - b.pane.startsWith('kcm-'))) {
    if ([...live.values()].some(s => s.tmux === p.pane && s.status !== 'ended')) continue;
    const sid0 = sessionIdOf(p.pid);
    const row = (sid0 && one(g, 'SELECT * FROM sessions WHERE sid = ?', sid0)) || one(g, 'SELECT * FROM sessions WHERE tmux = ? ORDER BY last_seen DESC LIMIT 1', p.pane);
    if (!row?.office) continue;
    // the same conversation already shows up from another pane: this one is a copy
    const copy = sid0 && live.has(sid0) && live.get(sid0).tmux !== p.pane;
    const sid = copy || !sid0 ? `pane-${p.pane}` : sid0;
    if (live.has(sid)) continue;
    expectSession({ sid, office: row.office, role: row.role, room: row.room, cwd: p.cwd || row.cwd, tmux: p.pane, slot: 0, title: copy ? `Salinan ${row.title || 'sesi'}` : row.title });
    const s = live.get(sid);
    Object.assign(s, { status: 'idle', startedAt: row.started_at, transcript: row.transcript, copy: !!copy });
    if (row.role && !copy) try { dbRun(officeDb(row.office), "UPDATE shifts SET sid = ?, status = 'aktif', ended_at = NULL WHERE sid = (SELECT sid FROM shifts WHERE tmux = ? ORDER BY started_at DESC LIMIT 1)", sid, p.pane); } catch {}
    bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
  }
}

let scanning = false;
export async function scanProcesses() {
  if (scanning) return;
  scanning = true;
  try {
    const procs = await claudeProcesses();
    const byTty = new Map(procs.map(p => [p.tty, p]));
    const liveTtys = new Set([...live.values()].filter(s => s.tty && s.status !== 'ended').map(s => s.tty));
    const g = globalDb();
    recoverPanes(g);
    try { reapGoneTmux(); } catch (e) { console.error('reap tmux:', e.message); }
    const claimed = new Set();
    for (const p of procs) {
      if (liveTtys.has(p.tty)) continue;
      // the newest unfinished session that ran on this tab, or failing that one in this folder without a known tab
      const rows = all(g, `SELECT * FROM sessions WHERE ended_at IS NULL AND tmux IS NULL AND (tty = ? OR (tty IS NULL AND cwd = ?))
                           ORDER BY (tty = ?) DESC, last_seen DESC LIMIT 12`, p.tty, p.cwd, p.tty);
      let done = false;
      for (const row of rows) {
        const lv = live.get(row.sid);
        if (lv) { if (lv.tty) continue; lv.tty = p.tty; done = true; break; }
        expectSession({ sid: row.sid, office: row.office, role: row.role, room: row.room, cwd: row.cwd, tmux: null, slot: 0, title: row.title });
        const s = live.get(row.sid);
        Object.assign(s, { kind: row.source || 'manual', status: 'idle', tty: p.tty, transcript: row.transcript, startedAt: row.started_at, lastSeen: row.last_seen || nowIso() });
        bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
        done = true; break;
      }
      if (!done) { const lv = [...live.values()].find(x => !x.tty && !x.tmux && x.cwd === p.cwd && x.status !== 'ended'); if (lv) { lv.tty = p.tty; done = true; } }
      if (done) { liveTtys.add(p.tty); continue; }
      // never heard from: recognise it by its transcript, else show a placeholder until its first hook
      const taken = new Set(live.keys());
      const tr = transcriptFor(p, taken);
      const office0 = officeForCwd(p.cwd, { create: false });
      if (tr) {
        let room0 = null;
        if (office0) { const m = officeModel(office0); room0 = m ? roomForCwd(m, p.cwd).room : null; }
        const last = readTranscript(tr.file, 40).items.filter(i => i.k === 'user').pop();
        const title = last ? last.s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : null;
        expectSession({ sid: tr.sid, office: office0, role: null, room: room0, cwd: p.cwd, tmux: null, slot: 0, title });
        const s = live.get(tr.sid);
        Object.assign(s, { kind: 'manual', status: 'idle', tty: p.tty, transcript: tr.file, startedAt: new Date(p.started).toISOString(), lastSeen: nowIso() });
        dbRun(g, "UPDATE sessions SET source = 'manual', tty = ?, transcript = ? WHERE sid = ?", p.tty, tr.file, tr.sid);
        bus.emit('msg', { t: 'session', office: office0, session: serialize(s) });
        liveTtys.add(p.tty);
        continue;
      }
      // a live session that cd'ed elsewhere but was launched here (its transcript folder says so):
      // that is probably this process; don't show a duplicate, but don't guess its terminal either
      const enc = p.cwd.replace(/[^A-Za-z0-9]/g, '-');
      const twin = [...live.values()].find(x => !x.tty && !x.tmux && !x.placeholder && x.status !== 'ended' && !claimed.has(x.sid) && x.transcript && path.basename(path.dirname(x.transcript)) === enc);
      if (twin) { claimed.add(twin.sid); continue; }
      const sid = `proc-${p.pid}`;
      if (live.has(sid)) continue;
      const office = officeForCwd(p.cwd, { create: false });
      let room = null;
      if (office) { const m = officeModel(office); room = m ? roomForCwd(m, p.cwd).room : null; }
      const s = { sid, office, room, role: null, kind: 'manual', cwd: p.cwd, status: 'idle', tool: null, title: 'Sesi belum terhubung', model: null, startedAt: nowIso(), lastSeen: nowIso(),
        subs: new Map(), pendingAgents: [], waiting: null, worktree: null, slot: 0, tmux: null, tty: p.tty, placeholder: true };
      live.set(sid, s);
      bus.emit('msg', { t: 'session', office, session: serialize(s) });
      liveTtys.add(p.tty);
    }
    for (const s of live.values()) { const p = s.tty && byTty.get(s.tty); if (p && s.host !== p.host) { s.host = p.host; bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); } }
    // sessions whose terminal no longer runs claude are gone
    for (const s of [...live.values()]) {
      if (s.tmux || !s.tty || s.status === 'ended' || s.kind === 'rapat') continue;
      if (!byTty.has(s.tty)) {
        live.delete(s.sid);
        if (!s.placeholder) globalDb().prepare('UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE sid = ?').run(nowIso(), s.sid);
        bus.emit('msg', { t: 'session-gone', office: s.office, sid: s.sid });
      }
    }
  } finally { scanning = false; }
}

