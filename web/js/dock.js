// Dok bawah: tab Proses (npm run dev, …) dan Terminal (zsh di tmux, tahan reload). Ctrl+` membuka/menutup.
import { keybarHTML, bindKeybar, ctrlFilter } from './drawer.js';
import { $, esc, api, post, patch, del, toast, modal, confirmDo, ago, attachTermRenderer } from './util.js';

const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
const S = { ctx: null, open: false, office: null, room: null, tab: 'proc', h: 0, max: false, terms: [], procs: [], sugg: {}, logId: null, loading: false, flash: null, seen: new Set() };
const TERMS = new Map(); // tmux name -> { el, term, fit, ws }
let el = null, logTerm = null, logFit = null, logOff = 0, logTimer = 0;
const STATUS = { jalan: 'Jalan', berhenti: 'Berhenti', gagal: 'Gagal' };
const IDLE_SH = /^-?(zsh|bash|sh|fish)$/;

const officeId = () => { const id = S.ctx?.office?.id; return id && id !== '_kompleks' ? id : null; };
const rooms = () => (S.ctx?.office?.plan?.rooms || []).filter(r => r.path != null);
const roomName = id => S.ctx?.office?.plan?.rooms.find(r => r.id === id)?.name || id || '';
const base = () => `/api/offices/${encodeURIComponent(S.office)}`;
const maxH = () => Math.max(160, innerHeight - 90);
const clampH = h => Math.max(150, Math.min(maxH(), h));
const termFont = () => Math.min(20, Math.max(9, Number(LS('kc.term.fs')) || 13));
const THEME = { background: '#0E1218', foreground: '#D4DAE3', cursor: '#E4A445' };
const FONT = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const preview = url => { const v = window.kantorViewer; if (v?.openUrl) v.openUrl(url); else window.open(url, '_blank', 'noopener'); };

/* ---------------- pasang ---------------- */
export function initDock(ctx) {
  S.ctx = ctx;
  S.h = clampH(Number(LS('kc.dock.h')) || 320);
  S.max = LS('kc.dock.max') === '1';
  S.tab = LS('kc.dock.tab') || 'proc';
  el = document.createElement('section');
  el.id = 'dock'; el.className = 'dock'; el.hidden = true; el.setAttribute('aria-label', 'Proses dan terminal');
  el.innerHTML = `<div class="dk-grip" data-dk="grip" title="Tarik untuk mengubah tinggi"></div>
    <div class="dk-bar"><div class="dk-tabs" id="dkTabs" role="tablist"></div>
      <div class="dk-ctl"><button class="dk-i" data-dk="max" title="Perbesar / kecilkan" aria-label="Perbesar dok">⤢</button><button class="dk-i" data-dk="hide" title="Sembunyikan (Ctrl+\`)" aria-label="Sembunyikan dok">✕</button></div></div>
    <div class="dk-body" id="dkBody">
      <div class="dk-proc" id="dkProc"><div class="dk-list" id="dkList"></div>
        <div class="dk-log" id="dkLog" hidden><div class="dk-log-h" id="dkLogH"></div><div class="dk-log-t" id="dkLogT"></div></div></div>
      <div class="dk-terms" id="dkTerms" hidden></div></div>
    <div class="dk-kb" id="dkKb" hidden>${keybarHTML()}</div>`;
  document.body.appendChild(el);
  bindKeybar($('.kb-wrap', el), () => TERMS.get(S.tab));
  // keyboard layar di HP menutupi dok yang menempel di bawah layar: naikkan dok setinggi keyboard
  const vv = window.visualViewport;
  if (vv) { const lift = () => { const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)); el.style.bottom = kb > 80 ? kb + 'px' : ''; }; vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift); }
  const btn = $('#dockBtn');
  if (btn) { btn.insertAdjacentHTML('beforeend', '<b class="dk-n" id="dkN" hidden>0</b>'); btn.addEventListener('click', e => { e.preventDefault(); toggle(); }); }
  window.addEventListener('keydown', e => { if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); e.stopPropagation(); toggle(); } }, true);
  el.addEventListener('click', onClick);
  el.addEventListener('dblclick', onDbl);
  el.addEventListener('pointerdown', onGrip);
  document.addEventListener('click', e => { if (!e.target.closest('.dk-menu, [data-dk="menu"]')) $('.dk-menu')?.remove(); });
  new ResizeObserver(() => fitActive()).observe($('#dkBody'));
  addEventListener('resize', () => { if (S.open) { S.h = clampH(S.h); apply(); } });
  addEventListener('hashchange', () => { setTimeout(sync, 350); setTimeout(sync, 1500); });
  applyVars();
  setTimeout(sync, 1200);
  if (LS('kc.dock.open') === '1') setTimeout(() => open(), 800);
}
export function openDock({ office, room } = {}) {
  sync();
  if (room) { S.room = room; S.flash = room; }
  S.tab = 'proc'; open();
}
export function dockLive(m) {
  if (!el) return;
  if (m.t === 'reconnected') { sync(true); for (const [n, t] of TERMS) if (t.ws?.readyState > 1 && n === S.tab && S.open) connect(n); return; }
  if (m.t === 'proc' && m.office === S.office) {
    if (m.removed) { S.procs = S.procs.filter(p => p.id !== m.removed); if (S.logId === m.removed) S.logId = null; }
    else if (m.proc) {
      const i = S.procs.findIndex(p => p.id === m.proc.id);
      if (i >= 0) S.procs[i] = m.proc; else S.procs.push(m.proc);
      if (m.proc.pending && !S.seen.has(m.proc.id)) { S.seen.add(m.proc.id); toast(`Agen mengusulkan perintah "${m.proc.cmd}". Buka dok Proses untuk menyetujuinya.`, 'warn'); }
    }
    badge(); if (S.open) { renderList(); renderLogHead(); }
  }
}

/* ---------------- buka / tutup / ukuran ---------------- */
const toggle = () => (S.open ? close() : open());
function open() {
  if (!S.office && !sync()) { toast('Buka sebuah kantor dulu untuk memakai dok.', 'warn'); }
  S.open = true; LS('kc.dock.open', '1');
  el.hidden = false; apply(); render(); load();
}
function close() { S.open = false; LS('kc.dock.open', '0'); el.hidden = true; clearInterval(logTimer); logTimer = 0; apply(); }
function applyVars() { document.documentElement.style.setProperty('--dock-h', S.open ? (S.max ? 'calc(100dvh - 52px)' : S.h + 'px') : '0px'); }
function apply() {
  document.body.classList.toggle('dock-open', S.open);
  el.classList.toggle('max', S.max);
  const b = el.querySelector('[data-dk="max"]'); if (b) { b.textContent = S.max ? '⤡' : '⤢'; b.title = S.max ? 'Kecilkan' : 'Perbesar'; }
  applyVars();
  clearTimeout(apply.t); apply.t = setTimeout(() => { dispatchEvent(new Event('resize')); fitActive(); }, 60);
}
function onGrip(e) {
  const g = e.target.closest('[data-dk="grip"]'); if (!g || S.max) return;
  e.preventDefault(); g.setPointerCapture(e.pointerId); document.body.classList.add('dk-drag');
  const mv = ev => { S.h = clampH(innerHeight - ev.clientY); applyVars(); };
  const up = () => { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); document.body.classList.remove('dk-drag'); LS('kc.dock.h', String(Math.round(S.h))); apply(); };
  g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up);
}

