// Tab Konten, bagian murni (tanpa database): deteksi media, baca/tulis caption per bagian, dan pemindai impor folder konten.
// Semua fungsi di sini hanya MEMBACA disk, kecuali writeCaption. Impor sungguhan (membuat kartu) ada di konten.js.
import fs from 'node:fs';
import path from 'node:path';

export const CAPTION_FILE = 'caption-instagram.md';
export const CAP_PLATS = { instagram: 'Instagram', tiktok: 'TikTok', threads: 'Threads', youtube: 'YouTube' };
const SECTION = /^##[ \t]+(Instagram|Caption|TikTok|Threads|YouTube)[ \t]*$/i;
const IMG = /\.(png|jpe?g|webp)$/i;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const SKIP_DIRS = new Set(['_kit', 'node_modules', '__pycache__']);

/** Nama dasar sebuah folder konten tanpa awalan post-/video-. */
export const baseName = folder => path.basename(String(folder)).replace(/^(post|video)-/i, '');

/* ---------------- listing dengan cache pendek (folder _hasil dipakai banyak item) ---------------- */
const dirCache = new Map();
const DIR_TTL = 15e3;
export function listFiles(dir) {
  const hit = dirCache.get(dir), now = Date.now();
  if (hit && now - hit.at < DIR_TTL) return hit.list;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name); } catch {}
  dirCache.set(dir, { at: now, list });
  if (dirCache.size > 400) for (const [k, v] of dirCache) if (now - v.at > DIR_TTL) dirCache.delete(k);
  return list;
}
export const clearDirCache = () => dirCache.clear();
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

/**
 * Media sebuah folder (path absolut): { slides:[rel], video:rel|null, cover:rel|null }; rel relatif ke rootAbs.
 * Carousel = out/slide-*.png, lalu clean/*.png, lalu out/*.png; carousel yang punya slide tidak melihat _hasil. Video = _hasil/FINAL/<nama>*-FINAL.mp4, _hasil/siap/<nama>*.mp4 terbaru, out/*.mp4 terbaru selain old-* dan scene-*.
 * Sampul = <nama>*cover* di dua folder _hasil itu, lalu slide pertama. Subfolder (mis. out/opsi) diabaikan.
 */
/** Nama proyek lain yang lebih panjang dan diawali nama ini, dari semua folder status + jenis. */
function namaSaudara(rootAbs, folderRel, nama) {
  const out = new Set();
  for (const g of ['sudah-posting', 'belum-posting', 'cek-dulu']) {
    for (const j of ['carousel', 'video']) for (const n of subdirs(path.join(rootAbs, g, j))) {
      const b = baseName(n).toLowerCase();
      if (b !== nama && b.startsWith(`${nama}-`) && jenisOf(`${g}/${j}/${n}`) === jenisOf(folderRel)) out.add(b);
    }
  }
  return [...out];
}
export function detectMedia(rootAbs, folderRel, { light = false } = {}) {
  const dir = path.join(rootAbs, folderRel), nama = baseName(folderRel).toLowerCase();
  // render bisa memakai nama folder utuh, atau tanpa akhiran versi (video-juanda-2015-v2 -> juanda-2015-FINAL.mp4)
  const asal = path.basename(folderRel).toLowerCase(), polos = nama.replace(/-(v\d+|3d)$/, '');
  const namas = [...new Set([nama, asal, polos])];
  // render milik proyek saudara (video-kumbakarna-duo) bukan milik video-kumbakarna
  const saudara = namaSaudara(rootAbs, folderRel, nama);
  const cocok = n => {
    const l = n.toLowerCase();
    if (saudara.some(x => l === x || l.startsWith(`${x}-`) || l.startsWith(`${x}.`))) return false;
    return namas.some(x => l === x || l.startsWith(`${x}-`) || l.startsWith(`${x}.`));
  };
  const rel = (...p) => path.posix.join(...p);
  const inDir = (sub, test) => listFiles(path.join(dir, sub)).filter(test).sort(natural).map(n => rel(folderRel, sub, n));
  let slides = inDir('out', n => /^slide-.*\.png$/i.test(n));
  if (!slides.length) slides = inDir('clean', n => /\.png$/i.test(n));
  if (!slides.length) slides = inDir('out', n => /\.png$/i.test(n));
  // carousel yang sudah punya slide tidak memakai _hasil: nama yang sama bisa milik proyek videonya
  if (slides.length && jenisOf(folderRel) === 'carousel') return { slides: light ? slides.slice(0, 1) : slides, video: null, cover: slides[0] };
  let video = null;
  const hasil = sub => path.join(rootAbs, '_hasil', sub);
  const final = listFiles(hasil('FINAL')).filter(n => cocok(n) && /-FINAL\.mp4$/i.test(n)).sort(natural);
  if (final.length) video = rel('_hasil/FINAL', final[0]);
  if (!video) {
    const siap = listFiles(hasil('siap')).filter(n => cocok(n) && /\.mp4$/i.test(n))
      .sort((a, b) => mtimeOf(path.join(hasil('siap'), b)) - mtimeOf(path.join(hasil('siap'), a)));
    if (siap.length) video = rel('_hasil/siap', siap[0]);
  }
  if (!video) { // render yang tersalip (old-*) dan adegan mentah (scene-*) bukan hasil
    const o = inDir('out', n => /\.mp4$/i.test(n) && !/^(old|scene)[-.]/i.test(n)).sort((a, b) => mtimeOf(path.join(rootAbs, b)) - mtimeOf(path.join(rootAbs, a)));
    if (o.length) video = o[0];
  }
  // proyek video: PNG di out/ itu gambar kerja (cek rute, lembar kontak), bukan slide
  if (video && jenisOf(folderRel) === 'video') slides = [];
  let cover = null;
  for (const sub of ['FINAL', 'siap']) {
    const c = listFiles(hasil(sub)).filter(n => cocok(n) && /cover/i.test(n) && IMG.test(n)).sort(natural);
    if (c.length) { cover = rel('_hasil', sub, c[0]); break; }
  }
  if (!cover && slides.length) cover = slides[0];
  if (!cover && video) cover = video; // gambar kecilnya diambil dari bingkai video
  return light ? { slides: slides.slice(0, 1), video, cover } : { slides, video, cover };
}

