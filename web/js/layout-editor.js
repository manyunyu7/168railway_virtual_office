// Layout editor for the Kantor tab: drag rooms around the floor plan, resize them, edit doors and floors,
// then save the result as the office's layout (PUT /api/offices/:id/layout). The canvas keeps drawing the
// real office underneath; this module only adds an HTML layer of handles on top and rebuilds the canvas
// with the edited plan while you drag.
import { $, esc, api, toast, confirmDo } from './util.js';
import { createFurnitureEditor } from './furniture-editor.js';
import { loadTemplates, galleryHTML } from './template-gallery.js';

const WH = 4;          // wall-face rows at the top of every room (same as server/layout.js)
const MIN = 8;         // smallest room the server accepts
const MAX_PLAN = 400;
const SIDES = [['t', 'atas'], ['b', 'bawah'], ['l', 'kiri'], ['r', 'kanan']];
const FLOORS = [['wood', 'Hijau kerja'], ['teal2', 'Biru-hijau'], ['wood2', 'Kayu'], ['carpet', 'Karpet'], ['carpetGreen', 'Karpet hijau'],
  ['marble', 'Marmer'], ['tile', 'Keramik'], ['metal', 'Logam'], ['plum', 'Ungu'], ['frozen', 'Beku']];
const FIXED = new Set(['lobby']); // the lobby holds the lift; it can be resized but not hidden
const CORR = 3;        // standard corridor width that edges snap to
const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
const CURSOR = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw' };

/** Problems that block saving. Mirrors layoutProblems() in server/offices.js. */
export function blockers(plan) {
  const out = [], rooms = plan.rooms.filter(r => r.kind !== 'zone');
  for (const r of rooms) {
    if (r.w < MIN || r.h < MIN) out.push({ id: r.id, msg: `${r.name} terlalu kecil (minimal ${MIN}×${MIN})` });
    if (r.x < 0 || r.y < 0 || r.x + r.w > plan.w || r.y + r.h > plan.h) out.push({ id: r.id, msg: `${r.name} keluar dari batas denah` });
    for (const d of r.doors || []) {
      const len = d.s === 't' || d.s === 'b' ? r.w : r.h;
      if (d.at < 1 || d.at + (d.w || 3) > len - 1) out.push({ id: r.id, msg: `Pintu ${r.name} tidak pas di dinding` });
    }
  }
  for (let i = 0; i < rooms.length; i++) for (let k = i + 1; k < rooms.length; k++) {
    const a = rooms[i], b = rooms[k];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 1 && oy > 1) out.push({ id: a.id, other: b.id, msg: `${a.name} menabrak ${b.name}` });
  }
  return out;
}

/** Walk grid of a plan: which tiles can be stood on, and which of them the lobby reaches. Null without rooms. */
function reach(plan) {
  const W = plan.w, H = plan.h, rooms = plan.rooms.filter(r => r.kind !== 'zone');
  const walk = new Uint8Array(W * H), inRoom = new Int16Array(W * H).fill(-1);
  const at = (x, y) => y * W + x, ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  rooms.forEach((r, i) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (ok(x, y)) inRoom[at(x, y)] = i; });
  for (let i = 0; i < W * H; i++) if (inRoom[i] === -1) walk[i] = 1;
  for (const r of rooms) for (let y = r.y + WH; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (ok(x, y)) walk[at(x, y)] = 1;
  for (const r of rooms) {
    for (let x = r.x; x < r.x + r.w; x++) { for (let y = r.y; y < r.y + WH; y++) if (ok(x, y)) walk[at(x, y)] = 0; if (ok(x, r.y + r.h - 1)) walk[at(x, r.y + r.h - 1)] = 0; }
    for (let y = r.y; y < r.y + r.h; y++) { if (ok(r.x, y)) walk[at(r.x, y)] = 0; if (ok(r.x + r.w - 1, y)) walk[at(r.x + r.w - 1, y)] = 0; }
  }
  for (const r of rooms) for (const d of r.doors || []) for (let k = 0; k < (d.w || 3); k++) {
    const cells = d.s === 'b' ? [[r.x + d.at + k, r.y + r.h - 1]] : d.s === 't' ? Array.from({ length: WH }, (_, y) => [r.x + d.at + k, r.y + y])
      : d.s === 'l' ? [[r.x, r.y + d.at + k]] : [[r.x + r.w - 1, r.y + d.at + k]];
    for (const [x, y] of cells) if (ok(x, y)) walk[at(x, y)] = 1;
  }
  const lobby = rooms.find(r => r.kind === 'lobby') || rooms[0];
  if (!lobby) return null;
  const seen = new Uint8Array(W * H), q = [];
  const sx = lobby.x + Math.floor(lobby.w / 2), sy = lobby.y + WH + 1;
  if (ok(sx, sy) && walk[at(sx, sy)]) { seen[at(sx, sy)] = 1; q.push(at(sx, sy)); }
  while (q.length) {
    const i = q.pop(), x = i % W, y = (i - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (ok(nx, ny) && walk[at(nx, ny)] && !seen[at(nx, ny)]) { seen[at(nx, ny)] = 1; q.push(at(nx, ny)); }
  }
  return { rooms, lobby, inRoom, seen, ok, at };
}

/** Rooms nobody can walk into from the lobby (a door facing a wall, or no door at all). Warnings only. */
export function unreachable(plan) {
  const g = reach(plan); if (!g) return [];
  return g.rooms.filter(r => {
    if (r === g.lobby) return false;
    for (let y = r.y + WH; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (g.ok(x, y) && g.seen[g.at(x, y)]) return false;
    return true;
  }).map(r => ({ id: r.id, msg: `${r.name} tidak bisa dimasuki dari lobi` }));
}

/* ---------- pure layout logic (no DOM) ---------- */
const cloneP = pl => ({ ...pl, rooms: pl.rooms.map(r => ({ ...r, doors: r.doors && r.doors.map(d => ({ ...d })) })) });
const hit = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
function grow(pl, r) { pl.w = Math.min(MAX_PLAN, Math.max(pl.w, r.x + r.w)); pl.h = Math.min(MAX_PLAN, Math.max(pl.h, r.y + r.h)); }
function fitDoors(r) {
  for (const d of r.doors || []) { const len = d.s === 't' || d.s === 'b' ? r.w : r.h; d.w = Math.max(2, Math.min(6, d.w || 3)); d.at = Math.max(1, Math.min(d.at, len - 1 - d.w)); }
}
/** Move a room; zones painted on it (open-plan areas) go along. */
function moveRoom(pl, r, x, y) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  const dx = x - r.x, dy = y - r.y; if (!dx && !dy) return false;
  r.x = x; r.y = y;
  for (const z of pl.rooms) if (z.kind === 'zone' && z.zoneOf === r.id) { z.x += dx; if (z.y !== undefined) z.y += dy; }
  grow(pl, r); return true;
}

/**
 * Best snap for a set of moving edges on one axis. edges: [{v, side:'lo'|'hi'}]; perp = the moving rect's span on the other axis.
 * Targets per neighbour: same edge (align), shared wall (1 tile overlap) and the standard corridor gap.
 */
function snapAxis(edges, others, ax, thr, perp) {
  const P = ax === 'x' ? 'y' : 'x', D = ax === 'x' ? 'w' : 'h', E = ax === 'x' ? 'h' : 'w';
  let best = null;
  for (const o of others) {
    if (Math.max(o[P] - perp[1], perp[0] - (o[P] + o[E])) > 10) continue;   // too far across to look related
    const lo = o[ax], hi = lo + o[D];
    for (const e of edges) for (const t of e.side === 'lo' ? [lo, hi - 1, hi + CORR] : [hi, lo + 1, lo - CORR]) {
      const d = t - e.v;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t, o, ax, a: Math.min(perp[0], o[P]), b: Math.max(perp[1], o[P] + o[E]) };
    }
  }
  return best;
}

