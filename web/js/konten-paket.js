// Tab Konten: Paket Posting (media besar, unduh/bagikan, caption per platform, tandai tayang) dan helper bersama
// (media viewer, salin, pertahankan isian saat render ulang). Dipakai konten.js.
import { esc, api, post, patch, toast, modal } from './util.js';
import { PLAT, METRIK, METRIK_LABEL, platformsFor, captionOf, fmtTanggal, fmtAt, fmtSize, validJam, validDate, num, hashFor } from './konten-lib.js';

/* ---------------- helper bersama ---------------- */
const sep = u => (String(u).includes('?') ? '&' : '?');
export const dlUrl = u => `${u}${sep(u)}dl=1`;
const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
export const ICON_JENIS = { carousel: '▦', video: '▶', lain: '◇' };

/** Salin teks; true bila berhasil. Cadangan lewat textarea sementara untuk konteks tanpa Clipboard API. */
export async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await Promise.race([navigator.clipboard.writeText(text), new Promise((_, no) => setTimeout(no, 1200))]); return true; } } catch {}
  try {
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); t.remove(); return !!ok;
  } catch { return false; }
}

/** Jalankan fn (yang menulis ulang isi root) tanpa membuang scroll, fokus, dan isian [data-k] yang sedang diubah pengguna. */
export function keepState(root, fn) {
  const y = window.scrollY, act = document.activeElement, snap = new Map();
  for (const f of root.querySelectorAll('[data-k]')) {
    if (f.type === 'checkbox' || f.type === 'radio') continue;
    snap.set(f.dataset.k, { v: f.value, dirty: f.value !== f.defaultValue, s: f.selectionStart, e: f.selectionEnd, st: f.scrollTop });
  }
  const focusKey = act && root.contains(act) ? act.dataset?.k || null : null;
  fn();
  for (const f of root.querySelectorAll('[data-k]')) {
    const s = snap.get(f.dataset.k); if (!s) continue;
    if (s.dirty) { f.value = s.v; f.dispatchEvent(new Event('input', { bubbles: true })); }
    f.scrollTop = s.st || 0;
  }
  if (focusKey) {
    const f = [...root.querySelectorAll('[data-k]')].find(x => x.dataset.k === focusKey), s = snap.get(focusKey);
    if (f) { try { f.focus({ preventScroll: true }); if (s && s.s != null && f.setSelectionRange && /^(text|search|url|tel|password)$|^textarea$/.test(f.type)) f.setSelectionRange(s.s, s.e); } catch {} }
  }
  window.scrollTo({ top: y, behavior: 'instant' });
}

