// Wires the things that ride on hook answers into live.js: reminders queued for a session (notices.js: rule changes)
// and warnings against repeated work (repeat.js). Everything here only adds context; nothing blocks a tool.
import { addHookContext, addToolObserver, whoOf } from './live.js';
import { takeNotices } from './notices.js';
import { warnBefore, recordAfter } from './repeat.js';
import { globalDb, one, run, nowIso } from './db.js';
import { sessionKonteks, labelOf } from './konteks.js';
import { isRemote } from './machines.js';

// Pengingat kerja berulang (repeat.js) membaca file gambar dan menjalankan git di path dari payload hook. Untuk sesi di
// Mac lain path itu milik mesin tersebut; di Mac ini path yang sama bisa saja ada (repo yang sama, user yang sama) dan
// pengingatnya jadi salah ("tidak ada file berubah"). Sesi remote dilewati; pemberitahuan aturan tetap sampai.
const localFs = s => !isRemote(s.machine);

let started = false;
export function startHookContext() {
  if (started) return;
  started = true;
  const nameOf = s => whoOf(s);
  // Sesi yang sudah jalan sebelum tool kerjaan_set ada belum punya tool itu, jadi hanya sesi sesudahnya yang diingatkan.
  let since = one(globalDb(), "SELECT value FROM kv WHERE key = 'kerjaan.since'")?.value;
  if (!since) { since = nowIso(); run(globalDb(), "INSERT INTO kv (key, value) VALUES ('kerjaan.since', ?)", since); }
  addHookContext((s, ev, p) => {
    if (ev !== 'UserPromptSubmit' || s.kerjaanTold || !s.office || s.role || /^\s*</.test(p.prompt || '') || Date.parse(s.startedAt) < Date.parse(since)) return null;
    s.kerjaanTold = true;
    if (sessionKonteks(s).kerjaan) return null;
    return '[Kantor Claude] Pemilik memantau pekerjaan tiap agen. Saat mulai pekerjaan baru atau pindah tahap besar, panggil tool kantor kerjaan_set dengan judul singkat dan langkah sekarang. Tidak perlu tiap langkah kecil.';
  });
  // label dari pemilik dengan "Kabari agennya": disampaikan sekali tiap labelnya berubah, pada prompt atau tool berikutnya
  addHookContext((s, ev) => {
    if (ev === 'PreToolUse') return null;
    const l = labelOf(s);
    if (!l?.tell) return null;
    // disimpan di DB, supaya restart daemon tidak mengabarkan label yang sama lagi
    const key = `label.told.${s.sid}`;
    if ((s.labelTold ??= one(globalDb(), 'SELECT value FROM kv WHERE key = ?', key)?.value || null) === l.at) return null;
    s.labelTold = l.at;
    run(globalDb(), 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, l.at);
    return `[Kantor Claude] Pemilik memberi label untuk sesi ini: "${l.text}". Itu ringkasan pekerjaan yang dia harapkan darimu di sesi ini. Tidak perlu dibalas.`;
  });
  addHookContext((s, ev, p) => {
    if (!s.office || ((s.engine === 'codex' || s.engine === 'opencode') && ev === 'PreToolUse')) return null; // Codex and OpenCode take context from PostToolUse / UserPromptSubmit only
    const parts = takeNotices(s.sid).map(t => `[Kantor Claude] ${t}`);
    if (ev === 'PreToolUse' && localFs(s)) { const w = warnBefore(s, p, { nameOf }); if (w) parts.push(w); }
    return parts.length ? parts.join('\n') : null;
  });
  addToolObserver((s, p, failed) => { if (s.office && s.engine !== 'codex' && localFs(s)) recordAfter(s, p, failed, { nameOf }); });
}
