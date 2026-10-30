// Tab Chat di kantor: daftar agen di kiri, percakapan sesi terpilih di kanan (satu kolom bergantian di HP).
import { $, esc, short, sprite, guestLook, modelName, api, post, toast, confirmDo, debounce } from './util.js';
import { mountChat } from './chat.js';
import { isCodex, codexBadge, modeOptions, pickCodexSettings, codexSessSub } from './codex.js';
import { isAntigravity } from './antigravity.js';
import { openSession, pickModel, MODE_LABEL, HOSTS, stopFlow, bgCount } from './drawer.js';
import { startShiftDialog } from './roles.js';
import { drawerState, closeDrawer } from './panel.js';

if (!document.getElementById('chatmodeCss')) {
  const l = document.createElement('link');
  l.id = 'chatmodeCss'; l.rel = 'stylesheet'; l.href = new URL('../css/chatmode.css', import.meta.url).href;
  document.head.appendChild(l);
}

const STATUS = { starting: 'Memulai', working: 'Bekerja', idle: 'Idle', waiting: 'Menunggu izin', ended: 'Selesai' };
const GROUPS = [['wait', 'Menunggu kamu'], ['work', 'Bekerja'], ['idle', 'Idle'], ['off', 'Libur']];
const ACTIONS = {
  esc: { ok: 'Esc dikirim' },
  compact: { ok: 'Meminta ringkasan' },
  clear: { ok: 'Konteks direset', title: 'Reset percakapan?', body: 'Percakapan sesi ini dikosongkan (/clear). Buku catatan role tetap ada.', label: 'Reset' },
  exit: { ok: 'Sesi ditutup', title: 'Selesaikan sesi?', body: 'Claude diminta keluar dengan /exit.', label: 'Selesai' },
  kill: { ok: 'Sesi dipaksa tutup', title: 'Paksa tutup sesi?', body: 'Proses Claude dimatikan langsung. Pekerjaan yang belum disimpan bisa hilang.', label: 'Paksa tutup' },
};
const narrow = () => matchMedia('(max-width: 900px)').matches;
const enc = encodeURIComponent;

const M = { ctx: null, el: null, sid: null, q: '', chat: null, chatSid: null, queue: new Map(), draft: '', focusNext: false, shiftSids: null, offs: [] };

const roleOf = id => M.ctx.office.roles.find(r => r.id === id);
const liveSess = () => M.ctx.office.sessions.filter(s => s.status !== 'ended');
const findSess = sid => M.ctx.office.sessions.find(s => s.sid === sid);
const roomName = id => M.ctx.office.plan.rooms.find(r => r.id === id)?.name || '';
const look = s => roleOf(s.role) || guestLook(s.sid);
function nameOf(s) {
  const r = roleOf(s.role);
  if (r) return r.name + (s.slot > 0 ? ' #' + (s.slot + 1) : '');
  return !s.title || s.title === 'Sesi belum terhubung' ? 'Sesi manual' : s.title;
}
function subOf(s) {
  const r = roleOf(s.role), model = s.model ? modelName(s.model) : '';
  if (isAntigravity(s)) return [r?.title, s.model || 'Gemini bawaan'].filter(Boolean).join(' · ');
  if (isCodex(s)) return [r?.title || 'Tanpa role', codexSessSub(s), r ? '' : roomName(s.room)].filter(Boolean).join(' · ');
  if (r) return [r.title, modelName(r.model)].filter(Boolean).join(' · ');
  return ['Tanpa role', model, roomName(s.room)].filter(Boolean).join(' · ');
}
const typeable = s => { const tty = s.tty ? s.tty.replace('/dev/', '') : null; return !!tty && !['vscode', 'lain'].includes(s.host); };
const groupOf = s => s.waiting || s.status === 'waiting' || inboxOf(s.sid).length ? 'wait' : s.status === 'working' || s.status === 'starting' ? 'work' : 'idle';
const inboxOf = sid => (M.ctx.st?.inbox || []).filter(i => i.sid === sid);
function doing(s) {
  if (s.waiting) return `minta izin: ${s.waiting.tool || ''}`;
  if (s.tool) return `${s.tool.name || ''} ${s.tool.label || ''}`.trim();
  if (s.status === 'working' || s.status === 'starting') return 'sedang bekerja';
  if (!s.role && (!s.title || s.title === 'Sesi belum terhubung')) return `belum terhubung${s.host && s.host !== 'lain' ? ' · ' + HOSTS[s.host] : ''}`;
  return s.role ? ['idle', roomName(s.room)].filter(Boolean).join(' · ') : (s.host && s.host !== 'lain' ? HOSTS[s.host] : 'manual');
}

