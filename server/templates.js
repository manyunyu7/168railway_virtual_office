// Office templates ("suasana kantor"): parametric floor plans + themed furniture for any office.
// A template (server/templates/<id>.json) names facility rooms to add, how rooms are arranged (rows, a hub in the middle,
// wide open-plan corridors), which side each group of rooms goes, floors per room kind and a furniture set per room kind.
// generate() turns an office's rooms + roles into {newRooms, layout, furniture, plan}; nothing has fixed coordinates, so the
// same template fits a 2-repo project and an 11-repo one. Deterministic per seed. apply()/restore() write it to the office.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';
import { officeDb, one, all, run, j, nowIso, tx } from './db.js';
import { officeModel, saveLayout, saveFurniture, layoutProblems, invalidate, slug } from './offices.js';
import { FN_WIDTH, FLOOR } from './layout.js';
import { furniture } from './furniture.js';
import { WH, builtIns, fillRoom, deskRects, mulberry, hashStr, unreachableRooms, interior, doorLands, overlap } from '../web/js/furnish-core.js';

export const TEMPLATE_DIR = path.join(ROOT_DIR, 'server', 'templates');
const ROOM_KINDS = ['kode', 'meeting', 'lib', 'qa', 'server', 'pantry', 'beku', 'game', 'manager', 'musik', 'musholla', 'lounge', 'gym', 'taman', 'telepon', 'tidur'];
const FLOORS = ['wood', 'teal', 'teal2', 'wood2', 'carpet', 'carpetGreen', 'marble', 'tile', 'metal', 'plum', 'frozen', 'musholla', 'lounge', 'gymMat', 'grass'];
const DECOR = ['plant', 'bench', 'water', 'vending'];
const ASPECT = 1.6;   // the office view is a wide window

/* ---------------- loading ---------------- */
let cache = null;
function sig() { try { return fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.json')).sort().map(f => `${f}:${fs.statSync(path.join(TEMPLATE_DIR, f)).mtimeMs}`).join('|'); } catch { return ''; } }
/** All templates, validated; a broken file is reported in `problems` and skipped. */
export function templates() {
  const s = sig();
  if (cache && cache.sig === s) return cache;
  const list = [], problems = [];
  let files = [];
  try { files = fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.json')).sort(); } catch {}
  for (const f of files) {
    try { list.push(normalize(JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, f), 'utf8')), f)); }
    catch (e) { problems.push({ file: f, error: e.message }); console.warn('[templates]', f, e.message); }
  }
  list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  cache = { sig: s, list, byId: new Map(list.map(t => [t.id, t])), problems };
  return cache;
}
function normalize(t, file) {
  if (!t || typeof t !== 'object') throw new Error('bukan objek');
  if (!/^[a-z0-9-]{2,40}$/.test(t.id || '')) throw new Error('id harus huruf kecil, angka, -');
  if (!t.name) throw new Error('name kosong');
  const L = t.layout || {};
  if (!['rows', 'hub'].includes(L.strategy || 'rows')) throw new Error(`strategi '${L.strategy}' tak dikenal`);
  for (const f of t.facilities || []) if (!ROOM_KINDS.includes(f.kind)) throw new Error(`jenis ruangan '${f.kind}' tak dikenal`);
  for (const [k, v] of Object.entries(t.floors || {})) for (const fl of [].concat(v)) if (!FLOORS.includes(fl)) throw new Error(`lantai '${fl}' untuk ${k} tak dikenal`);
  for (const d of t.corridorDecor?.items || []) if (!DECOR.includes(d)) throw new Error(`dekor koridor '${d}' tak dikenal`);
  return {
    id: t.id, name: String(t.name), desc: String(t.desc || ''), mood: String(t.mood || ''), accent: t.accent || '#7FA88A', order: Number(t.order) || 99, file,
    facilities: (t.facilities || []).map(f => ({ kind: f.kind, name: String(f.name || f.kind), size: Math.max(.5, Math.min(2.2, Number(f.size) || 1)) })),
    layout: { strategy: L.strategy || 'rows', corridor: Math.max(6, Math.min(12, L.corridor || 7)), rowH: Math.max(19, Math.min(27, L.rowH || 21)),
      lobbyW: Math.max(20, Math.min(32, L.lobbyW || 22)), doorW: Math.max(3, Math.min(6, L.doorW || 3)), twoDoorsFrom: L.twoDoorsFrom || 32,
      hub: (L.hub || []).filter(k => ROOM_KINDS.includes(k)), hubSize: Math.max(.8, Math.min(2, L.hubSize || 1.2)), codeSize: Math.max(.8, Math.min(1.6, L.codeSize || 1)),
      facilitySize: Math.max(.7, Math.min(1.5, L.facilitySize || 1)), wingLabels: L.wingLabels || 'groups' },
    filler: { kind: ROOM_KINDS.includes(t.filler?.kind) ? t.filler.kind : 'taman', name: String(t.filler?.name || 'Taman Kecil') },
    groups: (t.groups || []).map(g => ({ name: String(g.name || ''), kinds: [].concat(g.kinds || []) })),
    floors: t.floors || {}, furnish: t.furnish || {},
    corridorDecor: { every: Math.max(6, t.corridorDecor?.every || 16), items: t.corridorDecor?.items?.length ? t.corridorDecor.items : ['plant', 'bench', 'plant', 'water'] },
  };
}
export function getTemplate(id) {
  const t = templates().byId.get(id);
  if (!t) throw new Error('Template tidak dikenal');
  return t;
}

