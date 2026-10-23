import { mountUsage, unmountUsage, liveUsage } from './usage-card.js';
import { $, esc, short, usd, num, tok, api, post, toast, modal, sprite, guestLook, debounce } from './util.js';

let root = null, ctx = null, data = null, month = '', pollT = null;

const q = () => {
  const p = new URLSearchParams();
  if (ctx.office) p.set('office', ctx.office.id);
  if (month) p.set('month', month);
  const s = p.toString();
  return '/api/payroll' + (s ? '?' + s : '');
};

export async function render(el, c) {
  root = el; ctx = c; data = null; month = '';
  el.onclick = onClick; el.onchange = onChange;
  await load();
}
export function unmount() { unmountUsage(); clearTimeout(pollT); pollT = null; if (root) root.onclick = root.onchange = null; root = null; }

export function live(m) {
  liveUsage(m);
  if (m.t === 'changed' && m.what === 'payroll' && (m.office === '*' || !ctx?.office || m.office === ctx.office.id)) reload();
}
const reload = debounce(() => { if (root) load(); }, 600);

async function load() {
  try {
    data = await api(q());
    if (!month) month = data.month;
  } catch (e) {
    if (root) root.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    return;
  }
  draw();
  clearTimeout(pollT);
  if (data.scan?.running) pollT = setTimeout(() => { if (root) load(); }, 2000);
}

