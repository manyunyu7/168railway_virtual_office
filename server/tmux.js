import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { config, RUN_DIR, ROOT_DIR, CLAUDE_DIR } from './config.js';
import { officeDb, globalDb, one, all, run, nowIso, j } from './db.js';
import { officeModel } from './offices.js';
import { expectSession, live, logOffice, whoOf, bus, serialize, stopHeld } from './live.js';
import { createRole, listPlaybooks } from './store.js';
import { statusLineSettings } from './usage.js';
import { typeInto, claudePid } from './termapp.js';
import { recordOutgoing } from './outbox.js';
import { rulesBlock } from './aturan.js';
import { codexBin, codexArgs, codexScript, codexMode, codexDefaults, engineOf, readCodexSettings } from './codex.js';
import { agyBin, agyMode, agyArgs, agySettings, installAgyIntegration } from './antigravity.js';
import { who as actorName } from './actor.js';

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

// playbooks this role holds: titles + when to use them; the ones marked "always" go in full
function playbookLines(officeId, role) {
  const list = listPlaybooks(officeId, role.id);
  if (!list.length) return [];
  return ['## Playbook yang kamu pegang',
    'Sebelum mengerjakan tugas yang cocok dengan salah satu playbook di bawah, baca dulu isinya dengan `wiki_read` lalu ikuti langkahnya. Kalau ada langkah yang ternyata usang, jangan ubah playbook-nya: kirim usulan dengan `playbook_usul`.',
    ...list.map(p => `- **${p.title}**${p.when ? ` — ${p.when}` : ''}${p.approval ? ' — **minta persetujuan pengguna dulu sebelum menjalankan langkah yang berisiko**' : ''}`),
    ...list.filter(p => p.always).map(p => `\n### ${p.title} (selalu berlaku)\n${p.body.slice(0, 6000)}`), ''];
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
export function rolePrompt(officeId, role, extra = '', engine = 'claude') {
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === role.room);
  const db = officeDb(officeId);
  const rules = one(db, "SELECT body FROM wiki WHERE slug = 'aturan-kantor'")?.body;
  const structured = rulesBlock(officeId);
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
    '- Kantor punya board, wiki, notes, dan buku catatan per role. Aksesnya lewat tool MCP `kantor` (board_list, card_get, card_update, card_check, card_comment, card_create, wiki_search, wiki_read, wiki_write, notes_list, note_write, role_notes_read, role_notes_write, announce, sessions_list, roles_list). Pakai `sessions_list` untuk tahu siapa sedang bekerja di ruangan mana.',
    '- Kalau pemilik minta screenshot atau sebuah file, pakai `tangkap_layar` (layar Mac atau halaman lokal) atau `kirim_ke_pemilik` (berkas); keduanya sampai ke chat dan HP-nya. File kiriman pemilik ada di `.kantor/inbox/` (video: frame per detik di folder `-frames/` di sampingnya).',
    '- Sumber daya bersama (suite e2e, migrasi DB, dev server, commit di pohon yang sama) dipinjam lewat kunci harness: `kunci_ambil` sebelum dipakai, `kunci_lepas` begitu selesai (`kunci_list` untuk melihat siapa memegang apa). Jangan membuat kunci sendiri dengan mkdir/file. Aturan resmi kantor ada di `aturan_list`; hanya manager yang mengubahnya (`aturan_set`).',
    '- Wiki bukan papan obrolan: jangan menulis diskusi, tanya-jawab, atau laporan bolak-balik di wiki. Hasil akhir masuk wiki atau `pratinjau_kirim` (hasil visual yang perlu diputuskan pemilik: gambar, PDF, HTML, situs build); diskusi lewat pesan langsung (pesan_ke, balas) atau komentar kartu.',
    '- Saat mengerjakan kartu: pindahkan ke Dikerjakan, centang checklist yang selesai, tulis komentar singkat untuk temuan penting, lalu pindahkan ke Review saat siap dicek.',
    '- Menunggu kerja (kartu baru, pesan, commit, review): panggil `tunggu_kerja` lalu akhiri gilirannya; harness membangunkanmu dengan satu prompt tanpa biaya selama menunggu. Pakai `tunggu_kerja`, jangan sleep, polling, Monitor, atau ScheduleWakeup.',
    '- Sebelum berhenti, atau saat ada keputusan penting, perbarui buku catatanmu dengan role_notes_write supaya shift berikutnya tahu posisi terakhir.',
    engine === 'antigravity' ? '- Ikuti AGENTS.md, GEMINI.md, dan CLAUDE.md bila ada, serta wiki Aturan Kantor. Jawab dan tulis dalam Bahasa Indonesia. Gunakan tool pada server MCP kantor (misalnya sessions_list, board_list).'
      : engine !== 'claude' ? '- Ikuti AGENTS.md (dan CLAUDE.md bila ada) di repo dan halaman wiki "Aturan Kantor". Jawab dan tulis dalam Bahasa Indonesia. Tool MCP kantor muncul dengan awalan `mcp__kantor__`.'
      : '- Ikuti CLAUDE.md di repo dan halaman wiki "Aturan Kantor". Jawab dan tulis dalam Bahasa Indonesia.',
    engine !== 'claude' ? '- Kerjakan sampai tuntas dalam satu giliran: jangan berhenti di tengah untuk bertanya "lanjut?" atau menunggu konfirmasi, kecuali hal berisiko (menghapus data, kirim keluar, uang, produksi). Kalau ada beberapa cara, pilih yang paling wajar, lanjutkan, lalu laporkan hasilnya. Jangan mengirim Ctrl+C atau input ke terminal latar kecuali perlu; perintah yang lama jalankan dengan batas waktu sendiri.' : '',
    ...chain(db, role),
    role.is_mgr ? '- Kamu manager. Pecah permintaan jadi kartu dan tunjuk role yang tepat (field who). Kamu boleh memulai shift role lain dengan shift_start bila pekerjaannya jelas, dan membuka rapat antar-role dengan meeting_start. Jangan mengerjakan semua sendiri.' : '',
    '',
    ...playbookLines(officeId, role),
    role.notes ? `## Buku catatanmu (dari shift sebelumnya)\n${role.notes}` : '## Buku catatanmu\n(belum ada)',
    rules ? `\n## Aturan Kantor (dari wiki)\n${rules.slice(0, 4000)}` : '',
    structured,
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
  return modeFromCapture(txt);
}

