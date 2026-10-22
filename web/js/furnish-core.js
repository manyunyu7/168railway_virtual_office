// Auto-furnish logic shared by the browser editor (furniture-editor.js) and the server (templates.js).
// Pure: no DOM, no imports. The browser passes what its stage already knows (desks, walk grid);
// the server rebuilds the same facts with builtIns(), a geometry-only port of the stage's room furnishing.
export const WH = 4;          // wall-face rows at the top of every room
export const DOOR_DEPTH = 2;  // tiles inside a door that stay free
const SHOE = /sandal|sepatu/i;

export const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const interior = r => ({ x0: r.x + 1, y0: r.y + WH, x1: r.x + r.w - 1, y1: r.y + r.h - 1 });   // x1,y1 exclusive
export const inRoom = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
export function mulberry(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const hashStr = s => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);

/** The free-floor rectangles just inside each door of a room (DOOR_DEPTH tiles deep). */
export function doorLands(r) {
  return (r.doors || []).map(d => {
    const n = d.w || 3;
    if (d.s === 'b') return { x: r.x + d.at, y: r.y + r.h - 1 - DOOR_DEPTH, w: n, h: DOOR_DEPTH, s: 'b' };
    if (d.s === 't') return { x: r.x + d.at, y: r.y + WH, w: n, h: DOOR_DEPTH, s: 't' };
    if (d.s === 'l') return { x: r.x + 1, y: r.y + d.at, w: DOOR_DEPTH, h: n, s: 'l' };
    return { x: r.x + r.w - 1 - DOOR_DEPTH, y: r.y + d.at, w: DOOR_DEPTH, h: n, s: 'r' };
  });
}
/** Spots of item `d` at (x,y) that lie outside its own footprint (where someone stands to use it). */
export const spotsOut = (d, x, y) => (d.spots || []).map(s => [x + s.dx, y + s.dy]).filter(([sx, sy]) => sx < x || sx >= x + d.w || sy < y || sy >= y + d.h);
/** Desks as blocking rectangles: the 2-row desk plus its seat and front tile. */
export const deskRects = desks => desks.flatMap(d => [
  { x: d.tx, y: d.ty, w: d.w, h: 2 }, ...(d.seat ? [{ x: d.seat.tx, y: d.seat.ty, w: 1, h: 1 }] : []), ...(d.front ? [{ x: d.front.tx, y: d.front.ty, w: 1, h: 1 }] : [])]);

/**
 * New items for room `r` (`list` already holds what is placed anywhere). Deterministic for a given rnd.
 * ctx: { cands: catalog items allowed here (their `weight` is the pick weight), def(id) → item, desks: rects from deskRects(),
 *        blocked(x,y) → true for floor the room already uses (built-ins), uid() → new uid,
 *        density (1 = normal), walls (1 = normal share of the top wall), center: [items to put near the middle first] }
 */
