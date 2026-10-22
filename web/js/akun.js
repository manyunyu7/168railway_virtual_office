// Akun page (#/akun): your own account, the member list (admins), and the audit log (Riwayat).
// Members only see their own rows in Riwayat; the server enforces that, this page just hides the person filter.
import { $, esc, short, api, post, patch, toast, modal, confirmDo, ago } from './util.js';
import { refreshState } from './main.js';

let root = null, ctx = null, tab = 'riwayat';
let members = [], rows = [], more = false, filter = { actor: '', kind: '', office: '', q: '' };

const me = () => ctx.st?.me || null;
const isAdmin = () => me()?.role === 'admin';
const akunOn = () => !!ctx.st?.akun;

export async function render(el, c, sub = '') {
  root = el; ctx = c;
  tab = ['saya', 'anggota', 'riwayat'].includes(sub) ? sub : akunOn() && me()?.kind === 'member' ? 'saya' : 'riwayat';
  if (tab === 'anggota' && !isAdmin()) tab = 'riwayat';
  el.onclick = onClick; el.onsubmit = onSubmit; el.onchange = onChange;
  try { ctx.st = await refreshState(); } catch {}
  await load();
}
export function unmount() { if (root) root.onclick = root.onsubmit = root.onchange = null; root = null; }

async function load() {
  try {
    if (isAdmin()) members = (await api('/api/akun/anggota')).members;
    if (tab === 'riwayat') await loadRows(false);
  } catch (e) { toast(e.message, 'bad'); }
  draw();
}

const qs = extra => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filter, ...extra })) if (v) p.set(k, v);
  return p.toString();
};
async function loadRows(append) {
  const r = await api('/api/audit?' + qs({ limit: 100, before: append && rows.length ? rows[rows.length - 1].id : '' }));
  rows = append ? rows.concat(r.rows) : r.rows;
  more = r.more;
}

const KIND = { api: 'Aksi', prompt: 'Prompt', terminal: 'Terminal', agen: 'Agen', masuk: 'Masuk', 'masuk-gagal': 'Gagal masuk', keluar: 'Keluar', akun: 'Akun' };
const ROLE = { admin: 'Admin', anggota: 'Anggota' };
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const officeName = id => ctx.st?.offices?.find(o => o.id === id)?.name || id || '';
const status = m => m.disabled ? '<span class="st wait">Nonaktif</span>' : m.active ? '<span class="st working">Aktif</span>' : m.invitePending ? '<span class="st wait">Menunggu undangan</span>' : '<span class="st wait">Undangan kedaluwarsa</span>';

function draw() {
  if (!root) return;
  const tabs = [['saya', 'Akun saya', akunOn() && me()?.kind === 'member'], ['anggota', 'Anggota', isAdmin()], ['riwayat', 'Riwayat', true]].filter(t => t[2]);
  root.innerHTML = `<div class="wrap"><div class="settings">
    <div><p class="eyebrow">Kantor Claude</p><h1>Akun &amp; riwayat</h1></div>
    ${akunOn() ? '' : '<div class="notice">Mode akun belum aktif: kantor ini masih memakai satu token. Riwayat tetap dicatat atas nama "Kamu". Untuk server bersama, lihat <code>docs/AKUN.md</code>.</div>'}
    <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-act="ak-tab" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div>
    ${tab === 'saya' ? drawMe() : tab === 'anggota' ? drawMembers() : drawAudit()}
  </div></div>`;
}

function drawMe() {
  const m = me();
  return `<section class="card"><h2>${esc(m.name)}</h2><dl class="facts" style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px">
      <dt>Username</dt><dd><code>${esc(m.username)}</code></dd><dt>Peran</dt><dd>${ROLE[m.role] || esc(m.role)}</dd></dl>
      <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="ak-logout">Keluar</button></div></section>
    <section class="card"><h2>Ganti password</h2>
      <form id="akPass" class="grid2" autocomplete="off">
        <div class="field" style="grid-column:1/-1"><label for="akCur">Password sekarang</label><input id="akCur" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="akNew">Password baru</label><input id="akNew" type="password" autocomplete="new-password" minlength="10" required></div>
        <div class="field"><label for="akNew2">Ulangi password baru</label><input id="akNew2" type="password" autocomplete="new-password" minlength="10" required></div>
        <div class="field"><label for="akCode">Kode 2FA</label><input id="akCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="000000"></div>
        <p class="hint" style="grid-column:1/-1">Perangkat lain yang masuk dengan akunmu akan dikeluarkan.</p>
        <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit">Simpan password</button></div></form></section>`;
}

