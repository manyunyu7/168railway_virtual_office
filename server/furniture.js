// Furniture catalog (server/furniture/*.json) + behavior rules (behaviors.json), loaded and validated
// defensively: a broken item is logged and skipped, never fatal. Reloads itself when a file changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR } from './config.js';

export const AFFORDANCES = ['type', 'read', 'whiteboard', 'print', 'phone', 'test', 'server', 'meeting', 'think', 'coffee', 'water', 'eat', 'snack', 'sit', 'sofa', 'sleep', 'chat', 'play', 'game', 'music', 'exercise', 'pray', 'wudhu', 'plant', 'train', 'decor'];
export const POSES = ['stand', 'sit', 'sleep', 'pray', 'play', 'exercise', 'read'];
export const FACES = ['up', 'down', 'left', 'right'];
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const MAX_TILES = 40, MAX_SPRITE_H = 160;

export const FURNITURE_DIR = process.env.KANTOR_FURNITURE_DIR || path.join(ROOT_DIR, 'server', 'furniture');
const BEHAVIORS_FILE = 'behaviors.json';
const SCENES_FILE = 'scenes.json';   // adegan Magang per ruangan (docs/FRONTEND-CONTRACT.md, bagian Magang)

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Check a frame's rows against the sprite size/palette. Returns an error string or null. */
function rowsProblem(rows, w, h, palette, what) {
  if (!Array.isArray(rows) || rows.length !== h) return `${what}: harus ${h} baris`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r !== 'string' || r.length !== w) return `${what}: baris ${i} harus ${w} karakter`;
    for (const c of r) if (c !== '.' && !(c in palette)) return `${what}: baris ${i} memakai '${c}' yang tak ada di palette`;
  }
  return null;
}

