// Tab Performa: pemantau PC tempat daemon berjalan. Datanya dari /api/sysmon (sama dengan halaman Performa PC di Ghina).
// Selama tab terbuka dan terlihat, snapshot diambil tiap 5 dtk; permintaan itu sendiri menjaga sampler tetap di laju penuh.
import { $, esc, num, api, toast, debounce } from './util.js';

const RANGES = [[10, '10 mnt'], [60, '1 jam'], [360, '6 jam'], [1440, '24 jam']];
const SERIES = 'cpu,user,sys,ram,swap,comp,rx,tx,dr,dw,gpu,batt,agents,load,score,cores';
const TOPS = [['cpu', 'CPU'], ['ram', 'RAM'], ['power', 'Energi'], ['net', 'Jaringan'], ['gpu', 'GPU']];
let root = null, S = null, H = null, P = null, EV = null;
let range = 60, sort = 'cpu', allProcs = false, topKey = 'cpu', q = '';
const openGroups = new Set();
let timers = [], loading = false;
let halfW = 560, fullW = 1160; // lebar isi kartu dalam px, supaya teks grafik tidak ikut membesar
const onResize = debounce(() => draw(), 200);

export async function render(el) {
  root = el;
  el.onclick = onClick; el.oninput = onInput;
  el.innerHTML = '<p class="empty-line">Memuat performa PC…</p>';
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', onResize);
  await loadAll();
  start();
}
export function unmount() {
  stop();
  document.removeEventListener('visibilitychange', onVis);
  window.removeEventListener('resize', onResize);
  if (root) root.onclick = root.oninput = null;
  root = null;
}
export function live(m) { if (m.t === 'reconnected' && root) loadAll(); }

function start() {
  stop();
  timers = [setInterval(() => loadSnap(), 5000), setInterval(() => loadProcs(), 10000), setInterval(() => loadHist(), range <= 60 ? 5000 : 60000), setInterval(() => loadEvents(), 30000)];
}
function stop() { timers.forEach(clearInterval); timers = []; }
function onVis() { if (!root) return; if (document.hidden) stop(); else { loadAll(); start(); } }

async function get(path) { try { return await api(path); } catch (e) { if (root && !S) root.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return null; } }
async function loadSnap() { const s = await get('/api/sysmon?min=10&series=cpu'); if (s) { S = s; draw(); } }
async function loadHist() { const h = await get(`/api/sysmon/history?min=${range}&series=${SERIES}&points=240`); if (h) { H = h; draw(); } }
async function loadProcs() { const p = await get(`/api/sysmon/procs${allProcs ? '?all=1' : ''}`); if (p) { P = p; draw(); } }
async function loadEvents() { const e = await get('/api/sysmon/events?limit=80'); if (e) { EV = e.events; draw(); } }
async function loadAll() {
  if (loading) return;
  loading = true;
  try { await Promise.all([loadSnap(), loadHist(), loadProcs(), loadEvents()]); } finally { loading = false; }
}

