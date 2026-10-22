// Tab Board: kanban lengkap (filter, swimlane, label, WIP, multi-pilih, keyboard) + daftar + drawer kartu.
// Data dari API sungguhan, realtime lewat live(). Drawer ada di board-detail.js, fungsi murni di board-lib.js.
import { $, $$, esc, short, ago, api, post, patch, del, toast, confirmDo, modal, mini, ICON, debounce } from './util.js';
import { drawerState } from './panel.js';
import {
  PRIOS, GROUPS, isDate, fmtDay, dueState, pendingDeps, progressOf, midOrd, matchCard, activeCount,
  loadPrefs, savePrefs, loadWip, saveWip, defaultPrefs, parseQuick, todayStr,
} from './board-lib.js';
import {
  S, hooks, office, base, roles, roleOf, rooms, repoName, whoName, prioVar, epics, kids, isLive, liveHTML, repoChoices,
  labelOf, labelName, labelChip, mediaUrl,
  KINDS, KIND_LABEL, isAll, boardOf, curBoard, viewCols, colOf, colVal, boardChip, loadBoardSel, saveBoardSel,
} from './board-state.js';
import { openCard, openNew, reloadCard, refreshDrawer, closeDetail, updateLiveBox, unbindDetail, drawerOwned, openLabelManager } from './board-detail.js';

