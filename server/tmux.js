import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { config, RUN_DIR, ROOT_DIR, CLAUDE_DIR } from './config.js';
import { officeDb, globalDb, one, all, run, nowIso, j } from './db.js';
import { officeModel } from './offices.js';
import * as offices from './offices.js';
import { expectSession, live, logOffice, whoOf, bus, serialize, stopHeld } from './live.js';
import { createRole, listPlaybooks } from './store.js';
import { statusLineSettings } from './usage.js';
import { typeInto, claudePid } from './termapp.js';
import { recordOutgoing } from './outbox.js';
import { rulesBlock } from './aturan.js';
import { codexBin, codexArgs, codexScript, codexMode, codexDefaults, engineOf, readCodexSettings } from './codex.js';
import { agyBin, agyMode, agyArgs, agySettings, installAgyIntegration } from './antigravity.js';
import { draftOnScreen } from './draft-prompt.js';
import { who as actorName } from './actor.js';
import * as mx from './machines.js';

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

// Sesi tmux bisa jalan di Mac lain (docs/MULTI-PC.md): tmux() memilih mesinnya dari target `-t nama`
// (lihat machines.setTmuxMachine), atau dari opts.machine untuk perintah tanpa target (new-session, set-buffer).
const targetOf = args => { const i = args.indexOf('-t'); return i >= 0 ? String(args[i + 1] || '') : null; };
export const machineOfTmuxArgs = args => { const t = targetOf(args); return t ? mx.tmuxMachineOf(t) : mx.LOCAL; };
export function tmux(args, opts = {}) {
  const { machine: wanted, ...rest } = opts;
  const machine = wanted || machineOfTmuxArgs(args);
  if (mx.isRemote(machine)) {
    mx.ensureProbed(machine);
    const out = mx.execSync(machine, 'tmux', args, rest);
    if (args[0] === 'new-session' || args[0] === 'kill-session') mx.invalidateTmuxList(machine);
    return out;
  }
  opts = rest;
  const { tmux: t } = bins();
  if (!t) throw new Error('tmux belum terpasang. Jalankan: brew install tmux');
  return execFileSync(t, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
export function tmuxSessions() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean); } catch { return []; }
}
// Recovery must distinguish an empty tmux server from a failed listing: only the former means every pane is gone.
function tmuxSessionsForRecovery() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean); }
  catch (e) {
    const reason = String(e.stderr || '');
    if (e.status === 1 && /no server running|no sessions|error connecting to .*\(No such file or directory\)/i.test(reason)) return [];
    return null;
  }
}
export const hasTmux = name => {
  const m = mx.tmuxMachineOf(name);
  if (mx.isRemote(m)) {
    if (mx.isOffline(m) || mx.getMachine(m).disabled) return false; // tanpa ssh: mesin offline bisa memblokir sampai ConnectTimeout
    return !!mx.remoteTmuxSessions(m)?.includes(String(name).split(':')[0]);
  }
  return tmuxSessions().includes(name);
};
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function globalHooksInstalled() {
  try { return fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8').includes('kantor-hook.cjs'); } catch { return false; }
}

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'PreCompact', 'PermissionRequest'];
/** Hook kantor untuk --settings. machine = mesin remote: node dan skrip hook di mesin itu. */
export function hookSettings(machine = null) {
  const cmd = machine && mx.isRemote(machine)
    ? `${q(mx.ensureProbed(machine).node || 'node')} ${q(path.join(mx.machineRoot(machine), 'hooks', 'kantor-hook.cjs'))}`
    : `node ${q(path.join(ROOT_DIR, 'hooks', 'kantor-hook.cjs'))}`;
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
    room?.machine && mx.isRemote(room.machine)
      ? `Ruanganmu: ${room.name} (\`${room.remotePath || '?'}/\` di Mac **${machineName(room.machine)}**). Kamu bekerja di Mac itu, bukan di Mac kantor: folder ruangan lain tidak bisa kamu buka langsung, jadi berbagi hasil lewat tool kantor (pesan_ke, board, wiki).`
      : room ? `Ruanganmu: ${room.name}${room.path ? ` (\`${room.path}/\`)` : ''}.` : '',
    `Kepribadian: ${role.persona || '-'}`,
    skills.length ? `Keahlian: ${skills.join(', ')}.` : '',
    '',
    '## Cara kerja di kantor ini',
    '- Kantor punya board, wiki, notes, dan buku catatan per role. Aksesnya lewat tool MCP `kantor` (board_list, card_get, card_update, card_check, card_comment, card_create, wiki_search, wiki_read, wiki_write, notes_list, note_write, role_notes_read, role_notes_write, announce, sessions_list, roles_list). Pakai `sessions_list` untuk tahu siapa sedang bekerja di ruangan mana.',
    '- Kalau pemilik minta screenshot atau sebuah file, pakai `tangkap_layar` (layar Mac atau halaman lokal) atau `kirim_ke_pemilik` (berkas); keduanya sampai ke chat dan HP-nya. File kiriman pemilik ada di `.kantor/inbox/` (video: frame per detik di folder `-frames/` di sampingnya).',
    '- Sumber daya bersama (suite e2e, migrasi DB, dev server, commit di pohon yang sama) dipinjam lewat kunci harness: `kunci_ambil` sebelum dipakai, `kunci_lepas` begitu selesai (`kunci_list` untuk melihat siapa memegang apa). Jangan membuat kunci sendiri dengan mkdir/file. Aturan resmi kantor ada di `aturan_list`; hanya manager yang mengubahnya (`aturan_set`).',
    '- Wiki bukan papan obrolan: jangan menulis diskusi, tanya-jawab, atau laporan bolak-balik di wiki. Hasil akhir masuk wiki atau `pratinjau_kirim` (hasil visual yang perlu diputuskan pemilik: gambar, PDF, HTML, situs build); diskusi lewat pesan langsung (pesan_ke, balas) atau komentar kartu.',
    '- Konten sosial media (post Instagram, Threads, TikTok, YouTube) dicatat lewat tool `konten_*`, bukan `card_create`. Kirim ke pemilik dengan `konten_kirim`; keputusan setuju, jadwal, dan tayang milik pemilik (kamu hanya mengusulkan jadwal dengan `konten_jadwal_usul`, dan memanggil `konten_tayang` hanya setelah pemilik bilang sudah tayang).',
    '- Saat mengerjakan kartu: pindahkan ke Dikerjakan, centang checklist yang selesai, tulis komentar singkat untuk temuan penting, lalu pindahkan ke Review saat siap dicek.',
    '- Menunggu kerja (kartu baru, pesan, commit, review): panggil `tunggu_kerja` lalu akhiri gilirannya; harness membangunkanmu dengan satu prompt tanpa biaya selama menunggu. Pakai `tunggu_kerja`, jangan sleep, polling, Monitor, atau ScheduleWakeup.',
    '- Laporkan pekerjaanmu dengan `kerjaan_set` (judul singkat, langkah sekarang) saat mulai pekerjaan baru atau pindah tahap besar, supaya pemilik tahu kamu lagi apa tanpa membaca chat.',
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

function mcpConfig(officeId, roleId, sid, rm = null) {
  // shift di Mac lain: node dan mcp-stdio.js di mesin itu, bicara ke hub dengan token mesin
  if (rm) return { mcpServers: { kantor: { type: 'stdio', command: rm.bins.node, args: [path.join(rm.root, 'server', 'mcp-stdio.js')],
    env: { ...remoteEnv(rm.mc, sid), KANTOR_OFFICE: officeId, KANTOR_ROLE: roleId || '' } } } };
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
  const m = mx.tmuxMachineOf(name);
  if (mx.isRemote(m)) return mx.execAsync(m, 'tmux', ['capture-pane', '-p', '-t', name], { timeout: 5000 }).then(r => r.code ? null : modeFromCapture(r.stdout));
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

/* ---------------- shift di Mac lain (docs/MULTI-PC.md) ---------------- */
const machineName = id => mx.getMachine(id)?.name || id;
const offlineError = id => new Error(`Mac ${machineName(id)} sedang offline. Pastikan Mac itu menyala dan terhubung (Tailscale), lalu coba lagi.`);
const isRemoteId = id => !!id && id !== mx.LOCAL;
/** Lempar "Mac X sedang offline…" kalau mesin remote offline atau dinonaktifkan (sebelum ada ssh yang bisa menggantung). */
function assertOnline(id) {
  const mc = mx.getMachine(id);
  if (!mc) throw new Error('Mesin ini sudah tidak terdaftar di kantor.');
  if (mc.disabled) throw new Error(`Mac ${mc.name} sedang offline (dinonaktifkan di Pengaturan → Mesin).`);
  if (mx.isOffline(id)) throw offlineError(id);
}
/** Env pane shift remote: hook, statusline, dan MCP di mesin itu mengirim ke hub dengan token mesin (bukan KANTOR_HOME lokal). */
const remoteEnv = (mc, sid) => ({ KANTOR_SID: sid, KANTOR_URL: mc.hubUrl, KANTOR_TOKEN: mc.token, KANTOR_MACHINE: mc.id });
const envArgs = env => Object.entries(env).filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => ['-e', `${k}=${v}`]);
// token mesin tidak boleh muncul di argv (ssh di hub, tmux/codex di Mac itu): ia hanya ada di file 0600 <sid>.env
const withoutToken = ({ KANTOR_TOKEN, ...rest }) => rest;
const envFileText = env => Object.entries(env).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${q(v)}`).join('\n') + '\n';
/** Tulis <sid>.env (0600) di machineRunDir lewat stdin ssh; → path-nya. */
function writeRemoteEnv(rm, sid, extra = {}) {
  const file = path.join(rm.runDir, `${sid}.env`);
  mx.writeFile(rm.mc.id, file, envFileText({ ...remoteEnv(rm.mc, sid), ...extra }), 0o600);
  return file;
}

