import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { config, RUN_DIR, ROOT_DIR, CLAUDE_DIR } from './config.js';
import { officeDb, globalDb, one, all, run, nowIso, j } from './db.js';
import { officeModel } from './offices.js';
import { expectSession, live, logOffice, whoOf } from './live.js';
import { createRole } from './store.js';
import { typeInto, claudePid } from './termapp.js';

const which = bin => {
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(process.env.HOME, '.local/bin'), path.join(process.env.HOME, '.claude/local')]) {
    const f = path.join(p, bin);
    if (fs.existsSync(f)) return f;
  }
  try { return execFileSync('/bin/zsh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
};
let TMUX = null, CLAUDE = null;
export function bins() {
  TMUX ||= which('tmux');
  const cfg = config().claudeBin;
  CLAUDE ||= cfg && path.isAbsolute(cfg) ? cfg : which(cfg || 'claude');
  return { tmux: TMUX, claude: CLAUDE };
}

export function tmux(args, opts = {}) {
  const { tmux: t } = bins();
  if (!t) throw new Error('tmux belum terpasang. Jalankan: brew install tmux');
  return execFileSync(t, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
export function tmuxSessions() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean); } catch { return []; }
}
export const hasTmux = name => tmuxSessions().includes(name);
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function globalHooksInstalled() {
  try { return fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8').includes('kantor-hook.cjs'); } catch { return false; }
}

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'PreCompact', 'PermissionRequest'];
export function hookSettings() {
  const cmd = `node ${q(path.join(ROOT_DIR, 'hooks', 'kantor-hook.cjs'))}`;
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ matcher: '', hooks: [{ type: 'command', command: cmd, timeout: ev === 'PermissionRequest' ? 600 : 5 }] }];
  return { hooks };
}

// who this role answers to, and who answers to it
function chain(db, role) {
  const boss = role.reports_to && one(db, 'SELECT name, title FROM roles WHERE id = ? AND archived = 0', role.reports_to);
  const team = all(db, 'SELECT name, title FROM roles WHERE reports_to = ? AND archived = 0', role.id);
  return [
    boss ? `- Atasanmu: **${boss.name}** (${boss.title}). Laporkan hasil dan pertanyaan ke dia lewat komentar kartu; keputusan besar dia yang ambil.` : '',
    team.length ? `- Anak buahmu: ${team.map(t => `**${t.name}** (${t.title})`).join(', ')}. Kamu boleh membagi kartu ke mereka dan mereview hasilnya.` : '',
  ];
}
export function rolePrompt(officeId, role, extra = '') {
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === role.room);
  const db = officeDb(officeId);
  const rules = one(db, "SELECT body FROM wiki WHERE slug = 'aturan-kantor'")?.body;
  const news = all(db, 'SELECT text FROM news ORDER BY id DESC LIMIT 5').map(n => `- ${n.text}`).join('\n');
  const skills = j(role.skills, []);
  return [
    `# Peranmu di Kantor Claude`,
    `Kamu adalah **${role.name}**, ${role.title} di kantor **${m.name}** (\`${m.root}\`).`,
    room ? `Ruanganmu: ${room.name}${room.path ? ` (\`${room.path}/\`)` : ''}.` : '',
    `Kepribadian: ${role.persona || '-'}`,
    skills.length ? `Keahlian: ${skills.join(', ')}.` : '',
    '',
    '## Cara kerja di kantor ini',
    '- Kantor punya board, wiki, notes, dan buku catatan per role. Aksesnya lewat tool MCP `kantor` (board_list, card_get, card_update, card_check, card_comment, card_create, wiki_search, wiki_read, wiki_write, notes_list, note_write, role_notes_read, role_notes_write, announce).',
    '- Saat mengerjakan kartu: pindahkan ke Dikerjakan, centang checklist yang selesai, tulis komentar singkat untuk temuan penting, lalu pindahkan ke Review saat siap dicek.',
    '- Sebelum berhenti, atau saat ada keputusan penting, perbarui buku catatanmu dengan role_notes_write supaya shift berikutnya tahu posisi terakhir.',
    '- Ikuti CLAUDE.md di repo dan halaman wiki "Aturan Kantor". Jawab dan tulis dalam Bahasa Indonesia.',
    ...chain(db, role),
    role.is_mgr ? '- Kamu manager. Pecah permintaan jadi kartu dan tunjuk role yang tepat (field who). Kamu boleh memulai shift role lain dengan shift_start bila pekerjaannya jelas. Jangan mengerjakan semua sendiri.' : '',
    '',
    role.notes ? `## Buku catatanmu (dari shift sebelumnya)\n${role.notes}` : '## Buku catatanmu\n(belum ada)',
    rules ? `\n## Aturan Kantor (dari wiki)\n${rules.slice(0, 4000)}` : '',
    news ? `\n## Papan pengumuman\n${news}` : '',
    extra,
  ].filter(x => x !== '').join('\n');
}

