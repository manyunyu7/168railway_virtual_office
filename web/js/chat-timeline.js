// Satukan sumber chat berdasarkan waktu sebelum aksi tool dikelompokkan.
const ms = at => Date.parse(at) || 0;
const norm = text => String(text || '').replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1').replace(/\s+/g, ' ').trim().replace(/…$/, '').trim();
const sameText = (a, b) => {
  a = norm(a); b = norm(b);
  return a === b || (a.length > 20 && b.length > 20 && (a.startsWith(b) || b.startsWith(a)));
};

/** Urutan transcript tetap menjadi acuan; item tambahan disisipkan pada waktunya. */
export function chatTimeline(items, outbox = [], attachments = [], previews = []) {
  const used = new Set();
  // pesan gabungan lampiran (deliverBatch) di transcript: tampilkan tulisan pemiliknya saja, daftar file sudah jadi kartu
  const batches = [...new Map(attachments.filter(a => a.message).map(a => [a.message, a.note || ''])).entries()];
  if (batches.length) items = items.flatMap(g => {
    if (g.k !== 'user') return [g];
    const hit = batches.find(([m]) => sameText(g.s, m));
    return !hit ? [g] : hit[1] ? [{ ...g, s: hit[1] }] : [];
  });
  // antrean (pesan yang belum dibaca agen) juga: tulisan pemilik saja
  if (batches.length) outbox = outbox.flatMap(it => {
    const hit = batches.find(([m]) => sameText(it.text, m));
    return !hit ? [it] : hit[1] ? [{ ...it, text: hit[1] }] : [];
  });
  const extras = [
    ...outbox.filter(it => {
      const i = items.findIndex((g, j) => g.k === 'user' && !used.has(j) && sameText(g.s, it.text) && ms(g.at) >= ms(it.at) - 5000);
      if (i < 0) return true;
      used.add(i);
      return false;
    }).map(item => ({ k: 'outbox', at: item.at, item })),
    ...attachments.map(item => ({ k: 'attachment', at: item.at, item })),
    ...previews.map(item => ({ k: 'preview', at: item.createdAt, item })),
  ].sort((a, b) => ms(a.at) - ms(b.at));
  const rows = [];
  let i = 0;
  for (const item of items) {
    while (i < extras.length && ms(extras[i].at) <= ms(item.at)) rows.push(extras[i++]);
    rows.push(item);
  }
  rows.push(...extras.slice(i));
  return rows;
}
