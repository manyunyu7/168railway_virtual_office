import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { officeDb, all, one, run, nowIso, newId, j } from './db.js';
import { officeModel } from './offices.js';
import { bus, logOffice, expectSession, live } from './live.js';
import { bins, globalHooksInstalled, hookSettings } from './tmux.js';
import { listCards, getRole, saveWiki, COLS, createCard } from './store.js';
import { boardForRole } from './boards.js';
import { RUN_DIR } from './config.js';
import { codexBin, tomlStr } from './codex.js';
import { createLineParser, createClaudeStream, createTyper, getTyping } from './meeting-stream.js';
import { who } from './actor.js';

const running = new Map(); // office -> { meetingId, child, cancelled }
const changed = (office, extra = {}) => bus.emit('msg', { t: 'changed', office, what: 'meetings', ...extra });

export function listMeetings(office) {
  return all(officeDb(office), 'SELECT id, topic, status, participants, chair, created_at, ended_at, cost FROM meetings ORDER BY created_at DESC LIMIT 50')
    .map(m => ({ ...m, participants: j(m.participants, []) }));
}
export function getMeeting(office, id) {
  const db = officeDb(office);
  const m = one(db, 'SELECT * FROM meetings WHERE id = ?', id);
  if (!m) throw new Error('Rapat tidak ditemukan');
  return { ...m, participants: j(m.participants, []), decisions: j(m.decisions, []), actions: j(m.actions, []),
    messages: all(db, 'SELECT id, who, text, at, cost, kind FROM meeting_msgs WHERE meeting_id = ? ORDER BY id', id), running: running.get(office)?.meetingId === id, typing: getTyping(office, id) };
}

function addMsg(office, meetingId, who, text, kind = 'bicara', cost = 0) {
  const db = officeDb(office);
  const r = run(db, 'INSERT INTO meeting_msgs (meeting_id, who, text, at, cost, kind) VALUES (?, ?, ?, ?, ?, ?)', meetingId, who, text, nowIso(), cost, kind);
  bus.emit('msg', { t: 'meeting-msg', office, meetingId, msg: { id: Number(r.lastInsertRowid), who, text, at: nowIso(), cost, kind } });
}

