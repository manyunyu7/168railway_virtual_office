// Mesin: Mac lain tempat agen kantor jalan (docs/MULTI-PC.md). Panel di Pengaturan, cache klien,
// dan pemilih mesin + penjelajah folder untuk dialog Tambah ruangan.
import { $, esc, ago, api, post, patch, del, toast, confirmDo } from './util.js';

/* ---------------- logika murni (dites di test/ui-mesin.test.js) ---------------- */
export const canManage = st => !st?.akun || st?.me?.role === 'admin';

/** { k: 'online'|'offline'|'unknown'|'disabled', label, cls } untuk titik dan pil status. */
export function statusOf(m) {
  if (!m) return { k: 'unknown', label: 'Belum dicek', cls: 'unk' };
  if (m.disabled) return { k: 'disabled', label: 'Nonaktif', cls: 'dis' };
  if (m.online === true) return { k: 'online', label: 'Online', cls: 'on' };
  if (m.online === false) return { k: 'offline', label: 'Offline', cls: 'off' };
  return { k: 'unknown', label: 'Belum dicek', cls: 'unk' };
}
export const latencyText = ms => (ms == null || !Number.isFinite(Number(ms)) ? '' : Number(ms) < 1 ? '<1 ms' : `${Math.round(Number(ms))} ms`);

/** Baris keterangan di bawah nama mesin. */
export function metaLine(m, installed = null) {
  const out = [];
  const lat = latencyText(m.latencyMs);
  if (lat && m.online) out.push(`latensi ${lat}`);
  if (m.lastSeen) out.push(`terakhir terlihat ${ago(m.lastSeen)}`);
  else if (m.online == null && !m.disabled) out.push('belum pernah terhubung');
  const inst = installText(installed || m.installed);
  if (inst) out.push(inst);
  return out.join(' · ');
}
export function installText(i) {
  if (!i) return '';
  if (!i.version) return 'skrip belum dipasang';
  const v = String(i.version).slice(0, 7);
  return i.current ? `skrip ${v} terpasang (terbaru)` : `skrip ${v} terpasang (perlu diperbarui)`;
}
/** Label tombol pasang menurut status pemasangan yang diketahui. */
export function installLabel(i) {
  if (!i || !i.version) return 'Pasang skrip';
  return i.current ? 'Pasang ulang' : 'Perbarui skrip';
}

/** Validasi form tambah/ubah; sama dengan validate() di server/machines.js. null = oke. */
export function validateMachineForm({ name, ssh, hubUrl } = {}) {
  if (!String(name ?? '').trim()) return 'Nama mesin wajib diisi';
  const v = String(ssh ?? '').trim();
  if (!v) return 'Alamat SSH wajib diisi, mis. henry@mac-studio.tail1234.ts.net';
  if (v !== 'local:' && (!/^[A-Za-z0-9._@:\[\]-]+$/.test(v) || v.startsWith('-'))) return 'Alamat SSH tidak valid. Tulis user@host, tanpa spasi.';
  const h = String(hubUrl ?? '').trim();
  if (!h) return 'URL hub wajib diisi, mis. http://macbook-air.tail1234.ts.net:4317';
  let u; try { u = new URL(h); } catch { return 'URL hub tidak valid, mis. http://macbook-air.tail1234.ts.net:4317'; }
  if (!/^https?:$/.test(u.protocol)) return 'URL hub harus http atau https';
  if (v !== 'local:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname)) return 'URL hub tidak boleh localhost: Mac lain tidak bisa menjangkaunya. Pakai nama Tailscale atau IP Tailscale Mac ini.';
  return null;
}

/** Isi bawaan URL hub: origin halaman ini, kecuali loopback (tak terjangkau dari Mac lain). */
export function defaultHubUrl(loc) {
  if (!loc?.origin || !loc.hostname) return '';
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(loc.hostname)) return '';
  return loc.origin;
}
export const hubPlaceholder = loc => `http://macbook-air.tail1234.ts.net:${loc?.port || '4317'}`;

