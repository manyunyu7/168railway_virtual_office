// Memantau draf laporan Claude Code di sesi tmux kantor dan menjalankan keputusan pemilik.
import { live, emitSessionNow, logOffice, whoOf } from './live.js';
import { paneScreen, hasTmux, pressKey } from './tmux.js';
import { draftOnScreen, draftsWaiting, inputEmpty } from './draft-prompt.js';

const KEY = { abaikan: '0', kirim: '2' };

function check(s) {
  if (!s.tmux || s.status === 'ended' || !hasTmux(s.tmux)) return;
  const screen = paneScreen(s.tmux), title = draftOnScreen(screen);
  const next = title || draftsWaiting(screen) ? { title: title || null, siap: !!title } : null;
  if (JSON.stringify(next) === JSON.stringify(s.draftState || null)) return;
  s.draftState = next;
  emitSessionNow(s);
}

let timer = null;
export function startLaporanDraft(ms = 15000) {
  if (timer) return;
  const tick = () => { for (const s of live.values()) { try { check(s); } catch {} } };
  tick();
  timer = setInterval(tick, ms);
  timer.unref?.();
}

/** Keputusan pemilik atas draf: hanya menekan tombol kalau prompt-nya masih tampil dan kotak input kosong. */
export async function decideDraft(sid, aksi) {
  const s = live.get(sid);
  if (!s?.tmux || !hasTmux(s.tmux)) throw Object.assign(new Error('Sesi ini tidak jalan di terminal kantor. Putuskan langsung di jendelanya.'), { code: 409 });
  if (!KEY[aksi]) throw new Error('Aksi tidak dikenal');
  const screen = paneScreen(s.tmux);
  if (!draftOnScreen(screen)) { check(s); throw Object.assign(new Error('Prompt draf sedang tidak tampil di terminal, jadi tombolnya belum bisa ditekan. Coba lagi saat tampil.'), { code: 409 }); }
  if (!inputEmpty(screen)) throw Object.assign(new Error('Kotak input sesi sedang berisi teks. Coba lagi setelah terkirim.'), { code: 409 });
  pressKey(s.tmux, KEY[aksi]);
  await new Promise(r => setTimeout(r, 900));
  check(s);
  logOffice(s.office, 'Kamu', `${aksi === 'kirim' ? 'mengirim' : 'mengabaikan'} draf laporan Claude Code dari ${whoOf(s)}`, 'session');
  return { ok: true, masih: !!s.draftState?.siap };
}
