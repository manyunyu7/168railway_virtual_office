// Sequence numbers, not timestamps/text, identify transcript entries. Two
// identical messages in one millisecond must still remain separate messages.
export function mergeHistory(previous, data) {
  if (data.missing) return previous;
  if (!data.gen) return { ...data, items: data.items || [] };
  if (previous.gen !== data.gen) return { ...data, items: data.items || [] };
  const entries = new Map(previous.entries || previous.items.map((item, i) => [previous.first + i, item]));
  for (const [i, item] of (data.items || []).entries()) entries.set(data.first + i, item);
  const seqs = [...entries.keys()].sort((a, b) => a - b);
  const first = seqs[0] ?? data.first;
  return { ...previous, ...data, first, older: first === data.first ? data.older : previous.older,
    cursor: data.cursor || previous.cursor, entries, items: seqs.map(i => entries.get(i)) };
}