/** Pilihan untuk "Di mesin". Offline dan nonaktif tidak bisa dipilih. */
export function machineOptions(list = []) {
  return [{ id: '', label: 'Mac ini', disabled: false, note: '' },
    ...list.map(m => {
      const s = statusOf(m);
      const disabled = s.k === 'offline' || s.k === 'disabled';
      const note = s.k === 'offline' ? 'offline' : s.k === 'disabled' ? 'nonaktif' : s.k === 'unknown' ? 'belum dicek' : '';
      return { id: m.id, label: m.name || m.id, disabled, note };
    })];
}
/** Remah folder untuk path absolut: [{ name, dir }], diawali '/'. */
export function crumbsOf(dir) {
  const parts = String(dir || '').split('/').filter(Boolean);
  return [{ name: '/', dir: '/' }, ...parts.map((p, i) => ({ name: p, dir: '/' + parts.slice(0, i + 1).join('/') }))];
}
export const baseName = dir => String(dir || '').replace(/\/+$/, '').split('/').pop() || '';

/* ---------------- cache klien ---------------- */
let cache = [];
let loaded = null;              // promise muat awal
const installedOf = new Map();  // id → { version, current } dari Tes/Pasang terakhir
const testOf = new Map();       // id → hasil POST /test terakhir
const busy = new Map();         // id → 'test' | 'install' | 'toggle' | 'remove'
const listeners = new Set();    // dipanggil setiap cache berubah

export const machines = () => cache;
export const machineName = id => (!id || id === 'local' ? 'Mac ini' : cache.find(m => m.id === id)?.name || id);
function changed() {
  for (const fn of listeners) { try { fn(cache); } catch {} }
  if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') document.dispatchEvent(new CustomEvent('kantor:machines'));
}
function upsert(m) {
  if (!m?.id) return;
  const i = cache.findIndex(x => x.id === m.id);
  cache = i >= 0 ? cache.map((x, k) => (k === i ? { ...x, ...m } : x)) : [...cache, m];
}

export function loadMachines(force = false) {
  if (loaded && !force) return loaded;
  loaded = api('/api/machines').then(r => { cache = r.machines || []; changed(); return cache; })
    .catch(e => { loaded = null; throw e; });
  return loaded;
}
/**
 * Dipanggil main.js untuk event WS { t: 'machine', machine, removed? }: onMachineEvent(msg.machine, msg).
 * Pesan WS utuh juga diterima. removed:true = mesin dihapus.
 */
export function onMachineEvent(machine, msg = null) {
  if (machine?.t === 'machine') { msg = machine; machine = machine.machine; }
  if (!machine?.id) return;
  if (msg?.removed || machine.removed) { cache = cache.filter(x => x.id !== machine.id); testOf.delete(machine.id); installedOf.delete(machine.id); }
  else upsert(machine);
  changed();
}

/* ---------------- panel Pengaturan → Mesin ---------------- */
let panel = null, form = null, loadErr = ''; // form = null | { id: null|idMesin } saat form terbuka

export function mountMesin(el, st) {
  if (!el) return;
  if (!canManage(st)) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  panel = el;
  el.onclick = onPanelClick;
  el.onsubmit = onPanelSubmit;
  el.innerHTML = `<h2>Mesin</h2>
    <p>Jalankan agen di Mac lain dari kantor ini. Mac ini (hub) mengendalikan Mac lain lewat SSH; board, wiki, pesan, dan kunci tetap di sini. Ruangan yang foldernya ada di Mac lain menjalankan shift-nya di sana.</p>
    <div class="mx-body"></div><div class="mx-formbox"></div>${guideHTML()}`;
  listeners.add(drawList);
  drawList(); drawForm();
  loadMachines(true).then(() => { loadErr = ''; drawList(); }).catch(e => { loadErr = e.message; drawList(); });
}

function alive() {
  if (panel && panel.isConnected) return true;
  listeners.delete(drawList); panel = null; return false;
}
function drawList() {
  if (!alive()) return;
  $('.mx-body', panel).innerHTML = loadErr && !cache.length ? `<p class="warn-t">${esc(loadErr)}</p>`
    : cache.length ? `<ul class="mx-list">${cache.map(itemHTML).join('')}</ul>`
    : '<p class="hint mx-empty">Belum ada mesin lain. Semua agen jalan di Mac ini.</p>';
}
function drawForm() {
  if (!alive()) return;
  $('.mx-formbox', panel).innerHTML = form ? formHTML(form.id ? cache.find(m => m.id === form.id) : null)
    : '<div class="btn-row"><button class="btn primary" type="button" data-act="mx-add">Tambah mesin</button></div>';
  if (form) $('#mxName', panel)?.focus();
}