export function modeFromCapture(txt) {
  const lines = String(txt || '').split('\n').filter(l => l.trim());
  // the input box's bottom rule is a bare line of ─; under it sit the mode banner and, with background
  // subagents, a list of them ("⏺ main", "◯ general-purpose …"), so look at the lines after the rule
  let rule = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 14); i--) if (/^\s*─{20,}\s*$/.test(lines[i])) { rule = i; break; }
  if (rule < 0) return null;
  const after = lines.slice(rule + 1);
  // a dialog (permission prompt, picker) has its own rules and option list; its footer says how to leave it
  if (after.length > 8 || after.some(l => /esc to (cancel|go back)|enter to (select|confirm)/i.test(l))) return null;
  if (!lines.slice(Math.max(0, rule - 8), rule).some(l => /^\s*[❯>]\s?(?!\d+\.)/.test(l))) return null;
  for (const l of lines.slice(rule + 1, rule + 4)) for (const [re, m] of BANNERS) if (re.test(l)) return m;
  return 'default';
}
/** paneMode without blocking the event loop (for the background poller). */
export function paneModeAsync(name) {
  const { tmux: t } = bins();
  return new Promise(res => execFile(t, ['capture-pane', '-p', '-t', name], { timeout: 3000 }, (err, out) => res(err ? null : modeFromCapture(out))));
}

