import { $, esc, api, post, toast, confirmDo, getTheme } from './util.js';
import { refreshState } from './main.js';

// where this repo lives on the machine running the daemon (filled in from /api/state)
let REPO = 'kantor-claude';
const KC = `kc() { local name="kcm-$(basename "$PWD" | tr -c 'A-Za-z0-9_-' '-')-$(date +%H%M%S)"; tmux new-session -s "$name" -c "$PWD" "claude $*"; }`;
let root = null, st = null;

export async function render(el, ctx) {
  REPO = ctx?.st?.repoDir || REPO;
  root = el;
  st = ctx.st;
  el.onclick = onClick;
  try { st = await refreshState(); } catch (e) { st = st || null; if (!st) { el.innerHTML = `<div class="wrap"><div class="notice">${esc(e.message)}</div></div>`; return; } }
  draw();
}
export function unmount() { if (root) root.onclick = null; root = null; }

const flag = (ok, yes, no) => `<span class="st ${ok ? 'working' : 'wait'}">${ok ? yes : no}</span>`;
const cmd = (text, id) => `<div style="position:relative"><pre id="${id}">${esc(text)}</pre><button class="btn sm" data-act="st-copy" data-src="${id}" style="position:absolute;top:6px;right:6px">Salin</button></div>`;

