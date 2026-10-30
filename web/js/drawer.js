// Drawer untuk sesi (terminal, profil, subagent, shell) dan role.
import { $, esc, short, sprite, guestLook, modelName, api, post, patch, toast, modal, confirmDo, debounce, hhmm, ago, attachTermRenderer } from './util.js';
import { showDrawer, drawerState, drawerEl } from './panel.js';
import { loadPlaybooks, playbookListHTML, newPlaybookFor } from './playbooks.js';
import { mountChat } from './chat.js';
import { mountDm } from './dm.js';
import { isAntigravity } from './antigravity.js';
import { isCodex, codexBadge, modeOptions, pickCodexSettings, codexSessSub } from './codex.js';
import { startShiftDialog, openRoleEditor, roleState, PERMS } from './roles.js';

const STATUS = { starting: 'Memulai', working: 'Bekerja', idle: 'Idle', waiting: 'Menunggu izin', ended: 'Selesai' };
const TABS = { chat: 'Chat', term: 'Terminal', profil: 'Profil', pesan: 'Pesan', subs: 'Subagent', shell: 'Shell' };

/** Satu drawer terbuka pada satu waktu; D menyimpan keadaannya. */
let D = null;

const roleOf = (ctx, id) => ctx.office.roles.find(r => r.id === id);
const roomName = (ctx, id) => ctx.office.plan.rooms.find(r => r.id === id)?.name || id || '';
const findSess = (ctx, sid) => ctx.office.sessions.find(s => s.sid === sid);
const toolLabel = t => (t && typeof t === 'object' ? t.label || t.name : t) || '';

function sessLook(ctx, s) { return roleOf(ctx, s.role) || guestLook(s.sid); }
function sessName(ctx, s) {
  const r = roleOf(ctx, s.role);
  if (r) return r.name + (s.slot > 0 ? ' #' + (s.slot + 1) : '');
  return s.title || 'Sesi manual';
}
function sessSub(ctx, s) {
  const r = roleOf(ctx, s.role);
  const model = s.model ? modelName(s.model) : '';
  if (isAntigravity(s)) return [r?.title, s.model || 'Gemini bawaan'].filter(Boolean).join(' · ');
  if (isCodex(s)) return [r?.title || 'Tanpa role', codexSessSub(s), r ? '' : roomName(ctx, s.room)].filter(Boolean).join(' · ');
  if (r) return [r.title, modelName(r.model)].join(' · ');
  return ['Tanpa role', model, roomName(ctx, s.room)].filter(Boolean).join(' · ');
}
function sessChips(s) {
  const st = `<span class="st ${esc(s.status)}">${s.tunggu && s.status === 'idle' ? esc(s.tunggu.label) : STATUS[s.status] || esc(s.status)}</span>${s.anggaran ? `<span class="st wait">anggaran ${s.anggaran === 'habis' ? 'habis' : 'hampir habis'}</span>` : ''}`;
  return st + codexBadge(s) + (s.kind === 'manual' ? `<span class="st manual">${s.host && s.host !== 'lain' ? HOSTS[s.host] : 'Manual'}</span>` : '') + (s.compacting ? '<span class="st starting">Meringkas</span>' : '') + (s.permMode && s.permMode !== 'default' ? `<span class="st mode-${esc(s.permMode)}">${esc(MODE_LABEL[s.permMode] || s.permMode)}</span>` : '');
}

function headHTML(look, name, sub, chips) {
  return `<div class="dr-head compact"><button class="icon-btn dr-back" data-act="close-drawer" aria-label="Kembali ke kantor">←</button><div class="dr-ava">${sprite(look, 3)}</div><div class="dr-id"><div class="dr-line"><span class="dr-name" title="${esc(sub)}">${esc(name)}</span>${chips}</div><div class="dr-title">${esc(sub)}</div></div></div>`;
}
/** Satu baris di atas panel: identitas, tab (kalau ada), lalu tombol. Menghemat tinggi untuk terminal. */
function topHTML(head, tabs = null, cur = null) {
  const full = drawerEl()?.classList.contains('full');
  return `<div class="dr-top">${head}${tabs ? tabsHTML(tabs, cur) : ''}<div class="dr-tools" data-slot="tools"></div><div class="dr-btns"><button class="icon-btn dr-swbtn" data-act="dr-sw" aria-label="Tampilkan atau sembunyikan daftar agen" title="Daftar agen (tampilkan/sembunyikan)">☰</button><button class="icon-btn" data-act="agents-open" aria-label="Pindah agen (semua kantor)" title="Pindah agen, semua kantor (Alt+K)">⇄</button><button class="icon-btn" data-act="dr-full" aria-label="Layar penuh" title="${full ? 'Kecilkan' : 'Layar penuh'}">${full ? '⤡' : '⤢'}</button><button class="icon-btn" data-act="close-drawer" aria-label="Tutup panel">✕</button></div></div>`;
}
function switcherHTML(ctx, curSid) {
  const live = (ctx.office.sessions || []).filter(x => x.status !== 'ended');
  const st = x => x.waiting ? 'izin' : x.status === 'working' ? 'bekerja' : 'idle';
  return `<aside class="dr-switch" data-slot="switch"><button class="btn sm" data-act="dr-full">← Kembali ke kantor</button><button class="btn sm" data-act="agents-open">Semua kantor…</button>
    <p class="ctl-l">Agen · ${live.length} aktif</p>
    ${live.map(x => `<button class="sw-row${x.sid === curSid ? ' cur' : ''}" data-act="dr-sess" data-sid="${esc(x.sid)}"><span class="sw-ava">${sprite(sessLook(ctx, x), 2)}</span><span class="sw-b"><b>${esc(sessName(ctx, x))}</b><span>${esc(x.tool ? `${x.tool.name} ${x.tool.label || ''}` : roomName(ctx, x.room) || '')}</span></span><i class="sw-st ${st(x)}" title="${st(x)}"></i></button>`).join('') || '<p class="empty-line">Belum ada sesi.</p>'}</aside>`;
}
function toggleFull() {
  const d = drawerEl(), on = !d.classList.contains('full');
  d.classList.toggle('full', on);
  try { localStorage.setItem('kc.dr.full', on ? '1' : '0'); } catch {}
  const b = d.querySelector('.dr-btns [data-act="dr-full"]'); if (b) { b.textContent = on ? '⤡' : '⤢'; b.title = on ? 'Kecilkan' : 'Layar penuh'; }
  D?.term?.term?.focus();
}
// daftar agen di kiri (mode layar penuh) bisa disembunyikan supaya terminal lebih lebar
function toggleSwitcher() {
  const on = !drawerEl().classList.toggle('sw-hide');
  try { localStorage.setItem('kc.dr.sw', on ? '1' : '0'); } catch {}
}
try {
  const d = document.getElementById('drawer');
  if (localStorage.getItem('kc.dr.full') === '1') d?.classList.add('full');
  if (localStorage.getItem('kc.dr.sw') === '0') d?.classList.add('sw-hide');
} catch {}
function tabsHTML(tabs, cur) {
  return `<div class="dr-tabbar"><div class="dr-tabs" role="tablist">${tabs.map(k => `<button role="tab" aria-selected="${k === cur}" data-act="dr-tab" data-tab="${k}">${TABS[k]}</button>`).join('')}</div><details class="more dr-tmore" hidden><summary title="Tab lainnya" aria-label="Tab lainnya"></summary><div class="more-menu"></div></details></div>`;
}
/** Tab yang tidak muat di baris atas pindah ke menu ⋯; tab yang terbuka selalu terlihat. */
function fitTabs() {
  const bar = drawerEl()?.querySelector('.dr-tabbar'); if (!bar) return;
  const row = bar.querySelector('.dr-tabs'), more = bar.querySelector('.dr-tmore'), btns = [...row.querySelectorAll('button')];
  btns.forEach(b => { b.hidden = false; });
  more.hidden = true;
  const over = () => row.scrollWidth > row.clientWidth + 1, hid = [];
  if (over()) {
    more.hidden = false;
    for (const b of [...btns].reverse()) {
      if (!over()) break;
      if (b.getAttribute('aria-selected') === 'true') continue;
      b.hidden = true; hid.unshift(b);
    }
  }
  more.querySelector('summary').textContent = `+${hid.length} ▾`;
  more.querySelector('.more-menu').innerHTML = hid.map(b => `<button data-act="dr-tab" data-tab="${esc(b.dataset.tab)}">${esc(TABS[b.dataset.tab])}</button>`).join('');
}

