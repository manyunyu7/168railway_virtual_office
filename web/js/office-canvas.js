// Pixel office renderer driven by live session state.
import { short, hashStr, guestLook } from './util.js';
import { loadCatalog, getCatalog, createEngine, prayPhase } from './furniture.js';
import { attachOwner } from './owner.js';
import { createMinions } from './minions.js';

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
  metal: ['#5A616E', '#555B68', '#4A505C'], plum: ['#9B8CAE', '#9687A9', '#887A9C', '#7E7092'], frozen: ['#BFC1C6', '#B8BABF'],
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
const spr = (name, w, h, fn) => SP[name] ||= Object.assign(outlined(w, h, fn), { _k: name });   // _k: which sprite (the owner can use some built-ins)
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
  speaker: () => spr('speaker', 16, 26, c => { R(c, 0, 0, 16, 26, '#2A2D35'); R(c, 1, 1, 14, 24, '#3A3E48'); R(c, 1, 1, 14, 1, '#555B68'); disc(c, 8, 6, 2, '#555B68'); disc(c, 8, 6, 1, '#1B1E25'); disc(c, 8, 17, 6, '#555B68'); disc(c, 8, 17, 5, '#1B1E25'); R(c, 2, 24, 12, 1, '#2A2D35'); }),
  piano: () => spr('piano', 48, 24, c => {
    R(c, 0, 0, 48, 5, '#6B4535'); R(c, 0, 0, 48, 1, '#8A5C45'); R(c, 1, 5, 46, 8, '#4B2F26'); R(c, 17, 6, 14, 6, '#F4F0E4'); for (let k = 0; k < 3; k++) R(c, 19, 7 + k * 2, 10, 1, '#9AA0A8'); R(c, 4, 7, 3, 3, '#E2B04A'); R(c, 41, 7, 3, 3, '#E2B04A');
    R(c, 2, 13, 44, 6, '#F4F4EE'); for (let k = 0; k < 11; k++) { R(c, 2 + k * 4, 13, 1, 6, '#BDBDB5'); if ([0, 1, 3, 4, 5].includes(k % 7)) R(c, 2 + k * 4 + 3, 13, 2, 4, '#1B1B22'); }
    R(c, 0, 19, 48, 3, '#4B2F26'); R(c, 2, 22, 3, 2, '#3A2A22'); R(c, 43, 22, 3, 2, '#3A2A22'); R(c, 22, 22, 4, 2, '#E2B04A');
  }),
  bench: () => spr('pbench', 16, 8, c => { R(c, 0, 0, 16, 5, '#6B4535'); R(c, 1, 1, 14, 3, '#8A2F3A'); R(c, 1, 1, 14, 1, '#A9434F'); R(c, 1, 5, 2, 3, '#3A2A22'); R(c, 13, 5, 2, 3, '#3A2A22'); }),
  drums: () => spr('drums', 40, 30, c => {
    R(c, 4, 7, 1, 16, '#8A8A92'); R(c, 35, 6, 1, 17, '#8A8A92'); R(c, 0, 5, 10, 2, '#E3B94A'); R(c, 0, 5, 10, 1, '#F5D878'); R(c, 30, 4, 10, 2, '#E3B94A'); R(c, 30, 4, 10, 1, '#F5D878');
    disc(c, 14, 10, 4, '#E8E4DA'); disc(c, 14, 10, 3, '#3E6BA8'); disc(c, 26, 10, 4, '#E8E4DA'); disc(c, 26, 10, 3, '#3E6BA8');
    disc(c, 20, 21, 9, '#E8E4DA'); disc(c, 20, 21, 7, '#B93838'); disc(c, 20, 21, 2, '#F2CF72'); R(c, 11, 28, 2, 2, '#6B6B72'); R(c, 27, 28, 2, 2, '#6B6B72');
    R(c, 3, 20, 9, 5, '#D8D2C2'); R(c, 3, 20, 9, 2, '#FFFFFF'); R(c, 4, 25, 1, 3, '#8A8A92'); R(c, 10, 25, 1, 3, '#8A8A92');
    disc(c, 34, 24, 3, '#2A2F3A'); disc(c, 34, 24, 2, '#4A4F5C'); R(c, 34, 27, 1, 3, '#8A8A92');
  }),
  guitar: () => spr('guitar', 14, 28, c => {
    line(c, 7, 22, 2, 27, '#555B66'); line(c, 7, 22, 12, 27, '#555B66'); R(c, 6, 20, 2, 3, '#555B66');
    R(c, 6, 2, 2, 10, '#6B4535'); R(c, 5, 0, 4, 3, '#3A2A22'); R(c, 7, 2, 1, 10, '#D8D2C2');
    disc(c, 7, 12, 3, '#C98A3F'); disc(c, 7, 18, 5, '#C98A3F'); disc(c, 7, 18, 2, '#2A1F1A'); R(c, 4, 18, 1, 3, '#E2B06A'); R(c, 5, 22, 5, 1, '#6B4535');
  }),
  turntable: () => spr('turntable', 32, 22, c => {
    R(c, 0, 0, 32, 13, '#2A2D35'); R(c, 1, 1, 30, 11, '#1E2129'); R(c, 0, 0, 32, 1, '#555B68'); disc(c, 9, 6, 6, '#3A3E48'); R(c, 20, 8, 2, 2, '#E5655D'); R(c, 24, 9, 2, 2, '#7FD3C9'); R(c, 28, 9, 2, 2, '#F2CF72'); R(c, 27, 1, 3, 3, '#555B68');
    R(c, 0, 13, 32, 9, '#7A5532'); R(c, 0, 13, 32, 2, '#9C7046'); R(c, 2, 16, 13, 5, '#6A4828'); R(c, 17, 16, 13, 5, '#6A4828'); R(c, 7, 18, 3, 1, '#C9A15A'); R(c, 22, 18, 3, 1, '#C9A15A');
  }),
  note: i => spr('note' + i, 8, 10, c => { const col = ['#F2CF72', '#F49AC1', '#7FD3C9'][i % 3]; if (i % 2) { R(c, 0, 7, 3, 2, col); R(c, 4, 6, 3, 2, col); R(c, 2, 1, 1, 7, col); R(c, 6, 0, 1, 7, col); R(c, 2, 0, 5, 2, col); } else { R(c, 0, 7, 3, 2, col); R(c, 2, 1, 1, 7, col); R(c, 3, 1, 3, 1, col); R(c, 5, 2, 1, 3, col); } }),
  part: () => spr('part', 8, 64, c => { R(c, 1, 8, 6, 56, '#8E959F'); R(c, 1, 8, 6, 2, '#B3B9C2'); R(c, 0, 0, 8, 10, '#3E8E4E'); R(c, 2, 0, 4, 3, '#58A867'); }),
};