/* ---------------- media ---------------- */
const mediaName = m => m?.name || String(m?.rel || '').split('/').pop() || 'berkas';
export function mediaHTML(it, { full = true } = {}) {
  const md = it.media || {}, slides = md.slides || [], v = md.video;
  let h = '';
  if (v?.url) {
    h += `<div class="kt-vid"><video controls preload="metadata" playsinline src="${esc(v.url)}"${(v.thumb || md.cover?.thumb) ? ` poster="${esc(v.thumb || md.cover.thumb)}"` : ''}></video></div>
      ${full ? `<div class="kt-file"><span class="kt-fn">${esc(mediaName(v))}${v.size ? ` <small>${esc(fmtSize(v.size))}</small>` : ''}</span></div>` : ''}`;
  }
  if (slides.length) {
    h += `<div class="kt-stage" tabindex="0" aria-label="Slide, tombol panah untuk berpindah">
      <div class="kt-slides" role="list">${slides.map((s, i) => `<figure class="kt-slide" role="listitem"><img src="${esc(s.url)}" alt="Slide ${i + 1} dari ${slides.length}" loading="lazy" decoding="async"></figure>`).join('')}</div>
      ${slides.length > 1 ? '<button type="button" class="kt-nav prev" data-act="pk-nav" data-d="-1" aria-label="Slide sebelumnya">‹</button><button type="button" class="kt-nav next" data-act="pk-nav" data-d="1" aria-label="Slide berikutnya">›</button>' : ''}
      <span class="kt-count" aria-live="polite">1/${slides.length}</span></div>
    ${slides.length > 1 ? `<div class="kt-thumbs" role="group" aria-label="Pilih slide">${slides.map((s, i) => `<button type="button" class="kt-th${i ? '' : ' on'}" data-act="pk-slide" data-i="${i}" aria-label="Slide ${i + 1}"><img src="${esc(s.thumb || s.url)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}`;
  }
  if (!h) h = `<div class="kt-nomedia"><b>Belum ada media</b><span>Render post ini belum ketemu di folder proyeknya.</span>${it.folder ? `<code>${esc(it.folder)}</code>` : ''}</div>`;
  return h;
}
const slideAt = new Map(); // kartu -> slide yang sedang dilihat, bertahan saat tampilan digambar ulang
const stageOf = el => el?.closest?.('.kt-pk-media, .kt-rv')?.querySelector('.kt-slides');
function goSlide(box, i, smooth = true) {
  if (!box) return;
  const n = box.children.length, to = Math.max(0, Math.min(n - 1, i));
  box.scrollTo({ left: to * box.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
}
/** Pasang perilaku slide setelah digambar: penanda thumbnail, nomor, panah keyboard, posisi terakhir. */
export function bindMedia(root, cardId) {
  const box = root.querySelector('.kt-slides'); if (!box) return;
  const wrap = box.closest('.kt-pk-media, .kt-rv') || root;
  const mark = () => {
    const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
    slideAt.set(cardId, i);
    const c = wrap.querySelector('.kt-count'); if (c) c.textContent = `${i + 1}/${box.children.length}`;
    wrap.querySelectorAll('.kt-th').forEach((t, k) => { const on = k === i; if (t.classList.contains('on') !== on) { t.classList.toggle('on', on); if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } });
  };
  box.addEventListener('scroll', mark, { passive: true });
  box.closest('.kt-stage')?.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); goSlide(box, (slideAt.get(cardId) || 0) + (e.key === 'ArrowLeft' ? -1 : 1)); } });
  if (slideAt.get(cardId)) { goSlide(box, slideAt.get(cardId), false); mark(); }
}

/* ---------------- bagikan (Web Share dengan berkas) ---------------- */
const fileCache = new Map();
export const clearFileCache = () => fileCache.clear();
export const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';
async function toFile(m) {
  if (fileCache.has(m.url)) return fileCache.get(m.url);
  const r = await fetch(m.url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`Gagal mengambil ${mediaName(m)} (${r.status})`);
  const b = await r.blob(), n = mediaName(m);
  const f = new File([b], n, { type: b.type || (/\.mp4$/i.test(n) ? 'video/mp4' : /\.jpe?g$/i.test(n) ? 'image/jpeg' : 'image/png') });
  fileCache.set(m.url, f); return f;
}
async function shareMedia(list, title) {
  if (!list.length) { toast('Tidak ada berkas untuk dibagikan', 'bad'); return; }
  toast('Menyiapkan berkas…');
  const files = []; for (const m of list) files.push(await toFile(m));
  if (!navigator.canShare?.({ files })) { toast('Browser ini belum bisa membagikan berkas. Pakai Unduh.', 'bad'); return; }
  try { await navigator.share({ files, title }); }
  catch (e) { if (e?.name === 'AbortError') return; if (e?.name === 'NotAllowedError') { toast('Berkas sudah siap. Tekan Bagikan sekali lagi.', 'warn'); return; } throw e; }
}

/* ---------------- tampilan ---------------- */
const pill = (txt, cls = '') => `<span class="kt-pill ${cls}">${esc(txt)}</span>`;

