import { $, $$, esc, short, usd, api, post, del, toast, modal, closeModal, confirmDo, sprite, mini, onLive, connectLive, hhmm, ago, guestLook, modelName } from './util.js';
import { createStage } from './office-canvas.js';
import { isCodex } from './codex.js';
import { openSession, openRole, drawerOnLive, HOSTS, MODE_LABEL } from './drawer.js';
import { closeDrawer, drawerState } from './panel.js';
import * as board from './board.js';
import * as roles from './roles.js';
import * as archive from './archive.js';
import * as meetings from './meetings.js';
import * as notes from './notes.js';
import * as wiki from './wiki.js';
import * as pratinjau from './pratinjau.js';
import './docs.js';
import * as payroll from './payroll.js';
import * as metrics from './metrics.js';
import * as settings from './settings.js';
import * as wizard from './wizard.js';
import * as files from './files.js';
import * as gantt from './gantt.js';
import * as calendar from './calendar.js';
import * as chatmode from './chatmode.js';
import { initViewer, viewerLive } from './viewer.js';
import { initDock, dockLive, openDock } from './dock.js';
import { initAgents, agentsLive, paintAgentsBadge } from './agents.js';
import { music, mountPlayer, mountLibrary } from './music.js';
import { openLayoutEditor } from './layout-editor.js';
import { bindDmCard, paintDmCard, dmLive } from './dm.js';
import { minionCardHTML, paintMinionCard, showMinionMenu, closeMinionMenu } from './minions-ui.js';
import { kunciCardHTML, paintKunciCard, kunciLive } from './kunci-ui.js';
import { mountTabBar, refitTabBar } from './tab-bar.js';

export const ctx = { st: null, office: null, stage: null, view: null, route: null };
const view = $('#view');
const TABS = { kantor: 'Kantor', chat: 'Chat', board: 'Board', timeline: 'Timeline', kalender: 'Kalender', file: 'File', rapat: 'Rapat', notes: 'Notes', wiki: 'Wiki', pratinjau: 'Pratinjau', payroll: 'Payroll', metrik: 'Metrik', role: 'Role', arsip: 'Arsip' };
const MODULES = { chat: chatmode, board, timeline: gantt, kalender: calendar, file: files, role: roles, arsip: archive, rapat: meetings, notes, wiki, pratinjau, payroll, metrik: metrics };

/* ---------------- routing ---------------- */
function parse() {
  const h = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (h[0] === 'o' && h[1]) return { name: 'office', id: h[1], tab: TABS[h[2]] ? h[2] : 'kantor', rest: h.slice(3) };
  if (h[0] === 'kompleks' && (h[1] === 'notes' || h[1] === 'wiki')) return { name: 'office', id: '_kompleks', tab: h[1], rest: h.slice(2) };
  if (h[0] === 'baru') return { name: 'wizard' };
  if (h[0] === 'pengaturan') return { name: 'settings' };
  if (h[0] === 'payroll') return { name: 'payroll' };
  if (h[0] === 'metrik') return { name: 'metrik' };
  return { name: 'map' };
}
export const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };
async function route() {
  const r = parse();
  const prev = ctx.route;
  ctx.route = r;
  if (!(prev && prev.name === 'office' && r.name === 'office' && prev.id === r.id && prev.tab === r.tab)) {
    ctx.view?.unmount?.(); ctx.view = null;
    if (ctx.stage) { ctx.stage.destroy(); ctx.stage = null; }
    closeDrawer();
    closeModal();
  }
  document.body.classList.toggle('kantor-full', r.name === 'office' && r.tab === 'kantor' && r.id !== '_kompleks');
  document.body.classList.toggle('chat-full', r.name === 'office' && r.tab === 'chat' && r.id !== '_kompleks');
  document.body.classList.toggle('in-office', r.name === 'office');
  try {
    if (r.name === 'map') await renderMap();
    else if (r.name === 'wizard') { crumbs([['Kantor baru']]); ctx.view = wizard; await wizard.render(view, ctx); }
    else if (r.name === 'settings') { crumbs([['Pengaturan']]); ctx.view = settings; await settings.render(view, ctx); }
    else if (r.name === 'metrik') { crumbs([['Metrik kompleks']]); ctx.view = metrics; await metrics.render(view, { ...ctx, office: null, global: true }); }
    else if (r.name === 'payroll') { crumbs([['Payroll kompleks']]); ctx.view = payroll; await payroll.render(view, { ...ctx, office: null, global: true }); }
    else await renderOffice(r, prev);
  } catch (e) { view.innerHTML = `<div class="wrap"><div class="notice">${esc(e.message)}</div></div>`; }
}
window.addEventListener('hashchange', route);

/* ---------------- music: top-bar player, library dialog ---------------- */
let musicUnmount = null;
function toggleMusic() {
  const open = $('#musicPop');
  if (open) { musicUnmount?.(); musicUnmount = null; open.remove(); $('#musicBtn').setAttribute('aria-expanded', 'false'); return; }
  $('.top').insertAdjacentHTML('beforeend', '<div class="music-pop" id="musicPop" role="dialog" aria-label="Musik kantor"><div id="musicPlayer"></div><button class="btn sm" data-act="music-lib">Pustaka &amp; playlist</button></div>');
  const b = $('#musicBtn').getBoundingClientRect();
  $('#musicPop').style.right = Math.max(8, innerWidth - b.right) + 'px';
  musicUnmount = mountPlayer($('#musicPlayer'));
  $('#musicBtn').setAttribute('aria-expanded', 'true');
}
function openMusicLibrary() {
  if ($('#musicPop')) toggleMusic();
  modal({ title: 'Ruang Musik', html: '<div class="music-lib-host" id="musicLib"></div>', actions: [{ label: 'Tutup' }] });
  const un = mountLibrary($('#musicLib'));
  const obs = new MutationObserver(() => { if ($('#modal').hidden) { un?.(); obs.disconnect(); } });
  obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
}
music.on(st => { const b = $('#musicBtn'); if (b) { b.classList.toggle('on', !!st.playing); b.title = st.playing ? `Musik: ${st.title || ''}` : 'Musik kantor'; } });
document.addEventListener('click', e => {
  if (e.target.closest('#musicBtn')) { toggleMusic(); return; }
  if (!e.target.closest('#musicPop') && $('#musicPop') && !e.target.closest('[data-act="music-lib"]')) toggleMusic();
}, true);

