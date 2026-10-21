// Tab Arsip: riwayat sesi kantor, bisa dilanjutkan atau dibuka.
import { $, esc, short, sprite, guestLook, usd, dateLong, ago, api, post, toast, modal, closeModal, debounce } from './util.js';
import { openSession } from './drawer.js';
import { openWhenReady, PERMS } from './roles.js';

const A = { el: null, ctx: null, rows: [], f: { role: '', q: '', paid: false } };
const oid = ctx => encodeURIComponent(ctx.office.id);
const roleOf = id => A.ctx.office.roles.find(r => r.id === id);
const roomName = id => A.ctx.office.plan.rooms.find(r => r.id === id)?.name || id || '';

export async function render(el, ctx) {
  A.el = el; A.ctx = ctx;
  if (!el.dataset.arBound) {
    el.dataset.arBound = '1';
    el.addEventListener('click', onClick);
    el.addEventListener('input', debounce(onFilter, 150));
    el.addEventListener('change', onFilter);
  }
  el.innerHTML = '<p class="empty-line">Memuat…</p>';
  await load();
}
export function live(msg) {
  if (!A.el?.isConnected) return;
  if (msg.t === 'session-gone' || (msg.t === 'session' && msg.session?.status === 'ended')) load().catch(() => {});
}
export function unmount() { A.el = null; }

async function load() {
  A.rows = await api(`/api/offices/${oid(A.ctx)}/archive`);
  if (A.el?.isConnected) shell();
}

function shell() {
  const roles = A.ctx.office.roles;
  A.el.innerHTML = `<div class="roles-head"><div><h2>Arsip sesi</h2><p class="sub">Semua sesi di kantor ini, termasuk yang dijalankan manual. Transkripnya tersimpan di <code>~/.claude/projects</code> sehingga sesi bisa dilanjutkan.</p></div></div>
    <div class="bd-toolbar" style="margin-bottom:12px"><select id="ar-role" aria-label="Filter role"><option value="">Semua role</option>${roles.map(r => `<option value="${esc(r.id)}"${r.id === A.f.role ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="__none"${A.f.role === '__none' ? ' selected' : ''}>Sesi manual (tanpa role)</option></select>
      <input id="ar-q" type="search" placeholder="Cari judul atau perintah awal" value="${esc(A.f.q)}" aria-label="Cari">
      <label class="check"><input type="checkbox" id="ar-paid"${A.f.paid ? ' checked' : ''}> Hanya yang ada biaya</label></div>
    <div class="arch" id="ar-list"></div>`;
  list();
}

function filtered() {
  const { role, q, paid } = A.f, needle = q.trim().toLowerCase();
  return A.rows.filter(a => {
    if (role === '__none' ? a.role : role && a.role !== role) return false;
    if (paid && !(a.cost > 0)) return false;
    if (needle && !`${a.title || ''} ${a.first_prompt || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function rowHTML(a) {
  const r = a.role ? roleOf(a.role) : null;
  const seen = a.last_seen || a.ended_at;
  const when = a.active ? `mulai ${dateLong(a.started_at)}` : `${dateLong(a.started_at)} · terakhir ${ago(seen)}`;
  const meta = [r ? r.name : 'Sesi manual', roomName(a.room), when, a.cost > 0 ? usd(a.cost) : ''].filter(Boolean).map(esc).join(' · ');
  const action = a.active
    ? `<button class="btn sm primary" data-act="ar-open" data-sid="${esc(a.sid)}">Buka</button>`
    : `<button class="btn sm" data-act="ar-resume" data-sid="${esc(a.sid)}">Lanjutkan</button>`;
  return `<div class="arow"><div>${sprite(r || guestLook(a.sid), 2)}</div><div style="min-width:0"><h3>${esc(short(a.title || a.first_prompt || 'Sesi tanpa judul', 110))} ${a.active ? '<span class="st working">Aktif</span>' : ''}</h3><p>${meta}</p></div>${action}</div>`;
}

function list() {
  const rows = filtered(), el = $('#ar-list');
  if (!el) return;
  if (!A.rows.length) { el.innerHTML = '<p class="empty-line">Belum ada sesi yang tercatat di kantor ini.</p>'; return; }
  el.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<p class="empty-line">Tidak ada sesi yang cocok dengan filter.</p>';
}

function onFilter(e) {
  if (!['ar-role', 'ar-q', 'ar-paid'].includes(e.target.id)) return;
  A.f = { role: $('#ar-role').value, q: $('#ar-q').value, paid: $('#ar-paid').checked };
  list();
}

function onClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = A.rows.find(x => x.sid === b.dataset.sid); if (!a) return;
  if (b.dataset.act === 'ar-open') openSession(A.ctx, a.sid, 'term');
  else if (b.dataset.act === 'ar-resume') resume(a);
}

async function startResume(roleId, sid) {
  try {
    const r = await post(`/api/offices/${oid(A.ctx)}/roles/${encodeURIComponent(roleId)}/start`, { resumeSid: sid });
    toast('Sesi dilanjutkan', 'ok');
    openWhenReady(A.ctx, r.sid);
    return true;
  } catch (err) { toast(err.message, 'bad'); return false; }
}

function resume(a) {
  if (a.role && roleOf(a.role)) { startResume(a.role, a.sid); return; }
  const roles = A.ctx.office.roles.filter(r => !r.archived);
  modal({ title: 'Lanjutkan sesi manual', body: 'Sesi ini dilanjutkan di terminal kantor pada folder yang sama. Transkrip percakapan tetap tersimpan di ~/.claude/projects, jadi Claude melanjutkan dengan konteks yang sama.',
    html: `<div class="field"><label for="ar-pick">Lanjutkan sebagai</label><select id="ar-pick"><option value="">Sesi tanpa role (apa adanya)</option>${roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${esc(r.title)}</option>`).join('')}</select></div>
      <div class="field"><label for="ar-perm">Mode izin</label><select id="ar-perm">${PERMS.map(([v, l]) => `<option value="${v}"${v === 'bypassPermissions' ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`,
    actions: [{ label: 'Lanjutkan', kind: 'primary', fn: () => {
      const role = $('#ar-pick').value || null, permissionMode = $('#ar-perm').value || null;
      post(`/api/sessions/${encodeURIComponent(a.sid)}/adopt`, { role, permissionMode })
        .then(() => { closeModal(); toast('Sesi dilanjutkan', 'ok'); openWhenReady(A.ctx, a.sid); })
        .catch(err => toast(err.message, 'bad'));
      return false;
    } }, { label: 'Batal' }] });
}