/* ---------------- data ---------------- */
function sync(force) {
  const id = officeId();
  if (id === S.office && !force) return !!id;
  if (id !== S.office) { S.office = id; S.procs = []; S.terms = []; S.sugg = {}; S.logId = null; S.room = null; if (S.open) render(); }
  if (id) { load(); return true; }
  badge(); return false;
}
async function load() {
  if (!S.office || S.loading) return;
  S.loading = true;
  const o = S.office;
  try {
    const [p, t] = await Promise.all([api(`${base()}/procs${S.open ? '' : '?s=0'}`), api(`${base()}/terms`)]);
    if (o !== S.office) return;
    S.procs = p.procs; if (S.open || !Object.keys(S.sugg).length) S.sugg = p.suggestions || S.sugg; S.terms = t;
    for (const x of S.procs) if (x.pending) S.seen.add(x.id);
    if (S.tab !== 'proc' && !S.terms.some(x => x.name === S.tab)) S.tab = 'proc';
    badge(); if (S.open) render();
  } catch (e) { if (S.open) toast(e.message, 'bad'); } finally { S.loading = false; }
}
function badge() {
  const n = $('#dkN'), b = $('#dockBtn'); if (!n || !b) return;
  const up = S.procs.filter(p => p.status === 'jalan').length, pend = S.procs.some(p => p.pending);
  n.hidden = !up && !pend; n.textContent = pend ? '!' : up; b.classList.toggle('on', up > 0); b.classList.toggle('ask', pend);
  b.title = `Proses & terminal (Ctrl+\`)${up ? ` · ${up} proses jalan` : ''}${pend ? ' · ada perintah menunggu persetujuan' : ''}`;
}

/* ---------------- render ---------------- */
function render() { renderTabs(); showPane(); renderList(); renderLogHead(); }
function renderTabs() {
  const up = S.procs.filter(p => p.status === 'jalan').length;
  $('#dkTabs').innerHTML = `<button role="tab" class="dk-tab${S.tab === 'proc' ? ' cur' : ''}" aria-selected="${S.tab === 'proc'}" data-dk="tab" data-tab="proc">▶ Proses${up ? `<b class="dk-cnt">${up}</b>` : ''}</button>`
    + S.terms.map(t => `<span class="dk-tab term${S.tab === t.name ? ' cur' : ''}" role="tab" aria-selected="${S.tab === t.name}" data-dk="tab" data-tab="${esc(t.name)}" title="Klik dua kali untuk ganti nama${t.room ? ' · ' + esc(roomName(t.room)) : ''}"><span class="dk-tl">${esc(t.title)}</span><button class="dk-x" data-dk="term-close" data-name="${esc(t.name)}" aria-label="Tutup terminal ${esc(t.title)}" title="Tutup terminal">×</button></span>`).join('')
    + `<button class="dk-add" data-dk="term-new" title="Terminal baru di ${esc(roomName(S.room || defRoom()) || 'kantor')}" aria-label="Terminal baru">+</button><button class="dk-add sm" data-dk="menu" title="Pilih ruangan" aria-label="Pilih ruangan terminal baru">▾</button>`;
}
function defRoom() { return S.room || rooms().find(r => r.kind === 'kode')?.id || rooms()[0]?.id || null; }
function showPane() {
  const proc = S.tab === 'proc';
  $('#dkProc').hidden = !proc; $('#dkTerms').hidden = proc; $('#dkKb').hidden = proc;
  clearInterval(logTimer); logTimer = 0;
  if (proc) { if (S.logId) startLog(); return; }
  showTerm(S.tab);
}