/** Mesin dan folder kerja ruangan: { machine (null = Mac ini), cwd }. */
export function roomPlace(m, room) {
  const r = typeof offices.roomCwd === 'function' ? offices.roomCwd(m, room)
    : isRemoteId(room?.machine) ? { machine: room.machine, cwd: room.remotePath } : null;
  if (isRemoteId(r?.machine)) {
    if (!mx.getMachine(r.machine)) throw new Error(`Ruangan ${room?.name || ''} ada di mesin yang sudah tidak terdaftar. Pindahkan ruangannya ke Mac lain dulu.`);
    if (!r.cwd || !path.isAbsolute(r.cwd)) throw new Error(`Folder ruangan ${room?.name || ''} di Mac ${machineName(r.machine)} belum diatur.`);
    return { machine: r.machine, cwd: r.cwd };
  }
  let cwd = r?.cwd || (room && room.path ? path.join(m.root, room.path) : m.root);
  if (!fs.existsSync(cwd)) cwd = m.root;
  return { machine: null, cwd };
}

const BIN_LABEL = { claude: 'Claude Code (claude)', codex: 'Codex CLI (codex)', tmux: 'tmux', node: 'node', git: 'git' };
/**
 * Pastikan mesin remote siap: online, bin yang dibutuhkan ada, folder kerja ada, dan (scripts) skrip kantor terpasang.
 * → { mc (dengan token), bins, root, runDir, ownStatusLine }. Satu panggilan ssh untuk semua cek file.
 */
