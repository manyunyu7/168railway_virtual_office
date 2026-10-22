// Panel subagent di tab Chat: fungsi murni (tanpa DOM) supaya bisa dites di Node.
const SUB_KEEP_MS = 60_000; // selesai: tetap tampil redup sebentar
export const fmtTokens = n => n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
export const fmtElapsed = ms => { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`; };
/**
 * Baris panel subagent ala daftar agen Claude Code: yang tipe + deskripsi + statusnya sama digabung jadi "(+n)",
 * yang jalan di atas, yang selesai < 1 menit lalu ikut (redup). Token dijumlah per grup.
 */
export function subRows(subs, now = Date.now()) {
  const groups = new Map();
  for (const x of subs || []) {
    const done = x.status === 'done';
    if (done && x.ended && now - x.ended > SUB_KEEP_MS) continue;
    const k = `${done ? 1 : 0}\u0000${x.type || 'agent'}\u0000${x.desc || ''}`;
    const g = groups.get(k) || groups.set(k, { type: x.type || 'agent', desc: x.desc || '', done, n: 0, started: Infinity, ended: 0, tokens: null, act: '' }).get(k);
    g.n++; g.started = Math.min(g.started, x.started || now); g.ended = Math.max(g.ended, x.ended || 0);
    if (x.tokens != null) g.tokens = (g.tokens || 0) + x.tokens;
    if (!g.act && x.tool && (x.tool.label || x.tool.name)) g.act = `${x.tool.name || ''} ${x.tool.label || ''}`.trim();
  }
  return [...groups.values()].sort((a, b) => a.done - b.done || a.started - b.started)
    .map(g => ({ ...g, label: g.n > 1 ? `${g.type} (+${g.n - 1})` : g.type, elapsed: ((g.done && g.ended) || now) - g.started }));
}