function mcpConfig(officeId, roleId, sid) {
  const s = JSON.parse(fs.readFileSync(path.join(process.env.KANTOR_HOME || path.join(process.env.HOME, '.kantor-claude'), 'server.json'), 'utf8'));
  return { mcpServers: { kantor: { type: 'stdio', command: process.execPath, args: [path.join(ROOT_DIR, 'server', 'mcp-stdio.js')],
    env: { KANTOR_URL: `http://127.0.0.1:${s.port}`, KANTOR_TOKEN: s.token, KANTOR_OFFICE: officeId, KANTOR_ROLE: roleId || '', KANTOR_SID: sid } } } };
}

const MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];
/** CLI flags for a permission mode; falls back to the office default from config. */
export function permissionArgs(mode) {
  const m = mode === 'ikut' ? '' : (mode || config().defaultPermissionMode || '');
  if (m === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  // bypass stays reachable with Shift+Tab (and the mode switcher) without being on from the start
  const allow = ['--allow-dangerously-skip-permissions'];
  return MODES.includes(m) ? ['--permission-mode', m, ...allow] : allow;
}

// the mode banner under Claude's input box, e.g. "⏵⏵ auto mode on (shift+tab to cycle)"
const BANNERS = [[/bypass permissions on/i, 'bypassPermissions'], [/auto mode on/i, 'auto'], [/accept edits on/i, 'acceptEdits'], [/plan mode on/i, 'plan'], [/don.?t ask/i, 'dontAsk']];
/** Permission mode a tmux pane is in, read from its footer. null while a dialog covers the input box. */
export function paneMode(name) {
  let txt = '';
  try { txt = tmux(['capture-pane', '-p', '-t', name]); } catch { return null; }
  const lines = txt.split('\n').filter(l => l.trim());
  const foot = lines.at(-1) || '', above = lines.at(-2) || '';
  for (const [re, m] of BANNERS) if (re.test(foot)) return m;
  // footer right under the input box's bottom rule, without a banner: the normal mode
  return /^\s*─{20,}/.test(above) ? 'default' : null;
}

/** Press Shift+Tab in a kantor pane until it reaches the wanted mode. */
export async function setPermMode(sid, target) {
  const s = live.get(sid), name = s?.tmux;
  if (!name || !hasTmux(name)) throw new Error('Mode izin hanya bisa diganti dari sini untuk sesi yang jalan di terminal kantor. Untuk sesi lain, tekan Shift+Tab di jendelanya.');
  if (!MODES.includes(target)) throw new Error('Mode tidak dikenal');
  const start = paneMode(name);
  if (start == null) throw new Error('Sesi ini sedang menampilkan dialog. Jawab dulu di terminalnya, lalu coba lagi.');
  let cur = start;
  for (let i = 0; i < 8 && cur !== target; i++) {
    sendKeys(name, ['BTab']);
    await new Promise(r => setTimeout(r, 400));
    cur = paneMode(name);
    if (cur == null || cur === start) break;
  }
  if (cur) s.permMode = cur;
  if (cur !== target) throw new Error(target === 'bypassPermissions'
    ? 'Bypass tidak ada di putaran Shift+Tab sesi ini. Sesi yang dimulai sebelum pembaruan ini perlu dimulai ulang (ingatannya tetap ada).'
    : 'Mode itu tidak tersedia di putaran Shift+Tab sesi ini.');
  return { mode: cur };
}

/** Start (or resume) a shift for a role in tmux. Returns the session id. */
export function startShift(officeId, roleId, { task = '', cardId = null, resumeSid = null, worktree = false, permissionMode = null } = {}) {
  const { claude } = bins();
  if (!claude) throw new Error('Perintah claude tidak ditemukan. Atur "claudeBin" di ~/.kantor-claude/config.json');
  const db = officeDb(officeId);
  const role = one(db, 'SELECT * FROM roles WHERE id = ? AND archived = 0', roleId);
  if (!role) throw new Error('Role tidak ditemukan');
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === role.room);
  let cwd = room && room.path ? path.join(m.root, room.path) : m.root;
  if (!fs.existsSync(cwd)) cwd = m.root;

  const active = [...live.values()].filter(s => s.office === officeId && s.role === roleId && s.status !== 'ended');
  const used = new Set(active.map(s => s.slot));
  let slot = 0; while (used.has(slot)) slot++;
  if (worktree && slot > 0 && fs.existsSync(path.join(cwd, '.git'))) cwd = addWorktree(cwd, roleId, slot);

  const sid = resumeSid || crypto.randomUUID();
  const name = `kc-${officeId}-${roleId}${slot ? '-' + (slot + 1) : ''}`.replace(/[^A-Za-z0-9_-]/g, '-');
  if (hasTmux(name)) throw new Error(`Sesi tmux ${name} masih ada`);

  const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`);
  const card = cardId ? one(db, 'SELECT id, title, desc FROM cards WHERE id = ?', cardId) : null;
  fs.writeFileSync(promptFile, rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : ''), { mode: 0o600 });
  const mcpFile = path.join(RUN_DIR, `${sid}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig(officeId, roleId, sid)), { mode: 0o600 });
  const args = [q(claude)];
  if (resumeSid) args.push('--resume', q(resumeSid)); else args.push('--session-id', q(sid));
  args.push('--model', q(role.model || 'sonnet'), '--append-system-prompt-file', q(promptFile), '--mcp-config', q(mcpFile), '--name', q(`${role.name}${slot ? ' #' + (slot + 1) : ''} · ${m.name}`));
  args.push(...permissionArgs(permissionMode));
  // kantor's own MCP tools never need a prompt; hooks only when not installed globally
  const settings = { permissions: { allow: ['mcp__kantor'] }, ...(globalHooksInstalled() ? {} : hookSettings()) };
  const setFile = path.join(RUN_DIR, `${sid}.settings.json`);
  fs.writeFileSync(setFile, JSON.stringify(settings), { mode: 0o600 });
  args.push('--settings', q(setFile));
  const first = task || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : '');
  if (first && !resumeSid) args.push('--', q(first));
  const cmd = `export KANTOR_SID=${q(sid)}${process.env.KANTOR_HOME ? `; export KANTOR_HOME=${q(process.env.KANTOR_HOME)}` : ''}; exec ${args.join(' ')}`;
  const envs = ['-e', `KANTOR_SID=${sid}`];
  if (process.env.KANTOR_HOME) envs.push('-e', `KANTOR_HOME=${process.env.KANTOR_HOME}`);
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', cmd]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); } catch {}

  expectSession({ sid, office: officeId, role: roleId, room: role.room, cwd, tmux: name, slot, title: first || card?.title || null });
  run(db, `INSERT INTO shifts (sid, role, title, card, started_at, cwd, tmux, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'aktif')
           ON CONFLICT(sid) DO UPDATE SET started_at = excluded.started_at, ended_at = NULL, tmux = excluded.tmux, status = 'aktif'`,
    sid, roleId, first || card?.title || '', cardId, nowIso(), cwd, name);
  logOffice(officeId, role.name, resumeSid ? 'dipanggil lagi (resume)' : `mulai shift${slot ? ` ke-${slot + 1}` : ''}`, 'session');
  return { sid, tmux: name, slot };
}

