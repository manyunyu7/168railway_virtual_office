// Daftar "Agen aktif" lintas semua kantor: panel cepat dari header, pintasan keyboard, dan lompat antar sesi.
import { $, esc, short, sprite, guestLook, modelName, ago } from './util.js';
import { drawerState } from './panel.js';

const PIN_KEY = 'kc.agents.pins';
let C = null;            // { ctx, openSession, go }
let open = false, query = '', cursor = 0;
let pins = new Set();
try { pins = new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]')); } catch {}
const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify([...pins])); } catch {} };

const toolText = t => (t && typeof t === 'object' ? [t.name, t.label].filter(Boolean).join(' ') : t) || '';
const rank = s => s.waiting || s.status === 'waiting' ? 0 : s.status === 'working' || s.status === 'starting' ? 1 : 2;
const isCodex = s => s.engine === 'codex';

/** Semua sesi belum selesai di semua kantor, urut: menunggu, bekerja, idle (lalu paling baru aktif). */
export function activeAgents() {
  const out = [];
  for (const o of C?.ctx.st?.offices || []) for (const s of o.sessions || []) if (s.status !== 'ended') out.push({ ...s, office: o });
  return out.sort((a, b) => rank(a) - rank(b) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}
const nameOf = s => s.look?.name || (s.title && s.title !== 'Sesi belum terhubung' ? short(s.title, 34) : 'Sesi manual');
const searchText = s => [nameOf(s), s.title, s.look?.title, s.office.name, s.room, s.model, s.engine || 'claude', toolText(s.tool), s.waiting?.summary].join(' ').toLowerCase();
function whatOf(s) {
  if (s.waiting) return `${s.waiting.tool === 'AskUserQuestion' ? 'bertanya' : 'minta izin'}: ${short(s.waiting.summary || s.waiting.tool, 60)}`;
  const t = toolText(s.tool);
  if (t) return short(t, 60);
  if (s.look?.name && s.title && !s.title.startsWith(s.look.name)) return short(s.title, 60);
  return s.status === 'working' ? 'bekerja' : 'idle';
}

function rowHTML(s, i) {
  const look = s.look || guestLook(s.sid), pin = pins.has(s.sid), st = rank(s);
  const meta = [esc(s.office.name), s.room ? esc(s.room) : '', s.lastSeen ? ago(s.lastSeen) : ''].filter(Boolean).join(' · ');
  return `<li class="ag-li${i === cursor ? ' cur' : ''}" data-i="${i}">
    <button class="ag-open" type="button" data-ag="open" data-office="${esc(s.office.id)}" data-sid="${esc(s.sid)}">
      <span class="ag-ava">${sprite(look, 2)}</span>
      <span class="ag-b"><span class="ag-n"><b>${esc(nameOf(s))}</b><i class="ag-eng${isCodex(s) ? ' cx' : ''}">${s.engine === 'antigravity' ? 'Gemini' : isCodex(s) ? 'Codex' : 'Claude'}</i>${s.model ? `<i class="ag-mod">${esc(modelName(s.model))}</i>` : ''}${s.bgAgents ? `<i class="ag-sub" title="${s.bgAgents} subagent bekerja">⛓ ${s.bgAgents}</i>` : ''}</span>
      <span class="ag-w">${esc(whatOf(s))}</span><span class="ag-m">${meta}</span></span>
      <i class="ag-dot s${st}" title="${['menunggu izin', 'bekerja', 'idle'][st]}"></i>
    </button>
    <button class="ag-btn" type="button" data-ag="term" data-office="${esc(s.office.id)}" data-sid="${esc(s.sid)}" title="Buka Terminal" aria-label="Buka Terminal">⌨</button>
    <button class="ag-btn pin${pin ? ' on' : ''}" type="button" data-ag="pin" data-sid="${esc(s.sid)}" aria-pressed="${pin}" title="${pin ? 'Lepas sematan' : 'Sematkan'}" aria-label="Sematkan">${pin ? '★' : '☆'}</button></li>`;
}

/** Daftar yang tampil di panel (sudah difilter), dengan urutan sama seperti di layar. */
function shown() {
  const q = query.trim().toLowerCase();
  const all = activeAgents().filter(s => !q || searchText(s).includes(q));
  const pinned = all.filter(s => pins.has(s.sid));
  const rest = all.filter(s => !pins.has(s.sid));
  return { pinned, groups: [['Menunggu kamu', rest.filter(s => rank(s) === 0)], ['Bekerja', rest.filter(s => rank(s) === 1)], ['Idle', rest.filter(s => rank(s) === 2)]].filter(g => g[1].length) };
}
const flat = v => [...v.pinned, ...v.groups.flatMap(g => g[1])];

function listHTML() {
  const v = shown(), items = flat(v);
  cursor = Math.min(cursor, Math.max(0, items.length - 1));
  let i = 0;
  const sec = (t, l) => `<p class="ag-h">${t} <span>${l.length}</span></p><ul class="ag-ul">${l.map(s => rowHTML(s, i++)).join('')}</ul>`;
  if (!items.length) return `<p class="empty-line ag-empty">${query ? 'Tidak ada agen yang cocok.' : 'Belum ada agen aktif.'}</p>`;
  return (v.pinned.length ? sec('Disematkan', v.pinned) : '') + v.groups.map(([t, l]) => sec(t, l)).join('');
}
function paintList() { const el = $('#agList'); if (el) el.innerHTML = listHTML(); }

/** Lencana di header: jumlah agen aktif, dan yang menunggu izin. */
export function paintAgentsBadge() {
  const b = $('#agentsBtn'); if (!b || !C) return;
  const l = activeAgents(), w = l.filter(s => rank(s) === 0).length;
  $('#agentsCount').textContent = l.length;
  const wn = $('#agentsWait'); wn.textContent = w; wn.hidden = !w;
  b.classList.toggle('hot', w > 0);
  b.title = `Agen aktif: ${l.length}${w ? `, ${w} menunggu izin` : ''} (Alt+K)`;
}

export function togglePanel(force) {
  const want = force ?? !open;
  if (want === open) return;
  if (!want) { $('#agPanel')?.remove(); $('#agScrim')?.remove(); open = false; $('#agentsBtn')?.setAttribute('aria-expanded', 'false'); return; }
  open = true; query = ''; cursor = 0;
  document.body.insertAdjacentHTML('beforeend', `<div class="ag-scrim" id="agScrim"></div><section class="ag-panel" id="agPanel" role="dialog" aria-label="Agen aktif">
    <header><b>Agen aktif</b><span class="ag-cnt" id="agCnt"></span><button class="icon-btn" type="button" data-ag="close" aria-label="Tutup">✕</button></header>
    <input type="search" id="agQ" placeholder="Cari agen, kantor, model…  (↑↓ pilih, Enter buka)" autocomplete="off" aria-label="Cari agen">
    <div class="ag-list" id="agList"></div></section>`);
  $('#agentsBtn')?.setAttribute('aria-expanded', 'true');
  paintList(); paintCnt();
  $('#agQ').focus();
}
function paintCnt() { const e = $('#agCnt'); if (e) { const l = activeAgents(); e.textContent = `${l.length} sesi · ${new Set(l.map(s => s.office.id)).size} kantor`; } }

/** Buka sesi di kantor mana pun; pindah kantor otomatis bila perlu. */
export function openAgent(officeId, sid, tab = 'chat') {
  const { ctx, openSession, go } = C;
  togglePanel(false);
  const r = ctx.route;
  if (r?.name === 'office' && r.id === officeId && r.tab === 'kantor' && ctx.office?.sessions.some(x => x.sid === sid)) { openSession(ctx, sid, tab); return; }
  ctx.pendingSid = sid; ctx.pendingTab = tab;
  go(`#/o/${encodeURIComponent(officeId)}`);
}
/** Pindah ke agen aktif berikutnya (+1) atau sebelumnya (-1) dari yang sedang terbuka. */
export function stepAgent(dir) {
  const l = activeAgents(); if (!l.length) return;
  const key = drawerState().open ? drawerState().key : '';
  const i = l.findIndex(s => key === 'sess:' + s.sid);
  const n = l[(i < 0 ? (dir > 0 ? 0 : l.length - 1) : (i + dir + l.length) % l.length)];
  openAgent(n.office.id, n.sid, 'chat');
}

/** Tempel perubahan sesi dari websocket ke ctx.st supaya daftar dan lencana selalu mutakhir. */
export function agentsLive(m) {
  const st = C?.ctx.st; if (!st) return;
  let changed = false;
  if (m.t === 'session' && m.session) {
    const o = st.offices.find(x => x.id === m.office);
    if (!o) { clearTimeout(agentsLive.t); agentsLive.t = setTimeout(() => C.refresh().then(refresh), 600); return; }
    const i = o.sessions.findIndex(x => x.sid === m.session.sid);
    const prev = i >= 0 ? o.sessions[i] : null;
    const next = { ...(prev || {}), ...m.session, look: prev?.look || null };
    if (i >= 0) o.sessions[i] = next; else { o.sessions.push(next); if (m.session.role) { clearTimeout(agentsLive.t); agentsLive.t = setTimeout(() => C.refresh().then(refresh), 800); } }
    changed = true;
  } else if (m.t === 'session-gone') {
    for (const o of st.offices) { const k = o.sessions.findIndex(x => x.sid === m.sid); if (k >= 0) { o.sessions.splice(k, 1); changed = true; } }
  }
  if (changed) refresh();
}
function refresh() { paintAgentsBadge(); if (open) { paintList(); paintCnt(); } }

export function initAgents(opts) {
  C = opts;
  paintAgentsBadge();
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ag],[data-act="agents-open"],#agentsBtn,#agScrim');
    if (!b) { if (open && !e.target.closest('#agPanel')) togglePanel(false); return; }
    if (b.id === 'agentsBtn' || b.dataset.act === 'agents-open') { e.preventDefault(); togglePanel(); return; }
    if (b.id === 'agScrim') { togglePanel(false); return; }
    const a = b.dataset.ag;
    if (a === 'close') togglePanel(false);
    else if (a === 'open') openAgent(b.dataset.office, b.dataset.sid, 'chat');
    else if (a === 'term') openAgent(b.dataset.office, b.dataset.sid, 'term');
    else if (a === 'pin') { const s = b.dataset.sid; if (pins.has(s)) pins.delete(s); else pins.add(s); savePins(); paintList(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'agQ') { query = e.target.value; cursor = 0; paintList(); } });
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    // Alt+K / Cmd+K / Ctrl+K (di luar kolom ketik & terminal) membuka panel
    const k = e.key.toLowerCase();
    if (((e.altKey && e.code === 'KeyK') || ((e.metaKey || e.ctrlKey) && k === 'k' && !typing && !e.target.closest('.xterm'))) && !e.shiftKey) { e.preventDefault(); togglePanel(); return; }
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); stepAgent(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); togglePanel(false); return; }
    const items = flat(shown());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); paintList();
      $('#agList .ag-li.cur')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[cursor]) { e.preventDefault(); const s = items[cursor]; openAgent(s.office.id, s.sid, e.shiftKey ? 'term' : 'chat'); }
  }, true);
  window.addEventListener('hashchange', () => togglePanel(false));
}
