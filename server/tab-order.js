// GET/PUT /api/settings/tabs: validasi urutan tab global (disimpan di config.json sebagai tabOrder)
export { TAB_ID_RE, TAB_ORDER_MAX } from '../web/js/tab-order.js';
import { TAB_ID_RE, TAB_ORDER_MAX } from '../web/js/tab-order.js';

export function validateTabOrder(order) {
  if (!Array.isArray(order)) throw new Error('order harus berupa array');
  if (order.length > TAB_ORDER_MAX) throw new Error(`order maksimal ${TAB_ORDER_MAX} tab`);
  const out = [];
  for (const k of order) {
    if (typeof k !== 'string' || !TAB_ID_RE.test(k)) throw new Error('id tab tidak valid');
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
