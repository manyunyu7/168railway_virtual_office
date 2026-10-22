// Urutan tab kantor: gabungkan urutan tersimpan dengan daftar tab yang dikenal.
// Pure (tanpa DOM) supaya bisa dites dari node.
export const TAB_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const TAB_ORDER_MAX = 64;
export const DEFAULT_FIRST = ['kantor', 'wiki'];

// urutan bawaan: kantor, wiki, lalu sisanya sesuai urutan deklarasi
export function defaultOrder(known) {
  const first = DEFAULT_FIRST.filter(k => known.includes(k));
  return [...first, ...known.filter(k => !first.includes(k))];
}

// saved: urutan tersimpan (boleh berisi tab yang sudah dihapus / kurang tab baru)
// tab yang tidak dikenal dibuang; tab baru disisipkan di posisi bawaannya (setelah tetangga bawaan sebelumnya)
export function mergeOrder(saved, known) {
  const def = defaultOrder(known);
  if (!Array.isArray(saved)) return def;
  const out = [];
  for (const k of saved) if (known.includes(k) && !out.includes(k)) out.push(k);
  def.forEach((k, i) => {
    if (out.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.indexOf(def[j]); if (p >= 0) { at = p + 1; break; } }
    out.splice(at, 0, k);
  });
  return out;
}
