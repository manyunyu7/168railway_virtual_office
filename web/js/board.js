// Tab Board: kanban + daftar + drawer kartu. Data dari API sungguhan, realtime lewat live().
import { $, $$, esc, short, ago, api, post, patch, del, toast, confirmDo, mini, md, ICON, debounce } from './util.js';
import { showDrawer, closeDrawer, drawerState, drawerEl } from './panel.js';
import { startShiftDialog } from './roles.js';

const COLS = ['Backlog', 'Siap', 'Dikerjakan', 'Review', 'Selesai'];
const WIP = [0, 0, 5, 3, 0];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];
const LS = id => 'kc.board.' + id;

const S = {
  ctx: null, el: null, oid: null,
  cards: [], seen: new Map(),
  f: { q: '', role: '', repo: '', prio: '', group: 'none', view: 'kanban', sort: { k: 'col', dir: 1 } },
  dragId: null, timer: null, flash: new Set(), liveSig: '',
  dr: null, // { id|null, card, preview, blockedOpen, comment, notify, pending, focus }
  drEl: null, handlers: null, rootHandlers: null,
};

/* ---------------- helpers ---------------- */
const office = () => S.ctx.office;
const base = () => `/api/offices/${S.oid}`;
const roles = () => (office().roles || []).filter(r => !r.archived);
const roleOf = id => id && (office().roles || []).find(r => r.id === id);
const roleByAny = k => { k = String(k || '').toLowerCase(); return (office().roles || []).find(r => r.id.toLowerCase() === k || r.name.toLowerCase() === k); };
const rooms = () => office().plan?.rooms || [];
const repoName = id => {
  if (!id) return 'tanpa repo';
  if (id === 'lintas') return 'lintas repo';
  const r = rooms().find(x => x.id === id);
  return r ? r.name : id;
};
const whoName = id => (id ? roleOf(id)?.name || id : 'Belum ditugaskan');
const prioVar = p => `var(--${String(p || 'P2').toLowerCase()})`;
const epics = () => S.cards.filter(c => c.epic);
const kids = id => S.cards.filter(c => c.epicId === id);
const isLive = c => !!c.who && (office().sessions || []).some(s => s.role === c.who && s.status === 'working');
const liveHTML = c => (isLive(c) ? `<div class="kc-live"><i></i>${esc(whoName(c.who))} sedang bekerja</div>` : '');
const repoOptions = (cur) => {
  const list = rooms().filter(r => r.path != null || r.id === cur).map(r => [r.id, r.name]);
  if (!list.some(x => x[0] === 'lintas')) list.push(['lintas', 'lintas repo']);
  if (cur && !list.some(x => x[0] === cur)) list.push([cur, cur]);
  return list;
};

function loadPrefs() {
  try { Object.assign(S.f, JSON.parse(localStorage.getItem(LS(S.oid)) || '{}')); } catch {}
  if (!['none', 'repo', 'role'].includes(S.f.group)) S.f.group = 'none';
  if (!['kanban', 'list'].includes(S.f.view)) S.f.view = 'kanban';
}
function savePrefs() {
  try { const { q, role, repo, prio, group, view } = S.f; localStorage.setItem(LS(S.oid), JSON.stringify({ q, role, repo, prio, group, view })); } catch {}
}

function filtered() {
  const f = S.f, q = f.q.trim().toLowerCase();
  return S.cards.filter(c => !c.epic
    && (!q || c.title.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q))
    && (!f.role || (f.role === '_none' ? !c.who : c.who === f.role))
    && (!f.repo || c.repo === f.repo)
    && (!f.prio || c.prio === f.prio));
}