/* ---------------- tampilan ---------------- */
export async function render(el, ctx, r) {
  unmount();
  M.ctx = ctx; M.el = el; M.q = '';
  M.sid = r?.rest?.[0] || null;
  el.innerHTML = `<div class="cm" data-pane="list">
    <aside class="cm-side" aria-label="Daftar agen">
      <div class="cm-search"><input type="search" id="cmSearch" placeholder="Cari agen…  (Ctrl+K)" aria-label="Cari agen" autocomplete="off"></div>
      <div class="cm-list" id="cmList" role="listbox" aria-label="Agen"></div>
    </aside>
    <section class="cm-main" id="cmMain"></section></div>`;
  const root = $('.cm', el);
  $('#cmSearch', el).addEventListener('input', e => { M.q = e.target.value.trim().toLowerCase(); paintList(); });
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onFieldKey);
  root.addEventListener('input', e => { if (e.target.id === 'drQuickIn') { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; } });
  document.addEventListener('keydown', onKey, true);
  const obs = new MutationObserver(onDrawer);
  obs.observe($('#drawer'), { attributes: true, attributeFilter: ['hidden'] });
  M.offs = [() => document.removeEventListener('keydown', onKey, true), () => obs.disconnect()];
  document.documentElement.style.setProperty('--cm-top', $('.top').offsetHeight + 'px');
  paintList();
  loadQueues();
  // di layar lebar kolom kanan tidak boleh kosong: pilih agen teratas
  if (!M.sid && !narrow()) { const first = orderedLive()[0]; if (first) { M.sid = first.sid; history.replaceState(null, '', hashFor(first.sid)); } }
  select(M.sid, { silent: true });
}
export function route(r) {
  const sid = r?.rest?.[0] || null;
  if (sid === M.sid && M.chat) { setPane(); return; }
  select(sid, { silent: true });
}
export function unmount() {
  M.chat?.destroy(); M.chat = null; M.chatSid = null;
  for (const f of M.offs) f(); M.offs = [];
  M.el = null; M.shiftSids = null;
}
const hashFor = sid => `#/o/${enc(M.ctx.office.id)}/chat${sid ? '/' + enc(sid) : ''}`;
const go = sid => { if (location.hash === hashFor(sid)) route({ rest: sid ? [sid] : [] }); else location.hash = hashFor(sid); };

function setPane() {
  const root = $('.cm', M.el); if (!root) return;
  root.dataset.pane = M.sid ? 'chat' : 'list';
}

/* ---------------- daftar agen ---------------- */
function entries() {
  const o = M.ctx.office, out = [];
  const roles = o.roles.filter(r => !r.archived);
  const ss = liveSess();
  for (const r of roles) {
    const mine = ss.filter(s => s.role === r.id);
    if (!mine.length) out.push({ g: 'off', role: r, name: r.name, text: `${r.name} ${r.title} ${roomName(r.room)}` });
  }
  for (const s of ss) out.push({ g: groupOf(s), s, name: nameOf(s), text: `${nameOf(s)} ${subOf(s)} ${doing(s)}` });
  return out;
}
const matches = e => !M.q || e.text.toLowerCase().includes(M.q);
function ordered() {
  const o = M.ctx.office, rank = r => { const i = o.roles.findIndex(x => x.id === r); return i < 0 ? 999 : i; };
  const es = entries().filter(matches);
  return GROUPS.map(([g, label]) => ({ g, label, items: es.filter(e => e.g === g).sort((a, b) => (rank(a.s?.role ?? a.role?.id) - rank(b.s?.role ?? b.role?.id)) || (a.s?.slot || 0) - (b.s?.slot || 0)) }));
}
const orderedLive = () => ordered().flatMap(g => g.items).filter(e => e.s).map(e => e.s);

