// Memantau draf laporan Claude Code di sesi tmux kantor dan menjalankan keputusan pemilik.
import { live, emitSessionNow, logOffice, whoOf } from './live.js';
import { paneScreen, hasTmux, pressKey } from './tmux.js';
import { draftOnScreen, draftsWaiting, inputEmpty } from './draft-prompt.js';
import * as mx from './machines.js';

const KEY = { abaikan: '0', kirim: '2' };

/** Mesin remote tempat pane sesi ini jalan, atau null untuk Mac ini. */
const remoteOf = s => { const m = s.tmux ? mx.tmuxMachineOf(s.tmux) : null; return m && mx.isRemote(m) ? m : null; };
// sama dengan paneScreen di tmux.js: hanya dasar layar
const bottom = txt => String(txt || '').trimEnd().split('\n').slice(-22).join('\n');

function apply(s, screen) {
  const title = draftOnScreen(screen);
  const next = title || draftsWaiting(screen) ? { title: title || null, siap: !!title } : null;
  if (JSON.stringify(next) === JSON.stringify(s.draftState || null)) return;
  s.draftState = next;
  emitSessionNow(s);
}

function check(s) {
  if (!s.tmux || s.status === 'ended' || !hasTmux(s.tmux)) return;
  apply(s, paneScreen(s.tmux));
}
// Pane di Mac lain: capture lewat ssh secara async supaya poller tidak menahan event loop. Mesin offline dilewati
// (draftState lama dibiarkan); pane yang tidak ada membuat capture gagal, jadi hasTmux tidak perlu dipanggil.
export async function checkRemote(s, machine = remoteOf(s)) {
  if (!s.tmux || s.status === 'ended' || !machine || mx.isOffline(machine)) return false;
  const r = await mx.execAsync(machine, 'tmux', ['capture-pane', '-p', '-t', s.tmux, '-S', '-40'], { timeout: 5000 });
  if (r.code !== 0 || s.status === 'ended') return false;
  apply(s, bottom(r.stdout));
  return true;
}
const refresh = s => remoteOf(s) ? checkRemote(s) : check(s);

let busy = false;
/** Satu putaran: pane lokal sinkron seperti biasa, pane remote satu per satu secara async. Diekspor untuk tes. */
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const remote = [];
    for (const s of live.values()) {
      const m = remoteOf(s);
      if (m) remote.push([s, m]);
      else try { check(s); } catch {}
    }
    for (const [s, m] of remote) { try { await checkRemote(s, m); } catch {} }
  } finally { busy = false; }
}

let timer = null;
export function startLaporanDraft(ms = 15000) {
  if (timer) return;
  tick();
  timer = setInterval(tick, ms);
  timer.unref?.();
}

const offlineErr = m => Object.assign(new Error(`Mesin ${mx.getMachine(m)?.name || m} sedang offline. Putuskan draf ini setelah mesinnya tersambung lagi.`), { code: 409 });

/** Keputusan pemilik atas draf: hanya menekan tombol kalau prompt-nya masih tampil dan kotak input kosong. */
export async function decideDraft(sid, aksi) {
  const s = live.get(sid);
  const m = s && remoteOf(s);
  if (m && mx.isOffline(m)) throw offlineErr(m);
  if (!s?.tmux || !hasTmux(s.tmux)) throw Object.assign(new Error('Sesi ini tidak jalan di terminal kantor. Putuskan langsung di jendelanya.'), { code: 409 });
  if (!KEY[aksi]) throw new Error('Aksi tidak dikenal');
  const screen = paneScreen(s.tmux);
  if (!draftOnScreen(screen)) { await refresh(s); throw Object.assign(new Error('Prompt draf sedang tidak tampil di terminal, jadi tombolnya belum bisa ditekan. Coba lagi saat tampil.'), { code: 409 }); }
  if (!inputEmpty(screen)) throw Object.assign(new Error('Kotak input sesi sedang berisi teks. Coba lagi setelah terkirim.'), { code: 409 });
  pressKey(s.tmux, KEY[aksi]);
  await new Promise(r => setTimeout(r, m ? 1400 : 900)); // remote: layar dibaca lewat ssh, beri waktu lebih
  await refresh(s);
  logOffice(s.office, 'Kamu', `${aksi === 'kirim' ? 'mengirim' : 'mengabaikan'} draf laporan Claude Code dari ${whoOf(s)}`, 'session');
  return { ok: true, masih: !!s.draftState?.siap };
}