let capPlat = ''; // tab caption yang terakhir dibuka
function captionCard(it, plats) {
  if (!plats.length) return '';
  const cur = plats.includes(capPlat) ? capPlat : plats[0];
  return `<section class="kt-card kt-capcard"><div class="kt-tabs" role="tablist" aria-label="Caption per platform">${plats.map(p => `<button type="button" role="tab" class="kt-tab${p === cur ? ' on' : ''}" aria-selected="${p === cur}" data-act="pk-captab" data-p="${esc(p)}">${esc(PLAT[p])}</button>`).join('')}</div>
    ${plats.map(p => `<div class="kt-cap" data-plat="${esc(p)}"${p === cur ? '' : ' hidden'}>
      <textarea data-k="cap-${esc(p)}" rows="9" placeholder="Belum ada caption untuk ${esc(PLAT[p])}" aria-label="Caption ${esc(PLAT[p])}">${esc(captionOf(it, p))}</textarea>
      ${(() => { const c = capCount(p, captionOf(it, p)); return `<div class="kt-capn${c.lebih ? ' lebih' : ''}">${esc(c.lebih ? `${c.label}, kepanjangan` : c.label)}</div>`; })()}
      <div class="kt-row"><button type="button" class="btn primary kt-btn grow" data-act="pk-copy" data-p="${esc(p)}">Salin caption</button><button type="button" class="btn kt-btn" data-act="pk-savecap" data-p="${esc(p)}" hidden>Simpan</button><span class="kt-dirtymark" hidden>belum disimpan</span></div></div>`).join('')}</section>`;
}
/** Dialog "Tandai sudah tayang": pilih platform, link opsional. onDone dipanggil setelah semua tersimpan. */
export function tayangDialog(it, conf, base, onDone) {
  const belum = platformsFor(it.jenis, conf, it).filter(p => !it.platforms?.[p]);
  if (!belum.length) { toast('Semua platform sudah ditandai tayang', 'ok'); return; }
  modal({ title: 'Tandai sudah tayang', body: esc(it.title || ''), html: `<div class="kt-form">${belum.map((p, i) => `<label class="kt-tdrow"><input type="checkbox" id="td-c-${esc(p)}" ${i === 0 ? 'checked' : ''}><b>${esc(PLAT[p])}</b><input type="url" inputmode="url" id="td-l-${esc(p)}" placeholder="Link (boleh kosong)" aria-label="Link ${esc(PLAT[p])}"></label>`).join('')}</div>`,
    actions: [{ label: 'Tandai tayang', kind: 'primary', fn: () => {
      const pick = belum.filter(p => document.getElementById(`td-c-${p}`)?.checked).map(p => [p, document.getElementById(`td-l-${p}`).value.trim()]);
      if (!pick.length) { toast('Pilih minimal satu platform', 'warn'); return false; }
      if (pick.some(([, l]) => l && !safeHref(l))) { toast('Link harus diawali http:// atau https://', 'warn'); return false; }
      (async () => {
        let last = null;
        for (const [p, link] of pick) last = await post(`${base}/${encodeURIComponent(it.id)}/tayang`, { platform: p, ...(link ? { link } : {}) });
        toast(`Ditandai tayang di ${pick.length} platform`, 'ok');
        await onDone?.(last);
      })().catch(e => toast(e.message || 'Gagal', 'bad'));
    } }, { label: 'Batal' }] });
}
function postingRow(it, p) {
  const t = it.platforms?.[p], pf = it.perf?.[p] || {};
  if (!t) return `<li class="kt-pr"><b>${esc(PLAT[p])}</b><span class="kt-muted">Belum</span><span></span></li>`;
  const href = safeHref(t.link);
  return `<li class="kt-pr done"><b>${esc(PLAT[p])}</b><span class="kt-pr-at">✓ ${esc(t.at ? fmtAt(t.at) : 'Tayang')}</span>${href ? `<a class="btn kt-btn sm" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Buka ↗</a>` : '<span></span>'}
    <details class="kt-pr-more"><summary>${href ? 'Ubah link' : 'Tempel link'} · Performa</summary>
      <div class="kt-row"><input type="url" inputmode="url" data-k="lnk-${esc(p)}" value="${esc(t.link || '')}" placeholder="Link post" aria-label="Link ${esc(PLAT[p])}"><button type="button" class="btn kt-btn" data-act="pk-tayang" data-p="${esc(p)}">Simpan link</button></div>
      <div class="kt-perf-g">${METRIK.map(m => `<label>${esc(METRIK_LABEL[m])}<input type="number" inputmode="numeric" min="0" data-k="pf-${esc(p)}-${m}" value="${pf[m] ?? ''}"></label>`).join('')}</div>
      <button type="button" class="btn kt-btn block" data-act="pk-perf" data-p="${esc(p)}">Simpan performa</button></details></li>`;
}