/* ---------------- sizing ---------------- */
const FIXED_KINDS = new Set(['lobby', 'zone']);
/** Can every resident of room `r` (and of its zones) get a desk at this size? Checked on the real desk rules (builtIns). */
function seatsEveryone(r, zones, roles) {
  const room = { ...r, x: 1, y: 1, doors: [] };
  const zs = zones.map(z => ({ ...z, x: z.x - r.x + 1 }));
  const w = builtIns({ w: r.w + 2, h: r.h + 2, rooms: [room, ...zs], decor: [] }, roles);
  const ids = new Set([r.id, ...zones.map(z => z.id)]);
  const need = roles.filter(x => ids.has(x.room) && !x.archived).length;
  return w.desks.filter(d => d.role && ids.has(d.zone || d.room)).length >= need;
}
const DESK_KINDS = new Set(['kode', 'game', 'manager', 'meeting', 'lib', 'qa', 'server', 'beku', 'openplan']);
/** {min, pref} widths for a room in a row of height h. */
function widths(r, zones, roles, tpl, h, isFacility) {
  const L = tpl.layout;
  let pref;
  if (r.kind === 'kode') pref = Math.max(19, 7 * Math.max(2, roles.filter(x => x.room === r.id).length + 1) + 5) * L.codeSize;
  else if (r.kind === 'openplan') pref = r.w;
  else pref = (FN_WIDTH[r.kind] || r.w || 20) * (isFacility ? r._size || 1 : 1) * L.facilitySize;
  pref = Math.round(pref);
  let min = r.kind === 'openplan' ? r.w : Math.max(r.kind === 'telepon' ? 10 : 12, Math.round(pref * .75));
  // built-ins along the top wall need the width, and a door facing up needs a free stretch of that wall
  min = Math.max(min, { pantry: 22, musik: 22, server: 18, qa: 16 }[r.kind] || 0);
  if (DESK_KINDS.has(r.kind) || zones.length) {
    while (min < 140 && !seatsEveryone({ ...r, w: min, h }, zones, roles)) min++;
  }
  return { min, pref: Math.max(pref, min) };
}

/* ---------------- packing ---------------- */
/** Fill a segment of `len` tiles (rooms share walls) with as many rooms of `seq` from `i` as fit near their preferred width. */
function takeRooms(seq, i, len, max = Infinity) {
  const take = [];
  let sMin = 0, sPref = 0;
  while (i + take.length < seq.length && take.length < max) {
    const r = seq[i + take.length], n = take.length + 1;
    const nMin = sMin + r.min, nPref = sPref + r.pref;
    if (nMin - (n - 1) > len) break;
    if (take.length && nPref - (n - 1) > len * 1.12) break;
    take.push(r); sMin = nMin; sPref = nPref;
  }
  return take;
}
/** Widths for rooms filling exactly `len` tiles when possible; returns {w:[], void}. */
function spread(take, len, maxStretch = 1.7) {
  const T = len + take.length - 1, sPref = take.reduce((s, r) => s + r.pref, 0);
  const f = T / sPref;
  const w = take.map(r => Math.max(r.min, Math.min(Math.round(r.pref * maxStretch), Math.round(r.pref * f))));
  let diff = T - w.reduce((s, x) => s + x, 0);
  for (let guard = 0; diff !== 0 && guard < 400; guard++) {
    let best = -1;
    for (let k = 0; k < w.length; k++) {
      const r = take[k];
      if (diff > 0 && w[k] < Math.round(r.pref * maxStretch) && (best < 0 || w[k] / r.pref < w[best] / take[best].pref)) best = k;
      if (diff < 0 && w[k] > r.min && (best < 0 || w[k] / r.pref > w[best] / take[best].pref)) best = k;
    }
    if (best < 0) break;
    w[best] += Math.sign(diff); diff -= Math.sign(diff);
  }
  return { w, void: Math.max(0, diff) };
}
/**
 * Rows geometry: K corridors, 2K rows. Row 2k faces down onto corridor k, row 2k+1 faces up onto it; rows 2k+1 and 2k+2 stand
 * back to back sharing a wall. With hub rooms, the middle pair of rows is cut around the hub, which spans both rows.
 */