function remoteReady(id, { cwd, need = [], scripts = true } = {}) {
  assertOnline(id);
  const mc = mx.getMachine(id);
  let bins = mx.ensureProbed(id);
  const missing = () => ['tmux', ...(scripts ? ['node'] : []), ...need].filter(b => !bins?.[b]);
  if (missing().length) { // bisa jadi baru dipasang setelah probe terakhir: cari ulang sekali
    const p = mx.probeSync(id);
    if (!p.ok) throw offlineError(id);
    bins = p.bins;
  }
  const miss = missing();
  if (miss.length) throw new Error(`${miss.map(b => BIN_LABEL[b] || b).join(', ')} tidak ditemukan di Mac ${mc.name}. Pasang dulu di sana${miss.some(b => b === 'claude' || b === 'codex') ? ' (dan login sekali)' : ''}, lalu tekan Tes di Pengaturan → Mesin.`);
  const root = mx.machineRoot(id);
  const checks = [`test -d ${q(cwd)} || echo NOCWD`];
  if (scripts) checks.push(`{ test -f ${q(path.join(root, 'server', 'mcp-stdio.js'))} && test -f ${q(path.join(root, 'hooks', 'kantor-hook.cjs'))}; } || echo NOROOT`,
    `grep -qs '"statusLine"' "$HOME/.claude/settings.json" && echo OWNSTATUS`);
  let out;
  try { out = mx.shSync(id, [...checks, 'true'].join('; '), { timeout: 10000 }); }
  catch (e) {
    if (e.status === 255 || mx.isOffline(id)) throw offlineError(id);
    throw new Error(`Gagal memeriksa Mac ${mc.name}: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`);
  }
  if (/NOCWD/.test(out)) throw new Error(`Folder ${cwd} tidak ada di Mac ${mc.name}. Periksa folder ruangannya.`);
  if (/NOROOT/.test(out)) throw new Error(`Skrip kantor belum terpasang di Mac ${mc.name}. Buka Pengaturan → Mesin lalu tekan Pasang.`);
  return { mc, bins, root, runDir: mx.machineRunDir(id), ownStatusLine: /OWNSTATUS/.test(out) };
}

/**
 * Salin transkrip Claude sesi `sid` ke mesin `toMachine` (null = Mac hub) di ~/.claude/projects/<folder cwd>/<sid>.jsonl.
 * Sumbernya file asli di mesin asal (atau lokal); salinan cermin di hub tidak dipakai karena bisa tertinggal.
 */