function addWorktree(repoDir, roleId, slot) {
  const base = path.basename(repoDir);
  const target = path.join(path.dirname(repoDir), `${base}-kc-${roleId}-${slot + 1}`);
  if (!fs.existsSync(target)) {
    const branch = `kc/${roleId}-${slot + 1}-${Date.now().toString(36)}`;
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, target], { stdio: 'ignore' });
  }
  return target;
}

export function sendKeys(name, keys) { tmux(['send-keys', '-t', name, ...keys]); }
export function sendText(name, text) {
  // several lines go in as one bracketed paste, otherwise each newline would submit early
  if (/\n/.test(text)) {
    const buf = `kc-${process.pid}-${Date.now()}`;
    tmux(['set-buffer', '-b', buf, '--', text]);
    tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', name]);
  } else tmux(['send-keys', '-t', name, '-l', text]);
  setTimeout(() => { try { tmux(['send-keys', '-t', name, 'Enter']); } catch {} }, /\n/.test(text) ? 400 : 120);
}

export async function sessionAction(sid, action, text) {
  const s = live.get(sid);
  const row = one(globalDb(), 'SELECT tmux, tty FROM sessions WHERE sid = ?', sid);
  const name = s?.tmux || row?.tmux;
  const who = s ? whoOf(s) : 'Sesi';
  if (name && hasTmux(name)) {
    switch (action) {
      case 'esc': sendKeys(name, ['Escape']); logOffice(s?.office, who, 'dihentikan (Esc)', 'session'); break;
      case 'compact': sendText(name, '/compact'); break;
      case 'clear': sendText(name, '/clear'); break;
      case 'exit': sendText(name, '/exit'); setTimeout(() => { if (hasTmux(name)) try { tmux(['kill-session', '-t', name]); } catch {} }, 8000); break;
      case 'kill': tmux(['kill-session', '-t', name]); markEnded(sid); logOffice(s?.office, who, 'dipulangkan paksa', 'session'); break;
      case 'text': if (text) sendText(name, text); break;
      default: throw new Error('Aksi tidak dikenal');
    }
    return { via: 'tmux' };
  }
  // a session in a normal Terminal.app / iTerm2 tab: type into it
  const tty = s?.tty || row?.tty;
  if (!tty) throw new Error('Terminal sesi ini belum diketahui. Kirim satu perintah dari jendelanya dulu, lalu coba lagi.');
  if (s?.host === 'vscode' && action !== 'kill') throw new Error('Sesi ini jalan di terminal VS Code, dan kantor tidak bisa mengetik ke sana. Pakai "Pindahkan ke kantor" supaya bisa dikendalikan dari sini.');
  switch (action) {
    case 'text': { const app = await typeInto(tty, text); logOffice(s?.office, 'Kamu', `mengirim perintah ke ${who} lewat ${app}`, 'prompt'); return { via: app }; }
    case 'compact': return { via: await typeInto(tty, '/compact') };
    case 'clear': return { via: await typeInto(tty, '/clear') };
    case 'exit': return { via: await typeInto(tty, '/exit') };
    case 'kill': { const pid = claudePid(tty); if (!pid) throw new Error('Proses Claude di terminal itu tidak ditemukan'); process.kill(pid, 'SIGTERM'); markEnded(sid); logOffice(s?.office, who, 'dipulangkan paksa', 'session'); return { via: 'signal' }; }
    case 'esc': throw new Error('Esc tidak bisa dikirim ke Terminal dari sini. Pindahkan sesi ini ke kantor supaya bisa dihentikan, atau tekan Esc di jendelanya.');
    default: throw new Error('Aksi tidak dikenal');
  }
}

