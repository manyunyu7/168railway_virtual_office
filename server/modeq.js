// shift_mode while the session shows a dialog: queue the change and apply it as soon as the input box is back.
import { setPermMode } from './tmux.js';
import { live, serialize, bus, logOffice } from './live.js';

export const MODE_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const pending = new Map(); // sid -> { timer, mode }

export const isDialogError = e => /sedang menampilkan dialog/i.test(e?.message || '');

/**
 * Keep trying to set `mode` on session `s` until the dialog is gone. The latest request per session wins.
 * `apply`, `pollMs`, `waitMs` and `log` are injectable for tests.
 */
export function queueMode(s, mode, { office, who, label, apply = sid => setPermMode(sid, mode), pollMs = POLL_MS, waitMs = MODE_WAIT_MS, log = logOffice, done } = {}) {
  const old = pending.get(s.sid);
  if (old) clearTimeout(old.timer);
  const t0 = Date.now();
  const finish = (msg, ok) => { pending.delete(s.sid); log(office, who, msg, 'sesi'); done?.(ok, msg); };
  const tick = async () => {
    if (pending.get(s.sid)?.mode !== mode) return;
    if (s.status === 'ended' || !live.has(s.sid)) return finish(`jadwal mode izin ${label} batal: sesinya sudah selesai`, false);
    try {
      const r = await apply(s.sid);
      try { bus.emit('msg', { t: 'session', office, session: serialize(s) }); } catch {}
      return finish(`mode izin ${label} jadi ${r.mode} (sesuai jadwal)`, true);
    } catch (e) {
      if (!isDialogError(e)) return finish(`jadwal mode izin ${label} gagal: ${String(e.message).slice(0, 160)}`, false);
    }
    if (Date.now() - t0 >= waitMs) return finish(`jadwal mode izin ${label} batal: dialog tidak hilang dalam ${Math.round(waitMs / 60000)} menit`, false);
    pending.get(s.sid).timer = setTimeout(tick, pollMs);
  };
  pending.set(s.sid, { mode, timer: setTimeout(tick, pollMs) });
  pending.get(s.sid).timer.unref?.();
}
export const pendingMode = sid => pending.get(sid)?.mode || null;
export function cancelModes() { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }
