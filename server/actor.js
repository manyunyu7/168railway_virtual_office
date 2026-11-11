// Who is acting right now: the signed-in member (akun mode), the local owner ("Kamu"), or the daemon itself.
// Request handlers run inside withActor(); code deeper down asks who() instead of hard-coding 'Kamu'.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** kind: 'member' (akun login) | 'local' (single-user token) | 'system' (hooks, MCP, daemon) | 'agent' (a role via MCP)
 *  | 'machine' (hook dan MCP dari Mac lain lewat token mesin; hanya rute hook/agen/limit, lihat docs/MULTI-PC.md) */
export const LOCAL = Object.freeze({ kind: 'local', id: null, name: 'Kamu', role: 'admin' });
export const SYSTEM = Object.freeze({ kind: 'system', id: null, name: 'Sistem', role: 'admin' });
/** Actor untuk permintaan bertoken mesin. `id` sengaja null: di audit, actor_id dipakai untuk anggota. */
export const machineActor = (machine, name, ip = null) => ({ kind: 'machine', id: null, machine, name: `Mesin ${name || machine}`, role: 'machine', ip });
/** Payload hook: `kantor_machine` hanya dari token mesin, tidak pernah dari body (juga untuk token lokal). Mengubah `p`. */
export function stampHook(p, a) {
  if (!p || typeof p !== 'object') return p;
  delete p.kantor_machine;
  if (a?.kind === 'machine') {
    p.kantor_machine = a.machine;
    delete p.kantor_tty; // tty Mac lain tidak berarti apa-apa di hub (dan bisa menunjuk terminal lokal)
  }
  return p;
}

export const withActor = (actor, fn) => als.run(actor, fn);
export const actor = () => als.getStore() || null;

/** Name to write as the author of a human action. Outside any request (or for local/system) it stays 'Kamu'. */
export function who() {
  const a = als.getStore();
  return a?.kind === 'member' ? a.name : 'Kamu';
}

/** True when `by` is the human behind the current request (callers used to compare with 'Kamu'). */
export function isHuman(by) {
  if (by === 'Kamu') return true;
  const a = als.getStore();
  return a?.kind === 'member' && by === a.name;
}