function drawMembers() {
  const body = members.length ? members.map(m => `<tr>
      <td><b>${esc(m.name)}</b>${m.id === me()?.id ? ' <span class="hint">(kamu)</span>' : ''}</td><td><code>${esc(m.username)}</code></td>
      <td><select data-act="ak-role" data-id="${esc(m.id)}" aria-label="Peran ${esc(m.name)}">${Object.entries(ROLE).map(([v, l]) => `<option value="${v}"${m.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${status(m)}</td><td>${m.lastLogin ? esc(ago(m.lastLogin)) : '<span class="hint">belum pernah</span>'}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-act="ak-reset" data-id="${esc(m.id)}">${m.active ? 'Reset' : 'Undangan baru'}</button>
        <button class="btn sm ${m.disabled ? '' : 'danger'}" data-act="ak-toggle" data-id="${esc(m.id)}">${m.disabled ? 'Aktifkan' : 'Nonaktifkan'}</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-line">Belum ada anggota.</td></tr>';
  return `<section class="card"><h2>Anggota</h2>
      <p class="hint">Setiap anggota masuk dengan username, password, dan kode 2FA. Semua anggota bisa membuka terminal dan menyuruh agen; aksinya tercatat di Riwayat atas namanya. Admin juga bisa mengelola anggota, pengaturan, dan aturan kantor.</p>
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Nama</th><th>Username</th><th>Peran</th><th>Status</th><th>Terakhir masuk</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>
    <section class="card"><h2>Tambah anggota</h2>
      <form id="akAdd" class="grid2" autocomplete="off">
        <div class="field"><label for="akU">Username</label><input id="akU" required pattern="[a-z0-9][a-z0-9._-]{1,31}" autocapitalize="off" spellcheck="false" placeholder="budi"></div>
        <div class="field"><label for="akN">Nama tampilan</label><input id="akN" required maxlength="60" placeholder="Budi Santoso"></div>
        <div class="field"><label for="akR">Peran</label><select id="akR"><option value="anggota">Anggota</option><option value="admin">Admin</option></select></div>
        <p class="hint" style="grid-column:1/-1">Kamu akan mendapat link undangan sekali pakai (berlaku 3 hari). Kirim lewat jalur pribadi; di sana dia membuat password dan memasang 2FA.</p>
        <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit">Buat undangan</button></div></form></section>`;
}

function drawAudit() {
  const people = isAdmin() && members.length ? `<div class="field"><label for="akFa">Orang</label><select id="akFa" data-filter="actor"><option value="">Semua</option>${members.map(m => `<option value="${esc(m.id)}"${filter.actor === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}<option value="_lain"${filter.actor === '_lain' ? ' selected' : ''}>Lainnya (agen, sistem, lokal)</option></select></div>` : '';
  const list = rows.length ? rows.map(r => {
    const by = r.origin && r.origin !== r.actor ? ` <span class="hint">atas perintah ${esc(r.origin)}</span>` : '';
    return `<tr><td style="white-space:nowrap">${esc(when(r.at))}</td><td><b>${esc(r.actor)}</b>${by}</td><td><span class="chip">${esc(KIND[r.kind] || r.kind)}</span></td>
      <td>${esc(short(r.text, 220))}${r.meta?.status >= 400 ? ' <span class="st wait">gagal</span>' : ''}</td><td>${esc(officeName(r.office))}</td><td class="hint">${esc(r.ip || '')}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-line">Belum ada catatan yang cocok.</td></tr>';
  return `<section class="card"><h2>Riwayat</h2>
      <p class="hint">${isAdmin() ? 'Semua aksi orang dan agen di kantor ini: siapa mengetik prompt, membuka terminal, menyetujui izin, mengubah kartu, dan seterusnya.' : 'Aksimu sendiri di kantor ini. Admin bisa melihat riwayat semua anggota.'} Catatan tidak bisa diubah atau dihapus dari kantor.</p>
      <form id="akFilter" class="grid2" style="margin-top:12px">
        ${people}
        <div class="field"><label for="akFk">Jenis</label><select id="akFk" data-filter="kind"><option value="">Semua</option>${Object.entries(KIND).map(([v, l]) => `<option value="${v}"${filter.kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="akFo">Kantor</label><select id="akFo" data-filter="office"><option value="">Semua</option>${(ctx.st?.offices || []).map(o => `<option value="${esc(o.id)}"${filter.office === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="akFq">Cari</label><input id="akFq" type="search" value="${esc(filter.q)}" placeholder="kata di catatan"></div>
        <div class="btn-row" style="grid-column:1/-1"><button class="btn" type="submit">Terapkan</button><a class="btn" href="/api/audit.csv?${esc(qs({}))}" download>Unduh CSV</a>${isAdmin() ? '<button class="btn" type="button" data-act="ak-verify">Periksa keutuhan</button>' : ''}</div></form>
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Waktu</th><th>Siapa</th><th>Jenis</th><th>Apa</th><th>Kantor</th><th>IP</th></tr></thead><tbody>${list}</tbody></table></div>
      ${more ? '<div class="btn-row" style="margin-top:10px"><button class="btn" data-act="ak-more">Muat lebih lama</button></div>' : ''}</section>`;
}

function inviteModal(r) {
  modal({
    title: `Undangan untuk ${r.member.name}`,
    body: `Berlaku sampai ${esc(new Date(r.until).toLocaleString('id-ID'))} dan hanya bisa dipakai sekali.`,
    html: `<pre id="akLink" style="white-space:pre-wrap;word-break:break-all">${esc(r.link)}</pre>`,
    actions: [{ label: 'Salin link', kind: 'primary', fn: () => { navigator.clipboard.writeText(r.link).then(() => toast('Link tersalin', 'ok'), () => toast('Gagal menyalin, blok teksnya lalu salin manual', 'warn')); return false; } }, { label: 'Selesai' }],
  });
}

async function onClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act, m = members.find(x => x.id === t.dataset.id);
  try {
    if (act === 'ak-tab') { tab = t.dataset.tab; history.replaceState(null, '', `#/akun/${tab}`); await load(); }
    else if (act === 'ak-more') { await loadRows(true); draw(); }
    else if (act === 'ak-logout') { await fetch('/keluar', { method: 'POST', credentials: 'same-origin' }); location.href = '/masuk'; }
    else if (act === 'ak-verify') { const v = await api('/api/audit/verify'); v.ok ? toast(`Rantai audit utuh (${v.count} catatan)`, 'ok') : modal({ title: 'Rantai audit rusak', body: `Catatan #${v.brokenAt}: ${esc(v.why)}. ${v.count} catatan sebelumnya utuh. Seseorang mengubah file audit.db di luar kantor.` }); }
    else if (act === 'ak-reset' && m) confirmDo(m.active ? `Reset ${m.name}?` : `Undangan baru untuk ${m.name}?`, m.active ? 'Password dan 2FA-nya dihapus, semua perangkatnya dikeluarkan, lalu kamu mendapat link undangan baru.' : 'Link undangan lama tidak berlaku lagi.', m.active ? 'Reset' : 'Buat undangan', async () => {
      try { inviteModal(await post(`/api/akun/anggota/${m.id}/reset`)); await load(); } catch (err) { toast(err.message, 'bad'); }
    });
    else if (act === 'ak-toggle' && m) {
      const run = async () => { try { await patch(`/api/akun/anggota/${m.id}`, { disabled: !m.disabled }); toast(m.disabled ? `${m.name} aktif lagi` : `${m.name} dinonaktifkan`, 'ok'); await load(); } catch (err) { toast(err.message, 'bad'); } };
      if (m.disabled) await run(); else confirmDo(`Nonaktifkan ${m.name}?`, 'Dia langsung keluar dari semua perangkat dan tidak bisa masuk sampai diaktifkan lagi. Riwayatnya tetap ada.', 'Nonaktifkan', run);
    }
  } catch (err) { toast(err.message, 'bad'); }
}

async function onChange(e) {
  const t = e.target;
  if (t.dataset.act === 'ak-role') {
    try { await patch(`/api/akun/anggota/${t.dataset.id}`, { role: t.value }); toast('Peran diubah', 'ok'); } catch (err) { toast(err.message, 'bad'); }
    await load();
  } else if (t.dataset.filter) { filter[t.dataset.filter] = t.value; await loadRows(false).catch(err => toast(err.message, 'bad')); draw(); }
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === 'akAdd') {
      const r = await post('/api/akun/anggota', { username: $('#akU', f).value.trim().toLowerCase(), name: $('#akN', f).value.trim(), role: $('#akR', f).value });
      inviteModal(r); await load();
    } else if (f.id === 'akPass') {
      if ($('#akNew', f).value !== $('#akNew2', f).value) return toast('Kedua password baru tidak sama', 'warn');
      await post('/api/akun/password', { current: $('#akCur', f).value, next: $('#akNew', f).value, code: $('#akCode', f).value });
      f.reset(); toast('Password diganti. Perangkat lain sudah dikeluarkan.', 'ok');
    } else if (f.id === 'akFilter') {
      filter.q = $('#akFq', f).value.trim();
      await loadRows(false); draw();
    }
  } catch (err) { toast(err.message, 'bad'); }
}
