// Ingat posisi: satu tab terakhir secara global (ikut saat pindah kantor) dan sesi chat terakhir per kantor.
// Link dengan tab eksplisit selalu menang. Rute kompleks tidak dicatat.
const TAB_KEY = 'kc.nav.tab', SID_KEY = 'kc.nav.sid.';
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
export const tabLoad = () => get(TAB_KEY) || '';
export const tabSave = tab => set(TAB_KEY, tab);
export const sidLoad = officeId => get(SID_KEY + officeId) || '';
export const sidSave = (officeId, sid) => set(SID_KEY + officeId, sid);

/**
 * Tentukan tab dan sesi yang dibuka. r = rute hasil parse ({id, tab, explicit, rest}), prev = rute sebelumnya,
 * saved = { tab, sid }, ok = { tab(k), session(sid), pending: sid yang diminta program (panel Agen, kartu beranda), pendingTab }.
 * Mengembalikan { tab, rest, usedPending } bila ada yang berubah, atau null.
 */
export function resolveNav(r, prev, saved, ok) {
  let tab = r.tab, rest = r.rest || [], changed = false, usedPending = false;
  const sameOffice = prev?.name === 'office' && prev.id === r.id;
  // link program (pending) ke kantor yang sama tetap berupa link tanpa tab, jadi ikut tab yang sedang dibuka
  if (!r.explicit && (!sameOffice || ok.pending) && saved.tab && saved.tab !== 'kantor' && ok.tab(saved.tab)) { tab = saved.tab; rest = []; changed = true; }
  // Chat dan Terminal sama-sama daftar agen + satu sesi
  const paned = tab === 'chat' || tab === 'terminal';
  if (paned && !rest[0] && !(sameOffice && prev.tab === tab && !ok.pending)) {
    if (ok.pending && (tab === 'terminal' || ok.pendingTab !== 'term') && ok.session(ok.pending)) { rest = [ok.pending]; usedPending = true; changed = true; }
    else if (saved.sid && ok.session(saved.sid)) { rest = [saved.sid]; changed = true; }
  }
  return changed ? { tab, rest, usedPending } : null;
}