/** Press Shift+Tab in a kantor pane until it reaches the wanted mode. */
export async function setPermMode(sid, target) {
  const s = live.get(sid), name = s?.tmux;
  if (!name || !hasTmux(name)) throw new Error('Mode izin hanya bisa diganti dari sini untuk sesi yang jalan di terminal kantor. Untuk sesi lain, tekan Shift+Tab di jendelanya.');
  if (s.engine === 'antigravity') throw new Error('Ganti izin Gemini lewat /permissions di tab Terminal sesi ini.');
  if (s.engine === 'codex') return (await import('./codexpick.js')).setCodexMode(sid, target); // /permissions menu instead of Shift+Tab
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

export function helperPrompt(officeId, boss) {
  const m = officeModel(officeId);
  return [`# Peranmu di Kantor Claude`, `Kamu asisten sementara di kantor **${m.name}** (\`${m.root}\`), tanpa role tetap.`,
    `Atasanmu: **${boss.name}** (${boss.title}). Kerjakan yang dia minta, laporkan hasil dan pertanyaan ke dia lewat komentar kartu, dan biarkan keputusan besar di tangannya.`,
    'Kantor punya board, wiki, dan notes lewat tool MCP `kantor` (board_list, card_get, card_update, card_comment, wiki_read, sessions_list, dll). Ikuti CLAUDE.md di repo dan wiki "Aturan Kantor".'].join('\n\n');
}
/** Who a role-less session works for (shown in the office; null clears it). */
export function setSessionBoss(sid, boss) {
  run(globalDb(), 'UPDATE sessions SET boss = ? WHERE sid = ?', boss || null, sid);
  const s = live.get(sid);
  if (s) { s.boss = boss || null; bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); }
  return { ok: true };
}

/** Start (or resume) a shift for a role in tmux. Returns the session id. */
export function startShift(officeId, roleId, { task = '', cardId = null, resumeSid = null, worktree = false, permissionMode = null, engine = null, model = null, effort = null } = {}) {
  const db = officeDb(officeId);
  const role = one(db, 'SELECT * FROM roles WHERE id = ? AND archived = 0', roleId);
  if (!role) throw new Error('Role tidak ditemukan');
  // engine of this shift: the one asked for at start, else the role's own
  const previous = resumeSid ? one(globalDb(), 'SELECT engine, office FROM sessions WHERE sid = ?', resumeSid) : null;
  if (previous && previous.office !== officeId) throw new Error('Sesi resume berasal dari kantor lain');
  if (previous && engine && engineOf(engine) !== engineOf(previous.engine)) throw new Error('Resume harus memakai mesin sesi asal');
  const eng = engineOf(engine || (previous ? engineOf(previous.engine) : role.engine));
  const { claude } = bins();
  if (eng === 'claude' && !claude) throw new Error('Perintah claude tidak ditemukan. Atur "claudeBin" di ~/.kantor-claude/config.json');
  if (eng === 'antigravity' && !agyBin()) throw new Error('Antigravity CLI belum terpasang. Pasang dari https://antigravity.google/cli lalu login Google dengan agy.');
  if (eng === 'codex' && !codexBin()) throw new Error('Perintah codex tidak ditemukan. Pasang Codex CLI (brew install codex) atau atur "codex.bin" di ~/.kantor-claude/config.json');
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === role.room);
  let cwd = room && room.path ? path.join(m.root, room.path) : m.root;
  if (!fs.existsSync(cwd)) cwd = m.root;

  const active = [...live.values()].filter(s => s.office === officeId && s.role === roleId && s.status !== 'ended');
  const used = new Set(active.map(s => s.slot));
  let slot = 0; while (used.has(slot)) slot++;
  if (worktree && slot > 0 && fs.existsSync(path.join(cwd, '.git'))) cwd = addWorktree(cwd, roleId, slot);

  const sid = resumeSid || crypto.randomUUID();
  const name = `${process.env.KANTOR_TMUX_PREFIX || 'kc'}-${officeId}-${roleId}${slot ? '-' + (slot + 1) : ''}`.replace(/[^A-Za-z0-9_-]/g, '-');
  if (hasTmux(name)) throw new Error(`Sesi tmux ${name} masih ada`);

  const card = cardId ? one(db, 'SELECT id, title, desc FROM cards WHERE id = ?', cardId) : null;
  if (eng === 'antigravity') return launchAntigravity({ officeId, role, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort });
  if (eng === 'codex') return launchCodex({ officeId, role, m, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort });
  const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`);
  fs.writeFileSync(promptFile, rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : ''), { mode: 0o600 });
  const mcpFile = path.join(RUN_DIR, `${sid}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig(officeId, roleId, sid)), { mode: 0o600 });
  const args = [q(claude)];
  if (resumeSid) args.push('--resume', q(resumeSid)); else args.push('--session-id', q(sid));
  args.push('--model', q(model || (role.engine === 'claude' || !role.engine ? role.model : '') || 'sonnet'), '--append-system-prompt-file', q(promptFile), '--mcp-config', q(mcpFile), '--name', q(`${role.name}${slot ? ' #' + (slot + 1) : ''} · ${m.name}`));
  args.push(...permissionArgs(permissionMode));
  // kantor's own MCP tools never need a prompt; hooks only when not installed globally
  const settings = { permissions: { allow: ['mcp__kantor'] }, ...(globalHooksInstalled() ? {} : hookSettings()), ...statusLineSettings() };
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

