// Pixel office renderer driven by live session state.
import { short, hashStr, guestLook } from './util.js';

const T = 8, WH = 4;
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const P = {
  out: '#1C1825', ol: '#2A2430',
  wall: '#EEEAE2', wallHi: '#FBF9F4', wallLo: '#D9D4CA', wallEdge: '#2A2430',
  face: '#EAE6DD', faceLow: '#DDD8CE', trim: '#B9B2A6', faceTop: '#F7F4EE',
  glass: 'rgba(170,205,225,.45)', glassFrame: '#7F98A6',
  corr: ['#9DB3A6', '#99AFA2', '#89A093'],
  teal: ['#98AF9F', '#94AB9B', '#869E8E', '#7F9787'], teal2: ['#9AAFB0', '#96ABAC', '#879D9E', '#7E9496'],
  wood: ['#98AF9F', '#94AB9B', '#869E8E', '#7F9787'], carpet: ['#98AF9F', '#94AB9B', '#869E8E', '#7F9787'],
  carpetGreen: ['#A3B596', '#9FB192', '#90A383', '#889B7B'], wood2: ['#B98F62', '#B08759', '#9A774D'],
  marble: ['#E3DFD6', '#DCD8CF', '#CBC6BC'], tile: ['#E6E8EA', '#DEE1E4', '#CACED2'],
  metal: ['#5A616E', '#555B68', '#4A505C'], frozen: ['#BFC1C6', '#B8BABF'],
  deskTop: '#D6B07A', deskHi: '#E4C28F', deskFront: '#B88E58', deskDark: '#9C7646',
  chair: '#D59A55', chairHi: '#E8B371', mon: '#2F2A35', scrOff: '#3B3F4A', scrOn: '#4E8FD8', scrOnHi: '#8EC0F0',
  code: ['#E8F2FF', '#B9DAFF', '#FFE08A', '#C8F0D0'],
};
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function R(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }
function disc(c, cx, cy, r, col) { for (let dy = -r; dy <= r; dy++) { const w = Math.floor(Math.sqrt(r * r - dy * dy) + .4); R(c, cx - w, cy + dy, 2 * w + 1, 1, col); } }
function line(c, x0, y0, x1, y1, col) { x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0; const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy; for (let i = 0; i < 400; i++) { R(c, x0, y0, 1, 1, col); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } } }
function mk(w, h, fn) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; fn(cv.getContext('2d')); return cv; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------------- sprites ---------------- */
const SP = {};
function outlined(w, h, fn) {
  const cv = mk(w + 2, h + 2, c => { c.translate(1, 1); fn(c); });
  const c = cv.getContext('2d'), img = c.getImageData(0, 0, cv.width, cv.height), d = img.data, W = cv.width, H = cv.height;
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 40;
  const out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) out.push([x, y]);
  c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = P.ol;
  for (const [x, y] of out) c.fillRect(x, y, 1, 1);
  return cv;
}
const spr = (name, w, h, fn) => SP[name] ||= outlined(w, h, fn);
function plantSpr(v) {
  return spr('plant' + v, 16, 24, c => {
    R(c, 4, 18, 8, 6, '#B5653A'); R(c, 3, 17, 10, 2, '#C9784A'); R(c, 4, 22, 8, 2, '#9A532F');
    const g1 = '#3E8E4E', g2 = '#58A867', g3 = '#2F7340';
    if (v % 2) { R(c, 6, 2, 4, 15, g1); R(c, 2, 6, 4, 9, g2); R(c, 10, 5, 4, 10, g2); R(c, 7, 0, 2, 3, g2); R(c, 4, 10, 2, 6, g3); R(c, 11, 11, 2, 5, g3); }
    else { R(c, 3, 8, 10, 9, g1); R(c, 5, 5, 6, 4, g2); R(c, 1, 11, 3, 4, g2); R(c, 12, 10, 3, 5, g2); R(c, 6, 9, 2, 2, g2); R(c, 9, 12, 2, 2, g3); }
  });
}
const S = {
  bookshelf: () => spr('shelf', 32, 42, c => {
    R(c, 0, 0, 32, 42, '#6E4B2E'); R(c, 2, 2, 28, 38, '#4A321F');
    const cols = ['#B64A3D', '#3E6BA8', '#D9A441', '#4F8F5B', '#7A4F96', '#D8D2C2', '#2F5D6E'];
    for (let s = 0; s < 4; s++) { const y0 = 3 + s * 10; R(c, 2, y0 + 8, 28, 2, '#6E4B2E'); let x = 3, i = s * 3; while (x < 28) { const bw = 2 + (i * 7 % 3), bh = 5 + (i * 5 % 3); R(c, x, y0 + 8 - bh, bw, bh, cols[i % cols.length]); x += bw + (i % 4 === 0 ? 1 : 0); i++; } }
  }),
  rack: () => spr('rack', 16, 44, c => { R(c, 0, 0, 16, 44, '#1B1E25'); R(c, 1, 1, 14, 42, '#262A33'); for (let y = 3; y < 42; y += 4) R(c, 2, y, 12, 3, '#30353F'); }),
  sofa: col => spr('sofa' + col, 40, 20, c => { R(c, 0, 4, 40, 14, col); R(c, 2, 0, 36, 8, col); R(c, 0, 4, 4, 14, '#00000022'); R(c, 36, 4, 4, 14, '#00000022'); R(c, 4, 8, 15, 6, '#FFFFFF22'); R(c, 21, 8, 15, 6, '#FFFFFF22'); R(c, 2, 18, 3, 2, '#2B2B2B'); R(c, 35, 18, 3, 2, '#2B2B2B'); }),
  armchair: col => spr('arm' + col, 16, 18, c => { R(c, 0, 4, 16, 12, col); R(c, 2, 0, 12, 7, col); R(c, 3, 8, 10, 5, '#FFFFFF22'); R(c, 1, 16, 2, 2, '#2B2B2B'); R(c, 13, 16, 2, 2, '#2B2B2B'); }),
  meetingTable: () => spr('mtable', 76, 34, c => {
    for (let i = 0; i < 4; i++) { R(c, 8 + i * 17, 0, 10, 9, P.chair); R(c, 9 + i * 17, 0, 8, 1, P.chairHi); }
    R(c, 2, 8, 72, 13, '#B48A5C'); R(c, 2, 8, 72, 2, '#C9A06D'); R(c, 2, 21, 72, 4, '#7E5F3C');
    for (let i = 0; i < 4; i++) { R(c, 8 + i * 17, 26, 10, 8, P.chair); R(c, 9 + i * 17, 26, 8, 1, P.chairHi); }
    R(c, 20, 11, 6, 4, '#F4F4F4'); R(c, 46, 12, 5, 3, '#F4F4F4'); R(c, 60, 10, 3, 3, '#E2A23A');
  }),
  roundTable: () => spr('rtable', 28, 22, c => { R(c, 0, 10, 6, 6, P.chair); R(c, 22, 10, 6, 6, P.chair); R(c, 6, 4, 16, 10, '#D8D2C2'); R(c, 6, 4, 16, 2, '#EEE9DD'); R(c, 13, 14, 2, 6, '#7A7A7A'); R(c, 9, 20, 10, 2, '#7A7A7A'); R(c, 10, 6, 3, 3, '#FFFFFF'); }),
  longTable: () => spr('ltable', 66, 26, c => { R(c, 0, 6, 66, 10, '#C9A06D'); R(c, 0, 6, 66, 2, '#D9B37F'); R(c, 0, 16, 66, 3, '#8E6A42'); for (let i = 0; i < 5; i++) { R(c, 4 + i * 13, 0, 6, 5, '#5A606E'); R(c, 4 + i * 13, 20, 6, 5, '#5A606E'); } R(c, 10, 8, 3, 3, '#FFFFFF'); R(c, 40, 8, 4, 3, '#E5655D'); }),
  counter: () => spr('counter', 56, 36, c => {
    R(c, 0, 14, 56, 22, '#8A6A45'); R(c, 0, 12, 56, 3, '#D8D2C2'); R(c, 4, 18, 22, 14, '#7A5C3A'); R(c, 30, 18, 22, 14, '#7A5C3A'); R(c, 14, 24, 2, 3, '#C9A15A'); R(c, 40, 24, 2, 3, '#C9A15A');
    R(c, 4, 0, 12, 13, '#2A2E37'); R(c, 6, 2, 8, 3, '#3A3F4B'); R(c, 13, 8, 1, 1, '#E5655D'); R(c, 8, 9, 3, 3, '#FFFFFF');
    R(c, 22, 6, 14, 7, '#C9CFD6'); R(c, 24, 7, 10, 4, '#9AA3AF'); R(c, 28, 3, 2, 4, '#9AA3AF'); R(c, 40, 3, 12, 10, '#E9ECEF'); R(c, 41, 4, 7, 6, '#2B303B');
  }),
  fridge: () => spr('fridge', 16, 40, c => { R(c, 0, 0, 16, 40, '#E9ECEF'); R(c, 0, 14, 16, 1, '#C5CBD2'); R(c, 13, 0, 3, 40, '#D5DAE0'); R(c, 2, 5, 1, 6, '#9AA0A8'); R(c, 2, 18, 1, 8, '#9AA0A8'); R(c, 5, 22, 4, 4, '#F2CF72'); }),
  water: () => spr('water', 10, 32, c => { R(c, 2, 0, 6, 9, '#8FC7EA'); R(c, 3, 0, 4, 1, '#6FAED8'); R(c, 1, 9, 8, 23, '#EDEFF2'); R(c, 7, 9, 2, 23, '#D2D6DC'); R(c, 3, 15, 1, 2, '#C2413A'); R(c, 6, 15, 1, 2, '#3B7DD8'); }),
  vending: () => spr('vending', 18, 36, c => { R(c, 0, 0, 18, 36, '#B23A3A'); R(c, 2, 3, 10, 24, '#1E2A38'); for (let y = 5; y < 26; y += 5) for (let x = 3; x < 11; x += 3) R(c, x, y, 2, 3, ['#F2CF72', '#7FD3C9', '#E5655D', '#9FD67F'][(x + y) % 4]); R(c, 13, 5, 3, 6, '#2B2B2B'); R(c, 13, 13, 3, 2, '#7FD3C9'); R(c, 2, 29, 10, 4, '#2B2B2B'); }),
  bench: () => spr('bench', 32, 12, c => { R(c, 0, 0, 32, 4, '#9C7046'); R(c, 0, 4, 32, 2, '#7A5532'); R(c, 2, 6, 2, 6, '#555B66'); R(c, 28, 6, 2, 6, '#555B66'); }),
  reception: () => spr('recep', 58, 28, c => { R(c, 0, 6, 58, 22, '#7E5F3C'); R(c, 0, 4, 58, 4, '#D8D2C2'); R(c, 4, 12, 50, 12, '#9C7046'); R(c, 18, 14, 22, 8, '#A9620F'); R(c, 20, 16, 18, 4, '#F2CF72'); R(c, 6, 0, 8, 5, '#2A2F3A'); R(c, 7, 1, 6, 3, '#16303F'); R(c, 46, 1, 4, 4, '#C2413A'); }),
  printer: () => spr('printer', 18, 18, c => { R(c, 0, 6, 18, 12, '#D5D9DE'); R(c, 0, 6, 18, 2, '#EEF0F2'); R(c, 3, 2, 12, 5, '#F7F7F2'); R(c, 4, 10, 10, 2, '#2B303B'); R(c, 14, 13, 2, 1, '#2C8452'); }),
  cabinet: () => spr('cabinet', 14, 24, c => { R(c, 0, 0, 14, 24, '#8E959F'); for (let y = 2; y < 24; y += 7) { R(c, 1, y, 12, 6, '#A3AAB4'); R(c, 5, y + 2, 4, 1, '#5A606E'); } }),
  arcade: () => spr('arcade', 18, 38, c => { R(c, 1, 0, 16, 38, '#2F2A6B'); R(c, 0, 4, 18, 30, '#3B3584'); R(c, 3, 6, 12, 10, '#0E1218'); R(c, 4, 7, 10, 8, '#173042'); R(c, 6, 9, 3, 3, '#E2A23A'); R(c, 10, 11, 2, 2, '#7FD3C9'); R(c, 3, 19, 12, 5, '#1E1E24'); R(c, 5, 20, 2, 2, '#E5655D'); R(c, 10, 21, 2, 2, '#7FD3C9'); R(c, 2, 0, 14, 3, '#E5655D'); }),
  beanbag: col => spr('bean' + col, 18, 12, c => { R(c, 2, 2, 14, 10, col); R(c, 0, 5, 18, 7, col); R(c, 4, 3, 6, 3, '#FFFFFF33'); }),
  qaBench: () => spr('qabench', 66, 26, c => { R(c, 0, 12, 66, 4, '#C9CDD4'); R(c, 0, 16, 66, 3, '#9AA3AF'); R(c, 2, 19, 2, 7, '#7A808A'); R(c, 62, 19, 2, 7, '#7A808A'); for (let i = 0; i < 7; i++) { R(c, 4 + i * 9, 2, 6, 10, '#1B1F27'); R(c, 5 + i * 9, 3, 4, 7, '#2A4A5C'); } }),
  boxes: () => spr('boxes', 20, 20, c => { R(c, 0, 8, 12, 12, '#C49A62'); R(c, 0, 8, 12, 2, '#D9B37F'); R(c, 5, 8, 2, 12, '#A47A47'); R(c, 8, 0, 12, 10, '#B88B55'); R(c, 8, 0, 12, 2, '#D0A570'); R(c, 13, 0, 2, 10, '#9C7046'); R(c, 11, 10, 9, 10, '#C49A62'); }),
  sheet: () => spr('sheet', 40, 22, c => { R(c, 1, 4, 38, 16, '#E8E8E4'); R(c, 4, 0, 14, 6, '#F2F2EE'); R(c, 1, 18, 38, 4, '#CFCFC9'); R(c, 10, 8, 1, 10, '#D5D5CF'); R(c, 26, 6, 1, 12, '#D5D5CF'); }),
  stall: () => spr('stall', 24, 34, c => { R(c, 0, 0, 24, 34, '#A9B4C2'); R(c, 2, 2, 20, 30, '#BCC6D2'); R(c, 18, 16, 2, 2, '#5A606E'); R(c, 0, 0, 2, 34, '#8E99A8'); R(c, 22, 0, 2, 34, '#8E99A8'); }),
  sink: () => spr('sink', 18, 16, c => { R(c, 0, 4, 18, 12, '#E9ECEF'); R(c, 3, 5, 12, 5, '#C9D3DC'); R(c, 8, 0, 2, 5, '#9AA3AF'); R(c, 0, 14, 18, 2, '#C5CBD2'); }),
  globe: () => spr('globe', 12, 18, c => { disc(c, 6, 6, 5, '#3E6BA8'); R(c, 3, 4, 4, 3, '#4F8F5B'); R(c, 7, 7, 3, 2, '#4F8F5B'); R(c, 5, 12, 2, 4, '#7A5532'); R(c, 2, 16, 8, 2, '#7A5532'); }),
  wbStand: () => spr('wbstand', 30, 30, c => { R(c, 0, 0, 30, 20, '#9AA0A8'); R(c, 1, 1, 28, 18, '#F7F7F2'); line(c, 4, 5, 18, 5, '#3E6BA8'); line(c, 4, 9, 22, 9, '#3E6BA8'); line(c, 4, 13, 14, 13, '#C2413A'); R(c, 20, 11, 6, 5, '#F2CF72'); R(c, 4, 20, 2, 10, '#7A808A'); R(c, 24, 20, 2, 10, '#7A808A'); }),
  cooling: () => spr('cooling', 24, 36, c => { R(c, 0, 0, 24, 36, '#D5DAE0'); R(c, 2, 4, 20, 14, '#B9C0C8'); for (let y = 6; y < 17; y += 2) R(c, 3, y, 18, 1, '#9AA3AF'); R(c, 4, 22, 6, 3, '#2C8452'); }),
  trash: () => spr('trash', 10, 12, c => { R(c, 0, 0, 10, 12, '#8E959F'); R(c, 1, 1, 8, 10, '#6B727C'); for (let x = 1; x < 9; x += 2) R(c, x, 1, 1, 10, '#8E959F'); R(c, 2, 0, 3, 2, '#F4F4F4'); }),
  phoneBooth: () => spr('pbooth', 26, 30, c => { R(c, 0, 0, 26, 30, '#2F5D6E'); R(c, 2, 2, 22, 20, '#BFD9E6'); R(c, 8, 12, 10, 8, '#3C4250'); R(c, 0, 24, 26, 6, '#264B59'); }),
  part: () => spr('part', 8, 64, c => { R(c, 1, 8, 6, 56, '#8E959F'); R(c, 1, 8, 6, 2, '#B3B9C2'); R(c, 0, 0, 8, 10, '#3E8E4E'); R(c, 2, 0, 4, 3, '#58A867'); }),
};

