// Tab Kalender: kartu menurut tanggal tayang (publishAt), kalau tidak ada menurut tenggat (due). Bulan / minggu / agenda,
// filter papan, warna per papan atau per jenis kolom. Seret kartu ke hari lain untuk menjadwalkan ulang (PATCH, optimistis).
import { $, $$, esc, short, api, patch, toast } from './util.js';

const KIND_LABEL = { antre: 'Antre', siap: 'Siap', dikerjakan: 'Dikerjakan', review: 'Review', selesai: 'Selesai' };
const COLK = { antre: 'var(--b6)', siap: 'var(--b2)', dikerjakan: 'var(--accent)', review: 'var(--b4)', selesai: 'var(--ok)' };
const MONL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DOW = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const LS = id => 'kc.cal.' + id;

const S = { ctx: null, el: null, oid: null, cards: [], boards: [], view: 'month', color: 'board', board: 'all', cursor: null, undated: false, timer: null, h: null, drag: null };

/* ---------------- tanggal (string YYYY-MM-DD, waktu lokal) ---------------- */
const pad = n => String(n).padStart(2, '0');
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pdl = s => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; };
const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = d => addD(d, -((d.getDay() + 6) % 7));
const todayS = () => ds(new Date());
const fmtLong = s => { const d = pdl(s); return d ? d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''; };

/* ---------------- model ---------------- */
const base = () => `/api/offices/${S.oid}`;
const boardOf = id => S.boards.find(b => b.id === (id || 'utama'));
const kindOf = c => c.colKind || 'antre';
/** Tanggal kartu di kalender: tayang dulu, kalau kosong tenggat. */
const whenOf = c => (c.publishAt ? { d: c.publishAt, f: 'publishAt' } : c.due ? { d: c.due, f: 'due' } : null);
const visible = () => S.cards.filter(c => !c.epic && (S.board === 'all' || (c.board || 'utama') === S.board));
const colorOf = c => (S.color === 'board' ? boardOf(c.board)?.color || 'var(--b6)' : COLK[kindOf(c)]);
const byDay = () => { const m = new Map(); for (const c of visible()) { const w = whenOf(c); if (w) (m.get(w.d) || m.set(w.d, []).get(w.d)).push(c); } return m; };
/** Field yang diubah saat kartu tanpa tanggal diseret ke kalender: papan template Dev memakai tenggat, papan lain tanggal tayang. */
const fieldFor = c => whenOf(c)?.f || (boardOf(c.board)?.template === 'dev' ? 'due' : 'publishAt');

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS(S.oid)) || '{}');
    if (['month', 'week', 'agenda'].includes(p.view)) S.view = p.view;
    if (p.color === 'board' || p.color === 'kind') S.color = p.color;
    S.undated = !!p.undated;
    S.board = typeof p.board === 'string' ? p.board : 'all';
  } catch {}
}
function savePrefs() { try { localStorage.setItem(LS(S.oid), JSON.stringify({ view: S.view, color: S.color, board: S.board, undated: S.undated })); } catch {} }
async function fetchAll() {
  const b = await api(`${base()}/board?board=all`);
  S.cards = b.cards || []; S.boards = b.boards || [];
  if (S.board !== 'all' && !S.boards.some(x => x.id === S.board && !x.archived)) S.board = 'all';
}

