// Magang: panel pengaturan (jumlah, otomatis, usir semua), menu ketuk satu Magang, dan aksi usir. Simulasinya ada di minions.js.
import { api, post, toast, esc } from './util.js';

/** Usir satu Magang: dia pamit dan jalan ke lift saat itu juga; server menyimpan dan mengabari klien lain. */
export async function usirMinion(stage, officeId, id) {
  const m = stage?.minions?.get(id);
  stage?.minions?.leave(id);
  if (!officeId) return;
  try { await post(`/api/offices/${officeId}/minions/${encodeURIComponent(id)}/usir`); if (m) toast(`${m.name} diusir`, 'ok'); }
  catch (err) { toast(err.message, 'bad'); }
}

/** Menu kecil di dekat titik ketuk (px di dalam host stage). */
export function showMinionMenu(host, stage, officeId, id, sx, sy) {
  closeMinionMenu();
  const m = stage.minions.get(id); if (!m) return;
  const el = document.createElement('div');
  el.className = 'mg-menu'; el.setAttribute('role', 'menu');
  el.innerHTML = `<div class="mg-menu-h"><span class="mg-badge">MAGANG</span> <b>${esc(m.name)}</b></div>
    <div class="mg-menu-b"><button class="btn sm danger" data-mg="usir">Usir</button><button class="btn sm" data-mg="x">Tutup</button></div>`;
  host.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight, hw = host.clientWidth, hh = host.clientHeight;
  el.style.left = Math.max(6, Math.min(hw - w - 6, sx - w / 2)) + 'px';
  el.style.top = Math.max(6, Math.min(hh - h - 6, sy - h - 14)) + 'px';
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-mg]'); if (!b) return;
    closeMinionMenu();
    if (b.dataset.mg === 'usir') usirMinion(stage, officeId, id);
  });
  const away = e => { if (!el.contains(e.target)) closeMinionMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', away, { once: true, capture: true }), 0);
  el._t = setTimeout(closeMinionMenu, 8000);
}
export function closeMinionMenu() { document.querySelectorAll('.mg-menu').forEach(e => { clearTimeout(e._t); e.remove(); }); }

/** Kartu pengaturan di panel samping Kantor. getOffice() -> office (dengan .minions). */
export const minionCardHTML = () => `<div class="card mg-card" id="mgCard"><p class="eyebrow card-h">Magang</p><div id="mgBody"></div></div>`;
export function paintMinionCard(getOffice, getCount) {
  const el = document.getElementById('mgBody'); if (!el) return;
  const o = getOffice(), v = o?.minions; if (!v) { el.innerHTML = '<p class="hint">Tidak tersedia.</p>'; return; }
  const max = v.max || 30;
  if (el.dataset.ready !== o.id) {
    el.dataset.ready = o.id;
    el.innerHTML = `<p class="hint mg-hint">Karyawan magang tidak memanggil model apa pun: murni ramai-ramai. Mereka mengalah ke agen dan ke kamu.</p>
      <label class="mg-row"><span>Jumlah</span><input type="range" id="mgRange" min="0" max="${max}" step="1" aria-label="Jumlah Magang"><output id="mgOut"></output></label>
      <label class="mg-row mg-check"><input type="checkbox" id="mgAuto"><span>Otomatis <span class="hint">(sepi malam, berkurang saat banyak agen bekerja)</span></span></label>
      <div class="btn-row"><button class="btn sm danger" id="mgAll">Usir semua</button><span class="hint" id="mgNow"></span></div>`;
    const range = el.querySelector('#mgRange'), out = el.querySelector('#mgOut');
    let t = null;
    const put = body => api(`/api/offices/${o.id}/minions`, { method: 'PUT', body }).then(r => { o.minions = r; }).catch(err => toast(err.message, 'bad'));
    range.addEventListener('input', () => { out.textContent = range.value; clearTimeout(t); t = setTimeout(() => put({ count: Number(range.value) }), 250); });
    el.querySelector('#mgAuto').addEventListener('change', e => put({ auto: e.target.checked }));
    el.querySelector('#mgAll').addEventListener('click', () => { if (!getOffice().minions.count) return toast('Tidak ada Magang', 'warn'); put({ usirSemua: true }).then(() => toast('Semua Magang pulang', 'ok')); });
  }
  const range = el.querySelector('#mgRange'), auto = el.querySelector('#mgAuto');
  if (document.activeElement !== range) range.value = v.count;
  el.querySelector('#mgOut').textContent = range.value;
  auto.checked = !!v.auto;
  const here = getCount?.();
  el.querySelector('#mgNow').textContent = v.auto && here != null ? `${here} di kantor sekarang` : '';
}
