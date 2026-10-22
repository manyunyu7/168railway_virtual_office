// Tab bar kantor yang bisa diurutkan ulang: seret (mouse / tekan lama di layar sentuh) atau dialog "Atur tab".
// Urutan global disimpan di server (GET/PUT /api/settings/tabs) dan di-cache di localStorage.
import { $, esc, api, toast, modal } from './util.js';
import { mergeOrder, defaultOrder } from './tab-order.js';

const LS = 'kantor.tabOrder';
let saved = null;
try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch {}
let mounted = null; // { nav, opts, hidden: tab yang dipindah ke menu }
const fetched = api('/api/settings/tabs').then(r => { if (JSON.stringify(r.order) !== JSON.stringify(saved)) { setLocal(r.order); repaint(); } }).catch(() => {});

function setLocal(order) { saved = order; try { order ? localStorage.setItem(LS, JSON.stringify(order)) : localStorage.removeItem(LS); } catch {} }
async function persist(order) {
  setLocal(order); repaint();
  try { await api('/api/settings/tabs', { method: 'PUT', body: { order } }); } catch (e) { toast(`Urutan tab gagal disimpan: ${e.message}`, 'err'); }
}
export const orderTabs = known => mergeOrder(saved, known);

function repaint() {
  if (!mounted || !mounted.nav.isConnected) return;
  const { nav, opts } = mounted;
  closeMenu();
  nav.innerHTML = orderTabs(opts.tabs).map(k => `<a role="tab" draggable="false" data-tab="${esc(k)}" href="${esc(opts.href(k))}" aria-selected="${opts.current === k}">${esc(opts.labels[k] || k)}</a>`).join('')
    + `<button type="button" class="tab-more" aria-haspopup="menu" aria-expanded="false" title="Tab lainnya"></button>`;
  fit();
  if ($('#tabOrderList')) paintDialog();
}

/* ---- muat-sebisanya: tab yang tidak muat pindah ke menu "Lainnya" (tab yang terbuka selalu terlihat) ---- */
function fit() {
  if (!mounted || !mounted.nav.isConnected) return;
  const { nav, opts } = mounted, more = nav.querySelector('.tab-more'), tabs = [...nav.querySelectorAll('a[data-tab]')];
  tabs.forEach(a => { a.hidden = false; });
  more.hidden = true;
  const over = () => nav.scrollWidth > nav.clientWidth + 1;
  const hidden = [];
  if (over()) {
    more.hidden = false; more.textContent = 'Lainnya ▾';
    for (const a of [...tabs].reverse()) {
      if (!over()) break;
      if (a.getAttribute('aria-selected') === 'true') continue;
      a.hidden = true; hidden.unshift(a);
    }
  }
  mounted.hidden = hidden;
  if (!hidden.length) { more.hidden = opts.reorder === false; more.textContent = '⋯'; }
  more.classList.toggle('dot', hidden.some(a => { const b = a.querySelector('.tab-badge'); return b && !b.hidden; }));
  nav.scrollLeft = 0;
}
/** Hitung ulang (mis. setelah lencana tab berubah lebar). */
export const refitTabBar = () => fit();