function itemHTML(e) {
  if (e.role) {
    const r = e.role;
    return `<button class="cm-ag off" role="option" data-act="cm-shift" data-role="${esc(r.id)}" title="Mulai shift ${esc(r.name)}"><span class="cm-ava">${sprite(r, 3)}</span><span class="cm-tx"><b>${esc(r.name)}</b><span>${esc([r.title, roomName(r.room)].filter(Boolean).join(' · '))}</span></span><span class="cm-go">Mulai shift</span></button>`;
  }
  const s = e.s, perm = inboxOf(s.sid).length, q = M.queue.get(s.sid) || 0, cur = s.sid === M.sid;
  const badges = (perm ? `<i class="cm-bd wait" title="${perm} izin menunggu">${perm} izin</i>` : '') + (q ? `<i class="cm-bd q" title="${q} pesan terkirim, belum dibaca">${q} antre</i>` : '') + (bgCount(s) > 0 ? `<i class="cm-bd q" title="Subagent masih jalan di latar">${bgCount(s)} sub</i>` : '');
  return `<button class="cm-ag st-${e.g}${cur ? ' cur' : ''}" role="option" aria-selected="${cur}" data-act="cm-pick" data-sid="${esc(s.sid)}"><span class="cm-ava">${sprite(look(s), 3)}<i class="cm-dot"></i></span><span class="cm-tx"><b>${esc(nameOf(s))}${codexBadge(s)}</b><span>${esc(short(doing(s), 60))}</span></span>${badges}</button>`;
}
function paintList() {
  const el = $('#cmList', M.el); if (!el) return;
  const top = el.scrollTop;
  const gs = ordered().filter(g => g.items.length);
  el.innerHTML = gs.map(g => `<div class="cm-grp" data-g="${g.g}"><h3>${esc(g.label)}<span>${g.items.length}</span></h3>${g.items.map(itemHTML).join('')}</div>`).join('')
    || `<p class="cm-none">${M.q ? 'Tidak ada agen yang cocok.' : 'Belum ada role atau sesi di kantor ini.'}</p>`;
  el.scrollTop = top;
  const cur = $('.cm-ag.cur', el); if (cur && !narrow()) cur.scrollIntoView({ block: 'nearest' });
}
async function loadQueues() {
  const ss = liveSess();
  await Promise.all(ss.map(async s => {
    try {
      const d = await api(`/api/sessions/${enc(s.sid)}/outbox`);
      const arr = Array.isArray(d) ? d : d.items || [];
      M.queue.set(s.sid, arr.filter(x => x.status === 'pending').length);
    } catch { M.queue.set(s.sid, 0); }
  }));
  if (M.el) paintList();
}
const reloadQueue = sid => api(`/api/sessions/${enc(sid)}/outbox`).then(d => { M.queue.set(sid, (Array.isArray(d) ? d : d.items || []).filter(x => x.status === 'pending').length); paintList(); }).catch(() => {});

