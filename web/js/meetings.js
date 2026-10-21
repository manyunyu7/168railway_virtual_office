import { $, esc, short, usd, api, post, toast, confirmDo, sprite, mini, guestLook, dateLong, hhmm, modelName, md } from './util.js';

let root = null, ctx = null, list = [], cur = null, curId = null, mode = 'list', form = null;

const base = () => `#/o/${ctx.office.id}`;
const url = p => `/api/offices/${ctx.office.id}/${p}`;
const STATUS = { berjalan: 'Berjalan', selesai: 'Selesai', gagal: 'Gagal', terputus: 'Terputus' };
const statusChip = s => `<span class="st ${s === 'berjalan' ? 'working' : s === 'gagal' || s === 'terputus' ? 'wait' : 'idle'}">${STATUS[s] || esc(s)}</span>`;
const roleById = id => ctx.office.roles.find(r => r.id === id);
const roleByName = n => ctx.office.roles.find(r => r.name.toLowerCase() === String(n || '').toLowerCase());

export async function render(el, c, r) {
  root = el; ctx = c; list = []; cur = null; curId = null; mode = 'list'; form = null;
  el.onclick = onClick; el.onsubmit = onSubmit; el.oninput = onInput;
  await loadList();
  await openRoute(r);
}

export function unmount() { if (root) { root.onclick = root.onsubmit = root.oninput = null; } root = null; }

export async function route(r) { await openRoute(r); }

async function openRoute(r) {
  const id = r?.rest?.[0];
  if (id === 'baru') { mode = 'new'; curId = null; cur = null; form = form || { topic: '', agenda: '', rounds: 2, parts: ctx.office.roles.filter(x => !x.archived).map(x => x.id).slice(0, 3), chair: '' }; }
  else if (id) { mode = 'view'; await loadMeeting(id); }
  else { mode = 'list'; curId = null; cur = null; }
  draw();
}

async function loadList() {
  try { list = await api(url('meetings')); } catch (e) { list = []; toast(e.message, 'bad'); }
}
async function loadMeeting(id) {
  curId = id;
  try { cur = await api(url(`meetings/${encodeURIComponent(id)}`)); } catch (e) { cur = null; toast(e.message, 'bad'); }
}

/* ---------------- drawing ---------------- */
function draw() {
  if (!root) return;
  root.innerHTML = `<div class="meet-grid"><aside>${listHTML()}</aside><section id="mtMain" style="min-width:0">${mode === 'new' ? formHTML() : mode === 'view' ? viewHTML() : introHTML()}</section></div>`;
  if (mode === 'new') updateEstimate();
  if (mode === 'view') scrollChat(true);
}

function listHTML() {
  return `<div class="btn-row" style="margin-bottom:10px"><a class="btn primary" href="${base()}/rapat/baru">Rapat baru</a></div>
    <div class="meet-list">${list.length ? list.map(m => `<a class="meet-item" style="text-decoration:none" href="${base()}/rapat/${encodeURIComponent(m.id)}" aria-current="${m.id === curId}">
      <h4>${esc(short(m.topic, 60))}</h4><div class="btn-row">${statusChip(m.status)}<span class="hint">${esc(m.created_at ? dateLong(m.created_at) : '')}</span></div>
      <span class="hint">${m.participants?.length || 0} peserta · ${usd(m.cost, 3)}</span></a>`).join('') : '<p class="empty-line">Belum ada rapat.</p>'}</div>`;
}

function introHTML() {
  return `<div class="card"><h2>Rapat</h2><p class="sub">Role AI berdiskusi bergiliran tentang satu topik. Tiap giliran adalah satu panggilan <code>claude -p</code> sebagai role itu, hanya dengan tool baca. Di akhir, ketua menulis notulen yang disimpan ke wiki, lalu tindak lanjutnya bisa dijadikan kartu board.</p>
    <p class="hint" style="margin-top:8px">Selama rapat berlangsung, para peserta berkumpul di Ruang Meeting pada denah kantor.</p>
    <div class="btn-row" style="margin-top:12px"><a class="btn primary" href="${base()}/rapat/baru">Rapat baru</a></div></div>`;
}

