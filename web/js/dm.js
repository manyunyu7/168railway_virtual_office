// Pesan langsung antaragen: daftar utas per pasangan dan isi percakapan. Dipakai di panel kantor dan tab "Pesan" drawer agen.
import { $, esc, short, api, ago, hhmm, toast, mini, guestLook, post } from './util.js';
import { showDrawer } from './panel.js';

const ST = { menunggu: 'Menunggu', terkirim: 'Terkirim', dibaca: 'Dibaca', dibalas: 'Dibalas' };
const KIND = { pesan: 'Pesan', tanya: 'Tanya', balasan: 'Balasan', fyi: 'FYI' };

const roleOf = (ctx, id) => ctx.office.roles.find(r => r.id === id);
const face = (ctx, id) => mini(roleOf(ctx, id) || guestLook('role:' + id));
const stChip = s => `<span class="dm-st ${esc(s)}">${esc(ST[s] || s)}</span>`;
const base = ctx => `/api/offices/${encodeURIComponent(ctx.office.id)}/dm`;
const inShift = (ctx, id) => ctx.office.sessions.some(s => s.role === id && s.status !== 'ended' && s.tmux);

function listHTML(ctx, threads, role) {
  if (!threads.length) return `<p class="hint dm-empty">${role ? 'Agen ini belum berkirim pesan dengan agen lain.' : 'Belum ada pesan antaragen. Agen saling kirim lewat tool pesan_ke, tanya, dan balas.'}</p>`;
  return `<ul class="dm-list">${threads.map(t => {
    const l = t.last;
    return `<li><button class="dm-th" data-dm="open" data-a="${esc(t.a.id)}" data-b="${esc(t.b.id)}">
      <span class="dm-pair">${face(ctx, t.a.id)}${face(ctx, t.b.id)}</span>
      <span class="dm-body"><b>${esc(t.a.name)} ⇄ ${esc(t.b.name)}</b>
        <span class="dm-last">${esc(l.fromName)}: ${esc(short(l.text, 70))}</span></span>
      <span class="dm-meta"><span>${esc(ago(l.at))}</span>${t.pending ? `<span class="dm-n" title="Menunggu dikirim">${t.pending}</span>` : stChip(l.status)}</span></button></li>`;
  }).join('')}</ul>`;
}

function msgHTML(ctx, m, t) {
  const side = m.from === t.a.id ? 'a' : 'b';
  const link = m.card ? ` <a class="dm-card" href="#/o/${esc(ctx.office.id)}/board/${esc(m.card)}">kartu ${esc(m.card)}</a>` : '';
  return `<div class="dm-msg ${side}${m.kind === 'balasan' ? ' reply' : ''}" data-id="${esc(m.id)}">
    <div class="dm-mh"><b>${esc(m.fromName)}</b><span class="dm-kind">${esc(KIND[m.kind] || m.kind)}${m.group ? ' · siaran' : ''}</span><span class="dm-time" title="${esc(m.at)}">${esc(hhmm(m.at))}</span>${stChip(m.status)}</div>
    <div class="dm-tx">${esc(m.text)}${link}</div></div>`;
}

function threadHTML(ctx, t) {
  const waiting = t.items.filter(m => m.status === 'menunggu');
  const offline = [t.a, t.b].filter(p => waiting.some(m => m.to === p.id) && !inShift(ctx, p.id));
  return `<div class="dm-head"><button class="btn sm" data-dm="back">← Semua</button>
      <span class="dm-pair">${face(ctx, t.a.id)}${face(ctx, t.b.id)}</span><b>${esc(t.a.name)} ⇄ ${esc(t.b.name)}</b></div>
    ${offline.map(p => `<div class="dm-offer">${esc(p.name)} belum shift, jadi pesan masih menunggu. <button class="btn sm primary" data-dm="shift" data-id="${esc(p.id)}">Mulai shift ${esc(p.name)}</button></div>`).join('')}
    <div class="dm-msgs">${t.items.length ? t.items.map(m => msgHTML(ctx, m, t)).join('') : '<p class="hint">Belum ada pesan.</p>'}</div>`;
}