function segmentsFor(K, len, x0, tpl, hubW) {
  const { rowH: h, corridor: C } = tpl.layout;
  const rows = [], corridors = [];
  let y = 0;
  for (let k = 0; k < K; k++) {
    rows.push({ y, h, face: 'b', corr: k });
    y += h; corridors.push(y); y += C;
    rows.push({ y, h, face: 't', corr: k });
    y += k < K - 1 ? h - 1 : h;
  }
  const H = y;
  const hb = hubW ? Math.max(0, Math.floor((K - 2) / 2)) : -1;   // the hub stands in rows 2hb+1 and 2hb+2
  let hub = null;
  if (hubW) {
    const hx = x0 + Math.floor((len - hubW) / 2), r1 = rows[2 * hb + 1];
    hub = { x: hx, y: r1.y, w: hubW, h: 2 * h - 1, corrs: [hb, hb + 1] };
  }
  const seg = (row, a, b, side) => ({ ...row, x0: a, len: b - a, side });
  const segs = [];
  rows.forEach((row, i) => {
    if (hub && (i === 2 * hb + 1 || i === 2 * hb + 2)) {
      segs.push(seg(row, x0, hub.x + 1, 'l'), seg(row, hub.x + hub.w - 1, x0 + len, 'r'));
    } else segs.push(seg(row, x0, x0 + len, 'f'));
  });
  let order;
  if (hub) {
    // quiet side left of the hub, the busy side right of it, everything else in the full rows above and below
    const L = segs.filter(s => s.side === 'l'), R = segs.filter(s => s.side === 'r').reverse(), F = segs.filter(s => s.side === 'f');
    order = [...L, ...F, ...R];
  } else order = segs;
  return { segs: order, corridors, H, hub };
}

/** Lay the rooms out; returns null when they don't fit. */
function packAll(seq, K, len, x0, tpl, hubRooms) {
  const hubW = hubRooms.length ? hubRooms.reduce((s, r) => s + r.w, 0) - (hubRooms.length - 1) : 0;
  if (hubW && hubW > len - 24) return null;
  const g = segmentsFor(K, len, x0, tpl, hubW);
  let i = 0, voidTiles = 0, stretch = 0, emptySegs = 0;
  const placed = [];
  const usable = g.segs.filter(s => s.len >= 10);
  for (const s of g.segs) {
    if (s.len < 10) { voidTiles += Math.max(0, s.len) * s.h; continue; }
    // leave at least one room for every segment still to come, so no stretch of street stays empty
    const later = usable.length - usable.indexOf(s) - 1;
    const take = takeRooms(seq, i, s.len, Math.max(1, seq.length - i - later));
    if (!take.length) { emptySegs++; voidTiles += s.len * s.h; continue; }
    i += take.length;
    const { w, void: v } = spread(take, s.len);
    voidTiles += v * s.h;
    let x = s.x0;
    take.forEach((r, k) => { placed.push({ r, x, y: s.y, w: w[k], h: s.h, face: s.face, corr: s.corr, seg: s }); stretch += (w[k] / r.pref - 1) ** 2; x += w[k] - 1; });
  }
  if (i < seq.length) return null;
  return { ...g, placed, voidTiles, stretch, emptySegs, hubW };
}

/* ---------------- generation ---------------- */
/**
 * The office's current rooms (as officeModel shows them, hidden ones left out) + roles + extra rooms → template result.
 * input: { rooms, roles, extra (extraRooms meta), hidden }
 */