function itemHTML(m) {
  const s = statusOf(m), b = busy.get(m.id), inst = installedOf.get(m.id) || m.installed || null, t = testOf.get(m.id);
  const dis = b ? ' disabled' : '';
  return `<li class="mx-item${m.disabled ? ' is-off' : ''}" data-id="${esc(m.id)}">
    <div class="mx-head"><span class="mx-dot ${s.cls}" aria-hidden="true"></span><b class="mx-name">${esc(m.name || m.id)}</b><span class="mx-pill ${s.cls}">${esc(s.label)}</span></div>
    <p class="mx-addr"><code>${esc(m.ssh)}</code> <span class="hint">hub: <code>${esc(m.hubUrl)}</code>${m.root ? ` · folder skrip: <code>${esc(m.root)}</code>` : ''}</span></p>
    ${metaLine(m, inst) ? `<p class="hint">${esc(metaLine(m, inst))}</p>` : ''}
    ${m.lastError && m.online !== true ? `<p class="mx-err">${esc(m.lastError)}</p>` : ''}
    ${b === 'test' ? '<p class="hint">Mengetes koneksi…</p>' : b === 'install' ? '<p class="hint">Memasang skrip…</p>' : t ? testHTML(t) : ''}
    <div class="btn-row mx-acts">
      <button class="btn sm" type="button" data-act="mx-test"${dis}>Tes</button>
      <button class="btn sm" type="button" data-act="mx-install"${b || m.disabled ? ' disabled' : ''}>${esc(installLabel(inst))}</button>
      <button class="btn sm" type="button" data-act="mx-edit"${dis}>Ubah</button>
      <button class="btn sm ghost" type="button" data-act="mx-toggle"${dis}>${m.disabled ? 'Aktifkan' : 'Nonaktifkan'}</button>
      <button class="btn sm danger" type="button" data-act="mx-remove"${dis}>Hapus</button>
    </div></li>`;
}

