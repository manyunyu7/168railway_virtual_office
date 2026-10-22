// Tab Role: kartu role, editor role, daftar ruangan, dan dialog mulai shift.
import { $, $$, esc, short, sprite, isFem, modelName, SWATCHES, SKINS, HAIRS, api, post, patch, toast, modal, closeModal, confirmDo } from './util.js';
import { openSession, openRole } from './drawer.js';
import { loadPlaybooks, newPlaybookFor } from './playbooks.js';
import { createStage } from './office-canvas.js';
import { isCodex, codexBadge, mountCodexFields, codexValues, codexModels, codexFieldsHTML, CODEX_MODES } from './codex.js';
import { HAIR_STYLES, OUTFITS, ACCS, HIJABS, TEMPLATES, templateOf, applyLook, randomLook } from './chars.js';

const SKILL_SUGS = ['frontend', 'backend', 'review', 'testing', 'dokumentasi', 'debugging', 'refactor', 'database', 'devops', 'delegasi'];
const NO_DESK = ['lobby', 'openplan', 'toilet', 'booth', 'musik'];
const ROOM_KINDS = { kode: 'Kode (repo, ada meja)', game: 'Game', meeting: 'Ruang meeting', lib: 'Perpustakaan', qa: 'Lab QA', server: 'Ruang server', pantry: 'Pantry', manager: 'Ruang manager', musik: 'Ruang musik' };
const KIND_LABEL = { ...ROOM_KINDS, kode: 'Kode', beku: 'Beku', manager: 'Manager', musik: 'Musik', meeting: 'Meeting', lobby: 'Lobi' };
const MODEL_OPTS = [['sonnet', 'Sonnet 5.5, kerja utama'], ['opus', 'Opus 5.5, perencanaan'], ['haiku', 'Haiku 5.5, tugas kecil'], ['fable', 'Fable 5.1, paling kuat']];
export const PERMS = [['', 'Default kantor (lihat Pengaturan)'], ['ikut', 'Ikuti pengaturan Claude'], ['default', 'Selalu tanya'], ['acceptEdits', 'Edit file otomatis (acceptEdits)'], ['auto', 'Auto mode'], ['plan', 'Hanya merencanakan (plan)'], ['bypassPermissions', 'Lewati semua izin (--dangerously-skip-permissions)']];
const lastPerm = () => { try { return localStorage.getItem('kc.perm') || ''; } catch { return ''; } };

const M = { el: null, ctx: null, roles: [], office: null, showArchived: false };
let rf = null;      // keadaan editor role
let shift = null;   // keadaan dialog mulai shift

const roomsOf = ctx => (M.office || ctx.office).plan.rooms;
const roomName = (ctx, id) => ctx.office.plan.rooms.find(r => r.id === id)?.name || id || '-';
const liveSessions = (ctx, id) => ctx.office.sessions.filter(s => s.role === id && s.status !== 'ended');
const oid = ctx => encodeURIComponent(ctx.office.id);

/** Status role dari sesi hidupnya. */
export function roleState(ctx, id) {
  const ss = liveSessions(ctx, id);
  if (!ss.length) return { cls: 'off', label: 'Libur', n: 0 };
  if (ss.some(s => s.status === 'waiting')) return { cls: 'waiting', label: 'Menunggu izin', n: ss.length };
  if (ss.some(s => s.status === 'working' || s.status === 'starting')) return { cls: 'working', label: 'Bekerja', n: ss.length };
  return { cls: 'idle', label: 'Idle', n: ss.length };
}

/* ---------------- tab ---------------- */
export async function render(el, ctx) {
  M.el = el; M.ctx = ctx;
  if (!el.dataset.rlBound) { el.dataset.rlBound = '1'; el.addEventListener('click', onTabClick); }
  el.innerHTML = '<p class="empty-line">Memuat…</p>';
  await load();
  draw();
}
export function live(msg) {
  if (!M.el || !M.el.isConnected) return;
  if (msg.t === 'session' || msg.t === 'session-gone') { draw(); return; }
  if (msg.t === 'changed' && (msg.what === 'roles' || msg.what === 'plan' || msg.what === 'wiki')) load().then(draw).catch(() => {});
}
export function unmount() { M.el = null; }

async function load() {
  const [roles, office, pbs] = await Promise.all([api(`/api/offices/${oid(M.ctx)}/roles`), api(`/api/offices/${oid(M.ctx)}`), loadPlaybooks(M.ctx)]);
  M.roles = roles; M.office = office; M.pbs = pbs;
}

