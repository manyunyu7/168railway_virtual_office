// Tab Timeline: grafik Gantt dari kartu board. HTML/CSS untuk bar, SVG untuk panah dependensi.
// Data dari /board; jadwal diubah lewat PATCH kartu (optimistis, rollback + toast bila gagal).
import { $, $$, esc, api, patch, toast, modal, closeModal, confirmDo, mini } from './util.js';

const DAY = 86400000, RH = 38, HH = 58, BAR_T = 7, BAR_H = 24;
const ZOOM = { day: 42, week: 16, month: 5, quarter: 1.7 };
const ZNAME = [['day', 'Hari'], ['week', 'Minggu'], ['month', 'Bulan'], ['quarter', 'Kuartal']];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DOWL = ['M', 'S', 'S', 'R', 'K', 'J', 'S'];
// warna per JENIS kolom (bukan nomor kolom): papan bisa punya kolom sendiri
const KINDS = ['antre', 'siap', 'dikerjakan', 'review', 'selesai'];
const KIND_LABEL = { antre: 'Antre', siap: 'Siap', dikerjakan: 'Dikerjakan', review: 'Review', selesai: 'Selesai' };
const COLK = { antre: 'var(--b6)', siap: 'var(--b2)', dikerjakan: 'var(--accent)', review: 'var(--b4)', selesai: 'var(--ok)' };
const kindOf = c => c.colKind || KINDS[c.stage ?? c.col] || 'antre';
const colorOf = c => (S.color === 'who' ? roleOf(c.who)?.color || 'var(--b6)' : S.color === 'board' ? boardOf(c.board)?.color || 'var(--b6)' : COLK[kindOf(c)]);
const LSB = oid => 'kc.board.sel.' + oid;
const GROUPS = [['epic', 'Epic'], ['who', 'Orang'], ['repo', 'Repo'], ['label', 'Label'], ['none', 'Tanpa']];
const LS = id => 'kc.gantt.' + id;

const S = {
  ctx: null, el: null, oid: null, sc: null,
  cards: [], all: [], labels: [], boards: [], board: 'utama', moves: {}, ghosts: new Set(),
  zoom: 'week', dw: ZOOM.week, group: 'epic', color: 'col', who: '', label: '', hideDone: false, crit: false, compact: false,
  collapsed: new Set(), sel: null, ov: {}, lo: 0, days: 0, rows: [], rowOf: new Map(),
  D: null, busy: 0, chain: Promise.resolve(), timer: null, raf: 0, first: true, pop: null, handlers: null,
};

/* ---------------- tanggal ---------------- */
const pd = s => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || ''); return m ? Math.round(Date.UTC(+m[1], m[2] - 1, +m[3]) / DAY) : null; };
const fd = n => new Date(n * DAY).toISOString().slice(0, 10);
const dow = n => (((n + 4) % 7) + 7) % 7; // 0 = Minggu
const isWk = n => { const w = dow(n); return w === 0 || w === 6; };
const today = () => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
const ymd = n => { const d = new Date(n * DAY); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const fmt = (n, yr) => { const [y, m, d] = ymd(n); return `${d} ${MON[m]}${yr || y !== ymd(today())[0] ? ' ' + y : ''}`; };
const endFrom = (s, n) => { let e = s, c = isWk(s) ? 0 : 1; while (c < n) { e++; if (!isWk(e)) c++; } return e; };
const startTo = (e, n) => { let s = e, c = isWk(e) ? 0 : 1; while (c < n) { s--; if (!isWk(s)) c++; } return s; };

/* ---------------- model ---------------- */
const office = () => S.ctx.office;
const base = () => `/api/offices/${S.oid}`;
const roleOf = id => id && (office().roles || []).find(r => r.id === id);
const rooms = () => office().plan?.rooms || [];
const repoName = id => !id ? 'Tanpa repo' : id === 'lintas' ? 'Lintas repo' : rooms().find(x => x.id === id)?.name || id;
const card = id => S.all.find(c => c.id === id) || S.cards.find(c => c.id === id);
const boardOf = id => S.boards.find(b => b.id === (id || 'utama'));
const isAllB = () => S.board === 'all';
const labelOf = id => S.labels.find(l => l.id === id);
const done = c => (c.done ?? kindOf(c) === 'selesai');
const prog = c => c.progress != null ? c.progress : c.checks?.total ? Math.round(100 * c.checks.done / c.checks.total) : done(c) ? 100 : 0;

function span(c) {
  if (c.epic) return null;
  const o = S.ov[c.id];
  if (o) return { s: o.s, e: o.e, der: false, ms: !!c.milestone };
  let s = pd(c.start), e = pd(c.due);
  // hanya tanggal tayang: tampil sebagai ◆ di tanggal itu (menggeser = mengubah tanggal tayang)
  if (s == null && e == null && pd(c.publishAt) != null) { const d = pd(c.publishAt); return { s: d, e: d, der: false, ms: true, pub: true }; }
  if (c.milestone) { const d = e ?? s; return d == null ? null : { s: d, e: d, der: false, ms: true }; }
  if (s == null && e == null) return null;
  const n = Math.max(1, c.estDays || 2);
  let der = false;
  if (e == null) { e = endFrom(s, n); der = true; } else if (s == null) { s = startTo(e, n); der = true; }
  if (e < s) e = s;
  return { s, e, der, ms: false };
}
const overdue = c => { if (done(c)) return false; const sp = span(c), pa = pd(c.publishAt); return (!!sp && sp.e < today()) || (pa != null && pa < today()); };
/** Isi PATCH untuk jadwal baru [s, e]: kartu yang hanya punya tanggal tayang menggeser tanggal tayangnya. */
const dateFields = (c, s, e) => (span(c)?.pub ? { publishAt: fd(s) } : c.milestone ? { start: fd(s), due: fd(s) } : { start: fd(s), due: fd(e) });

const real = () => S.cards.filter(c => !c.epic);
const passes = c => (!S.who || (S.who === '_none' ? !c.who : c.who === S.who)) && (!S.label || (c.labels || []).includes(S.label)) && !(S.hideDone && done(c));
const scheduledAll = () => real().filter(c => span(c));
const unscheduled = () => real().filter(c => !span(c) && passes(c));

function conflicts() {
  const out = [];
  for (const c of real()) {
    const sp = span(c); if (!sp || done(c)) continue;
    for (const d of c.deps || []) { const p = card(d), ps = p && span(p); if (ps && sp.s <= ps.e) out.push({ from: d, to: c.id }); }
  }
  return out;
}
function critical() {
  const live = scheduledAll().filter(c => !done(c));
  if (live.length < 2) return { ids: new Set(), edges: new Set() };
  const ids = new Set(live.map(c => c.id));
  let cur = live.reduce((a, b) => (span(b).e > span(a).e ? b : a));
  const chain = [cur.id], edges = new Set();
  for (let guard = 0; guard < 200; guard++) {
    const preds = (cur.deps || []).filter(d => ids.has(d)).map(card);
    if (!preds.length) break;
    const p = preds.reduce((a, b) => (span(b).e > span(a).e ? b : a));
    edges.add(p.id + '>' + cur.id); chain.push(p.id); cur = p;
  }
  return chain.length < 2 ? { ids: new Set(), edges: new Set() } : { ids: new Set(chain), edges };
}
function wouldCycle(from, to) { // tambah "to menunggu from": melingkar bila from sudah (tak langsung) menunggu to
  const seen = new Set(); const st = [from];
  while (st.length) { const x = st.pop(); if (x === to) return true; if (seen.has(x)) continue; seen.add(x); (card(x)?.deps || []).forEach(d => st.push(d)); }
  return false;
}
function planShift() {
  const sc = scheduledAll(), ids = new Set(sc.map(c => c.id)), order = [], seen = new Set();
  const visit = c => { if (seen.has(c.id)) return; seen.add(c.id); (c.deps || []).filter(d => ids.has(d)).forEach(d => visit(card(d))); order.push(c); };
  sc.forEach(visit);
  const sh = new Map();
  for (const c of order) {
    if (done(c)) continue;
    const sp = span(c); let need = 0;
    for (const d of c.deps || []) { if (!ids.has(d)) continue; const pe = span(card(d)).e + (sh.get(d) || 0); need = Math.max(need, pe + 1 - sp.s); }
    if (need > 0) sh.set(c.id, need);
  }
  return sh;
}

/* ---------------- prefs & data ---------------- */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS(S.oid)) || '{}');
    if (ZOOM[p.zoom]) S.zoom = p.zoom;
    if (GROUPS.some(g => g[0] === p.group)) S.group = p.group;
    if (p.color === 'col' || p.color === 'who' || p.color === 'board') S.color = p.color;
    S.hideDone = !!p.hideDone; S.crit = !!p.crit; S.compact = !!p.compact;
    S.collapsed = new Set(p.collapsed || []);
  } catch {}
  S.dw = ZOOM[S.zoom];
  try { S.board = localStorage.getItem(LSB(S.oid)) || 'utama'; } catch {}
}
function savePrefs() {
  try { localStorage.setItem(LS(S.oid), JSON.stringify({ zoom: S.zoom, group: S.group, color: S.color, hideDone: S.hideDone, crit: S.crit, compact: S.compact, collapsed: [...S.collapsed] })); } catch {}
}
async function fetchBoard() {
  const b = await api(`${base()}/board?board=all&moves=1`);
  S.all = b.cards || []; S.labels = b.labels || []; S.boards = b.boards || []; S.moves = b.moves || {};
  if (!isAllB() && !S.boards.some(x => x.id === S.board && !x.archived)) S.board = 'utama';
  S.cards = isAllB() ? S.all : S.all.filter(c => (c.board || 'utama') === S.board);
}