export function generateFrom(input, tplId, seed = 1) {
  const tpl = typeof tplId === 'object' ? tplId : getTemplate(tplId);
  seed = Math.abs(Math.round(Number(seed) || 1));
  const L = tpl.layout;
  const roles = input.roles || [];
  const src = structuredClone(input.rooms);
  const zonesOf = id => src.filter(z => z.kind === 'zone' && z.zoneOf === id);
  // rooms an earlier template added that this one does not want, if nobody sits there and they have no folder
  const extra = structuredClone(input.extra || []);
  const keepExtra = [];
  const claimed = new Set(), newRooms = [];
  const occupied = id => roles.some(x => x.room === id);
  // facilities: reuse a room of that kind when the office has one free, else add one
  for (const f of tpl.facilities) {
    const have = src.find(r => r.kind === f.kind && !claimed.has(r.id));
    if (have) {
      claimed.add(have.id); have._size = f.size;
      // a room an earlier template added takes this template's name for it
      const ex = extra.find(x => x.id === have.id);
      if (ex?.fromTemplate && ex.fromTemplate !== tpl.id && !occupied(have.id)) { ex.name = have.name = f.name; ex.fromTemplate = have.fromTemplate = tpl.id; }
      continue;
    }
    let id = slug(f.name), n = 2;
    while (src.some(r => r.id === id) || extra.some(r => r.id === id) || newRooms.some(r => r.id === id)) id = `${slug(f.name)}-${n++}`;
    const room = { id, name: f.name, kind: f.kind, path: null, stack: '', extra: true, fromTemplate: tpl.id, _size: f.size };
    newRooms.push(room); claimed.add(id);
  }
  const dropped = new Set();
  for (const x of extra) {
    if (x.fromTemplate && !claimed.has(x.id) && !x.path && !occupied(x.id)) { dropped.add(x.id); continue; }
    keepExtra.push(x);
  }
  let rooms = [...src.filter(r => !dropped.has(r.id)), ...newRooms.map(r => ({ ...r, x: 0, y: 0, w: FN_WIDTH[r.kind] || 22, h: L.rowH }))];
  const lobbySrc = rooms.find(r => r.kind === 'lobby');
  const body = rooms.filter(r => r.kind !== 'lobby' && r.kind !== 'zone');

  // order: groups as the template lists them; inside a group, by kind order in the group then as the office lists them
  const groups = tpl.groups.length ? tpl.groups : [{ name: '', kinds: [] }];
  const groupOf = r => { const k = r.kind; let gi = groups.findIndex(g => g.kinds.includes(k)); if (gi < 0) gi = groups.findIndex(g => g.kinds.includes('kode')); return gi < 0 ? groups.length - 1 : gi; };
  const kindRank = (r, g) => { const i = groups[g].kinds.indexOf(r.kind); return i < 0 ? 99 : i; };
  const hubKinds = L.strategy === 'hub' ? L.hub : [];
  const hubRooms = [];
  for (const k of hubKinds) { const r = body.find(x => x.kind === k && !hubRooms.includes(x)); if (r) hubRooms.push(r); }
  const rest = body.filter(r => !hubRooms.includes(r));
  const order = rest.map((r, i) => ({ r, i, g: groupOf(r) })).sort((a, b) => a.g - b.g || kindRank(a.r, a.g) - kindRank(b.r, b.g) || a.i - b.i);

  const h = L.rowH;
  const isFac = r => !r.path && r.kind !== 'kode' && r.kind !== 'openplan';
  const seq = order.map(({ r, g }) => ({ room: r, g, ...widths(r, zonesOf(r.id), roles, tpl, h, isFac(r)) }));
  // hub rooms span two rows; their width follows the template's hub size
  const hubH = 2 * h - 1;
  for (const r of hubRooms) {
    const { min, pref } = widths(r, zonesOf(r.id), roles, tpl, hubH, isFac(r));
    r.w = Math.max(min, Math.round(pref * L.hubSize)); r.h = hubH;
  }
  const lobbyW = L.lobbyW, x0 = lobbyW - 1;
  const maxMin = Math.max(30, ...seq.map(s => s.min));
  let best = null;
  for (let K = hubRooms.length ? 2 : 1; K <= 6; K++) {
    let first = null;
    for (let len = maxMin; len <= 360; len += 2) {
      const p = packAll(seq, K, len, x0, tpl, hubRooms);
      if (p) { first = len; break; }
    }
    if (first === null) continue;
    for (const len of [1, 1.08, 1.16, 1.25, 1.35, 1.5].map(f => Math.round(first * f))) {
      const p = packAll(seq, K, len, x0, tpl, hubRooms);
      if (!p) continue;
      const W = x0 + len, H = p.H;
      const score = Math.abs(Math.log(W / H / ASPECT)) * 3 + p.voidTiles / (W * H) * 10 + p.emptySegs * 1.5 + p.stretch / seq.length * 2 + (W * H) / 60000;
      if (!best || score < best.score) best = { ...p, len, W, H, K, score };
    }
  }
  if (!best) throw new Error('Template tidak muat untuk kantor ini');

  /* ---- geometry onto the rooms ---- */
  const C = L.corridor, dw = L.doorW;
  const doorsOn = (w, side) => {
    const n = w >= L.twoDoorsFrom ? 2 : 1;
    return Array.from({ length: n }, (_, k) => {
      const c = Math.round(w * (k + 1) / (n + 1));
      return { s: side, at: Math.max(1, Math.min(w - 1 - dw, c - Math.floor(dw / 2))), w: dw };
    });
  };
  const floorFor = (r, idx) => { const f = tpl.floors[r.kind] ?? tpl.floors['*']; return f ? [].concat(f)[idx % [].concat(f).length] : (r.floor || FLOOR[r.kind] || 'wood'); };
  const kindIdx = {};
  const nextIdx = k => (kindIdx[k] = (kindIdx[k] ?? -1) + 1);
  const out = [];
  for (const p of best.placed) {
    const r = p.r.room;
    const dx = p.x - r.x;
    Object.assign(r, { x: p.x, y: p.y, w: p.w, h: p.h, doors: doorsOn(p.w, p.face), floor: floorFor(r, nextIdx(r.kind)) });
    for (const z of zonesOf(r.id)) z.x += dx;
    out.push(r);
  }
  if (best.hub) {
    let x = best.hub.x;
    for (const r of hubRooms) {
      const dx = x - r.x;
      Object.assign(r, { x, y: best.hub.y, h: best.hub.h, floor: floorFor(r, nextIdx(r.kind)) });
      r.doors = [...doorsOn(r.w, 't'), ...doorsOn(r.w, 'b')];
      for (const z of zonesOf(r.id)) z.x += dx;
      x += r.w - 1;
      out.push(r);
    }
  }
  // a street that ran out of rooms: a short gap goes to its last room, a long one becomes a small themed room (terrace, reading nook …)
  for (const s of new Set([...best.segs])) {
    if (s.len < 10) continue;
    const mine = out.filter(r => best.placed.some(p => p.seg === s && p.r.room === r)).sort((a, b) => a.x - b.x);
    const end = s.x0 + s.len, last = mine.at(-1), from = last ? last.x + last.w : s.x0;
    const gap = end - from;
    if (gap <= 0) continue;
    if (last && gap < 12) { last.w += gap; last.doors = doorsOn(last.w, s.face); continue; }
    if (gap < 10) continue;
    const f = tpl.filler;
    let id = slug(f.name), n = 2;
    while (rooms.some(r => r.id === id) || newRooms.some(r => r.id === id)) id = `${slug(f.name)}-${n++}`;
    const room = { id, name: f.name, kind: f.kind, path: null, stack: '', extra: true, fromTemplate: tpl.id };
    newRooms.push(room); rooms.push(room);
    const fx = last ? from - 1 : from, fw = end - fx;
    Object.assign(room, { x: fx, y: s.y, w: fw, h: s.h, doors: doorsOn(fw, s.face), floor: floorFor(room, nextIdx(room.kind)) });
    out.push(room);
  }
  const W = best.W, H = best.H;
  const lobby = lobbySrc || { id: 'lobby', name: 'Lobi', kind: 'lobby', elevator: 7 };
  Object.assign(lobby, { x: 0, y: 0, w: lobbyW, h: H, floor: floorFor(lobby, 0),
    doors: best.corridors.map(cy => { const n = Math.min(6, C - 2); return { s: 'r', at: cy + Math.floor((C - n) / 2), w: n }; }) });
  if (lobby.elevator === undefined || lobby.elevator > lobbyW - 6) lobby.elevator = Math.min(7, lobbyW - 8);
  const zones = rooms.filter(r => r.kind === 'zone' && out.some(o => o.id === r.zoneOf));
  const plan = { w: W, h: H, rooms: [lobby, ...out, ...zones] };

  clearDoors(plan, roles);

  /* ---- streets: carpet runners, decor away from doors, wing names ---- */
  const rnd = mulberry(hashStr(`${seed}:${tpl.id}:streets`));
  plan.runners = best.corridors.map(cy => ({ x: lobbyW * 8, y: (cy + Math.floor(C / 2)) * 8 - 2, w: (W - lobbyW) * 8, h: 12 }));
  plan.decor = [];
  const doorCols = (cy, edge) => {   // corridor columns in front of doors on that edge (with a 1-tile margin)
    const s = new Set();
    for (const r of plan.rooms) for (const d of r.doors || []) {
      if (edge === 'top' && d.s === 'b' && r.y + r.h === cy) for (let k = -1; k <= d.w; k++) s.add(r.x + d.at + k);
      if (edge === 'bot' && d.s === 't' && r.y === cy + C) for (let k = -1; k <= d.w; k++) s.add(r.x + d.at + k);
    }
    return s;
  };
  const size = t => (t === 'bench' ? 4 : t === 'vending' ? 2 : 1);
  best.corridors.forEach((cy, ci) => {
    for (const [edge, y] of [['top', cy], ['bot', cy + C - 1]]) {
      const busy = doorCols(cy, edge);
      let k = Math.floor(rnd() * tpl.corridorDecor.items.length) + ci + (edge === 'bot' ? 1 : 0);
      for (let x = lobbyW + 4 + (edge === 'bot' ? Math.floor(tpl.corridorDecor.every / 2) : 0); x < W - 3;) {
        const t = tpl.corridorDecor.items[k % tpl.corridorDecor.items.length], n = size(t);
        let free = x + n <= W - 1;
        for (let q = x; q < x + n && free; q++) if (busy.has(q)) free = false;
        if (free) { plan.decor.push({ t, x, y }); k++; x += tpl.corridorDecor.every + Math.floor(rnd() * 4); } else x++;
      }
    }
  });
  plan.wings = [];
  const seen = new Set();
  if (L.wingLabels === 'peron') best.corridors.forEach((cy, i) => plan.wings.push({ t: `Peron ${i + 1}`, x: lobbyW + 2, y: cy + Math.ceil(C / 2) + 1 }));
  else if (groups.length > 1) for (const p of best.placed) {
    const gi = seq.find(s => s.room === p.r.room)?.g;
    const g = groups[gi];
    if (!g?.name || seen.has(gi)) continue;
    seen.add(gi);
    const cy = best.corridors[p.corr];
    const arrow = p.face === 'b' ? ' ↑' : ' ↓';
    if (!plan.wings.some(w => w.y === cy + Math.ceil(C / 2) + 1 && Math.abs(w.x - (p.x + 2)) < 26)) plan.wings.push({ t: g.name + arrow, x: p.x + 2, y: cy + Math.ceil(C / 2) + 1 });
  }

  /* ---- furniture ---- */
  plan.furniture = furnishPlan(plan, roles, tpl, seed);
  for (const r of plan.rooms) delete r._size;
  const layout = { w: W, h: H, hidden: input.hidden || [],
    rooms: plan.rooms.map(r => r.kind === 'zone' ? { id: r.id, x: r.x, w: r.w } : { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, floor: r.floor, doors: r.doors }),
    decor: plan.decor, runners: plan.runners, wings: plan.wings };
  return { template: tpl.id, seed, newRooms: newRooms.map(({ _size, x, y, w, h, ...r }) => r), extraRooms: [...keepExtra, ...newRooms.map(({ _size, ...r }) => r)], dropped: [...dropped], layout, plan, furniture: plan.furniture };
}