function drawFloor(c, kind, x, y, w, h, seed) {
  const map = { wood: 'teal', carpet: 'teal', carpetGreen: 'carpetGreen', teal: 'teal', teal2: 'teal2' };
  const k = map[kind] || kind, pal = P[k] || P.teal;
  if (k === 'wood2') {
    for (let yy = 0; yy < h; yy += 6) { R(c, x, y + yy, w, Math.min(6, h - yy), (yy / 6) % 2 ? pal[0] : pal[1]); R(c, x, y + yy, w, 1, pal[2]); const off = ((yy / 6) * 13 + seed) % 28; for (let xx = off; xx < w; xx += 28) R(c, x + xx, y + yy, 1, Math.min(6, h - yy), pal[2]); }
    return;
  }
  if (k === 'frozen') { R(c, x, y, w, h, pal[0]); for (let i = 0; i < w + h; i += 10) line(c, x + Math.max(0, i - h), y + Math.min(h - 1, i), x + Math.min(w - 1, i), y + Math.max(0, i - w + 1), 'rgba(255,255,255,.12)'); return; }
  const s2 = k === 'tile' ? 8 : 16;
  R(c, x, y, w, h, pal[0]);
  for (let yy = 0; yy < h; yy += s2) for (let xx = 0; xx < w; xx += s2) {
    if (((xx + yy) / s2) % 2) R(c, x + xx, y + yy, s2, s2, pal[1]);
    R(c, x + xx, y + yy, s2, 1, pal[2]); R(c, x + xx, y + yy, 1, s2, pal[2]);
    if (pal[3] && s2 === 16) { R(c, x + xx - 1, y + yy, 3, 1, pal[3]); R(c, x + xx, y + yy - 1, 1, 3, pal[3]); }
  }
}