/**
 * Settle collisions after room `id` changed: whoever it overlaps is shoved away along the smallest way out
 * (keeping the corridor it had before, else sharing a wall), and that room then pushes its own neighbours.
 * The lobby never moves; a room that runs into it backs off instead. Returns the ids of rooms that were moved.
 */
function resolvePush(pl, id, orig, hidden) {
  const rooms = pl.rooms.filter(r => r.kind !== 'zone' && !hidden.has(r.id) && !hidden.has(r.zoneOf));
  const byId = i => rooms.find(r => r.id === i), o0 = i => orig.rooms.find(r => r.id === i);
  const pushed = new Set(), queue = [id];
  // corridor to keep when `m` ends up on side `dir` of `a`: what it had on that side before, if that was a real corridor
  const gap = (a, m, dir) => {
    const A = o0(a.id), M = o0(m.id); if (!A || !M) return -1;
    const horiz = dir === 'r' || dir === 'l';
    const across = horiz ? Math.min(A.y + A.h, M.y + M.h) - Math.max(A.y, M.y) : Math.min(A.x + A.w, M.x + M.w) - Math.max(A.x, M.x);
    if (across <= 1) return -1;
    const g = dir === 'r' ? M.x - (A.x + A.w) : dir === 'l' ? A.x - (M.x + M.w) : dir === 'd' ? M.y - (A.y + A.h) : A.y - (M.y + M.h);
    return g >= CORR ? Math.min(g, 7) : -1;
  };
  for (let guard = 0; queue.length && guard < 800; guard++) {
    const P = byId(queue.shift()); if (!P) continue;
    for (const Q of rooms) {
      if (Q === P || !hit(P, Q)) continue;
      const [m, a] = Q.kind === 'lobby' && P.kind !== 'lobby' ? [P, Q] : [Q, P];
      const opts = [
        ['d', a.y + a.h + gap(a, m, 'd'), 'y'], ['r', a.x + a.w + gap(a, m, 'r'), 'x'],
        ['u', a.y - gap(a, m, 'u') - m.h, 'y'], ['l', a.x - gap(a, m, 'l') - m.w, 'x'],
      ].filter(([, v]) => v >= 0).sort((p, q) => Math.abs(p[1] - m[p[2]]) - Math.abs(q[1] - m[q[2]]));
      const [, v, k] = opts[0];
      moveRoom(pl, m, k === 'x' ? v : m.x, k === 'y' ? v : m.y);
      pushed.add(m.id); queue.push(m.id);
      if (m === P) break;
    }
  }
  pushed.delete(id);
  return pushed;
}

/** The tiles just outside a door. */
function doorsOutside(r, d) {
  const n = d.w || 3;
  return Array.from({ length: n }, (_, k) => d.s === 'b' ? [r.x + d.at + k, r.y + r.h] : d.s === 't' ? [r.x + d.at + k, r.y - 1]
    : d.s === 'l' ? [r.x - 1, r.y + d.at + k] : [r.x + r.w, r.y + d.at + k]);
}
function corridorAt(g, x, y) {
  if (!g.ok(x, y)) return false;
  const i = g.at(x, y);
  return !!g.seen[i] && (g.inRoom[i] === -1 || g.rooms[g.inRoom[i]] === g.lobby);
}
/** Rooms (not the lobby) with no door that opens onto a corridor the lobby can reach. */
function closedRooms(pl) {
  const g = reach(pl); if (!g) return new Set();
  return new Set(g.rooms.filter(r => r !== g.lobby && !(r.doors || []).some(d => doorsOutside(r, d).some(([x, y]) => corridorAt(g, x, y)))).map(r => r.id));
}
/**
 * Move the door of every room that has none opening onto a connected corridor to the nearest spot (any side) that does.
 * Only rooms in `ids`, or ones that were open before the edit (`before` = closed ids then), are touched. Returns the rooms changed.
 */
function openDoors(pl, before, ids) {
  const g = reach(pl); if (!g) return [];
  const closed = closedRooms(pl), fixed = [];
  for (const r of g.rooms) {
    if (r === g.lobby || !closed.has(r.id) || !(ids.has(r.id) || !before.has(r.id))) continue;
    const old = r.doors?.[0], w = Math.max(2, Math.min(6, old?.w || 3));
    const oc = old ? (old.s === 't' || old.s === 'b' ? [r.x + old.at + w / 2, old.s === 't' ? r.y : r.y + r.h] : [old.s === 'l' ? r.x : r.x + r.w, r.y + old.at + w / 2]) : [r.x + r.w / 2, r.y + r.h];
    let best = null;
    for (const [s] of SIDES) {
      const horiz = s === 't' || s === 'b', lo = horiz ? 1 : WH, hi = (horiz ? r.w : r.h) - 1 - w;
      for (let at = lo; at <= hi; at++) {
        const d = { s, at, w };
        if (!doorsOutside(r, d).every(([x, y]) => corridorAt(g, x, y))) continue;
        const c = horiz ? [r.x + at + w / 2, s === 't' ? r.y : r.y + r.h] : [s === 'l' ? r.x : r.x + r.w, r.y + at + w / 2];
        const cost = Math.abs(c[0] - oc[0]) + Math.abs(c[1] - oc[1]);
        if (!best || cost < best.cost) best = { cost, d };
      }
    }
    if (best) { if (old) r.doors[0] = best.d; else (r.doors ||= []).push(best.d); fixed.push(r); }
  }
  return fixed;
}