// rearrange roles by dragging their cards in the strip (Alt+←/→ on a focused card does the same)
function saveRoleOrder(ids) {
  const o = ctx.office, pos = new Map(ids.map((id, i) => [id, i]));
  o.roles.sort((a, b) => (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999));
  kantorView.strip();
  post(`/api/offices/${encodeURIComponent(o.id)}/roles-order`, { order: o.roles.map(r => r.id) }).catch(e => toast(e.message, 'bad'));
}
function bindStripDrag(el) {
  if (el.dataset.drag) return;
  el.dataset.drag = 1;
  let from = null;
  const ids = () => [...new Set([...el.querySelectorAll('.kf-card[data-role]')].map(c => c.dataset.role))];
  el.addEventListener('dragstart', e => { const c = e.target.closest('.kf-card[data-role]'); if (!c) return; from = c.dataset.role; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', from); });
  el.addEventListener('dragend', () => { from = null; el.querySelectorAll('.dragging,.drop-l,.drop-r').forEach(c => c.classList.remove('dragging', 'drop-l', 'drop-r')); });
  el.addEventListener('dragover', e => {
    const c = e.target.closest('.kf-card[data-role]'); if (!from || !c) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    el.querySelectorAll('.drop-l,.drop-r').forEach(x => x.classList.remove('drop-l', 'drop-r'));
    if (c.dataset.role !== from) c.classList.add(after ? 'drop-r' : 'drop-l');
    // auto-scroll near the edges
    const b = el.getBoundingClientRect(); if (e.clientX < b.left + 40) el.scrollLeft -= 12; else if (e.clientX > b.right - 40) el.scrollLeft += 12;
  });
  el.addEventListener('drop', e => {
    const c = e.target.closest('.kf-card[data-role]'); if (!from || !c || c.dataset.role === from) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    const list = ids().filter(x => x !== from), at = list.indexOf(c.dataset.role) + (after ? 1 : 0);
    list.splice(at, 0, from);
    saveRoleOrder(list);
  });
  el.addEventListener('keydown', e => {
    if (!e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const c = e.target.closest('.kf-card[data-role]'); if (!c) return;
    e.preventDefault();
    const list = ids(), i = list.indexOf(c.dataset.role), j = i + (e.key === 'ArrowLeft' ? -1 : 1);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const id = c.dataset.role;
    saveRoleOrder(list);
    requestAnimationFrame(() => el.querySelector(`.kf-card[data-role="${CSS.escape(id)}"] .kf-hit`)?.focus());
  });
}
// show the strip's arrows and how many cards are hidden past the right edge
function stripEdges(el) {
  const wrap = el.parentElement; if (!wrap) return;
  const max = el.scrollWidth - el.clientWidth;
  const l = el.scrollLeft > 16, r = el.scrollLeft < max - 16;
  wrap.classList.toggle('can-l', l); wrap.classList.toggle('can-r', r);
  wrap.querySelector('.kf-arrow.l').hidden = !l; wrap.querySelector('.kf-arrow.r').hidden = !r;
  const edge = el.getBoundingClientRect().right;
  const hidden = [...el.children].filter(c => c.getBoundingClientRect().left > edge - 24).length;
  wrap.querySelector('.kf-arrow.r .n').textContent = hidden ? `+${hidden}` : '';
}
function toggleSwitcher() {
  let m = $('#offSwitch');
  if (m) { m.remove(); return; }
  const list = [...(ctx.st?.offices || [])].sort((a, b) => (b.fav - a.fav) || (b.sessions.length - a.sessions.length) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  $('.top').insertAdjacentHTML('beforeend', `<div class="off-switch" id="offSwitch" role="menu">${list.map(o => `<a href="#/o/${esc(o.id)}" role="menuitem" class="${ctx.office?.id === o.id ? 'cur' : ''}"><span class="fav-ic">${o.fav ? '★' : ''}</span><b>${esc(o.name)}</b><span class="hint">${o.sessions.length ? o.sessions.length + ' sesi' : ''}</span></a>`).join('')}<a href="#/" class="all">Semua kantor →</a></div>`);
  const b = $('[data-act="office-switch"]'); if (b) { const r = b.getBoundingClientRect(); $('#offSwitch').style.left = Math.max(8, r.left) + 'px'; }
}
function renderSwitcher() { if ($('#offSwitch')) { $('#offSwitch').remove(); toggleSwitcher(); } }
document.addEventListener('click', e => { if (!e.target.closest('#offSwitch') && !e.target.closest('[data-act="office-switch"]')) $('#offSwitch')?.remove(); }, true);
window.addEventListener('hashchange', () => $('#offSwitch')?.remove());
function crumbs(parts) {
  $('#crumbs').innerHTML = `<a href="#/">Kompleks</a>${parts.map(([t, h]) => `<span aria-hidden="true">/</span>${h ? `<a href="${h}">${esc(t)}</a>` : `<b>${esc(t)}</b>`}`).join('')}`;
}
function topCounts() {
  const n = ctx.st?.inbox?.length || 0;
  $('#inboxCount').textContent = n;
  $('#inboxPill').classList.toggle('hot', n > 0);
  paintAgentsBadge();
}

/* ---------------- state ---------------- */
export async function refreshState() { ctx.st = await api('/api/state'); topCounts(); return ctx.st; }

/* ---------------- map ---------------- */
const MICHAEL = { color: '#55606E', hair: '#2B1D14', skin: '#F1C9A5', tie: true };
function inboxHTML(items, showOffice) {
  if (!items.length) return '<p class="empty-line">Tidak ada yang menunggu izin.</p>';
  return `<ul class="inbox">${items.map(it => {
    const o = ctx.st.offices.find(x => x.id === it.office);
    return `<li class="ib"><div class="ib-who"><b>${esc(it.who || 'Sesi')}</b>${showOffice && o ? ` <span class="sub">·</span> <a href="#/o/${o.id}">${esc(o.name)}</a>` : ''}<span class="sub"> · ${esc(it.tool)} · ${ago(it.created_at)}</span></div>
      <code class="ib-cmd">${esc(it.summary)}</code>
      ${it.held ? `<div class="btn-row"><button class="btn sm primary" data-act="allow" data-id="${it.id}">Izinkan</button><button class="btn sm" data-act="deny" data-id="${it.id}">Tolak</button></div>`
        : '<p class="hint">Sudah pindah ke terminal sesinya. Jawab dari sana.</p>'}</li>`;
  }).join('')}</ul>`;
}
async function renderMap() {
  $('#crumbs').innerHTML = '<b>Kompleks</b>';
  const st = await refreshState();
  const all = st.offices;
  const sess = all.flatMap(o => o.sessions.filter(x => x.status !== 'ended').map(x => ({ ...x, office: o })));
  const working = sess.filter(x => x.status === 'working').length;
  const cost = all.reduce((a, o) => a + (o.monthCost || 0), 0);
  const favs = all.filter(o => o.fav);
  const active = all.filter(o => !o.fav && o.sessions.length).sort((a, b) => b.sessions.length - a.sessions.length);
  const rest = [...all].sort((a, b) => (b.fav - a.fav) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  const ended = await api('/api/sessions/recent-ended').catch(() => []);
  ctx.ended = ended;
  const section = (title, sub, body) => `<section class="hm-sec"><div class="hm-sec-h"><h2>${title}</h2>${sub ? `<span class="hint">${sub}</span>` : ''}</div>${body}</section>`;
  view.innerHTML = `<div class="wrap home">
    <header class="hm-head">
      <div><p class="eyebrow">Kantor Claude · ${all.length} kantor</p><h1>Kompleks</h1>
        <p class="hm-stats"><b>${sess.length}</b> sesi aktif <span>·</span> <b>${working}</b> sedang bekerja <span>·</span> <b class="${st.inbox.length ? 'warn' : ''}">${st.inbox.length}</b> izin menunggu <span>·</span> <b>${usd(cost, 0)}</b> bulan ini <span class="hint">(estimasi setara API)</span></p></div>
      <div class="btn-row"><a class="btn" href="#/metrik">Metrik</a><a class="btn" href="#/payroll">Payroll</a><button class="btn primary" data-act="add-office">Tambah kantor</button></div>
    </header>
    <div class="hm-grid">
      <div class="hm-main">
        ${section('Favorit', favs.length ? '' : 'Klik ☆ di kantor mana pun untuk menyematkannya di sini.', favs.length ? `<div class="hm-cards">${favs.map(cardHTML).join('')}</div>` : '')}
        ${active.length ? section('Sedang aktif', '', `<div class="hm-cards">${active.map(cardHTML).join('')}</div>`) : ''}
        ${section('Semua kantor', '', `<input type="search" id="hmFilter" placeholder="Cari kantor…" aria-label="Cari kantor" autocomplete="off">
          <div class="tbl-wrap"><table class="tbl hm-tbl"><thead><tr><th></th><th>Kantor</th><th class="num">Sesi</th><th class="num">Kartu</th><th class="num">Biaya bln ini</th><th>Terakhir aktif</th></tr></thead>
          <tbody>${rest.map(rowHTML).join('')}</tbody></table></div>`)}
      </div>
      <aside class="hm-side">
        <div class="card"><div class="rm-head"><div class="rm-ava">${sprite(MICHAEL, 3)}</div><div><p class="eyebrow">Regional Manager</p><h3>Michael</h3></div></div>
          <p class="eyebrow card-h" style="margin-top:12px">Kotak masuk gabungan · ${st.inbox.length}</p><div id="inboxAll">${inboxHTML(st.inbox, true)}</div></div>
        <div class="card"><p class="eyebrow card-h">Agen aktif · ${sess.length}</p>${sess.length ? `<ul class="hm-agents">${sess.sort((a, b) => rank(a) - rank(b)).map(agentRow).join('')}</ul>` : '<p class="empty-line">Belum ada sesi berjalan.</p>'}</div>
        ${st.loose?.length ? `<div class="card"><p class="eyebrow card-h">Di luar kantor · ${st.loose.length}</p><p class="hint" style="margin-bottom:8px">Sesi yang dijalankan langsung di folder induk, bukan di folder project.</p><ul class="hm-agents">${st.loose.map(looseRow).join('')}</ul></div>` : ''}
        ${ended.length ? `<div class="card"><p class="eyebrow card-h">Baru ditutup · ${ended.length}</p><p class="hint" style="margin-bottom:8px">Terminalnya sudah ditutup, tapi percakapannya masih tersimpan. Lanjutkan di kantor dengan ingatan yang sama.</p><ul class="hm-agents">${ended.map(endedRow).join('')}</ul></div>` : ''}
        <div class="card"><p class="eyebrow card-h">Bersama</p><div class="btn-row"><a class="btn sm" href="#/kompleks/notes">Notes kompleks</a><a class="btn sm" href="#/kompleks/wiki">Wiki kompleks</a></div></div>
      </aside>
    </div></div>`;
}
const rank = x => x.waiting ? 0 : x.status === 'working' ? 1 : 2;
const stDot = x => `<i class="hm-dot ${x.waiting ? 'wait' : x.status === 'working' ? 'work' : ''}" title="${x.waiting ? 'menunggu izin' : x.status === 'working' ? 'bekerja' : 'idle'}"></i>`;
const sessLabel = x => x.waiting ? `menunggu izin: ${x.waiting.tool}` : x.tool ? `${x.tool.name} ${x.tool.label || ''}`
  : x.placeholder || x.title === 'Sesi belum terhubung' ? `belum terhubung${x.host && x.host !== 'lain' ? ' · ' + HOSTS[x.host] : x.tty ? ' · ' + x.tty.replace('/dev/', '') : ''}`
  : x.status === 'working' ? 'bekerja' : 'idle';
function agentRow(x) {
  const name = x.look?.name || (x.title && x.title !== 'Sesi belum terhubung' ? short(x.title, 30) : 'Sesi manual');
  const what = x.look?.name && x.title && !x.title.startsWith(x.look.name) && !x.tool && !x.waiting ? short(x.title, 40) : sessLabel(x);
  return `<li><button class="hm-agent" data-act="go-sess" data-office="${esc(x.office.id)}" data-sid="${esc(x.sid)}" title="${esc(sessLabel(x))}">${mini(x.look || guestLook(x.sid))}<span class="hm-ab"><b>${esc(name)}</b><span>${esc(x.office.name)} · ${esc(short(what, 44))}</span></span>${stDot(x)}</button></li>`;
}
function endedRow(x) {
  const t = x.title && x.title !== 'Sesi belum terhubung' ? x.title : x.first_prompt || 'Sesi tanpa judul';
  return `<li><div class="hm-agent static">${mini(guestLook(x.sid))}<span class="hm-ab"><b>${esc(short(t, 34))}</b><span>${esc(x.office_name)} · ditutup ${ago(x.ended_at)}</span></span><button class="btn sm" data-act="resume-ended" data-sid="${esc(x.sid)}">Lanjutkan</button></div></li>`;
}
function resumeEnded(sid) {
  const x = (ctx.ended || []).find(e => e.sid === sid); if (!x) return;
  modal({ title: 'Lanjutkan sesi ini di kantor?', body: `Sesi dilanjutkan di terminal kantor ${x.office_name} pada folder yang sama (${(x.cwd || '').replace(/^\/Users\/[^/]+/, '~')}), dengan seluruh percakapannya.`,
    html: `<div class="field"><label for="rePerm">Mode izin</label><select id="rePerm">${roles.PERMS.map(([v, l]) => `<option value="${v}"${v === 'bypassPermissions' ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`,
    actions: [{ label: 'Lanjutkan', kind: 'primary', fn: () => {
      const permissionMode = $('#rePerm').value || null;
      post(`/api/sessions/${encodeURIComponent(sid)}/adopt`, { role: x.role || null, permissionMode })
        .then(() => { toast('Sesi dilanjutkan di kantor', 'ok'); ctx.pendingSid = sid; go(`#/o/${x.office}`); })
        .catch(e => toast(e.message, 'bad'));
    } }, { label: 'Batal' }] });
}
function looseRow(x) {
  return `<li><div class="hm-agent static">${mini(guestLook(x.sid))}<span class="hm-ab"><b>${esc(short(x.title || 'Sesi', 26))}</b><span>${esc((x.cwd || '').replace(/^\/Users\/[^/]+/, '~'))}${x.tty ? ' · ' + esc(x.tty.replace('/dev/', '')) : ''}</span></span>${stDot(x)}</div></li>`;
}
const favBtn = o => `<button class="fav${o.fav ? ' on' : ''}" data-act="fav" data-id="${esc(o.id)}" data-v="${o.fav ? 0 : 1}" aria-pressed="${o.fav}" title="${o.fav ? 'Hapus dari favorit' : 'Jadikan favorit'}">${o.fav ? '★' : '☆'}</button>`;
function bldHTML(o, big) {
  const lit = Math.min(8, o.sessions.length * 2), bc = `var(--b${(o.id.length % 6) + 1})`;
  return `<span class="hm-bld${big ? ' big' : ''}" style="--bc:${bc}" aria-hidden="true"><i class="roof"></i><span class="w">${Array.from({ length: 8 }, (_, i) => `<i class="${i < lit ? 'on' : ''}"></i>`).join('')}</span></span>`;
}
function cardHTML(o) {
  const ss = o.sessions.filter(x => x.status !== 'ended');
  const pend = ctx.st.inbox.filter(i => i.office === o.id).length;
  const status = pend ? `<span class="st wait">${pend} izin</span>` : ss.some(x => x.status === 'working') ? '<span class="st working">bekerja</span>' : ss.length ? '<span class="st idle">ada sesi</span>' : '<span class="st off">sepi</span>';
  return `<div class="hm-card"><a class="hm-card-link" href="#/o/${esc(o.id)}" aria-label="Buka ${esc(o.name)}"></a>
    <div class="hm-card-top">${bldHTML(o, true)}<div class="hm-card-id"><h3>${esc(o.name)}</h3><p>${esc(o.style || '')}</p></div>${favBtn(o)}</div>
    <div class="hm-card-agents">${ss.length ? ss.slice(0, 6).map(x => `<button class="hm-face" data-act="go-sess" data-office="${esc(o.id)}" data-sid="${esc(x.sid)}" title="${esc((x.look?.name || x.title || 'Sesi') + ' · ' + sessLabel(x))}">${mini(x.look || guestLook(x.sid))}${stDot(x)}</button>`).join('') + (ss.length > 6 ? `<span class="hm-more">+${ss.length - 6}</span>` : '') : '<span class="hint">Belum ada sesi</span>'}</div>
    <div class="hm-card-foot">${status}<span>${o.cards?.open || 0} kartu</span><span>${usd(o.monthCost, 0)} bln ini</span></div></div>`;
}
function rowHTML(o) {
  const ss = o.sessions.filter(x => x.status !== 'ended');
  return `<tr class="click" data-name="${esc(o.name.toLowerCase())}" data-act="go-office" data-id="${esc(o.id)}"><td>${favBtn(o)}</td>
    <td><span class="hm-rowname">${bldHTML(o)}<span><b>${esc(o.name)}</b><span class="hint">${esc(o.style || '')}</span></span></span></td>
    <td class="num" data-l="sesi">${ss.length ? `<b>${ss.length}</b>` : '–'}</td><td class="num" data-l="kartu">${o.cards?.open || 0}</td><td class="num" data-l="bln">${usd(o.monthCost, 0)}</td><td class="hint">${o.lastSeen ? ago(o.lastSeen) : '–'}</td></tr>`;
}
function addOffice() { go('#/baru'); }

/* ---------------- office ---------------- */
async function loadOffice(id) {
  if (id === '_kompleks') { ctx.office = { id: '_kompleks', name: 'Kompleks', roles: [], sessions: [], plan: { rooms: [] }, cards: [] }; return ctx.office; }
  ctx.office = await api(`/api/offices/${id}`);
  return ctx.office;
}
async function renderOffice(r, prev) {
  const sameOffice = prev && prev.name === 'office' && prev.id === r.id;
  if (!sameOffice || !ctx.office || ctx.office.id !== r.id) await loadOffice(r.id);
  if (!ctx.st) await refreshState();
  const o = ctx.office;
  // the tab bar in the header shows which tab is open, so the crumbs stop at the office (a switcher)
  const tabs = r.id === '_kompleks' ? ['notes', 'wiki'] : Object.keys(TABS);
  const tabNav = cls => `<nav class="tabs ${cls}" role="tablist"></nav>`;
  const fav = ctx.st?.offices.find(x => x.id === o.id)?.fav;
  if (r.id === '_kompleks') crumbs([['Bersama']]);
  else { crumbs([]); $('#crumbs').insertAdjacentHTML('beforeend', `<span aria-hidden="true">/</span><button class="off-btn" data-act="office-switch" aria-haspopup="menu" title="Pindah kantor">${fav ? '<span class="fav-ic">★</span>' : ''}${esc(o.name)}<span class="caret" aria-hidden="true">▾</span></button>`); }
  $('#crumbs').insertAdjacentHTML('beforeend', tabNav('top-tabs'));
  mountTabBar($('.top-tabs'), { tabs, labels: TABS, current: r.tab, href: k => r.id === '_kompleks' ? `#/kompleks/${k}` : `#/o/${o.id}/${k}`, reorder: r.id !== '_kompleks' });
  if (r.id !== '_kompleks') pratinjau.badge(r.id).then(n => paintPvBadge(r.id, n));
  if (sameOffice && prev.tab === r.tab) { ctx.view?.route?.(r); return; }
  if (r.tab === 'kantor' && r.id !== '_kompleks') {
    ctx.view = kantorView;
    kantorView.render(view, { eyebrow: o.style || 'Kantor', tabs: '' });
    if (ctx.pendingSid) { const sid = ctx.pendingSid, tab = ctx.pendingTab || 'term'; ctx.pendingSid = null; ctx.pendingTab = null; setTimeout(() => { if (o.sessions.some(x => x.sid === sid)) openSession(ctx, sid, tab); }, 300); }
    updateSub();
    return;
  }
  if (r.tab === 'chat' && r.id !== '_kompleks') { ctx.view = chatmode; await chatmode.render(view, ctx, r); return; }
  view.innerHTML = `<div class="wrap"><div class="office-head"><div><p class="eyebrow">${esc(o.style || (r.id === '_kompleks' ? 'Bersama untuk semua kantor' : 'Kantor'))}</p><h1>${esc(o.name)}</h1><p class="sub" id="officeSub"></p></div></div>
    <div id="tabBody"></div></div>`;
  updateSub();
  const body = $('#tabBody');
  if (r.tab === 'kantor') { ctx.view = kantorView; kantorView.render(body); }
  else { ctx.view = MODULES[r.tab]; await ctx.view.render(body, ctx, r); }
}
/** Lencana tab Pratinjau: berapa yang menunggu keputusan. */
function paintPvBadge(office, n) {
  if (ctx.office?.id !== office) return;
  for (const a of $$('.tabs [data-tab="pratinjau"]')) {
    let b = a.querySelector('.tab-badge');
    if (!b) { b = document.createElement('b'); b.className = 'tab-badge'; a.appendChild(b); }
    b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  }
  refitTabBar();
}
document.addEventListener('kantor:pratinjau-count', e => paintPvBadge(e.detail.office, e.detail.n));
function updateSub() {
  const o = ctx.office, el = $('#officeSub'); if (!o || !el || o.id === '_kompleks') return;
  const mgr = o.roles.find(r => r.isMgr), ss = o.sessions.filter(s => s.status !== 'ended');
  el.textContent = `${mgr ? `Manager: ${mgr.name} · ` : ''}${ss.length} sesi (${ss.filter(s => s.status === 'working').length} bekerja) · ${o.plan.rooms.filter(r => !['openplan', 'toilet', 'booth'].includes(r.kind)).length} ruangan · ${o.roles.length} role`;
}

/* ---------------- kantor tab ---------------- */
const kantorView = {
  sel: null,
  render(body, head) {
    const o = ctx.office;
    const mgr = o.roles.find(r => r.isMgr);
    body.innerHTML = `<div class="kf2" id="kf">
      <section class="kf-office"><div class="kf-frame">
        <div class="stage kf-stage" id="stage"></div>
        <div class="kf-top"><div class="roombar kf-rooms" id="roombar"></div></div>
        <div class="kf-chip"><b>${esc(o.name)}</b> <span id="officeSub"></span></div>
        <div class="stage-tools kf-tools"><button class="zbtn" data-act="zin" aria-label="Perbesar">+</button><button class="zbtn" data-act="zout" aria-label="Perkecil">−</button><button class="zbtn" data-act="zfit">Semua</button><button class="zbtn" data-act="kf-fullscreen" title="Layar penuh (sembunyikan toolbar browser)">⛶</button><button class="zbtn" data-act="layout-edit" title="Pindah, ubah ukuran, dan atur pintu ruangan">Atur denah</button></div>
      </div></section>
      <div class="kf-alist" id="kfAgents" aria-label="Daftar agen"></div>
      <aside class="kf-side" id="kfSide">
        ${mgr ? `<div class="card kf-mgr"><p class="eyebrow card-h">Suruh ${esc(mgr.name)}</p><form id="mgrForm" class="kf-ask"><textarea id="mgrInput" rows="2" placeholder="mis. rapikan alur pembayaran lalu siapkan rilis 1.8"></textarea><div class="btn-row"><button class="btn primary sm" type="submit">Kirim</button><span class="hint">Enter untuk kirim · Shift+Enter baris baru</span></div></form></div>` : ''}
        <div class="card kf-dm" id="dmCard"></div>
        <div class="card kf-inbox"><p class="eyebrow card-h">Kotak masuk</p><div id="inboxOffice"></div></div>
        <div class="card agents" id="sessCard"></div>
        <div class="card room-info" id="roomInfo"></div>
        ${minionCardHTML()}
        ${kunciCardHTML()}
        <div class="card"><p class="eyebrow card-h">Subagent aktif</p><div id="subList"></div></div>
        <div class="card"><p class="eyebrow card-h">Papan pengumuman</p><ul class="news" id="newsList"></ul><form id="newsForm" class="inline-form" style="margin-top:8px"><input id="newsInput" placeholder="Tempel pengumuman" autocomplete="off"><button class="btn sm">Tempel</button></form></div>
        <div class="card" id="wallCard" hidden><p class="eyebrow card-h">Ditempel di dinding</p><div class="wall-notes" id="wallNotes"></div></div>
        <div class="card"><p class="eyebrow card-h">Aktivitas</p><ol class="feed" id="feed"></ol></div>
      </aside>
      <div class="kf-stripwrap" id="kfStripWrap"><button class="kf-arrow l" data-act="strip-l" aria-label="Geser ke kiri" hidden>‹</button><nav class="kf-strip" id="kfStrip" aria-label="Agen"></nav><button class="kf-arrow r" data-act="strip-r" aria-label="Lihat agen lainnya" hidden>›<span class="n"></span></button></div>
      <div class="kf-resize" id="kfResize" role="separator" aria-orientation="vertical" title="Seret untuk mengubah lebar panel"><span></span></div>
    </div>`;
    document.documentElement.style.setProperty('--kf-top', $('.top').offsetHeight + 'px');
    try { const w = Number(localStorage.getItem('kc.kf.side')); if (w) document.documentElement.style.setProperty('--side-w', w + 'px'); } catch {}
    this.bindResize($('#kfResize'));
    ctx.stage = createStage($('#stage'), {
      plan: o.plan, roles: o.roles, sessions: o.sessions, cards: o.cards, fill: true, insets: { left: 10, top: 46, right: 10, bottom: 10 },
      onPick: (sid, sub, roleId) => { if (sid) openSession(ctx, sid, sub ? 'subs' : 'term'); else if (roleId) openRole(ctx, roleId); },
      onRoom: id => { this.sel = id; this.roomInfo(); this.roombar(); },
      onMinion: (id, sx, sy) => showMinionMenu($('#stage'), ctx.stage, o.id, id, sx, sy),
    });
    ctx.stage.minions.apply(o.minions);
    this.minionCard();
    paintKunciCard(ctx);
    this.strip();
    bindDmCard(ctx); paintDmCard(ctx);
    this.roombar(); this.inbox(); this.sess(); this.roomInfo(); this.subs(); this.news(); this.wall(); this.feed();
    this.timer = setInterval(() => { this.subs(); }, 1500);
  },
  minionCard() { paintMinionCard(() => ctx.office, () => ctx.stage?.minions.count()); },
  unmount() { clearInterval(this.timer); closeMinionMenu(); this.le?.close(); this.le = null; },
  async editLayout() {
    if (this.le || !ctx.stage) return;
    const o = ctx.office;
    try { const L = await api(`/api/offices/${o.id}/layout`); o.plan = L.plan; o.custom = L.custom; } catch (err) { return toast(err.message, 'bad'); }
    closeDrawer();
    ctx.stage.fitAll();
    this.le = openLayoutEditor({ office: o, stage: ctx.stage, host: $('#stage'), onDone: () => { this.le = null; this.roombar(); this.roomInfo(); } });
  },
  // space covered by the floating panels, so the floor plan centres in what stays visible
  insets(railOff) {
    const narrow = matchMedia('(max-width: 760px)').matches;
    return { left: 12, top: narrow ? 104 : 104, right: railOff || narrow ? 12 : 372, bottom: 76 };
  },
  toggleRail() {
    const kf = $('#kf'); if (!kf) return;
    const off = !kf.classList.contains('rail-off');
    kf.classList.toggle('rail-off', off);
    try { localStorage.setItem('kc.kf.rail', off ? 'off' : 'on'); } catch {}
    const b = $('[data-act="kf-rail"]'); b.textContent = off ? 'Tampilkan panel' : 'Sembunyikan panel'; b.setAttribute('aria-pressed', String(!off));
    ctx.stage?.setInsets(this.insets(off));
  },
  roombar() {
    const o = ctx.office, el = $('#roombar'); if (!el) return;
    const list = o.plan.rooms.filter(r => !['openplan', 'toilet', 'booth', 'lobby'].includes(r.kind));
    const cnt = id => o.sessions.filter(s => s.room === id && s.status !== 'ended').length;
    el.innerHTML = `<button data-act="zfit" aria-pressed="${!ctx.stage?.focus}">Seluruh lantai</button>` + list.map(r => `<button data-act="focus" data-id="${r.id}" aria-pressed="${ctx.stage?.focus === r.id}">${esc(r.name)}${cnt(r.id) ? `<span class="n">${cnt(r.id)}</span>` : ''}</button>`).join('');
  },
  inbox() { const el = $('#inboxOffice'); if (el) el.innerHTML = inboxHTML(ctx.st.inbox.filter(i => i.office === ctx.office.id), false); this.agents(); },
  sess() {
    const o = ctx.office, el = $('#sessCard'); if (!el) return;
    const ss = o.sessions.filter(s => s.status !== 'ended');
    const off = o.roles.filter(r => !ss.some(s => s.role === r.id));
    const label = s => s.waiting ? 'izin' : s.kind === 'manual' ? (s.status === 'working' ? 'bekerja' : 'manual') : { working: 'bekerja', idle: 'idle', starting: 'datang' }[s.status] || s.status;
    const cls = s => s.waiting ? 'waiting' : s.kind === 'manual' && s.status !== 'working' ? 'manual' : s.status;
    el.innerHTML = `<div class="ag-head"><span class="eyebrow">Agen</span><span class="ag-count">${ss.length} aktif</span></div>` + (ss.length ? `<ul class="ag-list">${ss.map(s => {
      const r = o.roles.find(x => x.id === s.role);
      const nm = r ? r.name + (s.slot ? ` #${s.slot + 1}` : '') : short(s.title || 'Sesi manual', 26);
      const who = [r ? r.title : 'Sesi manual', s.model ? modelName(s.model) : r ? modelName(r.model) : ''].filter(Boolean).join(' · ');
      const task = s.waiting ? 'menunggu izin' : s.tool ? `${s.tool.name} ${s.tool.label || ''}` : s.title || '';
      return `<li><button class="ag-row" data-act="open-sess" data-sid="${s.sid}"><span class="ag-ava">${mini(r || guestLook(s.sid))}</span><span class="ag-body"><b class="ag-name">${esc(nm)}</b><span class="ag-meta">${esc(who)}</span><span class="ag-task">${esc(short(task, 48))}</span></span><span class="ag-st ${cls(s)}">${label(s)}</span></button></li>`;
    }).join('')}</ul>` : '<p class="empty-line">Belum ada sesi berjalan.</p>') +
      (off.length ? `<p class="off-line">Libur: ${off.map(r => `<a href="#" data-act="open-role" data-id="${r.id}">${esc(r.name)}</a>`).join(', ')}</p>` : '');
  },
  // drag the divider between the floor plan and the right panel
  bindResize(h) {
    if (!h) return;
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag');
      const move = ev => {
        const w = Math.round(Math.min(Math.max(360, innerWidth - ev.clientX), Math.min(1100, innerWidth - 420)));
        document.documentElement.style.setProperty('--side-w', w + 'px');
        try { localStorage.setItem('kc.kf.side', String(w)); } catch {}
      };
      const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--side-w'); try { localStorage.removeItem('kc.kf.side'); } catch {} });
  },
  /* bottom strip: one card per role (boss first) plus manual sessions */
  strip() {
    const o = ctx.office, el = $('#kfStrip'); if (!el) return;
    const live = o.sessions.filter(s => s.status !== 'ended');
    // roles come in the order you arranged them (drag cards in the strip, or Alt+←/→)
    const roles = o.roles.filter(r => !r.archived);
    const room = id => o.plan.rooms.find(r => r.id === id)?.name || '';
    const st = s => !s ? 'off' : s.waiting ? 'wait' : s.status === 'working' ? 'work' : s.status === 'starting' ? 'start' : 'idle';
    const what = (s, fallback) => s.waiting ? `minta izin: ${s.waiting.tool || ''}` : s.tool ? `${s.tool.name} ${s.tool.label || ''}` : s.status === 'working' ? 'sedang bekerja' : fallback;
    const cxTag = s => isCodex(s) ? '<i class="kf-mode kf-cx" title="Mesin: OpenAI Codex">Codex</i>' : '';
    const modeTag = s => cxTag(s) + (s?.permMode && !['default', 'auto'].includes(s.permMode)
      ? `<i class="kf-mode m-${esc(s.permMode)}" title="Mode izin: ${esc(MODE_LABEL[s.permMode] || s.permMode)}">${esc({ bypassPermissions: 'bypass', acceptEdits: 'edit', dontAsk: 'tanpa tanya', readOnly: 'baca' }[s.permMode] || s.permMode)}</i>` : '');
    // one card: avatar with a status dot, name, and one line of what they are doing
    const card = (look, name, sub, s, attrs, boss, roleId, job = '') => `<div class="kf-card st-${st(s)}"${roleId ? ` draggable="true" data-role="${esc(roleId)}"` : ''}>
        <button class="kf-hit" ${attrs} title="${esc([name, job, sub].filter(Boolean).join(' · '))}"></button>
        <span class="kf-ava">${sprite(look, 4)}<i class="kf-dot"></i></span>
        <span class="kf-txt"><span class="kf-cname"><span class="kf-nm">${esc(name)}</span>${job ? `<span class="kf-job">${esc(job)}</span>` : ''}${boss ? '<i class="kf-boss">bos</i>' : ''}${modeTag(s)}</span><span class="kf-csub">${esc(sub)}</span></span>
        ${boss ? `<button class="kf-talk" data-act="kf-talk" data-id="${esc(roleId)}" title="Beri tugas ke ${esc(name)}">Suruh</button>` : ''}
      </div>`;
    // boss first, then whoever is on shift (incl. manual sessions); roles that are off go into one small group
    const boss = [], active = [], off = [];
    for (const r of roles) {
      const ss = live.filter(s => s.role === r.id);
      if (!ss.length) { if (r.isMgr) active.push(card(r, r.name, ['libur', room(r.room)].filter(Boolean).join(' · '), null, `data-act="open-role" data-id="${r.id}"`, true, r.id)); else off.push(r); continue; }
      for (const s of ss) active.push(card(r, r.name + (s.slot ? ` #${s.slot + 1}` : ''),
        what(s, s.title && !s.title.startsWith(r.name) ? s.title : ['idle', room(r.room)].filter(Boolean).join(' · ')), s, `data-act="open-sess" data-sid="${s.sid}"`, r.isMgr && !s.slot, r.id, r.isMgr && !s.slot ? '' : r.title));
    }
    for (const s of live.filter(s => !s.role)) {
      const loose = !s.title || s.title === 'Sesi belum terhubung';
      const where = [room(s.room), s.host && s.host !== 'lain' ? HOSTS[s.host] : ''].filter(Boolean).join(' · ');
      const boss = s.boss && o.roles.find(r => r.id === s.boss)?.name;
      active.push(card(guestLook(s.sid), loose ? 'Sesi manual' : s.title, what(s, loose ? `belum terhubung${where ? ' · ' + where : ''}` : where || 'manual'), s, `data-act="open-sess" data-sid="${s.sid}"`, false, null, boss ? `anak buah ${boss}` : ''));
    }
    const offGroup = off.length ? `<div class="kf-off"><span class="kf-off-h">Libur</span><span class="kf-off-avas">${off.map(r => `<button data-act="open-role" data-id="${r.id}" title="${esc(r.name)} · ${esc(r.title)} · ${esc(room(r.room))}">${sprite(r, 3)}</button>`).join('')}</span></div>` : '';
    el.innerHTML = [...boss, ...active].join('') + offGroup;
    // a mouse wheel scrolls the strip sideways (no scrollbar eating its height); arrows + fades show there is more
    if (!el.dataset.wheel) {
      el.dataset.wheel = 1;
      el.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
      el.addEventListener('scroll', () => stripEdges(el), { passive: true });
      new ResizeObserver(() => stripEdges(el)).observe(el);
    }
    stripEdges(el);
    bindStripDrag(el);
    this.agents();
  },
  /* phone version of the strip: a vertical list grouped by what needs you (waiting, working, idle, off) */
  agents() {
    const o = ctx.office, el = $('#kfAgents'); if (!el) return;
    const live = o.sessions.filter(s => s.status !== 'ended');
    const room = id => o.plan.rooms.find(r => r.id === id)?.name || '';
    const inbox = ctx.st.inbox.filter(i => i.office === o.id);
    const row = (look, name, job, sub, s, attrs, boss, roleId) => `<div class="al-row ${s ? (s.waiting ? 'wait' : s.status === 'working' ? 'work' : 'idle') : 'off'}">
        <button class="al-hit" ${attrs} aria-label="${esc(name)}"></button>
        <span class="al-ava">${sprite(look, 4)}<i class="kf-dot"></i></span>
        <span class="al-txt"><span class="al-name"><b>${esc(name)}</b>${job ? `<span class="al-job">${esc(job)}</span>` : ''}${boss ? '<i class="kf-boss">bos</i>' : ''}</span><span class="al-sub">${esc(sub)}</span></span>
        ${boss && roleId ? `<button class="al-talk" data-act="kf-talk" data-id="${esc(roleId)}">Suruh</button>` : ''}</div>`;
    const waitG = [], workG = [], idleG = [], off = [];
    const put = (s, look, name, job, boss, roleId, fallback) => {
      const attrs = `data-act="open-sess" data-sid="${s.sid}"`;
      if (s.waiting) waitG.push(row(look, name, job, `${s.waiting.tool === 'AskUserQuestion' ? 'bertanya' : 'minta izin'}: ${short(s.waiting.summary || s.waiting.tool || '', 60)}`, s, attrs, boss, roleId));
      else if (s.status === 'working' || s.status === 'starting') workG.push(row(look, name, job, s.tool ? `${s.tool.name} ${s.tool.label || ''}` : s.status === 'starting' ? 'baru datang' : 'sedang bekerja', s, attrs, boss, roleId));
      else idleG.push(row(look, name, job, `diam ${(ago(s.lastSeen) || 'baru saja').replace(' lalu', '')}${fallback ? ' · ' + fallback : ''}`, s, attrs, boss, roleId));
    };
    for (const r of o.roles.filter(r => !r.archived)) {
      const ss = live.filter(s => s.role === r.id);
      if (!ss.length) { off.push(r); continue; }
      for (const s of ss) { const boss = r.isMgr && !s.slot; put(s, r, r.name + (s.slot ? ` #${s.slot + 1}` : ''), boss ? '' : r.title, boss, r.id, room(r.room)); }
    }
    for (const s of live.filter(s => !s.role)) { const loose = !s.title || s.title === 'Sesi belum terhubung'; put(s, guestLook(s.sid), loose ? 'Sesi manual' : short(s.title, 30), '', false, null, room(s.room)); }
    const group = (title, n, body, cls = '') => n ? `<section class="al-grp ${cls}"><h3>${title} <span>${n}</span></h3>${body}</section>` : '';
    el.innerHTML = group('Menunggu kamu', waitG.length + inbox.length, (inbox.length ? inboxHTML(inbox, false) : '') + waitG.join(''), 'wait')
      + group('Bekerja', workG.length, workG.join(''))
      + group('Idle', idleG.length, idleG.join(''))
      + (!live.length ? '<p class="empty-line al-empty">Belum ada sesi berjalan.</p>' : '')
      + (off.length ? `<details class="al-grp al-off"><summary>Libur <span>${off.length}</span></summary>${off.map(r => row(r, r.name, r.title, room(r.room), null, `data-act="open-role" data-id="${r.id}"`, r.isMgr, r.id)).join('')}</details>` : '');
  },
  roomInfo() {
    const o = ctx.office, el = $('#roomInfo'); if (!el) return;
    const r = this.sel && o.plan.rooms.find(x => x.id === this.sel);
    if (!r) { el.innerHTML = '<h2>Ruangan</h2><p class="empty-line">Klik ruangan di denah untuk melihat repo, penghuni, dan kartunya.</p>'; return; }
    const res = o.roles.filter(x => x.room === r.id), ss = o.sessions.filter(s => s.room === r.id && s.status !== 'ended');
    const cards = o.cards.filter(c => c.repo === r.id && !(c.done ?? c.col >= 4));
    if (r.kind === 'musik') {
      const st = music.state();
      el.innerHTML = `<h2>${esc(r.name)}</h2><p class="hint" style="margin:4px 0 10px">Putar radio kantor atau lagu dan playlist-mu sendiri. Selama musik jalan, agen yang sedang santai nongkrong di sini.</p>
        <dl><dt>Sekarang</dt><dd>${st.playing ? `♪ ${esc(st.title || '')}` : 'sepi'}</dd></dl>
        <div class="btn-row" style="margin-top:10px"><button class="btn sm primary" data-act="music-toggle">${st.playing ? 'Jeda' : 'Putar musik'}</button><button class="btn sm" data-act="music-lib">Pustaka &amp; playlist</button></div>`;
      return;
    }
    if (r.kind === 'meeting') {
      const now = ss.filter(s => s.kind === 'rapat');
      el.innerHTML = `<h2>${esc(r.name)}</h2><p class="hint" style="margin:4px 0 10px">Tempat rapat antar-role. Saat rapat jalan, pesertanya berjalan ke meja ini dan layar TV menyala. Notulen otomatis masuk wiki. Subagent yang sedang merencanakan (Plan) juga duduk di sini.</p>
        <dl><dt>Sekarang</dt><dd>${now.length ? `rapat berjalan · ${now.length} peserta` : 'kosong'}</dd></dl>
        <div class="btn-row" style="margin-top:10px"><a class="btn sm primary" href="#/o/${esc(o.id)}/rapat">${now.length ? 'Ikuti rapat' : 'Mulai rapat'}</a></div>`;
      return;
    }
    el.innerHTML = `<h2>${esc(r.name)}</h2><dl>
      ${r.path ? `<dt>Folder</dt><dd><code>${esc(r.path)}/</code></dd>` : ''}${r.stack ? `<dt>Jenis</dt><dd>${esc(r.stack)}</dd>` : ''}
      ${r.worktrees?.length ? `<dt>Worktree</dt><dd>${r.worktrees.map(w => `<code>${esc(w)}</code>`).join(' ')}</dd>` : ''}
      ${r.md ? `<dt>Aturan</dt><dd><code>${esc(r.path)}/CLAUDE.md</code></dd>` : ''}
      <dt>Penghuni</dt><dd>${res.length ? res.map(x => `<a href="#" data-act="open-role" data-id="${x.id}">${esc(x.name)}</a>`).join(', ') : 'belum ada'}</dd>
      <dt>Sesi</dt><dd>${ss.length}</dd>
      <dt>Kartu</dt><dd>${cards.length ? cards.map(c => esc(short(c.title, 34))).join('<br>') : 'tidak ada'}</dd></dl>
      <div class="btn-row" style="margin-top:10px">${r.path != null ? `<button class="btn sm" data-act="room-dock" data-id="${r.id}">Proses &amp; terminal</button><button class="btn sm" data-act="room-shell" data-id="${r.id}">Buka shell di sini</button>` : ''}<button class="btn sm" data-act="new-shift-room" data-id="${r.id}">Mulai shift di sini</button></div>`;
  },
  subs() {
    const o = ctx.office, el = $('#subList'); if (!el) return;
    const list = o.sessions.flatMap(s => (s.subs || []).map(x => ({ ...x, s })));
    if (!list.length) { el.innerHTML = '<p class="empty-line">Tidak ada. Subagent muncul saat sesi memanggil tool Agent.</p>'; return; }
    el.innerHTML = `<ul class="subs">${list.map(x => { const r = o.roles.find(q => q.id === x.s.role); return `<li style="--sc:${r?.color || '#9AA3AF'}"><span class="sub-type">${esc(r?.name || 'Sesi')} → ${esc(x.type)} · ${Math.round((Date.now() - x.started) / 1000)} dtk${x.status === 'done' ? ' · selesai' : ''}</span><span>${esc(x.desc || '')}</span>${x.tool ? `<span class="hint">${esc(x.tool.name)} ${esc(x.tool.label || '')}</span>` : ''}</li>`; }).join('')}</ul>`;
  },
  news() { const el = $('#newsList'); if (el) el.innerHTML = ctx.office.news.length ? ctx.office.news.map(n => `<li><span>${esc(n.text)}${n.author && n.author !== 'Kamu' && n.author !== 'Sistem' ? ` <span class="hint">— ${esc(n.author)}</span>` : ''}</span><button data-act="news-del" data-id="${n.id}" aria-label="Lepas">✕</button></li>`).join('') : '<li class="empty-line" style="background:none;border:0">Kosong</li>'; },
  wall() { const w = ctx.office.wall || [], card = $('#wallCard'); if (!card) return; card.hidden = !w.length; $('#wallNotes').innerHTML = w.map(n => `<a href="#/o/${ctx.office.id}/notes/${n.id}" style="background:var(--n-${n.color})"><b>${esc(short(n.title || 'Catatan', 30))}</b><br>${esc(short(n.body, 90))}</a>`).join(''); },
  feed() { const el = $('#feed'); if (el) el.innerHTML = ctx.office.log.map(feedLi).join(''); },
  live(m) {
    const o = ctx.office;
    if (m.t === 'session' || m.t === 'session-gone') { ctx.stage?.sync(o.sessions); this.sess(); this.strip(); this.roombar(); this.subs(); updateSub(); }
    if (m.t === 'log') { const f = $('#feed'); if (f) { f.insertAdjacentHTML('afterbegin', feedLi(m.entry)); while (f.children.length > 60) f.lastChild.remove(); } }
    if (m.t?.startsWith('inbox')) this.inbox();
  },
};
const feedLi = l => `<li><time>${hhmm(l.at)}</time><span><b>${esc(l.who)}</b> ${esc(l.text)}</span></li>`;