/* ---------------- render ---------------- */
function chip(c) {
  const w = whenOf(c), late = !c.done && w && w.d < todayS(), b = boardOf(c.board);
  const label = `${c.title}. ${w?.f === 'publishAt' ? 'Tayang' : 'Tenggat'} ${fmtLong(w?.d)}. Papan ${b?.name || c.board}, ${c.colName}${late ? ', terlambat' : ''}. Alt+panah untuk menggeser.`;
  return `<button type="button" class="cal-chip${c.done ? ' done' : ''}${late ? ' late' : ''}" draggable="true" data-id="${esc(c.id)}" style="--cc:${colorOf(c)}" aria-label="${esc(label)}" title="${esc(c.title)} · ${esc(b?.name || '')} · ${esc(c.colName || '')}">`
    + `<i aria-hidden="true">${w?.f === 'publishAt' ? '◆' : '⏱'}</i>${c.coverUrl ? `<img src="${esc(c.coverUrl)}" alt="" loading="lazy" draggable="false" onerror="this.remove()">` : ''}<span>${esc(short(c.title, 60))}</span></button>`;
}
function rangeOf() {
  const c = S.cursor;
  if (S.view === 'week') { const a = monday(c); return { from: a, days: 7 }; }
  const first = new Date(c.getFullYear(), c.getMonth(), 1), a = monday(first);
  const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
  const days = Math.ceil(((last - a) / 864e5 + 1) / 7) * 7;
  return { from: a, days };
}
function titleOf() {
  const c = S.cursor;
  if (S.view === 'week') { const a = monday(c), z = addD(a, 6); return `${a.getDate()} ${MONL[a.getMonth()].slice(0, 3)} – ${z.getDate()} ${MONL[z.getMonth()].slice(0, 3)} ${z.getFullYear()}`; }
  return `${MONL[c.getMonth()]} ${c.getFullYear()}`;
}
function gridHTML() {
  const { from, days } = rangeOf(), m = byDay(), t = todayS(), month = S.cursor.getMonth();
  const max = S.view === 'week' ? 50 : 4;
  let cells = '';
  for (let i = 0; i < days; i++) {
    const d = addD(from, i), k = ds(d), list = (m.get(k) || []).sort((a, b) => a.done - b.done || a.title.localeCompare(b.title));
    const out = S.view === 'month' && d.getMonth() !== month;
    cells += `<div class="cal-day${out ? ' out' : ''}${k === t ? ' today' : ''}${d.getDay() === 0 || d.getDay() === 6 ? ' we' : ''}" data-day="${k}" role="gridcell" aria-label="${esc(fmtLong(k))}, ${list.length} kartu">
      <div class="cal-dn"><span>${d.getDate()}</span>${k === t ? '<b>hari ini</b>' : ''}</div>
      <div class="cal-items">${list.slice(0, max).map(chip).join('')}${list.length > max ? `<button type="button" class="cal-more" data-act="cal-more" data-day="${k}">+${list.length - max} lagi</button>` : ''}</div></div>`;
  }
  return `<div class="cal-grid ${S.view}" role="grid" aria-label="${esc(titleOf())}"><div class="cal-dow" role="row">${DOW.map(x => `<span role="columnheader">${x}</span>`).join('')}</div><div class="cal-cells">${cells}</div></div>`;
}
function agendaHTML() {
  const { from, days } = rangeOf(), m = byDay(), t = todayS();
  const rows = [];
  for (let i = 0; i < days; i++) {
    const k = ds(addD(from, i)), list = m.get(k);
    if (S.view === 'agenda' && addD(from, i).getMonth() !== S.cursor.getMonth()) continue;
    if (list?.length) rows.push(`<li class="${k === t ? 'today' : ''}" data-day="${k}"><h3>${esc(fmtLong(k))}${k === t ? ' · hari ini' : ''}</h3><div class="cal-items">${list.map(chip).join('')}</div></li>`);
  }
  return `<ul class="cal-agenda">${rows.join('') || '<li class="hint">Tidak ada kartu bertanggal di bulan ini.</li>'}</ul>`;
}
function undatedHTML() {
  const un = visible().filter(c => !whenOf(c) && !c.done);
  return `<aside class="cal-un" aria-label="Tanpa tanggal"><h3>Tanpa tanggal <span class="hint">${un.length}</span></h3><p class="hint">Seret ke hari untuk menjadwalkan.</p><div class="cal-items">${un.slice(0, 80).map(chip).join('') || '<span class="hint">Semua kartu sudah bertanggal.</span>'}</div></aside>`;
}
function paint() {
  if (!S.el) return;
  const bl = S.boards.filter(b => !b.archived);
  const seg = (arr, cur, act) => `<div class="seg" role="group">${arr.map(([k, v]) => `<button type="button" data-act="${act}" data-v="${k}" aria-pressed="${cur === k}">${v}</button>`).join('')}</div>`;
  const legend = S.color === 'board' ? bl.map(b => `<span class="gt-lg"><i style="background:${esc(b.color)}"></i>${esc(b.name)}</span>`).join('')
    : Object.keys(COLK).map(k => `<span class="gt-lg"><i style="background:${COLK[k]}"></i>${KIND_LABEL[k]}</span>`).join('');
  S.el.innerHTML = `<div class="cal-toolbar">
      <div class="cal-nav"><button type="button" class="btn sm" data-act="cal-prev" aria-label="Sebelumnya">‹</button><button type="button" class="btn sm" data-act="cal-today">Hari ini</button><button type="button" class="btn sm" data-act="cal-next" aria-label="Berikutnya">›</button><h2 aria-live="polite">${esc(titleOf())}</h2></div>
      <label class="sr-only" for="calBoard">Papan</label><select id="calBoard"><option value="all" ${S.board === 'all' ? 'selected' : ''}>Semua papan</option>${bl.map(b => `<option value="${esc(b.id)}" ${S.board === b.id ? 'selected' : ''}>${esc(b.icon || '')} ${esc(b.name)}</option>`).join('')}</select>
      ${seg([['month', 'Bulan'], ['week', 'Minggu'], ['agenda', 'Agenda']], S.view, 'cal-view')}
      <span class="seg-l">Warna</span>${seg([['board', 'Papan'], ['kind', 'Kolom']], S.color, 'cal-color')}
      <button type="button" class="btn sm ghost" data-act="cal-undated" aria-pressed="${S.undated}">Tanpa tanggal</button>
    </div>
    <div class="cal-body${S.undated ? ' with-un' : ''}"><div class="cal-main">${S.view === 'agenda' ? agendaHTML() : gridHTML()}</div>${S.undated ? undatedHTML() : ''}</div>
    <div class="gt-legend">${legend}<span class="gt-lg">◆ tanggal tayang</span><span class="gt-lg">⏱ tenggat (tanpa tanggal tayang)</span></div>`;
}