/* ---------------- caption ---------------- */
/**
 * { instagram, tiktok, threads, youtube } dari teks berkas. Tanpa bagian dikenal: pembuka berkas (atau `## Versi ...` / `## 01 ...` pertama) = Instagram, `## Versi Threads` = Threads. YouTube kosong memakai TikTok.
 * Bagian dikenal: `## Instagram` (atau `## Caption`), `## TikTok`, `## Threads`, `## YouTube`. Judul `##` lain (Catatan, Threads balasan, Build ulang, ...)
 * mengakhiri bagian sebelumnya dan isinya BUKAN caption (tidak ikut tersalin), tetapi tetap dijaga saat menulis balik.
 */
export function parseCaption(text) {
  const out = { instagram: null, threads: null, tiktok: null, youtube: null };
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const parts = splitSections(raw);
  if (!parts.sections.some(s => s.plat)) {
    // Berkas lama: caption ada di pembuka, atau di bagian versi (`## Versi A`, `## 01 — ...`). Bagian lain itu catatan kerja, bukan caption.
    const versi = parts.sections.find(s => VARIAN.test(s.head));
    const utama = versi ? versi.body : parts.pre.replace(/^\s*#[ \t][^\n]*\n+/, '');
    out.instagram = bersihkanCaption(utama) || null;
    const th = parts.sections.find(s => /^##[ \t]+versi[ \t]+threads\b/i.test(s.head));
    if (th) out.threads = bersihkanCaption(th.body) || null;
    return out;
  }
  for (const s of parts.sections) { if (!s.plat) continue; const t = s.body.trim(); if (t) out[s.plat] = out[s.plat] ? `${out[s.plat]}\n\n${t}` : t; }
  if (!out.youtube && out.tiktok) out.youtube = out.tiktok;
  return out;
}
const ANY_H2 = /^##[ \t]+\S/;
const VARIAN = /^##[ \t]+(versi[ \t]+(?!threads\b)\S|\d+\b)/i;
/** Buang garis pemisah `---` dan apa pun sesudahnya (catatan untuk tim); yang di atas garis itu captionnya. */
const bersihkanCaption = t => String(t ?? '').split(/^\s*-{3,}\s*$/m).find(x => x.trim())?.trim() ?? '';
function splitSections(raw) {
  const lines = raw.split('\n'), sections = [];
  let pre = [], cur = null, fence = false;
  for (const line of lines) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && ANY_H2.test(line)) {
      const m = SECTION.exec(line);
      cur = { plat: m ? (m[1].toLowerCase() === 'caption' ? 'instagram' : m[1].toLowerCase()) : null, head: line, body: [] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.body : pre).push(line);
  }
  return { pre: pre.join('\n'), sections: sections.map(s => ({ ...s, body: s.body.join('\n') })) };
}
export function readCaptionFile(dirAbs) {
  const f = path.join(dirAbs, CAPTION_FILE);
  try { return { file: f, text: fs.readFileSync(f, 'utf8') }; } catch { return { file: f, text: null }; }
}
/** Ada caption Instagram yang tidak kosong? (murah: baca berkas kecil sekali) */
export function hasCaption(dirAbs) {
  const { text } = readCaptionFile(dirAbs);
  return text != null && !!parseCaption(text).instagram;
}
/** Berkas lama tanpa `## Instagram`: tulis ulang dengan bagian tegas. Versi lain, catatan, dan build ulang tetap ada, tidak ikut jadi caption. */
function tegaskanBagian(raw) {
  const { pre, sections } = splitSections(raw);
  const cap = parseCaption(raw).instagram;
  if (!cap) return raw;
  const lain = sections.map(s => `${s.head.replace(/^##[ \t]+versi[ \t]+threads\b.*$/i, '## Threads')}\n${s.body.replace(/\s+$/, '')}`.replace(/\n$/, ''));
  const adaVersi = sections.some(s => VARIAN.test(s.head));
  const judul = /^\s*#[ \t][^\n]*/.exec(pre)?.[0].trim() || '';
  const sisa = adaVersi ? pre.replace(/^\s*#[ \t][^\n]*\n*/, '').trim() : pre.split(/^\s*-{3,}\s*$/m).slice(1).join('\n---\n').trim();
  return [judul, !adaVersi ? null : sisa, `## Instagram\n${cap}`, !adaVersi && sisa ? `## Catatan\n${sisa}` : null, ...lain].filter(Boolean).join('\n\n') + '\n';
}
/** Teks berkas baru setelah mengganti SATU bagian (platform); bagian lain, judul `##` lain, dan pembuka berkas tidak disentuh. */
export function replaceSection(text, plat, value) {
  const key = String(plat).toLowerCase(), label = CAP_PLATS[key];
  if (!label) throw new Error(`Platform caption tidak dikenal: ${plat}`);
  const body = String(value ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const raw2 = splitSections(raw).sections.some(s => s.plat) ? raw : tegaskanBagian(raw);
  const { pre, sections } = splitSections(raw2);
  const block = `## ${label}\n${body}\n`;
  if (!sections.some(s => s.plat === key)) return `${raw2.replace(/\s+$/, '')}${raw2.trim() ? '\n\n' : ''}${block}`;
  const chunks = [];
  if (pre.trim()) chunks.push(pre.replace(/\s+$/, ''));
  let done = false;
  for (const s of sections) {
    if (s.plat === key) { if (done) continue; done = true; chunks.push(`${s.head}\n${body}`); }
    else chunks.push(`${s.head}\n${s.body.replace(/\s+$/, '')}`.replace(/\n$/, ''));
  }
  return chunks.join('\n\n') + '\n';
}

/* ---------------- judul, jenis, seri ---------------- */
const humanize = name => { const t = baseName(name).replace(/[-_]+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : String(name); };
/** Potong di batas kata sampai max karakter. */
export function clipWords(s, max = 90) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}
export function jenisOf(folderRel) {
  const n = path.basename(folderRel);
  if (/^post-/i.test(n)) return 'carousel';
  if (/^video-/i.test(n)) return 'video';
  const parent = path.basename(path.dirname(folderRel)).toLowerCase();
  return parent === 'carousel' || parent === 'video' ? parent : 'lain';
}
export const sensitifOf = (folderRel, jenis) => jenis === 'video' && /(^|[-_])(19|20)\d{2}($|[-_])/.test(baseName(folderRel));
const tokens = folderRel => baseName(folderRel).toLowerCase().split(/[-_]+/).filter(Boolean);
/** Seri: folder yang berbagi 3 token awal (diutamakan) atau 2 token awal dengan minimal satu folder lain. Peta folder -> nama seri. */
export function seriMap(folders) {
  const toks = new Map(folders.map(f => [f, tokens(f)]));
  const count = (n, key) => { let c = 0; for (const t of toks.values()) if (t.length >= n && t.slice(0, n).join('-') === key) c++; return c; };
  const out = new Map();
  for (const [f, t] of toks) {
    for (const n of [3, 2]) {
      if (t.length < n) continue;
      const key = t.slice(0, n).join('-');
      if (count(n, key) >= 2) { out.set(f, key); break; }
    }
  }
  return out;
}

/* ---------------- shortcode Instagram -> waktu tayang ---------------- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** ms epoch dari shortcode (id = base64url -> BigInt; ms = (id >> 23) + 1314220021721), atau null bila tidak masuk akal. */
export function shortcodeMs(code) {
  code = String(code || '');
  if (!/^[A-Za-z0-9_-]{6,11}$/.test(code)) return null;
  let id = 0n;
  for (const ch of code) id = (id << 6n) | BigInt(B64.indexOf(ch));
  const ms = Number((id >> 23n) + 1314220021721n);
  return Number.isFinite(ms) && ms > Date.UTC(2010, 9, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}
export const shortcodeOf = link => /instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(String(link || ''))?.[1] || null;
export function parseSudahPosting(text) {
  const t = String(text || '');
  const link = /https?:\/\/\S+/.exec(t)?.[0]?.replace(/[)\].,;]+$/, '') || '';
  const judul = /^Judul IG:[ \t]*(.+)$/im.exec(t)?.[1]?.trim() || '';
  return { link, judul };
}
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ---------------- pemindai impor (baca saja) ---------------- */
const RISET_FILES = ['opsi.md', 'riset.md', 'brief.md', 'naskah.md'];
const subdirs = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name)).map(d => d.name).sort(natural); } catch { return []; } };