/* ---------------- live events ---------------- */
onLive(async m => {
  const o0 = ctx.office;
  if (m.t === 'dm') dmLive(m, ctx);
  if (m.t === 'pratinjau' && o0 && m.office === o0.id && ctx.view !== pratinjau) pratinjau.badge(o0.id).then(n => paintPvBadge(o0.id, n));
  if (m.t === 'pratinjau' && ctx.view !== pratinjau) pratinjau.liveViewer(m); // penampil yang dibuka dari chat
  try { viewerLive(m, ctx); dockLive(m, ctx); kunciLive(m, ctx); } catch (e) { console.error(e); }
  if (o0 && m.office === o0.id && ctx.stage?.minions) {
    if (m.t === 'minions') { o0.minions = m.minions; ctx.stage.minions.apply(m.minions); if (ctx.view === kantorView) kantorView.minionCard(); }
    else ctx.stage.minions.live(m);
  }
  if (m.t === 'reconnected') { if (ctx.route) { await refreshState().catch(() => {}); if (ctx.office && ctx.office.id !== '_kompleks') { await loadOffice(ctx.office.id).catch(() => {}); ctx.stage?.sync(ctx.office.sessions); ctx.stage?.minions?.apply(ctx.office.minions); } } return; }
  if (m.t === 'hello') return;
  agentsLive(m);
  const o = ctx.office;
  if (m.t === 'session' && o && m.office === o.id) {
    const i = o.sessions.findIndex(s => s.sid === m.session.sid);
    if (i >= 0) o.sessions[i] = m.session; else o.sessions.push(m.session);
    if (m.session.status === 'ended') setTimeout(() => { const k = o.sessions.findIndex(s => s.sid === m.session.sid && s.status === 'ended'); if (k >= 0) { o.sessions.splice(k, 1); ctx.stage?.sync(o.sessions); } }, 9000);
  }
  if (m.t === 'meeting-typing' && o && m.office === o.id) ctx.stage?.speak?.(m.role, m.done ? '' : m.text ? `…${m.text.replace(/\s+/g, ' ').slice(-28)}` : '…');
  if (m.t === 'session-gone' && o) { const k = o.sessions.findIndex(s => s.sid === m.sid); if (k >= 0) o.sessions.splice(k, 1); }
  if (m.t === 'log' && o && m.office === o.id) { o.log.unshift(m.entry); o.log.length = Math.min(o.log.length, 80); }
  if (m.t === 'inbox') {
    ctx.st && (ctx.st.inbox = [m.item, ...ctx.st.inbox.filter(x => x.id !== m.item.id)]);
    toast(`${m.item.who || 'Sesi'} minta izin: ${m.item.tool} ${short(m.item.summary, 40)}`, 'warn');
    notify(`${m.item.who || 'Sesi'} minta izin`, `${m.item.tool}: ${m.item.summary}`);
  }
  if (m.t === 'inbox-update' && ctx.st) ctx.st.inbox = ctx.st.inbox.filter(x => x.id !== m.id || m.status === 'open');
  if (m.t?.startsWith('inbox')) { topCounts(); if (ctx.route?.name === 'map') { const el = $('#inboxAll'); if (el) el.innerHTML = inboxHTML(ctx.st.inbox, true); } }
  if (m.t === 'changed' && o && (m.office === o.id || m.office === '*')) {
    // only the order changed (someone rearranged the strip, maybe in another tab): no need to rebuild the floor
    if (m.what === 'roles-order' && Array.isArray(m.order)) { const pos = new Map(m.order.map((id, i) => [id, i])); o.roles.sort((a, b) => (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999)); kantorView.strip?.(); }
    if (m.what === 'furniture' && !kantorView.le) { const fresh = await api(`/api/offices/${o.id}`).catch(() => null); if (fresh) { o.plan = fresh.plan; ctx.stage?.setFurniture?.(fresh.plan.furniture || []); } }
    if ((m.what === 'plan' || m.what === 'roles') && !kantorView.le) { const fresh = await api(`/api/offices/${o.id}`).catch(() => null); if (fresh) { Object.assign(o, fresh); ctx.stage?.rebuild(o.plan, o.roles); kantorView.roombar?.(); } }
    if (m.what === 'board') { const b = await api(`/api/offices/${o.id}/board?board=all`).catch(() => null); if (b) { const prev = o.cards; o.cards = b.cards.map(c => ({ id: c.id, title: c.title, col: c.col, stage: c.stage, done: c.done, board: c.board, who: c.who, repo: c.repo, blocked: c.blocked })); ctx.stage?.setCards(o.cards); ctx.stage?.minions?.cards(prev, o.cards); } }
    if (m.what === 'news') { o.news = await api(`/api/offices/${o.id}`).then(x => x.news).catch(() => o.news); kantorView.news?.(); }
    if (m.what === 'notes') { o.wall = await api(`/api/offices/${o.id}`).then(x => x.wall).catch(() => o.wall); if (ctx.view === kantorView) kantorView.wall(); }
  }
  if (ctx.route?.name === 'map' && (m.t === 'session' || m.t === 'session-gone')) debounceMap();
  ctx.view?.live?.(m, ctx);
  drawerOnLive(ctx, m);
});
let mapT = null;
const debounceMap = () => { clearTimeout(mapT); mapT = setTimeout(() => { if (ctx.route?.name === 'map') renderMap(); }, 1500); };
function notify(title, body) {
  if (document.hasFocus() || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}

/* ---------------- global clicks ---------------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const a = t.dataset.act, o = ctx.office;
  try {
    switch (a) {
      case 'allow': case 'deny': e.preventDefault(); await post(`/api/inbox/${t.dataset.id}`, { behavior: a }); toast(a === 'allow' ? 'Diizinkan' : 'Ditolak', a === 'allow' ? 'ok' : 'bad'); break;
      case 'add-office': addOffice(); break;
      case 'fav': e.preventDefault(); e.stopPropagation(); await post(`/api/offices/${t.dataset.id}/fav`, { fav: t.dataset.v === '1' }); toast(t.dataset.v === '1' ? 'Ditambahkan ke favorit' : 'Dihapus dari favorit', 'ok'); await refreshState(); if (ctx.route?.name === 'map') renderMap(); else renderSwitcher(); break;
      case 'go-office': go(`#/o/${t.dataset.id}`); break;
      case 'go-sess': e.preventDefault(); ctx.pendingSid = t.dataset.sid; if (ctx.route?.name === 'office' && ctx.route.id === t.dataset.office && ctx.route.tab === 'kantor') { openSession(ctx, t.dataset.sid, 'term'); ctx.pendingSid = null; } else go(`#/o/${t.dataset.office}`); break;
      case 'resume-ended': e.preventDefault(); resumeEnded(t.dataset.sid); break;
      case 'music-lib': e.preventDefault(); openMusicLibrary(); break;
      case 'music-toggle': e.preventDefault(); music.toggle(); setTimeout(() => kantorView.roomInfo?.(), 300); break;
      case 'strip-l': case 'strip-r': { const el = $('#kfStrip'); el?.scrollBy({ left: (t.dataset.act === 'strip-l' ? -1 : 1) * el.clientWidth * .8, behavior: 'smooth' }); break; }
      case 'room-dock': e.preventDefault(); openDock({ office: ctx.office?.id, room: t.dataset.id }); break;
      case 'office-switch': e.preventDefault(); toggleSwitcher(); break;
      case 'zin': ctx.stage?.zoomBy(1.4); kantorView.roombar(); break;
      case 'zout': ctx.stage?.zoomBy(1 / 1.4); kantorView.roombar(); break;
      case 'zfit': ctx.stage?.fitAll(); kantorView.roombar(); break;
      case 'layout-edit': kantorView.editLayout(); break;
      case 'kf-rail': kantorView.toggleRail(); break;
      case 'kf-fullscreen': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast('Browser menolak layar penuh', 'bad')); break;
      case 'kf-talk': e.stopPropagation(); closeDrawer(); setTimeout(() => { const i = $('#mgrInput'); if (i) { i.focus(); i.scrollIntoView({ block: 'nearest' }); } }, 30); break;
      case 'focus': ctx.stage?.focusRoom(t.dataset.id); kantorView.sel = t.dataset.id; ctx.stage?.select(t.dataset.id); kantorView.roombar(); kantorView.roomInfo(); break;
      case 'open-sess': openSession(ctx, t.dataset.sid, 'term'); break;
      case 'open-role': e.preventDefault(); openRole(ctx, t.dataset.id); break;
      case 'close-drawer': closeDrawer(); break;
      case 'news-del': o.news = await del(`/api/offices/${o.id}/news/${t.dataset.id}`); kantorView.news(); break;
      case 'room-shell': openSession(ctx, null, 'shell', { room: t.dataset.id }); break;
      case 'new-shift-room': roles.startShiftDialog(ctx, null, { room: t.dataset.id }); break;
    }
  } catch (err) { toast(err.message, 'bad'); }
});
document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'mgrForm') {
    e.preventDefault();
    const text = $('#mgrInput').value.trim(); if (!text) return;
    const o = ctx.office, mgr = o.roles.find(r => r.isMgr);
    const live = o.sessions.find(s => s.role === mgr.id && s.status !== 'ended' && s.tmux);
    try {
      if (live) { await post(`/api/sessions/${live.sid}/action`, { action: 'text', text }); toast(`Terkirim ke ${mgr.name}`, 'ok'); }
      else { await post(`/api/offices/${o.id}/roles/${mgr.id}/start`, { task: text }); toast(`${mgr.name} mulai shift dengan permintaanmu`, 'ok'); }
      $('#mgrInput').value = '';
    } catch (err) { toast(err.message, 'bad'); }
  }
  if (f.id === 'newsForm') {
    e.preventDefault();
    const v = $('#newsInput').value.trim(); if (!v) return;
    try { ctx.office.news = await post(`/api/offices/${ctx.office.id}/news`, { text: v }); $('#newsInput').value = ''; kantorView.news(); } catch (err) { toast(err.message, 'bad'); }
  }
});
document.addEventListener('keydown', e => { if (e.target.id === 'mgrInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#mgrForm')?.requestSubmit(); return; } if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true; else if (e.key === 'Escape' && drawerState().open && !e.target.closest('.xterm')) closeDrawer(); });

/* boot */
connectLive();
initViewer(ctx);
initDock(ctx);
initAgents({ ctx, openSession, go, refresh: refreshState });
refreshState().then(route).catch(e => { view.innerHTML = `<div class="wrap"><div class="notice">${esc(e.message)}</div></div>`; });
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
export { loadOffice, updateSub, kantorView };