/* ---------------- percakapan ---------------- */
function select(sid, { silent } = {}) {
  M.sid = sid;
  const main = $('#cmMain', M.el); if (!main) return;
  setPane();
  paintList();
  if (!sid) { destroyChat(); main.innerHTML = placeholder('Pilih agen untuk mulai ngobrol', 'Daftar di kiri menampilkan siapa yang menunggu kamu lebih dulu.'); return; }
  const s = findSess(sid);
  if (!s || s.status === 'ended') { destroyChat(); main.innerHTML = placeholder('Sesi ini sudah selesai', 'Pilih agen lain dari daftar.', true); return; }
  if (M.chatSid === sid && M.chat) return;
  destroyChat();
  if (drawerState().open) { main.innerHTML = placeholder('Terminal sedang terbuka di panel', 'Tutup panel untuk kembali ke percakapan.'); return; }
  main.innerHTML = `<header class="cm-head" id="cmHead"></header><div class="cm-body" id="cmBody"></div>`;
  paintHead();
  mountSel();
  void silent;
}
const placeholder = (t, sub, back) => `<div class="cm-empty">${narrow() || back ? '<button class="btn sm cm-back-inline" data-act="cm-back">← Daftar agen</button>' : ''}<b>${esc(t)}</b><p>${esc(sub)}</p></div>`;
function destroyChat() {
  if (M.chat) { M.draft = $('#drQuickIn', M.el)?.value || ''; M.chat.destroy(); }
  M.chat = null; M.chatSid = null;
}
function mountSel() {
  const body = $('#cmBody', M.el), sid = M.sid; if (!body) return;
  const s0 = findSess(sid);
  M.chatSid = sid;
  M.chat = mountChat(body, { ctx: M.ctx, sid, name: () => nameOf(findSess(sid) || s0), sess: () => findSess(sid) || s0,
    canSend: () => { const x = findSess(sid) || s0; return !!x.tmux || typeable(x); },
    send: text => sendAction(sid, 'text', text) });
  const ta = $('#drQuickIn', body);
  if (ta && M.draft) { ta.value = M.draft; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  M.draft = '';
  if (M.focusNext && ta && !ta.disabled) ta.focus();
  M.focusNext = false;
}
function modeSelect(s) {
  if (isAntigravity(s)) return '<button class="btn sm" data-act="cm-term" title="Gunakan /model atau /permissions di terminal">Model & izin Gemini</button>';
  if (isCodex(s)) return `<label class="cm-mode${s.permMode === 'bypassPermissions' ? ' danger' : ''}" title="Mode izin Codex."><select data-act="cm-mode" aria-label="Mode izin">${s.permMode ? '' : '<option value="">…</option>'}${modeOptions(s.permMode)}</select></label><button class="btn sm" data-act="cm-model" title="Ganti model dan effort Codex (sesi harus diam)">Model: ${esc(codexSessSub(s))}</button>`;
  return `<label class="cm-mode${s.permMode === 'bypassPermissions' ? ' danger' : ''}" title="Mode izin. Sama dengan menekan Shift+Tab di terminalnya."><select data-act="cm-mode" aria-label="Mode izin">${s.permMode ? '' : '<option value="">…</option>'}${['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].map(m => `<option value="${m}"${s.permMode === m ? ' selected' : ''}>Izin: ${MODE_LABEL[m]}</option>`).join('')}</select></label><button class="btn sm" data-act="cm-model" title="Ganti model sesi ini (/model)">Ganti model</button>`;
}
function paintHead() {
  const el = $('#cmHead', M.el), s = findSess(M.sid); if (!el || !s) return;
  const can = !!s.tmux || typeable(s), model = s.model ? modelName(s.model) : (roleOf(s.role) ? modelName(roleOf(s.role).model) : '');
  const st = s.waiting ? 'waiting' : s.status;
  const active = document.activeElement;
  const keepMode = active?.dataset?.act === 'cm-mode';
  const modeSlot = $('[data-slot="mode"]', el);
  if (keepMode && modeSlot) return; // jangan menutup dropdown yang sedang dipilih
  el.innerHTML = `<button class="icon-btn cm-back" data-act="cm-back" aria-label="Kembali ke daftar agen">←</button>
    <span class="cm-ava lg">${sprite(look(s), 4)}</span>
    <div class="cm-id"><div class="cm-name"><b>${esc(nameOf(s))}</b>${codexBadge(s)}<span class="st ${esc(st)}">${esc(s.tunggu && st === 'idle' ? s.tunggu.label : STATUS[st] || st)}</span>${s.anggaran === 'habis' ? '<span class="st wait">anggaran habis</span>' : ''}${s.compacting ? '<span class="st starting">Meringkas</span>' : ''}${bgCount(s) > 0 ? `<span class="st working" title="Subagent masih jalan di latar">${bgCount(s)} subagent latar</span>` : ''}</div><div class="cm-sub">${esc(subOf(s))}${model && !isCodex(s) && !subOf(s).includes(model) ? ' · ' + esc(model) : ''}</div></div>
    <div class="cm-tools"><span data-slot="mode">${s.tmux ? modeSelect(s) : ''}</span>
      <button class="btn sm halt" data-act="cm-action" data-a="esc" title="Hentikan pekerjaan yang sedang jalan (Esc)"${can ? '' : ' disabled'}>Hentikan</button>
      <button class="btn sm" data-act="cm-action" data-a="compact" title="/compact"${can ? '' : ' disabled'}>Ringkas</button>
      <button class="btn sm" data-act="cm-action" data-a="clear" title="/clear"${can ? '' : ' disabled'}>Reset</button>
      <button class="btn sm" data-act="cm-action" data-a="exit" title="Selesaikan sesi (/exit)"${can ? '' : ' disabled'}>Selesai</button>
      <button class="btn sm" data-act="cm-term" title="Buka terminal sesi ini di panel">Buka terminal</button></div>`;
}

/* ---------------- aksi ---------------- */
async function sendAction(sid, action, text) {
  try {
    const r = await post(`/api/sessions/${enc(sid)}/action`, text != null ? { action, text } : { action });
    if (r?.idle) { toast('Sesi sedang tidak bekerja, jadi tidak ada yang dihentikan.', 'ok'); return false; }
    return true;
  }
  catch (e) { toast(e.message, 'bad'); return false; }
}
function doAction(a) {
  const sid = M.sid, def = ACTIONS[a]; if (!sid || !def) return;
  if (a === 'esc' && bgCount(findSess(sid)) > 0) { stopFlow(findSess(sid), x => sendAction(sid, x).then(ok => ok && toast(x === 'stop-all' ? 'Semua dihentikan' : def.ok, 'ok'))); return; }
  const run = async () => { if (await sendAction(sid, a)) toast(def.ok, 'ok'); };
  if (!def.title) { run(); return; }
  const s = findSess(sid);
  const body = a === 'exit' && s?.worktree ? `${def.body} Sesi ini memakai worktree terpisah di ${esc(s.worktree)}; foldernya tetap ada di disk, jadi pastikan perubahan sudah di-commit.` : def.body;
  confirmDo(def.title, body, def.label, run, a === 'kill' ? 'danger' : 'primary');
}
async function onClick(e) {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'cm-model') { const cs = findSess(M.sid); if (isCodex(cs)) pickCodexSettings(cs); else pickModel(M.sid); }
  else if (act === 'cm-pick') { M.focusNext = false; go(b.dataset.sid); }
  else if (act === 'cm-back') go(null);
  else if (act === 'cm-action' || act === 'dr-action') doAction(b.dataset.a);
  else if (act === 'cm-term') { const s = findSess(M.sid); if (s) openSession(M.ctx, s.sid, 'term'); }
  else if (act === 'cm-shift') {
    M.shiftSids = { before: new Set(M.ctx.office.sessions.map(s => s.sid)), role: b.dataset.role, at: Date.now() };
    startShiftDialog(M.ctx, b.dataset.role);
  }
}
async function onChange(e) {
  if (e.target.dataset.act !== 'cm-mode' || !e.target.value) return;
  const sel = e.target, sid = M.sid;
  sel.disabled = true;
  try { const r = await post(`/api/sessions/${enc(sid)}/mode`, { mode: sel.value }); toast(`Mode izin: ${MODE_LABEL[r.mode] || r.mode}`, 'ok'); }
  catch (er) { toast(er.message, 'bad'); }
  const s = findSess(sid), slot = $('[data-slot="mode"]', M.el);
  if (s && slot) slot.innerHTML = modeSelect(s);
}
async function onSubmit(e) {
  if (e.target.id !== 'drQuick' || !M.sid) return;
  e.preventDefault();
  const input = $('#drQuickIn', M.el), text = input.value.trim(); if (!text) return;
  if (await sendAction(M.sid, 'text', text)) { input.value = ''; input.style.height = 'auto'; M.chat?.refresh(); }
}
function onFieldKey(e) {
  if (e.target.id === 'drQuickIn' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form?.requestSubmit(); }
}

