import { $, esc, short, usd, num, tok, api, toast, modal, debounce, dateLong } from './util.js';

const RANGES = [['today', 'Hari ini'], ['night', 'Semalam'], ['24h', '24 jam'], ['7d', '7 hari'], ['custom', 'Kustom']];
let root = null, ctx = null, data = null, range = 'today', from = '', to = '', stuck = 3, pollT = null;

const base = () => ctx.office ? `/api/offices/${encodeURIComponent(ctx.office.id)}/metrics` : '/api/metrics';
function query(extra = {}) {
  const p = new URLSearchParams({ range });
  if (range === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to); }
  if (stuck !== 3) p.set('stuck', stuck);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export async function render(el, c) {
  root = el; ctx = c; data = null;
  el.onclick = onClick; el.onchange = onChange;
  await load();
}
export function unmount() { clearTimeout(pollT); pollT = null; if (root) root.onclick = root.onchange = null; root = null; }
export function live(m) {
  if (m.t === 'changed' && ['board', 'roles', 'payroll'].includes(m.what) && (m.office === '*' || !ctx?.office || m.office === ctx.office.id)) reload();
}
const reload = debounce(() => { if (root) load(true); }, 1500);

async function load(quiet) {
  if (range === 'custom' && !from) { draw(); return; }
  try { data = await api(`${base()}?${query()}`); }
  catch (e) { if (root) { if (quiet) toast(e.message, 'bad'); else root.innerHTML = `<div class="notice">${esc(e.message)}</div>`; } return; }
  draw();
  clearTimeout(pollT);
  if (range === 'today' || range === '24h') pollT = setTimeout(() => { if (root) load(true); }, 60000);
}

/* ---------------- formatting ---------------- */
export const dur = s => s == null ? '-' : s < 90 ? `${s} dtk` : s < 5400 ? `${Math.round(s / 60)} mnt` : `${(s / 3600).toFixed(1).replace('.', ',')} jam`;
const hrs = h => h == null ? '-' : `${String(h).replace('.', ',')} jam`;
const kpi = (b, label, hint = '', cls = '') => `<div class="kpi ${cls}"><b>${b}</b><span>${esc(label)}</span>${hint ? `<small class="hint">${hint}</small>` : ''}</div>`;
const section = (title, sub, body) => `<section class="mt-sec"><div class="mt-sec-h"><h2>${esc(title)}</h2>${sub ? `<span class="hint">${sub}</span>` : ''}</div>${body}</section>`;
const empty = t => `<p class="empty-line">${esc(t)}</p>`;