/* ---------------- new meeting form ---------------- */
function formHTML() {
  const roles = ctx.office.roles.filter(r => !r.archived);
  if (roles.length < 2) return `<div class="card"><h2>Rapat baru</h2><p class="empty-line">Rapat butuh minimal 2 role. Tambahkan role di tab Role dulu.</p></div>`;
  return `<form class="card" id="mtForm" style="display:grid;gap:14px"><h2>Rapat baru</h2>
    <div class="field"><label for="mtTopic">Topik</label><input id="mtTopic" value="${esc(form.topic)}" placeholder="mis. Rencana rilis 1.8" autocomplete="off"></div>
    <div class="field"><label for="mtAgenda">Agenda / konteks</label><textarea id="mtAgenda" rows="4" placeholder="Apa yang perlu diputuskan? Tautan, batasan, tenggat.">${esc(form.agenda)}</textarea></div>
    <div class="field"><label>Peserta (minimal 2)</label><div style="display:grid;gap:6px">${roles.map(r => `<label class="check"><input type="checkbox" data-part="${esc(r.id)}" ${form.parts.includes(r.id) ? 'checked' : ''}>${mini(r)}<span>${esc(r.name)}</span><span class="hint">${esc(r.title || '')} · ${esc(modelName(r.model))}</span></label>`).join('')}</div></div>
    <div class="grid2"><div class="field"><label for="mtRounds">Ronde (1 sampai 4)</label><input id="mtRounds" type="number" min="1" max="4" value="${form.rounds}"></div>
      <div class="field"><label for="mtChair">Ketua</label><select id="mtChair"></select></div></div>
    <div class="notice info" id="mtEst"></div>
    <div class="btn-row"><button class="btn primary" type="submit" id="mtGo">Mulai rapat</button><a class="btn" href="${base()}/rapat">Batal</a></div></form>`;
}

