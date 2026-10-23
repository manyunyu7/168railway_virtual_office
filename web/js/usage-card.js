// "Pemakaian": subscription limits (Claude 5h / weekly, Codex) and usage statistics, shown at the top of the Payroll tab.
import { esc, tok, usd, num, api } from './util.js';

const RANGES = [['today', 'Hari ini'], ['7d', '7 hari'], ['30d', '30 hari']];
let host = null, officeId = null, range = '7d', lim = null, sum = null, metric = 'tokens';

const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const level = p => (p >= 90 ? 'bad' : p >= 80 ? 'warn' : '');
const dur = s => { const m = Math.floor(finite(s) / 60); return m >= 60 ? `${Math.floor(m / 60)}j ${m % 60}m` : `${m}m`; };

export function untilReset(at, now = Date.now()) {
  if (!at) return '';
  const s = Math.floor((at - now) / 1000);
  if (s <= 0) return 'sudah reset';
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `reset ${d}h ${h}j lagi` : s >= 3600 ? `reset ${Math.floor(s / 3600)}j ${m}m lagi` : s >= 60 ? `reset ${m}m lagi` : 'reset sebentar lagi';
}

function winRow(w) {
  const p = w.expired ? 0 : Math.max(0, Math.min(100, finite(w.usedPercent)));
  return `<div class="us-win"><div class="us-win-top"><span>${esc(w.label)}</span><b class="${level(p)}">${w.expired ? 'sudah reset' : Math.round(p) + '% terpakai'}</b></div>
    <div class="bar ${level(p)}"><i style="width:${p.toFixed(0)}%"></i></div>${w.resetsAt && !w.expired ? `<span class="hint">${esc(untilReset(w.resetsAt))}</span>` : ''}</div>`;
}
function engine(name, e, empty) {
  const ws = e?.windows || [];
  return `<div class="us-eng"><h3>${esc(name)}${e?.plan ? ` <span class="hint">${esc(e.plan)}</span>` : ''}</h3>${ws.length ? ws.map(winRow).join('') : `<p class="hint">${esc(empty)}</p>`}</div>`;
}

function chart(days) {
  const vals = days.map(d => Math.max(0, finite(metric === 'cost' ? d.cost : d.tokens)));
  const max = Math.max(...vals, 0);
  if (!vals.length || max <= 0) return '<p class="empty-line">Belum ada pemakaian.</p>';
  const f = v => (metric === 'cost' ? usd(v) : tok(v));
  // HTML bars at a fixed pixel height: an SVG viewBox would scale its text with the card (huge on desktop, tiny on a phone)
  const bars = vals.map((v, i) => {
    const day = String(days[i].day), lab = vals.length <= 7 || i % 5 === 0 ? `${day.slice(8)}/${day.slice(5, 7)}` : '';
    return `<div class="us-col" title="${esc(day)}: ${esc(f(v))}"><i style="height:${v > 0 ? Math.max(1, v / max * 100).toFixed(1) : 0}%"></i><small>${esc(lab)}</small></div>`;
  }).join('');
  return `<div class="us-chart" role="img" aria-label="Grafik pemakaian harian, tertinggi ${esc(f(max))}"><span class="us-chart-max">${esc(f(max))}</span><div class="us-bars">${bars}</div></div>`;
}

