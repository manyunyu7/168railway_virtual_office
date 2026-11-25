// Perbandingan token dalam waktu konstan (panjang berbeda langsung false; panjang token bukan rahasia).
import crypto from 'node:crypto';

/** true kalau a dan b string yang sama persis. null/undefined/kosong tidak pernah cocok. */
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
