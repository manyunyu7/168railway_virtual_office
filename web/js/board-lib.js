// Board: fungsi murni (tanggal, filter, singkatan cepat, preferensi). Tanpa DOM supaya gampang dites.
export const COLS = ['Backlog', 'Siap', 'Dikerjakan', 'Review', 'Selesai'];
export const DEFAULT_WIP = [0, 0, 5, 3, 0];
export const PRIOS = ['P0', 'P1', 'P2', 'P3'];
export const GROUPS = [['none', 'Tanpa kelompok'], ['who', 'Role'], ['epic', 'Epic'], ['prio', 'Prioritas'], ['label', 'Label'], ['repo', 'Repo']];
export const DONE_COL = 4;
export const OLD_DONE_DAYS = 7;

const LS = id => 'kc.board.' + id;
const LSW = id => 'kc.board.wip.' + id;

/* ---------------- tanggal ---------------- */
export const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const pad = n => String(n).padStart(2, '0');
export const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dayStr(new Date());
export const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return dayStr(new Date(y, m - 1, d + n)); };
export function fmtDay(s) {
  if (!isDate(s)) return s || '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
/** '' | 'over' | 'soon' | 'ok' | 'done' */
export function dueState(c, today = todayStr()) {
  if (!isDate(c.due)) return '';
  if (c.done ?? c.col === DONE_COL) return 'done';
  if (c.due < today) return 'over';
  return c.due <= addDays(today, 2) ? 'soon' : 'ok';
}
export function isOldDone(c, today = todayStr()) {
  if (!(c.done ?? c.col === DONE_COL)) return false;
  const t = Date.parse(c.movedAt || c.updatedAt || '');
  return !!t && t < Date.parse(addDays(today, -OLD_DONE_DAYS) + 'T00:00:00');
}

/* ---------------- kartu ---------------- */
export const byId = cards => new Map(cards.map(c => [c.id, c]));
/** dependensi yang belum Selesai (kartu yang sudah diarsipkan dianggap beres) */
export function pendingDeps(c, map) { return (c.deps || []).filter(id => { const d = map.get(id); return d && !(d.done ?? d.col === DONE_COL); }); }
export function progressOf(c) {
  if (c.progress != null) return c.progress;
  const t = c.checks?.total || 0;
  return t ? Math.round((c.checks.done / t) * 100) : null;
}
/** ord baru supaya kartu berada di antara prev dan next */
export function midOrd(prev, next) {
  if (prev != null && next != null) { const m = (prev + next) / 2; return m > prev && m < next ? m : prev + (next - prev) / 2; }
  if (next != null) return next - 1000;
  if (prev != null) return prev + 1000;
  return Date.now();
}
/** teks hitam/putih yang terbaca di atas warna hex */
export function labelInk(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  if (!Number.isFinite(n)) return '#fff';
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#1F1628' : '#fff';
}

/* ---------------- preferensi (localStorage, per kantor) ---------------- */
export const defaultPrefs = () => ({
  q: '', who: [], labels: [], prios: [], repos: [], due: '', blocked: false, waiting: false, unassigned: false, mine: false, me: '',
  hideOld: false, group: 'none', view: 'kanban', density: 'comfort', collapsed: [], collapsedB: {}, lanesOff: [], sort: { k: 'col', dir: 1 },
});
const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);
export function loadPrefs(oid) {
  const p = defaultPrefs();
  try {
    const s = JSON.parse(localStorage.getItem(LS(oid)) || '{}');
    p.q = String(s.q || '');
    p.who = arr(s.who ?? s.role); p.labels = arr(s.labels); p.prios = arr(s.prios ?? s.prio); p.repos = arr(s.repos ?? s.repo);
    p.due = ['overdue', 'week', 'none'].includes(s.due) ? s.due : '';
    for (const k of ['blocked', 'waiting', 'unassigned', 'mine', 'hideOld']) p[k] = !!s[k];
    p.me = String(s.me || '');
    p.group = GROUPS.some(g => g[0] === s.group) ? s.group : 'none';
    p.view = s.view === 'list' ? 'list' : 'kanban';
    p.density = s.density === 'compact' ? 'compact' : 'comfort';
    p.collapsed = (Array.isArray(s.collapsed) ? s.collapsed : []).map(Number).filter(n => n >= 0 && n < 20);
    p.lanesOff = arr(s.lanesOff);
    if (s.collapsedB && typeof s.collapsedB === 'object') for (const [k, v] of Object.entries(s.collapsedB)) if (Array.isArray(v)) p.collapsedB[k] = v.map(Number).filter(n => n >= 0 && n < 20);
    if (s.sort && typeof s.sort.k === 'string') p.sort = { k: s.sort.k, dir: s.sort.dir === -1 ? -1 : 1 };
  } catch {}
  return p;
}
export function savePrefs(oid, p) { try { localStorage.setItem(LS(oid), JSON.stringify(p)); } catch {} }
/** Batas WIP per kolom. Papan selain Utama disimpan terpisah (key oid.papan); kolom jenis dikerjakan/review dapat bawaan 5/3. */
export function loadWip(oid, cols) {
  const w = cols ? cols.map(c => (c.kind === 'dikerjakan' ? 5 : c.kind === 'review' ? 3 : 0)) : [...DEFAULT_WIP];
  try { const s = JSON.parse(localStorage.getItem(LSW(oid)) || 'null'); if (Array.isArray(s)) s.forEach((v, i) => { if (i < w.length && Number.isFinite(+v) && +v >= 0) w[i] = Math.floor(+v); }); } catch {}
  return w;
}
export function saveWip(oid, w) { try { localStorage.setItem(LSW(oid), JSON.stringify(w)); } catch {} }