/**
 * Pindai rootAbs/{sudah-posting,belum-posting,cek-dulu}/<jenis>/<folder>. Mengembalikan daftar rencana, tidak menulis apa pun.
 * Satu entri: { folder, tahap, jenis, title, seri, sensitif, labels, platforms, publishAt }.
 */
export function scan(rootAbs) {
  const entries = [];
  for (const group of ['sudah-posting', 'belum-posting', 'cek-dulu']) {
    for (const mid of subdirs(path.join(rootAbs, group))) {
      if (mid.startsWith('_')) continue; // sisa keluaran render, bukan jenis konten
      for (const name of subdirs(path.join(rootAbs, group, mid))) entries.push({ group, folder: `${group}/${mid}/${name}` });
    }
  }
  const series = seriMap(entries.map(e => e.folder));
  return entries.map(({ group, folder }) => {
    const dir = path.join(rootAbs, folder);
    const jenis = jenisOf(folder);
    const cap = readCaptionFile(dir).text;
    const igCaption = cap != null ? parseCaption(cap).instagram : null;
    const e = { folder, jenis, seri: series.get(folder) || '', sensitif: sensitifOf(folder, jenis), labels: [], platforms: {}, publishAt: '', tahap: 'ide', title: '' };
    let judul = '';
    if (group === 'sudah-posting') {
      e.tahap = 'tayang';
      let sp = ''; try { sp = fs.readFileSync(path.join(dir, 'SUDAH-POSTING.txt'), 'utf8'); } catch {}
      const { link, judul: j } = parseSudahPosting(sp);
      judul = j;
      const ms = shortcodeMs(shortcodeOf(link));
      e.platforms = { instagram: { link, at: ms ? new Date(ms).toISOString() : '' } };
      if (ms) e.publishAt = localDay(ms);
    } else {
      const m = detectMedia(rootAbs, folder, { light: true });
      const hasMedia = !!(m.slides.length || m.video);
      const files = new Set(listFiles(dir).map(n => n.toLowerCase()));
      if (group === 'cek-dulu') { e.tahap = 'review'; e.labels = ['cek-dulu']; }
      else if (hasMedia && igCaption) e.tahap = 'review';
      else if (hasMedia) e.tahap = 'produksi';
      else if (RISET_FILES.some(f => files.has(f))) e.tahap = 'riset';
      else e.tahap = 'ide';
    }
    e.title = judul || clipWords((igCaption || '').split('\n').find(l => l.trim() && !/^#/.test(l)) || '', 90) || humanize(folder);
    return e;
  });
}