export function carryClaudeTranscript(prev, sid, toMachine, cwd) {
  const mirror = prev.transcript && mx.remoteOfMirror(prev.transcript);
  const srcMachine = mirror ? mirror.machine : (isRemoteId(prev.machine) ? prev.machine : null);
  const srcFile = mirror ? mirror.file : prev.transcript;
  const fail = why => new Error(`Percakapan sesi ini tidak bisa dibawa ke ${toMachine ? `Mac ${machineName(toMachine)}` : 'Mac kantor'}: ${why}. Mulai shift baru saja; buku catatan role tetap terbawa.`);
  if (!srcFile) throw fail('transkripnya tidak diketahui');
  if (srcMachine && mx.isOffline(srcMachine)) throw fail(`Mac ${machineName(srcMachine)} sedang offline`);
  const parts = [], step = 8 << 20;
  for (let off = 0; ; ) { const b = mx.readFrom(srcMachine, srcFile, off, step); if (!b.length) break; parts.push(b); off += b.length; if (b.length < step) break; }
  const data = Buffer.concat(parts);
  if (!data.length) throw fail('transkripnya kosong atau tidak terbaca');
  const home = toMachine ? mx.machineHome(toMachine) : process.env.HOME;
  if (!home) throw fail('folder home di mesin tujuan tidak diketahui');
  const dest = path.join(home, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
  if ((mx.statFile(toMachine, dest)?.size || 0) >= data.length) return dest;
  mx.writeFile(toMachine, dest, data, 0o600);
  return dest;
}

/** Start (or resume) a shift for a role in tmux. Returns the session id. */
export function startShift(officeId, roleId, { task = '', cardId = null, resumeSid = null, worktree = false, permissionMode = null, engine = null, model = null, effort = null } = {}) {
  const db = officeDb(officeId);
  const role = one(db, 'SELECT * FROM roles WHERE id = ? AND archived = 0', roleId);
  if (!role) throw new Error('Role tidak ditemukan');
  // engine of this shift: the one asked for at start, else the role's own
  const previous = resumeSid ? one(globalDb(), 'SELECT engine, office, machine, transcript FROM sessions WHERE sid = ?', resumeSid) : null;
  if (previous && previous.office !== officeId) throw new Error('Sesi resume berasal dari kantor lain');
  if (previous && engine && engineOf(engine) !== engineOf(previous.engine)) throw new Error('Resume harus memakai mesin sesi asal');
  const eng = engineOf(engine || (previous ? engineOf(previous.engine) : role.engine));
  const m = officeModel(officeId);
  const room = m.plan.rooms.find(r => r.id === role.room);
  let { machine, cwd } = roomPlace(m, room);
  let claude = null, rm = null;
  if (previous && (isRemoteId(previous.machine) ? previous.machine : null) !== machine && eng === 'claude') {
    // ruangannya pindah mesin: bawa transkrip ke mesin tujuan (path folder sama), supaya --resume menemukan percakapannya
    carryClaudeTranscript(previous, resumeSid, machine, cwd);
  } else if (previous && (isRemoteId(previous.machine) ? previous.machine : null) !== machine) {
    throw new Error(`Sesi ini dulu jalan di ${isRemoteId(previous.machine) ? `Mac ${machineName(previous.machine)}` : 'Mac kantor'}, sedangkan ruangannya sekarang di ${machine ? `Mac ${machineName(machine)}` : 'Mac kantor'}. Percakapannya hanya bisa dilanjutkan di mesin asalnya; mulai shift baru saja.`);
  }
  if (machine) {
    if (eng === 'antigravity') throw new Error(`Antigravity belum bisa jalan di Mac lain. Pakai Claude atau Codex untuk role di ruangan ${room?.name || ''} (Mac ${machineName(machine)}).`);
    rm = remoteReady(machine, { cwd, need: [eng] });
  } else {
    ({ claude } = bins());
    if (eng === 'claude' && !claude) throw new Error('Perintah claude tidak ditemukan. Atur "claudeBin" di ~/.kantor-claude/config.json');
    if (eng === 'antigravity' && !agyBin()) throw new Error('Antigravity CLI belum terpasang. Pasang dari https://antigravity.google/cli lalu login Google dengan agy.');
    if (eng === 'codex' && !codexBin()) throw new Error('Perintah codex tidak ditemukan. Pasang Codex CLI (brew install codex) atau atur "codex.bin" di ~/.kantor-claude/config.json');
  }

  const active = [...live.values()].filter(s => s.office === officeId && s.role === roleId && s.status !== 'ended');
  const used = new Set(active.map(s => s.slot));
  let slot = 0; while (used.has(slot)) slot++;
  if (worktree && slot > 0 && machine) cwd = addRemoteWorktree(machine, cwd, roleId, slot);
  else if (worktree && slot > 0 && fs.existsSync(path.join(cwd, '.git'))) cwd = addWorktree(cwd, roleId, slot);

  const sid = resumeSid || crypto.randomUUID();
  // shift di Mac lain berawalan kcr-: kalau Mac itu juga menjalankan kantornya sendiri, pane ini tidak tertukar dengan shift miliknya (procscan, adoptRunning)
  const name = `${machine ? 'kcr' : process.env.KANTOR_TMUX_PREFIX || 'kc'}-${officeId}-${roleId}${slot ? '-' + (slot + 1) : ''}`.replace(/[^A-Za-z0-9_-]/g, '-');
  mx.setTmuxMachine(name, machine); // hasTmux dan set-option di bawah harus bertanya ke server tmux mesin yang benar
  if (hasTmux(name)) throw new Error(`Sesi tmux ${name} masih ada`);

  const card = cardId ? one(db, 'SELECT id, title, desc FROM cards WHERE id = ?', cardId) : null;
  if (eng === 'antigravity') return launchAntigravity({ officeId, role, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort });
  if (eng === 'codex') return launchCodex({ officeId, role, m, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort, machine, rm });
  // file run: di Mac lain ditulis ke machineRunDir lewat mx.writeFile
  const dir = rm ? rm.runDir : RUN_DIR;
  const put = (file, content) => rm ? mx.writeFile(machine, file, content, 0o600) : fs.writeFileSync(file, content, { mode: 0o600 });
  const promptFile = path.join(dir, `${sid}.prompt.md`);
  put(promptFile, rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : ''));
  const mcpFile = path.join(dir, `${sid}.mcp.json`);
  put(mcpFile, JSON.stringify(mcpConfig(officeId, roleId, sid, rm)));
  const args = [q(rm ? rm.bins.claude : claude)];
  if (resumeSid) args.push('--resume', q(resumeSid)); else args.push('--session-id', q(sid));
  args.push('--model', q(model || (role.engine === 'claude' || !role.engine ? role.model : '') || 'sonnet'), '--append-system-prompt-file', q(promptFile), '--mcp-config', q(mcpFile), '--name', q(`${role.name}${slot ? ' #' + (slot + 1) : ''} · ${m.name}`));
  args.push(...permissionArgs(permissionMode));
  // kantor's own MCP tools never need a prompt; hooks only when not installed globally
  // (di Mac lain hook selalu ikut: hook global di sana menunjuk ke daemon yang tidak ada)
  const settings = rm
    ? { permissions: { allow: ['mcp__kantor'] }, ...hookSettings(machine), ...(rm.ownStatusLine ? {} : statusLineSettings({ node: rm.bins.node, root: rm.root })) }
    : { permissions: { allow: ['mcp__kantor'] }, ...(globalHooksInstalled() ? {} : hookSettings()), ...statusLineSettings() };
  const setFile = path.join(dir, `${sid}.settings.json`);
  put(setFile, JSON.stringify(settings));
  args.push('--settings', q(setFile));
  const first = task || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : '');
  if (first && !resumeSid) args.push('--', q(first));
  if (rm) {
    const envFile = writeRemoteEnv(rm, sid);
    tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envArgs(withoutToken(remoteEnv(rm.mc, sid))), '/bin/zsh', '-lc', `set -a; . ${q(envFile)}; set +a; exec ${args.join(' ')}`], { machine });
  } else {
    const cmd = `export KANTOR_SID=${q(sid)}${process.env.KANTOR_HOME ? `; export KANTOR_HOME=${q(process.env.KANTOR_HOME)}` : ''}; exec ${args.join(' ')}`;
    const envs = ['-e', `KANTOR_SID=${sid}`];
    if (process.env.KANTOR_HOME) envs.push('-e', `KANTOR_HOME=${process.env.KANTOR_HOME}`);
    tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', cmd]);
  }
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); } catch {}

  expectSession({ sid, office: officeId, role: roleId, room: role.room, cwd, tmux: name, slot, title: first || card?.title || null, machine });
  run(db, `INSERT INTO shifts (sid, role, title, card, started_at, cwd, tmux, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'aktif')
           ON CONFLICT(sid) DO UPDATE SET started_at = excluded.started_at, ended_at = NULL, tmux = excluded.tmux, status = 'aktif'`,
    sid, roleId, first || card?.title || '', cardId, nowIso(), cwd, name);
  logOffice(officeId, role.name, resumeSid ? 'dipanggil lagi (resume)' : `mulai shift${slot ? ` ke-${slot + 1}` : ''}`, 'session');
  return { sid, tmux: name, slot };
}