const chip = p => p.stopping ? '<span class="pr-st stop">Menghentikan…</span>' : `<span class="pr-st ${p.status}">${STATUS[p.status]}${p.status === 'gagal' && p.code != null ? ` · kode ${p.code}` : ''}</span>`;
function procRow(p) {
  const up = p.status === 'jalan';
  const acts = p.pending
    ? `<button class="dk-b ok" data-dk="approve" data-id="${p.id}" data-start="1">Setujui &amp; jalankan</button><button class="dk-b" data-dk="approve" data-id="${p.id}">Setujui</button><button class="dk-b bad" data-dk="del" data-id="${p.id}">Tolak</button>`
    : `${up ? `<button class="dk-b bad" data-dk="stop" data-id="${p.id}">Hentikan</button><button class="dk-b" data-dk="restart" data-id="${p.id}">Ulang</button>` : `<button class="dk-b ok" data-dk="start" data-id="${p.id}">Jalankan</button>`}<button class="dk-b" data-dk="edit" data-id="${p.id}" title="Ubah">Ubah</button><button class="dk-b" data-dk="del" data-id="${p.id}" title="Hapus dari daftar">Hapus</button>`;
  return `<div class="pr${S.logId === p.id ? ' sel' : ''}${p.pending ? ' pend' : ''}" data-dk="log" data-id="${p.id}"><span class="pr-dot ${p.pending ? 'wait' : p.status}"></span>
    <div class="pr-main"><div class="pr-l1"><b>${esc(p.name)}</b>${p.pending ? '<span class="pr-st wait">Diusulkan agen</span>' : chip(p)}${p.status === 'jalan' && p.since ? `<span class="pr-since">${esc(ago(p.since))}</span>` : ''}</div><code class="pr-cmd">${esc(p.cmd)}</code></div>
    ${p.url ? `<span class="pr-port"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.url)}">:${p.port}</a><button class="dk-b pv" data-dk="preview" data-url="${esc(p.url)}">Pratinjau</button></span>` : ''}
    <div class="pr-act">${acts}</div></div>`;
}
function renderList() {
  const box = $('#dkList'); if (!box) return;
  if (!S.office) { box.innerHTML = '<p class="dk-empty">Buka sebuah kantor untuk melihat prosesnya.</p>'; return; }
  const all = S.ctx.office?.plan?.rooms || [];
  const has = r => S.procs.some(p => p.room === r.id) || (S.sugg[r.id] || []).length || r.id === S.room;
  const shown = all.filter(has), more = all.filter(r => r.path != null && !has(r));
  const orphan = S.procs.filter(p => !all.some(r => r.id === p.room));
  const sc = box.scrollTop;
  box.innerHTML = (shown.length || orphan.length ? '' : '<p class="dk-empty">Belum ada perintah. Pilih ruangan di bawah, lalu tambahkan mis. <code>npm run dev</code>.</p>') + shown.map(r => {
    const ps = S.procs.filter(p => p.room === r.id), sg = S.sugg[r.id] || [];
    return `<section class="pg${S.flash === r.id ? ' flash' : ''}" data-room="${esc(r.id)}"><header class="pg-h"><b>${esc(r.name)}</b>${r.path ? `<code>${esc(r.path)}/</code>` : ''}<span class="sp"></span>
      <button class="dk-b" data-dk="term-new" data-room="${esc(r.id)}">▸ Terminal</button><button class="dk-b" data-dk="add" data-room="${esc(r.id)}">+ Perintah</button></header>
      ${ps.map(procRow).join('')}
      ${sg.map((s, i) => `<div class="pr sug"><span class="pr-dot sug"></span><div class="pr-main"><div class="pr-l1"><code class="pr-cmd">${esc(s.cmd)}</code><span class="pr-since">${esc(s.why)}</span></div></div><div class="pr-act"><button class="dk-b" data-dk="sug" data-room="${esc(r.id)}" data-i="${i}">Tambah</button><button class="dk-b ok" data-dk="sug" data-room="${esc(r.id)}" data-i="${i}" data-start="1">Tambah &amp; jalankan</button></div></div>`).join('')}
      ${!ps.length && !sg.length ? '<p class="dk-empty sm">Belum ada perintah. Tambah satu, mis. <code>npm run dev</code>.</p>' : ''}</section>`;
  }).join('') + (more.length ? `<div class="dk-more"><span>Tambah perintah di</span>${more.map(r => `<button class="dk-b" data-dk="add" data-room="${esc(r.id)}">${esc(r.name)}</button>`).join('')}</div>` : '') + (orphan.length ? `<section class="pg"><header class="pg-h"><b>Ruangan lain</b></header>${orphan.map(procRow).join('')}</section>` : '');
  box.scrollTop = sc;
  if (S.flash) { const g = box.querySelector('.pg.flash'); g?.scrollIntoView({ block: 'nearest' }); setTimeout(() => { S.flash = null; g?.classList.remove('flash'); }, 1600); }
}

/* ---------------- log langsung ---------------- */
function renderLogHead() {
  const box = $('#dkLog'), p = S.procs.find(x => x.id === S.logId);
  if (!box) return;
  box.hidden = !p; $('#dkProc').classList.toggle('with-log', !!p);
  if (!p) return;
  $('#dkLogH').innerHTML = `<button class="dk-b back" data-dk="log-close">← Daftar</button><b>${esc(p.name)}</b>${chip(p)}<code class="pr-cmd">${esc(p.cmd)}</code><span class="sp"></span>${p.url ? `<a class="pr-port-l" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a><button class="dk-b pv" data-dk="preview" data-url="${esc(p.url)}">Pratinjau</button>` : ''}<button class="dk-b" data-dk="log-clear" title="Kosongkan tampilan (log di disk tetap)">Bersihkan</button><button class="dk-i" data-dk="log-close" aria-label="Tutup log">✕</button>`;
}
function ensureLogTerm() {
  if (logTerm || !window.Terminal) return;
  logTerm = new window.Terminal({ disableStdin: true, cursorBlink: false, cursorStyle: 'bar', cursorInactiveStyle: 'none', fontFamily: FONT, fontSize: Math.max(11, termFont() - 1), scrollback: 8000, theme: { ...THEME, cursor: THEME.background } });
  logFit = new window.FitAddon.FitAddon(); logTerm.loadAddon(logFit);
  logTerm.open($('#dkLogT'));
  new ResizeObserver(() => { try { if ($('#dkLogT').clientHeight > 20) logFit.fit(); } catch {} }).observe($('#dkLogT'));
}
async function startLog() {
  clearInterval(logTimer); logTimer = 0;
  const id = S.logId, p = S.procs.find(x => x.id === id); if (!p) return;
  renderLogHead(); ensureLogTerm(); if (!logTerm) return;
  logTerm.reset(); logOff = -1; try { logFit.fit(); } catch {}
  const pull = async () => {
    if (S.logId !== id || !S.open || S.tab !== 'proc') return;
    try {
      const r = await api(`${base()}/procs/${id}/log${logOff >= 0 ? '?offset=' + logOff : ''}`);
      if (S.logId !== id) return;
      if (logOff >= 0 && r.from !== logOff) logTerm.reset();
      if (r.text) logTerm.write(r.text);
      logOff = r.next;
    } catch {}
  };
  await pull(); logTimer = setInterval(pull, 900);
}

/* ---------------- terminal ---------------- */
function showTerm(name) {
  const box = $('#dkTerms');
  for (const [n, t] of TERMS) t.el.classList.toggle('cur', n === name);
  if (!window.Terminal || !window.FitAddon) { box.innerHTML = '<p class="dk-empty">xterm.js belum termuat. Muat ulang halaman.</p>'; return; }
  let t = TERMS.get(name);
  if (!t) { t = makeTerm(name); box.appendChild(t.el); t.el.classList.add('cur'); }
  else if (t.ws?.readyState > 1) connect(name);
  // a GPU-rendered terminal can come back blank after being hidden: refit and repaint every row
  requestAnimationFrame(() => { try { if (t.el.clientHeight > 20) t.fit.fit(); t.term.refresh(0, t.term.rows - 1); } catch {} if (!document.activeElement?.closest('.dk-tabs')) t.term.focus(); });
}
function makeTerm(name) {
  const e = document.createElement('div'); e.className = 'dk-term';
  const term = new window.Terminal({ cursorBlink: true, fontFamily: FONT, fontSize: termFont(), scrollback: 5000, theme: THEME });
  const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit);
  const t = { el: e, term, fit, ws: null };
  TERMS.set(name, t);
  requestAnimationFrame(async () => {
    term.open(e);
    attachTermRenderer(term);
    await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 400))]);
    try { if (e.clientHeight > 20) fit.fit(); } catch {}
    term.onData(d => { if (t.ws?.readyState === 1) t.ws.send(ctrlFilter(t, d)); });
    let rt = 0;
    term.onResize(({ cols, rows }) => { clearTimeout(rt); rt = setTimeout(() => { if (t.ws?.readyState === 1) t.ws.send('\x00' + JSON.stringify({ cols, rows })); }, 160); });
    connect(name);
  });
  return t;
}
function connect(name) {
  const t = TERMS.get(name); if (!t) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = t.ws = new WebSocket(`${proto}://${location.host}/ws/term?kind=dock&name=${encodeURIComponent(name)}&cols=${t.term.cols}&rows=${t.term.rows}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => t.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = () => { if (t.ws === ws) t.term.write('\r\n\x1b[2m[terputus. Klik tab ini lagi untuk menyambung]\x1b[0m\r\n'); };
}
function fitActive() {
  const t = TERMS.get(S.tab);
  if (t && S.tab !== 'proc') try { if (t.el.clientHeight > 20) t.fit.fit(); } catch {}
  if (S.tab === 'proc' && logFit) try { if ($('#dkLogT')?.clientHeight > 20) logFit.fit(); } catch {}
}
function disposeTerm(name) {
  const t = TERMS.get(name); if (!t) return;
  TERMS.delete(name); try { t.ws.onclose = null; t.ws.close(); } catch {} try { t.term.dispose(); } catch {} t.el.remove();
}
async function newTerm(room) {
  try {
    const t = await post(`${base()}/terms`, { room: room || defRoom() });
    if (room) S.room = room;
    S.terms.push(t); S.tab = t.name; LS('kc.dock.tab', t.name); render();
  } catch (e) { toast(e.message, 'bad'); }
}
function rename(tabEl) {
  const name = tabEl.dataset.tab, lab = tabEl.querySelector('.dk-tl'), cur = S.terms.find(x => x.name === name); if (!cur) return;
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'dk-ren'; inp.value = cur.title; inp.maxLength = 40;
  lab.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const end = async ok => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (ok && v && v !== cur.title) try { const t = await patch(`${base()}/terms/${name}`, { title: v }); cur.title = t.title; } catch (e) { toast(e.message, 'bad'); }
    renderTabs();
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); });
  inp.addEventListener('blur', () => end(true));
}
function closeTerm(name) {
  const t = S.terms.find(x => x.name === name); if (!t) return;
  const go = async () => {
    try { await del(`${base()}/terms/${name}`); } catch (e) { if (!/tidak ditemukan/.test(e.message)) return toast(e.message, 'bad'); }
    disposeTerm(name); S.terms = S.terms.filter(x => x.name !== name);
    if (S.tab === name) { S.tab = S.terms.at(-1)?.name || 'proc'; LS('kc.dock.tab', S.tab); }
    render();
  };
  if (t.busy) confirmDo('Tutup terminal?', `Di "${esc(t.title)}" masih ada perintah yang jalan. Menutup terminal akan menghentikannya.`, 'Tutup', go); else go();
}
function termMenu(btn) {
  $('.dk-menu')?.remove();
  const m = document.createElement('div'); m.className = 'dk-menu';
  m.innerHTML = rooms().map(r => `<button data-dk="term-new" data-room="${esc(r.id)}"><b>${esc(r.name)}</b><code>${esc(r.path || '.')}</code></button>`).join('') || '<p class="dk-empty sm">Belum ada ruangan.</p>';
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px'; m.style.bottom = (innerHeight - r.top + 6) + 'px';
}