/* ---------------- keyboard ---------------- */
const typing = t => t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(t.type) || t.tagName === 'SELECT' || t.isContentEditable);
function onKey(e) {
  if (!M.el || !$('#modal').hidden) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault(); e.stopPropagation();
    if (M.sid && narrow()) go(null);
    const i = $('#cmSearch', M.el); requestAnimationFrame(() => { i.focus(); i.select(); }); return;
  }
  const t = e.target, inSearch = t.id === 'cmSearch';
  if (e.key === 'Escape') {
    if (inSearch && t.value) { t.value = ''; M.q = ''; paintList(); e.stopPropagation(); return; }
    if (drawerState().open) return;
    if (narrow()) { if (M.sid) { go(null); e.stopPropagation(); } return; }
    if (t.id === 'drQuickIn' || inSearch) { t.blur(); e.stopPropagation(); }
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (!typing(t) || inSearch)) {
    const list = orderedLive(); if (!list.length) return;
    e.preventDefault();
    const i = list.findIndex(s => s.sid === M.sid), n = list.length;
    const next = list[i < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n];
    go(next.sid);
    if (!inSearch) requestAnimationFrame(() => $(`.cm-ag[data-sid="${CSS.escape(next.sid)}"]`, M.el)?.focus({ preventScroll: true }));
    return;
  }
  if (e.key === 'Enter' && !e.isComposing && (inSearch || t === document.body || t.classList?.contains('cm-ag'))) {
    const pick = inSearch ? orderedLive()[0] : t.dataset?.sid ? findSess(t.dataset.sid) : null;
    if (t.classList?.contains('cm-ag') && !t.dataset.sid) return; // tombol Mulai shift: biarkan klik biasa
    e.preventDefault();
    M.focusNext = true;
    if (pick && pick.sid !== M.sid) go(pick.sid);
    else { const ta = $('#drQuickIn', M.el); if (ta && !ta.disabled) { ta.focus(); M.focusNext = false; } else if (!M.sid && pick) go(pick.sid); }
  }
}