function drawFloor(c, kind, x, y, w, h, seed) {
  const map = { wood: 'teal', carpet: 'teal', carpetGreen: 'carpetGreen', teal: 'teal', teal2: 'teal2' };
  const k = map[kind] || kind, pal = P[k] || P.teal;
  if (k === 'musholla') { // green carpet with rows of prayer-rug shapes
    R(c, x, y, w, h, '#5C9672');
    for (let yy = 0; yy < h; yy += 16) for (let xx = 0; xx < w; xx += 16) {
      const bw = Math.min(10, w - xx - 3), bh = Math.min(13, h - yy - 2); if (bw < 4 || bh < 4) continue;
      R(c, x + xx + 3, y + yy + 1, bw, bh, '#4B8661'); R(c, x + xx + 4, y + yy + 2, bw - 2, bh - 2, '#69A582');
      R(c, x + xx + 3 + Math.floor(bw / 2) - 1, y + yy + 4, 2, 2, '#E8DAA6'); R(c, x + xx + 3 + Math.floor(bw / 2) - 2, y + yy + 6, 4, 1, '#E8DAA6');
    }
    return;
  }
  if (k === 'grass') {
    R(c, x, y, w, h, '#6BAE57'); const g = rng(seed + 3);
    for (let i = 0; i < w * h / 26; i++) { const gx = x + Math.floor(g() * (w - 3)), gy = y + Math.floor(g() * (h - 3)), r = g(); if (r < .55) { R(c, gx, gy + 1, 1, 2, '#5A9B49'); R(c, gx + 1, gy, 1, 3, '#5A9B49'); } else if (r < .9) R(c, gx, gy, 2, 1, '#7DBF68'); else { R(c, gx, gy, 1, 1, g() < .5 ? '#F4E7A0' : '#F2A7C0'); } }
    return;
  }
  if (k === 'gymMat') {
    R(c, x, y, w, h, '#47546A');
    for (let yy = 0; yy < h; yy += 16) for (let xx = 0; xx < w; xx += 16) { R(c, x + xx, y + yy, Math.min(16, w - xx), 1, '#38445A'); R(c, x + xx, y + yy, 1, Math.min(16, h - yy), '#38445A'); R(c, x + xx + 1, y + yy + 1, Math.min(15, w - xx - 1), 1, '#56647C'); if (((xx + yy) / 16) % 2) R(c, x + xx + 2, y + yy + 2, 3, 1, '#E0A24A'); }
    return;
  }
  if (k === 'lounge') {
    R(c, x, y, w, h, '#B89C8C');
    for (let yy = 0; yy < h; yy += 16) for (let xx = 0; xx < w; xx += 16) { if (((xx + yy) / 16) % 2) R(c, x + xx, y + yy, Math.min(16, w - xx), Math.min(16, h - yy), '#B09483'); R(c, x + xx, y + yy, Math.min(16, w - xx), 1, '#A38776'); R(c, x + xx, y + yy, 1, Math.min(16, h - yy), '#A38776'); }
    return;
  }
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
  let editing = false, frameCbs = new Set(), tickCbs = new Set(), camSig = '';
  let stage = null;
  let musicOn = false, musicChk = 0, focus = null, sel = null, ins = { left: 0, top: 0, right: 0, bottom: 0, ...(opts.insets || {}) };
  const canvas = document.createElement('canvas');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');

  /* ---------- furniture (catalog + activity engine live in furniture.js) ---------- */
  let furnList = opts.plan?.furniture || [], destroyed = false, curTime = 0, furnChk = 0;
  const furnWaiters = [];
  const engine = createEngine({
    world: () => world, ents: () => ents,
    roomOf: (tx, ty) => { const i = world.inRoom[ty * world.W + tx]; return i >= 0 ? world.rooms[i].id : null; },
    ownRoom: e => { const r = plan.rooms.find(x => x.id === (e.s?.room ?? e.homeRoom)); return r ? (r.kind === 'zone' ? r.zoneOf : r.id) : null; },
    blocked: (e, s) => !!earlyPlace(e, s),
  });
  // Magang (minions.js): cosmetic NPCs, own director; they live in `ents` like everyone (flag e.minion) so movement/drawing is shared
  const minions = createMinions({
    world: () => world, plan: () => plan, roles: () => roles, sessions: () => sessions, ents, engine,
    spawn: (id, look, atElevator) => spawnEnt(id, look, atElevator), randomSpot: id => randomSpot(id), serverDoor: () => serverDoor(),
    openElevator: ms => { world.elevator.until = performance.now() + (ms || 1500); },
    scenes: () => getCatalog().scenes || [],
  });
  // A* for Magang: cached per world (they repeat a few routes) and at most PATH_BUDGET uncached searches per frame, so 30 of them stay smooth
  const pathCache = new Map(), PATH_BUDGET = 2;
  let pathLeft = PATH_BUDGET;
  function minionPath(e) {
    const sx = Math.floor(e.x / T), sy = Math.floor(e.y / T), key = `${sx},${sy},${e.cur.tx},${e.cur.ty}`, hit = pathCache.get(key);
    if (hit) return hit.slice();
    if (pathLeft <= 0) return null;
    pathLeft--;
    const p = findPath(sx, sy, e.cur.tx, e.cur.ty) || [];
    if (pathCache.size > 600) pathCache.clear();
    pathCache.set(key, p);
    return p.slice();
  }

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
    world = { W, H, walk, inRoom, rooms, items: [], desks: [], wallDeco: [], leds: [], phones: [], clocks: [], tvs: [], eqs: [], speakers: [], rec: null, hang: [], rugs: [], zones: [], elevator: null, seat: new Set() };
    const block = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) walk[yy * W + xx] = 0; };
    let cur = null;
    const put = (img, tx, ty, fw, fh, o = {}) => {
      if (cur && !o.any && (tx < cur.x + 1 || ty < cur.y + WH || tx + fw > cur.x + cur.w - 1 || ty + fh > cur.y + cur.h - 1)) return false;
      const px = tx * T + Math.round((fw * T - img.width) / 2), py = (ty + fh) * T - img.height;
      world.items.push({ img, x: px, y: py, sortY: (ty + fh) * T, k: img._k, tx, ty, fw, fh });
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
    world.baseWalk = walk.slice(); world.baseSeat = new Set(world.seat);   // furniture is applied on top of this and can be swapped live
    if (plan.furniture) furnList = plan.furniture;
    applyFurniture();
    buildBg();
  }
  // (re)place the catalog furniture: reset walk grid, re-run layout, rebuild draw entries. Safe to call any time (live preview).
  function applyFurniture(list) {
    if (!world) return;
    if (list !== undefined) furnList = Array.isArray(list) ? list : [];
    engine.reset(); pathCache.clear(); minions.worldChanged();
    world.walk.set(world.baseWalk); world.seat = new Set(world.baseSeat);
    engine.layout(furnList);
    for (const inst of engine.insts) inst.entry = { y: inst.sortY, f: () => drawInst(inst) };
  }
  function drawInst(inst) {
    const b = inst.b, img = inst.use > 0 && b.active ? b.active : b.frames.length > 1 ? b.frames[Math.floor(curTime * b.fps) % b.frames.length] : b.frames[0];
    ctx.drawImage(img, inst.px, inst.py);
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
      case 'musik': {
        const last = () => world.items.at(-1), spk = () => world.speakers.push({ x: last().x + 9, y: last().y + 18, sortY: last().sortY + .1 });
        deco('vinyl', 38); deco('vinyl', 56, { col: '#3E6BA8' }); deco('eq', 76); deco('neonNote', 140); deco('gig', 174); deco('clock', r.w * T - 22);
        world.rugs.push({ x: (ix + 9) * T, y: (iy + 6) * T, w: 14 * T, h: 8 * T, c1: '#5B3F7A', c2: '#E2B04A' });
        if (put(S.speaker(), ix, iy, 2, 2)) spk();
        put(S.piano(), ix + 3, iy, 6, 2); put(S.bench(), ix + 5, iy + 2, 2, 1); put(plantSpr(0), ix + 10, iy + 1, 1, 1); // door lane (ix+12..14) stays clear
        if (put(S.turntable(), ix + 16, iy, 4, 2)) world.rec = { x: last().x + 10, y: last().y + 7, sortY: last().sortY + .1 };
        put(S.guitar(), ix + 21, iy, 2, 2);
        if (put(S.speaker(), ix + iw - 2, iy, 2, 2)) spk();
        put(S.drums(), ix + 1, iy + 7, 5, 3);
        if (put(S.sofa('#7A4E8C'), ix + 12, iy + 7, 5, 2)) for (const k of [1, 3]) world.hang.push({ tx: ix + 12 + k, ty: iy + 9, dy: -5 }); // sit just in front, overlapping the cushions
        [['#E5655D', 10, 11], ['#F2CF72', 17, 12], ['#3E6BA8', 19, 9]].forEach(([col, bx, by]) => { if (put(S.beanbag(col), ix + bx, iy + by, 2, 1)) { world.walk[(iy + by) * world.W + ix + bx] = 1; world.hang.push({ tx: ix + bx, ty: iy + by }); } });
        put(plantSpr(0), ix, iy + ih - 1, 1, 1); put(plantSpr(1), ix + iw - 1, iy + ih - 1, 1, 1);
        break;
      }
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
      case 'musholla': deco('arch', Math.max(8, Math.floor(r.w * T / 2) - 15)); deco('clock', r.w * T - 26); deco('window', 12); break;
      case 'lounge': deco('window', 14); deco('poster', 70); deco('clock', r.w * T - 26); if (r.w > 26) deco('window', r.w * T - 52); break;
      case 'gym': deco('mirror', 12, { w: 44 }); deco('mirror', 64, { w: 44 }); deco('poster3', 124); deco('clock', r.w * T - 26); break;
      case 'taman': deco('plantWall', 10); deco('window', 44); deco('plantWall', Math.max(60, r.w * T - 40)); break;
      case 'telepon': deco('clock', Math.floor(r.w * T / 2) - 7); break;
      case 'tidur': deco('window', 14); deco('clock', r.w * T - 26); break;
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
    world.clocks = []; world.tvs = []; world.lamps = []; world.eqs = [];
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
        for (let k = 0; k < 5; k++) { R(c, x + 2 + k * cw + cw - 1, y + 3, 1, 18, '#DADAD2'); list.filter(cd => (cd.stage ?? cd.col) === k).slice(0, 4).forEach((cd, i) => R(c, x + 3 + k * cw + (i % 2) * 3, y + 4 + Math.floor(i / 2) * 4 + (i % 2), 3, 3, cd.blocked ? '#E5655D' : cols[k])); }
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
      case 'vinyl': disc(c, x + 8, y + 10, 8, '#2A2430'); disc(c, x + 8, y + 10, 7, '#14161C'); disc(c, x + 8, y + 10, 5, '#22252D'); disc(c, x + 8, y + 10, 3, d.col || '#C2413A'); R(c, x + 8, y + 10, 1, 1, '#14161C'); R(c, x + 3, y + 6, 3, 1, '#555B68'); R(c, x + 10, y + 15, 3, 1, '#555B68'); break;
      case 'gig': R(c, x, y + 1, 20, 24, '#F4F0E4'); R(c, x + 1, y + 2, 18, 22, '#2A1F4A'); R(c, x + 1, y + 2, 18, 4, '#F49AC1'); disc(c, x + 8, y + 15, 3, '#F2CF72'); R(c, x + 10, y + 7, 2, 9, '#F2CF72'); R(c, x + 12, y + 7, 4, 2, '#F2CF72'); R(c, x + 3, y + 20, 14, 1, '#7FD3C9'); R(c, x + 5, y + 22, 10, 1, '#FFFFFF'); break;
      case 'neonNote': R(c, x, y + 2, 24, 20, '#1E1A2E'); R(c, x, y + 2, 24, 1, '#3A3358'); R(c, x + 4, y + 14, 5, 4, '#F49AC1'); R(c, x + 8, y + 5, 2, 11, '#F49AC1'); R(c, x + 10, y + 5, 5, 2, '#F49AC1'); R(c, x + 13, y + 7, 2, 4, '#F49AC1'); R(c, x + 15, y + 15, 4, 3, '#7FD3C9'); R(c, x + 18, y + 8, 2, 8, '#7FD3C9'); break;
      case 'eq': R(c, x, y + 3, 28, 18, '#14181F'); R(c, x + 1, y + 4, 26, 16, '#1B2230'); world.eqs.push({ x: x + 3, y: y + 18, n: 6 }); break;
      case 'arch': R(c, x, y + 2, 30, 22, '#2F6B4F'); R(c, x + 3, y + 5, 24, 19, '#E9D9A2'); R(c, x + 6, y + 8, 18, 16, '#2F6B4F'); R(c, x + 9, y + 6, 12, 3, '#2F6B4F'); R(c, x + 12, y + 4, 6, 3, '#2F6B4F'); R(c, x + 14, y + 11, 2, 2, '#E9D9A2'); R(c, x + 13, y + 13, 4, 1, '#E9D9A2'); break;
      case 'mirror': R(c, x, y + 2, d.w || 44, 21, '#7A808A'); R(c, x + 1, y + 3, (d.w || 44) - 2, 19, '#B8CAD8'); for (let k = 4; k < (d.w || 44) - 6; k += 14) { line(c, x + k, y + 20, x + k + 6, y + 5, 'rgba(255,255,255,.55)'); } break;
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
  // higher-priority places that always win over furniture activities
  function earlyPlace(e, s) {
    if (s.status === 'ended') return { key: 'leave', type: 'leave' };
    if (s.kind === 'rapat') return { key: 'meeting', type: 'spot', room: plan.rooms.some(r => r.id === 'meeting') ? 'meeting' : s.room, seed: hashStr(s.sid) };
    const tool = s.tool, label = tool ? `${tool.name} ${tool.label}` : '';
    if (s.waiting && SERVERISH.test(s.waiting.summary || '') && serverDoor()) return { key: 'srvdoor', type: 'door' };
    if (s.status === 'working' && tool && tool.name === 'Bash' && SERVERISH.test(tool.label) && plan.rooms.some(r => r.kind === 'server')) return { key: 'server', type: 'spot', room: world.rooms.find(r => r.kind === 'server').id };
    if (s.status === 'working' && tool && tool.name === 'Bash' && TESTISH.test(tool.label) && plan.rooms.some(r => r.id === 'qa')) return { key: 'qa', type: 'spot', room: 'qa' };
    if (s.status === 'working' && tool && (tool.name === 'WebSearch' || tool.name === 'WebFetch') && plan.rooms.some(r => r.id === 'lib')) return { key: 'lib', type: 'spot', room: 'lib' };
    if (musicOn && world.hang.length && s.status === 'idle' && !s.waiting && !e.sub) { const i = hangers().indexOf(s.sid); if (i >= 0) return { key: 'musik' + i, type: 'spot', room: world.rooms.find(r => r.kind === 'musik').id, tile: world.hang[i % world.hang.length] }; }
    return null;
  }
  function desiredPlace(e, s) {
    const early = earlyPlace(e, s); if (early) return early;
    const fp = engine.placeFor(e); if (fp) return fp;
    if (s.status === 'idle' && Date.now() - Date.parse(s.lastSeen) > 12 * 60e3 && plan.rooms.some(r => r.id === 'pantry')) return { key: 'pantry', type: 'spot', room: 'pantry', seed: hashStr(s.sid) };
    if (e.desk) return { key: 'desk', type: 'desk' };
    return { key: 'hot', type: 'spot', room: s.room, seed: hashStr(s.sid) };
  }
  // up to 4 idle sessions (picked by hash of the session id) hang out in the music room while music plays
  const hangers = () => sessions.filter(x => x.status === 'idle' && !x.waiting && x.kind !== 'rapat').map(x => [hashStr(x.sid), x.sid]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).slice(0, Math.min(4, world.hang.length)).map(x => x[1]);
  function replan(e, s) {
    const pl = desiredPlace(e, s), dwell = performance.now() - (e.placeAt || 0);
    if (e.act && pl.type !== 'furn') engine.abort(e);   // a higher-priority place took over
    const furn = pl.type === 'furn' || String(e.place).startsWith('furn');
    if (pl.key !== e.place && (dwell > 3500 || furn || e.place === 'desk' || e.place == null || pl.key === 'leave' || pl.key === 'srvdoor')) goPlace(e, pl);
  }
  function goPlace(e, pl) {
    e.q = []; e.cur = null; e.place = pl.key; e.placeAt = performance.now(); e.pose = null;
    if (pl.type === 'furn') {   // walk to the reserved spot (or beside the chat partner), then let the engine start the activity
      const a = pl.act, sp = a.inst ? a.inst.spots[a.si] : a.at;
      e.goingTo = a.aff === 'chat' ? 'ngobrol' : a.inst.def.name;
      if (e.instant && a.inst) { e.instant = false; e.x = sp.tx * T + 4; e.y = sp.ty * T + 7; engine.arrive(e); return; }
      e.instant = false;
      e.q.push({ t: 'go', tx: sp.tx, ty: sp.ty }, { t: 'call', fn: () => engine.arrive(e) });
      return;
    }
    e.goingTo = pl.type === 'desk' ? 'meja' : pl.type === 'leave' ? 'lift' : pl.type === 'door' ? 'Ruang Server' : (plan.rooms.find(r => r.id === pl.room)?.name || '');
    if (e.instant) { // first render after a page load: no walking in from the lift
      e.instant = false;
      const tgt = pl.type === 'desk' ? null : pl.type === 'door' ? serverDoor() : pl.type === 'spot' ? (pl.tile || randomSpot(pl.room, pl.seed)) : null;
      if (pl.type === 'desk') { e.x = e.desk.seat.x; e.y = e.desk.seat.y; e.mode = 'sit'; return; }
      if (tgt) { e.x = tgt.tx * T + 4; e.y = tgt.ty * T + 7 + (tgt.dy || 0); return; }
    }
    if (pl.type === 'desk') e.q.push({ t: 'go', tx: e.desk.seat.tx, ty: e.desk.seat.ty }, { t: 'sit' });
    else if (pl.type === 'door') { const d = serverDoor(); e.q.push({ t: 'go', tx: d.tx, ty: d.ty }); }
    else if (pl.type === 'leave') { e.q.push({ t: 'go', tx: world.elevator.tx, ty: world.elevator.ty }, { t: 'call', fn: () => { world.elevator.until = performance.now() + 1500; e.fade = true; } }); }
    else { const sp = pl.tile || randomSpot(pl.room, pl.seed); if (sp) e.q.push({ t: 'go', tx: sp.tx, ty: sp.ty }, ...(sp.dy ? [{ t: 'call', fn: () => { e.y += sp.dy; } }] : [])); }
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
    minions.sessions(list);
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
      replan(e, s);
      // subagents
      for (const sub of s.subs || []) {
        const id = `${s.sid}:${sub.id}`;
        seen.add(id);
        let se = ents.get(id);
        if (!se && sub.status === 'done') continue; // already reported and left by the lift; the server keeps it 60s for the chat, so don't respawn it
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
      if (seen.has(id) || e.fade || e.owner || e.minion) continue;
      if (!e.leaving) { e.leaving = true; engine.abort(e); e.q = []; e.cur = null; e.bubble = e.sub ? '' : 'Pulang'; e.q.push({ t: 'go', tx: world.elevator.tx, ty: world.elevator.ty }, { t: 'call', fn: () => { world.elevator.until = performance.now() + 1500; e.fade = true; } }); }
    }
  }
  // an agent about to walk into the owner stops; after a moment it looks for a way around, and in the end walks on (never stuck)
  function ownerInWay(e, nx, ny) {
    const now = performance.now();
    if (e.ghostUntil > now) return false;
    let o = null;
    for (const q of ents.values()) if (q.owner && !q.fade && Math.hypot(q.x - nx, q.y - ny) < 7 && Math.hypot(q.x - nx, q.y - ny) < Math.hypot(q.x - e.x, q.y - e.y)) { o = q; break; }
    if (!o) { e.ownerWait = 0; return false; }
    e.mode = 'stand';
    if (!e.ownerWait) { e.ownerWait = now; e.detoured = false; }
    const waited = now - e.ownerWait;
    if (waited > 900 && !e.detoured && e.cur?.t === 'go') {
      e.detoured = true;
      const { W, walk } = world, oi = Math.floor(o.y / T) * W + Math.floor(o.x / T), was = walk[oi];
      walk[oi] = 0; const p = findPath(Math.floor(e.x / T), Math.floor(e.y / T), e.cur.tx, e.cur.ty); walk[oi] = was;
      if (p && p.length) e.path = p;
    }
    if (waited > 4000) { e.ghostUntil = now + 1500; e.ownerWait = 0; }
    return true;
  }
  function step(e, dt) {
    if (!e.cur && e.q.length) {
      e.cur = e.q.shift(); e.cur.started = performance.now();
      if (e.cur.t === 'go') {
        e.mode = 'stand'; e.pose = null;
        if (e.minion) { const p = minionPath(e); if (!p) { e.q.unshift(e.cur); e.cur = null; return; } e.path = p; }
        else e.path = findPath(Math.floor(e.x / T), Math.floor(e.y / T), e.cur.tx, e.cur.ty) || [];
      }
    }
    const c = e.cur; if (!c) return;
    if (c.t === 'go') {
      if (!e.path.length) { e.cur = null; return; }
      const tgt = e.path[0], dx = tgt.x - e.x, dy = tgt.y - e.y, dist = Math.hypot(dx, dy), sp = (e.owner || e.minion ? e.speed || 56 : 56) * dt;
      if (!e.owner && dist > 0 && ownerInWay(e, e.x + dx / dist * Math.min(sp + 4, dist), e.y + dy / dist * Math.min(sp + 4, dist))) return;
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
  let ownerTap = null, lastPan = 0;
  const panBy = (dx, dy) => { lastPan = performance.now(); cam.tx -= dx / cam.z; cam.ty -= dy / cam.z; clamp(cam); cam.x = cam.tx; cam.y = cam.ty; focus = null; };
  // pinch zoom keeps the point between the fingers fixed; applied at once (no easing) so it tracks the fingers
  const zoomNow = (f, sx, sy) => { zoomBy(f, sx, sy); Object.assign(cam, { x: cam.tx, y: cam.ty, z: cam.tz }); };
  // touch/pen navigation for an element laid over the stage: two-finger pinch+pan, one-finger fling (inertia). Mouse is left to the callers.
  function touchNav(el) {
    const pts = new Map(); let base = null, fl = 0, smp = [];
    const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    const stop = () => cancelAnimationFrame(fl);
    return {
      get size() { return pts.size; }, stop,
      down(e) { if (e.pointerType === 'mouse') return; stop(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); smp = []; base = pts.size === 2 ? two() : null; },
      move(e) {
        const p = pts.get(e.pointerId); if (!p) return false;
        p.x = e.clientX; p.y = e.clientY;
        if (pts.size !== 2) { const t = performance.now(); smp.push({ t, x: p.x, y: p.y }); while (smp.length > 1 && t - smp[0].t > 100) smp.shift(); return false; }
        const n = two(), r = el.getBoundingClientRect();
        if (base) { zoomNow(n.d / base.d, n.x - r.left, n.y - r.top); panBy(n.x - base.x, n.y - base.y); }
        base = n; return true;
      },
      up(e, fling) {
        if (!pts.delete(e.pointerId)) return; base = null;
        const t = performance.now(), a = smp[0], z = smp[smp.length - 1];
        if (!fling || pts.size || !a || z === a || t - z.t > 60) return;
        let vx = (z.x - a.x) / (z.t - a.t), vy = (z.y - a.y) / (z.t - a.t), last = t;   // px/ms
        const run = now => {
          const dt = Math.min(40, now - last); last = now;
          panBy(vx * dt, vy * dt); const k = Math.exp(-dt / 325); vx *= k; vy *= k;
          if (Math.hypot(vx, vy) > .02) fl = requestAnimationFrame(run);
        };
        if (Math.hypot(vx, vy) > .15) fl = requestAnimationFrame(run);
      },
    };
  }
  const nav = touchNav(canvas);
  canvas.style.touchAction = 'none';   // the finger drives the camera, never the page
  canvas.style.webkitTouchCallout = 'none';
  canvas.addEventListener('contextmenu', e => { if (e.pointerType === 'touch' || lastType !== 'mouse') e.preventDefault(); });
  let down = null, lastType = 'mouse', lastTap = null;
  canvas.addEventListener('pointerdown', e => {
    if (editing) return;
    lastType = e.pointerType; nav.down(e);
    canvas.setPointerCapture(e.pointerId);
    if (nav.size > 1) { down = null; lastTap = null; return; }   // second finger: pinch, not a tap
    down = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty, moved: false, touch: e.pointerType !== 'mouse', id: e.pointerId };
  });
  canvas.addEventListener('pointermove', e => {
    if (editing) return;
    if (nav.move(e)) return;
    const r = canvas.getBoundingClientRect();
    if (down) { const dx = e.clientX - down.x, dy = e.clientY - down.y; if (Math.abs(dx) + Math.abs(dy) > (down.touch ? 10 : 4)) { down.moved = true; canvas.classList.add('grabbing'); } if (down.moved) { lastPan = performance.now(); cam.tx = down.cx - dx / cam.z; cam.ty = down.cy - dy / cam.z; clamp(cam); cam.x = cam.tx; cam.y = cam.ty; focus = null; } return; }
    if (e.pointerType === 'mouse') canvas.classList.toggle('hot', !!hitAt(e.clientX - r.left, e.clientY - r.top));
  });
  const fitZoom = () => Math.min(visW() / (world.W * T), visH() / (world.H * T));
  canvas.addEventListener('pointerup', e => {
    if (editing) return;
    canvas.classList.remove('grabbing');
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    nav.up(e, !!down && down.moved);
    if (down && !down.moved) {
      const now = performance.now();
      if (down.touch && lastTap && now - lastTap.t < 320 && Math.hypot(sx - lastTap.x, sy - lastTap.y) < 32) {
        // double-tap: zoom in on the point, or back to fit when already zoomed
        lastTap = null;
        if (cam.tz > fitZoom() * 1.3) fitAll(); else zoomBy(Math.min(2.4, 6 / cam.tz), sx, sy);
      } else {
        lastTap = down.touch ? { t: now, x: sx, y: sy } : null;
        const h = hitAt(sx, sy);
        if (h?.minion) opts.onMinion?.(h.minion, sx, sy);
        else if (ownerTap && ownerTap(sx, sy, h)) { /* the owner walks there */ }
        else if (h) onPick(h.sid, h.sub || null, h.role || null);
        else { const rm = roomAt(sx, sy); if (rm) { sel = rm; onRoom(rm); if (focus !== rm && cam.z < 2.2) focusRoom(rm); } }
      }
    }
    down = null;
  });
  canvas.addEventListener('pointercancel', e => { nav.up(e, false); down = null; canvas.classList.remove('grabbing'); });
  canvas.addEventListener('dblclick', e => { if (editing || lastType !== 'mouse') return; const r = canvas.getBoundingClientRect(); const rm = roomAt(e.clientX - r.left, e.clientY - r.top); if (rm) focusRoom(rm); });
  canvas.addEventListener('wheel', e => { if (editing || !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const ro = new ResizeObserver(() => { fitCanvas(); if (focus) focusRoom(focus, true); else clamp(cam); });
  ro.observe(host);

  /* ---------- render ---------- */
  const night = () => darkMQ.matches;
  const fadeTimer = setInterval(() => { for (const [id, e] of ents) if (e.fade) { e.alpha -= .25; if (e.alpha <= 0) { engine.abort(e); ents.delete(id); } } }, 120);
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!document.body.contains(canvas)) { destroy(); return; }
    const dt = Math.min(.05, (t - lastT) / 1000); lastT = t;
    const k = 1 - Math.pow(.0008, dt);
    cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k;
    musicOn = document.body.dataset.music === 'on';
    if (world.hang.length && t - musicChk > 1000) { musicChk = t; for (const e of ents.values()) if (e.s && !e.sub && !e.leaving && !e.fade) replan(e, e.s); }
    for (const f of tickCbs) f(dt, t);
    pathLeft = PATH_BUDGET;
    for (const e of ents.values()) step(e, dt);
    if (t - furnChk > 400) { furnChk = t; engine.tick(); minions.tick(); for (const e of ents.values()) if (e.s && !e.sub && !e.leaving && !e.fade) replan(e, e.s); }
    world.elevator.open += ((performance.now() < world.elevator.until ? 1 : 0) - world.elevator.open) * Math.min(1, dt * 6);
    if (Date.now() - world.bgAt > 120000) buildBg();
    draw(t / 1000);
    if (frameCbs.size) { const sig = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.z.toFixed(4)},${canvas._w},${canvas._h}`; if (sig !== camSig) { camSig = sig; frameCbs.forEach(f => f()); } }
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
    for (const q of world.eqs) for (let i = 0; i < q.n; i++) { const hh = musicOn ? 2 + Math.floor((Math.sin(time * 6 + i * 1.9) * .5 + .5) * 9 * (.6 + .4 * Math.sin(time * 2.3 + i))) : 1; emis.push([q.x + i * 4, q.y - hh, 3, hh, i > 4 ? '#E5655D' : i > 2 ? '#F2CF72' : '#5CC28A']); }
    drawElevator(c, world.elevator, emis);
    const sv = world.rooms.find(r => r.kind === 'server');
    if (sv) { const d = sv.doors[0]; const busy = sessions.some(s => s.tool?.name === 'Bash' && SERVERISH.test(s.tool.label)); const wait = sessions.some(s => s.waiting && SERVERISH.test(s.waiting.summary || '')); const col = busy ? '#5CC28A' : wait ? '#E3A33A' : '#E5655D'; if (d.s === 't') { R(c, (sv.x + d.at) * T, sv.y * T + WH * T - 3, d.w * T, 3, col); emis.push([(sv.x + d.at) * T, sv.y * T + WH * T - 3, d.w * T, 3, col]); } }
    const list = [];
    curTime = time;
    const vx0 = cam.x - 48, vy0 = cam.y - 48, vx1 = cam.x + canvas._w / z + 48, vy1 = cam.y + canvas._h / z + 48;
    for (const inst of engine.insts) {   // catalog furniture: flat things (rugs, mats) under everyone, the rest sorted with characters
      const sw = inst.def.sprite.w, sh = inst.def.sprite.h;
      if (inst.px > vx1 || inst.px + sw < vx0 || inst.py > vy1 || inst.py + sh < vy0) continue;
      if (inst.flat) drawInst(inst); else list.push(inst.entry);
    }
    for (const it of world.items) list.push({ y: it.sortY, f: () => c.drawImage(it.img, it.x, it.y) });
    hits = [];
    const on = musicOn;
    for (const sp of world.speakers) list.push({ y: sp.sortY, f: () => { const beat = on ? Math.abs(Math.sin(time * 7.5)) : 0, r = on && beat > .55 ? 4 : 3; disc(c, sp.x, sp.y, r, on ? '#7C8396' : '#4A4F5C'); disc(c, sp.x, sp.y, r - 2, '#2A2D35'); R(c, sp.x, sp.y, 1, 1, on ? '#F2CF72' : '#1B1E25'); if (on) { disc(c, sp.x, sp.y - 11, 1, beat > .3 ? '#F2CF72' : '#555B68'); } } });
    const rc = world.rec;
    if (rc) list.push({ y: rc.sortY, f: () => {
      const a = on ? time * 4.2 : .7, cx = rc.x, cy = rc.y, px = (k, rad) => [cx + Math.round(Math.cos(a + k) * rad), cy + Math.round(Math.sin(a + k) * rad * .85)];
      disc(c, cx, cy, 5, '#0E1014'); disc(c, cx, cy, 2, '#C2413A'); for (const k of [0, Math.PI]) { const [x, y] = px(k, 4); R(c, x, y, 1, 1, on ? '#B9C0D0' : '#3A3E48'); const [x2, y2] = px(k, 2); R(c, x2, y2, 1, 1, '#F2CF72'); }
      R(c, cx, cy, 1, 1, '#0E1014');
      const ax = rc.x + 17, ay = rc.y - 4, bx = on ? rc.x + 4 : ax, by = on ? rc.y - 2 : rc.y + 3; line(c, ax, ay, bx, by, '#C9CDD4'); R(c, bx, by, 2, 1, '#E8EAF0');
    } });
    if (on) { let n = 0; for (const sp of world.speakers) for (let i = 0; i < 3; i++, n++) { const ph = (time * .45 + i / 3 + n * .21) % 1, nx = sp.x - 4 + Math.round(Math.sin(ph * 7 + n) * 5) + (i - 1) * 4, ny = sp.y - 14 - Math.round(ph * 30); list.push({ y: 1e6, f: () => { c.globalAlpha = Math.min(1, ph * 6) * (1 - ph * ph); c.drawImage(S.note(i + n), nx, ny); c.globalAlpha = 1; } }); } }
    for (const d of world.desks) list.push({ y: (d.ty + 2) * T + 1, f: () => drawDesk(c, d, time, emis) });
    for (const e of ents.values()) if (e.sub && e.alpha > 0 && !editing) { const p = ents.get(e.parent); if (p) { c.globalAlpha = .55 * e.alpha; dash(c, e.x, e.y - 10, p.x, p.y - 12, e.cap); c.globalAlpha = 1; } }
    for (const e of ents.values()) { if (e.mode === 'sit' || editing) continue; list.push({ y: e.pose && e.poseInst ? Math.max(e.y, e.poseInst.sortY + .5) : e.y, f: () => drawEnt(c, e, time) }); }
    list.sort((a, b) => a.y - b.y).forEach(i => i.f());
    if (!editing) drawOverlays(c, time);
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
    const sitting = !editing && e && e.mode === 'sit' && e.desk === d;
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
      if (sitting) { glow(c, sx, sy - 8, e.look.color, busy); drawPerson(c, sx, sy, e.look, { sit: true, t: time + e.t0, typing: busy && !(e.faceUntil > performance.now()), blink: blink(time + e.t0), dir: e.faceUntil > performance.now() ? e.faceDir : 'up' }); hits.push({ x0: sx - 8, y0: sy - 22, x1: sx + 8, y1: sy + 2, sid: e.sid }); }
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
  let lanNow = null;   // lanyard colour while a Magang is drawn (every pose goes through drawPerson)
  function drawPerson(c, x, y, p, o) {
    if (lanNow && !o.lanyard) o = { ...o, lanyard: lanNow };
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) personShape(c, x + dx, y + dy, p, o, P.ol);
    personShape(c, x, y, p, o, null);
  }
  const shd = (hex, k) => { const n = parseInt(String(hex).slice(1, 7), 16) || 0; return '#' + [16, 8, 0].map(s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k))).toString(16).padStart(2, '0')).join(''); };
  function personShape(c, x, y, p, o, ol) {
    const f = col => ol || col;
    const bob = o.walk && Math.floor(o.t * 8) % 2 ? 1 : 0;
    const legs = o.sit ? 0 : (o.small ? 3 : 4);
    const bodyH = o.small ? 5 : 6;
    const top = y - legs - bodyH - 10 - bob;
    const back = o.dir === 'up', tb = top + 10;
    const st = p.hairStyle || 'short', of = p.outfit || 'kemeja', acc = p.acc || '', hij = st === 'hijab';
    const fem = hij || ['long', 'bun', 'ponytail', 'bob', 'pigtails'].includes(st) || of === 'rok' || of === 'dress';
    const hc = f(p.hair), sk = f(p.skin), hl = f(shd(p.hair, 1.45)), hj = f(p.hijab || '#E8EEF8'), acn = f(shd(p.color, 1.25)), dk = f(shd(p.color, .7)), white = f('#F4F4F4');
    const cap = o.cap || (acc === 'topi' && !hij ? p.color : null);
    const ox = o.dir === 'left' ? -1 : o.dir === 'right' ? 1 : 0;
    // hair that sits behind the head (front view) or over the whole back (back view)
    const hairBack = () => {
      if (hij) return;
      if (st === 'long') R(c, x - 6, top + 2, 12, 12, hc);
      else if (st === 'bob') R(c, x - 6, top + 2, 12, 9, hc);
      else if (st === 'curly') { R(c, x - 7, top, 14, 8, hc); R(c, x - 6, top - 2, 12, 2, hc); R(c, x - 6, top + 8, 2, 1, hc); R(c, x + 4, top + 8, 2, 1, hc); if (!ol) { R(c, x - 5, top - 1, 1, 1, hl); R(c, x + 1, top - 2, 1, 1, hl); R(c, x + 5, top + 1, 1, 1, hl); R(c, x - 7, top + 3, 1, 1, hl); R(c, x + 6, top + 5, 1, 1, hl); } }
      else if (st === 'ponytail') { R(c, x + 5, top + 2, 3, 3, hc); R(c, x + 6, top + 5, 2, 6, hc); if (!ol) R(c, x + 5, top + 2, 3, 1, acn); }
      else if (st === 'pigtails') { R(c, x - 8, top + 3, 3, 8, hc); R(c, x + 5, top + 3, 3, 8, hc); if (!ol) { R(c, x - 8, top + 3, 3, 1, acn); R(c, x + 5, top + 3, 3, 1, acn); } }
      else if (st === 'bun') R(c, x - 3, top - 4, 6, 4, hc);
    };
    const hairBackView = () => {
      if (hij) { R(c, x - 6, top - 1, 12, 12, hj); R(c, x - 6, tb - 1, 12, 4, hj); R(c, x - 5, tb + 3, 10, 1, hj); R(c, x - 3, tb + 4, 6, 1, hj); if (!ol) R(c, x, top + 2, 1, 9, shd(p.hijab || '#E8EEF8', .85)); return; }
      hairBack();
      if (st === 'long') R(c, x - 6, top + 2, 12, bodyH + 9, hc);
      else if (st === 'bob') R(c, x - 6, top, 12, 11, hc);
      R(c, x - 5, top, 10, 8, hc);
      if (st === 'ponytail') { R(c, x - 2, top + 3, 4, 9, hc); if (!ol) R(c, x - 2, top + 3, 4, 1, acn); }
      if (!ol && st !== 'short') R(c, x - 3, top + 1, 2, 1, hl);
    };
    // legs colours, skirts
    const skirt = f(shd(p.color, .55)), skirted = of === 'rok' || of === 'dress';
    if (!back) { hairBack(); }
    // head
    R(c, x - 5, top, 10, 10, sk);
    if (!back) {
      if (hij) {
        R(c, x - 6, top - 1, 12, 4, hj); R(c, x - 6, top + 3, 2, 8, hj); R(c, x + 4, top + 3, 2, 8, hj); R(c, x - 4, top + 9, 8, 2, hj);
        if (!ol) { R(c, x - 6, top + 2, 12, 1, shd(p.hijab || '#E8EEF8', .85)); R(c, x - 4, top + 8, 8, 1, shd(p.skin, .85)); }
      } else {
        R(c, x - 5, top, 10, 3, hc);
        if (st === 'long' || st === 'bob') { R(c, x - 5, top + 3, 2, 6, hc); R(c, x + 3, top + 3, 2, 6, hc); R(c, x - 5, top + 3, st === 'bob' ? 10 : 6, 1, hc); }
        else if (st === 'pigtails') { R(c, x - 5, top + 3, 10, 1, hc); R(c, x - 5, top + 4, 1, 2, hc); R(c, x + 4, top + 4, 1, 2, hc); }
        else if (st === 'ponytail') { R(c, x - 5, top + 3, 6, 1, hc); R(c, x - 5, top + 4, 1, 3, hc); R(c, x + 4, top + 4, 1, 1, hc); }
        else if (st === 'curly') { R(c, x - 5, top + 3, 3, 1, hc); R(c, x + 2, top + 3, 3, 1, hc); R(c, x - 5, top + 4, 1, 2, hc); R(c, x + 4, top + 4, 1, 2, hc); }
        else { R(c, x - 5, top + 3, 2, 3, hc); R(c, x + 3, top + 3, 2, 2, hc); }
        if (!ol && st !== 'short') R(c, x - 2, top + 1, 3, 1, hl);
      }
    }
    if (!ol && !back) {
      const eye = '#1F1628';
      if (fem) { R(c, x - 4 + ox, top + 7, 1, 1, '#F29C9C'); R(c, x + 3 + ox, top + 7, 1, 1, '#F29C9C'); }
      if (!o.blink) { R(c, x - 3 + ox, top + 5, 2, 2, eye); R(c, x + 1 + ox, top + 5, 2, 2, eye); if (fem) { R(c, x - 4 + ox, top + 5, 1, 1, eye); R(c, x + 3 + ox, top + 5, 1, 1, eye); } }
      else R(c, x - 3 + ox, top + 6, 2, 1, eye), R(c, x + 1 + ox, top + 6, 2, 1, eye);
      if (fem) R(c, x - 1 + ox, top + 8, 2, 1, '#D46A6A');
    }
    // body
    const th = of === 'rok' ? bodyH - 2 : bodyH;
    R(c, x - 5, tb, 10, th, f(p.color));
    if (skirted) R(c, x - 6, tb + th - (of === 'dress' ? 1 : 0), 12, of === 'dress' ? 3 : 3, skirt === ol ? ol : (of === 'dress' ? f(p.color) : skirt));
    if (!ol) {
      if (of === 'dress') { R(c, x - 5, tb + 2, 10, 1, dk); R(c, x - 6, tb + bodyH + 1, 12, 1, 'rgba(0,0,0,.18)'); R(c, x - 3, tb + bodyH, 1, 1, acn); R(c, x + 2, tb + bodyH + 1, 1, 1, acn); }
      else if (of === 'rok') R(c, x - 5, tb + th - 1, 10, 1, 'rgba(0,0,0,.25)');
      else R(c, x - 5, tb + bodyH - 1, 10, 1, 'rgba(0,0,0,.2)');
      if (!back) {
        if (of === 'jas') { R(c, x - 2, tb, 4, 3, white); R(c, x - 3, tb, 1, 4, dk); R(c, x + 2, tb, 1, 4, dk); if (p.tie) R(c, x - 1, tb + 1, 2, bodyH - 1, '#C2413A'); }
        else if (of === 'hoodie') { R(c, x - 4, tb, 8, 2, dk); R(c, x - 1, tb, 2, 1, sk); R(c, x - 2, tb + 2, 1, 2, white); R(c, x + 1, tb + 2, 1, 2, white); R(c, x - 3, tb + bodyH - 2, 6, 1, dk); }
        else { R(c, x - 1, tb, 2, 1, p.skin); if (p.tie && of === 'kemeja') R(c, x - 1, tb + 1, 2, bodyH - 1, '#C2413A'); }
      } else if (of === 'hoodie') R(c, x - 4, tb - 1, 8, 4, dk);
      else if (of === 'jas') R(c, x, tb + 2, 1, bodyH - 2, dk);
    }
    if (o.lanyard && !ol && !back) { R(c, x - 2, tb, 1, 2, o.lanyard); R(c, x + 1, tb, 1, 2, o.lanyard); R(c, x - 2, tb + 2, 4, 2, '#F4F4F4'); }
    if (back) hairBackView();
    else if (st === 'long' && !hij) { R(c, x - 5, tb, 2, 5, hc); R(c, x + 3, tb, 2, 5, hc); }
    if (hij && !back) { R(c, x - 6, tb - 1, 12, 3, hj); R(c, x - 5, tb + 2, 10, 1, hj); R(c, x - 3, tb + 3, 6, 1, hj); if (!ol) R(c, x, tb + 2, 1, 2, shd(p.hijab || '#E8EEF8', .85)); }
    // accessories on the head
    if (cap) { R(c, x - 6, top - 1, 12, 4, f(cap)); if (!back) R(c, x - 6, top + 3, 12, 1, f(shd(cap, .7))); }
    if (!ol && acc === 'anting') { R(c, x - 6, top + 8, 1, 2, '#F5C84C'); R(c, x + 5, top + 8, 1, 2, '#F5C84C'); }
    if (!ol && !back && acc === 'kacamata') { const fr = '#D9A21B', gx = x + ox; R(c, gx - 4, top + 4, 8, 1, fr); R(c, gx - 4, top + 5, 1, 2, fr); R(c, gx + 3, top + 5, 1, 2, fr); R(c, gx - 1, top + 5, 2, 1, fr); R(c, gx - 4, top + 7, 3, 1, fr); R(c, gx + 1, top + 7, 3, 1, fr); }
    // arms
    const a = o.typing ? Math.floor(o.t * 9) % 2 : 0;
    if (o.sit) { R(c, x - 7, tb + 1 - a, 2, 4, f(p.color)); R(c, x + 5, tb + a, 2, 4, f(p.color)); if (!ol) { R(c, x - 7, tb + 4 - a, 2, 1, p.skin); R(c, x + 5, tb + 3 + a, 2, 1, p.skin); } }
    else {
      const lph = o.walk ? Math.floor(o.t * 8) % 2 : -1, ph = o.walk ? lph : o.wave ? Math.floor(o.t * 6) % 2 : -1;
      if (o.armsUp) { // both hands up and moving (writing on a board, jumping jacks)
        R(c, x - 7, tb - 3 + (ph === 0 ? 1 : 0), 2, 5, f(p.color)); R(c, x + 5, tb - 3 + (ph === 1 ? 1 : 0), 2, 5, f(p.color));
        if (!ol) { R(c, x - 7, tb - 4 + (ph === 0 ? 1 : 0), 2, 1, p.skin); R(c, x + 5, tb - 4 + (ph === 1 ? 1 : 0), 2, 1, p.skin); }
      } else {
        R(c, x - 7, tb + 1 + (ph === 0 ? 1 : 0), 2, 4, f(p.color)); R(c, x + 5, tb + 1 + (ph === 1 ? 1 : 0), 2, 4, f(p.color));
        if (!ol) { R(c, x - 7, tb + 5 + (ph === 0 ? 1 : 0), 2, 1, p.skin); R(c, x + 5, tb + 5 + (ph === 1 ? 1 : 0), 2, 1, p.skin); }
      }
      const lb = tb + bodyH, l1 = lph === 1 ? legs - 1 : legs, l2 = lph === 0 ? legs - 1 : legs, lc = skirted ? sk : f(of === 'hoodie' ? '#3B4F78' : '#2B3242');
      R(c, x - 4, lb, 3, l1, lc); R(c, x + 1, lb, 3, l2, lc);
      R(c, x - 4, lb + l1 - 1, 3, 1, f('#15181E')); R(c, x + 1, lb + l2 - 1, 3, 1, f('#15181E'));
    }
  }
  function drawEnt(c, e, time) {
    c.globalAlpha = Math.max(0, e.alpha);
    lanNow = e.minion ? e.look.lanyard || '#3E6BA8' : null;
    R(c, e.x - 6, e.y - 1, 12, 3, 'rgba(0,0,0,.22)');
    if (e.s?.status === 'working' || e.sub) glow(c, e.x, e.y - 10, e.sub ? e.cap : e.look.color, false);
    if (e.pose && !e.sub) drawPosed(c, e, time);
    else drawPerson(c, Math.round(e.x), Math.round(e.y), e.look, { walk: e.mode === 'walk', t: time + e.t0, dir: e.dir, blink: blink(time + e.t0), small: !!e.sub, lanyard: e.sub ? e.cap : null, cap: e.sub ? e.cap : null });
    if (e.owner) drawCrown(c, e, time);
    if (e.minion) { lanNow = null; if (e.carry && !e.pose) drawCarry(c, e, time); }
    if (e.s?.engine === 'codex' && !e.sub && e.pose !== 'sleep') { const px = Math.round(e.x) + 6, py = Math.round(e.y) - 28; R(c, px - 1, py - 1, 5, 5, P.ol); R(c, px, py, 3, 3, '#7C6CF0'); R(c, px, py, 1, 1, '#D9D4FF'); }
    c.globalAlpha = 1;
    lanNow = null;
    if (e.minion) hits.push({ x0: e.x - 8, y0: e.y - 24, x1: e.x + 8, y1: e.y + 2, minion: e.id });
    else if (!e.owner) hits.push({ x0: e.x - 8, y0: e.y - 24, x1: e.x + 8, y1: e.y + 2, sid: e.sub ? e.parent : e.sid, sub: e.sub ? e.sub.id : null });
  }
  // what a Magang carries (mail, folder, box, paper, book, cup, broom) or holds up (the "?" sign for an agent waiting on permission)
  const SIGN_Q = [[1, 0], [2, 0], [3, 0], [0, 1], [4, 1], [4, 2], [3, 3], [2, 3], [2, 4], [2, 6]];
  function drawCarry(c, e, time) {
    const k = e.carry, t = time + e.t0, bob = e.mode === 'walk' && Math.floor(t * 8) % 2 ? 1 : 0;
    const x = Math.round(e.x), y = Math.round(e.y) - bob, hx = x + (e.dir === 'left' ? -11 : 6), hy = y - 9;
    switch (k) {
      case 'mail': R(c, hx - 1, hy - 3, 9, 7, P.ol); R(c, hx, hy - 2, 7, 5, '#FDFCF2'); R(c, hx + 1, hy - 2, 1, 1, '#9AA3AF'); R(c, hx + 2, hy - 1, 1, 1, '#9AA3AF'); R(c, hx + 3, hy, 1, 1, '#9AA3AF'); R(c, hx + 4, hy - 1, 1, 1, '#9AA3AF'); R(c, hx + 5, hy - 2, 1, 1, '#9AA3AF'); R(c, hx + 5, hy + 1, 1, 1, '#C2413A'); break;
      case 'folder': R(c, hx - 1, hy - 4, 10, 9, P.ol); R(c, hx, hy - 3, 8, 7, '#E3A33A'); R(c, hx, hy - 3, 3, 1, '#C9922A'); R(c, hx + 1, hy - 1, 6, 1, '#FDFCF2'); R(c, hx + 1, hy + 1, 5, 1, '#FDFCF2'); break;
      case 'box': R(c, hx - 1, hy - 4, 10, 9, P.ol); R(c, hx, hy - 3, 8, 7, '#B5835A'); R(c, hx + 3, hy - 3, 2, 7, '#D9B58A'); R(c, hx, hy - 3, 8, 1, '#C99A6E'); break;
      case 'paper': R(c, hx - 1, hy - 4, 8, 9, P.ol); R(c, hx, hy - 3, 6, 7, '#FDFCF2'); R(c, hx + 1, hy - 2, 4, 1, '#9AA3AF'); R(c, hx + 1, hy, 4, 1, '#9AA3AF'); R(c, hx + 1, hy + 2, 3, 1, '#9AA3AF'); break;
      case 'book': R(c, hx - 1, hy - 4, 8, 9, P.ol); R(c, hx, hy - 3, 6, 7, '#3E6BA8'); R(c, hx, hy - 3, 1, 7, '#2C4F80'); R(c, hx + 2, hy - 2, 3, 1, '#F2CF72'); break;
      case 'cup': { const lift = Math.floor(t * 3) % 4 === 0 ? 1 : 0; R(c, hx - 1, hy - 1, 6, 6, P.ol); R(c, hx, hy, 4, 4, '#FDFCF2'); R(c, hx + 1, hy + 1, 2, 1, '#6B4A2E'); R(c, hx + 1 + lift, hy - 3, 1, 2, 'rgba(255,255,255,.7)'); break; }
      case 'broom': R(c, hx - 1, hy - 14, 3, 20, P.ol); R(c, hx, hy - 13, 1, 15, '#8B6B3E'); R(c, hx - 2, hy + 2, 6, 5, P.ol); R(c, hx - 1, hy + 3, 4, 3, '#E2B04A'); R(c, hx - 1, hy + 5, 4, 1, '#B98A2E'); break;
      case 'clip': R(c, hx - 1, hy - 4, 9, 10, P.ol); R(c, hx, hy - 3, 7, 8, '#B5835A'); R(c, hx + 1, hy - 2, 5, 6, '#FDFCF2'); R(c, hx + 2, hy - 4, 3, 2, '#9AA3AF'); R(c, hx + 2, hy, 3, 1, '#9AA3AF'); R(c, hx + 2, hy + 2, 2, 1, '#C2413A'); break;
      case 'sign': {
        const sx = x + 7, top = y - 44, bx = sx - 4, up = Math.floor(t * 2) % 2;
        R(c, sx - 1, top + 9 + up, 3, 28 - up, P.ol); R(c, sx, top + 10 + up, 1, 27 - up, '#8B6B3E');
        R(c, bx - 1, top - 1 + up, 11, 12, P.ol); R(c, bx, top + up, 9, 10, '#F5C84C');
        for (const [qx, qy] of SIGN_Q) R(c, bx + 2 + qx, top + 1 + qy + up, 1, 1, '#3A240F');
        break;
      }
    }
  }
  // a small gold crown over the owner's head (standing, walking, sitting, reading, playing)
  function drawCrown(c, e, time) {
    if (e.pose === 'sleep' || e.pose === 'pray') return;
    const x = Math.round(e.x), sit = e.pose === 'sit', bob = e.mode === 'walk' && Math.floor((time + e.t0) * 8) % 2 ? 1 : 0;
    const top = Math.round(e.y) + (sit ? 3 : 0) - (sit ? 0 : 4) - 6 - 10 - bob - (e.pose === 'exercise' ? Math.round(Math.abs(Math.sin((time + e.t0) * 7)) * 2) : 0) - (e.look.hairStyle === 'bun' ? 4 : 0);
    const y = top - 4;
    R(c, x - 5, y + 1, 10, 4, P.ol); R(c, x - 5, y - 1, 2, 2, P.ol); R(c, x - 1, y - 2, 2, 3, P.ol); R(c, x + 3, y - 1, 2, 2, P.ol);
    R(c, x - 4, y + 2, 8, 2, '#F5C84C'); R(c, x - 4, y, 1, 2, '#F5C84C'); R(c, x, y - 1, 1, 3, '#F5C84C'); R(c, x + 3, y, 1, 2, '#F5C84C');
    R(c, x - 1, y + 2, 2, 1, '#E5655D'); R(c, x - 4, y + 3, 8, 1, '#C9922A');
  }
  /* ---------- poses at furniture spots (sit / sleep / pray / play / exercise / read / stand with props) ---------- */
  const WAVE = new Set(['whiteboard', 'wudhu', 'game', 'play', 'music', 'plant', 'train']), TYPING = new Set(['type', 'test', 'server', 'game', 'play', 'think']), SIPS = new Set(['coffee', 'water', 'eat', 'snack']);
  function drawPosed(c, e, time) {
    const x = Math.round(e.x), y = Math.round(e.y), t = time + e.t0, bl = blink(t), look = e.look, fx = e.fx, p = e.pose, dir = e.dir;
    switch (p) {
      case 'sit': drawPerson(c, x, y + 3, look, { sit: true, t, typing: TYPING.has(fx), blink: bl, dir }); break;
      case 'sleep': {
        const right = dir !== 'left';
        c.save(); c.translate(x + (right ? -9 : 9), y - 3); c.rotate(right ? Math.PI / 2 : -Math.PI / 2);
        drawPerson(c, 0, 0, look, { t, dir: 'down', blink: true }); c.restore(); break;
      }
      case 'pray': {
        const ph = prayPhase((performance.now() - e.poseAt) / 1000), d = dir === 'down' || !dir ? 'up' : dir;
        if (ph === 'berdiri') drawPerson(c, x, y, look, { t, dir: d, blink: false });
        else if (ph === 'duduk') drawPerson(c, x, y + 3, look, { sit: true, t, dir: d, blink: false });
        else { c.save(); c.translate(x, y); c.scale(1, ph === 'ruku' ? .68 : .42); drawPerson(c, 0, 0, look, { sit: ph === 'sujud', t, dir: d, blink: false }); c.restore(); }
        break;
      }
      case 'exercise': drawPerson(c, x, y - Math.round(Math.abs(Math.sin(t * 7)) * 2), look, { t, dir, blink: bl, wave: true, armsUp: true }); break;
      case 'play': drawPerson(c, x, y, look, { t, dir, blink: bl, wave: true }); break;
      case 'read': {
        drawPerson(c, x, y, look, { t, dir, blink: bl });
        if (dir !== 'up') { R(c, x - 4, y - 12, 8, 6, P.ol); R(c, x - 3, y - 11, 6, 4, '#F4EFE0'); R(c, x, y - 11, 1, 4, '#B9B2A0'); R(c, x - 3, y - 11, 6, 1, '#3E6BA8'); }
        break;
      }
      default: {
        const lift = Math.floor(t * 1.4) % 3 === 0;
        drawPerson(c, x, y, look, { t, dir, blink: bl, wave: WAVE.has(fx), armsUp: fx === 'whiteboard' });
        if (SIPS.has(fx)) { R(c, x + 4, y - (lift ? 15 : 9), 4, 4, P.ol); R(c, x + 5, y - (lift ? 14 : 8), 2, 2, fx === 'water' ? '#8EC6EA' : '#E8E2D0'); }
        if (fx === 'phone') { R(c, x + 4, y - 19, 3, 5, P.ol); R(c, x + 5, y - 18, 1, 3, '#7FD3C9'); }
        if (e.minion && fx === 'plant') { const k = Math.floor(t * 4) % 3; R(c, x + 3, y - 14, 6, 5, P.ol); R(c, x + 4, y - 13, 4, 3, '#6FA8DC'); R(c, x + 9, y - 13, 2, 1, '#6FA8DC'); R(c, x + 11, y - 11 + k, 1, 1, '#BFE3F5'); R(c, x + 12, y - 8 + k, 1, 1, '#8EC6EA'); }
        if (e.minion && fx === 'print') { R(c, x + 4, y - 14, 7, 8, P.ol); R(c, x + 5, y - 13, 5, 6, '#FDFCF2'); R(c, x + 6, y - 11, 3, 1, '#9AA3AF'); R(c, x + 6, y - 9, 3, 1, '#9AA3AF'); }
        if (fx === 'wudhu') { const k = Math.floor(t * 5) % 3; R(c, x - 1 + k, y - 8 + k, 1, 2, '#8EC6EA'); R(c, x + 3 - k, y - 6 + k, 1, 1, '#BFE3F5'); }
      }
    }
  }
  const zPix = (c, x, y, s, col) => { R(c, x, y, s, 1, col); R(c, x + s - 1, y + 1, 1, s - 2 > 0 ? s - 2 : 1, col); R(c, x, y + s - 1, s, 1, col); };
  // things floating over characters: sleeping "z", chat dots
  function drawOverlays(c, time) {
    const now = performance.now();
    for (const e of ents.values()) {
      if (e.alpha <= 0 || e.sub) continue;
      const sit = e.mode === 'sit' && e.desk, hx = sit ? e.desk.seat.x : e.x, hy = sit ? (e.desk.facing === 'down' ? e.desk.ty * T - 22 : e.desk.seat.y - 28) : e.y - 28;
      if (e.pose && e.fx === 'sleep') {
        const base = e.dir === 'left' ? -10 : 10;
        for (let k = 0; k < 3; k++) { const ph = (time * .5 + k / 3) % 1, s = 3 + (k > 0 ? 1 : 0); c.globalAlpha = Math.min(1, ph * 5) * (1 - ph * ph) * e.alpha; zPix(c, Math.round(e.x + base + k * 3 + Math.sin(ph * 5 + k) * 1.5), Math.round(e.y - 14 - ph * 16), s, '#FBF4EA'); }
        c.globalAlpha = 1;
      }
      if (e.talkUntil > now) {
        const bx = Math.round(hx) - 7, by = Math.round(hy) - 6, n = Math.floor((time + (e.talkSeed || 0)) * 3) % 4;
        R(c, bx - 1, by - 1, 15, 9, P.ol); R(c, bx, by, 13, 7, '#FDFCF2'); R(c, bx + 4, by + 8, 3, 2, P.ol); R(c, bx + 5, by + 7, 1, 2, '#FDFCF2');
        for (let k = 0; k < 3; k++) R(c, bx + 2 + k * 4, by + 3 - (k === n - 1 ? 1 : 0), 2, 2, '#1F1628');
      }
    }
  }
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  const PIX = '"Silkscreen", "Pixelify Sans", ui-monospace, monospace';
  const MONO = '"JetBrains Mono", ui-monospace, monospace';
  function drawLabels(c, time) {
    const z = cam.z, Sx = (wx, wy) => [(wx - cam.x) * z, (wy - cam.y) * z];
    c.textBaseline = 'middle';
    // the layout editor draws its own room plates
    if (!editing) for (const r of plan.rooms) {
      if (r.kind === 'openplan') continue;
      let wx, wy;
      if (r.kind === 'zone') { const op = plan.rooms.find(q => q.id === r.zoneOf); wx = (r.x + 1) * T; wy = (op.y + WH) * T + 2; } else { wx = r.x * T + 10; wy = r.y * T + 8; }
      const [sx, sy] = Sx(wx, wy); if (sx > canvas._w || sy > canvas._h || sx < -220 || sy < -40) continue;
      const fs = z < 1.2 ? 8 : 10;
      c.font = `700 ${fs}px ${PIX}`;
      // Keep the plate inside its room: drop the path first, then shorten the name, so neighbours never overlap.
      const maxW = r.kind === 'zone' || !r.w ? Infinity : (r.w * T - 14) * z - 12;
      let name = r.name.toUpperCase(), sub = z >= 1.6 && r.path ? r.path + '/' : '';
      let w1 = c.measureText(name).width;
      c.font = `500 ${fs}px ${MONO}`;
      let w2 = sub ? c.measureText(sub).width + 8 : 0;
      if (w1 + w2 > maxW) { sub = ''; w2 = 0; }
      if (w1 > maxW) {
        c.font = `700 ${fs}px ${PIX}`;
        while (name.length > 3 && c.measureText(name + '…').width > maxW) name = name.slice(0, -1);
        name = name.trimEnd() + '…'; w1 = c.measureText(name).width;
      }
      c.fillStyle = sel === r.id ? 'rgba(245,154,60,.95)' : r.kind === 'server' ? 'rgba(150,40,40,.88)' : 'rgba(31,22,40,.78)';
      rr(c, sx, sy, w1 + w2 + 12, fs + 8, 4); c.fill();
      c.fillStyle = sel === r.id ? '#3A240F' : '#FBF4EA'; c.font = `700 ${fs}px ${PIX}`; c.fillText(name, sx + 6, sy + (fs + 8) / 2 + .5);
      if (sub) { c.fillStyle = sel === r.id ? '#3A240F' : '#B8AEBF'; c.font = `500 ${fs}px ${MONO}`; c.fillText(sub, sx + 6 + w1 + 8, sy + (fs + 8) / 2 + .5); }
    }
    if (z >= .7) for (const wg of plan.wings || []) { const [sx, sy] = Sx(wg.x * T, wg.y * T); c.font = `700 ${z < 1.4 ? 8 : 10}px ${PIX}`; c.fillStyle = 'rgba(251,244,234,.7)'; c.fillText(wg.t.toUpperCase(), sx, sy); }
    for (const e of ents.values()) {
      if (e.alpha <= 0 || editing) continue;
      const sit = e.mode === 'sit' && e.desk;
      const fx = sit ? e.desk.seat.x : e.x, fy = sit ? (e.desk.facing === 'down' ? e.desk.ty * T + 2 * T + 2 : e.desk.seat.y + 2) : e.y + 2;
      const headY = sit ? (e.desk.facing === 'down' ? e.desk.ty * T - 20 : e.desk.seat.y - 24) : e.y - 26;
      const [sx, sy] = Sx(fx, fy), [, hy] = Sx(fx, headY);
      if (sx < -150 || sx > canvas._w + 150 || sy < -80 || sy > canvas._h + 60) continue;
      if (e.minion && z >= 1.5) { // Magang: orange "MAGANG" tag + first name
        c.font = `700 8px ${PIX}`; c.textAlign = 'center';
        const nm = e.name || '', tw = c.measureText(nm).width, bw = c.measureText('MAGANG').width + 8;
        c.fillStyle = 'rgba(31,22,40,.9)'; rr(c, sx - (tw + bw + 6) / 2, sy + 1, tw + bw + 6, 13, 3); c.fill();
        c.fillStyle = '#F2842B'; rr(c, sx - (tw + bw + 6) / 2 + 1, sy + 2, bw, 11, 2); c.fill();
        c.fillStyle = '#3A1E08'; c.fillText('MAGANG', sx - (tw + bw + 6) / 2 + 1 + bw / 2, sy + 8.5);
        c.fillStyle = '#FBF4EA'; c.fillText(nm, sx - (tw + bw + 6) / 2 + bw + 4 + tw / 2, sy + 8.5); c.textAlign = 'left';
      } else if (z >= 1.2 && !e.minion) { // name tag under the feet
        const fs = e.sub ? 8 : 10;
        c.font = `700 ${fs}px ${PIX}`; c.textAlign = 'center';
        const label = e.name || '', tw = c.measureText(label).width;
        c.fillStyle = e.owner ? 'rgba(245,200,76,.98)' : e.mgr ? 'rgba(245,154,60,.97)' : 'rgba(31,22,40,.9)';
        rr(c, sx - tw / 2 - 5, sy + 1, tw + 10, fs + 6, 3); c.fill();
        c.fillStyle = e.owner || e.mgr ? '#3A240F' : e.sub ? '#CDEDEA' : e.manual ? '#BFE5E8' : '#FBF4EA';
        c.fillText(label, sx, sy + 1 + (fs + 6) / 2 + .5); c.textAlign = 'left';
        if (e.s?.engine === 'codex' && !e.sub) { // "CX" badge untuk sesi Codex
          c.font = `700 7px ${PIX}`; const bw = c.measureText('CX').width + 6, bx = sx + tw / 2 + 7;
          c.fillStyle = '#3B3490'; rr(c, bx, sy + 3, bw, 11, 3); c.fill(); c.fillStyle = '#D9D4FF'; c.fillText('CX', bx + 3, sy + 9);
        } else if (e.owner) { // "OWNER" badge right of the name
          c.font = `700 7px ${PIX}`; const bw = c.measureText('OWNER').width + 6, bx = sx + tw / 2 + 7;
          c.fillStyle = '#3A240F'; rr(c, bx, sy + 3, bw, 11, 3); c.fill(); c.fillStyle = '#F5C84C'; c.fillText('OWNER', bx + 3, sy + 9);
        }
      }
      const say = e.say && e.say.until > performance.now() ? e.say.text : '';
      const text = say || (e.mode === 'walk' && e.goingTo && !e.sub ? `> menuju ${e.goingTo}` : e.bubble);
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

  function destroy() { if (destroyed) return; destroyed = true; cancelAnimationFrame(raf); clearInterval(fadeTimer); ro.disconnect(); stage?.ownerCtl?.destroy(); }

  const fitHost = () => { if (opts.fill) return; host.style.height = 'auto'; host.style.aspectRatio = `${plan.w} / ${plan.h}`; host.style.maxHeight = '82vh'; };
  fitHost();
  build(); fitCanvas(); fitAll(true);
  const furnReady = loadCatalog().then(() => { if (!destroyed) applyFurniture(); return getCatalog().items; });
  sync(opts.sessions || []);
  opts.animateArrivals = true;
  raf = requestAnimationFrame(frame);
  stage = {
    sync, minions,
    setCards(c) { cards = c; if (world) buildBg(); },
    // keepCam: leave the camera alone (the layout editor rebuilds while dragging)
    rebuild(p, r, o = {}) { plan = p; roles = r; fitHost(); const keep = sessions, owners = [...ents.values()].filter(e => e.owner); ents.clear(); build(); for (const e of owners) { e.q = []; e.cur = null; e.path = []; e.pose = null; ents.set(e.id, e); } fitCanvas(); if (o.keepCam) clamp(cam); else if (focus) focusRoom(focus, true); else fitAll(true); opts.animateArrivals = false; sync(keep); opts.animateArrivals = true; minions.rebuild(); },
    focusRoom, fitAll: () => fitAll(), zoomBy,
    setInsets(v) { ins = { ...ins, ...v }; if (focus) focusRoom(focus); else fitAll(); }, get insets() { return { ...ins }; }, get focus() { return focus; }, select(id) { sel = id; },
    // balloon over a meeting participant while they speak; empty text clears it
    speak(roleId, text) { for (const e of ents.values()) if (!e.sub && e.s?.role === roleId && e.s.kind === 'rapat') e.say = text ? { text, until: performance.now() + 20000 } : null; },
    // small envelope balloon over an agent while a direct message passes; ms = how long it stays
    dmBalloon(roleId, text, ms = 3000) { for (const e of ents.values()) if (!e.sub && e.s?.role === roleId && e.s.kind !== 'rapat') e.say = { text, until: performance.now() + ms }; },
    destroy,
    /* layout editor: camera maths + switch off picking/panning/characters */
    setEditing(on) { editing = !!on; if (editing) { focus = null; down = null; nav.stop(); canvas.classList.remove('grabbing', 'hot'); } camSig = ''; },
    get editing() { return editing; },
    toScreen: (tx, ty) => [(tx * T - cam.x) * cam.z, (ty * T - cam.y) * cam.z],           // tile -> px inside the host
    toTile: (clientX, clientY) => { const r = canvas.getBoundingClientRect(); return { x: ((clientX - r.left) / cam.z + cam.x) / T, y: ((clientY - r.top) / cam.z + cam.y) / T }; },
    scale: () => cam.z * T,                                                                 // screen px per tile
    panBy, touchNav,
    /* ---- furniture API (layout editor) ----
       furnitureCatalog(): items of the loaded catalog ([] until furnitureReady resolves; also fires onFurniture).
       world: live read-only view {W,H,walk,inRoom,rooms,desks,seat,furniture} (walk = Uint8Array, 1 = free tile incl. placed furniture).
       setFurniture(list): live preview of [{uid,item,x,y}] (absolute tiles) without reload; plan.furniture is used on build/rebuild.
       freeSpotsIn(roomId): free walkable tiles [{tx,ty}] inside the room's interior; furnitureSpotsIn(roomId): free activity spots of placed items.
       reloadFurniture(): refetch catalog (new version) and re-place. */
    furnitureCatalog: () => getCatalog().items,
    get furnitureReady() { return furnReady; },
    get world() { return world && { W: world.W, H: world.H, walk: world.walk, inRoom: world.inRoom, rooms: world.rooms, desks: world.desks, seat: world.seat, furniture: engine.insts }; },
    setFurniture: list => applyFurniture(list),
    reloadFurniture: () => loadCatalog(true).then(() => applyFurniture()),
    freeSpotsIn(id) {
      const rc = roomRect(id), out = []; if (!rc) return out;
      for (let y = rc.y0; y <= rc.y1; y++) for (let x = rc.x0; x <= rc.x1; x++) if (world.walk[y * world.W + x] && !world.seat.has(y * world.W + x)) out.push({ tx: x, ty: y });
      return out;
    },
    furnitureSpotsIn: id => engine.freeSpots(id),
    // snapshot of every agent's activity (tests / debugging)
    agents: () => [...ents.values()].filter(e => !e.sub).map(e => ({ id: e.id, minion: !!e.minion, place: e.place, aff: e.act?.aff || null, phase: e.act?.phase || null, src: e.act?.src || null, item: e.act?.inst?.def.id || null, pose: e.pose || null, mode: e.mode, tx: Math.floor(e.x / T), ty: Math.floor(e.y / T), talk: (e.talkUntil || 0) > performance.now() })),
    onFrame(fn) { frameCbs.add(fn); camSig = ''; return () => frameCbs.delete(fn); },       // called when camera/size changed
    /* ---- owner avatar (owner.js): internals it drives ---- */
    owner: {
      T, WH, get world() { return world; }, get plan() { return plan; }, get roles() { return roles; }, get sessions() { return sessions; }, get engine() { return engine; },
      ents, findPath, nearestWalk, lookOf: s => lookOf(s), nameOf: s => nameOf(s), host, canvas,
      walkable: (tx, ty) => tx >= 0 && ty >= 0 && tx < world.W && ty < world.H && !!world.walk[ty * world.W + tx],
      roomAt: (tx, ty) => { if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return null; const z = plan.rooms.find(r => r.kind === 'zone' && tx >= r.x && tx < r.x + r.w && plan.rooms.find(q => q.id === r.zoneOf && ty >= q.y && ty < q.y + q.h)); if (z) return z.id; const i = world.inRoom[ty * world.W + tx]; return i >= 0 ? world.rooms[i].id : null; },
      spawn: (id, look) => { const e = spawnEnt(id, look, true); e.owner = true; return e; },
      screenToWorld: (sx, sy) => ({ x: cam.x + sx / cam.z, y: cam.y + sy / cam.z }),
      worldToScreen: (wx, wy) => [(wx - cam.x) * cam.z, (wy - cam.y) * cam.z],
      get zoom() { return cam.tz; }, get lastPan() { return lastPan; }, get editing() { return editing; },
      centerOn(wx, wy, z, instant) { if (z) cam.tz = Math.max(.4, Math.min(6, z)); cam.tx = wx - (ins.left + visW() / 2) / cam.tz; cam.ty = wy - (ins.top + visH() / 2) / cam.tz; clamp(cam); focus = null; if (instant) Object.assign(cam, { x: cam.tx, y: cam.ty, z: cam.tz }); },
      openElevator: ms => { world.elevator.until = performance.now() + (ms || 1500); },
      setTap(fn) { ownerTap = fn; }, onTick(fn) { tickCbs.add(fn); return () => tickCbs.delete(fn); },
    },
  };
  if (opts.fill) stage.ownerCtl = attachOwner(stage);
  return stage;
}
