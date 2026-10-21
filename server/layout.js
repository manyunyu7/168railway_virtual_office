// Floor plans are in tiles (8 native px). A room rectangle includes its own walls;
// its top WH rows are the wall face. Doors: s = t|b|l|r, at = offset along that side, w = width.
export const WH = 4;

const FN_WIDTH = { manager: 24, meeting: 21, lib: 19, qa: 18, server: 16, pantry: 24, beku: 15, game: 24 };
const FLOOR = { manager: 'wood2', meeting: 'carpet', lib: 'carpetGreen', qa: 'tile', server: 'metal', pantry: 'tile', beku: 'frozen', kode: 'wood', game: 'wood' };

/**
 * Generic office: lobby on the left, rooms packed into rows that face shared corridors.
 * rooms: [{id, name, kind, path, stack, desks}] (no lobby)
 */
export function autoLayout(rooms) {
  const ROOM_H = 21, CORR = 7, LOBBY_W = 20;
  const width = r => FN_WIDTH[r.kind] || Math.max(19, 7 * Math.max(2, r.desks || 2) + 5);
  const total = rooms.reduce((s, r) => s + width(r) - 1, 0);
  const nRows = Math.max(1, Math.ceil(total / 112));
  const target = Math.ceil(total / nRows);
  const rows = [[]];
  let acc = 0;
  for (const r of rooms) {
    const w = width(r) - 1;
    if (acc + w > target + 10 && rows.at(-1).length) { rows.push([]); acc = 0; }
    rows.at(-1).push({ ...r, w: w + 1 });
    acc += w;
  }
  const rowW = Math.max(...rows.map(row => row.reduce((s, r) => s + r.w - 1, 0) + 1));
  const out = [];
  const corridors = [];
  let y = 0;
  rows.forEach((row, i) => {
    const facesDown = i % 2 === 0;
    if (!facesDown) { /* corridor already placed above */ }
    let x = LOBBY_W - 1;
    const used = row.reduce((s, r) => s + r.w - 1, 0) + 1;
    const extra = rowW - used;
    row.forEach((r, k) => {
      const w = r.w + (k === row.length - 1 ? extra : 0);
      const door = { s: facesDown ? 'b' : 't', at: Math.max(2, Math.floor(w / 2) - 1), w: 3 };
      out.push({ ...r, x, y, w, h: ROOM_H, floor: FLOOR[r.kind] || 'wood', wall: r.kind === 'meeting' ? 'glass' : undefined, doors: [door] });
      x += w - 1;
    });
    y += ROOM_H;
    if (facesDown) { corridors.push(y); y += CORR; }
  });
  const H = y + (rows.length % 2 === 1 ? 0 : 0);
  const lobbyH = Math.max(H, 30);
  const lobby = { id: 'lobby', name: 'Lobi', kind: 'lobby', x: 0, y: 0, w: LOBBY_W, h: lobbyH, floor: 'marble', elevator: 7, doors: corridors.map(cy => ({ s: 'r', at: cy + 2, w: 3 })) };
  const W = LOBBY_W - 1 + rowW;
  const decor = [];
  const runners = corridors.map(cy => ({ x: LOBBY_W * 8, y: (cy + 3) * 8 - 2, w: (W - LOBBY_W) * 8, h: 12 }));
  corridors.forEach((cy, i) => {
    for (let x = LOBBY_W + 4; x < W - 3; x += 22) decor.push({ t: (x / 22 | 0) % 3 === 1 ? 'bench' : 'plant', x, y: cy + (i % 2 ? 5 : 1) });
    decor.push({ t: 'vending', x: W - 4, y: cy + 1 });
  });
  return { w: W, h: Math.max(lobbyH, H), rooms: [lobby, ...out], decor, runners, wings: [] };
}

/* Hand-made plan for a 168Railway-like folder. `byPath` maps preset ids to real
   repo folders found on disk; preset rooms whose folder is missing stay as empty rooms. */