/* ---------------- board view ---------------- */
function shellHTML() {
  const f = S.f;
  const repos = rooms().filter(r => r.path != null || S.cards.some(c => c.repo === r.id));
  const opts = repos.map(r => [r.id, r.name]);
  if (!opts.some(x => x[0] === 'lintas')) opts.push(['lintas', 'lintas repo']);
  return `<div class="bd-toolbar">
      <input type="search" id="bdQ" placeholder="Cari kartu" value="${esc(f.q)}" aria-label="Cari kartu">
      <select id="bdRole" aria-label="Filter role"><option value="">Semua role</option>${roles().map(r => `<option value="${esc(r.id)}" ${f.role === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="_none" ${f.role === '_none' ? 'selected' : ''}>Belum ditugaskan</option></select>
      <select id="bdRepo" aria-label="Filter repo"><option value="">Semua repo</option>${opts.map(([id, n]) => `<option value="${esc(id)}" ${f.repo === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select id="bdPrio" aria-label="Filter prioritas"><option value="">Semua prioritas</option>${PRIOS.map(p => `<option ${f.prio === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <span class="seg-l">Kelompok</span><div class="seg">${[['none', 'Tidak ada'], ['repo', 'Repo'], ['role', 'Role']].map(([k, v]) => `<button data-act="bd-group" data-v="${k}" aria-pressed="${f.group === k}">${v}</button>`).join('')}</div>
      <div class="seg">${[['kanban', 'Kanban'], ['list', 'Daftar']].map(([k, v]) => `<button data-act="bd-view" data-v="${k}" aria-pressed="${f.view === k}">${v}</button>`).join('')}</div>
      <button class="btn primary" data-act="bd-new" style="margin-left:auto">Kartu baru</button>
    </div>
    <div class="epics" id="bdEpics"></div><div id="bdMain"></div>`;
}

function renderEpics() {
  const box = $('#bdEpics', S.el); if (!box) return;
  box.innerHTML = epics().map(ep => {
    const ks = kids(ep.id), d = ks.filter(k => k.col === 4).length;
    return `<button class="epic-card" data-act="bd-open" data-id="${esc(ep.id)}">
      <div class="kc-row1"><span class="prio" style="--pc:${prioVar(ep.prio)}">${esc(ep.prio)}</span><span class="epic">Epic · ${esc(COLS[ep.col] || '')}</span></div>
      <h4>${esc(ep.title)}</h4>
      <div class="kc-check"><div class="bar"><i style="width:${ks.length ? Math.round(d / ks.length * 100) : 0}%"></i></div><span>${d}/${ks.length}</span></div>
      <div class="epic-parts">${ks.map(k => `<span class="${k.col === 4 ? 'done' : ''}">${esc(repoName(k.repo))}${k.col === 4 ? ' selesai' : ''}</span>`).join('')}</div></button>`;
  }).join('');
}

function cardHTML(c) {
  const r = c.who && roleOf(c.who), ep = c.epicId && S.cards.find(x => x.id === c.epicId);
  const tot = c.checks?.total || 0, done = c.checks?.done || 0;
  return `<div class="kc${S.flash.has(c.id) ? ' flash' : ''}" draggable="true" tabindex="0" role="button" data-act="bd-open" data-id="${esc(c.id)}" data-card="${esc(c.id)}" style="--pc:${prioVar(c.prio)}">
    <div class="kc-row1"><span class="prio">${esc(c.prio)}</span><span class="repo">${esc(repoName(c.repo))}</span></div>
    <h4>${esc(c.title)}</h4>
    ${ep ? `<p class="kc-epic">Epic: ${esc(short(ep.title, 34))}</p>` : ''}
    ${c.blocked ? `<p class="kc-block">Terblokir: ${esc(c.blocked)}</p>` : ''}
    ${tot ? `<div class="kc-check"><div class="bar"><i style="width:${Math.round(done / tot * 100)}%"></i></div><span>${done}/${tot}</span></div>` : ''}
    <div class="kc-foot"><span class="kc-who">${r ? mini(r) + esc(r.name) : '<span class="sub">Belum ditugaskan</span>'}</span>
      ${c.comments ? `<span class="ico">${ICON.chat}${c.comments}</span>` : ''}${c.due ? `<span class="ico">${ICON.clock}${esc(c.due)}</span>` : ''}</div>
    <div class="kc-slot">${liveHTML(c)}</div>
  </div>`;
}

function lanes(cards) {
  const g = S.f.group;
  if (g === 'repo') {
    const keys = [...new Set(cards.map(c => c.repo || ''))];
    return keys.map(k => ({ key: k, label: repoName(k) }));
  }
  if (g === 'role') {
    const keys = roles().map(r => r.id);
    cards.forEach(c => { if (c.who && !keys.includes(c.who)) keys.push(c.who); });
    keys.push('_none');
    return keys.map(k => ({ key: k, label: k === '_none' ? 'Belum ditugaskan' : whoName(k) }));
  }
  return [{ key: null, label: '' }];
}

function renderMain() {
  const main = $('#bdMain', S.el); if (!main) return;
  if (!S.cards.length) {
    main.innerHTML = `<div class="empty"><p>Board masih kosong. Buat kartu pertama, atau minta manager atau agent menambahkannya lewat MCP kantor.</p><button class="btn primary" data-act="bd-new">Kartu baru</button></div>`;
    return;
  }
  const cards = filtered();
  if (!cards.length) { main.innerHTML = '<p class="empty-line">Tidak ada kartu yang cocok dengan filter.</p>'; return; }
  main.innerHTML = S.f.view === 'list' ? listHTML(cards) : kanbanHTML(cards);
}

function kanbanHTML(cards) {
  const g = S.f.group, ls = lanes(cards);
  const inLane = (c, l) => l.key === null || (g === 'repo' ? (c.repo || '') === l.key : (c.who || '_none') === l.key);
  let html = COLS.map((name, i) => {
    const n = cards.filter(c => c.col === i).length, lim = WIP[i];
    return `<div class="kb-colh${lim && n > lim ? ' over' : ''}"><h3>${name}</h3><span class="count">${n}${lim ? ' / ' + lim : ''}</span></div>`;
  }).join('');
  ls.forEach(l => {
    if (l.label) html += `<div class="lane-h">${esc(l.label)}</div>`;
    html += COLS.map((_, i) => `<div class="kb-cell" data-drop="${i}" data-lane="${l.key === null ? '' : esc(l.key)}">${cards.filter(c => c.col === i && inLane(c, l)).map(cardHTML).join('')}</div>`).join('');
  });
  return `<div class="board-scroll"><div class="kb">${html}</div></div>`;
}

const SORTS = {
  prio: c => c.prio, title: c => c.title.toLowerCase(), repo: c => repoName(c.repo).toLowerCase(),
  who: c => whoName(c.who).toLowerCase(), col: c => c.col,
  checks: c => (c.checks?.total ? c.checks.done / c.checks.total : -1), moved: c => c.movedAt || '',
};
function listHTML(cards) {
  const { k, dir } = S.f.sort, fn = SORTS[k] || SORTS.col;
  const sorted = [...cards].sort((a, b) => { const x = fn(a), y = fn(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.col - b.col; });
  const th = (key, label) => `<th><button class="bd-th" data-act="bd-sort" data-k="${key}">${label}${S.f.sort.k === key ? `<span aria-hidden="true">${dir > 0 ? ' ▲' : ' ▼'}</span>` : ''}</button></th>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${th('prio', 'Prioritas')}${th('title', 'Kartu')}${th('repo', 'Repo')}${th('who', 'Role')}${th('col', 'Status')}${th('checks', 'Checklist')}${th('moved', 'Terakhir')}</tr></thead><tbody>
    ${sorted.map(c => `<tr class="click" data-card="${esc(c.id)}" data-act="bd-open" data-id="${esc(c.id)}" tabindex="0">
      <td><span class="prio" style="--pc:${prioVar(c.prio)}">${esc(c.prio)}</span></td>
      <td>${esc(c.title)}${c.blocked ? ' <span class="st wait">terblokir</span>' : ''}<span class="kc-slot-inline">${isLive(c) ? ' <span class="st working">live</span>' : ''}</span></td>
      <td><span class="repo">${esc(repoName(c.repo))}</span></td>
      <td>${esc(whoName(c.who))}</td><td>${esc(COLS[c.col] || '')}</td>
      <td>${c.checks?.total ? `${c.checks.done}/${c.checks.total}` : '-'}</td>
      <td class="sub">${esc(c.movedBy ? c.movedBy + ' · ' + ago(c.movedAt) : '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function updateLive() {
  if (!S.el) return;
  const sig = (office().sessions || []).filter(s => s.status === 'working').map(s => s.role).sort().join(',');
  if (sig === S.liveSig) return;
  S.liveSig = sig;
  $$('.kc[data-card]', S.el).forEach(el => {
    const c = S.cards.find(x => x.id === el.dataset.card), slot = $('.kc-slot', el);
    if (c && slot) slot.innerHTML = liveHTML(c);
  });
  $$('tr[data-card]', S.el).forEach(tr => {
    const c = S.cards.find(x => x.id === tr.dataset.card), slot = $('.kc-slot-inline', tr);
    if (c && slot) slot.innerHTML = isLive(c) ? ' <span class="st working">live</span>' : '';
  });
  if (S.dr?.card && !S.dr.pending) { const b = $('.bd-livebox', drawerEl()); if (b) b.innerHTML = liveHTML(S.dr.card); }
}

function paint() { renderEpics(); renderMain(); }

async function fetchBoard() {
  const b = await api(`${base()}/board`);
  const next = new Map(b.cards.map(c => [c.id, c.updatedAt]));
  if (S.seen.size) b.cards.forEach(c => { if (S.seen.get(c.id) !== c.updatedAt) S.flash.add(c.id); });
  S.seen = next; S.cards = b.cards;
  return b;
}
async function refetch() {
  try { await fetchBoard(); } catch (e) { toast(e.message, 'bad'); return; }
  if (!S.el) return; // tab was left while fetching
  paint();
  if (S.flash.size) setTimeout(() => { S.flash.clear(); if (S.el) $$('.kc.flash', S.el).forEach(e => e.classList.remove('flash')); }, 1800);
  if (S.dr?.id) {
    if (!S.cards.some(c => c.id === S.dr.id)) { if (drawerOwned()) closeDrawer(); S.dr = null; }
    else refreshDrawer();
  }
}
const schedule = debounce(() => refetch(), 300);

/* ---------------- drag & drop ---------------- */
async function drop(cell, id) {
  const c = S.cards.find(x => x.id === id); if (!c) return;
  const col = Number(cell.dataset.drop), lane = cell.dataset.lane, g = S.f.group;
  const body = { col };
  if (g === 'role' && lane !== undefined) body.who = lane === '_none' || lane === '' ? null : lane;
  if (g === 'repo' && lane !== undefined) body.repo = lane;
  if (c.col === col && (body.who === undefined || (body.who || null) === (c.who || null)) && (body.repo === undefined || body.repo === (c.repo || ''))) return;
  Object.assign(c, { col }, body.who !== undefined ? { who: body.who } : {}, body.repo !== undefined ? { repo: body.repo } : {});
  renderMain();
  try { await patch(`${base()}/cards/${id}`, body); } catch (e) { toast(e.message, 'bad'); }
  refetch();
}

/* ---------------- drawer ---------------- */
const drawerOwned = () => { const s = drawerState(); return s.open && S.dr && s.key === 'card:' + (S.dr.id || 'new'); };
const inField = () => { const d = drawerEl(), a = document.activeElement; return !!(d && a && d.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };

function blankCard() {
  const f = S.f;
  return { id: null, title: '', desc: '', col: 0, who: f.role && f.role !== '_none' ? f.role : '', repo: f.repo || '', prio: 'P2', due: '', blocked: '', epic: false, epicId: '', checklist: [], comments: [], history: [], links: [], children: [] };
}

async function openCard(id) {
  try {
    const card = await api(`${base()}/cards/${id}`);
    S.dr = { id, card, preview: false, blockedOpen: false, comment: '', notify: false, pending: false };
    showDr();
  } catch (e) { toast(e.message, 'bad'); }
}
function openNew() {
  S.dr = { id: null, card: blankCard(), preview: false, blockedOpen: false, comment: '', notify: false, pending: false };
  showDr();
  $('#cdTitle', drawerEl())?.focus();
}
async function reloadCard(focusSel) {
  if (!S.dr?.id) return;
  try { S.dr.card = await api(`${base()}/cards/${S.dr.id}`); } catch (e) { toast(e.message, 'bad'); return; }
  S.dr.pending = false;
  showDr(focusSel);
}
function refreshDrawer() {
  if (!S.dr?.id || !drawerOwned()) return;
  if (inField()) { S.dr.pending = true; return; }
  reloadCard();
}

function whoOpts(c) {
  return `<option value="">Belum ditugaskan</option>${roles().map(r => `<option value="${esc(r.id)}" ${c.who === r.id ? 'selected' : ''}>${esc(r.name)} · ${esc(r.title || '')}</option>`).join('')}${c.who && !roleOf(c.who) ? `<option value="${esc(c.who)}" selected>${esc(c.who)}</option>` : ''}`;
}
function chipsHTML(c) {
  return `<span class="prio" style="--pc:${prioVar(c.prio)}">${esc(c.prio)}</span><span class="repo">${esc(repoName(c.repo))}</span>${c.epic ? '<span class="epic">Epic</span>' : ''}${c.id ? `<span class="hint">${esc(c.id)}</span>` : '<span class="hint">kartu baru</span>'}`;
}

function drawerHTML() {
  const { card: c, preview, blockedOpen } = S.dr, isNew = !c.id;
  const blocked = !!c.blocked || blockedOpen;
  const epicOpts = epics().filter(e => e.id !== c.id);
  const ck = c.checklist || [];
  const unchecked = ck.filter(x => !x.done).length;
  const cardIds = new Set(S.cards.map(x => x.id));
  const fields = `<div class="cd-grid">
      <div><label for="cdCol">Status</label><select id="cdCol" data-f="col">${COLS.map((n, i) => `<option value="${i}" ${c.col === i ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div><label for="cdWho">Ditugaskan ke</label><select id="cdWho" data-f="who">${whoOpts(c)}</select></div>
      <div><label for="cdPrio">Prioritas</label><select id="cdPrio" data-f="prio">${PRIOS.map(p => `<option ${c.prio === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div><label for="cdRepo">Repo</label><select id="cdRepo" data-f="repo"><option value="">Tanpa repo</option>${repoOptions(c.repo).map(([id, n]) => `<option value="${esc(id)}" ${c.repo === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label for="cdDue">Tenggat</label><div class="bd-due"><input id="cdDue" data-f="due" value="${esc(c.due)}" placeholder="2026-10-25 atau teks bebas" autocomplete="off"><button type="button" class="btn sm" data-act="bd-datepick" aria-label="Pilih tanggal">Tanggal</button><input type="date" id="cdDate" class="bd-date" tabindex="-1" aria-hidden="true"></div></div>
      <div><label for="cdEpic">Epic induk</label><select id="cdEpic" data-f="epicId"><option value="">Tanpa epic</option>${epicOpts.map(e => `<option value="${esc(e.id)}" ${c.epicId === e.id ? 'selected' : ''}>${esc(short(e.title, 36))}</option>`).join('')}</select></div>
    </div>`;
  const blockBox = `<div class="bd-block">
      <label class="bd-check"><input type="checkbox" id="cdBlk" ${blocked ? 'checked' : ''}> Terblokir</label>
      ${blocked ? `<input id="cdBlkWhy" value="${esc(c.blocked)}" placeholder="Alasan terblokir, mis. menunggu API dari Wulan" autocomplete="off">` : ''}</div>`;
  const desc = `<section class="dr-sec"><div class="bd-sec-h"><h3>Deskripsi</h3>${isNew ? '' : `<button type="button" class="btn sm ghost" data-act="bd-preview">${preview ? 'Edit' : 'Pratinjau'}</button>`}</div>
      ${preview ? `<div class="bd-prev">${c.desc ? md(c.desc, { roles: office().roles || [], cardIds, taskIndex: false }) : '<p class="hint">Belum ada deskripsi.</p>'}</div>`
        : `<textarea id="cdDesc" rows="5" placeholder="Apa yang harus dikerjakan, batasan, catatan. Markdown boleh.">${esc(c.desc)}</textarea>`}</section>`;
  if (isNew) {
    return `<div class="dr-head" style="align-items:flex-start"><div class="dr-id"><div class="kc-row1">${chipsHTML(c)}</div>
        <input class="cd-title" id="cdTitle" value="${esc(c.title)}" placeholder="Judul kartu" aria-label="Judul kartu" autocomplete="off"></div>
        <button class="icon-btn" data-act="close-drawer" aria-label="Tutup panel">✕</button></div>
      <div class="dr-body">${fields}${desc}
        <div class="btn-row"><button class="btn primary" data-act="bd-create">Buat kartu</button><button class="btn" data-act="close-drawer">Batal</button></div></div>`;
  }
  const children = c.epic ? `<section class="dr-sec"><h3>Sub-kartu (${(c.children || []).filter(k => k.col === 4).length}/${(c.children || []).length} selesai)</h3>
      <ul class="checklist">${(c.children || []).map(k => `<li class="${k.col === 4 ? 'done' : ''}"><span><a href="#" data-act="bd-open" data-id="${esc(k.id)}">${esc(k.title)}</a> <span class="hint">· ${esc(repoName(k.repo))} · ${esc(k.colName || COLS[k.col])}${k.who ? ' · ' + esc(whoName(k.who)) : ''}</span></span></li>`).join('') || '<li><span class="hint">Belum ada sub-kartu.</span></li>'}</ul></section>` : '';
  const checklist = `<section class="dr-sec"><h3>Checklist (${ck.filter(x => x.done).length}/${ck.length})</h3>
      <ul class="checklist">${ck.map(it => `<li class="${it.done ? 'done' : ''}"><input type="checkbox" id="ck${it.id}" data-ck="${it.id}" ${it.done ? 'checked' : ''}><label for="ck${it.id}" style="font-weight:400;font-size:14px"><span>${esc(it.text)}</span></label><button class="x" data-act="bd-ckdel" data-ck="${it.id}" aria-label="Hapus item">✕</button></li>`).join('')}</ul>
      <form class="inline-form" data-form="ck" style="margin-top:6px"><input id="ckInput" placeholder="Tambah item checklist" autocomplete="off"><button class="btn sm" type="submit">Tambah</button></form>
      ${unchecked ? `<div class="btn-row" style="margin-top:8px"><button class="btn sm" data-act="bd-split">Pecah jadi sub-kartu</button><span class="hint">${unchecked} item belum dicentang jadi kartu sendiri</span></div>` : ''}</section>`;
  const thread = (c.comments || []).map(m => {
    const r = roleByAny(m.who), you = /^(kamu|you)$/i.test(m.who);
    return `<li><span>${r ? mini(r) : ''}</span><div><div class="meta"><b>${esc(you ? 'Kamu' : r ? r.name : m.who)}</b> · ${esc(ago(m.at))}</div><div class="bd-msg">${esc(m.text)}</div></div></li>`;
  }).join('') || '<li><span></span><span class="hint">Belum ada komentar.</span></li>';
  const links = (c.links || []).length ? `<section class="dr-sec"><h3>Terkait</h3><ul class="hist">${c.links.map(l => `<li><span>${esc(l.kind)}</span><span>${/^https?:\/\//.test(l.value) ? `<a href="${esc(l.value)}" target="_blank" rel="noreferrer">${esc(short(l.value, 60))}</a>` : `<code>${esc(l.value)}</code>`}</span></li>`).join('')}</ul></section>` : '';
  const hist = `<section class="dr-sec"><h3>Riwayat</h3><ul class="hist">${(c.history || []).slice(0, 15).map(h => `<li><span>${esc(ago(h.at))}</span><span><b>${esc(h.who)}</b> ${esc(h.text)}</span></li>`).join('') || '<li><span></span><span>Belum ada.</span></li>'}</ul></section>`;
  return `<div class="dr-head" style="align-items:flex-start"><div class="dr-id"><div class="kc-row1 bd-chips">${chipsHTML(c)}</div>
      <input class="cd-title" id="cdTitle" data-f="title" value="${esc(c.title)}" aria-label="Judul kartu" autocomplete="off"></div>
      <button class="icon-btn" data-act="close-drawer" aria-label="Tutup panel">✕</button></div>
    <div class="dr-body">
      <div class="bd-livebox">${liveHTML(c)}</div>
      ${fields}${blockBox}${desc}${c.epic ? children : ''}${checklist}
      <section class="dr-sec"><h3>Komentar</h3><ul class="thread">${thread}</ul>
        <form class="inline-form bd-cm" data-form="cm" style="margin-top:8px"><input id="cmInput" placeholder="Tulis komentar" value="${esc(S.dr.comment)}" autocomplete="off"><button class="btn sm primary" type="submit">Kirim</button></form>
        <label class="bd-check"><input type="checkbox" id="cmNotify" ${S.dr.notify ? 'checked' : ''} ${c.who ? '' : 'disabled'}> Teruskan ke sesi role yang ditugaskan</label></section>
      ${links}${hist}
      <div class="btn-row">
        ${c.who ? `<button class="btn primary" data-act="bd-shift">Mulai shift ${esc(whoName(c.who))} untuk kartu ini</button>` : ''}
        <button class="btn danger" data-act="bd-delete">Hapus kartu</button>
      </div></div>`;
}

function showDr(focusSel) {
  const key = 'card:' + (S.dr.id || 'new');
  const prev = drawerEl() && $('.dr-body', drawerEl());
  const top = drawerState().open && drawerState().key === key && prev ? prev.scrollTop : 0;
  const d = showDrawer(drawerHTML(), { wide: false, key, close: () => { S.dr = null; } });
  bindDrawer(d);
  if (top) { const b = $('.dr-body', d); if (b) b.scrollTop = top; }
  if (focusSel) $(focusSel, d)?.focus();
}

async function savePatch(body) {
  const dr = S.dr; if (!dr?.id) return;
  try {
    const card = await patch(`${base()}/cards/${dr.id}`, body);
    if (S.dr === dr && card && card.id) {
      dr.card = { ...dr.card, ...card, checklist: card.checklist ?? dr.card.checklist, comments: card.comments ?? dr.card.comments, history: card.history ?? dr.card.history, children: card.children ?? dr.card.children, links: card.links ?? dr.card.links };
      const chips = $('.bd-chips', drawerEl()); if (chips) chips.innerHTML = chipsHTML(dr.card);
    }
  } catch (e) { toast(e.message, 'bad'); reloadCard(); }
}

const saveDesc = debounce(() => {
  const t = $('#cdDesc', drawerEl()); if (!t || !S.dr?.id) return;
  S.dr.card.desc = t.value;
  savePatch({ desc: t.value });
}, 700);

function readNew() {
  const d = drawerEl(), v = id => $(id, d)?.value ?? '';
  return { title: v('#cdTitle').trim(), desc: v('#cdDesc'), col: Number(v('#cdCol')), who: v('#cdWho') || null, repo: v('#cdRepo'), prio: v('#cdPrio'), due: v('#cdDue').trim(), epicId: v('#cdEpic') || undefined };
}

function bindDrawer(d) {
  if (d._bd) return;
  d._bd = true;
  const click = async e => {
    const t = e.target.closest('[data-act]'); if (!t || !S.dr) return;
    const a = t.dataset.act, dr = S.dr;
    try {
      if (a === 'bd-open') { e.preventDefault(); openCard(t.dataset.id); }
      else if (a === 'bd-datepick') { const dt = $('#cdDate', d); try { dt.showPicker(); } catch { dt.focus(); } }
      else if (a === 'bd-preview') {
        if (!dr.preview) { const ta = $('#cdDesc', d); if (ta) { dr.card.desc = ta.value; if (dr.id) await savePatch({ desc: ta.value }); } }
        dr.preview = !dr.preview; showDr();
      }
      else if (a === 'bd-create') {
        const b = readNew();
        if (!b.title) { toast('Judul kartu wajib diisi', 'warn'); $('#cdTitle', d)?.focus(); return; }
        const card = await post(`${base()}/cards`, b);
        toast('Kartu dibuat', 'ok');
        S.dr = { ...dr, id: card.id, card, preview: false };
        showDr(); refetch();
      }
      else if (a === 'bd-ckdel') { await post(`${base()}/cards/${dr.id}/check`, { itemId: t.dataset.ck, remove: true }); await reloadCard(); refetch(); }
      else if (a === 'bd-split') {
        confirmDo('Pecah jadi sub-kartu', 'Item checklist yang belum dicentang jadi kartu sendiri, dan kartu ini menjadi epic.', 'Pecah', async () => {
          try { await post(`${base()}/cards/${dr.id}/split`, {}); toast('Dipecah jadi sub-kartu', 'ok'); await reloadCard(); refetch(); } catch (err) { toast(err.message, 'bad'); }
        }, 'primary');
      }
      else if (a === 'bd-shift') {
        const c = dr.card; closeDrawer();
        startShiftDialog(S.ctx, c.who, { cardId: c.id });
      }
      else if (a === 'bd-delete') {
        const c = dr.card;
        confirmDo('Hapus kartu', `Kartu "${esc(short(c.title, 60))}"${c.epic ? ' beserta sub-kartunya' : ''} akan dihapus dari board.`, 'Hapus', async () => {
          try { await del(`${base()}/cards/${c.id}`); closeDrawer(); toast('Kartu dihapus', 'ok'); refetch(); } catch (err) { toast(err.message, 'bad'); }
        });
      }
    } catch (err) { toast(err.message, 'bad'); }
  };
  const change = async e => {
    const t = e.target, dr = S.dr; if (!dr) return;
    if (t.id === 'cdDate') { const due = $('#cdDue', d); due.value = t.value; if (dr.id) { dr.card.due = t.value; savePatch({ due: t.value }); } return; }
    if (t.dataset.ck) {
      try { await post(`${base()}/cards/${dr.id}/check`, { itemId: t.dataset.ck, done: t.checked }); await reloadCard(); refetch(); } catch (err) { toast(err.message, 'bad'); reloadCard(); }
      return;
    }
    if (t.id === 'cmNotify') { dr.notify = t.checked; return; }
    if (t.id === 'cdBlk') {
      if (t.checked) { dr.blockedOpen = true; showDr('#cdBlkWhy'); }
      else { dr.blockedOpen = false; dr.card.blocked = ''; if (dr.id) { await savePatch({ blocked: '' }); } showDr(); refetch(); }
      return;
    }
    if (t.id === 'cdBlkWhy') {
      const why = t.value.trim();
      if (why !== (dr.card.blocked || '')) { dr.card.blocked = why; await savePatch({ blocked: why }); }
      return;
    }
    const f = t.dataset.f; if (!f) return;
    let v = t.value;
    if (f === 'col') v = Number(v);
    if (f === 'who') v = v || null;
    if (f === 'title' && !v.trim()) { t.value = dr.card.title; return; }
    if (f === 'epicId') v = v || '';
    dr.card[f] = v;
    if (dr.id) savePatch({ [f]: v });
  };
  const input = e => {
    if (e.target.id === 'cdDesc' && S.dr?.id) saveDesc();
    if (e.target.id === 'cmInput' && S.dr) S.dr.comment = e.target.value;
  };
  const submit = async e => {
    const f = e.target.closest('form[data-form]'); if (!f || !S.dr?.id) return;
    e.preventDefault();
    const dr = S.dr;
    try {
      if (f.dataset.form === 'ck') {
        const v = $('#ckInput', d).value.trim(); if (!v) return;
        await post(`${base()}/cards/${dr.id}/check`, { text: v });
        await reloadCard('#ckInput'); refetch();
      } else {
        const v = $('#cmInput', d).value.trim(); if (!v) return;
        await post(`${base()}/cards/${dr.id}/comment`, { text: v, notify: !!($('#cmNotify', d)?.checked && dr.card.who) });
        dr.comment = '';
        await reloadCard('#cmInput'); refetch();
      }
    } catch (err) { toast(err.message, 'bad'); }
  };
  const focusout = e => {
    if (e.target.id === 'cdDesc' && S.dr?.id && e.target.value !== S.dr.card.desc) { S.dr.card.desc = e.target.value; savePatch({ desc: e.target.value }); }
    if (!S.dr?.pending) return;
    setTimeout(() => { if (S.dr?.pending && !inField()) { S.dr.pending = false; reloadCard(); } }, 200);
  };
  const keydown = e => { if (e.key === 'Enter' && e.target.matches('#cdTitle,#cdDue,#cdBlkWhy')) e.target.blur(); };
  const mdclick = e => { const a = e.target.closest('a[data-card]'); if (a) { e.preventDefault(); openCard(a.dataset.card); } };
  d.addEventListener('click', click); d.addEventListener('click', mdclick);
  d.addEventListener('change', change); d.addEventListener('input', input);
  d.addEventListener('submit', submit); d.addEventListener('focusout', focusout); d.addEventListener('keydown', keydown);
  S.handlers = { d, list: [['click', click], ['click', mdclick], ['change', change], ['input', input], ['submit', submit], ['focusout', focusout], ['keydown', keydown]] };
}

/* ---------------- root events ---------------- */
function bindRoot(el) {
  const click = e => {
    const t = e.target.closest('[data-act]'); if (!t || !el.contains(t)) return;
    const a = t.dataset.act;
    if (a === 'bd-open') { e.preventDefault(); openCard(t.dataset.id); }
    else if (a === 'bd-new') openNew();
    else if (a === 'bd-group' || a === 'bd-view') {
      S.f[a === 'bd-group' ? 'group' : 'view'] = t.dataset.v;
      $$(`[data-act="${a}"]`, el).forEach(b => b.setAttribute('aria-pressed', String(b === t)));
      savePrefs(); renderMain();
    }
    else if (a === 'bd-sort') {
      const k = t.dataset.k;
      S.f.sort = S.f.sort.k === k ? { k, dir: -S.f.sort.dir } : { k, dir: 1 };
      renderMain();
    }
  };
  const searchSoon = debounce(() => { S.f.q = $('#bdQ', el).value; savePrefs(); renderMain(); }, 150);
  const input = e => { if (e.target.id === 'bdQ') searchSoon(); };
  const change = e => {
    const m = { bdRole: 'role', bdRepo: 'repo', bdPrio: 'prio' }[e.target.id];
    if (m) { S.f[m] = e.target.value; savePrefs(); renderMain(); }
  };
  const keydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.kc,tr[data-card]')) { e.preventDefault(); openCard(e.target.dataset.card); }
  };
  const dragstart = e => {
    const k = e.target.closest?.('.kc'); if (!k) return;
    S.dragId = k.dataset.card; k.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', S.dragId); } catch {}
  };
  const dragend = () => { S.dragId = null; $$('.dragging,.kb-cell.over', el).forEach(x => x.classList.remove('dragging', 'over')); };
  const dragover = e => {
    const c = e.target.closest?.('.kb-cell'); if (!c || !S.dragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (!c.classList.contains('over')) { $$('.kb-cell.over', el).forEach(x => x.classList.remove('over')); c.classList.add('over'); }
  };
  const dragleave = e => { const c = e.target.closest?.('.kb-cell'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('over'); };
  const dropEv = e => {
    const c = e.target.closest?.('.kb-cell'); if (!c || !S.dragId) return;
    e.preventDefault(); const id = S.dragId; dragend(); drop(c, id);
  };
  const list = [['click', click], ['input', input], ['change', change], ['keydown', keydown], ['dragstart', dragstart], ['dragend', dragend], ['dragover', dragover], ['dragleave', dragleave], ['drop', dropEv]];
  list.forEach(([n, f]) => el.addEventListener(n, f));
  S.rootHandlers = { el, list };
}
function unbind() {
  const r = S.rootHandlers; if (r) r.list.forEach(([n, f]) => r.el.removeEventListener(n, f));
  const h = S.handlers; if (h) { h.list.forEach(([n, f]) => h.d.removeEventListener(n, f)); h.d._bd = false; }
  S.rootHandlers = S.handlers = null;
}

/* ---------------- module interface ---------------- */
export async function render(el, ctx, route) {
  unbind();
  Object.assign(S, { ctx, el, oid: ctx.office.id, cards: [], seen: new Map(), flash: new Set(), dr: null, liveSig: '' });
  S.f = { q: '', role: '', repo: '', prio: '', group: 'none', view: 'kanban', sort: { k: 'col', dir: 1 } };
  loadPrefs();
  el.innerHTML = '<p class="empty-line">Memuat board…</p>';
  try { await fetchBoard(); } catch (e) { el.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  S.liveSig = (ctx.office.sessions || []).filter(s => s.status === 'working').map(s => s.role).sort().join(',');
  el.innerHTML = shellHTML();
  bindRoot(el);
  paint();
  if (route?.rest?.[0]) openCard(route.rest[0]);
}

export function route(r) {
  const id = r?.rest?.[0];
  if (id && S.el && !(S.dr && S.dr.id === id && drawerOwned())) openCard(id);
}

export function live(msg, ctx) {
  if (!S.el || !S.oid) return;
  if (ctx) S.ctx = ctx;
  if (msg.t === 'changed' && msg.what === 'board' && (msg.office === S.oid || msg.office === '*')) {
    if (msg.card) S.flash.add(msg.card);
    schedule();
  } else if (msg.t === 'reconnected') schedule();
  else if (msg.t === 'session' || msg.t === 'session-gone') updateLive();
}

export function unmount() {
  unbind();
  clearTimeout(S.timer);
  if (S.dr && drawerOwned()) closeDrawer();
  S.dr = null; S.el = null; S.oid = null;
}