/* ---------------- rows ---------------- */
function groupSummary(items) {
  const sps = items.map(span).filter(Boolean);
  if (!sps.length) return null;
  const s = Math.min(...sps.map(x => x.s)), e = Math.max(...sps.map(x => x.e));
  let w = 0, p = 0; items.forEach(c => { const sp = span(c); if (!sp) return; const d = sp.e - sp.s + 1; w += d; p += d * prog(c); });
  return { s, e, p: w ? Math.round(p / w) : 0 };
}
const byStart = (a, b) => { const x = span(a), y = span(b); return x.s - y.s || x.e - y.e || a.title.localeCompare(b.title); };

function groupsOf(items, pool, pre = '') {
  const g = S.group, groups = [];
  if (g === 'epic') {
    pool.filter(c => c.epic).forEach(ep => groups.push({ key: pre + 'e:' + ep.id, title: ep.title, card: ep, sub: 'Epic', items: items.filter(c => c.epicId === ep.id) }));
    const ids = new Set(S.all.filter(c => c.epic).map(c => c.id));
    groups.push({ key: pre + 'e:_', title: 'Tanpa epic', sub: '', items: items.filter(c => !c.epicId || !ids.has(c.epicId) || !pool.some(x => x.id === c.epicId)) });
  } else if (g === 'who') {
    (office().roles || []).filter(r => !r.archived).forEach(r => groups.push({ key: pre + 'w:' + r.id, title: r.name, role: r, sub: r.title || '', items: items.filter(c => c.who === r.id) }));
    groups.push({ key: pre + 'w:_', title: 'Belum ditugaskan', sub: '', items: items.filter(c => !c.who || !roleOf(c.who)) });
  } else if (g === 'repo') {
    const keys = [...new Set(items.map(c => c.repo || ''))].sort((a, b) => repoName(a).localeCompare(repoName(b)));
    keys.forEach(k => groups.push({ key: pre + 'r:' + k, title: repoName(k), sub: '', items: items.filter(c => (c.repo || '') === k) }));
  } else if (g === 'label') {
    S.labels.forEach(l => groups.push({ key: pre + 'l:' + l.id, title: l.name, color: l.color, sub: '', items: items.filter(c => (c.labels || [])[0] === l.id) }));
    groups.push({ key: pre + 'l:_', title: 'Tanpa label', sub: '', items: items.filter(c => !(c.labels || []).some(labelOf)) });
  } else groups.push({ key: pre + 'n', title: null, items });
  const list = groups.filter(x => x.items.length);
  if (g === 'epic' || g === 'repo') list.sort((a, b) => groupSummary(a.items).s - groupSummary(b.items).s);
  return list;
}
function pushGroups(list, depth) {
  for (const gr of list) {
    gr.items.sort(byStart);
    if (gr.title != null) S.rows.push({ type: 'g', g: gr, depth });
    if (gr.title != null && S.collapsed.has(gr.key)) continue;
    gr.items.forEach(c => { S.rowOf.set(c.id, S.rows.length); S.rows.push({ type: 't', c, g: gr, depth }); });
  }
}
function buildRows() {
  const items = scheduledAll().filter(passes);
  S.rows = []; S.rowOf = new Map(); S.ghosts = new Set();
  if (isAllB()) {
    // Semua papan: kelompok per papan dulu (bisa diciutkan, warna papan), lalu kelompok pilihan
    for (const b of S.boards) {
      const bi = items.filter(c => (c.board || 'utama') === b.id);
      if (!bi.length) continue;
      const head = { key: 'b:' + b.id, title: b.name, color: b.color, sub: 'Papan', items: bi, board: b };
      S.rows.push({ type: 'g', g: head, depth: 0 });
      if (S.collapsed.has(head.key)) continue;
      pushGroups(groupsOf(bi, S.all.filter(c => (c.board || 'utama') === b.id), b.id + '|'), 1);
    }
    return;
  }
  // dependensi dari papan lain: bar abu-abu samar di atas, supaya panah lintas papan tetap terbaca
  const mine = new Set(S.cards.map(c => c.id));
  const ghosts = [...new Set(items.flatMap(c => c.deps || []))].map(card).filter(d => d && !mine.has(d.id) && span(d));
  if (ghosts.length) {
    const gr = { key: 'x:ghost', title: 'Dari papan lain', sub: '', items: ghosts, ghost: true };
    ghosts.forEach(d => S.ghosts.add(d.id));
    pushGroups([gr], 0);
  }
  pushGroups(groupsOf(items, S.cards), 0);
}

/* ---------------- layout ---------------- */
const listW = () => $('.gt-list', S.sc)?.offsetWidth || (S.compact ? 150 : 300);
const viewW = () => Math.max(300, (S.sc?.clientWidth || 900) - listW());
const X = d => (d - S.lo) * S.dw;

function computeRange() {
  const all = [...scheduledAll(), ...[...S.ghosts].map(card).filter(Boolean)].map(span).filter(Boolean), t = today();
  let lo = Math.min(t, ...all.map(x => x.s)) - 7, hi = Math.max(t, ...all.map(x => x.e)) + 28;
  lo -= (dow(lo) + 6) % 7; // mundur ke Senin
  const days = Math.max(hi - lo + 1, Math.ceil(viewW() / S.dw) + 2);
  const prevLo = S.lo;
  S.lo = lo; S.days = days;
  return prevLo;
}

