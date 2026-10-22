// PDF and markdown/text document cards (rendered by md() in util.js as figure.md-pdf / figure.md-doc) and their full-screen viewers.
// Cards fill themselves in when they scroll into view; clicks are handled by one delegated listener, so every place that shows md() gets it.
import { esc, md, post, toast } from './util.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/';
let libP = null;
const lib = () => (libP ||= import(PDFJS + 'pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; }).catch(e => { libP = null; throw e; }));
const loadPdf = async src => (await lib()).getDocument({ url: src, withCredentials: true }).promise;
const dlUrl = u => u + (u.includes('?') ? '&' : '?') + 'dl=1';
const MAX_TEXT = 2 * 1024 * 1024;

/* ---------------- kartu ---------------- */
const seen = new WeakSet();
const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); fill(e.target); } }, { rootMargin: '200px' }) : null;

function scan(root) {
  for (const f of root.querySelectorAll?.('figure.md-pdf, figure.md-doc') || []) {
    if (seen.has(f)) continue;
    seen.add(f);
    io ? io.observe(f) : fill(f);
  }
}

async function fill(f) {
  const src = f.dataset.src;
  try {
    if (f.classList.contains('md-pdf')) {
      const doc = await loadPdf(src), page = await doc.getPage(1);
      const th = f.querySelector('.pdf-thumb'), w = 150, vp0 = page.getViewport({ scale: 1 }), sc = (w * Math.min(2, window.devicePixelRatio || 1)) / vp0.width, vp = page.getViewport({ scale: sc });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      th.replaceChildren(c);
      f.querySelector('.pdf-info small').textContent = `PDF · ${doc.numPages} halaman`;
      doc.destroy();
    } else {
      const { text } = await fetchText(src);
      const { title, snippet } = summarize(text, f.dataset.name);
      f.querySelector('.doc-info b').textContent = title;
      f.querySelector('.doc-info small').textContent = f.dataset.name;
      f.querySelector('.doc-snip').textContent = snippet;
    }
  } catch { f.classList.add('failed'); }
}

async function fetchText(src) {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Gagal (${res.status})`);
  const buf = await res.arrayBuffer();
  return { text: new TextDecoder().decode(buf.byteLength > MAX_TEXT ? buf.slice(0, MAX_TEXT) : buf), cut: buf.byteLength > MAX_TEXT };
}

/** Title (first heading, else file name) and a few plain lines for the card. */
export function summarize(text, name) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let title = '', snip = [], code = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^```/.test(l)) { code = !code; continue; }
    if (code || !l || /^(-{3,}|\*{3,}|\|[\s:|-]+\|)$/.test(l)) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h && !title) { title = h[1].replace(/[*_`]/g, ''); continue; }
    snip.push(l.replace(/^[#>\-*\s]+/, '').replace(/[*_`]|!?\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (snip.length >= 4) break;
  }
  return { title: title || String(name || 'Dokumen').replace(/\.[a-z0-9]+$/i, ''), snippet: snip.join('\n') };
}

/* ---------------- overlay dasar ---------------- */
function overlay(label, cls) {
  const o = document.createElement('div');
  o.className = 'dv ' + cls; o.tabIndex = -1; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', label);
  const close = () => { o.remove(); document.removeEventListener('keydown', key, true); o.onclose?.(); };
  const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } else o.onkey?.(ev); };
  document.addEventListener('keydown', key, true);
  document.body.appendChild(o);
  o.close = close;
  return o;
}

