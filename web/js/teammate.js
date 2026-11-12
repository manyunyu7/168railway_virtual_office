// Pesan dari sesi Claude lain (<teammate-message …>) yang masuk ke transcript sebagai prompt user.
// Dipakai Chat (kartu, bukan gelembung pesanmu) dan konteks server (askOf), jadi tanpa DOM.
const RE = /<teammate-message([^>]*)>([\s\S]*?)(?:<\/teammate-message>|$)/g;
const attrsOf = s => Object.fromEntries([...String(s).matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const KIND = { idle_notification: 'selesai', shutdown_request: 'minta berhenti', shutdown_response: 'berhenti', task_assignment: 'tugas baru' };

/** [{from, color, summary, body, kind}] atau null kalau teks ini bukan pesan antar-sesi. */
export function teammateMsgs(text) {
  const t = String(text || '');
  if (!t.includes('<teammate-message')) return null;
  const out = [];
  for (const m of t.matchAll(RE)) {
    const a = attrsOf(m[1]), raw = m[2].trim();
    let from = a.teammate_id || 'sesi lain', summary = a.summary || '', body = raw, kind = 'pesan';
    if (raw.startsWith('{')) {
      try {
        const d = JSON.parse(raw);
        from = d.from || from; kind = KIND[d.type] || (d.type ? String(d.type).replace(/_/g, ' ') : kind);
        summary = d.summary || summary;
        body = d.result ?? d.message ?? d.content ?? d.text ?? '';
        if (typeof body !== 'string') body = JSON.stringify(body, null, 2);
      } catch { /* bukan JSON utuh (mis. terpotong): tampilkan apa adanya */ }
    }
    body = String(body).trim();
    // tanpa ringkasan: baris pertama isinya jadi pratinjau (tanpa tanda markdown)
    if (!summary && body) summary = body.split('\n').find(l => l.trim())?.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').slice(0, 160) || '';
    out.push({ from, color: a.color || '', summary, body, kind });
  }
  return out.length ? out : null;
}

/** Teks pemilik di luar pesan antar-sesi (mis. kalimat yang diketik setelah menempel pesan); kosong kalau tidak ada. */
export function teammateRest(text) {
  return String(text || '').replace(RE, ' ').replace(/Another Claude session sent a message:/g, ' ').replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+\n/g, '\n').trim();
}
