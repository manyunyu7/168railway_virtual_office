// Wires the things that ride on hook answers into live.js: reminders queued for a session (notices.js: rule changes)
// and warnings against repeated work (repeat.js). Everything here only adds context; nothing blocks a tool.
import { addHookContext, addToolObserver, whoOf } from './live.js';
import { takeNotices } from './notices.js';
import { warnBefore, recordAfter } from './repeat.js';

let started = false;
export function startHookContext() {
  if (started) return;
  started = true;
  const nameOf = s => whoOf(s);
  addHookContext((s, ev, p) => {
    if (!s.office || (s.engine === 'codex' && ev === 'PreToolUse')) return null; // Codex takes context from PostToolUse / UserPromptSubmit only
    const parts = takeNotices(s.sid).map(t => `[Kantor Claude] ${t}`);
    if (ev === 'PreToolUse') { const w = warnBefore(s, p, { nameOf }); if (w) parts.push(w); }
    return parts.length ? parts.join('\n') : null;
  });
  addToolObserver((s, p, failed) => { if (s.office && s.engine !== 'codex') recordAfter(s, p, failed, { nameOf }); });
}
