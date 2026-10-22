// Tab Chat di drawer sesi: percakapan sebagai gelembung, aksi tool dipadatkan, kartu izin, kolom ketik.
import { $, esc, short, hhmm, api, post, toast, md, onLive } from './util.js';
import { uploadFile, fmtSize } from './upload.js';
import { subRows, fmtTokens, fmtElapsed } from './subagents.js';
import { chatBubble, chatClick } from './pratinjau.js';

// CSS tab ini dimuat dari sini supaya index.html tidak perlu diubah
if (!document.getElementById('chatCss')) {
  const l = document.createElement('link');
  l.id = 'chatCss'; l.rel = 'stylesheet'; l.href = new URL('../css/chat.css', import.meta.url).href;
  document.head.appendChild(l);
}

const POLL_MS = 10000; // cadangan saja: server mendorong { t: 'transcript' } tiap transcript bertambah
const TOOL_FOLD = 3; // lebih dari ini, rangkaian aksi tool yang sudah lewat dilipat jadi satu baris
const sleep = ms => new Promise(r => setTimeout(r, ms));

const splitTool = s => { const i = s.indexOf(' '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const toolName = n => n.startsWith('mcp__') ? n.split('__')[1] : n;

const FRESH_MS = 4000;
/** HTML indikator mengetik, atau '' bila sesi tidak sedang bekerja / jawaban terbarunya baru saja masuk. */
export function typingHTML(s, gs, now = Date.now()) {
  if (!s || !(s.status === 'working' || s.status === 'starting') || s.waiting || s.compacting) return '';
  const last = gs?.[gs.length - 1];
  if (last?.k === 'text' && now - (Date.parse(last.at) || 0) < FRESH_MS) return '';
  const tl = s.tool && (s.tool.label || s.tool.name) ? `${s.tool.name || ''} ${short(s.tool.label || '', 60)}`.trim() : '';
  return `<div class="ch-row ai ch-typing" role="status" aria-live="polite"><div class="ch-b ai"><span class="ch-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="ch-tyt">Sedang mengetik…</span>${tl ? `<small class="ch-tyl">${esc(tl)}</small>` : ''}</div></div>`;
}

/** Item transcript datar -> pesan user, jawaban Claude, dan rangkaian aksi tool (hasilnya dipasangkan berurutan). */
export function buildChat(items) {
  const out = [], pend = [];
  let cur = null;
  for (const it of items) {
    if (it.k === 'tool') {
      const [name, label] = splitTool(it.s);
      const tl = { name, label, res: null, at: it.at, add: it.add, del: it.del };
      if (!cur) { cur = { k: 'tools', at: it.at, list: [] }; out.push(cur); }
      cur.list.push(tl); pend.push(tl);
    } else if (it.k === 'result') {
      const tl = pend.shift(); if (tl) tl.res = it;
    } else if (it.k === 'image' && it.src === 'view' && cur) {
      // gambar yang dilihat agen ikut rangkaian aksinya, tidak memutusnya; bila cocok dengan baris Read/ImageView, tampil di bawah baris itu
      const tl = [...cur.list].reverse().find(t => !t.img && t.label && (t.label === it.name || t.label === it.path || it.path.endsWith('/' + t.label)));
      if (tl) tl.img = it; else (cur.imgs ||= []).push(it);
    } else { cur = null; out.push(it); }
  }
  return out;
}

const toolRow = (t, running) => {
  const st = t.res ? (t.res.err ? '<i class="ch-ts err" title="Gagal">✕</i>' : '<i class="ch-ts ok" title="Selesai">✓</i>') : `<i class="ch-ts${running ? ' run' : ''}">…</i>`;
  const head = `<span class="ch-tn">${esc(toolName(t.name))}</span><span class="ch-tl">${esc(short(t.label, 90))}</span>${t.add || t.del ? `<span class="ch-diff"><b class="add">+${t.add || 0}</b> <b class="del">−${t.del || 0}</b></span>` : ''}${st}`;
  const body = (t.label && t.label.length > 90 ? `<div class="ch-tfull">${esc(t.label)}</div>` : '') + (t.res?.s ? `<pre>${esc(t.res.s)}</pre>` : '');
  const img = t.img ? `<div class="ch-imgs">${imgBtn(t.img, 'sm')}</div>` : '';
  if (t.img) return `<div class="ch-tool"><button type="button" class="ch-sum ch-sum-img" data-act="img-open" data-url="${esc(imgUrl(t.img))}" data-name="${esc(t.img.name || '')}">${head}</button>${img}</div>`;
  return body ? `<details class="ch-tool" data-k="${esc(t.at)}"><summary>${head}</summary>${body}</details>` : `<div class="ch-tool"><div class="ch-sum">${head}</div></div>`;
};
function toolsHTML(g, last, running) {
  const rows = g.list.map(t => toolRow(t, running && last)).join('') + (g.imgs?.length ? `<div class="ch-imgs">${g.imgs.map(i => imgBtn(i, 'sm')).join('')}</div>` : '');
  if (last || g.list.length <= TOOL_FOLD) return `<div class="ch-tools">${rows}</div>`;
  const cnt = {}; for (const t of g.list) { const n = toolName(t.name); cnt[n] = (cnt[n] || 0) + 1; }
  const sum = Object.entries(cnt).map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
  return `<details class="ch-tools fold" data-k="g${esc(g.at)}"><summary><b>${g.list.length} aksi</b> <span>${esc(short(sum, 80))}</span></summary>${rows}</details>`;
}
// Item {k:'image', path} dilayani GET /api/sessions/:sid/image?path=…[&thumb=1]; sid ditempel oleh load()
const imgUrl = (i, thumb) => `/api/sessions/${encodeURIComponent(i.sid)}/image?path=${encodeURIComponent(i.path)}${thumb ? '&thumb=1' : ''}`;
// thumbnail kecil (sm) dimuat langsung, bukan lazy: chat dirender ulang tiap pembaruan dan img lazy di dalamnya bisa tak pernah termuat (pil kosong)
const imgBtn = (i, cls = '') => `<button type="button" class="ch-media ${cls}" data-act="img-open" data-url="${esc(imgUrl(i))}" data-name="${esc(i.name || '')}" aria-label="Buka ${esc(i.name || 'gambar')}"><img src="${esc(imgUrl(i, true))}" alt="${esc(i.name || '')}"${cls === 'sm' ? '' : ' loading="lazy"'} onerror="this.closest('button').classList.add('gone')"><span class="ch-img-na">gambar tidak tersedia</span></button>`;
function itemHTML(g, last, running) {
  if (g.k === 'user') return `<div class="ch-row me"><div class="ch-b me">${esc(g.s)}</div><time>${esc(hhmm(g.at))}</time></div>`;
  if (g.k === 'text') return `<div class="ch-row ai"><div class="ch-b ai md">${md(g.s)}</div><time>${esc(hhmm(g.at))}</time></div>`;
  if (g.k === 'image') { // gambar dari transcript: hasil generate Codex, tempelan pemilik, atau gambar yang dilihat agen
    const me = g.src === 'user', cap = g.src === 'gen' ? `<div class="ch-cap">🎨 ${esc(short(g.s || 'Gambar dibuat', 160))}</div>` : '';
    return `<div class="ch-row ${me ? 'me' : 'ai'}"><div class="ch-b att ${me ? 'me' : 'ai'}">${imgBtn(g)}${cap}</div><time>${esc(hhmm(g.at))}</time></div>`;
  }
  return toolsHTML(g, last, running);
}

/** Pertanyaan AskUserQuestion dari ringkasan izin (JSON, kadang terpotong di 400 karakter). */
export function parseAsk(summary) {
  try {
    const qs = JSON.parse(summary).questions || [];
    return { qs: qs.map(q => ({ q: q.question || q.header || '', multi: !!q.multiSelect, opts: (q.options || []).map(o => ({ label: o.label || '', desc: o.description || '' })) })), partial: false };
  } catch {
    const un = s => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
    const q = [...summary.matchAll(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => un(m[1]));
    const labels = [...summary.matchAll(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => un(m[1]));
    return { qs: [{ q: q[0] || '', multi: false, opts: labels.map(label => ({ label, desc: '' })) }], partial: true, many: q.length > 1 };
  }
}


/* ---------------- lampiran ---------------- */
// Bentuk item dari GET /api/sessions/:sid/attachments; diterima longgar karena kontrak bisa bergeser.
const attMine = a => a.dir === 'in';
const attKind = a => a.kind || (String(a.mime || '').startsWith('image/') ? 'image' : String(a.mime || '').startsWith('video/') ? 'video' : 'file');
const attRaw = a => a.url || `/api/attachments/${encodeURIComponent(a.id)}/raw`;
const attThumb = a => a.thumb || `/api/attachments/${encodeURIComponent(a.id)}/thumb`;
const attDl = a => attRaw(a) + (attRaw(a).includes('?') ? '&' : '?') + 'dl=1';
const FILE_ICON = { pdf: '📕', zip: '🗜', csv: '📊', xlsx: '📊', json: '🧾', md: '📝', txt: '📝', mp3: '🎵', wav: '🎵' };
const fileIcon = n => FILE_ICON[String(n || '').split('.').pop().toLowerCase()] || '📄';
const attAt = a => a.at || '';

function attHTML(a, agent) {
  const mine = attMine(a), k = attKind(a), who = mine ? '' : `<span class="ch-who">${esc(agent || '')}</span>`;
  let body;
  if (k === 'image') body = `<button type="button" class="ch-media" data-act="att-open" data-id="${esc(a.id)}" aria-label="Buka ${esc(a.name)}"><img src="${attThumb(a)}" alt="${esc(a.name)}" loading="lazy"></button>`;
  else if (k === 'video') body = `<button type="button" class="ch-media vid" data-act="att-play" data-id="${esc(a.id)}" aria-label="Putar ${esc(a.name)}"><img src="${attThumb(a)}" alt="" loading="lazy" onerror="this.remove()"><span class="ch-play">▶</span></button>`;
  else if (k === 'audio') body = `<audio class="ch-audio" src="${attRaw(a)}" controls preload="none"></audio>`;
  else body = `<a class="ch-file" href="${attDl(a)}" download="${esc(a.name)}"><span class="ch-fi">${fileIcon(a.name)}</span><span class="ch-fn"><b>${esc(short(a.name, 48))}</b><small>${fmtSize(a.size)}</small></span><span class="ch-dl" aria-hidden="true">⬇</span></a>`;
  const cap = (a.caption ? `<div class="ch-cap">${esc(a.caption)}</div>` : '') + (a.processing ? '<div class="ch-cap ch-proc">Memproses…</div>' : '') + (mine && a.delivered === false ? '<div class="ch-cap ch-proc">Tersimpan, belum sampai ke sesi</div>' : '');
  return `<div class="ch-row ${mine ? 'me' : 'ai'}" data-att="${esc(a.id)}">${who}<div class="ch-b att ${mine ? 'me' : 'ai'}">${body}${cap}</div><time>${esc(hhmm(attAt(a)))}</time></div>`;
}

/** Layar penuh untuk gambar: ketuk/roda untuk zoom, seret untuk geser, tombol unduh dan tutup. */
function lightbox(a) {
  const el = document.createElement('div'); el.className = 'ch-lb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', a.name);
  el.innerHTML = `<div class="ch-lb-bar"><span>${esc(short(a.name, 60))}</span><a class="btn sm" href="${attDl(a)}" download="${esc(a.name)}">Unduh</a><button type="button" class="btn sm" data-x>Tutup</button></div><div class="ch-lb-stage"><img src="${attRaw(a)}" alt="${esc(a.name)}" draggable="false"></div>`;
  const img = $('img', el), stage = $('.ch-lb-stage', el);
  let sc = 1, tx = 0, ty = 0, drag = null, moved = false;
  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; stage.classList.toggle('zoom', sc > 1); };
  const zoom = (f, cx = 0, cy = 0) => { const n = Math.max(1, Math.min(8, sc * f)); tx = (tx - cx) * (n / sc) + cx; ty = (ty - cy) * (n / sc) + cy; sc = n; if (sc === 1) tx = ty = 0; apply(); };
  const rel = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };
  stage.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, ...rel(e)); }, { passive: false });
  const pts = new Map(); let pinch = 0;
  stage.addEventListener('pointerdown', e => { pts.set(e.pointerId, e); stage.setPointerCapture(e.pointerId); moved = false; drag = { x: e.clientX, y: e.clientY, tx, ty }; if (pts.size === 2) { const [p, q] = [...pts.values()]; pinch = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY); } });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    if (pts.size === 2) { const [p, q] = [...pts.values()], d = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY); if (pinch) zoom(d / pinch, ...rel({ clientX: (p.clientX + q.clientX) / 2, clientY: (p.clientY + q.clientY) / 2 })); pinch = d; moved = true; return; }
    if (sc > 1 && drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; tx = drag.tx + dx; ty = drag.ty + dy; apply(); }
  });
  const up = e => { pts.delete(e.pointerId); pinch = 0; drag = null; };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('click', e => { if (moved) return; if (document.elementFromPoint(e.clientX, e.clientY) === img) { if (sc > 1) { sc = 1; tx = ty = 0; apply(); } else zoom(2.5, ...rel(e)); } else close(); });
  const key = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
  const close = () => { document.removeEventListener('keydown', key, true); el.remove(); };
  el.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(); });
  document.addEventListener('keydown', key, true);
  document.body.appendChild(el); $('[data-x]', el).focus();
}