/* ---------------- bar chart (same idiom as payroll) ---------------- */
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
export function bars(starts, vals, { bucket, color = 'var(--accent)', label = 'item' } = {}) {
  if (!starts.length || !vals.some(v => v > 0)) return empty('Belum ada data di rentang ini.');
  const W = 1100, H = 170, L = 40, B = 24, T = 8, R = 6;
  const max = niceMax(Math.max(...vals, 1)), cw = (W - L - R) / starts.length, ch = H - B - T;
  const grid = [0, 0.5, 1].map(f => { const y = T + ch * (1 - f); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${num(Math.round(max * f * 10) / 10)}</text>`; }).join('');
  const step = Math.max(1, Math.ceil(starts.length / 12));
  const fmt = iso => { const d = new Date(iso); return bucket === 'hour' ? `${String(d.getHours()).padStart(2, '0')}.00` : `${d.getDate()}/${d.getMonth() + 1}`; };
  const rects = vals.map((v, i) => {
    const h = Math.max(v > 0 ? 1.5 : 0, (v / max) * ch), x = L + i * cw;
    const lab = i % step === 0 ? `<text x="${x + cw / 2}" y="${H - 7}" text-anchor="middle">${fmt(starts[i])}</text>` : '';
    return `<g><rect x="${x + 1}" y="${T + ch - h}" width="${Math.max(1, cw - 2)}" height="${h}" rx="2" fill="${color}"><title>${fmt(starts[i])}: ${num(v)} ${esc(label)}</title></rect>${lab}</g>`;
  }).join('');
  return `<svg class="chart mt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik ${esc(label)} per ${bucket === 'hour' ? 'jam' : 'hari'}">${grid}${rects}</svg>`;
}

/* ---------------- sections ---------------- */
function tbl(head, rows, nums = []) {
  if (!rows.length) return empty('Tidak ada data.');
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h, i) => `<th class="${nums.includes(i) ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${nums.includes(i) ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function cardsSection(d) {
  const c = d.cards, cy = c.cycle;
  const k = [
    kpi(num(c.created), 'Kartu dibuat'), kpi(num(c.done), 'Kartu selesai', `${num(c.started)} masuk Dikerjakan`),
    kpi(hrs(cy.avgH), 'Siklus rata-rata', `median ${hrs(cy.medianH)} · p90 ${hrs(cy.p90H)} · ${num(cy.n)} kartu terukur`),
    kpi(num(c.stuck.count), `Macet > ${c.stuck.hours} jam`, 'Dikerjakan / Review tanpa gerak', c.stuck.count ? 'warn' : ''),
    kpi(num(c.review.bounces), 'Bolak-balik Review', `${num(c.review.bouncedCards)} kartu · ${num(c.review.entries)} masuk Review`),
  ];
  const stuckT = c.stuck.cards.length ? tbl(['Kartu', 'Judul', 'Kolom', 'Pemilik', 'Diam'], c.stuck.cards.map(x => [`<code>${esc(x.id)}</code>`, esc(short(x.title, 60)) + (x.blocked ? ' <span class="chip">blok</span>' : ''), esc(x.col), esc(x.who || '-'), hrs(x.hours)]), [4]) : '';
  return section('Kartu', esc(d.range.label), `<div class="kpis">${k.join('')}</div>
    <div class="mt-grid"><div class="card"><h3>Kartu selesai per ${d.range.bucket === 'hour' ? 'jam' : 'hari'}</h3>${bars(d.series.starts, d.series.done, { bucket: d.range.bucket, label: 'selesai' })}</div>
    <div class="card"><h3>Kartu dibuat per ${d.range.bucket === 'hour' ? 'jam' : 'hari'}</h3>${bars(d.series.starts, d.series.created, { bucket: d.range.bucket, color: 'var(--blue)', label: 'dibuat' })}</div></div>
    ${stuckT}`);
}

function dmSection(d) {
  const m = d.dm;
  const k = [
    kpi(num(m.total), 'DM', `${num(m.pesan)} pesan · ${num(m.balasan)} balasan · ${num(m.tanya)} tanya`),
    kpi(dur(m.deliver.avgSec), 'Kirim sampai terlihat', `p90 ${dur(m.deliver.p90Sec)} · maks ${dur(m.deliver.maxSec)}`),
    kpi(dur(m.reply.avgSec), 'Sampai dibalas', `p90 ${dur(m.reply.p90Sec)} · maks ${dur(m.reply.maxSec)}`),
    kpi(num(m.slow5), 'DM antre > 5 mnt', `${num(m.slow1)} lewat 1 mnt`, m.slow5 ? 'warn' : ''),
    kpi(num(m.askTimeout), 'Tanya timeout'),
    kpi(num(m.waitingNow.count), 'Menunggu sekarang', m.waitingNow.count ? `tertua ${dur(m.waitingNow.oldestSec)}` : '', m.waitingNow.count ? 'warn' : ''),
  ];
  const maxAvg = Math.max(1, ...m.perRole.map(p => p.deliver.avgSec || 0));
  const rows = m.perRole.map(p => [esc(p.name), num(p.n),
    `<div class="mt-cellbar"><i style="width:${Math.round(((p.deliver.avgSec || 0) / maxAvg) * 100)}%"></i><span>${dur(p.deliver.avgSec)}</span></div>`,
    dur(p.deliver.p90Sec), dur(p.deliver.maxSec), num(p.slow1), num(p.slow5), dur(p.reply.avgSec)]);
  return section('Pesan langsung', 'latensi dari DM dibuat sampai diketik ke sesi penerima',
    `<div class="kpis">${k.join('')}</div>
    <div class="card"><h3>DM per ${d.range.bucket === 'hour' ? 'jam' : 'hari'}</h3>${bars(d.series.starts, d.series.dm, { bucket: d.range.bucket, color: 'var(--teal)', label: 'DM' })}</div>
    <h3 class="mt-h3">Per penerima</h3>${tbl(['Penerima', 'DM', 'Kirim rata-rata', 'p90', 'Maks', '> 1 mnt', '> 5 mnt', 'Dibalas'], rows, [1, 3, 4, 5, 6, 7])}`);
}

function sessionSection(d) {
  const s = d.sessions, t = s.totals, tot = (t.workSec + t.idleSec + t.waitSec) || 1;
  const k = [
    kpi(dur(t.workSec), 'Bekerja', `${Math.round((t.workSec / tot) * 100)}% dari waktu sesi`), kpi(dur(t.idleSec), 'Idle'), kpi(dur(t.waitSec), 'Menunggu izin'),
    kpi(num(s.compactions), 'Kompaksi'), kpi(num(s.interrupts), 'Interrupt'),
    kpi(num(s.permissions.toTerminal), 'Izin jatuh ke terminal', `dari ${num(s.permissions.total)} izin · tunggu rata-rata ${dur(s.permissions.waitAvgSec)}`, s.permissions.toTerminal ? 'warn' : ''),
  ];
  const rows = s.perRole.map(p => {
    const span = (p.workSec + p.idleSec + p.waitSec) || 1;
    const pc = v => ((v / span) * 100).toFixed(1);
    return [esc(p.name), `<div class="mt-stack" role="img" aria-label="kerja ${dur(p.workSec)}, idle ${dur(p.idleSec)}, izin ${dur(p.waitSec)}"><i class="w" style="width:${pc(p.workSec)}%"></i><i class="p" style="width:${pc(p.waitSec)}%"></i><i class="i" style="width:${pc(p.idleSec)}%"></i></div>`,
      dur(p.workSec), dur(p.idleSec), dur(p.waitSec), num(p.compactions), num(p.interrupts)];
  });
  return section('Sesi', 'perkiraan dari jejak aktivitas; jeda > 3 menit dianggap idle',
    `<div class="kpis">${k.join('')}</div><div class="mt-legend"><span><i class="w"></i>Bekerja</span><span><i class="p"></i>Menunggu izin</span><span><i class="i"></i>Idle</span></div>
    ${tbl(['Role', 'Waktu', 'Kerja', 'Idle', 'Izin', 'Kompaksi', 'Interrupt'], rows, [2, 3, 4, 5, 6])}`);
}

function costSection(d) {
  const c = d.cost;
  const k = [
    kpi(usd(c.total), 'Biaya', `per hari penuh (${esc(c.days[0] === c.days[1] ? c.days[0] : c.days.join(' – '))})`),
    kpi(c.perDoneCard != null ? usd(c.perDoneCard) : '-', 'Per kartu selesai'),
    kpi(c.perCommit != null ? usd(c.perCommit) : '-', 'Per commit'),
    kpi(tok(c.output), 'Token keluaran', `cache dibaca ${tok(c.cacheRead)}`),
  ];
  if (c.tokenOnlyTokens) k.push(kpi(tok(c.tokenOnlyTokens), 'Token Codex', 'tanpa harga (langganan)'));
  const total = c.total || 1;
  const rows = c.perRole.map(p => [esc(p.name), `<div class="mt-cellbar"><i style="width:${Math.round((p.cost / total) * 100)}%"></i><span>${usd(p.cost)}</span></div>`, num(p.msgs), tok(p.output), p.tokenOnlyTokens ? tok(p.tokenOnlyTokens) : '-']);
  return section('Biaya', 'estimasi setara harga API', `<div class="kpis">${k.join('')}</div>${tbl(['Role', 'Biaya', 'Pesan model', 'Keluaran', 'Token Codex'], rows, [2, 3, 4])}`);
}

function gitSection(d) {
  const g = d.git;
  const kinds = Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip">${esc(k)} ${num(n)}</span>`).join('');
  const k = [kpi(num(g.total), 'Commit'), kpi(num(g.reverts), 'Revert', '', g.reverts ? 'warn' : '')];
  const rows = g.perRepo.map(p => [esc(p.repo), num(p.commits), num(p.reverts)]);
  return section('Git', '', `<div class="kpis">${k.join('')}</div>${kinds ? `<div class="chips">${kinds}</div>` : ''}
    <div class="card"><h3>Commit per ${d.range.bucket === 'hour' ? 'jam' : 'hari'}</h3>${bars(d.series.starts, d.series.commits, { bucket: d.range.bucket, color: 'var(--ok)', label: 'commit' })}</div>
    ${g.perRepo.length ? tbl(['Repo', 'Commit', 'Revert'], rows, [1, 2]) : empty('Tidak ada repo git di kantor ini.')}`);
}

function frictionSection(d) {
  const f = d.friction;
  const k = [kpi(num(f.toolErrors.total), 'Tool gagal'), kpi(num(f.announcements), 'Pengumuman', 'aturan & koreksi lewat announce')];
  if (f.rules) for (const [n, v] of Object.entries(f.rules)) k.push(kpi(num(v), n === 'locks' ? 'Kunci' : 'Aturan'));
  const rows = f.toolErrors.byTool.map(e => [esc(e.tool), num(e.n), e.reasons.length ? e.reasons.map(r => `${esc(short(r.text, 90))} <span class="hint">${num(r.n)}x</span>`).join('<br>') : '<span class="hint">alasan tidak tercatat</span>']);
  return section('Gesekan', '', `<div class="kpis">${k.join('')}</div>${tbl(['Tool', 'Gagal', 'Alasan terbanyak'], rows, [1])}`);
}

function complexDraw(d) {
  const t = d.total;
  const k = [kpi(num(t.cardsCreated), 'Kartu dibuat'), kpi(num(t.cardsDone), 'Kartu selesai'), kpi(hrs(t.cycleAvgH), 'Siklus rata-rata'), kpi(num(t.stuck), 'Kartu macet', '', t.stuck ? 'warn' : ''),
    kpi(num(t.commits), 'Commit', `${num(t.reverts)} revert`), kpi(num(t.dm), 'DM', `${num(t.dmWaiting)} menunggu`), kpi(usd(t.cost), 'Biaya'), kpi(dur(t.workSec), 'Waktu kerja', `idle ${dur(t.idleSec)}`), kpi(num(t.toolErrors), 'Tool gagal')];
  const rows = d.offices.map(o => [`<a href="#/o/${encodeURIComponent(o.id)}/metrik">${esc(o.name)}</a>`, num(o.cardsDone), hrs(o.cycleAvgH), num(o.stuck), num(o.dm), dur(o.dmDeliverMaxSec), num(o.commits), usd(o.cost), num(o.toolErrors)]);
  return `<div class="kpis">${k.join('')}</div>${section('Per kantor', 'kantor dengan aktivitas di rentang ini', tbl(['Kantor', 'Selesai', 'Siklus', 'Macet', 'DM', 'DM maks', 'Commit', 'Biaya', 'Gagal'], rows, [1, 2, 3, 4, 5, 6, 7, 8]))}`;
}

function draw() {
  if (!root) return;
  const global = !ctx.office;
  const d = data;
  const head = `<div class="mt-bar">
    <div class="seg" role="group" aria-label="Rentang">${RANGES.map(([k, l]) => `<button data-range="${k}" aria-pressed="${range === k}">${l}</button>`).join('')}</div>
    ${range === 'custom' ? `<label class="hint" for="mtFrom">Dari</label><input type="date" id="mtFrom" value="${esc(from)}"><label class="hint" for="mtTo">Sampai</label><input type="date" id="mtTo" value="${esc(to)}">` : ''}
    ${global ? '' : `<label class="hint" for="mtStuck">Macet setelah</label><select id="mtStuck">${[1, 2, 3, 6, 12].map(h => `<option value="${h}" ${h === stuck ? 'selected' : ''}>${h} jam</option>`).join('')}</select>
    <button class="btn sm primary" data-act="mt-report">Laporan shift</button>`}
    <button class="btn sm" data-act="mt-reload">Muat ulang</button></div>`;
  const note = d ? `<p class="hint mt-note">${esc(dateLong(d.range.from))} sampai ${esc(dateLong(d.range.to))} · dihitung ${esc(dateLong(d.generatedAt))}</p>` : '';
  let body = '';
  if (!d) body = empty(range === 'custom' ? 'Pilih tanggal mulai.' : 'Memuat…');
  else if (global) body = complexDraw(d);
  else body = [cardsSection(d), dmSection(d), sessionSection(d), costSection(d), gitSection(d), frictionSection(d)].join('');
  root.innerHTML = `<div class="${global ? 'wrap ' : ''}mt-root">${global ? '<div><p class="eyebrow">Semua kantor</p><h1>Metrik kompleks</h1></div>' : ''}${head}${note}${body}</div>`;
}

/* ---------------- events ---------------- */
async function onClick(e) {
  const r = e.target.closest('[data-range]');
  if (r) { range = r.dataset.range; if (range === 'custom' && !from) { const d = new Date(); to = d.toISOString().slice(0, 10); d.setDate(d.getDate() - 2); from = d.toISOString().slice(0, 10); } load(); draw(); return; }
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'mt-reload') load(true);
  if (a === 'mt-report') await report();
}
function onChange(e) {
  if (e.target.id === 'mtFrom') { from = e.target.value; load(); }
  else if (e.target.id === 'mtTo') { to = e.target.value; load(); }
  else if (e.target.id === 'mtStuck') { stuck = Number(e.target.value) || 3; load(); }
}

async function report() {
  let md;
  try { md = (await api(`${base()}/report?${query()}`)).markdown; } catch (e) { toast(e.message, 'bad'); return; }
  const name = `laporan-shift-${ctx.office.id}-${new Date().toISOString().slice(0, 10)}.md`;
  modal({
    title: 'Laporan shift', html: `<textarea id="mtReport" class="mt-report" readonly spellcheck="false" aria-label="Laporan shift (markdown)">${esc(md)}</textarea>`,
    actions: [{ label: 'Tutup' },
      { label: 'Unduh .md', kind: 'sm', fn: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return false; } },
      { label: 'Salin', kind: 'primary', fn: () => { navigator.clipboard.writeText(md).then(() => toast('Laporan disalin', 'ok'), () => { $('#mtReport')?.select(); toast('Blok teksnya lalu salin manual', 'warn'); }); return false; } }],
  });
}