/** Slide doors that open straight onto a built-in (server racks, the QA bench, counters along the top wall) to free floor on the same wall. */
function clearDoors(plan, roles) {
  const world = builtIns(plan, roles);
  const free = b => { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (!world.walk[y * world.W + x]) return false; return true; };
  for (const r of plan.rooms) {
    if (r.kind === 'zone' || r.kind === 'lobby') continue;
    r.doors.forEach((d, i) => {
      const land = dd => doorLands({ ...r, doors: [dd] })[0];
      if (free(land(d))) return;
      const len = d.s === 't' || d.s === 'b' ? r.w : r.h, lo = d.s === 'l' || d.s === 'r' ? WH : 1;
      const opts = [];
      for (let at = lo; at + d.w <= len - 1; at++) if (Math.abs(at - d.at) > 0) opts.push(at);
      opts.sort((a, b) => Math.abs(a - d.at) - Math.abs(b - d.at));
      const others = r.doors.filter((_, k) => k !== i && _.s === d.s);
      const at = opts.find(a => free(land({ ...d, at: a })) && !others.some(o => a < o.at + o.w + 1 && o.at < a + d.w + 1));
      if (at !== undefined) d.at = at;
    });
  }
}
/** Themed furniture for every room of a laid-out plan. */
export function furnishPlan(plan, roles, tpl, seed) {
  const cat = furniture();
  const def = id => cat.byId.get(id);
  const world = builtIns(plan, roles);
  const desks = deskRects(world.desks);
  let n = 0;
  const uid = () => `t${(++n).toString(36)}`;
  let list = [];
  for (const r of plan.rooms.filter(x => x.kind !== 'zone')) {
    const spec = { ...(tpl.furnish['*'] || {}), ...(tpl.furnish[r.kind] || {}) };
    const listed = spec.items || {};
    const others = spec.others ?? (Object.keys(listed).length ? .15 : 1);
    const exclude = new Set(spec.exclude || []);
    const pool = new Map();
    if (others > 0) for (const d of cat.items) if (!exclude.has(d.id) && (d.rooms || []).some(k => k === r.kind || k === '*')) pool.set(d.id, { ...d, weight: (d.weight ?? 1) * others });
    for (const [id, w] of Object.entries(listed)) { const d = def(id); if (d && !exclude.has(id)) pool.set(id, { ...d, weight: w }); }
    const center = (spec.center || []).map(def).filter(Boolean);
    const blocked = (x, y) => x >= 0 && y >= 0 && x < world.W && y < world.H && world.walk[y * world.W + x] === 0;
    const rnd = mulberry(hashStr(`${seed}:${tpl.id}:${r.id}`));
    const added = fillRoom(r, rnd, list, { def, uid, desks, blocked, cands: [...pool.values()], density: spec.density ?? 1, walls: spec.walls ?? 1, center });
    list = list.concat(added);
  }
  return list;
}