/* ---------------- tombol khusus layar sentuh ---------------- */
const mobile = () => matchMedia('(max-width: 900px)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;
const KEYS = { esc: '\x1b', tab: '\t', enter: '\r', ctrlc: '\x03', slash: '/', stab: '\x1b[Z' };
const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' };
const KB = [['esc', 'Esc'], ['tab', 'Tab'], ['ctrl', 'Ctrl'], ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['stab', '⇧Tab'], ['enter', '⏎'], ['ctrlc', '^C'], ['slash', '/']];
const kbHidden = () => { try { return localStorage.getItem('kc.kb.hide') === '1'; } catch { return false; } };
/** Baris tombol di bawah terminal; hanya tampil di layar sentuh atau sempit (lihat drawer.css). */
export function keybarHTML() {
  return `<div class="kb-wrap${kbHidden() ? ' off' : ''}"><div class="keybar" role="toolbar" aria-label="Tombol terminal">${KB.map(([k, l]) => `<button type="button" class="kb-k${k === 'ctrl' ? ' ctrl' : ''}" data-kb="${k}"${k === 'ctrl' ? ' aria-pressed="false"' : ''}>${l}</button>`).join('')}<button type="button" class="kb-k hide" data-kb="hide" aria-label="Sembunyikan tombol">⌄</button></div><button type="button" class="kb-show" data-kb="show" aria-label="Tampilkan tombol terminal">⌨</button></div>`;
}
/** Ctrl yang menempel: ketikan huruf berikutnya dikirim sebagai Ctrl+huruf. Dipanggil dari onData terminal. */
export function ctrlFilter(t, d) {
  if (!t.ctrl) return d;
  t.ctrl = false; paintCtrl(false);
  return d.length === 1 && /[a-z]/i.test(d) ? String.fromCharCode(d.toUpperCase().charCodeAt(0) - 64) : d;
}
const paintCtrl = on => document.querySelectorAll('.kb-k.ctrl').forEach(b => b.setAttribute('aria-pressed', String(on)));
/** Pasang aksi tombol pada root keybarHTML(); getT() mengembalikan terminal aktif ({ term, ws, ctrl }). */
export function bindKeybar(root, getT) {
  let held = false;
  // tombol tidak boleh mencuri fokus, supaya keyboard layar tidak menutup tiap ketukan
  const keep = e => { held = !!document.activeElement?.closest?.('.xterm'); e.preventDefault(); };
  root.addEventListener('pointerdown', keep);
  root.addEventListener('mousedown', e => e.preventDefault());
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-kb]'); if (!b) return;
    const k = b.dataset.kb, wrap = b.closest('.kb-wrap');
    if (k === 'hide' || k === 'show') { const off = k === 'hide'; wrap.classList.toggle('off', off); try { localStorage.setItem('kc.kb.hide', off ? '1' : '0'); } catch {} return; }
    const t = getT(); if (!t) return;
    if (k === 'ctrl') { t.ctrl = !t.ctrl; paintCtrl(t.ctrl); if (held) t.term.focus(); return; }
    let seq = KEYS[k];
    if (ARROW[k]) seq = (t.term.modes?.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROW[k];
    if (seq == null) return;
    if (t.ctrl) { t.ctrl = false; paintCtrl(false); }
    if (t.ws?.readyState === 1) t.ws.send(seq);
    if (held) t.term.focus();
  });
}

