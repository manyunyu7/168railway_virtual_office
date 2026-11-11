// Multi-PC: di mesin mana sebuah kantor bekerja, untuk lencana di daftar kantor (GET /api/state, docs/MULTI-PC.md).
import { officeDb, one } from './db.js';
import { officeModel } from './offices.js';

const LOCAL = 'local';
const remoteOf = r => r && r.machine && r.machine !== LOCAL ? r.machine : null;

/**
 * Ringkasan penempatan ruangan berfolder: [{ id: 'local'|<id mesin>, rooms: n }], terbanyak dulu (seri: Mac ini dulu,
 * lalu id). Ruangan tanpa folder (lobi, pantry, dst.) tidak dihitung. Kosong bila tidak ada ruangan berfolder.
 */
export function machineSummary(rooms) {
  const n = new Map();
  for (const r of rooms || []) {
    if (!r || r.preview) continue;
    const id = remoteOf(r) || (r.path != null ? LOCAL : null);
    if (id) n.set(id, (n.get(id) || 0) + 1);
  }
  return [...n].map(([id, rooms]) => ({ id, rooms }))
    .sort((a, b) => b.rooms - a.rooms || (a.id === LOCAL ? -1 : b.id === LOCAL ? 1 : a.id.localeCompare(b.id)));
}

// Ruangan remote berasal dari meta 'extraRooms', 'rooms' (override), atau 'remoteRoot' (kantor dari wizard di mesin lain).
const META_REMOTE = /"machine"\s*:\s*"(?!local")[^"]+"/;
function hasRemoteRooms(id) {
  const db = officeDb(id);
  return ['extraRooms', 'rooms', 'remoteRoot'].some(k => META_REMOTE.test(one(db, 'SELECT value FROM meta WHERE key = ?', k)?.value || ''));
}

/**
 * Field `machines` per kantor untuk /api/state. undefined = semua ruangan di Mac ini (klien tidak memberi lencana),
 * jadi kantor satu-PC tidak memicu scan folder tambahan. Tidak pernah melempar.
 */
export function officeMachines(id) {
  try {
    if (!hasRemoteRooms(id)) return undefined;
    const s = machineSummary(officeModel(id)?.plan?.rooms);
    return s.some(x => x.id !== LOCAL) ? s : undefined;
  } catch { return undefined; }
}