/* ---------------- render: chrome ---------------- */
function toolbarHTML() {
  const roles = (office().roles || []).filter(r => !r.archived);
  const seg = (arr, cur, act) => `<div class="seg" role="group">${arr.map(([k, v]) => `<button data-act="${act}" data-v="${k}" aria-pressed="${cur === k}">${v}</button>`).join('')}</div>`;
  const bl = S.boards.filter(b => !b.archived);
  const bsel = bl.length > 1 || S.board !== 'utama' ? `<label class="sr-only" for="gtBoard">Papan</label><select id="gtBoard" aria-label="Papan">${bl.map(b => `<option value="${esc(b.id)}" ${S.board === b.id ? 'selected' : ''}>${esc(b.icon || '')} ${esc(b.name)}</option>`).join('')}<option value="all" ${isAllB() ? 'selected' : ''}>Semua papan</option></select>` : '';
  return `<div class="gt-toolbar">
    ${bsel}
    ${seg(ZNAME, S.zoom, 'gt-zoom')}
    <button class="btn sm" data-act="gt-today">Hari ini</button>
    <span class="seg-l">Kelompok</span>${seg(GROUPS, S.group, 'gt-group')}
    <span class="seg-l">Warna</span>${seg([['col', 'Status'], ['who', 'Orang'], ...(S.boards.length > 1 ? [['board', 'Papan']] : [])], S.color, 'gt-color')}
  </div>
  <div class="gt-toolbar gt-filters">
    <select id="gtWho" aria-label="Filter orang"><option value="">Semua orang</option>${roles.map(r => `<option value="${esc(r.id)}" ${S.who === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="_none" ${S.who === '_none' ? 'selected' : ''}>Belum ditugaskan</option></select>
    <select id="gtLabel" aria-label="Filter label"><option value="">Semua label</option>${S.labels.map(l => `<option value="${esc(l.id)}" ${S.label === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
    <label class="gt-chk"><input type="checkbox" id="gtHide" ${S.hideDone ? 'checked' : ''}> Sembunyikan Selesai</label>
    <label class="gt-chk"><input type="checkbox" id="gtCrit" ${S.crit ? 'checked' : ''}> Jalur kritis</label>
    <button class="btn sm ghost" data-act="gt-compact" aria-pressed="${S.compact}" title="Persempit kolom daftar">${S.compact ? 'Lebarkan daftar' : 'Ciutkan daftar'}</button>
    <span class="gt-sumwrap" id="gtSum"></span>
  </div>`;
}
function summaryHTML() {
  const sc = scheduledAll(), od = sc.filter(overdue).length, cf = conflicts(), un = real().filter(c => !span(c)).length;
  return `<span class="gt-pill"><b>${sc.length}</b> terjadwal</span>`
    + `<span class="gt-pill ${od ? 'bad' : ''}"><b>${od}</b> terlambat</span>`
    + `<span class="gt-pill ${cf.length ? 'bad' : ''}"><b>${cf.length}</b> konflik</span>`
    + `<span class="gt-pill"><b>${un}</b> belum dijadwalkan</span>`
    + (cf.length ? `<button class="btn sm primary" data-act="gt-shift">Geser otomatis</button>` : '');
}

/* ---------------- render: grid ---------------- */
function segs(fromKey, labelFn) {
  const out = []; let cur = null;
  for (let d = S.lo; d < S.lo + S.days; d++) {
    const k = fromKey(d);
    if (!cur || cur.k !== k) { cur = { k, from: d, to: d }; out.push(cur); } else cur.to = d;
  }
  out.forEach(s => { s.label = labelFn(s); });
  return out;
}
function headHTML() {
  const W = S.days * S.dw, z = S.zoom, t = today();
  const top = (z === 'day' || z === 'week')
    ? segs(d => { const [y, m] = ymd(d); return y * 12 + m; }, s => { const w = (s.to - s.from + 1) * S.dw, [y, m] = ymd(s.from); return w >= 120 ? `${MONL[m]} ${y}` : w >= 56 ? `${MON[m]} ${y}` : w >= 26 ? MON[m] : ''; })
    : segs(d => ymd(d)[0], s => String(ymd(s.from)[0]));
  let bot;
  if (z === 'day') bot = segs(d => d, s => `<span>${DOWL[dow(s.from)]}</span><b>${ymd(s.from)[2]}</b>`);
  else if (z === 'week') bot = segs(d => Math.floor((d + 3) / 7), s => { const [, m, dd] = ymd(s.from); return `${dd} ${MON[m]}`; });
  else if (z === 'month') bot = segs(d => { const [y, m] = ymd(d); return y * 12 + m; }, s => { const w = (s.to - s.from + 1) * S.dw, m = ymd(s.from)[1]; return w >= 70 ? MONL[m] : MON[m]; });
  else bot = segs(d => { const [y, m] = ymd(d); return y * 4 + Math.floor(m / 3); }, s => 'Q' + (Math.floor(ymd(s.from)[1] / 3) + 1));
  const cell = (s, cls) => `<div class="gt-hc ${cls}" style="left:${X(s.from)}px;width:${(s.to - s.from + 1) * S.dw}px">${s.label}</div>`;
  const topH = top.map(s => cell(s, 'top')).join('');
  const botH = bot.map(s => cell(s, 'bot' + (z === 'day' ? ' dy' + (isWk(s.from) ? ' we' : '') + (s.from === t ? ' now' : '') : ''))).join('');
  return { html: `<div class="gt-th" style="width:${W}px"><div class="gt-tier t1">${topH}</div><div class="gt-tier t2">${botH}</div>${t >= S.lo && t < S.lo + S.days ? `<i class="gt-now-h" style="left:${X(t) + S.dw / 2}px"></i>` : ''}</div>`, bot, top };
}
function barHTML(c, i) {
  const sp = span(c), sel = S.sel === c.id, p = prog(c), cr = S.crit && S.cr.ids.has(c.id);
  const col = colorOf(c), ghost = S.ghosts.has(c.id);
  const cls = ['gt-bar', ghost && 'ghost', sp.pub && 'pub', sp.ms && 'ms', sp.der && 'der', overdue(c) && 'late', c.blocked && 'blocked', done(c) && 'done', sel && 'sel', cr && 'crit', S.conf.has(c.id) && 'conf', S.crit && !cr && 'dimmed'].filter(Boolean).join(' ');
  const w = (sp.e - sp.s + 1) * S.dw;
  const dates = sp.ms ? fmt(sp.s, true) : `${fmt(sp.s, true)} sampai ${fmt(sp.e, true)}`;
  const aria = `${c.title}. ${sp.pub ? 'Tayang ' : ''}${dates}. ${ghost ? `Papan ${boardOf(c.board)?.name || c.board}. ` : ''}Progres ${p}%.${overdue(c) ? ' Terlambat.' : ''}${c.blocked ? ' Terblokir.' : ''}`;
  const top = i * RH + BAR_T;
  // ◆ tanggal tayang untuk kartu yang juga punya jadwal kerja
  const pa = pd(c.publishAt), pub = pa != null && !sp.pub ? `<i class="gt-pubm${!done(c) && pa < today() ? ' late' : ''}" style="left:${X(pa) + S.dw / 2 - 7}px;top:${top + BAR_H / 2 - 7}px" title="Tayang ${esc(fmt(pa, true))}: ${esc(c.title)}"></i>` : '';
  if (sp.ms) {
    const cx = X(sp.s) + S.dw / 2;
    return pub + `<div class="${cls}" data-id="${esc(c.id)}" tabindex="${sel ? 0 : -1}" role="button" aria-label="${esc(aria)}" style="--bc:${col};left:${cx - 11}px;top:${top}px;width:22px;height:${BAR_H}px"><i class="gt-dia"></i><span class="gt-out">${esc(c.title)}</span><u class="gt-lk" title="Tarik ke kartu lain untuk membuat dependensi"></u></div>`;
  }
  const nar = w < Math.min(110, 12 + c.title.length * 6.3);
  const txt = `<span class="gt-bt">${esc(c.title)}</span>`;
  return pub + `<div class="${cls}${nar ? ' nar' : ''}" data-id="${esc(c.id)}" tabindex="${sel ? 0 : -1}" role="button" aria-label="${esc(aria)}" style="--bc:${col};left:${X(sp.s)}px;top:${top}px;width:${w}px;height:${BAR_H}px"><div class="gt-in"><i class="gt-fill" style="width:${p}%"></i>${stagesHTML(c, sp)}${nar ? '' : txt}</div>${nar ? `<span class="gt-out">${esc(c.title)}</span>` : ''}${overdue(c) ? '<em class="gt-late-b" title="Terlambat">!</em>' : ''}<b class="gt-rz l" title="Ubah tanggal mulai"></b><b class="gt-rz r" title="Ubah tenggat"></b><u class="gt-lk" title="Tarik ke kartu lain untuk membuat dependensi"></u></div>`;
}
/** Segmen tahap di bawah bar: kolom yang dilewati kartu (dari riwayat pindah), untuk papan yang punya alur review. */
function stagesHTML(c, sp) {
  const b = boardOf(c.board); if (!b || !b.columns.some(x => x.kind === 'review')) return '';
  const mv = (S.moves[c.id] || []).filter(m => m.toKind && (m.board || 'utama') === (c.board || 'utama'));
  if (mv.length < 2) return '';
  const span0 = sp.e - sp.s + 1, out = [];
  mv.forEach((m, k) => {
    const a = pd(String(m.at).slice(0, 10)), z = k + 1 < mv.length ? pd(String(mv[k + 1].at).slice(0, 10)) : Math.max(today(), a);
    const s = Math.max(a, sp.s), e = Math.min(z, sp.e);
    if (a == null || e < s) return;
    out.push(`<i class="gt-stg" style="left:${(s - sp.s) / span0 * 100}%;width:${Math.max(2, (e - s + 1) / span0 * 100)}%;background:${COLK[m.toKind] || 'var(--b6)'}" title="${esc(m.toName || KIND_LABEL[m.toKind])}: ${fmt(a)}"></i>`);
  });
  return out.length ? `<span class="gt-stgs">${out.join('')}</span>` : '';
}
function sumHTML(r, i) {
  const sm = groupSummary(r.g.items); if (!sm) return '';
  const w = (sm.e - sm.s + 1) * S.dw;
  return `<div class="gt-sum" data-g="${esc(r.g.key)}" style="left:${X(sm.s)}px;top:${i * RH + RH / 2 - 6}px;width:${w}px"><i style="width:${sm.p}%"></i></div><span class="gt-sum-l" data-gl="${esc(r.g.key)}" style="left:${X(sm.e + 1) + 8}px;top:${i * RH + RH / 2 - 9}px">${fmt(sm.s)} – ${fmt(sm.e)} · ${sm.p}%</span>`;
}
function listRowHTML(r) {
  if (r.type === 'g') {
    const g = r.g, open = !S.collapsed.has(g.key), sm = groupSummary(g.items);
    const av = g.role ? mini(g.role) : g.color ? `<i class="gt-dot" style="background:${esc(g.color)}"></i>` : '';
    return `<div class="gt-lr grp${g.board ? ' brd' : ''}${g.ghost ? ' ghost' : ''}${r.depth ? ' d' + r.depth : ''}" style="height:${RH}px${g.board ? `;--bc:${esc(g.color)}` : ''}"><button class="gt-chev" data-act="gt-fold" data-k="${esc(g.key)}" aria-expanded="${open}" aria-label="${open ? 'Ciutkan' : 'Buka'} ${esc(g.title)}"><svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>${av}<span class="gt-ltitle" title="${esc(g.title)}">${esc(g.title)}</span><span class="gt-cnt">${g.items.length}${sm ? ' · ' + sm.p + '%' : ''}</span></div>`;
  }
  const c = r.c, role = roleOf(c.who);
  const cc = COLK[kindOf(c)];
  return `<div class="gt-lr${S.ghosts.has(c.id) ? ' ghost' : ''}${S.sel === c.id ? ' sel' : ''}${S.group === 'epic' || S.group === 'none' ? '' : ' ind'}${S.group === 'epic' ? ' ind' : ''}" data-id="${esc(c.id)}" style="height:${RH}px"><span class="gt-ltitle" title="${esc(c.title)}">${c.milestone ? '<i class="gt-mdot"></i>' : ''}${esc(c.title)}</span>${role ? `<span class="gt-av" title="${esc(role.name)}">${mini(role)}</span>` : '<span class="gt-av none" title="Belum ditugaskan"></span>'}<span class="gt-chip" style="--cc:${cc}" title="${esc(c.colName || '')}${S.ghosts.has(c.id) || isAllB() ? ' · papan ' + esc(boardOf(c.board)?.name || c.board) : ''}"><i></i>${esc(c.colName || '')}</span><button class="gt-ed" data-act="gt-edit" data-id="${esc(c.id)}" aria-label="Atur jadwal ${esc(c.title)}" title="Atur jadwal (E)">&#9998;</button></div>`;
}

function gridHTML() {
  const { html: head, bot } = headHTML();
  const W = S.days * S.dw, H = S.rows.length * RH, t = today();
  S.cr = S.crit ? critical() : { ids: new Set(), edges: new Set() };
  S.conf = new Set(conflicts().map(x => x.to));
  let bg = '';
  S.rows.forEach((r, i) => { bg += `<div class="gt-band${r.type === 'g' ? ' grp' : ''}" style="top:${i * RH}px;height:${RH}px"></div>`; });
  let vl = '';
  bot.forEach(s => { vl += `<i class="gt-vl" style="left:${X(s.from)}px"></i>`; });
  if (S.zoom === 'week') for (let d = S.lo; d < S.lo + S.days; d++) if (dow(d) !== 1) vl += `<i class="gt-vl f" style="left:${X(d)}px"></i>`;
  let we = '';
  if (S.dw >= 4) for (let d = S.lo; d < S.lo + S.days; d++) if (dow(d) === 6) we += `<i class="gt-we" style="left:${X(d)}px;width:${2 * S.dw}px"></i>`;
  const now = t >= S.lo && t < S.lo + S.days ? `<i class="gt-now" style="left:${X(t) + S.dw / 2}px"></i>` : '';
  let bars = '';
  S.rows.forEach((r, i) => { bars += r.type === 'g' ? sumHTML(r, i) : barHTML(r.c, i); });
  const lrows = S.rows.map(listRowHTML).join('');
  return `<div class="gt-head" style="height:${HH}px"><div class="gt-corner"><span>Tugas</span></div>${head}</div>`
    + `<div class="gt-main"><div class="gt-list" role="rowgroup">${lrows}</div>`
    + `<div class="gt-chart" style="width:${W}px;height:${H}px">${bg}${we}${vl}${now}<svg class="gt-svg" width="${W}" height="${H}" aria-hidden="false"><defs>${['', ' bad', ' crit'].map(k => `<marker id="gtah${k.trim()}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="gt-ah${k}" d="M0 0 8 4 0 8z"/></marker>`).join('')}</defs><g id="gtArrows"></g><path id="gtTmp" class="gt-tmp" d=""/></svg>${bars}<div class="gt-dropcol" id="gtDrop" hidden></div></div></div>`;
}

/* panah finish -> start */
function rp(pts, r = 5) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x, y] = pts[i], [x1, y1] = pts[i + 1];
    const l1 = Math.hypot(x - x0, y - y0) || 1, l2 = Math.hypot(x1 - x, y1 - y) || 1, rr = Math.min(r, l1 / 2, l2 / 2);
    d += `L${x - (x - x0) / l1 * rr} ${y - (y - y0) / l1 * rr}Q${x} ${y} ${x + (x1 - x) / l2 * rr} ${y + (y1 - y) / l2 * rr}`;
  }
  return d + `L${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
}
function anchors(c) {
  const sp = span(c), i = S.rowOf.get(c.id), y = i * RH + RH / 2;
  if (sp.ms) { const cx = X(sp.s) + S.dw / 2; return { xl: cx - 11, xr: cx + 11, y }; }
  return { xl: X(sp.s), xr: X(sp.e + 1), y };
}
function drawArrows() {
  const g = $('#gtArrows', S.sc); if (!g) return;
  let out = '';
  const cf = new Set(conflicts().map(x => x.from + '>' + x.to));
  for (const c of real()) {
    if (!S.rowOf.has(c.id) || !span(c)) continue;
    for (const d of c.deps || []) {
      const p = card(d); if (!p || !S.rowOf.has(d) || !span(p)) continue;
      const a = anchors(p), b = anchors(c), key = d + '>' + c.id;
      let pts;
      if (b.xl >= a.xr + 20) { const xm = a.xr + 10; pts = [[a.xr, a.y], [xm, a.y], [xm, b.y], [b.xl - 1, b.y]]; }
      else {
        const ycc = a.y + (b.y < a.y ? -RH / 2 : RH / 2);
        pts = [[a.xr, a.y], [a.xr + 10, a.y], [a.xr + 10, ycc], [b.xl - 11, ycc], [b.xl - 11, b.y], [b.xl - 1, b.y]];
      }
      const bad = cf.has(key), crit = S.crit && S.cr.edges.has(key), k = bad ? ' bad' : crit ? ' crit' : '';
      const sel = S.sel && (S.sel === d || S.sel === c.id) ? ' hl' : '';
      const dd = rp(pts);
      out += `<g class="gt-dep${k}${sel}${S.crit && !crit && !bad ? ' dimmed' : ''}" data-from="${esc(d)}" data-to="${esc(c.id)}"><path class="gt-hit" d="${dd}"><title>${esc(p.title)} selesai, lalu ${esc(c.title)} mulai${bad ? ' (konflik jadwal)' : ''}</title></path><path class="gt-arrow" d="${dd}" marker-end="url(#gtah${k.trim()})"/></g>`;
    }
  }
  g.innerHTML = out;
}

function legendHTML() {
  const items = S.color === 'who'
    ? (office().roles || []).filter(r => !r.archived && real().some(c => c.who === r.id)).map(r => `<span class="gt-lg"><i style="background:${esc(r.color)}"></i>${esc(r.name)}</span>`).join('')
    : S.color === 'board' ? S.boards.filter(b => !b.archived).map(b => `<span class="gt-lg"><i style="background:${esc(b.color)}"></i>${esc(b.name)}</span>`).join('')
    : KINDS.map(k => `<span class="gt-lg"><i style="background:${COLK[k]}"></i>${KIND_LABEL[k]}</span>`).join('');
  return `<div class="gt-legend">${items}<span class="gt-lg"><i class="d late"></i>Terlambat</span><span class="gt-lg"><i class="d pubm"></i>Tanggal tayang</span>${S.ghosts.size ? '<span class="gt-lg"><i class="d ghost"></i>Dependensi papan lain</span>' : ''}<span class="gt-lg"><i class="d blk"></i>Terblokir</span><span class="gt-lg"><i class="d conf"></i>Konflik</span><span class="gt-keys">Bar dipilih: <kbd>←</kbd><kbd>→</kbd> geser, <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> durasi, <kbd>Enter</kbd> buka, <kbd>E</kbd> atur jadwal</span></div>`;
}
function unschedHTML() {
  const un = unscheduled();
  if (!un.length) return '';
  return `<section class="gt-un" aria-label="Belum dijadwalkan"><div class="gt-un-h"><h2>Belum dijadwalkan</h2><span class="hint">${un.length} kartu. Seret ke grid untuk menjadwalkan, atau klik &ldquo;Hari ini&rdquo;.</span></div><div class="gt-un-list">${un.map(c => {
    const role = roleOf(c.who);
    return `<div class="gt-uni" data-id="${esc(c.id)}"><span class="gt-grip" aria-hidden="true">&#8942;&#8942;</span>${role ? `<span class="gt-av">${mini(role)}</span>` : ''}<span class="gt-ut" title="${esc(c.title)}">${esc(c.title)}</span><span class="gt-ue">${c.estDays ? c.estDays + ' hr' : '2 hr'}</span><button class="btn sm ghost" data-act="gt-sched" data-id="${esc(c.id)}">Hari ini</button></div>`;
  }).join('')}</div></section>`;
}
function emptyHTML() {
  return `<div class="gt-empty"><svg viewBox="0 0 120 64" width="120" height="64" aria-hidden="true"><rect x="4" y="8" width="52" height="12" rx="6" fill="var(--accent-soft)" stroke="var(--accent)"/><rect x="32" y="26" width="60" height="12" rx="6" fill="var(--teal-soft)" stroke="var(--teal)"/><rect x="70" y="44" width="44" height="12" rx="6" fill="var(--surface-2)" stroke="var(--muted-2)"/><path d="M56 14h8q4 0 4 4v4M92 32h6q4 0 4 4v4" fill="none" stroke="var(--muted-2)" stroke-dasharray="3 3"/></svg>
    <h2>${scheduledAll().length ? 'Tidak ada kartu yang cocok dengan filter' : 'Belum ada kartu yang dijadwalkan'}</h2>
    ${scheduledAll().length ? '<p>Longgarkan filter orang, label, atau tampilkan kartu Selesai.</p>' : `<p>Timeline membaca tanggal dari kartu. Cara mengisinya:</p>
    <ol><li>Seret kartu dari daftar <b>Belum dijadwalkan</b> di bawah ke grid ini.</li><li>Atau buka kartu di <a href="#/o/${esc(S.oid)}/board">Board</a> dan isi <b>Mulai</b> dan <b>Tenggat</b>.</li><li>Agen bisa mengaturnya lewat MCP <code>card_update</code> dengan <code>start</code>, <code>due</code>, <code>est_days</code>, dan <code>deps</code> (dependensi).</li></ol>`}</div>`;
}

/* ---------------- paint ---------------- */
function paintGrid() {
  const sc = S.sc; if (!sc) return;
  buildRows();
  const sl = sc.scrollLeft, st = sc.scrollTop, fid = document.activeElement?.closest?.('.gt-bar')?.dataset.id;
  const prevLo = S.lo;
  computeRange();
  const wrap = S.el.querySelector('.gt-board');
  if (!S.rows.length) { sc.innerHTML = ''; wrap.classList.add('is-empty'); $('.gt-emptyslot', S.el).innerHTML = emptyHTML(); return; }
  wrap.classList.remove('is-empty'); $('.gt-emptyslot', S.el).innerHTML = '';
  sc.innerHTML = gridHTML();
  drawArrows();
  sc.scrollLeft = sl + (prevLo ? (prevLo - S.lo) * S.dw : 0); sc.scrollTop = st;
  if (fid) $(`.gt-bar[data-id="${CSS.escape(fid)}"]`, sc)?.focus({ preventScroll: true });
}
function paintChrome() {
  $('#gtSum', S.el).innerHTML = summaryHTML();
  $('.gt-unslot', S.el).innerHTML = unschedHTML();
  $('.gt-legendslot', S.el).innerHTML = legendHTML();
}
function paintAll() {
  const sl = S.sc?.scrollLeft;
  S.el.innerHTML = `${toolbarHTML()}<div class="gt-board${S.compact ? ' compact' : ''}"><div class="gt-scroll" id="gtScroll" tabindex="-1"></div><div class="gt-emptyslot"></div></div><div class="gt-legendslot"></div><div class="gt-unslot"></div>`;
  S.sc = $('#gtScroll', S.el);
  paintGrid(); paintChrome();
  if (sl != null) S.sc.scrollLeft = sl;
}
function refresh() { paintGrid(); paintChrome(); }

function scrollToDay(d, smooth = true, frac = 0.3) {
  const x = (d - S.lo) * S.dw - viewW() * frac;
  S.sc.scrollTo({ left: Math.max(0, x), behavior: smooth ? 'smooth' : 'auto' });
}

/* ---------------- mutasi ---------------- */
function commit(id, fields, { quiet } = {}) {
  const c = card(id); if (!c) return Promise.resolve(false);
  const old = {}; Object.keys(fields).forEach(k => { old[k] = Array.isArray(c[k]) ? [...c[k]] : c[k]; });
  Object.assign(c, fields); S.ov = {};
  refresh();
  S.busy++;
  const run = S.chain.then(() => patch(`${base()}/cards/${id}`, fields));
  S.chain = run.catch(() => {});
  return run.then(() => true, e => { Object.assign(c, old); refresh(); toast(e.message || 'Gagal menyimpan jadwal', 'bad'); return false; })
    .finally(() => { S.busy--; if (quiet) return; });
}
async function addDep(from, to) {
  const t = card(to), f = card(from);
  if (!t || !f || from === to) return;
  if ((t.deps || []).includes(from)) return toast('Dependensi itu sudah ada', '');
  if (wouldCycle(from, to)) return toast('Dependensi melingkar ditolak', 'bad');
  const ok = await commit(to, { deps: [...(t.deps || []), from] });
  if (ok) {
    const a = span(f), b = span(t);
    if (a && b && b.s <= a.e) toast(`"${t.title}" mulai sebelum "${f.title}" selesai. Pakai Geser otomatis untuk merapikan.`, '');
    else toast('Dependensi dibuat');
  }
}
function removeDep(from, to) {
  const t = card(to), f = card(from); if (!t || !f) return;
  const bad = conflicts().some(x => x.from === from && x.to === to);
  const del = () => commit(to, { deps: (t.deps || []).filter(d => d !== from) }).then(ok => ok && toast('Dependensi dihapus'));
  const body = `&ldquo;${esc(t.title)}&rdquo; tidak lagi menunggu &ldquo;${esc(f.title)}&rdquo;.`;
  if (!bad) return confirmDo('Hapus dependensi?', body, 'Hapus', del);
  modal({ title: 'Konflik jadwal', body: `&ldquo;${esc(t.title)}&rdquo; mulai sebelum &ldquo;${esc(f.title)}&rdquo; selesai.`, actions: [
    { label: 'Geser otomatis', kind: 'primary', fn: () => { autoShift(); } },
    { label: 'Hapus dependensi', kind: 'danger', fn: () => { del(); } },
    { label: 'Batal' }] });
}
function autoShift() {
  const plan = planShift();
  if (!plan.size) return toast('Tidak ada konflik untuk digeser');
  const jobs = [];
  for (const [id, delta] of plan) {
    const c = card(id), sp = span(c), f = {};
    if (c.milestone) { f.start = fd(sp.s + delta); f.due = fd(sp.e + delta); }
    else { if (c.start) f.start = fd(pd(c.start) + delta); if (c.due) f.due = fd(pd(c.due) + delta); }
    jobs.push([id, f]);
  }
  Promise.all(jobs.map(([id, f]) => commit(id, f))).then(r => {
    const n = r.filter(Boolean).length;
    toast(`${n} kartu digeser`);
    if (n !== jobs.length) fetchBoard().then(refresh).catch(() => {});
  });
}
function schedule(id, startDay) {
  const c = card(id); if (!c) return;
  const e = endFrom(startDay, Math.max(1, c.estDays || 2));
  commit(id, c.milestone ? { start: fd(startDay), due: fd(startDay) } : { start: fd(startDay), due: fd(e) }).then(ok => ok && toast(`"${c.title}" dijadwalkan ${fmt(startDay)}`));
}

/* ---------------- seleksi, popover ---------------- */
function select(id, focus) {
  S.sel = id;
  $$('.gt-bar.sel,.gt-lr.sel', S.sc).forEach(e => e.classList.remove('sel'));
  $$('.gt-bar,.gt-lr', S.sc).forEach(e => { if (e.dataset.id === id) e.classList.add('sel'); if (e.classList.contains('gt-bar')) e.tabIndex = e.dataset.id === id ? 0 : -1; });
  $$('.gt-dep', S.sc).forEach(g => g.classList.toggle('hl', !!id && (g.dataset.from === id || g.dataset.to === id)));
  if (focus) $(`.gt-bar[data-id="${CSS.escape(id)}"]`, S.sc)?.focus({ preventScroll: true });
}
function openCard(id) { location.hash = `#/o/${S.oid}/board/${id}`; }
function closePop() { S.pop?.remove(); S.pop = null; }
function openEdit(id) {
  closePop();
  const c = card(id); if (!c) return;
  const sp = span(c), p = document.createElement('div');
  p.className = 'gt-pop'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Atur jadwal');
  p.innerHTML = `<h3>${esc(c.title)}</h3>
    <label>Mulai<input type="date" id="gpS" value="${sp ? fd(sp.s) : ''}"></label>
    <label>${c.milestone ? 'Tanggal' : 'Tenggat'}<input type="date" id="gpE" value="${sp ? fd(sp.e) : ''}"></label>
    ${c.milestone ? '' : `<label>Estimasi (hari kerja)<input type="number" min="0" max="365" id="gpN" value="${c.estDays ?? ''}"></label>
    <label>Progres (%)<input type="number" min="0" max="100" id="gpP" value="${c.progress ?? ''}" placeholder="${prog(c)}"></label>`}
    <div class="btn-row"><button class="btn sm primary" data-pop="save">Simpan</button><button class="btn sm" data-pop="open">Buka kartu</button>${sp ? '<button class="btn sm danger" data-pop="clear">Hapus jadwal</button>' : ''}<button class="btn sm ghost" data-pop="close">Tutup</button></div>`;
  document.body.appendChild(p); S.pop = p;
  const anchor = $(`.gt-bar[data-id="${CSS.escape(id)}"]`, S.sc) || $(`.gt-lr[data-id="${CSS.escape(id)}"]`, S.sc);
  const r = anchor ? anchor.getBoundingClientRect() : { left: 80, bottom: 120, top: 100 };
  const w = 280, h = p.offsetHeight;
  p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
  p.style.top = (r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8) + 'px';
  $('#gpS', p).focus();
  p.addEventListener('click', e => {
    const b = e.target.closest('[data-pop]'); if (!b) return;
    const a = b.dataset.pop;
    if (a === 'close') return closePop();
    if (a === 'open') { closePop(); return openCard(id); }
    if (a === 'clear') { closePop(); return commit(id, { start: '', due: '' }); }
    const f = {}, s = $('#gpS', p).value, d = $('#gpE', p).value;
    if (s && d && d < s) return toast('Tenggat tidak boleh sebelum tanggal mulai', 'bad');
    if (c.milestone) { const v = d || s; if (v) { f.start = v; f.due = v; } }
    else {
      if (s !== (sp && !sp.der ? fd(sp.s) : c.start || '') || (s && !c.start)) f.start = s;
      if (d !== (sp && !sp.der ? fd(sp.e) : c.due || '') || (d && !c.due)) f.due = d;
      const n = $('#gpN', p).value, pr = $('#gpP', p).value;
      if (String(c.estDays ?? '') !== n) f.estDays = n === '' ? null : Number(n);
      if (String(c.progress ?? '') !== pr) f.progress = pr === '' ? null : Number(pr);
    }
    closePop();
    if (Object.keys(f).length) commit(id, f);
  });
  p.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); $(`.gt-bar[data-id="${CSS.escape(id)}"]`, S.sc)?.focus(); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('[data-pop=save]', p).click(); });
}