/* ---------------- terminal xterm ---------------- */
let trTimer = null;
const termFont = () => { try { return Math.min(20, Math.max(9, Number(localStorage.getItem('kc.term.fs')) || 13)); } catch { return 13; } };
function setTermFont(delta) {
  const fs = Math.min(20, Math.max(9, termFont() + delta));
  try { localStorage.setItem('kc.term.fs', String(fs)); } catch {}
  const t = D?.term; if (t) { t.term.options.fontSize = fs; try { t.fit.fit(); } catch {} t.term.focus(); }
  const l = drawerEl().querySelector('[data-slot="fs"]'); if (l) l.textContent = String(fs);
}
// terminals stay connected for a while after you look away, so switching back is instant
// (no new tmux client, no resize, no full repaint of Claude's screen): query -> entry
const POOL = new Map(), POOL_MAX = 4;
function killTerm(t) {
  POOL.delete(t.query);
  try { t.ro?.disconnect(); } catch {}
  try { t.ws.onclose = null; t.ws.close(); } catch {}
  try { t.term.dispose(); } catch {}
  t.el.remove();
}
function disposeTerm(kill = false) {
  clearInterval(trTimer); trTimer = null;
  if (D?.chat) { D.chat.destroy(); D.chat = null; }
  const t = D?.term; if (!t) return;
  D.term = null;
  try { t.ro.disconnect(); } catch {}
  if (kill || t.ws.readyState > 1) { killTerm(t); return; }
  t.used = Date.now(); t.el.remove();
  const idle = [...POOL.values()].sort((x, y) => x.used - y.used);
  while (idle.length > POOL_MAX) killTerm(idle.shift());
}
function mountTerm(host, query) {
  if (!window.Terminal || !window.FitAddon) { host.innerHTML = '<p class="empty-line" style="padding:12px">xterm.js belum termuat. Muat ulang halaman.</p>'; return; }
  let t = POOL.get(query);
  if (t && t.ws.readyState > 1) { killTerm(t); t = null; }
  if (!t) t = newTerm(query);
  host.appendChild(t.el);
  // a pooled terminal coming back (or one whose GPU canvas was dropped) must repaint, else it shows blank
  requestAnimationFrame(() => { try { if (host.clientHeight > 20) t.fit.fit(); t.term.refresh(0, t.term.rows - 1); } catch {} });
  // refit when the box changes size, but only tell the server once things settle
  let raf = 0;
  t.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { if (host.clientHeight > 20) t.fit.fit(); } catch {} }); });
  t.ro.observe(host);
  D.term = t;
  if (!coarse()) setTimeout(() => t.term.focus(), 30); // di HP, fokus otomatis memunculkan keyboard dan menutupi layar
}
function newTerm(query) {
  const el = document.createElement('div'); el.className = 'xt-in';
  const term = new window.Terminal({ cursorBlink: true, fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace', fontSize: termFont(), scrollback: 5000, theme: { background: '#0E1218', foreground: '#D4DAE3', cursor: '#E4A445' } });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  const t = { query, el, term, fit, ws: null, ro: null, used: Date.now() };
  POOL.set(query, t);
  // connect only once the box has its real size and the mono font is in, so tmux is sized right from the start
  requestAnimationFrame(async () => {
    term.open(el);
    // GPU renderer on desktop (the DOM one cannot keep up with Claude's repaints); see attachTermRenderer
    attachTermRenderer(term);
    await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 400))]);
    try { if (el.clientHeight > 20) fit.fit(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = t.ws = new WebSocket(`${proto}://${location.host}/ws/term?${query}&cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => term.write('\r\n\x1b[2m[koneksi terminal tertutup]\x1b[0m\r\n');
    ws.onerror = () => term.write('\r\n\x1b[31m[gagal tersambung ke terminal]\x1b[0m\r\n');
    term.onData(d => { if (ws.readyState === 1) ws.send(ctrlFilter(t, d)); });
    let rt = 0;
    term.onResize(({ cols, rows }) => { clearTimeout(rt); rt = setTimeout(() => { if (ws.readyState === 1) ws.send('\x00' + JSON.stringify({ cols, rows })); }, 160); });
  });
  t.ws = { readyState: 0, send() {}, close() {} };
  return t;
}

/* ---------------- sesi ---------------- */
// Di HP keyboard layar bisa menutupi bagian bawah panel (Chrome tidak lagi mengecilkan layout viewport), jadi
// tinggi panel mengikuti visual viewport.
function fitViewport() {
  const d = drawerEl(), vv = window.visualViewport; if (!d) return;
  if (!vv || !mobile() || d.hidden) { d.style.removeProperty('--dr-h'); d.style.removeProperty('--dr-top'); return; }
  d.style.setProperty('--dr-h', vv.height + 'px'); d.style.setProperty('--dr-top', vv.offsetTop + 'px');
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);

export { HOSTS };
export function openSession(ctx, sid, tab = 'term', opts = {}) {
  const s = sid ? findSess(ctx, sid) : null;
  if (sid && !s) { toast('Sesi tidak ditemukan. Mungkin sudah selesai.', 'warn'); return; }
  if (!sid && !(tab === 'shell' && opts.room)) return;
  const key = sid ? 'sess:' + sid : 'shell:' + opts.room;
  if (D && D.key === key && drawerState().open) { switchTab(tab); return; }

  const room = s ? s.room : opts.room;
  const rest = s ? [...(roleOf(ctx, s.role) ? ['profil', 'pesan'] : []), 'subs', 'shell'] : [];
  // di HP percakapan lebih berguna daripada terminal mentah, jadi Chat jadi tab bawaan
  const tabs = s ? (mobile() ? ['chat', 'term', ...rest] : ['term', 'chat', ...rest]) : ['shell'];
  if (s && tab === 'term' && mobile()) tab = 'chat';
  if (!tabs.includes(tab)) tab = tabs[0];
  const head = s ? headHTML(sessLook(ctx, s), sessName(ctx, s), sessSub(ctx, s), sessChips(s))
    : headHTML(guestLook('shell:' + room), 'Shell ' + roomName(ctx, room), 'zsh biasa di folder ruangan, tanpa Claude', '<span class="st manual">Shell</span>');
  const html = switcherHTML(ctx, sid) + `<div class="dr-main">${topHTML(head, tabs, tab)}<div class="dr-body" id="drBody"></div></div>`;
  const state = { ctx, key, kind: 'session', sid, room, tab, tabs, term: null };
  const d = showDrawer(html, { wide: true, key, close: () => { state.ro?.disconnect(); const own = D; if (own === state) { disposeTerm(); D = null; } } });
  D = state;
  bindOnce(d);
  fitTabs();
  state.ro = new ResizeObserver(() => requestAnimationFrame(fitTabs));
  state.ro.observe(d.querySelector('.dr-tabbar'));
  fitViewport();
  renderBody();
}

function switchTab(tab) {
  if (!D || !D.tabs.includes(tab)) return;
  D.tab = tab;
  const d = drawerEl();
  d.querySelectorAll('.dr-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  fitTabs();
  renderBody();
}

function renderBody() {
  if (!D) return;
  disposeTerm();
  D.dm?.destroy(); D.dm = null;
  const body = $('#drBody'); if (!body) return;
  const tools = drawerEl().querySelector('[data-slot="tools"]'); if (tools) tools.innerHTML = '';
  const { ctx, sid, tab } = D;
  const s = sid ? findSess(ctx, sid) : null;
  if (D.kind === 'role') { body.innerHTML = roleBodyHTML(ctx, D.roleId); paintRolePb(); return; }
  if (tab === 'shell') {
    body.innerHTML = `<div class="termbox"><div class="xt" id="xt"></div></div>${keybarHTML()}<p class="hint">zsh biasa di folder ruangan ${esc(roomName(ctx, D.room))}. Tidak ada Claude di sini.</p>`;
    mountTerm($('#xt'), `kind=shell&office=${encodeURIComponent(ctx.office.id)}&room=${encodeURIComponent(D.room)}`);
    bindKeybar($('.kb-wrap', body), () => D?.term);
  } else if (tab === 'chat') chatTab(body, ctx, s);
  else if (tab === 'profil') body.innerHTML = sessProfileHTML(ctx, s);
  else if (tab === 'pesan') D.dm = mountDm(body, ctx, { role: s?.role });
  else if (tab === 'subs') body.innerHTML = subsHTML(ctx, s);
  else termTab(body, ctx, s);
}

function endedBanner() { return '<div class="note-ro" data-slot="ended">Sesi selesai. Terminal sudah tertutup. Riwayatnya ada di tab Arsip, dari sana kamu bisa melanjutkannya.</div>'; }

function termTab(body, ctx, s) {
  if (s.status === 'ended') { body.innerHTML = endedBanner(); return; }
  if (!s.tmux) { body.innerHTML = readonlyHTML(ctx, s); loadTranscript(s.sid); trTimer = setInterval(() => loadTranscript(s.sid), 10000); return; } // cadangan; { t: 'transcript' } memicu muat ulang
  const cmd = `tmux attach -t ${s.tmux}`;
  // kontrol terminal duduk di baris atas panel (bukan baris sendiri), supaya terminal dapat tinggi penuh
  const tools = drawerEl().querySelector('[data-slot="tools"]');
  if (tools) tools.innerHTML = `<span data-slot="mode">${modeSelect(s)}</span>
    <button class="btn sm halt" data-act="dr-action" data-a="esc" title="Hentikan pekerjaan yang sedang jalan (Esc)">■<span class="halt-l"> Hentikan</span></button>${bgCount(s) > 0 ? `<span class="st working" data-slot="bg" title="Subagent masih jalan di latar">${bgCount(s)} latar</span>` : ''}
    <details class="more"><summary class="btn sm" title="Kontrol lainnya" aria-label="Kontrol lainnya">⋯</summary><div class="more-menu">
      <button data-act="dr-model">${isCodex(s) ? `Ganti model (${esc(codexSessSub(s))})…` : 'Ganti model…'}</button>
      <button data-act="dr-action" data-a="compact">Ringkas (/compact)</button>
      <button data-act="dr-action" data-a="clear">Reset (/clear)</button>
      <div class="mm-fs">Ukuran huruf <span class="fs"><button data-act="dr-fs" data-d="-1" aria-label="Perkecil huruf">−</button><span data-slot="fs">${termFont()}</span><button data-act="dr-fs" data-d="1" aria-label="Perbesar huruf">+</button></span></div>
      <hr>
      <button data-act="dr-action" data-a="exit">Selesaikan sesi (/exit)</button>
      <button data-act="dr-action" data-a="kill" class="danger">Paksa tutup</button>
      <button data-act="dr-copy" data-text="${esc(cmd)}">Salin <code>${esc(cmd)}</code></button></div></details>`;
  body.innerHTML = `<div class="termbox"><div class="xt" id="xt"></div></div>
    ${keybarHTML()}`;
  mountTerm($('#xt'), `kind=session&sid=${encodeURIComponent(s.sid)}`);
  bindKeybar($('.kb-wrap', body), () => D?.term);
}

const typeableOf = s => { const tty = s.tty ? s.tty.replace('/dev/', '') : null; return !!tty && !['vscode', 'lain'].includes(s.host); };
function chatTab(body, ctx, s) {
  const sid = s.sid;
  D.chat = mountChat(body, { ctx, sid, name: () => sessName(ctx, findSess(D.ctx, sid) || s), sess: () => findSess(D.ctx, sid) || s,
    canSend: () => { const x = findSess(D.ctx, sid) || s; return !!x.tmux || typeableOf(x); },
    send: text => sendAction(sid, 'text', text) });
}

export const MODE_LABEL = { readOnly: 'Hanya baca', default: 'Selalu tanya', acceptEdits: 'Edit otomatis', auto: 'Auto', plan: 'Plan', dontAsk: 'Tanpa tanya', bypassPermissions: 'Bypass' };
const modeSelect = s => isAntigravity(s) ? '<span class="hint">Gemini · /permissions di terminal</span>' : isCodex(s) ? `<label class="tb-mode${s.permMode === 'bypassPermissions' ? ' danger' : ''}" title="Mode izin Codex."><select data-act="dr-mode" aria-label="Mode izin">${s.permMode ? '' : '<option value="">…</option>'}${modeOptions(s.permMode)}</select></label>` : `<label class="tb-mode${s.permMode === 'bypassPermissions' ? ' danger' : ''}" title="Mode izin. Sama dengan menekan Shift+Tab di terminalnya."><select data-act="dr-mode" aria-label="Mode izin">${s.permMode ? '' : '<option value="">…</option>'}${['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].map(m => `<option value="${m}"${s.permMode === m ? ' selected' : ''}>Izin: ${MODE_LABEL[m]}</option>`).join('')}</select></label>`;
/** Ganti model sesi lewat pemilih /model milik Claude Code sendiri; daftarnya diambil dari layar, bukan buatan kita. */
let pmOff = null;
export async function pickModel(sid) {
  pmOff?.();
  const enc = encodeURIComponent(sid);
  let r;
  try { r = await post(`/api/sessions/${enc}/model/open`); } catch (e) { toast(e.message, 'bad'); return; }
  const row = o => `<button type="button" class="btn${o.current ? ' primary' : ''}" data-pm="${o.index}" style="display:block;width:100%;text-align:left;margin:0 0 6px"><b>${esc(o.label)}</b>${o.current ? ' ✔ aktif' : ''}${o.desc ? `<br><small>${esc(o.desc)}</small>` : ''}</button>`;
  const card = $('#modalCard');
  const onPick = async e => {
    const b = e.target.closest('[data-pm]'); if (!b) return;
    card.removeEventListener('click', onPick);
    card.querySelectorAll('[data-pm]').forEach(x => { x.disabled = true; });
    try { const x = await post(`/api/sessions/${enc}/model/select`, { index: Number(b.dataset.pm) }); toast(`Model diganti ke ${x.model}`, 'ok'); }
    catch (er) { toast(er.message, 'bad'); }
    $('#modal').hidden = true;
  };
  modal({ title: 'Ganti model', body: 'Pilihan sama dengan perintah /model di Claude Code. Berlaku untuk sesi ini saja.', html: `<div style="max-height:55vh;overflow:auto;margin:10px 0">${r.options.map(row).join('')}</div>`,
    actions: [{ label: 'Batal', fn: () => { card.removeEventListener('click', onPick); post(`/api/sessions/${enc}/model/cancel`).catch(() => {}); } }] });
  card.addEventListener('click', onPick);
  pmOff = () => card.removeEventListener('click', onPick);
}
const HOSTS = { vscode: 'VS Code', terminal: 'Terminal', iterm: 'iTerm2', tmux: 'tmux', lain: 'aplikasi terminal lain' };
function readonlyHTML(ctx, s) {
  const tty = s.tty ? s.tty.replace('/dev/', '') : null;
  // typing works only into Terminal.app / iTerm2 tabs
  const typeable = typeableOf(s);
  const where = s.host ? HOSTS[s.host] || s.host : 'Terminal';
  const head = !tty ? 'Tab terminal sesi ini belum diketahui. Kirim satu perintah dari jendelanya dulu supaya kantor bisa menemukannya, atau pindahkan sesi ini ke kantor.'
    : typeable ? `Jalan di tab ${esc(where)} <code>${esc(tty)}</code>. Perintah yang kamu kirim di sini diketik langsung ke tab itu.`
    : `Jalan di terminal <b>${esc(where)}</b> <code>${esc(tty)}</code>. Kantor bisa menonton percakapannya, tapi tidak bisa mengetik ke ${esc(where)}. Pindahkan ke kantor supaya bisa kamu kendalikan dari sini, dengan ingatan yang sama.`;
  const dis = typeable ? '' : ' disabled';
  return `<div class="tr-head">${head}</div>
    <div class="sess-actions">
      <button class="btn sm primary" data-act="dr-adopt" title="Tutup sesi di terminalnya lalu lanjutkan di tmux kantor dengan ingatan utuh">Pindahkan ke kantor</button>
      <button class="btn sm" data-act="dr-action" data-a="compact"${dis}>Ringkas</button>
      <button class="btn sm" data-act="dr-action" data-a="clear"${dis}>Reset</button>
      <button class="btn sm" data-act="dr-action" data-a="exit"${dis}>Selesai</button>
      <button class="btn sm danger" data-act="dr-action" data-a="kill"${tty ? '' : ' disabled'}>Paksa tutup</button></div>
    <div class="tr-box" id="trBox"><p class="tr-empty">Memuat percakapan…</p></div>
    <form class="quick" id="drQuick"><input id="drQuickIn" autocomplete="off" aria-label="Kirim perintah" placeholder="${typeable ? `Ketik perintah untuk ${esc(sessName(ctx, s))}` : tty ? `Tidak bisa mengetik ke ${esc(where)} dari sini` : 'Belum bisa mengirim ke sesi ini'}" style="flex:1"${dis}><button class="btn primary" type="submit"${dis}>Kirim</button></form>
`;
}
const trLine = it => {
  if (it.k === 'user') return `<div class="tr-user">› ${esc(it.s)}</div>`;
  if (it.k === 'tool') return `<div class="tr-tool">⏺ ${esc(it.s)}</div>`;
  if (it.k === 'result') return `<div class="tr-res${it.err ? ' err' : ''}">⎿ ${esc(short(it.s.replace(/\s+/g, ' '), 160))}</div>`;
  return `<div class="tr-text">${esc(it.s)}</div>`;
};
async function loadTranscript(sid) {
  const box = $('#trBox'); if (!box || D?.sid !== sid) return;
  let data;
  try { data = await api(`/api/sessions/${encodeURIComponent(sid)}/transcript?n=150`); } catch { return; }
  if (!box.isConnected || D?.sid !== sid || box.dataset.size === String(data.size)) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.dataset.size = data.size;
  box.innerHTML = data.items.length ? data.items.map(trLine).join('') : '<p class="tr-empty">Belum ada percakapan di transcript.</p>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}
document.addEventListener('change', e => {
  if (e.target.id !== 'adRole') return;
  const v = e.target.value, n = document.getElementById('adNew'), b = document.getElementById('adBossWrap'), h = document.getElementById('adBossHint');
  if (n) { n.hidden = v !== '__new'; if (!n.hidden) document.getElementById('adName')?.focus(); }
  // an existing role already has its own boss; anonymous and new roles can be given one here
  if (b) b.hidden = !!v && v !== '__new';
  if (h) h.textContent = v === '__new' ? 'Role baru ini jadi anak buah orang yang kamu pilih, tercatat permanen di profilnya.' : 'Sesi tetap anonim dan sementara, tapi tahu atasannya: dia melapor ke atasan lewat komentar kartu.';
});
function adoptDialog() {
  const ctx = D.ctx, sid = D.sid, s = findSess(ctx, sid);
  const roles = ctx.office.roles.filter(r => !r.archived);
  const how = s?.host === 'vscode' || s?.host === 'lain'
    ? `Kantor menghentikan proses Claude di terminal ${HOSTS[s.host]} (hanya kalau sedang tidak bekerja), lalu melanjutkan sesi yang sama di tmux kantor pada folder yang sama. Isi percakapannya tetap ada. Tab terminalnya di ${HOSTS[s.host]} boleh kamu tutup setelahnya.`
    : 'Kantor mengetik /exit di tab Terminal-nya, lalu melanjutkan sesi yang sama di tmux kantor pada folder yang sama. Isi percakapannya tetap ada.';
  modal({ title: 'Pindahkan ke kantor?', body: how,
    html: `<div class="field"><label for="adRole">Sesi ini jadi siapa?</label><select id="adRole"><option value="">Tetap sesi tanpa role</option><option value="__new">+ Role baru (beri nama dan atasan)</option><optgroup label="Role yang ada">${roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${esc(r.title)}</option>`).join('')}</optgroup></select></div>
      <div class="ad-new" id="adNew" hidden><div class="rf-row"><div class="field"><label for="adName">Nama</label><input id="adName" placeholder="mis. Gilang" autocomplete="off"></div>
        <div class="field"><label for="adTitle">Jabatan</label><input id="adTitle" placeholder="mis. Asisten Laravel" autocomplete="off"></div></div>
        </div>
      <div class="field" id="adBossWrap"><label for="adBoss">Anak buah dari</label><select id="adBoss"><option value="">Tidak ada (langsung di bawah manager)</option>${roles.map(r => `<option value="${esc(r.id)}"${s?.boss === r.id ? ' selected' : ''}>${esc(r.name)} · ${esc(r.title)}</option>`).join('')}</select>
        <p class="hint" id="adBossHint">Sesi tetap anonim dan sementara, tapi tahu atasannya: dia melapor ke atasan lewat komentar kartu.</p></div>
      <div class="field"><label for="adPerm">Mode izin di kantor</label><select id="adPerm">${PERMS.map(([v, l]) => `<option value="${v}"${v === 'bypassPermissions' ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><p class="hint">Sesi manualmu biasanya jalan dengan --dangerously-skip-permissions, jadi pilihan itu dipilih bawaan.</p></div>`,
    actions: [{ label: 'Pindahkan', kind: 'primary', fn: () => {
      const pick = $('#adRole').value, permissionMode = $('#adPerm').value || null;
      const boss = $('#adBoss').value || null;
      const newRole = pick === '__new' ? { name: $('#adName').value.trim(), title: $('#adTitle').value.trim(), reportsTo: boss } : null;
      if (newRole && !newRole.name) { toast('Isi nama role barunya', 'warn'); return false; }
      const role = pick && pick !== '__new' ? pick : null;
      toast('Memindahkan sesi…');
      post(`/api/sessions/${encodeURIComponent(sid)}/adopt`, { role, permissionMode, newRole, boss: pick ? null : boss }).then(() => { toast('Sesi sekarang jalan di kantor', 'ok'); setTimeout(() => { if (D?.sid === sid) { D.tab = 'term'; renderBody(); } }, 2500); }).catch(e => toast(e.message, 'bad'));
    } }, { label: 'Batal' }] });
}
function factsHTML(ctx, s) {
  const items = [['Status', STATUS[s.status] || s.status], ['Sedang memakai', toolLabel(s.tool) || '-'], ['Ruangan', roomName(ctx, s.room) || '-'], ['Mulai', s.startedAt ? ago(s.startedAt) : '-']];
  if (s.waiting) items.push(['Menunggu izin', short(s.waiting.summary || s.waiting.tool, 80)]);
  if (s.cwd) items.push(['Folder', s.cwd]);
  return items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function sessProfileHTML(ctx, s) {
  const r = roleOf(ctx, s.role); if (!r) return '<p class="empty-line">Sesi ini tidak punya role.</p>';
  return `<section class="dr-sec"><h3>Kepribadian</h3><p>${esc(r.persona || '-')}</p></section>
    ${r.skills?.length ? `<section class="dr-sec"><h3>Skills</h3><div class="chips">${r.skills.map(k => `<span class="chip">${esc(k)}</span>`).join('')}</div></section>` : ''}
    <dl class="facts"><div><dt>Model</dt><dd>${esc(isCodex(r) ? 'Codex · ' + codexSessSub(r) : modelName(r.model))}</dd></div><div><dt>Ruangan</dt><dd>${esc(roomName(ctx, r.room))}</dd></div><div><dt>Folder kerja</dt><dd><code>${esc(s.cwd || '-')}</code></dd></div>${s.worktree ? `<div><dt>Worktree</dt><dd><code>${esc(s.worktree)}</code></dd></div>` : ''}</dl>
    <div class="btn-row"><button class="btn" data-act="dr-role" data-role="${esc(r.id)}">Buka profil role</button></div>`;
}

function elapsed(started) {
  const t = typeof started === 'number' ? started : Date.parse(started);
  if (!t) return '';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  return sec < 60 ? sec + ' dtk' : Math.floor(sec / 60) + ' mnt';
}
function subsHTML(ctx, s) {
  const color = roleOf(ctx, s.role)?.color || '#9AA3AF';
  const subs = s.subs || [];
  const list = subs.length ? `<ul class="subs">${subs.map(x => `<li style="--sc:${esc(color)}"><span class="sub-type">${esc(x.type || 'agent')} · ${esc(x.status === 'done' ? 'selesai' : 'jalan')} · ${esc(elapsed(x.started))}</span><span>${esc(short(x.desc || '', 140))}</span>${toolLabel(x.tool) ? `<span class="hint">${esc(toolLabel(x.tool))}</span>` : ''}</li>`).join('')}</ul>` : '<p class="empty-line">Tidak ada subagent.</p>';
  return `<p class="sub">Subagent adalah pekerja sementara yang dipanggil sesi ini lewat tool Agent. Di denah mereka memakai topi dan lanyard berwarna seragam induknya.</p>
    <section class="dr-sec" data-slot="subs"><h3>Subagent (${subs.filter(x => x.status !== 'done').length} jalan, ${subs.length} total)</h3>${list}</section>
    <section class="dr-sec"><h3>Ke mana subagent pergi</h3><ul class="hist">
      <li><span>Explore</span><span>ke Perpustakaan, membaca dan mencari di kode</span></li>
      <li><span>Plan</span><span>ke Ruang Meeting, menyusun rencana</span></li>
      <li><span>review / test</span><span>ke Lab QA</span></li>
      <li><span>lainnya</span><span>berdiri di samping meja induknya</span></li></ul></section>`;
}

/* ---------------- aksi ---------------- */
const ACTIONS = {
  esc: { ok: 'Esc dikirim' },
  compact: { ok: 'Meminta ringkasan' },
  clear: { ok: 'Konteks direset', title: 'Reset percakapan?', body: 'Percakapan sesi ini dikosongkan (/clear). Buku catatan role tetap ada.', label: 'Reset' },
  exit: { ok: 'Sesi ditutup', title: 'Selesaikan sesi?', label: 'Selesai' },
  kill: { ok: 'Sesi dipaksa tutup', title: 'Paksa tutup sesi?', body: 'Proses Claude dimatikan langsung. Pekerjaan yang belum disimpan bisa hilang.', label: 'Paksa tutup' },
};
async function sendAction(sid, action, text) {
  try {
    const r = await post(`/api/sessions/${encodeURIComponent(sid)}/action`, text != null ? { action, text } : { action });
    // daemon skips Esc on an idle prompt (it would open Claude Code's rewind menu)
    if (r?.idle) { toast('Sesi sedang tidak bekerja, jadi tidak ada yang dihentikan.', 'ok'); return false; }
    return true;
  }
  catch (e) { toast(e.message, 'bad'); return false; }
}
export const bgCount = s => s?.bgAgents ?? (s?.subs || []).filter(x => x.status !== 'done').length;
// with background subagents Esc alone leaves them running: ask whether to stop everything
export function stopFlow(s, send) {
  const n = bgCount(s);
  if (!(n > 0)) { send('esc'); return; }
  modal({
    title: 'Hentikan sesi ini?',
    body: `Agen utama ${s.status === 'working' ? 'sibuk' : 'idle'} · ${n} subagent masih jalan di latar.<br><br>“Hentikan semua” juga menghentikan subagent latar. Efek sampingnya: auto-reply artifact dimatikan untuk sisa sesi ini.`,
    actions: [{ label: 'Hentikan semua (termasuk subagent)', kind: 'danger', fn: () => { send('stop-all'); } }, { label: 'Hanya agen utama', fn: () => { send('esc'); } }, { label: 'Batal' }],
  });
}
function doAction(a) {
  if (!D?.sid) return;
  const s = findSess(D.ctx, D.sid), sid = D.sid, def = ACTIONS[a]; if (!def) return;
  if (a === 'esc' && bgCount(s) > 0) { stopFlow(s, x => sendAction(sid, x).then(ok => ok && toast(x === 'stop-all' ? 'Semua dihentikan' : def.ok, 'ok'))); return; }
  const run = async () => { if (await sendAction(sid, a)) toast(def.ok, 'ok'); };
  if (!def.title) { run(); return; }
  let body = def.body || '';
  if (a === 'exit') body = 'Claude diminta keluar dengan /exit.' + (s?.worktree ? ` Sesi ini memakai worktree terpisah di ${esc(s.worktree)}; foldernya tetap ada di disk, jadi pastikan perubahan sudah di-commit.` : '');
  confirmDo(def.title, body, def.label, run, a === 'kill' ? 'danger' : 'primary');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Disalin', 'ok'); return; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Disalin', 'ok'); } catch { toast('Gagal menyalin', 'bad'); }
  ta.remove();
}

/* ---------------- role ---------------- */
function roleHead(ctx, r) {
  const st = roleState(ctx, r.id);
  return headHTML(r, r.name, `${r.title} · ${isCodex(r) ? 'Codex · ' + codexSessSub(r) : modelName(r.model)}`, `${codexBadge(r)}<span class="st ${st.cls}">${st.label}${st.n > 1 ? ` · ${st.n} sesi` : ''}</span>${r.archived ? '<span class="st off">Diarsipkan</span>' : ''}`);
}
function roleSessionsHTML(ctx, r) {
  const ss = ctx.office.sessions.filter(s => s.role === r.id && s.status !== 'ended');
  if (!ss.length) return '<p class="empty-line">Sedang libur. Belum ada sesi aktif.</p>';
  return `<ul class="sess-list">${ss.map(s => `<li>${`<span class="mini">${sprite(r, 2)}</span>`}<div style="min-width:0"><button class="who" data-act="dr-sess" data-sid="${esc(s.sid)}">${esc(sessName(ctx, s))}</button><div class="t">${esc(toolLabel(s.tool) || s.title || '')}</div></div><span class="st ${esc(s.status)}">${STATUS[s.status] || esc(s.status)}</span></li>`).join('')}</ul>`;
}
async function paintRolePb() {
  const st = D, ctx = st.ctx, r = roleOf(ctx, st.roleId); if (!r) return;
  const list = await loadPlaybooks(ctx, r.id);
  const slot = D === st && drawerEl().querySelector('[data-slot="pbs"]');
  if (slot) slot.innerHTML = playbookListHTML(ctx, r, list);
}
function roleBodyHTML(ctx, id) {
  const r = roleOf(ctx, id); if (!r) return '<p class="empty-line">Role tidak ditemukan.</p>';
  return `<section class="dr-sec"><h3>Kepribadian</h3><p>${esc(r.persona || '-')}</p></section>
    ${r.skills?.length ? `<section class="dr-sec"><h3>Skills</h3><div class="chips">${r.skills.map(k => `<span class="chip">${esc(k)}</span>`).join('')}</div></section>` : ''}
    <dl class="facts"><div><dt>Model</dt><dd>${esc(isCodex(r) ? 'Codex · ' + codexSessSub(r) : modelName(r.model))}</dd></div><div><dt>Ruangan</dt><dd>${esc(roomName(ctx, r.room))}</dd></div><div><dt>Budget bulanan</dt><dd>${r.budget ? '$' + esc(r.budget) : 'Tanpa batas'}</dd></div><div><dt>Peran</dt><dd>${r.isMgr ? 'Manager' : 'Anggota'}</dd></div></dl>
    <section class="dr-sec"><h3>📘 Playbook</h3><div data-slot="pbs"><p class="hint">Memuat…</p></div></section>
    <section class="dr-sec"><h3>Sesi aktif</h3><div data-slot="sess">${roleSessionsHTML(ctx, r)}</div></section>
    <div class="btn-row"><button class="btn primary" data-act="dr-shift" data-role="${esc(r.id)}">Mulai shift</button><button class="btn" data-act="dr-edit" data-role="${esc(r.id)}">Ubah role</button></div>
    <section class="dr-sec"><h3>Buku catatan</h3><textarea rows="6" id="drNotes" aria-label="Buku catatan ${esc(r.name)}" placeholder="Catatan yang dibawa role ini dari shift ke shift. Role juga bisa menulisnya sendiri.">${esc(r.notes || '')}</textarea><p class="hint" id="drNotesHint">Tersimpan otomatis.</p></section>`;
}
const saveNotes = debounce(async (ctx, id, text) => {
  const hint = $('#drNotesHint');
  try {
    await patch(`/api/offices/${encodeURIComponent(ctx.office.id)}/roles/${encodeURIComponent(id)}`, { notes: text });
    const r = roleOf(ctx, id); if (r) r.notes = text;
    if (hint) hint.textContent = 'Tersimpan';
  } catch (e) { if (hint) hint.textContent = 'Gagal menyimpan: ' + e.message; toast(e.message, 'bad'); }
}, 700);

export function openRole(ctx, roleId) {
  const r = roleOf(ctx, roleId);
  if (!r) { toast('Role tidak ditemukan', 'warn'); return; }
  const key = 'role:' + roleId;
  if (D && D.key === key && drawerState().open) return;
  const html = switcherHTML(ctx, null) + `<div class="dr-main">${topHTML(roleHead(ctx, r))}<div class="dr-body" id="drBody"></div></div>`;
  const state = { ctx, key, kind: 'role', roleId, sid: null, tab: 'profil', tabs: [], term: null };
  const d = showDrawer(html, { wide: false, key, close: () => { if (D === state) { disposeTerm(); D = null; } } });
  D = state;
  bindOnce(d);
  fitViewport();
  renderBody();
}

/* ---------------- event ---------------- */
function bindOnce(d) {
  if (d.dataset.drBound) return;
  d.dataset.drBound = '1';
  d.addEventListener('click', onClick);
  d.addEventListener('submit', onSubmit);
  d.addEventListener('keydown', onKey);
  d.addEventListener('change', e => { if (e.target.dataset.act === 'dr-mode' && e.target.value) setMode(e.target); });
  d.addEventListener('input', e => {
    if (e.target.id === 'drQuickIn') { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }
    if (e.target.id === 'drNotes' && D?.kind === 'role') { const h = $('#drNotesHint'); if (h) h.textContent = 'Menyimpan…'; saveNotes(D.ctx, D.roleId, e.target.value); }
  });
}
function onClick(e) {
  const b = e.target.closest('[data-act]'); if (!b || !D) return;
  const act = b.dataset.act, ctx = D.ctx;
  if (act !== 'dr-fs') b.closest('details.more')?.removeAttribute('open');
  if (act === 'dr-tab') switchTab(b.dataset.tab);
  else if (act === 'dr-action') doAction(b.dataset.a);
  else if (act === 'dr-copy') copyText(b.dataset.text);
  else if (act === 'dr-adopt') adoptDialog();
  else if (act === 'dr-model') { const cs = findSess(ctx, D.sid); if (isAntigravity(cs)) { switchTab('term'); toast('Ketik /model atau /permissions di terminal Gemini'); } else if (isCodex(cs)) pickCodexSettings(cs); else pickModel(D.sid); }
  else if (act === 'dr-full') toggleFull();
  else if (act === 'dr-sw') toggleSwitcher();
  else if (act === 'dr-fs') setTermFont(Number(b.dataset.d));
  else if (act === 'dr-sess') openSession(ctx, b.dataset.sid, 'term');
  else if (act === 'dr-role') openRole(ctx, b.dataset.role);
  else if (act === 'dr-shift') startShiftDialog(ctx, b.dataset.role);
  else if (act === 'dr-edit') openRoleEditor(ctx, b.dataset.role);
  else if (act === 'pb-new') newPlaybookFor(ctx, roleOf(ctx, b.dataset.role), () => paintRolePb());
}
function onKey(e) {
  if (e.target.id === 'drQuickIn' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form?.requestSubmit(); }
}
async function onSubmit(e) {
  if (e.target.id !== 'drQuick' || !D?.sid) return;
  e.preventDefault();
  const input = $('#drQuickIn'), text = input.value.trim(); if (!text) return;
  if (await sendAction(D.sid, 'text', text)) { input.value = ''; toast('Terkirim', 'ok'); D.chat?.refresh(); setTimeout(() => D?.sid && loadTranscript(D.sid), 1200); }
}

/* ---------------- live ---------------- */
async function setMode(sel) {
  const sid = D?.sid, want = sel.value;
  sel.disabled = true;
  try { const r = await post(`/api/sessions/${encodeURIComponent(sid)}/mode`, { mode: want }); toast(`Mode izin: ${MODE_LABEL[r.mode] || r.mode}`, 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  sel.disabled = false;
  const s = findSess(D.ctx, sid), slot = drawerEl().querySelector('[data-slot="mode"]');
  if (s && slot) slot.innerHTML = modeSelect(s);
}
export function drawerOnLive(ctx, msg) {
  if (!D || !drawerState().open || D.key !== drawerState().key) return;
  D.ctx = ctx;
  if (msg.t === 'dm') D.dm?.refresh();
  if (msg.t === 'session' || msg.t === 'session-gone') { const sw = drawerEl().querySelector('[data-slot="switch"]'); if (sw) sw.outerHTML = switcherHTML(ctx, D.sid); }
  if (D.kind === 'role') { liveRole(ctx, msg); return; }
  if (!D.sid) return;
  if (msg.t?.startsWith('inbox')) D.chat?.live(msg);
  if (msg.t === 'session-gone' && msg.sid === D.sid) {
    // same terminal, new session id (Codex's first turn, /clear, /resume): reopen on the new id, same tab
    if (msg.next && findSess(ctx, msg.next)) { openSession(ctx, msg.next, D.tab); return; }
    markEnded(ctx); return;
  }
  if (msg.t === 'transcript' && msg.sid === D.sid) { const box = $('#trBox'); if (box && (msg.switched || box.dataset.size !== String(msg.size))) loadTranscript(D.sid); return; }
  if (msg.t !== 'session' || msg.session?.sid !== D.sid) return;
  const s = findSess(ctx, D.sid) || msg.session;
  const head = drawerEl().querySelector('.dr-head');
  if (head) head.outerHTML = headHTML(sessLook(ctx, s), sessName(ctx, s), sessSub(ctx, s), sessChips(s));
  if (D.chat) { D.chat.update(); if (s.status === 'ended') markEnded(ctx); return; }
  if (s.status === 'ended') { markEnded(ctx); return; }
  { const slot = drawerEl().querySelector('[data-slot="mode"]'); if (slot && !slot.querySelector('select:disabled') && document.activeElement?.dataset?.act !== 'dr-mode') slot.innerHTML = modeSelect(s); }
  if (D.tab === 'subs') { const sec = drawerEl().querySelector('[data-slot="subs"]'); if (sec) sec.outerHTML = subsHTML(ctx, s).match(/<section class="dr-sec" data-slot="subs">[\s\S]*?<\/section>/)[0]; }
  if (D.tab === 'term' && s.tmux && $('#trBox')) { renderBody(); return; }
  if (D.tab === 'term' && !s.tmux) { const f = drawerEl().querySelector('[data-slot="facts"]'); if (f) f.innerHTML = factsHTML(ctx, s); }
}
function markEnded(ctx) {
  if (D.tab === 'chat') { D.chat?.update(); const h = drawerEl().querySelector('.dr-head .btn-row'); if (h) h.innerHTML = '<span class="st ended">Selesai</span>'; return; }
  if (D.tab === 'term' || D.tab === 'subs') {
    if (D.tab === 'term') { disposeTerm(true); const body = $('#drBody'); if (body) body.innerHTML = endedBanner(); const t = drawerEl().querySelector('[data-slot="tools"]'); if (t) t.innerHTML = ''; }
    else { const body = $('#drBody'); if (body && !body.querySelector('[data-slot="ended"]')) body.insertAdjacentHTML('afterbegin', endedBanner()); }
  } else { const body = $('#drBody'); if (body && !body.querySelector('[data-slot="ended"]')) body.insertAdjacentHTML('afterbegin', endedBanner()); }
  const head = drawerEl().querySelector('.dr-head .btn-row');
  if (head) head.innerHTML = '<span class="st ended">Selesai</span>';
}
function liveRole(ctx, msg) {
  if (msg.t === 'changed' && msg.what === 'wiki') paintRolePb();
  if (msg.t !== 'session' && msg.t !== 'session-gone' && !(msg.t === 'changed' && msg.what === 'roles')) return;
  const r = roleOf(ctx, D.roleId); if (!r) return;
  const head = drawerEl().querySelector('.dr-head');
  if (head) head.outerHTML = roleHead(ctx, r);
  const sec = drawerEl().querySelector('[data-slot="sess"]');
  if (sec) sec.innerHTML = roleSessionsHTML(ctx, r);
}
