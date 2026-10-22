// Board: panel detail kartu (drawer) + pengelola label + unggah lampiran.
import { $, $$, esc, short, ago, api, post, patch, del, toast, confirmDo, modal, mini, md, ICON, debounce } from './util.js';
import { showDrawer, closeDrawer, drawerState, drawerEl } from './panel.js';
import { startShiftDialog } from './roles.js';
import { PRIOS, isDate, progressOf, fmtSize, labelInk } from './board-lib.js';
import { S, hooks, office, base, roles, roleOf, roleByAny, repoName, whoName, repoOptions, epics, liveHTML, labelChip, labelOf, mediaUrl, prioVar, boardOf, curBoard, isAll, KIND_LABEL } from './board-state.js';

let handlers = null;

export const drawerOwned = () => { const s = drawerState(); return s.open && S.dr && s.key === 'card:' + (S.dr.id || 'new'); };
const inField = () => { const d = drawerEl(), a = document.activeElement; return !!(d && a && d.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };

function blankCard() {
  const f = S.f;
  return { id: null, board: isAll() ? 'utama' : S.board, publishAt: '', title: '', desc: '', col: 0, who: f.who.length === 1 && f.who[0] !== '_none' ? f.who[0] : '', repo: f.repos.length === 1 && f.repos[0] !== '_none' ? f.repos[0] : '', prio: 'P2', due: '', start: '', estDays: null, progress: null, labels: f.labels.slice(0, 1), milestone: false, cover: null, blocked: '', epic: false, epicId: '', checklist: [], comments: [], history: [], links: [], children: [], deps: [], blocks: [], attachments: [] };
}

export async function openCard(id) {
  try {
    const card = await api(`${base()}/cards/${id}`);
    S.dr = { id, card, preview: false, blockedOpen: false, comment: '', notify: false, pending: false, uploading: 0 };
    showDr();
  } catch (e) { toast(e.message, 'bad'); }
}
export function openNew(over = {}) {
  S.dr = { id: null, card: { ...blankCard(), ...over }, preview: false, blockedOpen: false, comment: '', notify: false, pending: false, uploading: 0 };
  showDr();
  $('#cdTitle', drawerEl())?.focus();
}
export async function reloadCard(focusSel) {
  if (!S.dr?.id) return;
  try { S.dr.card = await api(`${base()}/cards/${S.dr.id}`); } catch (e) { toast(e.message, 'bad'); return; }
  S.dr.pending = false;
  showDr(focusSel);
}
export function refreshDrawer() {
  if (!S.dr?.id || !drawerOwned()) return;
  if (inField()) { S.dr.pending = true; return; }
  reloadCard();
}
export function closeDetail() { if (S.dr && drawerOwned()) closeDrawer(); S.dr = null; }
export function updateLiveBox() { if (S.dr?.card && !S.dr.pending) { const b = $('.bd-livebox', drawerEl()); if (b) b.innerHTML = liveHTML(S.dr.card); } }

/* ---------------- tampilan ---------------- */
function whoOpts(c) {
  return `<option value="">Belum ditugaskan</option>${roles().map(r => `<option value="${esc(r.id)}" ${c.who === r.id ? 'selected' : ''}>${esc(r.name)} · ${esc(r.title || '')}</option>`).join('')}${c.who && !roleOf(c.who) ? `<option value="${esc(c.who)}" selected>${esc(c.who)}</option>` : ''}`;
}
function chipsHTML(c) {
  return `<span class="prio" style="--pc:${prioVar(c.prio)}">${esc(c.prio)}</span><span class="repo">${esc(repoName(c.repo))}</span>${c.epic ? '<span class="epic">Epic</span>' : ''}${c.milestone ? '<span class="bd-ms-tag">◆ Milestone</span>' : ''}${c.id ? `<span class="hint">${esc(c.id)}</span>` : '<span class="hint">kartu baru</span>'}`;
}
const lblPicks = c => S.labels.length
  ? S.labels.map(l => `<button type="button" class="lbl pick" data-act="bd-lbl" data-id="${esc(l.id)}" aria-pressed="${(c.labels || []).includes(l.id)}" style="--lc:${esc(l.color)};--li:${labelInk(l.color)}">${esc(l.name)}</button>`).join('')
  : '<span class="hint">Belum ada label. Buat lewat Kelola label.</span>';

function fieldsHTML(c) {
  const epicOpts = epics().filter(e => e.id !== c.id);
  const boards = S.boards.filter(b => !b.archived || b.id === c.board), cols = (boardOf(c.board) || curBoard() || { columns: [] }).columns;
  return `<div class="cd-grid">
      ${boards.length > 1 ? `<div><label for="cdBoard">Papan</label><select id="cdBoard" data-f="board">${boards.map(b => `<option value="${esc(b.id)}" ${(c.board || 'utama') === b.id ? 'selected' : ''}>${esc(b.icon || '')} ${esc(b.name)}</option>`).join('')}</select></div>` : ''}
      <div><label for="cdCol">Status</label><select id="cdCol" data-f="col">${cols.map((x, i) => `<option value="${i}" ${c.col === i ? 'selected' : ''}>${esc(x.name)} · ${KIND_LABEL[x.kind] || x.kind}</option>`).join('')}</select></div>
      <div><label for="cdWho">Ditugaskan ke</label><select id="cdWho" data-f="who">${whoOpts(c)}</select></div>
      <div><label for="cdPrio">Prioritas</label><select id="cdPrio" data-f="prio">${PRIOS.map(p => `<option ${c.prio === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div><label for="cdRepo">Repo</label><select id="cdRepo" data-f="repo"><option value="">Tanpa repo</option>${repoOptions(c.repo).map(([id, n]) => `<option value="${esc(id)}" ${c.repo === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label for="cdStart">Mulai</label><div class="bd-due"><input type="date" id="cdStart" data-f="start" value="${isDate(c.start) ? esc(c.start) : ''}"><button type="button" class="btn sm ghost" data-act="bd-clr" data-for="cdStart" aria-label="Hapus tanggal mulai">Hapus</button></div></div>
      <div><label for="cdDue">Tenggat</label><div class="bd-due"><input type="date" id="cdDue" data-f="due" value="${isDate(c.due) ? esc(c.due) : ''}"><button type="button" class="btn sm ghost" data-act="bd-clr" data-for="cdDue" aria-label="Hapus tenggat">Hapus</button></div></div>
      <div><label for="cdPub">Tanggal tayang</label><div class="bd-due"><input type="date" id="cdPub" data-f="publishAt" value="${isDate(c.publishAt) ? esc(c.publishAt) : ''}"><button type="button" class="btn sm ghost" data-act="bd-clr" data-for="cdPub" aria-label="Hapus tanggal tayang">Hapus</button></div></div>
      <div><label for="cdEst">Estimasi (hari)</label><input type="number" id="cdEst" data-f="estDays" min="0" step="0.5" value="${c.estDays ?? ''}" placeholder="mis. 3"></div>
      <div><label for="cdEpic">Epic induk</label><select id="cdEpic" data-f="epicId"><option value="">Tanpa epic</option>${epicOpts.map(e => `<option value="${esc(e.id)}" ${c.epicId === e.id ? 'selected' : ''}>${esc(short(e.title, 36))}</option>`).join('')}</select></div>
    </div>`;
}
function progressHTML(c) {
  const auto = c.progress == null, ck = c.checklist || [], autoV = ck.length ? Math.round(ck.filter(x => x.done).length / ck.length * 100) : 0, v = auto ? autoV : c.progress;
  return `<div class="bd-prog"><label for="cdProg">Progres <b id="cdProgV">${v}%</b></label>
      <div class="bd-prog-row"><input type="range" id="cdProg" min="0" max="100" step="5" value="${v}" ${auto ? 'disabled' : ''}>
      <label class="bd-check"><input type="checkbox" id="cdAuto" ${auto ? 'checked' : ''}> Otomatis dari checklist</label></div></div>
      <label class="bd-check"><input type="checkbox" id="cdMs" data-f="milestone" ${c.milestone ? 'checked' : ''}> Milestone (penanda tonggak, tampil sebagai ◆)</label>`;
}
function depsHTML(c) {
  const bn = d => (d.board && d.board !== c.board ? ` · papan ${esc(boardOf(d.board)?.name || d.board)}` : '');
  const row = (d, rm) => `<li class="${d.done ? 'done' : ''}"><span><a href="#" data-act="bd-open" data-id="${esc(d.id)}">${esc(short(d.title, 52))}</a> <span class="hint">· ${esc(d.colName || '')}${bn(d)}</span></span>${rm ? `<button class="x" data-act="bd-depdel" data-id="${esc(d.id)}" aria-label="Lepas dependensi ${esc(short(d.title, 30))}">✕</button>` : ''}</li>`;
  return `<section class="dr-sec"><h3>Dependensi</h3>
      <p class="hint" style="margin-bottom:4px">Menunggu kartu (${(c.deps || []).length})</p>
      <ul class="checklist bd-deps">${(c.deps || []).map(d => row(d, true)).join('') || '<li><span class="hint">Tidak menunggu kartu lain.</span></li>'}</ul>
      <div class="bd-depadd"><input id="depQ" type="search" placeholder="Cari kartu untuk ditunggu…" autocomplete="off" aria-label="Cari kartu untuk ditunggu" value="${esc(S.dr.depQ || '')}"><ul class="bd-depres" id="depRes"></ul></div>
      ${(c.blocks || []).length ? `<p class="hint" style="margin:10px 0 4px">Memblokir (${c.blocks.length}), kartu ini menahan:</p><ul class="checklist bd-deps">${c.blocks.map(d => row(d, false)).join('')}</ul>` : ''}</section>`;
}
function attHTML(c) {
  const at = c.attachments || [];
  const pvCover = /^pv:/.test(c.cover || '');
  return `<section class="dr-sec"><div class="bd-sec-h"><h3>Lampiran (${at.length})</h3><span class="btn-row">${pvCover ? '<button type="button" class="btn sm ghost" data-act="bd-cover-off">Lepas sampul</button>' : ''}<button type="button" class="btn sm ghost" data-act="bd-cover-pv">Sampul dari pratinjau…</button></span></div>
      <div class="bd-drop" id="bdDrop">${S.dr.uploading ? `Mengunggah ${S.dr.uploading} file…` : 'Seret file ke sini atau '}${S.dr.uploading ? '' : '<button type="button" class="btn sm" data-act="bd-pickfile">pilih file</button>'}<input type="file" id="bdFile" multiple hidden></div>
      <ul class="bd-atts">${at.map(a => `<li><a class="bd-thumb" href="${esc(a.url)}" target="_blank" rel="noreferrer" aria-label="Buka ${esc(a.name)}">${a.image ? `<img src="${esc(a.url)}" alt="" loading="lazy">` : `<span class="ico-file">${ICON.file}</span>`}</a>
        <div class="bd-att-in"><b>${esc(short(a.name, 40))}</b><span class="hint">${esc(fmtSize(a.size))}${c.cover === a.id ? ' · sampul' : ''}</span>
        <div class="btn-row">${a.image ? `<button type="button" class="btn sm" data-act="bd-cover" data-id="${esc(a.id)}">${c.cover === a.id ? 'Lepas sampul' : 'Jadikan sampul'}</button>` : ''}<a class="btn sm" href="${esc(a.url)}?dl=1" download>Unduh</a><button type="button" class="btn sm danger" data-act="bd-attdel" data-id="${esc(a.id)}">Lepas</button></div></div></li>`).join('')}</ul></section>`;
}

function drawerHTML() {
  const { card: c, preview, blockedOpen } = S.dr, isNew = !c.id;
  const blocked = !!c.blocked || blockedOpen;
  const ck = c.checklist || [];
  const unchecked = ck.filter(x => !x.done).length;
  const cardIds = new Set(S.cards.map(x => x.id));
  const blockBox = `<div class="bd-block">
      <label class="bd-check"><input type="checkbox" id="cdBlk" ${blocked ? 'checked' : ''}> Terblokir</label>
      ${blocked ? `<input id="cdBlkWhy" value="${esc(c.blocked)}" placeholder="Alasan terblokir, mis. menunggu API dari Wulan" autocomplete="off">` : ''}</div>`;
  const lbls = `<section class="dr-sec"><div class="bd-sec-h"><h3>Label</h3><button type="button" class="btn sm ghost" data-act="bd-lblmgr">Kelola label</button></div><div class="bd-lbls" id="bdLbls">${lblPicks(c)}</div></section>`;
  const desc = `<section class="dr-sec"><div class="bd-sec-h"><h3>Deskripsi</h3>${isNew ? '' : `<button type="button" class="btn sm ghost" data-act="bd-preview">${preview ? 'Edit' : 'Pratinjau'}</button>`}</div>
      ${preview ? `<div class="bd-prev">${c.desc ? md(c.desc, { roles: office().roles || [], cardIds, taskIndex: false }) : '<p class="hint">Belum ada deskripsi.</p>'}</div>`
        : `<textarea id="cdDesc" rows="5" placeholder="Apa yang harus dikerjakan, batasan, catatan. Markdown boleh.">${esc(c.desc)}</textarea>`}</section>`;
  if (isNew) {
    return `<div class="dr-head" style="align-items:flex-start"><div class="dr-id"><div class="kc-row1">${chipsHTML(c)}</div>
        <input class="cd-title" id="cdTitle" value="${esc(c.title)}" placeholder="Judul kartu" aria-label="Judul kartu" autocomplete="off"></div>
        <button class="icon-btn" data-act="close-drawer" aria-label="Tutup panel">✕</button></div>
      <div class="dr-body">${fieldsHTML(c)}${lbls}${desc}
        <div class="btn-row"><button class="btn primary" data-act="bd-create">Buat kartu</button><button class="btn" data-act="close-drawer">Batal</button></div></div>`;
  }
  const children = c.epic ? `<section class="dr-sec"><h3>Sub-kartu (${(c.children || []).filter(k => k.done).length}/${(c.children || []).length} selesai)</h3>
      <ul class="checklist">${(c.children || []).map(k => `<li class="${k.done ? 'done' : ''}"><span><a href="#" data-act="bd-open" data-id="${esc(k.id)}">${esc(k.title)}</a> <span class="hint">· ${esc(repoName(k.repo))} · ${esc(k.colName || '')}${k.who ? ' · ' + esc(whoName(k.who)) : ''}</span></span></li>`).join('') || '<li><span class="hint">Belum ada sub-kartu.</span></li>'}</ul></section>` : '';
  const checklist = `<section class="dr-sec"><h3>Checklist (${ck.filter(x => x.done).length}/${ck.length})</h3>
      <ul class="checklist">${ck.map((it, i) => `<li class="${it.done ? 'done' : ''}"><input type="checkbox" id="ck${it.id}" data-ck="${it.id}" ${it.done ? 'checked' : ''}><label for="ck${it.id}" style="font-weight:400;font-size:14px"><span>${esc(it.text)}</span></label>
        <span class="bd-ckbtn"><button class="x" data-act="bd-ckmv" data-i="${i}" data-d="-1" aria-label="Naikkan item" ${i === 0 ? 'disabled' : ''}>↑</button><button class="x" data-act="bd-ckmv" data-i="${i}" data-d="1" aria-label="Turunkan item" ${i === ck.length - 1 ? 'disabled' : ''}>↓</button><button class="x" data-act="bd-ckdel" data-ck="${it.id}" aria-label="Hapus item">✕</button></span></li>`).join('')}</ul>
      <form class="inline-form" data-form="ck" style="margin-top:6px"><input id="ckInput" placeholder="Tambah item checklist" autocomplete="off"><button class="btn sm" type="submit">Tambah</button></form>
      ${unchecked ? `<div class="btn-row" style="margin-top:8px"><button class="btn sm" data-act="bd-split">Pecah jadi sub-kartu</button><span class="hint">${unchecked} item belum dicentang jadi kartu sendiri</span></div>` : ''}</section>`;
  const thread = (c.comments || []).map(m => {
    const r = roleByAny(m.who), you = /^(kamu|you)$/i.test(m.who);
    return `<li><span>${r ? mini(r) : ''}</span><div><div class="meta"><b>${esc(you ? 'Kamu' : r ? r.name : m.who)}</b> · ${esc(ago(m.at))}</div><div class="bd-msg">${esc(m.text)}</div></div></li>`;
  }).join('') || '<li><span></span><span class="hint">Belum ada komentar.</span></li>';
  const links = (c.links || []).length ? `<section class="dr-sec"><h3>Terkait</h3><ul class="hist">${c.links.map(l => `<li><span>${esc(l.kind)}</span><span>${/^https?:\/\//.test(l.value) ? `<a href="${esc(l.value)}" target="_blank" rel="noreferrer">${esc(short(l.value, 60))}</a>` : `<code>${esc(l.value)}</code>`}</span></li>`).join('')}</ul></section>` : '';
  const hist = `<section class="dr-sec"><h3>Riwayat</h3><ul class="hist">${(c.history || []).slice(0, 15).map(h => `<li><span>${esc(ago(h.at))}</span><span><b>${esc(h.who)}</b> ${esc(h.text)}</span></li>`).join('') || '<li><span></span><span>Belum ada.</span></li>'}</ul></section>`;
  const cov = c.cover && (c.coverUrl || (c.attachments || []).some(a => a.id === c.cover)) ? `<div class="bd-cover"><img src="${esc(c.coverUrl || mediaUrl(c.cover))}" alt="Sampul kartu"></div>` : '';
  return `${cov}<div class="dr-head" style="align-items:flex-start"><div class="dr-id"><div class="kc-row1 bd-chips">${chipsHTML(c)}</div>
      <input class="cd-title" id="cdTitle" data-f="title" value="${esc(c.title)}" aria-label="Judul kartu" autocomplete="off"></div>
      <button class="icon-btn" data-act="close-drawer" aria-label="Tutup panel">✕</button></div>
    <div class="dr-body">
      <div class="bd-livebox">${liveHTML(c)}</div>
      ${fieldsHTML(c)}${progressHTML(c)}${blockBox}${lbls}${desc}${c.epic ? children : ''}${depsHTML(c)}${attHTML(c)}${checklist}
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
  if (S.dr.depQ) renderDepResults();
  if (focusSel) $(focusSel, d)?.focus();
}

async function savePatch(body) {
  const dr = S.dr; if (!dr?.id) return;
  try {
    const card = await patch(`${base()}/cards/${dr.id}`, body);
    if (S.dr === dr && card && card.id) {
      dr.card = { ...dr.card, ...card };
      const chips = $('.bd-chips', drawerEl()); if (chips) chips.innerHTML = chipsHTML(dr.card);
    }
    return card;
  } catch (e) { toast(e.message, 'bad'); reloadCard(); }
}
const saveDesc = debounce(() => {
  const t = $('#cdDesc', drawerEl()); if (!t || !S.dr?.id) return;
  S.dr.card.desc = t.value;
  savePatch({ desc: t.value });
}, 700);

function readNew() {
  const d = drawerEl(), v = id => $(id, d)?.value ?? '', c = S.dr.card;
  const est = v('#cdEst');
  return { board: v('#cdBoard') || c.board || undefined, publishAt: v('#cdPub'), title: v('#cdTitle').trim(), desc: v('#cdDesc'), col: Number(v('#cdCol')), who: v('#cdWho') || null, repo: v('#cdRepo'), prio: v('#cdPrio'), due: v('#cdDue'), start: v('#cdStart'), estDays: est === '' ? undefined : Number(est), epicId: v('#cdEpic') || undefined, labels: c.labels || [] };
}

/* ---------------- dependensi ---------------- */
function renderDepResults() {
  const box = $('#depRes', drawerEl()); if (!box || !S.dr?.card) return;
  const q = (S.dr.depQ || '').trim().toLowerCase(), c = S.dr.card;
  if (!q) { box.innerHTML = ''; return; }
  const have = new Set((c.deps || []).map(d => d.id));
  const hits = (S.all.length ? S.all : S.cards).filter(x => x.id !== c.id && !have.has(x.id) && (x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))).slice(0, 7);
  box.innerHTML = hits.map(x => `<li><button type="button" data-act="bd-depadd" data-id="${esc(x.id)}"><span>${esc(short(x.title, 50))}</span><span class="hint">${esc(x.colName || '')}${x.board !== c.board ? ' · ' + esc(boardOf(x.board)?.name || x.board) : ''}${x.who ? ' · ' + esc(whoName(x.who)) : ''}</span></button></li>`).join('') || '<li class="hint" style="padding:6px 10px">Tidak ada kartu yang cocok.</li>';
}
async function setDeps(ids) {
  const dr = S.dr; if (!dr?.id) return;
  try { await patch(`${base()}/cards/${dr.id}`, { deps: ids }); dr.depQ = ''; await reloadCard(); hooks.refetch(); } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- lampiran ---------------- */
async function uploadFiles(files) {
  const dr = S.dr; files = [...files]; if (!dr?.id || !files.length) return;
  dr.uploading = files.length; showDr();
  for (const f of files) {
    try {
      const res = await fetch(`${base()}/media?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, credentials: 'same-origin' });
      let m = null; try { m = await res.json(); } catch {}
      if (!res.ok || !m?.id) throw new Error(m?.error || `Gagal unggah (${res.status})`);
      await post(`${base()}/cards/${dr.id}/attach`, { media: m.id });
    } catch (e) { toast(`${short(f.name, 30)}: ${e.message}`, 'bad'); }
    dr.uploading--;
  }
  dr.uploading = 0;
  if (S.dr === dr) { await reloadCard(); hooks.refetch(); }
}

/* ---------------- sampul dari pratinjau ---------------- */
async function coverFromPratinjau() {
  const dr = S.dr; if (!dr?.id) return;
  let items = [];
  try { items = await api(`${base()}/pratinjau?limit=40`); items = Array.isArray(items) ? items : items.items || []; } catch (e) { toast(e.message, 'bad'); return; }
  const imgs = it => (it.files || []).filter(f => f.thumb);
  const linked = items.filter(it => it.card === dr.id && imgs(it).length), other = items.filter(it => it.card !== dr.id && imgs(it).length).slice(0, 12);
  const grid = list => list.map(it => `<div class="bd-pvc"><p class="hint">${esc(short(it.title, 50))} · v${it.version}</p><div class="bd-pvg">${imgs(it).map(f => `<button type="button" class="bd-thumb" data-pvc="pv:${esc(it.id)}:${esc(f.id)}" aria-label="Jadikan ${esc(f.name)} sampul"><img src="${esc(f.thumb)}" alt="" loading="lazy"></button>`).join('')}</div></div>`).join('');
  modal({ title: 'Sampul dari pratinjau', html: `<div class="bd-pvpick">${linked.length ? `<h3>Pratinjau kartu ini</h3>${grid(linked)}` : '<p class="hint">Belum ada pratinjau bergambar yang terkait kartu ini.</p>'}${other.length ? `<h3>Pratinjau lain</h3>${grid(other)}` : ''}</div>`, actions: [{ label: 'Batal' }] });
  const mc = $('#modalCard');
  mc.querySelectorAll('[data-pvc]').forEach(b => b.addEventListener('click', async () => {
    $('#modal').hidden = true;
    if (S.dr !== dr) return;
    await savePatch({ cover: b.dataset.pvc }); await reloadCard(); hooks.refetch();
  }));
}

/* ---------------- checklist ---------------- */
async function moveCheck(i, dir) {
  const dr = S.dr, ck = [...(dr.card.checklist || [])], j = i + dir;
  if (j < 0 || j >= ck.length) return;
  [ck[i], ck[j]] = [ck[j], ck[i]];
  await post(`${base()}/cards/${dr.id}/checks-order`, { order: ck.map(it => it.id) });
  await reloadCard(); hooks.refetch();
}

/* ---------------- event drawer ---------------- */
function bindDrawer(d) {
  if (d._bd) return;
  d._bd = true;
  const click = async e => {
    const t = e.target.closest('[data-act]'); if (!t || !S.dr) return;
    const a = t.dataset.act, dr = S.dr;
    try {
      if (a === 'bd-open') { e.preventDefault(); openCard(t.dataset.id); }
      else if (a === 'bd-clr') {
        const inp = $('#' + t.dataset.for, d); inp.value = '';
        const f = inp.dataset.f; dr.card[f] = ''; if (dr.id) savePatch({ [f]: '' });
      }
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
        showDr(); hooks.refetch();
      }
      else if (a === 'bd-lbl') {
        const id = t.dataset.id, cur = new Set(dr.card.labels || []);
        cur.has(id) ? cur.delete(id) : cur.add(id);
        dr.card.labels = [...cur];
        t.setAttribute('aria-pressed', String(cur.has(id)));
        if (dr.id) await savePatch({ labels: dr.card.labels });
      }
      else if (a === 'bd-lblmgr') openLabelManager();
      else if (a === 'bd-depdel') await setDeps((dr.card.deps || []).map(x => x.id).filter(x => x !== t.dataset.id));
      else if (a === 'bd-depadd') await setDeps([...(dr.card.deps || []).map(x => x.id), t.dataset.id]);
      else if (a === 'bd-pickfile') $('#bdFile', d)?.click();
      else if (a === 'bd-cover-pv') coverFromPratinjau();
      else if (a === 'bd-cover-off') { await savePatch({ cover: null }); showDr(); hooks.refetch(); }
      else if (a === 'bd-cover') { await savePatch({ cover: dr.card.cover === t.dataset.id ? null : t.dataset.id }); showDr(); hooks.refetch(); }
      else if (a === 'bd-attdel') { await del(`${base()}/cards/${dr.id}/attach/${t.dataset.id}`); await reloadCard(); hooks.refetch(); }
      else if (a === 'bd-ckdel') { await post(`${base()}/cards/${dr.id}/check`, { itemId: t.dataset.ck, remove: true }); await reloadCard(); hooks.refetch(); }
      else if (a === 'bd-ckmv') await moveCheck(Number(t.dataset.i), Number(t.dataset.d));
      else if (a === 'bd-split') {
        confirmDo('Pecah jadi sub-kartu', 'Item checklist yang belum dicentang jadi kartu sendiri, dan kartu ini menjadi epic.', 'Pecah', async () => {
          try { await post(`${base()}/cards/${dr.id}/split`, {}); toast('Dipecah jadi sub-kartu', 'ok'); await reloadCard(); hooks.refetch(); } catch (err) { toast(err.message, 'bad'); }
        }, 'primary');
      }
      else if (a === 'bd-shift') { const c = dr.card; closeDrawer(); startShiftDialog(S.ctx, c.who, { cardId: c.id }); }
      else if (a === 'bd-delete') {
        const c = dr.card;
        confirmDo('Hapus kartu', `Kartu "${esc(short(c.title, 60))}"${c.epic ? ' beserta sub-kartunya' : ''} akan dihapus dari board.`, 'Hapus', async () => {
          try { await del(`${base()}/cards/${c.id}`); closeDrawer(); toast('Kartu dihapus', 'ok'); hooks.refetch(); } catch (err) { toast(err.message, 'bad'); }
        });
      }
    } catch (err) { toast(err.message, 'bad'); }
  };
  const change = async e => {
    const t = e.target, dr = S.dr; if (!dr) return;
    if (t.id === 'bdFile') { uploadFiles(t.files); t.value = ''; return; }
    if (t.dataset.ck) {
      try { await post(`${base()}/cards/${dr.id}/check`, { itemId: t.dataset.ck, done: t.checked }); await reloadCard(); hooks.refetch(); } catch (err) { toast(err.message, 'bad'); reloadCard(); }
      return;
    }
    if (t.id === 'cmNotify') { dr.notify = t.checked; return; }
    if (t.id === 'cdAuto') {
      const v = t.checked ? null : Number($('#cdProg', d).value);
      dr.card.progress = v; await savePatch({ progress: v }); showDr(); hooks.refetch(); return;
    }
    if (t.id === 'cdProg') { dr.card.progress = Number(t.value); savePatch({ progress: Number(t.value) }); return; }
    if (t.id === 'cdBlk') {
      if (t.checked) { dr.blockedOpen = true; showDr('#cdBlkWhy'); }
      else { dr.blockedOpen = false; dr.card.blocked = ''; if (dr.id) { await savePatch({ blocked: '' }); } showDr(); hooks.refetch(); }
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
    if (f === 'board') {
      dr.card.board = v;
      if (!dr.id) { const b = boardOf(v); dr.card.col = 0; dr.card.colName = b?.columns[0]?.name; showDr('#cdBoard'); return; }
      await savePatch({ board: v }); await reloadCard('#cdBoard'); hooks.refetch(); return;
    }
    if (f === 'who') v = v || null;
    if (f === 'title' && !v.trim()) { t.value = dr.card.title; return; }
    if (f === 'epicId') v = v || '';
    if (f === 'estDays') v = v === '' ? null : Math.max(0, Number(v));
    if (f === 'milestone') v = t.checked;
    dr.card[f] = v;
    if (dr.id) { await savePatch({ [f]: v }); if (['start', 'due', 'milestone', 'col', 'publishAt'].includes(f)) hooks.refetch(); }
  };
  const input = e => {
    if (e.target.id === 'cdDesc' && S.dr?.id) saveDesc();
    if (e.target.id === 'cmInput' && S.dr) S.dr.comment = e.target.value;
    if (e.target.id === 'cdProg') { const v = $('#cdProgV', d); if (v) v.textContent = e.target.value + '%'; }
    if (e.target.id === 'depQ' && S.dr) { S.dr.depQ = e.target.value; renderDepResults(); }
  };
  const submit = async e => {
    const f = e.target.closest('form[data-form]'); if (!f || !S.dr?.id) return;
    e.preventDefault();
    const dr = S.dr;
    try {
      if (f.dataset.form === 'ck') {
        const v = $('#ckInput', d).value.trim(); if (!v) return;
        await post(`${base()}/cards/${dr.id}/check`, { text: v });
        await reloadCard('#ckInput'); hooks.refetch();
      } else {
        const v = $('#cmInput', d).value.trim(); if (!v) return;
        await post(`${base()}/cards/${dr.id}/comment`, { text: v, notify: !!($('#cmNotify', d)?.checked && dr.card.who) });
        dr.comment = '';
        await reloadCard('#cmInput'); hooks.refetch();
      }
    } catch (err) { toast(err.message, 'bad'); }
  };
  const focusout = e => {
    if (e.target.id === 'cdDesc' && S.dr?.id && e.target.value !== S.dr.card.desc) { S.dr.card.desc = e.target.value; savePatch({ desc: e.target.value }); }
    if (!S.dr?.pending) return;
    setTimeout(() => { if (S.dr?.pending && !inField()) { S.dr.pending = false; reloadCard(); } }, 200);
  };
  const keydown = e => {
    if (e.key === 'Enter' && e.target.matches('#cdTitle,#cdBlkWhy') && S.dr?.id) e.target.blur();
    if (e.key === 'Enter' && e.target.id === 'cdTitle' && !S.dr?.id) { e.preventDefault(); $('[data-act="bd-create"]', d)?.click(); }
  };
  const mdclick = e => { const a = e.target.closest('a[data-card]'); if (a) { e.preventDefault(); openCard(a.dataset.card); } };
  const dropZone = on => e => {
    const z = e.target.closest?.('#bdDrop'); if (!z || !S.dr?.id) return;
    if (!(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault(); z.classList.toggle('over', on);
  };
  const dropFiles = e => {
    const z = e.target.closest?.('#bdDrop'); if (!z || !S.dr?.id) return;
    e.preventDefault(); z.classList.remove('over');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  };
  const list = [['click', click], ['click', mdclick], ['change', change], ['input', input], ['submit', submit], ['focusout', focusout], ['keydown', keydown], ['dragover', dropZone(true)], ['dragleave', dropZone(false)], ['drop', dropFiles]];
  list.forEach(([n, f]) => d.addEventListener(n, f));
  handlers = { d, list };
}
export function unbindDetail() {
  if (handlers) { handlers.list.forEach(([n, f]) => handlers.d.removeEventListener(n, f)); handlers.d._bd = false; }
  handlers = null;
}

/* ---------------- pengelola label ---------------- */
const lmRows = () => S.labels.map(l => {
  const n = S.cards.filter(c => (c.labels || []).includes(l.id)).length;
  return `<li data-id="${esc(l.id)}"><input type="color" value="${esc(l.color)}" data-lm="color" aria-label="Warna ${esc(l.name)}"><input type="text" value="${esc(l.name)}" maxlength="40" data-lm="name" aria-label="Nama label"><span class="hint">${n} kartu</span><button type="button" class="btn sm danger" data-lm="del">Hapus</button></li>`;
}).join('') || '<li class="hint">Belum ada label.</li>';
const lmHTML = () => `<div class="lm"><ul class="lm-list">${lmRows()}</ul>
    <form class="lm-new" data-lm-form><input type="color" id="lmColor" value="#4F79B8" aria-label="Warna label baru"><input type="text" id="lmName" maxlength="40" placeholder="Nama label baru" aria-label="Nama label baru" autocomplete="off"><button class="btn sm primary" type="submit">Tambah</button></form></div>`;
async function lmReload() {
  try { S.labels = await api(`${base()}/labels`); } catch (e) { toast(e.message, 'bad'); }
  const ul = $('#modalCard .lm-list'); if (ul) ul.innerHTML = lmRows();
  hooks.renderMain(); if (S.dr) { const b = $('#bdLbls', drawerEl()); if (b) b.innerHTML = lblPicks(S.dr.card); }
  hooks.refetch();
}
export function openLabelManager() {
  modal({ title: 'Kelola label', html: lmHTML(), actions: [{ label: 'Selesai' }] });
  const mc = $('#modalCard');
  if (mc._lm) return;
  mc._lm = true;
  mc.addEventListener('change', async e => {
    const t = e.target.closest('[data-lm]'); const li = t?.closest('li[data-id]'); if (!li || !['name', 'color'].includes(t.dataset.lm)) return;
    const l = labelOf(li.dataset.id); if (!l) return;
    const name = $('[data-lm=name]', li).value.trim() || l.name, color = $('[data-lm=color]', li).value;
    try { await post(`${base()}/labels`, { id: l.id, name, color }); await lmReload(); } catch (err) { toast(err.message, 'bad'); }
  });
  mc.addEventListener('click', async e => {
    const t = e.target.closest('[data-lm=del]'); if (!t) return;
    if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Yakin hapus?'; setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = 'Hapus'; } }, 3000); return; }
    try { await del(`${base()}/labels/${t.closest('li').dataset.id}`); await lmReload(); } catch (err) { toast(err.message, 'bad'); }
  });
  mc.addEventListener('submit', async e => {
    if (!e.target.matches('[data-lm-form]')) return;
    e.preventDefault();
    const name = $('#lmName', mc).value.trim(); if (!name) return;
    try { await post(`${base()}/labels`, { name, color: $('#lmColor', mc).value }); await lmReload(); const i = $('#lmName', mc); if (i) { i.value = ''; i.focus(); } } catch (err) { toast(err.message, 'bad'); }
  });
}