/* ---------------- ubah jadwal ---------------- */
async function moveTo(id, day) {
  const c = S.cards.find(x => x.id === id); if (!c) return;
  const f = fieldFor(c), old = c[f];
  if (old === day) return;
  c[f] = day; paint();
  try { await patch(`${base()}/cards/${id}`, { [f]: day }); toast(`"${short(c.title, 40)}" ${f === 'publishAt' ? 'tayang' : 'tenggat'} ${fmtLong(day)}`); }
  catch (e) { c[f] = old; paint(); toast(e.message, 'bad'); }
  $(`.cal-chip[data-id="${CSS.escape(id)}"]`, S.el)?.focus();
}
const openCard = id => { location.hash = `#/o/${S.oid}/board/${id}`; };

function bind() {
  const el = S.el;
  const h = {
    click: e => {
      const b = e.target.closest('[data-act]');
      if (b) {
        const a = b.dataset.act, c = S.cursor;
        if (a === 'cal-prev' || a === 'cal-next') { const d = a === 'cal-prev' ? -1 : 1; S.cursor = S.view === 'week' ? addD(c, 7 * d) : new Date(c.getFullYear(), c.getMonth() + d, 1); }
        else if (a === 'cal-today') S.cursor = new Date();
        else if (a === 'cal-view') { S.view = b.dataset.v; savePrefs(); }
        else if (a === 'cal-color') { S.color = b.dataset.v; savePrefs(); }
        else if (a === 'cal-undated') { S.undated = !S.undated; savePrefs(); }
        else if (a === 'cal-more') { S.view = 'week'; S.cursor = pdl(b.dataset.day); savePrefs(); }
        paint(); return;
      }
      const ch = e.target.closest('.cal-chip'); if (ch) openCard(ch.dataset.id);
    },
    change: e => { if (e.target.id === 'calBoard') { S.board = e.target.value; savePrefs(); paint(); } },
    key: e => {
      const ch = e.target.closest?.('.cal-chip'); if (!ch || !e.altKey) return;
      const c = S.cards.find(x => x.id === ch.dataset.id), w = c && whenOf(c);
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]; if (!step || !c) return;
      e.preventDefault();
      moveTo(c.id, ds(addD(pdl(w?.d || todayS()), w ? step : 0)));
    },
    dragstart: e => { const ch = e.target.closest?.('.cal-chip'); if (!ch) return; S.drag = ch.dataset.id; ch.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ch.dataset.id); } catch {} },
    dragend: () => { S.drag = null; $$('.dragging,.cal-over', el).forEach(x => x.classList.remove('dragging', 'cal-over')); },
    dragover: e => { const d = e.target.closest?.('[data-day]'); if (!d || !S.drag) return; e.preventDefault(); if (!d.classList.contains('cal-over')) { $$('.cal-over', el).forEach(x => x.classList.remove('cal-over')); d.classList.add('cal-over'); } },
    drop: e => { const d = e.target.closest?.('[data-day]'); if (!d || !S.drag) return; e.preventDefault(); const id = S.drag; h.dragend(); moveTo(id, d.dataset.day); },
  };
  for (const [n, f] of Object.entries(h)) el.addEventListener(n === 'key' ? 'keydown' : n, f);
  S.h = h;
}
function unbind() { if (S.h && S.el) for (const [n, f] of Object.entries(S.h)) S.el.removeEventListener(n === 'key' ? 'keydown' : n, f); S.h = null; }

/* ---------------- modul ---------------- */
export async function render(el, ctx) {
  unbind();
  Object.assign(S, { ctx, el, oid: ctx.office.id, cards: [], boards: [], cursor: new Date(), view: 'month', color: 'board', board: 'all', undated: false });
  loadPrefs();
  el.innerHTML = '<p class="empty-line">Memuat kalender…</p>';
  try { await fetchAll(); } catch (e) { el.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  el.classList.add('cal-root');
  paint(); bind();
}
export function live(msg, ctx) {
  if (!S.el || !S.oid) return;
  if (ctx) S.ctx = ctx;
  if ((msg.t === 'changed' && msg.what === 'board' && (msg.office === S.oid || msg.office === '*')) || msg.t === 'reconnected') {
    clearTimeout(S.timer);
    S.timer = setTimeout(async () => { if (!S.el || S.drag) return; try { await fetchAll(); paint(); } catch {} }, 300);
  }
}
export function unmount() { unbind(); clearTimeout(S.timer); S.el?.classList.remove('cal-root'); S.el = null; S.oid = null; }