/* ---------------- PDF ---------------- */
async function openPdf(src, name) {
  const o = overlay(name, 'dv-pdf');
  o.innerHTML = `<div class="dv-bar"><b class="dv-title">${esc(name)}</b>
    <span class="dv-grp"><button class="btn sm" data-a="prev" aria-label="Halaman sebelumnya">‹</button><span class="dv-pg"><input data-a="goto" inputmode="numeric" aria-label="Nomor halaman" value="1"> / <span data-a="total">–</span></span><button class="btn sm" data-a="next" aria-label="Halaman berikutnya">›</button></span>
    <span class="dv-grp"><button class="btn sm" data-a="out" aria-label="Perkecil">−</button><button class="btn sm" data-a="fit" aria-label="Pas lebar"><span data-a="zoom">100%</span></button><button class="btn sm" data-a="in" aria-label="Perbesar">+</button></span>
    <span class="dv-grp"><a class="btn sm" href="${esc(dlUrl(src))}" download>Unduh</a><a class="btn sm" href="${esc(src)}" target="_blank" rel="noreferrer">Tab baru</a><button class="btn sm" data-a="close" aria-label="Tutup">Tutup ✕</button></span></div>
  <div class="dv-body"><p class="dv-msg">Memuat PDF…</p></div>`;
  const body = o.querySelector('.dv-body'), $a = a => o.querySelector(`[data-a="${a}"]`);
  let doc, zoom = 1, cur = 1, pages = [], obs;
  const fitScale = async () => { const p = await doc.getPage(1), v = p.getViewport({ scale: 1 }); return Math.max(0.2, (body.clientWidth - 24) / v.width); };
  let base = 1;
  const setCur = n => { cur = Math.min(Math.max(1, n), doc.numPages); $a('goto').value = cur; };
  const draw = async pg => {
    if (pg.done === zoom) return;
    pg.done = zoom;
    const page = await doc.getPage(pg.n), dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: base * zoom }), c = pg.canvas;
    const ctx = c.getContext('2d');
    c.width = Math.ceil(vp.width * dpr); c.height = Math.ceil(vp.height * dpr); c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
    try { await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise; } catch { pg.done = 0; }
  };
  const layout = async () => {
    obs?.disconnect(); body.replaceChildren(); pages = [];
    const first = await doc.getPage(1), v1 = first.getViewport({ scale: base * zoom });
    obs = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) draw(pages[e.target.dataset.n - 1]); }, { root: body, rootMargin: '600px 0px' });
    const vis = new IntersectionObserver(es => { let best = null; for (const e of es) if (e.isIntersecting && (!best || e.intersectionRatio > best.intersectionRatio)) best = e; if (best) setCur(Number(best.target.dataset.n)); }, { root: body, threshold: [0.3, 0.6] });
    o.onclose = () => { obs.disconnect(); vis.disconnect(); doc?.destroy(); };
    for (let n = 1; n <= doc.numPages; n++) {
      const w = document.createElement('div'); w.className = 'dv-page'; w.dataset.n = n;
      const c = document.createElement('canvas'); c.setAttribute('role', 'img'); c.setAttribute('aria-label', `Halaman ${n}`);
      w.style.width = v1.width + 'px'; w.style.height = v1.height + 'px'; w.appendChild(c); body.appendChild(w);
      pages.push({ n, canvas: c, el: w, done: 0 }); obs.observe(w); vis.observe(w);
    }
  };
  const setZoom = async z => { zoom = Math.min(4, Math.max(0.25, z)); $a('zoom').textContent = Math.round(zoom * 100) + '%'; const keep = cur; await layout(); go(keep); };
  const go = n => { setCur(n); pages[cur - 1]?.el.scrollIntoView({ block: 'start' }); };
  o.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    ({ close: o.close, prev: () => go(cur - 1), next: () => go(cur + 1), in: () => doc && setZoom(zoom * 1.25), out: () => doc && setZoom(zoom / 1.25), fit: () => doc && setZoom(1) })[b.dataset.a]?.();
  });
  $a('goto').addEventListener('change', e => doc && go(parseInt(e.target.value, 10) || cur));
  o.onkey = ev => {
    if (!doc || ev.target.tagName === 'INPUT') return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { go(cur + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { go(cur - 1); ev.preventDefault(); }
    else if (ev.key === '+' || ev.key === '=') setZoom(zoom * 1.25);
    else if (ev.key === '-') setZoom(zoom / 1.25);
  };
  o.focus();
  try {
    doc = await loadPdf(src);
    base = await fitScale();
    $a('total').textContent = doc.numPages;
    await layout();
  } catch {
    // pdf.js unavailable (offline / blocked): fall back to the browser's own viewer
    body.innerHTML = `<iframe class="dv-frame" title="${esc(name)}" src="${esc(src)}" sandbox="allow-same-origin allow-downloads"></iframe>`;
    for (const a of ['prev', 'next', 'in', 'out', 'fit', 'goto']) $a(a).disabled = true;
  }
}

/* ---------------- dokumen markdown / teks ---------------- */
async function openDoc(src, name) {
  const o = overlay(name, 'dv-doc');
  const isTxt = /\.txt(?:[?#]|$)/i.test(name) || /\.txt(?:[?#]|$)/i.test(src);
  o.innerHTML = `<div class="dv-bar"><b class="dv-title">${esc(name)}</b>
    <span class="dv-grp"><button class="btn sm" data-a="src" aria-pressed="false">Lihat sumber</button>${isTxt ? '' : '<button class="btn sm" data-a="wiki">Jadikan halaman wiki</button>'}<a class="btn sm" href="${esc(dlUrl(src))}" download>Unduh</a><button class="btn sm" data-a="close" aria-label="Tutup">Tutup ✕</button></span></div>
  <div class="dv-body dv-docbody"><p class="dv-msg">Memuat…</p></div>`;
  const body = o.querySelector('.dv-body'), srcBtn = o.querySelector('[data-a="src"]');
  let text = '', raw = isTxt, cut = false;
  const paint = () => {
    srcBtn.setAttribute('aria-pressed', raw); srcBtn.textContent = raw ? 'Lihat tampilan' : 'Lihat sumber';
    body.innerHTML = `<article class="dv-doccard">${raw ? `<pre class="dv-raw"></pre>` : md(text, { taskIndex: false })}${cut ? '<p class="notice info">Dokumen terlalu besar, hanya bagian awal yang ditampilkan.</p>' : ''}</article>`;
    if (raw) body.querySelector('.dv-raw').textContent = text;
  };
  o.addEventListener('click', async e => {
    // inside the viewer, wiki/card links of the document are inert
    const inert = e.target.closest('a.wl, a[data-card]'); if (inert) { e.preventDefault(); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'close') o.close();
    else if (b.dataset.a === 'src') { raw = !raw; paint(); }
    else if (b.dataset.a === 'wiki') {
      const m = /^\/api\/offices\/([^/]+)\//.exec(src); if (!m) return;
      const title = (/^#{1,6}\s+(.+)$/m.exec(text) || [])[1]?.replace(/[*_`]/g, '').trim() || name.replace(/\.[a-z0-9]+$/i, '');
      b.disabled = true;
      try { await post(`/api/offices/${m[1]}/wiki`, { title: title.slice(0, 120), body: text, msg: `Diimpor dari ${name}` }); toast(`Halaman wiki "${title}" dibuat.`, 'ok'); o.close(); document.dispatchEvent(new CustomEvent('kantor:wiki-changed')); }
      catch (err) { toast(err.message, 'bad'); b.disabled = false; }
    }
  });
  o.focus();
  try { ({ text, cut } = await fetchText(src)); paint(); }
  catch (err) { body.innerHTML = `<p class="dv-msg">Tidak bisa memuat berkas: ${esc(err.message)}</p>`; }
}

/* ---------------- kait global ---------------- */
document.addEventListener('click', e => {
  const p = e.target.closest('[data-pdf]'); if (p) { e.preventDefault(); openPdf(p.dataset.pdf, p.closest('figure')?.dataset.name || 'PDF'); return; }
  const d = e.target.closest('[data-doc]'); if (d) { e.preventDefault(); openDoc(d.dataset.doc, d.closest('figure')?.dataset.name || 'Dokumen'); }
}, true);
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.body, { childList: true, subtree: true });
scan(document.body);