/** Mount the conversations into el. role = only those a role takes part in. Returns { refresh, destroy }. */
export function mountDm(el, ctx, { role = null } = {}) {
  const st = { open: null, gone: false };
  const q = role ? `?role=${encodeURIComponent(role)}` : '';
  async function paint() {
    if (st.gone) return;
    try {
      if (st.open) {
        const t = await api(`${base(ctx)}/${encodeURIComponent(st.open[0])}/${encodeURIComponent(st.open[1])}`);
        if (st.gone) return;
        const box = el.querySelector('.dm-msgs'), atEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        el.innerHTML = `<div class="dm">${threadHTML(ctx, t)}</div>`;
        const m = el.querySelector('.dm-msgs'); if (m && (atEnd || !box)) m.scrollTop = m.scrollHeight;
      } else {
        const { threads } = await api(base(ctx) + q);
        if (!st.gone) el.innerHTML = `<div class="dm">${listHTML(ctx, threads, role)}</div>`;
      }
    } catch (e) { if (!st.gone) el.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  const click = async e => {
    const t = e.target.closest('[data-dm]'); if (!t || !el.contains(t)) return;
    const a = t.dataset.dm;
    if (a === 'open') { st.open = [t.dataset.a, t.dataset.b]; paint(); }
    else if (a === 'back') { st.open = null; paint(); }
    else if (a === 'shift') {
      try { await post(`/api/offices/${encodeURIComponent(ctx.office.id)}/roles/${encodeURIComponent(t.dataset.id)}/start`, {}); toast('Shift dimulai. Pesan masuk begitu dia idle.', 'ok'); }
      catch (err) { toast(err.message, 'bad'); }
    }
  };
  el.addEventListener('click', click);
  paint();
  return { refresh: paint, destroy() { st.gone = true; el.removeEventListener('click', click); } };
}

/* ---------- panel di kantor ---------- */
let panel = null;
export function openDmPanel(ctx) {
  const d = showDrawer(`<div class="dr-main"><div class="dr-head"><div class="dr-id"><div class="dr-name">Obrolan agen</div><div class="dr-title">Pesan langsung antaragen di ${esc(ctx.office.name)}</div></div>
    <button class="icon-btn" data-act="close-drawer" aria-label="Tutup">×</button></div><div class="dr-body" id="dmPanel"></div></div>`,
    { key: 'dm', close: () => { panel?.destroy(); panel = null; } });
  panel?.destroy();
  panel = mountDm($('#dmPanel', d), ctx);
}

/* ---------- kartu ringkas di sisi kantor ---------- */
export async function paintDmCard(ctx) {
  const el = $('#dmCard'); if (!el) return;
  try {
    const { threads } = await api(base(ctx));
    const pend = threads.reduce((n, t) => n + t.pending, 0);
    el.innerHTML = `<p class="eyebrow card-h">Obrolan agen${pend ? ` <span class="dm-n">${pend}</span>` : ''}</p>` + (threads.length
      ? `<ul class="dm-mini">${threads.slice(0, 3).map(t => `<li><button class="dm-th" data-dm-card="open" data-a="${esc(t.a.id)}" data-b="${esc(t.b.id)}"><b>${esc(t.a.name)} ⇄ ${esc(t.b.name)}</b><span class="dm-last">${esc(short(t.last.text, 60))}</span></button></li>`).join('')}</ul>
        <button class="btn sm" data-dm-card="all">Semua obrolan (${threads.length})</button>`
      : '<p class="hint">Belum ada. Agen saling kirim pesan lewat tool pesan_ke dan tanya.</p>');
  } catch {}
}
export function bindDmCard(ctx) {
  const el = $('#dmCard'); if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', e => {
    const t = e.target.closest('[data-dm-card]'); if (!t) return;
    openDmPanel(ctx);
    if (t.dataset.dmCard === 'open') setTimeout(() => $('#dmPanel')?.querySelector(`[data-dm="open"][data-a="${CSS.escape(t.dataset.a)}"][data-b="${CSS.escape(t.dataset.b)}"]`)?.click(), 80);
  });
}

/** Realtime: refresh whatever is showing, and flash the balloons over the two agents. */
export function dmLive(msg, ctx, extra = {}) {
  if (msg.t !== 'dm' || !ctx.office || msg.office !== ctx.office.id) return;
  panel?.refresh();
  extra.tab?.refresh();
  paintDmCard(ctx);
  const m = msg.item;
  if (m && m.status === 'menunggu') { // a message was just created
    ctx.stage?.dmBalloon?.(m.from, `✉ ${short(m.toName, 14)}`, 2600);
    setTimeout(() => ctx.stage?.dmBalloon?.(m.to, `✉ ${short(m.fromName, 14)}`, 3200), 1400);
  }
}