/* ---------------- format ---------------- */
const dec = (v, d = 1) => v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(d).replace('.', ',');
const pct = (v, d = 1) => { if (v == null) return '–'; const r = Math.round(v * 10 ** d) / 10 ** d; return `${dec(r, Number.isInteger(r) ? 0 : d)}%`; };
function bytes(v) {
  if (v == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; v = Number(v);
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? Math.round(v) : dec(v)} ${u[i]}`;
}
const rate = v => v == null ? '–' : `${bytes(v)}/dtk`;
function dur(sec) {
  if (sec == null) return '–';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} hari ${h} jam` : h ? `${h} jam ${m} mnt` : `${m} mnt`;
}
const clock = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`; };
const agoS = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} dtk lalu` : s < 3600 ? `${Math.round(s / 60)} mnt lalu` : `${clock(t)}`; };
const lvl = (p, warn = 75, bad = 90) => p == null ? '' : p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok';
const STATUS_LVL = { baik: 'ok', waspada: 'warn', buruk: 'bad' };
const PRESSURE_LVL = { normal: 'ok', waspada: 'warn', kritis: 'bad' };
const empty = t => `<p class="empty-line">${esc(t)}</p>`;
const last = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const peak = a => { const v = (a || []).filter(x => x != null); return v.length ? Math.max(...v) : null; };
const mean = a => { const v = (a || []).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

/* ---------------- kecil: meter, kpi, kartu ---------------- */
const meter = (p, cls = lvl(p)) => `<span class="sy-meter ${cls}"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></span>`;
const kv = rows => `<dl class="sy-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const card = (title, body, { sub = '', wide = false, id = '' } = {}) => `<section class="card sy-card${wide ? ' wide' : ''}"${id ? ` id="${id}"` : ''}><div class="sy-card-h"><h3>${esc(title)}</h3>${sub ? `<span class="hint">${sub}</span>` : ''}</div>${body}</section>`;
function stat(label, value, { p = null, cls = lvl(p), hint = '', href = '' } = {}) {
  return `<button type="button" class="sy-stat ${cls}"${href ? ` data-jump="${href}"` : ''}><span class="sy-stat-l">${esc(label)}</span><b>${value}</b>${p != null ? meter(p, cls) : ''}${hint ? `<small>${hint}</small>` : ''}</button>`;
}

/* ---------------- grafik garis (SVG) ---------------- */
function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
/** lines: [{v:[], color, label, fill?}]  fmt: angka sumbu Y */
function chart(lines, { max = null, fmt = v => dec(v, 0), h = 150, label = 'grafik', wide = false } = {}) {
  const t = H?.t || [];
  if (t.length < 2 || !lines.some(l => (l.v || []).some(x => x != null))) return empty('Riwayat belum cukup. Biarkan tab ini terbuka sebentar.');
  const W = Math.max(240, wide ? fullW : halfW), L = 46, R = 8, T = 8, B = 20, cw = W - L - R, ch = h - T - B;
  const top = max ?? niceMax(Math.max(...lines.flatMap(l => (l.v || []).filter(x => x != null)), 0) * 1.08);
  const x = i => L + (i / (t.length - 1)) * cw, y = v => T + ch - (Math.min(v, top) / top) * ch;
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${T + ch * (1 - f)}" y2="${T + ch * (1 - f)}" class="sy-gl"/><text x="${L - 6}" y="${T + ch * (1 - f) + 4}" text-anchor="end">${esc(fmt(top * f))}</text>`).join('');
  const xs = [0, Math.floor((t.length - 1) / 2), t.length - 1].map((i, k) => `<text x="${x(i)}" y="${h - 5}" text-anchor="${['start', 'middle', 'end'][k]}">${clock(t[i])}</text>`).join('');
  const paths = lines.map(l => {
    let d = '', area = '', run = [];
    const flush = () => { if (run.length > 1 && l.fill) area += `M${run[0][0]},${T + ch}L${run.map(p => p.join(',')).join('L')}L${run[run.length - 1][0]},${T + ch}Z`; run = []; };
    (l.v || []).forEach((v, i) => {
      if (v == null) { flush(); return; }
      const p = [x(i).toFixed(1), y(v).toFixed(1)];
      d += (run.length ? 'L' : 'M') + p.join(',');
      run.push(p);
    });
    flush();
    return `${area ? `<path d="${area}" fill="${l.color}" opacity=".14"/>` : ''}<path d="${d}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const legend = `<div class="sy-legend">${lines.map(l => `<span><i style="background:${l.color}"></i>${esc(l.label)} <b>${esc(l.cur ?? fmt(last(l.v)))}</b>${l.extra ? ` <small>${l.extra}</small>` : ''}</span>`).join('')}</div>`;
  return `<svg class="sy-chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">${grid}${xs}${paths}</svg>${legend}`;
}

/* ---------------- bagian-bagian ---------------- */
function hero() {
  const hl = S.health || {}, sc = hl.score ?? null, L = STATUS_LVL[hl.status] || '';
  const C = 2 * Math.PI * 34, off = C * (1 - (sc || 0) / 100);
  const ring = `<svg class="sy-ring ${L}" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="34" class="bg"/><circle cx="40" cy="40" r="34" class="fg" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/><text x="40" y="45" text-anchor="middle">${sc ?? '–'}</text></svg>`;
  const reasons = (hl.reasons || []).length ? `<ul class="sy-reasons">${hl.reasons.map(r => `<li class="${r.level}"><span>${esc(r.text)}</span><b>−${r.pts}</b></li>`).join('')}</ul>` : '<p class="hint">Tidak ada yang mengurangi skor.</p>';
  const alerts = (S.alerts || []).length ? `<div class="sy-alerts">${S.alerts.map(a => `<span class="chip ${a.sustained ? 'bad' : 'warn'}">${esc(a.label)} ${dec(a.value)} &gt; ${a.limit} · sejak ${agoS(a.since)}</span>`).join('')}</div>` : '';
  const c = S.cpu || {};
  const levels = (c.levels || []).map(l => `${l.cores} ${l.kind === 'P' ? 'performa' : l.kind === 'E' ? 'efisiensi' : esc(l.name)}`).join(' + ');
  return `<section class="card sy-hero">
    <div class="sy-hero-score">${ring}<div><p class="eyebrow">Skor kesehatan</p><h2 class="${L}">${esc(hl.status || '–')}</h2>${reasons}</div></div>
    <div class="sy-hero-meta">${kv([
      ['Mesin', `${esc(S.host || '–')}${S.model ? ` <small>${esc(S.model)}</small>` : ''}`],
      ['Chip', `${esc(S.chip || '–')}${c.count ? ` · ${c.count} core${levels ? ` (${levels})` : ''}` : ''}`],
      ['Sistem', `${esc(S.os || '–')} · ${esc(S.arch || '')}`],
      ['Menyala', `${dur(S.uptimeSec)} <small>sejak ${new Date(S.bootAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>`],
      S.counts && ['Proses', `${num(S.counts.procs)} proses · ${num(S.counts.threads)} thread · ${num(S.counts.running)} berjalan`],
      S.users?.length && ['Pengguna', esc(S.users.join(', '))],
    ])}${alerts}</div></section>`;
}

function overview() {
  const c = S.cpu || {}, m = S.mem || {}, d = mainDisk(), g = S.gpu, n = S.net, io = S.diskio, b = S.battery, a = S.agents;
  return `<div class="sy-stats">
    ${stat('CPU', pct(c.total), { p: c.total, hint: `user ${pct(c.user)} · sistem ${pct(c.sys)}`, href: 'sy-cpu' })}
    ${stat('RAM', pct(m.pct), { p: m.pct, cls: PRESSURE_LVL[m.pressure] === 'ok' ? lvl(m.pct, 85, 95) : PRESSURE_LVL[m.pressure] || lvl(m.pct, 85, 95), hint: `${bytes(m.used)} / ${bytes(m.total)}${m.pressure ? ` · tekanan ${esc(m.pressure)}` : ''}`, href: 'sy-mem' })}
    ${g ? stat('GPU', pct(g.util), { p: g.util, hint: `memori ${bytes(g.mem)}`, href: 'sy-gpu' }) : ''}
    ${d ? stat('Disk', pct(d.pct), { p: d.pct, cls: lvl(d.pct, 85, 95), hint: `sisa ${bytes(d.free)}`, href: 'sy-disk' }) : ''}
    ${io ? stat('I/O disk', `${rate(io.read + io.write)}`, { cls: '', hint: `baca ${rate(io.read)} · tulis ${rate(io.write)}`, href: 'sy-disk' }) : ''}
    ${n ? stat('Jaringan', `↓ ${rate(n.rx)}`, { cls: '', hint: `↑ ${rate(n.tx)}`, href: 'sy-net' }) : ''}
    ${b ? stat('Baterai', pct(b.pct, 0), { p: b.pct, cls: b.ac ? 'ok' : lvl(100 - b.pct, 80, 90), hint: `${esc(b.state || '')}${b.ac ? ' · charger' : ''}`, href: 'sy-batt' }) : ''}
    ${a ? stat('Agen Kantor', pct(a.cpu), { cls: '', hint: `${num(a.n)} proses · ${bytes(a.rss)}`, href: 'sy-agents' }) : ''}
    ${stat('Beban', dec(S.load?.[0], 2), { cls: c.count && S.load?.[0] > c.count * 1.5 ? 'warn' : '', hint: `5 mnt ${dec(S.load?.[1], 2)} · 15 mnt ${dec(S.load?.[2], 2)}`, href: 'sy-cpu' })}
  </div>`;
}
const mainDisk = () => (S.disks || []).find(d => d.mount === '/System/Volumes/Data' || d.mount === '/') || (S.disks || [])[0];

function cpuSec() {
  const c = S.cpu || {}, cores = c.cores || [];
  const perf = (c.levels || []).find(l => l.kind === 'P')?.cores ?? null;
  const bars = cores.length ? `<div class="sy-cores">${cores.map((v, i) => `<div class="sy-core ${lvl(v)}" title="Core ${i + 1}: ${pct(v)}"><span><i style="height:${Math.max(2, v)}%"></i></span><small>${perf != null ? (i < cores.length - perf ? 'E' : 'P') : ''}${i + 1}</small></div>`).join('')}</div>` : empty('Data per core belum ada.');
  const heat = heatmap();
  return card('CPU', `${chart([{ v: H?.user, color: 'var(--blue)', label: 'User', fill: true }, { v: H?.sys, color: 'var(--bad)', label: 'Sistem', fill: true }, { v: H?.cpu, color: 'var(--ink)', label: 'Total', extra: `rata-rata ${pct(mean(H?.cpu))}` }], { max: 100, fmt: v => `${dec(v, 0)}%`, label: 'Grafik CPU', wide: true, h: 180 })}
    <h4 class="sy-h4">Per core sekarang</h4>${bars}
    <h4 class="sy-h4">Per core dari waktu ke waktu</h4>${heat}
    ${kv([['Frekuensi', c.freqMHz ? `${num(c.freqMHz)} MHz` : '–'], ['Idle', pct(c.idle)], ['Puncak di rentang ini', pct(peak(H?.cpu))], ['Beban 1 / 5 / 15 mnt', `${dec(S.load?.[0], 2)} / ${dec(S.load?.[1], 2)} / ${dec(S.load?.[2], 2)}`]])}`, { wide: true, id: 'sy-cpu', sub: `${c.count || '–'} core` });
}
function heatmap() {
  const keys = H ? Object.keys(H).filter(k => /^c\d+$/.test(k)).sort((a, b) => a.slice(1) - b.slice(1)) : [];
  const t = H?.t || [];
  if (!keys.length || t.length < 2) return empty('Riwayat per core belum cukup.');
  const cols = t.length, W = Math.max(240, fullW), rowH = 12, L = 26, cw = (W - L) / cols, h = keys.length * rowH + 16;
  const cells = keys.map((k, r) => H[k].map((v, i) => v == null ? '' : `<rect x="${(L + i * cw).toFixed(1)}" y="${r * rowH}" width="${(cw + 0.4).toFixed(1)}" height="${rowH - 1}" fill="var(--sy-heat)" fill-opacity="${(0.08 + Math.min(100, v) / 100 * 0.92).toFixed(2)}"><title>Core ${r + 1} · ${clock(t[i])}: ${pct(v)}</title></rect>`).join('')
    + `<text x="${L - 4}" y="${r * rowH + rowH - 2}" text-anchor="end">${r + 1}</text>`).join('');
  return `<svg class="sy-heat" viewBox="0 0 ${W} ${h}" role="img" aria-label="Peta panas CPU per core">${cells}<text x="${L}" y="${h - 3}">${clock(t[0])}</text><text x="${W}" y="${h - 3}" text-anchor="end">${clock(t[t.length - 1])}</text></svg>`;
}

function memSec() {
  const m = S.mem || {};
  const parts = [['app', 'Aplikasi', 'var(--blue)'], ['wired', 'Wired', 'var(--bad)'], ['compressed', 'Terkompresi', 'var(--warn)'], ['cached', 'Cache', 'var(--teal)'], ['unused', 'Kosong', 'var(--surface-2)']].filter(([k]) => m[k] != null);
  const stack = parts.length ? `<div class="sy-stack">${parts.map(([k, l, c]) => `<i style="width:${(m[k] / m.total * 100).toFixed(2)}%;background:${c}" title="${l}: ${bytes(m[k])}"></i>`).join('')}</div>
    <div class="sy-legend">${parts.map(([k, l, c]) => `<span><i style="background:${c}"></i>${l} <b>${bytes(m[k])}</b></span>`).join('')}</div>` : '';
  const sw = m.swap, r = m.rates;
  return card('Memori', `${stack}
    ${chart([{ v: H?.ram, color: 'var(--blue)', label: 'RAM terpakai', fill: true, extra: `puncak ${pct(peak(H?.ram))}` }], { max: 100, fmt: v => `${dec(v, 0)}%`, label: 'Grafik RAM' })}
    <h4 class="sy-h4">Swap &amp; terkompresi</h4>
    ${chart([{ v: H?.swap, color: 'var(--warn)', label: 'Swap', cur: bytes(last(H?.swap) * 1048576) }, { v: H?.comp, color: 'var(--teal)', label: 'Terkompresi', cur: bytes(last(H?.comp) * 1048576) }], { fmt: v => bytes(v * 1048576), label: 'Grafik swap' })}
    ${kv([['Terpakai', `${bytes(m.used)} dari ${bytes(m.total)} (${pct(m.pct)})`], ['Tekanan memori', m.pressure ? `<span class="sy-dot ${PRESSURE_LVL[m.pressure] || ''}"></span>${esc(m.pressure)}${m.freePct != null ? ` · ${m.freePct}% bebas menurut sistem` : ''}` : '–'],
      sw && ['Swap', `${bytes(sw.used)} dari ${bytes(sw.total)}${sw.total ? ` (${pct(sw.used / sw.total * 100, 0)})` : ''}`],
      r && ['Halaman masuk / keluar', `${num(r.pageins)} / ${num(r.pageouts)} per dtk`], r && ['Swap masuk / keluar', `${num(r.swapins)} / ${num(r.swapouts)} per dtk`]])}`, { id: 'sy-mem', sub: bytes(m.total) });
}

function diskSec() {
  const io = S.diskio;
  const vols = (S.disks || []).map(d => `<div class="sy-vol"><div class="sy-vol-h"><b>${esc(d.name || d.mount)}</b><span class="hint">${esc(d.mount)}</span><span>${bytes(d.used)} / ${bytes(d.total)}</span></div>${meter(d.pct, lvl(d.pct, 85, 95))}<small class="hint">sisa ${bytes(d.free)} · ${pct(d.pct)} terpakai</small></div>`).join('') || empty('Tidak ada data volume.');
  return card('Disk', `${vols}
    <h4 class="sy-h4">Baca &amp; tulis</h4>
    ${chart([{ v: H?.dr, color: 'var(--blue)', label: 'Baca', fill: true, cur: rate(io?.read) }, { v: H?.dw, color: 'var(--warn)', label: 'Tulis', fill: true, cur: rate(io?.write) }], { fmt: bytes, label: 'Grafik I/O disk' })}
    ${io ? kv([['IOPS baca / tulis', `${num(io.rIops)} / ${num(io.wIops)}`], ['Total sejak menyala', `baca ${bytes(io.readTotal)} · tulis ${bytes(io.writeTotal)}`]]) : ''}`, { id: 'sy-disk' });
}

function netSec() {
  const n = S.net;
  if (!n) return card('Jaringan', empty('Belum ada data jaringan.'), { id: 'sy-net' });
  const ifs = Object.entries(n.ifaces || {});
  const rows = ifs.length ? `<div class="tbl-wrap"><table class="tbl sy-tbl"><thead><tr><th>Antarmuka</th><th>IP</th><th class="num">↓ unduh</th><th class="num">↑ unggah</th><th class="num">Total ↓ / ↑</th></tr></thead><tbody>${ifs.map(([k, v]) => `<tr><td><code>${esc(k)}</code>${n.active === k ? ' <span class="chip ok">utama</span>' : ''}</td><td>${esc(v.ip || '–')}</td><td class="num">${rate(v.rx)}</td><td class="num">${rate(v.tx)}</td><td class="num">${bytes(v.rxTotal)} / ${bytes(v.txTotal)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return card('Jaringan', `${chart([{ v: H?.rx, color: 'var(--accent)', label: 'Unduh', fill: true, cur: rate(n.rx) }, { v: H?.tx, color: 'var(--blue)', label: 'Unggah', fill: true, cur: rate(n.tx) }], { fmt: bytes, label: 'Grafik jaringan' })}
    ${rows}
    ${kv([n.conns && ['Koneksi TCP', `${num(n.conns.established)} tersambung · ${num(n.conns.listen)} mendengarkan`], n.wifi && ['Wi-Fi', `${esc(n.wifi.ssid || 'nama jaringan tersembunyi')}${n.wifi.security ? ` · ${esc(n.wifi.security)}` : ''}`], ['Total sejak menyala', `↓ ${bytes(n.rxTotal)} · ↑ ${bytes(n.txTotal)}`]])}`, { id: 'sy-net' });
}

function gpuSec() {
  const g = S.gpu;
  if (!g) return '';
  return card('GPU', `<div class="sy-trio">${[['Perangkat', g.util], ['Renderer', g.renderer], ['Tiler', g.tiler]].map(([l, v]) => `<div><span class="hint">${l}</span><b>${pct(v, 0)}</b>${meter(v)}</div>`).join('')}</div>
    ${chart([{ v: H?.gpu, color: 'var(--violet, #8B5CF6)', label: 'Pemakaian GPU', fill: true, extra: `puncak ${pct(peak(H?.gpu), 0)}` }], { max: 100, fmt: v => `${dec(v, 0)}%`, label: 'Grafik GPU' })}
    ${kv([['Memori dipakai', bytes(g.mem)], ['Memori dialokasikan', bytes(g.alloc)], g.cores && ['Core GPU', num(g.cores)]])}`, { id: 'sy-gpu', sub: esc(g.name || '') });
}

function battSec() {
  const b = S.battery, th = S.thermal;
  if (!b && !th) return '';
  const body = b ? `<div class="sy-batt"><div class="sy-batt-body ${b.ac ? 'ok' : lvl(100 - b.pct, 80, 90)}"><i style="width:${b.pct}%"></i></div><b>${pct(b.pct, 0)}</b><span>${esc(b.state || '')}${b.remainingMin != null ? ` · ${dur(b.remainingMin * 60)} lagi` : ''}</span></div>
    ${chart([{ v: H?.batt, color: 'var(--accent)', label: 'Persen baterai', fill: true }], { max: 100, fmt: v => `${dec(v, 0)}%`, h: 110, label: 'Grafik baterai' })}
    ${kv([['Kesehatan', `${pct(b.health)} · ${esc(b.condition || '')}`], ['Kapasitas', b.capacityMah ? `${num(b.capacityMah)} mAh dari ${num(b.designMah)} mAh` : '–'], ['Siklus', b.cycles != null ? `${num(b.cycles)} dari ${num(b.designCycles || 1000)}` : '–'],
      ['Suhu baterai', b.tempC != null ? `${dec(b.tempC)} °C` : '–'], ['Daya', b.watts ? `${dec(b.watts)} W` : '0 W'], ['Tegangan', b.voltage != null ? `${dec(b.voltage, 2)} V` : '–'],
      b.adapter && ['Charger', `${esc(b.adapter.name || '')}${b.adapter.watts ? ` (${b.adapter.watts} W)` : ''}`]])}` : '';
  const therm = th ? kv([['Termal', `<span class="sy-dot ${th.state === 'normal' ? 'ok' : 'bad'}"></span>${esc(th.state)}${th.speedLimit != null ? ` · CPU dibatasi ${th.speedLimit}%` : ''}`]]) : '';
  return card('Baterai & termal', body + therm, { id: 'sy-batt' });
}

function agentsSec() {
  const a = S.agents;
  if (!a) return card('Agen Kantor', empty('Belum ada data proses agen.'), { id: 'sy-agents' });
  const kinds = Object.entries(a.kinds || {}).sort((x, y) => y[1].cpu - x[1].cpu);
  return card('Agen Kantor', `${kv([['Total', `${pct(a.cpu)} CPU (100% = 1 core) · ${bytes(a.rss)} RAM · ${num(a.n)} proses`]])}
    <div class="tbl-wrap"><table class="tbl sy-tbl"><thead><tr><th>Jenis</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Proses</th></tr></thead><tbody>${kinds.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${pct(v.cpu)}</td><td class="num">${bytes(v.rss)}</td><td class="num">${num(v.n)}</td></tr>`).join('')}</tbody></table></div>
    ${chart([{ v: H?.agents, color: 'var(--accent)', label: 'CPU agen', fill: true, extra: `puncak ${pct(peak(H?.agents))}` }], { fmt: v => `${dec(v, 0)}%`, h: 120, label: 'Grafik CPU agen' })}`, { id: 'sy-agents', sub: 'claude, codex, node, tmux' });
}

function historySec() {
  return card('Skor & beban', chart([{ v: H?.score, color: 'var(--accent)', label: 'Skor kesehatan' }], { max: 100, fmt: v => dec(v, 0), h: 110, label: 'Grafik skor' })
    + chart([{ v: H?.load, color: 'var(--warn)', label: 'Beban 1 mnt', extra: `${S.cpu?.count || '–'} core` }], { fmt: v => dec(v, 1), h: 110, label: 'Grafik beban' }), { id: 'sy-score' });
}

function topSec() {
  const rows = S.top?.[topKey] || [];
  const fmtV = { cpu: v => pct(v), ram: bytes, power: v => dec(v), net: rate, gpu: v => pct(v) }[topKey];
  const max = Math.max(...rows.map(r => r.value || 0), 1);
  const tabs = `<div class="seg" role="group" aria-label="Urutkan pemakan">${TOPS.filter(([k]) => S.top?.[k]).map(([k, l]) => `<button data-top="${k}" aria-pressed="${topKey === k}">${l}</button>`).join('')}</div>`;
  const body = rows.length ? `<ol class="sy-top">${rows.map(r => `<li><span class="sy-top-n">${esc(r.name)}${r.n > 1 ? ` <small>×${r.n}</small>` : ''}</span><span class="sy-top-bar"><i style="width:${(r.value / max * 100).toFixed(1)}%"></i></span><b>${fmtV(r.value)}</b>${topKey === 'net' ? `<small class="hint">↓ ${rate(r.rx)} · ↑ ${rate(r.tx)}</small>` : ''}</li>`).join('')}</ol>`
    : empty(topKey === 'power' ? 'Dampak energi diukur tiap 5 menit.' : 'Belum ada data.');
  return card('Pemakan terbesar', tabs + body, { id: 'sy-top', sub: topKey === 'cpu' ? '100% = 1 core' : topKey === 'power' ? 'dampak energi' : '' });
}

function procSec() {
  if (!P) return card('Proses', empty('Memuat proses…'), { wide: true, id: 'sy-procs' });
  const k = q.trim().toLowerCase();
  let g = [...(P.groups || [])];
  if (k) g = g.filter(x => x.name.toLowerCase().includes(k) || (x.procs || []).some(p => p.name.toLowerCase().includes(k) || String(p.pid) === k));
  g.sort(sort === 'ram' ? (a, b) => b.rss - a.rss : sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.cpu - a.cpu || b.rss - a.rss);
  const rows = g.map(x => {
    const opened = openGroups.has(x.name);
    const kids = opened ? (x.procs || []).map(p => `<tr class="sy-kid"><td><code>${p.pid}</code> ${esc(p.name)}</td><td class="num">${pct(p.cpu)}</td><td class="num">${bytes(p.rss)}</td><td></td></tr>`).join('') : '';
    return `<tr class="sy-grp${opened ? ' open' : ''}" data-grp="${esc(x.name)}"><td><button class="sy-tw" aria-expanded="${opened}" aria-label="Rincian ${esc(x.name)}">${x.n > 1 ? '▸' : ''}</button>${esc(x.name)}${x.agent ? ` <span class="chip ok">${esc(x.agent)}</span>` : ''}</td><td class="num">${pct(x.cpu)}</td><td class="num">${bytes(x.rss)}</td><td class="num">${num(x.n)}</td></tr>${kids}`;
  }).join('');
  const bar = `<div class="sy-procbar"><div class="seg" role="group" aria-label="Urutkan proses">${[['cpu', 'CPU'], ['ram', 'RAM'], ['name', 'Nama']].map(([v, l]) => `<button data-sort="${v}" aria-pressed="${sort === v}">${l}</button>`).join('')}</div>
    <input type="search" id="syQ" placeholder="Cari nama atau PID" value="${esc(q)}" aria-label="Cari proses">
    <button class="btn sm" data-act="sy-all">${allProcs ? 'Tampilkan ringkas' : 'Tampilkan semua'}</button></div>`;
  return card('Proses', `${bar}<div class="tbl-wrap sy-procs"><table class="tbl sy-tbl"><thead><tr><th>Aplikasi</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Proses</th></tr></thead><tbody>${rows || `<tr><td colspan="4">${empty('Tidak ada yang cocok.')}</td></tr>`}</tbody></table></div>`,
    { wide: true, id: 'sy-procs', sub: `${num(P.count)} proses, dikelompokkan per aplikasi · diperbarui ${P.at ? agoS(P.at) : '–'}` });
}

function eventsSec() {
  const ev = EV || S.events || [];
  const body = ev.length ? `<ul class="sy-events">${ev.map(e => `<li class="${e.level}"><span class="sy-dot ${e.level === 'info' ? '' : e.level}"></span><time>${new Date(e.at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time><span>${esc(e.text)}</span></li>`).join('')}</ul>` : empty('Belum ada peristiwa.');
  const lim = S.limits || {};
  return card('Peristiwa', body + `<p class="hint sy-limits">Peringatan dikirim ke Ghina bila CPU &gt; ${lim.cpu}%, RAM &gt; ${lim.ram}%, swap &gt; ${lim.swapPct}% atau disk &gt; ${lim.disk}% bertahan ${Math.round((lim.sustainSec || 0) / 60)} menit (jeda ${lim.cooldownMin} menit).</p>`, { id: 'sy-events' });
}

function footer() {
  const c = S.cost || {};
  return `<p class="hint sy-foot">Data ${S.at ? agoS(S.at) : '–'} · sampel tiap ${S.intervalSec} dtk selama ada yang menonton (${S.active ? 'aktif' : 'santai'}) · biaya pemantau ${dec(S.tickMs)} ms per sampel, daemon ${dec(c.daemonCpuPct, 2)}% CPU</p>`;
}

function draw() {
  if (!root || !S) return;
  const gw = root.clientWidth;
  fullW = gw - 40; halfW = (gw > 900 ? (gw - 14) / 2 : gw) - 40;
  if (S.enabled === false) { root.innerHTML = '<div class="notice">Pemantau performa dimatikan di config (<code>sysmon.enabled</code>).</div>'; return; }
  const focus = document.activeElement?.id === 'syQ' ? { s: document.activeElement.selectionStart } : null;
  const rangeBar = `<div class="sy-bar"><span class="seg-l">Rentang grafik</span><div class="seg" role="group" aria-label="Rentang grafik">${RANGES.map(([m, l]) => `<button data-range="${m}" aria-pressed="${range === m}">${l}</button>`).join('')}</div></div>`;
  root.innerHTML = `<div class="sy-root">${hero()}${overview()}${rangeBar}<div class="sy-grid">${cpuSec()}${memSec()}${diskSec()}${netSec()}${gpuSec()}${battSec()}${agentsSec()}${historySec()}${topSec()}${eventsSec()}${procSec()}</div>${footer()}</div>`;
  if (focus) { const i = $('#syQ', root); i.focus(); try { i.setSelectionRange(focus.s, focus.s); } catch {} }
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.jump) { document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (b.dataset.range) { range = Number(b.dataset.range); H = null; draw(); loadHist(); start(); return; }
  if (b.dataset.top) { topKey = b.dataset.top; draw(); return; }
  if (b.dataset.sort) { sort = b.dataset.sort; draw(); return; }
  if (b.dataset.act === 'sy-all') { allProcs = !allProcs; loadProcs().catch(er => toast(er.message, 'bad')); return; }
  const row = b.closest('tr[data-grp]');
  if (row && b.classList.contains('sy-tw')) { const k = row.dataset.grp; if (openGroups.has(k)) openGroups.delete(k); else openGroups.add(k); draw(); }
}
function onInput(e) { if (e.target.id === 'syQ') { q = e.target.value; draw(); } }