/** The Codex half of startShift: same tmux session, shift row and office log, different command line. */
function launchCodex({ officeId, role, m, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort }) {
  const db = officeDb(officeId);
  const own = role.engine === 'codex';
  const mdl = model || (own ? role.model : '') || '';
  const eff = effort || (own ? role.effort : '') || '';
  const mode = codexMode(permissionMode);
  const first = task || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : '');
  const home = process.env.KANTOR_HOME;
  const args = codexArgs({ resumeSid, model: mdl, effort: eff, mode, cwd, task: first,
    instructions: rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : '', 'codex'),
    mcp: { command: process.execPath, args: [path.join(ROOT_DIR, 'server', 'mcp-stdio.js')],
      env: { KANTOR_OFFICE: officeId, KANTOR_ROLE: role.id, KANTOR_SID: sid, ...(home ? { KANTOR_HOME: home } : {}) } } });
  // the long role prompt lives in a private script, not on the tmux command line (or in `ps`)
  const scriptFile = path.join(RUN_DIR, `${sid}.codex.sh`);
  fs.writeFileSync(scriptFile, codexScript({ bin: codexBin(), args, env: { KANTOR_SID: sid, KANTOR_ENGINE: 'codex', KANTOR_HOME: home } }), { mode: 0o700 });
  const envs = ['-e', `KANTOR_SID=${sid}`, '-e', 'KANTOR_ENGINE=codex'];
  if (home) envs.push('-e', `KANTOR_HOME=${home}`);
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', `exec ${q(scriptFile)}`]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); } catch {}
  expectSession({ sid, office: officeId, role: role.id, room: role.room, cwd, tmux: name, slot, title: first || card?.title || null, engine: 'codex', effort: eff || codexDefaults().effort, model: mdl || codexDefaults().model, permMode: mode });
  run(db, `INSERT INTO shifts (sid, role, title, card, started_at, cwd, tmux, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'aktif')
           ON CONFLICT(sid) DO UPDATE SET started_at = excluded.started_at, ended_at = NULL, tmux = excluded.tmux, status = 'aktif'`,
    sid, role.id, first || card?.title || '', card?.id || null, nowIso(), cwd, name);
  logOffice(officeId, role.name, resumeSid ? 'dipanggil lagi (resume, Codex)' : `mulai shift Codex${slot ? ` ke-${slot + 1}` : ''}`, 'session');
  return { sid, tmux: name, slot, engine: 'codex' };
}