let rootH = null, docH = null;
const persist = () => { S.f.collapsedB = { ...(S.f.collapsedB || {}), [S.board]: S.f.collapsed }; savePrefs(S.oid, S.f); };
const COLN = () => viewCols().map(c => c.name);
const wipKey = () => (S.board === 'utama' ? S.oid : `${S.oid}.${S.board}`);
const ctxF = () => ({ map: S.map, labelName, today: todayStr() });
const filtered = () => { const x = ctxF(); return S.cards.filter(c => !c.epic && matchCard(c, S.f, x)); };
const byOrd = (a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.createdAt?.localeCompare?.(b.createdAt) || 0;
const colCards = col => S.cards.filter(c => !c.epic && colOf(c) === col).sort(byOrd);
const visibleSel = () => [...S.sel].filter(id => S.map.has(id));
const FILTER_QUICK = [['mine', 'Kartu saya'], ['unassigned', 'Belum ditugaskan'], ['blocked', 'Terblokir'], ['waiting', 'Menunggu kartu lain'], ['hideOld', 'Sembunyikan Selesai lama']];
const DUE_OPTS = [['overdue', 'Terlambat'], ['week', 'Pekan ini'], ['none', 'Tanpa tenggat']];

/* ---------------- kerangka + kontrol ---------------- */
function shellHTML() {
  const f = S.f;
  return `<div class="bd-boards" id="bdBoards" role="toolbar" aria-label="Papan"></div><div class="bd-toolbar">
      <input type="search" id="bdQ" placeholder="Cari kartu  ( / )" value="${esc(f.q)}" aria-label="Cari kartu" autocomplete="off">
      <button type="button" class="btn" id="bdFpBtn" data-act="bd-fp" aria-expanded="false" aria-controls="bdFp">Filter<span class="bd-badge" id="bdBadge" hidden></span></button>
      <label class="sr-only" for="bdGroup">Kelompokkan berdasarkan</label>
      <select id="bdGroup" aria-label="Kelompokkan berdasarkan">${GROUPS.map(([k, v]) => `<option value="${k}" ${f.group === k ? 'selected' : ''}>${k === 'none' ? 'Kelompok: tidak ada' : 'Kelompok: ' + v.toLowerCase()}</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="Tampilan">${[['kanban', 'Kanban'], ['list', 'Daftar']].map(([k, v]) => `<button type="button" data-act="bd-view" data-v="${k}" aria-pressed="${f.view === k}">${v}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Kerapatan kartu">${[['comfort', 'Nyaman'], ['compact', 'Ringkas']].map(([k, v]) => `<button type="button" data-act="bd-dens" data-v="${k}" aria-pressed="${f.density === k}">${v}</button>`).join('')}</div>
      <button type="button" class="btn" data-act="bd-selmode" id="bdSelBtn" aria-pressed="${S.selMode}">Pilih</button>
      <button type="button" class="btn" data-act="bd-lblmgr">Label</button>
      <button type="button" class="btn ghost bd-help" data-act="bd-help" aria-label="Pintasan keyboard" title="Pintasan keyboard (?)">?</button>
      <button type="button" class="btn primary bd-new" data-act="bd-new">Kartu baru</button>
    </div>
    <div class="bd-qk" id="bdQk" role="group" aria-label="Filter cepat"></div>
    <div class="bd-active" id="bdActive" aria-live="polite"></div>
    <div class="bd-fp" id="bdFp" hidden></div>
    <div class="epics" id="bdEpics"></div><div id="bdMain"></div><div id="bdBulk"></div>`;
}

const fbtn = (k, v, text, on, extra = '') => `<button type="button" class="chip" data-act="bd-f" data-k="${k}" data-v="${esc(v)}" aria-pressed="${on}">${extra}${text}</button>`;
function renderControls() { keepFocus(renderControls0); }
function keepFocus(fn) {
  const a = document.activeElement; let sel = null;
  if (a && S.el?.contains(a) && !a.closest('#bdMain,.bd-menu,#bdBulk')) {
    const q = v => String(v).replace(/["\\]/g, '\\$&');
    sel = a.id ? '#' + a.id : a.dataset.act ? `[data-act="${a.dataset.act}"]` + (a.dataset.k ? `[data-k="${q(a.dataset.k)}"]` : '') + (a.dataset.v ? `[data-v="${q(a.dataset.v)}"]` : '') : null;
  }
  fn();
  if (sel) { try { $(sel, S.el)?.focus(); } catch {} }
}
function renderControls0() {
  const f = S.f, n = activeCount(f);
  const badge = $('#bdBadge', S.el); if (badge) { badge.hidden = !n; badge.textContent = n; }
  const qk = $('#bdQk', S.el);
  if (qk) qk.innerHTML = FILTER_QUICK.map(([k, v]) => `<button type="button" class="chip" data-act="bd-q" data-k="${k}" aria-pressed="${!!f[k]}">${v}</button>`).join('');
  // chip filter aktif
  const act = [];
  const chip = (k, v, text) => act.push(`<span class="chip bd-ac">${text}<button type="button" data-act="bd-rm" data-k="${k}" data-v="${esc(v)}" aria-label="Hapus filter ${esc(String(text).replace(/<[^>]*>/g, ''))}">✕</button></span>`);
  if (f.q.trim()) chip('q', '', `Cari: ${esc(short(f.q.trim(), 24))}`);
  f.who.forEach(v => chip('who', v, `Role: ${esc(v === '_none' ? 'belum ditugaskan' : whoName(v))}`));
  f.labels.forEach(v => { if (labelOf(v)) chip('labels', v, `Label: ${esc(labelName(v))}`); });
  f.prios.forEach(v => chip('prios', v, `Prioritas: ${esc(v)}`));
  f.repos.forEach(v => chip('repos', v, `Repo: ${esc(v === '_none' ? 'tanpa repo' : repoName(v))}`));
  if (f.due) chip('due', f.due, `Tenggat: ${esc(DUE_OPTS.find(x => x[0] === f.due)?.[1].toLowerCase() || '')}`);
  FILTER_QUICK.forEach(([k, v]) => { if (f[k]) chip(k, '', esc(v)); });
  const box = $('#bdActive', S.el);
  if (box) box.innerHTML = act.length ? `${act.join('')}<button type="button" class="btn sm ghost" data-act="bd-clear">Bersihkan semua</button>` : '';
  const btn = $('#bdFpBtn', S.el), fp = $('#bdFp', S.el);
  if (btn) btn.setAttribute('aria-expanded', String(S.fp));
  if (fp) {
    fp.hidden = !S.fp;
    if (S.fp) {
      const has = (k, v) => f[k].includes(v);
      fp.innerHTML = `<div class="bd-fg"><h4>Role</h4><div class="chips">${roles().map(r => fbtn('who', r.id, esc(r.name), has('who', r.id), mini(r))).join('')}${fbtn('who', '_none', 'Belum ditugaskan', has('who', '_none'))}</div></div>
        <div class="bd-fg"><h4>Label</h4><div class="chips">${S.labels.map(l => `<button type="button" class="lbl pick" data-act="bd-f" data-k="labels" data-v="${esc(l.id)}" aria-pressed="${has('labels', l.id)}" style="--lc:${esc(l.color)}">${esc(l.name)}</button>`).join('') || '<span class="hint">Belum ada label.</span>'}</div></div>
        <div class="bd-fg"><h4>Prioritas</h4><div class="chips">${PRIOS.map(p => fbtn('prios', p, p, has('prios', p))).join('')}</div></div>
        <div class="bd-fg"><h4>Repo / ruang</h4><div class="chips">${repoChoices().map(([id, nm]) => fbtn('repos', id, esc(nm), has('repos', id))).join('')}${fbtn('repos', '_none', 'Tanpa repo', has('repos', '_none'))}</div></div>
        <div class="bd-fg"><h4>Tenggat</h4><div class="chips">${DUE_OPTS.map(([k, v]) => fbtn('due', k, v, f.due === k)).join('')}</div></div>
        <div class="bd-fg"><h4>Saya adalah</h4><select id="bdMe" aria-label="Role yang dianggap saya"><option value="">(belum dipilih)</option>${roles().map(r => `<option value="${esc(r.id)}" ${f.me === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select><span class="hint">dipakai oleh filter Kartu saya</span></div>`;
    }
  }
}

/* ---------------- papan: pemilih, buat, pengaturan ---------------- */
function boardPrefs() {
  const cb = S.f.collapsedB || {};
  S.f.collapsed = cb[S.board] || (S.board === 'utama' ? S.f.collapsed : []);
  S.wip = loadWip(wipKey(), S.board === 'utama' ? null : viewCols());
}
function switchBoard(id) {
  if (id === S.board) return;
  S.board = id; saveBoardSel(S.oid, id);
  S.sel.clear(); S.qa = null; S.seen = new Map();
  S.cards = isAll() ? S.all : S.all.filter(c => (c.board || 'utama') === id);
  S.seen = new Map(S.cards.map(c => [c.id, c.updatedAt]));
  boardPrefs(); closeMenu(false); paint();
}
function renderBoards() {
  const box = $('#bdBoards', S.el); if (!box) return;
  const list = S.boards.filter(b => !b.archived);
  const n = id => S.all.filter(c => !c.epic && !c.done && (id === 'all' || (c.board || 'utama') === id)).length;
  const pill = (id, name, color, icon) => `<button type="button" class="bd-pill${S.board === id ? ' on' : ''}" data-act="bd-board" data-id="${esc(id)}" aria-pressed="${S.board === id}" style="--bc:${esc(color || 'var(--b6)')}">${icon ? `<span aria-hidden="true">${esc(icon)}</span>` : '<i class="dot"></i>'}<span>${esc(name)}</span><span class="count" aria-label="${n(id)} kartu terbuka">${n(id)}</span></button>`;
  const b = curBoard();
  box.innerHTML = list.map(x => pill(x.id, x.name, x.color, x.icon)).join('') + (list.length > 1 ? pill('all', 'Semua papan', '', '∑') : '')
    + `<button type="button" class="btn sm ghost" data-act="bd-board-new" title="Buat papan baru">+ Papan</button>`
    + (b ? `<button type="button" class="btn sm ghost" data-act="bd-board-set" title="Pengaturan papan ${esc(b.name)}" aria-label="Pengaturan papan ${esc(b.name)}">⚙ Atur papan</button>` : '');
}
const BOARD_COLORS = ['#2F5D9E', '#C2417A', '#3E9A5B', '#D98A1E', '#7A3E9D', '#2F7F86', '#D2553F', '#8B818B'];
const creativeRooms = () => rooms().filter(r => /kreatif|creative|desain|design|konten|content/i.test(`${r.id} ${r.name}`)).map(r => r.id);
async function newBoardDialog(tpl0 = 'kreatif') {
  let tpls = [];
  try { tpls = (await api(`${base()}/boards`)).templates || []; } catch {}
  const used = new Set(S.boards.filter(b => !b.archived).map(b => b.name.toLowerCase()));
  const pick = tpls.find(t => t.id === tpl0 && !used.has(t.name.toLowerCase())) ? tpl0 : 'dev';
  const tplHTML = tpls.map(t => `<label class="bd-tpl"><input type="radio" name="bdTpl" value="${esc(t.id)}" ${t.id === pick ? 'checked' : ''}><b>${esc(t.icon || '')} ${esc(t.name)}</b><span class="hint">${t.columns.map(c => esc(c.name)).join(' → ')}</span></label>`).join('')
    + `<label class="bd-tpl"><input type="radio" name="bdTpl" value="kosong"><b>Kosong</b><span class="hint">Antre → Dikerjakan → Selesai, atur sendiri</span></label>`;
  const cr = creativeRooms();
  modal({
    title: 'Papan baru',
    body: 'Satu kantor bisa punya beberapa papan, mis. papan Kreatif untuk tim konten terpisah dari papan dev. Kolom bisa diubah kapan saja lewat Atur papan.',
    html: `<div class="bd-nb"><div class="bd-tpls" role="radiogroup" aria-label="Template">${tplHTML}</div>
      <label for="bdNbName">Nama papan</label><input id="bdNbName" maxlength="40" placeholder="${esc(tpls.find(t => t.id === pick)?.name || 'Papan')}" autocomplete="off">
      ${cr.length ? `<label class="bd-check"><input type="checkbox" id="bdNbRooms" ${pick === 'kreatif' ? 'checked' : ''}> Jadikan papan bawaan untuk agen di ${cr.map(id => esc(rooms().find(r => r.id === id)?.name || id)).join(', ')}</label>` : ''}</div>`,
    actions: [{ label: 'Buat papan', kind: 'primary', fn: () => {
      const t = $('input[name=bdTpl]:checked', $('#modalCard'))?.value || 'dev';
      const tp = tpls.find(x => x.id === t);
      const name = $('#bdNbName').value.trim() || tp?.name || 'Papan baru';
      const body = { name, template: t === 'kosong' ? undefined : t, color: tp?.color || BOARD_COLORS[S.boards.length % BOARD_COLORS.length] };
      if (t === 'kosong') body.columns = [{ name: 'Antre', kind: 'antre' }, { name: 'Dikerjakan', kind: 'dikerjakan' }, { name: 'Selesai', kind: 'selesai' }];
      if ($('#bdNbRooms')?.checked) body.rooms = cr;
      post(`${base()}/boards`, body).then(async b => { toast(`Papan ${b.name} dibuat`, 'ok'); S.board = b.id; saveBoardSel(S.oid, b.id); await refetch(); boardPrefs(); paint(); }).catch(e => toast(e.message, 'bad'));
    } }, { label: 'Batal' }],
  });
}

let BS = null; // draf pengaturan papan
function bsColsHTML() {
  const counts = new Map();
  S.all.filter(c => (c.board || 'utama') === BS.id).forEach(c => { const id = BS.orig[c.col]?.id; if (id) counts.set(id, (counts.get(id) || 0) + 1); });
  const live = BS.columns.filter(c => !c.gone);
  const rows = BS.columns.map((c, i) => {
    if (c.gone) {
      const n = counts.get(c.id) || 0;
      return n ? `<li class="bs-gone"><span>${esc(c.name)} dihapus. Pindahkan ${n} kartu ke</span><select data-bs="move" data-i="${i}" aria-label="Kolom tujuan kartu dari ${esc(c.name)}">${live.map(x => `<option value="${esc(x.id || x.name)}" ${BS.moveTo[c.id] === (x.id || x.name) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><button type="button" class="btn sm ghost" data-bs="undo" data-i="${i}">Batal hapus</button></li>` : '';
    }
    const n = c.id ? counts.get(c.id) || 0 : 0;
    return `<li><input data-bs="name" data-i="${i}" value="${esc(c.name)}" maxlength="40" aria-label="Nama kolom ${i + 1}">
      <select data-bs="kind" data-i="${i}" aria-label="Jenis kolom ${esc(c.name)}">${KINDS.map(k => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
      <span class="hint">${n} kartu</span>
      <button type="button" class="x" data-bs="up" data-i="${i}" aria-label="Geser ${esc(c.name)} ke kiri">↑</button><button type="button" class="x" data-bs="down" data-i="${i}" aria-label="Geser ${esc(c.name)} ke kanan">↓</button>
      <button type="button" class="x" data-bs="del" data-i="${i}" aria-label="Hapus kolom ${esc(c.name)}">✕</button></li>`;
  }).join('');
  return `<ul class="bs-cols">${rows}</ul><button type="button" class="btn sm" data-bs="add">+ Kolom</button>
    <p class="hint">Jenis menentukan arti kolom: <b>Antre</b> (belum mulai), <b>Siap</b>, <b>Dikerjakan</b> (WIP), <b>Review</b>, <b>Selesai</b> (dihitung selesai di metrik, dependensi, kurir). Minimal satu kolom Selesai.</p>`;
}
function boardSettings() {
  const b = curBoard(); if (!b) return;
  BS = { id: b.id, orig: b.columns, columns: b.columns.map(c => ({ ...c })), moveTo: {}, rooms: [...b.rooms], roles: [...b.roles] };
  const roomList = rooms().filter(r => r.path != null || b.rooms.includes(r.id));
  modal({
    title: `Atur papan ${b.name}`,
    html: `<div class="bd-bs">
      <div class="bs-row"><div><label for="bsName">Nama</label><input id="bsName" value="${esc(b.name)}" maxlength="40"></div>
      <div><label for="bsIcon">Ikon</label><input id="bsIcon" value="${esc(b.icon || '')}" maxlength="4" style="width:5em"></div>
      <div><label for="bsColor">Warna</label><input type="color" id="bsColor" value="${esc(b.color)}"></div></div>
      <h3>Kolom</h3><div id="bsCols">${bsColsHTML()}</div>
      <h3>Papan bawaan agen</h3><p class="hint">Agen di ruangan atau dengan role ini memakai papan ini saat tidak menyebut papan (board_list, card_create).</p>
      <div class="chips">${roomList.map(r => `<label class="chip"><input type="checkbox" data-bs="room" value="${esc(r.id)}" ${b.rooms.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('') || '<span class="hint">Belum ada ruangan.</span>'}</div>
      <div class="chips">${roles().map(r => `<label class="chip"><input type="checkbox" data-bs="role" value="${esc(r.id)}" ${b.roles.includes(r.id) ? 'checked' : ''}> ${mini(r)} ${esc(r.name)}</label>`).join('')}</div>
      ${b.isDefault ? '' : '<div class="btn-row"><button type="button" class="btn sm danger" data-bs="archive">Arsipkan papan ini</button><span class="hint">kartunya pindah ke Utama</span></div>'}</div>`,
    actions: [{ label: 'Simpan', kind: 'primary', fn: () => { saveBoardSettings(); return false; } }, { label: 'Batal' }],
  });
  const mc = $('#modalCard');
  if (mc._bs) return;
  mc._bs = true;
  const redraw = () => { const box = $('#bsCols', mc); if (box) box.innerHTML = bsColsHTML(); };
  mc.addEventListener('click', e => {
    const t = e.target.closest('[data-bs]'); if (!t || !BS) return;
    const i = Number(t.dataset.i), k = t.dataset.bs, cs = BS.columns;
    if (k === 'add') { cs.push({ name: `Kolom ${cs.filter(c => !c.gone).length + 1}`, kind: 'dikerjakan' }); redraw(); $$('[data-bs=name]', mc).pop()?.select(); }
    else if (k === 'up' || k === 'down') { const j = i + (k === 'up' ? -1 : 1); if (j >= 0 && j < cs.length) { [cs[i], cs[j]] = [cs[j], cs[i]]; redraw(); } }
    else if (k === 'del') { if (cs[i].id) { cs[i].gone = true; const first = cs.find(c => !c.gone); if (first) BS.moveTo[cs[i].id] = first.id || first.name; } else cs.splice(i, 1); redraw(); }
    else if (k === 'undo') { delete cs[i].gone; delete BS.moveTo[cs[i].id]; redraw(); }
    else if (k === 'archive') {
      const b = curBoard(); if (!b) return;
      if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Yakin arsipkan?'; return; }
      del(`${base()}/boards/${b.id}`).then(async () => { toast(`Papan ${b.name} diarsipkan`, 'ok'); closeModalSafe(); switchBoard('utama'); await refetch(); }).catch(err => toast(err.message, 'bad'));
    }
  });
  const sync = e => {
    const t = e.target.closest('[data-bs]'); if (!t || !BS) return;
    const i = Number(t.dataset.i), k = t.dataset.bs;
    if (k === 'name') BS.columns[i].name = t.value;
    else if (k === 'kind') BS.columns[i].kind = t.value;
    else if (k === 'move') BS.moveTo[BS.columns[i].id] = t.value;
    else if (k === 'room' || k === 'role') { const arr = BS[k + 's']; t.checked ? arr.push(t.value) : arr.splice(arr.indexOf(t.value), 1); }
  };
  mc.addEventListener('input', sync); mc.addEventListener('change', sync);
}
function closeModalSafe() { const m = $('#modal'); if (m) m.hidden = true; }
async function saveBoardSettings() {
  if (!BS) return;
  const mc = $('#modalCard'), live = BS.columns.filter(c => !c.gone);
  // kolom baru belum punya id: server memberinya id dari nama; moveTo ke kolom baru memakai namanya, jadi dipetakan ke id hasil slug
  const slug = v => String(v).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const moveTo = Object.fromEntries(Object.entries(BS.moveTo).map(([k, v]) => [k, live.find(c => c.id === v) ? v : slug(v)]));
  const body = { name: $('#bsName', mc).value, icon: $('#bsIcon', mc).value, color: $('#bsColor', mc).value, rooms: BS.rooms, roles: BS.roles,
    columns: live.map(c => ({ ...(c.id ? { id: c.id } : {}), name: c.name.trim(), kind: c.kind })), moveTo };
  try { await patch(`${base()}/boards/${BS.id}`, body); toast('Papan disimpan', 'ok'); closeModalSafe(); BS = null; await refetch(); boardPrefs(); paint(); }
  catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- epic strip ---------------- */
function renderEpics() {
  const box = $('#bdEpics', S.el); if (!box) return;
  box.innerHTML = epics().map(ep => {
    const ks = kids(ep.id), d = ks.filter(k => k.done).length;
    return `<button class="epic-card" data-act="bd-open" data-id="${esc(ep.id)}">
      <div class="kc-row1"><span class="prio" style="--pc:${prioVar(ep.prio)}">${esc(ep.prio)}</span><span class="epic">Epic · ${esc(ep.colName || '')}</span></div>
      <h4>${esc(ep.title)}</h4>
      ${(ep.labels || []).length ? `<div class="kc-labels">${ep.labels.map(id => labelChip(id)).join('')}</div>` : ''}
      <div class="kc-check"><div class="bar"><i style="width:${ks.length ? Math.round(d / ks.length * 100) : 0}%"></i></div><span>${d}/${ks.length}</span></div>
      <div class="epic-parts">${ks.map(k => `<span class="${k.done ? 'done' : ''}">${esc(repoName(k.repo))}${k.done ? ' selesai' : ''}</span>`).join('')}</div></button>`;
  }).join('');
}

/* ---------------- kartu ---------------- */
function cardHTML(c) {
  const r = c.who && roleOf(c.who), ep = c.epicId && S.map.get(c.epicId);
  const pend = pendingDeps(c, S.map), ds = dueState(c), pg = progressOf(c), sel = S.sel.has(c.id);
  const tot = c.checks?.total || 0, done = c.checks?.done || 0;
  const cls = ['kc', S.flash.has(c.id) && 'flash', sel && 'sel', pend.length && 'waiting', c.blocked && 'blk', c.milestone && 'ms'].filter(Boolean).join(' ');
  const epKids = ep ? kids(ep.id) : [], epDone = epKids.filter(k => k.done).length;
  const dates = c.start && c.due ? `${fmtDay(c.start)} → ${fmtDay(c.due)}` : c.due ? fmtDay(c.due) : c.start ? 'mulai ' + fmtDay(c.start) : '';
  const waitTitle = pend.map(id => S.map.get(id)?.title).filter(Boolean).join(', ');
  const aria = `${c.title}, prioritas ${c.prio}, kolom ${c.colName || ''}${isAll() ? ', papan ' + (c.boardName || c.board) : ''}${r ? ', ' + r.name : ''}`;
  return `<div class="${cls}" draggable="true" tabindex="0" role="group" aria-label="${esc(aria)}" data-card="${esc(c.id)}" style="--pc:${prioVar(c.prio)}">
    <span class="kc-tools"><input type="checkbox" class="kc-cb" ${sel ? 'checked' : ''} aria-label="Pilih kartu ${esc(short(c.title, 30))}"><button type="button" class="kc-mb" data-act="bd-menu" data-id="${esc(c.id)}" aria-haspopup="menu" aria-label="Menu kartu ${esc(short(c.title, 30))}">⋯</button></span>
    ${c.cover ? `<div class="kc-cover"><img src="${esc(c.coverUrl || mediaUrl(c.cover))}" alt="" loading="lazy" draggable="false" onerror="this.parentNode.remove()"></div>` : ''}
    ${(c.labels || []).length ? `<div class="kc-labels">${c.labels.map(id => labelChip(id)).join('')}</div>` : ''}
    <div class="kc-row1"><span class="prio">${esc(c.prio)}</span><span class="repo">${esc(repoName(c.repo))}</span>${c.milestone ? '<span class="bd-ms" title="Milestone" aria-label="Milestone">◆</span>' : ''}${isAll() ? boardChip(c) : ''}</div>
    <h4>${esc(c.title)}</h4>
    ${ep ? `<p class="kc-epic" title="Epic: ${esc(ep.title)}"><span class="bd-eb">Epic</span> ${esc(short(ep.title, 30))} <span class="hint">${epDone}/${epKids.length}</span></p>` : ''}
    ${c.blocked ? `<p class="kc-block">Terblokir: ${esc(c.blocked)}</p>` : ''}
    ${pend.length ? `<p class="kc-wait" title="${esc(waitTitle)}">Menunggu ${pend.length} kartu</p>` : ''}
    ${isDate(c.publishAt) ? `<p class="kc-date kc-pub${!c.done && c.publishAt < todayStr() ? ' over' : ''}" title="Tanggal tayang"><span aria-hidden="true">◆</span><span>Tayang ${esc(fmtDay(c.publishAt))}</span></p>` : ''}
    ${dates ? `<p class="kc-date ${ds}">${ICON.clock}<span>${esc(dates)}</span>${ds === 'over' ? '<b>terlambat</b>' : ''}</p>` : ''}
    ${pg != null ? `<div class="kc-check"><div class="bar"><i style="width:${pg}%"></i></div><span>${tot && c.progress == null ? `${done}/${tot}` : pg + '%'}</span></div>` : ''}
    <div class="kc-foot"><span class="kc-who">${r ? mini(r) + `<span class="kc-wn">${esc(r.name)}</span>` : '<span class="sub">Belum ditugaskan</span>'}</span>
      ${c.comments ? `<span class="ico" title="${c.comments} komentar">${ICON.chat}${c.comments}</span>` : ''}${c.attachments ? `<span class="ico" title="${c.attachments} lampiran">${ICON.file}${c.attachments}</span>` : ''}</div>
    <div class="kc-slot">${liveHTML(c)}</div>
  </div>`;
}

/* ---------------- swimlane ---------------- */
const NONE = '_none';
function laneKeys(c, g) {
  if (g === 'who') return [c.who || NONE];
  if (g === 'epic') return [c.epicId && S.map.has(c.epicId) ? c.epicId : NONE];
  if (g === 'prio') return [c.prio];
  if (g === 'label') return (c.labels || []).filter(labelOf).length ? c.labels.filter(labelOf) : [NONE];
  if (g === 'repo') return [c.repo || NONE];
  return [''];
}
function lanes(cards) {
  const g = S.f.group;
  if (g === 'none') return [{ key: '', label: '', count: cards.length }];
  const used = new Map();
  cards.forEach(c => laneKeys(c, g).forEach(k => used.set(k, (used.get(k) || 0) + 1)));
  let order;
  if (g === 'who') order = [...roles().map(r => r.id), ...used.keys(), NONE];
  else if (g === 'epic') order = [...epics().map(e => e.id), ...used.keys(), NONE];
  else if (g === 'prio') order = PRIOS;
  else if (g === 'label') order = [...S.labels.map(l => l.id), NONE];
  else order = [...repoChoices().map(x => x[0]), ...used.keys(), NONE];
  const label = k => {
    if (k === NONE) return { who: 'Belum ditugaskan', epic: 'Tanpa epic', label: 'Tanpa label', repo: 'Tanpa repo' }[g];
    return g === 'who' ? whoName(k) : g === 'epic' ? S.map.get(k)?.title || k : g === 'prio' ? k : g === 'label' ? labelName(k) : repoName(k);
  };
  return [...new Set(order)].filter(k => used.has(k)).map(k => ({ key: k, label: label(k), count: used.get(k), color: g === 'label' ? labelOf(k)?.color : g === 'prio' ? prioVar(k) : '' }));
}
/** isi PATCH supaya kartu "masuk" ke swimlane tujuan */
function laneBody(g, key) {
  if (g === 'who') return { who: key === NONE ? null : key };
  if (g === 'epic') return { epicId: key === NONE ? '' : key };
  if (g === 'prio') return { prio: key };
  if (g === 'repo') return { repo: key === NONE ? '' : key };
  return {};
}

/* ---------------- kanban ---------------- */
function qaHTML(col, lane, pos) {
  return `<form class="kc-qa" data-qa="1" data-col="${col}" data-lane="${esc(lane)}" data-pos="${pos}"><input type="text" aria-label="Judul kartu baru di ${esc(COLN()[col] || '')}" placeholder="Judul #label @role !P1" value="${esc(S.qa.val || '')}" autocomplete="off" maxlength="200"><span class="hint">Enter tambah · Esc tutup</span></form>`;
}
function kanbanHTML(cards) {
  const g = S.f.group, ls = lanes(cards), coll = S.f.collapsed, wipOf = S.wip;
  const VC = viewCols(), names = VC.map(c => c.name);
  const tpl = names.map((_, i) => (coll.includes(i) ? '46px' : 'minmax(230px,1fr)')).join(' ');
  const minW = names.reduce((a, _, i) => a + (coll.includes(i) ? 58 : 242), 0);
  let html = names.map((n0, i) => {
    const name = esc(n0), kind = VC[i].kind;
    const n = cards.filter(c => colOf(c) === i).length, tot = S.cards.filter(c => !c.epic && colOf(c) === i).length, lim = wipOf[i], over = lim && tot > lim;
    if (coll.includes(i)) return `<div class="kb-colh collapsed${over ? ' over' : ''}"><button type="button" class="kb-fold" data-act="bd-fold" data-col="${i}" aria-expanded="false" aria-label="Buka kolom ${name}" title="Buka kolom"><span class="vt">${name}</span><span class="count">${n}</span></button></div>`;
    return `<div class="kb-colh${over ? ' over' : ''}">
      <button type="button" class="kb-fold ic" data-act="bd-fold" data-col="${i}" aria-expanded="true" aria-label="Ciutkan kolom ${name}" title="Ciutkan kolom">▾</button>
      <h3><i class="kb-kind k-${kind}" title="Jenis: ${KIND_LABEL[kind]}" aria-hidden="true"></i>${name}</h3><span class="count" aria-label="${n} kartu">${n}${n !== tot ? `<small>/${tot}</small>` : ''}</span>
      <button type="button" class="wip${over ? ' over' : ''}" data-act="bd-wip" data-col="${i}" title="Atur batas WIP kolom ${name}" aria-label="Batas WIP ${lim || 'tanpa batas'}, klik untuk mengubah">WIP ${lim ? tot + '/' + lim : '∞'}</button>
      <button type="button" class="kb-plus" data-act="bd-qa" data-col="${i}" data-lane="${esc(ls[0]?.key ?? '')}" data-pos="top" aria-label="Tambah kartu di ${name}" title="Tambah kartu">+</button></div>`;
  }).join('');
  ls.forEach(l => {
    const off = g !== 'none' && S.f.lanesOff.includes(g + ':' + l.key);
    if (g !== 'none') html += `<div class="lane-h"><button type="button" class="lane-t" data-act="bd-lane" data-key="${esc(l.key)}" aria-expanded="${!off}"><span class="chev" aria-hidden="true">${off ? '▸' : '▾'}</span>${l.color ? `<i class="lane-dot" style="background:${l.color}"></i>` : ''}<span>${esc(l.label)}</span><span class="count">${l.count}</span></button></div>`;
    if (off) return;
    names.forEach((n0, i) => {
      const name = esc(n0);
      if (coll.includes(i)) { html += `<div class="kb-cell cl" data-drop="${i}" data-lane="${esc(l.key)}" aria-hidden="true"></div>`; return; }
      const here = cards.filter(c => colOf(c) === i && laneKeys(c, g).includes(l.key)).sort(byOrd);
      const qa = S.qa && S.qa.col === i && S.qa.lane === l.key ? S.qa : null;
      html += `<div class="kb-cell" data-drop="${i}" data-lane="${esc(l.key)}" role="list" aria-label="${name}${l.label ? ' · ' + esc(l.label) : ''}">${qa?.pos === 'top' ? qaHTML(i, l.key, 'top') : ''}${here.map(cardHTML).join('')}${qa?.pos === 'bottom' ? qaHTML(i, l.key, 'bottom') : `<button type="button" class="kb-add" data-act="bd-qa" data-col="${i}" data-lane="${esc(l.key)}" data-pos="bottom" aria-label="Tambah kartu di ${name}">+ Tambah kartu</button>`}</div>`;
    });
  });
  return `<div class="board-scroll"><div class="kb" style="grid-template-columns:${tpl};min-width:${minW}px">${html}</div></div>`;
}

const SORTS = {
  prio: c => c.prio, title: c => c.title.toLowerCase(), repo: c => repoName(c.repo).toLowerCase(),
  who: c => whoName(c.who).toLowerCase(), col: c => colOf(c), due: c => c.due || '9999',
  checks: c => progressOf(c) ?? -1, moved: c => c.movedAt || '',
};
function listHTML(cards) {
  const { k, dir } = S.f.sort, fn = SORTS[k] || SORTS.col;
  const sorted = [...cards].sort((a, b) => { const x = fn(a), y = fn(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || colOf(a) - colOf(b); });
  const th = (key, label) => `<th><button class="bd-th" data-act="bd-sort" data-k="${key}">${label}${S.f.sort.k === key ? `<span aria-hidden="true">${dir > 0 ? ' ▲' : ' ▼'}</span>` : ''}</button></th>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th><span class="sr-only">Pilih</span></th>${th('prio', 'Prioritas')}${th('title', 'Kartu')}${th('repo', 'Repo')}${th('who', 'Role')}${th('col', 'Status')}${th('due', 'Tenggat')}${th('checks', 'Progres')}${th('moved', 'Terakhir')}</tr></thead><tbody>
    ${sorted.map(c => { const pg = progressOf(c), ds = dueState(c), pend = pendingDeps(c, S.map).length; return `<tr class="click${S.sel.has(c.id) ? ' sel' : ''}" data-card="${esc(c.id)}" tabindex="0">
      <td><input type="checkbox" class="kc-cb on" ${S.sel.has(c.id) ? 'checked' : ''} aria-label="Pilih kartu ${esc(short(c.title, 30))}"></td>
      <td><span class="prio" style="--pc:${prioVar(c.prio)}">${esc(c.prio)}</span></td>
      <td>${c.milestone ? '<span class="bd-ms">◆</span> ' : ''}${esc(c.title)}${c.blocked ? ' <span class="st wait">terblokir</span>' : ''}${pend ? ` <span class="st wait">menunggu ${pend}</span>` : ''}<span class="kc-slot-inline">${isLive(c) ? ' <span class="st working">live</span>' : ''}</span>
        ${(c.labels || []).length ? `<div class="kc-labels">${c.labels.map(id => labelChip(id)).join('')}</div>` : ''}</td>
      <td><span class="repo">${esc(repoName(c.repo))}</span></td>
      <td>${esc(whoName(c.who))}</td><td>${esc(c.colName || '')}${isAll() ? ` <span class="hint">· ${esc(c.boardName || c.board)}</span>` : ''}</td>
      <td class="kc-date ${ds}">${c.due ? esc(isDate(c.due) ? fmtDay(c.due) : c.due) : '-'}</td>
      <td>${pg != null ? pg + '%' : '-'}</td>
      <td class="sub">${esc(c.movedBy ? c.movedBy + ' · ' + ago(c.movedAt) : '')}</td></tr>`; }).join('')}
    </tbody></table></div>`;
}

function renderMain() {
  const main = $('#bdMain', S.el); if (!main) return;
  const act = document.activeElement, focusId = act?.closest?.('#bdMain') && act.closest('[data-card]')?.dataset.card;
  const qi = $('.kc-qa input', main), qval = qi?.value, qhad = qi && document.activeElement === qi;
  if (qval !== undefined && S.qa) S.qa.val = qval;
  renderControls(); renderBulk();
  main.className = 'bd-' + S.f.density + (S.sel.size || S.selMode ? ' bd-selecting' : '');
  if (!S.cards.length) {
    main.innerHTML = `<div class="empty"><p>Board masih kosong. Buat kartu pertama, atau minta manager atau agent menambahkannya lewat MCP kantor.</p><button class="btn primary" data-act="bd-new">Kartu baru</button></div>`;
    return;
  }
  const cards = filtered();
  if (!cards.length) { main.innerHTML = `<div class="empty-line bd-none">Tidak ada kartu yang cocok dengan filter. <button class="btn sm" data-act="bd-clear">Bersihkan filter</button></div>`; return; }
  main.innerHTML = S.f.view === 'list' ? listHTML(cards) : kanbanHTML(cards);
  if (S.qa && (S.qa.focus || qhad)) { const i = $('.kc-qa input', main); if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch {} } S.qa.focus = false; }
  else if (focusId) $(`[data-card="${CSS.escape(focusId)}"]`, main)?.focus({ preventScroll: true });
}
const paint = () => { renderBoards(); renderEpics(); renderMain(); };

function updateLive() {
  if (!S.el) return;
  const sig = (office().sessions || []).filter(s => s.status === 'working').map(s => s.role).sort().join(',');
  if (sig === S.liveSig) return;
  S.liveSig = sig;
  $$('.kc[data-card]', S.el).forEach(el => {
    const c = S.map.get(el.dataset.card), slot = $('.kc-slot', el);
    if (c && slot) slot.innerHTML = liveHTML(c);
  });
  $$('tr[data-card]', S.el).forEach(tr => {
    const c = S.map.get(tr.dataset.card), slot = $('.kc-slot-inline', tr);
    if (c && slot) slot.innerHTML = isLive(c) ? ' <span class="st working">live</span>' : '';
  });
  updateLiveBox();
}

async function fetchBoard() {
  // selalu semua papan: dependensi lintas papan, hitungan per papan, dan pindah papan butuh kartu papan lain juga
  const b = await api(`${base()}/board?board=all`);
  S.boards = b.boards || [];
  if (!isAll() && !S.boards.some(x => x.id === S.board && !x.archived)) S.board = 'utama';
  const mine = isAll() ? b.cards : b.cards.filter(c => (c.board || 'utama') === S.board);
  const next = new Map(mine.map(c => [c.id, c.updatedAt]));
  if (S.seen.size) mine.forEach(c => { if (S.seen.get(c.id) !== c.updatedAt) S.flash.add(c.id); });
  S.seen = next; S.all = b.cards; S.cards = mine; S.labels = b.labels || []; S.map = new Map(b.cards.map(c => [c.id, c]));
  S.sel = new Set(visibleSel());
  return b;
}
async function refetch() {
  try { await fetchBoard(); } catch (e) { toast(e.message, 'bad'); return; }
  if (!S.el) return;
  paint();
  if (S.flash.size) setTimeout(() => { S.flash.clear(); if (S.el) $$('.kc.flash', S.el).forEach(e => e.classList.remove('flash')); }, 1800);
  if (S.dr?.id) {
    if (!S.map.has(S.dr.id)) closeDetail();
    else refreshDrawer();
  }
}
const schedule = debounce(() => refetch(), 300);
hooks.refetch = refetch; hooks.renderMain = () => { if (S.el) paint(); };

/* ---------------- pindah / urut kartu ---------------- */
/** ord untuk n kartu yang disisipkan di antara prev dan next */
function ordsBetween(prev, next, n) {
  if (prev != null && next != null) return Array.from({ length: n }, (_, k) => prev + (next - prev) * (k + 1) / (n + 1));
  if (next != null) return Array.from({ length: n }, (_, k) => next - 1000 * (n - k));
  if (prev != null) return Array.from({ length: n }, (_, k) => prev + 1000 * (k + 1));
  const t = Date.now(); return Array.from({ length: n }, (_, k) => t + k);
}
async function placeCards(ids, col, lane, prevId, nextId, fromLane) {
  const g = S.f.group, cards = ids.map(id => S.map.get(id)).filter(Boolean); if (!cards.length) return;
  const ords = ordsBetween(S.map.get(prevId)?.ord ?? null, S.map.get(nextId)?.ord ?? null, cards.length);
  const jobs = cards.map((c, k) => {
    const body = { col: colVal(col), ord: ords[k] };
    if (lane !== undefined && lane !== null && g !== 'none' && g !== 'label') Object.assign(body, laneBody(g, lane));
    if (g === 'label' && lane !== undefined && lane !== fromLane) {
      let ls = (c.labels || []).filter(l => l !== fromLane);
      if (lane && lane !== NONE && !ls.includes(lane)) ls.push(lane);
      body.labels = ls;
    }
    Object.assign(c, body, isAll() ? { stage: col } : { col });
    return [c.id, body];
  });
  renderMain();
  try { await Promise.all(jobs.map(([id, body]) => patch(`${base()}/cards/${id}`, body))); } catch (e) { toast(e.message, 'bad'); }
  refetch();
}
function moveToCol(ids, col) {
  const last = colCards(col).filter(c => !ids.includes(c.id)).pop();
  return placeCards(ids, col, undefined, last?.id, null);
}
function reorder(id, dir) {
  const c = S.map.get(id); if (!c) return;
  const sib = colCards(colOf(c)), i = sib.findIndex(x => x.id === id), j = i + dir;
  if (j < 0 || j >= sib.length) return;
  const rest = sib.filter(x => x.id !== id), k = j; // sisip sebelum rest[k], setelah rest[k-1]
  placeCards([id], colOf(c), undefined, rest[k - 1]?.id, rest[k]?.id).then(() => { $(`[data-card="${CSS.escape(id)}"]`, S.el)?.focus(); });
}

/* ---------------- tambah cepat ---------------- */
async function quickAdd(form) {
  const input = $('input', form), qa = S.qa; if (!qa) return;
  const p = parseQuick(input.value, { labels: S.labels, roles: roles() });
  if (!p.title) { toast('Judul kartu kosong', 'warn'); return; }
  const g = S.f.group, col = Number(form.dataset.col), lane = form.dataset.lane;
  const body = { title: p.title, col: colVal(col), labels: p.labels, board: isAll() ? 'utama' : S.board };
  if (g !== 'none' && g !== 'label' && lane) Object.assign(body, laneBody(g, lane));
  if (g === 'label' && lane && lane !== NONE && labelOf(lane)) body.labels = [...new Set([...body.labels, labelName(lane)])];
  if (p.who) body.who = p.who;
  if (p.prio) body.prio = p.prio;
  input.disabled = true;
  try {
    const card = await post(`${base()}/cards`, body);
    if (qa.pos === 'top') { const first = colCards(col)[0]; if (first) await patch(`${base()}/cards/${card.id}`, { ord: first.ord - 1000 }); }
  } catch (e) { toast(e.message, 'bad'); input.disabled = false; input.focus(); return; }
  input.value = ''; qa.val = ''; qa.focus = true;
  await refetch();
}
function openQa(col, lane, pos) {
  if (S.f.collapsed.includes(col)) { S.f.collapsed = S.f.collapsed.filter(x => x !== col); persist(); }
  S.qa = { col, lane, pos, val: '', focus: true };
  renderMain();
}

/* ---------------- multi-pilih + aksi massal ---------------- */
function toggleSel(id, on) {
  on = on ?? !S.sel.has(id);
  on ? S.sel.add(id) : S.sel.delete(id);
  $$(`[data-card="${CSS.escape(id)}"]`, S.el).forEach(el => { el.classList.toggle('sel', on); const cb = $('.kc-cb', el); if (cb) cb.checked = on; });
  $('#bdMain', S.el)?.classList.toggle('bd-selecting', S.sel.size > 0 || S.selMode);
  renderBulk();
}
function clearSel() { S.sel.clear(); S.selMode = false; $('#bdSelBtn', S.el)?.setAttribute('aria-pressed', 'false'); renderMain(); }
function renderBulk() {
  const box = $('#bdBulk', S.el); if (!box) return;
  const n = visibleSel().length;
  if (!n) { box.innerHTML = ''; return; }
  if ($('.bd-bulk', box)) { $('.bd-bn', box).textContent = n + ' dipilih'; return; }
  const sel = (k, ph, opts) => `<select data-bulk="${k}" aria-label="${ph}"><option value="">${ph}</option>${opts}</select>`;
  box.innerHTML = `<div class="bd-bulk" role="toolbar" aria-label="Aksi untuk kartu terpilih"><b class="bd-bn">${n} dipilih</b>
    ${sel('col', 'Pindah ke…', COLN().map((c, i) => `<option value="${i}">${esc(c)}</option>`).join(''))}
    ${S.boards.filter(b => !b.archived).length > 1 ? sel('board', 'Pindah papan…', S.boards.filter(b => !b.archived).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')) : ''}
    ${sel('who', 'Tugaskan…', `<option value="${NONE}">(lepas penugasan)</option>` + roles().map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join(''))}
    ${sel('prio', 'Prioritas…', PRIOS.map(p => `<option>${p}</option>`).join(''))}
    ${sel('addl', '+ Label…', S.labels.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join(''))}
    ${sel('rml', '− Label…', S.labels.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join(''))}
    <button type="button" class="btn sm danger" data-act="bd-bulk-del">Arsipkan</button><button type="button" class="btn sm" data-act="bd-sel-clear">Batal</button></div>`;
}
async function bulk(kind, v) {
  const ids = visibleSel(); if (!ids.length || !v) return;
  if (kind === 'col') { await moveToCol(ids, Number(v)); return; }
  const jobs = ids.map(id => {
    const c = S.map.get(id); let body;
    if (kind === 'who') body = { who: v === NONE ? null : v };
    else if (kind === 'board') body = { board: v };
    else if (kind === 'prio') body = { prio: v };
    else if (kind === 'addl') body = { labels: [...new Set([...(c.labels || []), v])] };
    else body = { labels: (c.labels || []).filter(l => l !== v) };
    return patch(`${base()}/cards/${id}`, body);
  });
  try { await Promise.all(jobs); toast(`${ids.length} kartu diperbarui`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
  refetch();
}
function bulkDelete() {
  const ids = visibleSel();
  confirmDo('Arsipkan kartu', `${ids.length} kartu terpilih akan dihapus dari board (sub-kartu epic ikut).`, 'Arsipkan', async () => {
    try { await Promise.all(ids.map(id => del(`${base()}/cards/${id}`))); toast(`${ids.length} kartu diarsipkan`, 'ok'); S.sel.clear(); } catch (e) { toast(e.message, 'bad'); }
    refetch();
  });
}

/* ---------------- menu kartu (alternatif keyboard untuk drag) ---------------- */
function closeMenu(refocus) {
  const m = S.menu; if (!m) return;
  m.el.remove(); S.menu = null;
  if (refocus) ($(`[data-card="${CSS.escape(m.id)}"] .kc-mb`, S.el) || $(`[data-card="${CSS.escape(m.id)}"]`, S.el))?.focus();
}
function openMenu(id, anchor) {
  closeMenu();
  const c = S.map.get(id); if (!c) return;
  const cc = colOf(c), sib = colCards(cc), i = sib.findIndex(x => x.id === id);
  const el = document.createElement('div');
  el.className = 'bd-menu'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', 'Menu kartu');
  el.innerHTML = `<p class="bd-mh">Pindah ke</p>${COLN().map((n, k) => `<button type="button" role="menuitem" data-mn="mv" data-col="${k}" ${k === cc ? 'aria-current="true"' : ''}>${esc(n)}${k === cc ? ' ·' : ''}</button>`).join('')}
    <hr><button type="button" role="menuitem" data-mn="up" ${i <= 0 ? 'disabled' : ''}>Naikkan dalam kolom</button><button type="button" role="menuitem" data-mn="down" ${i >= sib.length - 1 ? 'disabled' : ''}>Turunkan dalam kolom</button>
    <hr><button type="button" role="menuitem" data-mn="open">Buka detail</button><button type="button" role="menuitem" data-mn="sel">${S.sel.has(id) ? 'Batal pilih' : 'Pilih kartu'}</button><button type="button" role="menuitem" class="danger" data-mn="del">Arsipkan</button>`;
  S.el.appendChild(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - h - 8)) + 'px';
  S.menu = { el, id };
  ($('button:not([disabled])', el)).focus();
}
function menuClick(e) {
  const b = e.target.closest('[data-mn]'); if (!b || !S.menu) return;
  const id = S.menu.id, k = b.dataset.mn;
  closeMenu(k === 'sel');
  if (k === 'mv') moveToCol([id], Number(b.dataset.col));
  else if (k === 'up') reorder(id, -1);
  else if (k === 'down') reorder(id, 1);
  else if (k === 'open') openCard(id);
  else if (k === 'sel') toggleSel(id);
  else if (k === 'del') confirmDo('Arsipkan kartu', `Kartu "${esc(short(S.map.get(id)?.title || '', 60))}" akan dihapus dari board.`, 'Arsipkan', async () => {
    try { await del(`${base()}/cards/${id}`); toast('Kartu diarsipkan', 'ok'); } catch (err) { toast(err.message, 'bad'); }
    refetch();
  });
}
function menuKey(e) {
  if (!S.menu) return false;
  const items = $$('button:not([disabled])', S.menu.el), i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === 'Escape') closeMenu(true);
  else if (e.key === 'Tab') closeMenu(true);
  else return false;
  e.preventDefault(); return true;
}

/* ---------------- dialog ---------------- */
function wipDialog(col) {
  modal({
    title: `Batas WIP: ${COLN()[col] || ''}`, body: 'Jumlah kartu maksimal di kolom ini. 0 berarti tanpa batas. Kolom diberi tanda saat batas terlewati. Disimpan di browser ini.',
    html: `<input type="number" id="wipIn" min="0" max="99" value="${S.wip[col] || 0}" aria-label="Batas WIP">`,
    actions: [{ label: 'Simpan', kind: 'primary', fn: () => { S.wip[col] = Math.max(0, Math.floor(Number($('#wipIn').value) || 0)); saveWip(wipKey(), S.wip); renderMain(); } }, { label: 'Batal' }],
  });
}
function helpDialog() {
  const rows = [['n', 'Kartu baru'], ['/', 'Cari kartu'], ['← → ↑ ↓', 'Pindah fokus antar kartu'], ['Enter / e', 'Buka kartu terfokus'], ['x', 'Pilih / batal pilih kartu'], ['m', 'Menu pindah kartu'], ['Shift + ← →', 'Pindah kartu antar kolom'], ['Shift + ↑ ↓', 'Ubah urutan dalam kolom'], ['Shift / Cmd + klik', 'Pilih beberapa kartu'], ['f', 'Buka / tutup filter'], ['a', 'Tambah cepat di kolom Backlog'], ['Esc', 'Tutup menu, hapus pilihan'], ['?', 'Bantuan ini']];
  modal({ title: 'Pintasan keyboard', html: `<dl class="bd-keys">${rows.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join('')}</dl><p class="hint">Tambah cepat: ketik <code>judul #label @role !P1</code> lalu Enter.</p>` });
}

/* ---------------- filter ---------------- */
function toggleF(k, v) {
  const f = S.f;
  if (k === 'due') f.due = f.due === v ? '' : v;
  else if (k === 'q') f.q = '';
  else if (Array.isArray(f[k])) f[k] = f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v];
  else f[k] = !f[k];
}
function removeF(k, v) {
  if (k === 'q') { f_q(''); } else if (k === 'due') S.f.due = ''; else if (Array.isArray(S.f[k])) S.f[k] = S.f[k].filter(x => x !== v); else S.f[k] = false;
}
function f_q(v) { S.f.q = v; const i = $('#bdQ', S.el); if (i) i.value = v; }
function clearFilters() {
  const d = defaultPrefs();
  Object.assign(S.f, { q: '', who: [], labels: [], prios: [], repos: [], due: '', blocked: false, waiting: false, unassigned: false, mine: false, hideOld: false });
  f_q(d.q);
}

/* ---------------- keyboard ---------------- */
function neighbor(from, dir) {
  const cards = $$('#bdMain .kc[data-card]', S.el); if (!cards.length) return null;
  if (!from) return cards[0];
  const r = from.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bs = Infinity;
  for (const el of cards) {
    if (el === from) continue;
    const q = el.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2, dx = x - cx, dy = y - cy;
    const ok = dir === 'left' ? dx < -20 : dir === 'right' ? dx > 20 : dir === 'up' ? (Math.abs(dx) < r.width / 2 && dy < -4) : (Math.abs(dx) < r.width / 2 && dy > 4);
    if (!ok) continue;
    const s = (dir === 'left' || dir === 'right') ? Math.abs(dx) * 3 + Math.abs(dy) : Math.abs(dy) * 3 + Math.abs(dx);
    if (s < bs) { bs = s; best = el; }
  }
  // kolom sebelah kosong di baris itu: lompat ke kartu terdekat di arah yang sama
  return best;
}
function onKey(e) {
  if (!S.el || e.defaultPrevented) return;
  if (menuKey(e)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
  if (e.key === 'Escape') {
    if (t.matches?.('.kc-qa input')) { S.qa = null; renderMain(); return; }
    if (S.fp) { S.fp = false; renderControls(); $('#bdFpBtn', S.el)?.focus(); return; }
    if (!typing && (S.sel.size || S.selMode) && !drawerState().open && $('#modal')?.hidden !== false) { clearSel(); return; }
    return;
  }
  if (typing || drawerState().open || $('#modal')?.hidden === false) return;
  const card = t.closest?.('.kc[data-card]');
  const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (dirs[e.key]) {
    if (S.f.view !== 'kanban') return;
    e.preventDefault();
    if (e.shiftKey && card) {
      const c = S.map.get(card.dataset.card), d = dirs[e.key];
      if (d === 'left' || d === 'right') { const to = colOf(c) + (d === 'left' ? -1 : 1); if (to >= 0 && to < COLN().length) moveToCol([c.id], to).then(() => $(`[data-card="${CSS.escape(c.id)}"]`, S.el)?.focus()); }
      else reorder(c.id, d === 'up' ? -1 : 1);
      return;
    }
    neighbor(card, dirs[e.key])?.focus(); return;
  }
  if (e.key === '/') { e.preventDefault(); $('#bdQ', S.el)?.focus(); }
  else if (e.key === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === '?') { e.preventDefault(); helpDialog(); }
  else if (e.key === 'f') { e.preventDefault(); S.fp = !S.fp; renderControls(); }
  else if (e.key === 'a' && S.f.view === 'kanban') { e.preventDefault(); openQa(0, lanes(filtered())[0]?.key ?? '', 'top'); }
  else if (card && (e.key === 'e')) { e.preventDefault(); openCard(card.dataset.card); }
  else if (card && e.key === 'x') { e.preventDefault(); toggleSel(card.dataset.card); }
  else if (card && e.key === 'm') { e.preventDefault(); openMenu(card.dataset.card, $('.kc-mb', card) || card); }
}

/* ---------------- event ---------------- */
function bindRoot(el) {
  const click = e => {
    const t = e.target.closest('[data-act]');
    if (S.menu && !e.target.closest('.bd-menu')) closeMenu(false);
    if (S.menu && e.target.closest('.bd-menu')) return menuClick(e);
    if (e.target.closest('.kc-cb')) { const c = e.target.closest('[data-card]'); toggleSel(c.dataset.card, e.target.checked); return; }
    if (t && el.contains(t)) {
      const a = t.dataset.act;
      if (a === 'bd-open') { e.preventDefault(); openCard(t.dataset.id); }
      else if (a === 'bd-board') switchBoard(t.dataset.id);
      else if (a === 'bd-board-new') newBoardDialog();
      else if (a === 'bd-board-set') boardSettings();
      else if (a === 'bd-new') openNew();
      else if (a === 'bd-help') helpDialog();
      else if (a === 'bd-lblmgr') openLabelManager();
      else if (a === 'bd-fp') { S.fp = !S.fp; renderControls(); }
      else if (a === 'bd-f') { toggleF(t.dataset.k, t.dataset.v); persist(); renderMain(); }
      else if (a === 'bd-q') {
        if (t.dataset.k === 'mine' && !S.f.me && !S.f.mine) { S.fp = true; renderControls(); toast('Pilih dulu "Saya adalah" di panel Filter', 'warn'); $('#bdMe', el)?.focus(); return; }
        toggleF(t.dataset.k); persist(); renderMain();
      }
      else if (a === 'bd-rm') { removeF(t.dataset.k, t.dataset.v); persist(); renderMain(); }
      else if (a === 'bd-clear') { clearFilters(); persist(); renderMain(); }
      else if (a === 'bd-view' || a === 'bd-dens') {
        S.f[a === 'bd-view' ? 'view' : 'density'] = t.dataset.v;
        $$(`[data-act="${a}"]`, el).forEach(b => b.setAttribute('aria-pressed', String(b === t)));
        persist(); renderMain();
      }
      else if (a === 'bd-sort') { const k = t.dataset.k; S.f.sort = S.f.sort.k === k ? { k, dir: -S.f.sort.dir } : { k, dir: 1 }; persist(); renderMain(); }
      else if (a === 'bd-selmode') { S.selMode = !S.selMode; t.setAttribute('aria-pressed', String(S.selMode)); $('#bdMain', el)?.classList.toggle('bd-selecting', S.sel.size > 0 || S.selMode); }
      else if (a === 'bd-sel-clear') clearSel();
      else if (a === 'bd-bulk-del') bulkDelete();
      else if (a === 'bd-fold') { const c = Number(t.dataset.col); S.f.collapsed = S.f.collapsed.includes(c) ? S.f.collapsed.filter(x => x !== c) : [...S.f.collapsed, c]; persist(); renderMain(); }
      else if (a === 'bd-lane') { const k = S.f.group + ':' + t.dataset.key; S.f.lanesOff = S.f.lanesOff.includes(k) ? S.f.lanesOff.filter(x => x !== k) : [...S.f.lanesOff, k]; persist(); renderMain(); }
      else if (a === 'bd-wip') wipDialog(Number(t.dataset.col));
      else if (a === 'bd-qa') openQa(Number(t.dataset.col), t.dataset.lane, t.dataset.pos);
      else if (a === 'bd-menu') { e.stopPropagation(); openMenu(t.dataset.id, t); }
      return;
    }
    const card = e.target.closest('.kc[data-card],tr[data-card]');
    if (card && el.contains(card)) {
      if (e.shiftKey || e.metaKey || e.ctrlKey || S.sel.size || S.selMode) { e.preventDefault(); toggleSel(card.dataset.card); }
      else openCard(card.dataset.card);
    }
  };
  const searchSoon = debounce(() => { S.f.q = $('#bdQ', el).value; persist(); renderMain(); }, 150);
  const input = e => { if (e.target.id === 'bdQ') searchSoon(); };
  const change = e => {
    const t = e.target;
    if (t.id === 'bdGroup') { S.f.group = t.value; persist(); renderMain(); }
    else if (t.id === 'bdMe') { S.f.me = t.value; if (!t.value) S.f.mine = false; persist(); renderMain(); }
    else if (t.dataset.bulk) { const k = t.dataset.bulk, v = t.value; t.value = ''; bulk(k, v); }
  };
  const keydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.kc,tr[data-card]')) { e.preventDefault(); openCard(e.target.dataset.card); }
  };
  const submit = e => { if (e.target.matches('form[data-qa]')) { e.preventDefault(); quickAdd(e.target); } };
  const focusout = e => {
    if (e.target.matches?.('.kc-qa input') && S.qa) {
      const v = e.target.value; S.qa.val = v;
      setTimeout(() => { if (S.qa && !v.trim() && !$('.kc-qa input:focus', el) && S.el) { S.qa = null; renderMain(); } }, 150);
    }
  };
  /* drag & drop: urut dalam kolom + pindah antar kolom/lane */
  const ph = document.createElement('div'); ph.className = 'kc-ph';
  const clearDnD = () => { ph.remove(); $$('.dragging,.kb-cell.over', el).forEach(x => x.classList.remove('dragging', 'over')); };
  const dragstart = e => {
    const k = e.target.closest?.('.kc'); if (!k) return;
    const id = k.dataset.card;
    S.dragIds = S.sel.has(id) && S.sel.size > 1 ? visibleSel() : [id];
    S.dragLane = k.closest('.kb-cell')?.dataset.lane;
    S.dragIds.forEach(i => $$(`.kc[data-card="${CSS.escape(i)}"]`, el).forEach(x => x.classList.add('dragging')));
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch {}
  };
  const dragend = () => { S.dragIds = null; clearDnD(); };
  const dragover = e => {
    const c = e.target.closest?.('.kb-cell'); if (!c || !S.dragIds) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (!c.classList.contains('over')) { $$('.kb-cell.over', el).forEach(x => x.classList.remove('over')); c.classList.add('over'); }
    if (c.classList.contains('cl')) return;
    const cards = $$(':scope > .kc:not(.dragging)', c);
    const ref = cards.find(k => { const r = k.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    const target = ref || $('.kb-add', c) || $('.kc-qa[data-pos=bottom]', c) || null;
    if (ph.parentNode !== c || (ref ? ph.nextElementSibling !== ref : (target ? ph.nextElementSibling !== target : ph !== c.lastElementChild))) c.insertBefore(ph, target);
  };
  const dragleave = e => { const c = e.target.closest?.('.kb-cell'); if (c && !c.contains(e.relatedTarget)) { c.classList.remove('over'); if (ph.parentNode === c) ph.remove(); } };
  const live = (node, dir) => { while (node && node.classList.contains('dragging')) node = node[dir]; return node; };
  const dropEv = e => {
    const c = e.target.closest?.('.kb-cell'); if (!c || !S.dragIds) return;
    e.preventDefault();
    const ids = S.dragIds, fromLane = S.dragLane, col = Number(c.dataset.drop), lane = c.dataset.lane;
    if (c.classList.contains('cl')) { S.dragIds = null; clearDnD(); moveToCol(ids, col); return; }
    let pid = null, nid = null;
    if (ph.parentNode === c) {
      const p = live(ph.previousElementSibling, 'previousElementSibling'), n = live(ph.nextElementSibling, 'nextElementSibling');
      pid = p?.classList.contains('kc') ? p.dataset.card : null; nid = n?.classList.contains('kc') ? n.dataset.card : null;
    } else pid = $$(':scope > .kc', c).filter(k => !ids.includes(k.dataset.card)).pop()?.dataset.card || null;
    S.dragIds = null; clearDnD();
    placeCards(ids, col, lane, pid, nid, fromLane);
  };
  const list = [['click', click], ['input', input], ['change', change], ['keydown', keydown], ['submit', submit], ['focusout', focusout], ['dragstart', dragstart], ['dragend', dragend], ['dragover', dragover], ['dragleave', dragleave], ['drop', dropEv]];
  list.forEach(([n, f]) => el.addEventListener(n, f));
  rootH = { el, list };
  docH = e => onKey(e);
  document.addEventListener('keydown', docH, true);
}
function unbind() {
  if (rootH) rootH.list.forEach(([n, f]) => rootH.el.removeEventListener(n, f));
  if (docH) document.removeEventListener('keydown', docH, true);
  rootH = docH = null;
  unbindDetail();
}

/* ---------------- module interface ---------------- */
export async function render(el, ctx, route) {
  unbind();
  Object.assign(S, { ctx, el, oid: ctx.office.id, cards: [], labels: [], map: new Map(), seen: new Map(), flash: new Set(), dr: null, liveSig: '', sel: new Set(), selMode: false, qa: null, fp: false, menu: null, dragIds: null });
  S.f = loadPrefs(S.oid); S.board = loadBoardSel(S.oid);
  el.innerHTML = '<p class="empty-line">Memuat board…</p>';
  try { await fetchBoard(); } catch (e) { el.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  boardPrefs();
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
  closeMenu(false);
  unbind();
  clearTimeout(S.timer);
  closeDetail();
  S.dr = null; S.el = null; S.oid = null;
}