export function paketHTML(it, conf, backHref) {
  const plats = platformsFor(it.jenis, conf, it);
  const md = it.media || {}, hasMedia = (md.slides || []).length || md.video?.url;
  const shareList = md.video?.url ? [md.video] : md.slides || [];
  const live = it.tahap === 'tayang', editable = !live && it.tahap !== 'arsip';
  const lagu = it.lagu || '', jam = validJam(it.jam) ? it.jam : '';
  const decide = it.tahap === 'review' ? `<section class="kt-card kt-decide"><h3>Menunggu keputusanmu</h3><div class="kt-row"><button type="button" class="btn primary kt-btn grow" data-act="pk-setuju">Setuju</button><button type="button" class="btn kt-btn grow" data-act="pk-revisi">Minta revisi</button></div></section>` : '';
  const belumSemua = plats.some(p => !it.platforms?.[p]);
  const posting = plats.length ? `<section class="kt-card"><h3>Posting</h3><ul class="kt-prs">${plats.map(p => postingRow(it, p)).join('')}</ul>${belumSemua && it.tahap !== 'arsip' ? '<button type="button" class="btn primary kt-btn block" data-act="pk-tayangdlg">Tandai sudah tayang…</button>' : ''}</section>` : '';
  const jadwal = editable && it.tahap !== 'review' ? `<section class="kt-card"><h3>Jadwal</h3><div class="kt-row kt-jd"><input type="date" data-k="jd-date" value="${esc(it.publishAt || '')}" aria-label="Tanggal tayang"><input type="time" data-k="jd-jam" value="${esc(jam || conf?.jamDefault || '19:00')}" aria-label="Jam tayang"><button type="button" class="btn kt-btn" data-act="pk-jadwal">Simpan</button>${it.publishAt ? '<button type="button" class="btn ghost kt-btn" data-act="pk-lepas">Lepas</button>' : ''}</div></section>` : '';
  const when = it.publishAt ? `${live ? 'Tayang' : 'Jadwal'} ${fmtTanggal(it.publishAt, true)}${!live && jam ? ' ' + jam : ''}` : '';
  return `<div class="kt-paket">
    <header class="kt-ph"><a class="kt-back" href="${esc(backHref)}">‹ Konten</a>
      <h2>${esc(it.title || 'Tanpa judul')}</h2>
      <div class="kt-pills">${pill(it.tahapNama || it.tahap, 'st-' + esc(it.tahap))}${when ? pill(when) : ''}${it.jadwalStatus === 'usulan' ? pill('Usulan jadwal', 'warn') : ''}${it.jenis ? pill(`${ICON_JENIS[it.jenis] || ''} ${it.jenis}`) : ''}${it.seri ? pill('Seri ' + it.seri) : ''}${it.sensitif ? pill('Sensitif', 'warn') : ''}</div></header>
    <div class="kt-pk-grid">
      <div class="kt-pk-media">${mediaHTML(it)}
        ${hasMedia ? `<div class="kt-row kt-pk-act">${canShare() ? `<button type="button" class="btn primary kt-btn grow" data-act="pk-share">${md.video?.url ? 'Bagikan video' : `Bagikan ${shareList.length} slide`}</button>` : ''}<button type="button" class="btn kt-btn grow" data-act="pk-dlall">${md.video?.url ? 'Unduh video' : shareList.length > 1 ? `Unduh ${shareList.length} slide` : 'Unduh'}</button>${md.cover?.url && md.video?.url ? `<a class="btn kt-btn" href="${esc(dlUrl(md.cover.url))}" download>Unduh sampul</a>` : ''}</div>` : ''}
      </div>
      <aside class="kt-pk-side">
        ${decide}${live ? posting + captionCard(it, plats) : captionCard(it, plats) + posting}${jadwal}
        <details class="kt-card kt-more"><summary>Lainnya</summary>
          <label class="kt-f">Saran lagu<span class="kt-row kt-tight"><input type="text" data-k="lagu" value="${esc(lagu)}" placeholder="Belum ada"><button type="button" class="btn kt-btn" data-act="pk-savelagu">Simpan</button></span></label>
          <label class="kt-f">Catatan<textarea data-k="catatan" rows="3" placeholder="Catatan internal"></textarea></label>
          <button type="button" class="btn kt-btn" data-act="pk-savecatatan">Simpan catatan</button>
          <label class="kt-check"><input type="checkbox" data-act="pk-sensitif" ${it.sensitif ? 'checked' : ''}> Konten sensitif, jangan dijadwalkan berurutan</label>
          ${(it.pratinjau || []).length ? `<div class="kt-f">Pratinjau${it.pratinjau.map(x => `<a class="kt-pv" href="#/o/${esc(encodeURIComponent(it._oid || ''))}/pratinjau/${esc(encodeURIComponent(x.id))}">${esc(x.title || x.id)}</a>`).join('')}</div>` : ''}
          ${it.folder ? `<p class="kt-muted kt-folder">Folder <code>${esc(it.folder)}</code></p>` : ''}
        </details>
      </aside>
    </div>
  </div>`.replace('placeholder="Catatan internal"></textarea>', `placeholder="Catatan internal">${esc(it.catatan || '')}</textarea>`);
}

