// Board: state bersama + helper kecil yang dipakai board.js dan board-detail.js.
import { esc } from './util.js';
import { defaultPrefs, labelInk } from './board-lib.js';

export const S = {
  ctx: null, el: null, oid: null,
  cards: [], all: [], labels: [], seen: new Map(), map: new Map(),
  board: 'utama', boards: [], // papan aktif ('all' = Semua papan) + daftar papan kantor
  f: defaultPrefs(), wip: [0, 0, 5, 3, 0],
  sel: new Set(), selMode: false, qa: null, fp: false, menu: null,
  dragId: null, dragLane: null, timer: null, flash: new Set(), liveSig: '', focusId: null,
  dr: null, // { id|null, card, preview, blockedOpen, comment, notify, pending, depQ, uploading }
};
/** diisi board.js supaya board-detail.js bisa memanggil tanpa import melingkar */
export const hooks = { refetch: () => {}, renderMain: () => {} };

export const office = () => S.ctx.office;
export const base = () => `/api/offices/${S.oid}`;
export const roles = () => (office().roles || []).filter(r => !r.archived);
export const roleOf = id => id && (office().roles || []).find(r => r.id === id);
export const roleByAny = k => { k = String(k || '').toLowerCase(); return (office().roles || []).find(r => r.id.toLowerCase() === k || r.name.toLowerCase() === k); };
export const rooms = () => office().plan?.rooms || [];
export const repoName = id => {
  if (!id) return 'tanpa repo';
  if (id === 'lintas') return 'lintas repo';
  const r = rooms().find(x => x.id === id);
  return r ? r.name : id;
};
export const whoName = id => (id ? roleOf(id)?.name || id : 'Belum ditugaskan');
export const prioVar = p => `var(--${String(p || 'P2').toLowerCase()})`;
export const epics = () => S.cards.filter(c => c.epic);
export const kids = id => S.cards.filter(c => c.epicId === id);
export const isLive = c => !!c.who && (office().sessions || []).some(s => s.role === c.who && s.status === 'working');
export const liveHTML = c => (isLive(c) ? `<div class="kc-live"><i></i>${esc(whoName(c.who))} sedang bekerja</div>` : '');
export const repoOptions = cur => {
  const list = rooms().filter(r => r.path != null || r.id === cur).map(r => [r.id, r.name]);
  if (!list.some(x => x[0] === 'lintas')) list.push(['lintas', 'lintas repo']);
  if (cur && !list.some(x => x[0] === cur)) list.push([cur, cur]);
  return list;
};
export const repoChoices = () => {
  const opts = rooms().filter(r => r.path != null || S.cards.some(c => c.repo === r.id)).map(r => [r.id, r.name]);
  if (!opts.some(x => x[0] === 'lintas')) opts.push(['lintas', 'lintas repo']);
  S.cards.forEach(c => { if (c.repo && !opts.some(x => x[0] === c.repo)) opts.push([c.repo, c.repo]); });
  return opts;
};
export const labelOf = id => S.labels.find(l => l.id === id);
export const labelName = id => labelOf(id)?.name || '';
export const mediaUrl = id => `${base()}/media/${id}`;
export const labelChip = (id, x = '') => {
  const l = labelOf(id); if (!l) return '';
  return `<span class="lbl" style="--lc:${esc(l.color)};--li:${labelInk(l.color)}" title="${esc(l.name)}">${esc(l.name)}${x}</span>`;
};

/* ---------------- papan (board) ---------------- */
export const KINDS = ['antre', 'siap', 'dikerjakan', 'review', 'selesai'];
export const KIND_LABEL = { antre: 'Antre', siap: 'Siap', dikerjakan: 'Dikerjakan', review: 'Review', selesai: 'Selesai' };
export const isAll = () => S.board === 'all';
export const boardOf = id => S.boards.find(b => b.id === (id || 'utama'));
export const curBoard = () => (isAll() ? null : boardOf(S.board) || boardOf('utama'));
/** Kolom tampilan: kolom papan aktif, atau lima jenis kolom saat Semua papan. */
export const viewCols = () => curBoard()?.columns || KINDS.map(k => ({ id: k, name: KIND_LABEL[k], kind: k }));
/** Indeks kolom tampilan untuk kartu (Semua papan: menurut jenis). */
export const colOf = c => (isAll() ? (c.stage ?? 0) : c.col);
/** Nilai `col` untuk PATCH: indeks di papan, atau nama jenis saat Semua papan (server memetakan ke kolom papan kartu). */
export const colVal = i => (isAll() ? KINDS[i] : i);
export const boardChip = c => { const b = boardOf(c.board); return b ? `<span class="kc-board" style="--bc:${esc(b.color)}" title="Papan ${esc(b.name)}">${esc(b.icon || '')} ${esc(b.name)}</span>` : ''; };
const LSB = oid => 'kc.board.sel.' + oid;
export function loadBoardSel(oid) { try { return localStorage.getItem(LSB(oid)) || 'utama'; } catch { return 'utama'; } }
export function saveBoardSel(oid, v) { try { localStorage.setItem(LSB(oid), v); } catch {} }