/* ---------------- checks ---------------- */
/** Everything that would make a generated office wrong. Empty = fine. */
export function resultProblems(plan, roles = []) {
  const out = [...layoutProblems(plan)];
  const cat = furniture();
  const world = builtIns(plan, roles);
  const desks = deskRects(world.desks);
  const rooms = plan.rooms.filter(r => r.kind !== 'zone');
  const roomAt = (x, y) => rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const solids = [], flats = [];
  for (const f of plan.furniture || []) {
    const d = cat.byId.get(f.item);
    if (!d) { out.push(`perabot ${f.item} tak dikenal`); continue; }
    const r = roomAt(f.x, f.y), b = { x: f.x, y: f.y, w: d.w, h: d.h, id: f.item };
    if (!r) { out.push(`${f.item} di luar ruangan`); continue; }
    const I = interior(r);
    if (f.x < I.x0 || f.y < I.y0 || f.x + d.w > I.x1 || f.y + d.h > I.y1) { out.push(`${f.item} keluar dari ${r.name}`); continue; }
    if (d.wall && f.y !== I.y0) out.push(`${f.item} harus di dinding atas ${r.name}`);
    for (const o of d.solid ? solids : flats) if (overlap(b, o)) out.push(`${f.item} menabrak ${o.id} di ${r.name}`);
    if (d.solid) {
      for (const k of desks) if (overlap(b, k)) out.push(`${f.item} menutup meja di ${r.name}`);
      for (const k of doorLands(r)) if (overlap(b, k)) out.push(`${f.item} menutup pintu ${r.name}`);
      for (let y = f.y; y < f.y + d.h; y++) for (let x = f.x; x < f.x + d.w; x++) if (world.walk[y * world.W + x] === 0) out.push(`${f.item} menabrak perabot bawaan ${r.name}`);
      solids.push(b);
    } else flats.push(b);
  }
  // with the furniture standing, can everyone still walk from the lobby into every room and to every desk seat?
  for (const b of solids) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) world.walk[y * world.W + x] = 0;
  const lost = unreachableRooms(world);
  for (const r of lost) out.push(`${r.name} tidak bisa dimasuki dari lobi`);
  for (const d of world.desks) if (!lost.seen[d.seat.ty * world.W + d.seat.tx]) out.push(`kursi meja di ${d.room} tidak terjangkau`);
  const need = roles.filter(r => rooms.some(x => x.id === r.room) || plan.rooms.some(z => z.kind === 'zone' && z.id === r.room));
  for (const r of need) if (!world.desks.some(d => d.role === r.id)) out.push(`${r.id} tidak dapat meja`);
  return out;
}