const BATAS_CAP = { instagram: 2200, threads: 500, tiktok: 4000, youtube: 5000 };
const capCount = (p, text) => { const n = [...String(text || '')].length, max = BATAS_CAP[p]; return { n, max, lebih: !!max && n > max, label: `${n.toLocaleString('id-ID')}${max ? ` / ${max.toLocaleString('id-ID')}` : ''}` }; };
/** Tampilkan tombol Simpan caption hanya saat isinya berbeda dari server. */
export function paketInput(e) {
  const f = e.target; if (!f?.dataset?.k?.startsWith('cap-')) return;
  const box = f.closest('.kt-cap'); if (!box) return;
  const hitung = box.querySelector('.kt-capn');
  if (hitung) { const c = capCount(box.dataset.plat, f.value); hitung.textContent = c.lebih ? `${c.label}, kepanjangan` : c.label; hitung.classList.toggle('lebih', c.lebih); }
  const dirty = f.value !== f.defaultValue;
  box.querySelector('.kt-dirtymark').hidden = !dirty;
  box.querySelector('[data-act="pk-savecap"]').hidden = !dirty;
  box.classList.toggle('dirty', dirty);
}

/**
 * Tangani aksi Paket. host = { oid, base, item(), conf(), refresh(), root }. Mengembalikan true bila aksi milik Paket.
 */