/* ---------------- drag ---------------- */
const tip = txt => {
  let t = $('#gtTip');
  if (!txt) return t?.remove();
  if (!t) { t = document.createElement('div'); t.id = 'gtTip'; t.className = 'gt-tip'; document.body.appendChild(t); }
  t.textContent = txt; return t;
};
function placeBar(id) {
  const c = card(id), sp = span(c), el = $(`.gt-bar[data-id="${CSS.escape(id)}"]`, S.sc); if (!el || !sp) return;
  if (sp.ms) { el.style.left = X(sp.s) + S.dw / 2 - 11 + 'px'; return; }
  el.style.left = X(sp.s) + 'px'; el.style.width = (sp.e - sp.s + 1) * S.dw + 'px';
}
function updateGroups() {
  for (const r of S.rows) {
    if (r.type !== 'g') continue;
    const sm = groupSummary(r.g.items), el = $(`.gt-sum[data-g="${CSS.escape(r.g.key)}"]`, S.sc), lb = $(`[data-gl="${CSS.escape(r.g.key)}"]`, S.sc);
    if (!sm || !el) continue;
    el.style.left = X(sm.s) + 'px'; el.style.width = (sm.e - sm.s + 1) * S.dw + 'px';
    if (lb) { lb.style.left = X(sm.e + 1) + 8 + 'px'; lb.textContent = `${fmt(sm.s)} – ${fmt(sm.e)} · ${sm.p}%`; }
  }
}
function chartRect() { return $('.gt-chart', S.sc).getBoundingClientRect(); }

