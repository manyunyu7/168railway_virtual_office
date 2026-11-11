// Multi-PC: strip status mesin di header (docs/MULTI-PC.md). Satu chip per mesin terdaftar: titik status, nama,
// latensi bila online. Tidak tampil sama sekali bila daftar mesin kosong (pengguna satu-PC, atau non-admin yang
// mendapat 403 dari /api/machines), jadi header pengguna satu-PC tidak berubah. Klik membuka Pengaturan → Mesin.
import { esc, ago } from './util.js';
import { machines, statusOf, latencyText } from './mesin.js';

/* ---------------- logika murni (dites di test/ui-strip.test.js) ---------------- */
export const MAX_CHIPS = 4; // lebih dari ini: satu chip ringkas berisi titik-titik dan "n/m online"
const DOT = { online: 'on', offline: 'off', unknown: 'unk', disabled: 'dis' };

/** Tooltip chip: nama dan status, lalu kapan terakhir terlihat, lalu galat terakhir (bila tidak online). */
export function chipTitle(m, agoFn = ago) {
  const s = statusOf(m), lat = s.k === 'online' ? latencyText(m.latencyMs) : '';
  const lines = [`${m?.name || m?.id || 'Mesin'}: ${s.label}${lat ? ` · ${lat}` : ''}`];
  if (m?.lastSeen) { const a = agoFn(m.lastSeen); if (a) lines.push(`Terakhir terlihat ${a}`); }
  else if (s.k === 'unknown') lines.push('Belum pernah terhubung');
  if (m?.lastError && m.online !== true) lines.push(`Galat terakhir: ${m.lastError}`);
  lines.push('Klik untuk membuka Pengaturan → Mesin');
  return lines.join('\n');
}

/** [{ id, name, dot, lat, title }] dalam urutan daftar. */
export function stripItems(list = [], agoFn = ago) {
  return (Array.isArray(list) ? list : []).filter(m => m?.id).map(m => {
    const s = statusOf(m);
    return { id: m.id, name: m.name || m.id, dot: DOT[s.k] || 'unk', lat: m.online === true && !m.disabled ? latencyText(m.latencyMs) : '', title: chipTitle(m, agoFn) };
  });
}

/** Ringkasan untuk chip tunggal saat mesin banyak. */
export function stripSummary(list = []) {
  const all = (Array.isArray(list) ? list : []).filter(m => m?.id);
  const on = all.filter(m => statusOf(m).k === 'online').length;
  return { total: all.length, online: on, text: `${on}/${all.length} online` };
}

/** HTML isi strip; '' bila tidak ada mesin. */
export function stripHTML(list = [], { max = MAX_CHIPS, agoFn = ago } = {}) {
  const items = stripItems(list, agoFn);
  if (!items.length) return '';
  const dot = it => `<span class="mxs-dot ${it.dot}" aria-hidden="true"></span>`;
  if (items.length > max) {
    const sum = stripSummary(list);
    const title = `${items.map(it => it.title.split('\n')[0]).join('\n')}\nKlik untuk membuka Pengaturan → Mesin`;
    return `<button type="button" class="mxs-chip mxs-sum" data-mxs="open" title="${esc(title)}" aria-label="${esc(`Mesin: ${sum.text}. Buka Pengaturan Mesin`)}">${items.map(dot).join('')}<span class="mxs-nm">${esc(sum.text)}</span></button>`;
  }
  return items.map(it => `<button type="button" class="mxs-chip ${it.dot}" data-mxs="open" data-id="${esc(it.id)}" title="${esc(it.title)}" aria-label="${esc(it.title.split('\n')[0])}">${dot(it)}<span class="mxs-nm">${esc(it.name)}</span>${it.lat ? `<span class="mxs-lat">${esc(it.lat)}</span>` : ''}</button>`).join('');
}

/* ---------------- DOM ---------------- */
/** Buka Pengaturan, lalu gulir ke bagian Mesin begitu sudah digambar. */
export function openMesinSettings() {
  const target = () => { const s = document.getElementById('stMesin'); return s && !s.hidden && s.isConnected ? s : null; };
  let touched = false;
  const stop = () => { touched = true; };
  for (const ev of ['wheel', 'touchstart', 'keydown']) addEventListener(ev, stop, { once: true, passive: true });
  const scroll = s => {
    s.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // bagian di atasnya (mis. Penyimpanan pratinjau) dimuat belakangan dan menggeser posisi: koreksi sekali, kecuali pengguna sudah menggulir sendiri
    setTimeout(() => { if (!touched && s.isConnected && s.getBoundingClientRect().top > 120) s.scrollIntoView({ block: 'start' }); }, 900);
  };
  const onSettings = /^#\/?pengaturan(\/|$)/.test(location.hash);
  if (onSettings && target()) { scroll(target()); return; }
  if (!onSettings) location.hash = '#/pengaturan';
  const t0 = Date.now();
  const tick = () => { const s = target(); if (s) { scroll(s); return; } if (Date.now() - t0 < 5000) setTimeout(tick, 80); };
  setTimeout(tick, 60);
}

let el = null, timer = null, sig = '', onChange = null;
function paint(force = false) {
  if (!el) return;
  const html = stripHTML(machines());
  if (!force && html === sig) return;
  sig = html;
  el.innerHTML = html;
  el.hidden = !html;
  try { onChange?.(); } catch {} // lebar header berubah: bar tab kantor perlu dihitung ulang
  // tooltip memuat "terakhir terlihat x mnt lalu": segarkan selama strip tampil
  if (html && !timer) timer = setInterval(() => paint(), 30000);
  else if (!html && timer) { clearInterval(timer); timer = null; }
}

/** Pasang strip di elemen header (kosong + hidden saat tidak ada mesin). Update live lewat event 'kantor:machines'.
 *  opts.onChange dipanggil setiap isi strip berubah (main.js: refitTabBar). */
export function mountMachineStrip(target, opts = {}) {
  if (!target || el === target) return;
  el = target;
  onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  el.hidden = true;
  el.addEventListener('click', e => { if (e.target.closest('[data-mxs="open"]')) { e.preventDefault(); openMesinSettings(); } });
  document.addEventListener('kantor:machines', () => paint());
  paint(true);
}
