// Who is acting right now: the signed-in member (akun mode), the local owner ("Kamu"), or the daemon itself.
// Request handlers run inside withActor(); code deeper down asks who() instead of hard-coding 'Kamu'.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** kind: 'member' (akun login) | 'local' (single-user token) | 'system' (hooks, MCP, daemon) | 'agent' (a role via MCP) */
export const LOCAL = Object.freeze({ kind: 'local', id: null, name: 'Kamu', role: 'admin' });
export const SYSTEM = Object.freeze({ kind: 'system', id: null, name: 'Sistem', role: 'admin' });

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
