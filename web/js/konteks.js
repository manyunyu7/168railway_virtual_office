// "Agen ini lagi ngerjain apa, dan gimana hasilnya?": topik, pil keadaan, dan baris detail dari s.konteks (dihitung server).
// Semua fungsi aman bila s.konteks tidak ada (data lama): hasilnya kosong dan pemanggil memakai tampilan lamanya.
import { esc, short, ago, post, toast, confirmDo } from './util.js';

if (typeof document !== 'undefined' && !document.getElementById('konteksCss')) {
  const l = document.createElement('link');
  l.id = 'konteksCss'; l.rel = 'stylesheet'; l.href = new URL('../css/konteks.css', import.meta.url).href;
  document.head.appendChild(l);
}

const PILL = { izin: 'Izin', tanya: 'Tanya', jalan: 'Jalan', tunggu: 'Tunggu', gagal: 'Galat', henti: 'Henti', selesai: 'Selesai', kosong: 'Kosong', tutup: 'Tutup' };
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const toolText = t => t && typeof t === 'object' ? [t.name, t.label].filter(Boolean).join(' ') : clean(t);

export const topicOf = s => clean(s?.konteks?.topic);
export const stateOf = s => s?.konteks?.state?.k || '';

/** Satu kalimat "sedang apa / hasilnya apa" sesuai keadaan; fallback dipakai bila konteks belum punya bahannya. */
export function detailOf(s, fallback = '') {
  const kx = s?.konteks; if (!kx) return fallback;
  const k = kx.state?.k;
  const pick = (...xs) => { for (const x of xs) { const t = clean(x); if (t) return t; } return fallback; };
  if (k === 'izin' || k === 'tanya') return pick(s.waiting?.summary, kx.reply?.q, s.waiting?.tool);
  if (k === 'jalan') { const a = clean(kx.ask?.s); return pick(kx.kerjaan?.langkah, toolText(s.tool), a !== topicOf(s) ? a : '', fallback, 'sedang berpikir'); }
  if (k === 'gagal') return pick(kx.err, kx.reply?.s);
  if (k === 'tutup') return fallback;
  return pick(kx.reply?.s);
}

/** Pil keadaan berwarna; '' bila tidak ada konteks. */
export function pillHTML(s) {
  const st = s?.konteks?.state; if (!st?.k) return '';
  return `<i class="kx-pill k-${esc(st.k)}" title="${esc(st.label || '')}">${esc(PILL[st.k] || st.label || st.k)}</i>`;
}

/** Teks tambahan untuk kolom pencarian. */
export const searchBits = s => [topicOf(s), s?.konteks?.state?.label, s?.konteks?.reply?.s, s?.konteks?.ask?.s].filter(Boolean).join(' ');

/** Baris topik (satu baris, ellipsis lewat CSS); '' bila tidak ada topik. */
export const topicHTML = (s, cls = '') => { const t = topicOf(s); return t ? `<span class="kx-topic${cls ? ' ' + cls : ''}" title="${esc(t)}">${esc(t)}</span>` : ''; };

/** Pil + detail dalam satu baris. */
export function subHTML(s, fallback = '', max = 90) {
  const pill = pillHTML(s), d = short(detailOf(s, fallback), max);
  if (!pill) return `<span class="kx-sub">${esc(d)}</span>`;
  return `<span class="kx-sub">${pill}<span class="kx-d">${esc(d)}</span></span>`;
}

/* ---------------- panel di atas percakapan ---------------- */
const OPEN_KEY = 'kc.kx.open';
const isOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const setOpen = on => { try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch {} };