function chairOptions() {
  const sel = $('#mtChair', root); if (!sel) return;
  const chosen = form.parts.map(roleById).filter(Boolean);
  if (!chosen.some(r => r.id === form.chair)) form.chair = (chosen.find(r => r.isMgr) || chosen[0] || {}).id || '';
  sel.innerHTML = chosen.map(r => `<option value="${esc(r.id)}" ${r.id === form.chair ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
}

function updateEstimate() {
  chairOptions();
  const n = form.parts.length, r = Math.min(4, Math.max(1, Number(form.rounds) || 1)), total = n * r + 1;
  const el = $('#mtEst', root); if (!el) return;
  el.innerHTML = `<span><b>≈ ${total} giliran</b> (${n} peserta × ${r} ronde + 1 notulen), tiap giliran memakai model role-nya. Biaya nyata, setara pemakaian API: rapat panjang dengan model besar bisa mencapai beberapa dolar.</span>`;
  const go = $('#mtGo', root); if (go) go.disabled = n < 2;
}

function onInput(e) {
  if (mode !== 'new' || !form) return;
  const t = e.target;
  if (t.id === 'mtTopic') form.topic = t.value;
  else if (t.id === 'mtAgenda') form.agenda = t.value;
  else if (t.id === 'mtRounds') { form.rounds = t.value; updateEstimate(); }
  else if (t.id === 'mtChair') form.chair = t.value;
  else if (t.dataset.part) {
    form.parts = t.checked ? [...form.parts, t.dataset.part] : form.parts.filter(x => x !== t.dataset.part);
    updateEstimate();
  }
}

async function onSubmit(e) {
  if (e.target.id === 'mtSay') {
    e.preventDefault();
    const inp = $('#mtSayText', root), text = inp.value.trim(); if (!text) return;
    try { await post(url(`meetings/${encodeURIComponent(curId)}/say`), { text }); inp.value = ''; } catch (err) { toast(err.message, 'bad'); }
    return;
  }
  if (e.target.id !== 'mtForm') return;
  e.preventDefault();
  const topic = form.topic.trim();
  if (!topic) { toast('Isi topik rapat dulu', 'warn'); return; }
  if (form.parts.length < 2) { toast('Pilih minimal 2 peserta', 'warn'); return; }
  const btn = $('#mtGo', root); btn.disabled = true;
  try {
    const r = await post(url('meetings'), { topic, agenda: form.agenda.trim(), participants: form.parts, rounds: Math.min(4, Math.max(1, Number(form.rounds) || 2)), chair: form.chair });
    const id = r.id || r.meeting?.id;
    form = null;
    toast('Rapat dimulai', 'ok');
    await loadList();
    if (id) location.hash = `${base()}/rapat/${encodeURIComponent(id)}`; else { mode = 'list'; draw(); }
  } catch (err) { toast(err.message, 'bad'); btn.disabled = false; }
}

/* ---------------- meeting view ---------------- */
function viewHTML() {
  const m = cur;
  if (!m) return `<div class="card"><p class="empty-line">Rapat tidak ditemukan.</p></div>`;
  const parts = (m.participants || []).map(roleById).filter(Boolean);
  const running = m.status === 'berjalan';
  return `<div class="card" style="display:grid;gap:14px">
    <div><div class="btn-row" style="justify-content:space-between"><h2 style="margin:0">${esc(m.topic)}</h2>${statusChip(m.status)}</div>
      <div class="btn-row" style="margin-top:8px">${parts.map(r => `<span title="${esc(r.name)}${r.id === m.chair ? ' (ketua)' : ''}">${mini(r)}</span>`).join('')}<span class="hint">${parts.map(r => esc(r.name)).join(', ')} · ketua ${esc(roleById(m.chair)?.name || m.chair || '-')} · ${m.rounds || '?'} ronde · <span data-slot="mtcost">${usd(m.cost, 3)}</span></span></div>
      ${m.agenda ? `<p class="sub" style="margin-top:8px;white-space:pre-wrap">${esc(m.agenda)}</p>` : ''}
      ${running ? '<p class="hint" style="margin-top:6px">Selama rapat berjalan, para peserta berkumpul di Ruang Meeting pada denah kantor.</p>' : ''}</div>
    ${m.status === 'gagal' || m.status === 'terputus' ? `<div class="notice"><span>${m.status === 'gagal' ? `Rapat berhenti: ${esc(m.error || 'tanpa keterangan')}` : 'Rapat terputus karena kantor dimulai ulang.'} Percakapan sejauh ini tersimpan, dan rapat bisa diteruskan dari giliran terakhir.</span><button class="btn sm primary" data-act="mt-resume">Lanjutkan rapat</button></div>` : ''}
    <div class="chat" id="mtChat" style="max-height:60vh;overflow-y:auto;padding-right:4px">${(m.messages || []).map(msgHTML).join('')}</div>
    <div id="mtTyping">${typingHTML()}</div>
    ${running ? `<form id="mtSay" class="inline-form" style="display:flex;gap:8px"><input id="mtSayText" placeholder="Sela rapat: tulis pendapat atau arahan" autocomplete="off" style="flex:1"><button class="btn" type="submit">Kirim</button></form>
      <div class="btn-row"><button class="btn danger" data-act="mt-cancel">Bubarkan rapat</button></div>` : ''}
    ${m.status === 'selesai' ? minutesHTML(m) : ''}</div>`;
}

function avatarFor(who) {
  const r = roleByName(who);
  return r ? sprite(r, 3) : sprite(guestLook(String(who)), 3);
}
function msgHTML(g) {
  const kind = g.kind === 'sistem' ? 'sistem' : g.kind === 'kamu' ? 'kamu' : '';
  if (kind === 'sistem') return `<div class="msg sistem" data-mid="${esc(g.id)}"><div class="bub">${esc(g.text)}</div></div>`;
  return `<div class="msg ${kind}" data-mid="${esc(g.id)}"><div>${kind ? sprite({ color: '#55606E', hair: '#2B1D14', skin: '#F1C9A5', tie: true }, 3) : avatarFor(g.who)}</div>
    <div><div class="who">${esc(kind ? 'Kamu' : g.who)} · ${esc(hhmm(g.at))}${g.cost ? ` · ${usd(g.cost, 3)}` : ''}</div><div class="bub">${md(g.text, { taskIndex: false })}</div></div></div>`;
}
function typingHTML() {
  const m = cur; if (!m || m.status !== 'berjalan') return '';
  const last = [...(m.messages || [])].reverse().find(g => g.kind === 'bicara');
  const names = (m.participants || []).map(roleById).filter(Boolean).map(r => r.name);
  let label = 'Rapat berjalan…';
  if (names.length) {
    const i = last ? names.findIndex(n => n.toLowerCase() === String(last.who).toLowerCase()) : -1;
    if (last && i >= 0) label = `${names[(i + 1) % names.length]} sedang bicara…`;
    else if (!last) label = `${names[0]} sedang bicara…`;
  }
  return `<div class="typing"><i></i><i></i><i></i><span>${esc(label)}</span></div>`;
}

function minutesHTML(m) {
  const acts = m.actions || [];
  const allDone = acts.length && acts.every(a => a.card);
  return `<div class="minutes"><h2 style="margin:0">Notulen</h2>
    ${m.summary ? `<div><h3 style="font-size:14px">Ringkasan</h3><p style="white-space:pre-wrap">${esc(m.summary)}</p></div>` : ''}
    ${m.decisions?.length ? `<div><h3 style="font-size:14px">Keputusan</h3><ul>${m.decisions.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
    <div><div class="btn-row" style="justify-content:space-between"><h3 style="font-size:14px">Tindak lanjut</h3>${acts.length && !allDone ? '<button class="btn sm" data-act="mt-action" data-index="all">Semua jadi kartu</button>' : ''}</div>
      ${acts.length ? acts.map((a, i) => `<div class="action-row"><div style="min-width:0"><b>${esc(a.title)}</b><div class="hint">${a.who ? esc(roleById(a.who)?.name || a.who) + ' · ' : ''}${esc(a.prio || '')}${a.detail ? ' · ' + esc(short(a.detail, 120)) : ''}</div></div>
        ${a.card ? `<a class="btn sm" href="${base()}/board/${esc(a.card)}">Lihat kartu</a>` : `<button class="btn sm" data-act="mt-action" data-index="${i}">Jadikan kartu</button>`}</div>`).join('') : '<p class="empty-line">Tidak ada tindak lanjut.</p>'}</div>
    ${m.wiki_slug ? `<div><a class="btn sm" href="${base()}/wiki/${encodeURIComponent(m.wiki_slug)}">Buka notulen di wiki</a></div>` : ''}</div>`;
}

function scrollChat(force) {
  const c = $('#mtChat', root); if (!c) return;
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 140) c.scrollTop = c.scrollHeight;
}

/* ---------------- actions ---------------- */
async function onClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  try {
    if (t.dataset.act === 'mt-cancel') {
      confirmDo('Bubarkan rapat?', 'Giliran yang sedang jalan dihentikan. Percakapan sejauh ini tetap tersimpan.', 'Bubarkan', async () => {
        try { await post(url('meetings-cancel'), { id: curId }); toast('Rapat dibubarkan', 'ok'); await refresh(); } catch (err) { toast(err.message, 'bad'); }
      });
    } else if (t.dataset.act === 'mt-resume') {
      t.disabled = true;
      await post(url(`meetings/${encodeURIComponent(curId)}/resume`), {});
      toast('Rapat dilanjutkan', 'ok');
      await refresh();
    } else if (t.dataset.act === 'mt-action') {
      t.disabled = true;
      const idx = t.dataset.index === 'all' ? 'all' : Number(t.dataset.index);
      await post(url(`meetings/${encodeURIComponent(curId)}/action`), { index: idx });
      toast('Kartu dibuat', 'ok');
      await refresh();
    }
  } catch (err) { toast(err.message, 'bad'); t.disabled = false; }
}

async function refresh() {
  await loadList();
  if (mode === 'view' && curId) await loadMeeting(curId);
  draw();
}

/* ---------------- live ---------------- */
export function live(msg) {
  if (!root || !ctx || msg.office !== ctx.office.id && msg.office !== '*') return;
  if (msg.t === 'meeting-msg' && mode === 'view' && cur && msg.meetingId === curId) {
    if ((cur.messages || []).some(g => g.id === msg.msg.id)) return;
    cur.messages = [...(cur.messages || []), msg.msg];
    if (msg.msg.cost) { cur.cost = (Number(cur.cost) || 0) + msg.msg.cost; const c = $('[data-slot="mtcost"]', root); if (c) c.textContent = usd(cur.cost, 3); }
    const chat = $('#mtChat', root); if (!chat) return;
    const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
    chat.insertAdjacentHTML('beforeend', msgHTML(msg.msg));
    if (stick) chat.scrollTop = chat.scrollHeight;
    const ty = $('#mtTyping', root); if (ty) ty.innerHTML = typingHTML();
  }
  if (msg.t === 'changed' && msg.what === 'meetings') {
    if (mode === 'new') return loadList().then(() => { const a = $('aside', root); if (a) a.innerHTML = listHTML(); });
    refresh();
  }
}