/**
 * Move a Terminal/iTerm session into a kantor tmux session: ask it to /exit, then
 * `claude --resume` it in the same folder (transcripts are per folder) so memory carries over.
 */
export async function adoptSession(sid, roleId = null, permissionMode = null, newRole = null) {
  const { claude } = bins();
  const s = live.get(sid);
  const row = one(globalDb(), 'SELECT * FROM sessions WHERE sid = ?', sid);
  const office = s?.office || row?.office, cwd = s?.cwd || row?.cwd, tty = s?.tty || row?.tty;
  if (!office || !cwd) throw new Error('Sesi ini tidak dikenal kantor');
  if ((s?.tmux || row?.tmux) && hasTmux(s?.tmux || row?.tmux)) throw new Error('Sesi ini sudah berjalan di tmux kantor');
  // after /clear the conversation can live in an office pane under another record: never start it twice
  for (const f of fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')).filter(f => f.endsWith('.json'))) {
    let d = null; try { d = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8')); } catch {}
    if (d?.sessionId !== sid || !d.pid) continue;
    let alive = false; try { process.kill(d.pid, 0); alive = true; } catch {}
    if (alive && d.tmux) throw new Error(`Percakapan ini masih jalan di tmux ${String(d.tmux).split(':')[0]}. Buka sesi itu saja.`);
  }
  const alive = s && s.status !== 'ended' && tty && claudePid(tty);
  if (alive) {
    const typed = s.host !== 'vscode' && await typeInto(tty, '/exit').then(() => true, () => false);
    if (!typed) {
      // VS Code (or an app we can't type into): stop it with a signal, but never in the middle of a turn
      if (s.status === 'working' || s.waiting) throw new Error('Sesi ini sedang bekerja. Tunggu sampai selesai menjawab, lalu pindahkan.');
      try { process.kill(alive, 'SIGTERM'); } catch {}
    }
    for (let i = 0; i < 30 && claudePid(tty); i++) await new Promise(r => setTimeout(r, 500));
    if (!typed && claudePid(tty)) { try { process.kill(claudePid(tty), 'SIGKILL'); } catch {} await new Promise(r => setTimeout(r, 800)); }
    if (claudePid(tty)) throw new Error('Sesi di terminalnya belum keluar. Tutup dulu dari jendelanya, lalu coba lagi.');
    live.delete(sid);
  }
  const resumable = s?.transcript || row?.transcript;
  if (resumable && !fs.existsSync(resumable)) throw new Error('Transcript sesi ini sudah tidak ada, jadi tidak bisa dilanjutkan.');
  if (newRole?.name?.trim()) {
    // the session becomes a new role, e.g. a helper under an existing one
    const m = String(s?.model || row?.model || '');
    const pal = ['#2F5D9E', '#2C8452', '#A9620F', '#7A3E9D', '#BC3B34', '#1C7379', '#C2417A'], k = [...newRole.name].reduce((a, c) => a + c.charCodeAt(0), 0);
    roleId = createRole(office, { name: newRole.name, title: newRole.title?.trim() || 'Asisten', reportsTo: newRole.reportsTo || null, room: s?.room || row?.room || null,
      model: /opus/.test(m) ? 'opus' : /haiku/.test(m) ? 'haiku' : /fable/.test(m) ? 'fable' : 'sonnet', color: pal[k % pal.length], hair: ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A'][k % 4], skin: ['#F1C9A5', '#D9A47C', '#B97E57', '#E8B98F'][k % 4],
      hairStyle: k % 3 === 0 ? 'long' : 'short', persona: newRole.persona || '' }).id;
  }
  const role = roleId ? one(officeDb(office), 'SELECT * FROM roles WHERE id = ? AND archived = 0', roleId) : null;
  const name = `kcm-${sid.slice(0, 8)}`;
  if (hasTmux(name)) tmux(['kill-session', '-t', name]);
  const settings = { permissions: { allow: ['mcp__kantor'] }, ...(globalHooksInstalled() ? {} : hookSettings()) };
  const setFile = path.join(RUN_DIR, `${sid}.settings.json`);
  fs.writeFileSync(setFile, JSON.stringify(settings), { mode: 0o600 });
  const mcpFile = path.join(RUN_DIR, `${sid}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig(office, roleId, sid)), { mode: 0o600 });
  const args = [q(claude), '--resume', q(sid), '--mcp-config', q(mcpFile), '--settings', q(setFile), ...permissionArgs(permissionMode)];
  if (role) {
    const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`);
    fs.writeFileSync(promptFile, rolePrompt(office, role), { mode: 0o600 });
    args.push('--model', q(role.model || 'sonnet'), '--append-system-prompt-file', q(promptFile));
  }
  const envs = ['-e', `KANTOR_SID=${sid}`];
  if (process.env.KANTOR_HOME) envs.push('-e', `KANTOR_HOME=${process.env.KANTOR_HOME}`);
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', `export KANTOR_SID=${q(sid)}; exec ${args.join(' ')}`]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); } catch {}
  const room = s?.room || row?.room;
  expectSession({ sid, office, role: roleId || null, room: roleId ? role.room : room, cwd, tmux: name, slot: 0, title: s?.title || row?.title });
  logOffice(office, role?.name || 'Sesi', 'dipindahkan dari Terminal ke kantor', 'session');
  return { sid, tmux: name };
}