/** Draf laporan ke Anthropic yang menunggu di terminal sesi. Mengirim selalu lewat konfirmasi yang menampilkan isinya. */
function draftHTML(d) {
  if (!d) return '';
  return `<div class="kx-draft"><div class="kx-draft-t"><b>Draf laporan ke Anthropic</b><span>${esc(d.title)}</span>${d.details ? `<details><summary>Lihat isi</summary><pre>${esc(d.details)}</pre></details>` : ''}<small>Belum terkirim. Dibuat sendiri oleh agen.${d.siap ? '' : ' Tombolnya muncul begitu prompt-nya tampil di terminal.'}</small></div>${d.siap ? '<div class="kx-draft-b"><button type="button" class="btn sm" data-kx-draft="abaikan">Abaikan</button><button type="button" class="btn sm" data-kx-draft="kirim">Kirim…</button></div>' : ''}</div>`;
}
export function panelHTML(s, open = false) {
  const kx = s?.konteks; if (!kx) return '';
  const st = kx.state || {}, rows = [];
  const row = (l, body, cls = '') => body ? rows.push(`<div class="kx-r${cls ? ' ' + cls : ''}"><b>${esc(l)}</b><span>${body}</span></div>`) : 0;
  if (kx.kerjaan) row('Laporan agen', `${esc(kx.kerjaan.judul)}${kx.kerjaan.langkah ? `: ${esc(kx.kerjaan.langkah)}` : ''}${kx.kerjaan.persen != null ? ` <small>${esc(kx.kerjaan.persen)}%</small>` : ''}${kx.kerjaan.at ? ` <small>${esc(ago(kx.kerjaan.at))}</small>` : ''}`);
  if (kx.ask?.s) row(kx.ask.from === 'agen' ? `Diminta ${s.look?.name || 'agen lain'}` : 'Kamu minta', `${esc(kx.ask.s)}${kx.ask.at ? ` <small>${esc(ago(kx.ask.at))}</small>` : ''}`);
  if (kx.reply?.s) row('Terakhir dia bilang', `${esc(kx.reply.s)}${kx.reply.at ? ` <small>${esc(ago(kx.reply.at))}</small>` : ''}`);
  if (kx.reply?.q) row('Pertanyaan', esc(kx.reply.q), 'q');
  if (kx.err) row('Galat', esc(kx.err), 'err');
  if (kx.card?.title) row('Kartu', esc(kx.card.title));
  if (kx.files?.names?.length) row(`Berkas${kx.files.n > kx.files.names.length ? ` (${kx.files.n})` : ''}`, kx.files.names.map(n => `<code>${esc(n)}</code>`).join(' '));
  if (kx.branch) row('Cabang', `<code>${esc(kx.branch)}</code>`);
  const topic = clean(kx.topic) || st.label || '';
  const lead = { jalan: 'Lagi', izin: 'Minta izin', tanya: 'Dia nanya', gagal: 'Galat', tunggu: 'Terakhir', henti: 'Terakhir', selesai: 'Hasil' }[st.k];
  const now = detailOf(s);
  return `${draftHTML(kx.draft)}<details class="kx"${open ? ' open' : ''}><summary>${pillHTML(s)}<span class="kx-head"><span class="kx-sum">${esc(topic)}</span>${now && now !== topic ? `<span class="kx-now">${lead ? `<b>${esc(lead)}:</b> ` : ''}${esc(now)}</span>` : ''}</span></summary><div class="kx-body">${rows.join('') || '<p class="kx-none">Belum ada ringkasan.</p>'}</div></details>`;
}

/** Pasang panel ke slot; kembalikan fungsi repaint. Status buka/tutup disimpan dan bertahan lewat repaint. */
export function mountPanel(slot, getSess) {
  if (!slot) return () => {};
  let last = null;
  slot.addEventListener('click', e => {
    const b = e.target.closest('[data-kx-draft]'), s = getSess(); if (!b || !s) return;
    const act = () => post(`/api/sessions/${encodeURIComponent(s.sid)}/draft-laporan`, { aksi: b.dataset.kxDraft }).then(r => toast(r.masih ? 'Draf masih tampil, cek tab Terminal' : b.dataset.kxDraft === 'kirim' ? 'Laporan dikirim' : 'Draf diabaikan', r.masih ? 'bad' : 'ok')).catch(x => toast(x.message, 'bad'));
    if (b.dataset.kxDraft === 'kirim') confirmDo('Kirim laporan ini ke Anthropic?', `Isinya: ${esc(short(s.konteks?.draft?.details || s.konteks?.draft?.title || '', 600))}`, 'Kirim', act, 'primary');
    else act();
  });
  slot.addEventListener('toggle', e => { if (e.target.classList?.contains('kx')) setOpen(e.target.open); }, true);
  return () => {
    const open = slot.querySelector('.kx')?.open ?? isOpen();
    const html = panelHTML(getSess(), open);
    if (html !== last) { last = html; slot.innerHTML = html; }
  };
}