function onDown(e) {
  if (e.button !== 0 || S.D) return;
  const t = e.target;
  if (t.closest('.gt-pop,[data-act],button,a,input,select')) return;
  const un = t.closest('.gt-uni');
  if (un) { e.preventDefault(); startDrag({ mode: 'sched', id: un.dataset.id, e, ghost: un }); return; }
  const bar = t.closest('.gt-bar');
  if (!bar || !S.sc.contains(bar)) { if (t.closest('.gt-chart') && !t.closest('.gt-dep')) { select(null); } return; }
  const id = bar.dataset.id, c = card(id), sp = span(c);
  select(id);
  closePop();
  if (S.ghosts.has(id)) return; // kartu papan lain: hanya ditampilkan
  const mode = t.closest('.gt-lk') ? 'link' : t.closest('.gt-rz.l') ? 'rl' : t.closest('.gt-rz.r') ? 'rr' : 'move';
  startDrag({ mode, id, e, sp0: { s: sp.s, e: sp.e }, bar });
  if (mode !== 'move') e.preventDefault();
}
function startDrag(d) {
  d.x0 = d.e.clientX; d.y0 = d.e.clientY; d.sl0 = S.sc.scrollLeft; d.moved = false; d.cx = d.x0; d.cy = d.y0;
  S.D = d;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
function endDrag() {
  const d = S.D; S.D = null;
  window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel);
  cancelAnimationFrame(S.auto); S.auto = 0;
  tip(null);
  document.body.classList.remove('gt-dragging');
  $$('.dragging,.gt-target', S.sc).forEach(x => x.classList.remove('dragging', 'gt-target'));
  const dc = $('#gtDrop', S.sc); if (dc) dc.hidden = true;
  $('.gt-ghost')?.remove();
  const tp = $('#gtTmp', S.sc); if (tp) tp.setAttribute('d', '');
  return d;
}
function applyDrag() {
  const d = S.D; if (!d || !d.moved) return;
  const dxDays = Math.round((d.cx - d.x0 + (S.sc.scrollLeft - d.sl0)) / S.dw);
  const c = card(d.id);
  if (d.mode === 'move' || d.mode === 'rl' || d.mode === 'rr') {
    let { s, e } = d.sp0;
    if (d.mode === 'move' || c.milestone) { s += dxDays; e += dxDays; }
    else if (d.mode === 'rl') s = Math.min(s + dxDays, e);
    else e = Math.max(e + dxDays, s);
    S.ov[d.id] = { s, e }; d.cur = { s, e };
    placeBar(d.id); updateGroups(); drawArrows();
    tip(c.milestone ? fmt(s, true) : `${fmt(s)} → ${fmt(e)} · ${e - s + 1} hari`)?.setAttribute('style', `left:${d.cx + 14}px;top:${d.cy + 16}px`);
  } else if (d.mode === 'link') {
    const a = anchors(c), r = chartRect(), x = d.cx - r.left, y = d.cy - r.top;
    $('#gtTmp', S.sc).setAttribute('d', `M${a.xr} ${a.y}C${a.xr + 40} ${a.y} ${x - 40} ${y} ${x} ${y}`);
    const tgt = targetAt(d.cx, d.cy, d.id);
    $$('.gt-target', S.sc).forEach(x2 => x2.classList.remove('gt-target'));
    if (tgt) tgt.classList.add('gt-target');
    tip(tgt ? `${c.title} → ${card(tgt.dataset.id).title}` : 'Lepas di atas bar lain untuk membuat dependensi')?.setAttribute('style', `left:${d.cx + 14}px;top:${d.cy + 16}px`);
  }
}
function targetAt(x, y, self) {
  for (const el of document.elementsFromPoint(x, y)) {
    const b = el.closest?.('.gt-bar');
    if (b && b.dataset.id !== self && S.sc.contains(b)) return b;
  }
  return null;
}
function onMove(e) {
  const d = S.D; if (!d) return;
  d.cx = e.clientX; d.cy = e.clientY;
  if (!d.moved && Math.hypot(d.cx - d.x0, d.cy - d.y0) < 4) return;
  if (!d.moved) {
    d.moved = true; document.body.classList.add('gt-dragging'); d.bar?.classList.add('dragging');
    if (d.mode === 'sched') {
      const g = d.ghost.cloneNode(true); g.classList.add('gt-ghost'); g.style.width = d.ghost.offsetWidth + 'px'; document.body.appendChild(g); d.g = g;
    }
  }
  if (d.mode === 'sched') {
    d.g.style.left = d.cx - 20 + 'px'; d.g.style.top = d.cy - 14 + 'px';
    const day = dropDay(d);
    const dc = $('#gtDrop', S.sc);
    if (day != null) { dc.hidden = false; dc.style.left = X(day) + 'px'; dc.style.width = S.dw + 'px'; tip(`Mulai ${fmt(day, true)}`)?.setAttribute('style', `left:${d.cx + 16}px;top:${d.cy + 22}px`); }
    else { dc.hidden = true; tip(null); }
  } else applyDrag();
  // gulir otomatis di tepi
  const r = S.sc.getBoundingClientRect(), lw = listW();
  const edge = d.cx > r.right - 50 ? 1 : d.cx < r.left + lw + 40 && d.mode !== 'link' ? -1 : 0;
  d.edge = edge;
  if (edge && !S.auto) {
    const loop = () => { if (!S.D || !S.D.edge) { S.auto = 0; return; } S.sc.scrollLeft += S.D.edge * 14; if (S.D.mode !== 'sched') applyDrag(); S.auto = requestAnimationFrame(loop); };
    S.auto = requestAnimationFrame(loop);
  }
}
function dropDay(d) {
  const r = S.sc.getBoundingClientRect(), cr = chartRect();
  if (d.cx < r.left + listW() || d.cx > r.right || d.cy < r.top + HH || d.cy > r.bottom) return null;
  return S.lo + Math.floor((d.cx - cr.left) / S.dw);
}
function onUp() {
  const d0 = S.D; if (!d0) return;
  const day = d0.mode === 'sched' && d0.moved ? dropDay(d0) : null;
  const tgt = d0.mode === 'link' && d0.moved ? targetAt(d0.cx, d0.cy, d0.id) : null;
  const d = endDrag();
  if (d.mode === 'sched') { if (day != null) schedule(d.id, day); return; }
  if (!d.moved) { S.ov = {}; return; }
  if (d.mode === 'link') { if (tgt) addDep(d.id, tgt.dataset.id); return; }
  const cur = d.cur, c = card(d.id);
  if (!cur || (cur.s === d.sp0.s && cur.e === d.sp0.e)) { S.ov = {}; refresh(); return; }
  commit(d.id, dateFields(c, cur.s, cur.e));
  S.suppressClick = true; setTimeout(() => { S.suppressClick = false; }, 0);
}
function onCancel() { endDrag(); S.ov = {}; refresh(); }