export async function paketAct(act, target, host) {
  if (!act.startsWith('pk-')) return false;
  if (act === 'pk-slide') { goSlide(stageOf(target), Number(target.dataset.i)); return true; }
  if (act === 'pk-nav') { const box = stageOf(target); if (box) goSlide(box, Math.round(box.scrollLeft / Math.max(1, box.clientWidth)) + Number(target.dataset.d)); return true; }
  if (act === 'pk-captab') {
    capPlat = target.dataset.p;
    const card = target.closest('.kt-capcard');
    card.querySelectorAll('.kt-tab').forEach(x => { const on = x === target; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
    card.querySelectorAll('.kt-cap').forEach(x => { x.hidden = x.dataset.plat !== capPlat; });
    return true;
  }
  const it = host.item(); if (!it) return true;
  const root = host.root, field = k => root.querySelector(`[data-k="${k}"]`), cid = encodeURIComponent(it.id);
  const url = `${host.base()}/${cid}`, p = target.dataset.p;
  if (act === 'pk-tayangdlg') { tayangDialog(it, host.conf(), host.base(), () => host.refresh()); return true; }
  const busy = btn => { if (btn) btn.disabled = true; return () => { if (btn) btn.disabled = false; }; };
  const done = busy(target);
  try {
    switch (act) {
      case 'pk-copy': { const v = field(`cap-${p}`)?.value || ''; if (!v.trim()) { toast(`Caption ${PLAT[p]} masih kosong`, 'warn'); break; } const ok = await copyText(v); toast(ok ? `Caption ${PLAT[p]} disalin` : 'Gagal menyalin, tahan teks lalu pilih Salin', ok ? 'ok' : 'bad'); break; }
      case 'pk-savecap': await api(`${url}/caption`, { method: 'PUT', body: { platform: p, text: field(`cap-${p}`).value } }); toast(`Caption ${PLAT[p]} disimpan`, 'ok'); await host.refresh(); break;
      case 'pk-dlall': {
        const md = it.media || {}, list = md.video?.url ? [md.video] : md.slides || [];
        for (const m of list) { const l = document.createElement('a'); l.href = dlUrl(m.url); l.download = mediaName(m); document.body.appendChild(l); l.click(); l.remove(); await new Promise(r => setTimeout(r, 350)); }
        toast(`${list.length} berkas diunduh`, 'ok');
        break;
      }
      case 'pk-copylagu': toast(await copyText(field('lagu').value) ? 'Lagu disalin' : 'Gagal menyalin', 'ok'); break;
      case 'pk-savelagu': await patch(url, { lagu: field('lagu').value.trim() }); toast('Lagu disimpan', 'ok'); await host.refresh(); break;
      case 'pk-savecatatan': await patch(url, { catatan: field('catatan').value }); toast('Catatan disimpan', 'ok'); await host.refresh(); break;
      case 'pk-sensitif': await patch(url, { sensitif: target.checked ? 1 : 0 }); toast(target.checked ? 'Ditandai sensitif' : 'Tanda sensitif dilepas', 'ok'); await host.refresh(); break;
      case 'pk-jadwal': {
        const d = field('jd-date').value, j = field('jd-jam').value;
        if (!validDate(d)) { toast('Pilih tanggal dulu', 'warn'); break; }
        await patch(url, { publishAt: d, jam: validJam(j) ? j : host.conf()?.jamDefault || '19:00' }); toast(`Dijadwalkan ${fmtTanggal(d, true)}`, 'ok'); await host.refresh(); break;
      }
      case 'pk-lepas': await patch(url, { publishAt: '' }); toast('Jadwal dilepas', 'ok'); await host.refresh(); break;
      case 'pk-share': { const md = it.media || {}; await shareMedia(md.video?.url ? [md.video] : md.slides || [], it.title); break; }
      case 'pk-tayang': {
        const link = (field(`lnk-${p}`)?.value || '').trim();
        if (link && !safeHref(link)) { toast('Link harus diawali http:// atau https://', 'warn'); break; }
        const r = await post(`${url}/tayang`, { platform: p, ...(link ? { link } : {}) });
        toast(`${PLAT[p]} ditandai tayang`, 'ok');
        await host.refresh();
        if (r?.pathPerluCek?.length) modal({ title: 'Folder dipindah', body: 'Berkas ini masih menyebut path lama dan perlu kamu cek:', html: `<ul class="kt-paths">${r.pathPerluCek.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` });
        break;
      }
      case 'pk-perf': {
        const body = { platform: p }; for (const m of METRIK) { const v = field(`pf-${p}-${m}`)?.value; if (v !== '' && v != null) body[m] = num(v); }
        await post(`${url}/performa`, body); toast(`Performa ${PLAT[p]} disimpan`, 'ok'); await host.refresh(); break;
      }
      case 'pk-setuju': await post(`${url}/review`, { keputusan: 'setuju' }); toast('Disetujui, masuk Siap tayang', 'ok'); await host.refresh(); break;
      case 'pk-revisi': host.revisi?.(it); break;
    }
  } catch (e) { toast(e.message || 'Gagal', 'bad'); }
  finally { done(); }
  return true;
}

export { hashFor };