function table(rows, nameKey = 'name') {
  if (!rows?.length) return '<p class="empty-line">Belum ada data.</p>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th class="num">Token</th><th class="num">Sesi</th><th class="num">Biaya</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r[nameKey] || r.name || '-')}</td><td class="num">${tok(r.tokens)}</td><td class="num">${num(r.sessions)}</td><td class="num">${r.cost > 0 ? usd(r.cost) : '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

function draw() {
  if (!host) return;
  const l = lim, s = sum;
  const stats = s ? (() => {
    const t = s.totals || {};
    const kp = [[tok(t.tokens), 'Total token'], [usd(t.cost), 'Biaya setara API (Claude)'], [num(t.sessions), 'Sesi'], [tok(s.avgPerSession?.tokens), 'Rata-rata token per sesi'], [dur(s.work?.seconds), 'Durasi sesi'], [dur(s.work?.avgSeconds), 'Rata-rata durasi sesi']];
    const top = (s.topSessions || []).map(x => `<tr><td>${esc((x.title || x.roleName || 'Sesi').slice(0, 48))}</td><td class="us-opt">${esc(x.roleName || '')}</td><td class="num">${tok(x.tokens)}</td><td class="num">${x.cost > 0 ? usd(x.cost) : '-'}</td></tr>`).join('');
    return `<div class="kpis">${kp.map(([b, sp]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(sp)}</span></div>`).join('')}</div>
      <p class="hint">Masuk ${tok(t.input)} · Keluar ${tok(t.output)} · Cache tulis ${tok(t.cacheW)} · Cache baca ${tok(t.cacheR)} · Claude ${tok(s.engines?.claude?.tokens)} · Codex ${tok(s.engines?.codex?.tokens)}</p>
      <div class="btn-row"><button class="btn sm" data-us="m-tokens" ${metric === 'tokens' ? 'disabled' : ''}>Token</button><button class="btn sm" data-us="m-cost" ${metric === 'cost' ? 'disabled' : ''}>Biaya</button></div>
      ${chart(s.daily || [])}
      <div class="pay-grid"><div>${s.byOffice?.length ? '<h3>Per kantor</h3>' + table(s.byOffice) : ''}<h3>Per peran</h3>${table(s.byRole)}<h3>Per mesin</h3>${table(s.byMachine)}</div>
      <div><h3>Per model</h3>${table(s.byModel, 'label')}<h3>Sesi terboros</h3>${top ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sesi</th><th class="us-opt">Peran</th><th class="num">Token</th><th class="num">Biaya</th></tr></thead><tbody>${top}</tbody></table></div>` : '<p class="empty-line">Belum ada sesi.</p>'}</div></div>
      <p class="hint">${esc(s.costNote || '')} Jumlah tool call dan baris yang diedit belum dicatat.</p>`;
  })() : '<p class="hint">Memuat…</p>';
  host.innerHTML = `<div class="card us-card"><h2>Batas pemakaian</h2>
    ${l ? `<div class="us-engs">${engine('Claude', l.claude, 'Belum ada laporan. Batas Claude datang dari statusline sesi Claude Code yang berjalan lewat Kantor.')}${engine('Codex', l.codex, 'Belum ada sesi Codex dengan data kuota.')}</div>` : '<p class="hint">Memuat…</p>'}</div>
    <div class="card us-card"><div class="btn-row"><h2 style="margin:0">Statistik pemakaian</h2>${RANGES.map(([k, t]) => `<button class="btn sm" data-us="r-${k}" ${range === k ? 'disabled' : ''}>${t}</button>`).join('')}</div>${stats}</div>`;
}

async function loadLimits() { try { lim = await api('/api/usage/limits'); } catch { lim = { claude: { windows: [] }, codex: { windows: [] } }; } draw(); }
async function loadSummary() {
  try { sum = await api(`/api/usage/summary?range=${range}${officeId ? '&office=' + encodeURIComponent(officeId) : ''}`); }
  catch (e) { sum = null; if (host) host.querySelector('.us-card:last-child')?.insertAdjacentHTML('beforeend', `<div class="notice">${esc(e.message)}</div>`); return; }
  draw();
}

export function mountUsage(el, office) {
  host = el; officeId = office?.id && office.id !== '_kompleks' ? office.id : null;
  host.onclick = e => {
    const b = e.target.closest('[data-us]'); if (!b) return;
    const k = b.dataset.us;
    if (k.startsWith('r-')) { range = k.slice(2); sum = null; draw(); loadSummary(); }
    else { metric = k === 'm-cost' ? 'cost' : 'tokens'; draw(); }
  };
  draw(); loadLimits(); loadSummary();
}
export const unmountUsage = () => { if (host) host.onclick = null; host = null; };
export function liveUsage(m) {
  if (!host) return;
  if (m.t === 'usage-limits' && m.limits) { lim = m.limits; draw(); }
}