export function railwayLayout(paths) {
  const P = id => paths[id] || null;
  const rooms = [
    { id: 'manager', name: 'Ruang Manager', kind: 'manager', path: '', x: 0, y: 0, w: 24, h: 23, floor: 'wood2', doors: [{ s: 'b', at: 16, w: 3 }] },
    { id: 'meeting', name: 'Ruang Meeting', kind: 'meeting', x: 23, y: 0, w: 22, h: 19, floor: 'carpet', wall: 'glass', doors: [{ s: 'b', at: 9, w: 3 }] },
    { id: 'lib', name: 'Perpustakaan', kind: 'lib', path: P('lib'), x: 44, y: 0, w: 22, h: 23, floor: 'carpetGreen', doors: [{ s: 'b', at: 9, w: 3 }] },
    { id: 'web', name: 'Web', kind: 'kode', path: P('web'), x: 65, y: 0, w: 36, h: 23, floor: 'wood', doors: [{ s: 'b', at: 5, w: 3 }, { s: 'b', at: 27, w: 3 }, { s: 'r', at: 6, w: 2 }, { s: 'r', at: 16, w: 2 }] },
    { id: 'ltc', name: 'Go LTC', kind: 'kode', path: P('ltc'), x: 100, y: 0, w: 28, h: 12, floor: 'wood', doors: [{ s: 'l', at: 6, w: 2 }] },
    { id: 'gopk', name: 'Go PK', kind: 'kode', path: P('gopk'), x: 100, y: 11, w: 28, h: 12, floor: 'wood', doors: [{ s: 'l', at: 5, w: 2 }] },
    { id: 'lobby', name: 'Lobi', kind: 'lobby', x: 0, y: 30, w: 23, h: 54, floor: 'marble', doors: [{ s: 't', at: 4, w: 3 }, { s: 'r', at: 21, w: 3 }], elevator: 13 },
    { id: 'openplan', name: 'Sayap Aplikasi', kind: 'openplan', x: 22, y: 30, w: 52, h: 19, floor: 'carpet', doors: [{ s: 't', at: 6, w: 3 }, { s: 't', at: 40, w: 3 }, { s: 'b', at: 24, w: 3 }] },
    { id: 'mobile', name: 'Mobile', kind: 'zone', zoneOf: 'openplan', path: P('mobile'), x: 23, w: 17, tint: 'rgba(60,170,105,.18)' },
    { id: 'admin', name: 'Admin', kind: 'zone', zoneOf: 'openplan', path: P('admin'), x: 40, w: 16, tint: 'rgba(70,120,200,.16)' },
    { id: 'live', name: 'Live Tracking', kind: 'zone', zoneOf: 'openplan', path: P('live'), x: 56, w: 17, tint: 'rgba(40,150,160,.18)' },
    { id: 'qa', name: 'Lab QA', kind: 'qa', x: 73, y: 30, w: 18, h: 19, floor: 'tile', doors: [{ s: 't', at: 8, w: 3 }] },
    { id: 'server', name: 'Ruang Server', kind: 'server', x: 90, y: 30, w: 17, h: 19, floor: 'metal', doors: [{ s: 't', at: 7, w: 3 }] },
    { id: 'lite', name: 'Gudang Lite', kind: 'beku', path: P('lite'), note: 'Bukan acuan UI', x: 106, y: 30, w: 14, h: 19, floor: 'frozen', doors: [{ s: 't', at: 5, w: 3 }] },
    { id: 'ppka', name: 'Studio PPKA', kind: 'game', path: P('ppka'), x: 22, y: 56, w: 26, h: 28, floor: 'wood', doors: [{ s: 't', at: 11, w: 3 }] },
    { id: 'gallery', name: 'Galeri', kind: 'kode', path: P('gallery'), x: 47, y: 56, w: 20, h: 28, floor: 'wood', doors: [{ s: 't', at: 8, w: 3 }] },
    { id: 'minikilla', name: 'Mini Killa', kind: 'kode', path: P('minikilla'), x: 66, y: 56, w: 17, h: 28, floor: 'wood', doors: [{ s: 't', at: 7, w: 3 }] },
    { id: 'pantry', name: 'Pantry', kind: 'pantry', x: 82, y: 56, w: 28, h: 28, floor: 'tile', doors: [{ s: 't', at: 5, w: 3 }, { s: 't', at: 20, w: 3 }] },
    { id: 'toilet', name: 'Toilet', kind: 'toilet', x: 109, y: 56, w: 19, h: 14, floor: 'tile', doors: [{ s: 't', at: 8, w: 2 }] },
    { id: 'booth', name: 'Phone booth', kind: 'booth', x: 109, y: 69, w: 19, h: 15, floor: 'carpet', wall: 'glass', doors: [{ s: 'l', at: 6, w: 2 }] },
  ];
  const decor = [
    { t: 'plant', x: 2, y: 25 }, { t: 'vending', x: 40, y: 23 }, { t: 'bench', x: 50, y: 26 }, { t: 'plant', x: 60, y: 25 }, { t: 'plant', x: 96, y: 25 },
    { t: 'water', x: 112, y: 25 }, { t: 'plant', x: 124, y: 33 }, { t: 'plant', x: 124, y: 46 }, { t: 'vending', x: 74, y: 49 }, { t: 'plant', x: 104, y: 50 }, { t: 'bench', x: 30, y: 52 },
  ];
  const runners = [{ x: 0, y: 25 * 8 + 4, w: 128 * 8, h: 12 }, { x: 23 * 8, y: 51 * 8 + 4, w: 105 * 8, h: 12 }, { x: 122 * 8 + 2, y: 23 * 8, w: 12, h: 33 * 8 }];
  return { w: 128, h: 84, rooms, decor, runners, wings: [{ t: 'Sayap Backend ↑', x: 66, y: 26 }, { t: 'Sayap Game & Tools ↓', x: 26, y: 52 }] };
}

/** Add a band of rooms below an existing plan: a corridor, then rooms whose doors face up. */
export function appendRow(plan, rooms) {
  const CORR = 7, ROOM_H = 21;
  const lobby = plan.rooms.find(r => r.kind === 'lobby');
  const x0 = lobby ? lobby.x + lobby.w - 1 : 0;
  const y0 = plan.h;
  let x = x0;
  const placed = [];
  for (const r of rooms) {
    const w = Math.max(18, FN_WIDTH[r.kind] || 22);
    if (x + w > Math.max(plan.w, x0 + 60) && placed.length) break;
    placed.push({ ...r, x, y: y0 + CORR, w, h: ROOM_H, floor: FLOOR[r.kind] || 'wood', wall: r.kind === 'meeting' ? 'glass' : undefined, doors: [{ s: 't', at: Math.floor(w / 2) - 1, w: 3 }] });
    x += w - 1;
  }
  const rest = rooms.slice(placed.length);
  plan.rooms.push(...placed);
  const newW = Math.max(plan.w, x + 1);
  if (lobby) { lobby.h = y0 + CORR + ROOM_H - lobby.y; lobby.doors = [...(lobby.doors || []), { s: 'r', at: y0 + 2 - lobby.y, w: 3 }]; }
  (plan.runners ||= []).push({ x: (x0 + 1) * 8, y: (y0 + 3) * 8 - 2, w: (newW - x0 - 1) * 8, h: 12 });
  (plan.decor ||= []).push({ t: 'plant', x: newW - 3, y: y0 + 1 });
  plan.w = newW; plan.h = y0 + CORR + ROOM_H;
  if (rest.length) appendRow(plan, rest);
  return plan;
}