function draw() {
  if (!root) return;
  const a = st.settings?.approvals || {};
  const hosts = st.settings?.extraHosts || [];
  root.innerHTML = `<div class="wrap"><div class="settings">
    <div><p class="eyebrow">Kantor Claude</p><h1>Pengaturan</h1></div>
    <section class="card"><h2>Status</h2><dl class="facts" style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;align-items:center">
      <dt>Daemon</dt><dd>${flag(true, 'Tersambung', '')}</dd>
      <dt>tmux</dt><dd>${flag(st.tmux, 'Tersedia', 'Tidak ditemukan')}${st.tmux ? '' : ' <span class="hint">Tanpa tmux, shift dari kantor dan terminal tidak bisa dipakai.</span>'}</dd>
      <dt>Claude CLI</dt><dd>${flag(st.claude, 'Ditemukan', 'Tidak ditemukan')}${st.claude ? '' : ' <span class="hint">Rapat dan shift butuh perintah <code>claude</code> di PATH.</span>'}</dd>
      <dt>Hooks global</dt><dd>${flag(st.hooks, 'Terpasang', 'Belum dipasang')}</dd></dl></section>

    <section class="card"><h2>Tampilan</h2>
      <p>Pilih tema warna. "Sistem" mengikuti mode terang atau gelap di perangkatmu. Pilihan ini disimpan di browser ini saja.</p>
      <div class="theme-seg" role="group" aria-label="Tema warna" style="margin-top:12px">${[['light', '☀', 'Terang'], ['dark', '☾', 'Gelap'], ['system', '◐', 'Sistem']].map(([k, ic, l]) => `<button type="button" class="theme-opt" data-theme-set="${k}" aria-pressed="${getTheme() === k}"><span aria-hidden="true">${ic}</span>${l}</button>`).join('')}</div></section>

    <section class="card"><h2>Hooks global</h2>
      <p>Tanpa hooks, hanya shift yang dimulai dari kantor yang terlihat. Dengan hooks, setiap sesi Claude Code di Mac ini muncul di kantor project-nya, termasuk yang kamu jalankan sendiri di iTerm.</p>
      <p class="hint" style="margin:6px 0 10px">Hooks aman: kalau daemon mati, hook langsung selesai tanpa menghambat Claude. Hook milik kamu yang lain (mis. pixel-agents) tetap dipertahankan. Cadangan <code>~/.claude/settings.json</code> dibuat otomatis tiap kali dipasang atau dilepas.</p>
      <div class="btn-row">${st.hooks ? '<button class="btn danger" data-act="st-hooks" data-mode="uninstall">Lepas hooks</button>' : '<button class="btn primary" data-act="st-hooks" data-mode="install">Pasang hooks</button>'}</div></section>

    <section class="card"><h2>Persetujuan izin</h2>
      <p>Saat Claude minta izin (mis. menjalankan perintah), kantor menahan permintaan itu supaya bisa kamu jawab dari Kotak masuk. Selama ditahan, prompt izin juga tetap muncul di terminalnya. Mana yang dijawab duluan, itu yang berlaku.</p>
      <form id="stApprovals" class="grid2" style="margin-top:12px">
        <div class="field"><label for="stHoldK">Tahan untuk shift kantor (detik)</label><input id="stHoldK" type="number" min="0" step="1" value="${Number(a.holdKantorSec ?? 0)}"></div>
        <div class="field"><label for="stHoldM">Tahan untuk sesi manual (detik)</label><input id="stHoldM" type="number" min="0" step="1" value="${Number(a.holdManualSec ?? 0)}"></div>
        <p class="hint" style="grid-column:1/-1">0 berarti tidak ditahan: permintaan hanya dicatat, terminal langsung bertanya seperti biasa.</p>
        <div class="field" style="grid-column:1/-1"><label for="stPerm">Mode izin bawaan untuk shift kantor</label><select id="stPerm">${[['', 'Ikuti pengaturan Claude'], ['default', 'Selalu tanya'], ['acceptEdits', 'Edit file otomatis (acceptEdits)'], ['auto', 'Auto mode'], ['plan', 'Hanya merencanakan (plan)'], ['bypassPermissions', 'Lewati semua izin (--dangerously-skip-permissions)']].map(([v, l]) => `<option value="${v}"${(st.settings?.defaultPermissionMode || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <p class="hint">Dipakai saat shift dimulai tanpa memilih mode, termasuk shift yang dimulai manager atau dari kotak "Suruh". Mode "lewati semua izin" sama dengan cara kamu menjalankan Claude di Terminal: tidak ada yang ditanyakan, termasuk perintah ke prod.</p></div>
        <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit" data-act="st-save">Simpan</button></div></form></section>

    <section class="card"><h2>Musik</h2>
      <p>Pemutar musik kantor punya stasiun yang dibuat langsung di browser, plus "Folder musikmu" yang memutar file audio (mp3, m4a, wav, ogg, flac) dari folder di Mac ini.</p>
      <form id="stMusic" class="grid2" style="margin-top:12px">
        <div class="field" style="grid-column:1/-1"><label for="stMusicDir">Folder musik</label><input id="stMusicDir" type="text" spellcheck="false" value="${esc(st.settings?.musicDir || '')}" placeholder="/Users/kamu/Music"></div>
        <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit">Simpan</button></div></form></section>

    <section class="card" id="stPv"><h2>Penyimpanan pratinjau</h2><p class="hint">Memuat…</p></section>

    <section class="card"><h2>Akses dari HP</h2>
      <p>Daemon hanya menerima alamat lokal secara bawaan. Untuk membuka dari HP lewat Tailscale, tambahkan IP Tailscale Mac ini ke <code>extraHosts</code> di <code>~/.kantor-claude/config.json</code>, lalu mulai ulang daemon.</p>
      ${cmd('{ "extraHosts": ["100.x.y.z:4317"] }', 'stHost')}
      <p class="hint">Buka alamat itu dengan URL bertoken (yang dicetak oleh <code>node bin/kantor.js open</code>). Tanpa token, akses ditolak.</p>
      <p class="hint">Saat ini: ${hosts.length ? hosts.map(h => `<code>${esc(h)}</code>`).join(', ') : 'belum ada host tambahan'}.</p></section>

    <section class="card"><h2>Perintah berguna</h2><div style="display:grid;gap:14px">
      <div><p>Buka kantor di browser dengan URL bertoken.</p>${cmd(`cd ${REPO} && node bin/kantor.js open`, 'stC1')}</div>
      <div><p>Jalankan daemon otomatis saat login.</p>${cmd(`cd ${REPO} && node bin/kantor.js service install`, 'stC2')}</div>
      <div><p>Pasang tool MCP kantor untuk semua sesi Claude.</p>${cmd(`cd ${REPO} && node bin/kantor.js mcp install`, 'stC3')}</div>
      <div><p>Fungsi <code>kc</code> untuk <code>~/.zshrc</code>. Menjalankan <code>claude</code> lewat <code>kc</code> memasukkannya ke tmux, sehingga kantor bisa menempelkan terminal ke sesi itu.</p>${cmd(KC, 'stC4')}</div></div></section>
  </div></div>`;
  drawPv();
}

const mb = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
async function drawPv() {
  const el = root && $('#stPv', root); if (!el) return;
  let s; try { s = await api('/api/pratinjau/storage'); } catch (e) { el.innerHTML = `<h2>Penyimpanan pratinjau</h2><p class="hint">${esc(e.message)}</p>`; return; }
  const total = s.offices.reduce((a, o) => a + o.bytes, 0);
  el.innerHTML = `<h2>Penyimpanan pratinjau</h2>
    <p>Berkas pratinjau yang sudah selesai (disetujui/dipilih/diarsip, atau info yang sudah dilihat) dibersihkan otomatis setelah beberapa hari; gambar kecilnya tetap ada. Yang 📌 disimpan, baru, revisi, ditunda, atau sudah jadi wiki tidak disentuh.</p>
    <ul class="hint" style="margin:10px 0">${s.offices.filter(o => o.items).map(o => `<li>${esc(o.name || o.id)}: <b>${mb(o.bytes)}</b> · ${o.items} pratinjau · ${o.files} berkas</li>`).join('') || '<li>Belum ada pratinjau.</li>'}</ul>
    <p class="hint">Total: <b>${mb(total)}</b></p>
    <form id="stPvForm" class="grid2" style="margin-top:12px">
      <div class="field"><label for="stPvDays">Bersihkan setelah (hari, 0 = mati)</label><input id="stPvDays" type="number" min="0" max="3650" value="${s.cleanupDays}"></div>
      <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit">Simpan</button><button class="btn" type="button" data-act="st-pvclean">Bersihkan sekarang</button></div></form>`;
}
async function pvClean() {
  try {
    const r = await post('/api/pratinjau/cleanup', { dryRun: true });
    if (r.off) { toast('Pembersihan otomatis mati (0 hari). Isi jumlah hari dulu.', 'warn'); return; }
    if (!r.items.length) { toast(`Tidak ada pratinjau selesai yang lebih tua dari ${r.days} hari.`, 'ok'); return; }
    confirmDo(`Bersihkan ${r.items.length} pratinjau?`, `Menghemat ${mb(r.bytes)}. Berkas aslinya dihapus; item dan gambar kecilnya tetap ada.`, 'Bersihkan', async () => {
      try { const d = await post('/api/pratinjau/cleanup', {}); toast(`${d.items.length} pratinjau dibersihkan (${mb(d.bytes)}).`, 'ok'); drawPv(); } catch (err) { toast(err.message, 'bad'); }
    });
  } catch (err) { toast(err.message, 'bad'); }
}

async function onClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'st-pvclean') return pvClean();
  if (act === 'st-copy') {
    const text = $('#' + t.dataset.src, root).textContent;
    try { await navigator.clipboard.writeText(text); toast('Tersalin', 'ok'); } catch { toast('Gagal menyalin, blok teksnya lalu salin manual', 'warn'); }
  } else if (act === 'st-hooks') {
    const install = t.dataset.mode === 'install';
    confirmDo(install ? 'Pasang hooks global?' : 'Lepas hooks global?',
      install ? 'Berkas ~/.claude/settings.json akan diubah. Cadangannya dibuat otomatis dan hook milikmu yang lain tetap ada.' : 'Hook Kantor Claude dihapus dari ~/.claude/settings.json (cadangan dibuat otomatis). Hook milikmu yang lain tetap ada. Sesi manual tidak akan terlihat lagi di kantor.',
      install ? 'Pasang' : 'Lepas',
      async () => {
        try { await post(`/api/hooks/${install ? 'install' : 'uninstall'}`); st = await refreshState(); toast(install ? 'Hooks terpasang' : 'Hooks dilepas', 'ok'); draw(); } catch (err) { toast(err.message, 'bad'); }
      }, install ? 'primary' : 'danger');
  }
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'stApprovals' || !root) return;
  e.preventDefault();
  const k = Number($('#stHoldK').value), m = Number($('#stHoldM').value);
  if (!(k >= 0) || !(m >= 0)) { toast('Isi detik dengan angka 0 atau lebih', 'warn'); return; }
  try {
    await post('/api/settings', { approvals: { holdKantorSec: Math.round(k), holdManualSec: Math.round(m) }, defaultPermissionMode: $('#stPerm').value });
    st = await refreshState(); toast('Pengaturan disimpan', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'stMusic' || !root) return;
  e.preventDefault();
  try {
    await post('/api/settings', { musicDir: $('#stMusicDir').value });
    st = await refreshState(); toast('Folder musik disimpan', 'ok');
    window.dispatchEvent(new CustomEvent('kantor-music-dir'));
  } catch (err) { toast(err.message, 'bad'); }
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'stPvForm' || !root) return;
  e.preventDefault();
  try { await api('/api/pratinjau/storage', { method: 'PUT', body: { cleanupDays: Number($('#stPvDays').value) } }); toast('Disimpan', 'ok'); drawPv(); } catch (err) { toast(err.message, 'bad'); }
});