// Chat yang sedang terpasang per sesi, supaya toast hanya muncul untuk sesi yang tidak dibuka.
const mounted = new Map();
onLive(msg => {
  if (msg.t !== 'attachment' || !msg.item || attMine(msg.item) || mounted.has(msg.sid)) return;
  const a = msg.item, who = a.agent || a.sender || 'Agen';
  toast(`${msg.name || who} mengirim ${attKind(a) === 'image' ? 'gambar' : attKind(a) === 'video' ? 'video' : 'file'}: ${short(a.name || '', 40)}`, 'ok');
});

const QUICK = [['lanjut', 'say', 'lanjut'], ['ya', 'say', 'ya'], ['Hentikan', 'dr-action', 'esc'], ['/compact', 'dr-action', 'compact']];

/**
 * Pasang Chat di host. o = { ctx, sid, name(), sess(), canSend(), send(text) }.
 * Mengembalikan { update(), live(msg), refresh(), destroy() }.
 */
export function mountChat(host, o) {
  let size = null, timer = 0, bump = 0, dead = false, loading = false, sticky = true, gs = [], atts = [], outbox = [], unsub = null, pvs = [];
  const pend = document.createElement('div'); pend.className = 'ch-pend';
  const typ = document.createElement('div'); typ.className = 'ch-typing-wrap';
  mounted.set(o.sid, (mounted.get(o.sid) || 0) + 1);
  host.innerHTML = `<div class="ch">
    <div class="ch-list" data-slot="list"><p class="ch-empty">Memuat percakapan…</p></div>
    <div class="ch-drop" hidden>Lepas file untuk melampirkan</div>
    <div class="ch-foot">
      <div data-slot="perm"></div>
      <div class="ch-status" data-slot="status"></div>
      <details class="ch-subs" data-slot="subs" open hidden><summary></summary><div class="ch-subs-list"></div></details>
      <div class="ch-quick">${QUICK.map(([l, act, v]) => act === 'say'
        ? `<button type="button" class="ch-chip" data-act="ch-say" data-text="${esc(v)}">${esc(l)}</button>`
        : `<button type="button" class="ch-chip${v === 'esc' ? ' halt' : ''}" data-act="dr-action" data-a="${v}">${esc(l)}</button>`).join('')}</div>
      <form class="msgbox ch-form" id="drQuick"><button type="button" class="ch-attach" data-act="ch-attach" title="Lampirkan file" aria-label="Lampirkan file">📎</button><input type="file" multiple hidden data-slot="file"><textarea id="drQuickIn" rows="1" aria-label="Pesan untuk ${esc(o.name())}" placeholder="Pesan untuk ${esc(o.name())}…"></textarea><button class="btn primary sm" type="submit">Kirim</button></form>
    </div></div>`;
  const list = $('[data-slot="list"]', host);
  list.addEventListener('scroll', () => { sticky = list.scrollHeight - list.scrollTop - list.clientHeight < 60; }, { passive: true });

  const running = () => { const s = o.sess(); return !!s && (s.status === 'working' || s.status === 'waiting'); };

  function lock() {
    const can = o.canSend() && o.sess()?.status !== 'ended';
    const ta = $('#drQuickIn', host);
    for (const el of host.querySelectorAll('.ch-form textarea, .ch-form button:not(.ch-attach), .ch-quick button')) el.disabled = !can;
    const at = $('.ch-attach', host); if (at) at.disabled = o.sess()?.status === 'ended';
    if (ta) ta.placeholder = can ? `Pesan untuk ${o.name()}…` : o.sess()?.status === 'ended' ? 'Sesi sudah selesai' : 'Tidak bisa mengetik ke sesi ini dari sini';
  }
  function statusHTML() {
    const s = o.sess(); if (!s) return '';
    const n = esc(o.name()), subs = (s.subs || []).filter(x => x.status !== 'done').length;
    let cls = s.status, t;
    if (s.status === 'ended') t = 'Sesi selesai';
    else if (s.waiting || s.status === 'waiting') t = `${n} menunggu izin`;
    else if (s.compacting) t = `${n} sedang meringkas percakapan`;
    else if (s.status === 'working' || s.status === 'starting') {
      const tl = s.tool && (s.tool.label || s.tool.name) ? `${esc(s.tool.name || '')} ${esc(short(s.tool.label || '', 60))}`.trim() : '';
      t = `${n} sedang ${tl ? 'memakai ' + tl : 'berpikir'}`;
    } else t = `${n} idle, menunggu pesanmu`;
    return `<i class="ch-dot ${esc(cls)}"></i><span>${t}${subs ? ` · ${subs} subagent jalan` : ''}</span>`;
  }
  function paintStatus() { const el = $('[data-slot="status"]', host); if (el) el.innerHTML = statusHTML(); lock(); }
  /* ---- subagent yang jalan (dan yang baru selesai), dengan waktu berjalan dan token ---- */
  let subTick = 0;
  function paintSubs() {
    const el = $('[data-slot="subs"]', host); if (!el) return;
    const s = o.sess(), rows = s && s.status !== 'ended' ? subRows(s.subs) : [];
    el.hidden = !rows.length;
    if (rows.length && !subTick) subTick = setInterval(() => { if (!document.hidden) paintSubs(); }, 1000);
    if (!rows.length) { clearInterval(subTick); subTick = 0; return; }
    const live = rows.filter(r => !r.done).reduce((a, r) => a + r.n, 0);
    const sum = `<i class="ch-dot ${live ? 'working' : 'idle'}"></i>${esc(o.name())} · ${live ? `${live} subagent jalan` : 'subagent selesai'}`;
    const sumEl = el.querySelector('summary'); if (sumEl.innerHTML !== sum) sumEl.innerHTML = sum;
    el.querySelector('.ch-subs-list').innerHTML = rows.map(r => `<div class="ch-sub${r.done ? ' done' : ''}"><span class="ch-sub-dot" aria-hidden="true">${r.done ? '●' : '○'}</span><b>${esc(r.label)}</b><span class="ch-sub-act">${esc(short((r.done ? '' : r.act) || r.desc || '', 80))}</span><span class="ch-sub-meta">${fmtElapsed(r.elapsed)}${r.tokens != null ? ` · ↓ ${fmtTokens(r.tokens)} tokens` : ''}</span></div>`).join('');
  }

  function permHTML() {
    const items = (o.ctx.st?.inbox || []).filter(i => i.sid === o.sid);
    return items.map(it => {
      if (it.tool === 'AskUserQuestion') return askHTML(it);
      return `<div class="ch-perm"><div class="ch-ph">Minta izin <b>${esc(it.tool)}</b></div><code>${esc(short(it.summary, 600))}</code>${it.held
        ? `<div class="btn-row"><button class="btn primary" data-act="allow" data-id="${esc(it.id)}">Izinkan</button><button class="btn" data-act="deny" data-id="${esc(it.id)}">Tolak</button></div>`
        : '<p class="hint">Sudah pindah ke terminal sesinya. Jawab dari tab Terminal.</p>'}</div>`;
    }).join('');
  }
  // Draf jawaban per item inbox: tahan repaint (update() memanggil paintPerm tiap status berubah).
  const drafts = new Map();
  const dq = (id, i) => { const d = drafts.get(id) || drafts.set(id, []).get(id); return d[i] || (d[i] = { sel: [], text: '', note: '', noteOpen: false }); };
  function askHTML(it) {
    const a = parseAsk(it.summary || '');
    if (!it.held || a.partial) return legacyAskHTML(it, a);
    const id = esc(it.id);
    return `<div class="ch-perm ask" data-ask="${id}"><div class="ch-ph">${esc(o.name())} bertanya</div>${a.qs.map((q, i) => {
      const d = dq(it.id, i);
      return `<div class="ch-aq" data-qi="${i}"><p class="ch-q">${esc(q.q)}${q.multi ? ' <small>(boleh pilih lebih dari satu)</small>' : ''}</p>
        ${q.opts.length ? `<ol class="ch-opts">${q.opts.map((p, k) => `<li><button type="button" class="btn ch-opt${d.sel.includes(k) ? ' on' : ''}" data-act="ch-pick" data-id="${id}" data-qi="${i}" data-k="${k}" aria-pressed="${d.sel.includes(k)}"><b>${k + 1}</b><span><span class="ch-ol">${esc(p.label)}</span>${p.desc ? `<small>${esc(p.desc)}</small>` : ''}</span></button></li>`).join('')}</ol>` : ''}
        <input class="ch-other" type="text" placeholder="Jawaban lain (ketik sendiri)" data-ask-in="text" data-id="${id}" data-qi="${i}" value="${esc(d.text)}">
        ${d.noteOpen ? `<textarea class="ch-note" rows="2" placeholder="Catatan tambahan (opsional)" data-ask-in="note" data-id="${id}" data-qi="${i}">${esc(d.note)}</textarea>` : `<button type="button" class="ch-addnote" data-act="ch-note" data-id="${id}" data-qi="${i}">+ Tambah catatan</button>`}</div>`;
    }).join('')}<div class="btn-row"><button class="btn primary" data-act="ch-send-ask" data-id="${id}">Kirim jawaban</button></div></div>`;
  }
  // Pertanyaan yang sudah pindah ke terminal: hanya bisa mengetik nomor opsi.
  function legacyAskHTML(it, a) {
    const one = a.qs.length === 1 && !a.qs[0].multi && !a.many && a.qs[0].opts.length;
    return `<div class="ch-perm ask"><div class="ch-ph">${esc(o.name())} bertanya</div>${a.qs.map(q => `<p class="ch-q">${esc(q.q)}</p>${q.opts.length ? `<ol class="ch-opts">${q.opts.map((p, i) => `<li>${one ? `<button class="btn" data-act="ch-ask" data-n="${i + 1}" data-id="${esc(it.id)}" data-held="0"><b>${i + 1}</b><span><span class="ch-ol">${esc(p.label)}</span>${p.desc ? `<small>${esc(p.desc)}</small>` : ''}</span></button>` : `<span class="ch-optx"><b>${i + 1}</b><span><span class="ch-ol">${esc(p.label)}</span>${p.desc ? `<small>${esc(p.desc)}</small>` : ''}</span></span>`}</li>`).join('')}</ol>` : ''}`).join('')}
      ${one ? '<p class="hint">Sudah pindah ke terminal; tombol mengetik nomor opsi.</p>' : '<p class="hint">Pertanyaan ini sudah pindah ke terminal. Jawab di tab Terminal.</p>'}</div>`;
  }
  function paintPerm() {
    const el = $('[data-slot="perm"]', host); if (!el) return;
    const open = new Set((o.ctx.st?.inbox || []).map(i => i.id)); for (const k of drafts.keys()) if (!open.has(k)) drafts.delete(k);
    const html = permHTML();
    // jangan merusak ketikan yang sedang berjalan
    if (el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && el.dataset.sig === sigPerm()) return;
    el.dataset.sig = sigPerm(); el.innerHTML = html;
  }
  const sigPerm = () => (o.ctx.st?.inbox || []).filter(i => i.sid === o.sid).map(i => i.id + (i.held ? 'h' : '')).join(',');

  async function load() {
    if (dead || loading) return;
    loading = true;
    let data;
    try { data = await api(`/api/sessions/${encodeURIComponent(o.sid)}/transcript?n=200`); } catch { loading = false; return; }
    loading = false;
    if (dead || !list.isConnected) return;
    if (String(data.size) === size && data.size != null) return;
    size = String(data.size);
    gs = buildChat((data.items || []).map(i => i.k === 'image' ? { ...i, sid: o.sid } : i));
    paint();
  }
  /** Gabungkan percakapan dan lampiran menurut waktu; unggahan yang sedang jalan selalu di ujung bawah. */
  function paint() {
    const open = new Set([...list.querySelectorAll('details[open]')].map(d => d.dataset.k));
    const ts = x => Date.parse(x) || 0, rows = [];
    // lampiran dan pratinjau yang dikirim sesi ini, disisipkan menurut waktu
    const sorted = [...atts.map(a => ({ at: attAt(a), html: () => attHTML(a, o.name()) })), ...pvs.map(p => ({ at: p.createdAt, html: () => pvRow(p) }))].sort((a, b) => ts(a.at) - ts(b.at));
    let ai = 0;
    gs.forEach((g, i) => {
      while (ai < sorted.length && ts(sorted[ai].at) <= ts(g.at)) rows.push(sorted[ai++].html());
      rows.push(itemHTML(g, i === gs.length - 1, running()));
    });
    while (ai < sorted.length) rows.push(sorted[ai++].html());
    const ob = outboxHTML();
    pend.remove();
    list.innerHTML = rows.length || ob || pend.childElementCount ? rows.join('') + ob : '<p class="ch-empty">Belum ada percakapan di transcript.</p>';
    list.appendChild(pend);
    for (const d of list.querySelectorAll('details[data-k]')) if (open.has(d.dataset.k)) d.open = true;
    paintTyping();
    if (sticky) list.scrollTop = list.scrollHeight;
  }
  /** "Sedang mengetik…" di ujung bawah selama sesi bekerja dan jawaban terbarunya belum muncul. */
  function paintTyping() {
    const html = typingHTML(o.sess(), gs);
    if (typ.dataset.h === html) { if (html && typ.parentNode !== list) list.appendChild(typ); return; }
    typ.dataset.h = html; typ.innerHTML = html;
    if (html) { list.appendChild(typ); if (sticky) list.scrollTop = list.scrollHeight; } else typ.remove();
  }
  /* ---- pratinjau dari sesi ini (pratinjau_kirim) sebagai gelembung dengan tombol aksinya ---- */
  const pvOffice = () => o.sess()?.office || o.ctx?.office?.id;
  const pvRow = p => `<div class="ch-row ai"><div class="ch-b ai">${chatBubble(p)}</div><time>${esc(hhmm(p.createdAt))}</time></div>`;
  async function loadPv() {
    const off = pvOffice(); if (!off) return;
    let d; try { d = await api(`/api/offices/${encodeURIComponent(off)}/pratinjau?sid=${encodeURIComponent(o.sid)}&limit=50`); } catch { return; }
    if (dead) return;
    pvs = d.items || []; paint();
  }
  function upsertPv(it) { if (!it || it.sid !== o.sid) return; const i = pvs.findIndex(x => x.id === it.id); if (i >= 0) pvs[i] = it; else pvs.push(it); paint(); }
  async function loadAtts() {
    let d; try { d = await api(`/api/sessions/${encodeURIComponent(o.sid)}/attachments`); } catch { return; }
    if (dead) return;
    const arr = Array.isArray(d) ? d : d.items || d.attachments || [];
    if (JSON.stringify(arr) === JSON.stringify(atts)) return;
    atts = arr; paint();
  }
  function addAtt(item) { if (!item) return; atts = atts.some(a => a.id === item.id) ? atts.map(a => a.id === item.id ? item : a) : [...atts, item]; paint(); }

  /* ---- antrean pesan: terkirim ke daemon tapi belum dibaca agen ---- */
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
  // same rule as server/outbox.js: unwrap a bracketed paste, either side may be clipped with "…"
  const unclip = t => norm(String(t || '').replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1')).replace(/…$/, '').trim();
  const sameText = (a, b) => { a = unclip(a); b = unclip(b); return a === b || (a.length > 20 && b.length > 20 && (a.startsWith(b) || b.startsWith(a))); };
  function outboxHTML() {
    const ts = x => Date.parse(x) || 0, used = new Set();
    const shown = outbox.filter(it => {
      if (it.status === 'read') { // sudah masuk transcript sebagai pesan biasa? jangan dobel
        const i = gs.findIndex((g, j) => g.k === 'user' && !used.has(j) && sameText(g.s, it.text) && ts(g.at) >= ts(it.at) - 5000);
        if (i >= 0) { used.add(i); return false; }
      }
      return true;
    }).sort((a, b) => ts(a.at) - ts(b.at));
    return shown.map(it => it.status === 'read'
      ? `<div class="ch-row me"><div class="ch-b me">${esc(it.text)}</div><time>${esc(hhmm(it.at))}</time></div>`
      : `<div class="ch-row me ch-q-row"><div class="ch-b me pending">${esc(it.text)}</div><div class="ch-pending"><span aria-hidden="true">🕒</span> Terkirim · menunggu dibaca${it.local ? '' : `<button type="button" class="ch-x" data-act="ob-cancel" data-id="${esc(it.id)}">Batalkan</button>`}</div></div>`).join('');
  }
  const obKey = it => norm(it.text);
  function setOutbox(arr) {
    // pesan optimistis dilepas begitu server mengakuinya (teks sama) atau setelah 10 detik
    const local = outbox.filter(x => x.local && Date.now() - x.t < 10000 && !arr.some(y => obKey(y) === obKey(x) && y.status === 'pending'));
    const seen = new Set(), keep = arr.filter(x => (x.status === 'pending' || x.status === 'read') && !seen.has(x.id) && seen.add(x.id));
    outbox = [...keep, ...local]; paint();
  }
  async function loadOutbox() {
    let d; try { d = await api(`/api/sessions/${encodeURIComponent(o.sid)}/outbox`); } catch { return; }
    if (dead) return;
    setOutbox(Array.isArray(d) ? d : d.items || []);
  }
  function upsertOutbox(item) {
    if (!item) return;
    const rest = outbox.filter(x => x.id !== item.id);
    setOutbox(item.status === 'pending' || item.status === 'read' ? [...rest.filter(x => !x.local), item] : rest.filter(x => !x.local));
  }
  function optimistic(text) {
    const t = norm(text); if (!t) return null;
    const it = { id: 'local' + Date.now() + Math.random(), text: t, at: new Date().toISOString(), status: 'pending', local: true, t: Date.now() };
    outbox = [...outbox, it]; sticky = true; paint(); setTimeout(() => { if (outbox.includes(it)) { outbox = outbox.filter(x => x !== it); paint(); } }, 10500);
    return it;
  }
  // kolom ketik ditangani drawer.js; di sini hanya ikut membaca isinya saat dikirim
  host.addEventListener('submit', e => { if (e.target.id === 'drQuick') { const it = optimistic($('#drQuickIn', host)?.value); if (it) setTimeout(loadOutbox, 600); } }, true);
  const send0 = o.send;
  o = { ...o, send: async text => { const it = optimistic(text); const ok = await send0(text); if (!ok && it) { outbox = outbox.filter(x => x !== it); paint(); } else if (ok) setTimeout(loadOutbox, 600); return ok; } };

  /* ---- unggah ---- */
  const queue = []; let busy = false;
  function pickFiles(files, caption) {
    const fs = [...files].filter(f => f.size >= 0); if (!fs.length) return;
    fs.forEach((f, i) => enqueue(f, i === 0 ? caption : ''));
  }
  function enqueue(file, caption) {
    const el = document.createElement('div'); el.className = 'ch-row me ch-up';
    const name = file.name || 'gambar tempel';
    el.innerHTML = `<div class="ch-b me att"><div class="ch-upn"><b>${esc(short(name, 40))}</b><small>${fmtSize(file.size)}</small></div><div class="ch-bar"><i></i></div><div class="ch-upi"><span data-s>Menunggu giliran…</span><button type="button" class="ch-x" data-x aria-label="Batalkan">Batal</button></div></div>`;
    pend.appendChild(el); sticky = true; list.scrollTop = list.scrollHeight;
    const ctl = new AbortController(), job = { file, caption, el, ctl };
    $('[data-x]', el).onclick = () => { ctl.abort(); if (!job.started) { el.remove(); queue.splice(queue.indexOf(job), 1); } };
    queue.push(job); pump();
  }
  async function pump() {
    if (busy) return; busy = true;
    while (queue.length && !dead) {
      const job = queue.shift(), { el } = job, s = $('[data-s]', el), bar = $('.ch-bar i', el), x = $('[data-x]', el);
      job.started = true; if (job.ctl.signal.aborted) { el.remove(); continue; }
      try {
        const r = await uploadFile(o.sid, job.file, { caption: job.caption, signal: job.ctl.signal, onProgress: (n, t) => { const p = t ? Math.min(100, Math.round(n / t * 100)) : 100; bar.style.width = p + '%'; s.textContent = `Mengunggah ${p}%`; } });
        void r; s.textContent = 'Terkirim'; el.classList.add('done'); x.remove();
        await loadAtts(); setTimeout(() => el.remove(), 600);
      } catch (e) {
        if (e.aborted) { el.remove(); continue; }
        el.classList.add('fail'); s.textContent = e.message || 'Gagal mengunggah'; x.textContent = 'Tutup'; x.onclick = () => el.remove();
        toast(`Gagal mengunggah ${job.file.name || 'file'}: ${e.message}`, 'bad');
      }
    }
    busy = false;
  }
  const fileIn = $('[data-slot="file"]', host), ta = () => $('#drQuickIn', host);
  const takeCaption = () => { const t = ta(); const v = (t?.value || '').trim(); if (t && v) { t.value = ''; t.style.height = 'auto'; } return v; };
  fileIn.addEventListener('change', () => { pickFiles(fileIn.files, takeCaption()); fileIn.value = ''; });
  const drop = $('.ch-drop', host); let dragN = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  host.addEventListener('dragenter', e => { if (hasFiles(e)) { dragN++; drop.hidden = false; } });
  host.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  host.addEventListener('dragleave', e => { if (hasFiles(e) && --dragN <= 0) { dragN = 0; drop.hidden = true; } });
  host.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; drop.hidden = true; pickFiles(e.dataTransfer.files, takeCaption()); });
  host.addEventListener('paste', e => {
    const fs = [...(e.clipboardData?.files || [])]; if (!fs.length) return;
    e.preventDefault(); pickFiles(fs, takeCaption());
  });

  host.addEventListener('click', async e => {
    if (e.target.closest('.pv-cb')) { await chatClick(e, pvOffice(), pvs, upsertPv); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'ch-attach') fileIn.click();
    else if (b.dataset.act === 'ob-cancel') { try { await api(`/api/sessions/${encodeURIComponent(o.sid)}/outbox/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' }); outbox = outbox.filter(x => x.id !== b.dataset.id); paint(); } catch (er) { toast(er.message, 'bad'); loadOutbox(); } }
    else if (b.dataset.act === 'img-open') lightbox({ name: b.dataset.name || 'gambar', url: b.dataset.url });
    else if (b.dataset.act === 'att-open') { const a = atts.find(x => x.id === b.dataset.id); if (a) lightbox(a); }
    else if (b.dataset.act === 'att-play') {
      const a = atts.find(x => x.id === b.dataset.id); if (!a) return;
      b.outerHTML = `<video class="ch-video" src="${attRaw(a)}" poster="${attThumb(a)}" controls autoplay playsinline preload="metadata"></video>`;
    }
    else if (b.dataset.act === 'ch-say') { if (await o.send(b.dataset.text)) bumpLoad(); }
    else if (b.dataset.act === 'ch-pick') {
      const a = parseAsk(((o.ctx.st?.inbox || []).find(i => i.id === b.dataset.id) || {}).summary || ''), i = +b.dataset.qi, k = +b.dataset.k, d = dq(b.dataset.id, i);
      if (a.qs[i]?.multi) d.sel = d.sel.includes(k) ? d.sel.filter(x => x !== k) : [...d.sel, k];
      else { d.sel = d.sel.includes(k) ? [] : [k]; if (d.sel.length) d.text = ''; }
      const box = b.closest('.ch-aq');
      box.querySelectorAll('.ch-opt').forEach(x => { const on = d.sel.includes(+x.dataset.k); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      const inp = box.querySelector('.ch-other'); if (inp && !a.qs[i]?.multi && d.sel.length) inp.value = '';
    }
    else if (b.dataset.act === 'ch-note') { const d = dq(b.dataset.id, +b.dataset.qi); d.noteOpen = true; paintPermForce(); $(`[data-ask-in="note"][data-id="${b.dataset.id}"][data-qi="${b.dataset.qi}"]`, host)?.focus(); }
    else if (b.dataset.act === 'ch-send-ask') {
      const it = (o.ctx.st?.inbox || []).find(i => i.id === b.dataset.id); if (!it) return;
      const a = parseAsk(it.summary || ''), dr = drafts.get(it.id) || [];
      const answers = a.qs.map((q, i) => { const d = dr[i] || { sel: [], text: '', note: '' }; return { q: i, ...(q.multi ? { choices: d.sel.map(k => k + 1) } : d.sel.length ? { choice: d.sel[0] + 1 } : {}), text: d.text, note: d.note }; });
      const miss = answers.findIndex(x => !x.choice && !(x.choices || []).length && !x.text.trim());
      if (miss >= 0) { toast(`Pilih atau tulis jawaban untuk pertanyaan ${miss + 1}`, 'bad'); return; }
      b.disabled = true;
      try { await post(`/api/inbox/${encodeURIComponent(it.id)}/answer`, { answers }); drafts.delete(it.id); bumpLoad(600); }
      catch (er) { toast(er.message, 'bad'); b.disabled = false; }
    }
    else if (b.dataset.act === 'ch-ask') {
      b.disabled = true;
      try {
        // izin yang masih ditahan harus dilepas dulu, baru pilihan muncul di terminalnya
        if (b.dataset.held === '1') { await post(`/api/inbox/${b.dataset.id}`, { behavior: 'allow' }); await sleep(1500); }
        await o.send(b.dataset.n);
      } catch (er) { toast(er.message, 'bad'); }
    }
  });
  function paintPermForce() { const el = $('[data-slot="perm"]', host); if (el) { el.dataset.sig = sigPerm(); el.innerHTML = permHTML(); } }
  host.addEventListener('input', e => {
    const t = e.target.closest('[data-ask-in]'); if (!t) return;
    const d = dq(t.dataset.id, +t.dataset.qi); d[t.dataset.askIn] = t.value;
    if (t.dataset.askIn === 'text' && t.value) { // jawaban ketikan menggantikan pilihan pada pertanyaan tunggal-pilih
      const a = parseAsk(((o.ctx.st?.inbox || []).find(i => i.id === t.dataset.id) || {}).summary || '');
      if (!a.qs[+t.dataset.qi]?.multi && d.sel.length) { d.sel = []; t.closest('.ch-aq').querySelectorAll('.ch-opt').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); }
    }
  });
  function bumpLoad(ms = 900) { clearTimeout(bump); bump = setTimeout(load, ms); }

  unsub = onLive(m => { if (m.t === 'attachment' && m.sid === o.sid) addAtt(m.item); else if (m.t === 'outbox' && m.sid === o.sid) upsertOutbox(m.item); else if (m.t === 'transcript' && m.sid === o.sid) { if (String(m.size) !== size || m.switched) { if (m.switched) size = null; load(); } } else if (m.t === 'pratinjau' && m.item?.sid === o.sid) upsertPv(m.item); else if (m.t === 'reconnected') { loadAtts(); loadOutbox(); loadPv(); load(); } });
  paintPerm(); paintStatus(); paintSubs(); load(); loadAtts(); loadOutbox(); loadPv();
  timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  return {
    update() { paintStatus(); paintSubs(); paintPerm(); paintTyping(); bumpLoad(700); },
    live(msg) { if (msg.t?.startsWith('inbox')) paintPerm(); },
    refresh() { bumpLoad(1200); },
    destroy() { dead = true; unsub?.(); for (const j of queue) j.ctl.abort(); const c = (mounted.get(o.sid) || 1) - 1; c ? mounted.set(o.sid, c) : mounted.delete(o.sid); clearInterval(timer); clearInterval(subTick); clearTimeout(bump); },
  };
}