export function startMeeting(office, { topic, agenda = '', participants = [], rounds = 2, chair }) {
  if (!topic?.trim()) throw new Error('Topik rapat wajib diisi');
  if (running.has(office)) throw new Error('Masih ada rapat yang berjalan di kantor ini');
  const roles = participants.map(id => getRole(office, id)).filter(Boolean);
  if (roles.length < 2) throw new Error('Rapat butuh minimal 2 peserta');
  const chairRole = getRole(office, chair) || roles.find(r => r.isMgr) || roles[0];
  const id = newId('m');
  run(officeDb(office), 'INSERT INTO meetings (id, topic, agenda, status, participants, rounds, chair, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, topic.trim(), agenda, 'berjalan', JSON.stringify(roles.map(r => r.id)), Math.max(1, Math.min(4, Number(rounds) || 2)), chairRole.id, nowIso());
  logOffice(office, chairRole.name, `membuka rapat: ${topic.trim()}`, 'meeting');
  launch(office, id, roles, chairRole, false);
  return getMeeting(office, id);
}

function launch(office, id, roles, chair, resume) {
  const state = { meetingId: id, child: null, cancelled: false, interjections: [] };
  running.set(office, state);
  changed(office, { meeting: id });
  runMeeting(office, id, roles, chair, state, resume).catch(e => {
    run(officeDb(office), "UPDATE meetings SET status = 'gagal', error = ?, ended_at = ? WHERE id = ?", e.message, nowIso(), id);
    addMsg(office, id, 'Sistem', `Rapat berhenti: ${e.message}`, 'sistem');
  }).finally(() => { running.delete(office); changed(office, { meeting: id }); });
}

/** Pick an interrupted or failed meeting up again at the turn where it stopped. */
export function resumeMeeting(office, id) {
  if (running.has(office)) throw new Error('Masih ada rapat yang berjalan di kantor ini');
  const db = officeDb(office);
  const m = one(db, 'SELECT * FROM meetings WHERE id = ?', id);
  if (!m) throw new Error('Rapat tidak ditemukan');
  if (!['terputus', 'gagal'].includes(m.status)) throw new Error('Rapat ini tidak sedang terhenti');
  const roles = j(m.participants, []).map(r => getRole(office, r)).filter(Boolean);
  if (roles.length < 2) throw new Error('Peserta rapat ini sudah tidak lengkap');
  const chair = getRole(office, m.chair) || roles[0];
  run(db, "UPDATE meetings SET status = 'berjalan', error = NULL, ended_at = NULL WHERE id = ?", id);
  launch(office, id, roles, chair, true);
  return getMeeting(office, id);
}

/** Reopen a finished meeting for more rounds, optionally with a new question from the owner. The notulen is rewritten afterwards. */
export function continueMeeting(office, id, { rounds = 1, note = '' } = {}) {
  if (running.has(office)) throw new Error('Masih ada rapat yang berjalan di kantor ini');
  const db = officeDb(office);
  const m = one(db, 'SELECT * FROM meetings WHERE id = ?', id);
  if (!m) throw new Error('Rapat tidak ditemukan');
  if (m.status !== 'selesai') throw new Error('Hanya rapat yang sudah selesai yang bisa dilanjutkan dengan ronde baru');
  const roles = j(m.participants, []).map(r => getRole(office, r)).filter(Boolean);
  if (roles.length < 2) throw new Error('Peserta rapat ini sudah tidak lengkap');
  const chair = getRole(office, m.chair) || roles[0];
  const extra = Math.max(1, Math.min(3, Number(rounds) || 1));
  run(db, "UPDATE meetings SET status = 'berjalan', rounds = ?, error = NULL, ended_at = NULL WHERE id = ?", m.rounds + extra, id);
  addMsg(office, id, 'Sistem', `Rapat dilanjutkan ${extra} ronde lagi.`, 'sistem');
  if (note.trim()) addMsg(office, id, who(), note.trim().slice(0, 4000), 'kamu');
  logOffice(office, chair.name, `melanjutkan rapat: ${m.topic.slice(0, 40)}`, 'meeting');
  launch(office, id, roles, chair, 'continue');
  return getMeeting(office, id);
}

/** On daemon start nothing is running yet: meetings still marked as running were cut off. */
export function markInterrupted(office) {
  const db = officeDb(office);
  for (const m of all(db, "SELECT id FROM meetings WHERE status = 'berjalan'")) {
    run(db, "UPDATE meetings SET status = 'terputus', cost = (SELECT COALESCE(SUM(cost), 0) FROM meeting_msgs WHERE meeting_id = ?) WHERE id = ?", m.id, m.id);
    addMsg(office, m.id, 'Sistem', 'Rapat terputus karena kantor dimulai ulang. Klik "Lanjutkan rapat" untuk meneruskan dari giliran terakhir.', 'sistem');
  }
}

export function cancelMeeting(office) {
  const st = running.get(office);
  if (!st) throw new Error('Tidak ada rapat yang berjalan');
  st.cancelled = true;
  try { st.child?.kill('SIGTERM'); } catch {}
}
export function interject(office, meetingId, text) {
  const st = running.get(office);
  if (!st || st.meetingId !== meetingId) throw new Error('Rapat ini sudah selesai');
  addMsg(office, meetingId, who(), text.trim(), 'kamu');
}

function boardBrief(office) {
  return listCards(office).filter(c => !c.done).slice(0, 40).map(c => `- [${c.colName}${c.board !== 'utama' ? ` · ${c.boardName}` : ''}] ${c.id} ${c.title}${c.who ? ` (${c.who})` : ''}${c.blocked ? ` TERBLOKIR: ${c.blocked}` : ''}`).join('\n') || '(board kosong)';
}

async function runMeeting(office, id, roles, chair, state, resume = false) {
  const db = officeDb(office);
  const m = officeModel(office);
  const meet = one(db, 'SELECT * FROM meetings WHERE id = ?', id);
  const rules = one(db, "SELECT body FROM wiki WHERE slug = 'aturan-kantor'")?.body || '';
  const roster = roles.map(r => `- ${r.name} (${r.title}, id: ${r.id})`).join('\n');
  let cost = resume ? one(db, 'SELECT COALESCE(SUM(cost), 0) c FROM meeting_msgs WHERE meeting_id = ?', id).c : 0;
  // turns already spoken (by the participants, in order) are skipped when resuming
  let skip = resume ? one(db, "SELECT COUNT(*) n FROM meeting_msgs WHERE meeting_id = ? AND kind = 'bicara'", id).n : 0;
  if (resume === true) addMsg(office, id, 'Sistem', `Rapat dilanjutkan dari giliran ke-${skip + 1}.`, 'sistem');
  else addMsg(office, id, 'Sistem', `Rapat dibuka oleh ${chair.name}. Peserta: ${roles.map(r => r.name).join(', ')}. ${meet.rounds} ronde.`, 'sistem');
  const transcript = () => all(db, 'SELECT who, text FROM meeting_msgs WHERE meeting_id = ? AND kind != ? ORDER BY id', id, 'sistem').map(x => `${x.who}: ${x.text}`).join('\n\n');

  for (let round = 1; round <= meet.rounds; round++) {
    for (const r of roles) {
      if (skip > 0) { skip--; continue; }
      if (state.cancelled) throw new Error('dibatalkan');
      const prompt = [
        `Kamu sedang rapat di Ruang Meeting kantor ${m.name}.`,
        `Topik: ${meet.topic}`, meet.agenda ? `Agenda/konteks dari pemilik kantor:\n${meet.agenda}` : '',
        `Peserta:\n${roster}`,
        `Board saat ini:\n${boardBrief(office)}`,
        `Transkrip rapat sejauh ini:\n${transcript() || '(belum ada)'}`,
        `Sekarang giliranmu (ronde ${round} dari ${meet.rounds}). Bicara sebagai ${r.name} (${r.title}) sesuai keahlian dan kepribadianmu.`,
        resume === 'continue' ? 'Rapat ini sempat selesai lalu dibuka lagi. Jangan mengulang yang sudah dibahas: lanjutkan dari situ, dan kalau pemilik kantor ("Kamu") memberi pertanyaan atau arahan baru, jawab itu dulu.' : '',
        'Singkat dan konkret, maksimal 120 kata. Tanggapi pendapat peserta lain kalau perlu. Boleh membaca kode di repo dengan Read/Grep/Glob kalau butuh fakta, tapi jangan mengubah apa pun. Langsung ke isi, tanpa salam pembuka.',
      ].filter(Boolean).join('\n\n');
      const out = await ask(office, r, prompt, `Rapat: ${meet.topic}`, state, { typing: true });
      cost += out.cost;
      run(db, 'UPDATE meetings SET cost = ? WHERE id = ?', cost, id);
      addMsg(office, id, r.name, out.text.trim() || '(diam)', 'bicara', out.cost);
      out.done();
    }
  }
  if (state.cancelled) throw new Error('dibatalkan');
  addMsg(office, id, 'Sistem', `${chair.name} menyusun notulen…`, 'sistem');
  const notePrompt = [
    `Kamu ketua rapat ini. Topik: ${meet.topic}`,
    `Peserta:\n${roster}`,
    `Transkrip lengkap:\n${transcript()}`,
    'Tulis notulen sebagai JSON saja (tanpa teks lain, tanpa code fence) dengan bentuk:',
    '{"ringkasan": "3-6 kalimat", "keputusan": ["..."], "tindak_lanjut": [{"judul": "kalimat perintah singkat", "untuk": "<id role dari daftar peserta atau kosong>", "prioritas": "P0|P1|P2|P3", "detail": "1-2 kalimat"}]}',
    'Semua dalam Bahasa Indonesia. Tindak lanjut harus konkret dan bisa dijadikan kartu board.',
  ].join('\n\n');
  const out = await ask(office, chair, notePrompt, `Notulen: ${meet.topic}`, state, { tools: false });
  cost += out.cost;
  const data = parseJson(out.text) || { ringkasan: out.text.trim(), keputusan: [], tindak_lanjut: [] };
  const fresh = (data.tindak_lanjut || []).map(a => ({ title: String(a.judul || '').slice(0, 160), who: roles.some(r => r.id === a.untuk) ? a.untuk : null, prio: ['P0', 'P1', 'P2', 'P3'].includes(a.prioritas) ? a.prioritas : 'P2', detail: a.detail || '', card: null })).filter(a => a.title);
  // a continued meeting keeps the follow-ups that already became cards
  const kept = j(meet.actions, []).filter(a => a.card);
  const actions = [...kept, ...fresh.filter(a => !kept.some(k => k.title.toLowerCase() === a.title.toLowerCase()))];
  const date = new Date().toISOString().slice(0, 10);
  const slug = meet.wiki_slug || `rapat-${date}-${id.slice(1, 6)}`;
  const body = [
    `# Rapat: ${meet.topic}`, '', `Tanggal: ${date} · Ketua: ${chair.name} · Peserta: ${roles.map(r => r.name).join(', ')}`, '',
    '## Ringkasan', data.ringkasan || '-', '', '## Keputusan', ...(data.keputusan?.length ? data.keputusan.map(k => `- ${k}`) : ['- (tidak ada)']), '',
    '## Tindak lanjut', ...(actions.length ? actions.map(a => `- [ ] ${a.title}${a.who ? ` — ${roles.find(r => r.id === a.who)?.name}` : ''} (${a.prio})`) : ['- (tidak ada)']), '',
    '## Transkrip', transcript().split('\n\n').map(x => `> ${x.replace(/\n/g, '\n> ')}`).join('\n\n'),
  ].join('\n');
  saveWiki(office, { slug, title: `Rapat ${date}: ${meet.topic.slice(0, 60)}`, body, msg: 'Notulen rapat' }, chair.name);
  run(db, "UPDATE meetings SET status = 'selesai', ended_at = ?, summary = ?, decisions = ?, actions = ?, cost = ?, wiki_slug = ? WHERE id = ?",
    nowIso(), data.ringkasan || '', JSON.stringify(data.keputusan || []), JSON.stringify(actions), cost, slug, id);
  addMsg(office, id, 'Sistem', `Rapat selesai. Notulen tersimpan di wiki. Biaya rapat sekitar $${cost.toFixed(2)}.`, 'sistem');
  logOffice(office, chair.name, `menutup rapat "${meet.topic.slice(0, 40)}" (${actions.length} tindak lanjut)`, 'meeting');
}

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

/** One headless turn for a role. The session is registered so the role appears in the meeting room. */
/** One headless turn for a Codex role: `codex exec --json`, read-only sandbox, persona as developer instructions. */
export function askCodex(office, role, prompt, title, state, { tools = true, typing = false } = {}) {
  const bin = codexBin();
  if (!bin) throw new Error('Perintah codex tidak ditemukan');
  const m = officeModel(office);
  const room = m.plan.rooms.find(r => r.id === role.room);
  let cwd = room?.path ? path.join(m.root, room.path) : m.root;
  if (!fs.existsSync(cwd)) cwd = m.root;
  const sid = crypto.randomUUID();
  const persona = `Kamu adalah ${role.name}, ${role.title} di kantor ${m.name}. Kepribadian: ${role.persona || '-'}. Keahlian: ${(role.skills || []).join(', ') || '-'}.${role.notes ? `\nBuku catatanmu:\n${role.notes.slice(0, 3000)}` : ''}${tools ? '' : '\nJawab langsung dari pengetahuan dan konteks rapat; jangan memakai tool.'}`;
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, '-c', `developer_instructions=${tomlStr(persona)}`];
  if (role.model) args.push('-m', role.model);
  if (role.effort) args.push('-c', `model_reasoning_effort=${tomlStr(role.effort)}`);
  args.push('--', prompt);
  expectSession({ sid, office, role: role.id, room: 'meeting', cwd, title, engine: 'codex' });
  const s = live.get(sid); if (s) { s.kind = 'rapat'; s.room = 'meeting'; s.status = 'working'; }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    let err = '', last = '', failed = '';
    const typer = typing ? createTyper(office, state.meetingId, role) : null;
    typer?.start();
    const lines = createLineParser(o => {
      if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) { last = o.item.text; typer?.text(last); }
      else if (o.type === 'turn.failed' || o.type === 'error') failed = String(o.error?.message || o.message || 'error');
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    child.stdout.on('data', d => lines.feed(String(d)));
    child.stderr.on('data', d => { err = (err + d).slice(-1000); });
    child.on('close', code => {
      clearTimeout(timer);
      lines.flush();
      state.child = null;
      const ls = live.get(sid); if (ls) { ls.status = 'ended'; bus.emit('msg', { t: 'session-gone', office, sid }); live.delete(sid); }
      const fail = e => { typer?.end(); reject(e); };
      if (state.cancelled) return fail(new Error('dibatalkan'));
      if (!last) return fail(new Error(`${role.name} tidak menjawab (${(failed || err).trim().slice(-200) || 'exit ' + code})`));
      resolve({ text: last, cost: 0, done: () => typer?.end() });
    });
  });
}

function ask(office, role, prompt, title, state, { tools = true, typing = false } = {}) {
  if (role.engine === 'codex') return askCodex(office, role, prompt, title, state, { tools, typing });
  const { claude } = bins();
  if (!claude) throw new Error('Perintah claude tidak ditemukan');
  const m = officeModel(office);
  const room = m.plan.rooms.find(r => r.id === role.room);
  let cwd = room?.path ? path.join(m.root, room.path) : m.root;
  if (!fs.existsSync(cwd)) cwd = m.root;
  const sid = crypto.randomUUID();
  const persona = `Kamu adalah ${role.name}, ${role.title} di kantor ${m.name}. Kepribadian: ${role.persona || '-'}. Keahlian: ${(role.skills || []).join(', ') || '-'}.${role.notes ? `\nBuku catatanmu:\n${role.notes.slice(0, 3000)}` : ''}`;
  const args = ['-p', prompt, '--session-id', sid, '--model', (role.engine === 'codex' ? '' : role.model) || 'sonnet', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', persona,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', tools ? '8' : '2'];
  if (tools) args.push('--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk');
  else args.push('--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', '--permission-mode', 'dontAsk');
  if (!globalHooksInstalled()) { const f = path.join(RUN_DIR, `${sid}.settings.json`); fs.writeFileSync(f, JSON.stringify(hookSettings()), { mode: 0o600 }); args.push('--settings', f); }
  expectSession({ sid, office, role: role.id, room: 'meeting', cwd, title });
  const s = live.get(sid); if (s) { s.kind = 'rapat'; s.room = 'meeting'; s.status = 'working'; }
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd, env: { ...process.env, KANTOR_SID: sid }, stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    let out = '', err = '';
    // typing: the turn's words stream to the UI as they are written; the caller closes it (out.done) after saving the message
    const typer = typing ? createTyper(office, state.meetingId, role) : null;
    typer?.start();
    const stream = createClaudeStream(t => typer?.text(t));
    const lines = createLineParser(o => stream.handle(o));
    const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    child.stdout.on('data', d => { out = (out + d).slice(-1000); lines.feed(String(d)); });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      lines.flush();
      state.child = null;
      const ls = live.get(sid); if (ls) { ls.status = 'ended'; bus.emit('msg', { t: 'session-gone', office, sid }); live.delete(sid); }
      const fail = e => { typer?.end(); reject(e); };
      if (state.cancelled) return fail(new Error('dibatalkan'));
      const data = stream.result;
      if (!data) return fail(new Error(`${role.name} tidak menjawab (${(err || out).trim().slice(-200) || 'exit ' + code})`));
      if (data.is_error && !data.result) return fail(new Error(`${role.name}: ${String(data.result || data.subtype || 'error').slice(0, 200)}`));
      resolve({ text: String(data.result || ''), cost: Number(data.total_cost_usd) || 0, done: () => typer?.end() });
    });
  });
}

export function actionToCard(office, meetingId, index, by = who()) {
  const db = officeDb(office);
  const meet = one(db, 'SELECT * FROM meetings WHERE id = ?', meetingId);
  if (!meet) throw new Error('Rapat tidak ditemukan');
  const actions = j(meet.actions, []);
  const idxs = index === 'all' ? actions.map((_, i) => i) : [Number(index)];
  for (const i of idxs) {
    const a = actions[i];
    if (!a || a.card) continue;
    const roleRow = a.who ? getRole(office, a.who) : null;
    const card = createCard(office, { title: a.title, desc: `${a.detail || ''}\n\nDari rapat: ${meet.topic}`.trim(), who: a.who, prio: a.prio, repo: roleRow?.room || '', board: boardForRole(office, roleRow).id }, by);
    a.card = card.id;
  }
  run(db, 'UPDATE meetings SET actions = ? WHERE id = ?', JSON.stringify(actions), meetingId);
  changed(office, { meeting: meetingId });
  return getMeeting(office, meetingId);
}
export { COLS };