/* ---------------- event wiring ---------------- */
function zoomTo(z) {
  if (!ZOOM[z] || z === S.zoom) return;
  const vw = viewW(), center = S.lo + (S.sc.scrollLeft + vw / 2) / S.dw, from = S.dw, to = ZOOM[z];
  S.zoom = z; savePrefs();
  $$('[data-act="gt-zoom"]', S.el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === z)));
  cancelAnimationFrame(S.raf);
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 220), ez = 1 - Math.pow(1 - k, 3);
    S.dw = from * Math.pow(to / from, ez);
    paintGrid();
    S.sc.scrollLeft = Math.max(0, (center - S.lo) * S.dw - vw / 2);
    if (k < 1) S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
}
function bind() {
  const el = S.el;
  const h = {
    down: onDown,
    click: e => {
      const t = e.target;
      const b = t.closest('[data-act]');
      if (b && el.contains(b)) {
        const a = b.dataset.act;
        if (a === 'gt-zoom') zoomTo(b.dataset.v);
        else if (a === 'gt-today') scrollToDay(today(), true, 0.35);
        else if (a === 'gt-group') { S.group = b.dataset.v; savePrefs(); paintAll(); }
        else if (a === 'gt-color') { S.color = b.dataset.v; savePrefs(); paintAll(); }
        else if (a === 'gt-compact') { S.compact = !S.compact; savePrefs(); paintAll(); }
        else if (a === 'gt-shift') confirmDo('Geser otomatis?', `${planShift().size} kartu penerus digeser maju supaya mulai tepat setelah pendahulunya selesai. Durasi tetap.`, 'Geser', autoShift, '');
        else if (a === 'gt-fold') { const k = b.dataset.k; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); savePrefs(); paintGrid(); }
        else if (a === 'gt-edit') { select(b.dataset.id); openEdit(b.dataset.id); }
        else if (a === 'gt-sched') schedule(b.dataset.id, today());
        return;
      }
      const dep = t.closest('.gt-dep');
      if (dep && el.contains(dep)) { removeDep(dep.dataset.from, dep.dataset.to); return; }
      const lr = t.closest('.gt-lr[data-id]');
      if (lr) { select(lr.dataset.id); const sp = span(card(lr.dataset.id)); if (sp) { const x = X(sp.s), v = S.sc.scrollLeft; if (x < v || x > v + viewW() - 40) scrollToDay(sp.s - 2, true, 0.1); } }
    },
    dbl: e => {
      const x = e.target.closest('.gt-bar[data-id],.gt-lr[data-id]');
      if (x && !e.target.closest('button')) { e.preventDefault(); openCard(x.dataset.id); }
    },
    change: e => {
      const t = e.target;
      if (t.id === 'gtBoard') { S.board = t.value; try { localStorage.setItem(LSB(S.oid), S.board); } catch {} S.cards = isAllB() ? S.all : S.all.filter(c => (c.board || 'utama') === S.board); S.sel = null; if (S.color === 'board' && !isAllB()) S.color = 'col'; paintAll(); return; }
      if (t.id === 'gtWho') S.who = t.value; else if (t.id === 'gtLabel') S.label = t.value;
      else if (t.id === 'gtHide') S.hideDone = t.checked; else if (t.id === 'gtCrit') S.crit = t.checked; else return;
      savePrefs(); refresh();
    },
    key: e => {
      const bar = e.target.closest?.('.gt-bar');
      if (!bar || !S.sc.contains(bar)) return;
      const id = bar.dataset.id, c = card(id), sp = span(c);
      if (e.key === 'Enter') { e.preventDefault(); openCard(id); }
      else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openEdit(id); }
      else if (e.key === 'Escape') { select(null); bar.blur(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dd = e.key === 'ArrowLeft' ? -1 : 1;
        let s = sp.s, en = sp.e;
        if (e.shiftKey && !c.milestone) { if (e.altKey) s = Math.min(s + dd, en); else en = Math.max(en + dd, s); } else { s += dd; en += dd; }
        if (S.ghosts.has(id)) return;
        commit(id, dateFields(c, s, en)).then(() => $(`.gt-bar[data-id="${CSS.escape(id)}"]`, S.sc)?.focus({ preventScroll: true }));
        const x = X(s) - S.sc.scrollLeft; if (x < 20 || x > viewW() - 60) scrollToDay(s - 3, false, 0.2);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let i = S.rowOf.get(id) + (e.key === 'ArrowDown' ? 1 : -1);
        while (S.rows[i] && S.rows[i].type !== 't') i += e.key === 'ArrowDown' ? 1 : -1;
        const r = S.rows[i]; if (r) { select(r.c.id, true); $(`.gt-bar[data-id="${CSS.escape(r.c.id)}"]`, S.sc)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      }
    },
    docKey: e => { if (e.key === 'Escape' && S.pop) closePop(); },
    docDown: e => { if (S.pop && !S.pop.contains(e.target) && !e.target.closest('[data-act="gt-edit"]')) closePop(); },
    resize: () => { if (S.sc && !S.D) paintGrid(); },
  };
  S.handlers = h;
  el.addEventListener('pointerdown', h.down);
  el.addEventListener('click', h.click);
  el.addEventListener('dblclick', h.dbl);
  el.addEventListener('change', h.change);
  el.addEventListener('keydown', h.key);
  document.addEventListener('keydown', h.docKey);
  document.addEventListener('pointerdown', h.docDown, true);
  window.addEventListener('resize', h.resize);
}
function unbind() {
  const h = S.handlers; if (!h) return;
  S.el?.removeEventListener('pointerdown', h.down); S.el?.removeEventListener('click', h.click); S.el?.removeEventListener('dblclick', h.dbl);
  S.el?.removeEventListener('change', h.change); S.el?.removeEventListener('keydown', h.key);
  document.removeEventListener('keydown', h.docKey); document.removeEventListener('pointerdown', h.docDown, true);
  window.removeEventListener('resize', h.resize);
  window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel);
  S.handlers = null;
}

