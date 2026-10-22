// The office owner as a character on the floor plan: where they stand in each office (memory only) and how they look (global).
// A client that "enters" the office PUTs its position (throttled while walking, a heartbeat while standing);
// without an update for PRESENT_MS the owner leaves by themselves.
import { globalDb, one, run } from './db.js';
import { bus } from './live.js';

export const PRESENT_MS = 2 * 60e3;
const FACES = ['up', 'down', 'left', 'right'];
const POSES = ['stand', 'sit', 'sleep', 'pray', 'play', 'exercise', 'read'];
const STYLES = ['short', 'long', 'ponytail', 'bob', 'bun', 'pigtails', 'curly', 'hijab'];
const OUTFITS = ['kemeja', 'rok', 'dress', 'hoodie', 'jas'];
const ACCS = ['', 'kacamata', 'anting', 'topi'];
export const DEFAULT_LOOK = { color: '#C9A15A', hair: '#2B1D14', skin: '#D9A47C', hairStyle: 'short', outfit: 'jas', acc: '', hijab: null, crown: true };

const pos = new Map();   // office -> { x, y, face, room, pose, fx, present, client, at }
const hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function getLook() {
  let v = null;
  try { v = JSON.parse(one(globalDb(), "SELECT value FROM kv WHERE key = 'owner.look'")?.value || 'null'); } catch {}
  return { ...DEFAULT_LOOK, ...(v || {}), crown: true };
}
/** Only known look keys with sane values are kept; anything else is refused with a message. */
export function cleanLook(l) {
  if (!l || typeof l !== 'object') throw new Error('look harus objek');
  const out = {};
  for (const k of ['color', 'hair', 'skin']) if (l[k] !== undefined) { if (!hex(l[k])) throw new Error(`look.${k} harus warna #rrggbb`); out[k] = l[k]; }
  if (l.hijab !== undefined) { if (l.hijab !== null && !hex(l.hijab)) throw new Error('look.hijab harus warna #rrggbb atau null'); out.hijab = l.hijab; }
  if (l.hairStyle !== undefined) { if (!STYLES.includes(l.hairStyle)) throw new Error('look.hairStyle tidak dikenal'); out.hairStyle = l.hairStyle; }
  if (l.outfit !== undefined) { if (!OUTFITS.includes(l.outfit)) throw new Error('look.outfit tidak dikenal'); out.outfit = l.outfit; }
  if (l.acc !== undefined) { if (!ACCS.includes(l.acc || '')) throw new Error('look.acc tidak dikenal'); out.acc = l.acc || ''; }
  return out;
}
export function setLook(l) {
  const look = { ...getLook(), ...cleanLook(l), crown: true };
  run(globalDb(), "INSERT INTO kv (key, value) VALUES ('owner.look', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(look));
  return look;
}

const view = (p, now) => {
  const present = !!p && p.present && now - p.at < PRESENT_MS;
  return { x: p?.x ?? null, y: p?.y ?? null, face: p?.face || 'down', room: p?.room ?? null, pose: present ? p.pose || null : null, fx: present ? p.fx || null : null,
    present, client: p?.client || null, at: p ? new Date(p.at).toISOString() : null, look: getLook() };
};
export function getOwner(office, now = Date.now()) { return view(pos.get(office), now); }

/** Partial update: fields left out keep their value. x,y are tile units (fractions allowed while walking). */
export function putOwner(office, b = {}, now = Date.now()) {
  if (!b || typeof b !== 'object') throw new Error('body harus objek');
  const cur = pos.get(office) || { x: null, y: null, face: 'down', room: null, pose: null, fx: null, present: false, client: null, at: now };
  const next = { ...cur, at: now };
  if (b.x !== undefined || b.y !== undefined) {
    const x = Number(b.x), y = Number(b.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 4000 || y > 4000) throw new Error('x,y harus angka tile yang wajar');
    next.x = Math.round(x * 100) / 100; next.y = Math.round(y * 100) / 100;
  }
  if (b.face !== undefined) { if (!FACES.includes(b.face)) throw new Error('face: up|down|left|right'); next.face = b.face; }
  if (b.room !== undefined) next.room = b.room == null ? null : String(b.room).slice(0, 80);
  if (b.pose !== undefined) { if (b.pose !== null && !POSES.includes(b.pose)) throw new Error('pose tidak dikenal'); next.pose = b.pose; }
  if (b.fx !== undefined) next.fx = b.fx == null ? null : String(b.fx).slice(0, 24);
  if (b.client !== undefined) next.client = b.client == null ? null : String(b.client).slice(0, 64);
  if (b.present !== undefined) next.present = !!b.present;
  if (next.present && (next.x == null || next.y == null)) throw new Error('owner yang hadir butuh x,y');
  if (!next.present) { next.pose = null; next.fx = null; }
  if (b.look !== undefined) setLook(b.look);
  pos.set(office, next);
  const owner = view(next, now);
  bus.emit('msg', { t: 'owner', office, owner });
  return owner;
}

/** Owners whose client stopped sending leave; one event each. */
export function sweep(now = Date.now()) {
  const gone = [];
  for (const [office, p] of pos) if (p.present && now - p.at >= PRESENT_MS) {
    p.present = false; p.pose = null; p.fx = null;
    gone.push(office);
    bus.emit('msg', { t: 'owner', office, owner: view(p, now) });
  }
  return gone;
}
export const startOwnerSweep = () => setInterval(() => sweep(), 15e3).unref();