function roleCardHTML(r) {
  const ctx = M.ctx, st = roleState(ctx, r.id);
  const status = r.archived ? '<span class="st off">Diarsipkan</span>' : `<span class="st ${st.cls}">${st.label}${st.n > 1 ? ` · ${st.n} sesi paralel` : ''}</span>`;
  return `<article class="rcard${r.archived ? ' archived' : ''}" data-role="${esc(r.id)}">
    <div class="rc-top"><div class="rc-ava">${sprite(r, 3)}</div><div style="min-width:0"><h3>${esc(r.name)}${codexBadge(r)}${r.isMgr ? ' <span class="chip">Manager</span>' : ''}</h3><p>${esc(r.title)}</p>${status}</div></div>
    <p class="rc-persona">${esc(r.persona || 'Belum ada kepribadian.')}</p>
    ${r.skills?.length ? `<div class="chips">${r.skills.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    <div class="rc-pb">📘 ${(M.pbs || []).filter(p => p.roles?.includes(r.id)).map(p => `<a href="#/o/${encodeURIComponent(oid(M.ctx))}/wiki/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>`).join(', ') || '<span class="hint">belum ada playbook</span>'}${r.archived ? '' : ` <button class="btn sm ghost" data-act="rl-pb-new" data-role="${esc(r.id)}">+ Playbook</button>`}</div>
    <div class="rc-meta"><span>${esc(isCodex(r) ? (r.model || 'Codex bawaan') + (r.effort ? ' · ' + r.effort : '') : modelName(r.model))}</span><span>${esc(roomName(ctx, r.room))}</span>${r.reportsTo ? `<span>anak buah ${esc(M.roles.find(x => x.id === r.reportsTo)?.name || r.reportsTo)}</span>` : ''}${M.roles.some(x => x.reportsTo === r.id && !x.archived) ? `<span>${M.roles.filter(x => x.reportsTo === r.id && !x.archived).length} anak buah</span>` : ''}</div>
    <div class="btn-row">${r.archived
      ? `<button class="btn sm" data-act="rl-archive" data-role="${esc(r.id)}" data-v="0">Pulihkan</button>`
      : `<button class="btn sm" data-act="rl-profile" data-role="${esc(r.id)}">Profil</button><button class="btn sm primary" data-act="rl-shift" data-role="${esc(r.id)}">Mulai shift</button><button class="btn sm" data-act="rl-edit" data-role="${esc(r.id)}">Ubah</button><button class="btn sm ghost" data-act="rl-archive" data-role="${esc(r.id)}" data-v="1">Arsipkan</button>`}</div></article>`;
}

function roomRowHTML(r) {
  const ctx = M.ctx, frozen = r.frozen || r.kind === 'beku';
  const n = M.roles.filter(x => x.room === r.id && !x.archived).length;
  const wt = (r.worktrees || []).length;
  return `<tr><td><b>${esc(r.name)}</b>${frozen ? ' <span class="st off">Beku</span>' : ''}</td><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td><td>${r.path ? `<code>${esc(r.path)}</code>` : '<span class="hint">-</span>'}</td><td class="num">${wt}</td><td class="num">${n}</td>
    <td><div class="btn-row" style="flex-wrap:nowrap"><button class="btn sm" data-act="rl-room-rename" data-room="${esc(r.id)}">Ganti nama</button><button class="btn sm" data-act="rl-room-freeze" data-room="${esc(r.id)}" data-v="${frozen ? 0 : 1}">${frozen ? 'Cairkan' : 'Bekukan'}</button>${r.extra ? `<button class="btn sm danger" data-act="rl-room-remove" data-room="${esc(r.id)}">Hapus</button>` : ''}</div></td></tr>`;
}

function draw() {
  if (!M.el) return;
  const active = M.roles.filter(r => !r.archived), arch = M.roles.filter(r => r.archived);
  const rooms = roomsOf(M.ctx).filter(r => !NO_DESK.includes(r.kind));
  M.el.innerHTML = `<div class="roles-head"><div><h2>Role</h2><p class="sub">Role adalah karyawan tetap kantor ini. Satu role bisa punya beberapa sesi paralel.</p></div><button class="btn primary" data-act="rl-new">Tambah role</button></div>
    <div class="role-grid">${active.map(roleCardHTML).join('') || '<p class="empty-line">Belum ada role.</p>'}</div>
    ${arch.length ? `<div class="rl-arch"><button class="btn sm ghost" data-act="rl-toggle-arch">${M.showArchived ? 'Sembunyikan' : 'Tampilkan'} ${arch.length} role diarsipkan</button>${M.showArchived ? `<div class="role-grid" style="margin-top:10px">${arch.map(roleCardHTML).join('')}</div>` : ''}</div>` : ''}
    <section class="rl-rooms"><div class="roles-head"><div><h2>Ruangan</h2><p class="sub">Setiap ruangan kode terhubung ke satu folder. Ruangan beku tidak dipakai untuk sesi baru.</p></div><button class="btn" data-act="rl-room-new">Tambah ruangan</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nama</th><th>Jenis</th><th>Folder</th><th class="num">Worktree</th><th class="num">Penghuni</th><th></th></tr></thead><tbody>${rooms.map(roomRowHTML).join('')}</tbody></table></div></section>`;
}

async function onTabClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const ctx = M.ctx, act = b.dataset.act, id = b.dataset.role, room = b.dataset.room;
  if (act === 'rl-new') openRoleEditor(ctx, null);
  else if (act === 'rl-edit') openRoleEditor(ctx, id);
  else if (act === 'rl-profile') openRole(ctx, id);
  else if (act === 'rl-pb-new') newPlaybookFor(ctx, M.roles.find(x => x.id === id), () => load().then(draw).catch(() => {}));
  else if (act === 'rl-shift') startShiftDialog(ctx, id);
  else if (act === 'rl-toggle-arch') { M.showArchived = !M.showArchived; draw(); }
  else if (act === 'rl-archive') archiveRole(id, b.dataset.v === '1');
  else if (act === 'rl-room-new') addRoomDialog();
  else if (act === 'rl-room-rename') renameRoom(room);
  else if (act === 'rl-room-freeze') roomPatch(room, { frozen: b.dataset.v === '1' }, b.dataset.v === '1' ? 'Ruangan dibekukan' : 'Ruangan dicairkan');
  else if (act === 'rl-room-remove') {
    const r = roomsOf(ctx).find(x => x.id === room);
    confirmDo('Hapus ruangan?', `Ruangan ${esc(r?.name || room)} dihapus dari denah. Folder di disk tidak disentuh. Hanya ruangan yang kamu tambah sendiri yang bisa dihapus.`, 'Hapus', () => roomPatch(room, { remove: true }, 'Ruangan dihapus'));
  }
}

async function archiveRole(id, v) {
  const r = M.roles.find(x => x.id === id);
  const run = async () => {
    try { await patch(`/api/offices/${oid(M.ctx)}/roles/${encodeURIComponent(id)}`, { archived: v }); toast(v ? 'Role diarsipkan' : 'Role dipulihkan', 'ok'); await load(); draw(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  if (v && liveSessions(M.ctx, id).length) { toast(`${r?.name || 'Role'} masih punya sesi aktif. Selesaikan dulu.`, 'warn'); return; }
  if (v) confirmDo('Arsipkan role?', `${esc(r?.name || id)} tidak lagi muncul di denah, tapi riwayat dan catatannya tetap ada. Bisa dipulihkan kapan saja.`, 'Arsipkan', run, 'primary');
  else run();
}

/* ---------------- ruangan ---------------- */
async function roomPatch(room, body, okMsg) {
  try { await patch(`/api/offices/${oid(M.ctx)}/rooms/${encodeURIComponent(room)}`, body); toast(okMsg, 'ok'); await load(); draw(); }
  catch (e) { toast(e.message, 'bad'); }
}
function renameRoom(room) {
  const r = roomsOf(M.ctx).find(x => x.id === room); if (!r) return;
  modal({ title: 'Ganti nama ruangan', html: `<div class="field"><label for="rl-rn">Nama baru</label><input id="rl-rn" value="${esc(r.name)}" autocomplete="off"></div>`,
    actions: [{ label: 'Simpan', kind: 'primary', fn: () => { const v = $('#rl-rn').value.trim(); if (!v) return false; roomPatch(room, { name: v }, 'Nama ruangan diganti'); } }, { label: 'Batal' }] });
}
// add-room dialog: browse the office folder, see the room on the floor plan before saving
let ra = null;
const prettyName = d => d.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function addRoomDialog() {
  ra = { dir: '', data: null, path: '', isNew: false, named: false, stage: null, view: 'room', t: 0, info: null };
  modal({ title: 'Tambah ruangan', html: `<div class="rm-add">
    <div class="rm-left">
      <div class="rf-row"><div class="field"><label for="rr-name">Nama</label><input id="rr-name" placeholder="mis. Admin Panel" autocomplete="off"></div>
        <div class="field"><label for="rr-kind">Jenis</label><select id="rr-kind">${Object.entries(ROOM_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div></div>
      <div class="field"><label>Folder</label>
        <div class="fb"><div class="fb-crumbs" id="fbCrumbs"></div><ul class="fb-list" id="fbList"><li class="fb-empty">Memuat…</li></ul>
          <div class="fb-foot"><button type="button" class="btn sm" data-fb="none">Tanpa folder</button><button type="button" class="btn sm" data-fb="new">Folder baru di sini</button></div>
          <div class="fb-new" id="fbNew" hidden><input id="rr-new" placeholder="nama-folder-baru" autocomplete="off"><label class="check"><input type="checkbox" id="rr-git"> git init</label></div></div>
        <p class="hint" id="fbSel"></p></div>
    </div>
    <div class="rm-right">
      <div class="rm-pv"><div class="rm-pv-stage" id="rmPv"></div>
        <div class="rm-pv-tools"><button type="button" data-fb="view-room" aria-pressed="true">Ruangan ini</button><button type="button" data-fb="view-all" aria-pressed="false">Seluruh lantai</button></div></div>
      <div class="rm-pv-info" id="rmPvInfo"></div>
    </div></div>`,
    actions: [{ label: 'Tambah ruangan', kind: 'primary', fn: submitRoom }, { label: 'Batal' }] });
  const card = $('#modalCard');
  if (!card.dataset.raBound) {
    card.dataset.raBound = 1;
    card.addEventListener('click', e => { if (ra && $('.rm-add', card)) onRoomClick(e); });
    card.addEventListener('input', e => {
      if (!ra || !$('.rm-add', card)) return;
      if (e.target.id === 'rr-name') { ra.named = !!e.target.value.trim(); preview(); }
      if (e.target.id === 'rr-new') { const v = e.target.value.trim().replace(/[\/\\]/g, ''); ra.isNew = !!v; ra.path = v ? (ra.dir ? `${ra.dir}/${v}` : v) : ra.dir; autoName(v); selLine(); preview(); }
    });
    card.addEventListener('change', e => { if (ra && e.target.id === 'rr-kind') preview(); });
  }
  browse('');
  preview();
}
async function browse(dir) {
  try { ra.data = await api(`/api/offices/${oid(M.ctx)}/browse?dir=${encodeURIComponent(dir)}`); } catch (e) { toast(e.message, 'bad'); return; }
  ra.dir = ra.data.dir; ra.path = ra.dir; ra.isNew = false;
  const nw = $('#fbNew'); if (nw) { nw.hidden = true; $('#rr-new').value = ''; }
  autoName(ra.dir.split('/').pop());
  drawBrowser(); selLine(); preview();
}
function autoName(base) { const n = $('#rr-name'); if (n && !ra.named) n.value = base ? prettyName(base) : ''; }
function drawBrowser() {
  const d = ra.data, parts = d.dir ? d.dir.split('/') : [];
  $('#fbCrumbs').innerHTML = `<button type="button" data-fb="go" data-dir="">${esc(M.ctx.office.name)}</button>` + parts.map((p, i) => `<span>/</span><button type="button" data-fb="go" data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('');
  const badge = e => [e.git ? '<i class="fb-b git">git</i>' : '', e.stack ? `<i class="fb-b">${esc(e.stack)}</i>` : '', e.md ? '<i class="fb-b md" title="Ada CLAUDE.md">CLAUDE.md</i>' : '', e.room ? `<i class="fb-b used">${esc(e.room)}</i>` : ''].join('');
  $('#fbList').innerHTML = (d.dir ? `<li><button type="button" class="fb-row up" data-fb="go" data-dir="${esc(parts.slice(0, -1).join('/'))}"><span class="fb-ic">↑</span><span class="fb-nm">..</span></button></li>` : '')
    + (d.entries.length ? d.entries.map(e => `<li><button type="button" class="fb-row${e.room ? ' used' : ''}" data-fb="go" data-dir="${esc(e.rel)}" title="${e.room ? `Sudah jadi ruangan ${esc(e.room)}` : 'Pilih folder ini'}"><span class="fb-ic">${e.git ? '◆' : '▸'}</span><span class="fb-nm">${esc(e.name)}</span><span class="fb-bs">${badge(e)}</span>${e.kids ? '<span class="fb-go">›</span>' : ''}</button></li>`).join('')
      : '<li class="fb-empty">Tidak ada subfolder.</li>');
}
function selLine() {
  const el = $('#fbSel'); if (!el) return;
  const used = !ra.isNew && ra.data?.info?.room;
  el.innerHTML = !ra.path ? 'Tanpa folder: ruangan non-kode (tidak terhubung ke folder mana pun).'
    : used ? `<span class="warn-t">Folder <code>${esc(ra.path)}/</code> sudah dipakai ruangan ${esc(used)}.</span>`
    : `Folder terpilih: <code>${esc(ra.path)}/</code>${ra.isNew ? ' (akan dibuat)' : ''}`;
}
function onRoomClick(e) {
  const t = e.target.closest('[data-fb]'); if (!t) return;
  const a = t.dataset.fb;
  if (a === 'go') browse(t.dataset.dir);
  else if (a === 'none') browse('');
  else if (a === 'new') { const nw = $('#fbNew'); nw.hidden = !nw.hidden; if (!nw.hidden) $('#rr-new').focus(); }
  else if (a === 'view-room' || a === 'view-all') {
    ra.view = a === 'view-room' ? 'room' : 'all';
    $$('.rm-pv-tools button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fb === a)));
    if (ra.stage) ra.view === 'room' ? ra.stage.focusRoom('__pv') : ra.stage.fitAll();
  }
}
function preview() {
  clearTimeout(ra.t);
  ra.t = setTimeout(async () => {
    const body = { name: $('#rr-name')?.value || '', kind: $('#rr-kind')?.value || 'kode', path: ra.path };
    let r;
    try { r = await post(`/api/offices/${oid(M.ctx)}/rooms/preview`, body); } catch (e) { $('#rmPvInfo').innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; return; }
    if (!$('#rmPv')) return;
    const moved = new Set(r.moved.map(m => m.sid));
    const sessions = M.ctx.office.sessions.filter(s => s.status !== 'ended').map(s => moved.has(s.sid) ? { ...s, room: '__pv' } : s);
    $('#rmPv').querySelector('canvas')?.remove();
    ra.stage = createStage($('#rmPv'), { plan: r.plan, roles: M.ctx.office.roles, sessions, cards: [], fill: true, animateArrivals: false, insets: { left: 6, top: 6, right: 6, bottom: 6 }, onPick: () => {}, onRoom: () => {} });
    ra.stage.select('__pv');
    if (ra.view === 'room') ra.stage.focusRoom('__pv', true); else ra.stage.fitAll();
    pvInfo(r);
  }, 220);
}
function pvInfo(r) {
  const info = !ra.isNew && ra.path ? ra.data?.info : null, room = r.room;
  const rows = [];
  rows.push(`<h3>${esc(room.name)}</h3><p class="hint">${esc(ROOM_KINDS[room.kind] || room.kind)}${room.stack ? ' · ' + esc(room.stack) : ''}</p>`);
  const facts = [];
  if (ra.path) facts.push(['Folder', `<code>${esc(ra.path)}/</code>${ra.isNew ? ' · akan dibuat' + ($('#rr-git')?.checked ? ' + git init' : '') : ''}`]);
  if (info?.git) facts.push(['Git', `repo${info.branch ? ` · branch <code>${esc(info.branch)}</code>` : ''}`]);
  if (info) facts.push(['Aturan', info.md ? 'Ada <code>CLAUDE.md</code>: dibaca otomatis oleh shift di ruangan ini' : 'Belum ada CLAUDE.md']);
  if (info?.readme) facts.push(['README', esc(short(info.readme, 140))]);
  if (info) facts.push(['Isi', `${info.files} item`]);
  rows.push(`<dl class="pv-dl">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`);
  if (r.moved.length) rows.push(`<p class="pv-moved"><b>${r.moved.length} sesi pindah ke sini</b> karena foldernya di dalam ${esc(ra.path)}/: ${r.moved.map(m => esc(roleName(m.role) || short(m.title || 'sesi', 26)) + (m.from ? ` <span class="hint">(dari ${esc(m.from)})</span>` : '')).join(', ')}</p>`);
  rows.push(`<p class="hint">${ra.path ? 'Sesi yang dibuka di folder ini otomatis duduk di sini. Role yang ditempatkan di ruangan ini memulai shift di folder ini.' : 'Ruangan tanpa folder cocok untuk ruang fungsi; shift role di sini mulai di folder kantor.'}</p>`);
  $('#rmPvInfo').innerHTML = rows.join('');
}
const roleName = id => id && (M.ctx.office.roles.find(r => r.id === id)?.name);
function submitRoom() {
  const name = $('#rr-name').value.trim(); if (!name) { toast('Nama ruangan wajib diisi', 'warn'); return false; }
  if (!ra.isNew && ra.path && ra.data?.info?.room) { toast(`Folder itu sudah dipakai ruangan ${ra.data.info.room}`, 'warn'); return false; }
  const body = { name, kind: $('#rr-kind').value, path: ra.path, create: ra.isNew, gitInit: ra.isNew && $('#rr-git').checked };
  post(`/api/offices/${oid(M.ctx)}/rooms`, body).then(() => { toast('Ruangan ditambah', 'ok'); closeModal(); ra = null; return load().then(draw); }).catch(e => toast(e.message, 'bad'));
  return false;
}

/* ---------------- editor role ---------------- */
export function openRoleEditor(ctx, roleId) {
  const cur = roleId ? (M.roles.find(r => r.id === roleId) || ctx.office.roles.find(r => r.id === roleId)) : null;
  if (roleId && !cur) { toast('Role tidak ditemukan', 'warn'); return; }
  const rooms = ctx.office.plan.rooms.filter(r => !NO_DESK.includes(r.kind));
  rf = { ctx, id: roleId || null, skills: [...(cur?.skills || [])], color: cur?.color || SWATCHES[0], hair: cur?.hair || HAIRS[0], skin: cur?.skin || SKINS[0], hairStyle: cur?.hairStyle || 'short', outfit: cur?.outfit || 'kemeja', acc: cur?.acc || '', hijab: cur?.hijab || HIJABS[0], tie: !!cur?.tie };
  const sel = (arr, v) => arr.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const swatch = (list, act, v) => list.map(c => `<button type="button" class="sw" style="background:${c}" data-act="${act}" data-c="${c}" aria-pressed="${c === v}" aria-label="Warna ${c}"></button>`).join('');
  modal({ title: cur ? `Ubah role ${cur.name}` : 'Tambah role', html: `<div class="role-form">
    <div class="rf-preview"><div id="rfPreview"></div><p class="nm" id="rfPrevName"></p><p class="hint" id="rfPrevTitle"></p></div>
    <div class="rf-fields">
      <div class="field"><label for="rf-name">Nama</label><input id="rf-name" value="${esc(cur?.name || '')}" placeholder="mis. Gilang" autocomplete="off"></div>
      <div class="field"><label for="rf-title">Jabatan</label><input id="rf-title" value="${esc(cur?.title || '')}" placeholder="mis. Desainer UI" autocomplete="off"></div>
      <div class="field"><label for="rf-persona">Kepribadian</label><textarea id="rf-persona" rows="4" placeholder="Cara dia bicara, apa yang dia pedulikan, apa yang tidak pernah dia lakukan">${esc(cur?.persona || '')}</textarea>
        <p class="hint">Teks ini menjadi system prompt role: Claude membacanya setiap kali shift dimulai.</p></div>
      <div class="field"><label for="rf-skill">Skills</label><div class="skill-box"><div class="chips" id="rfSkills"></div><input id="rf-skill" placeholder="Ketik lalu Enter" autocomplete="off"></div>
        <div class="sugs">${SKILL_SUGS.map(s => `<button type="button" data-act="rl-skill-sug" data-skill="${s}">+ ${s}</button>`).join('')}</div></div>
      <div class="field"><label for="rf-engine">Mesin</label><select id="rf-engine">${sel([['claude', 'Claude Code'], ['codex', 'OpenAI Codex']], cur?.engine === 'codex' ? 'codex' : 'claude')}</select></div>
      <div id="rf-cx"${cur?.engine === 'codex' ? '' : ' hidden'}></div>
      <div class="grid2"><div class="field" id="rf-claude-model"${cur?.engine === 'codex' ? ' hidden' : ''}><label for="rf-model">Model</label><select id="rf-model">${sel(MODEL_OPTS, cur?.engine === 'codex' ? 'sonnet' : cur?.model || 'sonnet')}</select></div>
        <div class="field"><label for="rf-room">Ruangan</label><select id="rf-room">${sel(rooms.map(r => [r.id, r.name + (r.path ? ' · ' + r.path : '')]), cur?.room || rooms.find(r => r.kind === 'kode')?.id || rooms[0]?.id)}</select></div></div>
      ${cur?.isMgr ? '' : `<div class="field"><label for="rf-boss">Atasan</label><select id="rf-boss"><option value="">Langsung di bawah manager</option>${(M.roles.length ? M.roles : ctx.office.roles).filter(r => !r.archived && !r.isMgr && r.id !== roleId).map(r => `<option value="${esc(r.id)}"${cur?.reportsTo === r.id ? ' selected' : ''}>${esc(r.name)} · ${esc(r.title)}</option>`).join('')}</select></div>`}
      <div class="field"><label for="rf-budget">Anggaran harian</label><input id="rf-budget" type="number" min="0" step="any" value="${cur?.budget || ''}" placeholder="kosong = tanpa batas" inputmode="decimal">
        <p class="hint">Role Claude: dolar per hari (setara tarif API). Role Codex: jumlah token per hari. Di 80% agen diingatkan, di 100% diminta menyimpan pekerjaan dan berhenti.</p></div>
      <div class="field"><label>Template karakter</label><div class="tpl-grid" id="rfTpl">${TEMPLATES.map(t => `<button type="button" class="tpl" data-act="rl-tpl" data-id="${t.id}" title="${esc(t.name)}">${sprite(t.look, 2)}<span>${esc(t.name)}</span></button>`).join('')}</div>
        <button type="button" class="btn sm" data-act="rl-rand" style="margin-top:8px">🎲 Acak</button></div>
      <div class="field"><label>Warna seragam</label><div class="swatches" id="rfColors">${swatch(SWATCHES, 'rl-sw-color', rf.color)}</div></div>
      <div class="grid2"><div class="field"><label>Warna kulit</label><div class="swatches" id="rfSkin">${swatch(SKINS, 'rl-sw-skin', rf.skin)}</div></div>
        <div class="field"><label>Warna rambut</label><div class="swatches" id="rfHair">${swatch(HAIRS, 'rl-sw-hair', rf.hair)}</div></div></div>
      <div class="grid2"><div class="field"><label for="rf-style">Gaya rambut</label><select id="rf-style">${sel(Object.entries(HAIR_STYLES), rf.hairStyle)}</select></div>
        <div class="field"><label for="rf-outfit">Pakaian</label><select id="rf-outfit">${sel(Object.entries(OUTFITS), rf.outfit)}</select></div></div>
      <div class="grid2"><div class="field"><label for="rf-acc">Aksesori</label><select id="rf-acc">${sel(Object.entries(ACCS), rf.acc)}</select></div>
        <div class="field" id="rfHijabF"><label>Warna hijab</label><div class="swatches" id="rfHijab">${swatch(HIJABS, 'rl-sw-hijab', rf.hijab)}</div></div></div>
      <label class="check"><input type="checkbox" id="rf-mgr"${cur?.isMgr ? ' checked' : ''}${cur ? ' disabled' : ''}> Manager (memecah permintaan jadi kartu dan boleh memulai shift role lain)</label>
      ${cur ? '<p class="hint">Status manager ditetapkan saat role dibuat.</p>' : ''}
    </div></div>`,
    actions: [{ label: cur ? 'Simpan' : 'Buat role', kind: 'primary', fn: () => { saveRole(); return false; } }, { label: 'Batal' }] });
  refreshSkills(); refreshPreview();
  rf.cx = { model: cur?.model, effort: cur?.effort };
  if (cur?.engine === 'codex') mountCodexFields($('#rf-cx'), 'rcx', rf.cx);
}
const rfLook = () => ({ color: rf.color, hair: rf.hair, skin: rf.skin, hairStyle: $('#rf-style')?.value || rf.hairStyle, outfit: $('#rf-outfit')?.value || rf.outfit, acc: $('#rf-acc')?.value ?? rf.acc, hijab: rf.hijab, tie: rf.tie });
/** Push a look into rf and every control that shows it. */
function setLook(look) {
  applyLook(rf, look);
  $('#rf-style').value = rf.hairStyle; $('#rf-outfit').value = rf.outfit; $('#rf-acc').value = rf.acc;
  pressSwatch('#rfColors', rf.color); pressSwatch('#rfSkin', rf.skin); pressSwatch('#rfHair', rf.hair); pressSwatch('#rfHijab', rf.hijab);
  refreshPreview();
}
function refreshSkills() { const el = $('#rfSkills'); if (el && rf) el.innerHTML = rf.skills.map((s, i) => `<span class="chip">${esc(s)}<button type="button" data-act="rl-skill-del" data-i="${i}" aria-label="Hapus ${esc(s)}">×</button></span>`).join(''); }
function refreshPreview() {
  const el = $('#rfPreview'); if (!el || !rf) return;
  Object.assign(rf, rfLook());
  if (rf.hairStyle === 'hijab' && rf.acc === 'topi') { rf.acc = ''; $('#rf-acc').value = ''; }
  const hf = $('#rfHijabF'); if (hf) hf.hidden = rf.hairStyle !== 'hijab';
  $$('#rfTpl .tpl').forEach(b => b.classList.toggle('on', Object.entries(templateOf(b.dataset.id).look).every(([k, v]) => rf[k] === v)));
  el.innerHTML = sprite({ ...rf, tie: rf.tie }, 5);
  $('#rfPrevName').textContent = $('#rf-name').value.trim() || 'Role baru';
  $('#rfPrevTitle').textContent = $('#rf-title').value.trim() || 'Jabatan';
}
function addSkill(s) { s = s.trim().toLowerCase().replace(/\s+/g, '-'); if (s && rf && !rf.skills.includes(s)) { rf.skills.push(s); refreshSkills(); } }
function pressSwatch(box, c) { $$('.sw', $(box)).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === c))); }

function roleEngineBody() {
  if ($('#rf-engine')?.value !== 'codex') return { engine: 'claude', model: $('#rf-model').value };
  const v = codexValues('rcx');
  return { engine: 'codex', model: v.model, effort: v.effort };
}
function toggleEngine() {
  const cx = $('#rf-engine').value === 'codex';
  $('#rf-cx').hidden = !cx; $('#rf-claude-model').hidden = cx;
  if (cx && !$('#rcx-model')) mountCodexFields($('#rf-cx'), 'rcx', rf.cx || {});
}
async function saveRole() {
  const name = $('#rf-name').value.trim(), title = $('#rf-title').value.trim();
  if (!name || !title) { toast('Nama dan jabatan wajib diisi', 'warn'); return; }
  const pending = $('#rf-skill').value; if (pending.trim()) addSkill(pending);
  const isMgr = $('#rf-mgr').checked;
  const body = { name, title, persona: $('#rf-persona').value.trim(), skills: rf.skills, ...roleEngineBody(), room: $('#rf-room').value,
    color: rf.color, hair: rf.hair, skin: rf.skin, hairStyle: rf.hairStyle, outfit: rf.outfit, acc: rf.acc, hijab: rf.hijab, tie: rf.tie, budget: Number($('#rf-budget').value) || null, ...($('#rf-boss') ? { reportsTo: $('#rf-boss').value || null } : {}) };
  const { ctx, id } = rf;
  try {
    if (id) await patch(`/api/offices/${oid(ctx)}/roles/${encodeURIComponent(id)}`, body);
    else await post(`/api/offices/${oid(ctx)}/roles`, { ...body, isMgr });
    closeModal(); toast(id ? 'Role disimpan' : 'Role dibuat', 'ok');
    if (M.el?.isConnected) { await load(); draw(); }
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- mulai shift ---------------- */
export async function startShiftDialog(ctx, roleId, opts = {}) {
  const roles = ctx.office.roles.filter(r => !r.archived);
  if (!roles.length) { toast('Belum ada role', 'warn'); return; }
  let pick = roleId && roles.find(r => r.id === roleId)?.id;
  if (!pick && opts.room) pick = roles.find(r => r.room === opts.room)?.id;
  pick = pick || roles[0].id;
  let cards = [];
  try { cards = (await api(`/api/offices/${oid(ctx)}/board?board=all`)).cards.filter(c => !c.done); } catch {}
  shift = { ctx, cards };
  modal({ title: 'Mulai shift', html: `<div class="rf-fields">
      <div class="field"><label for="sh-role">Role</label><select id="sh-role">${roles.map(r => `<option value="${esc(r.id)}"${r.id === pick ? ' selected' : ''}>${esc(r.name)} · ${esc(r.title)}${opts.room && r.room === opts.room ? ' (ruangan ini)' : ''}</option>`).join('')}</select></div>
      <div class="field"><label for="sh-engine">Mesin</label><select id="sh-engine"><option value="claude">Claude Code</option><option value="codex">OpenAI Codex</option></select></div>
      <div id="sh-cx" hidden></div>
      <div id="sh-par"></div>
      <div class="field"><label for="sh-task">Tugas pertama (opsional)</label><textarea id="sh-task" rows="3" placeholder="mis. perbaiki bug login lalu jalankan tes"></textarea></div>
      <div class="field"><label for="sh-card">Kartu (opsional)</label><select id="sh-card"></select></div>
      <div class="field"><label for="sh-perm">Mode izin</label><select id="sh-perm">${PERMS.map(([v, l]) => `<option value="${v}"${v === lastPerm() ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><p class="hint" id="sh-perm-warn" hidden>Role ini akan menjalankan perintah apa pun tanpa bertanya, termasuk yang menyentuh prod. Kotak masuk izin tidak akan dipakai.</p></div></div>`,
    actions: [{ label: 'Mulai shift', kind: 'primary', fn: () => { submitShift(); return false; } }, { label: 'Batal' }] });
  refreshShift();
  { const w = $('#sh-perm-warn'); if (w) w.hidden = lastPerm() !== 'bypassPermissions'; }
}
function refreshShift() {
  if (!shift) return;
  const { ctx, cards } = shift, id = $('#sh-role').value, n = liveSessions(ctx, id).length;
  if (shift.last !== id) { shift.last = id; const r = ctx.office.roles.find(x => x.id === id); $('#sh-engine').value = isCodex(r) ? 'codex' : 'claude'; shift.role = r; syncShiftEngine(); }
  $('#sh-par').innerHTML = n ? `<div class="note-ro">Ini sesi paralel ke-${n + 1} untuk role ini.</div><label class="check" style="margin-top:8px"><input type="checkbox" id="sh-wt" checked> Pakai worktree terpisah</label><p class="hint">Disarankan kalau dua sesi mengedit repo yang sama, supaya perubahannya tidak bertabrakan.</p>` : '';
  const mine = cards.filter(c => !c.who || c.who === id);
  $('#sh-card').innerHTML = `<option value="">Tanpa kartu</option>${mine.map(c => `<option value="${esc(c.id)}">${esc(short(c.title, 60))}${c.who ? '' : ' (belum ditugaskan)'}</option>`).join('')}`;
}
async function syncShiftEngine() {
  const cx = $('#sh-engine').value === 'codex', box = $('#sh-cx'), perm = $('#sh-perm');
  box.hidden = !cx;
  const old = perm.value;
  perm.innerHTML = cx ? CODEX_MODES.map(([v, l]) => `<option value="${v}"${v === 'default' ? ' selected' : ''}>${esc(l)}</option>`).join('')
    : PERMS.map(([v, l]) => `<option value="${v}"${v === lastPerm() ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const w = $('#sh-perm-warn'); if (w) w.hidden = perm.value !== 'bypassPermissions';
  if (cx) { const r = shift.role; await mountCodexFields(box, 'scx', isCodex(r) ? { model: r.model, effort: r.effort } : {}); }
}
async function submitShift() {
  const { ctx } = shift, id = $('#sh-role').value;
  const body = {};
  const task = $('#sh-task').value.trim(), card = $('#sh-card').value, perm = $('#sh-perm').value;
  const cx = $('#sh-engine').value === 'codex';
  if (!cx) try { localStorage.setItem('kc.perm', perm); } catch {}
  if (cx) { const v = codexValues('scx'); body.engine = 'codex'; if (v.model) body.model = v.model; if (v.effort) body.effort = v.effort; }
  else if (shift.role?.engine === 'codex') body.engine = 'claude';
  if (task) body.task = task;
  if (card) body.cardId = card;
  if (perm) body.permissionMode = perm;
  if ($('#sh-wt')?.checked) body.worktree = true;
  try {
    const r = await post(`/api/offices/${oid(ctx)}/roles/${encodeURIComponent(id)}/start`, body);
    closeModal(); toast('Shift dimulai', 'ok');
    openWhenReady(ctx, r.sid);
  } catch (e) { toast(e.message, 'bad'); }
}
/** Sesi baru muncul di ctx lewat event live; tunggu sebentar lalu buka. */
export function openWhenReady(ctx, sid, tries = 0) {
  setTimeout(() => {
    if (ctx.office.sessions.some(s => s.sid === sid)) openSession(ctx, sid, 'term');
    else if (tries < 5) openWhenReady(ctx, sid, tries + 1);
  }, tries ? 1000 : 1500);
}

/* ---------------- listener modal (editor + dialog) ---------------- */
document.addEventListener('click', e => {
  const b = e.target.closest('#modalCard [data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'rl-skill-sug') addSkill(b.dataset.skill);
  else if (act === 'rl-skill-del' && rf) { rf.skills.splice(Number(b.dataset.i), 1); refreshSkills(); }
  else if (act === 'rl-sw-color' && rf) { rf.color = b.dataset.c; pressSwatch('#rfColors', rf.color); refreshPreview(); }
  else if (act === 'rl-sw-skin' && rf) { rf.skin = b.dataset.c; pressSwatch('#rfSkin', rf.skin); refreshPreview(); }
  else if (act === 'rl-tpl' && rf) setLook(templateOf(b.dataset.id).look);
  else if (act === 'rl-rand' && rf) setLook(randomLook());
  else if (act === 'rl-sw-hijab' && rf) { rf.hijab = b.dataset.c; pressSwatch('#rfHijab', rf.hijab); refreshPreview(); }
  else if (act === 'rl-sw-hair' && rf) { rf.hair = b.dataset.c; pressSwatch('#rfHair', rf.hair); refreshPreview(); }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'rf-skill' && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); addSkill(e.target.value); e.target.value = ''; }
});
document.addEventListener('input', e => {
  if (e.target.id === 'rf-engine' && rf) toggleEngine();
  if (e.target.id === 'rf-name' || e.target.id === 'rf-title') refreshPreview();
});
document.addEventListener('change', e => {
  if (e.target.id === 'sh-role') refreshShift();
  else if (e.target.id === 'sh-engine') syncShiftEngine();
  else if (e.target.id === 'sh-perm') { const w = $('#sh-perm-warn'); if (w) w.hidden = e.target.value !== 'bypassPermissions'; }
  else if (e.target.id === 'rf-mgr') { if (rf && e.target.checked && ['kemeja', 'jas'].includes($('#rf-outfit').value)) rf.tie = !isFem(rfLook()); refreshPreview(); }
  else if (['rf-style', 'rf-outfit', 'rf-acc'].includes(e.target.id)) refreshPreview();
  else if (e.target.id === 'rr-folder') { const nw = e.target.value === '__new'; $('#rr-new').hidden = !nw; if (nw) { $('#rr-create').checked = true; $('#rr-new').focus(); } }
});