function markEnded(sid) {
  const s = live.get(sid);
  if (!s) return;
  s.status = 'ended';
  run(globalDb(), "UPDATE sessions SET status = 'ended', ended_at = ? WHERE sid = ?", nowIso(), sid);
  if (s.office && s.role) try { run(officeDb(s.office), "UPDATE shifts SET ended_at = ?, status = 'selesai' WHERE sid = ?", nowIso(), sid); } catch {}
}

/** On daemon start: re-adopt kantor tmux sessions that are still running. */
export function adoptRunning() {
  const names = new Set(tmuxSessions().filter(n => n.startsWith('kc-')));
  const rows = all(globalDb(), "SELECT * FROM sessions WHERE tmux IS NOT NULL AND (ended_at IS NULL)");
  for (const r of rows) {
    if (!names.has(r.tmux)) { run(globalDb(), "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE sid = ?", nowIso(), r.sid); continue; }
    const base = `kc-${r.office}-${r.role}`;
    const slot = r.tmux.startsWith(base + '-') ? Math.max(0, Number(r.tmux.slice(base.length + 1)) - 1 || 0) : 0;
    expectSession({ sid: r.sid, office: r.office, role: r.role, room: r.room, cwd: r.cwd, tmux: r.tmux, slot, title: r.title });
    const s = live.get(r.sid); s.status = 'idle'; s.startedAt = r.started_at;
  }
}