export function fillRoom(r, rnd, list, ctx) {
  const { def, uid } = ctx, cands = (ctx.cands || []).filter(d => (d.weight ?? 1) > 0);
  const dens = ctx.density ?? 1, wallShare = ctx.walls ?? 1;
  const I = interior(r), iw = I.x1 - I.x0, ih = I.y1 - I.y0;
  if (iw < 3 || ih < 3) return [];
  const kind = r.kind;
  if (!cands.length && !(ctx.center || []).length) return [];
  const gw = r.w, at = (x, y) => (x - r.x) + (y - r.y) * gw;
  const solid = new Int16Array(gw * r.h).fill(-1), deco = new Uint8Array(gw * r.h), door = new Uint8Array(gw * r.h), rsv = new Uint8Array(gw * r.h);
  const rects = [];   // placed solids (and desks) by index
  const must = [];
  const mark = (arr, b, v) => { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (inRoom(r, x, y)) arr[at(x, y)] = v; };
  const sidesOf = b => { const s = new Set(); if (b.x <= I.x0) s.add('l'); if (b.x + b.w >= I.x1) s.add('r'); if (b.y <= I.y0) s.add('t'); if (b.y + b.h >= I.y1) s.add('b'); return s; };
  const counts = {};
  let solidTiles = 0;
  const addRect = (b, isSolid) => { if (isSolid) { rects.push(b); mark(solid, b, rects.length - 1); solidTiles += b.w * b.h; } else mark(deco, b, 1); };
  const lands = doorLands(r);
  for (const k of lands) mark(door, k, 1);
  for (const k of ctx.desks || []) if (inRoom(r, k.x, k.y)) {
    if (k.h === 2) addRect(k, true); else { mark(rsv, k, 1); must.push([k.x, k.y]); }
  }
  const blocked = ctx.blocked || (() => false), keepTiles = solidTiles;
  for (let y = I.y0; y < I.y1; y++) for (let x = I.x0; x < I.x1; x++) if (blocked(x, y) && solid[at(x, y)] < 0) addRect({ x, y, w: 1, h: 1 }, true);
  solidTiles = keepTiles;
  for (const f of list) {
    const d = def(f.item); if (!d || !inRoom(r, f.x, f.y)) continue;
    counts[d.id] = (counts[d.id] || 0) + 1;
    addRect({ x: f.x, y: f.y, w: d.w, h: d.h }, d.solid);
    if (d.solid) for (const [sx, sy] of spotsOut(d, f.x, f.y)) if (inRoom(r, sx, sy)) { rsv[at(sx, sy)] = 1; must.push([sx, sy]); }
  }
  const inI = (x, y) => x >= I.x0 && x < I.x1 && y >= I.y0 && y < I.y1;
  const fits = (d, x, y) => {
    if (x < I.x0 || y < I.y0 || x + d.w > I.x1 || y + d.h > I.y1) return false;
    if (d.wall && y !== I.y0) return false;
    for (let yy = y; yy < y + d.h; yy++) for (let xx = x; xx < x + d.w; xx++) {
      const i = at(xx, yy);
      if (d.solid ? (solid[i] >= 0 || rsv[i] || door[i]) : (solid[i] >= 0 || deco[i] || door[i])) return false;
    }
    for (const [sx, sy] of spotsOut(d, x, y)) { if (!inI(sx, sy) || solid[at(sx, sy)] >= 0) return false; }
    if (d.solid) {   // keep a gap to other solids unless both lean on the same wall
      const mine = sidesOf({ x, y, w: d.w, h: d.h }), seen = new Set();
      for (let yy = y - 1; yy <= y + d.h; yy++) for (let xx = x - 1; xx <= x + d.w; xx++) {
        if (xx >= x && xx < x + d.w && yy >= y && yy < y + d.h) continue;
        if (!inI(xx, yy)) continue;
        const k = solid[at(xx, yy)]; if (k < 0 || seen.has(k)) continue;
        seen.add(k);
        const theirs = sidesOf(rects[k]);
        if (![...mine].some(s => theirs.has(s))) return false;
      }
    }
    return true;
  };
  // flats keep a tile of floor between them, so benches and mats don't pile up into one block
  const apart = (d, x, y) => { for (let yy = y - 1; yy <= y + d.h; yy++) for (let xx = x - 1; xx <= x + d.w; xx++) if (inI(xx, yy) && deco[at(xx, yy)]) return false; return true; };
  /** Can everyone still walk from the doors to every spot with `d` at (x,y)? */
  const connected = (d, x, y) => {
    const blk = new Uint8Array(solid.length);
    for (let i = 0; i < solid.length; i++) blk[i] = solid[i] >= 0 ? 1 : 0;
    if (d.solid) for (let yy = y; yy < y + d.h; yy++) for (let xx = x; xx < x + d.w; xx++) blk[at(xx, yy)] = 1;
    const starts = [];
    for (const k of lands) for (let yy = k.y; yy < k.y + k.h; yy++) for (let xx = k.x; xx < k.x + k.w; xx++) {
      const edge = k.s === 'b' ? yy === k.y + k.h - 1 : k.s === 't' ? yy === k.y : k.s === 'l' ? xx === k.x : xx === k.x + k.w - 1;
      if (edge && inI(xx, yy) && !blk[at(xx, yy)]) starts.push([xx, yy]);
    }
    if (!starts.length) return true;
    const targets = [...must, ...(d.solid ? spotsOut(d, x, y) : [])].filter(([tx, ty]) => inI(tx, ty) && !blk[at(tx, ty)]);
    const seen = new Uint8Array(solid.length), st = [starts[0]];
    seen[at(...starts[0])] = 1;
    while (st.length) {
      const [cx, cy] = st.pop();
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (!inI(nx, ny)) continue;
        const i = at(nx, ny); if (seen[i] || blk[i]) continue;
        seen[i] = 1; st.push([nx, ny]);
      }
    }
    return starts.every(([sx, sy]) => seen[at(sx, sy)]) && targets.every(([tx, ty]) => seen[at(tx, ty)]);
  };
  const out = [];
  const put = (d, x, y) => {
    out.push({ uid: uid(), item: d.id, x, y }); counts[d.id] = (counts[d.id] || 0) + 1;
    addRect({ x, y, w: d.w, h: d.h }, d.solid);
    if (d.solid) for (const [sx, sy] of spotsOut(d, x, y)) { rsv[at(sx, sy)] = 1; must.push([sx, sy]); }
  };
  const pick = pool => {
    let tot = 0; const ws = pool.map(d => { const w = (d.weight ?? 1) / (1 + (counts[d.id] || 0) * 1.8); tot += w; return w; });
    if (!(tot > 0)) return null;
    let t = rnd() * tot;
    for (let i = 0; i < pool.length; i++) { t -= ws[i]; if (t <= 0) return pool[i]; }
    return pool.at(-1);
  };
  const area = iw * ih;
  const density = (area < 150 ? .24 : area < 400 ? .2 : area < 800 ? .14 : .09) * dens;   // big halls stay airy
  let budget = Math.max(0, Math.round(area * density) - solidTiles);
  const maxItems = Math.max(2, Math.round(area / (area < 400 ? 20 : 28) * Math.max(.5, dens)));
  const dist = (x, y, tx, ty) => Math.abs(x - tx) + Math.abs(y - ty);
  const doorPt = lands.length ? [lands[0].x + lands[0].w / 2, lands[0].y + lands[0].h / 2] : [I.x0 + iw / 2, I.y1];
  /** Put `d` at the valid spot nearest to (tx,ty) that keeps the room walkable. */
  const nearest = (d, tx, ty) => {
    const opts = [];
    for (let y = I.y0; y + d.h <= I.y1; y++) for (let x = I.x0; x + d.w <= I.x1; x++) if (fits(d, x, y) && (d.solid || apart(d, x, y))) opts.push([dist(x + d.w / 2, y + d.h / 2, tx, ty) + rnd() * .5, x, y]);
    opts.sort((a, b) => a[0] - b[0]);
    for (const [, x, y] of opts.slice(0, 8)) if (connected(d, x, y)) { put(d, x, y); return true; }
    return false;
  };

  // 0. centrepieces (a template's fountain, reception desk …) near the middle of the open floor
  const noFloor = new Set();
  for (const d of ctx.center || []) {
    if (!d) continue;
    if (nearest(d, I.x0 + iw / 2, I.y0 + ih / 2 + 1)) budget -= d.solid ? d.w * d.h : 0;
    noFloor.add(d.id);
  }

  // 1. musholla: rows (saf) of mats that all face one direction = the face of the catalog's pray spots (now: up, the top wall);
  //    shoe rack and wudhu by the door
  if (kind === 'musholla') {
    const prayFace = d => (d.spots || []).find(s => s.pose === 'pray')?.face || 'up';
    const mats = cands.filter(d => (d.affords || []).includes('pray')).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
    if (mats.length) {
      const face = prayFace(mats[0]), pool = mats.filter(m => prayFace(m) === face && m.h === mats[0].h);
      pool.forEach(m => noFloor.add(m.id));
      const vert = face === 'up' || face === 'down';   // facing up/down: saf are horizontal rows, stacked along y
      const m0 = pool[0], gx = vert ? 0 : 1, gy = vert ? 1 : 0;
      const cap = Math.max(2, Math.round(area * .42 / (m0.w * m0.h)));
      let n = 0;
      const rows = [];
      if (vert) for (let y = I.y0 + 1; y + m0.h <= I.y1 - 1; y += m0.h + gy) rows.push(y); else for (let x = I.x0 + 1; x + m0.w <= I.x1 - 1; x += m0.w + gx) rows.push(x);
      if (face === 'down' || face === 'right') rows.reverse();
      for (const lead of rows) {
        const mat = pool[Math.floor(rnd() * pool.length)];
        if (vert) {
          const per = Math.max(1, Math.min(6, Math.floor((iw - 2 + gx) / (mat.w + gx))));
          const x0 = I.x0 + Math.floor((iw - (per * (mat.w + gx) - gx)) / 2);
          for (let k = 0; k < per && n < cap; k++) if (fits(mat, x0 + k * (mat.w + gx), lead)) { put(mat, x0 + k * (mat.w + gx), lead); n++; }
        } else {
          const per = Math.max(1, Math.min(6, Math.floor((ih - 2 + gy) / (mat.h + gy))));
          const y0 = I.y0 + Math.floor((ih - (per * (mat.h + gy) - gy)) / 2);
          for (let k = 0; k < per && n < cap; k++) if (fits(mat, lead, y0 + k * (mat.h + gy))) { put(mat, lead, y0 + k * (mat.h + gy)); n++; }
        }
        if (n >= cap) break;
      }
    }
    const rack = cands.find(d => SHOE.test(`${d.id} ${d.name}`));
    if (rack) { nearest(rack, doorPt[0], doorPt[1]); noFloor.add(rack.id); }
    const wudhu = pick(cands.filter(d => (d.affords || []).includes('wudhu')));
    if (wudhu) { nearest(wudhu, doorPt[0], doorPt[1]); noFloor.add(wudhu.id); }
  }

  // 2. wall items along the top wall, left to right with random gaps
  const walls = cands.filter(d => d.wall && !noFloor.has(d.id));
  let wallTiles = 0;
  const wallCap = Math.round(iw * .7 * Math.min(1.3, wallShare));
  if (walls.length && wallCap > 0) {
    for (let x = I.x0 + (rnd() < .5 ? 0 : 1); x < I.x1 && wallTiles < wallCap;) {
      const d = pick(walls.filter(w => x + w.w <= I.x1));
      if (!d) break;
      if (fits(d, x, I.y0) && connected(d, x, I.y0)) { put(d, x, I.y0); x += d.w + Math.floor(rnd() * 3) + (wallShare < 1 ? 2 : 0); wallTiles += d.w; } else x++;
    }
  }

  // 3. solid floor items: edges and corners first, the middle last
  const floor = cands.filter(d => !d.wall && !noFloor.has(d.id));
  const solids = floor.filter(d => d.solid), flats = floor.filter(d => !d.solid);
  const failed = new Set();
  let placed = out.length;
  for (let g = 0; g < 80 && budget > 0 && placed < maxItems; g++) {
    const d = pick(solids.filter(s => !failed.has(s.id) && s.w * s.h <= budget + 3));
    if (!d) break;
    const opts = [], big = d.w * d.h >= 9;
    for (let y = I.y0; y + d.h <= I.y1; y++) for (let x = I.x0; x + d.w <= I.x1; x++) {
      if (!fits(d, x, y)) continue;
      const dl = x - I.x0, dr = I.x1 - (x + d.w), db = I.y1 - (y + d.h), dt = y - I.y0;
      const e = Math.min(dl, dr, db, dt), corner = [dl, dr, db, dt].filter(v => v === 0).length >= 2;
      opts.push([-e * (big ? .8 : 2.2) + rnd() * (big ? 3 : 2.5) + (corner ? 3 : 0), x, y]);
    }
    opts.sort((a, b) => b[0] - a[0]);
    const ok = opts.slice(0, 10).find(([, x, y]) => connected(d, x, y));
    if (!ok) { failed.add(d.id); continue; }
    put(d, ok[1], ok[2]); budget -= d.w * d.h; placed++;
  }

  // 4. flat decor (rugs, mats) in the open middle, a couple at most
  const flatCap = Math.round((Math.max(0, Math.round(area / 110)) + (area > 80 ? 1 : 0)) * Math.min(1.5, dens));
  for (let g = 0, n = 0; g < 10 && n < flatCap && flats.length; g++) {
    const d = pick(flats); if (!d) break;
    const cx = I.x0 + iw / 2, cy = I.y0 + ih / 2, opts = [];
    for (let y = I.y0; y + d.h <= I.y1; y++) for (let x = I.x0; x + d.w <= I.x1; x++) if (fits(d, x, y) && apart(d, x, y)) opts.push([-dist(x + d.w / 2, y + d.h / 2, cx, cy) * .4 + rnd() * 3, x, y]);
    opts.sort((a, b) => b[0] - a[0]);
    if (opts.length) { put(d, opts[0][1], opts[0][2]); n++; }
  }
  return out;
}

