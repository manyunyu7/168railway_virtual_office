// Membuka chat di app HP dengan satu permintaan: transcript (delta), lampiran, dan sesi live sekaligus.

/** Argumen readTranscript dari query GET /api/sessions/:sid/transcript: mode lama, delta (?delta=1 / ?after=) atau halaman ke belakang (?before=&gen=). */
export function transcriptArgs(sid, q) {
  const n = Number(q.get('n')) || 120;
  if (q.has('before')) return [n, { sid, before: q.get('before'), gen: q.get('gen') || '' }];
  return [n, q.has('after') || q.get('delta') === '1' ? { sid, after: q.get('after') } : undefined];
}

/**
 * GET /api/sessions/:sid/open?n=&after=: jawaban yang sama persis dengan route aslinya.
 * transcript(sid, q) dan attachments(sid, q) adalah fungsi yang dipakai route transcript dan attachments;
 * session(sid) memberi objek sesi live (serialize) atau null.
 */
export function openSession(sid, q, { transcript, attachments, session }) {
  const tq = new URLSearchParams({ delta: '1' });
  if (q.has('n')) tq.set('n', q.get('n'));
  if (q.has('after')) tq.set('after', q.get('after'));
  let files = null;
  try { files = attachments(sid, new URLSearchParams()) ?? null; } catch { files = null; }
  return { transcript: transcript(sid, tq), attachments: files, session: session(sid) ?? null };
}