/** On daemon start: bring back Terminal/iTerm sessions whose Claude process is still alive. */
export function adoptManual() {
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  const rows = all(globalDb(), "SELECT * FROM sessions WHERE ended_at IS NULL AND tty IS NOT NULL AND tmux IS NULL AND last_seen > ? ORDER BY last_seen DESC", cutoff);
  const seenTty = new Set();
  for (const r of rows) {
    if (seenTty.has(r.tty) || live.has(r.sid)) continue;
    seenTty.add(r.tty); // newest session on a tab wins
    if (!claudePid(r.tty)) continue;
    expectSession({ sid: r.sid, office: r.office, role: r.role, room: r.room, cwd: r.cwd, tmux: null, slot: 0, title: r.title });
    const s = live.get(r.sid);
    Object.assign(s, { kind: r.source || 'manual', status: 'idle', tty: r.tty, transcript: r.transcript, startedAt: r.started_at, lastSeen: r.last_seen });
  }
}

/** Plain shell for a room, kept alive in tmux. */
export function ensureShell(officeId, roomId) {
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === roomId);
  const cwd = room && room.path ? path.join(m.root, room.path) : m.root;
  const name = `kcsh-${officeId}-${roomId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  if (!hasTmux(name)) { tmux(['new-session', '-d', '-s', name, '-c', fs.existsSync(cwd) ? cwd : m.root, '-x', '200', '-y', '50']); try { tmux(['set-option', '-t', name, 'status', 'off']); } catch {} }
  return name;
}

export function capture(name, lines = 200) {
  try { return tmux(['capture-pane', '-p', '-t', name, '-S', `-${lines}`]); } catch { return ''; }
}

export { execFile };