/**
 * Re-pack every room except the lobby into tidy rows right of it, corridors between row pairs (row 1 faces down,
 * row 2 faces up, like the generated plans). Keeps sizes and the rough top-left to bottom-right order.
 */
function tidyPlan(pl, hidden) {
  const vis = pl.rooms.filter(r => r.kind !== 'zone' && !hidden.has(r.id));
  const lobby = vis.find(r => r.kind === 'lobby'), rest = vis.filter(r => r !== lobby).sort((a, b) => a.y - b.y || a.x - b.x);
  const bands = [];
  for (const r of rest) { const b = bands.at(-1); if (b && r.y - b[0].y <= Math.max(6, b[0].h * .5)) b.push(r); else bands.push([r]); }
  const order = bands.flatMap(b => b.sort((p, q) => p.x - q.x));
  const total = order.reduce((s, r) => s + r.w - 1, 0), nRows = Math.max(1, Math.ceil(total / 112)), target = Math.ceil(total / nRows) + 10;
  const rows = [[]]; let acc = 0;
  for (const r of order) { if (acc + r.w - 1 > target && rows.at(-1).length) { rows.push([]); acc = 0; } rows.at(-1).push(r); acc += r.w - 1; }
  if (lobby) moveRoom(pl, lobby, 0, 0);
  const x0 = lobby ? lobby.x + lobby.w - 1 : 0, corridors = [];
  let y = 0, right = x0 + 1;
  rows.forEach((row, i) => {
    const down = i % 2 === 0, hMax = Math.max(...row.map(r => r.h)); let x = x0;
    for (const r of row) {
      moveRoom(pl, r, x, down ? y + hMax - r.h : y);
      const face = down ? 'b' : 't', keep = (r.doors || []).filter(d => d.s === face);
      r.doors = keep.length ? keep : [{ s: face, at: Math.max(1, Math.floor(r.w / 2) - 1), w: 3 }];
      fitDoors(r); x += r.w - 1; right = Math.max(right, x + 1);
    }
    y += hMax;
    if (down) { corridors.push(y); y += 7; }
  });
  if (lobby) {
    lobby.h = Math.max(30, y);
    lobby.doors = [...(lobby.doors || []).filter(d => d.s !== 'r'), ...corridors.map(cy => ({ s: 'r', at: cy + 2 - lobby.y, w: 3 }))];
  }
  pl.w = Math.min(MAX_PLAN, Math.max(20, right)); pl.h = Math.min(MAX_PLAN, Math.max(30, y));
  pl.runners = corridors.map(cy => ({ x: (x0 + 1) * 8, y: (cy + 3) * 8 - 2, w: (pl.w - x0 - 1) * 8, h: 12 }));
  pl.decor = corridors.flatMap((cy, i) => [...Array.from({ length: Math.max(0, Math.ceil((pl.w - 3 - (x0 + 5)) / 22)) }, (_, k) => { const x = x0 + 5 + k * 22; return { t: (x / 22 | 0) % 3 === 1 ? 'bench' : 'plant', x, y: cy + (i % 2 ? 5 : 1) }; }), { t: 'vending', x: pl.w - 4, y: cy + 1 }]);
  pl.wings = [];
}

/**
 * Furniture goes with its room: for every room that moved without changing size, shift the items that stood in it.
 * (A resize keeps items where they are.) Returns the same array when nothing moved.
 */
function carryFurn(base, list, now) {
  const move = new Map();
  for (const r of now.rooms) {
    const b = r.kind !== 'zone' && base.rooms.find(x => x.id === r.id);
    if (b && b.w === r.w && b.h === r.h && (b.x !== r.x || b.y !== r.y)) move.set(r.id, [r.x - b.x, r.y - b.y]);
  }
  if (!move.size || !list.length) return list;
  const rooms = base.rooms.filter(r => r.kind !== 'zone');
  return list.map(f => {
    const own = rooms.find(r => f.x > r.x && f.x < r.x + r.w - 1 && f.y >= r.y + WH && f.y < r.y + r.h - 1) || rooms.find(r => f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h);
    const d = own && move.get(own.id);
    return d ? { ...f, x: f.x + d[0], y: f.y + d[1] } : f;
  });
}

/**
 * Open the editor over a stage. opts: { office, stage, host (the #stage element), onDone(plan|null) }.
 * Returns { close } so the caller can drop it when the view unmounts.
 */