/* ============================================================ */
export function createStage(host, opts) {
  const { onPick, onRoom } = opts;
  let plan = opts.plan, roles = opts.roles, cards = opts.cards || [];
  let world = null, ents = new Map(), hits = [], raf = 0, lastT = performance.now(), sessions = [];
  const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
  let focus = null, sel = null, ins = { left: 0, top: 0, right: 0, bottom: 0, ...(opts.insets || {}) };
  const canvas = document.createElement('canvas');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');

  /* ---------- world ---------- */
  function build() {
    const W = plan.w, H = plan.h;
    const walk = new Uint8Array(W * H), inRoom = new Int16Array(W * H).fill(-1);
    const rooms = plan.rooms.filter(r => r.kind !== 'zone');
    rooms.forEach((r, i) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x < W && y < H) inRoom[y * W + x] = i; });
    for (let i = 0; i < W * H; i++) if (inRoom[i] === -1) walk[i] = 1;
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
    world = { W, H, walk, inRoom, rooms, items: [], desks: [], wallDeco: [], leds: [], phones: [], clocks: [], tvs: [], rugs: [], zones: [], elevator: null, seat: new Set() };
    const block = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) walk[yy * W + xx] = 0; };
    let cur = null;
    const put = (img, tx, ty, fw, fh, o = {}) => {
      if (cur && !o.any && (tx < cur.x + 1 || ty < cur.y + WH || tx + fw > cur.x + cur.w - 1 || ty + fh > cur.y + cur.h - 1)) return false;
      const px = tx * T + Math.round((fw * T - img.width) / 2), py = (ty + fh) * T - img.height;
      world.items.push({ img, x: px, y: py, sortY: (ty + fh) * T });
      block(tx, ty, fw, fh);
      return true;
    };
    for (const r of rooms) { cur = r; furnish(r, put); }
    for (const z of plan.rooms.filter(r => r.kind === 'zone')) { cur = rooms.find(r => r.id === z.zoneOf); furnishZone(z, cur, put); }
    cur = null;
    for (const d of plan.decor || []) {
      if (d.t === 'plant') put(plantSpr(d.x % 3), d.x, d.y, 1, 1);
      if (d.t === 'vending') put(S.vending(), d.x, d.y, 2, 1);
      if (d.t === 'bench') put(S.bench(), d.x, d.y, 4, 1);
      if (d.t === 'water') put(S.water(), d.x, d.y, 1, 1);
    }
    world.desks.forEach(d => { block(d.tx, d.ty, d.w, 2); walk[d.seat.ty * W + d.seat.tx] = 1; world.seat.add(d.seat.ty * W + d.seat.tx); });
    if (!world.elevator) { const lb = rooms.find(r => r.kind === 'lobby') || rooms[0]; world.elevator = { x: (lb.x + 2) * T, y: lb.y * T, open: 0, until: 0, tx: lb.x + 3, ty: lb.y + WH }; }
    world.items.sort((a, b) => a.sortY - b.sortY);
    buildBg();
  }
  function residents(id) { return roles.filter(r => r.room === id && !r.archived); }
  function deskAt(room, tx, ty, role, big, spare) {
    const d = { room: room.id, zone: null, tx, ty, w: big ? 7 : 5, role: role ? role.id : null, spare: !!spare, big: !!big, occ: null,
      mug: ['#FFFFFF', '#E5655D', '#3E6BA8', '#F2CF72', '#4F8F5B'][(tx + ty) % 5], item: ['lamp', 'duck', 'plant', 'cube', 'none', 'pen'][(tx * 7 + ty) % 6] };
    // workers sit on a stool south of the desk, facing the monitor; the manager sits behind a big desk facing us
    d.facing = big ? 'down' : 'up';
    d.seat = big ? { x: (tx + 3) * T + 4, y: (ty - 1) * T + 7, tx: tx + 3, ty: ty - 1 } : { x: (tx + 2) * T + 4, y: (ty + 2) * T + 9, tx: tx + 2, ty: ty + 2 };
    d.front = big ? { tx: tx + 3, ty: ty + 3 } : { tx: tx + 4, ty: ty + 3 };
    world.desks.push(d); return d;
  }
  function placeDesks(room, list, x0, x1, row, maxRow) {
    let x = x0, y = row;
    for (const it of list) {
      if (x + 5 > x1) { x = x0; y += 5; }
      if (y + 2 > maxRow) break;
      deskAt(room, x, y, it.role, false, it.spare); x += 7;
    }
  }
  function furnish(r, put) {
    const ix = r.x + 1, iy = r.y + WH, iw = r.w - 2, ih = r.h - WH - 1;
    const deco = (t, px, extra = {}) => world.wallDeco.push({ t, room: r, x: r.x * T + px, y: r.y * T, ...extra });
    const ext = r.y === 0;
    const res = residents(r.id).map(role => ({ role }));
    const spares = n => Array.from({ length: n }, () => ({ role: null, spare: true }));
    switch (r.kind) {
      case 'manager': {
        deco('window', 12); deco('poster', 50); deco('wb', Math.min(80, r.w * T - 100), { w: 64 }); if (r.w > 22) deco('window', r.w * T - 40); deco('clock', r.w * T - 24);
        const cx = ix + Math.floor(iw / 2) - 3;
        world.rugs.push({ x: (cx - 3) * T, y: (iy + 4) * T, w: 13 * T, h: 6 * T, c1: '#9E2F2F', c2: '#D9A441' });
        const mgr = res[0];
        deskAt(r, cx, iy + 6, mgr?.role || null, true, !mgr);
        placeDesks(r, [...res.slice(1), ...spares(2)], ix + 2, ix + iw, iy + 11, iy + ih - 3);
        put(S.bookshelf(), ix, iy, 4, 1); put(plantSpr(1), ix + iw - 1, iy, 1, 1); put(S.trash(), cx + 8, iy + 7, 1, 1);
        put(S.sofa('#5A4A6E'), ix + 1, iy + ih - 2, 5, 2); put(S.cabinet(), ix + iw - 2, iy + 9, 2, 1); put(plantSpr(0), ix + iw - 1, iy + ih - 1, 1, 1);
        break;
      }
      case 'meeting':
        deco('tv', Math.max(24, Math.floor(r.w * T / 2) - 22), { w: 44 }); deco('clock', r.w * T - 26); deco('plantWall', 12);
        put(S.meetingTable(), ix + Math.max(1, Math.floor((iw - 10) / 2)), iy + 4, 10, 4); put(plantSpr(0), ix, iy, 1, 1); put(plantSpr(1), ix + iw - 1, iy, 1, 1); put(S.wbStand(), ix + iw - 4, iy + 9, 4, 1);
        placeDesks(r, res, ix + 1, ix + iw, iy + 11, iy + ih - 1);
        break;
      case 'lib':
        if (ext) deco('window', r.w * T - 50);
        for (let k = 0; k * 5 + 4 <= iw - 2; k++) if (k !== 2) put(S.bookshelf(), ix + k * 5, iy, 4, 1);
        put(S.roundTable(), ix + 6, iy + 7, 4, 2); put(S.armchair('#3E6BA8'), ix + 14, iy + 8, 2, 2); put(S.armchair('#3E6BA8'), ix + 1, iy + 12, 2, 2);
        put(S.globe(), ix + iw - 2, iy + 12, 1, 1); put(plantSpr(1), ix + iw - 1, iy + ih - 1, 1, 1); put(S.bookshelf(), ix + 8, iy + 13, 4, 1);
        placeDesks(r, res, ix + 4, ix + iw, iy + 4, iy + 6);
        break;
      case 'qa':
        deco('ci', 40); deco('clock', r.w * T - 26);
        if (put(S.qaBench(), ix + 1, iy, 8, 1)) world.phones.push({ x: (ix + 1) * T + 1, y: (iy + 1) * T - 26 + 2, n: 7 });
        placeDesks(r, [...res, ...spares(1)], ix + 2, ix + iw, iy + 6, iy + ih - 1);
        put(S.cabinet(), ix + iw - 2, iy, 2, 1); put(plantSpr(0), ix + iw - 1, iy + ih - 1, 1, 1); put(S.printer(), ix, iy + ih - 1, 2, 1);
        break;
      case 'server':
        deco('warn', 20); deco('clock', r.w * T - 26);
        for (let k = 0; k < 4; k++) if (put(S.rack(), ix + 1 + k * 2, iy, 2, 1)) world.leds.push({ x: (ix + 1 + k * 2) * T, y: (iy + 1) * T - 44 });
        put(S.cooling(), ix + iw - 3, iy, 3, 1);
        for (let k = 0; k < 3; k++) if (put(S.rack(), ix + 2 + k * 2, iy + 7, 2, 1)) world.leds.push({ x: (ix + 2 + k * 2) * T, y: (iy + 8) * T - 44 });
        placeDesks(r, res, ix + 9, ix + iw, iy + 7, iy + ih - 1);
        break;
      case 'beku':
        deco('beku', 30);
        put(S.sheet(), ix + 1, iy + 3, 5, 2); put(S.sheet(), ix + 7, iy + 3, 5, 2); put(S.boxes(), ix, iy + 9, 3, 2); put(S.boxes(), ix + 9, iy + 10, 3, 2); put(S.cabinet(), ix + iw - 2, iy, 2, 1);
        placeDesks(r, res, ix + 1, ix + iw, iy + 13, iy + ih - 1);
        break;
      case 'pantry':
        deco('menu', 74); deco('clock', r.w * T - 60); if (r.w > 24) deco('window', r.w * T - 40);
        put(S.counter(), ix + 1, iy, 7, 1); put(S.fridge(), ix + 9, iy, 2, 1); put(S.water(), ix + 12, iy, 1, 1); put(S.vending(), ix + iw - 3, iy, 2, 1);
        put(S.longTable(), ix + 4, iy + 7, 9, 2); put(S.roundTable(), ix + 16, iy + 13, 4, 2); put(S.roundTable(), ix + 4, iy + 13, 4, 2); put(plantSpr(1), ix + iw - 1, iy + ih - 1, 1, 1); put(plantSpr(0), ix, iy + ih - 1, 1, 1);
        break;
      case 'toilet':
        deco('wc', 60);
        for (let k = 0; k < 3; k++) put(S.stall(), ix + 1 + k * 3, iy, 3, 1);
        put(S.sink(), ix + 12, iy, 2, 1); put(S.sink(), ix + 14, iy, 2, 1);
        break;
      case 'booth':
        put(S.phoneBooth(), ix + 2, iy + 2, 4, 2); put(S.phoneBooth(), ix + 9, iy + 2, 4, 2); put(plantSpr(0), ix + iw - 1, iy + ih - 1, 1, 1);
        break;
      case 'lobby': {
        deco('logo', Math.min(64, (r.w - 10) * T), { w: 60 });
        const ex = r.elevator ?? 7;
        deco('elevator', ex * T);
        world.elevator = { x: (r.x + ex) * T, y: r.y * T, open: 0, until: 0, tx: r.x + ex + 2, ty: r.y + WH };
        world.rugs.push({ x: (ix + 2) * T, y: (iy + 10) * T, w: Math.min(14, iw - 4) * T, h: 8 * T, c1: '#3E5A7A', c2: '#C9A15A' });
        put(S.reception(), ix + Math.max(1, Math.floor((iw - 8) / 2)), iy + 5, 8, 2); put(S.sofa('#2F5D6E'), ix + 1, iy + 16, 5, 2); put(S.sofa('#2F5D6E'), ix + iw - 6, iy + 16, 5, 2);
        put(plantSpr(1), ix, iy, 1, 1); put(plantSpr(0), ix + iw - 1, iy + 3, 1, 1); put(plantSpr(1), ix, iy + ih - 1, 1, 1); put(plantSpr(0), ix + iw - 1, iy + ih - 1, 1, 1);
        put(S.water(), ix + 2, iy + 24, 1, 1); put(S.bench(), ix + 6, iy + 32, 4, 1); put(S.armchair('#7A3E3E'), ix + 2, iy + 38, 2, 2); put(S.armchair('#7A3E3E'), ix + iw - 4, iy + 38, 2, 2);
        break;
      }
      case 'openplan':
        if (ext) deco('window', 20);
        deco('clock', Math.min(200, r.w * T - 30)); deco('poster2', 120); if (r.w > 40) deco('poster3', 300);
        put(S.printer(), ix + 22, iy + ih - 1, 2, 1); put(S.water(), ix + 25, iy + ih - 1, 1, 1); put(S.trash(), ix + 20, iy + ih - 1, 1, 1);
        break;
      case 'game':
        deco('window', 20); deco('poster3', 90); deco('wb', 130, { w: 44, repo: r.id }); deco('clock', r.w * T - 26);
        placeDesks(r, [...res, ...spares(2)], ix + 2, ix + iw - 6, iy + 3, iy + ih - 6);
        put(S.arcade(), ix + iw - 3, iy, 2, 1); put(S.arcade(), ix + iw - 6, iy, 2, 1); put(S.beanbag('#E5655D'), ix + 3, iy + ih - 3, 2, 1); put(S.beanbag('#3E6BA8'), ix + 7, iy + ih - 2, 2, 1);
        put(plantSpr(1), ix, iy + ih - 1, 1, 1); put(S.bookshelf(), ix + 12, iy + ih - 2, 4, 1);
        break;
      default: { // kode
        if (ext) deco('window', 12); else deco('poster2', 12);
        deco('wb', Math.floor(r.w * T / 2) - 20, { w: 40, repo: r.id }); deco('clock', r.w * T - 22);
        placeDesks(r, [...res, ...spares(res.length ? 1 : 2)], ix + 2, ix + iw - 1, iy + 3, iy + ih - 1);
        put(plantSpr(r.x % 2), ix + iw - 1, iy, 1, 1);
        if (ih > 12) { put(S.cabinet(), ix, iy + ih - 2, 2, 1); put(plantSpr(0), ix + iw - 1, iy + ih - 1, 1, 1); }
        if (r.w > 30) { put(S.printer(), ix + iw - 4, iy + ih - 1, 2, 1); put(S.sofa('#6E5A3E'), ix + 12, iy + ih - 3, 5, 2); }
      }
    }
  }
  function furnishZone(z, op, put) {
    const iy = op.y + WH;
    world.zones.push({ ...z, py: iy * T, ph: (op.h - WH - 1) * T });
    const res = residents(z.id);
    let x = z.x + 2;
    const list = [...res.map(role => ({ role })), { role: null, spare: true }];
    if (res.length < 1) list.push({ role: null, spare: true });
    for (const it of list) { if (x + 5 > z.x + z.w - 1) break; const d = deskAt(op, x, iy + 6, it.role, false, it.spare); d.zone = z.id; x += 7; }
    if (z.x + z.w < op.x + op.w - 1) put(S.part(), z.x + z.w - 1, iy + 1, 1, 7, { any: true });
    put(plantSpr(z.x % 2), z.x + 1, iy + 12, 1, 1, { any: true });
  }

  /* ---------- static background ---------- */
  function buildBg() {
    const { W, H } = world;
    const cv = mk(W * T, H * T, () => {}), c = cv.getContext('2d');
    R(c, 0, 0, W * T, H * T, P.out);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if (world.inRoom[y * W + x] !== -1) continue;
      R(c, x * T, y * T, 2 * T, 2 * T, ((x + y) / 2) % 2 ? P.corr[0] : P.corr[1]);
      R(c, x * T, y * T, 2 * T, 1, P.corr[2]); R(c, x * T, y * T, 1, 2 * T, P.corr[2]);
      R(c, x * T - 1, y * T, 3, 1, P.teal[3]); R(c, x * T, y * T - 1, 1, 3, P.teal[3]);
    }
    world.rooms.forEach((r, i) => drawFloor(c, r.floor || 'carpet', r.x * T + T, r.y * T + WH * T, r.w * T - 2 * T, r.h * T - WH * T - T, i * 7));
    for (const z of world.zones) R(c, z.x * T, z.py + 2, (z.w - 1) * T, z.ph - 4, z.tint || 'rgba(255,255,255,.1)');
    for (const g of world.rugs) { R(c, g.x, g.y, g.w, g.h, g.c1); R(c, g.x + 3, g.y + 3, g.w - 6, 1, g.c2); R(c, g.x + 3, g.y + g.h - 4, g.w - 6, 1, g.c2); R(c, g.x + 3, g.y + 3, 1, g.h - 6, g.c2); R(c, g.x + g.w - 4, g.y + 3, 1, g.h - 6, g.c2); }
    world.rooms.forEach(r => drawWalls(c, r));
    world.clocks = []; world.tvs = []; world.lamps = [];
    for (const r of world.rooms) {
      if (r.kind === 'toilet' || r.kind === 'booth' || r.w < 10) continue;
      const n = r.w > 26 ? 2 : 1;
      for (let i = 0; i < n; i++) world.lamps.push({ x: (r.x + Math.round(r.w * (i + 1) / (n + 1))) * T, y: (r.y + WH + 1) * T + 2, warm: r.kind === 'pantry' || r.kind === 'lobby' });
    }
    world.wallDeco.forEach(d => drawWallDeco(c, d));
    world.bg = cv; world.bgAt = Date.now();
  }
  const doorCols = (r, side) => { const s = new Set(); (r.doors || []).filter(d => d.s === side).forEach(d => { for (let k = 0; k < d.w; k++) s.add(d.at + k); }); return s; };
  function drawWalls(c, r) {
    const x = r.x * T, y = r.y * T, w = r.w * T, h = r.h * T, glass = r.wall === 'glass';
    const tops = doorCols(r, 't'), bots = doorCols(r, 'b'), lefts = doorCols(r, 'l'), rights = doorCols(r, 'r');
    // back wall face: a light band with a lighter cap and a dark baseboard, like a top-down office
    for (let k = 1; k < r.w - 1; k++) {
      const fx = x + k * T;
      if (tops.has(k)) { R(c, fx, y, T, WH * T, P.corr[0]); R(c, fx, y, T, 1, P.corr[2]); continue; }
      R(c, fx, y, T, 5, P.wallHi); R(c, fx, y + 5, T, 1, P.wallEdge);
      if (glass) { R(c, fx, y + 6, T, WH * T - 6, P.glass); R(c, fx, y + 6, 1, WH * T - 6, P.glassFrame); }
      else { R(c, fx, y + 6, T, WH * T - 9, P.face); R(c, fx, y + WH * T - 8, T, 5, P.faceLow); }
      R(c, fx, y + WH * T - 3, T, 2, P.trim); R(c, fx, y + WH * T - 1, T, 1, P.ol);
    }
    [...tops].forEach(k => { if (!tops.has(k - 1)) { R(c, x + k * T - 2, y, 2, WH * T, P.wallEdge); } if (!tops.has(k + 1)) { R(c, x + (k + 1) * T, y, 2, WH * T, P.wallEdge); } });
    // side + bottom walls: thick light walls with dark edges
    const side = (sx, set) => {
      for (let k = 0; k < r.h; k++) {
        if (set.has(k)) continue;
        R(c, sx, y + k * T, T, T, glass && k >= WH ? P.glassFrame : P.wall);
        R(c, sx + 1, y + k * T, 2, T, P.wallHi);
        R(c, sx, y + k * T, 1, T, P.wallEdge); R(c, sx + T - 1, y + k * T, 1, T, P.wallEdge);
      }
    };
    side(x, lefts); side(x + w - T, rights);
    for (let k = 0; k < r.w; k++) {
      if (bots.has(k)) continue;
      R(c, x + k * T, y + h - T, T, T, glass ? P.glassFrame : P.wall); R(c, x + k * T, y + h - T, T, 2, P.wallHi);
      R(c, x + k * T, y + h - T, T, 1, P.wallEdge); R(c, x + k * T, y + h - 1, T, 1, P.wallEdge);
    }
    [...bots].forEach(k => { if (!bots.has(k - 1)) R(c, x + k * T - 1, y + h - T, 1, T, P.wallEdge); if (!bots.has(k + 1)) R(c, x + (k + 1) * T, y + h - T, 1, T, P.wallEdge); });
    [...lefts].forEach(k => { if (!lefts.has(k - 1)) R(c, x, y + k * T - 1, T, 1, P.wallEdge); if (!lefts.has(k + 1)) R(c, x, y + (k + 1) * T, T, 1, P.wallEdge); });
    [...rights].forEach(k => { if (!rights.has(k - 1)) R(c, x + w - T, y + k * T - 1, T, 1, P.wallEdge); if (!rights.has(k + 1)) R(c, x + w - T, y + (k + 1) * T, T, 1, P.wallEdge); });
  }

  function drawWallDeco(c, d) {
    const x = d.x, y = d.y + 4, hr = new Date().getHours(), day = hr >= 6 && hr < 18;
    if (d.x + 30 > (d.room.x + d.room.w) * T) return;
    switch (d.t) {
      case 'window': {
        const sky = hr >= 6 && hr < 16 ? '#8CC6EE' : hr >= 16 && hr < 18 ? '#EFA867' : '#1A2342';
        R(c, x, y + 2, 34, 22, '#EDEDED'); R(c, x + 2, y + 4, 30, 18, sky);
        if (day) { R(c, x + 22, y + 6, 4, 4, '#FFE58A'); R(c, x + 5, y + 7, 7, 2, '#FFFFFF'); } else R(c, x + 23, y + 6, 3, 3, '#E8E8F0');
        const rg = rng(d.x);
        for (let bx = x + 2; bx < x + 32; bx += 5) { const bh = 5 + Math.floor(rg() * 9); R(c, bx, y + 22 - bh, 4, bh, day ? '#5C6B85' : '#0E1426'); if (!day) for (let k = 0; k < 3; k++) if (rg() > .4) R(c, bx + 1 + (k % 2) * 2, y + 22 - bh + 2 + k * 2, 1, 1, '#F2CF72'); }
        R(c, x + 16, y + 2, 2, 22, '#EDEDED'); R(c, x - 1, y + 24, 36, 2, '#C9C9C9');
        break;
      }
      case 'poster': {
        R(c, x, y + 1, 18, 22, '#C9A15A'); R(c, x + 2, y + 3, 14, 18, '#2F5D9E'); R(c, x + 2, y + 3, 14, 4, '#F2CF72');
        const top = roles.find(r => r.isMgr) || roles[0];
        if (top) { R(c, x + 5, y + 9, 8, 7, top.skin); R(c, x + 5, y + 9, 8, 2, top.hair); R(c, x + 7, y + 13, 1, 1, '#1B1B22'); R(c, x + 10, y + 13, 1, 1, '#1B1B22'); R(c, x + 4, y + 16, 10, 5, top.color); }
        break;
      }
      case 'poster2': R(c, x, y + 3, 16, 20, '#FFFFFF'); R(c, x + 1, y + 4, 14, 18, '#2C8452'); R(c, x + 3, y + 7, 10, 2, '#F2CF72'); R(c, x + 3, y + 11, 7, 1, '#FFFFFF'); R(c, x + 3, y + 13, 9, 1, '#FFFFFF'); break;
      case 'poster3': R(c, x, y + 3, 20, 16, '#1E1E24'); R(c, x + 2, y + 5, 16, 12, '#C2413A'); R(c, x + 4, y + 8, 12, 2, '#F2CF72'); R(c, x + 4, y + 12, 3, 3, '#FFFFFF'); break;
      case 'wb': {
        const w = d.w || 40;
        R(c, x, y + 1, w, 22, '#9AA0A8'); R(c, x + 1, y + 2, w - 2, 20, '#F7F7F2'); R(c, x + 3, y + 23, w - 6, 1, '#7A808A');
        const list = d.repo ? cards.filter(k => k.repo === d.repo) : cards;
        const cols = ['#F2CF72', '#9FD67F', '#7FD3C9', '#F49AC1', '#C8C8C8'], cw = Math.floor((w - 4) / 5);
        for (let k = 0; k < 5; k++) { R(c, x + 2 + k * cw + cw - 1, y + 3, 1, 18, '#DADAD2'); list.filter(cd => cd.col === k).slice(0, 4).forEach((cd, i) => R(c, x + 3 + k * cw + (i % 2) * 3, y + 4 + Math.floor(i / 2) * 4 + (i % 2), 3, 3, cd.blocked ? '#E5655D' : cols[k])); }
        break;
      }
      case 'tv': R(c, x, y + 1, d.w, 22, '#14181F'); R(c, x + 2, y + 3, d.w - 4, 18, '#1E2A38'); world.tvs.push({ x: x + 2, y: y + 3, w: d.w - 4, h: 18 }); break;
      case 'clock': world.clocks.push({ x: x + 7, y: y + 10 }); disc(c, x + 7, y + 10, 7, '#2B303A'); disc(c, x + 7, y + 10, 6, '#F7F7F2'); break;
      case 'ci': R(c, x, y + 3, 30, 14, '#2C8452'); R(c, x + 2, y + 5, 26, 10, '#3A9A62'); R(c, x + 4, y + 7, 4, 4, '#FFFFFF'); R(c, x + 10, y + 7, 15, 1, '#FFFFFF'); break;
      case 'warn': R(c, x, y + 2, 24, 18, '#F2CF72'); R(c, x + 1, y + 3, 22, 16, '#1E1E24'); R(c, x + 2, y + 4, 20, 3, '#C2413A'); R(c, x + 10, y + 9, 3, 6, '#F2CF72'); R(c, x + 10, y + 16, 3, 2, '#F2CF72'); break;
      case 'beku': R(c, x, y + 4, 56, 14, '#BFC3C9'); for (let k = 0; k < 56; k += 8) { R(c, x + k, y + 8, 4, 6, '#F2CF72'); R(c, x + k + 4, y + 8, 4, 6, '#1E1E24'); } break;
      case 'menu': R(c, x, y + 2, 34, 20, '#2B2B2B'); R(c, x + 2, y + 4, 30, 16, '#3A3A3A'); for (let k = 0; k < 4; k++) R(c, x + 4, y + 6 + k * 4, 12 + (k * 5) % 10, 1, '#E8E8E8'); break;
      case 'wc': R(c, x, y + 6, 22, 12, '#3E6BA8'); R(c, x + 4, y + 9, 3, 6, '#FFFFFF'); R(c, x + 15, y + 9, 3, 6, '#FFFFFF'); break;
      case 'logo': R(c, x, y + 4, d.w, 14, '#1E2A38'); R(c, x + 2, y + 6, d.w - 4, 10, '#A9620F'); for (let k = 0; k < 7; k++) R(c, x + 6 + k * 7, y + 8, 5, 6, '#F2CF72'); break;
      case 'plantWall': R(c, x, y + 4, 26, 18, '#4F8F5B'); for (let k = 0; k < 26; k += 4) R(c, x + k, y + 4 + (k % 3) * 2, 3, 3, '#6CB37A'); break;
      case 'elevator': R(c, x - 2, y - 1, 36, WH * T - 2, '#8E959F'); R(c, x, y + 4, 32, WH * T - 7, '#5A606E'); break;
    }
  }

  /* ---------- pathfinding ---------- */
  function findPath(sx, sy, gx, gy) {
    const { W, H, walk } = world;
    const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && walk[y * W + x];
    if (!ok(gx, gy)) { const n = nearestWalk(gx, gy); if (!n) return null; [gx, gy] = n; }
    if (!ok(sx, sy)) { const n = nearestWalk(sx, sy); if (!n) return null; [sx, sy] = n; }
    const N = W * H, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N), heap = [];
    const push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const h = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(dx, dy) + .414 * Math.min(dx, dy); };
    const s = sy * W + sx, goal = gy * W + gx;
    g[s] = 0; push(s, h(sx, sy));
    const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    let iter = 0;
    while (heap.length && iter++ < 60000) {
      const [, i] = pop(); if (closed[i]) continue; closed[i] = 1; if (i === goal) break;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy, cost] of D) {
        const nx = x + dx, ny = y + dy; if (!ok(nx, ny)) continue;
        if (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
        const ni = ny * W + nx, ng = g[i] + cost;
        if (ng < g[ni]) { g[ni] = ng; from[ni] = i; push(ni, ng + h(nx, ny)); }
      }
    }
    if (from[goal] === -1 && goal !== s) return null;
    const pts = []; let k = goal;
    while (k !== -1 && k !== s) { pts.push(k); k = from[k]; }
    pts.reverse();
    const out = []; let pdx = null, pdy = null, prev = s;
    pts.forEach((p, idx) => { const dx = (p % W) - (prev % W), dy = ((p / W) | 0) - ((prev / W) | 0); if (dx !== pdx || dy !== pdy) { if (idx > 0) out.push(prev); pdx = dx; pdy = dy; } prev = p; });
    out.push(goal);
    return out.map(p => ({ x: (p % W) * T + 4, y: ((p / W) | 0) * T + 7 }));
  }
  function nearestWalk(x, y) { const { W, H, walk } = world; for (let r = 1; r < 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && walk[ny * W + nx]) return [nx, ny]; } return null; }
  function roomRect(id) {
    const r = plan.rooms.find(x => x.id === id); if (!r) return null;
    if (r.kind === 'zone') { const op = plan.rooms.find(x => x.id === r.zoneOf); return { x0: r.x + 1, x1: r.x + r.w - 2, y0: op.y + WH + 9, y1: op.y + op.h - 3 }; }
    return { x0: r.x + 2, x1: r.x + r.w - 3, y0: r.y + WH + 1, y1: r.y + r.h - 3 };
  }
  function randomSpot(id, seed) {
    const rc = roomRect(id); if (!rc) return null;
    const rg = seed != null ? rng(seed) : Math.random;
    for (let i = 0; i < 80; i++) { const x = rc.x0 + Math.floor(rg() * (rc.x1 - rc.x0 + 1)), y = rc.y0 + Math.floor(rg() * (rc.y1 - rc.y0 + 1)); if (world.walk[y * world.W + x] && !world.seat.has(y * world.W + x)) return { tx: x, ty: y }; }
    return { tx: Math.floor((rc.x0 + rc.x1) / 2), ty: rc.y1 };
  }
  function serverDoor() {
    const sv = world.rooms.find(r => r.kind === 'server'); if (!sv) return null;
    const d = sv.doors.find(x => x.s === 't') || sv.doors[0];
    return d.s === 't' ? { tx: sv.x + d.at + 1, ty: sv.y - 1 } : d.s === 'b' ? { tx: sv.x + d.at + 1, ty: sv.y + sv.h } : { tx: sv.x + 2, ty: sv.y + WH + 2 };
  }

  /* ---------- entities from sessions ---------- */
  const SERVERISH = /\b(ssh|rsync|scp|deploy|git push|kubectl|docker push|sftp)\b/;
  const TESTISH = /\b(test|tests|pytest|phpunit|vitest|jest|analyze|lint|go vet|gradlew\b.*test|cargo test)\b/;
  function roleOf(s) { return s.role ? roles.find(r => r.id === s.role) : null; }
  function lookOf(s) { const r = roleOf(s); return r || guestLook(s.sid); }
  function nameOf(s) { const r = roleOf(s); if (r) return r.name + (s.slot ? ` #${s.slot + 1}` : ''); return s.kind === 'rapat' ? 'Rapat' : short(s.title || 'Sesi manual', 14); }
  function homeDesk(s) {
    const r = roleOf(s);
    if (r && !s.slot && s.kind !== 'rapat') { const d = world.desks.find(d => d.role === r.id); if (d && (!d.occ || d.occ === s.sid)) return d; }
    const roomId = s.room;
    const mine = world.desks.find(d => d.occ === s.sid);
    if (mine) return mine;
    const free = world.desks.find(d => !d.occ && (d.spare || (!d.role)) && (d.zone ? d.zone === roomId : d.room === roomId));
    return free || null;
  }
  function desiredPlace(e, s) {
    if (s.status === 'ended') return { key: 'leave', type: 'leave' };
    if (s.kind === 'rapat') return { key: 'meeting', type: 'spot', room: plan.rooms.some(r => r.id === 'meeting') ? 'meeting' : s.room, seed: hashStr(s.sid) };
    const tool = s.tool, label = tool ? `${tool.name} ${tool.label}` : '';
    if (s.waiting && SERVERISH.test(s.waiting.summary || '') && serverDoor()) return { key: 'srvdoor', type: 'door' };
    if (s.status === 'working' && tool && tool.name === 'Bash' && SERVERISH.test(tool.label) && plan.rooms.some(r => r.kind === 'server')) return { key: 'server', type: 'spot', room: world.rooms.find(r => r.kind === 'server').id };
    if (s.status === 'working' && tool && tool.name === 'Bash' && TESTISH.test(tool.label) && plan.rooms.some(r => r.id === 'qa')) return { key: 'qa', type: 'spot', room: 'qa' };
    if (s.status === 'working' && tool && (tool.name === 'WebSearch' || tool.name === 'WebFetch') && plan.rooms.some(r => r.id === 'lib')) return { key: 'lib', type: 'spot', room: 'lib' };
    if (s.status === 'idle' && Date.now() - Date.parse(s.lastSeen) > 12 * 60e3 && plan.rooms.some(r => r.id === 'pantry')) return { key: 'pantry', type: 'spot', room: 'pantry', seed: hashStr(s.sid) };
    if (e.desk) return { key: 'desk', type: 'desk' };
    return { key: 'hot', type: 'spot', room: s.room, seed: hashStr(s.sid) };
  }
  function goPlace(e, pl) {
    e.q = []; e.cur = null; e.place = pl.key; e.placeAt = performance.now();
    e.goingTo = pl.type === 'desk' ? 'meja' : pl.type === 'leave' ? 'lift' : pl.type === 'door' ? 'Ruang Server' : (plan.rooms.find(r => r.id === pl.room)?.name || '');
    if (e.instant) { // first render after a page load: no walking in from the lift
      e.instant = false;
      const tgt = pl.type === 'desk' ? null : pl.type === 'door' ? serverDoor() : pl.type === 'spot' ? randomSpot(pl.room, pl.seed) : null;
      if (pl.type === 'desk') { e.x = e.desk.seat.x; e.y = e.desk.seat.y; e.mode = 'sit'; return; }
      if (tgt) { e.x = tgt.tx * T + 4; e.y = tgt.ty * T + 7; return; }
    }
    if (pl.type === 'desk') e.q.push({ t: 'go', tx: e.desk.seat.tx, ty: e.desk.seat.ty }, { t: 'sit' });
    else if (pl.type === 'door') { const d = serverDoor(); e.q.push({ t: 'go', tx: d.tx, ty: d.ty }); }
    else if (pl.type === 'leave') { e.q.push({ t: 'go', tx: world.elevator.tx, ty: world.elevator.ty }, { t: 'call', fn: () => { world.elevator.until = performance.now() + 1500; e.fade = true; } }); }
    else { const sp = randomSpot(pl.room, pl.seed); if (sp) e.q.push({ t: 'go', tx: sp.tx, ty: sp.ty }); }
  }
  const VERB = { Read: 'membaca', Edit: 'mengedit', Write: 'menulis', MultiEdit: 'mengedit', NotebookEdit: 'mengedit', Bash: 'menjalankan', Grep: 'mencari', Glob: 'mencari', WebSearch: 'riset', WebFetch: 'membaca web', Task: 'mendelegasikan', Agent: 'mendelegasikan', TodoWrite: 'menyusun todo', Compact: 'merapikan' };
  const verb = t => VERB[t.name] || t.name;
  function bubbleFor(s) {
    if (s.waiting) return { text: `menunggu izin: ${s.waiting.summary || s.waiting.tool}`.trim(), kind: 'wait' };
    if (s.compacting) return { text: '= merapikan konteks', kind: '' };
    if (s.status === 'starting') return { text: '> datang', kind: '' };
    if (s.kind === 'rapat' && s.status !== 'ended') return { text: '= sedang rapat', kind: 'sub' };
    if (s.status === 'working' && s.tool) return { text: `< ${verb(s.tool)} ${s.tool.label || ''}`.trim(), kind: '' };
    if (s.status === 'working') return { text: '= berpikir', kind: '' };
    if (s.status === 'idle' && s.subs?.some(x => x.status === 'working')) return { text: `= menunggu ${s.subs.length} subagent`, kind: 'sub' };
    return { text: '', kind: '' };
  }

  function spawnEnt(id, look, atElevator) {
    const el = world.elevator;
    const e = { id, look, x: el.tx * T + 4, y: el.ty * T + 7, path: [], q: [], cur: null, mode: 'stand', dir: 'down', bubble: '', bkind: '', t0: Math.random() * 10, alpha: 1, fade: false, desk: null, place: null };
    if (atElevator) el.until = performance.now() + 1800;
    ents.set(id, e);
    return e;
  }
  function sync(list) {
    sessions = list;
    const seen = new Set();
    world.desks.forEach(d => { if (!list.some(s => s.sid === d.occ && s.status !== 'ended')) d.occ = null; });
    for (const s of list) {
      seen.add(s.sid);
      let e = ents.get(s.sid);
      if (!e) { e = spawnEnt(s.sid, lookOf(s), !!opts.animateArrivals); e.sid = s.sid; if (!opts.animateArrivals && s.status !== 'starting') e.instant = true; }
      e.look = lookOf(s); e.name = nameOf(s); e.mgr = !!roleOf(s)?.isMgr; e.manual = !s.role; e.s = s;
      if (!e.desk || e.desk.occ !== s.sid) { const d = homeDesk(s); if (d) { d.occ = s.sid; e.desk = d; } else e.desk = null; }
      // a session first seen already working sits down immediately (page reload)
      const b = bubbleFor(s); e.bubble = b.text; e.bkind = b.kind;
      const pl = desiredPlace(e, s);
      const dwell = performance.now() - (e.placeAt || 0);
      if (pl.key !== e.place && (dwell > 3500 || e.place === 'desk' || e.place == null || pl.key === 'leave' || pl.key === 'srvdoor')) goPlace(e, pl);
      // subagents
      for (const sub of s.subs || []) {
        const id = `${s.sid}:${sub.id}`;
        seen.add(id);
        let se = ents.get(id);
        if (!se) {
          se = spawnEnt(id, { ...guestLook(id), color: '#E8E2D0' }, true);
          se.sub = sub; se.parent = s.sid; se.cap = e.look.color;
          const t = (sub.type || '').toLowerCase();
          const room = /explore|research|search/.test(t) ? 'lib' : /plan/.test(t) ? 'meeting' : /review|qa|test/.test(t) ? (plan.rooms.some(r => r.id === 'qa') ? 'qa' : 'meeting') : null;
          if (room && plan.rooms.some(r => r.id === room)) { const sp = randomSpot(room); se.q.push({ t: 'go', tx: sp.tx, ty: sp.ty }); }
          else if (e.desk) { const k = (s.subs.indexOf(sub) % 3) - 1; se.q.push({ t: 'go', tx: e.desk.front.tx + 2 + k * 2, ty: e.desk.front.ty + 1 }); }
          else { const sp = randomSpot(s.room); if (sp) se.q.push({ t: 'go', tx: sp.tx, ty: sp.ty }); }
        }
        se.sub = sub; se.name = sub.type; se.cap = e.look.color;
        se.bubble = sub.status === 'done' ? '> lapor ke induk' : sub.tool ? `< ${verb(sub.tool)} ${sub.tool.label || ''}` : `= ${short(sub.desc || 'bekerja', 30)}`;
        se.bkind = sub.status === 'done' ? 'report' : 'sub';
        if (sub.status === 'done' && !se.reported) {
          se.reported = true; se.q = []; se.cur = null;
          const front = e.desk ? e.desk.front : { tx: Math.floor(e.x / T), ty: Math.floor(e.y / T) + 2 };
          se.q.push({ t: 'go', tx: front.tx + 1, ty: front.ty }, { t: 'wait', ms: 2600 }, { t: 'go', tx: world.elevator.tx, ty: world.elevator.ty }, { t: 'call', fn: () => { world.elevator.until = performance.now() + 1500; se.fade = true; } });
        }
      }
    }
    for (const [id, e] of ents) {
      if (seen.has(id) || e.fade) continue;
      if (!e.leaving) { e.leaving = true; e.q = []; e.cur = null; e.bubble = e.sub ? '' : 'Pulang'; e.q.push({ t: 'go', tx: world.elevator.tx, ty: world.elevator.ty }, { t: 'call', fn: () => { world.elevator.until = performance.now() + 1500; e.fade = true; } }); }
    }
  }
  function step(e, dt) {
    if (!e.cur && e.q.length) {
      e.cur = e.q.shift(); e.cur.started = performance.now();
      if (e.cur.t === 'go') { e.mode = 'stand'; e.path = findPath(Math.floor(e.x / T), Math.floor(e.y / T), e.cur.tx, e.cur.ty) || []; }
    }
    const c = e.cur; if (!c) return;
    if (c.t === 'go') {
      if (!e.path.length) { e.cur = null; return; }
      const tgt = e.path[0], dx = tgt.x - e.x, dy = tgt.y - e.y, dist = Math.hypot(dx, dy), sp = 56 * dt;
      if (dist <= sp) { e.x = tgt.x; e.y = tgt.y; e.path.shift(); } else { e.x += dx / dist * sp; e.y += dy / dist * sp; }
      e.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      e.mode = 'walk';
      if (!e.path.length) { e.mode = 'stand'; e.dir = 'down'; e.cur = null; }
    } else if (c.t === 'sit') { if (e.desk) { e.x = e.desk.seat.x; e.y = e.desk.seat.y; e.mode = 'sit'; e.dir = 'down'; } e.cur = null; }
    else if (c.t === 'wait') { if (performance.now() - c.started >= c.ms) e.cur = null; }
    else if (c.t === 'call') { e.cur = null; c.fn(); }
  }

  /* ---------- camera + input ---------- */
  function fitCanvas() { const r = host.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); canvas._dpr = dpr; canvas._w = r.width; canvas._h = r.height; }
  // the visible area excludes floating panels (insets, in screen px)
  const visW = () => Math.max(80, canvas._w - ins.left - ins.right), visH = () => Math.max(80, canvas._h - ins.top - ins.bottom);
  function clamp(c) {
    const vw = visW() / c.tz, vh = visH() / c.tz, W = world.W * T, H = world.H * T, ox = ins.left / c.tz, oy = ins.top / c.tz;
    c.tx = vw >= W ? (W - vw) / 2 - ox : Math.max(-ox - 40 / c.tz, Math.min(W - vw - ox + 40 / c.tz, c.tx));
    c.ty = vh >= H ? (H - vh) / 2 - oy : Math.max(-oy - 40 / c.tz, Math.min(H - vh - oy + 40 / c.tz, c.ty));
  }
  function fitAll(instant) { cam.tz = Math.min(visW() / (world.W * T), visH() / (world.H * T)); cam.tx = 0; cam.ty = 0; clamp(cam); focus = null; if (instant) Object.assign(cam, { x: cam.tx, y: cam.ty, z: cam.tz }); }
  function focusRoom(id, instant) {
    const r = plan.rooms.find(x => x.id === id); if (!r) return;
    let { x, y, w, h } = r;
    if (r.kind === 'zone') { const op = plan.rooms.find(q => q.id === r.zoneOf); y = op.y; h = op.h; }
    const z = Math.min(visW() / ((w + 4) * T), visH() / ((h + 4) * T), 3.2);
    cam.tz = z; cam.tx = (x + w / 2) * T - (ins.left + visW() / 2) / z; cam.ty = (y + h / 2) * T - (ins.top + visH() / 2) / z; clamp(cam);
    focus = id; sel = id; if (instant) Object.assign(cam, { x: cam.tx, y: cam.ty, z: cam.tz });
  }
  function zoomBy(f, sx = canvas._w / 2, sy = canvas._h / 2) { const wx = cam.tx + sx / cam.tz, wy = cam.ty + sy / cam.tz; cam.tz = Math.max(.4, Math.min(6, cam.tz * f)); cam.tx = wx - sx / cam.tz; cam.ty = wy - sy / cam.tz; clamp(cam); focus = null; }
  const hitAt = (sx, sy) => { const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z; for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (wx >= h.x0 && wx <= h.x1 && wy >= h.y0 && wy <= h.y1) return h; } return null; };
  function roomAt(sx, sy) {
    const wx = Math.floor((cam.x + sx / cam.z) / T), wy = Math.floor((cam.y + sy / cam.z) / T);
    const z = plan.rooms.find(r => r.kind === 'zone' && wx >= r.x && wx < r.x + r.w && plan.rooms.find(q => q.id === r.zoneOf && wy >= q.y && wy < q.y + q.h));
    if (z) return z.id;
    const r = world.rooms.find(r => wx >= r.x && wx < r.x + r.w && wy >= r.y && wy < r.y + r.h); return r ? r.id : null;
  }
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    if (down) { const dx = e.clientX - down.x, dy = e.clientY - down.y; if (Math.abs(dx) + Math.abs(dy) > 4) { down.moved = true; canvas.classList.add('grabbing'); } if (down.moved) { cam.tx = down.cx - dx / cam.z; cam.ty = down.cy - dy / cam.z; clamp(cam); cam.x = cam.tx; cam.y = cam.ty; focus = null; } return; }
    canvas.classList.toggle('hot', !!hitAt(e.clientX - r.left, e.clientY - r.top));
  });
  canvas.addEventListener('pointerup', e => {
    canvas.classList.remove('grabbing');
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (down && !down.moved) {
      const h = hitAt(sx, sy);
      if (h) onPick(h.sid, h.sub || null, h.role || null);
      else { const rm = roomAt(sx, sy); if (rm) { sel = rm; onRoom(rm); if (focus !== rm && cam.z < 2.2) focusRoom(rm); } }
    }
    down = null;
  });
  canvas.addEventListener('dblclick', e => { const r = canvas.getBoundingClientRect(); const rm = roomAt(e.clientX - r.left, e.clientY - r.top); if (rm) focusRoom(rm); });
  canvas.addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const ro = new ResizeObserver(() => { fitCanvas(); if (focus) focusRoom(focus, true); else clamp(cam); });
  ro.observe(host);

  /* ---------- render ---------- */
  const night = () => darkMQ.matches;
  const fadeTimer = setInterval(() => { for (const [id, e] of ents) if (e.fade) { e.alpha -= .25; if (e.alpha <= 0) ents.delete(id); } }, 120);
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!document.body.contains(canvas)) { destroy(); return; }
    const dt = Math.min(.05, (t - lastT) / 1000); lastT = t;
    const k = 1 - Math.pow(.0008, dt);
    cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k;
    for (const e of ents.values()) step(e, dt);
    world.elevator.open += ((performance.now() < world.elevator.until ? 1 : 0) - world.elevator.open) * Math.min(1, dt * 6);
    if (Date.now() - world.bgAt > 120000) buildBg();
    draw(t / 1000);
  }
  function draw(time) {
    const c = ctx, dpr = canvas._dpr, z = cam.z;
    c.setTransform(1, 0, 0, 1, 0, 0); c.imageSmoothingEnabled = false;
    c.fillStyle = P.out; c.fillRect(0, 0, canvas.width, canvas.height);
    c.setTransform(z * dpr, 0, 0, z * dpr, -cam.x * z * dpr, -cam.y * z * dpr);
    c.drawImage(world.bg, 0, 0);
    const emis = [];
    for (const k of world.clocks) { const d = new Date(), a = (d.getMinutes() / 60) * Math.PI * 2, b = ((d.getHours() % 12) / 12 + d.getMinutes() / 720) * Math.PI * 2; line(c, k.x, k.y, k.x + Math.round(Math.sin(a) * 5), k.y - Math.round(Math.cos(a) * 5), '#2B303A'); line(c, k.x, k.y, k.x + Math.round(Math.sin(b) * 3), k.y - Math.round(Math.cos(b) * 3), '#C2413A'); }
    for (const v of world.tvs) { const meet = sessions.some(s => s.kind === 'rapat'); for (let i = 0; i < 4; i++) { const w = 6 + ((i * 7 + Math.floor(time * 2)) % 20); emis.push([v.x + 3, v.y + 3 + i * 4, Math.min(w, v.w - 6), 2, meet ? P.code[i % 4] : '#2B3A4A']); } }
    for (const p of world.phones) for (let i = 0; i < p.n; i++) emis.push([p.x + 4 + i * 9, p.y + 1, 4, 7, (Math.floor(time * 1.5) + i) % 3 ? '#7FD3C9' : '#2A4A5C']);
    world.leds.forEach((l, i) => { for (let y = 4; y < 42; y += 4) emis.push([l.x + 3 + ((y + i) % 3) * 3, l.y + y, 1, 1, ((Math.floor(time * 4) + y + i * 3) % 5) ? '#5CC28A' : '#E3A33A']); });
    drawElevator(c, world.elevator, emis);
    const sv = world.rooms.find(r => r.kind === 'server');
    if (sv) { const d = sv.doors[0]; const busy = sessions.some(s => s.tool?.name === 'Bash' && SERVERISH.test(s.tool.label)); const wait = sessions.some(s => s.waiting && SERVERISH.test(s.waiting.summary || '')); const col = busy ? '#5CC28A' : wait ? '#E3A33A' : '#E5655D'; if (d.s === 't') { R(c, (sv.x + d.at) * T, sv.y * T + WH * T - 3, d.w * T, 3, col); emis.push([(sv.x + d.at) * T, sv.y * T + WH * T - 3, d.w * T, 3, col]); } }
    const list = [];
    for (const it of world.items) list.push({ y: it.sortY, f: () => c.drawImage(it.img, it.x, it.y) });
    hits = [];
    for (const d of world.desks) list.push({ y: (d.ty + 2) * T + 1, f: () => drawDesk(c, d, time, emis) });
    for (const e of ents.values()) if (e.sub && e.alpha > 0) { const p = ents.get(e.parent); if (p) { c.globalAlpha = .55 * e.alpha; dash(c, e.x, e.y - 10, p.x, p.y - 12, e.cap); c.globalAlpha = 1; } }
    for (const e of ents.values()) { if (e.mode === 'sit') continue; list.push({ y: e.y, f: () => drawEnt(c, e, time) }); }
    list.sort((a, b) => a.y - b.y).forEach(i => i.f());
    if (night()) { c.fillStyle = 'rgba(14,10,24,.22)'; c.fillRect(cam.x - 2, cam.y - 2, canvas._w / z + 4, canvas._h / z + 4); }
    for (const [x, y, w, h, col] of emis) R(c, x, y, w, h, col);
    for (const l of world.lamps || []) {
      const g = c.createRadialGradient(l.x, l.y, 1, l.x, l.y, 26), col = l.warm ? '255,190,110' : '255,108,80';
      g.addColorStop(0, `rgba(${col},.32)`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.fillRect(l.x - 26, l.y - 26, 52, 52);
      R(c, l.x - 3, l.y - 2, 6, 5, P.ol); R(c, l.x - 2, l.y - 1, 4, 3, l.warm ? '#FFC46E' : '#FF6C50'); R(c, l.x - 1, l.y - 1, 1, 1, '#FFE2C8');
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabels(c, time);
  }
  function dash(c, x0, y0, x1, y1, col) { const d = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(d / 4); for (let i = 0; i < n; i += 2) { const a = i / n; R(c, Math.round(x0 + (x1 - x0) * a), Math.round(y0 + (y1 - y0) * a), 1, 1, col); } }
  function drawElevator(c, el, emis) {
    const x = el.x, y = el.y + 4, h = WH * T - 7, o = el.open;
    R(c, x, y, 32, h, '#1E2129');
    const dw = Math.round(16 * (1 - o * .9));
    R(c, x, y, dw, h, '#AEB5BF'); R(c, x + 32 - dw, y, dw, h, '#AEB5BF'); R(c, x + dw - 1, y, 1, h, '#7A808A'); R(c, x + 32 - dw, y, 1, h, '#7A808A');
    emis.push([x + 14, y - 4, 4, 2, o > .3 ? '#5CC28A' : '#E3A33A']);
  }
  function drawDesk(c, d, time, emis) {
    const x = d.tx * T, y = d.ty * T, w = d.w * T;
    const e = d.occ ? ents.get(d.occ) : null;
    const sitting = e && e.mode === 'sit' && e.desk === d;
    const s = e?.s, on = !!(s && s.status !== 'ended'), busy = on && s.status === 'working';
    const stool = (sx, sy) => { R(c, sx - 5, sy - 4, 10, 7, P.ol); R(c, sx - 4, sy - 3, 8, 5, P.chair); R(c, sx - 4, sy - 3, 8, 1, P.chairHi); R(c, sx - 3, sy + 3, 1, 2, P.ol); R(c, sx + 2, sy + 3, 1, 2, P.ol); };
    if (d.facing === 'down') { // manager: chair + person behind the desk
      R(c, x + 18, y - 15, 20, 14, P.ol); R(c, x + 19, y - 14, 18, 12, '#5A4A6E'); R(c, x + 19, y - 14, 18, 2, '#6E5C86');
      if (sitting) { glow(c, d.seat.x, y - 8, e.look.color, busy); drawPerson(c, d.seat.x, y + 2, e.look, { sit: true, t: time + e.t0, typing: busy, blink: blink(time + e.t0), dir: 'down' }); hits.push({ x0: d.seat.x - 8, y0: y - 22, x1: d.seat.x + 8, y1: y + 2, sid: e.sid }); }
    }
    // desk top (seen from above) with a dark outline
    R(c, x - 1, y - 1, w + 2, 2 * T + 2, P.ol);
    R(c, x, y, w, 2 * T - 3, P.deskTop); R(c, x, y, w, 1, P.deskHi); R(c, x, y + 2 * T - 3, w, 3, P.deskFront);
    for (let k = 6; k < w - 2; k += 9) R(c, x + k, y + 2, 1, 2 * T - 6, P.deskDark);
    // monitor at the back edge, screen facing us
    const mx = x + Math.round(w / 2) - 7, my = y - 9;
    R(c, mx - 1, my - 1, 16, 12, P.ol); R(c, mx, my, 14, 10, P.mon);
    R(c, mx + 1, my + 1, 12, 7, on ? P.scrOn : P.scrOff);
    R(c, mx + 6, my + 10, 2, 2, P.ol); R(c, mx + 4, my + 12, 6, 1, P.ol);
    if (busy) for (let i = 0; i < 3; i++) { const ww = 3 + ((i * 5 + Math.floor(time * 3 + d.tx)) % 7); emis.push([mx + 2, my + 2 + i * 2, Math.min(ww, 10), 1, P.code[(i + d.tx) % 4]]); }
    else if (on) emis.push([mx + 1, my + 1, 12, 7, P.scrOn]);
    // keyboard, mug, small desk item
    R(c, mx + 1, y + 5, 12, 3, P.ol); R(c, mx + 2, y + 5, 10, 2, '#C9CDD4');
    R(c, x + w - 7, y + 3, 4, 4, P.ol); R(c, x + w - 6, y + 4, 2, 2, d.mug);
    if (d.item === 'lamp') { R(c, x + 3, y + 2, 3, 3, P.ol); R(c, x + 4, y + 3, 1, 1, '#F2CF72'); }
    if (d.item === 'plant') { R(c, x + 2, y + 2, 5, 5, P.ol); R(c, x + 3, y + 3, 3, 3, '#58A867'); }
    if (d.item === 'duck') { R(c, x + 3, y + 3, 3, 3, '#F2CF72'); }
    if (d.item === 'pen') { R(c, x + 3, y + 3, 2, 3, '#4F79B8'); }
    if (s?.worktree) { R(c, x + w - 3, y - 10, 1, 10, P.ol); R(c, x + w - 2, y - 10, 5, 4, '#F59A3C'); }
    d.plate = null;
    if (d.facing !== 'down') {
      const sx = d.seat.x, sy = d.seat.y;
      stool(sx, sy - 2);
      if (sitting) { glow(c, sx, sy - 8, e.look.color, busy); drawPerson(c, sx, sy, e.look, { sit: true, t: time + e.t0, typing: busy, blink: blink(time + e.t0), dir: 'up' }); hits.push({ x0: sx - 8, y0: sy - 22, x1: sx + 8, y1: sy + 2, sid: e.sid }); }
    }
    if (!sitting && d.role) hits.push({ x0: x, y0: y - 12, x1: x + w, y1: y + 2 * T, role: d.role });
  }
  function glow(c, x, y, color, strong) {
    const g = c.createRadialGradient(x, y, 1, x, y, 15);
    g.addColorStop(0, hexA(color, strong ? .5 : .25)); g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g; c.fillRect(x - 15, y - 15, 30, 30);
  }
  const hexA = (hex, a) => { const n = parseInt(String(hex).slice(1, 7), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  const blink = t => (t % 4.2) < .14;
  /* chibi person, drawn around (x = centre, y = feet). Pass 1 paints the outline. */
  function drawPerson(c, x, y, p, o) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) personShape(c, x + dx, y + dy, p, o, P.ol);
    personShape(c, x, y, p, o, null);
  }
  function personShape(c, x, y, p, o, ol) {
    const f = col => ol || col;
    const bob = o.walk && Math.floor(o.t * 8) % 2 ? 1 : 0;
    const legs = o.sit ? 0 : (o.small ? 3 : 4);
    const bodyH = o.small ? 5 : 6;
    const top = y - legs - bodyH - 10 - bob;
    const back = o.dir === 'up';
    // head 10x10, hair
    if (p.hairStyle === 'long' && !back) R(c, x - 6, top + 2, 12, 9, f(p.hair));
    R(c, x - 5, top, 10, 10, f(p.skin));
    if (back) { R(c, x - 5, top, 10, 8, f(p.hair)); if (p.hairStyle === 'long') R(c, x - 5, top + 8, 10, 3, f(p.hair)); }
    else { R(c, x - 5, top, 10, 3, f(p.hair)); R(c, x - 5, top + 3, 2, 3, f(p.hair)); R(c, x + 3, top + 3, 2, 2, f(p.hair)); }
    if (p.hairStyle === 'bun') R(c, x - 2, top - 3, 4, 3, f(p.hair));
    if (o.cap) { R(c, x - 6, top - 1, 12, 4, f(o.cap)); if (!back) R(c, x - 6, top + 3, 12, 1, f(o.cap)); }
    if (!ol && !back && !o.blink) { const ox = o.dir === 'left' ? -1 : o.dir === 'right' ? 1 : 0; R(c, x - 3 + ox, top + 5, 2, 2, '#1F1628'); R(c, x + 1 + ox, top + 5, 2, 2, '#1F1628'); R(c, x - 4 + ox, top + 7, 1, 1, '#E89A8A'); R(c, x + 3 + ox, top + 7, 1, 1, '#E89A8A'); }
    // body
    const tb = top + 10;
    R(c, x - 5, tb, 10, bodyH, f(p.color));
    if (!ol) { R(c, x - 5, tb + bodyH - 1, 10, 1, 'rgba(0,0,0,.2)'); if (!back) { R(c, x - 1, tb, 2, 1, p.skin); if (p.tie) R(c, x - 1, tb + 1, 2, bodyH - 1, '#C2413A'); } }
    if (o.lanyard && !ol && !back) { R(c, x - 2, tb, 1, 2, o.lanyard); R(c, x + 1, tb, 1, 2, o.lanyard); R(c, x - 2, tb + 2, 4, 2, '#F4F4F4'); }
    // arms
    const a = o.typing ? Math.floor(o.t * 9) % 2 : 0;
    if (o.sit) { R(c, x - 7, tb + 1 - a, 2, 4, f(p.color)); R(c, x + 5, tb + a, 2, 4, f(p.color)); if (!ol) { R(c, x - 7, tb + 4 - a, 2, 1, p.skin); R(c, x + 5, tb + 3 + a, 2, 1, p.skin); } }
    else {
      const ph = o.walk ? Math.floor(o.t * 8) % 2 : -1;
      R(c, x - 7, tb + 1 + (ph === 0 ? 1 : 0), 2, 4, f(p.color)); R(c, x + 5, tb + 1 + (ph === 1 ? 1 : 0), 2, 4, f(p.color));
      if (!ol) { R(c, x - 7, tb + 5 + (ph === 0 ? 1 : 0), 2, 1, p.skin); R(c, x + 5, tb + 5 + (ph === 1 ? 1 : 0), 2, 1, p.skin); }
      const lb = tb + bodyH, l1 = ph === 1 ? legs - 1 : legs, l2 = ph === 0 ? legs - 1 : legs;
      R(c, x - 4, lb, 3, l1, f('#2B3242')); R(c, x + 1, lb, 3, l2, f('#2B3242'));
      R(c, x - 4, lb + l1 - 1, 3, 1, f('#15181E')); R(c, x + 1, lb + l2 - 1, 3, 1, f('#15181E'));
    }
  }
  function drawEnt(c, e, time) {
    c.globalAlpha = Math.max(0, e.alpha);
    R(c, e.x - 6, e.y - 1, 12, 3, 'rgba(0,0,0,.22)');
    if (e.s?.status === 'working' || e.sub) glow(c, e.x, e.y - 10, e.sub ? e.cap : e.look.color, false);
    drawPerson(c, Math.round(e.x), Math.round(e.y), e.look, { walk: e.mode === 'walk', t: time + e.t0, dir: e.dir, blink: blink(time + e.t0), small: !!e.sub, lanyard: e.sub ? e.cap : null, cap: e.sub ? e.cap : null });
    c.globalAlpha = 1;
    hits.push({ x0: e.x - 8, y0: e.y - 24, x1: e.x + 8, y1: e.y + 2, sid: e.sub ? e.parent : e.sid, sub: e.sub ? e.sub.id : null });
  }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  const PIX = '"Silkscreen", "Pixelify Sans", ui-monospace, monospace';
  const MONO = '"JetBrains Mono", ui-monospace, monospace';
  function drawLabels(c, time) {
    const z = cam.z, Sx = (wx, wy) => [(wx - cam.x) * z, (wy - cam.y) * z];
    c.textBaseline = 'middle';
    for (const r of plan.rooms) {
      if (r.kind === 'openplan') continue;
      let wx, wy;
      if (r.kind === 'zone') { const op = plan.rooms.find(q => q.id === r.zoneOf); wx = (r.x + 1) * T; wy = (op.y + WH) * T + 2; } else { wx = r.x * T + 10; wy = r.y * T + 8; }
      const [sx, sy] = Sx(wx, wy); if (sx > canvas._w || sy > canvas._h || sx < -220 || sy < -40) continue;
      const fs = z < 1.2 ? 8 : 10;
      c.font = `700 ${fs}px ${PIX}`;
      const name = r.name.toUpperCase(), sub = z >= 1.6 && r.path ? r.path + '/' : '';
      const w1 = c.measureText(name).width;
      c.font = `500 ${fs}px ${MONO}`;
      const w2 = sub ? c.measureText(sub).width + 8 : 0;
      c.fillStyle = sel === r.id ? 'rgba(245,154,60,.95)' : r.kind === 'server' ? 'rgba(150,40,40,.88)' : 'rgba(31,22,40,.78)';
      rr(c, sx, sy, w1 + w2 + 12, fs + 8, 4); c.fill();
      c.fillStyle = sel === r.id ? '#3A240F' : '#FBF4EA'; c.font = `700 ${fs}px ${PIX}`; c.fillText(name, sx + 6, sy + (fs + 8) / 2 + .5);
      if (sub) { c.fillStyle = sel === r.id ? '#3A240F' : '#B8AEBF'; c.font = `500 ${fs}px ${MONO}`; c.fillText(sub, sx + 6 + w1 + 8, sy + (fs + 8) / 2 + .5); }
    }
    if (z >= .7) for (const wg of plan.wings || []) { const [sx, sy] = Sx(wg.x * T, wg.y * T); c.font = `700 ${z < 1.4 ? 8 : 10}px ${PIX}`; c.fillStyle = 'rgba(251,244,234,.7)'; c.fillText(wg.t.toUpperCase(), sx, sy); }
    for (const e of ents.values()) {
      if (e.alpha <= 0) continue;
      const sit = e.mode === 'sit' && e.desk;
      const fx = sit ? e.desk.seat.x : e.x, fy = sit ? (e.desk.facing === 'down' ? e.desk.ty * T + 2 * T + 2 : e.desk.seat.y + 2) : e.y + 2;
      const headY = sit ? (e.desk.facing === 'down' ? e.desk.ty * T - 20 : e.desk.seat.y - 24) : e.y - 26;
      const [sx, sy] = Sx(fx, fy), [, hy] = Sx(fx, headY);
      if (sx < -150 || sx > canvas._w + 150 || sy < -80 || sy > canvas._h + 60) continue;
      if (z >= 1.2) { // name tag under the feet
        const fs = e.sub ? 8 : 10;
        c.font = `700 ${fs}px ${PIX}`; c.textAlign = 'center';
        const label = e.name || '', tw = c.measureText(label).width;
        c.fillStyle = e.mgr ? 'rgba(245,154,60,.97)' : 'rgba(31,22,40,.9)';
        rr(c, sx - tw / 2 - 5, sy + 1, tw + 10, fs + 6, 3); c.fill();
        c.fillStyle = e.mgr ? '#3A240F' : e.sub ? '#CDEDEA' : e.manual ? '#BFE5E8' : '#FBF4EA';
        c.fillText(label, sx, sy + 1 + (fs + 6) / 2 + .5); c.textAlign = 'left';
      }
      const text = e.mode === 'walk' && e.goingTo && !e.sub ? `> menuju ${e.goingTo}` : e.bubble;
      if (!text) continue;
      const wait = e.bkind === 'wait';
      if (z < 1.2) { c.fillStyle = wait ? '#F59A3C' : '#FDFCF2'; c.beginPath(); c.arc(sx, hy, 3.5, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#1F1628'; c.lineWidth = 1.2; c.stroke(); continue; }
      c.font = `500 11px ${MONO}`;
      const txt = short(text, 34), tw = c.measureText(txt).width, bw = tw + 14, bh = 19, bx = Math.round(sx - bw / 2), by = Math.round(hy - 10 - bh);
      c.fillStyle = wait ? '#F59A3C' : e.bkind === 'sub' ? '#E8F4F2' : '#FDFCF2'; c.strokeStyle = '#1F1628'; c.lineWidth = 1.5;
      rr(c, bx, by, bw, bh, 5); c.fill(); c.stroke();
      // thought-dot tail like a pixel speech bubble
      c.beginPath(); c.arc(sx - 1, by + bh + 4, 2.2, 0, Math.PI * 2); c.fill(); c.stroke();
      c.beginPath(); c.arc(sx - 4, by + bh + 8, 1.4, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = wait ? '#2A1A08' : '#1F1628'; c.fillText(txt, bx + 7, by + bh / 2 + .5);
    }
  }

  function destroy() { cancelAnimationFrame(raf); clearInterval(fadeTimer); ro.disconnect(); }

  const fitHost = () => { if (opts.fill) return; host.style.height = 'auto'; host.style.aspectRatio = `${plan.w} / ${plan.h}`; host.style.maxHeight = '82vh'; };
  fitHost();
  build(); fitCanvas(); fitAll(true);
  sync(opts.sessions || []);
  opts.animateArrivals = true;
  raf = requestAnimationFrame(frame);
  return {
    sync,
    setCards(c) { cards = c; if (world) buildBg(); },
    rebuild(p, r) { plan = p; roles = r; fitHost(); const keep = sessions; ents.clear(); build(); fitCanvas(); if (focus) focusRoom(focus, true); else fitAll(true); opts.animateArrivals = false; sync(keep); opts.animateArrivals = true; },
    focusRoom, fitAll: () => fitAll(), zoomBy,
    setInsets(v) { ins = { ...ins, ...v }; if (focus) focusRoom(focus); else fitAll(); }, get focus() { return focus; }, select(id) { sel = id; },
    destroy,
  };
}