const BINS = ['tmux', 'node', 'claude', 'codex', 'git'];
function testHTML(t) {
  const bins = t.bins || {};
  const problems = Array.isArray(t.problems) ? t.problems : [];
  const ok = t.ok && !problems.length, connected = !!t.bins;
  return `<div class="mx-test ${ok ? 'ok' : 'bad'}">
    <p><b>${ok ? 'Siap dipakai' : connected ? 'Tersambung, ada yang perlu dibereskan' : 'Tes gagal'}</b>${t.latencyMs != null ? ` <span class="hint">· ${esc(latencyText(t.latencyMs))}</span>` : ''}${t.os ? ` <span class="hint">· ${esc(t.os)}</span>` : ''}${t.node ? ` <span class="hint">· node ${esc(t.node)}</span>` : ''}</p>
    ${connected ? `<div class="mx-bins">${BINS.map(k => `<span class="mx-bin ${bins[k] ? 'ok' : 'no'}" title="${esc(bins[k] || 'tidak ditemukan')}">${k}</span>`).join('')}
      ${t.hubReachable == null ? '' : `<span class="mx-bin ${t.hubReachable ? 'ok' : 'no'}">${t.hubReachable ? 'hub terjangkau' : 'hub tak terjangkau'}</span>`}</div>` : ''}
    ${t.home ? `<p class="hint">Home: <code>${esc(t.home)}</code></p>` : ''}
    ${problems.length ? `<ul class="mx-problems">${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function formHTML(m) {
  const loc = typeof location !== 'undefined' ? location : null;
  const hub = m ? m.hubUrl : (form.hubUrl ?? defaultHubUrl(loc));
  return `<form class="mx-form" id="mxForm" novalidate>
    <h3>${m ? `Ubah ${esc(m.name)}` : 'Tambah mesin'}</h3>
    <div class="grid2">
      <div class="field"><label for="mxName">Nama</label><input id="mxName" autocomplete="off" placeholder="mis. Mac Studio" value="${esc(m?.name || '')}"></div>
      <div class="field"><label for="mxSsh">Alamat SSH</label><input id="mxSsh" autocomplete="off" spellcheck="false" placeholder="henry@mac-studio.tail1234.ts.net" value="${esc(m?.ssh || '')}"></div>
      <div class="field" style="grid-column:1/-1"><label for="mxHub">URL hub</label><input id="mxHub" autocomplete="off" spellcheck="false" placeholder="${esc(hubPlaceholder(loc))}" value="${esc(hub || '')}">
        <p class="hint">Alamat yang dipakai Mac itu untuk menghubungi kantor ini, biasanya nama Tailscale Mac ini plus port daemon. Jangan pakai localhost. Host ini juga perlu ada di <code>extraHosts</code>.</p></div>
      <div class="field" style="grid-column:1/-1"><label for="mxRoot">Folder skrip di Mac itu (opsional)</label><input id="mxRoot" autocomplete="off" spellcheck="false" placeholder="~/.kantor-node" value="${esc(m?.root || '')}"></div>
    </div>
    <p class="mx-ferr warn-t" id="mxErr" hidden></p>
    <div class="btn-row" style="margin-top:10px"><button class="btn primary" type="submit">${m ? 'Simpan' : 'Tambah'}</button><button class="btn" type="button" data-act="mx-cancel">Batal</button>
      ${m ? '<button class="btn ghost" type="button" data-act="mx-rotate">Ganti token mesin</button>' : ''}</div>
  </form>`;
}

function guideHTML() {
  return `<details class="mx-guide"><summary>Cara menyiapkan Mac kedua</summary><ol>
    <li>Pasang Tailscale di kedua Mac, login ke tailnet yang sama.</li>
    <li>Di Mac kedua: Pengaturan Sistem → Umum → Berbagi → <b>Remote Login</b> nyala. Pasang <code>tmux</code>, <code>node</code> (22 atau lebih baru), dan <code>claude</code> yang sudah login. Tambahkan public key Mac ini ke <code>~/.ssh/authorized_keys</code> di sana.</li>
    <li>Di Mac ini, jalankan <code>ssh user@mac2.ts.net true</code> sekali untuk menerima host key.</li>
    <li>Isi <code>extraHosts</code> di <code>~/.kantor-claude/config.json</code> dengan IP Tailscale Mac ini, lalu mulai ulang daemon.</li>
    <li>Di sini: Tambah mesin, lalu Tes, lalu Pasang skrip.</li>
    <li>Tambah ruangan, pilih mesinnya, pilih folder repo di Mac itu. Role di ruangan itu akan shift di sana.</li>
  </ol></details>`;
}

const mid = t => t.closest('.mx-item')?.dataset.id;
async function onPanelClick(e) {
  const t = e.target.closest('[data-act^="mx-"]'); if (!t || !panel) return;
  const act = t.dataset.act, id = mid(t), m = id && cache.find(x => x.id === id);
  if (act === 'mx-add') { form = { id: null }; drawForm(); }
  else if (act === 'mx-edit' && m) { form = { id }; drawForm(); }
  else if (act === 'mx-cancel') { form = null; drawForm(); }
  else if (act === 'mx-test' && m) runTest(m);
  else if (act === 'mx-install' && m) runInstall(m);
  else if (act === 'mx-toggle' && m) {
    if (!m.disabled) confirmDo(`Nonaktifkan ${m.name}?`, 'Shift baru tidak bisa dimulai di mesin ini dan token mesinnya ditolak. Sesi yang sedang jalan di sana tidak diakhiri.', 'Nonaktifkan', () => setDisabled(m, true), 'primary');
    else setDisabled(m, false);
  } else if (act === 'mx-remove' && m) {
    confirmDo(`Hapus ${m.name}?`, 'Mesin dihapus dari kantor ini. Skrip di Mac itu tidak disentuh. Penghapusan ditolak kalau masih ada sesi hidup atau ruangan di mesin ini.', 'Hapus', () => remove(m));
  } else if (act === 'mx-rotate' && form?.id) {
    const fm = cache.find(x => x.id === form.id); if (!fm) return;
    confirmDo('Ganti token mesin?', 'Token lama langsung ditolak. Shift yang sedang jalan di mesin itu kehilangan akses hook dan MCP sampai dimulai ulang.', 'Ganti token', async () => {
      try { upsert((await patch(`/api/machines/${encodeURIComponent(fm.id)}`, { rotateToken: true })).machine); toast('Token mesin diganti', 'ok'); changed(); } catch (err) { toast(err.message, 'bad'); }
    });
  }
}

async function onPanelSubmit(e) {
  if (e.target.id !== 'mxForm') return;
  e.preventDefault();
  const v = { name: $('#mxName', panel).value.trim(), ssh: $('#mxSsh', panel).value.trim(), hubUrl: $('#mxHub', panel).value.trim().replace(/\/+$/, ''), root: $('#mxRoot', panel).value.trim() || null };
  const err = validateMachineForm(v), box = $('#mxErr', panel);
  if (err) { box.textContent = err; box.hidden = false; return; }
  box.hidden = true;
  const editing = form?.id;
  try {
    const r = editing ? await patch(`/api/machines/${encodeURIComponent(editing)}`, v) : await post('/api/machines', v);
    upsert(r.machine); form = null; changed(); drawForm();
    toast(editing ? 'Mesin disimpan' : 'Mesin ditambah. Tes dulu koneksinya.', 'ok');
    if (!editing && r.machine) runTest(r.machine);
  } catch (ex) { box.textContent = ex.message; box.hidden = false; }
}

async function runTest(m) {
  busy.set(m.id, 'test'); changed();
  try {
    const r = await post(`/api/machines/${encodeURIComponent(m.id)}/test`, {});
    testOf.set(m.id, r);
    if (r.installed) installedOf.set(m.id, r.installed);
    if (r.ok) upsert({ id: m.id, online: true, latencyMs: r.latencyMs ?? m.latencyMs, lastError: null, lastSeen: new Date().toISOString() });
  } catch (e) { testOf.set(m.id, { ok: false, problems: [e.message] }); }
  busy.delete(m.id); changed();
}
async function runInstall(m) {
  busy.set(m.id, 'install'); changed();
  try {
    const r = await post(`/api/machines/${encodeURIComponent(m.id)}/install`, {});
    installedOf.set(m.id, { version: r.version, current: true });
    toast(`Skrip terpasang di ${r.root || m.name}`, 'ok');
    busy.delete(m.id);
    return runTest(m);
  } catch (e) { toast(e.message, 'bad'); }
  busy.delete(m.id); changed();
}
async function setDisabled(m, v) {
  busy.set(m.id, 'toggle'); changed();
  try { upsert((await patch(`/api/machines/${encodeURIComponent(m.id)}`, { disabled: v })).machine); toast(v ? 'Mesin dinonaktifkan' : 'Mesin diaktifkan', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  busy.delete(m.id); changed();
}
async function remove(m) {
  busy.set(m.id, 'remove'); changed();
  try {
    await del(`/api/machines/${encodeURIComponent(m.id)}`);
    cache = cache.filter(x => x.id !== m.id); testOf.delete(m.id); installedOf.delete(m.id);
    if (form?.id === m.id) { form = null; drawForm(); }
    toast('Mesin dihapus', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  busy.delete(m.id); changed();
}

/* ---------------- dialog Tambah ruangan: "Di mesin" + penjelajah folder remote ---------------- */
/**
 * Pasang pemilih mesin di `el` (kosong bila tidak ada mesin lain).
 * onChange(null) = Mac ini; onChange({ machine, name, remotePath }) = mesin lain (remotePath null selama memuat).
 */
export function mountRoomMachine(el, { onChange = () => {} } = {}) {
  if (!el) return null;
  const s = { sel: '', dir: null, data: null, seq: 0, note: '', err: '' };
  const lastDir = new Map();
  const emit = () => onChange(s.sel ? { machine: s.sel, name: machineName(s.sel), remotePath: s.data?.dir || null } : null);

  const draw = () => {
    if (!el.isConnected) { listeners.delete(onCache); return; }
    const opts = machineOptions(cache);
    if (opts.length < 2) { el.innerHTML = ''; return; }
    const off = opts.filter(o => o.disabled);
    el.innerHTML = `<div class="field mx-room"><label for="rrMachine">Di mesin</label>
      <select id="rrMachine">${opts.map(o => `<option value="${esc(o.id)}"${o.disabled ? ' disabled' : ''}${o.id === s.sel ? ' selected' : ''}>${esc(o.label)}${o.note ? ` (${esc(o.note)})` : ''}</option>`).join('')}</select>
      ${off.length ? `<p class="hint">${off.map(o => esc(o.label)).join(', ')} tidak bisa dipilih karena ${off.every(o => o.note === 'nonaktif') ? 'nonaktif' : off.every(o => o.note === 'offline') ? 'sedang offline' : 'offline atau nonaktif'}. Cek di Pengaturan → Mesin.</p>` : ''}
      ${s.note ? `<p class="warn-t">${esc(s.note)}</p>` : ''}</div>
      ${s.sel ? browserHTML() : ''}`;
  };
  const browserHTML = () => {
    const d = s.data;
    const crumbs = d ? crumbsOf(d.dir).map((c, i) => `${i > 1 ? '<span>/</span>' : ''}<button type="button" data-mf="go" data-dir="${esc(c.dir)}">${esc(c.name)}</button>`).join('') : '';
    const rows = s.err ? `<li class="fb-empty warn-t">${esc(s.err)}</li>`
      : !d ? '<li class="fb-empty">Memuat folder…</li>'
      : (d.parent ? `<li><button type="button" class="fb-row up" data-mf="go" data-dir="${esc(d.parent)}"><span class="fb-ic">↑</span><span class="fb-nm">..</span></button></li>` : '')
        + (d.entries?.length ? d.entries.map(e => `<li><button type="button" class="fb-row" data-mf="go" data-dir="${esc(e.path)}" title="Pilih folder ini"><span class="fb-ic">${e.git ? '◆' : '▸'}</span><span class="fb-nm">${esc(e.name)}</span><span class="fb-bs">${e.git ? '<i class="fb-b git">git</i>' : ''}</span><span class="fb-go">›</span></button></li>`).join('')
          : '<li class="fb-empty">Tidak ada subfolder.</li>');
    return `<div class="field"><label>Folder di ${esc(machineName(s.sel))}</label>
      <div class="fb"><div class="fb-crumbs">${crumbs || '&nbsp;'}</div><ul class="fb-list">${rows}</ul></div>
      <p class="hint">${d ? `Folder terpilih: <code>${esc(d.dir)}/</code>${d.git ? ' · repo git' : ''}` : 'Pilih folder repo di mesin itu.'}</p></div>`;
  };
  const browse = async dir => {
    const seq = ++s.seq, id = s.sel;
    s.err = ''; s.data = null; draw(); emit();
    try {
      const r = await api(`/api/machines/${encodeURIComponent(id)}/browse?dir=${encodeURIComponent(dir || '')}`);
      if (seq !== s.seq || id !== s.sel) return;
      s.data = r; lastDir.set(id, r.dir);
    } catch (e) { if (seq !== s.seq) return; s.err = e.message; }
    draw(); emit();
  };
  const select = id => {
    s.sel = id; s.note = ''; s.data = null; s.err = '';
    if (id) browse(lastDir.get(id) || ''); else { draw(); emit(); }
  };
  const onCache = () => {
    if (!el.isConnected || el.closest('[hidden]')) { listeners.delete(onCache); return; }
    if (s.sel) {
      const o = machineOptions(cache).find(x => x.id === s.sel);
      if (!o || o.disabled) { const name = o?.label || s.sel; select(''); s.note = `${name} ${o ? (o.note === 'nonaktif' ? 'dinonaktifkan' : 'baru saja offline') : 'dihapus'}; pilihan kembali ke Mac ini.`; }
    }
    draw();
  };
  el.addEventListener('change', e => { if (e.target.id === 'rrMachine') select(e.target.value); });
  el.addEventListener('click', e => { const b = e.target.closest('[data-mf="go"]'); if (b && s.sel) browse(b.dataset.dir); });
  listeners.add(onCache);
  draw();
  loadMachines(true).then(draw).catch(() => { el.innerHTML = ''; });
  return { value: () => (s.sel ? { machine: s.sel, remotePath: s.data?.dir || null } : null) };
}