/**
 * Geometry-only port of the stage's world build (office-canvas.js build/furnish/furnishZone/placeDesks): the walk grid with
 * walls, doors, built-in room furniture, street decor and desks, without any catalog furniture. Keep in step with office-canvas.js.
 * Returns { W, H, walk (Uint8Array, 1 = free), inRoom, rooms, desks: [{room, zone, tx, ty, w, role, spare, big, seat:{tx,ty}, front:{tx,ty}}] }.
 */
export function builtIns(plan, roles = []) {
  const W = plan.w, H = plan.h;
  const walk = new Uint8Array(W * H), inRoomG = new Int16Array(W * H).fill(-1);
  const rooms = plan.rooms.filter(r => r.kind !== 'zone');
  rooms.forEach((r, i) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x < W && y < H) inRoomG[y * W + x] = i; });
  for (let i = 0; i < W * H; i++) if (inRoomG[i] === -1) walk[i] = 1;
  rooms.forEach(r => { for (let y = r.y + WH; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) walk[y * W + x] = 1; });
  rooms.forEach(r => {
    for (let x = r.x; x < r.x + r.w; x++) { for (let y = r.y; y < r.y + WH; y++) walk[y * W + x] = 0; walk[(r.y + r.h - 1) * W + x] = 0; }
    for (let y = r.y; y < r.y + r.h; y++) { walk[y * W + r.x] = 0; walk[y * W + r.x + r.w - 1] = 0; }
  });
  rooms.forEach(r => (r.doors || []).forEach(d => { for (let k = 0; k < d.w; k++) {
    if (d.s === 'b') walk[(r.y + r.h - 1) * W + r.x + d.at + k] = 1;
    if (d.s === 't') for (let y = r.y; y < r.y + WH; y++) walk[y * W + r.x + d.at + k] = 1;
    if (d.s === 'l') walk[(r.y + d.at + k) * W + r.x] = 1;
    if (d.s === 'r') walk[(r.y + d.at + k) * W + r.x + r.w - 1] = 1;
  } }));
  const desks = [];
  const block = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) walk[yy * W + xx] = 0; };
  let cur = null;
  const put = (tx, ty, fw, fh, o = {}) => {
    if (cur && !o.any && (tx < cur.x + 1 || ty < cur.y + WH || tx + fw > cur.x + cur.w - 1 || ty + fh > cur.y + cur.h - 1)) return false;
    block(tx, ty, fw, fh);
    return true;
  };
  const residents = id => roles.filter(r => r.room === id && !r.archived);
  const deskAt = (room, tx, ty, role, big, spare) => {
    const d = { room: room.id, zone: null, tx, ty, w: big ? 7 : 5, role: role ? role.id : null, spare: !!spare, big: !!big };
    d.seat = big ? { tx: tx + 3, ty: ty - 1 } : { tx: tx + 2, ty: ty + 2 };
    d.front = big ? { tx: tx + 3, ty: ty + 3 } : { tx: tx + 4, ty: ty + 3 };
    desks.push(d); return d;
  };
  const placeDesks = (room, list, x0, x1, row, maxRow) => {
    let x = x0, y = row;
    for (const it of list) {
      if (x + 5 > x1) { x = x0; y += 5; }
      if (y + 2 > maxRow) break;
      deskAt(room, x, y, it.role, false, it.spare); x += 7;
    }
  };
  const P1 = (x, y) => put(x, y, 1, 1);
  for (const r of rooms) {
    cur = r;
    const ix = r.x + 1, iy = r.y + WH, iw = r.w - 2, ih = r.h - WH - 1;
    const res = residents(r.id).map(role => ({ role }));
    const spares = n => Array.from({ length: n }, () => ({ role: null, spare: true }));
    switch (r.kind) {
      case 'manager': {
        const cx = ix + Math.floor(iw / 2) - 3, mgr = res[0];
        deskAt(r, cx, iy + 6, mgr?.role || null, true, !mgr);
        placeDesks(r, [...res.slice(1), ...spares(2)], ix + 2, ix + iw, iy + 11, iy + ih - 3);
        put(ix, iy, 4, 1); P1(ix + iw - 1, iy); P1(cx + 8, iy + 7);
        put(ix + 1, iy + ih - 2, 5, 2); put(ix + iw - 2, iy + 9, 2, 1); P1(ix + iw - 1, iy + ih - 1);
        break;
      }
      case 'meeting':
        put(ix + Math.max(1, Math.floor((iw - 10) / 2)), iy + 4, 10, 4); P1(ix, iy); P1(ix + iw - 1, iy); put(ix + iw - 4, iy + 9, 4, 1);
        placeDesks(r, res, ix + 1, ix + iw, iy + 11, iy + ih - 1);
        break;
      case 'lib':
        for (let k = 0; k * 5 + 4 <= iw - 2; k++) if (k !== 2) put(ix + k * 5, iy, 4, 1);
        put(ix + 6, iy + 7, 4, 2); put(ix + 14, iy + 8, 2, 2); put(ix + 1, iy + 12, 2, 2);
        P1(ix + iw - 2, iy + 12); P1(ix + iw - 1, iy + ih - 1); put(ix + 8, iy + 13, 4, 1);
        placeDesks(r, res, ix + 4, ix + iw, iy + 4, iy + 6);
        break;
      case 'qa':
        put(ix + 1, iy, 8, 1);
        placeDesks(r, [...res, ...spares(1)], ix + 2, ix + iw, iy + 6, iy + ih - 1);
        put(ix + iw - 2, iy, 2, 1); P1(ix + iw - 1, iy + ih - 1); put(ix, iy + ih - 1, 2, 1);
        break;
      case 'server':
        for (let k = 0; k < 4; k++) put(ix + 1 + k * 2, iy, 2, 1);
        put(ix + iw - 3, iy, 3, 1);
        for (let k = 0; k < 3; k++) put(ix + 2 + k * 2, iy + 7, 2, 1);
        placeDesks(r, res, ix + 9, ix + iw, iy + 7, iy + ih - 1);
        break;
      case 'beku':
        put(ix + 1, iy + 3, 5, 2); put(ix + 7, iy + 3, 5, 2); put(ix, iy + 9, 3, 2); put(ix + 9, iy + 10, 3, 2); put(ix + iw - 2, iy, 2, 1);
        placeDesks(r, res, ix + 1, ix + iw, iy + 13, iy + ih - 1);
        break;
      case 'pantry':
        put(ix + 1, iy, 7, 1); put(ix + 9, iy, 2, 1); P1(ix + 12, iy); put(ix + iw - 3, iy, 2, 1);
        put(ix + 4, iy + 7, 9, 2); put(ix + 16, iy + 13, 4, 2); put(ix + 4, iy + 13, 4, 2); P1(ix + iw - 1, iy + ih - 1); P1(ix, iy + ih - 1);
        break;
      case 'musik':
        put(ix, iy, 2, 2); put(ix + 3, iy, 6, 2); put(ix + 5, iy + 2, 2, 1); P1(ix + 10, iy + 1);
        put(ix + 16, iy, 4, 2); put(ix + 21, iy, 2, 2); put(ix + iw - 2, iy, 2, 2);
        put(ix + 1, iy + 7, 5, 3); put(ix + 12, iy + 7, 5, 2);
        for (const [bx, by] of [[10, 11], [17, 12], [19, 9]]) if (put(ix + bx, iy + by, 2, 1)) walk[(iy + by) * W + ix + bx] = 1;
        P1(ix, iy + ih - 1); P1(ix + iw - 1, iy + ih - 1);
        break;
      case 'toilet':
        for (let k = 0; k < 3; k++) put(ix + 1 + k * 3, iy, 3, 1);
        put(ix + 12, iy, 2, 1); put(ix + 14, iy, 2, 1);
        break;
      case 'booth':
        put(ix + 2, iy + 2, 4, 2); put(ix + 9, iy + 2, 4, 2); P1(ix + iw - 1, iy + ih - 1);
        break;
      case 'lobby':
        put(ix + Math.max(1, Math.floor((iw - 8) / 2)), iy + 5, 8, 2); put(ix + 1, iy + 16, 5, 2); put(ix + iw - 6, iy + 16, 5, 2);
        P1(ix, iy); P1(ix + iw - 1, iy + 3); P1(ix, iy + ih - 1); P1(ix + iw - 1, iy + ih - 1);
        P1(ix + 2, iy + 24); put(ix + 6, iy + 32, 4, 1); put(ix + 2, iy + 38, 2, 2); put(ix + iw - 4, iy + 38, 2, 2);
        break;
      case 'openplan':
        put(ix + 22, iy + ih - 1, 2, 1); P1(ix + 25, iy + ih - 1); P1(ix + 20, iy + ih - 1);
        break;
      case 'musholla': case 'lounge': case 'gym': case 'taman': case 'telepon': case 'tidur': break;
      case 'game':
        placeDesks(r, [...res, ...spares(2)], ix + 2, ix + iw - 6, iy + 3, iy + ih - 6);
        put(ix + iw - 3, iy, 2, 1); put(ix + iw - 6, iy, 2, 1); put(ix + 3, iy + ih - 3, 2, 1); put(ix + 7, iy + ih - 2, 2, 1);
        P1(ix, iy + ih - 1); put(ix + 12, iy + ih - 2, 4, 1);
        break;
      default: { // kode
        placeDesks(r, [...res, ...spares(res.length ? 1 : 2)], ix + 2, ix + iw - 1, iy + 3, iy + ih - 1);
        P1(ix + iw - 1, iy);
        if (ih > 12) { put(ix, iy + ih - 2, 2, 1); P1(ix + iw - 1, iy + ih - 1); }
        if (r.w > 30) { put(ix + iw - 4, iy + ih - 1, 2, 1); put(ix + 12, iy + ih - 3, 5, 2); }
      }
    }
  }
  for (const z of plan.rooms.filter(r => r.kind === 'zone')) {
    const op = rooms.find(r => r.id === z.zoneOf); if (!op) continue;
    cur = op;
    const iy = op.y + WH, res = residents(z.id);
    let x = z.x + 2;
    const list = [...res.map(role => ({ role })), { role: null, spare: true }];
    if (res.length < 1) list.push({ role: null, spare: true });
    for (const it of list) { if (x + 5 > z.x + z.w - 1) break; const d = deskAt(op, x, iy + 6, it.role, false, it.spare); d.zone = z.id; x += 7; }
    if (z.x + z.w < op.x + op.w - 1) put(z.x + z.w - 1, iy + 1, 1, 7, { any: true });
    put(z.x + 1, iy + 12, 1, 1, { any: true });
  }
  cur = null;
  for (const d of plan.decor || []) {
    if (d.t === 'plant' || d.t === 'water') P1(d.x, d.y);
    if (d.t === 'vending') put(d.x, d.y, 2, 1);
    if (d.t === 'bench') put(d.x, d.y, 4, 1);
  }
  const seat = new Set();
  for (const d of desks) { block(d.tx, d.ty, d.w, 2); walk[d.seat.ty * W + d.seat.tx] = 1; seat.add(d.seat.ty * W + d.seat.tx); }
  return { W, H, walk, inRoom: inRoomG, rooms, desks, seat };
}

/** Rooms nobody can walk into from the lobby on a walk grid (from builtIns, optionally with furniture applied). */
export function unreachableRooms(world) {
  const { W, H, walk, rooms } = world;
  const lobby = rooms.find(r => r.kind === 'lobby') || rooms[0];
  if (!lobby) return [];
  const seen = new Uint8Array(W * H), q = [];
  const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  for (let y = lobby.y + WH; y < lobby.y + lobby.h - 1 && !q.length; y++) for (let x = lobby.x + 1; x < lobby.x + lobby.w - 1; x++) if (walk[y * W + x]) { seen[y * W + x] = 1; q.push(y * W + x); break; }
  while (q.length) {
    const i = q.pop(), x = i % W, y = (i - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (ok(nx, ny) && walk[ny * W + nx] && !seen[ny * W + nx]) { seen[ny * W + nx] = 1; q.push(ny * W + nx); }
  }
  const lost = rooms.filter(r => {
    if (r === lobby) return false;
    for (let y = r.y + WH; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (ok(x, y) && seen[y * W + x]) return false;
    return true;
  });
  return Object.assign(lost, { seen });
}
