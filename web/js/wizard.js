// Halaman "Kantor baru": wizard 4 langkah dengan preview denah yang ikut berubah.
import { $, $$, esc, short, api, post, toast, sprite, isFem, ago, SWATCHES } from './util.js';
import { createStage } from './office-canvas.js';
import { PERMS } from './roles.js';
import { randomLook, applyLook } from './chars.js';
import { loadTemplates, galleryHTML } from './template-gallery.js';

const STEPS = ['Project', 'Ruangan', 'Tim', 'Suasana', 'Mulai'];
const MANAGERS = ['Bu Ratna', 'Pak Hendra', 'Bu Sari', 'Pak Bima', 'Bu Laras', 'Pak Danu'];
const MODELS = [['opus', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5'], ['fable', 'Fable 5.1']];
const SUB_SUGS = ['api', 'web', 'mobile', 'admin', 'docs', 'infra'];
// role presets: the room they prefer is matched against folder names
const PRESETS = [
  { key: 'generalis', name: 'Tari', fem: true, title: 'Generalis', model: 'sonnet', like: /./, persona: 'Serba bisa dan cepat belajar. Membaca CLAUDE.md dan wiki kantor sebelum mulai.', skills: [] },
  { key: 'frontend', name: 'Dimas', title: 'Frontend', model: 'sonnet', like: /web|front|ui|admin|site|app/, persona: 'Peduli detail tampilan dan aksesibilitas. Selalu cek hasilnya di browser sebelum bilang selesai.', skills: ['frontend', 'css', 'aksesibilitas'] },
  { key: 'backend', name: 'Arya', title: 'Backend', model: 'sonnet', like: /api|back|server|service|core/, persona: 'Teliti soal data dan kontrak API. Menulis tes untuk setiap perubahan logika.', skills: ['backend', 'database', 'testing'] },
  { key: 'mobile', name: 'Wulan', fem: true, title: 'Mobile', model: 'sonnet', like: /mobile|android|ios|flutter|app/, persona: 'Memikirkan pengguna di HP dengan sinyal jelek. Rapi soal versi rilis.', skills: ['mobile', 'rilis'] },
  { key: 'qa', name: 'Seno', title: 'QA', model: 'haiku', like: /test|qa/, persona: 'Skeptis. Menganggap fitur rusak sampai terbukti sebaliknya, dan menulis temuan sebagai komentar kartu.', skills: ['review', 'testing'] },
  { key: 'devops', name: 'Raka', title: 'DevOps', model: 'sonnet', like: /infra|deploy|ops|docker/, persona: 'Hati-hati di server. Tidak pernah restart atau mengubah config produksi tanpa persetujuan.', skills: ['devops', 'deploy'] },
  { key: 'docs', name: 'Lintang', fem: true, title: 'Dokumentasi', model: 'haiku', like: /docs|doc|wiki/, persona: 'Menulis jelas dan ringkas. Menjaga wiki kantor tetap sesuai kode.', skills: ['dokumentasi'] },
];

let W = null, root = null, pvTimer = 0, stage = null;
const fresh = () => ({
  step: 0, mode: 'new', name: '', folder: '', folderEdited: false, base: '', layout: 'single', subs: [], gitInit: true, description: '',
  root: '', q: '', team: [mgrMember()], claudeMd: true, firstCard: true, startManager: false, brief: '', permissionMode: '',
  roots: [], folders: [], preview: null, error: '', busy: false, template: 'zen-garden', seed: 1, tpls: null,
});
function mgrMember() {
  const i = Math.floor(Math.random() * MANAGERS.length), fem = MANAGERS[i].startsWith('Bu'), l = randomLook(undefined, { fem });
  return { key: 'manager', isMgr: true, fem, name: MANAGERS[i], title: 'Manager', model: 'opus', ...l, color: SWATCHES[6], outfit: fem && l.outfit !== 'rok' && l.outfit !== 'dress' ? 'jas' : l.outfit === 'hoodie' ? 'jas' : l.outfit, tie: !fem && ['jas', 'kemeja'].includes(l.outfit),
    persona: 'Teliti dan tenang. Memecah permintaan jadi kartu di board, menunjuk role yang tepat, dan mereview hasilnya sebelum dianggap selesai.', skills: ['delegasi', 'review'] };
}
const slugDir = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const tilde = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');

export async function render(el) {
  root = el; W = fresh();
  try { const r = await api('/api/wizard/folders'); W.roots = r.roots; W.folders = r.folders; W.base = r.roots[0] || ''; } catch (e) { toast(e.message, 'bad'); }
  loadTemplates().then(l => { if (!W) return; W.tpls = l; if (!l.some(t => t.id === W.template)) W.template = l[0]?.id || ''; if (W.step === 3) draw(); }).catch(() => { if (W) W.template = ''; });
  root.innerHTML = `<div class="wrap wz">
    <header class="wz-head"><div><p class="eyebrow">Kantor baru</p><h1>Buka kantor untuk project</h1></div><ol class="wz-steps" id="wzSteps"></ol></header>
    <div class="wz-grid"><section class="wz-main card" id="wzMain"></section>
      <aside class="wz-side"><div class="wz-pv"><div class="wz-stage" id="wzStage"></div><p class="wz-pv-empty" id="wzPvEmpty">Preview denah muncul di sini.</p></div><div class="wz-pv-info" id="wzPvInfo"></div></aside></div></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('keydown', e => { if (e.target.id === 'wzSub' && e.key === 'Enter') { e.preventDefault(); addSub(e.target.value); } });
  draw();
}
export function unmount() { clearTimeout(pvTimer); stage = null; root = null; }

function draw() {
  $('#wzSteps').innerHTML = STEPS.map((s, i) => `<li class="${i === W.step ? 'cur' : i < W.step ? 'done' : ''}"><button type="button" data-wz="goto" data-i="${i}"${i > W.step ? ' disabled' : ''}><span>${i + 1}</span>${s}</button></li>`).join('');
  $('#wzMain').innerHTML = [stepProject, stepRooms, stepTeam, stepMood, stepStart][W.step]() + navHTML();
  schedulePreview();
}
const navHTML = () => `<div class="wz-nav">${W.step ? '<button type="button" class="btn" data-wz="back">Kembali</button>' : '<a class="btn" href="#/">Batal</a>'}
  <span class="wz-err" id="wzErr">${esc(W.error)}</span>
  ${W.step < STEPS.length - 1 ? '<button type="button" class="btn primary" data-wz="next">Lanjut</button>' : `<button type="button" class="btn primary" data-wz="create"${W.busy ? ' disabled' : ''}>${W.busy ? 'Membuat…' : 'Buat kantor'}</button>`}</div>`;

/* ---------- step 1: project ---------- */
function stepProject() {
  const choice = (v, t, d) => `<button type="button" class="wz-choice" data-wz="mode" data-v="${v}" aria-pressed="${W.mode === v}"><b>${t}</b><span>${d}</span></button>`;
  return `<h2>Project apa?</h2>
    <div class="wz-choices">${choice('new', 'Project baru', 'Kantor membuatkan foldernya, bisa sekalian git init dan CLAUDE.md.')}${choice('existing', 'Folder yang sudah ada', 'Pilih project yang sudah ada di folder kerjamu.')}</div>
    ${W.mode === 'new' ? newHTML() : existingHTML()}`;
}
function newHTML() {
  const path = `${tilde(W.base)}/${W.folder || '…'}`;
  const lay = (v, t, d) => `<button type="button" class="wz-choice sm" data-wz="layout" data-v="${v}" aria-pressed="${W.layout === v}"><b>${t}</b><span>${d}</span></button>`;
  return `<div class="wz-fields">
    <div class="field"><label for="wzName">Nama project</label><input id="wzName" value="${esc(W.name)}" placeholder="mis. Toko Kopi" autocomplete="off"></div>
    <div class="rf-row"><div class="field"><label for="wzBase">Lokasi</label><select id="wzBase">${W.roots.map(r => `<option value="${esc(r)}"${r === W.base ? ' selected' : ''}>${esc(tilde(r))}</option>`).join('')}</select></div>
      <div class="field"><label for="wzFolder">Nama folder</label><input id="wzFolder" value="${esc(W.folder)}" placeholder="toko-kopi" autocomplete="off"></div></div>
    <p class="hint">Folder: <code>${esc(path)}</code></p>
    <div class="field"><label for="wzDesc">Mau bikin apa?</label><textarea id="wzDesc" rows="3" placeholder="Satu-dua kalimat. Ditulis ke CLAUDE.md dan halaman Beranda wiki, jadi semua role tahu tujuannya.">${esc(W.description)}</textarea></div>
    <div class="field"><label>Struktur</label><div class="wz-choices two">${lay('single', 'Satu repo', 'Satu git di folder project. Subfolder jadi ruangan.')}${lay('multi', 'Beberapa repo', 'Folder induk; tiap subfolder repo sendiri (seperti 168Railway).')}</div></div>
    <div class="field"><label for="wzSub">${W.layout === 'multi' ? 'Repo di dalamnya' : 'Subfolder (opsional)'}</label>
      <div class="skill-box"><div class="chips">${W.subs.map(s => `<span class="chip">${esc(s)}<button type="button" data-wz="rm-sub" data-v="${esc(s)}" aria-label="Hapus ${esc(s)}">×</button></span>`).join('')}</div><input id="wzSub" placeholder="ketik lalu Enter" autocomplete="off"></div>
      <div class="wz-sugs">${SUB_SUGS.filter(s => !W.subs.includes(s)).map(s => `<button type="button" class="chip add" data-wz="add-sub" data-v="${s}">+ ${s}</button>`).join('')}</div>
      <p class="hint">${W.layout === 'multi' ? 'Tiap repo jadi satu ruangan dengan meja.' : 'Tanpa subfolder, kantor punya satu ruangan kode untuk seluruh project.'}</p></div>
    <label class="check"><input type="checkbox" id="wzGit"${W.gitInit ? ' checked' : ''}> ${W.layout === 'multi' ? 'git init di tiap repo' : 'git init di folder project'}</label></div>`;
}
function existingHTML() {
  const q = W.q.trim().toLowerCase();
  const list = W.folders.filter(f => !q || f.name.toLowerCase().includes(q)).sort((a, b) => b.mtime - a.mtime);
  const desc = f => [f.repos > 1 ? `${f.repos} repo` : f.git ? 'repo git' : 'folder', f.stack, f.md ? 'CLAUDE.md' : ''].filter(Boolean).join(' · ');
  return `<div class="wz-fields"><input type="search" id="wzQ" value="${esc(W.q)}" placeholder="Cari folder…" autocomplete="off" aria-label="Cari folder">
    <ul class="wz-folders">${list.length ? list.map(f => `<li><button type="button" class="wz-folder" data-wz="pick" data-v="${esc(f.root)}" aria-pressed="${W.root === f.root}"><b>${esc(f.name)}</b><span>${esc(desc(f))}</span><span class="hint">${esc(tilde(f.base))} · diubah ${ago(new Date(f.mtime).toISOString())}</span></button></li>`).join('') : '<li class="empty-line">Tidak ada folder yang cocok. Semua folder di folder induk mungkin sudah jadi kantor.</li>'}</ul>
    <div class="field"><label for="wzDesc">Catatan tentang project (opsional)</label><textarea id="wzDesc" rows="2" placeholder="Masuk ke halaman Beranda wiki.">${esc(W.description)}</textarea></div></div>`;
}

/* ---------- step 2: rooms ---------- */
function stepRooms() {
  const pv = W.preview;
  const rooms = pv?.plan.rooms.filter(r => !['lobby', 'openplan', 'toilet', 'booth', 'zone'].includes(r.kind)) || [];
  return `<h2>Ruangan</h2><p class="sub">Disusun dari ${W.mode === 'new' ? 'struktur yang kamu pilih' : 'isi folder'}. Ruangan kode terhubung ke foldernya; sesi Claude yang dibuka di folder itu otomatis duduk di sana.</p>
    <ul class="wz-rooms">${rooms.map(r => `<li><b>${esc(r.name)}</b><span>${r.path ? `<code>${esc(r.path)}/</code>` : r.path === '' ? '<code>./</code>' : 'ruang fungsi'}${r.stack ? ' · ' + esc(r.stack) : ''}</span></li>`).join('') || '<li class="empty-line">Memuat…</li>'}</ul>
    <p class="hint">Ruangan bisa ditambah, diganti nama, atau dibekukan nanti dari tab Role.</p>`;
}

/* ---------- step 3: team ---------- */
function stepTeam() {
  const rooms = W.preview?.rooms || [];
  const picked = new Set(W.team.map(t => t.key));
  const row = (t, i) => `<li class="wz-member"><span class="wz-ava">${sprite(t, 3)}<button type="button" class="wz-dice" data-wz="dice" data-i="${i}" title="Acak tampilan" aria-label="Acak tampilan ${esc(t.name)}">🎲</button></span>
    <div class="wz-mf"><input value="${esc(t.name)}" data-wz-f="name" data-i="${i}" aria-label="Nama" placeholder="Nama"><input value="${esc(t.title)}" data-wz-f="title" data-i="${i}" aria-label="Jabatan" placeholder="Jabatan"></div>
    <div class="wz-mf">${t.isMgr ? '<span class="wz-room">Ruang Manager</span>' : `<select data-wz-f="room" data-i="${i}" aria-label="Ruangan">${rooms.map(r => `<option value="${esc(r.id)}"${r.id === t.room ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`}
      <select data-wz-f="model" data-i="${i}" aria-label="Model">${MODELS.map(([v, l]) => `<option value="${v}"${v === t.model ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    ${t.isMgr ? '<i class="kf-boss">bos</i>' : `<button type="button" class="btn sm" data-wz="rm-member" data-i="${i}" aria-label="Hapus ${esc(t.name)}">×</button>`}</li>`;
  return `<h2>Tim</h2><p class="sub">Manager memecah pekerjaan jadi kartu dan menunjuk role. Role lain bekerja di ruangannya. Semua bisa diubah nanti.</p>
    <div class="wz-presets">${PRESETS.map(p => `<button type="button" class="chip${picked.has(p.key) ? ' on' : ' add'}" data-wz="preset" data-v="${p.key}" aria-pressed="${picked.has(p.key)}">${picked.has(p.key) ? '✓' : '+'} ${p.title}</button>`).join('')}</div>
    <ul class="wz-team">${W.team.map(row).join('')}</ul>`;
}
function addPreset(key) {
  const i = W.team.findIndex(t => t.key === key);
  if (i >= 0) { W.team.splice(i, 1); return; }
  const p = PRESETS.find(x => x.key === key), n = W.team.length;
  const rooms = W.preview?.rooms || [];
  const room = (rooms.find(r => p.like.test(`${r.path || ''} ${r.name}`.toLowerCase())) || rooms[0])?.id || '';
  W.team.push({ key, name: p.name, title: p.title, model: p.model, persona: p.persona, skills: p.skills, room, ...randomLook(undefined, { fem: !!p.fem }) });
}

/* ---------- step 4: mood (office template) ---------- */
function stepMood() {
  const t = W.tpls?.find(x => x.id === W.template);
  return `<h2>Pilih suasana kantor</h2><p class="sub">Template menyusun ulang denah, menambah ruangan fasilitas (taman, musholla, lounge …) dan mengisi perabot bertema. Pratinjaunya langsung terlihat di samping. Bisa diganti atau dipulihkan kapan saja dari Atur denah.</p>
    ${W.tpls ? galleryHTML(W.tpls, W.template, { attr: 'data-wz-tpl', none: 'Tanpa template' }) : '<p class="hint">Memuat template…</p>'}
    ${t ? `<div class="btn-row"><button type="button" class="btn sm" data-wz="tpl-roll">Acak susunan</button><span class="hint">seed ${W.seed}</span></div>` : ''}`;
}

/* ---------- step 5: start ---------- */
function stepStart() {
  const mgr = W.team.find(t => t.isMgr);
  const where = W.mode === 'new' ? `${tilde(W.base)}/${W.folder}` : tilde(W.root);
  const made = W.mode === 'new' ? [`folder <code>${esc(where)}</code>`, ...W.subs.map(s => `<code>${esc(s)}/</code>${W.layout === 'multi' && W.gitInit ? ' + git init' : ''}`), W.layout !== 'multi' && W.gitInit ? 'git init' : ''].filter(Boolean) : [];
  return `<h2>Mulai</h2>
    <div class="wz-sum"><p><b>${esc(W.mode === 'new' ? W.name || W.folder : W.root.split('/').pop())}</b> · <code>${esc(where)}</code></p>
      ${made.length ? `<p class="hint">Dibuat: ${made.join(', ')}</p>` : '<p class="hint">Isi folder tidak diubah, kecuali CLAUDE.md kalau kamu centang di bawah dan belum ada.</p>'}
      <p class="hint">Tim: ${W.team.map(t => esc(t.name)).join(', ')} · ${W.preview?.plan.rooms.length || '?'} ruangan · suasana ${esc(W.tpls?.find(x => x.id === W.template)?.name || 'bawaan')}</p></div>
    <label class="check"><input type="checkbox" id="wzMd"${W.claudeMd ? ' checked' : ''}> Tulis <code>CLAUDE.md</code> awal${W.mode === 'existing' ? ' (hanya kalau belum ada)' : ''}</label>
    <label class="check"><input type="checkbox" id="wzCard"${W.firstCard ? ' checked' : ''}> Buat kartu pertama untuk ${esc(mgr?.name || 'manager')}: <i>${W.mode === 'new' ? 'Rancang struktur awal project' : 'Kenali project dan rapikan board'}</i></label>
    <label class="check"><input type="checkbox" id="wzStart"${W.startManager ? ' checked' : ''}> Langsung mulai shift ${esc(mgr?.name || 'manager')} <span class="hint">(memakai token)</span></label>
    ${W.startManager ? `<div class="wz-fields"><div class="field"><label for="wzBrief">Brief untuk ${esc(mgr?.name || 'manager')}</label><textarea id="wzBrief" rows="3" placeholder="Kosongkan untuk memakai kartu pertama sebagai tugas.">${esc(W.brief)}</textarea></div>
      <div class="field"><label for="wzPerm">Mode izin</label><select id="wzPerm">${PERMS.map(([v, l]) => `<option value="${v}"${v === W.permissionMode ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>` : ''}`;
}

/* ---------- events ---------- */
function onClick(e) {
  const card = e.target.closest('[data-wz-tpl]');
  if (card) { W.template = card.dataset.wzTpl; W.seed = 1; draw(); return; }
  const t = e.target.closest('[data-wz]'); if (!t) return;
  const a = t.dataset.wz, v = t.dataset.v;
  W.error = '';
  if (a === 'mode') { W.mode = v; W.preview = null; }
  else if (a === 'layout') W.layout = v;
  else if (a === 'add-sub') return addSub(v);
  else if (a === 'rm-sub') W.subs = W.subs.filter(s => s !== v);
  else if (a === 'pick') { W.root = v; const f = W.folders.find(x => x.root === v); if (f) W.claudeMd = !f.md; }
  else if (a === 'preset') addPreset(v);
  else if (a === 'dice') { const m = W.team[Number(t.dataset.i)], fem = m.fem ?? isFem(m); const l = randomLook(undefined, { fem }); if (m.isMgr) { l.color = m.color; if (l.outfit === 'hoodie') l.outfit = 'jas'; l.tie = !fem && ['jas', 'kemeja'].includes(l.outfit); } applyLook(m, l); }
  else if (a === 'rm-member') W.team.splice(Number(t.dataset.i), 1);
  else if (a === 'goto') W.step = Math.min(Number(t.dataset.i), W.step);
  else if (a === 'back') W.step--;
  else if (a === 'next') { const err = check(); if (err) { W.error = err; } else W.step++; }
  else if (a === 'tpl-roll') W.seed = (Math.random() * 1e6) | 0;
  else if (a === 'create') return create();
  draw();
}
function addSub(raw) {
  const s = slugDir(raw); if (!s || W.subs.includes(s)) return;
  W.subs.push(s); draw(); $('#wzSub')?.focus();
}
function onInput(e) {
  const t = e.target, id = t.id;
  if (id === 'wzName') { W.name = t.value; if (!W.folderEdited) { W.folder = slugDir(t.value); const f = $('#wzFolder'); if (f) f.value = W.folder; } refreshPath(); schedulePreview(); }
  else if (id === 'wzFolder') { W.folder = slugDir(t.value) || ''; W.folderEdited = !!t.value; refreshPath(); schedulePreview(); }
  else if (id === 'wzBase') { W.base = t.value; refreshPath(); schedulePreview(); }
  else if (id === 'wzDesc') W.description = t.value;
  else if (id === 'wzGit') { W.gitInit = t.checked; schedulePreview(); }
  else if (id === 'wzQ') { W.q = t.value; const pos = t.selectionStart; draw(); const q = $('#wzQ'); q.focus(); q.setSelectionRange(pos, pos); }
  else if (id === 'wzMd') W.claudeMd = t.checked;
  else if (id === 'wzCard') W.firstCard = t.checked;
  else if (id === 'wzStart') { W.startManager = t.checked; draw(); }
  else if (id === 'wzBrief') W.brief = t.value;
  else if (id === 'wzPerm') W.permissionMode = t.value;
  else if (t.dataset.wzF) { const m = W.team[Number(t.dataset.i)]; m[t.dataset.wzF] = t.value; if (e.type === 'change') { if (t.dataset.wzF === 'name' || t.dataset.wzF === 'title') return; schedulePreview(); } }
}
function refreshPath() { const h = $('#wzMain .hint code'); if (h) h.textContent = `${tilde(W.base)}/${W.folder || '…'}`; }
function check() {
  if (W.step === 0) {
    if (W.mode === 'new' && !W.folder) return 'Isi nama project dulu.';
    if (W.mode === 'new' && W.layout === 'multi' && !W.subs.length) return 'Tambahkan minimal satu repo.';
    if (W.mode === 'existing' && !W.root) return 'Pilih foldernya dulu.';
    if (W.preview?.warnings?.length) return W.preview.warnings[0];
  }
  if (W.step === 2 && !W.team.some(t => t.isMgr && t.name.trim())) return 'Manager perlu nama.';
  return '';
}
const spec = () => ({ mode: W.mode, name: W.mode === 'new' ? W.name || W.folder : undefined, base: W.base, folder: W.folder, layout: W.layout, subs: W.subs, gitInit: W.gitInit,
  root: W.root, description: W.description, team: W.team, claudeMd: W.claudeMd, firstCard: W.firstCard, startManager: W.startManager, brief: W.brief, permissionMode: W.permissionMode,
  template: W.template || null, seed: W.seed });

/* ---------- preview ---------- */
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(async () => {
    if (!root) return;
    if (W.mode === 'new' ? !W.folder : !W.root) { showPreview(null); return; }
    try { W.preview = await post('/api/wizard/preview', spec()); }
    catch (e) { W.preview = null; $('#wzPvInfo').innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; return; }
    // rooms may have changed under the team: keep each member's room valid
    const ids = new Set(W.preview.rooms.map(r => r.id));
    W.preview.team.forEach((t, i) => { if (!W.team[i].isMgr && !ids.has(W.team[i].room)) W.team[i].room = t.room; });
    showPreview(W.preview);
    if (W.step === 1 || W.step === 2) { const keep = document.activeElement?.dataset?.wzF ? null : true; if (keep) $('#wzMain').innerHTML = [stepProject, stepRooms, stepTeam, stepMood, stepStart][W.step]() + navHTML(); }
  }, 260);
}
function showPreview(pv) {
  const host = $('#wzStage'); if (!host) return;
  host.querySelector('canvas')?.remove();
  $('#wzPvEmpty').hidden = !!pv;
  if (!pv) { $('#wzPvInfo').innerHTML = ''; stage = null; return; }
  const roles = pv.team.map(t => ({ ...t, tie: t.tie ?? !!t.isMgr }));
  const sessions = pv.team.map((t, i) => ({ sid: `pv${i}`, role: t.id, room: t.room, status: 'idle', kind: 'kantor', title: t.name, subs: [] }));
  stage = createStage(host, { plan: pv.plan, roles, sessions, cards: [], fill: true, animateArrivals: false, insets: { left: 8, top: 8, right: 8, bottom: 8 }, onPick: () => {}, onRoom: () => {} });
  stage.fitAll();
  const code = pv.rooms.length;
  $('#wzPvInfo').innerHTML = `<p><b>${esc(pv.name)}</b> <span class="hint">${esc(tilde(pv.root))}</span></p>
    <p class="hint">${pv.plan.rooms.length} ruangan · ${code} ruangan kode · ${pv.team.length} orang</p>
    ${pv.warnings.map(w => `<p class="warn-t">${esc(w)}</p>`).join('')}`;
}

async function create() {
  W.busy = true; draw();
  try {
    const r = await post('/api/wizard/create', spec());
    toast(r.shift ? 'Kantor dibuka, manager mulai bekerja' : 'Kantor dibuka', 'ok');
    location.hash = `#/o/${r.id}`;
  } catch (e) { W.busy = false; W.error = e.message; draw(); }
}