/* ---------------- drawing ---------------- */
function draw() {
  if (!root) return;
  const d = data, t = d.total, days = d.byDay.filter(x => x.cost > 0).length;
  const office = ctx.office, global = !office;
  const budgetPct = d.budget ? (t.cost / d.budget) * 100 : 0;
  const tiles = [
    `<div class="kpi"><b>${usd(t.cost)}</b><span>Biaya bulan ini</span></div>`,
    `<div class="kpi"><b>${num(t.sessions)}</b><span>Sesi</span></div>`,
    `<div class="kpi"><b>${tok(t.output)}</b><span>Token keluaran</span></div>`,
    `<div class="kpi"><b>${usd(days ? d.byDay.reduce((a, x) => a + x.cost, 0) / days : 0)}</b><span>Rata-rata per hari aktif (30 hari)</span></div>`,
  ];
  if (!global) tiles.push(`<div class="kpi"><b>${d.budget ? usd(d.budget, 0) : 'Belum diatur'}</b><span>Budget bulan ini</span>
      ${d.budget ? `<div class="bar ${budgetPct >= 100 ? 'bad' : budgetPct >= 80 ? 'warn' : ''}" style="margin-top:6px"><i style="width:${Math.min(100, budgetPct).toFixed(0)}%"></i></div><span>${budgetPct.toFixed(0)}% terpakai</span>` : ''}
      <button class="btn sm" data-act="py-budget" style="justify-self:start;margin-top:6px">Atur budget</button></div>`);

  root.innerHTML = `<div class="${global ? 'wrap ' : ''}py-root">
    ${global ? '<div><p class="eyebrow">Semua kantor</p><h1>Payroll kompleks</h1></div>' : ''}
    <div id="pyUsage"></div>
    <div class="notice info"><span>Biaya di sini adalah estimasi setara harga API, dihitung dari transcript Claude Code di Mac ini. Ini bukan tagihan langganan.</span></div>
    <div class="btn-row"><label class="hint" for="pyMonth">Bulan</label><select id="pyMonth">${d.months.map(m => `<option ${m === d.month ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <button class="btn sm" data-act="py-rescan" ${d.scan?.running ? 'disabled' : ''}>Pindai ulang</button><span class="hint">${scanText(d.scan)}</span></div>
    <div class="kpis">${tiles.join('')}</div>
    <div class="card"><h2>Biaya harian, 30 hari terakhir</h2>${chart(d.byDay)}</div>
    <div class="card"><h2>Slip gaji</h2>${slips(d)}</div>
    <div class="pay-grid">
      <div><h2 style="font:700 15px var(--f-display);margin-bottom:8px">Sesi termahal</h2>${sessionsTable(d.bySession)}</div>
      <div class="py-side"><div><h2 style="font:700 15px var(--f-display);margin-bottom:8px">Per model</h2>${modelTable(d.byModel, t.cost)}</div>
      ${global ? `<div><h2 style="font:700 15px var(--f-display);margin-bottom:8px">Per kantor</h2>${officeTable(d.byOffice)}</div>` : ''}</div>
    </div></div>`;
  mountUsage($('#pyUsage'), office);
}

function scanText(s) {
  if (!s) return '';
  if (s.running) return `Memindai ${num(s.done)} dari ${num(s.files)} berkas…`;
  if (s.error) return `Pemindaian gagal: ${esc(s.error)}`;
  return s.lastRun ? `Dipindai ${new Date(s.lastRun).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${num(s.files)} berkas` : '';
}

function chart(days) {
  if (!days.length) return '<p class="empty-line">Belum ada data.</p>';
  const W = 1100, H = 240, L = 56, B = 26, T = 10, R = 8;
  const max = Math.max(...days.map(d => d.cost), 0.01);
  const nice = niceMax(max), cw = (W - L - R) / days.length, ch = H - B - T;
  const grid = [0, 0.5, 1].map(f => { const y = T + ch * (1 - f); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${usd(nice * f, nice < 10 ? 2 : 0)}</text>`; }).join('');
  const bars = days.map((d, i) => {
    const h = Math.max(d.cost > 0 ? 1.5 : 0, (d.cost / nice) * ch), x = L + i * cw;
    const lab = i % 5 === 0 || i === days.length - 1 ? `<text x="${x + cw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.day.slice(8))}/${esc(d.day.slice(5, 7))}</text>` : '';
    return `<g><rect x="${x + 1}" y="${T + ch - h}" width="${Math.max(1, cw - 2)}" height="${h}" rx="2" fill="var(--accent)"><title>${esc(d.day)}: ${usd(d.cost)}</title></rect>${lab}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik biaya harian">${grid}${bars}</svg>`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function slips(d) {
  const total = d.total.cost || 0;
  if (!d.byRole.length) return '<p class="empty-line">Belum ada pemakaian bulan ini.</p>';
  return `<div class="slips">${d.byRole.map(r => {
    const role = r.role ? ctx.office?.roles.find(x => x.id === r.role) : null;
    const name = r.role ? (role?.name || r.role) : 'Sesi manual';
    const look = role || guestLook(r.role || 'manual');
    const pct = total ? (r.cost / total) * 100 : 0;
    return `<div class="slip"><div class="slip-top">${sprite(look, 3)}<div><b>${esc(name)}</b><div class="hint">${esc(role?.title || (r.role ? '' : 'Tidak terikat role'))}</div></div></div>
      <div class="slip-amt">${usd(r.cost)}</div><div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>
      <div class="hint">${pct.toFixed(0)}% dari total · ${num(r.sessions)} sesi · ${tok(r.output)} token keluaran</div></div>`;
  }).join('')}</div>`;
}

function modelTable(rows, total) {
  if (!rows.length) return '<p class="empty-line">Belum ada data.</p>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Model</th><th class="num">Biaya</th><th class="num">Keluaran</th><th class="num">%</th></tr></thead><tbody>${rows.map(m => `<tr><td>${esc(m.label || m.model)}</td><td class="num">${usd(m.cost)}</td><td class="num">${tok(m.output)}</td><td class="num">${total ? ((m.cost / total) * 100).toFixed(0) : 0}%</td></tr>`).join('')}</tbody></table></div>`;
}

function officeTable(rows) {
  if (!rows?.length) return '<p class="empty-line">Belum ada data.</p>';
  const name = id => ctx.st?.offices?.find(o => o.id === id)?.name || id;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kantor</th><th class="num">Biaya</th><th class="num">Sesi</th></tr></thead><tbody>${rows.map(o => `<tr><td><a href="#/o/${encodeURIComponent(o.office)}/payroll">${esc(name(o.office))}</a></td><td class="num">${usd(o.cost)}</td><td class="num">${num(o.sessions)}</td></tr>`).join('')}</tbody></table></div>`;
}

function sessionsTable(rows) {
  if (!rows.length) return '<p class="empty-line">Belum ada sesi.</p>';
  const roleName = id => id ? (ctx.office?.roles.find(r => r.id === id)?.name || id) : 'Manual';
  const days = s => s.first === s.last ? esc(s.first) : `${esc(s.first)} – ${esc(s.last)}`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sesi</th><th>Role</th><th class="us-opt">Ruang</th><th class="us-opt">Hari</th><th class="num">Biaya</th></tr></thead><tbody>${rows.map(s => `<tr><td title="${esc(s.sid)}">${esc(short(s.title || s.first_prompt || s.sid.slice(0, 8), 44))}</td><td>${esc(roleName(s.role))}</td><td class="us-opt">${esc(s.room || '-')}</td><td class="us-opt">${days(s)}</td><td class="num">${usd(s.cost)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------------- actions ---------------- */
async function onChange(e) {
  if (e.target.id === 'pyMonth') { month = e.target.value; await load(); }
}
async function onClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  try {
    if (t.dataset.act === 'py-rescan') {
      t.disabled = true;
      await post('/api/payroll/rescan');
      toast('Pemindaian dimulai', 'ok');
      await load();
    } else if (t.dataset.act === 'py-budget') {
      modal({ title: 'Atur budget bulanan', body: `Batas biaya per bulan untuk kantor ${esc(ctx.office.name)}, dalam dolar (estimasi setara API). Isi 0 untuk menghapus batas.`,
        html: `<div class="field"><label for="pyBudget">Budget (USD)</label><input id="pyBudget" type="number" min="0" step="1" value="${data.budget || ''}"></div>`,
        actions: [{ label: 'Simpan', kind: 'primary', fn: () => {
          const usdVal = Number($('#pyBudget').value);
          if (!(usdVal >= 0)) { toast('Isi angka yang valid', 'warn'); return false; }
          post(`/api/offices/${ctx.office.id}/budget`, { usd: usdVal }).then(() => { toast('Budget disimpan', 'ok'); load(); }).catch(err => toast(err.message, 'bad'));
        } }, { label: 'Batal' }] });
    }
  } catch (err) { toast(err.message, 'bad'); t.disabled = false; }
}