/* ---------------- terminal terbuka = kolom ketik ganda; lepas dulu ---------------- */
function onDrawer() {
  if (!M.el) return;
  const open = !$('#drawer').hidden;
  if (open) {
    const key = drawerState().key || '';
    if (M.shiftSids && key.startsWith('sess:') && !M.shiftSids.before.has(key.slice(5)) && Date.now() - M.shiftSids.at < 90000) { closeDrawer(); return; }
    if (M.chat) { destroyChat(); $('#cmMain', M.el).innerHTML = placeholder('Terminal sedang terbuka di panel', 'Tutup panel untuk kembali ke percakapan.'); }
  } else if (M.sid && !M.chat) select(M.sid, { silent: true });
}

/* ---------------- live ---------------- */
const repaint = debounce(() => { if (M.el) { paintList(); } }, 120);
export function live(m, ctx) {
  if (!M.el || !M.el.isConnected) return;
  M.ctx = ctx;
  if (m.t === 'reconnected') { paintList(); loadQueues(); if (M.chat) M.chat.refresh(); return; }
  if (m.t === 'outbox' && m.sid) { reloadQueue(m.sid); return; }
  if (m.t?.startsWith('inbox')) { repaint(); M.chat?.live(m); if (M.chat) M.chat.update(); return; }
  if (m.t === 'changed' && (m.what === 'roles' || m.what === 'roles-order' || m.what === 'plan')) { repaint(); return; }
  if (m.t !== 'session' && m.t !== 'session-gone') return;
  const sid = m.t === 'session' ? m.session?.sid : m.sid;
  // shift yang baru dimulai dari daftar libur: langsung buka percakapannya
  if (M.shiftSids && m.t === 'session' && !M.shiftSids.before.has(sid) && m.session.role === M.shiftSids.role && Date.now() - M.shiftSids.at < 90000) { M.shiftSids = null; M.focusNext = true; go(sid); return; }
  repaint();
  if (m.t === 'session' && !M.queue.has(sid)) reloadQueue(sid);
  if (sid !== M.sid) return;
  // same terminal, new session id (Codex's first turn, /clear, /resume): keep the conversation open on the new id
  if (m.t === 'session-gone' && m.next && findSess(m.next)) { go(m.next); return; }
  if (m.t === 'session-gone' || m.session?.status === 'ended') {
    // beri jeda: pesan terakhir masih tampil, lalu kolom kanan berubah jadi "sesi selesai"
    M.chat?.update(); paintHead();
    setTimeout(() => { if (M.el && M.sid === sid && (!findSess(sid) || findSess(sid).status === 'ended')) select(sid, { silent: true }); }, 2500);
    return;
  }
  paintHead();
  M.chat?.update();
}
