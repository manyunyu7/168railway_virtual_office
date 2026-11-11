// shift_mode while the session shows a dialog: queue the change and apply it as soon as the input box is back.
import { setPermMode, paneModeAsync } from './tmux.js';
import { live, serialize, bus, logOffice } from './live.js';
import * as mx from './machines.js';

export const MODE_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const pending = new Map(); // sid -> { timer, mode }

export const isDialogError = e => /sedang menampilkan dialog/i.test(e?.message || '');

// Sesi di Mac lain (docs/MULTI-PC.md): setPermMode membaca layar lewat ssh sinkron, jadi antrean ini tidak boleh
// memanggilnya tiap 3 detik selama dialog tampil. Mesin offline: tunggu saja. Mesin online: layar dicek dulu secara
// async (sesi Claude), dan apply baru dipanggil saat kotak input sudah kembali. Sesi lokal tetap seperti semula.
const remoteOf = s => { const m = s.tmux ? mx.tmuxMachineOf(s.tmux) : s.machine; return m && mx.isRemote(m) ? m : null; };
const isClaude = s => !s.engine || s.engine === 'claude';

/**
 * Keep trying to set `mode` on session `s` until the dialog is gone. The latest request per session wins.
 * `apply`, `pollMs`, `waitMs` and `log` are injectable for tests.
 */
export function queueMode(s, mode, { office, who, label, apply = sid => setPermMode(sid, mode), probe = paneModeAsync, pollMs = POLL_MS, waitMs = MODE_WAIT_MS, log = logOffice, done } = {}) {
  const old = pending.get(s.sid);
  if (old) clearTimeout(old.timer);
  const t0 = Date.now();
  const me = { mode, timer: null };
  const mine = () => pending.get(s.sid) === me; // a newer queueMode (even for the same mode) replaces this loop
  const finish = (msg, ok) => { if (mine()) pending.delete(s.sid); log(office, who, msg, 'sesi'); done?.(ok, msg); };
  const again = () => { me.timer = setTimeout(tick, pollMs); };
  const tick = async () => {
    if (!mine()) return;
    if (s.status === 'ended' || !live.has(s.sid)) return finish(`jadwal mode izin ${label} batal: sesinya sudah selesai`, false);
    const machine = remoteOf(s);
    if (machine && mx.isOffline(machine)) {
      if (Date.now() - t0 >= waitMs) return finish(`jadwal mode izin ${label} batal: mesin ${mx.getMachine(machine)?.name || machine} offline selama ${Math.round(waitMs / 60000)} menit`, false);
      return again();
    }
    if (machine && s.tmux && isClaude(s)) {
      const seen = await probe(s.tmux).catch(() => null); // null: dialog masih tampil (atau layar tak terbaca)
      if (!mine()) return;
      if (seen == null) {
        if (Date.now() - t0 >= waitMs) return finish(`jadwal mode izin ${label} batal: dialog tidak hilang dalam ${Math.round(waitMs / 60000)} menit`, false);
        return again();
      }
    }
    try {
      const r = await apply(s.sid);
      try { bus.emit('msg', { t: 'session', office, session: serialize(s) }); } catch {}
      return finish(`mode izin ${label} jadi ${r.mode} (sesuai jadwal)`, true);
    } catch (e) {
      if (!isDialogError(e)) return finish(`jadwal mode izin ${label} gagal: ${String(e.message).slice(0, 160)}`, false);
    }
    if (Date.now() - t0 >= waitMs) return finish(`jadwal mode izin ${label} batal: dialog tidak hilang dalam ${Math.round(waitMs / 60000)} menit`, false);
    again();
  };
  me.timer = setTimeout(tick, pollMs);
  me.timer.unref?.();
  pending.set(s.sid, me);
}
export const pendingMode = sid => pending.get(sid)?.mode || null;
export function cancelModes() { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }
