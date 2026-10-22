// Gentle warnings against repeated work: the same image read again although the file did not change, and the same
// tsc / test command run again although no file in the tree changed. Never blocks: the warning rides along as
// additionalContext of the PreToolUse hook (see hookctx.js), the tool still runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
const HASH_MAX = 8 * 1024 * 1024;
const CAP = 600;
// checks worth warning about: type checks, test runs, linters, builds
const CHECKS = [
  /(^|[\s;&|(])(npx\s+|pnpm\s+(exec\s+)?|yarn\s+|bunx\s+)?(tsc|tsgo|vue-tsc)(\s|$)/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|typecheck|type-check|tsc|lint|check|build|e2e|test:[\w:-]+)\b/,
  /\b(vitest|jest|mocha|pytest|phpunit|rspec)\b/, /\bplaywright\s+test\b/, /\bcypress\s+run\b/,
  /\bnode\s+--test\b/, /\bgo\s+(test|vet)\b/, /\bcargo\s+(test|check|clippy)\b/, /\b(flutter|dart)\s+(test|analyze)\b/,
  /\bphp\s+artisan\s+test\b/, /\beslint\b/, /\bruff\b/, /\bmypy\b/,
];
const NOT_CHECK = /(--watch\b|\s-w\b|\bwatch\b|\bnpm\s+(run\s+)?dev\b|\bstart\b)/;

const imgSeen = new Map(); // office|path|hash -> {by, sid, at, toolUseId, transcript, count, bySid: Map(sid -> count)}
const cmdRuns = new Map(); // office|cwd|cmd -> {fp, at, sid, by, ok, count}

const cap = m => { while (m.size > CAP) m.delete(m.keys().next().value); };
const clock = at => new Date(at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** Same file content or same size+mtime. */
function fileSig(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  if (st.size <= HASH_MAX) return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/** What the assistant wrote right after a tool result, read back from the transcript (the "summary" of what was seen there). */
export function textAfterTool(transcript, toolUseId) {
  if (!transcript || !toolUseId) return null;
  try {
    const st = fs.statSync(transcript);
    const len = Math.min(st.size, 6 * 1024 * 1024);
    const fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    let seen = false;
    for (const line of lines) {
      if (!seen) { if (line.includes(toolUseId) && line.includes('tool_result')) seen = true; continue; }
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant') continue;
      const t = (o.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
      if (t.length >= 12) return clip(t, 260);
    }
  } catch {}
  return null;
}

export function normalizeCmd(cmd) {
  let c = String(cmd ?? '').replace(/\s+/g, ' ').trim();
  c = c.replace(/\s*2>&1/g, '');
  for (let i = 0; i < 3; i++) c = c.replace(/\s*\|\s*(tail|head|grep|wc|tee|cat|sed|awk)\b[^|]*$/, '');
  return c.trim();
}
export function isCheckCommand(cmd) {
  const c = normalizeCmd(cmd);
  return !!c && CHECKS.some(re => re.test(c)) && !NOT_CHECK.test(c);
}

/** Fingerprint of the working tree: HEAD, git status, and size+mtime of every changed file. null when cwd is not in a git repo. */
export function treeFingerprint(cwd) {
  if (!cwd) return null;
  try {
    const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 900, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const top = git('rev-parse', '--show-toplevel').trim();
    const head = git('rev-parse', 'HEAD').trim();
    const status = git('status', '--porcelain=v1', '-uall');
    const h = crypto.createHash('sha1').update(head).update('\0').update(status);
    for (const line of status.split('\n').slice(0, 400)) {
      const f = line.slice(3).split(' -> ').pop();
      if (!f) continue;
      try { const s = fs.statSync(path.join(top, f.replace(/^"|"$/g, ''))); h.update(`${f}:${s.size}:${Math.round(s.mtimeMs)}\n`); } catch { h.update(`${f}:-\n`); }
    }
    return h.digest('hex');
  } catch { return null; }
}

/** PreToolUse: returns a warning text or null. */
export function warnBefore(s, p, { nameOf = () => 'agen lain' } = {}) {
  const input = p.tool_input || {};
  if (p.tool_name === 'Read' && input.file_path && IMG.test(input.file_path)) {
    const file = path.resolve(p.cwd || s.cwd || '/', input.file_path);
    let sig; try { sig = fileSig(file); } catch { return null; }
    if (!sig) return null;
    const key = `${s.office}|${file}|${sig}`;
    const rec = imgSeen.get(key);
    const mine = rec?.bySid.get(s.sid) || 0;
    const base = path.basename(file);
    if (!rec) { imgSeen.set(key, { by: nameOf(s), sid: s.sid, at: Date.now(), toolUseId: p.tool_use_id, transcript: s.transcript, bySid: new Map([[s.sid, 1]]) }); cap(imgSeen); return null; }
    rec.bySid.set(s.sid, mine + 1);
    const total = [...rec.bySid.values()].reduce((a, b) => a + b, 0);
    const summary = textAfterTool(rec.transcript, rec.toolUseId);
    const note = summary ? ` Yang ditulis sesudah melihatnya: "${summary}".` : '';
    if (mine) return `[Pengingat Kantor] Gambar ${base} sudah kamu baca (terakhir pukul ${clock(rec.at)}, sekarang ke-${mine + 1} kalinya) dan isinya persis sama, belum berubah.${note} Tidak perlu membacanya lagi: pakai temuan tadi. Kalau memang butuh detail lain, sebut bagian gambar yang kamu cari.`;
    return `[Pengingat Kantor] Gambar ${base} dengan isi persis sama sudah dilihat ${rec.by} pukul ${clock(rec.at)} (total ${total} pembacaan oleh tim).${note} Kamu bisa memakai temuan itu atau bertanya kepadanya, tanpa membaca ulang.`;
  }
  if (p.tool_name === 'Bash' && isCheckCommand(input.command)) {
    const cwd = p.cwd || s.cwd;
    const key = `${s.office}|${cwd}|${normalizeCmd(input.command)}`;
    const rec = cmdRuns.get(key);
    if (!rec) return null;
    const fp = treeFingerprint(cwd);
    if (!fp || fp !== rec.fp) return null;
    const who = rec.sid === s.sid ? 'kamu' : rec.by;
    return `[Pengingat Kantor] Perintah ini sudah dijalankan ${who} pukul ${clock(rec.at)} (${rec.count}x berturut-turut tanpa perubahan file; hasil terakhir: ${rec.ok ? 'lulus' : 'gagal'}) dan sejak itu tidak ada file yang berubah di pohon kerja, jadi hasilnya akan sama. Ubah kodenya dulu, atau pakai hasil sebelumnya; ulangi hanya kalau kamu memang mencurigai tes yang tidak stabil.`;
  }
  return null;
}

/** PostToolUse: remember a finished check command together with the tree as it was afterwards. */
export function recordAfter(s, p, failed, { nameOf = () => 'agen lain' } = {}) {
  if (p.tool_name !== 'Bash' || !isCheckCommand(p.tool_input?.command)) return;
  const cwd = p.cwd || s.cwd;
  const fp = treeFingerprint(cwd);
  if (!fp) return;
  const key = `${s.office}|${cwd}|${normalizeCmd(p.tool_input.command)}`;
  const prev = cmdRuns.get(key);
  cmdRuns.set(key, { fp, at: Date.now(), sid: s.sid, by: nameOf(s), ok: !failed, count: prev && prev.fp === fp ? prev.count + 1 : 1 });
  cap(cmdRuns);
}

export function resetRepeat() { imgSeen.clear(); cmdRuns.clear(); }