export function openLayoutEditor({ office, stage, host, onDone }) {
  const start = structuredClone(office.plan);
  let plan = structuredClone(office.plan);
  let hidden = new Set(), sel = null, drag = null, raf = 0, dirty = false, busy = false, guides = [];
  const opts = { snap: true, push: true };
  // placed furniture [{uid,item,x,y}] (absolute tiles) edits together with the plan: same undo, same save
  let furn = structuredClone(office.plan.furniture || []), mode = 'room', furnDirty = false;
  const furn0 = JSON.stringify(furn);
  const undo = [], snap = () => { undo.push({ plan: structuredClone(plan), hidden: [...hidden], furn: structuredClone(furn) }); if (undo.length > 60) undo.shift(); };
  // rooms the office has but this plan already left out are not in office.plan; hidden here = hidden while editing
  const allRooms = () => plan.rooms.filter(r => r.kind !== 'zone');

  stage.setEditing(true);
  // keep the floor plan clear of the settings panel (it floats over the left side, or the bottom on phones)
  const prevInsets = stage.insets, narrow = matchMedia('(max-width: 760px)').matches;
  stage.setInsets(narrow ? { bottom: Math.round(host.clientHeight * .48) + 10 } : { left: 348 });
  const layer = document.createElement('div');
  layer.className = 'le-layer';
  host.appendChild(layer);
  const gl = document.createElement('div');
  gl.className = 'le-guides';
  host.appendChild(gl);
  const panel = document.createElement('aside');
  panel.className = 'le-panel';
  panel.setAttribute('aria-label', 'Atur denah');
  host.parentElement.appendChild(panel);
  host.closest('.kf2')?.classList.add('le-on');
  const F = createFurnitureEditor({
    stage, layer, office, host,
    get nav() { return nav; },
    furn: () => furn,
    setFurn(list) { furn = list; furnDirty = true; dirty = true; stage.setFurniture?.(furn); redraw(); refresh(); F.render(); },
    record: () => snap(),
    rooms: () => plan.rooms.filter(r => r.kind !== 'zone' && !hidden.has(r.id) && !hidden.has(r.zoneOf)),
    selRoom: () => sel,
    selectRoom: id => select(id),
    refresh: () => refresh(),
    addedRoom: addRoomLocal,
  });
  host.appendChild(F.el);

  /* ---------- canvas sync ---------- */
  const shown = () => !hidden.size ? furn : furn.filter(f => !plan.rooms.some(r => hidden.has(r.id) && f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h));
  const visiblePlan = () => ({ ...plan, furniture: shown(), rooms: plan.rooms.filter(r => !hidden.has(r.id) && !hidden.has(r.zoneOf)) });
  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; stage.rebuild(visiblePlan(), office.roles, { keepCam: true }); stage.setFurniture?.(shown()); F.render(); place(); });
  }

  /* ---------- handles ---------- */
  function boxes() {
    const bad = new Set([...blockers(visiblePlan()).flatMap(p => [p.id, p.other])]);
    const lost = new Set(unreachable(visiblePlan()).map(p => p.id));
    layer.innerHTML = allRooms().filter(r => !hidden.has(r.id)).map(r => `
      <div class="le-room${sel === r.id ? ' sel' : ''}${bad.has(r.id) ? ' bad' : lost.has(r.id) ? ' lost' : ''}" data-le-room="${esc(r.id)}" tabindex="-1">
        <span class="le-name">${esc(r.name)}</span><span class="le-size">${r.w}×${r.h}</span>
        ${(r.doors || []).map((d, i) => `<i class="le-door s-${d.s}" data-door="${i}"></i>`).join('')}
        ${sel === r.id && mode === 'room' ? HANDLES.map(h => `<span class="le-h h-${h}" data-le-h="${h}" title="Seret untuk mengubah ukuran"></span>`).join('') : ''}
      </div>`).join('');
    place();
  }
  function place() {
    const s = stage.scale(), live = drag && drag.kind !== 'pan' && drag.moved ? new Set(blockers(visiblePlan()).flatMap(p => [p.id, p.other])) : null;
    for (const el of layer.children) {
      const r = plan.rooms.find(x => x.id === el.dataset.leRoom); if (!r) continue;
      const [x, y] = stage.toScreen(r.x, r.y);
      el.style.transform = `translate(${x}px,${y}px)`; el.style.width = r.w * s + 'px'; el.style.height = r.h * s + 'px';
      el.classList.toggle('tiny', r.w * s < 70);
      el.querySelector('.le-size').textContent = `${r.w}×${r.h}`;
      el.classList.toggle('push', !!drag?.pushed?.has(r.id));
      if (live) el.classList.toggle('bad', live.has(r.id));
      for (const d of el.querySelectorAll('.le-door')) {
        const dd = r.doors[Number(d.dataset.door)]; if (!dd) continue;
        const along = dd.at * s, len = (dd.w || 3) * s;
        Object.assign(d.style, dd.s === 't' || dd.s === 'b' ? { left: along + 'px', width: len + 'px', height: '', top: '' } : { top: along + 'px', height: len + 'px', width: '', left: '' });
      }
    }
    overlay(s);
    F.place();
  }
  /** Snap guide lines + the live size / position badge while dragging. */
  function overlay(s) {
    let html = '';
    if (drag && drag.kind !== 'pan' && drag.moved) {
      for (const g of guides) {
        const [x, y] = stage.toScreen(g.ax === 'x' ? g.t : g.a, g.ax === 'x' ? g.a : g.t);
        html += g.ax === 'x' ? `<i class="le-guide v" style="left:${x}px;top:${y}px;height:${(g.b - g.a) * s}px"></i>` : `<i class="le-guide h" style="left:${x}px;top:${y}px;width:${(g.b - g.a) * s}px"></i>`;
      }
      const r = room(drag.id), [x, y] = stage.toScreen(r.x + r.w / 2, r.y);
      html += `<b class="le-badge${y < 36 ? ' in' : ''}" style="left:${x}px;top:${y}px">${drag.kind === 'size' ? `${r.w}×${r.h}` : `${r.x}, ${r.y}`}</b>`;
    }
    gl.innerHTML = html;
  }
  const offFrame = stage.onFrame(place);

  /* ---------- panel ---------- */
  function renderPanel() {
    if (tpl) { const top = panel.scrollTop; panel.innerHTML = tplPanel(); panel.scrollTop = top; return; }
    const v = visiblePlan(), bl = blockers(v), un = unreachable(v);
    const r = sel && plan.rooms.find(x => x.id === sel);
    const hiddenRooms = plan.rooms.filter(x => hidden.has(x.id));
    const top = panel.scrollTop;
    const lost = furn.filter(f => !plan.rooms.some(x => x.kind !== 'zone' && f.x >= x.x && f.x < x.x + x.w && f.y >= x.y && f.y < x.y + x.h)).length;
    const roomBody = `${r ? roomForm(r) : '<p class="le-empty">Klik sebuah ruangan untuk mengatur pintu, lantai, dan ukurannya.</p>'}
      <section class="le-sec"><h3>Denah</h3>
        <div class="le-grid"><label>Lebar<input type="number" data-le-plan="w" value="${plan.w}" min="20" max="${MAX_PLAN}"></label>
        <label>Tinggi<input type="number" data-le-plan="h" value="${plan.h}" min="20" max="${MAX_PLAN}"></label></div>
        <button class="btn sm" data-le="fit" type="button">Pangkas ke isi</button></section>
      ${hiddenRooms.length ? `<section class="le-sec"><h3>Disembunyikan</h3><ul class="le-list">${hiddenRooms.map(x => `<li><span>${esc(x.name)}</span><button class="btn sm" data-le="unhide" data-id="${esc(x.id)}" type="button">Tampilkan</button></li>`).join('')}</ul></section>` : ''}`;
    panel.innerHTML = `
      <div class="le-head"><p class="eyebrow">Atur denah</p><h2>${esc(office.name)}</h2>
        <div class="le-tabs" role="tablist">
          <button type="button" role="tab" class="le-tab" aria-selected="${mode === 'room'}" data-le="mode" data-m="room">Ruangan</button>
          <button type="button" role="tab" class="le-tab" aria-selected="${mode === 'furn'}" data-le="mode" data-m="furn">Perabot</button></div>
        ${mode === 'room' ? `<p class="hint">Seret ruangan untuk memindah; pilih ruangan lalu seret gagang di tepi atau sudutnya untuk mengubah ukuran. Seret area kosong untuk menggeser pandangan. Panah menggeser ruangan terpilih, Ctrl+Z membatalkan. Tahan Alt untuk menonaktifkan tempel sementara. Perabot ikut pindah bersama ruangannya.</p>
        <div class="le-tools">
          <button class="le-tog" type="button" data-le="tog-snap" aria-pressed="${opts.snap}" title="Tepi menempel ke ruangan tetangga">Tempel</button>
          <button class="le-tog" type="button" data-le="tog-push" aria-pressed="${opts.push}" title="Ruangan yang tertabrak ikut bergeser">Dorong</button>
          <button class="btn sm" type="button" data-le="tidy" title="Susun ulang semua ruangan ke baris rapi">Rapikan otomatis</button>
          <button class="btn sm" type="button" data-le="tpl-open" title="Ganti seluruh susunan dan perabot dengan template bertema">Terapkan template</button></div>` : ''}</div>
      ${mode === 'room' ? roomBody : F.panelHTML()}
      <section class="le-sec le-check">${bl.length ? `<h3 class="bad">Belum bisa disimpan</h3><ul>${bl.slice(0, 6).map(p => `<li><button type="button" data-le="pick" data-id="${esc(p.id)}">${esc(p.msg)}</button></li>`).join('')}${bl.length > 6 ? `<li>+${bl.length - 6} lagi</li>` : ''}</ul>`
        : '<h3 class="ok">Tidak ada yang bertabrakan</h3>'}
        ${un.length ? `<h3 class="warn">Peringatan</h3><ul>${un.map(p => `<li><button type="button" data-le="pick" data-id="${esc(p.id)}">${esc(p.msg)}</button></li>`).join('')}</ul><p class="hint">Agen tidak bisa berjalan masuk. Tambah atau geser pintunya ke arah koridor.</p>` : ''}
        ${lost ? `<h3 class="warn">${lost} perabot di luar ruangan</h3><p class="hint">Perabot yang tidak berada di dalam ruangan dibuang saat disimpan.</p>` : ''}</section>
      <div class="le-actions">
        <button class="btn primary" data-le="save" type="button" ${bl.length || busy ? 'disabled' : ''}>${busy ? 'Menyimpan…' : 'Simpan denah'}</button>
        <button class="btn" data-le="cancel" type="button">Batal</button>
        <button class="btn sm" data-le="undo" type="button" ${undo.length ? '' : 'disabled'}>Urungkan</button>
        ${office.custom && mode === 'room' ? '<button class="btn sm danger" data-le="reset" type="button">Kembalikan denah bawaan</button>' : ''}
      </div>`;
    panel.scrollTop = top;
    if (mode === 'furn') F.afterPanel(panel);
  }
  function roomForm(r) {
    const doors = r.doors || [];
    return `<section class="le-sec"><h3>${esc(r.name)}</h3>
      <div class="le-grid">${['x', 'y', 'w', 'h'].map(k => `<label>${{ x: 'Kiri', y: 'Atas', w: 'Lebar', h: 'Tinggi' }[k]}<input type="number" data-le-geo="${k}" value="${r[k]}" min="${k === 'w' || k === 'h' ? MIN : 0}"></label>`).join('')}</div>
      <label class="le-row">Lantai<select data-le-floor>${FLOORS.map(([v, l]) => `<option value="${v}"${(r.floor || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <h4>Pintu</h4>
      ${doors.length ? `<ul class="le-doors">${doors.map((d, i) => `<li>
        <select data-le-door="${i}" data-k="s" aria-label="Sisi pintu">${SIDES.map(([v, l]) => `<option value="${v}"${d.s === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label>posisi<input type="number" data-le-door="${i}" data-k="at" value="${d.at}" min="1"></label>
        <label>lebar<input type="number" data-le-door="${i}" data-k="w" value="${d.w || 3}" min="2" max="6"></label>
        <button class="btn sm" data-le="door-del" data-i="${i}" type="button" aria-label="Hapus pintu">✕</button></li>`).join('')}</ul>` : '<p class="hint">Belum ada pintu.</p>'}
      <div class="btn-row"><button class="btn sm" data-le="door-add" type="button">+ Pintu</button>
        ${FIXED.has(r.kind) ? '' : '<button class="btn sm" data-le="hide" type="button">Sembunyikan ruangan</button>'}</div>
    </section>`;
  }
  const refresh = () => { boxes(); renderPanel(); };
  const changed = () => { dirty = true; redraw(); refresh(); };

  /* ---------- editing helpers ---------- */
  const room = id => plan.rooms.find(r => r.id === id);
  const visibleOf = pl => ({ ...pl, rooms: pl.rooms.filter(r => !hidden.has(r.id) && !hidden.has(r.zoneOf)) });
  function fitPlan() {
    const rs = allRooms().filter(r => !hidden.has(r.id));
    plan.w = Math.max(20, ...rs.map(r => r.x + r.w)); plan.h = Math.max(20, ...rs.map(r => r.y + r.h));
  }
  function select(id) { sel = id; stage.select(id); refresh(); }
  /** After room `id` changed (plan already holds the new geometry): push neighbours aside, then reopen doors that got walled in. */
  function settle(base, id, pushed) {
    pushed = pushed || (opts.push ? resolvePush(plan, id, base, hidden) : new Set());
    const ids = new Set([id, ...pushed]);
    const fixed = openDoors(visiblePlan(), closedRooms(visibleOf(base)), ids);
    if (pushed.size) toast(`${pushed.size} ruangan ikut bergeser`, 'ok');
    if (fixed.length) toast(`Pintu ${fixed.map(r => r.name).slice(0, 3).join(', ')}${fixed.length > 3 ? ` +${fixed.length - 3}` : ''} dipindah ke koridor`, 'ok');
  }

  /* ---------- pointer ---------- */
  const nav = stage.touchNav(layer);
  layer.addEventListener('contextmenu', e => e.preventDefault());
  layer.addEventListener('pointerdown', e => {
    if (mode === 'furn') return F.down(e, nav);
    if (e.button !== 0) return;
    nav.down(e);
    if (nav.size > 1) { layer.setPointerCapture(e.pointerId); endDrag(); e.preventDefault(); return; }   // second finger: pinch
    const hd = e.target.closest('[data-le-h]'), box = e.target.closest('[data-le-room]');
    if (box) {
      const r = room(box.dataset.leRoom);
      snap();
      drag = { kind: hd ? 'size' : 'move', id: r.id, dir: hd?.dataset.leH, base: cloneP(plan), furn0: furn, t0: stage.toTile(e.clientX, e.clientY), r0: { x: r.x, y: r.y, w: r.w, h: r.h },
        moved: false, pushed: new Set(), sx: e.clientX, sy: e.clientY, slop: e.pointerType === 'mouse' ? 0 : 8 };
      if (sel !== r.id) select(r.id);
    } else drag = { kind: 'pan', px: e.clientX, py: e.clientY, touch: e.pointerType !== 'mouse' };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  /** Rebuild `plan` from the drag's starting plan + the pointer offset: snap, resize or move, then shove whoever is in the way. */
  function applyDrag(dx, dy, snapOn) {
    const b = drag.base, o = drag.r0, id = drag.id;
    plan = cloneP(b);
    const r = room(id), s = stage.scale(), thr = Math.min(6, Math.max(2, Math.ceil(10 / s)));
    const others = b.rooms.filter(x => x.kind !== 'zone' && x.id !== id && !hidden.has(x.id) && !hidden.has(x.zoneOf));
    guides = [];
    const take = g => { if (g) guides.push(g); return g ? g.d : 0; };
    if (drag.kind === 'move') {
      let x = Math.max(0, o.x + dx), y = Math.max(0, o.y + dy);
      if (snapOn) {
        x = Math.max(0, x + take(snapAxis([{ v: x, side: 'lo' }, { v: x + o.w, side: 'hi' }], others, 'x', thr, [y, y + o.h])));
        y = Math.max(0, y + take(snapAxis([{ v: y, side: 'lo' }, { v: y + o.h, side: 'hi' }], others, 'y', thr, [x, x + o.w])));
      }
      moveRoom(plan, r, x, y);
    } else {
      const d = drag.dir;
      let L = o.x, R = o.x + o.w, T = o.y, B = o.y + o.h;
      if (d.includes('w')) L = Math.max(0, L + dx); if (d.includes('e')) R += dx;
      if (d.includes('n')) T = Math.max(0, T + dy); if (d.includes('s')) B += dy;
      if (snapOn) {
        const px = [T, B], py = [L, R];
        if (d.includes('w')) L = Math.max(0, L + take(snapAxis([{ v: L, side: 'lo' }], others, 'x', thr, px)));
        if (d.includes('e')) R += take(snapAxis([{ v: R, side: 'hi' }], others, 'x', thr, px));
        if (d.includes('n')) T = Math.max(0, T + take(snapAxis([{ v: T, side: 'lo' }], others, 'y', thr, py)));
        if (d.includes('s')) B += take(snapAxis([{ v: B, side: 'hi' }], others, 'y', thr, py));
      }
      if (d.includes('w')) L = Math.min(L, o.x + o.w - MIN); else R = Math.max(R, o.x + MIN);
      if (d.includes('n')) T = Math.min(T, o.y + o.h - MIN); else B = Math.max(B, o.y + MIN);
      if (d.includes('w') && d.includes('e')) R = Math.max(R, L + MIN);
      const br = b.rooms.find(x => x.id === id);
      r.x = L; r.y = T; r.w = R - L; r.h = B - T;
      // doors keep their place in the world while the room's origin moves under them
      r.doors = (br.doors || []).map(dd => ({ ...dd, at: dd.s === 't' || dd.s === 'b' ? dd.at - (L - br.x) : dd.at - (T - br.y) }));
      fitDoors(r); grow(plan, r);
    }
    drag.moved = r.x !== o.x || r.y !== o.y || r.w !== o.w || r.h !== o.h;
    drag.pushed = drag.moved && opts.push ? resolvePush(plan, id, b, hidden) : new Set();
    furn = carryFurn(b, drag.furn0, plan);
  }
  layer.addEventListener('pointermove', e => {
    if (mode === 'furn') return F.move(e, nav);
    if (nav.move(e)) return;
    if (!drag) return;
    if (drag.kind === 'pan') { stage.panBy(e.clientX - drag.px, e.clientY - drag.py); drag.px = e.clientX; drag.py = e.clientY; return; }
    if (!drag.started && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < drag.slop) return;   // finger jitter is not a drag
    drag.started = true;
    const t = stage.toTile(e.clientX, e.clientY);
    applyDrag(Math.round(t.x - drag.t0.x), Math.round(t.y - drag.t0.y), opts.snap && !e.altKey);
    if (drag.moved) dirty = true;
    redraw();
  });
  function endDrag() {
    if (!drag) return;
    const d = drag; drag = null; guides = [];
    if (d.kind !== 'pan') {
      if (!d.moved) { undo.pop(); plan = d.base; furn = d.furn0; } else { settle(d.base, d.id, d.pushed); furn = carryFurn(d.base, d.furn0, plan); if (furn !== d.furn0) furnDirty = true; }
      redraw();
    }
    if (d.moved) refresh(); else place();
  }
  layer.addEventListener('pointerup', e => { if (mode === 'furn') return F.up(e, nav); nav.up(e, drag && drag.kind === 'pan' && drag.touch); endDrag(); });
  layer.addEventListener('pointercancel', e => { if (mode === 'furn') return F.cancel(e, nav); nav.up(e, false); endDrag(); });
  layer.addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const b = layer.getBoundingClientRect(); stage.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - b.left, e.clientY - b.top); }, { passive: false });

  /* ---------- panel inputs ---------- */
  panel.addEventListener('change', e => {
    const t = e.target, r = sel && room(sel);
    if (t.dataset.lf !== undefined) return F.panelChange(panel, e);
    if (t.dataset.lePlan) { snap(); plan[t.dataset.lePlan] = Math.max(20, Math.min(MAX_PLAN, Math.round(Number(t.value) || 0))); return changed(); }
    if (!r) return;
    snap();
    if (t.dataset.leGeo) {
      const k = t.dataset.leGeo, v = Math.round(Number(t.value) || 0), base = cloneP(plan);
      if (k === 'x' || k === 'y') moveRoom(plan, r, k === 'x' ? v : r.x, k === 'y' ? v : r.y);
      else { r[k] = Math.max(MIN, v); fitDoors(r); grow(plan, r); }
      settle(base, r.id); furn = carryFurn(base, furn, plan);
    } else if (t.matches('[data-le-floor]')) r.floor = t.value;
    else if (t.dataset.leDoor !== undefined) {
      const d = r.doors[Number(t.dataset.leDoor)], k = t.dataset.k;
      d[k] = k === 's' ? t.value : Math.round(Number(t.value) || 0);
      fitDoors(r);
    }
    changed();
  });
  panel.addEventListener('input', e => { if (e.target.dataset.lf !== undefined) F.panelInput(panel, e); });
  panel.addEventListener('pointerdown', e => F.panelDown(e));
  panel.addEventListener('scroll', e => { if (e.target.dataset?.lfPal !== undefined) F.onPalScroll(e.target.scrollTop); }, true);
  panel.addEventListener('click', async e => {
    const card = e.target.closest('[data-tpl]');
    if (card && tpl) { if (!tpl.busy) previewTpl(card.dataset.tpl, tpl.sel === card.dataset.tpl ? tpl.seed : 1); return; }
    if (e.target.closest('[data-lf]')) return F.panelClick(panel, e);
    const b = e.target.closest('[data-le]'); if (!b || b.disabled) return;
    const r = sel && room(sel);
    switch (b.dataset.le) {
      case 'pick': select(b.dataset.id); stage.focusRoom?.(b.dataset.id); break;
      case 'door-add': { snap(); const side = r.doors?.[0]?.s === 'b' ? 't' : 'b'; (r.doors ||= []).push({ s: side, at: Math.max(1, Math.floor(r.w / 2) - 1), w: 3 }); fitDoors(r); changed(); break; }
      case 'door-del': snap(); r.doors.splice(Number(b.dataset.i), 1); changed(); break;
      case 'hide': snap(); hidden.add(r.id); sel = null; changed(); break;
      case 'unhide': snap(); hidden.delete(b.dataset.id); changed(); break;
      case 'fit': snap(); fitPlan(); changed(); break;
      case 'tog-snap': opts.snap = !opts.snap; renderPanel(); break;
      case 'tog-push': opts.push = !opts.push; renderPanel(); break;
      case 'mode': setMode(b.dataset.m); break;
      case 'tpl-open': openTpl(); break;
      case 'tpl-roll': if (tpl?.sel) previewTpl(tpl.sel, (Math.random() * 1e6) | 0); break;
      case 'tpl-apply': applyTpl(); break;
      case 'tpl-restore': restoreTpl(); break;
      case 'tpl-close': closeTpl(); break;
      case 'tidy': snap(); const tb = cloneP(plan); tidyPlan(plan, hidden); furn = carryFurn(tb, furn, plan); furnDirty = true; dirty = true; toast('Ruangan disusun ulang. Ctrl+Z untuk membatalkan', 'ok'); changed(); break;
      case 'undo': doUndo(); break;
      case 'save': save(); break;
      case 'cancel': cancel(); break;
      case 'reset': confirmDo('Kembalikan denah bawaan?', 'Semua posisi, ukuran, dan pintu yang kamu atur di kantor ini dibuang, lalu denah disusun ulang otomatis.', 'Kembalikan', async () => {
        try { const res = await api(`/api/offices/${office.id}/layout`, { method: 'DELETE' }); close(res.plan, false); toast('Denah kembali ke susunan bawaan', 'ok'); } catch (err) { toast(err.message, 'bad'); }
      }); break;
    }
  });
  function doUndo() {
    const s = undo.pop(); if (!s) return;
    plan = s.plan; hidden = new Set(s.hidden); furn = s.furn; furnDirty = true; if (sel && !room(sel)) sel = null;
    dirty = true; stage.setFurniture?.(furn); redraw(); refresh(); F.render();
  }
  const onKey = e => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (tpl) { if (e.key === 'Escape') { e.preventDefault(); closeTpl(); } return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
    if (mode === 'furn' && F.key(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); if (sel) select(null); else cancel(); return; }
    if (mode === 'furn') return;
    const r = sel && room(sel); if (!r) return;
    const step = e.shiftKey ? 5 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); snap(); const base = cloneP(plan); if (moveRoom(plan, r, r.x + d[0], r.y + d[1])) { settle(base, r.id); furn = carryFurn(base, furn, plan); furnDirty = true; changed(); } else undo.pop(); }
  };
  document.addEventListener('keydown', onKey, true);

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    layer.classList.toggle('fmode', m === 'furn');
    panel.classList.toggle('fm', m === 'furn');
    if (narrow) stage.setInsets({ bottom: Math.round(host.clientHeight * (m === 'furn' ? .64 : .48)) + 10 });
    F.activate(m === 'furn');
    refresh();
  }
  /** A room the server just made (POST rooms): drop it into the plan, in free space if its generated spot collides with edited rooms. */
  function addRoomLocal(nr) {
    nr = structuredClone(nr);
    const others = plan.rooms.filter(r => r.kind !== 'zone');
    if (others.some(r => hit(r, nr))) {
      nr.x = 0; nr.y = Math.max(0, ...others.map(r => r.y + r.h)) + CORR;
      nr.doors = [{ s: 't', at: Math.max(1, Math.floor(nr.w / 2) - 1), w: 3 }];
    }
    plan.rooms.push(nr); grow(plan, nr);
    for (const u of undo) u.plan.rooms.push(structuredClone(nr));   // undo must not drop a room the server already has
    for (const pl of [start, office.plan]) if (pl && !pl.rooms.some(r => r.id === nr.id)) { pl.rooms.push(structuredClone(nr)); grow(pl, nr); }
    dirty = true; sel = nr.id; stage.select(nr.id); redraw(); refresh();
    stage.focusRoom?.(nr.id);
  }

  /* ---------- templates: gallery, live preview on the canvas (nothing saved), apply, restore ---------- */
  let tpl = null;   // { list, sel, seed, pv, busy, state } while the gallery is open
  async function openTpl() {
    tpl = { list: null, sel: null, seed: 1, pv: null, busy: false, state: null };
    layer.hidden = true; F.el.hidden = true; select(null);
    try {
      const [list, state] = await Promise.all([loadTemplates(), api(`/api/offices/${office.id}/template`)]);
      if (!tpl) return;
      tpl.list = list; tpl.state = state;
    } catch (err) { toast(err.message, 'bad'); }
    renderPanel();
  }
  async function previewTpl(id, seed) {
    Object.assign(tpl, { sel: id, seed, busy: true }); renderPanel();
    try {
      const pv = await api(`/api/offices/${office.id}/template/preview`, { method: 'POST', body: { template: id, seed } });
      if (!tpl || tpl.sel !== id || tpl.seed !== seed) return;
      tpl.pv = pv;
      stage.rebuild({ ...pv.plan, furniture: pv.furniture }, office.roles, { keepCam: false });
      stage.setFurniture?.(pv.furniture); stage.fitAll?.();
    } catch (err) { toast(err.message, 'bad'); }
    if (tpl) { tpl.busy = false; renderPanel(); }
  }
  function closeTpl() {
    if (!tpl) return;
    const had = !!tpl.pv; tpl = null;
    layer.hidden = false; F.el.hidden = mode !== 'furn';
    if (had) { stage.rebuild(visiblePlan(), office.roles, { keepCam: false }); stage.setFurniture?.(shown()); stage.fitAll?.(); }
    refresh();
  }
  function applyTpl() {
    const t = tpl?.list?.find(x => x.id === tpl.sel); if (!t || !tpl.pv) return;
    const go = async () => {
      tpl.busy = true; renderPanel();
      try {
        const r = await api(`/api/offices/${office.id}/template/apply`, { method: 'POST', body: { template: t.id, seed: tpl.seed } });
        tpl = null; toast(`Template ${t.name} diterapkan${r.newRooms.length ? `, ${r.newRooms.length} ruangan baru` : ''}`, 'ok');
        close(r.plan, true);
      } catch (err) { if (tpl) { tpl.busy = false; renderPanel(); } toast(err.message, 'bad'); }
    };
    confirmDo(`Terapkan ${t.name}?`, `Susunan ruangan, pintu, lantai, dan semua perabot diganti.${dirty ? ' Perubahan denah yang belum disimpan ikut dibuang.' : ''} Ruangan kode dan penghuninya tetap. Susunan sebelum template pertama disimpan sebagai cadangan dan bisa dipulihkan.`, 'Terapkan', go);
  }
  function restoreTpl() {
    confirmDo('Pulihkan susunan lama?', 'Denah, perabot, dan ruangan tambahan kembali seperti sebelum template pertama diterapkan. Ruangan yang dibuat template dilepas.', 'Pulihkan', async () => {
      try { const r = await api(`/api/offices/${office.id}/template/restore`, { method: 'POST' }); tpl = null; toast('Susunan lama dipulihkan', 'ok'); close(r.plan, r.custom); }
      catch (err) { toast(err.message, 'bad'); }
    });
  }
  function tplPanel() {
    const t = tpl.list?.find(x => x.id === tpl.sel), pv = tpl.pv && tpl.pv.template === tpl.sel ? tpl.pv : null;
    const names = l => l.map(r => esc(r.name)).join(', ');
    return `<div class="le-head"><p class="eyebrow">Suasana kantor</p><h2>${esc(office.name)}</h2>
        <p class="hint">Pilih template untuk melihat pratinjaunya di denah. Belum ada yang disimpan sampai kamu menekan Terapkan. Ruangan kode dan penghuninya tidak dihapus; ruangan fasilitas yang belum ada ditambahkan.</p></div>
      <section class="le-sec">${tpl.list ? galleryHTML(tpl.list, tpl.sel) : '<p class="hint">Memuat template…</p>'}</section>
      ${t ? `<section class="le-sec tpl-sum"><h3>${esc(t.name)} <span class="hint">seed ${tpl.seed}</span></h3>
        ${pv ? `<p class="hint">${pv.plan.w}×${pv.plan.h} tile · ${pv.plan.rooms.filter(r => r.kind !== 'zone').length} ruangan · ${pv.furniture.length} perabot.</p>
          <p class="hint">${pv.newRooms.length ? `Ruangan baru: ${names(pv.newRooms)}.` : 'Tidak ada ruangan baru.'}${pv.dropped.length ? ` Ruangan kosong dari template sebelumnya dilepas: ${esc(pv.dropped.join(', '))}.` : ''}</p>
          ${pv.problems.length ? `<p class="hint bad">${esc(pv.problems.slice(0, 3).join('; '))}</p>` : ''}` : '<p class="hint">Menyusun pratinjau…</p>'}</section>` : ''}
      <div class="le-actions">
        <button class="btn primary" data-le="tpl-apply" type="button" ${!pv || tpl.busy || pv.problems.length ? 'disabled' : ''}>${tpl.busy && pv ? 'Sebentar…' : 'Terapkan'}</button>
        <button class="btn" data-le="tpl-roll" type="button" ${t && !tpl.busy ? '' : 'disabled'} title="Susunan dan perabot lain dengan template yang sama">Acak lagi</button>
        <button class="btn sm" data-le="tpl-close" type="button">Batal</button></div>
      ${tpl.state?.backup ? `<section class="le-sec"><h3>Cadangan</h3><p class="hint">Template ${esc(tpl.state.current?.id || '')} sedang dipakai. Susunan sebelum template pertama tersimpan sejak ${esc(new Date(tpl.state.backup.at).toLocaleString('id-ID'))}.</p>
        <button class="btn sm danger" data-le="tpl-restore" type="button">Pulihkan susunan lama</button></section>` : ''}`;
  }

  /* ---------- save / leave ---------- */
  async function save() {
    const v = visiblePlan();
    if (blockers(v).length) return;
    busy = true; renderPanel();
    // street furniture that a moved room now sits on would block the floor; drop it
    const inside = (x, y) => v.rooms.some(r => r.kind !== 'zone' && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const body = { w: plan.w, h: plan.h, hidden: [...hidden],
      rooms: plan.rooms.map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, floor: r.floor, doors: r.doors || [] })),
      decor: (plan.decor || []).filter(d => !inside(d.x, d.y)),
      runners: plan.runners || [], wings: plan.wings || [] };
    try {
      const res = await api(`/api/offices/${office.id}/layout`, { method: 'PUT', body });
      // furniture only counts inside a room; anything left outside (room shrunk, moved away) is dropped
      const keep = furn.filter(f => plan.rooms.some(r => r.kind !== 'zone' && f.x >= r.x && f.x < r.x + r.w && f.y >= r.y && f.y < r.y + r.h));
      let saved = res.plan.furniture || keep;
      if (JSON.stringify(furn) !== furn0 || furnDirty) {
        try { const fr = await api(`/api/offices/${office.id}/furniture`, { method: 'PUT', body: { items: keep } }); saved = fr.items || keep; }
        catch (err) { toast(`Denah tersimpan, tapi perabot gagal: ${err.message}`, 'bad'); saved = res.plan.furniture || []; }
      }
      res.plan.furniture = saved;
      toast(keep.length < furn.length ? `Denah disimpan, ${furn.length - keep.length} perabot di luar ruangan dibuang` : 'Denah disimpan', 'ok');
      close(res.plan, true);
    } catch (err) { busy = false; renderPanel(); toast(err.message, 'bad'); }
  }
  function cancel() {
    if (!dirty) return close(null);
    confirmDo('Buang perubahan denah?', 'Posisi dan ukuran yang belum disimpan akan hilang.', 'Buang', () => close(null));
  }
  let closed = false;
  function close(newPlan, custom) {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    offFrame(); cancelAnimationFrame(raf);
    F.destroy(); layer.remove(); gl.remove(); panel.remove();
    host.closest('.kf2')?.classList.remove('le-on');
    stage.setEditing(false); stage.select(null); stage.setInsets(prevInsets);
    if (newPlan) { office.plan = newPlan; if (custom !== undefined) office.custom = custom; }
    stage.rebuild(newPlan || start, office.roles, { keepCam: true });
    stage.setFurniture?.((newPlan || start).furniture || []);
    onDone?.(newPlan);
  }

  refresh();
  return { close: () => close(null), get dirty() { return dirty; } };
}