/* ---------------- office glue ---------------- */
const meta = (db, k) => one(db, 'SELECT value FROM meta WHERE key = ?', k)?.value ?? null;
const setMeta = (db, k, v) => v === null ? run(db, 'DELETE FROM meta WHERE key = ?', k) : run(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
function officeInput(id) {
  const m = officeModel(id);
  if (!m) throw new Error('Kantor tidak ditemukan');
  const db = officeDb(id);
  return {
    rooms: m.plan.rooms, extra: j(meta(db, 'extraRooms'), []), hidden: j(meta(db, 'layout'), {})?.hidden || [],
    roles: all(db, 'SELECT id, room, archived, is_mgr FROM roles WHERE archived = 0 ORDER BY ord, created_at'),
  };
}
/** What the office would look like with the template, without saving anything. */
export function previewTemplate(id, tplId, seed) {
  const input = officeInput(id);
  const g = generateFrom(input, tplId, seed);
  return { template: g.template, seed: g.seed, newRooms: g.newRooms, dropped: g.dropped, plan: g.plan, layout: g.layout, furniture: g.furniture, problems: resultProblems(g.plan, input.roles) };
}
/** Apply a template: add its rooms, save layout and furniture in one transaction. The state before the first template is kept for restore. */
export function applyTemplate(id, tplId, seed) {
  const input = officeInput(id);
  const g = generateFrom(input, tplId, seed);
  const bad = resultProblems(g.plan, input.roles);
  if (bad.length) throw new Error(`Template belum bisa diterapkan: ${bad.slice(0, 3).join('; ')}`);
  const db = officeDb(id);
  const before = { at: nowIso(), layout: meta(db, 'layout'), furniture: meta(db, 'furniture'), extraRooms: meta(db, 'extraRooms') };
  try {
    tx(db, () => {
      // keep the oldest backup: trying several templates in a row must still lead back to the office as it was
      if (!meta(db, 'layout-backup')) setMeta(db, 'layout-backup', JSON.stringify(before));
      setMeta(db, 'extraRooms', JSON.stringify(g.extraRooms));
      invalidate(id);
      saveLayout(id, g.layout);
      saveFurniture(id, g.furniture);
      setMeta(db, 'template', JSON.stringify({ id: g.template, seed: g.seed, at: before.at }));
    });
  } finally { invalidate(id); }
  return { template: g.template, seed: g.seed, newRooms: g.newRooms, dropped: g.dropped, plan: officeModel(id).plan };
}
/** Put back the layout, furniture and extra rooms the office had before the first template. */
export function restoreTemplate(id) {
  const db = officeDb(id);
  const b = j(meta(db, 'layout-backup'), null);
  if (!b) throw new Error('Tidak ada cadangan susunan untuk dipulihkan');
  try {
    tx(db, () => {
      setMeta(db, 'layout', b.layout); setMeta(db, 'furniture', b.furniture); setMeta(db, 'extraRooms', b.extraRooms);
      setMeta(db, 'layout-backup', null); setMeta(db, 'template', null);
    });
  } finally { invalidate(id); }
  const m = officeModel(id);
  return { plan: m.plan, custom: !!m.custom };
}
export function templateState(id) {
  const db = officeDb(id);
  const b = j(meta(db, 'layout-backup'), null);
  return { current: j(meta(db, 'template'), null), backup: b ? { at: b.at } : null };
}

/* ---------------- gallery ---------------- */
const FLOOR_HEX = { wood: '#98AF9F', teal: '#98AF9F', carpet: '#98AF9F', teal2: '#9AAFB0', carpetGreen: '#A3B596', wood2: '#B98F62', marble: '#E3DFD6', tile: '#E6E8EA', metal: '#5A616E', plum: '#9B8CAE', frozen: '#BFC1C6', musholla: '#5C9672', grass: '#6BAE57', gymMat: '#47546A', lounge: '#B89C8C' };
/** A small SVG of a plan: corridors, room floors, walls and furniture blobs. */
export function planSvg(plan, px = 3) {
  const cat = furniture();
  const W = plan.w * px, H = plan.h * px;
  const rects = [`<rect width="${W}" height="${H}" fill="#9DB3A6"/>`];
  for (const r of plan.rooms.filter(x => x.kind !== 'zone')) {
    rects.push(`<rect x="${r.x * px}" y="${r.y * px}" width="${r.w * px}" height="${r.h * px}" fill="#2A2430"/>`);
    rects.push(`<rect x="${(r.x + 1) * px}" y="${(r.y + 1) * px}" width="${(r.w - 2) * px}" height="${(WH - 1) * px}" fill="#EAE6DD"/>`);
    rects.push(`<rect x="${(r.x + 1) * px}" y="${(r.y + WH) * px}" width="${(r.w - 2) * px}" height="${(r.h - WH - 1) * px}" fill="${FLOOR_HEX[r.floor] || '#98AF9F'}"/>`);
    for (const d of r.doors || []) {
      const [x, y, w, h] = d.s === 'b' ? [r.x + d.at, r.y + r.h - 1, d.w, 1] : d.s === 't' ? [r.x + d.at, r.y, d.w, WH] : d.s === 'l' ? [r.x, r.y + d.at, 1, d.w] : [r.x + r.w - 1, r.y + d.at, 1, d.w];
      rects.push(`<rect x="${x * px}" y="${y * px}" width="${w * px}" height="${h * px}" fill="${FLOOR_HEX[r.floor] || '#98AF9F'}"/>`);
    }
  }
  for (const f of plan.furniture || []) {
    const d = cat.byId.get(f.item); if (!d) continue;
    const col = Object.values(d.sprite.palette).find(c => !/^#(?:[0-3][0-9a-f]){3}/i.test(c)) || Object.values(d.sprite.palette)[0];
    rects.push(`<rect x="${f.x * px}" y="${f.y * px}" width="${d.w * px}" height="${d.h * px}" fill="${col.slice(0, 7)}"${d.solid ? '' : ' opacity=".55"'}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}
// a stand-in office for the gallery thumbnails: manager, meeting, library, three repos, the usual facilities
const SAMPLE = (() => {
  const r = (id, name, kind, extra = {}) => ({ id, name, kind, path: extra.path ?? null, stack: '', x: 0, y: 0, w: FN_WIDTH[kind] || 19, h: 21, doors: [], ...extra });
  return { rooms: [{ id: 'lobby', name: 'Lobi', kind: 'lobby', x: 0, y: 0, w: 20, h: 40, elevator: 7, doors: [] },
    r('manager', 'Ruang Manager', 'manager', { path: '' }), r('meeting', 'Ruang Meeting', 'meeting'), r('lib', 'Perpustakaan', 'lib'),
    r('web', 'Web', 'kode', { path: 'web' }), r('api', 'Api', 'kode', { path: 'api' }), r('app', 'App', 'kode', { path: 'app' }),
    r('qa', 'Lab QA', 'qa'), r('server', 'Ruang Server', 'server'), r('musik', 'Ruang Musik', 'musik'), r('pantry', 'Pantry', 'pantry')],
  roles: [{ id: 'mgr', room: 'manager' }, { id: 'a', room: 'web' }, { id: 'b', room: 'api' }], extra: [], hidden: [] };
})();
const thumbs = new Map();
/** Template list for the gallery, each with a thumbnail of the sample office. */
export function templateList() {
  const t = templates();
  return {
    templates: t.list.map(x => {
      const key = `${x.id}:${t.sig}:${furniture().version}`;
      if (!thumbs.has(key)) { try { thumbs.set(key, planSvg(generateFrom(SAMPLE, x, 1).plan, 2)); } catch (e) { thumbs.set(key, null); } }
      return { id: x.id, name: x.name, desc: x.desc, mood: x.mood, accent: x.accent, facilities: x.facilities, strategy: x.layout.strategy, thumb: thumbs.get(key) };
    }),
    ...(t.problems.length ? { problems: t.problems } : {}),
  };
}