/* ---------------- filter ---------------- */
export const FILTER_KEYS = ['who', 'labels', 'prios', 'repos'];
export function activeCount(f) {
  return (f.q.trim() ? 1 : 0) + f.who.length + f.labels.length + f.prios.length + f.repos.length + (f.due ? 1 : 0)
    + ['blocked', 'waiting', 'unassigned', 'mine', 'hideOld'].filter(k => f[k]).length;
}
export function matchCard(c, f, { map, labelName = () => '', today = todayStr() } = {}) {
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = (c.title + ' ' + (c.desc || '') + ' ' + c.id + ' ' + (c.labels || []).map(labelName).join(' ')).toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  if (f.who.length && !f.who.includes(c.who || '_none')) return false;
  if (f.labels.length && !f.labels.some(l => (c.labels || []).includes(l))) return false;
  if (f.prios.length && !f.prios.includes(c.prio)) return false;
  if (f.repos.length && !f.repos.includes(c.repo || '_none')) return false;
  if (f.due === 'overdue' && dueState(c, today) !== 'over') return false;
  if (f.due === 'none' && c.due) return false;
  if (f.due === 'week' && !(isDate(c.due) && c.due >= today && c.due <= addDays(today, 7))) return false;
  if (f.blocked && !c.blocked) return false;
  if (f.waiting && !(map && pendingDeps(c, map).length)) return false;
  if (f.unassigned && c.who) return false;
  if (f.mine && (!f.me || c.who !== f.me)) return false;
  if (f.hideOld && isOldDone(c, today)) return false;
  return true;
}

/* ---------------- singkatan cepat: "judul #label @role !P1" ---------------- */
export function parseQuick(text, { labels = [], roles = [] } = {}) {
  const out = { title: '', labels: [], who: null, prio: null };
  const keep = [];
  for (const tok of String(text).trim().split(/\s+/)) {
    let m;
    if ((m = /^#([^\s#@!]+)$/.exec(tok))) {
      const name = m[1].replace(/_/g, ' ');
      const hit = labels.find(l => l.name.toLowerCase() === name.toLowerCase());
      out.labels.push(hit ? hit.name : name);
    } else if ((m = /^@([^\s#@!]+)$/.exec(tok))) {
      const k = m[1].toLowerCase();
      const r = roles.find(x => x.id.toLowerCase() === k || x.name.toLowerCase() === k)
        || roles.find(x => x.name.toLowerCase().startsWith(k) || x.id.toLowerCase().startsWith(k));
      if (r) out.who = r.id; else keep.push(tok);
    } else if ((m = /^!([pP][0-3])$/.exec(tok))) out.prio = m[1].toUpperCase();
    else keep.push(tok);
  }
  out.title = keep.join(' ').trim();
  out.labels = [...new Set(out.labels)];
  return out;
}

export const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');