/** The Codex half of startShift: same tmux session, shift row and office log, different command line. */
function launchCodex({ officeId, role, m, cwd, slot, sid, name, card, task, resumeSid, permissionMode, model, effort, machine = null, rm = null }) {
  const db = officeDb(officeId);
  const own = role.engine === 'codex';
  const mdl = model || (own ? role.model : '') || '';
  const eff = effort || (own ? role.effort : '') || '';
  const mode = codexMode(permissionMode);
  const first = task || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : '');
  const home = rm ? null : process.env.KANTOR_HOME; // KANTOR_HOME lokal tidak berarti apa-apa di Mac lain
  // Codex membawa hook dan MCP lewat -c: di Mac lain keduanya menunjuk ke node dan skrip kantor di mesin itu, dan
  // env MCP harus memuat URL hub dan token mesin (Codex tidak meneruskan env induk ke server MCP)
  const args = codexArgs({ resumeSid, model: mdl, effort: eff, mode, cwd, task: first,
    instructions: rolePrompt(officeId, role, card ? `\n## Kartu shift ini\n${card.id}: ${card.title}\n${card.desc || ''}` : '', 'codex'),
    // token diteruskan dari env proses codex (env_vars), bukan ditulis di -c: argv codex terlihat di ps
    mcp: rm ? { command: rm.bins.node, args: [path.join(rm.root, 'server', 'mcp-stdio.js')], env: { KANTOR_OFFICE: officeId, KANTOR_ROLE: role.id, ...withoutToken(remoteEnv(rm.mc, sid)) }, envVars: ['KANTOR_TOKEN'] }
      : { command: process.execPath, args: [path.join(ROOT_DIR, 'server', 'mcp-stdio.js')],
        env: { KANTOR_OFFICE: officeId, KANTOR_ROLE: role.id, KANTOR_SID: sid, ...(home ? { KANTOR_HOME: home } : {}) } },
    hook: rm ? { node: rm.bins.node, root: rm.root } : null });
  // the long role prompt lives in a private script, not on the tmux command line (or in `ps`)
  const scriptFile = path.join(rm ? rm.runDir : RUN_DIR, `${sid}.codex.sh`);
  const env = rm ? { ...withoutToken(remoteEnv(rm.mc, sid)), KANTOR_ENGINE: 'codex' } : { KANTOR_SID: sid, KANTOR_ENGINE: 'codex', KANTOR_HOME: home };
  const script = codexScript({ bin: rm ? rm.bins.codex : codexBin(), args, env, envFile: rm ? writeRemoteEnv(rm, sid, { KANTOR_ENGINE: 'codex' }) : null });
  if (rm) mx.writeFile(machine, scriptFile, script, 0o700); else fs.writeFileSync(scriptFile, script, { mode: 0o700 });
  const envs = rm ? envArgs(env) : ['-e', `KANTOR_SID=${sid}`, '-e', 'KANTOR_ENGINE=codex'];
  if (home) envs.push('-e', `KANTOR_HOME=${home}`);
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envs, '/bin/zsh', '-lc', `exec ${q(scriptFile)}`], rm ? { machine } : {});
  try { tmux(['set-option', '-t', name, 'status', 'off']); tmux(['set-option', '-t', name, 'mouse', 'on']); tmux(['set-option', '-t', name, 'history-limit', '20000']); } catch {}
  const def = rm ? remoteCodexDefaults(machine) : codexDefaults();
  expectSession({ sid, office: officeId, role: role.id, room: role.room, cwd, tmux: name, slot, title: first || card?.title || null, engine: 'codex', effort: eff || def.effort, model: mdl || def.model, permMode: mode, machine });
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

/** Model dan effort bawaan Codex di Mac lain (config.toml di sana). */
function remoteCodexDefaults(machine) {
  let txt = '';
  try { txt = mx.shSync(machine, 'cat "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null; true', { timeout: 8000 }); } catch {}
  return codexDefaults(txt);
}