/* ---------------- modul ---------------- */
export async function render(el, ctx) {
  unbind(); closePop();
  Object.assign(S, { ctx, el, oid: ctx.office.id, cards: [], all: [], boards: [], moves: {}, ghosts: new Set(), sel: null, ov: {}, D: null, busy: 0, lo: 0, first: true });
  S.zoom = 'week'; S.group = 'epic'; S.color = 'col'; S.who = ''; S.label = ''; S.hideDone = false; S.crit = false; S.compact = false; S.collapsed = new Set();
  loadPrefs();
  el.innerHTML = '<p class="empty-line">Memuat timeline…</p>';
  try { await fetchBoard(); } catch (e) { el.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  el.classList.add('gt-root');
  paintAll(); bind();
  if (S.rows.length) { const sp = scheduledAll().map(span); const first = Math.min(...sp.map(x => x.s)); scrollToDay(Math.min(today() - 6, Math.max(first, today() - 24)), false, 0); }
}

function schedRefetch() {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    if (!S.el) return;
    if (S.D || S.busy || S.pop) { schedRefetch(); return; }
    try { await fetchBoard(); refresh(); } catch {}
  }, 250);
}
export function live(msg, ctx) {
  if (!S.el || !S.oid) return;
  if (ctx) S.ctx = ctx;
  if ((msg.t === 'changed' && msg.what === 'board' && (msg.office === S.oid || msg.office === '*')) || msg.t === 'reconnected') schedRefetch();
}
export function unmount() {
  unbind(); closePop(); tip(null);
  clearTimeout(S.timer); cancelAnimationFrame(S.raf);
  document.body.classList.remove('gt-dragging');
  S.el?.classList.remove('gt-root');
  S.el = null; S.oid = null; S.sc = null;
}
