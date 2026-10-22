// Kartu kecil di panel samping Kantor: kunci sumber daya bersama (siapa memegang, siapa antre) dan versi aturan kantor.
// Datanya dari GET /api/offices/:id/kunci dan /aturan; pembaruan lewat event live {t:'locks'} dan {t:'changed', what:'aturan'}.
import { api, esc } from './util.js';

export const kunciCardHTML = () => `<div class="card kunci-card" id="kunciCard"><p class="eyebrow card-h">Kunci &amp; aturan</p><div id="kunciBody"><p class="hint">Memuat…</p></div></div>`;

const left = k => Math.max(0, Math.ceil((Date.parse(k.kedaluwarsa) - Date.now()) / 60000));

function paint(o) {
  const el = document.getElementById('kunciBody'); if (!el || !o) return;
  const ks = o.kunci || [], ar = o.aturan;
  const locks = ks.length ? `<ul class="kunci-list">${ks.map(k => `<li><div class="kunci-h"><b>${esc(k.nama)}</b> <span class="hint">dipegang ${esc(k.pemegang.nama)} · sisa ${left(k)} mnt</span></div>
      <div class="hint kunci-why">${esc(k.alasan)}</div>
      ${k.antrean.length ? `<ol class="kunci-q">${k.antrean.map(q => `<li>${esc(q.nama)} <span class="hint">menunggu · ${esc(q.alasan)}</span></li>`).join('')}</ol>` : ''}</li>`).join('')}</ul>`
    : '<p class="hint">Tidak ada kunci dipegang.</p>';
  const set = (ar?.kategori || []).filter(c => c.isi);
  const rules = ar ? `<details class="kunci-rules"><summary>Aturan kantor · versi ${ar.versi} · ${set.length} kategori</summary>${set.length ? set.map(c => `<p><b>${esc(c.judul)}</b><br><span class="hint">${esc(c.isi)}</span></p>`).join('') : '<p class="hint">Belum ada aturan. Manager menyusunnya dengan aturan_set.</p>'}</details>` : '';
  el.innerHTML = locks + rules;
}

let timer = null;
export async function paintKunciCard(ctx) {
  const o = ctx.office; if (!o || !document.getElementById('kunciBody')) return;
  try {
    const [k, a] = await Promise.all([api(`/api/offices/${o.id}/kunci`), api(`/api/offices/${o.id}/aturan`)]);
    o.kunci = k.kunci; o.aturan = a;
  } catch { o.kunci = o.kunci || []; }
  paint(o);
  clearInterval(timer);
  timer = setInterval(() => { if (!document.getElementById('kunciBody')) return clearInterval(timer); paint(ctx.office); }, 30000);
}

export function kunciLive(m, ctx) {
  const o = ctx.office; if (!o || m.office !== o.id) return;
  if (m.t === 'locks') { o.kunci = m.locks; paint(o); }
  else if (m.t === 'changed' && m.what === 'aturan') paintKunciCard(ctx);
}