function launchAntigravity({ officeId, role, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort }) {
  installAgyIntegration();
  const own = role.engine === 'antigravity', mdl = model || (own ? role.model : '') || '';
  const eff = effort || (own ? role.effort : '') || '';
  const mode = agyMode(permissionMode), first = task || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : '');
  const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`), settingsFile = path.join(RUN_DIR, `${sid}.antigravity.json`);
  fs.writeFileSync(promptFile, rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : '', 'antigravity'), { mode: 0o600 });
  fs.writeFileSync(settingsFile, JSON.stringify(agySettings(cwd)), { mode: 0o600 });
  const args = agyArgs({ cwd, model: mdl, effort: eff, mode, resumeSid, task: first, settingsFile });
  const env = { KANTOR_SID: sid, KANTOR_ENGINE: 'antigravity', KANTOR_OFFICE: officeId, KANTOR_ROLE: role.id,
    KANTOR_PROMPT_FILE: promptFile, KANTOR_RESUME: resumeSid ? '1' : '', KANTOR_HOME: process.env.KANTOR_HOME };
  const script = path.join(RUN_DIR, `${sid}.antigravity.sh`);
  fs.writeFileSync(script, codexScript({ bin: agyBin(), args, env }), { mode: 0o700 });
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '60', '/bin/zsh', '-lc', `exec ${q(script)}`]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); } catch {}
  expectSession({ sid, office: officeId, role: role.id, room: role.room, cwd, tmux: name, slot, title: first || card?.title || null, engine: 'antigravity', model: mdl, effort: eff, permMode: mode });
  run(officeDb(officeId), `INSERT INTO shifts (sid, role, title, card, started_at, cwd, tmux, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'aktif')
    ON CONFLICT(sid) DO UPDATE SET started_at = excluded.started_at, ended_at = NULL, tmux = excluded.tmux, status = 'aktif'`,
    sid, role.id, first || card?.title || '', card?.id || null, nowIso(), cwd, name);
  logOffice(officeId, role.name, resumeSid ? 'melanjutkan sesi Gemini (Antigravity)' : 'mulai shift Gemini (Antigravity)', 'session');
  return { sid, tmux: name, slot, engine: 'antigravity' };
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
/** Long or multi-line text goes in as one bracketed paste (a newline would otherwise submit early). */
export const usePaste = text => /\n/.test(text) || String(text).length > 200;
/** How long to let the TUI digest the text before Enter: Claude Code folds big pastes into "[Pasted text …]" and swallows an early Enter. */
export function enterDelay(text) {
  const n = String(text).length;
  return usePaste(text) ? Math.min(2000, 350 + Math.round(n / 8)) : Math.min(600, 120 + Math.round(n / 20));
}
/**
 * Does the input box on screen still hold (the start of) the text we typed, or a "[Pasted text …]" placeholder?
 * Looks only at the last prompt line (❯ Claude Code, › Codex) near the bottom and the lines wrapped under it,
 * so an empty prompt (or Claude's dim suggestion text) never counts and a retry can't send an empty Enter.
 */
export function pendingInput(screen, text) {
  const lines = String(screen || '').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-25);
  let i = -1;
  for (let k = tail.length - 1; k >= 0; k--) if (/^\s*[❯›>]( |$)/.test(tail[k])) { i = k; break; }
  if (i < 0) return false;
  const first = tail[i].replace(/^\s*[❯›>]\s?/, '');
  if (!first.trim()) return false;
  const box = [first];
  for (let k = i + 1; k < tail.length && k < i + 8; k++) { if (/^[\s─━-]*[─━]{3,}/.test(tail[k])) break; box.push(tail[k]); }
  const got = box.join(' ');
  if (/\[Pasted text/i.test(got)) return true;
  const squash = s => String(s).replace(/\s+/g, '');
  const want = squash(text).slice(0, 24);
  return !!want && squash(got).includes(want.slice(0, Math.min(want.length, squash(got).length, 24)));
}

export function sendText(name, text) {
  if (usePaste(text)) {
    const buf = `kc-${process.pid}-${Date.now()}`;
    tmux(['set-buffer', '-b', buf, '--', text]);
    tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', name]);
  } else tmux(['send-keys', '-t', name, '-l', text]);
  return submit(name, text).catch(() => {});
}
// Enter, then check a moment later that the input box emptied; press Enter again (at most twice) if the text is still there.
async function submit(name, text) {
  await wait(enterDelay(text));
  tmux(['send-keys', '-t', name, 'Enter']);
  for (let r = 0; r < 2; r++) {
    await wait(750);
    if (!hasTmux(name) || !pendingInput(visible(name), text)) return;
    tmux(['send-keys', '-t', name, 'Enter']);
  }
}

// Esc first; if Claude is still busy a moment later (a running Bash ignores Esc), one Ctrl+C.
// Never two Ctrl+C in a row: the second one exits Claude Code.
const lastCtrlC = new Map();
const lastEsc = new Map();
export function stopHard(name) {
  // repeated presses: a second Esc on an idle prompt opens Claude Code's rewind menu
  if (Date.now() - (lastEsc.get(name) || 0) < 1500) return false;
  lastEsc.set(name, Date.now());
  sendKeys(name, ['Escape']);
  setTimeout(() => {
    try {
      if (!hasTmux(name) || !/esc to (?:interrupt|cancel)/i.test(capture(name, 15))) return;
      if (Date.now() - (lastCtrlC.get(name) || 0) < 3000) return;
      lastCtrlC.set(name, Date.now());
      sendKeys(name, ['C-c']);
    } catch {}
  }, 1500);
  return true;
}

// background subagents show in Claude Code's status bar as "← 2 agents"; read it from the last lines of the screen
export function screenAgents(text) {
  const tail = String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-4).join('\n');
  const m = tail.match(/(\d+)\s+(?:local\s+|background\s+)?agents?\b/i);
  return m ? +m[1] : 0;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const visible = name => { try { return tmux(['capture-pane', '-p', '-t', name]); } catch { return ''; } };

// Esc for the main agent if busy, then chat:killAgents (Ctrl+X Ctrl+K, pressed twice within 3 s to confirm).
export async function stopAll(name, liveCount = 0) {
  const screen = capture(name, 15);
  const busy = /esc to (?:interrupt|cancel)/i.test(screen);
  const agentsBefore = Math.max(screenAgents(visible(name)), liveCount);
  let stoppedMain = false;
  if (busy) {
    stoppedMain = stopHard(name);
    if (stoppedMain) await wait(1700);
  }
  if (agentsBefore > 0) {
    sendKeys(name, ['C-x', 'C-k']);
    await wait(600);
    sendKeys(name, ['C-x', 'C-k']);
    await wait(2000);
  }
  return { stoppedMain, agentsBefore, agentsAfter: screenAgents(visible(name)) };
}

export async function sessionAction(sid, action, text) {
  const s = live.get(sid);
  const row = one(globalDb(), 'SELECT tmux, tty FROM sessions WHERE sid = ?', sid);
  const name = s?.tmux || row?.tmux;
  const who = s ? whoOf(s) : 'Sesi';
  if (name && hasTmux(name)) {
    switch (action) {
      case 'esc': {
        if (s?.engine === 'antigravity') { const busy = /esc to (?:interrupt|cancel)/i.test(capture(name, 15)); if (busy) sendKeys(name, ['Escape']); return { via: 'tmux', sent: busy, idle: !busy }; }
        // released a held permission with interrupt: Claude already stopped, an extra Esc on the idle prompt would arm the rewind menu
        const released = stopHeld(sid);
        // nothing running: an Esc on the idle prompt only arms Claude Code's rewind menu (a second one opens it)
        const busy = /esc to (?:interrupt|cancel)/i.test(capture(name, 15));
        if (!released && !busy) return { via: 'tmux', idle: true };
        // Claude stops on the denied hook (interrupt); Codex only gets the denial and carries on, so it still needs the Esc
        const sent = released && s?.engine !== 'codex' ? false : stopHard(name);
        if (released || sent) logOffice(s?.office, who, 'dihentikan', 'session');
        return { via: 'tmux', released, sent, debounced: !released && !sent };
      }
      case 'stop-all': case 'kill-agents': {
        if (s?.engine === 'antigravity') { const busy = /esc to (?:interrupt|cancel)/i.test(capture(name, 15)); if (busy) sendKeys(name, ['Escape']); return { via: 'tmux', stoppedMain: busy, agentsBefore: 0, agentsAfter: 0 }; }
        stopHeld(sid);
        if (s?.engine === 'codex') { // no Ctrl+X Ctrl+K sweep in Codex: Esc (then one Ctrl+C) is the whole stop
          const busy = /esc to (?:interrupt|cancel)/i.test(capture(name, 15));
          const stoppedMain = busy ? stopHard(name) : false;
          // commands left running in Codex's background terminals are its "background agents"
          if (/background terminals? running/i.test(capture(name, 15))) { setTimeout(() => { try { sendText(name, '/stop'); } catch {} }, busy ? 2200 : 0); }
          if (stoppedMain) logOffice(s?.office, who, 'dihentikan', 'session');
          return { via: 'tmux', stoppedMain, agentsBefore: 0, agentsAfter: 0 };
        }
        const r = await stopAll(name, s ? [...s.subs.values()].filter(x => x.status !== 'done').length : 0);
        if (r.agentsBefore > 0) logOffice(s?.office, who, `menghentikan ${r.agentsBefore} subagent latar`, 'session');
        else if (r.stoppedMain) logOffice(s?.office, who, 'dihentikan', 'session');
        return { via: 'tmux', ...r };
      }
      case 'compact': sendText(name, '/compact'); break;
      case 'clear': sendText(name, '/clear'); break;
      case 'exit': sendText(name, '/exit'); setTimeout(() => { if (hasTmux(name)) try { tmux(['kill-session', '-t', name]); } catch {} }, 8000); break;
      case 'kill': tmux(['kill-session', '-t', name]); markEnded(sid); logOffice(s?.office, who, 'dipulangkan paksa', 'session'); break;
      case 'text': if (text) { sendText(name, text); recordOutgoing(sid, text); } break;
      default: throw new Error('Aksi tidak dikenal');
    }
    return { via: 'tmux' };
  }
  // a session in a normal Terminal.app / iTerm2 tab: type into it
  const tty = s?.tty || row?.tty;
  if (!tty) throw new Error('Terminal sesi ini belum diketahui. Kirim satu perintah dari jendelanya dulu, lalu coba lagi.');
  if (s?.host === 'vscode' && action !== 'kill') throw new Error('Sesi ini jalan di terminal VS Code, dan kantor tidak bisa mengetik ke sana. Pakai "Pindahkan ke kantor" supaya bisa dikendalikan dari sini.');
  switch (action) {
    case 'text': { const app = await typeInto(tty, text); recordOutgoing(sid, text); logOffice(s?.office, actorName(), `mengirim perintah ke ${who} lewat ${app}`, 'prompt'); return { via: app }; }
    case 'compact': return { via: await typeInto(tty, '/compact') };
    case 'clear': return { via: await typeInto(tty, '/clear') };
    case 'exit': return { via: await typeInto(tty, '/exit') };
    case 'kill': { const pid = claudePid(tty); if (!pid) throw new Error('Proses Claude di terminal itu tidak ditemukan'); process.kill(pid, 'SIGTERM'); markEnded(sid); logOffice(s?.office, who, 'dipulangkan paksa', 'session'); return { via: 'signal' }; }
    case 'stop-all': case 'kill-agents': throw new Error('Subagent latar hanya bisa dihentikan untuk sesi di tmux kantor. Pindahkan sesi ini ke kantor, atau tekan Ctrl+X Ctrl+K dua kali di jendelanya.');
    case 'esc': throw new Error('Esc tidak bisa dikirim ke Terminal dari sini. Pindahkan sesi ini ke kantor supaya bisa dihentikan, atau tekan Esc di jendelanya.');
    default: throw new Error('Aksi tidak dikenal');
  }
}

/**
 * Move a Terminal/iTerm session into a kantor tmux session: ask it to /exit, then
 * `claude --resume` it in the same folder (transcripts are per folder) so memory carries over.
 */
export async function adoptSession(sid, roleId = null, permissionMode = null, newRole = null, boss = null) {
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
  const settings = { permissions: { allow: ['mcp__kantor'] }, ...(globalHooksInstalled() ? {} : hookSettings()), ...statusLineSettings() };
  const setFile = path.join(RUN_DIR, `${sid}.settings.json`);
  fs.writeFileSync(setFile, JSON.stringify(settings), { mode: 0o600 });
  const mcpFile = path.join(RUN_DIR, `${sid}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig(office, roleId, sid)), { mode: 0o600 });
  const args = [q(claude), '--resume', q(sid), '--mcp-config', q(mcpFile), '--settings', q(setFile), ...permissionArgs(permissionMode)];
  const bossRow = !role && boss ? one(officeDb(office), 'SELECT * FROM roles WHERE id = ? AND archived = 0', boss) : null;
  if (role) {
    const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`);
    fs.writeFileSync(promptFile, rolePrompt(office, role), { mode: 0o600 });
    args.push('--model', q(role.model || 'sonnet'), '--append-system-prompt-file', q(promptFile));
  } else if (bossRow) {
    // a temporary helper: no role of its own, but it knows who it works for
    const promptFile = path.join(RUN_DIR, `${sid}.prompt.md`);
    fs.writeFileSync(promptFile, helperPrompt(office, bossRow), { mode: 0o600 });
    args.push('--append-system-prompt-file', q(promptFile));
  }
  const envs = ['-e', `KANTOR_SID=${sid}`];
  if (process.env.KANTOR_HOME) envs.push('-e', `KANTOR_HOME=${process.env.KANTOR_HOME}`);
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', `export KANTOR_SID=${q(sid)}; exec ${args.join(' ')}`]);
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); } catch {}
  const room = s?.room || row?.room;
  expectSession({ sid, office, role: roleId || null, room: roleId ? role.room : room, cwd, tmux: name, slot: 0, title: s?.title || row?.title });
  if (bossRow) setSessionBoss(sid, bossRow.id);
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

/** While running: end shift sessions whose tmux session is gone (killed outside the kantor), so they stop showing as idle. */
export function reapGoneTmux() {
  const names = tmuxSessions();
  if (!names.length) return 0; // tmux unreadable: never end sessions on a failed listing
  const present = new Set(names);
  const fresh = Date.now() - 60e3;
  let n = 0;
  for (const s of [...live.values()]) {
    if (!s.tmux || s.status === 'ended' || s.status === 'starting' || s.sid.startsWith('pane-')) continue;
    if (present.has(s.tmux) || Date.parse(s.startedAt) > fresh) continue;
    markEnded(s.sid);
    bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
    n++;
  }
  return n;
}

/** On daemon start: re-adopt kantor tmux sessions that are still running. */
export function adoptRunning() {
  const names = new Set(tmuxSessions().filter(n => n.startsWith('kc-')));
  const rows = all(globalDb(), "SELECT * FROM sessions WHERE tmux IS NOT NULL AND (ended_at IS NULL)");
  for (const r of rows) {
    if (!names.has(r.tmux)) { run(globalDb(), "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE sid = ?", nowIso(), r.sid); continue; }
    const base = `kc-${r.office}-${r.role}`;
    const slot = r.tmux.startsWith(base + '-') ? Math.max(0, Number(r.tmux.slice(base.length + 1)) - 1 || 0) : 0;
    expectSession({ sid: r.sid, office: r.office, role: r.role, room: r.room, cwd: r.cwd, tmux: r.tmux, slot, title: r.title, engine: r.engine, effort: r.effort, model: r.engine !== 'claude' ? r.model : null });
    const s = live.get(r.sid); s.status = 'idle'; s.startedAt = r.started_at;
    if (r.engine === 'antigravity') s.transcript = r.transcript || null;
    if (r.engine === 'codex') { s.transcript = r.transcript || null; const cs = readCodexSettings(s.transcript); if (cs?.mode) s.permMode = cs.mode; }
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