/* ---------------- perintah ---------------- */
function editor(p, roomId) {
  const rs = S.ctx.office.plan.rooms.filter(r => r.path != null || r.id === (p?.room || roomId));
  modal({ title: p ? 'Ubah perintah' : 'Perintah baru', html: `<div class="field"><label class="ctl-l" for="dkName">Nama</label><input id="dkName" type="text" placeholder="mis. Dev server" value="${esc(p?.name || '')}"></div>
    <div class="field" style="margin-top:10px"><label class="ctl-l" for="dkCmd">Perintah</label><input id="dkCmd" type="text" placeholder="npm run dev" spellcheck="false" autocomplete="off" value="${esc(p?.cmd || '')}"></div>
    ${p ? `<div class="field" style="margin-top:10px"><label class="ctl-l" for="dkRoom">Ruangan</label><select id="dkRoom">${rs.map(r => `<option value="${esc(r.id)}"${r.id === p.room ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>` : ''}
    <p class="dim" style="margin-top:8px;font-size:12px">Dijalankan lewat zsh di folder ruangan. Port dibaca otomatis dari lognya.</p>`,
    actions: [{ label: 'Simpan', kind: 'primary', fn: async () => {
      const cmd = $('#dkCmd').value.trim(); if (!cmd) { toast('Perintah belum diisi', 'warn'); return false; }
      try {
        if (p) await patch(`${base()}/procs/${p.id}`, { name: $('#dkName').value, cmd, room: $('#dkRoom').value });
        else await post(`${base()}/procs`, { room: roomId, name: $('#dkName').value, cmd });
        await load();
      } catch (e) { toast(e.message, 'bad'); }
    } }, { label: 'Batal' }] });
  for (const i of ['#dkName', '#dkCmd']) $(i).addEventListener('keydown', ev => { if (ev.key === 'Enter') $('#modalCard [data-modal="0"]').click(); });
}
const act = async (path, body, okMsg) => { try { const v = await post(`${base()}/procs/${path}`, body); upsert(v); if (okMsg) toast(okMsg, 'ok'); return v; } catch (e) { toast(e.message, 'bad'); } };
function upsert(v) { const i = S.procs.findIndex(p => p.id === v.id); if (i >= 0) S.procs[i] = v; else S.procs.push(v); badge(); renderList(); renderLogHead(); renderTabs(); }

async function onClick(e) {
  const t = e.target.closest('[data-dk]'); if (!t) return;
  const k = t.dataset.dk, id = t.dataset.id;
  if (k === 'grip') return;
  if (k === 'log' && e.target.closest('a, button')) return;
  e.stopPropagation();
  switch (k) {
    case 'hide': close(); break;
    case 'max': S.max = !S.max; LS('kc.dock.max', S.max ? '1' : '0'); apply(); break;
    case 'tab': {
      if (e.target.closest('.dk-x') || e.target.closest('.dk-ren')) return;
      if (S.tab === t.dataset.tab) return;
      S.tab = t.dataset.tab; LS('kc.dock.tab', S.tab);
      for (const x of $('#dkTabs').querySelectorAll('.dk-tab')) { x.classList.toggle('cur', x === t); x.setAttribute('aria-selected', String(x === t)); }
      showPane(); break;
    }
    case 'term-new': $('.dk-menu')?.remove(); newTerm(t.dataset.room || null); break;
    case 'menu': termMenu(t); break;
    case 'term-close': closeTerm(t.dataset.name); break;
    case 'add': editor(null, t.dataset.room); break;
    case 'edit': editor(S.procs.find(p => p.id === id)); break;
    case 'start': act(`${id}/start`); break;
    case 'stop': act(`${id}/stop`); break;
    case 'restart': act(`${id}/restart`, {}, 'Dimulai ulang'); break;
    case 'approve': act(`${id}/approve`, { start: !!t.dataset.start }); break;
    case 'del': {
      const p = S.procs.find(x => x.id === id); if (!p) break;
      const go = async () => { try { await del(`${base()}/procs/${id}`); S.procs = S.procs.filter(x => x.id !== id); if (S.logId === id) S.logId = null; badge(); renderList(); renderLogHead(); renderTabs(); } catch (er) { toast(er.message, 'bad'); } };
      if (p.pending || p.status !== 'jalan') go(); else confirmDo('Hapus proses?', `"${esc(p.name)}" sedang jalan dan akan dihentikan.`, 'Hapus', go);
      break;
    }
    case 'sug': {
      const s = (S.sugg[t.dataset.room] || [])[Number(t.dataset.i)]; if (!s) break;
      try {
        const v = await post(`${base()}/procs`, { room: t.dataset.room, name: s.name, cmd: s.cmd, auto: true, start: !!t.dataset.start });
        S.sugg[t.dataset.room] = (S.sugg[t.dataset.room] || []).filter(x => x.cmd !== s.cmd); upsert(v);
        if (t.dataset.start) { S.logId = v.id; renderList(); startLog(); }
      } catch (er) { toast(er.message, 'bad'); }
      break;
    }
    case 'preview': e.preventDefault(); preview(t.dataset.url); break;
    case 'log': S.logId = S.logId === id ? null : id; renderList(); if (S.logId) { startLog(); } else { clearInterval(logTimer); logTimer = 0; renderLogHead(); } break;
    case 'log-close': S.logId = null; clearInterval(logTimer); logTimer = 0; renderList(); renderLogHead(); break;
    case 'log-clear': logTerm?.reset(); break;
  }
}
function onDbl(e) {
  const t = e.target.closest('.dk-tab.term'); if (t && !e.target.closest('.dk-x, .dk-ren')) rename(t);
}