/** Worktree untuk slot kedua dst. di Mac lain, lewat git di mesin itu. Folder tanpa .git: tetap di folder ruangan. */
function addRemoteWorktree(machine, repoDir, roleId, slot) {
  const target = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-kc-${roleId}-${slot + 1}`);
  let out = '';
  try { out = mx.shSync(machine, `test -e ${q(path.join(repoDir, '.git'))} && echo GIT; test -e ${q(target)} && echo ADA; true`, { timeout: 10000 }); }
  catch (e) { if (e.status === 255 || mx.isOffline(machine)) throw offlineError(machine); throw e; }
  if (!/GIT/.test(out)) return repoDir;
  if (/ADA/.test(out)) return target;
  if (!mx.ensureProbed(machine).git) throw new Error(`git tidak ditemukan di Mac ${machineName(machine)}, jadi worktree tidak bisa dibuat. Pasang git di sana atau mulai shift tanpa worktree.`);
  const branch = `kc/${roleId}-${slot + 1}-${Date.now().toString(36)}`;
  try { mx.execSync(machine, 'git', ['-C', repoDir, 'worktree', 'add', '-b', branch, target], { timeout: 60000 }); }
  catch (e) { throw new Error(`Gagal membuat worktree di Mac ${machineName(machine)}: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`); }
  return target;
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

/** Isi layar pane saat ini, untuk modul lain yang perlu membacanya. */
export const paneScreen = name => capture(name, 40).trimEnd().split('\n').slice(-22).join('\n'); // hanya dasar layar: teks yang sekadar menyebut prompt ini di percakapan tidak ikut terbaca
export const pressKey = (name, key) => tmux(['send-keys', '-t', name, key]);
export function sendText(name, text) {
  // saat draf laporan tampil, tombol 0/1/2 berarti pilihan: tempel supaya pesan yang diawali angka tidak ikut menekannya
  if (usePaste(text) || draftOnScreen(paneScreen(name))) {
    const buf = `kc-${process.pid}-${Date.now()}`;
    tmux(['set-buffer', '-b', buf, '--', text], { machine: mx.tmuxMachineOf(name) }); // buffer harus di server tmux yang sama dengan pane
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
  const row = one(globalDb(), 'SELECT tmux, tty, machine FROM sessions WHERE sid = ?', sid);
  const name = s?.tmux || row?.tmux;
  const who = s ? whoOf(s) : 'Sesi';
  const machine = isRemoteId(s?.machine || row?.machine) ? (s?.machine || row?.machine) : null;
  if (machine && name && mx.tmuxMachineOf(name) !== machine) mx.setTmuxMachine(name, machine); // sesi yang belum dimuat ke live
  if (machine) assertOnline(machine);
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
      // Mac lain: tunggu sampai Enter benar-benar masuk (submit memeriksa layar lewat ssh)
      case 'text': if (text) { const sent = sendText(name, text); recordOutgoing(sid, text); if (machine) await sent; } break;
      default: throw new Error('Aksi tidak dikenal');
    }
    return { via: 'tmux' };
  }
  // sesi di Mac lain hanya dikendalikan lewat tmux; Terminal dan VS Code di sana tidak terjangkau
  if (machine) {
    assertOnline(machine);
    // hasTmux bisa salah saat ssh lambat: pastikan lewat daftar yang ketat sebelum menganggap tmux-nya hilang
    const list = remoteSessionsForRecovery(machine);
    if (list === null) throw offlineError(machine);
    if (name && list.includes(name)) throw new Error(`Mac ${machineName(machine)} lambat menjawab. Coba lagi sebentar lagi.`);
    if (action === 'kill' || action === 'exit') { markEnded(sid); if (s) bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); return { via: 'tmux', gone: true }; }
    throw new Error(`Sesi ini jalan di Mac ${machineName(machine)}, tapi tmux-nya sudah tidak ada di sana. Mulai shift baru dari kantor.`);
  }
  // a session in a normal Terminal.app / iTerm2 tab: type into it
  const tty = s?.tty || row?.tty;
  const topt = { machine: s?.machine || row?.machine || null }; // termapp menolak mesin remote (pengaman kedua)
  if (!tty) throw new Error('Terminal sesi ini belum diketahui. Kirim satu perintah dari jendelanya dulu, lalu coba lagi.');
  if (s?.host === 'vscode' && action !== 'kill') throw new Error('Sesi ini jalan di terminal VS Code, dan kantor tidak bisa mengetik ke sana. Pakai "Pindahkan ke kantor" supaya bisa dikendalikan dari sini.');
  switch (action) {
    case 'text': { const app = await typeInto(tty, text, topt); recordOutgoing(sid, text); logOffice(s?.office, actorName(), `mengirim perintah ke ${who} lewat ${app}`, 'prompt'); return { via: app }; }
    case 'compact': return { via: await typeInto(tty, '/compact', topt) };
    case 'clear': return { via: await typeInto(tty, '/clear', topt) };
    case 'exit': return { via: await typeInto(tty, '/exit', topt) };
    case 'kill': { const pid = claudePid(tty, topt); if (!pid) throw new Error('Proses Claude di terminal itu tidak ditemukan'); process.kill(pid, 'SIGTERM'); markEnded(sid); logOffice(s?.office, who, 'dipulangkan paksa', 'session'); return { via: 'signal' }; }
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
  if (isRemoteId(s?.machine || row?.machine)) throw new Error(`Sesi ini jalan di Mac ${machineName(s?.machine || row?.machine)}. Memindahkan sesi Terminal dari Mac lain belum didukung; mulai shift dari kantor untuk ruangan di mesin itu.`);
  if ((s?.tmux || row?.tmux) && hasTmux(s?.tmux || row?.tmux)) throw new Error('Sesi ini sudah berjalan di tmux kantor');
  // after /clear the conversation can live in an office pane under another record: never start it twice
  for (const f of fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')).filter(f => f.endsWith('.json'))) {
    let d = null; try { d = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8')); } catch {}
    if (d?.sessionId !== sid || !d.pid) continue;
    let alive = false; try { process.kill(d.pid, 0); alive = true; } catch {}
    if (alive && d.tmux) throw new Error(`Percakapan ini masih jalan di tmux ${String(d.tmux).split(':')[0]}. Buka sesi itu saja.`);
  }
  const topt = { machine: s?.machine || row?.machine || null };
  const alive = s && s.status !== 'ended' && tty && claudePid(tty, topt);
  if (alive) {
    const typed = s.host !== 'vscode' && await typeInto(tty, '/exit', topt).then(() => true, () => false);
    if (!typed) {
      // VS Code (or an app we can't type into): stop it with a signal, but never in the middle of a turn
      if (s.status === 'working' || s.waiting) throw new Error('Sesi ini sedang bekerja. Tunggu sampai selesai menjawab, lalu pindahkan.');
      try { process.kill(alive, 'SIGTERM'); } catch {}
    }
    for (let i = 0; i < 30 && claudePid(tty, topt); i++) await new Promise(r => setTimeout(r, 500));
    if (!typed && claudePid(tty, topt)) { try { process.kill(claudePid(tty, topt), 'SIGKILL'); } catch {} await new Promise(r => setTimeout(r, 800)); }
    if (claudePid(tty, topt)) throw new Error('Sesi di terminalnya belum keluar. Tutup dulu dari jendelanya, lalu coba lagi.');
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
export function reapGoneTmux(names = tmuxSessionsForRecovery()) {
  if (names === null) return 0; // tmux unreadable: never end sessions on a failed listing
  const present = new Set(names);
  const fresh = Date.now() - 60e3;
  let n = 0;
  for (const s of [...live.values()]) {
    if (!s.tmux || s.status === 'ended' || s.sid.startsWith('pane-')) continue;
    if (s.machine && s.machine !== mx.LOCAL) continue; // sesi di Mac lain: diurus per mesin (docs/MULTI-PC.md), jangan pernah diakhiri dari daftar tmux lokal
    if (present.has(s.tmux) || Date.parse(s.startedAt) > fresh) continue;
    markEnded(s.sid);
    bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
    n++;
  }
  return n;
}

/** On daemon start: re-adopt kantor tmux sessions that are still running. */
export function adoptRunning(sessionNames = tmuxSessionsForRecovery()) {
  if (sessionNames === null) return;
  const names = new Set(sessionNames.filter(n => n.startsWith('kc-')));
  const rows = all(globalDb(), "SELECT * FROM sessions WHERE tmux IS NOT NULL AND (ended_at IS NULL)");
  // A pane can have an older placeholder or conversation id after /clear. Adopt only its newest real id.
  rows.sort((a, b) => Number(a.sid.startsWith('pane-')) - Number(b.sid.startsWith('pane-'))
    || Date.parse(b.last_seen || b.started_at) - Date.parse(a.last_seen || a.started_at)
    || Date.parse(b.started_at) - Date.parse(a.started_at)
    || a.sid.localeCompare(b.sid));
  const adopted = new Set();
  for (const r of rows) {
    if (r.machine && r.machine !== mx.LOCAL) continue; // sesi di Mac lain diadopsi per mesin (adoptRemote), bukan dari daftar tmux lokal
    if (!names.has(r.tmux) || adopted.has(r.tmux)) {
      const endedAt = nowIso();
      run(globalDb(), "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE sid = ?", endedAt, r.sid);
      if (r.office && r.role) try { run(officeDb(r.office), "UPDATE shifts SET ended_at = ?, status = 'selesai' WHERE sid = ?", endedAt, r.sid); } catch {}
      continue;
    }
    adopted.add(r.tmux);
    const base = `kc-${r.office}-${r.role}`;
    const slot = r.tmux.startsWith(base + '-') ? Math.max(0, Number(r.tmux.slice(base.length + 1)) - 1 || 0) : 0;
    expectSession({ sid: r.sid, office: r.office, role: r.role, room: r.room, cwd: r.cwd, tmux: r.tmux, slot, title: r.title, engine: r.engine, effort: r.effort, model: r.engine !== 'claude' ? r.model : null });
    const s = live.get(r.sid); s.status = 'idle'; s.startedAt = r.started_at;
    run(globalDb(), "UPDATE sessions SET status = 'idle' WHERE sid = ?", r.sid);
    s.transcript = r.transcript || null; // tanpa ini kesehatan dan konteks sesi Claude kosong sampai hook berikutnya
    if (r.engine === 'codex') { const cs = readCodexSettings(s.transcript); if (cs?.mode) s.permMode = cs.mode; }
  }
}

/**
 * Daftar sesi tmux di mesin remote untuk pemulihan, atau null bila tidak bisa dipercaya (offline, dinonaktifkan,
 * timeout). Daftar kosong dicek ulang: hanya "no server running" yang berarti semua pane memang sudah hilang.
 */
function remoteSessionsForRecovery(id) {
  if (!mx.isRemote(id) || mx.getMachine(id).disabled) return null;
  const names = mx.remoteTmuxSessions(id, { fresh: true });
  if (names === null || mx.isOffline(id)) return null;
  if (names.length) return names;
  try { return mx.execSync(id, 'tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 8000 }).split('\n').filter(Boolean); }
  catch (e) { return e.status === 1 && /no server running|no sessions|error connecting/i.test(String(e.stderr || e.stdout || '')) ? [] : null; }
}

/**
 * Mesin remote online (startup, kembali online, tiap 60 detik): ambil lagi shift kantor di mesin itu yang tmux-nya
 * masih jalan, dan akhiri yang tmux-nya sudah hilang. Mesin tak terjangkau: tidak melakukan apa pun (aturan keras:
 * sesi di mesin offline tidak pernah diakhiri). → { adopted, ended } atau null.
 */
export function adoptRemote(machineId) {
  try { return adoptRemoteNow(machineId); } catch (e) { console.error('[kantor] adoptRemote', machineId, e.message); return null; }
}
function adoptRemoteNow(machineId) {
  const list = remoteSessionsForRecovery(machineId);
  if (list === null) return null;
  const names = new Set(list);
  const rows = all(globalDb(), 'SELECT * FROM sessions WHERE machine = ? AND tmux IS NOT NULL AND ended_at IS NULL', machineId);
  // satu pane, beberapa id (setelah /clear): yang sedang dipegang live menang, lalu yang terbaru seperti adoptRunning
  const held = r => Number(!(live.get(r.sid) && live.get(r.sid).status !== 'ended'));
  rows.sort((a, b) => held(a) - held(b) || Number(a.sid.startsWith('pane-')) - Number(b.sid.startsWith('pane-'))
    || Date.parse(b.last_seen || b.started_at) - Date.parse(a.last_seen || a.started_at)
    || Date.parse(b.started_at) - Date.parse(a.started_at)
    || a.sid.localeCompare(b.sid));
  const fresh = Date.now() - 60e3, taken = new Set();
  let adopted = 0, ended = 0;
  for (const r of rows) {
    const cur = live.get(r.sid);
    if (names.has(r.tmux) && !taken.has(r.tmux)) {
      taken.add(r.tmux);
      mx.setTmuxMachine(r.tmux, machineId);
      if (cur && cur.status !== 'ended') continue; // sudah dipegang: jangan setel ulang statusnya tiap putaran
      const base = `${r.tmux.startsWith('kcr-') ? 'kcr' : 'kc'}-${r.office}-${r.role}`;
      const slot = r.tmux.startsWith(base + '-') ? Math.max(0, Number(r.tmux.slice(base.length + 1)) - 1 || 0) : 0;
      expectSession({ sid: r.sid, office: r.office, role: r.role, room: r.room, cwd: r.cwd, tmux: r.tmux, slot, title: r.title, engine: r.engine, effort: r.effort, model: r.engine !== 'claude' ? r.model : null, machine: machineId });
      const s = live.get(r.sid); s.status = 'idle'; s.startedAt = r.started_at;
      run(globalDb(), "UPDATE sessions SET status = 'idle' WHERE sid = ?", r.sid);
      s.transcript = r.transcript || null; // path cermin lokal (mirror/<mesin>/...), jadi pembaca transkrip jalan seperti biasa
      const src = s.transcript && mx.remoteOfMirror(s.transcript);
      if (src) import('./mirror.js').then(mm => mm.mirrorTranscript?.(src.machine, src.file)).catch(() => {});
      if (r.engine === 'codex') { const cs = readCodexSettings(s.transcript); if (cs?.mode) s.permMode = cs.mode; }
      bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
      adopted++;
      continue;
    }
    if (Date.parse(cur?.startedAt || r.started_at) > fresh) continue; // baru diluncurkan: beri waktu
    const endedAt = nowIso();
    if (cur && cur.status !== 'ended') { markEnded(r.sid); bus.emit('msg', { t: 'session', office: cur.office, session: serialize(cur) }); }
    else {
      run(globalDb(), "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE sid = ?", endedAt, r.sid);
      if (r.office && r.role) try { run(officeDb(r.office), "UPDATE shifts SET ended_at = ?, status = 'selesai' WHERE sid = ?", endedAt, r.sid); } catch {}
    }
    ended++;
  }
  return { adopted, ended };
}

/** Seperti reapGoneTmux, hanya untuk sesi live di mesin itu, dan hanya kalau daftar tmux-nya bisa dibaca. */
export function reapRemote(machineId, names) {
  try { if (names === undefined) names = remoteSessionsForRecovery(machineId); } catch { return 0; }
  if (names === null || names === undefined) return 0;
  const present = new Set(names);
  const fresh = Date.now() - 60e3;
  let n = 0;
  for (const s of [...live.values()]) {
    if (s.machine !== machineId || !s.tmux || s.status === 'ended' || s.sid.startsWith('pane-')) continue;
    if (present.has(s.tmux) || Date.parse(s.startedAt) > fresh) continue;
    markEnded(s.sid);
    bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
    n++;
  }
  return n;
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
  const name = `kcsh-${officeId}-${roomId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const place = roomPlace(m, room);
  mx.setTmuxMachine(name, place.machine);
  if (place.machine) { // ruangan di Mac lain: shell-nya juga di sana
    assertOnline(place.machine);
    if (!hasTmux(name)) {
      remoteReady(place.machine, { cwd: place.cwd, scripts: false });
      tmux(['new-session', '-d', '-s', name, '-c', place.cwd, '-x', '200', '-y', '50'], { machine: place.machine });
      try { tmux(['set-option', '-t', name, 'status', 'off']); } catch {}
    }
    return name;
  }
  if (!hasTmux(name)) { tmux(['new-session', '-d', '-s', name, '-c', place.cwd, '-x', '200', '-y', '50']); try { tmux(['set-option', '-t', name, 'status', 'off']); } catch {} }
  return name;
}

export function capture(name, lines = 200) {
  try { return tmux(['capture-pane', '-p', '-t', name, '-S', `-${lines}`]); } catch { return ''; }
}

export { execFile };
