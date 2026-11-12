// Ringkasan otomatis saat konteks sesi penuh ("This session is being continued…"), dari kompaksi Claude Code
// atau yang ditempel pemilik. Tanpa DOM: dipakai Chat web dan dites di Node.
const HEAD = /^\s*This session is being continued from a previous conversation/;

/** {preview, body, rest} atau null kalau teks ini tidak memuat ringkasan kompaksi.
 *  `rest`: tulisan pemilik di luar ringkasan (mis. "ini juga baiknya…" sebelum menempelnya). */
export function compactSummary(text) {
  const raw = String(text || '');
  const pos = raw.search(/This session is being continued from a previous conversation/);
  if (pos < 0) return null;
  // ringkasan yang ditempel: isi blok <pasted_content> yang memuatnya; sisanya tulisan pemilik
  const blocks = [...raw.matchAll(/<pasted_content[^>]*>([\s\S]*?)(?:<\/pasted_content[^>]*>|$)/g)];
  const blk = blocks.find(m => m.index <= pos && pos <= m.index + m[0].length);
  const sum = blk ? blk[1] : raw.slice(pos);
  const rest = (blk ? raw.slice(0, blk.index) + raw.slice(blk.index + blk[0].length) : raw.slice(0, pos)).replace(/<\/?pasted_content[^>]*>/g, ' ').trim();
  let body = sum.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(HEAD, '').replace(/^[^\n]*\n/, '');
  const at = body.search(/^\s*Summary:\s*$/m);
  if (at >= 0) body = body.slice(at).replace(/^\s*Summary:\s*\n/, '');
  body = body.trim();
  // pratinjau: isi bagian pertama ("Primary Request and Intent"), tanpa tanda markdown
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const pick = lines.find((l, i) => i > 0 && !/^\d+\.\s/.test(l)) || lines[0] || '';
  const preview = pick.replace(/^[-*#>\s]+/, '').replace(/[*_`]/g, '').slice(0, 220);
  return { preview, body, rest };
}