/** Validate one raw item. Returns { item } (normalized) or { error }. */
export function validateItem(raw) {
  const bad = error => ({ error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('bukan objek');
  const { id, name, cat, w, h, sprite } = raw;
  if (typeof id !== 'string' || !ID.test(id)) return bad('id tidak valid (huruf, angka, - atau _)');
  if (typeof name !== 'string' || !name.trim()) return bad('name kosong');
  if (typeof cat !== 'string' || !cat.trim()) return bad('cat kosong');
  if (!int(w, 1, MAX_TILES) || !int(h, 1, MAX_TILES)) return bad(`w/h harus bilangan bulat 1..${MAX_TILES}`);
  if (!sprite || typeof sprite !== 'object') return bad('sprite hilang');
  if (sprite.w !== w * 8) return bad(`sprite.w harus ${w * 8} (w*8)`);
  if (!int(sprite.h, 1, MAX_SPRITE_H) || sprite.h < 1) return bad('sprite.h tidak valid');
  const palette = sprite.palette;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) return bad('palette hilang');
  for (const [k, v] of Object.entries(palette)) {
    if (k.length !== 1 || k === '.') return bad(`kunci palette '${k}' harus satu karakter selain '.'`);
    if (typeof v !== 'string' || !COLOR.test(v)) return bad(`warna palette '${k}' tidak valid`);
  }
  let e = rowsProblem(sprite.rows, sprite.w, sprite.h, palette, 'sprite');
  if (e) return bad(e);
  let frames;
  if (raw.frames !== undefined) {
    if (!Array.isArray(raw.frames) || !raw.frames.length) return bad('frames harus array tak kosong');
    frames = [];
    for (let i = 0; i < raw.frames.length; i++) {
      e = rowsProblem(raw.frames[i]?.rows, sprite.w, sprite.h, palette, `frames[${i}]`);
      if (e) return bad(e);
      frames.push({ rows: raw.frames[i].rows });
    }
  }
  const fps = raw.fps === undefined ? (frames ? 2 : undefined) : raw.fps;
  if (fps !== undefined && !(typeof fps === 'number' && fps > 0 && fps <= 30)) return bad('fps harus 0..30');
  let active;
  if (raw.active !== undefined) {
    e = rowsProblem(raw.active?.rows, sprite.w, sprite.h, palette, 'active');
    if (e) return bad(e);
    active = { rows: raw.active.rows };
  }
  const affords = raw.affords === undefined ? [] : raw.affords;
  if (!Array.isArray(affords) || affords.some(a => !AFFORDANCES.includes(a))) return bad(`affords harus subset dari daftar tetap (${[].concat(affords).filter(a => !AFFORDANCES.includes(a)).join(', ')})`);
  const spots = raw.spots === undefined ? [] : raw.spots;
  if (!Array.isArray(spots)) return bad('spots harus array');
  for (const s of spots) {
    if (!s || !int(s.dx, -3, w + 2) || !int(s.dy, -3, h + 2)) return bad('spot dx/dy harus bilangan bulat dekat footprint');
    if (!POSES.includes(s.pose)) return bad(`spot pose '${s.pose}' tak dikenal`);
    if (s.face !== undefined && !FACES.includes(s.face)) return bad(`spot face '${s.face}' tak dikenal`);
  }
  const rooms = raw.rooms === undefined ? [] : raw.rooms;
  if (!Array.isArray(rooms) || rooms.some(r => typeof r !== 'string')) return bad('rooms harus array string');
  const weight = raw.weight === undefined ? 1 : raw.weight;
  if (!(typeof weight === 'number' && weight >= 0 && weight <= 1000)) return bad('weight harus angka >= 0');
  const item = {
    id, name: name.trim(), cat: cat.trim(), w, h,
    sprite: { w: sprite.w, h: sprite.h, palette: { ...palette }, rows: [...sprite.rows] },
    ...(frames ? { frames, fps } : {}), ...(active ? { active } : {}),
    solid: raw.solid === undefined ? true : !!raw.solid, wall: !!raw.wall,
    affords: [...new Set(affords)],
    spots: spots.map(s => ({ dx: s.dx, dy: s.dy, pose: s.pose, face: s.face || 'down' })),
    rooms: [...new Set(rooms)], weight,
  };
  return { item };
}

/* ---------------- loader ---------------- */
let state = null; // { sig, at, items, byId, behaviors, version, problems }
let lastCheck = 0;
const CHECK_MS = 1000;
let logger = (...a) => console.warn('[furniture]', ...a);
export function setLogger(fn) { logger = fn || (() => {}); }

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
}
function signature(dir) {
  return listFiles(dir).map(f => { try { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('|');
}

function loadFromDisk(dir) {
  const problems = [], items = [], byId = new Map();
  const hash = crypto.createHash('sha1');
  let behaviors = null, scenes = [];
  const note = (file, id, msg) => { problems.push({ file, id: id || null, error: msg }); logger(`${file}${id ? ` [${id}]` : ''}: ${msg}`); };
  for (const f of listFiles(dir)) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { note(f, null, `tak terbaca: ${e.message}`); continue; }
    hash.update(f).update(text);
    let data;
    try { data = JSON.parse(text); } catch (e) { note(f, null, `JSON rusak: ${e.message}`); continue; }
    if (f === BEHAVIORS_FILE) { behaviors = data; continue; }
    if (f === SCENES_FILE) { const c = checkScenes(data); scenes = c.scenes; for (const m of c.problems) note(f, null, m); continue; }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!arr) { note(f, null, 'harus array item atau {items:[…]}'); continue; }
    for (const raw of arr) {
      const { item, error } = validateItem(raw);
      if (error) { note(f, raw?.id, error); continue; }
      if (byId.has(item.id)) { note(f, item.id, `id dobel (sudah ada di ${byId.get(item.id).file})`); continue; }
      item.file = f;
      byId.set(item.id, item);
      items.push(item);
    }
  }
  const checked = validateBehaviors(behaviors);
  for (const p of checked.problems) note(BEHAVIORS_FILE, null, p);
  const version = hash.digest('hex').slice(0, 12);
  // `file` is bookkeeping, not part of the public item
  for (const it of items) delete it.file;
  const pub = new Map(items.map(i => [i.id, i]));
  return { items, byId: pub, behaviors: checked.behaviors, scenes, version, problems };
}

/** The current catalog; re-reads the folder when any file changed (checked at most once a second). */
export function furniture({ dir = FURNITURE_DIR } = {}) {
  const now = Date.now();
  if (state && state.dir === dir && now - lastCheck < CHECK_MS) return state;
  lastCheck = now;
  const sig = signature(dir);
  if (!state || state.dir !== dir || state.sig !== sig) state = { dir, sig, ...loadFromDisk(dir) };
  return state;
}
export function reloadFurniture(opts) { state = null; lastCheck = 0; return furniture(opts); }
export const getItem = id => furniture().byId.get(id) || null;
export function catalog() {
  const f = furniture();
  return { items: f.items, behaviors: f.behaviors, scenes: f.scenes, version: f.version, ...(f.problems.length ? { problems: f.problems } : {}) };
}

/* ---------------- scenes (Magang) ---------------- */
/** scenes.json = {version, scenes:[{id, rooms:[kind|id], weight?, hourWeights?, actors?:[min,max], steps:[…]}]}. Bad scenes are dropped with a problem. */
export function checkScenes(data) {
  const problems = [], scenes = [], ids = new Set();
  const list = Array.isArray(data?.scenes) ? data.scenes : null;
  if (!list) return { scenes, problems: ['scenes.json harus {scenes:[…]}'] };
  for (const sc of list) {
    const id = sc?.id;
    if (typeof id !== 'string' || !id) { problems.push('adegan tanpa id'); continue; }
    if (ids.has(id)) { problems.push(`adegan ${id}: id dobel`); continue; }
    if (!Array.isArray(sc.rooms) || !sc.rooms.length || !sc.rooms.every(r => typeof r === 'string')) { problems.push(`adegan ${id}: rooms harus array string`); continue; }
    if (!Array.isArray(sc.steps) || !sc.steps.length || !sc.steps.every(st => st && typeof st === 'object')) { problems.push(`adegan ${id}: steps kosong/tidak valid`); continue; }
    ids.add(id); scenes.push(sc);
  }
  return { scenes, problems };
}

/* ---------------- behaviors ---------------- */
const WHEN_KEYS = ['status', 'tools', 'bash', 'label', 'subagent', 'thinking', 'idleMin', 'neighbor', 'prayer'];
/** Soft validation: drop rules that can't work, keep the rest. Missing file → built-in empty rules. */
export function validateBehaviors(b) {
  const problems = [];
  const out = { version: 1, rules: [], fallback: [], prayer: { windowMin: 20, names: ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'], steps: [{ a: 'wudhu', dwell: [25, 50] }, { a: 'pray', dwell: [90, 180] }] }, idle: { stages: [] }, chat: { distance: 6, minIdleSec: 20 } };
  if (b === null || b === undefined) { problems.push('behaviors.json tidak ada'); return { behaviors: out, problems }; }
  if (typeof b !== 'object' || Array.isArray(b)) { problems.push('behaviors.json harus objek'); return { behaviors: out, problems }; }
  const dwellOk = d => Array.isArray(d) && d.length === 2 && d.every(n => typeof n === 'number' && n >= 0) && d[0] <= d[1];
  const picksOk = p => Array.isArray(p) && p.length > 0 && p.every(x => AFFORDANCES.includes(x?.a) && (x.w === undefined || (typeof x.w === 'number' && x.w >= 0)));
  const clean = (r, where) => {
    if (!r || typeof r !== 'object') { problems.push(`${where}: bukan objek`); return null; }
    if (!picksOk(r.pick)) { problems.push(`${where}: pick harus array {a,w} dengan affordance dikenal`); return null; }
    if (!dwellOk(r.dwell)) { problems.push(`${where}: dwell harus [minDetik, maxDetik]`); return null; }
    for (const k of Object.keys(r.when || {})) if (!WHEN_KEYS.includes(k)) { problems.push(`${where}: kunci when '${k}' tak dikenal`); return null; }
    for (const k of ['bash', 'label']) if (r.when?.[k]) { try { new RegExp(r.when[k], 'i'); } catch { problems.push(`${where}: regex ${k} rusak`); return null; } }
    if (r.when?.idleMin && !(Array.isArray(r.when.idleMin) && r.when.idleMin.length === 2)) { problems.push(`${where}: idleMin harus [dari, sampai) menit (sampai boleh null)`); return null; }
    return { id: r.id || where, when: r.when || {}, chance: typeof r.chance === 'number' ? r.chance : 1, pick: r.pick.map(x => ({ a: x.a, w: x.w ?? 1 })), dwell: r.dwell, ...(r.then ? { then: r.then } : {}) };
  };
  (Array.isArray(b.rules) ? b.rules : []).forEach((r, i) => { const c = clean(r, `rules[${i}]`); if (c) out.rules.push(c); });
  (Array.isArray(b.fallback) ? b.fallback : []).forEach((r, i) => { const c = clean(r, `fallback[${i}]`); if (c) out.fallback.push(c); });
  if (b.prayer && typeof b.prayer === 'object') out.prayer = { ...out.prayer, ...b.prayer };
  if (b.chat && typeof b.chat === 'object') out.chat = { ...out.chat, ...b.chat };
  if (typeof b.version === 'number') out.version = b.version;
  if (b.notes) out.notes = b.notes;
  return { behaviors: out, problems };
}

/* ---------------- placement per office ---------------- */
/**
 * Check a placed-furniture list against the catalog and the plan. Returns { items, problems }:
 * items are normalized {uid,item,x,y}; problems list every refused entry (used to reject a PUT).
 * x,y are absolute tiles of the footprint's top-left; the footprint must lie inside the plan.
 */
export function checkPlaced(list, plan) {
  const problems = [], items = [], uids = new Set();
  if (!Array.isArray(list)) return { items, problems: ['items harus array'] };
  if (list.length > 2000) problems.push('terlalu banyak perabot (maks 2000)');
  const cat = furniture().byId;
  list.forEach((p, i) => {
    const at = `perabot #${i + 1}`;
    if (!p || typeof p !== 'object') { problems.push(`${at}: bukan objek`); return; }
    const def = cat.get(p.item);
    if (!def) { problems.push(`${at}: item '${p.item}' tidak dikenal`); return; }
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) { problems.push(`${at} (${def.name}): x,y harus bilangan bulat`); return; }
    if (p.x < 0 || p.y < 0 || p.x + def.w > plan.w || p.y + def.h > plan.h) { problems.push(`${at} (${def.name}): keluar dari batas denah`); return; }
    let uid = typeof p.uid === 'string' && /^[\w-]{1,40}$/.test(p.uid) ? p.uid : null;
    if (!uid) { let n = i + 1; do uid = `f${n++}`; while (uids.has(uid)); }
    if (uids.has(uid)) { problems.push(`${at}: uid '${uid}' dobel`); return; }
    uids.add(uid);
    items.push({ uid, item: def.id, x: p.x, y: p.y });
  });
  return { items, problems };
}
