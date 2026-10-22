// Shared-resource locks managed by the harness (instead of agents inventing mkdir locks): "e2e", "migrasi-db",
// "dev-server-3100", "git-commit". A lock has one holder and a FIFO queue. It is released by its holder, when its time
// (maks_menit) runs out, or when the holder's session ends. kunci_ambil waits in the queue (like `tanya`) and returns
// once the lock is theirs. State lives in memory: a daemon restart frees everything, which is also what the agents lose.
import { live, bus, logOffice, whoOf } from './live.js';
import { pushNotice } from './notices.js';

export const DEFAULT_MIN = 30, MAX_MIN = 180;
export const WAIT_DEFAULT_MIN = 10, WAIT_MAX_MIN = 15;
const NAME = /^[a-z0-9][a-z0-9._:-]{0,39}$/;

const offices = new Map(); // office -> Map(name -> lock)
const book = o => { let m = offices.get(o); if (!m) offices.set(o, m = new Map()); return m; };
const now = () => Date.now();
const iso = t => new Date(t).toISOString();

export function lockName(raw) {
  const n = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!NAME.test(n)) throw new Error(`Nama kunci "${raw}" tidak valid. Pakai huruf kecil/angka/tanda minus, maks 40 karakter, mis. "e2e", "migrasi-db", "dev-server-3100".`);
  return n;
}

/** The caller as a lock participant. sid is the id the MCP server was started with (it survives /clear), tmux ties it to the pane. */
function who(ident) {
  const sid = ident.sid;
  if (!sid) throw new Error('Kunci hanya untuk sesi kantor (sesi ini tidak dikenali). Mulai lewat shift atau MCP kantor.');
  const s = live.get(sid) || [...live.values()].find(x => x.sid === sid);
  return { sid, tmux: s?.tmux || null, role: ident.role?.id || s?.role || null, by: ident.by || (s ? whoOf(s) : 'Sesi'), office: ident.office };
}

function view(l) {
  const t = now();
  return {
    nama: l.name,
    pemegang: { nama: l.holder.by, role: l.holder.role, sid: l.holder.sid },
    alasan: l.reason, sejak: iso(l.since), kedaluwarsa: iso(l.expires), sisa_menit: Math.max(0, Math.ceil((l.expires - t) / 60000)), maks_menit: l.maxMin,
    antrean: l.queue.map((q, i) => ({ posisi: i + 1, nama: q.who.by, role: q.who.role, alasan: q.reason, sejak: iso(q.since), tunggu_menit: q.waitMin })),
  };
}
export function listLocks(office) { return [...book(office).values()].map(view).sort((a, b) => a.nama.localeCompare(b.nama)); }
function changed(office) { bus.emit('msg', { t: 'locks', office, locks: listLocks(office) }); }

function grant(office, l, who_, reason, maxMin) {
  clearTimeout(l.timer);
  l.holder = who_; l.reason = reason; l.maxMin = maxMin; l.since = now(); l.expires = l.since + maxMin * 60000;
  l.timer = setTimeout(() => expire(office, l.name), maxMin * 60000);
  l.timer.unref?.();
}

/** Free the lock and hand it to the first one in line. */
function handOver(office, l, why) {
  clearTimeout(l.timer);
  const m = book(office);
  const next = l.queue.shift();
  if (!next) { m.delete(l.name); logOffice(office, l.holder.by, `kunci ${l.name} bebas (${why})`, 'kunci'); changed(office); return null; }
  clearTimeout(next.timer);
  const waited = Math.round((now() - next.since) / 1000);
  grant(office, l, next.who, next.reason, next.maxMin);
  logOffice(office, next.who.by, `mendapat kunci ${l.name} setelah antre ${waited} dtk (${why})`, 'kunci');
  changed(office);
  next.resolve({ status: 'didapat', ...view(l), menunggu_detik: waited });
  return next.who;
}

function expire(office, name) {
  const l = book(office).get(name);
  if (!l) return;
  logOffice(office, l.holder.by, `kunci ${name} dilepas otomatis: lewat ${l.maxMin} menit`, 'kunci');
  // the holder is told once, on its next tool call
  const sess = [...live.values()].find(x => x.sid === l.holder.sid || (l.holder.tmux && x.tmux === l.holder.tmux && x.status !== 'ended'));
  if (sess) pushNotice(sess.sid, `Kunci "${name}" yang kamu pegang dilepas otomatis karena melewati ${l.maxMin} menit. Kalau masih perlu, ambil lagi dengan kunci_ambil (kamu masuk antrean seperti yang lain).`, `kunci-habis:${name}`);
  handOver(office, l, 'waktu habis');
}

/**
 * Take a lock, waiting in line when someone else holds it. Resolves with:
 *  didapat | dipegang (you already hold it; time refreshed) | belum (waited tunggu_menit, still not yours) | sesi-berakhir
 */