function closeMenu() { const m = $('#tabMoreMenu'); if (!m) return; m.remove(); mounted?.nav.querySelector('.tab-more')?.setAttribute('aria-expanded', 'false'); }
function openMenu(btn) {
  if ($('#tabMoreMenu')) { closeMenu(); return; }
  const m = document.createElement('div');
  m.id = 'tabMoreMenu'; m.className = 'tab-more-menu'; m.setAttribute('role', 'menu');
  m.innerHTML = (mounted.hidden || []).map(a => `<a role="menuitem" href="${esc(a.getAttribute('href'))}">${a.innerHTML}</a>`).join('')
    + (mounted.opts.reorder === false ? '' : `${mounted.hidden?.length ? '<hr>' : ''}<button type="button" role="menuitem" data-tcfg>Atur urutan tab…</button>`);
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  btn.setAttribute('aria-expanded', 'true');
  m.addEventListener('click', e => { if (e.target.closest('[data-tcfg]')) { closeMenu(); openDialog(); } else if (e.target.closest('a')) closeMenu(); });
  m.querySelector('a,button')?.focus();
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#tabMoreMenu,.tab-more')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#tabMoreMenu')) { closeMenu(); mounted?.nav.querySelector('.tab-more')?.focus(); } });
addEventListener('resize', () => closeMenu());
let ro = null;

// opts: { tabs:[ids], labels:{id:label}, href:id=>url, current, reorder }
export function mountTabBar(nav, opts) {
  mounted = { nav, opts, hidden: [] };
  repaint();
  // lebar yang tersedia berubah (jendela, panel samping, ikon header): atur ulang mana yang muat
  ro?.disconnect();
  ro = new ResizeObserver(() => requestAnimationFrame(fit));
  ro.observe(nav.parentElement || nav);
  document.fonts?.ready.then(() => fit());
  if (nav.dataset.reorderBound) return;
  nav.dataset.reorderBound = '1';
  nav.addEventListener('click', e => { const b = e.target.closest('.tab-more'); if (b) openMenu(b); });
  if (opts.reorder !== false) bindDrag(nav);
}

/* ---- seret ---- */
function bindDrag(nav) {
  let d = null, suppressClick = false;
  const tabsEl = () => [...nav.querySelectorAll('a[data-tab]')];
  const clearInd = () => nav.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  const blockScroll = e => { if (d?.active) e.preventDefault(); };
  nav.addEventListener('touchmove', blockScroll, { passive: false });
  const start = () => { d.active = true; d.el.classList.add('dragging'); nav.classList.add('reordering'); try { nav.setPointerCapture(d.id); } catch {} navigator.vibrate?.(15); };
  const end = () => { clearTimeout(d?.timer); d?.el.classList.remove('dragging'); nav.classList.remove('reordering'); clearInd(); d = null; };

  nav.addEventListener('pointerdown', e => {
    const el = e.target.closest('a[data-tab]');
    if (!el || e.button > 0) return;
    d = { el, id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', active: false, target: null };
    if (d.touch) d.timer = setTimeout(() => d && start(), 450);
  });
  nav.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!d.active) {
      if (d.touch) { if (moved > 8) end(); return; } // geser = gulir biasa
      if (moved < 6) return;
      start();
    }
    e.preventDefault();
    clearInd();
    const over = tabsEl().find(t => { const r = t.getBoundingClientRect(); return e.clientX >= r.left - 11 && e.clientX <= r.right + 11; });
    if (!over || over === d.el) { d.target = null; return; }
    const r = over.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    over.classList.add(after ? 'drop-after' : 'drop-before');
    d.target = { k: over.dataset.tab, after };
    // gulir otomatis di tepi
    const nr = nav.getBoundingClientRect();
    if (e.clientX < nr.left + 24) nav.scrollLeft -= 8; else if (e.clientX > nr.right - 24) nav.scrollLeft += 8;
  });
  const finish = e => {
    if (!d || e.pointerId !== d.id) return;
    if (d.active) {
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      const t = d.target, k = d.el.dataset.tab;
      if (t && e.type === 'pointerup') {
        const order = orderTabs(mounted.opts.tabs).filter(x => x !== k);
        order.splice(order.indexOf(t.k) + (t.after ? 1 : 0), 0, k);
        end(); persist(order); return;
      }
    }
    end();
  };
  nav.addEventListener('pointerup', finish);
  nav.addEventListener('pointercancel', finish);
  nav.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  nav.addEventListener('contextmenu', e => { if (d?.touch) e.preventDefault(); });
}

/* ---- dialog keyboard ---- */
function paintDialog() {
  const ul = $('#tabOrderList'); if (!ul || !mounted) return;
  const { tabs, labels } = mounted.opts, order = orderTabs(tabs);
  ul.innerHTML = order.map((k, i) => `<li><span>${esc(labels[k] || k)}</span>
    <button type="button" class="btn sm" data-tmove="${esc(k)}" data-dir="-1" ${i ? '' : 'disabled'} aria-label="Naikkan ${esc(labels[k] || k)}">↑</button>
    <button type="button" class="btn sm" data-tmove="${esc(k)}" data-dir="1" ${i < order.length - 1 ? '' : 'disabled'} aria-label="Turunkan ${esc(labels[k] || k)}">↓</button></li>`).join('');
}
function openDialog() {
  if (!mounted) return;
  modal({
    title: 'Atur tab',
    html: `<p class="muted">Seret tab di bilah atas (tekan lama di layar sentuh), atau pakai tombol di bawah. Urutan tersimpan untuk semua perangkat.</p>
      <ol id="tabOrderList" class="tab-order-list"></ol>
      <button type="button" class="btn" id="tabOrderReset">Kembalikan bawaan</button>`,
    actions: [{ label: 'Selesai', kind: 'primary' }],
  });
  paintDialog();
  const card = $('#modalCard');
  card.onclick = e => {
    const b = e.target.closest('[data-tmove]');
    if (b) {
      const order = orderTabs(mounted.opts.tabs), i = order.indexOf(b.dataset.tmove), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      persist(order);
      // pertahankan fokus di tombol yang sama setelah digambar ulang
      requestAnimationFrame(() => card.querySelector(`[data-tmove="${CSS.escape(b.dataset.tmove)}"][data-dir="${b.dataset.dir}"]:not([disabled])`)?.focus() || card.querySelector(`[data-tmove="${CSS.escape(b.dataset.tmove)}"]:not([disabled])`)?.focus());
      return;
    }
    if (e.target.closest('#tabOrderReset')) { persist(null); toast('Urutan tab dikembalikan ke bawaan'); }
  };
}
export { defaultOrder, fetched as tabOrderReady };
