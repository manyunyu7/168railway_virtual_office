// Multi-PC: lencana "di mesin mana" untuk agen dan ruangan, plus keadaan offline. Tanpa impor supaya bisa dites di node;
// sumber daftar mesin (mesin.js) dipasang oleh main.js lewat setMachineSource. Mac ini (null/'local') tidak pernah berlencana.
let SRC = { machines: () => [], machineName: null };

export function setMachineSource(src) { SRC = { ...SRC, ...src }; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isLocal = id => !id || id === 'local';
const list = () => { try { const l = SRC.machines?.(); return Array.isArray(l) ? l : []; } catch { return []; } };
export const machineOf = id => isLocal(id) ? null : list().find(m => m.id === id) || null;

/** Nama tampilan mesin remote; '' untuk Mac ini. */
export function machineLabel(id) {
  if (isLocal(id)) return '';
  let n = null;
  try { n = SRC.machineName?.(id); } catch {}
  return String(n || machineOf(id)?.name || id);
}
/** Mesin remote yang terakhir diketahui offline (online === false, sama dengan isOffline di server). */
export const machineDown = id => !isLocal(id) && machineOf(id)?.online === false;

/** Sesi di mesin yang sedang offline. Status mesin dari event { t:'machine' } lebih baru daripada salinan di sesi. */
export function sessOffline(s) {
  if (!s || isLocal(s.machine) || s.status === 'ended') return false;
  const m = machineOf(s.machine);
  return m && typeof m.online === 'boolean' ? m.online === false : !!s.machineOffline;
}
export const roomMachine = r => r && !isLocal(r.machine) ? r.machine : null;
export const roomOffline = r => !!roomMachine(r) && machineDown(r.machine);
/** Mesin tempat role bekerja: mesin ruangannya. */
export const roleMachine = (plan, role) => roomMachine((plan?.rooms || []).find(r => r.id === role?.room));

/** Lencana kecil "▭ Mac Studio"; kosong untuk Mac ini. off = paksa tampilan offline (mis. sesi.machineOffline). */
export function machineBadge(id, { off = machineDown(id), cls = '' } = {}) {
  if (isLocal(id)) return '';
  const n = machineLabel(id);
  return `<span class="mx-badge${off ? ' off' : ''}${cls ? ' ' + cls : ''}" title="${esc(off ? `Jalan di ${n}, sedang offline` : `Jalan di ${n}`)}"><i class="mx-ic" aria-hidden="true"></i>${off ? '<span class="mx-offl">offline ·&nbsp;</span>' : ''}${esc(n)}</span>`;
}
export const sessBadge = (s, cls) => s && !isLocal(s.machine) ? machineBadge(s.machine, { off: sessOffline(s), cls }) : '';
export const roomBadge = (r, cls) => roomMachine(r) ? machineBadge(r.machine, { cls }) : '';

/** Teks banner untuk chat/drawer sesi yang mesinnya offline. */
export const offlineText = s => `${machineLabel(s.machine)} offline. Pesan disimpan dan dikirim saat tersambung lagi; terminal tidak tersedia.`;
export const offlineBanner = s => sessOffline(s) ? `<div class="mx-banner" role="status"><i class="mx-ic" aria-hidden="true"></i><span>${esc(offlineText(s))}</span></div>` : '';
/** Alasan (tooltip) tombol yang butuh mesin: terminal, hentikan, ringkas, ganti model, dst. '' = boleh. */
export const blockReason = s => sessOffline(s) ? `Tidak tersedia: ${machineLabel(s.machine)} sedang offline` : '';
/** Atribut untuk tombol yang butuh mesin: ' disabled title="…"' saat offline, '' bila tidak. */
export const blockAttr = s => sessOffline(s) ? ` disabled title="${esc(blockReason(s))}"` : '';
/** Alasan ruangan tidak bisa dipakai memulai shift. */
export const roomBlockReason = r => roomOffline(r) ? `Tidak bisa mulai shift: ${machineLabel(r.machine)} sedang offline` : '';
/** Teks label antrean pesan yang belum dibaca sesi offline. */
export const outboxWaitText = s => sessOffline(s) ? `Tersimpan · dikirim saat ${machineLabel(s.machine)} tersambung lagi` : '';
/** Ada mesin remote yang dikenal? (untuk melewati pekerjaan ekstra bila tidak ada) */
export const anyRemote = () => list().length > 0;
