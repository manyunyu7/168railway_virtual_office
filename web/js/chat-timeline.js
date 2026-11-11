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