export function acquire(ident, a = {}) {
  const w = who(ident);
  const office = w.office;
  const name = lockName(a.nama);
  const reason = String(a.alasan ?? '').trim().slice(0, 200);
  if (!reason) throw new Error('Isi `alasan` singkat (mis. "jalankan suite e2e penuh"), supaya yang antre tahu untuk apa kunci dipakai.');
  const maxMin = Math.min(MAX_MIN, Math.max(0.02, Number(a.maks_menit) || DEFAULT_MIN));
  const waitMin = a.tunggu_menit === undefined || a.tunggu_menit === null ? WAIT_DEFAULT_MIN : Math.min(WAIT_MAX_MIN, Math.max(0, Number(a.tunggu_menit) || 0));
  const m = book(office);
  let l = m.get(name);
  if (!l) {
    l = { name, holder: null, reason: '', maxMin, since: 0, expires: 0, queue: [], timer: null };
    m.set(name, l);
    grant(office, l, w, reason, maxMin);
    logOffice(office, w.by, `mengambil kunci ${name} (${maxMin} mnt): ${reason}`, 'kunci');
    changed(office);
    return Promise.resolve({ status: 'didapat', ...view(l), menunggu_detik: 0 });
  }
  if (l.holder.sid === w.sid || (w.tmux && l.holder.tmux === w.tmux)) {
    grant(office, l, { ...l.holder, sid: w.sid }, reason, maxMin);
    changed(office);
    return Promise.resolve({ status: 'dipegang', ...view(l), catatan: 'Kunci ini sudah kamu pegang; waktunya diperbarui.' });
  }
  if (l.queue.some(q => q.who.sid === w.sid || (w.tmux && q.who.tmux === w.tmux))) throw new Error(`Kamu sudah antre untuk kunci ${name}.`);
  if (!waitMin) return Promise.resolve({ status: 'belum', ...view(l), catatan: `Kunci ${name} dipegang ${l.holder.by} (${view(l).sisa_menit} menit lagi). Kamu tidak antre (tunggu_menit 0).` });
  return new Promise(resolve => {
    const q = { who: w, reason, maxMin, waitMin, since: now(), resolve, timer: null };
    q.timer = setTimeout(() => {
      const i = l.queue.indexOf(q);
      if (i >= 0) l.queue.splice(i, 1);
      logOffice(office, w.by, `menyerah antre kunci ${name} setelah ${waitMin} menit`, 'kunci');
      changed(office);
      resolve({ status: 'belum', ...(book(office).get(name) ? view(l) : { nama: name }), catatan: `Sudah menunggu ${waitMin} menit, kunci ${name} masih dipegang ${l.holder.by}. Kamu keluar dari antrean. Kerjakan hal lain dulu atau ambil lagi nanti.` });
    }, waitMin * 60000);
    q.timer.unref?.();
    l.queue.push(q);
    logOffice(office, w.by, `antre kunci ${name} (posisi ${l.queue.length}, dipegang ${l.holder.by}): ${reason}`, 'kunci');
    changed(office);
  });
}

/** Release a lock you hold. A manager may free anyone's lock with paksa. */
export function release(ident, a = {}) {
  const w = who(ident);
  const office = w.office;
  const name = lockName(a.nama);
  const l = book(office).get(name);
  if (!l) return { status: 'bebas', nama: name, catatan: 'Kunci itu tidak sedang dipegang siapa pun.' };
  const mine = l.holder.sid === w.sid || (w.tmux && l.holder.tmux === w.tmux);
  if (!mine) {
    if (!(a.paksa && ident.role?.isMgr)) throw new Error(`Kunci ${name} dipegang ${l.holder.by}, bukan kamu.${ident.role?.isMgr ? ' Sebagai manager kamu bisa memaksa dengan paksa=true.' : ''}`);
    logOffice(office, w.by, `memaksa melepas kunci ${name} milik ${l.holder.by}`, 'kunci');
  }
  const next = handOver(office, l, mine ? `dilepas ${w.by}` : `dilepas paksa oleh ${w.by}`);
  return { status: 'dilepas', nama: name, berikutnya: next?.by || null };
}

/** Everything a finished session held or waited for. */
export function releaseSession(office, sid, tmux = null) {
  const m = book(office);
  for (const l of [...m.values()]) {
    for (const q of [...l.queue]) if (q.who.sid === sid || (tmux && q.who.tmux === tmux)) {
      l.queue.splice(l.queue.indexOf(q), 1); clearTimeout(q.timer);
      q.resolve({ status: 'sesi-berakhir', nama: l.name });
      changed(office);
    }
    if (l.holder.sid === sid || (tmux && l.holder.tmux === tmux)) handOver(office, l, `sesi ${l.holder.by} berakhir`);
  }
}

bus.on('msg', msg => {
  if (msg.t !== 'session' || msg.session?.status !== 'ended') return;
  const s = msg.session;
  if (s.office) releaseSession(s.office, s.sid, s.tmux || null);
});

// a holder whose session vanished without a SessionEnd (killed pane, daemon restart) must not block the line forever
export function sweep() {
  for (const [office, m] of offices) for (const l of [...m.values()]) {
    if (now() - l.since < 90e3) continue;
    const alive = [...live.values()].some(x => (x.sid === l.holder.sid || (l.holder.tmux && x.tmux === l.holder.tmux)) && x.status !== 'ended');
    if (!alive) handOver(office, l, `pemegang ${l.holder.by} tidak aktif lagi`);
  }
}
setInterval(sweep, 30e3).unref();

export function resetLocks() { for (const m of offices.values()) for (const l of m.values()) { clearTimeout(l.timer); for (const q of l.queue) clearTimeout(q.timer); } offices.clear(); }
